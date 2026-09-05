import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readJson } from './util.mjs';

const HEADER = '<!-- GENERATED from policy/policy.json by `node scripts/v4.mjs policy gen` — edit the source, then regenerate. -->';

export function generateDocs(root) {
  const p = readJson(join(root, 'policy', 'policy.json'));
  const rules = p.rules.map(r => `### ${r.id} — ${r.name}\n\n${r.text}`).join('\n\n');
  const tier = t => p.autonomy[t].map(x => `- ${x}`).join('\n');
  const body = [
    `# Working in ${p.project}`, '',
    '## Session protocol', '',
    p.protocol.map(x => `- ${x}`).join('\n'), '',
    `Phases: ${p.phases.join(' → ')}.`, '',
    '## Standing rules', '', rules, '',
    '## Autonomy', '',
    '**Always:**', tier('always'), '',
    '**Ask first:**', tier('askFirst'), '',
    '**Never:**', tier('never'), '',
  ].join('\n');
  writeFileSync(join(root, 'AGENTS.md'), `${HEADER}\n\n${body}`);
  writeFileSync(join(root, 'CLAUDE.md'), `${HEADER}\n\nRead AGENTS.md — it is the single policy source for this repository.\n`);
  writeFileSync(join(root, 'RULES.md'), `${HEADER}\n\n${['## Standing rules', '', rules].join('\n')}\n`);
}
