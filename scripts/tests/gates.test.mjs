import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, sha256, writeJson } from '../lib/util.mjs';
import { addReceipt, isStale, listReceipts } from '../lib/receipts.mjs';
import {
  authorizeNotApplicable, authorizeOwnerGateEvidence, checkGate, isGateReceiptAuthoritative,
  overrideGate, recordGateEvidence, validateTaskDeferralApproval,
  GATE_EVIDENCE_PRODUCER, GATE_PROOF_SCHEMA, OWNER_NOT_APPLICABLE_PRODUCER,
  OWNER_ACTIONS,
} from '../lib/gates.mjs';
import {
  overrideSubjectInputs, writeOwnerApproval as writeBoundOwnerApproval,
} from './helpers/owner-approval.mjs';
import { writeRawReceipt } from './helpers/raw-receipt.mjs';

const OWNER_NOT_APPLICABLE_RECEIPT_TYPE = 'owner-not-applicable-authorized';
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function proj() {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  writeJson(join(root, 'gates', 'spec.json'), {
    id: 'spec', version: 1,
    items: [{
      id: 'S1', text: 'requirements typed with stable IDs', receiptType: 'evidence',
      evidencePolicy: {
        authority: 'SYSTEM', requiredInputs: ['evidence.txt'], requiredPrefixes: [],
        allowedInputs: ['evidence.txt'], allowedPrefixes: [],
      },
    }],
    redFlags: [], rationalizations: [],
  });
  writeJson(join(root, 'policy', 'policy.json'), {
    protocol: [
      "Every gate is owner-overridable. An override needs the owner's explicit rationale and is recorded as a receipt. Nothing external to the owner may block this project.",
      "Approval semantics: only an unambiguous affirmative from the owner counts. Hedged responses ('looks reasonable', 'I guess') are not approval.",
    ],
    autonomy: {
      askFirst: ['Marking a gate item NOT_APPLICABLE', 'Terminally deferring a task'],
      never: ['Approve your own work on behalf of the owner'],
    },
  });
  return root;
}

function feasibilityEvidenceProject({ bindFinalInterfaces = true, compatible = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'v4-feasibility-'));
  const architecture = JSON.parse(readFileSync(join(projectRoot, 'gates', 'architecture.json'), 'utf8'));
  const feasibility = JSON.parse(readFileSync(join(projectRoot, 'gates', 'feasibility.json'), 'utf8'));
  writeJson(join(root, 'gates', 'architecture.json'), {
    ...architecture,
    items: [architecture.items.find(item => item.id === 'A2')],
  });
  writeJson(join(root, 'gates', 'feasibility.json'), {
    ...feasibility,
    items: [feasibility.items.find(item => item.id === 'F4')],
  });
  for (const input of [
    '.gitmodules',
    'architecture/interfaces.json',
    'architecture/provisional-interfaces.json',
    'bindings/robinhood-chain.json',
    'feasibility/cycle-control-model-results.json',
    'feasibility/cycle-control-survivability-bounds.json',
    'feasibility/interface-freeze.json',
    'feasibility/model-results.json',
    'packages/contracts/foundry.toml',
    'packages/contracts/remappings.txt',
    'product/dependency-pins.json',
    'specs/requirements.json',
  ]) {
    mkdirSync(dirname(join(root, input)), { recursive: true });
    cpSync(join(projectRoot, input), join(root, input));
  }
  const freezePath = join(root, 'feasibility', 'interface-freeze.json');
  const freeze = JSON.parse(readFileSync(freezePath, 'utf8'));
  for (const input of Object.keys(freeze.inputHashes)) {
    freeze.inputHashes[input] = `sha256:${hashFile(join(root, input))}`;
  }
  if (!compatible) {
    freeze.compatibilityVerdict.status = 'FAILED';
  }
  writeJson(freezePath, freeze);
  const architectureInputs = ['architecture/provisional-interfaces.json'];
  if (bindFinalInterfaces) {
    architectureInputs.push('architecture/interfaces.json', 'feasibility/interface-freeze.json');
  }
  recordGateEvidence(root, 'architecture', 'A2', architectureInputs);
  assert.equal(checkGate(root, 'architecture').result, 'PASSED');
  return root;
}

function integrationSpikeProject(integrationSpikes) {
  const root = mkdtempSync(join(tmpdir(), 'v4-integration-spikes-'));
  const feasibility = JSON.parse(readFileSync(join(projectRoot, 'gates', 'feasibility.json'), 'utf8'));
  writeJson(join(root, 'gates', 'feasibility.json'), {
    ...feasibility,
    items: [feasibility.items.find(item => item.id === 'F3')],
  });
  writeJson(join(root, 'feasibility', 'integration-spikes.json'), integrationSpikes);
  return root;
}

function moduleIndexProject() {
  const root = mkdtempSync(join(tmpdir(), 'v4-module-index-'));
  const architecture = JSON.parse(readFileSync(join(projectRoot, 'gates', 'architecture.json'), 'utf8'));
  writeJson(join(root, 'gates', 'architecture.json'), {
    ...architecture,
    items: [architecture.items.find(item => item.id === 'A6')],
  });
  const index = JSON.parse(readFileSync(join(projectRoot, 'docs', 'modules', 'index.json'), 'utf8'));
  cpSync(join(projectRoot, 'architecture', 'capability-map.json'), join(root, 'architecture', 'capability-map.json'));
  cpSync(join(projectRoot, 'specs', 'requirements.json'), join(root, 'specs', 'requirements.json'));
  writeJson(join(root, 'docs', 'modules', 'index.json'), index);
  for (const module of index.modules) {
    mkdirSync(dirname(join(root, module.path)), { recursive: true });
    cpSync(join(projectRoot, module.path), join(root, module.path));
  }
  return root;
}

function shipEvidenceProject(itemId) {
  const root = mkdtempSync(join(tmpdir(), 'v4-ship-evidence-'));
  const ship = JSON.parse(readFileSync(join(projectRoot, 'gates', 'ship.json'), 'utf8'));
  writeJson(join(root, 'gates', 'ship.json'), {
    ...ship,
    items: [ship.items.find(item => item.id === itemId)],
  });
  return root;
}

