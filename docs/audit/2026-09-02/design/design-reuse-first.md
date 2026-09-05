# HKMN Phase 2 Design: Autonomous Peg-Cycle Loop (Reuse-First)

Audience: implementing engineers and the owner. This is a design for Phase 2 work — nothing here is authorized to run, deploy, sign, broadcast, or spend. Phase 1 (main, commit 5b365c8) is explicitly scoped to one manually started, fully reconciled cycle with no scheduler and no dashboard (`decisions/ADR-0018-manual-one-cycle-phase-boundary.md`, `product/REQUIREMENTS_REVISION_55_PROPOSAL.md`, `specs/requirements.json` REQ-phase-boundary-1). Phase 2 opens only after a fresh requirements revision and exact owner approval (`REQ-phase-boundary-2`, `docs/superpowers/specs/2026-08-31-phase-2-foundation-draft.md`). Every claim about existing code below cites the file that supports it.

---

## 1. Summary (15 lines)

The owner wants HKMN's 2.50% process-budget share of swap fees to autonomously buy one Collector Crypt pack every N minutes (default 20, dashboard-adjustable), open it, sell the card via Collector's standard buyback, bridge proceeds back to Robinhood USDG, and pay HKMN holders pro rata — unattended, with a dashboard for pack choice, interval, and stuck-cycle recovery. Main (`packages/contracts/src`) has the immutable money kernel: `HookemonHook.sol` composes `CanonicalMarketCallback` (3% inclusive fee, quadrant-correct return deltas), `FeeAccounting.sol` (per-swap 10/40/250bps split, no cumulative remainder, no 1000-unit floor), and `ProcessBudget`/`PegCycleVault` (single-cycle EMPTY→FUNDED→OUTBOUND→RETURNED→PAYOUT_COMMITTED, absorbing FAILED with no recovery). The off-chain runner (`packages/runner/src/cycle`, `src/distribution`) is a durable, event-sourced state machine proven correct against fixture Ed25519 signatures only — every `verifyProduction*` function throws `INTEGRATION_PENDING`. Two unmerged branches carry real building blocks: `codex/phase2-revision-57` (per-cycle CREATE2 return escrow, single-active-cycle coordinator, a dependency-free operator CLI for prepare/freeze/start/status/resume/reconcile) and `codex/complete-v4-hook` (a lease-fenced `AutomatedCycleService`, a `budget-gate`, policy-gated wallets, and `CycleRunner.supersedeUnobservedIntent` for unsticking a broadcast-but-unobserved mutation). Neither branch implements a real Collector Crypt, Relay, or chain client, a scheduler, or a dashboard; both are 100% fixture-only for external I/O. External verification today (2026-09-02) confirms Robinhood Chain 4663, USDG, and the Uniswap v4 addresses are live, Relay bridges USDG↔Solana-Circle USD for both chains, and Collector Crypt's buyback API is live and unchanged — but Programmable's Robinhood v4 launch profile is `status: planned, readiness: unavailable` (`ROBINHOOD_CHAIN_PROFILE_UNAVAILABLE`), so production launch on 4663 is not possible today. The hook also has two unfixed conformance gaps against the mandatory Programmable fee policy: no cumulative platform/project remainder tracking and no revert below 1000 quote units (both required by `programmable-fee-policy.md` v1.1.0), plus an unpinned Programmable-owner address. This design is the smallest sound diff that assembles a real, testable, dry-run-capable autonomous loop on top of what already exists, gated end-to-end behind explicit owner-approved standing authority — it cannot legally or technically go live until Programmable's Robinhood profile ships and the owner signs a Phase 2 spec and an ADR granting bounded unattended signing authority.

---

## 2. Architecture

### 2.1 Components

