import {
  lstat,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from 'node:path';

import { assertOperatorConfiguration, migrateOperatorConfiguration } from '../config/state-schema.mjs';
import { canonicalJson } from '../cycle/journal.mjs';

const STATE_SCHEMA = 'hookemon.operator-state.v2';
const stateFields = ['schema', 'revision', 'configuration'];
const maximumStateBytes = 4_194_304;
const maximumLockBytes = 512;
const lockOwnerFields = ['pid', 'token'];
const lockTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const OPERATOR_HARD_CAPS = Object.freeze({
  maxBoostersPerCycle: '1000',
  maxUnitPriceMicroUsdg: '25000000',
  maxCycleBudgetMicroUsdg: '50000000',
  max24HourBudgetMicroUsdg: '3600000000',
});

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

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRevision(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('operator state revision is invalid');
  return value;
}

function assertOperatorHardCaps(configuration) {
  for (const [field, ceiling] of Object.entries(OPERATOR_HARD_CAPS)) {
    if (BigInt(configuration[field]) > BigInt(ceiling)) {
      throw new Error(`operator configuration ${field} exceeds the fixed hard cap`);
    }
  }
  return configuration;
}

function assertOperatorState(value) {
  exactObject(value, stateFields, 'operator state');
  if (value.schema !== STATE_SCHEMA) throw new Error('operator state schema is invalid');
  const configuration = value.configuration === null ? null : assertOperatorHardCaps(assertOperatorConfiguration(value.configuration));
  return deepFreeze({
    schema: STATE_SCHEMA,
    revision: assertRevision(value.revision),
    configuration,
  });
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isLegacyEmptyValue(value) {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, child]) => (
    key === 'schema' && typeof child === 'string'
  ) || isLegacyEmptyValue(child));
}

function migrateLegacyState(value) {
  if (!isPlainObject(value) || value.schema !== 'hookemon.operator-state.v1') {
    throw new Error('operator state schema is invalid');
  }
  const revision = assertRevision(value.revision);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'schema' || key === 'revision' || key === 'configuration') continue;
    if (!isLegacyEmptyValue(entry)) throw new Error('legacy operator state contains nonempty cycle records');
  }
  const migration = migrateOperatorConfiguration(value.configuration);
  return Object.freeze({
    state: assertOperatorState({ schema: STATE_SCHEMA, revision, configuration: migration.configuration }),
    migrated: true,
  });
}

function parseExistingState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('operator state file contains corrupt JSON');
  }
  let expected;
  try {
    expected = `${canonicalJson(parsed)}\n`;
  } catch {
    throw new Error('operator state file is not canonical JSON');
  }
  if (text !== expected) throw new Error('operator state file bytes are not canonical JSON plus one newline');

  if (parsed?.schema === 'hookemon.operator-state.v1') return migrateLegacyState(parsed);

  const migration = migrateOperatorConfiguration(parsed?.configuration);
  return Object.freeze({
    state: assertOperatorState({ ...parsed, configuration: migration.configuration }),
    migrated: migration.migrated,
  });
}

function assertAbsolutePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('operator state path must be absolute');
}

async function stableRegularFile(path, label) {
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
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino || opened.dev !== after.dev || opened.ino !== after.ino) throw new Error(`${label} changed while opening`);
    if ((opened.mode & 0o777) !== 0o600 || (after.mode & 0o777) !== 0o600) throw new Error(`${label} mode must be 0600`);
    if (opened.size > maximumStateBytes) throw new Error(`${label} exceeds the byte limit`);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function readExistingStateRecord(path, { allowMissing = false } = {}) {
  const text = await stableRegularFile(path, 'operator state file');
  if (text === null) {
    if (allowMissing) return null;
    throw new Error('operator state file does not exist');
  }
  return parseExistingState(text);
}

async function readExistingState(path, options = {}) {
  const record = await readExistingStateRecord(path, options);
  return record === null ? null : record.state;
}

function lockOwnerBytes(pid, token) {
  return `${canonicalJson({ pid, token })}\n`;
}

