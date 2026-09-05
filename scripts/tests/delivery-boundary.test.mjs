import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDeliveryBoundary } from '../check-delivery-boundary.mjs';
import { hashFile, sha256 } from '../lib/util.mjs';
import { writeOwnerApproval } from './helpers/owner-approval.mjs';

const here = join(import.meta.dirname, '..', '..');
const futurePath = 'future/PHASE_2_OWNER_DECISIONS.md';

function writeJson(root, file, value) {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-delivery-boundary-'));
  writeJson(root, 'specs/requirements.json', {
    revision: 1,
    requirements: [{ id: 'REQ-CORE-1', title: 'Core constraint' }],
  });
  writeJson(root, 'product/dependency-pins.json', {
    controlRuntime: { node: '24.19.0' },
  });
  writeJson(root, 'gates/release.json', {
    id: 'release', version: 1, items: [{ id: 'RG-1', text: 'release evidence exists' }],
  });
  writeJson(root, 'receipts/r-00001.json', {
    id: 'r-00001', at: '2026-08-30T00:00:00.000Z', type: 'evidence', phase: 'init', result: 'PASSED',
    data: {}, inputHashes: {},
  });
  writeJson(root, 'product/delivery-boundary.json', {
    schemaVersion: 1,
    openDeliveryPhase: 1,
    phases: { '1': 'OPEN', '2': 'CLOSED', '3': 'CLOSED' },
    operationalRoots: ['specs', 'interfaces', 'bindings', 'tasks', 'gates'],
    registries: [
      { id: 'requirements', sources: [{ file: 'specs/requirements.json', recordsAt: '/requirements', recordIdProperty: 'id' }] },
      { id: 'tasks', sources: [{ file: 'tasks.json', recordsAt: '/tasks', recordIdProperty: 'id', optional: true }] },
      { id: 'interfaces', sources: [{ file: 'interfaces/index.json', recordsAt: '/interfaces', recordIdProperty: 'id', optional: true }] },
      { id: 'product-dependencies', sources: [{ file: 'product/dependency-pins.json', records: [{ recordId: 'DEP-node-runtime', pointer: '/controlRuntime/node' }] }] },
      { id: 'bindings', sources: [{ file: 'bindings/index.json', recordsAt: '/bindings', recordIdProperty: 'id', optional: true }] },
      { id: 'release-gates', sources: [{ file: 'gates/release.json', recordsAt: '/items', recordIdProperty: 'id' }] },
    ],
    sidecars: [
      { recordId: 'requirements:REQ-CORE-1', deliveryPhase: 1 },
      { recordId: 'product-dependencies:DEP-node-runtime', deliveryPhase: 1 },
      { recordId: 'release-gates:RG-1', deliveryPhase: 1 },
    ],
  });
  return root;
}

function validDeferredTask(root, taskId = 'P1-011') {
  const rationale = 'Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope';
  writeJson(root, 'policy/policy.json', {
    autonomy: { askFirst: ['Terminally deferring a task'], never: ['Approve your own work on behalf of the owner'] },
  });
  writeJson(root, 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md', { approved: true });
  writeJson(root, 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md', { approved: true });
  const prestate = {
    id: taskId, title: 'dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: ['REQ-CORE-1'],
    status: 'ready', leaseToken: 0, completionCommit: null,
  };
  const descriptorInput = `decisions/task-deferrals/${taskId}.json`;
  const approvalInput = `decisions/owner-approvals/${taskId.toLowerCase()}-defer.json`;
  writeJson(root, descriptorInput, {
    schema: 'v4-task-deferral-v1', action: 'TASK_DEFER', taskId, phase: 'build',
    targetStatus: 'deferred', rationale, prestate,
    prestateFingerprint: sha256(Buffer.from(JSON.stringify(prestate))),
    requirements: { path: 'specs/requirements.json', revision: 1, sha256: hashFile(join(root, 'specs/requirements.json')) },
    decision: { path: 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md', sha256: hashFile(join(root, 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md')) },
    design: { path: 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md', sha256: hashFile(join(root, 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md')) },
  });
  writeOwnerApproval(root, approvalInput, { action: 'TASK_DEFER', phase: 'build', itemId: taskId, rationale }, ['policy/policy.json', descriptorInput]);
  return {
    id: taskId, title: 'dashboard', phase: 'build', risk: 'ordinary', deps: [], reqs: ['REQ-CORE-1'], status: 'deferred',
    deferApproval: approvalInput, deferDescriptor: descriptorInput,
    deferPrestateFingerprint: sha256(Buffer.from(JSON.stringify(prestate))),
  };
}

