import assert from 'node:assert/strict';
import test from 'node:test';
import { readDashboardProfile } from '../lib/public-dashboard-profile.ts';
import { normalizePublicCycleStatus } from '../lib/public-cycle-status.ts';
import { normalizePublicCommunitySnapshot } from '../lib/public-community-snapshot.ts';
import { dashboardTiming, formatMicroUsdc, historyPresentation, latestPayout, payoutPresentation, processStep, safeCardImage, validateDashboardPair } from '../public/comic-production/dashboard.mjs';

const generatedAt = '2026-09-04T12:00:00.000Z';
const nextCycleAt = '2026-09-04T12:20:00.000Z';
const now = Date.parse(generatedAt);
const network = readDashboardProfile('testnet').network;
function fixture() {
  return {
    status: {
      schemaVersion: 3, profile: 'testnet', network: structuredClone(network), executionState: 'active',
      executionReason: null, generatedAt, nextCycleAt, countdownSeconds: 1200, cycle: null,
    },
    community: {
      schemaVersion: 4, profile: 'testnet', badge: 'TESTNET', network: structuredClone(network),
      historyComplete: false, generatedAt, nextCycleAt, delayed: false, poolObservedAt: null,
      metrics: {
        latestObservedProjectPoolMicroUsdc: null, totalCycleFundingMicroUsdc: '0', totalCollectorSpendMicroUsdc: '0',
        totalBuybacksReturnedMicroUsdc: '0', totalBridgedBackMicroUsdc: '0', totalRewardsPaidMicroUsdc: '0',
        totalRewardsDeferredMicroUsdc: '0', totalQuotedOperatingCostsMicroUsdc: '0', latestRetainedReserveMicroUsdc: '0',
        latestCycleReserveTargetMicroUsdc: '0', completedCycles: 0, skippedCycles: 0, openedPacks: 0,
      },
      latestCycle: null, cards: [],
    },
  };
}
function completeCycle() {
  return {
    cycleId: 'cycle-1', status: 'complete', selectedPackId: 'pack-1', maxBoostersPerCycle: 4,
    plannedBoosters: 1, openedBoosters: 1, actions: [{ type: 'packs-bought', status: 'complete', at: generatedAt }],
    cards: [{ productId: 'card-1', rarity: 'rare', nftAddress: null, cardName: 'Verified card', setName: null,
      cardNumber: null, imageUrl: 'https://images.example/card.png', packPriceMicroUsdc: '1000000', buybackMicroUsdc: '1200000' }],
    returnedMicroUsdc: '1200000', rewardStatus: 'complete', roundAccounting: null, paidMicroUsdc: '1000000',
  };
}

test('browser dashboard accepts canonical server output and keeps nullable observations intact', () => {
  const pair = fixture();
  pair.status.cycle = completeCycle();
  pair.community.cards = [{ cycleId: 'cycle-1', ...pair.status.cycle.cards[0] }];
  const canonical = {
    status: normalizePublicCycleStatus(pair.status),
    community: normalizePublicCommunitySnapshot(pair.community),
  };
  assert.deepEqual(validateDashboardPair(canonical.status, canonical.community), canonical);
  assert.equal(formatMicroUsdc(canonical.community.metrics.latestObservedProjectPoolMicroUsdc), '—');
  pair.community.schemaVersion = 5;
  pair.community.latestCycle = { cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: generatedAt,
    paidMicroUsdc: '1000000', payoutRecipientCount: 2, rewardRecipientLimit: 50, roundAccounting: null, transactions: [] };
  assert.throws(() => validateDashboardPair(pair.status, pair.community), /PUBLIC_DASHBOARD_INVALID/);
});

test('malformed, unknown, mixed-network, and legacy payloads never become dashboard facts', () => {
  const mutations = [
    (pair) => { delete pair.community.metrics.openedPacks; },
    (pair) => { pair.community.metrics.totalRewardsPaidMicroUsdc = '01'; },
    (pair) => { pair.community.metrics.totalRewardsPaidMicroUsdc = -1; },
    (pair) => { pair.community.metrics.totalRewardsPaidMicroUsdg = '1'; },
    (pair) => { pair.status.network.ethereum.chainId = 1; },
    (pair) => { pair.status.network.evm = pair.status.network.ethereum; },
    (pair) => { pair.community.profile = 'mainnet'; },
    (pair) => { pair.community.network.solana.genesisHash = 'wrong-chain'; },
    (pair) => { pair.status.schemaVersion = 2; },
    (pair) => { pair.status.countdownSeconds = 1199; },
    (pair) => { pair.status.executionState = 'paused'; },
    (pair) => { pair.community.poolObservedAt = generatedAt; },
    (pair) => { pair.community.generatedAt = 'September 4, 2026'; },
    (pair) => { pair.community.cards = [null]; },
  ];
  for (const mutate of mutations) {
    const pair = fixture(); mutate(pair);
    assert.throws(() => validateDashboardPair(pair.status, pair.community), /PUBLIC_DASHBOARD_INVALID/);
  }
});

