import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createActivationReadiness } from '../../src/app/activation-readiness.mjs';

const execution = { profile: 'production' };

test('catalog reports not configured without a collector client', async () => {
  const { readCatalog } = createActivationReadiness({ collectorClient: null, execution });
  assert.deepEqual(await readCatalog(), { status: 'NOT_CONFIGURED', fetchedAtMs: 0, packs: [] });
});

test('catalog maps public machines, scales prices, and skips non-canonical prices', async () => {
  const { readCatalog } = createActivationReadiness({
    collectorClient: {
      async getMachines() {
        return [
          { code: 'alpha', name: 'Alpha', price: '1.25', public: true },
          { code: 'private', price: '2', public: false },
          { code: 'short', shortName: 'Short', price: '0.000001' },
          { code: 'invalid', price: '1.0000001' },
        ];
      },
      execution,
    },
  });
  const catalog = await readCatalog();
  assert.equal(catalog.status, 'LOADED');
  assert.equal(typeof catalog.fetchedAtMs, 'number');
  assert.deepEqual(catalog.packs, [
    { id: 'alpha', name: 'Alpha', priceMicroStablecoin: '1250000', available: null },
    { id: 'short', name: 'Short', priceMicroStablecoin: '1', available: null },
  ]);
});

test('catalog caches within ttl, refetches after ttl, and shares concurrent fetches', async () => {
  let now = 1_000;
  let calls = 0;
  let resolveMachines;
  const client = {
    getMachines() {
      calls += 1;
      if (calls === 1) return Promise.resolve([{ code: 'one', price: '1' }]);
      return new Promise(resolve => { resolveMachines = resolve; });
    },
  };
  const { readCatalog } = createActivationReadiness({ collectorClient: client, execution, now: () => now });
  await readCatalog();
  await readCatalog();
  assert.equal(calls, 1);
  now += 60_001;
  const first = readCatalog();
  const second = readCatalog();
  assert.equal(calls, 2);
  resolveMachines([{ code: 'two', price: '2' }]);
  assert.equal((await first).packs[0].id, 'two');
  assert.equal((await second).packs[0].id, 'two');
  assert.equal(calls, 2);
});

test('catalog returns stale after a failed refresh and unavailable without prior success', async () => {
  let now = 1_000;
  let fail = false;
  const client = { async getMachines() {
    if (fail) throw new Error('offline');
    return [{ code: 'one', price: '1' }];
  } };
  const reader = createActivationReadiness({ collectorClient: client, execution, now: () => now });
  const loaded = await reader.readCatalog();
  now += 60_001;
  fail = true;
  assert.deepEqual(await reader.readCatalog(), { ...loaded, status: 'STALE' });
  const unavailable = createActivationReadiness({
    collectorClient: { async getMachines() { throw new Error('offline'); } },
    execution,
  });
  assert.deepEqual(await unavailable.readCatalog(), { status: 'UNAVAILABLE', fetchedAtMs: 0, packs: [] });
});

test('readiness reports each blocking reason and ready when all requirements pass', async () => {
  const { readReadiness } = createActivationReadiness({ collectorClient: null, execution });
  assert.deepEqual(await readReadiness({ authorityStatus: null, catalog: { status: 'UNAVAILABLE', packs: [] } }), {
    ready: false,
    reasons: ['catalog-not-loaded', 'authority-unavailable'],
  });
  assert.deepEqual(await readReadiness({ authorityStatus: { configuration: null }, catalog: { status: 'LOADED', packs: [] } }), {
    ready: false,
    reasons: ['configuration-missing'],
  });
  const configuration = { packPlan: { orders: [{ pack: 'missing' }] } };
  assert.deepEqual(await readReadiness({ authorityStatus: { configuration }, catalog: { status: 'LOADED', packs: [] } }), {
    ready: false,
    reasons: ['pack-plan-not-in-catalog'],
  });
  const inspection = createActivationReadiness({ collectorClient: null, execution: { profile: 'inspection' } });
  assert.deepEqual(await inspection.readReadiness({
    authorityStatus: { configuration: { packPlan: { orders: [] } } },
    catalog: { status: 'LOADED', packs: [] },
  }), { ready: false, reasons: ['execution-profile-inspection'] });
  assert.deepEqual(await readReadiness({
    authorityStatus: { configuration: { packPlan: { orders: [{ pack: 'alpha' }] } } },
    catalog: { status: 'LOADED', packs: [{ id: 'alpha' }] },
  }), { ready: true, reasons: [] });
});
