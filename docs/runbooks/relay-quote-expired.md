# Relay quote expired

## Runner behavior

The stage remains nonterminal before any request, signature or broadcast. Preserve the expired quote and request evidence. Never sign the expired quote or silently replace an economic action.

## Recovery constraints

Approved bounded recovery requires a durable expired-quote identity and deadline, no unresolved signed or broadcast attempt, and replacement admission for the same claimed principal under the existing ceilings. The cited matrix test proves the pre-effect nonterminal boundary; it does not by itself prove automatic re-quotation.

Requirements revision 68 retains the owner-approved bounded-transient classification from revision 66. Its exact approval is recorded in `decisions/owner-approvals/revision-68-spec-s5-approved.json`. The canonical matrix binds the implemented stage boundary below; broader recovery claims require their own executable evidence. Semantic-invalid wrong-asset, wrong-recipient and conflicting-evidence holds remain unchanged.

## Recovery contract

Failure-matrix cells: Relay quote:expired-quote
Owning work package: WP07
Expected outcome: terminal=none; attempt=none; next=retry
Test: packages/adapters/test/app/stage-driver.test.mjs — keeps an expired Relay quote retryable before any request or broadcast
Alarm reason/code: OPEN FACT (WP07): no dedicated alert code is emitted for quote expiry.
Resume command: use only the supported policy- and lease-fenced runner recovery; no ad-hoc signing or broadcast.

## Escalation

Preserve the cycle and stage identifiers, request digest and redacted failure evidence. Escalate conflicting canonical evidence or an attempted identity, amount or signed-byte change before allowing another effect.
