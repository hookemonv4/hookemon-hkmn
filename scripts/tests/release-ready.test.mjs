import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  authorizeOwnerGateEvidence, checkGate, isGateReceiptAuthoritative, overrideGate, readOwnerApproval, recordGateEvidence,
} from '../lib/gates.mjs';
import { listReceipts } from '../lib/receipts.mjs';
import { hashFile, readJson, writeJson } from '../lib/util.mjs';
import { overrideSubjectInputs, writeOwnerApproval } from './helpers/owner-approval.mjs';
import { copyTrackedProjectFiles } from './helpers/tracked-project.mjs';
import {
  CAPABILITY_MAP_PATH,
  DEPLOYMENT_MANIFEST_PATH,
  EXPECTED_REDTEAM_FINDING_IDS,
  OWNER_APPROVALS_DIR,
  REDTEAM_FINDINGS_PATH,
  REDTEAM_RESOLUTIONS_PATH,
  REDTEAM_REVIEW_BUNDLE_PATH,
  REDTEAM_TERMINATION_PATH,
  REQUIREMENTS_PATH,
  REQUIRED_DISPOSITIONED_FINDING_ID,
  STATE_PATH,
  verifyReleaseReady,
} from '../verify-release-ready.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', '..');
const currentCycleFixture = join(here, 'fixtures', 'release-ready', 'current-cycle');
const attestedCycleFixture = join(here, 'fixtures', 'release-ready', 'attested-cycle.json');
const expectedFindingIds = [
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
];
const manifestDispositionedIds = ['RT-R58-01', 'RT-R58-02', 'RT-R58-04'];
const redteamEvidenceInputs = Object.freeze({
  R1: 'qa/redteam/doubt-loop.json',
  R2: REDTEAM_FINDINGS_PATH,
  R3: 'qa/redteam/resolutions.json',
  R4: 'qa/redteam/termination.json',
  R5: 'qa/redteam/threat-model.json',
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hookemon-release-ready-')));
  copyTrackedProjectFiles(templateRoot, root);
  return root;
}

function countsFor(findings) {
  const counts = {
    'contract-misread': 0,
    'valid-actionable': 0,
    'valid-tradeoff': 0,
    noise: 0,
    resolved: 0,
    open: 0,
    inProgress: 0,
  };
  for (const entry of findings) {
    counts[entry.classification] += 1;
    if (entry.status === 'RESOLVED') counts.resolved += 1;
    else if (entry.status === 'IN_PROGRESS') counts.inProgress += 1;
    else counts.open += 1;
  }
  return counts;
}

function setRedteamGateState(root, result) {
  const statePath = join(root, STATE_PATH);
  const state = readJson(statePath);
  const phases = state.phases.map(phase => (phase.phase === 'redteam' ? { ...phase, result } : phase));
  writeJson(statePath, { ...state, phases });
}

function writeFindings(root, record) {
  record.counts = countsFor(record.findings);
  writeJson(join(root, REDTEAM_FINDINGS_PATH), record);
}

function copyCurrentCycle(root) {
  const files = [
    ['findings.json', REDTEAM_FINDINGS_PATH],
    ['review-bundle.json', 'qa/redteam/current-review-bundle.json'],
    ['evidence.json', 'qa/redteam/current-cycle-evidence.json'],
    ['resolutions.json', 'qa/redteam/resolutions.json'],
    ['termination.json', 'qa/redteam/termination.json'],
  ];
  for (const [source, destination] of files) {
    const target = join(root, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(currentCycleFixture, source), target);
  }

  const requirementsRevision = readJson(join(root, REQUIREMENTS_PATH)).revision;
  const architectureRevision = readJson(join(root, CAPABILITY_MAP_PATH)).architectureRevision;
  const evidencePath = join(root, 'qa/redteam/current-cycle-evidence.json');
  const resolutionsPath = join(root, REDTEAM_RESOLUTIONS_PATH);
  const terminationPath = join(root, REDTEAM_TERMINATION_PATH);
  const bundlePath = join(root, REDTEAM_REVIEW_BUNDLE_PATH);
  const findingsPath = join(root, REDTEAM_FINDINGS_PATH);
  const evidence = readJson(evidencePath);
  const resolutions = readJson(resolutionsPath);
  const termination = readJson(terminationPath);
  const bundle = readJson(bundlePath);
  const findings = readJson(findingsPath);

  for (const artifact of [evidence, resolutions, termination, bundle, findings]) {
    artifact.requirementsRevision = requirementsRevision;
    artifact.architectureRevision = architectureRevision;
  }
  writeJson(evidencePath, evidence);
  writeJson(resolutionsPath, resolutions);
  writeJson(terminationPath, termination);
  bundle.artifacts.resolutions.sha256 = hashFile(resolutionsPath);
  bundle.artifacts.termination.sha256 = hashFile(terminationPath);
  for (const finding of bundle.findings) {
    for (const evidenceRecord of finding.evidence) {
      evidenceRecord.sha256 = hashFile(join(root, evidenceRecord.path));
    }
  }
  writeJson(bundlePath, bundle);
  findings.reviewBundle.sha256 = hashFile(bundlePath);
  writeFindings(root, findings);
}

function reviewTreeDigest(root, attestationPath) {
  const excludedDirectoryNames = new Set(['.git', '.worktrees', 'node_modules']);
  const entries = [];

  function visit(relativePath) {
    const absolutePath = join(root, relativePath);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`review tree fixture contains a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) {
        const child = relativePath === '.' ? entry : `${relativePath}/${entry}`;
        if (child === attestationPath || child.split('/').some(component => excludedDirectoryNames.has(component))) continue;
        visit(child);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`review tree fixture contains a non-regular entry: ${relativePath}`);
    entries.push(`${relativePath}\0${hashFile(absolutePath)}`);
  }

  visit('.');
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}

function copyOwnerAttestedCycle(root) {
  copyCurrentCycle(root);
  const template = readJson(attestedCycleFixture);
  const recordPath = join(root, REDTEAM_FINDINGS_PATH);
  const record = readJson(recordPath);
  const priorBundlePath = 'qa/redteam/prior-review-bundle.json';
  const priorBundle = {
    ...template.priorBundle,
    requirementsRevision: record.priorCycle.requirementsRevision,
    architectureRevision: record.priorCycle.architectureRevision,
    cycle: record.priorCycle.cycle,
    findings: record.findings.map(finding => ({
      id: finding.id,
      reportedSeverity: finding.reportedSeverity,
      classification: finding.classification,
      canonicalIssue: finding.canonicalIssue,
      status: template.priorStatusById[finding.id] ?? 'OPEN_FAIL_CLOSED',
    })),
  };
  mkdirSync(dirname(join(root, priorBundlePath)), { recursive: true });
  writeJson(join(root, priorBundlePath), priorBundle);
  writeJson(join(root, 'qa/redteam/doubt-loop.json'), {
    ...template.doubtLoop,
    requirementsRevision: record.requirementsRevision,
    architectureRevision: record.architectureRevision,
    cycle: record.cycle,
    reviewedFindingIds: record.findings.map(finding => finding.id),
  });
  writeJson(join(root, 'qa/redteam/threat-model.json'), {
    ...template.threatModel,
    requirementsRevision: record.requirementsRevision,
    architectureRevision: record.architectureRevision,
    cycle: record.cycle,
    reviewedFindingIds: record.findings.map(finding => finding.id),
  });
  record.priorReviewBundle = { path: priorBundlePath, sha256: hashFile(join(root, priorBundlePath)) };
  record.evidenceReferences = Object.fromEntries(record.findings.map(finding => [finding.id, [{
    path: 'qa/redteam/current-cycle-evidence.json',
    sha256: hashFile(join(root, 'qa/redteam/current-cycle-evidence.json')),
    testPath: 'scripts/tests/release-ready.test.mjs',
    testName: 'an owner-attested current-cycle review bundle with matching receipts is READY',
  }]]));
  writeFindings(root, record);
  return template;
}

function writeOwnerReviewAttestation(root, template, { approvalToken = template.attestation.approvalToken } = {}) {
  const revision = readJson(join(root, 'specs/requirements.json')).revision;
  const path = `${OWNER_APPROVALS_DIR}/redteam-review-attestation-${revision}.json`;
  const artifact = {
    ...template.attestation,
    approvalToken,
    subjectHashes: {
      ...template.attestation.subjectHashes,
      reviewedTree: reviewTreeDigest(root, path),
      'qa/redteam/current-review-bundle.json': hashFile(join(root, 'qa/redteam/current-review-bundle.json')),
    },
  };
  writeJson(join(root, path), artifact);
  return path;
}

function setCurrentCycleStatuses(root, statusById) {
  const recordPath = join(root, REDTEAM_FINDINGS_PATH);
  const bundlePath = join(root, 'qa/redteam/current-review-bundle.json');
  const resolutionsPath = join(root, 'qa/redteam/resolutions.json');
  const terminationPath = join(root, 'qa/redteam/termination.json');
  const record = readJson(recordPath);
  const bundle = readJson(bundlePath);
  const resolutions = readJson(resolutionsPath);
  const termination = readJson(terminationPath);

  for (const [id, status] of Object.entries(statusById)) {
    const finding = record.findings.find(candidate => candidate.id === id);
    const bundleFinding = bundle.findings.find(candidate => candidate.id === id);
    const resolution = resolutions.findings.find(candidate => candidate.id === id);
    const terminationState = termination.findingStates.find(candidate => candidate.id === id);
    assert.ok(finding && bundleFinding && resolution && terminationState, `current-cycle fixture is missing ${id}`);
    finding.status = status;
    bundleFinding.statusTransition = { from: bundleFinding.statusTransition.from, to: status };
    resolution.status = status;
    terminationState.status = status;
  }

  writeJson(resolutionsPath, resolutions);
  writeJson(terminationPath, termination);
  bundle.artifacts.resolutions.sha256 = hashFile(resolutionsPath);
  bundle.artifacts.termination.sha256 = hashFile(terminationPath);
  writeJson(bundlePath, bundle);
  record.reviewBundle.sha256 = hashFile(bundlePath);
  writeFindings(root, record);
}

function resetRedteamGateHistory(root) {
  rmSync(join(root, 'receipts'), { recursive: true, force: true });
  rmSync(join(root, 'gates', 'runs', 'redteam.json'), { force: true });
  for (const phase of ['init', 'spec', 'architecture', 'feasibility']) {
    rmSync(join(root, 'gates', `${phase}.json`), { force: true });
  }
}

function addReleaseProblem(root, findingId) {
  const path = join(root, 'gates', 'redteam.json');
  const gate = readJson(path);
  gate.items.push({
    id: findingId,
    text: `Release disposition for ${findingId}.`,
    receiptType: `release-disposition-${findingId.toLowerCase()}`,
    evidencePolicy: {
      authority: 'SYSTEM',
      requiredInputs: [`qa/redteam/${findingId.toLowerCase()}-disposition.json`],
      requiredPrefixes: [],
      allowedInputs: [`qa/redteam/${findingId.toLowerCase()}-disposition.json`],
      allowedPrefixes: [],
    },
  });
  writeJson(path, gate);
}

function createAuthoritativeRedteam(root, {
  failedFindingIds = [], overridden = false, corruptEvidenceItem = null, resetHistory = true,
} = {}) {
  if (resetHistory) resetRedteamGateHistory(root);
  for (const findingId of failedFindingIds) addReleaseProblem(root, findingId);
  for (const [itemId, input] of Object.entries(redteamEvidenceInputs)) {
    recordGateEvidence(root, 'redteam', itemId, [input]);
  }
  if (corruptEvidenceItem) {
    const run = readJson(join(root, 'gates', 'runs', 'redteam.json'));
    const receiptPath = join(root, 'receipts', `${run.items[corruptEvidenceItem].receipt}.json`);
    const receipt = readJson(receiptPath);
    receipt.data.itemId = 'R1';
    writeJson(receiptPath, receipt);
  }
  const checked = checkGate(root, 'redteam');
  assert.equal(
    checked.result,
    failedFindingIds.length > 0 || corruptEvidenceItem ? 'FAILED' : 'PASSED',
    checked.problems.join('\n'),
  );
  let receipt = checked.receipt;
  if (overridden) {
    const approvalInput = 'decisions/owner-approvals/redteam-release-override.json';
    const rationale = 'The owner explicitly accepts the bounded redteam disposition for release evaluation.';
    writeOwnerApproval(root, approvalInput, {
      action: 'GATE_OVERRIDE', phase: 'redteam', itemId: null, rationale,
    }, overrideSubjectInputs(root, 'redteam', approvalInput));
    receipt = overrideGate(root, 'redteam', rationale, approvalInput, 'RZ-release-evaluation');
  }
  assert.equal(isGateReceiptAuthoritative(root, receipt), true, `receipt ${receipt.id} must be authoritative`);
  return receipt;
}

function createCurrentSpecAuthorization(root) {
  const specGatePath = join(root, 'gates', 'spec.json');
  copyFileSync(join(templateRoot, 'gates', 'spec.json'), specGatePath);
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: {} });
  const gate = readJson(specGatePath);
  for (const item of gate.items.filter(item => item.id !== 'S5')) {
    recordGateEvidence(root, 'spec', item.id, item.evidencePolicy.requiredInputs);
  }
  const evidence = createCurrentRequirementsAuthorization(root);
  const checked = checkGate(root, 'spec');
  assert.equal(checked.result, 'PASSED', checked.problems.join('\n'));
  return { evidence, gate: checked.receipt };
}

function createCurrentRequirementsAuthorization(root) {
  const approvalInput = 'decisions/owner-approvals/release-ready-requirements-s5-approved.json';
  const rationale = 'Owner approves the exact current requirements revision for release readiness.';
  writeOwnerApproval(root, approvalInput, {
    action: 'GATE_EVIDENCE', phase: 'spec', itemId: 'S5', rationale,
  }, ['gates/spec.json', 'policy/policy.json', 'specs/requirements.json']);
  return authorizeOwnerGateEvidence(root, 'spec', 'S5', rationale, approvalInput, ['specs/requirements.json']);
}

function createContradictoryCurrentS5Authorization(root, approvalToken) {
  const approvalInput = 'decisions/owner-approvals/current-s5-contradiction.json';
  const rationale = 'DRAFT_UNSIGNED candidate for the current S5 authorization must not be accepted.';
  copyFileSync(join(templateRoot, 'gates', 'spec.json'), join(root, 'gates', 'spec.json'));
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: {} });
  writeOwnerApproval(root, approvalInput, {
    action: 'GATE_EVIDENCE', phase: 'spec', itemId: 'S5', rationale, approvalToken,
  }, ['gates/spec.json', 'policy/policy.json', 'specs/requirements.json']);
  return authorizeOwnerGateEvidence(root, 'spec', 'S5', rationale, approvalInput, ['specs/requirements.json']);
}

function makeReady(root, {
  openFindingIds = [], failedFindingIds = [], overridden = false, stateResult = 'PENDING',
  corruptEvidenceItem = null, specAuthorized = true, retainRevision64Baseline = false,
} = {}) {
  const template = copyOwnerAttestedCycle(root);
  if (openFindingIds.length > 0) {
    setCurrentCycleStatuses(root, Object.fromEntries(openFindingIds.map(id => [id, 'OPEN_FAIL_CLOSED'])));
  }
  const baselinePath = join(root, OWNER_APPROVALS_DIR, 'revision-64-baseline.json');
  const baseline = retainRevision64Baseline ? readJson(baselinePath) : null;
  rmSync(join(root, OWNER_APPROVALS_DIR), { recursive: true, force: true });
  mkdirSync(join(root, OWNER_APPROVALS_DIR), { recursive: true });
  if (baseline !== null) writeJson(baselinePath, baseline);
  let receipt;
  if (specAuthorized) {
    resetRedteamGateHistory(root);
    createCurrentSpecAuthorization(root);
    receipt = createAuthoritativeRedteam(root, {
      failedFindingIds, overridden, corruptEvidenceItem, resetHistory: false,
    });
  } else {
    receipt = createAuthoritativeRedteam(root, { failedFindingIds, overridden, corruptEvidenceItem });
  }
  setRedteamGateState(root, stateResult);
  writeOwnerReviewAttestation(root, template);
  return receipt;
}

function makeOwnerAttestedReady(root, {
  openFindingIds = [], failedFindingIds = [], overridden = false, stateResult = 'PENDING',
  corruptEvidenceItem = null, approvalToken = 'OWNER APPROVED',
} = {}) {
  const receipt = makeReady(root, {
    openFindingIds, failedFindingIds, overridden, stateResult, corruptEvidenceItem,
  });
  if (approvalToken !== 'OWNER APPROVED') {
    const template = readJson(attestedCycleFixture);
    writeOwnerReviewAttestation(root, template, { approvalToken });
  }
  return receipt;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function manifestDigest(manifest) {
  const candidate = structuredClone(manifest);
  delete candidate.deploymentManifestDigest;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(candidate))).digest('hex')}`;
}

test('an independently authored owner-attested review bundle with a matching authoritative receipt is READY', () => {
  const root = fixture();
  const receipt = makeReady(root);
  const s5Evidence = listReceipts(root).find(candidate => candidate.type === 'owner-spec-approved');
  assert.ok(s5Evidence, 'a formal S5 evidence receipt must be present');
  const approval = readJson(join(root, s5Evidence.data.approvalInput));
  assert.equal(approval.approvalToken, 'OWNER APPROVED');
  assert.deepEqual(Object.keys(approval.subjectHashes), [
    'gates/spec.json',
    'policy/policy.json',
    REQUIREMENTS_PATH,
  ]);
  assert.doesNotThrow(() => readOwnerApproval(root, s5Evidence.data.approvalInput, {
    action: 'GATE_EVIDENCE',
    phase: 'spec',
    itemId: 'S5',
    rationale: s5Evidence.data.rationale,
    subjectInputs: ['gates/spec.json', 'policy/policy.json', REQUIREMENTS_PATH],
  }));

  const report = verifyReleaseReady(root);

  assert.deepEqual(EXPECTED_REDTEAM_FINDING_IDS, expectedFindingIds);
  assert.equal(receipt.result, 'PASSED');
  assert.equal(report.result, 'READY', report.errors.join('\n'));
  assert.deepEqual(report.errors, []);
  assert.equal(report.deploymentManifest.checked, true);
  assert.equal(report.traceability.valid, true);
  assert.equal(report.approvalArtifacts.checked, 2);
  assert.equal(report.requirementsAuthorization.authorized, true);
  assert.equal(report.requirementsAuthorization.receiptId, s5Evidence.id);
  assert.deepEqual(report.redteam.openBlocking, []);
  assert.deepEqual(report.redteam.openNonBlockingByManifest, []);
  assert.equal(report.redteam.gateResult, 'PASSED');
});

test('the retained revision-64 DRAFT_UNSIGNED baseline cannot authorize current S5 requirements', () => {
  const root = fixture();
  const baselineInput = `${OWNER_APPROVALS_DIR}/revision-64-baseline.json`;
  const baseline = readJson(join(root, baselineInput));
  assert.equal(baseline.approvalToken, 'DRAFT_UNSIGNED_NOT_YET_APPROVED');
  assert.throws(
    () => readOwnerApproval(root, baselineInput, {
      action: 'GATE_EVIDENCE',
      phase: 'spec',
      itemId: 'S5',
      rationale: baseline.rationale,
      subjectInputs: Object.keys(baseline.subjectHashes),
    }),
    /owner approval must contain exactly/,
  );
  const currentHashFixture = `${OWNER_APPROVALS_DIR}/revision-64-current-hashes.json`;
  writeJson(join(root, currentHashFixture), {
    schema: 'v4-owner-approval-v2',
    authority: 'OWNER',
    action: 'GATE_EVIDENCE',
    phase: 'spec',
    itemId: 'S5',
    rationale: baseline.rationale,
    approvalToken: baseline.approvalToken,
    subjectHashes: Object.fromEntries([
      'gates/spec.json',
      'policy/policy.json',
      REQUIREMENTS_PATH,
    ].map((path) => [path, hashFile(join(root, path))])),
  });
  assert.throws(
    () => readOwnerApproval(root, currentHashFixture, {
      action: 'GATE_EVIDENCE',
      phase: 'spec',
      itemId: 'S5',
      rationale: baseline.rationale,
      subjectInputs: ['gates/spec.json', 'policy/policy.json', REQUIREMENTS_PATH],
    }),
    /explicit APPROVED or AUTHORIZED token/,
  );
  makeReady(root, { specAuthorized: false, retainRevision64Baseline: true });
  assert.deepEqual(readJson(join(root, baselineInput)), baseline);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /current requirements revision.*formal S5 owner authorization/i);

  const readyRoot = fixture();
  makeReady(readyRoot, { retainRevision64Baseline: true });
  assert.equal(verifyReleaseReady(readyRoot).result, 'READY');
});

test('historical revision-58 formal artifacts with DRAFT_UNSIGNED do not invalidate current readiness', () => {
  const root = fixture();
  makeReady(root);
  for (const name of [
    'phase-2-revision-58-spec-s5-approved.json',
    'revision-58-baseline.json',
    'revision-58-distribution-signer-custody.json',
    'revision-58-hookdata-relaxation.json',
    'revision-58-standing-authority.json',
  ]) {
    copyFileSync(
      join(templateRoot, OWNER_APPROVALS_DIR, name),
      join(root, OWNER_APPROVALS_DIR, name),
    );
  }
  writeOwnerReviewAttestation(root, readJson(attestedCycleFixture));

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'READY', report.errors.join('\n'));
  assert.deepEqual(report.approvalArtifacts.selfContradictory, []);
});

