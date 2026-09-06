import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { jcsBytes } from './jcs.mjs';
import { keccak256Hex } from './keccak.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const SOURCE_BUNDLE_PREFIX = Buffer.from('programmable.source-bundle.v2', 'utf8');
const MAX_GIT_BLOB_BYTES = 32 * 1024 * 1024;

function fail(message, path) {
  throw new TypeError(`${message}: ${path}`);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertRepositoryRelativePosixPath(inputPath, label) {
  if (typeof inputPath !== 'string' || inputPath.length === 0
    || inputPath.includes('\\') || inputPath.includes('\0') || inputPath.startsWith('/')
    || inputPath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('source bundle paths must be nonempty repository-relative POSIX paths', label);
  }
  return inputPath;
}

function assertNoSymlinkPathComponents(root, inputPath) {
  let current = resolve(root);
  for (const part of inputPath.split('/')) {
    current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail('listed source bundle path is missing', inputPath);
    }
    if (stat.isSymbolicLink()) fail('source bundle paths cannot be symlinks', inputPath);
  }
}

function pathFromRoot(root, inputPath) {
  assertRepositoryRelativePosixPath(inputPath, String(inputPath));

  const absolutePath = resolve(root, inputPath);
  const relativePath = relative(root, absolutePath);
  if (isAbsolute(relativePath) || relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    fail('source bundle path escapes the repository root', inputPath);
  }
  assertNoSymlinkPathComponents(root, inputPath);
  return {
    absolutePath,
    path: relativePath.split(sep).join('/'),
  };
}

function entryForFile(absolutePath, path) {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    fail('listed source bundle path is missing', path);
  }
  if (stat.isSymbolicLink()) fail('source bundle paths cannot be symlinks', path);
  if (!stat.isFile()) fail('source bundle entry is not a regular file', path);
  if ((stat.mode & 0o777) !== 0o644) fail('source bundle entries must have mode 100644', path);

  const contents = readFileSync(absolutePath);
  return entryForBytes(path, contents);
}

function entryForBytes(path, contents) {
  return {
    path,
    kind: 'file',
    mode: '100644',
    byteLength: String(contents.length),
    contentSha256: sha256(contents),
    symlinkTarget: null,
  };
}

function collectPath(root, inputPath, entries) {
  const { absolutePath, path } = pathFromRoot(root, inputPath);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    fail('listed source bundle path is missing', path);
  }
  if (stat.isSymbolicLink()) fail('source bundle paths cannot be symlinks', path);

  if (stat.isFile()) {
    entries.set(path, entryForFile(absolutePath, path));
    return;
  }
  if (!stat.isDirectory()) fail('source bundle entry is not a regular file or directory', path);

  for (const name of readdirSync(absolutePath, { encoding: 'utf8' })) {
    collectPath(root, `${path}/${name}`, entries);
  }
}

