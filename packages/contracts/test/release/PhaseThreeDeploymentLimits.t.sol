// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";

import { HookemonHook } from "../../src/HookemonHook.sol";
import { PermanentPositionCustody } from "../../src/bindings/RobinhoodBindings.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";

contract PhaseThreeDeploymentLimitsTest is Test {
    uint256 private constant PHASE_THREE_BLOCK_GAS_LIMIT = 30_000_000;
    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    address private constant USDG = address(0x1002);
    address private constant HKMN = address(0x1003);
    address private constant PROGRAMMABLE = 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c;

    // Component measurements are intentionally distinct from an exact provider-route gas proof.
    function testMeasuredReleaseTargetComponentsStayBelowPinnedBlockGasLimit() external {
        HookemonHook.ConstructorConfig memory config = _hookConfig();
        bytes32 hookInitCodeHash =
            keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));

        vm.pauseGasMetering();
        bytes32 hookSalt = _mineHookSalt(hookInitCodeHash);
        vm.resumeGasMetering();

        uint256 tokenGas = _deployToken();
        uint256 custodyGas = _deployCustody();
        uint256 hookGas = _deployHook(config, hookSalt);

        _assertComponentGasHeadroom("HKMNToken deployment component gas", tokenGas);
        _assertComponentGasHeadroom("PermanentPositionCustody deployment component gas", custodyGas);
        _assertComponentGasHeadroom("HookemonHook deployment component gas", hookGas);
    }

    function _deployToken() private returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();
        HKMNToken token =
            new HKMNToken(address(this), USDG, 18, 194068571418249185253397768292205730969);
        gasUsed = gasBefore - gasleft();
        assertGt(address(token).code.length, 0);
    }

    function _deployCustody() private returns (uint256 gasUsed) {
        uint256 gasBefore = gasleft();
        PermanentPositionCustody custody = new PermanentPositionCustody(address(0x1001), 0);
        gasUsed = gasBefore - gasleft();
        assertGt(address(custody).code.length, 0);
    }

    function _deployHook(HookemonHook.ConstructorConfig memory config, bytes32 salt)
        private
        returns (uint256 gasUsed)
    {
        uint256 gasBefore = gasleft();
        HookemonHook hook = new HookemonHook{ salt: salt }(config);
        gasUsed = gasBefore - gasleft();
        assertGt(address(hook).code.length, 0);
    }

    function _assertComponentGasHeadroom(string memory label, uint256 gasUsed) private {
        assertLt(gasUsed, PHASE_THREE_BLOCK_GAS_LIMIT, label);
        emit log_named_uint(label, gasUsed);
        emit log_named_uint(
            string.concat(label, " headroom"), PHASE_THREE_BLOCK_GAS_LIMIT - gasUsed
        );
    }

    function _hookConfig() private view returns (HookemonHook.ConstructorConfig memory config) {
        config = HookemonHook.ConstructorConfig({
            manager: IPoolManager(address(0x1001)),
            positionManager: address(0x1004),
            permit2: address(0x1005),
            usdg: Currency.wrap(USDG),
            hkmn: Currency.wrap(HKMN),
            tickSpacing: 60,
            programmable: PROGRAMMABLE,
            treasury: address(0x1006),
            operations: address(0x1007),
            launchAuthority: address(0x1008),
            issuanceAuthority: address(this),
            expectedDecimals: 18,
            bindingDigest: bytes32(uint256(1)),
            runtimeDigest: bytes32(uint256(2)),
            processClaimLimit6h: 50_000_000_000,
            processClaimLimitMax: 500_000_000_000,
            processClaimMaxCount: 24,
            operationsRotationDelay: 43_200
        });
    }

    function _mineHookSalt(bytes32 initCodeHash) private view returns (bytes32) {
        for (uint256 candidate; candidate < 131_072; ++candidate) {
            bytes32 salt = bytes32(candidate);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
            if (uint160(predicted) & ALL_HOOK_PERMISSION_MASK == REQUIRED_HOOK_PERMISSION_MASK) {
                return salt;
            }
        }
        revert("hook salt was not found");
    }
}
