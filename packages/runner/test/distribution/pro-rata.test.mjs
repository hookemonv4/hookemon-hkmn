import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { deriveClosedProceedsBasis, deriveHolderDistributionCandidate } from '../../src/distribution/reconcile.mjs';
import {
  CHUNK_ENTRY_LIMIT,
  MAX_CHUNKS_PER_DISTRIBUTION,
  chunkProRataEntries,
  computeProRataDistribution,
  computeProRataDistributionFromSnapshot,
  toHolderCandidateInput,
} from '../../src/distribution/pro-rata.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

function address(index) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

function closedProceedsBasisFixture(cycleId) {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(cycleId, [], { cycleStore });
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  return deriveClosedProceedsBasis(runner.readClosedProceedsBasisHandoff({ proceedsKey }));
}

const holderSnapshotMetadata = {
  chainId: '1',
  tokenAddress: `0x${'a'.repeat(40)}`,
  blockNumber: '12345678',
  blockHash: `0x${'b'.repeat(64)}`,
};

test('floor-rounding is exact: sum(amount_i) + dust == proceeds', () => {
  const directBalances = [
    { recipient: address(2), directHkmnBalance: '200' },
    { recipient: address(0), directHkmnBalance: '100' },
    { recipient: address(1), directHkmnBalance: '333' },
  ];
  const distribution = computeProRataDistribution({ directBalances, proceedsAmount: '77' });

  assert.equal(distribution.schema, 'hookemon.pro-rata-distribution.v1');
  assert.equal(distribution.totalEligibleSupply, '633');
  assert.equal(distribution.distributablePool, '77');
  assert.equal(distribution.holderCount, 3);

  const sum = distribution.entries.reduce((total, entry) => total + BigInt(entry.amountAtomicUSDG), 0n);
  assert.equal(sum, BigInt(distribution.totalAmountAtomicUSDG));
  assert.equal(sum + BigInt(distribution.dust), BigInt(distribution.proceedsAmount));
  assert.equal(sum + BigInt(distribution.dust), BigInt(distribution.distributablePool));

  // address(0) = 100/633 * 77 = floor(7700/633) = 12; address(1) = 333/633*77 = floor(25641/633) = 40;
  // address(2) = 200/633*77 = floor(15400/633) = 24. sum = 76, dust = 1.
  assert.deepEqual(
    distribution.entries.map((entry) => [entry.recipient, entry.amountAtomicUSDG]),
    [[address(0), '12'], [address(1), '40'], [address(2), '24']],
  );
  assert.equal(distribution.dust, '1');
  // entries are address-sorted and densely, contiguously indexed regardless of input order.
  assert.deepEqual(distribution.entries.map((entry) => entry.index), [0, 1, 2]);
});

test('entries are address-sorted independent of input order', () => {
  const directBalances = [
    { recipient: address(5), directHkmnBalance: '10' },
    { recipient: address(1), directHkmnBalance: '10' },
    { recipient: address(3), directHkmnBalance: '10' },
  ];
  const forward = computeProRataDistribution({ directBalances, proceedsAmount: '30' });
  const reversed = computeProRataDistribution({ directBalances: [...directBalances].reverse(), proceedsAmount: '30' });

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.entries.map((entry) => entry.recipient), [address(1), address(3), address(5)]);
});

test('a holder whose floor share is zero is omitted from entries but still tracked', () => {
  const directBalances = [
    { recipient: address(0), directHkmnBalance: '999' },
    { recipient: address(1), directHkmnBalance: '1' },
  ];
  // supply = 1000, proceeds = 2: address(0) floors to floor(1998/1000) = 1; address(1) floors
  // to floor(2/1000) = 0 and is left out of entries even though its balance is nonzero.
  const distribution = computeProRataDistribution({ directBalances, proceedsAmount: '2' });

  assert.equal(distribution.holderCount, 2);
  assert.equal(distribution.payableHolderCount, 1);
  assert.equal(distribution.entries.length, 1);
  assert.equal(distribution.entries[0].recipient, address(0));
  assert.equal(distribution.totalAmountAtomicUSDG, '1');
  assert.equal(distribution.dust, '1');

  const noneEligible = computeProRataDistribution({
    directBalances: [{ recipient: address(0), directHkmnBalance: '1' }],
    proceedsAmount: '1',
    totalEligibleSupply: '1000000',
  });
  assert.equal(noneEligible.entries.length, 0);
  assert.equal(noneEligible.dust, '1');
});

