# Custody Ledger Projection

## Purpose

`projectPolicyCustody` in `packages/adapters/src/app/accounting-projection.mjs` projects the durable
per-cycle custody ledgers into the policy engine's USDG loss and outstanding-custody controls.

`packages/adapters/src/solana-custody-balance-observation.mjs` is a pure combiner that validates two
independently produced finalized-commitment read sides and, only after strict agreement, binds them
to a caller-supplied canonical `{chainId, assetId, decimals}` custody balance observation. It
imports no transport and performs no direct RPC itself, and it selects no chain/asset identity on
its own. It is a bounded validator/orchestrator only — not an identity source, not a durable
producer or writer, not a historical observer, not a valuation, and not a readiness proof. See
`product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md` (DRAFT, non-authoritative) for what
remains unresolved before any writer may treat its output as custody evidence.

## Public interface

- `projectPolicyCustody({cycleRepository, evmUsdg})` reads every active and archived cycle.
- It returns realized loss, at-risk loss, outstanding USDG custody, held and unattributed flags,
  an unvalued-exposure flag, and one partitioned summary per cycle.
- The Phase 3 custody contract records `verifiedCurrentBalance` as a finalized observed on-chain
  typed amount, obligations separately, expected cycle assets, and unattributed external deposits.
- `combineFinalizedBalanceObservation(sideA, sideB, { chainId, assetId, decimals, mint, owner, tokenProgramId, expectedGenesisHash? })` returns a frozen `{ account, balance: { chainId, assetId, decimals, amountAtomic }, finality: { height, hash, timestampUnixSeconds } }` or throws `SolanaCustodyObservationError`.
- `observeFinalizedBalanceWithRetry(readRound, request, { maxAttempts? })` invokes a caller-supplied `readRound(attempt)` up to `maxAttempts` bounded times (default 3), returning the first round that combines successfully, and throws `SolanaCustodyObservationError` after exhaustion. `readRound` is the helper's only I/O boundary: the helper itself imports no transport and never calls `fetch` or an RPC client directly, but the resulting observation still depends on whatever I/O the caller's `readRound` performs.
- `SolanaCustodyObservationError` is the sole thrown error type from the balance-observation helper.

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
- Both balance-observation read sides must be at `commitment: 'finalized'`; a lower commitment is rejected, never silently accepted.
- Both sides must report the same `context.slot` and the same non-empty `block.blockhash` and `block.blockTime` (including both `null`, never coerced to a timestamp).
- Both sides' token account `{address, mint, owner, tokenProgram, decimals, amountAtomic}` must agree with each other and with the caller-supplied expected `mint`/`owner`/`tokenProgramId`/canonical `decimals`.
- When `expectedGenesisHash` is supplied, both sides must report exactly that genesis hash.
- The returned balance observation's `chainId`/`assetId`/`decimals` are exactly the caller-supplied canonical values — this helper never selects `solana-mainnet` or Relay `792703809` itself.
- `minContextSlot` is out of scope for the balance-observation helper: it is the caller's read boundary's concern and is never treated here as pinning a historical slot.

## State transitions

The projection is read-only. A completed cycle's unresolved EVM USDG claim becomes realized loss;
the same unresolved amount on any other cycle remains at risk and outstanding custody. Finalized
observations update verified balances without changing the one-time principal obligation.

The balance-observation helper is stateless: each call is an independent pure validation, and
`observeFinalizedBalanceWithRetry` carries no state beyond its own bounded loop counter. It only
constructs evidence from already-read sides; it never produces or persists a balance itself.

## Operational commands

```sh
node --test packages/adapters/test/app/accounting-projection.test.mjs
```

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test test/solana-custody-balance-observation.test.mjs
```

## Recovery pointers

- Record an attributed ledger update before relying on a balance to permit a new claim.
- Treat an unvalued asset, missing USDG identity, or unknown quarantine representation as a pause
  condition until the underlying custody data is classified.
- A thrown `SolanaCustodyObservationError` from `observeFinalizedBalanceWithRetry` means no round
  agreed within `maxAttempts`; there is no partial or best-effort result to recover.
- The balance-observation helper has no durable state and nothing to reconcile after a crash: a
  restart simply re-runs `readRound` and re-validates from scratch.
- Fixture coverage for the balance-observation helper is in
  `packages/adapters/test/solana-custody-balance-observation.test.mjs`.
