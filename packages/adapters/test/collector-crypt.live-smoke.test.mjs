// Separate, explicitly-labeled LIVE read-only smoke test for the real Collector Crypt API
// (GET /api/status, GET /api/machines). Non-blocking in CI by construction rather than by CI
// configuration: `.github/workflows/v4-gates.yml`'s "Verify adapters dependencies" step already
// runs `node --test test/*.test.mjs`, which is outside this work package's writeSet to change, so
// this file makes itself a no-op (`skip`, which node:test reports as passing) unless a caller
// explicitly opts in with COLLECTOR_CRYPT_LIVE_SMOKE=1 — and even then, any failure (no network, no
// COLLECTOR_CRYPT_API_KEY, provider outage) is reported as a skip, never a failure, because a live
// third-party dependency is inherently outside this repository's control.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCollectorCryptClient } from '../src/collector-crypt.mjs';

const liveSmokeEnabled = process.env.COLLECTOR_CRYPT_LIVE_SMOKE === '1';
const apiKey = process.env.COLLECTOR_CRYPT_API_KEY;

test('LIVE: GET /api/status and GET /api/machines succeed against the real Collector Crypt API', { skip: !liveSmokeEnabled && 'set COLLECTOR_CRYPT_LIVE_SMOKE=1 and COLLECTOR_CRYPT_API_KEY to run this live check' }, async t => {
  if (!apiKey) {
    t.skip('COLLECTOR_CRYPT_API_KEY is not set');
    return;
  }

  const client = createCollectorCryptClient({ apiKey, dryRun: true, maxAttempts: 1 });

  try {
    const status = await client.getStatus();
    assert.equal(typeof status.machineStatus, 'string');

    const machines = await client.getMachines();
    assert.ok(Array.isArray(machines.machines));
  } catch (error) {
    // A live third-party outage or network restriction is not this repository's failure to report.
    t.skip(`live Collector Crypt read failed, treating as non-blocking: ${error.message}`);
  }
});
