import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualCycleHandler } from '../src/routes/manual-cycle.mjs';
import { createManualCycleControl, MANUAL_TEST_PLAN } from '../../runner/src/operator/manual-cycle.mjs';

async function serve(t, ctx) {
  const server = createServer(createManualCycleHandler(ctx));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/operator/api/manual-cycle`;
}
const credential = 'manual-test-proxy-credential-00000001';
const headers = { 'x-hookemon-proxy-credential': credential, 'cf-access-jwt-assertion': 'valid', 'content-type': 'application/json' };

test('authentication precedes status, holder snapshot, and every manual command', async t => {
  let reads = 0;
  const url = await serve(t, { proxyCredential: credential, accessJwtVerifier: async token => {
    if (token !== 'valid') throw new Error('invalid'); return { email: 'owner@example.invalid' };
  }, readManualCycleHolders: async () => { reads += 1; return { status: 'preview', finalized: false, recipients: [] }; } });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { 'x-hookemon-proxy-credential': credential } })).status, 401);
  assert.equal((await fetch(url, { headers: { ...headers, 'cf-access-jwt-assertion': 'invalid' } })).status, 401);
  assert.equal(reads, 0);
  const status = await (await fetch(url, { headers })).json();
  assert.equal(status.ready, false); assert.equal(status.executionMode, 'unavailable');
  assert.equal(status.holderSnapshot.status, 'preview');
  assert.equal((await fetch(url, { headers, method: 'POST', body: '{}' })).status, 503);
});

test('authenticated HTTP click admits once, reconciles same cycle, and replays durable result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'manual-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let active = null, runCalls = 0, recoveryCalls = 0;
  const control = createManualCycleControl({ path: join(directory, 'request.json'), wait: async () => {},
    readReadiness: async () => ({ ready: true, reasons: [], revision: 1, configurationRevision: 1, plan: { ...MANUAL_TEST_PLAN } }),
    cycleRepository: { nextCycleId: () => 'one-cycle', readActiveCycle: async () => active, describeCycle: async () => null },
    buildWorker: () => ({
      async runOnce({ manualCycleId }) { runCalls += 1; active = { cycleId: manualCycleId }; throw new Error('outbound mutation remains unresolved after execution'); },
      async recoverActiveCycle({ manualCycleId }) { recoveryCalls += 1; assert.equal(manualCycleId, 'one-cycle'); active = null; return { status: 'COMPLETE', cycleId: manualCycleId }; },
    }),
  });
  const url = await serve(t, { proxyCredential: credential, manualCycleControl: control });
  const body = JSON.stringify({ requestId: 'click-request-1', expectedRevision: 1 });
  const response = await fetch(url, { headers, method: 'POST', body });
  assert.equal(response.status, 202); await control.settled();
  const completed = await (await fetch(url, { headers })).json();
  assert.equal(completed.request.status, 'completed');
  assert.equal((await fetch(url, { headers, method: 'POST', body })).status, 200);
  assert.equal(runCalls, 1); assert.equal(recoveryCalls, 1);
});
