# Keychain user interaction unavailable

## Runner behavior

A provable signing denial before any broadcast leaves the cycle nonterminal with NOT_SENT evidence and bounded redacted OS error text. Preserve the signer identity and request; never export keys or substitute an unapproved signer.

## Recovery constraints

Restore readiness of the same approved signer before retrying the identical request. This denial cell does not establish that a timeout produced no signature. Sign-only timeout recovery is separately restricted to the verified owned Keychain broker and requires durable unsigned bytes, signer identity, request/policy digests and validity context before invocation, exact reuse and signature deduplication. It grants no broadcast authority. Opaque signer timeouts retain their terminal no-automatic-retry contract.

Requirements revision 68 retains the owner-approved bounded-transient classification from revision 66. Its exact approval is recorded in `decisions/owner-approvals/revision-68-spec-s5-approved.json`. The canonical matrix binds the implemented stage boundary below; broader recovery claims require their own executable evidence. Semantic-invalid wrong-asset, wrong-recipient and conflicting-evidence holds remain unchanged.

## Recovery contract

Failure-matrix cells: External signer:keychain-interaction
Owning work package: WP08a
Expected outcome: terminal=none; attempt=NOT_SENT; next=retry
Test: packages/adapters/test/app/stage-driver.test.mjs — keeps a keychain interaction denial retryable with redacted OS text before any broadcast
Alarm reason/code: OPEN FACT (WP08a): no dedicated alert code is emitted for a signing error.
Resume command: use only the supported policy- and lease-fenced runner recovery; no ad-hoc signing or broadcast.

## Escalation

Preserve the cycle and stage identifiers, request digest and redacted failure evidence. Escalate conflicting canonical evidence or an attempted identity, amount or signed-byte change before allowing another effect.