function errors(root) {
  return checkDeliveryBoundary(root).errors.join('\n');
}

test('accepts regular Phase 1 records and treats receipts as non-operative inputs', () => {
  const root = fixture();
  const result = checkDeliveryBoundary(root);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.receiptsChecked, 1);
});

test('keeps the active dashboard deferred while revision 56 corrects Phase 1 custody', () => {
  const prd = readFileSync(join(here, 'product', 'PRD.md'), 'utf8');
  const proposal = readFileSync(join(here, 'product', 'REQUIREMENTS_REVISION_56_PROPOSAL.md'), 'utf8');

  assert.match(prd, /dashboard and UI are deferred to Phase 2/i);
  assert.match(proposal, /Requirements revision 56/);
  assert.match(proposal, /PegCycleVault/);
});

test('requires sidecars for active tasks but excludes owner-deferred tasks', () => {
  const root = fixture();
  writeJson(root, 'tasks.json', {
    tasks: [
      { id: 'P1-010', status: 'ready' },
      { id: 'P1-012', status: 'done' },
      validDeferredTask(root),
    ],
  });
  const boundary = join(root, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(boundary));
  doc.sidecars.push(
    { recordId: 'tasks:P1-010', deliveryPhase: 1 },
    { recordId: 'tasks:P1-012', deliveryPhase: 1 },
  );
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);

  assert.equal(checkDeliveryBoundary(root).ok, true, errors(root));

  doc.sidecars.push({ recordId: 'tasks:P1-011', deliveryPhase: 1 });
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(root), /unknown sidecar.*tasks:P1-011/i);

  doc.sidecars = doc.sidecars.filter(sidecar => sidecar.recordId !== 'tasks:P1-010');
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(root), /missing sidecar.*tasks:P1-010/i);
});

test('registers an owner-deferred task card without an active sidecar', () => {
  const root = fixture();
  writeJson(root, 'tasks.json', { tasks: [validDeferredTask(root)] });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'tasks/P1-011.md'), '# Deferred dashboard\n');

  const result = checkDeliveryBoundary(root);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('rejects deferred tasks without valid owner authority', () => {
  const root = fixture();
  const deferred = validDeferredTask(root);
  deferred.deferApproval = 'decisions/owner-approvals/missing.json';
  writeJson(root, 'tasks.json', { tasks: [deferred] });
  assert.match(errors(root), /deferred task P1-011 authority invalid/i);
});

test('rejects valid-looking owner authority for non-dashboard deferred tasks', () => {
  const root = fixture();
  writeJson(root, 'tasks.json', { tasks: [validDeferredTask(root, 'P1-010')] });
  assert.match(errors(root), /deferred task P1-010 authority invalid/i);
});

test('accepts Phase 2 records only when Phase 2 is the active delivery phase', () => {
  const root = fixture();
  const boundary = join(root, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(boundary));
  doc.openDeliveryPhase = 2;
  doc.phases = { '1': 'COMPLETE', '2': 'OPEN', '3': 'CLOSED' };
  doc.sidecars[0].deliveryPhase = 2;
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.equal(checkDeliveryBoundary(root).ok, true, errors(root));

  doc.sidecars[0].deliveryPhase = 3;
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(root), /REQ-CORE-1.*closed delivery phase 3/i);
});

test('rejects missing, duplicate, and unknown record classifications', () => {
  const root = fixture();
  const boundary = join(root, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(boundary));
  doc.sidecars = [
    { recordId: 'requirements:REQ-CORE-1', deliveryPhase: 1 },
    { recordId: 'requirements:REQ-CORE-1', deliveryPhase: 1 },
    { recordId: 'UNKNOWN-RECORD', deliveryPhase: 1 },
  ];
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  const found = errors(root);
  assert.match(found, /duplicate sidecar.*requirements:REQ-CORE-1/i);
  assert.match(found, /missing sidecar.*product-dependencies:DEP-node-runtime/i);
  assert.match(found, /unknown sidecar.*UNKNOWN-RECORD/i);
});

