import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import * as durableStore from '../../src/cycle/durable-store.mjs';
import { CycleJournal, RECOVERY_LIMITS, canonicalJson } from '../../src/cycle/journal.mjs';

const { DurableCycleStore, StateDirectoryLossError, readStateDirectoryRecovery } = durableStore;
const lockRaceChildPath = fileURLToPath(new URL('./durable-store-lock-race-child.mjs', import.meta.url));

function lockRaceChild({ directory, role }) {
  const stderr = [];
  const child = spawn(process.execPath, [lockRaceChildPath], {
    env: {
      ...process.env,
      DURABLE_LOCK_RACE_DIRECTORY: directory,
      DURABLE_LOCK_RACE_ROLE: role,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr.on('data', chunk => stderr.push(chunk));

  return {
    child,
    waitFor(stage) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`durable lock race child did not report ${stage}: ${Buffer.concat(stderr).toString('utf8')}`));
        }, 10_000);
        const onMessage = message => {
          if (message?.stage !== stage) return;
          cleanup();
          resolve(message);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(`durable lock race child exited before ${stage} (code ${code}, signal ${signal}): ${Buffer.concat(stderr).toString('utf8')}`));
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.off('message', onMessage);
          child.off('exit', onExit);
        };
        child.on('message', onMessage);
        child.once('exit', onExit);
      });
    },
    resume() {
      child.send('resume');
    },
    stop(signal = 'SIGTERM') {
      if (child.exitCode === null && !child.killed) child.kill(signal);
    },
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-durable-cycle-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function exitedProcessPid() {
  const child = spawn(process.execPath, ['--eval', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

async function commitFixtureEvent(store, cycleId, journal, payload = {}) {
  const expectedVersion = journal.entries.length;
  const expectedJournalHead = journal.head;
  const tx = store.begin(cycleId, { expectedVersion, expectedJournalHead });
  const entry = journal.append('fixture-event', payload);
  tx.stageEvent(entry);
  await store.commit(tx);
  return entry;
}

async function createAndCloseCycle(store, cycleId, eventCount = 2) {
  const journal = new CycleJournal(cycleId);
  for (let index = 0; index < eventCount; index += 1) {
    await commitFixtureEvent(store, cycleId, journal, { step: index });
  }
  return journal;
}

function authorizationRecord(overrides = {}) {
  return {
    key: 'sha256:' + '1'.repeat(64),
    nonceKey: 'sha256:' + '2'.repeat(64),
    cycleId: 'cycle-nonce-a',
    actionKind: 'outbound',
    authorizationKind: 'mutation',
    actionDigest: 'sha256:' + '3'.repeat(64),
    subjectDigest: 'sha256:' + '3'.repeat(64),
    commitment: 'sha256:' + '4'.repeat(64),
    validatedAt: '2029-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('creates and completes cycles well beyond the old 16-cycle ceiling without a store-cycle-count-limit error', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  for (let index = 1; index <= 40; index += 1) {
    const cycleId = `cycle-${String(index).padStart(3, '0')}`;
    await createAndCloseCycle(store, cycleId, 2);
    await store.archiveCycle(cycleId);
  }
  assert.deepEqual(store.activeCycleIds, []);
  assert.equal(store.archivedCycleIds.length, 40);
  // Specifically cover cycles #17 through #40, the ones the old 16-cycle
  // ceiling would have refused outright.
  for (let index = 17; index <= 40; index += 1) {
    const cycleId = `cycle-${String(index).padStart(3, '0')}`;
    const { cycle } = await store.readArchivedCycle(cycleId);
    assert.equal(cycle.version, 2);
  }
});

test('still bounds concurrently active cycles at RECOVERY_LIMITS.storeCycles when none are archived', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  for (let index = 1; index <= RECOVERY_LIMITS.storeCycles; index += 1) {
    await createAndCloseCycle(store, `cycle-active-${index}`, 1);
  }
  assert.equal(store.activeCycleIds.length, RECOVERY_LIMITS.storeCycles);
  await assert.rejects(
    createAndCloseCycle(store, 'cycle-active-overflow', 1),
    /active cycle count limit exceeded/,
  );

  // Archiving one active cycle frees exactly one slot.
  await store.archiveCycle('cycle-active-1');
  await createAndCloseCycle(store, 'cycle-active-overflow', 1);
  assert.equal(store.activeCycleIds.length, RECOVERY_LIMITS.storeCycles);
});

test('archives terminal cycles out of the hot set and never reloads their journals during recovery', async t => {
  const directory = await temporaryDirectory(t);
  let store = await DurableCycleStore.open(directory);
  await createAndCloseCycle(store, 'cycle-archived-a', 2);
  await store.archiveCycle('cycle-archived-a');
  await createAndCloseCycle(store, 'cycle-active-b', 1);

  assert.deepEqual(store.activeCycleIds, ['cycle-active-b']);
  assert.deepEqual(store.archivedCycleIds, ['cycle-archived-a']);
  assert.throws(() => store.readCycle('cycle-archived-a'), /archived/);
  assert.equal(store.readCycle('cycle-active-b').version, 1);

  // Corrupt the archive file directly. If archived cycles were re-parsed
  // during recovery this would make the next open() fail; instead recovery
  // only scans active/, so it must succeed untouched.
  const archivePath = join(directory, 'archive', `${encodeURIComponent('cycle-archived-a')}.json`);
  await writeFile(archivePath, 'not json', { mode: 0o600 });

  store = await DurableCycleStore.open(directory);
  assert.deepEqual(store.activeCycleIds, ['cycle-active-b']);
  assert.deepEqual(store.archivedCycleIds, ['cycle-archived-a']);
  assert.equal(store.readCycle('cycle-active-b').version, 1);
  await assert.rejects(store.readArchivedCycle('cycle-archived-a'), /corrupt JSON/);
});

test('recovers the active cycle from disk after a restart, with more than 20 prior cycles already archived', async t => {
  const directory = await temporaryDirectory(t);
  let store = await DurableCycleStore.open(directory);
  for (let index = 1; index <= 22; index += 1) {
    const cycleId = `cycle-history-${index}`;
    await createAndCloseCycle(store, cycleId, 1);
    await store.archiveCycle(cycleId);
  }

  const journal = new CycleJournal('cycle-mid-flight');
  await commitFixtureEvent(store, 'cycle-mid-flight', journal, { step: 'outbound' });
  await commitFixtureEvent(store, 'cycle-mid-flight', journal, { step: 'purchase' });

  // Simulate a crash: the in-memory store instance is simply abandoned, and
  // a brand-new instance is opened against the same directory, with no
  // shared in-memory state whatsoever.
  store = await DurableCycleStore.open(directory);

  assert.deepEqual(store.activeCycleIds, ['cycle-mid-flight']);
  assert.equal(store.archivedCycleIds.length, 22);
  const recovered = store.readCycle('cycle-mid-flight');
  assert.equal(recovered.version, 2);
  assert.equal(recovered.journalHead, journal.head);
  assert.deepEqual(recovered.entries.map(entry => entry.payload), [{ step: 'outbound' }, { step: 'purchase' }]);

  // Continue the cycle purely from the disk-recovered journal, proving the
  // resumed state did not depend on the abandoned in-memory journal.
  const resumedJournal = new CycleJournal('cycle-mid-flight', recovered.entries);
  await commitFixtureEvent(store, 'cycle-mid-flight', resumedJournal, { step: 'return' });
  await store.archiveCycle('cycle-mid-flight');
  assert.deepEqual(store.activeCycleIds, []);
  assert.equal(store.archivedCycleIds.length, 23);
  const { cycle: closed } = await store.readArchivedCycle('cycle-mid-flight');
  assert.equal(closed.version, 3);
});

test('recovers an SQLite lease left by a crashed process', async t => {
  const directory = await temporaryDirectory(t);
  await DurableCycleStore.open(directory);
  const holder = lockRaceChild({ directory, role: 'sqlite-holder' });
  t.after(() => holder.stop());
  await holder.waitFor('sqlite-lease-held');
  const exited = once(holder.child, 'exit');
  holder.stop('SIGKILL');
  await exited;

  const store = await DurableCycleStore.open(directory);
  await createAndCloseCycle(store, 'cycle-after-stale-lock', 1);
  assert.deepEqual(store.activeCycleIds, ['cycle-after-stale-lock']);
});

test('a post-stat/pre-delete legacy contender cannot delete a replacement SQLite lease', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'store.lock');
  const deadPid = await exitedProcessPid();
  await DurableCycleStore.open(directory);
  await writeFile(lockPath, `${canonicalJson({ pid: deadPid, token: 'stale-token' })}\n`, { mode: 0o600 });

  const staleRemover = lockRaceChild({ directory, role: 'post-stat-unlinker' });
  t.after(() => staleRemover.stop());
  await staleRemover.waitFor('post-stat');

  const successor = lockRaceChild({ directory, role: 'sqlite-holder' });
  t.after(() => successor.stop());
  await successor.waitFor('sqlite-lease-held');

  try {
    await assert.rejects(DurableCycleStore.open(directory), /durable cycle store lock contention/);

    const staleResult = staleRemover.waitFor('result');
    staleRemover.resume();
    assert.equal((await staleResult).outcome, 'unlinked');

    await assert.rejects(DurableCycleStore.open(directory), /durable cycle store lock contention/);
  } finally {
    const successorResult = successor.waitFor('result');
    successor.resume();
    assert.equal((await successorResult).outcome, 'released');
  }

  await DurableCycleStore.open(directory);
});

