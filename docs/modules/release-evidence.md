# Release Evidence

## Purpose

Release Evidence builds and verifies the Phase 3 package without treating local evidence as live readiness. It binds active requirements revision 76 and architecture revision 11 to the current token, hook, custody, compiler, graph draft, and owner inputs. Retained revision-65/architecture-9 approvals and calculations remain historical evidence. It never authorizes deployment, signing, broadcast, funding, or publication.

## Public interface

- `scripts/programmable/rebuild-phase3-release.mjs` compiles the three Phase 3 targets with the pinned launch profile and regenerates release artifacts, package data, submission, deployment manifest, Solidity draft constants, and source commitments.
- `PhaseThreeReleasePlan.Draft` pins chain 4663, the graph roles, target template hashes, a 1,000,000,000-HKMN supply, a full canonical-market allocation, zero other allocation, legacy 240-USDG seed and full-range fixture defaults, the revised inclusive 20/30/250 basis-point fee split, and one exact price-order tuple.
- The two historical USDG seed fixtures consume 240 USDG (240000000 atomic units) and the full HKMN allocation. USDG-currency0 uses `161723809515207654588927258648643645224` at liquidity `489897948556635619`; HKMN-currency0 uses `38813714284914462669` at liquidity `489897948572597439`.
- `buildLaunchPackage()` and `verifyLaunchPackage()` render and verify the checked-in `ADDRESS_DERIVATION_PENDING` graph draft or a separately written materialized package. When a materialized seed transaction is present, the verifier locally derives the expected seed-intent digest (payer, ticks, liquidity, both maxima, and a 900-second `maxDeadlineSeconds` policy) with `scripts/programmable/lib/seed-intent.mjs`, decodes the seed calldata, and rejects a mismatch or a deadline outside that 900-second window before a wallet is asked to sign. This is a package-level, pre-signing JavaScript check, not a Solidity hook invariant: the checked-in `HookemonHook.sol` does not implement an on-chain `seedIntentDigest`, a `SeedIntentMismatch` check, or a `deadline <= block.timestamp + 900` enforcement. The draft includes `create-request.json`, a deterministic local template for the 21 recorded V4 envelope fields, plus a package-owned source-bundle coverage declaration. Values that committed evidence does not establish remain explicit `null`; the template is not a POST body. Verification may use `--allow-unverified` for local review; it does not change readiness.
- `scripts/verify-deployment-manifest.mjs`, `scripts/verify-release-package-closure.mjs`, and the Phase 3 test suite check template identity, complete package closure, graph shape, source commitments, code-size headroom, and genesis evidence.
- `decisions/owner-inputs/launch-inputs-owner.json` retains the historical 240-USDG owner budget decision and records the approved X profile `https://x.com/hookemon4`. `decisions/owner-inputs/programmable-acceptance.json` records route acceptance on 2026-09-05 and the accepted 10-basis-point `FEE-01` share on 2026-09-04.
- `scripts/programmable/preflight.mjs` loads the V4 request template from `HEAD`, checks the live capability deployment/profile binding against the pinned evidence, and uses only the advertised read-only preflight route. It requires `--repository-url`, `--source-commit`, and `--source-tree`; its source descriptor uses the provider's RFC 8785 and Keccak recipe. `--dry-run` and preflight use one mode-`600` launch-attempt record outside the repository, and `--status <requestId>` uses the advertised status route.
- `sendPreflightProbe()` in `scripts/programmable/lib/preflight-probe.mjs` records a numbered, redacted request-response pair for the fixed V4 preflight route. Its caller supplies the process-environment API key; the helper never writes or returns it. It atomically reserves IDs and rate slots, rejects reused IDs, limits the rate to one request per ten seconds, permits at most sixty requests, and records a redacted transport failure if no response arrives.

The active native assisted-launch inputs preserve token-only inventory at ticks 133500/161220, sqrtPriceX96 `250929875796514805540091219040452`, liquidity `421035394154913054639875`, zero creator ETH and 115 atomic HKMN of permanent custody dust. Version 0.1.2 uses inclusive 20/30/250-bps cumulative streams and confirms 24 claims per rolling six hours. Its source and compiler artifacts supersede submission `45ddd161-e5bb-4cb0-ad92-8f4eb044d82e`; historical USDG calculations and previous submission hashes remain evidence for their own source. The owner-input `assistedLaunchRevision` records the fixed native caps separately from the bot USD budget.

