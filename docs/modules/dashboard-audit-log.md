# Dashboard Audit Log

## Purpose

`packages/dashboard/src/auth/audit-log.mjs` is the append-only, hash-chained record of every
dispatched operator command. It is a record of decisions, never the money-moving state itself: the
runner authority (`packages/runner/src/operator/control.mjs`) remains the sole source of truth a
caller mutates, and this log cannot mutate it back.

## Public interface

- `appendAuditEntry(path, entry)` appends one hash-chained line; `readAllAuditEntries(path)` and
  `verifyAuditChain(path)` read and verify the chain.
- `commandDigest({expectedVersion, command, note})` binds a command's identity for
  `executeAuditedCommand`'s idempotency check.
- `executeAuditedCommand({path, requestId, command, actor, actorRole, expectedVersion,
  observedVersion, note, resultCode, now, processIsAlive, effect})` reserves a `PREPARED` record,
  invokes `effect(preparedReceipt)` outside the write lock, and finalizes it `APPLIED`, `REJECTED`,
  or `UNCERTAIN`. `processIsAlive` defaults to a real PID liveness check and is injectable for tests.

## Invariants

- A command's requestId is idempotent: a retry with the same requestId and command digest replays
  the durable outcome instead of invoking `effect` again; a different digest under the same
  requestId is an `AuditRequestConflict`.
- A normal in-process effect failure (a thrown error the calling process is alive to catch) resolves
  to `UNCERTAIN` in the same call, never `PREPARED` — the caller-visible outcome always distinguishes
  "ran and failed" from "still pending."
- A `PREPARED` record whose owning process has since died (a hard crash between reserving `PREPARED`
  and finalizing it) is an orphan, not an in-flight command. `executeAuditedCommand` detects this by
  checking whether the recorded owner PID is still alive; a live owner's `PREPARED` is replayed
  unchanged (do not run its effect a second time from a different process while it may still be
  running).
- Reclaiming an orphaned `PREPARED` record atomically rewrites its owner PID to the current process
  (still under the write lock, before `effect` runs) so a second concurrent recovery attempt sees a
  live owner and backs off instead of running the same effect twice. The original request's identity
  (its very first `PREPARED` entry — `eventId`, `commandDigest`, `observedVersion`) never changes.
- A reclaimed effect that fails with the exact `'stale operator state revision'` compare-and-swap
  signal `operator/control.mjs`/`operator/state-file.mjs` use for a lost CAS is finalized `APPLIED`
  with `COMMAND_RECOVERED_ALREADY_APPLIED`, not `UNCERTAIN`: the CAS failure itself proves the crashed
  attempt already took effect. Any other reclaimed failure is finalized `UNCERTAIN`, identically to a
  normal in-process failure.
- A `PREPARED` record from a version of this module that predates the `pid` field is never treated as
  an orphan (there is no owner to check liveness against) and keeps its prior behavior.

## State transitions

- `PREPARED` → `APPLIED` | `REJECTED` | `UNCERTAIN`, exactly once, terminal from there.
- An orphan recovery inserts one additional `PREPARED` entry (the reclaim, under the recovering
  process's PID) before the same terminal transition; `readAllAuditEntries` therefore shows
  `PREPARED, PREPARED, <terminal>` for a recovered request instead of `PREPARED, <terminal>`.

## Operational commands

```sh
node --test packages/dashboard/test/auth/audit-log.test.mjs
```

- `verifyAuditChain(path)` before trusting a log after any out-of-band file operation.

## Recovery pointers

- A request stuck at `PREPARED` with its owner process still alive is genuinely in flight; wait for
  it, do not reclaim it.
- A request stuck at `PREPARED` with a dead owner self-heals the next time any caller retries
  `executeAuditedCommand` with the same requestId and command digest — including the dashboard's own
  normal retry path after a restart. No separate sweep or manual repair step exists or is needed.
- If a reclaimed effect's `UNCERTAIN` outcome needs a human decision, inspect the wrapped authority's
  own state (e.g. `operatorControl.status()`) directly; this log records that a decision was made, not
  what the authoritative state ended up being.
