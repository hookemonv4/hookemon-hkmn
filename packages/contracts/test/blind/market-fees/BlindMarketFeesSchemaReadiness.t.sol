// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {
    BlindAmountMode,
    BlindDeploymentConfig,
    BlindMarketFeesFixture,
    BlindSwapRequest,
    BlindSwapSide,
    BlindTokenOrder
} from "./fixtures/BlindMarketFeesFixture.sol";

/// @dev P1-001 callback/delta conventions consumed by the concrete P1-002 adapter.
contract BlindMarketFeesSchemaReadinessTest {
    error BlindReadinessAssertionFailed(string reason);

    uint256 internal constant EXECUTED_USDG = 10_000;
    uint256 internal constant EXECUTED_HKMN = 420_690;
    address internal constant EXPECTED_BUYER = address(0x8000);

    function test_rawDeltasMapToExecutedUsdgAndExecutedHkmn() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();

        for (uint256 orderIndex; orderIndex < 2; ++orderIndex) {
            BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder(orderIndex));

            for (uint256 sideIndex; sideIndex < 2; ++sideIndex) {
                for (uint256 modeIndex; modeIndex < 2; ++modeIndex) {
                    BlindSwapRequest memory request = fixture.swapRequest(
                        config,
                        BlindSwapSide(sideIndex),
                        BlindAmountMode(modeIndex),
                        EXECUTED_USDG,
                        EXECUTED_HKMN
                    );
                    (uint256 observedUsdg, uint256 observedHkmn) = _executedAmounts(config, request);

                    _assertEq(
                        observedUsdg, EXECUTED_USDG, "raw deltas mapped the wrong executed USDG"
                    );
                    _assertEq(
                        observedHkmn, EXECUTED_HKMN, "raw deltas mapped the wrong executed HKMN"
                    );
                }
            }
        }
    }

    function test_buyQuadrantsKeepTheCanonicalCallbackSender() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();

        for (uint256 orderIndex; orderIndex < 2; ++orderIndex) {
            BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder(orderIndex));

            for (uint256 modeIndex; modeIndex < 2; ++modeIndex) {
                BlindSwapRequest memory request = fixture.swapRequest(
                    config,
                    BlindSwapSide.Buy,
                    BlindAmountMode(modeIndex),
                    EXECUTED_USDG,
                    EXECUTED_HKMN
                );

                _assertEq(
                    uint160(request.trader),
                    uint160(EXPECTED_BUYER),
                    "fixture changed the expected buyer"
                );
                _assertEq(
                    uint160(request.finalizedSender),
                    uint160(request.callbackSender),
                    "finalized callback sender changed"
                );
                if (request.callbackSender == address(0)) {
                    revert BlindReadinessAssertionFailed("callback sender is zero");
                }
            }
        }
    }

    function _executedAmounts(BlindDeploymentConfig memory config, BlindSwapRequest memory request)
        internal
        pure
        returns (uint256 executedUsdg, uint256 executedHkmn)
    {
        bool usdgIsCurrency0 = config.canonicalPoolKey.currency0 == config.usdg;
        int256 usdgDelta =
            usdgIsCurrency0 ? request.currency0TraderDelta : request.currency1TraderDelta;
        int256 hkmnDelta =
            usdgIsCurrency0 ? request.currency1TraderDelta : request.currency0TraderDelta;

        executedUsdg = _absolute(usdgDelta);
        executedHkmn = _absolute(hkmnDelta);
    }

    function _absolute(int256 value) internal pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindReadinessAssertionFailed(reason);
    }
}
