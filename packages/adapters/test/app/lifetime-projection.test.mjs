import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { projectLifetimeTotals } from '../../src/app/lifetime-projection.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';

async function repositoryFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-lifetime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return CycleRepository.open(directory, (() => {
    let now = 1_000;
    return () => now++;
  })());
}

async function completeThrough(repository, cycleId, lastStage, evidence) {
  const last = OPERATIONAL_CYCLE_STAGES.indexOf(lastStage);
  for (const stage of OPERATIONAL_CYCLE_STAGES.slice(0, last + 1)) {
    if ((await repository.readStage(cycleId, stage)).status === 'COMPLETE') continue;
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, evidence?.[stage] ?? (stage === lastStage ? evidence : { seeded: stage }));
  }
}

test('lifetime projection reports an empty durable repository without fabricated totals', async t => {
  const repository = await repositoryFor(t);
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async () => ({}),
    now: () => 1_000,
  });
  assert.equal(projection.cyclesScanned, 0);
  assert.equal(projection.terminalCycles, 0);
  assert.equal(projection.counts.openedPacks, null);
  assert.equal(projection.totals.totalRewardsPaidMicroUsdg, null);
});

test('lifetime projection keeps active opened evidence visible and excludes it from terminal totals', async t => {
  const repository = await repositoryFor(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'rehearsal' });
  await completeThrough(repository, cycleId, 'open', {
    packs: [
      { packIndex: 0, decision: 'opened' },
      { packIndex: 1, decision: 'held' },
    ],
  });
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async () => ({}),
  });
  assert.equal(projection.terminalCycles, 0);
  assert.equal(projection.perCycle[0].openedPacks, 1);
  assert.equal(projection.counts.completedCycles, 0);
});

test('lifetime projection identifies a non-held terminal cycle that never purchased', async t => {
  const repository = await repositoryFor(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'rehearsal' });
  await completeThrough(repository, cycleId, 'payout', { seeded: 'payout' });
  await repository.completeCycle(cycleId);
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async () => ({}),
  });
  assert.equal(projection.terminalCycles, 1);
  assert.equal(projection.counts.skippedCycles, 1);
  assert.equal(projection.completeness.skippedCycles, true);
});

test('lifetime projection sums complete terminal accounting and opened evidence', async t => {
  const repository = await repositoryFor(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '10', mode: 'rehearsal' });
  await completeThrough(repository, cycleId, 'payout', {
    purchase: { packs: [{ packIndex: 0, status: 'purchased' }] },
    open: { packs: [{ packIndex: 0, decision: 'opened' }, { packIndex: 1, outcome: 'opened' }] },
    payout: { seeded: 'payout' },
  });
  await repository.completeCycle(cycleId);
  const accounting = {
    inboundBridgeProceeds: { chainId: '4663', assetId: 'usdg', decimals: 6, units: '12' },
    paidHolderRewardsMicroUsdg: '7',
    payoutLiabilityMicroUsdg: '3',
    quotedCosts: {
      outboundBridgeMicroUsdg: '1',
      inboundBridgeMicroUsdg: '2',
      collectorApiMicroUsdg: '3',
      evmNetworkMicroUsdg: '4',
      solanaNetworkMicroUsdg: '5',
      slippageMicroUsdg: '6',
    },
    feeReserveAfterMicroUsdg: '8',
    feeReserveTargetMicroUsdg: '9',
  };
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async () => accounting,
  });
  assert.equal(projection.counts.openedPacks, 2);
  assert.equal(projection.totals.totalBridgedBackMicroUsdg, '12');
  assert.equal(projection.totals.totalRewardsPaidMicroUsdg, '7');
  assert.equal(projection.totals.totalRewardsDeferredMicroUsdg, '3');
  assert.equal(projection.totals.totalQuotedOperatingCostsMicroUsdg, '21');
  assert.equal(projection.totals.latestRetainedReserveMicroUsdg, '8');
  assert.equal(projection.totals.latestCycleReserveTargetMicroUsdg, '9');
  assert.equal(projection.completeness.totalRewardsPaidMicroUsdg, true);
});

