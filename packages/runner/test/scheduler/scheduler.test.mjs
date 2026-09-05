// Unit coverage for the scheduler's own control-flow decisions (packages/runner/src/scheduler/
// scheduler.mjs): which of AutomatedCycleService's two entry points a tick calls, whether a
// configuration change is visible on the very next tick, that liveMode is threaded through fresh every
// time, and that a bad tick (a read failure, a broken worker, a thrown cycle) never kills the loop. The
// worker here is a lightweight fake — AutomatedCycleService's own stage/lease/join semantics are already
// covered by automation/automated-cycle-service.test.mjs and integration/automated-cycle.test.mjs, and
// exercised again end to end through this scheduler by integration/full-cycle-dry-run.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduler, DEFAULT_TICK_INTERVAL_MS } from '../../src/scheduler/scheduler.mjs';

function manualClock() {
  let nextId = 1;
  const pending = new Map();
  return {
    schedule({ delayMs, callback }) {
      const id = nextId++;
      pending.set(id, { delayMs, callback });
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    pendingDelayMs() {
      if (pending.size !== 1) throw new Error(`expected exactly one pending timer, found ${pending.size}`);
      return [...pending.values()][0].delayMs;
    },
    fire() {
      if (pending.size !== 1) throw new Error(`expected exactly one pending timer to fire, found ${pending.size}`);
      const [id, entry] = [...pending.entries()][0];
      pending.delete(id);
      entry.callback();
    },
  };
}

function configuration({ paused, liveMode, intervalMinutes = 20, executionPaused = false, killSwitch = false } = {}) {
  return { paused, liveMode, intervalMinutes, executionPaused, killSwitch };
}

function stateReaderFrom(configurations) {
  let index = 0;
  const calls = [];
  return {
    calls,
    read: async statePath => {
      calls.push(statePath);
      const value = configurations[Math.min(index, configurations.length - 1)];
      index += 1;
      return { configuration: value };
    },
  };
}

function fakeWorker({ runOnce, recoverActiveCycle } = {}) {
  const calls = [];
  return {
    calls,
    runOnce: async opts => {
      calls.push({ method: 'runOnce', opts });
      return runOnce ? runOnce(opts) : { status: 'COMPLETE' };
    },
    recoverActiveCycle: async opts => {
      calls.push({ method: 'recoverActiveCycle', opts });
      return recoverActiveCycle ? recoverActiveCycle(opts) : { status: 'NO_ACTIVE_CYCLE' };
    },
  };
}

async function tickOnce(scheduler, clock) {
  clock.fire();
  await scheduler.settled();
}

test('a paused tick calls recoverActiveCycle and never runOnce, so no new cycle can start', async () => {
  const worker = fakeWorker();
  const reader = stateReaderFrom([configuration({ paused: true, liveMode: false })]);
  const events = [];
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.deepEqual(worker.calls.map(call => call.method), ['recoverActiveCycle']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'TICK_COMPLETE');
  assert.equal(events[0].calledMethod, 'recoverActiveCycle');
  assert.equal(events[0].paused, true);
  scheduler.stop();
});

test('an unpaused tick calls runOnce, which resumes an already-active cycle or opens a fresh one', async () => {
  const worker = fakeWorker({ runOnce: async () => ({ status: 'COMPLETE', cycleId: 'c1' }) });
  const reader = stateReaderFrom([configuration({ paused: false, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await scheduler.settled();

  assert.deepEqual(worker.calls.map(call => call.method), ['runOnce']);
  scheduler.stop();
});

test('execution pause and kill switch route a tick through recovery instead of opening a new cycle', async () => {
  for (const controls of [{ executionPaused: true }, { killSwitch: true }]) {
    const worker = fakeWorker();
    const reader = stateReaderFrom([configuration({ paused: false, liveMode: true, ...controls })]);
    const scheduler = createScheduler({
      statePath: '/state.json',
      readState: reader.read,
      buildWorker: () => worker,
    });
    await scheduler.triggerTick();
    assert.deepEqual(worker.calls.map(call => call.method), ['recoverActiveCycle']);
  }
});

test('unpausing between ticks switches the very next tick from recoverActiveCycle to runOnce, continuing the same active cycle', async () => {
  // A stateful fake standing in for "a cycle interrupted mid-stage while paused, then continued once
  // resumed": whichever method is called, the same underlying progress counter advances — proving the
  // scheduler's method choice is orthogonal to whether the cycle itself actually continues (that
  // continuity is AutomatedCycleService's own contract, proven for real by full-cycle-dry-run.test.mjs).
  let progress = 0;
  const worker = fakeWorker({
    runOnce: async () => { progress += 1; return { status: progress >= 2 ? 'COMPLETE' : 'IN_PROGRESS', cycleId: 'c1' }; },
    recoverActiveCycle: async () => { progress += 1; return { status: 'IN_PROGRESS', cycleId: 'c1' }; },
  });
  const reader = stateReaderFrom([
    configuration({ paused: true, liveMode: false }),
    configuration({ paused: false, liveMode: false }),
  ]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await scheduler.settled();
  assert.deepEqual(worker.calls.map(call => call.method), ['recoverActiveCycle']);
  assert.equal(progress, 1);

  await tickOnce(scheduler, clock);
  assert.deepEqual(worker.calls.map(call => call.method), ['recoverActiveCycle', 'runOnce']);
  assert.equal(progress, 2);
  scheduler.stop();
});

test('an interval change in the operator configuration takes effect on the very next tick', async () => {
  const worker = fakeWorker();
  const reader = stateReaderFrom([
    configuration({ paused: true, liveMode: false, intervalMinutes: 20 }),
    configuration({ paused: true, liveMode: false, intervalMinutes: 5 }),
  ]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await scheduler.settled();
  assert.equal(clock.pendingDelayMs(), 20 * 60_000);

  await tickOnce(scheduler, clock);
  assert.equal(clock.pendingDelayMs(), 5 * 60_000);
  scheduler.stop();
});

test('liveMode is re-read and passed into buildWorker fresh on every tick, never cached from a previous tick', async () => {
  const worker = fakeWorker();
  const seenLiveModes = [];
  const reader = stateReaderFrom([
    configuration({ paused: true, liveMode: false }),
    configuration({ paused: true, liveMode: true }),
    configuration({ paused: true, liveMode: false }),
  ]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: ({ liveMode }) => { seenLiveModes.push(liveMode); return worker; },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await scheduler.settled();
  await tickOnce(scheduler, clock);
  await tickOnce(scheduler, clock);

  assert.deepEqual(seenLiveModes, [false, true, false]);
  scheduler.stop();
});

test('liveMode never flips on its own: with a config that never sets it true, buildWorker never once sees true', async () => {
  const worker = fakeWorker();
  const seenLiveModes = [];
  const reader = stateReaderFrom([configuration({ paused: false, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: ({ liveMode }) => { seenLiveModes.push(liveMode); return worker; },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await scheduler.settled();
  await tickOnce(scheduler, clock);
  await tickOnce(scheduler, clock);

  assert.ok(seenLiveModes.every(value => value === false));
  scheduler.stop();
});

test('no operator configuration on disk yet is treated as paused, dry-run, and the default interval', async () => {
  const worker = fakeWorker();
  const events = [];
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: async () => ({ configuration: null }),
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.deepEqual(worker.calls.map(call => call.method), ['recoverActiveCycle']);
  assert.equal(events[0].liveMode, false);
  assert.equal(events[0].paused, true);
  assert.equal(clock.pendingDelayMs(), DEFAULT_TICK_INTERVAL_MS);
  scheduler.stop();
});

test('LEASE_HELD is an ordinary tick outcome, not a failure: the loop keeps ticking on schedule', async () => {
  const worker = fakeWorker({ runOnce: async () => ({ status: 'LEASE_HELD', cycleId: null, stage: null }) });
  const events = [];
  const reader = stateReaderFrom([configuration({ paused: false, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.equal(events[0].type, 'TICK_COMPLETE');
  assert.equal(events[0].result.status, 'LEASE_HELD');
  assert.equal(clock.pendingCount(), 1);
  scheduler.stop();
});

test('a state-file read failure does not crash the loop: it skips the tick, reports it, and reschedules', async () => {
  const worker = fakeWorker();
  const events = [];
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: async () => { throw new Error('operator state file contains corrupt JSON'); },
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'TICK_STATE_READ_FAILED');
  assert.equal(worker.calls.length, 0);
  assert.equal(clock.pendingCount(), 1);
  assert.equal(clock.pendingDelayMs(), DEFAULT_TICK_INTERVAL_MS);
  scheduler.stop();
});

test('a missing operator state file is reported distinctly from a corrupt one, and still reschedules safely', async () => {
  const worker = fakeWorker();
  const events = [];
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: async () => { throw new Error('operator state file does not exist'); },
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.equal(events[0].type, 'TICK_STATE_MISSING');
  scheduler.stop();
});

test('a buildWorker that throws does not crash the loop', async () => {
  const events = [];
  const clock = manualClock();
  const reader = stateReaderFrom([configuration({ paused: false, liveMode: false })]);
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => { throw new Error('adapter wiring not ready'); },
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.equal(events[0].type, 'TICK_WORKER_BUILD_FAILED');
  assert.equal(clock.pendingCount(), 1);
  scheduler.stop();
});

test('a worker missing runOnce/recoverActiveCycle is rejected rather than called', async () => {
  const events = [];
  const clock = manualClock();
  const reader = stateReaderFrom([configuration({ paused: false, liveMode: false })]);
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => ({}),
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();

  assert.equal(events[0].type, 'TICK_WORKER_INVALID');
  scheduler.stop();
});

test('a cycle that throws mid-run does not crash the loop: it is reported and the next tick still runs', async () => {
  const events = [];
  let attempt = 0;
  const worker = fakeWorker({
    runOnce: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('purchase stage mutation remains unresolved after execution');
      return { status: 'COMPLETE', cycleId: 'c1' };
    },
  });
  const reader = stateReaderFrom([
    configuration({ paused: false, liveMode: false }),
    configuration({ paused: false, liveMode: false }),
  ]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onTick: event => events.push(event),
  });
  scheduler.start();
  await scheduler.settled();
  assert.equal(events[0].type, 'TICK_FAILED');

  await tickOnce(scheduler, clock);
  assert.equal(events[1].type, 'TICK_COMPLETE');
  assert.equal(worker.calls.length, 2);
  scheduler.stop();
});

test('stop() cancels the pending timer and start() is idempotent', async () => {
  const worker = fakeWorker();
  const reader = stateReaderFrom([configuration({ paused: true, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  assert.equal(scheduler.isRunning(), false);
  scheduler.start();
  scheduler.start(); // idempotent: must not schedule a second immediate tick
  assert.equal(scheduler.isRunning(), true);
  await scheduler.settled();
  assert.equal(clock.pendingCount(), 1);

  scheduler.stop();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(scheduler.isRunning(), false);
});

test('a tick already in flight when stop() is called is left to finish its current stage; no further tick follows', async () => {
  let releaseTick;
  let markCalled;
  const called = new Promise(resolve => { markCalled = resolve; });
  const inFlight = new Promise(resolve => { releaseTick = resolve; });
  const worker = fakeWorker({
    recoverActiveCycle: async () => { markCalled(); await inFlight; return { status: 'NO_ACTIVE_CYCLE' }; },
  });
  const reader = stateReaderFrom([configuration({ paused: true, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await called; // wait until the tick has actually reached the worker call before stopping mid-flight
  scheduler.stop();
  assert.equal(worker.calls.length, 1, 'the first tick was already dispatched before stop() was called');
  releaseTick();
  await scheduler.settled();

  assert.equal(clock.pendingCount(), 0, 'no follow-up tick is scheduled once stopped');
  assert.equal(worker.calls.length, 1);
});

test('stop() discards a scheduled tick that was queued behind a manual tick', async () => {
  let releaseManual;
  let markManualStarted;
  const manualStarted = new Promise(resolve => { markManualStarted = resolve; });
  let invocation = 0;
  const worker = fakeWorker({
    runOnce: async () => {
      invocation += 1;
      if (invocation === 2) {
        markManualStarted();
        await new Promise(resolve => { releaseManual = resolve; });
      }
      return { status: 'COMPLETE' };
    },
  });
  const reader = stateReaderFrom([
    configuration({ paused: false, liveMode: false }),
    configuration({ paused: false, liveMode: false }),
    configuration({ paused: false, liveMode: false }),
  ]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  scheduler.start();
  await scheduler.settled();
  const manual = scheduler.triggerTick();
  await manualStarted;
  clock.fire();
  scheduler.stop();
  releaseManual();
  await manual;
  await scheduler.settled();

  assert.equal(worker.calls.length, 2);
  assert.equal(clock.pendingCount(), 0);
});

test('triggerTick() drives exactly one tick on demand without touching the timer loop', async () => {
  const worker = fakeWorker({ runOnce: async () => ({ status: 'COMPLETE', cycleId: 'manual' }) });
  const reader = stateReaderFrom([configuration({ paused: false, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const outcome = await scheduler.triggerTick();

  assert.equal(outcome.result.status, 'COMPLETE');
  assert.equal(clock.pendingCount(), 0, 'triggerTick never touches the scheduled-timer loop');
  assert.deepEqual(worker.calls.map(call => call.method), ['runOnce']);
});

test('overlapping manual triggerTick calls are serialized behind the in-flight worker', async () => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  let active = 0;
  let peakActive = 0;
  let invocation = 0;
  const worker = fakeWorker({
    runOnce: async () => {
      invocation += 1;
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (invocation === 1) {
        markFirstStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
      active -= 1;
      return { status: 'COMPLETE' };
    },
  });
  const reader = stateReaderFrom([
    configuration({ paused: false, liveMode: false }),
    configuration({ paused: false, liveMode: false }),
  ]);
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
  });

  const first = scheduler.triggerTick();
  await firstStarted;
  const second = scheduler.triggerTick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peakActive, 1);
  assert.equal(worker.calls.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(worker.calls.length, 2);
  assert.equal(peakActive, 1);
});

test('abortInFlight() aborts the signal passed to the in-flight worker call', async () => {
  let capturedSignal;
  let releaseTick;
  let markCalled;
  const called = new Promise(resolve => { markCalled = resolve; });
  const inFlight = new Promise(resolve => { releaseTick = resolve; });
  const worker = fakeWorker({
    recoverActiveCycle: async ({ signal }) => { capturedSignal = signal; markCalled(); await inFlight; return { status: 'NO_ACTIVE_CYCLE' }; },
  });
  const reader = stateReaderFrom([configuration({ paused: true, liveMode: false })]);
  const clock = manualClock();
  const scheduler = createScheduler({
    statePath: '/state.json',
    readState: reader.read,
    buildWorker: () => worker,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  scheduler.start();
  await called; // wait until the tick reaches the worker call and captures the signal
  assert.equal(capturedSignal.aborted, false);

  scheduler.abortInFlight();
  assert.equal(capturedSignal.aborted, true);
  releaseTick();
  await scheduler.settled();
  scheduler.stop();
});

test('constructor validation rejects a missing statePath, buildWorker, or malformed options', () => {
  assert.throws(() => createScheduler(), /scheduler options must be an object/);
  assert.throws(() => createScheduler({ buildWorker: () => {} }), /scheduler statePath must be a nonempty string/);
  assert.throws(() => createScheduler({ statePath: '/state.json' }), /scheduler buildWorker must be a function/);
  assert.throws(
    () => createScheduler({ statePath: '/state.json', buildWorker: () => {}, defaultIntervalMs: 0 }),
    /scheduler defaultIntervalMs must be a positive integer/,
  );
  assert.throws(
    () => createScheduler({ statePath: '/state.json', buildWorker: () => {}, onTick: 'not-a-function' }),
    /scheduler onTick must be a function/,
  );
});
