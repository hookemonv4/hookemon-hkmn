import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AutomatedCycleService, AUTOMATED_CYCLE_STAGES } from '../../src/automation/automated-cycle-service.mjs';
import { applyOperatorConfiguration } from '../../src/config/state-schema.mjs';
import { createEmptyOperatorState, mutateOperatorState, readOperatorState } from '../../src/operator/state-file.mjs';
import { createScheduler } from '../../src/scheduler/scheduler.mjs';

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

  async readActiveCycle() { return this.active && structuredClone(this.active); }
  async createCycle({ releaseAmount, mode }) {
    this.active = { cycleId: `dry-cycle-${this.next++}`, releaseAmount, mode };
    this.stages.set(this.active.cycleId, new Map());
    return structuredClone(this.active);
  }
  async readStage(cycleId, stage) { return structuredClone(this.stages.get(cycleId)?.get(stage) ?? { status: 'PENDING' }); }
  async prepareStage(cycleId, stage) { return { status: 'PREPARED', intentId: `${cycleId}:${stage}` }; }
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

const budget = Object.freeze({
  availableProcessUsdg: '55000000',
  packPriceUsdg: '50000000',
  outboundCapUsdg: '1000000',
  returnCapUsdg: '1000000',
  operatingMarginUsdg: '3000000',
  activeCycleId: null,
});

function configuration(overrides = {}) {
  return {
    intervalMinutes: 5,
    allowedPackIds: [],
    requestedOrders: 0,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '0',
    maxCycleBudgetMicroUsdg: '0',
    max24HourBudgetMicroUsdg: '0',
    paused: false,
    liveMode: false,
    ...overrides,
  };
}

async function writeConfiguration(statePath, patch) {
  let current = null;
  try {
    current = await readOperatorState(statePath);
  } catch {
    // The first write creates the state file.
  }
  return mutateOperatorState(statePath, current?.revision ?? null, state => ({
    ...(state ?? createEmptyOperatorState()),
    configuration: applyOperatorConfiguration(state?.configuration ?? null, configuration(patch)),
  }));
}

test('a scheduler rereads dry-run and pause state while one repository completes the operational sequence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-full-cycle-dry-run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'operator-state.json');
  await writeConfiguration(statePath, {});

  const repository = new MemoryCycleRepository();
  const leaseStore = new MemoryLeaseStore();
  const events = [];
  const liveModes = [];
  const scheduler = createScheduler({
    statePath,
    onTick: event => events.push(event),
    buildWorker: ({ liveMode }) => {
      liveModes.push(liveMode);
      const evidence = new Map();
      return new AutomatedCycleService({
        owner: 'scheduler-worker',
        liveMode,
        leaseTtlMs: 5_000,
        now: () => 1_000,
        leaseStore,
        budgetReader: { read: async () => structuredClone(budget) },
        cycleRepository: repository,
        runnerFactory: cycleId => ({ cycleId, repository }),
        stageDriver: {
          async reconcile({ cycleId, stage }) { return evidence.get(`${cycleId}:${stage}`) ?? null; },
          async execute({ cycleId, stage }) { evidence.set(`${cycleId}:${stage}`, { stage, mode: liveMode ? 'live' : 'dry' }); },
          async commit() {},
        },
        feeSettlementObserver: { observe: async () => ({ status: 'OBSERVED' }) },
      });
    },
  });

  const first = await scheduler.triggerTick();
  assert.equal(first.result.status, 'COMPLETE');
  assert.deepEqual(repository.completed, [first.result.cycleId]);
  assert.deepEqual([...([...repository.stages.values()][0].keys())], AUTOMATED_CYCLE_STAGES);
  assert.deepEqual(liveModes, [false]);

  await writeConfiguration(statePath, { paused: true });
  const second = await scheduler.triggerTick();
  assert.equal(second.result.status, 'NO_ACTIVE_CYCLE');
  assert.equal(events.at(-1).calledMethod, 'recoverActiveCycle');
  assert.deepEqual(liveModes, [false, false]);
});
