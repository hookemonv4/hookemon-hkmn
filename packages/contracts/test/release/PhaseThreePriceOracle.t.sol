// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { LiquidityAmounts } from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import { Test } from "forge-std/Test.sol";
import { PhaseThreeTickMathVectors } from "../../script/release/PhaseThreeTickMathVectors.s.sol";

contract PhaseThreePriceOracleTest is Test {
    uint256 private constant USDG_SEED = 240_000_000;
    uint256 private constant HKMN_POOL_ALLOCATION = 1_000_000_000e18;
    int24 private constant TICK_LOWER = -887220;
    int24 private constant TICK_UPPER = 887220;
    uint128 private constant USDG_CURRENCY0_LIQUIDITY = 489897948556635619;
    uint128 private constant HKMN_CURRENCY0_LIQUIDITY = 489897948572597439;

    uint160 private constant USDG_CURRENCY0_SQRT_PRICE_X96 =
        161723809515207654588927258648643645224;
    uint160 private constant HKMN_CURRENCY0_SQRT_PRICE_X96 = 38813714284914462669;
    uint256 private constant USDG_CURRENCY0_CONSUMED_AMOUNT0 = 240000000;
    uint256 private constant USDG_CURRENCY0_CONSUMED_AMOUNT1 = 1000000000000000000000000000;
    uint256 private constant HKMN_CURRENCY0_CONSUMED_AMOUNT0 = 1000000000000000000000000000;
    uint256 private constant HKMN_CURRENCY0_CONSUMED_AMOUNT1 = 240000000;
    bytes32 private constant TICK_MATH_VECTORS_KECCAK =
        0xe23d9e5874ff6be7e6f9e0351d765746773b1e6f094a0c82b6a0fb56408c8401;

    function test_v4TickMathAndLiquidityAmountsBindTheUsdgCurrency0ReleaseTuple() external pure {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            USDG_CURRENCY0_SQRT_PRICE_X96,
            TickMath.getSqrtPriceAtTick(TICK_LOWER),
            TickMath.getSqrtPriceAtTick(TICK_UPPER),
            USDG_SEED,
            HKMN_POOL_ALLOCATION
        );

        assertEq(liquidity, USDG_CURRENCY0_LIQUIDITY);
        assertEq(USDG_CURRENCY0_SQRT_PRICE_X96, 161723809515207654588927258648643645224);
        assertEq(USDG_SEED, 240_000_000);
        assertEq(HKMN_POOL_ALLOCATION, 1_000_000_000e18);
        assertEq(
            SqrtPriceMath.getAmount0Delta(
                USDG_CURRENCY0_SQRT_PRICE_X96,
                TickMath.getSqrtPriceAtTick(TICK_UPPER),
                liquidity,
                true
            ),
            USDG_CURRENCY0_CONSUMED_AMOUNT0
        );
        assertEq(
            SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(TICK_LOWER),
                USDG_CURRENCY0_SQRT_PRICE_X96,
                liquidity,
                true
            ),
            USDG_CURRENCY0_CONSUMED_AMOUNT1
        );
    }

    function test_v4TickMathAndLiquidityAmountsBindTheHkmnCurrency0ReleaseTuple() external pure {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            HKMN_CURRENCY0_SQRT_PRICE_X96,
            TickMath.getSqrtPriceAtTick(TICK_LOWER),
            TickMath.getSqrtPriceAtTick(TICK_UPPER),
            HKMN_POOL_ALLOCATION,
            USDG_SEED
        );

        assertEq(liquidity, HKMN_CURRENCY0_LIQUIDITY);
        assertEq(HKMN_CURRENCY0_SQRT_PRICE_X96, 38813714284914462669);
        assertEq(HKMN_POOL_ALLOCATION, 1_000_000_000e18);
        assertEq(USDG_SEED, 240_000_000);
        assertEq(
            SqrtPriceMath.getAmount0Delta(
                HKMN_CURRENCY0_SQRT_PRICE_X96,
                TickMath.getSqrtPriceAtTick(TICK_UPPER),
                liquidity,
                true
            ),
            HKMN_CURRENCY0_CONSUMED_AMOUNT0
        );
        assertEq(
            SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(TICK_LOWER),
                HKMN_CURRENCY0_SQRT_PRICE_X96,
                liquidity,
                true
            ),
            HKMN_CURRENCY0_CONSUMED_AMOUNT1
        );
    }

    function test_v4TickMathGeneratesTheCommittedVectorArtifact() external {
        PhaseThreeTickMathVectors writer = new PhaseThreeTickMathVectors();
        assertEq(keccak256(bytes(writer.canonicalJson())), TICK_MATH_VECTORS_KECCAK);
    }

    function test_v4TickMathWriterEmitsTheCommittedVectorBytes() external {
        string memory outputDirectory = "test/release/.generated";
        string memory outputPath = "test/release/.generated/phase3-tickmath-vectors.json";
        PhaseThreeTickMathVectors writer = new PhaseThreeTickMathVectors();

        vm.createDir(outputDirectory, true);
        writer.writeVectors(outputPath);

        assertEq(keccak256(bytes(vm.readFile(outputPath))), TICK_MATH_VECTORS_KECCAK);
        vm.removeFile(outputPath);
        vm.removeDir(outputDirectory, false);
    }
}