test('untrusted card metadata remains data and image URLs cannot execute code or contain credentials', () => {
  const pair = fixture();
  pair.status.cycle = completeCycle();
  pair.status.cycle.cards[0].cardName = '<img src=x onerror=alert(1)>';
  assert.doesNotThrow(() => validateDashboardPair(pair.status, pair.community));
  for (const imageUrl of ['javascript:alert(1)', 'http://images.example/card.png', 'https://user:secret@images.example/card.png']) {
    pair.status.cycle.cards[0].imageUrl = imageUrl;
    assert.equal(safeCardImage(imageUrl), null);
    assert.throws(() => validateDashboardPair(pair.status, pair.community), /PUBLIC_DASHBOARD_INVALID/);
  }
  assert.equal(safeCardImage('https://images.example/card.png'), 'https://images.example/card.png');
});

test('money stays exact beyond Number precision and averages round down to one micro-USDC', () => {
  const paid = '900719925474099312345678';
  const payout = latestPayout({ status: 'complete', paidMicroUsdc: paid, payoutRecipientCount: 3, roundAccounting: null });
  assert.equal(payout.average, '300239975158033104115226');
  assert.equal(formatMicroUsdc(payout.average), '300,239,975,158,033,104.115226 USDC');
  assert.equal(latestPayout({ status: 'complete', paidMicroUsdc: '1000000', payoutRecipientCount: 3 }).average, '333333');
  assert.equal(formatMicroUsdc('0'), '0 USDC');
  for (const value of [null, undefined, '01', '1e6', '-1', 1000000]) assert.equal(formatMicroUsdc(value), '—');
});

test('averages require a completed distribution and actual recipients, not allocation limits', () => {
  const cycle = { status: 'complete', paidMicroUsdc: '1000000', payoutRecipientCount: 2, rewardRecipientLimit: 50 };
  assert.equal(latestPayout(cycle).average, '500000');
  for (const patch of [{ status: 'running' }, { paidMicroUsdc: null }, { payoutRecipientCount: 0 },
    { payoutRecipientCount: undefined }, { payoutRecipientCount: 1.5 },
    { roundAccounting: { plannedHolderRewardsMicroUsdc: '1000000', paidHolderRewardsMicroUsdc: null, distributionStatus: 'pending' } },
    { roundAccounting: { paidHolderRewardsMicroUsdc: '999999', distributionStatus: 'reconciled' } }]) {
    assert.equal(latestPayout({ ...cycle, ...patch }), null);
  }
  assert.equal(latestPayout({ ...cycle, paidMicroUsdc: null, roundAccounting: {
    paidHolderRewardsMicroUsdc: '1000000', distributionStatus: 'reconciled',
  } }).average, '500000');
});

test('historical totals require complete verified history rather than placeholder zeros or partial sums', () => {
  const pair = fixture();
  const empty = { totalPaid: '—', completedCycles: '—', skippedCycles: '—', openedPacks: '—' };
  assert.deepEqual(historyPresentation(null), { ...empty, note: 'Awaiting verified history' });
  assert.deepEqual(historyPresentation(pair.community), { ...empty, note: 'Verified history is incomplete' });
  pair.community.metrics.totalRewardsPaidMicroUsdc = '900719925474099312345678';
  pair.community.metrics.completedCycles = 1200;
  pair.community.metrics.skippedCycles = 15;
  pair.community.metrics.openedPacks = 4500;
  assert.deepEqual(historyPresentation(pair.community), { ...empty, note: 'Verified history is incomplete' });
  pair.community.historyComplete = true;
  validateDashboardPair(pair.status, pair.community);
  assert.deepEqual(historyPresentation(pair.community), {
    totalPaid: '900,719,925,474,099,312.345678 USDC', completedCycles: '1,200', skippedCycles: '15',
    openedPacks: '4,500', note: 'Complete verified cycle history',
  });
});

