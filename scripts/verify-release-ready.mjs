#!/usr/bin/env node

// The Phase 3 release gate. It fails while a deployment manifest is invalid, traceability is
// incomplete, the redteam record is stale or semantically incomplete, or a signed owner artifact
// still labels itself as an unsigned draft. RT-R58-01, RT-R58-02, and RT-R58-04 are non-blocking
// only when the deployment manifest validates; approval JSON never changes that decision.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashFile, readJson } from './lib/util.mjs';
import {
  GATE_PROOF_SCHEMA,
  OWNER_ACTIONS,
  OWNER_EVIDENCE_PRODUCER,
  isGateReceiptAuthoritative,
  readOwnerApproval,
  validateGateEvidenceReceipt,
} from './lib/gates.mjs';
import { listReceipts } from './lib/receipts.mjs';
import { checkManifest } from './test-manifest.mjs';
import { verifyDeploymentManifest } from './verify-deployment-manifest.mjs';
import { verifyCommittedTraceability } from './verify-traceability.mjs';

export const DEPLOYMENT_MANIFEST_PATH = 'release/phase3/deployment-manifest.json';
export const REDTEAM_FINDINGS_PATH = 'decisions/redteam/findings.json';
export const OWNER_APPROVALS_DIR = 'decisions/owner-approvals';
export const STATE_PATH = 'state.json';
export const REQUIREMENTS_PATH = 'specs/requirements.json';
export const CAPABILITY_MAP_PATH = 'architecture/capability-map.json';
export const REDTEAM_REVIEW_BUNDLE_PATH = 'qa/redteam/current-review-bundle.json';
export const REDTEAM_RESOLUTIONS_PATH = 'qa/redteam/resolutions.json';
export const REDTEAM_TERMINATION_PATH = 'qa/redteam/termination.json';
export const REDTEAM_EVIDENCE_PATH = 'qa/redteam/current-cycle-evidence.json';
export const REDTEAM_DOUBT_LOOP_PATH = 'qa/redteam/doubt-loop.json';
export const REDTEAM_THREAT_MODEL_PATH = 'qa/redteam/threat-model.json';

export const REQUIRED_DISPOSITIONED_FINDING_ID = 'RT-R58-05';
export const EXPECTED_REDTEAM_FINDING_IDS = Object.freeze([
  'RT-R55-01',
  'RT-R55-03',
  'RT-R55-04',
  'RT-R58-01',
  'RT-R58-02',
  'RT-R58-03',
  'RT-R58-04',
  'RT-R58-05',
  'RT-R58-06',
  'RT-R58-07',
  'RT-R58-08',
]);

const NON_BLOCKING_BY_MANIFEST_IDS = new Set(['RT-R58-01', 'RT-R58-02', 'RT-R58-04']);
const RESOLVED_STATUSES = new Set(['RESOLVED']);
const FINDING_STATUSES = new Set(['RESOLVED', 'OPEN_FAIL_CLOSED', 'IN_PROGRESS']);
const FINDING_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const EXPECTED_CLASSIFICATION_PRECEDENCE = Object.freeze([
  'contract-misread',
  'valid-actionable',
  'valid-tradeoff',
  'noise',
]);
const FINDING_CLASSIFICATIONS = new Set(EXPECTED_CLASSIFICATION_PRECEDENCE);
const SHA256 = /^[0-9a-f]{64}$/;
const REVIEW_BUNDLE_SCHEMA = 'hookemon.redteam-review-bundle.v1';
const REVIEW_RESOLUTIONS_SCHEMA = 'hookemon.redteam-resolutions.v3';
const REVIEW_TERMINATION_SCHEMA = 'hookemon.redteam-termination.v3';
const REVIEW_EVIDENCE_SCHEMA = 'hookemon.redteam-evidence.v1';
const REVIEW_DOUBT_LOOP_SCHEMA = 'hookemon.redteam-doubt-loop.v3';
const REVIEW_THREAT_MODEL_SCHEMA = 'hookemon.redteam-threat-model.v2';
const REVIEW_ATTESTATION_ACTION = 'REDTEAM_REVIEW_ATTESTATION';
const MANIFEST_DISPOSITIONED_PROBLEM_IDS = new Set(['RT-R58-01', 'RT-R58-02', 'RT-R58-04']);
const REDTEAM_COUNTS_KEYS = Object.freeze([
  'contract-misread',
  'valid-actionable',
  'valid-tradeoff',
  'noise',
  'resolved',
  'open',
  'inProgress',
]);
const SIGNED_APPROVAL_TOKEN = 'OWNER APPROVED';
const FORMAL_OWNER_APPROVAL_TOKENS = new Set(['OWNER APPROVED', 'OWNER AUTHORIZED']);
const UNSIGNED_DRAFT_MARKER = 'DRAFT_UNSIGNED';
const SPEC_S5_RECEIPT_TYPE = 'owner-spec-approved';
const CURRENT_REQUIREMENTS_S5_SUBJECT_INPUTS = Object.freeze([
  'gates/spec.json',
  'policy/policy.json',
  REQUIREMENTS_PATH,
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isRepositoryContained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function containedPath(root, relativePath, label) {
  if (!nonEmptyString(relativePath) || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  const repositoryRoot = realpathSync(root);
  const lexical = resolve(repositoryRoot, relativePath);
  if (!isRepositoryContained(repositoryRoot, lexical)) {
    throw new Error(`${label} must remain inside the repository`);
  }
  return { repositoryRoot, lexical };
}

function ownerApprovalFiles(root, { readDirectory = readdirSync } = {}) {
  const { repositoryRoot, lexical } = containedPath(root, OWNER_APPROVALS_DIR, 'owner approvals directory');
  const directory = lstatSync(lexical);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error('owner approvals directory must be a regular repository-contained directory');
  }
  const resolvedDirectory = realpathSync(lexical);
  if (!isRepositoryContained(repositoryRoot, resolvedDirectory) || resolvedDirectory !== lexical) {
    throw new Error('owner approvals directory must be a regular repository-contained directory');
  }

  return readDirectory(lexical)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const entryPath = join(lexical, name);
      const entry = lstatSync(entryPath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`owner approval entry must be a regular repository-contained JSON file: ${name}`);
      }
      const resolvedEntry = realpathSync(entryPath);
      if (!isRepositoryContained(repositoryRoot, resolvedEntry) || resolvedEntry !== entryPath) {
        throw new Error(`owner approval entry must be a regular repository-contained JSON file: ${name}`);
      }
      return `${OWNER_APPROVALS_DIR}/${name}`;
    });
}

