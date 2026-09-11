import { createRewardSelectionSnapshot } from '../../src/automation/reward-selection-snapshot.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { AutomatedCycleService, AUTOMATED_CYCLE_STAGES } from '../../src/automation/automated-cycle-service.mjs';

class MemoryLeaseStore {
  version = 0;
  lease = null;
  readLease() { return { version: this.version, lease: this.lease && structuredClone(this.lease) }; }
  compareAndSwapLease(expectedVersion, nextLease) {
    if (expectedVersion !== this.version) return false;
    this.version += 1;
    this.lease = nextLease && structuredClone(nextLease);
    return true;
  }
}

class MemoryCycleRepository {
  active = null;
  next = 1;
  stages = new Map();
  completed = [];
  created = [];

  async readActiveCycle() { return this.active; }
  async createCycle({ releaseAmount, mode, providerMode = null, rehearsalSessionId = null, packPlan, rewardRecipientLimit, configurationRevision }) {
    if (this.active !== null) throw new Error('active cycle exists');
    this.active = { cycleId: `cycle-${this.next++}`, releaseAmount, mode, providerMode, rehearsalSessionId };
    if (packPlan !== undefined) this.active.packPlanSnapshot = { plan: structuredClone(packPlan) };
    if (rewardRecipientLimit !== undefined) this.active.rewardSelection = createRewardSelectionSnapshot({ cycleId: this.active.cycleId, rewardRecipientLimit, configurationRevision });
    this.created.push(structuredClone(this.active));
    this.stages.set(this.active.cycleId, new Map());
    return structuredClone(this.active);
  }
  async readStage(cycleId, stage) { return structuredClone(this.stages.get(cycleId)?.get(stage) ?? { status: 'PENDING' }); }
  async prepareStage(cycleId, stage) {
    const current = await this.readStage(cycleId, stage);
    if (current.status === 'COMPLETE') return current;
    const prepared = { status: 'PREPARED', intentId: `${cycleId}:${stage}` };
    this.stages.get(cycleId).set(stage, prepared);
    return structuredClone(prepared);
  }
  async completeStage(cycleId, stage, evidence) {
    this.stages.get(cycleId).set(stage, { status: 'COMPLETE', evidence: structuredClone(evidence) });
  }
  async completeCycle(cycleId) {
    this.completed.push(cycleId);
    this.active = null;
  }
  async readClaimPreconditions() {
    return { heldAssets: false, unattributed: false, unresolvedObligations: false };
  }
}

const readyBudget = () => ({
  availableProcessWei: '55000000',
  packPriceWei: '50000000',
  outboundCapWei: '1000000',
  returnCapWei: '1000000',
  operatingMarginWei: '3000000',
  activeCycleId: null,
});

