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
  async createCycle({ releaseAmount, mode, providerMode = null, rehearsalSessionId = null }) {
    if (this.active !== null) throw new Error('active cycle exists');
    this.active = { cycleId: `cycle-${this.next++}`, releaseAmount, mode, providerMode, rehearsalSessionId };
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
  availableProcessUsdg: '55000000',
  packPriceUsdg: '50000000',
  outboundCapUsdg: '1000000',
  returnCapUsdg: '1000000',
  operatingMarginUsdg: '3000000',
  activeCycleId: null,
});

function fixture({ budget = readyBudget(), crashStage = null, liveMode = false, mode = undefined, providerMode = undefined, policyEngine = undefined, packId = undefined, recoveryGuard = undefined, beforeComplete = undefined } = {}) {
  const leaseStore = new MemoryLeaseStore();
  const cycles = new MemoryCycleRepository();
  const executions = [];
  const commits = [];
  const providerEvidence = new Map();
  let crash = crashStage;
  const serviceConfig = {
    owner: 'worker-one',
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore,
    budgetReader: { read: async () => structuredClone(budget) },
    cycleRepository: cycles,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver: {
      async reconcile({ cycleId, stage }) { return providerEvidence.get(`${cycleId}:${stage}`) ?? null; },
      async execute({ cycleId, stage, intent }) {
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
  const { service, cycles } = fixture({ budget: { ...readyBudget(), availableProcessUsdg: '54999999' } });
  assert.deepEqual(await service.runOnce(), {
    status: 'WAITING_FOR_PROCESS_BUDGET',
    cycleId: null,
    stage: null,
    requiredProcessUsdg: '55000000',
  });
  assert.equal(cycles.active, null);
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
    assert.equal(input.releaseAmountMicroUsdg, '55000000');
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
