# Lease expiry during mutation

## Detection

- Alert reason: the wallet lease or fencing token is no longer current immediately before a provider mutation, signature, or broadcast.
- Target journal state: retain the existing `PREPARED`, `SIGNED`, or `BROADCAST` evidence and enter `HELD_UNAVAILABLE`.

## Safe stop

- Mark the path unavailable and do not invoke a live runner that could let the stale worker send another action. An execution-pause control is planned (WP10b).
- Do not reacquire a lease and then send old prepared bytes, use a fresh nonce, or create a second cycle.

## Runner behavior

- The runner checks the fence immediately before the provider mutation. A pre-call fence loss
  records `NOT_SENT`, holds the cycle `HELD_UNAVAILABLE`, and invokes no provider effect.
- Retain existing bytes and provider records for reconciliation; a stale fence never authorizes a new action.
- A wallet nonce reservation carries its fencing token plus `leaseAcquiredAtMs` and
  `leaseExpiresAtMs`. An expired reservation fails its next signer or broadcast assertion. A
  replacement worker may take it over only with a later valid lease window after expiry; it must not
  delete or release the old reservation first.

## Operator recovery

- The production status output does not expose provider, transaction, or finality evidence. Preserve the recorded action and use only the approved reconciliation control when it is available.
- No control overrides a stale fence. Resume is planned (WP12) and remains unavailable until reconciliation proves the prior outcome.
- Terminal reconciliation releases only the exact global wallet reservation with its matching
  fencing token and lease window. A stale release cannot erase a newer fence; an already released
  record may only clear the same stranded global reservation idempotently.

## Escalation

Escalate the lease owner, fencing value, cycle, stage, and journal digest to the operations owner when another worker may have acquired the lease.

## Evidence

- Failure-matrix cell: `Wallet lease:lost-lease` expects `HELD_UNAVAILABLE` and is owned by WP07.
- Traceability: L3-M9 and L5-M12.

## Recovery contract

Failure-matrix cells: Wallet lease:lost-lease
Owning work package: WP07
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=NOT_SENT; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds a lost lease before a provider effect and retains a NOT_SENT retry record
Alarm reason/code: `LEASE_CONTENTION`
Resume command: none supported; no action may resume until the prior effect is reconciled.

## Proposed revision 66 (not implemented; not canonical)

`decisions/ADR-0025-bounded-transient-recovery-classification.md` splits this
single canonical cell into two proposed cases that must not share one tuple:

- **Before the capability boundary** (proven-pre-effect-transient): no effect
  occurred, so an owner decision is not required to make progress. Proposed
  target: `terminal=null`, `attempt=NOT_SENT`,
  `next=retry-same-request-under-new-lease` — a newly, later-fenced owner may
  retry the identical prepared request digest exactly once; CAS/fencing must
  still prevent the stale owner from performing any effect after fence
  failure.
- **After the capability boundary was already reached** (effect-ambiguous,
  new proposed cell `Wallet lease:lost-lease-after-capability`): the provider
  mutation may already have been sent, so this is not the same evidence class.
  Proposed target: `terminal=null`, `attempt=SENT_UNKNOWN`,
  `next=reconcile-before-retry` — observation-only, no automatic retry or new
  provider mutation until canonical reconciliation resolves the prior attempt.

No implementation exists yet for either case; the current, canonical control
above (recorded unchanged in `docs/audit/2026-09-04/failure-matrix.json`)
records `NOT_SENT` with zero effect and lets the scheduler reacquire the
lease on a later run, without an automatic same-digest retry or the
post-boundary `SENT_UNKNOWN` reclassification, and does not distinguish the
two cases at all. Both proposed rows are recorded in the non-canonical
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`,
not in the canonical matrix. This section is a draft citation only — do not
resume a held cycle against it until the revision is owner-approved through
`gates/spec.json`'s `S5` item and this specific behavior is implemented and
tested.
