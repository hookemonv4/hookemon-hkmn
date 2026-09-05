import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  hashFile, nowIso, readJson, sha256, writeJson,
} from './util.mjs';
import {
  listReceipts, isStale, resolveReceiptInput,
} from './receipts.mjs';
import { PHASES, assertFrameworkPhase } from './phases.mjs';
import { validateInterfaceFreeze } from '../../feasibility/verify-robinhood-binding.mjs';

export const ITEM_STATUSES = ['RUN', 'INHERITED', 'NOT_APPLICABLE', 'ESCALATE'];
export const GATE_RESULTS = ['PASSED', 'FAILED', 'OVERRIDDEN', 'STALE', 'EXHAUSTED_WITH_OPEN_FINDINGS', 'PENDING'];
export const OWNER_NOT_APPLICABLE_RECEIPT_TYPE = 'owner-not-applicable-authorized';
export const GATE_EVIDENCE_PRODUCER = 'v4-gate-evidence-v1';
export const OWNER_EVIDENCE_PRODUCER = 'v4-owner-authorize-v1';
export const OWNER_NOT_APPLICABLE_PRODUCER = 'v4-owner-not-applicable-v1';
export const GATE_PROOF_SCHEMA = 'sha256-input-manifest-v1';
export const OWNER_APPROVAL_SCHEMA = 'v4-owner-approval-v2';
export const OWNER_ACTIONS = Object.freeze({
  EVIDENCE: 'GATE_EVIDENCE',
  OVERRIDE: 'GATE_OVERRIDE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  TASK_DEFER: 'TASK_DEFER',
});
const POLICY_INPUT = 'policy/policy.json';
const OWNER_APPROVAL_PREFIX = 'decisions/owner-approvals/';
const OWNER_APPROVAL_PATH = /^decisions\/owner-approvals\/[a-z0-9][a-z0-9._-]*\.json$/;
const TASK_DEFERRAL_PATH = /^decisions\/task-deferrals\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const OWNER_ASK_FIRST = 'Marking a gate item NOT_APPLICABLE';
const TASK_DEFER_ASK_FIRST = 'Terminally deferring a task';
const OWNER_NEVER = 'Approve your own work on behalf of the owner';
const OWNER_OVERRIDE_POLICY = "Every gate is owner-overridable. An override needs the owner's explicit rationale and is recorded as a receipt. Nothing external to the owner may block this project.";
const OWNER_APPROVAL_POLICY = "Approval semantics: only an unambiguous affirmative from the owner counts. Hedged responses ('looks reasonable', 'I guess') are not approval.";
const POLICY_KEYS = [
  'allowedInputs', 'allowedPrefixes', 'authority', 'requiredInputs', 'requiredPrefixes',
];
const OWNER_APPROVAL_KEYS = [
  'action', 'approvalToken', 'authority', 'itemId', 'phase', 'rationale', 'schema', 'subjectHashes',
];
const TASK_DEFERRAL_KEYS = [
  'action', 'decision', 'design', 'phase', 'prestate', 'prestateFingerprint', 'rationale',
  'requirements', 'schema', 'targetStatus', 'taskId',
];
const TASK_DEFERRAL_PRESTATE_KEYS = [
  'completionCommit', 'deps', 'id', 'leaseToken', 'phase', 'reqs', 'risk', 'status', 'title',
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODULE_CARD_SECTIONS = Object.freeze([
  'Purpose',
  'Public interface',
  'Invariants',
  'State transitions',
  'Operational commands',
  'Recovery pointers',
]);
const OWNER_APPROVAL_TOKENS = new Set([
  'OWNER APPROVED',
  'OWNER AUTHORIZED',
  'PHASE 1 BASELINE APPROVED',
  'LEGACY CLEANUP APPROVED',
  'SPEC A APPROVED',
  'SPEC B APPROVED',
  'SPEC C APPROVED',
]);
const TASK_DEFERRAL_AUTHORITIES = new WeakMap();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertPathArray(value, label, prefix = false) {
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !path
      || path.startsWith('/') || path.split(/[\\/]/).includes('..')
      || (prefix && !path.endsWith('/')))) {
    throw new Error(`${label} must be an array of repo-relative ${prefix ? 'prefixes ending in /' : 'paths'}`);
  }
}

function validateEvidencePolicy(phase, item) {
  const policy = item.evidencePolicy;
  if (!sameKeys(policy, POLICY_KEYS)) {
    throw new Error(`${phase}/${item.id} evidencePolicy must contain exactly ${POLICY_KEYS.join(', ')}`);
  }
  if (!['SYSTEM', 'OWNER'].includes(policy.authority)) {
    throw new Error(`${phase}/${item.id} evidencePolicy has invalid authority ${String(policy.authority)}`);
  }
  assertPathArray(policy.requiredInputs, `${phase}/${item.id} requiredInputs`);
  assertPathArray(policy.allowedInputs, `${phase}/${item.id} allowedInputs`);
  assertPathArray(policy.requiredPrefixes, `${phase}/${item.id} requiredPrefixes`, true);
  assertPathArray(policy.allowedPrefixes, `${phase}/${item.id} allowedPrefixes`, true);
  if (policy.requiredInputs.length + policy.requiredPrefixes.length === 0) {
    throw new Error(`${phase}/${item.id} evidencePolicy must require at least one artifact`);
  }
  for (const required of policy.requiredInputs) {
    if (!policy.allowedInputs.includes(required)
        && !policy.allowedPrefixes.some(prefix => required.startsWith(prefix))) {
      throw new Error(`${phase}/${item.id} required input ${required} is not allowed`);
    }
  }
  for (const required of policy.requiredPrefixes) {
    if (!policy.allowedPrefixes.some(prefix => required.startsWith(prefix))) {
      throw new Error(`${phase}/${item.id} required prefix ${required} is not allowed`);
    }
  }
  return policy;
}

function readGateDefinition(root, phase) {
  assertFrameworkPhase(phase, 'gate phase');
  const definition = readJson(join(root, 'gates', `${phase}.json`));
  if (!isPlainObject(definition) || definition.id !== phase || !Number.isInteger(definition.version)
      || definition.version < 1 || !Array.isArray(definition.items)) {
    throw new Error(`gate ${phase} has an invalid definition`);
  }
  const ids = new Set();
  const types = new Set();
  for (const item of definition.items) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id
        || typeof item.receiptType !== 'string' || !item.receiptType) {
      throw new Error(`gate ${phase} has an invalid item`);
    }
    if (ids.has(item.id)) throw new Error(`gate ${phase} has duplicate item ${item.id}`);
    if (types.has(item.receiptType)) throw new Error(`gate ${phase} has duplicate receiptType ${item.receiptType}`);
    ids.add(item.id);
    types.add(item.receiptType);
    validateEvidencePolicy(phase, item);
  }
  return definition;
}