test('state projections cannot replace an authoritative redteam receipt', () => {
  for (const projectedResult of ['FAILED', 'OVERRIDDEN', 'STALE', 'EXHAUSTED_WITH_OPEN_FINDINGS', 'PENDING', 'UNRECOGNIZED']) {
    const root = fixture();
    makeReady(root, { stateResult: projectedResult });

    const report = verifyReleaseReady(root);

    assert.equal(report.result, 'READY', `${projectedResult}: ${report.errors.join('\n')}`);
    assert.equal(report.redteam.gateResult, 'PASSED');
  }
});

test('a projected PASSED result without a latest redteam receipt is NOT_READY', () => {
  const root = fixture();
  const template = copyOwnerAttestedCycle(root);
  rmSync(join(root, OWNER_APPROVALS_DIR), { recursive: true, force: true });
  rmSync(join(root, 'receipts'), { recursive: true, force: true });
  mkdirSync(join(root, OWNER_APPROVALS_DIR), { recursive: true });
  setRedteamGateState(root, 'PASSED');
  writeOwnerReviewAttestation(root, template);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /latest redteam gate receipt is missing/);
});

test('a forged latest redteam receipt cannot be rescued by a matching state projection', () => {
  const root = fixture();
  const receipt = makeReady(root, { stateResult: 'PASSED' });
  const receiptPath = join(root, 'receipts', `${receipt.id}.json`);
  const forged = readJson(receiptPath);
  forged.data.problems = ['R1: forged projection'];
  writeJson(receiptPath, forged);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /latest redteam gate receipt .* is not authoritative/);
});