function fixture({ readCycleConfiguration, readPackPlan, budget = readyBudget(), crashStage = null, liveMode = false, mode = undefined, providerMode = undefined, policyEngine = undefined, packId = undefined, recoveryGuard = undefined, beforeComplete = undefined, now = () => 1_000, stageContextSink = undefined } = {}) {
  const leaseStore = new MemoryLeaseStore();
  const cycles = new MemoryCycleRepository();
  const executions = [];
  const commits = [];
  const providerEvidence = new Map();
  let crash = crashStage;
  const serviceConfig = {
    owner: 'worker-one',
    leaseTtlMs: 1_000,
    now,
    leaseStore,
    budgetReader: { read: async () => structuredClone(budget) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile(context) {
        stageContextSink?.(context);
        const { cycleId, stage } = context;
        return providerEvidence.get(`${cycleId}:${stage}`) ?? null;
      },
      async execute(context) {
        stageContextSink?.(context);
        const { cycleId, stage, intent } = context;
        executions.push(stage);
        const evidence = { transactionId: `${cycleId}-${stage}`, intentId: intent.intentId };
        providerEvidence.set(`${cycleId}:${stage}`, evidence);
        if (crash === stage) {
          crash = null;
          throw new Error('simulated crash after broadcast');
        }
      },
      async commit({ runner, stage, evidence }) {
        assert.equal(runner.cycleId, evidence.transactionId.slice(0, 7));
        commits.push(stage);
      },
    },
    feeSettlementObserver: { observe: async cycleId => ({ cycleId, status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  };
  if (readCycleConfiguration !== undefined) serviceConfig.readCycleConfiguration = readCycleConfiguration;
  if (readPackPlan !== undefined) serviceConfig.readPackPlan = readPackPlan;
  if (policyEngine !== undefined) serviceConfig.policyEngine = policyEngine;
  if (packId !== undefined) serviceConfig.packId = packId;
  if (mode !== undefined) serviceConfig.mode = mode;
  if (providerMode !== undefined) serviceConfig.providerMode = providerMode;
  if (recoveryGuard !== undefined) serviceConfig.recoveryGuard = recoveryGuard;
  if (beforeComplete !== undefined) serviceConfig.beforeComplete = beforeComplete;
  serviceConfig.liveMode = liveMode;
  const service = new AutomatedCycleService(serviceConfig);
  return { service, cycles, executions, commits, budget };
}

test('seals an explicit rehearsal mode into each newly created cycle', async () => {
  const { service, cycles } = fixture({ mode: 'rehearsal' });
  const result = await service.runOnce();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(cycles.completed.length, 1);
  assert.equal(cycles.completed[0], 'cycle-1');
  assert.equal(cycles.stages.get('cycle-1')?.size, AUTOMATED_CYCLE_STAGES.length);
  assert.equal(cycles.created[0].mode, 'rehearsal');
});

test('refuses an active cycle whose durable provider mode differs before running a stage', async () => {
  const { service, cycles, executions } = fixture({ mode: 'rehearsal', providerMode: 'fake' });
  cycles.active = {
    cycleId: 'cycle-live-rehearsal', releaseAmount: '55000000', mode: 'rehearsal', providerMode: 'live',
  };
  cycles.stages.set(cycles.active.cycleId, new Map());

  assert.deepEqual(await service.recoverActiveCycle(), {
    status: 'CYCLE_PROVIDER_MODE_MISMATCH', cycleId: 'cycle-live-rehearsal', stage: null,
  });
  assert.deepEqual(executions, []);
});

test('refuses a service whose live flag disagrees with its declared provider mode', () => {
  assert.throws(
    () => fixture({ mode: 'rehearsal', providerMode: 'live', liveMode: false }),
    /liveMode must match providerMode/,
  );
  assert.throws(
    () => fixture({ mode: 'production', providerMode: 'live', liveMode: false }),
    /production mode requires liveMode=true/,
  );
});

test('waits without creating a cycle when process liability is below budget', async () => {
  const { service, cycles } = fixture({ budget: { ...readyBudget(), availableProcessWei: '54999999' } });
  assert.deepEqual(await service.runOnce(), {
    status: 'WAITING_FOR_PROCESS_BUDGET',
    cycleId: null,
    stage: null,
    requiredProcessWei: '55000000',
  });
  assert.equal(cycles.active, null);
});

test('recovers a prepared supplementary settlement without a normal active cycle', async () => {
  const cycles = new MemoryCycleRepository();
  const position = {
    positionId: `held:${'a'.repeat(64)}`,
    cycleId: 'cycle-complete',
    packId: 'base-pack',
    memo: 'memo-supplementary',
    mint: 'mint-supplementary',
    cardRef: 'mint-supplementary',
    costMicroUsd: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  const settlement = {
    positionId: position.positionId,
    cycleId: position.cycleId,
    manifestId: `${position.cycleId}:supplementary:1`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  cycles.listHeldPositions = async () => [structuredClone(position)];
  cycles.readSupplementarySettlement = async positionId => {
    assert.equal(positionId, position.positionId);
    return structuredClone(settlement);
  };
  const dispatched = [];
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    liveMode: false,
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => structuredClone(readyBudget()) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async runSupplementarySettlement(context) {
        dispatched.push(context);
        return {
          status: 'ADVANCED',
          positionId: context.position.positionId,
          cycleId: context.settlement.cycleId,
          manifestId: context.settlement.manifestId,
          stage: 'supplementary-buyback',
          state: 'BUYBACK_SENT_UNKNOWN',
        };
      },
      async reconcile() { return { transactionId: 'unexpected-main-stage' }; },
      async execute() { throw new Error('normal cycle must not execute during supplementary recovery'); },
      async commit() {},
    },
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  });

  assert.deepEqual(await service.recoverActiveCycle(), {
    status: 'SUPPLEMENTARY_SETTLEMENT',
    cycleId: position.cycleId,
    stage: 'supplementary-buyback',
    positionId: position.positionId,
    manifestId: settlement.manifestId,
    settlementState: 'BUYBACK_SENT_UNKNOWN',
  });
  assert.equal(dispatched.length, 1);
  assert.equal(cycles.created.length, 0);
});

test('leaves normal recovery idle when a supplementary handler is pending', async () => {
  const cycles = new MemoryCycleRepository();
  const position = {
    positionId: `held:${'c'.repeat(64)}`,
    cycleId: 'cycle-complete-pending',
    packId: 'base-pack',
    memo: 'memo-supplementary-pending',
    mint: 'mint-supplementary-pending',
    cardRef: 'mint-supplementary-pending',
    costMicroUsd: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'d'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  const settlement = {
    positionId: position.positionId,
    cycleId: position.cycleId,
    manifestId: `${position.cycleId}:supplementary:1`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  cycles.listHeldPositions = async () => [structuredClone(position)];
  cycles.readSupplementarySettlement = async () => structuredClone(settlement);
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    liveMode: false,
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => structuredClone(readyBudget()) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async runSupplementarySettlement() {
        return {
          status: 'PENDING',
          positionId: position.positionId,
          cycleId: position.cycleId,
          manifestId: settlement.manifestId,
          stage: null,
          state: settlement.state,
        };
      },
      async reconcile() { return { transactionId: 'unexpected-main-stage' }; },
      async execute() { throw new Error('normal cycle must not execute during inactive recovery'); },
      async commit() {},
    },
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  });

  assert.deepEqual(await service.recoverActiveCycle(), {
    status: 'NO_ACTIVE_CYCLE', cycleId: null, stage: null,
  });
  assert.equal(cycles.created.length, 0);
});

test('runs one cycle in fixed order and keeps fee settlement observational', async () => {
  const { service, cycles, executions, commits } = fixture();
  const result = await service.runOnce();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.cycleId, 'cycle-1');
  assert.equal(result.stage, 'closed');
  assert.equal(result.feeSettlement.status, 'PENDING_BENEFICIARY_CLAIMS');
  assert.deepEqual(executions, AUTOMATED_CYCLE_STAGES);
  assert.deepEqual(commits, AUTOMATED_CYCLE_STAGES);
  assert.deepEqual(cycles.completed, ['cycle-1']);
});