function gateItem(root, phase, itemId) {
  const definition = readGateDefinition(root, phase);
  const item = definition.items.find(candidate => candidate.id === itemId);
  if (!item) throw new Error(`gate ${phase} has no item ${itemId}`);
  return { definition, item, policy: validateEvidencePolicy(phase, item) };
}

export function reservedGateReceiptTypes(root) {
  const types = new Set(['gate', OWNER_NOT_APPLICABLE_RECEIPT_TYPE]);
  for (const phase of PHASES) {
    for (const item of readGateDefinition(root, phase).items) types.add(item.receiptType);
  }
  return types;
}

function writeGateReceipt(root, { type, phase, result, data, inputs }) {
  if (!Array.isArray(inputs)) throw new Error('gate receipt inputs must be an array');
  const history = listReceipts(root);
  const lastSequence = history.length === 0 ? 0n : BigInt(history.at(-1).id.slice(2));
  const id = `r-${(lastSequence + 1n).toString().padStart(5, '0')}`;
  const inputHashes = {};
  for (const input of inputs) inputHashes[input] = hashFile(resolveReceiptInput(root, input));
  const receipt = {
    id, at: nowIso(), type, phase, result, data, inputHashes,
  };
  const directory = join(root, 'receipts');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

function normalizeEvidenceInputs(phase, item, inputs) {
  if (!Array.isArray(inputs)) throw new Error(`${phase}/${item.id} evidence inputs must be an array`);
  const unique = [...new Set(inputs)];
  if (unique.length !== inputs.length) throw new Error(`${phase}/${item.id} evidence inputs must be unique`);
  const policy = validateEvidencePolicy(phase, item);
  for (const input of unique) {
    if (typeof input !== 'string' || !input
        || input === '.gitkeep' || input.endsWith('/.gitkeep')
        || (!policy.allowedInputs.includes(input)
          && !policy.allowedPrefixes.some(prefix => input.startsWith(prefix)))) {
      throw new Error(`${String(input)} is not allowed by ${phase}/${item.id} evidence policy`);
    }
  }
  for (const required of policy.requiredInputs) {
    if (!unique.includes(required)) throw new Error(`${phase}/${item.id} evidence requires input ${required}`);
  }
  for (const required of policy.requiredPrefixes) {
    if (!unique.some(input => input.startsWith(required))) {
      throw new Error(`${phase}/${item.id} evidence requires an input under ${required}`);
    }
  }
  return [...unique].sort();
}

function readRunForUpdate(root, phase) {
  const runPath = join(root, 'gates', 'runs', `${phase}.json`);
  const run = readJson(runPath, { items: {} });
  if (!isPlainObject(run) || !isPlainObject(run.items)) {
    throw new Error(`gate run ${phase} must contain an items object`);
  }
  return { run, runPath };
}

function updateRun(root, phase, itemId, status, receiptId) {
  const { run, runPath } = readRunForUpdate(root, phase);
  writeJson(runPath, {
    ...run,
    items: { ...run.items, [itemId]: { status, receipt: receiptId } },
  });
}

function validateIntegrationSpikes(root) {
  const artifact = readJson(join(root, 'feasibility', 'integration-spikes.json'));
  const disposition = typeof artifact.gateDisposition === 'string' ? artifact.gateDisposition : '';
  if (/\bF3\b[^.]*\b(?:must not pass|stays? blocked|must remain blocked)\b/i.test(disposition)) {
    throw new Error('feasibility/F3 cannot pass: integration spikes explicitly block F3');
  }
  if (artifact.schemaVersion !== 'hookemon.integration-spikes.v2'
      || artifact.overallStatus !== 'PASSED'
      || artifact.gateDisposition !== 'F3 PASSED'
      || !Array.isArray(artifact.waivers)
      || !Array.isArray(artifact.blockingFacts)) {
    throw new Error('feasibility/F3 cannot pass without the exact v2 schema and passing disposition');
  }
  if (artifact.waivers.length > 0) {
    throw new Error('feasibility/F3 SYSTEM evidence cannot grant or consume owner waivers; use a gate override');
  }
  if (artifact.blockingFacts.length > 0) {
    throw new Error('feasibility/F3 cannot pass while integration-spike blockers remain');
  }
  if (!Array.isArray(artifact.spikes) || artifact.spikes.length === 0) {
    throw new Error('feasibility/F3 cannot pass without integration spike results');
  }
  const spikeIds = new Set();
  for (const spike of artifact.spikes) {
    if (!isPlainObject(spike) || typeof spike.id !== 'string' || !spike.id
        || typeof spike.status !== 'string' || !spike.status
        || spike.status !== 'PASSED' || spikeIds.has(spike.id)) {
      throw new Error(`unresolved integration spike ${String(spike?.id ?? '(unknown)')} requires a gate override`);
    }
    spikeIds.add(spike.id);
  }
}

function receiptTransitivelyBindsCurrentInput(root, receipt, input, receipts) {
  const expectedHash = hashFile(resolveReceiptInput(root, input));
  const byInput = new Map(receipts.map(candidate => [`receipts/${candidate.id}.json`, candidate]));
  const queue = [receipt];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.inputHashes?.[input] === expectedHash) return true;
    for (const nested of Object.keys(current.inputHashes ?? {})) {
      if (byInput.has(nested)) queue.push(byInput.get(nested));
    }
  }
  return false;
}

function validateFrozenInterfaces(root) {
  const freeze = readJson(join(root, 'feasibility', 'interface-freeze.json'));
  const frozen = readJson(join(root, 'architecture', 'interfaces.json'));
  const provisional = readJson(join(root, 'architecture', 'provisional-interfaces.json'));
  const manifest = readJson(join(root, 'bindings', 'robinhood-chain.json'));
  try {
    validateInterfaceFreeze({ freeze, frozen, provisional, manifest, projectRoot: root });
  } catch (error) {
    throw new Error(`feasibility/F4 interface freeze invalid: ${error.message}`);
  }

  const receipts = listReceipts(root);
  const architectureReceipt = [...receipts].reverse()
    .find(receipt => receipt.type === 'gate' && receipt.phase === 'architecture');
  const boundInputs = ['architecture/interfaces.json', 'feasibility/interface-freeze.json'];
  if (!architectureReceipt
      || !['PASSED', 'OVERRIDDEN'].includes(architectureReceipt.result)
      || !isGateReceiptAuthoritative(root, architectureReceipt)
      || !boundInputs.every(input => receiptTransitivelyBindsCurrentInput(
        root, architectureReceipt, input, receipts,
      ))) {
    throw new Error('latest authoritative architecture gate receipt does not bind architecture/interfaces.json and feasibility/interface-freeze.json');
  }
}

