import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { canonicalJson } from '../../src/cycle/journal.mjs';

const cliUrl = new URL('../../src/operator/cli.mjs', import.meta.url);
const nodePath = process.execPath;
const hash = character => `sha256:${character.repeat(64)}`;

async function cliModule() {
  return import(cliUrl.href);
}

async function temporaryWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-operator-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, inputPath: name => join(directory, name) };
}

async function writeCanonical(path, value) {
  await writeFile(path, `${canonicalJson(value)}\n`, { mode: 0o600 });
}

function authority() {
  const calls = { status: 0, execute: [], audited: [], events: [] };
  return {
    calls,
    operatorControl: {
      async status() {
        calls.status += 1;
        return { activeCycleId: null, revision: 4 };
      },
      async execute(input) {
        calls.events.push('effect');
        calls.execute.push(input);
        return { action: input.command.type, revision: input.expectedRevision };
      },
    },
    async executeAudited({ effect, ...input }) {
      calls.events.push('audit');
      calls.audited.push(input);
      return effect();
    },
  };
}

function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [cliUrl.pathname, ...args], {
      env: { ...process.env, OPENSSL_CONF: '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

test('CLI source has no standalone cycle-store lifecycle', async () => {
  const source = await readFile(cliUrl, 'utf8');
  assert.match(source, /export async function runOperatorCli/);
  assert.doesNotMatch(source, /new OperatorControl|class OperatorControl|FixtureCycleStore|CycleRunner/);
  assert.doesNotMatch(source, /cycle prepare|cycle freeze|cycle start|abandon-expired/);
});

test('status and reconcile use the injected authority without an audit executor', async () => {
  const injected = authority();
  const { runOperatorCli } = await cliModule();

  assert.deepEqual(
    await runOperatorCli(['status'], { operatorControl: injected.operatorControl }),
    { activeCycleId: null, revision: 4 },
  );
  assert.deepEqual(
    await runOperatorCli(['reconcile', '--expected-revision', '4'], { operatorControl: injected.operatorControl }),
    { action: 'reconcile', revision: 4 },
  );
  assert.equal(injected.calls.status, 1);
  assert.deepEqual(injected.calls.execute, [{ expectedRevision: 4, command: { type: 'reconcile' } }]);
  assert.deepEqual(injected.calls.audited, []);
});

test('recovery inspection refuses a fresh signature while a durable chain attempt is unresolved', async () => {
  const { inspectCycleRecovery } = await cliModule();
  const recovery = inspectCycleRecovery({
    cycleId: 'cycle-recovery',
    mode: 'rehearsal',
    terminalState: null,
    operationalAttempts: new Map(),
    chainAttempts: new Map([[
      'purchase\u0000sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      {
        attempt: {
          stage: 'purchase',
          state: 'SIGNED',
          requestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          rawBytes: 'not-for-status-output',
          hash: null,
        },
      },
    ]]),
  });
  assert.deepEqual(recovery, {
    resumable: false,
    reason: 'CHAIN_ATTEMPT_UNRESOLVED',
    reconciliationOnly: false,
  });
});

test('repository status exposes custody facts without signed transaction bytes', async () => {
  const { projectCycleRepositoryStatus } = await cliModule();
  const custody = {
    schema: 'hookemon.custody-ledger.v1',
    cycleId: 'cycle-status',
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:stablecoin',
    decimals: 6,
    claimed: '30',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '30',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
  const status = projectCycleRepositoryStatus({
    cycleId: 'cycle-status',
    mode: 'rehearsal',
    releaseAmount: '30',
    terminalState: null,
    completed: false,
    archived: false,
    stages: new Map(),
    operationalAttempts: new Map(),
    chainAttempts: new Map([['claim', {
      attempt: { stage: 'claim-process', state: 'SIGNED', requestDigest: hash('b'), rawBytes: 'secret-signed-bytes', hash: null },
    }]]),
    custodyLedgers: new Map([['custody', custody]]),
  });

  assert.deepEqual(status.custody, [custody]);
  assert.equal(JSON.stringify(status).includes('secret-signed-bytes'), false);
});

test('effectful CLI commands require the injected audited executor', async () => {
  const injected = authority();
  const { runOperatorCli } = await cliModule();

  await assert.rejects(
    runOperatorCli(['pause', '--expected-revision', '4', '--request-id', 'request-1'], {
      operatorControl: injected.operatorControl,
    }),
    /audited.*required|audit.*required/i,
  );
  assert.deepEqual(injected.calls.execute, []);

  assert.deepEqual(
    await runOperatorCli(['pause', '--expected-revision', '4', '--request-id', 'request-1'], injected),
    { action: 'pause', revision: 4 },
  );
  assert.deepEqual(injected.calls.audited, [{
    requestId: 'request-1',
    expectedRevision: 4,
    command: { type: 'pause' },
  }]);
  assert.deepEqual(injected.calls.execute, [{ expectedRevision: 4, requestId: 'request-1', command: { type: 'pause' } }]);
  assert.deepEqual(injected.calls.events, ['audit', 'effect']);
});

test('an audited executor cannot alter the command bound to its deferred effect', async t => {
  const workspace = await temporaryWorkspace(t);
  const configurationPath = workspace.inputPath('configuration.json');
  await writeCanonical(configurationPath, { intervalMinutes: 30 });
  const injected = authority();
  const { runOperatorCli } = await cliModule();
  let mutationError = null;

  const result = await runOperatorCli([
    'update-configuration', '--expected-revision', '4', '--request-id', 'request-bound-command', '--input', configurationPath,
  ], {
    operatorControl: injected.operatorControl,
    async executeAudited(input) {
      try {
        input.command.configuration.intervalMinutes = 45;
      } catch (error) {
        mutationError = error;
      }
      return input.effect();
    },
  });

  assert.deepEqual(result, { action: 'update-configuration', revision: 4 });
  assert.ok(mutationError instanceof TypeError);
  assert.deepEqual(injected.calls.execute, [{
    expectedRevision: 4,
    requestId: 'request-bound-command',
    command: { type: 'update-configuration', configuration: { intervalMinutes: 30 } },
  }]);
});

test('configuration and manual-approval inputs are absolute canonical JSON', async t => {
  const workspace = await temporaryWorkspace(t);
  const configurationPath = workspace.inputPath('configuration.json');
  const approvalPath = workspace.inputPath('approval.json');
  await writeCanonical(configurationPath, { intervalMinutes: 30 });
  await writeCanonical(approvalPath, { cycleId: 'cycle-one', cycleDigest: hash('a') });
  const injected = authority();
  const { runOperatorCli } = await cliModule();

  await runOperatorCli([
    'update-configuration', '--expected-revision', '4', '--request-id', 'request-configuration', '--input', configurationPath,
  ], injected);
  await runOperatorCli([
    'manual-approval', '--expected-revision', '4', '--request-id', 'request-approval', '--input', approvalPath,
  ], injected);

  assert.deepEqual(injected.calls.audited, [
    {
      requestId: 'request-configuration',
      expectedRevision: 4,
      command: { type: 'update-configuration', configuration: { intervalMinutes: 30 } },
    },
    {
      requestId: 'request-approval',
      expectedRevision: 4,
      command: { type: 'manual-approval', cycleId: 'cycle-one', cycleDigest: hash('a') },
    },
  ]);
  await assert.rejects(
    runOperatorCli([
      'update-configuration', '--expected-revision', '4', '--request-id', 'request-relative', '--input', 'relative.json',
    ], injected),
    /absolute/i,
  );
  await writeFile(configurationPath, '{ "intervalMinutes": 30 }\n', { mode: 0o600 });
  await assert.rejects(
    runOperatorCli([
      'update-configuration', '--expected-revision', '4', '--request-id', 'request-noncanonical', '--input', configurationPath,
    ], injected),
    /canonical/i,
  );
});

test('held owner decision input is forwarded through the audited authority', async t => {
  const workspace = await temporaryWorkspace(t);
  const decisionPath = workspace.inputPath('held-owner-decision.json');
  await writeCanonical(decisionPath, {
    choice: 'keep-holding',
    cycleId: 'cycle-one',
    expectedCycleRevision: 2,
    heldEvidenceDigest: hash('b'),
  });
  const injected = authority();
  const { runOperatorCli } = await cliModule();

  await runOperatorCli([
    'held-owner-decision', '--expected-revision', '4', '--request-id', 'request-held', '--input', decisionPath,
  ], injected);

  assert.deepEqual(injected.calls.audited, [{
    requestId: 'request-held',
    expectedRevision: 4,
    command: {
      type: 'held-owner-decision',
      cycleId: 'cycle-one',
      heldEvidenceDigest: hash('b'),
      expectedCycleRevision: 2,
      choice: 'keep-holding',
    },
  }]);
  assert.deepEqual(injected.calls.execute, [{
    expectedRevision: 4,
    requestId: 'request-held',
    command: {
      type: 'held-owner-decision',
      cycleId: 'cycle-one',
      heldEvidenceDigest: hash('b'),
      expectedCycleRevision: 2,
      choice: 'keep-holding',
    },
  }]);
});

test('the executable reports missing composed authority with bounded diagnostics', async () => {
  const result = await invoke(['status']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /composed authority/i);
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= 512);
});
