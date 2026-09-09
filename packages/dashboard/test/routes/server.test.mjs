import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { appendAuditEntry, readAllAuditEntries } from '../../src/auth/audit-log.mjs';
import { normalizePublicCycleStatus } from '../../src/contracts/public-cycle-status.mjs';
import { normalizePublicCommunitySnapshot } from '../../src/contracts/public-community-snapshot.mjs';
import { buildContext, createRequestListener, readEnvironmentConfig } from '../../src/server.mjs';
import { openSqliteProjection } from '../../src/storage/sqlite-projection.mjs';
import { createOperatorControl } from '../../../runner/src/operator/control.mjs';
import { createDefaultOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
import { OPERATOR_HARD_CAPS, createEmptyOperatorState, mutateOperatorState, readOperatorState } from '../../../runner/src/operator/state-file.mjs';

const CREDENTIAL = 'a'.repeat(40);
const AUTH = { 'x-hookemon-proxy-credential': CREDENTIAL };

function configuration(overrides = {}) {
  return {
    intervalMinutes: 20,
    allowedPackIds: ['base-pack'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: '100',
    maxCycleBudgetMicroUsd: '100',
    max24HourBudgetMicroUsd: '100',
    paused: false,
    executionPaused: false,
    killSwitch: false,
    liveMode: false,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsd: '100',
    lossCapMicroUsd: '100',
    maxOutstandingCustodyMicroUsd: '100',
    manualApprovalCycles: 0,
    configurationRevision: 0,
    ...overrides,
  };
}

function status(revision, config = configuration()) {
  return {
    revision,
    configuration: config,
    activeCycleId: 'cycle-one',
    cycles: [{
      cycleId: 'cycle-one',
      terminalState: null,
      stages: [{ stage: 'claim-process', status: 'COMPLETE' }, { stage: 'payout', status: 'PENDING' }],
      requests: [{ stage: 'claim-process', state: 'PREPARED', requestDigest: `sha256:${'c'.repeat(64)}` }],
      payout: { status: 'PENDING' },
      transactionIds: null,
    }],
    cap: {
      offChain24Hour: { usedMicroUsd: '40', limitMicroUsd: '100', remainingMicroUsd: '60' },
      loss: null,
      outstandingCustody: null,
      onChainRemainingCapacity: null,
    },
    custody: { buckets: [] },
    alertSources: { safetyTelemetry: false },
    alerts: [],
  };
}

async function buildTestServer(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-routes-'));
  const auditLogPath = join(directory, 'audit.log');
  const sqliteProjection = openSqliteProjection(':memory:');
  let revision = 0;
  let currentConfiguration = configuration();
  const calls = { status: 0, execute: [], errors: [] };
  const authority = {
    async status() {
      calls.status += 1;
      return status(revision, currentConfiguration);
    },
    async execute(input) {
      calls.execute.push(input);
      revision += 1;
      if (input.command.type === 'pause') currentConfiguration = configuration({ paused: true, executionPaused: true });
      if (input.command.type === 'resume') currentConfiguration = configuration({ paused: false, executionPaused: false });
      if (input.command.type === 'kill') currentConfiguration = configuration({ paused: true, executionPaused: true, killSwitch: true });
      if (input.command.type === 'update-configuration') {
        currentConfiguration = configuration({
          ...currentConfiguration,
          ...input.command.configuration,
          configurationRevision: currentConfiguration.configurationRevision + 1,
        });
      }
      return { action: input.command.type, revision, configuration: currentConfiguration };
    },
  };
  const ctx = {
    onError: (operation, error) => calls.errors.push({ operation, message: error.message }),
    profileId: 'mainnet',
    proxyCredential: CREDENTIAL,
    operatorControl: authority,
    sqliteProjection,
    auditLogPath,
    now: () => Date.UTC(2026, 0, 1),
    ...overrides,
  };
  const listener = createRequestListener(ctx);
  t.after(async () => {
    sqliteProjection.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function request(path, { method = 'GET', headers = {}, body = null } = {}) {
    const req = Object.assign(
      Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]),
      { method, url: path, headers },
    );
    let status = null;
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(nextStatus) { status = nextStatus; this.headersSent = true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); },
    };
    await listener(req, res);
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { status, body: parsed, diagnostics: JSON.stringify(calls.errors) };
  }
  return {
    ctx,
    calls,
    get(path, headers) { return request(path, { headers }); },
    post(path, body, headers) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    },
  };
}

