// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Blind adversarial tests for claimProcess/claimProgrammable/claimTreasury and the
// Operations/Treasury role machinery (requirements.json rev 62, spec statements (2) and (3)).
// Setup mirrors the CREATE2-mining / mock-token *pattern* used in test/access/ProcessClaims.t.sol,
// but every oracle value below is computed independently from the specification text, and several
// scenarios here (cross-function reentrancy across the three claim streams, a former-Treasury
// address's standing ability to claim what it already accrued, fuzzed third-party destinations)
// are not covered by that file.

import { Test } from "@uniswap/v4-core/lib/forge-std/src/Test.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";

import { FeeAccounting } from "../../../src/accounting/FeeAccounting.sol";
import { MoneyRoles } from "../../../src/access/MoneyRoles.sol";
import { RobinhoodBindings } from "../../../src/bindings/RobinhoodBindings.sol";
import { HookemonHook } from "../../../src/HookemonHook.sol";

/// @dev A mock USDG whose `transfer` can be armed to make one outbound call to an arbitrary
///      target/payload before returning, used to mount reentrancy attempts (self- and
///      cross-function) against the money path lock.
contract ReentryToken {
    mapping(address account => uint256 balance) private balances;
    bool private armed;
    address private target;
    bytes private payload;

    error ReentryCallReverted();

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function burn(address account, uint256 amount) external {
        balances[account] -= amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function arm(address reentryTarget, bytes calldata reentryPayload) external {
        target = reentryTarget;
        payload = reentryPayload;
        armed = true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[recipient] += amount;
        if (armed) {
            armed = false;
            (bool ok,) = target.call(payload);
            if (!ok) revert ReentryCallReverted();
        }
        return true;
    }
}

contract ClaimsBlindHookHarness is HookemonHook {
    ReentryToken private immutable token;

    constructor(HookemonHook.ConstructorConfig memory config, ReentryToken configuredToken)
        HookemonHook(config)
    {
        token = configuredToken;
    }

    function accrueForTest(uint256 executedUsdg) external moneyPath {
        uint256 fee = _previewTotalFee(executedUsdg);
        uint256 balanceBeforeCollection = _hookUsdgBalance();
        token.mint(address(this), fee);
        _accrueAuthenticatedSwap(executedUsdg, balanceBeforeCollection);
    }
}

contract ClaimsBlindFactory {
    HookemonHook.ConstructorConfig private config;
    ReentryToken private immutable token;

    constructor(HookemonHook.ConstructorConfig memory configured, ReentryToken configuredToken) {
        config = configured;
        token = configuredToken;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(type(ClaimsBlindHookHarness).creationCode, abi.encode(config, token))
        );
    }

    function deploy(bytes32 salt) external returns (ClaimsBlindHookHarness) {
        return new ClaimsBlindHookHarness{ salt: salt }(config, token);
    }
}

/// @dev Generic actor used both as a claim caller and, via `vm.etch`, to occupy the pinned
///      Programmable-beneficiary address so the reentrancy tests can drive it.
contract ClaimActor {
    function claimProcess(HookemonHook hook, bytes32 cycleId, uint256 amount) external {
        hook.claimProcess(cycleId, amount, address(this));
    }

    function claimTreasury(HookemonHook hook, uint256 amount) external {
        hook.claimTreasury(amount, address(this));
    }

    function claimProgrammable(HookemonHook hook, uint256 amount) external {
        hook.claimProgrammable(amount, address(this));
    }
}

