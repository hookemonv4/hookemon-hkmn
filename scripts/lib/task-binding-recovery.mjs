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