test('rejects unregistered normative files in operational roots', () => {
  const root = fixture();
  writeFileSync(join(root, 'specs/PHASE_2_EXECUTION_TASK.md'), '# not classified\n');
  assert.match(errors(root), /unregistered normative file specs\/PHASE_2_EXECUTION_TASK\.md/i);
});

test('registers task cards through the canonical context-pack index', () => {
  const root = fixture();
  writeJson(root, 'tasks.json', {
    tasks: [{ id: 'P1-001', title: 'Freeze contract' }],
  });
  writeJson(root, 'tasks/context-packs.json', {
    cards: [{ id: 'P1-001', path: 'tasks/P1-001.md' }],
  });
  writeFileSync(join(root, 'tasks/P1-001.md'), '# P1-001\n');
  const boundary = join(root, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(boundary));
  doc.registries.find(registry => registry.id === 'tasks').sources.push({
    file: 'tasks/context-packs.json',
    records: [{ recordId: 'context-packs', pointer: '/cards' }],
  });
  doc.sidecars.push(
    { recordId: 'tasks:P1-001', deliveryPhase: 1 },
    { recordId: 'tasks:context-packs', deliveryPhase: 1 },
  );
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  const result = checkDeliveryBoundary(root);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('rejects a context-pack card path that does not match its task id', () => {
  const root = fixture();
  writeJson(root, 'tasks.json', {
    tasks: [{ id: 'P1-001', title: 'Freeze contract' }],
  });
  writeJson(root, 'tasks/context-packs.json', {
    cards: [{ id: 'P1-001', path: 'tasks/OTHER.md' }],
  });
  writeFileSync(join(root, 'tasks/OTHER.md'), '# Wrong card\n');
  const boundary = join(root, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(boundary));
  doc.registries.find(registry => registry.id === 'tasks').sources.push({
    file: 'tasks/context-packs.json',
    records: [{ recordId: 'context-packs', pointer: '/cards' }],
  });
  doc.sidecars.push(
    { recordId: 'tasks:P1-001', deliveryPhase: 1 },
    { recordId: 'tasks:context-packs', deliveryPhase: 1 },
  );
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(root), /task context pack P1-001 has an invalid card path/i);
});

test('rejects unregistered normative gate files', () => {
  const root = fixture();
  writeJson(root, 'gates/PHASE_2_RELEASE.json', { id: 'phase-2', items: [] });
  assert.match(errors(root), /unregistered normative file gates\/PHASE_2_RELEASE\.json/i);
});

test('rejects source paths that are not regular repo-internal paths', () => {
  for (const file of ['/tmp/x.json', '../specs/requirements.json', 'specs\\requirements.json', 'specs/../../x.json']) {
    const root = fixture();
    const boundary = join(root, 'product/delivery-boundary.json');
    const doc = JSON.parse(readFile(boundary));
    doc.registries[0].sources[0].file = file;
    writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
    assert.match(errors(root), /source path must be a regular repo-internal path/i, file);
  }

  const fileLinkRoot = fixture();
  const fileLink = join(fileLinkRoot, 'specs/requirements.json');
  writeJson(fileLinkRoot, 'outside.json', { requirements: [{ id: 'REQ-CORE-1' }] });
  unlinkSync(fileLink);
  symlinkSync(join(fileLinkRoot, 'outside.json'), fileLink);
  assert.match(errors(fileLinkRoot), /source path must be a regular repo-internal path/i);

  const directoryLinkRoot = fixture();
  symlinkSync(join(directoryLinkRoot, 'specs'), join(directoryLinkRoot, 'linked-specs'));
  const boundary = join(directoryLinkRoot, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(boundary));
  doc.registries[0].sources[0].file = 'linked-specs/requirements.json';
  writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(directoryLinkRoot), /source path must be a regular repo-internal path/i);
});

