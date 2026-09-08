// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import { IPositionDescriptor } from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import { IWETH9 } from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import { LiquidityAmounts } from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";
import { DeployPermit2 } from "permit2/test/utils/DeployPermit2.sol";
import { HookemonHook } from "../../src/HookemonHook.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";
import {
    PermanentPositionCustody,
    RobinhoodBindings
} from "../../src/bindings/RobinhoodBindings.sol";
import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";

contract NativeRecipient {
    bool public reject;
    address public forward;
    address public reenter;
    bytes public reentryData;
    bool public reentrySucceeded;

    function configure(bool reject_, address forward_, address reenter_, bytes calldata data)
        external
    {
        reject = reject_;
        forward = forward_;
        reenter = reenter_;
        reentryData = data;
    }

    function claim(HookemonHook hook, bytes32 cycleId, uint256 amount) external {
        hook.claimProcess(cycleId, amount, address(this));
    }

    receive() external payable {
        require(!reject, "recipient rejects");
        if (reenter != address(0)) (reentrySucceeded,) = reenter.call(reentryData);
        if (forward != address(0)) {
            (bool ok,) = forward.call{ value: msg.value }("");
            require(ok);
        }
    }
}

/// @dev A cheatcode-only fault models a balance discontinuity before the final solvency check.
contract NativeSolvencyFault is Test {
    function drain(address target) external {
        vm.deal(target, 0);
    }
}

