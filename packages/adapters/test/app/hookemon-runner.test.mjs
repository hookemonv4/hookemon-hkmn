// Subprocess coverage for the literal CLI entrypoint: `node bin/hookemon-runner.mjs <command>`,
// exactly as an operator would invoke it, configured entirely through HOOKEMON_* environment
// variables (never a file inside this repository). Most URLs used here are `.invalid` placeholders
// (RFC 2606). The production-resume fixture uses loopback HTTPS and an ephemeral test CA passed to
// its subprocess, while still stopping at the frozen-interface authority before any mutation.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { runOperatorCli } from '../../../runner/src/operator/cli.mjs';
import { createEmptyOperatorState, mutateOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { deriveCyclePolicyDigest } from '../../../runner/src/automation/policy-engine.mjs';
import { canonicalJson } from '../../../runner/src/cycle/journal.mjs';
import { stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';
import {
  buildManualApprovalHandoff,
  compositionInput,
  parseArgv,
  runCli,
  runRehearsalSupervisor,
} from '../../bin/hookemon-runner.mjs';
import { readRehearsalSession } from '../../../runner/src/cycle/rehearsal-session.mjs';

const execFileAsync = promisify(execFile);
const BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-runner.mjs', import.meta.url));

async function tempStateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function baseEnv(stateDir) {
  return {
    ...process.env,
    HOOKEMON_STATE_DIR: stateDir,
    HOOKEMON_ROBINHOOD_RPC_URL: 'https://robinhood.example.invalid',
    HOOKEMON_SOLANA_RPC_URL: 'https://solana.example.invalid',
    HOOKEMON_RELAY_BASE_URL: 'https://relay.example.invalid',
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: 'https://collector-crypt.example.invalid',
  };
}

test('compositionInput pins enforceProfile for every composed run and resume profile', () => {
  const base = {
    stateDir: '/tmp/hookemon-runner-composition',
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    defaultIntervalMs: 60_000,
    chainId: 4663,
    robinhood: null,
    solana: null,
    relay: null,
    collectorCrypt: null,
    contracts: null,
    accounts: null,
    budget: null,
    pack: null,
    minimums: null,
    nativeGasCaps: null,
    moneyConfiguration: null,
    hkmn: null,
    distribution: null,
    rehearsal: null,
    observability: null,
    standingAuthority: { documentPath: null },
  };
  const compositions = [
    { command: 'run', execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: false } },
    { command: 'run', execution: { profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'fake', enforceProfile: false } },
    { command: 'resume', execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: false } },
    { command: 'resume', execution: { profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'fake', enforceProfile: false } },
  ];

  for (const { command, execution } of compositions) {
    const input = compositionInput({
      env: { ...base, execution },
      statePath: `${base.stateDir}/operator-state.json`,
      dashboard: null,
      signerClient: null,
      signerReadiness: null,
      rehearsalCapUsdg: null,
      rehearsalSessionId: null,
      restartInjector: null,
      operatorAuditLogPath: undefined,
      logTicks: false,
    });
    assert.equal(input.execution.enforceProfile, true, `${command}:${execution.profile}`);
  }
});

