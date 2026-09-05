# ADR-0020: Manual repeatable peg cycles

## Status

Accepted by the owner on 1 September 2026 for local Phase 2 implementation. This decision grants no deployment, credential, signing, broadcast, asset-movement, spending, publication, or production authority.

## Context

Phase 1 proves one manually controlled cycle and treats `PegCycleVault.FAILED` as absorbing because a shared return balance cannot safely distinguish a delayed return from an earlier failed cycle. The owner wants the same interrupted cycle to resume, but wants a new cycle to be possible after an evidenced terminal failure. The owner also wants manual pack and money-parameter control without a dashboard, scheduler, database, automatic strategy, or concurrent orchestration.

Reopening the same shared token balance after failure is unsafe. A delayed return for cycle A can arrive after cycle B starts and satisfy or contaminate B's balance checks.

## Decision

Keep one immutable hook-bound `PegCycleVault` as the authorization coordinator and permit at most one active cycle. Give every cycle a deterministic immutable `PegCycleReturnEscrow` deployed with `CREATE2`. Funding, outbound return, and payout for that cycle use only its escrow. A terminal failure closes that cycle and quarantines its escrow. The authorizer may bind one successor only through the exact failed cycle identifier and its stored failure receipt digest. The successor requires a fresh cycle identifier and nonce and therefore receives a different escrow.

The local operator imports one exact pack snapshot, manually selects one pack, edits the existing money parameters only in draft state, and freezes one canonical plan before start. Quantity remains one and turbo mode remains disabled. Crash recovery reconstructs the same cycle and journal, and an unresolved external attempt must reconcile before progress. No blind retry or same-cycle replacement is allowed.

Allow permissionless deletion of an expired, unfunded pending authorization while keeping its identifier, nonce, and escrow consumed. To avoid stranding same-cycle funds, allow the immutable authorizer to renew a `FUNDED` outbound deadline or `RETURNED` payout deadline with a fresh nonce only when every other frozen field is identical. Renewal performs no external action and never bypasses unresolved-intent reconciliation.

## Supersession

This ADR supersedes only ADR-0019's shared-vault return destination and absorbing global-failure restriction. ADR-0019's immutable custody, exact authorization, trigger-only Operations role, typed route executor, payout conservation, and provider-boundary decisions remain in force.

This ADR also opens only the manual pack-selection and local operator-control portion deferred by ADR-0018. ADR-0018's deferral of dashboards, scheduling, unattended operation, catalog persistence, route optimization, multi-pack execution, and concurrency remains in force.

## Consequences

- A failed cycle no longer blocks all future cycles.
- Late or unsolicited funds remain isolated in the escrow that received them and cannot become another cycle's proceeds.
- Historical terminal evidence is keyed by cycle identifier rather than represented only by one mutable global digest.
- Draft selection remains reversible, while a frozen plan remains immutable.
- The implementation needs one small escrow contract and one local JSON controller, but no factory service, database, scheduler, or UI.
- An expired `FUNDED` or `RETURNED` authorization can regain liveness only through exact-subject authorizer renewal with a fresh nonce.

## Alternatives

### Reopen the same vault after failure

Rejected because a delayed return can cross cycle boundaries and contaminate a later payout.

### Add per-cycle accounting inside one shared vault

Rejected because ERC-20 transfers do not carry a cycle identifier. Safe attribution would require a larger verified callback or routing protocol and would still retain a shared-balance failure surface.

### Deploy a full cycle factory and allow concurrency

Rejected because one active coordinator plus isolated escrows meets the requirement without lease management, concurrent budgets, or scheduler policy.

### Build a dashboard and automatic pack strategy first

Rejected because neither is needed for manual selection, exact freeze, recovery, or failure isolation.
