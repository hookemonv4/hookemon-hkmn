# Dashboard plan verification

## Purpose

The read-only preflight distinguishes an actual Robinhood mainnet fork from an unforked local Anvil node or an unavailable endpoint. Fork availability alone does not verify dashboard persistence or plan execution.

## Public interface

`inspectFork(localUrl)` in `packages/adapters/test/dashboard-plan/fork-preflight.mjs` returns a `hookemon.dashboard-fork-preflight.v1` observation. `evidence` is `ROBINHOOD_MAINNET_FORK`, `LOCAL_UNFORKED`, or `UNVERIFIED`. `dashboardPlanVerified` remains false. The CLI prints three independent observations and exits nonzero if any observation fails to verify fork provenance.

## Invariants

Only an HTTP endpoint on literal `127.0.0.1` without credentials, query, fragment, or path is accepted. Requests use only `anvil_metadata`, `eth_chainId`, and `eth_getBlockByNumber`. The upstream comes from the checked-in Robinhood binding; endpoint text from RPC metadata is never followed or printed. Local fork metadata, the local fork block, and the public upstream block must agree on chain and block identity. Redirects are rejected and requests time out after five seconds. No accounts, signatures, transactions, mining, snapshots, resets, deployments, or process control are involved.

## State transitions

Each attempt begins `UNVERIFIED`. Missing fork metadata yields `LOCAL_UNFORKED`; matching fork and upstream observations yield `ROBINHOOD_MAINNET_FORK`. Malformed, mismatched, or unavailable evidence remains `UNVERIFIED`. The harness does not change runner or chain state and cannot certify the dashboard plan.

## Operational commands

Run from the repository root with Node 24 or newer:

```sh
node --test packages/adapters/test/dashboard-plan/fork-preflight.test.mjs
node packages/adapters/test/dashboard-plan/fork-preflight.mjs http://127.0.0.1:18545
```

The unit suite repeats six guard cases three times using offline fixtures. These are not chain-fork tests. The CLI performs actual read-only RPC observations. The separate coordinator owns fork startup and its mutable simulation; this harness must not start or restart that process.

## Recovery pointers

For `LOCAL_UNFORKED`, obtain the coordinator's fork endpoint. For `RPC_UNAVAILABLE`, check endpoint availability with that coordinator and retry; an offline fixture is not a substitute for chain evidence. A block mismatch requires checking the pinned block against `bindings/robinhood-chain.json` and the coordinator's fork configuration. Preserve the failed observation. Persistence, repeated plan execution, and change-at-next-cycle acceptance require the implemented plan API and a dedicated mutable simulation owned by the coordinator.

## Evidence sources

The repository pins Foundry 1.7.1 at commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8` in `release/phase1/local-toolchain.json`. Its [Anvil metadata implementation](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/anvil/src/eth/api.rs#L401) exposes fork chain, block number and hash without wallet material. The [official Anvil guide](https://www.getfoundry.sh/anvil/index.html) distinguishes plain local nodes from nodes started with a fork URL. The repository's `hook-contract-client.anvil.mjs` starts a plain local node; the coordinator's Robinhood fork and the Foundry `RobinhoodV4Fork` contract suite are separate evidence sources.
