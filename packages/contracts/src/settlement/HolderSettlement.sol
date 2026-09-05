// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { CanonicalMerkleSum } from "../payout/CanonicalMerkleSum.sol";
import { PayoutCommitment } from "../payout/PayoutCommitment.sol";
import { IPegCycleVault } from "../process/IPegCycleVault.sol";

/// @notice Pays one funded canonical entitlement, from one closed payout chunk, to its committed
///         recipient.
abstract contract HolderSettlement is PayoutCommitment {
    mapping(
        bytes32 payoutId => mapping(uint16 chunkIndex => mapping(uint16 index => bool paid))
    ) private paidEntitlements;

    error InvalidEntitlementProof();
    error EntitlementAlreadyPaid();

    event EntitlementPaid(
        bytes32 indexed payoutId,
        uint16 indexed index,
        address indexed recipient,
        uint16 chunkIndex,
        uint256 amount
    );

    constructor(
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault pegCycleVault
    ) PayoutCommitment(programmable, treasury, operations, pegCycleVault) { }

    function payEntitlement(
        bytes32 payoutId,
        uint16 chunkIndex,
        uint16 index,
        address recipient,
        uint256 amount,
        bytes32[10] calldata siblingHashes,
        uint256[10] calldata siblingSums
    ) external moneyPath {
        if (paidEntitlements[payoutId][chunkIndex][index]) {
            revert EntitlementAlreadyPaid();
        }
        if (!_verifyEntitlementProof(
                payoutId, chunkIndex, index, recipient, amount, siblingHashes, siblingSums
            )) {
            revert InvalidEntitlementProof();
        }

        paidEntitlements[payoutId][chunkIndex][index] = true;
        _consumePayoutEntitlement(payoutId, amount);
        _transferExactUsdg(recipient, amount);
        _requireSolvent();

        emit EntitlementPaid(payoutId, index, recipient, chunkIndex, amount);
    }

    function verifyEntitlementProof(
        bytes32 payoutId,
        uint16 chunkIndex,
        uint16 index,
        address recipient,
        uint256 amount,
        bytes32[10] calldata siblingHashes,
        uint256[10] calldata siblingSums
    ) external view returns (bool) {
        return _verifyEntitlementProof(
            payoutId, chunkIndex, index, recipient, amount, siblingHashes, siblingSums
        );
    }

    function isPaid(bytes32 payoutId, uint16 chunkIndex, uint16 index)
        external
        view
        returns (bool)
    {
        return paidEntitlements[payoutId][chunkIndex][index];
    }

    function _verifyEntitlementProof(
        bytes32 payoutId,
        uint16 chunkIndex,
        uint16 index,
        address recipient,
        uint256 amount,
        bytes32[10] calldata siblingHashes,
        uint256[10] calldata siblingSums
    ) private view returns (bool) {
        PayoutRecord memory payout = _readPayout(payoutId);
        if (
            !payout.funded || !_isManifestClosed(payoutId) || index >= CanonicalMerkleSum.TREE_WIDTH
                || recipient == address(0) || recipient == address(this) || amount == 0
        ) return false;

        PayoutChunk memory chunk = _readPayoutChunk(payoutId, chunkIndex);
        if (!chunk.committed) return false;

        return CanonicalMerkleSum.verify(
            CanonicalMerkleSum.Domain({
                chainId: block.chainid,
                hook: address(this),
                cycleId: payout.cycleId,
                payoutId: payout.payoutId,
                manifestDigest: payout.manifestDigest
            }),
            index,
            recipient,
            amount,
            siblingHashes,
            siblingSums,
            chunk.rootHash,
            chunk.rootSum
        );
    }
}
