# Canonical Market

## Purpose

The canonical-market module authenticates the one USDG/HKMN pool and presents an executed USDG observation as the gross quote-volume input to fee accounting. It owns the narrow hook initialization and swap callback boundary described by `REQ-canonical-market-1` through `REQ-canonical-market-7`.

## Public interface

`packages/contracts/src/market/CanonicalMarket.sol` defines the abstract `CanonicalMarketCallback` core. `packages/contracts/src/HookemonHook.sol` composes it directly with `FeeAccounting`, `MoneyRoles`, and `HookemonIssuance`.

- The deployed hook address carries permission mask `0x20CC`. The enabled permissions are `beforeInitialize`, `beforeSwap`, `afterSwap`, `beforeSwapReturnDelta`, and `afterSwapReturnDelta`; every other permission is disabled.
- `beforeInitialize` always reverts direct external initialization with `InitializationNotAuthorized`. `initializeCanonicalPool(uint160 sqrtPriceX96)` accepts only `launchAuthority`, constructs the complete zero-static-fee canonical key, calls the bound PoolManager from the hook, and can succeed once. `canonicalPoolInitialized` records completion.
- `beforeSwap` and `afterSwap` authenticate the bound PoolManager, complete PoolKey, callback sender and parameters, callback phase, finalized deltas, zero static LP fee, and zero protocol and live LP fees before accounting receives executed USDG volume.
- Callback state is `Idle`, `Pending`, or `Finalizing`. Nested callbacks, including same-pool recursion during fee collection, revert.
- The v4 signatures accept `hookData`, but its bytes are ignored and excluded from callback context. The kernel has no `CanonicalSwapHookData` decoder, router binding, operation ID, recipient attribution, or HKMN buyer-credit state. `CanonicalSwapObserved` records only the callback sender, executed USDG, and raw HKMN delta.
- Empty bytes, truncated payloads, and arbitrary byte sequences take the same authenticated callback path. Equivalent swaps produce the same PoolManager deltas, fee collection, accrued liabilities, remainders, and observable callback state; no stored field is derived from `hookData`.
- A full final delta is normalized for both token orders, both directions, and exact-input and exact-output swaps. `executedUsdg` is gross quote-side USDG. The inclusive USDG fee stays separate from that volume and is collected with `PoolManager.take` before the corresponding liabilities accrue.
- For exact output, the callback solves `gross - programmableIncrement(gross) - treasuryIncrement(gross) - processIncrement(gross) = requestedNet`, where `requestedNet` is the quote-side USDG amount before the hook fee. It rounds the nominal 3% gross estimate up, starts no lower than eight atomic units below that estimate, scans candidates upward through the bounded window, and returns the first equality. This avoids a later valid gross root when carried floor increments make the net function locally non-monotone.
- `HookemonHook.ConstructorConfig` binds the PoolManager, PositionManager, Permit2, USDG, HKMN, tick spacing, three money roles, launch authority, issuance authority, expected decimals, binding and runtime digests, three process-claim limits, and the Operations rotation delay. Its Programmable beneficiary must equal `RobinhoodBindings.PROGRAMMABLE_BENEFICIARY`. It contains no router or vault field.

## Invariants

