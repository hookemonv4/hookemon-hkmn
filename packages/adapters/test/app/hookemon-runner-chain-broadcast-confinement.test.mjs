// Exercises `bin/hookemon-runner.mjs`'s own `chainBroadcastTransports` -- the two actual
// signed-byte send clients `loadOperatorSignerClient` receives, constructed independently of
// `compose.mjs`'s own already-confined adapters. A real loopback server redirects outward; under
// the `synthetic-offline` authority both the EVM and Solana broadcast paths must refuse to follow
// it (never reaching a second server standing in for the redirect target), and outside that
// authority the ordinary redirect-following behavior must be unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

import { COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE } from '../../src/signing/collector-production-binding.mjs';
import { chainBroadcastTransports } from '../../bin/hookemon-runner.mjs';

/** A server that always 302-redirects to `targetUrl`, and a server that always answers a JSON-RPC
 * POST with `{ result }`, counting how many requests each actually receives. */
async function redirectingRpcPair(t, result) {
  let targetRequests = 0;
  const target = createServer((request, response) => {
    targetRequests += 1;
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { id } = JSON.parse(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const targetPort = target.address().port;

  // 307 (not 302/303) preserves the original POST method and body across the redirect, so the
  // non-synthetic "still follows the redirect" case below actually reaches the target with the
  // same JSON-RPC request the front server received, exactly like a real single-hop RPC redirect.
  const front = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${targetPort}` });
    response.end();
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => front.close(resolve)));
  const frontPort = front.address().port;

  return { frontUrl: `http://127.0.0.1:${frontPort}`, targetRequests: () => targetRequests };
}

test('chainBroadcastTransports refuses an outward EVM broadcast redirect under synthetic-offline authority, reaching zero redirect targets', async t => {
  const { frontUrl, targetRequests } = await redirectingRpcPair(t, '0xhash');
  const env = {
    collectorCrypt: { productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE },
    robinhood: { rpcUrl: frontUrl },
  };
  const transports = chainBroadcastTransports(env);
  await assert.rejects(() => transports.evm('0x1234'), /refuses a transport redirect/);
  assert.equal(targetRequests(), 0, 'the redirect target must never be reached once the front server redirects');
});

test('chainBroadcastTransports refuses an outward Solana broadcast redirect under synthetic-offline authority, reaching zero redirect targets', async t => {
  const { frontUrl, targetRequests } = await redirectingRpcPair(t, 'signature-value');
  const env = {
    collectorCrypt: { productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE },
    solana: { rpcUrl: frontUrl },
  };
  const transports = chainBroadcastTransports(env);
  await assert.rejects(() => transports.solana('AA=='), /refuses a transport redirect/);
  assert.equal(targetRequests(), 0, 'the redirect target must never be reached once the front server redirects');
});

test('chainBroadcastTransports still follows an EVM broadcast redirect outside the synthetic-offline authority', async t => {
  const { frontUrl, targetRequests } = await redirectingRpcPair(t, '0xhash');
  const transports = chainBroadcastTransports({ robinhood: { rpcUrl: frontUrl } });
  const result = await transports.evm('0x1234');
  assert.equal(result.transactionHash, '0xhash');
  assert.equal(targetRequests(), 1, 'ordinary (non-synthetic) behavior must still follow the redirect to the real target');
});

test('chainBroadcastTransports still follows a Solana broadcast redirect outside the synthetic-offline authority', async t => {
  const { frontUrl, targetRequests } = await redirectingRpcPair(t, 'signature-value');
  const transports = chainBroadcastTransports({ solana: { rpcUrl: frontUrl } });
  const result = await transports.solana('AA==');
  assert.equal(result.signature, 'signature-value');
  assert.equal(targetRequests(), 1, 'ordinary (non-synthetic) behavior must still follow the redirect to the real target');
});
