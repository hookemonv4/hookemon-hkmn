# Relay wrong asset

## Detection

Alert when a Relay quote or step names an unexpected chain, mint, token address,
recipient, or atomic amount. Record the pre-signature policy refusal as
`HELD_DATA_UNVERIFIED`; any wrong-asset delta after broadcast is an incident.

## Safe stop

Reject the unsigned step. Do not sign, broadcast, re-quote, or rely on a ticker
symbol or a normalized Solana address as asset identity. Preserve the quote and
the policy-decoder result for review.

## Runner behavior

The transaction-policy boundary records `NOT_SENT` and holds the cycle
`HELD_DATA_UNVERIFIED` before signing. It has no automatic correction or asset
substitution path.

## Operator recovery

Only read-only quote and intent evidence may be inspected through existing
adapter calls. No supported operator command can replace, cancel, or approve a
wrong-asset action today; `resume` and `abort-cycle` are planned (WP12), while
dashboard control wiring is planned (WP10b).

## Escalation

Escalate immediately if any signature was requested, any transaction was
broadcast, or a finalized delta names the wrong asset or recipient. Keep the
cycle held until custody attribution is reconciled.

## Evidence

Failure-matrix cell: Transaction policy:wrong-asset.
 Owning work package: WP08a.
Traceability: L4-M2, L4-M14.

## Recovery contract

Failure-matrix cells: Transaction policy:wrong-asset
Owning work package: WP08a
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=NOT_SENT; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds a wrong-asset transaction policy refusal before signing
Alarm reason/code: OPEN FACT (WP08a): no dedicated alarm reason/code is emitted for a policy refusal.
Resume command: none supported; do not re-quote or sign until the decoded intent is corrected.
