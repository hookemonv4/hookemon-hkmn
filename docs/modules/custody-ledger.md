# Custody Ledger Projection

## Purpose

`projectPolicyCustody` in `packages/adapters/src/app/accounting-projection.mjs` projects the durable
per-cycle custody ledgers into the policy engine's USDG loss and outstanding-custody controls.

## Public interface

- `projectPolicyCustody({cycleRepository, evmUsdg})` reads every active and archived cycle.
- It returns realized loss, at-risk loss, outstanding USDG custody, held and unattributed flags,
  an unvalued-exposure flag, and one partitioned summary per cycle.
- The Phase 3 custody contract records `verifiedCurrentBalance` as a finalized observed on-chain
  typed amount, obligations separately, expected cycle assets, and unattributed external deposits.

## Invariants

- Values stay in atomic units. The projection never prices or converts a foreign asset to USDG.
- EVM USDG outstanding custody contains unresolved `claimed - returnReceived` principal exactly
  once, plus that cycle's residual, payout liability, dust, and refunds. Verified current balances
  never substitute for obligations, and one cycle's return never offsets another cycle's claim.
- Foreign cumulative lifecycle flows do not remain unvalued after settlement. A foreign current
  balance in residual, payout liability, dust, refunds, held assets, or unattributed custody marks
  the projection unvalued until it is reconciled or classified.
- Held or unattributed value on any ledger is visible to policy even when the ledger is foreign.
- Expected cycle assets are cycle-attributed typed amounts. Unattributed external deposits remain
  outside expected assets and pause new claims until reconciled or classified.

## State transitions

The projection is read-only. A completed cycle's unresolved EVM USDG claim becomes realized loss;
the same unresolved amount on any other cycle remains at risk and outstanding custody. Finalized
observations update verified balances without changing the one-time principal obligation.

## Operational commands

```sh
node --test packages/adapters/test/app/accounting-projection.test.mjs
```

## Recovery pointers

- Record an attributed ledger update before relying on a balance to permit a new claim.
- Treat an unvalued asset, missing USDG identity, or unknown quarantine representation as a pause
  condition until the underlying custody data is classified.