## Invariants

- A local build, package check, draft validation, or archive measurement is evidence only. Each remains separate from `launchEligible` and external-action authority.
- The checked-in graph contains exactly `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,sqrtPriceX96)`. The allocation call has one address argument.
- The token allocation is complete: no remainder custody, treasury allocation, or non-circulating HKMN allocation appears in the release contract, graph, manifest, or submission.
- A materialized seed transaction must match the package verifier's locally derived intent digest for payer, ticks, liquidity, and both maxima, and its deadline must be no later than 900 seconds after the reference execution timestamp. This is a JavaScript package-verifier check performed before a call can be presented for signing, not a Solidity hook or release-plan invariant; the checked-in `HookemonHook.sol` has no on-chain equivalent enforcement.
- The owner-recorded route and fee acceptance resolve the former provider-confirmation and platform-share decision records. The X profile is recorded metadata, not a pending owner input.
- The draft's unverified input set is exactly `UNVERIFIED_LAUNCH_INTENT_PREIMAGE`, `PROVIDER_API_KEY_PENDING`, `OWNER_WALLET_FUNDING_PENDING`, and `BUILDER_IDENTITY_PENDING`. The first is limited to provider-supplied graph values; the remaining three are explicit preflight, funding, or identity inputs.
- A package mismatch in source bytes, ABI, artifact hashes, Standard JSON, metadata bytes, price tuple, graph call, manifest closure, or code-size headroom invalidates the generated output and requires a rebuild.
- The native launch profile uses solc `0.8.26+commit.8a97fa7a`, 200 optimizer runs, `viaIR: true`, Cancun, no bytecode hash, and no CBOR metadata. The release rebuild rejects every runtime template above 24,576 bytes before replacing artifacts. Historical package fixtures retain their separate 1,000-run legacy profile. The [Solidity 0.8.26 IR documentation](https://docs.soliditylang.org/en/v0.8.26/ir-breaking-changes.html) defines code-generation differences; native money-path tests run under the launch profile before release.
- Preflight sends only the 21 top-level fields allowed by `programmable.custom-launch-create-request.v4`. Its local contract check rejects missing fields, extra fields, unexpected schema constants, an unsupported funding mode, or a verification-bundle schema mismatch. It copies `chainDeployment`, `chainDeploymentDescriptorDigest`, and `profile` from live capabilities only when they match the pinned evidence. A new attempt generates one random nonzero lowercase-bytes32 nonce, records canonical request bytes, and reuses both unchanged on retries. It cannot create, submit, sign, or broadcast a launch.
- Preflight accepts only the exact recorded preflight path on the configured API origin; status checks likewise require the exact recorded status path. Neither operation can redirect the API credential to another host.
- Preflight accepts only exact lowercase 40-hex `HEAD` and tree object IDs. If a public-origin rejection cites the initial squash `37c0f95`, preserve the external evidence and have the owner reseed the public repository before retrying the unchanged attempt.
- `PROGRAMMABLE_API_KEY` is accepted only from the process environment. It never appears in a request body, standard output, error output, or preflight evidence; secret-looking provider response fields are removed before evidence is written.
- Probe evidence always records `[REDACTED]` for the authorization header. A provider format probe can establish only the field shape reached by the response boundary; it never makes a probe-only nonce, source digest, or graph value deployable.

## State transitions

- Frozen inputs generate `ADDRESS_DERIVATION_PENDING` evidence with local integrity only, including a request template whose unresolved paths remain explicit.
- A matching verifier run preserves that state while the provider graph preimage is absent.
- A provider response containing the exact graph preimage can create a materialized candidate for preflight review. It remains non-signing until every separate live prerequisite is current and the owner authorizes the action.
- An accepted response writes external evidence and prints a read-only handoff. A provider rejection also writes external evidence, reports numbered differences, and exits nonzero. Status polling is read-only and does not alter evidence or provider state.
- A numbered format probe that reaches a deeper provider validation boundary records that field shape in `provider-documents.json`. The provider statement of 2026-09-05 settles the source-manifest digest and nonce rules; incomplete source coverage still rejects before a POST.

## Operational commands

```sh
node scripts/programmable/rebuild-phase3-release.mjs
node --test scripts/tests/phase3-bytecode-binding.test.mjs scripts/tests/phase3-launch-package.test.mjs scripts/tests/phase3-price-oracle.test.mjs
node scripts/programmable/verify-launch-package.mjs --allow-unverified
node scripts/verify-deployment-manifest.mjs
node scripts/verify-release-package-closure.mjs
node scripts/programmable/preflight.mjs --repository-url "$(git remote get-url origin)" --source-commit "$(git rev-parse HEAD)" --source-tree "$(git rev-parse HEAD^{tree})" --launch-attempt /private/tmp/hookemon-launch-attempt.json --new-launch-attempt --dry-run
node scripts/programmable/preflight.mjs --repository-url "$(git remote get-url origin)" --source-commit "$(git rev-parse HEAD)" --source-tree "$(git rev-parse HEAD^{tree})" --launch-attempt /private/tmp/hookemon-launch-attempt.json
node scripts/programmable/preflight.mjs --status <requestId>
node --test scripts/tests/programmable-preflight.test.mjs scripts/tests/programmable-package.test.mjs
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/release/PhaseThreeReleasePlan.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/release/PhaseThreePriceOracle.t.sol' -vv
```

## Recovery pointers

- Regenerate affected evidence after a source, compiler, graph, price, manifest, or metadata change. Never patch generated hashes by hand.
- A changed hook bytecode digest or decoded seed intent invalidates the package. Rebuild the launch artifacts and re-run the seed verifier instead of changing a transaction by hand.
- OPEN FACT: `UNVERIFIED_LAUNCH_INTENT_PREIMAGE` lacks provider-supplied route namespace, route nonce, topology hash, target-id hashes, and serialized graph call data. Request those values through preflight and retain the non-signing draft until they are bound.
- Supply the API key only to the approved preflight path, fund the owner wallet before the owner-signed seed, and record builder identity through the designated evidence path. These inputs do not supersede owner action controls.
- When verification reports a changed byte, discard the generated output and rebuild from the frozen inputs rather than carrying a stale digest forward.
- OPEN FACT: `create-request.json` contains the recorded envelope and reproducible build evidence, but committed records do not establish the provider deployment descriptor, graph salts and call data, target runtime materialization, launch intent, or agent attestation. Resolve: retain the canonical provider capability copy and complete nested V4 schemas, then record the provider graph preimage and source commitment inputs. Verified alternative: retain the explicit-null template and stop before a provider POST.
- OPEN FACT: source coverage lacks a committed metadata image and attestation evidence file. Resolve: add both inputs with repository-relative paths, regenerate the package, and rerun the preflight. Verified alternative: keep the coverage declaration unresolved and reject a request locally.
- If `.reservation.lock` remains after an interrupted probe, verify that no probe process is active, inspect the retained numbered reservation, then remove only that exact lock before retrying. The helper never reclaims a lock automatically.

The native draft and materialized address schemas require optimizer 200 and viaIR. Historical v1 manifests retain optimizer 1000 without viaIR; a native manifest cannot reuse that compiler profile. `scripts/launch/derive-addresses.mjs` enforces the same split from `launchInputs.schemaVersion` (v1 historical, v2 native) and rejects artifacts compiled under the other profile; `scripts/mine-hook-address.mjs` provider mining selects the profile and constructor encoding from the ConstructorConfig field identity. `release/phase3/launch-inputs.example.json` is a v2 example and carries the native profile. The checked-in compiler exports under `release/phase3/artifacts/` identify their contract through `metadata.settings.compilationTarget` and omit `settings.metadata.useLiteralContent`; the deriver and miner read them in place, treat only the omitted key as the documented `false` default ([Solidity 0.8.26 metadata](https://docs.soliditylang.org/en/v0.8.26/metadata.html)), and keep every other identity and metadata check strict. `scripts/tests/launch-addresses.test.mjs` derives a native v2 manifest from those exports with synthetic local roles; that is build-only evidence, not a deployment or provider claim.