test('requires the exact complete operational root list', () => {
  for (const roots of [[], ['specs', 'interfaces', 'bindings', 'tasks'], ['specs', 'interfaces', 'bindings', 'tasks', 'gates', 'gates']]) {
    const root = fixture();
    const boundary = join(root, 'product/delivery-boundary.json');
    const doc = JSON.parse(readFile(boundary));
    doc.operationalRoots = roots;
    writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
    assert.match(errors(root), /operationalRoots must exactly list/i);
  }
});

test('allows an empty regular .gitkeep in an operational root', () => {
  const root = fixture();
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'tasks/.gitkeep'), '');
  const result = checkDeliveryBoundary(root);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('rejects noncanonical .gitkeep entries in operational roots', () => {
  const nonempty = fixture();
  mkdirSync(join(nonempty, 'tasks'), { recursive: true });
  writeFileSync(join(nonempty, 'tasks/.gitkeep'), 'not empty\n');
  assert.match(errors(nonempty), /operational root tasks \.gitkeep must be an empty regular repo-internal file/i);

  const linked = fixture();
  mkdirSync(join(linked, 'tasks'), { recursive: true });
  writeFileSync(join(linked, 'outside.txt'), '');
  symlinkSync(join(linked, 'outside.txt'), join(linked, 'tasks/.gitkeep'));
  assert.match(errors(linked), /operational root tasks \.gitkeep must be an empty regular repo-internal file/i);

  const special = fixture();
  mkdirSync(join(special, 'tasks/.gitkeep'), { recursive: true });
  assert.match(errors(special), /operational root tasks \.gitkeep must be an empty regular repo-internal file/i);
});

test('rejects an operational start root that is a directory symlink', () => {
  const root = fixture();
  const external = mkdtempSync(join(tmpdir(), 'hookemon-delivery-boundary-external-'));
  symlinkSync(external, join(root, 'tasks'));
  assert.match(errors(root), /operational root tasks must be a regular directory/i);
});

test('rejects a receipt root that is a directory symlink', () => {
  const root = fixture();
  const external = mkdtempSync(join(tmpdir(), 'hookemon-delivery-boundary-receipts-'));
  writeJson(external, 'r-00001.json', JSON.parse(readFile(join(root, 'receipts/r-00001.json'))));
  rmSync(join(root, 'receipts'), { recursive: true });
  symlinkSync(external, join(root, 'receipts'));
  assert.match(errors(root), /receipt root must be a regular repo-internal directory/i);
});

test('rejects a delivery boundary file that is a symlink', () => {
  const root = fixture();
  const boundary = join(root, 'product/delivery-boundary.json');
  const external = mkdtempSync(join(tmpdir(), 'hookemon-delivery-boundary-file-'));
  writeFileSync(join(external, 'delivery-boundary.json'), readFile(boundary));
  unlinkSync(boundary);
  symlinkSync(join(external, 'delivery-boundary.json'), boundary);
  assert.match(errors(root), /delivery boundary must be a regular repo-internal file/i);
});

test('requires a canonical receipt .gitkeep when it exists', () => {
  const root = fixture();
  writeFileSync(join(root, 'receipts/.gitkeep'), 'not empty\n');
  assert.match(errors(root), /receipt \.gitkeep must be an empty regular file/i);
});

test('rejects a registered record without a stable id', () => {
  const root = fixture();
  const requirements = join(root, 'specs/requirements.json');
  const doc = JSON.parse(readFile(requirements));
  delete doc.requirements[0].id;
  writeFileSync(requirements, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(root), /requirements record has a missing or invalid stable id/i);
});

test('rejects an open operational record that references the future decision', () => {
  const root = fixture();
  const requirements = join(root, 'specs/requirements.json');
  const doc = JSON.parse(readFile(requirements));
  doc.requirements[0].reference = futurePath;
  writeFileSync(requirements, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(root), /REQ-CORE-1.*future.*reference/i);
});

