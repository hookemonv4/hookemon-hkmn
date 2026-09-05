// Live, read-only smoke test for GET https://api.relay.link/chains. Deliberately named without a
// `.test.mjs` suffix so CI's `node --test test/*.test.mjs` step (the required, blocking gate —
// see .github/workflows/v4-gates.yml) never picks it up: a Relay outage or network flake here must
// never fail the required gate. Run it manually:
//
//   node packages/adapters/test/relay-client.live-chains.mjs
//
// It performs exactly one real network call (GET /chains — a read, no quote, no execution) and
// re-checks the same route-enablement gate the adapter itself uses before trusting a quote.
import assert from 'node:assert/strict';

import { DIRECTIONS, assertRouteEnabled, createRelayClient } from '../src/relay-client.mjs';

async function main() {
  const client = createRelayClient();
  const chainsResponse = await client.getChains();
  const outbound = assertRouteEnabled({ direction: DIRECTIONS.OUTBOUND, chainsResponse });
  const inbound = assertRouteEnabled({ direction: DIRECTIONS.RETURN, chainsResponse });
  assert.ok(Object.values(outbound.checks).every(Boolean), 'OUTBOUND route is not fully enabled right now');
  assert.ok(Object.values(inbound.checks).every(Boolean), 'RETURN route is not fully enabled right now');
  process.stdout.write('PASSED: Relay /chains lists both bridge directions as enabled right now.\n');
}

main().catch((error) => {
  process.stderr.write(`Relay live /chains smoke test did not pass (non-blocking): ${error.message}\n`);
  process.exitCode = 1;
});
