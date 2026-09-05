// Coverage for observability/alert-webhook.mjs: alert shape validation, the transition -> alert
// mapping helpers, the dedupe tracker, and — closing the "no alert channel has ever been test-fired"
// gap ops/HANDOFF.md names — fake webhook coverage that records the canonical POST body without
// opening a socket, plus retry and permanent-failure coverage.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  ALERT_SCHEMA,
  alertFromSchedulerTick,
  alertFromTerminalCycle,
  buildAlert,
  createAlertWebhook,
  createPersistentAlertDeduper,
  createTransitionDeduper,
} from '../../src/observability/alert-webhook.mjs';

async function createMockWebhook(handler) {
  const fetchImpl = async (url, request) => {
    let status = 200;
    const response = {
      writeHead(nextStatus) { status = nextStatus; },
      end() {},
    };
    await handler({ method: request.method, headers: request.headers, url }, request.body, response);
    return { ok: status >= 200 && status < 300, status };
  };
  return { server: { close() {} }, url: 'https://alerts.example.test/hooks', fetchImpl };
}

function noSleep() {
  return Promise.resolve();
}

test('buildAlert validates and freezes an exact alert shape', () => {
  const alert = buildAlert({ reason: 'CYCLE_FAILED', severity: 'critical', cycleId: 'c-1', stage: 'return', message: 'boom' });
  assert.deepEqual(alert, { reason: 'CYCLE_FAILED', severity: 'critical', cycleId: 'c-1', stage: 'return', message: 'boom', detail: null });
  assert.throws(() => buildAlert({ reason: 'NOT_A_REASON', severity: 'critical', message: 'x' }), /reason is invalid/);
  assert.throws(() => buildAlert({ reason: 'CYCLE_FAILED', severity: 'meh', message: 'x' }), /severity is invalid/);
  assert.throws(() => buildAlert({ reason: 'CYCLE_FAILED', severity: 'critical', message: '' }), /message/);
});