test('rejects singular and plural future-reference fields recursively', () => {
  for (const field of ['input', 'inputs', 'source', 'sources', 'dependency', 'dependencies', 'reference', 'references', 'path', 'paths']) {
    const root = fixture();
    const requirements = join(root, 'specs/requirements.json');
    const doc = JSON.parse(readFile(requirements));
    doc.requirements[0].nested = { [field]: [futurePath] };
    writeFileSync(requirements, `${JSON.stringify(doc, null, 2)}\n`);
    assert.match(errors(root), new RegExp(`REQ-CORE-1.*future.*${field}`, 'i'), field);
  }
});

test('rejects unknown keys and non-exclusive delivery-boundary schema forms', () => {
  const cases = [
    { mutate: doc => { doc.unexpected = true; }, error: /delivery boundary has unknown key/i },
    { mutate: doc => { doc.phases.extra = 'CLOSED'; }, error: /delivery boundary phase map has unknown key/i },
    { mutate: doc => { doc.registries[0].unexpected = true; }, error: /registry requirements has unknown key/i },
    { mutate: doc => { doc.registries[0].sources[0].optional = 'true'; }, error: /source specs\/requirements\.json optional must be a boolean/i },
    { mutate: doc => { doc.registries[0].sources[0].records = {}; }, error: /source specs\/requirements\.json records must be an array/i },
    { mutate: doc => { doc.registries[0].sources[0].records = []; }, error: /source specs\/requirements\.json must use exactly one record form/i },
    { mutate: doc => { doc.registries[3].sources[0].records[0].unexpected = true; }, error: /static record DEP-node-runtime has unknown key/i },
    { mutate: doc => { doc.sidecars[0].unexpected = true; }, error: /sidecar requirements:REQ-CORE-1 has unknown key/i },
  ];
  for (const { mutate, error } of cases) {
    const root = fixture();
    const boundary = join(root, 'product/delivery-boundary.json');
    const doc = JSON.parse(readFile(boundary));
    mutate(doc);
    writeFileSync(boundary, `${JSON.stringify(doc, null, 2)}\n`);
    assert.match(errors(root), error);
  }
});

test('requires canonical consecutive regular receipt files with exact schemas', () => {
  const badSchema = fixture();
  const receipt = join(badSchema, 'receipts/r-00001.json');
  const doc = JSON.parse(readFile(receipt));
  doc.unexpected = true;
  writeFileSync(receipt, `${JSON.stringify(doc, null, 2)}\n`);
  assert.match(errors(badSchema), /receipt r-00001 has unknown key unexpected/i);

  const gap = fixture();
  renameSync(join(gap, 'receipts/r-00001.json'), join(gap, 'receipts/r-00002.json'));
  assert.match(errors(gap), /receipt sequence must contain r-00001/i);

  const linked = fixture();
  const linkedReceipt = join(linked, 'receipts/r-00001.json');
  writeJson(linked, 'receipt-target.json', JSON.parse(readFile(linkedReceipt)));
  unlinkSync(linkedReceipt);
  symlinkSync(join(linked, 'receipt-target.json'), linkedReceipt);
  assert.match(errors(linked), /receipt r-00001\.json must be a regular file/i);
});

test('accepts an open Phase 3 boundary and rejects malformed or unsupported phases', () => {
  const root = fixture();
  const boundary = join(root, 'product/delivery-boundary.json');
  writeFileSync(boundary, '{not json\n');
  assert.match(errors(root), /malformed delivery boundary/i);

  const phaseThree = fixture();
  const phaseThreeBoundary = join(phaseThree, 'product/delivery-boundary.json');
  const doc = JSON.parse(readFile(phaseThreeBoundary));
  doc.openDeliveryPhase = 3;
  doc.phases = { '1': 'COMPLETE', '2': 'COMPLETE', '3': 'OPEN' };
  doc.sidecars = doc.sidecars.map((sidecar) => ({ ...sidecar, deliveryPhase: 3 }));
  writeFileSync(phaseThreeBoundary, `${JSON.stringify(doc, null, 2)}\n`);
  assert.equal(checkDeliveryBoundary(phaseThree).ok, true, errors(phaseThree));

  const unsupported = fixture();
  const unsupportedBoundary = join(unsupported, 'product/delivery-boundary.json');
  const unsupportedDoc = JSON.parse(readFile(unsupportedBoundary));
  unsupportedDoc.openDeliveryPhase = 4;
  unsupportedDoc.phases = { '1': 'COMPLETE', '2': 'COMPLETE', '3': 'CLOSED', '4': 'OPEN' };
  writeFileSync(unsupportedBoundary, `${JSON.stringify(unsupportedDoc, null, 2)}\n`);
  assert.match(errors(unsupported), /openDeliveryPhase must be 1, 2, or 3/i);
});

