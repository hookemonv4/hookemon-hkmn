import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  writeJson, nowIso, sha256, readJson,
} from './util.mjs';
import { assertFrameworkPhase } from './phases.mjs';
import {
  assertTaskDeferralAuthority, readOwnerApproval, readTaskDeferralDescriptor,
  validateTaskDeferralApproval,
} from './gates.mjs';
import { resolveReceiptInput } from './receipts.mjs';
import { validateTaskBindingRecovery, validateOperationalAcceptance } from './task-binding-recovery.mjs';
import { validateHistoricalUsdgArchive } from './historical-usdg-archive.mjs';

const LEDGER_ROOTS = new WeakMap();
const FULL_COMMIT = /^[0-9a-f]{40}$/;

// BOT-CLEANROOM's completion history was orphaned by a history rewrite: the strict descendant
// and stable-patch-id routes below cannot express "five files are an exact retained patch, two
// omitted files already entered through an independently merged domain foundation". This is a
// separate, owner-authenticated, single-task exception — never a third generic route.
const COMPOSITE_PROVENANCE_SCHEMA = 'v4-task-rebind-composite-provenance-v1';
const COMPOSITE_PROVENANCE_ACTION = 'TASK_REBIND_COMPOSITE_PROVENANCE';
const COMPOSITE_PROVENANCE_TASK_ID = 'BOT-CLEANROOM';
const COMPOSITE_PROVENANCE_RETAINED_FILE_COUNT = 5;
const COMPOSITE_PROVENANCE_OMITTED_FILE_COUNT = 2;
const COMPOSITE_PROVENANCE_DESCRIPTOR_PATH = /^decisions\/task-rebinds\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const COMPOSITE_PROVENANCE_DESCRIPTOR_KEYS = [
  'action', 'domainFoundationCommit', 'domainMergeCommit', 'fromCommit', 'omittedFiles',
  'phase', 'prestate', 'prestateFingerprint', 'rationale', 'retainedPatch', 'schema', 'target',
  'taskId',
];
const COMPOSITE_PROVENANCE_PRESTATE_KEYS = [
  'completionCommit', 'deps', 'id', 'leaseToken', 'phase', 'reqs', 'risk', 'status', 'title',
];
const COMPOSITE_PROVENANCE_RETAINED_PATCH_KEYS = ['paths', 'sha256', 'sourceCommit'];
const COMPOSITE_PROVENANCE_OMITTED_FILE_KEYS = ['blob', 'path'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMPOSITE_PROVENANCE_AUTHORITIES = new WeakMap();

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
      owner TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, outcome TEXT, commit_sha TEXT,
      provenance TEXT
    );
    CREATE TABLE IF NOT EXISTS merge_queue(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      candidate_sha TEXT NOT NULL, integration_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', merged_sha TEXT
    );
    CREATE TABLE IF NOT EXISTS task_binding_recoveries(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL, provenance TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_operational_acceptances(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL, provenance TEXT NOT NULL
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
  const attemptColumns = new Set(db.prepare('PRAGMA table_info(attempts)').all().map(column => column.name));
  if (!attemptColumns.has('provenance')) db.exec('ALTER TABLE attempts ADD COLUMN provenance TEXT');
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

// Archive disposition appends provenance; original attempts and task state remain untouched.
export function archiveHistoricalUsdgCompletion(db, taskId, options) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    const provenance = validateHistoricalUsdgArchive(root, db, taskId, options);
    const at = nowIso();
    const token = provenance.descriptor.prestate.leaseToken;
    db.prepare(`INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha,provenance)
      VALUES(?,?,?,?,?,'done',?,?)`).run(taskId, token, 'historical-archive-disposition', at, at,
        provenance.target, JSON.stringify(provenance));
    db.exec('COMMIT');
    return { taskId, route: provenance.route, commitSha: provenance.target };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function recoverTaskRequirements(db, taskId, options) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    if (db.prepare('SELECT 1 FROM task_operational_acceptances WHERE task_id=?').get(taskId)) {
      throw new Error('operationally accepted task cannot acquire product bindings');
    }
    const recovery = validateTaskBindingRecovery(root, db, taskId, options);
    if (recovery.descriptor.prestate.status === 'done') {
      validateCompletionCommit(root, recovery.descriptor.prestate.completion?.commitSha);
    }
    db.prepare('UPDATE tasks SET reqs=? WHERE id=?').run(JSON.stringify(recovery.reqs), taskId);
    db.prepare('INSERT INTO task_binding_recoveries(task_id,recorded_at,provenance) VALUES(?,?,?)')
      .run(taskId, nowIso(), JSON.stringify(recovery));
    db.exec('COMMIT');
    return { taskId, reqs: recovery.reqs, prestateFingerprint: recovery.prestateFingerprint };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function acceptOperationalTask(db, taskId, options) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    const acceptance = validateOperationalAcceptance(root, db, taskId, options);
    // Validate every done completion before appending authority, including other orphan history.
    for (const task of listTasks(db).filter(task => task.status === 'done')) {
      validateCompletionCommit(root, latestCompletionCommit(db, task.id));
    }
    const previous = db.prepare('SELECT provenance FROM task_operational_acceptances WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(taskId);
    if (previous && JSON.stringify(JSON.parse(previous.provenance).binding) === JSON.stringify(acceptance.binding)) {
      throw new Error('operational acceptance already recorded');
    }
    db.prepare('INSERT INTO task_operational_acceptances(task_id,recorded_at,provenance) VALUES(?,?,?)')
      .run(taskId, nowIso(), JSON.stringify(acceptance));
    db.exec('COMMIT');
    return acceptance.binding;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

function assertFullCommitFormat(commitSha) {
  if (typeof commitSha !== 'string' || !FULL_COMMIT.test(commitSha)) {
    throw new Error('completion commit must be a full lowercase 40-hex SHA');
  }
}

function commitObjectExists(root, commitSha) {
  return gitResult(root, ['cat-file', '-e', `${commitSha}^{commit}`]).status === 0;
}

function isReachableFromHead(root, commitSha) {
  return gitResult(root, ['merge-base', '--is-ancestor', commitSha, 'HEAD']).status === 0;
}

function isAncestor(root, ancestorSha, descendantSha) {
  return gitResult(root, ['merge-base', '--is-ancestor', ancestorSha, descendantSha]).status === 0;
}

function assertFullObjectId(value, label) {
  if (typeof value !== 'string' || !FULL_COMMIT.test(value)) {
    throw new Error(`composite-provenance rebind ${label} must be a full lowercase 40-hex object id`);
  }
}

function blobObjectExists(root, blobSha) {
  return gitResult(root, ['cat-file', '-e', `${blobSha}^{blob}`]).status === 0;
}

function blobAt(root, commitSha, path) {
  const result = gitResult(root, ['rev-parse', `${commitSha}:${path}`]);
  if (result.status !== 0) throw new Error(`path ${path} does not exist at commit ${commitSha}`);
  return result.stdout.trim();
}

function changedPaths(root, commitSha) {
  const result = gitResult(root, ['show', '--no-color', '--no-renames', '--name-only', '--format=', commitSha]);
  if (result.status !== 0) throw new Error(`unable to list changed paths for commit ${commitSha}`);
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRepoRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
    && !value.split('/').includes('..');
}

function isMergeCommit(root, commitSha) {
  const parents = gitResult(root, ['show', '-s', '--format=%P', commitSha]);
  if (parents.status !== 0) throw new Error(`completion commit ${commitSha} is not an existing commit object`);
  return parents.stdout.trim().split(/\s+/).filter(Boolean).length > 1;
}

// Byte-for-byte view of a patch as a canonicalized Buffer. Committed file content is not
// guaranteed to be valid UTF-8 (legacy encodings are legal patch payload), so the raw patch is
// captured as a Buffer and never decoded as UTF-8. Normalization uses a lossless latin1
// string view (a 1:1 byte<->code-point mapping, unlike UTF-8) so the header regexes below can
// run without ever collapsing distinct non-UTF-8 payload bytes into the same replacement
// character; only the two known-ASCII git-generated header line shapes are rewritten, never
// payload lines (those always start with '+'/'-'/' ' and so can never match '^index '/'^@@ ').
function canonicalizePatchBytes(rawPatch) {
  const text = rawPatch.toString('latin1');
  const canonicalText = text
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+((?: [0-7]{6})?)$/gm, 'index <object>..<object>$1')
    .replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/gm, '@@ <coords> @@$1');
  return Buffer.from(canonicalText, 'latin1');
}

// A canonical raw patch preserves whitespace, binary payloads, paths, modes, and all changed
// content byte-for-byte; only commit-dependent blob object IDs and hunk line-number coordinates
// are normalized, since those vary with history rewrites even for a truly identical change.
// Rendering is pinned against inherited repository configuration that could otherwise hide or
// alter content: no external diff driver, no path-relativization, and gitlink (submodule)
// changes always shown in full regardless of a local `diff.ignoreSubmodules` setting.
function canonicalCommitPatchArgs(root, commitSha) {
  return [
    '-C', root, 'show',
    '--no-color', '--no-textconv', '--no-renames', '--no-ext-diff', '--no-relative',
    '--ignore-submodules=none', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/',
    '--full-index', '--binary', '--format=', commitSha,
  ];
}

// Restricted to `paths` when given, so a composite-provenance descriptor can bind the canonical
// bytes of an exact file subset without claiming equivalence for the rest of the commit.
function canonicalPatchSha256(root, commitSha, paths = []) {
  const args = canonicalCommitPatchArgs(root, commitSha);
  if (paths.length > 0) args.push('--', ...paths);
  const diff = spawnSync('git', args, { maxBuffer: 1024 * 1024 * 256 });
  if (diff.status !== 0) throw new Error(`unable to render patch for commit ${commitSha}`);
  const canonical = canonicalizePatchBytes(diff.stdout);
  if (!canonical.toString('latin1').trim()) {
    throw new Error(`commit ${commitSha} produced an empty patch for the requested paths`);
  }
  return { canonical, sha256: sha256(canonical) };
}

function rewrittenCommitPatch(root, commitSha) {
  const diff = spawnSync('git', canonicalCommitPatchArgs(root, commitSha), { maxBuffer: 1024 * 1024 * 256 });
  if (diff.status !== 0) throw new Error(`unable to render patch for completion commit ${commitSha}`);
  const rawPatch = diff.stdout;
  const patchId = spawnSync('git', ['-C', root, 'patch-id', '--stable'], {
    input: rawPatch, encoding: 'utf8',
  });
  if (patchId.status !== 0) {
    throw new Error(`unable to compute stable patch id for completion commit ${commitSha}`);
  }
  const id = patchId.stdout.trim().split(/\s+/)[0] ?? '';
  const canonical = canonicalizePatchBytes(rawPatch);
  return { id, canonical };
}

function deriveRebindProvenance(root, fromCommitSha, commitSha) {
  assertFullCommitFormat(fromCommitSha);
  assertFullCommitFormat(commitSha);
  if (!commitObjectExists(root, commitSha)) {
    throw new Error(`completion commit ${commitSha} is not an existing commit object`);
  }
  if (!isReachableFromHead(root, commitSha)) {
    throw new Error(`completion commit ${commitSha} is not reachable from current HEAD`);
  }
  if (!commitObjectExists(root, fromCommitSha)) {
    throw new Error(`completion commit ${fromCommitSha} is not an existing commit object`);
  }
  if (isReachableFromHead(root, fromCommitSha)) {
    if (!isAncestor(root, fromCommitSha, commitSha)) {
      throw new Error(`completion commit ${commitSha} is not descended from ${fromCommitSha}`);
    }
    return { route: 'descendant', from: fromCommitSha, target: commitSha };
  }
  if (isMergeCommit(root, fromCommitSha)) {
    throw new Error(`completion commit ${fromCommitSha} is a merge commit`);
  }
  if (isMergeCommit(root, commitSha)) {
    throw new Error(`completion commit ${commitSha} is a merge commit`);
  }
  const from = rewrittenCommitPatch(root, fromCommitSha);
  const target = rewrittenCommitPatch(root, commitSha);
  if (!from.id || !from.canonical.toString('latin1').trim()) {
    throw new Error(`completion commit ${fromCommitSha} produced an empty patch`);
  }
  if (!target.id || !target.canonical.toString('latin1').trim()) {
    throw new Error(`completion commit ${commitSha} produced an empty patch`);
  }
  if (from.id !== target.id) {
    throw new Error(`completion commit ${commitSha} stable patch id does not match ${fromCommitSha}`);
  }
  if (!from.canonical.equals(target.canonical)) {
    throw new Error(`completion commit ${commitSha} canonical patch does not match ${fromCommitSha}`);
  }
  return {
    route: 'stable-patch-id',
    from: fromCommitSha,
    target: commitSha,
    patchId: from.id,
    rawPatchSha256: sha256(from.canonical),
  };
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
    const provenance = deriveRebindProvenance(root, fromCommitSha, commitSha);
    const at = nowIso();
    db.prepare(`
      INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha,provenance)
      VALUES(?,?,?,?,?,'done',?,?)
    `).run(taskId, task.lease_token, 'completion-rebind', at, at, commitSha, JSON.stringify(provenance));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function compositeProvenanceDescriptorPath(root, input, taskId) {
  if (typeof input !== 'string' || !COMPOSITE_PROVENANCE_DESCRIPTOR_PATH.test(input)
      || input !== `decisions/task-rebinds/${taskId}.json`) {
    throw new Error(`composite-provenance rebind descriptor must be decisions/task-rebinds/${taskId}.json`);
  }
  const rootPath = realpathSync(root);
  const lexical = resolve(rootPath, input);
  const rel = relative(rootPath, lexical);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('composite-provenance rebind descriptor must remain inside the repository');
  }
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(lexical) !== lexical) {
    throw new Error('composite-provenance rebind descriptor must be a regular repo-internal file, not a symlink');
  }
  resolveReceiptInput(root, input);
  return lexical;
}