test('an explicit totalEligibleSupply wider than the supplied balances is honoured', () => {
  const directBalances = [{ recipient: address(0), directHkmnBalance: '100' }];
  const distribution = computeProRataDistribution({
    directBalances,
    proceedsAmount: '1000',
    totalEligibleSupply: '1000',
  });
  assert.equal(distribution.totalEligibleSupply, '1000');
  assert.equal(distribution.entries[0].amountAtomicUSDG, '100');
  assert.equal(distribution.dust, '900');

  assert.throws(
    () => computeProRataDistribution({ directBalances, proceedsAmount: '1000', totalEligibleSupply: '99' }),
    /at least the sum/,
  );
});

test('dust carries forward across two simulated cycles without loss', () => {
  const directBalances = [
    { recipient: address(0), directHkmnBalance: '1' },
    { recipient: address(1), directHkmnBalance: '1' },
    { recipient: address(2), directHkmnBalance: '1' },
  ];
  // supply = 3, cycle 1 proceeds = 10: floor(10/3) = 3 each, sum = 9, dust = 1.
  const cycle1 = computeProRataDistribution({ directBalances, proceedsAmount: '10' });
  assert.equal(cycle1.totalAmountAtomicUSDG, '9');
  assert.equal(cycle1.dust, '1');

  // cycle 2 carries cycle 1's dust forward: pool = 10 + 1 = 11, floor(11/3) = 3 each, sum = 9, dust = 2.
  const cycle2 = computeProRataDistribution({ directBalances, proceedsAmount: '10', previousDust: cycle1.dust });
  assert.equal(cycle2.previousDust, '1');
  assert.equal(cycle2.distributablePool, '11');
  assert.equal(cycle2.totalAmountAtomicUSDG, '9');
  assert.equal(cycle2.dust, '2');

  // No value is lost across the two cycles: everything actually paid out plus what remains
  // as dust for a future cycle equals the two cycles' combined proceeds.
  const totalPaidOut = BigInt(cycle1.totalAmountAtomicUSDG) + BigInt(cycle2.totalAmountAtomicUSDG);
  const combinedProceeds = BigInt(cycle1.proceedsAmount) + BigInt(cycle2.proceedsAmount);
  assert.equal(totalPaidOut + BigInt(cycle2.dust), combinedProceeds);

  // Running the same two cycles with a non-zero third cycle keeps the invariant chained.
  const cycle3 = computeProRataDistribution({ directBalances, proceedsAmount: '0', previousDust: cycle2.dust });
  assert.equal(cycle3.distributablePool, '2');
  // floor(2/3) = 0 for every holder: still fully conserved as dust, nothing silently dropped.
  assert.equal(cycle3.entries.length, 0);
  assert.equal(cycle3.dust, '2');
});

test('computeProRataDistributionFromSnapshot reads directBalances and totalHolderBalance', () => {
  const holderSnapshot = {
    schema: 'hookemon.hkmn-holder-snapshot.v1',
    totalHolderBalance: '1000',
    directBalances: [{ recipient: address(0), directHkmnBalance: '100' }],
  };
  const distribution = computeProRataDistributionFromSnapshot(holderSnapshot, { proceedsAmount: '1000' });
  assert.equal(distribution.totalEligibleSupply, '1000');
  assert.equal(distribution.entries[0].amountAtomicUSDG, '100');

  assert.throws(() => computeProRataDistributionFromSnapshot(null, { proceedsAmount: '1' }), /holder snapshot is required/);
});

