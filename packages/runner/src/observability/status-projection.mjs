// Turns the durable journal and operator state into the public cycle-status shape the dashboard
// reads (design section 4.7): cycle stage, next scheduled run, last payout, lifetime totals. This
// module holds no storage of its own and performs no I/O — every input is either a plain snapshot the
// caller already has (the operator state file's `activeCycleId`/`terminalCycles`/`configuration`
// fields, see operator/state-file.mjs) or a small injected async function (`readStage`) so the "live
// journal state" half of the projection is always a fresh read against whatever cycleRepository the
// caller is actually running against (durable-store-backed in production, an in-memory fake in tests)
// rather than a snapshot that can go stale between reads.
//
// `readStage` is called once per AUTOMATED_CYCLE_STAGES entry (imported from
// automation/automated-cycle-service.mjs so this module never hand-maintains a second copy of the
// eight-stage list) using exactly the same "first non-COMPLETE stage is the current one" rule
// AutomatedCycleService's own stage loop uses (`current?.status === 'COMPLETE' ? continue : ...`), so
// the projected `activeCycle.stage` can never disagree with which stage the automated service would
// actually attempt next.
import { AUTOMATED_CYCLE_STAGES } from '../automation/automated-cycle-service.mjs';

export const CYCLE_STATUS_SCHEMA = 'hookemon.cycle-status-projection.v1';

const terminalLifecycleBuckets = Object.freeze({
  PAYOUT_COMMITTED: 'paidOut',
  FAILED: 'failed',
  DEGRADED: 'degraded',
  EXPIRED_UNSTARTED: 'expiredUnstarted',
});

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

/**
 * Convert one of scheduler.mjs's `onTick` event objects into the `lastTick` shape
 * `projectCycleStatus` expects. A thin convenience so a caller wiring the scheduler's `onTick` hook
 * straight into this module never has to hand-pick fields.
 */
export function lastTickFromSchedulerEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('scheduler tick event must be an object');
  if (!Number.isFinite(event.at)) throw new Error('scheduler tick event must carry a numeric "at" timestamp');
  if (!Number.isFinite(event.intervalMs)) throw new Error('scheduler tick event must carry a numeric "intervalMs"');
  return Object.freeze({ at: event.at, intervalMs: event.intervalMs });
}

async function projectActiveCycle(activeCycleId, readStage, readAccounting) {
  if (typeof readStage !== 'function') {
    throw new Error('status projection readStage must be a function when activeCycleId is set');
  }
  let stage = 'closed';
  let completedStages = 0;
  for (const candidate of AUTOMATED_CYCLE_STAGES) {
    // eslint-disable-next-line no-await-in-loop -- stages are read in order; the first incomplete one
    // is the answer, so there is nothing to gain from reading the remaining stages concurrently.
    const record = await readStage(activeCycleId, candidate);
    if (record?.status === 'COMPLETE') {
      completedStages += 1;
      continue;
    }
    stage = candidate;
    break;
  }
  const base = { cycleId: activeCycleId, stage, completedStages, totalStages: AUTOMATED_CYCLE_STAGES.length };
  // `readAccounting` is entirely optional and additive: every existing caller that does not supply it
  // gets the exact same shape as before (see status-projection.test.mjs's own `deepEqual` assertions)
  // — only a caller that opts in (routes/public.mjs's `ctx.readAccounting`, see accounting-
  // projection.mjs) gets the extra `accounting` field at all.
  if (typeof readAccounting !== 'function') return Object.freeze(base);
  const accounting = await readAccounting(activeCycleId);
  return Object.freeze({ ...base, accounting });
}

function projectLastPayout(terminalCycles) {
  for (let index = terminalCycles.length - 1; index >= 0; index -= 1) {
    const terminal = terminalCycles[index];
    if (terminal?.lifecycle === 'PAYOUT_COMMITTED') {
      return Object.freeze({
        cycleId: terminal.cycleId,
        onchainCycleId: terminal.onchainCycleId ?? null,
        terminalDigest: terminal.terminalDigest ?? null,
        journalVersion: terminal.journalVersion ?? null,
      });
    }
  }
  return null;
}