test('lifetime projection keeps payout totals incomplete when finalized payout evidence is absent', async t => {
  const repository = await repositoryFor(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '10', mode: 'rehearsal' });
  await completeThrough(repository, cycleId, 'payout', {
    packs: [{ packIndex: 0, status: 'purchased' }],
  });
  await repository.completeCycle(cycleId);
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async () => ({
      paidHolderRewardsMicroUsdg: null,
      payoutLiabilityMicroUsdg: null,
      inboundBridgeProceeds: { chainId: '4663', assetId: 'usdg', decimals: 6, units: '12' },
    }),
  });
  assert.equal(projection.totals.totalBridgedBackMicroUsdg, '12');
  assert.equal(projection.completeness.totalBridgedBackMicroUsdg, true);
  assert.equal(projection.totals.totalRewardsPaidMicroUsdg, null);
  assert.equal(projection.completeness.totalRewardsPaidMicroUsdg, false);
  assert.equal(projection.totals.totalRewardsDeferredMicroUsdg, null);
  assert.equal(projection.completeness.totalRewardsDeferredMicroUsdg, false);
});

test('lifetime projection uses native wei fields for native accounting cycles', async t => {
  const repository = await repositoryFor(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '100', mode: 'rehearsal' });
  await completeThrough(repository, cycleId, 'payout', {
    purchase: { packs: [{ packIndex: 0, status: 'purchased' }] },
    open: { packs: [{ packIndex: 0, decision: 'opened' }] },
    payout: { seeded: 'payout' },
  });
  await repository.completeCycle(cycleId);
  const accounting = {
    schema: 'hookemon.native-round-accounting.v1',
    releaseAmount: { chainId: '4663', assetId: 'native', decimals: 18, units: '100' },
    inboundBridgeProceeds: { chainId: '4663', assetId: 'native', decimals: 18, units: '80' },
    paidHolderRewardsWei: '70',
    payoutLiabilityWei: '10',
    feeReserveAfterWei: null,
    feeReserveTargetWei: null,
  };
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async () => accounting,
  });
  assert.equal(projection.units, 'wei');
  assert.equal(projection.totals.totalCycleFundingWei, '100');
  assert.equal(projection.totals.totalBridgedBackWei, '80');
  assert.equal(projection.totals.totalRewardsPaidWei, '70');
  assert.equal(projection.totals.totalRewardsDeferredWei, '10');
  assert.equal(projection.totals.totalCollectorSpendMicroUsd, null);
  assert.equal(projection.completeness.totalCycleFundingWei, true);
  assert.equal(projection.completeness.totalRewardsPaidWei, true);
  assert.equal(projection.completeness.totalCollectorSpendMicroUsd, false);
});

test('lifetime projection refuses to sum mixed native and historical units', async t => {
  const repository = await repositoryFor(t);
  const first = await repository.createCycle({ releaseAmount: '10', mode: 'rehearsal' });
  await completeThrough(repository, first.cycleId, 'payout', { packs: [{ packIndex: 0, status: 'purchased' }] });
  await repository.completeCycle(first.cycleId);
  const second = await repository.createCycle({ releaseAmount: '20', mode: 'rehearsal' });
  await completeThrough(repository, second.cycleId, 'payout', { packs: [{ packIndex: 0, status: 'purchased' }] });
  await repository.completeCycle(second.cycleId);
  const projection = await projectLifetimeTotals({
    cycleRepository: repository,
    cycleIds: await repository.listKnownCycleIds(),
    readAccounting: async cycleId => cycleId === first.cycleId
      ? { packSpendMicroUsdg: '10', paidHolderRewardsMicroUsdg: '5', payoutLiabilityMicroUsdg: '0' }
      : {
        schema: 'hookemon.native-round-accounting.v1',
        releaseAmount: { chainId: '4663', assetId: 'native', decimals: 18, units: '20' },
        inboundBridgeProceeds: { chainId: '4663', assetId: 'native', decimals: 18, units: '18' },
        paidHolderRewardsWei: '18',
        payoutLiabilityWei: '0',
      },
  });
  assert.equal(projection.units, 'mixed');
  for (const field of ['totalCycleFundingMicroUsdg', 'totalCycleFundingWei', 'totalRewardsPaidMicroUsdg', 'totalRewardsPaidWei']) {
    assert.equal(projection.totals[field], null);
    assert.equal(projection.completeness[field], false);
  }
});
