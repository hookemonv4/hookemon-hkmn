// Production acceptance harness. This deliberately uses the literal CLI and loopback HTTP/RPC
// services; it has no composition, stage, signer, or authority injection seam.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { createEmptyOperatorState, mutateOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';
import { assertCycleSnapshot } from '../../../runner/src/cycle/cycle-store.mjs';
import { stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';

const execFileAsync = promisify(execFile);
const BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-runner.mjs', import.meta.url));
const SOURCE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const EVM_ACCOUNT = '0x000000000000000000000000000000000000dead';
const SOLANA_ACCOUNT = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fixtureServer(t, directory) {
  const paths = {
    caKey: join(directory, 'ca-key.pem'), caCert: join(directory, 'ca-cert.pem'),
    key: join(directory, 'tls-key.pem'), request: join(directory, 'tls-request.pem'),
    cert: join(directory, 'tls-cert.pem'), extensions: join(directory, 'tls-ext.cnf'),
  };
  await execFileAsync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', paths.caKey, '-out', paths.caCert, '-subj', '/CN=HKMN graph fixture']);
  await execFileAsync('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', paths.key, '-out', paths.request, '-subj', '/CN=127.0.0.1']);
  await writeFile(paths.extensions, 'subjectAltName=IP:127.0.0.1\n');
  await execFileAsync('/usr/bin/openssl', ['x509', '-req', '-in', paths.request, '-CA', paths.caCert, '-CAkey', paths.caKey, '-CAcreateserial', '-out', paths.cert, '-days', '1', '-extfile', paths.extensions]);
  const [key, cert] = await Promise.all([readFile(paths.key), readFile(paths.cert)]);
  const calls = { evm: 0, solana: 0, methods: [] };
  const server = createServer({ key, cert }, async (request, response) => {
    if (request.url === '/alert') { response.writeHead(204); response.end(); return; }
    if (request.url === '/chains') { respond(response, { chains: [] }); return; }
    if (!['/rpc', '/archive', '/solana'].includes(request.url)) { response.writeHead(404); response.end(); return; }
    const rpc = await body(request);
    const reply = result => respond(response, { jsonrpc: '2.0', id: rpc.id, result });
    if (request.url !== '/solana') {
      calls.evm += 1;
      calls.methods.push(`evm:${rpc.method}`);
      if (rpc.method === 'eth_chainId') return reply('0x1237');
      if (rpc.method === 'eth_getTransactionCount') return reply('0x0');
      if (rpc.method === 'eth_getBalance') return reply('0x61a80');
      if (rpc.method === 'eth_maxPriorityFeePerGas') return reply('0x1');
      if (rpc.method === 'eth_estimateGas') return reply('0x5208');
      if (rpc.method === 'eth_getBlockByNumber') {
        const number = ['latest', 'finalized'].includes(rpc.params?.[0]) ? '0xa' : rpc.params?.[0];
        return reply({ number, hash: `0x${'1'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1' });
      }
      if (rpc.method === 'eth_getLogs') {
        const filter = rpc.params?.[0] ?? {};
        const from = BigInt(filter.fromBlock ?? '0x0');
        const to = BigInt(filter.toBlock ?? '0x0');
        return reply(from <= 1n && to >= 1n ? [{
        address: `0x${'d'.repeat(40)}`,
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${'9'.repeat(40)}`],
        data: `0x${'1'.padStart(64, '0')}`, blockNumber: '0x1', logIndex: '0x0', blockHash: `0x${'1'.repeat(64)}`, removed: false,
        }] : []);
      }
      if (rpc.method === 'eth_call') return reply(`0x${'0'.repeat(64)}`);
      return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled EVM ${rpc.method}` } });
    }
    calls.solana += 1;
    calls.methods.push(`solana:${rpc.method}`);
    if (rpc.method === 'getGenesisHash') return reply('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    if (rpc.method === 'getBalance') return reply({ context: { slot: 1 }, value: 10000000 });
    if (rpc.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } });
    if (rpc.method === 'getBlockHeight') return reply(1);
    return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled Solana ${rpc.method}` } });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { baseUrl: `https://127.0.0.1:${server.address().port}`, caCert: paths.caCert, calls };
}

