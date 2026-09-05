import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDashboardResponse } from '../../src/contracts/operator-contracts.mjs';
import { buildDashboardReadModel } from '../../src/projections/operator-projection.mjs';

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
          realizedLossMicroUsdg: '7',
          atRiskMicroUsdg: '8',
          usedMicroUsdg: '15',
          limitMicroUsdg: '100',
          remainingMicroUsdg: '85',
        },
        outstandingCustody: {
          usedMicroUsdg: '19',
          limitMicroUsdg: '100',
          remainingMicroUsdg: '81',
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

  assert.equal(validated.schemaVersion, 6);
  assert.equal(validated.cap.loss.usedMicroUsdg, '15');
  assert.equal(validated.cap.outstandingCustody.usedMicroUsdg, '19');
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
  legacy.schemaVersion = 5;
  delete legacy.alertSources;
  delete legacy.cap.loss;
  delete legacy.cap.outstandingCustody;

  assert.equal(assertDashboardResponse(legacy).schemaVersion, 5);
});
