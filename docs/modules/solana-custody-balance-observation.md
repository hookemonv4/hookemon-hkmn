# Solana Custody Balance Observation

## Purpose

`packages/adapters/src/solana-custody-balance-observation.mjs` is a pure, dependency-free combiner
that validates two independently produced finalized-commitment read sides and, only after strict
agreement, binds them to a caller-supplied canonical `{chainId, assetId, decimals}` custody
balance observation. It performs no RPC I/O, imports no transport, and selects no chain/asset
identity itself. See `product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md` (DRAFT,
non-authoritative) for what remains unresolved before any writer may treat its output as custody
evidence.

## Public interface

- `combineFinalizedBalanceObservation(sideA, sideB, { chainId, assetId, decimals, mint, owner, tokenProgramId, expectedGenesisHash? })` returns a frozen `{ account, balance: { chainId, assetId, decimals, amountAtomic }, finality: { height, hash, timestampUnixSeconds } }` or throws `SolanaCustodyObservationError`.
- `observeFinalizedBalanceWithRetry(readRound, request, { maxAttempts? })` calls a caller-supplied `readRound(attempt)` up to `maxAttempts` bounded times (default 3), returning the first round that combines successfully; it throws `SolanaCustodyObservationError` after exhaustion. `readRound` is the only I/O boundary — this module never calls `fetch` or an RPC client.
- `SolanaCustodyObservationError` is the sole thrown error type.

## Invariants

- Both read sides must be at `commitment: 'finalized'`; a lower commitment is rejected, never silently accepted.
- Both sides must report the same `context.slot` and the same non-empty `block.blockhash` and `block.blockTime` (including both `null`, never coerced to a timestamp).
- Both sides' token account `{address, mint, owner, tokenProgram, decimals, amountAtomic}` must agree with each other and with the caller-supplied expected `mint`/`owner`/`tokenProgramId`/canonical `decimals`.
- When `expectedGenesisHash` is supplied, both sides must report exactly that genesis hash.
- The returned observation's `chainId`/`assetId`/`decimals` are exactly the caller-supplied canonical values — this module never selects `solana-mainnet` or Relay `792703809`.
- `minContextSlot` is out of scope for this module: it is the caller's read boundary's concern and is never treated here as pinning a historical slot.

## State transitions

Stateless. Each call is an independent pure validation; `observeFinalizedBalanceWithRetry` has no
state beyond its own bounded loop counter.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test test/solana-custody-balance-observation.test.mjs
```

## Recovery pointers

- A thrown `SolanaCustodyObservationError` from `observeFinalizedBalanceWithRetry` means no round
  agreed within `maxAttempts`; there is no partial or best-effort result to recover.
- This module has no durable state and nothing to reconcile after a crash: a restart simply re-runs
  `readRound` and re-validates from scratch.
- Fixture coverage is in `packages/adapters/test/solana-custody-balance-observation.test.mjs`.