```
                         ┌───────────────────────────────────────────────┐
                         │  Dashboard (packages/dashboard)                │
                         │  operator console (loopback+token)             │
                         │  public community status (read-only)           │
                         └───────────────┬─────────────────┬─────────────┘
                                          │ config mutate    │ read-only
                                          ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ packages/runner/src/automation  (NEW — cherry-picked + productionized)   │
│  scheduler.mjs → AutomatedCycleService.runOnce() every intervalMs        │
│  exclusive-lease.mjs (CAS lease)   budget-gate.mjs (decideCycleBudget)   │
│  policy-wallets.mjs (Evm/SolanaPolicyWallet, allowedDestinations/Fns)    │
│  fee-settlement.mjs (claimProgrammable/claimTreasury automation)        │
│  kill-switch.mjs (NEW — off-chain pause flag, checked before every sign)│
└───────────┬─────────────────┬─────────────────┬─────────────────────────┘
            │                 │                 │
            ▼                 ▼                 ▼
┌─────────────────┐ ┌──────────────────┐ ┌────────────────────────┐
│ packages/runner/ │ │ packages/runner/ │ │ packages/runner/src/   │
│ src/cycle         │ │ src/providers    │ │ distribution (holder   │
│ (EXISTING journal │ │ (NEW — Collector,│ │ snapshot + manifest,   │
│ + reducer + CAS    │ │ Relay, Solana,   │ │ EXTENDED for chunking) │
│ store, all fixture │ │ Robinhood RPC    │ │                        │
│ paths kept, real   │ │ wire clients)    │ │                        │
│ paths added)       │ │                  │ │                        │
└───────────┬────────┘ └──────────────────┘ └───────────┬────────────┘
            │                                            │
            ▼                                            ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Robinhood Chain 4663 (on-chain, packages/contracts/src)                │
│  HookemonHook / CanonicalMarket / FeeAccounting (GAP fixes, WP-02/03)  │
│  ProcessBudget → PegCycleVault (per-cycle CREATE2 escrow from rev57;   │
│  degraded-return + multi-shard payout states, WP-04/05)               │
│  PayoutCommitment / HolderSettlement (multi-payoutId per cycle, WP-05) │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.2 Trust boundaries and custody

Everything below extends `architecture/trust-boundaries.md`'s existing table (TB-01..TB-20), which stays authoritative; Phase 2 adds no new on-chain role. `TB-07` already states "the minimal caller matrix has no unintended success and no V1 admin, automation, or pause role" and `TB-08` requires Operations to *trigger* funding, never custody it. The autonomous loop must respect this exactly: **the scheduler and its signer hold no on-chain privilege beyond the existing `operationsTrigger` and `authorizer` roles that Phase 1 already defined** (`packages/contracts/src/process/PegCycleVault.sol`, `MoneyRoles.sol`). No new Solidity role is introduced.

Custody model for unattended operation:

- **Operations trigger key** (EVM) — calls `ProcessBudget.openPegCycle`, `PegCycleVault.executeOutbound`, and (post-return) triggers `PegCycleVault.consumePayoutAuthorization` indirectly via the hook. This key moves no funds itself (`bindings.mjs validateCycleCustody`, `packages/runner/src/cycle/bindings.mjs:1-33`, already enforces `operationsTrigger != cycleVaultAccount && operationsTrigger != policyAccount`).
- **Vault authorizer key** (EVM) — calls `PegCycleVault.authorizeFunding`/`authorizePayout`/`recordTerminalFailure`. In Phase 1 this is a human-operated EOA (`contracts-process.json` openQuestions: "is authorizer... operated directly by 'operations' personnel"). For Phase 2 autonomy this is the **second** key the standing-authority ADR must name explicitly — recommended: keep it separate from the operations-trigger key, held by the same policy-wallet signer but under a distinct, tighter allowlist (only `authorizeFunding`/`authorizePayout`, never `executeOutbound`), so a single compromised process cannot both authorize and execute a cycle without two independent checks having already passed off-chain.
- **Solana execution wallet** (Collector Crypt purchase/open/buyback signer) — a `SolanaPolicyWallet` (`codex/complete-v4-hook packages/runner/src/automation/policy-wallets.mjs:1-214`) bound to `allowedDestinations` = {Collector Crypt purchase account, Collector prize-wallet, the bound Circle Circle USD token account}, `allowedFunctions` = {the exact Collector-generated instruction shapes}, `maxAmount` = the per-cycle pack price cap.
- **Relay bridge caller** — same EVM/Solana policy wallets, restricted to Relay's deposit contract / Solana deposit program `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` (verified live, `external-facts.json` crossChainUsdgSolanaCircleUsdRoutes) and the bound return destination (the vault or its per-cycle CREATE2 escrow).
- **Key custody**: see §6. No key is ever held in an on-chain contract; no contract gains a pause, admin, or automation role — this is a hard architectural constraint from `TB-07` and `REQ-role-control-3`/`REQ-process-budget-5` (`product-docs.json` invariants), which this design does not touch.

### 2.3 Data flow for one cycle (numbered, who signs what)

This extends the existing `cycle-runner.mjs` state machine (`transitionOrder = [prepared, outbound-finalized, purchase-finalized, open-reconciled, buyback-finalized, return-finalized, closed]`, `runner-cycle-a.json` keyFacts) — no journal event kind changes; only the fixture verifiers get real production counterparts.

1. **Scheduler tick** (no signature): `scheduler.mjs` wakes every `intervalMs`, calls `budget-gate.decideCycleBudget` (`budget-gate.mjs`, unchanged) against a live `readProcessLiability()` read of `FeeAccounting.processLiability()`. If insufficient, sleep to next tick.
2. **Lease acquire** (no signature): `exclusive-lease.acquireLease` CAS against the operator state file (rev57 `state-file.mjs`, extended) — prevents two scheduler instances from double-triggering.
3. **Open peg cycle — operations-trigger key signs an EVM tx** calling `ProcessBudget.openPegCycle(cycleId)`, which atomically debits process liability and funds the vault's per-cycle CREATE2 escrow (rev57 `PegCycleReturnEscrow.sol`). Journaled as `cycle-preflight-recorded` → `intent-prepared` → owner-approval-recorded (now: policy-wallet-authorized) → `broadcast-recorded` → `provider-receipt-verified` (real: an EVM receipt fetched at a finalized block, not a fixture Ed25519 signature).
4. **Outbound conversion — Robinhood USDG → Solana Circle USD via Relay**: vault authorizer key signs `PegCycleVault.executeOutbound`; the Solana-side leg is prepared and signed by the Solana policy wallet. Real `RelayClient.quote`/`.status` (ported from `mainnet-cycle-canary` legacy branch's `packages/integrations/src/relay-client.js`, re-implemented clean-room per `product/SOURCE_BOUNDARY.md`) replaces `preflight.mjs`'s fixture release-verification digest.
5. **Collector Crypt purchase** — Solana policy wallet signs the `generatePack` transaction Collector returns; journaled per `collector.mjs`'s existing schema (`hookemon.fixture-collector-request.v1` → a new `hookemon.collector-request.v1` production schema with the same field shape, per `collector.mjs:1-145` in `runner-cycle-b.json`).
6. **Pack open** — same wallet signs `openPack`; `recordFinalizedCollectorOpenCustody` now requires a real Solana RPC `getTransaction` read at `finalized` commitment (mirrors `SolanaTurboBuybackVerifier` from the legacy branch), not a fixture RPC signature.
7. **Standard buyback (within Collector's 72-hour window)** — Solana policy wallet signs the buyback transaction; a distinct **post-open** authorization is required (`authorization.mjs`'s existing `hookemon.fixture-post-open-buyback-approval.v1` domain — this stays a *separate* signature class exactly because the card is unknown until step 6, per `runner-cycle-b.json` invariants).
8. **Return conversion — Solana Circle USD → Robinhood USDG via Relay**, credited only to the vault's per-cycle escrow (never Operations, `TB-15`).
9. **Payout authorization — vault authorizer key signs** `PegCycleVault.authorizePayout` (or, for >1024 holders, a sequence of partial-drain authorizations, WP-05) once the holder-distribution manifest is compiled and independently re-verified (§2.4, §4).
10. **Payout funding — hook-triggered** `consumePayoutAuthorization` moves the escrow's exact returned USDG into the hook, crediting `payoutLiability` (`PayoutCommitment.fundPayoutFromPegCycle`, unchanged).
11. **Holder settlement** — a permissionless worker (any key; `HolderSettlement.payEntitlement` has no access control, `runner-distribution.json`) calls `payEntitlement` for every leaf. The scheduler runs this itself as a convenience, but nothing on-chain requires it to.
12. **Fee settlement (parallel, not cycle-gated)** — `fee-settlement.mjs`'s `planFeeSettlements`/`verifyFeeSettlement` (from `codex/complete-v4-hook`) periodically claims `claimProgrammable`/`claimTreasury` to their fixed, immutable destinations — this never touches process liability and can run on its own cadence.

### 2.4 Recovery model

| Situation | On-chain state | Recovery |
|---|---|---|
| Stuck mid-external-action (broadcast sent, never observed) | any | `CycleRunner.supersedeUnobservedIntent` (`codex/complete-v4-hook reducer.mjs`) — requires dual independently-signed "NOT_FOUND, finalized" observer proofs (provider + RPC) **and** a fresh policy-wallet-signed authorization. This is deliberately heavyweight and stays that way: the dashboard's "kick" button triggers the *attempt* to gather this proof, it does not itself bypass the cryptographic gate. |
| Vault `OUTBOUND`, return came back nonzero but below `minimumReturnUsdg` | `OUTBOUND`, no valid transition today (`contracts-process.json` suspicion at `PegCycleVault.sol:301`) | **New** `DEGRADED_RETURN` transition (WP-04): `authorizePayout` accepts `rootSum < minimumReturnUsdg` only when explicitly flagged `acceptDegraded=true` in the authorization, still requires `balance==rootSum` exactly (no invented value), and the operator dashboard surfaces this as a distinct alert requiring one more human confirmation before the vault authorizer signs it — this is the one case in the whole loop the design does *not* fully automate, because accepting a below-minimum return is an economic judgment call, not a mechanical fact. |
| Vault `FUNDED`/`OUTBOUND` with an **expired** pending authorization | any | Already solved on `codex/phase2-revision-57`: `cancelExpiredFundingAuthorization`, `authorizeFundingAfterFailure`, `renewFundingAuthorizationDeadline`/`renewPayoutAuthorizationDeadline` (`PegCycleVault.sol` on that branch, `branch-phase2-rev57.json` invariants). Adopted as-is in WP-01. |
| Vault `FAILED` (per-cycle escrow now, not the shared vault) | `FAILED`, terminal for that `cycleId` | Rev57's per-cycle CREATE2 escrow already isolates a failure to one cycle; `authorizeFundingAfterFailure` opens a fresh successor cycle with a fresh escrow (`branch-phase2-rev57.json` stateTransitions). The **quarantined failed escrow's residual balance has no on-chain sweep** — this is deliberate (no rescue path is ever added to an immutable custody contract, `compatibility-standard.md` "no rescue/upgrade path"); it is written off in the runner's cycle ledger and disclosed on the public status page as a known-loss line item, never silently dropped. |
| Frozen operator plan that expired before `start` | operator state file only, no on-chain effect | `abandon-expired` (rev57 `control.mjs`), unchanged. |
| Scheduler process itself crashes | any | Idempotent recovery is already the design: `CycleRunner`'s constructor always replays the journal (`runner-cycle-a.json` stateTransitions: "the runner never assumes a mid-flight external action succeeded or failed on its own"), and `AutomatedCycleService.recoverActiveCycle()` (`codex/complete-v4-hook`) resumes at the exact incomplete stage. |

### 2.5 Kill switch

There is **no on-chain pause** — adding one would violate `TB-07`/`REQ-role-control-3` and require re-opening the immutable-hook design, which this document does not propose. The kill switch is entirely off-chain and enforced at the one place all signing funnels through: `PolicyWallet.sign()` (WP-11) checks a `paused` flag in the operator state file before producing any signature, for *any* of the four keys. `POST /api/pause` (WP-16) flips that flag under CAS; the scheduler's next tick (and any in-flight `sign()` call) observes it immediately. This is consistent with `control-plane.json`'s finding that `external-action-stop.json`'s flags are "policy-only, not runtime interposition" today — this design makes the equivalent flag *actually* interposed at the signer, not merely documented.

---

## 3. Contract changes before deployment (file by file)

All changes are additive to the fee/vault/payout kernel; none touch `CanonicalMarket.sol`'s callback authentication, the 0x00CC permission mask, or `HookemonIssuance.sol`. Each item names the spec-revision consequence.

### 3.1 `packages/contracts/src/accounting/FeeAccounting.sol` — cumulative remainders + minimum-quote revert (WP-02)

Two conformance gaps against the mandatory `programmable-fee-policy.md` v1.1.0, found independently by `contracts-kernel.json` (suspicion at `FeeAccounting.sol:152`) and `skill-and-prs.json` (GAP-1, GAP-2):

- **GAP-1**: `_splitLiability` floors `programmableFee`/`treasuryFee` independently *per swap* with no persisted cross-swap remainder. Policy: *"independent cumulative platform and project remainders for the lifetime of the canonical pool. Claims must not reset them. This closes the split-swap bypass..."* (`programmable-fee-policy.md` lines 56-61). **Fix**: add two monotonic storage slots, `cumulativeGrossExecutedUsdg` and `cumulativeProgrammableAccrued`/`cumulativeTreasuryAccrued`. On each swap: `newGross = cumulativeGrossExecutedUsdg + executedUsdg`; `cumulativeProgrammableEntitlement = floor(newGross * PROGRAMMABLE_FEE_BPS / BPS_DENOMINATOR)`; this swap's `programmableFee = cumulativeProgrammableEntitlement - cumulativeProgrammableAccrued` (then `cumulativeProgrammableAccrued = cumulativeProgrammableEntitlement`); identically for treasury. `processFee` stays `totalFee - programmableFee - treasuryFee` (a subtraction, never independently floored, so it inherits exactness). Claims never touch these cumulative trackers — only the per-beneficiary liability balances they feed.
- **GAP-2**: no floor on gross quote amount. Policy: *"A positive gross quote amount below 1,000 smallest quote-asset units must revert atomically"* (same section). **Fix**: `CanonicalMarket.sol`'s `_fee()` (currently only upper-bound-checked, `CanonicalMarket.sol:272`) gains `if (executedUsdg > 0 && executedUsdg < 1000) revert BelowMinimumQuoteUnits();` before computing any delta.

**Spec consequence**: this changes `REQ-fee-accounting-1`'s measurable behavior (exact split — now cumulative, not per-swap) and adds a new edge case to `REQ-canonical-market-1..5`. Requires a `specs/requirements.json` revision bump and a new ADR (folded into ADR-0021, §8) documenting the split-formula change; existing `FeeAccounting.t.sol` fixed literals for `type(uint256).max` (`contracts-tests-a.json` keyFacts) must be recomputed under the cumulative formula — WP-22.

### 3.2 `packages/contracts/src/bindings/RobinhoodBindings.sol` — pin the Programmable owner (WP-03, GAP-4)

`validate(Binding memory)` checks 12 addresses pairwise-distinct and pins 5 to known Robinhood addresses, but never checks `binding.programmableBeneficiary` against the policy-mandated `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c` (`contracts-kernel.json` suspicion at line 114; `bindings/robinhood-chain.json` itself lists `PROGRAMMABLE_OWNER_AND_CLAIM_DESTINATION_POLICY_RESOLUTION` as an open `productionReadiness` blocker). **Fix**: add `if (b.programmableBeneficiary != PROGRAMMABLE_OWNER) revert InvalidProgrammableBeneficiary();` with `PROGRAMMABLE_OWNER` a `constant address` equal to that value, and thread the same check into `HookemonHook`'s constructor so a wrong `ConstructorConfig.programmable` cannot deploy at all (not just fail binding validation after the fact).

### 3.3 `packages/contracts/src/accounting/FeeAccounting.sol` — claim events + self-call policy declaration (WP-03, GAP-5)

- Add `event ProgrammableClaimed(address indexed beneficiary, address indexed destination, uint256 amount)` / `TreasuryClaimed(...)` to `_claimLiability` (currently silent, `contracts-kernel.json` autonomyGaps) — needed for the dashboard's community status page (§5) to index claims without polling.
- The hook never self-initiates a `PoolManager.swap()` on its own pool (confirmed by `skill-and-prs.json` GAP-5 grep), so declare `selfCallPolicy: same-pool-swap-forbidden` in `submission.json` (§7) and add one negative test proving a same-pool self-call reverts (it already does, by construction — this closes the *evidence* gap, not a code gap).

### 3.4 `packages/contracts/src/process/PegCycleVault.sol` — degraded-return recovery state (WP-04)

Base this on `codex/phase2-revision-57`'s already-improved vault (per-cycle CREATE2 escrow, `authorizeFundingAfterFailure`, deadline renewal — adopted wholesale in WP-01). On top of that, add the `DEGRADED_RETURN` handling described in §2.4: `authorizePayout` gains an `acceptDegraded` bool on `PayoutAuthorization`; when true, the `rootSum >= minimumReturnUsdg` check is skipped but `balance == rootSum` stays exact. **Spec consequence**: new `PayoutAuthorization` field is a breaking ABI change to `IPegCycleVault.sol` — bump `REQUIREMENTS_REVISION` to 58 (rev57 already claims 57; see §8) and update every fixture in `vault-payout-authorization.mjs`/`preflight.mjs` that hardcodes the revision literal (`runner-cycle-b.json` suspicion: preflight.mjs hard-asserts revision at *module load time*, so this is a breaking-until-coordinated change — WP-04 must land together with WP-23's fixture updates in the same PR).

### 3.5 `packages/contracts/src/process/PegCycleVault.sol` + `src/payout/PayoutCommitment.sol` — multi-shard payout for >1024 holders (WP-05)

Today `authorizePayout` requires `vault.balanceOf == rootSum` **exactly** and `consumePayoutAuthorization` drains the **entire** balance in one call, moving the lifecycle to `PAYOUT_COMMITTED` (a terminal-for-this-cycle state that only a *fresh* `authorizeFunding` re-opens — i.e. today's design supports exactly one `payoutId` per cycle, hard-capped at 1024 recipients by `CanonicalMerkleSum.TREE_WIDTH`, `runner-distribution.json` autonomyGaps). **Fix**: relax `authorizePayout`'s balance check from `== rootSum` to `rootSum <= balance` and add an `isFinalShard` flag; `RETURNED` stays `RETURNED` (not `PAYOUT_COMMITTED`) after a non-final shard's `consumePayoutAuthorization`, only transitioning once a shard with `isFinalShard=true` drains the remainder to exactly zero. This lets the off-chain compiler (WP-06) split any holder count into `ceil(holders/1024)` shards, each its own `payoutId` with its own `CanonicalMerkleSum` tree, funded sequentially from the same returned batch. **This is the single largest owner decision in this document** — it changes an already-approved invariant (`authorizePayout requires... current USDG balance == rootSum exactly`, `contracts-process.json` publicInterface) and is flagged as Decision F in §11.

### 3.6 What is *not* changed

`CanonicalMarket.sol`'s callback authentication, single-router binding, and full-fill-only semantics stay as-is — loosening the router binding (accepting any caller) was considered per the task's decision list but is **not recommended**: the autonomous loop only ever needs the one router it already binds to (Universal Router, address to be reconciled per §11 Decision H), and relaxing caller authentication widens the attack surface for zero operational benefit to this design. `HookemonIssuance.sol`'s issuance guard is untouched — token creation via the Programmable launchpad is blocked on external readiness (§7), not on anything this design can fix.

---

## 4. Off-chain services (file by file)

All new code is dependency-free Node 24 built-ins, following the existing convention in every file under `packages/runner/src` (`runner-cycle-a.json`/`runner-cycle-b.json` externalDependencies: "zero npm dependencies... node:crypto only"). New top-level directory `packages/runner/src/providers/` holds real client implementations; `packages/runner/src/automation/` (cherry-picked from `codex/complete-v4-hook`, then extended) holds the scheduler/lease/policy-wallet/settlement layer; `packages/dashboard/` is new.

### 4.1 Scheduler — `packages/runner/src/automation/scheduler.mjs` (NEW, ~150 lines)

Thin `setInterval`-equivalent wrapper (matching the legacy branch's proven default, `apps/operator/src/scheduler.js` `intervalMs = 20*60*1000`, re-implemented clean-room) around `AutomatedCycleService.runOnce()`/`.recoverActiveCycle()` (`codex/complete-v4-hook automated-cycle-service.mjs`, adopted verbatim — it is already 100% dependency-injected and holds no provider-specific code). Reads `intervalMs` from the operator state file (mutable via dashboard, §5), re-reads it every tick (no restart needed to change cadence). Calls `kill-switch.isPaused()` before every tick.

### 4.2 `kill-switch.mjs` (NEW, ~40 lines)

`isPaused(stateFile)` / `setPaused(stateFile, bool, actor)` — CAS-guarded read/write on the same operator state file rev57 already defines (`state-file.mjs`), reusing its exclusive-lock/CAS primitives rather than inventing a second storage mechanism.

### 4.3 Provider adapters — `packages/runner/src/providers/` (NEW)

Each adapter implements the exact `verifyProduction*` seam every fixture file already declares and currently stubs (`collector.mjs.verifyProductionCollectorIntegration`, `decoder.mjs.verifyProductionTransaction`, `cycle-runner.mjs.verifyProductionProviderReceipt` — all throw `INTEGRATION_PENDING` today, `runner-cycle-b.json`). Re-implemented clean-room from the documented API shapes (`external-facts.json` collectorCryptProductionApi, crossChainUsdgSolanaCircleUsdRoutes) and, for technique only, informed by the historical `mainnet-cycle-canary` branch's real client code (`packages/integrations/src/collector-crypt.js`, `relay-client.js`, `solana-rpc-transaction-submitter.js`) per `product/SOURCE_BOUNDARY.md` — no address, key, or ABI is copied without re-verification against today's live evidence.

- **`collector-crypt-client.mjs`** (~200 lines): `generatePack`/`openPack`/`getBuyback`/`generateBuyback`/`submitTransaction`/`getPackStatus` against `https://gacha.collectorcrypt.com`, `x-api-key` header (docs require it; `GET /api/status`/`/api/machines` work unauthenticated today per live verification — mutation endpoints are documented as key-gated and untested by anyone in this repo, `external-facts.json` autonomyGaps). Returns objects shaped exactly like `collector.mjs`'s existing fixture schemas so the reducer needs zero changes.
- **`relay-client.mjs`** (~180 lines): `quote(originChainId, destinationChainId, originCurrency, destinationCurrency, amount, recipient)` → `POST /quote/v2`; `status(requestId)` → `GET /intents/status/v3`. Verified live for Robinhood 4663 USDG and Solana (792703809) Circle USD (`external-facts.json`).
- **`solana-wire.mjs`** (~350 lines, WP-09): hand-rolled Solana transaction message construction (compact-u16 arrays, `Memo`/`TransferChecked`/Collector-specific instruction encoding), base58, and an Ed25519 sign call delegated to the policy wallet — no `@solana/web3.js`. JSON-RPC client (`sendTransaction`/`getSignatureStatuses`/`getTransaction` at `finalized` commitment) using plain `fetch`.
- **`evm-wire.mjs`** (~250 lines, WP-10): minimal typed-transaction (EIP-1559) RLP encoding and a narrow ABI encoder covering exactly the known call shapes this system ever needs (`openPegCycle(bytes32)`, `executeOutbound(bytes32,bytes)`, `authorizeFunding/authorizePayout(...)`, `claimProgrammable/claimTreasury(address,address)`, plus Universal Router `execute(bytes,bytes[],uint256)`) — not a general ABI codec. JSON-RPC client requiring `finalized`/exact-block reads, matching the pattern `codex/complete-v4-hook` already hardened in `feasibility/verify-robinhood-binding.mjs` (finalized-tag-only, `eth_getProof`-derived codehash).
- **`robinhood-rpc.mjs`** (~120 lines): thin wrapper over `evm-wire.mjs` pinned to `https://rpc.mainnet.chain.robinhood.com` (verified live, chain id `0x1237`=4663, `external-facts.json`).

