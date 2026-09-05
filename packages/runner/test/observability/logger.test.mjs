// Unit coverage for observability/logger.mjs: fixed-schema JSON lines, level routing to
// stdout/stderr, and the two domain-shaped convenience calls (logStageTransition, logSchedulerTick).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger, LOG_SCHEMA, redactForLogging } from '../../src/observability/logger.mjs';

function captureLogger(overrides = {}) {
  const out = [];
  const err = [];
  const logger = createLogger({
    clock: () => '2026-09-02T00:00:00.000Z',
    stdout: line => out.push(JSON.parse(line)),
    stderr: line => err.push(JSON.parse(line)),
    ...overrides,
  });
  return { logger, out, err };
}

test('info/debug write to stdout with the fixed schema', () => {
  const { logger, out, err } = captureLogger();
  const record = logger.info('protocol-fee-nonzero', { poolId: 'pool-1', protocolFee: '0' });
  assert.equal(out.length, 1);
  assert.equal(err.length, 0);
  assert.deepEqual(record, { schema: LOG_SCHEMA, ts: '2026-09-02T00:00:00.000Z', level: 'info', event: 'protocol-fee-nonzero', poolId: 'pool-1', protocolFee: '0' });
  assert.deepEqual(out[0], record);
});

test('warn/error write to stderr', () => {
  const { logger, out, err } = captureLogger();
  logger.warn('observability-alert-webhook-unavailable', { reason: 'test alert configuration' });
  logger.error('observability-alert-sink-unavailable', { code: 'ALERT_SINK_UNAVAILABLE', target: 'alert sink' });
  assert.equal(out.length, 0);
  assert.equal(err.length, 2);
  assert.equal(err[0].level, 'warn');
  assert.equal(err[1].level, 'error');
});

test('rejects an invalid level, event, or fields shape', () => {
  const { logger } = captureLogger();
  assert.throws(() => logger.debug('', {}), /nonempty string/);
  assert.throws(() => logger.debug('ok', 'not-an-object'), /plain object/);
  assert.throws(() => logger.debug('ok', ['array']), /plain object/);
});

test('fields cannot redefine a fixed log field', () => {
  const { logger } = captureLogger();
  assert.throws(() => logger.info('protocol-fee-nonzero', { level: 'hacked' }), /fixed log field/);
  assert.throws(() => logger.info('protocol-fee-nonzero', { schema: 'hacked' }), /fixed log field/);
});

test('logStageTransition routes level by status and always emits the stage-transition event name', () => {
  const { logger, out, err } = captureLogger();
  logger.logStageTransition({ cycleId: 'c-1', stage: 'claim-process', status: 'STARTED' });
  logger.logStageTransition({ cycleId: 'c-1', stage: 'claim-process', status: 'COMPLETE', message: 'ok' });
  logger.logStageTransition({ cycleId: 'c-1', stage: 'outbound', status: 'FAILED', message: 'boom' });
  logger.logStageTransition({ cycleId: 'c-1', stage: 'outbound', status: 'DEGRADED' });
  logger.logStageTransition({ cycleId: 'c-1', stage: 'outbound', status: 'RETRY' });
  logger.logStageTransition({ cycleId: 'c-1', stage: 'outbound', status: 'SOMETHING_NEW' });

  assert.equal(out.length, 3); // STARTED, COMPLETE, SOMETHING_NEW (unknown -> info)
  assert.equal(err.length, 3); // FAILED, DEGRADED, RETRY (warn)
  for (const record of [...out, ...err]) assert.equal(record.event, 'stage-transition');
  assert.equal(out[1].message, 'ok');
  assert.equal(err[0].message, 'boom');
  assert.equal(err[0].status, 'FAILED');
  assert.equal(err[2].status, 'RETRY');
  assert.equal(err[2].level, 'warn');
});

test('logStageTransition validates its required fields', () => {
  const { logger } = captureLogger();
  assert.throws(() => logger.logStageTransition({ stage: 'claim-process', status: 'STARTED' }), /cycleId/);
  assert.throws(() => logger.logStageTransition({ cycleId: 'c-1', status: 'STARTED' }), /stage/);
  assert.throws(() => logger.logStageTransition({ cycleId: 'c-1', stage: 'claim-process' }), /status/);
});