function isSelfContradictorySignedDraft(artifact) {
  if (!FORMAL_OWNER_APPROVAL_TOKENS.has(String(artifact?.approvalToken ?? '').trim())) return false;
  return artifactContainsMarker(artifact);
}

function readApproval(root, relativePath) {
  try {
    return readJson(join(root, relativePath));
  } catch {
    return null;
  }
}

function artifactContainsMarker(value) {
  if (typeof value === 'string') return value.includes(UNSIGNED_DRAFT_MARKER);
  if (Array.isArray(value)) return value.some(artifactContainsMarker);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => key.includes(UNSIGNED_DRAFT_MARKER) || artifactContainsMarker(nested));
}

function checkDeploymentManifest(root, errors) {
  let manifest;
  try {
    manifest = readJson(join(root, DEPLOYMENT_MANIFEST_PATH));
  } catch (error) {
    errors.push(`deployment manifest could not be read at ${DEPLOYMENT_MANIFEST_PATH}: ${error.message}`);
    return { checked: false, path: DEPLOYMENT_MANIFEST_PATH };
  }
  try {
    const result = verifyDeploymentManifest(manifest, root);
    return { checked: true, path: DEPLOYMENT_MANIFEST_PATH, digest: result.digest, targets: result.targets };
  } catch (error) {
    errors.push(
      `deployment manifest at ${DEPLOYMENT_MANIFEST_PATH} is invalid (this includes any vault-family `
      + `contract appearing among the deployed targets): ${error.message}`,
    );
    return { checked: false, path: DEPLOYMENT_MANIFEST_PATH };
  }
}

function checkTraceability(root, errors) {
  let result;
  try {
    result = verifyCommittedTraceability(root);
  } catch (error) {
    errors.push(`traceability could not be verified: ${error.message}`);
    return { valid: false };
  }
  if (!result.valid) {
    for (const error of result.errors) errors.push(`traceability incomplete: ${error}`);
  }
  return { valid: result.valid };
}

function checkApprovalArtifactConsistency(root, errors, options) {
  let files;
  try {
    files = ownerApprovalFiles(root, options);
  } catch (error) {
    errors.push(`owner approvals directory ${OWNER_APPROVALS_DIR} could not be enumerated: ${error.message}`);
    return { checked: 0, selfContradictory: [] };
  }
  const selfContradictory = [];
  for (const relativePath of files) {
    const artifact = readApproval(root, relativePath);
    if (artifact === null) {
      errors.push(`${relativePath} could not be read as JSON`);
      continue;
    }
    if (artifact.action === OWNER_ACTIONS.EVIDENCE && artifact.phase === 'spec' && artifact.itemId === 'S5') {
      continue;
    }
    if (isSelfContradictorySignedDraft(artifact)) {
      selfContradictory.push(relativePath);
      errors.push(
        `${relativePath} carries a formal owner approval token but its artifact contains `
        + `"${UNSIGNED_DRAFT_MARKER}": an approval artifact cannot be both signed and an unsigned draft.`,
      );
    }
  }
  return { checked: files.length, selfContradictory };
}

function hasExactCurrentInputHashes(root, receipt, inputs) {
  if (!isPlainObject(receipt?.inputHashes)) return false;
  const expected = [...new Set(inputs)].sort();
  const actual = Object.keys(receipt.inputHashes).sort();
  if (!sameStringArray(actual, expected)) return false;
  try {
    return expected.every(input => receipt.inputHashes[input] === hashFile(join(root, input)));
  } catch {
    return false;
  }
}

function checkCurrentRequirementsAuthorization(root, errors) {
  let requirements;
  try {
    requirements = readJson(join(root, REQUIREMENTS_PATH));
  } catch (error) {
    errors.push(`${REQUIREMENTS_PATH} could not be read for formal S5 authorization: ${error.message}`);
    return { checked: false, authorized: false, revision: null };
  }
  if (!positiveInteger(requirements?.revision)) {
    errors.push(`${REQUIREMENTS_PATH} revision must be a positive integer for formal S5 authorization`);
    return { checked: false, authorized: false, revision: requirements?.revision ?? null };
  }

  let receipts;
  try {
    receipts = listReceipts(root);
  } catch (error) {
    errors.push(`formal S5 authorization receipts could not be read: ${error.message}`);
    return { checked: false, authorized: false, revision: requirements.revision };
  }

  const selfContradictoryCandidates = [];
  for (const receipt of [...receipts].reverse()) {
    if (
      receipt.type !== SPEC_S5_RECEIPT_TYPE
      || receipt.phase !== 'spec'
      || receipt.result !== 'PASSED'
      || !sameKeys(receipt.data, ['approvalInput', 'itemId', 'producer', 'proofSchema', 'rationale'])
      || receipt.data.itemId !== 'S5'
      || receipt.data.producer !== OWNER_EVIDENCE_PRODUCER
      || receipt.data.proofSchema !== GATE_PROOF_SCHEMA
      || !nonEmptyString(receipt.data.rationale)
      || !nonEmptyString(receipt.data.approvalInput)
    ) continue;

    let approval;
    try {
      approval = readOwnerApproval(root, receipt.data.approvalInput, {
        action: OWNER_ACTIONS.EVIDENCE,
        phase: 'spec',
        itemId: 'S5',
        rationale: receipt.data.rationale,
        subjectInputs: CURRENT_REQUIREMENTS_S5_SUBJECT_INPUTS,
      });
    } catch {
      continue;
    }
    if (isSelfContradictorySignedDraft(approval)) {
      selfContradictoryCandidates.push(receipt.data.approvalInput);
      continue;
    }
    if (!hasExactCurrentInputHashes(root, receipt, [
      ...CURRENT_REQUIREMENTS_S5_SUBJECT_INPUTS,
      receipt.data.approvalInput,
    ])) continue;

    return {
      checked: true,
      authorized: true,
      revision: requirements.revision,
      receiptId: receipt.id,
      approvalInput: receipt.data.approvalInput,
    };
  }

  for (const approvalInput of [...new Set(selfContradictoryCandidates)].sort()) {
    errors.push(
      `current S5 authorization candidate ${approvalInput} carries a formal owner approval token but contains `
      + `"${UNSIGNED_DRAFT_MARKER}": an approval artifact cannot be both signed and an unsigned draft.`,
    );
  }
  errors.push(`current requirements revision ${requirements.revision} has no valid formal S5 owner authorization`);
  return {
    checked: true,
    authorized: false,
    revision: requirements.revision,
    selfContradictoryCandidates: [...new Set(selfContradictoryCandidates)].sort(),
  };
}

