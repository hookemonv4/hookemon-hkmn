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

## Proposed revision 66

`decisions/ADR-0025-bounded-transient-recovery-classification.md` classifies
an expired blockhash as effect-ambiguous, not semantic-invalid: the original
signature may or may not have landed, so a mechanical hold-and-owner-decision
cannot safely be resolved by a person either. The proposed target is
`terminal=null`, `attempt=BROADCAST`, `next=reconcile-then-replace`: keep the
original attempt nonterminal and observation-only, reconcile its signature
until finalized or until canonical validity/status evidence proves it expired
and unlanded, and only then create exactly one linked replacement attempt
with a fresh blockhash/signature. The original bytes and signature are
retained forever; no replacement is created from timeout, a missing response,
or block height alone.

The "Recovery contract" above is the frozen revision-65 contract and the
currently deployed fallback: it is binding today and stays binding regardless
of whether this proposal is later owner-approved, until an implementation and
a promoted matrix cell supersede it. Its cited test itself proves only that
the low-level `createStageDriver` primitive leaves `terminalState=null` while
the chain attempt persists `BROADCAST` when this error is thrown on
reconcile — not that the frozen whole-cycle hold above is exercised
end-to-end, and not the proposed replacement. Treat that gap as documented
contract/evidence drift, not as proof either way. The unimplemented proposed
row lives only in the non-canonical
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`.

This section is authoritative only once a `decisions/owner-approvals/*`
receipt approves the exact current `specs/requirements.json` hash under
`gates/spec.json`'s `S5` item AND this behavior has an implemented, passing,
non-`OPEN FACT` citation promoted into the canonical matrix; check both
directly rather than inferring either from this document's wording.