function readCompositeProvenanceDescriptor(root, descriptorInput, taskId) {
  return readJson(compositeProvenanceDescriptorPath(root, descriptorInput, taskId));
}

// Independent recomputation of a retained-file-subset canonical patch digest, exposed so a
// descriptor author can derive the exact `retainedPatch.sha256` this validator will demand.
export function compositeProvenanceRetainedPatchSha256(root, commitSha, paths) {
  return canonicalPatchSha256(root, commitSha, paths).sha256;
}

export function prepareCompositeProvenanceRebind(db, taskId) {
  if (taskId !== COMPOSITE_PROVENANCE_TASK_ID) {
    throw new Error(`only ${COMPOSITE_PROVENANCE_TASK_ID} may use the composite-provenance rebind route`);
  }
  const task = listTasks(db).find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`no such task ${taskId}`);
  if (task.status !== 'done') throw new Error(`task ${taskId} is ${task.status}`);
  if (task.lease_owner !== null || task.lease_expires !== null) {
    throw new Error(`task ${taskId} is leased`);
  }
  const prestate = {
    id: task.id,
    title: task.title,
    phase: task.phase,
    risk: task.risk,
    deps: task.deps,
    reqs: task.reqs,
    status: task.status,
    leaseToken: task.lease_token,
    completionCommit: latestCompletionCommit(db, taskId),
  };
  return { prestate, fingerprint: sha256(Buffer.from(JSON.stringify(prestate))) };
}

