# Solana blockhash expiry

## Runner behavior

The stage remains nonterminal and retains its BROADCAST attempt, original signed bytes, signature, blockhash and validity evidence. A missing final result or an expired height alone never proves the transaction did not land.

## Recovery constraints

The matrix action describes the existing recovery boundary, not permission to rebroadcast expired bytes. Reconcile the original signature first. Replacement requires canonical expired-and-unlanded proof, one linked replacement and permanent retention of the original evidence under the approved recovery contract. The cited test proves retention across reopen, not the complete replacement sequence.

Requirements revision 68 retains the owner-approved bounded-transient classification from revision 66. Its exact approval is recorded in `decisions/owner-approvals/revision-68-spec-s5-approved.json`. The canonical matrix binds the implemented stage boundary below; broader recovery claims require their own executable evidence. Semantic-invalid wrong-asset, wrong-recipient and conflicting-evidence holds remain unchanged.

## Recovery contract

Failure-matrix cells: Chain transaction:expired-blockhash
Owning work package: WP08a
Expected outcome: terminal=none; attempt=BROADCAST; next=reconcile-or-rebroadcast
Test: packages/adapters/test/app/stage-driver.test.mjs — keeps an expired return blockhash retryable while retaining a broadcast attempt after reopen
Alarm reason/code: SOLANA_BLOCKHASH_STALE
Resume command: use only the supported policy- and lease-fenced runner recovery; no ad-hoc signing or broadcast.

## Escalation

Preserve the cycle and stage identifiers, request digest and redacted failure evidence. Escalate conflicting canonical evidence or an attempted identity, amount or signed-byte change before allowing another effect.
