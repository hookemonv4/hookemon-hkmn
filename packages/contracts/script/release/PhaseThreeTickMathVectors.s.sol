// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script } from "forge-std/Script.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Regenerates the committed Phase 3 TickMath vectors from the pinned Solidity library.
contract PhaseThreeTickMathVectors is Script {
    string internal constant OUTPUT_PATH = "../../release/phase3/tickmath-vectors.json";
    int24 internal constant PHASE_THREE_MIN_TICK = -887220;
    int24 internal constant PHASE_THREE_MAX_TICK = 887220;

    function run() external {
        writeVectors(OUTPUT_PATH);
    }

    function writeVectors(string memory outputPath) public {
        vm.writeFile(outputPath, canonicalJson());
    }

    function canonicalJson() public pure returns (string memory output) {
        output = string.concat(
            "{\n",
            "  \"schemaVersion\": \"hookemon.phase3.tickmath-vectors.v1\",\n",
            "  \"canonicalSource\": {\n",
            "    \"path\": \"packages/contracts/lib/v4-core/src/libraries/TickMath.sol\",\n",
            "    \"revision\": \"46c6834698c48bc4a463a86d8420f4eb1d7f3b75\",\n",
            "    \"function\": \"TickMath.getSqrtPriceAtTick\"\n",
            "  },\n",
            "  \"phaseThreeFullRange\": {\n",
            "    \"minimumTick\": -887220,\n",
            "    \"maximumTick\": 887220,\n",
            "    \"sqrtLowerX96\": \"",
            vm.toString(uint256(TickMath.getSqrtPriceAtTick(PHASE_THREE_MIN_TICK))),
            "\",\n",
            "    \"sqrtUpperX96\": \"",
            vm.toString(uint256(TickMath.getSqrtPriceAtTick(PHASE_THREE_MAX_TICK))),
            "\"\n",
            "  },\n",
            "  \"vectors\": [\n"
        );

        int24[] memory ticks = _ticks();
        for (uint256 index; index < ticks.length; ++index) {
            output = string.concat(
                output,
                "    { \"tick\": ",
                vm.toString(int256(ticks[index])),
                ", \"sqrtPriceX96\": \"",
                vm.toString(uint256(TickMath.getSqrtPriceAtTick(ticks[index]))),
                "\" }",
                index + 1 == ticks.length ? "\n" : ",\n"
            );
        }
        return string.concat(output, "  ]\n}\n");
    }

    function _ticks() private pure returns (int24[] memory ticks) {
        ticks = new int24[](44);
        for (uint256 bit; bit < 20; ++bit) {
            int24 oneBitTick = int24(uint24(1) << uint24(bit));
            ticks[2 * bit] = -oneBitTick;
            ticks[2 * bit + 1] = oneBitTick;
        }
        ticks[40] = TickMath.MIN_TICK;
        ticks[41] = TickMath.MAX_TICK;
        ticks[42] = PHASE_THREE_MIN_TICK;
        ticks[43] = PHASE_THREE_MAX_TICK;
    }
}