// Verifies the full owner-approved composite-provenance disposition: exact seven-path partition,
// canonical five-file retained-patch equality against a target-reachable source commit, and
// byte-identical omitted files across the old completion, the domain foundation, and the target.
// Never trusts a descriptor-declared hash or blob id without recomputing it from the repository.
export function validateCompositeProvenanceRebindApproval(root, {
  taskId, fromCommitSha, commitSha, rationale, descriptorInput, approvalInput, prestate, prestateFingerprint,
}) {
  if (taskId !== COMPOSITE_PROVENANCE_TASK_ID) {
    throw new Error(`only ${COMPOSITE_PROVENANCE_TASK_ID} may use the composite-provenance rebind route`);
  }
  assertFullCommitFormat(fromCommitSha);
  assertFullCommitFormat(commitSha);
  const descriptor = readCompositeProvenanceDescriptor(root, descriptorInput, taskId);
  if (!sameKeys(descriptor, COMPOSITE_PROVENANCE_DESCRIPTOR_KEYS)) {
    throw new Error(`composite-provenance rebind descriptor must contain exactly ${COMPOSITE_PROVENANCE_DESCRIPTOR_KEYS.join(', ')}`);
  }
  if (descriptor.schema !== COMPOSITE_PROVENANCE_SCHEMA) {
    throw new Error('composite-provenance rebind descriptor has unsupported schema');
  }
  if (descriptor.action !== COMPOSITE_PROVENANCE_ACTION) {
    throw new Error('composite-provenance rebind descriptor has invalid action');
  }
  if (descriptor.taskId !== taskId) {
    throw new Error('composite-provenance rebind descriptor does not match task id');
  }
  if (descriptor.fromCommit !== fromCommitSha || descriptor.target !== commitSha) {
    throw new Error('composite-provenance rebind descriptor does not match the requested from/target commits');
  }
  if (typeof rationale !== 'string' || !rationale.trim()
      || typeof descriptor.rationale !== 'string' || !descriptor.rationale.trim()) {
    throw new Error('composite-provenance rebind descriptor rationale must be nonempty');
  }
  if (descriptor.rationale !== rationale.trim()) {
    throw new Error('composite-provenance rebind descriptor rationale does not match the requested rationale');
  }
  if (!sameKeys(prestate, COMPOSITE_PROVENANCE_PRESTATE_KEYS)
      || !sameKeys(descriptor.prestate, COMPOSITE_PROVENANCE_PRESTATE_KEYS)) {
    throw new Error(`composite-provenance rebind prestate must contain exactly ${COMPOSITE_PROVENANCE_PRESTATE_KEYS.join(', ')}`);
  }
  if (descriptor.phase !== prestate.phase || descriptor.phase !== descriptor.prestate.phase) {
    throw new Error('composite-provenance rebind descriptor phase does not match task phase');
  }
  if (descriptor.prestate.status !== 'done' || descriptor.prestate.completionCommit !== fromCommitSha) {
    throw new Error('composite-provenance rebind descriptor prestate must reflect the current done completion');
  }
  const descriptorFingerprint = sha256(Buffer.from(JSON.stringify(descriptor.prestate)));
  if (descriptor.prestateFingerprint !== descriptorFingerprint
      || prestateFingerprint !== descriptorFingerprint
      || sha256(Buffer.from(JSON.stringify(prestate))) !== descriptorFingerprint) {
    throw new Error('composite-provenance rebind descriptor prestate fingerprint does not match current task');
  }

  if (!commitObjectExists(root, fromCommitSha)) {
    throw new Error(`completion commit ${fromCommitSha} is not an existing commit object`);
  }
  if (isReachableFromHead(root, fromCommitSha)) {
    throw new Error(`completion commit ${fromCommitSha} is reachable from current HEAD; use the descendant or stable-patch-id route instead`);
  }
  if (isMergeCommit(root, fromCommitSha)) {
    throw new Error(`completion commit ${fromCommitSha} is a merge commit`);
  }
  if (!commitObjectExists(root, commitSha)) {
    throw new Error(`completion commit ${commitSha} is not an existing commit object`);
  }
  if (!isReachableFromHead(root, commitSha)) {
    throw new Error(`completion commit ${commitSha} is not reachable from current HEAD`);
  }

  if (!sameKeys(descriptor.retainedPatch, COMPOSITE_PROVENANCE_RETAINED_PATCH_KEYS)) {
    throw new Error(`composite-provenance rebind retainedPatch must contain exactly ${COMPOSITE_PROVENANCE_RETAINED_PATCH_KEYS.join(', ')}`);
  }
  const { paths, sourceCommit, sha256: retainedSha256 } = descriptor.retainedPatch;
  if (!Array.isArray(paths) || paths.length !== COMPOSITE_PROVENANCE_RETAINED_FILE_COUNT
      || paths.some(path => !isRepoRelativePath(path))
      || new Set(paths).size !== paths.length
      || !sameStringArray(paths, [...paths].sort())) {
    throw new Error(`composite-provenance rebind retainedPatch.paths must be exactly ${COMPOSITE_PROVENANCE_RETAINED_FILE_COUNT} unique sorted repo-relative paths`);
  }
  if (typeof retainedSha256 !== 'string' || !SHA256_PATTERN.test(retainedSha256)) {
    throw new Error('composite-provenance rebind retainedPatch.sha256 must be a SHA-256 hex digest');
  }
  assertFullObjectId(sourceCommit, 'retainedPatch.sourceCommit');
  if (!commitObjectExists(root, sourceCommit)) {
    throw new Error(`retained-patch source commit ${sourceCommit} is not an existing commit object`);
  }
  if (isMergeCommit(root, sourceCommit)) {
    throw new Error(`retained-patch source commit ${sourceCommit} is a merge commit`);
  }
  if (!isAncestor(root, sourceCommit, commitSha)) {
    throw new Error(`retained-patch source commit ${sourceCommit} is not reachable from target ${commitSha}`);
  }

  if (!Array.isArray(descriptor.omittedFiles)
      || descriptor.omittedFiles.length !== COMPOSITE_PROVENANCE_OMITTED_FILE_COUNT) {
    throw new Error(`composite-provenance rebind omittedFiles must list exactly ${COMPOSITE_PROVENANCE_OMITTED_FILE_COUNT} paths`);
  }
  const omittedPaths = descriptor.omittedFiles.map(file => file?.path);
  if (new Set(omittedPaths).size !== omittedPaths.length || !sameStringArray(omittedPaths, [...omittedPaths].sort())) {
    throw new Error('composite-provenance rebind omittedFiles must be unique and sorted by path');
  }
  for (const file of descriptor.omittedFiles) {
    if (!sameKeys(file, COMPOSITE_PROVENANCE_OMITTED_FILE_KEYS)) {
      throw new Error(`composite-provenance rebind omitted file entry must contain exactly ${COMPOSITE_PROVENANCE_OMITTED_FILE_KEYS.join(', ')}`);
    }
    if (!isRepoRelativePath(file.path)) {
      throw new Error(`composite-provenance rebind omitted file path is invalid: ${String(file.path)}`);
    }
    assertFullObjectId(file.blob, `omitted file blob for ${file.path}`);
  }

  const declaredPaths = new Set([...paths, ...omittedPaths]);
  if (declaredPaths.size !== COMPOSITE_PROVENANCE_RETAINED_FILE_COUNT + COMPOSITE_PROVENANCE_OMITTED_FILE_COUNT) {
    throw new Error('composite-provenance rebind retained and omitted paths must not overlap');
  }
  const sourcePartition = changedPaths(root, fromCommitSha);
  if (sourcePartition.length !== declaredPaths.size
      || new Set(sourcePartition).size !== sourcePartition.length
      || !sourcePartition.every(path => declaredPaths.has(path))) {
    throw new Error(`completion commit ${fromCommitSha} must change exactly the seven declared paths, with no omitted extra path`);
  }

  assertFullObjectId(descriptor.domainFoundationCommit, 'domainFoundationCommit');
  assertFullObjectId(descriptor.domainMergeCommit, 'domainMergeCommit');
  if (!commitObjectExists(root, descriptor.domainFoundationCommit)) {
    throw new Error(`domain foundation commit ${descriptor.domainFoundationCommit} is not an existing commit object`);
  }
  if (!commitObjectExists(root, descriptor.domainMergeCommit)) {
    throw new Error(`domain merge commit ${descriptor.domainMergeCommit} is not an existing commit object`);
  }
  if (!isMergeCommit(root, descriptor.domainMergeCommit)) {
    throw new Error(`domain merge commit ${descriptor.domainMergeCommit} is not a merge commit`);
  }
  if (!isAncestor(root, descriptor.domainFoundationCommit, descriptor.domainMergeCommit)) {
    throw new Error('domain foundation commit is not reachable from the domain merge commit');
  }
  if (!isAncestor(root, descriptor.domainMergeCommit, commitSha)) {
    throw new Error('domain merge commit is not reachable from the target completion');
  }

  for (const file of descriptor.omittedFiles) {
    if (!blobObjectExists(root, file.blob)) {
      throw new Error(`omitted file blob ${file.blob} for ${file.path} is not an existing blob object`);
    }
    for (const [label, sha] of [
      ['old completion', fromCommitSha],
      ['domain foundation', descriptor.domainFoundationCommit],
      ['target', commitSha],
    ]) {
      if (blobAt(root, sha, file.path) !== file.blob) {
        throw new Error(`omitted file ${file.path} is not byte-identical at the ${label} commit ${sha}`);
      }
    }
  }

  const restricted = canonicalPatchSha256(root, fromCommitSha, paths);
  if (restricted.sha256 !== retainedSha256) {
    throw new Error(`completion commit ${fromCommitSha} restricted to the five retained paths does not match the declared patch hash`);
  }
  const sourcePatch = canonicalPatchSha256(root, sourceCommit);
  if (sourcePatch.sha256 !== retainedSha256) {
    throw new Error(`retained-patch source commit ${sourceCommit} does not match the declared patch hash`);
  }
  const sourceChangedPaths = changedPaths(root, sourceCommit);
  if (!sameStringArray([...sourceChangedPaths].sort(), paths)) {
    throw new Error(`retained-patch source commit ${sourceCommit} must change exactly the five retained paths`);
  }

  readOwnerApproval(root, approvalInput, {
    action: COMPOSITE_PROVENANCE_ACTION,
    phase: descriptor.phase,
    itemId: taskId,
    rationale: descriptor.rationale,
    subjectInputs: [descriptorInput],
  });

  const authority = Object.freeze({});
  COMPOSITE_PROVENANCE_AUTHORITIES.set(authority, Object.freeze({
    taskId,
    fromCommitSha,
    commitSha,
    prestateFingerprint,
    descriptorInput,
    approvalInput,
    retainedPatch: Object.freeze({ paths: Object.freeze([...paths]), sourceCommit, sha256: retainedSha256 }),
    omittedFiles: Object.freeze(descriptor.omittedFiles.map(file => Object.freeze({ ...file }))),
    domainFoundationCommit: descriptor.domainFoundationCommit,
    domainMergeCommit: descriptor.domainMergeCommit,
  }));
  return Object.freeze({ ...descriptor, authority });
}

