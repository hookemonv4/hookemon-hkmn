import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCycleAccounting } from '../../src/app/accounting-projection.mjs';
import { buildPublicCycleStatus } from '../../../dashboard/src/projections/cycle-status-projection.mjs';
import { buildPublicCommunitySnapshot } from '../../../dashboard/src/projections/community-snapshot-projection.mjs';
import { normalizePublicCycleStatus } from '../../../../apps/web/lib/public-cycle-status.ts';
import { normalizePublicCommunitySnapshot } from '../../../../apps/web/lib/public-community-snapshot.ts';
import { validateDashboardPair, latestPayout, processStep } from '../../../../apps/web/public/comic-production/dashboard.mjs';

const now = '2026-09-08T12:00:00.000Z';
async function accounting() {
  return projectCycleAccounting({ cycleId: 'native-1', cycleRepository: {
    describeCycle: async () => ({ releaseAmount: '1234567890123456789', admission: { schema: 'hookemon.policy-admission.v3' }, relayLegs: new Map() }),
    readStage: async () => null,
  } });
}

test('native wei never enters a historical pack-spend scalar and round contract crosses both public readers', async () => {
  const round = await accounting();
  assert.equal(round.releaseAmount.units, '1234567890123456789');
  assert.equal(round.packSpendMicroUsd, null);
  assert.equal(Object.hasOwn(round, 'packSpendMicroUsdg'), false);
  const status = buildPublicCycleStatus({ profileId: 'mainnet', internalStatus: {
    generatedAt: now, intervalMinutes: 20, paused: true, nextRunAt: null,
    activeCycle: { cycleId: 'native-1', stage: 'funding', accounting: round }, heldPositions: [],
  } });
  assert.equal(status.schemaVersion, 7);
  assert.deepEqual(normalizePublicCycleStatus(status, 'mainnet'), status);
  const community = await buildPublicCommunitySnapshot({ profileId: 'mainnet', repositoryCycles: [{ cycleId: 'native-1', terminalState: 'COMPLETE' }], generatedAt: now, readAccounting: async () => round });
  assert.equal(community.schemaVersion, 9);
  assert.deepEqual(normalizePublicCommunitySnapshot(community, 'mainnet'), community);
  assert.equal(community.metrics.totalRewardsPaidWei, null);
  assert.deepEqual(validateDashboardPair(status, community), { status, community });
  assert.equal(processStep('return', status).amount, 'Not confirmed');
  for (const change of [
    value => { value.cycle.roundAccounting.paidHolderRewardsMicroUsdg = '1'; },
    value => { value.cycle.roundAccounting.releaseAmount.decimals = 6; },
    value => { value.cycle.roundAccounting.releaseAmount.assetId = '0x0000000000000000000000000000000000000000'; },
    value => { value.cycle.roundAccounting.paidHolderRewardsWei = 1; },
    value => { delete value.cycle.roundAccounting.schema; },
    value => { value.releaseAmount = value.cycle.roundAccounting.releaseAmount; },
    value => { value.schema = 'hookemon.native-round-accounting.v1'; },
    value => { value.cycle.roundAccounting.packGainMicroUsd = '2'; value.cycle.roundAccounting.packLossMicroUsd = '3'; },
  ]) {
    const invalid = structuredClone(status); change(invalid);
    assert.throws(() => normalizePublicCycleStatus(invalid));
  }
});

test('production comic computes native payout average in wei without rounding to six decimals', async () => {
  const round = await accounting();
  const payout = latestPayout({ status: 'complete', payoutRecipientCount: 2, paidWei: '3', roundAccounting: { ...round, paidHolderRewardsWei: '3', distributionStatus: 'settled' } });
  assert.deepEqual(payout, { unit: 'ETH', paid: '3', recipients: 2, average: '1' });
});

test('native payout conservation keeps rejected recipients as liabilities and requires the trusted identity', async () => {
  const amount = amountAtomic => ({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic });
  const recipient = '0x2222222222222222222222222222222222222222';
  const evidence = {
    schema: 'hookemon.direct-payout-result.v2', cycleId: 'native-1',
    distributablePool: amount('10'), totalAllocated: amount('7'), dust: amount('3'),
    recipients: [{ recipient, state: 'REFUSED', amount: amount('7') }],
    quarantine: [{ recipient, amount: amount('7') }],
  };
  const project = (record, trustedPayoutContext) => projectCycleAccounting({ cycleId: 'native-1', trustedPayoutContext,
    cycleRepository: {
      describeCycle: async () => ({ releaseAmount: '10', admission: { schema: 'hookemon.policy-admission.v3' }, relayLegs: new Map() }),
      readStage: async (_, stage) => stage === 'payout' ? { status: 'COMPLETE', evidence: record } : null,
    },
  });
  const trusted = { nativeAsset: { chainId: '4663', assetId: 'native', decimals: 18 }, operationsAddress: '0x1111111111111111111111111111111111111111' };
  const round = await project(evidence, trusted);
  assert.equal(round.paidHolderRewardsWei, '0');
  assert.equal(round.payoutLiabilityWei, '7');
  assert.equal(round.payoutDustWei, '3');
  assert.equal(round.paidHolderRewardsRecipientCount, 0);
  assert.equal(round.holderRewardsStatus, 'paid-with-liabilities');
  assert.equal((await project(evidence, null)).paidHolderRewardsWei, null);
  for (const edit of [
    record => { record.dust.amountAtomic = '4'; },
    record => { record.recipients.push(record.recipients[0]); },
    record => { record.recipients[0].state = 'FINALIZED'; },
    record => { record.distributablePool.decimals = 6; },
  ]) {
    const invalid = structuredClone(evidence); edit(invalid);
    assert.equal((await project(invalid, trusted)).paidHolderRewardsWei, null);
  }
});
