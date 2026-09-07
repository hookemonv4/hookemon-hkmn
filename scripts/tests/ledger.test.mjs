import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openLedger, addTask, listTasks, nextTask, claimTask, completeTask, projectTasks,
  heartbeatTask, releaseTask, setTaskDeps, prepareTaskDeferral, deferTask,
  rebindCompletionCommit, prepareCompositeProvenanceRebind, validateCompositeProvenanceRebindApproval,
  rebindCompletionCompositeProvenance, compositeProvenanceRetainedPatchSha256,
} from '../lib/ledger.mjs';
import {
  hashFile, readJson, sha256, writeJson,
} from '../lib/util.mjs';
import { validateTaskDeferralApproval } from '../lib/gates.mjs';
import { writeOwnerApproval } from './helpers/owner-approval.mjs';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Hookemon']);
  execFileSync('git', ['-C', root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const branch = execFileSync(
    'git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' },
  ).trim();
  return { root, head, branch };
}

function deferralAuthority(root, db, taskId) {
  const current = prepareTaskDeferral(db, taskId);
  const rationale = 'Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope';
  const descriptorInput = `decisions/task-deferrals/${taskId}.json`;
  const approvalInput = `decisions/owner-approvals/${taskId.toLowerCase()}-defer.json`;
  const requirementsInput = 'specs/requirements.json';
  const decisionInput = 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md';
  const designInput = 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md';
  writeJson(join(root, 'policy/policy.json'), {
    autonomy: {
      askFirst: ['Terminally deferring a task'],
      never: ['Approve your own work on behalf of the owner'],
    },
  });
  writeJson(join(root, requirementsInput), { revision: 55, requirements: [] });
  writeJson(join(root, decisionInput), { approved: true });
  writeJson(join(root, designInput), { approved: true });
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-deferral-v1',
    action: 'TASK_DEFER',
    taskId,
    phase: current.prestate.phase,
    targetStatus: 'deferred',
    rationale,
    prestate: current.prestate,
    prestateFingerprint: current.fingerprint,
    requirements: {
      path: requirementsInput,
      revision: 55,
      sha256: hashFile(join(root, requirementsInput)),
    },
    decision: { path: decisionInput, sha256: hashFile(join(root, decisionInput)) },
    design: { path: designInput, sha256: hashFile(join(root, designInput)) },
  });
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: current.prestate.phase, itemId: taskId, rationale,
  }, ['policy/policy.json', descriptorInput]);
  return validateTaskDeferralApproval(root, {
    taskId,
    phase: current.prestate.phase,
    rationale,
    descriptorInput,
    approvalInput,
    prestate: current.prestate,
    prestateFingerprint: current.fingerprint,
  }).authority;
}

function rev(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function blobIdAt(root, commitSha, path) {
  return execFileSync('git', ['-C', root, 'rev-parse', `${commitSha}:${path}`], { encoding: 'utf8' }).trim();
}

function commitFiles(root, files, message) {
  for (const [path, content] of files) {
    writeFileSync(join(root, path), content);
    execFileSync('git', ['-C', root, 'add', path]);
  }
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', message]);
  return rev(root);
}

const COMPOSITE_PROVENANCE_RETAINED_PATHS = [
  'retained-1.mjs', 'retained-2.mjs', 'retained-3.mjs', 'retained-4.mjs', 'retained-5.mjs',
].sort();
const COMPOSITE_PROVENANCE_OMITTED_CONTENT = [
  ['omitted-a.mjs', 'const omittedA = "old-a";\n'],
  ['omitted-b.mjs', 'const omittedB = "old-b";\n'],
];

// The old completion, built while it is still reachable from HEAD so `completeTask` accepts it
// (matching how the real BOT-CLEANROOM completion was originally recorded before its history was
// rewritten out from under it).
function commitCompositeProvenanceOldCompletion(root) {
  return commitFiles(root, [
    ...COMPOSITE_PROVENANCE_RETAINED_PATHS.map(path => [path, `export const value = "${path} v1";\n`]),
    ...COMPOSITE_PROVENANCE_OMITTED_CONTENT,
  ], 'original composite completion');
}

// Rewrites history from `base` onward so the old completion becomes unreachable, then builds the
// evidence shape from the proposal: five retained files carried intact by a source commit
// reachable from the target, and two omitted files byte-identical to an independently merged
// domain foundation reachable from the same target.
function rewriteCompositeProvenanceHistory({
  root, base, branch, fromCommit,
}) {
  execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', base]);
  execFileSync('git', ['-C', root, 'checkout', '--quiet', '-b', 'domain']);
  const domainFoundationCommit = commitFiles(root, COMPOSITE_PROVENANCE_OMITTED_CONTENT, 'domain foundation');
  execFileSync('git', ['-C', root, 'checkout', '--quiet', branch]);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'mainline progress']);
  execFileSync('git', ['-C', root, 'merge', '--quiet', '--no-ff', 'domain', '-m', 'merge domain foundation']);
  const domainMergeCommit = rev(root);

  const sourceCommit = commitFiles(
    root,
    COMPOSITE_PROVENANCE_RETAINED_PATHS.map(path => [path, `export const value = "${path} v1";\n`]),
    'retained patch source',
  );
  const target = commitFiles(
    root,
    ['retained-1.mjs', 'retained-2.mjs', 'retained-3.mjs'].map(
      path => [path, `export const value = "${path} v2 evolved";\n`],
    ),
    'later evolution',
  );

  const retainedPatchSha256 = compositeProvenanceRetainedPatchSha256(
    root, fromCommit, COMPOSITE_PROVENANCE_RETAINED_PATHS,
  );
  const omittedFiles = COMPOSITE_PROVENANCE_OMITTED_CONTENT
    .map(([path]) => ({ path, blob: blobIdAt(root, fromCommit, path) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    fromCommit,
    target,
    sourceCommit,
    domainFoundationCommit,
    domainMergeCommit,
    retainedPaths: COMPOSITE_PROVENANCE_RETAINED_PATHS,
    retainedPatchSha256,
    omittedFiles,
  };
}

function writeCompositeProvenanceDescriptor(root, taskId, fixture, prestate, prestateFingerprint, rationale) {
  const descriptorInput = `decisions/task-rebinds/${taskId}.json`;
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-rebind-composite-provenance-v1',
    action: 'TASK_REBIND_COMPOSITE_PROVENANCE',
    taskId,
    phase: prestate.phase,
    fromCommit: fixture.fromCommit,
    target: fixture.target,
    prestate,
    prestateFingerprint,
    retainedPatch: {
      paths: fixture.retainedPaths,
      sourceCommit: fixture.sourceCommit,
      sha256: fixture.retainedPatchSha256,
    },
    omittedFiles: fixture.omittedFiles,
    domainFoundationCommit: fixture.domainFoundationCommit,
    domainMergeCommit: fixture.domainMergeCommit,
    rationale,
  });
  return descriptorInput;
}