test('logSchedulerTick maps every onTick event type to the right level and a scheduler-* event name', () => {
  const { logger, out, err } = captureLogger();
  logger.logSchedulerTick({ type: 'TICK_COMPLETE', tick: 1, at: 100, paused: false, liveMode: false, intervalMs: 1200000, calledMethod: 'runOnce', result: { status: 'COMPLETE' } });
  logger.logSchedulerTick({ type: 'TICK_STATE_MISSING', tick: 2, at: 200, paused: true, liveMode: false, intervalMs: 1200000 });
  logger.logSchedulerTick({ type: 'TICK_STATE_READ_FAILED', tick: 3, at: 300, error: new Error('disk error') });
  logger.logSchedulerTick({ type: 'TICK_WORKER_BUILD_FAILED', tick: 4, at: 400, error: new Error('bad worker') });
  logger.logSchedulerTick({ type: 'TICK_WORKER_INVALID', tick: 5, at: 500, error: new Error('missing method') });
  logger.logSchedulerTick({ type: 'TICK_FAILED', tick: 6, at: 600, error: new Error('cycle threw'), calledMethod: 'runOnce' });

  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'scheduler-tick-complete');
  assert.equal(out[0].result.status, 'COMPLETE');
  assert.equal(out[0].calledMethod, 'runOnce');

  assert.equal(err.length, 5);
  assert.equal(err[0].event, 'scheduler-tick-state-missing');
  assert.equal(err[0].level, 'warn');
  for (const record of err.slice(1)) assert.equal(record.level, 'error');
  assert.equal(err[1].event, 'scheduler-tick-state-read-failed');
  assert.equal(err[1].error, 'external error');
  assert.equal(err[4].event, 'scheduler-tick-failed');
  assert.equal(err[4].error, 'external error');
});

test('logSchedulerTick requires an object with a nonempty type', () => {
  const { logger } = captureLogger();
  assert.throws(() => logger.logSchedulerTick(null), /object/);
  assert.throws(() => logger.logSchedulerTick({}), /type/);
});

test('createLogger validates its options', () => {
  assert.throws(() => createLogger('nope'), /object/);
  assert.throws(() => createLogger({ clock: 'nope' }), /clock must be a function/);
  assert.throws(() => createLogger({ stdout: 'nope' }), /stdout must be a function/);
  assert.throws(() => createLogger({ stderr: 'nope' }), /stderr must be a function/);
});

test('defaults to console.log/console.error when no sinks are injected', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const seen = [];
  console.log = line => seen.push(['log', line]);
  console.error = line => seen.push(['error', line]);
  try {
    const logger = createLogger();
    logger.info('protocol-fee-nonzero', { poolId: 'pool-1', protocolFee: '0' });
    logger.error('observability-alert-sink-unavailable', { code: 'ALERT_SINK_UNAVAILABLE', target: 'alert sink' });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 'log');
  assert.equal(seen[1][0], 'error');
  assert.equal(JSON.parse(seen[0][1]).schema, LOG_SCHEMA);
});

test('redacts webhook endpoints, credential-shaped fields, and signer references before non-logger serialization', () => {
  const webhookUrl = 'https://alerts.example.test/hooks?access=not-for-output';
  const signerReference = 'keychain://operator/not-for-output';

  const record = redactForLogging({
    webhookUrl,
    authorization: 'Bearer not-for-output',
    nested: { privateKey: 'not-for-output', signerReference },
    publicAddress: '0x0000000000000000000000000000000000000009',
  });

  assert.equal(record.webhookUrl, '[REDACTED]');
  assert.equal(record.authorization, '[REDACTED]');
  assert.equal(record.nested.privateKey, '[REDACTED]');
  assert.equal(record.nested.signerReference, '[REDACTED]');
  assert.equal(record.publicAddress, '0x0000000000000000000000000000000000000009');
  assert.doesNotMatch(JSON.stringify(record), /not-for-output/);
  assert.deepEqual(redactForLogging({ url: webhookUrl }), { url: '[REDACTED]' });
});

test('rejects raw, signed, and binary transaction fields at every nesting level', () => {
  const { logger, out, err } = captureLogger();
  const marker = 'must-not-reach-a-log-sink';
  const fields = {
    code: 'CANARY_DRIFT',
    target: 'canonical pool fee',
    observed: null,
    action: 'restore the configured reader',
    delivered: false,
  };

  for (const expected of [
    { signedBytes: marker },
    { nested: { rawBytes: marker } },
    { nested: { signedTxBase64: marker } },
    { nested: { serializedTransaction: marker } },
    { signer: { keypair: marker } },
    { response: { binaryPayload: new Uint8Array([1, 2, 3]) } },
  ]) {
    assert.throws(
      () => logger.error('pre-signature-canary-drift', { ...fields, expected }),
      /does not allow field|plain object/i,
    );
  }

  assert.equal(out.length, 0);
  assert.equal(err.length, 0);
});

