import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocs } from '../lib/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('the policy retains the exact authorization clauses consumed by the owner gate engine', () => {
  const policy = JSON.parse(readFileSync(join(here, '..', '..', 'policy', 'policy.json'), 'utf8'));
  // These sentences are a machine interface in explicitOwnerPolicyIsActive, not editable paraphrases.
  const clauses = [
    [policy.autonomy.never, 'Approve your own work on behalf of the owner'],
    [policy.autonomy.askFirst, 'Marking a gate item NOT_APPLICABLE'],
    [policy.autonomy.askFirst, 'Terminally deferring a task'],
    [policy.protocol, "Every gate is owner-overridable. An override needs the owner's explicit rationale and is recorded as a receipt. Nothing external to the owner may block this project."],
    [policy.protocol, "Approval semantics: only an unambiguous affirmative from the owner counts. Hedged responses ('looks reasonable', 'I guess') are not approval."],
  ];
  for (const [section, clause] of clauses) {
    assert.ok(section.includes(clause), `missing machine-bound owner policy clause: ${clause}`);
  }
});

test('AGENTS.md, CLAUDE.md, RULES.md are generated from policy.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  mkdirSync(join(root, 'policy'), { recursive: true });
  copyFileSync(join(here, '..', '..', 'policy', 'policy.json'), join(root, 'policy', 'policy.json'));
  generateDocs(root);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'RULES.md']) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.match(text, /GENERATED from policy\/policy\.json/);
  }
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /node scripts\/v4\.mjs status/);
  assert.match(agents, /R4/);
  assert.match(agents, /owner-overridable/);
});
