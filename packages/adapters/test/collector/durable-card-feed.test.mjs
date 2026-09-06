import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDurableCardFeed } from '../../src/collector/durable-card-feed.mjs';
import { createRecentWinnersCollector } from '../../src/collector/recent-winners.mjs';

const CYCLE_ID = 'cycle-1';
const REQUESTED_AT_MS = 1_700_000_000_000;

function packBatchRequestPacks(overrides = []) {
  return [
    { packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: 'pokemon_25' },
    { packIndex: 1, memo: 'memo-1', expectedCardCount: 1, packType: 'pokemon_25' },
    ...overrides,
  ];
}

test('buildDurableCardFeed builds a PURCHASED observation from the real purchase-batch requestedAtMs, no fabricated timestamp', () => {
  const { trustedOperations, observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: packBatchRequestPacks(),
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [
        { packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' },
        { packIndex: 1, memo: 'memo-1', status: 'not_purchased' },
      ] } },
    },
  });
  assert.equal(trustedOperations.size, 2, 'both packs get a trusted identity even though only one has a card to show');
  assert.deepEqual(trustedOperations.get('memo-0'), { cycleId: CYCLE_ID, operationId: 'pack:cycle-1:0', packIndex: 0, mint: null, wallet: null });
  assert.equal(observations.length, 1, 'a not_purchased pack never fabricates a card event');
  assert.equal(observations[0].operationId, 'pack:cycle-1:0');
  assert.equal(observations[0].state, 'observed');
  assert.equal(observations[0].observedAt, new Date(REQUESTED_AT_MS).toISOString());
  assert.equal(observations[0].finalizedAt, null);
  assert.equal(observations[0].transactionId, 'sig-0');
});

test('buildDurableCardFeed requires a real caller-supplied timestamp past PURCHASED, never invents one', () => {
  const { observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: [{ packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null }],
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' }] } },
      open: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', decision: 'opened', signature: 'open-sig-0', mint: 'mint-0', assetKind: 'spl' }] } },
    },
    // no observedAtByOperationId supplied for the OPENED transition
  });
  assert.equal(observations.length, 0, 'past-PURCHASED progress without a real observed timestamp is not yet buildable, never a fabricated one');
});

test('buildDurableCardFeed uses a caller-supplied real timestamp for a post-purchase transition and marks finalizedAt only once genuinely terminal', () => {
  const { observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: [{ packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null }],
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' }] } },
      open: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', decision: 'opened', signature: 'open-sig-0', mint: 'mint-0', assetKind: 'spl' }] } },
      epicGate: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sell', offer: null, insuredValue: null, rawInsuredValue: null, insuredValueUnit: null, instantBuybackPercent: null, matchedBuybackPercent: null, prizeTier: null, rarity: null }] } },
      buyback: { status: 'COMPLETE', evidence: { soldCount: 1, packs: [{ packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sold', signature: 'sale-sig-0', proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '40' } }] } },
    },
    observedAtByOperationId: new Map([
      ['pack:cycle-1:0', { observedAt: '2026-01-01T00:05:00.000Z', finalizedAt: '2026-01-01T00:06:00.000Z' }],
    ]),
  });
  assert.equal(observations.length, 1);
  const [observation] = observations;
  assert.equal(observation.state, 'finalized');
  assert.equal(observation.mint, 'mint-0');
  assert.equal(observation.transactionId, 'sale-sig-0');
  assert.deepEqual(observation.proceeds, { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, units: '40' });
  assert.equal(observation.observedAt, '2026-01-01T00:05:00.000Z');
  assert.equal(observation.finalizedAt, '2026-01-01T00:06:00.000Z');
});

test('buildDurableCardFeed excludes a pre-reconcile buyback decision (submitted/unknown) from the public feed, never surfaced as a pending card state', () => {
  const { observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: [{ packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null }],
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' }] } },
      buyback: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'submitted' }] } },
    },
  });
  assert.equal(observations.length, 0);
});

