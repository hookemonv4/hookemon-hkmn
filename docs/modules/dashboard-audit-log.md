# Dashboard Audit Log

## Purpose

`packages/dashboard/src/auth/audit-log.mjs` is the append-only, hash-chained record of every
dispatched operator command. It is a record of decisions, never the money-moving state itself: the
runner authority (`packages/runner/src/operator/control.mjs`) remains the sole source of truth a
caller mutates, and this log cannot mutate it back or infer that it did.

## Public interface

- `appendAuditEntry(path, entry)` appends one hash-chained line; `readAllAuditEntries(path)` and
  `verifyAuditChain(path)` read and verify the chain.
- `commandDigest({expectedVersion, command, note})` binds a command's identity for
  `executeAuditedCommand`'s idempotency check.
- `executeAuditedCommand({path, requestId, command, actor, actorRole, expectedVersion,
  observedVersion, note, resultCode, now, leaseTtlMs, heartbeatIntervalMs, effect})` reserves a
  `PREPARED` record, invokes `effect(preparedReceipt)` outside the write lock, and finalizes it
  `APPLIED`, `REJECTED`, or `UNCERTAIN`. `leaseTtlMs` (default 30s) and `heartbeatIntervalMs`
  (default `leaseTtlMs / 2`) are injectable for tests.

## Invariants

- A command's requestId is idempotent: a retry with the same requestId and command digest replays
  the durable outcome instead of invoking `effect` again; a different digest under the same
  requestId is an `AuditRequestConflict`.
- A normal in-process effect failure (a thrown error the calling process is alive to catch) resolves
  to `UNCERTAIN` in the same call, never `PREPARED` — the caller-visible outcome always distinguishes
  "ran and failed" from "still pending."
- A `PREPARED` record's ownership is a durable, time-based lease, never a process ID. Every PREPARED
  entry — freshly reserved, reclaimed, or renewed — carries a random `claimToken` and inherits its
  `occurredAt` from the same clock every append already uses. A claim older than `leaseTtlMs` with no
  renewal is orphaned and reclaimable; a live claimant renews it via a heartbeat at half the lease
  interval, so a claim genuinely still in flight never appears stale to a second claimant. This is
  deliberately not PID-based: `process.kill(pid, 0)` only ever inspects the local host's process
  table, so it is either useless or actively wrong from a second host sharing the same log, and
  cannot distinguish a dead PID from one a different process has since reused. The write-append lock
  (`${path}.lock`) uses the identical time-based reasoning: a lock is only ever removed once its
  filesystem modification time exceeds the stale threshold, never by checking its recorded owner
  PID's liveness.
- A legacy `PREPARED` record from before `claimToken` existed still carries `occurredAt` (a required
  field on every entry) and ages out the same way — there is no separate migration path.
- Reclaiming an orphaned `PREPARED` record appends a fresh claim (new `claimToken`, current
  `occurredAt`) under the same write lock the staleness check itself ran inside, so a second
  concurrent recovery attempt that acquires the lock afterward sees the fresh claim and backs off
  instead of running the same effect twice. The original request's identity (its very first
  `PREPARED` entry — `eventId`, `commandDigest`, `observedVersion`) never changes.
- This module never infers "the crashed attempt's effect already applied" from a generic error
  message: a shared-state compare-and-swap conflict (e.g. `'stale operator state revision'`) carries
  no command-specific identity or postcondition, only "some write happened." Any effect failure —
  first attempt or recovered — is finalized `UNCERTAIN` alike. An authoritative APPLIED outcome comes
  only from the wrapped authority itself recognizing its own already-applied effect and returning
  successfully (see `operator/control.mjs`'s idempotent configuration mutation for how that authority
  does it) — never from this log guessing.

## State transitions

- `PREPARED` → `APPLIED` | `REJECTED` | `UNCERTAIN`, exactly once, terminal from there.
- Any number of `PREPARED` renewal/reclaim entries (heartbeat or recovery) may precede the terminal
  transition; `readAllAuditEntries` shows `PREPARED, PREPARED, ..., <terminal>` for a
  renewed/recovered request instead of a single `PREPARED, <terminal>`.

## Operational commands

```sh
node --test packages/dashboard/test/auth/audit-log.test.mjs
```

- `verifyAuditChain(path)` before trusting a log after any out-of-band file operation.

## Recovery pointers

- A request stuck at `PREPARED` younger than `leaseTtlMs` is genuinely in flight (or its claimant is
  renewing it); wait for it, do not reclaim it.
- A request stuck at `PREPARED` older than `leaseTtlMs` self-heals the next time any caller retries
  `executeAuditedCommand` with the same requestId and command digest — including the dashboard's own
  normal retry path after a restart, on any host sharing the log. No separate sweep, PID inspection,
  or manual repair step exists or is needed.
- If a recovered effect's `UNCERTAIN` outcome needs a human decision, inspect the wrapped authority's
  own state (e.g. `operatorControl.status()`) directly; this log records that a decision was made, not
  what the authoritative state ended up being.
