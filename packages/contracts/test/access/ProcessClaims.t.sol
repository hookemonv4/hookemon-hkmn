// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "@uniswap/v4-core/lib/forge-std/src/Test.sol";
import { Vm } from "@uniswap/v4-core/lib/forge-std/src/Vm.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";

import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";
import { MoneyRoles } from "../../src/access/MoneyRoles.sol";
import { RobinhoodBindings } from "../../src/bindings/RobinhoodBindings.sol";
import { HookemonHook } from "../../src/HookemonHook.sol";

contract ProcessClaimsToken {
    mapping(address account => uint256 balance) private balances;
    bool private transferFailure;
    bool private reentryEnabled;
    address private reentryTarget;
    bytes private reentryCall;

    error ReentryRejected();

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function burn(address account, uint256 amount) external {
        balances[account] -= amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function setTransferFailure(bool value) external {
        transferFailure = value;
    }

    function setReentry(address target, bytes calldata callData) external {
        reentryTarget = target;
        reentryCall = callData;
        reentryEnabled = true;
    }

    function clearReentry() external {
        delete reentryTarget;
        delete reentryCall;
        reentryEnabled = false;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (transferFailure) return false;
        balances[msg.sender] -= amount;
        balances[recipient] += amount;
        if (reentryEnabled) {
            (bool succeeded,) = reentryTarget.call(reentryCall);
            if (!succeeded) revert ReentryRejected();
        }
        return true;
    }
}

contract ProcessClaimsHookHarness is HookemonHook {
    ProcessClaimsToken private immutable token;

    constructor(HookemonHook.ConstructorConfig memory config, ProcessClaimsToken configuredToken)
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

contract ProcessClaimsFactory {
    HookemonHook.ConstructorConfig private config;
    ProcessClaimsToken private immutable token;

    constructor(
        HookemonHook.ConstructorConfig memory configured,
        ProcessClaimsToken configuredToken
    ) {
        config = configured;
        token = configuredToken;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(type(ProcessClaimsHookHarness).creationCode, abi.encode(config, token))
        );
    }

    function deploy(bytes32 salt) external returns (ProcessClaimsHookHarness) {
        return new ProcessClaimsHookHarness{ salt: salt }(config, token);
    }
}

contract OperationsClaimActor {
    function claim(
        HookemonHook hook,
        bytes32 cycleId,
        uint256 amountAtomicUsdg,
        address destination
    ) external {
        hook.claimProcess(cycleId, amountAtomicUsdg, destination);
    }

    function reenter(HookemonHook hook, bytes32 cycleId, uint256 amountAtomicUsdg) external {
        hook.claimProcess(cycleId, amountAtomicUsdg, address(this));
    }
}

contract ProcessClaimsTest is Test {
    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    uint256 private constant WINDOW = 21_600;
    uint256 private constant ROTATION_DELAY = 3 days;
    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS_ONE = address(0x7000);
    address private constant OPERATIONS_TWO = address(0x7001);
    address private constant OPERATIONS_THREE = address(0x7002);
    address private constant UNRELATED = address(0xBAD1);
    bytes32 private constant CYCLE_ONE = keccak256("process-cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("process-cycle-two");
    bytes32 private constant CYCLE_THREE = keccak256("process-cycle-three");
    bytes32 private constant CYCLE_FOUR = keccak256("process-cycle-four");

    struct FuzzClaim {
        uint256 amount;
        uint256 timestamp;
    }

    ProcessClaimsToken private token;

    function setUp() external {
        vm.warp(1_000_000);
        token = new ProcessClaimsToken();
    }

    function testClaimProcessTransfersExactAmountRecordsCycleAndEmitsFields() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);

        vm.recordLogs();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 40);

        assertEq(token.balanceOf(OPERATIONS_ONE), 40);
        assertEq(hook.processLiability(), 210);
        assertEq(hook.totalLiability(), 260);
        assertEq(hook.remainingProcessClaimCapacity(), 60);
        assertTrue(hook.processClaimCycleUsed(CYCLE_ONE));
        _assertProcessClaimed(vm.getRecordedLogs(), hook, CYCLE_ONE, 40, 100, 40);
    }

    function testWindowCountsAt21599AndExpiresAt21600() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 60);

        vm.warp(block.timestamp + WINDOW - 1);
        assertEq(hook.remainingProcessClaimCapacity(), 40);
        vm.expectRevert();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_TWO, 41);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_TWO, 40);

        vm.warp(block.timestamp + 1);
        assertEq(hook.remainingProcessClaimCapacity(), 60);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_THREE, 60);
        assertEq(hook.remainingProcessClaimCapacity(), 0);
    }

    function testDelayedLimitIncreaseRejectsClaimAt21599AndAcceptsItAt21600() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);

        uint256 scheduledAt = block.timestamp;
        vm.prank(TREASURY);
        hook.setProcessClaimLimit(200);

        vm.warp(scheduledAt + WINDOW - 1);
        vm.expectRevert(HookemonHook.ProcessClaimCapacityExceeded.selector);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 101);
        assertFalse(hook.processClaimCycleUsed(CYCLE_ONE));

        vm.warp(scheduledAt + WINDOW);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 101);
        assertEq(token.balanceOf(OPERATIONS_ONE), 101);
        assertEq(hook.remainingProcessClaimCapacity(), 99);
    }

    function testLimitDecreaseAndZeroApplyImmediatelyWithoutResettingUsage() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 60);

        vm.prank(TREASURY);
        hook.setProcessClaimLimit(50);
        assertEq(hook.remainingProcessClaimCapacity(), 0);
        vm.expectRevert();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_TWO, 1);

        vm.prank(TREASURY);
        hook.setProcessClaimLimit(0);
        assertEq(hook.remainingProcessClaimCapacity(), 0);
        vm.expectRevert();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_TWO, 1);
        assertTrue(hook.processClaimCycleUsed(CYCLE_ONE));
    }

    function testLimitIncreaseWaitsForExactlySixHoursAndCannotExceedMaximum() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);

        uint256 scheduledAt = block.timestamp;
        vm.prank(TREASURY);
        hook.setProcessClaimLimit(200);
        vm.warp(scheduledAt + 1);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 60);
        assertEq(hook.activeProcessClaimLimit(), 100);
        assertEq(hook.remainingProcessClaimCapacity(), 40);
        vm.warp(scheduledAt + WINDOW - 1);
        assertEq(hook.activeProcessClaimLimit(), 100);
        assertEq(hook.remainingProcessClaimCapacity(), 40);
        vm.warp(scheduledAt + WINDOW);
        assertEq(hook.activeProcessClaimLimit(), 200);
        assertEq(hook.remainingProcessClaimCapacity(), 140);
        assertTrue(hook.processClaimCycleUsed(CYCLE_ONE));

        vm.prank(TREASURY);
        vm.expectRevert();
        hook.setProcessClaimLimit(201);
    }

    function testImmediateDecreaseCancelsAPendingIncrease() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);

        vm.prank(TREASURY);
        hook.setProcessClaimLimit(200);
        vm.prank(TREASURY);
        hook.setProcessClaimLimit(50);
        assertEq(hook.activeProcessClaimLimit(), 50);

        vm.warp(block.timestamp + WINDOW);
        assertEq(hook.activeProcessClaimLimit(), 50);
    }

    function testProcessClaimRejectsZeroAndAmountsAboveLiabilityWithoutRecordingHistory() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 500, 500, 2);
        _accrue(hook);

        vm.expectRevert(MoneyRoles.InvalidCycle.selector);
        _claimAs(OPERATIONS_ONE, hook, bytes32(0), 1);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 0);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 251);

        assertEq(hook.processLiability(), 250);
        assertEq(hook.totalLiability(), 300);
        assertEq(hook.remainingProcessClaimCapacity(), 500);
        assertFalse(hook.processClaimCycleUsed(CYCLE_ONE));
        assertTrue(hook.isSolvent());
    }

    function testBoundedActiveEntriesRejectNPlusOneUntilExpiry() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 200, 200, 2);
        _accrue(hook);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_TWO, 1);

        vm.expectRevert();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_THREE, 1);

        vm.warp(block.timestamp + WINDOW);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_THREE, 1);
        assertEq(hook.remainingProcessClaimCapacity(), 199);
    }

    function testMaximumEntryCountHasBoundedCapacityAndPrunesExpiredEntries() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 100, 64);
        _accrue(hook);

        for (uint256 index; index < 64; ++index) {
            _claimAs(OPERATIONS_ONE, hook, keccak256(abi.encode(index)), 1);
        }
        assertEq(hook.remainingProcessClaimCapacity(), 36);
        assertGt(vm.lastCallGas().gasTotalUsed, 0);

        vm.warp(block.timestamp + WINDOW);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);
        assertEq(hook.remainingProcessClaimCapacity(), 99);
        assertGt(vm.lastCallGas().gasTotalUsed, 0);
    }

    function testCycleIdentifierRemainsUsedAfterItsEntryExpires() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);

        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);
        assertTrue(hook.processClaimCycleUsed(CYCLE_ONE));
    }

    function testOnlyOperationsMayClaimToItselfAndTreasuryControlsPause() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);

        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        _claimAs(UNRELATED, hook, CYCLE_ONE, 1);
        vm.expectRevert(MoneyRoles.InvalidDestination.selector);
        vm.prank(OPERATIONS_ONE);
        hook.claimProcess(CYCLE_ONE, 1, UNRELATED);
        assertFalse(hook.processClaimCycleUsed(CYCLE_ONE));

        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.setProcessClaimLimit(50);
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.pauseProcessClaims();
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        hook.scheduleOperationsRotation(OPERATIONS_TWO);

        vm.prank(TREASURY);
        hook.pauseProcessClaims();
        assertTrue(hook.processClaimsPaused());
        vm.expectRevert();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);
        vm.prank(TREASURY);
        hook.unpauseProcessClaims();
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);
    }

    function testEmergencyRotationPausesClaimsAndPreservesUsageAndCycleHistory() external {
        uint256 rotationDelay = 1 hours;
        ProcessClaimsHookHarness hook =
            _deployWithRotationDelay(OPERATIONS_ONE, 100, 200, 2, rotationDelay);
        _accrue(hook);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 60);

        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(OPERATIONS_TWO);
        assertTrue(hook.processClaimsPaused());
        vm.prank(TREASURY);
        vm.expectRevert();
        hook.unpauseProcessClaims();
        vm.warp(block.timestamp + rotationDelay - 1);
        vm.prank(TREASURY);
        vm.expectRevert();
        hook.executeOperationsRotation();

        vm.warp(block.timestamp + 1);
        vm.prank(TREASURY);
        hook.executeOperationsRotation();
        (MoneyRoles.RoleState memory roles,,,) = hook.readRoles(bytes32(0));
        assertEq(roles.operations, OPERATIONS_TWO);
        assertTrue(hook.processClaimsPaused());

        vm.prank(TREASURY);
        hook.unpauseProcessClaims();
        vm.expectRevert();
        _claimAs(OPERATIONS_TWO, hook, CYCLE_ONE, 1);
        vm.expectRevert();
        _claimAs(OPERATIONS_TWO, hook, CYCLE_TWO, 41);
        _claimAs(OPERATIONS_TWO, hook, CYCLE_TWO, 40);
    }

    function testEmergencyRotationClearsAndFreezesOrdinaryHandover() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);

        vm.prank(OPERATIONS_ONE);
        hook.proposeOperations(OPERATIONS_THREE);
        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(OPERATIONS_TWO);
        (,, MoneyRoles.PendingRoleTransfer memory operationsTransfer,) = hook.readRoles(bytes32(0));
        assertEq(operationsTransfer.proposedAccount, address(0));

        vm.prank(OPERATIONS_ONE);
        vm.expectRevert();
        hook.proposeOperations(OPERATIONS_THREE);
        vm.prank(OPERATIONS_THREE);
        vm.expectRevert();
        hook.acceptOperations();

        (MoneyRoles.RoleState memory roles,,,) = hook.readRoles(bytes32(0));
        assertEq(roles.operations, OPERATIONS_ONE);
        assertTrue(hook.processClaimsPaused());
    }

    function testEmergencyRotationEvictsAdversarialOperationsAtOriginalDeadline() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);

        uint256 scheduledAt = block.timestamp;
        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(OPERATIONS_TWO);
        vm.warp(scheduledAt + ROTATION_DELAY);
        vm.prank(TREASURY);
        hook.executeOperationsRotation();
        (MoneyRoles.RoleState memory roles,,,) = hook.readRoles(bytes32(0));
        assertEq(roles.operations, OPERATIONS_TWO);

        vm.prank(TREASURY);
        hook.unpauseProcessClaims();
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);
        _claimAs(OPERATIONS_TWO, hook, CYCLE_ONE, 1);
        assertEq(token.balanceOf(OPERATIONS_ONE), 0);
        assertEq(token.balanceOf(OPERATIONS_TWO), 1);
    }

    function testMaximumOperationsRotationDelaySchedulesExactDeadline() external {
        uint256 maximumDelay = 30 days;
        ProcessClaimsHookHarness hook =
            _deployWithRotationDelay(OPERATIONS_ONE, 100, 200, 2, maximumDelay);

        uint256 scheduledAt = block.timestamp;
        vm.prank(TREASURY);
        hook.scheduleOperationsRotation(OPERATIONS_TWO);
        (,, uint256 executableAt) = hook.scheduledOperationsRotation();
        assertEq(executableAt, scheduledAt + maximumDelay);
    }

    function testOperationsRotationRejectsTimestampOverflow() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        vm.warp(type(uint256).max - ROTATION_DELAY + 1);

        vm.prank(TREASURY);
        vm.expectRevert(HookemonHook.OperationsRotationTimestampOverflow.selector);
        hook.scheduleOperationsRotation(OPERATIONS_TWO);
    }

    function testReentrantProcessClaimRollsBackLiabilityHistoryAndBalances() external {
        OperationsClaimActor operations = new OperationsClaimActor();
        ProcessClaimsHookHarness hook = _deploy(address(operations), 100, 200, 2);
        _accrue(hook);
        token.setReentry(
            address(operations), abi.encodeCall(OperationsClaimActor.reenter, (hook, CYCLE_TWO, 1))
        );

        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        operations.claim(hook, CYCLE_ONE, 1, address(operations));

        assertEq(hook.processLiability(), 250);
        assertEq(hook.totalLiability(), 300);
        assertEq(hook.hookUsdgBalance(), 300);
        assertEq(hook.remainingProcessClaimCapacity(), 100);
        assertEq(token.balanceOf(address(operations)), 0);
        assertFalse(hook.processClaimCycleUsed(CYCLE_ONE));
        assertFalse(hook.processClaimCycleUsed(CYCLE_TWO));
    }

    function testProcessTransferFailureRollsBackLiabilityHistoryAndBalances() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);
        token.setTransferFailure(true);

        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);

        assertEq(hook.processLiability(), 250);
        assertEq(hook.totalLiability(), 300);
        assertEq(hook.hookUsdgBalance(), 300);
        assertEq(hook.remainingProcessClaimCapacity(), 100);
        assertEq(token.balanceOf(OPERATIONS_ONE), 0);
        assertFalse(hook.processClaimCycleUsed(CYCLE_ONE));
        assertTrue(hook.isSolvent());
    }

    function testProcessClaimMayConsumeTheFullProcessLiability() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 500, 500, 2);
        _accrue(hook);

        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 250);

        assertEq(token.balanceOf(OPERATIONS_ONE), 250);
        assertEq(hook.processLiability(), 0);
        assertEq(hook.totalLiability(), 50);
        assertEq(hook.remainingProcessClaimCapacity(), 250);
        assertTrue(hook.isSolvent());
    }

    function testInsolventProcessClaimRollsBackLiabilityHistoryAndBalances() external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 2);
        _accrue(hook);
        token.burn(address(hook), 1);

        vm.expectRevert(FeeAccounting.InsolventAccounting.selector);
        _claimAs(OPERATIONS_ONE, hook, CYCLE_ONE, 1);

        assertEq(hook.processLiability(), 250);
        assertEq(hook.totalLiability(), 300);
        assertEq(hook.hookUsdgBalance(), 299);
        assertEq(hook.remainingProcessClaimCapacity(), 100);
        assertEq(token.balanceOf(OPERATIONS_ONE), 0);
        assertFalse(hook.processClaimCycleUsed(CYCLE_ONE));
        assertFalse(hook.isSolvent());
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzzClaimsMatchIndependentWindowCapacityOracle(
        uint16 rawFirstAmount,
        uint16 rawSecondAmount,
        uint16 rawThirdAmount,
        uint16 rawFirstGap,
        uint16 rawSecondGap
    ) external {
        ProcessClaimsHookHarness hook = _deploy(OPERATIONS_ONE, 100, 200, 8);
        _accrue(hook);
        hook.accrueForTest(10_000);

        uint256 activeLimit = 100;
        FuzzClaim memory first = _claimWithinOracleCapacityOrRevert(
            hook, CYCLE_ONE, bound(uint256(rawFirstAmount), 1, 150), activeLimit
        );
        assertEq(hook.remainingProcessClaimCapacity(), activeLimit - first.amount);

        vm.warp(block.timestamp + bound(uint256(rawFirstGap), 0, WINDOW));
        uint256 usedBeforeSecond =
            _activeSum(first.amount, first.timestamp, 0, 0, 0, 0, block.timestamp);
        assertEq(hook.remainingProcessClaimCapacity(), activeLimit - usedBeforeSecond);
        FuzzClaim memory second = _claimWithinOracleCapacityOrRevert(
            hook, CYCLE_TWO, bound(uint256(rawSecondAmount), 1, 150), activeLimit - usedBeforeSecond
        );
        uint256 usedAfterSecond = _activeSum(
            first.amount, first.timestamp, second.amount, second.timestamp, 0, 0, block.timestamp
        );
        assertLe(usedAfterSecond, activeLimit);

        vm.warp(block.timestamp + bound(uint256(rawSecondGap), 0, WINDOW));
        uint256 usedBeforeThird = _activeSum(
            first.amount, first.timestamp, second.amount, second.timestamp, 0, 0, block.timestamp
        );
        assertEq(hook.remainingProcessClaimCapacity(), activeLimit - usedBeforeThird);
        FuzzClaim memory third = _claimWithinOracleCapacityOrRevert(
            hook, CYCLE_THREE, bound(uint256(rawThirdAmount), 1, 150), activeLimit - usedBeforeThird
        );
        uint256 usedAfterThird = _activeSum(
            first.amount,
            first.timestamp,
            second.amount,
            second.timestamp,
            third.amount,
            third.timestamp,
            block.timestamp
        );
        assertLe(usedAfterThird, activeLimit);
        assertEq(hook.remainingProcessClaimCapacity(), activeLimit - usedAfterThird);
    }

    function _deploy(address operations, uint256 limit, uint256 maximum, uint256 maxCount)
        private
        returns (ProcessClaimsHookHarness hook)
    {
        return _deployWithRotationDelay(operations, limit, maximum, maxCount, ROTATION_DELAY);
    }

    function _deployWithRotationDelay(
        address operations,
        uint256 limit,
        uint256 maximum,
        uint256 maxCount,
        uint256 rotationDelay
    ) private returns (ProcessClaimsHookHarness hook) {
        ProcessClaimsFactory factory = new ProcessClaimsFactory(
            HookemonHook.ConstructorConfig({
                manager: IPoolManager(address(0x1000)),
                positionManager: address(0x1001),
                permit2: address(0x1002),
                usdg: Currency.wrap(address(token)),
                hkmn: Currency.wrap(address(0x2000)),
                tickSpacing: 60,
                programmable: PROGRAMMABLE,
                treasury: TREASURY,
                operations: operations,
                launchAuthority: address(0x3000),
                issuanceAuthority: address(0x3001),
                expectedDecimals: 18,
                bindingDigest: keccak256("process-claims-binding"),
                runtimeDigest: keccak256("process-claims-runtime"),
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
        revert("missing valid process-claims hook salt");
    }

    function _accrue(ProcessClaimsHookHarness hook) private {
        hook.accrueForTest(10_000);
        assertEq(hook.processLiability(), 250);
        assertEq(hook.totalLiability(), 300);
        assertEq(hook.hookUsdgBalance(), 300);
    }

    function _claimAs(address caller, HookemonHook hook, bytes32 cycleId, uint256 amountAtomicUsdg)
        private
    {
        vm.prank(caller);
        hook.claimProcess(cycleId, amountAtomicUsdg, caller);
    }

    function _claimWithinOracleCapacityOrRevert(
        HookemonHook hook,
        bytes32 cycleId,
        uint256 amount,
        uint256 capacity
    ) private returns (FuzzClaim memory claim) {
        if (amount <= capacity) {
            claim = FuzzClaim({ amount: amount, timestamp: block.timestamp });
            _claimAs(OPERATIONS_ONE, hook, cycleId, amount);
            return claim;
        }
        vm.expectRevert(HookemonHook.ProcessClaimCapacityExceeded.selector);
        _claimAs(OPERATIONS_ONE, hook, cycleId, amount);
        assertFalse(hook.processClaimCycleUsed(cycleId));
    }

    function _activeSum(
        uint256 firstAmount,
        uint256 firstTimestamp,
        uint256 secondAmount,
        uint256 secondTimestamp,
        uint256 thirdAmount,
        uint256 thirdTimestamp,
        uint256 currentTimestamp
    ) private pure returns (uint256 total) {
        if (firstTimestamp != 0 && currentTimestamp - firstTimestamp < WINDOW) {
            total += firstAmount;
        }
        if (secondTimestamp != 0 && currentTimestamp - secondTimestamp < WINDOW) {
            total += secondAmount;
        }
        if (thirdTimestamp != 0 && currentTimestamp - thirdTimestamp < WINDOW) {
            total += thirdAmount;
        }
    }

    function _assertProcessClaimed(
        Vm.Log[] memory logs,
        HookemonHook hook,
        bytes32 cycleId,
        uint256 amount,
        uint256 cap,
        uint256 usedAfter
    ) private view {
        bytes32 signature = keccak256(
            "ProcessClaimed(bytes32,uint256,address,uint256,uint256,uint256)"
        );
        for (uint256 index; index < logs.length; ++index) {
            Vm.Log memory entry = logs[index];
            if (entry.emitter != address(hook) || entry.topics.length != 3) continue;
            if (entry.topics[0] != signature || entry.topics[1] != cycleId) continue;
            if (address(uint160(uint256(entry.topics[2]))) != OPERATIONS_ONE) continue;
            (
                uint256 recordedAmount,
                uint256 timestamp,
                uint256 recordedCap,
                uint256 recordedUsedAfter
            ) = abi.decode(entry.data, (uint256, uint256, uint256, uint256));
            assertEq(recordedAmount, amount);
            assertEq(timestamp, block.timestamp);
            assertEq(recordedCap, cap);
            assertEq(recordedUsedAfter, usedAfter);
            return;
        }
        assertTrue(false, "missing ProcessClaimed event");
    }
}
