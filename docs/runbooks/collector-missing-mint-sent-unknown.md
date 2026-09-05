# Collector missing mint after an unknown open

## Detection

An open attempt remains `SENT_UNKNOWN` and its memo-bound status cannot prove a
single card mint after the guarded recovery read.

## Safe stop

Do not issue another open, infer a mint, buy back a card, or use a wallet token
balance as evidence. Preserve the memo, provider status, and Solana evidence.

## Runner behavior

The open reconciliation holds the cycle `HELD_DATA_UNVERIFIED` while retaining
the `SENT_UNKNOWN` attempt. It makes no further provider mutation after the
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
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=SENT_UNKNOWN; next=owner-decision
Test: packages/adapters/test/app/stages-collector-lifecycle.test.mjs — open SENT_UNKNOWN retry missing mint holds durably after reopen
Alarm reason/code: OPEN FACT (WP08b): no dedicated alarm reason/code is emitted for this hold.
Resume command: none supported; reconcile the original memo and finalized evidence first.
