import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readOwnerApproval, recordGateEvidence } from '../lib/gates.mjs';
import { addTask, listTasks, openLedger } from '../lib/ledger.mjs';
import { closeoutSummary, externalPreflightInputs, reviewedTreeDigest } from '../lib/owner-closeout.mjs';
import { hashFile, readJson, writeJson } from '../lib/util.mjs';
import { verifyReleaseReady } from '../verify-release-ready.mjs';
import { copyTrackedProjectFiles } from './helpers/tracked-project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, '..', '..');
const closeoutScript = join(repositoryRoot, 'scripts', 'owner-closeout.sh');
const closeoutHelper = join(repositoryRoot, 'scripts', 'lib', 'owner-closeout.mjs');
const currentCycleFixture = join(here, 'fixtures', 'release-ready', 'current-cycle');
const attestedCycleFixture = join(here, 'fixtures', 'release-ready', 'attested-cycle.json');

const redteamEvidenceInputs = Object.freeze({
  R1: 'qa/redteam/doubt-loop.json',
  R2: 'decisions/redteam/findings.json',
  R3: 'qa/redteam/resolutions.json',
  R4: 'qa/redteam/termination.json',
  R5: 'qa/redteam/threat-model.json',
});

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function writeFakeV4(root) {
  writeFileSync(join(root, 'scripts', 'v4.mjs'), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const eventPath = 'closeout-events.jsonl';
const event = { args };
appendFileSync(eventPath, JSON.stringify(event) + '\\n');

if (args[0] === 'gate' && args[1] === 'check') {
  const phase = args[2];
  if (process.env.CLOSEOUT_REAL_RELEASE_READY === '1' && (phase === 'spec' || phase === 'redteam')) {
    const { checkGate } = await import('./lib/gates.mjs');
    const checked = checkGate(process.cwd(), phase);
    console.log(JSON.stringify({ result: checked.result, phase, problems: checked.problems }));
    process.exit(checked.result === 'PASSED' ? 0 : 1);
  }
  const failed = process.env.CLOSEOUT_FAIL_PHASE;
  const result = phase === failed ? 'FAILED' : 'PASSED';
  console.log(JSON.stringify({ result, phase, problems: result === 'FAILED' ? ['fixture failure'] : [] }));
  process.exit(result === 'PASSED' ? 0 : 1);
}

if (args[0] === 'gate' && args[1] === 'owner-authorize') {
  if (process.env.CLOSEOUT_FAIL_OWNER_AUTHORIZE === '1') {
    console.error('fixture owner authorization failure');
    process.exit(1);
  }
  const approval = args[args.indexOf('--approval') + 1];
  if (!approval || !existsSync(approval)) {
    console.error('fixture approval is missing');
    process.exit(1);
  }
  if (process.env.CLOSEOUT_REAL_RELEASE_READY === '1') {
    const { authorizeOwnerGateEvidence } = await import('./lib/gates.mjs');
    const option = name => args[args.indexOf(name) + 1];
    const inputs = args.filter((value, index) => args[index - 1] === '--input');
    const receipt = authorizeOwnerGateEvidence(
      process.cwd(),
      'spec',
      option('--item'),
      option('--rationale'),
      approval,
      inputs,
    );
    console.log(JSON.stringify({ result: 'PASSED', approval, receipt: receipt.id }));
    process.exit(0);
  }
  console.log(JSON.stringify({ result: 'PASSED', approval }));
  process.exit(0);
}

if (args[0] === 'status') {
  if (args.includes('--check')) {
    writeFileSync('STATE.md', '# fixture state\\n');
    writeFileSync('state.json', JSON.stringify({ result: 'PASSED' }) + '\\n');
  }
  console.log(JSON.stringify({ result: 'PASSED' }));
  process.exit(0);
}

console.log(JSON.stringify({ result: 'PASSED', args }));
`);
}

function writeFakeReleaseReady(root, {
  result = 'READY',
  errors = [],
} = {}) {
  writeFileSync(join(root, 'scripts', 'verify-release-ready.mjs'), `#!/usr/bin/env node
console.log(JSON.stringify(${JSON.stringify({ result, errors })}));
process.exit(${result === 'READY' ? 0 : 1});
`);
}

function events(root) {
  const path = join(root, 'closeout-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function writeFixtureLedger(root) {
  const descriptorInput = 'decisions/task-deferrals/P1-011.json';
  const descriptor = readJson(join(root, descriptorInput));
  const db = openLedger(root);
  addTask(db, {
    id: 'P1-011',
    title: descriptor.prestate.title,
    phase: descriptor.prestate.phase,
    risk: descriptor.prestate.risk,
    deps: descriptor.prestate.deps,
    reqs: descriptor.prestate.reqs,
  });
  db.prepare(`
    UPDATE tasks
    SET status='deferred', lease_token=?, defer_approval=?, defer_descriptor=?, defer_prestate_fingerprint=?
    WHERE id=?
  `).run(
    descriptor.prestate.leaseToken,
    'decisions/owner-approvals/phase-2-revision-58-dashboard-deferral-approved.json',
    descriptorInput,
    descriptor.prestateFingerprint,
    'P1-011',
  );
  db.prepare(`
    INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha)
    VALUES(?,?,?,?,?,'done',?)
  `).run(
    'P1-011',
    descriptor.prestate.leaseToken,
    'fixture',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    descriptor.prestate.completionCommit,
  );
  db.close();
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
  for (const finding of findings) {
    counts[finding.classification] += 1;
    if (finding.status === 'RESOLVED') counts.resolved += 1;
    else if (finding.status === 'IN_PROGRESS') counts.inProgress += 1;
    else counts.open += 1;
  }
  return counts;
}

function writeReleaseReadyFindings(root, record) {
  record.counts = countsFor(record.findings);
  writeJson(join(root, 'decisions', 'redteam', 'findings.json'), record);
}

function copyCurrentRedteamCycle(root) {
  const files = [
    ['findings.json', 'decisions/redteam/findings.json'],
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

  const requirementsRevision = readJson(join(root, 'specs', 'requirements.json')).revision;
  const architectureRevision = readJson(join(root, 'architecture', 'capability-map.json')).architectureRevision;
  const evidencePath = join(root, 'qa/redteam/current-cycle-evidence.json');
  const resolutionsPath = join(root, 'qa/redteam/resolutions.json');
  const terminationPath = join(root, 'qa/redteam/termination.json');
  const bundlePath = join(root, 'qa/redteam/current-review-bundle.json');
  const findingsPath = join(root, 'decisions/redteam/findings.json');
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
  writeReleaseReadyFindings(root, findings);
}

function copyReleaseReadyRedteamCycle(root) {
  copyCurrentRedteamCycle(root);
  const template = readJson(attestedCycleFixture);
  const findingsPath = join(root, 'decisions/redteam/findings.json');
  const findings = readJson(findingsPath);
  const priorBundlePath = 'qa/redteam/prior-review-bundle.json';
  const priorBundle = {
    ...template.priorBundle,
    requirementsRevision: findings.priorCycle.requirementsRevision,
    architectureRevision: findings.priorCycle.architectureRevision,
    cycle: findings.priorCycle.cycle,
    findings: findings.findings.filter(finding => Object.hasOwn(template.priorStatusById, finding.id)).map(finding => ({
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
    requirementsRevision: findings.requirementsRevision,
    architectureRevision: findings.architectureRevision,
    cycle: findings.cycle,
    reviewedFindingIds: findings.findings.map(finding => finding.id),
  });
  writeJson(join(root, 'qa/redteam/threat-model.json'), {
    ...template.threatModel,
    requirementsRevision: findings.requirementsRevision,
    architectureRevision: findings.architectureRevision,
    cycle: findings.cycle,
    reviewedFindingIds: findings.findings.map(finding => finding.id),
  });
  findings.priorReviewBundle = { path: priorBundlePath, sha256: hashFile(join(root, priorBundlePath)) };
  findings.evidenceReferences = Object.fromEntries(findings.findings.map(finding => [finding.id, [{
    path: 'qa/redteam/current-cycle-evidence.json',
    sha256: hashFile(join(root, 'qa/redteam/current-cycle-evidence.json')),
    testPath: 'scripts/tests/release-ready.test.mjs',
    testName: 'an owner-attested current-cycle review bundle with matching receipts is READY',
  }]]));
  writeReleaseReadyFindings(root, findings);
}

function prepareRealReleaseReadyFixture(root) {
  copyReleaseReadyRedteamCycle(root);
  rmSync(join(root, 'receipts'), { recursive: true, force: true });
  rmSync(join(root, 'gates', 'runs', 'redteam.json'), { force: true });
  for (const phase of ['init', 'spec', 'architecture', 'feasibility']) {
    rmSync(join(root, 'gates', `${phase}.json`), { force: true });
  }

  copyFileSync(join(repositoryRoot, 'gates', 'spec.json'), join(root, 'gates', 'spec.json'));
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: {} });
  const specGate = readJson(join(root, 'gates', 'spec.json'));
  for (const item of specGate.items.filter(item => item.id !== 'S5')) {
    recordGateEvidence(root, 'spec', item.id, item.evidencePolicy.requiredInputs);
  }
  for (const [itemId, input] of Object.entries(redteamEvidenceInputs)) {
    recordGateEvidence(root, 'redteam', itemId, [input]);
  }
}

function fixture({ realReleaseReady = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hookemon-owner-closeout-')));
  copyTrackedProjectFiles(repositoryRoot, root);
  copyFileSync(closeoutScript, join(root, 'scripts', 'owner-closeout.sh'));
  if (existsSync(closeoutHelper)) copyFileSync(closeoutHelper, join(root, 'scripts', 'lib', 'owner-closeout.mjs'));
  writeFakeV4(root);
  if (realReleaseReady) prepareRealReleaseReadyFixture(root);
  else {
    writeFakeReleaseReady(root);
    mkdirSync(join(root, 'qa', 'redteam'), { recursive: true });
    writeFileSync(join(root, 'qa', 'redteam', 'current-review-bundle.json'), '{}\n');
  }
  writeFixtureLedger(root);
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
}

function runCloseout(root, ...args) {
  return runCloseoutWithEnv(root, {}, ...args);
}

function runCloseoutWithEnv(root, extraEnv, ...args) {
  return spawnSync('bash', ['scripts/owner-closeout.sh', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOOKEMON_NODE_BIN: process.execPath,
      ...extraEnv,
    },
  });
}

test('owner closeout previews immutable drafts, signs current successor approvals, and walks every gate once', () => {
  const root = fixture();
  try {
    const baselinePath = join(root, 'decisions', 'owner-approvals', 'revision-65-baseline.json');
    const p1DraftPath = join(root, 'decisions', 'task-deferrals', 'P1-011-revision-65-rebind-DRAFT.json');
    const dependencyVerificationPath = join(root, 'product', 'dependency-verification.json');
    const baselineBefore = readFileSync(baselinePath, 'utf8');
    const p1DraftBefore = readFileSync(p1DraftPath, 'utf8');
    const dependencyVerificationBefore = readFileSync(dependencyVerificationPath, 'utf8');

    const dryRun = runCloseout(root);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Dry run: no approvals or receipts were written\./);
    assert.match(dryRun.stdout, /revision-65-baseline\.json/);
    assert.deepEqual(events(root), []);
    assert.equal(readFileSync(baselinePath, 'utf8'), baselineBefore);

    const summary = closeoutSummary(root);
    assert.equal(summary.inventory.unsigned.length, 13);
    assert.equal(summary.inventory.selfContradictory.length, 5);
    assert.equal(summary.inventory.namedOverrideDrafts.length, 1);
    assert.equal(summary.inventory.namedOverrideDrafts[0].path, 'decisions/owner-approvals/closeout-feasibility-override-DRAFT.json');
    assert.equal(summary.inventory.namedOverrideDrafts[0].validator.result, 'INVALID');
    assert.equal(summary.inventory.p1RebindDrafts.length, 4);
    assert.equal(summary.deferredTaskDraft, 'decisions/task-deferrals/P1-011-revision-65-rebind-DRAFT.json');
    assert.equal(summary.pinBump.status, 'ABSENT');
    assert.deepEqual(
      externalPreflightInputs(root).map(input => input.code),
      [
        'BUILDER_IDENTITY_PENDING',
        'OWNER_WALLET_FUNDING_PENDING',
        'PROVIDER_API_KEY_PENDING',
        'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
      ],
    );

    const confirmed = runCloseout(root, '--confirm');
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /repository release readiness is READY/i);
    assert.match(confirmed.stdout, /external preflight inputs remain/i);
    assert.match(confirmed.stdout, /UNVERIFIED_LAUNCH_INTENT_PREIMAGE/);
    assert.equal(readFileSync(baselinePath, 'utf8'), baselineBefore);
    assert.equal(readFileSync(p1DraftPath, 'utf8'), p1DraftBefore);
    assert.equal(readFileSync(dependencyVerificationPath, 'utf8'), dependencyVerificationBefore);

    const approvalPath = 'decisions/owner-approvals/closeout-revision-65-spec-s5-approved.json';
    const approval = readJson(join(root, approvalPath));
    assert.equal(approval.approvalToken, 'OWNER APPROVED');
    assert.doesNotMatch(JSON.stringify(approval), /DRAFT_UNSIGNED/);
    readOwnerApproval(root, approvalPath, {
      action: 'GATE_EVIDENCE',
      phase: 'spec',
      itemId: 'S5',
      rationale: approval.rationale,
      subjectInputs: ['gates/spec.json', 'policy/policy.json', 'specs/requirements.json'],
    });

    const p1ApprovalPath = 'decisions/owner-approvals/phase-3-revision-65-dashboard-deferral-approved.json';
    const p1Approval = readJson(join(root, p1ApprovalPath));
    assert.equal(p1Approval.approvalToken, 'OWNER APPROVED');
    assert.doesNotMatch(JSON.stringify(p1Approval), /DRAFT_UNSIGNED/);
    readOwnerApproval(root, p1ApprovalPath, {
      action: 'TASK_DEFER',
      phase: 'build',
      itemId: 'P1-011',
      rationale: p1Approval.rationale,
      subjectInputs: ['decisions/task-deferrals/P1-011.json', 'policy/policy.json'],
    });

    const attestation = readJson(join(root, 'decisions', 'owner-approvals', 'redteam-review-attestation-65.json'));
    assert.equal(attestation.approvalToken, 'OWNER APPROVED');
    assert.doesNotMatch(JSON.stringify(attestation), /DRAFT_UNSIGNED/);
    assert.equal(
      attestation.subjectHashes.reviewedTree,
      reviewedTreeDigest(root, 'decisions/owner-approvals/redteam-review-attestation-65.json'),
    );

    const db = openLedger(root);
    const rebound = listTasks(db).find(task => task.id === 'P1-011');
    assert.equal(rebound.status, 'deferred');
    assert.equal(rebound.defer_approval, p1ApprovalPath);
    assert.equal(rebound.defer_descriptor, 'decisions/task-deferrals/P1-011.json');
    assert.equal(db.prepare("SELECT count(*) AS count FROM attempts WHERE task_id='P1-011'").get().count, 1);
    db.close();

    const calls = events(root).map(event => event.args);
    assert.deepEqual(
      calls.filter(args => args[0] === 'gate' && args[1] === 'check').map(args => args[2]),
      ['init', 'spec', 'architecture', 'feasibility', 'redteam', 'tasks', 'build', 'ship'],
    );
    const authorizeIndex = calls.findIndex(args => args[0] === 'gate' && args[1] === 'owner-authorize');
    const specCheckIndex = calls.findIndex(args => args[0] === 'gate' && args[1] === 'check' && args[2] === 'spec');
    assert.ok(authorizeIndex >= 0 && authorizeIndex < specCheckIndex);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout removes only a newly generated attestation after a non-ready release report', () => {
  const root = fixture();
  try {
    writeFakeReleaseReady(root, {
      result: 'NOT_READY',
      errors: ['Programmable preflight inputs are required outside this repository'],
    });
    git(root, 'add', 'scripts/verify-release-ready.mjs');
    git(root, 'commit', '--quiet', '-m', 'fixture non-ready report');

    const result = runCloseout(root, '--confirm');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release readiness is not READY/i);
    assert.match(result.stderr, /discarded newly generated redteam attestation/i);
    assert.equal(existsSync(join(root, 'decisions', 'owner-approvals', 'redteam-review-attestation-65.json')), false);

    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'record failed release closeout');
    const dryRun = runCloseout(root);
    assert.equal(dryRun.status, 0, dryRun.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout refuses to discard a committed redteam attestation directly', () => {
  const root = fixture();
  try {
    const output = execFileSync(process.execPath, [closeoutHelper, 'materialize-redteam-attestation'], {
      cwd: root,
      encoding: 'utf8',
    });
    const { output: attestationPath } = JSON.parse(output);
    const attestationHash = hashFile(join(root, attestationPath));
    git(root, 'add', attestationPath);
    git(root, 'commit', '--quiet', '-m', 'record redteam attestation');

    const discard = spawnSync(process.execPath, [
      closeoutHelper,
      'discard-redteam-attestation',
      '--expected-hash',
      attestationHash,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(discard.status, 0);
    assert.match(discard.stderr, /untracked/i);
    assert.equal(existsSync(join(root, attestationPath)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout refuses a dirty checkout before it writes approvals or receipts', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'uncommitted.txt'), 'dirty\n');
    const result = runCloseout(root, '--confirm');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dirty/i);
    assert.deepEqual(events(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout refuses a linked worktree before it writes approvals or receipts', () => {
  const root = fixture();
  const linked = join(root, '.worktrees', 'linked-closeout');
  try {
    mkdirSync(join(root, '.worktrees'), { recursive: true });
    git(root, 'worktree', 'add', '--detach', linked, 'HEAD');
    const result = runCloseout(linked, '--confirm');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /linked worktree|worktree/i);
    assert.deepEqual(events(linked), []);
  } finally {
    if (existsSync(linked)) git(root, 'worktree', 'remove', '--force', linked);
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout stops at the first failed gate with its phase name', () => {
  const root = fixture();
  try {
    const result = runCloseoutWithEnv(root, { CLOSEOUT_FAIL_PHASE: 'redteam' }, '--confirm');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /redteam gate did not pass/i);
    assert.deepEqual(
      events(root).filter(event => event.args[0] === 'gate' && event.args[1] === 'check').map(event => event.args[2]),
      ['init', 'spec', 'architecture', 'feasibility', 'redteam'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout can dry-run again after a failed gate record is committed', () => {
  const root = fixture();
  try {
    const failed = runCloseoutWithEnv(root, { CLOSEOUT_FAIL_PHASE: 'redteam' }, '--confirm');
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /preserve and commit its receipt/i);
    const eventsBeforeCommit = events(root);
    assert.ok(eventsBeforeCommit.length > 0);

    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'record failed closeout gate');
    assert.equal(git(root, 'status', '--porcelain'), '');

    const dryRun = runCloseout(root);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Dry run: no approvals or receipts were written\./);
    assert.deepEqual(events(root), eventsBeforeCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout does not materialize later approvals when init fails', () => {
  const root = fixture();
  try {
    const result = runCloseoutWithEnv(root, { CLOSEOUT_FAIL_PHASE: 'init' }, '--confirm');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /init gate did not pass/i);
    assert.equal(existsSync(join(root, 'decisions', 'owner-approvals', 'closeout-revision-65-spec-s5-approved.json')), false);
    assert.equal(existsSync(join(root, 'decisions', 'owner-approvals', 'phase-3-revision-65-dashboard-deferral-approved.json')), false);
    assert.deepEqual(
      events(root).filter(event => event.args[0] === 'gate' && event.args[1] === 'check').map(event => event.args[2]),
      ['init'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout stops plainly when the S5 authorization fails', () => {
  const root = fixture();
  try {
    const result = runCloseoutWithEnv(root, { CLOSEOUT_FAIL_OWNER_AUTHORIZE: '1' }, '--confirm');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /spec S5 authorization failed/i);
    assert.deepEqual(
      events(root).filter(event => event.args[0] === 'gate' && event.args[1] === 'check').map(event => event.args[2]),
      ['init'],
    );
    assert.equal(existsSync(join(root, 'decisions', 'owner-approvals', 'phase-3-revision-65-dashboard-deferral-approved.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner closeout reaches same-checkout release readiness before reporting external preflight inputs', () => {
  const root = fixture({ realReleaseReady: true });
  try {
    const result = runCloseoutWithEnv(root, { CLOSEOUT_REAL_RELEASE_READY: '1' }, '--confirm');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"result":\s*"READY"/);
    assert.match(result.stdout, /external preflight inputs remain/i);

    const report = verifyReleaseReady(root);
    assert.equal(report.result, 'READY', report.errors.join('\n'));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      externalPreflightInputs(root).map(input => input.code),
      [
        'BUILDER_IDENTITY_PENDING',
        'OWNER_WALLET_FUNDING_PENDING',
        'PROVIDER_API_KEY_PENDING',
        'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
