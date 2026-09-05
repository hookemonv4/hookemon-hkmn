import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePublicCycleStatus } from '../../src/contracts/public-cycle-status.mjs';
import { readDashboardProfile } from '../../src/contracts/dashboard-profile.mjs';

function idleStatus(profileId = 'mainnet') {
  const profile = readDashboardProfile(profileId);
  const generatedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const nextCycleAt = new Date('2026-01-01T00:20:00.000Z').toISOString();
  return {
    schemaVersion: 3,
    profile: profileId,
    network: profile.network,
    executionState: 'active',
    executionReason: null,
    generatedAt,
    nextCycleAt,
    countdownSeconds: 1_200,
    cycle: null,
  };
}

test('accepts a well-formed idle status and echoes it back unchanged', () => {
  const input = idleStatus();
  const result = normalizePublicCycleStatus(input, 'mainnet');
  assert.deepEqual(result, input);
});

test('accepts a paused status with executionReason operator-paused', () => {
  const input = { ...idleStatus(), executionState: 'paused', executionReason: 'operator-paused' };
  const result = normalizePublicCycleStatus(input, 'mainnet');
  assert.equal(result.executionState, 'paused');
});

test('rejects a paused status without executionReason operator-paused', () => {
  const input = { ...idleStatus(), executionState: 'paused', executionReason: null };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test('rejects an active status carrying executionReason', () => {
  const input = { ...idleStatus(), executionReason: 'operator-paused' };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('rejects a wrong countdownSeconds', () => {
  const input = { ...idleStatus(), countdownSeconds: 999 };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('rejects an unknown top-level key', () => {
  const input = { ...idleStatus(), extra: true };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('rejects a missing required key', () => {
  const input = idleStatus();
  delete input.executionReason;
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('rejects the wrong network for the profile', () => {
  const input = idleStatus();
  input.network = readDashboardProfile('testnet').network;
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('rejects an unexpected profile mismatch', () => {
  const input = idleStatus('testnet');
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('accepts a full active cycle with round accounting and enforces gain/loss exclusivity', () => {
  const input = idleStatus();
  input.cycle = {
    cycleId: 'cycle-1',
    status: 'purchase-finalized',
    selectedPackId: 'starter-pack',
    maxBoostersPerCycle: 5,
    plannedBoosters: 1,
    openedBoosters: 1,
    actions: [{ type: 'buy-pack', status: 'complete', at: input.generatedAt }],
    cards: [{
      productId: 'p1', rarity: 'rare', nftAddress: null, cardName: 'Card', setName: null,
      cardNumber: null, imageUrl: null, packPriceMicroUsdg: '1000000', buybackMicroUsdg: '2000000',
    }],
    returnedMicroUsdg: null,
    rewardStatus: null,
    roundAccounting: {
      packSpendMicroUsdg: '1000000', buybackMicroUsdg: '2000000', packGainMicroUsdg: '1000000', packLossMicroUsdg: '0',
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
  const result = normalizePublicCycleStatus(input, 'mainnet');
  assert.equal(result.cycle.roundAccounting.packGainMicroUsdg, '1000000');
});

test('rejects roundAccounting with both packGain and packLoss nonzero', () => {
  const input = idleStatus();
  input.cycle = {
    cycleId: 'cycle-1', status: 'x', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: {
      packSpendMicroUsdg: '1', buybackMicroUsdg: '1', packGainMicroUsdg: '1', packLossMicroUsdg: '1',
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
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('rejects a cards array length mismatched with openedBoosters', () => {
  const input = idleStatus();
  input.cycle = {
    cycleId: 'cycle-1', status: 'x', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 1, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: null,
  };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'));
});

test('accepts the legacy schemaVersion 1 idle shape and normalizes to schemaVersion 3', () => {
  const generatedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const nextCycleAt = new Date('2026-01-01T00:20:00.000Z').toISOString();
  const legacy = { schemaVersion: 1, generatedAt, nextCycleAt, countdownSeconds: 1_200, cycle: null };
  const result = normalizePublicCycleStatus(legacy, 'mainnet');
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.executionState, 'unknown');
});

test('rejects a non-object value', () => {
  assert.throws(() => normalizePublicCycleStatus(null, 'mainnet'));
  assert.throws(() => normalizePublicCycleStatus('nope', 'mainnet'));
  assert.throws(() => normalizePublicCycleStatus([], 'mainnet'));
});
