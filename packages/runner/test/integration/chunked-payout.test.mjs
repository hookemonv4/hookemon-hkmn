// End-to-end fixture regression (WP-23): chunked payout beyond 1024 holders.
//
// WP-04 replaced `PayoutCommitment`'s single depth-10 Merkle-sum tree (hard-capped at
// `CanonicalMerkleSum.TREE_WIDTH` = 1024 leaves) with a parent/child structure
// (packages/contracts/src/payout/PayoutCommitment.sol): the funded amount stays keyed by one
// `payoutId` (unchanged "money-in-custody" step), but the holder breakdown may now be represented
// by up to `MAX_CHUNKS_PER_PAYOUT` (= 64) independent depth-10 chunk trees, committed one at a time
// via `commitPayoutChunk(payoutId, chunkIndex, rootHash, rootSum)`. No chunk becomes claimable
// until the exact sum of every committed chunk's `rootSum` equals the payout's funded `rootSum`
// (`payout.rootSum`, fixed at funding time) — at which point the manifest closes permanently
// (`manifestClosed[payoutId] = true`).
//
// The off-chain candidate/manifest compiler that will eventually split >1024 real holders into
// chunks automatically is WP-12's job (packages/runner/src/distribution/pro-rata.mjs), not yet
// built — `deriveHolderDistributionCandidate` (packages/runner/src/distribution/reconcile.mjs)
// is still hard-capped at 1024 entries by design (`assertCandidateArray`), matching one single
// depth-10 tree. This test proves the *lower-level* mechanism WP-04 actually added — independent
// per-chunk trees built via the existing `buildDistribution` (packages/runner/src/distribution/merkle-sum.mjs,
// itself sourced from packages/contracts/tooling/payout/canonical-merkle-sum.mjs, the same JS
// mirror the contract's own Solidity tests are generated against) whose sums add up exactly to one
// funded liability — through a real closed cycle from the existing fixture pipeline, using the
// exact "clone the real closed-proceeds basis, override `finalCredit`, recompute the digest"
// technique `holder-candidate.test.mjs` already established for exercising a total other than the
// fixture harness's own fixed return amount.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { deriveClosedProceedsBasis, deriveHolderDistributionCandidate } from '../../src/distribution/reconcile.mjs';
import { buildDistribution, decodeCanonicalManifest, orderedProofsDigest, verifyProof, WIDTH } from '../../src/distribution/merkle-sum.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

