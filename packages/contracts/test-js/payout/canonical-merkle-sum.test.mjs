import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEPTH,
  TAGS,
  UINT256_MAX,
  WIDTH,
  buildDistribution,
  manifestBytes,
  orderedProofsDigest,
  parentNode,
  verifyProof,
} from '../../tooling/payout/canonical-merkle-sum.mjs';

const vectorUrl = new URL('../../test-vectors/payout/canonical-merkle-sum-v1.json', import.meta.url);
const vector = JSON.parse(readFileSync(vectorUrl, 'utf8'));
const EXPECTED_PROOFS_DIGEST =
  '0xcd7ef3c72e4ecb1503bc321ef4d0bee5c39a80ab5d33eaa8520e8b78a73647ae';

function asInput(source = vector) {
  return {
    domain: source.domain,
    snapshotNumber: BigInt(source.snapshot.number),
    snapshotHash: source.snapshot.hash,
    entries: source.entries.map((entry) => ({
      index: entry.index,
      recipient: entry.recipient,
      amount: BigInt(entry.amount),
      directBalance: BigInt(entry.directBalance),
    })),
  };
}

test('reproduces the canonical vector and verifies every tree position', () => {
  const built = buildDistribution(asInput());

  assert.equal(DEPTH, 10);
  assert.equal(WIDTH, 1_024);
  assert.deepEqual(TAGS, {
    manifest: '0xe233262d6b4897b325c0dbd557cbf2f2cb7fc50bd733773363c7081ef0531690',
    nonemptyLeaf: '0xd37de1da5c23bd627715b91a7599c49a9ce84bd89a6a12296a68da81d999954c',
    emptyLeaf: '0xeb9ee6d019ec108540d8da56b7766b816d5f025aaf6309d1917298b559b198d4',
    node: '0x2d812371b1e4d5cd1ba18b7691b42f7a51afff661d6f18bed93cd006b5281ede',
  });
  assert.deepEqual(TAGS, vector.tags);
  assert.equal(built.manifestBytes, vector.manifest.bytes);
  assert.equal(built.manifestDigest, vector.manifest.digest);
  assert.deepEqual(built.root, vector.root);
  assert.equal(vector.proofsDigest, EXPECTED_PROOFS_DIGEST);
  assert.equal(orderedProofsDigest(built.proofs), EXPECTED_PROOFS_DIGEST);
  assert.equal(built.proofs.length, WIDTH);

  for (let index = 0; index < WIDTH; index += 1) {
    assert.deepEqual(built.proofs[index], vector.proofs[index]);
    assert.equal(verifyProof(built.leaves[index], index, built.proofs[index], built.root), true);
  }
});

test('rejects noncanonical manifests', () => {
  const input = asInput();

  assert.throws(
    () => manifestBytes({ ...input, entries: [input.entries[1], input.entries[0]] }),
    /strictly increasing/,
  );
  assert.throws(
    () => manifestBytes({ ...input, entries: [input.entries[0], input.entries[0]] }),
    /strictly increasing/,
  );
  assert.throws(
    () => manifestBytes({ ...input, entries: [{ ...input.entries[0], index: WIDTH }] }),
    /index/,
  );
  assert.throws(
    () => manifestBytes({ ...input, entries: [{ ...input.entries[0], amount: 0n }] }),
    /amount/,
  );
  assert.throws(
    () => manifestBytes({ ...input, entries: [{ ...input.entries[0], directBalance: 0n }] }),
    /direct balance/,
  );
  assert.throws(
    () =>
      manifestBytes({
        ...input,
        entries: [{ ...input.entries[0], recipient: '0x0000000000000000000000000000000000000000' }],
      }),
    /recipient/,
  );
  assert.throws(
    () =>
      manifestBytes({
        ...input,
        entries: [{ ...input.entries[0], recipient: input.domain.hook }],
      }),
    /recipient/,
  );
});

test('domain, path, sibling, and proof-shape mutations do not verify', () => {
  const built = buildDistribution(asInput());
  const entry = vector.entries[2];
  const index = entry.index;
  const leaf = built.leaves[index];
  const proof = structuredClone(built.proofs[index]);

  const changedHash = `0x${'ff'.repeat(32)}`;
  proof.siblingHashes[0] = changedHash;
  assert.equal(verifyProof(leaf, index, proof, built.root), false);

  const changedSum = structuredClone(built.proofs[index]);
  changedSum.siblingSums[0] = (BigInt(changedSum.siblingSums[0]) + 1n).toString();
  assert.equal(verifyProof(leaf, index, changedSum, built.root), false);

  assert.equal(verifyProof(leaf, index ^ 1, built.proofs[index], built.root), false);
  assert.throws(
    () => verifyProof(leaf, index, { siblingHashes: [], siblingSums: [] }, built.root),
    /depth 10/,
  );

  const changedDomain = asInput();
  changedDomain.domain = { ...changedDomain.domain, payoutId: changedHash };
  const rebuilt = buildDistribution(changedDomain);
  assert.notEqual(rebuilt.root.hash, built.root.hash);
});

test('checked node sums reject uint256 overflow', () => {
  assert.throws(
    () =>
      parentNode(
        0,
        { hash: `0x${'11'.repeat(32)}`, sum: UINT256_MAX.toString() },
        { hash: `0x${'22'.repeat(32)}`, sum: '1' },
      ),
    /overflow/,
  );
});
