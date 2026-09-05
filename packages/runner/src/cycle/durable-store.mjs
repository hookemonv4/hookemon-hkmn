// Disk-backed cycle store for production use. Closes the FixtureCycleStore
// all-in-memory ceiling (RECOVERY_LIMITS.storeCycles = 16, no persistence, no
// archiving) so a scheduler that opens a new cycle every 20 minutes can run
// indefinitely: the storeCycles ceiling bounds only the *active* (not yet
// archived) working set, not lifetime history, and a process restart
// recovers the active cycle by reading from disk instead of depending on
// in-memory state having survived.
//
// Mechanism: an in-memory FixtureCycleStore ("#hot") is reused unmodified to
// validate and hold only the active cycles' journals, so every existing
// FixtureCycleStore invariant (append-only journal chains, canonical digest
// checks, atomic per-cycle commit) is enforced by construction rather than
// re-implemented. Every committed cycle snapshot is additionally persisted
// to its own file under active/, and once a caller calls archiveCycle() the
// file moves to archive/ and #hot is rebuilt from the remaining active
// cycles only, dropping the archived cycle's journal from memory and from
// the storeCycles ceiling. Anti-replay evidence (authorization keys, nonce
// keys, receipt keys) is tracked in a small, unbounded, always-loaded index
// that survives archiving, so a consumed nonce can never be replayed against
// a later cycle even after its original cycle has been archived.
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  closeSync,
  chmodSync,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  FixtureCycleStore,
  assertAuthorizationRecord,
  assertCycleId,
  assertCycleSnapshot,
  assertReceiptRecord,
} from './cycle-store.mjs';
import { assertBoundedCanonicalValue, canonicalJson, digest, RECOVERY_LIMITS } from './journal.mjs';

const indexSchema = 'hookemon.durable-cycle-store.index.v1';
const activeCycleSchema = 'hookemon.durable-cycle-store.active-cycle.v1';
const archivedCycleSchema = 'hookemon.durable-cycle-store.archived-cycle.v1';
const storeIdentitySchema = 'hookemon.durable-cycle-store.identity.v1';
const stateDirectoryIdentitySchema = 'hookemon.durable-cycle-store.state-directory-identity.v1';
const stateDirectoryRecoverySchema = 'hookemon.state-directory-recovery.v1';
const maximumCycleFileBytes = 8_388_608;
const maximumIndexBytes = 67_108_864;
const maximumStoreIdentityBytes = 4_096;
const maximumLegacyMigrationFenceBytes = 4_096;
const maximumPagedPayoutPageBytes = 8_388_608;
const maximumPagedPayoutStateBytes = 67_108_864;
const pagedPayoutPageItems = RECOVERY_LIMITS.payloadArrayItems;
const maximumPagedPayoutPages = RECOVERY_LIMITS.canonicalArrayItems;
const pagedPayoutManifestSchema = 'hookemon.durable-cycle-store.paged-payout-manifest.v1';
const pagedPayoutPageSchema = 'hookemon.durable-cycle-store.paged-payout-page.v1';
const pagedPayoutReferenceSchema = 'hookemon.durable-cycle-store.paged-payout-reference.v1';
const privateDirectoryMode = 0o700;
const lockDirectoryName = '.store-lock';
const lockDatabaseFileName = 'lease.sqlite';
const lockDatabaseArtifactNames = new Set([
  lockDatabaseFileName,
  `${lockDatabaseFileName}-journal`,
]);
const stageIdentifierPattern = /^[a-z][a-z0-9-]{1,63}$/;
const globalKeyPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const internalPagedSchemas = new Set([pagedPayoutManifestSchema, pagedPayoutPageSchema, pagedPayoutReferenceSchema]);
const forbiddenCanonicalKeys = new Set(['__proto__', 'prototype', 'constructor']);
const openGuard = Symbol('durable-cycle-store-open-guard');
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class StateDirectoryLossError extends Error {
  constructor(recovery) {
    super('durable cycle state directory is unavailable');
    this.name = 'StateDirectoryLossError';
    this.code = 'STATE_DIRECTORY_LOSS';
    this.recovery = recovery;
  }
}

function exactObject(value, fields, label) {
  canonicalJson(value);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
  ) throw new Error(`${label} must use the exact schema`);
  return value;
}

function randomToken() {
  return globalThis.crypto.randomUUID();
}

function assertStoreDirectoryPath(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new Error('durable cycle store directory must be an absolute path');
  }
  return directory;
}

function storeIdentityPath(directory) {
  return join(dirname(directory), `${basename(directory)}.identity.json`);
}

function stateDirectoryIdentityPath(directory) {
  return join(directory, '.store-identity.json');
}

function lockDirectoryPath(directory) {
  return join(directory, lockDirectoryName);
}

function lockDatabasePath(directory) {
  return join(lockDirectoryPath(directory), lockDatabaseFileName);
}

function legacyLockPath(directory) {
  return join(directory, 'store.lock');
}

function assertStoreIdentity(value) {
  exactObject(value, ['schema', 'storeId', 'createdAt'], 'durable cycle store identity');
  if (value.schema !== storeIdentitySchema) throw new Error('durable cycle store identity schema is invalid');
  if (typeof value.storeId !== 'string' || !uuidPattern.test(value.storeId)) throw new Error('durable cycle store identity store id is invalid');
  if (typeof value.createdAt !== 'string' || !isoTimestamp.test(value.createdAt)) throw new Error('durable cycle store identity created-at is invalid');
  return Object.freeze({ ...value });
}

function assertFilesystemIdentifier(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertStateDirectoryIdentity(value) {
  exactObject(value, ['schema', 'storeId', 'directoryDevice', 'directoryInode'], 'durable cycle store state-directory identity');
  if (value.schema !== stateDirectoryIdentitySchema) throw new Error('durable cycle store state-directory identity schema is invalid');
  if (typeof value.storeId !== 'string' || !uuidPattern.test(value.storeId)) throw new Error('durable cycle store state-directory identity store id is invalid');
  assertFilesystemIdentifier(value.directoryDevice, 'durable cycle store state-directory identity device');
  assertFilesystemIdentifier(value.directoryInode, 'durable cycle store state-directory identity inode');
  return Object.freeze({ ...value });
}

function serializeStoreIdentity(value) {
  return `${canonicalJson(assertStoreIdentity(value))}\n`;
}

function serializeStateDirectoryIdentity(value) {
  return `${canonicalJson(assertStateDirectoryIdentity(value))}\n`;
}

async function readStoreIdentity(path) {
  const text = await readStableFile(path, maximumStoreIdentityBytes, 'durable cycle store identity file');
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('durable cycle store identity file contains corrupt JSON');
  }
  if (`${canonicalJson(parsed)}\n` !== text) throw new Error('durable cycle store identity file bytes are not canonical JSON plus one newline');
  return assertStoreIdentity(parsed);
}

async function readStateDirectoryIdentity(path) {
  const text = await readStableFile(path, maximumStoreIdentityBytes, 'durable cycle store state-directory identity file');
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('durable cycle store state-directory identity file contains corrupt JSON');
  }
  if (`${canonicalJson(parsed)}\n` !== text) throw new Error('durable cycle store state-directory identity file bytes are not canonical JSON plus one newline');
  return assertStateDirectoryIdentity(parsed);
}

function stateDirectoryWitness(directoryInfo) {
  if (typeof directoryInfo.dev !== 'bigint' || directoryInfo.dev < 0n) {
    throw new Error('durable cycle store state-directory device is invalid');
  }
  if (typeof directoryInfo.ino !== 'bigint' || directoryInfo.ino < 0n) {
    throw new Error('durable cycle store state-directory inode is invalid');
  }
  return Object.freeze({
    directoryDevice: directoryInfo.dev.toString(),
    directoryInode: directoryInfo.ino.toString(),
  });
}

async function stateDirectoryAvailability(directory, expectedIdentity) {
  try {
    const root = await lstat(directory, { bigint: true });
    if (root.isSymbolicLink() || !root.isDirectory()) return 'unavailable';
    for (const child of ['active', 'archive', 'payout']) {
      const childInfo = await lstat(join(directory, child));
      if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) return 'unavailable';
    }
    const stateIdentity = await readStateDirectoryIdentity(stateDirectoryIdentityPath(directory));
    if (stateIdentity === null) return 'identity-marker-missing';
    if (stateIdentity.storeId !== expectedIdentity.storeId) return 'identity-marker-mismatch';
    if (!await hasOnlyExpectedLockDatabaseArtifacts(lockDirectoryPath(directory))) return 'unavailable';
    const witness = stateDirectoryWitness(root);
    if (stateIdentity.directoryDevice !== witness.directoryDevice || stateIdentity.directoryInode !== witness.directoryInode) {
      return 'identity-directory-mismatch';
    }
    await readdir(directory);
    return 'available';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ENOTDIR') return 'unavailable';
    throw error;
  }
}