test('takes over a token-bound legacy fence after its child process crashes', async t => {
  const directory = await temporaryDirectory(t);
  await DurableCycleStore.open(directory);
  const holder = lockRaceChild({ directory, role: 'legacy-fence-holder' });
  t.after(() => holder.stop());
  await holder.waitFor('legacy-fence-held');
  const exited = once(holder.child, 'exit');
  holder.stop('SIGKILL');
  await exited;

  const recovered = await DurableCycleStore.open(directory);
  await createAndCloseCycle(recovered, 'cycle-after-stale-legacy-fence', 1);
  assert.deepEqual(recovered.activeCycleIds, ['cycle-after-stale-legacy-fence']);
});

test('does not reap a child-crashed legacy fence until the SQLite lease is available', async t => {
  const directory = await temporaryDirectory(t);
  const lockPath = join(directory, 'store.lock');
  await DurableCycleStore.open(directory);
  const legacyHolder = lockRaceChild({ directory, role: 'legacy-fence-holder' });
  t.after(() => legacyHolder.stop());
  await legacyHolder.waitFor('legacy-fence-held');
  const legacyExited = once(legacyHolder.child, 'exit');
  legacyHolder.stop('SIGKILL');
  await legacyExited;
  const staleFence = await stat(lockPath);

  const sqliteHolder = lockRaceChild({ directory, role: 'sqlite-holder' });
  t.after(() => sqliteHolder.stop());
  await sqliteHolder.waitFor('sqlite-lease-held');
  try {
    await assert.rejects(DurableCycleStore.open(directory), /durable cycle store lock contention/);
    const retainedFence = await stat(lockPath);
    assert.equal(retainedFence.dev, staleFence.dev);
    assert.equal(retainedFence.ino, staleFence.ino);
  } finally {
    const result = sqliteHolder.waitFor('result');
    sqliteHolder.resume();
    assert.equal((await result).outcome, 'released');
  }

  const recovered = await DurableCycleStore.open(directory);
  await createAndCloseCycle(recovered, 'cycle-after-serialized-stale-takeover', 1);
  assert.deepEqual(recovered.activeCycleIds, ['cycle-after-serialized-stale-takeover']);
});

