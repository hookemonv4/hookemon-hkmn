# Phase 2 Launch Plan — Autonomous Peg Cycle on Robinhood Chain

> **Superseded on 2026-09-04.** This document is retained as historical Phase 2 evidence. The active handoff is [release/phase3/launch-plan.md](../phase3/launch-plan.md); its inputs and assertions take precedence over the historical claims below.

## 1. Scope and status

This document extends `packages/contracts/script/release/PhaseOneReleasePlan.sol`'s pattern — a
frozen deployment plan plus a read-only, non-executing verifier — to Phase 2's new contracts: the
per-cycle `PegCycleReturnEscrow`, the chunked payout stack (`PayoutCommitment`,
`CanonicalMerkleSum`, `HolderSettlement`), and the off-chain distribution-signer/verifier pairing
that gates every payout commitment before it reaches `PayoutCommitment` on-chain.

Like `PhaseOneReleasePlan`, this plan **exposes no transaction-execution entrypoint**. It is
release-readiness evidence, not a deployment tool, and it does not itself sign, broadcast, deploy,
spend, or read secrets. Every field below is either a value already fixed by shipped, tested source
(cited by file) or is explicitly `INTEGRATION_PENDING` — never silently omitted.

**Current status: `INTEGRATION_PENDING`.** Programmable's Robinhood Chain profile is not available
(discovery lists chain 4663 `status: "planned"`; the v4 capabilities endpoint returns
`readiness.status: "unavailable"`, `reasonCodes: ["ROBINHOOD_CHAIN_PROFILE_UNAVAILABLE"]`, verified
2026-09-02). This plan cannot be executed until that external precondition resolves; see
`scripts/verify-phase2-readiness.mjs` for the live, non-blocking re-probe of this and every other
external precondition Phase 2 depends on.

## 2. Plan fields — knowable today

These mirror `PhaseOneReleasePlan.Plan`'s pattern (one struct field per identity/hash the on-chain
verifier would check) extended for the new contracts. Values are cited from shipped source and
`bindings/robinhood-chain.json`; nothing here is invented.