test('health and public projections remain unauthenticated, query-free, and contract-valid', async (t) => {
  const server = await buildTestServer(t);
  const health = await server.get('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });

  const cycle = await server.get('/public/api/cycle-status');
  assert.equal(cycle.status, 200);
  assert.doesNotThrow(() => normalizePublicCycleStatus(cycle.body, 'mainnet'));
  assert.doesNotMatch(JSON.stringify(cycle.body).toLowerCase(), /signer|privatekey|digest/);
  assert.equal((await server.get('/public/api/cycle-status?x=1')).status, 400);

  const community = await server.get('/public/api/community-dashboard');
  assert.equal(community.status, 200);
  assert.doesNotThrow(() => normalizePublicCommunitySnapshot(community.body, 'mainnet'));
});

test('operator routes require the proxy credential before every authority or projection access', async (t) => {
  const server = await buildTestServer(t);
  for (const path of [
    '/operator/api/bootstrap', '/operator/api/dashboard', '/operator/api/cards', '/operator/api/packs',
    '/operator/api/identities', '/operator/api/audit',
  ]) {
    const result = await server.get(path);
    assert.equal(result.status, 401, path);
    assert.equal(result.body.code, 'PROXY_CREDENTIAL_REQUIRED');
  }
  assert.equal((await server.get('/operator/api/bootstrap', { 'x-hookemon-proxy-credential': 'b'.repeat(40) })).status, 401);
});

test('bootstrap accepts the proxy credential and an optional valid Access assertion', async (t) => {
  const server = await buildTestServer(t, { accessJwtVerifier: async () => ({ email: 'operator-console' }) });
  const missing = await server.get('/operator/api/bootstrap', AUTH);
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'ACCESS_ASSERTION_REQUIRED');
  const result = await server.get('/operator/api/bootstrap', { ...AUTH, 'cf-access-jwt-assertion': 'token' });
  assert.equal(result.status, 200, result.diagnostics);
  assert.equal(result.body.identity.email, 'operator-console');
  assert.equal(result.body.state.desiredStatus, 'active');
});

test('bootstrap projects only its published hard caps when runner custody caps are present', async t => {
  assert.equal(OPERATOR_HARD_CAPS.maxHeldPositions, '10');
  const server = await buildTestServer(t);
  const result = await server.get('/operator/api/bootstrap', AUTH);
  assert.equal(result.status, 200, result.diagnostics);
  const fields = ['maxBoostersPerCycle', 'maxUnitPriceMicroUsd', 'maxCycleBudgetMicroUsd', 'max24HourBudgetMicroUsd'];
  assert.deepEqual(result.body.hardCaps, Object.fromEntries(fields.map(field => [field, OPERATOR_HARD_CAPS[field]])));
});

test('authority mutations appear in the next bootstrap view and its durable audit projection', async (t) => {
  const server = await buildTestServer(t);
  const pause = await server.post('/operator/api/decisions', {
    requestId: 'pause-status', expectedVersion: 0, command: { type: 'pause' },
  }, AUTH);
  assert.equal(pause.status, 200);
  assert.equal(pause.body.state.desiredStatus, 'paused');
  const audit = await server.get('/operator/api/audit', AUTH);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.decisions[0].action, 'pause');
  assert.equal(audit.body.decisions[0].requestId, 'pause-status');

  const configured = await server.post('/operator/api/decisions', {
    requestId: 'config-status',
    expectedVersion: 1,
    command: { type: 'update-configuration', configuration: { intervalMinutes: 30, requestedOrders: 2 } },
  }, AUTH);
  assert.equal(configured.status, 200);
  const bootstrap = await server.get('/operator/api/bootstrap', AUTH);
  assert.equal(bootstrap.body.state.cycleIntervalMinutes, 30);
  assert.deepEqual(bootstrap.body.state.manualPackOrders, [{ productId: 'base-pack', quantity: 2 }]);
});

