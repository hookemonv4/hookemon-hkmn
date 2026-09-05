# EVM nonce interference

## Detection

Treat a nonce differing from the prepared request as an EVM nonce-interference
incident.

## Safe stop

Do not sign or broadcast a replacement transaction while the original nonce is
unresolved.

Do not manually delete a wallet nonce reservation. Its fencing token and lease
window remain part of the recovery evidence; only an expired reservation can be
taken over by a later valid fence.

## Runner behavior

The affected recipient is quarantined as `NONCE_INTERFERENCE` before a new
spend is created. Later recipients may finish; the completed payout pass then
holds the cycle for an owner decision about the liability.

## Operator recovery

No supported command can clear nonce interference.

## Escalation

Escalate the expected and observed nonce with the original request digest.
Include the reservation fencing token and lease window so recovery can distinguish
nonce interference from a stale worker.

## Evidence

The original transaction and nonce finality remain required recovery evidence.

## Recovery contract

Failure-matrix cells: EVM nonce:interference
Owning work package: WP08a
Expected outcome: terminal=HELD_OWNER_DECISION; attempt=NONCE_INTERFERENCE; next=owner-decision
Test: packages/adapters/test/app/stages-payout.test.mjs — continues a later recipient after isolated nonce interference and holds reopened payout custody
Alarm reason/code: `EVM_NONCE_STALE`
Resume command: none supported; resolve the original nonce before any replacement spend.
