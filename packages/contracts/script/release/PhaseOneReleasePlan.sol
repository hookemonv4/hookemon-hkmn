// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PegCycleVault } from "../../src/process/PegCycleVault.sol";

/// @notice Canonical local deployment plan and read-only deployed-code verifier.
/// @dev This contract deliberately exposes no transaction execution entrypoint.
contract PhaseOneReleasePlan {
    bytes32 public constant SCHEMA = keccak256("HOOKEMON_PHASE_ONE_RELEASE_PLAN_V3");
    bytes32 private constant EMPTY_CODE_HASH = keccak256("");

    struct Plan {
        uint256 chainId;
        address usdg;
        address programmable;
        address treasury;
        address operationsTrigger;
        address positionManager;
        address vaultDeployer;
        bytes32 vaultSalt;
        bytes32 vaultInitCodeHash;
        address expectedVault;
        address vaultUsdg;
        address vaultAuthorizer;
        address vaultRouteExecutor;
        bytes32 vaultBindingManifestDigest;
        address vaultDeploymentAuthority;
        address vaultDistributionSigner;
        address vaultDistributionVerifier;
        address hookDeployer;
        bytes32 hookSalt;
        bytes32 hookInitCodeHash;
        address expectedHook;
        bytes32 usdgRuntimeCodeHash;
        bytes32 positionManagerRuntimeCodeHash;
        bytes32 vaultRuntimeCodeHash;
        bytes32 hookRuntimeCodeHash;
        bytes32 candidateManifestSha256;
    }

    error InvalidPlan();
    error WrongChain(uint256 actual, uint256 expected);
    error HookAddressMismatch(address actual, address expected);
    error VaultAddressMismatch(address actual, address expected);
    error VaultInitCodeHashMismatch(bytes32 actual, bytes32 expected);
    error MissingRuntimeCode(address target);
    error RuntimeCodeMismatch(address target, bytes32 actual, bytes32 expected);

    function validate(Plan calldata plan) external view returns (bytes32 planDigest) {
        return _validate(plan);
    }

    function verifyDeployedRuntime(Plan calldata plan)
        external
        view
        returns (bytes32 planDigest, bytes32 runtimeSetDigest)
    {
        planDigest = _validate(plan);
        bytes32 usdgCodeHash = _requireRuntime(plan.usdg, plan.usdgRuntimeCodeHash);
        bytes32 positionManagerCodeHash =
            _requireRuntime(plan.positionManager, plan.positionManagerRuntimeCodeHash);
        bytes32 vaultCodeHash = _requireRuntime(plan.expectedVault, plan.vaultRuntimeCodeHash);
        bytes32 hookCodeHash = _requireRuntime(plan.expectedHook, plan.hookRuntimeCodeHash);
        runtimeSetDigest = keccak256(
            abi.encode(SCHEMA, usdgCodeHash, positionManagerCodeHash, vaultCodeHash, hookCodeHash)
        );
    }

    function computeCreate2Address(address deployer, bytes32 salt, bytes32 initCodeHash)
        public
        pure
        returns (address)
    {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))
            )
        );
    }

    function _validate(Plan calldata plan) private view returns (bytes32 planDigest) {
        if (plan.chainId != block.chainid) revert WrongChain(block.chainid, plan.chainId);
        if (
            plan.usdg == address(0) || plan.programmable == address(0)
                || plan.treasury == address(0) || plan.operationsTrigger == address(0)
                || plan.positionManager == address(0) || plan.vaultDeployer == address(0)
                || plan.vaultInitCodeHash == bytes32(0) || plan.expectedVault == address(0)
                || plan.vaultUsdg == address(0) || plan.vaultAuthorizer == address(0)
                || plan.vaultRouteExecutor == address(0)
                || plan.vaultBindingManifestDigest == bytes32(0)
                || plan.vaultDeploymentAuthority == address(0) || plan.hookDeployer == address(0)
                || plan.vaultDistributionSigner == address(0)
                || plan.vaultDistributionVerifier == address(0)
                || plan.hookInitCodeHash == bytes32(0) || plan.usdgRuntimeCodeHash == bytes32(0)
                || plan.positionManagerRuntimeCodeHash == bytes32(0)
                || plan.vaultRuntimeCodeHash == bytes32(0) || plan.hookRuntimeCodeHash == bytes32(0)
                || plan.candidateManifestSha256 == bytes32(0) || plan.vaultUsdg != plan.usdg
        ) revert InvalidPlan();
        address[12] memory identities = [
            plan.usdg,
            plan.programmable,
            plan.treasury,
            plan.operationsTrigger,
            plan.positionManager,
            plan.expectedVault,
            plan.vaultAuthorizer,
            plan.vaultRouteExecutor,
            plan.vaultDeploymentAuthority,
            plan.expectedHook,
            plan.vaultDistributionSigner,
            plan.vaultDistributionVerifier
        ];
        for (uint256 left; left < identities.length; ++left) {
            for (uint256 right = left + 1; right < identities.length; ++right) {
                if (identities[left] == identities[right]) revert InvalidPlan();
            }
        }

        bytes32 computedVaultInitCodeHash = keccak256(
            abi.encodePacked(
                type(PegCycleVault).creationCode,
                abi.encode(
                    plan.vaultUsdg,
                    plan.vaultAuthorizer,
                    plan.vaultRouteExecutor,
                    plan.vaultBindingManifestDigest,
                    plan.vaultDeploymentAuthority,
                    plan.vaultDistributionSigner,
                    plan.vaultDistributionVerifier
                )
            )
        );
        if (computedVaultInitCodeHash != plan.vaultInitCodeHash) {
            revert VaultInitCodeHashMismatch(computedVaultInitCodeHash, plan.vaultInitCodeHash);
        }
        address computedVault =
            computeCreate2Address(plan.vaultDeployer, plan.vaultSalt, computedVaultInitCodeHash);
        if (computedVault != plan.expectedVault) {
            revert VaultAddressMismatch(computedVault, plan.expectedVault);
        }

        address computed =
            computeCreate2Address(plan.hookDeployer, plan.hookSalt, plan.hookInitCodeHash);
        if (computed != plan.expectedHook) revert HookAddressMismatch(computed, plan.expectedHook);
        planDigest = keccak256(abi.encode(SCHEMA, plan));
    }

    function _requireRuntime(address target, bytes32 expected)
        private
        view
        returns (bytes32 codeHash)
    {
        codeHash = target.codehash;
        if (codeHash == bytes32(0) || codeHash == EMPTY_CODE_HASH) {
            revert MissingRuntimeCode(target);
        }
        if (codeHash != expected) revert RuntimeCodeMismatch(target, codeHash, expected);
    }
}
