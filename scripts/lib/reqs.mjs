import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { hashFile, readJson, sha256, writeJson } from './util.mjs';
import { listReceipts, isStale } from './receipts.mjs';
import {
  isGateReceiptAuthoritative, validateProjectedTaskDeferral,
} from './gates.mjs';
import { PHASE_SET } from './phases.mjs';
import { validateCompletionCommit } from './ledger.mjs';

export const REQ_KINDS = ['functional', 'performance', 'reliability', 'security', 'operational', 'compatibility', 'migration'];
const FILE = ['specs', 'requirements.json'];
const REQUIREMENTS_INPUT = 'specs/requirements.json';
const TASK_FILE = 'tasks.json';
const TASK_STATUSES = new Set(['ready', 'done', 'deferred']);
const PASSING_TASK_EVIDENCE_RESULTS = new Set(['PASSED']);

export function addRequirement(root, req) {
  const { id, kind, title, statement, measurement, module } = req;
  if (!REQ_KINDS.includes(kind)) throw new Error(`invalid kind ${kind}`);
  for (const [k, v] of Object.entries({ id, title, statement, measurement, module })) {
    if (!v) throw new Error(`requirement needs ${k}`);
  }
  const doc = readJson(join(root, ...FILE));
  if (doc.requirements.some(r => r.id === id)) throw new Error(`id ${id} must be unique`);
  doc.requirements.push({ id, kind, title, statement, measurement, module, status: 'approved' });
  doc.revision += 1;
  writeJson(join(root, ...FILE), doc);
  return doc.requirements.at(-1);
}

export function listRequirements(root) {
  return readJson(join(root, ...FILE)).requirements;
}

function requirementsBinding(root) {
  const path = join(root, ...FILE);
  const document = readJson(path);
  if (!document || typeof document !== 'object' || Array.isArray(document)
      || !Number.isInteger(document.revision) || document.revision < 0
      || !Array.isArray(document.requirements)) {
    throw new Error('specs/requirements.json must contain an integer revision and requirements array');
  }
  return { revision: document.revision, hash: hashFile(path) };
}

export function traceCheck(root) {
  const projection = readTaskProjection(root);
  const gaps = [...projection.gaps];
  const tasks = projection.tasks;
  const activeTasks = tasks.filter(task => task.status !== 'deferred');
  const receipts = listReceipts(root);
  const requirements = listRequirements(root);
  const requirementIds = new Set(requirements.map(requirement => requirement.id));

  for (const task of tasks) {
    if (task.reqs.length === 0) {
      if (task.status !== 'deferred') gaps.push(`${task.id}: active task needs at least one known requirement`);
    }
    for (const requirementId of task.reqs) {
      if (!requirementIds.has(requirementId)) {
        gaps.push(`${task.id}: unknown requirement ${requirementId}`);
      }
    }
  }

  if (tasksGateIsAuthoritative(root, receipts)) {
    if (!projection.exists) gaps.push('tasks.json: committed projection missing');
    for (const requirement of requirements) {
      if (!activeTasks.some(task => task.reqs.includes(requirement.id))) {
        gaps.push(`${requirement.id}: no task covers this requirement`);
      }
    }
  }

  for (const task of tasks.filter(candidate => candidate.status === 'done')) {
    if (!receipts.some(receipt => isValidTaskEvidence(root, receipt, task))) {
      gaps.push(`${task.id}: done without valid evidence receipt`);
    }
  }
  return { gaps };
}