test('compositionInput resolves a persisted authority artifact bound to the verified owner document', async t => {
  const stateDir = await tempStateDir(t);
  const owner = generateKeyPairSync('ed25519');
  const policy = generateKeyPairSync('ed25519');
  const unsignedDocument = buildCanonicalStandingAuthorityDocument({
    owner: 'fixture-owner',
    policyPublicKey: policy.publicKey,
    perCycleSpendCap: '10',
    maxCyclesPerDay: 1,
    allowedPacks: ['fixture-pack'],
    allowedDestinations: ['fixture-solana-policy-account'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'fixture-authority',
  });
  const document = attachOwnerSignature(unsignedDocument, owner.privateKey);
  const documentPath = join(stateDir, 'standing-authority.json');
  const ownerPublicKeyPath = join(stateDir, 'owner-public.pem');
  const policyPublicKeyPath = join(stateDir, 'policy-public.pem');
  await Promise.all([
    writeFile(documentPath, `${JSON.stringify(document)}\n`, { mode: 0o600 }),
    writeFile(ownerPublicKeyPath, owner.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
    writeFile(policyPublicKeyPath, policy.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
  ]);
  const unsignedIntent = {
    schema: 'hookemon.standing-authority-step-intent.v1',
    standingAuthorityDigest: document.documentDigest,
    cycleId: 'cycle-artifact',
    actionKind: 'outbound',
    authorizationKind: 'sign',
    subjectDigest: `sha256:${'a'.repeat(64)}`,
    destination: 'fixture-solana-policy-account',
    pack: 'fixture-pack',
    spendAmount: '10',
    nonce: 'cycle-artifact-outbound-sign',
    issuedAt: '2026-06-01T00:00:00.000Z',
  };
  const intent = {
    ...unsignedIntent,
    policySignature: signMessage(null, Buffer.from(stepAuthorizationIntentDigest(unsignedIntent), 'utf8'), policy.privateKey).toString('base64url'),
  };
  await writeFile(join(stateDir, 'standing-authority-step-authorizations.json'), `${canonicalJson({
    schema: 'hookemon.standing-authority-step-authorizations.v1',
    authorityDigest: document.documentDigest,
    entries: [{ signerRole: 'operator-evm', intent }],
  })}\n`, { mode: 0o600 });

  const base = {
    stateDir,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    defaultIntervalMs: 60_000,
    chainId: 4663,
    robinhood: null,
    solana: null,
    relay: null,
    collectorCrypt: null,
    contracts: null,
    accounts: null,
    budget: null,
    pack: null,
    minimums: null,
    nativeGasCaps: null,
    moneyConfiguration: null,
    hkmn: null,
    distribution: null,
    rehearsal: null,
    observability: null,
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: false },
    standingAuthority: { documentPath, ownerPublicKeyPath, policyPublicKeyPath },
  };
  const input = compositionInput({
    env: base,
    statePath: join(stateDir, 'operator-state.json'),
    dashboard: null,
    signerClient: null,
    signerReadiness: null,
    rehearsalCapUsdg: null,
    rehearsalSessionId: null,
    restartInjector: null,
    operatorAuditLogPath: undefined,
    logTicks: false,
  });
  assert.equal(typeof input.standingAuthorityStepAuthorization, 'function');
  assert.deepEqual(
    await input.standingAuthorityStepAuthorization({
      cycleId: 'cycle-artifact',
      stage: 'outbound',
      authorizationKind: 'sign',
      requestDigest: intent.subjectDigest,
      signerRole: 'operator-evm',
    }),
    intent,
  );

  await rm(join(stateDir, 'standing-authority-step-authorizations.json'));
  assert.throws(
    () => compositionInput({
      env: base,
      statePath: join(stateDir, 'operator-state.json'),
      dashboard: null,
      signerClient: null,
      signerReadiness: null,
      rehearsalCapUsdg: null,
      rehearsalSessionId: null,
      restartInjector: null,
      operatorAuditLogPath: undefined,
      logTicks: false,
    }),
    /artifact/i,
  );
});

test('dry-run accepts an explicit production profile and composes its fake-provider boundary', async () => {
  assert.equal(parseArgv(['dry-run']).mode, 'inspection');
  assert.equal(parseArgv(['dry-run', '--mode', 'production']).mode, 'production');
  assert.throws(() => parseArgv(['dry-run', '--mode', 'rehearsal']), /production|inspection/);

  const buildCalls = [];
  const emitted = [];
  let shutdowns = 0;
  await runCli(['dry-run', '--mode', 'production'], {
    environment: {},
    async buildComposition(input) {
      buildCalls.push(input);
      return {
        service: {
          async runOnce(options) {
            assert.deepEqual(options, { liveMode: false });
            return { status: 'COMPLETE', cycleId: 'cycle-production-dry-run' };
          },
        },
        async shutdown() { shutdowns += 1; },
      };
    },
    emitJson(value) { emitted.push(value); },
  });
  assert.deepEqual(buildCalls, [{
    statePathOverride: null,
    withDashboard: false,
    logTicks: false,
    profile: 'production',
    dryRun: true,
  }]);
  assert.deepEqual(emitted, [{ status: 'COMPLETE', cycleId: 'cycle-production-dry-run' }]);
  assert.equal(shutdowns, 1);
});

async function fakeRehearsalEnv(t, stateDir) {
  const observabilityPath = join(stateDir, 'observability.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  return {
    ...baseEnv(stateDir),
    HOOKEMON_CHAIN_ID: '4663',
    HOOKEMON_EVM_ACCOUNT: `0x${'b'.repeat(40)}`,
    HOOKEMON_SOLANA_ACCOUNT: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t',
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'false',
    HOOKEMON_KEYCHAIN_COMMAND: '/tmp/hookemon-keychain-signer',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_PACK_CODE: 'collector-25',
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_MIN_SOLANA_RECEIVE: '0',
    HOOKEMON_MIN_RETURN_USDG: '0',
    HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0',
    HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '30',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '30',
    HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0',
    HOOKEMON_BUDGET_RETURN_CAP_USDG: '0',
    HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0',
    HOOKEMON_PROVIDER_MODE: 'fake',
    HOOKEMON_RELAY_SOLANA_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    HOOKEMON_RELAY_SOLANA_DECIMALS: '6',
    HOOKEMON_EVM_GAS_PRICE_CAP: '2',
    HOOKEMON_EVM_NATIVE_RESERVE: '2',
    HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2',
    HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: '11111111111111111111111111111111',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: '22222222222222222222222222222222',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
  };
}

test('rehearsal restart injection requires one explicit fake rehearsal profile', () => {
  const parsed = parseArgv([
    'run', '--mode', 'rehearsal', '--cycles', '2', '--cap-usdg', '30', '--relay-roundtrip', '--restart-inject',
  ]);
  assert.equal(parsed.mode, 'rehearsal');
  assert.equal(parsed.collectorOnly, false);
  assert.equal(parsed.relayRoundtrip, true);
  assert.equal(parsed.restartInject, true);
  assert.throws(
    () => parseArgv(['run', '--mode', 'rehearsal', '--cycles', '2', '--cap-usdg', '30', '--restart-inject']),
    /requires --collector-only or --relay-roundtrip/,
  );
  assert.throws(
    () => parseArgv([
      'run', '--mode', 'rehearsal', '--cycles', '2', '--cap-usdg', '30', '--collector-only', '--relay-roundtrip',
    ]),
    /cannot combine --collector-only and --relay-roundtrip/,
  );
});

test('the literal rehearsal command relaunches a restart worker with one durable bounded session', async t => {
  const stateDir = await tempStateDir(t);
  const invocations = [];
  const output = [];
  let sessionPath = null;
  let workerNumber = 0;
  const supervisor = parsed => runRehearsalSupervisor(parsed, {
    readEnvironmentFn: () => ({ stateDir, execution: { providerMode: 'fake' }, rehearsal: { mode: 'collector-only' } }),
    runWorkerFn: async input => {
      invocations.push(input.argv);
      sessionPath = input.sessionPath;
      workerNumber += 1;
      return workerNumber === 1
        ? { code: 75, stdout: '', stderr: '' }
        : { code: 0, stdout: '{"mode":"rehearsal","cycles":[]}\n', stderr: '' };
    },
    writeStdout: value => output.push(value),
  });

  await runCli([
    'run', '--mode', 'rehearsal', '--cycles', '2', '--cap-usdg', '30', '--collector-only', '--restart-inject',
  ], { runRehearsalSupervisorFn: supervisor });

  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0], [
    'run', '--mode', 'rehearsal', '--cycles', '2', '--cap-usdg', '30', '--collector-only', '--restart-inject',
  ]);
  assert.deepEqual(invocations[1], invocations[0]);
  assert.equal((await readRehearsalSession({ path: sessionPath })).restartCount, 1);
  assert.deepEqual(output, ['{"mode":"rehearsal","cycles":[]}\n']);
});

