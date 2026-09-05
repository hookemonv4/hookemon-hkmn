# Phase 3 verification plan

Run the local launch-package verifier against `release/phase3/launch-inputs.json`, `release/phase3/address-manifest.json`, and the rendered draft package. It must reproduce input digests, provider target order, full-range ticks, exact full-allocation price candidates, and the four retained readiness inputs without reading credentials or network state.

Run the deployment-manifest verifier to confirm the token, hook, custody constructor schemas, EIP-55 addresses, and genesis size and code-deposit-gas headroom. Run the programmable package and launch-address tests for the `0x20cc` hook route, address-order price selection, graph-factory issuance authority, and exactly three ABI-derived calls in token, custody, hook order.

Run the focused Foundry draft-plan, launch, release, and blind token-role tests. They reject materialized graph fields, missing graph issuance authority, an unapproved price tuple, nonzero residual HKMN after a graph seed, a changed template hash, and an allocation that is not the complete supply to the canonical market.

Before a signing decision, obtain the provider's route namespace, route nonce, topology hash, target-id hashes, and serialized calls for `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,sqrtPriceX96)`. Then rebuild the package with the pinned compiler profile, derive the graph through those provider values, compare materialized runtime hashes after deployment, and confirm the resolved PoolKey, PoolId, hook mask, exact `240000000` USDG allowance, selected exact tuple, deadline, nonce, and gas fields.
