# Phase 2 Manual Operator Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one durable manual control path that freezes a selected pack and money parameters, resumes the exact interrupted cycle, and starts a safely isolated fresh cycle after terminal failure.

**Architecture:** The hook-bound `PegCycleVault` remains the single-cycle coordinator, while each cycle receives a deterministic immutable `PegCycleReturnEscrow` so delayed returns cannot cross cycle boundaries. A dependency-free Node.js controller stores one canonical JSON state file, freezes one pack-backed cycle plan, and reuses the existing journal, reducer, cycle store, and reconciliation logic. Production signing, broadcast, provider mutation, scheduling, dashboards, databases, and concurrency remain absent.

**Tech Stack:** Solidity 0.8.26, Foundry 1.7.1, Node.js 24.19.0 ESM, Node.js standard library, existing canonical JSON and SHA-256 journal utilities.

## Global Constraints

- Bind every Phase 2 task and authorization to approved requirements revision `57`; use the v4 CLI for ledger changes and do not edit generated `STATE.md`, `state.json`, `tasks.json`, or append-only receipts by hand.
- Preserve the exact inclusive fee split and all Phase 1 payout, paid-key, route-executor, role, and immutable hook bindings.
- Set the new coordinator authorization domain to requirements revision `57`; revision-56 evidence remains historical and cannot authorize the revised contract.
- Operations remains a trigger only and never receives process principal, returned USDG, NFT custody, or payout funds.
- One cycle may be active. Every later cycle uses a fresh cycle identifier, fresh nonce, and unique deterministic escrow.
- Quantity is exactly `1`; turbo mode is exactly `false`.
- Draft pack and money fields are editable only before canonical freeze.
- Recovery always uses the frozen cycle identifier, plan digest, durable journal, and cycle-store snapshot. An unresolved action must reconcile before progress and is never retried blindly.
- Pending expired authorization cleanup keeps the old cycle identifier, nonce, and escrow consumed.
- A `FUNDED` or `RETURNED` deadline renewal changes only `expiresAt` and an unused nonce. It never executes or retries an external action.
- Unexpected or late USDG remains isolated in the escrow that received it and cannot be credited to another cycle.
- Use no proxy, upgrade, generic call, generic approval, generic recipient, rescue, sweep, owner, successor, database, server, scheduler, wallet, signer, credential loader, or production network transport.
- Production Collector, Robinhood, bridge, signing, and broadcast operations remain `INTEGRATION_PENDING` and fail closed.
- Use test-first red-green cycles and one small Conventional Commit per task. Do not push, merge, deploy, publish, access credentials, sign, broadcast, move assets, or spend.

---

### Task 1: Isolate each cycle's custody and preserve same-cycle liveness

**Files:**
- Create: `packages/contracts/src/process/PegCycleReturnEscrow.sol`
- Modify: `packages/contracts/src/process/IPegCycleVault.sol`
- Modify: `packages/contracts/src/process/PegCycleVault.sol`
- Modify: `packages/contracts/src/process/ProcessBudget.sol`
- Modify: `packages/contracts/test/process/PegCycleVault.t.sol`
- Modify: `packages/contracts/test/process/ProcessBudget.t.sol`
- Modify only for changed fixture expectations: `packages/contracts/test/payout/PayoutCommitment.t.sol`
- Modify only for changed fixture expectations: `packages/contracts/test/integration/PhaseOneLocalLoop.t.sol`
- Modify only for changed fixture expectations: `packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol`
- Modify: `architecture/interfaces.json`
- Modify: `docs/modules/peg-cycle-vault.md`
- Modify: `docs/modules/process-budget.md`