test('refuses to reopen a lock still held by a live process', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, 'store.lock'), `${canonicalJson({ pid: process.pid, token: 'live-token' })}\n`, { mode: 0o600 });
  await assert.rejects(DurableCycleStore.open(directory), /lock contention/);
});

test('makes commitSync contend on the same SQLite lease used by async operations', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  const holder = lockRaceChild({ directory, role: 'sqlite-holder' });
  t.after(() => holder.stop());
  await holder.waitFor('sqlite-lease-held');

  const journal = new CycleJournal('cycle-sync-lease-contention');
  const transaction = store.begin('cycle-sync-lease-contention', { expectedVersion: 0, expectedJournalHead: null });
  transaction.stageEvent(journal.append('fixture-event', { step: 'contended' }));
  assert.throws(() => store.commitSync(transaction), /durable cycle store lock contention/);

  const holderResult = holder.waitFor('result');
  holder.resume();
  assert.equal((await holderResult).outcome, 'released');
  store.commitSync(transaction);
  assert.equal(store.readCycle('cycle-sync-lease-contention').version, 1);
});

test('never lets a nonce consumed by an archived cycle be replayed by a later cycle', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);

  const journalA = new CycleJournal('cycle-nonce-a');
  const txA = store.begin('cycle-nonce-a', { expectedVersion: 0, expectedJournalHead: null });
  txA.stageEvent(journalA.append('fixture-event', { step: 0 }));
  txA.consumeAuthorization(authorizationRecord());
  await store.commit(txA);
  await store.archiveCycle('cycle-nonce-a');

  const journalB = new CycleJournal('cycle-nonce-b');
  const txB = store.begin('cycle-nonce-b', { expectedVersion: 0, expectedJournalHead: null });
  txB.stageEvent(journalB.append('fixture-event', { step: 0 }));
  assert.throws(
    () => txB.consumeAuthorization(authorizationRecord({
      cycleId: 'cycle-nonce-b',
      key: 'sha256:' + '9'.repeat(64),
      actionDigest: 'sha256:' + 'a'.repeat(64),
      commitment: 'sha256:' + 'b'.repeat(64),
    })),
    /authorization nonce already consumed/,
  );
});

