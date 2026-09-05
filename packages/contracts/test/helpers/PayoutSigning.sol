// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault, PayoutDomainTypedData } from "../../src/process/IPegCycleVault.sol";

interface PayoutSigningVm {
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
}

/// @notice Shared test-only helper for `PegCycleVault.authorizePayout`'s dual EIP-712 signature
/// requirement (decision D7). Reproduces the vault's exact domain separator and
/// `PayoutDistribution` digest, and produces (r,s,v)-packed ECDSA signatures via Foundry's
/// `vm.sign`, so every Forge suite that exercises `authorizePayout` builds its distribution-signer
/// and verifier signatures through one canonical path instead of re-deriving the hashing scheme by
/// hand in each test file.
library PayoutSigning {
    PayoutSigningVm private constant VM =
        PayoutSigningVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Arbitrary, fixed, non-zero test private keys for the two pinned identities. Never
    /// used outside this test suite; production keys are owner/operator-configured (D3/D7).
    uint256 internal constant DISTRIBUTION_SIGNER_KEY =
        0x5150a1a7b1b34fc0678868b19c65e5e1841c151b6dd25f3e7d3729a7d5c8213b;
    uint256 internal constant DISTRIBUTION_VERIFIER_KEY =
        0x2c94d7f5911d5cca909a719d0d5eea9d8b3a2a68bb02f8d4c412ea6ee9d2731b;

    function distributionSignerAddress() internal pure returns (address) {
        return VM.addr(DISTRIBUTION_SIGNER_KEY);
    }

    function distributionVerifierAddress() internal pure returns (address) {
        return VM.addr(DISTRIBUTION_VERIFIER_KEY);
    }

    /// @dev `PegCycleVault.domainSeparator` is intentionally not a public getter (every byte of
    /// its own runtime bytecode is scarce under the EIP-170 limit); off-chain and test-side
    /// signers reproduce it independently instead, exactly as real EIP-712 tooling normally does,
    /// from the same three public inputs: the fixed domain name/version, the live chain ID, and
    /// the vault's own address as `verifyingContract`.
    function computeDomainSeparator(address vault) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                PayoutDomainTypedData.EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(PayoutDomainTypedData.EIP712_DOMAIN_NAME)),
                keccak256(bytes(PayoutDomainTypedData.EIP712_DOMAIN_VERSION)),
                block.chainid,
                vault
            )
        );
    }

    /// @dev The exact digest `PayoutDistributionSignatures` computes on-chain: the EIP-712
    /// encoding of `authorization`'s `PayoutDistribution` subject under `domainSeparator` (see
    /// `computeDomainSeparator` above for how callers reproduce that value).
    function digest(
        bytes32 domainSeparator,
        IPegCycleVault.PayoutAuthorization memory authorization
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PayoutDomainTypedData.PAYOUT_DISTRIBUTION_TYPEHASH,
                authorization.requirementsRevision,
                authorization.chainId,
                authorization.cycleId,
                authorization.hook,
                authorization.vault,
                authorization.usdg,
                authorization.operationsTrigger,
                authorization.bindingManifestDigest,
                authorization.payoutId,
                authorization.manifestDigest,
                authorization.rootHash,
                authorization.rootSum
            )
        );
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator, structHash));
    }

    /// @notice Produces the standard (distribution-signer, verifier) signature pair over
    /// `authorization` for `domainSeparator`, using the fixed test keys above.
    function signPair(
        bytes32 domainSeparator,
        IPegCycleVault.PayoutAuthorization memory authorization
    ) internal pure returns (bytes memory distributionSignature, bytes memory verifierSignature) {
        bytes32 payoutDigest = digest(domainSeparator, authorization);
        distributionSignature = sign(DISTRIBUTION_SIGNER_KEY, payoutDigest);
        verifierSignature = sign(DISTRIBUTION_VERIFIER_KEY, payoutDigest);
    }

    function sign(uint256 privateKey, bytes32 payoutDigest)
        internal
        pure
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(privateKey, payoutDigest);
        signature = abi.encodePacked(r, s, v);
    }
}
