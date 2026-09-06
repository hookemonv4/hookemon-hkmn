import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommunityDashboardHandler, createCycleStatusHandler } from '../../src/routes/public.mjs';

async function request(handler) {
  let status = null;
  const chunks = [];
  await handler(
    { method: 'GET', url: '/public/api/cycle-status' },
    {
      writeHead(nextStatus) { status = nextStatus; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); },
    },
  );
  return { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

test('public cycle status reports a held terminal state instead of an earlier completed stage', async () => {
  const handler = createCycleStatusHandler({
    profileId: 'mainnet',
    now: () => Date.UTC(2026, 0, 1),
    operatorControl: {
      async status() {
        return {
          configuration: { intervalMinutes: 20, maxBoostersPerCycle: 1, paused: false, executionPaused: false, killSwitch: false },
          activeCycleId: 'cycle-held',
          cycles: [{
            cycleId: 'cycle-held',
            terminalState: 'HELD_OWNER_DECISION',
            stages: [{ stage: 'purchase', status: 'COMPLETE' }],
          }],
        };
      },
    },
  });

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.equal(result.body.cycle.status, 'HELD_OWNER_DECISION');
});

function cycleStatusCtx(overrides = {}) {
  return {
    profileId: 'mainnet',
    now: () => Date.UTC(2026, 0, 1),
    operatorControl: {
      async status() {
        return {
          configuration: { intervalMinutes: 20, maxBoostersPerCycle: 1, paused: false, executionPaused: false, killSwitch: false },
          activeCycleId: null,
          cycles: [],
        };
      },
    },
    ...overrides,
  };
}

test('a real getSchedulerView reaches the public cycle-status response verbatim', async () => {
  const schedulerView = {
    nextCycleAt: '2026-01-01T00:20:00.000Z', nextReconcileAt: null,
    automationEnabled: true, paused: false, pendingReason: null,
  };
  const handler = createCycleStatusHandler(cycleStatusCtx({ getSchedulerView: () => schedulerView }));

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.scheduler, schedulerView);
});

test('a throwing getSchedulerView degrades to the conservative fallback instead of a 503', async () => {
  const handler = createCycleStatusHandler(cycleStatusCtx({
    getSchedulerView: () => { throw new Error('scheduler unavailable'); },
    onError: () => {},
  }));

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.equal(result.body.scheduler.automationEnabled, true);
});

test('public projections expose only the held reason, age, and cycle state after the attributed cycle completes', async () => {
  const heldPosition = {
    positionId: 'position-1',
    cycleId: 'cycle-complete',
    reason: 'EPIC_THRESHOLD',
    openedAtMs: Date.UTC(2025, 11, 31, 23, 58),
    terminalState: 'OPEN',
    memo: 'private-provider-memo',
    mint: 'PrivateMintIdentity',
    cardRef: 'private-card-reference',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    insuredValue: { chainId: 'solana', assetId: 'usdg', decimals: 6, amountAtomic: '400' },
    costMicroUsdg: '100',
  };
  const status = async () => ({
    configuration: { intervalMinutes: 20, maxBoostersPerCycle: 1, paused: false, executionPaused: false, killSwitch: false },
    activeCycleId: null,
    cycles: [{ cycleId: 'cycle-complete', terminalState: 'COMPLETE', stages: [{ stage: 'payout', status: 'COMPLETE' }] }],
    heldPositions: [heldPosition],
  });
  const ctx = { profileId: 'mainnet', now: () => Date.UTC(2026, 0, 1), operatorControl: { status } };

  const cycleStatus = await request(createCycleStatusHandler(ctx));
  const community = await request(createCommunityDashboardHandler(ctx));

  for (const body of [cycleStatus.body, community.body]) {
    assert.equal(body.heldPositionCount, 1);
    assert.deepEqual(body.heldPositions, [{
      reason: 'EPIC_THRESHOLD',
      ageSeconds: 120,
      cycleState: 'COMPLETE',
    }]);
    assert.doesNotMatch(JSON.stringify(body.heldPositions), /position-1|cycle-complete/i);
    assert.doesNotMatch(JSON.stringify(body), /memo|mint|cardRef|evidenceDigest|insuredValue|costMicroUsdg/i);
  }
});

test('the public community projection reports a complete main cycle as paid out while held positions remain separate', async () => {
  const handler = createCommunityDashboardHandler({
    profileId: 'mainnet',
    now: () => Date.UTC(2026, 0, 1),
    operatorControl: {
      async status() {
        return {
          configuration: { intervalMinutes: 20, maxBoostersPerCycle: 1, paused: false, executionPaused: false, killSwitch: false },
          activeCycleId: null,
          cycles: [{ cycleId: 'cycle-complete', terminalState: 'COMPLETE', stages: [{ stage: 'payout', status: 'COMPLETE' }] }],
          heldPositions: [],
        };
      },
    },
  });

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.equal(result.body.latestCycle.status, 'paid-out');
});

function communityCtx(overrides = {}) {
  return {
    profileId: 'mainnet',
    now: () => Date.UTC(2026, 0, 1),
    operatorControl: {
      async status() {
        return {
          configuration: { intervalMinutes: 20, maxBoostersPerCycle: 1, paused: false, executionPaused: false, killSwitch: false },
          activeCycleId: null,
          cycles: [],
          heldPositions: [],
        };
      },
    },
    ...overrides,
  };
}

test('the public community projection carries real recent-winners cards through verbatim', async () => {
  const card = {
    cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, memo: 'hookemon-cycle-1', mint: null,
    eventId: 'evt-1', sequence: '0000000001', state: 'observed',
    name: 'Ember Chick', imageUrl: null, observedAt: '2026-01-01T00:00:00.000Z',
    finalizedAt: null, transactionId: null, proceeds: null,
  };
  const handler = createCommunityDashboardHandler(communityCtx({
    listRecentWinners: async ({ limit }) => { assert.equal(limit, 12); return [card]; },
  }));

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.cards, [card]);
});

test('a failing listRecentWinners degrades to an empty card feed instead of a 503 (provider feed failure must not stop the route)', async () => {
  const handler = createCommunityDashboardHandler(communityCtx({
    listRecentWinners: async () => { throw new Error('provider outage'); },
    onError: () => {},
  }));

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.cards, []);
});
