// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault, PayoutDomainTypedData } from "./IPegCycleVault.sol";

/// @notice Validates one `PayoutAuthorization` against the vault's active cycle and consumption
/// state, then verifies the two pinned EIP-712 signatures `PegCycleVault.authorizePayout`
/// requires (decision D7): a distribution-signer signature and an independent verifier signature,
/// both over the same `PayoutDistribution` digest (see `IPegCycleVault`'s module docstring for the
/// domain and struct this hashes).
/// @dev Declared as an `external` library deliberately: every function here is called through a
/// real `DELEGATECALL`, not inlined, so this logic's bytecode is deployed once, separately, and
/// does not count against `PegCycleVault`'s own EIP-170 24,576-byte runtime budget. `verify` takes
/// every piece of vault state it needs (the active cycle's frozen authorization, the three
/// consumption flags, and the escrow's live balance) as plain value/memory arguments rather than
/// reading `PegCycleVault`'s storage itself: the library's own state stays exactly nothing, so a
/// future storage-layout change on the vault can never silently desynchronize it from this check.
library PayoutDistributionSignatures {
    /// @notice Any field of `authorization` does not exactly match the vault's active cycle,
    /// deployment identities, or consumption/balance state.
    error InvalidAuthorization();
    /// @notice `authorization.payoutId` was already consumed by an earlier `authorizePayout` call.
    error PayoutIdAlreadyConsumed();
    /// @notice One or both signatures is empty or not a well-formed 65-byte (r,s,v) signature.
    error MissingSignature();
    /// @notice The two signatures are byte-identical; two distinct signatures are always
    /// required, so a duplicate is rejected before recovery is attempted.
    error DuplicateSignature();
    /// @notice A signature's `s` value lies in the upper half order (or its `v` is not 27/28):
    /// ecrecover-malleable signatures are never accepted.
    error MalleableSignature();
    /// @notice A well-formed, non-malleable signature nonetheless recovers to `address(0)`.
    error InvalidSignature();
    /// @notice `distributionSignature` does not recover to the pinned `distributionSigner`.
    error InvalidDistributionSigner();
    /// @notice `verifierSignature` does not recover to the pinned `distributionVerifier`.
    error InvalidDistributionVerifier();

    /// @dev The revision this library's field validation is written for -- identical to
    /// `PegCycleVault.REQUIREMENTS_REVISION` by construction; this library is deployed and pinned
    /// per-vault, not shared generically, so duplicating the constant here (rather than passing
    /// it as a call argument) costs nothing in practice and one less field to encode.
    uint32 private constant REQUIREMENTS_REVISION = 57;

    /// @dev Everything `authorizePayout` already holds in memory or storage that this check
    /// needs, besides `authorization`, the two signatures, and `address(this)` (this function
    /// runs via `DELEGATECALL`, so `address(this)` here already resolves to the vault, not the
    /// library). Bundled into one struct so the external call stays one manageable parameter list
    /// rather than a dozen loose scalars. `escrowAddress` itself is deliberately absent: a zero
    /// address always carries a zero balance, which `escrowBalance < authorization.rootSum`
    /// already rejects on its own (every accepted `rootSum` is provably positive), so a separate
    /// zero-escrow check would only ever duplicate that outcome.
    struct ActiveCycleContext {
        bytes32 activeCycleId;
        address hook;
        address usdg;
        address operationsTrigger;
        bytes32 bindingManifestDigest;
        uint256 minimumReturnUsdg;
        bytes32 returnActionDigest;
        bool nonceConsumed;
        bool payoutIdConsumed;
        bool returnReceiptConsumed;
        uint256 escrowBalance;
    }

    /// @notice Reverts unless `authorization` exactly matches `context` (and this vault's own
    /// address, read as `address(this)` under the `DELEGATECALL` this runs through) and carries
    /// two valid, distinct signatures recovering to `distributionSigner` and
    /// `distributionVerifier` respectively, over its `PayoutDistribution` subject under
    /// `domainSeparator`. Returns nothing on success.
    function verify(
        bytes32 domainSeparator,
        IPegCycleVault.PayoutAuthorization calldata authorization,
        ActiveCycleContext calldata context,
        bytes calldata distributionSignature,
        bytes calldata verifierSignature,
        address distributionSigner,
        address distributionVerifier
    ) external view {
        if (
            authorization.requirementsRevision != REQUIREMENTS_REVISION
                || authorization.chainId != block.chainid
                || authorization.cycleId != context.activeCycleId
                || authorization.hook != context.hook || authorization.vault != address(this)
                || authorization.usdg != context.usdg
                || authorization.operationsTrigger != context.operationsTrigger
                || authorization.bindingManifestDigest != context.bindingManifestDigest
                || authorization.payoutId == bytes32(0)
                || authorization.manifestDigest == bytes32(0)
                || authorization.rootHash == bytes32(0)
                || authorization.rootSum < context.minimumReturnUsdg
                || authorization.returnActionDigest != context.returnActionDigest
                || authorization.returnReceiptDigest == bytes32(0)
                || authorization.expiresAt <= block.timestamp || authorization.nonce == 0
                || context.nonceConsumed || context.returnReceiptConsumed
                || context.escrowBalance < authorization.rootSum
        ) revert InvalidAuthorization();
        if (context.payoutIdConsumed) revert PayoutIdAlreadyConsumed();

        if (distributionSignature.length == 0 || verifierSignature.length == 0) {
            revert MissingSignature();
        }
        if (keccak256(distributionSignature) == keccak256(verifierSignature)) {
            revert DuplicateSignature();
        }
        bytes32 digest = _payoutDistributionDigest(domainSeparator, authorization);
        if (_recoverSigner(digest, distributionSignature) != distributionSigner) {
            revert InvalidDistributionSigner();
        }
        if (_recoverSigner(digest, verifierSignature) != distributionVerifier) {
            revert InvalidDistributionVerifier();
        }
    }

    function _payoutDistributionDigest(
        bytes32 domainSeparator,
        IPegCycleVault.PayoutAuthorization calldata authorization
    ) private pure returns (bytes32) {
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
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @dev Recovers the signer of `digest` from a 65-byte (r,s,v) ECDSA `signature`, rejecting a
    /// malformed length, an upper-half-order `s` (signature malleability), or a recovery that
    /// resolves to `address(0)` with distinct, named errors rather than a single generic revert.
    function _recoverSigner(bytes32 digest, bytes calldata signature)
        private
        pure
        returns (address signer)
    {
        if (signature.length != 65) revert MissingSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        // secp256k1n / 2 -- the yellow paper's Appendix F upper bound on a canonical (lower-half)
        // `s`. Rejecting the upper half and requiring `v` in {27,28} removes ecrecover's
        // signature malleability outright, matching the audited pattern OpenZeppelin's ECDSA
        // library uses, reimplemented narrowly here (only the 65-byte (r,s,v) form this contract
        // ever produces or accepts).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert MalleableSignature();
        }
        if (v != 27 && v != 28) revert MalleableSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