function taskDeferralFixture(root, overrides = {}) {
  const descriptorInput = 'decisions/task-deferrals/P1-011.json';
  const approvalInput = 'decisions/owner-approvals/p1-011-defer.json';
  const prestate = {
    id: 'P1-011',
    title: 'dashboard',
    phase: 'build',
    risk: 'ordinary',
    deps: ['P1-001'],
    reqs: ['REQ-dashboard-1'],
    status: 'done',
    leaseToken: 1,
    completionCommit: '1'.repeat(40),
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  writeJson(join(root, 'specs', 'requirements.json'), { revision: 55, requirements: [] });
  writeJson(join(root, 'decisions', 'ADR-0018-manual-one-cycle-phase-boundary.md'), { approved: true });
  writeJson(join(root, 'docs', 'superpowers', 'specs', '2026-08-31-manual-one-cycle-design.md'), { approved: true });
  const descriptor = {
    schema: 'v4-task-deferral-v1',
    action: 'TASK_DEFER',
    taskId: 'P1-011',
    phase: 'build',
    targetStatus: 'deferred',
    rationale: 'Dashboard deferred to Phase 2 by the owner-approved manual one-cycle scope',
    prestate,
    prestateFingerprint,
    requirements: {
      path: 'specs/requirements.json',
      revision: 55,
      sha256: hashFile(join(root, 'specs', 'requirements.json')),
    },
    decision: {
      path: 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md',
      sha256: hashFile(join(root, 'decisions', 'ADR-0018-manual-one-cycle-phase-boundary.md')),
    },
    design: {
      path: 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md',
      sha256: hashFile(join(root, 'docs', 'superpowers', 'specs', '2026-08-31-manual-one-cycle-design.md')),
    },
    ...overrides,
  };
  writeJson(join(root, descriptorInput), descriptor);
  writeBoundOwnerApproval(root, approvalInput, {
    action: OWNER_ACTIONS.TASK_DEFER,
    phase: descriptor.phase,
    itemId: descriptor.taskId,
    rationale: descriptor.rationale,
  }, ['policy/policy.json', descriptorInput]);
  return { descriptor, descriptorInput, approvalInput, prestate, prestateFingerprint };
}

function proofData(itemId = 'S1') {
  return { itemId, producer: GATE_EVIDENCE_PRODUCER, proofSchema: GATE_PROOF_SCHEMA };
}

function writeOwnerApproval(root, action, rationale, itemId = null, name = action.toLowerCase()) {
  const input = `decisions/owner-approvals/${name}.json`;
  const subjectInputs = action === 'GATE_OVERRIDE'
    ? overrideSubjectInputs(root, 'spec')
    : ['gates/spec.json', 'policy/policy.json'];
  return writeBoundOwnerApproval(root, input, {
    action, phase: 'spec', itemId, rationale,
  }, subjectInputs);
}

function ownerOverride(root, rationale) {
  const approval = writeOwnerApproval(root, 'GATE_OVERRIDE', rationale);
  return overrideGate(root, 'spec', rationale, approval);
}

test('task deferral approval binds policy, immutable descriptor, and exact prestate', () => {
  const root = proj();
  const fixture = taskDeferralFixture(root);

  const descriptor = validateTaskDeferralApproval(root, {
    taskId: 'P1-011',
    phase: 'build',
    rationale: fixture.descriptor.rationale,
    descriptorInput: fixture.descriptorInput,
    approvalInput: fixture.approvalInput,
    prestate: fixture.prestate,
    prestateFingerprint: fixture.prestateFingerprint,
  });

  assert.equal(descriptor.taskId, 'P1-011');
  assert.equal(descriptor.targetStatus, 'deferred');
  assert.equal(descriptor.prestateFingerprint, fixture.prestateFingerprint);
});

test('task deferral approval rejects stale policy, descriptor inputs, and task prestate', () => {
  const policyRoot = proj();
  const policyFixture = taskDeferralFixture(policyRoot);
  const policy = JSON.parse(readFileSync(join(policyRoot, 'policy/policy.json'), 'utf8'));
  policy.autonomy.askFirst = ['Marking a gate item NOT_APPLICABLE'];
  writeJson(join(policyRoot, 'policy/policy.json'), policy);
  assert.throws(
    () => validateTaskDeferralApproval(policyRoot, {
      taskId: 'P1-011', phase: 'build',
      rationale: policyFixture.descriptor.rationale,
      descriptorInput: policyFixture.descriptorInput,
      approvalInput: policyFixture.approvalInput,
      prestate: policyFixture.prestate,
      prestateFingerprint: policyFixture.prestateFingerprint,
    }),
    /task deferral owner policy is not active/,
  );

  const inputRoot = proj();
  const inputFixture = taskDeferralFixture(inputRoot);
  writeJson(join(inputRoot, inputFixture.descriptor.decision.path), { approved: false });
  assert.throws(
    () => validateTaskDeferralApproval(inputRoot, {
      taskId: 'P1-011', phase: 'build',
      rationale: inputFixture.descriptor.rationale,
      descriptorInput: inputFixture.descriptorInput,
      approvalInput: inputFixture.approvalInput,
      prestate: inputFixture.prestate,
      prestateFingerprint: inputFixture.prestateFingerprint,
    }),
    /decision hash does not match current content/,
  );

  const prestateRoot = proj();
  const prestateFixture = taskDeferralFixture(prestateRoot);
  assert.throws(
    () => validateTaskDeferralApproval(prestateRoot, {
      taskId: 'P1-011', phase: 'build',
      rationale: prestateFixture.descriptor.rationale,
      descriptorInput: prestateFixture.descriptorInput,
      approvalInput: prestateFixture.approvalInput,
      prestate: { ...prestateFixture.prestate, leaseToken: 2 },
      prestateFingerprint: sha256(Buffer.from(JSON.stringify({
        ...prestateFixture.prestate,
        leaseToken: 2,
      }))),
    }),
    /descriptor prestate fingerprint does not match current task/,
  );
});

test('task deferral approval rejects malformed descriptors and wrong approval action', () => {
  const descriptorRoot = proj();
  const descriptorFixture = taskDeferralFixture(descriptorRoot, { unexpected: true });
  assert.throws(
    () => validateTaskDeferralApproval(descriptorRoot, {
      taskId: 'P1-011', phase: 'build',
      rationale: descriptorFixture.descriptor.rationale,
      descriptorInput: descriptorFixture.descriptorInput,
      approvalInput: descriptorFixture.approvalInput,
      prestate: descriptorFixture.prestate,
      prestateFingerprint: descriptorFixture.prestateFingerprint,
    }),
    /task deferral descriptor must contain exactly/,
  );

  const approvalRoot = proj();
  const approvalFixture = taskDeferralFixture(approvalRoot);
  writeBoundOwnerApproval(approvalRoot, approvalFixture.approvalInput, {
    action: OWNER_ACTIONS.EVIDENCE,
    phase: 'build',
    itemId: 'P1-011',
    rationale: approvalFixture.descriptor.rationale,
  }, ['policy/policy.json', approvalFixture.descriptorInput]);
  assert.throws(
    () => validateTaskDeferralApproval(approvalRoot, {
      taskId: 'P1-011', phase: 'build',
      rationale: approvalFixture.descriptor.rationale,
      descriptorInput: approvalFixture.descriptorInput,
      approvalInput: approvalFixture.approvalInput,
      prestate: approvalFixture.prestate,
      prestateFingerprint: approvalFixture.prestateFingerprint,
    }),
    /owner approval has action GATE_EVIDENCE; expected TASK_DEFER/,
  );
});

test('init gate declares the exact receipt type for every item', () => {
  const init = JSON.parse(readFileSync(new URL('../../gates/init.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(init.items.map(item => [item.id, item.receiptType])),
    {
      I1: 'prd-written',
      I2: 'owner-cleanroom-baseline-approved',
      I3: 'measurable-success-criteria-verified',
      I4: 'domain-pack-validated',
      I5: 'dependency-pin',
      I6: 'cleanroom-project-policy-generated',
    },
  );
});

test('every later gate item declares its stable exact receipt type', () => {
  const expected = {
    spec: {
      S1: 'typed-requirements-verified',
      S2: 'functional-edge-cases-verified',
      S3: 'architecture-decisions-recorded',
      S4: 'scope-boundaries-recorded',
      S5: 'owner-spec-approved',
    },
    architecture: {
      A1: 'capability-map-verified',
      A2: 'provisional-interfaces-verified',
      A3: 'failure-modes-operationalized',
      A4: 'risk-classes-defined',
      A5: 'trust-boundaries-reviewed',
      A6: 'module-contracts-created',
    },
    feasibility: {
      F1: 'scenario-model-run',
      F2: 'owner-survivability-bounds-approved',
      F3: 'integration-spikes-verified',
      F4: 'interfaces-frozen',
      F5: 'risk-lane-escalation-verified',
    },
    redteam: {
      R1: 'doubt-loop-review-run',
      R2: 'review-findings-classified',
      R3: 'critical-findings-resolved',
      R4: 'doubt-loop-termination-verified',
      R5: 'threat-pass-completed',
    },
    tasks: {
      T1: 'task-requirements-bound',
      T2: 'task-dependency-dag-verified',
      T3: 'task-risk-ordering-verified',
      T4: 'task-context-packs-verified',
      T5: 'task-projection-trace-verified',
    },
    build: {
      B1: 'task-ledger-complete',
      B2: 'build-trace-verified',
      B3: 'module-contracts-updated',
      B4: 'owner-spec-revision-approved',
      B5: 'review-evidence-verified',
      B6: 'task-commit-integrity-verified',
    },
    ship: {
      H1: 'release-state-verified',
      H2: 'alert-runbooks-test-fired',
      H3: 'induced-failure-drill-verified',
      H4: 'owner-advisories-reviewed',
      H5: 'operations-handoff-complete',
    },
  };

  for (const [phase, receiptTypes] of Object.entries(expected)) {
    const definition = JSON.parse(readFileSync(new URL(`../../gates/${phase}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(
      Object.fromEntries(definition.items.map(item => [item.id, item.receiptType])),
      receiptTypes,
      phase,
    );
  }
});

test('architecture A2 can bind the post-feasibility interface freeze on recheck', () => {
  const architecture = JSON.parse(
    readFileSync(new URL('../../gates/architecture.json', import.meta.url), 'utf8'),
  );
  const policy = architecture.items.find(item => item.id === 'A2').evidencePolicy;

  assert.deepEqual(policy.requiredInputs, ['architecture/provisional-interfaces.json']);
  assert.deepEqual(policy.allowedInputs, [
    'architecture/provisional-interfaces.json',
    'architecture/interfaces.json',
    'feasibility/interface-freeze.json',
  ]);
});

test('architecture A6 accepts the provisional Phase 3 module index and binds every card', () => {
  const root = moduleIndexProject();
  const receipt = recordGateEvidence(root, 'architecture', 'A6', ['docs/modules/index.json']);
  const index = JSON.parse(readFileSync(join(root, 'docs', 'modules', 'index.json'), 'utf8'));
  assert.equal(index.productPhase, 3);
  assert.equal(index.requirementsRevision, 65);
  assert.equal(index.architectureRevision, 9);
  assert.equal(index.interfaceStatus, 'PROVISIONAL');
  const expectedInputs = [
    'gates/architecture.json',
    'architecture/capability-map.json',
    'docs/modules/index.json',
    'specs/requirements.json',
    ...index.modules.map(module => module.path),
  ].sort();

  assert.deepEqual(Object.keys(receipt.inputHashes).sort(), expectedInputs);
  assert.equal(checkGate(root, 'architecture').result, 'PASSED');

  writeFileSync(join(root, index.modules[0].path), '# Tampered module\n');
  assert.equal(checkGate(root, 'architecture').result, 'FAILED');
});

test('architecture A6 rejects a module index with a false card digest', () => {
  const root = moduleIndexProject();
  const indexPath = join(root, 'docs', 'modules', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.modules[0].sha256 = '0'.repeat(64);
  writeJson(indexPath, index);

  assert.throws(
    () => recordGateEvidence(root, 'architecture', 'A6', ['docs/modules/index.json']),
    /module index digest mismatch/,
  );
  assert.deepEqual(listReceipts(root), []);
});

test('architecture A6 rejects reduced module sets and stale revision bindings', () => {
  const reducedRoot = moduleIndexProject();
  const reducedPath = join(reducedRoot, 'docs', 'modules', 'index.json');
  const reduced = JSON.parse(readFileSync(reducedPath, 'utf8'));
  reduced.modules.shift();
  writeJson(reducedPath, reduced);
  assert.throws(
    () => recordGateEvidence(reducedRoot, 'architecture', 'A6', ['docs/modules/index.json']),
    /module set must match the capability map/,
  );

  const staleRoot = moduleIndexProject();
  const stalePath = join(staleRoot, 'docs', 'modules', 'index.json');
  const stale = JSON.parse(readFileSync(stalePath, 'utf8'));
  stale.requirementsRevision += 1;
  writeJson(stalePath, stale);
  assert.throws(
    () => recordGateEvidence(staleRoot, 'architecture', 'A6', ['docs/modules/index.json']),
    /revision binding does not match current architecture and requirements/,
  );
});

test('architecture A6 rejects symlink aliases and non-semantic headings', () => {
  const symlinkRoot = moduleIndexProject();
  const symlinkIndexPath = join(symlinkRoot, 'docs', 'modules', 'index.json');
  const symlinkIndex = JSON.parse(readFileSync(symlinkIndexPath, 'utf8'));
  const aliased = symlinkIndex.modules[0];
  const target = symlinkIndex.modules[1];
  rmSync(join(symlinkRoot, aliased.path));
  symlinkSync(`${target.id}.md`, join(symlinkRoot, aliased.path));
  aliased.sha256 = hashFile(join(symlinkRoot, target.path));
  writeJson(symlinkIndexPath, symlinkIndex);
  assert.throws(
    () => recordGateEvidence(symlinkRoot, 'architecture', 'A6', ['docs/modules/index.json']),
    /must be a unique regular file, not a symlink or alias/,
  );

  const headingRoot = moduleIndexProject();
  const headingIndexPath = join(headingRoot, 'docs', 'modules', 'index.json');
  const headingIndex = JSON.parse(readFileSync(headingIndexPath, 'utf8'));
  const module = headingIndex.modules[0];
  const fakeCard = `# Phase Boundary\n\n\`\`\`md\n${headingIndex.requiredSections.map(section => `## ${section}`).join('\n')}\n\`\`\`\n`;
  writeFileSync(join(headingRoot, module.path), fakeCard);
  module.sha256 = hashFile(join(headingRoot, module.path));
  writeJson(headingIndexPath, headingIndex);
  assert.throws(
    () => recordGateEvidence(headingRoot, 'architecture', 'A6', ['docs/modules/index.json']),
    /must have its exact title and ordered nonempty sections/,
  );

  const longFenceRoot = moduleIndexProject();
  const longFenceIndexPath = join(longFenceRoot, 'docs', 'modules', 'index.json');
  const longFenceIndex = JSON.parse(readFileSync(longFenceIndexPath, 'utf8'));
  const fencedModule = longFenceIndex.modules[0];
  const fencedSections = longFenceIndex.requiredSections
    .map(section => `## ${section}\nnot real module documentation`)
    .join('\n');
  const longFenceCard = `# Phase Boundary\n\n\`\`\`\`md\n\`\`\`\n${fencedSections}\n\`\`\`\`\n`;
  writeFileSync(join(longFenceRoot, fencedModule.path), longFenceCard);
  fencedModule.sha256 = hashFile(join(longFenceRoot, fencedModule.path));
  writeJson(longFenceIndexPath, longFenceIndex);
  assert.throws(
    () => recordGateEvidence(longFenceRoot, 'architecture', 'A6', ['docs/modules/index.json']),
    /must have its exact title and ordered nonempty sections/,
  );
});

test('architecture A6 rejects non-exact index schema and interface status', () => {
  const root = moduleIndexProject();
  const indexPath = join(root, 'docs', 'modules', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.interfaceStatus = 'FROZEN';
  index.unexpected = true;
  writeJson(indexPath, index);

  assert.throws(
    () => recordGateEvidence(root, 'architecture', 'A6', ['docs/modules/index.json']),
    /invalid schema or interface status/,
  );
});

test('feasibility gate binds the revision 57 cycle-control model and per-cycle bounds', () => {
  const feasibility = JSON.parse(
    readFileSync(new URL('../../gates/feasibility.json', import.meta.url), 'utf8'),
  );
  const byId = new Map(feasibility.items.map((item) => [item.id, item]));

  assert.equal(feasibility.version, 4);
  assert.deepEqual(byId.get('F1').evidencePolicy.requiredInputs, [
    'feasibility/cycle-control-model.mjs',
    'feasibility/cycle-control-model-results.json',
    'specs/requirements.json',
  ]);
  assert.deepEqual(byId.get('F2').evidencePolicy.requiredInputs, [
    'feasibility/cycle-control-survivability-bounds.json',
  ]);
  assert.match(byId.get('F1').text, /revision 57 cycle-control/i);
  assert.match(byId.get('F2').text, /per-cycle/i);
});

test('feasibility F3 rejects an artifact that explicitly says F3 must not pass', () => {
  const root = integrationSpikeProject({
    schemaVersion: 'hookemon.integration-spikes.v2',
    overallStatus: 'BLOCKED_PRODUCTION',
    gateDisposition: 'Required live integration proof is unresolved. F3 must not pass.',
    spikes: [{ id: 'SPIKE-LIVE', status: 'BLOCKED_PENDING_LIVE_PROOF' }],
    waivers: [],
    blockingFacts: ['The live provider path is unproven.'],
  });

  assert.throws(
    () => recordGateEvidence(root, 'feasibility', 'F3', ['feasibility/integration-spikes.json']),
    /feasibility\/F3 cannot pass/,
  );
  assert.deepEqual(listReceipts(root), []);
});

test('feasibility F3 does not treat an artifact-authored waiver as owner authority', () => {
  const root = integrationSpikeProject({
    schemaVersion: 'hookemon.integration-spikes.v2',
    overallStatus: 'PASSED',
    gateDisposition: 'F3 PASSED',
    spikes: [{ id: 'SPIKE-LIVE', status: 'UNRESOLVED' }],
    waivers: [{ spikeId: 'SPIKE-LIVE', authority: 'OWNER' }],
    blockingFacts: [],
  });

  assert.throws(
    () => recordGateEvidence(root, 'feasibility', 'F3', ['feasibility/integration-spikes.json']),
    /SYSTEM evidence cannot grant or consume owner waivers/,
  );
  assert.deepEqual(listReceipts(root), []);
});

test('feasibility F3 rejects pass-like status prefixes and incomplete schemas', () => {
  const root = integrationSpikeProject({
    overallStatus: 'READY',
    spikes: [{ id: 'fake', status: 'PASSED_NOT_ACTUALLY_RUN' }],
  });

  assert.throws(
    () => recordGateEvidence(root, 'feasibility', 'F3', ['feasibility/integration-spikes.json']),
    /exact v2 schema and passing disposition/,
  );
  assert.deepEqual(listReceipts(root), []);
});

test('feasibility F3 accepts only the exact completed SYSTEM evidence shape', () => {
  const root = integrationSpikeProject({
    schemaVersion: 'hookemon.integration-spikes.v2',
    overallStatus: 'PASSED',
    gateDisposition: 'F3 PASSED',
    spikes: [{ id: 'SPIKE-LIVE', status: 'PASSED' }],
    waivers: [],
    blockingFacts: [],
  });

  const receipt = recordGateEvidence(
    root,
    'feasibility',
    'F3',
    ['feasibility/integration-spikes.json'],
  );

  assert.equal(receipt.result, 'PASSED');
});

test('feasibility gate check rejects forged F3 evidence for blocked spikes', () => {
  const root = integrationSpikeProject({
    schemaVersion: 'hookemon.integration-spikes.v2',
    overallStatus: 'BLOCKED_PRODUCTION',
    gateDisposition: 'F3 must not pass.',
    spikes: [{ id: 'SPIKE-LIVE', status: 'BLOCKED_PENDING_LIVE_PROOF' }],
    waivers: [],
    blockingFacts: ['The live provider path is unproven.'],
  });
  const evidence = writeRawReceipt(root, {
    type: 'integration-spikes-verified',
    phase: 'feasibility',
    result: 'PASSED',
    data: proofData('F3'),
    inputs: ['gates/feasibility.json', 'feasibility/integration-spikes.json'],
  });
  writeJson(join(root, 'gates', 'runs', 'feasibility.json'), {
    items: { F3: { status: 'RUN', receipt: evidence.id } },
  });

  const checked = checkGate(root, 'feasibility');

  assert.equal(checked.result, 'FAILED');
  assert.match(checked.problems.join('\n'), /feasibility\/F3 cannot pass/);
});

test('feasibility F4 rejects an internally incompatible build-only freeze', () => {
  const root = feasibilityEvidenceProject({ compatible: false });

  assert.throws(
    () => recordGateEvidence(root, 'feasibility', 'F4', [
      'architecture/interfaces.json',
      'feasibility/interface-freeze.json',
    ]),
    /feasibility\/F4 interface freeze invalid: architecture compatibility re-check failed/,
  );
});

test('feasibility gate check rejects forged F4 evidence for an incompatible freeze', () => {
  const root = feasibilityEvidenceProject({ compatible: false });
  const evidence = writeRawReceipt(root, {
    type: 'interfaces-frozen',
    phase: 'feasibility',
    result: 'PASSED',
    data: proofData('F4'),
    inputs: [
      'gates/feasibility.json',
      'architecture/interfaces.json',
      'feasibility/interface-freeze.json',
    ],
  });
  writeJson(join(root, 'gates', 'runs', 'feasibility.json'), {
    items: { F4: { status: 'RUN', receipt: evidence.id } },
  });

  const checked = checkGate(root, 'feasibility');

  assert.equal(checked.result, 'FAILED');
  assert.match(checked.problems.join('\n'), /interface freeze invalid/);
});

test('feasibility F4 requires the latest architecture gate to bind the final freeze transitively', () => {
  const root = feasibilityEvidenceProject({ bindFinalInterfaces: false });

  assert.throws(
    () => recordGateEvidence(root, 'feasibility', 'F4', [
      'architecture/interfaces.json',
      'feasibility/interface-freeze.json',
    ]),
    /latest authoritative architecture gate receipt does not bind architecture\/interfaces\.json and feasibility\/interface-freeze\.json/,
  );
});

test('feasibility F4 accepts the current fail-closed build-only freeze after architecture recheck', () => {
  const root = feasibilityEvidenceProject();

  const evidence = recordGateEvidence(root, 'feasibility', 'F4', [
    'architecture/interfaces.json',
    'feasibility/interface-freeze.json',
  ]);

  assert.equal(evidence.result, 'PASSED');
});

test('unrelated SYSTEM gate evidence keeps the generic recording behavior', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'generic system evidence');

  const evidence = recordGateEvidence(root, 'spec', 'S1', ['evidence.txt']);

  assert.equal(evidence.result, 'PASSED');
});

test('ship H3 rejects an unstructured induced-failure claim', () => {
  const root = shipEvidenceProject('H3');
  writeJson(join(root, 'qa', 'drills', 'induced-failure.json'), {});

  assert.throws(
    () => recordGateEvidence(root, 'ship', 'H3', ['qa/drills/induced-failure.json']),
    /ship\/H3 induced-failure evidence is invalid/,
  );
});

test('ship H5 rejects a handoff without fail-closed local operations guidance', () => {
  const root = shipEvidenceProject('H5');
  mkdirSync(join(root, 'ops'), { recursive: true });
  writeFileSync(join(root, 'ops', 'HANDOFF.md'), '# Operations\n\nEverything is operating.\n');

  assert.throws(
    () => recordGateEvidence(root, 'ship', 'H5', ['ops/HANDOFF.md']),
    /ship\/H5 operations handoff is invalid/,
  );
});

test('ship H3 and H5 accept the current local-only drill and handoff', () => {
  const h3Root = shipEvidenceProject('H3');
  mkdirSync(join(h3Root, 'qa', 'drills'), { recursive: true });
  cpSync(
    join(projectRoot, 'qa', 'drills', 'induced-failure.json'),
    join(h3Root, 'qa', 'drills', 'induced-failure.json'),
  );
  assert.equal(
    recordGateEvidence(h3Root, 'ship', 'H3', ['qa/drills/induced-failure.json']).result,
    'PASSED',
  );

  const h5Root = shipEvidenceProject('H5');
  mkdirSync(join(h5Root, 'ops'), { recursive: true });
  cpSync(join(projectRoot, 'ops', 'HANDOFF.md'), join(h5Root, 'ops', 'HANDOFF.md'));
  assert.equal(recordGateEvidence(h5Root, 'ship', 'H5', ['ops/HANDOFF.md']).result, 'PASSED');
});

test('task and build gates distinguish active work from owner-deferred exclusions', () => {
  const tasks = JSON.parse(readFileSync(new URL('../../gates/tasks.json', import.meta.url), 'utf8'));
  const build = JSON.parse(readFileSync(new URL('../../gates/build.json', import.meta.url), 'utf8'));

  assert.equal(
    tasks.items.find(item => item.id === 'T1').text,
    'Every active ledger task binds at least one known REQ id and names a verification command; every excluded task is explicitly owner-deferred',
  );
  assert.equal(
    build.items.find(item => item.id === 'B1').text,
    'Every active ledger task is done; every excluded task is explicitly owner-deferred; no live leases; merge queue empty (no queued or retest rows)',
  );
});

test('arbitrary empty receipts cannot satisfy any later gate', () => {
  for (const phase of ['spec', 'architecture', 'feasibility', 'redteam', 'tasks', 'build', 'ship']) {
    const root = proj();
    const definition = JSON.parse(readFileSync(new URL(`../../gates/${phase}.json`, import.meta.url), 'utf8'));
    writeJson(join(root, 'gates', `${phase}.json`), { ...definition, items: [definition.items[0]] });
    const empty = writeRawReceipt(root, { type: definition.items[0].receiptType, phase });
    writeJson(join(root, 'gates', 'runs', `${phase}.json`), {
      items: { [definition.items[0].id]: { status: 'RUN', receipt: empty.id } },
    });

    const { result, problems } = checkGate(root, phase);

    assert.equal(result, 'FAILED', phase);
    assert.match(problems.join('\n'), /invalid proof data schema/, phase);
  }
});

test('gate rejects evidence with the wrong receipt type', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'requirements list');
  const ev = addReceipt(root, {
    type: 'wrong-evidence', phase: 'spec', result: 'PASSED', data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: { S1: { status: 'RUN', receipt: ev.id } } });

  const { result, problems } = checkGate(root, 'spec');

  assert.equal(result, 'FAILED');
  assert.deepEqual(problems, ['S1: evidence r-00001 has type wrong-evidence; expected evidence']);
});

test('gate rejects evidence from another phase or with a failed result', () => {
  const wrongPhaseRoot = proj();
  writeFileSync(join(wrongPhaseRoot, 'evidence.txt'), 'requirements list');
  const wrongPhase = writeRawReceipt(wrongPhaseRoot, {
    type: 'evidence',
    phase: 'init',
    result: 'PASSED',
    data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(wrongPhaseRoot, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: wrongPhase.id } },
  });
  assert.deepEqual(
    checkGate(wrongPhaseRoot, 'spec').problems,
    ['S1: evidence r-00001 has phase init; expected spec'],
  );

  const failedRoot = proj();
  writeFileSync(join(failedRoot, 'evidence.txt'), 'requirements list');
  const failed = writeRawReceipt(failedRoot, {
    type: 'evidence',
    phase: 'spec',
    result: 'FAILED',
    data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(failedRoot, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: failed.id } },
  });
  assert.deepEqual(
    checkGate(failedRoot, 'spec').problems,
    ['S1: evidence r-00001 has non-passing result FAILED'],
  );
});

test('gate fails when items are unrecorded, passes with fresh evidence', () => {
  const root = proj();
  assert.equal(checkGate(root, 'spec').result, 'FAILED');
  writeFileSync(join(root, 'evidence.txt'), 'requirements list');
  const ev = recordGateEvidence(root, 'spec', 'S1', ['evidence.txt']);
  const { result, receipt } = checkGate(root, 'spec');
  assert.equal(result, 'PASSED');
  assert.equal(receipt.type, 'gate');
  assert.match(receipt.inputHashes[`receipts/${ev.id}.json`], /^[0-9a-f]{64}$/);
});

test('stale evidence fails the gate; override records rationale', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'v1');
  recordGateEvidence(root, 'spec', 'S1', ['evidence.txt']);
  writeFileSync(join(root, 'evidence.txt'), 'v2');
  const { result, problems } = checkGate(root, 'spec');
  assert.equal(result, 'FAILED');
  assert.match(problems[0], /STALE/);
  const o = ownerOverride(root, 'owner accepts risk for demo');
  assert.equal(o.result, 'OVERRIDDEN');
  assert.throws(() => overrideGate(root, 'spec', '', 'missing.json'));
});