function expectedCounts(findings) {
  const counts = Object.fromEntries(REDTEAM_COUNTS_KEYS.map(key => [key, 0]));
  for (const finding of findings) {
    if (FINDING_CLASSIFICATIONS.has(finding?.classification)) counts[finding.classification] += 1;
    if (finding?.status === 'RESOLVED') counts.resolved += 1;
    else if (finding?.status === 'IN_PROGRESS') counts.inProgress += 1;
    else if (finding?.status === 'OPEN_FAIL_CLOSED') counts.open += 1;
  }
  return counts;
}

function countsMatch(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every(key => actual[key] === expected[key]);
}

function checkFindingShape(finding, index, errors) {
  const label = typeof finding?.id === 'string' ? finding.id : `findings[${index}]`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!nonEmptyString(finding.id)) errors.push(`${label} id must be a non-empty string`);
  if (!FINDING_SEVERITIES.has(finding.reportedSeverity)) {
    errors.push(`${label} reportedSeverity must be one of ${[...FINDING_SEVERITIES].join(', ')}`);
  }
  if (!FINDING_CLASSIFICATIONS.has(finding.classification)) {
    errors.push(`${label} classification must be one of ${[...FINDING_CLASSIFICATIONS].join(', ')}`);
  }
  if (!nonEmptyString(finding.canonicalIssue)) errors.push(`${label} canonicalIssue must be a non-empty string`);
  if (!nonEmptyString(finding.summary)) errors.push(`${label} summary must be a non-empty string`);
  if (!FINDING_STATUSES.has(finding.status)) {
    errors.push(`${label} status must be one of ${[...FINDING_STATUSES].join(', ')}`);
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0 || finding.evidence.some(value => !nonEmptyString(value))) {
    errors.push(`${label} evidence must be a non-empty string array`);
  }
  if (!nonEmptyString(finding.disposition)) errors.push(`${label} disposition must be a non-empty string`);
}

function checkRedteamRevisions(root, record, errors) {
  let requirementsRevision;
  let architectureRevision;
  try {
    requirementsRevision = readJson(join(root, REQUIREMENTS_PATH)).revision;
  } catch (error) {
    errors.push(`${REQUIREMENTS_PATH} could not be read: ${error.message}`);
  }
  try {
    architectureRevision = readJson(join(root, CAPABILITY_MAP_PATH)).architectureRevision;
  } catch (error) {
    errors.push(`${CAPABILITY_MAP_PATH} could not be read: ${error.message}`);
  }
  if (record?.requirementsRevision !== requirementsRevision) {
    errors.push(`${REDTEAM_FINDINGS_PATH} requirementsRevision must match ${REQUIREMENTS_PATH} revision`);
  }
  if (record?.architectureRevision !== architectureRevision) {
    errors.push(`${REDTEAM_FINDINGS_PATH} architectureRevision must match ${CAPABILITY_MAP_PATH} architectureRevision`);
  }
}

function checkRedteamLifecycleMetadata(record, errors) {
  if (!positiveInteger(record?.cycle)) {
    errors.push(`${REDTEAM_FINDINGS_PATH} cycle must be a positive integer`);
  }

  const priorCycle = record?.priorCycle;
  if (!priorCycle || typeof priorCycle !== 'object' || Array.isArray(priorCycle)) {
    errors.push(`${REDTEAM_FINDINGS_PATH} priorCycle must be an object`);
  } else {
    if (!positiveInteger(priorCycle.cycle)) {
      errors.push(`${REDTEAM_FINDINGS_PATH} priorCycle cycle must be a positive integer`);
    }
    if (!positiveInteger(priorCycle.requirementsRevision)) {
      errors.push(`${REDTEAM_FINDINGS_PATH} priorCycle requirementsRevision must be a positive integer`);
    }
    if (!positiveInteger(priorCycle.architectureRevision)) {
      errors.push(`${REDTEAM_FINDINGS_PATH} priorCycle architectureRevision must be a positive integer`);
    }
    if (!nonEmptyString(priorCycle.note)) {
      errors.push(`${REDTEAM_FINDINGS_PATH} priorCycle note must be a non-empty string`);
    }
    if (positiveInteger(record?.cycle) && positiveInteger(priorCycle.cycle) && priorCycle.cycle !== record.cycle - 1) {
      errors.push(`${REDTEAM_FINDINGS_PATH} priorCycle cycle must immediately precede cycle`);
    }
  }

  const precedence = record?.classificationPrecedence;
  if (!Array.isArray(precedence)
    || precedence.length !== EXPECTED_CLASSIFICATION_PRECEDENCE.length
    || precedence.some((value, index) => value !== EXPECTED_CLASSIFICATION_PRECEDENCE[index])) {
    errors.push(
      `${REDTEAM_FINDINGS_PATH} classificationPrecedence must exactly list ${EXPECTED_CLASSIFICATION_PRECEDENCE.join(', ')}`,
    );
  }
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function readContentAddressedFile(root, descriptor, expectedPath, label, errors) {
  if (!sameKeys(descriptor, ['path', 'sha256'])) {
    errors.push(`${label} must contain exactly path and sha256`);
    return null;
  }
  if (expectedPath !== null && descriptor.path !== expectedPath) {
    errors.push(`${label} path must be ${expectedPath}`);
    return null;
  }
  if (!nonEmptyString(descriptor.path) || !SHA256.test(descriptor.sha256)) {
    errors.push(`${label} must contain a repository path and a lowercase SHA-256 digest`);
    return null;
  }

  let file;
  try {
    const { repositoryRoot, lexical } = containedPath(root, descriptor.path, label);
    const stat = lstatSync(lexical);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('must be a regular repository-contained file');
    }
    const physical = realpathSync(lexical);
    if (!isRepositoryContained(repositoryRoot, physical) || physical !== lexical) {
      throw new Error('must be a regular repository-contained file');
    }
    const digest = hashFile(physical);
    if (digest !== descriptor.sha256) {
      errors.push(`${label} ${descriptor.path} digest does not match its content address`);
      return null;
    }
    file = { path: physical, value: readJson(physical) };
  } catch (error) {
    errors.push(`${label} ${descriptor.path} could not be read: ${error.message}`);
  }
  return file;
}

