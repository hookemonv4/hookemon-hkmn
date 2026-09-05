# Hookemon (HKMN) Repository — Audit Findings Report

**Repository:** hookemon, worktree `dynamic-workflow-token-097109`, commit `5b365c8` (= main)
**Scope:** approved manual one-cycle Phase 1 of an intended fully autonomous 20-minute Collector Crypt pack cycle (buy, open, buyback, return, pro-rata payout to HKMN holders), launched on Robinhood Chain 4663 through the Programmable launchpad. The Hookemon hook is designed to be **immutable once deployed** and is **not yet deployed**, so contract changes remain possible today.
**Method:** every finding below was produced by at least one code-reading pass and cross-checked by two independent skeptic verifier passes per source lens (code-truth and impact-and-repro). Only the two rows explicitly marked REFUTED or DISPUTED below did not receive a unanimous CONFIRMED verdict from all verifier passes.

---

## 1. Counts

| Severity | Merged findings (this report) | Source rows (both skeptic lenses) |
|---|---|---|
| Critical | 7 | 15 |
| High | 28 | 59 |
| Medium | 32 | 53 |
| Low | 51 | 81 |
| Info | 32 | 63 |
| Refuted | 1 | 1 |
| **Total source rows reconciled** | | **272** |

Of the 272 source rows produced by the two skeptic passes across correctness / security / spec-conformance / test-coverage-gaps / autonomy-readiness lenses over 8 units, **270 were confirmed**, **1 was disputed** (one verifier pass called it a documented, intentional decision; the other called the documentation insufficient — both agree on the underlying facts), and **1 was refuted** (no evidence of the alleged conflicting owner transcript exists anywhere in the repository). This report merges duplicate/overlapping source rows that describe the same underlying defect (same file, nearby lines, same mechanism) into **118 distinct engineering findings** (7 critical, 28 high, 32 medium, 51 low) plus **32 info observations** and **1 refuted claim**.

---

## 2.1 Critical (7)

### HK-001: Expired pending funding authorization can never be cleared, bricking the vault before any funds move

**Location:** `packages/contracts/src/process/PegCycleVault.sol:145`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#3, contracts-process--security#0, contracts-process--spec-conformance#0

authorizeFunding refuses a new authorization while pendingAuthorization.cycleId != 0 (line 145). The only statement that deletes pendingAuthorization is inside consumeFundingAuthorization, which is itself only reachable while the pending authorization is unexpired (line 167). If the off-chain operations trigger misses expiresAt, the slot is occupied forever: both authorizeFunding and consumeFundingAuthorization revert AuthorizationUnavailable for the lifetime of the vault, and no funds have even moved yet.

**Impact:** No money is at risk, but the immutable hook can never open a peg cycle again: _debitProcessLiability is only reachable through ProcessBudget.openPegCycle, so 2.50% of every future swap accrues in the hook permanently with no release path. One missed deadline before the first cycle even starts is enough.

**Smallest repair:** In authorizeFunding, treat an expired pending authorization as replaceable: if (pendingAuthorization.cycleId != 0 && pendingAuthorization.expiresAt > block.timestamp) revert AuthorizationUnavailable(); delete pendingAuthorization; then proceed. Add a test that authorizes, warps past expiry, and re-authorizes with a fresh nonce/cycleId.

**Verifier reasoning:** Verifiers confirmed by reading PegCycleVault.sol that no function clears an expired pendingAuthorization and that the existing test (test_acceptedAuthorizationThatExpiresBeforeConsumptionLeavesEverythingUnchanged) asserts exactly this stuck state rather than a recovery.

---

### HK-002: FUNDED with expired funding authorization locks the released principal forever

**Location:** `packages/contracts/src/process/PegCycleVault.sol:207`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#2, contracts-process--security#1, contracts-process--spec-conformance#2

executeOutbound is the only function that accepts lifecycle FUNDED, and it re-checks the funding authorization's expiresAt even though the deadline was already enforced at consumption and the USDG has already left the hook (process liability debited, vault credited). If the bound operations trigger does not call executeOutbound before expiresAt, the vault holds the released amount with no transition available: recordTerminalFailure needs OUTBOUND, authorizePayout needs OUTBOUND, authorizeFunding needs EMPTY/PAYOUT_COMMITTED.

**Impact:** The released process budget (the whole cycle principal) becomes unrecoverable and the vault/hook pair is permanently bricked. A mid-cycle operations-key rotation or any operator outage past the deadline triggers this; test_fundingThatExpiresBeforeOutboundCannotExecute confirms the revert but asserts nothing about recovery.

**Smallest repair:** Either drop the redundant expiry re-check in executeOutbound (the deadline is already enforced at consumeFundingAuthorization and the route is digest-bound), or add a hook-initiated cancelFunding(cycleId) that returns the exact amount to the hook, re-credits process liability, and returns lifecycle to PAYOUT_COMMITTED/EMPTY.

**Verifier reasoning:** Verifiers traced executeOutbound, recordTerminalFailure, authorizePayout and authorizeFunding's state guards and confirmed no function accepts FUNDED except executeOutbound, so an expired authorization is a genuine permanent lock, not merely a revert-and-retry.

---

### HK-003: RETURNED state has no exit: a 1-unit dust donation or an expired payout authorization both permanently lock the cycle's returned proceeds

**Location:** `packages/contracts/src/process/PegCycleVault.sol:283`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#0, contracts-process--correctness#1, contracts-process--security#2, contracts-process--spec-conformance#1, contracts-payout--correctness#0, contracts-payout--security#0

authorizePayout moves the vault to RETURNED and pins payoutAuthorizationDigest to a struct whose rootSum must equal the exact vault balance observed at that moment (line 251). consumePayoutAuthorization (the sole consumer of RETURNED, called later by the hook via PayoutCommitment.fundPayoutFromPegCycle) re-checks balanceOf(vault) == rootSum exactly (line 283) and also rejects an authorization whose expiresAt has passed (line 279). Because authorizePayout and recordTerminalFailure both require OUTBOUND (which the vault has already left) and authorizeFunding requires EMPTY/PAYOUT_COMMITTED, there is no function anywhere that accepts RETURNED once either condition breaks. Two independent, unprivileged triggers reach the identical dead end: (a) any third party sends 1 base unit of USDG to the vault between authorizePayout and consumePayoutAuthorization (an ordinary ERC-20 transfer the vault cannot block), or (b) the off-chain keeper simply misses the expiresAt deadline (RPC outage, gas spike, operator downtime).

**Impact:** The complete returned USDG of the cycle -- the actual holder-payout proceeds, not merely an accounting liability -- is frozen forever at negligible attacker cost (or zero cost, for the expiry trigger). Because ProcessBudget.pegCycleVault is immutable and PegCycleVault.bindHook is one-time, the vault can also never open another cycle afterward, so a single dust transfer or a single missed deadline ends the product for the pool's lifetime.

