# Immutable Peg-Cycle Custody Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the immutable 2.50% process share and all attributable returned USDG outside Operations custody from fee accrual through holder payout.

**Architecture:** Requirements revision 56 replaces Operations-directed process release with a hook-bound `PegCycleVault`. The immutable authorizer records exact cycle and payout approvals onchain; Operations may trigger those records once but never receives or controls USDG. Provider-specific Programmable, Robinhood, bridge, Solana, and Collector bindings remain fail-closed adapters until current official evidence exists.

**Tech Stack:** Solidity 0.8.26, Foundry, Node.js 24 ESM runner, pinned Uniswap v4-core/v4-periphery/liquidity-launcher sources, JSON evidence artifacts.

## Global Constraints

- Preserve the exact fee formula: `total=floor(Q*300/10000)`, `programmable=floor(Q*10/10000)`, `treasury=floor(Q*40/10000)`, `process=total-programmable-treasury`.
- Operations may trigger a cycle but may never receive, withdraw, redirect, approve, rescue, or otherwise control process principal or returned proceeds.
- The hook may debit process liability only while atomically funding its immutable `PegCycleVault`.
- Returned Robinhood USDG goes to the vault and is atomically reclassified at the hook into a payout whose root sum equals the exact attributable return.
- The vault has no proxy, upgrade, delegatecall, generic call, generic approval, rescue, sweep, administrator, or successor-control path.
- One sequential Phase 1 cycle may be active; every authorization, outbound action, return attribution, payout identifier, and receipt is single-use.
- The cycle authorizer is immutable and distinct from Operations, treasury, Programmable, the hook, and the vault.
- An ordinary Operations-controlled EOA is forbidden as an EVM route recipient, Solana player, NFT recipient, buyback recipient, or return recipient.
- Previous-chain Programmable documentation is `UNVERIFIED_FOR_ROBINHOOD` and may inform terminology or API shape only. Robinhood launch/admission ABIs, addresses, runtimes, and provider semantics stay `INTEGRATION_PENDING` until current official evidence exists.
- No task may access secrets, sign, broadcast, deploy, move assets, spend, publish, push, merge, or claim production readiness.
- Use test-first red-green cycles, run only focused local tests, and create one small Conventional Commit per task.

---

### Task 1: Bind requirements revision 56

**Files:**
- Create: `product/REQUIREMENTS_REVISION_56_PROPOSAL.md`
- Create: `decisions/ADR-0019-immutable-peg-cycle-custody.md`
- Modify: `product/PRD.md`
- Modify: `product/OWNER_DECISIONS.md`
- Modify: `product/SOURCE_BOUNDARY.md`
- Modify: `architecture/capability-map.md`
- Modify: `architecture/capability-map.json`
- Modify: `architecture/trust-boundaries.md`
- Modify: `architecture/failure-modes.md`
- Modify: `docs/modules/process-budget.md`
- Modify: `docs/modules/payout-commitment.md`
- Create: content-addressed previous-chain API-shape evidence under `feasibility/`
- Modify: `tasks/P1-006.md`
- Modify: `tasks/P1-007.md`
- Modify: `tasks/P1-010.md`
- Modify: `tasks/P1-012.md`
- Test: `scripts/tests/final-review.test.mjs`
- Test: `scripts/tests/delivery-boundary.test.mjs`

**Interfaces:**
- Consumes: approved design `docs/superpowers/specs/2026-09-01-immutable-peg-cycle-custody-design.md`.
- Produces: normative revision-56 language and stable module/task boundaries for Tasks 2-5.

- [ ] **Step 1: Write failing boundary assertions**

Add focused assertions that the active PRD and task cards contain `PegCycleVault`, forbid Operations custody, retain exact `300/10/40/remainder` fee math, keep the dashboard deferred, and label previous-chain Programmable material `UNVERIFIED_FOR_ROBINHOOD`. Require every entry in the content-addressed previous-chain API-shape artifact to contain a repository-relative source path, source SHA-256, reusable interface shape, and `productionAuthority: false`; reject secrets, previous-chain addresses copied as Robinhood bindings, or any `VERIFIED_FOR_ROBINHOOD` claim.

