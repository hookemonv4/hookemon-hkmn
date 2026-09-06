# ADR-0024: Carve held cards into attributed positions

## Status

PROPOSED_PENDING_OWNER_APPROVAL. Drafted for requirements revision 66. This
decision grants no deployment, credential use, signing, broadcast, asset
movement, spending, or publication authority, and is not itself an owner
approval of revision 66.

## Context

A held card currently puts its entire cycle into a terminal whole-cycle hold
(`REQ-epic-gate-1` at revision 65: "In v1, a held card blocks new claims.").
That stalls the already-settled proceeds of the same cycle behind one slow
card. `authoritative-launch-handoff.md:197-201` requires a held or unknown
card to be separated from the settled portion, bound to its original snapshot
and operation, and later paid to original holders without blocking valid
sales; `:283` makes the N=2 sale/held split, return, and finalized holder
payout an acceptance requirement. The frozen revision-65 failure matrix and
`specs/requirements.json` contradict that accepted target and must be revised
before it can become the conformance authority.

## Decision

Each held or unresolved card becomes an attributed held position with its
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
remain follow-up work (see the OPEN FACT citations in
`docs/audit/2026-09-04/failure-matrix.json`).

The limit uses an insured value only when it is already configured as USDG. A
typed Solana stablecoin insured value remains evidence and falls back to
attributed purchase cost because no frozen conversion quote is bound to it.

The default `maxHeldPositions: 10` is capacity-safe for the 16-entry
DurableCycleStore when positions span completed cycles. Values above 10 have
no verified new-cycle capacity guarantee, and values at or above 16 can
exhaust the store until post-completion position archival or a
store-capacity exemption is added.

An owner decision addresses one position and binds its evidence digest and
revision. `keep-holding` is repeatable without settlement. `sell` starts a
supplementary buyback, return, and payout for that position only, reusing the
original frozen eligibility snapshot and using a new immutable manifest after
its first broadcast.

The operator projection shows positions and limit usage. The public
projection shows only count, reason class, age, and cycle state.

This decision retains whole-cycle holds for failures that make a cycle
unattributable: unattributed deposits, missing predecessor evidence, and
snapshot failure. The unrelated wrong-asset and wrong-recipient
transaction-policy holds are semantic-invalid requests and are unchanged by
this decision; see ADR-0025 for the separate transient-recovery
classification that also does not touch them.

## Alternatives

### Keep the whole-cycle hold

Rejected: one held card stalls payouts for settled cards, conflicting with
`authoritative-launch-handoff.md:197-201,283`.

### Fully parallel cycles with per-cycle Solana sub-wallets

Rejected for this revision: a larger change than the accepted target requires
right now. Deferred until after the first mainnet cycles; this decision
preserves per-card attribution inside the existing Operations-wallet custody
model.

## Consequences

The repository, custody ledger, policy engine, stages, payout planner,
dashboard, and operator controls must use the same held-position authority
records once implemented. No held-position bucket may fund a different cycle.
Recovery reuses durable attempts and never sends a provider mutation again
merely because a process restarted. This ADR does not authorize
implementation by itself; `specs/requirements.json` revision 66, the matrix,
and the runbooks are a proposal pending the S5 owner-approval procedure in
`spec-approval-protocol.md`.
