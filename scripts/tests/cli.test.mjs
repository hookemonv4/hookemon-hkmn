import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, sha256, writeJson } from '../lib/util.mjs';
import { writeRawReceipt } from './helpers/raw-receipt.mjs';
import { overrideSubjectInputs, writeOwnerApproval } from './helpers/owner-approval.mjs';
import { copyTrackedProjectFiles } from './helpers/tracked-project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', '..');

function proj(sourceRoot = templateRoot) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v4-')));
  copyTrackedProjectFiles(sourceRoot, root);
  rmSync(join(root, 'receipts'), { recursive: true, force: true });
  rmSync(join(root, '.v4'), { recursive: true, force: true });
  mkdirSync(join(root, 'receipts'));
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Hookemon']);
  execFileSync('git', ['-C', root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
  return root;
}
function v4(root, ...args) {
  return JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'v4.mjs'), ...args], { cwd: root, encoding: 'utf8' }).trim());
}
function v4Result(root, ...args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'v4.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

test('project fixtures exclude ignored worktree files while retaining tracked files', () => {
  const source = mkdtempSync(join(tmpdir(), 'v4-fixture-source-'));
  const sentinel = join(source, 'node_modules', 'tracked-fixture-sentinel', 'marker.txt');
  execFileSync('git', ['-C', source, 'init', '--quiet']);
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(source, 'tracked.txt'), 'tracked');
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, 'must not be copied into fixtures');
  execFileSync('git', ['-C', source, 'add', '.gitignore', 'tracked.txt']);

  const root = proj(source);

  assert.ok(existsSync(join(source, 'node_modules', 'tracked-fixture-sentinel', 'marker.txt')));
  assert.ok(existsSync(join(root, 'tracked.txt')));
  assert.equal(existsSync(join(root, 'node_modules', 'tracked-fixture-sentinel', 'marker.txt')), false);
});

test('status, task lifecycle and gate override work end to end through the CLI', () => {
  const root = proj();
  assert.equal(v4(root, 'status').currentPhase, 'init');
  v4(root, 'policy', 'gen');
  assert.ok(existsSync(join(root, 'AGENTS.md')));
  v4(root, 'task', 'add', 'T1', '--title', 'demo', '--req', 'REQ-core-1');
  const { token } = v4(root, 'task', 'claim', 'T1', '--owner', 'a');
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  v4(root, 'task', 'complete', 'T1', '--owner', 'a', '--token', String(token), '--commit', head);
  const rationale = 'owner decision: demo';
  const approval = 'decisions/owner-approvals/init-override.json';
  writeOwnerApproval(root, approval, {
    action: 'GATE_OVERRIDE', phase: 'init', itemId: null, rationale,
  }, overrideSubjectInputs(root, 'init'));
  const o = v4(root, 'gate', 'override', 'init', '--rationale', rationale, '--approval', approval);
  assert.equal(o.result, 'OVERRIDDEN');
  assert.equal(v4(root, 'status').currentPhase, 'spec');
});

test('task rebind-completion appends a descendant completion and regenerates tasks.json', () => {
  const root = proj();
  v4(root, 'task', 'add', 'T1', '--title', 'demo', '--req', 'REQ-core-1');
  const { token } = v4(root, 'task', 'claim', 'T1', '--owner', 'worker');
  const completion = execFileSync(
    'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();
  v4(
    root, 'task', 'complete', 'T1', '--owner', 'worker', '--token', String(token),
    '--commit', completion,
  );
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'integrated']);
  const integrated = execFileSync(
    'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();

  assert.deepEqual(v4(
    root, 'task', 'rebind-completion', 'T1', '--from', completion, '--commit', integrated,
  ), { ok: true, id: 'T1', commitSha: integrated });

  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    .tasks.find(task => task.id === 'T1');
  assert.equal(projected.status, 'done');
  assert.equal(projected.commitSha, integrated);
});

test('status --check rejects recorded failed, stale, and exhausted gates', () => {
  for (const result of ['FAILED', 'EXHAUSTED_WITH_OPEN_FINDINGS']) {
    const root = proj();
    writeRawReceipt(root, { type: 'gate', phase: 'init', result });
    assert.equal(v4Result(root, 'status', '--check').status, 1, result);
  }

  const staleRoot = proj();
  writeFileSync(join(staleRoot, 'evidence.txt'), 'v1');
  writeRawReceipt(staleRoot, {
    type: 'gate',
    phase: 'init',
    result: 'PASSED',
    inputs: ['evidence.txt'],
  });
  writeFileSync(join(staleRoot, 'evidence.txt'), 'v2');
  assert.equal(v4Result(staleRoot, 'status', '--check').status, 1, 'STALE');
});

test('status --check allows future pending phases', () => {
  const root = proj();
  writeJson(join(root, 'gates', 'init.json'), { id: 'init', version: 1, items: [] });
  assert.equal(v4(root, 'gate', 'check', 'init').result, 'PASSED');

  const checked = v4Result(root, 'status', '--check');

  assert.equal(checked.status, 0, checked.stderr);
  const state = JSON.parse(checked.stdout);
  assert.equal(state.currentPhase, 'spec');
  assert.equal(state.phases.find(phase => phase.phase === 'spec').result, 'PENDING');
});