```js
assert.match(prd, /PegCycleVault/);
assert.match(prd, /Operations[^.]*never[^.]*process principal/i);
assert.match(prd, /totalFee[^\n]*300[^\n]*programmable[^\n]*10[^\n]*treasury[^\n]*40/);
assert.match(sourceBoundary, /UNVERIFIED_FOR_ROBINHOOD/);
assert.doesNotMatch(prd, /Current Operations alone releases each new process cycle to itself/);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test scripts/tests/final-review.test.mjs scripts/tests/delivery-boundary.test.mjs
```

Expected: FAIL because revision 55 still authorizes Operations-directed release and no `PegCycleVault` authority exists.

- [ ] **Step 3: Write the minimal normative revision**

Record revision 56 with these exact rules:

```text
The immutable fee split remains 0.10% Programmable, 0.40% treasury, and the exact remainder of the inclusive 3.00% fee as peg-cycle process liability. The hook may debit process liability only while atomically funding its immutable PegCycleVault. Operations is a trigger only and never a process-principal, external-route, return-proceeds, or payout-funding custodian. All exact attributable returned USDG is committed from the vault to the hook as one sum-bound holder payout.
```

ADR-0019 must supersede only the Operations-custody portions of ADR-0011, ADR-0013, ADR-0015, and ADR-0018. It must retain two-step Operations rotation for future trigger authority and leave Programmable launch/admission facts `INTEGRATION_PENDING`.

Build the compatibility artifact only from the legacy local repository's public source, tests, and documentation. Preserve interface names and state-machine lessons where useful, but classify every prior-chain ABI, address, deployment graph, Registry/Router behavior, and provider API field as comparison evidence rather than Robinhood authority.

The initial evidence set contains eleven content-addressed source and documentation records enumerated inside the compatibility artifact. Recompute and store each full SHA-256 while generating the artifact; do not copy any address, ABI, legacy bridge message layout, domain, permission bit, or provider field into a Robinhood binding.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run the Step 2 command.

Expected: PASS with no source-boundary or delivery-boundary regression.

- [ ] **Step 5: Commit**

```sh
git add product architecture feasibility docs/modules tasks decisions scripts/tests
git commit -m "docs(spec): require immutable peg cycle custody"
```

---

### Task 2: Fund a hook-bound vault instead of Operations

**Files:**
- Create: `packages/contracts/src/process/IPegCycleVault.sol`
- Create: `packages/contracts/src/process/IPegCycleRouteExecutor.sol`
- Create: `packages/contracts/src/process/PegCycleVault.sol`
- Create: `packages/contracts/test/process/PegCycleVault.t.sol`
- Modify: `packages/contracts/src/process/ProcessBudget.sol`
- Modify: `packages/contracts/src/access/MoneyRoles.sol`
- Modify: `packages/contracts/src/payout/PayoutCommitment.sol` only for constructor propagation.
- Modify: `packages/contracts/src/settlement/HolderSettlement.sol` only for constructor propagation.
- Modify: `packages/contracts/test/process/ProcessBudget.t.sol`
- Modify as required for compile-only constructor/setup propagation: `packages/contracts/test/payout/PayoutCommitment.t.sol`, `packages/contracts/test/settlement/HolderSettlement.t.sol`, `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol`, `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol`.
- Modify: `architecture/interfaces.json`
- Modify: `docs/modules/process-budget.md`
- Modify: `tasks/P1-006.md`

**Interfaces:**
- Consumes: revision-56 frozen authorization/vault schema, `FeeAccounting._debitProcessLiability`, exact USDG transfer helpers, current Operations trigger identity.
- Produces:
  - `IPegCycleVault.FundingAuthorization`.
  - `PegCycleVault.authorizeFunding(FundingAuthorization calldata)` callable only by immutable authorizer.
  - `PegCycleVault.consumeFundingAuthorization(bytes32 cycleId, address operationsTrigger)` callable only by the hook.
  - `PegCycleVault.executeOutbound(bytes32 cycleId, bytes calldata routeData)` callable only by the bound Operations trigger and forwarding only through the immutable typed route executor.
  - `ProcessBudget.openPegCycle(bytes32 cycleId)` callable only by current Operations and transferring only to the immutable vault.