test('an authoritative FAILED receipt may remain release-ready only for the three manifest dispositions', () => {
  const root = fixture();
  makeReady(root, {
    openFindingIds: manifestDispositionedIds,
    failedFindingIds: ['RT-R58-01'],
    stateResult: 'PASSED',
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'READY', report.errors.join('\n'));
  assert.equal(report.redteam.gateResult, 'FAILED');
  assert.deepEqual(report.redteam.openBlocking, []);
  assert.deepEqual(report.redteam.openNonBlockingByManifest, manifestDispositionedIds);
});

test('an allowed failed problem must correspond to an unresolved current-cycle finding', () => {
  const root = fixture();
  makeReady(root, { failedFindingIds: ['RT-R58-01'] });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R58-01 is not unresolved in the current review bundle/);
});

test('an authoritative FAILED receipt with a non-dispositioned problem is NOT_READY', () => {
  const root = fixture();
  makeReady(root, {
    openFindingIds: ['RT-R58-03'],
    failedFindingIds: ['RT-R58-03'],
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R58-03/);
});

test('a colon-bearing gate item cannot hide behind a manifest-dispositioned problem id', () => {
  const root = fixture();
  makeReady(root, {
    openFindingIds: ['RT-R58-01'],
    failedFindingIds: ['RT-R58-01: shadow'],
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /FAILED with problems outside the manifest-dispositioned finding set/);
});

test('a valid redteam override is evaluated from its authoritative receipt', () => {
  const root = fixture();
  makeReady(root, {
    openFindingIds: manifestDispositionedIds,
    failedFindingIds: ['RT-R58-01'],
    overridden: true,
    stateResult: 'PENDING',
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'READY', report.errors.join('\n'));
  assert.equal(report.redteam.gateResult, 'OVERRIDDEN');
});

test('a redteam record cannot downgrade or relabel bundle-bound finding metadata', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  Object.assign(record.findings[0], {
    reportedSeverity: 'low',
    classification: 'noise',
    canonicalIssue: 'replacement-issue',
  });
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R55-01 reportedSeverity does not match the current review bundle/);
  assert.match(report.errors.join('\n'), /RT-R55-01 classification does not match the current review bundle/);
  assert.match(report.errors.join('\n'), /RT-R55-01 canonicalIssue does not match the current review bundle/);
});

test('a redteam record status must match the bundle transition and current review artifacts', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.findings[0].status = 'IN_PROGRESS';
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R55-01 status does not match the current review bundle transition/);
});

