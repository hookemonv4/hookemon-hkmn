import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'proof-domain.json');

const requiredManifestFields = [
  'manifestTag',
  'schemaVersion',
  'chainId',
  'hook',
  'cycleId',
  'payoutId',
  'snapshotNumber',
  'snapshotHash',
  'entries',
];

const requiredEntryFields = ['index:uint16', 'recipient:address', 'amount:uint256', 'directHkmnBalance:uint256'];
const requiredLeafFields = [
  'leafTag',
  'chainId',
  'hook',
  'cycleId',
  'payoutId',
  'manifestDigest',
  'index:uint16',
  'recipient:address',
  'amount:uint256',
];
const requiredEmptyLeafFields = [
  'emptyLeafTag',
  'chainId',
  'hook',
  'cycleId',
  'payoutId',
  'manifestDigest',
  'index:uint16',
];

const requiredMutations = new Set([
  'manifest-tag',
  'schema-version',
  'manifest-encoding',
  'chain-id',
  'hook',
  'cycle-id',
  'payout-id',
  'snapshot-number',
  'snapshot-hash',
  'entry-order',
  'duplicate-index',
  'out-of-range-index',
  'zero-recipient',
  'zero-amount',
  'zero-direct-hkmn-balance',
  'manifest-digest',
  'leaf-tag',
  'empty-leaf-tag',
  'empty-leaf-chain-id',
  'empty-leaf-hook',
  'empty-leaf-cycle-id',
  'empty-leaf-payout-id',
  'empty-leaf-manifest-digest',
  'empty-leaf-index',
  'node-tag',
  'index-bit',
  'sibling-order',
  'sibling-hash',
  'sibling-sum',
  'node-level',
  'recipient',
  'amount',
  'tree-depth',
  'padding-rule',
  'child-sum-overflow',
  'root-sum-funding-mismatch',
]);

function readFixture() {
  assert.equal(existsSync(fixturePath), true, 'blind proof-domain fixture is missing');
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

test('blind proof-domain fixture freezes semantics while tag bytes remain deferred', () => {
  const fixture = readFixture();

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.requirementsRevision, 55);
  assert.equal(fixture.interfaceBinding, 'deferred-until-frozen');
  assert.equal(fixture.tags.manifest, 'deferred-until-frozen');
  assert.equal(fixture.tags.nonemptyLeaf, 'deferred-until-frozen');
  assert.equal(fixture.tags.emptyLeaf, 'deferred-until-frozen');
  assert.equal(fixture.tags.internalNode, 'deferred-until-frozen');

  assert.deepEqual(fixture.manifest.solidityAbiFields, requiredManifestFields);
  assert.deepEqual(fixture.manifest.entryFields, requiredEntryFields);
  assert.equal(fixture.manifest.entriesOrdering, 'strictly-ascending-unique-index');
  assert.equal(fixture.manifest.digest, 'keccak256(canonicalManifestBytes)');

  assert.deepEqual(fixture.nonemptyLeaf.solidityAbiFields, requiredLeafFields);
  assert.deepEqual(fixture.emptyLeaf.solidityAbiFields, requiredEmptyLeafFields);
  assert.equal(fixture.emptyLeaf.tagRule, 'distinct-from-nonempty-leaf-tag');
  assert.equal(fixture.emptyLeaf.sum, '0');
  assert.equal(fixture.emptyLeaf.domainIncludesIndex, true);
  assert.equal(fixture.internalNode.childOrder, 'ordered-left-right');
  assert.equal(fixture.internalNode.sumRule, 'checked-uint256-addition');
});

test('blind proof-domain fixture covers every position and required mutation', () => {
  const fixture = readFixture();

  assert.equal(fixture.tree.depth, 10);
  assert.equal(fixture.tree.positions, 1024);
  assert.equal(fixture.tree.firstIndex, 0);
  assert.equal(fixture.tree.lastIndex, 1023);
  assert.equal(fixture.tree.pathRule, 'bit-i-of-index-selects-left-or-right-at-level-i');
  assert.equal(fixture.tree.requiredValidProofCount, 1024);
  assert.equal(fixture.tree.siblingHashesPerProof, 10);
  assert.equal(fixture.tree.siblingSumsPerProof, 10);
  assert.equal(fixture.paidKey, 'payoutId+uint16-index');

  const mutationIds = fixture.mutations.map(({ id }) => id);
  assert.equal(new Set(mutationIds).size, mutationIds.length);
  for (const mutation of requiredMutations) {
    assert.equal(mutationIds.includes(mutation), true, `missing proof mutation: ${mutation}`);
  }
  for (const mutation of fixture.mutations) {
    assert.equal(mutation.expected.outcome, 'revert');
    assert.equal(mutation.expected.stateMutation, 'none');
  }

  const emptyLeafMutations = fixture.mutations.filter(({ id }) => id.startsWith('empty-leaf-'));
  assert.deepEqual(
    emptyLeafMutations.map(({ id }) => id),
    [
      'empty-leaf-tag',
      'empty-leaf-chain-id',
      'empty-leaf-hook',
      'empty-leaf-cycle-id',
      'empty-leaf-payout-id',
      'empty-leaf-manifest-digest',
      'empty-leaf-index',
    ],
  );
  assert.ok(emptyLeafMutations.every(({ scope }) => scope === 'empty-leaf-domain'));
});