test('classifies every machine-effective Phase 1 pin including the frozen build toolchain', () => {
  const pins = JSON.parse(readFile(join(here, 'product/dependency-pins.json')));
  const boundary = JSON.parse(readFile(join(here, 'product/delivery-boundary.json')));
  const dependencyRegistry = boundary.registries.find(registry => registry.id === 'product-dependencies');
  const expectedRecords = [
    { recordId: 'DEP-control-runtime', pointer: '/controlRuntime' },
    { recordId: 'DEP-base-pack', pointer: '/contentAddresses/basePack' },
    { recordId: 'DEP-workflow', pointer: '/contentAddresses/workflow' },
    { recordId: 'DEP-action-checkout', pointer: '/contentAddresses/githubActions/actions~1checkout' },
    { recordId: 'DEP-gitleaks', pointer: '/securityTools/gitleaks' },
    { recordId: 'DEP-phase1-toolchain', pointer: '/phase1Toolchain' },
  ];

  assert.deepEqual(dependencyRegistry.sources, [{
    file: 'product/dependency-pins.json',
    records: expectedRecords,
  }]);
  assert.deepEqual(
    boundary.sidecars.filter(sidecar => sidecar.recordId.startsWith('product-dependencies:')),
    expectedRecords.map(record => ({
      recordId: `product-dependencies:${record.recordId}`,
      deliveryPhase: 1,
    })),
  );
  assert.equal(pins.phase1Toolchain.status, 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING');
  assert.equal(pins.phase1Toolchain.requirementsRevision, 56);
  assert.equal(pins.phase1Toolchain.architectureRevision, 4);
  assert.equal(pins.phase1Toolchain.robinhood.chainId, 4663);
  assert.equal(
    pins.phase1Toolchain.bindingManifest.manifestDigest,
    '97280c263a0e238c447e73ae12d176ff4bcfb6653cb2ca84df26f575f47b7861',
  );
  assert.equal(expectedRecords.some(record => record.pointer === '/phase1Toolchain'), true);
});

test('the current tree exposes a revision-bound unsigned P1-011 renewal and rejects it as authority', () => {
  const descriptorPath = 'decisions/task-deferrals/P1-011-revision-65-rebind-DRAFT.json';
  const approvalPath = 'decisions/owner-approvals/phase-3-revision-65-dashboard-deferral-DRAFT_UNSIGNED.json';
  const descriptor = JSON.parse(readFileSync(join(here, descriptorPath), 'utf8'));
  const approval = JSON.parse(readFileSync(join(here, approvalPath), 'utf8'));

  assert.equal(descriptor.requirements.revision, 65);
  assert.equal(descriptor.requirements.sha256, hashFile(join(here, 'specs/requirements.json')));
  assert.equal(approval.draftStatus, 'UNSIGNED_DRAFT_PENDING_OWNER_SIGNATURE');
  assert.match(approval.approvalToken, /^DRAFT_UNSIGNED/);
  assert.match(descriptor.rationale, /The current task CLI cannot rebind an already deferred entry/);
  assert.match(descriptor.rationale, /owner signature is necessary but not sufficient/);
  assert.deepEqual(approval.subjectHashes, {
    [descriptorPath]: hashFile(join(here, descriptorPath)),
    'policy/policy.json': hashFile(join(here, 'policy/policy.json')),
  });

  // The task projection still points at the revision-58 signed authority. The unsigned draft
  // records the required owner action but cannot authorize the deferred state.
  const result = checkDeliveryBoundary(here);
  assert.deepEqual(result.errors, [
    'deferred task P1-011 renewal pending owner signature and an owner-authorized deferred-task rebind path for requirements revision 65',
  ]);
  assert.equal(result.ok, false);
});

function readFile(path) {
  return readFileSync(path, 'utf8');
}
