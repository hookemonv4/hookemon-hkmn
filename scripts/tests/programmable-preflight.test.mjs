import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assembleV4PreflightRequest,
  normalizeV4PublicSource,
  validateV4RequestContract,
} from '../programmable/lib/preflight-package.mjs';
import {
  materializePhaseThreeCreateRequest,
  normalizeV4PreflightNonce,
} from '../programmable/lib/create-request-materializer.mjs';
import {
  createV4LaunchAttempt,
  generateV4LaunchNonce,
  launchAttemptRequestBytes,
  readV4LaunchAttempt,
} from '../programmable/lib/launch-attempt.mjs';
import { derivePhaseThreeSourceBundleCoverage } from '../programmable/lib/source-bundle-coverage.mjs';
import { sendPreflightProbe } from '../programmable/lib/preflight-probe.mjs';
import { getPreflightStatus, runPreflight, v4PreflightEvidenceDirectory } from '../programmable/lib/preflight-runner.mjs';

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
    fundingPlan: {
      schemaVersion: 'programmable.robinhood-funding-plan.v1',
      capitalSource: 'creator-funded',
      pricingModel: 'concentrated-liquidity',
      nativeAllocations: { initialLiquidityWei: '0', initialBuyWei: '0', reserveWei: '0', otherLaunchValueWei: '0' },
      maxLaunchValueWei: '0',
      maxGasCostWei: '0',
      launchMode: 'build-only',
    },
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

function gitObject(expression) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', expression], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot resolve fixture Git object ${expression}`);
  return result.stdout.trim();
}

function sourceFixture() {
  return {
    repositoryUrl: 'https://example.invalid/example-org/example-repo',
    sourceCommit: gitObject('HEAD'),
    sourceTree: gitObject('HEAD^{tree}'),
  };
}

function completeFixtureSourceBundleCoverage() {
  return {
    schemaVersion: 'hookemon.phase3.source-bundle-coverage.v1',
    sourcePaths: ['packages/contracts/src/HookemonHook.sol'],
    standardJsonInputPaths: ['release/phase3/build-info/launch.json'],
    compilerArtifactPaths: ['release/phase3/artifacts/hook.json'],
    attestationEvidencePaths: ['release/phase3/package/create-request.json'],
    metadataImagePath: 'release/phase3/package/graph-draft.json',
    unresolved: [],
  };
}

function preflightPackageFixture(request = requestTemplate()) {
  return {
    request,
    contract: requestContract(),
    pinnedCapabilities: capabilityResponse(),
    launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
    sourceBundleCoverage: completeFixtureSourceBundleCoverage(),
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

test('requires exact public Git object IDs for V4 source provenance', () => {
  const source = sourceFixture();
  assert.deepEqual(normalizeV4PublicSource(root, source), source);
  assert.throws(
    () => normalizeV4PublicSource(root, { ...source, sourceCommit: 'HEAD' }),
    /exact lowercase HEAD object ID/i,
  );
  assert.throws(
    () => normalizeV4PublicSource(root, { ...source, sourceTree: root }),
    /exact lowercase HEAD tree object ID/i,
  );
});

test('persists one random provider nonce and the canonical request bytes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-launch-attempt-'));
  const path = join(directory, 'launch-attempt.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const source = {
    repositoryUrl: 'https://example.invalid/example-org/example-repo',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
  };
  const record = createV4LaunchAttempt({
    path,
    source,
    request: { z: ['last'], a: 'first', nonce: `0x${'2a'.repeat(32)}` },
    providerDocuments: { v4RequestContract: {} },
    newLaunchAttempt: true,
    randomBytes: () => Buffer.alloc(32, 0x2a),
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });

  assert.equal(record.nonce, `0x${'2a'.repeat(32)}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(record.idempotency, {
    headerName: null,
    key: null,
    reason: 'no idempotency header is defined by the recorded V4 contract',
  });
  assert.equal(launchAttemptRequestBytes(record).toString('utf8'), `{"a":"first","nonce":"0x${'2a'.repeat(32)}","z":["last"]}`);
  assert.deepEqual(readV4LaunchAttempt(path), record);
  assert.throws(
    () => createV4LaunchAttempt({ path, source, request: { a: 'changed' }, providerDocuments: { v4RequestContract: {} } }),
    /already exists/i,
  );
  assert.throws(
    () => createV4LaunchAttempt({
      path,
      source,
      request: { a: 'replacement' },
      providerDocuments: { v4RequestContract: {} },
      newLaunchAttempt: true,
    }),
    /already exists/i,
  );
  assert.throws(
    () => createV4LaunchAttempt({
      path: join(directory, 'missing.json'),
      source,
      request: { a: 'new' },
      providerDocuments: { v4RequestContract: {} },
    }),
    /new-launch-attempt/i,
  );
  chmodSync(path, 0o644);
  assert.throws(() => readV4LaunchAttempt(path), /permissions/i);
  chmodSync(path, 0o600);
  const linkedPath = join(directory, 'linked-attempt.json');
  symlinkSync(path, linkedPath);
  assert.throws(() => readV4LaunchAttempt(linkedPath), /symlink/i);
  assert.throws(
    () => createV4LaunchAttempt({
      path: linkedPath,
      source,
      request: { a: 'replacement' },
      providerDocuments: { v4RequestContract: {} },
      newLaunchAttempt: true,
    }),
    /symlink/i,
  );
  const inconsistentRecord = { ...record, nonce: `0x${'2b'.repeat(32)}` };
  writeFileSync(path, JSON.stringify(inconsistentRecord));
  assert.throws(() => readV4LaunchAttempt(path), /request nonce does not match/i);
  const invalidUtf8Bytes = Buffer.concat([
    Buffer.from(`{"nonce":"${record.nonce}","value":"`, 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('"}', 'utf8'),
  ]);
  const invalidUtf8Record = {
    ...record,
    request: {
      encoding: 'base64',
      sha256: `sha256:${createHash('sha256').update(invalidUtf8Bytes).digest('hex')}`,
      base64: invalidUtf8Bytes.toString('base64'),
    },
  };
  writeFileSync(path, JSON.stringify(invalidUtf8Record));
  assert.throws(() => readV4LaunchAttempt(path), /RFC 8785 canonical JSON/i);
  assert.throws(() => generateV4LaunchNonce({ randomBytes: () => Buffer.alloc(32) }), /all-zero/i);
});