test('a review bundle requires each status transition to begin at the prior review status', () => {
  const root = fixture();
  makeReady(root);
  const bundlePath = join(root, 'qa/redteam/current-review-bundle.json');
  const bundle = readJson(bundlePath);
  bundle.findings[0].statusTransition = { from: 'RESOLVED', to: 'RESOLVED' };
  writeJson(bundlePath, bundle);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.reviewBundle.sha256 = hashFile(bundlePath);
  writeFindings(root, record);
  createAuthoritativeRedteam(root);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R55-01 current review transition does not begin at the prior review status/);
});

test('content-addressed review evidence is verified after the redteam receipts are recorded', () => {
  const root = fixture();
  makeReady(root);
  writeFileSync(join(root, 'qa/redteam/current-cycle-evidence.json'), '{"tampered":true}\n');

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /current review evidence .* digest does not match/);
});

test('the record must bind the exact current review bundle bytes', () => {
  const root = fixture();
  makeReady(root);
  const bundlePath = join(root, 'qa/redteam/current-review-bundle.json');
  const bundle = readJson(bundlePath);
  bundle.findings[0].canonicalIssue = 'tampered-bundle-issue';
  writeJson(bundlePath, bundle);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /reviewBundle .* digest does not match/);
});

test('an excluded deployment target is rejected independently of manifest-digest drift', () => {
  const root = fixture();
  makeReady(root);
  const manifestPath = join(root, DEPLOYMENT_MANIFEST_PATH);
  const manifest = readJson(manifestPath);
  manifest.deployed.push({ ...manifest.deployed[0], name: manifest.excluded[0] });
  manifest.deploymentManifestDigest = manifestDigest(manifest);
  writeJson(manifestPath, manifest);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.equal(report.deploymentManifest.checked, false);
  assert.match(report.errors.join('\n'), /excluded contract appears in deployed targets/);
});

