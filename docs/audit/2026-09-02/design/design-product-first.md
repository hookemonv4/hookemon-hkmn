# Hookemon Product-First Design: Autonomous Community Cycle

## 1. Summary of the target system (15 lines)

HKMN is a community token on Robinhood Chain (4663), launched through Programmable's launchpad on a canonical USDG/HKMN Uniswap v4 pool whose sole hook (`HookemonHook`) charges an inclusive 3.00% swap fee, split 0.10% Programmable + 0.40% treasury + 2.50% process budget. A fully autonomous loop, ticking by default every 20 minutes (owner-adjustable via a dashboard), pulls the accrued 2.50% process share into a single-cycle custody vault (`PegCycleVault`), bridges it from Robinhood USDG to Solana Circle USD via Relay, buys one Collector Crypt pack, opens it, sells the card back through Collector Crypt's standard buyback (not "Bybit" — no Bybit integration exists anywhere in the codebase or its history), bridges the Circle USD proceeds back to Robinhood USDG, and pays every HKMN holder their pro-rata share permissionlessly through a depth-10 canonical Merkle-sum settlement contract. A dashboard lets the owner choose packs, change the interval, pause/resume, and kick stuck cycles; a public page shows community-facing cycle status. Today the contracts implement the accounting, custody-lifecycle and settlement primitives correctly and are unit/invariant-tested (171/171 forge tests locally), but every provider integration (Collector Crypt, Relay, Solana, Robinhood RPC) in the runner is fixture-only, there is no scheduler, no dashboard, no npm dependencies for real signing, and the contracts have five concrete gaps versus policy and the owner's autonomy goal: no cumulative-remainder / no-1000-unit-floor fee enforcement, an immutable single-router binding that blocks every standard wallet and the Trading API, a `FAILED`-is-absorbing vault with no recovery, a 1024-holder hard cap with no chunking, and no owner-independent kill switch. Programmable's Robinhood Chain profile is not yet available for production launch (status `unavailable`), so the token cannot be issued on 4663 today regardless of code readiness. This design closes the product gaps in dependency order, keeps every external action (spend, sign, broadcast, deploy) behind an explicit owner-approved standing-authority grant, and defines a dry-run mode so the whole system is buildable and demonstrable now, with only the final "flip live" step waiting on Programmable and funded keys.

## 2. Architecture

### 2.1 Components

```
Dashboard (packages/dashboard)
  ├─ backend: node:http API + JSON state store (config, cycle history, pause flag)
  └─ frontend: static admin UI + public community status page

Scheduler + Cycle Worker (packages/runner/src/automation, src/scheduler)
  ├─ interval loop (owner-configurable, default 20 min) + exclusive lease
  ├─ budget gate (available process liability vs. required spend)
  ├─ 8-stage CycleRunner driver: funding → outbound → purchase → open → buyback → return → distribution → payout
  └─ stuck-cycle reconciliation (dual-observer supersede, escrow-successor recovery)

Provider adapters (packages/runner/src/providers)
  ├─ Robinhood EVM RPC + contract client (PegCycleVault, ProcessBudget, HookemonHook reads/writes)
  ├─ Collector Crypt REST client (generatePack/openPack/buyback/status)
  ├─ Relay bridge client (USDG↔Circle USD quote/status, both directions)
  └─ Solana RPC + policy-constrained signer (execution wallet)

Distribution pipeline (packages/runner/src/distribution)
  ├─ holder snapshot indexer (finalized HKMN Transfer-log → balances)
  ├─ pro-rata manifest compiler (rounding rule, ≤1024-leaf chunking)
  ├─ Merkle-sum tree + owner/verifier signing
  └─ payout submitter / keeper (drives HolderSettlement.payEntitlement per leaf)

Fee-settlement worker (packages/runner/src/automation/fee-settlement-worker.mjs)
  └─ periodic claimProgrammable / claimTreasury against the hook

Configuration & secrets (packages/runner/src/config)
  └─ per-cycle caps, key material boundary, kill-switch flag, dry-run toggle

Observability (packages/runner/src/observability)
  └─ structured cycle log, alert hooks, stuck-cycle heuristics

Contracts (packages/contracts/src)
  └─ HookemonHook / CanonicalMarket / FeeAccounting / ProcessBudget / PegCycleVault(+escrow) /
     PayoutCommitment / CanonicalMerkleSum / HolderSettlement / HookemonIssuance / RobinhoodBindings
```

### 2.2 Trust boundaries

- **On-chain immutable core** (HookemonHook and everything it composes): trusted by construction once deployed; no admin key can alter fee split, permission mask, or custody rules. This boundary is the safety backstop — every off-chain compromise is bounded by what these contracts will accept.
- **Vault authority boundary** (`authorizer` on `PegCycleVault`): a single EOA/multisig that can authorize funding and payout amounts up to the vault's actual balance, routed only through the immutable, pinned `routeExecutor`. Compromise here can misdirect one cycle's principal to the routeExecutor's allowed destinations, but cannot mint HKMN, cannot touch the 90% permanent liquidity, and cannot exceed the vault's balance.
- **Operations-trigger boundary** (`operations` on `ProcessBudget`/`PegCycleVault`): per ADR-0019, this identity is trigger-only — it can start a cycle and call `executeOutbound`, but it never receives, routes, or custodies funds directly (`packages/contracts/src/access/MoneyRoles.sol`, `packages/contracts/src/process/ProcessBudget.sol`). Compromise here can grief timing (start/stall cycles) but cannot steal principal.
- **Execution-wallet boundary** (Solana signer): holds real Circle USD during the pack-buy/open/buyback leg. This is the highest-value off-chain key in a live cycle (up to one pack price + gas). Must be policy-constrained (allowlisted program IDs, destinations, amounts) the way `packages/runner/src/automation/policy-wallets.mjs` on `codex/complete-v4-hook` demonstrates, not a raw keypair.
- **Distribution-signer boundary** (owner + independent verifier keys in `packages/runner/src/distribution/manifest.mjs`): authorizes what the holder-payout Merkle root actually pays. Compromise here can misdirect the *entire returned proceeds of one cycle* to attacker-chosen "holders" — this is the second-highest-value key and is recommended to stay owner-held (see §11, decision C).
- **Claim boundary** (`programmableBeneficiary`, `treasury` on `FeeAccounting`): self-claim-only by construction (`claimProgrammable`/`claimTreasury` force `destination == beneficiary`, `packages/contracts/src/HookemonHook.sol`), so this key can only ever move funds to itself — low risk, recommended to stay owner-held and decoupled from the autonomous worker entirely.
- **Dashboard boundary**: mutates configuration only (pack list, interval, pause/resume, restart request) — never signs, spends, or broadcasts. A dashboard compromise can misconfigure or pause the loop, never steal funds directly, because every config change still routes through the worker's own on-chain-bounded caps.
- **Guardian/kill-switch boundary** (new, §3): a role held by the owner, separate from every worker-held key, that can pause new-cycle starts without moving any funds — the one control that survives a full worker-machine compromise.

### 2.3 Custody and authority model

The worker process (scheduler + cycle driver) runs unattended and must hold, at minimum: the `operations` EVM key (low value, trigger-only), the `vault-authorizer` EVM key (bounded by vault balance + immutable routeExecutor), and a Solana execution-wallet key wrapped in a policy-wallet (bounded by an explicit allowlist + per-tx amount cap). It must **not** hold the `treasury`/`programmable` claim keys or the `distribution-signer` keys — those stay with the owner or a separate, lower-frequency service, so that a compromise of the always-on worker cannot redirect either the platform's own fee entitlement or a cycle's entire holder payout. Every worker-held key operates under an explicit per-cycle cap (pack price + outbound/return slippage tolerance + gas caps, mirroring `decideCycleBudget` in `packages/runner/src/automation/budget-gate.mjs` on `codex/complete-v4-hook`) and a rolling window cap (24h outflow ceiling, mirroring the legacy `journal.js` pattern at `apps/operator/src/journal.js` on `mainnet-cycle-canary`, reimplemented clean-room). Key material itself is never embedded in source or logs; recommended storage is an OS keychain (macOS Keychain, reusing the *pattern*, not the code, of `packages/integrations/src/macos-keychain.js`) or an equivalent encrypted-at-rest local store, loaded once at process start.

### 2.4 Data flow for one cycle (numbered, with signer)

