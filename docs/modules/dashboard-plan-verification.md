# Dashboard plan verification

## Purpose

The read-only preflight distinguishes an actual Robinhood mainnet fork from an unforked local Anvil node or an unavailable endpoint. Fork availability alone does not verify dashboard persistence or plan execution. The offline persistence acceptance harness connects the public operator control API, atomic state file, and durable cycle repository to verify saved-plan and immutable-snapshot behavior. The manual connected harness uses authenticated dashboard HTTP APIs and built-in runner handlers on its own Robinhood fork, with a publicly observed catalog and explicitly simulated external providers.

## Public interface

`inspectFork(localUrl)` in `packages/adapters/test/dashboard-plan/fork-preflight.mjs` returns a `hookemon.dashboard-fork-preflight.v1` observation. `evidence` is `ROBINHOOD_MAINNET_FORK`, `LOCAL_UNFORKED`, or `UNVERIFIED`. `dashboardPlanVerified` remains false. The CLI prints three independent observations and exits nonzero if any observation fails to verify fork provenance.

## Invariants

The read-only preflight accepts only an HTTP endpoint on literal `127.0.0.1` without credentials, query, fragment, or path is accepted. Requests use only `anvil_metadata`, `eth_chainId`, and `eth_getBlockByNumber`. The upstream comes from the checked-in Robinhood binding; endpoint text from RPC metadata is never followed or printed. Local fork metadata, the local fork block, and the public upstream block must agree on chain and block identity. Redirects are rejected and requests time out after five seconds. The preflight involves no accounts, signatures, transactions, mining, snapshots, resets, deployments, or process control.

The connected launcher owns only port 28545 and refuses an occupied endpoint. It starts a separate fork pinned to an observed public block and never resets the coordinator node. All transactions use random disposable keys and local RPC. Collector purchases, Solana transactions, and Relay quote/status responses are simulated; catalog data is fetched without credentials from the public machines endpoint and remains unchanged. The isolated source copy replaces exactly two operations identity pins for its ephemeral accounts. No production source or identity is changed. Copied files, launcher, compiler version, original and transformed policy, validated frozen artifacts, catalog response, and fork block have recorded hashes before execution.

## State transitions

Each attempt begins `UNVERIFIED`. Missing fork metadata yields `LOCAL_UNFORKED`; matching fork and upstream observations yield `ROBINHOOD_MAINNET_FORK`. Malformed, mismatched, or unavailable evidence remains `UNVERIFIED`. The preflight does not change runner or chain state and cannot certify the dashboard plan. The offline acceptance harness writes only disposable state directories. It saves a plan, opens two successive cycle snapshots, changes the saved plan while the second is active, restarts in a fresh process, rejects a stale edit, and verifies that the third snapshot alone adopts the new plan. Its stage completions are explicit synthetic fixtures; no purchase execution is implied.

## Operational commands

Run from the repository root with Node 24 or newer:

```sh
node --test packages/adapters/test/dashboard-plan/fork-preflight.test.mjs
node --test packages/adapters/test/dashboard-plan/persistence-acceptance.test.mjs
node packages/adapters/test/dashboard-plan/fork-preflight.mjs http://127.0.0.1:18545
```

The persistence acceptance suite repeats its complete scenario three times and reports the implementation source HEAD and tracked source diff hash. `HOOKEMON_DASHBOARD_PLAN_SOURCE_ROOT` can target a separate integrated checkout while dependent source changes are being coordinated; absent the variable, the current repository is used. Untracked implementation files or a source change during a run fail evidence validation.

The preflight unit suite repeats six guard cases three times using offline fixtures. These are not chain-fork tests. The CLI performs actual read-only RPC observations. The separate coordinator owns fork startup and its mutable simulation; this harness must not start or restart that process.

The manual connected launcher requires explicit paths in `HOOKEMON_DASHBOARD_FORK_ARTIFACT_ROOT`, `HOOKEMON_DASHBOARD_FORK_SOLC`, `HOOKEMON_DASHBOARD_FORK_HARNESS_SOURCE`, and `HOOKEMON_DASHBOARD_FORK_ANVIL`. It validates the three release artifacts against the adjacent address manifest and the harness source against `fork-fixture-provenance.json`. Run `node packages/adapters/test/dashboard-plan/run-fork-acceptance.mjs`. Default execution repeats the full three-cycle scenario three times; `HOOKEMON_DASHBOARD_FORK_ATTEMPTS=1` is an exploratory run, not the final repeated acceptance. Evidence is written under the owned worktree's `.session/dashboard-fork-*` directory. The ordinary test suite explicitly skips the mutable fork scenario unless launched with this prepared environment.

## Recovery pointers

For `LOCAL_UNFORKED`, obtain the coordinator's fork endpoint. For `RPC_UNAVAILABLE`, check endpoint availability with that coordinator and retry; an offline fixture is not a substitute for chain evidence. A block mismatch requires checking the pinned block against `bindings/robinhood-chain.json` and the coordinator's fork configuration. Preserve the failed observation. The connected suite asserts three completed cycles per attempt: original plan, unchanged repeat with an in-flight saved edit, then the changed plan after recomposition. It checks actual local holder balance deltas and finalized payout receipts. Failed assertions remain failed evidence. The HTTP scenario does not exercise a browser, real provider purchases, or production wallets. Partial-order crash recovery remains a separate execution test. Offline snapshot acceptance establishes storage and binding semantics only.

## Evidence sources

The repository pins Foundry 1.7.1 at commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8` in `release/phase1/local-toolchain.json`. Its [Anvil metadata implementation](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/anvil/src/eth/api.rs#L401) exposes fork chain, block number and hash without wallet material. The [official Anvil guide](https://www.getfoundry.sh/anvil/index.html) distinguishes plain local nodes from nodes started with a fork URL. The repository's `hook-contract-client.anvil.mjs` starts a plain local node; the coordinator's Robinhood fork and the Foundry `RobinhoodV4Fork` contract suite are separate evidence sources.
