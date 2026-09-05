# Custody Ledger Projection

## Purpose

`projectPolicyCustody` in `packages/adapters/src/app/accounting-projection.mjs` projects the durable
per-cycle custody ledgers into the policy engine's USDG loss and outstanding-custody controls.

## Public interface

- `projectPolicyCustody({cycleRepository, evmUsdg})` reads every active and archived cycle.
- It returns realized loss, at-risk loss, outstanding USDG custody, held-position count and value,
  held and unattributed flags, an unvalued-exposure flag, and one partitioned summary per cycle.
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
- `heldPositions` is not a foreign currency balance. It is a per-card custody bucket whose open
  records carry an explicit USDG control value; the projection totals those records by position and
  does not infer a conversion from the ledger asset. An insured amount counts only when it is
  already typed as the configured USDG asset; otherwise the record value is the attributed purchase
  cost. A verified foreign insured value remains evidence, not a USDG valuation.
- Held or unattributed value on any ledger is visible to policy even when the ledger is foreign.
- Expected cycle assets are cycle-attributed typed amounts. Unattributed external deposits remain
  outside expected assets and pause new claims until reconciled or classified.

## State transitions

The projection is read-only. A completed cycle's unresolved EVM USDG claim becomes realized loss;
the same unresolved amount on any other cycle remains at risk and outstanding custody. Open held
positions remain in the count/value summary after their original cycle completes. Finalized
observations update verified balances without changing the one-time principal obligation.

## Operational commands

```sh
node --test packages/adapters/test/app/accounting-projection.test.mjs
```

## Recovery pointers

- Record an attributed ledger update before relying on a balance to permit a new claim.
- Treat an unvalued asset, missing USDG identity, or unknown quarantine representation as a pause
  condition until the underlying custody data is classified.
- Use the held-position count and value for the owner caps; do not revalue a foreign ledger bucket
  from its atomic amount. Until a frozen quote binding exists, do not turn a Collector Solana
  stablecoin insured amount into a USDG limit value.
