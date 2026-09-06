# Relay quote expired

## Detection

Treat an expired Relay quote as unavailable before any signature or broadcast.

## Safe stop

Do not sign an expired quote or create a replacement economic action.

## Runner behavior

The cycle is held and preserves the expired quote with its request evidence.

## Operator recovery

No supported command can re-quote a held cycle.

## Escalation

Escalate the quote expiry, request digest, and available custody evidence.

## Evidence

The original quote and its expiry remain attached to the held cycle.

## Recovery contract

Failure-matrix cells: Relay quote:expired-quote
Owning work package: WP07
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds an expired Relay quote before any request or broadcast
Alarm reason/code: OPEN FACT (WP07): no dedicated alert code is emitted for quote expiry.
Resume command: none supported; an approved reconciliation must resolve the original held cycle first.

## Proposed revision 66

`decisions/ADR-0025-bounded-transient-recovery-classification.md` classifies a
pre-request, pre-signature expired quote as proven-pre-effect-transient, not
semantic-invalid: no provider or chain attempt exists, so an owner decision is
not required to make progress. The proposed target is `terminal=null`,
`attempt=null`, `next=refresh-after-readmission`: the repository persists the
expired quote's identity and deadline, and only after re-proving no signed or
broadcast attempt exists does policy/admission atomically select one
replacement quote for the same claimed principal, re-running full admission
and ceilings. A quote is never silently substituted once signed bytes exist
for it.

The "Recovery contract" above is the frozen revision-65 contract and the
currently deployed fallback: it is binding today and stays binding regardless
of whether this proposal is later owner-approved, until an implementation and
a promoted matrix cell supersede it. Its cited test itself proves only that
the low-level `createStageDriver` primitive leaves `terminalState=null`, no
attempt persisted, and the cycle active/retryable when this error is thrown
— not that the frozen whole-cycle hold above is exercised end-to-end, and not
the proposed refresh. Treat that gap as documented contract/evidence drift,
not as proof either way. The proposed row lives only in the non-canonical
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`
and is not implemented.

This section is authoritative only once both hold: (a) a
`decisions/owner-approvals/*` receipt approves the exact current
`specs/requirements.json` hash under `gates/spec.json`'s `S5` item, and (b)
this behavior has an implemented, passing, non-`OPEN FACT` citation promoted
into the canonical matrix. Check both directly; do not infer either from this
document's wording.
