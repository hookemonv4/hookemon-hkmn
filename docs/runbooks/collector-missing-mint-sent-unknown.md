# Collector missing mint after an unknown open

## Detection

An open attempt remains `SENT_UNKNOWN` and its memo-bound status cannot prove a
single card mint after read-only reconciliation.

## Safe stop

Do not issue another open, infer a mint, buy back a card, or use a wallet token
balance as evidence. Preserve the memo, provider status, and Solana evidence.

## Runner behavior

The open reconciliation carves this pack's card out as a durable held position
(`cycleRepository.recordHeldPosition`) with terminal class `HELD_UNRESOLVED`
(reason `SENT_UNKNOWN_DEADLINE`) once past its reconcile deadline, or
`HELD_DATA_UNVERIFIED` if Collector's status read itself answers with no
memo-bound mint before the deadline. It never holds the whole cycle for this
one pack: a multi-pack batch's other packs still open, gate, and sell normally
in the same reconcile pass. It makes no further provider mutation after the
missing-mint result.

## Operator recovery

Obtain memo-bound status and finalized token evidence through the approved
read-only path. No command can turn an unknown attempt into a new open request.

## Escalation

Escalate conflicting status, a missing memo binding, or any later mutation.

## Evidence

The durable unknown attempt and its memo identify the only reconciliation path.

## Recovery contract

Failure-matrix cells: Open result:missing-mint-sent-unknown-retry
Owning work package: WP08b
Expected outcome: cycle terminal=none (position held HELD_UNRESOLVED); attempt=SENT_UNKNOWN; next=held-position-owner-decision
Test: packages/adapters/test/app/stages-collector-lifecycle.test.mjs — open SENT_UNKNOWN retry missing mint holds durably after reopen
Alarm reason/code: OPEN FACT (WP08b): no dedicated alarm reason/code is emitted for this hold.
Resume command: none supported; reconcile the original memo and finalized evidence first.
