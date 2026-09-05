import { decideCycleBudget } from './budget-gate.mjs';
import { acquireLease, assertLeaseCurrent, releaseLease, renewLease } from './exclusive-lease.mjs';
import { PolicyRefusalError } from './policy-engine.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../cycle/money-schemas.mjs';

// This sequencer owns durable stage order, not chain or provider mechanics. The stage driver owns
// those mechanics and only returns reconciled evidence. Keeping the stage sequence here tied to the
// operational schema prevents a scheduler, CLI, or repository consumer from silently using a different
// progression.
export const AUTOMATED_CYCLE_STAGES = OPERATIONAL_CYCLE_STAGES;

// These joins remain explicit even though the normal list ordering also reaches them first. Recovery
// can start at any incomplete stage, so the repository must prove their predecessor evidence exists.
const STAGE_JOIN_PRECONDITIONS = Object.freeze({
  'claim-process': Object.freeze(['eligibility-snapshot']),
  payout: Object.freeze(['eligibility-snapshot', 'return']),
});
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') throw new Error(`${label}.${method} is required`);
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('automated cycle aborted');
}

function assertPolicyEngine(value) {
  for (const method of ['evaluate', 'admit', 'evaluatePurchase', 'assertExecutionAllowed']) {
    requireMethod(value, method, 'policyEngine');
  }
  return value;
}

function assertPolicyDecision(decision) {
  if (!decision || decision.allowed !== true) {
    throw new PolicyRefusalError(decision?.reason ?? 'POLICY_ENGINE_INVALID_DECISION');
  }
  return decision;
}

async function assertJoinPreconditions(cycleRepository, cycleId, stage) {
  const preconditions = STAGE_JOIN_PRECONDITIONS[stage];
  if (!preconditions) return;
  for (const precondition of preconditions) {
    const record = await cycleRepository.readStage(cycleId, precondition);
    if (record?.status !== 'COMPLETE' || record.evidence === undefined || record.evidence === null) {
      throw new Error(`stage join incomplete: '${precondition}' must be finalized before '${stage}' can be attempted`);
    }
  }
  if (stage === 'claim-process') {
    const custody = await cycleRepository.readClaimPreconditions(cycleId);
    if (!custody || typeof custody !== 'object') throw new Error('claim-process custody preconditions are invalid');
    const reasons = [
      custody.heldAssets === true ? 'held assets' : null,
      custody.unattributed === true ? 'unattributed assets' : null,
      custody.unresolvedObligations === true ? 'unresolved obligations' : null,
    ].filter(Boolean);
    if (reasons.length > 0) throw new Error(`claim-process blocked by custody preconditions: ${reasons.join(', ')}`);
  }
}

export class AutomatedCycleService {
  #budgetReader;
  #beforeComplete;
  #beforeMutation;
  #cycleRepository;
  #dryRun;
  #feeSettlementObserver;
  #leaseStore;
  #leaseTtlMs;
  #now;
  #owner;
  #liveMode;
  #mode;
  #providerMode;
  #packId;
  #policyEngine;
  #policyCapUsdg;
  #recoveryGuard;
  #rehearsalSessionId;
  #runnerFactory;
  #stageDriver;

