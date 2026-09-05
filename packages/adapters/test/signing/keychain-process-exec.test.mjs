import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProcessExec } from '../../src/signing/keychain-process-exec.mjs';

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

test('keychain process executor terminates and reaps a helper that ignores SIGTERM', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-keychain-exec-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helperPath = join(directory, 'ignore-term.mjs');
  writeFileSync(helperPath, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[2], String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  `);

  const pidPath = join(directory, 'helper.pid');
  let processId;
  try {
    const pending = createProcessExec()({
      command: process.execPath,
      args: [helperPath, pidPath],
      input: '',
      timeoutMs: 500,
    });
    processId = await waitForProcessId(pidPath);
    const result = await Promise.race([
      pending,
      delay(1_000).then(() => { throw new Error('keychain executor did not reap the terminated helper'); }),
    ]);
    assert.equal(result.timedOut, true);
    assert.equal(await processExited(processId), true);
  } finally {
    if (processId !== undefined) forceKill(processId);
  }
});
