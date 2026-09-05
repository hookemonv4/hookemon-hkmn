import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFileLeaseStore } from '../../src/app/lease-store.mjs';
import { acquireLease, releaseLease, renewLease, assertLeaseCurrent } from '../../../runner/src/automation/exclusive-lease.mjs';

async function tempLeasePath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-lease-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'lease.json');
}

test('a fresh lease store starts empty at version 0', async t => {
  const store = createFileLeaseStore(await tempLeasePath(t));
  assert.deepEqual(store.readLease(), { version: 0, lease: null });
});

test('compareAndSwapLease rejects a stale expected version and accepts the current one', async t => {
  const store = createFileLeaseStore(await tempLeasePath(t));
  assert.equal(store.compareAndSwapLease(5, { owner: 'x' }), false);
  assert.equal(store.compareAndSwapLease(0, { owner: 'x' }), true);
  assert.deepEqual(store.readLease(), { version: 1, lease: { owner: 'x' } });
  assert.equal(store.compareAndSwapLease(0, { owner: 'y' }), false, 'the version already moved');
});

test('the lease record survives across separate store instances pointed at the same path', async t => {
  const path = await tempLeasePath(t);
  const first = createFileLeaseStore(path);
  first.compareAndSwapLease(0, { owner: 'writer-one' });
  const second = createFileLeaseStore(path);
  assert.deepEqual(second.readLease(), { version: 1, lease: { owner: 'writer-one' } });
});

test('exclusive-lease.mjs composes with the file-backed store: acquire/renew/release round-trips', async t => {
  const store = createFileLeaseStore(await tempLeasePath(t));
  let now = 1_000;
  const lease = acquireLease({ store, owner: 'worker-one', now, ttlMs: 5_000 });
  assertLeaseCurrent({ store, lease, now });
  now += 2_000;
  const renewed = renewLease({ store, lease, now, ttlMs: 5_000 });
  assertLeaseCurrent({ store, lease: renewed, now });
  releaseLease({ store, lease: renewed });
  assert.deepEqual(store.readLease(), { version: 3, lease: null });
});

test('two runners pointed at the same lease-store directory: the second acquire is rejected while the first lease is held', async t => {
  const path = await tempLeasePath(t);
  const runnerOneStore = createFileLeaseStore(path);
  const runnerTwoStore = createFileLeaseStore(path);
  const now = 1_000;
  acquireLease({ store: runnerOneStore, owner: 'runner-one', now, ttlMs: 60_000 });
  assert.throws(
    () => acquireLease({ store: runnerTwoStore, owner: 'runner-two', now, ttlMs: 60_000 }),
    /active cycle lease is already held/,
  );
});

test('two runners pointed at the same lease-store directory: after expiry, a new runner may acquire it', async t => {
  const path = await tempLeasePath(t);
  const runnerOneStore = createFileLeaseStore(path);
  const runnerTwoStore = createFileLeaseStore(path);
  acquireLease({ store: runnerOneStore, owner: 'runner-one', now: 1_000, ttlMs: 5_000 });
  const lease = acquireLease({ store: runnerTwoStore, owner: 'runner-two', now: 10_000, ttlMs: 5_000 });
  assert.equal(lease.owner, 'runner-two');
});