test('lets identical evidence be re-consumed idempotently within the cycle that owns it', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);

  const journal = new CycleJournal('cycle-idempotent');
  const tx1 = store.begin('cycle-idempotent', { expectedVersion: 0, expectedJournalHead: null });
  tx1.stageEvent(journal.append('fixture-event', { step: 0 }));
  tx1.consumeAuthorization(authorizationRecord({ cycleId: 'cycle-idempotent' }));
  await store.commit(tx1);

  const tx2 = store.begin('cycle-idempotent', { expectedVersion: journal.entries.length, expectedJournalHead: journal.head });
  tx2.stageEvent(journal.append('fixture-event', { step: 1 }));
  assert.doesNotThrow(() => tx2.consumeAuthorization(authorizationRecord({ cycleId: 'cycle-idempotent' })));
  await store.commit(tx2);
  assert.equal(store.readCycle('cycle-idempotent').version, 2);
});

test('rejects beginning a new transaction for a cycle identifier that was already archived', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  await createAndCloseCycle(store, 'cycle-once', 1);
  await store.archiveCycle('cycle-once');
  assert.throws(
    () => store.begin('cycle-once', { expectedVersion: 0, expectedJournalHead: null }),
    /already archived/,
  );
});

test('rejects archiving a cycle that has no committed journal, and archiving twice', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  await assert.rejects(store.archiveCycle('cycle-never-started'), /not active/);

  await createAndCloseCycle(store, 'cycle-once-more', 1);
  await store.archiveCycle('cycle-once-more');
  await assert.rejects(store.archiveCycle('cycle-once-more'), /already archived/);
});

test('leaves FixtureCycleStore bounded behavior unchanged for direct fixture use', () => {
  const cycles = [];
  for (let index = 1; index <= RECOVERY_LIMITS.storeCycles + 1; index += 1) {
    cycles.push({ cycleId: `cycle-bound-${index}`, version: 0, journalHead: null, entries: [] });
  }
  assert.throws(
    () => new FixtureCycleStore({ schema: 'hookemon.fixture-cycle-store.v1', cycles, authorizations: [], receipts: [] }),
    /cycle count limit exceeded/,
  );

  const store = new FixtureCycleStore();
  assert.deepEqual(store.snapshot, { schema: 'hookemon.fixture-cycle-store.v1', cycles: [], authorizations: [], receipts: [] });
});

test('rejects a non-absolute directory and a direct constructor call', async () => {
  await assert.rejects(DurableCycleStore.open('relative/path'), /absolute path/);
  assert.throws(() => new DurableCycleStore({}, '/tmp/whatever'), /DurableCycleStore\.open/);
});

