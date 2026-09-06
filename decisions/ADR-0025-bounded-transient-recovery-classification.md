# ADR-0025: Classify pre-effect transient failures apart from semantic-invalid holds

## Status

PROPOSED_PENDING_OWNER_APPROVAL. Drafted for requirements revision 66,
alongside ADR-0024. This decision grants no deployment, credential use,
signing, broadcast, asset movement, spending, or publication authority, and is
not itself an owner approval of revision 66.

## Context

Revision 65 holds four failure classes — an expired Relay quote, an expired
Solana blockhash, a lost wallet lease, and a denied/unavailable external
signer — as `HELD_UNAVAILABLE` pending an owner decision, identically to
semantic-invalid requests such as a wrong-asset or wrong-recipient transaction
policy refusal. `transient-recovery-contract-review.md` finds that mechanical
restoration of all four whole-cycle holds conflicts with the accepted launch
target: unattended bounded recovery, where retries resolve the same transfer,
an expired Solana transaction is replaced only after its old outcome is
resolved (`authoritative-launch-handoff.md:186`), active pending work
reconciles on the fast cadence with bounded outage backoff (`:223-229`), and
restart completes the same operations exactly once (`:283`). Requiring an
owner decision for every pre-effect lease loss, unavailable signer, expired
pre-sign quote, or definitively expired/unlanded Solana transaction would
reintroduce per-cycle manual stops.

The four failures below have no external effect yet, or their prior effect is
provably absent, at the point they are detected; they are not semantically
wrong requests and do not need a person to resolve them. Wrong-asset and
wrong-recipient remain semantic-invalid requests and are unaffected by this
decision.

## Decision

Every recovery path is assigned to exactly one of three classes:

- **Semantic-invalid**: the request itself is wrong. Terminal `HELD_*` state
  with an owner decision. Unchanged by this ADR (wrong-asset, wrong-recipient,
  cross-cycle attribution failure, conflicting canonical evidence).
- **Effect-ambiguous**: the external outcome cannot yet be distinguished.
  Observation-only until canonical evidence resolves it; no owner decision is
  requested while ambiguity remains unresolved, because a person has no more
  information than the automated reconciler does.
- **Proven-pre-effect-transient**: no external effect occurred. The identical
  approved intent may retry automatically once the blocking condition clears.

The four cells reclassify as follows, with `terminal=null` in every case (no
cycle terminal state):

| Failure | Class | Attempt | Next action |
| --- | --- | --- | --- |
| Relay quote expired before any request/signature | proven-pre-effect-transient | none | `refresh-after-readmission` |
| Solana blockhash expired past its validity boundary | effect-ambiguous | `BROADCAST` | `reconcile-then-replace` |
| Wallet lease/fencing token lost before a provider/signature boundary | proven-pre-effect-transient (pre-boundary); reclassified effect-ambiguous `SENT_UNKNOWN` if the capability boundary was reached | `NOT_SENT` | `retry-same-request-under-new-lease` |
| External signer denied/timed out before signing | proven-pre-effect-transient | `NOT_SENT` | `retry-after-signer-readiness` |

Quote refresh happens at the policy/admission boundary, not as a stage-local
quote swap, and only after proving no signed or broadcast attempt exists for
the same claimed principal; a quote is never silently substituted once signed
bytes exist. Solana replacement happens only behind an authoritative
expired-and-unlanded resolution recorded against the old attempt, creates
exactly one linked replacement, and retains the original signed bytes and
signature forever. Lost-lease and Keychain retries reuse the identical
prepared request digest; a stale fenced owner performs no effect after fence
failure, and CAS/fencing prevents it from overwriting a newer attempt. The
signer-unavailable reason is durable, redacted, and UI-visible after restart,
distinct from the scheduler's current generic `TICK_FAILED` outage-backoff
reason.

## Alternatives

### Restore all four revision-65 whole-cycle holds unchanged

Rejected: conflicts with the accepted unattended bounded-recovery target
(`authoritative-launch-handoff.md:186,223-229,283`) by reintroducing a
per-cycle manual stop for conditions that provably had no effect or remain
merely ambiguous, not wrong.

### Treat all four as the held-position carve-out in ADR-0024

Rejected: these are whole-cycle transaction/lifecycle safety conditions, not
card-level holds; the accepted target for them is bounded automatic recovery,
not a supplementary per-card settlement path. Keeping them as a distinct
three-class taxonomy avoids conflating "this specific card should return
value independently" with "this transient condition should stop blocking the
whole cycle automatically."

## Consequences

`docs/audit/2026-09-04/failure-matrix.json` and the four affected runbooks
(`relay-quote-expired.md`, `solana-blockhash-expiry.md`,
`lease-expiry-mid-mutation.md`, `keychain-user-interaction.md`) carry a
"Proposed revision 66" section citing this ADR; their existing bodies still
describe the current, implemented revision-65 behavior and must not be read
as already changed. No runtime, stage-driver, scheduler, or test change is
made by this ADR. Per `transient-recovery-contract-review.md`, suggested
disjoint implementation ownership after approval is: policy/admission plus
quote-refresh repository transition; return/Solana expired-attempt resolution
and replacement; stage-driver lease/signer classification; scheduler/status
projection; then one serial failure-matrix/runbook/module-index integration
owner. `docs/modules/cycle-runner.md` and `docs/modules/index.json` need a
matching update after implementation, which this ADR does not perform.