function readTaskProjection(root) {
  const path = join(root, TASK_FILE);
  if (!existsSync(path)) return { exists: false, tasks: [], gaps: [] };
  const doc = readJson(path);
  if (!doc || !Array.isArray(doc.tasks)) {
    return { exists: true, tasks: [], gaps: ['tasks.json: tasks must be an array'] };
  }

  const tasks = [];
  const gaps = [];
  const ids = new Set();
  for (const [index, task] of doc.tasks.entries()) {
    const problems = [];
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      problems.push('must be an object');
    } else {
      if (typeof task.id !== 'string' || !task.id.trim()) problems.push('id must be a nonempty string');
      else if (ids.has(task.id)) problems.push(`duplicate id ${task.id}`);
      if (typeof task.title !== 'string' || !task.title.trim()) problems.push('title must be a nonempty string');
      if (!PHASE_SET.has(task.phase)) problems.push(`invalid phase ${String(task.phase)}`);
      if (typeof task.risk !== 'string' || !task.risk.trim()) problems.push('risk must be a nonempty string');
      if (!TASK_STATUSES.has(task.status)) problems.push(`invalid status ${String(task.status)}`);
      if (!Array.isArray(task.deps) || task.deps.some(id => typeof id !== 'string' || !id.trim())) {
        problems.push('deps must be an array of nonempty strings');
      }
      if (!Array.isArray(task.reqs) || task.reqs.some(id => typeof id !== 'string' || !id.trim())) {
        problems.push('reqs must be an array of nonempty strings');
      }
      if (task.status === 'done') {
        try { validateCompletionCommit(root, task.commitSha); }
        catch (error) { problems.push(`commitSha invalid: ${error.message}`); }
      } else if (task.status !== 'done' && Object.hasOwn(task, 'commitSha')) {
        problems.push(`${task.status} task must not have commitSha`);
      }
      const deferralFields = ['deferApproval', 'deferDescriptor', 'deferPrestateFingerprint'];
      if (task.status === 'deferred') {
        for (const field of deferralFields) {
          if (typeof task[field] !== 'string' || !task[field]) {
            problems.push(`deferred task needs ${field}`);
          }
        }
        if (problems.length === 0) {
          try {
            validateProjectedTaskDeferral(root, task);
          } catch (error) {
            problems.push(`deferred task authority invalid: ${error.message}`);
          }
        }
      } else if (deferralFields.some(field => Object.hasOwn(task, field))) {
        problems.push(`${task.status} task must not have deferral authority`);
      }
    }

    if (problems.length > 0) {
      gaps.push(`tasks.json task ${index}: ${problems.join('; ')}`);
    } else {
      ids.add(task.id);
      tasks.push(task);
    }
  }
  return { exists: true, tasks, gaps };
}

function tasksGateIsAuthoritative(root, receipts) {
  const latest = [...receipts].reverse()
    .find(receipt => receipt.type === 'gate' && receipt.phase === 'tasks');
  return Boolean(latest && ['PASSED', 'OVERRIDDEN'].includes(latest.result)
    && isGateReceiptAuthoritative(root, latest));
}

function isValidTaskEvidence(root, receipt, task) {
  if (receipt.type !== 'evidence') return false;
  if (!PASSING_TASK_EVIDENCE_RESULTS.has(receipt.result)) return false;
  if (receipt.data?.taskId !== task.id || receipt.phase !== task.phase) return false;
  if (!receipt.inputHashes || typeof receipt.inputHashes !== 'object'
      || Array.isArray(receipt.inputHashes) || Object.keys(receipt.inputHashes).length === 0) return false;
  if (receipt.data?.commitSha !== task.commitSha) return false;
  if (receipt.data?.taskFingerprint !== taskFingerprint(task)) return false;
  let requirements;
  try { requirements = requirementsBinding(root); }
  catch { return false; }
  if (receipt.data?.requirementsRevision !== requirements.revision
      || receipt.data?.requirementsHash !== requirements.hash
      || !Object.hasOwn(receipt.inputHashes, REQUIREMENTS_INPUT)) return false;
  if (!Object.keys(receipt.inputHashes).some(input => input !== REQUIREMENTS_INPUT)) return false;
  return !isStale(root, receipt);
}

export function taskFingerprint(task) {
  const canonical = {
    id: task.id,
    title: task.title,
    phase: task.phase,
    reqs: task.reqs,
    deps: task.deps,
    risk: task.risk,
    status: task.status,
    commitSha: task.commitSha,
    deferApproval: task.deferApproval,
    deferDescriptor: task.deferDescriptor,
    deferPrestateFingerprint: task.deferPrestateFingerprint,
  };
  return sha256(Buffer.from(JSON.stringify(canonical)));
}

export function taskEvidenceContext(root, taskId, requestedCommit = null) {
  const projection = readTaskProjection(root);
  if (!projection.exists) throw new Error('tasks.json: committed projection missing');
  if (projection.gaps.length > 0) throw new Error(projection.gaps.join('; '));
  const task = projection.tasks.find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`tasks.json: no task ${taskId}`);
  if (task.status !== 'done') throw new Error(`task ${taskId} is not done`);
  if (requestedCommit !== null && requestedCommit !== task.commitSha) {
    throw new Error(`task ${taskId} commit ${task.commitSha} does not match requested ${requestedCommit}`);
  }
  const requirements = requirementsBinding(root);
  return {
    phase: task.phase,
    data: {
      taskId: task.id,
      commitSha: task.commitSha,
      taskFingerprint: taskFingerprint(task),
      requirementsRevision: requirements.revision,
      requirementsHash: requirements.hash,
    },
    inputs: [REQUIREMENTS_INPUT],
  };
}

export function taskEvidenceData(root, taskId, requestedCommit = null) {
  return taskEvidenceContext(root, taskId, requestedCommit).data;
}