test('incomplete traceability fails the gate without crashing the tool', () => {
  const root = fixture();
  makeReady(root);
  writeJson(join(root, 'docs', 'audit', '2026-09-04', 'traceability.json'), { findings: [] });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.equal(report.traceability.valid, false);
  assert.match(report.errors.join('\n'), /traceability (incomplete|could not be verified)/);
});

test('formal tokens with DRAFT_UNSIGNED are rejected only when they are current S5 candidates', () => {
  for (const approvalToken of ['  OWNER APPROVED  ', 'OWNER AUTHORIZED']) {
    const root = fixture();
    createContradictoryCurrentS5Authorization(root, approvalToken);

    const report = verifyReleaseReady(root);

    assert.equal(report.result, 'NOT_READY', approvalToken);
    assert.equal(report.requirementsAuthorization.authorized, false, approvalToken);
    assert.match(report.errors.join('\n'), /current S5 authorization.*DRAFT_UNSIGNED/i);
    assert.deepEqual(report.approvalArtifacts.selfContradictory, []);
  }
});

test('a trimmed signed token with DRAFT_UNSIGNED anywhere in its rationale is self-contradictory', () => {
  const root = fixture();
  makeReady(root);
  writeJson(join(root, OWNER_APPROVALS_DIR, 'contradiction.json'), {
    schema: 'v4-owner-approval-v2',
    authority: 'OWNER',
    action: 'GATE_EVIDENCE',
    rationale: 'The archived rationale includes DRAFT_UNSIGNED after its opening sentence.',
    approvalToken: '  OWNER APPROVED  ',
    subjectHashes: {},
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.deepEqual(report.approvalArtifacts.selfContradictory, [`${OWNER_APPROVALS_DIR}/contradiction.json`]);
});

test('a genuine unsigned draft is not self-contradictory', () => {
  const root = fixture();
  makeReady(root);
  writeJson(join(root, OWNER_APPROVALS_DIR, 'real-draft.json'), {
    schema: 'v4-owner-approval-v2',
    authority: 'OWNER',
    action: 'GATE_EVIDENCE',
    rationale: 'DRAFT_UNSIGNED: this is a pending draft.',
    approvalToken: 'DRAFT_UNSIGNED_NOT_YET_APPROVED',
    subjectHashes: {},
  });
  writeOwnerReviewAttestation(root, readJson(attestedCycleFixture));

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'READY', report.errors.join('\n'));
  assert.deepEqual(report.approvalArtifacts.selfContradictory, []);
});

test('approval enumeration requires a real repository-contained directory', () => {
  const root = fixture();
  makeReady(root);
  rmSync(join(root, OWNER_APPROVALS_DIR), { recursive: true, force: true });
  writeFileSync(join(root, OWNER_APPROVALS_DIR), 'not a directory\n');

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /owner approvals directory .* could not be enumerated/);
});

