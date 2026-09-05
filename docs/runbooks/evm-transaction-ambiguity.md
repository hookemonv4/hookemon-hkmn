# EVM transaction replaced

## Detection

Treat a same-nonce replacement as unresolved while its original nonce,
transaction hash, and finality remain unproven.

## Safe stop

Do not sign or broadcast another payout for the affected recipient. Preserve
the original signed bytes, nonce, calldata, and transaction hash for
reconciliation.

## Runner behavior

The affected recipient is quarantined as `NONCE_INTERFERENCE`. Later recipients
may finish from the immutable manifest; after the payout pass, the cycle enters
`HELD_OWNER_DECISION` for the quarantined liability.

## Operator recovery

No supported command can replace an unresolved EVM spend or redirect the
quarantined recipient.

## Escalation

Escalate the nonce, signed-bytes digest, transaction hash, and finality result.

## Evidence

The original nonce and transaction must be resolved before any owner decision.

## Recovery contract

Failure-matrix cells: EVM transaction:replaced
Owning work package: WP08a
Expected outcome: terminal=HELD_OWNER_DECISION; attempt=NONCE_INTERFERENCE; next=owner-decision
Test: packages/adapters/test/app/stages-payout.test.mjs — continues a later recipient after isolated nonce interference and holds reopened payout custody
Alarm reason/code: `EVM_NONCE_STALE`
Resume command: none supported; reconcile the original nonce and transaction before an owner decision.