**Interfaces:**
- Consumes: current `IPegCycleVault.FundingAuthorization`, `IPegCycleVault.PayoutAuthorization`, immutable hook/USDG/route-executor bindings, exact transfer helpers, and existing replay mappings.
- Produces:
  - `PegCycleReturnEscrow(address coordinator, address usdg, address hook, address routeExecutor, bytes32 cycleId)`.
  - `PegCycleReturnEscrow.sendOutbound(uint256 amount)` and `sendPayout(uint256 amount)`, callable only by its coordinator and targeting only immutable destinations.
  - `PegCycleVault.computeCycleEscrow(bytes32 cycleId) -> address`.
  - `PegCycleVault.authorizeFundingAfterFailure(FundingAuthorization next, bytes32 failedCycleId, bytes32 failureReceiptDigest)`.
  - `PegCycleVault.cancelExpiredFundingAuthorization(bytes32 cycleId)`.
  - `PegCycleVault.renewFundingAuthorizationDeadline(FundingAuthorization renewal)`.
  - `PegCycleVault.renewPayoutAuthorizationDeadline(PayoutAuthorization renewal)`.
  - Historical `cycleEscrows`, `cycleLifecycles`, and `failureReceiptDigests` reads keyed by cycle identifier.

- [ ] **Step 1: Write the failing isolation and lifecycle tests**

Replace shared-vault balance assertions with the predicted escrow and add focused tests equivalent to:

```solidity
function test_failedCycleCanBeFollowedByFreshIsolatedCycle() external {
    (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
    address escrowOne = vault.computeCycleEscrow(CYCLE_ONE);
    vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route()));
    usdg.mint(address(hook), 250);
    hook.fund(CYCLE_ONE, OPERATIONS);
    assert(usdg.balanceOf(escrowOne) == 250);
    VM.prank(OPERATIONS);
    vault.executeOutbound(CYCLE_ONE, _route());
    vault.recordTerminalFailure(CYCLE_ONE, FAILURE_RECEIPT_DIGEST);

    IPegCycleVault.FundingAuthorization memory next =
        _auth(usdg, vault, hook, CYCLE_TWO, 100, 2, _route());
    address escrowTwo = vault.computeCycleEscrow(CYCLE_TWO);
    assert(escrowTwo != escrowOne);
    vault.authorizeFundingAfterFailure(next, CYCLE_ONE, FAILURE_RECEIPT_DIGEST);
    usdg.mint(address(hook), 100);
    hook.fund(CYCLE_TWO, OPERATIONS);
    usdg.mint(escrowOne, 77);

    assert(usdg.balanceOf(escrowOne) == 77);
    assert(usdg.balanceOf(escrowTwo) == 100);
    assert(vault.failureReceiptDigests(CYCLE_ONE) == FAILURE_RECEIPT_DIGEST);
}

function test_expiredPendingAuthorizationCanBeDiscardedWithoutReusingIdentity() external {
    (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
    IPegCycleVault.FundingAuthorization memory auth =
        _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
    auth.expiresAt = uint64(block.timestamp + 1);
    vault.authorizeFunding(auth);
    VM.warp(block.timestamp + 2);
    vault.cancelExpiredFundingAuthorization(CYCLE_ONE);
    assert(vault.readPendingAuthorization().cycleId == bytes32(0));
    assert(vault.isCycleConsumed(CYCLE_ONE));
    assert(vault.isNonceConsumed(1));
    _reject(vault, auth);
}
```

Add a payout-contamination test: send late USDG to escrow A after A fails, complete outbound for B, and prove B's payout authorization accepts only B's exact escrow balance. Add negative cases for ordinary funding authorization in `FAILED`, wrong failed predecessor, wrong failure receipt digest, an already-bound successor, same cycle/nonce reuse, wrong predicted return destination, prefunded escrow, cancellation before expiry, cancellation while funding, and arbitrary escrow selectors.

- [ ] **Step 2: Write the failing exact-renewal tests**

Add tests that create an expired `FUNDED` authorization and expired `RETURNED` payout authorization, then accept only these exact renewals:

