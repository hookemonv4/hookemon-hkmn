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

test('keeps identifier-bearing held positions in schema version 4 while schema version 5 exposes only public status fields', () => {
  const legacyHeld = {
    ...idleStatus(),
    schemaVersion: 4,
    heldPositionCount: 1,
    heldPositions: [{
      positionId: 'position-1', cycleId: 'cycle-1', reason: 'EPIC_THRESHOLD', ageSeconds: 60, cycleState: 'COMPLETE',
    }],
  };
  const publicHeld = {
    ...idleStatus(),
    schemaVersion: 5,
    heldPositionCount: 1,
    heldPositions: [{ reason: 'EPIC_THRESHOLD', ageSeconds: 60, cycleState: 'COMPLETE' }],
  };

  assert.equal(normalizePublicCycleStatus(legacyHeld, 'mainnet').heldPositions[0].positionId, 'position-1');
  assert.deepEqual(normalizePublicCycleStatus(publicHeld, 'mainnet').heldPositions, publicHeld.heldPositions);
  assert.throws(() => normalizePublicCycleStatus({
    ...publicHeld,
    heldPositions: [{ ...publicHeld.heldPositions[0], positionId: 'position-1' }],
  }, 'mainnet'));
});

test('rejects a non-object value', () => {
  assert.throws(() => normalizePublicCycleStatus(null, 'mainnet'));
  assert.throws(() => normalizePublicCycleStatus('nope', 'mainnet'));
  assert.throws(() => normalizePublicCycleStatus([], 'mainnet'));
});

function v6RoundAccounting(overrides = {}) {
  return {
    packSpendMicroUsdg: null,
    buybackMicroUsdg: null,
    outboundBridgeDebit: null,
    inboundBridgeProceeds: null,
    collectorPurchaseDebit: null,
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
    payoutLiabilityMicroUsdg: null, payoutDustMicroUsdg: null, paidHolderRewardsRecipientCount: null,
    holderRewardsStatus: 'pending', distributionStatus: 'pending',
    ...overrides,
  };
}

function v6Status() {
  return {
    ...idleStatus(),
    schemaVersion: 6,
    heldPositionCount: 0,
    heldPositions: [],
    scheduler: {
      nextCycleAt: null, nextReconcileAt: null, automationEnabled: false, paused: false, pendingReason: null,
    },
  };
}

test('schemaVersion 6 accepts an unknown (null) packSpend/buyback instead of an invented zero', () => {
  const input = v6Status();
  input.cycle = {
    cycleId: 'cycle-1', status: 'purchase-pending', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: v6RoundAccounting(),
  };
  const result = normalizePublicCycleStatus(input, 'mainnet');
  assert.equal(result.schemaVersion, 6);
  assert.equal(result.cycle.roundAccounting.packSpendMicroUsdg, null);
  assert.equal(result.cycle.roundAccounting.buybackMicroUsdg, null);
  assert.equal(result.cycle.roundAccounting.packGainMicroUsdg, null);
});

test('schemaVersion 6 keeps the EVM bridge debit and the real Collector-side (Solana) debit as two distinct typed Amount fields, never folded into packSpendMicroUsdg', () => {
  const input = v6Status();
  input.cycle = {
    cycleId: 'cycle-1', status: 'settled', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: v6RoundAccounting({
      outboundBridgeDebit: { chainId: '4663', assetId: '0xusdg', units: '50', decimals: 6 }, // real EVM USDG bridge debit
      collectorPurchaseDebit: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '49', decimals: 6 }, // distinct real Solana debit
    }),
  };
  const result = normalizePublicCycleStatus(input, 'mainnet');
  // packSpendMicroUsdg has no honest same-asset USDG pack-economics producer, so it stays null even
  // though a bridge debit and a Collector debit both exist.
  assert.equal(result.cycle.roundAccounting.packSpendMicroUsdg, null);
  assert.equal(result.cycle.roundAccounting.packGainMicroUsdg, null);
  assert.deepEqual(result.cycle.roundAccounting.outboundBridgeDebit, {
    chainId: '4663', assetId: '0xusdg', units: '50', decimals: 6,
  });
  assert.deepEqual(result.cycle.roundAccounting.collectorPurchaseDebit, {
    chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '49', decimals: 6,
  });
});

