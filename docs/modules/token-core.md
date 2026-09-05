# Token Core

## Purpose

Token Core defines the immutable Phase 3 HKMN target and its complete canonical-market allocation. It covers requirements revision 65. Historical issuance sources remain in the repository only to reproduce Phase 1 evidence; they are not Phase 3 token targets.

## Public interface

- `packages/contracts/src/launch/HKMNToken.sol` deploys a fixed supply of `1_000_000_000 * 10^18` HKMN. It accepts only 18 decimals and the graph factory as its issuance authority.
- `HKMNToken.allocate(address canonicalMarket)` is callable once by the issuance authority after graph deployment. It transfers the full supply from the token contract to the canonical-market hook and emits `AllocationCompleted`.
- `MARKET_ALLOCATION_BPS` is `10_000`. The token exposes no remainder-custody argument or allocation path.
- `validateGraphConfiguration(...)` and `validateIssuedAllocation(...)` prove the expected USDG, price, issuance authority, decimals, canonical market, complete supply, and zero token-contract balance to `HookemonHook`.
- Ordinary ERC-20 `transfer`, `approve`, and `transferFrom` operations are available after allocation. The token has no privileged mint, burn, confiscation, pause, upgrade, rescue, or balance-adjustment operation.
- `HookemonHook.initializeGraphLaunch(...)` checks the allocation before pool initialization. Its graph-mode `seedCanonicalLiquidity(SeedParams)` accepts the full HKMN balance and 240 USDG for the exact release tuple, then requires the hook's HKMN balance to be zero.
- `PermanentPositionCustody` binds the minted LP position only. It does not custody a second HKMN balance or expose a release path for one.

## Invariants

- Name and symbol are exactly Hookemon and HKMN. Supply is exactly 1,000,000,000 HKMN at 18 decimals.
- Allocation occurs exactly once, transfers 100 percent of the supply to the canonical-market hook, and leaves zero HKMN in the token contract. No treasury, custody, or other allocation receives HKMN at issuance.
- Only the configured graph factory can allocate. Allocation rejects an empty, zero, or non-contract canonical-market target.
- The graph validates allocation, custody binding, USDG, launch price, and 18-decimal supply before it initializes the canonical pool. Invalid or reordered graph calls revert.
- The Phase 3 graph seed either consumes the complete HKMN allocation into the LP position or reverts. It cannot transfer a graph-mode residual to treasury or a non-circulating account.
- Historical `HookemonIssuance` and retained strategy sources do not change the concrete Phase 3 supply, allocation, or graph target set.

## State transitions

- Deployment mints the complete supply to the token contract.
- The one authorized allocation moves the complete supply to the canonical-market hook and permanently marks the token allocated.
- The graph initializes the pool after allocation. A successful later seed moves the complete hook balance into the custody-bound LP position; a failed seed preserves the completed allocation and permits a retry.

## Operational commands

```sh
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/launch/LaunchComposition.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/release/PhaseThreeReleasePlan.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/blind/token-roles/FixedSupplyPrep.t.sol' -vv
node scripts/verify-phase1-release.mjs
```

## Recovery pointers

- Reject a graph whose token selector, recipient, amount, USDG, price, issuance authority, decimals, or custody binding differs from the frozen release inputs.
- Rebuild release evidence after a token or hook source change; do not alter the fixed-supply or allocation invariants to fit a stale artifact.
- The only pending graph input is the provider-supplied launch-intent preimage: route namespace, route nonce, topology hash, target-id hashes, and serialized call data. Retain the non-signing local draft until those values are bound.
- Do not add minting, upgradeability, a second allocation recipient, a treasury allocation, or a non-circulating custody balance.
