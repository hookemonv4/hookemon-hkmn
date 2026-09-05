# Holder count above payout envelope

## Detection

- Alert reason: `evaluatePayoutFeasibility` finds a holder count above the configured `maxRecipientCount` before a process claim.
- Target journal state: `reconcileLiveEligibilitySnapshot` retains the eligibility snapshot and feasibility result and enters `HELD_UNAVAILABLE` before a payout record or broadcast exists.

## Safe stop

- Mark the payout path unavailable and do not invoke a live runner to claim process USDG for a payout that cannot fit the approved envelope. An execution-pause control is planned (WP10b).
- Do not split the manifest, drop holders, sample recipients, or increase a limit from the runner.

## Runner behavior

- The eligibility snapshot path refuses the next claim and holds the cycle `HELD_UNAVAILABLE` with the measured feasibility evidence (recipient count, configured maximum, manifest digest) before any payout record exists.
- Do not create a partial payout transaction from an over-limit manifest.

## Operator recovery

- The production status output does not expose the snapshot or feasibility record. Reconciliation control is planned (WP10b).
- No current CLI or dashboard control changes the recipient envelope. A dashboard status and recovery surface is planned (WP10b).

## Escalation

Escalate the snapshot block, manifest digest, measured holder count, and feasibility envelope to the payout owner for an approved design change.

## Evidence

- Failure-matrix cell: `Payout feasibility:holder-count-above-envelope` expects `HELD_UNAVAILABLE` and is owned by WP09b.
- Traceability: L2-M19 and L5-M8.

## Recovery contract

Failure-matrix cells: Payout feasibility:holder-count-above-envelope
Owning work package: WP09b
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/eligibility-snapshot.test.mjs — holds a holder envelope breach durably after reopen before the sole claim transition
Alarm reason/code: OPEN FACT (WP09b): no dedicated alert code is emitted for payout infeasibility.
Resume command: none supported; an approved design change must establish a feasible manifest first.
