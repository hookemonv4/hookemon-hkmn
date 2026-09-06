import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { jcsBytes, jcsCanonicalize } from './jcs.mjs';

const ATTEMPT_SCHEMA_VERSION = 'hookemon.programmable-launch-attempt.v1';
const NONCE = /^0x[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;
const RECORD_MODE = 0o600;

function fail(message) {
  throw new Error(`invalid V4 launch attempt: ${message}`);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}.${key} is not allowed`);
}

function validateSource(source) {
  requireExactKeys(source, ['repositoryUrl', 'sourceCommit', 'sourceTree'], 'source');
  for (const field of ['repositoryUrl', 'sourceCommit', 'sourceTree']) {
    if (typeof source[field] !== 'string' || source[field].length === 0) fail(`source.${field} must be a nonempty string`);
  }
  let repositoryUrl;
  try {
    repositoryUrl = new URL(source.repositoryUrl);
  } catch {
    fail('source.repositoryUrl must be a URL');
  }
  if (repositoryUrl.protocol !== 'https:' || repositoryUrl.username || repositoryUrl.password || repositoryUrl.search || repositoryUrl.hash) {
    fail('source.repositoryUrl must be a public HTTPS URL without credentials');
  }
  for (const field of ['sourceCommit', 'sourceTree']) {
    if (!GIT_OBJECT_ID.test(source[field])) fail(`source.${field} must be a lowercase 40-hex object ID`);
  }
  return source;
}

function validateNonce(value) {
  if (typeof value !== 'string' || !NONCE.test(value)) fail('nonce must be 0x plus 64 lowercase hex characters');
  if (/^0x0{64}$/.test(value)) fail('nonce cannot be all-zero');
  return value;
}

function idempotencyFrom(providerDocuments) {
  const header = providerDocuments?.v4RequestContract?.idempotencyHeader;
  if (header === undefined || header === null) {
    return {
      headerName: null,
      key: null,
      reason: 'no idempotency header is defined by the recorded V4 contract',
    };
  }
  fail('the recorded V4 contract defines an idempotency header without a documented key recipe');
}

function validateIdempotency(value) {
  requireExactKeys(value, ['headerName', 'key', 'reason'], 'idempotency');
  if (value.headerName !== null || value.key !== null
    || value.reason !== 'no idempotency header is defined by the recorded V4 contract') {
    fail('idempotency must record the documented V4 header state');
  }
  return value;
}

function validateRequestRecord(value) {
  requireExactKeys(value, ['encoding', 'sha256', 'base64'], 'request');
  if (value.encoding !== 'base64') fail('request.encoding must be base64');
  if (typeof value.base64 !== 'string' || value.base64.length === 0) fail('request.base64 must be a nonempty string');
  const bytes = Buffer.from(value.base64, 'base64');
  if (bytes.toString('base64') !== value.base64) fail('request.base64 is not canonical base64');
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) fail('request.sha256 must be a sha256 digest');
  if (sha256(bytes) !== value.sha256) fail('request.sha256 does not match request.base64');
  return bytes;
}

function validateRequestBinding(record) {
  const bytes = validateRequestRecord(record.request);
  const text = bytes.toString('utf8');
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    fail('request bytes must contain JSON');
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    fail('request bytes must contain a JSON object');
  }
  let canonical;
  try {
    canonical = jcsBytes(request);
  } catch {
    fail('request bytes must use RFC 8785 canonical JSON');
  }
  if (!canonical.equals(bytes)) fail('request bytes must use RFC 8785 canonical JSON');
  if (request.nonce !== record.nonce) fail('request nonce does not match the persisted launch-attempt nonce');
  return bytes;
}

function validateRecord(record) {
  requireExactKeys(record, ['schemaVersion', 'createdAt', 'source', 'nonce', 'idempotency', 'request'], 'record');
  if (record.schemaVersion !== ATTEMPT_SCHEMA_VERSION) fail('schemaVersion is not supported');
  if (typeof record.createdAt !== 'string' || Number.isNaN(new Date(record.createdAt).getTime())) fail('createdAt must be an ISO timestamp');
  validateSource(record.source);
  validateNonce(record.nonce);
  validateIdempotency(record.idempotency);
  validateRequestBinding(record);
  return record;
}

function canonicalStorageDirectory(path) {
  let current = resolve(path);
  const missing = [];
  while (true) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(`cannot inspect ${path}`);
      const parent = dirname(current);
      if (parent === current) fail(`cannot resolve ${path}`);
      missing.unshift(basename(current));
      current = parent;
      continue;
    }
    let canonical;
    try {
      canonical = realpathSync(current);
    } catch {
      fail(`cannot resolve ${path}`);
    }
    if (!lstatSync(canonical).isDirectory()) fail(`launch attempt storage parent must be a directory: ${current}`);
    return resolve(canonical, ...missing);
  }
}

export function assertV4LaunchAttemptStoragePath(path) {
  if (typeof path !== 'string' || path.length === 0) fail('path must be a nonempty string');
  const absolutePath = resolve(path);
  const leaf = basename(absolutePath);
  if (leaf.length === 0) fail('path must name a file or directory below the filesystem root');
  const parent = canonicalStorageDirectory(dirname(absolutePath));
  const outputPath = resolve(parent, leaf);
  if (relative(parent, outputPath) === '' || relative(parent, outputPath).startsWith('..')) {
    fail(`launch attempt storage path escapes its canonical parent: ${path}`);
  }
  try {
    if (lstatSync(outputPath).isSymbolicLink()) fail(`launch attempt record cannot be a symlink: ${outputPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return outputPath;
}

function existingRecord(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail(`cannot inspect ${path}`);
  }
  if (stat.isSymbolicLink()) fail(`launch attempt record cannot be a symlink: ${path}`);
  if (!stat.isFile()) fail(`launch attempt record must be a regular file: ${path}`);
  if ((stat.mode & 0o777) !== RECORD_MODE) fail(`launch attempt record permissions must be 0600: ${path}`);
  return true;
}

