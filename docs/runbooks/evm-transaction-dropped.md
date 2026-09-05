# EVM transaction dropped

## Detection

Treat a missing EVM transaction and receipt as unresolved while the persisted
nonce, signed bytes, calldata, and hash remain attributable to the recipient.

## Safe stop

Do not sign fresh bytes, allocate a new nonce, or change the recipient. Keep
the immutable broadcast attempt available for receipt search and recovery.

## Runner behavior

The runner reopens the repository and rebroadcasts only the exact persisted
bytes when both receipt and transaction are absent. The attempt stays
`BROADCAST`; no terminal hold is created for that recoverable case. The final
signer and broadcaster assertion uses the signed attempt's fencing token with
the current stage lease window, so a stale reservation cannot resend those
bytes.

## Operator recovery

No operator command constructs replacement bytes. Reconcile the original hash
or let the exact-byte recovery path submit the stored transaction.

## Escalation

Escalate if the stored bytes, nonce, calldata, or receipt observation differs
from the durable attempt.

## Evidence

The recipient page's signed bytes and approval context bind the only allowed resend.

## Recovery contract

Failure-matrix cells: EVM transaction:dropped
Owning work package: WP08a
Expected outcome: terminal=none; attempt=BROADCAST; next=reconcile-or-rebroadcast
Test: packages/adapters/test/app/stages-payout.test.mjs — rebroadcasts dropped bytes from a reopened payout repository without signing or holding
Alarm reason/code: `EVM_NONCE_STALE`
Resume command: none supported; use only receipt reconciliation or exact-byte rebroadcast.
