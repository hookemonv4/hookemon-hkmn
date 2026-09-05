// Unit coverage for observability/status-projection.mjs: the active cycle's stage is derived by
// reading each AUTOMATED_CYCLE_STAGES entry through an injected readStage (exactly the rule
// AutomatedCycleService's own stage loop uses), last payout and totals are derived from
// operatorState-shaped terminalCycles, and configuration/lastTick project the paused/liveMode/
// nextRunAt fields the dashboard needs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTOMATED_CYCLE_STAGES } from '../../src/automation/automated-cycle-service.mjs';
import {
  CYCLE_STATUS_SCHEMA,
  lastTickFromSchedulerEvent,
  projectCycleStatus,
} from '../../src/observability/status-projection.mjs';

function readStageFromCompletedSet(completed) {
  return async (cycleId, stage) => (completed.has(stage) ? { status: 'COMPLETE', evidence: { cycleId, stage } } : null);
}

test('no active cycle, no configuration yet: conservative defaults, matching scheduler.mjs first-boot treatment', async () => {
  const projection = await projectCycleStatus({ activeCycleId: null, terminalCycles: [], configuration: null, now: 12345 });
  assert.equal(projection.schema, CYCLE_STATUS_SCHEMA);
  assert.equal(projection.paused, true);
  assert.equal(projection.liveMode, false);
  assert.equal(projection.intervalMinutes, null);
  assert.equal(projection.nextRunAt, null);
  assert.equal(projection.activeCycle, null);
  assert.equal(projection.lastPayout, null);
  assert.deepEqual(projection.totals, { totalCycles: 0, paidOut: 0, failed: 0, degraded: 0, expiredUnstarted: 0 });
  assert.equal(projection.generatedAt, new Date(12345).toISOString());
});

test('active cycle stage is the first non-COMPLETE stage, in AUTOMATED_CYCLE_STAGES order', async () => {
  const completed = new Set(['eligibility-snapshot', 'claim-process', 'outbound']);
  const projection = await projectCycleStatus({
    activeCycleId: 'cycle-1',
    readStage: readStageFromCompletedSet(completed),
    terminalCycles: [],
    configuration: { paused: false, liveMode: true, intervalMinutes: 20 },
  });
  assert.deepEqual(projection.activeCycle, { cycleId: 'cycle-1', stage: 'purchase', completedStages: 3, totalStages: AUTOMATED_CYCLE_STAGES.length });
  assert.equal(projection.paused, false);
  assert.equal(projection.liveMode, true);
  assert.equal(projection.intervalMinutes, 20);
});

test('active cycle with every stage COMPLETE projects stage "closed"', async () => {
  const completed = new Set(AUTOMATED_CYCLE_STAGES);
  const projection = await projectCycleStatus({
    activeCycleId: 'cycle-2',
    readStage: readStageFromCompletedSet(completed),
    terminalCycles: [],
    configuration: null,
  });
  assert.deepEqual(projection.activeCycle, { cycleId: 'cycle-2', stage: 'closed', completedStages: AUTOMATED_CYCLE_STAGES.length, totalStages: AUTOMATED_CYCLE_STAGES.length });
});

test('activeCycleId set without a readStage function throws', async () => {
  await assert.rejects(() => projectCycleStatus({ activeCycleId: 'cycle-1', terminalCycles: [] }), /readStage/);
});

test('readAccounting is entirely optional: activeCycle carries no "accounting" key at all when it is omitted', async () => {
  const completed = new Set(['eligibility-snapshot']);
  const projection = await projectCycleStatus({
    activeCycleId: 'cycle-1',
    readStage: readStageFromCompletedSet(completed),
    terminalCycles: [],
    configuration: null,
  });
  assert.deepEqual(Object.keys(projection.activeCycle).sort(), ['cycleId', 'completedStages', 'stage', 'totalStages'].sort());
});

test('readAccounting, when supplied, is called with the active cycle id and its result is attached as activeCycle.accounting', async () => {
  const completed = new Set(['eligibility-snapshot']);
  const calls = [];
  const projection = await projectCycleStatus({
    activeCycleId: 'cycle-1',
    readStage: readStageFromCompletedSet(completed),
    terminalCycles: [],
    configuration: null,
    readAccounting: async cycleId => {
      calls.push(cycleId);
      return { packSpendMicroUsdg: '5000000' };
    },
  });
  assert.deepEqual(calls, ['cycle-1']);
  assert.deepEqual(projection.activeCycle.accounting, { packSpendMicroUsdg: '5000000' });
});