async function keychainCommand(directory) {
  const path = join(directory, 'keychain.mjs');
  await writeFile(path, [
    `#!${process.execPath}`,
    "import { readFileSync } from 'node:fs';",
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    "if (input.operation === 'probe') process.stdout.write(JSON.stringify({ ready: true }));",
    "else throw new Error('N=2 graph fixture reached a signer mutation before its protocol is configured');",
    '',
  ].join('\n'), { mode: 0o700 });
  return path;
}

function observability(baseUrl, directory) {
  const hash = `0x${'a'.repeat(64)}`;
  const pin = address => ({ address, runtimeHash: hash });
  return {
    canaries: {
      chainId: 4663,
      contracts: { usdg: { proxy: pin(USDG), implementation: pin(`0x${'2'.repeat(40)}`), decimals: 6 }, poolManager: pin(`0x${'3'.repeat(40)}`), positionManager: pin(`0x${'4'.repeat(40)}`), router: pin(`0x${'5'.repeat(40)}`), quoter: pin(`0x${'6'.repeat(40)}`) },
      roles: { hookAddress: `0x${'7'.repeat(40)}`, cycleId: `0x${'0'.repeat(64)}`, treasury: `0x${'8'.repeat(40)}`, operations: EVM_ACCOUNT },
      canonicalPool: { poolId: `0x${'f'.repeat(64)}` }, providerPolicyDigest: hash,
      nativeGasReserves: [{ chainId: 4663, assetId: 'native', decimals: 18, amountAtomic: '1' }, { chainId: 'solana', assetId: 'native', decimals: 9, amountAtomic: '1' }],
    },
    alert: { webhookUrl: `${baseUrl}/alert`, dedupePath: join(directory, 'observability.sqlite') },
    startPreflight: { requiredSignerRoles: ['operator-evm', 'operator-solana'], requireEvmRpc: true, requireSolanaRpc: true },
  };
}

function eligibilitySnapshotFixture() {
  const launchManifest = {
    supply: { chainId: '4663', assetId: `0x${'d'.repeat(40)}`, decimals: 18, amountAtomic: '1' },
    hook: `0x${'c'.repeat(40)}`, poolManager: `0x${'3'.repeat(40)}`, custody: `0x${'b'.repeat(40)}`,
    operations: EVM_ACCOUNT, treasury: `0x${'8'.repeat(40)}`, programmableRecipient: `0x${'4'.repeat(40)}`,
    launchContracts: [`0x${'b'.repeat(40)}`], burnAddresses: [`0x${'0'.repeat(36)}dead`], roleHistory: [],
  };
  return {
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' }, launchManifest,
    launchManifestDigest: digest({ domain: 'hookemon.eligibility-launch-manifest.v1', launchManifest }),
    primaryLogSourceId: 'fixture-primary', secondaryLogSourceId: 'fixture-secondary', logPageSize: '2', maxRetriesPerPage: 2,
    feasibility: { measuredTransferGas: '50000', maxGasPriceWei: '2', nativeReserveWei: '10', nativeBalanceWei: '400000', maxRecipientCount: 2, maxTransactionCount: 2 },
  };
}

async function activateTwoPackPolicy(directory) {
  const configuration = applyOperatorConfiguration(null, {
    intervalMinutes: 5,
    allowedPackIds: ['return-fixture'],
    requestedOrders: 2,
    maxBoostersPerCycle: 2,
    maxUnitPriceMicroUsdg: '17',
    maxCycleBudgetMicroUsdg: '34',
    max24HourBudgetMicroUsdg: '34',
    paused: false,
    liveMode: true,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsdg: '34',
    lossCapMicroUsdg: '1000',
    maxOutstandingCustodyMicroUsdg: '1000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
  });
  await mutateOperatorState(join(directory, 'operator-state.json'), null, state => ({
    ...(state ?? createEmptyOperatorState()), configuration,
  }));
}

