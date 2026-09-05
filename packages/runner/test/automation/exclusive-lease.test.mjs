import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as exclusiveLease from '../../src/automation/exclusive-lease.mjs';

const {
  LeaseLostError,
  acquireLease,
  assertLeaseCurrent,
  releaseLease,
  renewLease,
} = exclusiveLease;

class MemoryLeaseStore {
  #lease = null;
  #version = 0;

  readLease() {
    return { version: this.#version, lease: this.#lease === null ? null : structuredClone(this.#lease) };
  }

  compareAndSwapLease(expectedVersion, nextLease) {
    if (expectedVersion !== this.#version) return false;
    this.#version += 1;
    this.#lease = nextLease === null ? null : structuredClone(nextLease);
    return true;
  }
}

test('acquires one durable lease and rejects a concurrent owner', () => {
  const store = new MemoryLeaseStore();
  const lease = acquireLease({ store, owner: 'worker-a', now: 1_000, ttlMs: 500 });
  assert.equal(lease.owner, 'worker-a');
  assert.equal(lease.version, 1);
  assert.equal(lease.acquiredAt, 1_000);
  assert.equal(lease.expiresAt, 1_500);
  assert.match(lease.token, /^[0-9a-f-]{36}$/);
  assert.throws(
    () => acquireLease({ store, owner: 'worker-b', now: 1_001, ttlMs: 500 }),
    /active cycle lease/,
  );
});

test('renews only the current owner token and advances the CAS version', () => {
  const store = new MemoryLeaseStore();
  const lease = acquireLease({ store, owner: 'worker-a', now: 1_000, ttlMs: 500 });
  assert.throws(
    () => renewLease({ store, lease: { ...lease, token: randomUUID() }, now: 1_200, ttlMs: 500 }),
    /owner token/,
  );

  const renewed = renewLease({ store, lease, now: 1_200, ttlMs: 500 });
  assert.equal(renewed.version, 2);
  assert.equal(renewed.acquiredAt, 1_000);
  assert.equal(renewed.expiresAt, 1_700);
});

test('a fencing token survives renewal, changes on replacement, and rejects an expired worker mutation', () => {
  const store = new MemoryLeaseStore();
  const first = acquireLease({ store, owner: 'worker-a', now: 1_000, ttlMs: 100 });
  assert.match(first.fencingToken, /^[0-9a-f-]{36}$/);
  const renewed = renewLease({ store, lease: first, now: 1_050, ttlMs: 100 });
  assert.equal(renewed.fencingToken, first.fencingToken);

  const replacement = acquireLease({ store, owner: 'worker-b', now: 1_151, ttlMs: 100 });
  assert.notEqual(replacement.fencingToken, first.fencingToken);
  assert.equal(typeof LeaseLostError, 'function');
  assert.throws(
    () => assertLeaseCurrent({ store, lease: renewed, now: 1_151 }),
    error => error instanceof LeaseLostError && error.code === 'LEASE_LOST',
  );
});

test('assertLeaseCurrent identifies an expired lease as a typed lease loss', () => {
  const store = new MemoryLeaseStore();
  const lease = acquireLease({ store, owner: 'worker-a', now: 1_000, ttlMs: 100 });

  assert.equal(typeof LeaseLostError, 'function');
  assert.throws(
    () => assertLeaseCurrent({ store, lease, now: 1_100 }),
    error => error instanceof LeaseLostError
      && error.code === 'LEASE_LOST'
      && error.reason === 'expired'
      && error.lease.owner === 'worker-a',
  );
});

test('release is owner-token checked and stale release cannot clear a replacement', () => {
  const store = new MemoryLeaseStore();
  const stale = acquireLease({ store, owner: 'worker-a', now: 1_000, ttlMs: 100 });
  const replacement = acquireLease({ store, owner: 'worker-b', now: 1_101, ttlMs: 100 });

  assert.throws(() => releaseLease({ store, lease: stale }), /owner token|version/);
  assert.equal(store.readLease().lease.token, replacement.token);
  assert.equal(releaseLease({ store, lease: replacement }), true);
  assert.equal(store.readLease().lease, null);
});

test('rejects invalid owner, time, ttl, and non-CAS stores', () => {
  const store = new MemoryLeaseStore();
  assert.throws(() => acquireLease({ store, owner: '', now: 1, ttlMs: 1 }), /owner/);
  assert.throws(() => acquireLease({ store, owner: 'worker', now: -1, ttlMs: 1 }), /time/);
  assert.throws(() => acquireLease({ store, owner: 'worker', now: 1, ttlMs: 0 }), /ttl/);
  assert.throws(() => acquireLease({ store: {}, owner: 'worker', now: 1, ttlMs: 1 }), /store/);
});
