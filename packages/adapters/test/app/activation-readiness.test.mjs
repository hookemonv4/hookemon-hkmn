import assert from 'node:assert/strict';
import test from 'node:test';

import { createActivationReadiness } from '../../src/app/activation-readiness.mjs';

test('returns NOT_CONFIGURED when Collector is absent', async () => {
  const readiness = createActivationReadiness({ collectorClient: null, assertStartReadiness: async () => {} });
  assert.deepEqual(await readiness.readCatalog(), { status: 'NOT_CONFIGURED', fetchedAtMs: 0, packs: [] });
});

test('maps public Collector machines to canonical six-decimal prices', async () => {
  const readiness = createActivationReadiness({
    collectorClient: {
      async getMachines() {
        return { machines: [
          { code: 'base-pack', name: 'Base', price: '12.5', public: true },
          { code: 'private-pack', name: 'Private', price: '1', public: false },
          { code: 'bad-pack', name: 'Bad', price: '1.0000001', public: true },
        ] };
      },
    },
    assertStartReadiness: async () => {},
    now: () => 123,
  });
  assert.deepEqual(await readiness.readCatalog(), {
    status: 'LOADED',
    fetchedAtMs: 123,
    packs: [{ id: 'base-pack', name: 'Base', priceMicroStablecoin: '12500000', available: null }],
  });
});

test('returns UNAVAILABLE before a successful catalog fetch and STALE afterward', async () => {
  let fail = true;
  let now = 0;
  const readiness = createActivationReadiness({
    collectorClient: {
      async getMachines() {
        if (fail) throw new Error('offline');
        return [{ code: 'base-pack', shortName: 'Base', price: 1 }];
      },
    },
    assertStartReadiness: async () => {},
    now: () => now,
    ttlMs: 10,
  });
  assert.deepEqual(await readiness.readCatalog(), { status: 'UNAVAILABLE', fetchedAtMs: 0, packs: [] });
  fail = false;
  now = 10;
  const loaded = await readiness.readCatalog();
  assert.equal(loaded.status, 'LOADED');
  fail = true;
  now = 20;
  assert.deepEqual(await readiness.readCatalog(), { ...loaded, status: 'STALE' });
});

test('caches readiness for the TTL, truncates rejection reasons, and deduplicates calls', async () => {
  let now = 0;
  let calls = 0;
  let reject = false;
  const readiness = createActivationReadiness({
    collectorClient: null,
    assertStartReadiness: async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 1));
      if (reject) throw new Error('x'.repeat(400));
    },
    readinessOptions: { liveMode: false },
    now: () => now,
    ttlMs: 10,
  });
  const first = await Promise.all([readiness.readReadiness(), readiness.readReadiness()]);
  assert.deepEqual(first[0], { ready: true, reasons: [] });
  assert.deepEqual(first[1], first[0]);
  assert.equal(calls, 1);
  now = 10;
  reject = true;
  const failed = await readiness.readReadiness();
  assert.equal(failed.ready, false);
  assert.match(failed.reasons[0], /^start-readiness: /);
  assert.ok(failed.reasons[0].length <= 256);
  now = 20;
  await readiness.readReadiness();
  assert.equal(calls, 3);
});
