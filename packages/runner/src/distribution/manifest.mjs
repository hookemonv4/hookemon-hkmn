import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { canonicalJson, digest } from '../cycle/journal.mjs';
import { deriveHolderDistributionCandidate } from './reconcile.mjs';
import {
  buildDistribution,
  decodeCanonicalManifest,
  orderedProofsDigest,
} from './merkle-sum.mjs';

const OWNER_PUBLIC_KEY = createPublicKey({
  key: Buffer.from(
    '302a300506032b657003210070b70676c75b964bbef8ec0a3bd5ab483aea0f28a4e07fb800f0bafe92ca34ca',
    'hex',
  ),
  format: 'der',
  type: 'spki',
});
const DISTRIBUTION_VERIFIER_PUBLIC_KEY = createPublicKey({
  key: Buffer.from(
    '302a300506032b65700321000ddfd4d84356540af1e218e05816e7431e4bd08008e44b24c7020bbe7a67e435',
    'hex',
  ),
  format: 'der',
  type: 'spki',
});
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const POSITIVE_DECIMAL = /^(?:[1-9][0-9]*)$/;
const RUNNER_CYCLE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const APPROVAL_FIELDS = [
  'schema',
  'authority',
  'candidateDigest',
  'closedProceedsBasisDigest',
  'entriesDigest',
  'chainId',
  'hook',
  'cycleId',
  'payoutId',
  'snapshotNumber',
  'snapshotHash',
];
const VERIFICATION_FIELDS = [
  'schema',
  'authority',
  'scope',
  'runnerCycleId',
  'proceedsKey',
  'closedLedgerDigest',
  'closedProceedsBasisDigest',
  'verificationJournalHead',
  'candidateDigest',
  'ownerApprovalDigest',
  'onchainCycleId',
  'payoutId',
  'manifestDigest',
  'rootHash',
  'rootSum',
  'proofsDigest',
  'sourceIds',
  'copyCount',
];

function exactObject(value, fields, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(descriptors).length !== fields.length
    || !fields.every((field) => Object.hasOwn(descriptors, field))
    || Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'),
    )
  ) throw new Error(`${label} must use the exact schema`);
  return value;
}

function approvalPayload(value) {
  return exactObject(value, APPROVAL_FIELDS, 'distribution approval payload');
}

export function distributionApprovalDigest(value) {
  const payload = approvalPayload(value);
  return digest({ domain: 'hookemon.fixture-distribution-approval.v1', payload });
}

export function distributionVerificationDigest(value) {
  const hasSignature = Object.hasOwn(value ?? {}, 'verificationSignature');
  const receipt = exactObject(
    value,
    [...VERIFICATION_FIELDS, 'receiptDigest', ...(hasSignature ? ['verificationSignature'] : [])],
    'distribution verification receipt',
  );
  const { receiptDigest: _receiptDigest, verificationSignature: _signature, ...content } = receipt;
  return digest({ domain: 'hookemon.fixture-distribution-verification.v1', receipt: content });
}

export function verifyDistributionVerificationReceipt(value) {
  const receipt = exactObject(
    value,
    [...VERIFICATION_FIELDS, 'receiptDigest', 'verificationSignature'],
    'distribution verification receipt',
  );
  if (
    receipt.schema !== 'hookemon.fixture-distribution-verification.v1'
    || receipt.authority !== 'HOOKEMON_FIXTURE_DISTRIBUTION_VERIFIER'
    || receipt.scope !== 'LOCAL_BYTES_ONLY_NOT_PUBLICATION_OR_LIVE_FUNDING_AUTHORITY'
  ) throw new Error('distribution verification authority or scope is invalid');
  for (const field of [
    'proceedsKey',
    'closedLedgerDigest',
    'closedProceedsBasisDigest',
    'verificationJournalHead',
    'candidateDigest',
    'ownerApprovalDigest',
    'receiptDigest',
  ]) {
    if (!DIGEST.test(receipt[field])) throw new Error(`distribution verification ${field} is invalid`);
  }
  if (
    typeof receipt.runnerCycleId !== 'string'
    || !RUNNER_CYCLE_ID.test(receipt.runnerCycleId)
    || receipt.runnerCycleId === ZERO_BYTES32
  ) {
    throw new Error('distribution verification runnerCycleId is invalid');
  }
  for (const field of [
    'onchainCycleId',
    'payoutId',
    'manifestDigest',
    'rootHash',
    'proofsDigest',
  ]) {
    if (!BYTES32.test(receipt[field]) || receipt[field] === ZERO_BYTES32) {
      throw new Error(`distribution verification ${field} is invalid`);
    }
  }
  if (!POSITIVE_DECIMAL.test(receipt.rootSum)) {
    throw new Error('distribution verification rootSum is invalid');
  }
  if (
    !Array.isArray(receipt.sourceIds)
    || receipt.sourceIds.length !== 3
    || new Set(receipt.sourceIds).size !== 3
    || receipt.sourceIds.some((sourceId) => typeof sourceId !== 'string' || sourceId.length === 0)
    || receipt.copyCount !== 3
  ) throw new Error('distribution verification sources are invalid');
  if (receipt.receiptDigest !== distributionVerificationDigest(receipt)) {
    throw new Error('distribution verification receipt digest is invalid');
  }
  if (
    typeof receipt.verificationSignature !== 'string'
    || !verifySignature(
      null,
      Buffer.from(receipt.receiptDigest, 'utf8'),
      DISTRIBUTION_VERIFIER_PUBLIC_KEY,
      Buffer.from(receipt.verificationSignature, 'base64url'),
    )
  ) throw new Error('distribution verification signature is invalid');
  return structuredClone(receipt);
}

