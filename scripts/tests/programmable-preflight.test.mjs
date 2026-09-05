import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assembleV4PreflightRequest,
  validateV4RequestContract,
} from '../programmable/lib/preflight-package.mjs';
import {
  materializePhaseThreeCreateRequest,
  normalizeV4PreflightNonce,
} from '../programmable/lib/create-request-materializer.mjs';
import { sendPreflightProbe } from '../programmable/lib/preflight-probe.mjs';
import { getPreflightStatus, runPreflight } from '../programmable/lib/preflight-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const node = process.execPath;
const providerNonce = '0x000000000000000000000000000000000000000000000000000000000000002a';

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

function sendJson(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

function capabilityResponse() {
  return {
    schemaVersion: 'programmable.custom-launch-capabilities.v4',
    chain: { id: '4663', caip2: 'eip155:4663' },
    chainDeploymentDescriptorDigest: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    chainDeployment: { schemaVersion: 'programmable.custom-launch-chain-deployment.v1', chainId: '4663', caip2: 'eip155:4663' },
    profile: { schemaVersion: 'programmable.custom-launch-profile-ref.v4', structuralProfileId: 'fixture-profile', profileDigest: 'sha256:fixture' },
    routes: {
      capabilities: '/v4/chains/4663/capabilities',
      preflight: '/v4/chains/4663/custom-launches/preflight',
      status: '/v4/chains/4663/custom-launches/{launchId}',
    },
    safety: { transactionBroadcast: false },
  };
}

function requestTemplate() {
  return {
    schemaVersion: 'programmable.custom-launch-create-request.v4',
    chainId: '4663',
    caip2: 'eip155:4663',
    chainDeployment: { schemaVersion: 'programmable.custom-launch-chain-deployment.v1', chainId: '4663', caip2: 'eip155:4663' },
    chainDeploymentDescriptorDigest: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    profile: { schemaVersion: 'programmable.custom-launch-profile-ref.v4', structuralProfileId: 'fixture-profile', profileDigest: 'sha256:fixture' },
    launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
    nonce: '0x1',
    permitWindow: { validAfter: '0', deadline: '1' },
    sourceDescriptor: { schemaVersion: '2.0.0', kind: 'deterministic-source-bundle', controllerWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729', sourceLineageNonce: '1', sourceBundleDigest: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', bundleContentSha256: 'sha256:fixture', publicOriginCommitment: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
    sourceBundleManifest: { schemaVersion: '2.0.0', entries: [] },
    externalContracts: [],
    graphBundle: { schemaVersion: 'programmable.custom-graph-bundle.v1', sourceBundleSha256: 'sha256:fixture', targets: [], pool: { tokenTargetId: 'token', hookTargetId: 'hook', fee: 0, tickSpacing: 60 } },
    projectMetadata: {},
    projectMetadataHash: 'sha256:fixture',
    projectMetadataImageArtifact: {},
    verificationBundle: { schemaVersion: 'programmable.exact-source-verification-bundle.v2', compilationUnits: [], components: [] },
    funding: { schemaVersion: 'programmable.custom-launch-funding-intent.v2', mode: 'none', valueWei: '0' },
    liquidityModel: { schemaVersion: 'programmable.custom-launch-liquidity-model.v1', model: 'project-provided-liquidity', declaredLaunchState: 'liquidity-required', targetIds: ['token', 'hook'] },
    launchIntentHash: 'sha256:fixture',
    agentAttestation: { schemaVersion: 'programmable.agent-launch-attestation.v2', subjectLaunchIntentHash: 'sha256:fixture', agentId: 'fixture', checkedAt: '2030-01-01T00:00:00.000Z', checks: [] },
  };
}

function requestContract() {
  return {
    additionalProperties: false,
    required: Object.keys(requestTemplate()),
    funding: { schemaVersion: 'programmable.custom-launch-funding-intent.v2', mode: ['none', 'wallet-transaction-value'] },
    verificationBundle: { schemaVersion: 'programmable.exact-source-verification-bundle.v2' },
  };
}

test('assembles the provider V4 request without the retired wrapper fields', () => {
  const request = assembleV4PreflightRequest({
    template: requestTemplate(),
    contract: requestContract(),
    capabilities: capabilityResponse(),
    pinnedCapabilities: capabilityResponse(),
    launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
    nonce: providerNonce,
    now: new Date('2030-01-01T00:00:00.000Z'),
  });

  assert.doesNotThrow(() => validateV4RequestContract(request, requestContract()));
  assert.equal(request.schemaVersion, 'programmable.custom-launch-create-request.v4');
  assert.equal(request.nonce, providerNonce);
  assert.equal(request.permitWindow.validAfter, '1893456000');
  assert.equal(request.permitWindow.deadline, '1893456900');
  assert.equal(Object.hasOwn(request, 'committedPackage'), false);
  assert.equal(Object.hasOwn(request, 'expected'), false);
});

test('the generated Phase 3 template rejects unresolved evidence before a provider POST', () => {
  const providerDocuments = JSON.parse(readFileSync(join(root, 'release/phase3/admission/provider-documents.json'), 'utf8'));
  const { request, unresolvedPaths } = materializePhaseThreeCreateRequest({ root });

  assert.ok(unresolvedPaths.includes('/chainDeployment'));
  assert.ok(unresolvedPaths.includes('/graphBundle/targets/0/applicantSalt'));
  assert.throws(
    () => validateV4RequestContract(request, providerDocuments.v4RequestContract),
    /request contains unresolved fields: \/chainDeployment/,
  );
});

test('requires a provider nonce rather than padding an RPC account nonce', () => {
  assert.equal(normalizeV4PreflightNonce(providerNonce), providerNonce);
  assert.throws(() => normalizeV4PreflightNonce('0x2a'), /lowercase bytes32/i);
  assert.throws(() => normalizeV4PreflightNonce(`0x${'0'.repeat(64)}`), /nonzero/i);
});

test('runPreflight rejects an RPC account nonce before a provider POST', async () => {
  const requestedUrls = [];
  const packageData = {
    request: requestTemplate(),
    contract: requestContract(),
    pinnedCapabilities: capabilityResponse(),
    launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
  };
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    if (String(url) === 'https://provider.example/v4/chains/4663/capabilities') {
      return new Response(JSON.stringify(capabilityResponse()), { status: 200 });
    }
    if (String(url) === 'https://rpc.example') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl: 'https://provider.example',
      rpcUrl: 'https://rpc.example',
      apiKey: 'test-api-key',
      packageData,
      fetchImpl,
    }),
    /lowercase bytes32/i,
  );
  assert.deepEqual(requestedUrls, [
    'https://provider.example/v4/chains/4663/capabilities',
    'https://rpc.example',
  ]);
});