- Only the complete authenticated canonical market can mutate fee accounting. A foreign manager, currency, fee, tick spacing, hook, pool identifier, callback stage, malformed delta, partial fill, or reentrant entry creates no liability.
- Currency ordering derives from bound token addresses, never display notation.
- Fee accounting consumes authenticated gross finalized USDG volume, never nominal, net-only, or unexecuted volume, and a rounded fee amount is never reused as executed volume.
- Exact-output gross-up centers an ascending scan on `ceil(requestedNet * 10,000 / 9,700)`. The 10/40/250-basis-point carried-floor streams each differ from their fractional share by less than one atomic unit, so the eight-unit window on either side of the estimate covers their combined rounding drift. The first root prevents collection against a higher valid gross quote.
- Exact output preserves the requested amount of its specified asset and reconciles quote-side `requestedNet` exactly. Collection equals the three current 10/40/250-basis-point carried increments, never falls below a stream's accumulated entitlement, and never selects a later valid gross root. Each stream differs from its fractional share by less than one atomic rounding unit, retained in its lifetime remainder instead of discarded or charged separately.
- Hook data cannot change callback validation, fee collection, liability accrual, or recipient-credit state.
- A positive executed USDG volume below 1,000 atomic units reverts the whole swap; exactly 1,000 is eligible for accounting.
- The canonical PoolKey has zero static LP fee. Nonzero protocol or live LP fee state rejects the swap. The inclusive cumulative-remainder Hookemon fee is the only canonical-route trading fee; gas is separate.
- Direct PoolManager initialization, second initialization, unsupported partial execution, and rejected callbacks leave pool initialization, observations, callback state, and liabilities unchanged.
- The permanently custodied position representing the 90 percent launch allocation has no transfer, approval, liquidity-decrease, withdrawal, fee-collection, rescue, upgrade, delegation, or project-controlled successor path. Custody cannot freeze a user balance or block a supported buy or sell.
- Construction accepts only the pinned Programmable beneficiary. On chain 4663, it also accepts only the bound Robinhood USDG address. PositionManager, Permit2, and launch authority are nonzero; the constructor's `processClaimLimit6h` value is no greater than the immutable 500000 USDG `processClaimLimitMax`; `processClaimMaxCount` is from 1 through 64; and `operationsRotationDelay` is the immutable 43200-second production value. The later `claimProcess` window is 21600 seconds.

## State transitions

- The pool moves from uninitialized to initialized only when `launchAuthority` invokes the one-shot hook self-initialization entry.
- A valid swap moves callback state from `Idle` to `Pending`, then `Finalizing`, and back to `Idle` after gross-volume authentication, fee collection, liability accrual, observation storage, and event emission succeed.
- Any rejected callback, failed collection, failed accounting transition, unauthorized initialization, or repeated initialization reverts atomically and preserves the preceding pool, liability, and callback state.

## Operational commands

```sh
forge fmt --check --root packages/contracts
forge test --root packages/contracts --match-path 'test/market/*.t.sol' -vvv
forge test --root packages/contracts --match-path test/integration/HookemonHook.t.sol -vv
```

`packages/contracts/test/market/CanonicalMarketCallbackSurface.t.sol` covers selectors, all eight callback quadrants, ignored hook data, context and PoolKey mutations, partial fills, reentrancy, fee-state rejection, and collection rollback. `packages/contracts/test/market/CanonicalMarket.t.sol` covers the real accounting composition, the 1,000-unit boundary, and carried-remainder exact-output roots. `packages/contracts/test/integration/HookemonHook.t.sol` derives gross USDG and fees from observed PoolManager, caller, and hook deltas across all eight quadrants before checking the hook record, and independently rejects every eligible smaller exact-output root. `packages/contracts/test/blind/market-fees/BlindCanonicalMarketAdapter.t.sol` independently mirrors fresh 10/40/250-basis-point streams to check every buy quadrant's first exact-output gross root and collected split. `packages/contracts/test/bindings/RobinhoodV4PoolManager.t.sol` covers the pinned local PoolManager across all eight quadrants and permanent custody.

## Recovery pointers

- Keep initialization and callback mutation unavailable when any market, launch-authority, or provider fact is unresolved.
- Repair the exact PoolKey, callback context, or binding evidence instead of accepting a partial match or adding a router-specific path.
- Reconcile exact-output failures from the observed gross, the three pre-swap remainders, and the requested net amount. Do not substitute a flat fee estimate or select a later gross root.
- Preserve every accrued liability if an accounting transition fails or an immutable successor is separately specified.
- Do not add an alternate initializer, partial-fill continuation, hook-data authority, position-control path, or second market domain as incident response.