test('passes a deterministic clock value to every stage context', async () => {
  const contexts = [];
  const { service } = fixture({
    now: () => 123_456,
    stageContextSink: context => contexts.push(context),
  });

  await service.runOnce();

  assert.ok(contexts.length > 0);
  assert.ok(contexts.every(context => context.nowMs === 123_456));
});

test('seals rehearsal evidence after reconciliation and before archival', async () => {
  const observed = [];
  const { service, cycles } = fixture({
    mode: 'rehearsal',
    providerMode: 'fake',
    beforeComplete: async ({ cycleId, runner }) => {
      observed.push({ cycleId, runnerCycleId: runner.cycleId, completed: cycles.completed.length });
    },
  });
  await service.runOnce();
  assert.deepEqual(observed, [{ cycleId: 'cycle-1', runnerCycleId: 'cycle-1', completed: 0 }]);
  assert.deepEqual(cycles.completed, ['cycle-1']);
});

test('a live service consults policy before cycle creation, claim, purchase, and each mutation fence', async () => {
  const calls = [];
  const fenceInputs = [];
  const policyEngine = {
    async evaluate(input) { calls.push(['evaluate', input.boundary]); return { allowed: true }; },
    async admit(input) { calls.push(['admit', input.boundary]); return { allowed: true, cycleDigest: 'sha256:policy' }; },
    async evaluatePurchase(input) { calls.push(['purchase', input.boundary]); return { allowed: true, cycleDigest: 'sha256:policy' }; },
    async assertExecutionAllowed(input) { fenceInputs.push(input); calls.push(['fence', input.boundary]); return { allowed: true }; },
  };
  const { service } = fixture({ liveMode: true, packId: 'base-pack', policyEngine });
  const result = await service.runOnce();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(calls.slice(0, 2), [
    ['evaluate', 'cycle-start'],
    ['fence', 'mutation'],
  ]);
  assert.ok(calls.findIndex(call => call[0] === 'admit') > 0);
  assert.ok(calls.some(call => call[0] === 'purchase' && call[1] === 'purchase'));
  assert.equal(calls.filter(call => call[0] === 'fence').length, AUTOMATED_CYCLE_STAGES.length);
  for (const input of fenceInputs) {
    assert.equal(input.cycleId, 'cycle-1');
    assert.equal(input.releaseAmountWei, '55000000');
    assert.equal(input.packId, 'base-pack');
    assert.ok(AUTOMATED_CYCLE_STAGES.includes(input.stage));
    assert.match(input.fencingToken, /^[0-9a-f-]{36}$/);
  }
});

