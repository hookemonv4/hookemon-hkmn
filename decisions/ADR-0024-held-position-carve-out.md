# ADR-0024: Carve held cards into attributed positions

## Status

Proposed. Drafted for requirements revision 66. This decision grants no deployment,
credential use, signing, broadcast, asset movement, spending, or publication
authority, and is not itself an owner approval of revision 66 — that remains
true regardless of approval state. Formal approval of the exact revision-66
`specs/requirements.json` bytes is the `S5` item defined in `gates/spec.json`,
evidenced solely by a `decisions/owner-approvals/*` receipt bound to that
exact current hash; check that directory and `gates/runs/spec.json` directly
for the current state rather than inferring it from this document. This ADR
does not itself grant or record that approval.

## Context

Revision 65's `REQ-epic-gate-1` reads "In v1, a held card blocks new claims,"
and the frozen `docs/audit/2026-09-04/failure-matrix.json` matches that text
by holding an unresolved card's whole cycle. That contradicts what the
runtime at this exact head already does: `recordHeldPosition` in
`packages/adapters/src/app/cycle-repository.mjs` (around lines 3725-3772)
carves a card into its own attributed position without terminally holding the
cycle; a completed cycle already retains open positions for supplementary
recovery (around lines 3384-3394 and 3583-3602); and a `sell` decision already
creates one position-keyed supplementary settlement atomically (around lines
3818-3851). The three changed and eight new cells this revision adds to the
failure matrix cite real, currently-passing tests for that behavior (see the
matrix file itself for the exact test names).

This revision's purpose is therefore primarily to bring the frozen
`specs/requirements.json` and failure matrix into agreement with runtime
behavior that the project has already built and tested, so that a held or
unknown card is documented as separated from the settled portion, bound to
its original snapshot and operation, and later paid to original holders
without blocking valid sales — not to propose new runtime behavior for this
part. The genuinely unimplemented follow-up work is narrower: production
observation-only provider reconciliation for an overdue `SENT_UNKNOWN`
position, and automatic supplementary intent (see the two `OPEN FACT`
citations already present in the matrix for those specific gaps).

## Decision

Each held or unresolved card is an attributed held position with its
original cycle and pack, card evidence, purchase-cost share, typed insured
value when verified, reason, and durable owner decision and resolution
fields. The settled cards continue through return and payout. A cycle can
reach `COMPLETED` while positions remain open, including a zero-proceeds
`COMPLETED` result when all cards are held. A completed record remains
available for supplementary recovery until its held positions resolve.
Scheduling skips that record when selecting a new cycle, but it remains an
active DurableCycleStore entry until archival.

New claims continue unless open positions reach the configured count limit or
exceed the configured value limit (`HELD_LIMIT`). Unattributed or unvalued
custody remains fail-closed. A provider mutation that stays `SENT_UNKNOWN`
beyond the configured reconciliation deadline becomes a position, and later
repository evidence can record whether it was sold, refunded, or never sent.
Production observation-only reconciliation and automatic supplementary intent
remain follow-up work (see the two `OPEN FACT` citations in
`docs/audit/2026-09-04/failure-matrix.json`, which name exactly this gap and
nothing broader).

The limit uses an insured value only when it is already configured as USDG. A
typed Solana stablecoin insured value remains evidence and falls back to
attributed purchase cost because no frozen conversion quote is bound to it.

`maxHeldPositions` is capped at 10, the verified capacity-safe value for the
16-entry DurableCycleStore when positions span completed cycles. A
configuration above 10 has no verified new-cycle capacity guarantee — values
at or above 16 can exhaust the store — so it is refused at admission until
post-completion position archival or a measured store-capacity exemption is
implemented. This is a hard requirement boundary, not merely an
implementation note: unattended operation must not knowingly accept a
configuration that can strand active completed records.

The first `sell` decision accepted for one position atomically creates
exactly one supplementary settlement, keyed by that position's ID. An exact
replay of that same request (e.g. after a lost response) returns the
identical settlement; a conflicting or later `sell` request for an
already-settled or in-flight position fails; and a resolved position
(`SOLD`, `REFUNDED`, or `NEVER_SENT`) can never create another settlement.
The finalized position return and any permitted dust source are bound to one
atomic, position-aware consumption record shared by every supplementary
manifest for that position, so at most one supplementary manifest can ever be
funded per held position and per return source — never per manifest ID alone,
since `<cycleId>:supplementary:<n>` by itself does not bound `n` to one
attempt. `keep-holding` is repeatable without settlement and has no
settlement effect.

The operator projection shows positions and limit usage. The public
projection shows only count, reason class, age, and cycle state.

This decision preserves every semantic-invalid whole-cycle class exactly as
today and the card-level carve-out never applies to any of them: a
wrong-asset or wrong-recipient transaction-policy refusal, a cross-cycle
attribution failure, conflicting canonical evidence, an unattributed deposit,
missing predecessor evidence, or a snapshot failure remain terminal
whole-cycle `HELD_*` states with an owner decision, matching the unchanged
`Transaction policy:wrong-asset` and `Transaction policy:wrong-recipient`
matrix cells. See ADR-0025 for the separate transient-recovery classification
for expired quote/blockhash, lost lease, and signer denial/timeout, which
also does not touch any of these semantic-invalid classes.

## Alternatives

### Keep the whole-cycle hold as the documented contract

Rejected: it already disagrees with the deployed and tested runtime behavior
at this head, and a held card would keep stalling payouts for settled cards
in the documented contract even though the code no longer does that.

### Fully parallel cycles with per-cycle Solana sub-wallets

Rejected for this revision: a larger change than reconciling the spec with
already-built behavior requires. Deferred until after the first mainnet
cycles; this decision preserves per-card attribution inside the existing
Operations-wallet custody model.

## Consequences

The repository, custody ledger, policy engine, stages, payout planner,
dashboard, and operator controls must keep using the same held-position
authority records this ADR describes. No held-position bucket may fund a
different cycle. Recovery reuses durable attempts and never sends a provider
mutation again merely because a process restarted. This ADR does not itself
authorize anything; treat `specs/requirements.json` revision 66, the failure
matrix, and the runbooks as authoritative only once a
`decisions/owner-approvals/*` receipt approves this exact requirements hash
under the `S5` item in `gates/spec.json`.