test('send() posts a canonical alert body through the configured webhook client', async () => {
  const received = [];
  const { server, url, fetchImpl } = await createMockWebhook((request, body, response) => {
    received.push({ method: request.method, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  try {
    const webhook = createAlertWebhook({ url, fetchImpl, now: () => '2026-09-02T00:00:00.000Z' });
    const alert = alertFromTerminalCycle({ cycleId: 'cycle-9', lifecycle: 'FAILED', cycleStage: 'return-finalized', failureReceiptDigest: '0xdead' });
    const result = await webhook.send(alert);

    assert.deepEqual(result, { delivered: true, attempts: 1, status: 200 });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].headers['content-type'], 'application/json');
    assert.deepEqual(received[0].body, {
      schema: ALERT_SCHEMA,
      sentAt: '2026-09-02T00:00:00.000Z',
      reason: 'CYCLE_FAILED',
      severity: 'critical',
      cycleId: 'cycle-9',
      stage: 'return-finalized',
      message: 'cycle cycle-9 reached a terminal FAILED state',
      detail: { failureReceiptDigest: '0xdead' },
    });
  } finally {
    server.close();
  }
});

test('a DEGRADED terminal cycle fires the same webhook path as FAILED', async () => {
  const received = [];
  const { server, url, fetchImpl } = await createMockWebhook((request, body, response) => {
    received.push(JSON.parse(body));
    response.writeHead(200);
    response.end();
  });
  try {
    const webhook = createAlertWebhook({ url, fetchImpl });
    const alert = alertFromTerminalCycle({ cycleId: 'cycle-7', lifecycle: 'DEGRADED', cycleStage: 'return-finalized', terminalDigest: '0xfeed' });
    const result = await webhook.send(alert);
    assert.equal(result.delivered, true);
    assert.equal(received[0].reason, 'CYCLE_DEGRADED');
    assert.equal(received[0].cycleId, 'cycle-7');
  } finally {
    server.close();
  }
});

test('authoritative held terminal states map to a cycle alert', () => {
  for (const terminalState of ['HELD_DATA_UNVERIFIED', 'HELD_UNAVAILABLE', 'HELD_OWNER_DECISION']) {
    const alert = alertFromTerminalCycle({
      cycleId: 'cycle-held',
      terminalState,
      cycleStage: 'return',
      terminalDigest: '0xheld',
    });
    assert.ok(alert, `${terminalState} must produce an alert`);
    assert.equal(alert.reason, 'CYCLE_DEGRADED');
    assert.equal(alert.cycleId, 'cycle-held');
    assert.equal(alert.detail.terminalState, terminalState);
  }
});

test('lease-contention transition fires through alertFromSchedulerTick', async () => {
  const received = [];
  const { server, url, fetchImpl } = await createMockWebhook((request, body, response) => {
    received.push(JSON.parse(body));
    response.writeHead(200);
    response.end();
  });
  try {
    const webhook = createAlertWebhook({ url, fetchImpl });
    const tickEvent = { type: 'TICK_COMPLETE', tick: 4, result: { status: 'LEASE_HELD', cycleId: null, stage: null } };
    const alert = alertFromSchedulerTick(tickEvent);
    assert.ok(alert, 'lease contention must produce an alert');
    const result = await webhook.send(alert);
    assert.equal(result.delivered, true);
    assert.equal(received[0].reason, 'LEASE_CONTENTION');
    assert.equal(received[0].severity, 'warning');
  } finally {
    server.close();
  }
});

test('retries a failing endpoint and eventually delivers', async () => {
  let attempts = 0;
  const { server, url, fetchImpl } = await createMockWebhook((request, body, response) => {
    attempts += 1;
    if (attempts < 3) {
      response.writeHead(503);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end();
  });
  try {
    const webhook = createAlertWebhook({ url, fetchImpl, maxAttempts: 5, sleep: noSleep });
    const result = await webhook.send(buildAlert({ reason: 'SCHEDULER_TICK_FAILED', severity: 'critical', message: 'tick failed' }));
    assert.deepEqual(result, { delivered: true, attempts: 3, status: 200 });
    assert.equal(attempts, 3);
  } finally {
    server.close();
  }
});

test('reports (never throws) once every retry is exhausted, and logs the failure', async () => {
  const { server, url, fetchImpl } = await createMockWebhook((request, body, response) => {
    response.writeHead(500);
    response.end();
  });
  const loggedErrors = [];
  try {
    const webhook = createAlertWebhook({
      url,
      fetchImpl,
      maxAttempts: 2,
      sleep: noSleep,
      logger: { error: (event, fields) => loggedErrors.push({ event, fields }) },
    });
    const result = await webhook.send(buildAlert({ reason: 'CYCLE_FAILED', severity: 'critical', message: 'tick failed' }));
    assert.equal(result.delivered, false);
    assert.equal(result.attempts, 2);
    assert.match(result.error, /status 500/);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0].event, 'alert-webhook-delivery-failed');
    assert.equal(loggedErrors[0].fields.attempts, 2);
  } finally {
    server.close();
  }
});

test('a transport error is retried and then reported, never thrown', async () => {
  const webhook = createAlertWebhook({
    url: 'https://alerts.example.test/hooks',
    fetchImpl: async () => { throw new Error('connection refused'); },
    maxAttempts: 2,
    sleep: noSleep,
    timeoutMs: 500,
  });
  const result = await webhook.send(buildAlert({ reason: 'CYCLE_FAILED', severity: 'critical', message: 'x' }));
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 2);
});

