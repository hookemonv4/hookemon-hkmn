import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendAuditEntry,
  executeAuditedCommand,
  readAllAuditEntries,
  verifyAuditChain,
  GENESIS_HASH,
} from '../../src/auth/audit-log.mjs';

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-audit-'));
  return join(dir, 'audit.log');
}

function deferred() {
  let resolve;
  const promise = new Promise(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

function auditedInput(path, overrides = {}) {
  return {
    path,
    requestId: 'request-default',
    command: { type: 'pause' },
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    expectedVersion: 0,
    observedVersion: 0,
    note: null,
    now: () => Date.UTC(2026, 0, 1),
    async effect() {},
    ...overrides,
  };
}

async function appendFromChild(path, eventId) {
  const modulePath = fileURLToPath(new URL('../../src/auth/audit-log.mjs', import.meta.url));
  const source = `
    import { appendAuditEntry } from ${JSON.stringify(modulePath)};
    process.stdout.write('ready\\n');
    process.stdin.once('data', async () => {
      try {
        await appendAuditEntry(process.env.HOOKEMON_AUDIT_TEST_PATH, {
          eventId: ${JSON.stringify(eventId)},
          occurredAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          actor: { email: 'operator-console' },
          actorRole: 'operator',
          action: 'pause',
          outcome: 'accepted',
          resultCode: 'DECISION_ACCEPTED',
          observedVersion: 0,
          note: null,
        });
        process.stdout.write('done\\n');
      } catch (error) {
        process.stderr.write(String(error.stack || error));
        process.exitCode = 1;
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, HOOKEMON_AUDIT_TEST_PATH: path },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('ready')) resolve();
    });
  });
  return {
    start() { child.stdin.end('go\\n'); },
    done: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) resolve(output);
        else reject(new Error(`audit child ${eventId} failed: ${output.stderr}`));
      });
    }),
  };
}

function entry(overrides = {}) {
  return {
    eventId: 'event-1',
    occurredAt: new Date().toISOString(),
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    action: 'pause',
    outcome: 'accepted',
    resultCode: 'DECISION_ACCEPTED',
    observedVersion: 0,
    note: null,
    ...overrides,
  };
}

test('the first entry chains from the genesis hash', async () => {
  const path = await tempPath();
  const stored = await appendAuditEntry(path, entry());
  assert.equal(stored.sequence, 1);
  assert.equal(stored.prevHash, GENESIS_HASH);
  assert.match(stored.hash, /^sha256:[0-9a-f]{64}$/);
});

test('sequence increments and each entry chains to the previous hash', async () => {
  const path = await tempPath();
  const first = await appendAuditEntry(path, entry({ eventId: 'e1' }));
  const second = await appendAuditEntry(path, entry({ eventId: 'e2', action: 'activate' }));
  assert.equal(second.sequence, 2);
  assert.equal(second.prevHash, first.hash);
});

test('verifyAuditChain accepts an untampered log', async () => {
  const path = await tempPath();
  for (let i = 0; i < 5; i += 1) await appendAuditEntry(path, entry({ eventId: `e${i}` }));
  const result = await verifyAuditChain(path);
  assert.deepEqual(result, { valid: true, count: 5 });
});

test('verifyAuditChain detects a tampered field', async () => {
  const path = await tempPath();
  await appendAuditEntry(path, entry({ eventId: 'e1' }));
  await appendAuditEntry(path, entry({ eventId: 'e2' }));
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[0]);
  tampered.resultCode = 'FORGED';
  lines[0] = JSON.stringify(tampered);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  const result = await verifyAuditChain(path);
  assert.equal(result.valid, false);
});

test('verifyAuditChain detects a deleted middle entry', async () => {
  const path = await tempPath();
  await appendAuditEntry(path, entry({ eventId: 'e1' }));
  await appendAuditEntry(path, entry({ eventId: 'e2' }));
  await appendAuditEntry(path, entry({ eventId: 'e3' }));
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  await writeFile(path, `${[lines[0], lines[2]].join('\n')}\n`, 'utf8');
  const result = await verifyAuditChain(path);
  assert.equal(result.valid, false);
});

test('readAllAuditEntries returns an empty array for a missing file', async () => {
  const path = await tempPath();
  assert.deepEqual(await readAllAuditEntries(path), []);
});

test('concurrent appends to the same path are serialized without a sequence collision', async () => {
  const path = await tempPath();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => appendAuditEntry(path, entry({ eventId: `concurrent-${i}` }))),
  );
  const sequences = results.map(r => r.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const check = await verifyAuditChain(path);
  assert.equal(check.valid, true);
});

test('an audited command persists one dispatch receipt before its effect and replays that receipt', async () => {
  const path = await tempPath();
  const observed = [];
  let effects = 0;
  const input = {
    path,
    requestId: 'request-17',
    command: { type: 'pause' },
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    expectedVersion: 7,
    observedVersion: 7,
    note: 'pause before maintenance',
    now: () => Date.UTC(2026, 0, 1),
    async effect(receipt) {
      effects += 1;
      observed.push(await readAllAuditEntries(path));
      return { action: 'pause', revision: 8, receipt };
    },
  };

  const first = await executeAuditedCommand(input);
  const replay = await executeAuditedCommand({ ...input, observedVersion: 8 });

  assert.equal(effects, 1);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(first.receipt.resultCode, 'COMMAND_DISPATCHED');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].length, 1, 'the effect sees the durable audit record');
  assert.equal(observed[0][0].requestId, 'request-17');
  assert.equal(observed[0][0].commandDigest, first.receipt.commandDigest);
});

test('an audit persistence failure prevents the command effect', async () => {
  let effects = 0;
  await assert.rejects(
    executeAuditedCommand({
      path: '',
      requestId: 'request-18',
      command: { type: 'pause' },
      actor: { email: 'operator-console' },
      actorRole: 'operator',
      observedVersion: 0,
      note: null,
      now: () => Date.UTC(2026, 0, 1),
      async effect() { effects += 1; },
    }),
  );
  assert.equal(effects, 0);
});

test('concurrent identical request IDs persist one receipt and invoke one effect', async () => {
  const path = await tempPath();
  let effects = 0;
  const input = {
    path,
    requestId: 'request-concurrent',
    expectedVersion: 4,
    observedVersion: 4,
    command: { type: 'pause' },
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    note: null,
    now: () => Date.UTC(2026, 0, 1),
    async effect() { effects += 1; },
  };

  const [first, second] = await Promise.all([
    executeAuditedCommand(input),
    executeAuditedCommand(input),
  ]);

  assert.equal(effects, 1);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.deepEqual([first.commandState, second.commandState].sort(), ['APPLIED', 'PREPARED']);
  const entries = await readAllAuditEntries(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.commandState), ['PREPARED', 'APPLIED']);
});

test('a failed effect becomes uncertain and its retry reports the durable state without another effect', async () => {
  const path = await tempPath();
  let effects = 0;
  const input = auditedInput(path, {
    requestId: 'request-uncertain',
    async effect() {
      effects += 1;
      throw new Error('authority connection dropped after dispatch');
    },
  });

  await assert.rejects(() => executeAuditedCommand(input));
  const retry = await executeAuditedCommand(input);

  assert.equal(effects, 1);
  assert.equal(retry.replayed, true);
  assert.equal(retry.commandState, 'UNCERTAIN');
  assert.equal(retry.receipt.resultCode, 'COMMAND_UNCERTAIN');
});

test('a long-running effect does not hold the audit queue for a successor command', async () => {
  const path = await tempPath();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStartedSignal = deferred();
  let secondStarted = false;
  const first = executeAuditedCommand(auditedInput(path, {
    requestId: 'request-long',
    async effect() {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  }));
  await firstStarted.promise;
  const second = executeAuditedCommand(auditedInput(path, {
    requestId: 'request-successor',
    command: { type: 'kill' },
    async effect() {
      secondStarted = true;
      secondStartedSignal.resolve();
    },
  }));

  try {
    await Promise.race([
      secondStartedSignal.promise,
      new Promise(resolve => setTimeout(resolve, 250)),
    ]);
    assert.equal(secondStarted, true);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled([first, second]);
  }
});

test('a successor command still executes when its predecessor effect rejects', async () => {
  const path = await tempPath();
  let successorEffects = 0;
  const first = executeAuditedCommand(auditedInput(path, {
    requestId: 'request-rejected-predecessor',
    async effect() { throw new Error('authority unavailable'); },
  }));
  const successor = executeAuditedCommand(auditedInput(path, {
    requestId: 'request-after-rejection',
    command: { type: 'resume' },
    async effect() { successorEffects += 1; },
  }));

  await assert.rejects(first);
  await assert.doesNotReject(successor);
  assert.equal(successorEffects, 1);
});

test('separate processes assign one valid sequence chain to concurrent appends', async () => {
  const path = await tempPath();
  const children = await Promise.all(
    Array.from({ length: 6 }, (_, index) => appendFromChild(path, `process-${index}`)),
  );
  children.forEach(child => child.start());
  await Promise.all(children.map(child => child.done));

  const entries = await readAllAuditEntries(path);
  assert.deepEqual(entries.map(entry => entry.sequence).sort((left, right) => left - right), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await verifyAuditChain(path), { valid: true, count: 6 });
});