function checkReviewStateArtifact(artifact, field, schema, bundle, label, errors) {
  const expectedKeys = ['schemaVersion', 'phase', 'requirementsRevision', 'architectureRevision', 'cycle', field];
  if (!sameKeys(artifact, expectedKeys)) {
    errors.push(`${label} must contain exactly ${expectedKeys.join(', ')}`);
    return new Map();
  }
  if (artifact.schemaVersion !== schema || artifact.phase !== 'redteam'
      || artifact.requirementsRevision !== bundle.requirementsRevision
      || artifact.architectureRevision !== bundle.architectureRevision
      || artifact.cycle !== bundle.cycle) {
    errors.push(`${label} must bind the current redteam review cycle and revisions`);
  }
  if (!Array.isArray(artifact[field])) {
    errors.push(`${label} ${field} must be an array`);
    return new Map();
  }
  const states = new Map();
  for (const [index, state] of artifact[field].entries()) {
    if (!sameKeys(state, ['id', 'status']) || !nonEmptyString(state.id) || !FINDING_STATUSES.has(state.status)) {
      errors.push(`${label} ${field}[${index}] must contain a finding id and valid status`);
      continue;
    }
    if (states.has(state.id)) {
      errors.push(`${label} ${field} contains duplicate ${state.id}`);
      continue;
    }
    states.set(state.id, state.status);
  }
  return states;
}

function checkBundleFindingShape(finding, index, errors) {
  const label = nonEmptyString(finding?.id) ? finding.id : `review bundle findings[${index}]`;
  const expectedKeys = [
    'id', 'reportedSeverity', 'classification', 'canonicalIssue', 'statusTransition', 'evidence',
  ];
  if (!sameKeys(finding, expectedKeys)) {
    errors.push(`${label} in the current review bundle must contain exactly ${expectedKeys.join(', ')}`);
    return false;
  }
  if (!nonEmptyString(finding.id) || !FINDING_SEVERITIES.has(finding.reportedSeverity)
      || !FINDING_CLASSIFICATIONS.has(finding.classification) || !nonEmptyString(finding.canonicalIssue)) {
    errors.push(`${label} in the current review bundle has invalid finding metadata`);
    return false;
  }
  if (!sameKeys(finding.statusTransition, ['from', 'to'])
      || !FINDING_STATUSES.has(finding.statusTransition.from)
      || !FINDING_STATUSES.has(finding.statusTransition.to)) {
    errors.push(`${label} in the current review bundle has an invalid statusTransition`);
    return false;
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    errors.push(`${label} in the current review bundle requires content-addressed evidence`);
    return false;
  }
  return true;
}

function sameIdSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) return false;
  const expectedSet = new Set(expected);
  return actual.every(id => expectedSet.has(id));
}

function checkExactFindingIdSet(states, expected, label, errors) {
  const valid = sameIdSet([...states.keys()], expected);
  if (!valid) errors.push(`${label} finding ids must exactly match ${expected.join(', ')}`);
  return valid;
}

function checkPriorBundleFindingShape(finding, index, errors) {
  const label = nonEmptyString(finding?.id) ? finding.id : `prior review bundle findings[${index}]`;
  const expectedKeys = ['id', 'reportedSeverity', 'classification', 'canonicalIssue', 'status'];
  if (!sameKeys(finding, expectedKeys)) {
    errors.push(`${label} in the prior review bundle must contain exactly ${expectedKeys.join(', ')}`);
    return false;
  }
  if (!nonEmptyString(finding.id) || !FINDING_SEVERITIES.has(finding.reportedSeverity)
      || !FINDING_CLASSIFICATIONS.has(finding.classification) || !nonEmptyString(finding.canonicalIssue)
      || !FINDING_STATUSES.has(finding.status)) {
    errors.push(`${label} in the prior review bundle has invalid finding metadata`);
    return false;
  }
  return true;
}

function checkPriorReviewBundle(root, record, errors) {
  const prior = record?.priorCycle;
  const bundleFile = readContentAddressedFile(
    root,
    record?.priorReviewBundle,
    'qa/redteam/prior-review-bundle.json',
    'prior review bundle',
    errors,
  );
  if (!bundleFile) return null;
  const bundle = bundleFile.value;
  const expectedKeys = ['schemaVersion', 'phase', 'requirementsRevision', 'architectureRevision', 'cycle', 'findings'];
  if (!sameKeys(bundle, expectedKeys)) {
    errors.push(`prior review bundle must contain exactly ${expectedKeys.join(', ')}`);
    return null;
  }
  if (bundle.schemaVersion !== REVIEW_BUNDLE_SCHEMA || bundle.phase !== 'redteam'
      || bundle.requirementsRevision !== prior?.requirementsRevision
      || bundle.architectureRevision !== prior?.architectureRevision
      || bundle.cycle !== prior?.cycle) {
    errors.push('prior review bundle must bind the predecessor redteam cycle and revisions');
  }
  if (!Array.isArray(bundle.findings)) {
    errors.push('prior review bundle findings must be an array');
    return null;
  }
  const findingsById = new Map();
  for (const [index, finding] of bundle.findings.entries()) {
    if (!checkPriorBundleFindingShape(finding, index, errors)) continue;
    if (findingsById.has(finding.id)) {
      errors.push(`${finding.id} appears more than once in the prior review bundle`);
      continue;
    }
    findingsById.set(finding.id, finding);
  }
  const exactIds = checkExactFindingIdSet(findingsById, EXPECTED_REDTEAM_FINDING_IDS, 'prior review bundle', errors);
  return { bundle, findingsById, exactIds };
}

