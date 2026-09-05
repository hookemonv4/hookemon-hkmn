#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProjectedTaskDeferral } from './lib/gates.mjs';
import { hashFile } from './lib/util.mjs';

const REQUIRED_REGISTRIES = [
  'requirements', 'tasks', 'interfaces', 'product-dependencies', 'bindings', 'release-gates',
];
const OPERATIONAL_ROOTS = ['specs', 'interfaces', 'bindings', 'tasks', 'gates'];
const FUTURE_DECISION = 'future/PHASE_2_OWNER_DECISIONS.md';
const REFERENCE_FIELDS = new Set([
  'input', 'inputs', 'source', 'sources', 'dependency', 'dependencies',
  'reference', 'references', 'path', 'paths',
]);

function readJson(path, label, errors) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${label} must be a JSON object`);
      return null;
    }
    return value;
  } catch {
    errors.push(`malformed ${label}`);
    return null;
  }
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let current = value;
  for (const token of pointer.slice(1).split('/')) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[token.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return current;
}

function exactKeys(value, keys, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      errors.push(`${label} has unknown key ${key}`);
      valid = false;
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      errors.push(`${label} is missing key ${key}`);
      valid = false;
    }
  }
  return valid;
}

function safeRelativePath(root, file) {
  if (typeof file !== 'string' || file === '' || file.includes('\\') || file.startsWith('/') ||
      file.split('/').some(part => part === '' || part === '.' || part === '..')) return false;
  const target = resolve(root, file);
  return target !== root && !relative(root, target).startsWith('..');
}

function realpathWithin(root, path) {
  try {
    const rel = relative(realpathSync(root), realpathSync(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function regularRepoPath(root, path, type) {
  try {
    const stat = lstatSync(path);
    const expected = type === 'file' ? stat.isFile() : stat.isDirectory();
    return { exists: true, safe: expected && !stat.isSymbolicLink() && realpathWithin(root, path) };
  } catch {
    return { exists: false, safe: true };
  }
}

function regularSourcePath(root, file) {
  if (!safeRelativePath(root, file)) return { safe: false, exists: false };
  let current = root;
  for (const part of file.split('/')) {
    current = join(current, part);
    if (!existsSync(current)) return { safe: true, exists: false };
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return { safe: false, exists: true };
  }
  return { safe: lstatSync(current).isFile(), exists: true };
}

function pendingTaskDeferralRevision(root, task, authorityError) {
  if (task?.id !== 'P1-011'
      || !/^task deferral requirements (?:hash|revision) does not match current content$/.test(
        authorityError?.message ?? '',
      )) return null;

  const requirementsInput = 'specs/requirements.json';
  const requirementsState = regularSourcePath(root, requirementsInput);
  if (!requirementsState.safe || !requirementsState.exists) return null;
  const parseErrors = [];
  const requirements = readJson(join(root, requirementsInput), 'requirements', parseErrors);
  const liveDescriptor = readJson(
    join(root, task.deferDescriptor),
    'live task deferral descriptor',
    parseErrors,
  );
  const revision = requirements?.revision;
  const liveRevision = liveDescriptor?.requirements?.revision;
  if (parseErrors.length > 0 || !Number.isInteger(revision) || !Number.isInteger(liveRevision)) {
    return null;
  }

  const descriptorInput = `decisions/task-deferrals/P1-011-revision-${revision}-rebind-DRAFT.json`;
  const approvalInput = `decisions/owner-approvals/phase-3-revision-${revision}-dashboard-deferral-DRAFT_UNSIGNED.json`;
  for (const input of [descriptorInput, approvalInput, 'policy/policy.json']) {
    const state = regularSourcePath(root, input);
    if (!state.safe || !state.exists) return null;
  }
  const descriptor = readJson(join(root, descriptorInput), 'pending task deferral descriptor', parseErrors);
  const approval = readJson(join(root, approvalInput), 'pending task deferral approval', parseErrors);
  if (parseErrors.length > 0) return null;

  const rationale = `Phase 1 task P1-011 remains deferred under the owner-approved manual one-cycle boundary. DRAFT_UNSIGNED re-binding to requirements revision ${revision} after specs/requirements.json advanced from revision ${liveRevision} to ${revision}; this draft is not wired into tasks.json and does not replace the live decisions/task-deferrals/P1-011.json binding. The current task CLI cannot rebind an already deferred entry, and the approval draft binds the draft descriptor path instead of the canonical descriptor path, so an owner signature is necessary but not sufficient. An owner-authorized rebind operation must validate the existing deferral, produce canonical descriptor and approval bytes, and append the renewal receipt before this draft can replace the live binding. It authorizes no deployment, credential use, signing, broadcast, asset movement, spending, or publication.`;
  const expectedDescriptor = {
    ...liveDescriptor,
    rationale,
    requirements: {
      path: requirementsInput,
      revision,
      sha256: hashFile(join(root, requirementsInput)),
    },
  };
  if (JSON.stringify(descriptor) !== JSON.stringify(expectedDescriptor)) return null;
  for (const binding of [descriptor.decision, descriptor.design]) {
    const state = regularSourcePath(root, binding.path);
    if (!state.safe || !state.exists || hashFile(join(root, binding.path)) !== binding.sha256) {
      return null;
    }
  }
  for (const field of ['id', 'title', 'phase', 'risk', 'deps', 'reqs']) {
    if (JSON.stringify(descriptor.prestate[field]) !== JSON.stringify(task[field])) return null;
  }

  const expectedApproval = {
    schema: 'v4-owner-approval-v2',
    authority: 'OWNER',
    action: 'TASK_DEFER',
    phase: task.phase,
    itemId: task.id,
    rationale,
    approvalToken: 'DRAFT_UNSIGNED_NOT_YET_APPROVED',
    draftStatus: 'UNSIGNED_DRAFT_PENDING_OWNER_SIGNATURE',
    subjectHashes: {
      [descriptorInput]: hashFile(join(root, descriptorInput)),
      'policy/policy.json': hashFile(join(root, 'policy/policy.json')),
    },
  };
  return JSON.stringify(approval) === JSON.stringify(expectedApproval) ? revision : null;
}

function visitFiles(root, directory, errors) {
  const start = join(root, directory);
  const startState = regularRepoPath(root, start, 'directory');
  if (!startState.exists) return [];
  if (!startState.safe) {
    errors?.push(`operational root ${directory} must be a regular directory`);
    return [];
  }
  const files = [];
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    const file = join(start, entry.name);
    if (entry.name === '.gitkeep') {
      const state = regularRepoPath(root, file, 'file');
      if (!state.safe || readFileSync(file, 'utf8') !== '') {
        errors?.push(`operational root ${directory} .gitkeep must be an empty regular repo-internal file`);
      }
      continue;
    }
    if (entry.isSymbolicLink()) errors?.push(`operational root ${directory} contains symbolic link ${relative(root, file)}`);
    else if (entry.isDirectory()) files.push(...visitFiles(root, relative(root, file), errors));
    else if (entry.isFile()) files.push(relative(root, file));
    else errors?.push(`operational root ${directory} contains non-regular path ${relative(root, file)}`);
  }
  return files;
}

function futureReference(value, field = null) {
  if (typeof value === 'string') {
    return field && value.replaceAll('\\', '/').includes(FUTURE_DECISION) ? field : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = futureReference(entry, field);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    const found = futureReference(entry, REFERENCE_FIELDS.has(key.toLowerCase()) ? key : field);
    if (found) return found;
  }
  return null;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]*$/.test(value);
}

function recordKey(registryId, recordId) {
  return `${registryId}:${recordId}`;
}

function readReceipts(root, errors) {
  const directory = join(root, 'receipts');
  const rootState = regularRepoPath(root, directory, 'directory');
  if (!rootState.exists) return 0;
  if (!rootState.safe) {
    errors.push('receipt root must be a regular repo-internal directory');
    return 0;
  }
  const listed = readdirSync(directory).sort();
  if (listed.includes('.gitkeep')) {
    const keep = join(directory, '.gitkeep');
    const state = regularRepoPath(root, keep, 'file');
    if (!state.safe || readFileSync(keep, 'utf8') !== '') errors.push('receipt .gitkeep must be an empty regular file');
  }
  const entries = listed.filter(name => name !== '.gitkeep');
  for (let index = 0; index < entries.length; index += 1) {
    const name = entries[index];
    const expectedId = `r-${String(index + 1).padStart(5, '0')}`;
    const path = join(directory, name);
    if (name !== `${expectedId}.json`) errors.push(`receipt sequence must contain ${expectedId}`);
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      errors.push(`receipt ${name} must be a regular file`);
      continue;
    }
    const receipt = readJson(path, `receipt ${expectedId}`, errors);
    if (!receipt) continue;
    exactKeys(receipt, ['id', 'at', 'type', 'phase', 'result', 'data', 'inputHashes'], `receipt ${expectedId}`, errors);
    if (receipt.id !== expectedId) errors.push(`receipt ${name} must contain canonical id ${expectedId}`);
    if (typeof receipt.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.at) || Number.isNaN(Date.parse(receipt.at))) {
      errors.push(`receipt ${expectedId} has invalid at`);
    }
    if (typeof receipt.type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(receipt.type)) errors.push(`receipt ${expectedId} has invalid type`);
    if (receipt.phase !== null && typeof receipt.phase !== 'string') errors.push(`receipt ${expectedId} has invalid phase`);
    if (receipt.result !== null && typeof receipt.result !== 'string') errors.push(`receipt ${expectedId} has invalid result`);
    if (!receipt.data || typeof receipt.data !== 'object' || Array.isArray(receipt.data)) errors.push(`receipt ${expectedId} has invalid data`);
    if (!receipt.inputHashes || typeof receipt.inputHashes !== 'object' || Array.isArray(receipt.inputHashes)) {
      errors.push(`receipt ${expectedId} has invalid inputHashes`);
    } else {
      for (const [input, hash] of Object.entries(receipt.inputHashes)) {
        if (!safeRelativePath(root, input) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
          errors.push(`receipt ${expectedId} has invalid input hash`);
        }
      }
    }
  }
  return entries.length;
}

export function checkDeliveryBoundary(rootPath) {
  const root = resolve(rootPath);
  const errors = [];
  const boundaryPath = join(root, 'product/delivery-boundary.json');
  const boundaryState = regularRepoPath(root, boundaryPath, 'file');
  if (!boundaryState.safe || !boundaryState.exists) {
    errors.push('delivery boundary must be a regular repo-internal file');
    return { ok: false, errors, receiptsChecked: readReceipts(root, errors) };
  }
  const boundary = readJson(boundaryPath, 'delivery boundary', errors);
  if (!boundary) return { ok: false, errors, receiptsChecked: readReceipts(root, errors) };

  exactKeys(boundary, ['schemaVersion', 'openDeliveryPhase', 'phases', 'operationalRoots', 'registries', 'sidecars'], 'delivery boundary', errors);
  if (boundary.schemaVersion !== 1) errors.push('delivery boundary schemaVersion must be 1');
  if (![1, 2, 3].includes(boundary.openDeliveryPhase)) {
    errors.push('delivery boundary openDeliveryPhase must be 1, 2, or 3');
  }
  const phases = boundary.phases;
  const expectedPhases = {
    1: { '1': 'OPEN', '2': 'CLOSED', '3': 'CLOSED' },
    2: { '1': 'COMPLETE', '2': 'OPEN', '3': 'CLOSED' },
    3: { '1': 'COMPLETE', '2': 'COMPLETE', '3': 'OPEN' },
  }[boundary.openDeliveryPhase];
  if (!phases || typeof phases !== 'object' || Array.isArray(phases)
      || Object.keys(phases).length !== 3
      || !expectedPhases
      || Object.entries(expectedPhases).some(([phase, status]) => phases[phase] !== status)) {
    errors.push('delivery boundary phase map must match the active delivery phase');
  }
  if (phases && typeof phases === 'object' && !Array.isArray(phases)) {
    for (const key of Object.keys(phases)) {
      if (!['1', '2', '3'].includes(key)) errors.push(`delivery boundary phase map has unknown key ${key}`);
    }
  }
  if (!Array.isArray(boundary.operationalRoots) || new Set(boundary.operationalRoots).size !== OPERATIONAL_ROOTS.length ||
      boundary.operationalRoots.length !== OPERATIONAL_ROOTS.length ||
      OPERATIONAL_ROOTS.some(rootName => !boundary.operationalRoots.includes(rootName))) {
    errors.push('delivery boundary operationalRoots must exactly list every operational root once');
  }
  if (!Array.isArray(boundary.registries)) {
    errors.push('delivery boundary registries must be an array');
    return { ok: false, errors, receiptsChecked: readReceipts(root, errors) };
  }

  const registryIds = boundary.registries.map(registry => registry?.id);
  for (const id of REQUIRED_REGISTRIES) {
    if (registryIds.filter(found => found === id).length !== 1) errors.push(`delivery boundary must register ${id} exactly once`);
  }
  for (const id of registryIds) {
    if (!REQUIRED_REGISTRIES.includes(id)) errors.push(`unknown delivery registry ${String(id)}`);
  }

  const records = new Map();
  const registeredFiles = new Set();
  for (const registry of boundary.registries) {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      errors.push('delivery boundary registry must be an object');
      continue;
    }
    exactKeys(registry, ['id', 'sources'], `registry ${String(registry.id)}`, errors);
    if (!REQUIRED_REGISTRIES.includes(registry.id) || !Array.isArray(registry.sources)) continue;
    for (const source of registry.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        errors.push(`registry ${registry.id} has an invalid source`);
        continue;
      }
      const hasStatic = Object.hasOwn(source, 'records');
      const hasCollection = Object.hasOwn(source, 'recordsAt') || Object.hasOwn(source, 'recordIdProperty');
      const sourceLabel = `source ${String(source.file)}`;
      const allowed = hasStatic && !hasCollection
        ? ['file', 'records', 'optional']
        : hasCollection && !hasStatic
          ? ['file', 'recordsAt', 'recordIdProperty', 'optional']
          : [];
      if (hasStatic && !Array.isArray(source.records)) errors.push(`${sourceLabel} records must be an array`);
      if (hasStatic === hasCollection) errors.push(`${sourceLabel} must use exactly one record form`);
      if (allowed.length > 0) {
        for (const key of Object.keys(source)) if (!allowed.includes(key)) errors.push(`${sourceLabel} has unknown key ${key}`);
        for (const key of allowed.filter(key => key !== 'optional')) if (!(key in source)) errors.push(`${sourceLabel} is missing key ${key}`);
      }
      if (Object.hasOwn(source, 'optional') && typeof source.optional !== 'boolean') errors.push(`${sourceLabel} optional must be a boolean`);
      const safePath = regularSourcePath(root, source.file);
      if (!safePath.safe) {
        errors.push(`source path must be a regular repo-internal path: ${source.file}`);
        continue;
      }
      registeredFiles.add(source.file);
      const file = join(root, source.file);
      if (!safePath.exists) {
        if (source.optional !== true) errors.push(`registered source ${source.file} is missing`);
        continue;
      }
      const doc = readJson(file, `registered source ${source.file}`, errors);
      if (!doc) continue;
      if (registry.id === 'tasks' && source.file === 'tasks/context-packs.json') {
        if (!Array.isArray(doc.cards)) {
          errors.push('task context-pack registry must contain a cards array');
        } else {
          for (const card of doc.cards) {
            const expectedPath = validId(card?.id) ? `tasks/${card.id}.md` : null;
            if (!expectedPath || card?.path !== expectedPath) {
              errors.push(`task context pack ${String(card?.id)} has an invalid card path`);
              continue;
            }
            const cardState = regularSourcePath(root, card.path);
            if (!cardState.safe || !cardState.exists) {
              errors.push(`task context pack ${card.id} must reference a regular repo-internal card`);
              continue;
            }
            registeredFiles.add(card.path);
          }
        }
      }
      if (hasStatic && Array.isArray(source.records) && !hasCollection) {
        for (const sidecar of source.records) {
          if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
            errors.push(`registry ${registry.id} has an invalid static record sidecar`);
            continue;
          }
          exactKeys(sidecar, ['recordId', 'pointer'], `static record ${String(sidecar.recordId)}`, errors);
          if (!validId(sidecar.recordId) || typeof sidecar.pointer !== 'string' || !sidecar.pointer.startsWith('/')) {
            errors.push(`registry ${registry.id} has an invalid static record sidecar`);
            continue;
          }
          if (jsonPointer(doc, sidecar.pointer) === undefined) {
            errors.push(`record ${sidecar.recordId} points to missing ${source.file}${sidecar.pointer}`);
            continue;
          }
          const id = recordKey(registry.id, sidecar.recordId);
          if (records.has(id)) errors.push(`duplicate record id ${id}`);
          else records.set(id, jsonPointer(doc, sidecar.pointer));
        }
      } else if (hasCollection && !hasStatic) {
        const collection = jsonPointer(doc, source.recordsAt);
        if (!Array.isArray(collection) || !validId(source.recordIdProperty)) {
          errors.push(`registry ${registry.id} has an invalid record collection`);
          continue;
        }
        for (const record of collection) {
          const id = record?.[source.recordIdProperty];
          if (!validId(id)) {
            errors.push(`registry ${registry.id} record has a missing or invalid stable id`);
            continue;
          }
          if (registry.id === 'tasks' && source.file === 'tasks.json'
              && record.status === 'deferred') {
            try {
              validateProjectedTaskDeferral(root, record);
              registeredFiles.add(`tasks/${record.id}.md`);
            } catch (error) {
              const pendingRevision = pendingTaskDeferralRevision(root, record, error);
              errors.push(pendingRevision === null
                ? `deferred task ${record.id} authority invalid: ${error.message}`
                : `deferred task ${record.id} renewal pending owner signature and an owner-authorized deferred-task rebind path for requirements revision ${pendingRevision}`);
            }
            continue;
          }
          const key = recordKey(registry.id, id);
          if (records.has(key)) errors.push(`duplicate record id ${key}`);
          else records.set(key, record);
        }
      }
    }
  }

  const sidecars = Array.isArray(boundary.sidecars) ? boundary.sidecars : [];
  if (!Array.isArray(boundary.sidecars)) errors.push('delivery boundary sidecars must be an array');
  const classified = new Set();
  for (const sidecar of sidecars) {
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
      errors.push('delivery boundary has an invalid record sidecar');
      continue;
    }
    exactKeys(sidecar, ['recordId', 'deliveryPhase'], `sidecar ${String(sidecar.recordId)}`, errors);
    if (!validId(sidecar.recordId) || !Number.isInteger(sidecar.deliveryPhase)) {
      errors.push('delivery boundary has an invalid record sidecar');
      continue;
    }
    if (classified.has(sidecar.recordId)) errors.push(`duplicate sidecar for ${sidecar.recordId}`);
    classified.add(sidecar.recordId);
    if (!records.has(sidecar.recordId)) errors.push(`unknown sidecar for ${sidecar.recordId}`);
    if (sidecar.deliveryPhase < 1 || sidecar.deliveryPhase > boundary.openDeliveryPhase) {
      errors.push(`${sidecar.recordId} is assigned to closed delivery phase ${sidecar.deliveryPhase}`);
    }
  }
  for (const id of records.keys()) {
    if (!classified.has(id)) errors.push(`missing sidecar for ${id}`);
    const field = futureReference(records.get(id));
    if (field) errors.push(`${id} references future decision through ${field}`);
  }

  for (const operationalRoot of boundary.operationalRoots ?? []) {
    if (!OPERATIONAL_ROOTS.includes(operationalRoot)) continue;
    for (const file of visitFiles(root, operationalRoot, errors)) {
      if (file.startsWith('gates/runs/')) continue;
      if (!registeredFiles.has(file)) errors.push(`unregistered normative file ${file}`);
    }
  }

  const receiptsChecked = readReceipts(root, errors);
  return { ok: errors.length === 0, errors, receiptsChecked };
}

function main() {
  const result = checkDeliveryBoundary(process.cwd());
  if (result.ok) console.log(`delivery boundary check passed (${result.receiptsChecked} receipts checked)`);
  else {
    console.log(`delivery boundary check failed: ${result.errors.length} violation(s)`);
    for (const error of result.errors) console.log(`- ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