test('approval enumeration rejects a directory symlink and a JSON symlink', () => {
  const directoryRoot = fixture();
  makeReady(directoryRoot);
  rmSync(join(directoryRoot, OWNER_APPROVALS_DIR), { recursive: true, force: true });
  mkdirSync(join(directoryRoot, 'approval-target'), { recursive: true });
  symlinkSync(join(directoryRoot, 'approval-target'), join(directoryRoot, OWNER_APPROVALS_DIR), 'dir');
  const directoryReport = verifyReleaseReady(directoryRoot);
  assert.equal(directoryReport.result, 'NOT_READY');
  assert.match(directoryReport.errors.join('\n'), /owner approvals directory must be a regular repository-contained directory/);

  const fileRoot = fixture();
  makeReady(fileRoot);
  writeJson(join(fileRoot, 'approval-target.json'), { approvalToken: 'OWNER APPROVED' });
  symlinkSync(join(fileRoot, 'approval-target.json'), join(fileRoot, OWNER_APPROVALS_DIR, 'alias.json'));
  const fileReport = verifyReleaseReady(fileRoot);
  assert.equal(fileReport.result, 'NOT_READY');
  assert.match(fileReport.errors.join('\n'), /owner approval entry must be a regular repository-contained JSON file/);
});

test('approval enumeration rejects a non-regular JSON entry', () => {
  const root = fixture();
  makeReady(root);
  mkdirSync(join(root, OWNER_APPROVALS_DIR, 'directory.json'));

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /owner approval entry must be a regular repository-contained JSON file/);
});

