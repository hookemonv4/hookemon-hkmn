// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {
    BlindAmountMode,
    BlindDeploymentConfig,
    BlindFeeSplit,
    BlindMarketFeesFixture,
    BlindSwapRequest,
    BlindSwapSide,
    BlindTokenOrder
} from "./fixtures/BlindMarketFeesFixture.sol";

contract BlindMarketFeesPrepTest {
    error BlindPrepAssertionFailed(string reason);

    uint256 internal constant EXECUTED_USDG = 10_000;
    uint256 internal constant HKMN_AMOUNT = 420_690;
    uint256 internal constant UNTRUSTED_NOMINAL_SENTINEL = type(uint128).max;
    uint160 internal constant ALL_HOOK_MASK = uint160((1 << 14) - 1);
    uint160 internal constant FROZEN_HOOK_MASK = 0x20CC;

    function test_fixtureCatalogCoversAllEightSwapQuadrants() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();
        uint256 observedQuadrants;

        for (uint256 orderIndex; orderIndex < 2; ++orderIndex) {
            BlindTokenOrder order = BlindTokenOrder(orderIndex);
            BlindDeploymentConfig memory config = fixture.configuration(order);

            for (uint256 sideIndex; sideIndex < 2; ++sideIndex) {
                BlindSwapSide side = BlindSwapSide(sideIndex);

                for (uint256 modeIndex; modeIndex < 2; ++modeIndex) {
                    BlindAmountMode amountMode = BlindAmountMode(modeIndex);
                    BlindSwapRequest memory request =
                        fixture.swapRequest(config, side, amountMode, EXECUTED_USDG, HKMN_AMOUNT);

                    _assertEq(
                        uint256(request.side), sideIndex, "fixture changed the requested swap side"
                    );
                    _assertEq(
                        uint256(request.amountMode),
                        modeIndex,
                        "fixture changed the requested amount mode"
                    );
                    _assertAddressMappedDeltas(config, request, side);
                    ++observedQuadrants;
                }
            }
        }

        _assertEq(observedQuadrants, 8, "fixture catalog does not contain all eight quadrants");
    }

    function test_fixtureCatalogBindsNinetyPercentCustodyAndZeroLpFee() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();

        for (uint256 orderIndex; orderIndex < 2; ++orderIndex) {
            BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder(orderIndex));

            _assertEq(
                config.canonicalPoolKey.staticLpFee,
                0,
                "fixture canonical PoolKey has a nonzero LP fee"
            );
            _assertEq(
                config.launchHkmnAllocation,
                config.fixedHkmnSupply * 90 / 100,
                "fixture launch allocation differs from ninety percent"
            );
            _assertTrue(
                config.canonicalPoolKey.currency0 < config.canonicalPoolKey.currency1,
                "fixture currencies are not address ordered"
            );
        }
    }

    function test_fixtureHookUsesFrozenPermissionMask() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();

        for (uint256 orderIndex; orderIndex < 2; ++orderIndex) {
            BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder(orderIndex));

            _assertEq(
                uint160(config.hooks) & ALL_HOOK_MASK,
                FROZEN_HOOK_MASK,
                "fixture hook does not use the frozen permission mask"
            );
            _assertEq(
                uint160(config.canonicalPoolKey.hooks),
                uint160(config.hooks),
                "fixture PoolKey does not use the configured hook"
            );
        }
    }

    function test_displayedNominalUsdgIsNeverSpecifiedAmountOrFeeBasis() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();

        for (uint256 orderIndex; orderIndex < 2; ++orderIndex) {
            BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder(orderIndex));

            for (uint256 sideIndex; sideIndex < 2; ++sideIndex) {
                BlindSwapSide side = BlindSwapSide(sideIndex);

                for (uint256 modeIndex; modeIndex < 2; ++modeIndex) {
                    BlindAmountMode amountMode = BlindAmountMode(modeIndex);
                    BlindSwapRequest memory request =
                        fixture.swapRequest(config, side, amountMode, EXECUTED_USDG, HKMN_AMOUNT);
                    (uint256 executedUsdg, uint256 executedHkmn) = _executedAmounts(config, request);
                    uint256 specifiedAmount = amountMode == BlindAmountMode.ExactInput
                        ? (side == BlindSwapSide.Buy ? executedUsdg : executedHkmn)
                        : (side == BlindSwapSide.Buy ? executedHkmn : executedUsdg);

                    _assertEq(
                        request.displayedNominalUsdg,
                        UNTRUSTED_NOMINAL_SENTINEL,
                        "fixture nominal value is not an explicit poison sentinel"
                    );
                    _assertNotEq(
                        request.displayedNominalUsdg,
                        specifiedAmount,
                        "displayed nominal USDG was accepted as specifiedAmount"
                    );
                    _assertNotEq(
                        request.displayedNominalUsdg,
                        executedUsdg,
                        "displayed nominal USDG was accepted as executed USDG"
                    );
                    _assertEq(
                        _split(executedUsdg).total, 300, "fee basis did not use executed USDG"
                    );
                    _assertNotEq(
                        _split(request.displayedNominalUsdg).total,
                        _split(executedUsdg).total,
                        "displayed nominal USDG was accepted as the fee basis"
                    );
                }
            }
        }
    }

    function test_roundingCatalogConservesEveryBoundaryUnit() external pure {
        uint256[9] memory quantities = [uint256(1), 33, 34, 249, 250, 999, 1_000, 3_333, 3_334];
        uint256[9] memory totals = [uint256(0), 0, 1, 7, 7, 29, 30, 99, 100];
        uint256[9] memory programmable = [uint256(0), 0, 0, 0, 0, 0, 1, 3, 3];
        uint256[9] memory treasury = [uint256(0), 0, 0, 0, 1, 3, 4, 13, 13];
        uint256[9] memory process = [uint256(0), 0, 1, 7, 6, 26, 25, 83, 84];

        for (uint256 index; index < quantities.length; ++index) {
            BlindFeeSplit memory split = _split(quantities[index]);
            _assertEq(split.total, totals[index], "rounding catalog total differs");
            _assertEq(
                split.programmable,
                programmable[index],
                "rounding catalog Programmable share differs"
            );
            _assertEq(split.treasury, treasury[index], "rounding catalog treasury share differs");
            _assertEq(split.process, process[index], "rounding catalog process remainder differs");
            _assertEq(
                split.programmable + split.treasury + split.process,
                split.total,
                "rounding catalog leaves unassigned dust"
            );
        }
    }

    function test_unclaimedProductionBindingRemainsExplicitlyUnavailable() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();
        BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder.UsdgCurrency0);

        (bool succeeded, bytes memory revertData) =
            address(fixture).call(abi.encodeCall(BlindMarketFeesFixture.deploy, (config)));

        _assertFalse(succeeded, "unclaimed prep unexpectedly supplied a production binding");
        _assertEq(
            bytes32(_selector(revertData)),
            bytes32(BlindMarketFeesFixture.BlindMarketFeesImplementationNotBound.selector),
            "unclaimed prep reverted for the wrong reason"
        );
    }

    function _assertAddressMappedDeltas(
        BlindDeploymentConfig memory config,
        BlindSwapRequest memory request,
        BlindSwapSide side
    ) internal pure {
        int256 expectedUsdg = side == BlindSwapSide.Buy
            ? -int256(EXECUTED_USDG)
            : int256(EXECUTED_USDG);
        int256 expectedHkmn = side == BlindSwapSide.Buy ? int256(HKMN_AMOUNT) : -int256(HKMN_AMOUNT);
        bool usdgIsCurrency0 = config.canonicalPoolKey.currency0 == config.usdg;

        _assertEq(
            request.currency0TraderDelta,
            usdgIsCurrency0 ? expectedUsdg : expectedHkmn,
            "fixture mapped the wrong currency0 delta"
        );
        _assertEq(
            request.currency1TraderDelta,
            usdgIsCurrency0 ? expectedHkmn : expectedUsdg,
            "fixture mapped the wrong currency1 delta"
        );
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

    function _split(uint256 executedUsdg) internal pure returns (BlindFeeSplit memory split) {
        split.total = executedUsdg * 300 / 10_000;
        split.programmable = executedUsdg * 10 / 10_000;
        split.treasury = executedUsdg * 40 / 10_000;
        split.process = split.total - split.programmable - split.treasury;
    }

    function _selector(bytes memory revertData) internal pure returns (bytes4 selector) {
        if (revertData.length < 4) {
            revert BlindPrepAssertionFailed("binding sentinel returned malformed revert data");
        }
        assembly ("memory-safe") {
            selector := mload(add(revertData, 0x20))
        }
    }

    function _assertEq(uint256 actual, uint256 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindPrepAssertionFailed(reason);
    }

    function _assertEq(int256 actual, int256 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindPrepAssertionFailed(reason);
    }

    function _assertEq(bytes32 actual, bytes32 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindPrepAssertionFailed(reason);
    }

    function _assertNotEq(uint256 actual, uint256 expected, string memory reason) internal pure {
        if (actual == expected) revert BlindPrepAssertionFailed(reason);
    }

    function _assertTrue(bool value, string memory reason) internal pure {
        if (!value) revert BlindPrepAssertionFailed(reason);
    }

    function _assertFalse(bool value, string memory reason) internal pure {
        if (value) revert BlindPrepAssertionFailed(reason);
    }
}
