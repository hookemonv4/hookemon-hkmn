# Launch Orchestration

## Purpose

Launch Orchestration prepares the native ETH/HKMN market and its permanent liquidity position. The three-target Programmable graph and the later payable seed are separate transactions. Local derivation, draft validation and package verification neither approve a launch nor sign or broadcast it.

## Public interface

`HKMNToken.allocate(hook)`, `custody.configureBindingHook(hook)` and `hook.initializeGraphLaunch(custody, sqrtPriceX96)` execute in that order after deployment. The graph allocates the entire fixed stock, configures custody and initializes the pool. It has zero deployment and initializer value.

`HookemonHook.seedCanonicalLiquidity(SeedParams)` accepts native ETH with `msg.value == amount0Max`. Only HKMN uses temporary approvals. Exact pinned PositionManager debt consumes the full HKMN stock; unused native value returns to the payer, who may differ from the caller. Custody permanently binds the verified full-range LP position.

`deriveNativePriceCandidate({ nativeWei, hkmnAtomic })` derives one native-currency0 price and liquidity tuple from explicit integer maxima. It records exact debt and refund without choosing funding. `scripts/launch/derive-addresses.mjs` accepts native `hookemon.phase3.launch-inputs.v2`, recomputes this tuple, and binds native quote identity, positive wei claim limits, the actual eighteen-word hook constructor, target initializers, CREATE2 preimages and runtime artifacts. `build-address-manifest.mjs` binds its full inputs, including the external seed intent, into the digest chain.

`PhaseThreeReleasePlan.validateDraft` checks source, roles, allocation, fees and whether a proposed native seed tuple can pay the exact full-stock debt within its maximum. It does not select a funding-to-price ratio or approve a seed price. Increasing a refundable maximum can remain feasible. The stricter deterministic price choice belongs to address derivation and package verification.

`materializePhaseThreePriceSelection` selects only the recomputed native tuple. `verifyPhaseThreeMaterializedSeedManifest` rederives the actual address manifest and checks the frozen native seed policy, compiled artifacts and exact constructor values. `verifyMaterializedSeedTransaction` checks native value, destination, custody, payer, ticks, liquidity, maxima and relative deadline against that policy. The seed-intent digest is an external package commitment, not a hook constructor field. Historical v1 address evidence remains separately decoded; its USDG assumptions or approvals cannot authorize a native seed.

## Invariants

The stock is exactly 1,000,000,000 HKMN at 18 decimals, allocated entirely to the canonical market. Native ETH is currency0 and HKMN is currency1. Graph initialization is atomic and external pool initialization is rejected. Seeding is one-shot and consumes the full stock; it never creates a remainder-custody allocation.

The seed uses the exact PoolKey, configured PositionManager, full-range ticks, hook and recorded liquidity. Native debt and payer refund are calculated per call, independently of forced ETH and unrelated balances. A rejected payer refund reverts that seed attempt. Permanent custody exposes no withdrawal, approval, rescue, collection, upgrade or delegation path.

A signing candidate needs the frozen explicit native funding, deterministic price, positive claim ceilings, exact artifacts and provider graph preimage. The package checks its payer and relative deadline, with at most 900 seconds from the reference timestamp. The hook has no immutable seed-intent digest and does not enforce that offchain relative window. An old owner approval, a feasible Solidity draft or an unsigned local package is not transaction authority.

## State transitions

Missing owner or provider inputs leave an `ADDRESS_DERIVATION_PENDING` draft, with unknown funding, addresses and calldata explicitly unset. Complete inputs permit deterministic materialization and verification. A successful graph becomes allocated, initialized and unseeded. A successful separate seed becomes seeded and permanently custodied; a failed seed rolls back only its own attempt. A seeded mainnet pool is publicly tradable.

## Operational commands

```sh
node scripts/programmable/rebuild-phase3-release.mjs
node scripts/programmable/verify-launch-package.mjs --allow-unverified
node --test scripts/tests/native-release-package.test.mjs scripts/tests/native-seed-intent.test.mjs
FOUNDRY_PROFILE=launch forge test --root packages/contracts --match-path 'test/release/PhaseThreeReleasePlan.t.sol'
```

## Recovery pointers

Rebuild generated artifacts and the review target after source or compiler changes. Reject changed seed calldata, native value, policy, manifest, artifact or expired deadline and rederive from the exact authorized inputs. Never fill an unknown address, seed amount or admission field by inference.

Provider field-level evidence is in `feasibility/native-provider-admission/`; earned-fee funding scenarios are in `feasibility/native-funding/`. Their observations do not establish model admission or the complete external capital budget. Resolve provider metadata, graph preimages, route admission and the next transaction's funding and fee bounds before requesting that concrete wallet action. The owner decision in `decisions/owner-approvals/mainnet-test-priority-20260908.json` defers complete EUR 250 affordability proof until functional testing. `release/phase3/launch-plan.md` defines the staged first cycle, conditional second cycle, reconciliation and cost record; it does not authorize spending. Historical USDG preparation is retained under `docs/evidence/usdg-launch-preparation-20260907/`.
