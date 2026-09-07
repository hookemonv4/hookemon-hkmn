// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {AccountedCanonicalMarketHook, AccountedCanonicalMarketHookDeployer} from "../market/CanonicalMarket.t.sol";
import {MarketTestToken, RecipientPoolSwapTest} from "../market/CanonicalMarketCallbackSurface.t.sol";

// Local model: production callback/accounting + real pinned PoolManager. It is not a launch,
// live transaction, price oracle, or receipt for a successful external cycle.
contract OwnerCapitalFeasibilityTest is Test {
    PoolManager manager;
    RecipientPoolSwapTest router;
    MarketTestToken usdg;
    MarketTestToken hkmn;
    AccountedCanonicalMarketHook hook;
    PoolKey key;

    function test_onePackFundedByActualFeesWith150UsdgInitialCapital() public {
        manager = new PoolManager(address(this));
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(manager);
        router = new RecipientPoolSwapTest(manager);
        MarketTestToken first = new MarketTestToken();
        MarketTestToken second = new MarketTestToken();
        (usdg, hkmn) = address(first) < address(second) ? (first, second) : (second, first);
        hook = new AccountedCanonicalMarketHookDeployer()
            .deploy(
                manager, Currency.wrap(address(usdg)), Currency.wrap(address(hkmn)), address(0xC001), address(0xC002)
            );
        key = PoolKey(Currency.wrap(address(usdg)), Currency.wrap(address(hkmn)), 0, 60, IHooks(address(hook)));
        usdg.mint(address(this), 150_000_000);
        hkmn.mint(address(this), 1_000_000_000 ether);
        usdg.approve(address(liquidityRouter), type(uint256).max);
        hkmn.approve(address(liquidityRouter), type(uint256).max);
        usdg.approve(address(router), type(uint256).max);
        hkmn.approve(address(router), type(uint256).max);
        uint160 price = uint160(uint256(3_162_277_660) << 96);
        manager.initialize(key, price);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            price,
            TickMath.getSqrtPriceAtTick(-887220),
            TickMath.getSqrtPriceAtTick(887220),
            100_000_000,
            1_000_000_000 ether
        );
        uint256 seedBefore = usdg.balanceOf(address(this));
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-887220, 887220, int256(uint256(liquidity)), bytes32(0)), ""
        );
        uint256 seed = seedBefore - usdg.balanceOf(address(this));
        uint256 unseededHkmn = hkmn.balanceOf(address(this));
        uint256 swaps;
        uint256 gasUsed;
        uint256 gross;
        uint256 minTrader = usdg.balanceOf(address(this));
        assertEq(hook.processLiability(), 0);
        while (hook.processLiability() < 25_298_644 && swaps < 100) {
            uint256 available = usdg.balanceOf(address(this));
            uint256 start = gasleft();
            router.swap(
                key, SwapParams(true, -int256(available), TickMath.MIN_SQRT_PRICE + 1), address(this), address(this), ""
            );
            gasUsed += start - gasleft() + 21_000;
            gross += hook.lastExecutedUsdg();
            swaps++;
            uint256 purchased = hkmn.balanceOf(address(this)) - unseededHkmn;
            assertGt(purchased, 0);
            start = gasleft();
            router.swap(
                key,
                SwapParams(false, -int256(purchased), TickMath.MAX_SQRT_PRICE - 1),
                address(this),
                address(this),
                ""
            );
            gasUsed += start - gasleft() + 21_000;
            gross += hook.lastExecutedUsdg();
            swaps++;
            assertEq(hkmn.balanceOf(address(this)), unseededHkmn);
            if (usdg.balanceOf(address(this)) < minTrader) minTrader = usdg.balanceOf(address(this));
            assertEq(
                usdg.balanceOf(address(this)) + usdg.balanceOf(address(manager)) + usdg.balanceOf(address(hook)),
                150_000_000
            );
            assertEq(hook.processLiability(), gross * 250 / 10_000);
        }
        assertGe(hook.processLiability(), 25_298_644);
        emit log_named_uint("initialOwnerUsdgAtomic", 150_000_000);
        emit log_named_uint("seedUsdgAtomic", seed);
        emit log_named_uint("remainingTraderUsdgAtomic", usdg.balanceOf(address(this)));
        emit log_named_uint("remainingPoolUsdgAtomic", usdg.balanceOf(address(manager)));
        emit log_named_uint("minimumRoundEndTraderAtomic", minTrader);
        emit log_named_uint("processLiabilityAtomic", hook.processLiability());
        emit log_named_uint("totalFeeAtomic", hook.totalLiability());
        emit log_named_uint("grossExecutedUsdgAtomic", gross);
        emit log_named_uint("swapCount", swaps);
        emit log_named_uint("swapGasMeasuredPlusIntrinsic", gasUsed);
    }
}