const HOOK = `0x${'a'.repeat(40)}`;
const CYCLE = `0x${'c'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;
const CHAIN_ID = '4663';
const SNAPSHOT_NUMBER = '12345678';
const SNAPSHOT_HASH = `0x${'e'.repeat(64)}`;
const MAX_CHUNKS_PER_PAYOUT = 64; // packages/contracts/src/payout/PayoutCommitment.sol:35
const HOLDER_COUNT = 2100; // > 1024: forces at least two chunks

function recipientForIndex(globalIndex) {
  // 20-byte address, deterministic and distinct per holder, never the zero address or HOOK.
  return `0x${(globalIndex + 1).toString(16).padStart(40, '0')}`;
}

/// Splits `totalUSDG` pro rata across `HOLDER_COUNT` holders whose direct HKMN balance is
/// `index + 1` (a simple, strictly-increasing distribution), using floor division and carrying
/// the residual dust into the final holder — the same `floor(balance_i * proceeds / totalSupply)`
/// rule design.md section 3.6/B2 describes, with the leftover dust tracked and assigned rather
/// than silently dropped.
function buildHolderSet(totalUSDG) {
  const balances = Array.from({ length: HOLDER_COUNT }, (_, index) => BigInt(index + 1));
  const totalSupply = balances.reduce((sum, balance) => sum + balance, 0n);
  const amounts = balances.map(balance => (balance * totalUSDG) / totalSupply);
  const distributed = amounts.reduce((sum, amount) => sum + amount, 0n);
  const dust = totalUSDG - distributed;
  amounts[amounts.length - 1] += dust;
  assert.ok(amounts.every(amount => amount > 0n), 'every holder must receive a strictly positive amount');
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0n), totalUSDG);
  return balances.map((balance, index) => ({
    globalIndex: index,
    recipient: recipientForIndex(index),
    directHkmnBalance: balance.toString(),
    amountAtomicUSDG: amounts[index].toString(),
  }));
}

function chunkHolderSet(holders, chunkSize = WIDTH) {
  const chunks = [];
  for (let start = 0; start < holders.length; start += chunkSize) {
    chunks.push(holders.slice(start, start + chunkSize));
  }
  return chunks;
}

/// Rebuilds `manifestBytes` from scratch via `decodeCanonicalManifest` + `buildDistribution` and
/// asserts it reproduces the exact same digest, root, and ordered-proofs digest — the same
/// dual-copy reconstruction-and-compare check `distribution/manifest.mjs`'s
/// `verifyDistributionCopies` performs for the single-chunk case, applied per chunk here since the
/// single-payout `artifact` schema that function verifies does not (yet) span multiple chunks.
function verifyChunkDualCopy(built) {
  const decoded = decodeCanonicalManifest(built.manifestBytes);
  const rebuilt = buildDistribution(decoded);
  assert.equal(rebuilt.manifestDigest, built.manifestDigest);
  assert.deepEqual(rebuilt.root, built.root);
  assert.equal(orderedProofsDigest(rebuilt.proofs), orderedProofsDigest(built.proofs));
}

/// Mirrors, verbatim, `PayoutCommitment.commitPayoutChunk`'s full accounting body: recommitting an
/// already-committed index first backs out its old contribution, a chunk may never push the
/// running sum above the funded liability, and the manifest closes permanently the instant the
/// running sum reaches that liability exactly.
function createChunkCommitmentLedger(payoutRootSum) {
  let runningSum = 0n;
  let closed = false;
  const committed = new Map();
  return {
    commit(chunkIndex, rootSum) {
      if (closed) throw new Error('PayoutManifestAlreadyClosed');
      if (chunkIndex >= MAX_CHUNKS_PER_PAYOUT) throw new Error('PayoutChunkIndexOutOfRange');
      let sum = runningSum;
      if (committed.has(chunkIndex)) sum -= committed.get(chunkIndex);
      if (rootSum > payoutRootSum || sum > payoutRootSum - rootSum) throw new Error('PayoutChunkSumExceedsLiability');
      sum += rootSum;
      committed.set(chunkIndex, rootSum);
      runningSum = sum;
      if (runningSum === payoutRootSum) closed = true;
      return { runningSum, closed };
    },
    get runningSum() { return runningSum; },
    get closed() { return closed; },
  };
}

test('a >1024-holder set is structurally rejected by the existing single-manifest candidate path, motivating chunking', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(CYCLE, [], { cycleStore });
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, CYCLE);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const realClosedProceedsBasis = deriveClosedProceedsBasis(runner.readClosedProceedsBasisHandoff({ proceedsKey }));

  const holders = buildHolderSet(4_412_137n);
  const totalUSDG = holders.reduce((sum, holder) => sum + BigInt(holder.amountAtomicUSDG), 0n);
  const closedProceedsBasis = structuredClone(realClosedProceedsBasis);
  closedProceedsBasis.finalCredit.preBalance = '0';
  closedProceedsBasis.finalCredit.postBalance = totalUSDG.toString();
  closedProceedsBasis.finalCredit.amount = totalUSDG.toString();
  const { basisDigest: _old, ...content } = closedProceedsBasis;
  closedProceedsBasis.basisDigest = digest({ domain: 'hookemon.closed-proceeds-basis.v1', basis: content });

  const snapshot = {
    schema: 'hookemon.input-bound-hkmn-snapshot-candidate.v1',
    authority: 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED',
    asset: 'HKMN',
    chainId: CHAIN_ID,
    tokenAddress: `0x${'b'.repeat(40)}`,
    blockNumber: SNAPSHOT_NUMBER,
    blockHash: SNAPSHOT_HASH,
    finalized: true,
    directBalances: holders.map(({ recipient, directHkmnBalance }) => ({ recipient, directHkmnBalance })),
  };
  const entries = holders.map(holder => ({
    index: holder.globalIndex, recipient: holder.recipient,
    directHkmnBalance: holder.directHkmnBalance, amountAtomicUSDG: holder.amountAtomicUSDG,
  }));

  assert.throws(
    () => deriveHolderDistributionCandidate({ closedProceedsBasis, snapshot, entries }),
    /between 1 and 1024/,
  );
});

test('the same >1024-holder cycle completes via independent chunk trees whose sums add up to exactly the funded total', () => {
  const totalUSDG = 4_412_137n; // not an exact multiple of total HKMN supply: forces real dust-carry
  const holders = buildHolderSet(totalUSDG);
  assert.equal(holders.length, HOLDER_COUNT);
  assert.ok(HOLDER_COUNT > WIDTH, 'the holder set must exceed one chunk to actually require chunking');

  const domain = { chainId: CHAIN_ID, hook: HOOK, cycleId: CYCLE, payoutId: PAYOUT };
  const groups = chunkHolderSet(holders);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].length, WIDTH);
  assert.equal(groups[1].length, WIDTH);
  assert.equal(groups[2].length, HOLDER_COUNT - 2 * WIDTH);
  assert.ok(groups.length <= MAX_CHUNKS_PER_PAYOUT);

  const ledger = createChunkCommitmentLedger(totalUSDG);
  const builtChunks = [];
  groups.forEach((group, chunkIndex) => {
    // Each chunk is its own independent depth-10 tree, keyed by LOCAL leaf indices 0..(size-1) —
    // chunk identity itself is carried entirely out-of-band by `chunkIndex`, exactly as
    // `commitPayoutChunk(payoutId, chunkIndex, ...)` keys chunks by an external mapping, not by
    // anything folded into the tree's own hash domain (the domain here is identical across every
    // chunk: only the entries, and hence `manifestDigest`, differ).
    const entries = group.map((holder, localIndex) => ({
      index: localIndex, recipient: holder.recipient,
      amount: holder.amountAtomicUSDG, directBalance: holder.directHkmnBalance,
    }));
    const built = buildDistribution({ domain, snapshotNumber: SNAPSHOT_NUMBER, snapshotHash: SNAPSHOT_HASH, entries });
    assert.equal(built.leaves.length, WIDTH);
    assert.equal(built.proofs.length, WIDTH);
    verifyChunkDualCopy(built);

    const chunkRootSum = BigInt(built.root.sum);
    const expectedChunkSum = group.reduce((sum, holder) => sum + BigInt(holder.amountAtomicUSDG), 0n);
    assert.equal(chunkRootSum, expectedChunkSum);

    // Spot-check pull-based claim proofs for the first, middle, and last holder of this chunk,
    // each against this chunk's OWN root — proving per-chunk settlement is independently provable.
    for (const localIndex of [0, Math.floor(group.length / 2), group.length - 1]) {
      assert.equal(verifyProof(built.leaves[localIndex], localIndex, built.proofs[localIndex], built.root), true);
    }

    const before = ledger.commit(chunkIndex, chunkRootSum);
    builtChunks.push({ chunkIndex, root: built.root, manifestDigest: built.manifestDigest });
    if (chunkIndex < groups.length - 1) {
      assert.equal(before.closed, false, `manifest must not close before the final chunk (index ${chunkIndex})`);
      assert.ok(before.runningSum < totalUSDG);
    }
  });

  // The core WP-04 invariant: sum(chunk.rootSum) == payoutLiability[payoutId] exactly, and only
  // then does the manifest close.
  assert.equal(ledger.runningSum, totalUSDG);
  assert.equal(ledger.closed, true);

  // Every chunk's manifest is distinct (different entries => different manifestDigest) even
  // though every chunk shares the same domain (chainId/hook/cycleId/payoutId).
  assert.equal(new Set(builtChunks.map(chunk => chunk.manifestDigest)).size, groups.length);
  // And every committed chunkIndex stays within the declared ceiling.
  assert.ok(builtChunks.every(chunk => chunk.chunkIndex < MAX_CHUNKS_PER_PAYOUT));
});

test('a chunk cannot push the committed sum above the funded liability, and nothing may be committed once the manifest has closed', () => {
  const totalUSDG = 100n;
  const ledger = createChunkCommitmentLedger(totalUSDG);
  ledger.commit(0, 60n);
  assert.throws(() => ledger.commit(1, 41n), /PayoutChunkSumExceedsLiability/);
  ledger.commit(1, 40n);
  assert.equal(ledger.runningSum, 100n);
  assert.equal(ledger.closed, true);
  assert.throws(() => ledger.commit(2, 1n), /PayoutManifestAlreadyClosed/);
});

test('recommitting an already-committed chunk index replaces its prior contribution rather than double-counting it', () => {
  const totalUSDG = 100n;
  const ledger = createChunkCommitmentLedger(totalUSDG);
  ledger.commit(0, 30n);
  ledger.commit(1, 30n);
  assert.equal(ledger.runningSum, 60n);
  // Recommit chunk 0 with a larger root sum: the ledger must back out the old 30 first.
  ledger.commit(0, 70n);
  assert.equal(ledger.runningSum, 100n);
  assert.equal(ledger.closed, true);
});