function assertUniqueRegularModuleFile(root, input, physicalFiles) {
  const repoRoot = realpathSync(root);
  const lexical = resolve(repoRoot, input);
  const target = resolveReceiptInput(root, input);
  const stat = lstatSync(lexical);
  const identity = `${stat.dev}:${stat.ino}`;
  if (stat.isSymbolicLink() || !stat.isFile() || target !== lexical || physicalFiles.has(identity)) {
    throw new Error(`architecture/A6 module artifact ${input} must be a unique regular file, not a symlink or alias`);
  }
  physicalFiles.add(identity);
  return lexical;
}

function hasExactModuleCardStructure(card, moduleId) {
  const expectedTitle = moduleId.split('-')
    .map(part => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
  const lines = card.replaceAll('\r\n', '\n').split('\n');
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (fence === null) {
      const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        fence = { marker: opening[1][0], length: opening[1].length };
        continue;
      }
    } else {
      const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const heading = lines[index].match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (heading) headings.push({ level: heading[1].length, title: heading[2], line: index });
  }
  const titles = headings.filter(heading => heading.level === 1);
  const sections = headings.filter(heading => heading.level === 2);
  if (titles.length !== 1 || headings[0] !== titles[0] || titles[0].title !== expectedTitle
      || !sameStringArray(sections.map(section => section.title), MODULE_CARD_SECTIONS)) {
    return false;
  }
  return sections.every((section, index) => {
    const nextLine = sections[index + 1]?.line ?? lines.length;
    return lines.slice(section.line + 1, nextLine).some(line => {
      const trimmed = line.trim();
      return trimmed && !/^(`{3,}|~{3,})/.test(trimmed) && !/^#{1,6}(?:\s|$)/.test(trimmed);
    });
  });
}

function validateModuleIndex(root) {
  const indexInput = 'docs/modules/index.json';
  const capabilityInput = 'architecture/capability-map.json';
  const requirementsInput = 'specs/requirements.json';
  const index = readJson(assertUniqueRegularModuleFile(root, indexInput, new Set()));
  const capability = readJson(resolveReceiptInput(root, capabilityInput));
  const requirements = readJson(resolveReceiptInput(root, requirementsInput));
  const interfaceStatusByPhase = {
    1: 'PROVISIONAL',
    2: 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING',
    3: 'PROVISIONAL',
  };
  if (!sameKeys(index, [
    'architectureRevision', 'interfaceStatus', 'modules', 'productPhase', 'requiredSections',
    'requirementsRevision', 'schemaVersion',
  ]) || index.schemaVersion !== 1 || !Object.hasOwn(interfaceStatusByPhase, index.productPhase)
      || index.interfaceStatus !== interfaceStatusByPhase[index.productPhase]
      || !sameStringArray(index.requiredSections, MODULE_CARD_SECTIONS)
      || !Array.isArray(index.modules) || index.modules.length === 0) {
    throw new Error('architecture/A6 module index has an invalid schema or interface status');
  }
  if (!isPlainObject(capability) || !Array.isArray(capability.modules)
      || !Array.isArray(capability.topologicalOrder)
      || !isPlainObject(requirements)
      || index.productPhase !== capability.productPhase
      || index.architectureRevision !== capability.architectureRevision
      || index.requirementsRevision !== capability.requirementsRevision
      || index.requirementsRevision !== requirements.revision) {
    throw new Error('architecture/A6 revision binding does not match current architecture and requirements');
  }
  const capabilityIds = capability.modules.map(module => module?.id);
  if (!sameStringSet(capabilityIds, capability.topologicalOrder)
      || !sameStringArray(index.modules.map(module => module?.id), capability.topologicalOrder)) {
    throw new Error('architecture/A6 module set must match the capability map');
  }

  const ids = new Set();
  const paths = new Set();
  const physicalCards = new Set();
  for (const module of index.modules) {
    if (!sameKeys(module, ['id', 'path', 'sha256'])
        || typeof module.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(module.id)
        || module.path !== `docs/modules/${module.id}.md`
        || typeof module.sha256 !== 'string' || !SHA256_PATTERN.test(module.sha256)) {
      throw new Error('architecture/A6 module index contains an invalid module entry');
    }
    if (ids.has(module.id) || paths.has(module.path)) {
      throw new Error(`architecture/A6 module index contains duplicate module ${module.id}`);
    }
    ids.add(module.id);
    paths.add(module.path);
    const cardPath = assertUniqueRegularModuleFile(root, module.path, physicalCards);
    if (hashFile(cardPath) !== module.sha256) {
      throw new Error(`architecture/A6 module index digest mismatch for ${module.path}`);
    }
    const card = readFileSync(cardPath, 'utf8');
    if (!hasExactModuleCardStructure(card, module.id)) {
      throw new Error(`architecture/A6 module card ${module.path} must have its exact title and ordered nonempty sections`);
    }
  }
  return [capabilityInput, indexInput, requirementsInput, ...paths].sort();
}

function validateInducedFailureDrill(root) {
  const drill = readJson(join(root, 'qa', 'drills', 'induced-failure.json'));
  const invalid = !sameKeys(drill, [
    'authority', 'claims', 'diagnosis', 'executedAt', 'scenario', 'schemaVersion', 'telemetry',
  ])
    || drill.schemaVersion !== 'hookemon.induced-failure-drill.v1'
    || drill.authority !== 'LOCAL_DIAGNOSTIC_EVIDENCE_ONLY'
    || typeof drill.executedAt !== 'string'
    || new Date(drill.executedAt).toISOString() !== drill.executedAt
    || !sameKeys(drill.scenario, ['id', 'injection', 'scope'])
    || drill.scenario.id !== 'phase1-manifest-digest-mismatch'
    || drill.scenario.injection !== 'HOOKEMON_PHASE1_MANIFEST_SHA256=64_ZERO_HEX'
    || drill.scenario.scope !== 'LOCAL_OFFLINE_RELEASE_VERIFIER_ONLY'
    || !sameKeys(drill.telemetry, [
      'candidateManifestSha256', 'command', 'exitCode', 'injectedManifestSha256',
      'nodeVersion', 'observed', 'source',
    ])
    || drill.telemetry.command !== 'env HOOKEMON_PHASE1_MANIFEST_SHA256=0000000000000000000000000000000000000000000000000000000000000000 OPENSSL_CONF=/dev/null /private/tmp/node-v24.19.0-darwin-arm64/bin/node scripts/verify-phase1-release.mjs'
    || drill.telemetry.source !== 'PROCESS_EXIT_AND_STDERR_ONLY'
    || drill.telemetry.exitCode !== 1
    || drill.telemetry.observed !== 'local candidate manifest digest does not match the caller-supplied digest'
    || drill.telemetry.nodeVersion !== 'v24.19.0'
    || !SHA256_PATTERN.test(drill.telemetry.candidateManifestSha256)
    || drill.telemetry.candidateManifestSha256 === '0'.repeat(64)
    || drill.telemetry.injectedManifestSha256 !== '0'.repeat(64)
    || !sameKeys(drill.diagnosis, ['classification', 'derivedOnlyFromTelemetry', 'outcome'])
    || drill.diagnosis.classification !== 'CALLER_MANIFEST_DIGEST_MISMATCH'
    || drill.diagnosis.derivedOnlyFromTelemetry !== true
    || drill.diagnosis.outcome !== 'FAIL_CLOSED_LOCAL_VERIFIER_REJECTION'
    || !sameKeys(drill.claims, [
      'alertChannelTested', 'externalActionsPerformed', 'liveReadinessProven',
      'operatingStateProven',
    ])
    || Object.values(drill.claims).some(value => value !== false);
  if (invalid) throw new Error('ship/H3 induced-failure evidence is invalid');
}

function validateOperationsHandoff(root) {
  const handoff = readFileSync(join(root, 'ops', 'HANDOFF.md'), 'utf8').replaceAll('\r\n', '\n');
  const required = [
    '# Phase 1 Local Operations Handoff',
    '## Status',
    'Local-only preparation; not operating and not live.',
    '## See status',
    '`node scripts/v4.mjs status --check`',
    '`state.json`',
    '## Stop locally',
    'Ctrl-C',
    'No background service or scheduler is configured.',
    '## Paging',
    'Paging is not configured and therefore fails closed.',
    'Nobody is paged automatically.',
    '## Receipts',
    '`receipts/`',
    '`gates/runs/`',
    '## Authority',
    'does not authorize deployment, publication, credential access, signing, broadcast, spending, or a live cycle.',
  ];
  const forbidden = [/Status:\s*OPERATING/i, /alerts? (?:are|is) configured/i, /live readiness (?:is|has been) proven/i];
  if (!required.every(value => handoff.includes(value)) || forbidden.some(pattern => pattern.test(handoff))) {
    throw new Error('ship/H5 operations handoff is invalid');
  }
}

function expandSystemEvidenceInputs(root, phase, itemId, inputs) {
  if (phase === 'architecture' && itemId === 'A6') {
    return [...new Set([...inputs, ...validateModuleIndex(root)])];
  }
  return inputs;
}

function validateSystemEvidenceSemantics(root, phase, itemId, inputs) {
  if (phase === 'architecture' && itemId === 'A6') {
    const expected = validateModuleIndex(root);
    if (!sameStringArray([...inputs].sort(), expected)) {
      throw new Error('architecture/A6 evidence must bind the module index and every indexed card');
    }
  }
  if (phase === 'feasibility' && itemId === 'F3') validateIntegrationSpikes(root);
  if (phase === 'feasibility' && itemId === 'F4') validateFrozenInterfaces(root);
  if (phase === 'ship' && itemId === 'H3') validateInducedFailureDrill(root);
  if (phase === 'ship' && itemId === 'H5') validateOperationsHandoff(root);
}

export function recordGateEvidence(root, phase, itemId, inputs) {
  const { item, policy } = gateItem(root, phase, itemId);
  if (policy.authority !== 'SYSTEM') throw new Error(`${phase}/${itemId} requires OWNER authorization`);
  const expandedInputs = expandSystemEvidenceInputs(root, phase, itemId, inputs);
  const artifactInputs = normalizeEvidenceInputs(phase, item, expandedInputs);
  validateSystemEvidenceSemantics(root, phase, itemId, artifactInputs);
  readRunForUpdate(root, phase);
  const receipt = writeGateReceipt(root, {
    type: item.receiptType,
    phase,
    result: 'PASSED',
    data: { itemId, producer: GATE_EVIDENCE_PRODUCER, proofSchema: GATE_PROOF_SCHEMA },
    inputs: [`gates/${phase}.json`, ...artifactInputs],
  });
  updateRun(root, phase, itemId, 'RUN', receipt.id);
  return receipt;
}

function approvalArtifactPath(root, input) {
  if (typeof input !== 'string' || !OWNER_APPROVAL_PATH.test(input)) {
    throw new Error(`owner approval must be a JSON artifact under ${OWNER_APPROVAL_PREFIX}`);
  }
  const rootPath = realpathSync(root);
  const lexical = resolve(rootPath, input);
  const rel = relative(rootPath, lexical);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('owner approval must remain inside the repository');
  }
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(lexical) !== lexical) {
    throw new Error('owner approval must be a regular repo-internal file, not a symlink');
  }
  resolveReceiptInput(root, input);
  return lexical;
}

function explicitApprovalToken(token) {
  return typeof token === 'string' && OWNER_APPROVAL_TOKENS.has(token.trim());
}

function exactOwnerSubjectInputs(root, subjectHashes, expectedInputs) {
  if (!isPlainObject(subjectHashes)) throw new Error('owner approval subjectHashes must be a plain object');
  const actual = Object.keys(subjectHashes);
  const canonical = [...actual].sort();
  if (!sameStringArray(actual, canonical)) {
    throw new Error('owner approval subjectHashes paths must be in canonical lexicographic order');
  }
  const expected = [...new Set(expectedInputs)].sort();
  if (!sameStringArray(actual, expected)) {
    const missing = expected.filter(input => !actual.includes(input));
    const extra = actual.filter(input => !expected.includes(input));
    throw new Error(`owner approval subjectHashes must bind exactly the approved inputs (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  for (const input of actual) {
    const approvedHash = subjectHashes[input];
    if (typeof approvedHash !== 'string' || !SHA256_PATTERN.test(approvedHash)) {
      throw new Error(`owner approval has invalid SHA-256 subject hash for ${input}`);
    }
    const currentHash = hashFile(resolveReceiptInput(root, input));
    if (approvedHash !== currentHash) {
      throw new Error(`owner approval subject hash for ${input} does not match current content`);
    }
  }
  return expected;
}

export function readOwnerApproval(root, approvalInput, expected) {
  const artifact = readJson(approvalArtifactPath(root, approvalInput));
  if (!sameKeys(artifact, OWNER_APPROVAL_KEYS)) {
    throw new Error(`owner approval must contain exactly ${OWNER_APPROVAL_KEYS.join(', ')}`);
  }
  if (artifact.schema !== OWNER_APPROVAL_SCHEMA) throw new Error(`owner approval has schema ${String(artifact.schema)}; expected ${OWNER_APPROVAL_SCHEMA}`);
  if (artifact.authority !== 'OWNER') throw new Error(`owner approval has authority ${String(artifact.authority)}; expected OWNER`);
  if (artifact.action !== expected.action) throw new Error(`owner approval has action ${String(artifact.action)}; expected ${expected.action}`);
  if (artifact.phase !== expected.phase) throw new Error(`owner approval has phase ${String(artifact.phase)}; expected ${expected.phase}`);
  if (artifact.itemId !== expected.itemId) throw new Error(`owner approval has itemId ${String(artifact.itemId)}; expected ${String(expected.itemId)}`);
  if (typeof artifact.rationale !== 'string' || !artifact.rationale.trim()) throw new Error('owner approval rationale must be nonempty');
  if (artifact.rationale !== expected.rationale) throw new Error('owner approval rationale does not match the requested rationale');
  if (!explicitApprovalToken(artifact.approvalToken)) throw new Error('owner approval needs a nonempty explicit APPROVED or AUTHORIZED token');
  exactOwnerSubjectInputs(root, artifact.subjectHashes, expected.subjectInputs);
  return artifact;
}

function taskDeferralDescriptorPath(root, input, taskId) {
  if (typeof input !== 'string' || !TASK_DEFERRAL_PATH.test(input)
      || input !== `decisions/task-deferrals/${taskId}.json`) {
    throw new Error(`task deferral descriptor must be decisions/task-deferrals/${taskId}.json`);
  }
  const rootPath = realpathSync(root);
  const lexical = resolve(rootPath, input);
  const rel = relative(rootPath, lexical);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('task deferral descriptor must remain inside the repository');
  }
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(lexical) !== lexical) {
    throw new Error('task deferral descriptor must be a regular repo-internal file, not a symlink');
  }
  resolveReceiptInput(root, input);
  return lexical;
}

export function readTaskDeferralDescriptor(root, descriptorInput, taskId) {
  return readJson(taskDeferralDescriptorPath(root, descriptorInput, taskId));
}

function validateTaskDeferralBinding(root, binding, label, pathPattern) {
  if (!sameKeys(binding, ['path', 'sha256'])) {
    throw new Error(`task deferral ${label} must contain exactly path, sha256`);
  }
  if (typeof binding.path !== 'string' || !pathPattern.test(binding.path)) {
    throw new Error(`task deferral ${label} has invalid path`);
  }
  if (typeof binding.sha256 !== 'string' || !SHA256_PATTERN.test(binding.sha256)) {
    throw new Error(`task deferral ${label} has invalid SHA-256`);
  }
  if (hashFile(resolveReceiptInput(root, binding.path)) !== binding.sha256) {
    throw new Error(`task deferral ${label} hash does not match current content`);
  }
}

export function validateTaskDeferralApproval(root, {
  taskId, phase, rationale, descriptorInput, approvalInput, prestate, prestateFingerprint,
}) {
  if (!explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.TASK_DEFER)) {
    throw new Error('task deferral owner policy is not active');
  }
  const descriptor = readTaskDeferralDescriptor(root, descriptorInput, taskId);
  if (!sameKeys(descriptor, TASK_DEFERRAL_KEYS)) {
    throw new Error(`task deferral descriptor must contain exactly ${TASK_DEFERRAL_KEYS.join(', ')}`);
  }
  if (descriptor.schema !== 'v4-task-deferral-v1') {
    throw new Error('task deferral descriptor has unsupported schema');
  }
  if (descriptor.action !== OWNER_ACTIONS.TASK_DEFER || descriptor.targetStatus !== 'deferred') {
    throw new Error('task deferral descriptor has invalid action or target status');
  }
  if (descriptor.taskId !== taskId || descriptor.phase !== phase) {
    throw new Error('task deferral descriptor does not match task id and phase');
  }
  if (typeof rationale !== 'string' || !rationale.trim()
      || typeof descriptor.rationale !== 'string' || !descriptor.rationale.trim()) {
    throw new Error('task deferral descriptor rationale must be nonempty');
  }
  if (descriptor.rationale !== rationale.trim()) {
    throw new Error('task deferral descriptor rationale does not match the requested rationale');
  }
  if (!sameKeys(descriptor.prestate, TASK_DEFERRAL_PRESTATE_KEYS)) {
    throw new Error(`task deferral prestate must contain exactly ${TASK_DEFERRAL_PRESTATE_KEYS.join(', ')}`);
  }
  const descriptorFingerprint = sha256(Buffer.from(JSON.stringify(descriptor.prestate)));
  if (descriptor.prestateFingerprint !== descriptorFingerprint
      || prestateFingerprint !== descriptorFingerprint
      || sha256(Buffer.from(JSON.stringify(prestate))) !== descriptorFingerprint) {
    throw new Error('task deferral descriptor prestate fingerprint does not match current task');
  }
  if (!sameKeys(descriptor.requirements, ['path', 'revision', 'sha256'])
      || descriptor.requirements.path !== 'specs/requirements.json'
      || !Number.isInteger(descriptor.requirements.revision)
      || descriptor.requirements.revision < 1
      || typeof descriptor.requirements.sha256 !== 'string'
      || !SHA256_PATTERN.test(descriptor.requirements.sha256)) {
    throw new Error('task deferral requirements binding is invalid');
  }
  const requirementsPath = resolveReceiptInput(root, descriptor.requirements.path);
  if (hashFile(requirementsPath) !== descriptor.requirements.sha256) {
    throw new Error('task deferral requirements hash does not match current content');
  }
  if (readJson(requirementsPath).revision !== descriptor.requirements.revision) {
    throw new Error('task deferral requirements revision does not match current content');
  }
  validateTaskDeferralBinding(
    root,
    descriptor.decision,
    'decision',
    /^decisions\/ADR-[0-9]{4}[a-z0-9._-]*\.md$/,
  );
  validateTaskDeferralBinding(
    root,
    descriptor.design,
    'design',
    /^docs\/superpowers\/specs\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9._-]+\.md$/,
  );
  readOwnerApproval(root, approvalInput, {
    action: OWNER_ACTIONS.TASK_DEFER,
    phase,
    itemId: taskId,
    rationale: descriptor.rationale,
    subjectInputs: [descriptorInput, POLICY_INPUT],
  });
  const authority = Object.freeze({});
  TASK_DEFERRAL_AUTHORITIES.set(authority, Object.freeze({
    taskId,
    prestateFingerprint,
    descriptorInput,
    approvalInput,
  }));
  return Object.freeze({ ...descriptor, authority });
}

export function validateProjectedTaskDeferral(root, task) {
  if (!task || task.id !== 'P1-011') throw new Error('only P1-011 may be deferred');
  const descriptor = readTaskDeferralDescriptor(root, task.deferDescriptor, task.id);
  validateTaskDeferralApproval(root, {
    taskId: task.id, phase: task.phase, rationale: descriptor.rationale,
    descriptorInput: task.deferDescriptor, approvalInput: task.deferApproval,
    prestate: descriptor.prestate, prestateFingerprint: task.deferPrestateFingerprint,
  });
  const projectedFields = ['id', 'title', 'phase', 'risk', 'deps', 'reqs'];
  for (const field of projectedFields) {
    if (JSON.stringify(descriptor.prestate[field]) !== JSON.stringify(task[field])) {
      throw new Error(`task deferral prestate ${field} does not match projected task`);
    }
  }
  if (!['ready', 'done'].includes(descriptor.prestate.status)) {
    throw new Error('task deferral prestate status must be ready or done');
  }
  return descriptor;
}

export function assertTaskDeferralAuthority(authority, {
  taskId, prestateFingerprint,
}) {
  const binding = authority && typeof authority === 'object'
    ? TASK_DEFERRAL_AUTHORITIES.get(authority)
    : null;
  if (!binding
      || binding.taskId !== taskId
      || binding.prestateFingerprint !== prestateFingerprint) {
    throw new Error('task deferral requires validated owner authorization');
  }
  return binding;
}

function ownerEvidenceSubjectInputs(phase, artifactInputs) {
  return [...new Set([`gates/${phase}.json`, POLICY_INPUT, ...artifactInputs])].sort();
}

function receiptInputClosure(root, inputs) {
  const closure = new Set(inputs);
  const receipts = new Map(
    listReceipts(root).map(receipt => [`receipts/${receipt.id}.json`, receipt]),
  );
  const queue = [...closure].filter(input => receipts.has(input));
  while (queue.length > 0) {
    const receipt = receipts.get(queue.shift());
    for (const input of Object.keys(receipt.inputHashes ?? {})) {
      if (closure.has(input)) continue;
      closure.add(input);
      if (receipts.has(input)) queue.push(input);
    }
  }
  return [...closure].filter(input => {
    try {
      resolveReceiptInput(root, input);
      return true;
    } catch {
      return false;
    }
  }).sort();
}

function overrideApprovalSubjectInputs(root, evaluation, approvalInput) {
  return receiptInputClosure(root, [...evaluation.inputs, POLICY_INPUT])
    .filter(input => input !== approvalInput);
}

function approvalMatchesReceipt(artifact, receipt, subjectInputs) {
  for (const input of subjectInputs) {
    if (receipt.inputHashes?.[input] !== artifact.subjectHashes[input]) {
      return `receipt hash for ${input} does not match its owner approval subject hash`;
    }
  }
  return null;
}

function hasCurrentDirectInputs(root, receipt) {
  try {
    return Object.entries(receipt.inputHashes ?? {}).every(
      ([input, hash]) => hashFile(resolveReceiptInput(root, input)) === hash,
    );
  } catch {
    return false;
  }
}

export function authorizeOwnerGateEvidence(root, phase, itemId, rationale, approvalInput, inputs) {
  if (typeof rationale !== 'string' || !rationale.trim()) throw new Error('owner gate evidence requires a rationale');
  const normalizedRationale = rationale.trim();
  const { item, policy } = gateItem(root, phase, itemId);
  if (policy.authority !== 'OWNER') throw new Error(`${phase}/${itemId} does not accept OWNER authorization`);
  if (!explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.EVIDENCE)) throw new Error('explicit-owner policy is not active');
  const artifactInputs = normalizeEvidenceInputs(phase, item, inputs);
  const subjectInputs = ownerEvidenceSubjectInputs(phase, artifactInputs);
  readOwnerApproval(root, approvalInput, {
    action: OWNER_ACTIONS.EVIDENCE, phase, itemId, rationale: normalizedRationale, subjectInputs,
  });
  readRunForUpdate(root, phase);
  const receipt = writeGateReceipt(root, {
    type: item.receiptType,
    phase,
    result: 'PASSED',
    data: {
      approvalInput,
      itemId,
      producer: OWNER_EVIDENCE_PRODUCER,
      proofSchema: GATE_PROOF_SCHEMA,
      rationale: normalizedRationale,
    },
    inputs: [...subjectInputs, approvalInput],
  });
  updateRun(root, phase, itemId, 'RUN', receipt.id);
  return receipt;
}

function evidenceProblem(root, phase, item, receipt) {
  const policy = validateEvidencePolicy(phase, item);
  const expectedDataKeys = policy.authority === 'OWNER'
    ? ['approvalInput', 'itemId', 'producer', 'proofSchema', 'rationale']
    : ['itemId', 'producer', 'proofSchema'];
  if (!sameKeys(receipt.data, expectedDataKeys)) return `evidence ${receipt.id} has invalid proof data schema`;
  if (receipt.type !== item.receiptType) return `evidence ${receipt.id} has type ${receipt.type}; expected ${item.receiptType}`;
  if (receipt.phase !== phase) return `evidence ${receipt.id} has phase ${receipt.phase ?? '(none)'}; expected ${phase}`;
  if (receipt.result !== 'PASSED') return `evidence ${receipt.id} has non-passing result ${receipt.result ?? '(none)'}`;
  if (receipt.data.itemId !== item.id) return `evidence ${receipt.id} binds item ${String(receipt.data.itemId)}; expected ${item.id}`;
  if (receipt.data.proofSchema !== GATE_PROOF_SCHEMA) return `evidence ${receipt.id} has invalid proof schema`;

  const gateInput = `gates/${phase}.json`;
  const automaticInputs = [gateInput];
  if (policy.authority === 'SYSTEM') {
    if (receipt.data.producer !== GATE_EVIDENCE_PRODUCER) return `evidence ${receipt.id} has invalid producer`;
  } else {
    if (receipt.data.producer !== OWNER_EVIDENCE_PRODUCER) return `evidence ${receipt.id} has invalid owner producer`;
    if (typeof receipt.data.rationale !== 'string' || !receipt.data.rationale.trim()) return `evidence ${receipt.id} needs a nonempty owner rationale`;
    if (typeof receipt.data.approvalInput !== 'string') return `evidence ${receipt.id} has no owner approval input`;
    if (!explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.EVIDENCE)) return 'explicit-owner policy is not active';
    automaticInputs.push(POLICY_INPUT, receipt.data.approvalInput);
  }

  const inputKeys = Object.keys(receipt.inputHashes ?? {});
  if (!automaticInputs.every(input => inputKeys.includes(input))) {
    return `evidence ${receipt.id} does not bind its gate and authority policy`;
  }
  const artifacts = inputKeys.filter(input => !automaticInputs.includes(input));
  try {
    normalizeEvidenceInputs(phase, item, artifacts);
  } catch (error) {
    return `evidence ${receipt.id}: ${error.message}`;
  }
  if (!hasExactInputs(receipt, [...automaticInputs, ...artifacts])) {
    return `evidence ${receipt.id} has unexpected proof inputs`;
  }
  if (policy.authority === 'OWNER') {
    const subjectInputs = ownerEvidenceSubjectInputs(phase, artifacts);
    try {
      const approval = readOwnerApproval(root, receipt.data.approvalInput, {
        action: OWNER_ACTIONS.EVIDENCE,
        phase,
        itemId: item.id,
        rationale: receipt.data.rationale,
        subjectInputs,
      });
      const mismatch = approvalMatchesReceipt(approval, receipt, subjectInputs);
      if (mismatch) return `evidence ${receipt.id} ${mismatch}`;
    } catch (error) {
      return `evidence ${receipt.id} owner approval invalid: ${error.message}`;
    }
  }
  if (policy.authority === 'SYSTEM') {
    try {
      validateSystemEvidenceSemantics(root, phase, item.id, artifacts);
    } catch (error) {
      return `evidence ${receipt.id}: ${error.message}`;
    }
  }
  if (isStale(root, receipt)) return `evidence ${receipt.id} is STALE`;
  return null;
}

