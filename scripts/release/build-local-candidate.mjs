// Regenerates release/phase1/local-candidate.json's `files` digest list from the exact
// requiredCandidatePaths production closure defined in verify-phase1-release.mjs, so the
// candidate always content-addresses the tree it is run against. Every other manifest field
// (schema, authority, phase boundary markers, custody roles, the deterministic local vault
// identity, and external-action status) is release metadata, not tree-derived data, and this
// script never touches it -- those change only when someone deliberately edits
// release/phase1/local-candidate.json, e.g. after re-running the documented Foundry invariant
// command in docs/modules/release-evidence.md and reading the fresh `DeterministicVaultIdentity`
// event because PegCycleVault's construction bytecode moved.
//
// Deterministic: running this script twice against an unchanged tree produces byte-identical
// output (the file list and their SHA-256 digests depend only on file contents, and key order
// is preserved from the existing manifest).
//
// Usage: node scripts/release/build-local-candidate.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { requiredCandidatePaths } from '../verify-phase1-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function main() {
  const manifestPath = resolve(root, 'release/phase1/local-candidate.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files = [...requiredCandidatePaths].sort().map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
  }));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: 'REGENERATED',
    manifest: 'release/phase1/local-candidate.json',
    files: manifest.files.length,
    manifestSha256: sha256(readFileSync(manifestPath)),
  }, null, 2)}\n`);
}

main();
