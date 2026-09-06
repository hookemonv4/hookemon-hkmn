import assert from 'node:assert/strict';
import test from 'node:test';
import { readDashboardProfile } from '../lib/public-dashboard-profile.ts';
import { normalizePublicCycleStatus } from '../lib/public-cycle-status.ts';
import { normalizePublicCommunitySnapshot } from '../lib/public-community-snapshot.ts';
import { dashboardTiming, formatMicroUsdg, historyPresentation, humanizeSchedulerReason, latestPayout, normalizePublicCycleHistory, payoutPresentation, presentCard, processStep, safeCardImage, validateDashboardPair } from '../public/comic-production/dashboard.mjs';

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
        latestObservedProjectPoolMicroUsdg: null, totalCycleFundingMicroUsdg: '0', totalCollectorSpendMicroUsdg: '0',
        totalBuybacksReturnedMicroUsdg: '0', totalBridgedBackMicroUsdg: '0', totalRewardsPaidMicroUsdg: '0',
        totalRewardsDeferredMicroUsdg: '0', totalQuotedOperatingCostsMicroUsdg: '0', latestRetainedReserveMicroUsdg: '0',
        latestCycleReserveTargetMicroUsdg: '0', completedCycles: 0, skippedCycles: 0, openedPacks: 0,
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
      cardNumber: null, imageUrl: 'https://images.example/card.png', packPriceMicroUsdg: '1000000', buybackMicroUsdg: '1200000' }],
    returnedMicroUsdg: '1200000', rewardStatus: 'complete', roundAccounting: null, paidMicroUsdg: '1000000',
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
  assert.equal(formatMicroUsdg(canonical.community.metrics.latestObservedProjectPoolMicroUsdg), '—');
});

test('browser dashboard accepts the current backend schemaVersion 5 with a reward recipient limit', () => {
  const pair = fixture();
  pair.status.cycle = completeCycle();
  pair.community.cards = [{ cycleId: 'cycle-1', ...pair.status.cycle.cards[0] }];
  pair.community.schemaVersion = 5;
  pair.community.latestCycle = {
    cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: generatedAt,
    paidMicroUsdg: '1000000', payoutRecipientCount: 2, rewardRecipientLimit: 50,
    roundAccounting: null, transactions: [],
  };
  const canonical = {
    status: normalizePublicCycleStatus(pair.status),
    community: normalizePublicCommunitySnapshot(pair.community),
  };
  assert.deepEqual(validateDashboardPair(canonical.status, canonical.community), canonical);
  assert.equal(canonical.community.schemaVersion, 5);
  assert.equal(canonical.community.latestCycle.rewardRecipientLimit, 50);
});