test('rejects malformed pro-rata inputs', () => {
  const validBalances = [{ recipient: address(0), directHkmnBalance: '10' }];
  assert.throws(() => computeProRataDistribution({ directBalances: [], proceedsAmount: '1' }), /nonempty array/);
  assert.throws(
    () => computeProRataDistribution({ directBalances: validBalances, proceedsAmount: 'abc' }),
    /proceeds amount/,
  );
  assert.throws(
    () => computeProRataDistribution({ directBalances: validBalances, proceedsAmount: '1', previousDust: '-1' }),
    /previous dust/,
  );
  assert.throws(
    () => computeProRataDistribution({
      directBalances: [{ recipient: address(0), directHkmnBalance: '0' }],
      proceedsAmount: '1',
    }),
    /balance must be positive/,
  );
  assert.throws(
    () => computeProRataDistribution({
      directBalances: [
        { recipient: address(0), directHkmnBalance: '1' },
        { recipient: address(0), directHkmnBalance: '1' },
      ],
      proceedsAmount: '1',
    }),
    /recipients must be unique/,
  );
  assert.throws(
    () => computeProRataDistribution({
      directBalances: [{ recipient: `0x${'0'.repeat(40)}`, directHkmnBalance: '1' }],
      proceedsAmount: '1',
    }),
    /nonzero EVM address/,
  );
});

test('chunkProRataEntries places a single small distribution into exactly one chunk', () => {
  const directBalances = [
    { recipient: address(0), directHkmnBalance: '3' },
    { recipient: address(1), directHkmnBalance: '7' },
  ];
  const distribution = computeProRataDistribution({ directBalances, proceedsAmount: '10' });
  const chunked = chunkProRataEntries(distribution.entries);

  assert.equal(chunked.chunkCount, 1);
  assert.equal(chunked.totalLiability, distribution.totalAmountAtomicUSDG);
  assert.equal(chunked.chunks.length, 1);
  assert.equal(chunked.chunks[0].chunkIndex, 0);
  assert.equal(chunked.chunks[0].rootSum, distribution.totalAmountAtomicUSDG);
  assert.deepEqual(chunked.chunks[0].entries.map((entry) => entry.index), [0, 1]);
});

test('a >1024-holder synthetic snapshot chunks correctly and each chunk rootSum sums to the total liability', () => {
  const holderCount = 2600;
  const directBalances = Array.from({ length: holderCount }, (_, index) => (
    { recipient: address(index), directHkmnBalance: '1' }
  ));
  // supply == holderCount == proceeds, so every holder floors to exactly 1 and dust is 0.
  const distribution = computeProRataDistribution({ directBalances, proceedsAmount: String(holderCount) });
  assert.equal(distribution.payableHolderCount, holderCount);
  assert.equal(distribution.dust, '0');

  const chunked = chunkProRataEntries(distribution.entries);
  assert.equal(chunked.chunkEntryLimit, CHUNK_ENTRY_LIMIT);
  assert.equal(chunked.chunkCount, 3);
  assert.equal(chunked.chunks.map((chunk) => chunk.entryCount).join(','), '1024,1024,552');
  assert.equal(chunked.chunks.map((chunk) => chunk.rootSum).join(','), '1024,1024,552');
  assert.equal(chunked.totalLiability, distribution.totalAmountAtomicUSDG);

  const sumOfChunkRootSums = chunked.chunks.reduce((sum, chunk) => sum + BigInt(chunk.rootSum), 0n);
  assert.equal(sumOfChunkRootSums, BigInt(distribution.totalAmountAtomicUSDG));

  // Chunking is deterministic and address-sorted end to end: no gaps, no overlap, no reordering.
  const flattened = chunked.chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.recipient));
  assert.deepEqual(flattened, distribution.entries.map((entry) => entry.recipient));
  for (const chunk of chunked.chunks) {
    assert.deepEqual(chunk.entries.map((entry) => entry.index), chunk.entries.map((_, index) => index));
  }
  // Every chunk index stays within contract's declared MAX_CHUNKS_PER_PAYOUT / TREE_WIDTH bounds.
  assert.ok(chunked.chunkCount <= MAX_CHUNKS_PER_DISTRIBUTION);
  for (const chunk of chunked.chunks) assert.ok(chunk.entryCount <= CHUNK_ENTRY_LIMIT);
});