function setupCompositeProvenanceCase() {
  const { root, head: base, branch } = repo();
  const db = openLedger(root);
  const taskId = 'BOT-CLEANROOM';
  addTask(db, { id: taskId, title: 'cleanroom import', phase: 'build' });
  const { token } = claimTask(db, taskId, 'worker');

  // Complete the task while the old commit is still reachable from HEAD, then rewrite history
  // out from under it, exactly like the real orphaned-completion scenario this route repairs.
  const fromCommit = commitCompositeProvenanceOldCompletion(root);
  completeTask(db, taskId, 'worker', token, fromCommit);
  const fixture = rewriteCompositeProvenanceHistory({
    root, base, branch, fromCommit,
  });

  const current = prepareCompositeProvenanceRebind(db, taskId);
  const rationale = 'Owner-approved composite provenance for the exact BOT-CLEANROOM evidence record';
  const descriptorInput = writeCompositeProvenanceDescriptor(
    root, taskId, fixture, current.prestate, current.fingerprint, rationale,
  );
  const approvalInput = 'decisions/owner-approvals/bot-cleanroom-composite-provenance.json';
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_REBIND_COMPOSITE_PROVENANCE', phase: current.prestate.phase, itemId: taskId, rationale,
  }, [descriptorInput]);

  return {
    root, db, taskId, fixture, current, rationale, descriptorInput, approvalInput,
  };
}

test('lease is atomic and fencing tokens protect completion', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'freeze interface', phase: 'build', reqs: ['REQ-core-1'] });
  addTask(db, { id: 'T2', title: 'implement module', deps: ['T1'] });
  assert.throws(() => claimTask(db, 'T2', 'agent-a'), /dependency T1 not done/);
  const { token } = claimTask(db, 'T1', 'agent-a');
  assert.equal(token, 1);
  assert.throws(() => claimTask(db, 'T1', 'agent-b'), /leased/);
  assert.throws(() => completeTask(db, 'T1', 'agent-b', token), /fencing/);
  completeTask(db, 'T1', 'agent-a', token, head);
  const { token: t2 } = claimTask(db, 'T2', 'agent-b');
  assert.equal(t2, 1);
  projectTasks(db, root);
  const proj = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'));
  assert.equal(proj.tasks.find(t => t.id === 'T1').status, 'done');
  assert.equal(proj.tasks.find(t => t.id === 'T1').commitSha, head);
  assert.equal(Object.hasOwn(proj.tasks.find(t => t.id === 'T2'), 'commitSha'), false);
});

test('expired leases can be reclaimed with a higher fencing token', () => {
  const { root } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'x' });
  const { token } = claimTask(db, 'T1', 'agent-a', -1);
  const { token: token2 } = claimTask(db, 'T1', 'agent-b');
  assert.equal(token2, token + 1);
  assert.throws(() => completeTask(db, 'T1', 'agent-a', token), /fencing/);
});

test('nextTask returns the first claimable task, skipping leased and blocked', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'A1', title: 'contract' });
  addTask(db, { id: 'F1', title: 'ui', deps: ['A1'] });
  addTask(db, { id: 'B1', title: 'api' });
  assert.equal(nextTask(db).id, 'A1');
  const { token } = claimTask(db, 'A1', 'w1');
  assert.equal(nextTask(db).id, 'B1');
  completeTask(db, 'A1', 'w1', token, head);
  claimTask(db, 'B1', 'w2');
  assert.equal(nextTask(db).id, 'F1');
});

