> ## Audit status update (2026-09-04)
>
> The adversarial audit confirmed narrow local safeguards: canonical-pool callback checks,
> exact USDG balance-delta collection, and the absence of a deployed or authorized live path.
> It refuted or narrowed broad historical statements that the fee path, launch composition,
> Operations claims, and holder payout were complete and production-ready. The audit found
> unresolved launch, accounting, runner, and payout work that must remain fail-closed until
> their assigned work packages prove it. The authoritative finding dispositions are in
> [traceability.json](../../audit/2026-09-04/traceability.json); the approved Phase 3
> remediation boundary is the [Operations-wallet revision pointer](2026-09-04-phase3-operations-wallet.md).
> This status block preserves the handover record below and grants no live authority.

# Historical money-path audit and Programmable handover (2026-09-04)

Handover for the next session. Everything below was read from the current tree
(`codex/rehearsal-collector-only`, HEAD `0963f00`) or from live public
endpoints on 2026-09-03/04. Nothing was deployed, signed, broadcast or spent.

## 1. Where the closeout stands

- init, spec, architecture, redteam: PASSED on the current tree.
- feasibility: FAILED on F3, owner-overridden (`r-00608`, rationale: Programmable
  readiness for chain 4663 unavailable). The override authorizes no deployment,
  credentials, signing, broadcast, spending or publication.
- tasks: failed twice because `task project` stamps `generatedAt` into
  `tasks.json` on every run, so T1/T2/T3/T5 evidence recorded by hand was always
  stale. `scripts/owner-closeout.sh` now records that evidence itself after the
  projection (`0963f00`). Not yet re-run by the owner.
- Expected next owner run: `git pull && bash scripts/owner-closeout.sh` from
  the owner's local checkout with `HOOKEMON_NODE_BIN` pointing at a Node
  24.19.0 binary. Expected: tasks
  PASSED, build PASSED, stop at `ship` with a new override draft the owner reads
  and signs. Then commit `receipts/ STATE.md state.json tasks.json decisions/`
  and push; CI `gates` on PR #5 should turn green because `status --check` then
  sees fresh receipts.
- PR #5 (`codex/rehearsal-collector-only` -> `main`) is a draft, not merged.
  PRs #1-#3 stay open until #5 is confirmed merged.

## 2. Audit result: what the code enforces today

### 2.1 Hook fee path (contracts) - implemented, tested, fail-closed

- `HookemonHook.sol`: `beforeSwap`/`afterSwap` with return-delta permissions;
  `onlyPoolManager` on callbacks; `_collectFee` reads USDG balance before
  `poolManager.take`; `_usdgBalanceOf`/`_transferUsdg` reject malformed token
  responses.
- `FeeAccounting.sol`: split is compile-time: total 300 bps = programmable 10 +
  treasury 40 + process 250. Accrual reverts unless the hook's USDG delta equals
  the computed fee exactly (`InvalidCollectionDelta`); minimum executed 1_000
  units; cumulative remainders for programmable/project; solvency check after
  every accrual and claim; every transfer verified by exact source and
  destination balance deltas; `moneyPath` reentrancy lock.
- Beneficiaries (`MoneyRoles.sol`): programmable beneficiary is immutable and
  pinned to `0x4957f49620aff3adbbe8195a4f633e49cc93376c` by
  `RobinhoodBindings.validate`; treasury changes only via
  `proposeTreasury` (current treasury) + `acceptTreasury` (successor).
  `claimTreasury(beneficiary, destination)` requires caller == stored treasury
  and destination == treasury; `claimProgrammable` likewise for the pinned
  address. The hook can never be a destination.
- Not automated: no runner code calls `claimTreasury`/`claimProgrammable`
  (`fee-settlement.mjs` only plans and verifies). Treasury claims are a manual
  owner action from the treasury wallet.
- OPEN OWNER DECISION: "0.5 % treasury" in older notes = 0.4 % treasury +
  0.1 % programmable (as coded) or a separate 0.5 %? Owner has not answered.

### 2.2 Process budget -> vault escrow -> Relay outbound - GAP A

Contracts are correct: `PegCycleVault.authorizeFunding` (authorizer) ->
`HookemonHook.openPegCycle(cycleId)` (operations trigger; debits process
liability, transfers exactly `auth.amount` to the CREATE2 cycle escrow, vault
confirms escrow balance 0 -> amount, lifecycle EMPTY -> FUNDED) ->
`executeOutbound` (FUNDED only, operations trigger, frozen route digest,
reentrancy guard, exact escrow delta).