test('a policy refusal prevents a new live cycle before its durable cycle record is created', async () => {
  const policyEngine = {
    async evaluate() { return { allowed: false, reason: 'KILL_SWITCH' }; },
    async admit() { throw new Error('claim policy must not run'); },
    async evaluatePurchase() { throw new Error('purchase policy must not run'); },
    async assertExecutionAllowed() { throw new Error('mutation fence must not run'); },
  };
  const { service, cycles } = fixture({ liveMode: true, packId: 'base-pack', policyEngine });
  assert.deepEqual(await service.runOnce(), {
    status: 'POLICY_REFUSED', cycleId: null, stage: null, reason: 'KILL_SWITCH',
  });
  assert.equal(cycles.active, null);
});

test('freezes the operations-wallet stage order', () => {
  assert.deepEqual(AUTOMATED_CYCLE_STAGES, [
    'eligibility-snapshot',
    'claim-process',
    'outbound',
    'purchase',
    'open',
    'epic-gate',
    'buyback',
    'return',
    'payout',
  ]);
});

/**
 * ADR-0025 `refresh-after-readmission`'s repository surface, minimal enough for the orchestration
 * tests below: one active cycle carrying an immutable `admission`, plus the quote-refresh
 * projection accessors and selector `AutomatedCycleService` reads and calls directly.
 */
function refreshFixtureRepository({ admission, releaseAmount = '55000000' } = {}) {
  const stages = new Map();
  const selectCalls = [];
  const completed = [];
  let active = { cycleId: 'cycle-refresh-1', releaseAmount, mode: 'rehearsal', admission };
  let refresh = { state: 'REFRESH_REQUIRED', expiryDigest: `sha256:${'1'.repeat(64)}` };
  return {
    get selectCalls() { return selectCalls; },
    get completed() { return completed; },
    async readActiveCycle() { return active; },
    async createCycle() { throw new Error('must not create a new cycle while one is already active'); },
    async readStage(_cycleId, stage) { return stages.get(stage) ?? { status: 'PENDING' }; },
    async prepareStage(cycleId, stage) {
      const prepared = { status: 'PREPARED', intentId: `${cycleId}:${stage}` };
      stages.set(stage, prepared);
      return prepared;
    },
    async completeStage(_cycleId, stage, evidence) { stages.set(stage, { status: 'COMPLETE', evidence }); },
    async completeCycle() { completed.push(active.cycleId); active = null; },
    async readClaimPreconditions() { return { unattributed: false, unresolvedObligations: false }; },
    async readOutboundQuoteRefresh() { return refresh; },
    async readFinalizedClaimCustodyEvidence() { return { cycleId: 'cycle-refresh-1' }; },
    async selectOutboundQuoteRefresh(cycleId, args) {
      selectCalls.push({ cycleId, ...args });
      refresh = { state: 'ACTIVE', replacement: args.replacement };
    },
  };
}

