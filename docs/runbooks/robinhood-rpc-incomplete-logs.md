# Robinhood RPC incomplete transfer logs

## Detection

Alert when a Transfer-log replay is missing, unordered, cannot reconcile
mint-minus-burn with the launch manifest, or lacks its required second source.
Journal the snapshot as `HELD_DATA_UNVERIFIED` with the failed completeness
proof and pinned block context.

## Safe stop

Do not prepare `claim-process`, form a payout manifest, or fill a gap with
manually collected logs. An incomplete holder set cannot be repaired in place.

## Runner behavior

The required path replays every Transfer log to a finalized pinned block,
rechecks the hash, and requires an independent second source or archive RPC.
Any failed completeness proof rejects the snapshot before claim preparation.
`reconcileLiveEligibilitySnapshot` holds the cycle `HELD_DATA_UNVERIFIED` when
the replayed supply does not reconcile or an independent source disagrees.

## Operator recovery

No supported CLI/dashboard control can amend or approve an incomplete snapshot.
Do not insert logs manually. `resume` and `abort-cycle` are planned (WP12);
dashboard pause/resume is planned (WP10b), after a new completeness proof passes.

## Escalation

Escalate when the second source is absent or disagrees, supply reconciliation
fails, or the archive range cannot be retrieved.

## Evidence

Failure-matrix cell: Snapshot:incomplete-logs.
Owning work package: WP09a.
Existing adapter evidence: paged Transfer logs retain each page's checked hash.

## Recovery contract

Failure-matrix cells: Snapshot:incomplete-logs
Owning work package: WP09a
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=none; next=owner-decision
Test: packages/adapters/test/app/eligibility-snapshot.test.mjs — holds incomplete snapshot logs durably after reopen before the sole claim transition
Alarm reason/code: OPEN FACT (WP09a): no dedicated alert code is emitted for incomplete snapshot logs.
Resume command: none supported; obtain the pinned range from an independent source before a snapshot is accepted.
