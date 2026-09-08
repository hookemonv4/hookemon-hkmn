# Conditional local funding and gas evidence

Separate local transactions show that 100 USDG of liquidity plus a 50 USDG trader balance generate 25.945514 USDG of genuine process fees in 16 round trips. The production hook then claims 25.298644 USDG to its configured local Operations account. A separate pre-seed study measures the two approvals and initial liquidity deposit. These are local candidate economics, not authorization to replace the historical 240 USDG launch seed or proof of the complete 250 USD budget.

| Study | Executed transactions | EVM gas |
| --- | ---: | ---: |
| 150 USDG swaps | 32 | 8,381,513 |
| Owner-cap scenario swaps and claim | 33 | 8,602,064 |
| Seed approvals and seed | 3 | 769,903 |

The two swap studies overlap and must not be added together. The claim scenario uses explicitly recorded 50,000 USDG six-hour and 500,000 USDG immutable caps, local test authority and fixture count limit 8. All production runtime templates match the tracked launch artifacts outside compiler-defined constructor immutables. The provider deployment is supplied by a test graph harness, so its deployment gas is not proven. USDG acquisition prices, provider charges, Arbitrum poster fees, bridges, Solana lifecycle and final payout costs remain unpriced.

The coordinator independently checked the original 150 USDG receipts, gas, distinct blocks and exact transfer conservation; its raw review is included. Other scope reviews were communicated in the task conversation and are not represented as signed approval receipts. `receipts.json` preserves full raw local receipts in compact JSON. Large exported account allocations remain outside Git and are identified by SHA-256; the source patches recreate them from their public block when archive access exists.

## Reproduction

Use the repository-pinned submodules and Foundry 1.7.1 (4072e48705af9d93e3c0f6e29e93b5e9a40caed8), solc 0.8.26. The archived foundry.toml records the package configuration; launch profile uses optimizer 1000, Cancun, no CBOR metadata. In an isolated worktree, copy the baseline archive test using `git show b8067b1e5acc02e0b8b60f6910333042ca4ea432:packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol` into the export filename named in the selected study's patch, then `git apply docs/evidence/local-gas/<study>/export.patch`. For claim or seed, copy `packages/contracts/test/launch/LaunchComposition.t.sol` to `LocalClaimLaunchComposition.t.sol` in the same directory and apply `owner-caps.patch` once. Patches contain only test fixture/export changes; tracked production modules stay unchanged.

Create both `packages/contracts/test/release/.generated` and `test/release/.generated`. Run `FOUNDRY_PROFILE=launch ROBINHOOD_FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --root packages/contracts --match-contract <export-class> --match-test testExportExistingFixtureOnly -vv`; use FOUNDRY_ALLOW_PATHS for the repository if dependency worktrees require it. Classes are LocalGas150ExportTest, LocalGasClaimExportTest and LocalGasSeedExportTest. Each source pins its exact public block. Public endpoints may require archive access when that state ages.

Wrap the exported allocation JSON as `{"alloc": <exported-object>}` and initialize a fresh loopback Anvil with `--fork-url` and `--fork-block-number` matching the study, `--init` that wrapper, and `--silent`. The scripts enforce/use ports 18548, 18549 and 18550 respectively; preserve other study instances. Create `.local-gas` and run the selected measure script from the repository root. The scripts use local impersonated fixture accounts only and must never target a live endpoint. No real keys are required. Seed uses exactly the serialized SeedParams; claim uses the configured local Operations account.

No tests were repeated to package this documentation. Export, transaction and validation results are the executions described in each study report. Local EVM gas excludes native poster/L1 fees and is not a live maximum.