test('chunkProRataEntries rejects an invalid chunk entry limit and too many chunks', () => {
  const entries = Array.from({ length: 65 }, (_, index) => (
    { index: 0, recipient: address(index), directHkmnBalance: '1', amountAtomicUSDG: '1' }
  ));
  assert.throws(() => chunkProRataEntries(entries, { chunkEntryLimit: 0 }), /chunk entry limit is invalid/);
  assert.throws(() => chunkProRataEntries(entries, { chunkEntryLimit: CHUNK_ENTRY_LIMIT + 1 }), /chunk entry limit is invalid/);
  // 65 entries at 1 per chunk would require 65 chunks, one over MAX_CHUNKS_PER_DISTRIBUTION (64).
  assert.throws(
    () => chunkProRataEntries(entries, { chunkEntryLimit: 1 }),
    /exceeding MAX_CHUNKS_PER_PAYOUT/,
  );
  // 64 entries at 1 per chunk fits exactly.
  assert.equal(chunkProRataEntries(entries.slice(0, 64), { chunkEntryLimit: 1 }).chunkCount, 64);
});

test('output feeds unmodified into reconcile.mjs\'s deriveHolderDistributionCandidate', () => {
  const closedProceedsBasis = closedProceedsBasisFixture('cycle-pro-rata-unmodified');
  assert.equal(closedProceedsBasis.finalCredit.amount, '10');

  const directBalances = [
    { recipient: address(0), directHkmnBalance: '3' },
    { recipient: address(1), directHkmnBalance: '7' },
  ];
  const distribution = computeProRataDistribution({ directBalances, proceedsAmount: '10' });
  assert.equal(distribution.totalAmountAtomicUSDG, closedProceedsBasis.finalCredit.amount);
  assert.equal(distribution.dust, '0');

  const chunked = chunkProRataEntries(distribution.entries);
  assert.equal(chunked.chunkCount, 1);

  const candidateInput = toHolderCandidateInput({
    closedProceedsBasis,
    holderSnapshot: holderSnapshotMetadata,
    chunk: chunked.chunks[0],
  });

  const candidate = deriveHolderDistributionCandidate(candidateInput);
  assert.equal(candidate.schema, 'hookemon.holder-distribution-candidate.v1');
  assert.equal(candidate.status, 'PENDING_OWNER_APPROVAL_AND_PROOF_DOMAIN');
  assert.equal(candidate.entryCount, 2);
  assert.equal(candidate.totalAmountAtomicUSDG, closedProceedsBasis.finalCredit.amount);
  assert.deepEqual(
    candidate.entries.map((entry) => [entry.recipient, entry.amountAtomicUSDG]),
    [[address(0), '3'], [address(1), '7']],
  );

  // Calling it twice on independently re-derived input is byte-identical (dual-builder friendly).
  const secondDistribution = computeProRataDistribution({ directBalances: [...directBalances].reverse(), proceedsAmount: '10' });
  const secondChunk = chunkProRataEntries(secondDistribution.entries).chunks[0];
  const secondCandidate = deriveHolderDistributionCandidate(toHolderCandidateInput({
    closedProceedsBasis,
    holderSnapshot: holderSnapshotMetadata,
    chunk: secondChunk,
  }));
  assert.deepEqual(secondCandidate, candidate);
});

test('toHolderCandidateInput rejects an empty chunk', () => {
  assert.throws(
    () => toHolderCandidateInput({
      closedProceedsBasis: {},
      holderSnapshot: holderSnapshotMetadata,
      chunk: { entries: [] },
    }),
    /nonempty chunk/,
  );
});
