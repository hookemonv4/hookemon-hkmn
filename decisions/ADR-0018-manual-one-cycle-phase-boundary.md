# ADR-0018: Manual one-cycle Phase 1 boundary

## Status

Accepted by the owner on 31 August 2026.

## Context

ADR-0013 put one real fixed Collector cycle and a minimal read-only dashboard in Phase 1 while leaving broader automation for later. The owner subsequently approved a narrower first release: prove the complete money path with one capped, manually started and fully reconciled cycle, without making any dashboard, UI, scheduler, continuous operation, catalog persistence, route optimization, or multi-pack behavior a Phase 1 obligation.

This decision supersedes only ADR-0013's dashboard and automation boundary. ADR-0013's fixed Collector pack path and all immutable money, proof, role, custody, provider-binding, and successor decisions remain authoritative. ADR-0017 remains unchanged.

## Decision

- Keep the immutable money kernel, fixed HKMN supply, official provider bindings, exact inclusive fee formulas, single-use process release, sum-bound payout, permissionless at-most-once payment, zero static LP fee, and permanent non-project-controlled launch-position custody unchanged.
- Keep one manually started one-shot runner and one continuous receipt chain for the fixed Robinhood-USDG-to-Solana-USD Coin route, one operator-selected standard non-turbo Collector pack purchase and open, one finalized standard buyback, the fixed Solana-USD Coin-to-Robinhood-USDG return, exact payout funding from attributable returned USDG, at least one holder payment, and final reconciliation.
- Defer every public or operator dashboard, OpenUI or other user interface, scheduler, continuous or unattended operation, catalog persistence or refresh, route discovery or optimization, automatic pack selection, multi-pack execution, and concurrent-cycle behavior to a fresh Phase 2 specification.
- Remove `REQ-dashboard-1` from the active requirements array and permanently reserve that ID. It cannot identify a new requirement or an active Phase 1 obligation.
- Use contract reads, events, receipts, canonical manifest bytes, and entitlement state as the Phase 1 verification sources. A dashboard projection is neither required nor valid live evidence.
- Preserve the separately authorized and capped live-canary boundary. This ADR authorizes no deployment, signature, broadcast, bridge transfer, marketplace mutation, credential access, or spend.

## Alternatives

### Keep the minimal read-only dashboard in Phase 1

Pros:

- A public page could make the canary easier to inspect.

Cons:

- It adds a release dependency that is not needed to execute, fund, verify, claim, or reconcile the money path.
- It delays the narrow canary without strengthening immutable safety.

Rejected: the owner approved the manual one-cycle scope and deferred dashboard and UI work to Phase 2.

### Defer the external Collector cycle together with the dashboard

Pros:

- Phase 1 would contain only the onchain kernel and local evidence.

Cons:

- It would not prove the fixed outbound conversion, pack purchase and open, buyback, return conversion, payout funding, and holder payment as one receipt chain.

Rejected: the owner retained the complete fixed cross-chain Collector money path in Phase 1.

### Add scheduling and continuous operation to the manual runner

Pros:

- Repeated cycles could run without an operator starting each one.

Cons:

- Standing automation expands authority, restart, catalog, and uncertain-external-state requirements before one bounded cycle has been proven.

Rejected: Phase 1 is one manually started, capped and fully reconciled cycle, not an unattended service.

### Add catalog persistence, route optimization, or multi-pack strategy support

Pros:

- The runner could select among more packs and routes.

Cons:

- These capabilities expand selection policy and mutable infrastructure beyond the fixed canary path.

Rejected: the operator selects one current pack and freezes one fixed outbound and return route into the cycle authorization.

## Consequences

- Phase 1 has one fewer product obligation while preserving its production-shaped manual canary.
- P1-009, the accepted manual subset of P1-010, and P1-012 remain required; only the dashboard task P1-011 moves out of Phase 1.
- The local or fork proof and the separately authorized capped live receipt chain end in contract, receipt, manifest, and entitlement reconciliation rather than dashboard verification.
- Phase 2 may add reversible product surfaces and automation only under a fresh requirements revision and owner approval, without weakening historical liabilities, custody, payout conservation, or at-most-once external actions.