function requirePathList(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an explicit list`, name);
  return value;
}

function resolveCommit(root, sourceCommit) {
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    fail('source bundle sourceCommit must be a lowercase 40-hex Git commit', 'sourceCommit');
  }
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${sourceCommit}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('source bundle sourceCommit cannot be resolved', sourceCommit);
  }
}

function gitTreeEntries(root, commit, inputPath) {
  assertRepositoryRelativePosixPath(inputPath, inputPath);
  let output;
  try {
    output = execFileSync('git', ['-C', root, '--literal-pathspecs', 'ls-tree', '-r', '-z', commit, '--', inputPath], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    fail('listed source bundle path is missing', inputPath);
  }
  if (output.length === 0) fail('listed source bundle path is missing', inputPath);
  const text = output.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(output)) fail('source bundle Git tree paths must be valid UTF-8', inputPath);
  return text.split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    if (tab === -1) fail('source bundle Git tree entry is malformed', inputPath);
    const [mode, type, objectId] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    assertRepositoryRelativePosixPath(path, path);
    if (type !== 'blob') fail('source bundle entry is not a regular file', path);
    if (mode === '120000') fail('source bundle paths cannot be symlinks', path);
    if (mode !== '100644') fail('source bundle entries must have mode 100644', path);
    if (!/^[0-9a-f]{40,64}$/u.test(objectId)) fail('source bundle Git object ID is malformed', path);
    return { path, objectId };
  });
}

function collectGitPath(root, commit, inputPath, entries) {
  for (const { path, objectId } of gitTreeEntries(root, commit, inputPath)) {
    let contents;
    try {
      contents = execFileSync('git', ['-C', root, 'cat-file', 'blob', objectId], {
        encoding: 'buffer',
        maxBuffer: MAX_GIT_BLOB_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      fail('source bundle Git blob cannot be read', path);
    }
    entries.set(path, entryForBytes(path, contents));
  }
}

function assertManifestEntry(entry, index) {
  const path = `/entries/${index}`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('source bundle entry must be an object', path);
  const expectedKeys = ['path', 'kind', 'mode', 'byteLength', 'contentSha256', 'symlinkTarget'];
  for (const key of expectedKeys) if (!Object.hasOwn(entry, key)) fail('source bundle entry is missing a field', `${path}/${key}`);
  for (const key of Object.keys(entry)) if (!expectedKeys.includes(key)) fail('source bundle entry has an unexpected field', `${path}/${key}`);
  try {
    assertRepositoryRelativePosixPath(entry.path, `${path}/path`);
  } catch {
    fail('source bundle entry path must be repository-relative POSIX', `${path}/path`);
  }
  if (entry.kind !== 'file') fail('source bundle entry kind must be file', `${path}/kind`);
  if (entry.mode !== '100644') fail('source bundle entry mode must be 100644', `${path}/mode`);
  if (typeof entry.byteLength !== 'string' || !INTEGER.test(entry.byteLength)) {
    fail('source bundle entry byteLength must use integer strings', `${path}/byteLength`);
  }
  if (typeof entry.contentSha256 !== 'string' || !SHA256.test(entry.contentSha256)) {
    fail('source bundle entry contentSha256 must be a sha256 digest', `${path}/contentSha256`);
  }
  if (entry.symlinkTarget !== null) fail('source bundle entry symlinkTarget must be null', `${path}/symlinkTarget`);
}

function assertNoFloats(value, path = '$') {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) fail('source bundle manifests cannot contain floating-point values', path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFloats(item, `${path}/${index}`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertNoFloats(item, `${path}/${key}`);
  }
}

export function assertSourceBundleManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('source bundle manifest must be an object', '$');
  if (manifest.schemaVersion !== '2.0.0') fail('source bundle manifest schemaVersion must be 2.0.0', '/schemaVersion');
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) fail('source bundle manifest entries must be nonempty', '/entries');
  if (Object.keys(manifest).length !== 2 || !Object.hasOwn(manifest, 'schemaVersion') || !Object.hasOwn(manifest, 'entries')) {
    fail('source bundle manifest has unexpected fields', '$');
  }

  const paths = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    assertManifestEntry(entry, index);
    if (paths.has(entry.path)) fail('source bundle manifest paths must be unique', `/entries/${index}/path`);
    paths.add(entry.path);
    if (index > 0 && Buffer.compare(Buffer.from(manifest.entries[index - 1].path, 'utf8'), Buffer.from(entry.path, 'utf8')) > 0) {
      fail('source bundle manifest entries must be sorted by UTF-8 path bytes', `/entries/${index}/path`);
    }
  }
  assertNoFloats(manifest);
  return manifest;
}

export function buildSourceBundleManifest({
  root,
  sourcePaths,
  standardJsonInputPaths,
  compilerArtifactPaths,
  attestationEvidencePaths,
  metadataImagePath,
  sourceCommit,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) fail('source bundle root must be a path', 'root');
  if (typeof metadataImagePath !== 'string' || metadataImagePath.length === 0) {
    fail('metadataImagePath must be an explicit repository-relative path', 'metadataImagePath');
  }

  const entries = new Map();
  const paths = [
    ...requirePathList(sourcePaths, 'sourcePaths'),
    ...requirePathList(standardJsonInputPaths, 'standardJsonInputPaths'),
    ...requirePathList(compilerArtifactPaths, 'compilerArtifactPaths'),
    ...requirePathList(attestationEvidencePaths, 'attestationEvidencePaths'),
    metadataImagePath,
  ];
  if (sourceCommit === undefined) {
    for (const path of paths) collectPath(root, path, entries);
  } else {
    const commit = resolveCommit(root, sourceCommit);
    for (const path of paths) collectGitPath(root, commit, path, entries);
  }

  const manifest = {
    schemaVersion: '2.0.0',
    entries: [...entries.values()].sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))),
  };
  return assertSourceBundleManifest(manifest);
}

export function sourceBundleContentSha256(manifest) {
  return sha256(jcsBytes(assertSourceBundleManifest(manifest)));
}

export function sourceBundleDigest(manifest) {
  const bytes = jcsBytes(assertSourceBundleManifest(manifest));
  return keccak256Hex(Buffer.concat([SOURCE_BUNDLE_PREFIX, Buffer.of(0), bytes]));
}

/**
 * Rechecks every manifest entry against the exact Git commit named in the
 * public provenance fields. Production manifests are enumerated from that
 * tree, so edited or deleted worktree files cannot change the digest.
 */
export function assertSourceBundleMatchesCommit({ root, sourceCommit, manifest } = {}) {
  if (typeof root !== 'string' || root.length === 0) fail('source bundle root must be a path', 'root');
  assertSourceBundleManifest(manifest);
  const commit = resolveCommit(root, sourceCommit);
  for (const entry of manifest.entries) {
    let treeEntry;
    try {
      treeEntry = execFileSync('git', ['-C', root, '--literal-pathspecs', 'ls-tree', '-z', commit, '--', entry.path], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString('utf8');
    } catch {
      fail('source bundle entry is absent from the claimed source commit', entry.path);
    }
    if (!/^100644 blob [0-9a-f]+\t/u.test(treeEntry)) {
      fail('source bundle entry mode does not match the claimed source commit', entry.path);
    }
    let bytes;
    try {
      bytes = execFileSync('git', ['-C', root, 'show', `${commit}:${entry.path}`], {
        encoding: 'buffer',
        maxBuffer: MAX_GIT_BLOB_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      fail('source bundle entry is absent from the claimed source commit', entry.path);
    }
    if (String(bytes.length) !== entry.byteLength || sha256(bytes) !== entry.contentSha256) {
      fail('source bundle entry does not match the claimed source commit', entry.path);
    }
  }
  return manifest;
}

function validatePublicSource(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) fail('public source must be an object', 'source');
  const keys = ['repositoryUrl', 'sourceCommit', 'sourceTree'];
  for (const key of keys) if (!Object.hasOwn(source, key)) fail('public source is missing a field', `source/${key}`);
  for (const key of Object.keys(source)) if (!keys.includes(key)) fail('public source has an unexpected field', `source/${key}`);
  for (const key of keys) {
    if (typeof source[key] !== 'string' || source[key].length === 0) fail('public source fields must be nonempty strings', `source/${key}`);
  }
  for (const key of ['sourceCommit', 'sourceTree']) {
    if (!/^[0-9a-f]{40}$/u.test(source[key])) fail('public source commit and tree must be lowercase 40-hex IDs', `source/${key}`);
  }
  return source;
}

export function sourcePublicOriginCommitment(source) {
  return keccak256Hex(jcsBytes(validatePublicSource(source)));
}

export function buildSourceBundleDescriptor({
  manifest,
  controllerWallet,
  sourceLineageNonce = '1',
  source,
} = {}) {
  assertSourceBundleManifest(manifest);
  if (typeof controllerWallet !== 'string' || !ADDRESS.test(controllerWallet)) {
    fail('source descriptor controllerWallet must be an EVM address', 'controllerWallet');
  }
  if (typeof sourceLineageNonce !== 'string' || !INTEGER.test(sourceLineageNonce)) {
    fail('source descriptor sourceLineageNonce must be an integer string', 'sourceLineageNonce');
  }
  return {
    schemaVersion: '2.0.0',
    kind: 'deterministic-source-bundle',
    controllerWallet,
    sourceLineageNonce,
    sourceBundleDigest: sourceBundleDigest(manifest),
    bundleContentSha256: sourceBundleContentSha256(manifest),
    publicOriginCommitment: sourcePublicOriginCommitment(source),
  };
}
