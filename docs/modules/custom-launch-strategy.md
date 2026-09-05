# Custom Launch Strategy

## Purpose

Custom Launch Strategy is frozen compatibility source from an earlier launch design. Phase 3 replaces it with the single authorized atomic launch leg owned by Launch Orchestration, so it has no deployment-manifest entry or live authority.

The retained compatibility evidence includes `packages/contracts/test/launch/vendor/RealLauncherFactoryComposition.t.sol`. It imports the vendored `LiquidityLauncher` and `UERC20Factory` sources and proves the earlier `multicall([createToken, distributeToken])` composition, including CREATE2 prediction, full-supply transfer, allowance consumption, and callback salt. The test does not seed a Uniswap v4 position and does not establish Phase 3 launch authority.

## Public interface

No Custom Launch Strategy operation participates in the Phase 3 deployed interface. Launch Orchestration performs the one-time hook-self initialization, position mint and settlement, permanent custody binding, and launch stamp.

## Invariants

- The frozen source is excluded by the content-addressed deployment manifest.
- It cannot issue a token, initialize a pool, mint liquidity, approve an allowance, or hold a launch position in Phase 3.
- The Phase 3 launch path permits hook-self initialization only inside the authorized wallet transaction and reverts the whole transaction on any failed substep.
- The retained composition test verifies compatibility source only; it cannot make the frozen path deployable.
- Restoring this source requires a new approved architecture, deployment-manifest revision, and feasibility evidence.

## State transitions

The module has no Phase 3 runtime state transition. Any attempted deployment or runtime reference fails deployment-manifest validation.

## Operational commands

- Verify that the deployment manifest excludes this module and that launch evidence names Launch Orchestration as the only launch authority.
- `FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/launch/vendor/RealLauncherFactoryComposition.t.sol' -vvv` runs the retained launcher/factory composition test.
- `packages/contracts/remappings.txt` scopes the factory's `@openzeppelin/` imports to `lib/uerc20-factory/lib/openzeppelin-contracts/` and its `@solady/` imports to `lib/uerc20-factory/lib/solady/`. This leaves v4-core's OpenZeppelin mapping intact for other package imports. Root `foundry.toml` and `remappings.txt` carry the unscoped mappings required by the Programmable scanner.

## Recovery pointers

- Treat a manifest entry or caller path to this source as a release-integrity failure.
- Do not use a frozen launch path to recover a failed atomic launch.
- Correct the launch inputs and retry only a transaction that has not completed its one-time launch stamp.
- If the composition test cannot resolve the factory's nested dependencies, initialize the vendored factory's OpenZeppelin and Solady submodules and confirm the package-scoped entries with `forge remappings --root packages/contracts`.
