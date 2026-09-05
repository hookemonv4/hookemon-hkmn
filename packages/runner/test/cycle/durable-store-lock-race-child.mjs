import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { DURABLE_LOCK_RACE_DIRECTORY: directory, DURABLE_LOCK_RACE_ROLE: role } = process.env;
if (typeof directory !== 'string' || typeof role !== 'string') {
  throw new Error('durable lock race child configuration is incomplete');
}

const lockPath = join(directory, 'store.lock');
const lockDatabasePath = join(directory, '.store-lock', 'lease.sqlite');

function announce(stage, details = {}) {
  if (typeof process.send !== 'function') throw new Error('durable lock race child requires an IPC parent');
  process.send({ stage, ...details });
}

async function waitForResume() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('durable lock race child resume timed out')), 10_000);
    process.once('message', message => {
      clearTimeout(timeout);
      if (message !== 'resume') {
        reject(new Error('durable lock race child received an unexpected command'));
        return;
      }
      resolve();
    });
  });
}

try {
  if (role === 'post-stat-unlinker') {
    await lstat(lockPath);
    announce('post-stat');
    await waitForResume();
    await unlink(lockPath);
    announce('result', { outcome: 'unlinked' });
  } else if (role === 'legacy-fence-holder') {
    const token = 'child-legacy-fence-token';
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    announce('legacy-fence-held', { token });
    await waitForResume();
    await unlink(lockPath);
    announce('result', { outcome: 'released' });
  } else if (role === 'sqlite-holder') {
    const database = new DatabaseSync(lockDatabasePath);
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
      announce('sqlite-lease-held');
      await waitForResume();
      database.exec('COMMIT');
      announce('result', { outcome: 'released' });
    } finally {
      database.close();
    }
  } else {
    throw new Error('durable lock race child role is invalid');
  }
} catch (error) {
  announce('result', { outcome: 'error', message: error?.message ?? String(error) });
}
