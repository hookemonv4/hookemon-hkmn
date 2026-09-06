// Interval-driven scheduler (design section 4.1): the thing that actually turns the ported
// AutomatedCycleService (packages/runner/src/automation/automated-cycle-service.mjs) into an
// unattended, ~20-minute autonomous loop. This module is deliberately dependency-free and holds no
// cycle-domain knowledge of its own — it wakes on a cadence, re-reads the operator state file
// (packages/runner/src/operator/state-file.mjs) fresh on every single tick, and drives exactly one of
// two calls on the caller-supplied worker per tick. Everything else (the lease, the budget gate, the
// stage sequence, the adapters) lives downstream, behind `buildWorker`.
//
// Pause and resume, for free, by construction
// --------------------------------------------
// `AutomatedCycleService.runOnce()` already does both jobs a scheduler needs: it resumes an existing
// active cycle if one exists, or opens a fresh one if the budget gate allows it. `recoverActiveCycle()`
// is the same resume path with the "open a fresh one" half removed — it is a no-op
// ({status:'NO_ACTIVE_CYCLE'}) when nothing is in flight. So the whole pause contract collapses to
// picking which of the two methods a tick calls:
//   - paused  -> worker.recoverActiveCycle()  (finish what is already open; never start anything new)
//   - running -> worker.runOnce()             (finish what is already open, or start a fresh one)
// Unpausing therefore "continues an interrupted cycle" without this module needing any resume logic of
// its own: the very next tick just calls runOnce() again and it picks the active cycle back up. And
// because a tick's single await chain runs every remaining stage of one cycle to completion before this
// module looks at the pause flag again, flipping `paused` mid-tick can never interrupt a stage in
// progress — the current tick always finishes its current stage (and every stage after it, in the same
// call) before the next tick's pause check ever runs.
//
// The exclusive lease
// --------------------
// AutomatedCycleService#run() acquires, heartbeats and releases the exclusive cycle lease
// (packages/runner/src/automation/exclusive-lease.mjs) internally as the very first and very last thing
// it does, and reports contention back as a normal `{status:'LEASE_HELD'}` result rather than throwing.
// This module therefore never re-implements lease acquisition; its own contribution to exclusivity is
// simply that it never has two ticks in flight at once (the next tick is only scheduled from inside the
// previous tick's completion handler), so `runOnce()`/`recoverActiveCycle()` — which is where the lease
// is actually taken, before any stage-mutating call happens — is always called serially, one at a time,
// from this scheduler.
//
// liveMode
// --------
// `configuration.liveMode` (packages/runner/src/config/state-schema.mjs) is read fresh from disk on
// every tick and passed into `buildWorker({liveMode, configuration})` on every tick — never cached from
// a previous tick, never defaulted to true, never inferred from anything but that on-disk value.
// `buildWorker` is what threads `liveMode` on into the downstream signer/adapter layer, where each
// mutating call requires it explicitly (see packages/adapters/src/relay-client.mjs's `prepareExecution`,
// gated on an explicit `liveMode: true` argument with no default). This module's only obligation to that
// contract is structural: there is no code path that calls a worker without having just re-read
// `liveMode` from the operator state file for that exact tick, and reconstructing the worker every tick
// (rather than reusing one built at start-up) is what makes a dashboard flip from false to true actually
// reach the next tick instead of being silently frozen at whatever the worker was built with.
import { readOperatorState } from '../operator/state-file.mjs';

/** 20 minutes, matching config/state-schema.mjs's DEFAULT_INTERVAL_MINUTES — used only when no
 * operator configuration has been written yet (first boot, before any dashboard edit). */
export const DEFAULT_TICK_INTERVAL_MS = 1_200_000;

/** Default fast-reconciliation retry: how soon a tick that reports an already-open cycle still
 * waiting to reconcile (or a partial supplementary settlement) is retried, instead of waiting out the
 * full `intervalMinutes` new-cycle cadence. Also the starting point for the bounded outage backoff
 * below. */
export const RECONCILE_RETRY_MS = 5_000;

/** Ceiling for the bounded backoff applied to consecutive tick outages (a state-file read failure, a
 * worker that cannot be built, or the worker call itself throwing) — doubled on every consecutive
 * outage tick starting from RECONCILE_RETRY_MS, reset the moment a tick stops being an outage. */
export const RECONCILE_MAX_BACKOFF_MS = 300_000;

const RECONCILE_BACKOFF_FACTOR = 2;

// AutomatedCycleService statuses meaning "a cycle is already open and there is more to reconcile
// right now" (as opposed to "nothing to do until the next interval"). These get the flat
// RECONCILE_RETRY_MS retry, never the growing outage backoff: a chain confirmation still pending is
// normal latency, not a fault.
const RECONCILE_PENDING_STATUSES = new Set(['ACTIVE_CYCLE_NOT_RECONCILED', 'SUPPLEMENTARY_SETTLEMENT']);