Runner gap: `packages/adapters/src/app/stages/funding.mjs` only broadcasts
`authorizeFunding`. No stage calls `openPegCycle`
(`buildOpenPegCycleCall` exists in `hook-contract-client.mjs`, unused).
`outbound.mjs` would revert with `InvalidLifecycle`. No fund loss, but no live
cycle can progress. Required: an `open-cycle` step between funding and
outbound, signed by the operations-trigger identity, finality-gated like the
other stages. Deadline: before any live/testnet cycle.

### 2.3 Solana collector leg - implemented and rehearsed live

`purchase`/`open`/`buyback` use Collector Crypt endpoints; proceeds are the
finalized Solana stablecoin balance delta, never the catalog `instantBuyback`; SPL-first
with Metaplex Core fallback and owner readback; missing token accounts abort.
Rehearsal proved 25 in, 17 realized, 10 x 1.70 paid on Solana (Solana stablecoin units).
Rehearsal wallet `4oy6t7zN8rHnL47m2f61dMLc9jjwqP4U5jheHGwdGW54` must never be
used in production.

### 2.4 Return leg (Relay Solana -> Robinhood) - implemented, never run live

`return.mjs` bridges the refund token account's actual balance via Relay into
the cycle return escrow; there is no `executeReturn` on the vault, Relay
credits the escrow passively. Short or ambiguous returns become DEGRADED and
need a signed owner acceptance (`recordDegradedReturn`). `authorizePayout`
requires the dual EIP-712 signatures (distribution signer + verifier, both
immutable vault identities). Relay has never been exercised live in either
direction.

### 2.5 Holder payout - GAP B

`distribution.mjs`: real snapshot from finalized `Transfer` logs, anchored to
`totalSupply`, exclusion set (vault, hook, PoolManager, pool custody, pinned
programmable beneficiary, current treasury, prior return escrows, zero,
`HOOKEMON_EXCLUDED_HOLDER_ADDRESSES`), one Merkle-sum chunk, throws above
1024 leaves (chunking shipped inactive). `payout.mjs`: `authorizePayout`, then
`fundPayoutFromPegCycle` - funds then sit in the hook as payout liability.

Runner gap: nothing calls `commitPayoutChunk` (manifest close; caller must be
the vault authorizer) or `payEntitlement` (per-holder settlement).
`packages/runner/src/distribution/settlement-worker.mjs` is complete but is
not wired into `bin/hookemon-runner.mjs` or the dashboard. Without this no
holder receives USDG. Required: a settlement stage that commits the chunk with
the authorizer and drives `settleDistribution` with a real `submitEntitlement`
bound to `payEntitlement`, journaled, retry-safe, treating
`EntitlementAlreadyPaid` as reconciliation. Deadline: before production.

Missing-wallet policy is moot for Robinhood holders (HKMN holders are EVM
addresses by definition); only the exclusion set applies.

### 2.6 Configuration / governance - open, nothing needs owner signature now

Unset for production: `HOOKEMON_VAULT_ADDRESS`, `HOOKEMON_HOOK_ADDRESS`,
`HOOKEMON_POOL_ADDRESS`, `HOOKEMON_HKMN_ADDRESS`, `HOOKEMON_TREASURY_ADDRESS`,
Relay and Collector API keys, and five distinct signer roles (authorizer EVM,
operations trigger, distribution signer, verifier, Solana). No contract is
deployed; `bindings/robinhood-chain.json` pool key is INTEGRATION_PENDING.
Rehearsal variables (`HOOKEMON_REHEARSAL_*`) must be absent in production.
See `docs/operations/production-env-checklist.md`.

## 3. Programmable Custom Launch - facts read on 2026-09-04

Sources: `https://programmable.market/.well-known/programmable.json`,
`GET https://api.programmable.market/v3/capabilities` (both public, no key
used). Copies were fetched to a scratch directory outside the repo (not committed).

- Discovery `chains`: `1: live`, `4663: planned`. Text: "Robinhood Chain V4 is
  planned and not deployed; its public routes stay disabled until deployment,
  policy, finality and indexing gates pass."
- `GET /v3/capabilities` binds to `chain.id = "1"` (chain 1 mainnet),
  profile `programmable.direct-native-hook-graph.v1`, revision 3, version
  `3.3.0`, `productionLaunchAuthorized: true`. Fresh submissions accept only
  `3.3.0`; `3.4.0` inactive.
- Consequence: a fresh V3.3 launch today would launch HKMN on chain 1, not
  Robinhood. There is no live Robinhood launch route. OPEN FACT for F3.
