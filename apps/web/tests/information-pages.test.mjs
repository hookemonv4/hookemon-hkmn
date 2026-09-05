import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readDashboardProfile } from '../lib/public-dashboard-profile.ts';
import { cycleRecord } from '../public/comic-production/information-pages.mjs';

function fixture() {
  const network = readDashboardProfile('testnet').network;
  const generatedAt = '2026-09-04T12:00:00.000Z';
  const nextCycleAt = '2026-09-04T12:20:00.000Z';
  return {
    status: { schemaVersion: 3, profile: 'testnet', network, executionState: 'active', executionReason: null,
      generatedAt, nextCycleAt, countdownSeconds: 1200, cycle: null },
    community: { schemaVersion: 4, profile: 'testnet', badge: 'TESTNET', network, historyComplete: false,
      generatedAt, nextCycleAt, delayed: false, poolObservedAt: null,
      metrics: { latestObservedProjectPoolMicroUsdc: null, totalCycleFundingMicroUsdc: '0',
        totalCollectorSpendMicroUsdc: '0', totalBuybacksReturnedMicroUsdc: '0', totalBridgedBackMicroUsdc: '0',
        totalRewardsPaidMicroUsdc: '0', totalRewardsDeferredMicroUsdc: '0', totalQuotedOperatingCostsMicroUsdc: '0',
        latestRetainedReserveMicroUsdc: '0', latestCycleReserveTargetMicroUsdc: '0',
        completedCycles: 0, skippedCycles: 0, openedPacks: 0 }, latestCycle: null, cards: [] },
  };
}
test('incomplete history and missing accounting stay unavailable', () => {
  const { status, community } = fixture();
  const model = cycleRecord(status, community);
  assert.equal(model.count, '—');
  assert.equal(model.pool, '—');
  assert.ok(model.breakdown.every(([, value]) => value === '—'));
  assert.match(model.feed, /TESTNET.*Delayed/);
});
test('partial payout is never presented as a completed payment', () => {
  const { status, community } = fixture();
  community.latestCycle = { cycleId: 'cycle-1', status: 'pending', reason: null, updatedAt: community.generatedAt,
    paidMicroUsdc: '500000', payoutRecipientCount: 2, roundAccounting: null, transactions: [] };
  assert.equal(cycleRecord(status, community).paid, '—');
  community.latestCycle.status = 'complete';
  assert.equal(cycleRecord(status, community).paid, '0.5 USDC');
});
test('transaction links use the validated chain and profile', () => {
  const { status, community } = fixture();
  const id = '0x' + 'ab'.repeat(32);
  community.latestCycle = { cycleId: 'cycle-1', status: 'complete', reason: null, updatedAt: community.generatedAt,
    paidMicroUsdc: null, payoutRecipientCount: 0, roundAccounting: null,
    transactions: [{ chain: 'ethereum', purpose: 'reward-settlement', id }] };
  assert.equal(cycleRecord(status, community).transactions[0].url, 'https://sepolia.etherscan.io/tx/' + id);
  community.latestCycle.transactions[0].id = 'javascript:alert(1)';
  assert.throws(() => cycleRecord(status, community), /PUBLIC_DASHBOARD_INVALID/);
});
test('cross-network observations are rejected before presentation', () => {
  const { status, community } = fixture();
  community.network = { ...community.network, ethereum: { ...community.network.ethereum, chainId: 4663 } };
  assert.throws(() => cycleRecord(status, community), /PUBLIC_DASHBOARD_INVALID/);
});
test('information page import does not start the homepage dashboard poller', async () => {
  let touched = false;
  globalThis.document = {
    body: { hasAttribute: (name) => name === 'data-information-page' },
    getElementById() { touched = true; throw new Error('Unexpected dashboard polling'); },
  };
  try {
    await import('../public/comic-production/dashboard.mjs?information-page-test');
    assert.equal(touched, false);
  } finally { delete globalThis.document; }
});
test('subpages expose accessible disclosure controls and approved brand assets', async () => {
  for (const page of ['cycles', 'holders', 'transparency']) {
    const html = await readFile(new URL('../public/comic-production/' + page + '.html', import.meta.url), 'utf8');
    assert.match(html, /<details/);
    assert.match(html, /<summary/);
    assert.match(html, /href="#main"/);
    assert.match(html, /hookemon-logo.svg/);
    assert.match(html, new RegExp('href="/' + page + '" aria-current="page"'));
    assert.doesNotMatch(html, /0x[0-9a-fA-F]{40}/);
  }
});
