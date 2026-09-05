import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { assertPairedDistributionApproval, VERIFIER_ROLE } from '../../../runner/src/distribution/distribution-signer.mjs';
import { createProcessExec as createVerifierProcessExec, runOnePass, runWatch, parseArgs } from '../../bin/hookemon-verifier.mjs';
import { buildDistributionVerificationRequest } from './distribution-fixture.mjs';

const execFileAsync = promisify(execFile);
const binPath = new URL('../../bin/hookemon-verifier.mjs', import.meta.url).pathname;
const fixtureVerifierOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function fakeVerifierSignerClient({ role = VERIFIER_ROLE, signature = 'ZmFrZS1zaWduYXR1cmU' } = {}) {
  const calls = [];
  return {
    client: { role, async sign(request) { calls.push(request); return signature; } },
    calls,
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForProcessId(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return Number(readFileSync(path, 'utf8'));
    await delay(10);
  }
  throw new Error('test helper did not record a process id');
}

async function processExited(processId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
    await delay(10);
  }
  return false;
}

function forceKill(processId) {
  try {
    process.kill(processId, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

test('parseArgs rejects an unknown flag and requires a mode', () => {
  assert.throws(() => parseArgs(['once', '--not-a-flag', 'x']), /unknown argument/);
});

test('the verifier keychain executor aborts and reaps a helper that ignores SIGTERM', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-keychain-exec-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helperPath = join(directory, 'ignore-term.mjs');
  writeFileSync(helperPath, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[2], String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  `);

  const pidPath = join(directory, 'verifier.pid');
  const controller = new AbortController();
  let processId;
  try {
    const pending = createVerifierProcessExec()({
      command: process.execPath,
      args: [helperPath, pidPath],
      input: '',
      // The abort below is the behaviour under test. Keep the executor deadline outside the
      // helper-startup window so the deadline cannot terminate the child before the readiness
      // handshake completes under a busy test runner.
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    processId = await waitForProcessId(pidPath);
    controller.abort();
    const result = await Promise.race([
      pending,
      delay(1_000).then(() => { throw new Error('verifier executor did not reap the terminated helper'); }),
    ]);
    assert.equal(result.timedOut, true);
    assert.equal(await processExited(processId), true);
  } finally {
    if (processId !== undefined) forceKill(processId);
  }
});

test('runOnePass refuses a signer client that is not bound to the verifier role', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-wrong-role-'));
  await assert.rejects(
    () => runOnePass({ dir, signerClient: { role: 'distribution-signer', sign: async () => 'x' } }),
    /requires a signer client bound to role "verifier"/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('runOnePass verifies a valid pending request and writes a receipt the runner accepts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-valid-'));
  const { approval, artifact, copies, context } = await buildDistributionVerificationRequest();
  const { client: signerClient, calls } = fakeVerifierSignerClient();

  // Seed the pending request the way a real runner/operator would.
  const results0 = await runOnePass({ dir, signerClient, ...fixtureVerifierOptions }); // creates the directories, nothing pending yet
  assert.deepEqual(results0, []);
  writeFileSync(join(dir, 'pending', 'cycle-1.json'), JSON.stringify({ artifact, copies, context }));

  const results = await runOnePass({ dir, signerClient, ...fixtureVerifierOptions });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'VERIFIED');
  assert.equal(calls.length, 1, 'the injected signer client must have been invoked exactly once');

  const receiptPath = join(dir, 'receipts', 'cycle-1.json');
  assert.equal(existsSync(receiptPath), true);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.verificationSignature, 'ZmFrZS1zaWduYXR1cmU');

  // "the runner accepts" — the production consumption path, paired against the distribution-signer
  // approval and the compiled artifact, exactly as design section 2.4 step 9 requires.
  const paired = assertPairedDistributionApproval(approval, artifact, receipt);
  assert.equal(paired.rootHash, artifact.root.hash);
  assert.equal(paired.rootSum, artifact.root.sum);

  rmSync(dir, { recursive: true, force: true });
});

test('runOnePass creates directories on first use, then never reprocesses an already-answered request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-idempotent-2-'));
  const { client: bootstrapClient } = fakeVerifierSignerClient();
  await runOnePass({ dir, signerClient: bootstrapClient, ...fixtureVerifierOptions }); // ensures pending/receipts/failed exist

  const { artifact, copies, context } = await buildDistributionVerificationRequest();
  writeFileSync(join(dir, 'pending', 'cycle-1.json'), JSON.stringify({ artifact, copies, context }));
  const { client: signerClient, calls } = fakeVerifierSignerClient();
  const first = await runOnePass({ dir, signerClient, ...fixtureVerifierOptions });
  assert.equal(first.length, 1);
  assert.equal(calls.length, 1);

  const second = await runOnePass({ dir, signerClient, ...fixtureVerifierOptions });
  assert.deepEqual(second, [], 'an already-answered request must never be reprocessed');
  assert.equal(calls.length, 1, 'the signer client must not be invoked again for an already-answered request');

  rmSync(dir, { recursive: true, force: true });
});

test('runOnePass writes a failed/ record (never a receipt) for a request that fails to verify', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-failed-'));
  const { client: bootstrapClient } = fakeVerifierSignerClient();
  await runOnePass({ dir, signerClient: bootstrapClient, ...fixtureVerifierOptions });

  const { artifact, copies, context } = await buildDistributionVerificationRequest();
  const tamperedCopies = copies.map((copy, index) => (index === 0 ? { ...copy, manifestBytes: 'tampered' } : copy));
  writeFileSync(join(dir, 'pending', 'cycle-bad.json'), JSON.stringify({ artifact, copies: tamperedCopies, context }));

  const { client: signerClient, calls } = fakeVerifierSignerClient();
  const results = await runOnePass({ dir, signerClient, ...fixtureVerifierOptions });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'FAILED');
  assert.equal(calls.length, 0, 'a request that fails reconstruction must never reach the signer client');
  assert.equal(existsSync(join(dir, 'failed', 'cycle-bad.json')), true);
  assert.equal(existsSync(join(dir, 'receipts', 'cycle-bad.json')), false);

  rmSync(dir, { recursive: true, force: true });
});

test('runWatch polls until its AbortSignal fires, and stops calling the signer client afterward', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-watch-'));
  const { client: signerClient } = fakeVerifierSignerClient();
  const controller = new AbortController();
  const watchPromise = runWatch({ dir, signerClient, ...fixtureVerifierOptions, intervalMs: 5, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await watchPromise;
  assert.equal(existsSync(join(dir, 'pending')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('hookemon-verifier CLI records a refusal before its external verifier module can sign', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-subprocess-'));
  const { approval, artifact, copies, context } = await buildDistributionVerificationRequest();
  const request = { artifact, copies, context };

  // A throwaway, test-only Ed25519 key — generated once for this fixture, never a production key,
  // never read from a file (embedded directly in this fixture module's source, in-process).
  const signerModulePath = join(dir, 'fake-verifier-signer.mjs');
  writeFileSync(signerModulePath, `
    import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
    const KEY = createPrivateKey({
      key: Buffer.from('302e020100300506032b6570042204208b72aa0078d38dd84cce459f6357af524a276b96580d43bcf4a669407e02dcb7', 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    export function createSignerClient(role, { liveMode }) {
      if (role !== 'verifier') throw new Error('unexpected role: ' + role);
      if (!liveMode) throw new Error('expected liveMode true');
      return {
        async sign(request) {
          return cryptoSign(null, request, KEY).toString('base64url');
        },
      };
    }
  `);

  const pendingDir = join(dir, 'state', 'pending');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(join(pendingDir, 'cycle-child.json'), JSON.stringify(request));

  const { stdout } = await execFileAsync(process.execPath, [
    binPath, 'once',
    '--dir', join(dir, 'state'),
    '--live-mode',
    '--signer-backend', 'module',
    '--signer-module', signerModulePath,
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'FAILED');
  assert.match(parsed[0].error, /active frozen interface authority is invalid/);

  const receiptPath = join(dir, 'state', 'receipts', 'cycle-child.json');
  assert.equal(existsSync(receiptPath), false);
  const failure = JSON.parse(readFileSync(join(dir, 'state', 'failed', 'cycle-child.json'), 'utf8'));
  assert.match(failure.error, /active frozen interface authority is invalid/);

  rmSync(dir, { recursive: true, force: true });
});

test('hookemon-verifier subprocess refuses to start without --live-mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-subprocess-no-live-'));
  await assert.rejects(
    execFileAsync(process.execPath, [binPath, 'once', '--dir', dir, '--signer-backend', 'module', '--signer-module', join(dir, 'nonexistent.mjs')]),
  );
  rmSync(dir, { recursive: true, force: true });
});
