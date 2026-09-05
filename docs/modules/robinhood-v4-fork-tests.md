# Robinhood V4 Fork Evidence

## Purpose

This module provides reproducible, non-skipping fork evidence for the Robinhood Chain v4 integration. `release/phase3/fork-pin.json` binds one finalized chain-4663 block to its header hash and the runtime hashes for PoolManager, PositionManager, Permit2, the USDG proxy and implementation, Universal Router, V4Quoter, and StateView. The archive suite deploys local test targets through the provider-shaped graph executor against that pinned runtime and exercises the deployed Universal Router and V4Quoter paths. It does not sign, broadcast, or spend outside the forked test state.

## Public interface

- `packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol` is the mandatory archive proof. It selects the block recorded in `fork-pin.json` with `vm.createSelectFork(vm.envString("ROBINHOOD_FORK_RPC_URL"), pinnedBlock)`. A missing, unreachable, or incompatible archive endpoint is a test failure; this suite never skips.
- `scripts/verify-fork-pin.mjs` independently reads `fork-pin.json`, verifies its check-only binding to the archive test constants, then verifies the pinned block header, chain ID, runtime bundle, and USDG implementation slot through `ROBINHOOD_FORK_RPC_URL`. Its current-head canary resolves `latest` once and uses that numeric block tag for every runtime read.
- `packages/contracts/test/integration/RobinhoodV4Fork.t.sol` and `RobinhoodV4ForkSmoke.t.sol` retain focused swap coverage. `LaunchLegFork.t.sol` verifies the graph launch and Permit2 seed path against the live configured runtime. When `ROBINHOOD_FORK_RPC_URL` is supplied, their fork setup must surface an endpoint or runtime problem as a failure rather than a skip.

## Invariants

- The pin is complete only when its exact block number and hash, chain ID, all seven top-level runtime entries, and the USDG implementation address and runtime hash agree with the archive RPC. The verifier rejects a mismatch between any pin scalar and the archive test constants before making an RPC request.
- The archive proof uses the real PoolManager, PositionManager, Permit2, USDG proxy, Universal Router, V4Quoter, and StateView recorded by the pin. It funds test accounts with Foundry cheatcodes, routes swaps through the real Universal Router rather than a direct PoolManager unlock, and checks StateView against PoolManager after launch and each route.
- V4Quoter quotes exact-input and exact-output swaps before each of the eight router fee quadrants: both directions, both orderings, and both exactness modes. Quotes must leave fee liabilities, hook callback state, PoolManager state, StateView, and token balances unchanged; the resulting quote is the router's minimum output or maximum input bound.
- Each fee route derives gross USDG and the fee from the PoolManager `Swap` event and USDG balance deltas for the trader, PoolManager, Universal Router, and hook. It independently checks each stream against `floor(cumulativeGross * bps / 10_000)`, checks the emitted cumulative remainders, and checks claims as exact liability and balance debits. A nondivisible split sequence includes intervening claims to prove that claims do not reset remainders.
- The archive suite separates router slippage rollback from a finite-liquidity partial fill. The latter reaches the hook's wrapped `InvalidFinalizedSwap` selector and restores balances, liabilities, slot state, liquidity, and StateView.
- The archive and LaunchLeg suites invoke the same `ProgrammableGraphHarness` used by `LaunchComposition.t.sol`. It deploys token, custody, then hook and makes exactly one raw initializer call per target: `HKMNToken.allocate(hook)`, `PermanentPositionCustody.configureBindingHook(hook)`, then `HookemonHook.initializeGraphLaunch(custody, price)`.
- The graph creates an 18-decimal HKMN token whose issuance authority is the graph factory. It allocates the full 1,000,000,000 HKMN supply to the hook and leaves no token remainder in custody. The hook validates that allocation before initializing the pool. The archive suite requires exact reverts for an unauthorized graph initializer, a wrong target order, and a replay after a successful launch. Permit2 liquidity seeding is a later step; it snapshots `PositionManager.nextTokenId()` immediately before minting and asserts that custody receives that exact position ID.
- The revision-65 seed uses the full usable tick range from -887220 to 887220 and a 240 USDG maximum. Its fixed-point launch price and liquidity are selected from the two release candidates according to the deployed token address. In graph mode the seed returns any unused USDG to the payer and rejects HKMN residuals; the release fixture consumes the full 240 USDG, leaves the hook empty, and transfers no HKMN dust to treasury.
- Seed rollback evidence includes a forced custody-bind failure after the PositionManager mint call. It restores payer, hook, PoolManager, and PositionManager USDG/HKMN balances; ERC-20 and Permit2 approvals; pool state; position counter; custody state; and canonical seed state.
- The archive suite validates CREATE2 reproduction of its local token, hook, and custody targets, the ordered graph launch, and the later liquidity seed. It is evidence for the pinned runtime, not evidence of a production deployment.
- The canary never changes the pinned verdict. A current-head runtime difference emits a warning and keeps the process successful when the pinned verification passes. A pinned mismatch exits nonzero.
- No archive RPC endpoint belongs in source, fixtures, reports, or commands. The environment variable name is the only repository reference to the archive endpoint.
- `release/phase3/deployment-manifest.json` does not currently provide a concrete production launch configuration. This module must not claim a final production PoolKey, launch price, or deployed target address from that manifest.