test('readAccounting is never called when there is no active cycle', async () => {
  const projection = await projectCycleStatus({
    activeCycleId: null,
    terminalCycles: [],
    configuration: null,
    readAccounting: async () => { throw new Error('must not be called'); },
  });
  assert.equal(projection.activeCycle, null);
});

test('lastPayout is the most recent PAYOUT_COMMITTED terminal cycle, ignoring FAILED/EXPIRED ones after it in the array only if none follow', async () => {
  const terminalCycles = [
    { cycleId: 'a', lifecycle: 'PAYOUT_COMMITTED', onchainCycleId: '0xa', terminalDigest: '0xaa', journalVersion: 9 },
    { cycleId: 'b', lifecycle: 'FAILED', onchainCycleId: '0xb', failureReceiptDigest: '0xbb' },
  ];
  const projection = await projectCycleStatus({ activeCycleId: null, terminalCycles, configuration: null });
  assert.deepEqual(projection.lastPayout, { cycleId: 'a', onchainCycleId: '0xa', terminalDigest: '0xaa', journalVersion: 9 });
});

test('lastPayout is null when no terminal cycle ever paid out', async () => {
  const terminalCycles = [{ cycleId: 'a', lifecycle: 'FAILED' }, { cycleId: 'b', lifecycle: 'EXPIRED_UNSTARTED' }];
  const projection = await projectCycleStatus({ activeCycleId: null, terminalCycles, configuration: null });
  assert.equal(projection.lastPayout, null);
});

test('totals bucket every terminal lifecycle, including a forward-compatible DEGRADED bucket', async () => {
  const terminalCycles = [
    { cycleId: 'a', lifecycle: 'PAYOUT_COMMITTED' },
    { cycleId: 'b', lifecycle: 'PAYOUT_COMMITTED' },
    { cycleId: 'c', lifecycle: 'FAILED' },
    { cycleId: 'd', lifecycle: 'DEGRADED' },
    { cycleId: 'e', lifecycle: 'EXPIRED_UNSTARTED' },
  ];
  const projection = await projectCycleStatus({ activeCycleId: null, terminalCycles, configuration: null });
  assert.deepEqual(projection.totals, { totalCycles: 5, paidOut: 2, failed: 1, degraded: 1, expiredUnstarted: 1 });
});

test('nextRunAt is derived from lastTick.at + lastTick.intervalMs', async () => {
  const projection = await projectCycleStatus({
    activeCycleId: null,
    terminalCycles: [],
    configuration: null,
    lastTick: { at: 1_000_000, intervalMs: 1_200_000 },
  });
  assert.equal(projection.nextRunAt, new Date(2_200_000).toISOString());
});

test('lastTickFromSchedulerEvent extracts {at, intervalMs} from a real onTick event shape', () => {
  const event = { type: 'TICK_COMPLETE', tick: 3, at: 555, paused: false, liveMode: true, intervalMs: 1_200_000, calledMethod: 'runOnce', result: { status: 'COMPLETE' } };
  assert.deepEqual(lastTickFromSchedulerEvent(event), { at: 555, intervalMs: 1_200_000 });
});

test('lastTickFromSchedulerEvent rejects a malformed event', () => {
  assert.throws(() => lastTickFromSchedulerEvent(null), /object/);
  assert.throws(() => lastTickFromSchedulerEvent({ at: 'nope', intervalMs: 1 }), /"at"/);
  assert.throws(() => lastTickFromSchedulerEvent({ at: 1 }), /intervalMs/);
});

test('projectCycleStatus validates its input shape', async () => {
  await assert.rejects(() => projectCycleStatus(null), /plain object/);
  await assert.rejects(() => projectCycleStatus({ activeCycleId: 1 }), /activeCycleId/);
  await assert.rejects(() => projectCycleStatus({ activeCycleId: null, terminalCycles: 'nope' }), /terminalCycles/);
  await assert.rejects(() => projectCycleStatus({ activeCycleId: null, configuration: 'nope' }), /configuration/);
  await assert.rejects(() => projectCycleStatus({ activeCycleId: null, lastTick: 'nope' }), /lastTick/);
  await assert.rejects(() => projectCycleStatus({ activeCycleId: null, now: NaN }), /now/);
});

test('the projected object is frozen at every level that matters (activeCycle, lastPayout, totals)', async () => {
  const projection = await projectCycleStatus({
    activeCycleId: 'cycle-1',
    readStage: readStageFromCompletedSet(new Set()),
    terminalCycles: [{ cycleId: 'a', lifecycle: 'PAYOUT_COMMITTED' }],
    configuration: null,
  });
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.activeCycle));
  assert.ok(Object.isFrozen(projection.lastPayout));
  assert.ok(Object.isFrozen(projection.totals));
});