test('relay-roundtrip restart workers retain the explicit profile flag', async t => {
  const stateDir = await tempStateDir(t);
  const invocations = [];
  await runRehearsalSupervisor({
    statePathOverride: null,
    cycles: 1,
    capUsdg: '30',
    collectorOnly: false,
    relayRoundtrip: true,
  }, {
    readEnvironmentFn: () => ({ stateDir, execution: { providerMode: 'fake' }, rehearsal: { mode: 'relay-roundtrip' } }),
    runWorkerFn: async input => {
      invocations.push(input.argv);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(invocations, [[
    'run', '--mode', 'rehearsal', '--cycles', '1', '--cap-usdg', '30', '--relay-roundtrip', '--restart-inject',
  ]]);
});

test('a manual-approval refusal has a digest-bound handoff without creating an effect', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await mutateOperatorState(statePath, null, state => ({
    ...(state ?? createEmptyOperatorState()),
    configuration: applyOperatorConfiguration(null, {
      intervalMinutes: 5,
      allowedPackIds: ['collector-25'],
      requestedOrders: 1,
      maxBoostersPerCycle: 1,
      maxUnitPriceMicroUsdg: '30',
      maxCycleBudgetMicroUsdg: '30',
      max24HourBudgetMicroUsdg: '60',
      paused: false,
      liveMode: false,
    }),
  }));
  const handoff = await buildManualApprovalHandoff({
    composition: {
      cycleRepository: {
        readActiveCycle: async () => ({
          cycleId: 'cycle-manual-approval', releaseAmount: '30', mode: 'rehearsal', providerMode: 'fake',
        }),
      },
    },
    env: { pack: { code: 'collector-25' } },
    statePath,
  });
  assert.deepEqual(handoff.status, 'AWAITING_MANUAL_APPROVAL');
  assert.equal(handoff.cycleId, 'cycle-manual-approval');
  assert.match(handoff.policyDigest, /^sha256:[0-9a-f]{64}$/);
});

test('hookemon-runner status reads the repository without loading a signer or provider', async t => {
  const stateDir = await tempStateDir(t);
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'status'], { env: baseEnv(stateDir) });
  assert.deepEqual(JSON.parse(stdout), { status: 'NO_ACTIVE_CYCLE' });
});

test('hookemon-runner abort-cycle records an idempotent reason under the repository lease', async t => {
  const stateDir = await tempStateDir(t);
  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal' });
  const { stdout } = await execFileAsync(process.execPath, [
    BIN_PATH, 'abort-cycle', cycle.cycleId, '--reason', 'operator stop for reconciliation',
  ], { env: baseEnv(stateDir) });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'CYCLE_ABORTED');
  assert.equal(result.terminalState, 'HELD_OWNER_DECISION');
  assert.deepEqual(result.terminalEvidence, {
    command: 'abort-cycle',
    reason: 'operator stop for reconciliation',
  });
  const retry = await execFileAsync(process.execPath, [
    BIN_PATH, 'abort-cycle', cycle.cycleId, '--reason', 'operator stop for reconciliation',
  ], { env: baseEnv(stateDir) });
  assert.equal(JSON.parse(retry.stdout).status, 'CYCLE_ABORTED');
});

test('hookemon-runner resume refuses an unresolved signed chain attempt before loading a signer', async t => {
  const stateDir = await tempStateDir(t);
  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycle.cycleId, 'claim-process', {
    schema: 'hookemon.chain-transaction-attempt.v1',
    cycleId: cycle.cycleId,
    stage: 'claim-process',
    state: 'PREPARED',
    requestDigest,
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
  });
  await repository.recordSignedTransaction(cycle.cycleId, 'claim-process', requestDigest, {
    rawBytes: '0xabcdef',
    nonce: '8',
    blockhash: null,
    hash: '0xdeadbeef',
  });
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'resume', cycle.cycleId], {
    env: { ...baseEnv(stateDir), HOOKEMON_SIGNER_MODULE: '/nonexistent-signer-module.mjs' },
  });
  assert.deepEqual(JSON.parse(stdout), {
    status: 'RESUME_REFUSED',
    cycleId: cycle.cycleId,
    reason: 'CHAIN_ATTEMPT_UNRESOLVED',
  });
});

test('hookemon-runner resume refuses a live rehearsal journal under a fake provider profile before signer construction', async t => {
  const stateDir = await tempStateDir(t);
  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal', providerMode: 'live' });
  const env = await fakeRehearsalEnv(t, stateDir);
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'resume', cycle.cycleId], {
    env: { ...env, HOOKEMON_SIGNER_MODULE: '/nonexistent-signer-module.mjs' },
  });
  assert.deepEqual(JSON.parse(stdout), {
    status: 'RESUME_REFUSED', cycleId: cycle.cycleId, reason: 'CYCLE_PROVIDER_MODE_MISMATCH',
  });
});

