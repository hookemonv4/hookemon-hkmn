// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { CustomLaunchStrategy } from "../../src/launch/CustomLaunchStrategy.sol";
import { HookemonIssuance } from "../../src/launch/HookemonIssuance.sol";

interface Vm {
    function prank(address caller) external;
}

contract IntegrationGuard is HookemonIssuance {
    constructor(address authority, bytes32 bindingDigest, bytes32 runtimeDigest)
        HookemonIssuance(authority, 18, bindingDigest, runtimeDigest)
    { }
}

contract HookemonIssuanceIntegrationTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant OWNER = address(0xA11CE);
    bytes32 private constant BINDING_DIGEST = keccak256("retired-integration-binding");
    bytes32 private constant RUNTIME_DIGEST = keccak256("retired-integration-runtime");

    function testRetiredStrategyCannotMutateAnIssuanceGuard() external {
        CustomLaunchStrategy strategy = _strategy();
        IntegrationGuard guard =
            new IntegrationGuard(address(strategy), BINDING_DIGEST, RUNTIME_DIGEST);

        VM.prank(OWNER);
        (bool success, bytes memory result) =
            address(strategy).call(abi.encodeCall(strategy.launch, ()));

        assert(!success);
        assert(_selector(result) == CustomLaunchStrategy.LaunchPathDisabled.selector);
        assert(guard.readTokenState().status == HookemonIssuance.GuardStatus.UNPREPARED);
    }

    function _strategy() private returns (CustomLaunchStrategy strategy) {
        CustomLaunchStrategy.PlaceholderLbpCurve memory curve =
            CustomLaunchStrategy.PlaceholderLbpCurve({
                minLaunchTick: -160_000,
                initialTick: -20_000,
                decayDurationSeconds: 7 days,
                description: "retired integration curve"
            });
        strategy = new CustomLaunchStrategy(
            address(0x1111),
            address(0x2222),
            OWNER,
            address(0x3333),
            18,
            BINDING_DIGEST,
            RUNTIME_DIGEST,
            7 days,
            curve
        );
    }

    function _selector(bytes memory result) private pure returns (bytes4 selector) {
        if (result.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(result, 0x20))
        }
    }
}
