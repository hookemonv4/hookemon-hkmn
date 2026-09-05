import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectCycleStatus } from '../../../runner/src/observability/status-projection.mjs';
import { buildPublicCycleStatus } from '../../src/projections/cycle-status-projection.mjs';
import { createDefaultOperatorConfiguration, applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';

test('an unconfigured (fresh) operator projects executionState unknown', async () => {
  const internalStatus = await projectCycleStatus({ activeCycleId: null, terminalCycles: [], configuration: null, now: Date.parse('2026-01-01T00:00:00.000Z') });
  const status = buildPublicCycleStatus({ profileId: 'testnet', internalStatus, configuration: null });
  assert.equal(status.executionState, 'unknown');
  assert.equal(status.executionReason, null);
  assert.equal(status.cycle, null);
});

test('a paused, configured operator projects executionState paused with a synthesized nextCycleAt', async () => {
  const configuration = applyOperatorConfiguration(null, { paused: true, intervalMinutes: 25 });
  const internalStatus = await projectCycleStatus({
    activeCycleId: null, terminalCycles: [], configuration, now: Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const status = buildPublicCycleStatus({ profileId: 'testnet', internalStatus, configuration });
  assert.equal(status.executionState, 'paused');
  assert.equal(status.executionReason, 'operator-paused');
  assert.equal(status.nextCycleAt, new Date(Date.parse('2026-01-01T00:00:00.000Z') + 25 * 60_000).toISOString());
  assert.equal(status.countdownSeconds, 25 * 60);
});

test('an active operator with an in-flight cycle reports a conservative cycle (no fabricated cards/accounting)', async () => {
  const configuration = createDefaultOperatorConfiguration();
  const readStage = async (cycleId, stage) => (stage === 'funding' ? { status: 'COMPLETE' } : null);
  const internalStatus = await projectCycleStatus({
    activeCycleId: 'cycle-1', readStage, terminalCycles: [], configuration, now: Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const status = buildPublicCycleStatus({ profileId: 'testnet', internalStatus, configuration });
  assert.equal(status.cycle.cycleId, 'cycle-1');
  assert.equal(status.cycle.roundAccounting, null);
  assert.deepEqual(status.cycle.cards, []);
  assert.deepEqual(status.cycle.actions, []);
  assert.equal(status.cycle.openedBoosters, 0);
});

const FIXTURE_ACCOUNTING = Object.freeze({
  packSpendMicroUsdg: '5000000',
  buybackMicroUsdg: '0',
  packGainMicroUsdg: '0',
  packLossMicroUsdg: '5000000',
  quotedCosts: Object.freeze({
    outboundBridgeMicroUsdg: '5000',
    inboundBridgeMicroUsdg: null,
    collectorApiMicroUsdg: null,
    evmNetworkMicroUsdg: null,
    solanaNetworkMicroUsdg: null,
    slippageMicroUsdg: null,
  }),
  protectedCostsMicroUsdg: null,
  confirmedCostsMicroUsdg: null,
  cycleGainMicroUsdg: null,
  cycleLossMicroUsdg: null,
  walletBalanceBeforeMicroUsdg: null,
  walletBalanceAfterMicroUsdg: null,
  networkFees: Object.freeze({ walletLamportsCharged: null, purchase: null, buyback: null }),
  feeReserveBeforeMicroUsdg: null,
  feeReserveTargetMicroUsdg: null,
  feeReserveTopUpMicroUsdg: null,
  feeReserveAfterMicroUsdg: null,
  plannedHolderRewardsMicroUsdg: null,
  paidHolderRewardsMicroUsdg: null,
  holderRewardsStatus: 'not-started',
  distributionStatus: 'not-started',
});

test('when projectCycleStatus was given a readAccounting seam, the real per-cycle accounting reaches roundAccounting and passes the exact website validator', async () => {
  const configuration = createDefaultOperatorConfiguration();
  const readStage = async (cycleId, stage) => (stage === 'funding' ? { status: 'COMPLETE' } : null);
  const internalStatus = await projectCycleStatus({
    activeCycleId: 'cycle-1',
    readStage,
    readAccounting: async cycleId => (cycleId === 'cycle-1' ? FIXTURE_ACCOUNTING : null),
    terminalCycles: [],
    configuration,
    now: Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const status = buildPublicCycleStatus({ profileId: 'testnet', internalStatus, configuration });
  assert.deepEqual(status.cycle.roundAccounting, FIXTURE_ACCOUNTING);
  assert.equal(status.cycle.rewardStatus, 'not-started');
});
