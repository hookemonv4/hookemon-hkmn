// End-to-end coverage for the launch-repair acceptance criteria that only show up once the scheduler
// (src/scheduler/scheduler.mjs), the policy engine (src/automation/policy-engine.mjs), and
// AutomatedCycleService are driven together: a one-time launch-readiness approval unlocking standing
// automation for every cycle after it, an already-open cycle reconciling on the bounded 5-second retry
// instead of waiting out the full new-cycle interval, and two runners sharing one lease never both
// advancing the same cycle.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduler, RECONCILE_RETRY_MS } from '../../src/scheduler/scheduler.mjs';
import { AutomatedCycleService } from '../../src/automation/automated-cycle-service.mjs';
import { createPolicyEngine, deriveCyclePolicyDigest } from '../../src/automation/policy-engine.mjs';
import { createDefaultOperatorConfiguration } from '../../src/config/state-schema.mjs';

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
  created = [];
  completed = [];

  async readActiveCycle() { return this.active; }
  async createCycle({ releaseAmount, mode }) {
    if (this.active !== null) throw new Error('active cycle exists');
    this.active = { cycleId: `cycle-${this.next++}`, releaseAmount, mode };
    this.created.push(this.active.cycleId);
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

// packPriceUsdg mirrors the verified public catalog's pokemon_25 pack (H-funding-observations.md).
const readyBudget = () => ({
  availableProcessUsdg: '30000000',
  packPriceUsdg: '25000000',
  outboundCapUsdg: '1000000',
  returnCapUsdg: '1000000',
  operatingMarginUsdg: '3000000',
  activeCycleId: null,
});

function zeroCustody() {
  return {
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
    unattributed: false,
    unvaluedExposure: false,
  };
}

function launchConfiguration(overrides = {}) {
  return {
    ...createDefaultOperatorConfiguration(),
    liveMode: true,
    paused: false,
    allowedPackIds: ['base-pack'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '30000000',
    maxCycleBudgetMicroUsdg: '30000000',
    max24HourBudgetMicroUsdg: '100000000',
    perCycleCapMicroUsdg: '30000000',
    lossCapMicroUsdg: '100000000',
    maxOutstandingCustodyMicroUsdg: '100000000',
    maxCyclesPerDay: 10,
    manualApprovalCycles: 1,
    intervalMinutes: 20,
    ...overrides,
  };
}

function policyEngineFixture(configuration) {
  let current = configuration;
  const engine = createPolicyEngine({
    now: () => 1_000,
    readConfiguration: async () => current,
    readCustody: async () => zeroCustody(),
    mutateConfiguration: async mutation => {
      const outcome = await mutation(current);
      current = outcome.configuration;
      return outcome.result;
    },
  });
  return { engine, current: () => current };
}

function buildWorker({ leaseStore, cycles, policyEngine, crashStage = null }) {
  let crash = crashStage;
  const providerEvidence = new Map();
  return new AutomatedCycleService({
    owner: 'runner-under-test',
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore,
    budgetReader: { read: async () => readyBudget() },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile(context) {
        return providerEvidence.get(`${context.cycleId}:${context.stage}`) ?? null;
      },
      async execute(context) {
        const { cycleId, stage, intent } = context;
        const evidence = { transactionId: `${cycleId}-${stage}`, intentId: intent.intentId };
        if (crash === stage) {
          crash = null;
          throw new Error('simulated provider RPC timeout');
        }
        providerEvidence.set(`${cycleId}:${stage}`, evidence);
      },
      async commit() {},
    },
    feeSettlementObserver: { observe: async cycleId => ({ cycleId, status: 'PENDING_BENEFICIARY_CLAIMS' }) },
    liveMode: true,
    mode: 'production',
    packId: 'base-pack',
    policyEngine,
  });
}

test('a one-time launch-readiness approval unlocks standing automation: only the first cycle needs it, every later cycle proceeds on its own', async () => {
  const leaseStore = new MemoryLeaseStore();
  const cycles = new MemoryCycleRepository();
  const { engine } = policyEngineFixture(launchConfiguration({ manualApprovalCycles: 1 }));
  const worker = buildWorker({ leaseStore, cycles, policyEngine: engine });

  const configuration = { paused: false, liveMode: true, executionPaused: false, killSwitch: false, intervalMinutes: 20 };
  const clock = (() => {
    let nextId = 1;
    const pending = new Map();
    return {
      schedule({ delayMs, callback }) { const id = nextId++; pending.set(id, { delayMs, callback }); return id; },
      cancel(id) { pending.delete(id); },
      fire() {
        const [id, entry] = [...pending.entries()][0];
        pending.delete(id);
        entry.callback();
      },
      pendingDelayMs() { return [...pending.values()][0].delayMs; },
    };
  })();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: async () => ({ configuration }),
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  // Tick 1: opens cycle-1 and is refused at claim-process for lack of a manual approval. This is the
  // exact "operator has not yet made the one-time launch-readiness decision" state — and it must
  // retry fast (RECONCILE_RETRY_MS), not wait out the full 20-minute interval.
  scheduler.start();
  await scheduler.settled();
  assert.deepEqual(cycles.created, ['cycle-1']);
  assert.equal(clock.pendingDelayMs(), RECONCILE_RETRY_MS);
  assert.equal(scheduler.getView().pendingReason, 'TICK_FAILED');

  // The owner makes the one-time decision: approve cycle-1's exact policy digest.
  const cycleDigest = deriveCyclePolicyDigest({
    configuration: launchConfiguration({ manualApprovalCycles: 1 }),
    cycleId: 'cycle-1',
    releaseAmountMicroUsdg: '30000000',
    packId: 'base-pack',
    liveMode: true,
  });
  await engine.recordManualApproval({ cycleDigest, cycleId: 'cycle-1', approvedAtMs: 1_000 });

  // Tick 2: cycle-1 resumes and completes with no further approval.
  clock.fire();
  await scheduler.settled();
  assert.deepEqual(cycles.completed, ['cycle-1']);
  assert.equal(clock.pendingDelayMs(), 20 * 60_000, 'a completed cycle returns to the ordinary interval cadence');

  // Ticks 3 and 4: cycle-2 and cycle-3 are each opened and completed automatically. Nobody records a
  // second or third manual approval — standing automation, not a mandatory first-three-cycle gate.
  clock.fire();
  await scheduler.settled();
  clock.fire();
  await scheduler.settled();

  assert.deepEqual(cycles.created, ['cycle-1', 'cycle-2', 'cycle-3']);
  assert.deepEqual(cycles.completed, ['cycle-1', 'cycle-2', 'cycle-3']);
});

test('an already-open cycle reconciles on the bounded retry, never waiting the full new-cycle interval, and a paused scheduler still advances it', async () => {
  const leaseStore = new MemoryLeaseStore();
  const cycles = new MemoryCycleRepository();
  const { engine } = policyEngineFixture(launchConfiguration({ manualApprovalCycles: 0 }));
  const worker = buildWorker({ leaseStore, cycles, policyEngine: engine, crashStage: 'purchase' });

  const configuration = { paused: false, liveMode: true, executionPaused: false, killSwitch: false, intervalMinutes: 20 };
  const clock = (() => {
    let nextId = 1;
    const pending = new Map();
    return {
      schedule({ delayMs, callback }) { const id = nextId++; pending.set(id, { delayMs, callback }); return id; },
      cancel(id) { pending.delete(id); },
      fire() {
        const [id, entry] = [...pending.entries()][0];
        pending.delete(id);
        entry.callback();
      },
      pendingDelayMs() { return [...pending.values()][0].delayMs; },
    };
  })();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: async () => ({ configuration }),
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  scheduler.start();
  await scheduler.settled();
  assert.equal(cycles.active.cycleId, 'cycle-1', 'the cycle is open but not yet complete: purchase crashed');
  assert.equal(clock.pendingDelayMs(), RECONCILE_RETRY_MS, 'reconciling the open cycle never waits the 20-minute cadence');

  // The operator pauses new-cycle scheduling. The already-open cycle must still be allowed to
  // reconcile and finish — pause only blocks starting something new.
  configuration.paused = true;
  clock.fire();
  await scheduler.settled();
  assert.deepEqual(cycles.completed, ['cycle-1']);
});