test('createAlertWebhook validates its options', () => {
  assert.throws(() => createAlertWebhook({ url: '' }), /nonempty string/);
  assert.throws(() => createAlertWebhook({ url: 'not a url' }), /Invalid URL/);
  assert.throws(() => createAlertWebhook({ url: 'http://x', maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createAlertWebhook({ url: 'http://x', backoffMs: -1 }), /backoffMs/);
  assert.throws(() => createAlertWebhook({ url: 'http://x', timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createAlertWebhook({ url: 'http://x', fetchImpl: 'nope' }), /fetchImpl/);
});

test('send() validates the alert it is given', async () => {
  const webhook = createAlertWebhook({ url: 'http://127.0.0.1:1', fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(() => webhook.send({ reason: 'NOT_A_REASON' }), /must use the exact schema/);
});

test('refuses opaque transaction aliases in alert detail before webhook delivery', async () => {
  const marker = 'opaque-base64-marker';
  let calls = 0;
  const webhook = createAlertWebhook({
    url: 'https://alerts.example.test/hooks',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 204 };
    },
  });

  await assert.rejects(
    () => webhook.send({
      reason: 'CANARY_DRIFT',
      severity: 'critical',
      cycleId: null,
      stage: null,
      message: 'canary read failed',
      detail: { transaction: marker, data: marker, payloadBytes: marker, wire: marker },
    }),
    /alert detail.*does not allow field "transaction"/i,
  );
  assert.equal(calls, 0);
});

test('refuses prototype-property fields in alert detail before webhook delivery', async () => {
  const marker = 'opaque-base64-marker';
  let calls = 0;
  const webhook = createAlertWebhook({
    url: 'https://alerts.example.test/hooks',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 204 };
    },
  });

  for (const field of ['toString', 'constructor']) {
    await assert.rejects(
      () => webhook.send({
        reason: 'CANARY_DRIFT',
        severity: 'critical',
        cycleId: null,
        stage: null,
        message: 'canary read failed',
        detail: { [field]: marker },
      }),
      new RegExp(`does not allow field "${field}"`, 'i'),
    );
  }
  assert.equal(calls, 0);
});

test('alertFromSchedulerTick maps every failure event type and ignores a clean tick', () => {
  assert.equal(alertFromSchedulerTick({ type: 'TICK_COMPLETE', result: { status: 'COMPLETE' } }), null);
  assert.equal(alertFromSchedulerTick({ type: 'TICK_STATE_MISSING' }), null);
  assert.equal(alertFromSchedulerTick(null), null);

  for (const type of ['TICK_FAILED', 'TICK_STATE_READ_FAILED', 'TICK_WORKER_BUILD_FAILED', 'TICK_WORKER_INVALID']) {
    const alert = alertFromSchedulerTick({ type, tick: 1, error: new Error(`${type} boom`) });
    assert.equal(alert.reason, 'SCHEDULER_TICK_FAILED');
    assert.equal(alert.severity, 'critical');
    assert.match(alert.message, new RegExp(type));
    assert.equal(alert.detail.error, 'external error');
  }
});

test('alertFromTerminalCycle ignores PAYOUT_COMMITTED and EXPIRED_UNSTARTED', () => {
  assert.equal(alertFromTerminalCycle({ cycleId: 'a', lifecycle: 'PAYOUT_COMMITTED' }), null);
  assert.equal(alertFromTerminalCycle({ cycleId: 'a', lifecycle: 'EXPIRED_UNSTARTED' }), null);
  assert.equal(alertFromTerminalCycle(null), null);
});

test('createTransitionDeduper fires once per key until reset', () => {
  const deduper = createTransitionDeduper();
  assert.equal(deduper.shouldFire('k'), true);
  assert.equal(deduper.shouldFire('k'), false);
  assert.equal(deduper.shouldFire('k'), false);
  deduper.reset('k');
  assert.equal(deduper.shouldFire('k'), true);
  assert.equal(deduper.shouldFire('other'), true);
  deduper.clear();
  assert.equal(deduper.shouldFire('other'), true);
});

test('createTransitionDeduper validates its key', () => {
  const deduper = createTransitionDeduper();
  assert.throws(() => deduper.shouldFire(''), /nonempty string/);
  assert.throws(() => deduper.reset(1), /nonempty string/);
});

test('persistent alert delivery retries pending rows, suppresses delivered rows across restart, and rearms after resolution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-observability-'));
  const path = join(directory, 'alerts.sqlite');
  let now = 100;
  try {
    const first = createPersistentAlertDeduper({ path, now: () => now, windowMs: 1_000 });
    const initial = first.claim('canary:pool-fee');
    assert.deepEqual(initial, { deliver: true, state: 'PENDING', token: 1 });
    assert.deepEqual(first.markPending('canary:pool-fee', initial.token), { state: 'PENDING', updated: true });
    first.close();

    const restarted = createPersistentAlertDeduper({ path, now: () => now, windowMs: 1_000 });
    const retry = restarted.claim('canary:pool-fee');
    assert.deepEqual(retry, { deliver: true, state: 'PENDING', token: 2 });
    assert.deepEqual(restarted.markDelivered('canary:pool-fee', retry.token), { state: 'DELIVERED', updated: true });
    now += 1_001;
    assert.deepEqual(restarted.claim('canary:pool-fee'), { deliver: false, state: 'DELIVERED' });
    assert.deepEqual(restarted.resolve('canary:pool-fee'), { state: 'RESOLVED' });
    assert.deepEqual(restarted.resolve('canary:pool-fee'), { state: 'RESOLVED' });
    assert.deepEqual(restarted.claim('canary:pool-fee'), { deliver: true, state: 'PENDING', token: 3 });
    restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates legacy alerted rows as delivered without re-paging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-observability-'));
  const path = join(directory, 'alerts.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE observability_alert_dedupe (
        alert_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        alerted_at INTEGER NOT NULL,
        resolved_at INTEGER,
        CHECK (state IN ('ALERTED', 'RESOLVED'))
      );
    `);
    legacy.prepare(`
      INSERT INTO observability_alert_dedupe (alert_key, state, alerted_at, resolved_at)
      VALUES (?, 'ALERTED', ?, NULL)
    `).run('canary:legacy-target', 100);
    legacy.close();

    const deduper = createPersistentAlertDeduper({ path, now: () => 100, windowMs: 1_000 });
    assert.deepEqual(deduper.claim('canary:legacy-target'), { deliver: false, state: 'DELIVERED' });
    deduper.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persistent alert claims are atomic across deduper instances and an abandoned pending claim can be retried', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-observability-'));
  const path = join(directory, 'alerts.sqlite');
  let now = 100;
  try {
    const first = createPersistentAlertDeduper({ path, now: () => now, windowMs: 1_000 });
    const second = createPersistentAlertDeduper({ path, now: () => now, windowMs: 1_000 });

    assert.deepEqual(first.claim('canary:stable-target'), { deliver: true, state: 'PENDING', token: 1 });
    assert.deepEqual(second.claim('canary:stable-target'), { deliver: false, state: 'PENDING' });

    now += 1_000;
    assert.deepEqual(second.claim('canary:stable-target'), { deliver: true, state: 'PENDING', token: 2 });
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persistent alert deduper exposes an operational readiness probe', () => {
  const deduper = createPersistentAlertDeduper({ path: ':memory:', windowMs: 1_000 });
  try {
    assert.equal(deduper.ready(), true);
  } finally {
    deduper.close();
  }
});

test('persistent alert deduper retains a pending claim for its configured delivery lease', () => {
  let now = 100;
  const deduper = createPersistentAlertDeduper({ path: ':memory:', windowMs: 1, leaseMs: 1_000, now: () => now });
  try {
    assert.deepEqual(deduper.claim('canary:delivery-lease'), { deliver: true, state: 'PENDING', token: 1 });
    now += 1;
    assert.deepEqual(deduper.claim('canary:delivery-lease'), { deliver: false, state: 'PENDING' });
    now += 999;
    assert.deepEqual(deduper.claim('canary:delivery-lease'), { deliver: true, state: 'PENDING', token: 2 });
  } finally {
    deduper.close();
  }
});

test('canary alerts are accepted, retry using configured backoff, and never expose the webhook endpoint', async () => {
  const webhookUrl = 'https://alerts.example.test/hooks?access=not-for-output';
  const sleeps = [];
  const loggedErrors = [];
  let attempts = 0;
  const webhook = createAlertWebhook({
    url: webhookUrl,
    maxAttempts: 3,
    backoffMs: 17,
    sleep: async delay => sleeps.push(delay),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`request failed for ${webhookUrl}`);
      return { ok: true, status: 204 };
    },
    logger: { error: (event, fields) => loggedErrors.push({ event, fields }) },
  });

  const result = await webhook.send(buildAlert({
    reason: 'CANARY_DRIFT',
    severity: 'critical',
    message: 'canonical pool fee is nonzero',
    detail: { code: 'POOL_FEE_NONZERO', action: 'restore zero protocol fee' },
  }));

  assert.deepEqual(result, { delivered: true, attempts: 3, status: 204 });
  assert.deepEqual(sleeps, [17, 34]);
  assert.equal(Object.hasOwn(webhook, 'url'), false);
  assert.equal(loggedErrors.length, 0);
});

test('permanent delivery failures do not put webhook endpoints or request errors into log fields', async () => {
  const webhookUrl = 'https://alerts.example.test/hooks?access=not-for-output';
  const loggedErrors = [];
  const webhook = createAlertWebhook({
    url: webhookUrl,
    maxAttempts: 1,
    fetchImpl: async () => { throw new Error(`request failed for ${webhookUrl}`); },
    logger: { error: (event, fields) => loggedErrors.push({ event, fields }) },
  });

  const result = await webhook.send(buildAlert({ reason: 'CANARY_DRIFT', severity: 'critical', message: 'canary read failed' }));

  assert.equal(result.delivered, false);
  assert.equal(loggedErrors.length, 1);
  assert.doesNotMatch(JSON.stringify(loggedErrors), /not-for-output/);
  assert.equal(Object.hasOwn(loggedErrors[0].fields, 'url'), false);
});

test('webhook delivery normalizes provider errors before logging them', async () => {
  const marker = 'provider-signedTxBase64-must-not-leak';
  const loggedErrors = [];
  const webhook = createAlertWebhook({
    url: 'https://alerts.example.test/hooks',
    maxAttempts: 1,
    fetchImpl: async () => { throw new Error(`upstream response contained ${marker}`); },
    logger: { error: (event, fields) => loggedErrors.push({ event, fields }) },
  });

  const result = await webhook.send(buildAlert({
    reason: 'CANARY_DRIFT',
    severity: 'critical',
    message: 'canary read failed',
  }));

  assert.equal(result.delivered, false);
  assert.equal(result.error, 'alert webhook transport failed');
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0].fields.error, 'alert webhook transport failed');
  assert.doesNotMatch(JSON.stringify({ result, loggedErrors }), /provider-signedTxBase64-must-not-leak/);
});
