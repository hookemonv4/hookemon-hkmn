# Unknown card mutation deadline

## Detection

A SENT_UNKNOWN open passes its recorded deadline without conclusive evidence.

## Safe stop

Do not resubmit the mutation or infer that no card was opened.

## Runner behavior

The pack becomes HELD_UNRESOLVED and retains its original SENT_UNKNOWN attempt.

## Operator recovery

Reconcile the original memo and attributable chain evidence before resolving the position.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Card mutation:sent-unknown-deadline
Owning work package: WP08b
Expected outcome: terminal=none; attempt=SENT_UNKNOWN; next=held-position-owner-decision-or-reconcile
Test: packages/adapters/test/app/stages-collector-lifecycle.test.mjs — reconcileLiveOpen holds a SENT_UNKNOWN pack past its deadline as HELD_UNRESOLVED without resubmitting
Alarm reason/code: OPEN FACT (WP08b): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
