> ## Audit status update (2026-09-04)
>
> The adversarial audit confirmed narrow local safeguards: canonical-pool callback checks,
> exact USDG balance-delta collection, and the absence of a deployed or authorized live path.
> It refuted or narrowed the broad historical claims that the complete fee path, launch
> composition, Operations claims, and holder payout were sound end to end. In particular,
> the audit recorded defects or missing proofs for launch liquidity and custody, external
> pool initialization, gross-fee accounting, destination handling, runner wiring, and payout
> execution. The authoritative finding dispositions are in
> [traceability.json](../../audit/2026-09-04/traceability.json); the approved Phase 3
> remediation boundary is the [Operations-wallet revision pointer](2026-09-04-phase3-operations-wallet.md).
> This status block preserves the historical audit below and grants no live authority.

# Historical Money-Path Audit: Findings and Remediation Master Plan

Audited revision: `codex/rehearsal-collector-only` @ `932b1d3` (PR #5), 2026-09-04.
Scope: every contract under `packages/contracts/src`, every live stage under
`packages/adapters/src/app/stages`, runner wiring, Forge + Node test suites, cleanroom, status gate.

Verdict: **the contracts are sound (exact balance deltas, solvency checks, dual EIP-712 signatures,
lifecycle gates, fee split 10/40/250 bps correct), but the money path is NOT executable end to end.**
It breaks at four chain/runner seams and can permanently lock funds at two places. Nothing is deployed
or live today.

---

## Part A — Verified working

| Area | Finding |
|---|---|
| Fee split | `FeeAccounting.sol` L8–17: 300 bps total = 10 (Programmable 0.1%) + 40 (treasury 0.4%) + 250 (process pot 2.5%). Cumulative-remainder rounding, no wei leakage across swaps. |
| Fee collection | `_accrueAuthenticatedSwap`: hook USDG delta must equal the computed fee exactly; solvency checked after every accrual. |
| Hook callbacks | PoolManager-only; canonical pool matched exactly (currencies, fee=0, tickSpacing, hooks=this, protocolFee=0, lpFee=0). All 8 swap quadrants tested (`HookemonHook.t.sol:389,444–455`, `RobinhoodV4PoolManager.t.sol:365–377`). |
| Claims 0.1 / 0.4 | Programmable beneficiary immutable; treasury only via propose/accept; destination must equal beneficiary; hook never a destination. Rotation + claim tested (`FeeAccounting.t.sol:178–190`). |
| Pot → escrow | `ProcessBudget.openPegCycle`: debits liability, transfers exactly the authorized amount into the CREATE2 escrow, confirms funding. |
| Vault lifecycle | EMPTY → FUNDED → OUTBOUND → RETURNED → PAYOUT_COMMITTED; FAILED/DEGRADED terminal; successor requires terminal receipt. Recovery tested (`PegCycleVaultRecovery.t.sol`, `PegCycleReturnDegraded.t.sol`). |
| Payout | Dual EIP-712 (signer ≠ verifier ≠ authorizer), replay/malleability/swap tested. Merkle-sum depth 10, domain-bound. `payEntitlement` double-pay safe; failed transfer tested (`HolderSettlement.t.sol:88–114`). |
| Node tests | adapters 140/140, runner 255/255, fixture verification OK. |

---

## Part B — Findings by severity

Tags: **[DEFECT]** code bug · **[MISSING]** wiring/integration absent · **[BLOCKER]** deploy/config ·
**[DECISION]** owner decision open · **[TEST]** test/evidence gap.

### CRITICAL — path breaks or funds strand

**K1 [DEFECT] Outbound route data does not match the contract — `executeOutbound` always reverts.**
- Where: `packages/adapters/src/app/stages/action-builder.mjs:211–219` (`extractRouteData`),
  `funding.mjs:142–145`, `outbound.mjs:79`, `packages/contracts/src/process/PegCycleRouteExecutor.sol:91–121`.
- What: the runner freezes Relay's **raw transaction calldata** (`step.data.data`) and passes it as
  `routeData`; the contract does `abi.decode(routeData, (RouteParams{target,amount,requestId,minimumReceive}))`
  — a different format → decode revert / `InvalidRoute`.
- Also: the executor ignores Relay's `data.to` and only moves funds to the **immutable `depositTarget`** via a
  bare `transfer()` (no requestId) or a token callback (USDG is plain ERC-20, no `transferAndCall`). Relay cannot
  attribute such a deposit to the quote → **USDG sits with the Relay solver unattributed = loss / manual
  recovery.** The code itself marks this `INTEGRATION_PENDING`.
- Also: the quote is frozen at funding time (24 h expiry) while Relay quotes expire within minutes; quote
  `user` is the escrow but the actual sender is the route executor.
- Impact: outbound bridge cannot work; if it ever did, funds could strand at the solver.
- Fix: settle the Relay ERC-20 deposit mechanics for contract senders **with Relay** (deposit address, how
  `requestId` is conveyed, validity window). Then: off-chain builds `abi.encode(RouteParams)` from the quote
  (target = Relay deposit, requestId = quote requestId, minimumReceive = quoted output); executor conveys the
  requestId on-chain (callback path or Relay depository call). Quote just before `executeOutbound`; set
  `outboundActionDigest` at execution time via renewal/fresh authorization, or hash only stable fields.
- Acceptance: Anvil-fork test where `executeOutbound` succeeds with runner-built route data, plus a small
  testnet bridge arriving on Solana.

**K2 [MISSING] `openPegCycle` is never called — a cycle never starts.**
- Where: `funding.mjs` only sends `authorizeFunding`; `hook-contract-client.mjs:179` is a calldata builder
  with no caller.
- Impact: vault stays EMPTY/pending; `executeOutbound` → `InvalidLifecycle`. Pot stays in the hook (safe,
  never circulates). Pending authorization expires after 24 h.
- Fix: two idempotent funding phases (pattern: `payout.mjs`): 1) `authorizeFunding` (authorizer),
  2) `openPegCycle` (operations trigger — `msg.sender` is bound as the trigger). `funding` is COMPLETE only
  after phase 2's finalized receipt.
