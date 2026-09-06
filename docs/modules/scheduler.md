# Scheduler

## Purpose

`packages/runner/src/scheduler/scheduler.mjs` reads the current operator state on every tick and
serializes worker dispatch. It owns cadence and cancellation, not money limits or signatures.

## Public interface

- `createScheduler(options)` returns `start`, `stop`, `isRunning`, `abortInFlight`, `triggerTick`,
  `settled`, and `getView`.
- `buildWorker({liveMode, configuration})` is invoked fresh for each tick.
- `onTick(event)` receives read failures, worker failures, completed results, and the interval used
  for the next scheduled wake-up.
- `getView()` returns the frozen `SchedulerView` contract: `{ nextCycleAt, nextReconcileAt,
  automationEnabled, paused, pendingReason }`, reflecting the most recently settled tick (automatic
  or manually triggered). `nextCycleAt`/`nextReconcileAt` are ISO timestamps or `null`.
- `RECONCILE_RETRY_MS` (5,000) and `RECONCILE_MAX_BACKOFF_MS` (300,000) are exported defaults;
  `options.reconcileRetryMs`/`options.reconcileMaxBackoffMs` override them.

## Invariants

- Scheduled and manually triggered ticks share one promise chain. Two ticks cannot call a worker at
  the same time.
- Each timer-originated tick carries the scheduler generation that created it. `stop()` invalidates
  that generation, so a scheduled tick queued behind another tick cannot run after stop.
- The scheduler rereads `paused`, `executionPaused`, `killSwitch`, `liveMode`, and interval state
  before each dispatch.
- Any pause or kill control selects `recoverActiveCycle` instead of `runOnce`, so it never opens a
  new cycle from that tick; an already-open cycle still reconciles while paused.
- The scheduler does not cache configuration, bypass policy, or hold signer material.
- A single timer drives the loop; `nextCycleAt` and `nextReconcileAt` are mutually exclusive at any
  moment — whichever is more urgent is what is actually scheduled next. A tick classifies its own
  outcome: a still-open cycle or partial settlement (`ACTIVE_CYCLE_NOT_RECONCILED`,
  `SUPPLEMENTARY_SETTLEMENT`) retries at the flat `reconcileRetryMs`, never the full
  `intervalMinutes` cadence. A state-read failure, a worker that cannot be built or is malformed, or
  the worker call itself throwing is an outage: it retries with a bounded backoff starting at
  `reconcileRetryMs` and doubling up to `reconcileMaxBackoffMs`, reset the moment a tick stops being
  an outage. A missing (never-configured) operator state file is not an outage and keeps the
  ordinary interval cadence.
- `pendingReason` prioritizes a specific external result (insufficient process funds, a lease held
  by another runner, a policy or recovery refusal, a still-reconciling transaction, a tick failure)
  over the generic pause/kill flags, which remain visible via `paused`/`automationEnabled` regardless.

## State transitions

- A start wake-up queues one generation-tagged tick and schedules the next one after its outcome.
- A manual `triggerTick` queues behind any active work. If it finds nothing urgent
  (`requiresFastRetry === null`), it installs no timer of its own and leaves whatever cadence timer
  is already running untouched — only `pendingReason` (a fresh, real finding) updates. If it *does*
  find urgent pending work (a still-open cycle, a partial settlement, or an outage), it preempts the
  currently installed timer: cancels it, bumps the scheduler generation (so a callback already in
  flight for the cancelled timer is a guaranteed no-op), and installs the real fast-retry/backoff
  timer in its place. `getView()` reflects whichever timer is actually installed either way — never
  an outcome that has no matching real wakeup.
- State read, worker construction, and worker execution failures are emitted and leave the loop able
  to run a later tick, retried per the outage backoff above rather than the ordinary interval — a
  manual tick that hits one of these preempts the installed timer the same way.
- `stop()` clears `getView()`'s `nextCycleAt`/`nextReconcileAt` to `null` (no timer is installed);
  `pendingReason` keeps showing the last real tick's finding, since `stop()` itself neither runs a
  tick nor discovers anything new. A manual tick run against a stopped scheduler never installs a
  timer, regardless of what it finds.

## Operational commands

```sh
node --test packages/runner/test/scheduler/scheduler.test.mjs packages/runner/test/integration/launch-automation-recovery.test.mjs
```

- Use `triggerTick` for an operator-requested wake-up; it uses the same state read as a timer tick.
- Use `abortInFlight` only to request a between-stage stop. It does not interrupt a mutation.
- Read `getView()` to show the dashboard an accurate next-wakeup time and a precise reason nothing is
  advancing, instead of inferring it from raw tick events.

## Recovery pointers

- Keep a paused or killed configuration until the active repository state is reconciled; pausing
  does not stop an already-open cycle's fast reconciliation retry.
- If a tick reports a state read error, repair the state file; the loop already retries it on its own
  bounded outage backoff rather than waiting for the next queued interval wake-up.
- Use `triggerTick` for an explicit operator action after a stop; it is independent of invalidated
  timer generations.