// Release readiness revalidates evidence receipts independently of a later gate result. Keeping
// this wrapper next to the evaluator makes that second use follow the exact gate semantics.
export function validateGateEvidenceReceipt(root, phase, itemId, receipt) {
  const { item } = gateItem(root, phase, itemId);
  return evidenceProblem(root, phase, item, receipt);
}

function notApplicableProblem(root, phase, item, authorization) {
  if (authorization.type !== OWNER_NOT_APPLICABLE_RECEIPT_TYPE) {
    return `owner authorization ${authorization.id} has type ${authorization.type}; expected ${OWNER_NOT_APPLICABLE_RECEIPT_TYPE}`;
  }
  if (authorization.phase !== phase) return `owner authorization ${authorization.id} has phase ${authorization.phase ?? '(none)'}; expected ${phase}`;
  if (authorization.result !== 'PASSED') return `owner authorization ${authorization.id} has non-passing result ${authorization.result ?? '(none)'}`;
  if (!sameKeys(authorization.data, ['approvalInput', 'itemId', 'producer', 'proofSchema', 'rationale'])) {
    return `owner authorization ${authorization.id} has invalid proof data schema`;
  }
  if (authorization.data.itemId !== item.id) return `owner authorization ${authorization.id} authorizes ${authorization.data.itemId ?? '(none)'}; expected ${item.id}`;
  if (authorization.data.producer !== OWNER_NOT_APPLICABLE_PRODUCER
      || authorization.data.proofSchema !== GATE_PROOF_SCHEMA) {
    return `owner authorization ${authorization.id} has invalid producer or proof schema`;
  }
  if (typeof authorization.data.rationale !== 'string' || !authorization.data.rationale.trim()) {
    return `owner authorization ${authorization.id} needs a nonempty owner rationale`;
  }
  if (!explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.NOT_APPLICABLE)) return 'explicit-owner policy is not active';
  const subjectInputs = [`gates/${phase}.json`, POLICY_INPUT].sort();
  try {
    const approval = readOwnerApproval(root, authorization.data.approvalInput, {
      action: OWNER_ACTIONS.NOT_APPLICABLE,
      phase,
      itemId: item.id,
      rationale: authorization.data.rationale,
      subjectInputs,
    });
    const mismatch = approvalMatchesReceipt(approval, authorization, subjectInputs);
    if (mismatch) return `owner authorization ${authorization.id} ${mismatch}`;
  } catch (error) {
    return `owner authorization ${authorization.id} approval invalid: ${error.message}`;
  }
  const expectedInputs = [...subjectInputs, authorization.data.approvalInput];
  if (!hasExactInputs(authorization, expectedInputs)) return `owner authorization ${authorization.id} does not bind its exact authority inputs`;
  if (isStale(root, authorization)) return `owner authorization ${authorization.id} is STALE`;
  return null;
}

