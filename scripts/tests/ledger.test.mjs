import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openLedger, addTask, listTasks, nextTask, claimTask, completeTask, projectTasks,
  heartbeatTask, releaseTask, setTaskDeps, prepareTaskDeferral, deferTask,
  prepareTaskDeferralRebind, rebindCompletionCommit, rebindTaskDeferral,
  importHistoricalTasks,
} from '../lib/ledger.mjs';
import { hashFile, sha256, writeJson } from '../lib/util.mjs';
import { addReceipt } from '../lib/receipts.mjs';
import { validateTaskDeferralApproval } from '../lib/gates.mjs';
import { writeOwnerApproval } from './helpers/owner-approval.mjs';

function commitAll(root, message) {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', message]);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

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

test('task projection rejects an unreachable commit with no real evidence receipt binding it', () => {
  const { root } = repo();
  // A real commit object that is deliberately not on any branch -- the same disconnected shape as
  // a genuine historical completion commit, but with no receipt evidence backing it, unlike a
  // legitimate importHistoricalTasks row.
  execFileSync('git', ['-C', root, 'checkout', '--quiet', '--orphan', 'unreachable']);
  const orphanCommit = commitAll(root, 'a real but disconnected commit with no evidence');
  execFileSync('git', ['-C', root, 'checkout', '--quiet', 'main']);
  execFileSync('git', ['-C', root, 'branch', '-D', 'unreachable']);

  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'project commit', phase: 'build' });
  const { token } = claimTask(db, 'T1', 'worker');
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE tasks SET status='done' WHERE id='T1'").run();
  db.prepare("UPDATE attempts SET ended=?, outcome='done', commit_sha=? WHERE task_id='T1' AND token=?")
    .run(new Date().toISOString(), orphanCommit, token);
  db.exec('COMMIT');

  assert.throws(() => projectTasks(db, root), /not reachable from current HEAD/);
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
  const task = listTasks(db).find(candidate => candidate.id === 'T1');
  assert.equal(task.status, 'done');
  assert.equal(task.lease_owner, null);
  assert.equal(task.lease_token, token);
  assert.equal(task.lease_expires, null);
  const projected = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(projected.commitSha, integrated);
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

test('rebindTaskDeferral validates the replacement authority inside its transaction', () => {
  const { root } = repo();
  const db = openLedger(root);
  addTask(db, { id: 'P1-011', title: 'dashboard' });
  deferTask(db, 'P1-011', { authority: deferralAuthority(root, db, 'P1-011') });
  const before = listTasks(db).find(task => task.id === 'P1-011');
  const rebind = prepareTaskDeferralRebind(db, 'P1-011');

  assert.throws(
    () => rebindTaskDeferral(db, 'P1-011', {
      expectedBinding: rebind.binding,
      descriptorInput: 'decisions/task-deferrals/P1-011.json',
      approvalInput: 'decisions/owner-approvals/missing-rebind.json',
    }),
    /missing-rebind|ENOENT|owner approval/,
  );
  const after = listTasks(db).find(task => task.id === 'P1-011');
  assert.deepEqual(
    {
      status: after.status,
      approval: after.defer_approval,
      descriptor: after.defer_descriptor,
      fingerprint: after.defer_prestate_fingerprint,
      token: after.lease_token,
    },
    {
      status: before.status,
      approval: before.defer_approval,
      descriptor: before.defer_descriptor,
      fingerprint: before.defer_prestate_fingerprint,
      token: before.lease_token,
    },
  );
});

function historicalSnapshotCommit(root, tasks) {
  writeJson(join(root, 'tasks.json'), { generatedAt: new Date().toISOString(), tasks });
  return commitAll(root, 'historical snapshot');
}

test('importHistoricalTasks restores a done task from its real evidence receipt', () => {
  const { root } = repo();
  const doneCommit = commitAll(root, 'implement P0-DONE');
  const receipt = addReceipt(root, {
    type: 'evidence',
    phase: 'build',
    result: 'PASSED',
    data: { taskId: 'P0-DONE', commitSha: doneCommit },
  });
  commitAll(root, 'record P0-DONE evidence receipt');
  const fromCommit = historicalSnapshotCommit(root, [
    { id: 'P0-DONE', title: 'freeze interface', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'done', commitSha: doneCommit },
  ]);

  const db = openLedger(root);
  const result = importHistoricalTasks(db, root, { fromCommit });
  assert.deepEqual(result.imported, ['P0-DONE']);
  const imported = listTasks(db).find(task => task.id === 'P0-DONE');
  assert.equal(imported.status, 'done');
  assert.equal(
    db.prepare('SELECT commit_sha, started, ended, owner FROM attempts WHERE task_id=?').get('P0-DONE').commit_sha,
    doneCommit,
  );
  assert.equal(
    db.prepare('SELECT started FROM attempts WHERE task_id=?').get('P0-DONE').started,
    receipt.at,
  );
});

test('importHistoricalTasks refuses a done task with no matching evidence receipt', () => {
  const { root } = repo();
  const doneCommit = commitAll(root, 'implement P0-UNPROVEN');
  const fromCommit = historicalSnapshotCommit(root, [
    { id: 'P0-UNPROVEN', title: 'freeze interface', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'done', commitSha: doneCommit },
  ]);

  const db = openLedger(root);
  assert.throws(
    () => importHistoricalTasks(db, root, { fromCommit }),
    /no PASSED evidence receipt binds historical task P0-UNPROVEN/,
  );
  assert.deepEqual(listTasks(db), []);
});

test('importHistoricalTasks refuses to overwrite an existing live task', () => {
  const { root } = repo();
  const doneCommit = commitAll(root, 'implement LAUNCH-A');
  addReceipt(root, { type: 'evidence', phase: 'build', result: 'PASSED', data: { taskId: 'LAUNCH-A', commitSha: doneCommit } });
  commitAll(root, 'record LAUNCH-A evidence receipt');
  const fromCommit = historicalSnapshotCommit(root, [
    { id: 'LAUNCH-A', title: 'live task', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'done', commitSha: doneCommit },
  ]);

  const db = openLedger(root);
  addTask(db, { id: 'LAUNCH-A', title: 'live claimable work' });
  assert.throws(
    () => importHistoricalTasks(db, root, { fromCommit }),
    /LAUNCH-A already exists in this ledger; historical import refuses to overwrite/,
  );
  const live = listTasks(db).find(task => task.id === 'LAUNCH-A');
  assert.equal(live.status, 'ready');
});

test('importHistoricalTasks restores a deferred task from its real descriptor and owner approval', () => {
  const { root } = repo();
  const prestate = {
    id: 'P0-DEFER', title: 'dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: [],
    status: 'ready', leaseToken: 0, completionCommit: null,
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  const descriptorInput = 'decisions/task-deferrals/P0-DEFER.json';
  const rationale = 'Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope';
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-deferral-v1', action: 'TASK_DEFER', taskId: 'P0-DEFER', phase: 'build',
    targetStatus: 'deferred', rationale, prestate, prestateFingerprint,
  });
  const approvalInput = 'decisions/owner-approvals/p0-defer.json';
  writeJson(join(root, 'policy/policy.json'), {});
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P0-DEFER', rationale,
  }, ['policy/policy.json', descriptorInput]);
  commitAll(root, 'sign P0-DEFER deferral');

  const fromCommit = historicalSnapshotCommit(root, [
    { id: 'P0-DEFER', title: 'dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'deferred' },
  ]);

  const db = openLedger(root);
  const result = importHistoricalTasks(db, root, { fromCommit });
  assert.deepEqual(result.imported, ['P0-DEFER']);
  const imported = listTasks(db).find(task => task.id === 'P0-DEFER');
  assert.equal(imported.status, 'deferred');
  assert.equal(imported.defer_approval, approvalInput);
  assert.equal(imported.defer_descriptor, descriptorInput);
  assert.equal(imported.defer_prestate_fingerprint, prestateFingerprint);
});