- Acceptance: unit tests with a fake chain (both phases, crash-resume, revert path) + fork test vault `FUNDED`.

**K3 [MISSING] Holder payout ends in the hook — `commitPayoutChunk` and `payEntitlement` have no callers.**
- Where: `packages/runner/src/distribution/settlement-worker.mjs` complete but not wired into
  `bin/hookemon-runner.mjs`/dashboard; no stage sends `commitPayoutChunk`.
- Impact: after `fundPayoutFromPegCycle` the whole payout sits as `payoutLiability`, manifest stays open,
  no holder receives USDG.
- Fix: a) `commit` stage (authorizer) after `payout`: `commitPayoutChunk(payoutId, 0, chunkRoot, chunkSum)`
  until `manifestClosed`. b) settlement worker as runner subcommand/daemon with a real `submitEntitlement`
  (EVM signer, proofs from the manifest), durable progress, idempotency via `isEntitlementPaid`.
- Acceptance: fork test: payout liability → 0, every leaf `paid`, hook solvency preserved.

**K4 [MISSING] 0.1% / 0.4% cannot be collected — no tooling for `claimProgrammable` / `claimTreasury`.**
- Fix: CLI subcommand `claim-treasury` (signer = treasury wallet) + documented Programmable claim runbook.

### HIGH — permanent lock-up / silent loss

**H1 [DECISION + DEFECT] Escrow residue is locked forever.**
- Where: `PegCycleReturnEscrow.sol:43–51` (only `sendOutbound`/`sendPayout` via the vault);
  `PegCycleVault.consumePayoutAuthorization` pulls only `rootSum`; `recordDegradedReturn` doc: "no other function
  ever sweeps". `distribution.mjs:404` passes **no `previousDust`**.
