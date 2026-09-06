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

## Proposed revision 66 (draft, pending owner approval)

`transient-recovery-contract-review.md` classifies a pre-request, pre-signature
expired quote as proven-pre-effect-transient, not semantic-invalid: no provider
or chain attempt exists, so an owner decision is not required to make
progress. The draft proposes `terminal=null`, `attempt=null`,
`next=refresh-after-readmission`: the repository persists the expired quote's
identity and deadline, and only after re-proving no signed or broadcast
attempt exists does policy/admission atomically select one replacement quote
for the same claimed principal, re-running full admission and ceilings. A
quote is never silently substituted once signed bytes exist for it.

OPEN FACT (WP07): no implementation exists yet; the current build (evidenced
above) instead retries the same immutable expired quote under generic
scheduler outage backoff, which cannot make progress but also creates no
effect. This section is a draft citation only — do not resume a held cycle
against it until the revision is approved and implemented.