contract ClaimsAdversarialBlindTest is Test {
    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    uint256 private constant WINDOW = 21_600;
    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0xC100);
    address private constant OPERATIONS = address(0xC200);
    address private constant UNRELATED = address(0xC300);
    bytes32 private constant CYCLE_A = keccak256("blind-cycle-a");
    bytes32 private constant CYCLE_B = keccak256("blind-cycle-b");
    bytes32 private constant CYCLE_C = keccak256("blind-cycle-c");

    ReentryToken private token;

    function setUp() external {
        vm.warp(5_000_000);
        token = new ReentryToken();
    }

    // ---------------------------------------------------------------------
    // Double-claim / cycle reuse.
    // ---------------------------------------------------------------------

    function testSameCycleIdCannotBeClaimedTwiceEvenWithinTheSameBlock() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 1_000, 1_000, 4, 1 days);
        _accrue(hook, 100_000);

        _claimAs(OPERATIONS, hook, CYCLE_A, 10);
        vm.expectRevert(HookemonHook.ProcessClaimCycleAlreadyUsed.selector);
        _claimAs(OPERATIONS, hook, CYCLE_A, 10);
        assertEq(hook.remainingProcessClaimCapacity(), 990);
    }

    // ---------------------------------------------------------------------
    // Exact six-hour window boundary (independent numbers from ProcessClaims.t.sol).
    // ---------------------------------------------------------------------

    function testWindowEntryIsActiveAtWindowMinusOneAndExpiredAtExactlyWindow() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 777, 777, 4, 1 days);
        _accrue(hook, 1_000_000);
        _claimAs(OPERATIONS, hook, CYCLE_A, 500);

        vm.warp(block.timestamp + WINDOW - 1);
        assertEq(hook.remainingProcessClaimCapacity(), 277, "entry must still count at window-1");
        vm.expectRevert(HookemonHook.ProcessClaimCapacityExceeded.selector);
        _claimAs(OPERATIONS, hook, CYCLE_B, 278);

        vm.warp(block.timestamp + 1);
        assertEq(hook.remainingProcessClaimCapacity(), 777, "entry must expire at exactly window");
        _claimAs(OPERATIONS, hook, CYCLE_B, 777);
    }

    // ---------------------------------------------------------------------
    // At most N retained active entries.
    // ---------------------------------------------------------------------

    function testFuzz_NPlusOneEntriesRejectedUntilAnExpires(uint8 rawMaxCount) external {
        uint256 maxCount = bound(uint256(rawMaxCount), 1, 6);
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 1_000_000, 1_000_000, maxCount, 1 days);
        _accrue(hook, 100_000_000);

        for (uint256 i; i < maxCount; ++i) {
            _claimAs(OPERATIONS, hook, keccak256(abi.encode("fuzz-entry", i)), 1);
        }
        vm.expectRevert(HookemonHook.ProcessClaimEntryLimitReached.selector);
        _claimAs(OPERATIONS, hook, keccak256("fuzz-entry-overflow"), 1);

        vm.warp(block.timestamp + WINDOW);
        // After every prior entry expires, a fresh claim must succeed again.
        _claimAs(OPERATIONS, hook, keccak256("fuzz-entry-after-expiry"), 1);
    }

    // ---------------------------------------------------------------------
    // Limit increase cannot activate before the full six-hour delay elapses.
    // ---------------------------------------------------------------------

    function testScheduledLimitIncreaseCannotBeUsedOneSecondEarly() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 50, 900, 4, 1 days);
        _accrue(hook, 1_000_000);
        uint256 scheduledAt = block.timestamp;

        vm.prank(TREASURY);
        hook.setProcessClaimLimit(900);
        assertEq(hook.activeProcessClaimLimit(), 50, "increase must not be active immediately");

        vm.warp(scheduledAt + WINDOW - 1);
        assertEq(hook.activeProcessClaimLimit(), 50, "increase activated one second early");
        vm.expectRevert(HookemonHook.ProcessClaimCapacityExceeded.selector);
        _claimAs(OPERATIONS, hook, CYCLE_A, 51);

        vm.warp(scheduledAt + WINDOW);
        assertEq(hook.activeProcessClaimLimit(), 900, "increase failed to activate exactly on time");
        _claimAs(OPERATIONS, hook, CYCLE_A, 51);
    }

    function testScheduledIncreaseAboveImmutableMaximumIsRejected() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 50, 900, 4, 1 days);
        vm.prank(TREASURY);
        vm.expectRevert(HookemonHook.ProcessClaimLimitExceedsMaximum.selector);
        hook.setProcessClaimLimit(901);
    }

    // ---------------------------------------------------------------------
    // Emergency Operations rotation: cannot be cancelled or defeated by Operations.
    // ---------------------------------------------------------------------

    function testOperationsCannotScheduleOrExecuteItsOwnRotation() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 100, 100, 4, 1 hours);
        vm.prank(OPERATIONS);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.scheduleOperationsRotation(address(0xD000));

        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(address(0xD000));
        vm.prank(OPERATIONS);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.executeOperationsRotation();
    }

    function testOperationsCannotSelfRotateAwayFromAPendingEmergencyRotation() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 100, 100, 4, 1 hours);
        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(address(0xD000));

        vm.prank(OPERATIONS);
        vm.expectRevert(HookemonHook.OperationsRotationPending.selector);
        hook.proposeOperations(address(0xD111));

        (MoneyRoles.RoleState memory roles,,,) = hook.readRoles(bytes32(0));
        assertEq(roles.operations, OPERATIONS, "pending rotation must not have moved control yet");
    }

    function testEmergencyRotationAutoPausesAndOperationsCannotUnpause() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 100, 100, 4, 1 hours);
        assertFalse(hook.processClaimsPaused());
        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(address(0xD000));
        assertTrue(hook.processClaimsPaused(), "rotation must auto-pause claims");

        // Operations has no pause-control entry point at all (only Treasury does); confirm the
        // paused state survives an attempted claim.
        _accrue(hook, 10_000);
        vm.expectRevert(HookemonHook.ProcessClaimsArePaused.selector);
        _claimAs(OPERATIONS, hook, CYCLE_A, 1);
    }

    // ---------------------------------------------------------------------
    // Claims during pause revert (manual pause path).
    // ---------------------------------------------------------------------

    function testManualPauseBlocksProcessClaimsAndUnpauseRestoresThem() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 100, 100, 4, 1 days);
        _accrue(hook, 10_000);

        vm.prank(TREASURY);
        hook.pauseProcessClaims();
        vm.expectRevert(HookemonHook.ProcessClaimsArePaused.selector);
        _claimAs(OPERATIONS, hook, CYCLE_A, 1);

        vm.prank(TREASURY);
        hook.unpauseProcessClaims();
        _claimAs(OPERATIONS, hook, CYCLE_A, 1);
    }

    // ---------------------------------------------------------------------
    // Destination must equal msg.sender for process claims (fuzzed destinations).
    // ---------------------------------------------------------------------

    function testFuzz_ProcessClaimToThirdPartyDestinationAlwaysReverts(address destination)
        external
    {
        vm.assume(destination != OPERATIONS);
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 1_000, 1_000, 4, 1 days);
        _accrue(hook, 10_000);

        vm.prank(OPERATIONS);
        vm.expectRevert(MoneyRoles.InvalidDestination.selector);
        hook.claimProcess(CYCLE_A, 1, destination);
        assertFalse(hook.processClaimCycleUsed(CYCLE_A));
    }

    // ---------------------------------------------------------------------
    // Cross-role authorization: only the pinned beneficiary/current-Treasury/current-Operations
    // may call their respective claim entry point.
    // ---------------------------------------------------------------------

    function testTreasuryCannotClaimProgrammableAndProgrammableCannotClaimTreasury() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 1_000, 1_000, 4, 1 days);
        _accrue(hook, 1_000_000);

        vm.prank(TREASURY);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.claimProgrammable(1, TREASURY);

        // PROGRAMMABLE was never a recognized treasury beneficiary, so this fails the
        // beneficiary-registration check before the caller-identity check ever runs.
        vm.prank(PROGRAMMABLE);
        vm.expectRevert(MoneyRoles.InvalidRoleBeneficiary.selector);
        hook.claimTreasury(1, PROGRAMMABLE);
    }

    function testOperationsCannotClaimTreasuryOrProgrammableAndTheyCannotClaimProcess() external {
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 1_000, 1_000, 4, 1 days);
        _accrue(hook, 1_000_000);

        // OPERATIONS was never a recognized treasury beneficiary, so this fails the
        // beneficiary-registration check before the caller-identity check ever runs.
        vm.prank(OPERATIONS);
        vm.expectRevert(MoneyRoles.InvalidRoleBeneficiary.selector);
        hook.claimTreasury(1, OPERATIONS);
        vm.prank(OPERATIONS);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.claimProgrammable(1, OPERATIONS);

        vm.prank(TREASURY);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.claimProcess(CYCLE_A, 1, TREASURY);
        vm.prank(PROGRAMMABLE);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.claimProcess(CYCLE_A, 1, PROGRAMMABLE);
    }

    // ---------------------------------------------------------------------
    // Reentrancy: self- and cross-function, must be blocked atomically.
    // ---------------------------------------------------------------------

    function testReentrantProcessClaimDuringItsOwnTransferIsBlockedAtomically() external {
        ClaimActor actor = new ClaimActor();
        ClaimsBlindHookHarness hook = _deploy(address(actor), 1_000, 1_000, 4, 1 days);
        _accrue(hook, 100_000);
        token.arm(address(actor), abi.encodeCall(ClaimActor.claimProcess, (hook, CYCLE_B, 1)));

        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        actor.claimProcess(hook, CYCLE_A, 1);

        assertEq(hook.processLiability(), 2_500, "process liability must roll back");
        assertFalse(hook.processClaimCycleUsed(CYCLE_A));
        assertFalse(hook.processClaimCycleUsed(CYCLE_B));
        assertEq(token.balanceOf(address(actor)), 0);
    }

    function testReentrantTreasuryClaimDuringItsOwnTransferIsBlockedAtomically() external {
        ClaimActor actor = new ClaimActor();
        ClaimsBlindHookHarness hook = _deployWithTreasury(address(actor), 1_000, 1_000, 4, 1 days);
        _accrue(hook, 100_000);
        token.arm(address(actor), abi.encodeCall(ClaimActor.claimTreasury, (hook, 1)));

        vm.prank(address(actor));
        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        hook.claimTreasury(1, address(actor));

        (, uint256 treasuryLiability,) = hook.readFeeLiabilities(address(actor));
        assertEq(treasuryLiability, 400, "treasury liability must roll back");
        assertEq(token.balanceOf(address(actor)), 0);
    }

    function testReentrantProgrammableClaimDuringItsOwnTransferIsBlockedAtomically() external {
        ClaimActor implementation = new ClaimActor();
        vm.etch(PROGRAMMABLE, address(implementation).code);
        ClaimsBlindHookHarness hook = _deploy(OPERATIONS, 1_000, 1_000, 4, 1 days);
        _accrue(hook, 100_000);
        token.arm(PROGRAMMABLE, abi.encodeCall(ClaimActor.claimProgrammable, (hook, 1)));

        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        ClaimActor(PROGRAMMABLE).claimProgrammable(hook, 1);

        (uint256 programmableLiability,,) = hook.readFeeLiabilities(TREASURY);
        assertEq(programmableLiability, 100, "programmable liability must roll back");
        assertEq(token.balanceOf(PROGRAMMABLE), 0);
    }

    /// @dev Cross-function: a process claim's transfer tries to reenter claimTreasury. The shared
    ///      `moneyPath` lock in FeeAccounting must block this even though the two claims draw from
    ///      independent liability streams.
    function testProcessClaimTransferCannotReenterTreasuryClaim() external {
        ClaimActor operationsActor = new ClaimActor();
        ClaimsBlindHookHarness hook = _deployWithBoth(
            address(operationsActor), address(operationsActor), 1_000, 1_000, 4, 1 days
        );
        _accrue(hook, 100_000);
        token.arm(address(operationsActor), abi.encodeCall(ClaimActor.claimTreasury, (hook, 1)));

        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        operationsActor.claimProcess(hook, CYCLE_A, 1);

        assertEq(hook.processLiability(), 2_500);
        (, uint256 treasuryLiability,) = hook.readFeeLiabilities(address(operationsActor));
        assertEq(
            treasuryLiability, 400, "cross-reentrant treasury claim must not have drained anything"
        );
        assertFalse(hook.processClaimCycleUsed(CYCLE_A));
    }

    /// @dev Cross-function: a Treasury claim's transfer tries to reenter claimProgrammable.
    function testTreasuryClaimTransferCannotReenterProgrammableClaim() external {
        ClaimActor implementation = new ClaimActor();
        vm.etch(PROGRAMMABLE, address(implementation).code);
        ClaimActor treasuryActor = new ClaimActor();
        ClaimsBlindHookHarness hook =
            _deployWithTreasury(address(treasuryActor), 1_000, 1_000, 4, 1 days);
        _accrue(hook, 100_000);
        token.arm(PROGRAMMABLE, abi.encodeCall(ClaimActor.claimProgrammable, (hook, 1)));

        vm.prank(address(treasuryActor));
        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        hook.claimTreasury(1, address(treasuryActor));

        (uint256 programmableLiability,,) = hook.readFeeLiabilities(address(treasuryActor));
        assertEq(
            programmableLiability,
            100,
            "cross-reentrant programmable claim must not have drained anything"
        );
    }

    // ---------------------------------------------------------------------
    // Former-Treasury standing: investigate whether a superseded Treasury address keeps the
    // ability to claim what it already accrued (spec statement (3) omits the word "current" for
    // Treasury/Programmable, unlike statement (2)'s explicit "current Operations role").
    // ---------------------------------------------------------------------

    function testFormerTreasuryCanStillClaimItsPreRotationAccrualButNothingMore() external {
        ClaimsBlindHookHarness hook = _deployWithTreasury(TREASURY, 1_000, 1_000, 4, 1 days);
        _accrue(hook, 100_000); // 40 bps of 100_000 = 400 accrued to TREASURY.

        address newTreasury = address(0xC999);
        vm.prank(TREASURY);
        hook.proposeTreasury(newTreasury);
        vm.prank(newTreasury);
        hook.acceptTreasury();

        _accrue(hook, 100_000); // a further 400 must now accrue to newTreasury, not TREASURY.

        (, uint256 oldTreasuryLiability,) = hook.readFeeLiabilities(TREASURY);
        (, uint256 newTreasuryLiability,) = hook.readFeeLiabilities(newTreasury);
        assertEq(oldTreasuryLiability, 400, "old treasury balance must be frozen at rotation time");
        assertEq(newTreasuryLiability, 400, "new fees must accrue only to the current treasury");

        // The old beneficiary is still able to withdraw exactly what it already earned...
        vm.prank(TREASURY);
        hook.claimTreasury(400, TREASURY);
        assertEq(token.balanceOf(TREASURY), 400);

        // ...but cannot claim more than that (its own ledger entry is now exhausted), even though
        // it remains a recognized treasury beneficiary address forever.
        vm.prank(TREASURY);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        hook.claimTreasury(1, TREASURY);
    }

    // ---------------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------------

    function _accrue(ClaimsBlindHookHarness hook, uint256 executedUsdg) private {
        hook.accrueForTest(executedUsdg);
    }

    function _claimAs(address caller, HookemonHook hook, bytes32 cycleId, uint256 amount) private {
        vm.prank(caller);
        hook.claimProcess(cycleId, amount, caller);
    }

    function _deploy(
        address operations,
        uint256 limit,
        uint256 maximum,
        uint256 maxCount,
        uint256 rotationDelay
    ) private returns (ClaimsBlindHookHarness hook) {
        return _deployWithBoth(TREASURY, operations, limit, maximum, maxCount, rotationDelay);
    }

    function _deployWithTreasury(
        address treasury,
        uint256 limit,
        uint256 maximum,
        uint256 maxCount,
        uint256 rotationDelay
    ) private returns (ClaimsBlindHookHarness hook) {
        return _deployWithBoth(treasury, OPERATIONS, limit, maximum, maxCount, rotationDelay);
    }

    function _deployWithBoth(
        address treasury,
        address operations,
        uint256 limit,
        uint256 maximum,
        uint256 maxCount,
        uint256 rotationDelay
    ) private returns (ClaimsBlindHookHarness hook) {
        ClaimsBlindFactory factory = new ClaimsBlindFactory(
            HookemonHook.ConstructorConfig({
                manager: IPoolManager(address(0xC000)),
                positionManager: address(0xC001),
                permit2: address(0xC002),
                usdg: Currency.wrap(address(token)),
                hkmn: Currency.wrap(address(0xC003)),
                tickSpacing: 60,
                programmable: PROGRAMMABLE,
                treasury: treasury,
                operations: operations,
                launchAuthority: address(0xC004),
                issuanceAuthority: address(0xC005),
                expectedDecimals: 18,
                bindingDigest: keccak256("blind-claims-binding"),
                runtimeDigest: keccak256("blind-claims-runtime"),
                processClaimLimit6h: limit,
                processClaimLimitMax: maximum,
                processClaimMaxCount: maxCount,
                operationsRotationDelay: rotationDelay
            }),
            token
        );
        bytes32 initCodeHash = factory.initCodeHash();
        for (uint256 nonce; nonce < 250_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(salt, initCodeHash, address(factory));
            if ((uint160(predicted) & ALL_HOOK_PERMISSION_MASK) == REQUIRED_HOOK_PERMISSION_MASK) {
                hook = factory.deploy(salt);
                assertEq(address(hook), predicted);
                return hook;
            }
        }
        revert("missing valid claims hook salt");
    }
}
