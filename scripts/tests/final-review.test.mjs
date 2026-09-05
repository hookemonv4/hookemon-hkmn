import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as receiptModule from '../lib/receipts.mjs';
import { openLedger, addTask, claimTask, completeTask, projectTasks } from '../lib/ledger.mjs';
import { projectState } from '../lib/state.mjs';
import { taskEvidenceContext, traceCheck } from '../lib/reqs.mjs';
import { writeJson } from '../lib/util.mjs';
import {
  approvalSubjectHashes, overrideSubjectInputs,
  writeOwnerApproval as writeBoundOwnerApproval,
} from './helpers/owner-approval.mjs';
import { copyTrackedProjectFiles } from './helpers/tracked-project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', '..');
const { addReceipt, listReceipts } = receiptModule;

test('Phase 3 topology keeps dashboard controls separate from live authority', () => {
  const topology = readFileSync(join(templateRoot, 'architecture', 'execution-topology.md'), 'utf8');
  const dashboard = readFileSync(join(templateRoot, 'docs', 'modules', 'dashboard.md'), 'utf8');

  assert.match(topology, /^# Product Phase 3 Execution Topology$/m);
  assert.match(topology, /requirements revision `65` and architecture revision `9`/);
  assert.match(topology, /does not authorize deployment, signing, broadcasting, spending, or publication/);
  assert.match(topology, /`repairMergeEligible` reports code and integration readiness only/);
  assert.match(dashboard, /authoritative Phase 3 status/);
  assert.match(dashboard, /never signs, broadcasts, deploys, spends, moves custody/);
});

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v4-final-review-')));
  copyTrackedProjectFiles(templateRoot, root);
  rmSync(join(root, 'receipts'), { recursive: true, force: true });
  rmSync(join(root, '.v4'), { recursive: true, force: true });
  mkdirSync(join(root, 'receipts'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
}

function v4Result(root, ...args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'v4.mjs'), ...args], {
    cwd: root, encoding: 'utf8',
  });
}