function checkCurrentReviewBundle(root, record, findings, errors, { evaluateStatuses = true } = {}) {
  const bundleFile = readContentAddressedFile(
    root,
    record?.reviewBundle,
    REDTEAM_REVIEW_BUNDLE_PATH,
    'reviewBundle',
    errors,
  );
  if (!bundleFile) return null;
  const bundle = bundleFile.value;
  const expectedBundleKeys = [
    'schemaVersion', 'phase', 'requirementsRevision', 'architectureRevision', 'cycle', 'artifacts', 'findings',
  ];
  if (!sameKeys(bundle, expectedBundleKeys)) {
    errors.push(`current review bundle must contain exactly ${expectedBundleKeys.join(', ')}`);
    return null;
  }
  if (bundle.schemaVersion !== REVIEW_BUNDLE_SCHEMA || bundle.phase !== 'redteam'
      || bundle.requirementsRevision !== record?.requirementsRevision
      || bundle.architectureRevision !== record?.architectureRevision
      || bundle.cycle !== record?.cycle) {
    errors.push('current review bundle must bind the findings record cycle and revisions');
  }
  if (!sameKeys(bundle.artifacts, ['resolutions', 'termination'])) {
    errors.push('current review bundle artifacts must contain exactly resolutions and termination');
    return null;
  }

  const resolutionsFile = readContentAddressedFile(
    root,
    bundle.artifacts.resolutions,
    REDTEAM_RESOLUTIONS_PATH,
    'current review resolutions',
    errors,
  );
  const terminationFile = readContentAddressedFile(
    root,
    bundle.artifacts.termination,
    REDTEAM_TERMINATION_PATH,
    'current review termination',
    errors,
  );
  const resolutionStates = resolutionsFile
    ? checkReviewStateArtifact(resolutionsFile.value, 'findings', REVIEW_RESOLUTIONS_SCHEMA, bundle, 'current review resolutions', errors)
    : new Map();
  const terminationStates = terminationFile
    ? checkReviewStateArtifact(terminationFile.value, 'findingStates', REVIEW_TERMINATION_SCHEMA, bundle, 'current review termination', errors)
    : new Map();

  if (!Array.isArray(bundle.findings)) {
    errors.push('current review bundle findings must be an array');
    return null;
  }
  const bundleById = new Map();
  for (const [index, bundleFinding] of bundle.findings.entries()) {
    if (!checkBundleFindingShape(bundleFinding, index, errors)) continue;
    if (bundleById.has(bundleFinding.id)) {
      errors.push(`${bundleFinding.id} appears more than once in the current review bundle`);
      continue;
    }
    bundleById.set(bundleFinding.id, bundleFinding);
    for (const evidence of bundleFinding.evidence) {
      readContentAddressedFile(root, evidence, null, 'current review evidence', errors);
    }
  }
  const bundleIdsMatch = checkExactFindingIdSet(bundleById, EXPECTED_REDTEAM_FINDING_IDS, 'current review bundle', errors);
  const resolutionIdsMatch = checkExactFindingIdSet(
    resolutionStates,
    EXPECTED_REDTEAM_FINDING_IDS,
    'current review resolutions',
    errors,
  );
  const terminationIdsMatch = checkExactFindingIdSet(
    terminationStates,
    EXPECTED_REDTEAM_FINDING_IDS,
    'current review termination',
    errors,
  );
  const prior = checkPriorReviewBundle(root, record, errors);
  const idSetsMatch = bundleIdsMatch && resolutionIdsMatch && terminationIdsMatch && (prior?.exactIds ?? false);

  if (!idSetsMatch || !evaluateStatuses) {
    return { bundle, resolutionStates, terminationStates, prior, idSetsMatch };
  }

  for (const finding of findings) {
    if (!finding || !nonEmptyString(finding.id)) continue;
    const bundleFinding = bundleById.get(finding.id);
    if (!bundleFinding) continue;
    if (finding.reportedSeverity !== bundleFinding.reportedSeverity) {
      errors.push(`${finding.id} reportedSeverity does not match the current review bundle`);
    }
    if (finding.classification !== bundleFinding.classification) {
      errors.push(`${finding.id} classification does not match the current review bundle`);
    }
    if (finding.canonicalIssue !== bundleFinding.canonicalIssue) {
      errors.push(`${finding.id} canonicalIssue does not match the current review bundle`);
    }
    if (finding.status !== bundleFinding.statusTransition.to) {
      errors.push(`${finding.id} status does not match the current review bundle transition`);
    }
    const priorFinding = prior?.findingsById.get(finding.id);
    if (priorFinding && bundleFinding.statusTransition.from !== priorFinding.status) {
      errors.push(`${finding.id} current review transition does not begin at the prior review status`);
    }
    const evidencePaths = Array.isArray(bundleFinding.evidence)
      ? bundleFinding.evidence.map(evidence => evidence?.path)
      : [];
    if (!sameStringArray(finding.evidence, evidencePaths)) {
      errors.push(`${finding.id} evidence paths do not match the current review bundle`);
    }
    if (resolutionStates.get(finding.id) !== finding.status) {
      errors.push(`${finding.id} status does not match current review resolutions`);
    }
    if (terminationStates.get(finding.id) !== finding.status) {
      errors.push(`${finding.id} status does not match current review termination`);
    }
  }
  return {
    bundle,
    resolutionStates,
    terminationStates,
    prior,
    idSetsMatch,
  };
}

function failedReceiptProblemIds(receipt) {
  const problems = receipt?.data?.problems;
  if (!Array.isArray(problems) || problems.length === 0) return null;
  const ids = problems.map(problem => {
    if (typeof problem !== 'string') return null;
    const match = /^(RT-R58-(?:01|02|04)): ([\x20-\x7e]+)$/.exec(problem);
    if (!match || match[2].includes(':') || /\bRT-R\d{2}-\d{2}\b/.test(match[2])) return null;
    return match[1];
  });
  if (!ids.every(id => id !== null && MANIFEST_DISPOSITIONED_PROBLEM_IDS.has(id))
      || new Set(ids).size !== ids.length) {
    return null;
  }
  return ids;
}

function latestRedteamGateReceipt(receipts) {
  return receipts.findLast(candidate => candidate.type === 'gate' && candidate.phase === 'redteam') ?? null;
}

function redteamGateResult(root, receipts, errors) {
  const receipt = latestRedteamGateReceipt(receipts);
  if (!receipt) {
    errors.push('latest redteam gate receipt is missing');
    return null;
  }
  if (!['PASSED', 'FAILED', 'OVERRIDDEN'].includes(receipt.result)) {
    errors.push(`latest redteam gate receipt ${receipt.id} has unsupported result ${receipt.result}`);
    return null;
  }
  if (!isGateReceiptAuthoritative(root, receipt)) {
    errors.push(`latest redteam gate receipt ${receipt.id} is not authoritative`);
    return null;
  }
  const failedProblemIds = receipt.result === 'FAILED' ? failedReceiptProblemIds(receipt) : [];
  if (receipt.result === 'FAILED' && failedProblemIds === null) {
    errors.push(
      `latest redteam gate receipt ${receipt.id} FAILED with problems outside the manifest-dispositioned finding set`,
    );
    return null;
  }
  return { result: receipt.result, receipt, receipts, failedProblemIds };
}