```solidity
IPegCycleVault.FundingAuthorization memory fundingRenewal = vault.readActiveAuthorization();
fundingRenewal.expiresAt = uint64(block.timestamp + 1 days);
fundingRenewal.nonce = 11;
vault.renewFundingAuthorizationDeadline(fundingRenewal);

IPegCycleVault.PayoutAuthorization memory payoutRenewal = expiredPayout;
payoutRenewal.expiresAt = uint64(block.timestamp + 1 days);
payoutRenewal.nonce = 12;
vault.renewPayoutAuthorizationDeadline(payoutRenewal);
```

For each struct, mutate every other field one at a time and assert revert plus unchanged storage. Also reject wrong caller, zero/reused nonce, nonfuture deadline, renewal before the matching lifecycle, and funding renewal in `OUTBOUND`. Assert both accepted renewals preserve the cycle and escrow and move no USDG.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/process/*.t.sol' -vvv
```

Expected: compilation or assertion failures because the escrow and lifecycle APIs do not exist and current funding targets the shared vault.

- [ ] **Step 4: Implement the narrow immutable escrow**

Create the escrow with no arbitrary recipient surface:

```solidity
contract PegCycleReturnEscrow {
    address public immutable coordinator;
    address public immutable usdg;
    address public immutable hook;
    address public immutable routeExecutor;
    bytes32 public immutable cycleId;

    constructor(
        address coordinator_,
        address usdg_,
        address hook_,
        address routeExecutor_,
        bytes32 cycleId_
    ) {
        if (
            coordinator_ == address(0) || coordinator_.code.length == 0
                || usdg_ == address(0) || usdg_.code.length == 0
                || hook_ == address(0) || hook_.code.length == 0
                || routeExecutor_ == address(0) || routeExecutor_.code.length == 0
                || cycleId_ == bytes32(0) || coordinator_ == usdg_ || coordinator_ == hook_
                || coordinator_ == routeExecutor_ || hook_ == routeExecutor_
        ) revert InvalidIdentity();
        coordinator = coordinator_;
        usdg = usdg_;
        hook = hook_;
        routeExecutor = routeExecutor_;
        cycleId = cycleId_;
    }

    function sendOutbound(uint256 amount) external {
        if (msg.sender != coordinator) revert UnauthorizedCaller();
        _transferExact(routeExecutor, amount);
    }

    function sendPayout(uint256 amount) external {
        if (msg.sender != coordinator) revert UnauthorizedCaller();
        _transferExact(hook, amount);
    }
}
```

In `PegCycleVault`, compute the address from `CREATE2` salt `cycleId` and the exact constructor bytecode. On funding authorization, require `authorization.returnDestination == computeCycleEscrow(cycleId)`, deploy exactly that escrow if absent, verify its immutable identity, and bind `cycleEscrows[cycleId]` once.

`consumeFundingAuthorization` reads the named escrow balance and requires zero before the hook transfer. `confirmFunding` requires an exact increase equal to `authorization.amount`. `executeOutbound` asks that escrow to transfer the exact amount to the immutable route executor, then calls the existing typed executor with the same escrow as return destination. Payout authorization and consumption read and debit only the active escrow.

Change the hook funding destination only:

```solidity
_debitProcessLiability(auth.amount);
_transferExactUsdg(auth.returnDestination, auth.amount);
pegCycleVault.confirmFunding(cycleId, balanceBefore);
```

On payout commitment or terminal failure, write the cycle-keyed terminal record and close the active slot. After `PAYOUT_COMMITTED`, the ordinary authorization path may accept a fresh cycle. After `FAILED`, only `authorizeFundingAfterFailure` may accept a fresh cycle, and it must match the exact current failed cycle and stored failure receipt digest before recording the predecessor-to-successor binding. Keep every prior escrow deployed and inaccessible except through its already terminal coordinator state. If an unfunded recovery authorization expires, pending cleanup also clears that predecessor's pending successor pointer without making the expired cycle or nonce reusable.

- [ ] **Step 5: Implement pending cleanup and exact-only renewal**

Add the interface methods and make the comparison explicit by hashing the authorization without its two renewable fields:

```solidity
function _fundingSubjectDigest(FundingAuthorization memory value)
    private pure returns (bytes32)
{
    value.expiresAt = 0;
    value.nonce = 0;
    return keccak256(abi.encode(value));
}

function _payoutSubjectDigest(PayoutAuthorization memory value)
    private pure returns (bytes32)
{
    value.expiresAt = 0;
    value.nonce = 0;
    return keccak256(abi.encode(value));
}
```

`cancelExpiredFundingAuthorization` requires the named pending record, `block.timestamp >= expiresAt`, and no funding in progress. Delete only the pending record and emit `ExpiredFundingAuthorizationCancelled`; leave cycle, nonce, and escrow consumption unchanged.

Each renewal is authorizer-only, requires its exact lifecycle, a future deadline, and an unused nonzero nonce, compares the subject digest with the stored authorization, consumes the new nonce, replaces only `expiresAt` and `nonce`, recomputes the full stored authorization digest where applicable, and emits a renewal event. It must not transfer tokens or call the executor or hook.

- [ ] **Step 6: Run focused contract tests and confirm GREEN**

Run:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/process/*.t.sol' -vvv
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts --match-path 'test/payout/PayoutCommitment.t.sol' -vvv
```

Expected: all selected tests pass; Operations and the coordinator end with zero cycle USDG, while each nonterminal escrow holds only its own exact balance.

- [ ] **Step 7: Update frozen interfaces and module cards**

Record the escrow constructor and selectors, coordinator reads and renewals, new funding destination, invariants, transitions, operational commands, and recovery behavior. State explicitly that late failed-cycle funds remain quarantined and renewal is not an external retry.

- [ ] **Step 8: Inspect the diff and commit**

Run:

```sh
git diff --check
git diff -- packages/contracts architecture/interfaces.json docs/modules/peg-cycle-vault.md docs/modules/process-budget.md
git status --short
git add packages/contracts architecture/interfaces.json docs/modules/peg-cycle-vault.md docs/modules/process-budget.md
git commit -m "feat(custody): isolate peg cycle returns"
```

---

### Task 2: Freeze a manually selected pack and cycle plan

**Files:**
- Create: `packages/runner/src/operator/pack-selection.mjs`
- Create: `packages/runner/src/operator/cycle-plan.mjs`
- Create: `packages/runner/test/operator/pack-selection.test.mjs`
- Create: `packages/runner/test/operator/cycle-plan.test.mjs`
- Modify: `packages/runner/src/cycle/bindings.mjs`
- Modify: `packages/runner/src/cycle/collector.mjs`
- Modify: `packages/runner/src/cycle/schemas.mjs`
- Modify: `packages/runner/src/cycle/preflight.mjs`
- Modify: `packages/runner/src/cycle/reducer.mjs`
- Modify: `packages/runner/test/cycle/bindings-state-machine.test.mjs`
- Modify: `packages/runner/test/cycle/collector-sequence.test.mjs`
- Modify: `packages/runner/test/cycle/fixture-cycle.mjs`
- Modify: `packages/runner/test/cycle/security.test.mjs`
- Modify: `docs/modules/cycle-runner.md`

**Interfaces:**
- Consumes: `canonicalJson`, `digest`, existing bounded canonical-value checks, current fixed source chain and Solana binding, and `PegCycleVault.computeCycleEscrow` output supplied as `returnAccount`.
- Produces:
  - `createPackSnapshot({ source, observedAt, sourcePayloadDigest, packs })`.
  - `selectPack(snapshot, packCode)`.
  - `createCycleDraft(input)`, `reviseCycleDraft(draft, patch)`, and `freezeCycleDraft(draft, snapshot)`.
  - `assertFrozenCyclePlan(value)` and `assertFrozenPlanBinding(plan, binding)`.

- [ ] **Step 1: Write failing pack snapshot and freeze tests**

Create tests with two packs and prove exact selection and immutability:

```js
const snapshot = createPackSnapshot({
  source: 'collector',
  observedAt: '2029-01-01T00:00:00.000Z',
  sourcePayloadDigest: `sha256:${'1'.repeat(64)}`,
  packs: [{ code: 'collector-crypt' }, { code: 'collector-ember' }],
});
assert.equal(selectPack(snapshot, 'collector-ember').pack, 'collector-ember');
assert.throws(() => selectPack(snapshot, 'missing-pack'), /snapshot/i);

const draft = createCycleDraft(validDraft({
  cycleId: 'cycle-two',
  authorizationNonce: '2',
  packSnapshotDigest: snapshot.snapshotDigest,
  pack: 'collector-ember',
  returnAccount: '0x0000000000000000000000000000000000002002',
}));
const revised = reviseCycleDraft(draft, { amount: '25' });
const frozen = freezeCycleDraft(revised, snapshot);
assert.equal(frozen.amount, '25');
assert.throws(() => reviseCycleDraft(frozen, { amount: '26' }), /frozen/i);
```

Also reject duplicate/unsorted/unknown pack records, changed snapshot bytes with retained digest, unknown draft fields, invalid cycle or nonce, nonpositive money values, wrong return escrow, quantity other than one, turbo mode, a pack from another snapshot, and every post-freeze edit.

- [ ] **Step 2: Write failing runner binding tests for a second selected pack**

Use `collector-ember` in one complete fixture path and assert that request, mutation authorization, generated response, signed status, open request, and reducer state all retain that exact pack. Add adversarial cases where any one record substitutes `collector-crypt` or another snapshot digest.

Change custody tests so `cycleVaultAccount` is the coordinator and `returnAccount` is a distinct predicted escrow. Reject Operations, policy account, hook, coordinator, zero/invalid identity, or another cycle's escrow as the return account.

- [ ] **Step 3: Run the focused Node tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/operator/pack-selection.test.mjs packages/runner/test/operator/cycle-plan.test.mjs packages/runner/test/cycle/bindings-state-machine.test.mjs packages/runner/test/cycle/collector-sequence.test.mjs
```

Expected: missing-module failures and hardcoded `collector-crypt` / shared-return-account assertion failures.

- [ ] **Step 4: Implement closed pack artifacts and frozen plans**

Use closed schemas and return frozen clones:

```js
export function createPackSnapshot(input) {
  const verified = assertPackSnapshotInput(input);
  const body = { schema: 'hookemon.pack-snapshot.v1', ...verified };
  return Object.freeze({ ...body, snapshotDigest: digest({ domain: body.schema, snapshot: body }) });
}

export function freezeCycleDraft(draft, snapshot) {
  const exactDraft = assertCycleDraft(draft);
  const exactSnapshot = assertPackSnapshot(snapshot);
  if (exactDraft.packSnapshotDigest !== exactSnapshot.snapshotDigest) throw new Error('cycle draft pack snapshot mismatch');
  selectPack(exactSnapshot, exactDraft.pack);
  const body = { ...exactDraft, schema: 'hookemon.frozen-cycle-plan.v1' };
  return deepFreeze({ ...body, planDigest: digest({ domain: body.schema, plan: body }) });
}
```

`reviseCycleDraft` accepts only the explicit draft-editable keys and always revalidates the whole candidate. `assertFrozenCyclePlan` recomputes the digest and rejects accessors, decorated arrays, unknown keys, or a mutable/noncanonical clone. Keep decimal money values as canonical positive strings.

- [ ] **Step 5: Generalize only the selected pack and isolated return binding**

Remove the literal `collector-crypt` checks from reusable validators. Keep the identifier grammar, quantity one, turbo false, fixed chain, cluster, mint, wallet, and refund-owner rules. Verify authority at the plan seam:

```js
export function assertFrozenPlanBinding(planValue, bindingValue) {
  const plan = assertFrozenCyclePlan(planValue);
  const binding = validateBinding(bindingValue);
  if (binding.pack !== plan.pack) throw new Error('binding pack differs from frozen cycle plan');
  if (plan.returnAccount === plan.cycleVaultAccount) throw new Error('cycle return escrow must differ from coordinator');
  return { plan, binding };
}
```

Build Collector fixture responses with `exactBinding.pack`; validate any syntactically valid selected pack, then require equality with the frozen plan and preceding records in reducer transitions. Change `validateCycleCustody` to require the return escrow to be distinct from Operations, policy account, and coordinator while retaining the coordinator as `cycleVaultAccount`.

- [ ] **Step 6: Run focused runner tests and confirm GREEN**

Run the Step 3 command, then:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/cycle/*.test.mjs
```

Expected: all cycle and operator-selection tests pass for both pack fixtures, and every cross-snapshot or cross-escrow substitution fails.

- [ ] **Step 7: Update the cycle-runner module card and commit**

Document manual snapshot selection, pre-freeze editing, immutable plan digest, selected-pack propagation, distinct return escrow, and unchanged reconciliation rules. Remove claims that the runner always uses the literal `collector-crypt`; retain fixture-only and production `INTEGRATION_PENDING` warnings.

Run:

```sh
git diff --check
git diff -- packages/runner/src/operator packages/runner/src/cycle packages/runner/test/operator packages/runner/test/cycle docs/modules/cycle-runner.md
git status --short
git add packages/runner/src/operator packages/runner/src/cycle packages/runner/test/operator packages/runner/test/cycle docs/modules/cycle-runner.md
git commit -m "feat(runner): freeze manual pack selection"
```

---

### Task 3: Add one atomic local operator state and CLI

**Files:**
- Create: `packages/runner/src/operator/state-file.mjs`
- Create: `packages/runner/src/operator/control.mjs`
- Create: `packages/runner/src/operator/cli.mjs`
- Create: `packages/runner/test/operator/state-file.test.mjs`
- Create: `packages/runner/test/operator/control.test.mjs`
- Create: `packages/runner/test/operator/cli.test.mjs`
- Modify: `packages/runner/src/cycle/cycle-runner.mjs`
- Modify: `packages/runner/test/cycle/runner.test.mjs`
- Modify: `docs/modules/cycle-runner.md`

**Interfaces:**
- Consumes: Task 2 pack/plan functions, `FixtureCycleStore.snapshot/reopen`, `CycleRunner.recover`, current journal CAS, reducer stage, and fixture verification functions.
- Produces:
  - `readOperatorState(path)` and `mutateOperatorState(path, expectedRevision, mutation)`.
  - `OperatorControl.prepare`, `freeze`, `start`, `status`, `resume`, and `reconcile`.
  - `CycleRunner.inspect()` with no mutation.
  - Local CLI commands `packs list`, `cycle prepare`, `cycle freeze`, `cycle start`, `cycle status`, `cycle resume`, and `cycle reconcile`.

- [ ] **Step 1: Write failing atomic-file tests**

Use `mkdtemp` and verify creation, reopen, stale revision rejection, lock contention, corrupted JSON rejection, symlink rejection, restrictive file mode, and recovery after an interrupted temporary write:

```js
const initial = await mutateOperatorState(path, null, () => emptyOperatorState());
assert.equal(initial.revision, 0);
const next = await mutateOperatorState(path, 0, state => ({ ...state, draft: validDraft() }));
assert.equal(next.revision, 1);
await assert.rejects(
  mutateOperatorState(path, 0, state => state),
  /stale operator state revision/i,
);
assert.deepEqual(await readOperatorState(path), next);
```

Assert bytes are canonical JSON plus one newline, the state file is mode `0600`, a `.lock` file is created with exclusive `wx`, the temporary file is in the same directory, the file and directory are synced before success, and lock cleanup never deletes a lock owned by another process.

- [ ] **Step 2: Write failing control and CLI tests**

Cover this exact sequence:

```text
import snapshot -> prepare draft -> revise draft -> freeze -> start
-> persist journal -> simulate restart -> resume same cycle
-> expose unresolved request -> reconcile same request
-> record verified terminal failure -> prepare fresh cycle
```

Assert the restarted controller retains the same `cycleId`, `planDigest`, journal version, journal head, consumed authorizations, and receipts. Reject a second active cycle, a changed frozen field, changed snapshot, reused cycle identifier, reused nonce, unverified failure flag, and any attempt to prepare new while the old cycle is nonterminal.

For CLI tests, invoke the Node process with fixture files and assert stdout contains canonical JSON status only, stderr contains bounded diagnostics, exit `0` means success, exit `2` means safe reconciliation or new authorization is required, and exit `1` means invalid input. Search the operator source and reject imports or strings for `fetch`, `http`, `https`, wallet, signer, private key, send transaction, scheduler, server, or database APIs.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/operator/state-file.test.mjs packages/runner/test/operator/control.test.mjs packages/runner/test/operator/cli.test.mjs packages/runner/test/cycle/runner.test.mjs
```

Expected: missing-module and missing-`inspect` failures.

- [ ] **Step 4: Implement the strict atomic state adapter**

Use only `node:fs/promises`, `node:path`, and existing canonical JSON helpers. The exact persisted shape is:

```js
{
  schema: 'hookemon.operator-state.v1',
  revision: 0,
  packSnapshot: null,
  draft: null,
  frozenPlan: null,
  activeCycleId: null,
  terminalCycles: [],
  cycleStore: { schema: 'hookemon.fixture-cycle-store.v1', cycles: [], authorizations: [], receipts: [] },
}
```

Validate the whole state before and after mutation. Refuse symlinks and nonregular files. Create the lock with `open(lockPath, 'wx', 0o600)`, include a random ownership token in it, write and `sync()` a same-directory temporary file with mode `0600`, rename it over the state file, sync the containing directory, then unlink only the lock whose token still matches. Never recover by guessing from a partial file.

- [ ] **Step 5: Implement the minimal controller and read-only inspection**

Add a read-only runner projection:

```js
inspect() {
  const unresolved = [...this.#state.externalMutations.entries()]
    .filter(([, attempt]) => attempt.status === 'unresolved')
    .map(([requestDigest]) => requestDigest);
  return Object.freeze({
    cycleId: this.#journal.cycleId,
    stage: this.#state.stage,
    version: this.#state.version,
    journalHead: this.#state.head,
    unresolvedRequestDigest: unresolved.length === 1 ? unresolved[0] : null,
  });
}
```

`OperatorControl.start` requires one frozen plan, no active cycle, and a matching empty or recovered cycle-store record. `resume` always calls `FixtureCycleStore.reopen(state.cycleStore)` and `CycleRunner.recover` with entries from that exact cycle. `reconcile` accepts only a verified fixture evidence bundle for the unresolved request digest and persists the resulting journal/store snapshot with expected state revision.

Terminal state import accepts a verified contract observation with exact cycle, escrow, lifecycle, and nonzero terminal digest. Only `PAYOUT_COMMITTED` or `FAILED` clears `activeCycleId`; all prior cycle identifiers and authorization nonces remain in terminal summaries and are rejected for new drafts.

`status` derives one allowed next operation:

```text
draft -> freeze
frozen with no active cycle -> start
active with unresolved request -> reconcile
active without unresolved request -> resume
terminal -> prepare-new
```

- [ ] **Step 6: Implement the dependency-free CLI**

Parse a closed command and flag allowlist without a third-party package. Require absolute state and input paths, reject duplicate/unknown flags, read no environment credentials, and never load a network adapter. Each command delegates to `OperatorControl`, prints one canonical result to stdout, and maps invalid input, safe stop, and success to the tested exit codes.

- [ ] **Step 7: Run focused and complete runner tests**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/operator/*.test.mjs
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/cycle/*.test.mjs packages/runner/test/distribution/*.test.mjs
```

Expected: all tests pass with no network, credential, signing, broadcast, database, or scheduler dependency.

- [ ] **Step 8: Update the module card and commit**

Add the CLI commands, state-file schema, one-active-cycle invariant, exact resume/reconcile behavior, terminal-cycle handoff, operational commands, and corruption/lock recovery pointers.

Run:

```sh
git diff --check
git diff -- packages/runner/src/operator packages/runner/src/cycle/cycle-runner.mjs packages/runner/test/operator packages/runner/test/cycle/runner.test.mjs docs/modules/cycle-runner.md
git status --short
git add packages/runner/src/operator packages/runner/src/cycle/cycle-runner.mjs packages/runner/test/operator packages/runner/test/cycle/runner.test.mjs docs/modules/cycle-runner.md
git commit -m "feat(operator): add durable cycle controls"
```

---

### Task 4: Verify the complete lean Phase 2 boundary

**Files:**
- Modify: `scripts/tests/final-review.test.mjs`
- Modify: `scripts/tests/delivery-boundary.test.mjs`
- Create: `qa/reviews/phase2-operator-control-local-verification.json`
- Modify: the Phase 2 task cards and module index required by approved requirements revision `57`.

**Interfaces:**
- Consumes: Tasks 1-3, approved Phase 2 requirements and ADR-0020.
- Produces: machine-checked evidence that the exact owner-approved scope exists and excluded surfaces do not.

- [ ] **Step 1: Add failing boundary assertions**

Assert that the normative spec, ADR, module cards, frozen interfaces, and code contain manual pack selection, canonical freeze, same-cycle recovery, fresh-cycle-after-failure, unique cycle escrow, pending cleanup, and exact-only deadline renewal. Reject active Phase 2 obligations or runtime imports for dashboard, scheduler, automatic selection, concurrent cycles, database, production signer, or broadcast.

The boundary test must also assert that `verifyProductionCollectorIntegration()` and `verifyProductionProviderReceipt()` still throw `INTEGRATION_PENDING`.

- [ ] **Step 2: Run boundary tests and confirm RED**

Run:

```sh
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test scripts/tests/final-review.test.mjs scripts/tests/delivery-boundary.test.mjs
```

Expected: failure until task cards, module index, and final scope assertions are synchronized.

- [ ] **Step 3: Synchronize only the approved documentation and task evidence**

Update affected module/task artifacts with current-state language. Do not revive the deleted read-model direction, do not claim production integration, and do not mark any external action complete. Record actual focused command outputs, tool versions, commit identities, and evidence class `LOCAL_ONLY` in `qa/reviews/phase2-operator-control-local-verification.json`.

- [ ] **Step 4: Run the final local verification once**

Run:

```sh
OPENSSL_CONF=/dev/null HOOKEMON_SOLC_BINARY=/private/tmp/p1-004-solc-0.8.26 forge test --root packages/contracts -vv
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test packages/runner/test/cycle/*.test.mjs packages/runner/test/distribution/*.test.mjs packages/runner/test/operator/*.test.mjs
OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node --test scripts/tests/final-review.test.mjs scripts/tests/delivery-boundary.test.mjs scripts/tests/reqs.test.mjs
```

Expected: every command passes. Treat Foundry cache-write warnings outside the sandbox as warnings only when the command exits zero and all tests pass.

- [ ] **Step 5: Review scope and commit**

Run:

```sh
git diff --check
git status --short
git diff --stat
git log -4 --oneline
git add scripts/tests qa/reviews tasks docs/modules
git commit -m "test(phase2): verify manual cycle control"
```

Confirm before committing that the staged diff contains no generated state, receipts, secrets, deployment artifact, production address, unrelated refactor, dashboard, scheduler, database, signer, broadcast path, or pushed remote state.
