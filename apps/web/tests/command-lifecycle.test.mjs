import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommandEnvelope,
  reservePendingCommand,
  PENDING_COMMAND_STORAGE_KEY,
  classifyDecisionOutcome,
  MAX_RECOVERY_ATTEMPTS,
  nextRecoveryDelayMs,
  parsePendingCommand,
  serializePendingCommand,
} from '../app/operator/command-lifecycle.mjs';

function receiptBody(commandState = 'APPLIED', requestId = 'request-1') {
  const code = commandState === 'APPLIED' ? 'DECISION_ACCEPTED' : `COMMAND_${commandState}`;
  return { commandState, code, receipt: {
    sequence: 2, eventId: 'event-2', requestId, commandDigest: `sha256:${'a'.repeat(64)}`,
    action: 'pause', observedVersion: 4, resultCode: code, commandState,
  } };
}

test('only matching durable receipts establish terminal command outcomes', () => {
  const classify = (status, body) => classifyDecisionOutcome({ status, body, requestId: 'request-1' });
  assert.equal(classify(200, receiptBody()).phase, 'success');
  assert.equal(classify(409, receiptBody('REJECTED')).phase, 'failure');
  assert.equal(classify(202, receiptBody('PREPARED')).phase, 'prepared');
  for (const [status, body] of [
    [200, null], [200, { code: 'DECISION_ACCEPTED' }],
    [200, receiptBody('APPLIED', 'different-request')],
    [401, { code: 'AUTH_REQUIRED' }], [403, { code: 'FORBIDDEN' }],
    [409, { code: 'AUDIT_REQUEST_CONFLICT' }], [503, null], [null, null],
    [200, { ...receiptBody(), receipt: { ...receiptBody().receipt, commandDigest: 'bad' } }],
  ]) assert.equal(classify(status, body).phase, 'uncertain');
});

test('exhausted and authentication-interrupted recovery preserves the same request against new submissions', () => {
  const entries = new Map();
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
  const original = buildCommandEnvelope({ requestId: 'request-1', expectedVersion: 4, command: { type: 'run-cycle-now' } });
  reservePendingCommand(storage, original);
  for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    assert.equal(classifyDecisionOutcome({ status: 401, body: { code: 'AUTH_REQUIRED' }, requestId: original.requestId }).phase, 'uncertain');
    reservePendingCommand(storage, original);
  }
  const later = buildCommandEnvelope({ requestId: 'request-2', expectedVersion: 5, command: { type: 'run-cycle-now' } });
  assert.throws(() => reservePendingCommand(storage, later), /unresolved command/);
  const recovered = parsePendingCommand(storage.getItem(PENDING_COMMAND_STORAGE_KEY));
  assert.deepEqual(recovered, original);
  reservePendingCommand(storage, recovered);
  assert.equal(classifyDecisionOutcome({ status: 200, body: receiptBody(), requestId: recovered.requestId }).phase, 'success');
  storage.removeItem(PENDING_COMMAND_STORAGE_KEY);
  assert.deepEqual(reservePendingCommand(storage, later), later);
});

test('serializes deterministic envelopes and rejects malformed pending commands', () => {
  const first = buildCommandEnvelope({
    requestId: 'request-1',
    expectedVersion: 4,
    command: { type: 'pause' },
    note: 'operator note',
  });
  const second = buildCommandEnvelope({
    requestId: 'request-1',
    expectedVersion: 4,
    command: { type: 'pause' },
    note: 'operator note',
  });
  assert.equal(serializePendingCommand(first), serializePendingCommand(second));
  assert.deepEqual(parsePendingCommand(serializePendingCommand(first)), first);
  for (const malformed of [
    '{',
    JSON.stringify({ requestId: '', expectedVersion: 1, command: { type: 'pause' } }),
    JSON.stringify({ requestId: 'bad space', expectedVersion: 1, command: { type: 'pause' } }),
    JSON.stringify({ requestId: 'ok', expectedVersion: 1.5, command: { type: 'pause' } }),
    JSON.stringify({ requestId: 'ok', expectedVersion: 1, command: [] }),
    JSON.stringify({ requestId: 'ok', expectedVersion: 1, command: {} }),
    JSON.stringify({ requestId: 'ok', expectedVersion: 1, command: { type: 'pause' }, note: 4 }),
  ]) assert.equal(parsePendingCommand(malformed), null);
});

test('uses bounded exponential recovery delays', () => {
  assert.equal(nextRecoveryDelayMs(0), 1000);
  assert.equal(nextRecoveryDelayMs(1), 2000);
  assert.equal(nextRecoveryDelayMs(3), 8000);
  assert.equal(nextRecoveryDelayMs(MAX_RECOVERY_ATTEMPTS), 15000);
  assert.equal(nextRecoveryDelayMs(MAX_RECOVERY_ATTEMPTS + 10), 15000);
});
