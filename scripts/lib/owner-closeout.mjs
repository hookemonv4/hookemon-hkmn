#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  OWNER_ACTIONS, OWNER_APPROVAL_SCHEMA, readOwnerApproval,
} from './gates.mjs';
import {
  listTasks, openLedger, prepareTaskDeferralRebind, projectTasks, rebindTaskDeferral,
} from './ledger.mjs';
import { hashFile, readJson, writeJson } from './util.mjs';

export const CLOSEOUT_APPROVALS_DIR = 'decisions/owner-approvals';
export const TASK_DEFERRALS_DIR = 'decisions/task-deferrals';
export const REQUIREMENTS_PATH = 'specs/requirements.json';
export const REDTEAM_REVIEW_BUNDLE_PATH = 'qa/redteam/current-review-bundle.json';
export const DEPENDENCY_VERIFICATION_PATH = 'product/dependency-verification.json';
export const PREFLIGHT_PACKAGE_MANIFEST_PATH = 'release/phase3/package/package-manifest.json';
export const FORMAL_OWNER_TOKEN = 'OWNER APPROVED';
export const UNSIGNED_DRAFT_MARKER = 'DRAFT_UNSIGNED';

const FORMAL_OWNER_TOKENS = new Set(['OWNER APPROVED', 'OWNER AUTHORIZED']);
const SPEC_S5_SUBJECTS = Object.freeze([
  'gates/spec.json',
  'policy/policy.json',
  REQUIREMENTS_PATH,
]);
const PREFLIGHT_INPUT_CODES = Object.freeze([
  'BUILDER_IDENTITY_PENDING',
  'OWNER_WALLET_FUNDING_PENDING',
  'PROVIDER_API_KEY_PENDING',
  'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
]);
const REDTEAM_ATTESTATION_KEYS = Object.freeze([
  'action', 'approvalToken', 'authority', 'itemId', 'phase', 'rationale', 'schema', 'subjectHashes',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function markerPresent(value) {
  if (typeof value === 'string') return value.includes(UNSIGNED_DRAFT_MARKER);
  if (Array.isArray(value)) return value.some(markerPresent);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => key.includes(UNSIGNED_DRAFT_MARKER) || markerPresent(nested));
}

function safeApprovalDirectory(root) {
  const repositoryRoot = realpathSync(root);
  const directory = resolve(repositoryRoot, CLOSEOUT_APPROVALS_DIR);
  const rel = relative(repositoryRoot, directory);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('owner approval directory escapes the repository');
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) {
    throw new Error('owner approval directory must be a regular repository directory');
  }
  return directory;
}

function regularRepositoryDirectory(root, input, label) {
  if (typeof input !== 'string' || !input || input.startsWith('/') || input.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be a repository-relative directory path`);
  }
  const repositoryRoot = realpathSync(root);
  const lexical = resolve(repositoryRoot, input);
  const rel = relative(repositoryRoot, lexical);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} escapes the repository`);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(lexical) !== lexical) {
    throw new Error(`${label} must be a regular repository directory`);
  }
  return lexical;
}

function regularRepositoryFile(root, input, label) {
  if (typeof input !== 'string' || !input || input.startsWith('/') || input.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be a repository-relative file path`);
  }
  const repositoryRoot = realpathSync(root);
  const lexical = resolve(repositoryRoot, input);
  const rel = relative(repositoryRoot, lexical);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${label} escapes the repository`);
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(lexical) !== lexical) {
    throw new Error(`${label} must be a regular repository file`);
  }
  return lexical;
}

function approvalArtifactFiles(root) {
  const directory = safeApprovalDirectory(root);
  return readdirSync(directory).sort().filter(name => name.endsWith('.json')).map(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
      throw new Error(`owner approval artifact must be a regular file: ${name}`);
    }
    return `${CLOSEOUT_APPROVALS_DIR}/${name}`;
  });
}

function taskDeferralArtifactFiles(root) {
  const directory = regularRepositoryDirectory(root, TASK_DEFERRALS_DIR, 'task deferral directory');
  return readdirSync(directory).sort().filter(name => name.endsWith('.json')).map(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
      throw new Error(`task deferral artifact must be a regular file: ${name}`);
    }
    return `${TASK_DEFERRALS_DIR}/${name}`;
  });
}

function approvalArtifact(root, input) {
  return readJson(regularRepositoryFile(root, input, 'owner approval artifact'));
}

