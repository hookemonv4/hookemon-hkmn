# Launch Orchestration

## Purpose

Launch Orchestration creates the Phase 3 canonical market and places its first LP position in permanent custody. Requirements revision 65 and architecture revision 9 define a three-target Programmable graph followed by a separate owner-signed seed transaction. Local tools produce deterministic, non-signing evidence only.

## Public interface

- `deriveNativePriceCandidate({nativeWei,hkmnAtomic})` derives the selected native-currency0 full-range seed tuple from explicit integer maxima. It consumes the complete HKMN stock and records exact native debt and refund; it supplies no default funding amount.
- `verifyMaterializedSeedTransaction` requires native ETH transaction value equal to `amount0Max`, including the refundable excess over exact debt. Historical zero-value funding fails validation; immutable calldata, destination, intent and deadline bindings remain mandatory.

- `HKMNToken.allocate(address canonicalMarket)` is the graph-only, one-time allocation call. It transfers the entire fixed HKMN supply to the hook.
- The graph runs exactly three ordered calls after token, custody, and hook deployment: `token.allocate(hook)`, `custody.configureBindingHook(hook)`, and `hook.initializeGraphLaunch(custody, sqrtPriceX96)`.
- `PermanentPositionCustody` is configured once with the hook and binds one verified PositionManager LP token. It has no HKMN remainder-custody role.
- `HookemonHook.initializeGraphLaunch(address custody, uint160 sqrtPriceX96)` verifies the issued token, custody binding, and frozen graph price before its self-call initializes the canonical pool under the `0x20CC` permission mask.
- `HookemonHook.seedCanonicalLiquidity(SeedParams)` is the later, owner-signed Permit2 path. It accepts 240 USDG (`240000000` atomic units) and the complete HKMN hook balance, mints the full-range position to custody, clears temporary approvals, and returns an unused USDG balance to the payer.
- `PhaseThreeReleasePlan` accepts only two exact full-consumption tuples: USDG-currency0 uses `sqrtPriceX96 = 161723809515207654588927258648643645224` and liquidity `489897948556635619`; HKMN-currency0 uses `sqrtPriceX96 = 38813714284914462669` and liquidity `489897948572597439`.
- `scripts/launch/derive-addresses.mjs`, `scripts/launch/build-address-manifest.mjs`, and `scripts/mine-hook-address.mjs` derive and verify the three-target graph, address ordering, pool identifiers, initializer bytes, and `0x20CC` hook address from frozen inputs and compiled artifacts.
- `scripts/programmable/build-launch-package.mjs` renders the checked-in graph draft or a disposable materialized package. Its package manifest declares the exact source-bundle coverage. `scripts/programmable/verify-launch-package.mjs` rederives the materialized address manifest, decodes the seed transaction, and checks its intent digest and committed bytes.

## Invariants

- The token has exactly 1,000,000,000 HKMN with 18 decimals. Allocation is 10,000 basis points to the canonical market and zero to every other allocation category.
- The token allocation selector, target, argument, count, and order are bound to the compiled ABI. A different selector, an added call, a reordered call, or a changed argument invalidates the graph.
- Graph initialization is atomic. An external pool initialization cannot pass `beforeInitialize`, and graph mode cannot use the non-graph initialization path.
- The graph seed consumes the full HKMN allocation. A residual HKMN balance in the hook reverts graph-mode seeding; it is never transferred to treasury or a separate custody balance.
- The seed position belongs to the configured PositionManager, exact PoolKey, full-range ticks, hook, and recorded liquidity before custody binds it. Permanent custody has no approval, transfer, withdrawal, fee-collection, rescue, upgrade, or delegation path.
- Before a materialized seed transaction can be presented for signing, the package verifier (`scripts/programmable/lib/seed-intent.mjs`) locally derives the expected intent digest and rejects a changed payer, lower or upper tick, liquidity, either maximum, or deadline; a deadline more than 900 seconds after the reference execution timestamp also fails. This is a JavaScript pre-signing check, not an on-chain hook or release-plan invariant: the checked-in `HookemonHook.sol` and `PhaseThreeReleasePlan.sol` implement neither an immutable seed-intent digest nor a deadline-window enforcement.
- The seed leg remains one-shot. A rejected intent or deadline leaves the completed graph, unseeded state, refunds, and dust handling unchanged.
- `LaunchLeg.t.sol`, `PhaseThreeReleasePlan.t.sol`, and `RobinhoodV4ArchiveFork.t.sol` cover the bound-field mutations at the hook, executable pre-sign plan, and pinned archive-fork layers.
- The provider graph has no native or ERC-20 funding leg. The later seed is the only USDG pull and does not change graph allocation, custody configuration, pool initialization, or launch stamp.
- Derivation and package tools do not read credentials, contact a provider, sign, or broadcast.
- A preflight source manifest cannot be materialized until its declared attestation evidence and metadata image are committed. Package coverage never substitutes unrelated evidence or a guessed asset path.

## State transitions

- Frozen source and owner inputs produce an `ADDRESS_DERIVATION_PENDING` local graph draft.
- The accepted three-call graph moves the deployed targets from unallocated to allocated, initialized, and unseeded in one transaction.
- A successful seed moves the canonical market to seeded-and-custodied. A seed failure rolls back only that seed attempt and leaves the completed graph available for retry.
- A provider-supplied graph preimage can materialize route values, target identifiers, call data, and derived addresses. It does not authorize a wallet action.

## Operational commands

```sh
node scripts/programmable/rebuild-phase3-release.mjs
node --test scripts/tests/launch-addresses.test.mjs scripts/tests/phase3-launch-package.test.mjs
node scripts/programmable/verify-launch-package.mjs --allow-unverified
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/launch/LaunchLeg.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/launch/LaunchComposition.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/release/PhaseThreeReleasePlan.t.sol' -vv
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol' -vv
```

## Recovery pointers

- Rebuild the release package after any token, hook, custody, price, compiler, or source commitment changes; do not hand-edit generated artifacts.
- If decoded seed calldata no longer matches the package verifier's locally derived seed-intent digest, or sets `deadline` later than 900 seconds after the execution block timestamp, reject it and rebuild the materialized package from the frozen inputs before requesting a wallet action.
- OPEN FACT: the provider-supplied launch-intent preimage is absent. The missing values are route namespace, route nonce, topology hash, target-id hashes, and serialized graph call data for the accepted three-call graph. Obtain them from provider preflight; until then retain the non-signing draft without encoded call data or target addresses.
- OPEN FACT: the source-bundle coverage declaration lacks an attestation evidence file and selected metadata image. Add both paths and regenerate the package; the verified alternative keeps source preflight unavailable.
- Keep `PROVIDER_API_KEY_PENDING`, `OWNER_WALLET_FUNDING_PENDING`, and `BUILDER_IDENTITY_PENDING` as their separate preflight or operational inputs. None changes the allocation or creates signing authority.
- If a materialized address ordering does not select one approved price tuple, rebuild from the frozen inputs and reject the candidate rather than forcing an ordering.
