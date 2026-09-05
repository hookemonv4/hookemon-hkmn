// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { CustomLaunchStrategy } from "../../src/launch/CustomLaunchStrategy.sol";
import {
    TestLiquidityLauncher,
    TestUERC20Factory
} from "./fixtures/TestLiquidityLauncherStack.sol";

interface Vm {
    function prank(address caller) external;
}

contract CustomLaunchStrategyTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant OWNER = address(0xA11CE);
    address private constant PROJECT = address(0xB000);
    bytes32 private constant BINDING_DIGEST = keccak256("retired-strategy-binding");
    bytes32 private constant RUNTIME_DIGEST = keccak256("retired-strategy-runtime");

    function testAllMutatingLaunchEntryPointsFailClosed() external {
        (CustomLaunchStrategy strategy,) = _deploy();

        VM.prank(OWNER);
        _expectLaunchPathDisabled(address(strategy), abi.encodeCall(strategy.launch, ()));
        assert(!strategy.launched());
        assert(!strategy.issuanceGuardBound());

        VM.prank(OWNER);
        _expectLaunchPathDisabled(
            address(strategy), abi.encodeCall(strategy.bindIssuanceGuard, (address(0xCAFE)))
        );
        assert(!strategy.issuanceGuardBound());

        _expectLaunchPathDisabled(
            address(strategy),
            abi.encodeCall(
                strategy.initializeDistribution,
                (address(0x1234), 420_690_000_000e18, "", bytes32(0))
            )
        );
    }

    function testConstructorDoesNotCreateAuxiliaryLaunchTargets() external {
        (CustomLaunchStrategy strategy,) = _deploy();

        assert(strategy.remainderRepresentation() == address(0));
        assert(strategy.marketPositionCustody() == address(0));
    }

    function _expectLaunchPathDisabled(address target, bytes memory callData) private {
        (bool success, bytes memory result) = target.call(callData);
        assert(!success);
        assert(_selector(result) == CustomLaunchStrategy.LaunchPathDisabled.selector);
    }

    function _selector(bytes memory result) private pure returns (bytes4 selector) {
        if (result.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(result, 0x20))
        }
    }

    function _deploy()
        private
        returns (CustomLaunchStrategy strategy, TestLiquidityLauncher launcher)
    {
        launcher = new TestLiquidityLauncher();
        TestUERC20Factory factory = new TestUERC20Factory();
        CustomLaunchStrategy.PlaceholderLbpCurve memory curve =
            CustomLaunchStrategy.PlaceholderLbpCurve({
                minLaunchTick: -160_000,
                initialTick: -20_000,
                decayDurationSeconds: 7 days,
                description: "retired compatibility curve"
            });
        strategy = new CustomLaunchStrategy(
            address(launcher),
            address(factory),
            OWNER,
            PROJECT,
            18,
            BINDING_DIGEST,
            RUNTIME_DIGEST,
            7 days,
            curve
        );
    }
}
