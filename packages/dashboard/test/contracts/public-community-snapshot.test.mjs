import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePublicCommunitySnapshot } from '../../src/contracts/public-community-snapshot.mjs';
import { readDashboardProfile } from '../../src/contracts/dashboard-profile.mjs';

function baseSnapshot(profileId = 'mainnet') {
  const profile = readDashboardProfile(profileId);
  return {
    schemaVersion: 5,
    profile: profileId,
    badge: profile.badge,
    network: profile.network,
    historyComplete: true,
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    nextCycleAt: null,
    delayed: false,
    poolObservedAt: null,
    metrics: {
      latestObservedProjectPoolMicroUsdg: null,
      totalCycleFundingMicroUsdg: '0',
      totalCollectorSpendMicroUsdg: '0',
      totalBuybacksReturnedMicroUsdg: '0',
      totalBridgedBackMicroUsdg: '0',
      totalRewardsPaidMicroUsdg: '0',
      totalRewardsDeferredMicroUsdg: '0',
      totalQuotedOperatingCostsMicroUsdg: '0',
      latestRetainedReserveMicroUsdg: '0',
      latestCycleReserveTargetMicroUsdg: '0',
      completedCycles: 0,
      skippedCycles: 0,
      openedPacks: 0,
    },
    latestCycle: null,
    cards: [],
  };
}

test('accepts a well-formed empty snapshot', () => {
  const input = baseSnapshot();
  const result = normalizePublicCommunitySnapshot(input, 'mainnet');
  assert.equal(result.schemaVersion, 5);
  assert.equal(result.badge, 'MAINNET');
});

test('keeps a schema version 5 snapshot free of version 6 held-position fields', () => {
  const result = normalizePublicCommunitySnapshot(baseSnapshot(), 'mainnet');
  assert.equal(Object.hasOwn(result, 'heldPositionCount'), false);
  assert.equal(Object.hasOwn(result, 'heldPositions'), false);
});

test('keeps identifier-bearing held positions in schema version 6 while schema version 7 exposes only public status fields', () => {
  const legacyHeld = {
    ...baseSnapshot(),
    schemaVersion: 6,
    heldPositionCount: 1,
    heldPositions: [{
      positionId: 'position-1', cycleId: 'cycle-1', reason: 'EPIC_THRESHOLD', ageSeconds: 60, cycleState: 'COMPLETE',
    }],
  };
  const publicHeld = {
    ...baseSnapshot(),
    schemaVersion: 7,
    heldPositionCount: 1,
    heldPositions: [{ reason: 'EPIC_THRESHOLD', ageSeconds: 60, cycleState: 'COMPLETE' }],
  };

  assert.equal(normalizePublicCommunitySnapshot(legacyHeld, 'mainnet').heldPositions[0].positionId, 'position-1');
  assert.deepEqual(normalizePublicCommunitySnapshot(publicHeld, 'mainnet').heldPositions, publicHeld.heldPositions);
  assert.throws(() => normalizePublicCommunitySnapshot({
    ...publicHeld,
    heldPositions: [{ ...publicHeld.heldPositions[0], cycleId: 'cycle-1' }],
  }, 'mainnet'));
});

