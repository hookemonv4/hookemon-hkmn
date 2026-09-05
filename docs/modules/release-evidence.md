# Release Evidence

## Purpose

Release Evidence builds and verifies the Phase 3 package without treating local evidence as live readiness. It binds requirements revision 65 and architecture revision 9 to the current token, hook, custody, compiler, graph draft, and owner inputs. It never authorizes deployment, signing, broadcast, funding, or publication.

## Public interface

- `scripts/programmable/rebuild-phase3-release.mjs` compiles the three Phase 3 targets with the pinned launch profile and regenerates release artifacts, package data, submission, deployment manifest, Solidity draft constants, and source commitments.
- `PhaseThreeReleasePlan.Draft` pins chain 4663, the graph roles, target template hashes, a 1,000,000,000-HKMN supply, a full canonical-market allocation, zero other allocation, a 240-USDG seed, full-range ticks, the 10/40/250 basis-point fee split, and one exact price-order tuple.
- The two approved seed tuples consume all 240 USDG atomic units and the full HKMN allocation. USDG-currency0 uses `161723809515207654588927258648643645224` at liquidity `489897948556635619`; HKMN-currency0 uses `38813714284914462669` at liquidity `489897948572597439`.
- `buildLaunchPackage()` and `verifyLaunchPackage()` render and verify the checked-in `ADDRESS_DERIVATION_PENDING` graph draft or a separately written materialized package. Verification may use `--allow-unverified` for local review; it does not change readiness.
- `scripts/verify-deployment-manifest.mjs`, `scripts/verify-release-package-closure.mjs`, and the Phase 3 test suite check template identity, complete package closure, graph shape, source commitments, code-size headroom, and genesis evidence.
- `decisions/owner-inputs/launch-inputs-owner.json` records the 240-USDG owner budget decision and the approved X profile `https://x.com/hookemon4`. `decisions/owner-inputs/programmable-acceptance.json` records route acceptance on 2026-09-05 and the accepted 10-basis-point `FEE-01` share on 2026-09-04.
- `scripts/programmable/preflight.mjs` loads the Phase 3 package from `HEAD`, requests public chain-4663 capabilities before the advertised read-only preflight route, and writes a sanitized evidence record under `release/phase3/preflight/`. `--dry-run` prints no-network request data; `--status <requestId>` uses the advertised status route.

## Invariants

- A local build, package check, draft validation, or archive measurement is evidence only. Each remains separate from `launchEligible` and external-action authority.
- The checked-in graph contains exactly `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody,sqrtPriceX96)`. The allocation call has one address argument.
- The token allocation is complete: no remainder custody, treasury allocation, or non-circulating HKMN allocation appears in the release contract, graph, manifest, or submission.
- The owner-recorded route and fee acceptance resolve the former provider-confirmation and platform-share decision records. The X profile is recorded metadata, not a pending owner input.
- The draft's unverified input set is exactly `UNVERIFIED_LAUNCH_INTENT_PREIMAGE`, `PROVIDER_API_KEY_PENDING`, `OWNER_WALLET_FUNDING_PENDING`, and `BUILDER_IDENTITY_PENDING`. The first is limited to provider-supplied graph values; the remaining three are explicit preflight, funding, or identity inputs.
- A package mismatch in source bytes, ABI, artifact hashes, Standard JSON, metadata bytes, price tuple, graph call, manifest closure, or code-size headroom invalidates the generated output and requires a rebuild.
- The launch profile remains solc `0.8.26+commit.8a97fa7a`, 1,000 optimizer runs, `viaIR: false`, Cancun, no bytecode hash, and no CBOR metadata.
- Preflight compares the committed profile, commit/tree/package roots, package digests, caller, deployer, graph transaction chain/target/value, exact typed 240-USDG Permit2 allowance, deadline ceiling, and refund destination. It cannot create, submit, sign, or broadcast a launch.
- `PROGRAMMABLE_API_KEY` is accepted only from the process environment. It never appears in a request body, standard output, error output, or preflight evidence; secret-looking provider response fields are removed before evidence is written.

## State transitions

- Frozen inputs generate `ADDRESS_DERIVATION_PENDING` evidence with local integrity only.
- A matching verifier run preserves that state while the provider graph preimage is absent.
- A provider response containing the exact graph preimage can create a materialized candidate for preflight review. It remains non-signing until every separate live prerequisite is current and the owner authorizes the action.
- A matching response writes evidence and prints a wallet handoff. Any mismatch writes evidence, prints numbered differences, and exits nonzero. Status polling is read-only and does not alter evidence or provider state.

## Operational commands

```sh
node scripts/programmable/rebuild-phase3-release.mjs
node --test scripts/tests/phase3-bytecode-binding.test.mjs scripts/tests/phase3-launch-package.test.mjs scripts/tests/phase3-price-oracle.test.mjs
node scripts/programmable/verify-launch-package.mjs --allow-unverified
node scripts/verify-deployment-manifest.mjs
node scripts/verify-release-package-closure.mjs
export $(cat ~/.hookemon/programmable.env) && node scripts/programmable/preflight.mjs
node scripts/programmable/preflight.mjs --dry-run
node scripts/programmable/preflight.mjs --status <requestId>
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/release/PhaseThreeReleasePlan.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/release/PhaseThreePriceOracle.t.sol' -vv
```

## Recovery pointers

- Regenerate affected evidence after a source, compiler, graph, price, manifest, or metadata change. Never patch generated hashes by hand.
- OPEN FACT: `UNVERIFIED_LAUNCH_INTENT_PREIMAGE` lacks provider-supplied route namespace, route nonce, topology hash, target-id hashes, and serialized graph call data. Request those values through preflight and retain the non-signing draft until they are bound.
- Supply the API key only to the approved preflight path, fund the owner wallet before the owner-signed seed, and record builder identity through the designated evidence path. These inputs do not supersede owner action controls.
- When verification reports a changed byte, discard the generated output and rebuild from the frozen inputs rather than carrying a stale digest forward.
- OPEN FACT: the current package does not contain the provider-required materialized V4 request fields. Resolve route namespace, route nonce, target hashes, serialized graph calls, addresses, and the launch intent; commit the complete request and rerun preflight against that exact commit. Until then, the command can only record a read-only provider rejection or mismatch.