function verifyApproval(value, candidate, closedProceedsBasis) {
  const approval = exactObject(
    value,
    [...APPROVAL_FIELDS, 'approvalDigest', 'signature'],
    'distribution approval',
  );
  if (
    approval.schema !== 'hookemon.fixture-distribution-approval.v1'
    || approval.authority !== 'FIXTURE_OWNER_SIGNATURE'
  ) throw new Error('distribution approval schema or authority is invalid');
  for (const field of ['candidateDigest', 'closedProceedsBasisDigest', 'entriesDigest']) {
    if (!DIGEST.test(approval[field])) throw new Error(`distribution approval ${field} is invalid`);
  }
  if (!POSITIVE_DECIMAL.test(approval.chainId)) throw new Error('distribution approval chainId is invalid');
  if (!ADDRESS.test(approval.hook) || approval.hook === ZERO_ADDRESS) {
    throw new Error('distribution approval hook is invalid');
  }
  for (const field of ['cycleId', 'payoutId', 'snapshotHash']) {
    if (!BYTES32.test(approval[field]) || approval[field] === ZERO_BYTES32) {
      throw new Error(`distribution approval ${field} is invalid`);
    }
  }
  if (!POSITIVE_DECIMAL.test(approval.snapshotNumber)) {
    throw new Error('distribution approval snapshotNumber is invalid');
  }
  if (
    approval.candidateDigest !== candidate.candidateDigest
    || approval.closedProceedsBasisDigest !== candidate.closedProceedsBasisDigest
    || approval.entriesDigest !== candidate.entriesDigest
    || approval.chainId !== candidate.snapshot.chainId
    || (BYTES32.test(closedProceedsBasis.cycleId) && approval.cycleId !== closedProceedsBasis.cycleId)
    || approval.snapshotNumber !== candidate.snapshot.blockNumber
    || approval.snapshotHash !== candidate.snapshot.blockHash
  ) throw new Error('distribution approval candidate binding is invalid');

  const { approvalDigest, signature, ...payload } = approval;
  const expectedDigest = distributionApprovalDigest(payload);
  if (approvalDigest !== expectedDigest) throw new Error('distribution approval digest is invalid');
  if (
    typeof signature !== 'string'
    || !verifySignature(
      null,
      Buffer.from(approvalDigest, 'utf8'),
      OWNER_PUBLIC_KEY,
      Buffer.from(signature, 'base64url'),
    )
  ) throw new Error('distribution approval signature is invalid');
  return structuredClone(approval);
}