1. **Tick** — scheduler timer fires (no key). Checks the dashboard's `paused` flag and the on-chain guardian pause bit (read-only call, no key); checks `activeCycleId == null`.
2. **Budget read** — worker reads `ProcessBudget`/`FeeAccounting` liability views on Robinhood RPC (read-only). `decideCycleBudget` compares available process liability to `packPrice + outboundCap + returnCap + operatingMargin`; if insufficient, waits for next tick.
3. **Fund the vault** — `vault-authorizer` key signs `PegCycleVault.authorizeFunding(FundingAuthorization)`; `operations` key signs `ProcessBudget.openPegCycle(cycleId)`, which internally consumes the authorization and moves USDG hook→vault (`packages/contracts/src/process/PegCycleVault.sol`, `ProcessBudget.sol`).
4. **Bridge out** — `operations` key signs `PegCycleVault.executeOutbound(cycleId, routeData)`, pushing vault USDG to the immutable `routeExecutor`. The execution-wallet's Solana leg and the Relay bridge transaction (Robinhood USDG → Solana Circle USD) are signed by the **Solana policy-wallet** key, quoted and submitted through `RelayClient`.
5. **Buy the pack** — worker calls Collector Crypt `POST /api/generatePack`, receives an unsigned Solana tx, signs it with the **execution-wallet** key (policy-checked: destination = Collector's known program/prize-wallet, asset = Circle USD, amount = pack price only), submits, polls `/api/pack/status`.
6. **Open the pack** — worker calls `POST /api/openPack`; if not turbo, waits on the webhook/status poll; records the drawn card.
7. **Sell the card (buyback)** — worker calls Collector Crypt's standard buyback (`GET /api/buyback/available`, `POST /api/buyback`) within the 72-hour window to the original prize wallet, signs the returned unsigned tx with the **execution-wallet** key, submits.
8. **Bridge back** — worker requests a Relay quote/status for Solana Circle USD → Robinhood USDG, signs with the **execution-wallet** key, and directs proceeds to the cycle's per-cycle return escrow (`PegCycleReturnEscrow`, adopted from `codex/phase2-revision-57`).
9. **Return authorization** — once USDG is confirmed in the escrow, **`vault-authorizer`** key signs `PegCycleVault.authorizePayout(PayoutAuthorization)` binding `rootSum`/`minimumReturnUsdg`; **`operations`** key signs the hook-side `fundPayoutFromPegCycle` call (via `PayoutCommitment`) that pulls the escrow balance into the hook and credits `payoutLiability` (`packages/contracts/src/payout/PayoutCommitment.sol`).
10. **Compile the distribution** — off-chain: holder snapshot indexer reads finalized HKMN `Transfer` logs at the return block, excludes pool/escrow/hook/treasury/vault addresses, computes each holder's pro-rata share of the returned amount, builds the depth-10 Merkle-sum manifest.
11. **Approve the distribution** — the **owner's distribution-signer** key (not worker-held, see §2.3) signs the candidate distribution approval; a second, independent **verifier** key (also owner/ops-held, not the cycle worker) signs the 3-copy reconstruction receipt (`packages/runner/src/distribution/manifest.mjs`). This is the one step that still requires a human/HSM action per cycle under the recommended custody model (§11, decision C) — it can be automated later under a separate, explicit owner-approved standing grant.
12. **Pay holders** — worker (no privileged key needed — `HolderSettlement.payEntitlement` is permissionless) calls the settlement contract once per manifest leaf (up to 1024 per payoutId), tracked by the payout submitter/keeper until every leaf shows `isPaid`.
13. **Settle fees** — independently, on its own schedule, the fee-settlement worker (running with the **treasury** and **programmable** keys, never the cycle worker's keys) calls `claimProgrammable`/`claimTreasury`.

### 2.5 Recovery model

- **Stuck (external mutation broadcast but never observed)**: reuse `CycleRunner.reconcileUnresolvedIntent` / `supersedeUnobservedIntent` (`packages/runner/src/cycle/cycle-runner.mjs`, `reducer.mjs`, ported from `codex/complete-v4-hook`) — requires dual-observer proof (provider + RPC, both "not found, finalized") plus a fresh owner-signed authorization before replacing a stalled broadcast.
- **Failed at `OUTBOUND` with zero vault balance**: `recordTerminalFailure` → adopt `codex/phase2-revision-57`'s per-cycle CREATE2 escrow + `authorizeFundingAfterFailure` to start a clean successor cycle without redeploying the hook.
- **Failed at `OUTBOUND` with a nonzero, wrong-amount balance (today: no transition, permanently stuck)**: WP-06 relaxes `recordTerminalFailure` to accept a nonzero balance, sweeping it to a documented recovery destination (process budget) via the same `routeExecutor`-gated exact-transfer pattern, then allows `authorizeFundingAfterFailure` as normal. This closes the single worst dead-end found in the audit (`packages/contracts/src/process/PegCycleVault.sol` suspicion at the `recordTerminalFailure`/`authorizePayout` boundary).
- **`RETURNED` blocked by a stray dust deposit** (today: `authorizePayout` requires balance `== rootSum` exactly, so any third-party donation into the vault permanently blocks payout): WP-06 also relaxes this to `balance >= rootSum`, transferring exactly `rootSum` and leaving dust for a later sweep, closing the second worst dead-end.
- **Expired pending funding/payout authorization**: adopt rev57's `cancelExpiredFundingAuthorization` / `renewFundingAuthorizationDeadline` / `renewPayoutAuthorizationDeadline`.
- **Dashboard "restart/kick"**: maps to `resume` (replay + continue) and `reconcile` (supply fresh external evidence) operator-control verbs already designed on rev57 (`packages/runner/src/operator/control.mjs`), extended with a "force-fail-and-recover" verb that invokes the WP-06 relaxed `recordTerminalFailure` path when a cycle cannot otherwise be resolved.

### 2.6 Kill switch

Two independent layers, because a soft (off-chain) switch alone cannot survive a compromised worker:

1. **Soft switch** — dashboard `paused` flag in the operator state file; the scheduler checks it every tick before starting a new cycle. Instant, no gas, but only effective if the worker process is honest.
2. **Hard switch** — a new `guardian` role on `ProcessBudget` (WP-03), held by an owner-controlled key that is never given to the always-on worker, whose only capability is to set a `paused` bit that `openPegCycle` checks and reverts on. It cannot move funds, cannot alter fee split, cannot touch an already-`FUNDED`/`OUTBOUND` cycle (those must still be recovered through the normal lifecycle) — it only blocks *new* cycles from starting. This is deliberately minimal so it cannot become a second custody boundary.

## 3. Contract changes before deployment (file by file)

- **`packages/contracts/src/accounting/FeeAccounting.sol`** — add (a) a revert when a single swap's gross USDG quote is below 1,000 smallest units (closes GAP-2 in `skill-and-prs.json`), and (b) a persisted cumulative-remainder tracker per the single canonical pool (programmable and "project" — treasury+process — remainders survive across swaps and are only zeroed at accrual, never at claim) so split-swap flooring cannot permanently starve the Programmable owner's 0.10% entitlement (closes GAP-1). **Spec consequence**: new `REQ-fee-accounting-6` ("minimum gross quote and cumulative remainder conservation") in requirements revision 58; ADR amendment to ADR-0016.
- **`packages/contracts/src/bindings/RobinhoodBindings.sol`** — `validate()` gains a check that `binding.programmableBeneficiary == 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c` (closes GAP-4; today only non-zero/non-self is checked). **Spec consequence**: `REQ-provider-binding-4` amendment.
- **`packages/contracts/src/market/CanonicalMarket.sol`** and **`packages/contracts/src/HookemonHook.sol`** — relax the immutable single-router binding: accept any `msg.sender` router, keep the fee-taking and quadrant logic unconditional (fee is enforced regardless of caller), and make `hookData`'s `sender`/`recipient` fields optional for HKMN-credit attribution — a swap without valid `hookData` still pays the correct fee but simply is not eligible for `buyerHkmnCredit` bookkeeping. This is the single highest-impact contract change: today only one pinned `swapRouter` address can swap at all, which excludes every standard wallet, the Uniswap UI, aggregators, and the Trading API (`skill-and-prs.json` GAP analysis; `CanonicalSwapHookData` domain check in `CanonicalMarket.sol`). **Spec consequence**: this rewrites `REQ-canonical-market-2`/`-3` and needs a fresh requirements-revision proposal (58) plus a new ADR (superseding the router-binding rationale in the current design) — flagged as an explicit owner decision in §11 because it changes a security property the redteam already reviewed once.
- **`packages/contracts/src/process/ProcessBudget.sol`** — add the `guardian`-role pause bit described in §2.6 (new role, two-step propose/accept like the existing treasury/operations pattern in `MoneyRoles.sol`, capability strictly limited to gating `openPegCycle`). **Spec consequence**: new `REQ-process-budget-6`.
- **`packages/contracts/src/process/PegCycleVault.sol`** (+ new `PegCycleReturnEscrow.sol`, adopted from `codex/phase2-revision-57`) — adopt per-cycle CREATE2 escrow, `authorizeFundingAfterFailure`, `cancelExpiredFundingAuthorization`, deadline renewal; additionally relax `recordTerminalFailure` to accept nonzero balance (sweep) and relax `authorizePayout`/`consumePayoutAuthorization` to accept balance `>= rootSum` (transfer exactly `rootSum`, leave dust) per §2.5. **Spec consequence**: bumps `REQUIREMENTS_REVISION` to 58 (rev57 already claimed 57 for the escrow-only slice; this design's additional dust/degraded-return relaxation is new scope on top of rev57 and needs its own REQ, e.g. `REQ-cycle-control-2`).
- **`packages/contracts/src/payout/PayoutCommitment.sol`** — fix the `payoutId == bytes32(0)` sentinel collision in `PayoutAlreadyFunded` (contracts-payout suspicion) by using an explicit `funded` boolean per record instead of overloading `payoutId != 0`. Low-risk, high-value hardening; no spec change needed (bug fix, not behavior change).
- **`packages/contracts/src/settlement/HolderSettlement.sol`** — replace the hardcoded `1024` literal with `CanonicalMerkleSum.TREE_WIDTH` (contracts-payout suspicion); no behavior change.
- No change is proposed to `CanonicalMerkleSum.sol`'s fixed depth-10/1024-leaf shape for the initial launch (see §11 decision F on holder-count scale) — chunking is handled off-chain by minting multiple `payoutId`s against one cycle's returned proceeds, which the existing `PayoutCommitment` data model already supports per-`payoutId`; only the vault's payout-authorization step needs the `>= rootSum` relaxation from WP-06 to let a single returned balance fund several sequential payoutIds.

## 4. Offchain services (file by file)

### `packages/runner/src/automation/` (new, adapting `codex/complete-v4-hook`'s design, clean-room reimplemented)
- `scheduler.mjs` — interval loop (`setInterval`/async loop), reads interval from dashboard config, checks pause flags (soft + hard), calls the cycle worker.
- `exclusive-lease.mjs` — CAS-based lease so only one worker instance runs a cycle at a time (port of the audited, dependency-free design at `packages/runner/src/automation/exclusive-lease.mjs` on `codex/complete-v4-hook`, 4/4 tests passing there).
- `budget-gate.mjs` — `decideCycleBudget` port (pure function, 5/5 tests passing on `codex/complete-v4-hook`).
- `automated-cycle-service.mjs` — 8-stage driver (`funding, outbound, purchase, open, buyback, return, distribution, payout`) wrapping `CycleRunner`, dependency-injected provider adapters.
- `fee-settlement-worker.mjs` — periodic `claimProgrammable`/`claimTreasury`, running under separate treasury/programmable keys, decoupled from the cycle worker process.

### `packages/runner/src/providers/` (new — the actual production integrations; today every path throws `INTEGRATION_PENDING`)
- `robinhood-rpc.mjs` — read/write client for `PegCycleVault`, `ProcessBudget`, `HookemonHook`: `eth_call` reads (liability views, lifecycle state), transaction building/signing/broadcast for `openPegCycle`, `authorizeFunding`, `executeOutbound`, `authorizePayout`, `fundPayoutFromPegCycle`, `claimProgrammable`, `claimTreasury`. Requires a finalized-block-only read policy (mirroring the hardened `feasibility/verify-robinhood-binding.mjs` pattern from `codex/complete-v4-hook`: explicit `finalized` tag, `eth_getProof`-derived codehash checks before trusting any contract).
- `collector-crypt.mjs` — real REST client per `docs.collectorcrypt.com/gacha/api`: `generatePack`, `openPack`, `getBuyback`/`buyback`, `submitTransaction`, `getPackStatus`, `getMachines`. Mirrors the API shape already evidenced (not reused code) in `packages/integrations/src/collector-crypt.js` on `mainnet-cycle-canary`.
- `relay.mjs` — `POST /quote/v2`, `GET /intents/status/v3` for both directions (Robinhood USDG → Solana Circle USD and back), request/response validation, polling with backoff.
- `solana.mjs` — Solana RPC submitter (simulate → send → poll finality) + a policy-constrained signer (allowlisted program IDs: Collector Crypt program, Relay deposit program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`; allowlisted destination accounts; per-tx amount cap).

### `packages/runner/src/distribution/` (extends existing fixture-verified modules with real inputs)
- `snapshot-indexer.mjs` — finalized `Transfer(address,address,uint256)` log scan for the HKMN token from genesis (or last checkpoint) to a target finalized block, incremental/resumable, excludes pool/escrow/hook/treasury/vault addresses (configurable exclusion set), produces the `hookemon.input-bound-hkmn-snapshot-candidate.v1` shape `reconcile.mjs` already expects (`packages/runner/src/distribution/reconcile.mjs`).
- `pro-rata.mjs` — computes each holder's `amountAtomicUSDG` from `(holderBalance / totalCirculatingSupply) * closedProceedsBasis.finalCredit.amount`, floors per holder, and carries the remainder into the process-budget bucket for the next cycle (explicit, documented rounding rule — none exists in the repo today, confirmed by `runner-distribution.json`'s autonomy-gap finding). Chunks the holder list into ≤1024-entry manifests, minting one `payoutId` per chunk against the same cycle's proceeds (relies on the WP-06 `>= rootSum` vault relaxation).
- `payout-submitter.mjs` — keeper loop: for every funded `payoutId`, iterate leaves not yet `isPaid`, call `HolderSettlement.payEntitlement`, retry with backoff, record failures for the dashboard's stuck-cycle view.

### `packages/runner/src/config/` (new)
- `secrets.mjs` — loads key material from the OS keychain / encrypted store at process start; never logs, never round-trips through the dashboard.
- `cycle-config.mjs` — pack selection list, interval, per-cycle caps, rolling-window cap, dry-run toggle; the single source the dashboard's config-mutation endpoints write to.

### `packages/runner/src/observability/` (new)
- `cycle-log.mjs` — structured, append-only cycle event log (reuses the existing journal/receipt patterns already proven in `packages/runner/src/cycle/journal.mjs`).
- `alerts.mjs` — pluggable alert sink (webhook/email stub first; the repo's own `ops/HANDOFF.md` already documents that no alert channel has ever been test-fired — this closes that gap with at least one real, testable channel).
- `stuck-cycle-detector.mjs` — elapsed-time heuristics per lifecycle stage, feeding the dashboard's "stuck" indicator.

## 5. Dashboard

- **Audience**: two surfaces from one backend — an owner-authenticated control surface, and an unauthenticated public community status page.
- **Auth**: mutation endpoints require a bearer token (long-lived, owner-issued, checked with a timing-safe comparison — the same pattern already used for `OPERATOR_CONTROL_PROXY_CREDENTIAL` on the legacy branch, reimplemented clean-room); read-only status endpoints are public.
- **Storage**: extends the rev57 operator state-file pattern (`packages/runner/src/operator/state-file.mjs`: exclusive lock, revision-CAS, atomic write) with a cycle-history collection and a `dashboardConfig` document (pack list, interval, paused).
- **API** (all JSON):
  - `GET /public/status` — current cycle stage, last N cycles' summaries, total distributed, holder count. No auth.
  - `GET /public/history?cursor=` — paginated cycle history. No auth.
  - `GET /api/config` — current pack list / interval / paused state. Auth required.
  - `PUT /api/config` — body `{packs: string[], intervalMs: number, paused: boolean}`. Auth required; validated against `packages/runner/src/operator/pack-selection.mjs`-style snapshot schema.
  - `POST /api/cycle/pause` / `POST /api/cycle/resume` — soft kill switch toggle. Auth required.
  - `POST /api/cycle/restart` — invokes the operator-control `resume`/`reconcile`/force-fail-and-recover verbs from §2.5. Auth required.
  - `GET /api/cycle/:id` — full evidence for one cycle (journal, receipts, distribution manifest digest). Auth required.
- **Pages**: owner control panel (pack picker, interval slider, pause/resume, cycle list with restart buttons, per-cycle drill-down); public community status page (current stage, recent payouts, total distributed to date).
- **Tech**: dependency-free `node:http` + static HTML/CSS/vanilla JS, matching the repository's existing zero-npm-dependency posture (`product/dependency-pins.json`) unless §11 decision D (npm onboarding) is taken, in which case a minimal static bundler may be added — kept out of the runner's dependency surface either way.

## 6. Dependency and signer decision

**Recommendation: adopt pinned npm dependencies (`viem` for EVM, `@solana/web3.js` for Solana) behind a coordinated, explicit onboarding work package**, rather than continuing hand-rolled EVM/Solana primitives.

Rationale: the contracts package (Foundry/Solidity) already depends on external code by design (Uniswap v4-core/periphery submodules), and the one evidenced *working* real integration in this codebase's history (`mainnet-cycle-canary.js` on the legacy branch) is built entirely on `viem` and `@solana/web3.js`/raw JSON-RPC — hand-rolling transaction encoding, ABI decoding, and Solana instruction building for two chains is exactly the kind of low-level, security-sensitive surface (the repo's own `feasibility/verify-robinhood-binding.mjs` already reimplements `keccak256` from scratch three separate times across `packages/contracts/tooling/payout/canonical-merkle-sum.mjs`, `packages/runner/src/cycle/vault-payout-authorization.mjs`, and `packages/runner/src/distribution/merkle-sum.mjs` — each a maintenance/drift risk the audit flagged) where a maintained, audited library is safer than another from-scratch implementation. The offsetting cost is real: adding npm packages requires a lockfile, a CI install step, and a coordinated 3-way hash update (workflow file, `product/dependency-pins.json`, `scripts/verify-control-dependencies.mjs`'s `SUPPORTED_*` constants) per the control plane's own supply-chain gate (`control-plane.json`). This is scoped as its own work package (WP-21) precisely because it is a security-relevant, gate-breaking change that must not be silently bundled into a provider-adapter PR.

Alternative considered and rejected for now: an external signer/RPC gateway service (e.g., a hosted Privy-style policy-wallet API, as used for the "production" pipeline on the legacy branch). This is a stronger custody model long-term (keys never touch the worker process at all) but introduces a new third-party trust dependency and a recurring cost before the owner has approved any live spend; recommended as a *Phase 2b* upgrade to the Solana execution-wallet boundary specifically (§2.3), not a Phase 2 blocker.

## 7. Launch path via Programmable on 4663

**Can be prepared now** (no external readiness required):
- `submission.json` per the builder skill's schema: `projectSurfaces`/`projectCapabilities` (declaring the hook as an `onchain-contract`, the runner as a `keeper` + `external-provider` consumer, the dashboard as an `api-service`/`web-app`), the root `programmableFee` record (rate split, immutable owner `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c`, canonical PoolKey, quote asset USDG, self-call policy `same-pool-swap-forbidden` since the hook never self-initiates a swap), `accounting.minimumGrossQuoteUnits: 1000`, `accounting.liabilityKeyDimensions: [poolId, currency, owner]` (satisfied in practice by the single-pool architecture; document the invariant explicitly per GAP-3 in `skill-and-prs.json`).
- Launch plan document: chain, deployer, CREATE2 salts, expected hook/vault addresses, constructor arguments, required post-deploy reads, rollback limitations (per `security-and-evidence.md` §6 "Deployment plan").
- A custom `LiquidityLauncher` strategy: the stock `InstantLaunchStrategy` is hookless/native-ETH/1e9-supply and unusable for HKMN's hooked, USDG-denominated, 420,690,000,000-supply launch (confirmed fact in the task context); a bespoke strategy contract (or an LBP-migration path via the pinned `LBPStrategy` at `0x05d552391067389EE44fec3924157ed33F976000`) must be designed and reviewed before any launch transaction is possible, independent of Programmable's chain-profile readiness.
- Hook CREATE2 address mining: offline script producing a salt whose deployed address's low 14 bits equal `0x00CC` for the *final* constructor arguments (must be re-run after every contract change in §3, since constructor args are part of the CREATE2 preimage).
- Custody construction: `PermanentPositionCustody` deployment plan for the 90% permanent LP position, matching the existing `packages/contracts/src/bindings/RobinhoodBindings.sol` design.

**Waits on external readiness**:
- Any transaction that actually calls Programmable's launch APIs or deploys to Robinhood Chain mainnet — blocked until `GET /v4/chains/4663/capabilities` reports readiness other than `unavailable` (currently `ROBINHOOD_CHAIN_PROFILE_UNAVAILABLE`).
- Final Universal Router address resolution — the repo's pinned `0x06afBA43fd06227fA663b0dAecF536f6EaA6BF99` differs from Uniswap's currently-published `0x8876789976decbfcbbbe364623c63652db8c0904` for chain 4663 (`skill-and-prs.json` criticalDiscrepancy, corroborated independently by `branch-complete-v4-hook.json`'s `bindings/robinhood-chain-current-official.json`); this must be re-probed with a fresh finalized-RPC read immediately before any live deployment, not assumed from either cached value. With the router-binding relaxation in §3 (accept any router), this discrepancy stops being launch-blocking for swap functionality, but the binding manifest's pinned address still needs reconciliation for evidence/documentation purposes.
- Real Collector Crypt / Relay API keys and a funded process-budget + execution-wallet — required only for the first *live* cycle, not for building or testing the system (see §12 dry-run mode).

## 8. Process artifacts

- **Requirements revision 58 outline** (new REQ ids, statements):
  - `REQ-fee-accounting-6`: "Every canonical-pool swap enforces a 1,000-smallest-quote-unit minimum (revert below) and accrues into a cumulative, never-reset remainder per (poolId, currency, beneficiary) for the Programmable and project fee streams."
  - `REQ-canonical-market-6`: "The canonical pool accepts a swap from any caller; the fee split and solvency invariants apply unconditionally; `hookData`-bound recipient credit is an optional attribution mechanism, not a swap-eligibility gate."
  - `REQ-process-budget-6`: "A `guardian` role, distinct from `operations`/`treasury`/`programmable`, can pause and unpause new `openPegCycle` calls without any capability to move, claim, or redirect funds."
  - `REQ-cycle-control-2`: "A failed or dust-blocked `PegCycleVault` cycle at any nonzero balance can be recovered (swept and superseded) without redeploying the hook or vault." (Builds on rev57's `REQ-cycle-control-1`.)
  - `REQ-holder-distribution-scale-1`: "A single cycle's returned proceeds may be committed and paid across multiple `payoutId`s (chunked ≤1024 holders each) drawn from one authorized return balance."
  - `REQ-automation-1`: "An interval-driven scheduler may start, drive, and recover pack cycles unattended, subject to a dashboard-configurable interval, a dashboard-configurable pause flag, and an owner-held guardian pause that the scheduler cannot override."
  - `REQ-dashboard-2`: "An authenticated dashboard may mutate pack selection, interval, and pause state, and may request cycle restart/reconciliation; it may never sign, spend, or broadcast directly."
- **ADR-0021 outline**: "Autonomous Cycle Authority and Circuit Breaker" — supersedes/extends ADR-0019 by defining which off-chain keys the worker may hold (§2.3), the guardian pause mechanism (§2.6, §3), and the explicit boundary that treasury/programmable claim keys and the distribution-signer key stay outside the always-on worker.
- **Owner-approval drafts needed** (unsigned, `decisions/owner-approvals/*.json`, schema `v4-owner-approval-v2`): approval for requirements revision 58 (S5), approval for the router-binding relaxation specifically (given it revisits a redteam-reviewed security property), approval for the standing custody/authority grant in ADR-0021 (a new autonomy tier beyond anything in the current `policy/policy.json` "Ask first"/"Never" lists — spending, signing, and broadcast currently always require explicit per-action owner approval; a scheduler needs a *standing* grant, which is the single largest process change this design requires), approval for npm dependency onboarding (§6/WP-21).
- **Delivery-boundary / CI / policy changes**: `product/delivery-boundary.json` must open a Phase 2 delivery window (today `phases: {1: OPEN, 2: CLOSED, 3: CLOSED}` in `scripts/check-delivery-boundary.mjs`); `scripts/check-delivery-boundary.mjs`'s `OPERATIONAL_ROOTS` may need a registry for the new `packages/dashboard` and `packages/runner/src/providers` trees; task deferral must be widened from its current hardcoded `P1-011`-only restriction (`scripts/lib/ledger.mjs`) once P1-011's Phase 2 successor tasks exist; if WP-21 (npm) is taken, `.github/workflows/v4-gates.yml`, `product/dependency-pins.json`, and `scripts/verify-control-dependencies.mjs` need the coordinated 3-way update described in §6.
- **Task cards**: fresh numbering starting at `P2-013` (both existing unmerged branches already claim `P2-001..012`: `codex/phase2-revision-57` for the CREATE2-escrow/operator-CLI slice, `codex/complete-v4-hook` for its own unrelated `P2-001..004` — reusing either range would collide; `P2-013` onward avoids both).
- **Docs to update**: `docs/modules/dashboard.md` (currently explicitly "Phase 2 Only, not active" — becomes the real contract card once P1-011's successor ships), `docs/modules/peg-cycle-vault.md` (recovery-path additions), `docs/modules/cycle-runner.md` (production provider wiring), new `docs/modules/{scheduler,distribution-pipeline,dashboard}.md`.

## 9. Test and evidence strategy

- **Unit**: `forge test` for every contract change in §3 (new revert-threshold tests, cumulative-remainder fuzz tests extending `packages/contracts/test/accounting/FeeAccounting.t.sol`'s existing extreme-value pattern, guardian-pause tests, relaxed-recovery-path tests extending `packages/contracts/test/process/PegLegacyVaultRecovery.t.sol`'s pattern from rev57); `node --test` for every new runner module, following the existing zero-flakiness bar (every module reviewed in this audit passed 100% with zero skips).
- **Fixture end-to-end**: extend the existing fixture-cycle harness (`packages/runner/test/cycle/fixture-cycle.mjs`, `verify-fixtures.mjs`) to exercise the new chunked-distribution and guardian-pause paths before any real provider is wired.
- **Forked/anvil integration for the hook path**: a new Foundry fork test against a pinned Robinhood-chain block, running the real `PoolManager`/`UniversalRouter` (once the router address is reconciled per §7) with the relaxed router-binding from §3, replacing today's `RobinhoodV4PoolManager.t.sol`'s hand-written stand-in hook with the real `HookemonHook`.
- **Dry-run mode against real read-only RPC/APIs**: every provider adapter in §4 ships a `dryRun: true` mode that performs real GET/`eth_call` reads (Collector Crypt `/api/status`/`/api/machines`, Robinhood RPC finalized reads, Relay quote-only calls) but never signs or broadcasts — this is the default mode until the owner explicitly funds and approves live execution (§12).
- **Live canary gating**: a single manual one-pack run (mirroring the legacy branch's `mainnet-cycle-canary.js` shape, rebuilt clean-room) must succeed, reviewed by the owner, before the scheduler is ever allowed to run unattended against real funds — this is the same "manual canary before automation" sequencing the legacy branch itself followed.

## 10. Ordered work packages

| # | ID | Title | Parallel? |
|---|----|----|----|
|1|WP-01|Fee-policy conformance (min-quote revert + cumulative remainders)|Y (with WP-02..04)|
|2|WP-02|Router-binding relaxation + programmable-beneficiary pin|Y|
|3|WP-03|Guardian pause / circuit breaker|Y|
|4|WP-04|PayoutCommitment sentinel-collision + HolderSettlement literal fix|Y|
|5|WP-05|Adopt rev57 PegCycleReturnEscrow + failure-successor lifecycle|after WP-01..04 land|
|6|WP-06|Stranded-fund / dust recovery relaxation|after WP-05|
|7|WP-07|Scheduler + lease + budget-gate core|Y (contracts-independent)|
|8|WP-08|Collector Crypt production adapter|Y|
|9|WP-09|Relay bridge production adapter|Y|
|10|WP-10|Solana RPC + policy-wallet signer|after WP-21 (needs @solana/web3.js) or standalone if hand-rolled|
|11|WP-11|Robinhood EVM RPC + contract adapter|after WP-21 (needs viem) or standalone|
|12|WP-12|Holder snapshot indexer|Y|
|13|WP-13|Pro-rata manifest compiler + chunking|after WP-06 (needs vault relaxation) and WP-12|
|14|WP-14|Payout submitter / settlement keeper|after WP-13|
|15|WP-15|Fee-claim settlement worker|Y|
|16|WP-16|Configuration & secrets management|Y|
|17|WP-17|Observability (log/alerts/stuck-cycle detector)|Y|
|18|WP-18|Dashboard backend API + state store|after WP-16|
|19|WP-19|Dashboard frontend (admin + public status page)|after WP-18|
|20|WP-20|Programmable launch prep artifacts|Y|
|21|WP-21|npm dependency onboarding (viem + @solana/web3.js)|Y, early|
|22|WP-22|Process artifacts (rev58, ADR-0021, owner-approval drafts, delivery-boundary/CI, task cards, docs)|Y, first (unblocks everything else's authority)|

### WP-01 — Fee-policy conformance
- **Goal**: close GAP-1/GAP-2: revert swaps with gross USDG quote below 1,000 units; persist cumulative platform/project remainders that survive claims.
- **Dependencies**: none.
- **Write set**: `packages/contracts/src/accounting/FeeAccounting.sol`, `packages/contracts/src/market/CanonicalMarket.sol` (add the minimum-quote revert in `_fee()`), new/updated tests in `packages/contracts/test/accounting/FeeAccounting.t.sol`, `packages/contracts/test/accounting/FeeAccountingInvariant.t.sol`.
- **Read set**: `<builder-skill>/references/programmable-fee-policy.md`, `standard-fee-kernel.md`.
- **Tests**: `forge test --match-path 'test/accounting/*.t.sol'`; extend the existing extreme-value fuzz (`type(uint256).max`) with a below-1000 boundary table and a multi-swap cumulative-remainder regression.
- **Acceptance criteria**: a swap with gross quote 1–999 units reverts; 100 sequential 999-unit swaps accrue the same total Programmable liability (within one unit) as one 99,900-unit swap.
- **Risk class**: R3 (money-moving contract logic).
- **Parallel**: yes, independent of WP-02..04.

### WP-02 — Router-binding relaxation + programmable-beneficiary pin
- **Goal**: accept any caller as swap router while keeping fee enforcement unconditional; make hookData-based recipient credit optional; pin `programmableBeneficiary` to the policy-mandated address in `RobinhoodBindings.validate()`.
- **Dependencies**: none (parallel with WP-01/03/04); requires the owner decision in §11-B before merge.
- **Write set**: `packages/contracts/src/market/CanonicalMarket.sol`, `packages/contracts/src/HookemonHook.sol`, `packages/contracts/src/bindings/RobinhoodBindings.sol`; new tests in `packages/contracts/test/market/CanonicalMarketCallbackSurface.t.sol`, `packages/contracts/test/bindings/RobinhoodBindings.t.sol`.
- **Read set**: `packages/contracts/src/market/CanonicalMarket.sol` (current `_matches`/hookData validation), `specs/requirements.json` (`REQ-canonical-market-2/3`).
- **Tests**: `forge test --match-path 'test/market/*.t.sol'`, `forge test --match-path 'test/bindings/*.t.sol'`; add a case proving a swap from an arbitrary router (not the pinned one) still pays the correct fee and does not revert.
- **Acceptance criteria**: any router can execute a full-fill swap and pay the exact fee; a swap without hookData succeeds and pays fee but credits no `buyerHkmnCredit`; `RobinhoodBindings.validate()` rejects a binding whose `programmableBeneficiary` is not `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c`.
- **Risk class**: R4 (revisits a redteam-reviewed security property; needs the owner decision and a fresh redteam pass before merge).
- **Parallel**: yes for implementation; merge gated on owner approval.

### WP-03 — Guardian pause / circuit breaker
- **Goal**: add an owner-held `guardian` role that can pause/unpause new `openPegCycle` calls only.
- **Dependencies**: none.
- **Write set**: `packages/contracts/src/access/MoneyRoles.sol` (or a new sibling mixin to avoid touching the audited role-handover logic directly), `packages/contracts/src/process/ProcessBudget.sol`; new `packages/contracts/test/process/ProcessBudgetGuardian.t.sol`.
- **Read set**: `packages/contracts/src/access/MoneyRoles.sol` (two-step propose/accept pattern to reuse).
- **Tests**: new file, `forge test --match-path 'test/process/*.t.sol'`.
- **Acceptance criteria**: guardian can pause/unpause; paused state blocks `openPegCycle` with a clear revert; guardian has zero capability to read/move/claim funds (proved by a forbidden-selector-style probe as in `MoneyRoles.t.sol`).
- **Risk class**: R2 (additive, narrowly scoped).
- **Parallel**: yes.

### WP-04 — PayoutCommitment/HolderSettlement hardening
- **Goal**: fix the `payoutId == bytes32(0)` sentinel collision; replace HolderSettlement's hardcoded `1024` with `CanonicalMerkleSum.TREE_WIDTH`.
- **Dependencies**: none.
- **Write set**: `packages/contracts/src/payout/PayoutCommitment.sol`, `packages/contracts/src/settlement/HolderSettlement.sol`; extend `packages/contracts/test/payout/PayoutCommitment.t.sol`, `packages/contracts/test/settlement/HolderSettlement.t.sol`.
- **Read set**: same two source files, current `PayoutRecord` struct.
- **Tests**: add a repeated-`bytes32(0)`-authorization regression proving the second call reverts instead of overwriting.
- **Acceptance criteria**: funding the same `payoutId` (including the zero sentinel) twice always reverts `PayoutAlreadyFunded`.
- **Risk class**: R2 (bug fix, no external behavior change for well-formed payoutIds).
- **Parallel**: yes.

### WP-05 — Adopt rev57 escrow + failure-successor lifecycle
- **Goal**: bring `PegCycleReturnEscrow`, `authorizeFundingAfterFailure`, `cancelExpiredFundingAuthorization`, and deadline renewal from `codex/phase2-revision-57` into the integration base, resolving the merge-tree conflicts already identified (`docs/modules/index.json`, `docs/modules/peg-cycle-vault.md`, `gates/runs/init.json`, `packages/contracts/src/process/PegCycleVault.sol`, `product/delivery-boundary.json`, receipts `r-00430`/`r-00431`, `scripts/tests/final-review.test.mjs`, `tasks.json`).
- **Dependencies**: WP-01..04 landed first (so the merged vault carries the fee/router/guardian changes too, avoiding a second wave of conflicts).
- **Write set**: `packages/contracts/src/process/PegCycleVault.sol`, new `packages/contracts/src/process/PegCycleReturnEscrow.sol`, `packages/contracts/src/process/IPegCycleVault.sol`, `packages/runner/src/distribution/reconcile.mjs`, `packages/runner/src/cycle/vault-payout-authorization.mjs`, `docs/modules/peg-cycle-vault.md`, `docs/modules/index.json`, `tasks.json`.
- **Read set**: full rev57 diff (already summarized in `branch-phase2-rev57.json`), current main equivalents.
- **Tests**: `forge test --match-path 'test/process/*.t.sol'` including the ported `PegLegacyVaultRecovery.t.sol`; re-hash `docs/modules/index.json` (fix the digest bug already found on rev57 at commit `228d4b1`) and rerun `node --test scripts/tests/gates.test.mjs`.
- **Acceptance criteria**: all 14 rev57 recovery scenarios pass against the merged tree; `node scripts/v4.mjs status --check` shows no new STALE gate from this merge.
- **Risk class**: R3 (custody lifecycle change).
- **Parallel**: no — sequenced after WP-01..04.

### WP-06 — Stranded-fund / dust recovery relaxation
- **Goal**: relax `recordTerminalFailure` to accept nonzero vault balance (sweep to process budget) and relax `authorizePayout`/`consumePayoutAuthorization` to accept balance `>= rootSum` (transfer exactly `rootSum`, leave remainder).
- **Dependencies**: WP-05.
- **Write set**: `packages/contracts/src/process/PegCycleVault.sol`, `packages/contracts/src/process/PegCycleReturnEscrow.sol`; new `packages/contracts/test/process/PegLegacyVaultDustRecovery.t.sol`.
- **Read set**: current `authorizePayout`/`recordTerminalFailure`/`consumePayoutAuthorization` implementations post-WP-05.
- **Tests**: cases for (a) a below-`minimumReturnUsdg` nonzero return swept via terminal failure, (b) a stray 1-unit donation during `RETURNED` not blocking payout.
- **Acceptance criteria**: neither dead-end reproduced in `contracts-process.json`'s suspicions remains reachable.
- **Risk class**: R3.
- **Parallel**: no.

### WP-07 — Scheduler + lease + budget-gate core
- **Goal**: interval-driven loop with exclusive lease and budget gating, no provider wiring yet (uses fixture/dry-run adapters).
- **Dependencies**: none (contracts-independent; wire to real vault reads once WP-11 lands).
- **Write set**: `packages/runner/src/automation/scheduler.mjs`, `exclusive-lease.mjs`, `budget-gate.mjs`, `automated-cycle-service.mjs`; tests under `packages/runner/test/automation/`.
- **Read set**: `packages/runner/src/cycle/cycle-runner.mjs`, `codex/complete-v4-hook`'s equivalent modules (design reference only, clean-room reimplementation per `product/SOURCE_BOUNDARY.md`).
- **Tests**: `node --test packages/runner/test/automation/*.test.mjs` (lease acquire/renew/fence, budget threshold/wait/insufficient, 8-stage happy path + crash-recovery-at-each-stage).
- **Acceptance criteria**: recovering from a simulated crash after any of the 8 stages converges to the same final journal as an uninterrupted run.
- **Risk class**: R2 (pure orchestration, no real funds).
- **Parallel**: yes.

### WP-08 — Collector Crypt production adapter
- **Goal**: real REST client implementing the documented API surface, replacing `CycleRunner.verifyProductionCollectorIntegration`'s `INTEGRATION_PENDING` throw.
- **Dependencies**: none.
- **Write set**: `packages/runner/src/providers/collector-crypt.mjs`; tests in `packages/runner/test/providers/collector-crypt.test.mjs` (mocked HTTP) plus a `dryRun` integration test against the real, unauthenticated `GET /api/status`/`/api/machines`.
- **Read set**: `docs.collectorcrypt.com/gacha/api` (fetch live), `packages/runner/src/cycle/collector.mjs` (fixture schema it must satisfy).
- **Tests**: `node --test packages/runner/test/providers/collector-crypt.test.mjs`; a separate, explicitly-labeled live smoke test hitting real read-only endpoints.
- **Acceptance criteria**: dry-run mode successfully reads real machine/status data; mutation calls are fully implemented but gated behind an explicit `allowMutations` flag defaulting false.
- **Risk class**: R3 (external API integration, eventual real spend).
- **Parallel**: yes.

### WP-09 — Relay bridge production adapter
- **Goal**: real bridge client for both directions (Robinhood USDG → Solana Circle USD, and back).
- **Dependencies**: none.
- **Write set**: `packages/runner/src/providers/relay.mjs`; tests in `packages/runner/test/providers/relay.test.mjs`.
- **Read set**: `api.relay.link` docs (fetch live), `packages/runner/src/cycle/decoder.mjs`/`bindings.mjs` (schema it must satisfy for the runner's evidence pipeline).
- **Tests**: `node --test packages/runner/test/providers/relay.test.mjs`; quote-only dry-run smoke test against the real API.
- **Acceptance criteria**: a quote round-trip for both directions validates against `validateEvmRelayQuote`/`validateSolanaRelayQuote`-equivalent checks; status polling handles `success`/`failure`/`refund`/pending correctly.
- **Risk class**: R3.
- **Parallel**: yes.

### WP-10 — Solana RPC + policy-wallet signer
- **Goal**: real Solana transaction build/sign/submit/finality-poll, wrapped in an allowlist policy (program IDs, destinations, per-tx cap).
- **Dependencies**: WP-21 if using `@solana/web3.js`; otherwise standalone with hand-rolled JSON-RPC (higher risk, not recommended — see §6).
- **Write set**: `packages/runner/src/providers/solana.mjs`, `packages/runner/src/automation/policy-wallet-solana.mjs`; tests in `packages/runner/test/providers/solana.test.mjs`, `packages/runner/test/automation/policy-wallet-solana.test.mjs`.
- **Read set**: `packages/runner/src/cycle/decoder.mjs` (fixture message schema), `bindings.mjs` (custody invariants: `operationsTrigger` never equals `cycleVaultAccount`/`policyAccount`).
- **Tests**: `node --test packages/runner/test/providers/solana.test.mjs packages/runner/test/automation/policy-wallet-solana.test.mjs` — every policy-field mismatch (wrong program, wrong destination, over-cap amount) must reject before signing.
- **Acceptance criteria**: an out-of-policy transaction is rejected before any signature is produced; a compute-budget/tx-size cap matching Collector Crypt's documented Solana constraints (≤250,000 CU, ≤1,232 bytes) is enforced.
- **Risk class**: R4 (holds real spendable custody at execution time).
- **Parallel**: after WP-21, or standalone if the hand-rolled path is chosen.

### WP-11 — Robinhood EVM RPC + contract adapter
- **Goal**: real read/write client for the four contracts (`PegCycleVault`, `ProcessBudget`, `HookemonHook`, `HolderSettlement`), finalized-block-only reads with codehash verification before trusting any address.
- **Dependencies**: WP-21 if using `viem`; otherwise standalone with hand-rolled `eth_call`/tx signing (not recommended).
- **Write set**: `packages/runner/src/providers/robinhood-rpc.mjs`; tests in `packages/runner/test/providers/robinhood-rpc.test.mjs`.
- **Read set**: `feasibility/verify-robinhood-binding.mjs` (finalized-tag + `eth_getProof` pattern to reuse), `bindings/robinhood-chain.json`.
- **Tests**: `node --test packages/runner/test/providers/robinhood-rpc.test.mjs`; a live dry-run smoke test reading real finalized state (liability views, vault lifecycle) with no signing.
- **Acceptance criteria**: every write path validates the target contract's live codehash against the pinned binding before submitting; a stale/`latest`-tag read is rejected.
- **Risk class**: R4 (every worker-held key's transactions route through this module).
- **Parallel**: after WP-21, or standalone.

### WP-12 — Holder snapshot indexer
- **Goal**: finalized-block HKMN `Transfer`-log scan producing per-holder balances, excluding configured system addresses.
- **Dependencies**: none (can build against a mocked RPC first, wire to WP-11 later).
- **Write set**: `packages/runner/src/distribution/snapshot-indexer.mjs`; tests in `packages/runner/test/distribution/snapshot-indexer.test.mjs`.
- **Read set**: `packages/runner/src/distribution/reconcile.mjs` (target snapshot schema `hookemon.input-bound-hkmn-snapshot-candidate.v1`).
- **Tests**: `node --test packages/runner/test/distribution/snapshot-indexer.test.mjs` — incremental resume from a checkpoint, reorg-safety (finalized-only), exclusion-set correctness.
- **Acceptance criteria**: two independent runs over the same finalized range produce byte-identical snapshots; excluded addresses never appear as holders.
- **Risk class**: R3 (directly determines who gets paid).
- **Parallel**: yes.

### WP-13 — Pro-rata manifest compiler + chunking
- **Goal**: compute each holder's share with an explicit floor-and-carry rounding rule, and split into ≤1024-leaf manifests/`payoutId`s per cycle.
- **Dependencies**: WP-06 (vault `>= rootSum` relaxation, needed for multi-`payoutId` funding from one return), WP-12.
- **Write set**: `packages/runner/src/distribution/pro-rata.mjs`; extend `packages/runner/src/distribution/reconcile.mjs`/`manifest.mjs` to accept a chunk index; tests in `packages/runner/test/distribution/pro-rata.test.mjs`.
- **Read set**: `packages/runner/src/distribution/reconcile.mjs`, `manifest.mjs` (existing 1024-leaf, single-payoutId assumptions to relax).
- **Tests**: `node --test packages/runner/test/distribution/pro-rata.test.mjs`; a 2,500-holder synthetic snapshot proving correct 3-chunk splitting and exact remainder carry-forward.
- **Acceptance criteria**: sum of all chunks' `rootSum` equals the cycle's total returned proceeds exactly; no holder appears twice across chunks.
- **Risk class**: R3.
- **Parallel**: no — sequenced after WP-06/WP-12.

### WP-14 — Payout submitter / settlement keeper
- **Goal**: drive `HolderSettlement.payEntitlement` for every leaf of every funded `payoutId` until all are paid, with retry/backoff and dashboard-visible failure tracking.
- **Dependencies**: WP-13, WP-11.
- **Write set**: `packages/runner/src/distribution/payout-submitter.mjs`; tests in `packages/runner/test/distribution/payout-submitter.test.mjs`.
- **Read set**: `packages/contracts/src/settlement/HolderSettlement.sol` ABI/errors.
- **Tests**: `node --test packages/runner/test/distribution/payout-submitter.test.mjs` — idempotent retry on `EntitlementAlreadyPaid`, backoff on transient RPC failure.
- **Acceptance criteria**: a simulated 1024-leaf manifest reaches 100% paid with no duplicate submissions and no dropped leaves after a mid-run crash/restart.
- **Risk class**: R2 (permissionless call, no privileged key).
- **Parallel**: no — sequenced after WP-13.

### WP-15 — Fee-claim settlement worker
- **Goal**: periodic `claimProgrammable`/`claimTreasury`, isolated in its own process/key boundary from the cycle worker.
- **Dependencies**: WP-11.
- **Write set**: `packages/runner/src/automation/fee-settlement-worker.mjs`; tests in `packages/runner/test/automation/fee-settlement-worker.test.mjs`.
- **Read set**: `packages/contracts/src/HookemonHook.sol` (`claimProgrammable`/`claimTreasury`/`readFeeLiabilities`).
- **Tests**: `node --test packages/runner/test/automation/fee-settlement-worker.test.mjs`.
- **Acceptance criteria**: never invoked with the cycle worker's key material; claims only when liability exceeds a configurable threshold (avoids dust-claim gas waste).
- **Risk class**: R2 (self-claim-only by contract design).
- **Parallel**: yes (after WP-11).

### WP-16 — Configuration & secrets management
- **Goal**: single source of truth for pack list/interval/caps/dry-run toggle; key-material loading boundary.
- **Dependencies**: none.
- **Write set**: `packages/runner/src/config/secrets.mjs`, `cycle-config.mjs`; tests in `packages/runner/test/config/`.
- **Read set**: existing `packages/runner/src/operator/state-file.mjs` (lock/CAS pattern to reuse for `cycle-config.mjs`).
- **Tests**: `node --test packages/runner/test/config/*.test.mjs` — secrets never appear in `JSON.stringify`/log output (assert via a source/log-scan test, mirroring `control.test.mjs`'s "no production integration capability" source-scan pattern).
- **Acceptance criteria**: a config mutation from the dashboard is visible to the scheduler within one tick; secrets are provably absent from every log/error path.
- **Risk class**: R3 (secret-boundary).
- **Parallel**: yes.

### WP-17 — Observability
- **Goal**: structured cycle log, at least one real alert channel, stuck-cycle heuristics feeding the dashboard.
- **Dependencies**: none.
- **Write set**: `packages/runner/src/observability/cycle-log.mjs`, `alerts.mjs`, `stuck-cycle-detector.mjs`; tests under `packages/runner/test/observability/`.
- **Read set**: `packages/runner/src/cycle/journal.mjs` (append-only pattern to reuse), `ops/HANDOFF.md` (documents zero alert channels test-fired today).
- **Tests**: `node --test packages/runner/test/observability/*.test.mjs`; an explicit test-fire of the chosen alert channel (closing the `alertChannelTested:false` gap in `qa/drills/induced-failure.json`).
- **Acceptance criteria**: a cycle stuck beyond a configurable threshold at any stage triggers exactly one alert (no duplicate storms on repeated polling).
- **Risk class**: R2.
- **Parallel**: yes.

### WP-18 — Dashboard backend
- **Goal**: implement the API in §5.
- **Dependencies**: WP-16 (config), WP-17 (status data).
- **Write set**: `packages/dashboard/server/index.mjs`, `routes.mjs`, `auth.mjs`; tests in `packages/dashboard/test/`.
- **Read set**: `packages/runner/src/operator/state-file.mjs`, `control.mjs` (verbs to wrap).
- **Tests**: `node --test packages/dashboard/test/*.test.mjs` — auth-required endpoints reject unauthenticated requests; config mutations round-trip through the CAS store correctly.
- **Acceptance criteria**: every mutation endpoint requires auth; every read endpoint works without it; a restart request correctly invokes the WP-06 recovery path when appropriate.
- **Risk class**: R2 (no signing/spending capability by design).
- **Parallel**: no — sequenced after WP-16/17.

### WP-19 — Dashboard frontend
- **Goal**: owner control panel + public community status page.
- **Dependencies**: WP-18.
- **Write set**: `packages/dashboard/public/index.html`, `admin.html`, `status.html`, `app.js`, `style.css`.
- **Read set**: WP-18's API contract.
- **Tests**: manual/visual verification via `Bash`+`curl` against the running backend (no browser automation dependency required for this repo's zero-npm posture); optional Playwright smoke test if WP-21 is taken.
- **Acceptance criteria**: pack selection, interval change, pause/resume, and restart are all operable from the admin UI; the public status page renders with no auth.
- **Risk class**: R1.
- **Parallel**: no — sequenced after WP-18.

### WP-20 — Programmable launch prep artifacts
- **Goal**: produce the artifacts in §7 that don't require external readiness.
- **Dependencies**: WP-02 (router binding — affects `submission.json`'s router/compatibility declarations) recommended complete first, though drafting can start in parallel.
- **Write set**: new `launch/submission.json`, `launch/launch-plan.md`, `launch/hook-address-mining.mjs`, `launch/custody-construction.md`, a design note for the custom `LiquidityLauncher` strategy.
- **Read set**: `<builder-skill>/references/*` (all four references), `bindings/robinhood-chain.json`.
- **Tests**: a schema-validation test for `submission.json` against the builder skill's schema/checker if available; `hook-address-mining.mjs` unit test proving it finds a valid salt for a known permission mask.
- **Acceptance criteria**: `submission.json` passes the builder skill's own validator; the mining script reproduces the existing CREATE2 preimage check already proven in `packages/contracts/script/release/PhaseOneReleasePlan.sol`.
- **Risk class**: R1 (documentation/tooling, no chain interaction).
- **Parallel**: yes.

### WP-21 — npm dependency onboarding
- **Goal**: add `viem` and `@solana/web3.js` as pinned dependencies with a lockfile, CI install step, and the coordinated 3-way hash update.
- **Dependencies**: none, but should land early since WP-10/WP-11 (and optionally WP-19) depend on it.
- **Write set**: new `package.json`/lockfile at repo root or `packages/runner/`, `.github/workflows/v4-gates.yml`, `product/dependency-pins.json`, `scripts/verify-control-dependencies.mjs`; new `scripts/tests/control-dependencies.test.mjs` cases for the added packages.
- **Read set**: `scripts/verify-control-dependencies.mjs` (current `SUPPORTED_*` constants and hash-pinning mechanism), `.github/workflows/v4-gates.yml`.
- **Tests**: `node --test scripts/tests/control-dependencies.test.mjs`; a live run of `verify-control-dependencies.mjs` confirming `PASSED`.
- **Acceptance criteria**: CI installs the pinned packages byte-for-byte reproducibly; `scripts/v4.mjs status --check` shows no new STALE gate from this change.
- **Risk class**: R3 (supply-chain / CI gate change, requires careful sequencing to avoid breaking the append-only gate history).
- **Parallel**: yes, but should be prioritized early.

### WP-22 — Process artifacts
- **Goal**: produce the requirements revision 58 proposal, ADR-0021, unsigned owner-approval drafts, delivery-boundary/CI/policy changes, task cards, and docs updates from §8.
- **Dependencies**: none for drafting; should conceptually precede/accompany WP-01..06 since those contract changes need the REQ ids this package defines, but can be iterated together.
- **Write set**: `product/REQUIREMENTS_REVISION_58_PROPOSAL.md`, `decisions/ADR-0021-autonomous-cycle-authority-and-circuit-breaker.md`, `decisions/owner-approvals/phase-2-revision-58-*-DRAFT.json` (unsigned), `product/delivery-boundary.json`, `tasks/P2-013.md` onward, `docs/modules/{dashboard,peg-cycle-vault,cycle-runner,scheduler,distribution-pipeline}.md`.
- **Read set**: `specs/requirements.json`, existing ADR chain (`decisions/ADR-0016..0020`), `product/delivery-boundary.json`, `scripts/check-delivery-boundary.mjs`.
- **Tests**: `node --test scripts/tests/reqs.test.mjs scripts/tests/delivery-boundary.test.mjs scripts/tests/phase-boundary.test.mjs` after edits.
- **Acceptance criteria**: `node scripts/v4.mjs trace check` passes against the new REQ ids once tasks reference them; delivery-boundary check passes with Phase 2 open.
- **Risk class**: R2 (process/documentation, gates real work but touches no funds).
- **Parallel**: yes, first.

## 11. Open owner decisions

**A. Integration base.**
(a) *Recommended*: main + a semantic merge of rev57's escrow/recovery slice (WP-05) + a clean-room-reimplemented port of `complete-v4-hook`'s automation modules (scheduler/lease/budget-gate/fee-settlement — these are dependency-injected and hold no contract-layer conflict with main). Drop `complete-v4-hook`'s own `HookemonHook.sol`/`ProcessBudget.sol` claim-function changes entirely (main's version is strictly more defensive: exact-32-byte transfer-return check plus `InvalidVaultUsdg`, versus `complete-v4-hook`'s looser empty-return-accepted variant). (b) Start a fresh Phase 2 branch from main only, re-deriving the escrow/recovery design from scratch instead of merging rev57 — slower, avoids inheriting rev57's stale-digest CI bug and its own un-reviewed edge cases, but throws away 19 already-tested commits.

**B. Router-binding relaxation (§3, WP-02).**
(a) *Recommended*: relax to accept-any-router-with-optional-hookData, as designed above — this is the only path that lets standard wallets, the Uniswap UI, and the Trading API interact with the pool, and it does not weaken the fee-enforcement invariant (the fee is taken unconditionally in `_afterSwap` regardless of caller). (b) Keep the immutable single-router binding and instead build/host a bespoke frontend that only ever talks to that one router — cheaper to implement, but permanently excludes every third-party integration and contradicts a community token's basic tradability expectation.

**C. Standing authority and custody model (§2.3).**
(a) *Recommended*: worker holds `operations` + `vault-authorizer` + Solana execution-wallet keys under hard per-cycle/rolling caps and the guardian kill switch; `treasury`/`programmable`/`distribution-signer` keys stay owner-held, invoked on a separate, lower-frequency, owner-triggered or semi-manual schedule. This is the minimum grant that actually achieves "buy-open-sell-distribute automatically" while keeping the two highest-value keys (treasury claim self-limited by design; distribution-signer not self-limited at all) out of the always-on process. (b) Fully automate every key including the distribution-signer — achieves true zero-touch operation but means a worker-machine compromise can redirect an entire cycle's proceeds to attacker-chosen addresses with no independent second signature; not recommended without a hardware-backed remote policy signer (§6 alternative) first.

**D. Runtime dependencies (§6, WP-21).**
(a) *Recommended*: pinned npm (`viem`, `@solana/web3.js`) with the coordinated 3-way CI change. (b) Continue dependency-free hand-rolled primitives — preserves the current zero-supply-chain-surface property the control plane already enforces, at the cost of hand-maintaining transaction encoding/ABI/Solana-instruction logic for two live chains, which the audit found already produces duplicate from-scratch `keccak256` implementations with no cross-check against a reference implementation. (c) External signer/RPC gateway (Privy-style) — strongest custody isolation, introduces a new paid third-party dependency; recommended only as a later upgrade to the Solana leg specifically, not as the initial approach.

**E. Scheduler and stuck-cycle model (§2.5, §4).**
(a) *Recommended*: as designed — interval loop + lease + budget gate + reconcile-before-retry + dashboard restart/kick mapped to `resume`/`reconcile`/force-fail-and-recover. (b) A simpler fixed-cadence loop with no lease/budget-gate sophistication, relying entirely on the dashboard's manual pause for safety — faster to build, but re-introduces the double-spend/overlapping-cycle risk the lease exists to prevent.

**F. Holder distribution at scale (§3, §4 WP-13).**
(a) *Recommended*: keep the on-chain 1024-leaf-per-`payoutId` shape unchanged; chunk off-chain into multiple `payoutId`s per cycle once holder count exceeds 1024, using the WP-06 vault relaxation to fund each chunk sequentially from one return. (b) Design a successor hook/settlement contract with a larger or unbounded tree depth — cleaner long-term, but is exactly the kind of "immutable successor lifecycle" change ADR-0008 already scopes as its own deployment event, not a Phase 2 increment; recommended only once holder count is actually approaching 1024 in practice.

**G. Dashboard audience/auth (§5).**
(a) *Recommended*: as designed — bearer-token owner auth for mutation, public read for status. (b) No public surface at all, owner-only for everything including status — simpler, but contradicts the explicit "community-facing status" requirement.

## 12. What cannot be finished without external readiness, and dry-run behavior until then

- **Programmable Robinhood-Chain launch** cannot proceed past artifact preparation (§7) until Programmable's `/v4/chains/4663/capabilities` reports something other than `unavailable`. Until then, the system runs entirely on **dry-run mode**: every provider adapter (§4) performs only read-only/quote-only calls against real endpoints where safe (Collector Crypt status/machines, Relay quotes, Robinhood finalized reads), and the scheduler drives full 8-stage cycles against the existing fixture harness so every code path is exercised without spending real funds.
- **Real API keys** (Collector Crypt `x-api-key`, any Relay key if required) and **funded wallets** (process budget in USDG, Solana execution wallet float, gas reserves on both chains) are required only for the first live cycle. Until the owner supplies and explicitly approves these, `allowMutations`/`allowSigning` flags across every provider adapter default to `false`, and the scheduler refuses to advance any cycle past the dry-run boundary — enforced in code (a hard assertion in `automated-cycle-service.mjs`), not merely by configuration convention.
- **The router-address discrepancy** (§7) must be re-resolved with a fresh finalized-RPC probe immediately before the first live deployment; neither cached value (repo-pinned or Uniswap-docs-published) should be trusted without that final check.
- **The standing-authority owner approval** (§11-C) is a hard prerequisite for the scheduler ever running unattended against live funds — until it is granted, the system can be fully built, tested, and demonstrated in dry-run, but every real cycle must be started manually by the owner, exactly as Phase 1's current per-action-approval model already requires.