async function stateDirectoryBootstrapEligibility(directory) {
  try {
    const root = await lstat(directory);
    if (root.isSymbolicLink() || !root.isDirectory()) return 'unavailable';
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'store.lock' && entry.isFile()) continue;
      if (entry.name === lockDirectoryName && await hasOnlyExpectedLockDatabaseArtifacts(join(directory, entry.name))) continue;
      if (!['active', 'archive', 'payout'].includes(entry.name)
        || entry.isSymbolicLink()
        || !entry.isDirectory()) {
        return 'missing-identity';
      }
      if ((await readdir(join(directory, entry.name))).length > 0) return 'missing-identity';
    }
    return 'bootstrap';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'bootstrap';
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ENOTDIR') return 'unavailable';
    throw error;
  }
}

function recoveryMetadata({ directory, identityPath, identity, availability }) {
  return Object.freeze({
    schema: stateDirectoryRecoverySchema,
    detected: availability !== 'available',
    ...(availability === 'available' ? {} : {
      terminalState: 'HELD_DATA_UNVERIFIED',
      nextAction: 'owner-decision',
      reason: availability,
    }),
    stateDirectory: directory,
    identityPath,
    identity,
  });
}

/**
 * Reads the nonsecret identity that survives beside the cycle data directory.
 * Consumers can turn a detected loss into their own durable owner-decision
 * record without attempting to recreate or write into the missing journal.
 */
export async function readStateDirectoryRecovery(directory) {
  assertStoreDirectoryPath(directory);
  const identityPath = storeIdentityPath(directory);
  const identity = await readStoreIdentity(identityPath);
  if (identity === null) {
    const bootstrapEligibility = await stateDirectoryBootstrapEligibility(directory);
    return recoveryMetadata({
      directory,
      identityPath,
      identity: null,
      availability: bootstrapEligibility === 'bootstrap' ? 'available' : bootstrapEligibility,
    });
  }
  const availability = await stateDirectoryAvailability(directory, identity);
  return recoveryMetadata({ directory, identityPath, identity, availability });
}

async function atomicWriteFile(directory, path, text) {
  const token = randomToken();
  const temporaryPath = join(directory, `.tmp-${token}`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  const directoryHandle = await open(dirname(path), 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function readStableFile(path, maxBytes, label) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!before.isFile()) throw new Error(`${label} must be a regular file`);
  if ((before.mode & 0o777) !== 0o600) throw new Error(`${label} mode must be 0600`);
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed while opening`);
    if ((opened.mode & 0o777) !== 0o600) throw new Error(`${label} mode must be 0600`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds the byte limit`);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

function readStableFileSync(path, maxBytes, label) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!before.isFile()) throw new Error(`${label} must be a regular file`);
  if ((before.mode & 0o777) !== 0o600) throw new Error(`${label} mode must be 0600`);
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed while opening`);
    if ((opened.mode & 0o777) !== 0o600) throw new Error(`${label} mode must be 0600`);
    if (opened.size > maxBytes) throw new Error(`${label} exceeds the byte limit`);
    return readFileSync(fd, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
}

function assertLockDatabaseFile(stat, label) {
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} mode must be 0600`);
}

function assertLegacyMigrationFenceOwner(value) {
  exactObject(value, ['pid', 'token'], 'durable cycle store legacy migration fence');
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error('durable cycle store legacy migration fence PID is invalid');
  }
  if (typeof value.token !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.token)) {
    throw new Error('durable cycle store legacy migration fence token is invalid');
  }
  return Object.freeze({ ...value });
}

function serializeLegacyMigrationFence(owner) {
  return `${canonicalJson(assertLegacyMigrationFenceOwner(owner))}\n`;
}

function parseLegacyMigrationFence(contents) {
  let owner;
  try {
    owner = JSON.parse(contents);
  } catch {
    throw new Error('durable cycle store legacy migration fence is not valid JSON');
  }
  if (serializeLegacyMigrationFence(owner) !== contents) {
    throw new Error('durable cycle store legacy migration fence bytes are not canonical JSON plus one newline');
  }
  return assertLegacyMigrationFenceOwner(owner);
}

function sameLegacyMigrationFence(left, right) {
  return sameFilesystemObject(left, right)
    && left.pid === right.pid
    && left.token === right.token;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function readLegacyMigrationFence(path, expected = null) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('durable cycle store legacy migration fence is missing');
    throw error;
  }
  assertLockDatabaseFile(before, 'durable cycle store legacy migration fence');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    const afterOpen = await lstat(path);
    if (!sameFilesystemObject(before, opened) || !sameFilesystemObject(opened, afterOpen)) {
      throw new Error('durable cycle store legacy migration fence changed while reading');
    }
    const contents = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(contents, 'utf8') > maximumLegacyMigrationFenceBytes) {
      throw new Error('durable cycle store legacy migration fence exceeds the byte limit');
    }
    const afterRead = await lstat(path);
    if (!sameFilesystemObject(opened, afterRead)) {
      throw new Error('durable cycle store legacy migration fence changed while reading');
    }
    const owner = parseLegacyMigrationFence(contents);
    const record = Object.freeze({
      path,
      pid: owner.pid,
      token: owner.token,
      dev: opened.dev,
      ino: opened.ino,
    });
    if (expected !== null && !sameLegacyMigrationFence(expected, record)) {
      throw new Error('durable cycle store legacy migration fence changed while releasing');
    }
    return record;
  } finally {
    await handle.close();
  }
}

function readLegacyMigrationFenceSync(path, expected = null) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('durable cycle store legacy migration fence is missing');
    throw error;
  }
  assertLockDatabaseFile(before, 'durable cycle store legacy migration fence');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    const afterOpen = lstatSync(path);
    if (!sameFilesystemObject(before, opened) || !sameFilesystemObject(opened, afterOpen)) {
      throw new Error('durable cycle store legacy migration fence changed while reading');
    }
    const contents = readFileSync(fd, { encoding: 'utf8' });
    if (Buffer.byteLength(contents, 'utf8') > maximumLegacyMigrationFenceBytes) {
      throw new Error('durable cycle store legacy migration fence exceeds the byte limit');
    }
    const afterRead = lstatSync(path);
    if (!sameFilesystemObject(opened, afterRead)) {
      throw new Error('durable cycle store legacy migration fence changed while reading');
    }
    const owner = parseLegacyMigrationFence(contents);
    const record = Object.freeze({
      path,
      pid: owner.pid,
      token: owner.token,
      dev: opened.dev,
      ino: opened.ino,
    });
    if (expected !== null && !sameLegacyMigrationFence(expected, record)) {
      throw new Error('durable cycle store legacy migration fence changed while releasing');
    }
    return record;
  } finally {
    closeSync(fd);
  }
}

async function takeOverStaleLegacyMigrationFence(path, expected) {
  // The caller holds SQLite's exclusive lease, so another participating writer cannot replace
  // this pathname between the confirmed inode/token record and the unlink below.
  const current = await readLegacyMigrationFence(path);
  if (!sameLegacyMigrationFence(expected, current)) {
    throw new Error('durable cycle store lock contention: legacy migration fence changed during stale takeover');
  }
  if (isProcessAlive(current.pid)) {
    throw new Error('durable cycle store lock contention: legacy migration fence is held by a live process');
  }
  await unlink(path);
  await syncDirectory(dirname(path));
}

function takeOverStaleLegacyMigrationFenceSync(path, expected) {
  // acquireLockSync holds the same SQLite lease before it reaches this confirmation.
  const current = readLegacyMigrationFenceSync(path);
  if (!sameLegacyMigrationFence(expected, current)) {
    throw new Error('durable cycle store lock contention: legacy migration fence changed during stale takeover');
  }
  if (isProcessAlive(current.pid)) {
    throw new Error('durable cycle store lock contention: legacy migration fence is held by a live process');
  }
  unlinkSync(path);
  syncDirectorySync(dirname(path));
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function syncDirectorySync(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function acquireLegacyMigrationFence(path) {
  const owner = { pid: process.pid, token: randomToken() };
  for (;;) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readLegacyMigrationFence(path);
      if (isProcessAlive(existing.pid)) {
        throw new Error('durable cycle store lock contention: legacy migration fence is held by a live process');
      }
      await takeOverStaleLegacyMigrationFence(path, existing);
      continue;
    }
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serializeLegacyMigrationFence(owner), { encoding: 'utf8' });
      await handle.sync();
      const opened = await handle.stat();
      const current = await lstat(path);
      assertLockDatabaseFile(current, 'durable cycle store legacy migration fence');
      if (!sameFilesystemObject(opened, current)) {
        throw new Error('durable cycle store legacy migration fence changed while acquiring');
      }
      await syncDirectory(dirname(path));
      return Object.freeze({ path, pid: owner.pid, token: owner.token, dev: opened.dev, ino: opened.ino });
    } finally {
      await handle.close();
    }
  }
}