function checkAuthoritativeRedteamEvidenceReceipts(root, receipts, gateReceipt, errors) {
  let run;
  try {
    run = readJson(join(root, 'gates/runs/redteam.json'));
  } catch (error) {
    errors.push(`redteam evidence run could not be read: ${error.message}`);
    return;
  }
  const required = [
    ['R1', REDTEAM_DOUBT_LOOP_PATH],
    ['R2', REDTEAM_FINDINGS_PATH],
    ['R3', REDTEAM_RESOLUTIONS_PATH],
    ['R4', REDTEAM_TERMINATION_PATH],
    ['R5', REDTEAM_THREAT_MODEL_PATH],
  ];
  const gateReceiptIndex = gateReceipt ? receipts.findIndex(candidate => candidate.id === gateReceipt.id) : -1;
  for (const [itemId, artifactPath] of required) {
    const receiptId = run?.items?.[itemId]?.receipt;
    const receipt = receipts.find(candidate => candidate.id === receiptId);
    if (!receipt || run?.items?.[itemId]?.status !== 'RUN') {
      errors.push(`${itemId} does not reference an authoritative current redteam evidence receipt`);
      continue;
    }
    try {
      const problem = validateGateEvidenceReceipt(root, 'redteam', itemId, receipt);
      if (problem) errors.push(`${itemId} evidence receipt ${receipt.id} ${problem}`);
    } catch (error) {
      errors.push(`${itemId} evidence receipt ${receipt.id} could not be validated: ${error.message}`);
    }
    const receiptIndex = receipts.findIndex(candidate => candidate.id === receipt.id);
    if (gateReceiptIndex === -1 || receiptIndex === -1 || receiptIndex >= gateReceiptIndex) {
      errors.push(`${itemId} evidence receipt ${receipt.id} must precede the latest redteam gate receipt`);
    }
    const receiptPath = `receipts/${receipt.id}.json`;
    if (!gateReceipt || !Object.hasOwn(gateReceipt.inputHashes ?? {}, receiptPath)) {
      errors.push(`${itemId} receipt ${receipt.id} is not bound by the latest redteam gate receipt`);
    }
    try {
      if (receipt.inputHashes?.[artifactPath] !== hashFile(join(root, artifactPath))) {
        errors.push(`${itemId} receipt ${receipt.id} does not bind current ${artifactPath}`);
      }
    } catch (error) {
      errors.push(`${itemId} receipt ${receipt.id} could not verify ${artifactPath}: ${error.message}`);
    }
  }
}

function regularRepositoryFile(root, relativePath, label) {
  const { repositoryRoot, lexical } = containedPath(root, relativePath, label);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular repository-contained file`);
  }
  const physical = realpathSync(lexical);
  if (!isRepositoryContained(repositoryRoot, physical) || physical !== lexical) {
    throw new Error(`${label} must be a regular repository-contained file`);
  }
  return physical;
}

function readRegularJson(root, relativePath, label, errors) {
  try {
    return readJson(regularRepositoryFile(root, relativePath, label));
  } catch (error) {
    errors.push(`${label} ${relativePath} could not be read: ${error.message}`);
    return null;
  }
}

function checkCurrentReviewEvidenceSemantics(root, record, errors) {
  const expectedIds = EXPECTED_REDTEAM_FINDING_IDS;
  const expectedRevisionFields = artifact => artifact?.phase === 'redteam'
    && artifact.requirementsRevision === record?.requirementsRevision
    && artifact.architectureRevision === record?.architectureRevision
    && artifact.cycle === record?.cycle;
  const doubtLoop = readRegularJson(root, REDTEAM_DOUBT_LOOP_PATH, 'current review doubt loop', errors);
  if (doubtLoop) {
    const expectedKeys = ['schemaVersion', 'phase', 'requirementsRevision', 'architectureRevision', 'cycle', 'reviewContract', 'reviewedFindingIds'];
    if (!sameKeys(doubtLoop, expectedKeys)) {
      errors.push(`current review doubt loop must contain exactly ${expectedKeys.join(', ')}`);
    }
    if (doubtLoop.schemaVersion !== REVIEW_DOUBT_LOOP_SCHEMA || !expectedRevisionFields(doubtLoop)) {
      errors.push('current review doubt loop must bind the current redteam cycle and revisions');
    }
    if (!sameKeys(doubtLoop.reviewContract, ['artifactOnly', 'authorReasoningIncluded', 'issuesOnly'])
        || doubtLoop.reviewContract.artifactOnly !== true
        || doubtLoop.reviewContract.authorReasoningIncluded !== false
        || doubtLoop.reviewContract.issuesOnly !== true) {
      errors.push('current review doubt loop must enforce the artifact-only issues-only contract');
    }
    if (!sameIdSet(doubtLoop.reviewedFindingIds ?? [], expectedIds)) {
      errors.push('current review doubt loop reviewedFindingIds must exactly match the review finding set');
    }
  }

  const evidence = readRegularJson(root, REDTEAM_EVIDENCE_PATH, 'current review evidence', errors);
  if (evidence) {
    const expectedKeys = ['schemaVersion', 'phase', 'requirementsRevision', 'architectureRevision', 'cycle', 'reviewedFindingIds', 'record'];
    if (!sameKeys(evidence, expectedKeys)) {
      errors.push(`current review evidence must contain exactly ${expectedKeys.join(', ')}`);
    }
    if (evidence.schemaVersion !== REVIEW_EVIDENCE_SCHEMA || !expectedRevisionFields(evidence)
        || !nonEmptyString(evidence.record)) {
      errors.push('current review evidence must bind the current redteam cycle and revisions');
    }
    if (!sameIdSet(evidence.reviewedFindingIds ?? [], expectedIds)) {
      errors.push('current review evidence reviewedFindingIds must exactly match the review finding set');
    }
  }

  const threatModel = readRegularJson(root, REDTEAM_THREAT_MODEL_PATH, 'current review threat model', errors);
  if (threatModel) {
    const expectedKeys = ['schemaVersion', 'phase', 'requirementsRevision', 'architectureRevision', 'cycle', 'method', 'categories', 'reviewedFindingIds'];
    const categories = ['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'Denial of Service', 'Elevation of Privilege'];
    if (!sameKeys(threatModel, expectedKeys)) {
      errors.push(`current review threat model must contain exactly ${expectedKeys.join(', ')}`);
    }
    if (threatModel.schemaVersion !== REVIEW_THREAT_MODEL_SCHEMA || !expectedRevisionFields(threatModel)
        || threatModel.method !== 'STRIDE' || !sameStringArray(threatModel.categories, categories)) {
      errors.push('current review threat model must bind the current STRIDE review');
    }
    if (!sameIdSet(threatModel.reviewedFindingIds ?? [], expectedIds)) {
      errors.push('current review threat model reviewedFindingIds must exactly match the review finding set');
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkFindingEvidenceReferences(root, record, currentReview, errors) {
  const references = record?.evidenceReferences;
  if (!isPlainObject(references) || !sameIdSet(Object.keys(references ?? {}), EXPECTED_REDTEAM_FINDING_IDS)) {
    errors.push('redteam evidenceReferences must contain exactly one entry for every review finding');
    return;
  }
  let manifest;
  try {
    manifest = checkManifest(root);
  } catch (error) {
    errors.push(`test manifest could not be checked for redteam evidence references: ${error.message}`);
    return;
  }
  if (!manifest.ok) {
    errors.push(`test manifest is invalid for redteam evidence references: ${manifest.errors.join('; ')}`);
    return;
  }
  const testPaths = new Set(Object.values(manifest.suites).flatMap(suite => suite.files));
  for (const [findingId, findingReferences] of Object.entries(references)) {
    if (!Array.isArray(findingReferences) || findingReferences.length === 0) {
      errors.push(`${findingId} must contain at least one content-addressed evidence reference`);
      continue;
    }
    const bundleFinding = currentReview?.bundle?.findings.find(finding => finding.id === findingId);
    for (const [index, reference] of findingReferences.entries()) {
      const label = `${findingId} evidenceReferences[${index}]`;
      if (!sameKeys(reference, ['path', 'sha256', 'testPath', 'testName'])
          || !nonEmptyString(reference.path) || !SHA256.test(reference.sha256)
          || !nonEmptyString(reference.testPath) || !nonEmptyString(reference.testName)) {
        errors.push(`${label} must contain a content address and named manifest test`);
        continue;
      }
      try {
        if (hashFile(regularRepositoryFile(root, reference.path, label)) !== reference.sha256) {
          errors.push(`${label} digest does not match its content address`);
        }
      } catch (error) {
        errors.push(`${label} could not verify its content address: ${error.message}`);
      }
      if (!bundleFinding?.evidence?.some(evidence => evidence.path === reference.path && evidence.sha256 === reference.sha256)) {
        errors.push(`${label} is not referenced by the current review bundle`);
      }
      if (!testPaths.has(reference.testPath)) {
        errors.push(`${label} testPath is not present in the test manifest`);
        continue;
      }
      try {
        const source = readFileSync(regularRepositoryFile(root, reference.testPath, label), 'utf8');
        const testName = escapeRegExp(reference.testName);
        if (!(new RegExp(`\\b(?:test|it)\\s*\\(\\s*(['\"])${testName}\\1`).test(source))) {
          errors.push(`${label} testName is not present in ${reference.testPath}`);
        }
      } catch (error) {
        errors.push(`${label} testPath could not be read: ${error.message}`);
      }
    }
  }
}