test('surfaces stale evidence conflicts as errors rather than silently overwriting them', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  const journal = new CycleJournal('cycle-conflict');
  const tx = store.begin('cycle-conflict', { expectedVersion: 0, expectedJournalHead: null });
  tx.stageEvent(journal.append('fixture-event', { step: 0 }));
  tx.consumeAuthorization(authorizationRecord({ cycleId: 'cycle-conflict' }));
  await store.commit(tx);

  const journal2 = new CycleJournal('cycle-conflict-2');
  const tx2 = store.begin('cycle-conflict-2', { expectedVersion: 0, expectedJournalHead: null });
  tx2.stageEvent(journal2.append('fixture-event', { step: 0 }));
  assert.throws(
    () => tx2.consumeAuthorization(authorizationRecord({
      cycleId: 'cycle-conflict-2',
      commitment: 'sha256:' + 'f'.repeat(64),
    })),
    /already consumed by different evidence/,
  );
});

test('creates the store directory tree on first open', async t => {
  const parent = await temporaryDirectory(t);
  const directory = join(parent, 'nested', 'store');
  const store = await DurableCycleStore.open(directory);
  assert.deepEqual(store.activeCycleIds, []);
  await mkdir(join(directory, 'active'), { recursive: true });
});

test('records a nonsecret sibling identity when a cycle store first bootstraps', async t => {
  const parent = await temporaryDirectory(t);
  const directory = join(parent, 'nested', 'cycles');

  await DurableCycleStore.open(directory);

  assert.equal(typeof readStateDirectoryRecovery, 'function');
  const recovery = await readStateDirectoryRecovery(directory);
  assert.equal(recovery.detected, false);
  assert.equal(recovery.identityPath, join(parent, 'nested', 'cycles.identity.json'));
  assert.deepEqual(Object.keys(recovery.identity).sort(), ['createdAt', 'schema', 'storeId']);
  assert.match(recovery.identity.storeId, /^[0-9a-f-]{36}$/);
});

test('fails closed when the private SQLite lock directory contains an unexpected sidecar', async t => {
  const directory = await temporaryDirectory(t);
  await DurableCycleStore.open(directory);
  await writeFile(join(directory, '.store-lock', 'lease.sqlite-wal'), 'unexpected', { mode: 0o600 });

  await assert.rejects(
    DurableCycleStore.open(directory),
    error => error instanceof StateDirectoryLossError
      && error.code === 'STATE_DIRECTORY_LOSS'
      && error.recovery.reason === 'unavailable',
  );
});

test('refuses to recreate an established cycle state directory after it is lost', async t => {
  const parent = await temporaryDirectory(t);
  const directory = join(parent, 'cycles');
  await DurableCycleStore.open(directory);
  await rm(directory, { recursive: true, force: true });

  assert.equal(typeof StateDirectoryLossError, 'function');
  const recovery = await readStateDirectoryRecovery(directory);
  assert.equal(recovery.detected, true);
  assert.equal(recovery.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(recovery.nextAction, 'owner-decision');
  assert.equal(recovery.stateDirectory, directory);

  await assert.rejects(
    DurableCycleStore.open(directory),
    error => error instanceof StateDirectoryLossError
      && error.code === 'STATE_DIRECTORY_LOSS'
      && error.recovery.identity.storeId === recovery.identity.storeId,
  );
  assert.equal((await readdir(parent)).includes('cycles'), false);
});

test('detects an empty replacement state directory after an established store is deleted', async t => {
  const parent = await temporaryDirectory(t);
  const directory = join(parent, 'cycles');
  await DurableCycleStore.open(directory);
  await rm(directory, { recursive: true, force: true });
  for (const child of ['active', 'archive', 'payout']) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }

  const recovery = await readStateDirectoryRecovery(directory);
  assert.equal(recovery.detected, true);
  assert.equal(recovery.reason, 'identity-marker-missing');
  await assert.rejects(
    DurableCycleStore.open(directory),
    error => error instanceof StateDirectoryLossError
      && error.code === 'STATE_DIRECTORY_LOSS'
      && error.recovery.reason === 'identity-marker-missing',
  );
});

test('rejects a replacement state directory even when its original identity marker is copied', async t => {
  const parent = await temporaryDirectory(t);
  const directory = join(parent, 'cycles');
  await DurableCycleStore.open(directory);
  const marker = await readFile(join(directory, '.store-identity.json'), 'utf8');
  await rm(directory, { recursive: true, force: true });
  for (const child of ['active', 'archive', 'payout']) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }
  await writeFile(join(directory, '.store-identity.json'), marker, { mode: 0o600 });

  const recovery = await readStateDirectoryRecovery(directory);
  assert.equal(recovery.detected, true);
  assert.equal(recovery.reason, 'identity-directory-mismatch');
  await assert.rejects(
    DurableCycleStore.open(directory),
    error => error instanceof StateDirectoryLossError
      && error.code === 'STATE_DIRECTORY_LOSS'
      && error.recovery.reason === 'identity-directory-mismatch',
  );
});

