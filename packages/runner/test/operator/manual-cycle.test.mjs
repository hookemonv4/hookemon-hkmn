import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualCycleControl, MANUAL_TEST_PLAN } from '../../src/operator/manual-cycle.mjs';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manual-cycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'request.json');
  let active = null;
  const calls = [];
  const readiness = { ready: true, reasons: [], revision: 7, configurationRevision: 4, plan: { ...MANUAL_TEST_PLAN } };
  const config = { path, readReadiness: async () => readiness,
    cycleRepository: { nextCycleId: () => 'cycle-reserved', readActiveCycle: async () => active,
      describeCycle: async () => null },
    buildWorker: () => ({
      runOnce: async input => { calls.push(['run', input]); return { status: 'COMPLETE', cycleId: input.manualCycleId }; },
      recoverActiveCycle: async input => { calls.push(['recover', input]); return { status: 'COMPLETE', cycleId: input.manualCycleId }; },
    }), ...overrides };
  return { control: createManualCycleControl(config), config, calls, path, readiness, setActive: value => { active = value; } };
}
const input = { requestId: 'manual-request-1', expectedRevision: 7 };

test('concurrent submissions and network retries admit one durable cycle only', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.control.request(input)));
  await f.control.settled();
  assert.ok(responses.every(response => [200, 202].includes(response.httpStatus)));
  assert.equal(f.calls.length, 1);
  assert.equal((await f.control.status()).request.status, 'completed');
  assert.equal((await f.control.request({ ...input, requestId: 'manual-request-2' })).httpStatus, 409);
  assert.equal((await f.control.status()).ready, false);
});

test('missing readiness, pause, held custody, wrong plan, and stale revision never create a request', async t => {
  const f = await fixture(t);
  for (const reason of ['PRODUCTION_PREFLIGHT_NOT_READY', 'EXECUTION_PAUSED', 'HELD_CUSTODY_NOT_CLEAR', 'EXTERNAL_TOKEN_RECIPIENT_BINDING_UNAVAILABLE']) {
    f.readiness.ready = false; f.readiness.reasons = [reason];
    assert.equal((await f.control.request(input)).httpStatus, 409);
  }
  f.readiness.ready = true; f.readiness.reasons = []; f.readiness.plan.quantity = 2;
  assert.equal((await f.control.request(input)).httpStatus, 409);
  f.readiness.plan.quantity = 1;
  assert.equal((await f.control.request({ ...input, expectedRevision: 6 })).httpStatus, 409);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('post-reservation revision change consumes test without dispatch', async t => {
  const f = await fixture(t);
  let reads = 0;
  const control = createManualCycleControl({ ...f.config, readReadiness: async () => ({ ...f.readiness, revision: ++reads === 1 ? 7 : 8 }) });
  assert.equal((await control.request(input)).body.code, 'READINESS_CHANGED');
  assert.equal(f.calls.length, 0);
  assert.equal((await control.status()).request.status, 'failed');
});

test('crash after reservation never repeats runOnce, including when no cycle was created', async t => {
  const f = await fixture(t);
  await seedRecord(f.path, { status: 'running' });
  const restarted = createManualCycleControl(f.config);
  await restarted.recover();
  await restarted.request(input);
  assert.equal(f.calls.length, 0);
  assert.equal((await restarted.status()).request.status, 'uncertain');
});

test('restart recovers only the durable reserved cycle and never performs new admission', async t => {
  const f = await fixture(t);
  await seedRecord(f.path, { status: 'uncertain' });
  f.setActive({ cycleId: 'cycle-reserved' });
  await f.control.recover(); await f.control.settled();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'recover');
  assert.equal(f.calls[0][1].manualCycleId, 'cycle-reserved');
  assert.equal((await f.control.status()).request.status, 'completed');
});

test('uncertain provider effect is retained after restart and unreadable journal fails closed', async t => {
  const f = await fixture(t, { buildWorker: () => ({ runOnce: async () => { throw new Error('post-broadcast'); } }) });
  await f.control.request(input); await f.control.settled();
  assert.equal((await f.control.status()).request.status, 'uncertain');
  await writeFile(f.path, '{');
  assert.equal((await f.control.status()).ready, false);
  await assert.rejects(f.control.request(input));
});

async function seedRecord(path, override = {}) {
  const record = { schemaVersion: 1, requestId: input.requestId, expectedRevision: 7,
    configurationRevision: 4, plan: { ...MANUAL_TEST_PLAN }, cycleId: 'cycle-reserved',
    status: 'running', resultCode: 'MANUAL_REQUEST_ACCEPTED', ...override };
  await writeFile(path, JSON.stringify({ ...record, digest: createHash('sha256').update(JSON.stringify(record)).digest('hex') }));
}

test('pending bridge reconciles the same cycle without another admission and stops at a hold', async t => {
  const f = await fixture(t);
  let admissions = 0, recoveries = 0, waits = 0;
  const control = createManualCycleControl({ ...f.config, wait: async () => { waits += 1; },
    buildWorker: () => ({
      async runOnce({ manualCycleId }) {
        admissions += 1; f.setActive({ cycleId: manualCycleId });
        throw new Error('outbound mutation remains unresolved after execution');
      },
      async recoverActiveCycle({ manualCycleId }) {
        recoveries += 1; f.setActive({ cycleId: manualCycleId, terminalState: 'HELD_ASSET' });
        return { status: 'HELD_ASSET', cycleId: manualCycleId };
      },
    }),
  });
  await control.request(input); await control.settled();
  assert.equal(admissions, 1); assert.equal(recoveries, 1); assert.equal(waits, 1);
  assert.equal((await control.status()).request.status, 'uncertain');
});

test('modified persisted plan or digest never recovers a different intended payment', async t => {
  const f = await fixture(t);
  f.setActive({ cycleId: 'cycle-reserved' });
  await seedRecord(f.path, { plan: { ...MANUAL_TEST_PLAN, recipientTokenAddress: '0xwrong' } });
  assert.equal((await f.control.status()).ready, false);
  await assert.rejects(f.control.recover(), /invalid manual cycle record/);
  assert.equal(f.calls.length, 0);
});
