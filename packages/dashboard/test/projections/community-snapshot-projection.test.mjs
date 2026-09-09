import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPublicCommunitySnapshot } from '../../src/projections/community-snapshot-projection.mjs';

function publicCardEvent(overrides = {}) {
  return {
    cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, memo: 'hookemon-cycle-1', mint: null,
    eventId: 'evt-1', sequence: '0000000001', state: 'observed',
    name: 'Ember Chick', imageUrl: null, observedAt: '2026-01-01T00:00:00.000Z',
    finalizedAt: null, transactionId: null, proceeds: null,
    ...overrides,
  };
}

test('recentWinners, when supplied, becomes the public cards feed verbatim', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    recentWinners: [publicCardEvent()],
  });
  assert.equal(snapshot.schemaVersion, 8);
  assert.deepEqual(snapshot.cards, [publicCardEvent()]);
});

test('recentWinners is omitted, cards stays empty (no fabricated card feed)', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.deepEqual(snapshot.cards, []);
});

test('an empty repository-derived terminal set projects a zero-metrics snapshot with no latestCycle', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.equal(snapshot.latestCycle, null);
  assert.equal(snapshot.metrics.totalCycleFundingMicroUsdg, null, 'no durable aggregate producer exists, so this is unknown, not an invented zero');
  assert.equal(snapshot.metrics.skippedCycles, null);
  assert.equal(snapshot.metrics.openedPacks, null);
  assert.equal(snapshot.metrics.completedCycles, 0, 'a real zero completed-cycle count is not fabricated');
});

test('a completed repository cycle projects as latestCycle status paid-out with no fabricated money fields', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [{ cycleId: 'cycle-1', terminalState: 'COMPLETED' }],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    completedCycles: 1,
  });
  assert.equal(snapshot.latestCycle.cycleId, 'cycle-1');
  assert.equal(snapshot.latestCycle.status, 'paid-out');
  assert.equal(snapshot.latestCycle.paidMicroUsdg, null);
  assert.equal(snapshot.latestCycle.roundAccounting, null, 'no readAccounting seam was supplied, so this stays null exactly as before');
  assert.deepEqual(snapshot.latestCycle.transactions, []);
  assert.equal(snapshot.metrics.completedCycles, 1);
});

test('a failed repository cycle projects as latestCycle status failed', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'testnet',
    repositoryCycles: [{ cycleId: 'cycle-2', terminalState: 'FAILED' }],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.equal(snapshot.latestCycle.status, 'failed');
});

test('readAccounting, when supplied, is called with the most recent terminal cycle id and its result becomes latestCycle.roundAccounting', async () => {
  const calls = [];
  const fixtureAccounting = {
    packSpendMicroUsdg: null, buybackMicroUsdg: null,
    outboundBridgeDebit: { chainId: '4663', assetId: '0xusdg', units: '5000000', decimals: 6 },
    inboundBridgeProceeds: { chainId: '4663', assetId: '0xusdg', units: '4990000', decimals: 6 },
    collectorPurchaseDebit: { chainId: 'solana:mainnet-beta', assetId: 'spl:stablecoin', units: '4995000', decimals: 6 },
    collectorBuybackProceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:stablecoin', units: '4990000', decimals: 6 },
    packGainMicroUsdg: null, packLossMicroUsdg: null,
    quotedCosts: {
      outboundBridgeMicroUsdg: null, inboundBridgeMicroUsdg: null, collectorApiMicroUsdg: null,
      evmNetworkMicroUsdg: null, solanaNetworkMicroUsdg: null, slippageMicroUsdg: null,
    },
    protectedCostsMicroUsdg: null, confirmedCostsMicroUsdg: null, cycleGainMicroUsdg: null, cycleLossMicroUsdg: null,
    walletBalanceBeforeMicroUsdg: null, walletBalanceAfterMicroUsdg: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdg: null, feeReserveTargetMicroUsdg: null, feeReserveTopUpMicroUsdg: null, feeReserveAfterMicroUsdg: null,
    plannedHolderRewardsMicroUsdg: null, paidHolderRewardsMicroUsdg: null,
    payoutLiabilityMicroUsdg: null, payoutDustMicroUsdg: null, paidHolderRewardsRecipientCount: null,
    holderRewardsStatus: 'not-started', distributionStatus: 'settled',
  };
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [
      { cycleId: 'cycle-older', terminalState: 'FAILED', terminalAtMs: 1_000 },
      { cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 2_000 },
    ],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    readAccounting: async cycleId => { calls.push(cycleId); return fixtureAccounting; },
  });
  assert.deepEqual(calls, ['cycle-1'], 'only the most recent terminal cycle is read, and never more than once');
  assert.deepEqual(snapshot.latestCycle.roundAccounting, fixtureAccounting);
});

test('two completed cycles plus a third still-running one: the latest completed is selected by terminalAtMs, not array order', async () => {
  // The still-running third cycle never appears in repositoryCycles (only terminal cycles do); it is
  // tracked separately via the active-cycle seam. Deliberately out of chronological array order here
  // to prove selection is not ".at(-1)".
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [
      { cycleId: 'cycle-2', terminalState: 'COMPLETED', terminalAtMs: 5_000 },
      { cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 1_000 },
    ],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    completedCycles: 2,
  });
  assert.equal(snapshot.latestCycle.cycleId, 'cycle-2');
  assert.equal(snapshot.historyComplete, true);
});

test('a deterministic tie-break by cycleId applies when two cycles share the same terminalAtMs', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [
      { cycleId: 'cycle-b', terminalState: 'COMPLETED', terminalAtMs: 5_000 },
      { cycleId: 'cycle-a', terminalState: 'COMPLETED', terminalAtMs: 5_000 },
    ],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  // 'cycle-a' < 'cycle-b' lexically; the tie-break is stable across repeated calls regardless of
  // input array order.
  assert.equal(snapshot.latestCycle.cycleId, 'cycle-a');
});

test('two or more terminal cycles without a terminalAtMs never guess a latest cycle; historyComplete honestly reports false', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [
      { cycleId: 'cycle-1', terminalState: 'COMPLETED' },
      { cycleId: 'cycle-2', terminalState: 'COMPLETED' },
    ],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.equal(snapshot.latestCycle, null);
  assert.equal(snapshot.historyComplete, false);
});

test('a single terminal cycle is unambiguous even without a terminalAtMs', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [{ cycleId: 'cycle-1', terminalState: 'COMPLETED' }],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.equal(snapshot.latestCycle.cycleId, 'cycle-1');
  assert.equal(snapshot.historyComplete, true);
});

test('latest cycle reports only its frozen recipient limit without inventing a paid count', async () => {
  const snapshot = await buildPublicCommunitySnapshot({ profileId: 'testnet', generatedAt: '2026-09-09T00:00:00.000Z', repositoryCycles: [{ cycleId: 'selected', terminalState: 'COMPLETED', rewardSelection: { rewardRecipientLimit: 700 } }] });
  assert.equal(snapshot.latestCycle.rewardRecipientLimit, 700);
  assert.equal(snapshot.latestCycle.payoutRecipientCount, null);
});