function prerequisiteGateProblems(root, phase, receipt = null) {
  const phaseIndex = PHASES.indexOf(phase);
  const receipts = listReceipts(root);
  const receiptIndex = receipt === null
    ? null
    : receipts.findIndex(candidate => candidate.id === receipt.id);
  const problems = [];

  for (const prerequisite of PHASES.slice(0, phaseIndex)) {
    if (!existsSync(join(root, 'gates', `${prerequisite}.json`))) continue;
    const latestIndex = receipts.findLastIndex(
      candidate => candidate.type === 'gate' && candidate.phase === prerequisite,
    );
    if (latestIndex === -1) {
      problems.push(`prerequisite ${prerequisite} gate has no receipt`);
      continue;
    }
    const latest = receipts[latestIndex];
    if (!['PASSED', 'OVERRIDDEN'].includes(latest.result)) {
      problems.push(`prerequisite ${prerequisite} gate is ${latest.result ?? '(none)'} via ${latest.id}`);
      continue;
    }
    if (!isGateReceiptAuthoritative(root, latest)) {
      problems.push(`prerequisite ${prerequisite} gate is STALE via ${latest.id}`);
      continue;
    }
    if (receipt !== null && (receiptIndex === -1 || latestIndex >= receiptIndex)) {
      problems.push(`prerequisite ${prerequisite} gate was authorized after ${receipt.id}`);
    }
  }
  return problems;
}