test('override binds the evaluated run and referenced evidence transitively', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'v1');
  const ev = writeRawReceipt(root, {
    type: 'evidence', phase: 'spec', result: 'FAILED', data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: ev.id } },
  });
  const override = ownerOverride(root, 'Owner accepts this exact failed evaluation.');
  assert.equal(override.result, 'OVERRIDDEN');
  assert.match(override.inputHashes['gates/runs/spec.json'], /^[0-9a-f]{64}$/);
  assert.match(override.inputHashes[`receipts/${ev.id}.json`], /^[0-9a-f]{64}$/);

  writeFileSync(join(root, 'evidence.txt'), 'v2');
  assert.equal(isStale(root, override), true);
});

test('override becomes stale when the evaluated run changes', () => {
  const root = proj();
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'ESCALATE' } },
  });
  const override = ownerOverride(root, 'Owner accepts this exact escalation.');

  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: 'r-99999' } },
  });

  assert.equal(isStale(root, override), true);
});

test('override binds required inputs for escalated gate items', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'v1');
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'ESCALATE' } },
  });
  const override = ownerOverride(root, 'Owner accepts this exact escalation evidence.');

  assert.match(override.inputHashes['evidence.txt'], /^[0-9a-f]{64}$/);

  writeFileSync(join(root, 'evidence.txt'), 'v2');
  assert.equal(isStale(root, override), true);
});

