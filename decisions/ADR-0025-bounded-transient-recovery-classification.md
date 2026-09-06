# ADR-0025: Classify pre-effect transient failures apart from semantic-invalid holds

## Status

PROPOSED_PENDING_OWNER_APPROVAL. Drafted for requirements revision 66,
alongside ADR-0024. This decision grants no deployment, credential use,
signing, broadcast, asset movement, spending, or publication authority, and is
not itself an owner approval of revision 66. Formal approval of the exact
revision-66 `specs/requirements.json` bytes is the `S5` item defined in
`gates/spec.json`; no `decisions/owner-approvals/*` record for it exists yet,
and this ADR does not create one.

**Unlike ADR-0024, none of this ADR's target behavior is implemented at this
head.** The canonical `docs/audit/2026-09-04/failure-matrix.json` is
unchanged for every cell named below and still requires the current
`HELD_UNAVAILABLE`/owner-decision tuple for each. The proposed tuples this
ADR describes are recorded only in the clearly non-canonical
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`,
which is not read by `packages/runner/test/cycle/failure-matrix.test.mjs`, any
CI gate, or any other conformance check. A tuple below must not be promoted
into the canonical matrix, and its owning work package must not be added to
that test file's `OPEN_FACT_CELL_KEYS` allowlist, until the runtime change
exists and an exact passing test citation replaces the current-behavior
citation.

## Context

Revision 65 holds four failure classes — an expired Relay quote, an expired
Solana blockhash, a lost wallet lease, and a denied/unavailable external
signer — as `HELD_UNAVAILABLE` pending an owner decision, identically to
semantic-invalid requests such as a wrong-asset or wrong-recipient
transaction-policy refusal (see ADR-0024 for that unaffected class). Requiring
a person to decide every pre-effect lease loss, unavailable signer, expired
pre-sign quote, or definitively expired/unlanded Solana transaction reimposes
a manual stop for conditions that either had no effect yet or are merely
ambiguous, not wrong. This ADR proposes replacing that with three explicit
recovery classes and assigns each of the four revision-65 failures — split
into six named cases, because two of the four collapse a provable pre-effect
case and a genuinely ambiguous case into one tuple today — to exactly one
class.

## Decision

Every recovery path is assigned to exactly one of three classes:

- **Semantic-invalid**: the request itself is wrong. Terminal `HELD_*` state
  with an owner decision. Unaffected by this ADR (wrong-asset, wrong-recipient,
  cross-cycle attribution failure, conflicting canonical evidence,
  unattributed deposit, missing predecessor evidence, snapshot failure — the
  exhaustive list from ADR-0024).
- **Effect-ambiguous**: the external outcome cannot yet be distinguished.
  Observation-only until canonical evidence resolves it; no owner decision is
  requested while ambiguity remains unresolved, because a person has no more
  information than the automated reconciler does, and no automatic retry or
  new provider mutation is permitted either.
- **Proven-pre-effect-transient**: no external effect occurred. The identical
  approved intent may retry automatically once the blocking condition clears.

Proposed classification (`terminal=null` in every row; none of this is
canonical yet):

| Case | Class | Attempt | Proposed next action |
| --- | --- | --- | --- |
| Relay quote expired before any request/signature | proven-pre-effect-transient | none | `refresh-after-readmission` |
| Solana blockhash expired past its validity boundary | effect-ambiguous | `BROADCAST` | `reconcile-then-replace` |
| Wallet lease/fencing token lost **before** the provider/signature capability boundary | proven-pre-effect-transient | `NOT_SENT` | `retry-same-request-under-new-lease` |
| Wallet lease/fencing token lost **after** the capability boundary was reached | effect-ambiguous | `SENT_UNKNOWN` | `reconcile-before-retry` |
| External signer denial provable before any signature could exist | proven-pre-effect-transient | `NOT_SENT` | `retry-after-signer-readiness` |
| External signer timeout, or any outcome that cannot prove no signature was returned | effect-ambiguous | `NOT_SENT` | `reconcile-before-retry` |

The lease and signer rows each split what is a single matrix cell today
because a provable pre-effect case and a genuinely ambiguous case do not share
one safe recovery tuple: retrying automatically after the capability boundary
was reached, or after a timeout that cannot prove no signature exists, risks a
duplicate provider mutation or a second signature for the same request.

Quote refresh happens at the policy/admission boundary, not as a stage-local
quote swap, and only after proving no signed or broadcast attempt exists for
the same claimed principal; a quote is never silently substituted once signed
bytes exist. Solana replacement happens only behind an authoritative
expired-and-unlanded resolution recorded against the old attempt, creates
exactly one linked replacement, and retains the original signed bytes and
signature forever. Lost-lease and signer retries in the proven-pre-effect rows
reuse the identical prepared request digest; a stale fenced owner performs no
effect after fence failure, and CAS/fencing prevents it from overwriting a
newer attempt. The signer-unavailable reason is durable, redacted, and
UI-visible after restart, distinct from the scheduler's current generic
`TICK_FAILED` outage-backoff reason.

## Alternatives

### Restore all four revision-65 whole-cycle holds unchanged

Rejected: reimposes a per-cycle manual stop for conditions that provably had
no effect or remain merely ambiguous, not wrong, conflicting with the goal of
unattended bounded recovery for the accepted launch target.

### Reuse ADR-0024's held-position carve-out for these four failures

Rejected: these are whole-cycle transaction/lifecycle safety conditions, not
card-level holds; the target for them is bounded automatic recovery of the
whole cycle's own attempt, not a supplementary per-card settlement path.
Keeping them as a distinct three-class taxonomy avoids conflating "this
specific card should return value independently" with "this transient
condition should stop blocking the whole cycle automatically."

### Give the lease and signer cases one shared retryable tuple regardless of timing

Rejected: a retry after the capability boundary, or after a timeout that
cannot prove no signature was returned, could create a duplicate provider
mutation or a second valid signature for the same request. The evidence
condition, not convenience, must determine the tuple.

## Consequences

`docs/audit/2026-09-04/failure-matrix.json` is unchanged by this ADR. The
proposed six-row tuple set lives in
`docs/audit/2026-09-04/failure-matrix-revision-66-transient-proposal-DRAFT.json`
until each row has its runtime change and an exact passing test citation.
`docs/runbooks/relay-quote-expired.md`, `solana-blockhash-expiry.md`,
`lease-expiry-mid-mutation.md`, and `keychain-user-interaction.md` each carry
a "Proposed revision 66" section citing that draft file and this ADR; their
existing bodies still describe the current, implemented revision-65 behavior
and must not be read as already changed. No runtime, stage-driver, scheduler,
or test change is made by this ADR. Suggested disjoint implementation
ownership after approval: policy/admission plus quote-refresh repository
transition; return/Solana expired-attempt resolution and replacement;
stage-driver lease/signer boundary classification for both the pre- and
post-capability cases; scheduler/status projection; then one serial
failure-matrix/runbook integration owner who promotes rows out of the draft
file one at a time as their tests pass.
