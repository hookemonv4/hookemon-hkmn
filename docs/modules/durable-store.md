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
- `persistPagedPayoutState(cycleId, stage, state)` / `readPagedPayoutState(cycleId, stage)` durably
  store a direct-payout state whose `recipients` (and any other large array in its object graph)
  exceed the journal's bounded payload. `state.cycleId` must equal `cycleId`, `state.recipients` must
  be an array of unique-`recipient`-keyed objects; `readPagedPayoutState` returns `null` when nothing
  has been persisted yet for that `(cycleId, stage)` pair.
- `persistPagedStageEvidence(cycleId, stage, evidence)` / `readPagedStageEvidence(cycleId, stage,
  expected)` are the generic counterpart for any other large stage evidence (e.g. an
  eligibility-snapshot manifest's `entries` beyond ~64 items) that does not fit the journal's bounded
  payload. `evidence` needs only a matching `cycleId` field — no `recipients` shape or other
  payout-specific requirement. Shares its page format, ceilings, and locking with the payout methods
  above but writes under its own directory root and schema strings; it never shares a manifest,
  generation, or page file with payout state, even for the identical `(cycleId, stage)` pair.
- `persistPagedStageEvidence` is idempotent by content, not by request identity: it returns a compact,
  immutable `{schema, cycleId, stage, generation, evidenceDigest}` handle a caller durably records
  (e.g. as the compact marker C's journal event stores in place of the full evidence). `evidenceDigest`
  is a pure content address of the evidence value — independent of the random `generation` any one
  persist call happens to pick for its on-disk layout — computed via `evidenceContentDigest`, which
  chunks any array longer than one page before hashing so it never hits `digest()`'s fixed default
  bound (unlike this module's own paged ceilings, that bound cannot be overridden per call). A retry
  with byte-identical evidence recomputes the identical `evidenceDigest`, matches the existing
  manifest, and returns the existing handle without writing a new generation or any new page files. A
  retry with different evidence for the same `(cycleId, stage)` throws
  `'durable cycle store stage evidence is already persisted with different evidence'` rather than
  silently replacing the existing reference.
- `readPagedStageEvidence`'s third argument, `expected`, distinguishes "nothing has been persisted"
  from "something should exist but its blob is missing or does not match": with `expected` omitted (or
  `null`), a caller has no durable reference yet, so a missing stage-evidence directory or manifest
  returns `null` (an ordinary absent read). With `expected` supplied (the handle a caller previously
  recorded, e.g. from its own journal), the same absence — or a manifest whose `generation`/
  `evidenceDigest` do not match `expected` — is a hard failure (thrown error), never `null`: a journal
  that already committed a reference to this evidence describes a fact that must still be true, and a
  missing or altered blob under that fact is corruption to raise or hold on, not a value to silently
  treat as "never happened."

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
- Paged storage ceilings (D-storage-requirements.md, 2026-09-06) are deliberately independent local
  constants, never aliases of journal.mjs's shared `RECOVERY_LIMITS` defaults that every other
  bounded-value caller in this codebase relies on: `maximumPagedPages` (1,024 — a 10,000-recipient
  payout state pages two 10,000-item arrays, `recipients` and `plan.allocations`, against one shared
  budget, needing 314 pages; this is ~3x that), `maximumPagedStateObjects` (90,000 — a fully-FINALIZED
  10,000-recipient state measures ~7 objects/recipient + ~22 fixed overhead ≈ 70,022, plus margin),
  and `maximumPagedStateArrays` (25,000 — a fully-FINALIZED recipient's own small nested arrays, e.g.
  a finality record's `logIndexes`, count separately from array *items*). These are a justified
  10,000-recipient/10,000-entry acceptance ceiling, not an unbounded allowance and not a promise of
  50,000.
- An array that already fits in one page (`length <= 64`) is written inline in the manifest rather
  than as a page reference: paging every array regardless of size (the original behavior) exhausted
  the shared page budget on realistic records with several small nested arrays long before reaching
  10,000 recipients. This is a **backward-compatible format extension**: an older manifest that did
  page a small array (written before this change) still decodes correctly, since decoding recognizes
  both a plain inline array and a page-reference object; only newly-written manifests use the more
  compact inline form. No migration step is needed — nothing has to rewrite old manifests.
- `persistPagedStageEvidence`'s top-level `stage-evidence/` directory is created lazily, on first use,
  unlike `payout/`, which every store bootstraps eagerly at `open()`. An existing store predating this
  feature has no `stage-evidence/` directory on disk; `open()`'s bootstrap/availability checks
  intentionally never require it, so an older store keeps opening exactly as before until something
  actually calls `persistPagedStageEvidence`.

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