function assertLockOwner(text) {
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    throw new Error('operator state lock owner is not canonical JSON');
  }
  exactObject(owner, lockOwnerFields, 'operator state lock owner');
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('operator state lock owner PID is invalid');
  if (typeof owner.token !== 'string' || !lockTokenPattern.test(owner.token)) throw new Error('operator state lock owner token is invalid');
  if (text !== lockOwnerBytes(owner.pid, owner.token)) throw new Error('operator state lock owner bytes are not canonical JSON plus one newline');
  return owner;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readStableLockOwner(lockPath) {
  let before;
  try {
    before = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error('operator state lock file must not be a symlink');
  if (!before.isFile()) throw new Error('operator state lock file must be a regular file');
  if ((before.mode & 0o777) !== 0o600) throw new Error('operator state lock file mode must be 0600');
  const handle = await open(lockPath, 'r');
  try {
    const opened = await handle.stat();
    const afterOpen = await lstat(lockPath);
    if (
      !afterOpen.isFile()
      || afterOpen.isSymbolicLink()
      || !sameFile(before, opened)
      || !sameFile(opened, afterOpen)
    ) throw new Error('operator state lock file changed while opening');
    if ((opened.mode & 0o777) !== 0o600 || (afterOpen.mode & 0o777) !== 0o600) throw new Error('operator state lock file mode must be 0600');
    if (opened.size > maximumLockBytes) throw new Error('operator state lock file exceeds the byte limit');
    const contents = await handle.readFile({ encoding: 'utf8' });
    const afterRead = await lstat(lockPath);
    if (
      !afterRead.isFile()
      || afterRead.isSymbolicLink()
      || !sameFile(opened, afterRead)
      || (afterRead.mode & 0o777) !== 0o600
    ) throw new Error('operator state lock file changed while reading');
    return { contents, identity: opened, owner: assertLockOwner(contents) };
  } finally {
    await handle.close();
  }
}

function processDefinitelyDoesNotExist(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

async function removeStaleLock(lockPath) {
  const lock = await readStableLockOwner(lockPath);
  if (lock === null) return;
  if (!processDefinitelyDoesNotExist(lock.owner.pid)) throw new Error('operator state lock contention');
  let current;
  try {
    current = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || (current.mode & 0o777) !== 0o600
    || !sameFile(current, lock.identity)
  ) throw new Error('operator state lock changed before stale removal');
  await unlink(lockPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
}

async function acquireOperatorLock(lockPath) {
  try {
    return await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  try {
    await removeStaleLock(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    return await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('operator state lock contention');
    throw error;
  }
}

async function removeOwnedLock(lockPath, expectedContents, expectedIdentity) {
  if (!expectedIdentity) return;
  let lock;
  try {
    lock = await readStableLockOwner(lockPath);
  } catch {
    return;
  }
  if (lock === null || lock.contents !== expectedContents || !sameFile(lock.identity, expectedIdentity)) return;
  let current;
  try {
    current = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o777) !== 0o600 || !sameFile(current, expectedIdentity)) return;
  await unlink(lockPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
}

export function createEmptyOperatorState() {
  return deepFreeze({
    schema: STATE_SCHEMA,
    revision: 0,
    configuration: null,
  });
}

export async function readOperatorState(path) {
  assertAbsolutePath(path);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await readExistingStateRecord(path);
    if (!record.migrated) return record.state;
    try {
      return await mutateOperatorState(path, record.state.revision, () => record.state);
    } catch (error) {
      if ((error?.message === 'stale operator state revision' || error?.message === 'operator state lock contention') && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('operator state configuration migration retry loop was exhausted');
}

export async function mutateOperatorState(path, expectedRevision, mutation) {
  assertAbsolutePath(path);
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) throw new Error('expected operator state revision is invalid');
  if (typeof mutation !== 'function') throw new Error('operator state mutation must be a function');
  const lockPath = `${path}.lock`;
  const token = globalThis.crypto.randomUUID();
  const ownerBytes = lockOwnerBytes(process.pid, token);
  let lockHandle;
  let lockIdentity = null;
  let temporaryHandle;
  let temporaryPath = null;
  try {
    lockHandle = await acquireOperatorLock(lockPath);
    await lockHandle.chmod(0o600);
    await lockHandle.writeFile(ownerBytes, { encoding: 'utf8' });
    await lockHandle.sync();
    lockIdentity = await lockHandle.stat();
    await lockHandle.close();
    lockHandle = null;

    const current = await readExistingState(path, { allowMissing: true });
    if (current === null ? expectedRevision !== null : expectedRevision !== current.revision) throw new Error('stale operator state revision');
    const proposed = await mutation(current);
    const nextRevision = current === null ? 0 : current.revision + 1;
    const candidate = assertOperatorState({ ...proposed, revision: nextRevision });
    const bytes = `${canonicalJson(candidate)}\n`;

    const directory = dirname(path);
    temporaryPath = join(directory, `.${basename(path)}.tmp-${token}`);
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.writeFile(bytes, { encoding: 'utf8' });
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await rename(temporaryPath, path);
    temporaryPath = null;
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return candidate;
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => {});
    if (temporaryPath) await unlink(temporaryPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    if (lockHandle) await lockHandle.close().catch(() => {});
    await removeOwnedLock(lockPath, ownerBytes, lockIdentity);
  }
}