test('run-cycle-now invokes the authority once and retains its precomputed receipt code', async (t) => {
  const server = await buildTestServer(t);
  const result = await server.post('/operator/api/decisions', {
    requestId: 'run-now', expectedVersion: 0, command: { type: 'run-cycle-now' },
  }, AUTH);
  assert.equal(result.status, 200, result.diagnostics);
  assert.equal(result.body.code, 'TICK_TRIGGERED');
  assert.deepEqual(server.calls.execute, [{ expectedRevision: 0, requestId: 'run-now', command: { type: 'run-cycle-now' } }]);
});

test('cards, packs, identities, static controls, and unknown paths preserve their route contracts', async (t) => {
  const server = await buildTestServer(t, {
    identities: Object.freeze({ vaultAddress: '0xabc', collectorCryptConfigured: false }),
    listPacks: async () => ({ machines: [{
      code: 'base-pack', name: 'Base pack', shortName: 'Base', price: 1,
      public: true, instantBuyback: false, turboMode: false, image: 'private',
    }] }),
  });
  assert.equal((await server.get('/operator/api/cards?bogus=1', AUTH)).status, 400);
  assert.deepEqual((await server.get('/operator/api/identities', AUTH)).body, {
    identities: { vaultAddress: '0xabc', collectorCryptConfigured: false },
  });
  const packs = await server.get('/operator/api/packs', AUTH);
  assert.equal(packs.status, 200);
  assert.equal(packs.body.machines[0].image, undefined);
  assert.equal((await server.get('/operator/api/packs?x=1', AUTH)).status, 400);
  const page = await server.get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /id="pauseBtn"/);
  assert.match(page.body, /id="manualApprovalBtn"/);
  assert.equal((await server.get('/nope')).status, 404);
});

test('owner dashboard read projections use the injected authority and expose the configured network', async (t) => {
  const server = await buildTestServer(t, {
    identities: { operationsEvm: '0xabc', operationsSolana: 'PublicSolanaIdentity' },
  });
  const dashboard = await server.get('/operator/api/dashboard', AUTH);
  assert.equal(dashboard.status, 200, dashboard.diagnostics);
  assert.equal(dashboard.body.cycles[0].cycleId, 'cycle-one');
  assert.equal(dashboard.body.cap.offChain24Hour.remainingMicroUsd, '60');
  assert.deepEqual((await server.get('/operator/api/identities', AUTH)).body, {
    identities: { operationsEvm: '0xabc', operationsSolana: 'PublicSolanaIdentity' },
  });
  assert.deepEqual((await server.get('/operator/api/network', AUTH)).body, { profile: 'mainnet' });
  assert.equal(server.calls.status, 1);
});

test('owner dashboard projects cycles and custody from an authority built with an injected repository', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cycleId = 'cycle-repository';
  const authority = createOperatorControl({
    statePath: join(directory, 'operator-state.json'),
    cycleRepository: {
      async peekActiveCycle() { return { cycleId }; },
      async listKnownCycleIds() { return [cycleId]; },
      async describeCycle() {
        return {
          releaseAmount: '7', terminalState: null, version: 0, heldEvidenceDigest: null, ownerDecision: null,
          stages: { 'claim-process': { status: 'COMPLETE' }, payout: { status: 'PENDING' } },
          operationalAttempts: {},
          custodyLedgers: { main: { cycleId, chainId: '4663', assetId: 'asset', decimals: 6, ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(name => [name, '0'])) } },
        };
      },
    },
    policyEngine: { async recordManualApproval() { return { approved: true }; } },
  });
  const server = await buildTestServer(t, { operatorControl: authority });
  const result = await server.get('/operator/api/dashboard', AUTH);
  assert.equal(result.status, 200, result.diagnostics);
  assert.equal(result.body.cycles[0].cycleId, cycleId);
  assert.equal(result.body.custody.buckets[0].cycleId, cycleId);
  assert.equal(result.body.custody.buckets[0].buckets.claimed.amountAtomic, '0');
});