test('task set-deps and owner-approved defer work end to end through the CLI', () => {
  const root = proj();
  for (const id of ['P1-008', 'P1-009', 'P1-010']) {
    v4(root, 'task', 'add', id, '--title', id, '--req', 'REQ-core-1');
  }
  v4(root, 'task', 'add', 'P1-011', '--title', 'dashboard', '--req', 'REQ-dashboard-1');
  v4(
    root, 'task', 'add', 'P1-012', '--title', 'release', '--req', 'REQ-core-1',
    '--dep', 'P1-008', '--dep', 'P1-009', '--dep', 'P1-010', '--dep', 'P1-011',
  );

  v4(
    root, 'task', 'set-deps', 'P1-012',
    '--dep', 'P1-008', '--dep', 'P1-009', '--dep', 'P1-010',
  );
  assert.deepEqual(
    v4(root, 'task', 'list').tasks.find(task => task.id === 'P1-012').deps,
    ['P1-008', 'P1-009', 'P1-010'],
  );

  const policyPath = join(root, 'policy/policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.autonomy.askFirst.push('Terminally deferring a task');
  writeJson(policyPath, policy);
  const decisionPath = 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md';
  const designPath = 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md';
  writeJson(join(root, decisionPath), { approved: true });
  writeJson(join(root, designPath), { approved: true });
  const row = v4(root, 'task', 'list').tasks.find(task => task.id === 'P1-011');
  const prestate = {
    id: row.id,
    title: row.title,
    phase: row.phase,
    risk: row.risk,
    deps: row.deps,
    reqs: row.reqs,
    status: row.status,
    leaseToken: row.lease_token,
    completionCommit: null,
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  const requirementsPath = join(root, 'specs/requirements.json');
  const requirements = JSON.parse(readFileSync(requirementsPath, 'utf8'));
  const rationale = 'Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope';
  const descriptorInput = 'decisions/task-deferrals/P1-011.json';
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-deferral-v1',
    action: 'TASK_DEFER',
    taskId: 'P1-011',
    phase: 'build',
    targetStatus: 'deferred',
    rationale,
    prestate,
    prestateFingerprint,
    requirements: {
      path: 'specs/requirements.json',
      revision: requirements.revision,
      sha256: hashFile(requirementsPath),
    },
    decision: { path: decisionPath, sha256: hashFile(join(root, decisionPath)) },
    design: { path: designPath, sha256: hashFile(join(root, designPath)) },
  });
  const approvalInput = 'decisions/owner-approvals/p1-011-defer.json';
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P1-011', rationale,
  }, ['policy/policy.json', descriptorInput]);

  const assertDeferFails = (...args) => {
    assert.notEqual(v4Result(root, 'task', 'defer', 'P1-011', ...args).status, 0);
    assert.equal(v4(root, 'task', 'list').tasks.find(task => task.id === 'P1-011').status, 'ready');
  };
  const validDeferArgs = [
    '--rationale', rationale,
    '--record', descriptorInput,
    '--approval', approvalInput,
  ];
  const restoreApproval = () => writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P1-011', rationale,
  }, ['policy/policy.json', descriptorInput]);

  writeOwnerApproval(root, approvalInput, {
    action: 'GATE_EVIDENCE', phase: 'build', itemId: 'P1-011', rationale,
  }, ['policy/policy.json', descriptorInput]);
  assertDeferFails(...validDeferArgs);
  restoreApproval();

  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'init', itemId: 'P1-011', rationale,
  }, ['policy/policy.json', descriptorInput]);
  assertDeferFails(...validDeferArgs);
  restoreApproval();

  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P1-012', rationale,
  }, ['policy/policy.json', descriptorInput]);
  assertDeferFails(...validDeferArgs);
  restoreApproval();

  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P1-011', rationale: `${rationale} altered`,
  }, ['policy/policy.json', descriptorInput]);
  assertDeferFails(...validDeferArgs);
  restoreApproval();

  const tamperedApproval = JSON.parse(readFileSync(join(root, approvalInput), 'utf8'));
  tamperedApproval.subjectHashes[descriptorInput] = '0'.repeat(64);
  writeJson(join(root, approvalInput), tamperedApproval);
  assertDeferFails(...validDeferArgs);
  restoreApproval();

  assertDeferFails(
    '--rationale', rationale,
    '--record', `../${descriptorInput}`,
    '--approval', approvalInput,
  );

  policy.autonomy.askFirst = policy.autonomy.askFirst
    .filter(action => action !== 'Terminally deferring a task');
  writeJson(policyPath, policy);
  assertDeferFails(...validDeferArgs);
  policy.autonomy.askFirst.push('Terminally deferring a task');
  writeJson(policyPath, policy);
  restoreApproval();

  assert.notEqual(
    v4Result(
      root, 'task', 'defer', 'P1-011', '--rationale', rationale,
      '--record', descriptorInput, '--approval', 'decisions/owner-approvals/missing.json',
    ).status,
    0,
  );
  v4(
    root, 'task', 'defer', 'P1-011', '--rationale', rationale,
    '--record', descriptorInput, '--approval', approvalInput,
  );
  const deferred = v4(root, 'task', 'list').tasks.find(task => task.id === 'P1-011');
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.defer_approval, approvalInput);
  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    .tasks.find(task => task.id === 'P1-011');
  assert.equal(projected.status, 'deferred');
  assert.equal(projected.deferApproval, approvalInput);
  assert.equal(Object.hasOwn(projected, 'commitSha'), false);
});