function acquireLegacyMigrationFenceSync(path) {
  const owner = { pid: process.pid, token: randomToken() };
  for (;;) {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLegacyMigrationFenceSync(path);
      if (isProcessAlive(existing.pid)) {
        throw new Error('durable cycle store lock contention: legacy migration fence is held by a live process');
      }
      takeOverStaleLegacyMigrationFenceSync(path, existing);
      continue;
    }
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, Buffer.from(serializeLegacyMigrationFence(owner), 'utf8'));
      fsyncSync(fd);
      const opened = fstatSync(fd);
      const current = lstatSync(path);
      assertLockDatabaseFile(current, 'durable cycle store legacy migration fence');
      if (!sameFilesystemObject(opened, current)) {
        throw new Error('durable cycle store legacy migration fence changed while acquiring');
      }
      syncDirectorySync(dirname(path));
      return Object.freeze({ path, pid: owner.pid, token: owner.token, dev: opened.dev, ino: opened.ino });
    } finally {
      closeSync(fd);
    }
  }
}

async function releaseLegacyMigrationFence(fence) {
  await readLegacyMigrationFence(fence.path, fence);
  await unlink(fence.path);
  await syncDirectory(dirname(fence.path));
}

function releaseLegacyMigrationFenceSync(fence) {
  readLegacyMigrationFenceSync(fence.path, fence);
  unlinkSync(fence.path);
  syncDirectorySync(dirname(fence.path));
}

async function ensureLockDatabaseFile(path) {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory, 'durable cycle store SQLite lock directory');
  if (!await hasOnlyExpectedLockDatabaseArtifacts(directory)) {
    throw new Error('durable cycle store SQLite lock directory contains unexpected artifacts');
  }
  let handle = null;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (handle !== null) {
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  assertLockDatabaseFile(await lstat(path), 'durable cycle store SQLite lock database');
  if (!await hasOnlyExpectedLockDatabaseArtifacts(directory)) {
    throw new Error('durable cycle store SQLite lock directory contains unexpected artifacts');
  }
}

function ensureLockDatabaseFileSync(path) {
  const directory = dirname(path);
  ensurePrivateDirectorySync(directory, 'durable cycle store SQLite lock directory');
  if (!hasOnlyExpectedLockDatabaseArtifactsSync(directory)) {
    throw new Error('durable cycle store SQLite lock directory contains unexpected artifacts');
  }
  let fd = null;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (fd !== null) {
    try {
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  assertLockDatabaseFile(lstatSync(path), 'durable cycle store SQLite lock database');
  if (!hasOnlyExpectedLockDatabaseArtifactsSync(directory)) {
    throw new Error('durable cycle store SQLite lock directory contains unexpected artifacts');
  }
}

function isSqliteLockContention(error) {
  return error?.code === 'ERR_SQLITE_ERROR' && (error?.errcode === 5 || error?.errcode === 6);
}

function sameFilesystemObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function acquireSqliteLock(path) {
  let database = null;
  try {
    const expectedDatabase = lstatSync(path);
    assertLockDatabaseFile(expectedDatabase, 'durable cycle store SQLite lock database');
    database = new DatabaseSync(path);
    database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
    const currentDatabase = lstatSync(path);
    assertLockDatabaseFile(currentDatabase, 'durable cycle store SQLite lock database');
    if (!sameFilesystemObject(expectedDatabase, currentDatabase)) {
      throw new Error('durable cycle store SQLite lock database changed while acquiring');
    }
    if (!hasOnlyExpectedLockDatabaseArtifactsSync(dirname(path))) {
      throw new Error('durable cycle store SQLite lock directory contains unexpected artifacts');
    }
    return database;
  } catch (error) {
    try {
      database?.exec('ROLLBACK');
    } catch {
      // The acquisition did not necessarily reach BEGIN EXCLUSIVE.
    }
    try {
      database?.close();
    } catch {
      // Preserve the SQLite acquisition error.
    }
    if (isSqliteLockContention(error)) throw new Error('durable cycle store lock contention');
    throw error;
  }
}

function releaseSqliteLock(database) {
  let failure = null;
  try {
    database.exec('COMMIT');
  } catch (error) {
    failure = error;
    try {
      database.exec('ROLLBACK');
    } catch {
      // Closing the database still releases the kernel lock.
    }
  }
  try {
    database.close();
  } catch (error) {
    if (failure === null) failure = error;
  }
  if (failure !== null) throw failure;
}

async function acquireLock(lockPath, legacyPath) {
  await ensureLockDatabaseFile(lockPath);
  const database = acquireSqliteLock(lockPath);
  try {
    return Object.freeze({
      database,
      legacyFence: await acquireLegacyMigrationFence(legacyPath),
    });
  } catch (error) {
    try {
      releaseSqliteLock(database);
    } catch {
      // Preserve the acquisition error.
    }
    throw error;
  }
}

async function releaseLock(lock) {
  let failure = null;
  try {
    releaseSqliteLock(lock.database);
  } catch (error) {
    failure = error;
  }
  try {
    await releaseLegacyMigrationFence(lock.legacyFence);
  } catch (error) {
    if (failure === null) failure = error;
  }
  if (failure !== null) throw failure;
}

// Synchronous twins of atomicWriteFile/acquireLock/releaseLock above (WP-31), used only
// by commitSync (see the DurableCycleStore class below): CycleRunner's own public API is fully
// synchronous for every existing (fixture) caller, and the only way a disk-backed production store can
// commit durably (fsync'd, atomic rename) without CycleRunner itself becoming async is to perform that
// I/O with Node's synchronous fs primitives instead of node:fs/promises. Every ordering/durability
// guarantee (write-then-fsync-then-rename-then-fsync-directory; index before journal) is identical to
// the async path above — this is a mechanical transliteration, not a different protocol.
function atomicWriteFileSync(directory, path, text) {
  const token = randomToken();
  const temporaryPath = join(directory, `.tmp-${token}`);
  const fd = openSync(temporaryPath, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, Buffer.from(text, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
  const directoryFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function acquireLockSync(lockPath, legacyPath) {
  ensureLockDatabaseFileSync(lockPath);
  const database = acquireSqliteLock(lockPath);
  try {
    return Object.freeze({
      database,
      legacyFence: acquireLegacyMigrationFenceSync(legacyPath),
    });
  } catch (error) {
    try {
      releaseSqliteLock(database);
    } catch {
      // Preserve the acquisition error.
    }
    throw error;
  }
}

function releaseLockSync(lock) {
  let failure = null;
  try {
    releaseSqliteLock(lock.database);
  } catch (error) {
    failure = error;
  }
  try {
    releaseLegacyMigrationFenceSync(lock.legacyFence);
  } catch (error) {
    if (failure === null) failure = error;
  }
  if (failure !== null) throw failure;
}

function assertIndexShape(value) {
  canonicalJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('durable cycle store index must use the exact schema');
  }
  const fields = Object.hasOwn(value, 'globalKeys')
    ? ['schema', 'revision', 'archivedCycleIds', 'authorizations', 'receipts', 'globalKeys']
    : ['schema', 'revision', 'archivedCycleIds', 'authorizations', 'receipts'];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error('durable cycle store index must use the exact schema');
  }
  if (value.schema !== indexSchema) throw new Error('durable cycle store index schema is invalid');
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error('durable cycle store index revision is invalid');
  if (!Array.isArray(value.archivedCycleIds)) throw new Error('durable cycle store archived cycle identifiers are invalid');
  value.archivedCycleIds.forEach(assertCycleId);
  const archivedIds = new Set(value.archivedCycleIds);
  if (archivedIds.size !== value.archivedCycleIds.length) throw new Error('durable cycle store archived cycle identifiers must be unique');
  for (let index = 1; index < value.archivedCycleIds.length; index += 1) {
    if (value.archivedCycleIds[index].localeCompare(value.archivedCycleIds[index - 1]) <= 0) throw new Error('durable cycle store archived cycle identifiers must be sorted');
  }
  if (!Array.isArray(value.authorizations) || !Array.isArray(value.receipts) || (Object.hasOwn(value, 'globalKeys') && !Array.isArray(value.globalKeys))) {
    throw new Error('durable cycle store evidence index is invalid');
  }

  const authorizations = new Map();
  const authorizationNonces = new Map();
  for (const raw of value.authorizations) {
    const record = assertAuthorizationRecord(raw);
    if (authorizations.has(record.key)) throw new Error('duplicate durable cycle store authorization record');
    if (authorizationNonces.has(record.nonceKey)) throw new Error('duplicate durable cycle store authorization nonce');
    authorizations.set(record.key, record);
    authorizationNonces.set(record.nonceKey, record.key);
  }
  const receipts = new Map();
  for (const raw of value.receipts) {
    const record = assertReceiptRecord(raw);
    if (receipts.has(record.key)) throw new Error('duplicate durable cycle store receipt record');
    receipts.set(record.key, record);
  }
  const globalKeys = new Map();
  for (const raw of value.globalKeys ?? []) {
    exactObject(raw, ['key', 'value'], 'durable global reservation record');
    const key = assertGlobalKey(raw.key);
    canonicalJson(raw.value);
    if (globalKeys.has(key)) throw new Error('duplicate durable global reservation key');
    globalKeys.set(key, structuredClone(raw.value));
  }
  return {
    revision: value.revision,
    archivedCycleIds: [...archivedIds],
    authorizations,
    authorizationNonces,
    receipts,
    globalKeys,
  };
}

function emptyIndex() {
  return {
    revision: 0,
    archivedCycleIds: [],
    authorizations: new Map(),
    authorizationNonces: new Map(),
    receipts: new Map(),
    globalKeys: new Map(),
  };
}

function serializeIndex(index) {
  const value = {
    schema: indexSchema,
    revision: index.revision,
    archivedCycleIds: [...index.archivedCycleIds].sort((a, b) => a.localeCompare(b)),
    authorizations: [...index.authorizations.values()].sort((a, b) => a.key.localeCompare(b.key)).map(record => structuredClone(record)),
    receipts: [...index.receipts.values()].sort((a, b) => a.key.localeCompare(b.key)).map(record => structuredClone(record)),
    globalKeys: [...index.globalKeys.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value: structuredClone(value) })),
  };
  return `${canonicalJson(value)}\n`;
}

function encodeCycleFileName(cycleId) {
  return `${encodeURIComponent(cycleId)}.json`;
}

function serializeActiveCycle(cycle) {
  const value = { schema: activeCycleSchema, cycle: assertCycleSnapshot(cycle) };
  return `${canonicalJson(value)}\n`;
}

function parseActiveCycle(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} contains corrupt JSON`);
  }
  if (`${canonicalJson(parsed)}\n` !== text) throw new Error(`${label} bytes are not canonical JSON plus one newline`);
  exactObject(parsed, ['schema', 'cycle'], label);
  if (parsed.schema !== activeCycleSchema) throw new Error(`${label} schema is invalid`);
  return assertCycleSnapshot(parsed.cycle);
}

function serializeArchivedCycle(cycle, archivedAt) {
  const value = { schema: archivedCycleSchema, archivedAt, cycle: assertCycleSnapshot(cycle) };
  return `${canonicalJson(value)}\n`;
}

function parseArchivedCycle(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} contains corrupt JSON`);
  }
  if (`${canonicalJson(parsed)}\n` !== text) throw new Error(`${label} bytes are not canonical JSON plus one newline`);
  exactObject(parsed, ['schema', 'archivedAt', 'cycle'], label);
  if (parsed.schema !== archivedCycleSchema) throw new Error(`${label} schema is invalid`);
  if (typeof parsed.archivedAt !== 'string' || !isoTimestamp.test(parsed.archivedAt)) throw new Error(`${label} archive timestamp is invalid`);
  return { cycle: assertCycleSnapshot(parsed.cycle), archivedAt: parsed.archivedAt };
}

