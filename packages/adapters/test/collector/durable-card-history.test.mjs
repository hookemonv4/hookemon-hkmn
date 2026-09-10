import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDurableCardHistory } from '../../src/collector/durable-card-history.mjs';

const baseRequests = [
  { packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: 'pack-a' },
  { packIndex: 1, memo: 'memo-1', expectedCardCount: 1, packType: 'pack-b' },
];
const requestedAtMs = 1_700_000_000_000;

function stages(overrides = {}) {
  return {
    purchase: { status: 'COMPLETE', evidence: { packs: [
      { packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'purchase-0', packCost: { decimals: 6, amountAtomic: '1200000' } },
      { packIndex: 1, memo: 'memo-1', status: 'purchased', signature: 'purchase-1', packCost: { decimals: 6, amountAtomic: '1300000' } },
    ] } },
    open: { status: 'COMPLETE', evidence: { packs: [
      { packIndex: 0, memo: 'memo-0', decision: 'opened', signature: 'open-0', mint: 'mint-0' },
      { packIndex: 1, memo: 'memo-1', decision: 'opened', signature: 'open-1', mint: 'mint-1' },
    ] } },
    epicGate: { status: 'COMPLETE', evidence: { packs: [
      { packIndex: 0, memo: 'memo-0', decision: 'sell', mint: 'mint-0', rarity: 'epic' },
      { packIndex: 1, memo: 'memo-1', decision: 'held', mint: 'mint-1', rarity: 'rare' },
    ] } },
    buyback: { status: 'COMPLETE', evidence: { soldCount: 1, packs: [
      { packIndex: 0, memo: 'memo-0', decision: 'sold', mint: 'mint-0', signature: 'sale-0', proceeds: { chainId: 'solana', assetId: 'stablecoin', decimals: 6, amountAtomic: '900000' } },
    ] } },
    ...overrides,
  };
}

test('buildDurableCardHistory maps gated and sold rows without fabricating metadata', () => {
  const result = buildDurableCardHistory({
    cycleId: 'cycle-1', packBatchRequestPacks: baseRequests, purchaseRequestedAtMs: requestedAtMs, stages: stages(),
  });
  assert.equal(result.skipped, 0);
  assert.equal(result.cards.length, 2);
  assert.deepEqual(result.cards[0], {
    cycleId: 'cycle-1', packIndex: 0, productId: 'pack-a', rarity: 'epic', nftAddress: 'mint-0',
    cardName: null, setName: null, cardNumber: null, imageUrl: null,
    packPriceMicroUsdg: '1200000', buybackMicroUsdg: '900000',
    observedAt: new Date(requestedAtMs).toISOString(),
  });
});

test('held-at-gate is included and unsupported lifecycle states are skipped', () => {
  const held = buildDurableCardHistory({
    cycleId: 'cycle-1', packBatchRequestPacks: [baseRequests[1]], purchaseRequestedAtMs: requestedAtMs,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ ...stages().purchase.evidence.packs[1] }] } },
      open: { status: 'COMPLETE', evidence: { packs: [{ ...stages().open.evidence.packs[1] }] } },
      epicGate: { status: 'COMPLETE', evidence: { packs: [{ ...stages().epicGate.evidence.packs[1] }] } },
    },
  });
  assert.equal(held.cards[0].buybackMicroUsdg, null);
  const purchased = buildDurableCardHistory({
    cycleId: 'cycle-1', packBatchRequestPacks: [baseRequests[0]], purchaseRequestedAtMs: requestedAtMs,
    stages: { purchase: { status: 'COMPLETE', evidence: { packs: [{ ...stages().purchase.evidence.packs[0] }] } } },
  });
  assert.deepEqual(purchased, { cards: [], skipped: 1 });
});

test('invalid batch and missing product type skip every affected pack; non-six-decimal amounts stay null', () => {
  assert.deepEqual(buildDurableCardHistory({
    cycleId: 'cycle-1',
    packBatchRequestPacks: [{ ...baseRequests[0], packType: null }],
    purchaseRequestedAtMs: requestedAtMs,
    stages: stages(),
  }), { cards: [], skipped: 1 });
  const altered = stages();
  for (const stage of ['purchase', 'open', 'epicGate', 'buyback']) {
    altered[stage].evidence.packs = altered[stage].evidence.packs.slice(0, 1);
  }
  altered.buyback.evidence.soldCount = 1;
  altered.purchase.evidence.packs[0].packCost = { decimals: 18, amountAtomic: '1200000000000000000' };
  altered.buyback.evidence.packs[0].proceeds = { chainId: 'solana', assetId: 'stablecoin', decimals: 18, amountAtomic: '9' };
  const result = buildDurableCardHistory({
    cycleId: 'cycle-1', packBatchRequestPacks: [baseRequests[0]], purchaseRequestedAtMs: requestedAtMs, stages: altered,
  });
  assert.equal(result.cards[0].packPriceMicroUsdg, null);
  assert.equal(result.cards[0].buybackMicroUsdg, null);
  assert.deepEqual(buildDurableCardHistory({
    cycleId: 'cycle-1', packBatchRequestPacks: baseRequests, purchaseRequestedAtMs: requestedAtMs,
    stages: { purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 9 }] } } },
  }), { cards: [], skipped: 2 });
});

test('buildDurableCardHistory is deterministic', () => {
  const input = { cycleId: 'cycle-1', packBatchRequestPacks: baseRequests, purchaseRequestedAtMs: requestedAtMs, stages: stages() };
  assert.deepEqual(buildDurableCardHistory(input), buildDurableCardHistory(input));
});
