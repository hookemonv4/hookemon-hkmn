// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library CanonicalMerkleSum {
    uint8 internal constant TREE_DEPTH = 10;
    uint16 internal constant TREE_WIDTH = 1024;
    uint8 internal constant SCHEMA_VERSION = 1;

    bytes32 internal constant MANIFEST_TAG = keccak256("HOOKEMON_PAYOUT_MANIFEST_R55_A4_V1");
    bytes32 internal constant NONEMPTY_LEAF_TAG =
        keccak256("HOOKEMON_PAYOUT_NONEMPTY_LEAF_R55_A4_V1");
    bytes32 internal constant EMPTY_LEAF_TAG = keccak256("HOOKEMON_PAYOUT_EMPTY_LEAF_R55_A4_V1");
    bytes32 internal constant NODE_TAG = keccak256("HOOKEMON_PAYOUT_NODE_R55_A4_V1");

    error InvalidIndex();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidDirectBalance();
    error EntriesNotStrictlyIncreasing();
    error SumOverflow();

    struct Domain {
        uint256 chainId;
        address hook;
        bytes32 cycleId;
        bytes32 payoutId;
        bytes32 manifestDigest;
    }

    struct ManifestEntry {
        uint16 index;
        address recipient;
        uint256 amount;
        uint256 directBalance;
    }

    struct Node {
        bytes32 hash;
        uint256 sum;
    }

    function manifestBytes(
        uint256 chainId,
        address hook,
        bytes32 cycleId,
        bytes32 payoutId,
        uint256 snapshotNumber,
        bytes32 snapshotHash,
        ManifestEntry[] memory entries
    ) internal pure returns (bytes memory) {
        _validateEntries(entries, hook);
        return abi.encode(
            MANIFEST_TAG,
            SCHEMA_VERSION,
            chainId,
            hook,
            cycleId,
            payoutId,
            snapshotNumber,
            snapshotHash,
            entries
        );
    }

    function nonemptyLeaf(Domain memory domain, uint16 index, address recipient, uint256 amount)
        internal
        pure
        returns (Node memory)
    {
        if (index >= TREE_WIDTH) revert InvalidIndex();
        if (recipient == address(0) || recipient == domain.hook) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();

        return Node({
            hash: keccak256(
                abi.encode(
                    NONEMPTY_LEAF_TAG,
                    domain.chainId,
                    domain.hook,
                    domain.cycleId,
                    domain.payoutId,
                    domain.manifestDigest,
                    index,
                    recipient,
                    amount
                )
            ),
            sum: amount
        });
    }

    function emptyLeaf(Domain memory domain, uint16 index) internal pure returns (Node memory) {
        if (index >= TREE_WIDTH) revert InvalidIndex();

        return Node({
            hash: keccak256(
                abi.encode(
                    EMPTY_LEAF_TAG,
                    domain.chainId,
                    domain.hook,
                    domain.cycleId,
                    domain.payoutId,
                    domain.manifestDigest,
                    index
                )
            ),
            sum: 0
        });
    }

    function parentNode(uint8 level, Node memory left, Node memory right)
        internal
        pure
        returns (Node memory)
    {
        if (right.sum > type(uint256).max - left.sum) revert SumOverflow();
        uint256 sum = left.sum + right.sum;
        return Node({
            hash: keccak256(
                abi.encode(NODE_TAG, level, left.hash, left.sum, right.hash, right.sum)
            ),
            sum: sum
        });
    }

    function rootFromProof(
        Node memory leaf,
        uint16 index,
        bytes32[10] memory siblingHashes,
        uint256[10] memory siblingSums
    ) internal pure returns (Node memory node) {
        if (index >= TREE_WIDTH) revert InvalidIndex();
        node = leaf;
        for (uint8 level; level < TREE_DEPTH; ++level) {
            Node memory sibling = Node({ hash: siblingHashes[level], sum: siblingSums[level] });
            node = ((index >> level) & 1) == 0
                ? parentNode(level, node, sibling)
                : parentNode(level, sibling, node);
        }
    }

    function verify(
        Domain memory domain,
        uint16 index,
        address recipient,
        uint256 amount,
        bytes32[10] calldata siblingHashes,
        uint256[10] calldata siblingSums,
        bytes32 expectedRootHash,
        uint256 expectedRootSum
    ) internal pure returns (bool) {
        Node memory node = nonemptyLeaf(domain, index, recipient, amount);
        for (uint8 level; level < TREE_DEPTH; ++level) {
            Node memory sibling = Node({ hash: siblingHashes[level], sum: siblingSums[level] });
            node = ((index >> level) & 1) == 0
                ? parentNode(level, node, sibling)
                : parentNode(level, sibling, node);
        }
        return node.hash == expectedRootHash && node.sum == expectedRootSum;
    }

    function _validateEntries(ManifestEntry[] memory entries, address hook) private pure {
        for (uint256 cursor; cursor < entries.length; ++cursor) {
            ManifestEntry memory entry = entries[cursor];
            if (entry.index >= TREE_WIDTH) revert InvalidIndex();
            if (entry.recipient == address(0) || entry.recipient == hook) {
                revert InvalidRecipient();
            }
            if (entry.amount == 0) revert InvalidAmount();
            if (entry.directBalance == 0) revert InvalidDirectBalance();
            if (cursor != 0 && entries[cursor - 1].index >= entry.index) {
                revert EntriesNotStrictlyIncreasing();
            }
        }
    }
}