function assertStageIdentifier(value) {
  if (typeof value !== 'string' || !stageIdentifierPattern.test(value)) throw new Error('paged payout stage identifier is invalid');
  return value;
}

function assertGlobalKey(value) {
  if (typeof value !== 'string' || !globalKeyPattern.test(value)) throw new Error('durable global reservation key is invalid');
  return value;
}

function assertPrivateDirectoryInfo(value, label) {
  if (value.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!value.isDirectory()) throw new Error(`${label} must be a directory`);
  if ((value.mode & 0o777) !== privateDirectoryMode) throw new Error(`${label} mode must be 0700`);
}

async function hasOnlyExpectedLockDatabaseArtifacts(path) {
  let directory;
  try {
    directory = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  try {
    assertPrivateDirectoryInfo(directory, 'durable cycle store SQLite lock directory');
    let hasDatabase = false;
    let hasJournal = false;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!lockDatabaseArtifactNames.has(entry.name) || !entry.isFile()) return false;
      assertLockDatabaseFile(
        await lstat(join(path, entry.name)),
        `durable cycle store SQLite lock artifact ${entry.name}`,
      );
      if (entry.name === lockDatabaseFileName) hasDatabase = true;
      if (entry.name === `${lockDatabaseFileName}-journal`) hasJournal = true;
    }
    return !hasJournal || hasDatabase;
  } catch {
    return false;
  }
}