test('the dashboard route table has one mutation endpoint', async () => {
  const source = await readFile(join(process.cwd(), 'packages/dashboard/src/server.mjs'), 'utf8');
  const postRoutes = [...source.matchAll(/\['[^']+', \{ POST:/g)];
  assert.equal(postRoutes.length, 1);
  assert.match(postRoutes[0][0], /\/operator\/api\/decisions/);
});

test('authority-backed dashboard and public status never read a cycle from the state file', async (t) => {
  const server = await buildTestServer(t, {
    readOperatorState: async () => { throw new Error('state-file cycle read is forbidden'); },
  });
  const dashboard = await server.get('/operator/api/dashboard', AUTH);
  assert.equal(dashboard.status, 200, dashboard.diagnostics);
  assert.equal(dashboard.body.activeCycle.cycleId, 'cycle-one');
  assert.equal(dashboard.body.cycles[0].requests[0].requestDigest, `sha256:${'c'.repeat(64)}`);
  assert.equal(dashboard.body.cap.offChain24Hour.remainingMicroUsd, '60');
  const publicStatus = await server.get('/public/api/cycle-status');
  assert.equal(publicStatus.status, 200);
  assert.doesNotThrow(() => normalizePublicCycleStatus(publicStatus.body, 'mainnet'));
  assert.ok(server.calls.status >= 2);
});

test('a duplicate request writes one pre-effect audit receipt, one terminal receipt, and calls authority once', async (t) => {
  let auditVisibleBeforeEffect = false;
  const server = await buildTestServer(t);
  const originalExecute = server.ctx.operatorControl.execute;
  server.ctx.operatorControl.execute = async input => {
    const records = await readAllAuditEntries(server.ctx.auditLogPath);
    auditVisibleBeforeEffect = records.length === 1
      && records[0].resultCode === 'COMMAND_PREPARED'
      && records[0].commandState === 'PREPARED';
    return originalExecute(input);
  };
  const request = { requestId: 'pause-once', expectedVersion: 0, command: { type: 'pause' } };
  const first = await server.post('/operator/api/decisions', request, AUTH);
  const replay = await server.post('/operator/api/decisions', request, AUTH);
  assert.equal(first.status, 200);
  assert.equal(first.body.code, 'DECISION_ACCEPTED');
  assert.equal(first.body.replayed, false);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.receipt, first.body.receipt);
  assert.equal(server.calls.execute.length, 1);
  assert.equal(auditVisibleBeforeEffect, true);
  const records = await readAllAuditEntries(server.ctx.auditLogPath);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.commandState), ['PREPARED', 'APPLIED']);
  assert.ok(records.every(record => record.requestId === 'pause-once'));
});

test('an unresolved command stays uncertain on retry instead of becoming a replayed success', async (t) => {
  let effects = 0;
  const server = await buildTestServer(t);
  server.ctx.operatorControl.execute = async () => {
    effects += 1;
    throw new Error('authority response was lost');
  };
  const request = { requestId: 'pause-uncertain', expectedVersion: 0, command: { type: 'pause' } };

  const first = await server.post('/operator/api/decisions', request, AUTH);
  const retry = await server.post('/operator/api/decisions', request, AUTH);

  assert.equal(first.status, 503);
  assert.equal(first.body.code, 'COMMAND_UNCERTAIN');
  assert.equal(first.body.commandState, 'UNCERTAIN');
  assert.equal(retry.status, 503);
  assert.equal(retry.body.code, 'COMMAND_UNCERTAIN');
  assert.equal(retry.body.commandState, 'UNCERTAIN');
  assert.equal(effects, 1);
  assert.deepEqual(
    (await readAllAuditEntries(server.ctx.auditLogPath)).map(entry => entry.commandState),
    ['PREPARED', 'UNCERTAIN'],
  );
});

