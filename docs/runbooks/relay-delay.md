# Relay delay

## Detection

Alert when a Relay intent remains `PENDING`, a status read is unavailable, or the
cycle journal records the provider attempt as `SENT_UNKNOWN`. A broadcast without
a finalized, cycle-attributed destination delta is also unresolved.

## Safe stop

Do not sign another Relay step, re-quote, or treat the quote as delivered. Keep
the existing intent, request digest, and any signed bytes as the sole evidence.

## Runner behavior

The stage driver records a lost response as `SENT_UNKNOWN`, preserves it across
restart, and does not automatically re-quote, sign, broadcast, or settle a
delayed leg.

## Operator recovery

The only existing recovery capability is read-only intent reconciliation while
the originating Relay client still retains its in-memory intent record. It is
not a durable restart control. No supported operator resume or abort command
exists today; `resume` and `abort-cycle` are planned (WP12), and dashboard
pause/resume is planned (WP10b).

## Escalation

Escalate when the intent cannot be authenticated after a process restart, when
either chain shows a nonzero but unattributed delta, or when the delay exceeds
the route's usable lifetime. Do not create a replacement action from a balance.

## Evidence

Failure-matrix cell: Relay:lost-response.
Owning work package: WP07.
Traceability: L4-M12, L4-M14.

## Recovery contract

Failure-matrix cells: Relay:lost-response
Owning work package: WP07
Expected outcome: terminal=none; attempt=SENT_UNKNOWN; next=reconcile
Test: packages/adapters/test/app/stage-driver.test.mjs — keeps a Relay lost-response attempt SENT_UNKNOWN after reopen until reconciliation
Alarm reason/code: OPEN FACT (WP07): no dedicated alarm reason/code is emitted for a lost Relay response.
Resume command: none supported; reconcile the original Relay request and finalized deltas before another route is considered.