function hasOnlyExpectedLockDatabaseArtifactsSync(path) {
  let directory;
  try {
    directory = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  try {
    assertPrivateDirectoryInfo(directory, 'durable cycle store SQLite lock directory');
    let hasDatabase = false;
    let hasJournal = false;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!lockDatabaseArtifactNames.has(entry.name) || !entry.isFile()) return false;
      assertLockDatabaseFile(
        lstatSync(join(path, entry.name)),
        `durable cycle store SQLite lock artifact ${entry.name}`,
      );
      if (entry.name === lockDatabaseFileName) hasDatabase = true;
      if (entry.name === `${lockDatabaseFileName}-journal`) hasJournal = true;
    }
    return !hasJournal || hasDatabase;
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(path, label) {
  try {
    assertPrivateDirectoryInfo(await lstat(path), label);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await mkdir(path, { mode: privateDirectoryMode });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await chmod(path, privateDirectoryMode);
  assertPrivateDirectoryInfo(await lstat(path), label);
}

function ensurePrivateDirectorySync(path, label) {
  try {
    assertPrivateDirectoryInfo(lstatSync(path), label);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    mkdirSync(path, { mode: privateDirectoryMode });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  chmodSync(path, privateDirectoryMode);
  assertPrivateDirectoryInfo(lstatSync(path), label);
}

async function assertPrivateDirectory(path, label) {
  try {
    assertPrivateDirectoryInfo(await lstat(path), label);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw error;
  }
}

async function privateDirectoryExists(path, label) {
  try {
    assertPrivateDirectoryInfo(await lstat(path), label);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertCanonicalPayoutValue(value, label, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} number is invalid`);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error(`${label} has an unsupported value`);
  if (active.has(value)) throw new Error(`${label} is cyclic`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
        throw new Error(`${label} array is not canonical`);
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes('length') || names.some(name => name !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length))) {
        throw new Error(`${label} array is not canonical`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`${label} array is not canonical`);
        assertCanonicalPayoutValue(descriptor.value, `${label}[${index}]`, active);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error(`${label} object is not canonical`);
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (forbiddenCanonicalKeys.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label} object is not canonical`);
      }
      assertCanonicalPayoutValue(descriptor.value, `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function recipientKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'recipient');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !globalKeyPattern.test(descriptor.value)) return null;
  return descriptor.value;
}

function recipientKeys(value, label, { required = false } = {}) {
  if (!Array.isArray(value)) {
    if (required) throw new Error(`${label} recipients are invalid`);
    return null;
  }
  const keys = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const key = recipientKey(value[index]);
    if (key === null || seen.has(key)) {
      if (required) throw new Error(`${label} recipients must have unique recipient keys`);
      return null;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function assertPagedPayoutState(cycleId, value) {
  assertCycleId(cycleId);
  assertCanonicalPayoutValue(value, 'paged payout state');
  assertBoundedCanonicalValue(value, 'paged payout state', {
    arrayItems: pagedPayoutPageItems * maximumPagedPayoutPages,
    aggregateBytes: maximumPagedPayoutStateBytes,
  });
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('paged payout state must be a plain object');
  }
  const stateCycleId = Object.getOwnPropertyDescriptor(value, 'cycleId');
  if (!stateCycleId || !Object.hasOwn(stateCycleId, 'value') || stateCycleId.value !== cycleId) {
    throw new Error('paged payout state cycle identifier does not match its storage key');
  }
  const recipients = Object.getOwnPropertyDescriptor(value, 'recipients');
  if (!recipients || !Object.hasOwn(recipients, 'value')) throw new Error('paged payout state recipients are required');
  recipientKeys(recipients.value, 'paged payout state', { required: true });
  return structuredClone(value);
}

function assertGeneration(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('paged payout generation is invalid');
  }
  return value;
}

function pageFileName(pageId) {
  if (!Number.isInteger(pageId) || pageId < 0 || pageId >= maximumPagedPayoutPages) throw new Error('paged payout page identifier is invalid');
  return `${String(pageId).padStart(4, '0')}.json`;
}

function pageReference(kind, length, pages) {
  return {
    schema: pagedPayoutReferenceSchema,
    kind,
    length,
    pages,
  };
}

function addPayoutPage(context, kind, entries) {
  if (context.pages.length >= maximumPagedPayoutPages) throw new Error('paged payout state exceeds the page limit');
  const pageId = context.pages.length;
  const page = {
    schema: pagedPayoutPageSchema,
    cycleId: context.cycleId,
    stage: context.stage,
    generation: context.generation,
    pageId,
    kind,
    entries,
  };
  canonicalJson(page);
  context.pages.push(page);
  return { id: pageId, digest: digest(page) };
}

function encodePagedPayoutValue(value, context) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const keys = recipientKeys(value, 'paged payout value');
    const kind = keys === null ? 'sequence' : 'recipient-map';
    const pages = [];
    for (let start = 0; start < value.length; start += pagedPayoutPageItems) {
      const end = Math.min(start + pagedPayoutPageItems, value.length);
      if (kind === 'sequence') {
        pages.push(addPayoutPage(context, kind, value.slice(start, end).map(entry => encodePagedPayoutValue(entry, context))));
        continue;
      }
      const entries = {};
      for (let index = start; index < end; index += 1) {
        Object.defineProperty(entries, keys[index], {
          enumerable: true,
          value: { index, value: encodePagedPayoutValue(value[index], context) },
        });
      }
      pages.push(addPayoutPage(context, kind, entries));
    }
    return pageReference(kind, value.length, pages);
  }
  if (internalPagedSchemas.has(value.schema)) throw new Error('paged payout state uses a reserved schema');
  const encoded = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(encoded, key, { enumerable: true, value: encodePagedPayoutValue(entry, context) });
  }
  return encoded;
}

function serializePagedPayoutManifest({ cycleId, stage, generation, pages, state }) {
  const manifest = {
    schema: pagedPayoutManifestSchema,
    cycleId,
    stage,
    generation,
    pageCount: pages.length,
    state,
  };
  return `${canonicalJson(manifest)}\n`;
}

function parsePagedPayoutManifest(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} contains corrupt JSON`);
  }
  if (`${canonicalJson(value)}\n` !== text) throw new Error(`${label} bytes are not canonical JSON plus one newline`);
  exactObject(value, ['schema', 'cycleId', 'stage', 'generation', 'pageCount', 'state'], label);
  if (value.schema !== pagedPayoutManifestSchema) throw new Error(`${label} schema is invalid`);
  assertCycleId(value.cycleId);
  assertStageIdentifier(value.stage);
  assertGeneration(value.generation);
  if (!Number.isInteger(value.pageCount) || value.pageCount < 0 || value.pageCount > maximumPagedPayoutPages) {
    throw new Error(`${label} page count is invalid`);
  }
  return value;
}

function parsePagedPayoutPage(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} contains corrupt JSON`);
  }
  if (`${canonicalJson(value)}\n` !== text) throw new Error(`${label} bytes are not canonical JSON plus one newline`);
  exactObject(value, ['schema', 'cycleId', 'stage', 'generation', 'pageId', 'kind', 'entries'], label);
  if (value.schema !== pagedPayoutPageSchema) throw new Error(`${label} schema is invalid`);
  assertCycleId(value.cycleId);
  assertStageIdentifier(value.stage);
  assertGeneration(value.generation);
  pageFileName(value.pageId);
  if (!['sequence', 'recipient-map'].includes(value.kind)) throw new Error(`${label} kind is invalid`);
  if (value.kind === 'sequence') {
    if (!Array.isArray(value.entries) || value.entries.length > pagedPayoutPageItems) throw new Error(`${label} entries are invalid`);
  } else if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) || Object.keys(value.entries).length > pagedPayoutPageItems) {
    throw new Error(`${label} entries are invalid`);
  }
  return value;
}

function assertPagedReference(value, label) {
  exactObject(value, ['schema', 'kind', 'length', 'pages'], label);
  if (value.schema !== pagedPayoutReferenceSchema) throw new Error(`${label} schema is invalid`);
  if (!['sequence', 'recipient-map'].includes(value.kind)) throw new Error(`${label} kind is invalid`);
  if (!Number.isInteger(value.length) || value.length < 0 || value.length > pagedPayoutPageItems * maximumPagedPayoutPages) {
    throw new Error(`${label} length is invalid`);
  }
  if (!Array.isArray(value.pages) || value.pages.length !== Math.ceil(value.length / pagedPayoutPageItems)) {
    throw new Error(`${label} pages are invalid`);
  }
  return value.pages.map((page, index) => {
    exactObject(page, ['id', 'digest'], `${label} page ${index}`);
    pageFileName(page.id);
    if (typeof page.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(page.digest)) throw new Error(`${label} page ${index} digest is invalid`);
    return page;
  });
}

async function decodePagedPayoutValue(value, context) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('paged payout manifest state is invalid');
  }
  if (value.schema === pagedPayoutReferenceSchema) {
    const pages = assertPagedReference(value, 'paged payout reference');
    const entries = [];
    const recipientEntries = new Map();
    for (const pageReferenceValue of pages) {
      if (context.pageIds.has(pageReferenceValue.id)) throw new Error('paged payout page is referenced more than once');
      context.pageIds.add(pageReferenceValue.id);
      const page = await context.readPage(pageReferenceValue);
      if (page.kind !== value.kind) throw new Error('paged payout page kind does not match its reference');
      if (value.kind === 'sequence') {
        for (const entry of page.entries) entries.push(await decodePagedPayoutValue(entry, context));
        continue;
      }
      for (const [recipient, entry] of Object.entries(page.entries)) {
        if (!globalKeyPattern.test(recipient) || recipientEntries.has(recipient)) throw new Error('paged payout recipient key is invalid or duplicated');
        exactObject(entry, ['index', 'value'], `paged payout recipient ${recipient}`);
        if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= value.length || entries[entry.index] !== undefined) {
          throw new Error('paged payout recipient index is invalid or duplicated');
        }
        entries[entry.index] = await decodePagedPayoutValue(entry.value, context);
        recipientEntries.set(recipient, entry.index);
      }
    }
    if (entries.length !== value.length) throw new Error('paged payout page entries do not reconstruct their reference');
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index] === undefined) throw new Error('paged payout page entries do not reconstruct their reference');
    }
    return entries;
  }
  const decoded = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(decoded, key, { enumerable: true, value: await decodePagedPayoutValue(entry, context) });
  }
  return decoded;
}

/**
 * A durable transaction wraps the underlying FixtureCycleStore transaction
 * (`inner`) obtained from the in-memory hot store, adding a pre-check against
 * the durable, never-forgotten evidence index so a nonce or receipt consumed
 * by an already-archived cycle can never be replayed by a later one.
 */
class DurableCycleTransaction {
  #store;
  #closed = false;
  #stagedGlobalKeys = new Map();
  #stagedGlobalKeyReplacements = new Map();
  #stagedGlobalKeyReleases = new Map();

  constructor(store, inner, cycleId) {
    this.#store = store;
    this.inner = inner;
    this.cycleId = cycleId;
  }

  #assertOpen() {
    if (this.#closed) throw new Error('durable cycle transaction is closed');
  }

  assertOwner(store) {
    this.#assertOpen();
    if (this.#store !== store) throw new Error('durable cycle transaction belongs to a different store');
  }

  stageEvent(value) {
    this.#assertOpen();
    this.inner.stageEvent(value);
  }

  consumeAuthorization(value) {
    this.#assertOpen();
    const record = assertAuthorizationRecord(value);
    this.#store.checkAuthorizationAgainstDurableIndex(record);
    return this.inner.consumeAuthorization(value);
  }

  consumeReceipt(value) {
    this.#assertOpen();
    const record = assertReceiptRecord(value);
    this.#store.checkReceiptAgainstDurableIndex(record);
    return this.inner.consumeReceipt(value);
  }

  consume(value) { return this.consumeReceipt(value); }

  /**
   * Stages a permanent global reservation beside this journal transaction. The store rechecks it
   * while holding its durable lock, so callers cannot lose uniqueness between a preflight read and
   * their journal append.
   */
  stageGlobalKey(key, value) {
    this.#assertOpen();
    assertGlobalKey(key);
    canonicalJson(value);
    const reservation = structuredClone(value);
    if (this.#stagedGlobalKeyReplacements.has(key) || this.#stagedGlobalKeyReleases.has(key)) {
      throw new Error('durable transaction stages conflicting global reservation operations');
    }
    const previous = this.#stagedGlobalKeys.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(reservation)) {
      throw new Error('durable transaction stages conflicting global reservation values');
    }
    this.#store.checkGlobalKeyAgainstDurableIndex(key, reservation);
    this.#stagedGlobalKeys.set(key, reservation);
  }

  /** Atomically replaces one known global reservation beside this journal transaction. */
  stageGlobalKeyReplacement(key, expectedValue, value) {
    this.#assertOpen();
    assertGlobalKey(key);
    canonicalJson(expectedValue);
    canonicalJson(value);
    if (this.#stagedGlobalKeys.has(key) || this.#stagedGlobalKeyReleases.has(key)) {
      throw new Error('durable transaction stages conflicting global reservation operations');
    }
    const replacement = { expectedValue: structuredClone(expectedValue), value: structuredClone(value) };
    const previous = this.#stagedGlobalKeyReplacements.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(replacement)) {
      throw new Error('durable transaction stages conflicting global reservation replacements');
    }
    this.#store.checkGlobalKeyReplacementAgainstDurableIndex(key, replacement.expectedValue, replacement.value);
    this.#stagedGlobalKeyReplacements.set(key, replacement);
  }

  /** Atomically removes one known global reservation beside this journal transaction. */
  stageGlobalKeyRelease(key, expectedValue) {
    this.#assertOpen();
    assertGlobalKey(key);
    canonicalJson(expectedValue);
    if (this.#stagedGlobalKeys.has(key) || this.#stagedGlobalKeyReplacements.has(key)) {
      throw new Error('durable transaction stages conflicting global reservation operations');
    }
    const expected = structuredClone(expectedValue);
    const previous = this.#stagedGlobalKeyReleases.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(expected)) {
      throw new Error('durable transaction stages conflicting global reservation releases');
    }
    this.#store.checkGlobalKeyReleaseAgainstDurableIndex(key, expected);
    this.#stagedGlobalKeyReleases.set(key, expected);
  }

  authorizationRecord(key) { return this.#store.authorizationRecord(key); }
  receiptRecord(key) { return this.#store.receiptRecord(key); }
  assertStagedRecordsPersisted() { this.inner.assertStagedRecordsPersisted(); }

  get stagedEvents() { return this.inner.stagedEvents; }
  get stagedAuthorizations() { return this.inner.stagedAuthorizations; }
  get stagedReceipts() { return this.inner.stagedReceipts; }
  get stagedGlobalKeys() { return [...this.#stagedGlobalKeys.entries()].map(([key, value]) => [key, structuredClone(value)]); }
  get stagedGlobalKeyReplacements() {
    return [...this.#stagedGlobalKeyReplacements.entries()].map(([key, value]) => [key, structuredClone(value)]);
  }
  get stagedGlobalKeyReleases() { return [...this.#stagedGlobalKeyReleases.entries()].map(([key, value]) => [key, structuredClone(value)]); }

  close() {
    this.#closed = true;
    this.inner.close();
  }
}

export class DurableCycleStore {
  #directory;
  #activeDirectory;
  #archiveDirectory;
  #payoutDirectory;
  #indexPath;
  #legacyLockPath;
  #lockDatabasePath;
  #hot;
  #index;
  #activeCycleIds;
  #queue = Promise.resolve();

  constructor(guard, directory) {
    if (guard !== openGuard) throw new Error('DurableCycleStore must be constructed with DurableCycleStore.open(directory)');
    this.#directory = directory;
    this.#activeDirectory = join(directory, 'active');
    this.#archiveDirectory = join(directory, 'archive');
    this.#payoutDirectory = join(directory, 'payout');
    this.#indexPath = join(directory, 'index.json');
    this.#legacyLockPath = legacyLockPath(directory);
    this.#lockDatabasePath = lockDatabasePath(directory);
  }

  static async open(directory) {
    assertStoreDirectoryPath(directory);
    const recovery = await readStateDirectoryRecovery(directory);
    if (recovery.detected) throw new StateDirectoryLossError(recovery);
    const store = new DurableCycleStore(openGuard, directory);
    if (recovery.identity === null) {
      await mkdir(store.#activeDirectory, { recursive: true });
      await mkdir(store.#archiveDirectory, { recursive: true });
      await ensurePrivateDirectory(store.#payoutDirectory, 'durable cycle store payout directory');
    } else {
      await assertPrivateDirectory(store.#payoutDirectory, 'durable cycle store payout directory');
    }
    await store.#withLock(async () => {
      const lockedRecovery = await readStateDirectoryRecovery(directory);
      if (lockedRecovery.detected) throw new StateDirectoryLossError(lockedRecovery);
      if (lockedRecovery.identity === null) {
        const identity = {
          schema: storeIdentitySchema,
          storeId: randomToken(),
          createdAt: new Date().toISOString(),
        };
        const stateDirectory = await lstat(directory, { bigint: true });
        if (stateDirectory.isSymbolicLink() || !stateDirectory.isDirectory()) {
          throw new Error('durable cycle store state directory is unavailable during bootstrap');
        }
        await atomicWriteFile(
          directory,
          stateDirectoryIdentityPath(directory),
          serializeStateDirectoryIdentity({
            schema: stateDirectoryIdentitySchema,
            storeId: identity.storeId,
            ...stateDirectoryWitness(stateDirectory),
          }),
        );
        await atomicWriteFile(
          dirname(lockedRecovery.identityPath),
          lockedRecovery.identityPath,
          serializeStoreIdentity(identity),
        );
      }
      store.#index = await store.#loadIndex();
      const cycles = await store.#loadActiveCycles();
      store.#activeCycleIds = new Set(cycles.map(cycle => cycle.cycleId));
      store.#hot = store.#buildHot(cycles);
    });
    return store;
  }

  async #withLock(work) {
    const run = async () => {
      const lock = await acquireLock(this.#lockDatabasePath, this.#legacyLockPath);
      try {
        return await work();
      } finally {
        await releaseLock(lock);
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  async #loadIndex() {
    const text = await readStableFile(this.#indexPath, maximumIndexBytes, 'durable cycle store index file');
    if (text === null) return emptyIndex();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('durable cycle store index file contains corrupt JSON');
    }
    if (`${canonicalJson(parsed)}\n` !== text) throw new Error('durable cycle store index file bytes are not canonical JSON plus one newline');
    return assertIndexShape(parsed);
  }

  #loadIndexSync() {
    const text = readStableFileSync(this.#indexPath, maximumIndexBytes, 'durable cycle store index file');
    if (text === null) return emptyIndex();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('durable cycle store index file contains corrupt JSON');
    }
    if (`${canonicalJson(parsed)}\n` !== text) throw new Error('durable cycle store index file bytes are not canonical JSON plus one newline');
    return assertIndexShape(parsed);
  }

  async #writeIndex() {
    const bytes = serializeIndex(this.#index);
    await atomicWriteFile(this.#directory, this.#indexPath, bytes);
  }

  async #refreshIndexUnderLock() {
    this.#index = await this.#loadIndex();
  }

  #payoutCycleDirectory(cycleId) {
    return join(this.#payoutDirectory, encodeURIComponent(cycleId));
  }

  #payoutStageDirectory(cycleId, stage) {
    return join(this.#payoutCycleDirectory(cycleId), encodeURIComponent(stage));
  }

  async #loadActiveCycles() {
    const entries = await readdir(this.#activeDirectory, { withFileTypes: true });
    const archivedIds = new Set(this.#index.archivedCycleIds);
    const cycles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      const path = join(this.#activeDirectory, entry.name);
      const text = await readStableFile(path, maximumCycleFileBytes, `durable cycle store active cycle file ${entry.name}`);
      if (text === null) continue;
      const cycle = parseActiveCycle(text, `durable cycle store active cycle file ${entry.name}`);
      if (encodeCycleFileName(cycle.cycleId) !== entry.name) throw new Error(`durable cycle store active cycle file ${entry.name} identity mismatch`);
      if (archivedIds.has(cycle.cycleId)) {
        // A crash between archiveCycle() writing the index and unlinking the
        // active file left this stray copy behind; the index is authoritative,
        // so discard it here and finish the cleanup it never got to.
        await unlink(path).catch(() => {});
        continue;
      }
      cycles.push(cycle);
    }
    cycles.sort((a, b) => a.cycleId.localeCompare(b.cycleId));
    return cycles;
  }

  #buildHot(cycles) {
    const activeIds = new Set(cycles.map(cycle => cycle.cycleId));
    const authorizations = [...this.#index.authorizations.values()].filter(record => activeIds.has(record.cycleId));
    const receipts = [...this.#index.receipts.values()].filter(record => activeIds.has(record.cycleId));
    return new FixtureCycleStore({
      schema: 'hookemon.fixture-cycle-store.v1',
      cycles: cycles.map(cycle => structuredClone(cycle)),
      authorizations,
      receipts,
    });
  }

  checkAuthorizationAgainstDurableIndex(record) {
    const existing = this.#index.authorizations.get(record.key);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new Error('authorization already consumed by different evidence');
    const nonceOwner = this.#index.authorizationNonces.get(record.nonceKey);
    if (nonceOwner && nonceOwner !== record.key) throw new Error('authorization nonce already consumed');
  }

  checkReceiptAgainstDurableIndex(record) {
    const existing = this.#index.receipts.get(record.key);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new Error('provider receipt already consumed by a different cycle or receipt');
  }

  checkGlobalKeyAgainstDurableIndex(key, value) {
    assertGlobalKey(key);
    canonicalJson(value);
    const existing = this.#index.globalKeys.get(key);
    if (existing && canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error('durable global reservation key is already reserved by a different value');
    }
  }

  checkGlobalKeyReplacementAgainstDurableIndex(key, expectedValue, value) {
    assertGlobalKey(key);
    canonicalJson(expectedValue);
    canonicalJson(value);
    const existing = this.#index.globalKeys.get(key);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(expectedValue)) {
      throw new Error('durable global reservation key changed before replacement');
    }
  }

  checkGlobalKeyReleaseAgainstDurableIndex(key, expectedValue) {
    assertGlobalKey(key);
    canonicalJson(expectedValue);
    const existing = this.#index.globalKeys.get(key);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(expectedValue)) {
      throw new Error('durable global reservation key changed before release');
    }
  }

  get activeCycleIds() { return Object.freeze([...this.#activeCycleIds].sort((a, b) => a.localeCompare(b))); }
  get archivedCycleIds() { return Object.freeze([...this.#index.archivedCycleIds].sort((a, b) => a.localeCompare(b))); }

  authorizationRecord(key) {
    const record = this.#index.authorizations.get(key);
    return record ? structuredClone(record) : null;
  }

  authorizationKeyForNonce(nonceKey) {
    return this.#index.authorizationNonces.get(nonceKey) ?? null;
  }

  receiptRecord(key) {
    const record = this.#index.receipts.get(key);
    return record ? structuredClone(record) : null;
  }

  /**
   * Reserves a small, globally unique durable key. Repeating the same owner
   * value is idempotent; a different owner is refused under the store lock.
   */
  async reserveGlobalKey(key, value) {
    assertGlobalKey(key);
    canonicalJson(value);
    const reservation = structuredClone(value);
    return this.#withLock(async () => {
      await this.#refreshIndexUnderLock();
      if (this.#index.globalKeys.has(key)) {
        const existing = this.#index.globalKeys.get(key);
        if (canonicalJson(existing) !== canonicalJson(reservation)) throw new Error('durable global reservation key is already reserved by a different value');
        return structuredClone(existing);
      }
      this.#index.globalKeys.set(key, reservation);
      this.#index.revision += 1;
      await this.#writeIndex();
      return structuredClone(reservation);
    });
  }

  async readGlobalKey(key) {
    assertGlobalKey(key);
    return this.#withLock(async () => {
      await this.#refreshIndexUnderLock();
      const reservation = this.#index.globalKeys.get(key);
      return reservation === undefined ? null : structuredClone(reservation);
    });
  }

  async releaseGlobalKey(key, value) {
    assertGlobalKey(key);
    canonicalJson(value);
    const reservation = structuredClone(value);
    return this.#withLock(async () => {
      await this.#refreshIndexUnderLock();
      if (!this.#index.globalKeys.has(key)) return false;
      const existing = this.#index.globalKeys.get(key);
      if (canonicalJson(existing) !== canonicalJson(reservation)) throw new Error('durable global reservation key is owned by different value');
      this.#index.globalKeys.delete(key);
      this.#index.revision += 1;
      await this.#writeIndex();
      return true;
    });
  }

  /**
   * Stores direct-payout state outside the bounded journal payload. Every
   * sequence is split into 64-item files; sequences whose entries carry a
   * unique recipient use recipient keys inside each page. The manifest is
   * written only after every page for a fresh generation is durable.
   */
  async persistPagedPayoutState(cycleId, stage, state) {
    assertCycleId(cycleId);
    assertStageIdentifier(stage);
    const validatedState = assertPagedPayoutState(cycleId, state);
    return this.#withLock(async () => {
      const cycleDirectory = this.#payoutCycleDirectory(cycleId);
      const stageDirectory = this.#payoutStageDirectory(cycleId, stage);
      await ensurePrivateDirectory(cycleDirectory, 'durable cycle store payout cycle directory');
      await ensurePrivateDirectory(stageDirectory, 'durable cycle store payout stage directory');

      const generation = randomToken();
      const generationDirectory = join(stageDirectory, generation);
      await ensurePrivateDirectory(generationDirectory, 'durable cycle store payout generation directory');
      const context = { cycleId, stage, generation, pages: [] };
      const encodedState = encodePagedPayoutValue(validatedState, context);
      for (const page of context.pages) {
        await atomicWriteFile(
          generationDirectory,
          join(generationDirectory, pageFileName(page.pageId)),
          `${canonicalJson(page)}\n`,
        );
      }
      await atomicWriteFile(
        stageDirectory,
        join(stageDirectory, 'manifest.json'),
        serializePagedPayoutManifest({ cycleId, stage, generation, pages: context.pages, state: encodedState }),
      );
    });
  }

  async readPagedPayoutState(cycleId, stage) {
    assertCycleId(cycleId);
    assertStageIdentifier(stage);
    const cycleDirectory = this.#payoutCycleDirectory(cycleId);
    const stageDirectory = this.#payoutStageDirectory(cycleId, stage);
    if (!(await privateDirectoryExists(this.#payoutDirectory, 'durable cycle store payout directory'))
      || !(await privateDirectoryExists(cycleDirectory, 'durable cycle store payout cycle directory'))
      || !(await privateDirectoryExists(stageDirectory, 'durable cycle store payout stage directory'))) {
      return null;
    }
    const manifestPath = join(stageDirectory, 'manifest.json');
    const manifestText = await readStableFile(manifestPath, maximumPagedPayoutPageBytes, 'durable cycle store payout manifest');
    if (manifestText === null) return null;
    const manifest = parsePagedPayoutManifest(manifestText, 'durable cycle store payout manifest');
    if (manifest.cycleId !== cycleId || manifest.stage !== stage) throw new Error('durable cycle store payout manifest identity mismatch');
    const generationDirectory = join(stageDirectory, manifest.generation);
    await assertPrivateDirectory(generationDirectory, 'durable cycle store payout generation directory');
    const context = {
      pageIds: new Set(),
      readPage: async reference => {
        const path = join(generationDirectory, pageFileName(reference.id));
        const text = await readStableFile(path, maximumPagedPayoutPageBytes, `durable cycle store payout page ${reference.id}`);
        if (text === null) throw new Error('durable cycle store payout page is missing');
        const page = parsePagedPayoutPage(text, `durable cycle store payout page ${reference.id}`);
        if (page.cycleId !== cycleId || page.stage !== stage || page.generation !== manifest.generation || page.pageId !== reference.id) {
          throw new Error('durable cycle store payout page identity mismatch');
        }
        if (digest(page) !== reference.digest) throw new Error('durable cycle store payout page digest does not match its manifest');
        return page;
      },
    };
    const state = await decodePagedPayoutValue(manifest.state, context);
    if (context.pageIds.size !== manifest.pageCount) throw new Error('durable cycle store payout manifest page count does not match its state');
    for (let pageId = 0; pageId < manifest.pageCount; pageId += 1) {
      if (!context.pageIds.has(pageId)) throw new Error('durable cycle store payout manifest omits a page');
    }
    return assertPagedPayoutState(cycleId, state);
  }

  readCycle(cycleId) {
    assertCycleId(cycleId);
    if (this.#index.archivedCycleIds.includes(cycleId)) throw new Error('cycle is archived; call readArchivedCycle() for historical lookups');
    return this.#hot.readCycle(cycleId);
  }

  async readArchivedCycle(cycleId) {
    assertCycleId(cycleId);
    if (!this.#index.archivedCycleIds.includes(cycleId)) throw new Error('cycle is not archived in the durable store');
    const path = join(this.#archiveDirectory, encodeCycleFileName(cycleId));
    const text = await readStableFile(path, maximumCycleFileBytes, `durable cycle store archive file for ${cycleId}`);
    if (text === null) throw new Error('durable cycle store archive file is missing');
    const { cycle, archivedAt } = parseArchivedCycle(text, `durable cycle store archive file for ${cycleId}`);
    if (cycle.cycleId !== cycleId) throw new Error('durable cycle store archive file identity mismatch');
    return { cycle, archivedAt };
  }

  begin(cycleId, options) {
    assertCycleId(cycleId);
    if (this.#index.archivedCycleIds.includes(cycleId)) throw new Error('durable cycle store cycle identifier was already archived and cannot be reopened');
    if (!this.#activeCycleIds.has(cycleId) && this.#activeCycleIds.size >= RECOVERY_LIMITS.storeCycles) {
      throw new Error('durable cycle store active cycle count limit exceeded; archive settled cycles before starting new ones');
    }
    const inner = this.#hot.begin(cycleId, options);
    return new DurableCycleTransaction(this, inner, cycleId);
  }

  async commit(transaction) {
    if (!(transaction instanceof DurableCycleTransaction)) throw new Error('durable cycle transaction is invalid');
    transaction.assertOwner(this);
    return this.#withLock(async () => {
      try {
        await this.#refreshIndexUnderLock();
        const stagedAuthorizations = transaction.stagedAuthorizations;
        const stagedReceipts = transaction.stagedReceipts;
        const stagedGlobalKeys = transaction.stagedGlobalKeys;
        const stagedGlobalKeyReplacements = transaction.stagedGlobalKeyReplacements;
        const stagedGlobalKeyReleases = transaction.stagedGlobalKeyReleases;

        // Re-check staged evidence against the durable index one more time
        // now that the store's lock is held: consumeAuthorization/consumeReceipt
        // already checked it while the transaction was being built, but that
        // happened outside the lock, so a concurrently-committed transaction
        // could have raced ahead in the meantime. This is the authoritative,
        // serialized check.
        for (const [, record] of stagedAuthorizations) this.checkAuthorizationAgainstDurableIndex(record);
        for (const [, record] of stagedReceipts) this.checkReceiptAgainstDurableIndex(record);
        for (const [key, value] of stagedGlobalKeys) this.checkGlobalKeyAgainstDurableIndex(key, value);
        for (const [key, replacement] of stagedGlobalKeyReplacements) {
          this.checkGlobalKeyReplacementAgainstDurableIndex(key, replacement.expectedValue, replacement.value);
        }
        for (const [key, expectedValue] of stagedGlobalKeyReleases) {
          this.checkGlobalKeyReleaseAgainstDurableIndex(key, expectedValue);
        }

        this.#hot.commit(transaction.inner);

        // Persist the evidence index before the journal file: if the process
        // crashes between the two writes below, the index (which anti-replay
        // checks depend on) is never behind the journal it protects. A
        // retried commit after such a crash is idempotent — the same
        // authorization/receipt content re-consumes cleanly (see
        // checkAuthorizationAgainstDurableIndex / checkReceiptAgainstDurableIndex)
        // — so the only cost of this ordering is a possible harmless retry,
        // never a replay of consumed evidence.
        for (const [key, record] of stagedAuthorizations) {
          this.#index.authorizations.set(key, record);
          this.#index.authorizationNonces.set(record.nonceKey, key);
        }
        for (const [key, record] of stagedReceipts) this.#index.receipts.set(key, record);
        for (const [key, value] of stagedGlobalKeys) this.#index.globalKeys.set(key, value);
        for (const [key, replacement] of stagedGlobalKeyReplacements) this.#index.globalKeys.set(key, replacement.value);
        for (const [key] of stagedGlobalKeyReleases) this.#index.globalKeys.delete(key);
        this.#index.revision += 1;
        await this.#writeIndex();

        const cycle = this.#hot.readCycle(transaction.cycleId);
        await atomicWriteFile(this.#activeDirectory, join(this.#activeDirectory, encodeCycleFileName(transaction.cycleId)), serializeActiveCycle(cycle));
        this.#activeCycleIds.add(transaction.cycleId);
      } finally {
        transaction.close();
      }
    });
  }

  // Synchronous twin of commit() above (WP-31), for CycleRunner's fully-synchronous public API (see
  // cycle-runner.mjs's #persist): identical ordering and durability guarantees (index before journal,
  // fsync'd atomic writes throughout — see atomicWriteFileSync), using Node's synchronous fs primitives
  // instead of node:fs/promises. Serializes against other *synchronous* commitSync/archiveCycleSync
  // callers via the same on-disk lock file the async path uses (acquireLockSync/releaseLockSync), but a
  // synchronous call cannot join this instance's async #queue — do not interleave commitSync with
  // concurrent async commit()/archiveCycle() calls on the same open DurableCycleStore instance within
  // one process; a single CycleRunner process should pick one calling convention per store instance.
  commitSync(transaction) {
    if (!(transaction instanceof DurableCycleTransaction)) throw new Error('durable cycle transaction is invalid');
    transaction.assertOwner(this);
    const lock = acquireLockSync(this.#lockDatabasePath, this.#legacyLockPath);
    try {
      this.#index = this.#loadIndexSync();
      const stagedAuthorizations = transaction.stagedAuthorizations;
      const stagedReceipts = transaction.stagedReceipts;
      const stagedGlobalKeys = transaction.stagedGlobalKeys;
      const stagedGlobalKeyReplacements = transaction.stagedGlobalKeyReplacements;
      const stagedGlobalKeyReleases = transaction.stagedGlobalKeyReleases;

      for (const [, record] of stagedAuthorizations) this.checkAuthorizationAgainstDurableIndex(record);
      for (const [, record] of stagedReceipts) this.checkReceiptAgainstDurableIndex(record);
      for (const [key, value] of stagedGlobalKeys) this.checkGlobalKeyAgainstDurableIndex(key, value);
      for (const [key, replacement] of stagedGlobalKeyReplacements) {
        this.checkGlobalKeyReplacementAgainstDurableIndex(key, replacement.expectedValue, replacement.value);
      }
      for (const [key, expectedValue] of stagedGlobalKeyReleases) {
        this.checkGlobalKeyReleaseAgainstDurableIndex(key, expectedValue);
      }

      this.#hot.commit(transaction.inner);

      for (const [key, record] of stagedAuthorizations) {
        this.#index.authorizations.set(key, record);
        this.#index.authorizationNonces.set(record.nonceKey, key);
      }
      for (const [key, record] of stagedReceipts) this.#index.receipts.set(key, record);
      for (const [key, value] of stagedGlobalKeys) this.#index.globalKeys.set(key, value);
      for (const [key, replacement] of stagedGlobalKeyReplacements) this.#index.globalKeys.set(key, replacement.value);
      for (const [key] of stagedGlobalKeyReleases) this.#index.globalKeys.delete(key);
      this.#index.revision += 1;
      atomicWriteFileSync(this.#directory, this.#indexPath, serializeIndex(this.#index));

      const cycle = this.#hot.readCycle(transaction.cycleId);
      atomicWriteFileSync(this.#activeDirectory, join(this.#activeDirectory, encodeCycleFileName(transaction.cycleId)), serializeActiveCycle(cycle));
      this.#activeCycleIds.add(transaction.cycleId);
    } finally {
      transaction.close();
      releaseLockSync(lock);
    }
  }

  async archiveCycle(cycleId) {
    assertCycleId(cycleId);
    return this.#withLock(async () => {
      await this.#refreshIndexUnderLock();
      if (this.#index.archivedCycleIds.includes(cycleId)) throw new Error('cycle is already archived');
      if (!this.#activeCycleIds.has(cycleId)) throw new Error('cycle is not active in the durable cycle store');
      const cycle = this.#hot.readCycle(cycleId);
      if (cycle.version === 0) throw new Error('cycle has no committed journal and cannot be archived');

      // Write the archive file, then the index (the authority on what is
      // archived), and only then unlink the active file: if the process
      // crashes before the unlink, the next open() sees an active-directory
      // file shadowed by an index entry that already marks it archived and
      // discards the stray copy (see #loadActiveCycles). The index is never
      // behind what is actually safely archived on disk.
      const archivedAt = new Date().toISOString();
      await atomicWriteFile(this.#archiveDirectory, join(this.#archiveDirectory, encodeCycleFileName(cycleId)), serializeArchivedCycle(cycle, archivedAt));

      this.#index.archivedCycleIds = [...this.#index.archivedCycleIds, cycleId].sort((a, b) => a.localeCompare(b));
      this.#index.revision += 1;
      await this.#writeIndex();

      const activePath = join(this.#activeDirectory, encodeCycleFileName(cycleId));
      await unlink(activePath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      this.#activeCycleIds.delete(cycleId);

      const remaining = [...this.#activeCycleIds].sort((a, b) => a.localeCompare(b)).map(id => this.#hot.readCycle(id));
      this.#hot = this.#buildHot(remaining);
    });
  }
}
