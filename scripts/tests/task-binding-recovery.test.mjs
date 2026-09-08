import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addTask, claimTask, completeTask, openLedger, projectTasks, recoverTaskRequirements, releaseTask, acceptOperationalTask } from '../lib/ledger.mjs';
import { prepareTaskBindingRecovery, prepareOperationalAcceptance } from '../lib/task-binding-recovery.mjs';
import { hashFile, readJson, writeJson } from '../lib/util.mjs';
import { taskEvidenceContext, traceCheck } from '../lib/reqs.mjs';
import { addReceipt } from '../lib/receipts.mjs';
import { writeOwnerApproval } from './helpers/owner-approval.mjs';
import { checkGate } from '../lib/gates.mjs';

const cli = resolve(import.meta.dirname, '../v4.mjs');
function fixture(t, done = true) {
  const root = mkdtempSync(join(tmpdir(), 'task-bindings-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Hookemon');
  git('config', 'user.email', '312745360+hookemonv4@users.noreply.github.com');
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  writeJson(join(root, 'specs/requirements.json'), {
    revision: 1, requirements: [
      { id: 'REQ-a', status: 'approved' }, { id: 'REQ-unrelated', status: 'approved' },
      { id: 'REQ-old', status: 'superseded' },
    ],
  });
  writeFileSync(join(root, 'evidence.txt'), 'Bounded contribution evidence');
  const db = openLedger(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  addTask(db, { id: 'T1', title: 'Repair existing contribution' });
  if (done) {
    const { token } = claimTask(db, 'T1', 'worker');
    completeTask(db, 'T1', 'worker', token, head);
  }
  const options = { record: 'decisions/task-bindings/T1.json', approval: 'decisions/owner-approvals/t1-bindings.json' };
  const current = prepareTaskBindingRecovery(db, 'T1');
  const descriptor = {
    schema: 'v4-task-binding-recovery-v1', action: 'TASK_BIND_REQUIREMENTS', taskId: 'T1',
    prestate: current.prestate, prestateFingerprint: current.fingerprint,
    requirements: { revision: 1, sha256: hashFile(join(root, 'specs/requirements.json')) },
    rationale: 'Recover the reviewed implementation contribution',
    bindings: [{ requirementId: 'REQ-a', contribution: 'supporting', rationale: 'Supporting check, not full requirement acceptance', evidence: { 'evidence.txt': hashFile(join(root, 'evidence.txt')) } }],
  };
  const save = () => writeJson(join(root, options.record), descriptor);
  const approve = () => writeOwnerApproval(root, options.approval, {
    action: descriptor.action, phase: 'build', itemId: 'T1', rationale: descriptor.rationale,
  }, [options.record]);
  save(); approve();
  return { root, db, head, git, descriptor, options, save, approve };
}
function snapshot(db) {
  return ['tasks', 'attempts', 'task_binding_recoveries', 'task_operational_acceptances'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
}
function refuses(f, pattern) {
  const before = snapshot(f.db);
  assert.throws(() => recoverTaskRequirements(f.db, 'T1', f.options), pattern);
  assert.deepEqual(snapshot(f.db), before);
}

test('recovery preserves completion attempts and qualified history, invalidates old evidence, and refuses replay', t => {
  const f = fixture(t);
  projectTasks(f.db, f.root);
  const context = taskEvidenceContext(f.root, 'T1');
  addReceipt(f.root, { type: 'evidence', phase: 'build', result: 'PASSED', data: context.data, inputs: [...context.inputs, 'evidence.txt'] });
  const before = snapshot(f.db);
  recoverTaskRequirements(f.db, 'T1', f.options);
  const after = snapshot(f.db);
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual({ ...after[0][0], reqs: '[]' }, { ...before[0][0] });
  const provenance = JSON.parse(after[2][0].provenance);
  assert.equal(provenance.descriptor.bindings[0].contribution, 'supporting');
  assert.equal(provenance.recordHash, hashFile(join(f.root, f.options.record)));
  assert.equal(provenance.approvalHash, hashFile(join(f.root, f.options.approval)));
  projectTasks(f.db, f.root);
  assert.equal(readJson(join(f.root, 'tasks.json')).tasks[0].commitSha, f.head);
  assert.deepEqual(traceCheck(f.root).gaps, ['T1: done without valid evidence receipt']);
  refuses(f, /stale/);
});

test('ready unleased task recovers without acquiring or changing a fence', t => {
  const f = fixture(t, false);
  recoverTaskRequirements(f.db, 'T1', f.options);
  const task = f.db.prepare('SELECT * FROM tasks WHERE id=?').get('T1');
  assert.equal(task.status, 'ready'); assert.equal(task.lease_token, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0);
});

for (const [label, mutate, expected] of [
  ['unknown requirement', d => { d.bindings[0].requirementId = 'REQ-missing'; }, /known approved/],
  ['superseded requirement', d => { d.bindings[0].requirementId = 'REQ-old'; }, /known approved/],
  ['duplicate requirement', d => { d.bindings.push(structuredClone(d.bindings[0])); }, /duplicate/],
  ['empty bindings', d => { d.bindings = []; }, /nonempty/],
  ['unqualified coverage', d => { d.bindings[0].contribution = 'complete'; }, /qualified/],
  ['stale prestate', d => { d.prestate.leaseToken++; }, /stale/],
  ['stale specification', d => { d.requirements.revision++; }, /stale/],
  ['evidence traversal', d => { d.bindings[0].evidence = { '../outside': 'a'.repeat(64) }; }, /repo-relative/],
]) {
  test(`rejects ${label} without mutation`, t => {
    const f = fixture(t); mutate(f.descriptor); f.save(); f.approve(); refuses(f, expected);
  });
}

test('known unrelated requirement cannot replace the exact approved contribution', t => {
  const f = fixture(t);
  f.descriptor.bindings[0].requirementId = 'REQ-unrelated'; f.save();
  refuses(f, /hash/);
});
test('changed evidence and missing or forged approval refuse without mutation', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'evidence.txt'), 'Changed evidence'); refuses(f, /evidence hash/);
  f.descriptor.bindings[0].evidence['evidence.txt'] = hashFile(join(f.root, 'evidence.txt')); f.save(); f.approve();
  const approval = readJson(join(f.root, f.options.approval)); approval.authority = 'SYSTEM';
  writeJson(join(f.root, f.options.approval), approval); refuses(f, /authority/);
  rmSync(join(f.root, f.options.approval)); refuses(f, /ENOENT/);
});
test('active and expired foreign leases refuse, and released superseded token makes descriptor stale', t => {
  const f = fixture(t, false);
  const { token } = claimTask(f.db, 'T1', 'foreign', -1); refuses(f, /leased/);
  const next = claimTask(f.db, 'T1', 'successor'); refuses(f, /leased/);
  assert.ok(next.token > token);
  releaseTask(f.db, 'T1', 'successor', next.token); refuses(f, /stale/);
});
test('unknown tasks and orphan completions remain refused', t => {
  const f = fixture(t);
  assert.throws(() => prepareTaskBindingRecovery(f.db, 'missing'), /no such task/);
  f.git('checkout', '--quiet', '--orphan', 'replacement'); f.git('commit', '--quiet', '--allow-empty', '-m', 'replacement');
  refuses(f, /ancestor|reachable/);
});
test('CLI applies approved bindings and refuses another orphan before canonical mutation', t => {
  const f = fixture(t);
  const run = () => spawnSync(process.execPath, [cli, 'task', 'recover-bindings', 'T1', '--record', f.options.record, '--approval', f.options.approval], { cwd: f.root, encoding: 'utf8' });
  addTask(f.db, { id: 'ORPHAN', title: 'Other historical completion' });
  const lease = claimTask(f.db, 'ORPHAN', 'worker');
  f.git('checkout', '--quiet', '-b', 'side'); f.git('commit', '--quiet', '--allow-empty', '-m', 'side');
  completeTask(f.db, 'ORPHAN', 'worker', lease.token, f.git('rev-parse', 'HEAD'));
  f.git('checkout', '--quiet', '--detach', f.head);
  const before = snapshot(f.db); const failed = run();
  assert.equal(failed.status, 1); assert.deepEqual(snapshot(f.db), before);
  f.git('checkout', '--quiet', 'side');
  const passed = run(); assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout).reqs, ['REQ-a']);
  assert.equal(readJson(join(f.root, 'tasks.json')).tasks.find(task => task.id === 'T1').commitSha, f.head);
});

