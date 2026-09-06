import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, nowIso, sha256 } from './util.mjs';
import { assertFrameworkPhase } from './phases.mjs';
import {
  assertTaskDeferralAuthority, readTaskDeferralDescriptor, validateTaskDeferralApproval,
} from './gates.mjs';
import { listReceipts } from './receipts.mjs';

const OWNER_APPROVAL_TOKENS_FOR_IMPORT = new Set(['OWNER APPROVED', 'OWNER AUTHORIZED']);

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

function deferredTaskRebindPrestate(db, taskId) {
  if (taskId !== 'P1-011') throw new Error(`only P1-011 may be rebound (got ${taskId})`);
  const task = listTasks(db).find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`no such task ${taskId}`);
  if (task.status !== 'deferred') throw new Error(`task ${taskId} is ${task.status}`);
  if (task.lease_owner !== null || task.lease_expires !== null) {
    throw new Error(`task ${taskId} is leased`);
  }
  if (typeof task.defer_approval !== 'string' || typeof task.defer_descriptor !== 'string'
      || typeof task.defer_prestate_fingerprint !== 'string') {
    throw new Error(`task ${taskId} has no complete deferred authority binding`);
  }
  const root = LEDGER_ROOTS.get(db);
  if (!root) throw new Error('ledger has no repository root');
  const descriptor = readTaskDeferralDescriptor(root, task.defer_descriptor, taskId);
  if (!['ready', 'done'].includes(descriptor?.prestate?.status)) {
    throw new Error(`task ${taskId} deferred descriptor has no valid original status`);
  }
  const prestate = {
    id: task.id,
    title: task.title,
    phase: task.phase,
    risk: task.risk,
    deps: task.deps,
    reqs: task.reqs,
    status: descriptor.prestate.status,
    leaseToken: task.lease_token,
    completionCommit: descriptor.prestate.status === 'done'
      ? latestCompletionCommit(db, taskId)
      : null,
  };
  const fingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  if (task.defer_prestate_fingerprint !== fingerprint) {
    throw new Error(`task ${taskId} deferred prestate fingerprint does not match ledger state`);
  }
  if (prestate.status === 'done' && typeof prestate.completionCommit !== 'string') {
    throw new Error(`task ${taskId} deferred completion has no recorded commit`);
  }
  return {
    task,
    prestate,
    fingerprint,
    binding: {
      approvalInput: task.defer_approval,
      descriptorInput: task.defer_descriptor,
      prestateFingerprint: task.defer_prestate_fingerprint,
    },
  };
}

export function prepareTaskDeferralRebind(db, taskId) {
  const current = deferredTaskRebindPrestate(db, taskId);
  return {
    prestate: current.prestate,
    prestateFingerprint: current.fingerprint,
    binding: current.binding,
  };
}