- Impact: 1) per-cycle rounding dust stays in the escrow irrecoverably; 2) **every DEGRADED return (rehearsal:
  25 in, 17 back) locks the entire returned amount forever**; 3) FAILED escrows with residue likewise.
- Fix (pre-deployment; escrow is immutable): vault function `sweepTerminalEscrow(cycleId)` — authorizer only,
  lifecycle FAILED/DEGRADED/PAYOUT_COMMITTED only, destination exclusively the hook, booked as
  `processLiability` (back into the pot). Dust carry-forward in the runner (`previousDust` from last cycle).
- Acceptance: tests: sweep only in terminal states, exact deltas, hook solvent; runner dust carry-forward test.

**H2 [DEFECT] Safety minima are placeholders `'1'`.**
- Where: `funding.mjs:171–175` (`minimumRobinhoodReceive`, `minimumSolanaReceive`, `minimumReturnUsdg`,
  gas caps).
- Impact: a 1-wei return counts on-chain as a "clean" payout → bridge/buyback losses are silently distributed
  pro rata to holders; gas caps are ineffective.
- Fix: values mandatory from config (fail closed, no defaults); `minimumReturnUsdg` as owner policy (e.g. x%
  of release amount).

**H3 [TEST] Relay never exercised live in either direction; return is passive.**
- `return.mjs` bridges the Solana balance; the Robinhood side has no evidence beyond an escrow balance read at
  `latest` (`distribution.mjs:300`, not `finalized`).
- Fix: read the escrow balance at a finalized block; testnet round trip with a minimal amount before any
  production cycle.

**H4 [DEFECT] `open` and `purchase` stages are not crash-safe.**
- Where: `open.mjs:78–86`, `purchase.mjs:14–25` — no `readStageAttempt` before mutating (every other stage has
  one).
- Impact: after a crash between API call and journal write, a second `openPack` → Collector answers "already
  opened" without `transactionSignature` → `mint: null` → buyback **unreachable for that cycle**, card stays in
  the wallet. For `purchase`: double buy possible.
- Fix: idempotency guard as in `funding.mjs:112`; for `open` add a `getPackStatus` fallback for mint discovery.

**H5 [MISSING] No recovery controls in the runner.**
- `cancelExpiredFundingAuthorization`, `renewFundingAuthorizationDeadline`, `renewPayoutAuthorizationDeadline`,
  `recordTerminalFailure`: calldata builders only, no caller/CLI. A stuck cycle is only recoverable by hand-crafted
  transactions.
- Fix: CLI subcommands with standing-authority intents (pattern: `accept-degraded-return`).

**H6 [BLOCKER] Production prerequisites entirely absent.**
- No contract deployed; Robinhood PoolKey `INTEGRATION_PENDING`; five distinct signers (authorizer, operations
  trigger, distribution signer, distribution verifier, Solana) not provisioned; Relay/Collector credentials;
  Programmable reports only chain 1 live, Robinhood 4663 "planned" — no launch path for the hook.

### MEDIUM

- **M1 [DECISION]** Fee policy: "0.5% treasury" = 0.4 + 0.1 (current code) or a separate 0.5? Fix in writing
  before deployment (constants are immutable).
- **M2 [DEFECT]** `distribution.mjs:330` writes `operationsTrigger: config.accounts.evm` (the authorizer) into
  the ledger instead of `config.accounts.operationsTrigger` → wrong field in the evidence digest.
- **M3 [MISSING]** Chunked payouts inactive: >1024 holders → `distribution` throws (`distribution.mjs:409`).
  Estimate holder count before launch.
- **M4 [TEST]** CI red: `gates` job fails at `v4.mjs status --check` (all 8 phase receipts STALE). Locally Forge
  240/246 (4 constructor tests fail under Forge 1.8.1 while CI pins 1.7.1 → likely toolchain drift, verify with
  1.7.1; 1 test needs `--ffi`); cleanroom 24 violations (historical ticker identifiers).