test('refuses to mint a replacement identity over a nonempty existing cycle store', async t => {
  const parent = await temporaryDirectory(t);
  const directory = join(parent, 'cycles');
  const store = await DurableCycleStore.open(directory);
  await createAndCloseCycle(store, 'cycle-with-evidence', 1);
  const identityPath = join(parent, 'cycles.identity.json');
  await unlink(identityPath);

  const recovery = await readStateDirectoryRecovery(directory);
  assert.equal(recovery.detected, true);
  assert.equal(recovery.reason, 'missing-identity');
  assert.equal(recovery.identity, null);
  await assert.rejects(
    DurableCycleStore.open(directory),
    error => error instanceof StateDirectoryLossError && error.recovery.reason === 'missing-identity',
  );
  assert.equal((await readdir(parent)).includes('cycles.identity.json'), false);
});

// WP-31: CycleRunner's own public API is fully synchronous, so a disk-backed production store must be
// committable synchronously too — commitSync is the Node-sync-fs twin of commit() above, with identical
// durability guarantees (see durable-store.mjs's atomicWriteFileSync). This proves it produces the exact
// same persisted, reloadable state as the async path: a cycle written via commitSync survives a fresh
// DurableCycleStore.open() of the same directory, byte-identically to one written via commit().
test('commitSync persists a cycle exactly like the async commit(), reloadable after a fresh open', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  const journal = new CycleJournal('cycle-sync-commit');
  for (let index = 0; index < 3; index += 1) {
    const expectedVersion = journal.entries.length;
    const expectedJournalHead = journal.head;
    const tx = store.begin('cycle-sync-commit', { expectedVersion, expectedJournalHead });
    const entry = journal.append('fixture-event', { step: index });
    tx.stageEvent(entry);
    if (index === 1) tx.consumeAuthorization(authorizationRecord({ cycleId: 'cycle-sync-commit' }));
    store.commitSync(tx);
  }
  assert.deepEqual(store.activeCycleIds, ['cycle-sync-commit']);
  assert.equal(store.readCycle('cycle-sync-commit').version, 3);

  const reopened = await DurableCycleStore.open(directory);
  assert.deepEqual(reopened.activeCycleIds, ['cycle-sync-commit']);
  assert.deepEqual(reopened.readCycle('cycle-sync-commit'), store.readCycle('cycle-sync-commit'));
  assert.ok(reopened.authorizationRecord(authorizationRecord({ cycleId: 'cycle-sync-commit' }).key));
});

// The evidence-profile.mjs interface check CycleRunner's constructor performs (see cycle-runner.mjs's
// #evidenceProfile.cycleStore.accepts) — a real conformance test, not merely an instanceof check,
// proving DurableCycleStore exposes the exact synchronous {readCycle, begin, commitSync} shape a
// production CycleRunner needs.
test('DurableCycleStore conforms to the synchronous cycle store interface CycleRunner requires', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  assert.equal(typeof store.readCycle, 'function');
  assert.equal(typeof store.begin, 'function');
  assert.equal(typeof store.commitSync, 'function');
  const stored = store.readCycle('cycle-conformance');
  assert.deepEqual(stored, { cycleId: 'cycle-conformance', version: 0, journalHead: null, entries: [] });
  const tx = store.begin('cycle-conformance', { expectedVersion: 0, expectedJournalHead: null });
  const journal = new CycleJournal('cycle-conformance');
  tx.stageEvent(journal.append('fixture-event', {}));
  store.commitSync(tx);
  assert.equal(store.readCycle('cycle-conformance').version, 1);
});

