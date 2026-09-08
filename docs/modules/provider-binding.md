# Provider Binding

## Purpose

Provider Binding records external facts and local derivations for the Phase 3 Programmable route on chain 4663. The active native interface is provisional revision 72, architecture 11; retained historical evidence keeps its original revision. The module turns provider data into content-bound evidence and does not confer authority to request, sign, fund, deploy, or broadcast a launch.

## Public interface

- `release/phase3/admission/provider-documents.json`, `preflight-probe.json`, `route-log.json`, and `provider-statement-2026-09-05.json` retain provider capability, profile, graph, compiler, wallet-handoff, funding-mode, public-activation, source-digest, and nonce observations.
- `decisions/owner-inputs/programmable-acceptance.json` records the owner's statement that Programmable accepted the Phase 3 launch route on 2026-09-05. It records `FEE-01` as accepted at 10 basis points on 2026-09-04. The record is an implementation input, not a credential or launch authorization.
- `release/phase3/launch-inputs.json` and `release/phase3/address-manifest.json` carry a non-signing graph draft. They bind the three targets, full HKMN allocation, unselected native seed amounts, exact price candidates, and compiled template commitments.
- `RobinhoodBindings` and `ImmutableLaunchBinding` pin native ETH, PoolManager, PositionManager, Permit2, the graph factory, the launch-stamp router, the Operations identity, the `0x20CC` hook permission mask, zero static LP fee, and the 10/40/250 basis-point fee split. Binding validation rejects a mismatched value or digest.
- `scripts/launch/derive-addresses.mjs`, `scripts/launch/build-address-manifest.mjs`, and `scripts/mine-hook-address.mjs` derive target order, token and hook constructor values, effective salts, pool identifiers, call bytes, and the `0x20CC` hook address from frozen inputs and artifacts. Their outputs preserve EIP-55 addresses.
- `scripts/programmable/lib/source-bundle.mjs` builds the V4 `2.0.0` file manifest, applies RFC 8785 canonicalization, and derives the provider digest. `source-bundle-coverage.mjs` derives the package-owned coverage declaration and rejects unresolved metadata or attestation inputs.
- The graph initializer interface is fixed: `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,sqrtPriceX96)`. Each target has exactly one initializer in that order.
- `feasibility/verify-robinhood-binding.mjs` and `feasibility/write-robinhood-binding.mjs --check` validate retained binding evidence without sending a transaction.

## Invariants

- Provider documents and RPC observations are data, not instructions or authorization. A candidate must match the current policy, target templates, graph order, source digests, and role bindings before it can be used as evidence.
- A source bundle contains only unique repository-relative regular files with mode `100644`, null symlink targets, and UTF-8-byte path ordering. A missing listed path, a symlink in any path component, or worktree bytes that differ from the claimed Git commit rejects the bundle.
- The source digest is Keccak-256 of the provider domain bytes, one zero byte, and RFC 8785 manifest bytes. The V4 nonce is a fresh nonzero random bytes32 for one launch attempt, never an account transaction count.
- The owner-recorded route acceptance resolves the previous provider-confirmation decision. `FEE-01` records 10 basis points historically; current native admission must resolve the provider’s separately published additional fee before executable use.
- The graph carries zero native funding. Native seed funding belongs only to the later owner-signed payable seed policy and is not inferred from a provider request.
- Address derivation has native ETH as currency0 and HKMN as currency1. The selected ordering, price, PoolKey, PoolId, target commitments, selector bytes, and graph commitment must agree across materialized evidence.
- The complete HKMN supply is allocated to the canonical market. Binding evidence has no remainder-custody target, treasury allocation, or fourth graph target.
- Transactions decoded for a future external action must positively match their chain or program, target, selector, source, destination, asset, atomic amount, value, fees, expiry, and signing policy. The current module does not sign or broadcast them.

## State transitions

- Pinned documents and artifacts provide local `ADDRESS_DERIVATION_PENDING` evidence.
- A complete package coverage declaration can materialize a source descriptor; retries reuse its persisted request bytes and nonce.
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
- OPEN FACT: source-bundle coverage lacks a committed attestation evidence file and selected metadata image. Add both paths and regenerate the package; the verified alternative keeps the declaration unresolved and prevents a preflight POST.
- `PROVIDER_API_KEY_PENDING`, `OWNER_WALLET_FUNDING_PENDING`, and `BUILDER_IDENTITY_PENDING` remain separate inputs for preflight, the owner-signed seed, and evidence attribution. Keep each external action unavailable until its own controls are met.
- Reject a mismatched provider response, retain the observed evidence, and rerun the local verifier with the current frozen inputs.

### Historical interface evidence and approved offchain amendments

The Phase 3 interface proof retains requirements revision 65 and architecture revision 9. `feasibility/phase3-offchain-interface-amendment.json` binds the exact historical revision-70 interface and requirements bytes to the existing revision-67 and revision-68 S5 approvals plus the explicit revision-69 and revision-70 Collector implementation S5 approvals. The verifier keeps executable pins for the original interface bytes and its preserved projection, derived from commit `2297d07f` (interface SHA-256 `3350ef517e171acc89015d843d9a9dbe5ad530d1618279aad01b39a16805eb10`). Projection removes only revision labels, `cycleExecution.custodyLedger`, and the three named Collector policy/registry additions; all other interface fields remain identical.