test('only accepts typed fields for registered observability events', () => {
  const { logger, err } = captureLogger();
  const marker = 'opaque-base64-marker';

  const record = logger.error('protocol-fee-nonzero', { poolId: 'pool-1', protocolFee: '500' });
  assert.equal(record.poolId, 'pool-1');
  assert.equal(record.protocolFee, '500');

  assert.throws(
    () => logger.info('unregistered-observability-event', { cycleId: 'cycle-1' }),
    /registered observability event/i,
  );
  assert.throws(
    () => logger.error('protocol-fee-nonzero', { poolId: 'pool-1', protocolFee: '500', transaction: marker }),
    /does not allow field "transaction"/i,
  );
  for (const field of ['toString', 'constructor']) {
    assert.throws(
      () => logger.error('protocol-fee-nonzero', { poolId: 'pool-1', protocolFee: '500', [field]: marker }),
      new RegExp(`does not allow field "${field}"`, 'i'),
    );
  }
  assert.throws(
    () => logger.logStageTransition({ cycleId: 'cycle-1', stage: 'purchase', status: 'STARTED', wire: marker }),
    /does not allow field "wire"/i,
  );
  assert.throws(
    () => logger.logSchedulerTick({
      type: 'TICK_COMPLETE',
      tick: 1,
      at: 100,
      paused: false,
      liveMode: false,
      intervalMs: 1_200_000,
      result: { transaction: marker },
    }),
    /scheduler result.*does not allow field "transaction"/i,
  );

  assert.equal(err.length, 1);
  assert.doesNotMatch(JSON.stringify(err), /opaque-base64-marker/);
});

test('rejects an unregistered event name before it reaches a log sink', () => {
  const { logger, out, err } = captureLogger();
  const marker = 'opaque-signedTxBase64-marker';

  for (const event of [`provider-error-${marker}`, 'toString', 'constructor']) {
    assert.throws(
      () => logger.error(event, {}),
      /registered observability event/i,
    );
  }

  assert.equal(out.length, 0);
  assert.equal(err.length, 0);
  assert.doesNotMatch(JSON.stringify({ out, err }), /opaque-signedTxBase64-marker/);
});

test('redacts transaction-shaped values recursively before a non-logger sink receives them', () => {
  const marker = 'must-not-reach-a-webhook';
  const redacted = redactForLogging({
    nested: {
      signedBytes: marker,
      rawBytes: marker,
      signedTxBase64: marker,
      serializedTransaction: marker,
      transaction: marker,
      data: marker,
      payloadBytes: marker,
      wire: marker,
      keypair: marker,
      response: { binaryPayload: new Uint8Array([1, 2, 3]) },
    },
  });

  assert.deepEqual(redacted, {
    nested: {
      signedBytes: '[REDACTED]',
      rawBytes: '[REDACTED]',
      signedTxBase64: '[REDACTED]',
      serializedTransaction: '[REDACTED]',
      transaction: '[REDACTED]',
      data: '[REDACTED]',
      payloadBytes: '[REDACTED]',
      wire: '[REDACTED]',
      keypair: '[REDACTED]',
      response: { binaryPayload: '[REDACTED]' },
    },
  });
  assert.doesNotMatch(JSON.stringify(redacted), /must-not-reach-a-webhook/);
});

test('redacts transaction-shaped text and normalizes provider error strings', () => {
  const marker = 'must-not-reach-an-observability-sink';
  const redacted = redactForLogging({
    message: `provider returned signedTxBase64 ${marker}`,
    providerError: `upstream returned raw transaction ${marker}`,
  });

  assert.deepEqual(redacted, { message: '[REDACTED]', providerError: 'external error' });
  assert.doesNotMatch(JSON.stringify(redacted), /must-not-reach-an-observability-sink/);
});

test('normalizes scheduler errors before writing them to a log sink', () => {
  const { logger, err } = captureLogger();
  const marker = 'provider-signedTxBase64-must-not-leak';

  logger.logSchedulerTick({ type: 'TICK_FAILED', tick: 1, error: new Error(`upstream provider returned ${marker}`) });

  assert.equal(err.length, 1);
  assert.equal(err[0].error, 'external error');
  assert.doesNotMatch(JSON.stringify(err), /provider-signedTxBase64-must-not-leak/);
});

test('honors a minimum log level without changing the JSON schema of emitted records', () => {
  const { logger, out, err } = captureLogger({ minimumLevel: 'warn' });

  assert.equal(logger.info('protocol-fee-nonzero', { poolId: 'pool-1', protocolFee: '0' }), null);
  const record = logger.warn('observability-alert-webhook-unavailable', { reason: 'test alert configuration' });

  assert.equal(out.length, 0);
  assert.equal(err.length, 1);
  assert.equal(record.level, 'warn');
});
