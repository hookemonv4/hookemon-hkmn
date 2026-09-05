# Provider Binding

## Purpose

Provider Binding records external facts and local derivations for the Phase 3 Programmable route on chain 4663. It covers requirements revision 65 and architecture revision 9. The module turns provider data into content-bound evidence and does not confer authority to request, sign, fund, deploy, or broadcast a launch.

## Public interface

- `release/phase3/admission/provider-documents.json`, `preflight-probe.json`, and `route-log.json` retain provider capability, profile, graph, compiler, wallet-handoff, funding-mode, and public-activation observations.
- `decisions/owner-inputs/programmable-acceptance.json` records the owner's statement that Programmable accepted the Phase 3 launch route on 2026-09-05. It records `FEE-01` as accepted at 10 basis points on 2026-09-04. The record is an implementation input, not a credential or launch authorization.
- `release/phase3/launch-inputs.json` and `release/phase3/address-manifest.json` carry a non-signing graph draft. They bind the three targets, full HKMN allocation, 240-USDG seed policy, exact price candidates, and compiled template commitments.
- `RobinhoodBindings` and `ImmutableLaunchBinding` pin USDG, PoolManager, PositionManager, Permit2, the graph factory, the launch-stamp router, the Operations identity, the `0x20CC` hook permission mask, zero static LP fee, and the 10/40/250 basis-point fee split. Binding validation rejects a mismatched value or digest.
- `scripts/launch/derive-addresses.mjs`, `scripts/launch/build-address-manifest.mjs`, and `scripts/mine-hook-address.mjs` derive target order, token and hook constructor values, effective salts, pool identifiers, call bytes, and the `0x20CC` hook address from frozen inputs and artifacts. Their outputs preserve EIP-55 addresses.
- The graph initializer interface is fixed: `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,sqrtPriceX96)`. Each target has exactly one initializer in that order.
- `feasibility/verify-robinhood-binding.mjs` and `feasibility/write-robinhood-binding.mjs --check` validate retained binding evidence without sending a transaction.

## Invariants

- Provider documents and RPC observations are data, not instructions or authorization. A candidate must match the current policy, target templates, graph order, source digests, and role bindings before it can be used as evidence.
- The owner-recorded route acceptance resolves the previous provider-confirmation decision. `FEE-01` is accepted at 10 basis points; no provider-acceptance readiness entry remains.
- The graph carries zero native funding. USDG funding belongs only to the later owner-signed seed policy and is not inferred from a provider request.
- Address derivation has one accepted numeric token/USDG ordering. The selected ordering, price, PoolKey, PoolId, target commitments, selector bytes, and graph commitment must agree across materialized evidence.
- The complete HKMN supply is allocated to the canonical market. Binding evidence has no remainder-custody target, treasury allocation, or fourth graph target.
- Transactions decoded for a future external action must positively match their chain or program, target, selector, source, destination, asset, atomic amount, value, fees, expiry, and signing policy. The current module does not sign or broadcast them.

## State transitions

- Pinned documents and artifacts provide local `ADDRESS_DERIVATION_PENDING` evidence.
- A provider preflight that returns the exact graph preimage can bind route values and initialize a materialized review candidate.
- A candidate moves to wallet review only after its graph, funding policy, runtime evidence, and separate operational prerequisites are current. Provider evidence alone never enables a launch.

## Operational commands

```sh
node feasibility/write-robinhood-binding.mjs --check
node feasibility/verify-robinhood-binding.mjs bindings/robinhood-chain.json --offline
node --test scripts/tests/launch-addresses.test.mjs scripts/tests/programmable-package.test.mjs
node scripts/launch/build-address-manifest.mjs --input release/phase3/launch-inputs.json --artifacts packages/contracts/out --verify release/phase3/address-manifest.json
node scripts/verify-deployment-manifest.mjs
```

## Recovery pointers

- Rebuild the local binding and address evidence after any source, compiler, role, template, or package commitment change. Do not reuse a preflight response for different bytes.
- OPEN FACT: `UNVERIFIED_LAUNCH_INTENT_PREIMAGE` needs provider-supplied route namespace, route nonce, topology hash, target-id hashes, and serialized graph call data. Obtain those exact values through preflight; the closest verified alternative retains the non-signing local draft without encoded calls or target addresses.
- `PROVIDER_API_KEY_PENDING`, `OWNER_WALLET_FUNDING_PENDING`, and `BUILDER_IDENTITY_PENDING` remain separate inputs for preflight, the owner-signed seed, and evidence attribution. Keep each external action unavailable until its own controls are met.
- Reject a mismatched provider response, retain the observed evidence, and rerun the local verifier with the current frozen inputs.