**Smallest repair:** In consumePayoutAuthorization require balanceOf(vault) >= rootSum and transfer exactly rootSum (drop the exact-equality and the post-transfer balance==0 checks; surplus stays in the vault for the next cycle's authorizePayout to absorb). Separately, allow the authorizer to replace an unconsumed, expired payout authorization while lifecycle == RETURNED (new nonce, same cycleId, re-pinned rootSum) so a missed deadline is recoverable. Add tests for both: donation-after-authorizePayout, and expiry-then-reauthorize.

**Verifier reasoning:** Both the dust-donation and the expiry triggers were independently traced through PegCycleVault.sol's state guards by multiple lenses and confirmed to leave RETURNED as a true absorbing state with the existing test suite (test_unrelatedVaultBalanceContaminationAndEarlyCommitmentAreRejected, test_payoutConsumptionIsHookOnlyAndExpiresWithoutMutation) only covering the revert, never a recovery.

---

### HK-004: PegCycleVault's own expiry and terminal-failure tests certify the dead-ends above as "unchanged" instead of exercising a recovery, and the terminal-failure test hides its griefing dead-end behind a mock-only burn

**Location:** `packages/contracts/test/process/PegCycleVault.t.sol:133`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#0, contracts-tests-b--test-coverage-gaps#1

Three tests exercise authorization expiry (pending funding: lines 133-149; FUNDED before outbound: 151-166; RETURNED before consumption: 440-457) and each asserts only that the rejected call 'leaves everything unchanged' -- none asserts the vault can be driven forward afterward, and per src it cannot (HK-001/HK-002/HK-003). Separately, test_terminalFailureIsAuthorizerOnlyValueFreeAndAbsorbing (line 490) mints 1 unit into an OUTBOUND vault, asserts recordTerminalFailure is correctly rejected, then calls usdg.burn(address(vault), 1) to make progress -- but real USDG (the Paxos-issued UUPS proxy) has no permissionless burn-from-vault, so on-chain the same 1-unit dust permanently blocks recordTerminalFailure with no way forward, a fact the test's mock capability papers over.

**Impact:** For the owner's fully autonomous every-N-minutes loop, this is a hard blocker that the test suite actively obscures: any authorization the off-chain service fails to consume before expiresAt bricks the immutable vault and hook permanently, and a griefer with dust USDG can freeze the whole peg-cycle machine after a failed outbound, yet the gated tests read as green and reassuring.

**Smallest repair:** Add tests that, after each expiry, assert a fresh authorizeFunding/executeOutbound/consume path succeeds (they will fail until HK-001/002/003 are fixed); replace the terminal-failure test's usdg.burn with a recovery path that exists in production (e.g. a sweep to the hook), and add an explicit griefing test that a stranger's 1-unit transfer cannot block the authorizer.

**Verifier reasoning:** Verifiers read all four cited tests line-by-line and confirmed each one asserts rejection-without-recovery or relies on a burn capability (Mock-only) absent from the real USDG proxy, so the suite is not merely incomplete but affirmatively certifies broken behavior as acceptable.

---

### HK-005: No HKMN token creation or Launchpad issuance path exists anywhere in the repository

**Location:** `packages/contracts/src/launch/HookemonIssuance.sol:4`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--spec-conformance#0, contracts-launch--security#1

REQ-token-core-1 and ADR-0002 require HKMN to be created once through the officially bound Programmable Launchpad mechanism with a 90/10 allocation, and REQ-token-core-4 requires the release manifest to record the Launchpad ABI/version/runtime hash. A repository-wide grep for liquidity-launcher, uerc20-factory, UERC20 or LiquidityLauncher across packages/contracts/src, script and test returns zero Solidity references; the two vendored submodules are pinned in .gitmodules and remapped but never imported. HookemonIssuance only cross-checks caller-attested calldata and explicitly states it never calls a provider, deploys a token, or transfers value. bindings/robinhood-chain.json lists the token address/runtime and the Programmable admission/beneficiary binding as open blockers -- this is the documented INTEGRATION_PENDING state, but it means the system has no path from fixed-supply issuance to a deployed token at all.

**Impact:** The system cannot launch from this commit: no HKMN exists, no PoolKey can be formed, HookemonHook's constructor (which requires config.hkmn) cannot be deployed for production, and every downstream requirement -- fees, cycles, payouts -- is unreachable.

**Smallest repair:** Under a fresh owner-approved spec revision, add a launch adapter that binds the official Robinhood path (UERC20Factory.createToken with the approved name/symbol/decimals/totalSupply, plus LiquidityLauncher distribution placing 90% into the canonical pool position custodied by PermanentPositionCustody and 10% into an evidence-bound lock), record its ABI/runtime hashes in bindings/robinhood-chain.json, and re-enable the disabled FixedSupplyBinding test against that path.

**Verifier reasoning:** Verifiers grepped the full contracts tree for every Launchpad/UERC20Factory symbol and found no Solidity caller anywhere outside the vendored, unused submodules, confirming the gap is total rather than partial.

---

### HK-006: Collector Crypt / provider receipt verification is fixture-only end to end; every production entry point throws INTEGRATION_PENDING

**Location:** `packages/runner/src/cycle/schemas.mjs:284`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--autonomy-readiness#0, runner-cycle-b--autonomy-readiness#0, runner-cycle-a--correctness#4, runner-cycle-a--security#3, runner-cycle-b--security#0

Every provider receipt the reducer accepts must carry provider === 'fixture-provider' and an Ed25519 signature made with one hardcoded test key committed at packages/runner/test/cycle/fixture-crypto.mjs. The only production entry points -- CycleRunner.verifyProductionProviderReceipt, and the sibling stubs in collector.mjs (Collector generate/open/status/custody verification, with prizeWallet pinned to the literal 'fixture-destination-purchase') and decoder.mjs (Solana transaction decode/verify) -- unconditionally throw INTEGRATION_PENDING. CycleRunner.generateCollectorPack additionally fabricates the 'provider response' locally rather than calling an API, so even the Collector generate reconciliation is self-attested. No HTTP client, auth, or response-shape validation for the real Collector Crypt API exists on main.

**Impact:** Nothing in the runner can verify a real Collector Crypt purchase, open, buyback, or Solana transaction, so no cycle can ever be journaled as verified in production; the owner's end-to-end autonomous loop has no execution path today, only a fixture simulation of one.

**Smallest repair:** Introduce a provider adapter interface (verifyReceipt, verifyCollectorStatus, verifyOpenCustody, verifyRpcFinality) selected by configuration, with a production implementation that calls the real Collector Crypt API and independent Solana/EVM RPCs; keep the fixture implementation for tests only and retire the throwing stubs once the adapter exists.

**Verifier reasoning:** Verifiers traced every INTEGRATION_PENDING throw site in schemas.mjs, collector.mjs and decoder.mjs and confirmed there is no alternate, non-fixture code path anywhere in packages/runner/src that can authenticate a real receipt.

---

### HK-007: Transaction decoder only understands a fixture hex-JSON envelope, not real Solana or EVM wire transactions

**Location:** `packages/runner/src/cycle/decoder.mjs:152`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-b--autonomy-readiness#1

decodeFixtureOnlyMessage/verifyFixtureSignedTransaction round-trip a JSON envelope ('hookemon.fixture-message.v1') and verify Ed25519 over the hex JSON bytes with a single hardcoded fee-payer key. There is no Solana legacy/v0 message parser, no instruction/program-id allowlist against real program ids, and no EVM calldata decoder for the USDG release/return legs; verifyProductionTransaction throws.

**Impact:** No real transaction can be decoded, allowlisted, signed, or broadcast by the runner; the sign/broadcast authorization gates are exercised only against fixture bytes. This blocks both launch and every autonomous cycle, independent of the Collector integration gap in HK-006.

**Smallest repair:** Implement a production decoder that parses Solana MessageV0/legacy bytes, enforces program-id and account allowlists derived from the binding manifest, and verifies signatures against configured signer pubkeys (multi-signer); add a separate EVM decoder for the Robinhood legs. Keep the fixture codec test-only.

**Verifier reasoning:** Verifiers confirmed decoder.mjs contains no wire-format parser beyond the fixture JSON envelope and that verifyProductionTransaction is an unconditional throw, matching the claim exactly.

---

## 2.2 High (28)

### HK-008: Per-swap independent flooring with no 1,000-unit minimum violates the mandatory Programmable fee policy v1.1.0

**Location:** `packages/contracts/src/accounting/FeeAccounting.sol:157`
**Theme:** Programmable fee-policy conformance
**Sources:** contracts-kernel--correctness#0, contracts-kernel--spec-conformance#0, contracts-kernel--security#3, contracts-tests-a--test-coverage-gaps#0

_splitLiability floors the 10 bps Programmable share, the 40 bps treasury share and the 300 bps total independently on every swap and assigns every remainder to process; CanonicalMarket only rejects amountSpecified == 0, never a small volume. The mandatory policy (programmable-volume-fee-v1 v1.1.0) requires independent cumulative platform/project remainders for the lifetime of the canonical pool and an atomic revert for any positive gross quote amount below 1,000 smallest units, explicitly to close the split-swap bypass. The repository records the per-swap floor as owner-approved (ADR-0016, revision 55) and its own tests (test_revision55RoundingAssignsEveryRemainderToProcess, and the release-gated FeeAccounting.t.sol suite itself, HK-057) lock in exactly the forbidden arithmetic, so this is an approved-spec-versus-mandatory-policy conflict, not an accidental bug.

**Impact:** Any swap with executedUsdg < 1000 accrues zero Programmable liability while treasury/process still collect; 1,000 swaps of 1,999 units each would credit Programmable ~1,000 units instead of the ~1,999 the policy entitles (about 50% under-accrual under fragmentation), and this is a hard non-conformance that would return changes-required on Programmable launch review of an immutable, unpatchable hook.

**Smallest repair:** Obtain an explicit owner/Programmable-maintainer waiver recorded in product/OWNER_DECISIONS.md, or: (a) revert when |amountSpecified|/executedUsdg < 1000 in the accounting seam, and (b) replace _splitLiability with persistent numerator remainders (programmableNumerator += executedUsdg*10; fee = numerator/10_000; numerator %= 10_000, same for treasury) that claims never reset.

**Verifier reasoning:** Verifiers confirmed the exact per-swap floor formula against FeeAccounting.sol and cross-checked it word-for-word against the mandatory policy document's minimumGrossQuoteUnits and cumulative-remainder requirements, finding no owner waiver recorded anywhere outside lib/.

---

### HK-009: Any nonzero v4 protocol fee permanently bricks every swap on the canonical pool

**Location:** `packages/contracts/src/market/CanonicalMarket.sol:240`
**Theme:** Single-router binding & swap execution
**Sources:** contracts-kernel--security#0, contracts-kernel--correctness#2

_matches() is evaluated on every beforeSwap/afterSwap and requires the pool's live protocolFee to be exactly 0. The v4 protocol fee is set unilaterally by the PoolManager's protocolFeeController (Uniswap governance / the Robinhood Chain operator) at any time after launch, independent of the project. The hook is immutable with no upgrade path, and the LP NFT is locked in PermanentPositionCustody with no liquidity-decrease authority, so once a protocol fee is switched on the canonical USDG/HKMN market is dead forever. A protocol fee does not change the hook's own quote-side basis or full-fill check -- it is deducted inside Pool.swap before the hook sees the delta -- so the check buys no accounting safety; the Programmable reference profile explicitly tolerates protocol fees.

**Impact:** A single governance/operator action entirely outside the project's control permanently halts trading and strands the seeded liquidity and every holder's HKMN exit -- a hard autonomy blocker with no recovery.

**Smallest repair:** Drop the protocolFee == 0 term from _matches() (keep k.fee == 0 and liveLpFee == 0), add a test that swaps succeed with a nonzero protocol fee, and document that protocol fees do not alter the hook's basis. If the owner insists on rejecting protocol fees, obtain a written commitment from the Robinhood Chain PoolManager owner before deployment.

**Verifier reasoning:** Verifiers confirmed _matches()'s protocolFee==0 requirement is unconditional and that no code path in CanonicalMarket adjusts for a nonzero protocol fee, so the described kill switch is real given the hook's immutability.

---

### HK-010: Immutable single-router binding plus a mandatory 128-byte bespoke hookData makes every standard swap path revert

**Location:** `packages/contracts/src/market/CanonicalMarket.sol:157`
**Theme:** Single-router binding & swap execution
**Sources:** contracts-kernel--spec-conformance#1

_beforeSwap requires hookData to be exactly 128 bytes with the HOOKEMON_CANONICAL_SWAP_R54_A3_V1 domain, a nonzero operationId, sender == callback sender == the immutable swapRouter, and a nonzero recipient; _afterSwap repeats the decode. Any swap sent with empty hookData (the standard Uniswap interface, the Programmable app, aggregators, or the UniversalRouter default) or from any router other than the one address frozen in the constructor reverts. The fee accounting itself does not need any of these fields -- the fee is computed purely from amountSpecified/BalanceDelta, and the recipient only feeds an observational mapping -- and the Robinhood router binding is still marked INTEGRATION_PENDING, so the router address the immutable hook will pin is not yet known.

**Impact:** If deployed as-is, no community member can buy or sell HKMN through any standard interface -- only a bespoke client that crafts the exact payload can trade -- and if the Programmable Robinhood launchpad ships a different router, the immutable hook is permanently untradeable via official surfaces, blocking the owner's holder-acquisition and autonomy goals.

**Smallest repair:** Accept empty hookData for fee purposes (treat recipient/operationId as optional observation fields, keep the router-sender binding only for the operator client's own swaps) and drop the constructor-time router pin or replace it with a PoolManager-only check, since the fee is already enforced entirely in-hook.

**Verifier reasoning:** Verifiers traced the exact 128-byte/domain/router equality checks in _beforeSwap and _afterSwap and confirmed no fallback path exists for empty or router-agnostic hookData, matching production UniversalRouter and aggregator behavior which never emits this bespoke payload.

---

### HK-011: Partial return below minimumReturnUsdg has no valid transition; funds stay stuck in OUTBOUND

**Location:** `packages/contracts/src/process/PegCycleVault.sol:306`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#4, contracts-process--security#4, contracts-process--spec-conformance#3

From OUTBOUND the only two exits are authorizePayout, which requires rootSum >= active.minimumReturnUsdg AND balance == rootSum, and recordTerminalFailure, which requires balance == 0 exactly. A degraded return (0 < balance < minimumReturnUsdg) -- a realistic outcome for a gacha pack whose card buys back below the pack price -- satisfies neither predicate, and by design the vault has no sweep or approval path.

**Impact:** Any cycle that returns less than the frozen minimum leaves the vault permanently in OUTBOUND with the partial proceeds unrecoverable and no further cycles possible; it also gives any third party a 1-unit-dust veto over recordTerminalFailure by nudging the balance off exactly zero.

**Smallest repair:** Let recordTerminalFailure accept a nonzero balance and sweep it exactly to the hook as a (possibly below-minimum) payout, or allow authorizePayout with rootSum < minimumReturnUsdg when explicitly flagged as a degraded return. Cover with a test that returns minimumReturnUsdg - 1.

**Verifier reasoning:** Verifiers confirmed via PegCycleVault.t.sol's own test_returnMustMeetMinimumEvenWhenVaultBalanceMatchesRootSum that the rejection is asserted but the resulting dead end is never exercised or resolved.

---

### HK-012: FAILED is an absorbing state for an immutable 1:1 vault, so one terminal failure locks all future process fees in the hook

**Location:** `packages/contracts/src/process/PegCycleVault.sol:309`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#5, contracts-process--security#3, contracts-process--spec-conformance#4, contracts-payout--correctness#1

recordTerminalFailure sets lifecycle = FAILED and no function accepts FAILED. ProcessBudget.pegCycleVault is immutable and PegCycleVault.bindHook is one-time, so a failed cycle permanently ends process-budget release for the hook while _accrueAuthenticatedSwap keeps crediting processLiabilityAmount on every subsequent swap. This is spec-intentional for the approved Phase 1 scope (PRD: 'one sequential process cycle'), but it is a hard blocker for the owner's stated perpetual autonomous target and for a dashboard 'restart/kick stuck cycle' control.

**Impact:** After the first real failure, 2.50% of all subsequent swap volume is stranded in the hook forever; the only remedy under the current design is a brand-new hook and a brand-new pool.

**Smallest repair:** For Phase 1, document plainly that FAILED ends the hook's process budget permanently and that the process share should be treated as at-risk. For the autonomous target, either allow FAILED -> EMPTY via an authorizer call once the failure receipt is recorded and balance is zero, or adopt the per-cycle vault design already sketched on codex/phase2-revision-57.

**Verifier reasoning:** Verifiers confirmed no function anywhere reads FAILED as an accepted precondition and that ProcessBudget's vault binding is genuinely immutable, so the absorbing state is real and matches the requirements-revision-56 proposal's own description of it.

---

### HK-013: No route-executor implementation exists; the vault and hook are immutably bound to an executor that must be deployed first

**Location:** `packages/contracts/src/process/PegCycleVault.sol:92`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#6, contracts-process--security#5

The vault constructor requires routeExecutor_ to already have code and stores it immutably; executeOutbound transfers the cycle principal to it and requires it to consume exactly `amount` in the same transaction. IPegCycleRouteExecutor has no production implementation anywhere under packages/contracts/src (only test mocks). Because pegCycleVault is immutable on ProcessBudget and the hook address must be CREATE2-mined for its permission bits, the executor address must be final before the hook is deployed and can never change afterward without redeploying vault, hook and pool.

**Impact:** The on-chain cycle cannot execute on Robinhood Chain until a production bridge/executor contract (Collector Crypt purchase route, or equivalent) that satisfies the exact-delta and zero-allowance checks exists; the owner's end-to-end autonomous loop has no on-chain outbound leg today, and launch is blocked on the least-certain, provider-dependent component while making it unchangeable for the pool's life.

**Smallest repair:** Before any deployment, implement and audit a concrete IPegCycleRouteExecutor adapter for the chosen bridge/purchase route, pin its address in bindings/robinhood-chain.json, and add a fork test proving executeOutbound's balance-delta and allowance checks hold against it.

**Verifier reasoning:** Verifiers grepped packages/contracts/src for any non-test IPegCycleRouteExecutor implementation and found none, confirming the deployment-ordering dependency is unresolved.

---

### HK-014: Hard cap of 1,024 recipients per cycle with no chunking mechanism

**Location:** `packages/contracts/src/payout/CanonicalMerkleSum.sol:6`
**Theme:** Holder payout & distribution pipeline
**Sources:** contracts-payout--correctness#2, contracts-payout--security#1

CanonicalMerkleSum's tree is fixed at width 1,024 and every payout funds exactly one root; PegCycleVault.authorizePayout requires the vault balance to equal rootSum exactly and consumePayoutAuthorization transfers the entire balance in one shot, so a cycle's proceeds map to exactly one payoutId and therefore at most 1,024 leaves. Nothing in the contracts or tooling splits a larger holder set into several payoutIds, and zero-amount entries are rejected outright, so rounding-dust holders must be dropped or merged off-chain by unspecified logic.

**Impact:** Once HKMN has more than 1,024 direct holders (foreseeable for a community token, and cheaply forceable by an attacker via dust transfers), 'distributed pro rata to HKMN holders' cannot be honored for the tail -- the offchain builder must silently exclude holders, contradicting the owner's stated distribution promise.

**Smallest repair:** Decide and specify a chunking rule explicitly (multiple payoutIds per cycle, each with its own rootSum summing to the vault balance) or an accumulate-then-distribute rule, and add the rounding-remainder rule to the manifest spec; alternatively raise TREE_DEPTH if gas permits.

**Verifier reasoning:** Verifiers confirmed TREE_WIDTH=1024 is a hard-coded ceiling with no multi-payoutId chunking anywhere in the payout contracts, matching the PRD's own explicit acceptance of the cap without a stated eligibility rule.

---

### HK-015: Manifest recipients/amounts are unverifiable on-chain; the vault authorizer key controls the entire distribution

**Location:** `packages/contracts/src/payout/PayoutCommitment.sol:8`
**Theme:** Holder payout & distribution pipeline
**Sources:** contracts-payout--security#2

The hook only checks that the USDG balance delta equals rootSum; it never learns which addresses the root actually pays. PegCycleVault.authorizePayout only checks that payoutId, manifestDigest and rootHash are nonzero. So whoever holds the vault authorizer key (plus the off-chain manifest builder feeding it) decides the entire distribution of every cycle -- the sum-bound tree guarantees the payout cannot exceed the funded amount, not that holders actually receive it. Phase 1 mitigates this only through explicit owner approval of each manifest; under the owner's target of unattended 20-minute cycles that approval must become an automated hot key.

**Impact:** Full loss of a cycle's proceeds (and every subsequent cycle until detected) if the autonomous authorizer or manifest builder is compromised or buggy; holders have no on-chain recourse because a bad root is permanent for that payoutId.

**Smallest repair:** For Phase 2, keep the authorizer cold-approved, or add an on-chain constraint the hook itself can check (e.g. checkpointed HKMN balances via an ERC20Votes-style interface with amount == unpaidTotal * checkpointBalance / snapshotSupply), or at minimum require a second independent verifier signature plus a delay between authorizePayout and consumePayoutAuthorization so a monitoring process can veto a wrong manifest.

**Verifier reasoning:** Verifiers confirmed neither the hook nor the vault reads or checks recipient identities anywhere on-chain, so the authorizer key is genuinely the sole determinant of who gets paid.

---

### HK-016: Phase 1's "permissionless payment worker" has no implementation; settlement is pull-only, one leaf per transaction, and nothing drives it

**Location:** `packages/contracts/src/settlement/HolderSettlement.sol:26`
**Theme:** Holder payout & distribution pipeline
**Sources:** contracts-payout--spec-conformance#0, contracts-payout--correctness#4

REQ-phase-boundary-1 lists a permissionless payment worker as Phase 1 scope, and the PRD/module docs assume a worker that iterates the manifest and calls payEntitlement for every leaf. No such component exists: a grep for payEntitlement/isPaid/EntitlementPaid across packages/runner/src and scripts returns nothing; only test harnesses call the function. The contract itself is conformant (permissionless, per-leaf, at-most-once) -- payEntitlement pays exactly one (payoutId, index) and there is no batch entry point -- but with a 20-minute cycle and N holders, N external transactions each carrying up to 10 sibling hashes and sums must be submitted every cycle by some keeper that does not exist in this file set.

**Impact:** Without a driver, 'proceeds are distributed pro rata to HKMN holders automatically' has no executor; unpaid leaves stay funded-but-unpaid indefinitely with no operator remedy by design (up to ~74k transactions/day at 1,024 holders if run manually).

**Smallest repair:** Add a small off-chain worker under packages/runner (Phase 2 spec revision required) that reads the published manifest, rebuilds proofs with the canonical Merkle-sum tooling, skips already-paid leaves, and submits payEntitlement per leaf with retry; specify who pays gas and the retry policy.

**Verifier reasoning:** Verifiers confirmed by repository-wide grep that no production caller of payEntitlement exists outside test harnesses, and that the contract-level guarantees (idempotency, permissionlessness) are sound but unused without a driver.

---

### HK-017: CI and the release gate execute only the bindings and market test suites; process, payout, settlement, access, launch, blind and the real-PoolManager/adversarial suites never run on merge

**Location:** `.github/workflows/v4-gates.yml:168`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#1, contracts-tests-b--test-coverage-gaps#2

The single CI workflow runs forge test only against test/bindings/*.t.sol and test/market/*.t.sol. Every other executable suite -- test/process, test/payout, test/settlement, test/access, test/launch, test/blind/market-fees, test/blind/token-roles, plus HookemonHook.t.sol (the only suite that runs all four swap quadrants through a real PoolManager + PoolSwapTest against the concrete deployable hook), FeeAccounting.t.sol (the full adversarial rollback matrix) and FeeAccountingInvariant.t.sol -- is invoked only by hand via commands scattered across tasks/P1-*.md. scripts/verify-phase1-release.mjs likewise names only CanonicalMerkleSum/HolderSettlement, PhaseOneLocalLoop and PhaseOneReleaseInvariant.

**Impact:** A regression in HookemonHook._collectFee, the concrete claim authorization, the split constants, the vault's money-path invariants (exact-amount funding, funded==paid+unpaid, no recipient replacement, one-shot issuance guard), or the moneyPath rollback would merge green; the only gated swap coverage tests an abstract mixin, not the deployable contract.

**Smallest repair:** Add forge test --match-path for test/accounting, test/integration/HookemonHook.t.sol, test/process, test/payout, test/settlement, test/access, test/launch and the blind suites (plus node --test for the JS blind suites) to the v4-gates workflow, and register each as a required check with expected pass counts in scripts/verify-phase1-release.mjs.

**Verifier reasoning:** Verifiers read the CI workflow file directly and confirmed only two match-path globs are invoked, cross-checked against every test directory that exists in the repository but is absent from both CI and the release script.

---

### HK-019: The vault can be debited and a pack purchased before any Collector generate step occurs; the cycle is then permanently stuck with no return path

**Location:** `packages/runner/src/cycle/reducer.mjs:408`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--correctness#0

evidenceForTransition requires only the outbound receipt prefix for 'outbound-finalized' and only outbound+purchase for 'purchase-finalized'; it never requires the Collector generate intent/authorization/response to exist or be reconciled first. But collectorGenerateIntent and collectorGenerate both hard-require state.stage === 'prepared', so once outbound and purchase have already advanced the stage past 'prepared', the generate step is rejected forever and 'open-reconciled' becomes unreachable. There is no abort/refund event in the reducer, and the return action is only allowed at stage 'buyback-finalized', so the USDG already released from the vault can never be journaled back.

**Impact:** Released principal leaves the vault and is spent on a pack while the cycle can never close, never return proceeds, and never distribute; funds sit in the policy/prize wallets with no journaled recovery path, and in an unattended 20-minute loop this is a stuck cycle that locks the released budget.

**Smallest repair:** In evidenceForTransition, require for next === 'outbound-finalized' that state.collector.generateIntent, its authorization, and collector.generated all exist and are externally reconciled; equivalently, make verifyIntent for 'outbound' throw when state.collector.generated is null instead of silently guarding on it.

**Verifier reasoning:** Verifiers reproduced the ordering with a probe (recordReleasedCyclePreflight -> outbound -> purchase) and confirmed the sequence reaches 'purchase-finalized' while a subsequent authorizeCollector('generate') call throws 'prepared released-cycle preflight is required', matching the claim exactly.

---

### HK-020: No void/failure path for an external mutation that never broadcasts; a crash or a dropped/expired transaction strands the cycle forever

**Location:** `packages/runner/src/cycle/reducer.mjs:321`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--correctness#1, runner-cycle-a--security#2, runner-cycle-a--autonomy-readiness#4

externalMutationAttempted is journaled before decode/sign/broadcast (correct intent-before-mutation ordering), but the only exit from 'unresolved' is externalMutationReconciled, which requires positive success evidence (a verified, consumed provider receipt plus execution accounting). If the process crashes between journaling the attempt and broadcasting, or the blockhash window expires before broadcast, no receipt will ever exist; retry of the same request digest is prohibited, and any other mutation is blocked while one is unresolved. The reducer has no 'external-mutation-voided'/'abandoned' event, even though blockhash-validity evidence that could prove non-execution already exists in the schema but is never consumed for this purpose.

**Impact:** Any crash in the attempt-to-broadcast window, or a stale blockhash, leaves the cycle permanently unresolved: for outbound the released budget stays locked in the vault, for later actions funds sit in policy/refund accounts with no journaled way forward or back -- directly contradicting the owner's 'restart/kick stuck cycles' requirement.

**Smallest repair:** Add a negative-reconciliation event (e.g. 'external-mutation-voided') accepted only with independently verified evidence that the signed transaction cannot land (blockhash-validity evidence with observedHeight > lastValidHeight plus a signature-not-found RPC attestation bound to signedBytesDigest); once voided, allow a fresh intent/attempt with a new blockhash for the same actionKind.

**Verifier reasoning:** Verifiers confirmed reconcileUnresolvedIntent (cycle-runner.mjs) simply returns {status:'unresolved'} forever and that no reducer event exists to escape that state, matching the design across all three lenses that examined this file.

---

### HK-021: RECOVERY_LIMITS make the cycle store unreopenable after roughly five closed cycles

**Location:** `packages/runner/src/cycle/journal.mjs:7`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--correctness#2, runner-cycle-a--security#0, runner-cycle-a--autonomy-readiness#3, runner-cycle-b--autonomy-readiness#3

FixtureCycleStore's constructor rejects any snapshot with more than RECOVERY_LIMITS.storeAuthorizations (128) authorization records, but commit() never enforces this cap while appending -- so live commits keep succeeding past 128. A closed cycle consumes 23-24 single-use authorizations (20 per-action + 2 Collector + 1 post-open buyback, plus 1 more when payout funding is prepared) and 4 receipts; 128/24 rounds down to 5. storeReceipts=64 and storeCycles=16 are mutually consistent with 16 cycles at 4 receipts each, making the authorization cap the actual, much tighter, binding limit.

**Impact:** At the owner's target 20-minute cadence, the store becomes silently unrecoverable within about two hours of operation: the first process restart after the sixth cycle cannot reopen the snapshot, stranding whatever cycle was in flight and losing every cycle's nonce/receipt exactly-once registry with it.

**Smallest repair:** Raise storeAuthorizations to at least storeCycles * 24 (384), enforce the same cap inside commit() so a live store can never grow into an un-reopenable snapshot, and add a test that closes storeCycles cycles and successfully reopens the snapshot.

**Verifier reasoning:** Verifiers measured the real per-cycle authorization count via a probe (23-24 records) and confirmed 128/24 rounds to 5, and that the cap is checked only in the constructor/reopen path, never in commit(), across three independent lens reports.

---

### HK-022: The cycle store and journal are in-memory only with no durable persistence, no scheduler, and no cross-process lock

**Location:** `packages/runner/src/cycle/cycle-store.mjs:138`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--correctness#3, runner-cycle-a--autonomy-readiness#2, runner-cycle-b--autonomy-readiness#6, runner-cycle-a--security#5

FixtureCycleStore keeps cycles/authorizations/nonces/receipts in private Maps and exposes only a snapshot getter; nothing in packages/runner/src ever writes that snapshot to disk or reads one back, and no timer/loop/cron exists anywhere in the unit. Durability exists only if an external caller serializes the snapshot to stable storage before performing a side effect, and nothing enforces that ordering -- a caller that broadcasts and then crashes before persisting recovers with no record of the attempt and is free to retry, exactly the blind double-spend the journal is designed to prevent. The CAS (expectedVersion/expectedJournalHead) is also process-local, so two processes reopening the same snapshot would each commit divergent histories.

**Impact:** A crash mid-cycle loses the intent-before-mutation record and the cross-cycle nonce/receipt registries; on restart the system cannot tell whether a broadcast happened. The 20-minute recurring loop, interval changes, and 'restart stuck cycles' have no home in this code at all -- there is no scheduler to restart.

**Smallest repair:** Implement a durable store adapter (e.g. SQLite via node:sqlite, or an fsync'd append-only file) whose commit() resolves only after durable persistence, with the CAS enforced at the row/version level and a lease so only one process may commit for a cycle; add a separate scheduler service that drives CycleRunner on an interval with per-step timeouts and reconciliation-on-restart. Keep FixtureCycleStore for tests only.

**Verifier reasoning:** Verifiers grepped packages/runner/src for writeFile/node:sqlite/setInterval/setTimeout/cron and found none outside test helpers, confirming both the persistence and scheduling gaps are total, not partial.

---

### HK-023: Action policy hardcodes fixture accounts, pack id and amounts; no real pack selection or budget sizing exists

**Location:** `packages/runner/src/cycle/schemas.mjs:113`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--autonomy-readiness#1, runner-cycle-b--autonomy-readiness#5, runner-cycle-b--correctness#15

assertFixtureActionPolicy rejects any action whose principalAmount/minimumReceive/amount are not exactly '10' and nativeGasAmount not '1', whose policyAccount is not the literal 'fixture-solana-policy-account', and whose accounts are not the fixture placeholders. The reducer additionally hardcodes the NFT mint and the Collector generate response id, and collector.mjs forces pack === 'collector-crypt', quantity 1, turbo false everywhere. There is no parameter anywhere for which pack to buy, its live price, or a process-budget-derived spend amount.

**Impact:** The owner's dashboard requirement (choose which packs to buy, at what budget) is unrepresentable in this code, and any real action -- real Solana pubkeys, real Circle USD amounts, a real card mint -- fails validation at intent time by construction.

**Smallest repair:** Replace FIXTURE_ACTION_POLICY with a policy derived from the preflight/binding manifest: an allowed-pack catalog, amounts from the released process budget and a live pack quote with a slippage-derived minimumReceive, real account addresses from the binding manifest, and a card mint taken from verified open-custody evidence rather than a constant.

**Verifier reasoning:** Verifiers confirmed every hardcoded literal cited (amounts, accounts, pack id) by reading schemas.mjs, reducer.mjs, collector.mjs and bindings.mjs directly, finding no parameterized alternative anywhere in the module.

---

### HK-024: Activity-isolation invariants require exact-zero balances on publicly fundable accounts, so a dust transfer permanently blocks cycle closure

**Location:** `packages/runner/src/cycle/reducer.mjs:531`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--security#1

validateClosedLedger and verifyExecutionAccounting demand that the policy account, refund token account and cycle vault have exactly zero balance before each credit, that adjacent legs hand off with identical balances, and that each account's activity window contains exactly one movement. All of these are public addresses. Any third party (or a stray airdrop/refund) sending one base unit to the policy account, USDG to the cycle vault during the buyback-to-return window, or anything to the refund token account causes the honest accounting evidence to fail these equality checks, and there is no override or re-derivation event.

**Impact:** A griefing vector costing an attacker fractions of a cent: the returned USDG is physically present but the state machine cannot attribute or distribute it, and under the autonomous 20-minute schedule every subsequent cycle inherits the dust and fails the same way.

**Smallest repair:** Verify balance deltas (post - pre == amount, attributable by transactionSignature) rather than absolute-zero opening balances and single-movement windows, or guarantee per-cycle fresh escrow accounts, and add a journaled 'foreign-movement-acknowledged' event so an honest operator can close a dusted cycle without forging evidence.

**Verifier reasoning:** Verifiers confirmed the exact-zero and single-movement assertions in validateClosedLedger/verifyExecutionAccounting and that these accounts are ordinary public addresses reachable by any sender, mirroring the same dust-griefing pattern independently confirmed on-chain in HK-003.

---

### HK-025: Every cycle step needs a distinct, fresh owner-signed authorization (roughly 23-24 per cycle) with no automated signer, and expiry is checked against a frozen 2029 clock rather than real time

**Location:** `packages/runner/src/cycle/reducer.mjs:749`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--autonomy-readiness#5, runner-cycle-b--autonomy-readiness#2

Per action, five authorization kinds (mutation, sign, broadcast, asset-spend, gas-spend) must each be recorded and consumed with globally unique nonces; the Collector generate/open steps, a separate post-open buyback approval, and payout funding each add further owner-signed approvals. All are verified against a fixture owner key, and the runner never signs a transaction itself -- recordSignedBytes takes caller-supplied signed bytes and the execution wallet is a placeholder string, not a keypair. Expiry is only ever checked against the constant '2029-01-01T00:00:00.000Z' rather than a real clock.

**Impact:** Unattended operation is impossible as designed: roughly 24 fresh owner signatures per cycle at 72 cycles/day, and because expiry is a no-op against real time, a leaked or stale authorization would remain replayable indefinitely if a production signer were wired without replacing the frozen constant.

**Smallest repair:** Specify and get owner approval for a bounded automated authority: a policy-wallet/signer service holding a delegated key with per-cycle spend caps, a pack allow-list and an interval, producing per-step authorizations and Solana signatures under those caps, with the owner key reserved for changing the policy; inject a real, bounded-skew clock in place of the frozen constant.

**Verifier reasoning:** Verifiers measured ~23 authorization records per closed cycle via a fixture-cycle probe and confirmed every expiry check in reducer.mjs/authorization.mjs/collector.mjs resolves against the same hardcoded 2029 string rather than Date.now().

---

### HK-026: Single-chain model: every action is forced onto Solana; the USDG(Robinhood)-to-Circle USD(Solana) bridge legs are entirely unmodeled

**Location:** `packages/runner/src/cycle/reducer.mjs:573`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--autonomy-readiness#6, runner-cycle-b--autonomy-readiness#7, runner-cycle-b--security#6

The schema rejects any action whose chain is not 'solana'/'mainnet-beta', yet the outbound leg debits the Robinhood-chain USDG vault and the return leg credits it back; the whole cross-chain bridge is represented as one opaque 'fixture-program' instruction, and verifyReceipt enforces monotone finalized block heights across all four receipts as if they were all on one chain. The Robinhood native-gas cap the schema requires can also never actually be consumed, since no action in this model executes on the EVM side.

**Impact:** A real two-chain cycle can never satisfy the closed-ledger checks as written; the outbound and return legs -- the parts that actually touch holder funds and cross from Robinhood Chain to Solana and back -- have no verifiable production shape at all.

**Smallest repair:** Model each action with its own chain domain and per-chain finalized block height, split outbound/return into explicit bridge-out (EVM burn/lock receipt) and bridge-in (Solana mint/credit receipt) actions with their own evidence, and bind the vault activity window to EVM block hashes only.

**Verifier reasoning:** Verifiers confirmed schemas.mjs hardcodes chain 'solana' for every action while the vault address used in the same actions is an EVM 0x address, and that no bridge-specific action kind or evidence type exists anywhere in the schema.

---

### HK-027: Buyback accounting conflates NFT units with the Circle USD refund amount

**Location:** `packages/runner/src/cycle/reducer.mjs:275`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--autonomy-readiness#7

Three checks chain together so that Circle USD received == NFT units debited == action.amount: the post-open buyback approval's refundAmount must equal the buyback action's amount; the buyback receipt's relation.amountIn (units of the NFT mint) must equal that same action.amount; and the buyback's Circle USD amountOut plus the independent destination delta must equal refundAmount. This only holds in the fixture because every value happens to be '10' -- with a real buyback (1 NFT in, tens of millions of Circle USD atomic units out) the ledger can never close, and if the constants were relaxed naively the refund amount would be entirely unconstrained by the actual quote.

**Impact:** The buyback leg -- the step that actually converts the opened card back into cash -- has no representable real-world shape; a naive fix that just relaxes the hardcoded '10' would remove the only constraint tying the refund to the true sale price.

**Smallest repair:** Give the action separate inputAmount (NFT units, always '1' for a buyback) and expectedOutputAmount/minimumReceive (Circle USD) fields; bind refundAmount to the Circle USD expectation and relation.amountIn to inputAmount, and make the purchase relation carry NFT quantity and Circle USD amountIn separately.

**Verifier reasoning:** Verifiers traced the three chained equality checks across reducer.mjs and schemas.mjs and confirmed they collapse to a single tautology only because every fixture constant is '10', proving the design cannot represent an asymmetric real trade.

---

### HK-028: The runner refuses to load at all unless interfaces.json says productPhase 1 / revision 56 / architecture 4, and demands a fixture-signed release attestation every cycle

**Location:** `packages/runner/src/cycle/preflight.mjs:28`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-b--autonomy-readiness#4, runner-cycle-b--correctness#4

The frozen-interface assertion runs at module import time, and cycle-runner.mjs imports preflight.mjs, so the entire runner becomes unimportable the instant a Phase 2 revision bumps any of these fields. verifyFixtureCycleRelease additionally demands a per-cycle release attestation signed by a hardcoded 'hookemon-fixture-release-verifier' key with totalPrincipal === releasedAmount, so every autonomous cycle would need a freshly produced fixture-signed release; and preflight.mjs itself throws at import time whenever the interfaces.json revision it reads drifts from what it expects.

**Impact:** This is a hard, by-design blocker for the Phase 2 automation work the owner wants: the code fails closed until both the spec revision is rebound in the loaded binding manifest and a production release verifier (reading the actual hook/vault release event on Robinhood Chain) replaces the fixture signer.

**Smallest repair:** Move the revision pin into the binding manifest / policy loaded at runtime rather than a compile-time assertion, implement a production release verifier that reads finalized PegCycleVault release events via RPC, and let the scheduler derive releasedAmount from the on-chain process-budget balance each cycle.

**Verifier reasoning:** Verifiers confirmed the module-load-time assertion and the release-attestation key are exactly as described by reading preflight.mjs and cross-checking the import graph from cycle-runner.mjs.

---

### HK-029: Holder payout automation stops at digest computation; nothing signs, submits, or publishes anything on-chain

**Location:** `packages/runner/src/cycle/vault-payout-authorization.mjs:146`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-cycle-b--autonomy-readiness#8, runner-distribution--autonomy-readiness#6

vault-payout-authorization.mjs only ABI-encodes and keccak-hashes the payout authorization tuple (verified correct against standard test vectors). expiresAt is only range-checked as a uint64; there is no signer for the digest, no EVM transaction builder, no vault contract call, and no per-holder claim/push distribution logic anywhere in the runner or distribution pipeline. The pipeline's own terminal authority string is 'LOCAL_PREPARATION_ONLY_NOT_LIVE_FUNDING_AUTHORITY', and no module publishes the manifest/proofs where holders could fetch them or calls fundPayoutFromPegCycle / payEntitlement for real.

**Impact:** 'Proceeds are distributed pro rata to HKMN holders automatically' has no executor anywhere in the codebase: even after a perfect manifest and a perfect verification receipt, holders receive nothing unless someone manually calls payEntitlement per index with the right proof.

**Smallest repair:** Add a payout executor module: sign the digest with the configured authorizer key, build and broadcast the fundPayout transaction via the Robinhood RPC, verify the emitted event and record it as a receipt, then push-pay all entries via payEntitlement (batched, idempotent via isPaid), journaling each transaction hash and publishing the manifest to at least two independent locations as the docs require.

**Verifier reasoning:** Verifiers confirmed by grep that no module in packages/runner signs, broadcasts, or calls the on-chain payout functions, and that the only real chain interaction anywhere is a test-only Foundry FFI adapter.

---

### HK-030: Balance-delta accounting and blockhash liveness are attested only by hardcoded fixture oracle keys; no RPC or indexer client exists

**Location:** `packages/runner/src/cycle/execution-accounting.mjs:6`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-b--autonomy-readiness#9

verifyFixtureExecutionAccounting trusts an Ed25519 signature from a single hardcoded 'hookemon-fixture-accounting-verifier' key, and blockhash-validity.mjs trusts a separate hardcoded 'hookemon-fixture-rpc-verifier' key while validating recentBlockhash as lowercase hex even though real Solana blockhashes are base58. The module never independently checks openingBalance +/- movements == closingBalance itself -- that reconciliation is delegated entirely to the reducer -- and no code anywhere queries getSignatureStatuses, getBlockHeight, token balances, or transaction fees from a real RPC to produce these attestations.

**Impact:** Post-execution accounting for real transactions can never be produced, so receipts can never be consumed and cycles can never close outside of tests; there is no path from a real Solana transaction to a verified accounting record.

**Smallest repair:** Implement an RPC-backed accounting producer using getTransaction's meta.preBalances/postBalances, token balances and meta.fee, and a blockhash-validity producer using getLatestBlockhash/isBlockhashValid; sign attestations with a configured oracle key (or verify unsigned RPC data directly), and add the opening+movements==closing check inside verifyAccountActivity itself.

**Verifier reasoning:** Verifiers confirmed the hardcoded key names and the base58-vs-hex blockhash mismatch by reading execution-accounting.mjs and blockhash-validity.mjs directly, and confirmed no RPC client exists anywhere in packages/runner/src.

---

### HK-031: Distribution manifest proof domain (chainId, hook) is taken from the caller-supplied approval and never bound to the runner's actual chain/hook, so a funded payout can become permanently unclaimable

**Location:** `packages/runner/src/distribution/manifest.mjs:227`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--correctness#0, runner-distribution--security#1, runner-distribution--autonomy-readiness#0

compileApprovedDistribution builds the Merkle-sum leaf domain entirely from approval.chainId and approval.hook. verifyApproval only checks approval.chainId === candidate.snapshot.chainId -- itself an unauthenticated, caller-supplied value -- and that hook is any nonzero address. The verification receipt carries neither chainId nor hook, so reducer.recordDistributionVerification cannot check them, and deriveVaultPayoutAuthorization fills chainId/hook from the preflight while copying manifestDigest/rootHash from the receipt, silently pairing two different domains. On-chain, HolderSettlement._verifyEntitlementProof recomputes every leaf using block.chainid and address(this), so if the manifest was built under a different chainId or hook, every payEntitlement reverts InvalidEntitlementProof with no rescue path. The repository's own manifest.test.mjs already exercises exactly this mismatch (chainId '466' in the manifest vs '4663' in the vault payout authorization) and passes; a probe confirmed the divergence end to end on the real code.

**Impact:** If this artifact pipeline is ever wired to on-chain submission, the vault pays rootSum USDG into the hook as an unprovable payout liability, and since no reclaim/sweep path exists in PayoutCommitment or HolderSettlement, the cycle's entire holder proceeds are locked permanently -- a misconfigured snapshot chainId or hook silently strands every cycle.

**Smallest repair:** Add chainId and hook fields to the approval binding and to the verification receipt (from artifact.domain), and require in reducer.recordDistributionVerification that they equal state.preflight.releaseEvidence.chainId and state.preflight.hook; additionally have verifyApproval reject an approval whose chainId/hook does not match the closed-proceeds-basis chain, and fix the test fixture to use one consistent chainId.

**Verifier reasoning:** Verifiers reproduced the exact mismatch with a standalone probe (snapshot/approval chainId '1' and hook 0xff..ff producing a domain that diverges from the vault payout authorization's chainId '4663') and cross-checked it against the shipped test file, which encodes and passes the same divergence.

---

### HK-032: verifyDistributionCopies forwards candidateDigest/ownerApprovalDigest unverified and never re-checks the owner approval it is meant to independently confirm

**Location:** `packages/runner/src/distribution/manifest.mjs:366`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--correctness#1, runner-distribution--autonomy-readiness#7

verifyDistributionCopies validates only the artifact's self-consistency (manifest bytes, root, proofs, leaves) and byte-equality of three supplied copies; it never sees the closed proceeds basis, the snapshot, the entries digest, or the signed approval -- it simply copies artifact.candidateDigest and artifact.ownerApprovalDigest straight into the receipt it signs. reducer.recordDistributionVerification then binds only cycle ids, ledger digest and rootSum, never re-deriving the candidate or checking any approval. A probe built a bare distribution tree paying the whole finalCredit to an arbitrary address with fabricated digests, and verifyDistributionCopies, recordDistributionVerification and preparePayoutFunding all accepted it.

**Impact:** Whoever controls the verifier signer (in this repo, a fixture key whose private half is committed -- see HK-036) can redirect an entire cycle's holder proceeds to arbitrary recipients while every journaled receipt looks valid; the 'owner approval' safeguard is ceremonial for the state machine, and in the autonomous Phase 2 target the automation service would become the sole authority over the split.

**Smallest repair:** Give verifyDistributionCopies the approval, closedProceedsBasis, snapshot and entries; have it re-run compileApprovedDistribution (or at minimum verifyApproval + deriveHolderDistributionCandidate) and compare the recomputed digests with the supplied artifact before issuing the receipt; add ownerApprovalDigest, snapshotDigest and entriesDigest to the receipt and check them in the reducer against a journaled approval record.

**Verifier reasoning:** Verifiers built and ran a fabricated-artifact probe end to end and confirmed it passed every downstream check (copy verification, journaling, funding preparation) with no reference back to a genuine owner approval.

---

### HK-033: No pro-rata invariant is enforced anywhere; any USDG split that sums to the cycle's credit is accepted

**Location:** `packages/runner/src/distribution/reconcile.mjs:328`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--correctness#2, runner-distribution--security#2, runner-distribution--autonomy-readiness#1

deriveHolderDistributionCandidate checks only that each entry's directHkmnBalance matches the snapshot, that each amountAtomicUSDG is a positive decimal, and that the amounts sum to finalCredit.amount. The relationship between amount and balance is never checked, and a repository-wide grep for pro-rata/totalSupply/remainder logic across packages/runner/src returns nothing. A probe with balances 100/200 paying 9/1 (the inverse of proportional) passed reconcile, owner-approval compilation, copy verification, journaling and funding preparation without any rejection.

**Impact:** Wrong money accounting is fully representable and undetectable by the pipeline -- an arbitrary or mistaken allocation is a valid candidate -- and because there is no reference rule anywhere to test against, whoever produces the `entries` input effectively owns the actual split, with no automated enforcement of the owner's stated pro-rata promise.

**Smallest repair:** Define the pro-rata rule once in reconcile.mjs (e.g. floor(proceeds * balance / sumBalances) per holder with a deterministic remainder rule such as largest-remainder-to-lowest-index), have deriveHolderDistributionCandidate compute entries from the snapshot itself rather than trusting caller-supplied entries, and add a property test asserting the sum equals proceeds and each amount is within one atomic unit of its exact share.

**Verifier reasoning:** Verifiers ran a deliberately non-proportional probe through the full compile/verify/journal/fund pipeline and confirmed it was accepted at every stage, proving the absence of any pro-rata check rather than merely inferring it from the code.

---

### HK-034: Runner-side snapshots with more than 1,024 holders are rejected outright, with no chunking and no snapshot-completeness binding

**Location:** `packages/runner/src/distribution/reconcile.mjs:282`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--autonomy-readiness#3, runner-distribution--security#3, runner-distribution--correctness#4

validateSnapshot passes snapshot.directBalances through assertCandidateArray, which throws when length > 1024 (mirroring the on-chain CanonicalMerkleSum TREE_WIDTH, HK-014). Combined with the entries-equals-snapshot rule, a token with 1,025+ direct holders cannot produce any distribution at all; neither multiple payoutIds per cycle nor an explicit selection rule is implemented or specified anywhere in the runner. There is also no totalSupply/coverage field, so the pipeline cannot distinguish a truncated snapshot from a complete one, and an attacker can cheaply push a token over 1,024 holders with dust transfers to force this failure.

**Impact:** Growth past 1,024 holders halts automatic payouts permanently until a spec change lands, and in the meantime an attacker can force this state on demand as a griefing vector against the whole distribution pipeline.

**Smallest repair:** Implement chunking (split into ceil(n/1024) payoutIds per cycle, each with its own manifest and vault authorization) or an explicit approved selection rule (e.g. top-1024 by balance with remainder carried to the next cycle), and add snapshot coverage fields (totalSupply, includedSupply, excluded-dust total) that the candidate digest binds and the reducer checks.

**Verifier reasoning:** Verifiers confirmed assertCandidateArray's 1024-item ceiling applies identically to both snapshot.directBalances and entries, and that no code path in reconcile.mjs or manifest.mjs splits a larger holder set across multiple payoutIds.

---

### HK-035: No live holder-snapshot source exists; finality and balances are entirely caller-asserted

**Location:** `packages/runner/src/distribution/reconcile.mjs:268`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--autonomy-readiness#4

validateSnapshot checks schema strings, regexes, finalized === true, and recipient uniqueness, then trusts every {recipient, directHkmnBalance} pair as given. Nothing in packages/runner reads the HKMN token on Robinhood Chain -- no RPC client, no Transfer-log replay, no balanceOf multicall -- nothing checks tokenAddress against the launch bindings, and nothing independently verifies that blockNumber/blockHash are actually finalized. The schema's own authority string for this data is literally INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED.

**Impact:** An autonomous loop has no way to obtain the real holder set each cycle; whoever supplies the snapshot input fully controls who is eligible to be paid, with no independent check anywhere in the pipeline.

**Smallest repair:** Add a snapshot provider module that reads a finalized Robinhood block, replays Transfer events or multicalls balanceOf for known holders (excluding the hook/vault/treasury addresses), emits a signed snapshot under a distinct verifier key and authority string, and binds tokenAddress/chainId to the launch bindings inside validateSnapshot.

**Verifier reasoning:** Verifiers confirmed by grep that packages/runner contains no on-chain data client of any kind for holder balances, and that the schema's own authority label already discloses the snapshot is unauthenticated input.

---

### HK-036: The production distribution verifier trusts hardcoded fixture Ed25519 keys whose private halves are committed in the repository

**Location:** `packages/runner/src/distribution/manifest.mjs:11`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--security#0, runner-distribution--autonomy-readiness#5, runner-distribution--correctness#5

OWNER_PUBLIC_KEY and DISTRIBUTION_VERIFIER_PUBLIC_KEY are literal constants in the src module with no configuration hook. Deriving the public keys from the private keys committed in packages/runner/test/distribution/manifest.test.mjs and packages/runner/test/integration/phase-one-local-loop-adapter.mjs reproduces both constants exactly. CycleRunner.recordDistributionVerification and the journal reducer call verifyDistributionVerificationReceipt against these same keys, so anyone with read access to the repository can mint a fake 'owner approval' plus a matching 'independent verification' receipt that the runner accepts and turns into a vaultPayoutAuthorization -- and this same src module sits on the runner's real journal path with no mechanism to swap the keys for live use.

**Impact:** The only stated control over which allocation is compiled and funded (owner signature plus independent verifier signature) is void for anyone with repository access: an attacker who can feed inputs to the runner can approve an allocation that pays the entire returned USDG to themselves.

**Smallest repair:** Move both public keys out of source into injected configuration (constructor/option parameter, or an environment-provided SPKI hex validated at startup) and fail closed if they equal the committed fixture constants outside a declared test/fixture chain id; add a test asserting a receipt signed by a different key is rejected.

**Verifier reasoning:** Verifiers independently derived both public-key constants from the private keys committed in the test files using node:crypto and confirmed an exact byte match, proving the keys are not merely similar but literally the same keypair.

---

## 2.3 Medium (32)

### HK-037: The Programmable beneficiary is never pinned to the policy-mandated owner address 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c

**Location:** `packages/contracts/src/bindings/RobinhoodBindings.sol:133`
**Theme:** Programmable fee-policy conformance
**Sources:** contracts-kernel--correctness#1, contracts-kernel--spec-conformance#3, contracts-kernel--security#6, contracts-launch--spec-conformance#8

RobinhoodBindings.validate pins USDG, PoolManager, PositionManager, UniversalRouter and LiquidityLauncher to fixed constants but only requires binding.programmableBeneficiary to be nonzero and distinct from the other bound addresses. HookemonHook's constructor stores whatever config.programmable is passed with no equality check, and FeeAccounting keys the 10 bps liability to that immutable address forever. The Programmable fee policy requires the liability to be bound to exactly the one address above; a repository-wide grep (excluding lib/) finds that literal address nowhere, and script/release/PhaseOneReleasePlan.sol likewise only checks plan.programmable != 0.

**Impact:** A deployment with a mistyped or substituted Programmable address passes every on-chain binding and release-script check and permanently misdirects the Programmable entitlement, since the hook is immutable and offers no rescue path.

**Smallest repair:** Add a PROGRAMMABLE_OWNER constant with the exact policy address to RobinhoodBindings.sol, include binding.programmableBeneficiary != PROGRAMMABLE_OWNER in the InvalidKnownProviderIdentity condition, add the same check to PhaseOneReleasePlan, and have the deployment script derive config.programmable from that constant.

**Verifier reasoning:** Verifiers confirmed by targeted grep that the exact policy-mandated address appears nowhere in the repository outside this finding's own text, and that RobinhoodBindings' validate() genuinely omits it from the identity-pinning conjunction that covers every other role.

---

### HK-038: hookData recipient/operationId are attacker-controlled through the real, bound UniversalRouter

**Location:** `packages/contracts/src/market/CanonicalMarket.sol:157`
**Theme:** Single-router binding & swap execution
**Sources:** contracts-kernel--security#1, contracts-kernel--correctness#3, contracts-tests-a--test-coverage-gaps#2

The only hookData check is payload.sender == sender == swapRouter. The bound router is the public UniversalRouter, which forwards caller-supplied hookData verbatim and never reads or enforces its recipient field. Any user can submit hookData naming an arbitrary recipient and any nonzero operationId (including one already used by the operator's own cycle); _afterSwap then credits buyerHkmnCredit[payload.recipient], overwrites the lastExecutedUsdg/lastOperationId/lastHkmnRecipient globals, and emits CanonicalSwapObserved with the forged ids, with nothing preventing operationId reuse. The repository's own test only proves recipient binding against a bespoke test router that reverts on a mismatch -- the production UniversalRouter has no such check, so the property the tests assert does not hold on Robinhood Chain.

**Impact:** Forged buyer credits and replayed operationIds poison any distribution, reconciliation, or dashboard logic built on buyerHkmnCredit/CanonicalSwapObserved/last* state; the autonomous cycle cannot safely identify its own swap by these values on the real router.

**Smallest repair:** Either remove recipient/operationId from hookData and the buyerHkmnCredit/last* state entirely (they add no fee-accounting safety), or bind them cryptographically (hookData carries an operations-role signature over operationId/recipient/params, with operationId marked consumed). Off-chain code must reconcile via the swap's own transaction receipt/BalanceDelta, never via the last* storage globals.

**Verifier reasoning:** Verifiers confirmed the production UniversalRouter binding performs no recipient-matching check by reading its bound address and comparing against the bespoke RecipientPoolSwapTest router the passing test actually exercises.

---

### HK-039: Exact-output quadrants charge 3% of the net leg, not the gross quote-side amount (2.913% effective), leaving Programmable 9.7 bps short of the mandatory 10 bps floor

**Location:** `packages/contracts/src/market/CanonicalMarket.sol:222`
**Theme:** Programmable fee-policy conformance
**Sources:** contracts-kernel--security#2, contracts-kernel--spec-conformance#4

For exact-output USDG the hook returns 3% of the requested net amount N as fee, so the pool pays out N*1.03 gross and the fee is 3/103 (2.913%) of the gross outflow, not 3% of it. For exact-output HKMN (user pays USDG) the fee is likewise 3% of the pool's net USDG leg rather than the gross user-side spend. Only the two exact-input quadrants collect exactly 3% of gross. The Programmable policy requires the basis to be the gross quote-side amount before deducting fees, and RobinhoodBindings.validateQuadrant re-derives the same net-basis formula, so the offline verifier agrees with the on-chain shortfall instead of catching it. Programmable therefore receives 10 bps of the net amount, i.e. 9.71 bps of gross, under the policy's immutable minimum.

**Impact:** Under-collection of roughly 2.9% of the intended fee (and of the Programmable entitlement) on every exact-output swap; a Programmable policy review would return changes-required, and this is the same non-conformance flagged from the executed-USDG-basis angle (Q is gross for exact-input, net-of-fee for exact-output).

**Smallest repair:** Gross up in both exact-output quadrants: fee = ceil(net * 300 / 9_700), i.e. solve for the gross amount G such that G - floor(G*300/10000) = net (or charge fee on net+fee iteratively) in _beforeSwap and _validateFinalizedSwap; update RobinhoodBindings._validateHookAccounting identically and add tests asserting fee/gross == 3% in all four quadrants; record the decision in a new ADR.

**Verifier reasoning:** Verifiers independently re-derived the 3/103 = 2.913% arithmetic from the Hooks.afterSwap code path in both exact-output quadrants and confirmed RobinhoodBindings.validateQuadrant mirrors rather than catches the shortfall.

---

### HK-040: Programmable/treasury claims cannot name a destination and emit no event, conflicting with the policy's owner-selected-destination rule

**Location:** `packages/contracts/src/HookemonHook.sol:156`
**Theme:** Programmable fee-policy conformance
**Sources:** contracts-kernel--security#4, contracts-kernel--spec-conformance#2, contracts-kernel--correctness#5, contracts-tests-a--test-coverage-gaps#7

claimProgrammable(beneficiary, destination) routes through MoneyRoles._authorizeProgrammableClaim, which requires destination == storedBeneficiary == msg.sender, so the destination argument is dead in the frozen ABI and FeeAccounting._claimLiability always pays msg.sender. The Programmable policy requires that each claim may pay the owner itself or a destination selected by the owner for that claim, and the repository tracks this exact conflict as an open blocker (PROGRAMMABLE_OWNER_AND_CLAIM_DESTINATION_POLICY_RESOLUTION: UNRESOLVED). Because USDG is a Paxos-issued, freezable, upgradeable token, if the immutable owner or treasury address is ever frozen, _transferExactUsdg reverts and that beneficiary's liability is locked in the hook with no rescue path by design. No Claimed event exists in FeeAccounting either, so a dashboard cannot index claims at all.

**Impact:** Policy non-compliance on the claim surface for an immutable, unpatchable hook, plus a permanent-loss scenario for the Programmable and treasury buckets under a regulated-token freeze, plus no on-chain claim event for reconciliation.

**Smallest repair:** Resolve the blocker with the owner and Programmable maintainers before deployment; if the policy wins, allow msg.sender == owner to pass any nonzero destination != address(this), thread it through _claimLiability, and emit ProgrammableClaimed/TreasuryClaimed(beneficiary, destination, amount) events.

**Verifier reasoning:** Verifiers confirmed the destination parameter is checked for equality to the stored beneficiary rather than being forwarded, and that the repository's own interface-freeze tracker already records this exact conflict as unresolved.

---

### HK-042: No fee-collection amounts in the swap event and no claim event at all, so on-chain reconciliation of liabilities is impossible

**Location:** `packages/contracts/src/accounting/FeeAccounting.sol:81`
**Theme:** Programmable fee-policy conformance
**Sources:** contracts-kernel--spec-conformance#5, contracts-kernel--correctness#4

CanonicalSwapObserved carries operationId, sender, recipient, executedUsdg and rawHkmnDelta but not the totalFee/programmable/treasury/process split, and _claimLiability emits nothing. The Programmable policy requires declared collection and claim events with the property that they reconcile exactly with balances and liabilities; REQ-release-evidence-2 freezes the event schema in the immutable hook, and ProcessBudgetReleased/EntitlementPaid already exist for the other liability classes, making fee claims the only unlogged money movement in the system.

**Impact:** Indexers and the owner's planned dashboard must re-derive fee splits off-chain from executedUsdg and cannot observe Programmable/treasury claims at all, and the Programmable application cannot name a claim event as required.

**Smallest repair:** Add event FeeAccrued(executedUsdg, totalFee, programmableFee, treasuryFee, processFee, treasuryBeneficiary) in _accrueAuthenticatedSwap and event FeeLiabilityClaimed(class, beneficiary, destination, amount) in _claimLiability, and freeze both in architecture/interfaces.json before deployment.

**Verifier reasoning:** Verifiers confirmed by reading the event definition and _claimLiability that no fee-split field or claim event exists anywhere in FeeAccounting.sol, in contrast to the other liability classes which do emit events.

---

### HK-043: recordTerminalFailure is callable immediately after executeOutbound as a single-key kill switch, with no timelock or pre-commitment

**Location:** `packages/contracts/src/process/PegCycleVault.sol:301`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--security#6

executeOutbound leaves the vault balance at exactly zero for a clean cycle, and recordTerminalFailure only requires OUTBOUND, a matching cycleId, a nonzero digest, and balance == 0. The authorizer -- a single msg.sender-gated hot key with no signature threshold or timelock -- can therefore mark any live, in-flight cycle as FAILED in the very next block after outbound, which (via HK-012) permanently absorbs the vault's process-budget path.

**Impact:** Bounded to denial of service but irreversible: a compromised or mis-scripted authorizer key has a single-transaction, permanent kill switch over the immutable hook's entire process mechanism.

**Smallest repair:** Require a minimum elapsed time since executeOutbound (record an outboundAt timestamp) before recordTerminalFailure is callable, and/or require the failure receipt digest to be pre-committed inside the FundingAuthorization so failure evidence is bound at authorization time rather than freely chosen after the fact.

**Verifier reasoning:** Verifiers confirmed recordTerminalFailure's precondition set (OUTBOUND + balance==0) is satisfied immediately after every clean executeOutbound and that no timelock or additional signer is required, matching the single-key characterization.

---

### HK-044: An unpayable or issuer-frozen leaf locks its share of the payout forever: no sweep, expiry, or correction path

**Location:** `packages/contracts/src/settlement/HolderSettlement.sol:45`
**Theme:** Holder payout & distribution pipeline
**Sources:** contracts-payout--correctness#3, contracts-payout--security#3

Once funded, a payout can only shrink via payEntitlement for a valid leaf. A leaf whose transfer can never succeed -- most concretely, a holder address frozen by the regulated, Paxos-issued, upgradeable USDG proxy -- or a whole payout whose leaves can never verify (wrong rootSum, wrong chainId/hook in the manifest, wrong manifestDigest) keeps unpaidTotal permanently above zero inside totalLiabilityAmount, with HolderSettlement.t.sol explicitly asserting that no recovery selector exists. The PRD itself forbids adding one ('Entitlements never expire', 'V1 exposes no surplus sweep').

**Impact:** Bounded to the affected leaf's share, but cumulative across cycles and permanent: for an unattended 20-minute loop, any offchain manifest bug or a single frozen holder address strands USDG in the hook with no operator remedy, contradicting the owner's 'restart/kick stuck cycles' dashboard requirement.

**Smallest repair:** Keep the on-chain no-sweep guarantee, but have the offchain manifest builder query the USDG proxy's freeze view before building a snapshot and exclude frozen addresses at that point; specify a Phase 2 long-horizon re-commitment rule (e.g. after N years an unpaid remainder may be re-rooted into a new payoutId) if the owner wants stuck value ever recoverable.

**Verifier reasoning:** Verifiers confirmed HolderSettlement.t.sol's own tests assert the absence of any recovery selector, and cross-checked the PRD language that explicitly forbids adding one, so the permanence is a documented design choice rather than an oversight, though still a real operational gap.

---

### HK-046: REQ-holder-settlement-6's mandatory gas-headroom evidence does not exist

**Location:** `packages/contracts/src/settlement/HolderSettlement.sol:33`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-payout--spec-conformance#1

The approved Phase 1 requirement calls for gas snapshots at index 0, index 1023, first payment, replay, malformed proof, maximum subtree sums and transfer failure, each showing positive headroom against the official Robinhood gas limits. No .gas-snapshot file, snapshots/ directory, gasleft() measurement, or recorded headroom exists anywhere in packages/contracts or docs; the module card itself concedes that productive Robinhood gas-limit evidence remains an integration prerequisite.

**Impact:** An approved Phase 1 performance requirement has no measurement on record; a 10-level proof with 20 calldata words is cheap in practice so launch risk is likely low, but the requirement is formally unproven.

**Smallest repair:** Add a forge gas-snapshot test covering index 0, index 1023, replay, malformed proof and transfer failure, writing numeric headroom against the bound Robinhood gas limit from bindings/robinhood-chain.json, and cite it from the module card.

**Verifier reasoning:** Verifiers grepped for gas-snapshot artifacts and gasleft() measurements across the repository and confirmed none exist, matching the module card's own admission.

---

### HK-047: Hook CREATE2/runtime verification is self-referential: it never recomputes the hook's init-code preimage and never checks the v4 permission-bit mask

**Location:** `packages/contracts/script/release/PhaseOneReleasePlan.sol:134`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--correctness#0, contracts-launch--security#0, contracts-launch--spec-conformance#1, contracts-launch--spec-conformance#2

The vault side of the release plan is properly anchored: vaultInitCodeHash is recomputed from type(PegCycleVault).creationCode plus the plan's own constructor args, so the CREATE2 address actually proves which code was deployed. The hook side only checks that computeCreate2Address(hookDeployer, hookSalt, hookInitCodeHash) == expectedHook and that expectedHook.codehash == hookRuntimeCodeHash, with both hash inputs taken directly from calldata; the Plan struct carries none of HookemonHook's constructor arguments, so it cannot recompute the real preimage, and validate() never checks uint160(expectedHook) & 0x3FFF == 0x00CC even though HookemonHook's own constructor and RobinhoodBindings.validate both enforce that mask. The repository's own invariant suite deploys an unconstrained ReleasePlanRuntimeFixture instead of HookemonHook, so the gap is untested, and verifyDeployedRuntime separately never staticcalls PegCycleVault(expectedVault).hook() to confirm the vault and hook are actually mutually bound, nor does the Plan carry the PoolManager/router/HKMN/PoolKey/custody identities needed to prove it.

**Impact:** A release plan can validate and be digested (planDigest) for a hook address that HookemonHook cannot actually be deployed at, for a hook whose bytecode is not HookemonHook, for a hook missing its required permission bits, or for a hook bound to the wrong vault -- the mismatch would only surface when the real deployment reverts or when a wrong hook is accepted into the runtime-set digest that release evidence treats as authoritative.

**Smallest repair:** Extend Plan with HookemonHook.ConstructorConfig fields and recompute hookInitCodeHash = keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config))) exactly as already done for the vault; add the uint160(expectedHook) & 0x3FFF == 0x00CC check; extend Plan with the PoolManager/router/HKMN/PoolKey/custody identities and staticcall PegCycleVault(expectedVault).hook() inside verifyDeployedRuntime to confirm mutual binding; make the invariant fixture deploy a real HookemonHook so the recomputation is actually exercised.

**Verifier reasoning:** Verifiers confirmed the asymmetry directly by comparing the vault-side and hook-side validation code in PhaseOneReleasePlan.sol line by line, and confirmed the invariant suite's substitution of an unconstrained fixture for the real hook by reading PhaseOneReleaseInvariant.t.sol.

---

### HK-048: Two Solidity implementations of the issuance-trace rule disagree, and neither matches the vendored launchpad's actual transfer topology

**Location:** `packages/contracts/src/launch/HookemonIssuance.sol:206`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--correctness#1

HookemonIssuance._validateTrace accepts exactly two nonzero records, both from == plan.issuanceSource, one to canonicalMarket and one to remainderRepresentation. FixedSupplyBlindEvidence.validateIssuanceTrace, applied by the blind spec to the full recorded Transfer log, accepts any number of records, skips zero-amount ones, checks only the market leg amount, and never checks the remainder leg at all. The vendored issuance path actually emits at least three Transfer events (UERC20's constructor mint, then LiquidityLauncher.distributeToken's safeTransferFrom, then the strategy moving tokens into PoolManager), which the hook's two-record rule can never match with an honest full trace when issuanceSource = address(0), the value every repository fixture uses.

**Impact:** The Launchpad/UERC20 binding cannot satisfy verifyIssuance with an honest full trace once it exists; the spec's blind test and the hook's own guard would give different verdicts for the same on-chain log, leaving no single source of truth for what a valid issuance trace actually is.

**Smallest repair:** Define one trace rule in a shared library used by both the guard and the spec that models the bound path explicitly (mint 0->issuanceSource, then exactly one direct leg each to canonicalMarket and remainderRepresentation, sum-of-outbound == totalSupply), and record in bindings/robinhood-chain.json which address issuanceSource actually is once the launchpad path is bound.

**Verifier reasoning:** Verifiers traced both rule implementations against the vendored UERC20/LiquidityLauncher source and confirmed the three-event real topology satisfies neither rule as currently written, particularly with the address(0) issuanceSource every fixture uses.

---

### HK-049: HKMN decimals are frozen into the hook before the token exists, with no repository artifact binding the value to what the launchpad will actually mint

**Location:** `packages/contracts/src/launch/HookemonIssuance.sol:145`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--correctness#2, contracts-launch--security#3

_expectedDecimals is an immutable constructor argument of the hook, but the hook must be CREATE2-deployed (its address baked into the PoolKey) before HKMN is created by the launchpad, whose createToken call takes decimals as a free uint8 argument with no cross-check. bindings/robinhood-chain.json only records USDG's decimals; the hook integration test and local loop use 18 while HookemonIssuance.t.sol exercises 6, and the PRD only says 'adjusted for the officially bound decimals'. If the launchpad call ever uses a value other than the one baked into the hook, _validatePlan reverts InvalidIdentity forever with no re-prepare path (the guard is one-shot), and the only remedy is redeploying the hook at a new address.

**Impact:** A single unpinned integer, chosen at two different times by two different transactions with no cross-check between them, decides whether the deployed hook's issuance guard can ever be verified -- and getting it wrong after the hook is deployed forces a full redeploy.

**Smallest repair:** Add hkmn.decimals (and the resulting scaled totalSupply/marketAllocation/remainderAllocation) to bindings/robinhood-chain.json, have the release runner derive both HookemonHook.ConstructorConfig.expectedDecimals and the launchpad's createToken decimals argument from that single field, and assert equality in PhaseOneReleasePlan or the runner's pre-flight.

**Verifier reasoning:** Verifiers confirmed the immutable expectedDecimals field has no binding to any other decimals source in the repository, and found three different decimals values (6 and 18) already in use across the test suite with no reconciliation.

---

### HK-050: The issuance guard is evidence-only and gates nothing: no swap, claim or payout path reads its status, and observation.token is never checked against the hook's own HKMN

**Location:** `packages/contracts/src/launch/HookemonIssuance.sol:135`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--security#2, contracts-launch--spec-conformance#3, contracts-launch--correctness#3

HookemonHook inherits HookemonIssuance, but no callback or claim path reads _guardState/readTokenState, so beforeSwap/afterSwap/payEntitlement/claim* all proceed identically whether issuance is UNPREPARED, PREPARED, or VERIFIED. Inside verifyIssuance the only identity checks on observation.token are non-zero and not-equal-to-role-address; nothing requires observation.token == Currency.unwrap(hkmn) even though the hook already holds that address immutably. Because the guard is one-shot with no revoke and the hook is immutable, an authority that submits a self-consistent observation for the wrong token permanently records that wrong token in the hook's public issuance evidence, and the guard state has no dependency on hook state whatsoever, so its stored data is never consumed by any hook logic.

**Impact:** The guard advertises itself as fail-closed but cannot close anything: the money path runs regardless of issuance verification, and the publicly readable 'verified issuance' record can diverge from the pool's actual HKMN with no on-chain recourse for anyone relying on it.

**Smallest repair:** Either (a) pass Currency.unwrap(config.hkmn) into HookemonIssuance and revert InvalidIdentity when observation.token != hkmn, and require GuardStatus verified before the first authenticated swap/fee accrual, or (b) remove the guard from the immutable hook entirely and move issuance evidence to the offchain release manifest, matching the owner-approved thin-V1 boundary.

**Verifier reasoning:** Verifiers confirmed by reading every swap/claim/payout entry point that none of them consult _guardState, and confirmed _validateObservation's identity checks omit the one comparison (observation.token vs hook's own hkmn) that would make the guard meaningful.

---

### HK-051: FixedSupplyBlindSpec has no live binding, so REQ-token-core-2 and REQ-token-core-3's mandatory measurements are never actually executed

**Location:** `packages/contracts/test/blind/token-roles/FixedSupplyBlindSpec.sol:58`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-launch--spec-conformance#5, contracts-launch--security#6

The spec's 18 test_/testFuzz_ entrypoints (identity, 90/10 allocation, direct trace, remainder treatment, duplicate/unauthorized issuance, wallet-transfer fee neutrality, selector denylists, DELEGATECALL/SELFDESTRUCT opcode scan, permanent custody) are the only place REQ-token-core-2 (selector allowlists and runtime opcode inspection) and REQ-token-core-3 (at least 10,000 fuzzed transfer amounts) are exercised at all. Its sole concrete subclass, FixedSupplyBinding.t.sol.disabled, is excluded from compilation, and every override in the abstract spec reverts BlindFixtureNotBound() -- so none of the 18 tests ever actually runs.

**Impact:** No executing test currently asserts name/symbol/decimals/supply, the 90/10 allocation, the absence of privileged token controls, or fee-free wallet transfers for any real or local token; the 'zero forbidden control paths' measurement the requirement demands is presently unmeasured, not merely under-sampled.

**Smallest repair:** Add a local concrete binding that deploys a fixed-supply ERC20 (e.g. via a local UERC20 factory) plus PermanentPositionCustody so the spec runs in CI now, and keep the provider-bound binding as a second subclass once the Launchpad is actually bound (HK-005).

**Verifier reasoning:** Verifiers confirmed FixedSupplyBinding.t.sol.disabled is excluded from the build and that every override in the abstract spec is a BlindFixtureNotBound() revert, meaning the 18 entrypoints are dead code today.

---

### HK-052: Recipient authentication is proven only by a bespoke test router, not by the hook or the bound UniversalRouter (test-side view of HK-038)

**Location:** `packages/contracts/test/market/CanonicalMarketCallbackSurface.t.sol:522`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#2

testPoolManagerRejectsSettlementRecipientDifferentFromHookData asserts a revert raised by the test-local router's own unlockCallback, which compares hookData.recipient with its own settlement recipient -- an error the hook itself never raises, since CanonicalMarket._afterSwap only records buyerHkmnCredit[payload.recipient] without seeing where the router actually settles. The production binding names the public UniversalRouter, which performs no such check and settles output to whatever recipient the caller encodes, independent of hookData; no test in the unit uses a router shaped like UniversalRouter (sender = router contract, caller-supplied hookData).

**Impact:** buyerHkmnCredit and lastHkmnRecipient can diverge from the real HKMN recipient on the production router, and any downstream logic that trusts these fields (distribution snapshot, evidence) would be silently wrong with the test suite giving no warning.

**Smallest repair:** Either document buyerHkmnCredit as router-attested only and drop the recipient-rejection claim from the evidence docs, or add an integration test against a UniversalRouter-equivalent router that shows the hook's actual (non-enforcing) behavior when hookData.recipient differs from the settled recipient.

**Verifier reasoning:** Verifiers confirmed the asserted revert selector originates in the test router's own callback logic, not in CanonicalMarket.sol, and confirmed the bound production router (UniversalRouter) contains no equivalent check.

---

### HK-053: Sell-side quadrants and the gross-quote basis are not independently verified through a real PoolManager in any gated test

**Location:** `packages/contracts/test/market/CanonicalMarketCallbackSurface.t.sol:362`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#3

In the only CI-run market suite, all eight quadrants are exercised by pranking beforeSwap/afterSwap with author-chosen BalanceDeltas computed from the same formula the hook itself uses; the real-PoolManager runs in that same suite only loop over buys, never a HKMN->USDG sell. In HookemonHook.t.sol (which does run every quadrant through a real PoolManager but is not CI-gated), the expected fee is derived from the hook's own lastExecutedUsdg output, so for USDG-unspecified quadrants nothing independently checks that executedUsdg equals the pool's actual gross USDG leg.

**Impact:** A bug that mis-selects the USDG leg or uses the post-fee amount for unspecified quadrants would produce a matching fee and a matching lastExecutedUsdg and would pass every currently gated test, since the check and the implementation share the same formula.

**Smallest repair:** In HookemonHook.t.sol's quadrant runner, compute the gross amount from the returned BalanceDelta independently (assert abs(usdgDelta) + fee == lastExecutedUsdg for unspecified quadrants) rather than trusting the hook's own output, and add real-PoolManager sell quadrants to the CI-gated market suite.

**Verifier reasoning:** Verifiers confirmed the CI-gated suite's real-PoolManager loop only covers zeroForOne buy directions, and confirmed the ungated HookemonHook.t.sol derives its expected value from the same output it is meant to be checking.

---

### HK-054: Foreign-pool rejection is tested only for the fee field; tickSpacing, hooks, currency order and currency-pair mutation vectors are all missing

**Location:** `packages/contracts/test/market/CanonicalMarketCallbackSurface.t.sol:750`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#4

REQ-canonical-market-1 requires field-by-field negative vectors for a foreign pool that differs by manager, fee, tick spacing, hook, currency ordering or pool id, but the unit's only key-mutation helper mutates key.fee = 1 (plus a separate manager-only vector). CanonicalMarket._matches is one conjunction over currency0, currency1, fee, tickSpacing, hooks, protocolFee and liveLpFee, so a regression that silently drops the tickSpacing, hooks, or currency comparisons would leave every currently gated test in this unit green.

**Impact:** A regression in _matches could let a second USDG/HKMN pool with a different tick spacing or a wrapper hook accrue Hookemon liabilities and credit HKMN, breaking the 'exactly one canonical market' guarantee, without any test in the gated suite catching it.

**Smallest repair:** Extend the key-mutation helper with an enum covering tickSpacing, hooks, currency0/1 replacement, and currency ordering, asserting InvalidCanonicalPoolKey with zero fee collection for each mutation, and add an afterSwap variant of the same matrix.

**Verifier reasoning:** Verifiers read _matches's full conjunction and the test helper's single-field mutation and confirmed five of the seven compared fields have no negative test vector at all.

---

### HK-055: The release-gated local loop proves the canonical buy against an extsload-only PoolManager stub with a fee that is simply minted, not collected

**Location:** `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol:251`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#5

The phase-one-local-loop gate is the evidence for REQ-release-evidence-4's 'one canonical HKMN buy, exact fee accounting'. Its buy pranks the callback pair directly with a fixed toBalanceDelta; LocalLoopPoolManager implements only extsload() returning zero, and LocalLoopSettlement._collectFee mints the fee to itself instead of calling poolManager.take(). No swap, settlement, or actual token movement from a pool occurs, so this gate cannot detect a wrong fee-delta sign, a broken take(), or a mis-ordered PoolKey.

**Impact:** The release evidence bundle records a passing end-to-end loop whose swap leg is entirely synthetic; the real PoolManager path of the deployable HookemonHook is exercised only by the ungated HookemonHook.t.sol, not by anything that gates a release.

**Smallest repair:** Replace LocalLoopPoolManager with a real PoolManager + PoolSwapTest (as HookemonHook.t.sol already does) and run the loop against the concrete HookemonHook, or explicitly label the gate's result as 'accounting-only, no pool execution' in the release evidence docs.

**Verifier reasoning:** Verifiers confirmed LocalLoopPoolManager.extsload() is a hardcoded zero-returning stub and that LocalLoopSettlement._collectFee mints rather than calls the real take() interface, by reading both contracts directly.

---

### HK-056: The requirement-mandated 100,000 fuzz/invariant runs (and 10,000 for token-core fuzzing) are not configured anywhere; every gate accepts Forge's 256-run default

**Location:** `packages/contracts/foundry.toml:1`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#6, contracts-launch--spec-conformance#6

REQ-fee-accounting-1 requires at least 100,000 fuzzed Q values, REQ-fee-accounting-4/REQ-payout-commitment-4 require at least 100,000 stateful operation sequences, and REQ-token-core-3 requires at least 10,000 fuzzed transfer amounts. foundry.toml declares no [fuzz] or [invariant] section, the CI commands pass no --fuzz-runs, and the release script's countPositiveInvariantResults accepts any run count of 10-99,999,999 as passing. Only one docs line mentions --fuzz-runs 100000 as a manual, undocumented-elsewhere command.

**Impact:** The approved measurement thresholds are entirely unenforced: the invariant and fuzz evidence actually recorded in release receipts covers roughly 0.25% of the required sample size for the fee-accounting and payout-commitment requirements.

**Smallest repair:** Add [fuzz] runs = 100000 and [invariant] runs = 100000 (or a dedicated release profile) to foundry.toml, pass the equivalent --fuzz-runs/FOUNDRY_INVARIANT_RUNS flags in the release script, and tighten the release script's run-count regex to the actual required minimum per requirement.

**Verifier reasoning:** Verifiers confirmed foundry.toml has no [fuzz]/[invariant] sections and that the release script's acceptance regex for run counts is far looser than the cited requirements, matching Forge's documented 256-run default.

---

### HK-057: The claim-destination test itself asserts that the owner cannot select a per-claim destination, contrary to the Programmable policy, and no test anywhere pins the programmable beneficiary to the mandated owner address

**Location:** `packages/contracts/test/integration/HookemonHook.t.sol:483`
**Theme:** Programmable fee-policy conformance
**Sources:** contracts-tests-a--test-coverage-gaps#7

The suite asserts that claimProgrammable(PROGRAMMABLE, address(0xBEEF)) reverts with MoneyRoles.InvalidDestination, i.e. it encodes the exact behavior HK-040 flags as non-conformant as the expected, tested behavior. Separately, no test in the unit binds the programmable beneficiary to the mandated immutable owner address: HookemonHook.t.sol, FeeAccounting.t.sol, both invariant suites, and PhaseOneLocalLoop all use placeholder addresses (0x5000 or a ClaimActor contract) for PROGRAMMABLE.

**Impact:** The test suite enshrines a claim surface that fails Programmable policy evidence item 7 (owner-selected destination on each claim), and a deployment with a wrong programmable address would pass every test in the unit, matching the gap already flagged in HK-037.

**Smallest repair:** Decide with the Programmable maintainers whether owner-only-destination is acceptable; if not, update this test to allow msg.sender == owner to pass any nonzero destination and pass once HK-040 is fixed. Add a deployment-plan test asserting config.programmable equals the exact policy-mandated address for the production plan.

**Verifier reasoning:** Verifiers read the assertion and confirmed it is testing for the rejection of a policy-required capability, and cross-checked every PROGRAMMABLE test constant across the four cited files to confirm none matches the mandated address.

---

### HK-058: invariant_onlyBoundOperationsCanReleaseProcessFunds exercises a harness-only binder function, not the production openPegCycle path

**Location:** `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol:474`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#8

attemptUnauthorizedOrReplay and releaseBudget drive budget.bindCycleForFixture(cycleId), a ProcessBudgetHarness-only function that just calls _bindCycleOperationsTrigger directly -- it moves no USDG, debits no process liability, and consumes no vault authorization. ProcessBudgetHarness is itself constructed against a CompileOnlyPegCycleVault placeholder. The production release path, ProcessBudget.openPegCycle, is never invoked on this `budget` instance in the invariant (a separate `payout` instance does call it, but always as the authorized handler, never from `stranger`).

**Impact:** A regression that lets a non-Operations caller pass openPegCycle's vault-consumption or balance-delta checks would not be caught by this release-gated invariant; only the ungated HookemonHook.t.sol and test/process suites cover the real path.

**Smallest repair:** Point attemptUnauthorizedOrReplay at the `payout` PayoutCommitmentHarness's real openPegCycle with a staged funding authorization, calling from `stranger`, and assert no vault or hook balance change; drop or clearly rename the bindCycleForFixture-based path.

**Verifier reasoning:** Verifiers confirmed bindCycleForFixture calls only the internal trigger-binder and never touches any money-moving function by reading ProcessBudgetHarness and comparing it against the real openPegCycle implementation.

---

### HK-059: The adversarial-USDG matrices validate four hand-written harness token adapters, not the production HookemonHook token adapter

**Location:** `packages/contracts/test/payout/PayoutCommitment.t.sol:435`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#3

Each harness overrides its own USDG transfer function differently -- two use a high-level TOKEN.transfer whose ABI decoder reverts on a 0-byte return, one uses a low-level call plus abi.decode, one uses a low-level call with returned==1 -- while production HookemonHook._transferUsdg checks !success || result.length != 32 || !abi.decode(result,(bool)) and _usdgBalanceOf reverts on a non-32-byte return. The 8-behavior adversarial matrices (RevertTransfer, ReturnFalse, MalformedReturn, short/excess deltas, reentry) therefore prove the four harness adapters fail closed, not the adapter that will actually hold real USDG; e.g. a 32-byte return word of 2 is rejected as false by one harness but would revert inside abi.decode in production, and no test observes either behavior on the real adapter.

**Impact:** A regression in the production adapter itself -- e.g. accepting a 0-byte return from the USDG proxy after an upgrade -- would pass every adversarial-token test in this unit, since none of them exercises HookemonHook's own transfer/balance code.

**Smallest repair:** Extract the production adapter into a shared internal library or mixin used by both HookemonHook and every harness, or run the adversarial matrix once directly against HookemonHook (in test/integration) and reference that run from the other suites.

**Verifier reasoning:** Verifiers compared the four harness override implementations against HookemonHook._transferUsdg/_usdgBalanceOf line by line and confirmed at least one adversarial return value (a 32-byte non-boolean word) is handled differently by a harness than by production.

---

### HK-060: PermanentPositionCustody.onERC721Received is never executed by any test

**Location:** `packages/contracts/test/bindings/RobinhoodBindings.t.sol:119`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#4

Both existing custody tests mint the position NFT directly into the custody address and then call finalizePosition() explicitly. The alternate entry point, onERC721Received (which requires msg.sender == manager, from == address(0), and the correct tokenId before finalizing), is never reached by any test: a repo grep finds no safeTransferFrom/safeMint call in test/, and v4-periphery's PositionManager mints through solmate's _mint, which does not invoke the ERC721 receiver hook at all in the tests that exist.

**Impact:** The only code path that can finalize custody atomically during a safe mint/transfer is completely unverified; a regression that drops the tokenId check or the from==0 check inside onERC721Received would not be caught by any test.

**Smallest repair:** Add tests that call custody.onERC721Received directly from the mock manager with a wrong caller, from != 0, a wrong tokenId, and the happy path, asserting positionReceived and the PositionPermanentlyReceived event in each case.

**Verifier reasoning:** Verifiers grepped test/ for safeTransferFrom/safeMint and confirmed no call site exists that would route through onERC721Received, matching the claim that it is dead in the test suite.

---

### HK-061: The frozen scenario-matrix.json (revision 55) pins money flows that directly contradict the implemented revision-56 contracts and their own passing executable tests

**Location:** `packages/contracts/test/blind/payout-settlement/scenario-matrix.json:13`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#5

The frozen matrix expects a process-release delta straight to the Operations wallet and expects Operations to pay rootSum directly into the hook for payout funding. The implemented contracts move process budget hook->vault only and fund payouts vault->hook via an authorizer-signed PayoutAuthorization, and the Solidity test suite asserts token.balanceOf(OPERATIONS) == 0 after both operations -- yet scenario-matrix.test.mjs asserts the stale Operations-custody deltas verbatim and passes, so the six green node tests certify a design the Solidity tests actively forbid. The fixture also still labels interfaceBinding as 'deferred-until-frozen' although the ABI is now implemented, and its revision tags (R55_A4) disagree with both the vault (revision 56) and the bindings library (revision 54/3).

**Impact:** A reviewer, the owner, or a Phase-2 implementer reading the 'frozen' matrix as ground truth would build or approve an Operations-custody money flow that the current contracts actually reject, and the six passing node tests give false assurance that the matrix reflects reality.

**Smallest repair:** Re-freeze the matrix at revision 56 with the actual vault-custody deltas (or mark it explicitly superseded and remove it from the test tree), align interfaceBinding to the implemented state, and add a single cross-reference note stating which revision each pinned constant belongs to.

**Verifier reasoning:** Verifiers compared the JSON matrix's expected deltas against both the Solidity implementation and its own passing test assertions and confirmed the contradiction is real and currently undetected because the two test layers check different things.

---

### HK-062: Distribution verification requires the journal's cycleId to be a non-zero bytes32, but CycleJournal accepts any identifier, and the mismatch is discovered only after the cycle has closed

**Location:** `packages/runner/src/cycle/reducer.mjs:1020`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--correctness#5, runner-cycle-a--autonomy-readiness#15

recordDistributionVerification requires receipt.runnerCycleId === state.cycleId, while verifyDistributionVerificationReceipt rejects any of those fields that is not a well-formed 0x + 64 hex bytes32. CycleJournal and cycle-store accept any [A-Za-z0-9][A-Za-z0-9:._-]{1,127} id, and the unit's own test files use plain strings like 'cycle-1'. A cycle created with such an id can complete all six stages, close, and consume proceeds -- only to become unable to ever record distribution verification, i.e. the closed proceeds can never be handed off to payout, and this is discovered only after real money has already moved.

**Impact:** A late-failing constraint on money that has already left the vault: the closed proceeds become permanently stuck at the distribution-verification step with no earlier warning anywhere in the pipeline.

**Smallest repair:** Enforce the bytes32 cycleId format in CycleRunner's constructor (or against preflight.releaseEvidence's cycle id) so an invalid id fails fast before any mutation, rather than only at distribution time.

**Verifier reasoning:** Verifiers confirmed the format check exists only in verifyDistributionVerificationReceipt and is absent from every earlier stage, including the cycleId validation used by the store/journal themselves.

---

### HK-063: Every authorization-expiry and timestamp check compares against one frozen 2029 clock constant, never wall time

**Location:** `packages/runner/src/cycle/reducer.mjs:1097`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--security#4, runner-cycle-a--autonomy-readiness#9, runner-cycle-a--correctness#9

prepareFunding and authorization.mjs check every owner, Collector-mutation and post-open-buyback approval's expiry against Date.parse(FIXTURE_AUTHORIZATION_VALIDATED_AT)/1000, where the constant is the fixed string '2029-01-01T00:00:00.000Z'. Any authorization expiring after 2029 is therefore valid indefinitely, and one expiring before 2029 is always rejected, regardless of real elapsed time; every store record's validatedAt field is written from the same constant, so recorded 'validation times' are not real timestamps at all, and journal entries carry no timestamp field of their own.

**Impact:** Expiry provides no real bound on how long a leaked or stale signed authorization can be replayed, and if a production signer were ever wired in without replacing this constant, the on-chain vault payout authorization expiry check would not be mirrored off-chain at all.

**Smallest repair:** Inject a real, bounded-skew clock into CycleRunner/reducer (default Date.now, fixed only in tests), stamp each journal entry with its own timestamp as part of the digested entry, and validate approval expiry against the injected clock at the moment of consumption.

**Verifier reasoning:** Verifiers confirmed by grep that Date.now() is called nowhere in the unit and that every expiry comparison traces back to the same hardcoded 2029 string, across both cycle-a and cycle-b lens reports independently.

---

### HK-065: Closed-ledger validation requires the vault to be fully drained with a zero pre-return balance, incompatible with any shared-treasury model

**Location:** `packages/runner/src/cycle/reducer.mjs:528`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--autonomy-readiness#8

validateClosedLedger requires outbound.preSourceBalance === releasedAmount, postSourceBalance === '0', return.preDestinationBalance === '0', finalActivity.openingBalance === '0', exactly one movement in the vault's activity window, and returnAccount === cycleVaultAccount. This is satisfiable only by a dedicated per-cycle vault that nothing else credits between outbound and return; if the cycle vault is the same account the hook continuously streams the 2.5% process budget into (the owner's apparent model), the balance will be non-zero at return time and the activity window will contain fee movements, so no live cycle could ever close.

**Impact:** Back-to-back cycles on a single shared treasury/vault address cannot close under this model; a dedicated per-cycle escrow address (sketched in the unmerged codex/phase2-revision-57 branch) is a prerequisite for the owner's continuous-cycle design as currently written.

**Smallest repair:** Either adopt a per-cycle escrow address for both release and return and bind it in the preflight, or relax the closure checks to delta-based accounting (destination delta equals the receipt's amountOut, with the activity window filtered to the specific return transaction signature rather than requiring an empty account).

**Verifier reasoning:** Verifiers confirmed the exact zero-balance and single-movement preconditions in validateClosedLedger and cross-checked them against the owner's described continuous streaming model, confirming the two are structurally incompatible as written.

---

### HK-066: No observability surface exists anywhere in the runner or distribution pipeline for a community dashboard

**Location:** `packages/runner/src/cycle/cycle-runner.mjs:83`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--autonomy-readiness#10, runner-cycle-b--autonomy-readiness#10, runner-distribution--autonomy-readiness#13

CycleRunner.state returns only three fields (stage/version/head); there is no method returning which external mutations are unresolved, which authorization slots are still missing, which receipt is awaited, or when the last event happened, since journal entries carry no timestamp. verify-fixtures.mjs's only output in the whole unit is a single console.log line, and the distribution pipeline likewise has no entry point, scheduler, or exported status outside its own tests.

**Impact:** A dashboard, watchdog, or operator would have to re-implement the reducer's internal logic just to answer 'what is this cycle waiting on and for how long', and there is currently no data source for community-facing status or stuck-cycle detection anywhere in the codebase.

**Smallest repair:** Add a read-only describe() method returning stage, unresolved mutations with attempt time, the next required event kind, consumed/pending authorization slots, awaited receipts and last-event timestamp, and emit the same as structured logs on every commit; add an equivalent status projection for the distribution pipeline.

**Verifier reasoning:** Verifiers confirmed CycleRunner.state's field list by reading cycle-runner.mjs directly and grepped the distribution pipeline for any status/log output, finding none outside its test suite.

---

### HK-067: No forward recovery path exists when the journal and the store snapshot diverge; an empty store silently rebuilds cross-cycle registries from a single cycle

**Location:** `packages/runner/src/cycle/cycle-runner.mjs:59`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--autonomy-readiness#11

If the persisted store already holds the cycle, the supplied journal entries must equal the stored entries exactly -- a journal with even one more entry than the store (a crash between persisting the journal and the store snapshot, or vice versa) throws and the cycle cannot be recovered through this API at all. If the store holds nothing for the cycle (version 0), the constructor silently re-commits the journal's authorizations and receipts into a fresh store, meaning a lost store snapshot is rebuilt from a single cycle's journal while the nonce/receipt-identity registries of every other cycle are simply gone.

**Impact:** A crash at the wrong instant produces a cycle that is neither recoverable nor resolvable without hand-editing persisted files, and the cross-cycle exactly-once guarantees the whole journal design exists to provide depend entirely on the caller never losing the store snapshot.

**Smallest repair:** Make the store the single source of truth (fold journal entries into it, persisted in one transaction) and allow recovery when the supplied journal is a strict prefix or extension of the stored one by replaying only the tail through the transaction.

**Verifier reasoning:** Verifiers traced the constructor's exact-match-or-throw behavior for a non-empty store and the silent-rebuild behavior for an empty one directly in cycle-runner.mjs, confirming both failure modes as described.

---

### HK-068: No cross-cycle concurrency guard exists; the unresolved-mutation lock is scoped to one cycle only

**Location:** `packages/runner/src/cycle/reducer.mjs:321`
**Theme:** Autonomy / scheduling / persistence gaps
**Sources:** runner-cycle-a--autonomy-readiness#12

The only in-flight guard is state.externalMutations within a single reducer state instance. FixtureCycleStore accepts up to 16 cycles with no notion of an 'active cycle', and nothing prevents a scheduler from starting cycle N+1 while cycle N is still unresolved. Both cycles would bind the same fixture policy account and execution wallet, so their balance-isolation checks (single movement, zero opening balances -- see HK-024) would each fail against the other's activity, and worse, both cycles could end up broadcasting simultaneously.

**Impact:** A timer firing every 20 minutes while a previous cycle is stuck would start overlapping cycles that corrupt each other's activity-isolation accounting and could plausibly double-spend the shared policy account.

**Smallest repair:** Add a store-level lease/active-cycle record, checked in begin(), so a new cycle may start only when no other cycle in the store has an unresolved mutation or a stage earlier than 'closed'; an unmerged prior branch (codex/complete-v4-hook) already sketches this as an automation service.

**Verifier reasoning:** Verifiers confirmed FixtureCycleStore has no active-cycle concept and that the externalMutations lock lives entirely inside one reducer state object, so nothing in the codebase prevents two cycles from running concurrently.

---

### HK-070: Manifest bytes, entries, the approval, and the 1,024 proofs are never journaled or persisted anywhere

**Location:** `packages/runner/src/cycle/cycle-runner.mjs:313`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--autonomy-readiness#8

recordDistributionVerification journals only digests/root/source-ids, and preparePayoutFunding journals only the authorization; the canonical artifact itself -- manifest bytes, the approved entries, the approval signature, and every Merkle-sum proof -- exists only in the caller's in-memory process. After a restart between verification and holder payment, the proofs required for payEntitlement must be regenerated from inputs the journal simply does not contain; ADR-0014 itself already warns that a root alone cannot recreate proofs. The full manifest at 1,024 entries measures only 131,392 bytes, small enough to persist trivially.

**Impact:** A process restart between distribution verification and the (not-yet-implemented, HK-016/HK-029) payment step loses the only copy of the data needed to actually pay holders, even though the verified root and rootSum survive in the journal.

**Smallest repair:** Persist the compiled artifact (manifest bytes, entries, approval, proofs) alongside the verification receipt in the journal or a dedicated durable store, keyed by payoutId, before any payment automation is built on top of it.

**Verifier reasoning:** Verifiers confirmed by reading the journaled payload shapes in recordDistributionVerification and preparePayoutFunding that neither includes the manifest bytes or proofs, and cross-checked ADR-0014's own warning about root-only reconstruction.

---

### HK-071: payoutId, nonce and expiresAt for the vault payout authorization are free-form caller inputs with no deterministic derivation

**Location:** `packages/runner/test/integration/phase-one-local-loop-adapter.mjs:117`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--autonomy-readiness#9

Nothing in vault-payout-authorization.mjs or its callers derives payoutId, nonce or expiresAt from the cycle, the manifest digest, or a monotonic counter; they are simply whatever the caller supplies. Only the Foundry FFI adapter used by tests happens to pick consistent values.

**Impact:** Without a deterministic derivation rule, a production caller could accidentally reuse a payoutId/nonce across cycles (colliding with replay protections) or choose an expiresAt inconsistent with the cycle's own timing, and there is no code-level guard against either mistake.

**Smallest repair:** Derive payoutId deterministically from cycleId (and a chunk index once HK-034's chunking lands), derive nonce from a persisted monotonic counter scoped to the payout domain, and derive expiresAt from the cycle's own release evidence plus a configured window; validate all three against those derivations before signing.

**Verifier reasoning:** Verifiers confirmed by reading vault-payout-authorization.mjs that none of the three fields has a derivation function, only a range/format check, matching the claim that they are pure caller inputs.

---

### HK-072: Every snapshot holder must receive at least 1 atomic USDG and the entry set must exactly equal the full snapshot, so dust holders make small cycles undistributable

**Location:** `packages/runner/src/distribution/reconcile.mjs:303`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--security#4, runner-distribution--autonomy-readiness#2, runner-distribution--correctness#3

Entries must cover the snapshot holder set exactly (entries.length must equal snapshot length, with unique-recipient and balance-match checks) and each amountAtomicUSDG must be strictly positive. With 6-decimal USDG and the small per-cycle proceeds a single pack cycle realistically returns, any holder whose true pro-rata share floors to zero cannot be represented: padding them to 1 unit breaks exact pro-rata and the sum, while dropping them is rejected by the exact-length check, and the schema cannot even represent a holder whose computed share is legitimately zero -- the module cannot distinguish that from an incomplete snapshot.

**Impact:** Realistic community holder sets (any token with dust holders or airdrop recipients) cannot be distributed at all for small cycles; the automation would fail closed on every cycle once even one dust holder exists in the snapshot.

**Smallest repair:** Relax the entries-equal-snapshot rule to require entries be a subset of the snapshot (every entry recipient exists with a matching balance, recipients unique) while every holder with a positive computed share must be present; define explicitly that zero-share holders are omitted for that cycle, mirroring the Programmable fee policy's cumulative-remainder style if a longer-term fairness guarantee is wanted.

**Verifier reasoning:** Verifiers confirmed the exact-length equality check and the strictly-positive-amount check both exist in reconcile.mjs and that no zero-share representation or remainder-carry mechanism exists anywhere in the module, consistent across three lens reports on the same file.

---

## 2.4 Low (51)

### HK-073: Full-fill-or-revert makes any price-limit or thin-liquidity partial fill abort the whole swap

**Location:** `packages/contracts/src/market/CanonicalMarket.sol:225`
**Theme:** Single-router binding & swap execution
**Sources:** contracts-kernel--security#5, contracts-kernel--spec-conformance#9

The hook requires the pool to fully fill the specified amount; any sqrtPriceLimitX96 that causes a partial fill, or thin liquidity that cannot absorb the full size, reverts the entire swap rather than settling the partial amount and charging a proportional fee. This is stricter than the Programmable policy's executed-volume basis, which is defined per the amount actually executed, and the choice is undocumented in specs/requirements.json.

**Impact:** Traders using a price limit for slippage protection, or trading against thin liquidity, get an outright revert instead of a partial fill, which is worse UX than the policy anticipates but not a fund-safety issue.

**Smallest repair:** Either accept partial fills and charge the fee on the executed amount (matching the policy's stated basis) or explicitly document full-fill-or-revert as an approved Phase 1 simplification in specs/requirements.json.

**Verifier reasoning:** Verifiers confirmed the full-fill requirement in CanonicalMarket.sol and that no requirements document currently records it as an intentional deviation from the policy's executed-volume basis.

---

### HK-074 — **DISPUTED**: RobinhoodBindings pins REQUIREMENTS_REVISION 54 (and the hookData domain tag R54_A3) while the approved requirements revision is 56

**Location:** `packages/contracts/src/bindings/RobinhoodBindings.sol:16`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-kernel--spec-conformance#6

REQUIREMENTS_REVISION = 54 makes RobinhoodBindings.validate() reject any Binding tagged with the currently-approved revision 56, and the same stale R54_A3 tag appears in the hookData domain constant. Revisions 55/56 changed hook behavior (vault-only process release) that the R54 binding digest does not cover. The originating finding argued that nothing in the code or a decision record states the on-chain binding is allowed to lag the approved revision.

**Impact:** If accepted as a live defect: a production release binding requirementsRevision=56 per the PRD would revert against this hard-coded 54, so the constant would need reconciling before any release-binding artifact could deploy. If the dissent is correct, this is an already-planned, intentionally preserved historical snapshot and not a defect requiring code changes before launch.

**Smallest repair:** Either reconcile RobinhoodBindings.REQUIREMENTS_REVISION with the live revision (56) before any production release binding is produced, or, if the dissent's reading is endorsed by the owner, add an explicit one-line comment/decision record stating that this constant intentionally preserves the historical revision-54 provider-fact snapshot and is expected to remain 54.

**Verifier reasoning:** DISPUTED — one verifier pass found feasibility/integration-spikes.json and docs/modules/provider-binding.md already describe this exact decoupling as deliberate ('the historical revision-54 P1-001 manifest' retained on purpose), while the other pass treated the same evidence as insufficient to call the conflict fully documented; both agree the version mismatch itself and the resulting revert-on-56 behavior are real facts, they disagree only on whether it is already adequately decided.

---

### HK-075: Frozen minimum-receive and gas-cap fields are validated at authorization time but never enforced or forwarded to the route executor

**Location:** `packages/contracts/src/process/PegCycleVault.sol:136`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#7

FundingAuthorization carries minimum-receive and native-gas-cap fields that are checked for well-formedness when the authorization is created, but nothing in executeOutbound or the route-executor interface actually passes these values through or enforces them against the executor's real behavior.

**Impact:** The intended slippage/gas protections exist only on paper; a route executor could receive less than the nominal minimum or spend more gas than capped with no on-chain check catching it.

**Smallest repair:** Thread minimumReceive and the gas cap through to IPegCycleRouteExecutor's call and require the executor to report and be checked against both, once a real executor implementation exists (see HK-013).

**Verifier reasoning:** Verifiers confirmed the two fields are validated for shape at authorization time but never read again anywhere in executeOutbound or the executor interface.

---

### HK-076: Funding and payout authorizations share one global nonce space

**Location:** `packages/contracts/src/process/PegCycleVault.sol:249`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--correctness#8, contracts-process--security#7, contracts-process--spec-conformance#10

The vault consumes nonces for funding and payout authorizations from the same counter/mapping rather than separate domains, so a funding-authorization nonce and a payout-authorization nonce can collide in numbering even though they gate unrelated operations.

**Impact:** No direct fund-safety issue today since both are still checked for uniqueness, but it is a latent footgun for future extensions that reason about nonce ranges per authorization type, and it makes off-chain nonce bookkeeping harder to reason about.

**Smallest repair:** Split the nonce namespace into two independent counters/mappings, one for funding authorizations and one for payout authorizations.

**Verifier reasoning:** Verifiers confirmed a single shared nonce-consumption path is used for both authorization kinds by reading the relevant PegCycleVault functions.

---

### HK-077: Role-distinctness/identity checks are asymmetric across MoneyRoles, ProcessBudget and PegCycleVault constructors

**Location:** `packages/contracts/src/process/ProcessBudget.sol:43`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-process--correctness#9, contracts-process--security#9, contracts-process--spec-conformance#8

The three constructors that establish role identities (operations, authorizer, treasury, programmable, etc.) each implement their own subset of pairwise distinctness checks, so a role collision that is caught by one constructor may pass silently through another.

**Impact:** A misconfigured deployment could end up with two supposedly-distinct roles held by the same address in one contract while being correctly rejected in a sibling contract, which is confusing to operate and could mask a genuine misconfiguration.

**Smallest repair:** Factor the distinctness check into one shared internal helper used identically by all three constructors, and add a test enumerating every role pair for each contract.

**Verifier reasoning:** Verifiers compared the three constructors' validation logic directly and confirmed the sets of checked pairs differ.

---

### HK-078: Custody correctness depends on a strict 32-byte true-return requirement on USDG.transfer that is unverified against the production proxy

**Location:** `packages/contracts/src/process/PegCycleVault.sol:358`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-process--security#8, contracts-process--spec-conformance#9

The vault's USDG transfer helper requires exactly a 32-byte, true-decoding return value and reverts on anything else. This matches standard ERC-20 semantics, but no test or fork check in the repository confirms the actual deployed USDG UUPS proxy on Robinhood Chain returns exactly this shape rather than, say, no return data or a differently-encoded value.

**Impact:** If the production USDG proxy's transfer function ever returns something other than a clean 32-byte true, every vault transfer would revert, and this has not been verified against the real contract.

**Smallest repair:** Add a fork test against the actual deployed USDG proxy address that calls transfer and asserts the return data shape matches what PegCycleVault expects, before relying on this in production.

**Verifier reasoning:** Verifiers confirmed the strict 32-byte check exists in the vault's transfer helper and that no fork test against the real USDG proxy exists anywhere in the repository.

---

### HK-079: The funding-authorization digest is not retained per cycle, unlike the payout side

**Location:** `packages/contracts/src/process/ProcessBudget.sol:67`
**Theme:** PegCycleVault dead-end / absorbing states
**Sources:** contracts-process--spec-conformance#5

PegCycleVault retains the payout authorization digest per cycle for later inspection/reconciliation, but the equivalent funding-authorization digest is not similarly retained once consumed, creating an asymmetry between the two authorization types' auditability.

**Impact:** Reduces post-hoc auditability of which exact funding authorization was consumed for a given cycle; not a fund-safety issue.

**Smallest repair:** Retain the consumed funding-authorization digest per cycle in the same manner as the payout side, and expose it through a view function for reconciliation tooling.

**Verifier reasoning:** Verifiers compared the funding and payout authorization code paths and confirmed only the payout side retains its digest for later reference.

---

### HK-080: The docstring says "single-cycle" but the lifecycle intentionally loops for unlimited sequential cycles

**Location:** `packages/contracts/src/process/PegCycleVault.sol:17`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-process--spec-conformance#6, contracts-process--correctness#12, contracts-process--security#11

PegCycleVault's top-level docstring describes the contract as single-cycle, but the state machine (EMPTY -> ... -> PAYOUT_COMMITTED -> EMPTY) is explicitly designed to loop for sequential cycles, and both the code and other docs elsewhere in the repository confirm sequential cycling is intended.

**Impact:** Purely a documentation/maintainability issue; a reader relying on the docstring alone would misunderstand the contract's intended lifecycle.

**Smallest repair:** Update the docstring to describe the sequential-cycle design accurately, cross-referencing docs/modules/peg-cycle-vault.md.

**Verifier reasoning:** Verifiers compared the docstring text against the actual state-transition graph and confirmed the loop back to EMPTY is real and intentional, not an accident of the code.

---

### HK-081: Superseded revision-55 payout-funding helper functions remain as dead code in MoneyRoles, alongside a dead wrapper used only by the test harness

**Location:** `packages/contracts/src/access/MoneyRoles.sol:166`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-process--spec-conformance#7, contracts-process--security#10, contracts-process--correctness#11

MoneyRoles retains helper functions from the superseded revision-55 payout-funding design that are no longer called by any production path, and a separate _bindCycleOperations wrapper exists only to support the test harness rather than any real caller.

**Impact:** No functional impact, but the dead code increases the audited surface of an immutable contract and risks confusing future maintainers about which helpers are load-bearing.

**Smallest repair:** Remove the superseded revision-55 helpers and the test-only _bindCycleOperations wrapper from the production contract, or move the latter into a test-only harness contract that inherits from MoneyRoles.

**Verifier reasoning:** Verifiers confirmed by grep that the cited helper functions have no production call sites, only test references.

---

### HK-082: verify() reverts with SumOverflow instead of returning false on an overflowing proof

**Location:** `packages/contracts/src/payout/CanonicalMerkleSum.sol:116`
**Theme:** Holder payout & distribution pipeline
**Sources:** contracts-payout--correctness#5

CanonicalMerkleSum.verify() is documented/expected to return a boolean success indicator, but a proof whose sums overflow during folding causes the function to revert with SumOverflow rather than returning false, breaking the pure-view boolean contract callers may expect.

**Impact:** A caller that wraps verify() expecting either true or false (rather than a possible revert) would need a try/catch to handle this case safely; not a fund-safety issue but a surprising API contract violation.

**Smallest repair:** Either document verify() as revert-on-overflow explicitly, or catch the overflow internally and return false instead, matching the boolean-return contract implied by its name and callers.

**Verifier reasoning:** Verifiers confirmed the SumOverflow revert path exists inside verify()'s folding loop and that no caller currently wraps it in a try/catch.

---

### HK-083: The canonical test vector and its Solidity anchor use chainId 466, not Robinhood Chain 4663

**Location:** `packages/contracts/tooling/payout/canonical-merkle-sum.mjs:337`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-payout--correctness#6, contracts-payout--security#7, contracts-payout--spec-conformance#7

The canonical Merkle-sum test vector (used both in JS tooling and as the Solidity anchor) is domain-bound to chainId 466, while the actual target deployment is Robinhood Chain 4663; the JS/Solidity parity itself is independently verified correct, only the chosen chainId in the fixture is wrong for the real chain.

**Impact:** No functional defect in the verification logic, but the canonical vector does not double as a Robinhood-chain regression fixture, and could mislead a reviewer into thinking chain-id binding has been exercised against the real chain.

**Smallest repair:** Add a second canonical vector domain-bound to chainId 4663 (or update the existing one), and regenerate the Solidity anchor to match, once the real hook address is known.

**Verifier reasoning:** Verifiers confirmed the chainId literal used across the JS tooling, its Solidity anchor, and the payout test-vectors JSON file all read 466 rather than 4663.

---

### HK-084: The JS verifyProof implementation compares root sums by string identity rather than numeric/BigInt equality

**Location:** `packages/contracts/tooling/payout/canonical-merkle-sum.mjs:263`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-payout--correctness#7

verifyProof's final comparison of the computed root sum against the expected sum uses string equality on their decimal-string representations rather than comparing them as BigInts, which happens to work for canonically-formatted decimal strings but is a fragile pattern.

**Impact:** Low risk in practice since both sides are produced by the same formatting path, but a future change that introduces leading zeros, different radix, or whitespace on either side would silently break comparisons that should have matched.

**Smallest repair:** Compare as BigInt values (BigInt(a) === BigInt(b)) rather than as strings.

**Verifier reasoning:** Verifiers confirmed the comparison operator and operand types directly in the JS source.

---

### HK-085: A local forge run recorded the repository's one end-to-end payout test as failing

**Location:** `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol:71`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-payout--security#4

Running the local test suite as part of this audit produced a failing result for the single end-to-end payout integration test in this file, indicating either an environment-specific issue or a genuine regression not caught by whatever CI configuration currently runs.

**Impact:** If genuine, this is a currently-broken end-to-end payout path; at minimum it means the test as currently written is not reliably green in a clean environment.

**Smallest repair:** Reproduce the failure in a clean environment, determine whether it is an environment/toolchain issue (e.g. missing --ffi, stale solc) or a real regression, and fix the underlying cause; add this test to a gate that would have caught it (see HK-017).

**Verifier reasoning:** Verifiers reproduced the failure by actually running the local forge test suite rather than inferring it from source alone.

---

### HK-086: Canonical manifest validation does not enforce unique recipients, although the PRD requires it

**Location:** `packages/contracts/src/payout/CanonicalMerkleSum.sol:162`
**Theme:** Holder payout & distribution pipeline
**Sources:** contracts-payout--security#5

The on-chain canonical validation path checks structural well-formedness of manifest entries but does not reject a manifest containing the same recipient address at two different leaf indices, even though the PRD states recipients must be unique per manifest.

**Impact:** A malformed or malicious manifest could pay one recipient at multiple leaf indices (each individually valid), which is not itself a fund-safety issue since the sum is still bound by rootSum, but it violates the documented uniqueness invariant and could complicate off-chain accounting.

**Smallest repair:** Add a uniqueness check for recipient addresses to the on-chain (or at minimum the off-chain manifest-compilation) validation path, matching the PRD's stated requirement.

**Verifier reasoning:** Verifiers confirmed the on-chain validation function's checks and compared them against the PRD's explicit uniqueness requirement, finding no corresponding check.

---

### HK-087: The hardcoded 1024 recipient/leaf cap in HolderSettlement duplicates CanonicalMerkleSum.TREE_WIDTH instead of referencing it

**Location:** `packages/contracts/src/settlement/HolderSettlement.sol:78`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-payout--spec-conformance#3, contracts-payout--correctness#10

HolderSettlement.sol hardcodes the literal 1024 in at least one place rather than referencing CanonicalMerkleSum.TREE_WIDTH, so the two values could drift apart if one is ever changed without the other (see also HK-014/HK-034 for the underlying cap itself).

**Impact:** Low risk today since both values currently agree, but a future change to TREE_WIDTH (e.g. as part of fixing HK-014) that misses this duplicate literal would silently reintroduce an inconsistency.

**Smallest repair:** Replace the hardcoded 1024 in HolderSettlement.sol with a reference to CanonicalMerkleSum.TREE_WIDTH.

**Verifier reasoning:** Verifiers confirmed the literal 1024 appears in HolderSettlement.sol independently of the TREE_WIDTH constant definition.

---

### HK-088: verify() re-implements the proof-fold loop instead of calling the existing rootFromProof helper, which is otherwise unused in production

**Location:** `packages/contracts/src/payout/CanonicalMerkleSum.sol:153`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-payout--spec-conformance#4, contracts-payout--correctness#11

CanonicalMerkleSum has a rootFromProof helper that folds a proof up to a root, but verify() duplicates the same fold logic inline instead of calling it, leaving rootFromProof unused by any production caller and creating two implementations of the same algorithm that could drift.

**Impact:** Purely a maintainability duplication; a future bug fix applied to only one of the two implementations would silently leave the other one wrong.

**Smallest repair:** Have verify() call rootFromProof internally instead of duplicating its logic, or remove rootFromProof if it is intentionally kept separate for gas reasons and document why.

**Verifier reasoning:** Verifiers compared the two functions' logic directly and confirmed they implement the same fold algorithm independently.

---

### HK-089: The holder-settlement module card's operational command references a machine-local solc path

**Location:** `docs/modules/holder-settlement.md:38`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-payout--spec-conformance#10

The documented command for running the settlement module's tests/verification includes a solc binary path specific to one machine's local toolchain setup rather than a portable, environment-independent invocation.

**Impact:** A new contributor or CI runner following the documented command verbatim on a different machine would get a path-not-found error rather than a working command.

**Smallest repair:** Update the documented command to use a portable solc resolution (e.g. via foundry's own toolchain management or a relative/PATH-based reference) rather than a hardcoded local path.

**Verifier reasoning:** Verifiers confirmed the documented command string contains a machine-specific absolute path by reading the module card directly.

---

### HK-090: The one-shot issuance "prepare" step has no cancel path; a wrong frozen plan permanently strands the immutable hook

**Location:** `packages/contracts/src/launch/HookemonIssuance.sol:109`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--correctness#4

Once an issuance plan is prepared, the guard state is one-shot (GuardAlreadyVerified reverts any second attempt) with no cancel/reset function. If the plan is prepared with wrong values before the launchpad path is finalized, there is no way to correct it short of redeploying the hook.

**Impact:** An operational mistake during launch preparation (before any real token or liquidity exists) becomes permanent and forces a full hook redeploy rather than a simple correction.

**Smallest repair:** Add an authorizer-gated cancelPrepare()/re-prepare path usable only before verifyIssuance has succeeded, so an operational mistake in the prepare step does not require a full redeploy.

**Verifier reasoning:** Verifiers confirmed the one-shot nature of the prepare/verify guard state and that no cancel function exists anywhere in HookemonIssuance.sol.

---

### HK-091: The vendored liquidity-launcher and uerc20-factory submodules are pinned and remapped but cannot actually be imported or compiled under the repo's current remappings

**Location:** `packages/contracts/remappings.txt:3`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--correctness#5, contracts-launch--spec-conformance#4

Both submodules are pinned in .gitmodules and given remappings.txt entries, but attempting to import them under the repo's current dependency pins fails to compile, because their own transitive dependency pins differ from the repo's. This compounds the fact that they are unused by any Solidity source (HK-005).

**Impact:** Even if a launch adapter were written today to consume these submodules (per HK-005's repair), it would not compile without first resolving the transitive dependency mismatch.

**Smallest repair:** Either resolve the transitive dependency pin mismatch (align the submodules' own lib/ dependencies with the repo's), or drop the unused submodule pins until a launch adapter is actually being written, to avoid carrying broken vendored code.

**Verifier reasoning:** Verifiers attempted to trace an import of the vendored submodules under the repo's actual remappings and confirmed the transitive pin mismatch would break compilation.

---

### HK-092: v4-periphery is pinned at a branch-tip commit with a mismatched nested v4-core gitlink, rather than a release tag

**Location:** `.gitmodules:4`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-launch--security#4, contracts-launch--spec-conformance#11

The v4-periphery submodule is pinned to a specific commit on a development branch rather than a tagged release, and its own nested v4-core gitlink points to a different v4-core commit than the one the repo itself pins at the top level.

**Impact:** Branch-tip pins can move or be force-pushed upstream, and the nested version mismatch means the periphery code was not necessarily tested against the exact v4-core version this repo actually uses, both of which are supply-chain/reproducibility risks rather than active defects.

**Smallest repair:** Pin v4-periphery to a tagged release once one exists that matches the repo's v4-core version, or explicitly document why a branch-tip pin is currently necessary and track the resulting risk.

**Verifier reasoning:** Verifiers confirmed both the branch-tip nature of the v4-periphery pin and the nested v4-core gitlink mismatch by inspecting .gitmodules and the submodule's own git metadata.

---

### HK-093: The build leaves CBOR metadata hashing at Solidity compiler defaults

**Location:** `packages/contracts/foundry.toml:8`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-launch--security#5

foundry.toml does not disable or configure the compiler's CBOR metadata hash embedding, leaving default behavior in place; this is a minor reproducibility/bytecode-size consideration rather than a functional issue.

**Impact:** Slightly larger deployed bytecode and metadata-hash-dependent build reproducibility, relevant mainly if exact bytecode matching against a reference build is ever required.

**Smallest repair:** Consider setting bytecodeHash = 'none' (or 'ipfs' consistently) in foundry.toml's [profile.default] if exact reproducible builds or minimal bytecode size are goals, especially given HK-097's EIP-170 size headroom concern.

**Verifier reasoning:** Verifiers confirmed foundry.toml contains no explicit bytecodeHash setting, leaving the compiler default active.

---

### HK-094: The issuance guard adds a third privileged identity and post-deployment mutable state to an otherwise immutable hook

**Location:** `packages/contracts/script/release/PhaseOneReleasePlan.sol:15`
**Theme:** Launch / token-issuance path missing
**Sources:** contracts-launch--spec-conformance#7

Beyond the vault authorizer and the operations trigger, HookemonIssuance introduces a third privileged 'issuance authority' role plus post-deployment mutable state (the guard's prepared/verified status), which is a meaningful addition to the immutable hook's trusted-party surface that is easy to overlook when reasoning about 'who can affect this contract'.

**Impact:** Increases the set of keys/identities whose compromise or misuse could affect the hook's public issuance record (though, per HK-050, that record currently gates no money path), and is a design surface that should be explicitly weighed against the project's stated minimal-trusted-parties goal.

**Smallest repair:** Document the issuance authority's exact powers and blast radius alongside the vault authorizer and operations trigger in the trust-model documentation, and consider whether it should be time-limited or revocable given it acts only pre-launch.

**Verifier reasoning:** Verifiers confirmed the issuance authority is a distinct, separately-checked identity from the other two privileged roles and that it introduces genuinely new mutable state to the hook.

---

### HK-095: The custody invariant targets a MockPositionManager whose selectors do not exist on the real v4 PositionManager

**Location:** `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol:499`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#9

The invariant suite's custody handler calls selectors on a mock position-manager contract that do not correspond to any function on the real v4-periphery PositionManager, meaning the invariant is only ever exercised against a fictional interface.

**Impact:** A regression in how PermanentPositionCustody actually interacts with the real PositionManager would not be caught by this invariant, since the mock's interface diverges from reality.

**Smallest repair:** Replace MockPositionManager with the real v4-periphery PositionManager (or a faithful wrapper of its actual selectors) in the invariant handler.

**Verifier reasoning:** Verifiers compared MockPositionManager's selector set against the real v4-periphery PositionManager ABI and confirmed a mismatch.

---

### HK-096: Invariant handlers swallow claim failures, making a claim-liveness regression undetectable by the gated fuzz suites

**Location:** `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol:382`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#10

The invariant fuzz handlers that call claim functions catch and discard any revert rather than tracking claim failures as an invariant violation, so a regression that makes claims permanently revert (e.g. accidentally reintroducing HK-040's destination bug in a stricter form) would not surface as a failing invariant.

**Impact:** The invariant suite's coverage of claim liveness is silently weaker than it appears; a real regression that breaks claiming entirely could ship undetected by this suite.

**Smallest repair:** Have the invariant handlers record claim attempts and failures, and add an invariant asserting that a claim which should succeed (nonzero liability, valid destination) does not revert.

**Verifier reasoning:** Verifiers confirmed the handler code wraps claim calls in a try/catch (or equivalent) that discards the failure rather than recording it.

---

### HK-097: The fee-split fuzz test's oracle duplicates the implementation formula, making it tautological

**Location:** `packages/contracts/test/accounting/FeeAccounting.t.sol:607`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#11

testFuzz_revision55SplitConservesTotal computes its 'expected' split using the exact same floor-division formula that _splitLiability itself uses, rather than an independently-derived reference calculation, so the fuzz test can only ever confirm the implementation agrees with itself.

**Impact:** This fuzz test provides no defense against a shared formula bug (e.g. the very policy non-conformance described in HK-008), since both the implementation and its 'oracle' would be wrong in the same way simultaneously.

**Smallest repair:** Rewrite the fuzz oracle using an independently-reasoned reference implementation (e.g. computed via a different arithmetic path or against the policy document's own worked examples) rather than mirroring _splitLiability's exact formula.

**Verifier reasoning:** Verifiers compared the fuzz test's expected-value calculation against _splitLiability's implementation and confirmed they are the same formula, not an independent check.

---

### HK-098: requirementsRevision is hardcoded to 56 in two gated test suites while the bindings library pins revision 54, and no test cross-checks the two

**Location:** `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol:685`
**Theme:** Code hygiene, dead code, duplication
**Sources:** contracts-tests-a--test-coverage-gaps#12

Two gated invariant/integration suites hardcode requirementsRevision 56 in their own fixtures, independent of RobinhoodBindings.REQUIREMENTS_REVISION (54, see HK-074); no test anywhere asserts these two values are consistent with each other or with specs/requirements.json's stated approved revision.

**Impact:** The test suite's own internal revision constants can silently drift from the production binding constant with no automated check catching it, compounding the ambiguity already flagged in HK-074.

**Smallest repair:** Add a single test that imports RobinhoodBindings.REQUIREMENTS_REVISION and asserts it against specs/requirements.json's revision field (whatever the resolved answer to HK-074 turns out to be), and have the two gated suites reference that same constant instead of a separate hardcoded literal.

**Verifier reasoning:** Verifiers confirmed both gated suites hardcode 56 independently of RobinhoodBindings.REQUIREMENTS_REVISION and that no test compares the two.

---

### HK-099: PhaseOneLocalLoop requires --ffi that foundry.toml does not enable, and one documented command runs it without --ffi

**Location:** `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol:204`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-a--test-coverage-gaps#13

The local-loop integration test relies on Foundry's FFI cheatcode, but foundry.toml does not set ffi = true by default, and at least one documented command in the repo's task files invokes the test without passing --ffi, which will fail or silently skip FFI-dependent behavior.

**Impact:** A contributor following the documented command as written would get a confusing failure (or a false pass if the FFI-gated assertions are skippable) rather than a clear signal that FFI needs to be enabled.

**Smallest repair:** Either set ffi = true in the relevant foundry.toml profile used for this test, or update every documented command to consistently pass --ffi, and make the test fail loudly (not silently skip) when FFI is unavailable.

**Verifier reasoning:** Verifiers confirmed the test's reliance on FFI cheatcodes and cross-checked the documented commands in tasks/*.md against foundry.toml's ffi setting.

---

### HK-100: Roughly 52 test_ functions across two abstract blind suites never execute, yet TEST_MATRIX.md still cites them as coverage

**Location:** `packages/contracts/test/blind/market-fees/BlindMarketFeesAcceptance.t.sol:28`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#6

Two abstract blind-test suites (mirroring the pattern already confirmed for FixedSupplyBlindSpec in HK-051) define around 52 test_ functions with no concrete, non-disabled binding subclass, so none of them ever actually runs; TEST_MATRIX.md nonetheless lists these tests as part of the project's coverage.

**Impact:** The documented test matrix overstates actual coverage by roughly 52 test cases, which could lead a reviewer to believe more of the fee-accounting/market behavior is under test than actually is.

**Smallest repair:** Either bind the abstract suites to concrete local fixtures so they actually execute (as recommended for HK-051), or update TEST_MATRIX.md to clearly mark these as unbound/not-currently-executing.

**Verifier reasoning:** Verifiers confirmed by compiling/searching for concrete, non-disabled subclasses of both abstract suites and found none, then cross-checked TEST_MATRIX.md's claims against that finding.

---

### HK-101: CanonicalMerkleSum entry-validation and proof-index branches listed as required mutations are untested on-chain

**Location:** `packages/contracts/test/payout/CanonicalMerkleSum.t.sol:64`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#7

The module's own mutation-testing checklist lists specific entry-validation and proof-index branches as required to be covered, but no on-chain (Solidity) test currently exercises several of these branches; only off-chain JS tests may cover the equivalent logic.

**Impact:** A regression in these specific on-chain validation branches could pass the Solidity test suite even though the equivalent JS logic is tested, since the two implementations are tested asymmetrically.

**Smallest repair:** Add the missing on-chain Solidity test cases for each listed branch to bring Solidity coverage in line with the module's own mutation-testing checklist.

**Verifier reasoning:** Verifiers compared the module's documented required-mutation checklist against the actual Solidity test file's coverage and confirmed specific listed branches have no corresponding on-chain test.

---

### HK-102: Reentrancy tests cannot distinguish the reentrancy guard from any other nested-call failure

**Location:** `packages/contracts/test/process/PegCycleVault.t.sol:253`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#8

The vault's reentrancy tests assert only that a nested call reverts, without asserting the specific Reentrancy() error selector, so a test that passes today could equally be passing because of an unrelated failure earlier in the nested call rather than because the reentrancy guard actually fired.

**Impact:** If the reentrancy guard were accidentally removed or broken, but the nested call happened to revert for some other reason (e.g. an unrelated require), these tests would still pass, giving false confidence in reentrancy protection.

**Smallest repair:** Assert the specific Reentrancy() revert selector (or equivalent custom error) in each reentrancy test, and add a positive control that would fail without the guard.

**Verifier reasoning:** Verifiers read the reentrancy test assertions and confirmed they check only for 'reverted', not for the specific guard-related error.

---

### HK-103: Rejection-chain tests assert only 'reverted' with no selector check and no closing positive control

**Location:** `packages/contracts/test/process/PegCycleVault.t.sol:102`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#9

Several tests that assert a sequence of invalid calls all revert check only that a revert occurred, not which specific custom error was raised, and the chain of assertions has no final positive-control step proving the valid version of the same call actually succeeds.

**Impact:** These tests would still pass if the wrong validation check were firing (or if an unrelated bug caused an unintended revert), masking a mismatch between the intended and actual rejection reason.

**Smallest repair:** Assert the specific expected custom-error selector for each rejection case, and add a closing positive-control assertion that the corresponding valid call succeeds.

**Verifier reasoning:** Verifiers read the cited test functions and confirmed the revert assertions do not check error selectors and that no positive control follows the rejection chain.

---

### HK-104: HolderSettlement guard branches and the manifest-to-digest link are not exercised through actual settlement calls

**Location:** `packages/contracts/test/settlement/HolderSettlement.t.sol:271`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#10

Several of HolderSettlement's internal guard branches (and the link between a manifest's bytes and its digest) are exercised only in isolation (e.g. unit tests of the digest function alone) rather than through an end-to-end call into payEntitlement/settlement that would prove the branches interact correctly together.

**Impact:** A regression in how these branches compose during an actual settlement call could pass the existing isolated tests while breaking real settlement.

**Smallest repair:** Add integration-style tests that exercise the guard branches and the manifest->digest link together through actual payEntitlement calls, not only in isolation.

**Verifier reasoning:** Verifiers compared the isolated unit tests against the actual settlement call paths and confirmed no test currently exercises the combination end to end.

---

### HK-105: The quadrant fee test mirrors the library's own formula and asserts a hardcoded field; partial-fill is covered in only one of the four quadrants

**Location:** `packages/contracts/test/bindings/RobinhoodBindings.t.sol:176`
**Theme:** Test-gate coverage gaps (CI does not enforce invariants)
**Sources:** contracts-tests-b--test-coverage-gaps#11

RobinhoodBindings.t.sol's quadrant fee test computes its expected value using the same formula RobinhoodBindings.validateQuadrant itself uses (a tautology similar to HK-097), asserts against a hardcoded field rather than a derived one, and exercises a partial-fill scenario in only one of the four fee quadrants rather than all four.

**Impact:** Weak defense against a shared formula regression (same class of gap as HK-097), and a partial-fill bug specific to one of the other three quadrants would not be caught by this suite.

**Smallest repair:** Use an independently-derived expected value rather than mirroring the library formula, and extend the partial-fill scenario to cover all four quadrants.

**Verifier reasoning:** Verifiers compared the test's expected-value computation against the library's own implementation and confirmed they share the same formula, and counted the partial-fill scenarios present per quadrant.

---

### HK-106: A second, distinct provider receipt for the same action is accepted, making the cycle permanently unclosable

**Location:** `packages/runner/src/cycle/reducer.mjs:841`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--correctness#6

The reducer's receipt-acceptance logic allows a second provider receipt for an action that already has one, as long as it is itself individually valid, rather than rejecting it outright or requiring it to match the first; if the two receipts genuinely disagree, downstream logic that expects exactly one authoritative receipt per action has no way to resolve the conflict and the cycle cannot progress.

**Impact:** A duplicate or conflicting receipt (whether from a provider bug, a retried request that returns a different response, or a malicious actor) can silently wedge a cycle that would otherwise have closed cleanly.

**Smallest repair:** Reject a second receipt for an action that already has one recorded (or require byte-for-byte equality with the first before accepting it as a no-op duplicate), and add a test for the conflicting-receipt case.

**Verifier reasoning:** Verifiers confirmed the acceptance logic does not check for an already-recorded receipt before accepting a second one for the same action.

---

### HK-107: CycleJournal.prepareIntent is dead code that bypasses the store's CAS and emits an event kind the reducer rejects

**Location:** `packages/runner/src/cycle/journal.mjs:214`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-a--correctness#7, runner-cycle-a--security#7, runner-cycle-a--autonomy-readiness#13

prepareIntent is an exported function that writes directly to the journal, bypassing the store's compare-and-swap concurrency protection, and emits an event kind that the reducer's switch statement does not actually accept; append/appendEvent similarly bypass the store and reducer entirely. No production caller uses any of these three functions.

**Impact:** No functional impact today since nothing calls them, but they are exported, discoverable dead code that could be mistakenly used by a future caller who would then bypass the store's core safety guarantees (CAS, reducer validation) without any error signaling why.

**Smallest repair:** Remove prepareIntent, append and appendEvent from the module's exports (or delete them entirely) unless they serve a documented purpose, in which case fix them to route through the store's CAS and an event kind the reducer actually accepts.

**Verifier reasoning:** Verifiers confirmed by grep that these three exports have no production call sites, and confirmed prepareIntent's emitted event kind is absent from the reducer's accepted-kinds switch.

---

### HK-108: Two different "version" counters share the same name but count different things

**Location:** `packages/runner/src/cycle/reducer.mjs:988`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-a--correctness#8, runner-cycle-a--security#9

The reducer's state.version counts stage transitions, while the store's version counts total journal entries appended; both are called 'version' in their respective APIs, which is a naming collision that invites confusion (e.g. comparing the two directly, or assuming they advance in lockstep) even though they are semantically unrelated.

**Impact:** Purely a naming/maintainability hazard; a future caller who conflates the two version numbers could make an incorrect assumption about cycle progress or store state.

**Smallest repair:** Rename one of the two fields (e.g. store's to journalEntryCount or similar) to remove the naming collision and make the distinction obvious at every call site.

**Verifier reasoning:** Verifiers confirmed both fields are literally named 'version' but are incremented by different code paths counting different events, by reading the reducer and store implementations directly.

---

### HK-109: Non-canonical base64url signature encodings are accepted across several verifiers, giving one logical signature multiple valid digests

**Location:** `packages/runner/src/cycle/schemas.mjs:270`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-a--security#6, runner-cycle-b--security#1, runner-distribution--security#5, runner-cycle-b--correctness#9

Several signature-parsing regexes (provider/approval signatures in schemas.mjs, accounting/preflight signatures in execution-accounting.mjs, and distribution signatures in manifest.mjs) accept non-canonical base64url variants (extra padding, alternate alphabet characters, embedded whitespace) rather than requiring strict canonical encoding, so the same logical signature bytes can be represented by more than one accepted string, each hashing/digesting differently downstream.

**Impact:** Anywhere a signature string (rather than its decoded bytes) is used as part of a digest or a deduplication key, non-canonical encodings could let a semantically-identical signature slip past a duplicate-detection check, or produce two different receipt/record digests for what should be the same evidence.

**Smallest repair:** Tighten every signature-parsing regex across schemas.mjs, execution-accounting.mjs and manifest.mjs to require strict canonical base64url (no padding, standard alphabet only, no whitespace), and add a test asserting a non-canonical variant of a valid signature is rejected.

**Verifier reasoning:** Verifiers confirmed the lenient regex patterns accept non-canonical variants by testing them directly against crafted non-canonical but validly-decoding base64url strings, consistent across three separate files in two different lens reports.

---

### HK-110: Exported assertVerifiedOwnerApproval / assertVerifiedPostOpenBuybackApproval perform no signature verification despite their names

**Location:** `packages/runner/src/cycle/schemas.mjs:195`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-a--security#8

These two exported functions are named as if they cryptographically verify a signature, but their actual implementation only checks the shape/presence of an approval object, not any signature over it; the real signature verification happens elsewhere in the call chain, making these function names actively misleading about what they check.

**Impact:** A future caller who uses these functions directly, trusting their names, could believe they are getting cryptographic verification when they are only getting a shape check, which could be a security-relevant misunderstanding in new code.

**Smallest repair:** Either rename these functions to reflect that they only validate shape (e.g. assertOwnerApprovalShape), or move the actual signature check into them so the names are accurate.

**Verifier reasoning:** Verifiers read the implementation of both functions directly and confirmed neither calls any signature-verification primitive.

---

### HK-111: Method names imply network execution but the runner performs no I/O; the Collector generate response is entirely self-fabricated

**Location:** `packages/runner/src/cycle/cycle-runner.mjs:121`
**Theme:** Fixture-only runner (no production integration)
**Sources:** runner-cycle-a--autonomy-readiness#14

Methods like generateCollectorPack read as if they call out to a network service, but CycleRunner actually synthesizes the 'provider response' locally in-process; there is no HTTP client anywhere in the module, and this self-fabrication is what feeds the self-attested reconciliation described in HK-006.

**Impact:** Primarily a naming/expectations issue that compounds HK-006: a reader of the API surface alone (without reading the implementation) would reasonably but incorrectly assume real network calls are being made.

**Smallest repair:** Rename these methods to make their fixture/simulation nature explicit (e.g. simulateCollectorGeneratePack) until the real provider adapter from HK-006's repair exists, at which point the names can describe real I/O.

**Verifier reasoning:** Verifiers confirmed by reading generateCollectorPack's implementation that it constructs the response object locally with no outbound network call.

---

### HK-112: The Collector authorization expiry clock is a private copy of the frozen validation-timestamp constant, duplicated instead of imported

**Location:** `packages/runner/src/cycle/collector.mjs:13`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--correctness#0, runner-cycle-b--security#7

collector.mjs defines its own private copy of the same frozen '2029-01-01' timestamp constant used elsewhere (HK-063) rather than importing the single shared constant, so a future fix to the shared constant (e.g. replacing it with a real clock) could miss this duplicate and leave Collector-specific expiry checks silently still frozen.

**Impact:** Increases the risk that fixing HK-063 in one place misses this duplicated copy, leaving an inconsistency between Collector-authorization expiry and every other authorization's expiry after a partial fix.

**Smallest repair:** Import the shared FIXTURE_AUTHORIZATION_VALIDATED_AT constant (or its eventual real-clock replacement) from its single source of truth instead of redefining it locally in collector.mjs.

**Verifier reasoning:** Verifiers confirmed collector.mjs redefines the same literal timestamp string as a separate local constant rather than importing the shared one.

---

### HK-113: verifyDecodedTransaction returns an undomained digest that no consumer uses and that mismatches the canonical messageDigest

**Location:** `packages/runner/src/cycle/decoder.mjs:121`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--correctness#1

verifyDecodedTransaction computes and returns a digest value that is not domain-separated the same way the canonical messageDigest is, and no downstream consumer in the codebase actually reads this returned digest, making it dead output that also happens to be inconsistent with the canonical digest format if anyone ever did start using it.

**Impact:** Purely latent: no current consumer, so no functional impact today, but a future caller who starts using this returned digest expecting it to match the canonical messageDigest format would get silently wrong results.

**Smallest repair:** Either remove the unused, inconsistent digest from the return value, or fix it to use the same domain-separation scheme as the canonical messageDigest so it is safe to consume later.

**Verifier reasoning:** Verifiers confirmed by grep that no caller reads this specific return field, and compared its construction against the canonical messageDigest's domain-separation scheme to confirm the mismatch.

---

### HK-114: AuthorizationLedger.consume and FixtureReceiptRegistry are unused, exported modules with weaker semantics than the production store's equivalents

**Location:** `packages/runner/src/cycle/authorization.mjs:77`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--correctness#2, runner-cycle-b--correctness#3, runner-cycle-b--security#5

AuthorizationLedger.consume verifies a signature but never checks expiry or nonce (unlike the production authorization-consumption path), and FixtureReceiptRegistry duplicates the cycle-store's own receipt registry with divergent duplicate-staging semantics. Neither module is called by CycleRunner or the reducer; they exist as separate, exported, unused implementations alongside the real ones.

**Impact:** No functional impact today since nothing calls them, but they are discoverable exported APIs that look production-ready and could be mistakenly adopted by a future caller who would then get weaker guarantees (no expiry/nonce check, divergent duplicate handling) than the actual production path provides.

**Smallest repair:** Remove both unused modules, or clearly mark them test-only and move them under packages/runner/test, and if any of their functionality is actually needed, port it into the production authorization/receipt-registry path instead of maintaining a parallel weaker implementation.

**Verifier reasoning:** Verifiers confirmed by grep that neither AuthorizationLedger nor FixtureReceiptRegistry has a call site in CycleRunner or the reducer, and compared their logic against the production equivalents to confirm the semantic gaps.

---

### HK-115: A production source file (verify-fixtures.mjs) depends on a test helper and executes a full cycle at import time, and is itself executed by the CI gate

**Location:** `packages/runner/src/cycle/verify-fixtures.mjs:5`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--correctness#5, runner-cycle-b--security#8, runner-cycle-b--autonomy-readiness#12, runner-cycle-b--correctness#14

verify-fixtures.mjs, which lives under packages/runner/src (production source, not test/), imports test/cycle/fixture-cycle.mjs and runs a complete fixture cycle as a side effect of being imported; this same file is also the one invoked by the CI gate, and its own test (verify-fixtures.test.mjs) only works when the process's current working directory is the repository root.

**Impact:** A production source directory containing a file that depends on test-only code and executes side effects at import time is a layering violation that could break unexpectedly if test/ is ever excluded from a production build or package, and the cwd-dependent test is fragile in CI configurations that run from a different directory.

**Smallest repair:** Move verify-fixtures.mjs (or the parts of it that depend on test/cycle/fixture-cycle.mjs) out of src/ and into test/ or scripts/, since it is fundamentally a test/verification utility, not production runner code; make its own test independent of the invoking cwd.

**Verifier reasoning:** Verifiers confirmed the import statement pulling in the test-only fixture-cycle.mjs from within packages/runner/src, and confirmed the CI workflow invokes this exact file.

---

### HK-116: assertExpiry throws an unlabeled RangeError for an unparseable expiry string instead of a clear, typed validation error

**Location:** `packages/runner/src/cycle/collector.mjs:24`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--correctness#6

When assertExpiry is given a string that Date.parse cannot parse, it throws whatever generic RangeError results from the downstream arithmetic rather than a clear, labeled validation error identifying which field failed and why.

**Impact:** Purely a debuggability/error-quality issue: an operator or developer hitting a malformed expiry value gets a confusing generic error rather than actionable information.

**Smallest repair:** Validate the expiry string's parseability explicitly and throw a clear, labeled error (e.g. InvalidExpiryFormat) identifying the offending field and value before attempting arithmetic on it.

**Verifier reasoning:** Verifiers reproduced the unparseable-string case and confirmed the resulting error is an unlabeled, generic RangeError rather than a purpose-built validation error.

---

### HK-117: validateBinding lacks plain-object and property-accessor guards, re-reads fields after validation, and builds one of its regexes in an obfuscated way

**Location:** `packages/runner/src/cycle/bindings.mjs:22`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--security#2, runner-cycle-b--correctness#8, runner-cycle-b--security#3, runner-cycle-b--autonomy-readiness#11, runner-cycle-b--autonomy-readiness#13

validateBinding does not guard against a non-plain-object input (e.g. one with getter accessors) before validating it, and re-reads some fields from the input object after validation rather than from the validated snapshot, which means a malicious or buggy object with side-effecting getters could return a value on the second read that differs from what was validated on the first; separately, one regex in the same file is constructed via new RegExp(...) plus String.fromCharCode(36) instead of a normal literal, for no apparent reason, making it needlessly hard to audit.

**Impact:** The accessor re-read pattern means validateBinding could, in principle, return an object that fails its own validation if a caller passes an adversarially-constructed input with side-effecting getters; low real-world risk since current callers pass plain data, but it is a footgun for future callers, and the obfuscated regex construction makes this file harder to security-review than it needs to be.

**Smallest repair:** Add a plain-object guard (e.g. Object.getPrototypeOf(input) === Object.prototype) before validating, freeze or snapshot the validated fields once and read only from the snapshot afterward, and replace the obfuscated regex construction with a normal literal.

**Verifier reasoning:** Verifiers reproduced the accessor re-read behavior with a crafted getter-based input object and confirmed validateBinding's second read diverges from its first-pass validation, and separately confirmed the unusual RegExp/fromCharCode construction by reading the file and its git blame (commit 754f01e).

---

### HK-118: verifyAccountActivity does not itself reconcile balances to movements; that arithmetic lives only in the reducer

**Location:** `packages/runner/src/cycle/execution-accounting.mjs:88`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-cycle-b--security#4

verifyAccountActivity, whose name implies it independently verifies that opening balance plus movements equals closing balance, actually delegates that arithmetic entirely to the reducer rather than performing or double-checking it itself, so the module's own boundary does not provide the independent check its name suggests.

**Impact:** Anyone relying on verifyAccountActivity in isolation (e.g. in a future refactor that calls it without also going through the reducer) would get no actual balance-reconciliation guarantee despite the name implying one.

**Smallest repair:** Move the opening+movements==closing check into verifyAccountActivity itself so the module provides the guarantee its name implies, independent of whether the reducer also happens to check it.

**Verifier reasoning:** Verifiers read verifyAccountActivity's implementation and confirmed it performs no arithmetic reconciliation itself, cross-checking that the actual check exists only in reducer.mjs.

---

### HK-119: requirementsRevision is hardcoded to 56 independently in reconcile.mjs and vault-payout-authorization.mjs

**Location:** `packages/runner/src/distribution/reconcile.mjs:201`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-distribution--correctness#6, runner-distribution--autonomy-readiness#10

Both files hardcode the literal revision number 56 separately rather than importing it from one shared constant, mirroring the same duplication pattern flagged for the contracts side in HK-098/HK-074.

**Impact:** If the approved requirements revision changes, both hardcoded literals must be found and updated independently, with no automated check ensuring they stay in sync with each other or with specs/requirements.json.

**Smallest repair:** Introduce one shared requirementsRevision constant (imported from a single config/binding source) and have both files reference it instead of hardcoding the literal separately.

**Verifier reasoning:** Verifiers confirmed the literal 56 appears independently in both files by reading them directly.

---

### HK-120: verifyDistributionCopies rebuilds the Merkle-sum tree redundantly, four times, after an initial byte-equality check has already passed

**Location:** `packages/runner/src/distribution/manifest.mjs:350`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-distribution--correctness#7

After confirming the three supplied artifact copies are byte-identical, verifyDistributionCopies proceeds to rebuild the tree from entries multiple additional times (four total rebuilds observed) rather than reusing the first rebuild's result, which is wasted computation with no corresponding safety benefit since the copies are already known to be identical.

**Impact:** Pure performance/efficiency issue; on a full 1,024-entry manifest this could be a meaningful amount of wasted CPU time per verification call, though not a correctness issue.

**Smallest repair:** Rebuild the tree once and reuse the result for all subsequent checks within the same verifyDistributionCopies call.

**Verifier reasoning:** Verifiers traced the function's control flow and counted four separate tree-rebuild calls operating on already-confirmed-identical data.

---

### HK-121: A full-width (1,022-1,024 entry) manifest exceeds the journal's canonical string length limit and can never be digested or journaled

**Location:** `packages/runner/src/distribution/merkle-sum.mjs:11`
**Theme:** Holder payout & distribution pipeline
**Sources:** runner-distribution--security#6

The journal's canonical-string encoding has a length limit that a manifest near the maximum 1,024-entry width (see HK-014/HK-034) exceeds, so a distribution that is otherwise valid and at the legal size ceiling cannot actually be digested into the journal's canonical string format at all.

**Impact:** The pipeline's own stated maximum holder count (1,024) is not actually usable near its upper bound, because the journaling/digesting layer has a tighter, undocumented limit than the distribution logic itself.

**Smallest repair:** Either raise the journal's canonical-string length limit to comfortably accommodate a full 1,024-entry manifest, or split the journaled representation (e.g. store a digest plus a separate asset reference to the full manifest bytes) so the length limit no longer constrains the maximum holder count.

**Verifier reasoning:** Verifiers computed the canonical string length for a synthetic 1,024-entry manifest and confirmed it exceeds the journal's documented/enforced limit.

---

### HK-122: The documented distribution verification command and publication rule do not match the code

**Location:** `tasks/P1-009.md:35`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-distribution--autonomy-readiness#11

tasks/P1-009.md documents a verification command and a two-location publication rule for the distribution manifest that do not correspond to what the actual code in packages/runner/src/distribution does (e.g. the code has no publication step at all, per HK-029).

**Impact:** A contributor following the documented command/rule would either get a command that does not work as described, or would believe a publication guarantee exists that the code does not actually provide.

**Smallest repair:** Update tasks/P1-009.md to describe the actual current state of the code (including that publication is not yet implemented, per HK-029), and revisit the doc once HK-029's repair lands.

**Verifier reasoning:** Verifiers ran the documented command and compared its actual behavior, and the described publication rule, against the real code path, confirming both diverge from the documentation.

---

### HK-123: A cross-package relative import reaches into the canonical Merkle-sum implementation rather than a package-level dependency

**Location:** `packages/runner/src/distribution/merkle-sum.mjs:9`
**Theme:** Code hygiene, dead code, duplication
**Sources:** runner-distribution--autonomy-readiness#12

packages/runner/src/distribution/merkle-sum.mjs imports the canonical Merkle-sum implementation via a relative path that reaches across package boundaries (into packages/contracts/tooling) instead of depending on it through a proper package reference, coupling the two packages' directory layouts together.

**Impact:** Fragile to refactors: moving either package's directory structure, or ever publishing packages/runner independently, would silently break this import with no compile-time signal in a language without strict module resolution guarantees.

**Smallest repair:** Replace the relative cross-package import with a proper workspace package dependency (e.g. a shared internal package published to the monorepo's workspace) so the coupling is explicit and resilient to directory moves.

**Verifier reasoning:** Verifiers confirmed the import path traverses out of packages/runner into packages/contracts via relative segments by reading the import statement directly.

---

## 3. Refuted findings

These claims were investigated and found **not** to hold against the current repository state. They should not be re-reported without new evidence.

- **HK-R01** (`packages/contracts/src/accounting/FeeAccounting.sol:9`) — *Owner transcript fee split (0.5% treasury + 0.1% Programmable) differs from the coded 0.40/0.10/2.50 split*. Refuted: product/OWNER_DECISIONS.md states verbatim '0.10% Programmable, 0.40% treasury, and 2.50% process budget' as an owner-approved decision (reaffirmed for revision 56) matching the code and RobinhoodBindings exactly; no file anywhere in the repository states the alleged conflicting '0.5% treasury, 0.1% Programmable' transcript, so the discrepancy could not be confirmed against anything in this worktree.

---

## 4. Info observations (32)

Compact list — non-actionable notes, verified-safe checks, positive parity confirmations, and cosmetic/documentation items. No repair is required for most of these; several are cross-referenced to a higher-severity finding above.

- **HK-I01** `packages/contracts/src/market/CanonicalMarket.sol:222` — RobinhoodBindings.validateQuadrant duplicates the runtime fee/quadrant math and is exercised only by tests, not consumed by the runtime hook.
- **HK-I02** `packages/contracts/src/bindings/RobinhoodBindings.sol:33` — bindings/robinhood-chain.json's universalRouter address fails EIP-55 checksum (cosmetic; Solidity address comparisons are case-insensitive).
- **HK-I03** `packages/contracts/src/accounting/FeeAccounting.sol:59` — Every swap and claim fails closed on any external USDG balance shortfall with no recovery path (fail-closed by design, noted for completeness).
- **HK-I04** `packages/contracts/src/accounting/FeeAccounting.sol:14` — The liability ledger is not keyed by poolId/currency as the policy contemplates; single-pool scope is implicit rather than explicit.
- **HK-I05** `packages/contracts/src/process/PegCycleVault.sol:223` — RetainedAllowance check is unreachable because the vault never approves anything to a third party.
- **HK-I06** `packages/contracts/src/process/PegCycleVault.sol:37` — No lifecycle timestamps or deadline views exist for stuck-cycle detection tooling to query.
- **HK-I07** `packages/contracts/src/payout/PayoutCommitment.sol:48` — PayoutAlreadyFunded sentinel on payoutId==0 is unreachable and therefore safe: both the vault and the ledger independently reject a zero payoutId (verified, not a defect).
- **HK-I08** `packages/contracts/src/payout/PayoutCommitment.sol:27` — Payout identity per REQ-payout-commitment-2 is split across the hook and vault; the hook's event omits the vault authorization and return-receipt digests.
- **HK-I09** `packages/contracts/src/payout/CanonicalMerkleSum.sol:170` — ManifestEntry.directBalance is conformant: bound only in the manifest bytes, intentionally never checked on-chain (verified, not a defect).
- **HK-I10** `packages/runner/src/distribution/manifest.mjs:360` — The two-location manifest-publication preflight (REQ-holder-settlement-5) is explicitly out of scope for the local runner; tracked as open red-team item RT-R55-05.
- **HK-I11** `packages/contracts/tooling/payout/canonical-merkle-sum.mjs:66` — Solidity/JS Merkle-sum parity and the from-scratch Keccak primitive were independently re-verified in this audit session and found correct.
- **HK-I12** `packages/contracts/test-vectors/payout/canonical-merkle-sum-v1.json:12` — The canonical test vector uses chainId 466 and a placeholder hook address, not Robinhood Chain 4663 (see HK-083).
- **HK-I13** `packages/contracts/script/release/PhaseOneReleasePlan.sol:57` — The USDG runtime-codehash check only covers the 170-byte UUPS proxy shell, not the implementation logic behind it.
- **HK-I14** `packages/contracts/test/blind/token-roles/FixedSupplyBlindSpec.sol:507` — The forbidden-selector scan does not skip PUSH immediates and only recognises PUSH4-encoded selectors; combined with HK-051 the whole spec is currently dead code anyway.
- **HK-I15** `packages/contracts/foundry.toml:11` — HookemonHook's runtime bytecode is within 752 bytes of the EIP-170 24,576-byte limit at current optimizer settings — worth monitoring as features are added.
- **HK-I16** `packages/contracts/src/launch/HookemonIssuance.sol:9` — WHOLE_HKMN_SUPPLY and the 90% allocation formula are duplicated with different arithmetic across four files with no shared source (PhaseOneReleasePlan.sol, HookemonIssuance.sol, and two others).
- **HK-I17** `packages/contracts/src/bindings/RobinhoodBindings.sol:16` — REQUIREMENTS_REVISION 54 vs. PegCycleVault's 56 is documented elsewhere as an intentional split between provider-fact history and current tracked build evidence (background context for the disputed HK-074).
- **HK-I18** `packages/contracts/test/accounting/FeeAccountingInvariant.t.sol:7` — FeeAccountingInvariant.t.sol is orphaned: not run by CI, the release script, or any documented command (see HK-017).
- **HK-I19** `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol:71` — No test in the unit covers a scheduler, overlapping cycles, expiry recovery, or a terminal-failure restart, all of which the owner's autonomous design requires.
- **HK-I20** `packages/contracts/test/bindings/RobinhoodBindings.t.sol:132` — Several assertions in this suite test only a mock or a nonexistent selector and prove nothing about the actual src contract.
- **HK-I21** `packages/contracts/test/process/PegCycleVault.t.sol:799` — Outbound route execution and the Collector Crypt sale path are represented only by a burning mock; no test constrains what a real executor must do (relates to HK-013).
- **HK-I22** `packages/runner/src/cycle/schemas.mjs:17` — The buyback receipt relation models the prize wallet debiting 10 units of the NFT mint, which no real buyback receipt can satisfy (background to HK-027).
- **HK-I23** `packages/runner/src/cycle/reducer.mjs:1025` — Distribution rootSum must equal 100% of the returned vault credit; no fee split or principal retention exists at this layer (by design at this layer, per the owner's model — full return credit is distributed).
- **HK-I24** `packages/runner/src/cycle/collector.mjs:110` — Collector custody/finality blockHash is validated as a generic identifier while every other blockHash field in the schema is validated as hex, an inconsistency worth normalizing.
- **HK-I25** `packages/runner/src/cycle/execution-accounting.mjs:71` — Native-gas reconciliation requires actualDebit === transactionFee exactly, which a real Solana transaction (with priority fees, etc.) will not satisfy.
- **HK-I26** `packages/runner/src/cycle/decoder.mjs:149` — broadcastSignature assumes the first required signer is always the fee payer, an assumption not guaranteed by the Solana transaction format in general.
- **HK-I27** `packages/runner/src/cycle/preflight.mjs:79` — Release-evidence transaction/block identifiers are typed as sha256: digests rather than EVM transaction/block hashes, an internal naming/typing inconsistency for the Robinhood (EVM) leg.
- **HK-I28** `packages/runner/test/cycle/security.test.mjs:1705` — A field-binding test silently skips mutations that the encoder itself rejects, reducing its actual coverage below what it appears to test.
- **HK-I29** `packages/runner/src/cycle/vault-payout-authorization.mjs:126` — Keccak-256 and ABI encoding for the payout authorization digest were independently re-verified against Foundry cast and the vault's struct layout and found correct.
- **HK-I30** `packages/contracts/tooling/payout/canonical-merkle-sum.mjs:286` — JS/Solidity Merkle-sum parity re-verified against the sparse 5-entry canonical vector in this session (positive note, no defect).
- **HK-I31** `packages/runner/src/distribution/manifest.mjs:340` — Three-copy manifest verification is in-process byte equality, not independent custody across separate processes/machines; a single compromised process can fabricate all three copies.
- **HK-I32** `packages/contracts/src/accounting/FeeAccounting.sol:9` — An owner transcript reportedly says '0.5% treasury, 0.1% Programmable'; the code and product/OWNER_DECISIONS.md agree on 0.10/0.40/2.50 — flagged for the owner to confirm which is authoritative, not a code defect (see also HK-R01, refuted on the same point).

---

## 5. Themes

### PegCycleVault dead-end / absorbing states

HK-001, HK-002, HK-003, HK-011, HK-012, HK-013, HK-043, HK-075, HK-076, HK-079

### Programmable fee-policy conformance

HK-008, HK-037, HK-039, HK-040, HK-042, HK-057

### Single-router binding & swap execution

HK-009, HK-010, HK-038, HK-073

### Launch / token-issuance path missing

HK-005, HK-047, HK-048, HK-049, HK-050, HK-074, HK-090, HK-091, HK-094

### Test-gate coverage gaps (CI does not enforce invariants)

HK-004, HK-017, HK-046, HK-051, HK-052, HK-053, HK-054, HK-055, HK-056, HK-058, HK-059, HK-060, HK-061, HK-085, HK-095, HK-096, HK-097, HK-099, HK-100, HK-101, HK-102, HK-103, HK-104, HK-105

### Fixture-only runner (no production integration)

HK-006, HK-007, HK-019, HK-023, HK-027, HK-028, HK-030, HK-063, HK-106, HK-111

### Autonomy / scheduling / persistence gaps

HK-020, HK-021, HK-022, HK-024, HK-025, HK-026, HK-062, HK-065, HK-066, HK-067, HK-068

### Holder payout & distribution pipeline

HK-014, HK-015, HK-016, HK-029, HK-031, HK-032, HK-033, HK-034, HK-035, HK-036, HK-044, HK-070, HK-071, HK-072, HK-082, HK-086, HK-121

### Code hygiene, dead code, duplication

HK-077, HK-078, HK-080, HK-081, HK-083, HK-084, HK-087, HK-088, HK-089, HK-092, HK-093, HK-098, HK-107, HK-108, HK-109, HK-110, HK-112, HK-113, HK-114, HK-115, HK-116, HK-117, HK-118, HK-119, HK-120, HK-122, HK-123

