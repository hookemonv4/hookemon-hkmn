# ADR-0019: Immutable peg-cycle custody

## Status

Accepted by the owner on 1 September 2026.

## Context

Revision 55 allowed Operations to receive process principal and later fund the payout. That creates Operations custody after release and does not satisfy the approved immutable peg-cycle design.

## Decision

The hook may debit process liability only while atomically funding its immutable, mutually bound `PegCycleVault`. Operations remains a trigger only; it never receives, routes, returns, funds, withdraws, or approves process principal or returned proceeds. The vault uses one sequential lifecycle and permits only narrow typed, feasibility-bound route operations. Exact attributable returned USDG is transferred from the vault to the hook only while atomically recording one sum-bound payout liability.

Operations retains two-step rotation for future trigger authority. The immutable authorization identity remains separate from Operations and is single-use and exact. Robinhood Programmable launch and admission facts remain `INTEGRATION_PENDING`.

## Supersession

This ADR supersedes only the Operations-custody portions of ADR-0011, ADR-0013, ADR-0015, and ADR-0018. Their fee conservation, deferred dashboard, fixed manual-cycle, provider-binding, and unrelated authority decisions remain in force.

## Consequences

The hook and `PegCycleVault` must be deployed as one immutable composition. Future tasks replace Operations-directed release and Operations-funded payout assumptions with vault-only funding and return attribution. Legacy Programmable material remains comparison evidence only.
