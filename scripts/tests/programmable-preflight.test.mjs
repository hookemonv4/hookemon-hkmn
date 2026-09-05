import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { runPreflight } from '../programmable/lib/preflight-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const node = process.execPath;

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function readBody(request) {
  return new Promise((resolveBody) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolveBody(body));
  });
}

function sendJson(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

function capabilityResponse() {
  return {
    chain: { id: '4663' },
    profile: {
      structuralProfileId: 'programmable.custom-launch.robinhood-mainnet.v1',
      profileDigest: 'sha256:484b1dc6e9091804fabc230f2b3a7504940fa00264f8e66e82a66a951e71f1a0',
    },
    routes: {
      capabilities: '/v4/chains/4663/capabilities',
      preflight: '/v4/chains/4663/custom-launches/preflight',
      status: '/v4/chains/4663/custom-launches/{launchId}',
    },
    safety: { transactionBroadcast: false },
  };
}

function matchingPreflight(body) {
  return {
    requestId: 'preflight-test-001',
    credential: 'test-api-key',
    profile: body.expected.profile,
    roots: body.expected.roots,
    digests: body.expected.digests,
    caller: body.expected.caller,
    deployer: body.expected.deployer,
    graphTransaction: {
      chainId: '4663',
      to: body.expected.graphTransaction.to,
      data: '0x1234',
      value: '0',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    seedTransaction: {
      permit2Allowance: {
        chainId: '4663',
        assetId: 'usdg-4663',
        decimals: 6,
        amountAtomic: '240000000',
      },
      deadlineSeconds: 900,
      refundDestination: body.expected.seedTransaction.refundDestination,
    },
  };
}

test('preflight binds a matching read-only provider response and redacts the API key from evidence', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') return sendJson(response, capabilityResponse());
    assert.equal(request.url, '/v4/chains/4663/custom-launches/preflight');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer test-api-key');
    const body = JSON.parse(await readBody(request));
    assert.doesNotMatch(JSON.stringify(body), /test-api-key/);
    return sendJson(response, matchingPreflight(body));
  });
  t.after(() => server.close());

  const result = await runPreflight({
    root,
    baseUrl,
    apiKey: 'test-api-key',
    outputDirectory,
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });

  assert.deepEqual(result.mismatches, []);
  const evidence = readFileSync(result.evidencePath, 'utf8');
  assert.doesNotMatch(evidence, /test-api-key/);
  assert.doesNotMatch(evidence, /apiKey/i);
  assert.doesNotMatch(evidence, /credential/i);
});

test('preflight returns a numbered digest mismatch without creating a successful result', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') return sendJson(response, capabilityResponse());
    const body = JSON.parse(await readBody(request));
    const reply = matchingPreflight(body);
    reply.digests.graphDraftSha256 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    return sendJson(response, reply);
  });
  t.after(() => server.close());

  const result = await runPreflight({ root, baseUrl, apiKey: 'test-api-key', outputDirectory });

  assert.equal(result.mismatches.length, 1);
  assert.match(result.mismatches[0], /^1\. digests\.graphDraftSha256:/);
});

test('the CLI refuses a missing API key before it contacts the provider', async (t) => {
  let requests = 0;
  const { server, baseUrl } = await startServer((request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  t.after(() => server.close());

  const result = spawnSync(node, ['scripts/programmable/preflight.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PROGRAMMABLE_API_BASE_URL: baseUrl, PROGRAMMABLE_API_KEY: '' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PROGRAMMABLE_API_KEY is required/);
  assert.equal(requests, 0);
});
