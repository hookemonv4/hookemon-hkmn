import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocs } from '../lib/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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