export function compileApprovedDistribution(inputValue) {
  const input = exactObject(
    inputValue,
    ['closedProceedsBasis', 'snapshot', 'entries', 'approval'],
    'approved distribution input',
  );
  const candidate = deriveHolderDistributionCandidate({
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
  });
  const approval = verifyApproval(input.approval, candidate, input.closedProceedsBasis);
  const domain = {
    chainId: approval.chainId,
    hook: approval.hook,
    cycleId: approval.cycleId,
    payoutId: approval.payoutId,
  };
  const entries = candidate.entries.map((entry) => ({
    index: entry.index,
    recipient: entry.recipient,
    amount: entry.amountAtomicUSDG,
    directBalance: entry.directHkmnBalance,
  }));
  const built = buildDistribution({
    domain,
    snapshotNumber: approval.snapshotNumber,
    snapshotHash: approval.snapshotHash,
    entries,
  });
  if (built.root.sum !== candidate.totalAmountAtomicUSDG) {
    throw new Error('canonical distribution root does not match reconciled USDG');
  }

  return {
    schema: 'hookemon.canonical-holder-distribution.v1',
    authority: 'LOCAL_FIXTURE_VERIFIED_NOT_PUBLISHED',
    candidateDigest: candidate.candidateDigest,
    closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
    ownerApprovalDigest: approval.approvalDigest,
    domain,
    snapshot: {
      number: approval.snapshotNumber,
      hash: approval.snapshotHash,
      digest: candidate.snapshotDigest,
    },
    entries,
    manifest: { bytes: built.manifestBytes, digest: built.manifestDigest },
    root: built.root,
    proofsDigest: orderedProofsDigest(built.proofs),
    leaves: built.leaves,
    proofs: built.proofs,
  };
}

