import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertHolderSnapshot,
  buildEligibilityHolderSet,
  buildHolderSnapshot,
} from '../../src/distribution/snapshot-indexer.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function address(index) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

test('retains a holder set larger than 1024 and records the zero-address exclusion', () => {
  const transferLogs = Array.from({ length: 1025 }, (_, index) => ({
    blockNumber: '1',
    logIndex: String(index),
    from: ZERO_ADDRESS,
    to: address(index),
    value: '1',
  }));
  const holderSet = buildEligibilityHolderSet({
    chainId: '4663',
    tokenAddress: TOKEN,
    tokenDecimals: 18,
    snapshotBlock: '8',
    snapshotHash: `0x${'1'.repeat(64)}`,
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1025' },
    exclusions: [{ address: ZERO_ADDRESS, reason: 'zero-address' }],
    transferLogs,
  });

  assert.equal(holderSet.entries.length, 1025);
  assert.equal(holderSet.entries.at(-1).recipient, address(1024));
  assert.equal(holderSet.exclusions[0].address, ZERO_ADDRESS);
  assert.match(holderSet.transferLogDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(holderSet.holderSnapshotDigest, /^sha256:[0-9a-f]{64}$/);

  const snapshot = buildHolderSnapshot({
    chainId: '4663',
    tokenAddress: TOKEN,
    blockNumber: '8',
    blockHash: `0x${'1'.repeat(64)}`,
    finalized: true,
    totalSupply: '1025',
    excludedAddresses: [{ address: ZERO_ADDRESS, reason: 'zero-address' }],
    transferLogs,
  });
  assert.deepEqual(assertHolderSnapshot(snapshot), snapshot);
});