test('preflight probe records a redacted request-response pair under its numbered probe ID', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));

  const result = await sendPreflightProbe({
    apiKey: 'test-api-key',
    request: requestTemplate(),
    probeId: '001',
    summary: 'The fixture records an invalid request without retaining credentials.',
    outputDirectory,
    now: () => new Date('2030-01-01T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.programmable.market/v4/chains/4663/custom-launches/preflight');
      assert.equal(options.headers.authorization, 'Bearer test-api-key');
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ error: { code: 'INVALID_REQUEST', apiKey: 'do-not-retain' } }), { status: 400 });
    },
  });

  assert.equal(result.httpStatus, 400);
  assert.equal(result.evidencePath, join(outputDirectory, '001.json'));
  const evidence = readFileSync(result.evidencePath, 'utf8');
  assert.match(evidence, /\"authorization\": \"\[REDACTED\]\"/);
  assert.match(evidence, /INVALID_REQUEST/);
  assert.doesNotMatch(evidence, /test-api-key|do-not-retain/);
});

test('preflight probe rejects an alternate API origin before sending credentials', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '001',
      summary: 'This fixture must not send a credential to an alternate origin.',
      outputDirectory,
      baseUrl: 'https://alternate.example',
      fetchImpl: async () => assert.fail('the provider must not be called'),
    }),
    /fixed provider origin/,
  );
});