const missingStateMessage = 'operator state file does not exist';

function defaultSchedule({ delayMs, callback }) {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}

function defaultCancel(handle) {
  clearTimeout(handle);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function assertFunction(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'function') throw new Error(`${label} must be a function`);
  return value;
}

/**
 * Build a scheduler. Every dependency the loop itself needs is injected — the real operator state file
 * reader is the default for `readState`, and the real `setTimeout`/`clearTimeout` (unref'd, so this loop
 * never by itself keeps a process alive) are the defaults for `schedule`/`cancel`; tests substitute
 * deterministic fakes for both so the ~20-minute cadence never has to be waited out in real time.
 *
 * @param {object} options
 * @param {string} options.statePath - passed straight through to `readState`.
 * @param {(context: {liveMode: boolean, configuration: object|null}) => {runOnce: Function, recoverActiveCycle: Function}} options.buildWorker
 *   - constructs the AutomatedCycleService-shaped worker for one tick. Called fresh every tick with the
 *   liveMode/configuration this module just read, so it is the seam through which liveMode actually
 *   reaches the downstream stageDriver/signer layer.
 * @param {(statePath: string) => Promise<object|null>} [options.readState] - defaults to the real
 *   `readOperatorState`.
 * @param {() => number} [options.now] - defaults to `Date.now`.
 * @param {(args: {delayMs: number, callback: () => void}) => unknown} [options.schedule] - defaults to
 *   an unref'd `setTimeout`.
 * @param {(handle: unknown) => void} [options.cancel] - defaults to `clearTimeout`.
 * @param {(event: object) => void} [options.onTick] - optional observability hook, called once per tick
 *   with the outcome (never allowed to throw back into the loop).
 * @param {number} [options.defaultIntervalMs] - used only when no operator configuration exists yet.
 */