contract NativeHookTest is Test, DeployPermit2 {
    address private constant LAUNCH = address(0xA11CE);
    address private constant TREASURY = address(0xBEEF);
    address private constant SINK = address(0x123456);
    PoolManager private manager;
    PositionManager private positions;
    IAllowanceTransfer private permit;
    PoolSwapTest private router;
    HookemonHook private hook;
    HKMNToken private token;
    PermanentPositionCustody private custody;
    NativeRecipient private operations;
    PoolKey private key;
    HookemonHook.SeedParams private seed;
    uint256 private nativeDebt;

    function setUp() public {
        manager = new PoolManager(address(this));
        permit = IAllowanceTransfer(deployPermit2());
        positions = new PositionManager(
            IPoolManager(address(manager)),
            permit,
            100000,
            IPositionDescriptor(address(0)),
            IWETH9(address(0))
        );
        router = new PoolSwapTest(manager);
        operations = new NativeRecipient();
        token = new HKMNToken(address(this), address(0), 18, uint160(1 << 96));
        HookemonHook.ConstructorConfig memory config = HookemonHook.ConstructorConfig({
            manager: manager,
            positionManager: address(positions),
            permit2: address(permit),
            quoteCurrency: Currency.wrap(address(0)),
            hkmn: Currency.wrap(address(token)),
            tickSpacing: 60,
            programmable: RobinhoodBindings.PROGRAMMABLE_BENEFICIARY,
            treasury: TREASURY,
            operations: address(operations),
            launchAuthority: LAUNCH,
            issuanceAuthority: address(this),
            expectedDecimals: 18,
            bindingDigest: bytes32(uint256(1)),
            runtimeDigest: bytes32(uint256(2)),
            processClaimLimit6hWei: 1000000,
            processClaimLimitMaxWei: 2000000,
            processClaimMaxCount: 64,
            operationsRotationDelay: 43200
        });
        bytes32 hash =
            keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));
        for (uint256 i;; ++i) {
            bytes32 salt = bytes32(i);
            if (uint160(vm.computeCreate2Address(salt, hash, address(this))) & 0x3fff == 0x20cc) {
                hook = new HookemonHook{ salt: salt }(config);
                break;
            }
        }
        custody = new PermanentPositionCustody(address(positions), 0);
        custody.configureBindingHook(address(hook));
        token.allocate(address(hook));
        hook.initializeGraphLaunch(address(custody), uint160(1 << 96));
        key = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(address(token)), 0, 60, IHooks(address(hook))
        );
        uint160 lower = TickMath.getSqrtPriceAtTick(-887220);
        uint160 upper = TickMath.getSqrtPriceAtTick(887220);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmount1(lower, uint160(1 << 96), token.totalSupply());
        assertEq(
            SqrtPriceMath.getAmount1Delta(lower, uint160(1 << 96), liquidity, true),
            token.totalSupply()
        );
        nativeDebt = SqrtPriceMath.getAmount0Delta(uint160(1 << 96), upper, liquidity, true);
        seed = HookemonHook.SeedParams(
            -887220,
            887220,
            liquidity,
            uint128(nativeDebt + 99),
            uint128(token.totalSupply()),
            block.timestamp + 100,
            SINK,
            address(custody)
        );
        vm.deal(LAUNCH, 1e40);
        vm.deal(address(this), 1e40);
        token.approve(address(router), type(uint256).max);
    }

    function _seed() private {
        vm.prank(LAUNCH);
        hook.seedCanonicalLiquidity{ value: seed.amount0Max }(seed);
    }

    function _swap(bool zeroForOne, int256 amount) private {
        router.swap{ value: zeroForOne ? 1e24 : 0 }(
            key,
            SwapParams(
                zeroForOne,
                amount,
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function testNativeSeedPreservesForcedBalancesAndRefundsDistinctPayer() external {
        vm.deal(address(hook), 73);
        vm.deal(address(positions), 17);
        _seed();
        assertEq(address(manager).balance, nativeDebt);
        assertEq(address(positions).balance, 17);
        assertEq(address(hook).balance, 73);
        assertEq(SINK.balance, 99);
        assertEq(hook.totalLiability(), 0);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(token.balanceOf(address(manager)), token.totalSupply());
        assertEq(positions.ownerOf(hook.canonicalPositionTokenId()), address(custody));
        assertEq(token.allowance(address(hook), address(permit)), 0);
        (uint160 allowed,,) = permit.allowance(address(hook), address(token), address(positions));
        assertEq(allowed, 0);
    }

    function testSeedRejectsUnderAndOverValueWithoutConsumingForcedEth() external {
        vm.deal(address(hook), nativeDebt);
        vm.deal(address(positions), nativeDebt);
        vm.startPrank(LAUNCH);
        vm.expectRevert(HookemonHook.SeedFundingMismatch.selector);
        hook.seedCanonicalLiquidity{ value: seed.amount0Max - 1 }(seed);
        vm.expectRevert(HookemonHook.SeedFundingMismatch.selector);
        hook.seedCanonicalLiquidity{ value: uint256(seed.amount0Max) + 1 }(seed);
        vm.stopPrank();
        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(address(hook).balance, nativeDebt);
        assertEq(address(positions).balance, nativeDebt);
    }

    function testSeedRejectsInsufficientNativeMaximumWithRichManager() external {
        vm.deal(address(positions), nativeDebt);
        seed.amount0Max = uint128(nativeDebt - 1);
        vm.prank(LAUNCH);
        vm.expectRevert(HookemonHook.SeedFundingMismatch.selector);
        hook.seedCanonicalLiquidity{ value: seed.amount0Max }(seed);
        assertFalse(hook.canonicalLiquiditySeeded());
    }

    function testSeedRejectingRefundRollsBackMintAndApprovals() external {
        NativeRecipient payer = new NativeRecipient();
        payer.configure(true, address(0), address(0), "");
        seed.payer = address(payer);
        vm.prank(LAUNCH);
        vm.expectRevert(HookemonHook.SeedRefundFailed.selector);
        hook.seedCanonicalLiquidity{ value: seed.amount0Max }(seed);
        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(positions.nextTokenId(), 1);
        assertEq(address(manager).balance, 0);
        assertEq(token.balanceOf(address(hook)), token.totalSupply());
        assertEq(token.allowance(address(hook), address(permit)), 0);
    }

    function testFourNativeSwapQuadrantsAndCumulativeLiabilities() external {
        _seed();
        _swap(true, -100000);
        _swap(true, 10000);
        _swap(false, -10000);
        _swap(false, 10000);
        (uint256 p, uint256 t, uint256 process) = hook.readFeeLiabilities(TREASURY);
        assertGt(p, 0);
        assertGt(t, 0);
        assertGt(process, 0);
        assertEq(p + t + process, hook.totalLiability());
        assertEq(address(hook).balance, hook.totalLiability());
        assertTrue(hook.isSolvent());
    }

    function testNativeMinimum999RejectsAnd1000AccruesExactStreams() external {
        _seed();
        vm.expectRevert();
        _swap(true, -999);
        assertEq(hook.totalLiability(), 0);
        _swap(true, -1000);
        (uint256 p, uint256 t, uint256 process) = hook.readFeeLiabilities(TREASURY);
        assertEq(p, 1);
        assertEq(t, 4);
        assertEq(process, 25);
    }

    function testProcessForwardingRecipientAndPostPaymentProof() external {
        _seed();
        _swap(true, -100000);
        operations.configure(false, SINK, address(0), "");
        uint256 before = SINK.balance;
        vm.recordLogs();
        operations.claim(hook, bytes32(uint256(1)), 2500);
        assertEq(SINK.balance, before + 2500);
        assertEq(address(operations).balance, 0);
        assertEq(hook.processLiability(), 0);
        assertTrue(hook.processClaimCycleUsed(bytes32(uint256(1))));
        assertTrue(hook.isSolvent());
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function testRejectingProcessRecipientRollsBackCycleWindowAndLiability() external {
        _seed();
        _swap(true, -100000);
        operations.configure(true, address(0), address(0), "");
        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        operations.claim(hook, bytes32(uint256(2)), 2500);
        assertEq(hook.processLiability(), 2500);
        assertEq(hook.remainingProcessClaimCapacity(), 1000000);
        assertFalse(hook.processClaimCycleUsed(bytes32(uint256(2))));
        assertEq(address(hook).balance, 3000);
    }

    function testNativeClaimReentryCannotConsumeSecondCycle() external {
        _seed();
        _swap(true, -100000);
        operations.configure(
            false,
            address(0),
            address(hook),
            abi.encodeCall(
                hook.claimProcess, (bytes32(uint256(4)), uint256(100), address(operations))
            )
        );
        operations.claim(hook, bytes32(uint256(3)), 1000);
        assertFalse(operations.reentrySucceeded());
        assertFalse(hook.processClaimCycleUsed(bytes32(uint256(4))));
        assertEq(hook.processLiability(), 1500);
        assertEq(hook.remainingProcessClaimCapacity(), 999000);
    }

    function testSeedUsesLivePriceAndBoundsHkmnDebtBeforeMint() external {
        // StateLibrary pins pools mapping at slot 6; change both current price and tick.
        bytes32 poolId = keccak256(abi.encode(key));
        bytes32 slot = keccak256(abi.encode(poolId, uint256(6)));
        uint160 price = TickMath.getSqrtPriceAtTick(60);
        vm.store(address(manager), slot, bytes32(uint256(price) | (uint256(60) << 160)));
        vm.prank(LAUNCH);
        vm.expectRevert(HookemonHook.SeedFundingMismatch.selector);
        hook.seedCanonicalLiquidity{ value: seed.amount0Max }(seed);
        assertEq(positions.nextTokenId(), 1);
        assertEq(token.allowance(address(hook), address(permit)), 0);
        assertEq(token.balanceOf(address(hook)), token.totalSupply());
    }

    function testSeedRefundCannotReenterMoneyPath() external {
        NativeRecipient payer = new NativeRecipient();
        seed.payer = address(payer);
        payer.configure(
            false, address(0), address(hook), abi.encodeCall(hook.seedCanonicalLiquidity, (seed))
        );
        _seed();
        assertFalse(payer.reentrySucceeded());
        assertEq(address(payer).balance, 99);
        assertTrue(hook.canonicalLiquiditySeeded());
        assertEq(hook.totalLiability(), 0);
    }

    function testCanonicalCallbackRejectsReversedAndNonNativeKeys() external {
        PoolKey memory wrong = key;
        wrong.currency0 = key.currency1;
        wrong.currency1 = key.currency0;
        vm.prank(address(manager));
        vm.expectRevert();
        hook.beforeSwap(
            address(this), wrong, SwapParams(true, -1000, TickMath.MIN_SQRT_PRICE + 1), ""
        );
        wrong = key;
        wrong.currency0 = Currency.wrap(address(0xBAD));
        vm.prank(address(manager));
        vm.expectRevert();
        hook.beforeSwap(
            address(this), wrong, SwapParams(true, -1000, TickMath.MIN_SQRT_PRICE + 1), ""
        );
        assertEq(hook.totalLiability(), 0);
    }

    function testSelectedTokenNativeIdentityAndFixedAllocation() external {
        assertEq(token.expectedQuoteCurrency(), address(0));
        assertEq(token.totalSupply(), 1_000_000_000e18);
        vm.expectRevert(HKMNToken.InvalidLaunchConfiguration.selector);
        new HKMNToken(address(this), address(0xBAD), 18, uint160(1 << 96));
    }

    function testPartialBeneficiaryPaymentSupportsForwarding() external {
        _seed();
        _swap(true, -100000);
        NativeRecipient destination = new NativeRecipient();
        destination.configure(false, SINK, address(0), "");
        uint256 before = SINK.balance;
        vm.prank(TREASURY);
        hook.claimTreasury(123, address(destination));
        assertEq(SINK.balance, before + 123);
        assertEq(address(destination).balance, 0);
        (, uint256 remaining,) = hook.readFeeLiabilities(TREASURY);
        assertEq(remaining, 277);
        assertTrue(hook.isSolvent());
    }

    function testPostPaymentSolvencyFailureRestoresClaimAndHistory() external {
        _seed();
        _swap(true, -100000);
        NativeSolvencyFault fault = new NativeSolvencyFault();
        operations.configure(
            false, address(0), address(fault), abi.encodeCall(fault.drain, (address(hook)))
        );
        vm.expectRevert(FeeAccounting.InsolventAccounting.selector);
        operations.claim(hook, bytes32(uint256(88)), 1000);
        assertEq(hook.processLiability(), 2500);
        assertEq(hook.totalLiability(), 3000);
        // vm.deal bypasses EVM journaling; only the reverted payment is restored.
        assertEq(address(hook).balance, 1000);
        assertEq(address(operations).balance, 0);
        assertEq(hook.remainingProcessClaimCapacity(), 1000000);
        assertFalse(hook.processClaimCycleUsed(bytes32(uint256(88))));
    }

    receive() external payable { }
}
