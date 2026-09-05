# Scheduler

## Purpose

`packages/runner/src/scheduler/scheduler.mjs` reads the current operator state on every tick and
serializes worker dispatch. It owns cadence and cancellation, not money limits or signatures.

## Public interface

- `createScheduler(options)` returns `start`, `stop`, `isRunning`, `abortInFlight`, `triggerTick`,
  and `settled`.
- `buildWorker({liveMode, configuration})` is invoked fresh for each tick.
- `onTick(event)` receives read failures, worker failures, completed results, and the interval used
  for the next scheduled wake-up.

## Invariants

- Scheduled and manually triggered ticks share one promise chain. Two ticks cannot call a worker at
  the same time.
- Each timer-originated tick carries the scheduler generation that created it. `stop()` invalidates
  that generation, so a scheduled tick queued behind another tick cannot run after stop.
- The scheduler rereads `paused`, `executionPaused`, `killSwitch`, `liveMode`, and interval state
  before each dispatch.
- Any pause or kill control selects `recoverActiveCycle` instead of `runOnce`, so it never opens a
  new cycle from that tick.
- The scheduler does not cache configuration, bypass policy, or hold signer material.

## State transitions

- A start wake-up queues one generation-tagged tick and schedules the next one after its outcome.
- A manual `triggerTick` queues behind any active work and schedules no timer.
- State read, worker construction, and worker execution failures are emitted and leave the loop able
  to run a later tick.

## Operational commands

```sh
node --test packages/runner/test/scheduler/scheduler.test.mjs
```

- Use `triggerTick` for an operator-requested wake-up; it uses the same state read as a timer tick.
- Use `abortInFlight` only to request a between-stage stop. It does not interrupt a mutation.

## Recovery pointers

- Keep a paused or killed configuration until the active repository state is reconciled.
- If a tick reports a state read error, repair the state file and let the next queued wake-up reread
  it; do not reuse the prior configuration.
- Use `triggerTick` for an explicit operator action after a stop; it is independent of invalidated
  timer generations.