function readSecureRecord(path) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail(`cannot read ${path}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail(`launch attempt record must be a regular file: ${path}`);
    if ((stat.mode & 0o777) !== RECORD_MODE) fail(`launch attempt record permissions must be 0600: ${path}`);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function defaultV4LaunchAttemptPath() {
  return resolve(homedir(), '.hookemon', 'programmable', 'launch-attempt.json');
}

export function generateV4LaunchNonce({ randomBytes = cryptoRandomBytes } = {}) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('randomBytes must return 32 bytes');
  if (bytes.length !== 32) fail('randomBytes must return 32 bytes');
  const nonce = `0x${Buffer.from(bytes).toString('hex')}`;
  return validateNonce(nonce);
}

export function launchAttemptRequestBytes(record) {
  validateRecord(record);
  return validateRequestRecord(record.request);
}

export function readV4LaunchAttempt(path = defaultV4LaunchAttemptPath()) {
  const outputPath = assertV4LaunchAttemptStoragePath(path);
  if (!existingRecord(outputPath)) fail(`cannot read ${outputPath}`);
  let record;
  try {
    record = JSON.parse(readSecureRecord(outputPath));
  } catch {
    fail(`cannot read ${outputPath}`);
  }
  return validateRecord(record);
}

export function assertLaunchAttemptSource(record, source) {
  validateRecord(record);
  validateSource(source);
  if (record.source.repositoryUrl !== source.repositoryUrl
    || record.source.sourceCommit !== source.sourceCommit
    || record.source.sourceTree !== source.sourceTree) {
    fail('source flags do not match the persisted launch attempt');
  }
  return record;
}

export function createV4LaunchAttempt({
  path = defaultV4LaunchAttemptPath(),
  source,
  request,
  providerDocuments,
  newLaunchAttempt = false,
  nonce,
  randomBytes = cryptoRandomBytes,
  now = () => new Date(),
  validateStoragePath = (candidate) => candidate,
} = {}) {
  if (typeof path !== 'string' || path.length === 0) fail('path must be a nonempty string');
  validateSource(source);
  if (request === null || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
  if (typeof newLaunchAttempt !== 'boolean') fail('newLaunchAttempt must be a boolean');
  if (typeof validateStoragePath !== 'function') fail('validateStoragePath must be a function');

  const outputPath = assertV4LaunchAttemptStoragePath(path);
  const exists = existingRecord(outputPath);
  if (exists) fail(`${outputPath} already exists; choose a new launch-attempt path`);
  if (!exists && !newLaunchAttempt) {
    fail(`${outputPath} does not exist; use --new-launch-attempt to create a new attempt`);
  }
  const timestamp = now();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) fail('now must return a valid Date');
  const requestBytes = jcsBytes(request);
  const record = {
    schemaVersion: ATTEMPT_SCHEMA_VERSION,
    createdAt: timestamp.toISOString(),
    source: { ...source },
    nonce: nonce === undefined ? generateV4LaunchNonce({ randomBytes }) : validateNonce(nonce),
    idempotency: idempotencyFrom(providerDocuments),
    request: {
      encoding: 'base64',
      sha256: sha256(requestBytes),
      base64: requestBytes.toString('base64'),
    },
  };
  validateRecord(record);

  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const checkedDirectory = assertV4LaunchAttemptStoragePath(outputDirectory);
  const checkedPath = assertV4LaunchAttemptStoragePath(resolve(checkedDirectory, basename(outputPath)));
  const finalPath = validateStoragePath(checkedPath);
  if (typeof finalPath !== 'string' || finalPath.length === 0) fail('validateStoragePath must return a path');
  let descriptor;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    descriptor = openSync(finalPath, flags, RECORD_MODE);
  } catch {
    fail(`cannot write ${finalPath}`);
  }
  try {
    fchmodSync(descriptor, RECORD_MODE);
    writeFileSync(descriptor, `${jcsCanonicalize(record)}\n`, { encoding: 'utf8' });
  } finally {
    closeSync(descriptor);
  }
  return record;
}
