# Collector timeout

## Detection

Alert on a mutation timeout, lost response, or `CollectorCryptError` after a
send. Treat a received `503` and a network failure as unresolved until provider
and chain evidence prove the outcome; the target journal state is `SENT_UNKNOWN`.

## Safe stop

Do not issue a new purchase, open, buyback, or transaction-submission request.
Keep the original request digest, memo, signed bytes, and error evidence; do not
manufacture a clean terminal state if no durable pre-send record exists.

## Runner behavior

The stage driver records `SENT_UNKNOWN` after a committed-then-`503` response,
preserves it across restart, and refuses another provider mutation until
read-only reconciliation proves the original outcome.

## Operator recovery

When the original memo or mint is known, existing read-only `getPackStatus` or
`getBuybackAvailable` calls may collect evidence. They cannot authorize a retry.
No supported operator resume or abort command exists today; those are planned
(WP12), and dashboard controls are planned (WP10b).

## Escalation

Escalate when read-only evidence is absent, contradictory, or shows a provider
mutation after the timeout. Escalate immediately if a second mutation was sent
or a nonzero token delta cannot be attributed to the original request.

## Evidence

Failure-matrix cell: Collector API:committed-then-503.
Owning work package: WP08b.
Traceability: L4-M4, L4-M7.

## Recovery contract

Failure-matrix cells: Collector API:committed-then-503
Owning work package: WP08b
Expected outcome: terminal=none; attempt=SENT_UNKNOWN; next=reconcile
Test: packages/adapters/test/app/stage-driver.test.mjs — keeps a Collector committed-then-503 attempt SENT_UNKNOWN after reopen until reconciliation
Alarm reason/code: OPEN FACT (WP08b): no dedicated alarm reason/code is emitted for an unresolved Collector mutation.
Resume command: none supported; reconcile the original memo, provider status, signature, and finalized deltas first.