function evaluateGate(root, phase, receipt = null) {
  const def = readGateDefinition(root, phase);
  const runPath = join(root, 'gates', 'runs', `${phase}.json`);
  const hasRunFile = existsSync(runPath);
  const run = readJson(runPath, { items: {} });
  if (!isPlainObject(run) || !isPlainObject(run.items)) {
    throw new Error(`gate run ${phase} must contain an items object`);
  }
  const receipts = listReceipts(root);
  const problems = prerequisiteGateProblems(root, phase, receipt);
  const evidenceInputs = new Set();
  for (const item of def.items) {
    const entry = run.items[item.id];
    if (!entry) { problems.push(`${item.id}: no status recorded`); continue; }
    if (!ITEM_STATUSES.includes(entry.status)) { problems.push(`${item.id}: invalid status ${entry.status}`); continue; }
    if (entry.status === 'ESCALATE') {
      problems.push(`${item.id}: escalated — resolve or override`);
      for (const input of item.evidencePolicy.requiredInputs) {
        try {
          resolveReceiptInput(root, input);
          evidenceInputs.add(input);
        } catch {
          problems.push(`${item.id}: required input ${input} is unavailable`);
        }
      }
    }
    if (entry.status === 'NOT_APPLICABLE') {
      const authorization = receipts.find(r => r.id === entry.receipt);
      if (!authorization) {
        problems.push(`${item.id}: owner authorization receipt ${entry.receipt ?? '(none)'} not found`);
      } else {
        evidenceInputs.add(`receipts/${authorization.id}.json`);
        const problem = notApplicableProblem(root, phase, item, authorization);
        if (problem) problems.push(`${item.id}: ${problem}`);
      }
    }
    if (entry.status === 'RUN' || entry.status === 'INHERITED') {
      const ev = receipts.find(r => r.id === entry.receipt);
      if (!ev) problems.push(`${item.id}: evidence receipt ${entry.receipt ?? '(none)'} not found`);
      else {
        evidenceInputs.add(`receipts/${ev.id}.json`);
        const problem = evidenceProblem(root, phase, item, ev);
        if (problem) problems.push(`${item.id}: ${problem}`);
      }
    }
  }
  const result = problems.length === 0 ? 'PASSED' : 'FAILED';
  const inputs = [
    `gates/${phase}.json`,
    ...(hasRunFile ? [`gates/runs/${phase}.json`] : []),
    ...evidenceInputs,
  ];
  return { def, problems, result, inputs };
}

