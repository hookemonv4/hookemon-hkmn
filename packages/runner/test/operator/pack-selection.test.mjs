import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPackSnapshot,
  selectPack,
} from '../../src/operator/pack-selection.mjs';

const sourcePayloadDigest = `sha256:${'1'.repeat(64)}`;

function snapshotInput(overrides = {}) {
  return {
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest,
    packs: [{ code: 'collector-crypt' }, { code: 'collector-ember' }],
    ...overrides,
  };
}

test('content-addresses one exact sorted pack snapshot and selects one named pack', () => {
  const first = createPackSnapshot(snapshotInput());
  const second = createPackSnapshot(snapshotInput());

  assert.match(first.snapshotDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  assert.deepEqual(selectPack(first, 'collector-ember'), {
    snapshotDigest: first.snapshotDigest,
    pack: 'collector-ember',
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.packs), true);
  assert.equal(first.packs.every(Object.isFrozen), true);
});

test('rejects a missing pack and any retained digest over changed snapshot bytes', () => {
  const snapshot = createPackSnapshot(snapshotInput());
  assert.throws(() => selectPack(snapshot, 'missing-pack'), /snapshot/i);

  const tampered = {
    ...snapshot,
    packs: [{ code: 'collector-crypt' }, { code: 'collector-spark' }],
  };
  assert.throws(() => selectPack(tampered, 'collector-spark'), /digest/i);
});

test('rejects duplicate, unsorted, malformed, and open pack snapshot input', () => {
  const cases = [
    snapshotInput({ packs: [{ code: 'collector-crypt' }, { code: 'collector-crypt' }] }),
    snapshotInput({ packs: [{ code: 'collector-ember' }, { code: 'collector-crypt' }] }),
    snapshotInput({ packs: [{ code: 'Collector Crypt' }] }),
    snapshotInput({ packs: [{ code: 'collector-crypt', price: '10' }] }),
    snapshotInput({ source: 'another-provider' }),
    snapshotInput({ observedAt: '2029-01-01' }),
    snapshotInput({ sourcePayloadDigest: `sha256:${'A'.repeat(64)}` }),
    { ...snapshotInput(), refreshAfter: '2030-01-01T00:00:00.000Z' },
  ];

  for (const value of cases) {
    assert.throws(() => createPackSnapshot(value), /snapshot|pack|source|observed|digest|schema/i);
  }
});

test('accepts lowercase pack codes containing underscores and rejects spaced names', () => {
  const snapshot = createPackSnapshot(snapshotInput({ packs: [{ code: 'pokemon_50' }] }));
  assert.deepEqual(selectPack(snapshot, 'pokemon_50').pack, 'pokemon_50');
  assert.throws(() => selectPack(snapshot, 'Pokemon 50'), /invalid/);
});

test('rejects accessors and decorated or sparse pack arrays before hashing', () => {
  const accessor = snapshotInput();
  Object.defineProperty(accessor, 'source', { enumerable: true, get: () => 'collector' });
  assert.throws(() => createPackSnapshot(accessor), /canonical|plain|property/i);

  const decorated = [{ code: 'collector-crypt' }];
  decorated.note = 'not-canonical';
  assert.throws(() => createPackSnapshot(snapshotInput({ packs: decorated })), /canonical|array/i);

  const sparse = Array(2);
  sparse[1] = { code: 'collector-crypt' };
  assert.throws(() => createPackSnapshot(snapshotInput({ packs: sparse })), /canonical|array/i);
});