## State transitions

- A passing archive run proves the provider-shaped graph composition against the pinned runtime: deployment, the three ordered initializers, then a separate Permit2 seed. The current provider-route measurement is 10,264,874 aggregate transaction gas, including 651,348 calldata gas and a 1,000,000 gas margin, within the 30,000,000 genesis envelope recorded in `release/phase3/graph-gas-evidence.json`. A failed run is evidence that the required archive environment, pinned header, runtime bundle, launch path, or asserted behavior no longer matches the pin.
- `verify-fork-pin.mjs` exits zero only when the pinned verification passes. It emits a current-head warning without changing that exit status when the numeric snapshot resolved from `latest` differs or cannot be observed.
- A pin update requires a newly verified finalized block, its header hash, each pinned runtime hash, and the USDG implementation slot. It is a new evidence record, not an automatic repair for a test regression.

## Operational commands

Run the verifier and Foundry commands with Node 24.19.0 and the pinned Foundry release:

```sh
node scripts/verify-fork-pin.mjs
```

With `ROBINHOOD_FORK_RPC_URL` configured, run this CI-ready `--match-path` command list. The archive proof is mandatory; the three focused suites also fail rather than skip if their configured fork cannot be created or its required runtime differs.

```sh
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' \
  forge test --root packages/contracts \
  --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol' -vvv

FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' \
  forge test --root packages/contracts \
  --match-path 'test/integration/RobinhoodV4Fork.t.sol' -vvv

FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' \
  forge test --root packages/contracts \
  --match-path 'test/integration/RobinhoodV4ForkSmoke.t.sol' -vvv

FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' \
  forge test --root packages/contracts \
  --match-path 'test/integration/LaunchLegFork.t.sol' -vvv
```

If any command above discovers zero tests because `forge-std/Script.sol` cannot resolve, retry that command with the process-only fallback. Do not edit `remappings.txt` or `foundry.toml` for this fallback.

```sh
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' \
FOUNDRY_REMAPPINGS='forge-std/=lib/v4-core/lib/forge-std/src/' \
  forge test --root packages/contracts \
  --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol' -vvv
```

## Recovery pointers

- A missing archive environment or failed archive connection is an **OPEN FACT**: obtain access to an archive-capable chain-4663 RPC through the approved environment configuration; the closest verified alternative is the unit-tested pin verifier with a fake RPC and the local integration suites.
- A pinned header or runtime mismatch is an **OPEN FACT**: inspect the exact RPC response at the recorded block, recompute every affected hash and the USDG implementation slot, then prepare a reviewed pin update. Do not replace a mismatch with an assumed value.
- A current-head warning is a drift signal. Investigate the live bytecode and router behavior before deciding whether a new finalized pin is appropriate; it does not invalidate a passing archive proof by itself.
- An ordered graph assertion failure is an **OPEN FACT**: compare the executor's target deployments and initializer selectors with `LaunchComposition.t.sol`, then establish whether the provider contract or the test composition changed. Keep the graph launch and seed as separate transitions.
- Concrete production launch inputs, including the manifest launch price, remain an **OPEN FACT**: resolve them from an approved production manifest and binding update, then add deployment-specific evidence. Until then, the suite's CREATE2 checks apply only to its test harness.