test('task projection revalidates the recorded completion commit', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'project commit', phase: 'build' });
  const { token } = claimTask(db, 'T1', 'worker');
  completeTask(db, 'T1', 'worker', token, head);
  db.prepare("UPDATE attempts SET commit_sha=? WHERE task_id='T1'").run('0'.repeat(40));

  assert.throws(() => projectTasks(db, root), /not an existing commit object/);
});

test('rebindCompletionCommit appends completion history and projects the descendant commit', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'project commit', phase: 'build' });
  const { token } = claimTask(db, 'T1', 'worker');
  completeTask(db, 'T1', 'worker', token, head);
  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'integrated']);
  const integrated = execFileSync(
    'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();

  rebindCompletionCommit(db, 'T1', head, integrated);
  projectTasks(db, root);

  const attemptsAfter = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  assert.deepEqual(attemptsAfter.slice(0, attemptsBefore.length), attemptsBefore);
  assert.equal(attemptsAfter.length, attemptsBefore.length + 1);
  assert.equal(attemptsAfter.at(-1).task_id, 'T1');
  assert.equal(attemptsAfter.at(-1).outcome, 'done');
  assert.equal(attemptsAfter.at(-1).commit_sha, integrated);
  assert.deepEqual(JSON.parse(attemptsAfter.at(-1).provenance), {
    route: 'descendant', from: head, target: integrated,
  });
  const task = listTasks(db).find(candidate => candidate.id === 'T1');
  assert.equal(task.status, 'done');
  assert.equal(task.lease_owner, null);
  assert.equal(task.lease_token, token);
  assert.equal(task.lease_expires, null);
  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(projected.commitSha, integrated);
});

test('rebindCompletionCommit accepts a rewritten completion whose canonical raw patch matches and records stable-patch-id provenance', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'rewrite', phase: 'build' });
  const { token } = claimTask(db, 'T1', 'worker');
  writeFileSync(join(root, 'file.txt'), 'same content\n');
  execFileSync('git', ['-C', root, 'add', 'file.txt']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'original change']);
  const original = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  completeTask(db, 'T1', 'worker', token, original);

  execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
  writeFileSync(join(root, 'file.txt'), 'same content\n');
  execFileSync('git', ['-C', root, 'add', 'file.txt']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'rewritten change']);
  const rewritten = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  rebindCompletionCommit(db, 'T1', original, rewritten);
  projectTasks(db, root);

  const attempt = db.prepare('SELECT * FROM attempts ORDER BY seq').all().at(-1);
  assert.equal(attempt.commit_sha, rewritten);
  const provenance = JSON.parse(attempt.provenance);
  assert.equal(provenance.route, 'stable-patch-id');
  assert.equal(provenance.from, original);
  assert.equal(provenance.target, rewritten);
  assert.match(provenance.patchId, /^[0-9a-f]{40}$/);
  assert.match(provenance.rawPatchSha256, /^[0-9a-f]{64}$/);
  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(projected.commitSha, rewritten);
});

test('rebindCompletionCommit refuses a whitespace-only rewrite even though its stable patch id matches', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'rewrite', phase: 'build' });
  const { token } = claimTask(db, 'T1', 'worker');
  writeFileSync(join(root, 'file.txt'), 'const s = "hello  world";\n');
  execFileSync('git', ['-C', root, 'add', 'file.txt']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'original change']);
  const original = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  completeTask(db, 'T1', 'worker', token, original);

  execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
  writeFileSync(join(root, 'file.txt'), 'const s = "hello world";\n');
  execFileSync('git', ['-C', root, 'add', 'file.txt']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'semantically different change']);
  const rewritten = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  assert.throws(
    () => rebindCompletionCommit(db, 'T1', original, rewritten),
    /canonical patch does not match/,
  );
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);
});