function reviewedTreeDigest(root, attestationPath) {
  const repositoryRoot = realpathSync(root);
  const excludedDirectoryNames = new Set(['.git', '.worktrees', 'node_modules']);
  const entries = [];
  function visit(relativePath) {
    const absolutePath = join(repositoryRoot, relativePath);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`reviewed tree contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) {
        const child = relativePath === '.' ? entry : `${relativePath}/${entry}`;
        if (child !== attestationPath && !child.split('/').some(component => excludedDirectoryNames.has(component))) {
          visit(child);
        }
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`reviewed tree contains a non-regular entry: ${relativePath}`);
    entries.push(`${relativePath}\0${hashFile(absolutePath)}`);
  }
  visit('.');
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}

function checkRedteamReviewAttestation(root, currentReview, errors) {
  let revision;
  try {
    revision = readJson(join(root, REQUIREMENTS_PATH)).revision;
  } catch (error) {
    errors.push(`redteam review attestation could not read ${REQUIREMENTS_PATH}: ${error.message}`);
    return null;
  }
  if (!positiveInteger(revision)) {
    errors.push('redteam review attestation cannot be located without a valid requirements revision');
    return null;
  }
  const path = `${OWNER_APPROVALS_DIR}/redteam-review-attestation-${revision}.json`;
  const artifact = readRegularJson(root, path, 'redteam review attestation', errors);
  if (!artifact) return null;
  const expectedKeys = ['schema', 'authority', 'action', 'phase', 'itemId', 'rationale', 'approvalToken', 'subjectHashes'];
  if (!sameKeys(artifact, expectedKeys)) {
    errors.push(`redteam review attestation ${path} must contain exactly ${expectedKeys.join(', ')}`);
    return null;
  }
  if (artifact.schema !== 'v4-owner-approval-v2' || artifact.authority !== 'OWNER'
      || artifact.action !== REVIEW_ATTESTATION_ACTION || artifact.phase !== 'redteam'
      || artifact.itemId !== null || !nonEmptyString(artifact.rationale)) {
    errors.push(`redteam review attestation ${path} has an invalid owner approval subject`);
  }
  if (artifact.approvalToken !== SIGNED_APPROVAL_TOKEN) {
    errors.push(`redteam review attestation ${path} requires ${SIGNED_APPROVAL_TOKEN}`);
  }
  if (!sameKeys(artifact.subjectHashes, ['reviewedTree', REDTEAM_REVIEW_BUNDLE_PATH])
      || !SHA256.test(artifact.subjectHashes?.reviewedTree)
      || !SHA256.test(artifact.subjectHashes?.[REDTEAM_REVIEW_BUNDLE_PATH])) {
    errors.push(`redteam review attestation ${path} must bind the reviewed tree and current review bundle`);
    return null;
  }
  try {
    if (currentReview?.bundle && artifact.subjectHashes[REDTEAM_REVIEW_BUNDLE_PATH]
        !== hashFile(join(root, REDTEAM_REVIEW_BUNDLE_PATH))) {
      errors.push(`redteam review attestation ${path} current review bundle hash does not match`);
    }
    if (artifact.subjectHashes.reviewedTree !== reviewedTreeDigest(root, path)) {
      errors.push(`redteam review attestation ${path} reviewed tree hash does not match`);
    }
  } catch (error) {
    errors.push(`redteam review attestation ${path} could not verify its subject hashes: ${error.message}`);
  }
  return { path, artifact };
}

function checkRedteamFindings(root, errors, deploymentManifest) {
  let record;
  try {
    record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  } catch (error) {
    errors.push(`redteam findings could not be read at ${REDTEAM_FINDINGS_PATH}: ${error.message}`);
    return { checked: false };
  }

  if (record?.schemaVersion !== 2) errors.push(`${REDTEAM_FINDINGS_PATH} schemaVersion must be 2`);
  if (record?.phase !== 'redteam') errors.push(`${REDTEAM_FINDINGS_PATH} phase must be redteam`);
  checkRedteamRevisions(root, record, errors);
  checkRedteamLifecycleMetadata(record, errors);

  const findings = Array.isArray(record?.findings) ? record.findings : [];
  if (!Array.isArray(record?.findings)) errors.push(`${REDTEAM_FINDINGS_PATH} findings must be an array`);
  const idCounts = new Map();
  for (const [index, finding] of findings.entries()) {
    checkFindingShape(finding, index, errors);
    if (nonEmptyString(finding?.id)) idCounts.set(finding.id, (idCounts.get(finding.id) ?? 0) + 1);
  }
  for (const id of EXPECTED_REDTEAM_FINDING_IDS) {
    const count = idCounts.get(id) ?? 0;
    if (count === 0) errors.push(`${id} is missing from the required redteam set`);
    if (count > 1) errors.push(`${id} appears ${count} times in the required redteam set`);
  }
  for (const [id] of idCounts) {
    if (!EXPECTED_REDTEAM_FINDING_IDS.includes(id)) errors.push(`${id} is not in the required redteam set`);
  }
  const recordIdsMatch = sameIdSet([...idCounts.keys()], EXPECTED_REDTEAM_FINDING_IDS)
    && [...idCounts.values()].every(count => count === 1);
  if (!countsMatch(record?.counts, expectedCounts(findings))) {
    errors.push('redteam counts must exactly match the findings');
  }

  const currentReview = checkCurrentReviewBundle(root, record, findings, errors, {
    evaluateStatuses: recordIdsMatch,
  });
  checkCurrentReviewEvidenceSemantics(root, record, errors);
  checkFindingEvidenceReferences(root, record, currentReview, errors);
  checkRedteamReviewAttestation(root, currentReview, errors);

  let receipts = [];
  try {
    receipts = listReceipts(root);
  } catch (error) {
    errors.push(`redteam receipts could not be read: ${error.message}`);
  }
  const latestReceipt = latestRedteamGateReceipt(receipts);
  checkAuthoritativeRedteamEvidenceReceipts(root, receipts, latestReceipt, errors);

  if (!recordIdsMatch || !currentReview?.idSetsMatch) {
    return {
      checked: true,
      findingCount: findings.length,
      openBlocking: [],
      openNonBlockingByManifest: [],
      gateResult: null,
      gateReceiptId: latestReceipt?.id ?? null,
    };
  }

  const gate = redteamGateResult(root, receipts, errors);
  const openBlocking = [];
  const openNonBlockingByManifest = [];
  for (const finding of findings) {
    if (!finding || !nonEmptyString(finding.id) || RESOLVED_STATUSES.has(finding.status)) continue;
    if (!FINDING_STATUSES.has(finding.status)) continue;
    if (NON_BLOCKING_BY_MANIFEST_IDS.has(finding.id) && deploymentManifest.checked) {
      openNonBlockingByManifest.push(finding.id);
      continue;
    }
    if (NON_BLOCKING_BY_MANIFEST_IDS.has(finding.id)) {
      errors.push(
        `${finding.id} is open and blocks release readiness until the deployment manifest validates; `
        + 'owner-approval artifacts cannot override this rule.',
      );
    } else {
      errors.push(`${finding.id} is open (status ${finding.status}) and has no non-blocking disposition path: it blocks release readiness.`);
    }
    openBlocking.push(finding.id);
  }

  const unresolvedFindingIds = findings
    .filter(finding => finding && nonEmptyString(finding.id) && FINDING_STATUSES.has(finding.status) && !RESOLVED_STATUSES.has(finding.status))
    .map(finding => finding.id);
  if (gate?.result === 'FAILED') {
    const unresolvedFindingIdSet = new Set(unresolvedFindingIds);
    for (const id of gate.failedProblemIds) {
      if (!unresolvedFindingIdSet.has(id)) {
        errors.push(`${id} is not unresolved in the current review bundle`);
      }
    }
  }
  if (gate?.result === 'PASSED' && unresolvedFindingIds.length > 0) {
    errors.push(
      `latest authoritative redteam gate receipt ${gate.receipt.id} is PASSED while ${REDTEAM_FINDINGS_PATH} still lists open `
      + `findings (${unresolvedFindingIds.join(', ')}); a PASSED gate can never coexist with open findings.`,
    );
  }

  return {
    checked: true,
    findingCount: findings.length,
    openBlocking,
    openNonBlockingByManifest,
    gateResult: gate?.result ?? null,
    gateReceiptId: gate?.receipt.id ?? null,
  };
}

export function verifyReleaseReady(rootPath, { readdirSync: readDirectory = readdirSync } = {}) {
  const root = resolve(rootPath);
  const errors = [];
  const deploymentManifest = checkDeploymentManifest(root, errors);
  const traceability = checkTraceability(root, errors);
  const approvalArtifacts = checkApprovalArtifactConsistency(root, errors, { readDirectory });
  const requirementsAuthorization = checkCurrentRequirementsAuthorization(root, errors);
  const redteam = checkRedteamFindings(root, errors, deploymentManifest);

  return {
    schemaVersion: 1,
    result: errors.length === 0 ? 'READY' : 'NOT_READY',
    errors,
    deploymentManifest,
    traceability,
    approvalArtifacts,
    requirementsAuthorization,
    redteam,
  };
}

function main() {
  const report = verifyReleaseReady(process.cwd());
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'READY') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