test('runPreflight preserves a launch attempt across a retry without consulting RPC', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-attempt-'));
  const launchAttemptPath = join(directory, 'launch-attempt.json');
  const outputDirectory = join(directory, 'evidence');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requestBodies = [];
  const packageData = preflightPackageFixture();
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') return sendJson(response, capabilityResponse());
    if (request.url === '/rpc') {
      assert.fail('the V4 preflight nonce must not be read from RPC');
    }
    if (request.url === '/v4/chains/4663/custom-launches/preflight') {
      requestBodies.push(Buffer.from(await readBody(request), 'utf8'));
      return sendJson(response, { error: { code: 'RETRYABLE_FIXTURE' } }, 400);
    }
    return sendJson(response, { error: { code: 'NOT_FOUND' } }, 404);
  });
  t.after(() => server.close());

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      rpcUrl: `${baseUrl}/rpc`,
      apiKey: 'test-api-key',
      packageData,
      source: sourceFixture(),
      launchAttemptPath,
      outputDirectory,
      newLaunchAttempt: true,
      randomBytes: () => Buffer.alloc(32, 0x2a),
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    }),
    /RETRYABLE_FIXTURE/,
  );
  const firstRecord = readFileSync(launchAttemptPath, 'utf8');

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      rpcUrl: `${baseUrl}/rpc`,
      apiKey: 'test-api-key',
      packageData,
      source: sourceFixture(),
      launchAttemptPath,
      outputDirectory,
      now: () => new Date('2030-01-02T00:00:00.000Z'),
    }),
    /RETRYABLE_FIXTURE/,
  );

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[1], requestBodies[0]);
  assert.deepEqual(launchAttemptRequestBytes(readV4LaunchAttempt(launchAttemptPath)), requestBodies[0]);
  assert.equal(readFileSync(launchAttemptPath, 'utf8'), firstRecord);
});