- **M5 [TEST]** Slither `divide-before-multiply` in `FeeAccounting.sol:258` is mathematically correct
  (high/low split) — document as false positive.
- **M6 [DECISION]** Economics: the rehearsal returned 25 → 17 (−32%) per pack. With H2 set correctly this
  becomes DEGRADED; without H1 it is a total loss. Owner must set the return minimum and the loss policy.

---

## Part C — Master plan (order = dependency)

### Phase 0 — Decisions (owner, before any code)
1. Final fee policy (M1). 2. Return minimum and loss rule (H2/M6). 3. Sweep rule for escrow residue (H1: back
into the pot). 4. Confirm Relay deposit mechanics with Relay (K1). 5. Programmable lane: wait for chain 4663 or
custom-hook lane without the 10-bps claim (H6).

### Phase 1 — Contracts (once, pre-deploy; immutable afterwards)
1. `PegCycleVault.sweepTerminalEscrow` + escrow `sendSweep(hook)` (H1) + tests.
2. Adapt `PegCycleRouteExecutor` to the Relay mechanics (K1): requestId on-chain, depository call if needed.
3. Forge green on the CI toolchain 1.7.1; enable or mark the `--ffi` test in CI (M4).
Acceptance: `forge test` 246/246, Slither findings triaged.

### Phase 2 — Runner: close the money path
1. Two-phase funding with `openPegCycle` (K2).
2. Route data as `abi.encode(RouteParams)` from the Relay quote, quoted just in time (K1).
3. Minima/gas caps mandatory from config (H2). 4. Escrow read at `finalized` (H3). 5. Idempotency for
`open`/`purchase` (H4). 6. Ledger field `operationsTrigger` (M2). 7. Dust carry-forward (H1).
8. `commit` stage (`commitPayoutChunk`) + wire the settlement worker (K3).
9. CLI: `claim-treasury`, `claim-programmable` runbook, `cancel-expired-funding`, `renew-*`,
`record-terminal-failure`, `sweep-escrow` (K4/H5).
Acceptance: Node tests green incl. new stage tests (happy, crash-resume, revert).

### Phase 3 — Local end-to-end simulation (Anvil fork, Relay/Collector mocked)
Swap → fee 0.1/0.4/2.5 booked → `openPegCycle` → `executeOutbound` → (mock return into escrow) →
`authorizePayout` (2 signatures) → `fundPayoutFromPegCycle` → `commitPayoutChunk` → all `payEntitlement` →
`claimTreasury`/`claimProgrammable`. Check: hook liabilities = 0 (except pot remainder), escrow = 0 after
sweep, sum of holder payouts = rootSum.

### Phase 4 — Testnet / minimal amounts
1. Relay Robinhood→Solana and Solana→escrow once each with a minimal amount (H3).
2. Collector purchase/open/buyback with one pack, return, payout to ≥2 holders.
3. Exercise recovery: cancel an expired authorization, one DEGRADED case + sweep.

### Phase 5 — Production
1. Provision five signers + addresses + keys; rehearsal variables removed (H6).
2. Deploy (hook, vault, route executor, bindings) → pin PoolKey → Robinhood bindings validation.
3. Programmable launch only after explicit owner approval (`pack → validate --remote → submit → status`).
4. Cleanroom 24 → 0, `status --check` green (re-record phase receipts), module cards updated (M4).
5. First cycle with a small pot, manual approval of every stage; automation afterwards.

### Definition of done
- [ ] Owner decisions 1–5 recorded under `decisions/`.
- [ ] Forge 246/246 (CI toolchain), Node all green, cleanroom 0, status green.
- [ ] Anvil E2E script runs through; all liabilities/escrows settle exactly.
- [ ] Testnet Relay round trip in both directions with receipts.
- [ ] Recovery paths executed once (cancel, renew, degraded + sweep).
- [ ] No mutation without an idempotency guard; no `'1'` defaults for minima.