test('schemaVersion 6 rejects a malformed typed Amount (never silently drops it to null)', () => {
  const input = v6Status();
  input.cycle = {
    cycleId: 'cycle-1', status: 'settled', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: v6RoundAccounting({
      collectorPurchaseDebit: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '-1', decimals: 6 },
    }),
  };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test('schemaVersion 6 projects real finalized payout evidence into paid/planned/liability/dust/count', () => {
  const input = v6Status();
  input.cycle = {
    cycleId: 'cycle-1', status: 'settled', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: v6RoundAccounting({
      plannedHolderRewardsMicroUsdg: '100',
      paidHolderRewardsMicroUsdg: '70',
      payoutLiabilityMicroUsdg: '30',
      payoutDustMicroUsdg: '0',
      paidHolderRewardsRecipientCount: 2,
      holderRewardsStatus: 'paid-with-liabilities',
    }),
  };
  const result = normalizePublicCycleStatus(input, 'mainnet');
  const accounting = result.cycle.roundAccounting;
  assert.equal(accounting.plannedHolderRewardsMicroUsdg, '100');
  assert.equal(accounting.paidHolderRewardsMicroUsdg, '70');
  assert.equal(accounting.payoutLiabilityMicroUsdg, '30');
  assert.equal(accounting.paidHolderRewardsRecipientCount, 2);
  assert.equal(accounting.holderRewardsStatus, 'paid-with-liabilities');
});

test('schemaVersion 6 rejects a negative paidHolderRewardsRecipientCount', () => {
  const input = v6Status();
  input.cycle = {
    cycleId: 'cycle-1', status: 'settled', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: v6RoundAccounting({ paidHolderRewardsRecipientCount: -1 }),
  };
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test('schemaVersion 6 carries the real SchedulerView verbatim, with mutually-consistent next-wakeup fields', () => {
  const input = v6Status();
  input.scheduler = {
    nextCycleAt: null,
    nextReconcileAt: '2026-01-01T00:00:05.000Z',
    automationEnabled: true,
    paused: false,
    pendingReason: 'RECONCILING_PENDING_TRANSACTION',
  };
  const result = normalizePublicCycleStatus(input, 'mainnet');
  assert.deepEqual(result.scheduler, input.scheduler);
});

test('schemaVersion 6 rejects a scheduler missing a required field', () => {
  const input = v6Status();
  delete input.scheduler.pendingReason;
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test('schemaVersion 3-5 do not require or accept a scheduler field', () => {
  const input = idleStatus();
  assert.equal(Object.hasOwn(normalizePublicCycleStatus(input, 'mainnet'), 'scheduler'), false);
  assert.throws(() => normalizePublicCycleStatus({ ...input, scheduler: v6Status().scheduler }, 'mainnet'), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test('schemaVersion 3-5 still require packSpend/buyback as non-null money (unchanged legacy shape)', () => {
  const input = idleStatus();
  input.cycle = {
    cycleId: 'cycle-1', status: 'x', selectedPackId: null, maxBoostersPerCycle: null,
    plannedBoosters: 1, openedBoosters: 0, actions: [], cards: [], returnedMicroUsdg: null, rewardStatus: null,
    roundAccounting: {
      packSpendMicroUsdg: null, buybackMicroUsdg: '1', packGainMicroUsdg: '0', packLossMicroUsdg: '0',
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
  assert.throws(() => normalizePublicCycleStatus(input, 'mainnet'), /PUBLIC_CYCLE_STATUS_INVALID/);
});