function operation(t) {
  const f = fixture(t);
  writeJson(join(f.root, 'policy/policy.json'), { autonomy: { never: ['Approve your own work on behalf of the owner'] } });
  const current = prepareOperationalAcceptance(f.db, 'T1');
  f.options = { record: 'decisions/task-operations/T1.json', approval: 'decisions/owner-approvals/t1-operation.json' };
  f.descriptor = {
    schema: 'v4-task-operational-acceptance-v1', action: 'TASK_ACCEPT_OPERATIONAL', taskId: 'T1',
    prestate: current.prestate, prestateFingerprint: current.fingerprint,
    processSources: { 'policy/policy.json': hashFile(join(f.root, 'policy/policy.json')) },
    rationale: 'Accept the completed maintenance work under the governing process, without product coverage',
  };
  f.save = () => writeJson(join(f.root, f.options.record), f.descriptor);
  f.approve = () => writeOwnerApproval(f.root, f.options.approval, {
    action: f.descriptor.action, phase: 'build', itemId: 'T1', rationale: f.descriptor.rationale,
  }, [f.options.record]);
  f.save(); f.approve(); return f;
}
function refusesOperation(f, pattern) {
  const before = snapshot(f.db);
  assert.throws(() => acceptOperationalTask(f.db, 'T1', f.options), pattern);
  assert.deepEqual(snapshot(f.db), before);
}
function operationEvidence(f, includeAuthority = true) {
  const context = taskEvidenceContext(f.root, 'T1');
  addReceipt(f.root, { type: 'evidence', phase: 'build', result: 'PASSED', data: context.data,
    inputs: [...(includeAuthority ? context.inputs : ['specs/requirements.json']), 'evidence.txt'] });
}