test('the HTTP control path records cap-plus-one and stale-revision refusals as rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-hard-cap-'));
  const statePath = join(directory, 'operator-state.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mutateOperatorState(statePath, null, () => ({
    ...createEmptyOperatorState(),
    configuration: createDefaultOperatorConfiguration(),
  }));
  const authority = createOperatorControl({
    statePath,
    cycleRepository: {
      async peekActiveCycle() { return null; },
      async listKnownCycleIds() { return []; },
      async describeCycle() { throw new Error('not used'); },
    },
    policyEngine: { async recordManualApproval() { throw new Error('not used'); } },
    readCustody: async () => ({
      realizedLossMicroUsd: '0',
      atRiskMicroUsd: '0',
      outstandingMicroUsd: '0',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
    }),
  });
  const server = await buildTestServer(t, { operatorControl: authority });

  const result = await server.post('/operator/api/decisions', {
    requestId: 'hard-cap-plus-one',
    expectedVersion: 0,
    command: {
      type: 'update-configuration',
      configuration: {
        maxUnitPriceMicroUsd: (BigInt(OPERATOR_HARD_CAPS.maxUnitPriceMicroUsd) + 1n).toString(),
        maxCycleBudgetMicroUsd: OPERATOR_HARD_CAPS.maxCycleBudgetMicroUsd,
        max24HourBudgetMicroUsd: OPERATOR_HARD_CAPS.max24HourBudgetMicroUsd,
      },
    },
  }, AUTH);

  assert.equal(result.status, 409, result.diagnostics);
  assert.equal(result.body.code, 'COMMAND_REJECTED');
  assert.equal(result.body.commandState, 'REJECTED');
  assert.equal((await readOperatorState(statePath)).configuration.maxUnitPriceMicroUsd, '0');

  const stale = await server.post('/operator/api/decisions', {
    requestId: 'stale-revision', expectedVersion: 1, command: { type: 'pause' },
  }, AUTH);
  assert.equal(stale.status, 409, stale.diagnostics);
  assert.equal(stale.body.code, 'COMMAND_REJECTED');
  assert.equal(stale.body.commandState, 'REJECTED');
  assert.equal((await readOperatorState(statePath)).configuration.paused, false);
  assert.deepEqual(
    (await readAllAuditEntries(server.ctx.auditLogPath)).map(entry => entry.commandState),
    ['PREPARED', 'REJECTED', 'PREPARED', 'REJECTED'],
  );
});

test('reusing a request id with another command is rejected without another authority call', async (t) => {
  const server = await buildTestServer(t);
  await server.post('/operator/api/decisions', { requestId: 'same-id', expectedVersion: 0, command: { type: 'pause' } }, AUTH);
  const conflict = await server.post('/operator/api/decisions', { requestId: 'same-id', expectedVersion: 0, command: { type: 'kill' } }, AUTH);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'AUDIT_REQUEST_ID_CONFLICT');
  assert.equal(server.calls.execute.length, 1);
});

test('reconcile maps to one read-only authority command', async (t) => {
  const server = await buildTestServer(t);
  const result = await server.post('/operator/api/decisions', { requestId: 'reconcile-1', expectedVersion: 0, command: { type: 'reconcile' } }, AUTH);
  assert.equal(result.status, 200, result.diagnostics);
  assert.deepEqual(server.calls.execute, [{ expectedRevision: 0, requestId: 'reconcile-1', command: { type: 'reconcile' } }]);
});

test('a standalone listener without an authority does not emulate an effect', async (t) => {
  const server = await buildTestServer(t, { operatorControl: null });
  const result = await server.post('/operator/api/decisions', { requestId: 'unavailable-1', expectedVersion: 0, command: { type: 'pause' } }, AUTH);
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'OPERATOR_CONTROL_UNAVAILABLE');
  assert.deepEqual(await readAllAuditEntries(server.ctx.auditLogPath), []);
});

test('operator endpoints reject requests without the proxy credential', async (t) => {
  const server = await buildTestServer(t);
  const result = await server.get('/operator/api/dashboard');
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'PROXY_CREDENTIAL_REQUIRED');
});

test('standalone configuration defaults to the mainnet profile', () => {
  const config = readEnvironmentConfig({
    HOOKEMON_STATE_DIR: '/tmp/hookemon-dashboard-routes',
    HOOKEMON_DASHBOARD_PROXY_CREDENTIAL: CREDENTIAL,
  });
  assert.equal(config.profileId, 'mainnet');
});

test('standalone configuration rejects a dashboard profile and chain mismatch', () => {
  assert.throws(() => readEnvironmentConfig({
    HOOKEMON_STATE_DIR: '/tmp/hookemon-dashboard-routes',
    HOOKEMON_DASHBOARD_PROXY_CREDENTIAL: CREDENTIAL,
    HOOKEMON_DASHBOARD_PROFILE: 'testnet',
    HOOKEMON_CHAIN_ID: '4663',
  }), /profile.*chain/i);
});

