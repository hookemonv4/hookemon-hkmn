# Durable Cycle Store

## Purpose

`packages/runner/src/cycle/durable-store.mjs` is the disk-backed, cross-process-safe cycle store
`CycleRepository` (`packages/adapters/src/app/cycle-repository.mjs`, C-owned) opens and commits
through. It owns the on-disk journal/index layout, the state-directory identity/loss detection, and
the cross-process write lock; it holds no domain knowledge of cycles, packs, or money.

## Public interface

- `DurableCycleStore.open(directory)` opens (or bootstraps) a state directory and returns a store
  exposing `begin`/`commit`/`commitSync`, `activeCycleIds`/`archivedCycleIds`, and the synchronous
  interface `CycleRunner` requires.
- `readStateDirectoryRecovery(directory)` reads the nonsecret identity/availability facts a caller
  turns into its own owner-decision record on detected state loss, without writing anything.
- `StateDirectoryLossError` is thrown by `open()` when the state directory's identity or witness no
  longer matches what was previously bootstrapped.

## Invariants

- Every mutation acquires one combined lock before touching the journal/index: a private
  `.store-lock/lease.sqlite` SQLite `BEGIN EXCLUSIVE` transaction, and — while still holding that
  lease — `store.lock`, a plain-file fence recording the owner's PID and a random token (crash
  recovery unlinks it only after confirming the same inode/PID/token and that the PID no longer
  exists; a live or ambiguous PID stays lock contention).
- **Lock release is the exact reverse of acquisition order**: the legacy fence (`store.lock`) is
  removed first, while the SQLite lease is still held; the SQLite lease is released last. Releasing
  SQLite first would free it for a second acquirer while the fence file still exists — that acquirer
  reaches the fence's EEXIST-retry branch and either loses to a spurious "held by a live process"
  against a lock actively being released, or observes the file vanish mid-read and surfaces a raw
  ENOENT. Releasing in reverse order closes the window entirely: no other acquirer can even attempt
  the fence until SQLite is free, and by then the fence is already gone. `acquireLock`/`releaseLock`
  and their `*Sync` twins are the only place this ordering is decided; do not introduce a second path
  that acquires or releases either primitive independently.
- The store never partially writes: every durable write is temp-file-write, fsync, atomic rename,
  then fsync the containing directory (see `atomicWriteFile`/`atomicWriteFileSync`).
- A within-process caller is additionally serialized by one promise queue (`#withLock`'s
  `this.#queue`) so overlapping calls on the *same* open store instance never interleave; this is
  independent of and in addition to the cross-process file lock above, which is what actually
  protects two separate store instances (same process or different processes) against each other.

## State transitions

- `bootstrap` (no identity marker yet) → an identity marker and empty index/journal are written
  under the lock on first open.
- `available` → normal read/commit.
- `missing` / `identity-marker-missing` / `identity-marker-mismatch` / `identity-directory-mismatch`
  / `unavailable` → `StateDirectoryLossError`, a read-only recovery facade; `open()` never recreates
  a directory that looks like it might already hold data under a different identity.

## Operational commands

```sh
node --test packages/runner/test/cycle/durable-store.test.mjs
```

- `packages/runner/test/cycle/durable-store-lock-race-child.mjs` is a real independent child process
  used by several of these tests; add a new `role` there for any new cross-process race scenario
  rather than approximating it with same-process instances, which share a runtime and cannot exercise
  a genuine second-process file-lock race.

## Recovery pointers

- On lock contention, do not delete `.store-lock/lease.sqlite`, its rollback journal, or `store.lock`
  by hand; a retained `lease.sqlite` alone after a clean release is expected. Reopen and retry.
- A `StateDirectoryLossError` is a durable fact about the directory, not a transient error; do not
  retry `open()` in a loop expecting it to resolve itself. Escalate to the owner-decision path
  `readStateDirectoryRecovery` describes.
- If a caller reports `'durable cycle store legacy migration fence is missing'` or a raw ENOENT on
  `store.lock` outside a deliberate crash-recovery scenario, that is the release-order race this
  module now closes structurally — check `releaseLock`/`releaseLockSync` have not regressed to
  releasing SQLite before the fence, rather than adding a catch around the symptom.
