// On-disk lease store backing packages/runner/src/automation/exclusive-lease.mjs's `leaseStore`
// seam ({ readLease(), compareAndSwapLease(expectedVersion, nextLease) }, both SYNCHRONOUS — see
// exclusive-lease.mjs's own MemoryLeaseStore-shaped test fixtures). The lease itself is the only
// thing standing between two `hookemon-runner` processes pointed at the same state directory both
// driving a cycle at once, so this store has exactly one job: make "read the current version, then
// write only if nobody else moved it first" atomic enough that a second process can never observe a
// successful compareAndSwapLease for a version somebody else just consumed.
//
// Mechanism: the lease record itself is a single small JSON file, written with the same
// temp-file-then-rename pattern every other durable file in this repository uses (see
// packages/runner/src/cycle/durable-store.mjs, packages/runner/src/operator/state-file.mjs) so a
// reader never observes a partially-written file. `compareAndSwapLease` additionally wraps its
// read-verify-write critical section in a short-lived, `O_EXCL`-created lock file (the same
// exclusive-create-as-mutex trick durable-store.mjs's acquireLock/releaseLock use, done here
// synchronously since the leaseStore seam is synchronous by contract) so two processes racing to
// write the *same* expected version can never both succeed — one observes the lock already held and
// retries until the other has released it, at which point its own read is fresh and one of the two
// correctly fails the version comparison. This is what "single-process safe" in the work package
// step list means in practice: safe under real concurrent processes for this store's own critical
// section, not just safe against interleaved calls inside one process.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';

const SCHEMA = 'hookemon.adapters.lease-store.v1';
const EMPTY = Object.freeze({ schema: SCHEMA, version: 0, lease: null });

// Bounded spin-retry for the advisory lock: the critical section it guards is a few synchronous
// filesystem calls (microseconds), so a short, tight retry loop resolves real contention almost
// immediately without needing an async sleep this synchronous API cannot offer.
const LOCK_MAX_ATTEMPTS = 20_000;

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function readRecord(path) {
  let text;
  try {
    text = readFileSync(path, { encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'ENOENT') return EMPTY;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('lease store file contains corrupt JSON');
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.schema !== SCHEMA
    || !Number.isSafeInteger(parsed.version)
    || parsed.version < 0
    || (parsed.lease !== null && (typeof parsed.lease !== 'object' || Array.isArray(parsed.lease)))
  ) {
    throw new Error('lease store file schema is invalid');
  }
  return parsed;
}

function writeRecordAtomic(path, record) {
  const directory = dirname(path);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const bytes = `${JSON.stringify(record)}\n`;
  writeFileSync(temporaryPath, bytes, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // best-effort cleanup only; the rename error is what matters.
    }
    throw error;
  }
}

function withLock(lockPath, work) {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      continue; // somebody else holds the lock right now; spin and try again.
    }
    try {
      closeSync(fd);
      return work();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('lease store lock contention: exceeded the maximum retry attempts');
}

/**
 * Builds the synchronous `leaseStore` exclusive-lease.mjs requires: `readLease()` -> `{version,
 * lease}` and `compareAndSwapLease(expectedVersion, nextLease)` -> boolean. `path` is the absolute
 * path to the lease record file (a sibling `.lock` file is used only transiently, for the CAS
 * critical section, and never left behind between calls).
 */
export function createFileLeaseStore(path) {
  assertAbsolutePath(path, 'lease store path');
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });

  return Object.freeze({
    readLease() {
      const record = readRecord(path);
      return { version: record.version, lease: record.lease };
    },
    compareAndSwapLease(expectedVersion, nextLease) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error('lease store expectedVersion is invalid');
      }
      if (nextLease !== null && (typeof nextLease !== 'object' || Array.isArray(nextLease))) {
        throw new Error('lease store nextLease is invalid');
      }
      return withLock(lockPath, () => {
        const current = readRecord(path);
        if (current.version !== expectedVersion) return false;
        writeRecordAtomic(path, { schema: SCHEMA, version: expectedVersion + 1, lease: nextLease });
        return true;
      });
    },
  });
}