test('preflight probe reserves its rate slot before issuing a request', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  let releaseFirstResponse;
  const fixedNow = () => new Date('2030-01-01T00:00:00.000Z');
  const first = sendPreflightProbe({
    apiKey: 'test-api-key',
    request: requestTemplate(),
    probeId: '001',
    summary: 'This request holds the rate slot until its evidence is recorded.',
    outputDirectory,
    now: fixedNow,
    fetchImpl: async () => new Promise((resolveResponse) => {
      releaseFirstResponse = () => resolveResponse(new Response('{}', { status: 400 }));
    }),
  });

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '002',
      summary: 'This concurrent request must not reach the provider.',
      outputDirectory,
      now: fixedNow,
      fetchImpl: async () => assert.fail('the provider must not be called'),
    }),
    /at least 10 seconds/,
  );
  releaseFirstResponse();
  await first;
});

test('preflight probe fails closed while a reservation lock exists', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  writeFileSync(join(outputDirectory, '.reservation.lock'), JSON.stringify({ pid: 999_999 }));

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '001',
      summary: 'This request must not recover a stale lock automatically.',
      outputDirectory,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      fetchImpl: async () => assert.fail('the provider must not be called'),
    }),
    /another preflight probe is reserving a request/,
  );
});

test('preflight probe records a redacted transport failure after reserving a request', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '001',
      summary: 'This fixture records a transport failure without retaining its cause.',
      outputDirectory,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      fetchImpl: async () => { throw new Error('test-api-key must not be retained'); },
    }),
    /transport failed/,
  );
  const evidence = JSON.parse(readFileSync(join(outputDirectory, '001.json'), 'utf8'));
  assert.deepEqual(evidence.response, {
    httpStatus: null,
    transportError: '[REDACTED_TRANSPORT_ERROR]',
  });
  assert.doesNotMatch(JSON.stringify(evidence), /test-api-key/);
  assert.equal(readdirSync(outputDirectory).some((entry) => entry.endsWith('.pending.json')), false);
});

test('preflight probe does not retain an unparsed provider response body', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));

  const result = await sendPreflightProbe({
    apiKey: 'test-api-key',
    request: requestTemplate(),
    probeId: '001',
    summary: 'The fixture supplies non-JSON text that must not be retained.',
    outputDirectory,
    now: () => new Date('2030-01-01T00:00:00.000Z'),
    fetchImpl: async () => new Response('api-key=do-not-retain', { status: 502 }),
  });

  assert.deepEqual(result.body, { unparsedBody: '[REDACTED_NON_JSON]', byteLength: 21 });
  assert.doesNotMatch(readFileSync(join(outputDirectory, '001.json'), 'utf8'), /do-not-retain/);
});

test('preflight probe refuses a second provider request inside the ten-second interval', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  writeFileSync(join(outputDirectory, '001.json'), JSON.stringify({ recordedAt: '2030-01-01T00:00:00.000Z' }));

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '002',
      summary: 'This request must not reach the provider.',
      outputDirectory,
      now: () => new Date('2030-01-01T00:00:09.999Z'),
      fetchImpl: async () => assert.fail('the provider must not be called'),
    }),
    /at least 10 seconds/,
  );
});

test('preflight probe preserves an existing numbered request-response pair', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  writeFileSync(join(outputDirectory, '001.json'), JSON.stringify({ recordedAt: '2030-01-01T00:00:00.000Z' }));

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '001',
      summary: 'This request must not overwrite recorded evidence.',
      outputDirectory,
      now: () => new Date('2030-01-01T00:00:10.000Z'),
      fetchImpl: async () => assert.fail('the provider must not be called'),
    }),
    /already exists/,
  );
});

test('preflight probe refuses to exceed the sixty-request budget', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-probe-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  for (let index = 1; index <= 60; index += 1) {
    writeFileSync(
      join(outputDirectory, `${String(index).padStart(3, '0')}.json`),
      JSON.stringify({ recordedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index * 10)).toISOString() }),
    );
  }

  await assert.rejects(
    () => sendPreflightProbe({
      apiKey: 'test-api-key',
      request: requestTemplate(),
      probeId: '061',
      summary: 'This request exceeds the fixed probe budget.',
      outputDirectory,
      now: () => new Date('2030-01-01T00:10:10.000Z'),
      fetchImpl: async () => assert.fail('the provider must not be called'),
    }),
    /maximum of 60/,
  );
});