test('an invalid manifest cannot be waived by an approval whose rationale names RT-R58-010', () => {
  const root = fixture();
  makeReady(root, {
    openFindingIds: ['RT-R58-01'],
    failedFindingIds: ['RT-R58-01'],
  });
  const manifestPath = join(root, DEPLOYMENT_MANIFEST_PATH);
  const manifest = readJson(manifestPath);
  manifest.deploymentManifestDigest = `sha256:${'0'.repeat(64)}`;
  writeJson(manifestPath, manifest);
  writeJson(join(root, OWNER_APPROVALS_DIR, 'accept.json'), {
    approvalToken: 'OWNER APPROVED',
    rationale: 'RT-R58-010 is not a release disposition.',
    subjectHashes: { [REDTEAM_FINDINGS_PATH]: 'not-a-valid-hash' },
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.equal(report.deploymentManifest.checked, false);
  assert.deepEqual(report.redteam.openBlocking, ['RT-R58-01']);
  assert.match(report.errors.join('\n'), /RT-R58-01 is open and blocks release readiness until the deployment manifest validates/);
});

test('RT-R58-05 requires a complete disposition record', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.findings = record.findings.filter(entry => entry.id !== REQUIRED_DISPOSITIONED_FINDING_ID);
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), new RegExp(`${REQUIRED_DISPOSITIONED_FINDING_ID} is missing from the required redteam set`));
});

test('redteam findings must contain the exact unique expected id set', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.findings.push({ ...record.findings[0] });
  record.findings.push({ ...record.findings[0], id: 'RT-R58-99' });
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R55-01 appears 2 times/);
  assert.match(report.errors.join('\n'), /RT-R58-99 is not in the required redteam set/);
});

test('redteam findings reject malformed required fields and enum values', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  Object.assign(record.findings[0], {
    reportedSeverity: 'urgent',
    classification: 'unreviewed',
    canonicalIssue: '',
    summary: '',
    status: 'PENDING',
    evidence: [],
    disposition: '',
  });
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /RT-R55-01 reportedSeverity must be one of/);
  assert.match(report.errors.join('\n'), /RT-R55-01 classification must be one of/);
  assert.match(report.errors.join('\n'), /RT-R55-01 canonicalIssue must be a non-empty string/);
  assert.match(report.errors.join('\n'), /RT-R55-01 status must be one of/);
  assert.match(report.errors.join('\n'), /RT-R55-01 evidence must be a non-empty string array/);
});

test('redteam lifecycle metadata requires a predecessor and exact classification precedence', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.cycle = 0;
  record.priorCycle = { cycle: 1 };
  record.classificationPrecedence = ['noise'];
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /cycle must be a positive integer/);
  assert.match(report.errors.join('\n'), /priorCycle requirementsRevision must be a positive integer/);
  assert.match(report.errors.join('\n'), /classificationPrecedence must exactly list/);
});

test('redteam count fields must exactly recompute from the findings', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.counts.open = 1;
  writeJson(join(root, REDTEAM_FINDINGS_PATH), record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /redteam counts must exactly match the findings/);
});

test('redteam revisions must align with the current requirements and architecture', () => {
  const root = fixture();
  makeReady(root);
  const record = readJson(join(root, REDTEAM_FINDINGS_PATH));
  record.requirementsRevision -= 1;
  record.architectureRevision -= 1;
  writeFindings(root, record);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /requirementsRevision must match specs\/requirements\.json revision/);
  assert.match(report.errors.join('\n'), /architectureRevision must match architecture\/capability-map\.json architectureRevision/);
  assert.doesNotMatch(report.errors.join('\n'), /redteam review attestation .* could not be read/);
});

test('a null redteam record returns NOT_READY rather than throwing', () => {
  const root = fixture();
  makeReady(root);
  writeJson(join(root, REDTEAM_FINDINGS_PATH), null);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /schemaVersion must be 2/);
  assert.match(report.errors.join('\n'), /findings must be an array/);
});

test('an owner-attested current-cycle review bundle with matching receipts is READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'READY', report.errors.join('\n'));
});