test('buildDurableCardFeed rebuilds byte-identical output from the same durable inputs, with stable identities/order/timestamps and no duplicate card', () => {
  const inputs = {
    cycleId: CYCLE_ID,
    packBatchRequestPacks: packBatchRequestPacks(),
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [
        { packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' },
        { packIndex: 1, memo: 'memo-1', status: 'purchased', signature: 'sig-1' },
      ] } },
    },
  };
  const first = buildDurableCardFeed(inputs);
  const second = buildDurableCardFeed(inputs);
  assert.deepEqual([...first.observations], [...second.observations]);
  assert.deepEqual([...first.trustedOperations.entries()], [...second.trustedOperations.entries()]);

  const collector = createRecentWinnersCollector({ trustedOperations: first.trustedOperations });
  for (const observation of first.observations) collector.ingest(observation);
  for (const observation of second.observations) collector.ingest(observation);
  assert.equal(collector.size(), 2, 'ingesting the same rebuilt feed twice never duplicates a card');
});

test('buildDurableCardFeed: an out-of-order later observation never regresses an already-finalized card once fed through the collector', () => {
  const { trustedOperations, observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: [{ packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null }],
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' }] } },
      open: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', decision: 'opened', signature: 'open-sig-0', mint: 'mint-0', assetKind: 'spl' }] } },
      epicGate: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sell', offer: null, insuredValue: null, rawInsuredValue: null, insuredValueUnit: null, instantBuybackPercent: null, matchedBuybackPercent: null, prizeTier: null, rarity: null }] } },
      buyback: { status: 'COMPLETE', evidence: { soldCount: 1, packs: [{ packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sold', signature: 'sale-sig-0', proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '40' } }] } },
    },
    observedAtByOperationId: new Map([
      ['pack:cycle-1:0', { observedAt: '2026-01-01T00:05:00.000Z', finalizedAt: '2026-01-01T00:06:00.000Z' }],
    ]),
  });
  const collector = createRecentWinnersCollector({ trustedOperations });
  const finalized = collector.ingest(observations[0]);
  assert.equal(finalized.state, 'finalized');
  // A stale re-delivery of the earlier PURCHASED observation (e.g. a delayed Ably message) arrives
  // after the card is already finalized -- must never regress it back to 'observed'.
  const stalePurchased = {
    cycleId: CYCLE_ID, operationId: 'pack:cycle-1:0', packIndex: 0, memo: 'memo-0', mint: 'mint-0',
    eventId: 'pack:cycle-1:0:PURCHASED', sequence: String(BigInt(REQUESTED_AT_MS) * 1_000_000n),
    state: 'observed', name: null, imageUrl: null,
    observedAt: new Date(REQUESTED_AT_MS).toISOString(), finalizedAt: null, transactionId: 'sig-0', proceeds: null,
  };
  const afterStale = collector.ingest(stalePurchased);
  assert.equal(afterStale.state, 'finalized', 'finalized never regresses to observed');
  assert.equal(collector.size(), 1);
});

test('F9-sol-verification repro: a corrupt COMPLETE stage with a foreign memo rejects the cycle feed rather than falling back to PURCHASED', () => {
  const { trustedOperations, observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: [{ packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null }],
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' }] } },
      open: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', decision: 'opened', signature: 'open-sig-0', mint: 'mint-0' }] } },
      epicGate: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', decision: 'sell', mint: 'mint-0' }] } },
      // A buyback entry at the same packIndex but a DIFFERENT memo -- a broken/foreign cross-stage
      // ledger, never trusted as this pack's own SOLD outcome.
      buyback: { status: 'COMPLETE', evidence: { soldCount: 1, packs: [
        { packIndex: 0, memo: 'foreign-memo', mint: 'foreign-mint', decision: 'sold', signature: 'foreign-sig', proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '999' } },
      ] } },
    },
  });
  assert.equal(trustedOperations.size, 0);
  assert.equal(observations.length, 0);
});