export function checkGate(root, phase) {
  const evaluation = evaluateGate(root, phase);
  const receipt = writeGateReceipt(root, {
    type: 'gate', phase, result: evaluation.result,
    data: { gateVersion: evaluation.def.version, problems: evaluation.problems },
    inputs: evaluation.inputs,
  });
  return { result: evaluation.result, problems: evaluation.problems, receipt };
}

export function overrideGate(root, phase, rationale, approvalInput, rationalizationId = null) {
  if (typeof rationale !== 'string' || !rationale.trim()) throw new Error('override requires a rationale');
  const normalizedRationale = rationale.trim();
  if (!explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.OVERRIDE)) throw new Error('explicit-owner policy is not active');
  const prerequisiteProblems = prerequisiteGateProblems(root, phase);
  if (prerequisiteProblems.length > 0) {
    throw new Error(`cannot override ${phase} while ${prerequisiteProblems.join('; ')}`);
  }
  const evaluation = evaluateGate(root, phase);
  if (evaluation.result === 'PASSED') throw new Error(`cannot override passing ${phase} gate`);
  const subjectInputs = overrideApprovalSubjectInputs(root, evaluation, approvalInput);
  readOwnerApproval(root, approvalInput, {
    action: OWNER_ACTIONS.OVERRIDE, phase, itemId: null, rationale: normalizedRationale, subjectInputs,
  });
  return writeGateReceipt(root, {
    type: 'gate', phase, result: 'OVERRIDDEN',
    data: {
      gateVersion: evaluation.def.version,
      overriddenResult: evaluation.result,
      problems: evaluation.problems,
      approvalInput,
      rationale: normalizedRationale, rationalizationId,
      note: 'A rationalization ID explains a block; it never authorizes. Only the owner does.',
    },
    inputs: [...subjectInputs, approvalInput],
  });
}