test('rebindCompletionCommit rejects merge commits, empty patches, and mismatched patch ids on the rewritten-source route without mutation', () => {
  const assertRejectedWithoutMutation = ({ db, root, attempt, error }) => {
    const before = {
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY seq').all(),
    };
    assert.throws(attempt, error);
    assert.deepEqual({
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY seq').all(),
    }, before);
  };

  {
    const { root, head, branch } = repo();
    const db = openLedger(root);
    addTask(db, { id: 'T1', title: 'x' });
    const { token } = claimTask(db, 'T1', 'worker');
    writeFileSync(join(root, 'file.txt'), 'value\n');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'original']);
    const original = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    completeTask(db, 'T1', 'worker', token, original);

    execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
    execFileSync('git', ['-C', root, 'checkout', '--quiet', '-b', 'side']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'side']);
    execFileSync('git', ['-C', root, 'checkout', '--quiet', branch]);
    execFileSync('git', ['-C', root, 'merge', '--quiet', '--no-ff', 'side', '-m', 'merge']);
    const merged = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', original, merged),
      error: /is a merge commit/,
    });
  }

  {
    const { root, head, branch } = repo();
    const db = openLedger(root);
    addTask(db, { id: 'T1', title: 'x' });
    const { token } = claimTask(db, 'T1', 'worker');
    execFileSync('git', ['-C', root, 'checkout', '--quiet', '-b', 'side']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'side']);
    execFileSync('git', ['-C', root, 'checkout', '--quiet', branch]);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'main-tip']);
    execFileSync('git', ['-C', root, 'merge', '--quiet', '--no-ff', 'side', '-m', 'merge']);
    const merged = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    completeTask(db, 'T1', 'worker', token, merged);

    execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
    writeFileSync(join(root, 'file.txt'), 'value\n');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'rewritten']);
    const rewritten = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', merged, rewritten),
      error: /is a merge commit/,
    });
  }

  {
    const { root, head } = repo();
    const db = openLedger(root);
    addTask(db, { id: 'T1', title: 'x' });
    const { token } = claimTask(db, 'T1', 'worker');
    writeFileSync(join(root, 'file.txt'), 'value\n');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'original']);
    const original = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    completeTask(db, 'T1', 'worker', token, original);

    execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'noop']);
    const empty = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', original, empty),
      error: /produced an empty patch/,
    });
  }

  {
    const { root, head } = repo();
    const db = openLedger(root);
    addTask(db, { id: 'T1', title: 'x' });
    const { token } = claimTask(db, 'T1', 'worker');
    writeFileSync(join(root, 'file.txt'), 'value\n');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'original']);
    const original = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    completeTask(db, 'T1', 'worker', token, original);

    execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
    writeFileSync(join(root, 'other.txt'), 'unrelated\n');
    execFileSync('git', ['-C', root, 'add', 'other.txt']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'unrelated change']);
    const unrelated = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', original, unrelated),
      error: /stable patch id does not match/,
    });
  }
});

test('rebindCompletionCommit refuses a rewrite whose non-UTF-8 payload bytes differ, even though naive UTF-8 decoding would collapse them', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'x' });
  const { token } = claimTask(db, 'T1', 'worker');

  const build = byte => {
    writeFileSync(join(root, 'shared.txt'), 'same content\n');
    execFileSync('git', ['-C', root, 'add', 'shared.txt']);
    writeFileSync(join(root, 'legacy.txt'), Buffer.from([0x61, byte, 0x0a]));
    execFileSync('git', ['-C', root, 'add', 'legacy.txt']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', `change ${byte}`]);
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };

  const original = build(0x80);
  completeTask(db, 'T1', 'worker', token, original);
  execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
  const rewritten = build(0x81);

  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  assert.throws(
    () => rebindCompletionCommit(db, 'T1', original, rewritten),
    /stable patch id does not match/,
  );
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);
});