test('the independently authored attestation fixture carries an owner-approved token and complete subject hashes', () => {
  const fixtureArtifact = readJson(attestedCycleFixture).attestation;

  assert.equal(fixtureArtifact.approvalToken, 'OWNER APPROVED');
  assert.deepEqual(Object.keys(fixtureArtifact.subjectHashes).sort(), [
    'qa/redteam/current-review-bundle.json',
    'reviewedTree',
  ]);
  for (const hash of Object.values(fixtureArtifact.subjectHashes)) {
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});

test('a draft current-cycle review attestation remains NOT_READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root, { approvalToken: 'DRAFT_UNSIGNED_NOT_YET_APPROVED' });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /redteam review attestation .* requires OWNER APPROVED/);
});

test('coherently rewritten current-cycle artifacts with fresh receipts remain NOT_READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root);
  const recordPath = join(root, REDTEAM_FINDINGS_PATH);
  const bundlePath = join(root, 'qa/redteam/current-review-bundle.json');
  const resolutionsPath = join(root, 'qa/redteam/resolutions.json');
  const terminationPath = join(root, 'qa/redteam/termination.json');
  const record = readJson(recordPath);
  const bundle = readJson(bundlePath);
  const resolutions = readJson(resolutionsPath);
  const termination = readJson(terminationPath);

  record.findings[0].canonicalIssue = 'rewritten-current-cycle-issue';
  bundle.findings[0].canonicalIssue = 'rewritten-current-cycle-issue';
  resolutions.findings[0].status = 'RESOLVED';
  termination.findingStates[0].status = 'RESOLVED';
  writeJson(resolutionsPath, resolutions);
  writeJson(terminationPath, termination);
  bundle.artifacts.resolutions.sha256 = hashFile(resolutionsPath);
  bundle.artifacts.termination.sha256 = hashFile(terminationPath);
  writeJson(bundlePath, bundle);
  record.reviewBundle.sha256 = hashFile(bundlePath);
  writeFindings(root, record);
  createAuthoritativeRedteam(root);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /redteam review attestation/);
});

test('an extra OPEN_FAIL_CLOSED id in resolutions and termination remains NOT_READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root);
  const recordPath = join(root, REDTEAM_FINDINGS_PATH);
  const bundlePath = join(root, 'qa/redteam/current-review-bundle.json');
  const resolutionsPath = join(root, 'qa/redteam/resolutions.json');
  const terminationPath = join(root, 'qa/redteam/termination.json');
  const record = readJson(recordPath);
  const bundle = readJson(bundlePath);
  const resolutions = readJson(resolutionsPath);
  const termination = readJson(terminationPath);
  const extra = { id: 'RT-R58-99', status: 'OPEN_FAIL_CLOSED' };

  resolutions.findings.push(extra);
  termination.findingStates.push(extra);
  writeJson(resolutionsPath, resolutions);
  writeJson(terminationPath, termination);
  bundle.artifacts.resolutions.sha256 = hashFile(resolutionsPath);
  bundle.artifacts.termination.sha256 = hashFile(terminationPath);
  writeJson(bundlePath, bundle);
  record.reviewBundle.sha256 = hashFile(bundlePath);
  writeFindings(root, record);
  createAuthoritativeRedteam(root);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /current review resolutions finding ids must exactly match/);
});

test('a corrupted R2 evidence receipt with a valid owner override remains NOT_READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root, { overridden: true, corruptEvidenceItem: 'R2' });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /R2 evidence receipt .* binds item R1/);
});

test('a hidden non-dispositioned problem behind an allowed prefix remains NOT_READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root, {
    openFindingIds: ['RT-R58-01'],
    failedFindingIds: ['RT-R58-01: allowed disposition\nRT-R58-03: hidden disposition'],
  });

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /FAILED with problems outside the manifest-dispositioned finding set/);
});

test('a latest PENDING redteam receipt remains NOT_READY', () => {
  const root = fixture();
  const receipt = makeOwnerAttestedReady(root);
  const receiptPath = join(root, 'receipts', `${receipt.id}.json`);
  const pending = readJson(receiptPath);
  pending.result = 'PENDING';
  writeJson(receiptPath, pending);

  const report = verifyReleaseReady(root);

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /unsupported result PENDING/);
});

test('approval-directory EACCES remains NOT_READY', () => {
  const root = fixture();
  makeOwnerAttestedReady(root);
  const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

  const report = verifyReleaseReady(root, { readdirSync: () => { throw accessError; } });

  assert.equal(report.result, 'NOT_READY');
  assert.match(report.errors.join('\n'), /owner approvals directory .* could not be enumerated/);
});

test('the CLI reports a receipt-bound readiness decision and a tampered review failure', () => {
  const readyRoot = fixture();
  makeReady(readyRoot);
  const script = join(templateRoot, 'scripts', 'verify-release-ready.mjs');

  const readyRun = spawnSync(process.execPath, [script], { cwd: readyRoot, encoding: 'utf8' });
  assert.equal(readyRun.status, 0, readyRun.stderr);
  assert.equal(JSON.parse(readyRun.stdout).result, 'READY');

  writeFileSync(join(readyRoot, 'qa/redteam/current-cycle-evidence.json'), '{"tampered":true}\n');
  const notReadyRun = spawnSync(process.execPath, [script], { cwd: readyRoot, encoding: 'utf8' });
  assert.equal(notReadyRun.status, 1);
  assert.equal(JSON.parse(notReadyRun.stdout).result, 'NOT_READY');
});