/** The same reconcile/execute-then-reconcile provider shape `fixture()`'s stageDriver uses. */
function providerStageDriver() {
  const providerEvidence = new Map();
  const executions = [];
  return {
    executions,
    driver: {
      async reconcile(context) {
        return providerEvidence.get(`${context.cycleId}:${context.stage}`) ?? null;
      },
      async execute(context) {
        executions.push(context.stage);
        providerEvidence.set(`${context.cycleId}:${context.stage}`, { transactionId: `${context.cycleId}-${context.stage}` });
      },
      async commit() {},
    },
  };
}

test('reports a benign wait instead of a crash loop when a quote refresh is durably required but no refresh capability is wired', async () => {
  const cycleRepository = refreshFixtureRepository({ admission: { cycleId: 'cycle-refresh-1', marker: 'original' } });
  const { driver, executions } = providerStageDriver();
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => readyBudget() },
    cycleRepository,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: driver,
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
    liveMode: false,
  });

  const result = await service.recoverActiveCycle();
  assert.deepEqual(result, { status: 'WAITING_FOR_QUOTE_REFRESH', cycleId: 'cycle-refresh-1', stage: 'outbound' });
  assert.deepEqual(executions, ['eligibility-snapshot', 'claim-process']);
  assert.equal(cycleRepository.selectCalls.length, 0);
  assert.equal(cycleRepository.completed.length, 0);
});

test('a later tick fetches and atomically selects a replacement, then proceeds through outbound normally', async () => {
  const originalAdmission = { cycleId: 'cycle-refresh-1', marker: 'original' };
  const cycleRepository = refreshFixtureRepository({ admission: originalAdmission });
  const { driver, executions } = providerStageDriver();
  const planCalls = [];
  const evaluateCalls = [];
  const replacement = { schema: 'hookemon.policy-admission.v2', cycleId: 'cycle-refresh-1', marker: 'replacement' };
  const quoteRefreshPlanner = {
    async plan(input) { planCalls.push(input); return replacement; },
  };
  const policyEngine = {
    async evaluate() { return { allowed: true }; },
    async admit() { return { allowed: true, cycleDigest: 'sha256:policy' }; },
    async evaluatePurchase() { return { allowed: true, cycleDigest: 'sha256:policy' }; },
    async assertExecutionAllowed() { return { allowed: true }; },
    async evaluateQuoteRefresh(input) {
      evaluateCalls.push(input);
      return { allowed: true, refreshPolicyDecisionDigest: `sha256:${'2'.repeat(64)}` };
    },
  };
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => readyBudget() },
    cycleRepository,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: driver,
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
    liveMode: false,
    policyEngine,
    quoteRefreshPlanner,
  });

  const result = await service.recoverActiveCycle();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(executions, ['eligibility-snapshot', 'claim-process', 'outbound', 'purchase', 'open', 'epic-gate', 'buyback', 'return', 'payout']);

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0].cycleId, 'cycle-refresh-1');
  assert.equal(planCalls[0].admission, originalAdmission);
  assert.deepEqual(planCalls[0].custody, { cycleId: 'cycle-refresh-1' });

  assert.equal(evaluateCalls.length, 1);
  assert.equal(evaluateCalls[0].admission, originalAdmission);
  assert.equal(evaluateCalls[0].replacement, replacement);

  assert.equal(cycleRepository.selectCalls.length, 1);
  assert.deepEqual(cycleRepository.selectCalls[0], {
    cycleId: 'cycle-refresh-1',
    predecessorExpiryDigest: `sha256:${'1'.repeat(64)}`,
    replacement,
    refreshPolicyDecisionDigest: `sha256:${'2'.repeat(64)}`,
    operations: null,
    assertLease: cycleRepository.selectCalls[0].assertLease,
  });
});

test('reconciles a crash after broadcast without executing the stage twice', async () => {
  const { service, executions, commits } = fixture({ crashStage: 'outbound' });
  await assert.rejects(() => service.runOnce(), /simulated crash/);
  const result = await service.recoverActiveCycle();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(executions.filter(stage => stage === 'outbound').length, 1);
  assert.deepEqual(commits, AUTOMATED_CYCLE_STAGES);
});

