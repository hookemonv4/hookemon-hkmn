import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareTaskBindingRecovery } from './task-binding-recovery.mjs';
import { readOwnerApproval } from './gates.mjs';
import { resolveReceiptInput } from './receipts.mjs';
import { hashFile, readJson, sha256 } from './util.mjs';

export const HISTORICAL_USDG_SOURCES = Object.freeze({
  'PR38-EVIDENCE-CLEANUP': '34fc4006e3f05a60d6a3cd9fc8383b445330aa62',
  'PR38-PUBLIC-HASH-REDACTION': 'e142bfa101f87c80b121e9c558b2a681f9ee07dd',
});
// Reviewed archival content, not a configurable import source or patch-equivalence exception.
export const HISTORICAL_USDG_ARCHIVE = 'c797b6c0a9c856752d05ee2ddd18dd2411571d6f';
const SOURCE = HISTORICAL_USDG_SOURCES['PR38-PUBLIC-HASH-REDACTION'];
const CLEANUP = HISTORICAL_USDG_SOURCES['PR38-EVIDENCE-CLEANUP'];
const PREFIX = 'release/launch-preparation-20260907/';
const ARCHIVE = 'docs/evidence/usdg-launch-preparation-20260907/';
const CARD = 'docs/modules/launch-preparation.md';
const ACTION = 'TASK_ARCHIVE_HISTORICAL_USDG_COMPLETION';
const NORMALIZED = new Map([
  ['evidence/normalization.json', 'documents-public-dependency-digest-redaction'],
  ['evidence/provider-capabilities-resume.json', 'public-dependency-digest-redacted'],
  ['integrity.json', 'recomputed-normalization-and-provider-inventory'],
]);
const digest = value => sha256(Buffer.from(JSON.stringify(value)));
function git(root, ...args) {
  try {
    return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
      maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new Error(`historical archive Git verification failed (${args[0]})`); }
}
function assertCommit(root, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')
      || git(root, 'cat-file', '-t', commit).toString().trim() !== 'commit') throw new Error('historical archive requires exact commit objects');
}
function entry(root, commit, path) {
  const line = git(root, 'ls-tree', commit, '--', path).toString().trim();
  const match = /^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
  if (!match || match[3] !== path) throw new Error(`historical archive missing regular 100644 blob: ${path}`);
  const bytes = git(root, 'cat-file', 'blob', match[2]);
  return { path, mode: match[1], blob: match[2], sha256: sha256(bytes), byteLength: bytes.length };
}
function assertAbsent(root, target, path) {
  if (git(root, 'ls-tree', target, '--', path).length) throw new Error(`historical active guidance must remain absent: ${path}`);
}
function fullDiff(root, source) {
  const parents = git(root, 'rev-list', '--parents', '-n', '1', source).toString().trim().split(' ');
  if (parents.length !== 2) throw new Error('historical source must have exactly one parent');
  return git(root, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', source).toString().trim().split('\n').sort();
}

function verifyNormalizationSemantics(root) {
  const json = (commit, path) => JSON.parse(git(root, 'show', `${commit}:${PREFIX}${path}`));
  const resume = json(CLEANUP, 'evidence/provider-capabilities-resume.json');
  resume.context.chainDeployment.publicSource.sourceHashes['lib/v4-core/src/types/PoolKey.sol'] = '[redacted-source-digest]';
  if (digest(resume) !== digest(json(SOURCE, 'evidence/provider-capabilities-resume.json'))) throw new Error('historical provider redaction semantics mismatch');
  const normalization = json(CLEANUP, 'evidence/normalization.json');
  normalization.operations.push('One public dependency source digest is redacted because the secret scanner treats its field name and value as a credential. The exact original digest remains in the original snapshot bound above.');
  if (digest(normalization) !== digest(json(SOURCE, 'evidence/normalization.json'))) throw new Error('historical normalization explanation mismatch');
  const integrity = json(CLEANUP, 'integrity.json');
  for (const file of integrity.files) {
    if (['evidence/provider-capabilities-resume.json', 'evidence/normalization.json'].includes(file.path)) {
      const current = entry(root, SOURCE, PREFIX + file.path);
      file.byteLength = current.byteLength;
      file.sha256 = current.sha256;
    }
  }
  if (digest(integrity) !== digest(json(SOURCE, 'integrity.json'))) throw new Error('historical integrity normalization mismatch');
}

export function prepareHistoricalUsdgArchive(db, taskId) {
  if (!Object.hasOwn(HISTORICAL_USDG_SOURCES, taskId)) throw new Error('historical archive route is limited to the two PR38 tasks');
  const current = prepareTaskBindingRecovery(db, taskId);
  if (current.prestate.status !== 'done'
      || current.prestate.completion?.commitSha !== HISTORICAL_USDG_SOURCES[taskId]) throw new Error('historical source completion does not match task');
  return current;
}

// Each changed source path receives one exact counterpart or one pinned later-normalized
// counterpart. The complete original commit remains authenticated; no source path is omitted.
export function historicalUsdgArchiveInventory(root, taskId, target) {
  if (git(root, 'for-each-ref', '--format=%(refname)', 'refs/replace/').length) throw new Error('historical archive refuses replacement refs');
  const source = HISTORICAL_USDG_SOURCES[taskId];
  if (!source) throw new Error('historical archive route is limited to the two PR38 tasks');
  for (const commit of [SOURCE, CLEANUP, HISTORICAL_USDG_ARCHIVE, target]) assertCommit(root, commit);
  git(root, 'merge-base', '--is-ancestor', target, 'HEAD');
  verifyNormalizationSemantics(root);
  if (!git(root, 'ls-tree', target, '--', ARCHIVE.slice(0, -1)).equals(git(root, 'ls-tree', HISTORICAL_USDG_ARCHIVE, '--', ARCHIVE.slice(0, -1)))) throw new Error('historical archive target differs from the complete pinned archive tree');
  const manifestPath = `${ARCHIVE}manifest.json`;
  const manifestEntry = entry(root, HISTORICAL_USDG_ARCHIVE, manifestPath);
  const manifest = JSON.parse(git(root, 'cat-file', 'blob', manifestEntry.blob));
  if (manifest.sourceCommit !== SOURCE || manifest.cleanupCommit !== CLEANUP
      || manifest.files.length !== 24) throw new Error('historical manifest source identity mismatch');
  const targets = [...manifest.files.map(file => file.archivePath), `${ARCHIVE}historical-module-card.md`, manifestPath, `${ARCHIVE}README.md`].sort();
  const archiveFiles = targets.map(path => {
    const pinned = entry(root, HISTORICAL_USDG_ARCHIVE, path);
    if (digest(entry(root, target, path)) !== digest(pinned)) throw new Error(`historical archive target differs: ${path}`);
    return pinned;
  });
  assertAbsent(root, target, PREFIX.slice(0, -1));
  assertAbsent(root, target, CARD);
  const paths = fullDiff(root, source);
  const expected = source === SOURCE
    ? [...manifest.files.map(file => file.sourcePath), CARD].sort()
    : ['README.md', 'evidence/ci-bytecode-evidence.json', 'evidence/normalization.json', 'evidence/provider-capabilities-resume.json', 'evidence/provider-guide.md', 'integrity.json', 'projectMetadata.candidate.json', 'projectMetadataImageArtifact.candidate.json'].map(path => PREFIX + path).sort();
  if (digest(paths) !== digest(expected)) throw new Error('historical source full diff partition mismatch');
  // Validate every manifest claim independently against source blobs, including unchanged files.
  for (const file of manifest.files) {
    const original = entry(root, SOURCE, file.sourcePath);
    const cleanup = entry(root, CLEANUP, file.sourcePath);
    const archived = entry(root, target, file.archivePath);
    if (file.archivePath !== ARCHIVE + 'historical-package/' + file.sourcePath.slice(PREFIX.length)
        || original.blob !== file.sourceBlob || original.sha256 !== file.sha256
        || original.byteLength !== file.byteLength || archived.blob !== original.blob
        || cleanup.blob !== file.cleanupBlob || cleanup.sha256 !== file.cleanupSha256
        || file.matchesCleanup !== (cleanup.blob === original.blob)) throw new Error('historical manifest blob claim mismatch');
  }
  const card = entry(root, SOURCE, CARD);
  if (digest(manifest.supportingArtifacts) !== digest([{ sourcePath: CARD, archivePath: `${ARCHIVE}historical-module-card.md`, sourceBlob: card.blob, byteLength: card.byteLength, sha256: card.sha256, status: 'HISTORICAL_NOT_REGISTERED_AS_ACTIVE_MODULE' }])) throw new Error('historical supporting artifact mismatch');
  if (entry(root, target, `${ARCHIVE}historical-module-card.md`).blob !== card.blob) throw new Error('historical module card mismatch');
  const partition = paths.map(path => {
    const original = entry(root, source, path);
    const archivePath = path === CARD ? `${ARCHIVE}historical-module-card.md` : ARCHIVE + 'historical-package/' + path.slice(PREFIX.length);
    const archived = entry(root, target, archivePath);
    const normalization = source === CLEANUP ? NORMALIZED.get(path.slice(PREFIX.length)) : undefined;
    if (!normalization && original.blob !== archived.blob) throw new Error('historical exact counterpart mismatch');
    if (normalization && original.blob === archived.blob) throw new Error('historical normalized counterpart must retain its distinct source');
    return { source: original, archive: archived, disposition: normalization ? 'pinned-later-normalized-counterpart' : 'exact-archived-counterpart', ...(normalization ? { normalization, counterpartCommit: SOURCE } : {}) };
  });
  return { archiveCommit: HISTORICAL_USDG_ARCHIVE, sourceCommit: source, target, manifest: manifestEntry, archiveFiles, partition };
}

export function validateHistoricalUsdgArchive(root, db, taskId, { record, approval }) {
  const current = prepareHistoricalUsdgArchive(db, taskId);
  if (record !== `decisions/task-archives/${taskId}.json`) throw new Error('historical archive descriptor path mismatch');
  const path = resolve(realpathSync(root), record);
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('historical descriptor must be a regular file without symlinks');
  resolveReceiptInput(root, record);
  const descriptor = readJson(path);
  if (Object.keys(descriptor).sort().join(',') !== ['schema', 'action', 'taskId', 'prestate', 'prestateFingerprint', 'inventory', 'rationale'].sort().join(',')
      || descriptor.schema !== 'v4-historical-usdg-completion-archive-v1' || descriptor.action !== ACTION
      || descriptor.taskId !== taskId) throw new Error('historical archive descriptor identity mismatch');
  if (descriptor.prestateFingerprint !== current.fingerprint || digest(descriptor.prestate) !== current.fingerprint) throw new Error('historical archive prestate is stale');
  const inventory = historicalUsdgArchiveInventory(root, taskId, descriptor.inventory?.target);
  for (const file of inventory.archiveFiles) {
    const currentPath = resolve(realpathSync(root), file.path);
    if (!lstatSync(currentPath).isFile() || realpathSync(currentPath) !== currentPath
        || (lstatSync(currentPath).mode & 0o111) || hashFile(currentPath) !== file.sha256) throw new Error('historical working archive is missing, altered or has a different mode');
  }
  if (digest(descriptor.inventory) !== digest(inventory)) throw new Error('historical archive inventory mismatch');
  if (typeof descriptor.rationale !== 'string' || !descriptor.rationale.trim()) throw new Error('historical archival rationale required');
  readOwnerApproval(root, approval, { action: ACTION, phase: current.prestate.phase, itemId: taskId, rationale: descriptor.rationale, subjectInputs: [record] });
  return { route: 'owner-approved-historical-usdg-archive', from: inventory.sourceCommit, target: inventory.target,
    descriptor, record, recordHash: hashFile(path), approval, approvalHash: hashFile(join(root, approval)) };
}
