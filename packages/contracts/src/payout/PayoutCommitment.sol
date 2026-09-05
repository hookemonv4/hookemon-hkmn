// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ProcessBudget, IPegCycleVaultIdentity } from "../process/ProcessBudget.sol";
import { IPegCycleVault } from "../process/IPegCycleVault.sol";

/// @notice Atomically commits exact returned cycle proceeds as one immutable sum-bound payout.
/// @dev Manifest publication and independent proof verification remain offchain preflight duties.
///
/// Chunking: a funded payout's liability may be represented by one or more independent depth-10
/// Merkle-sum "chunks", each committed separately via `commitPayoutChunk`. No chunk is claimable
/// until the exact sum of every committed chunk's `rootSum` equals the payout's funded `rootSum`
/// (`payoutLiability[payoutId]` at funding time); the manifest then closes permanently and the
/// commitment set becomes immutable, matching the single atomic-commit invariant this contract has
/// always upheld for the unchunked payout. Chunk indices remain open (not auto-closed) until that
/// exact-sum condition holds, so a partial or abandoned commitment set can always be corrected by
/// recommitting any not-yet-closed index -- it can never leave holders permanently unpayable.
/// Chunk commitment is restricted to `pegCycleVault.authorizer()` -- the same single privileged
/// identity whose dual-builder/dual-publication/owner-approved (TB-16) off-chain process already
/// unilaterally determines `payout.rootHash`/`payout.rootSum` before it ever calls
/// `PegCycleVault.authorizePayout`. Nothing here independently re-verifies a chunk's root against
/// real holder data (see `HolderSettlement` for that at claim time), so this call must never be
/// opened to a lower-trust caller such as the payout's `operationsTrigger`: doing so would let that
/// materially lower-privilege automation key alone redirect an entire funded payout to a root of its
/// own choosing, with no dual signature and no correction window once the manifest closes. Binding
/// the caller to the vault's own authorizer keeps chunk-root authority at exactly the trust tier the
/// rest of the payout-authorization flow already requires -- no new privileged actor is introduced.
/// Today's default operational mode commits exactly one chunk (index 0) whose root mirrors the
/// funding authorization's root -- unchanged behavior from the pre-chunking contract -- while
/// `MAX_CHUNKS_PER_PAYOUT` bounds the mechanism for later multi-chunk activation without an
/// unbounded on-chain loop.
abstract contract PayoutCommitment is ProcessBudget {
    /// @dev Declared ceiling on independent chunks per payout; each commit is O(1), so this bounds
    ///      the mechanism's surface area rather than any single call's gas.
    uint16 internal constant MAX_CHUNKS_PER_PAYOUT = 64;

    struct PayoutRecord {
        bytes32 cycleId;
        address operationsTrigger;
        bytes32 payoutId;
        bytes32 manifestDigest;
        bytes32 rootHash;
        uint256 rootSum;
        uint256 paidTotal;
        uint256 unpaidTotal;
        bool funded;
    }

    struct PayoutChunk {
        bytes32 rootHash;
        uint256 rootSum;
        bool committed;
    }

    mapping(bytes32 payoutId => PayoutRecord payout) private payouts;
    mapping(bytes32 payoutId => mapping(uint16 chunkIndex => PayoutChunk chunk)) private
        payoutChunks;
    mapping(bytes32 payoutId => uint256 committedSum) private committedChunkSum;
    /// @dev Counts distinct chunk indices ever committed for the payout, not the count currently
    ///      committed -- a recommit of an already-committed index does not increment it.
    mapping(bytes32 payoutId => uint16 count) private committedChunkCount;
    mapping(bytes32 payoutId => bool closed) private manifestClosed;

    error PayoutAlreadyFunded();
    error PayoutBalanceDeltaMismatch();
    error InsufficientPayoutLiability();
    error PayoutNotFunded();
    error PayoutManifestAlreadyClosed();
    error PayoutChunkIndexOutOfRange();
    error PayoutChunkSumExceedsLiability();
    error UnauthorizedChunkCommitter();

    event PayoutFunded(
        bytes32 indexed payoutId,
        bytes32 indexed cycleId,
        address indexed operationsTrigger,
        bytes32 manifestDigest,
        bytes32 rootHash,
        uint256 rootSum
    );
    event PayoutChunkCommitted(
        bytes32 indexed payoutId, uint16 indexed chunkIndex, bytes32 rootHash, uint256 rootSum
    );
    event PayoutManifestClosed(bytes32 indexed payoutId, uint16 chunkCount, uint256 totalRootSum);

    constructor(
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault pegCycleVault
    ) ProcessBudget(programmable, treasury, operations, pegCycleVault) { }

    function fundPayoutFromPegCycle(IPegCycleVault.PayoutAuthorization calldata authorization)
        external
        moneyPath
        returns (PayoutRecord memory record)
    {
        if (payouts[authorization.payoutId].funded) revert PayoutAlreadyFunded();
        uint256 hookBalanceBefore = _hookUsdgBalance();
        address operationsTrigger = pegCycleVault.consumePayoutAuthorization(authorization);
        uint256 hookBalanceAfter = _hookUsdgBalance();
        if (
            hookBalanceAfter < hookBalanceBefore
                || hookBalanceAfter - hookBalanceBefore != authorization.rootSum
        ) revert PayoutBalanceDeltaMismatch();

        record = PayoutRecord({
            cycleId: authorization.cycleId,
            operationsTrigger: operationsTrigger,
            payoutId: authorization.payoutId,
            manifestDigest: authorization.manifestDigest,
            rootHash: authorization.rootHash,
            rootSum: authorization.rootSum,
            paidTotal: 0,
            unpaidTotal: authorization.rootSum,
            funded: true
        });
        payouts[authorization.payoutId] = record;
        _creditPayoutLiability(authorization.payoutId, authorization.rootSum);
        _requireSolvent();
        emit PayoutFunded(
            authorization.payoutId,
            authorization.cycleId,
            operationsTrigger,
            authorization.manifestDigest,
            authorization.rootHash,
            authorization.rootSum
        );
    }

    /// @notice Commits (or, before the manifest closes, recommits) one independent chunk of the
    ///         payout's Merkle-sum manifest. Closes the manifest automatically, permanently, once
    ///         every committed chunk's `rootSum` sums to exactly the payout's funded `rootSum`.
    function commitPayoutChunk(
        bytes32 payoutId,
        uint16 chunkIndex,
        bytes32 rootHash,
        uint256 rootSum
    ) external {
        PayoutRecord storage payout = payouts[payoutId];
        if (!payout.funded) revert PayoutNotFunded();
        if (msg.sender != IPegCycleVaultIdentity(address(pegCycleVault)).authorizer()) {
            revert UnauthorizedChunkCommitter();
        }
        if (manifestClosed[payoutId]) revert PayoutManifestAlreadyClosed();
        if (chunkIndex >= MAX_CHUNKS_PER_PAYOUT) revert PayoutChunkIndexOutOfRange();

        PayoutChunk storage chunk = payoutChunks[payoutId][chunkIndex];
        uint256 runningSum = committedChunkSum[payoutId];
        if (chunk.committed) {
            runningSum -= chunk.rootSum;
        } else {
            committedChunkCount[payoutId] += 1;
        }
        if (rootSum > payout.rootSum || runningSum > payout.rootSum - rootSum) {
            revert PayoutChunkSumExceedsLiability();
        }
        runningSum += rootSum;

        chunk.rootHash = rootHash;
        chunk.rootSum = rootSum;
        chunk.committed = true;
        committedChunkSum[payoutId] = runningSum;
        emit PayoutChunkCommitted(payoutId, chunkIndex, rootHash, rootSum);

        if (runningSum == payout.rootSum) {
            manifestClosed[payoutId] = true;
            emit PayoutManifestClosed(payoutId, committedChunkCount[payoutId], runningSum);
        }
    }

    function readPayout(bytes32 payoutId) external view returns (PayoutRecord memory) {
        return payouts[payoutId];
    }

    function readPayoutConservation(bytes32 payoutId)
        external
        view
        returns (uint256 funded, uint256 paid, uint256 unpaid)
    {
        PayoutRecord storage payout = payouts[payoutId];
        return (payout.rootSum, payout.paidTotal, payout.unpaidTotal);
    }

    function readPayoutChunk(bytes32 payoutId, uint16 chunkIndex)
        external
        view
        returns (PayoutChunk memory)
    {
        return payoutChunks[payoutId][chunkIndex];
    }

    function isManifestClosed(bytes32 payoutId) external view returns (bool) {
        return manifestClosed[payoutId];
    }

    function _readPayout(bytes32 payoutId) internal view returns (PayoutRecord memory) {
        return payouts[payoutId];
    }

    function _readPayoutChunk(bytes32 payoutId, uint16 chunkIndex)
        internal
        view
        returns (PayoutChunk memory)
    {
        return payoutChunks[payoutId][chunkIndex];
    }

    function _isManifestClosed(bytes32 payoutId) internal view returns (bool) {
        return manifestClosed[payoutId];
    }

    function _consumePayoutEntitlement(bytes32 payoutId, uint256 amount) internal {
        PayoutRecord storage payout = payouts[payoutId];
        if (!payout.funded || amount == 0 || amount > payout.unpaidTotal) {
            revert InsufficientPayoutLiability();
        }
        payout.unpaidTotal -= amount;
        payout.paidTotal += amount;
        _debitPayoutLiability(payoutId, amount);
    }
}
