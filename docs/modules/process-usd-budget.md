# Process USD claim budget

## Purpose

The managed bot limits native ETH process claims using authenticated USD valuations. The owner-controlled `processClaimLimit6hMicroUsd` setting defaults to `25000000000` (USD25,000), accepts zero to pause, and cannot exceed `50000000000` (USD50,000). Its existing operator configuration patch route changes the limit; balance growth never raises it. Historical native configuration without the field migrates to the default.

## Public interface

`CycleRepository.reserveProcessUsdClaim(cycleId, { hook, amountWei, limitMicroUsd })` checks the immutable admission's exact native amount, hook, fresh durable Relay valuation, and upward USD rounding. It atomically reserves against one global chain-and-hook budget before signing and rechecks before broadcasting. `finalizeProcessUsdClaim(cycleId, { hook, proof })` accepts a process-authenticated native claim payment proof or a reverted transaction gas proof bound to the persisted claim attempt and custody ledger. The stage driver exposes finalization through its lease-fenced reconciliation facade.

## Invariants

ETH liabilities and payments remain wei. Confirmed USD debits retain their original valuation and count while `now - blockTimestamp < 21600000` milliseconds. Equality expires the debit. Unresolved reservations count regardless of age, restart, wallet rotation, or archival. A lower limit does not clear history; zero prevents a first send even when the cycle already has a reservation. Global compare-and-swap prevents competing writers from admitting excess value. Retries cannot change amount, valuation, or finalized outcome.

The USD guarantee covers the managed bot path, as accepted by the owner. The contract retains its separate wei cap. This control does not introduce an onchain USD oracle and cannot constrain direct calls made outside the bot with Operations credentials. Limit changes use the existing offchain configuration semantics; the contract's delayed wei-limit controls remain separate.

## State transitions

A fresh admission becomes `RESERVED` before signing. Only verified finalized success changes it to `CONFIRMED`, timestamped from the transaction's block. Verified finalized revert changes it to `REVERTED`, releasing its debit. Missing, stale, conflicting, fabricated, or unavailable evidence leaves capacity reserved and refuses further effects. Unsent reservations also remain conservative; there is no automatic timeout release.

## Operational commands

Read and update `processClaimLimit6hMicroUsd` through the existing authenticated operator configuration route. Values are integer microUSD strings: `25000000000`, `50000000000`, or `0`. Existing per-cycle and 24-hour limits still apply independently. Run focused checks with `node --test packages/adapters/test/native/process-usd-claims.test.mjs packages/adapters/test/app/claim-process.test.mjs packages/adapters/test/app/stage-driver.test.mjs packages/runner/test/config/state-schema.test.mjs`.

## Recovery pointers

Keep the durable state directory. Restart restores quote provenance only while the original quote remains fresh and retains unresolved USD reservations. Reconcile persisted signed bytes rather than creating a replacement cycle or price. A pre-upgrade in-flight claim without a USD reservation refuses finalization through this path; its state requires explicit reviewed recovery, not a fabricated valuation or a new empty budget. See [Cycle repository](cycle-repository.md) and [Operator controls](operator-controls.md).
