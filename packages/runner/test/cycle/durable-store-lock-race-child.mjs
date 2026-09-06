import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DurableCycleStore } from '../../src/cycle/durable-store.mjs';
import { CycleJournal } from '../../src/cycle/journal.mjs';

const {
  DURABLE_LOCK_RACE_DIRECTORY: directory,
  DURABLE_LOCK_RACE_ROLE: role,
  DURABLE_LOCK_RACE_HAMMER_PREFIX: hammerPrefix,
  DURABLE_LOCK_RACE_HAMMER_ITERATIONS: hammerIterationsRaw,
} = process.env;
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
  } else if (role === 'commit-hammer') {
    // A genuinely independent OS process, not a same-process instance sharing anything but the
    // filesystem, repeatedly opening and committing against the same directory as fast as possible —
    // the actual "concurrent writers" shape that reproduces the store.lock release-order race: a
    // benign "durable cycle store lock contention" from real contention is expected and ignored; a
    // raw ENOENT or a "legacy migration fence is missing" surfacing all the way to this catch is the
    // defect under test and is reported back to the parent as a failure.
    const iterations = Number(hammerIterationsRaw);
    if (!Number.isInteger(iterations) || iterations <= 0) throw new Error('durable lock race hammer iterations is invalid');
    const anomalies = [];
    let contentions = 0;
    let store = null;
    while (store === null) {
      try {
        store = await DurableCycleStore.open(directory);
      } catch (error) {
        if (error?.message !== 'durable cycle store lock contention') throw error;
        contentions += 1;
      }
    }
    for (let index = 0; index < iterations; index += 1) {
      try {
        const cycleId = `${hammerPrefix}-${index}`;
        const journal = new CycleJournal(cycleId);
        const tx = store.begin(cycleId, { expectedVersion: 0, expectedJournalHead: null });
        tx.stageEvent(journal.append('fixture-event', { index }));
        await store.commit(tx);
      } catch (error) {
        const message = error?.message ?? String(error);
        if (message === 'durable cycle store lock contention' || /active cycle count limit exceeded/.test(message)) {
          contentions += 1;
          continue;
        }
        anomalies.push(message);
      }
    }
    announce('result', { outcome: 'done', contentions, anomalies });
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