  constructor(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('automated cycle service configuration is invalid');
    }
    const requiredFields = [
      'owner',
      'leaseTtlMs',
      'now',
      'leaseStore',
      'budgetReader',
      'cycleRepository',
      'runnerFactory',
      'stageDriver',
      'feeSettlementObserver',
      'liveMode',
    ];
    const optionalFields = ['packId', 'policyEngine', 'mode', 'providerMode', 'dryRun', 'policyCapUsdg', 'recoveryGuard', 'beforeComplete', 'beforeMutation', 'rehearsalSessionId'];
    const keys = Object.keys(config);
    if (!requiredFields.every(field => Object.hasOwn(config, field)) || keys.some(field => !requiredFields.includes(field) && !optionalFields.includes(field))) {
      throw new Error('automated cycle service configuration must use the exact schema');
    }
    if (typeof config.now !== 'function' || typeof config.runnerFactory !== 'function') {
      throw new Error('automated cycle service factories are invalid');
    }
    requireMethod(config.budgetReader, 'read', 'budgetReader');
    for (const method of ['readActiveCycle', 'createCycle', 'readStage', 'prepareStage', 'completeStage', 'completeCycle', 'readClaimPreconditions']) {
      requireMethod(config.cycleRepository, method, 'cycleRepository');
    }
    for (const method of ['reconcile', 'execute', 'commit']) requireMethod(config.stageDriver, method, 'stageDriver');
    requireMethod(config.feeSettlementObserver, 'observe', 'feeSettlementObserver');
    const liveMode = config.liveMode;
    if (typeof liveMode !== 'boolean') throw new Error('automated cycle service liveMode must be a boolean');
    const mode = config.mode ?? (liveMode ? 'production' : 'rehearsal');
    if (mode !== 'production' && mode !== 'rehearsal') {
      throw new Error('automated cycle service mode must be "production" or "rehearsal"');
    }
    const providerMode = config.providerMode ?? null;
    if (providerMode !== null && providerMode !== 'live' && providerMode !== 'fake') {
      throw new Error('automated cycle service providerMode must be "live" or "fake"');
    }
    const dryRun = config.dryRun ?? false;
    if (typeof dryRun !== 'boolean') throw new Error('automated cycle service dryRun must be a boolean');
    if (dryRun && (mode !== 'production' || providerMode !== 'fake' || liveMode !== false)) {
      throw new Error('automated cycle service dryRun requires production mode with fake providers and liveMode=false');
    }
    this.#dryRun = dryRun;
    if (mode === 'production' && providerMode !== null && providerMode !== 'live' && !dryRun) {
      throw new Error('automated cycle service production providerMode must be "live"');
    }
    if (mode === 'production' && liveMode !== true && !dryRun) {
      throw new Error('automated cycle service production mode requires liveMode=true');
    }
    if (providerMode !== null && liveMode !== (providerMode === 'live') && !dryRun) {
      throw new Error('automated cycle service liveMode must match providerMode');
    }
    if (config.rehearsalSessionId !== undefined && (typeof config.rehearsalSessionId !== 'string'
      || !/^rehearsal-[0-9a-f-]{36}$/.test(config.rehearsalSessionId)
      || mode !== 'rehearsal' || providerMode !== 'fake')) {
      throw new Error('automated cycle service rehearsalSessionId requires fake rehearsal execution');
    }
    const policyEngine = config.policyEngine === undefined ? null : assertPolicyEngine(config.policyEngine);
    if (config.recoveryGuard !== undefined && typeof config.recoveryGuard !== 'function') {
      throw new Error('automated cycle service recoveryGuard must be a function');
    }
    if (config.beforeComplete !== undefined && typeof config.beforeComplete !== 'function') {
      throw new Error('automated cycle service beforeComplete must be a function');
    }
    if (config.beforeMutation !== undefined && typeof config.beforeMutation !== 'function') {
      throw new Error('automated cycle service beforeMutation must be a function');
    }
    if (config.policyCapUsdg !== undefined && (typeof config.policyCapUsdg !== 'string' || !decimalPattern.test(config.policyCapUsdg))) {
      throw new Error('automated cycle service policyCapUsdg must be a canonical unsigned decimal string');
    }
    if (liveMode && policyEngine === null) throw new Error('live automated cycle service requires a policyEngine');
    if (liveMode && (typeof config.packId !== 'string' || config.packId.length === 0)) {
      throw new Error('live automated cycle service requires a policy packId');
    }
    if (config.packId !== undefined && (typeof config.packId !== 'string' || config.packId.length === 0)) {
      throw new Error('automated cycle service packId is invalid');
    }
    this.#owner = config.owner;
    this.#liveMode = liveMode;
    this.#mode = mode;
    this.#providerMode = providerMode;
    this.#packId = config.packId ?? null;
    this.#policyEngine = policyEngine;
    this.#policyCapUsdg = config.policyCapUsdg ?? null;
    this.#recoveryGuard = config.recoveryGuard ?? null;
    this.#beforeComplete = config.beforeComplete ?? null;
    this.#beforeMutation = config.beforeMutation ?? null;
    this.#rehearsalSessionId = config.rehearsalSessionId ?? null;
    this.#leaseTtlMs = config.leaseTtlMs;
    this.#now = config.now;
    this.#leaseStore = config.leaseStore;
    this.#budgetReader = config.budgetReader;
    this.#cycleRepository = config.cycleRepository;
    this.#runnerFactory = config.runnerFactory;
    this.#stageDriver = config.stageDriver;
    this.#feeSettlementObserver = config.feeSettlementObserver;
  }

  async runOnce({ signal } = {}) {
    return this.#run({ signal, requireActive: false });
  }

  async recoverActiveCycle({ signal } = {}) {
    return this.#run({ signal, requireActive: true });
  }

  async #run({ signal, requireActive }) {
    let lease;
    let heartbeatTimer;
    let heartbeatError;
    let activeContext;
    try {
      lease = acquireLease({
        store: this.#leaseStore,
        owner: this.#owner,
        now: this.#now(),
        ttlMs: this.#leaseTtlMs,
      });
    } catch (error) {
      if (/active cycle lease/.test(error.message)) {
        return { status: 'LEASE_HELD', cycleId: null, stage: null };
      }
      throw error;
    }

    try {
      assertNotAborted(signal);
      let cycle = await this.#cycleRepository.readActiveCycle();
      let createdCycle = false;
      if (cycle === null) {
        if (requireActive) return { status: 'NO_ACTIVE_CYCLE', cycleId: null, stage: null };
        const budget = await this.#budgetReader.read();
        if (budget?.packPriceUsdg === '0') {
          return {
            status: 'WAITING_FOR_PROCESS_BUDGET',
            cycleId: null,
            stage: null,
            requiredProcessUsdg: '0',
          };
        }
        const decision = decideCycleBudget(budget);
        if (!decision.ready) {
          return {
            status: decision.reason === 'ACTIVE_CYCLE' ? 'ACTIVE_CYCLE_NOT_RECONCILED' : 'WAITING_FOR_PROCESS_BUDGET',
            cycleId: null,
            stage: null,
            requiredProcessUsdg: decision.requiredProcessUsdg,
          };
        }
        if (this.#policyEngine) {
          const policyDecision = await this.#policyEngine.evaluate({
            boundary: 'cycle-start',
            releaseAmountMicroUsdg: decision.releaseAmount,
            liveMode: this.#liveMode,
            mode: this.#mode,
            capUsdg: this.#policyCapUsdg ?? undefined,
          });
          if (!policyDecision?.allowed) {
            return {
              status: 'POLICY_REFUSED',
              cycleId: null,
              stage: null,
              reason: policyDecision?.reason ?? 'POLICY_ENGINE_INVALID_DECISION',
            };
          }
        }
        assertLeaseCurrent({ store: this.#leaseStore, lease, now: this.#now() });
        cycle = await this.#cycleRepository.createCycle({
          releaseAmount: decision.releaseAmount,
          mode: this.#mode,
          ...(this.#providerMode === null ? {} : { providerMode: this.#providerMode }),
          ...(this.#dryRun ? { dryRun: true } : {}),
          ...(this.#rehearsalSessionId === null ? {} : { rehearsalSessionId: this.#rehearsalSessionId }),
        });
        createdCycle = true;
        assertLeaseCurrent({ store: this.#leaseStore, lease, now: this.#now() });
      }
      if (!cycle || typeof cycle.cycleId !== 'string') throw new Error('active cycle record is invalid');
      if (cycle.mode !== 'production' && cycle.mode !== 'rehearsal') {
        return { status: 'CYCLE_MODE_UNRESOLVED', cycleId: cycle.cycleId, stage: null };
      }
      if (cycle.mode !== this.#mode) {
        return { status: 'CYCLE_MODE_MISMATCH', cycleId: cycle.cycleId, stage: null };
      }
      if (this.#providerMode !== null && cycle.providerMode !== this.#providerMode) {
        return {
          status: cycle.providerMode === null ? 'CYCLE_PROVIDER_MODE_UNRESOLVED' : 'CYCLE_PROVIDER_MODE_MISMATCH',
          cycleId: cycle.cycleId,
          stage: null,
        };
      }
      if (Boolean(cycle.dryRun) !== this.#dryRun) {
        return {
          status: cycle.dryRun === true ? 'CYCLE_DRY_RUN_MISMATCH' : 'CYCLE_DRY_RUN_UNRESOLVED',
          cycleId: cycle.cycleId,
          stage: null,
        };
      }
      if (this.#rehearsalSessionId !== null && cycle.rehearsalSessionId !== this.#rehearsalSessionId) {
        return {
          status: cycle.rehearsalSessionId === null ? 'CYCLE_REHEARSAL_SESSION_UNRESOLVED' : 'CYCLE_REHEARSAL_SESSION_MISMATCH',
          cycleId: cycle.cycleId,
          stage: null,
        };
      }
      if (typeof cycle.terminalState === 'string') {
        return { status: cycle.terminalState, cycleId: cycle.cycleId, stage: null };
      }
      if (!createdCycle && this.#recoveryGuard !== null) {
        const recovery = await this.#recoveryGuard({ cycleId: cycle.cycleId, mode: cycle.mode });
        if (!recovery || recovery.resumable !== true) {
          return {
            status: 'RECOVERY_REFUSED',
            cycleId: cycle.cycleId,
            stage: null,
            reason: recovery?.reason ?? 'RECOVERY_GUARD_INVALID',
          };
        }
      }
      const runner = this.#runnerFactory(cycle.cycleId);
      const assertLease = () => {
        if (heartbeatError) throw heartbeatError;
        assertLeaseCurrent({ store: this.#leaseStore, lease, now: this.#now() });
      };
      const assertMutationAllowed = async ({
        boundary = 'mutation',
        cycleId = cycle.cycleId,
        releaseAmountMicroUsdg = cycle.releaseAmount,
        packId = this.#packId,
        requestDigest = null,
        fencingToken = lease.fencingToken,
        stage = activeContext?.stage ?? null,
      } = {}) => {
        if (cycleId !== cycle.cycleId || releaseAmountMicroUsdg !== cycle.releaseAmount || packId !== this.#packId) {
          throw new Error('automated cycle mutation guard context does not match the active cycle');
        }
        if (stage !== activeContext?.stage) throw new Error('automated cycle mutation guard stage does not match the active stage');
        if (requestDigest !== null && (typeof requestDigest !== 'string' || !digestPattern.test(requestDigest))) {
          throw new Error('automated cycle mutation guard request digest is invalid');
        }
        if (fencingToken !== lease.fencingToken) throw new Error('automated cycle mutation guard fencing token is stale');
        assertLease();
        if (this.#policyEngine) {
          const policyDecision = await this.#policyEngine.assertExecutionAllowed({
            boundary,
            cycleId,
            releaseAmountMicroUsdg,
            packId,
            requestDigest,
            fencingToken,
            stage,
            liveMode: this.#liveMode,
            mode: this.#mode,
            capUsdg: this.#policyCapUsdg ?? undefined,
          });
          assertPolicyDecision(policyDecision);
        }
        assertLease();
        return lease.fencingToken;
      };
      const scheduleHeartbeat = () => {
        heartbeatTimer = setTimeout(() => {
          if (heartbeatError) return;
          try {
            lease = renewLease({
              store: this.#leaseStore,
              lease,
              now: this.#now(),
              ttlMs: this.#leaseTtlMs,
            });
            if (activeContext) Object.assign(activeContext.lease, lease);
            scheduleHeartbeat();
          } catch (error) {
            heartbeatError = error;
          }
        }, Math.max(1, Math.floor(this.#leaseTtlMs / 2)));
        heartbeatTimer.unref?.();
      };
      scheduleHeartbeat();

      for (const stage of AUTOMATED_CYCLE_STAGES) {
        assertNotAborted(signal);
        assertLease();
        const current = await this.#cycleRepository.readStage(cycle.cycleId, stage);
        if (current?.status === 'COMPLETE') continue;
        await assertJoinPreconditions(this.#cycleRepository, cycle.cycleId, stage);
        const context = {
          cycleId: cycle.cycleId,
          stage,
          runner,
          lease: { ...lease },
          fencingToken: lease.fencingToken,
          releaseAmountMicroUsdg: cycle.releaseAmount,
          packId: this.#packId,
          assertLease,
          assertMutationAllowed,
        };
        activeContext = context;
        const intent = await this.#cycleRepository.prepareStage(cycle.cycleId, stage, context);
        assertLease();
        context.intent = intent;
        let evidence = await this.#stageDriver.reconcile(context);
        assertLease();
        if (evidence === null) {
          if (this.#policyEngine && stage === 'claim-process') {
            const policyDecision = await this.#policyEngine.admit({
              boundary: 'claim-process',
              cycleId: cycle.cycleId,
              releaseAmountMicroUsdg: cycle.releaseAmount,
              packId: this.#packId,
              liveMode: this.#liveMode,
              mode: this.#mode,
              capUsdg: this.#policyCapUsdg ?? undefined,
            });
            assertPolicyDecision(policyDecision);
          }
          if (this.#policyEngine && stage === 'purchase') {
            const policyDecision = await this.#policyEngine.evaluatePurchase({
              boundary: 'purchase',
              cycleId: cycle.cycleId,
              releaseAmountMicroUsdg: cycle.releaseAmount,
              packId: this.#packId,
              liveMode: this.#liveMode,
              mode: this.#mode,
              capUsdg: this.#policyCapUsdg ?? undefined,
            });
            assertPolicyDecision(policyDecision);
          }
          await assertMutationAllowed({ boundary: 'mutation' });
          if (this.#beforeMutation !== null) {
            await this.#beforeMutation(Object.freeze({
              cycleId: cycle.cycleId,
              stage,
              mode: cycle.mode,
              providerMode: cycle.providerMode ?? null,
              releaseAmountMicroUsdg: cycle.releaseAmount,
              assertLease,
            }));
            assertLease();
          }
          await this.#stageDriver.execute(context);
          assertLease();
          evidence = await this.#stageDriver.reconcile(context);
          assertLease();
        }
        if (evidence === null) throw new Error(`${stage} mutation remains unresolved after execution`);
        await this.#stageDriver.commit({ ...context, evidence });
        assertLease();
        await this.#cycleRepository.completeStage(cycle.cycleId, stage, evidence, { lease: { ...lease }, assertLease });
        assertLease();
        lease = renewLease({
          store: this.#leaseStore,
          lease,
          now: this.#now(),
          ttlMs: this.#leaseTtlMs,
        });
      }

      activeContext = null;
      assertLease();
      if (this.#beforeComplete !== null) {
        await this.#beforeComplete(Object.freeze({
          cycleId: cycle.cycleId,
          mode: cycle.mode,
          providerMode: cycle.providerMode ?? null,
          runner,
        }));
        assertLease();
      }
      await this.#cycleRepository.completeCycle(cycle.cycleId, { lease: { ...lease }, assertLease });
      assertLease();
      let feeSettlement;
      try {
        feeSettlement = await this.#feeSettlementObserver.observe(cycle.cycleId);
      } catch (error) {
        feeSettlement = { status: 'OBSERVATION_FAILED', error: error.message };
      }
      return { status: 'COMPLETE', cycleId: cycle.cycleId, stage: 'closed', feeSettlement };
    } finally {
      activeContext = null;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (lease) releaseLease({ store: this.#leaseStore, lease });
    }
  }
}