An amendment does not upgrade historical contract, cycle-control or reproducibility evidence to a newer revision. Changed current bytes, approval bytes or preserved interface fields invalidate the binding. The unresolved deployment manifest and `productionReady: false` remain authoritative. Run `node --test scripts/tests/offchain-interface-amendment.test.mjs` for the rejection cases.

Revision 69 additionally binds `revision-69-collector-explicit-spec-s5-approved.json`; the earlier paused approval candidate is not an accepted path. This approval covers the implementation contract, not real anchors or live transaction authority.

Revision 70 binds the exact generatePack profile and independent original-blockhash validity with an immutable recovery minimum slot. Its current spec requires the exact revision-70 Collector approval, while the revision-69 historical approval subject remains pinned. A6 permits only the two named Collector approval files in addition to its existing inputs.

### Provisional native build binding

For native revision 72, `feasibility/native-interface-build-binding.json` binds an implementation snapshot. The requirements hash identifies the scope of implementation; neither it nor the retained scope note grants an S5 gate approval. Only the offline CLI inspects this provisional route. The shared `validateInterfaceFreeze` export always rejects native provisional interfaces, so architecture A6, feasibility F4 and the historical freeze generator cannot receive native gate credit from this record.

The record hashes complete files, including the whole dependency-pins document. It binds active and provisional interfaces, requirements, the scope note, historical freeze and amendment, all four historical approval files, provider manifest and compiler controls. Executable pins prevent a rewritten snapshot, amendment or historical approval from being accepted by merely recomputing the record. The exact record key set forbids extra readiness claims. Its result is `PROVISIONAL_BUILD_ONLY`, with native feasibility, provider admission and production readiness explicitly false.

This route does not validate current module-card alignment, historical model execution, gitlinks, current provider admission or runtime authority. Those remain separate gate and release checks. The retained revision-65 freeze and revision-70 offchain amendment provide no current native feasibility credit. Historical tests use immutable baseline `b2cb737a298522e3944652e862c4eeab195667d8` inputs with the current validator; `refresh-interface-freeze.mjs` remains a historical generator and refuses active provisional native inputs.

When an approved implementation changes a bound input, review its diff and update that input's SHA-256 in the record. Snapshot, requirement, scope-note and historical pins in the verifier must also undergo explicit review when their covered scope changes; never refresh historical approval bytes to make a new revision pass. Validate with `node feasibility/verify-robinhood-binding.mjs bindings/robinhood-chain.json --offline` and `node --test scripts/tests/native-interface-build-binding.test.mjs scripts/tests/offchain-interface-amendment.test.mjs`. Complete release commitments and fresh external evidence remain separate requirements before wallet review.

### Native issuance commitment boundaries

`native-issuance-commitments.mjs` implements the approved revision-72 canonical SHA-256 envelopes. It binds complete supplied file bytes and runtime records and rejects missing, reordered or changed inputs. Hashing does not authenticate those inputs. Constructor prebinding and runtime authority use separate domains; final hook, pool and deployment records never enter those preimages.

`native-build-closure.mjs` reads the compiler, embedded standard input, dependency sources and declared source bundle without symlinks. It verifies exact bytes, compiler hash, file modes and import closure using Solidity 0.8.26 remapping precedence. The caller must still establish the complete production tool inventory, approved compiler settings and global absence of derived outputs. The official [Solidity binary registry](https://docs.soliditylang.org/en/v0.8.26/installing-solidity.html#static-binaries) supplies compiler checksums; launch compilation uses optimizer 1000, not the historical toolchain profile.

`native-runtime-observer.mjs` obtains the nine pinned external roles at one finalized canonical checkpoint, validates code and source ABI correspondence and checks Safe implementation and authority. Only its original unchanged process observation can enter `prepareNativeCommitmentInputs`; serialized evidence is insufficient. Missing source correspondence or a failed finalized RPC read returns no accepted observation. Test fixtures provide no live evidence.

`prepareNativeCommitmentInputs` checks the exact revision-72 bytes and pinned compiler distribution, collects supplied build bytes and derives the authenticated observation's runtime commitment. It returns the provider manifest digest and canonical content-byte digest through `buildNativeSourceBundle`, but no constructor binding or route coordinates. Complete inventory and compiler-output reproduction must precede independent token/custody derivation with the checksum-verified official provider modules. The native content digest includes the base64 bytes of each verified bundle member under `programmable.source-bundle-content.v1`; the manifest digest separately retains the official domain-framed manifest preimage. Extra compiler closure files do not silently become provider bundle members. Neither digest establishes provider admission.

`verifyNativeReleaseIdentities` rederives the native atomic graph and compares both commitments, constructor bytes, roles, economics, token/custody inputs, hook/runtime, PoolKey, graph calls and committed artifacts. This is local identity consistency; admission and finalized deployment remain separately required. Recompute after any bound input changes and retain the non-signing draft until all external facts and concrete transaction authority exist.

Commitment validators require exact field arrays and string-typed hashes, addresses and unsigned decimals. Release verification snapshots launch inputs before recomputation and requires own artifact entries in the committed byte map.