test('standalone startup rejects a broken audit chain before controls are enabled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-audit-startup-'));
  const auditLogPath = join(directory, 'audit.log');
  const sqlitePath = join(directory, 'dashboard.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await appendAuditEntry(auditLogPath, {
    eventId: 'startup-chain-entry',
    occurredAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    action: 'pause',
    outcome: 'accepted',
    resultCode: 'DECISION_ACCEPTED',
    observedVersion: 0,
    note: null,
  });
  const [line] = (await readFile(auditLogPath, 'utf8')).trim().split('\n');
  await writeFile(auditLogPath, `${JSON.stringify({ ...JSON.parse(line), hash: 'sha256:forged' })}\n`, 'utf8');

  await assert.rejects(
    () => buildContext({
      profileId: 'mainnet',
      proxyCredential: CREDENTIAL,
      sqlitePath,
      auditLogPath,
      access: null,
    }),
    /audit chain/i,
  );
});

test('route sources contain no legacy state-file cycle fields', async () => {
  for (const path of ['packages/dashboard/src/routes/operator.mjs', 'packages/dashboard/src/routes/public.mjs']) {
    const source = await readFile(join(process.cwd(), path), 'utf8');
    assert.doesNotMatch(source, /state\?\.activeCycleId|state\?\.terminalCycles|readOperatorState\(ctx\.statePath\)/);
  }
});

test('authenticated HTTP saves the durable pack plan across service recreation without shrinking the allowlist', async t => {
  const { createServer } = await import('node:http');
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-plan-http-'));
  const statePath = join(directory, 'operator-state.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mutateOperatorState(statePath, null, () => ({
    ...createEmptyOperatorState(),
    configuration: { ...createDefaultOperatorConfiguration(), allowedPackIds: ['active-pack'] },
  }));
  const authority = () => createOperatorControl({
    statePath,
    cycleRepository: {
      async peekActiveCycle() { return null; },
      async listKnownCycleIds() { return []; },
      async describeCycle() { throw new Error('not used'); },
    },
    policyEngine: { async recordManualApproval() { throw new Error('not used'); } },
    readCustody: async () => ({ realizedLossMicroUsd: '0', atRiskMicroUsd: '0', outstandingMicroUsd: '0', heldAssets: false,
      heldPositions: { count: 0, valueMicroUsd: '0', positions: [] }, unattributed: false, unvaluedExposure: false }),
  });
  async function start() {
    const fixture = await buildTestServer(t, { operatorControl: authority() });
    const http = createServer(createRequestListener(fixture.ctx));
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => http.close(resolve)));
    const base = `http://127.0.0.1:${http.address().port}`;
    return async (path, body = undefined, authenticated = true) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(authenticated ? AUTH : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
  }
  const request = await start();
  assert.equal((await request('/operator/api/bootstrap', undefined, false)).status, 401);
  const before = await request('/operator/api/bootstrap');
  assert.equal(before.status, 200);
  const orders = [{ pack: 'pack-a', quantity: 3 }, { pack: 'pack-b', quantity: 1 }];
  const saved = await request('/operator/api/decisions', { requestId: 'save-plan-http', expectedVersion: before.body.state.version,
    command: { type: 'update-configuration', configuration: { allowedPackIds: ['active-pack', 'pack-a', 'pack-b'], packPlan: { orders } } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const restarted = await start();
  const after = await restarted('/operator/api/bootstrap');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.state.packPlan, { schema: 'hookemon.pack-plan.v1', revision: 1, orders });
  const cleared = await restarted('/operator/api/decisions', { requestId: 'clear-plan-http', expectedVersion: after.body.state.version,
    command: { type: 'update-configuration', configuration: { packPlan: { orders: [] } } } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const final = (await restarted('/operator/api/bootstrap')).body;
  assert.deepEqual(final.state.packPlan.orders, []);
  assert.equal(final.state.packPlan.revision, 2);
  assert.deepEqual(final.state.allowedPackIds, ['active-pack', 'pack-a', 'pack-b']);
  const invalid = await restarted('/operator/api/decisions', { requestId: 'client-plan-revision', expectedVersion: final.state.version,
    command: { type: 'update-configuration', configuration: { packPlan: { orders: [], revision: 99 } } } });
  assert.equal(invalid.status, 400);
  assert.equal((await readOperatorState(statePath)).configuration.packPlan.revision, 2);
});