export function verifyDistributionCopies(artifactValue, copiesValue, contextValue) {
  const artifact = exactObject(
    artifactValue,
    [
      'schema',
      'authority',
      'candidateDigest',
      'closedProceedsBasisDigest',
      'ownerApprovalDigest',
      'domain',
      'snapshot',
      'entries',
      'manifest',
      'root',
      'proofsDigest',
      'leaves',
      'proofs',
    ],
    'distribution artifact',
  );
  if (
    artifact.schema !== 'hookemon.canonical-holder-distribution.v1'
    || artifact.authority !== 'LOCAL_FIXTURE_VERIFIED_NOT_PUBLISHED'
  ) throw new Error('distribution artifact schema or authority is invalid');
  const rebuilt = buildDistribution({
    domain: artifact.domain,
    snapshotNumber: artifact.snapshot.number,
    snapshotHash: artifact.snapshot.hash,
    entries: artifact.entries,
  });
  const leavesMatch = Array.isArray(artifact.leaves)
    && artifact.leaves.length === rebuilt.leaves.length
    && artifact.leaves.every(
      (leaf, index) => leaf?.hash === rebuilt.leaves[index].hash && leaf?.sum === rebuilt.leaves[index].sum,
    );
  if (
    artifact.manifest.bytes !== rebuilt.manifestBytes
    || artifact.manifest.digest !== rebuilt.manifestDigest
    || canonicalJson(artifact.root) !== canonicalJson(rebuilt.root)
    || artifact.proofsDigest !== orderedProofsDigest(rebuilt.proofs)
    || orderedProofsDigest(artifact.proofs) !== artifact.proofsDigest
    || !leavesMatch
  ) throw new Error('distribution artifact reconstruction mismatch');
  if (!Array.isArray(copiesValue) || copiesValue.length !== 3) {
    throw new Error('distribution copies must contain primary, mirror, and archive');
  }
  const context = exactObject(
    contextValue,
    [
      'runnerCycleId',
      'proceedsKey',
      'closedLedgerDigest',
      'closedProceedsBasisDigest',
      'verificationJournalHead',
    ],
    'distribution verification context',
  );
  if (
    typeof context.runnerCycleId !== 'string'
    || !RUNNER_CYCLE_ID.test(context.runnerCycleId)
    || context.runnerCycleId === ZERO_BYTES32
    || (BYTES32.test(context.runnerCycleId) && context.runnerCycleId !== artifact.domain.cycleId)
    || context.closedProceedsBasisDigest !== artifact.closedProceedsBasisDigest
  ) throw new Error('distribution verification cycle or basis binding is invalid');
  for (const field of [
    'proceedsKey',
    'closedLedgerDigest',
    'closedProceedsBasisDigest',
    'verificationJournalHead',
  ]) {
    if (!DIGEST.test(context[field])) throw new Error(`distribution verification context ${field} is invalid`);
  }
  const sourceIds = new Set();
  for (const value of copiesValue) {
    const copy = exactObject(value, ['sourceId', 'manifestBytes'], 'distribution copy');
    if (typeof copy.sourceId !== 'string' || copy.sourceId.length === 0 || sourceIds.has(copy.sourceId)) {
      throw new Error('distribution copy source is invalid or duplicate');
    }
    sourceIds.add(copy.sourceId);
    if (copy.manifestBytes !== artifact.manifest.bytes) {
      throw new Error('distribution copy manifest mismatch');
    }
    const copyRebuild = buildDistribution(decodeCanonicalManifest(copy.manifestBytes));
    if (
      copyRebuild.manifestDigest !== artifact.manifest.digest
      || canonicalJson(copyRebuild.root) !== canonicalJson(artifact.root)
      || orderedProofsDigest(copyRebuild.proofs) !== artifact.proofsDigest
    ) throw new Error('distribution copy reconstruction mismatch');
  }
  const receiptContent = {
    schema: 'hookemon.fixture-distribution-verification.v1',
    authority: 'HOOKEMON_FIXTURE_DISTRIBUTION_VERIFIER',
    scope: 'LOCAL_BYTES_ONLY_NOT_PUBLICATION_OR_LIVE_FUNDING_AUTHORITY',
    runnerCycleId: context.runnerCycleId,
    proceedsKey: context.proceedsKey,
    closedLedgerDigest: context.closedLedgerDigest,
    closedProceedsBasisDigest: context.closedProceedsBasisDigest,
    verificationJournalHead: context.verificationJournalHead,
    candidateDigest: artifact.candidateDigest,
    ownerApprovalDigest: artifact.ownerApprovalDigest,
    onchainCycleId: artifact.domain.cycleId,
    payoutId: artifact.domain.payoutId,
    manifestDigest: artifact.manifest.digest,
    rootHash: artifact.root.hash,
    rootSum: artifact.root.sum,
    proofsDigest: artifact.proofsDigest,
    sourceIds: [...sourceIds],
    copyCount: copiesValue.length,
  };
  return {
    ...receiptContent,
    receiptDigest: digest({
      domain: 'hookemon.fixture-distribution-verification.v1',
      receipt: receiptContent,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// WP-39 production profile: everything above this line (`OWNER_PUBLIC_KEY`,
// `DISTRIBUTION_VERIFIER_PUBLIC_KEY`, `compileApprovedDistribution`, `verifyDistributionCopies`,
// and the two digest/verify functions) is the Ed25519 fixture scheme, used only under the fixture
// evidence profile, and is left completely unchanged by this section.
//
// Under the production profile the same two roles (distribution-signer, verifier) instead produce
// real secp256k1 signatures over the vault's own EIP-712 `PayoutDistribution` digest — the exact
// bytes `PegCycleVault.authorizePayout` verifies on-chain — so there is exactly one signature
// scheme gating the manifest, both off-chain and on-chain (decision D7, WP-38/WP-39). This module
// stays dependency-free (no keccak256/secp256k1 here): the digest itself and every recovery/
// verification of a signature against it are computed in
// `packages/adapters/src/signing/payout-typed-data.mjs`/`payout-distribution.mjs` (viem), and are
// never duplicated here. This module's own job under production is exactly what it already does
// under fixture: derive the candidate and build the canonical Merkle-sum tree from real, given
// inputs — `buildProductionDistributionArtifact` below is the direct production analog of
// `compileApprovedDistribution`, differing only in that it takes the full on-chain domain
// (including `vault`/`usdg`/`operationsTrigger`/`bindingManifestDigest`/`requirementsRevision` —
// fields the EIP-712 struct needs but the local fixture candidate binding never did) and produces
// no `ownerApprovalDigest`/local-approval linkage, because there is no separate local approval
// object in production: the EIP-712 signature over this exact artifact's own manifestDigest/
// rootHash/rootSum *is* the approval.
const PRODUCTION_AUTHORITY = 'HOOKEMON_PRODUCTION_EIP712_VAULT_DISTRIBUTION_NOT_YET_SIGNED';
const PRODUCTION_DOMAIN_FIELDS = [
  'requirementsRevision', 'chainId', 'cycleId', 'hook', 'vault', 'usdg', 'operationsTrigger', 'bindingManifestDigest',
];

function productionDomain(value) {
  return exactObject(value, PRODUCTION_DOMAIN_FIELDS, 'production distribution domain');
}

/**
 * Builds the canonical Merkle-sum distribution artifact for the production profile, from the
 * candidate inputs alone — no owner-approval object, no Ed25519 key. `domain` carries every field
 * the vault's own EIP-712 `PayoutDistribution` struct needs (see `PRODUCTION_DOMAIN_FIELDS`)
 * except `payoutId`, which this function derives the same way `compileApprovedDistribution`'s
 * caller already does (an explicit, separate argument — this module never invents a payout id).
 * Both the distribution-signer and the independent verifier call this from the exact same
 * candidate inputs and are expected to reach byte-identical output; `assertPairedProductionPayoutSignatures`
 * (`packages/adapters/src/signing/payout-distribution.mjs`) is what actually cross-checks their two
 * signatures agree on the resulting `manifestDigest`/`rootHash`/`rootSum`.
 */
export function buildProductionDistributionArtifact({ closedProceedsBasis, snapshot, entries, domain, payoutId }) {
  const validatedDomain = productionDomain(domain);
  if (!BYTES32.test(payoutId) || payoutId === ZERO_BYTES32) throw new Error('production distribution payoutId is invalid');
  const candidate = deriveHolderDistributionCandidate({ closedProceedsBasis, snapshot, entries });
  const merkleDomain = {
    chainId: String(validatedDomain.chainId),
    hook: validatedDomain.hook,
    cycleId: validatedDomain.cycleId,
    payoutId,
  };
  const treeEntries = candidate.entries.map((entry) => ({
    index: entry.index,
    recipient: entry.recipient,
    amount: entry.amountAtomicUSDG,
    directBalance: entry.directHkmnBalance,
  }));
  const built = buildDistribution({
    domain: merkleDomain,
    snapshotNumber: candidate.snapshot.blockNumber,
    snapshotHash: candidate.snapshot.blockHash,
    entries: treeEntries,
  });
  if (built.root.sum !== candidate.totalAmountAtomicUSDG) {
    throw new Error('canonical distribution root does not match reconciled USDG');
  }
  return {
    schema: 'hookemon.production-eip712-holder-distribution.v1',
    authority: PRODUCTION_AUTHORITY,
    candidateDigest: candidate.candidateDigest,
    closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
    // Every field JSON-serializable (a canonical decimal chainId string, never a raw BigInt) —
    // this artifact is written to disk as JSON by distribution.mjs's pending/receipts contract.
    domain: { ...validatedDomain, chainId: String(validatedDomain.chainId), payoutId },
    merkleDomain,
    snapshot: {
      number: candidate.snapshot.blockNumber,
      hash: candidate.snapshot.blockHash,
      digest: candidate.snapshotDigest,
    },
    entries: treeEntries,
    manifest: { bytes: built.manifestBytes, digest: built.manifestDigest },
    root: built.root,
    proofsDigest: orderedProofsDigest(built.proofs),
    leaves: built.leaves,
    proofs: built.proofs,
  };
}

/**
 * Independently rebuilds a production distribution artifact from `artifact.domain`/
 * `artifact.entries`/`artifact.snapshot` alone and asserts the result matches `artifact` in every
 * field a tamper could target — the production analog of `verifyDistributionCopies`'s own
 * reconstruction check, minus the Ed25519 owner-approval linkage (there is none in production).
 * This is what the separate verifier process (`bin/hookemon-verifier.mjs`) calls before it ever
 * signs anything: a request that fails this check never reaches the signer client.
 */
export function verifyProductionDistributionArtifactReconstruction(artifactValue) {
  const artifact = exactObject(
    artifactValue,
    [
      'schema', 'authority', 'candidateDigest', 'closedProceedsBasisDigest', 'domain', 'merkleDomain',
      'snapshot', 'entries', 'manifest', 'root', 'proofsDigest', 'leaves', 'proofs',
    ],
    'production distribution artifact',
  );
  if (artifact.schema !== 'hookemon.production-eip712-holder-distribution.v1' || artifact.authority !== PRODUCTION_AUTHORITY) {
    throw new Error('production distribution artifact schema or authority is invalid');
  }
  const rebuilt = buildDistribution({
    domain: artifact.merkleDomain,
    snapshotNumber: artifact.snapshot.number,
    snapshotHash: artifact.snapshot.hash,
    entries: artifact.entries,
  });
  const leavesMatch = Array.isArray(artifact.leaves)
    && artifact.leaves.length === rebuilt.leaves.length
    && artifact.leaves.every(
      (leaf, index) => leaf?.hash === rebuilt.leaves[index].hash && leaf?.sum === rebuilt.leaves[index].sum,
    );
  if (
    artifact.manifest.bytes !== rebuilt.manifestBytes
    || artifact.manifest.digest !== rebuilt.manifestDigest
    || canonicalJson(artifact.root) !== canonicalJson(rebuilt.root)
    || artifact.proofsDigest !== orderedProofsDigest(rebuilt.proofs)
    || orderedProofsDigest(artifact.proofs) !== artifact.proofsDigest
    || !leavesMatch
  ) throw new Error('production distribution artifact reconstruction mismatch');
  return structuredClone(artifact);
}