test('importHistoricalTasks reconstructs a prior completion before a retiring deferral', () => {
  const { root } = repo();
  const priorCompletionCommit = commitAll(root, 'implement P0-RETIRED before it was retired');
  const prestate = {
    id: 'P0-RETIRED', title: 'render loop dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: [],
    status: 'done', leaseToken: 1, completionCommit: priorCompletionCommit,
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  const descriptorInput = 'decisions/task-deferrals/P0-RETIRED.json';
  const rationale = 'Retired to Phase 2 after the manual one-cycle scope closed it out';
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-deferral-v1', action: 'TASK_DEFER', taskId: 'P0-RETIRED', phase: 'build',
    targetStatus: 'deferred', rationale, prestate, prestateFingerprint,
  });
  const approvalInput = 'decisions/owner-approvals/p0-retired-defer.json';
  writeJson(join(root, 'policy/policy.json'), {});
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P0-RETIRED', rationale,
  }, ['policy/policy.json', descriptorInput]);
  commitAll(root, 'sign P0-RETIRED deferral');

  const fromCommit = historicalSnapshotCommit(root, [
    { id: 'P0-RETIRED', title: 'render loop dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'deferred' },
  ]);

  const db = openLedger(root);
  const result = importHistoricalTasks(db, root, { fromCommit });
  assert.deepEqual(result.imported, ['P0-RETIRED']);
  const imported = listTasks(db).find(task => task.id === 'P0-RETIRED');
  assert.equal(imported.status, 'deferred');
  assert.equal(imported.lease_token, 1);
  assert.equal(
    db.prepare("SELECT commit_sha FROM attempts WHERE task_id='P0-RETIRED' AND outcome='done'").get().commit_sha,
    priorCompletionCommit,
  );
});

test('importHistoricalTasks refuses a deferred task whose approval token is not formal', () => {
  const { root } = repo();
  const prestate = {
    id: 'P0-UNSIGNED', title: 'dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: [],
    status: 'ready', leaseToken: 0, completionCommit: null,
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  const descriptorInput = 'decisions/task-deferrals/P0-UNSIGNED.json';
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-deferral-v1', action: 'TASK_DEFER', taskId: 'P0-UNSIGNED', phase: 'build',
    targetStatus: 'deferred', rationale: 'draft', prestate, prestateFingerprint,
  });
  writeJson(join(root, 'policy/policy.json'), {});
  writeOwnerApproval(root, 'decisions/owner-approvals/p0-unsigned-defer.json', {
    action: 'TASK_DEFER', phase: 'build', itemId: 'P0-UNSIGNED', rationale: 'draft',
    approvalToken: 'DRAFT_UNSIGNED_NOT_YET_APPROVED',
  }, ['policy/policy.json', descriptorInput]);
  commitAll(root, 'draft P0-UNSIGNED deferral, never signed');
  const fromCommit = historicalSnapshotCommit(root, [
    { id: 'P0-UNSIGNED', title: 'dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'deferred' },
  ]);

  assert.throws(
    () => importHistoricalTasks(openLedger(root), root, { fromCommit }),
    /no verifiable owner-approved deferral authority found for historical task P0-UNSIGNED/,
  );
});
