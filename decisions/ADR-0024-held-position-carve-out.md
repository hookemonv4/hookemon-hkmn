# ADR-0024: Carve held cards into attributed positions

## Status

Accepted by owner decision dated 2026-09-05. Requirements revision 66 retains architecture
revision 9. This decision grants no deployment, credential use, signing, broadcast, asset
movement, spending, or publication authority.

## Context

A held card previously put its entire cycle into a terminal hold. That stranded the already-settled
proceeds with one slow card and prevented later claim processing. A card-level recovery path needs
to preserve attribution, evidence, and custody isolation without delaying the settled portion of a
cycle.

## Decision

Each held or unresolved card becomes an attributed held position with its original cycle and pack,
card evidence, purchase-cost share, typed insured value when verified, reason, and durable owner
decision and resolution fields. The settled cards continue through return and payout. A cycle can
reach `COMPLETED` while positions remain open, including a zero-proceeds `COMPLETED` result when
all cards are held. A completed record remains available for supplementary recovery until its held
positions resolve. Scheduling skips that record when selecting a new cycle, but it remains an
active DurableCycleStore entry until archival.

New claims continue unless open positions reach the configured count limit or exceed the configured
value limit. Unattributed or unvalued custody remains fail-closed. A provider mutation that stays
`SENT_UNKNOWN` beyond the configured reconciliation deadline becomes a position and later
repository evidence can record whether it was sold, refunded, or never sent. Production
observation-only reconciliation and automatic supplementary intent remain follow-up work.

The limit uses an insured value only when it is already configured as USDG. A typed Solana
stablecoin insured value remains evidence and falls back to attributed purchase cost because no
frozen conversion quote is bound to it.

The default `maxHeldPositions: 10` is capacity-safe for the 16-entry DurableCycleStore when
positions span completed cycles. Values above 10 have no verified new-cycle capacity guarantee, and
values at or above 16 can exhaust the store until post-completion position archival or a
store-capacity exemption is added.

An owner decision addresses one position and binds its evidence digest and revision. `keep-holding`
is repeatable without settlement. `sell` starts a supplementary buyback, return, and payout for
that position only. Its durable boundaries are `PREPARED`, `BUYBACK_SENT_UNKNOWN`,
`RETURN_BROADCAST`, `PAYOUT_BROADCAST`, and `COMPLETE`. The supplementary payout reuses the
original frozen eligibility snapshot and gets a new immutable manifest after its first broadcast.
Its return boundary binds the attributed USDG return with zero/null supplementary dust. A nonzero
normal-cycle dust record remains unavailable until a position-aware atomic consumption transition
exists.

The operator projection shows positions and limit usage. The public projection shows only count,
reason class, age, and cycle state.

This decision retains whole-cycle holds for failures that make a cycle unattributable: unattributed
deposits, missing predecessor evidence, and snapshot failure. Other cycle-wide safety gates remain
outside this card-level carve-out.

## Alternatives

### Whole-cycle hold

Rejected because one held card stalls payouts for settled cards.

### Fully parallel cycles with per-cycle Solana sub-wallets

Deferred until after the first mainnet cycles. The current decision preserves per-card attribution
inside the existing Operations-wallet custody model.

## Consequences

The repository, custody ledger, policy engine, stages, payout planner, dashboard, and operator
controls must use the same held-position authority records. No held-position bucket may fund a
different cycle. Recovery reuses durable attempts and never sends a provider mutation again merely
because a process restarted.