function taskDeferralArtifact(root, input) {
  return readJson(regularRepositoryFile(root, input, 'task deferral artifact'));
}

function requirementRevision(root) {
  const requirements = readJson(regularRepositoryFile(root, REQUIREMENTS_PATH, 'requirements'));
  if (!Number.isInteger(requirements?.revision) || requirements.revision < 1) {
    throw new Error(`${REQUIREMENTS_PATH} must contain a positive revision`);
  }
  return requirements.revision;
}

function sortedHashes(root, inputs) {
  return Object.fromEntries([...new Set(inputs)].sort().map(input => [
    input,
    hashFile(regularRepositoryFile(root, input, 'owner approval subject')),
  ]));
}

function writeArtifact(root, relativePath, artifact) {
  const directory = safeApprovalDirectory(root);
  if (!relativePath.startsWith(`${CLOSEOUT_APPROVALS_DIR}/`)) {
    throw new Error(`owner approval output is outside ${CLOSEOUT_APPROVALS_DIR}: ${relativePath}`);
  }
  const name = relativePath.slice(`${CLOSEOUT_APPROVALS_DIR}/`.length);
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name)) {
    throw new Error(`owner approval output has an invalid file name: ${relativePath}`);
  }
  const target = join(directory, name);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`owner approval output must not replace a symbolic link: ${relativePath}`);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`);
}

function currentSpecApprovalPath(revision) {
  return `${CLOSEOUT_APPROVALS_DIR}/closeout-revision-${revision}-spec-s5-approved.json`;
}

function currentRedteamAttestationPath(revision) {
  return `${CLOSEOUT_APPROVALS_DIR}/redteam-review-attestation-${revision}.json`;
}

function currentP1ApprovalPath(revision) {
  return `${CLOSEOUT_APPROVALS_DIR}/phase-3-revision-${revision}-dashboard-deferral-approved.json`;
}

function latestDraft(paths, matcher) {
  const matches = paths.filter(matcher);
  return matches.at(-1) ?? null;
}

function approvalValidatorResult(root, path, artifact) {
  try {
    if (!isPlainObject(artifact)) throw new Error('owner approval artifact must be an object');
    readOwnerApproval(root, path, {
      action: artifact.action,
      phase: artifact.phase,
      itemId: artifact.itemId,
      rationale: artifact.rationale,
      subjectInputs: Object.keys(artifact.subjectHashes ?? {}),
    });
    return { result: 'VALID' };
  } catch (error) {
    return { result: 'INVALID', error: error.message };
  }
}

function p1RebindDrafts(root, approvalRecords) {
  return taskDeferralArtifactFiles(root)
    .filter(path => /^decisions\/task-deferrals\/P1-011-revision-\d+-rebind-DRAFT\.json$/.test(path))
    .map(path => {
      let descriptor;
      try {
        descriptor = taskDeferralArtifact(root, path);
      } catch (error) {
        return { path, status: 'UNREADABLE', error: error.message };
      }
      const approval = approvalRecords.find(record => (
        record.artifact?.subjectHashes && Object.hasOwn(record.artifact.subjectHashes, path)
      ));
      const revision = Number(path.match(/revision-(\d+)-rebind-DRAFT\.json$/)?.[1]);
      return {
        path,
        revision: Number.isInteger(revision) ? revision : null,
        containsMarker: markerPresent(descriptor) || path.includes(UNSIGNED_DRAFT_MARKER),
        approvalPath: approval?.path ?? null,
        status: 'HISTORICAL_DRAFT',
        validator: {
          result: 'NOT_APPLICABLE',
          reason: 'validateTaskDeferralApproval accepts only the canonical P1-011 descriptor and a formal approval with canonical subjects.',
        },
      };
    });
}

function pinBumpSummary(root) {
  let verification;
  try {
    verification = readJson(regularRepositoryFile(root, DEPENDENCY_VERIFICATION_PATH, 'dependency verification record'));
  } catch (error) {
    return { status: 'OPEN_FACT', path: DEPENDENCY_VERIFICATION_PATH, reason: error.message };
  }
  const record = verification?.candidateVerification?.controlGatePinBump ?? null;
  if (record === null) {
    return {
      status: 'ABSENT',
      path: DEPENDENCY_VERIFICATION_PATH,
      reason: 'No controlGatePinBump record exists. A valid pin bump needs the exact committed protected-base and candidate trees, pin bytes, base checker blob, and changed control digests.',
    };
  }
  return {
    status: 'PRESENT',
    path: DEPENDENCY_VERIFICATION_PATH,
    containsMarker: markerPresent(record),
    formal: String(record?.approvalToken ?? '').trim() === FORMAL_OWNER_TOKEN,
    record,
  };
}

export function externalPreflightInputs(rootPath) {
  const root = resolve(rootPath);
  const manifest = readJson(regularRepositoryFile(root, PREFLIGHT_PACKAGE_MANIFEST_PATH, 'Phase 3 preflight package manifest'));
  if (manifest?.schemaVersion !== 'hookemon.phase3.local-package-manifest.v1'
      || !Array.isArray(manifest.unverified)) {
    throw new Error(`${PREFLIGHT_PACKAGE_MANIFEST_PATH} has no valid external preflight input list`);
  }
  const codes = manifest.unverified.map(input => input?.code).sort();
  const expected = [...PREFLIGHT_INPUT_CODES].sort();
  if (codes.length !== expected.length || codes.some((code, index) => code !== expected[index])) {
    throw new Error(`${PREFLIGHT_PACKAGE_MANIFEST_PATH} has unclassified preflight inputs`);
  }
  if (manifest.unverified.some(input => !isPlainObject(input)
      || typeof input.path !== 'string' || !input.path
      || typeof input.reason !== 'string' || !input.reason
      || typeof input.blocking !== 'boolean')) {
    throw new Error(`${PREFLIGHT_PACKAGE_MANIFEST_PATH} has malformed preflight inputs`);
  }
  return manifest.unverified
    .map(({ code, path, reason, blocking }) => ({ code, path, reason, blocking }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

export function inventoryOwnerApprovals(rootPath) {
  const root = resolve(rootPath);
  const unsigned = [];
  const selfContradictory = [];
  const artifacts = [];
  for (const path of approvalArtifactFiles(root)) {
    let artifact;
    try {
      artifact = approvalArtifact(root, path);
    } catch (error) {
      artifacts.push({ path, status: 'UNREADABLE', error: error.message });
      continue;
    }
    const containsMarker = markerPresent(artifact);
    const formal = FORMAL_OWNER_TOKENS.has(String(artifact?.approvalToken ?? '').trim());
    const record = {
      path,
      artifact,
      containsMarker,
      formal,
      validator: approvalValidatorResult(root, path, artifact),
    };
    artifacts.push(record);
    if (containsMarker && formal) selfContradictory.push(path);
    else if (containsMarker) unsigned.push(path);
  }
  const namedOverrideDrafts = artifacts
    .filter(record => record.artifact?.action === OWNER_ACTIONS.OVERRIDE
      && (record.path.includes(UNSIGNED_DRAFT_MARKER) || /-DRAFT\.json$/i.test(record.path)))
    .map(({ path, formal, validator }) => ({
      path,
      formal,
      validator,
      status: 'STALE_OVERRIDE_DRAFT',
      reason: 'A gate override must bind the current failed evaluation closure and use a lowercase formal approval path. This historical draft is reported but cannot be reused.',
    }));
  return { artifacts, unsigned, selfContradictory, namedOverrideDrafts };
}

export function closeoutSummary(rootPath) {
  const root = resolve(rootPath);
  const revision = requirementRevision(root);
  const inventory = inventoryOwnerApprovals(root);
  const baseline = `${CLOSEOUT_APPROVALS_DIR}/revision-${revision}-baseline.json`;
  const redteamDraft = latestDraft(inventory.unsigned, path => /\/redteam-review-attestation-\d+\.json$/.test(path));
  const p1Drafts = p1RebindDrafts(root, inventory.artifacts);
  const p1Draft = p1Drafts.at(-1)?.path ?? null;
  const revisionBaselineArtifacts = inventory.unsigned
    .filter(path => /\/revision-(?:59|62|63|64|65)-(?:baseline|fee-policy|operations-wallet|snapshot-payout)\.json$/.test(path));
  return {
    schemaVersion: 1,
    revision,
    inventory: {
      unsigned: inventory.unsigned,
      selfContradictory: inventory.selfContradictory,
      namedOverrideDrafts: inventory.namedOverrideDrafts,
      p1RebindDrafts: p1Drafts,
      revisionBaselineArtifacts,
      absentRevisionBaselines: [60, 61],
    },
    formalApprovals: [
      {
        kind: 'spec-s5',
        source: baseline,
        output: currentSpecApprovalPath(revision),
        status: existsSync(join(root, baseline)) ? 'READY_TO_MATERIALIZE' : 'OPEN_FACT',
      },
      {
        kind: 'redteam-review-attestation',
        source: redteamDraft,
        output: currentRedteamAttestationPath(revision),
        status: existsSync(join(root, REDTEAM_REVIEW_BUNDLE_PATH)) ? 'READY_AFTER_GATE_WALK' : 'OPEN_FACT',
      },
      {
        kind: 'p1-011-deferral-rebind',
        source: p1Draft,
        output: currentP1ApprovalPath(revision),
        status: p1Draft ? 'READY_IF_LEDGER_RETAINS_DEFERRED_P1_011' : 'OPEN_FACT',
      },
    ],
    deferredTaskDraft: p1Draft,
    pinBump: pinBumpSummary(root),
    historicalDraftPolicy: 'Historical drafts and contradictory historical S5 artifacts are reported but never rewritten. Current formal approvals are separate, validator-shaped successors.',
  };
}

function assertUnchangedFormalApproval(root, path, expected) {
  if (!existsSync(join(root, path))) return false;
  readOwnerApproval(root, path, expected);
  return true;
}

export function materializeSpecApproval(rootPath) {
  const root = resolve(rootPath);
  const revision = requirementRevision(root);
  const source = `${CLOSEOUT_APPROVALS_DIR}/revision-${revision}-baseline.json`;
  if (!existsSync(join(root, source))) {
    throw new Error(`current requirements revision ${revision} has no baseline draft at ${source}`);
  }
  const output = currentSpecApprovalPath(revision);
  const rationale = `Owner approves requirements revision ${revision} for the Phase 3 closeout. This formal S5 authorization is derived from ${source} and does not authorize deployment, credentials, signing, broadcast, asset movement, spending, or publication.`;
  const expected = {
    action: OWNER_ACTIONS.EVIDENCE,
    phase: 'spec',
    itemId: 'S5',
    rationale,
    subjectInputs: SPEC_S5_SUBJECTS,
  };
  if (assertUnchangedFormalApproval(root, output, expected)) return { output, rationale, reused: true };

  writeArtifact(root, output, {
    schema: OWNER_APPROVAL_SCHEMA,
    authority: 'OWNER',
    action: OWNER_ACTIONS.EVIDENCE,
    phase: 'spec',
    itemId: 'S5',
    rationale,
    approvalToken: FORMAL_OWNER_TOKEN,
    subjectHashes: sortedHashes(root, SPEC_S5_SUBJECTS),
  });
  readOwnerApproval(root, output, expected);
  return { output, rationale, reused: false };
}

export function materializeP1DeferralRebind(rootPath) {
  const root = resolve(rootPath);
  const revision = requirementRevision(root);
  const db = openLedger(root);
  try {
    const task = listTasks(db).find(candidate => candidate.id === 'P1-011');
    if (!task) return { skipped: true, reason: 'P1-011 is absent from the ledger' };
    if (task.status !== 'deferred') {
      throw new Error(`P1-011 must already be deferred before a closeout rebind (found ${task.status})`);
    }

    const rebind = prepareTaskDeferralRebind(db, task.id);
    const stagedDraft = p1RebindDrafts(root, inventoryOwnerApprovals(root).artifacts).at(-1);
    if (!stagedDraft?.path) {
      throw new Error('P1-011 has no staged rebind draft to carry into the current formal successor');
    }
    const stagedDescriptor = taskDeferralArtifact(root, stagedDraft.path);
    if (stagedDescriptor?.taskId !== task.id || stagedDescriptor?.phase !== task.phase
        || stagedDescriptor?.action !== OWNER_ACTIONS.TASK_DEFER) {
      throw new Error('P1-011 staged rebind draft does not describe the deferred ledger task');
    }
    const descriptorInput = `${TASK_DEFERRALS_DIR}/P1-011.json`;
    const decisionPath = stagedDescriptor.decision?.path;
    const designPath = stagedDescriptor.design?.path;
    if (typeof decisionPath !== 'string' || typeof designPath !== 'string') {
      throw new Error('P1-011 staged rebind draft has invalid decision or design paths');
    }
    const requirementsPath = regularRepositoryFile(root, REQUIREMENTS_PATH, 'requirements');
    const decisionFile = regularRepositoryFile(root, decisionPath, 'P1-011 deferral decision');
    const designFile = regularRepositoryFile(root, designPath, 'P1-011 deferral design');
    const prestate = rebind.prestate;
    const prestateFingerprint = rebind.prestateFingerprint;
    const rationale = `Owner confirms that P1-011 remains deferred under the manual one-cycle boundary and rebinds that deferred task to requirements revision ${revision}. This authorization does not authorize deployment, credentials, signing, broadcast, asset movement, spending, or publication.`;
    const descriptor = {
      schema: 'v4-task-deferral-v1',
      action: OWNER_ACTIONS.TASK_DEFER,
      taskId: task.id,
      phase: task.phase,
      targetStatus: 'deferred',
      rationale,
      prestate,
      prestateFingerprint,
      requirements: {
        path: REQUIREMENTS_PATH,
        revision,
        sha256: hashFile(requirementsPath),
      },
      decision: {
        path: decisionPath,
        sha256: hashFile(decisionFile),
      },
      design: {
        path: designPath,
        sha256: hashFile(designFile),
      },
    };

    const approvalInput = currentP1ApprovalPath(revision);
    const expected = {
      action: OWNER_ACTIONS.TASK_DEFER,
      phase: task.phase,
      itemId: task.id,
      rationale,
      subjectInputs: [descriptorInput, 'policy/policy.json'],
    };
    if (existsSync(join(root, approvalInput))) {
      const currentDescriptor = taskDeferralArtifact(root, descriptorInput);
      if (JSON.stringify(currentDescriptor) !== JSON.stringify(descriptor)) {
        throw new Error(`current P1-011 descriptor differs from the expected revision ${revision} successor; do not overwrite a formal owner artifact`);
      }
      readOwnerApproval(root, approvalInput, expected);
    } else {
      writeJson(join(root, descriptorInput), descriptor);
      writeArtifact(root, approvalInput, {
        schema: OWNER_APPROVAL_SCHEMA,
        authority: 'OWNER',
        action: OWNER_ACTIONS.TASK_DEFER,
        phase: task.phase,
        itemId: task.id,
        rationale,
        approvalToken: FORMAL_OWNER_TOKEN,
        subjectHashes: sortedHashes(root, [descriptorInput, 'policy/policy.json']),
      });
      readOwnerApproval(root, approvalInput, expected);
    }
    const rebound = rebindTaskDeferral(db, task.id, {
      expectedBinding: rebind.binding,
      descriptorInput,
      approvalInput,
    });
    projectTasks(db, root);
    return {
      approvalInput,
      descriptorInput,
      sourceDraft: stagedDraft.path,
      rationale,
      authority: Boolean(rebound.approvalInput),
    };
  } finally {
    db.close();
  }
}

export function reviewedTreeDigest(rootPath, attestationPath) {
  const root = realpathSync(rootPath);
  const excludedDirectoryNames = new Set(['.git', '.worktrees', 'node_modules']);
  const entries = [];
  function visit(relativePath) {
    const absolutePath = join(root, relativePath);
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

function matchesCurrentRedteamAttestation(root, current, output, rationale, bundlePath) {
  return Boolean(current && hasExactKeys(current, REDTEAM_ATTESTATION_KEYS)
    && !markerPresent(current)
    && current.schema === OWNER_APPROVAL_SCHEMA
    && current.authority === 'OWNER'
    && current.approvalToken === FORMAL_OWNER_TOKEN
    && current.rationale === rationale
    && current.action === 'REDTEAM_REVIEW_ATTESTATION'
    && current.phase === 'redteam'
    && current.itemId === null
    && hasExactKeys(current.subjectHashes, ['reviewedTree', REDTEAM_REVIEW_BUNDLE_PATH])
    && current.subjectHashes?.[REDTEAM_REVIEW_BUNDLE_PATH] === hashFile(bundlePath)
    && current.subjectHashes?.reviewedTree === reviewedTreeDigest(root, output));
}

export function materializeRedteamAttestation(rootPath) {
  const root = resolve(rootPath);
  const revision = requirementRevision(root);
  if (!existsSync(join(root, REDTEAM_REVIEW_BUNDLE_PATH))) {
    throw new Error(`current redteam review bundle is missing at ${REDTEAM_REVIEW_BUNDLE_PATH}`);
  }
  const bundlePath = regularRepositoryFile(root, REDTEAM_REVIEW_BUNDLE_PATH, 'current redteam review bundle');
  const output = currentRedteamAttestationPath(revision);
  const rationale = `Owner attests to the current Phase 3 redteam review bundle and reviewed tree for requirements revision ${revision}. This attestation does not authorize deployment, credentials, signing, broadcast, asset movement, spending, or publication.`;
  const current = existsSync(join(root, output)) ? approvalArtifact(root, output) : null;
  if (matchesCurrentRedteamAttestation(root, current, output, rationale, bundlePath)) {
    return { output, rationale, reused: true };
  }
  if (current) throw new Error(`current redteam attestation ${output} is stale or malformed; do not overwrite a formal owner artifact`);

  writeArtifact(root, output, {
    schema: OWNER_APPROVAL_SCHEMA,
    authority: 'OWNER',
    action: 'REDTEAM_REVIEW_ATTESTATION',
    phase: 'redteam',
    itemId: null,
    rationale,
    approvalToken: FORMAL_OWNER_TOKEN,
    subjectHashes: {
      reviewedTree: reviewedTreeDigest(root, output),
      [REDTEAM_REVIEW_BUNDLE_PATH]: hashFile(bundlePath),
    },
  });
  return {
    output,
    rationale,
    reused: false,
    artifactHash: hashFile(regularRepositoryFile(root, output, 'current redteam attestation')),
  };
}

function assertUntrackedArtifact(root, output) {
  const status = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', output],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (status !== `?? ${output}`) {
    throw new Error(`current redteam attestation ${output} is not an untracked artifact from this closeout`);
  }
}

export function discardCurrentRedteamAttestation(rootPath, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('discarding a redteam attestation requires the exact newly generated artifact hash');
  }
  const root = resolve(rootPath);
  const revision = requirementRevision(root);
  const output = currentRedteamAttestationPath(revision);
  const bundlePath = regularRepositoryFile(root, REDTEAM_REVIEW_BUNDLE_PATH, 'current redteam review bundle');
  const rationale = `Owner attests to the current Phase 3 redteam review bundle and reviewed tree for requirements revision ${revision}. This attestation does not authorize deployment, credentials, signing, broadcast, asset movement, spending, or publication.`;
  const attestationPath = regularRepositoryFile(root, output, 'current redteam attestation');
  if (hashFile(attestationPath) !== expectedHash) {
    throw new Error(`current redteam attestation ${output} does not match the newly generated artifact hash`);
  }
  const current = readJson(attestationPath);
  if (!matchesCurrentRedteamAttestation(root, current, output, rationale, bundlePath)) {
    throw new Error(`current redteam attestation ${output} changed after materialization; preserve it rather than discarding it`);
  }
  assertUntrackedArtifact(root, output);
  unlinkSync(attestationPath);
  return { output, discarded: true };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'summary') print(closeoutSummary(root));
  else if (command === 'materialize-spec') print(materializeSpecApproval(root));
  else if (command === 'spec-path') print({ path: currentSpecApprovalPath(requirementRevision(root)) });
  else if (command === 'spec-rationale') {
    const path = currentSpecApprovalPath(requirementRevision(root));
    print({ rationale: approvalArtifact(root, path).rationale });
  }
  else if (command === 'materialize-p1-rebind') print(materializeP1DeferralRebind(root));
  else if (command === 'materialize-redteam-attestation') print(materializeRedteamAttestation(root));
  else if (command === 'discard-redteam-attestation') {
    if (args.length !== 2 || args[0] !== '--expected-hash') {
      throw new Error('usage: owner-closeout.mjs discard-redteam-attestation --expected-hash <sha256>');
    }
    print(discardCurrentRedteamAttestation(root, args[1]));
  }
  else if (command === 'external-preflight-inputs') print({ inputs: externalPreflightInputs(root) });
  else throw new Error('usage: owner-closeout.mjs summary|materialize-spec|spec-path|spec-rationale|materialize-p1-rebind|materialize-redteam-attestation|discard-redteam-attestation --expected-hash <sha256>|external-preflight-inputs');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[owner-closeout] ${error.message}\n`);
    process.exitCode = 1;
  }
}