test('hookemon-runner status --cycle projects recovery facts without signed transaction bytes', async t => {
  const stateDir = await tempStateDir(t);
  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal' });
  const requestDigest = `sha256:${'b'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycle.cycleId, 'claim-process', {
    schema: 'hookemon.chain-transaction-attempt.v1',
    cycleId: cycle.cycleId,
    stage: 'claim-process',
    state: 'PREPARED',
    requestDigest,
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
  });
  await repository.recordSignedTransaction(cycle.cycleId, 'claim-process', requestDigest, {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: '0xdeadbeef',
  });
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'status', '--cycle', cycle.cycleId], { env: baseEnv(stateDir) });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'CYCLE');
  assert.equal(result.mode, 'rehearsal');
  assert.equal(result.recovery.reason, 'CHAIN_ATTEMPT_UNRESOLVED');
  assert.doesNotMatch(stdout, /0xabcdef/);
});

test('hookemon-runner dry-run exits 0 and prints a JSON outcome when nothing is configured to spend yet', async t => {
  const stateDir = await tempStateDir(t);
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'dry-run'], { env: baseEnv(stateDir) });
  const outcome = JSON.parse(stdout);
  assert.equal(outcome.status, 'WAITING_FOR_PROCESS_BUDGET', 'the conservative zero-budget default never opens a cycle on its own');
});

test('hookemon-runner dry-run runs a complete cycle end to end and exits 0 when a budget is configured', async t => {
  const stateDir = await tempStateDir(t);
  const env = { ...baseEnv(stateDir), HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '10', HOOKEMON_BUDGET_PACK_PRICE_USDG: '1' };
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'dry-run'], { env });
  const outcome = JSON.parse(stdout);
  assert.equal(outcome.status, 'COMPLETE');
  assert.equal(typeof outcome.cycleId, 'string');

  const { stdout: statusStdout } = await execFileAsync(process.execPath, [BIN_PATH, 'status'], { env });
  assert.deepEqual(JSON.parse(statusStdout), { status: 'NO_ACTIVE_CYCLE' }, 'the completed cycle was archived');
});

test('hookemon-runner dry-run in collector-only rehearsal mode routes bridge stages to rehearsal skip handlers', async t => {
  const stateDir = await tempStateDir(t);
  const env = {
    ...baseEnv(stateDir),
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '10',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '1',
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_SOLANA_ACCOUNT: 'CxV9v9g5eyiQtFWHx1uUTpt9LRC78LcjSTGas7ihX7wQ',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t',
  };
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, 'dry-run'], { env });
  const outcome = JSON.parse(stdout);
  assert.equal(outcome.status, 'COMPLETE');

  const archived = JSON.parse(await readFile(join(stateDir, 'cycles', 'archive', `${outcome.cycleId}.json`), 'utf8'));
  const completed = Object.fromEntries(
    archived.cycle.entries
      .filter(entry => entry.kind === 'stage-completed')
      .map(entry => [entry.payload.stage, entry.payload.evidence]),
  );
  for (const stage of ['outbound', 'return']) {
    assert.equal(completed[stage].skipped, true, `${stage} must be skipped in the rehearsal`);
    assert.equal(completed[stage].rehearsalMode, 'collector-only');
  }
  assert.match(completed.payout.reason, /buyback is not complete/, 'payout must come from the rehearsal handler, not the vault payout');
});

test('hookemon-runner refuses the unaudited tick command before opening a composition', async t => {
  const stateDir = await tempStateDir(t);
  await assert.rejects(
    execFileAsync(process.execPath, [BIN_PATH, 'tick'], { env: baseEnv(stateDir) }),
    error => /unaudited tick.*prohibited|use.*run-cycle-now/i.test(error.stderr),
  );
});

test('hookemon-runner operator executes a command through the composed audited authority', async () => {
  const calls = { composition: [], audited: [], execute: [], shutdown: 0 };
  const output = [];
  const composition = {
    operatorControl: {
      async status() {
        return { revision: 4 };
      },
      async execute(input) {
        calls.execute.push(input);
        return { action: input.command.type, revision: 5 };
      },
    },
    async executeAudited({ effect, ...input }) {
      calls.audited.push(input);
      return effect();
    },
    async shutdown() {
      calls.shutdown += 1;
    },
  };
  const priorExitCode = process.exitCode;
  try {
    await runCli([
      'operator', '--state', '/tmp/hookemon-operator-state.json',
      'pause', '--expected-revision', '4', '--request-id', 'installed-cli-request',
    ], {
      buildComposition: async input => {
        calls.composition.push(input);
        return composition;
      },
      runComposedOperatorCli: runOperatorCli,
      emitJson: value => output.push(value),
      environment: { HOOKEMON_DASHBOARD_AUDIT_LOG_PATH: '/tmp/shared-dashboard-audit.log' },
    });
  } finally {
    process.exitCode = priorExitCode;
  }

  assert.deepEqual(calls.composition, [{
    statePathOverride: '/tmp/hookemon-operator-state.json',
    withDashboard: false,
    logTicks: false,
    operatorAuditLogPath: '/tmp/shared-dashboard-audit.log',
  }]);
  assert.deepEqual(calls.audited, [{
    requestId: 'installed-cli-request',
    expectedRevision: 4,
    command: { type: 'pause' },
  }]);
  assert.deepEqual(calls.execute, [{
    expectedRevision: 4,
    requestId: 'installed-cli-request',
    command: { type: 'pause' },
  }]);
  assert.deepEqual(output, [{ action: 'pause', revision: 5 }]);
  assert.equal(calls.shutdown, 1);
});

test('hookemon-runner status reads the active cycle through the pure peek client', async () => {
  const calls = { composition: [], peek: 0, read: 0, describe: 0, shutdown: 0 };
  const output = [];
  const composition = {
    cycleRepository: {
      async peekActiveCycle() {
        calls.peek += 1;
        return { cycleId: 'cycle-status', releaseAmount: '7' };
      },
      async readActiveCycle() {
        calls.read += 1;
        throw new Error('legacy status must not archive a completed cycle');
      },
      async describeCycle(cycleId) {
        calls.describe += 1;
        assert.equal(cycleId, 'cycle-status');
        return {
          cycleId,
          releaseAmount: '7',
          stages: new Map([['purchase', { status: 'PENDING' }]]),
          completed: false,
        };
      },
    },
    async shutdown() {
      calls.shutdown += 1;
    },
  };

  await runCli(['status'], {
    buildComposition: async input => {
      calls.composition.push(input);
      return composition;
    },
    emitJson: value => output.push(value),
  });

  assert.deepEqual(calls.composition, [{ statePathOverride: null, withDashboard: false, logTicks: false }]);
  assert.equal(calls.peek, 1);
  assert.equal(calls.read, 0);
  assert.equal(calls.describe, 1);
  assert.deepEqual(output, [{
    status: 'ACTIVE_CYCLE',
    cycleId: 'cycle-status',
    releaseAmount: '7',
    stages: { purchase: { status: 'PENDING' } },
    completed: false,
  }]);
  assert.equal(calls.shutdown, 1);
});

test('hookemon-runner refuses an unknown HOOKEMON_* environment variable', async t => {
  const stateDir = await tempStateDir(t);
  const env = { ...baseEnv(stateDir), HOOKEMON_NOT_A_REAL_VARIABLE: 'x' };
  await assert.rejects(execFileAsync(process.execPath, [BIN_PATH, 'dry-run'], { env }));
});

test('hookemon-runner prints usage and a nonzero exit code for an unknown command', async t => {
  const stateDir = await tempStateDir(t);
  await assert.rejects(execFileAsync(process.execPath, [BIN_PATH, 'not-a-command'], { env: baseEnv(stateDir) }));
});

test('hookemon-runner no longer exposes the deprecated degraded-return mutation command', () => {
  assert.equal(parseArgv(['accept-degraded-return']).invalidCommand, true);
});

const PRODUCTION_RETURN_EVM_ACCOUNT = '0x000000000000000000000000000000000000dEaD';
const PRODUCTION_RETURN_SOLANA_ACCOUNT = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const PRODUCTION_RETURN_SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PRODUCTION_RETURN_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function productionObservabilityConfig({ baseUrl, stateDir }) {
  const runtimeHash = `0x${'a'.repeat(64)}`;
  const pin = address => ({ address, runtimeHash });
  return {
    canaries: {
      chainId: 4663,
      contracts: {
        usdg: {
          proxy: pin(PRODUCTION_RETURN_USDG),
          implementation: pin(`0x${'2'.repeat(40)}`),
          decimals: 6,
        },
        poolManager: pin(`0x${'3'.repeat(40)}`),
        positionManager: pin(`0x${'4'.repeat(40)}`),
        router: pin(`0x${'5'.repeat(40)}`),
        quoter: pin(`0x${'6'.repeat(40)}`),
      },
      roles: {
        hookAddress: `0x${'7'.repeat(40)}`,
        cycleId: `0x${'0'.repeat(64)}`,
        treasury: `0x${'8'.repeat(40)}`,
        operations: PRODUCTION_RETURN_EVM_ACCOUNT,
      },
      canonicalPool: { poolId: `0x${'f'.repeat(64)}` },
      providerPolicyDigest: runtimeHash,
      nativeGasReserves: [
        { chainId: 4663, assetId: 'native', decimals: 18, amountAtomic: '1' },
        { chainId: 'solana', assetId: 'native', decimals: 9, amountAtomic: '1' },
      ],
    },
    alert: { webhookUrl: `${baseUrl}/alert`, dedupePath: join(stateDir, 'observability.sqlite') },
    startPreflight: {
      requiredSignerRoles: ['operator-evm', 'operator-solana'],
      requireEvmRpc: true,
      requireSolanaRpc: true,
    },
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function buildReturnRelayQuote() {
  const raw = JSON.parse(await readFile(new URL('../fixtures/relay/quote-return.json', import.meta.url), 'utf8'));
  const deadline = Math.floor(Date.now() / 1000) + 3_600;
  const inputAmount = '17';
  const outputAmount = '16';
  const transferData = Buffer.alloc(10);
  transferData.writeUInt8(12, 0);
  transferData.writeBigUInt64LE(BigInt(inputAmount), 1);
  transferData.writeUInt8(6, 9);

  raw.details.sender = PRODUCTION_RETURN_SOLANA_ACCOUNT;
  raw.details.recipient = PRODUCTION_RETURN_EVM_ACCOUNT;
  raw.details.currencyIn.amount = inputAmount;
  raw.details.currencyIn.minimumAmount = inputAmount;
  raw.details.currencyOut.amount = outputAmount;
  raw.details.currencyOut.minimumAmount = outputAmount;
  raw.steps = [{
    id: 'return-transfer',
    action: 'Confirm transaction in your wallet',
    description: 'Return the cycle-attributed Solana stablecoin proceeds',
    kind: 'transaction',
    requestId: raw.requestId,
    items: [{
      status: 'incomplete',
      data: {
        instructions: [{
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc', isSigner: false, isWritable: true },
            { pubkey: PRODUCTION_RETURN_SOLANA_MINT, isSigner: false, isWritable: false },
            { pubkey: '8MWgLuNVQAhpoTUQZiUUkG9Q1569HCkJbmAivoQ5VhDN', isSigner: false, isWritable: true },
            { pubkey: PRODUCTION_RETURN_SOLANA_ACCOUNT, isSigner: true, isWritable: false },
          ],
          data: transferData.toString('hex'),
        }],
        addressLookupTableAddresses: [],
      },
    }],
  }];

  const orderData = raw.protocol.v2.orderData;
  orderData.inputs[0].payment.amount = inputAmount;
  orderData.inputs[0].refunds[0].recipient = PRODUCTION_RETURN_SOLANA_ACCOUNT;
  orderData.inputs[0].refunds[0].deadline = deadline;
  orderData.inputs[0].refunds[1].recipient = PRODUCTION_RETURN_EVM_ACCOUNT;
  orderData.inputs[0].refunds[1].deadline = deadline;
  orderData.output.payments[0].recipient = PRODUCTION_RETURN_EVM_ACCOUNT;
  orderData.output.payments[0].expectedAmount = outputAmount;
  orderData.output.payments[0].minimumAmount = outputAmount;
  orderData.output.deadline = deadline;
  raw.protocol.v2.paymentDetails.amount = inputAmount;
  return raw;
}

async function startProductionFixtureServer(t, { stateDir, chains, quote }) {
  const caKeyPath = join(stateDir, 'fixture-ca-key.pem');
  const caCertificatePath = join(stateDir, 'fixture-ca-cert.pem');
  const keyPath = join(stateDir, 'fixture-tls-key.pem');
  const certificateRequestPath = join(stateDir, 'fixture-tls-request.pem');
  const certificatePath = join(stateDir, 'fixture-tls-cert.pem');
  const certificateExtensionsPath = join(stateDir, 'fixture-tls-extensions.cnf');
  await execFileAsync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', caKeyPath, '-out', caCertificatePath, '-subj', '/CN=Hookemon CLI test CA',
  ]);
  await execFileAsync('/usr/bin/openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certificateRequestPath, '-subj', '/CN=127.0.0.1',
  ]);
  await writeFile(certificateExtensionsPath, [
    'subjectAltName=IP:127.0.0.1',
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    '',
  ].join('\n'), 'utf8');
  await execFileAsync('/usr/bin/openssl', [
    'x509', '-req', '-in', certificateRequestPath,
    '-CA', caCertificatePath, '-CAkey', caKeyPath, '-CAcreateserial',
    '-out', certificatePath, '-days', '1', '-sha256', '-extfile', certificateExtensionsPath,
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  const requests = { evmChainId: 0, evmStatusRead: 0, solanaGenesis: 0, solanaBlockhash: 0 };
  const server = createHttpsServer({ key, cert }, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/chains') {
        writeJson(response, 200, chains);
        return;
      }
      if (request.method === 'POST' && request.url === '/quote/v2') {
        writeJson(response, 200, quote);
        return;
      }
      if (request.method === 'POST' && request.url === '/alert') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST' || !['/rpc', '/archive', '/solana'].includes(request.url)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const payload = JSON.parse(await readRequestBody(request));
      const respondRpc = result => writeJson(response, 200, { jsonrpc: '2.0', id: payload.id, result });
      if (request.url === '/rpc' || request.url === '/archive') {
        if (payload.method === 'eth_chainId') {
          requests.evmChainId += 1;
          respondRpc('0x1237');
          return;
        }
        if (payload.method === 'eth_call') {
          const data = payload.params?.[0]?.data;
          if (data === '0x5c975abb' || (typeof data === 'string' && data.startsWith('0xe5839836'))) {
            requests.evmStatusRead += 1;
            respondRpc(`0x${'0'.repeat(64)}`);
            return;
          }
        }
        writeJson(response, 200, {
          jsonrpc: '2.0', id: payload.id,
          error: { code: -32601, message: `unexpected EVM RPC method ${payload.method}` },
        });
        return;
      }
      if (payload.method === 'getGenesisHash') {
        requests.solanaGenesis += 1;
        respondRpc(SOLANA_MAINNET_GENESIS_HASH);
        return;
      }
      if (payload.method === 'getBalance') {
        respondRpc({ context: { slot: 12 }, value: 10_000_000 });
        return;
      }
      if (payload.method === 'getLatestBlockhash') {
        requests.solanaBlockhash += 1;
        respondRpc({ context: { slot: 12 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000 } });
        return;
      }
      if (payload.method === 'isBlockhashValid') {
        respondRpc({ context: { slot: 12 }, value: true });
        return;
      }
      if (payload.method === 'getBlockHeight') {
        respondRpc(12);
        return;
      }
      if (payload.method === 'getTransaction') {
        respondRpc({
          slot: 52,
          blockTime: 1_700_000_080,
          transaction: {
            message: {
              accountKeys: [{ pubkey: PRODUCTION_RETURN_SOLANA_ACCOUNT, signer: false, writable: true }],
              instructions: [],
            },
          },
          meta: {
            err: null,
            preTokenBalances: [{
              accountIndex: 0,
              mint: PRODUCTION_RETURN_SOLANA_MINT,
              owner: PRODUCTION_RETURN_SOLANA_ACCOUNT,
              uiTokenAmount: { amount: '17', decimals: 6, uiAmountString: '0.000017' },
            }],
            postTokenBalances: [{
              accountIndex: 0,
              mint: PRODUCTION_RETURN_SOLANA_MINT,
              owner: PRODUCTION_RETURN_SOLANA_ACCOUNT,
              uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' },
            }],
          },
        });
        return;
      }
      writeJson(response, 200, {
        jsonrpc: '2.0', id: payload.id,
        error: { code: -32601, message: `unexpected Solana RPC method ${payload.method}` },
      });
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return { baseUrl: `https://127.0.0.1:${port}`, caCertificatePath, requests };
}

async function writeFixtureKeychainCommand(stateDir) {
  const commandPath = join(stateDir, 'fixture-keychain.mjs');
  const script = [
    `#!${process.execPath}`,
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    "appendFileSync(process.env.HKMN_KEYCHAIN_LOG, input.operation + ':' + input.role + '\\n');",
    "const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';",
    'function encodeBase58(bytes) {',
    '  const digits = [0];',
    '  for (const byte of bytes) {',
    '    let carry = byte;',
    '    for (let index = 0; index < digits.length; index += 1) {',
    '      carry += digits[index] << 8;',
    '      digits[index] = carry % 58;',
    '      carry = Math.floor(carry / 58);',
    '    }',
    '    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }',
    '  }',
    "  let output = '';",
    "  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) output += '1';",
    '  for (let index = digits.length - 1; index >= 0; index -= 1) output += alphabet[digits[index]];',
    '  return output;',
    '}',
    "if (input.operation === 'probe') { process.stdout.write(JSON.stringify({ ready: true })); process.exit(0); }",
    "if (input.operation === 'sign') {",
    "  const raw = input.request?.data?.transaction;",
    "  if (typeof raw !== 'string') throw new Error('sign request is missing serialized Solana bytes');",
    "  const bytes = Buffer.from(raw, 'base64');",
    "  for (let index = 0; index < 64; index += 1) bytes[1 + index] = index + 1;",
    "  process.stdout.write(JSON.stringify({ signedTxBase64: bytes.toString('base64') }));",
    '  process.exit(0);',
    '}',
    "if (input.operation === 'broadcast') {",
    "  const raw = input.request?.data?.signedTxBase64;",
    "  if (typeof raw !== 'string') throw new Error('broadcast request is missing signed Solana bytes');",
    "  const bytes = Buffer.from(raw, 'base64');",
    "  process.stdout.write(JSON.stringify({ signature: encodeBase58(bytes.subarray(1, 65)) }));",
    '  process.exit(0);',
    '}',
    "throw new Error('unexpected keychain operation');",
    '',
  ].join('\n');
  await writeFile(commandPath, script, { mode: 0o700 });
  await chmod(commandPath, 0o700);
  return commandPath;
}

async function seedProductionReturnCycle(stateDir) {
  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const cycle = await repository.createCycle({ releaseAmount: '17', mode: 'production', providerMode: 'live' });
  for (const stage of ['eligibility-snapshot', 'claim-process', 'outbound', 'purchase', 'open', 'epic-gate', 'buyback']) {
    await repository.prepareStage(cycle.cycleId, stage);
    await repository.completeStage(cycle.cycleId, stage, { finalized: true, stage });
  }
  await repository.recordCustodyLedger(cycle.cycleId, {
    schema: 'hookemon.custody-ledger.v1',
    cycleId: cycle.cycleId,
    chainId: '792703809',
    assetId: PRODUCTION_RETURN_SOLANA_MINT,
    decimals: 6,
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '17',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  });
  const policy = applyOperatorConfiguration(null, {
    intervalMinutes: 5,
    allowedPackIds: ['return-fixture'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '17',
    maxCycleBudgetMicroUsdg: '17',
    max24HourBudgetMicroUsdg: '17',
    paused: false,
    liveMode: true,
    maxCyclesPerDay: 3,
    perCycleCapMicroUsdg: '17',
    lossCapMicroUsdg: '1000',
    maxOutstandingCustodyMicroUsdg: '1000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 3,
  });
  const cycleDigest = deriveCyclePolicyDigest({
    configuration: policy,
    cycleId: cycle.cycleId,
    releaseAmountMicroUsdg: cycle.releaseAmount,
    packId: 'return-fixture',
    liveMode: true,
    mode: 'production',
  });
  const now = Date.now();
  const configured = {
    ...policy,
    approvalsByCycleDigest: { [cycleDigest]: { cycleId: cycle.cycleId, approvedAtMs: now } },
    cycleLedger: [{
      cycleId: cycle.cycleId,
      cycleDigest,
      mode: 'production',
      openedAtMs: now,
      releaseAmountMicroUsdg: cycle.releaseAmount,
    }],
    spendLedger: [{
      cycleId: cycle.cycleId,
      cycleDigest,
      amountMicroUsdg: cycle.releaseAmount,
      reservedAtMs: now,
    }],
  };
  await mutateOperatorState(join(stateDir, 'operator-state.json'), null, state => ({
    ...(state ?? createEmptyOperatorState()),
    configuration: configured,
  }));
  return { cycle, repository };
}

test('fresh production resume composes keychain and observability before refusing a frozen-interface mutation', { timeout: 30_000 }, async t => {
  const stateDir = await tempStateDir(t);
  const [chains, quote] = await Promise.all([
    readFile(new URL('../fixtures/relay/chains.json', import.meta.url), 'utf8').then(JSON.parse),
    buildReturnRelayQuote(),
  ]);
  const fixtureServer = await startProductionFixtureServer(t, { stateDir, chains, quote });
  const keychainCommand = await writeFixtureKeychainCommand(stateDir);
  const keychainLogPath = join(stateDir, 'keychain.log');
  const observabilityPath = join(stateDir, 'observability.json');
  await writeFile(observabilityPath, `${JSON.stringify(productionObservabilityConfig({ baseUrl: fixtureServer.baseUrl, stateDir }))}\n`, 'utf8');
  const { cycle, repository } = await seedProductionReturnCycle(stateDir);
  const { NODE_TLS_REJECT_UNAUTHORIZED: _unsafeTlsOverride, ...trustedBaseEnv } = baseEnv(stateDir);
  const env = {
    ...trustedBaseEnv,
    HOOKEMON_CHAIN_ID: '4663',
    HOOKEMON_ROBINHOOD_RPC_URL: `${fixtureServer.baseUrl}/rpc`,
    HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: `${fixtureServer.baseUrl}/archive`,
    HOOKEMON_SOLANA_RPC_URL: `${fixtureServer.baseUrl}/solana`,
    HOOKEMON_RELAY_BASE_URL: fixtureServer.baseUrl,
    HOOKEMON_RELAY_API_KEY: 'fixture-relay-key',
    HOOKEMON_RELAY_SOLANA_MINT: PRODUCTION_RETURN_SOLANA_MINT,
    HOOKEMON_RELAY_SOLANA_DECIMALS: '6',
    HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: `${fixtureServer.baseUrl}/collector`,
    HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'fixture-collector-key',
    HOOKEMON_EVM_ACCOUNT: PRODUCTION_RETURN_EVM_ACCOUNT,
    HOOKEMON_SOLANA_ACCOUNT: PRODUCTION_RETURN_SOLANA_ACCOUNT,
    HOOKEMON_VAULT_ADDRESS: `0x${'b'.repeat(40)}`,
    HOOKEMON_HOOK_ADDRESS: `0x${'c'.repeat(40)}`,
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'true',
    HOOKEMON_KEYCHAIN_COMMAND: keychainCommand,
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_PROVIDER_MODE: 'live',
    HOOKEMON_PACK_CODE: 'return-fixture',
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_MIN_SOLANA_RECEIVE: '0',
    HOOKEMON_MIN_RETURN_USDG: '0',
    HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0',
    HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0',
    HOOKEMON_EVM_GAS_PRICE_CAP: '2',
    HOOKEMON_EVM_NATIVE_RESERVE: '2',
    HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2',
    HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '17',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '17',
    HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '17',
    HOOKEMON_BUDGET_RETURN_CAP_USDG: '17',
    HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
    HKMN_KEYCHAIN_LOG: keychainLogPath,
    NODE_EXTRA_CA_CERTS: fixtureServer.caCertificatePath,
  };
  assert.equal(Object.hasOwn(env, 'NODE_TLS_REJECT_UNAUTHORIZED'), false);
  assert.equal(env.NODE_EXTRA_CA_CERTS, fixtureServer.caCertificatePath);

  await assert.rejects(
    execFileAsync(process.execPath, [BIN_PATH, 'resume', cycle.cycleId], { env }),
    error => {
      assert.match(error.stderr, /active frozen interface authority is invalid/);
      return true;
    },
  );

  assert.ok(fixtureServer.requests.evmChainId > 0, 'production composition must probe the configured EVM RPC');
  assert.ok(fixtureServer.requests.evmStatusRead >= 2, 'the production resume must verify USDG pause and Operations freeze status');
  assert.ok(fixtureServer.requests.solanaGenesis > 0, 'production composition must verify the configured Solana network');
  assert.ok(fixtureServer.requests.solanaBlockhash > 0, 'observability start preflight must probe the configured Solana RPC');
  const keychainCalls = (await readFile(keychainLogPath, 'utf8')).trim().split('\n');
  assert.deepEqual(new Set(keychainCalls), new Set(['probe:operator-evm', 'probe:operator-solana']));
  assert.equal(keychainCalls.length, 2, 'the frozen interface must refuse before a keychain sign or broadcast');
  const description = await repository.describeCycle(cycle.cycleId);
  assert.equal(description.chainAttempts.size, 0);
  assert.equal((await repository.readStage(cycle.cycleId, 'return')).status, 'PENDING');
});

/** Reserves an ephemeral local TCP port by binding to :0 and immediately closing — inherently a race
 * against another process grabbing the same port before the CLI subprocess binds it, same as every
 * other "find a free port for a test server" helper; acceptable here given how briefly the window is
 * and how small the test's own concurrency is. */
async function reserveEphemeralPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Spawns the CLI, waits for `pattern` to appear on stderr (the ready signal `runRun` writes once
 * its listener is actually bound), then returns the child so the caller can exercise it and is
 * responsible for terminating it. Rejects if the process exits, errors, or the pattern never
 * appears before `timeoutMs`. */
function spawnUntil(argv, env, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${pattern} in stderr; captured: ${stderr}`));
    }, timeoutMs);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (!settled && pattern.test(stderr)) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`hookemon-runner exited before ${pattern} appeared (code=${code}, signal=${signal}); stderr: ${stderr}`));
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

test('waitForExit resolves when a child exited before subscription', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  const expected = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const result = await Promise.race([
    waitForExit(child),
    new Promise(resolve => queueMicrotask(() => resolve('still waiting'))),
  ]);
  assert.deepEqual(result, expected);
});

async function exerciseInjectedProductionRun(argv, expectedWithDashboard) {
  const calls = { composition: [], start: 0, settled: 0, shutdown: 0 };
  const composition = {
    dashboard: null,
    scheduler: {
      start() {
        calls.start += 1;
        queueMicrotask(() => process.emit('SIGTERM'));
      },
      async settled() {
        calls.settled += 1;
      },
    },
    async shutdown() {
      calls.shutdown += 1;
    },
  };

  await runCli(argv, {
    buildComposition: async input => {
      calls.composition.push(input);
      return composition;
    },
  });

  assert.deepEqual(calls.composition, [{
    statePathOverride: null,
    withDashboard: expectedWithDashboard,
    logTicks: true,
    profile: 'production',
  }]);
  assert.equal(calls.start, 1);
  assert.equal(calls.settled, 1);
  assert.ok(calls.shutdown >= 1);
}

test('hookemon-runner run requests the scheduler and dashboard composition, then handles graceful shutdown', async () => {
  await exerciseInjectedProductionRun(['run', '--mode', 'production'], true);
});

test('hookemon-runner run --no-dashboard requests the scheduler-only composition', async () => {
  await exerciseInjectedProductionRun(['run', '--mode', 'production', '--no-dashboard'], false);
});

test('hookemon-runner run propagates a dashboard configuration refusal before starting the scheduler', async () => {
  await assert.rejects(
    runCli(['run', '--mode', 'production'], {
      buildComposition: async input => {
        assert.equal(input.withDashboard, true);
        throw new Error('HOOKEMON_DASHBOARD_PROXY_CREDENTIAL is required');
      },
    }),
    /HOOKEMON_DASHBOARD_PROXY_CREDENTIAL is required/,
  );
});

test('hookemon-runner run rejects an ambiguous execution profile before it can create a signer or listener', async t => {
  const stateDir = await tempStateDir(t);
  await assert.rejects(
    execFileAsync(process.execPath, [BIN_PATH, 'run'], { env: baseEnv(stateDir) }),
    error => /run requires --mode production or rehearsal/.test(error.stderr),
  );
});

test('hookemon-runner run --no-dashboard still requires an explicit execution profile', async t => {
  const stateDir = await tempStateDir(t);
  await assert.rejects(
    execFileAsync(process.execPath, [BIN_PATH, 'run', '--no-dashboard'], { env: baseEnv(stateDir) }),
    error => /run requires --mode production or rehearsal/.test(error.stderr),
  );
});

test('hookemon-runner refuses rehearsal-only flags without rehearsal mode', async t => {
  const stateDir = await tempStateDir(t);
  await assert.rejects(
    execFileAsync(process.execPath, [BIN_PATH, 'run', '--mode', 'production', '--collector-only'], { env: baseEnv(stateDir) }),
    error => /require --mode rehearsal/.test(error.stderr),
  );
});
