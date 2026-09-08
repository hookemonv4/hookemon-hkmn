import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { requireLiveMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
// Populated only by an independently reviewed release after exact owner-approved artifacts exist.
// Data files and environment variables cannot select this executable trust root.
const COLLECTOR_LIVE_RELEASE_SHA256 = null;
const fields = ['stage', 'provider', 'chainId', 'bindingPath', 'bindingDigest', 'ownerApprovalReceiptId'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new Error(`Collector live anchors: ${message}`); }
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`${label} schema is invalid`);
}
function readArtifact(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(path)
    || path.split('/').some(part => part === '..' || part === '.' || part === '')) fail('artifact path is invalid');
  const target = resolve(root, path);
  if (!target.startsWith(`${root}${sep}`) || realpathSync(target) !== target) fail('artifact path must remain inside the frozen release without symlinks');
  const bytes = readFileSync(target);
  return { value: JSON.parse(bytes), hash: sha(bytes) };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Reads only module-owned release paths; a registry or environment cannot choose its trust root. */
export function requireCollectorLiveBindingAnchors() {
  if (!/^[a-f0-9]{64}$/.test(COLLECTOR_LIVE_RELEASE_SHA256 ?? '')) fail('release authority is not pinned');
  const { value: manifest, hash: manifestSha256 } = readArtifact('bindings/collector-live-release.json');
  if (manifestSha256 !== COLLECTOR_LIVE_RELEASE_SHA256) fail('manifest bytes do not match executable release authority');
  const authority = requireLiveMutationAuthority();
  exact(manifest, ['schema', 'requirementsRevision', 'architectureRevision', 'anchors', 'approvalEvidence'], 'manifest');
  if (manifest.schema !== 'hookemon.collector-live-release.v1'
    || manifest.requirementsRevision !== authority.requirementsRevision
    || manifest.architectureRevision !== authority.architectureRevision
    || digest(manifest) !== authority.bindingManifestDigest) fail('manifest does not match frozen release authority');
  if (!Array.isArray(manifest.approvalEvidence) || manifest.approvalEvidence.length !== 2) fail('exactly two approval evidence pins are required');
  if (!Array.isArray(manifest.anchors) || manifest.anchors.length !== 2) fail('exactly two anchors are required');
  const seen = new Set();
  const receipts = new Set();
  const entries = manifest.anchors.map(anchor => {
    exact(anchor, fields, 'anchor');
    if (!['purchase', 'buyback'].includes(anchor.stage) || seen.has(anchor.stage)
      || anchor.provider !== 'collector-crypt' || anchor.chainId !== 'solana-mainnet'
      || !/^sha256:[a-f0-9]{64}$/.test(anchor.bindingDigest)
      || !/^r-[0-9]{5,}$/.test(anchor.ownerApprovalReceiptId)
      || receipts.has(anchor.ownerApprovalReceiptId)) fail('anchor identity is invalid');
    seen.add(anchor.stage); receipts.add(anchor.ownerApprovalReceiptId);
    const binding = readArtifact(anchor.bindingPath);
    if (digest(binding.value) !== anchor.bindingDigest) fail('binding digest does not match anchor');
    const evidence = manifest.approvalEvidence.find(value => value.receiptId === anchor.ownerApprovalReceiptId);
    exact(evidence, ['receiptId', 'receiptSha256', 'approvalPath', 'approvalSha256'], 'approval evidence');
    const receiptArtifact = readArtifact(`receipts/${anchor.ownerApprovalReceiptId}.json`);
    if (receiptArtifact.hash !== evidence.receiptSha256) fail('owner receipt bytes do not match frozen manifest');
    const receipt = receiptArtifact.value;
    if (receipt.id !== anchor.ownerApprovalReceiptId || receipt.type !== 'collector-live-binding-approved'
      || receipt.result !== 'PASSED' || !receipt.inputHashes || typeof receipt.inputHashes !== 'object'
      || receipt.inputHashes[anchor.bindingPath] !== binding.hash) fail('owner approval receipt does not bind artifact');
    const approvalPaths = Object.keys(receipt.inputHashes).filter(path => path.startsWith('decisions/') && path.endsWith('.json'));
    if (approvalPaths.length !== 1) fail('owner approval artifact is missing or ambiguous');
    const approval = readArtifact(approvalPaths[0]);
    exact(approval.value, ['schema', 'authority', 'approvalToken', 'anchor'], 'approval');
    if (approvalPaths[0] !== evidence.approvalPath || approval.hash !== evidence.approvalSha256
      || approval.hash !== receipt.inputHashes[approvalPaths[0]]
      || approval.value.schema !== 'hookemon.collector-live-binding-approval.v1'
      || approval.value.authority !== 'OWNER' || approval.value.approvalToken !== 'OWNER APPROVED'
      || digest(approval.value.anchor) !== digest(anchor)) fail('owner approval does not bind exact anchor');
    return { ...anchor, binding: binding.value, releaseIdentity: {
      manifestPath: 'bindings/collector-live-release.json', manifestSha256,
      manifestDigest: digest(manifest), requirementsRevision: manifest.requirementsRevision,
      architectureRevision: manifest.architectureRevision, ...anchor,
      bindingSha256: binding.hash, receiptSha256: receiptArtifact.hash,
      approvalPath: approvalPaths[0], approvalSha256: approval.hash,
    } };
  });
  return freeze(entries);
}

export function assertCollectorLiveBindingEntry(entry, { loaded = false } = {}) {
  const anchor = requireCollectorLiveBindingAnchors().find(value => value.stage === entry.stage);
  if (!anchor || entry.authority !== 'live' || entry.provider !== anchor.provider
    || entry.chainId !== anchor.chainId || entry.expectedDigest !== anchor.bindingDigest
    || digest(entry.binding) !== anchor.bindingDigest) fail('entry does not match approved release anchor');
  if (loaded && (!entry.releaseIdentity || digest(entry.releaseIdentity) !== digest(anchor.releaseIdentity))) {
    fail('loaded release identity does not match current approved release');
  }
  return anchor.releaseIdentity;
}
