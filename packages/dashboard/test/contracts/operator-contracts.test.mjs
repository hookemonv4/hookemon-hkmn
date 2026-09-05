import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAuditResponse,
  ContractValidationError,
  DECISION_TYPES,
  readDecisionRequest,
} from '../../src/contracts/operator-contracts.mjs';

test('DECISION_TYPES exposes only commands with a control authority effect', () => {
  for (const type of ['pause', 'resume', 'kill', 'manual-approval', 'held-owner-decision', 'run-cycle-now', 'resume-cycle', 'reconcile', 'update-configuration']) {
    assert.ok(DECISION_TYPES.includes(type), `missing decision type ${type}`);
  }
  assert.equal(DECISION_TYPES.includes('skip-next-cycle'), false);
  assert.equal(DECISION_TYPES.includes('accept-degraded-return'), false);
});

test('reads a resume decision and maps a legacy activate request to the same authority command', () => {
  const resume = readDecisionRequest({ requestId: 'resume-1', expectedVersion: 3, command: { type: 'resume' } });
  const activate = readDecisionRequest({ requestId: 'activate-1', expectedVersion: 3, command: { type: 'activate' } });
  assert.equal(resume.command.type, 'resume');
  assert.deepEqual(activate.command, { type: 'resume' });
});

test('reads a digest-bound manual approval', () => {
  const result = readDecisionRequest({
    requestId: 'approval-1',
    expectedVersion: 3,
    command: {
      type: 'manual-approval',
      cycleId: 'cycle-42',
      cycleDigest: `sha256:${'a'.repeat(64)}`,
    },
  });
  assert.deepEqual(result.command, {
    type: 'manual-approval',
    cycleId: 'cycle-42',
    cycleDigest: `sha256:${'a'.repeat(64)}`,
  });
});

test('reads a held owner decision bound to the held evidence and cycle revision', () => {
  const result = readDecisionRequest({
    requestId: 'held-decision-1',
    expectedVersion: 3,
    command: {
      type: 'held-owner-decision',
      cycleId: 'cycle-42',
      heldEvidenceDigest: `sha256:${'b'.repeat(64)}`,
      expectedCycleRevision: 9,
      choice: 'keep-holding',
    },
  });
  assert.deepEqual(result.command, {
    type: 'held-owner-decision',
    cycleId: 'cycle-42',
    heldEvidenceDigest: `sha256:${'b'.repeat(64)}`,
    expectedCycleRevision: 9,
    choice: 'keep-holding',
  });
});

test('reads an update-configuration patch without granting pause or kill fields', () => {
  const result = readDecisionRequest({
    requestId: 'config-1',
    expectedVersion: 3,
    command: {
      type: 'update-configuration',
      configuration: { intervalMinutes: 30, maxCyclesPerDay: 2, lossCapMicroUsdg: '200' },
    },
  });
  assert.deepEqual(result.command.configuration, { intervalMinutes: 30, maxCyclesPerDay: 2, lossCapMicroUsdg: '200' });
  assert.throws(() => readDecisionRequest({
    requestId: 'config-kill', expectedVersion: 3,
    command: { type: 'update-configuration', configuration: { killSwitch: false } },
  }), ContractValidationError);
});

test('maps recovery aliases only to real authority commands', () => {
  const restart = readDecisionRequest({ requestId: 'restart-1', expectedVersion: 3, command: { type: 'restart-request' } });
  const reconcile = readDecisionRequest({ requestId: 'reconcile-1', expectedVersion: 3, command: { type: 'reconcile-request' } });
  assert.deepEqual(restart.command, { type: 'resume-cycle' });
  assert.deepEqual(reconcile.command, { type: 'reconcile' });
});

test('rejects audit-only commands', () => {
  for (const type of ['skip-next-cycle', 'accept-degraded-return']) {
    assert.throws(() => readDecisionRequest({ requestId: `reject-${type}`, expectedVersion: 0, command: { type } }), ContractValidationError);
  }
});

test('rejects a malformed requestId and an extra envelope key', () => {
  assert.throws(() => readDecisionRequest({ requestId: '', expectedVersion: 0, command: { type: 'pause' } }), ContractValidationError);
  assert.throws(() => readDecisionRequest({ requestId: 'r', expectedVersion: 0, command: { type: 'pause' }, bogus: true }), ContractValidationError);
});

test('audit responses expose the persisted request receipt fields', () => {
  const response = assertAuditResponse({
    decisions: [{
      sequence: '1',
      eventId: 'event-1',
      occurredAt: new Date(2026, 0, 1).toISOString(),
      actor: { email: 'operator-console' },
      actorRole: 'operator',
      action: 'pause',
      outcome: 'accepted',
      resultCode: 'COMMAND_DISPATCHED',
      observedVersion: 3,
      note: null,
      requestId: 'request-1',
      commandDigest: `sha256:${'b'.repeat(64)}`,
    }],
    nextCursor: null,
  });
  assert.equal(response.decisions[0].requestId, 'request-1');
});