test('round-trips a 1,025-recipient payout state through recipient-keyed pages after restart', async t => {
  const directory = await temporaryDirectory(t);
  const cycleId = 'cycle-paged-payout';
  const stage = 'payout';
  const recipients = Array.from({ length: 1025 }, (_, index) => ({
    recipient: `recipient-${String(index).padStart(4, '0')}`,
    amountAtomic: String(index + 1),
    state: 'PREPARED',
  }));
  const state = {
    schema: 'hookemon.direct-payout-state.v1',
    cycleId,
    plan: {
      allocations: recipients.map(({ recipient, amountAtomic }) => ({ recipient, amountAtomic })),
    },
    recipients,
  };

  const store = await DurableCycleStore.open(directory);
  await store.persistPagedPayoutState(cycleId, stage, state);

  const manifestDirectory = join(directory, 'payout', encodeURIComponent(cycleId), stage);
  const manifest = await stat(join(manifestDirectory, 'manifest.json'));
  assert.equal(manifest.mode & 0o777, 0o600);
  const generations = (await readdir(manifestDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  assert.equal(generations.length, 1);
  for (const entry of await readdir(join(manifestDirectory, generations[0].name), { withFileTypes: true })) {
    if (entry.isFile()) assert.equal((await stat(join(manifestDirectory, generations[0].name, entry.name))).mode & 0o777, 0o600);
  }

  const reopened = await DurableCycleStore.open(directory);
  assert.deepEqual(await reopened.readPagedPayoutState(cycleId, stage), state);
});

test('refuses an invalid payout stage identifier before writing a snapshot', async t => {
  const directory = await temporaryDirectory(t);
  const store = await DurableCycleStore.open(directory);
  await assert.rejects(
    store.persistPagedPayoutState('cycle-invalid-stage', 'Payout', {
      schema: 'hookemon.direct-payout-state.v1',
      cycleId: 'cycle-invalid-stage',
      recipients: [],
    }),
    /stage identifier is invalid/,
  );
});

test('serializes a global reservation across separately opened durable stores', async t => {
  const directory = await temporaryDirectory(t);
  const first = await DurableCycleStore.open(directory);
  const second = await DurableCycleStore.open(directory);
  const key = 'wallet-nonce:4663:operations:17';
  const owner = { cycleId: 'cycle-global-lock', reservation: '17' };

  assert.deepEqual(await first.reserveGlobalKey(key, owner), owner);
  assert.deepEqual(await second.readGlobalKey(key), owner);
  await assert.rejects(
    second.reserveGlobalKey(key, { cycleId: 'cycle-other-lock', reservation: '17' }),
    /already reserved/,
  );
  assert.deepEqual(await second.reserveGlobalKey(key, owner), owner);
  await assert.rejects(
    first.releaseGlobalKey(key, { cycleId: 'cycle-other-lock', reservation: '17' }),
    /owned by different value/,
  );
  assert.equal(await second.releaseGlobalKey(key, owner), true);
  assert.equal(await first.readGlobalKey(key), null);
});

test('preserves a global reservation when another store commits synchronously', async t => {
  const directory = await temporaryDirectory(t);
  const first = await DurableCycleStore.open(directory);
  const second = await DurableCycleStore.open(directory);
  const key = 'relay-source:4663:transaction-17';
  const owner = { cycleId: 'cycle-global-preserve', requestDigest: 'digest-17' };
  await first.reserveGlobalKey(key, owner);

  const journal = new CycleJournal('cycle-sync-after-reservation');
  const transaction = second.begin('cycle-sync-after-reservation', { expectedVersion: 0, expectedJournalHead: null });
  transaction.stageEvent(journal.append('fixture-event', { step: 'persist' }));
  second.commitSync(transaction);

  assert.deepEqual(await first.readGlobalKey(key), owner);
});

test('opens an index written before global reservations were added', async t => {
  const directory = await temporaryDirectory(t);
  // Establish the store identity before substituting the legacy index fixture.
  // A populated tree without that marker is now treated as state loss rather
  // than a safe bootstrap.
  await DurableCycleStore.open(directory);
  await writeFile(join(directory, 'index.json'), `${canonicalJson({
    schema: 'hookemon.durable-cycle-store.index.v1',
    revision: 0,
    archivedCycleIds: [],
    authorizations: [],
    receipts: [],
  })}\n`, { mode: 0o600 });

  const store = await DurableCycleStore.open(directory);
  assert.equal(await store.readGlobalKey('wallet-nonce:4663:operations:18'), null);
});
