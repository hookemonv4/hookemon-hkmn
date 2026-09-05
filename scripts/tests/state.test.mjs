import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addReceipt } from '../lib/receipts.mjs';
import { projectState, PHASES } from '../lib/state.mjs';
import { writeJson } from '../lib/util.mjs';
import { checkGate, overrideGate } from '../lib/gates.mjs';
import { overrideSubjectInputs, writeOwnerApproval } from './helpers/owner-approval.mjs';

const BLOCKED_ITEM = {
  id: 'S1', text: 'blocked', receiptType: 'evidence',
  evidencePolicy: {
    authority: 'SYSTEM', requiredInputs: ['evidence.txt'], requiredPrefixes: [],
    allowedInputs: ['evidence.txt'], allowedPrefixes: [],
  },
};

function ownerOverride(root, rationale, phase = 'spec') {
  writeJson(join(root, 'policy', 'policy.json'), {
    protocol: ["Every gate is owner-overridable. An override needs the owner's explicit rationale and is recorded as a receipt. Nothing external to the owner may block this project."],
    autonomy: { never: ['Approve your own work on behalf of the owner'] },
  });
  const approval = `decisions/owner-approvals/${phase}-override.json`;
  writeOwnerApproval(root, approval, {
    action: 'GATE_OVERRIDE', phase, itemId: null, rationale,
  }, overrideSubjectInputs(root, phase));
  return overrideGate(root, phase, rationale, approval);
}

test('projects current phase, staleness, and overrides; STATE.md is generated', () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  writeJson(join(root, 'gates', 'init.json'), { id: 'init', version: 1, items: [] });
  checkGate(root, 'init');
  writeJson(join(root, 'gates', 'spec.json'), {
    id: 'spec', version: 1, items: [BLOCKED_ITEM],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: { S1: { status: 'ESCALATE' } } });
  const latest = ownerOverride(root, 'demo');
  const expectedGeneratedAt = '2026-08-30T12:34:56.000Z';
  writeFileSync(
    join(root, 'receipts', `${latest.id}.json`),
    JSON.stringify({ ...latest, at: expectedGeneratedAt }),
  );
  let s = projectState(root);
  assert.equal(PHASES[0], 'init');
  assert.equal(s.currentPhase, 'architecture');
  assert.equal(s.overrides.length, 1);
  assert.equal(s.generatedAt, expectedGeneratedAt);
  assert.equal(projectState(root).generatedAt, expectedGeneratedAt);
  writeJson(join(root, 'gates', 'init.json'), { id: 'init', version: 2, items: [] });
  s = projectState(root);
  assert.equal(s.phases[0].result, 'STALE');
  assert.equal(s.currentPhase, 'init');
  const md = readFileSync(join(root, 'STATE.md'), 'utf8');
  assert.match(md, /GENERATED/);
  assert.match(md, /OVERRIDDEN|STALE/);
});

test('a gate definition change makes an OVERRIDDEN phase stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  writeJson(join(root, 'gates', 'init.json'), { id: 'init', version: 1, items: [] });
  checkGate(root, 'init');
  writeJson(join(root, 'gates', 'spec.json'), {
    id: 'spec', version: 1, items: [BLOCKED_ITEM],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: { S1: { status: 'ESCALATE' } } });
  ownerOverride(root, 'owner accepts the risk');
  assert.equal(projectState(root).phases.find(p => p.phase === 'spec').result, 'OVERRIDDEN');

  writeJson(join(root, 'gates', 'spec.json'), {
    id: 'spec', version: 2, items: [BLOCKED_ITEM],
  });

  const state = projectState(root);
  assert.equal(state.phases.find(p => p.phase === 'spec').result, 'STALE');
  assert.equal(state.currentPhase, 'spec');
});

test('canonical handwritten PASSED gates with empty or false inputs are not authoritative', () => {
  for (const inputHashes of [{}, { 'gates/init.json': '0'.repeat(64) }]) {
    const root = mkdtempSync(join(tmpdir(), 'v4-'));
    writeJson(join(root, 'gates', 'init.json'), {
      id: 'init', version: 1,
      items: [{
        id: 'I1', text: 'required evidence', receiptType: 'prd-written',
        evidencePolicy: {
          authority: 'SYSTEM', requiredInputs: ['evidence.txt'], requiredPrefixes: [],
          allowedInputs: ['evidence.txt'], allowedPrefixes: [],
        },
      }],
    });
    writeJson(join(root, 'receipts', 'r-00001.json'), {
      id: 'r-00001',
      at: '2026-08-30T00:00:00.000Z',
      type: 'gate',
      phase: 'init',
      result: 'PASSED',
      data: { gateVersion: 1, problems: [] },
      inputHashes,
    });

    const state = projectState(root);

    assert.notEqual(state.phases.find(phase => phase.phase === 'init').result, 'PASSED');
    assert.equal(state.currentPhase, 'init');
  }
});

test('later gates fail closed after an earlier gate fails until that gate is authentically overridden', () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  for (const phase of ['init', 'spec', 'architecture']) {
    writeJson(join(root, 'gates', `${phase}.json`), { id: phase, version: 1, items: [] });
    assert.equal(checkGate(root, phase).result, 'PASSED');
  }

  writeJson(join(root, 'gates', 'spec.json'), {
    id: 'spec', version: 2, items: [BLOCKED_ITEM],
  });
  writeJson(join(root, 'gates', 'runs', 'spec.json'), { items: { S1: { status: 'ESCALATE' } } });

  const blockedState = projectState(root);
  assert.equal(blockedState.phases.find(phase => phase.phase === 'architecture').result, 'STALE');
  assert.equal(blockedState.currentPhase, 'spec');

  const staleBlockedCheck = checkGate(root, 'architecture');
  assert.equal(staleBlockedCheck.result, 'FAILED');
  assert.match(staleBlockedCheck.problems.join('\n'), /prerequisite spec gate is STALE/);

  assert.equal(checkGate(root, 'spec').result, 'FAILED');
  const blockedCheck = checkGate(root, 'architecture');
  assert.equal(blockedCheck.result, 'FAILED');
  assert.match(blockedCheck.problems.join('\n'), /prerequisite spec gate is FAILED/);
  assert.throws(
    () => ownerOverride(root, 'owner tries to bypass the failed spec gate', 'architecture'),
    /cannot override architecture while prerequisite spec gate is FAILED/,
  );

  ownerOverride(root, 'owner accepts the exact spec gate failure');
  const allowedCheck = checkGate(root, 'architecture');
  assert.equal(allowedCheck.result, 'PASSED');
});