- The older `v4/chains/4663/capabilities` endpoint used by
  `scripts/verify-phase2-readiness.mjs#probeProgrammable` now returns
  `readiness.status = "ready"` (probe expects `"available"`), with deployment
  evidence for `robinhood-mainnet-custom-launch-v1` (tx
  `0x30617f...b8d08d`, block 50469365). The probe string must be checked
  against Programmable's documentation before F3 can be re-evaluated; the
  discovery document still says `planned`, so F3 stays open either way.
- Compiler admitted: exactly `0.8.26+commit.8a97fa7a`; exact standard JSON and
  source bytes required. Check `packages/contracts/foundry.toml` solc pin.
- Graph: 3-16 direct CREATE2 targets, one primary token, one hook, one pool;
  existing deployed contracts cannot be graph targets
  (`ROUTER_V1_COMPONENTS_MUST_MATCH_NEW_FACTORY_OUTPUTS`); existing ERC20
  quote currency (USDG) supported with exact pool-key binding.
- Fee: the 10 bps platform claim exists only in the fee-certified lane for
  the exact stamped PoolKey; an arbitrary custom-hook lane carries no
  automatic claim. Our hook already pins the programmable beneficiary and 10
  bps in `FeeAccounting`; lane choice must be decided with the owner.
- Metadata required for 3.3: name, symbol, description (>= 20 bytes), one
  website, one `https://x.com/...` link, one local PNG/JPEG/WebP/GIF plus its
  canonical public URI. Never invent these; ask the owner.
- Flow (CLI 3.3.9, never signs or broadcasts): `pack -> validate --remote ->
  submit -> status --watch --until authorized -> owner wallet ->
  status --until finalized`. Preflight consumes no quota/nonce and persists
  nothing. Submit and both wallet steps are owner actions.
- API key: env var `PROGRAMMABLE_API_KEY` only; scopes `custom-launch:create`,
  `custom-launch:read`. The key was not present in the Linux environment when
  checked. It must be provided as a session secret, never pasted into chat,
  files or command history. `scripts/check-cleanroom.mjs` rejects `pm_live_`
  shapes in the repo.
- Not yet read: remediation catalog
  (`policies/custom-launch-agent-remediation-v1.json`), pack-config schema,
  V3 OpenAPI, guide section `#existing-project-integration`. Read them before
  writing `programmable-launch.config.json`.

## 4. Plan for the next session

1. Owner: finish closeout (section 1), sign ship override, commit and push
   receipts; confirm CI green on PR #5; owner decides merge; then close
   PRs #1-#3.
2. Owner decisions needed: fee-split question (2.1); Programmable lane
   (fee-certified vs arbitrary hook); project metadata and image; whether to
   wait for Robinhood 4663 or prepare on the chain-1 profile only for dry runs.
3. Code work packages on new `codex/` branches, each with its own draft PR:
   - WP-A `open-cycle` stage (`openPegCycle`) between funding and outbound.
   - WP-B settlement stage (`commitPayoutChunk` + `settleDistribution` ->
     `payEntitlement`) wired into the runner binary, journaled.
   - WP-C Programmable launch package: read the four documents above, pin
     solc 0.8.26 exact build, write pack config, run `pack` and
     `validate --remote` only (preflight, no submit). Fix F3 probe string
     against documentation; record F3 as OPEN FACT with the 2026-09-04
     evidence.
4. Full Anvil-fork dry run: fee -> openPegCycle -> outbound -> return ->
   payout -> holder settlement, before any testnet or live budget.
5. Only afterwards: testnet/small live budget, one treasury claim from the
   hardware wallet, Relay live in both directions.

## 5. Clean-room finding (2026-09-04, blocks CI after closeout)

`node scripts/check-cleanroom.mjs .` fails on this branch with 33 findings,
all rule `historical-architecture`, in rehearsal code and docs (identifier
and prose uses of the Solana stablecoin ticker, also in camel-case identifiers, in
`packages/adapters/src/app/stages/rehearsal.mjs`,
`accounting-projection.mjs`, their tests, `docs/rehearsal/collector-only.md`,
`docs/modules/rehearsal-stage.md`, `docs/modules/composition-root.md`,
`docs/operations/production-env-checklist.md`). CI never reached this step
because `status --check` fails first on stale receipts. Once the owner's
closeout push makes `status --check` green, the `cleanroom` step will fail.
Required before merge: rename the identifiers and prose to a neutral term
(for example `solanaStable`) or record an owner decision that the rehearsal
lane is exempt. No production behavior changes.