| Field | Value | Source |
|---|---|---|
| `chainId` | `4663` | `bindings/robinhood-chain.json` |
| `usdg` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `bindings/robinhood-chain.json` (`contracts.usdg`) |
| `usdgDecimals` | `6` | `bindings/robinhood-chain.json` (`contracts.usdg.metadata.decimals`) |
| `poolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `bindings/robinhood-chain.json` (`contracts.poolManager`) |
| `positionManager` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | `bindings/robinhood-chain.json` (`contracts.positionManager`) |
| `liquidityLauncher` | `0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0` | `bindings/robinhood-chain.json` (`contracts.liquidityLauncher`) |
| `uerc20Factory` | `0x000000e200088D55C39a11F609E5F667729ad49b` | `bindings/robinhood-chain.json` (`contracts.uerc20Factory`) |
| `programmableBeneficiary` | `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c` | `RobinhoodBindings.PROGRAMMABLE_BENEFICIARY` (pinned, immutable) |
| `hookPermissionMask` | `0x00CC` (`BEFORE_SWAP`, `AFTER_SWAP`, `BEFORE_SWAP_RETURNS_DELTA`, `AFTER_SWAP_RETURNS_DELTA`) | `HookemonHook.REQUIRED_HOOK_PERMISSION_MASK`, `HookemonHook.getHookPermissions()` |
| `staticLpFee` | `0` | `RobinhoodBindings.STATIC_LP_FEE` |
| `totalHookFeeBps` | `300` (3.00%) | `RobinhoodBindings.TOTAL_HOOK_FEE_BPS` |
| `programmableFeeBps` | `10` (0.10%) | `RobinhoodBindings.PROGRAMMABLE_FEE_BPS` |
| `treasuryFeeBps` | `40` (0.40%) | `RobinhoodBindings.TREASURY_FEE_BPS` |
| `marketAllocationBps` | `9000` (90%) | `RobinhoodBindings.MARKET_ALLOCATION_BPS` |
| `wholeHkmnSupply` | `420,690,000,000` whole HKMN | `HookemonIssuance.WHOLE_HKMN_SUPPLY` |
| `hkmnDecimals` | `18` | fixed by the deployment harness (`packages/contracts/test/launch/HookemonIssuance.t.sol`); not yet an on-chain constant |
| `hkmnInitialSupply` | `420690000000000000000000000000` base units | `WHOLE_HKMN_SUPPLY * 10^18` |
| `payoutTreeWidth` | `1024` leaves per chunk | `CanonicalMerkleSum.TREE_WIDTH` |
| `chunkCount` | `1` (chunked payouts implemented and tested, shipped inactive — decision D5) | `packages/contracts/test/payout/*.t.sol`, `packages/runner/test/integration/chunked-payout.test.mjs` |
| `dustCarryForward` | `true` (dust carries forward across cycles, never swept — decision D6) | `FeeAccounting` cumulative-remainder invariants, `docs/modules/fee-accounting.md` |
| `escrowComputation` | `PegCycleVault.computeCycleEscrow(cycleId)` — deterministic CREATE2 per cycle | `packages/contracts/src/process/PegCycleVault.sol` |
| `escrowRuntimeDigest` | keccak256 of `PegCycleReturnEscrow`'s creation code (recomputed per plan, not pinned here) | `packages/contracts/src/process/PegCycleReturnEscrow.sol` |
| `distributionSignerRole` | worker's own key (the "distribution-signer") | `decision D7 (MODIFIED)` |
| `distributionVerifierRole` | a separately-keyed, separately-hosted automated verifier that independently recomputes the snapshot/manifest and signs only on an exact match | `decision D7 (MODIFIED)` |
| `humanSignaturePerCycle` | `false` (fully automated; a manual mode may exist as a non-default option) | `decision D7 (MODIFIED)` |
| `onChainPauseRole` | none added (existing FAILED/DEGRADED terminal states plus a dashboard pause are the only kill switch) | `decision D8`, `ADR-0021` |
| `remainderRepresentation` | `PLACEHOLDER_OWNER_DECISION`: a timelocked treasury-custody contract stub, conservative LBP curve | `decision D10` (owner confirmation pending) |
| `perCycleSpendCap` | `PLACEHOLDER_OWNER_DECISION`: one configured pack purchase plus bridge fees per cycle | `decision D4` (owner-signed standing authority drafted by WP-21, unsigned as of this plan) |
| `maxCyclesPerDay` | `PLACEHOLDER_OWNER_DECISION`: `72` | `decision D4` (owner-signed standing authority drafted by WP-21, unsigned as of this plan) |

## 3. Plan fields — explicitly `INTEGRATION_PENDING`

Every field below is presently unknowable and is recorded as `INTEGRATION_PENDING`, never omitted:

| Field | Status | Blocking dependency |
|---|---|---|
| `hkmnAddress` | `INTEGRATION_PENDING` | WP-20 (custom `LiquidityLauncher` strategy + `HookemonIssuance` wiring) |
| `hookAddress` (CREATE2-mined) | `INTEGRATION_PENDING` | WP-20, hard-gated on WP-25's router resolution below |
| `universalRouter` (which of the two candidates is live) | `INTEGRATION_PENDING` — two candidates on record: repo-pinned `0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99` vs. Uniswap's public deployments-page value `0x8876789976decbfcbbbe364623c63652db8c0904` | WP-25 (`scripts/verify-phase2-readiness.mjs`, on-chain runtime-codehash probe) |
| `canonicalPoolKey` (currency0/currency1 ordering, tickSpacing, PoolId) | `INTEGRATION_PENDING` — depends on final on-chain address comparison between USDG and the not-yet-minted HKMN address | WP-20 |
| `routeExecutorAddress` / `routeExecutorRuntimeDigest` | `INTEGRATION_PENDING` — `IPegCycleRouteExecutor` is an interface only; no concrete implementation exists in this tree yet | WP-28 (`PegCycleRouteExecutor.sol`) |
| `escrowDeployedRuntimeDigest` (per-cycle, actually observed) | `INTEGRATION_PENDING` — no cycle has been opened against a real deployment | depends on `hookAddress`, `canonicalPoolKey` |
| `automatedCycleServiceBinding` | `INTEGRATION_PENDING` — `operations.keeper`'s actor is a design-level description, not yet a merged, tested scheduler | WP-07 / WP-14 |
| `distributionSignerKeyMaterial` / `distributionVerifierKeyMaterial` | `INTEGRATION_PENDING` — no key material is generated, held, or referenced by this plan | out of scope for this repository (owner infrastructure) |
| `ownerSignedStandingAuthority` (the actual signature over `perCycleSpendCap`/`maxCyclesPerDay`) | `INTEGRATION_PENDING` — WP-21 drafts the unsigned owner-approval document; no signature exists yet | owner action, outside this repository |
| `programmableOfficialLaunchProfileId` | `INTEGRATION_PENDING` | external (Programmable's Robinhood profile is not `readiness:available`) |
| `chainDeploymentDigest` | `INTEGRATION_PENDING` | depends on every address above |

## 3a. Programmable custom-launch profile (verified 2026-09-03)

`https://api.programmable.market/v4/chains/4663/capabilities` now publishes a concrete
`chainDeployment` for a Robinhood custom-launch route, distinct from the general readiness status
in §3 above (still `unavailable`, unchanged since 2026-09-02):

| Field | Value | Status |
|---|---|---|
| `chainDeploymentId` | `robinhood-mainnet-custom-launch-v1` | fixed by the provider |
| `launchStampRouter` | `0x34965F2A2ee9254522232C32F02056E92BE0C98a` | address fixed; runtime code hash `INTEGRATION_PENDING` (not yet independently probed) |
| `permitAuthority` | `0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06` | address fixed; runtime code hash `INTEGRATION_PENDING` (not yet independently probed) |
| `finalityPolicy` | `robinhood-stage-finality-v1` | fixed by the provider |
| `toolchain` | solc `0.8.26` | fixed by the provider |
| `readiness.status` | `unavailable` | unchanged from §1/§3 — nothing may be submitted through this route yet |

Routes: preflight `POST /v4/chains/4663/custom-launches/preflight`, create
`POST /v4/chains/4663/custom-launches`, status `GET /v4/chains/4663/custom-launches/{launchId}`.
All three require a bearer API key with scopes `custom-launch:create` and `custom-launch:read`
(capabilities and finalized metadata need no key). The key is supplied only through the
`HOOKEMON_PROGRAMMABLE_API_KEY` environment variable read by the (not yet implemented) launch
step, on the operator machine only — it is never written into this repository, the journal, or the
dashboard. `bindings/robinhood-chain.json`'s `market` fields are not changed by this plan; they are
written only by the launch step itself, once a real launch actually completes.

## 4. Verification plan (read-only, non-executing)

Mirroring `PhaseOneReleasePlan.validate`/`verifyDeployedRuntime`'s two-stage pattern — a static
plan-consistency check followed by a live runtime-code check — the Phase 2 equivalent, once the
pending fields above resolve, verifies:

1. **Plan consistency** (static, no chain read): every identity in the extended plan (`usdg`,
   `programmableBeneficiary`, `poolManager`, `hkmnAddress`, `hookAddress`, `routeExecutorAddress`,
   every per-cycle `computeCycleEscrow(cycleId)` result) is pairwise distinct, matching
   `PhaseOneReleasePlan._validate`'s duplicate-identity check extended with the two new
   identities (route executor, escrow computation authority).
2. **Hook and escrow CREATE2 address recomputation**: `computeCreate2Address` (already generic in
   `PhaseOneReleasePlan`) re-derives the hook address from the mined salt and init-code hash, and
   `PegCycleVault.computeCycleEscrow(cycleId)` re-derives each cycle's escrow address the same way
   the contract itself does internally — never trusting an externally supplied escrow address.
3. **Deployed runtime code check** (live, once addresses exist): extend
   `verifyDeployedRuntime`'s pattern to also require nonzero, expected runtime code at
   `hkmnAddress`, `hookAddress`, and (once WP-28 ships) `routeExecutorAddress`, in addition to the
   Phase 1 set (`usdg`, `positionManager`, `expectedVault`, `expectedHook`).
4. **Fee-split and permission-mask assertion**: confirm the deployed hook's `getHookPermissions()`
   and the on-chain `REQUIRED_HOOK_PERMISSION_MASK` match `0x00CC` exactly, and that
   `RobinhoodBindings.PROGRAMMABLE_BENEFICIARY`/`TOTAL_HOOK_FEE_BPS`/`PROGRAMMABLE_FEE_BPS`/
   `TREASURY_FEE_BPS` are unchanged from §2 — a changed value stales this plan.
5. **Distribution dual-signature check** (off-chain, before any on-chain payout commitment):
   confirm the distribution-signer and the separately-keyed distribution-verifier both signed the
   exact same recomputed snapshot/manifest digest before `PayoutCommitment` is called — this plan
   records the *requirement*, not a live check, since no signer/verifier key material exists in
   this repository.

None of the above is implemented as an executable script in this package; WP-19 prepares the plan
and its evidence table only, per its acceptance criteria. A future package that implements the
extended Solidity verifier (mirroring `PhaseOneReleasePlan.sol`) should bind directly to this
document's field table rather than re-deriving it.

## 5. Operational commands (evidence already produced)

```sh
forge fmt --check --root packages/contracts
forge test --root packages/contracts --match-path 'test/process/*.t.sol' -vvv
forge test --root packages/contracts --match-path 'test/payout/*.t.sol' -vvv
forge test --root packages/contracts --match-path 'test/settlement/*.t.sol' -vvv
forge test --root packages/contracts --match-path 'test/bindings/*.t.sol' -vvv
node --test packages/runner/test/integration/chunked-payout.test.mjs
node --test packages/runner/test/integration/degraded-return.test.mjs
node --test packages/runner/test/integration/dust-fast-path.test.mjs
node feasibility/verify-robinhood-binding.mjs bindings/robinhood-chain.json
node scripts/verify-phase2-readiness.mjs bindings/robinhood-chain.json
node scripts/verify-phase2-readiness.mjs --offline
node /path/to/programmable-v4-hook-builder/scripts/validate-submission.mjs release/phase2/submission.json --repository-root .
```

## 6. What cannot proceed until external readiness changes

No work package should be blocked *waiting* on Programmable's Robinhood profile; this plan and
`release/phase2/submission.json` are built now and simply cannot execute their final step. The
single action that directly depends on the missing fact — an actual submission/registration call
to Programmable, and any real on-chain deployment against `chainId: 4663` — waits. Everything else
(contracts, tests, the off-chain automation, dashboard, and this evidence) proceeds independently,
per `AGENTS.md` R5.