test('runPreflight validates a direct request template before it can reach the provider', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  let preflightPosts = 0;
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') return sendJson(response, capabilityResponse());
    if (request.url === '/v4/chains/4663/custom-launches/preflight') {
      preflightPosts += 1;
      return sendJson(response, { error: { code: 'UNEXPECTED_POST' } }, 500);
    }
    return sendJson(response, { error: { code: 'NOT_FOUND' } }, 404);
  });
  t.after(() => server.close());
  const template = requestTemplate();
  delete template.launchIntentHash;

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      outputDirectory,
      packageData: {
        request: template,
        contract: requestContract(),
        pinnedCapabilities: capabilityResponse(),
        launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
      },
      nonce: providerNonce,
    }),
    /missing required property at \/launchIntentHash/,
  );
  assert.equal(preflightPosts, 0);
});

test('runPreflight does not require a status route it does not use', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const capabilities = capabilityResponse();
  delete capabilities.routes.status;
  let preflightPosts = 0;
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') return sendJson(response, capabilities);
    if (request.url === '/v4/chains/4663/custom-launches/preflight') {
      preflightPosts += 1;
      return sendJson(response, { error: { code: 'EXPECTED_REJECTION' } }, 400);
    }
    return sendJson(response, { error: { code: 'NOT_FOUND' } }, 404);
  });
  t.after(() => server.close());

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      outputDirectory,
      requestTemplate: requestTemplate(),
      contract: requestContract(),
      pinnedCapabilities: capabilityResponse(),
      launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
      nonce: providerNonce,
    }),
    /EXPECTED_REJECTION/,
  );
  assert.equal(preflightPosts, 1);
});

test('preflight and status reject provider routes outside the recorded API paths', async () => {
  const baseUrl = 'https://provider.example';
  const malformedPreflightCapabilities = capabilityResponse();
  malformedPreflightCapabilities.routes.preflight = 'https://attacker.example/preflight';
  const malformedStatusCapabilities = capabilityResponse();
  malformedStatusCapabilities.routes.status = 'https://attacker.example/status/{launchId}';
  const requestedUrls = [];
  let capabilityReads = 0;
  const fetchImpl = async (url) => {
    requestedUrls.push(String(url));
    if (String(url) === 'https://provider.example/v4/chains/4663/capabilities') {
      capabilityReads += 1;
      const body = capabilityReads === 1 ? malformedPreflightCapabilities : malformedStatusCapabilities;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const packageData = {
    request: requestTemplate(),
    contract: requestContract(),
    pinnedCapabilities: capabilityResponse(),
    launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
  };

  await assert.rejects(
    () => runPreflight({ root, baseUrl, apiKey: 'test-api-key', packageData, nonce: providerNonce, fetchImpl }),
    /preflight route/,
  );
  await assert.rejects(
    () => getPreflightStatus({ baseUrl, apiKey: 'test-api-key', requestId: 'request-1', fetchImpl }),
    /status route/,
  );
  assert.deepEqual(requestedUrls, [
    'https://provider.example/v4/chains/4663/capabilities',
    'https://provider.example/v4/chains/4663/capabilities',
  ]);
});

test('records the provider probe error when a required V4 field is missing', async (t) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-'));
  t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') return sendJson(response, capabilityResponse());
    assert.equal(request.url, '/v4/chains/4663/custom-launches/preflight');
    const body = JSON.parse(await readBody(request));
    delete body.launchIntentHash;
    return sendJson(response, {
      schemaVersion: 'programmable.api-error.v1',
      error: { code: 'INVALID_REQUEST', message: 'request has unknown or missing fields' },
    }, 400);
  });
  t.after(() => server.close());

  const error = await runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      outputDirectory,
      requestTemplate: requestTemplate(),
      contract: requestContract(),
      pinnedCapabilities: capabilityResponse(),
      launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
      nonce: providerNonce,
    }).then(() => assert.fail('expected the provider rejection'), (rejection) => rejection);
  assert.match(error.message, /INVALID_REQUEST/);
  assert.equal(readdirSync(outputDirectory).length, 1);
  const evidence = readFileSync(error.evidencePath, 'utf8');
  assert.doesNotMatch(evidence, /test-api-key/);
  assert.match(evidence, /INVALID_REQUEST/);
});

test('the dry-run requires public source flags and never prints the API key', () => {
  const result = spawnSync(node, ['scripts/programmable/preflight.mjs', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PROGRAMMABLE_API_KEY: 'test-api-key' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repository-url/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /test-api-key/);
});