test('rejects a mismatched badge for the profile', () => {
  const input = { ...baseSnapshot(), badge: 'TESTNET' };
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('rejects poolObservedAt after generatedAt', () => {
  const input = baseSnapshot();
  input.poolObservedAt = new Date('2026-01-01T00:05:00.000Z').toISOString();
  input.metrics = { ...input.metrics, latestObservedProjectPoolMicroUsdg: '0' };
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('rejects a stale pool observation not marked delayed', () => {
  const input = baseSnapshot();
  input.poolObservedAt = new Date('2025-12-31T23:00:00.000Z').toISOString();
  input.metrics = { ...input.metrics, latestObservedProjectPoolMicroUsdg: '0' };
  input.delayed = false;
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('accepts a stale pool observation marked delayed', () => {
  const input = baseSnapshot();
  input.poolObservedAt = new Date('2025-12-31T23:00:00.000Z').toISOString();
  input.metrics = { ...input.metrics, latestObservedProjectPoolMicroUsdg: '0' };
  input.delayed = true;
  const result = normalizePublicCommunitySnapshot(input, 'mainnet');
  assert.equal(result.delayed, true);
});

test('rejects poolObservedAt/metrics null mismatch', () => {
  const input = baseSnapshot();
  input.poolObservedAt = input.generatedAt;
  // metrics.latestObservedProjectPoolMicroUsdg left null -> mismatch
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('accepts a latestCycle with transactions and a valid rewardRecipientLimit', () => {
  const input = baseSnapshot();
  input.latestCycle = {
    cycleId: 'cycle-1',
    status: 'paid-out',
    reason: null,
    updatedAt: null,
    paidMicroUsdg: null,
    payoutRecipientCount: 0,
    rewardRecipientLimit: 200,
    roundAccounting: null,
    transactions: [{ chain: 'solana', purpose: 'collector-purchase', id: '1'.repeat(44) }],
  };
  const result = normalizePublicCommunitySnapshot(input, 'mainnet');
  assert.equal(result.latestCycle.transactions.length, 1);
});

test('rejects an invalid rewardRecipientLimit', () => {
  const input = baseSnapshot();
  input.latestCycle = {
    cycleId: 'cycle-1', status: 'paid-out', reason: null, updatedAt: null, paidMicroUsdg: null,
    payoutRecipientCount: 0, rewardRecipientLimit: 150, roundAccounting: null, transactions: [],
  };
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('rejects duplicate transaction chain+id pairs', () => {
  const input = baseSnapshot();
  const tx = { chain: 'solana', purpose: 'collector-purchase', id: '1'.repeat(44) };
  input.latestCycle = {
    cycleId: 'cycle-1', status: 'paid-out', reason: null, updatedAt: null, paidMicroUsdg: null,
    payoutRecipientCount: 0, rewardRecipientLimit: 200, roundAccounting: null, transactions: [tx, tx],
  };
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('rejects more than 12 cards', () => {
  const input = baseSnapshot();
  input.cards = Array.from({ length: 13 }, (_, i) => ({
    cycleId: 'c1', productId: `p${i}`, rarity: 'common', nftAddress: null, cardName: null, setName: null,
    cardNumber: null, imageUrl: null, packPriceMicroUsdg: null, buybackMicroUsdg: null,
  }));
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('rejects an unknown top-level key', () => {
  const input = { ...baseSnapshot(), extra: 1 };
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

function v8Snapshot() {
  return { ...baseSnapshot(), schemaVersion: 8, heldPositionCount: 0, heldPositions: [] };
}

function publicCardEvent(overrides = {}) {
  return {
    cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, memo: 'hookemon-cycle-1', mint: null,
    eventId: 'evt-1', sequence: '0000000001', state: 'observed',
    name: 'Ember Chick', imageUrl: null, observedAt: '2026-01-01T00:00:00.000Z',
    finalizedAt: null, transactionId: null, proceeds: null,
    ...overrides,
  };
}

test('schemaVersion 8 accepts the frozen PublicCardEvent shape as a real card, not the legacy productId/rarity shape', () => {
  const input = v8Snapshot();
  input.cards = [publicCardEvent()];
  const result = normalizePublicCommunitySnapshot(input, 'mainnet');
  assert.equal(result.schemaVersion, 8);
  assert.deepEqual(result.cards[0], publicCardEvent());
});

test('schemaVersion 8 rejects a card still shaped as the legacy productId/rarity card', () => {
  const input = v8Snapshot();
  input.cards = [{
    cycleId: 'c1', productId: 'p1', rarity: 'common', nftAddress: null, cardName: null, setName: null,
    cardNumber: null, imageUrl: null, packPriceMicroUsdg: null, buybackMicroUsdg: null,
  }];
  assert.throws(() => normalizePublicCommunitySnapshot(input, 'mainnet'));
});

test('schemaVersion 8 accepts a finalized card with real typed proceeds', () => {
  const input = v8Snapshot();
  input.cards = [publicCardEvent({
    state: 'finalized',
    finalizedAt: '2026-01-01T00:05:00.000Z',
    transactionId: 'sig-1',
    proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '4995000', decimals: 6 },
  })];
  const result = normalizePublicCommunitySnapshot(input, 'mainnet');
  assert.equal(result.cards[0].state, 'finalized');
  assert.deepEqual(result.cards[0].proceeds, { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '4995000', decimals: 6 });
});

test('schemaVersion 8 roundAccounting: unknown packSpend/buyback is null, and the real Collector-side debit is a distinct typed Amount', () => {
  const input = v8Snapshot();
  input.latestCycle = {
    cycleId: 'cycle-1', status: 'paid-out', reason: null, updatedAt: null, paidMicroUsdg: null,
    payoutRecipientCount: 0, rewardRecipientLimit: 200, transactions: [],
    roundAccounting: {
      packSpendMicroUsdg: '50',
      buybackMicroUsdg: null,
      collectorPurchaseDebit: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '49', decimals: 6 },
      collectorBuybackProceeds: null,
      packGainMicroUsdg: null,
      packLossMicroUsdg: null,
      quotedCosts: {
        outboundBridgeMicroUsdg: null, inboundBridgeMicroUsdg: null, collectorApiMicroUsdg: null,
        evmNetworkMicroUsdg: null, solanaNetworkMicroUsdg: null, slippageMicroUsdg: null,
      },
      protectedCostsMicroUsdg: null, confirmedCostsMicroUsdg: null, cycleGainMicroUsdg: null, cycleLossMicroUsdg: null,
      walletBalanceBeforeMicroUsdg: null, walletBalanceAfterMicroUsdg: null,
      networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
      feeReserveBeforeMicroUsdg: null, feeReserveTargetMicroUsdg: null, feeReserveTopUpMicroUsdg: null, feeReserveAfterMicroUsdg: null,
      plannedHolderRewardsMicroUsdg: null, paidHolderRewardsMicroUsdg: null,
      holderRewardsStatus: 'pending', distributionStatus: 'pending',
    },
  };
  const result = normalizePublicCommunitySnapshot(input, 'mainnet');
  assert.equal(result.latestCycle.roundAccounting.buybackMicroUsdg, null);
  assert.deepEqual(result.latestCycle.roundAccounting.collectorPurchaseDebit, {
    chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '49', decimals: 6,
  });
});
