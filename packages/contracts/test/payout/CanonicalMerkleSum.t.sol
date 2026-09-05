// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { CanonicalMerkleSum } from "../../src/payout/CanonicalMerkleSum.sol";

contract CanonicalMerkleSumTest {
    uint16 private constant WIDTH = 1024;
    uint8 private constant DEPTH = 10;
    bytes32 private constant EXPECTED_MANIFEST_DIGEST =
        0x4550f1964b800f4f1ecd2f911d505716e9612584c9fc141c68ea25c37802c135;
    bytes32 private constant EXPECTED_ROOT_HASH =
        0x5d8190ebdd464920299e6f975e600a3a0fb0dbbed61ad4086b0f36acef8fdcea;
    uint256 private constant EXPECTED_ROOT_SUM = 1500;
    bytes32 private constant EXPECTED_PROOFS_DIGEST =
        0xcd7ef3c72e4ecb1503bc321ef4d0bee5c39a80ab5d33eaa8520e8b78a73647ae;

    function testReproducesManifestAndAllProofsIndependently() external pure {
        CanonicalMerkleSum.Domain memory domain = _domain();
        CanonicalMerkleSum.ManifestEntry[] memory entries = _entries();
        bytes memory expectedManifest = abi.encode(
            keccak256("HOOKEMON_PAYOUT_MANIFEST_R55_A4_V1"),
            uint8(1),
            domain.chainId,
            domain.hook,
            domain.cycleId,
            domain.payoutId,
            uint256(12_345_678),
            bytes32(uint256(0xabcdef)),
            entries
        );

        bytes memory actualManifest = CanonicalMerkleSum.manifestBytes(
            domain.chainId,
            domain.hook,
            domain.cycleId,
            domain.payoutId,
            12_345_678,
            bytes32(uint256(0xabcdef)),
            entries
        );
        require(keccak256(actualManifest) == keccak256(expectedManifest), "manifest bytes");
        domain.manifestDigest = keccak256(actualManifest);
        require(domain.manifestDigest == EXPECTED_MANIFEST_DIGEST, "manifest anchor");

        CanonicalMerkleSum.Node[] memory actualTree = _actualTree(domain, entries);
        CanonicalMerkleSum.Node[] memory expectedTree = _expectedTree(domain, entries);
        require(actualTree[1].hash == expectedTree[1].hash, "root hash");
        require(actualTree[1].sum == expectedTree[1].sum, "root sum");
        require(actualTree[1].hash == EXPECTED_ROOT_HASH, "root hash anchor");
        require(actualTree[1].sum == EXPECTED_ROOT_SUM, "root sum anchor");

        bytes32 proofsDigest;
        for (uint16 index; index < WIDTH; ++index) {
            (bytes32[10] memory hashes, uint256[10] memory sums) = _proof(actualTree, index);
            CanonicalMerkleSum.Node memory root =
                CanonicalMerkleSum.rootFromProof(actualTree[WIDTH + index], index, hashes, sums);
            require(root.hash == actualTree[1].hash, "proof hash");
            require(root.sum == actualTree[1].sum, "proof sum");
            proofsDigest = keccak256(abi.encode(proofsDigest, index, hashes, sums));
        }
        require(proofsDigest == EXPECTED_PROOFS_DIGEST, "proofs anchor");
    }

    function testRejectsNoncanonicalManifestEntries() external {
        CanonicalMerkleSum.ManifestEntry[] memory entries = _entries();
        entries[1].index = entries[0].index;

        (bool ok,) = address(this).call(abi.encodeCall(this.manifestBytesExternal, (entries)));
        require(!ok, "duplicate accepted");

        entries = _entries();
        entries[0].recipient = address(0);
        (ok,) = address(this).call(abi.encodeCall(this.manifestBytesExternal, (entries)));
        require(!ok, "zero recipient accepted");

        entries = _entries();
        entries[0].recipient = _domain().hook;
        (ok,) = address(this).call(abi.encodeCall(this.manifestBytesExternal, (entries)));
        require(!ok, "hook recipient accepted");
    }

    function testRejectsNodeSumOverflow() external {
        CanonicalMerkleSum.Node memory left =
            CanonicalMerkleSum.Node({ hash: bytes32(uint256(1)), sum: type(uint256).max });
        CanonicalMerkleSum.Node memory right =
            CanonicalMerkleSum.Node({ hash: bytes32(uint256(2)), sum: 1 });

        (bool ok,) = address(this).call(abi.encodeCall(this.parentExternal, (left, right)));
        require(!ok, "overflow accepted");
    }

    function manifestBytesExternal(CanonicalMerkleSum.ManifestEntry[] memory entries)
        external
        pure
        returns (bytes memory)
    {
        CanonicalMerkleSum.Domain memory domain = _domain();
        return CanonicalMerkleSum.manifestBytes(
            domain.chainId,
            domain.hook,
            domain.cycleId,
            domain.payoutId,
            12_345_678,
            bytes32(uint256(0xabcdef)),
            entries
        );
    }

    function parentExternal(
        CanonicalMerkleSum.Node memory left,
        CanonicalMerkleSum.Node memory right
    ) external pure returns (CanonicalMerkleSum.Node memory) {
        return CanonicalMerkleSum.parentNode(0, left, right);
    }

    function _actualTree(
        CanonicalMerkleSum.Domain memory domain,
        CanonicalMerkleSum.ManifestEntry[] memory entries
    ) private pure returns (CanonicalMerkleSum.Node[] memory tree) {
        tree = new CanonicalMerkleSum.Node[](WIDTH * 2);
        uint256 entryCursor;
        for (uint16 index; index < WIDTH; ++index) {
            if (entryCursor < entries.length && entries[entryCursor].index == index) {
                CanonicalMerkleSum.ManifestEntry memory entry = entries[entryCursor++];
                tree[WIDTH + index] =
                    CanonicalMerkleSum.nonemptyLeaf(domain, index, entry.recipient, entry.amount);
            } else {
                tree[WIDTH + index] = CanonicalMerkleSum.emptyLeaf(domain, index);
            }
        }
        _fillParents(tree, false);
    }

    function _expectedTree(
        CanonicalMerkleSum.Domain memory domain,
        CanonicalMerkleSum.ManifestEntry[] memory entries
    ) private pure returns (CanonicalMerkleSum.Node[] memory tree) {
        tree = new CanonicalMerkleSum.Node[](WIDTH * 2);
        uint256 entryCursor;
        for (uint16 index; index < WIDTH; ++index) {
            if (entryCursor < entries.length && entries[entryCursor].index == index) {
                CanonicalMerkleSum.ManifestEntry memory entry = entries[entryCursor++];
                tree[WIDTH + index] = CanonicalMerkleSum.Node({
                    hash: keccak256(
                        abi.encode(
                            keccak256("HOOKEMON_PAYOUT_NONEMPTY_LEAF_R55_A4_V1"),
                            domain.chainId,
                            domain.hook,
                            domain.cycleId,
                            domain.payoutId,
                            domain.manifestDigest,
                            index,
                            entry.recipient,
                            entry.amount
                        )
                    ),
                    sum: entry.amount
                });
            } else {
                tree[WIDTH + index] = CanonicalMerkleSum.Node({
                    hash: keccak256(
                        abi.encode(
                            keccak256("HOOKEMON_PAYOUT_EMPTY_LEAF_R55_A4_V1"),
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
        }
        _fillParents(tree, true);
    }

    function _fillParents(CanonicalMerkleSum.Node[] memory tree, bool useReference) private pure {
        uint256 width = WIDTH;
        for (uint8 level; level < DEPTH; ++level) {
            uint256 parentStart = width >> 1;
            for (uint256 offset; offset < parentStart; ++offset) {
                uint256 parentIndex = parentStart + offset;
                CanonicalMerkleSum.Node memory left = tree[parentIndex * 2];
                CanonicalMerkleSum.Node memory right = tree[parentIndex * 2 + 1];
                tree[parentIndex] = useReference
                    ? CanonicalMerkleSum.Node({
                        hash: keccak256(
                            abi.encode(
                                keccak256("HOOKEMON_PAYOUT_NODE_R55_A4_V1"),
                                level,
                                left.hash,
                                left.sum,
                                right.hash,
                                right.sum
                            )
                        ),
                        sum: left.sum + right.sum
                    })
                    : CanonicalMerkleSum.parentNode(level, left, right);
            }
            width = parentStart;
        }
    }

    function _proof(CanonicalMerkleSum.Node[] memory tree, uint16 index)
        private
        pure
        returns (bytes32[10] memory hashes, uint256[10] memory sums)
    {
        uint256 cursor = WIDTH + index;
        for (uint8 level; level < DEPTH; ++level) {
            CanonicalMerkleSum.Node memory sibling = tree[cursor ^ 1];
            hashes[level] = sibling.hash;
            sums[level] = sibling.sum;
            cursor >>= 1;
        }
    }

    function _domain() private pure returns (CanonicalMerkleSum.Domain memory) {
        return CanonicalMerkleSum.Domain({
            chainId: 466,
            hook: 0x1111111111111111111111111111111111111111,
            cycleId: bytes32(uint256(0xc1c1e)),
            payoutId: bytes32(uint256(0xa110c)),
            manifestDigest: bytes32(0)
        });
    }

    function _entries() private pure returns (CanonicalMerkleSum.ManifestEntry[] memory entries) {
        entries = new CanonicalMerkleSum.ManifestEntry[](5);
        entries[0] = CanonicalMerkleSum.ManifestEntry({
            index: 0,
            recipient: 0x0000000000000000000000000000000000001001,
            amount: 100,
            directBalance: 5
        });
        entries[1] = CanonicalMerkleSum.ManifestEntry({
            index: 1,
            recipient: 0x0000000000000000000000000000000000001002,
            amount: 200,
            directBalance: 10
        });
        entries[2] = CanonicalMerkleSum.ManifestEntry({
            index: 17,
            recipient: 0x0000000000000000000000000000000000001012,
            amount: 300,
            directBalance: 15
        });
        entries[3] = CanonicalMerkleSum.ManifestEntry({
            index: 511,
            recipient: 0x0000000000000000000000000000000000001511,
            amount: 400,
            directBalance: 20
        });
        entries[4] = CanonicalMerkleSum.ManifestEntry({
            index: 1023,
            recipient: 0x0000000000000000000000000000000000002023,
            amount: 500,
            directBalance: 25
        });
    }
}
