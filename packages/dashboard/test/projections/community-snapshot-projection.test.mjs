import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPublicCommunitySnapshot } from '../../src/projections/community-snapshot-projection.mjs';

test('an empty repository-derived terminal set projects a zero-metrics snapshot with no latestCycle', async () => {
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.equal(snapshot.latestCycle, null);
  assert.equal(snapshot.metrics.totalCycleFundingMicroUsdg, '0');
  assert.equal(snapshot.metrics.completedCycles, 0);
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
    packSpendMicroUsdg: '5000000', buybackMicroUsdg: '4990000', packGainMicroUsdg: '0', packLossMicroUsdg: '10000',
    quotedCosts: {
      outboundBridgeMicroUsdg: null, inboundBridgeMicroUsdg: null, collectorApiMicroUsdg: null,
      evmNetworkMicroUsdg: null, solanaNetworkMicroUsdg: null, slippageMicroUsdg: null,
    },
    protectedCostsMicroUsdg: null, confirmedCostsMicroUsdg: null, cycleGainMicroUsdg: null, cycleLossMicroUsdg: null,
    walletBalanceBeforeMicroUsdg: null, walletBalanceAfterMicroUsdg: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdg: null, feeReserveTargetMicroUsdg: null, feeReserveTopUpMicroUsdg: null, feeReserveAfterMicroUsdg: null,
    plannedHolderRewardsMicroUsdg: null, paidHolderRewardsMicroUsdg: null,
    holderRewardsStatus: 'not-started', distributionStatus: 'settled',
  };
  const snapshot = await buildPublicCommunitySnapshot({
    profileId: 'mainnet',
    repositoryCycles: [{ cycleId: 'cycle-older', terminalState: 'FAILED' }, { cycleId: 'cycle-1', terminalState: 'COMPLETED' }],
    generatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    readAccounting: async cycleId => { calls.push(cycleId); return fixtureAccounting; },
  });
  assert.deepEqual(calls, ['cycle-1'], 'only the most recent terminal cycle is read, and never more than once');
  assert.deepEqual(snapshot.latestCycle.roundAccounting, fixtureAccounting);
});
