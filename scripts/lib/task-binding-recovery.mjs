import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readOwnerApproval } from './gates.mjs';
import { resolveReceiptInput } from './receipts.mjs';
import { hashFile, readJson, sha256 } from './util.mjs';

const ACTION = 'TASK_BIND_REQUIREMENTS';
const REQUIREMENTS = 'specs/requirements.json';
const fingerprint = value => sha256(Buffer.from(JSON.stringify(value)));

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
}

export function prepareTaskBindingRecovery(db, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) throw new Error(`no such task ${taskId}`);
  if (!['ready', 'done'].includes(task.status)) throw new Error(`task ${taskId} is ${task.status}`);
  // Even an expired lease needs supported release/reclaim handling first.
  if (task.lease_owner !== null || task.lease_expires !== null) throw new Error(`task ${taskId} is leased`);
  const completion = db.prepare("SELECT seq,commit_sha FROM attempts WHERE task_id=? AND outcome='done' ORDER BY seq DESC LIMIT 1").get(taskId);
  const prestate = {
    id: task.id, title: task.title, phase: task.phase, risk: task.risk,
    deps: JSON.parse(task.deps), reqs: JSON.parse(task.reqs), status: task.status,
    leaseToken: task.lease_token,
    completion: completion ? { seq: completion.seq, commitSha: completion.commit_sha } : null,
  };
  return { prestate, fingerprint: fingerprint(prestate) };
}

// Authorization approves the exact reviewed contribution, not merely any known requirement.
// This route never classifies operational work or certifies requirement acceptance.
export function validateTaskBindingRecovery(root, db, taskId, { record, approval }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)
      || record !== `decisions/task-bindings/${taskId}.json`) {
    throw new Error('binding descriptor must be decisions/task-bindings/<task-id>.json');
  }
  const path = resolve(realpathSync(root), record);
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new Error('binding descriptor must be a regular repo-internal file without symlinks');
  }
  resolveReceiptInput(root, record);
  const descriptor = readJson(path);
  exactKeys(descriptor, ['schema', 'action', 'taskId', 'prestate', 'prestateFingerprint', 'requirements', 'bindings', 'rationale'], 'binding descriptor');
  if (descriptor.schema !== 'v4-task-binding-recovery-v1' || descriptor.action !== ACTION
      || descriptor.taskId !== taskId) throw new Error('binding descriptor identity mismatch');
  const current = prepareTaskBindingRecovery(db, taskId);
  if (descriptor.prestateFingerprint !== current.fingerprint
      || fingerprint(descriptor.prestate) !== current.fingerprint) throw new Error('binding prestate is stale');
  exactKeys(descriptor.requirements, ['revision', 'sha256'], 'requirements binding');
  const requirements = readJson(join(root, REQUIREMENTS));
  if (!Number.isInteger(requirements.revision) || !Array.isArray(requirements.requirements)
      || descriptor.requirements.revision !== requirements.revision
      || descriptor.requirements.sha256 !== hashFile(join(root, REQUIREMENTS))) {
    throw new Error('binding requirements are stale');
  }
  if (typeof descriptor.rationale !== 'string' || !descriptor.rationale.trim()) throw new Error('binding rationale is required');
  if (!Array.isArray(descriptor.bindings) || !descriptor.bindings.length) throw new Error('nonempty requirement bindings required');
  const reqs = [];
  for (const binding of descriptor.bindings) {
    exactKeys(binding, ['requirementId', 'contribution', 'rationale', 'evidence'], 'requirement contribution');
    const matches = requirements.requirements.filter(req => req.id === binding.requirementId);
    if (matches.length !== 1 || matches[0].status !== 'approved') throw new Error('binding needs a known approved requirement');
    if (reqs.includes(binding.requirementId)) throw new Error('duplicate requirement binding');
    if (!['implementation', 'supporting', 'test'].includes(binding.contribution)
        || typeof binding.rationale !== 'string' || !binding.rationale.trim()) throw new Error('qualified contribution required');
    if (!binding.evidence || typeof binding.evidence !== 'object' || Array.isArray(binding.evidence)
        || !Object.keys(binding.evidence).length) throw new Error('contribution evidence required');
    for (const [input, digest] of Object.entries(binding.evidence)) {
      const evidencePath = resolveReceiptInput(root, input);
      if (digest !== hashFile(evidencePath)) throw new Error('contribution evidence hash mismatch');
    }
    reqs.push(binding.requirementId);
  }
  if (JSON.stringify(reqs) === JSON.stringify(current.prestate.reqs)) throw new Error('binding recovery must change requirements');
  readOwnerApproval(root, approval, {
    action: ACTION, phase: current.prestate.phase, itemId: taskId,
    rationale: descriptor.rationale, subjectInputs: [record],
  });
  return {
    reqs, prestateFingerprint: current.fingerprint, descriptor,
    record, recordHash: hashFile(path), approval, approvalHash: hashFile(join(root, approval)),
  };
}

