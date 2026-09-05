# Solana RPC 429

## Detection

Alert when `SolanaRpcError` records `httpStatus: 429`. Journal the request,
response classification, and current attempt state. A rate limit after a send
does not prove that the transaction was never accepted.

## Safe stop

Do not issue an unjournaled retry, replacement signature, or new transaction.
Keep existing signed bytes and wait for reconciliation where a send may have
occurred.

## Runner behavior

The RPC client makes no hidden retry. The target path uses bounded backoff for
reads and preserves ambiguous mutation attempts for reconciliation; priority
and provider changes must remain policy-bound.

OPEN FACT: Live retry, backoff, and failover wiring is missing. L4-M9 assigns
it to WP08a, WP08b, and WP13. Until then, preserve the ambiguous attempt and
keep the cycle held rather than retrying.

## Operator recovery

No supported rate-limit override or RPC switch exists in the operator surface.
Do not change endpoints or priority fees manually. `resume` and `abort-cycle`
are planned (WP12); dashboard pause/resume is planned (WP10b), after the
original attempt has reconciled.

## Escalation

Escalate when the limit persists after the runner's bounded backoff, affects a
signed or broadcast attempt, or prevents the required finality observation.

## Evidence

Owning work package: WP13.
Existing adapter evidence: the Solana RPC test maps HTTP 429 to `SolanaRpcError`.
Traceability: L4-M9.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP13
Expected outcome: terminal=none; attempt=none; next=none
Test: OPEN FACT (WP13): no executed HTTP-429 recovery test is cited by the current runbook.
Alarm reason/code: OPEN FACT (WP13): no dedicated alert code is emitted for RPC rate limiting.
Resume command: none supported; retain the original request and retry only a documented read-only observation.
