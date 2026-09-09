import assert from 'node:assert/strict';
import test from 'node:test';

import { assertBootstrap, assertDashboardResponse } from '../../src/contracts/operator-contracts.mjs';
import { buildBootstrap, buildDashboardReadModel } from '../../src/projections/operator-projection.mjs';

test('a terminal cycle state overrides an incomplete lifecycle stage and unavailable payout', () => {
  const dashboard = buildDashboardReadModel({
    authorityStatus: {
      revision: 3,
      configuration: null,
      activeCycleId: 'cycle-held',
      cycles: [{
        cycleId: 'cycle-held',
        terminalState: 'HELD_OWNER_DECISION',
        stages: [
          { stage: 'purchase', status: 'COMPLETE' },
          { stage: 'open', status: 'PREPARED' },
        ],
        payout: null,
      }],
      cap: { offChain24Hour: null, onChainRemainingCapacity: null },
      custody: { buckets: [] },
      alerts: [],
    },
    now: () => Date.UTC(2026, 0, 1),
  });

  assert.equal(dashboard.activeCycle.status, 'HELD_OWNER_DECISION');
  assert.equal(dashboard.payoutStatus, null);
});

test('dashboard projection preserves policy cap usage and safety telemetry availability', () => {
  const dashboard = buildDashboardReadModel({
    authorityStatus: {
      revision: 3,
      configuration: null,
      activeCycleId: null,
      cycles: [],
      cap: {
        offChain24Hour: null,
        loss: {
          realizedLossMicroUsd: '7',
          atRiskMicroUsd: '8',
          usedMicroUsd: '15',
          limitMicroUsd: '100',
          remainingMicroUsd: '85',
        },
        outstandingCustody: {
          usedMicroUsd: '19',
          limitMicroUsd: '100',
          remainingMicroUsd: '81',
        },
        onChainRemainingCapacity: null,
      },
      custody: { buckets: [] },
      alertSources: { safetyTelemetry: true },
      alerts: [],
    },
    now: () => Date.UTC(2026, 0, 1),
  });

  const validated = assertDashboardResponse(dashboard);

  assert.equal(validated.schemaVersion, 7);
  assert.equal(validated.cap.loss.usedMicroUsd, '15');
  assert.equal(validated.cap.outstandingCustody.usedMicroUsd, '19');
  assert.deepEqual(validated.alertSources, { safetyTelemetry: true });
});

test('dashboard contract continues to accept the prior cap-only response shape', () => {
  const legacy = buildDashboardReadModel({
    authorityStatus: {
      revision: 3,
      configuration: null,
      activeCycleId: null,
      cycles: [],
      cap: { offChain24Hour: null, onChainRemainingCapacity: null },
      custody: { buckets: [] },
      alerts: [],
    },
    now: () => Date.UTC(2026, 0, 1),
  });
  legacy.metrics = {
    cycleStartProjectPoolMicroUsdg: null, totalCycleFundingMicroUsdg: '0', totalCollectorSpendMicroUsdg: '0',
    totalBuybacksReturnedMicroUsdg: '0', totalBridgedBackMicroUsdg: '0', totalRewardsPaidMicroUsdg: '0',
    totalRewardsDeferredMicroUsdg: '0', totalQuotedOperatingCostsMicroUsdg: '0', latestRetainedReserveMicroUsdg: '0',
    latestCycleReserveTargetMicroUsdg: '0', completedCycles: 0, skippedCycles: 0, openedPacks: 0,
  };
  legacy.schemaVersion = 5;
  delete legacy.alertSources;
  delete legacy.cap.loss;
  delete legacy.cap.outstandingCustody;

  assert.equal(assertDashboardResponse(legacy).schemaVersion, 5);
});


test('bootstrap exposes the exact stored plan and deliberately accepts legacy payloads without one', () => {
  const packPlan = { schema: 'hookemon.pack-plan.v1', revision: 4, orders: [{ pack: 'base-pack', quantity: 3 }] };
  const bootstrap = buildBootstrap({ authorityStatus: { revision: 9, configuration: null }, identity: { subject: 'operator', email: null, role: 'operator' } });
  bootstrap.state.packPlan = packPlan;
  assert.equal(assertBootstrap(bootstrap).state.packPlan, packPlan);
  assert.throws(() => assertBootstrap({ ...bootstrap, state: { ...bootstrap.state, packPlan: { ...packPlan, revision: -1 } } }));
  const legacy = { ...bootstrap, state: { ...bootstrap.state } };
  delete legacy.state.packPlan;
  assert.equal(assertBootstrap(legacy), legacy);
});

test('saved recipient setting never replaces an active cycle frozen or historic selection', async () => {
  const { createDefaultOperatorConfiguration } = await import('../../../runner/src/config/state-schema.mjs');
  const configuration = { ...createDefaultOperatorConfiguration(), rewardRecipientLimit: 900, configurationRevision: 20 };
  const authorityStatus = { configuration, revision: 25, activeCycleId: 'frozen', cycles: [{ cycleId: 'frozen', rewardSelection: { rewardRecipientLimit: 300, configurationRevision: 4 }, stages: [] }] };
  const bootstrap = buildBootstrap({ authorityStatus, identity: { subject: 'operator', email: null, role: 'operator' } });
  assert.equal(bootstrap.state.rewardRecipientLimit, 900);
  assert.deepEqual(bootstrap.rewardRecipientLimits, [100,200,300,400,500,600,700,800,900,1000]);
  const selected = buildDashboardReadModel({ authorityStatus, now: () => 0 });
  assert.equal(selected.activeCycle.rewardRecipientLimit, 300);
  assert.equal(selected.activeCycle.configurationRevision, '4');
  delete authorityStatus.cycles[0].rewardSelection;
  const historic = buildDashboardReadModel({ authorityStatus, now: () => 0 });
  assert.equal(historic.activeCycle.rewardRecipientLimit, null);
  assert.equal(historic.activeCycle.configurationRevision, null);
});