test('operational acceptance preserves history, still needs evidence, and contributes no product coverage', t => {
  const f = operation(t); const before = snapshot(f.db);
  acceptOperationalTask(f.db, 'T1', f.options); projectTasks(f.db, f.root);
  const after = snapshot(f.db);
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3));
  assert.equal(after[3].length, 1);
  assert.deepEqual(traceCheck(f.root).gaps, ['T1: done without valid evidence receipt']);
  operationEvidence(f, false);
  assert.deepEqual(traceCheck(f.root).gaps, ['T1: done without valid evidence receipt']);
  operationEvidence(f);
  assert.deepEqual(traceCheck(f.root).gaps, []);
  writeJson(join(f.root, 'gates/tasks.json'), { id: 'tasks', version: 1, items: [] });
  checkGate(f.root, 'tasks');
  assert.deepEqual(traceCheck(f.root).gaps, ['REQ-a: no task covers this requirement', 'REQ-unrelated: no task covers this requirement', 'REQ-old: no task covers this requirement']);
  refusesOperation(f, /already recorded/);
  assert.throws(() => recoverTaskRequirements(f.db, 'T1', {}), /cannot acquire product/);
});

test('operational projection fails closed on forged classification, task changes and missing approval', t => {
  const f = operation(t); acceptOperationalTask(f.db, 'T1', f.options); projectTasks(f.db, f.root);
  const original = readJson(join(f.root, 'tasks.json'));
  for (const mutate of [
    task => { task.operationalAcceptance = {}; },
    task => { task.reqs = ['REQ-a']; },
    task => { task.status = 'ready'; },
    task => { task.title = 'Different work'; },
    task => { task.commitSha = 'a'.repeat(40); },
  ]) {
    const changed = structuredClone(original); mutate(changed.tasks[0]); writeJson(join(f.root, 'tasks.json'), changed);
    assert.match(traceCheck(f.root).gaps.join('\n'), /operational acceptance invalid/);
  }
  writeJson(join(f.root, 'tasks.json'), original);
  rmSync(join(f.root, f.options.approval));
  assert.match(traceCheck(f.root).gaps.join('\n'), /operational acceptance invalid/);
});

test('process changes require fresh exact acceptance and invalidate prior evidence without erasing history', t => {
  const f = operation(t); acceptOperationalTask(f.db, 'T1', f.options); projectTasks(f.db, f.root); operationEvidence(f);
  writeJson(join(f.root, 'policy/policy.json'), { reviewed: 'New governing policy' });
  assert.match(traceCheck(f.root).gaps.join('\n'), /process source is stale/);
  assert.throws(() => projectTasks(f.db, f.root), /process source is stale/);
  refusesOperation(f, /process source is stale/);
  f.descriptor.processSources['policy/policy.json'] = hashFile(join(f.root, 'policy/policy.json')); f.save();
  refusesOperation(f, /hash/);
  f.approve(); acceptOperationalTask(f.db, 'T1', f.options); projectTasks(f.db, f.root);
  assert.equal(snapshot(f.db)[3].length, 2);
  assert.deepEqual(traceCheck(f.root).gaps, ['T1: done without valid evidence receipt']);
  operationEvidence(f); assert.deepEqual(traceCheck(f.root).gaps, []);
});

test('operation requires completed unbound work, exact governing sources and current completion', t => {
  const ready = fixture(t, false); assert.throws(() => prepareOperationalAcceptance(ready.db, 'T1'), /completed task/);
  const bound = fixture(t); recoverTaskRequirements(bound.db, 'T1', bound.options);
  assert.throws(() => prepareOperationalAcceptance(bound.db, 'T1'), /no product requirements/);
  const f = operation(t); f.descriptor.processSources = {}; f.save(); f.approve(); refusesOperation(f, /governing policy/);
  f.descriptor.processSources = { 'policy/policy.json': hashFile(join(f.root, 'policy/policy.json')) };
  f.descriptor.prestate.completion.seq++; f.save(); f.approve(); refusesOperation(f, /prestate/);
});

test('operational CLI preserves orphan refusal and emits revalidated disposition', t => {
  const f = operation(t);
  const run = () => spawnSync(process.execPath, [cli, 'task', 'accept-operation', 'T1', '--record', f.options.record, '--approval', f.options.approval], { cwd: f.root, encoding: 'utf8' });
  f.git('checkout', '--quiet', '--orphan', 'replacement'); f.git('commit', '--quiet', '--allow-empty', '-m', 'replacement');
  const before = snapshot(f.db); assert.equal(run().status, 1); assert.deepEqual(snapshot(f.db), before);
  f.git('checkout', '--quiet', '--detach', f.head);
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).operationalAcceptance.recordHash);
  assert.equal(readJson(join(f.root, 'tasks.json')).tasks[0].operationalAcceptance.record, f.options.record);
});
