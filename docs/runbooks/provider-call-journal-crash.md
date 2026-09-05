# Crash between provider call and journal write

## Detection

- Alert reason: restart finds a provider-bound stage at `PREPARED` with its request digest but no response or reconciliation evidence after the provider boundary.
- Target journal state: treat that prepared request as outcome-unknown. A recorded uncertain send uses `SENT_UNKNOWN` and advances only through reconciliation.

## Safe stop

- Mark the path unavailable and do not invoke a live runner to repeat the provider call, generate a fresh request, or create a new idempotency key. An execution-pause control is planned (WP10b).
- Preserve the request digest, stage inputs, provider identifiers, and custody observations.

## Runner behavior

- The WP07-0 stage driver records `PREPARED` before a provider call. On restart, it promotes an unresolved attempt to `SENT_UNKNOWN` and permits reconciliation before any later stage can advance.
- Provider-specific reconciliation and its executed recovery proof remain delivery work for WP07 and WP08b. Until then, stop before a new manual provider call and retain the request evidence.

## Operator recovery

- The production status output does not expose the original provider request or reconciliation evidence. Reconciliation control is planned (WP10b).
- No planned resume can clear an unresolved request. Resume after this class of incident is planned (WP12) and requires completed reconciliation.

## Escalation

Escalate the request digest, provider response lookup result, cycle, and custody evidence to the provider owner and release owner when reconciliation cannot establish the outcome.

## Evidence

- Failure-matrix cell: `Collector API:committed-then-503` expects `SENT_UNKNOWN` then `reconcile` and is owned by WP08b.
- Failure-matrix cell: `Relay:lost-response` expects `SENT_UNKNOWN` then `reconcile` and is owned by WP07.
- Traceability: L3-M9 and L4-M4.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP07
Expected outcome: terminal=none; attempt=none; next=none
Test: packages/adapters/test/app/stage-driver.test.mjs — persists PREPARED before a provider call and lets reconcileLive perform the only completion advance
Alarm reason/code: OPEN FACT (WP07): no dedicated alert code is emitted for a post-call journal crash.
Resume command: none supported; reconciliation is the only permitted completion path for the original request.
