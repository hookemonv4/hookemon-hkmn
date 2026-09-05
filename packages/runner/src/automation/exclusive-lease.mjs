import { randomUUID } from 'node:crypto';

const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const fencingTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class LeaseLostError extends Error {
  constructor(reason, lease) {
    super(`cycle lease lost: ${reason}`);
    this.name = 'LeaseLostError';
    this.code = 'LEASE_LOST';
    this.reason = reason;
    this.lease = Object.freeze({ owner: lease.owner, version: lease.version });
  }
}

function assertStore(store) {
  if (!store || typeof store.readLease !== 'function' || typeof store.compareAndSwapLease !== 'function') {
    throw new Error('lease store must provide readLease and compareAndSwapLease');
  }
}

function assertClock(now, ttlMs) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('lease time is invalid');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('lease ttl is invalid');
  if (!Number.isSafeInteger(now + ttlMs)) throw new Error('lease expiry overflow');
}

function assertOwner(owner) {
  if (typeof owner !== 'string' || !ownerPattern.test(owner)) throw new Error('lease owner is invalid');
}

function assertFencingToken(value) {
  if (typeof value !== 'string' || !fencingTokenPattern.test(value)) throw new Error('cycle lease fencing token is invalid');
  return value;
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('lease store snapshot is invalid');
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) {
    throw new Error('lease store version is invalid');
  }
  if (snapshot.lease !== null && (!snapshot.lease || typeof snapshot.lease !== 'object')) {
    throw new Error('lease store record is invalid');
  }
  return snapshot;
}

function assertLeaseOwnership(current, lease) {
  if (
    current === null
    || current.version !== lease.version
    || current.owner !== lease.owner
    || current.token !== lease.token
    || current.fencingToken !== lease.fencingToken
  ) throw new Error('cycle lease owner token or version mismatch');
}

export function assertLeaseCurrent({ store, lease, now }) {
  assertStore(store);
  if (!lease || !Number.isSafeInteger(lease.version) || typeof lease.owner !== 'string' || typeof lease.token !== 'string') {
    throw new Error('cycle lease is invalid');
  }
  assertFencingToken(lease.fencingToken);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('lease time is invalid');
  const snapshot = assertSnapshot(store.readLease());
  if (
    snapshot.lease === null
    || snapshot.lease.version !== lease.version
    || snapshot.lease.owner !== lease.owner
    || snapshot.lease.token !== lease.token
    || snapshot.lease.fencingToken !== lease.fencingToken
  ) throw new LeaseLostError('ownership', lease);
  if (snapshot.lease.expiresAt <= now) throw new LeaseLostError('expired', lease);
  return true;
}

export function acquireLease({ store, owner, now, ttlMs }) {
  assertStore(store);
  assertOwner(owner);
  assertClock(now, ttlMs);
  const snapshot = assertSnapshot(store.readLease());
  if (snapshot.lease !== null && snapshot.lease.expiresAt > now) {
    throw new Error('active cycle lease is already held');
  }
  const lease = {
    version: snapshot.version + 1,
    owner,
    token: randomUUID(),
    fencingToken: randomUUID(),
    acquiredAt: now,
    expiresAt: now + ttlMs,
  };
  if (!store.compareAndSwapLease(snapshot.version, lease)) {
    throw new Error('concurrent cycle lease acquisition rejected');
  }
  return structuredClone(lease);
}

export function renewLease({ store, lease, now, ttlMs }) {
  assertStore(store);
  assertClock(now, ttlMs);
  const snapshot = assertSnapshot(store.readLease());
  assertLeaseOwnership(snapshot.lease, lease);
  if (snapshot.lease.expiresAt <= now) throw new Error('cycle lease has expired');
  const renewed = {
    ...snapshot.lease,
    version: snapshot.version + 1,
    expiresAt: now + ttlMs,
  };
  if (!store.compareAndSwapLease(snapshot.version, renewed)) {
    throw new Error('concurrent cycle lease renewal rejected');
  }
  return structuredClone(renewed);
}

export function releaseLease({ store, lease }) {
  assertStore(store);
  const snapshot = assertSnapshot(store.readLease());
  assertLeaseOwnership(snapshot.lease, lease);
  if (!store.compareAndSwapLease(snapshot.version, null)) {
    throw new Error('concurrent cycle lease release rejected');
  }
  return true;
}
