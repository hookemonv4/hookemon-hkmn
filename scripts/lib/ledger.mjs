import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, nowIso, sha256 } from './util.mjs';
import { assertFrameworkPhase } from './phases.mjs';
import {
  assertTaskDeferralAuthority, readTaskDeferralDescriptor, validateTaskDeferralApproval,
} from './gates.mjs';

const LEDGER_ROOTS = new WeakMap();
const FULL_COMMIT = /^[0-9a-f]{40}$/;

export function openLedger(root) {
  mkdirSync(join(root, '.v4'), { recursive: true });
  const db = new DatabaseSync(join(root, '.v4', 'ledger.db'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'build',
      risk TEXT NOT NULL DEFAULT 'ordinary', deps TEXT NOT NULL DEFAULT '[]',
      reqs TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'ready',
      lease_owner TEXT, lease_token INTEGER NOT NULL DEFAULT 0, lease_expires INTEGER,
      defer_approval TEXT, defer_descriptor TEXT, defer_prestate_fingerprint TEXT
    );
    CREATE TABLE IF NOT EXISTS attempts(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, token INTEGER NOT NULL,
      owner TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, outcome TEXT, commit_sha TEXT
    );
    CREATE TABLE IF NOT EXISTS merge_queue(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      candidate_sha TEXT NOT NULL, integration_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', merged_sha TEXT
    );
  `);
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  for (const [name, type] of [
    ['defer_approval', 'TEXT'],
    ['defer_descriptor', 'TEXT'],
    ['defer_prestate_fingerprint', 'TEXT'],
  ]) {
    if (!taskColumns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }
  LEDGER_ROOTS.set(db, root);
  return db;
}

export function addTask(db, t) {
  const phase = assertFrameworkPhase(t.phase ?? 'build', 'task phase');
  db.prepare('INSERT INTO tasks(id,title,phase,risk,deps,reqs) VALUES(?,?,?,?,?,?)')
    .run(t.id, t.title, phase, t.risk ?? 'ordinary',
         JSON.stringify(t.deps ?? []), JSON.stringify(t.reqs ?? []));
}

export function listTasks(db) {
  return db.prepare('SELECT * FROM tasks ORDER BY id').all()
    .map(t => ({ ...t, deps: JSON.parse(t.deps), reqs: JSON.parse(t.reqs) }));
}

function assertAcyclicTaskGraph(tasks) {
  const dependencies = new Map(tasks.map(task => [task.id, task.deps]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of dependencies.keys()) visit(id);
}

export function setTaskDeps(db, taskId, deps) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const tasks = listTasks(db);
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`no such task ${taskId}`);
    if (task.status !== 'ready') throw new Error(`task ${taskId} is ${task.status}`);
    if (task.lease_owner !== null || task.lease_expires !== null) {
      throw new Error(`task ${taskId} is leased`);
    }
    if (!Array.isArray(deps) || deps.some(dep => typeof dep !== 'string' || !dep)) {
      throw new Error('task dependencies must be nonempty task ids');
    }
    const seen = new Set();
    for (const dependency of deps) {
      if (dependency === taskId) throw new Error(`task ${taskId} cannot depend on itself`);
      if (seen.has(dependency)) throw new Error(`duplicate dependency ${dependency}`);
      seen.add(dependency);
      if (!tasks.some(candidate => candidate.id === dependency)) {
        throw new Error(`no such dependency ${dependency}`);
      }
    }
    task.deps = [...deps];
    assertAcyclicTaskGraph(tasks);
    db.prepare('UPDATE tasks SET deps=? WHERE id=?').run(JSON.stringify(deps), taskId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function latestCompletionCommit(db, taskId) {
  return db.prepare(`
    SELECT commit_sha FROM attempts
    WHERE task_id=? AND outcome='done'
    ORDER BY seq DESC LIMIT 1
  `).get(taskId)?.commit_sha ?? null;
}

function taskDeferralPrestate(db, taskId) {
  if (taskId !== 'P1-011') throw new Error(`only P1-011 may be deferred (got ${taskId})`);
  const task = listTasks(db).find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`no such task ${taskId}`);
  if (!['ready', 'done'].includes(task.status)) throw new Error(`task ${taskId} is ${task.status}`);
  if (task.lease_owner !== null || task.lease_expires !== null) {
    throw new Error(`task ${taskId} is leased`);
  }
  const dependent = listTasks(db).find(candidate => (
    candidate.id !== taskId
      && candidate.status !== 'deferred'
      && candidate.deps.includes(taskId)
  ));
  if (dependent) throw new Error(`task ${taskId} is still required by ${dependent.id}`);
  const prestate = {
    id: task.id,
    title: task.title,
    phase: task.phase,
    risk: task.risk,
    deps: task.deps,
    reqs: task.reqs,
    status: task.status,
    leaseToken: task.lease_token,
    completionCommit: task.status === 'done' ? latestCompletionCommit(db, taskId) : null,
  };
  return { prestate, fingerprint: sha256(Buffer.from(JSON.stringify(prestate))) };
}

export function prepareTaskDeferral(db, taskId) {
  return taskDeferralPrestate(db, taskId);
}

export function deferTask(db, taskId, {
  authority,
}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = taskDeferralPrestate(db, taskId);
    const binding = assertTaskDeferralAuthority(authority, {
      taskId,
      prestateFingerprint: current.fingerprint,
    });
    db.prepare(`
      UPDATE tasks
      SET status='deferred', lease_owner=NULL, lease_expires=NULL,
          defer_approval=?, defer_descriptor=?, defer_prestate_fingerprint=?
      WHERE id=?
    `).run(binding.approvalInput, binding.descriptorInput, binding.prestateFingerprint, taskId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function nextTask(db) {
  const now = Date.now();
  const done = new Set(db.prepare("SELECT id FROM tasks WHERE status='done'").all().map(t => t.id));
  for (const t of listTasks(db)) {
    if (t.status !== 'ready') continue;
    if (t.lease_owner && t.lease_expires > now) continue;
    if (!t.deps.every(d => done.has(d))) continue;
    return t;
  }
  return null;
}

export function claimTask(db, taskId, owner, ttlSec = 3600) {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!t) throw new Error(`no such task ${taskId}`);
    if (t.status !== 'ready') throw new Error(`task ${taskId} is ${t.status}`);
    if (t.lease_owner && t.lease_expires > now) throw new Error(`task ${taskId} leased by ${t.lease_owner}`);
    for (const d of JSON.parse(t.deps)) {
      const dep = db.prepare('SELECT status FROM tasks WHERE id=?').get(d);
      if (!dep || dep.status !== 'done') throw new Error(`dependency ${d} not done`);
    }
    const token = t.lease_token + 1;
    db.prepare('UPDATE tasks SET lease_owner=?, lease_token=?, lease_expires=? WHERE id=?')
      .run(owner, token, now + ttlSec * 1000, taskId);
    db.prepare('INSERT INTO attempts(task_id,token,owner,started) VALUES(?,?,?,?)')
      .run(taskId, token, owner, nowIso());
    db.exec('COMMIT');
    return { token };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function assertFence(db, taskId, owner, token) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!t || t.lease_owner !== owner || t.lease_token !== token) {
    throw new Error(`fencing token mismatch for ${taskId}`);
  }
  return t;
}

export function heartbeatTask(db, taskId, owner, token, ttlSec = 3600) {
  db.exec('BEGIN IMMEDIATE');
  try {
    assertFence(db, taskId, owner, token);
    db.prepare('UPDATE tasks SET lease_expires=? WHERE id=?').run(Date.now() + ttlSec * 1000, taskId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function gitResult(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

export function validateCompletionCommit(root, commitSha) {
  if (typeof commitSha !== 'string' || !FULL_COMMIT.test(commitSha)) {
    throw new Error('completion commit must be a full lowercase 40-hex SHA');
  }
  const object = gitResult(root, ['cat-file', '-e', `${commitSha}^{commit}`]);
  if (object.status !== 0) throw new Error(`completion commit ${commitSha} is not an existing commit object`);
  const reachable = gitResult(root, ['merge-base', '--is-ancestor', commitSha, 'HEAD']);
  if (reachable.status !== 0) throw new Error(`completion commit ${commitSha} is not reachable from current HEAD`);
  return commitSha;
}

export function completeTask(db, taskId, owner, token, commitSha = null) {
  db.exec('BEGIN IMMEDIATE');
  try {
    assertFence(db, taskId, owner, token);
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    validateCompletionCommit(root, commitSha);
    db.prepare("UPDATE tasks SET status='done', lease_owner=NULL, lease_expires=NULL WHERE id=?").run(taskId);
    db.prepare('UPDATE attempts SET ended=?, outcome=?, commit_sha=? WHERE task_id=? AND token=?')
      .run(nowIso(), 'done', commitSha, taskId, token);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function rebindCompletionCommit(db, taskId, fromCommitSha, commitSha) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) throw new Error(`no such task ${taskId}`);
    if (task.status !== 'done') throw new Error(`task ${taskId} is ${task.status}`);
    if (task.lease_owner !== null || task.lease_expires !== null) {
      throw new Error(`task ${taskId} is leased`);
    }
    const current = latestCompletionCommit(db, taskId);
    if (current !== fromCommitSha) {
      throw new Error(`current completion ${current} does not match requested ${fromCommitSha}`);
    }
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    validateCompletionCommit(root, fromCommitSha);
    validateCompletionCommit(root, commitSha);
    const descended = gitResult(root, ['merge-base', '--is-ancestor', fromCommitSha, commitSha]);
    if (descended.status !== 0) {
      throw new Error(`completion commit ${commitSha} is not descended from ${fromCommitSha}`);
    }
    const at = nowIso();
    db.prepare(`
      INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha)
      VALUES(?,?,?,?,?,'done',?)
    `).run(taskId, task.lease_token, 'completion-rebind', at, at, commitSha);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function releaseTask(db, taskId, owner, token, outcome = 'released') {
  db.exec('BEGIN IMMEDIATE');
  try {
    assertFence(db, taskId, owner, token);
    db.prepare('UPDATE tasks SET lease_owner=NULL, lease_expires=NULL WHERE id=?').run(taskId);
    db.prepare('UPDATE attempts SET ended=?, outcome=? WHERE task_id=? AND token=?')
      .run(nowIso(), outcome, taskId, token);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function projectTasks(db, root) {
  const completion = db.prepare(`
    SELECT commit_sha FROM attempts
    WHERE task_id=? AND outcome='done'
    ORDER BY seq DESC LIMIT 1
  `);
  const tasks = listTasks(db).map(({
    lease_owner, lease_token, lease_expires,
    defer_approval, defer_descriptor, defer_prestate_fingerprint,
    ...task
  }) => {
    if (task.status === 'deferred') {
      const descriptor = readTaskDeferralDescriptor(root, defer_descriptor, task.id);
      const prestate = {
        id: task.id,
        title: task.title,
        phase: task.phase,
        risk: task.risk,
        deps: task.deps,
        reqs: task.reqs,
        status: descriptor?.prestate?.status,
        leaseToken: lease_token,
        completionCommit: descriptor?.prestate?.status === 'done'
          ? completion.get(task.id)?.commit_sha ?? null
          : null,
      };
      const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
      if (defer_prestate_fingerprint !== prestateFingerprint) {
        throw new Error(`task ${task.id} deferred prestate fingerprint does not match ledger state`);
      }
      const validated = validateTaskDeferralApproval(root, {
        taskId: task.id,
        phase: task.phase,
        rationale: descriptor?.rationale,
        descriptorInput: defer_descriptor,
        approvalInput: defer_approval,
        prestate,
        prestateFingerprint,
      });
      assertTaskDeferralAuthority(validated.authority, { taskId: task.id, prestateFingerprint });
      return {
        ...task,
        deferApproval: defer_approval,
        deferDescriptor: defer_descriptor,
        deferPrestateFingerprint: defer_prestate_fingerprint,
      };
    }
    if (task.status !== 'done') return task;
    const commitSha = completion.get(task.id)?.commit_sha ?? null;
    validateCompletionCommit(root, commitSha);
    return { ...task, commitSha };
  });
  writeJson(join(root, 'tasks.json'), { generatedAt: nowIso(), tasks });
}

export function mergeEnqueue(db, { taskId, candidateSha, integrationSha }) {
  const r = db.prepare('INSERT INTO merge_queue(task_id,candidate_sha,integration_sha) VALUES(?,?,?)')
    .run(taskId, candidateSha, integrationSha);
  return Number(r.lastInsertRowid);
}

export function mergeNext(db) {
  return db.prepare("SELECT * FROM merge_queue WHERE status='queued' ORDER BY seq LIMIT 1").get() ?? null;
}

export function mergeRecord(db, seq, { mergedSha, currentIntegrationSha }) {
  const row = db.prepare('SELECT * FROM merge_queue WHERE seq=?').get(seq);
  if (!row) throw new Error(`no queue entry ${seq}`);
  if (currentIntegrationSha !== row.integration_sha) {
    db.prepare("UPDATE merge_queue SET status='retest' WHERE seq=?").run(seq);
    return 'retest';
  }
  db.prepare("UPDATE merge_queue SET status='merged', merged_sha=? WHERE seq=?").run(mergedSha, seq);
  return 'merged';
}