export function createScheduler(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('scheduler options must be an object');
  const {
    statePath,
    buildWorker,
    readState = readOperatorState,
    now = () => Date.now(),
    schedule = defaultSchedule,
    cancel = defaultCancel,
    onTick,
    defaultIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    reconcileRetryMs = RECONCILE_RETRY_MS,
    reconcileMaxBackoffMs = RECONCILE_MAX_BACKOFF_MS,
  } = options;

  if (typeof statePath !== 'string' || statePath.length === 0) throw new Error('scheduler statePath must be a nonempty string');
  assertFunction(buildWorker, 'scheduler buildWorker');
  assertFunction(readState, 'scheduler readState');
  assertFunction(now, 'scheduler now');
  assertFunction(schedule, 'scheduler schedule');
  assertFunction(cancel, 'scheduler cancel');
  assertFunction(onTick, 'scheduler onTick', { optional: true });
  assertPositiveInteger(defaultIntervalMs, 'scheduler defaultIntervalMs');
  assertPositiveInteger(reconcileRetryMs, 'scheduler reconcileRetryMs');
  assertPositiveInteger(reconcileMaxBackoffMs, 'scheduler reconcileMaxBackoffMs');
  if (reconcileMaxBackoffMs < reconcileRetryMs) throw new Error('scheduler reconcileMaxBackoffMs must be at least reconcileRetryMs');

  let stopped = true;
  let timerHandle = null;
  let tickCount = 0;
  let tickChain = Promise.resolve();
  let currentAbortController = null;
  let scheduleGeneration = 0;
  let outageBackoffMs = null;
  let nextCycleAtMs = null;
  let nextReconcileAtMs = null;
  let lastConfigPaused = true;
  let lastAutomationEnabled = false;
  let lastPendingReason = null;

  function emit(event) {
    if (typeof onTick !== 'function') return;
    try {
      onTick(event);
    } catch {
      // Observability must never break the loop: a broken onTick hook is the caller's bug, not a
      // reason to stop driving cycles.
    }
  }

  async function readConfiguration() {
    try {
      const state = await readState(statePath);
      return { configuration: state?.configuration ?? null, error: null };
    } catch (error) {
      return { configuration: null, error };
    }
  }

  // UI-facing reason a tick did not (or could not) advance a cycle right now — precise enough for the
  // dashboard to distinguish "paused by the operator" from "waiting on funds" from "waiting on an
  // already-sent transaction" rather than a single generic idle state.
  function tickPendingReason({ configuration, result }) {
    if (configuration === null) return 'CONFIGURATION_NOT_SET';
    // A specific external result (a pending reconciliation, a lease held elsewhere, an insufficient
    // process budget, a policy refusal) is reported ahead of the generic pause flags: it is the more
    // actionable fact, and the raw `paused` flag remains separately visible on the view regardless.
    if (result) {
      switch (result.status) {
        case 'WAITING_FOR_PROCESS_BUDGET': return 'INSUFFICIENT_FUNDS';
        case 'ACTIVE_CYCLE_NOT_RECONCILED':
        case 'SUPPLEMENTARY_SETTLEMENT': return 'RECONCILING_PENDING_TRANSACTION';
        case 'LEASE_HELD': return 'LEASE_HELD_BY_ANOTHER_RUNNER';
        case 'POLICY_REFUSED': return `POLICY_REFUSED_${result.reason ?? 'UNKNOWN'}`;
        case 'RECOVERY_REFUSED': return `RECOVERY_REFUSED_${result.reason ?? 'UNKNOWN'}`;
        default: break;
      }
    }
    if (configuration.killSwitch) return 'KILL_SWITCH';
    if (configuration.executionPaused) return 'EXECUTION_PAUSED';
    if (configuration.paused) return 'PAUSED';
    return null;
  }

  /**
   * Runs one tick and classifies its outcome for scheduling: `requiresFastRetry` is `'outage'` for a
   * transient failure (state read, worker construction, or the worker call itself throwing) — retried
   * with growing bounded backoff — `'pending'` for a successfully-observed but still-open cycle or
   * settlement — retried at a flat `reconcileRetryMs` — or `null` for a tick that has nothing left to
   * do until the next `intervalMinutes` new-cycle wakeup.
   */
  async function runTick() {
    tickCount += 1;
    const tick = tickCount;
    const at = now();
    const { configuration, error: stateError } = await readConfiguration();

    const paused = configuration ? Boolean(configuration.paused || configuration.executionPaused || configuration.killSwitch) : true;
    const liveMode = configuration ? configuration.liveMode : false;
    const intervalMs = configuration ? configuration.intervalMinutes * 60_000 : defaultIntervalMs;
    lastConfigPaused = configuration ? Boolean(configuration.paused) : true;
    lastAutomationEnabled = configuration !== null && !configuration.paused && !configuration.executionPaused && !configuration.killSwitch;

    if (stateError) {
      const missing = stateError.message === missingStateMessage;
      emit({
        type: missing ? 'TICK_STATE_MISSING' : 'TICK_STATE_READ_FAILED',
        tick,
        at,
        error: stateError,
        paused,
        liveMode,
        intervalMs,
      });
      return {
        intervalMs,
        requiresFastRetry: missing ? null : 'outage',
        pendingReason: missing ? 'CONFIGURATION_NOT_SET' : 'STATE_UNAVAILABLE',
      };
    }

    let worker;
    try {
      worker = buildWorker({ liveMode, configuration });
    } catch (error) {
      emit({ type: 'TICK_WORKER_BUILD_FAILED', tick, at, error, paused, liveMode, intervalMs });
      return { intervalMs, requiresFastRetry: 'outage', pendingReason: 'WORKER_UNAVAILABLE' };
    }
    if (!worker || typeof worker.runOnce !== 'function' || typeof worker.recoverActiveCycle !== 'function') {
      emit({
        type: 'TICK_WORKER_INVALID',
        tick,
        at,
        error: new Error('scheduler worker must provide runOnce and recoverActiveCycle'),
        paused,
        liveMode,
        intervalMs,
      });
      return { intervalMs, requiresFastRetry: 'outage', pendingReason: 'WORKER_UNAVAILABLE' };
    }

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;
    const calledMethod = paused ? 'recoverActiveCycle' : 'runOnce';
    let result = null;
    let runError = null;
    try {
      result = paused ? await worker.recoverActiveCycle({ signal }) : await worker.runOnce({ signal });
    } catch (error) {
      runError = error;
    } finally {
      currentAbortController = null;
    }

    if (runError) {
      emit({ type: 'TICK_FAILED', tick, at, error: runError, paused, liveMode, intervalMs, calledMethod });
      return { intervalMs, requiresFastRetry: 'outage', pendingReason: 'TICK_FAILED' };
    }

    emit({ type: 'TICK_COMPLETE', tick, at, paused, liveMode, intervalMs, calledMethod, result });
    return {
      intervalMs,
      result,
      requiresFastRetry: RECONCILE_PENDING_STATUSES.has(result?.status) ? 'pending' : null,
      pendingReason: tickPendingReason({ configuration, result }),
    };
  }

  function scheduleNext(delayMs) {
    if (stopped) return;
    const scheduledGeneration = scheduleGeneration;
    timerHandle = schedule({ delayMs, callback: () => wake({ scheduledGeneration }) });
  }

  // Turns one tick's classified outcome into the actual next-wakeup delay, and records it as
  // nextCycleAt/nextReconcileAt for getView(). The two are mutually exclusive at any moment: either
  // the next wakeup is the ordinary new-cycle cadence, or it is a fast reconciliation/outage retry —
  // never both, since a single timer drives the loop and whichever is more urgent wins.
  function applyScheduleOutcome(outcome) {
    lastPendingReason = outcome.pendingReason ?? null;
    if (outcome.requiresFastRetry === 'outage') {
      outageBackoffMs = outageBackoffMs === null
        ? reconcileRetryMs
        : Math.min(outageBackoffMs * RECONCILE_BACKOFF_FACTOR, reconcileMaxBackoffMs);
      nextReconcileAtMs = now() + outageBackoffMs;
      nextCycleAtMs = null;
      return outageBackoffMs;
    }
    if (outcome.requiresFastRetry === 'pending') {
      outageBackoffMs = null;
      nextReconcileAtMs = now() + reconcileRetryMs;
      nextCycleAtMs = null;
      return reconcileRetryMs;
    }
    outageBackoffMs = null;
    nextCycleAtMs = now() + outcome.intervalMs;
    nextReconcileAtMs = null;
    return outcome.intervalMs;
  }

  function enqueueTick({ scheduleAfter, scheduledGeneration = null }) {
    const dispatch = () => {
      if (scheduledGeneration !== null && (stopped || scheduledGeneration !== scheduleGeneration)) {
        return { intervalMs: defaultIntervalMs, requiresFastRetry: null, pendingReason: lastPendingReason };
      }
      return runTick();
    };
    const outcome = tickChain.then(
      dispatch,
      dispatch,
    );
    tickChain = outcome.then(
      result => {
        const delayMs = applyScheduleOutcome(result);
        if (scheduleAfter) scheduleNext(delayMs);
      },
      () => {
        if (scheduleAfter) scheduleNext(defaultIntervalMs);
      },
    );
    return outcome;
  }

  function wake({ scheduledGeneration = scheduleGeneration } = {}) {
    timerHandle = null;
    if (stopped || scheduledGeneration !== scheduleGeneration) return;
    enqueueTick({ scheduleAfter: true, scheduledGeneration });
  }

  return {
    /** Begin ticking: runs the first tick immediately (so a process restart recovers an interrupted
     * cycle right away rather than waiting out a full interval) and self-reschedules from then on using
     * the interval it reads at the start of every tick. A no-op if already running. */
    start() {
      if (!stopped) return;
      stopped = false;
      scheduleGeneration += 1;
      wake({ scheduledGeneration: scheduleGeneration });
    },
    /** Stop scheduling further ticks. A tick already in flight is left to finish on its own (see the
     * pause note above — this module never interrupts a stage in progress); it simply will not be
     * followed by another one. */
    stop() {
      stopped = true;
      scheduleGeneration += 1;
      if (timerHandle !== null) {
        cancel(timerHandle);
        timerHandle = null;
      }
    },
    isRunning() {
      return !stopped;
    },
    /** The frozen SchedulerView contract: the actual next new-cycle and reconciliation wakeups (never
     * both at once — see applyScheduleOutcome), whether standing automation is currently allowed to
     * open a cycle unattended, the raw operator pause flag, and a precise UI-facing reason nothing is
     * advancing right now (insufficient funds, a paused state, or an external pending result), or
     * `null` when there is nothing blocking. Reflects the most recently settled tick, automatic or
     * manually triggered. */
    getView() {
      return Object.freeze({
        nextCycleAt: nextCycleAtMs === null ? null : new Date(nextCycleAtMs).toISOString(),
        nextReconcileAt: nextReconcileAtMs === null ? null : new Date(nextReconcileAtMs).toISOString(),
        automationEnabled: lastAutomationEnabled,
        paused: lastConfigPaused,
        pendingReason: stopped ? (lastPendingReason ?? 'SCHEDULER_STOPPED') : lastPendingReason,
      });
    },
    /** Abort the signal passed to the in-flight worker call, if any. AutomatedCycleService checks this
     * signal between stages (never mid-stage), so this still respects "let the current stage finish". */
    abortInFlight() {
      currentAbortController?.abort();
    },
    /** Drive exactly one tick and resolve once it settles, bypassing the timer loop entirely. Used by
     * tests and by an operator-triggered "run now" control; does not require `start()` to have been
     * called and does not itself schedule a follow-up tick. */
    async triggerTick() {
      return enqueueTick({ scheduleAfter: false });
    },
    /** Await the in-flight tick (and its scheduling side effect), if any is running. Primarily for
     * tests that need to observe the loop settle after `start()`/`wake` before asserting on it. */
    async settled() {
      await tickChain;
    },
  };
}