function projectTotals(terminalCycles) {
  const totals = { totalCycles: 0, paidOut: 0, failed: 0, degraded: 0, expiredUnstarted: 0 };
  for (const terminal of terminalCycles) {
    totals.totalCycles += 1;
    const bucket = terminalLifecycleBuckets[terminal?.lifecycle];
    if (bucket) totals[bucket] += 1;
  }
  return Object.freeze(totals);
}

/**
 * @param {object} input
 * @param {string|null} input.activeCycleId - `operatorState.activeCycleId` (or `null` if the file
 *   does not exist yet / carries no active cycle).
 * @param {(cycleId: string, stage: string) => Promise<{status: string}|null>} [input.readStage] -
 *   required whenever `activeCycleId` is not null; typically `cycleRepository.readStage` bound to the
 *   live cycleRepository AutomatedCycleService itself is configured with.
 * @param {Array<object>} [input.terminalCycles] - `operatorState.terminalCycles`; defaults to `[]`.
 * @param {{paused: boolean, liveMode: boolean, intervalMinutes: number}|null} [input.configuration] -
 *   `operatorState.configuration`; `null` before any dashboard edit exists, projected the same
 *   conservative way scheduler.mjs treats it (`paused: true`, `liveMode: false`, no interval).
 * @param {{at: number, intervalMs: number}|null} [input.lastTick] - the most recent scheduler tick's
 *   start time and the interval it used, e.g. via `lastTickFromSchedulerEvent`. `null` when no tick has
 *   ever been observed (nothing to project a next-run time from yet).
 * @param {(cycleId: string) => Promise<object>} [input.readAccounting] - entirely optional; when
 *   supplied (and `activeCycleId` is not null) its result is attached as `activeCycle.accounting` —
 *   typically `packages/adapters/src/app/accounting-projection.mjs`'s `projectCycleAccounting` bound
 *   to the live `cycleRepository`. Every existing caller that omits this gets the exact same
 *   `activeCycle` shape as before (see status-projection.test.mjs).
 * @param {number} [input.now] - defaults to `Date.now()`; only used for `generatedAt`.
 */
export async function projectCycleStatus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('status projection input must be a plain object');
  const {
    activeCycleId = null,
    readStage = null,
    terminalCycles = [],
    configuration = null,
    lastTick = null,
    readAccounting = null,
    now = Date.now(),
  } = input;

  if (activeCycleId !== null) assertNonEmptyString(activeCycleId, 'status projection activeCycleId');
  if (!Array.isArray(terminalCycles)) throw new Error('status projection terminalCycles must be an array');
  if (configuration !== null && (typeof configuration !== 'object' || Array.isArray(configuration))) {
    throw new Error('status projection configuration must be an object or null');
  }
  if (lastTick !== null) {
    if (typeof lastTick !== 'object' || Array.isArray(lastTick) || !Number.isFinite(lastTick.at) || !Number.isFinite(lastTick.intervalMs)) {
      throw new Error('status projection lastTick must be {at, intervalMs} or null');
    }
  }
  if (!Number.isFinite(now)) throw new Error('status projection now must be a finite number');

  const activeCycle = activeCycleId === null ? null : await projectActiveCycle(activeCycleId, readStage, readAccounting);

  return Object.freeze({
    schema: CYCLE_STATUS_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    paused: configuration ? Boolean(configuration.paused) : true,
    liveMode: configuration ? Boolean(configuration.liveMode) : false,
    intervalMinutes: configuration ? configuration.intervalMinutes : null,
    nextRunAt: lastTick ? new Date(lastTick.at + lastTick.intervalMs).toISOString() : null,
    activeCycle,
    lastPayout: projectLastPayout(terminalCycles),
    totals: projectTotals(terminalCycles),
  });
}