export function rebindTaskDeferral(db, taskId, {
  expectedBinding,
  descriptorInput,
  approvalInput,
}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = deferredTaskRebindPrestate(db, taskId);
    if (!expectedBinding || current.binding.approvalInput !== expectedBinding.approvalInput
        || current.binding.descriptorInput !== expectedBinding.descriptorInput
        || current.binding.prestateFingerprint !== expectedBinding.prestateFingerprint) {
      throw new Error(`task ${taskId} deferred authority changed before rebind`);
    }
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    const descriptor = readTaskDeferralDescriptor(root, descriptorInput, taskId);
    const validated = validateTaskDeferralApproval(root, {
      taskId,
      phase: current.task.phase,
      rationale: descriptor.rationale,
      descriptorInput,
      approvalInput,
      prestate: current.prestate,
      prestateFingerprint: current.fingerprint,
    });
    const binding = assertTaskDeferralAuthority(validated.authority, {
      taskId,
      prestateFingerprint: current.fingerprint,
    });
    db.prepare(`
      UPDATE tasks
      SET defer_approval=?, defer_descriptor=?, defer_prestate_fingerprint=?
      WHERE id=?
    `).run(binding.approvalInput, binding.descriptorInput, binding.prestateFingerprint, taskId);
    db.exec('COMMIT');
    return {
      approvalInput: binding.approvalInput,
      descriptorInput: binding.descriptorInput,
      prestateFingerprint: binding.prestateFingerprint,
    };
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

function historicalTaskSnapshot(root, fromCommit) {
  if (typeof fromCommit !== 'string' || !FULL_COMMIT.test(fromCommit)) {
    throw new Error('historical import commit must be a full lowercase 40-hex SHA');
  }
  const commitCheck = gitResult(root, ['cat-file', '-e', `${fromCommit}^{commit}`]);
  if (commitCheck.status !== 0) throw new Error(`historical import commit ${fromCommit} is not an existing commit object`);
  const reachable = gitResult(root, ['merge-base', '--is-ancestor', fromCommit, 'HEAD']);
  if (reachable.status !== 0) throw new Error(`historical import commit ${fromCommit} is not reachable from current HEAD`);
  const show = gitResult(root, ['show', `${fromCommit}:tasks.json`]);
  if (show.status !== 0) throw new Error(`historical import commit ${fromCommit} has no tasks.json`);
  let snapshot;
  try {
    snapshot = JSON.parse(show.stdout);
  } catch {
    throw new Error(`historical import commit ${fromCommit} has an invalid tasks.json`);
  }
  if (!Array.isArray(snapshot?.tasks)) throw new Error(`historical import commit ${fromCommit} tasks.json has no tasks array`);
  return snapshot.tasks;
}

/**
 * A historical completion commit predates and is deliberately disconnected from the current
 * branch's own clean ancestry (the canonical import intentionally excludes the private legacy
 * history that predates it), so unlike a live completeTask() the commit cannot be required to be
 * an ancestor of HEAD. It still must be a real commit object actually present in this repository,
 * not merely a string -- that is what distinguishes restoring real history from inventing it.
 */
function assertHistoricalCommitExists(root, commitSha) {
  const object = gitResult(root, ['cat-file', '-e', `${commitSha}^{commit}`]);
  if (object.status !== 0) throw new Error(`historical completion commit ${commitSha} is not an existing commit object`);
}

/**
 * A completion commit is normally required to be an ancestor of HEAD (validateCompletionCommit) --
 * the correct anti-tamper check for a task actually completed on this branch's own history. A
 * historically imported task's commit predates and is deliberately disconnected from the current
 * clean canonical ancestry (see importHistoricalTasks), so it can never satisfy that check, not
 * even after regenerating the projection. Accept it here only as a fallback, and only when a real
 * PASSED evidence receipt binds this exact task id to this exact commit -- the same standard
 * importHistoricalTasks itself required before writing the row, re-verified on every projection
 * rather than trusted from the initial import alone.
 */
function validateCompletionCommitForProjection(root, taskId, commitSha) {
  try {
    validateCompletionCommit(root, commitSha);
    return;
  } catch (error) {
    if (earliestPassedEvidenceReceipt(root, taskId, commitSha)) return;
    throw error;
  }
}

function earliestPassedEvidenceReceipt(root, taskId, commitSha) {
  const matches = listReceipts(root).filter(receipt => (
    receipt.type === 'evidence'
    && receipt.result === 'PASSED'
    && receipt.data?.taskId === taskId
    && receipt.data?.commitSha === commitSha
  ));
  if (matches.length === 0) return null;
  return matches.reduce((earliest, candidate) => (candidate.at < earliest.at ? candidate : earliest));
}

function historicalDeferralAuthority(root, taskId) {
  const descriptorPath = `decisions/task-deferrals/${taskId}.json`;
  let descriptor;
  try {
    descriptor = JSON.parse(readFileSync(join(root, descriptorPath), 'utf8'));
  } catch {
    return null;
  }
  if (descriptor?.schema !== 'v4-task-deferral-v1' || descriptor.taskId !== taskId
      || descriptor.action !== 'TASK_DEFER' || descriptor.targetStatus !== 'deferred'
      || !descriptor.prestate || typeof descriptor.prestateFingerprint !== 'string') {
    return null;
  }
  const descriptorFingerprint = sha256(Buffer.from(JSON.stringify(descriptor.prestate)));
  if (descriptor.prestateFingerprint !== descriptorFingerprint) return null;
  const descriptorBytes = readFileSync(join(root, descriptorPath));
  const descriptorSha256 = sha256(descriptorBytes);

  const approvalsDirectory = join(root, 'decisions', 'owner-approvals');
  let approvalNames;
  try {
    approvalNames = spawnSync('ls', [approvalsDirectory], { encoding: 'utf8' }).stdout
      .split('\n').map(name => name.trim()).filter(name => name.endsWith('.json'));
  } catch {
    approvalNames = [];
  }
  for (const name of approvalNames) {
    const approvalPath = `decisions/owner-approvals/${name}`;
    let approval;
    try {
      approval = JSON.parse(readFileSync(join(root, approvalPath), 'utf8'));
    } catch {
      continue;
    }
    if (approval?.action !== 'TASK_DEFER' || approval.itemId !== taskId) continue;
    if (!OWNER_APPROVAL_TOKENS_FOR_IMPORT.has(String(approval.approvalToken ?? '').trim())) continue;
    if (approval.subjectHashes?.[descriptorPath] !== descriptorSha256) continue;
    const log = gitResult(root, ['log', '-1', '--format=%aI', '--', approvalPath]);
    const at = log.status === 0 && log.stdout.trim() ? new Date(log.stdout.trim()).toISOString() : null;
    if (!at) continue;
    return {
      descriptorPath, approvalPath, prestateFingerprint: descriptor.prestateFingerprint,
      prestate: descriptor.prestate, at,
    };
  }
  return null;
}

/**
 * Restores historical task records that predate this worktree's ledger without inventing any
 * evidence: every "done" import requires a real PASSED evidence receipt binding that exact task
 * id to that exact completion commit, and every "deferred" import requires a real committed
 * deferral descriptor whose own prestate fingerprint is internally consistent plus a real owner
 * approval file (an explicit OWNER APPROVED/AUTHORIZED token) whose subjectHashes bind that
 * descriptor's current bytes. Refuses entirely (no partial import) if any task in the historical
 * snapshot already exists in this ledger, or if required evidence for any task is missing or
 * internally inconsistent. Never touches an existing task row.
 */
export function importHistoricalTasks(db, root, { fromCommit, only = null } = {}) {
  if (only !== null && (!Array.isArray(only) || only.some(id => typeof id !== 'string' || !id))) {
    throw new Error('historical import "only" filter must be an array of nonempty task ids');
  }
  const onlyIds = only === null ? null : new Set(only);
  const snapshot = historicalTaskSnapshot(root, fromCommit)
    .filter(task => onlyIds === null || onlyIds.has(task?.id));
  if (onlyIds !== null) {
    const found = new Set(snapshot.map(task => task.id));
    for (const id of onlyIds) {
      if (!found.has(id)) throw new Error(`historical import "only" filter named ${id}, which is not in the snapshot`);
    }
  }
  const existingIds = new Set(listTasks(db).map(task => task.id));
  const plan = [];
  for (const task of snapshot) {
    if (!task || typeof task.id !== 'string' || !task.id) throw new Error('historical snapshot has an invalid task id');
    if (existingIds.has(task.id)) {
      throw new Error(`task ${task.id} already exists in this ledger; historical import refuses to overwrite a live task`);
    }
    if (task.status === 'done') {
      if (typeof task.commitSha !== 'string' || !FULL_COMMIT.test(task.commitSha)) {
        throw new Error(`historical task ${task.id} has no valid completion commit to verify`);
      }
      assertHistoricalCommitExists(root, task.commitSha);
      const receipt = earliestPassedEvidenceReceipt(root, task.id, task.commitSha);
      if (!receipt) {
        throw new Error(`no PASSED evidence receipt binds historical task ${task.id} to commit ${task.commitSha}; refusing import`);
      }
      plan.push({ task, kind: 'done', at: receipt.at, receiptId: receipt.id });
    } else if (task.status === 'deferred') {
      const authority = historicalDeferralAuthority(root, task.id);
      if (!authority) {
        throw new Error(`no verifiable owner-approved deferral authority found for historical task ${task.id}; refusing import`);
      }
      for (const field of ['id', 'title', 'phase', 'risk', 'deps', 'reqs']) {
        if (JSON.stringify(authority.prestate[field]) !== JSON.stringify(task[field] ?? (field === 'deps' || field === 'reqs' ? [] : undefined))) {
          throw new Error(`historical task ${task.id} does not match its deferral descriptor's ${field}; refusing import`);
        }
      }
      // The descriptor's own prestate may record that this task was actually completed before
      // being deferred (e.g. retired, unmerged work). The owner-approved, hash-bound descriptor is
      // itself the evidence for that prior state -- verified above via the prestate fingerprint and
      // the approval's subjectHashes -- so no separate completion receipt is required here.
      if (authority.prestate.status === 'done') {
        if (typeof authority.prestate.completionCommit !== 'string' || !FULL_COMMIT.test(authority.prestate.completionCommit)) {
          throw new Error(`historical task ${task.id}'s deferral descriptor claims a prior completion with no valid commit; refusing import`);
        }
        assertHistoricalCommitExists(root, authority.prestate.completionCommit);
      } else if (authority.prestate.status !== 'ready') {
        throw new Error(`historical task ${task.id}'s deferral descriptor has an unsupported prior status ${String(authority.prestate.status)}; refusing import`);
      }
      plan.push({ task, kind: 'deferred', authority, at: authority.at });
    } else {
      throw new Error(`historical task ${task.id} has unsupported status ${String(task.status)}; refusing import`);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of plan) {
      const { task } = entry;
      const phase = assertFrameworkPhase(task.phase ?? 'build', 'task phase');
      db.prepare('INSERT INTO tasks(id,title,phase,risk,deps,reqs,status) VALUES(?,?,?,?,?,?,?)')
        .run(task.id, task.title, phase, task.risk ?? 'ordinary',
             JSON.stringify(task.deps ?? []), JSON.stringify(task.reqs ?? []),
             entry.kind === 'done' ? 'done' : 'deferred');
      if (entry.kind === 'done') {
        db.prepare(`
          INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha)
          VALUES(?,1,'historical-import',?,?,'done',?)
        `).run(task.id, entry.at, entry.at, task.commitSha);
      } else {
        if (entry.authority.prestate.status === 'done') {
          db.prepare(`
            INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha)
            VALUES(?,?,'historical-import',?,?,'done',?)
          `).run(task.id, entry.authority.prestate.leaseToken || 1, entry.at, entry.at, entry.authority.prestate.completionCommit);
        }
        db.prepare(`
          UPDATE tasks SET lease_token=?, defer_approval=?, defer_descriptor=?, defer_prestate_fingerprint=? WHERE id=?
        `).run(
          entry.authority.prestate.leaseToken || 0,
          entry.authority.approvalPath, entry.authority.descriptorPath, entry.authority.prestateFingerprint,
          task.id,
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { imported: plan.map(entry => entry.task.id) };
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
    validateCompletionCommitForProjection(root, task.id, commitSha);
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