test('malformed, unknown, mixed-network, and legacy payloads never become dashboard facts', () => {
  const mutations = [
    (pair) => { delete pair.community.metrics.openedPacks; },
    (pair) => { pair.community.metrics.totalRewardsPaidMicroUsdg = '01'; },
    (pair) => { pair.community.metrics.totalRewardsPaidMicroUsdg = -1; },
    (pair) => { pair.community.metrics.totalRewardsPaidMicroUsdg = 1; },
    (pair) => { pair.status.network.evm.chainId = 1; },
    (pair) => { pair.status.network.legacyNetwork = pair.status.network.evm; },
    (pair) => { pair.community.profile = 'mainnet'; },
    (pair) => { pair.community.network.solana.genesisHash = 'wrong-chain'; },
    (pair) => { pair.status.schemaVersion = 2; },
    (pair) => { pair.status.countdownSeconds = 1199; },
    (pair) => { pair.status.executionState = 'paused'; },
    (pair) => { pair.community.poolObservedAt = generatedAt; },
    (pair) => { pair.community.generatedAt = 'September 4, 2026'; },
    (pair) => { pair.community.cards = [null]; },
    (pair) => { pair.community.schemaVersion = 6; },
    (pair) => {
      pair.community.schemaVersion = 5;
      pair.community.latestCycle = {
        cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: generatedAt,
        paidMicroUsdg: '1000000', payoutRecipientCount: 2,
        roundAccounting: null, transactions: [],
      };
    },
    (pair) => {
      pair.community.latestCycle = {
        cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: generatedAt,
        paidMicroUsdg: '1000000', payoutRecipientCount: 2, rewardRecipientLimit: 50,
        roundAccounting: null, transactions: [],
      };
    },
    (pair) => {
      pair.community.schemaVersion = 5;
      pair.community.latestCycle = {
        cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: generatedAt,
        paidMicroUsdg: '1000000', payoutRecipientCount: 2, rewardRecipientLimit: 75,
        roundAccounting: null, transactions: [],
      };
    },
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
  for (const imageUrl of ['javascript:alert(1)', 'http://images.example/card.png', 'https://-@images.invalid/card.png']) {
    pair.status.cycle.cards[0].imageUrl = imageUrl;
    assert.equal(safeCardImage(imageUrl), null);
    assert.throws(() => validateDashboardPair(pair.status, pair.community), /PUBLIC_DASHBOARD_INVALID/);
  }
  assert.equal(safeCardImage('https://images.example/card.png'), 'https://images.example/card.png');
});

test('money stays exact beyond Number precision and averages round down to one micro-USDG', () => {
  const paid = '900719925474099312345678';
  const payout = latestPayout({ status: 'complete', paidMicroUsdg: paid, payoutRecipientCount: 3, roundAccounting: null });
  assert.equal(payout.average, '300239975158033104115226');
  assert.equal(formatMicroUsdg(payout.average), '300,239,975,158,033,104.115226 USDG');
  assert.equal(latestPayout({ status: 'complete', paidMicroUsdg: '1000000', payoutRecipientCount: 3 }).average, '333333');
  assert.equal(formatMicroUsdg('0'), '0 USDG');
  for (const value of [null, undefined, '01', '1e6', '-1', 1000000]) assert.equal(formatMicroUsdg(value), '—');
});

test('averages require a completed distribution and actual recipients, not allocation limits', () => {
  const cycle = { status: 'complete', paidMicroUsdg: '1000000', payoutRecipientCount: 2, rewardRecipientLimit: 50 };
  assert.equal(latestPayout(cycle).average, '500000');
  for (const patch of [{ status: 'running' }, { paidMicroUsdg: null }, { payoutRecipientCount: 0 },
    { payoutRecipientCount: undefined }, { payoutRecipientCount: 1.5 },
    { roundAccounting: { plannedHolderRewardsMicroUsdg: '1000000', paidHolderRewardsMicroUsdg: null, distributionStatus: 'pending' } },
    { roundAccounting: { paidHolderRewardsMicroUsdg: '999999', distributionStatus: 'reconciled' } }]) {
    assert.equal(latestPayout({ ...cycle, ...patch }), null);
  }
  assert.equal(latestPayout({ ...cycle, paidMicroUsdg: null, roundAccounting: {
    paidHolderRewardsMicroUsdg: '1000000', distributionStatus: 'reconciled',
  } }).average, '500000');
});

test('historical totals require complete verified history rather than placeholder zeros or partial sums', () => {
  const pair = fixture();
  const empty = { totalPaid: '—', completedCycles: '—', skippedCycles: '—', openedPacks: '—' };
  assert.deepEqual(historyPresentation(null), { ...empty, note: 'Awaiting verified history' });
  assert.deepEqual(historyPresentation(pair.community), { ...empty, note: 'Verified history is incomplete' });
  pair.community.metrics.totalRewardsPaidMicroUsdg = '900719925474099312345678';
  pair.community.metrics.completedCycles = 1200;
  pair.community.metrics.skippedCycles = 15;
  pair.community.metrics.openedPacks = 4500;
  assert.deepEqual(historyPresentation(pair.community), { ...empty, note: 'Verified history is incomplete' });
  pair.community.historyComplete = true;
  validateDashboardPair(pair.status, pair.community);
  assert.deepEqual(historyPresentation(pair.community), {
    totalPaid: '900,719,925,474,099,312.345678 USDG', completedCycles: '1,200', skippedCycles: '15',
    openedPacks: '4,500', note: 'Complete verified cycle history',
  });
});

test('verified zero activity and delayed historical observations retain their distinct meaning', () => {
  const pair = fixture();
  pair.community.historyComplete = true;
  const result = historyPresentation(pair.community);
  assert.equal(result.totalPaid, '0 USDG');
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
  community.latestCycle = { status: 'running', paidMicroUsdg: null, payoutRecipientCount: 0 };
  assert.deepEqual(payoutPresentation(community), { payout: null, note: 'Latest cycle has no completed payout' });
  community.latestCycle = { status: 'complete', paidMicroUsdg: '1000000', payoutRecipientCount: 2 };
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
  pair.community.metrics.latestObservedProjectPoolMicroUsdg = '1000000';
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

function schemaVersion6And8Fixture() {
  return {
    status: {
      schemaVersion: 6, profile: 'testnet', network: structuredClone(network), executionState: 'active',
      executionReason: null, generatedAt, nextCycleAt, countdownSeconds: 1200, cycle: null,
      heldPositionCount: 1,
      heldPositions: [{ reason: 'AWAITING_BUYBACK_WINDOW', ageSeconds: 30, cycleState: 'opened' }],
      scheduler: { nextCycleAt, nextReconcileAt: null, automationEnabled: true, paused: false, pendingReason: null },
    },
    community: {
      schemaVersion: 8, profile: 'testnet', badge: 'TESTNET', network: structuredClone(network),
      historyComplete: false, generatedAt, nextCycleAt, delayed: false, poolObservedAt: null,
      metrics: {
        latestObservedProjectPoolMicroUsdg: null, totalCycleFundingMicroUsdg: '0', totalCollectorSpendMicroUsdg: '0',
        totalBuybacksReturnedMicroUsdg: '0', totalBridgedBackMicroUsdg: '0', totalRewardsPaidMicroUsdg: '0',
        totalRewardsDeferredMicroUsdg: '0', totalQuotedOperatingCostsMicroUsdg: '0', latestRetainedReserveMicroUsdg: '0',
        latestCycleReserveTargetMicroUsdg: '0', completedCycles: 0, skippedCycles: 0, openedPacks: 0,
      },
      latestCycle: null, cards: [],
      heldPositionCount: 1,
      heldPositions: [{ reason: 'AWAITING_BUYBACK_WINDOW', ageSeconds: 30, cycleState: 'opened' }],
    },
  };
}

test('browser dashboard accepts the real backend schemaVersion 6/8 pair with scheduler, held positions, and typed nullable accounting', () => {
  const pair = schemaVersion6And8Fixture();
  pair.community.cards = [{
    cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, memo: 'memo-1', mint: null,
    eventId: 'evt-1', sequence: '1', state: 'finalized', name: 'Pikachu',
    imageUrl: 'https://images.example/pikachu.png',
    observedAt: '2026-09-04T11:58:00.000Z', finalizedAt: '2026-09-04T11:59:00.000Z', transactionId: null,
    proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '8000000', decimals: 6 },
  }];
  const canonical = {
    status: normalizePublicCycleStatus(pair.status, 'testnet'),
    community: normalizePublicCommunitySnapshot(pair.community, 'testnet'),
  };
  const validated = validateDashboardPair(canonical.status, canonical.community);
  assert.deepEqual(validated, canonical);
  assert.equal(validated.status.scheduler.nextReconcileAt, null);

  const display = presentCard(validated.community.cards[0]);
  assert.equal(display.label, 'Pikachu');
  assert.equal(display.detailLine, 'Proceeds: 8 spl:usdc-mint');
});

test('standalone dashboard.mjs validates real bridge amounts, payout-liability facts, and nullable lifetime metrics at schemaVersion 8', () => {
  const pair = schemaVersion6And8Fixture();
  const typedAccounting = {
    packSpendMicroUsdg: null, buybackMicroUsdg: null,
    outboundBridgeDebit: { chainId: 'eip155:4663', assetId: 'USDG', units: '5000000', decimals: 6 },
    inboundBridgeProceeds: null,
    collectorPurchaseDebit: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', units: '10000000', decimals: 6 },
    collectorBuybackProceeds: null,
    packGainMicroUsdg: null, packLossMicroUsdg: null,
    quotedCosts: {
      outboundBridgeMicroUsdg: null, inboundBridgeMicroUsdg: null, collectorApiMicroUsdg: null,
      evmNetworkMicroUsdg: null, solanaNetworkMicroUsdg: null, slippageMicroUsdg: null,
    },
    protectedCostsMicroUsdg: null, confirmedCostsMicroUsdg: null,
    cycleGainMicroUsdg: null, cycleLossMicroUsdg: null,
    walletBalanceBeforeMicroUsdg: null, walletBalanceAfterMicroUsdg: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdg: null, feeReserveTargetMicroUsdg: null, feeReserveTopUpMicroUsdg: null,
    feeReserveAfterMicroUsdg: null, plannedHolderRewardsMicroUsdg: null, paidHolderRewardsMicroUsdg: null,
    payoutLiabilityMicroUsdg: '1200000', payoutDustMicroUsdg: '0', paidHolderRewardsRecipientCount: null,
    holderRewardsStatus: 'awaiting-verification', distributionStatus: 'pending',
  };
  pair.community.metrics.skippedCycles = null;
  pair.community.metrics.openedPacks = null;
  pair.community.metrics.totalRewardsPaidMicroUsdg = null;
  pair.community.latestCycle = {
    cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: generatedAt,
    paidMicroUsdg: null, payoutRecipientCount: null, rewardRecipientLimit: null,
    roundAccounting: typedAccounting, transactions: [],
  };
  const canonical = {
    status: normalizePublicCycleStatus(pair.status, 'testnet'),
    community: normalizePublicCommunitySnapshot(pair.community, 'testnet'),
  };
  const validated = validateDashboardPair(canonical.status, canonical.community);
  assert.deepEqual(validated.community.latestCycle.roundAccounting.outboundBridgeDebit, typedAccounting.outboundBridgeDebit);
  assert.equal(validated.community.latestCycle.roundAccounting.payoutLiabilityMicroUsdg, '1200000');
  assert.equal(validated.community.latestCycle.payoutRecipientCount, null);
  assert.equal(validated.community.latestCycle.rewardRecipientLimit, null);
  assert.equal(validated.community.metrics.skippedCycles, null);
  assert.equal(validated.community.metrics.totalRewardsPaidMicroUsdg, null);
});

test('dashboardTiming shows a reconcile wakeup distinctly from a cycle wakeup, and humanizes a pending reason', () => {
  const pair = schemaVersion6And8Fixture();
  pair.status.scheduler = {
    nextCycleAt: null, nextReconcileAt: '2026-09-04T12:00:05.000Z',
    automationEnabled: true, paused: false, pendingReason: 'RECONCILING_PENDING_TRANSACTION',
  };
  const canonical = {
    status: normalizePublicCycleStatus(pair.status, 'testnet'),
    community: normalizePublicCommunitySnapshot(pair.community, 'testnet'),
  };
  // pendingReason takes priority over a raw wakeup countdown -- it is the more specific fact.
  const timing = dashboardTiming(validateDashboardPair(canonical.status, canonical.community), now);
  assert.equal(timing.countdown, '--:--');
  assert.equal(timing.note, humanizeSchedulerReason('RECONCILING_PENDING_TRANSACTION'));
  assert.equal(timing.note, 'Reconciling a pending transaction');
});

test('dashboardTiming counts down to nextReconcileAt when no pendingReason blocks it', () => {
  const pair = schemaVersion6And8Fixture();
  pair.status.scheduler = {
    nextCycleAt: null, nextReconcileAt: '2026-09-04T12:00:05.000Z',
    automationEnabled: true, paused: false, pendingReason: null,
  };
  const canonical = {
    status: normalizePublicCycleStatus(pair.status, 'testnet'),
    community: normalizePublicCommunitySnapshot(pair.community, 'testnet'),
  };
  const timing = dashboardTiming(validateDashboardPair(canonical.status, canonical.community), now);
  assert.equal(timing.countdown, '00:05');
  assert.match(timing.note, /^Reconciling/);
});

function historyPage(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: 'testnet',
    network,
    generatedAt: '2026-09-06T12:00:00.000Z',
    asOf: '2026-09-06T11:59:55.000Z',
    historyComplete: true,
    items: [
      { cycleId: 'cycle-2', status: 'complete', terminalAt: '2026-09-06T11:00:00.000Z', updatedAt: '2026-09-06T11:00:01.000Z' },
      { cycleId: 'cycle-1', status: 'complete', terminalAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:01.000Z' },
    ],
    nextCursor: null,
    ...overrides,
  };
}

test('standalone dashboard.mjs normalizePublicCycleHistory accepts a real page and rejects out-of-order or fail-open shapes', () => {
  const page = historyPage();
  assert.deepEqual(normalizePublicCycleHistory(page), page);
  assert.deepEqual(normalizePublicCycleHistory(page, 'testnet'), page);
  assert.throws(() => normalizePublicCycleHistory(page, 'mainnet'), /PUBLIC_CYCLE_HISTORY_INVALID/);

  const outOfOrder = historyPage({
    items: [
      { cycleId: 'cycle-1', status: 'complete', terminalAt: '2026-09-06T10:00:00.000Z', updatedAt: null },
      { cycleId: 'cycle-2', status: 'complete', terminalAt: '2026-09-06T11:00:00.000Z', updatedAt: null },
    ],
  });
  assert.throws(() => normalizePublicCycleHistory(outOfOrder), /PUBLIC_CYCLE_HISTORY_INVALID/);

  const incompleteWithItems = historyPage({ historyComplete: false });
  assert.throws(() => normalizePublicCycleHistory(incompleteWithItems), /PUBLIC_CYCLE_HISTORY_INVALID/);

  const incompleteEmpty = historyPage({ historyComplete: false, items: [], nextCursor: null });
  assert.deepEqual(normalizePublicCycleHistory(incompleteEmpty), incompleteEmpty);

  // historyComplete: true can never coexist with a null terminalAt anywhere in items -- the
  // producer's own all-or-nothing rule fails the whole page closed instead.
  const fakeComplete = historyPage({
    items: [{ cycleId: 'cycle-3', status: 'awaiting-terminal-timestamp', terminalAt: null, updatedAt: null }],
  });
  assert.throws(() => normalizePublicCycleHistory(fakeComplete), /PUBLIC_CYCLE_HISTORY_INVALID/);
});

test('presentCard never shows a not-yet-finalized card event as if it had proceeds', () => {
  const pending = presentCard({
    cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, memo: null, mint: null,
    eventId: 'evt-1', sequence: '1', state: 'observed', name: null, imageUrl: null,
    observedAt: '2026-09-04T11:58:00.000Z', finalizedAt: null, transactionId: null, proceeds: null,
  });
  assert.equal(pending.label, 'op-1');
  assert.equal(pending.detailLine, 'Not yet sold');
});