export function prepareOperationalAcceptance(db, taskId) {
  const current = prepareTaskBindingRecovery(db, taskId);
  if (current.prestate.status !== 'done' || current.prestate.reqs.length) {
    throw new Error('operational acceptance requires a completed task with no product requirements');
  }
  return current;
}

function readOperationalAcceptance(root, taskId, { record, approval }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)
      || record !== `decisions/task-operations/${taskId}.json`) {
    throw new Error('operational descriptor must be decisions/task-operations/<task-id>.json');
  }
  const path = resolve(realpathSync(root), record);
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('operational descriptor must be a regular repo-internal file without symlinks');
  resolveReceiptInput(root, record);
  const descriptor = readJson(path);
  exactKeys(descriptor, ['schema', 'action', 'taskId', 'prestate', 'prestateFingerprint', 'processSources', 'rationale'], 'operational descriptor');
  if (descriptor.schema !== 'v4-task-operational-acceptance-v1'
      || descriptor.action !== 'TASK_ACCEPT_OPERATIONAL' || descriptor.taskId !== taskId) throw new Error('operational descriptor identity mismatch');
  const p = descriptor.prestate;
  exactKeys(p, ['id', 'title', 'phase', 'risk', 'deps', 'reqs', 'status', 'leaseToken', 'completion'], 'operational prestate');
  if (p.id !== taskId || p.status !== 'done' || !Array.isArray(p.reqs) || p.reqs.length
      || !Number.isInteger(p.leaseToken) || p.leaseToken < 0
      || !p.completion || !Number.isInteger(p.completion.seq) || p.completion.seq < 1
      || fingerprint(p) !== descriptor.prestateFingerprint) throw new Error('invalid operational prestate');
  exactKeys(p.completion, ['seq', 'commitSha'], 'operational completion');
  if (typeof descriptor.rationale !== 'string' || !descriptor.rationale.trim()) throw new Error('operational rationale required');
  const sources = descriptor.processSources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)
      || !Object.hasOwn(sources, 'policy/policy.json')) throw new Error('operational acceptance must bind governing policy');
  for (const [input, digest] of Object.entries(sources)) {
    if (digest !== hashFile(resolveReceiptInput(root, input))) throw new Error('operational process source is stale');
  }
  const ownerApproval = readOwnerApproval(root, approval, {
    action: descriptor.action, phase: p.phase, itemId: taskId,
    rationale: descriptor.rationale, subjectInputs: [record],
  });
  return {
    descriptor, ownerApproval,
    binding: { record, recordHash: hashFile(path), approval, approvalHash: hashFile(join(root, approval)), prestateFingerprint: descriptor.prestateFingerprint },
  };
}

export function validateOperationalAcceptance(root, db, taskId, options) {
  const result = readOperationalAcceptance(root, taskId, options);
  if (prepareOperationalAcceptance(db, taskId).fingerprint !== result.binding.prestateFingerprint) {
    throw new Error('operational prestate is stale');
  }
  return result;
}

export function validateProjectedOperationalAcceptance(root, task) {
  const binding = task.operationalAcceptance;
  exactKeys(binding, ['record', 'recordHash', 'approval', 'approvalHash', 'prestateFingerprint'], 'operational projection');
  const result = readOperationalAcceptance(root, task.id, binding);
  if (fingerprint(binding) !== fingerprint(result.binding)) throw new Error('operational projection authority is stale');
  const p = result.descriptor.prestate;
  for (const field of ['id', 'title', 'phase', 'risk', 'deps', 'reqs', 'status']) {
    if (JSON.stringify(task[field]) !== JSON.stringify(p[field])) throw new Error('operational projection differs from approved task');
  }
  if (task.commitSha !== p.completion.commitSha) throw new Error('operational completion differs from approval');
  return [binding.record, binding.approval, ...Object.keys(result.descriptor.processSources)];
}