test('refuses recovery under the acquired lease when the journal has an unresolved chain attempt', async () => {
  let guardCalls = 0;
  const { service, cycles, executions } = fixture({
    recoveryGuard: async () => {
      guardCalls += 1;
      return { resumable: false, reason: 'CHAIN_ATTEMPT_UNRESOLVED' };
    },
  });
  cycles.active = { cycleId: 'cycle-existing', releaseAmount: '55000000', mode: 'rehearsal' };
  cycles.stages.set('cycle-existing', new Map());

  assert.deepEqual(await service.recoverActiveCycle(), {
    status: 'RECOVERY_REFUSED', cycleId: 'cycle-existing', stage: null, reason: 'CHAIN_ATTEMPT_UNRESOLVED',
  });
  assert.equal(guardCalls, 1);
  assert.deepEqual(executions, []);
});

test('rejects duplicate concurrent wakeups through the durable lease', async () => {
  const { service } = fixture();
  const held = service.runOnce();
  const duplicate = await service.runOnce();
  assert.equal(duplicate.status, 'LEASE_HELD');
  await held;
});

test('refreshes the fenced lease tuple exposed to an in-flight stage', async () => {
  const leaseStore = new MemoryLeaseStore();
  const cycles = new MemoryCycleRepository();
  const observed = [];
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    liveMode: false,
    leaseTtlMs: 20,
    now: () => 1_000,
    leaseStore,
    budgetReader: { read: async () => structuredClone(readyBudget()) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile() { return { transactionId: 'already-observed' }; },
      async execute() {},
      async commit({ lease, fencingToken, stage }) {
        if (stage === 'eligibility-snapshot') await new Promise(resolve => setTimeout(resolve, 50));
        observed.push({ lease: { ...lease }, fencingToken, current: leaseStore.readLease().lease });
      },
    },
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  });
  await service.runOnce();
  assert.ok(observed.length > 0);
  assert.equal(observed[0].lease.owner, 'worker-one');
  assert.equal(observed[0].lease.version, observed[0].current.version);
  assert.equal(observed[0].fencingToken, observed[0].current.fencingToken);
  assert.ok(observed[0].lease.version > 1);
});

test('fences a stalled stage after lease expiry and replacement acquisition', async () => {
  const leaseStore = new MemoryLeaseStore();
  const cycles = new MemoryCycleRepository();
  let now = 1_000;
  let releaseStalledStage;
  let stalledStage;
  let snapshotExecutions = 0;
  const providerEvidence = new Map();
  const makeService = owner => new AutomatedCycleService({
    owner,
    liveMode: false,
    leaseTtlMs: 1_000,
    now: () => now,
    leaseStore,
    budgetReader: { read: async () => structuredClone(readyBudget()) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile({ cycleId, stage }) { return providerEvidence.get(`${cycleId}:${stage}`) ?? null; },
      async execute({ cycleId, stage, intent, assertMutationAllowed }) {
        if (owner === 'worker-one' && stage === 'eligibility-snapshot') {
          stalledStage = new Promise(resolve => { releaseStalledStage = resolve; });
          await stalledStage;
        }
        if (assertMutationAllowed) await assertMutationAllowed({ boundary: 'broadcast' });
        if (stage === 'eligibility-snapshot') snapshotExecutions += 1;
        providerEvidence.set(`${cycleId}:${stage}`, { transactionId: `${cycleId}-${stage}`, intentId: intent.intentId });
      },
      async commit({ stage, assertLease }) {
        if (assertLease) assertLease();
        assert.equal(typeof stage, 'string');
      },
    },
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  });

  const first = makeService('worker-one').runOnce();
  while (!releaseStalledStage) await new Promise(resolve => setImmediate(resolve));
  now = 2_001;
  const replacement = await makeService('worker-two').runOnce();
  assert.equal(replacement.status, 'COMPLETE');
  releaseStalledStage();
  await assert.rejects(first, /owner token|lease/);
  assert.equal(snapshotExecutions, 1);
});

