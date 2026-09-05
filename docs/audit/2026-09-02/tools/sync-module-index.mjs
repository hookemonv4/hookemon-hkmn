// Usage: node sync-module-index.mjs <repoRoot>
// Rebuilds docs/modules/index.json modules[] to exactly the capability-map topologicalOrder with fresh sha256 digests.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const root = process.argv[2];
const indexPath = join(root, 'docs/modules/index.json');
const capPath = join(root, 'architecture/capability-map.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const cap = JSON.parse(readFileSync(capPath, 'utf8'));
const modules = [];
for (const id of cap.topologicalOrder) {
  const path = `docs/modules/${id}.md`;
  const abs = join(root, path);
  if (!existsSync(abs)) { console.error(`missing card for ${id}`); process.exit(1); }
  modules.push({ id, path, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') });
}
const unregistered = [];
import { readdirSync } from 'node:fs';
for (const f of readdirSync(join(root, 'docs/modules'))) {
  if (f.endsWith('.md') && !cap.topologicalOrder.includes(f.replace(/\.md$/, ''))) unregistered.push(f);
}
index.modules = modules;
index.productPhase = cap.productPhase; index.architectureRevision = cap.architectureRevision; index.requirementsRevision = cap.requirementsRevision;
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ registered: modules.length, unregistered }));
