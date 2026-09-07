# All cards held settlement

## Detection

Every card is held and the main cycle has no attributable sale proceeds.

## Safe stop

Do not fund a payout from held value or another cycle.

## Runner behavior

The main cycle completes with zero main settlement while its held positions remain tracked.

## Operator recovery

Resolve later proceeds through their original positions and supplementary settlement namespace.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Cycle settlement:all-cards-held-zero-proceeds
Owning work package: WP09b
Expected outcome: terminal=COMPLETED; attempt=none; next=zero-payout
Test: packages/adapters/test/app/cycle-repository.test.mjs — all held cards complete a cycle with zero main settlement
Alarm reason/code: OPEN FACT (WP09b): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