test('a retry rejects changed pinned capabilities before the immutable request is resent', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-capabilities-'));
  const launchAttemptPath = join(directory, 'launch-attempt.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const changedCapabilities = capabilityResponse();
  changedCapabilities.profile.profileDigest = 'sha256:changed';
  let capabilityReads = 0;
  let preflightPosts = 0;
  const { server, baseUrl } = await startServer(async (request, response) => {
    if (request.url === '/v4/chains/4663/capabilities') {
      capabilityReads += 1;
      return sendJson(response, capabilityReads === 1 ? capabilityResponse() : changedCapabilities);
    }
    if (request.url === '/v4/chains/4663/custom-launches/preflight') {
      preflightPosts += 1;
      return sendJson(response, { error: { code: 'FIXTURE_RETRY' } }, 400);
    }
    return sendJson(response, { error: { code: 'NOT_FOUND' } }, 404);
  });
  t.after(() => server.close());
  const options = {
    root,
    baseUrl,
    apiKey: 'test-api-key',
    source: sourceFixture(),
    launchAttemptPath,
    packageData: preflightPackageFixture(),
    randomBytes: () => Buffer.alloc(32, 0x2a),
  };

  await assert.rejects(() => runPreflight({ ...options, newLaunchAttempt: true }), /FIXTURE_RETRY/);
  await assert.rejects(() => runPreflight(options), /does not match committed provider evidence/i);
  assert.equal(preflightPosts, 1);
});

test('preflight requires an explicit external path for a new launch attempt', async (t) => {
  const externalDirectory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-path-'));
  const externalPath = join(externalDirectory, 'launch-attempt.json');
  t.after(() => rmSync(externalDirectory, { recursive: true, force: true }));
  const packageData = preflightPackageFixture();
  const fetchImpl = async () => assert.fail('a local path or missing flag must fail before a provider request');

  await assert.rejects(
    () => runPreflight({
      root,
      apiKey: 'test-api-key',
      source: sourceFixture(),
      packageData,
      launchAttemptPath: join(root, '.preflight-attempt-fixture.json'),
      newLaunchAttempt: true,
      fetchImpl,
    }),
    /outside the repository/i,
  );
  await assert.rejects(
    () => runPreflight({
      root,
      apiKey: 'test-api-key',
      source: sourceFixture(),
      packageData,
      launchAttemptPath: externalPath,
      fetchImpl,
    }),
    /new-launch-attempt/i,
  );
  const linkedRoot = join(externalDirectory, 'linked-root');
  symlinkSync(root, linkedRoot);
  await assert.rejects(
    () => runPreflight({
      root: linkedRoot,
      apiKey: 'test-api-key',
      source: sourceFixture(),
      packageData,
      launchAttemptPath: join(root, '.preflight-attempt-fixture.json'),
      newLaunchAttempt: true,
      fetchImpl,
    }),
    /outside the repository/i,
  );
  const linkedRepository = join(externalDirectory, 'linked-repository');
  symlinkSync(root, linkedRepository);
  await assert.rejects(
    () => runPreflight({
      root,
      apiKey: 'test-api-key',
      source: sourceFixture(),
      packageData,
      launchAttemptPath: join(linkedRepository, 'launch-attempt.json'),
      newLaunchAttempt: true,
      fetchImpl,
    }),
    /outside the repository/i,
  );
});

test('preflight and status request redirect rejection from every provider route', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-redirect-'));
  const launchAttemptPath = join(directory, 'launch-attempt.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const redirects = [];
  const fetchImpl = async (url, options = {}) => {
    redirects.push({ url: String(url), redirect: options.redirect });
    if (String(url).endsWith('/capabilities')) return new Response(JSON.stringify(capabilityResponse()), { status: 200 });
    if (String(url).endsWith('/preflight')) return new Response(JSON.stringify({ error: { code: 'FIXTURE_REDIRECT' } }), { status: 400 });
    if (String(url).endsWith('/request-1')) return new Response(JSON.stringify({ state: 'queued' }), { status: 200 });
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl: 'https://provider.example',
      apiKey: 'test-api-key',
      source: sourceFixture(),
      launchAttemptPath,
      newLaunchAttempt: true,
      packageData: preflightPackageFixture(),
      randomBytes: () => Buffer.alloc(32, 0x2a),
      fetchImpl,
    }),
    /FIXTURE_REDIRECT/,
  );
  await getPreflightStatus({
    baseUrl: 'https://provider.example', apiKey: 'test-api-key', requestId: 'request-1', fetchImpl,
  });
  assert.ok(redirects.length >= 4);
  assert.ok(redirects.every(({ redirect }) => redirect === 'error'));
});

test('runPreflight refuses incomplete source coverage before a provider POST', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-coverage-'));
  const outputDirectory = join(directory, 'evidence');
  const launchAttemptPath = join(directory, 'launch-attempt.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      packageData: {
        ...preflightPackageFixture(),
        sourceBundleCoverage: derivePhaseThreeSourceBundleCoverage({ root }),
      },
      source: sourceFixture(),
      outputDirectory,
      launchAttemptPath,
      newLaunchAttempt: true,
    }),
    /source bundle coverage is incomplete/i,
  );
  assert.equal(preflightPosts, 0);
  assert.equal(existsSync(launchAttemptPath), false);
});

