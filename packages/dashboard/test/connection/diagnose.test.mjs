import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diagnoseDashboardConnection } from '../../src/connection/diagnose.mjs';
import { createRequestListener } from '../../src/server.mjs';
import { createDefaultOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';

const credential = 'synthetic-test-credential-00000000000000000000';
async function serve(t, overrides = {}, customListener) {
  const requests = [];
  const listener = customListener ?? createRequestListener({ profileId: 'mainnet', proxyCredential: credential,
    operatorControl: { status: async () => ({ revision: 0, configuration: createDefaultOperatorConfiguration() }),
      execute: async () => { throw new Error('diagnostics must never write'); } },
    listPacks: async () => ({ machines: [{ code: 'fixture-pack', name: 'Fixture pack' }] }), ...overrides });
  const server = createServer((req, res) => { requests.push([req.method, req.url]); return listener(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('reads authenticated authority and catalog through actual routes without writes', async t => {
  const { origin, requests } = await serve(t);
  const result = await diagnoseDashboardConnection({ origin, credential });
  assert.equal(result.readConnectionReady, true);
  assert.equal(result.writesTested, false);
  assert.equal(result.checks[0].executionConnected, false);
  assert.equal(result.checks[1].packCount, 1);
  assert.deepEqual(requests, [['GET', '/operator/api/bootstrap'], ['GET', '/operator/api/packs']]);
  assert.equal(JSON.stringify(result).includes(credential), false);
});
for (const [name, listPacks, code] of [
  ['unconfigured', null, 'CATALOG_NOT_CONFIGURED'],
  ['empty', async () => ({ machines: [] }), 'CATALOG_EMPTY'],
  ['upstream failure', async () => { throw new Error(credential); }, 'HTTP_502'],
  ['invalid codes', async () => ({ machines: [{ code: null }] }), 'CATALOG_INVALID'],
  ['duplicate codes', async () => ({ machines: [{ code: 'a' }, { code: 'a' }] }), 'CATALOG_INVALID'],
]) test(`does not report ${name} catalog as connected`, async t => {
  const { origin } = await serve(t, { listPacks });
  const result = await diagnoseDashboardConnection({ origin, credential });
  assert.equal(result.readConnectionReady, false);
  assert.equal(result.checks[1].code, code);
  assert.equal(JSON.stringify(result).includes(credential), false);
});
test('wrong credential cannot reach authority or catalog', async t => {
  const { origin } = await serve(t, { operatorControl: null, listPacks: () => assert.fail('unauthenticated catalog read') });
  const result = await diagnoseDashboardConnection({ origin, credential: 'b'.repeat(40) });
  assert.deepEqual(result.checks.map(check => check.code), ['HTTP_401', 'HTTP_401']);
});
test('accepts configured Access assertion without logging it', async t => {
  const token = 'synthetic-access-token';
  const { origin } = await serve(t, { accessJwtVerifier: async value => { assert.equal(value, token); return {}; } });
  const result = await diagnoseDashboardConnection({ origin, credential, accessJwt: token });
  assert.equal(result.readConnectionReady, true);
  assert.equal(JSON.stringify(result).includes(token), false);
});
test('redirects are never followed with credentials', async t => {
  let targetHits = 0;
  const target = await serve(t, {}, (req, res) => { targetHits++; res.end('{}'); });
  const source = await serve(t, {}, (req, res) => { res.writeHead(302, { location: target.origin }); res.end(); });
  const result = await diagnoseDashboardConnection({ origin: source.origin, credential });
  assert.equal(result.readConnectionReady, false);
  assert.equal(targetHits, 0);
});
test('rejects unsafe or ambiguous origins before requesting', async () => {
  for (const origin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?secret=x']) {
    await assert.rejects(diagnoseDashboardConnection({ origin, credential }));
  }
});
test('unavailable authority is not hidden by a working catalog', async t => {
  const { origin } = await serve(t, { operatorControl: null });
  const result = await diagnoseDashboardConnection({ origin, credential });
  assert.equal(result.readConnectionReady, false);
  assert.equal(result.checks[0].code, 'HTTP_503');
  assert.equal(result.checks[1].ok, true);
});
