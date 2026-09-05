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
  custody = { heldAssets: false, unattributed: false, unresolvedObligations: false };

  async readActiveCycle() { return this.active && structuredClone(this.active); }
  async createCycle({ releaseAmount, mode }) {
    this.active = { cycleId: `integration-cycle-${this.next++}`, releaseAmount, mode };
    this.stages.set(this.active.cycleId, new Map());
    return structuredClone(this.active);
  }
  async readStage(cycleId, stage) {
    return structuredClone(this.stages.get(cycleId)?.get(stage) ?? { status: 'PENDING' });
  }
  async prepareStage(cycleId, stage) {
    return { status: 'PREPARED', intentId: `${cycleId}:${stage}` };
  }
  async completeStage(cycleId, stage, evidence) {
    this.stages.get(cycleId).set(stage, { status: 'COMPLETE', evidence: structuredClone(evidence) });
  }
  async completeCycle(cycleId) {
    this.completed.push(cycleId);
    this.active = null;
  }
  async readClaimPreconditions() { return structuredClone(this.custody); }
}

const budget = Object.freeze({
  availableProcessUsdg: '55000000',
  packPriceUsdg: '50000000',
  outboundCapUsdg: '1000000',
  returnCapUsdg: '1000000',
  operatingMarginUsdg: '3000000',
  activeCycleId: null,
});

function createService(repository, driver) {
  return new AutomatedCycleService({
    owner: 'integration-worker',
    liveMode: false,
    leaseTtlMs: 5_000,
    now: () => 1_000,
    leaseStore: new MemoryLeaseStore(),
    budgetReader: { read: async () => structuredClone(budget) },
    cycleRepository: repository,
    runnerFactory: cycleId => ({ cycleId, repository }),
    stageDriver: driver,
    feeSettlementObserver: { observe: async cycleId => ({ cycleId, status: 'OBSERVED' }) },
  });
}

test('the full operational sequence completes through one repository and one lease', async () => {
  const repository = new MemoryCycleRepository();
  const executed = [];
  const evidence = new Map();
  const service = createService(repository, {
    async reconcile({ cycleId, stage }) { return evidence.get(`${cycleId}:${stage}`) ?? null; },
    async execute({ cycleId, stage, runner }) {
      assert.equal(runner.repository, repository);
      executed.push(stage);
      evidence.set(`${cycleId}:${stage}`, { stage, source: 'integration-driver' });
    },
    async commit() {},
  });

  const result = await service.runOnce();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(executed, AUTOMATED_CYCLE_STAGES);
  assert.deepEqual(repository.completed, [result.cycleId]);
});

test('a custody hold prevents a resumed cycle from entering claim-process', async () => {
  const repository = new MemoryCycleRepository();
  repository.active = { cycleId: 'integration-held', releaseAmount: '55000000', mode: 'rehearsal' };
  repository.stages.set(repository.active.cycleId, new Map([[
    'eligibility-snapshot',
    { status: 'COMPLETE', evidence: { snapshotDigest: 'sha256:eligible' } },
  ]]));
  repository.custody = { heldAssets: true, unattributed: false, unresolvedObligations: false };
  const executed = [];
  const service = createService(repository, {
    async reconcile() { return null; },
    async execute({ stage }) { executed.push(stage); },
    async commit() {},
  });

  await assert.rejects(() => service.recoverActiveCycle(), /claim-process blocked by custody preconditions: held assets/);
  assert.deepEqual(executed, []);
});