test('runPreflight caps an attempt before a sixth provider POST', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-budget-'));
  const launchAttemptPath = join(directory, 'launch-attempt.json');
  const outputDirectory = v4PreflightEvidenceDirectory(launchAttemptPath, `0x${'2a'.repeat(32)}`);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  for (let index = 1; index <= 5; index += 1) writeFileSync(join(outputDirectory, `${index}.json`), '{}\n');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      packageData: preflightPackageFixture(),
      source: sourceFixture(),
      launchAttemptPath,
      newLaunchAttempt: true,
      randomBytes: () => Buffer.alloc(32, 0x2a),
    }),
    /at most 5 preflight requests/i,
  );
  assert.equal(preflightPosts, 0);
});

test('preflight reserves the fifth slot before a concurrent sixth provider POST', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-reservation-'));
  const launchAttemptPath = join(directory, 'launch-attempt.json');
  const evidenceDirectory = v4PreflightEvidenceDirectory(launchAttemptPath, `0x${'2a'.repeat(32)}`);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  for (let index = 1; index <= 4; index += 1) writeFileSync(join(evidenceDirectory, `${index}.json`), '{}\n');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let releaseFirstPost;
  let signalFirstPost;
  const firstPostStarted = new Promise((resolveFirstPost) => { signalFirstPost = resolveFirstPost; });
  let preflightPosts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/capabilities')) return new Response(JSON.stringify(capabilityResponse()), { status: 200 });
    if (String(url).endsWith('/preflight')) {
      preflightPosts += 1;
      signalFirstPost();
      return new Promise((resolvePost) => {
        releaseFirstPost = () => resolvePost(new Response(JSON.stringify({ error: { code: 'FIXTURE_RESERVATION' } }), { status: 400 }));
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const options = {
    root,
    baseUrl: 'https://provider.example',
    apiKey: 'test-api-key',
    source: sourceFixture(),
    launchAttemptPath,
    packageData: preflightPackageFixture(),
    randomBytes: () => Buffer.alloc(32, 0x2a),
    fetchImpl,
  };
  const first = runPreflight({ ...options, newLaunchAttempt: true });
  await firstPostStarted;
  await assert.rejects(() => runPreflight(options), /at most 5 preflight requests/i);
  assert.equal(preflightPosts, 1);
  releaseFirstPost();
  await assert.rejects(() => first, /FIXTURE_RESERVATION/);
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
      launchAttemptPath: join(outputDirectory, 'launch-attempt.json'),
      newLaunchAttempt: true,
      source: sourceFixture(),
      packageData: preflightPackageFixture(template),
      randomBytes: () => Buffer.alloc(32, 0x2a),
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
      launchAttemptPath: join(outputDirectory, 'launch-attempt.json'),
      newLaunchAttempt: true,
      source: sourceFixture(),
      packageData: preflightPackageFixture(),
      randomBytes: () => Buffer.alloc(32, 0x2a),
    }),
    /EXPECTED_REJECTION/,
  );
  assert.equal(preflightPosts, 1);
});

test('preflight and status reject provider routes outside the recorded API paths', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-preflight-routes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  const packageData = preflightPackageFixture();

  await assert.rejects(
    () => runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      packageData,
      source: sourceFixture(),
      launchAttemptPath: join(directory, 'launch-attempt.json'),
      newLaunchAttempt: true,
      fetchImpl,
    }),
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
      error: { code: 'INVALID_REQUEST', message: 'request contains test-api-key and unknown fields' },
    }, 400);
  });
  t.after(() => server.close());

  const error = await runPreflight({
      root,
      baseUrl,
      apiKey: 'test-api-key',
      launchAttemptPath: join(outputDirectory, 'launch-attempt.json'),
      newLaunchAttempt: true,
      source: sourceFixture(),
      packageData: preflightPackageFixture(),
      randomBytes: () => Buffer.alloc(32, 0x2a),
    }).then(() => assert.fail('expected the provider rejection'), (rejection) => rejection);
  assert.match(error.message, /INVALID_REQUEST/);
  assert.doesNotMatch(error.message, /test-api-key/);
  const evidenceDirectory = v4PreflightEvidenceDirectory(join(outputDirectory, 'launch-attempt.json'), `0x${'2a'.repeat(32)}`);
  assert.equal(readdirSync(evidenceDirectory).length, 1);
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
