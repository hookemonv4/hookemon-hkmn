# Lease expiry during mutation

## Runner behavior

A fence lost before a provider effect leaves the cycle nonterminal with NOT_SENT evidence and no provider mutation. A stale worker never receives authority from this retry state. Preserve the prepared request and lease evidence.

## Recovery constraints

Only a newly valid fenced owner may retry the identical request. Existing nonce reservations retain their fencing token and lease window; takeover requires a later valid lease after expiry, and a stale release cannot clear a newer reservation. Post-provider-boundary ambiguity remains observation-only SENT_UNKNOWN. Post-signing lease loss follows the separate PREPARED/SIGNED/BROADCAST/REFUSED chain journal. The cited matrix test covers only pre-effect loss.

Requirements revision 68 retains the owner-approved bounded-transient classification from revision 66. Its exact approval is recorded in `decisions/owner-approvals/revision-68-spec-s5-approved.json`. The canonical matrix binds the implemented stage boundary below; broader recovery claims require their own executable evidence. Semantic-invalid wrong-asset, wrong-recipient and conflicting-evidence holds remain unchanged.

## Recovery contract

Failure-matrix cells: Wallet lease:lost-lease
Owning work package: WP07
Expected outcome: terminal=none; attempt=NOT_SENT; next=retry
Test: packages/adapters/test/app/stage-driver.test.mjs — keeps a lost lease retryable before a provider effect and retains a NOT_SENT record
Alarm reason/code: LEASE_CONTENTION
Resume command: use only the supported policy- and lease-fenced runner recovery; no ad-hoc signing or broadcast.

## Escalation

Preserve the cycle and stage identifiers, request digest and redacted failure evidence. Escalate conflicting canonical evidence or an attempted identity, amount or signed-byte change before allowing another effect.
