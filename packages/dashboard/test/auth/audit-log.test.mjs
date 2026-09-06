import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendAuditEntry,
  commandDigest,
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

test('a lock file older than the stale threshold is cleaned up by its durable modification time alone, never by an unreachable owner pid', async () => {
  const path = await tempPath();
  const lockPath = `${path}.lock`;
  // A pid this host can never observe (e.g. from a different host sharing the log) — proving cleanup
  // does not depend on being able to confirm or deny that pid's liveness at all.
  await writeFile(lockPath, JSON.stringify({ token: 'foreign-token', pid: 999_999 }), { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);

  await appendAuditEntry(path, entry({ eventId: 'after-stale-lock' }));

  const entries = await readAllAuditEntries(path);
  assert.equal(entries.length, 1);
});

test('a fresh lock file is left alone even though its owner pid is unreachable from this host', async () => {
  const path = await tempPath();
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, JSON.stringify({ token: 'foreign-token', pid: 999_999 }), { mode: 0o600 });

  const attempt = appendAuditEntry(path, entry({ eventId: 'blocked-by-fresh-lock' }));
  let settled = false;
  attempt.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false, 'a lock only 100ms old must not be treated as stale regardless of its recorded pid');

  await unlink(lockPath);
  await attempt;
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

test('an effect may replace its applied audit result code without changing its prepared or replayed receipt', async () => {
  const path = await tempPath();
  const input = auditedInput(path, {
    requestId: 'request-supplementary-recovery',
    command: { type: 'resume-cycle' },
    resultCode: 'RECOVERY_DISPATCHED',
    async effect() {
      return { auditResultCode: 'RECOVERY_SUPPLEMENTARY_SETTLEMENT' };
    },
  });

  const first = await executeAuditedCommand(input);
  const replay = await executeAuditedCommand(input);
  const records = await readAllAuditEntries(path);

  assert.equal(first.replayed, false);
  assert.equal(first.receipt.resultCode, 'RECOVERY_SUPPLEMENTARY_SETTLEMENT');
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.resultCode, 'RECOVERY_SUPPLEMENTARY_SETTLEMENT');
  assert.deepEqual(records.map(record => record.resultCode), [
    'COMMAND_PREPARED',
    'RECOVERY_SUPPLEMENTARY_SETTLEMENT',
  ]);
  assert.deepEqual(records.map(record => record.commandState), ['PREPARED', 'APPLIED']);
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

function seedPreparedEntry(path, { requestId, occurredAt, claimToken = undefined }) {
  return appendAuditEntry(path, {
    eventId: 'seed-prepared',
    occurredAt,
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    action: 'pause',
    outcome: 'accepted',
    resultCode: 'COMMAND_DISPATCHED',
    observedVersion: 0,
    note: null,
    requestId,
    commandDigest: commandDigest({ expectedVersion: 0, command: { type: 'pause' }, note: null }),
    commandState: 'PREPARED',
    ...(claimToken === undefined ? {} : { claimToken }),
  });
}

test('a PREPARED command still within its lease is replayed, not re-executed', async () => {
  const path = await tempPath();
  let effects = 0;
  const requestId = 'request-within-lease';
  await seedPreparedEntry(path, { requestId, occurredAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), claimToken: '11111111-1111-4111-8111-111111111111' });

  const result = await executeAuditedCommand(auditedInput(path, {
    requestId,
    now: () => Date.UTC(2026, 0, 1, 0, 0, 1), // one second later, well inside the default lease
    async effect() { effects += 1; },
  }));

  assert.equal(effects, 0);
  assert.equal(result.replayed, true);
  assert.equal(result.commandState, 'PREPARED');
});

test('a legacy PREPARED command with no claimToken ages out and is reclaimed exactly like a fresh orphan — no separate migration path', async () => {
  const path = await tempPath();
  let effects = 0;
  const requestId = 'request-legacy-no-claim-token';
  await seedPreparedEntry(path, { requestId, occurredAt: new Date(Date.UTC(2026, 0, 1)).toISOString() });

  const result = await executeAuditedCommand(auditedInput(path, {
    requestId,
    leaseTtlMs: 1_000,
    now: () => Date.UTC(2026, 0, 1, 0, 0, 5), // five seconds later, past a 1s lease
    async effect() { effects += 1; },
  }));
  const records = await readAllAuditEntries(path);

  assert.equal(effects, 1, 'a legacy record with no claimToken is still reclaimed once it is old enough');
  assert.equal(result.replayed, false);
  assert.equal(result.commandState, 'APPLIED');
  assert.deepEqual(records.map(record => record.commandState), ['PREPARED', 'PREPARED', 'APPLIED']);
  assert.equal(typeof records[1].claimToken, 'string', 'the reclaim entry is durably claimed going forward');

  const retry = await executeAuditedCommand(auditedInput(path, { requestId, async effect() { throw new Error('must not run once resolved'); } }));
  assert.equal(effects, 1, 'a retry after resolution never re-runs the effect');
  assert.equal(retry.replayed, true);
  assert.equal(retry.commandState, 'APPLIED');
});

test('a stale claim is only ever reclaimed by age, never by a generic effect-error message — recovering it never fabricates APPLIED', async () => {
  const path = await tempPath();
  let effects = 0;
  const requestId = 'request-orphan-genuine-failure';
  await seedPreparedEntry(path, { requestId, occurredAt: new Date(Date.UTC(2026, 0, 1)).toISOString() });

  await assert.rejects(executeAuditedCommand(auditedInput(path, {
    requestId,
    leaseTtlMs: 1_000,
    now: () => Date.UTC(2026, 0, 1, 0, 0, 5),
    async effect() {
      effects += 1;
      // The same message a stale operator-state CAS failure produces (see control.mjs) — but this
      // log has no authority-specific way to know that means "already applied" and must not guess.
      throw new Error('stale operator state revision');
    },
  })));

  const retry = await executeAuditedCommand(auditedInput(path, { requestId, async effect() { throw new Error('must not run once resolved'); } }));
  assert.equal(effects, 1);
  assert.equal(retry.replayed, true);
  assert.equal(retry.commandState, 'UNCERTAIN');
  assert.equal(retry.receipt.resultCode, 'COMMAND_UNCERTAIN');
});

test('a heartbeat renewal keeps a slow but genuinely alive effect from appearing orphaned to a concurrent attempt', async () => {
  const path = await tempPath();
  const requestId = 'request-heartbeat-keepalive';
  const effectStarted = deferred();
  const releaseEffect = deferred();
  let effects = 0;

  const slow = executeAuditedCommand(auditedInput(path, {
    requestId,
    leaseTtlMs: 80,
    heartbeatIntervalMs: 25,
    now: () => Date.now(),
    async effect() {
      effects += 1;
      effectStarted.resolve();
      await releaseEffect.promise;
    },
  }));
  await effectStarted.promise;
  // Wait past the 80ms lease without the concurrent call ever seeing it go stale, proving the
  // heartbeat (every 25ms) renewed it durably in the meantime.
  await new Promise(resolve => setTimeout(resolve, 200));

  const concurrent = await executeAuditedCommand(auditedInput(path, {
    requestId,
    leaseTtlMs: 80,
    now: () => Date.now(),
    async effect() { effects += 1; },
  }));
  releaseEffect.resolve();
  const slowResult = await slow;

  assert.equal(effects, 1, 'the concurrent attempt replayed the still-live claim instead of reclaiming and re-executing');
  assert.equal(concurrent.replayed, true);
  assert.equal(concurrent.commandState, 'PREPARED');
  assert.equal(slowResult.replayed, false);
  assert.equal(slowResult.commandState, 'APPLIED');
});

async function executeAuditedCommandFromChild({ path, requestId, sideEffectDir, leaseTtlMs }) {
  const modulePath = fileURLToPath(new URL('../../src/auth/audit-log.mjs', import.meta.url));
  const source = `
    import { executeAuditedCommand } from ${JSON.stringify(modulePath)};
    import { open } from 'node:fs/promises';
    import { join } from 'node:path';
    process.stdout.write('ready\\n');
    process.stdin.once('data', async () => {
      try {
        const result = await executeAuditedCommand({
          path: process.env.HOOKEMON_AUDIT_TEST_PATH,
          requestId: ${JSON.stringify(requestId)},
          command: { type: 'pause' },
          actor: { email: 'operator-console' },
          actorRole: 'operator',
          expectedVersion: 0,
          observedVersion: 0,
          note: null,
          leaseTtlMs: ${JSON.stringify(leaseTtlMs)},
          async effect() {
            const marker = join(process.env.HOOKEMON_SIDE_EFFECT_DIR, \`\${process.pid}-\${Date.now()}\`);
            const handle = await open(marker, 'wx');
            await handle.close();
            return { auditResultCode: 'CHILD_APPLIED' };
          },
        });
        process.stdout.write(JSON.stringify({ replayed: result.replayed, commandState: result.commandState }) + '\\n');
      } catch (error) {
        process.stderr.write(String(error.stack || error));
        process.exitCode = 1;
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, HOOKEMON_AUDIT_TEST_PATH: path, HOOKEMON_SIDE_EFFECT_DIR: sideEffectDir },
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
    start() { child.stdin.end('go\n'); },
    done: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => {
        if (code === 0) resolve(output);
        else reject(new Error(`audit child ${requestId} failed: ${output.stderr}`));
      });
    }),
  };
}

test('two independent child processes racing to recover the same orphaned claim run the effect exactly once', async () => {
  const path = await tempPath();
  const sideEffectDir = await mkdtemp(join(tmpdir(), 'hookemon-audit-side-effect-'));
  const requestId = 'request-two-process-race';
  // A legacy-shaped orphan (no claimToken) far enough in the past to be immediately reclaimable —
  // simulates a crash that predates a live owner ever being recorded, and stands in for "two hosts"
  // since each child is a fully independent OS process with its own process table, sharing nothing
  // but this file and the lock beside it.
  await seedPreparedEntry(path, { requestId, occurredAt: new Date(0).toISOString() });

  const [childA, childB] = await Promise.all([
    executeAuditedCommandFromChild({ path, requestId, sideEffectDir, leaseTtlMs: 1_000 }),
    executeAuditedCommandFromChild({ path, requestId, sideEffectDir, leaseTtlMs: 1_000 }),
  ]);
  childA.start();
  childB.start();
  const [outputA, outputB] = await Promise.all([childA.done, childB.done]);

  const sideEffects = await readdir(sideEffectDir);
  assert.equal(sideEffects.length, 1, 'exactly one claimant dispatched the effect');
  const resultA = JSON.parse(outputA.stdout.trim().split('\n').filter(Boolean).pop());
  const resultB = JSON.parse(outputB.stdout.trim().split('\n').filter(Boolean).pop());
  // Whichever child's check loses the race backs off immediately without waiting for the winner to
  // finish, so its own immediate return can observe either the winner's still-fresh PREPARED claim
  // or (if it happened to check slightly later) the winner's already-resolved APPLIED terminal state
  // — both are correct outcomes of the same single execution. The durable log is the actual
  // authority: it must end in exactly one terminal APPLIED state, with a valid chain throughout.
  for (const result of [resultA, resultB]) {
    assert.ok(['APPLIED', 'PREPARED'].includes(result.commandState), `unexpected commandState: ${result.commandState}`);
  }
  const records = await readAllAuditEntries(path);
  assert.deepEqual(records.filter(record => record.commandState === 'APPLIED').map(record => record.resultCode), ['CHILD_APPLIED']);
  const chain = await verifyAuditChain(path);
  assert.equal(chain.valid, true);
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