test('allows claim processing when held positions are within policy limits', async () => {
  const cycles = new MemoryCycleRepository();
  cycles.active = { cycleId: 'cycle-held-position', releaseAmount: '50000000', mode: 'rehearsal' };
  cycles.stages.set(cycles.active.cycleId, new Map([
    ['eligibility-snapshot', { status: 'COMPLETE', evidence: { blockHash: '0xabc' } }],
  ]));
  cycles.readClaimPreconditions = async () => ({
    heldAssets: true,
    unattributed: false,
    unresolvedObligations: false,
  });
  const executions = [];
  const evidence = new Map();
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    liveMode: false,
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => structuredClone(readyBudget()) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile({ cycleId, stage }) { return evidence.get(`${cycleId}:${stage}`) ?? null; },
      async execute({ cycleId, stage }) {
        executions.push(stage);
        evidence.set(`${cycleId}:${stage}`, { transactionId: `${cycleId}-${stage}` });
      },
      async commit() {},
    },
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  });

  const result = await service.recoverActiveCycle();

  assert.equal(result.status, 'COMPLETE');
  assert.ok(executions.includes('claim-process'));
});

test('requires the eligibility snapshot before claim and both snapshot plus return before payout', async () => {
  const cycles = new MemoryCycleRepository();
  cycles.active = { cycleId: 'cycle-join', releaseAmount: '50000000', mode: 'rehearsal' };
  cycles.stages.set('cycle-join', new Map());
  cycles.stages.get('cycle-join').set('eligibility-snapshot', { status: 'COMPLETE' });

  const executions = [];
  const providerEvidence = new Map();
  const service = new AutomatedCycleService({
    owner: 'worker-one',
    liveMode: false,
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => structuredClone(readyBudget()) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile({ cycleId, stage }) { return providerEvidence.get(`${cycleId}:${stage}`) ?? null; },
      async execute({ cycleId, stage }) {
        executions.push(stage);
        providerEvidence.set(`${cycleId}:${stage}`, { transactionId: `${cycleId}-${stage}` });
      },
      async commit() {},
    },
    feeSettlementObserver: { observe: async () => ({ status: 'PENDING_BENEFICIARY_CLAIMS' }) },
  });

  await assert.rejects(
    () => service.recoverActiveCycle(),
    /join incomplete.*'eligibility-snapshot'.*before 'claim-process'/,
  );
  assert.deepEqual(executions, [], 'claim-process must not execute without snapshot evidence');

  await cycles.completeStage('cycle-join', 'eligibility-snapshot', { blockHash: '0xabc' });
  for (const stage of ['claim-process', 'outbound', 'purchase', 'open', 'epic-gate', 'buyback']) {
    await cycles.completeStage('cycle-join', stage, { transactionId: `${stage}-evidence` });
  }
  cycles.stages.get('cycle-join').set('return', { status: 'COMPLETE' });

  await assert.rejects(
    () => service.recoverActiveCycle(),
    /join incomplete.*'return'.*before 'payout'/,
  );
  assert.deepEqual(executions, [], 'payout must never execute while return evidence is missing');

  await cycles.completeStage('cycle-join', 'return', { transactionId: 'return-evidence' });
  const result = await service.recoverActiveCycle();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(executions, ['payout']);
});


test('fixed plan repeats each cycle and an edit during execution applies only to the next', async () => {
  const first = { schema: 'hookemon.pack-plan.v1', revision: 1,
    orders: [{ pack: 'base-pack', quantity: 2 }, { pack: 'premium-pack', quantity: 1 }] };
  const replacement = { schema: 'hookemon.pack-plan.v1', revision: 2, orders: [{ pack: 'new-pack', quantity: 3 }] };
  let selection = structuredClone(first);
  let reads = 0;
  const { service, cycles } = fixture({ readPackPlan: async () => { reads++; return selection; } });
  await service.runOnce();
  await service.runOnce();
  assert.deepEqual(cycles.created.map(cycle => cycle.packPlanSnapshot.plan), [first, first]);
  assert.equal(reads, 2);
  selection = replacement;
  await service.runOnce();
  assert.deepEqual(cycles.created[2].packPlanSnapshot.plan, replacement);
  assert.deepEqual(cycles.created[0].packPlanSnapshot.plan, first);
});