test('verified zero activity and delayed historical observations retain their distinct meaning', () => {
  const pair = fixture();
  pair.community.historyComplete = true;
  const result = historyPresentation(pair.community);
  assert.equal(result.totalPaid, '0 USDC');
  assert.equal(result.completedCycles, '0');
  assert.equal(result.skippedCycles, '0');
  assert.equal(result.openedPacks, '0');
  pair.community.delayed = true;
  assert.deepEqual(historyPresentation(pair.community), result);
  assert.equal(dashboardTiming(pair, now).delayed, true);
  assert.equal(dashboardTiming(pair, now).countdown, '--:--');
});

test('payout notes distinguish missing history from the latest cycle still awaiting distribution', () => {
  const { community } = fixture();
  assert.equal(payoutPresentation(null).note, 'Awaiting verified payout data');
  assert.equal(payoutPresentation(community).note, 'Payout history not reported');
  community.latestCycle = { status: 'running', paidMicroUsdc: null, payoutRecipientCount: 0 };
  assert.deepEqual(payoutPresentation(community), { payout: null, note: 'Latest cycle has no completed payout' });
  community.latestCycle = { status: 'complete', paidMicroUsdc: '1000000', payoutRecipientCount: 2 };
  assert.equal(payoutPresentation(community).note, 'Completed holder distribution');
  assert.equal(payoutPresentation(community).payout.average, '500000');
  community.latestCycle = null;
  community.historyComplete = true;
  assert.deepEqual(payoutPresentation(community), { payout: null, note: 'No completed payout reported' });
});

test('countdown stops for stale, paused, unknown, failed, expired, or inconsistent schedules', () => {
  const pair = fixture();
  assert.equal(dashboardTiming(pair, now + 1000).countdown, '19:59');
  assert.equal(dashboardTiming(pair, now + 90_001).delayed, true);
  assert.equal(dashboardTiming(pair, now + 90_001).countdown, '--:--');
  assert.equal(dashboardTiming(pair, now, true).countdown, '--:--');
  assert.equal(dashboardTiming(pair, now - 6000).countdown, '--:--');
  for (const executionState of ['paused', 'unknown']) {
    assert.equal(dashboardTiming({ ...pair, status: { ...pair.status, executionState } }, now).countdown, '--:--');
  }
  assert.match(dashboardTiming({ ...pair, status: { ...pair.status, executionState: 'paused' } }, now).note, /paused/);
  assert.equal(dashboardTiming({ ...pair, community: { ...pair.community, nextCycleAt: generatedAt } }, now).countdown, '--:--');
  assert.equal(dashboardTiming({ ...pair, status: { ...pair.status, nextCycleAt: generatedAt } }, now).countdown, '--:--');
  assert.equal(dashboardTiming(null, now).countdown, '--:--');
});

test('old pool observations mark the feed delayed before the next poll', () => {
  const pair = fixture();
  pair.community.poolObservedAt = '2026-09-04T11:58:40.000Z';
  pair.community.metrics.latestObservedProjectPoolMicroUsdc = '1000000';
  validateDashboardPair(pair.status, pair.community);
  assert.equal(dashboardTiming(pair, now).delayed, false);
  assert.equal(dashboardTiming(pair, now + 11_000).delayed, true);
  pair.community.poolObservedAt = '2026-09-04T11:58:00.000Z';
  assert.throws(() => validateDashboardPair(pair.status, pair.community), /PUBLIC_DASHBOARD_INVALID/);
  pair.community.delayed = true;
  assert.doesNotThrow(() => validateDashboardPair(pair.status, pair.community));
});

test('process indicators preserve failed and deferred evidence and do not infer actions', () => {
  const status = fixture().status;
  assert.deepEqual(processStep('cards', status), { state: 'waiting', amount: '—' });
  status.cycle = completeCycle();
  assert.equal(processStep('cards', status).state, 'complete');
  assert.equal(processStep('fees', status).state, 'waiting');
  status.cycle.rewardStatus = 'payout-deferred';
  assert.equal(processStep('holders', status).state, 'deferred');
  status.cycle.actions.push({ type: 'rewards-complete', status: 'failed', at: generatedAt });
  assert.equal(processStep('holders', status).state, 'failed');
  status.executionState = 'paused';
  assert.equal(processStep('fees', status).state, 'paused');
});
