import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyDecision, OperatorControlUnavailable } from '../../src/projections/decision-application.mjs';

test('applyDecision maps a pause request to one authority execution', async () => {
  const calls = [];
  const result = await applyDecision({
    expectedVersion: 4,
    command: { type: 'pause' },
    operatorControl: {
      async execute(input) {
        calls.push(input);
        return { action: 'pause', revision: 5 };
      },
    },
  });
  assert.deepEqual(calls, [{ expectedRevision: 4, command: { type: 'pause' } }]);
  assert.deepEqual(result, { action: 'pause', revision: 5 });
});

test('applyDecision forwards reconcile as one authority request without adding a recovery effect', async () => {
  const calls = [];
  await applyDecision({
    expectedVersion: 5,
    command: { type: 'reconcile' },
    operatorControl: { async execute(input) { calls.push(input); return { action: 'reconcile', revision: 5 }; } },
  });
  assert.deepEqual(calls, [{ expectedRevision: 5, command: { type: 'reconcile' } }]);
});

test('applyDecision preserves manual approval cycle identity and digest', async () => {
  const calls = [];
  const command = { type: 'manual-approval', cycleId: 'cycle-1', cycleDigest: `sha256:${'a'.repeat(64)}` };
  await applyDecision({
    expectedVersion: 6,
    command,
    operatorControl: { async execute(input) { calls.push(input); return { action: 'manual-approval', revision: 7 }; } },
  });
  assert.deepEqual(calls, [{ expectedRevision: 6, command }]);
});

test('applyDecision passes its durable request ID to a held owner decision', async () => {
  const calls = [];
  const command = {
    type: 'held-owner-decision',
    cycleId: 'cycle-1',
    heldEvidenceDigest: `sha256:${'c'.repeat(64)}`,
    expectedCycleRevision: 2,
    choice: 'sell',
  };
  await applyDecision({
    requestId: 'held-owner-request-1',
    expectedVersion: 7,
    command,
    operatorControl: { async execute(input) { calls.push(input); return { action: 'held-owner-decision', revision: 7 }; } },
  });
  assert.deepEqual(calls, [{ expectedRevision: 7, requestId: 'held-owner-request-1', command }]);
});

test('applyDecision refuses to emulate a missing operator authority', async () => {
  await assert.rejects(
    applyDecision({ expectedVersion: 0, command: { type: 'pause' }, operatorControl: null }),
    OperatorControlUnavailable,
  );
});
