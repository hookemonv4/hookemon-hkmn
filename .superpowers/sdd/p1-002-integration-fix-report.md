# P1-002 integration hardening report

## Result

P1-002 now binds a domain-separated operation identity, callback sender, and exact HKMN recipient across the complete before/after callback context. A finalized buy records the positive raw HKMN output only for that authenticated recipient. The local recipient-aware router proves the same amount reaches the recipient's token balance in both token orders and exact-input/output buys.

The independent blind P1-002 adapter is active. P1-004 liability, claim, beneficiary, adversarial-token, solvency, and permanent-custody authority paths remain quarantined, as do the explicitly named production-only checks.

## RED evidence

- Baseline market surface: 13/13 passing before new tests.
- Recipient/hook-data RED: 13 passing and 2 intended failures. Malformed, zero-operation, zero-recipient, and encoded-sender mismatch data were accepted; the authenticated recipient credit getter/amount was absent.
- Concrete blind adapter RED: 4 passing and 2 intended failures. Zero recipient/operation identity was accepted and exact recipient HKMN credit was absent.

The RED tests were added before production changes. Production was then changed minimally around hook-data decoding/context binding and recipient credit, with each focused suite rerun to GREEN.

## GREEN evidence

- `CanonicalMarketCallbackSurface.t.sol`: 16/16 passing, including real PoolManager/recipient-router balance deltas in all four buy quadrants.
- `test/blind/market-fees/*.t.sol`: 14/14 passing, including 6/6 concrete adapter acceptance tests and 2/2 active schema-readiness tests.
- Completed full contracts run: 39/39 passing. It used `--offline` and explicit `--lib-paths lib/v4-core --lib-paths lib/v4-periphery` to prevent Foundry from initializing unrelated upstream Git histories. This run finished before the later narrow-local-only instruction and was not repeated.
- `forge fmt --check --root packages/contracts`: passing.
- Bundled Node 24 controls: 81/81 passing across `reqs.test.mjs`, `control-dependencies.test.mjs`, and `cleanroom.test.mjs`; direct clean-room scan passed for 414 text files.

## Files

- `packages/contracts/src/market/CanonicalMarket.sol`: exact 128-byte hook-data decoder, full callback binding, recipient credit and observation fields/event.
- `packages/contracts/test/market/CanonicalMarketCallbackSurface.t.sol`: focused binding/credit tests and real PoolManager recipient-router coverage.
- `packages/contracts/test/blind/market-fees/BlindCanonicalMarketAdapter.t.sol`: concrete independent P1-002 adapter and acceptance suite.
- `packages/contracts/test/blind/market-fees/fixtures/BlindMarketFeesFixture.sol`: frozen callback sender, operation, recipient, live-fee, and finalized-delta fields.
- `packages/contracts/test/blind/market-fees/BlindMarketFeesSchemaReadiness.t.sol`: active P1-001 schema checks.
- `packages/contracts/test/blind/market-fees/BlindMarketFeesAcceptance.t.sol` and `TEST_MATRIX.md`: explicit P1-004 quarantine and active P1-002 boundary.
- `docs/modules/canonical-market.md`: current callback schema, recipient boundary, local proof, and named production blockers.

## Commits

- `6afeed9 fix(canonical-market): bind authenticated swap recipients`
- `9430cd2 test(canonical-market): activate blind callback acceptance`
- `7d4be09 docs(canonical-market): record callback binding boundary`

## Preserved invariants

- Static LP fee remains zero; nonzero static/live LP or protocol fee fails before economic mutation.
- The inclusive fee remains 300 bps; existing fee collection, fee/volume separation, and P1-004 split rounding are unchanged.
- Partial fills, callback/context mismatches, fee-delta mutation, nested finalization, and reverts collect no fee and accrue no volume or recipient credit.
- Token settlement stays in the router/PoolManager path; the callback records authenticated credit but gains no new token-transfer or custody authority.
- Permanent non-project-controlled custody and every deployment/authorization boundary are unchanged.

## Caveats and deferred production checks

Only required pinned v4-core/v4-periphery dependencies were used. Foundry 1.7.1 attempted recursive initialization when invoked against the broad `lib` directory, so verification commands constrained library discovery instead of fetching unrelated upstream histories. The host Node 20 runtime lacked `node:sqlite`; the bundled Node 24 runtime ran the read-only controls. No frozen architecture module expansion or generated dependency evidence change was necessary.

Production remains fail-closed under `DEPLOYED_ROBINHOOD_POOLMANAGER_CALLBACK_AND_SETTLEMENT_FORK`, `EXACT_OUTPUT_USDG_Q_GROSS_NET_AND_FEE_CUSTODY_SEMANTICS`, final canonical PoolKey/hook/HKMN/custody identities and runtime, `ROUTER_AND_PROVIDER_ZERO_SURCHARGE_INTEGRATION_PROOF`, and deployed post-custody buy/sell verification. No push, deployment, signature, broadcast, spend, secret access, or production RPC action occurred.

## Independent review closure

### Router settlement context

RED: two new real-PoolManager tests both failed because `RecipientPoolSwapTest` could settle HKMN to an address different from the authenticated hook-data recipient and because the hook accepted any callback sender that self-declared the same sender in hook data.

GREEN: `CanonicalMarketCallback` now binds a nonzero immutable `swapRouter`; the strict hook-data decoder is shared with the recipient-aware router; and the router verifies its own sender plus exact settlement-recipient equality after the real PoolManager callback but before settlement. The mismatch reverts with `InvalidSettlementContext` and atomically rolls back fee collection, volume observation, recipient credit, and token movement. The complete surface suite passes 18/18.

### Blind PoolKey and finalized-delta paths

RED: the PoolKey mutation test failed because the concrete adapter ignored `BlindPoolKey.poolId`. A second focused RED showed that an out-of-range `int256` final delta could truncate to an accepted `int128` value.

GREEN: the adapter and its fixture-facing read now use the v4 `PoolIdLibrary` derivation, reject any supplied/derived PoolId mismatch, and reject both currency deltas outside the `int128` domain before conversion. Active blind vectors independently exercise recomputed currency order, tick spacing, hook address, mismatched PoolId, zero HKMN output, same-sign deltas, out-of-range deltas, and specified-delta mutation; every rejection proves an unchanged economic digest. The concrete blind suite passes 8/8.

Review fix commit: `716d209 fix(canonical-market): authenticate router settlement and pool identity`. Only the surface and concrete blind P1-002 suites plus `forge fmt` were rerun; the earlier broad and Node gates were not repeated.
