# Solana blockhash expiry

## Detection

Alert when validity evidence has `observedHeight > lastValidHeight`, the RPC
rejects signed bytes for a stale blockhash, or a `BROADCAST` attempt lacks
finalization at that boundary. The journal must retain the signed bytes,
signature, blockhash, and validity evidence.

## Safe stop

Do not sign a replacement or advance the stage. Preserve the original attempt
and reconcile it; a missing final result is not proof that no transaction ran.

## Runner behavior

The required failure-matrix outcome is `HELD_UNAVAILABLE` with the attempt at
`BROADCAST`, followed by an owner decision after reconciliation establishes the
original outcome. Transaction policy rejects stale blockhashes before broadcast
and binds the blockhash to the signed message.

## Operator recovery

No incident-specific CLI recovery control exists. Do not resend bytes from an
ad-hoc tool. `resume` and `abort-cycle` are planned (WP12); dashboard
pause/resume is planned (WP10b). Use either only after reconciliation supplies
finalized evidence for the original attempt.

## Escalation

Escalate if finalization and non-broadcast cannot be distinguished after the
validity boundary, if observers disagree, or if a new signature was requested.

## Evidence

Failure-matrix cell: Chain transaction:expired-blockhash.
Traceability: L4-M9.
Owning work package: WP08a, WP13.

## Recovery contract

Failure-matrix cells: Chain transaction:expired-blockhash
Owning work package: WP08a
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=BROADCAST; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds an expired return blockhash while retaining a broadcast attempt after reopen
Alarm reason/code: `SOLANA_BLOCKHASH_STALE`
Resume command: none supported; reconcile the original signed bytes and signature before any replacement is considered.
