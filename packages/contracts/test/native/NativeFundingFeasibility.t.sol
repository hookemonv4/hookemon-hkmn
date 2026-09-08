// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {HookemonHook} from "../../src/HookemonHook.sol";
import {HKMNToken} from "../../src/launch/HKMNToken.sol";
import {PermanentPositionCustody, RobinhoodBindings} from "../../src/bindings/RobinhoodBindings.sol";
import {FeeAccounting} from "../../src/accounting/FeeAccounting.sol";

/// @dev Isolated payable Operations fixture; no off-chain route or buyback is fabricated.
contract FundingOperations {
    function claim(HookemonHook hook, uint256 amount) external {
        hook.claimProcess(keccak256("historical-exact-output-scenario"), amount, address(this));
    }
    receive() external payable {}
}

/// @notice Actual native graph and pinned managers. Gas is local EVM execution, not a live cap.
contract NativeFundingFeasibilityTest is Test, DeployPermit2 {
    uint256 constant TARGET = 10_243_579_001_330_370;
    uint256 constant SEED_MAX = 40_000_000_000_000_000;
    uint160 constant PRICE = 12527072418752396559322253362376889;
    uint128 constant LIQUIDITY = 6324555320336758663997;
    address constant LAUNCH = address(0xA11CE);
    address constant TREASURY = address(0xBEEF);
    bytes32 constant FEES = keccak256(
        "SwapLiabilitiesAccrued(uint256,uint256,address,uint256,address,uint256,uint256,uint256,uint256,uint256)"
    );
    PoolManager manager;
    PositionManager positions;
    PoolSwapTest router;
    HookemonHook hook;
    HKMNToken token;
    PermanentPositionCustody custody;
    FundingOperations operations;
    PoolKey key;
    uint256 nativeDebt;
    uint256 gross;
    uint256 swapGas;
    uint256 swaps;
    uint256 minAfterBuy;
    uint256 minRoundEnd;

    function _deploy() private {
        manager = new PoolManager(address(this));
        IAllowanceTransfer permit = IAllowanceTransfer(deployPermit2());
        positions = new PositionManager(manager, permit, 100000, IPositionDescriptor(address(0)), IWETH9(address(0)));
        router = new PoolSwapTest(manager);
        operations = new FundingOperations();
        uint256 start = gasleft();
        token = new HKMNToken(address(this), address(0), 18, PRICE);
        uint256 tokenGas = start - gasleft();
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
            processClaimLimit6hWei: TARGET,
            processClaimLimitMaxWei: TARGET,
            processClaimMaxCount: 1,
            operationsRotationDelay: 43200
        });
        bytes32 initHash = keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));
        bytes32 salt;
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            if (uint160(vm.computeCreate2Address(salt, initHash, address(this))) & 0x3fff == 0x20cc) break;
        }
        start = gasleft();
        hook = new HookemonHook{salt: salt}(config);
        uint256 hookGas = start - gasleft();
        start = gasleft();
        custody = new PermanentPositionCustody(address(positions), 0);
        uint256 custodyGas = start - gasleft();
        start = gasleft();
        custody.configureBindingHook(address(hook));
        token.allocate(address(hook));
        hook.initializeGraphLaunch(address(custody), PRICE);
        token.approve(address(router), type(uint256).max);
        uint256 wiringGas = start - gasleft();
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 0, 60, IHooks(address(hook)));
        nativeDebt = SqrtPriceMath.getAmount0Delta(PRICE, TickMath.getSqrtPriceAtTick(887220), LIQUIDITY, true);
        assertEq(nativeDebt, 39999999999999657);
        assertEq(token.totalSupply(), 1e27);
        assertEq(token.balanceOf(address(this)), 0);
        emit log_named_uint("tokenDeploymentGasLocal", tokenGas);
        emit log_named_uint("hookDeploymentGasLocal", hookGas);
        emit log_named_uint("custodyDeploymentGasLocal", custodyGas);
        emit log_named_uint("graphWiringGasLocal", wiringGas);
    }

    function _seed() private {
        vm.deal(LAUNCH, SEED_MAX);
        HookemonHook.SeedParams memory seed = HookemonHook.SeedParams(
            -887220,
            887220,
            LIQUIDITY,
            uint128(SEED_MAX),
            uint128(token.totalSupply()),
            block.timestamp + 100,
            LAUNCH,
            address(custody)
        );
        vm.prank(LAUNCH);
        uint256 start = gasleft();
        hook.seedCanonicalLiquidity{value: SEED_MAX}(seed);
        emit log_named_uint("seedGasLocal", start - gasleft());
        assertEq(positions.ownerOf(hook.canonicalPositionTokenId()), address(custody));
        assertEq(token.balanceOf(address(manager)), token.totalSupply());
        assertEq(address(manager).balance, nativeDebt);
        assertEq(address(positions).balance, 0);
        assertEq(LAUNCH.balance, SEED_MAX - nativeDebt);
        assertEq(hook.processLiability(), 0);
    }

    function _swap(bool buy, uint256 amount) private {
        vm.recordLogs();
        uint256 start = gasleft();
        router.swap{value: buy ? amount : 0}(
            key,
            SwapParams(buy, -int256(amount), buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        swapGas += start - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 matched;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == FEES) {
                (uint256 executed,,,,,,,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
                gross += executed;
                matched++;
            }
        }
        assertEq(matched, 1);
        swaps++;
        assertEq(hook.processLiability(), gross * 250 / 10000);
        assertTrue(hook.isSolvent());
    }

    function _scenario(uint256 tradingFloat, bool expectFunded) private {
        _deploy();
        _seed();
        vm.deal(address(this), tradingFloat);
        minAfterBuy = tradingFloat;
        minRoundEnd = tradingFloat;
        uint256 initialCapital = SEED_MAX + tradingFloat;
        for (uint256 round; round < 128 && hook.processLiability() < TARGET; round++) {
            uint256 available = address(this).balance;
            if (available < 1000) break;
            _swap(true, available);
            if (address(this).balance < minAfterBuy) minAfterBuy = address(this).balance;
            uint256 purchased = token.balanceOf(address(this));
            assertGt(purchased, 0);
            _swap(false, purchased);
            assertEq(token.balanceOf(address(this)), 0);
            if (address(this).balance < minRoundEnd) minRoundEnd = address(this).balance;
            assertGe(address(manager).balance, nativeDebt);
            assertEq(
                LAUNCH.balance + address(this).balance + address(manager).balance + address(hook).balance,
                initialCapital
            );
        }
        assertEq(hook.processLiability() >= TARGET, expectFunded);
        emit log_named_uint("initialCapitalWei", initialCapital);
        emit log_named_uint("seedLockedWei", nativeDebt);
        emit log_named_uint("initialTradingFloatWei", tradingFloat);
        emit log_named_uint("grossExecutedWei", gross);
        emit log_named_uint("earnedProcessWei", hook.processLiability());
        emit log_named_uint("feeLiabilitiesWei", hook.totalLiability());
        emit log_named_uint("traderRemainingWei", address(this).balance);
        emit log_named_uint("poolRemainingWei", address(manager).balance);
        emit log_named_uint("minimumAfterBuyWei", minAfterBuy);
        emit log_named_uint("minimumRoundEndWei", minRoundEnd);
        emit log_named_uint("swapCount", swaps);
        emit log_named_uint("swapExecutionGasLocal", swapGas);
        if (expectFunded) {
            uint256 before = hook.processLiability();
            uint256 start = gasleft();
            operations.claim(hook, TARGET);
            emit log_named_uint("claimGasLocal", start - gasleft());
            assertEq(address(operations).balance, TARGET);
            assertEq(hook.processLiability(), before - TARGET);
            assertEq(
                LAUNCH.balance + address(this).balance + address(manager).balance + address(hook).balance
                    + address(operations).balance,
                initialCapital
            );
        }
    }

    function testSeed004Float001CannotReachHistoricalBridgePrincipal() external {
        _scenario(0.01 ether, false);
    }

    function testSeed004Float002EarnsAndClaimsHistoricalBridgePrincipal() external {
        _scenario(0.02 ether, true);
    }

    function testSeed004Float004EarnsAndClaimsHistoricalBridgePrincipal() external {
        _scenario(0.04 ether, true);
    }
    receive() external payable {}
}