async function testPolicyAuthority(t, directory) {
  const ownerKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const ownerPublicKeyPath = join(directory, 'test-owner-public.pem');
  const policyPublicKeyPath = join(directory, 'test-policy-public.pem');
  const documentPath = join(directory, 'test-standing-authority.json');
  const artifactPath = join(directory, 'standing-authority-step-authorizations.json');
  const artifactNextPath = join(directory, 'standing-authority-step-authorizations.next.json');
  await Promise.all([
    writeFile(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
    writeFile(policyPublicKeyPath, policyKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
  ]);
  const document = attachOwnerSignature(buildCanonicalStandingAuthorityDocument({
    owner: 'test-loopback-authority',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '34',
    maxCyclesPerDay: 1,
    allowedPacks: ['return-fixture'],
    allowedDestinations: ['test-loopback-authority-destination'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'test-loopback-automatic-policy',
  }), ownerKeys.privateKey);
  await writeFile(documentPath, `${canonicalJson(document)}\n`, { mode: 0o600 });

  const entries = new Map();
  const diagnostics = { publishAttempts: 0, publishWrites: 0, enoent: 0, keys: [] };
  let publishing = false;
  let publishedArtifact = null;
  let producerError = null;
  // Deliberately NOT `CycleRepository.open()`. That bootstrap takes the durable store's exclusive
  // SQLite lock, and `acquireSqliteLock` sets `PRAGMA busy_timeout = 0`, so the loser of any
  // collision fails immediately. The production child charges such a failure to its own tick as an
  // outage and doubles its reconcile backoff, while this loop never backs off -- an observer polling
  // the store therefore starves the very runner it is meant to authorize (measured: every tick of a
  // 60s window lost the lock, and the graph never advanced past eligibility-snapshot).
  //
  // This reads the committed active-cycle files directly instead: no lock, no contention, and no
  // weaker evidence. `durable-store.mjs` writes each `active/<cycleId>.json` atomically as canonical
  // JSON plus one newline, so a reader observes either the whole previous version or the whole next
  // one, and `assertCycleSnapshot` re-verifies the journal hash chain before anything here is
  // authorized. An entry that has not been durably committed by the runner is therefore never
  // visible to this producer, which is exactly the fail-closed property the poll must preserve.
  async function readCommittedPreparedAttempts() {
    const activeDirectory = join(directory, 'cycles', 'active');
    let names;
    try {
      names = await readdir(activeDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const prepared = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      let text;
      try {
        text = await readFile(join(activeDirectory, name), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const parsed = JSON.parse(text);
      if (`${canonicalJson(parsed)}\n` !== text) throw new Error('active cycle file is not canonical JSON plus one newline');
      const cycle = assertCycleSnapshot(parsed.cycle);
      for (const entry of cycle.entries) {
        if (typeof entry?.kind !== 'string' || !entry.kind.endsWith('attempt-prepared')) continue;
        const attempt = entry.payload?.attempt;
        if (typeof attempt?.stage !== 'string' || typeof attempt?.requestDigest !== 'string') continue;
        prepared.push({ cycleId: cycle.cycleId, stage: attempt.stage, requestDigest: attempt.requestDigest });
      }
    }
    return prepared;
  }

  async function publish() {
    if (publishing) return;
    publishing = true;
    diagnostics.publishAttempts += 1;
    try {
      for (const { cycleId, stage, requestDigest } of await readCommittedPreparedAttempts()) {
        for (const signerRole of ['operator-evm', 'operator-solana']) {
          const unsignedIntent = {
            schema: 'hookemon.standing-authority-step-intent.v1',
            standingAuthorityDigest: document.documentDigest,
            cycleId,
            actionKind: stage,
            authorizationKind: 'sign',
            subjectDigest: requestDigest,
            destination: 'test-loopback-authority-destination',
            pack: 'return-fixture',
            spendAmount: '1',
            nonce: `test-${digest({ cycleId, stage, requestDigest, signerRole }).slice('sha256:'.length)}`,
            issuedAt: '2026-09-06T00:00:00.000Z',
          };
          const intent = Object.freeze({
            ...unsignedIntent,
            policySignature: signMessage(null, Buffer.from(stepAuthorizationIntentDigest(unsignedIntent), 'utf8'), policyKeys.privateKey).toString('base64url'),
          });
          const entryKey = canonicalJson({ cycleId, stage, requestDigest, signerRole });
          if (!entries.has(entryKey)) diagnostics.keys.push({ atMs: Date.now(), stage, requestDigest, signerRole });
          entries.set(entryKey, Object.freeze({ signerRole, intent }));
        }
      }
      const artifact = {
        schema: 'hookemon.standing-authority-step-authorizations.v1',
        authorityDigest: document.documentDigest,
        entries: [...entries.values()],
      };
      const artifactText = `${canonicalJson(artifact)}\n`;
      if (artifactText === publishedArtifact) return;
      await writeFile(artifactNextPath, artifactText, { mode: 0o600 });
      await rename(artifactNextPath, artifactPath);
      publishedArtifact = artifactText;
      diagnostics.publishWrites += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      diagnostics.enoent += 1;
    } finally {
      publishing = false;
    }
  }
  await publish();
  const timer = setInterval(() => {
    void publish().catch(error => { producerError = error; });
  }, 10);
  t.after(() => clearInterval(timer));
  return {
    documentPath,
    ownerPublicKeyPath,
    policyPublicKeyPath,
    diagnostics,
    // The assertions below reopen the same durable store, and `open()` takes the store's exclusive
    // zero-tolerance SQLite lock. Stop the producer and let its in-flight publish drain first, or
    // the harness reliably races itself into `durable cycle store lock contention`.
    async stop() {
      clearInterval(timer);
      while (publishing) await new Promise(resolve => setTimeout(resolve, 5));
    },
    assertHealthy() { if (producerError !== null) throw producerError; },
  };
}

async function isolatedSource(directory) {
  const root = join(directory, 'source');
  const copyFilter = path => !path.includes('/node_modules');
  await Promise.all([
    cp(join(SOURCE_ROOT, 'packages', 'adapters'), join(root, 'packages', 'adapters'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'runner'), join(root, 'packages', 'runner'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'contracts'), join(root, 'packages', 'contracts'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'dashboard'), join(root, 'packages', 'dashboard'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'domain'), join(root, 'packages', 'domain'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'architecture'), join(root, 'architecture'), { recursive: true }),
    cp(join(SOURCE_ROOT, 'bindings'), join(root, 'bindings'), { recursive: true }),
  ]);
  await symlink(join(SOURCE_ROOT, 'packages', 'adapters', 'node_modules'), join(root, 'packages', 'adapters', 'node_modules'));
  await writeFile(join(root, 'architecture', 'interfaces.json'), `${JSON.stringify({
    schemaVersion: 'hookemon.interfaces.v1', productPhase: 3, requirementsRevision: 65, architectureRevision: 9,
    status: 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING', bindingManifestDigest: `sha256:${'a'.repeat(64)}`,
    fixture: 'I-03 isolated test authority; not a release approval',
  })}\n`);
  const binPath = await realpath(join(root, 'packages', 'adapters', 'bin', 'hookemon-runner.mjs'));
  let entrypointOutput = '';
  try {
    const result = await execFileAsync(process.execPath, [binPath]);
    entrypointOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (error) {
    entrypointOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (!/Usage: hookemon-runner/.test(entrypointOutput)) {
    throw new Error('isolated production graph fixture did not execute the copied CLI entrypoint');
  }
  return binPath;
}

async function runProductionWindow(binPath, env, durationMs = 15000) {
  const child = spawn(process.execPath, [binPath, 'run', '--mode', 'production', '--no-dashboard'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let exitCode = null;
  let signal = null;
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.once('close', (code, receivedSignal) => { exitCode = code; signal = receivedSignal; });
  await new Promise(resolve => setTimeout(resolve, durationMs));
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000)),
  ]);
  return { stderr, stdout, exitCode, signal };
}

const GRAPH_WINDOW_MS = Number(process.env.HKMN_GRAPH_WINDOW_MS ?? 15000);

test('I-01/I-02 literal production loader completes an automatic two-pack cycle', { timeout: GRAPH_WINDOW_MS + 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-graph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await fixtureServer(t, directory);
  const binPath = await isolatedSource(directory);
  const keychain = await keychainCommand(directory);
  const authority = await testPolicyAuthority(t, directory);
  await activateTwoPackPolicy(directory);
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, `${JSON.stringify(observability(fixture.baseUrl, directory))}\n`);
  await writeFile(eligibilitySnapshotPath, `${JSON.stringify(eligibilitySnapshotFixture())}\n`);
  const env = {
    ...process.env,
    HOOKEMON_STATE_DIR: directory, HOOKEMON_DEFAULT_INTERVAL_MS: '100', HOOKEMON_CHAIN_ID: '4663', HOOKEMON_PROVIDER_MODE: 'live',
    // Short so a wallet-nonce reservation from a tick whose sign attempt failed before reaching the
    // chain (still PREPARED, see cli.mjs's inspectCycleRecovery) is legitimately expired -- and
    // therefore takeable under a fresh lease's fencing token -- well before the scheduler's own
    // ~5s failed-tick retry backoff fires the next attempt. The default 90s production TTL would
    // otherwise make every retry within this fixture's 15s window collide with its own prior attempt.
    HOOKEMON_LEASE_TTL_MS: '1000',
    HOOKEMON_ROBINHOOD_RPC_URL: `${fixture.baseUrl}/rpc`, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: `${fixture.baseUrl}/archive`, HOOKEMON_SOLANA_RPC_URL: `${fixture.baseUrl}/solana`,
    HOOKEMON_RELAY_BASE_URL: fixture.baseUrl, HOOKEMON_RELAY_API_KEY: 'fixture-relay-key', HOOKEMON_RELAY_SOLANA_MINT: SOLANA_MINT, HOOKEMON_RELAY_SOLANA_DECIMALS: '6', HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: `${fixture.baseUrl}/collector`, HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'fixture-collector-key',
    HOOKEMON_EVM_ACCOUNT: EVM_ACCOUNT, HOOKEMON_SOLANA_ACCOUNT: SOLANA_ACCOUNT, HOOKEMON_VAULT_ADDRESS: `0x${'b'.repeat(40)}`, HOOKEMON_HOOK_ADDRESS: `0x${'c'.repeat(40)}`, HOOKEMON_HKMN_ADDRESS: `0x${'d'.repeat(40)}`, HOOKEMON_HKMN_DECIMALS: '18',
    HOOKEMON_SIGNER_BACKEND: 'keychain', HOOKEMON_SIGNER_LIVE_MODE: 'true', HOOKEMON_KEYCHAIN_COMMAND: keychain, HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm', HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_STANDING_AUTHORITY_PATH: authority.documentPath, HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: authority.ownerPublicKeyPath, HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: authority.policyPublicKeyPath,
    HOOKEMON_PACK_CODE: 'return-fixture', HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0', HOOKEMON_MIN_SOLANA_RECEIVE: '0', HOOKEMON_MIN_RETURN_USDG: '0', HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0', HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0', HOOKEMON_EVM_GAS_PRICE_CAP: '2', HOOKEMON_EVM_NATIVE_RESERVE: '2', HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2', HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '85', HOOKEMON_BUDGET_PACK_PRICE_USDG: '17', HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0', HOOKEMON_BUDGET_RETURN_CAP_USDG: '0', HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0', HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath, HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath, NODE_EXTRA_CA_CERTS: fixture.caCert,
  };
  const run = await runProductionWindow(binPath, env, GRAPH_WINDOW_MS);
  await authority.stop();
  authority.assertHealthy();
  const { stderr } = run;
  const repository = await CycleRepository.open(join(directory, 'cycles'));
  const cycleIds = await repository.listKnownCycleIds();
  assert.equal(cycleIds.length, 1, `production graph did not durably admit one N=2 cycle: ${JSON.stringify({ run, calls: fixture.calls })}`);
  const cycle = await repository.describeCycle(cycleIds[0]);
  assert.equal(cycle.mode, 'production');
  assert.equal(cycle.providerMode, 'live');
  const purchase = cycle.stages.get('purchase') ?? cycle.preparedStages.get('purchase') ?? null;
  assert.ok(purchase, `automatic admission must durably reach the purchase operation boundary for both requested packs; ${JSON.stringify({
    stages: [...cycle.stages.keys()], prepared: [...cycle.preparedStages.keys()],
    chainAttempts: [...cycle.chainAttempts.values()].map(record => ({ stage: record?.attempt?.stage, state: record?.attempt?.state, requestDigest: record?.attempt?.requestDigest })),
    operationalAttempts: [...cycle.operationalAttempts.values()].map(record => ({ stage: record?.attempt?.stage, requestDigest: record?.attempt?.requestDigest })),
    authorizations: authority.diagnostics, terminalState: cycle.terminalState, stderr,
  })}`);
  assert.equal(cycle.completed, true, 'the automatic N=2 production graph must converge before the scheduler window closes');
  assert.ok(fixture.calls.evm > 0 && fixture.calls.solana > 0, 'production graph must use both loopback chain protocols');
});