test('edit after cycle starts does not reread or rewrite its frozen plan during recovery', async () => {
  const original = { schema: 'hookemon.pack-plan.v1', revision: 1, orders: [{ pack: 'base-pack', quantity: 2 }] };
  let selection = original;
  let reads = 0;
  const { service, cycles } = fixture({ crashStage: 'purchase', readPackPlan: async () => { reads++; return selection; } });
  await assert.rejects(service.runOnce(), /simulated crash/);
  selection = { schema: 'hookemon.pack-plan.v1', revision: 2, orders: [{ pack: 'premium-pack', quantity: 1 }] };
  await service.runOnce();
  assert.equal(reads, 1);
  assert.deepEqual(cycles.created[0].packPlanSnapshot.plan, original);
  await service.runOnce();
  assert.deepEqual(cycles.created[1].packPlanSnapshot.plan, selection);
});

test('empty selected plan starts no cycle even when a legacy pack is configured', async () => {
  const { service, cycles } = fixture({ packId: 'legacy-pack', readPackPlan: async () => ({ schema: 'hookemon.pack-plan.v1', revision: 2, orders: [] }) });
  assert.equal((await service.runOnce()).status, 'WAITING_FOR_ADMISSION');
  assert.equal(cycles.created.length, 0);
});

// REQ-cycle-runner-3 revision72: one persisted selection survives changed settings.
test('one authoritative config read freezes selection before a crash and resumed stages reuse it', async () => {
  let reads = 0;
  const configuration = { configurationRevision: 7, rewardRecipientLimit: 300, packPlan: { schema: 'hookemon.pack-plan.v1', revision: 1, orders: [{ pack: 'pack-a', quantity: 1 }] } };
  const contexts = [];
  const { service, cycles } = fixture({ readCycleConfiguration: async () => { reads++; return configuration; }, crashStage: 'claim-process', stageContextSink: c => contexts.push(c) });
  await assert.rejects(service.runOnce({}), /simulated crash/);
  const frozen = structuredClone(cycles.active.rewardSelection);
  configuration.rewardRecipientLimit = 600; configuration.configurationRevision++;
  assert.equal((await service.runOnce({})).status, 'COMPLETE');
  assert.equal(reads, 1);
  assert.equal(frozen.rewardRecipientLimit, 300);
  assert.ok(contexts.every(context => context.rewardSelection.digest === frozen.digest));
});
test('an explicit missing configuration cannot open an unbound new cycle', async () => {
  const { service, cycles } = fixture({ readCycleConfiguration: async () => null });
  assert.equal((await service.runOnce({})).status, 'WAITING_FOR_CONFIGURATION');
  assert.equal(cycles.created.length, 0);
});


test('manual cycle mismatch and absent recovery never dispatch unrelated payouts or new admission', async () => {
  const { service, cycles, executions } = fixture();
  cycles.active = { cycleId: 'different-cycle' };
  assert.equal((await service.recoverActiveCycle({ manualCycleId: 'reserved-cycle' })).status, 'MANUAL_CYCLE_MISMATCH');
  cycles.active = null;
  assert.equal((await service.recoverActiveCycle({ manualCycleId: 'reserved-cycle' })).status, 'NO_ACTIVE_CYCLE');
  assert.equal(cycles.created.length, 0);
  assert.equal(executions.length, 0);
});

test('manual admission refuses a plan edited after the dashboard readiness check', async () => {
  const { service, cycles, executions } = fixture({ readCycleConfiguration: async () => ({
    configurationRevision: 8, rewardRecipientLimit: 100,
    packPlan: { schema: 'hookemon.pack-plan.v1', revision: 1, orders: [{ pack: 'pokemon_50', quantity: 2 }] },
  }) });
  const result = await service.runOnce({ manualCycleId: 'reserved-cycle', manualPlan: {
    configurationRevision: 7, recipientLimit: 100, packCode: 'pokemon_25', quantity: 1,
  } });
  assert.equal(result.status, 'MANUAL_CONFIGURATION_CHANGED');
  assert.equal(cycles.created.length, 0); assert.equal(executions.length, 0);
});