- [ ] **Step 1: Write the failing vault-funding tests**

Define the desired authorization shape in the test before production code:

```solidity
IPegCycleVault.FundingAuthorization memory auth = IPegCycleVault.FundingAuthorization({
    requirementsRevision: 56,
    chainId: block.chainid,
    cycleId: CYCLE_ONE,
    hook: address(subject),
    vault: address(vault),
    usdg: address(usdg),
    operationsTrigger: OPERATIONS_ONE,
    amount: 250,
    bindingManifestDigest: BINDING_DIGEST,
    outboundActionDigest: OUTBOUND_DIGEST,
    returnActionDigest: RETURN_DIGEST,
    returnDestination: address(vault),
    minimumRobinhoodReceive: 1,
    minimumSolanaReceive: 1,
    minimumReturnUsdg: 1,
    robinhoodNativeGasCap: 1,
    solanaNativeGasCap: 1,
    expiresAt: uint64(block.timestamp + 1 days),
    nonce: 1
});
```

Cover one successful funding and negative cases for direct Operations receipt, alternate destination, non-authorizer approval, wrong revision/chain/hook/vault/USDG/binding digest/Operations trigger/return destination, zero or excessive amount, expiry, nonce replay, cycle replay, second active cycle, token failure, short/excess balance delta, and reentrancy. Cover outbound execution with `keccak256(routeData)` as the exact stored digest and failures for a wrong caller, target, digest, amount, token delta, replay, arbitrary selector, and retained allowance. Assert the Operations USDG balance never increases.

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/process/*.t.sol' -vvv
```

Expected: compilation/test failure because the vault API and `openPegCycle` do not exist and current code transfers to Operations.

- [ ] **Step 3: Implement the minimal funding state machine**

Create the exact shared interface:

```solidity
interface IPegCycleVault {
    struct FundingAuthorization {
        uint32 requirementsRevision;
        uint256 chainId;
        bytes32 cycleId;
        address hook;
        address vault;
        address usdg;
        address operationsTrigger;
        uint256 amount;
        bytes32 bindingManifestDigest;
        bytes32 outboundActionDigest;
        bytes32 returnActionDigest;
        address returnDestination;
        uint256 minimumRobinhoodReceive;
        uint256 minimumSolanaReceive;
        uint256 minimumReturnUsdg;
        uint256 robinhoodNativeGasCap;
        uint256 solanaNativeGasCap;
        uint64 expiresAt;
        uint256 nonce;
    }

    function consumeFundingAuthorization(bytes32 cycleId, address operationsTrigger)
        external
        returns (FundingAuthorization memory authorization, uint256 balanceBefore);

    function confirmFunding(bytes32 cycleId, uint256 balanceBefore) external;
}
```

`PegCycleVault` must bind immutable `usdg`, `authorizer`, `routeExecutor`, `bindingManifestDigest`, and a launch-only deployment authority. That authority may call `bindHook(address)` exactly once inside the atomic GraphFactory launch composition; the hook must have deployed code and must already name the same vault. After binding, no caller can change the hook or any other vault identity. Store an enum `EMPTY`, `FUNDED`, `OUTBOUND`, `RETURNED`, `PAYOUT_COMMITTED`, `FAILED` and one active cycle record. A pending authorization is a separate single-use record and does not itself change the money lifecycle from `EMPTY`.

The route executor interface is narrow:

```solidity
interface IPegCycleRouteExecutor {
    function executeOutbound(
        bytes32 cycleId,
        address usdg,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external;
}
```

`executeOutbound` validates the stored digest before transferring the exact principal to the immutable route executor, invokes only this selector, requires the vault principal balance to fall by exactly the funded amount, requires no residual token allowance, and marks `OUTBOUND`. The local executor fixture may simulate a route; the production executor remains `INTEGRATION_PENDING` until current Programmable/Robinhood bindings exist.

Replace the public release with the minimal hook path:

```solidity
function openPegCycle(bytes32 cycleId) external moneyPath returns (ReleasedCycle memory released) {
    address operations = _bindCycleOperationsTrigger(cycleId, msg.sender);
    (IPegCycleVault.FundingAuthorization memory auth, uint256 beforeBalance) =
        pegCycleVault.consumeFundingAuthorization(cycleId, operations);
    _debitProcessLiability(auth.amount);
    _transferExactUsdg(address(pegCycleVault), auth.amount);
    pegCycleVault.confirmFunding(cycleId, beforeBalance);
    released = ReleasedCycle({cycleId: cycleId, amount: auth.amount, operationsTrigger: operations});
    releasedCycles[cycleId] = released;
    emit ProcessBudgetReleased(cycleId, operations, auth.amount);
}
```

Keep the event's Operations field as the immutable trigger audit record, not as recipient evidence. Remove every public path that accepts a process recipient or transfers process USDG to Operations.

Propagate the immutable vault constructor argument through `PayoutCommitment`, `HolderSettlement`, and their direct test harnesses without implementing Task 3 payout behavior early. Re-freeze `architecture/interfaces.json` to the exact implemented method names and lifecycle. Correct P1-006's prohibition from any `external-execution function` to any **arbitrary** external-execution function; the exact immutable typed route executor is required, while generic targets, selectors, calls, and approvals remain forbidden.

- [ ] **Step 4: Run the focused contract tests and confirm GREEN**

Run the Step 2 command.

Then run the compile-only gate:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge build --root packages/contracts
```

Expected: PASS; the successful case increases only the vault USDG balance, and every rejected case leaves liabilities, cycle state, hook balance, vault balance, and Operations balance unchanged.

- [ ] **Step 5: Commit**

```sh
git add packages/contracts/src/process packages/contracts/src/access packages/contracts/src/payout packages/contracts/src/settlement packages/contracts/test/process packages/contracts/test/payout packages/contracts/test/settlement packages/contracts/test/integration packages/contracts/test/invariant architecture/interfaces.json docs/modules/process-budget.md tasks/P1-006.md
git commit -m "feat(process): route cycle funding through immutable vault"
```

---

### Task 3: Commit returned proceeds directly from vault to payout

**Files:**
- Modify: `packages/contracts/src/process/IPegCycleVault.sol`
- Modify: `packages/contracts/src/process/PegCycleVault.sol`
- Modify: `packages/contracts/src/payout/PayoutCommitment.sol`
- Modify: `packages/contracts/src/settlement/HolderSettlement.sol` only if the renamed payout record requires mechanical propagation.
- Modify: `packages/contracts/test/process/PegCycleVault.t.sol`
- Modify: `packages/contracts/test/payout/PayoutCommitment.t.sol`
- Modify: `packages/contracts/test/settlement/HolderSettlement.t.sol`
- Modify as required for compile-only API propagation: `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol`, `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol`.
- Modify: `architecture/interfaces.json`
- Modify: `docs/modules/payout-commitment.md`
- Modify: `tasks/P1-007.md`

**Interfaces:**
- Consumes: the funded cycle and immutable vault binding from Task 2.
- Produces:
  - `PegCycleVault.authorizePayout(PayoutAuthorization calldata)` callable only by authorizer after the exact return is present.
  - `PegCycleVault.consumePayoutAuthorization(...)` callable only by hook and transferring exact returned USDG to hook.
  - `PayoutCommitment.fundPayoutFromPegCycle(...)` with no Operations payer or allowance.

- [ ] **Step 1: Write failing returned-proceeds tests**

Define the desired payout authorization:

```solidity
IPegCycleVault.PayoutAuthorization memory auth = IPegCycleVault.PayoutAuthorization({
    requirementsRevision: 56,
    chainId: block.chainid,
    cycleId: CYCLE_ONE,
    hook: address(subject),
    vault: address(vault),
    usdg: address(usdg),
    operationsTrigger: OPERATIONS_ONE,
    bindingManifestDigest: BINDING_DIGEST,
    payoutId: PAYOUT_ONE,
    manifestDigest: MANIFEST_DIGEST,
    rootHash: ROOT_HASH,
    rootSum: 175,
    returnActionDigest: RETURN_DIGEST,
    returnReceiptDigest: RETURN_RECEIPT_DIGEST,
    expiresAt: uint64(block.timestamp + 1 days),
    nonce: 2
});
```

Cover exact success and failures for Operations-funded payout, external-wallet funding, wrong cycle/hook/vault/USDG/Operations trigger/binding manifest/payout/distribution manifest/root/root sum/return action/receipt/revision/chain/nonce/expiry, payout replay, return amount mismatch, unrelated vault balance contamination, token failure, reentrancy, and early commitment before outbound/return. Add authorizer-only terminal failure coverage: it succeeds only after `OUTBOUND`, with a nonzero failure-receipt digest and zero vault USDG balance; it cannot release value and cannot be used while funds or returned proceeds remain. Assert Operations balance is unchanged throughout.

- [ ] **Step 2: Run the payout tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/process/PegCycleVault.t.sol' -vvv
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/payout/PayoutCommitment.t.sol' -vvv
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/settlement/HolderSettlement.t.sol' -vvv
```

Expected: FAIL because the current payout pulls USDG from cycle-bound Operations.

- [ ] **Step 3: Add exact vault-to-hook payout commitment**

Extend the interface:

```solidity
struct PayoutAuthorization {
    uint32 requirementsRevision;
    uint256 chainId;
    bytes32 cycleId;
    address hook;
    address vault;
    address usdg;
    address operationsTrigger;
    bytes32 bindingManifestDigest;
    bytes32 payoutId;
    bytes32 manifestDigest;
    bytes32 rootHash;
    uint256 rootSum;
    bytes32 returnActionDigest;
    bytes32 returnReceiptDigest;
    uint64 expiresAt;
    uint256 nonce;
}

function consumePayoutAuthorization(PayoutAuthorization calldata authorization)
    external
    returns (address operationsTrigger);
```

The vault accepts payout authorization only after `OUTBOUND`, when every deployment and cycle identity matches the active funding authorization, `returnActionDigest` equals the stored return action, `returnReceiptDigest` is nonzero, its exact USDG balance equals `rootSum`, and `rootSum >= minimumReturnUsdg`; acceptance stores the exact authorization digest and marks `RETURNED`. Consumption is hook-only, requires the exact stored authorization before expiry, transfers exactly `rootSum` to the hook, leaves vault USDG balance zero, and marks the cycle `PAYOUT_COMMITTED`. `recordTerminalFailure(cycleId, failureReceiptDigest)` is authorizer-only, requires `OUTBOUND` plus zero vault USDG, records the exact failure digest, and creates no transfer or approval path. `FAILED` is absorbing for this one-cycle Phase 1 vault: it never unlocks another cycle, so a delayed return cannot be attributed to later principal. A new cycle may open only after `PAYOUT_COMMITTED`.

Replace the external payer path with:

```solidity
function fundPayoutFromPegCycle(IPegCycleVault.PayoutAuthorization calldata authorization)
    external
    moneyPath
    returns (PayoutRecord memory record)
{
    uint256 hookBalanceBefore = _hookUsdgBalance();
    address operationsTrigger = pegCycleVault.consumePayoutAuthorization(authorization);
    uint256 hookBalanceAfter = _hookUsdgBalance();
    if (hookBalanceAfter - hookBalanceBefore != authorization.rootSum) {
        revert PayoutBalanceDeltaMismatch();
    }
    record = _recordPayout(authorization, operationsTrigger);
    _creditPayoutLiability(authorization.payoutId, authorization.rootSum);
    _requireSolvent();
}
```

Keep Operations only as historical trigger metadata in `PayoutRecord`; rename the field to `operationsTrigger` if ABI migration checks confirm no frozen production ABI exists. Delete `_transferFromUsdg` from the payout funding path.

Use the same vault transfer reentrancy and exact source/destination balance-delta discipline as outbound funding. Re-freeze `architecture/interfaces.json`, the payout module card, and P1-007 to the exact implemented method names and record fields. Propagate removed legacy payout API calls into integration/invariant fixtures only as required to compile; Task 5 owns their complete revision-56 proof.

- [ ] **Step 4: Run the focused payout tests and confirm GREEN**

Run the Step 2 command.

Then run the compile-only gate:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge build --root packages/contracts
```

Expected: PASS; exact returned USDG becomes payout liability atomically without any Operations allowance or balance delta.

- [ ] **Step 5: Commit**

```sh
git add packages/contracts/src/process packages/contracts/src/payout packages/contracts/src/settlement packages/contracts/test/process packages/contracts/test/payout packages/contracts/test/settlement packages/contracts/test/integration packages/contracts/test/invariant architecture/interfaces.json docs/modules/payout-commitment.md tasks/P1-007.md
git commit -m "feat(payout): fund holder commitments from peg cycle vault"
```

---

### Task 4: Remove Operations custody from runner accounting

**Files:**
- Modify: `packages/runner/src/cycle/schemas.mjs`
- Modify: `packages/runner/src/cycle/preflight.mjs`
- Modify: `packages/runner/src/cycle/reducer.mjs`
- Modify: `packages/runner/src/cycle/bindings.mjs`
- Modify: `packages/runner/src/cycle/decoder.mjs`
- Modify: `packages/runner/src/distribution/reconcile.mjs`
- Modify: `packages/runner/src/cycle/cycle-runner.mjs` only where public handoffs change.
- Modify: exact-schema mirrors in `packages/runner/test/cycle/fixture-cycle.mjs`, `bindings-state-machine.test.mjs`, `collector-sequence.test.mjs`, and `journal.test.mjs` only where the custody envelope changes.
- Modify: `packages/runner/test/cycle/security.test.mjs`
- Modify: `packages/runner/test/distribution/reconcile.test.mjs`
- Modify: `packages/runner/test/integration/phase-one-local-loop-adapter.mjs`

**Interfaces:**
- Consumes: revision-56 `cycleVaultAccount`, `policyAccount`, `operationsTrigger`, funding authorization, and payout authorization.
- Produces: a closed cycle whose outbound debit and final USDG credit belong to the vault/policy custody path, never Operations.

- [ ] **Step 1: Write failing runner custody tests**

Change the fixture contract first:

```js
const preflight = {
  ...existing,
  requirementsRevision: 56,
  operationsTrigger: 'fixture-operations-trigger',
  cycleVaultAccount: 'fixture-peg-cycle-vault',
  policyAccount: 'fixture-solana-policy-account',
  returnAccount: 'fixture-peg-cycle-vault'
};
```

Add negative cases proving that any action with `operationsAccount` as source, player, NFT recipient, buyback recipient, or return destination fails. The closed-ledger assertions must require the outbound Robinhood USDG debit from `cycleVaultAccount`, the Solana actions from `policyAccount`, and the final Robinhood USDG credit to `returnAccount == cycleVaultAccount`.

- [ ] **Step 2: Run the focused runner tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/cycle/security.test.mjs packages/runner/test/distribution/reconcile.test.mjs
```

Expected: FAIL because revision-55 schemas and reconciliation require Operations-account debits and credits.

- [ ] **Step 3: Implement the revision-56 runner projection**

Replace custody-bearing `operationsAccount` fields with explicit roles:

```js
const custody = {
  operationsTrigger,
  cycleVaultAccount,
  policyAccount,
  returnAccount: cycleVaultAccount
};
```

Keep `operationsTrigger` only for authorization and audit. Bind every action digest to `cycleVaultAccount` or `policyAccount` as appropriate. Derive returned proceeds only from the continuous finalized activity window of `cycleVaultAccount`; reject unrelated credits, mixed activity, alternate recipients, and any Operations balance basis. The payout funding intent must bind the onchain vault payout authorization rather than an Operations token approval.

- [ ] **Step 4: Run the focused runner tests and confirm GREEN**

Run the Step 2 command.

Expected: PASS with the revised fixtures; every legacy Operations-custody vector fails closed.

- [ ] **Step 5: Commit**

```sh
git add packages/runner/src packages/runner/test
git commit -m "feat(runner): remove operations custody from cycle ledger"
```

---

### Task 5: Rebind the complete local Phase 1 proof

**Files:**
- Modify: `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol`
- Modify: `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol`
- Modify: `packages/contracts/script/release/PhaseOneReleasePlan.sol`
- Modify: `scripts/verify-phase1-release.mjs`
- Modify: `scripts/verify-phase1-reproducibility.mjs`
- Modify: `scripts/tests/phase1-release.test.mjs`
- Modify: `scripts/tests/phase1-reproducibility.test.mjs`
- Modify: `scripts/tests/phase-boundary.test.mjs`
- Modify: `scripts/tests/reqs.test.mjs`
- Modify: `release/phase1/local-candidate.json`
- Modify: `release/phase1/local-reproducibility.json`
- Modify: `qa/reviews/p1-012-local-verification.json`
- Modify: `specs/requirements.json`
- Modify: `product/dependency-pins.json`
- Modify: `architecture/interfaces.json`
- Modify: `architecture/provisional-interfaces.json`
- Modify: `architecture/risk-classes.json`
- Modify: `architecture/execution-topology.md`
- Modify: `feasibility/interface-freeze.json`
- Modify: `feasibility/refresh-interface-freeze.mjs` only if the revision-56 source set requires it.
- Modify: `feasibility/model.mjs`
- Modify: `feasibility/model-results.json`
- Modify: `feasibility/survivability-bounds.json`
- Modify: `feasibility/integration-spikes.json`
- Modify: `feasibility/risk-lanes.json`
- Modify: `tasks/context-packs.json`
- Create: `docs/modules/peg-cycle-vault.md`
- Modify: `docs/modules/index.json`
- Modify: `docs/modules/cycle-runner.md`
- Modify: `docs/modules/release-evidence.md`

**Interfaces:**
- Consumes: reviewed commits from Tasks 1-4.
- Produces: one local-only revision-56 candidate proving zero Operations custody and preserving all existing fee, solvency, replay, permanent-LP-custody, and holder-payment invariants.

- [ ] **Step 1: Write failing integrated and verifier assertions**

Add assertions that the local loop:

```solidity
assertEq(usdg.balanceOf(operations), operationsBalanceBefore);
assertEq(usdg.balanceOf(address(vault)), 0);
assertEq(hook.processLiability(), processBefore - fundedPrincipal);
assertEq(hook.payoutLiability(PAYOUT_ID), exactReturnedUsdg);
```

Add release-verifier source and compiler-surface deny checks for Operations-directed process transfer, legacy `fundPayout`, generic vault execution/approval/rescue/upgrade, and mutable authorizer/vault/route bindings. Preserve each compiler artifact's exact `methodIdentifiers` map and require exact allowlisted maps for the high-risk vault, budget, payout, and settlement contracts/interfaces; do not rely on bare four-byte calls that can revert only because ABI arguments are missing. Require the candidate to include vault source, interface, focused tests, runner custody fields, revision-56 documents, and exact local initcode/concrete-runtime hashes. Update revision-55 requirement, dependency, provisional-interface, module-index, feasibility-model, bounds, risk, and phase-boundary assertions so the evidence inputs are coherent before regeneration.

- [ ] **Step 2: Run focused integration/verifier tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test scripts/tests/phase1-release.test.mjs scripts/tests/phase1-reproducibility.test.mjs
```

Then run:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/integration/PhaseOneLocalLoop.t.sol' -vvv
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/invariant/PhaseOneReleaseInvariant.t.sol' -vvv
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test scripts/tests/phase-boundary.test.mjs scripts/tests/reqs.test.mjs
```

Expected: FAIL because the candidate/local loop and their revision, artifact-count, compiler-surface, model, and module projections still bind the old Operations-custody evidence.

- [ ] **Step 3: Update the integrated proof and fail-closed external status**

Recompose the local loop and invariant harness around the real `PegCycleVault`: exact funding authorization, permissionless Operations trigger, typed outbound route, exact return to the vault, separate payout authorization, permissionless vault-funded payout, and holder payment. Prove Operations never receives or controls USDG, while preserving its ability to trigger an already exact-authorized transition. Assert the exact process-liability debit, zero final vault balance, exact payout-liability credit, and persistent committed authorization/receipt evidence.

Align the hard revision-56 requirements, dependency pin, provisional interfaces, module index/card, execution topology, risk projections, deterministic feasibility model/results/bounds, and phase-boundary tests. Operations compromise exposure to process principal and returned proceeds must be exactly zero; provider, authorizer, route-executor, bridge, and policy-wallet compromise remain separate unresolved/nonzero risk classes until live bindings exist. Regenerate the interface freeze from coherent revision-56 inputs rather than hand-editing only its output.

Update the release plan and candidate hashes without adding `run()`, broadcast, signing, deployment, provider mutation, or secret access. Keep these exact external statuses:

```json
{
  "programmablePreviousChainDocs": "UNVERIFIED_FOR_ROBINHOOD_API_SHAPE_ONLY",
  "programmableRobinhoodLaunch": "INTEGRATION_PENDING",
  "robinhoodPegCycleRoute": "INTEGRATION_PENDING",
  "solanaPolicyCustody": "INTEGRATION_PENDING",
  "mainnetCanary": "SEPARATE_EXACT_ACTION_AUTHORIZATION_REQUIRED",
  "productionReady": false
}
```

Expand reproducibility from the old 14-artifact set to the exact current 20-artifact source set, preserve `methodIdentifiers` in each summary and its aggregate digest, and require exact compiler surfaces for high-risk contracts. Bind a deterministic local vault plan including constructor initcode, CREATE2 address, immutable identities, and concrete deployed runtime hash. Compiler runtime-template hashes with immutable references must be labeled as templates and never presented as deployed-runtime evidence.

- [ ] **Step 4: Run one focused local verification pass**

Run the four Step 2 commands. Then run only the focused runner tests from Task 4, the deterministic feasibility model verification, and the interface-freeze check.

Expected: all focused tests PASS. Do not rerun the complete repository suite locally; GitHub CI remains the later full net.

- [ ] **Step 5: Independent review**

Review the Task 1-5 range for:

- any direct or indirect Operations custody;
- generic call/approval/rescue/upgrade authority;
- mismatched authorizer, route, chain, digest, nonce, amount, expiry, or recipient;
- unrelated balance attribution;
- replay across cycle, action, receipt, payout, or deployment;
- false claims based on previous-chain Programmable documentation;
- loss of existing fee conservation, solvency, LP custody, or holder-payment guarantees.

Fix Critical and Important findings, rerun only affected focused tests, and return the exact corrective diff to the same reviewer before source closure is accepted.

- [ ] **Step 6: Commit reviewed source closure**

```sh
git add packages/contracts/test/integration packages/contracts/test/invariant packages/contracts/script/release scripts specs product architecture feasibility tasks docs/modules
git commit -m "test(release): prove immutable peg cycle custody"
```

- [ ] **Step 7: Generate commit-bound evidence and commit the records**

Run the reproducibility generator twice against the exact reviewed Step 6 commit, then run the release verifier once against the resulting trusted candidate digest. Write only `release/phase1/local-reproducibility.json` and `qa/reviews/p1-012-local-verification.json`; neither belongs inside the self-hashed candidate file list. Confirm `sourceCommit`, candidate digest, 20-artifact identity set, method-identifier maps, runtime/initcode hashes, runner source set, test counts, and `externalActionsPerformed: false` all match before committing:

```sh
git add release/phase1/local-reproducibility.json qa/reviews/p1-012-local-verification.json
git commit -m "test(release): record revision 56 local evidence"
```

---

## Mainnet handoff after local completion

Do not perform this section during plan implementation. After current Programmable Robinhood documentation and production support exist, bind the exact Launchpad, Registrar, PoolManager, router, hook admission path, fee custody, vault route executor, Solana policy account, Collector pack, outbound route, return route, code hashes, ABIs, gas limits, and source revisions.

Run a pinned Robinhood fork first. A later minimum-value Mainnet canary requires a new exact owner authorization naming every deployed address, signer identity, asset, destination, calldata digest, principal cap, minimum return, and native-gas cap. The owner has authorized read-only use of the historical Programmable API key for legacy API-shape discovery before rotation; if the key is made available, keep it out of repository files, command output, logs, receipts, and Git history. It never authorizes mutation, signing, deployment, publication, or Mainnet activity.