### 4.4 Policy wallets and signer — `packages/runner/src/automation/policy-wallets.mjs` (cherry-picked from `codex/complete-v4-hook`, extended, ~280 lines total, WP-11)

Adopt `EvmPolicyWallet`/`SolanaPolicyWallet` as-is (`policy-wallets.mjs:1-214` — already rejects raw key material in config, already checkpoints signed bytes idempotently, already tested against 6 adversarial cases, `branch-complete-v4-hook.json`). Add a `LocalEncryptedKeySigner` (AES-256-GCM, passphrase supplied once at process start via stdin, never logged, never persisted decrypted — §6) and a `KillSwitchGate` wrapper that checks `kill-switch.isPaused()` before delegating to the real signer, satisfying §2.5.

### 4.5 Holder snapshot indexer — `packages/runner/src/distribution/holder-snapshot.mjs` (NEW, ~300 lines, WP-13)

HKMN is a plain ERC20 (per `contracts-launch.json`'s `FixedSupplyBlindSpec` — full ERC20 transfer/approve semantics, no ERC6909 claim-token model). Two-phase: (1) a chunked `Transfer` event log scan (respecting Robinhood RPC's block-range limits, resumable via a persisted `lastScannedBlock` checkpoint) builds the candidate holder-address set; (2) at the cycle's finalized snapshot block, batch `balanceOf` reads (via `evm-wire.mjs`) reconstruct each address's exact balance — this two-step design (log-scan for discovery, direct read for the authoritative amount) avoids trusting a running log-derived balance, which could drift from re-orgs or missed events, while avoiding an unbounded balance-guess over "every address that ever existed." **Exclusions** (hardcoded, not configurable): `address(poolManager)` (holds the 90% pooled reserve under v4's singleton accounting, not a discrete holder), the permanent LP-position custody contract, `address(hook)`, `address(vault)`/its per-cycle escrows, `programmableBeneficiary`, `treasury`, and the zero address. Output schema matches `reconcile.mjs`'s existing `hookemon.input-bound-hkmn-snapshot-candidate.v1` shape exactly (`runner-distribution.json` keyFacts) so no downstream module changes.

### 4.6 Pro-rata manifest compiler — `packages/runner/src/distribution/manifest.mjs` + `reconcile.mjs` (EXTENDED, ~250 lines of changes, WP-06)

`reconcile.mjs` today only *verifies* an externally-supplied allocation sums exactly to the final USDG credit (`runner-distribution.json` invariants: "no file in packages/runner computes amount = balance*proceeds/totalSupply"). Add `computeProRataAllocation(snapshot, totalProceeds)`: largest-remainder method — `share_i = floor(balance_i * totalProceeds / totalSupply)`, remainder distributed one unit at a time to the entries with the largest fractional remainder, ties broken by ascending address — guarantees `sum(share_i) == totalProceeds` exactly, matching `REQ-cycle-runner-2`'s existing exact-sum requirement. Add `chunkIntoShards(entries, maxPerShard=1024)`: splits the allocation into `ceil(n/1024)` `payoutId`-keyed manifests, each independently building its own `CanonicalMerkleSum` tree (reusing `merkle-sum.mjs` unmodified) and its own 3-copy independent verification (`verifyDistributionCopies`, unmodified). `requirementsRevision` literal (currently hardcoded 56, `reconcile.mjs:201`) becomes a parameter bound to the new revision 58 (§3.4/§8).

### 4.7 Settlement worker — reuses `packages/runner/src/automation/fee-settlement.mjs` (cherry-picked as-is) and adds a periodic driver in `scheduler.mjs`'s companion loop (fee claims run on their own interval, independent of the pack cycle, per §2.3 step 12).

### 4.8 Configuration and secrets

Configuration (interval, pack allowlist, per-cycle caps) lives in the same operator state file as rev57's `cycle-plan.mjs`/`state-file.mjs` (extended with `intervalMs`, `packAllowlist[]`, `paused`, `perCycleSpendCapUsdg`, `dailySpendCapUsdg` fields) — one file, one CAS lock, matching the existing design rather than introducing a second config store. Secrets (the encrypted key file, the passphrase) never enter this file; §6 covers custody.

### 4.9 Observability

Structured JSON log lines to stdout (matching every existing script's convention, `control-plane.json` "all output is one JSON line to stdout") plus the journal itself, which is already a complete audit trail. No new logging library.

---

## 5. Dashboard

**Audience**: two distinct surfaces, per `phase-2-foundation-draft.md`'s still-open "Audience" row — this design answers it as *separated surfaces*, the safer of the two options the draft lists.

- **Operator console** (private): the owner only. Binds to `127.0.0.1` (or a private interface) plus a bearer token generated at first run and printed once to the terminal (never stored in git, matching AGENTS.md's "Ask first" gate on secrets). No public exposure.
- **Community status page** (public, read-only): anyone. Serves only finalized-chain-derived projections, matching `phase-2-foundation-draft.md`'s "Derived-data authority boundary" — every field is `available | unavailable | inconsistent`, never inferred success. No wallet connect, no write path of any kind.

**Storage**: the operator state file (§4.8) for config; a small read-only projection cache (`packages/dashboard/cache.json`, rebuilt from finalized chain reads on each poll, never authoritative — matches the same "derived-data" boundary).

**Tech**: `node:http` + static HTML/vanilla JS, zero build step, zero npm dependency — matching `control-plane.json`'s established discipline that adding an npm dependency requires "a lockfile, a CI install step, and a coordinated 3-way workflow-hash update." A dashboard is exactly the kind of surface where that cost is not worth paying for a framework.

**API endpoints** (operator console, all require the bearer token):

| Method | Path | Payload | Effect |
|---|---|---|---|
| GET | `/api/status` | — | current cycle stage, lease owner, budget-gate decision, last N cycle outcomes, fee-claim status |
| GET | `/api/config` | — | current `intervalMs`, `packAllowlist`, caps, `paused` |
| POST | `/api/config` | `{intervalMs?, packAllowlist?, perCycleSpendCapUsdg?, dailySpendCapUsdg?}` | CAS-writes the operator state file's config fields **only** — never triggers a cycle, never touches a key |
| POST | `/api/pause` | `{reason}` | sets `paused=true` (§2.5) |
| POST | `/api/resume` | `{}` | sets `paused=false` |
| POST | `/api/cycle/reconcile` | `{cycleId}` | invokes `reconcileUnresolvedIntent` (already-existing, evidence-gated, does not bypass the supersession cryptographic gate) |
| POST | `/api/cycle/supersede` | `{cycleId, proof, authorization}` | thin pass-through to `CycleRunner.supersedeUnobservedIntent` — the dashboard never fabricates the required dual-observer proof or policy-wallet authorization itself, it only relays what the operator (or an automated proof-gatherer, WP-15) already produced |

**Public endpoints** (no auth, GET-only):

| Path | Returns |
|---|---|
| `/public/api/status` | interval, next estimated window, last N cycles (pack, outcome, amount distributed, tx hashes), cumulative distributed-to-holders total, known-loss line items from any quarantined `FAILED` escrow (§2.4) |
| `/public/api/holders/:cycleId` | the published 3-copy-verified manifest digest and root for that cycle's payout(s), so any holder can independently verify their entitlement |

**Pages**: operator console (status, config form, pause/resume, cycle history with a "reconcile"/"supersede" action per stuck row); public page (plain HTML table, no JS framework, matches every other doc-generation convention in this repo).

---

## 6. Dependency and signer decision

**Recommendation: dependency-free Node builtins with hand-rolled EVM/Solana primitives, plus a local AES-256-GCM-encrypted key file unlocked by an operator-supplied passphrase at process start (not a remote KMS/HSM, not raw plaintext keys).**

Rationale: every file this design touches or extends already follows the zero-npm-dependency convention (`runner-cycle-a.json`, `runner-cycle-b.json`, `runner-distribution.json` externalDependencies all say "node:crypto only"), and `control-plane.json` documents exactly how expensive introducing one npm package is here — a lockfile, a CI install step, and a **3-way coordinated hash update** across the workflow file, `product/dependency-pins.json`, and `scripts/verify-control-dependencies.mjs`. The `evm-wire.mjs`/`solana-wire.mjs` surface this design needs is narrow (a handful of known call shapes, not a general SDK), so hand-rolling is bounded work, not an open-ended undertaking — and it keeps the entire signable-transaction-construction path auditable by direct code review rather than by trusting a third-party SDK's ABI encoder, which matters most exactly at the money-moving boundary (`architecture/risk-classes.json` R4).

For the signer: no HSM or cloud KMS is provisioned anywhere in this repository today (the legacy branch's Privy/macOS-Keychain integrations are explicitly non-authoritative, `product/SOURCE_BOUNDARY.md`). Standing up a remote signing service is real infrastructure work outside this design's scope. The pragmatic default is a locally-held, passphrase-encrypted key file that the operator unlocks once when the scheduler process starts (passphrase read from stdin or an OS keychain call, never written to disk decrypted, never logged — `PolicyWallet`'s existing config-validation already rejects any raw `privateKey`/`secretKey`/`mnemonic` field, `codex/complete-v4-hook policy-wallets.mjs`, so this constraint is enforced in code, not just by convention). This is Decision C in §11; a remote-signer upgrade path is explicitly preserved because `PolicyWallet` is already dependency-injected against a `signerClient` interface — swapping the local file signer for a remote one later requires no interface change.

**Alternative considered and rejected for now**: pinned npm packages (`viem`, `@solana/web3.js`) with a lockfile and CI changes — faster to build, but breaks the repo's supply-chain pinning discipline and adds an ongoing maintenance surface (version bumps requiring the 3-way hash coordination) for functionality this design can implement in ~700 lines total across `evm-wire.mjs`/`solana-wire.mjs`. Recommended only if the owner decides supply-chain purity matters less than delivery speed (Decision D, §11).

---

## 7. Launch path via Programmable on 4663

**Cannot happen today**: Programmable's discovery document lists chain 4663 with `status: planned`, and `GET /v4/chains/4663/capabilities` returns `readiness.status: unavailable, reasonCodes: [ROBINHOOD_CHAIN_PROFILE_UNAVAILABLE]` (verified live 2026-09-02, `external-facts.json`) — this is new since the repo's last snapshot (which showed no chain-4663 entry at all), but readiness is still explicitly not there. Nothing in this design, or any amount of local engineering, changes that; it is an external dependency with no committed ETA.

**Can be prepared now** (all read-only / draft artifacts, zero deployment):

- **`submission.json` draft** (WP-18, `release/phase2/submission.json`): the exact schema from `programmable-fee-policy.md` (§3.1 above quoted the template verbatim), filled with this repo's known values — `policyId: programmable-volume-fee-v1`, `policyVersion: 1.1.0`, `rates.selectedHundredthsOfBip: 30000` (3%), `platformHundredthsOfBip: 1000`, `projectHundredthsOfBip: 29000`, `ownership.owner: 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c`, `collection.status: pending-hook-integration` until WP-02/WP-03 land (then `implemented`), `swapModePaths` per the quadrant table already correctly implemented in `CanonicalMarket.sol` (`skill-and-prs.json` conformingOrLikelyCorrectAreas), `accounting.roundingPolicy: cumulative-independent-platform-project-remainders` (true only after WP-02), `accounting.minimumGrossQuoteUnits: 1000` (true only after WP-02), `collection.selfCallPolicy: same-pool-swap-forbidden`.
- **Launch plan**: the official stock `InstantLaunchStrategy` is hookless, native-ETH-paired, and fixed at 1,000,000,000 supply (`feasibility/official-robinhood-binding-recheck.json` negativeCompatibilityFacts) — unusable for HKMN's custom-hook, USDG-paired, 420.69B-supply design. A custom `LiquidityLauncher` strategy (or an LBP-migration path using `LBPStrategy` at `0x05d552391067389EE44fec3924157ed33F976000`, verified live) must be designed against Uniswap's real `liquidity-launcher`/`uerc20-factory` submodules (currently vendored but **unreferenced by any contract in this repo**, `contracts-launch.json` autonomyGaps) — this is design work that can start now against the pinned submodule source, independent of Programmable's readiness.
- **Hook CREATE2 salt mining**: `HookemonHook`'s constructor already self-checks the deployed address's low 14 bits against `0x00CC` (`contracts-kernel.json`). A salt-mining script against a *provisional* deployer address can run today and be re-run once the real launcher/factory address is confirmed — the mask constraint (`REQUIRED_HOOK_PERMISSION_MASK`) does not depend on Programmable's readiness at all.
- **The `router` binding discrepancy must be resolved before any of this is final**: the repo's pinned `universalRouter` (`0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99`, on-chain-verified) does not match Uniswap's own public v4-deployments page for chain 4663 (`0x8876789976decbfcbbbe364623c63652db8c0904`, fetched twice, byte-identical — `skill-and-prs.json` criticalDiscrepancy). This is Decision H in §11 and must be closed with a fresh live probe before `HookemonHook`'s immutable `swapRouter` is finalized, since that binding is a **constructor-time immutable** and cannot be changed post-deployment.

**Waits for external readiness**: actual submission to Programmable, actual admission/review, actual deployment via their launchpad, and anything the owner has not yet explicitly authorized (signing, broadcast, spend — AGENTS.md Never/Ask-first tiers, unaffected by any of this).

**Until then, the system runs in dry-run mode**: every provider adapter (§4.3) supports a `--dry-run` flag that performs the real read-only calls (quotes, balance reads, RPC probes) but refuses any call that would sign or broadcast, returning a structured "would have done X" record instead — this is the same "technical readiness never grants execution authority" principle already codified in `TB-19` and `docs/superpowers/specs/2026-08-31-phase-2-foundation-draft.md`'s "External-action boundary."

---

## 8. Process artifacts

### 8.1 Requirements revision 58 (outline)

Rev 56 is current on main; rev57 (unmerged, `codex/phase2-revision-57`) adds `REQ-cycle-control-1`. This design proposes **revision 58 = merged rev57 baseline + the following new/changed requirements**, once WP-01 lands rev57's content on main:

- `REQ-fee-policy-conformance-1` — the hook must track independent cumulative Programmable/treasury remainders for the canonical pool's lifetime and revert any positive gross quote amount below 1,000 smallest USDG units, matching `programmable-fee-policy.md` v1.1.0 exactly (supersedes the measurable behavior of `REQ-fee-accounting-1`).
- `REQ-fee-policy-conformance-2` — the deployed `programmableBeneficiary` must equal the immutable policy owner address; construction must revert otherwise.
- `REQ-autonomy-1` — a bounded, revocable standing signing authority may trigger repeated peg cycles on an operator-configured interval without a fresh owner authorization per action, subject to per-cycle and cumulative spend caps and an off-chain kill switch that takes effect before the next signature.
- `REQ-autonomy-2` — the operator may configure interval, pack allowlist, and caps through a private console; no configuration mutation may itself trigger a cycle, sign, or spend.
- `REQ-distribution-scale-1` — a holder distribution exceeding 1,024 recipients is split into multiple sequential, exactly-summing payout shards within one returned batch; no shard may commit before its predecessor.
- `REQ-recovery-1` — a returned amount below the cycle's minimum-return threshold reaches a distinct, explicitly flagged `DEGRADED_RETURN` state requiring one additional confirmation rather than either silently succeeding or becoming permanently stuck.
- `REQ-community-status-1` — a public, read-only status surface reports only finalized-chain-derived data, using `available|unavailable|inconsistent` states, never inferred success.

### 8.2 ADR-0021 (outline): "Bounded standing authority for repeated peg cycles"

Status: proposed, pending owner approval. Context: ADR-0019 made Operations a trigger-only identity with no custody; ADR-0018 deferred all automation to Phase 2; `policy.json`'s autonomy tiers currently hard-stop "any spend, credential use, or secret access" regardless of any standing grant (`control-plane.json` autonomyGaps). Decision: introduce exactly one new authority class — a policy-wallet-gated, per-key allowlisted, capped, and instantly revocable standing signing authority — scoped to the four keys named in §2.2, each restricted to the exact call shapes already defined by Phase 1's roles. This ADR does **not** grant any new on-chain role; it only authorizes an off-chain process to exercise the *existing* `operationsTrigger`/`authorizer`/policy-wallet identities repeatedly instead of once. Consequences: the owner must separately approve exact caps (per-cycle max spend, cumulative daily/weekly cap, revocation procedure) as an owner-approval artifact (§8.3), not as prose in this ADR.

### 8.3 Owner-approval drafts needed (unsigned, `decisions/owner-approvals/*.json`, schema `v4-owner-approval-v2`)

1. `phase-2-revision-58-spec-baseline-approved.json` — approves requirements revision 58 as the Phase 2 spec baseline.
2. `phase-2-adr-0021-standing-authority-approved.json` — approves ADR-0021 **with exact numeric caps filled in by the owner** (this draft ships with caps as `null`/placeholder; it cannot be a valid approval until the owner fills them).
3. `phase-2-fee-policy-conformance-build-approved.json` — approves the WP-02/WP-03 contract changes (analogous to Phase 1's `feasibility-override-build-now-approved.json` pattern).
4. `phase-2-launch-prep-approved.json` — approves preparing (not submitting) the `submission.json`/launch-plan/salt-mining artifacts of §7.

### 8.4 Delivery-boundary / CI / policy changes

- `product/delivery-boundary.json`: flip `phases.2` from `CLOSED` to `OPEN`, add a `deliveryPhase:2` sidecar for every new registry record — required because `scripts/check-delivery-boundary.mjs` hard-codes `phases:{'1':'OPEN','2':'CLOSED','3':'CLOSED'}` today (`control-plane.json`).
- `scripts/lib/ledger.mjs` / `scripts/lib/gates.mjs`: task deferral is hardcoded to `taskId === 'P1-011'` only (`control-plane.json` invariants) — this restriction is about *deferring* a task, not about *creating* new Phase 2 tasks, so no change is needed there for this work; it only matters if a future task needs deferring.
- `.github/workflows/v4-gates.yml` + `product/dependency-pins.json` + `scripts/verify-control-dependencies.mjs`: only touched if Decision D (§11) chooses pinned npm dependencies, or if a new CI job (e.g. a scheduled dry-run health check) is added — both require the documented 3-way coordinated hash update.
- Task ids: `codex/phase2-revision-57` already claims `P2-001..P2-012`; `codex/complete-v4-hook` separately and incompatibly claims `P2-001..P2-004` for different scope (`branch-complete-v4-hook.json` suspicion). **This design's new task cards are numbered `P2-013` through `P2-036`** (§10), reserving `P2-001..P2-012` for rev57's already-designed work once merged, and explicitly not reusing `codex/complete-v4-hook`'s colliding ids (its automation *code* is cherry-picked in WP-01; its task cards are not).

### 8.5 Docs to update

- Revise: `docs/modules/process-budget.md`, `docs/modules/peg-cycle-vault.md`, `docs/modules/cycle-runner.md`, `docs/modules/fee-accounting.md` (all gain a "Phase 2" section documenting the new automated caller, per the existing per-module contract-card format).
- New: `docs/modules/scheduler.md`, `docs/modules/policy-wallet.md`, `docs/modules/holder-snapshot.md`, `docs/modules/dashboard.md` (this **replaces**, under a fresh requirement id, the historical `docs/modules/dashboard.md` that is explicitly "Phase 2 Only... not an active Phase 1 module" today — `product-docs.json`; `REQ-dashboard-1` itself stays permanently reserved and is never reused, per ADR-0018).
- `README.md` / `product/PRD.md`: add a Phase 2 summary section once revision 58 is owner-approved.

---

## 9. Test and evidence strategy

Follows the builder skill's layered model (`security-and-evidence.md` §3-4) exactly, extending rather than replacing Phase 1's existing suites.

- **Unit**: every WP-02..WP-05 contract change gets boundary-value tests (zero, one, 999, 1000, 1001 quote units; cumulative-remainder equal-entitlement-for-split-vs-unsplit-volume, mirroring the policy's own required test #11) added to `FeeAccounting.t.sol`/`CanonicalMarketCallbackSurface.t.sol`/`PegCycleVault.t.sol` (WP-22).
- **Integration lifecycle**: extend `PhaseOneLocalLoop.t.sol`'s pattern (currently a single fixed-amount, single-recipient path, `contracts-tests-a.json` suspicion re: hand-picked `BalanceDelta`) into a `PhaseTwoLocalLoop.t.sol` that runs the full create→initialize→swap→accrue→claim→release→outbound→return→multi-shard-payout sequence through a **real** `PoolManager`/`PoolSwapTest` (as `RobinhoodV4PoolManager.t.sol` already does for the swap leg) rather than a hand-pranked delta.
- **Fuzz + stateful invariants**: extend `PhaseOneReleaseInvariant.t.sol`'s handler with the WP-04/WP-05 state transitions (degraded-return, multi-shard) as new invariant targets, and add the split-swap-bypass regression the policy names explicitly (`security-and-evidence.md` "compare N tiny withdrawals with one aggregate... may differ only by declared, bounded dust").
- **Adversarial mocks**: reuse the existing 8-variant adversarial-token harness (`VaultUsdg` in `PegCycleVault.t.sol`) against every new transfer path introduced by WP-04/WP-05.
- **Provider adapter tests (WP-23)**: each of WP-07..WP-10's real clients gets a fixture-replay test suite (record a real read-only response once, replay it deterministically in CI — the same pattern `verify-robinhood-binding.mjs` already uses for `--offline` mode) plus a `--dry-run` integration test that hits the *actual* live read-only endpoints (Collector `/api/status`/`/api/machines`, Robinhood RPC, Relay `/chains`) in a separate, explicitly-labeled, non-blocking CI job — never the mutation endpoints.
- **Dry-run mode (WP-24)**: a standalone script, `scripts/verify-phase2-readiness.mjs`, that performs every read this design needs against real endpoints (Robinhood RPC binding recheck, Programmable capabilities poll, Collector machine-list freshness, Relay chain-support check) and reports `INTEGRATION_PENDING` per item until every precondition is real — mirrors `feasibility/verify-robinhood-binding.mjs`'s existing fail-closed pattern exactly, extended to the new providers.
- **Live canary**: only after the owner has (a) approved ADR-0021 with real caps, (b) confirmed Programmable readiness has changed from `unavailable`, and (c) separately authorized one capped live run — rebuilt clean-room in the spirit of (but not copying code from) the legacy `mainnet-cycle-canary.js` one-pack canary, gated exactly as `TB-19` requires: "technical readiness never grants execution authority."

---

## 10. Ordered work packages

24 packages. Risk classes per `architecture/risk-classes.json` (R4 = irreversible custody/external-state, R3 = authority-binding/release-truth, R2 = deterministic read-only, R1 = docs). Commands assume `packages/contracts` for `forge` and repo root for `node --test`.

**WP-01 — Integration base assembly**
Goal: produce one buildable tree = main + semantic merge of `codex/phase2-revision-57`'s `PegCycleVault.sol`/`PegCycleReturnEscrow.sol`/operator-control modules + cherry-picked automation modules from `codex/complete-v4-hook` (`automated-cycle-service.mjs`, `budget-gate.mjs`, `exclusive-lease.mjs`, `policy-wallets.mjs`, `fee-settlement.mjs`, and the `SwapLiabilitiesAccrued` event applied to *main's* `FeeAccounting.sol`, not rev57's `ProcessBudget.sol` duplicate — main's `_transferUsdg`/`InvalidVaultUsdg` checks are strictly more defensive and must win, `branch-complete-v4-hook.json` suspicion). Also fixes the stale `docs/modules/cycle-runner.md` digest bug already found on rev57 (`branch-phase2-rev57.json` suspicion) and renumbers any colliding task ids.
Dependencies: none (first).
Write set: `packages/contracts/src/process/{PegCycleVault.sol,PegCycleReturnEscrow.sol,IPegCycleVault.sol}`, `packages/contracts/src/accounting/FeeAccounting.sol` (event only), `packages/runner/src/operator/*` (new dir, from rev57), `packages/runner/src/automation/*` (new dir, from complete-v4-hook), `docs/modules/index.json`, `tasks/context-packs.json`.
Read set: both branches in full (already read for this design), main's current `HookemonHook.sol`/`ProcessBudget.sol`.
Tests: `forge test --root packages/contracts`, `node --test packages/runner/test/operator/*.test.mjs packages/runner/test/automation/*.test.mjs packages/runner/test/cycle/*.test.mjs`, `node --test scripts/tests/gates.test.mjs` (must pass the module-index digest check this WP fixes).
Acceptance: 142/142 rev57 tests + all main tests + all complete-v4-hook automation tests pass against one tree; zero duplicate function signatures.
Risk: R4 (touches money-path contracts). Parallel: no — everything else depends on this.

**WP-02 — Fee policy: cumulative remainders + minimum-quote revert**
Goal: implement §3.1.
Dependencies: WP-01.
Write set: `packages/contracts/src/accounting/FeeAccounting.sol`, `packages/contracts/src/market/CanonicalMarket.sol`.
Read set: `programmable-fee-policy.md`, `standard-fee-kernel.md`.
Tests: `forge test --match-path 'test/accounting/*.t.sol'`, new boundary tests (0/999/1000/1001 units; split-vs-unsplit equal entitlement).
Acceptance: `type(uint256).max` split literals recomputed and match; a 999-unit swap reverts; splitting one 100,000-unit swap into 200 swaps of 500 units each yields the same cumulative Programmable entitlement as one swap, ±0.
Risk: R4. Parallel: no (blocks WP-22).

**WP-03 — Programmable owner pin + claim events + self-call policy evidence**
Goal: implement §3.2/§3.3.
Dependencies: WP-01.
Write set: `packages/contracts/src/bindings/RobinhoodBindings.sol`, `packages/contracts/src/HookemonHook.sol` (constructor check), `packages/contracts/src/accounting/FeeAccounting.sol` (events).
Read set: `bindings/robinhood-chain.json`.
Tests: `forge test --match-path 'test/bindings/*.t.sol'`, new constructor-revert test for a wrong `programmable` address, new same-pool-self-call-reverts test.
Acceptance: deployment with any `programmable != 0x4957f4...` reverts; `ProgrammableClaimed`/`TreasuryClaimed` events fire with correct indexed fields.
Risk: R4. Parallel: yes, with WP-02 (touches different functions in the same files — coordinate one PR).

**WP-04 — Degraded-return recovery state**
Goal: implement §3.4.
Dependencies: WP-01.
Write set: `packages/contracts/src/process/PegCycleVault.sol`, `packages/contracts/src/process/IPegCycleVault.sol`.
Read set: `contracts-process.json` suspicion at `PegCycleVault.sol:301`.
Tests: `forge test --match-path 'test/process/*.t.sol'`, new `test_degradedReturnRequiresExplicitFlagAndExactBalance`.
Acceptance: a return below `minimumReturnUsdg` without `acceptDegraded=true` still reverts (no silent laxity); with the flag, balance still must equal `rootSum` exactly.
Risk: R4. Parallel: yes, with WP-02/WP-03.

**WP-05 — Multi-shard payout authorization (on-chain)**
Goal: implement §3.5.
Dependencies: WP-01, WP-04 (same file).
Write set: `packages/contracts/src/process/PegCycleVault.sol`, `packages/contracts/src/payout/PayoutCommitment.sol`.
Read set: `runner-distribution.json` autonomyGaps (1024-cap).
Tests: `forge test --match-path 'test/process/*.t.sol' 'test/payout/*.t.sol'`, new multi-shard sequence test (3 shards, verify `RETURNED` persists between non-final shards, `PAYOUT_COMMITTED` only after the final one, sum of shard `rootSum`s equals total).
Acceptance: a 3-shard sequence with a deliberately wrong intermediate sum reverts atomically with no partial state change.
Risk: R4. Parallel: no (depends on WP-04, same files).

**WP-06 — Off-chain distribution chunking**
Goal: implement §4.6.
Dependencies: WP-05 (needs the new `PayoutAuthorization` shard fields).
Write set: `packages/runner/src/distribution/{manifest.mjs,reconcile.mjs}`.
Read set: `runner-distribution.json` publicInterface.
Tests: `node --test packages/runner/test/distribution/*.test.mjs`, new tests for `computeProRataAllocation` (exact-sum property, largest-remainder correctness against a hand-computed 7-entry fixture) and `chunkIntoShards` (2049 holders → 3 shards of ≤1024).
Acceptance: for any holder count 1..5000 (fuzzed), `sum(all shards' entries) == totalProceeds` exactly.
Risk: R3 (release-truth: this data becomes an on-chain authorization). Parallel: no.

**WP-07 — Real Collector Crypt provider adapter**
Goal: implement §4.3 `collector-crypt-client.mjs`.
Dependencies: WP-01.
Write set: `packages/runner/src/providers/collector-crypt-client.mjs`, wires into `packages/runner/src/cycle/collector.mjs`'s `verifyProductionCollectorIntegration`.
Read set: `docs.collectorcrypt.com/gacha/api`, `packages/runner/src/cycle/collector.mjs`.
Tests: `node --test packages/runner/test/providers/collector-crypt-client.test.mjs` (fixture-replay, no live calls in CI); manual `--dry-run` against live `/api/status`/`/api/machines`.
Acceptance: schema output matches `collector.mjs`'s existing fixture shape byte-for-byte; no mutation call is ever made outside `--live` mode, which this WP does not enable.
Risk: R3 (feeds an R4 action but does not itself sign/spend). Parallel: yes, with WP-08/WP-09/WP-10.

**WP-08 — Real Relay bridge adapter**
Goal: implement §4.3 `relay-client.mjs`.
Dependencies: WP-01.
Write set: `packages/runner/src/providers/relay-client.mjs`.
Read set: `api.relay.link` docs, `external-facts.json` crossChainUsdgSolanaCircleUsdRoutes.
Tests: fixture-replay test + `--dry-run` quote against live `/quote/v2` (read-only; a quote is not a mutation).
Acceptance: quote response validated against both EVM and Solana leg shapes for both directions.
Risk: R3. Parallel: yes.

**WP-09 — Solana wire primitives**
Goal: implement §4.3 `solana-wire.mjs`.
Dependencies: none beyond WP-01.
Write set: `packages/runner/src/providers/solana-wire.mjs`.
Read set: Solana transaction/message wire format (external), `collector-transaction-policy.js` from the legacy branch (technique reference only, per `product/SOURCE_BOUNDARY.md`).
Tests: round-trip encode/decode tests against known-good Solana transaction byte fixtures; base58 known-answer tests.
Acceptance: encodes a `Memo`+`TransferChecked` pair byte-identical to a reference transaction.
Risk: R4 (constructs signable transactions). Parallel: yes, with WP-10.

**WP-10 — EVM wire primitives**
Goal: implement §4.3 `evm-wire.mjs`, `robinhood-rpc.mjs`.
Dependencies: none beyond WP-01.
Write set: `packages/runner/src/providers/{evm-wire.mjs,robinhood-rpc.mjs}`.
Read set: EIP-1559 typed-transaction spec (external), the exact call shapes named in §4.3.
Tests: known-answer RLP-encoding tests; a `finalized`-tag-only enforcement test (rejects any RPC call that doesn't pin block tag or number).
Acceptance: encodes each of the 5 named call shapes byte-identical to a `forge script --sig` reference encoding.
Risk: R4. Parallel: yes, with WP-09.

**WP-11 — Policy wallets + local encrypted signer**
Goal: implement §4.4/§6.
Dependencies: WP-09, WP-10 (signs the wire formats they produce).
Write set: `packages/runner/src/automation/policy-wallets.mjs` (extend), new `packages/runner/src/automation/local-encrypted-signer.mjs`, `kill-switch.mjs`.
Read set: `codex/complete-v4-hook policy-wallets.mjs` (adopted base).
Tests: `node --test packages/runner/test/automation/policy-wallets.test.mjs` (existing 6 cases) + new: passphrase-wrong rejects, paused-flag blocks signing, key never appears in process env/log output (grep-based test over captured stdout/stderr).
Acceptance: `sign()` throws `Paused` when `kill-switch.isPaused()` is true, with zero signature produced.
Risk: R4. Parallel: no.

**WP-12 — Scheduler**
Goal: implement §4.1.
Dependencies: WP-01, WP-11.
Write set: `packages/runner/src/automation/scheduler.mjs`.
Read set: `codex/complete-v4-hook automated-cycle-service.mjs`.
Tests: `node --test packages/runner/test/automation/scheduler.test.mjs` — mocked clock, verifies interval re-read each tick, verifies pause short-circuits before any provider call, verifies crash-recovery calls `recoverActiveCycle` not `runOnce` when a cycle is active.
Acceptance: changing `intervalMs` via the operator state file takes effect on the very next tick without a process restart.
Risk: R3 (orchestration, not itself money-moving). Parallel: no.

**WP-13 — Holder snapshot indexer**
Goal: implement §4.5.
Dependencies: WP-10.
Write set: `packages/runner/src/distribution/holder-snapshot.mjs`.
Read set: `contracts-launch.json` (HKMN is plain ERC20), `runner-distribution.json` (snapshot schema).
Tests: fixture-replay against a recorded log-scan + balance-read sequence; exclusion-list test (pool/hook/vault/treasury/programmable never appear in output even if they hold a nonzero balance in the fixture).
Acceptance: two independent scans of the same finalized block produce byte-identical output (determinism required for the 3-copy verification in §4.6 to mean anything).
Risk: R3. Parallel: yes, with WP-06/WP-14/WP-15.

**WP-14 — Fee settlement automation**
Goal: wire `fee-settlement.mjs` (cherry-picked in WP-01) into a periodic driver.
Dependencies: WP-01, WP-11.
Write set: `packages/runner/src/automation/scheduler.mjs` (companion loop, small addition).
Read set: `codex/complete-v4-hook fee-settlement.mjs` (adopted as-is).
Tests: `node --test packages/runner/test/automation/fee-settlement.test.mjs` (existing 4 cases) + one new test that the companion loop never runs concurrently with a pack-cycle claim on the same nonce.
Acceptance: claiming never blocks or is blocked by the pack cycle's own lease.
Risk: R4 (claims move funds). Parallel: yes, with WP-13.

**WP-15 — Stuck-cycle recovery orchestration**
Goal: automate *gathering* the dual-observer proof `supersedeUnobservedIntent` requires (the signature itself stays manual/policy-wallet-gated, per §2.4).
Dependencies: WP-08 (Relay status), WP-09/WP-10 (chain reads), WP-11.
Write set: `packages/runner/src/automation/stuck-cycle-detector.mjs` (NEW, ~200 lines).
Read set: `codex/complete-v4-hook reducer.mjs` supersession fixtures.
Tests: `node --test packages/runner/test/automation/stuck-cycle-detector.test.mjs` — given a broadcast with no finalized observation after N confirmations, produces a valid unsigned proof object matching the reducer's expected shape.
Acceptance: never produces a proof for a mutation that *did* land (false-positive rate must be provably zero given finalized-only reads).
Risk: R3. Parallel: yes, with WP-13/WP-14.

**WP-16 — Dashboard backend**
Goal: implement §5 API.
Dependencies: WP-01, WP-11, WP-12.
Write set: `packages/dashboard/src/server.mjs` (NEW, ~400 lines), `packages/dashboard/src/routes/*.mjs`.
Read set: rev57's `state-file.mjs`/`control.mjs` (reused for CAS config writes).
Tests: `node --test packages/dashboard/test/*.test.mjs` — every mutation endpoint tested for CAS-rejection on stale revision, bearer-token enforcement, and that `/api/config` never triggers `AutomatedCycleService`.
Acceptance: no endpoint can produce a signature or a broadcast; `curl` fuzzing of malformed JSON never crashes the process.
Risk: R2 (config mutation) for `/api/config`/`/api/pause`; R3 for `/api/cycle/reconcile`/`/api/cycle/supersede` (they invoke authority-binding logic). Parallel: no.

**WP-17 — Dashboard frontend**
Goal: implement §5 pages.
Dependencies: WP-16.
Write set: `packages/dashboard/public/{operator.html,status.html}` (NEW, ~500 lines combined, vanilla JS).
Read set: WP-16's API shapes.
Tests: manual/visual; one automated smoke test hitting `GET /api/status` and asserting the HTML renders the expected fields (jsdom-free, string-match against the served bundle).
Acceptance: public page renders with zero JS errors when every backend field is `unavailable`.
Risk: R1. Parallel: yes, with everything except WP-16 (its only dependency).

**WP-18 — `submission.json` + launch-plan draft**
Goal: implement §7's prepared artifacts.
Dependencies: WP-02, WP-03 (submission fields depend on the fixed contract behavior).
Write set: `release/phase2/submission.json`, `release/phase2/launch-plan.md`.
Read set: `programmable-fee-policy.md`, `feasibility/official-robinhood-binding-recheck.json`.
Tests: `node --test scripts/tests/submission-schema.test.mjs` (NEW) — validates the JSON against the policy's schema shape.
Acceptance: every field the policy marks required is non-null except those explicitly gated on external readiness.
Risk: R1 (documentary — makes no on-chain or external-mutation claim). Parallel: yes.

**WP-19 — Hook CREATE2 salt mining**
Goal: implement §7's deterministic deployment plan.
Dependencies: WP-01 (needs the final `HookemonHook` bytecode including WP-02/WP-03 changes).
Write set: `packages/contracts/script/release/MineHookSalt.s.sol` or `scripts/mine-hook-salt.mjs` (NEW, ~150 lines).
Read set: `contracts-launch.json` (`PhaseOneReleasePlan.sol` CREATE2 pattern).
Tests: `forge test` or `node --test` verifying the mined salt's resulting address really has low-14-bits `0x00CC`.
Acceptance: deterministic — the same source + salt always mines the same address.
Risk: R2 (read-only computation, no deployment). Parallel: yes.

**WP-20 — Requirements revision 58 + ADR-0021 + owner-approval drafts + delivery-boundary/CI**
Goal: implement §8.1-8.4.
Dependencies: WP-01 through WP-06 (the requirements text must describe what actually shipped).
Write set: `specs/requirements.json`, `decisions/ADR-0021-bounded-standing-authority.md`, `decisions/owner-approvals/phase-2-*.json` (unsigned drafts), `product/delivery-boundary.json`, `architecture/interfaces.json`, `tasks/P2-013.md`..`P2-036.md`, `tasks/context-packs.json`.
Read set: every ADR and requirement cited in §8.
Tests: `node --test scripts/tests/{reqs,delivery-boundary,gates}.test.mjs`.
Acceptance: `node scripts/v4.mjs status --check` reports the new revision as internally consistent (not stale) against its own bound receipts.
Risk: R3 (governs whether R4 work may proceed). Parallel: no — sequenced after the contract/runner WPs it documents, but does not block them.

**WP-21 — docs/modules updates**
Goal: implement §8.5.
Dependencies: WP-20 (needs final requirement ids to cite).
Write set: `docs/modules/{process-budget,peg-cycle-vault,cycle-runner,fee-accounting,scheduler,policy-wallet,holder-snapshot,dashboard}.md`, `README.md`, `product/PRD.md`.
Read set: every module card touched.
Tests: `node --test scripts/tests/*.test.mjs` (module-index digest check).
Acceptance: `docs/modules/index.json` digests match disk for every touched card.
Risk: R1. Parallel: yes, with WP-17/WP-18.

**WP-22 — Contract test additions for WP-02..WP-05**
Goal: implement §9's unit/integration/fuzz layer for the contract WPs.
Dependencies: WP-02 through WP-05.
Write set: `packages/contracts/test/{accounting,market,process,payout}/*.t.sol` (extensions), new `packages/contracts/test/integration/PhaseTwoLocalLoop.t.sol`.
Read set: `security-and-evidence.md` §4.
Tests: `forge test` (full suite).
Acceptance: every new invariant in `PhaseOneReleaseInvariant.t.sol`'s handler survives 100,000+ fuzz runs with zero violations (matching the existing bar, `product-docs.json` keyFacts).
Risk: R4 (verifies R4 code — errors here hide real bugs). Parallel: no.

**WP-23 — Runner test additions for WP-07..WP-15**
Goal: implement §9's provider-adapter and dry-run test layer.
Dependencies: WP-07 through WP-15.
Write set: `packages/runner/test/providers/*.test.mjs`, `packages/runner/test/automation/*.test.mjs` (new cases).
Read set: every provider adapter's real API docs.
Tests: `node --test packages/runner/test/providers/*.test.mjs packages/runner/test/automation/*.test.mjs`.
Acceptance: 100% of fixture-replay tests pass with zero network access (verified via a CI network-isolation check).
Risk: R3. Parallel: no.

**WP-24 — Live dry-run verification harness**
Goal: implement §9's `scripts/verify-phase2-readiness.mjs`.
Dependencies: WP-07, WP-08, WP-10, WP-18.
Write set: `scripts/verify-phase2-readiness.mjs` (NEW, ~400 lines, modeled on `feasibility/verify-robinhood-binding.mjs`).
Read set: `feasibility/verify-robinhood-binding.mjs` (pattern reference).
Tests: `node --test scripts/tests/phase2-readiness.test.mjs` (offline mode against recorded fixtures) + manual live run.
Acceptance: reports `INTEGRATION_PENDING` for Programmable submission/admission (true today) and `PASSED` for every other precondition that is actually live (Robinhood RPC, Uniswap v4 addresses, Relay, Collector reads) — matching the exact live-verification results already recorded in `external-facts.json`.
Risk: R2. Parallel: yes, with WP-17/WP-18/WP-21.

---

## 11. Open owner decisions

**A. Integration base.** Recommended: main + semantic merge of `codex/phase2-revision-57` + cherry-pick of `codex/complete-v4-hook`'s automation modules (this document's WP-01). Alternative: start Phase 2 fresh off main only, redesigning the CREATE2-escrow/operator-control layer from scratch — rejected as needless rework given rev57's 142/142 passing tests and clean design (`branch-phase2-rev57.json`).

**B. Hook changes before deployment.** Recommended: exactly WP-02 through WP-05 (fee-policy conformance, Programmable-owner pin, degraded-return state, multi-shard payout) — no router-binding relaxation (§3.6). Alternative: also loosen the single-router binding to accept any caller with fee enforced regardless of router — rejected: no operational benefit to this design, widens attack surface, and is a much larger `REQ-canonical-market-*` spec revision than the fee-policy fixes alone.

**C. Custody model for unattended operation.** Recommended default: local AES-256-GCM-encrypted key file, passphrase supplied once at process start, four distinct policy-wallet-gated keys (§2.2), off-chain kill switch enforced at `sign()` (§2.5), and the owner must supply exact spend caps in the ADR-0021 approval artifact (§8.3) — this design ships no default caps, they are the owner's number to choose. Alternative: remote policy signer (Privy-style or a cloud KMS) — safer against local key exfiltration but requires standing up infrastructure this repo has none of today; recommended as a Phase 2b upgrade once the local-signer path is proven, not as the v1 default.

**D. Runtime dependencies.** Recommended: dependency-free Node builtins with hand-rolled EVM/Solana primitives (§6). Alternative: pinned npm packages (`viem`, `@solana/web3.js`) with lockfile + CI changes — faster, less auditable, breaks the existing supply-chain-pinning discipline; recommended only if delivery speed outweighs that.

**E. Scheduler and stuck-cycle model.** Recommended: `AutomatedCycleService` (as-is from `codex/complete-v4-hook`) wrapped in a plain interval loop (§4.1), with `supersedeUnobservedIntent` kept deliberately manual/cryptographically-gated for the on-chain-committing recovery path, and a fully automated proof-gathering step (WP-15) that only *prepares* what a human or the policy-wallet still must sign. Alternative: make `supersedeUnobservedIntent` itself fully automatic once dual-observer proof exists — rejected: this removes the last human checkpoint on an action that can move an entire cycle's principal to a different intent; recommend keeping it gated unless the owner explicitly wants otherwise.

**F. Holder distribution at scale.** Recommended: multi-shard on-chain payout authorization (§3.5, WP-05) — a real contract change to `authorizePayout`'s exact-balance invariant. Alternative: cap Phase 2 automation to holder counts ≤1024 and defer chunking to a later phase — this would silently break "distributed pro rata to HKMN holders automatically" once the community exceeds 1024 wallets, which is a real risk for any successful community token; recommend building the chunking now rather than retrofitting it under time pressure later. Pro-rata rounding rule: largest-remainder method, ties broken by ascending address (deterministic, auditable, matches the exact-sum requirement already in `REQ-cycle-runner-2`). Snapshot source: recommended two-phase log-scan-for-discovery + finalized-block-balanceOf-for-amount (§4.5) over pure log-derived running balances, which would trust an unverified running total; alternative (eth_call-only, no log scan) requires a pre-known holder address list from elsewhere, which does not exist. Exclusions: PoolManager, LP-custody contract, hook, vault/escrows, treasury, programmable beneficiary, zero address — fixed list, not configurable (a configurable exclusion list would itself need owner-approval-gated changes, adding complexity for no benefit at this holder count).

**G. Dashboard.** Recommended: separated operator/public surfaces, `node:http` + static HTML, config-only mutation authority (§5). Alternative: a single combined surface with role-based access — rejected as unnecessary complexity and a larger attack surface for the private console.

**H. Universal Router address.** Must be resolved with a fresh live probe before any deployment: repo-pinned `0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99` vs. Uniswap's current public docs `0x8876789976decbfcbbbe364623c63652db8c0904` (§7). This is not this design's decision to make — it requires an authoritative, timestamped, reproducible on-chain probe (bytecode read at both addresses, presence/absence check) recorded as a fresh binding evidence file before `HookemonHook`'s immutable `swapRouter` constructor argument is chosen.

**I. Fee-split wording.** The owner's transcribed "0.5% separated: 0.5% treasury, 0.1% Programmable" does not literally match the repo's coded 0.40% treasury + 0.10% Programmable = 0.50% combined (`contracts-process.json` keyFacts, `product-docs.json` keyFacts). Recommended: treat the repo-coded 300/10/40/250bps split as authoritative (it is owner-approved via ADR-0016 and unanimously corroborated across every branch and the historical legacy code) and ask the owner to confirm this reading explicitly rather than silently reinterpreting the transcript.

**J. "Bybit."** Recommended: treat as a mis-transcription of "buyback" — Bybit's NFT marketplace has been shut down since 2025-04-08 and never had a Collector Crypt integration (verified live, `external-facts.json` bybit). Recommend a one-line owner confirmation before finalizing any spec text that names the sale mechanism.

---

## 12. What cannot be finished without external readiness, and dry-run behavior until then

Blocked on external readiness, with no committed ETA:

- **Programmable production launch on 4663** — `readiness.status: unavailable`, `ROBINHOOD_CHAIN_PROFILE_UNAVAILABLE` (verified live 2026-09-02). Nothing this design does changes this; §7 defines everything that *can* be prepared meanwhile.
- **A confirmed, funded HKMN token and canonical PoolKey** — does not exist; depends on the above.
- **Funded operator wallets** (Robinhood-side gas, Solana-side SOL/Circle USD float, the process-budget itself accruing real fee volume) — depends on the pool existing and trading.
- **API keys** (Collector Crypt `x-api-key` for mutation endpoints — undocumented whether the repo has ever obtained one; `external-facts.json` notes the documented requirement conflicts with today's unauthenticated GET behavior and mutation endpoints are entirely untested).
- **Owner-signed ADR-0021 with real spend caps** — this design deliberately ships no default caps; standing signing authority cannot exist without them.

**Until all of the above are true, the system operates exclusively in dry-run mode** (§7, §9 WP-24): every provider adapter performs real read-only calls where they are already live (Robinhood RPC, Uniswap v4 addresses, Relay `/chains` and `/quote/v2` read paths, Collector's unauthenticated GET endpoints) and refuses every call that would sign, broadcast, spend, or mutate external state, returning a structured "would have done X, blocked because Y" record instead. `scripts/verify-phase2-readiness.mjs` (WP-24) is the single source of truth for which preconditions are currently real versus still pending, re-run on demand or on a read-only CI schedule, reporting exactly the same fail-closed status this repo's existing `feasibility/verify-robinhood-binding.mjs` already establishes as the house style.
