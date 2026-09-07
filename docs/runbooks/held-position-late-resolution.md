# Late held-position resolution

## Detection

Attributable evidence arrives for a position held after a mutation deadline.

## Safe stop

Do not credit another cycle or discard the original unknown attempt.

## Runner behavior

Sold, refunded or never-sent outcomes resolve only on the position’s attributable path.

## Operator recovery

Retain the position identity and original holder snapshot for any supplementary settlement.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Held position:sent-unknown-late-resolution
Owning work package: WP09b
Expected outcome: terminal=COMPLETED; attempt=SENT_UNKNOWN; next=supplementary-settlement-or-close
Test: packages/adapters/test/app/cycle-repository.test.mjs — resolves a deadline-held position as sold, refunded, or never sent only on its attributable path
Alarm reason/code: OPEN FACT (WP09b): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
