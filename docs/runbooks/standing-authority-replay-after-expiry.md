# Standing authority replay after expiry

## Detection

An owner authority has expired before its first use, or a caller presents a
replay whose exact persisted decision is absent. A matching persisted decision
remains valid for replay after the authority document expires.

## Safe stop

For an expired first use, do not reserve a day-cap slot or nonce, sign,
broadcast, or replace the intent. Preserve the rejected intent digest and the
authority expiry evidence. A matching persisted replay keeps its original
decision and continues to reconciliation without a second reservation or
signature.

## Runner behavior

The first use is `REFUSED` without a reservation or terminal cycle state. An
exact replay of a decision persisted before expiry keeps the cycle non-terminal,
records `RESPONSE_RECORDED` for the existing stage request, and moves to
reconciliation without consuming another day-cap slot, nonce, or signature.

## Operator recovery

Obtain a newly authorized intent. A fresh authority must be verified before its
first reservation; no command can revive an expired first use.

## Escalation

Escalate the authority digest, intent digest, expiry timestamp, and any claimed
reservation key to the signing owner.

## Evidence

The authority digest and durable decision distinguish a valid replay from a
new first-use request.

## Recovery contract

Failure-matrix cells: Standing authority:replay-after-expiry
Owning work package: WP07
Expected outcome: terminal=none; attempt=RESPONSE_RECORDED; next=reconcile
Test: packages/adapters/test/app/stage-driver.test.mjs — production signing replays a stored authority after expiry with one signer and a reopened reconciliation attempt
Alarm reason/code: OPEN FACT (WP07): no dedicated alert code is emitted for an expired authority.
Resume command: none supported; re-authorize the exact next action before signing.