test('F8-sol-verification repro: a self-contradictory purchase batch-request ledger (duplicate packIndex under two different memos) rejects the entire batch, not a partial publication', () => {
  const { trustedOperations, observations } = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: [
      { packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null },
      { packIndex: 0, memo: 'memo-1', expectedCardCount: 1, packType: null },
    ],
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {
      purchase: { status: 'COMPLETE', evidence: { packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' }] } },
    },
  });
  assert.equal(trustedOperations.size, 0, 'no partial trust for the non-conflicting entry either');
  assert.equal(observations.length, 0);
});

function completeLifecycle() {
  return {
    purchase: { status: 'COMPLETE', evidence: { packs: [
      { packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'purchase-sig-0' },
      { packIndex: 1, memo: 'memo-1', status: 'purchased', signature: 'purchase-sig-1' },
    ] } },
    open: { status: 'COMPLETE', evidence: { packs: [
      { packIndex: 0, memo: 'memo-0', decision: 'opened', signature: 'open-sig-0', mint: 'mint-0' },
      { packIndex: 1, memo: 'memo-1', decision: 'opened', signature: 'open-sig-1', mint: 'mint-1' },
    ] } },
    epicGate: { status: 'COMPLETE', evidence: { packs: [
      { packIndex: 0, memo: 'memo-0', decision: 'sell', mint: 'mint-0' },
      { packIndex: 1, memo: 'memo-1', decision: 'sell', mint: 'mint-1' },
    ] } },
    buyback: { status: 'COMPLETE', evidence: { soldCount: 2, packs: [
      { packIndex: 0, memo: 'memo-0', decision: 'sold', mint: 'mint-0', signature: 'sale-sig-0', proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '40' } },
      { packIndex: 1, memo: 'memo-1', decision: 'sold', mint: 'mint-1', signature: 'sale-sig-1', proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '30' } },
    ] } },
  };
}

test('F9-sol-verification repro: every COMPLETE stage has one memo-and-mint-continuous row per predecessor', () => {
  const malformed = completeLifecycle();
  malformed.buyback.evidence.packs[1] = { ...malformed.buyback.evidence.packs[1], packIndex: 0, mint: 'foreign-mint' };
  const result = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: packBatchRequestPacks(),
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: malformed,
  });
  assert.equal(result.trustedOperations.size, 0);
  assert.equal(result.observations.length, 0);
});

test('F9-sol-verification repro: sold rows require a signature and a typed proceeds amount, while held rows cannot carry either', () => {
  for (const change of [
    stages => { delete stages.buyback.evidence.packs[0].signature; },
    stages => { delete stages.buyback.evidence.packs[0].proceeds; },
    stages => { stages.buyback.evidence.packs[1] = { ...stages.buyback.evidence.packs[1], decision: 'held', signature: 'contradictory-sig', proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '30' } }; stages.buyback.evidence.soldCount = 1; },
  ]) {
    const stages = completeLifecycle();
    change(stages);
    const result = buildDurableCardFeed({
      cycleId: CYCLE_ID,
      packBatchRequestPacks: packBatchRequestPacks(),
      purchaseRequestedAtMs: REQUESTED_AT_MS,
      stages,
    });
    assert.equal(result.trustedOperations.size, 0);
    assert.equal(result.observations.length, 0);
  }
});

test('F9-sol-verification repro: a unique but non-dense request ledger is rejected before any stage is trusted', () => {
  const result = buildDurableCardFeed({
    cycleId: CYCLE_ID,
    packBatchRequestPacks: packBatchRequestPacks().map(request => ({ ...request, packIndex: request.packIndex + 1 })),
    purchaseRequestedAtMs: REQUESTED_AT_MS,
    stages: {},
  });
  assert.equal(result.trustedOperations.size, 0);
  assert.equal(result.observations.length, 0);
});