function v4(root, ...args) {
  const result = v4Result(root, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function writeOwnerApproval(root, name, fields) {
  const path = `decisions/owner-approvals/${name}.json`;
  const subjectInputs = fields.action === 'GATE_OVERRIDE'
    ? overrideSubjectInputs(root, fields.phase)
    : fields.subjectInputs ?? [`gates/${fields.phase}.json`, 'policy/policy.json'];
  return writeBoundOwnerApproval(root, path, fields, subjectInputs);
}

function readModuleContract(name) {
  const path = join(templateRoot, 'docs', 'modules', `${name}.md`);
  assert.equal(existsSync(path), true, `${name} module contract must exist`);
  const contract = readFileSync(path, 'utf8');
  for (const heading of [
    'Purpose', 'Public interface', 'Invariants', 'State transitions', 'Operational commands', 'Recovery pointers',
  ]) {
    assert.match(contract, new RegExp(`^## ${heading}$`, 'm'), `${name}: ${heading}`);
  }
  return contract;
}

test('every gate item declares a fail-closed evidence policy', () => {
  for (const phase of ['init', 'spec', 'architecture', 'feasibility', 'redteam', 'tasks', 'build', 'ship']) {
    const definition = JSON.parse(readFileSync(join(templateRoot, 'gates', `${phase}.json`), 'utf8'));
    for (const item of definition.items) {
      assert.deepEqual(Object.keys(item.evidencePolicy).sort(), [
        'allowedInputs', 'allowedPrefixes', 'authority', 'requiredInputs', 'requiredPrefixes',
      ]);
      assert.ok(['SYSTEM', 'OWNER'].includes(item.evidencePolicy.authority));
      for (const key of ['allowedInputs', 'allowedPrefixes', 'requiredInputs', 'requiredPrefixes']) {
        assert.ok(Array.isArray(item.evidencePolicy[key]), `${phase}/${item.id} ${key}`);
      }
      assert.ok(item.evidencePolicy.requiredInputs.length + item.evidencePolicy.requiredPrefixes.length > 0,
        `${phase}/${item.id} must require an artifact`);
    }
  }
});

test('init I6 binds the exact current control surface without mutable projections', () => {
  const excludedFromInitControlSurface = new Set([
    'scripts/tests/phase1-release.test.mjs',
    'scripts/tests/phase1-reproducibility.test.mjs',
    'scripts/tests/fork-pin.test.mjs',
    'scripts/verify-phase1-release.mjs',
    'scripts/verify-phase1-reproducibility.mjs',
    'scripts/release/build-local-candidate.mjs',
  ]);
  function filesUnder(relativeDirectory, extension) {
    return readdirSync(join(templateRoot, relativeDirectory), { withFileTypes: true })
      .flatMap(entry => {
        const path = `${relativeDirectory}/${entry.name}`;
        if (entry.isDirectory()) return filesUnder(path, extension);
        return entry.isFile() && path.endsWith(extension) ? [path] : [];
      });
  }

  const gateDefinitions = readdirSync(join(templateRoot, 'gates'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'init.json')
    .map(entry => `gates/${entry.name}`);
  const expectedInputs = [
    '.github/workflows/control-gate.yml',
    '.github/workflows/fork-pin-canary.yml',
    '.github/workflows/fork-proof.yml',
    '.github/workflows/identity-gate.yml',
    '.github/workflows/v4-gates.yml',
    '.gitignore',
    '.gitleaks.toml',
    '.nvmrc',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'RULES.md',
    'docs/control-authority.md',
    'policy/policy.json',
    'product/delivery-boundary.json',
    ...filesUnder('docs/modules', '.md'),
    ...filesUnder('scripts', '.mjs').filter(input => !excludedFromInitControlSurface.has(input)),
    ...gateDefinitions,
  ].sort();
  const definition = JSON.parse(readFileSync(join(templateRoot, 'gates', 'init.json'), 'utf8'));
  const policy = definition.items.find(item => item.id === 'I6').evidencePolicy;
  const trackedInputs = new Set(
    execFileSync('git', ['-C', templateRoot, 'ls-files', '-z']).toString('utf8').split('\0').filter(Boolean),
  );

  assert.equal(definition.version, 4);
  assert.deepEqual(expectedInputs.filter(input => !trackedInputs.has(input)), []);
  assert.deepEqual(policy.requiredInputs, expectedInputs);
  assert.deepEqual(policy.allowedInputs, expectedInputs);
  assert.deepEqual(policy.requiredPrefixes, []);
  assert.deepEqual(policy.allowedPrefixes, []);
  assert.equal(policy.requiredInputs.includes('gates/init.json'), false,
    'dedicated gate evidence binds gates/init.json automatically');
  for (const forbidden of [/^gates\/runs\//, /^receipts\//, /^(?:STATE\.md|state\.json|tasks\.json)$/, /^future\//]) {
    assert.equal(policy.requiredInputs.some(input => forbidden.test(input)), false, forbidden.source);
  }
});

test('owner approval provenance is documented as a required external merge boundary', () => {
  const authority = readFileSync(join(templateRoot, 'docs', 'control-authority.md'), 'utf8');
  assert.match(authority, /Approval provenance must be enforced by the protected pull-request and merge process\./);
  assert.doesNotMatch(authority, /Approval provenance is enforced/);
});

test('owner approval contract documents exact v2 subject binding without claiming signatures', () => {
  const authority = readFileSync(join(templateRoot, 'docs', 'control-authority.md'), 'utf8');
  const contract = readModuleContract('v4-evidence-control');

  assert.match(authority, /`v4-owner-approval-v2`/);
  assert.match(authority, /`subjectHashes`/);
  assert.match(authority, /exact content binding, not a cryptographic signature/);
  assert.match(contract, /Gate evidence binds the gate definition, authority policy, and exact approved artifact inputs/);
  assert.match(contract, /`NOT_APPLICABLE` binds the gate definition and authority policy/);
  assert.match(contract, /override binds the complete evaluated closure/);
  assert.match(contract, /currently missing nested path is represented by the bound parent receipt, run, and evaluation problems/);
});

test('delivery boundary module contract defines its read-only manifest checker', () => {
  const contract = readModuleContract('delivery-boundary');

  assert.match(contract, /`node scripts\/check-delivery-boundary\.mjs`/);
  assert.match(contract, /`checkDeliveryBoundary\(rootPath\)`/);
  assert.match(contract, /gate-run projections/);
  assert.match(contract, /does not write repository files/);
});

test('control supply chain separates local consistency from external release authority', () => {
  const contract = readModuleContract('control-supply-chain');
  const authority = readFileSync(join(templateRoot, 'docs', 'control-authority.md'), 'utf8');

  assert.match(contract, /repository-local consistency check/);
  assert.match(contract, /does not provide external immutability/);
  assert.match(authority, /protected pull-request and merge process/);
  assert.match(authority, /immutable external repository rule/);
  assert.match(authority, /does not claim that either release prerequisite is configured or active/);
  assert.doesNotMatch(contract, /future reviewed policy/);
});

test('tracked-project fixture module contract defines its tracked-only safety boundary', () => {
  const contract = readModuleContract('tracked-project-fixtures');

  assert.match(contract, /`copyTrackedProjectFiles\(sourceRoot, targetRoot\)`/);
  assert.match(contract, /current working-tree bytes/);
  assert.match(contract, /ignored and other untracked files/);
  assert.match(contract, /validates every source entry before it creates the target root/);
  assert.match(contract, /partially populated target/);
});

test('reserved gate receipt types cannot be manufactured by generic receipt CLI', () => {
  const root = project();
  for (const type of ['typed-requirements-verified', 'owner-spec-approved']) {
    const result = v4Result(
      root, 'receipt', 'add', '--type', type,
      '--phase', 'spec', '--result', 'PASSED', '--input', 'specs/requirements.json',
    );
    assert.equal(result.status, 1, type);
    assert.match(result.stderr, /reserved for gate commands/, type);
  }
  assert.deepEqual(listReceipts(root), []);

  assert.throws(() => addReceipt(root, {
    type: 'typed-requirements-verified', phase: 'spec', result: 'PASSED',
    data: {
      itemId: 'S1', producer: 'v4-gate-evidence-v1', proofSchema: 'sha256-input-manifest-v1',
    },
    inputs: ['gates/spec.json', 'specs/requirements.json'],
  }), /reserved for dedicated gate commands/);
  assert.equal('addGateReceipt' in receiptModule, false,
    'the receipt library must not expose a raw reserved-type writer');
});

test('dedicated gate evidence enforces item policy and binds proof schema', () => {
  const root = project();
  writeFileSync(join(root, 'ordinary.txt'), 'not spec evidence');

  const rejected = v4Result(
    root, 'gate', 'evidence', 'spec', '--item', 'S1', '--input', 'ordinary.txt',
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /not allowed by spec\/S1 evidence policy/);
  assert.deepEqual(listReceipts(root), []);

  const receipt = v4(
    root, 'gate', 'evidence', 'spec', '--item', 'S1', '--input', 'specs/requirements.json',
  );
  assert.equal(receipt.type, 'typed-requirements-verified');
  assert.deepEqual(receipt.data, {
    itemId: 'S1', producer: 'v4-gate-evidence-v1', proofSchema: 'sha256-input-manifest-v1',
  });
  assert.match(receipt.inputHashes['gates/spec.json'], /^[0-9a-f]{64}$/);
  assert.match(receipt.inputHashes['specs/requirements.json'], /^[0-9a-f]{64}$/);
  const run = JSON.parse(readFileSync(join(root, 'gates', 'runs', 'spec.json'), 'utf8'));
  assert.deepEqual(run.items.S1, { status: 'RUN', receipt: receipt.id });
});

test('architecture gates reject arbitrary files even under the architecture directory', () => {
  const root = project();
  for (const itemId of ['A1', 'A2', 'A3', 'A4', 'A5']) {
    const input = `architecture/not-evidence-${itemId}.txt`;
    writeFileSync(join(root, input), 'not canonical architecture evidence');
    const rejected = v4Result(
      root, 'gate', 'evidence', 'architecture', '--item', itemId, '--input', input,
    );
    assert.equal(rejected.status, 1, itemId);
    assert.match(rejected.stderr, /not allowed by architecture\//, itemId);
  }
  assert.deepEqual(listReceipts(root), []);
});

test('owner gate evidence only consumes matching structured owner approval artifacts', () => {
  const root = project();
  writeFileSync(join(root, 'README-owner.md'), 'OWNER APPROVED');
  const rejectedReadme = v4Result(
    root, 'gate', 'owner-authorize', 'spec', '--item', 'S5',
    '--rationale', 'Owner approves this exact spec revision.', '--approval', 'README-owner.md',
    '--input', 'specs/requirements.json',
  );
  assert.equal(rejectedReadme.status, 1);
  assert.match(rejectedReadme.stderr, /decisions\/owner-approvals/);

  const wrong = writeOwnerApproval(root, 'wrong-spec', {
    action: 'NOT_APPLICABLE', phase: 'spec', itemId: 'S5',
    rationale: 'Owner approves this exact spec revision.',
  });
  const rejectedAction = v4Result(
    root, 'gate', 'owner-authorize', 'spec', '--item', 'S5',
    '--rationale', 'Owner approves this exact spec revision.', '--approval', wrong,
    '--input', 'specs/requirements.json',
  );
  assert.equal(rejectedAction.status, 1);
  assert.match(rejectedAction.stderr, /action NOT_APPLICABLE; expected GATE_EVIDENCE/);

  const approval = writeOwnerApproval(root, 'spec-approved', {
    action: 'GATE_EVIDENCE', phase: 'spec', itemId: 'S5',
    rationale: 'Owner approves this exact spec revision.',
    subjectInputs: ['gates/spec.json', 'policy/policy.json', 'specs/requirements.json'],
  });
  const receipt = v4(
    root, 'gate', 'owner-authorize', 'spec', '--item', 'S5',
    '--rationale', 'Owner approves this exact spec revision.', '--approval', approval,
    '--input', 'specs/requirements.json',
  );
  assert.equal(receipt.type, 'owner-spec-approved');
  assert.match(receipt.inputHashes[approval], /^[0-9a-f]{64}$/);
  assert.match(receipt.inputHashes['policy/policy.json'], /^[0-9a-f]{64}$/);

  const ordinary = v4Result(
    root, 'gate', 'evidence', 'spec', '--item', 'S5', '--input', 'specs/requirements.json',
  );
  assert.equal(ordinary.status, 1);
  assert.match(ordinary.stderr, /requires OWNER authorization/);
});

test('owner approval schema, authority, binding fields, token, and regular-file status fail closed', () => {
  const root = project();
  const rationale = 'Owner approves this exact spec revision.';
  const path = 'decisions/owner-approvals/schema-check.json';
  const subjectInputs = ['gates/spec.json', 'policy/policy.json', 'specs/requirements.json'];
  const subjectHashes = approvalSubjectHashes(root, subjectInputs);
  const missingSubjectHashes = { ...subjectHashes };
  delete missingSubjectHashes['specs/requirements.json'];
  const valid = {
    schema: 'v4-owner-approval-v2', authority: 'OWNER', action: 'GATE_EVIDENCE',
    phase: 'spec', itemId: 'S5', rationale, approvalToken: 'OWNER APPROVED',
    subjectHashes,
  };
  const cases = [
    { value: { ...valid, extra: true }, error: /contain exactly/ },
    { value: { ...valid, schema: 'v4-owner-approval-v1' }, error: /schema v4-owner-approval-v1; expected v4-owner-approval-v2/ },
    { value: { ...valid, authority: 'AGENT' }, error: /authority AGENT; expected OWNER/ },
    { value: { ...valid, phase: 'init' }, error: /phase init; expected spec/ },
    { value: { ...valid, itemId: 'S4' }, error: /itemId S4; expected S5/ },
    { value: { ...valid, rationale: 'different' }, error: /rationale does not match/ },
    { value: { ...valid, approvalToken: 'maybe' }, error: /explicit APPROVED or AUTHORIZED token/ },
    { value: { ...valid, approvalToken: 'NOT APPROVED' }, error: /explicit APPROVED or AUTHORIZED token/ },
    { value: { ...valid, approvalToken: 'NEVER APPROVED' }, error: /explicit APPROVED or AUTHORIZED token/ },
    { value: { ...valid, subjectHashes: null }, error: /subjectHashes must be a plain object/ },
    { value: { ...valid, subjectHashes: missingSubjectHashes }, error: /missing: specs\/requirements\.json/ },
    { value: { ...valid, subjectHashes: { ...subjectHashes, 'zz-extra.txt': '0'.repeat(64) } }, error: /extra: zz-extra\.txt/ },
    { value: { ...valid, subjectHashes: { ...subjectHashes, 'specs/requirements.json': 'A'.repeat(64) } }, error: /invalid SHA-256 subject hash/ },
    { value: { ...valid, subjectHashes: { ...subjectHashes, 'specs/requirements.json': '0'.repeat(64) } }, error: /does not match current content/ },
    {
      value: {
        ...valid,
        subjectHashes: {
          'specs/requirements.json': subjectHashes['specs/requirements.json'],
          'gates/spec.json': subjectHashes['gates/spec.json'],
          'policy/policy.json': subjectHashes['policy/policy.json'],
        },
      },
      error: /canonical lexicographic order/,
    },
  ];
  for (const scenario of cases) {
    writeJson(join(root, path), scenario.value);
    const result = v4Result(
      root, 'gate', 'owner-authorize', 'spec', '--item', 'S5',
      '--rationale', rationale, '--approval', path, '--input', 'specs/requirements.json',
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario.error);
    assert.deepEqual(listReceipts(root), []);
  }

  const target = 'decisions/owner-approvals/target.json';
  writeJson(join(root, target), valid);
  const link = 'decisions/owner-approvals/link.json';
  symlinkSync('target.json', join(root, link));
  const linked = v4Result(
    root, 'gate', 'owner-authorize', 'spec', '--item', 'S5',
    '--rationale', rationale, '--approval', link, '--input', 'specs/requirements.json',
  );
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /regular repo-internal file, not a symlink/);
  assert.deepEqual(listReceipts(root), []);
});

test('the exact Phase 1 baseline owner token authorizes init I2', () => {
  const root = project();
  const approvalToken = 'PHASE 1 BASELINE APPROVED';
  const approval = writeOwnerApproval(root, 'phase-1-baseline', {
    action: 'GATE_EVIDENCE', phase: 'init', itemId: 'I2',
    rationale: approvalToken, approvalToken,
    subjectInputs: ['gates/init.json', 'policy/policy.json', 'product/PRD.md'],
  });

  const receipt = v4(
    root, 'gate', 'owner-authorize', 'init', '--item', 'I2',
    '--rationale', approvalToken, '--approval', approval, '--input', 'product/PRD.md',
  );

  assert.equal(receipt.type, 'owner-cleanroom-baseline-approved');
});

test('the recorded init I2 approval binds the current policy', () => {
  const run = JSON.parse(readFileSync(join(templateRoot, 'gates', 'runs', 'init.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(
    join(templateRoot, 'receipts', `${run.items.I2.receipt}.json`),
    'utf8',
  ));
  assert.equal(receipt.type, 'owner-cleanroom-baseline-approved');
  assert.equal(receipt.data.itemId, 'I2');
  assert.match(receipt.data.approvalInput, /^decisions\/owner-approvals\/[a-z0-9][a-z0-9._-]*\.json$/);

  const approval = JSON.parse(readFileSync(join(templateRoot, receipt.data.approvalInput), 'utf8'));
  const subjectInputs = ['gates/init.json', 'policy/policy.json', 'product/PRD.md'];
  const currentHashes = approvalSubjectHashes(templateRoot, subjectInputs);

  assert.equal(approval.schema, 'v4-owner-approval-v2');
  assert.deepEqual(Object.keys(approval.subjectHashes), subjectInputs);
  assert.equal(approval.subjectHashes['policy/policy.json'], currentHashes['policy/policy.json']);
  assert.equal(Object.keys(approval.subjectHashes).some(input => input.startsWith('future/')), false);
});

test('current Phase 3 interface evidence remains non-authoritative', () => {
  const interfaces = JSON.parse(readFileSync(join(templateRoot, 'architecture', 'interfaces.json'), 'utf8'));
  const freeze = JSON.parse(readFileSync(join(templateRoot, 'feasibility', 'interface-freeze.json'), 'utf8'));

  assert.equal(interfaces.productPhase, 3);
  assert.equal(interfaces.requirementsRevision, 65);
  assert.equal(interfaces.architectureRevision, 9);
  assert.equal(interfaces.bindingManifestDigest, null);
  assert.equal(interfaces.providerBinding.status, 'INTEGRATION_PENDING');
  assert.equal(interfaces.phaseBoundary.codeReadinessDoesNotAuthorizeLive, true);
  assert.equal(freeze.status, 'PROVISIONAL_PHASE3_PENDING_FEASIBILITY');
  assert.equal(freeze.bindingManifestDigest, null);
  assert.equal(freeze.productionReadiness.ready, false);
  assert.match(freeze.productionReadiness.rule, /cannot authorize signing, broadcast, deployment, asset movement, gas spend, or publication/);
});

test('Phase 2 review evidence is local-only and binds the lean cycle-control implementation', () => {
  const artifact = JSON.parse(readFileSync(
    join(templateRoot, 'qa', 'reviews', 'phase2-operator-control-local-verification.json'),
    'utf8',
  ));
  const reviewIndex = JSON.parse(readFileSync(join(templateRoot, 'qa', 'reviews', 'index.json'), 'utf8'));

  assert.equal(artifact.schema, 'hookemon.phase2-local-verification.v1');
  assert.equal(artifact.authority, 'LOCAL_FIXTURE_AND_OFFLINE_TESTS_ONLY');
  assert.equal(artifact.requirementsRevision, 57);
  assert.equal(artifact.architectureRevision, 5);
  assert.equal(artifact.releaseApproved, false);
  assert.equal(artifact.productionReady, false);
  assert.equal(artifact.externalActionsPerformed, false);
  for (const commit of [
    '9b7b69751888e792c15d8cda03099cf369d42739',
    'b9e891cef32f72ccde313a1e4a56a4e1549ada2c',
    'b11754857ef561e5b92abe99bf1f1bafee913729',
    'fc4906a2c9c9b9a70e7bdb02724fbf317a3a3adb',
    'e6a8ca750d401294569c9a8fb926e4afca7f18b1',
    'd590b060992834158c09df9f3af9e867b5d02ff9',
  ]) assert.equal(artifact.implementationCommits.includes(commit), true, commit);
  for (const capability of [
    'dashboard', 'server', 'database', 'scheduler', 'automatic-pack-selection',
    'concurrent-cycles', 'production-signing', 'broadcast', 'deployment',
  ]) assert.equal(artifact.excludedCapabilities.includes(capability), true, capability);
  assert.equal(artifact.verification.runner.failed, 0);
  assert.equal(artifact.verification.contractProcess.failed, 0);
  assert.equal(artifact.verification.contractSurface.failed, 0);
  assert.equal(reviewIndex.scope, 'PHASE_1_AND_PHASE_2_LOCAL_REVIEW_EVIDENCE');
  assert.equal(reviewIndex.phaseTwoDisposition.localOnly, true);
  assert.equal(reviewIndex.phaseTwoDisposition.releaseApproved, false);
  assert.equal(reviewIndex.phaseTwoDisposition.productionReady, false);
  assert.equal(
    reviewIndex.reviews.some(review => review.id === 'P2-OPERATOR-CONTROL-LOCAL'),
    true,
  );
});

test('override and NOT_APPLICABLE require matching structured owner approvals', () => {
  const root = project();
  const overrideRationale = 'Owner accepts this exact failed spec evaluation.';
  const overrideApproval = writeOwnerApproval(root, 'spec-override', {
    action: 'GATE_OVERRIDE', phase: 'init', itemId: null, rationale: overrideRationale,
  });
  const override = v4(
    root, 'gate', 'override', 'init', '--rationale', overrideRationale, '--approval', overrideApproval,
  );
  assert.equal(override.result, 'OVERRIDDEN');
  assert.match(override.inputHashes[overrideApproval], /^[0-9a-f]{64}$/);
  assert.match(override.inputHashes['policy/policy.json'], /^[0-9a-f]{64}$/);

  const naRoot = project();
  const rationale = 'Owner confirms this item does not apply.';
  const approval = writeOwnerApproval(naRoot, 'spec-s1-na', {
    action: 'NOT_APPLICABLE', phase: 'spec', itemId: 'S1', rationale,
  });
  const authorization = v4(
    naRoot, 'gate', 'authorize-not-applicable', 'spec', '--item', 'S1',
    '--rationale', rationale, '--approval', approval,
  );
  assert.match(authorization.inputHashes[approval], /^[0-9a-f]{64}$/);
  const checked = v4Result(naRoot, 'gate', 'check', 'spec');
  assert.equal(checked.status, 1);
  assert.doesNotMatch(JSON.parse(checked.stdout).problems.join('\n'), /S1:/);
});

test('owner policy text must match exactly and cannot be disabled by suffix', () => {
  const root = project();
  const rationale = 'Owner accepts this exact failed spec evaluation.';
  const approval = writeOwnerApproval(root, 'policy-override', {
    action: 'GATE_OVERRIDE', phase: 'spec', itemId: null, rationale,
  });
  const policyPath = join(root, 'policy', 'policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.protocol = policy.protocol.map(line => line.startsWith('Every gate is owner-overridable.')
    ? `${line} DISABLED: overrides are forbidden.` : line);
  writeJson(policyPath, policy);

  const result = v4Result(
    root, 'gate', 'override', 'spec', '--rationale', rationale, '--approval', approval,
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit-owner policy is not active/);
  assert.deepEqual(listReceipts(root), []);
});

test('task completion accepts only a reachable full lowercase commit object', () => {
  const root = project();
  const head = git(root, 'rev-parse', 'HEAD');
  const unreachable = git(root, 'commit-tree', `${head}^{tree}`, '-m', 'unreachable');
  const db = openLedger(root);
  addTask(db, { id: 'T1', title: 'bind commit', phase: 'build' });
  const { token } = claimTask(db, 'T1', 'worker');

  for (const value of ['abc123', 'A'.repeat(40), '0'.repeat(40), unreachable]) {
    assert.throws(() => completeTask(db, 'T1', 'worker', token, value), /commit/i, value);
  }
  completeTask(db, 'T1', 'worker', token, head);
  projectTasks(db, root);
  const task = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(task.commitSha, head);
});

test('trace rejects malformed or unreachable completion commits', () => {
  const root = project();
  for (const commitSha of ['abc123', '0'.repeat(40)]) {
    writeJson(join(root, 'tasks.json'), {
      generatedAt: '2026-08-30T00:00:00.000Z',
      tasks: [{
        id: 'T1', title: 'task', phase: 'build', risk: 'ordinary', deps: [], reqs: [],
        status: 'done', commitSha,
      }],
    });
    assert.match(traceCheck(root).gaps.join('\n'), /commitSha/);
  }
});

test('task evidence automatically binds the complete requirements revision and content', () => {
  const root = project();
  const head = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'artifact.txt'), 'verified output');
  const originalRequirements = {
    revision: 1,
    requirements: [{
      id: 'REQ-proof-1', kind: 'functional', title: 'proof', statement: 'original statement',
      measurement: 'original measurement', module: 'core', status: 'approved',
    }],
  };
  writeJson(join(root, 'specs', 'requirements.json'), originalRequirements);
  writeJson(join(root, 'tasks.json'), {
    generatedAt: '2026-08-30T00:00:00.000Z',
    tasks: [{
      id: 'T1', title: 'task', phase: 'build', risk: 'ordinary', deps: [], reqs: ['REQ-proof-1'],
      status: 'done', commitSha: head,
    }],
  });
  const evidence = v4(
    root, 'receipt', 'add', '--type', 'evidence', '--result', 'PASSED',
    '--task', 'T1', '--commit', head, '--input', 'artifact.txt',
  );
  assert.match(evidence.inputHashes['specs/requirements.json'], /^[0-9a-f]{64}$/);
  assert.equal(evidence.data.requirementsRevision,
    JSON.parse(readFileSync(join(root, 'specs', 'requirements.json'), 'utf8')).revision);
  assert.match(evidence.data.requirementsHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(traceCheck(root).gaps, []);

  writeJson(join(root, 'specs', 'requirements.json'), {
    ...originalRequirements,
    requirements: [{ ...originalRequirements.requirements[0], statement: 'changed statement' }],
  });
  assert.deepEqual(traceCheck(root).gaps, ['T1: done without valid evidence receipt']);
  writeJson(join(root, 'specs', 'requirements.json'), originalRequirements);
  assert.deepEqual(traceCheck(root).gaps, []);

  writeJson(join(root, 'specs', 'requirements.json'), {
    ...originalRequirements,
    requirements: [{ ...originalRequirements.requirements[0], measurement: 'changed measurement' }],
  });
  assert.deepEqual(traceCheck(root).gaps, ['T1: done without valid evidence receipt']);
  writeJson(join(root, 'specs', 'requirements.json'), originalRequirements);
  assert.deepEqual(traceCheck(root).gaps, []);

  writeJson(join(root, 'specs', 'requirements.json'), { ...originalRequirements, revision: 2 });
  assert.deepEqual(traceCheck(root).gaps, ['T1: done without valid evidence receipt']);
});

test('task evidence requires a verification artifact in addition to requirements', () => {
  const root = project();
  const commitSha = git(root, 'rev-parse', 'HEAD');
  writeJson(join(root, 'tasks.json'), {
    generatedAt: '2026-08-30T00:00:00.000Z',
    tasks: [{
      id: 'T1', title: 'task', phase: 'build', risk: 'ordinary', deps: [], reqs: ['REQ-token-core-1'],
      status: 'done', commitSha,
    }],
  });
  const cli = v4Result(
    root, 'receipt', 'add', '--type', 'evidence', '--result', 'PASSED',
    '--task', 'T1', '--commit', commitSha,
  );
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /verification artifact/);
  assert.deepEqual(listReceipts(root), []);

  const context = taskEvidenceContext(root, 'T1', commitSha);
  addReceipt(root, {
    type: 'evidence', phase: context.phase, result: 'PASSED',
    data: context.data, inputs: context.inputs,
  });
  assert.deepEqual(traceCheck(root).gaps, ['T1: done without valid evidence receipt']);
});

test('task phase must be a valid framework phase', () => {
  const root = project();
  const result = v4Result(root, 'task', 'add', 'T1', '--title', 'invalid phase', '--phase', 'moon');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid task phase moon/);

  writeJson(join(root, 'tasks.json'), {
    generatedAt: '2026-08-30T00:00:00.000Z',
    tasks: [{
      id: 'T1', title: 'invalid phase', phase: 'moon', risk: 'ordinary', deps: [], reqs: [],
      status: 'ready',
    }],
  });
  assert.match(traceCheck(root).gaps.join('\n'), /invalid phase moon/);
});

test('state lists only the current authoritative override', () => {
  const root = project();
  const rationale = 'Owner accepts this exact failed spec evaluation.';
  const approval = writeOwnerApproval(root, 'spec-override-state', {
    action: 'GATE_OVERRIDE', phase: 'init', itemId: null, rationale,
  });
  v4(root, 'gate', 'override', 'init', '--rationale', rationale, '--approval', approval);
  assert.equal(projectState(root).overrides.length, 1);

  const definition = JSON.parse(readFileSync(join(root, 'gates', 'init.json'), 'utf8'));
  writeJson(join(root, 'gates', 'init.json'), { ...definition, version: definition.version + 1 });
  assert.deepEqual(projectState(root).overrides, []);
});

test('legacy receipts r-00001 through r-00025 remain readable', () => {
  const receipts = listReceipts(templateRoot);
  const legacyReceiptIds = Array.from({ length: 25 }, (_, index) => `r-${String(index + 1).padStart(5, '0')}`);
  assert.deepEqual(receipts.slice(0, 25).map(receipt => receipt.id), legacyReceiptIds);
  assert.deepEqual(
    readdirSync(join(templateRoot, 'receipts')).filter(name => /^r-\d+\.json$/.test(name)).sort().slice(0, 25),
    legacyReceiptIds.map(id => `${id}.json`),
  );
});

test('status fails closed on a zzzz named handwritten PASSED gate receipt', () => {
  const root = project();
  writeJson(join(root, 'receipts', 'zzzz.json'), {
    id: 'r-00001', at: '2026-08-30T00:00:00.000Z', type: 'gate', phase: 'init',
    result: 'PASSED', data: { gateVersion: 2, problems: [] }, inputHashes: {},
  });

  const status = v4Result(root, 'status', '--check');

  assert.equal(status.status, 1);
  assert.match(status.stderr, /receipt filename must be canonical/);
});