function assertCompositeProvenanceAuthority(authority, {
  taskId, fromCommitSha, commitSha, prestateFingerprint,
}) {
  const binding = authority && typeof authority === 'object'
    ? COMPOSITE_PROVENANCE_AUTHORITIES.get(authority)
    : null;
  if (!binding
      || binding.taskId !== taskId
      || binding.fromCommitSha !== fromCommitSha
      || binding.commitSha !== commitSha
      || binding.prestateFingerprint !== prestateFingerprint) {
    throw new Error('composite-provenance rebind requires validated owner authorization');
  }
  return binding;
}

export function rebindCompletionCompositeProvenance(db, taskId, fromCommitSha, commitSha, { authority }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (taskId !== COMPOSITE_PROVENANCE_TASK_ID) {
      throw new Error(`only ${COMPOSITE_PROVENANCE_TASK_ID} may use the composite-provenance rebind route`);
    }
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
    const prestate = {
      id: task.id,
      title: task.title,
      phase: task.phase,
      risk: task.risk,
      deps: JSON.parse(task.deps),
      reqs: JSON.parse(task.reqs),
      status: task.status,
      leaseToken: task.lease_token,
      completionCommit: current,
    };
    const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
    const binding = assertCompositeProvenanceAuthority(authority, {
      taskId, fromCommitSha, commitSha, prestateFingerprint,
    });
    const root = LEDGER_ROOTS.get(db);
    if (!root) throw new Error('ledger has no repository root');
    if (!commitObjectExists(root, commitSha) || !isReachableFromHead(root, commitSha)) {
      throw new Error(`completion commit ${commitSha} is not reachable from current HEAD`);
    }
    const provenance = {
      route: 'owner-approved-composite-provenance',
      from: fromCommitSha,
      target: commitSha,
      retainedPatch: binding.retainedPatch,
      omittedFiles: binding.omittedFiles,
      domainFoundationCommit: binding.domainFoundationCommit,
      domainMergeCommit: binding.domainMergeCommit,
      descriptorInput: binding.descriptorInput,
      approvalInput: binding.approvalInput,
    };
    const at = nowIso();
    db.prepare(`
      INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha,provenance)
      VALUES(?,?,?,?,?,'done',?,?)
    `).run(taskId, task.lease_token, 'completion-rebind', at, at, commitSha, JSON.stringify(provenance));
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
    const operational = db.prepare('SELECT provenance FROM task_operational_acceptances WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(task.id);
    if (operational) {
      const stored = JSON.parse(operational.provenance);
      const current = validateOperationalAcceptance(root, db, task.id, stored.binding);
      if (JSON.stringify(current.binding) !== JSON.stringify(stored.binding)) throw new Error('operational acceptance authority changed since recording');
      return { ...task, commitSha, operationalAcceptance: current.binding };
    }
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