test('owner gate evidence approval cannot replay after an approved artifact changes', () => {
  const root = proj();
  const definition = JSON.parse(readFileSync(join(root, 'gates', 'spec.json'), 'utf8'));
  definition.items[0].evidencePolicy.authority = 'OWNER';
  writeJson(join(root, 'gates', 'spec.json'), definition);
  writeFileSync(join(root, 'evidence.txt'), 'approved v1');
  const rationale = 'Owner approves this exact evidence.';
  const approval = writeBoundOwnerApproval(
    root,
    'decisions/owner-approvals/evidence-replay.json',
    { action: 'GATE_EVIDENCE', phase: 'spec', itemId: 'S1', rationale },
    ['gates/spec.json', 'policy/policy.json', 'evidence.txt'],
  );
  authorizeOwnerGateEvidence(root, 'spec', 'S1', rationale, approval, ['evidence.txt']);

  writeFileSync(join(root, 'evidence.txt'), 'attacker replacement');

  assert.throws(
    () => authorizeOwnerGateEvidence(root, 'spec', 'S1', rationale, approval, ['evidence.txt']),
    /subject hash for evidence\.txt does not match current content/,
  );
});

test('owner evidence receipt hash must equal the approval subject hash', () => {
  const root = proj();
  const definition = JSON.parse(readFileSync(join(root, 'gates', 'spec.json'), 'utf8'));
  definition.items[0].evidencePolicy.authority = 'OWNER';
  writeJson(join(root, 'gates', 'spec.json'), definition);
  writeFileSync(join(root, 'evidence.txt'), 'approved bytes');
  const rationale = 'Owner approves this exact evidence.';
  const approval = writeBoundOwnerApproval(
    root,
    'decisions/owner-approvals/receipt-mismatch.json',
    { action: 'GATE_EVIDENCE', phase: 'spec', itemId: 'S1', rationale },
    ['gates/spec.json', 'policy/policy.json', 'evidence.txt'],
  );
  const evidence = authorizeOwnerGateEvidence(
    root, 'spec', 'S1', rationale, approval, ['evidence.txt'],
  );
  const receiptPath = join(root, 'receipts', `${evidence.id}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.inputHashes['evidence.txt'] = '0'.repeat(64);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const checked = checkGate(root, 'spec');

  assert.equal(checked.result, 'FAILED');
  assert.match(checked.problems.join('\n'), /receipt hash for evidence\.txt does not match its owner approval subject hash/);
});

test('owner override approval cannot replay after the evaluated evidence closure changes', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'approved v1');
  const evidence = writeRawReceipt(root, {
    type: 'evidence', phase: 'spec', result: 'FAILED', data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: evidence.id } },
  });
  const rationale = 'Owner accepts this exact failed evaluation.';
  const approval = writeBoundOwnerApproval(
    root,
    'decisions/owner-approvals/override-replay.json',
    { action: 'GATE_OVERRIDE', phase: 'spec', itemId: null, rationale },
    overrideSubjectInputs(root, 'spec'),
  );
  overrideGate(root, 'spec', rationale, approval);

  writeFileSync(join(root, 'evidence.txt'), 'attacker replacement');

  assert.throws(
    () => overrideGate(root, 'spec', rationale, approval),
    /subject hash for evidence\.txt does not match current content/,
  );
});

test('an override of stale evidence is authoritative when approval binds the current closure', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'recorded v1');
  const evidence = writeRawReceipt(root, {
    type: 'evidence', phase: 'spec', result: 'PASSED', data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: evidence.id } },
  });
  writeFileSync(join(root, 'evidence.txt'), 'current stale bytes');
  const rationale = 'Owner accepts this exact stale evidence evaluation.';
  const approval = writeBoundOwnerApproval(
    root,
    'decisions/owner-approvals/stale-override.json',
    { action: 'GATE_OVERRIDE', phase: 'spec', itemId: null, rationale },
    overrideSubjectInputs(root, 'spec'),
  );

  const override = overrideGate(root, 'spec', rationale, approval);

  assert.equal(isGateReceiptAuthoritative(root, override), true);
});

test('an override binds missing nested input absence and expires when the path appears', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'recorded bytes');
  const evidence = writeRawReceipt(root, {
    type: 'evidence', phase: 'spec', result: 'PASSED', data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt'],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: evidence.id } },
  });
  rmSync(join(root, 'evidence.txt'));
  const rationale = 'Owner accepts this exact missing-artifact evaluation.';
  const approval = writeBoundOwnerApproval(
    root,
    'decisions/owner-approvals/missing-artifact-override.json',
    { action: 'GATE_OVERRIDE', phase: 'spec', itemId: null, rationale },
    overrideSubjectInputs(root, 'spec'),
  );

  const override = overrideGate(root, 'spec', rationale, approval);

  assert.equal(isGateReceiptAuthoritative(root, override), true);
  writeFileSync(join(root, 'evidence.txt'), 'newly appeared bytes');
  assert.equal(isGateReceiptAuthoritative(root, override), false);
});

test('override subjects exclude the new approval even when failed evidence references its path', () => {
  const root = proj();
  const approval = 'decisions/owner-approvals/self-reference-override.json';
  writeFileSync(join(root, 'evidence.txt'), 'recorded bytes');
  writeJson(join(root, approval), { placeholder: true });
  const evidence = writeRawReceipt(root, {
    type: 'evidence', phase: 'spec', result: 'PASSED', data: proofData(),
    inputs: ['gates/spec.json', 'evidence.txt', approval],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'RUN', receipt: evidence.id } },
  });
  const rationale = 'Owner accepts this exact malformed evidence evaluation.';
  writeBoundOwnerApproval(
    root,
    approval,
    { action: 'GATE_OVERRIDE', phase: 'spec', itemId: null, rationale },
    overrideSubjectInputs(root, 'spec', approval),
  );

  const override = overrideGate(root, 'spec', rationale, approval);

  assert.equal(isGateReceiptAuthoritative(root, override), true);
  assert.match(override.inputHashes[approval], /^[0-9a-f]{64}$/);
});

test('NOT_APPLICABLE approval cannot replay after its gate definition changes', () => {
  const root = proj();
  const rationale = 'Owner confirms this exact item does not apply.';
  const approval = writeBoundOwnerApproval(
    root,
    'decisions/owner-approvals/not-applicable-replay.json',
    { action: 'NOT_APPLICABLE', phase: 'spec', itemId: 'S1', rationale },
    ['gates/spec.json', 'policy/policy.json'],
  );
  authorizeNotApplicable(root, 'spec', 'S1', rationale, approval);
  const definition = JSON.parse(readFileSync(join(root, 'gates', 'spec.json'), 'utf8'));
  writeJson(join(root, 'gates', 'spec.json'), { ...definition, version: definition.version + 1 });

  assert.throws(
    () => authorizeNotApplicable(root, 'spec', 'S1', rationale, approval),
    /subject hash for gates\/spec\.json does not match current content/,
  );
});

test('NOT_APPLICABLE fails without dedicated owner authorization', () => {
  const root = proj();
  writeJson(join(root, 'gates', 'runs', 'spec.json'), {
    items: { S1: { status: 'NOT_APPLICABLE' } },
  });

  const { result, problems } = checkGate(root, 'spec');

  assert.equal(result, 'FAILED');
  assert.match(problems.join('\n'), /owner authorization receipt \(none\) not found/);
});

test('NOT_APPLICABLE rejects malformed, unbound, and stale owner authorization', () => {
  const cases = [
    { name: 'wrong type', changes: { type: 'evidence' }, problem: /has type evidence; expected owner-not-applicable-authorized/ },
    { name: 'wrong phase', changes: { phase: 'init' }, problem: /has phase init; expected spec/ },
    { name: 'wrong item', data: { itemId: 'S2' }, problem: /authorizes S2; expected S1/ },
    { name: 'blank rationale', data: { rationale: '   ' }, problem: /needs a nonempty owner rationale/ },
    { name: 'non-passing result', changes: { result: null }, problem: /has non-passing result \(none\)/ },
    { name: 'unbound gate definition', inputs: 'unbound', problem: /receipt hash for gates\/spec\.json does not match its owner approval subject hash/ },
  ];

  for (const c of cases) {
    const root = proj();
    const rationale = 'owner decision';
    const approval = writeOwnerApproval(root, 'NOT_APPLICABLE', rationale, 'S1', `case-${c.name.replaceAll(' ', '-')}`);
    const data = {
      approvalInput: approval,
      itemId: 'S1',
      producer: OWNER_NOT_APPLICABLE_PRODUCER,
      proofSchema: GATE_PROOF_SCHEMA,
      rationale,
      ...c.data,
    };
    const authorization = writeRawReceipt(root, {
      type: OWNER_NOT_APPLICABLE_RECEIPT_TYPE,
      phase: 'spec',
      result: 'PASSED',
      data,
      inputs: c.inputs === 'unbound'
        ? ['policy/policy.json', approval]
        : ['gates/spec.json', 'policy/policy.json', approval],
      ...c.changes,
    });
    writeJson(join(root, 'gates', 'runs', 'spec.json'), {
      items: { S1: { status: 'NOT_APPLICABLE', receipt: authorization.id } },
    });

    const { result, problems } = checkGate(root, 'spec');

    assert.equal(result, 'FAILED', c.name);
    assert.match(problems.join('\n'), c.problem, c.name);
  }

  const staleRoot = proj();
  const staleRationale = 'owner decision';
  const staleApproval = writeOwnerApproval(staleRoot, 'NOT_APPLICABLE', staleRationale, 'S1', 'stale');
  authorizeNotApplicable(staleRoot, 'spec', 'S1', staleRationale, staleApproval);
  const definition = JSON.parse(readFileSync(join(staleRoot, 'gates', 'spec.json'), 'utf8'));
  writeJson(join(staleRoot, 'gates', 'spec.json'), { ...definition, version: definition.version + 1 });

  const { result, problems } = checkGate(staleRoot, 'spec');

  assert.equal(result, 'FAILED');
  assert.match(problems.join('\n'), /approval invalid: owner approval subject hash for gates\/spec\.json does not match current content/);
});

test('NOT_APPLICABLE passes with fresh item-bound owner authorization', () => {
  const root = proj();
  const rationale = 'Owner confirms this item does not apply.';
  const approval = writeOwnerApproval(root, 'NOT_APPLICABLE', rationale, 'S1');
  const authorization = authorizeNotApplicable(root, 'spec', 'S1',
    rationale, approval);

  const { result, receipt } = checkGate(root, 'spec');

  assert.equal(result, 'PASSED');
  assert.match(authorization.inputHashes['policy/policy.json'], /^[0-9a-f]{64}$/);
  assert.match(authorization.inputHashes[approval], /^[0-9a-f]{64}$/);
  assert.match(receipt.inputHashes[`receipts/${authorization.id}.json`], /^[0-9a-f]{64}$/);
});

test('NOT_APPLICABLE validates the run before creating an append-only receipt', () => {
  const root = proj();
  const rationale = 'Owner confirms S1 does not apply.';
  const approval = writeOwnerApproval(root, 'NOT_APPLICABLE', rationale, 'S1');
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: null });

  assert.throws(
    () => authorizeNotApplicable(root, 'spec', 'S1', rationale, approval),
    /must contain an items object/,
  );
  assert.deepEqual(listReceipts(root), []);
});