export function authorizeNotApplicable(root, phase, itemId, rationale, approvalInput) {
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('NOT_APPLICABLE authorization requires an item id');
  if (typeof rationale !== 'string' || !rationale.trim()) throw new Error('NOT_APPLICABLE authorization requires an owner rationale');
  const normalizedRationale = rationale.trim();
  gateItem(root, phase, itemId);
  if (!explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.NOT_APPLICABLE)) throw new Error('explicit-owner policy is not active');
  const subjectInputs = [`gates/${phase}.json`, POLICY_INPUT].sort();
  readOwnerApproval(root, approvalInput, {
    action: OWNER_ACTIONS.NOT_APPLICABLE, phase, itemId, rationale: normalizedRationale, subjectInputs,
  });
  readRunForUpdate(root, phase);
  const receipt = writeGateReceipt(root, {
    type: OWNER_NOT_APPLICABLE_RECEIPT_TYPE,
    phase,
    result: 'PASSED',
    data: {
      approvalInput,
      itemId,
      producer: OWNER_NOT_APPLICABLE_PRODUCER,
      proofSchema: GATE_PROOF_SCHEMA,
      rationale: normalizedRationale,
    },
    inputs: [...subjectInputs, approvalInput],
  });
  updateRun(root, phase, itemId, 'NOT_APPLICABLE', receipt.id);
  return receipt;
}

function explicitOwnerPolicyIsActive(root, action) {
  try {
    const policy = readJson(join(root, POLICY_INPUT));
    const never = Array.isArray(policy.autonomy?.never) && policy.autonomy.never.includes(OWNER_NEVER);
    if (!never) return false;
    if (action === OWNER_ACTIONS.NOT_APPLICABLE) {
      return Array.isArray(policy.autonomy?.askFirst) && policy.autonomy.askFirst.includes(OWNER_ASK_FIRST);
    }
    if (action === OWNER_ACTIONS.TASK_DEFER) {
      return Array.isArray(policy.autonomy?.askFirst)
        && policy.autonomy.askFirst.includes(TASK_DEFER_ASK_FIRST);
    }
    if (action === OWNER_ACTIONS.OVERRIDE) {
      return Array.isArray(policy.protocol) && policy.protocol.includes(OWNER_OVERRIDE_POLICY);
    }
    return Array.isArray(policy.protocol) && policy.protocol.includes(OWNER_APPROVAL_POLICY);
  } catch {
    return false;
  }
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => typeof value === 'string' && value === expected[index]);
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every(value => typeof value === 'string' && expected.includes(value));
}

function hasExactInputs(receipt, expectedInputs) {
  const actual = Object.keys(receipt.inputHashes).sort();
  const expected = [...new Set(expectedInputs)].sort();
  return sameStringArray(actual, expected);
}

export function isGateReceiptAuthoritative(root, receipt) {
  if (!receipt || receipt.type !== 'gate' || typeof receipt.phase !== 'string') return false;
  if (!['PASSED', 'FAILED', 'OVERRIDDEN'].includes(receipt.result)) return false;
  const expectedDataKeys = receipt.result === 'OVERRIDDEN'
    ? ['approvalInput', 'gateVersion', 'note', 'overriddenResult', 'problems', 'rationale', 'rationalizationId']
    : ['gateVersion', 'problems'];
  if (!sameKeys(receipt.data, expectedDataKeys)) return false;
  let evaluation;
  try { evaluation = evaluateGate(root, receipt.phase, receipt); }
  catch { return false; }
  if (receipt.data?.gateVersion !== evaluation.def.version) return false;
  if (!sameStringArray(receipt.data?.problems, evaluation.problems)) return false;
  const authorityInputs = receipt.result === 'OVERRIDDEN'
    ? [receipt.data?.approvalInput]
    : [];
  if (authorityInputs.some(input => typeof input !== 'string')) return false;
  const overrideSubjects = receipt.result === 'OVERRIDDEN'
    ? overrideApprovalSubjectInputs(root, evaluation, receipt.data?.approvalInput)
    : [];
  const expectedInputs = receipt.result === 'OVERRIDDEN'
    ? [...overrideSubjects, ...authorityInputs]
    : evaluation.inputs;
  if (!hasExactInputs(receipt, expectedInputs)) return false;
  if (receipt.result === 'OVERRIDDEN' ? !hasCurrentDirectInputs(root, receipt) : isStale(root, receipt)) return false;
  if (receipt.result === 'OVERRIDDEN') {
    if (evaluation.result === 'PASSED'
        || receipt.data?.overriddenResult !== evaluation.result
        || typeof receipt.data?.rationale !== 'string'
        || !receipt.data.rationale.trim()
        || !explicitOwnerPolicyIsActive(root, OWNER_ACTIONS.OVERRIDE)) return false;
    try {
      const approval = readOwnerApproval(root, receipt.data.approvalInput, {
        action: OWNER_ACTIONS.OVERRIDE,
        phase: receipt.phase,
        itemId: null,
        rationale: receipt.data.rationale,
        subjectInputs: overrideSubjects,
      });
      if (approvalMatchesReceipt(approval, receipt, overrideSubjects)) return false;
    } catch {
      return false;
    }
    return true;
  }
  return receipt.result === evaluation.result;
}