test('rebindCompletionCommit refuses a rewrite that only differs in a gitlink target hidden by an inherited diff.ignoreSubmodules config', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'x' });
  const { token } = claimTask(db, 'T1', 'worker');

  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'other-target']);
  const otherTarget = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);

  const build = gitlinkSha => {
    writeFileSync(join(root, 'shared.txt'), 'same content\n');
    execFileSync('git', ['-C', root, 'add', 'shared.txt']);
    execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${gitlinkSha},module`]);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', `link ${gitlinkSha}`]);
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  };

  const original = build(head);
  completeTask(db, 'T1', 'worker', token, original);
  execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', head]);
  const rewritten = build(otherTarget);
  execFileSync('git', ['-C', root, 'config', 'diff.ignoreSubmodules', 'all']);

  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  assert.throws(
    () => rebindCompletionCommit(db, 'T1', original, rewritten),
    /stable patch id does not match/,
  );
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);
});

test('rebindCompletionCommit rejects invalid state or ancestry without mutation', () => {
  const assertRejectedWithoutMutation = ({ db, root, attempt, error }) => {
    const before = {
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY seq').all(),
      projection: readFileSync(join(root, 'tasks.json'), 'utf8'),
    };
    assert.throws(attempt, error);
    assert.deepEqual({
      tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY seq').all(),
      projection: readFileSync(join(root, 'tasks.json'), 'utf8'),
    }, before);
  };

  {
    const { root, head } = repo();
    const db = openLedger(root);
    addTask(db, { id: 'T1', title: 'done task' });
    const { token } = claimTask(db, 'T1', 'worker');
    completeTask(db, 'T1', 'worker', token, head);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'integrated']);
    const integrated = execFileSync(
      'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
    ).trim();
    projectTasks(db, root);

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', '0'.repeat(40), integrated),
      error: /current completion .* does not match requested/,
    });
    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', head, 'f'.repeat(40)),
      error: /not an existing commit object/,
    });
    db.prepare(`
      UPDATE tasks SET lease_owner='stale-worker', lease_expires=? WHERE id='T1'
    `).run(Date.now() + 60_000);
    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', head, integrated),
      error: /task T1 is leased/,
    });
  }

  for (const status of ['ready', 'deferred']) {
    const { root, head } = repo();
    const db = openLedger(root);
    addTask(db, { id: 'T1', title: `${status} task` });
    projectTasks(db, root);
    if (status === 'deferred') {
      db.prepare("UPDATE tasks SET status='deferred' WHERE id='T1'").run();
    }
    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', head, head),
      error: new RegExp(`task T1 is ${status}`),
    });
  }

  {
    const { root, head, branch } = repo();
    const db = openLedger(root);
    execFileSync('git', ['-C', root, 'checkout', '--quiet', '-b', 'completion']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'completion']);
    const completion = execFileSync(
      'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['-C', root, 'checkout', '--quiet', branch]);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'sibling']);
    const sibling = execFileSync(
      'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['-C', root, 'merge', '--quiet', '--no-ff', 'completion', '-m', 'merge']);
    addTask(db, { id: 'T1', title: 'done task' });
    const { token } = claimTask(db, 'T1', 'worker');
    completeTask(db, 'T1', 'worker', token, completion);
    projectTasks(db, root);

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', completion, sibling),
      error: /is not descended from/,
    });
    assert.notEqual(head, sibling);
  }

  {
    const { root, head, branch } = repo();
    const db = openLedger(root);
    execFileSync('git', ['-C', root, 'checkout', '--quiet', '-b', 'unreachable']);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'unreachable']);
    const unreachable = execFileSync(
      'git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['-C', root, 'checkout', '--quiet', branch]);
    addTask(db, { id: 'T1', title: 'done task' });
    const { token } = claimTask(db, 'T1', 'worker');
    completeTask(db, 'T1', 'worker', token, head);
    projectTasks(db, root);

    assertRejectedWithoutMutation({
      db, root,
      attempt: () => rebindCompletionCommit(db, 'T1', head, unreachable),
      error: /not reachable from current HEAD/,
    });
  }
});

test('setTaskDeps replaces only dependencies on an unleased ready task', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  for (const id of ['P1-008', 'P1-009', 'P1-010']) {
    addTask(db, { id, title: id });
  }
  addTask(db, { id: 'P1-012', title: 'release proof', deps: ['P1-008'] });
  const before = db.prepare('SELECT lease_token FROM tasks WHERE id=?').get('P1-012');
  const attemptsBefore = db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count;

  setTaskDeps(db, 'P1-012', ['P1-008', 'P1-009', 'P1-010']);

  const projected = listTasks(db).find(task => task.id === 'P1-012');
  assert.deepEqual(projected.deps, ['P1-008', 'P1-009', 'P1-010']);
  assert.equal(projected.lease_token, before.lease_token);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count, attemptsBefore);
  for (const id of ['P1-008', 'P1-009', 'P1-010']) {
    const { token } = claimTask(db, id, 'worker');
    completeTask(db, id, 'worker', token, head);
  }
  assert.equal(nextTask(db).id, 'P1-012');
});

test('setTaskDeps rejects invalid graphs and any leased or non-ready target', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'A', title: 'A' });
  addTask(db, { id: 'B', title: 'B', deps: ['A'] });
  addTask(db, { id: 'C', title: 'C' });

  const assertRejectedWithoutMutation = (attempt, error) => {
    const before = {
      tasks: db.prepare('SELECT id, lease_token, lease_owner, lease_expires FROM tasks ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY seq').all(),
    };
    assert.throws(attempt, error);
    assert.deepEqual({
      tasks: db.prepare('SELECT id, lease_token, lease_owner, lease_expires FROM tasks ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM attempts ORDER BY seq').all(),
    }, before);
  };

  assertRejectedWithoutMutation(() => setTaskDeps(db, 'missing', []), /no such task missing/);
  assertRejectedWithoutMutation(() => setTaskDeps(db, 'A', ['missing']), /no such dependency missing/);
  assertRejectedWithoutMutation(() => setTaskDeps(db, 'A', ['A']), /cannot depend on itself/);
  assertRejectedWithoutMutation(() => setTaskDeps(db, 'A', ['B', 'B']), /duplicate dependency B/);
  assertRejectedWithoutMutation(() => setTaskDeps(db, 'A', ['B']), /dependency cycle/);

  claimTask(db, 'C', 'worker', -1);
  assertRejectedWithoutMutation(() => setTaskDeps(db, 'C', []), /task C is leased/);

  const { token } = claimTask(db, 'A', 'worker');
  completeTask(db, 'A', 'worker', token, head);
  assertRejectedWithoutMutation(() => setTaskDeps(db, 'A', []), /task A is done/);
});

test('deferTask rejects caller-supplied artifact paths without validated authority', () => {
  const { root } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'P1-011', title: 'dashboard' });
  const before = prepareTaskDeferral(db, 'P1-011');

  assert.throws(
    () => deferTask(db, 'P1-011', {
      expectedFingerprint: before.fingerprint,
      descriptorInput: 'decisions/task-deferrals/P1-011.json',
      approvalInput: 'decisions/owner-approvals/P1-011.json',
    }),
    /validated owner authorization/,
  );
  assert.equal(listTasks(db).find(task => task.id === 'P1-011').status, 'ready');
});

test('projectTasks rejects a deferred row without validated owner authority', () => {
  const { root } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'P1-011', title: 'dashboard' });
  const before = prepareTaskDeferral(db, 'P1-011');
  db.prepare(`
    UPDATE tasks SET status='deferred', defer_approval=?, defer_descriptor=?, defer_prestate_fingerprint=?
    WHERE id=?
  `).run(
    'decisions/owner-approvals/P1-011.json',
    'decisions/task-deferrals/P1-011.json',
    before.fingerprint,
    'P1-011',
  );

  assert.throws(() => projectTasks(db, root), /ENOENT|task deferral descriptor|owner approval|validated owner authorization/);
});

test('deferTask is terminal and preserves fencing and attempt history', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'P1-011', title: 'dashboard', reqs: ['REQ-dashboard-1'] });
  const { token } = claimTask(db, 'P1-011', 'dashboard-worker');
  releaseTask(db, 'P1-011', 'dashboard-worker', token);
  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  const before = prepareTaskDeferral(db, 'P1-011');

  deferTask(db, 'P1-011', {
    authority: deferralAuthority(root, db, 'P1-011'),
  });

  const task = listTasks(db).find(candidate => candidate.id === 'P1-011');
  assert.equal(task.status, 'deferred');
  assert.equal(task.lease_token, token);
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);
  assert.equal(nextTask(db), null);
  assert.throws(
    () => heartbeatTask(db, 'P1-011', 'dashboard-worker', token),
    /fencing token mismatch/,
  );
  assert.throws(
    () => completeTask(db, 'P1-011', 'dashboard-worker', token, head),
    /fencing token mismatch/,
  );

  projectTasks(db, root);
  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(projected.status, 'deferred');
  assert.equal(projected.deferApproval, 'decisions/owner-approvals/p1-011-defer.json');
  assert.equal(projected.deferDescriptor, 'decisions/task-deferrals/P1-011.json');
  assert.equal(projected.deferPrestateFingerprint, before.fingerprint);
  assert.equal(Object.hasOwn(projected, 'commitSha'), false);
  assert.equal(Object.hasOwn(projected, 'defer_approval'), false);
});

test('deferTask can retire unmerged done work without revalidating its completion commit', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'P1-011', title: 'dashboard' });
  const { token } = claimTask(db, 'P1-011', 'dashboard-worker');
  completeTask(db, 'P1-011', 'dashboard-worker', token, head);
  db.prepare("UPDATE attempts SET commit_sha=? WHERE task_id='P1-011'").run('0'.repeat(40));
  const before = prepareTaskDeferral(db, 'P1-011');

  deferTask(db, 'P1-011', {
    authority: deferralAuthority(root, db, 'P1-011'),
  });

  assert.doesNotThrow(() => projectTasks(db, root));
  assert.equal(JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')).tasks[0].status, 'deferred');
});

test('deferTask rejects leases, dependents, and stale prestate fingerprints', () => {
  const { root } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'P1-011', title: 'dashboard' });
  addTask(db, { id: 'P1-012', title: 'release', deps: ['P1-011'] });
  assert.throws(() => prepareTaskDeferral(db, 'P1-011'), /still required by P1-012/);
  setTaskDeps(db, 'P1-012', []);

  claimTask(db, 'P1-011', 'dashboard-worker', -1);
  assert.throws(() => prepareTaskDeferral(db, 'P1-011'), /task P1-011 is leased/);
  const row = db.prepare("SELECT lease_token FROM tasks WHERE id='P1-011'").get();
  releaseTask(db, 'P1-011', 'dashboard-worker', row.lease_token);
  const before = prepareTaskDeferral(db, 'P1-011');

  assert.throws(
    () => deferTask(db, 'P1-011', {
      authority: {},
    }),
    /validated owner authorization/,
  );
  assert.equal(prepareTaskDeferral(db, 'P1-011').fingerprint, before.fingerprint);
});

test('task deferral is restricted to the approved dashboard task', () => {
  const { root } = repo();
  const db = openLedger(root);
  for (const taskId of ['P1-009', 'P1-010', 'P1-012']) addTask(db, { id: taskId, title: taskId });
  for (const taskId of ['P1-009', 'P1-010', 'P1-012']) {
    assert.throws(() => prepareTaskDeferral(db, taskId), /only P1-011 may be deferred/);
  }
});

test('composite-provenance rebind accepts the exact valid seven-path partition and records provenance', () => {
  const {
    root, db, taskId, fixture, descriptorInput, approvalInput, rationale, current,
  } = setupCompositeProvenanceCase();
  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();

  const descriptor = validateCompositeProvenanceRebindApproval(root, {
    taskId,
    fromCommitSha: fixture.fromCommit,
    commitSha: fixture.target,
    rationale,
    descriptorInput,
    approvalInput,
    prestate: current.prestate,
    prestateFingerprint: current.fingerprint,
  });
  rebindCompletionCompositeProvenance(db, taskId, fixture.fromCommit, fixture.target, {
    authority: descriptor.authority,
  });
  projectTasks(db, root);

  const attemptsAfter = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  assert.deepEqual(attemptsAfter.slice(0, attemptsBefore.length), attemptsBefore);
  assert.equal(attemptsAfter.length, attemptsBefore.length + 1);
  const last = attemptsAfter.at(-1);
  assert.equal(last.commit_sha, fixture.target);
  assert.equal(last.outcome, 'done');
  assert.equal(last.owner, 'completion-rebind');
  const provenance = JSON.parse(last.provenance);
  assert.equal(provenance.route, 'owner-approved-composite-provenance');
  assert.equal(provenance.from, fixture.fromCommit);
  assert.equal(provenance.target, fixture.target);
  assert.deepEqual(provenance.retainedPatch.paths, fixture.retainedPaths);
  assert.equal(provenance.retainedPatch.sourceCommit, fixture.sourceCommit);
  assert.equal(provenance.retainedPatch.sha256, fixture.retainedPatchSha256);
  assert.deepEqual(provenance.omittedFiles, fixture.omittedFiles);
  assert.equal(provenance.domainFoundationCommit, fixture.domainFoundationCommit);
  assert.equal(provenance.domainMergeCommit, fixture.domainMergeCommit);
  assert.equal(provenance.descriptorInput, descriptorInput);
  assert.equal(provenance.approvalInput, approvalInput);

  const task = listTasks(db).find(candidate => candidate.id === taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.lease_owner, null);

  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    .tasks.find(candidate => candidate.id === taskId);
  assert.equal(projected.commitSha, fixture.target);
});

test('composite-provenance rebind is restricted to BOT-CLEANROOM', () => {
  const { root, head } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'OTHER-TASK', title: 'x' });
  const { token } = claimTask(db, 'OTHER-TASK', 'worker');
  completeTask(db, 'OTHER-TASK', 'worker', token, head);

  assert.throws(() => prepareCompositeProvenanceRebind(db, 'OTHER-TASK'), /only BOT-CLEANROOM/);
  assert.throws(
    () => validateCompositeProvenanceRebindApproval(root, {
      taskId: 'OTHER-TASK',
      fromCommitSha: head,
      commitSha: head,
      rationale: 'x',
      descriptorInput: 'decisions/task-rebinds/OTHER-TASK.json',
      approvalInput: 'decisions/owner-approvals/other-task.json',
      prestate: {},
      prestateFingerprint: 'x',
    }),
    /only BOT-CLEANROOM/,
  );
  assert.throws(
    () => rebindCompletionCompositeProvenance(db, 'OTHER-TASK', head, head, { authority: {} }),
    /only BOT-CLEANROOM/,
  );
});

test('composite-provenance rebind rejects tampered bytes, paths, source, target, and prestate without mutation', () => {
  const {
    root, db, taskId, fixture, descriptorInput, approvalInput, rationale, current,
  } = setupCompositeProvenanceCase();
  const originalDescriptor = readJson(join(root, descriptorInput));
  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();

  const assertTamperRejected = (mutate, errorPattern) => {
    const tampered = JSON.parse(JSON.stringify(originalDescriptor));
    mutate(tampered);
    writeJson(join(root, descriptorInput), tampered);
    assert.throws(() => validateCompositeProvenanceRebindApproval(root, {
      taskId,
      fromCommitSha: fixture.fromCommit,
      commitSha: fixture.target,
      rationale,
      descriptorInput,
      approvalInput,
      prestate: current.prestate,
      prestateFingerprint: current.fingerprint,
    }), errorPattern);
    assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);
    writeJson(join(root, descriptorInput), originalDescriptor);
  };

  assertTamperRejected(
    d => { d.retainedPatch.sha256 = '0'.repeat(64); },
    /does not match the declared patch hash/,
  );
  assertTamperRejected(
    d => { d.retainedPatch.sourceCommit = d.domainFoundationCommit; },
    /does not match the declared patch hash/,
  );
  assertTamperRejected(
    d => {
      d.retainedPatch.paths = [...d.retainedPatch.paths.slice(1), 'unrelated.mjs'].sort();
    },
    /must change exactly the seven declared paths/,
  );
  assertTamperRejected(
    d => { d.omittedFiles[0].blob = '1'.repeat(40); },
    /is not an existing blob object/,
  );
  assertTamperRejected(
    d => { d.omittedFiles[1].path = d.retainedPatch.paths.at(-1); },
    /must not overlap/,
  );
  assertTamperRejected(
    d => { d.target = d.domainFoundationCommit; },
    /does not match the requested from\/target commits/,
  );
  assertTamperRejected(
    d => { d.fromCommit = d.target; },
    /does not match the requested from\/target commits/,
  );
  assertTamperRejected(
    d => { d.prestate.title = 'a title the owner never approved'; },
    /prestate fingerprint does not match/,
  );
  assertTamperRejected(
    d => { d.rationale = 'a rationale nobody approved'; },
    /rationale does not match the requested rationale/,
  );
});

test('composite-provenance rebind requires the old completion to be unreachable from HEAD', () => {
  const { root, head: base, branch } = repo();
  const taskId = 'BOT-CLEANROOM';
  const fromCommit = commitCompositeProvenanceOldCompletion(root);
  const fixture = rewriteCompositeProvenanceHistory({
    root, base, branch, fromCommit,
  });
  const rationale = 'x';
  const prestate = {
    id: taskId,
    title: 'x',
    phase: 'build',
    risk: 'ordinary',
    deps: [],
    reqs: [],
    status: 'done',
    leaseToken: 1,
    completionCommit: fixture.target,
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  const descriptorInput = 'decisions/task-rebinds/BOT-CLEANROOM.json';
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-rebind-composite-provenance-v1',
    action: 'TASK_REBIND_COMPOSITE_PROVENANCE',
    taskId,
    phase: prestate.phase,
    fromCommit: fixture.target,
    target: fixture.target,
    prestate,
    prestateFingerprint,
    retainedPatch: {
      paths: fixture.retainedPaths, sourceCommit: fixture.sourceCommit, sha256: fixture.retainedPatchSha256,
    },
    omittedFiles: fixture.omittedFiles,
    domainFoundationCommit: fixture.domainFoundationCommit,
    domainMergeCommit: fixture.domainMergeCommit,
    rationale,
  });
  const approvalInput = 'decisions/owner-approvals/bot-cleanroom-composite-provenance.json';
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_REBIND_COMPOSITE_PROVENANCE', phase: prestate.phase, itemId: taskId, rationale,
  }, [descriptorInput]);

  assert.throws(
    () => validateCompositeProvenanceRebindApproval(root, {
      taskId,
      fromCommitSha: fixture.target,
      commitSha: fixture.target,
      rationale,
      descriptorInput,
      approvalInput,
      prestate,
      prestateFingerprint,
    }),
    /is reachable from current HEAD; use the descendant or stable-patch-id route instead/,
  );
});

test('composite-provenance rebind rejects an old completion that changes an extra unpartitioned path', () => {
  const { root, head: base, branch } = repo();
  const db = openLedger(root);
  const taskId = 'BOT-CLEANROOM';
  addTask(db, { id: taskId, title: 'x', phase: 'build' });
  const { token } = claimTask(db, taskId, 'worker');

  const fromCommit = commitFiles(root, [
    ...COMPOSITE_PROVENANCE_RETAINED_PATHS.map(path => [path, `export const value = "${path} v1";\n`]),
    ...COMPOSITE_PROVENANCE_OMITTED_CONTENT,
    ['extra-unpartitioned.mjs', 'unaccounted for\n'],
  ], 'original composite completion plus an unpartitioned extra file');
  completeTask(db, taskId, 'worker', token, fromCommit);
  const fixture = rewriteCompositeProvenanceHistory({
    root, base, branch, fromCommit,
  });
  const current = prepareCompositeProvenanceRebind(db, taskId);
  const rationale = 'x';
  const descriptorInput = writeCompositeProvenanceDescriptor(
    root, taskId, fixture, current.prestate, current.fingerprint, rationale,
  );
  const approvalInput = 'decisions/owner-approvals/bot-cleanroom-composite-provenance.json';
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_REBIND_COMPOSITE_PROVENANCE', phase: current.prestate.phase, itemId: taskId, rationale,
  }, [descriptorInput]);

  assert.throws(
    () => validateCompositeProvenanceRebindApproval(root, {
      taskId,
      fromCommitSha: fromCommit,
      commitSha: fixture.target,
      rationale,
      descriptorInput,
      approvalInput,
      prestate: current.prestate,
      prestateFingerprint: current.fingerprint,
    }),
    /must change exactly the seven declared paths, with no omitted extra path/,
  );
});

test('composite-provenance rebind rejects a missing or mismatched owner approval without mutation', () => {
  const {
    root, db, taskId, fixture, descriptorInput, approvalInput, rationale, current,
  } = setupCompositeProvenanceCase();
  const attemptsBefore = db.prepare('SELECT * FROM attempts ORDER BY seq').all();
  const attempt = () => validateCompositeProvenanceRebindApproval(root, {
    taskId,
    fromCommitSha: fixture.fromCommit,
    commitSha: fixture.target,
    rationale,
    descriptorInput,
    approvalInput,
    prestate: current.prestate,
    prestateFingerprint: current.fingerprint,
  });

  rmSync(join(root, approvalInput));
  assert.throws(attempt, /ENOENT/);
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);

  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_REBIND_COMPOSITE_PROVENANCE',
    phase: current.prestate.phase,
    itemId: taskId,
    rationale: 'a rationale nobody approved',
  }, [descriptorInput]);
  assert.throws(attempt, /owner approval rationale does not match/);
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsBefore);
});

test('composite-provenance rebind refuses stale reinvocation without creating another record', () => {
  const {
    root, db, taskId, fixture, descriptorInput, approvalInput, rationale, current,
  } = setupCompositeProvenanceCase();

  const descriptor = validateCompositeProvenanceRebindApproval(root, {
    taskId,
    fromCommitSha: fixture.fromCommit,
    commitSha: fixture.target,
    rationale,
    descriptorInput,
    approvalInput,
    prestate: current.prestate,
    prestateFingerprint: current.fingerprint,
  });
  rebindCompletionCompositeProvenance(db, taskId, fixture.fromCommit, fixture.target, {
    authority: descriptor.authority,
  });
  const attemptsAfterFirst = db.prepare('SELECT * FROM attempts ORDER BY seq').all();

  assert.throws(
    () => rebindCompletionCompositeProvenance(db, taskId, fixture.fromCommit, fixture.target, {
      authority: descriptor.authority,
    }),
    /current completion .* does not match requested/,
  );
  assert.deepEqual(db.prepare('SELECT * FROM attempts ORDER BY seq').all(), attemptsAfterFirst);
});
