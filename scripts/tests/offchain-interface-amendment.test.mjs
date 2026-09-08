import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { INTERFACE_FREEZE_INPUTS, validateInterfaceFreeze } from '../../feasibility/verify-robinhood-binding.mjs';
const source = resolve(import.meta.dirname, '../..');
const amendmentPath = 'feasibility/phase3-offchain-interface-amendment.json';
const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const hash = (root, path) => `sha256:${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'offchain-interface-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const amendment = read(source, amendmentPath);
  for (const path of [...INTERFACE_FREEZE_INPUTS, 'feasibility/interface-freeze.json', amendmentPath, ...Object.keys(amendment.ownerApprovalHashes)]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), execFileSync('git', ['show', `b2cb737a298522e3944652e862c4eeab195667d8:${path}`], { cwd: source }));
  }
  // This suite proves the retained revision-70 amendment, not the active native interface.
  // Every input comes from the integrated immutable baseline; assert the amendment subjects as well.
  for (const path of ['architecture/interfaces.json', 'specs/requirements.json']) {
    const bytes = readFileSync(join(root, path));
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, amendment.currentInputHashes[path]);
  }
  return root;
}
function validate(root) {
  return validateInterfaceFreeze({ freeze: read(root, 'feasibility/interface-freeze.json'), frozen: read(root, 'architecture/interfaces.json'), provisional: read(root, 'architecture/provisional-interfaces.json'), manifest: read(root, 'bindings/robinhood-chain.json'), projectRoot: root });
}
function change(root, path, mutate) {
  const value = read(root, path); mutate(value); writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}
for (const path of ['specs/requirements.json', 'architecture/interfaces.json']) {
  test(`offchain amendment rejects unbound ${path} bytes`, t => {
    const root = fixture(t);
    writeFileSync(join(root, path), `${readFileSync(join(root, path), 'utf8')}\n`);
    assert.throws(() => validate(root), /offchain current binding mismatch/);
  });
}
test('offchain amendment rejects onchain drift even if current interface bytes are rebound', t => {
  const root = fixture(t);
  change(root, 'architecture/interfaces.json', value => { value.moduleInterfaces[0].operations.push('unauthorizedOperation'); });
  change(root, amendmentPath, value => { value.currentInputHashes['architecture/interfaces.json'] = hash(root, 'architecture/interfaces.json'); });
  change(root, 'feasibility/interface-freeze.json', value => { value.offchainAmendment.sha256 = hash(root, amendmentPath); });
  assert.throws(() => validate(root), /preserved onchain interface projection/);
});
test('offchain amendment rejects changed owner approval bytes', t => {
  const root = fixture(t);
  change(root, 'decisions/owner-approvals/revision-68-spec-s5-approved.json', value => { value.rationale = 'unapproved replacement'; });
  assert.throws(() => validate(root), /owner approval hash mismatch/);
});

test('offchain amendment cannot rebind its historical projection anchor', t => {
  const root = fixture(t);
  change(root, amendmentPath, value => { value.preservedInterfaceProjectionDigest = `sha256:${'a'.repeat(64)}`; });
  change(root, 'feasibility/interface-freeze.json', value => { value.offchainAmendment.sha256 = hash(root, amendmentPath); });
  assert.throws(() => validate(root), /historical projection anchor mismatch/);
});

test('explicit revision-70 approval preserves historical contract proof', t => {
  const result = validate(fixture(t));
  assert.equal(result.requirementsRevision, 65);
  assert.equal(result.architectureRevision, 9);
  assert.equal(result.productionReady, false);
});
test('revision-69 amendment refuses the earlier paused approval path', t => {
  const root = fixture(t);
  change(root, amendmentPath, value => {
    value.ownerApprovalHashes['decisions/owner-approvals/revision-69-spec-s5-approved.json'] = value.ownerApprovalHashes['decisions/owner-approvals/revision-69-collector-explicit-spec-s5-approved.json'];
    delete value.ownerApprovalHashes['decisions/owner-approvals/revision-69-collector-explicit-spec-s5-approved.json'];
  });
  change(root, 'feasibility/interface-freeze.json', value => { value.offchainAmendment.sha256 = hash(root, amendmentPath); });
  assert.throws(() => validate(root), /offchain approval paths/);
});
test('revision-70 approval must bind the actual current spec even after hash rebinding', t => {
  const root = fixture(t);
  const approval = 'decisions/owner-approvals/revision-70-collector-explicit-spec-s5-approved.json';
  change(root, approval, value => { value.subjectHashes['specs/requirements.json'] = '5b440ee917a60b5626a88f90f6608e1d653b583f1462f5f5aaebba2120b13cae'; });
  change(root, amendmentPath, value => { value.ownerApprovalHashes[approval] = hash(root, approval); });
  change(root, 'feasibility/interface-freeze.json', value => { value.offchainAmendment.sha256 = hash(root, amendmentPath); });
  assert.throws(() => validate(root), /current spec is not owner approved/);
});
