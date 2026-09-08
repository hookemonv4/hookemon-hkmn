import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = '56f185e07dfafe5533df617ec1dad473ecb63f68';
const ACTIVE = '63396266c1fa7f30814177a6c548e9af332d07ad';
export const PROVENANCE_DIRECTORY = 'evidence/receipt-provenance/eth-pr39-pr40';
const ENTRIES = [
  ['receipts/r-00648.json', 'b196230ae714ce01a0d3317bde4bfbfbd65b6891', '6493f375f51d3e3a33d6ccba93205687517844bf'],
  ['receipts/r-00649.json', 'ac3f12b7a7e285e5cb54caed5ef9b2b709dfe1c3', '81526a5fb151a41a553d5135b3eb5260cd45fd6a'],
];
const descriptor = {
  schema: 'hookemon-eth-receipt-collision-v1',
  authority: false,
  sourceCommit: SOURCE,
  activeCommit: ACTIVE,
  entries: ENTRIES.map(([path, sourceBlob, activeBlob]) => ({
    path, sourceBlob, activeBlob,
    archive: `${PROVENANCE_DIRECTORY}/${sourceBlob}.json`,
  })),
};
const descriptorPath = `${PROVENANCE_DIRECTORY}/descriptor.json`;
const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
function git(root, args) { return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
function text(root, args) { return git(root, args).toString('utf8').trim(); }
function ancestor(root, base, head) {
  try { git(root, ['merge-base', '--is-ancestor', base, head]); return true; } catch { return false; }
}
function entry(root, ref, path) {
  const output = text(root, ['ls-tree', ref, '--', path]);
  const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(output);
  return match?.[2] === path ? match[1] : null;
}
function validateParents(root, parents) {
  if (parents.length !== 2 || parents[0] === parents[1]) throw new Error('provenance requires a two-parent merge');
  const sourceParent = parents.find(parent => ancestor(root, SOURCE, parent)
    && ENTRIES.every(([path, blob]) => entry(root, parent, path) === blob));
  const activeParent = parents.find(parent => ancestor(root, ACTIVE, parent)
    && ENTRIES.every(([path, , blob]) => entry(root, parent, path) === blob));
  if (!sourceParent || !activeParent || sourceParent === activeParent) throw new Error('merge does not contain the pinned source and active histories');
  for (const [path, sourceBlob, activeBlob] of ENTRIES) {
    if (entry(root, SOURCE, path) !== sourceBlob || entry(root, ACTIVE, path) !== activeBlob) throw new Error('pinned receipt identity mismatch');
  }
  return { sourceParent, activeParent };
}
function statIfPresent(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function artifacts(root) {
  return [[descriptorPath, descriptorBytes], ...descriptor.entries.map(item => [item.archive, git(root, ['cat-file', 'blob', item.sourceBlob])])];
}

// This is historical preservation only. Archived owner approvals are never reissued as ledger evidence.
export function preserveEthReceiptCollision(root) {
  const branch = text(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!branch.startsWith('codex/')) throw new Error('provenance producer requires a codex/ branch');
  const parents = [text(root, ['rev-parse', 'HEAD']), ...text(root, ['rev-parse', '--verify', 'MERGE_HEAD']).split('\n')];
  validateParents(root, parents);
  const output = artifacts(root);
  for (const [path, bytes] of output) {
    for (const parent of parents) {
      if (text(root, ['ls-tree', parent, '--', path])) throw new Error('provenance must be introduced at this merge');
    }
    const components = path.split('/');
    for (let index = 1; index <= components.length; index++) {
      const absolute = join(root, ...components.slice(0, index));
      if (statIfPresent(absolute)?.isSymbolicLink()) throw new Error('provenance paths must not contain symlinks');
    }
    if (existsSync(join(root, path)) && !readFileSync(join(root, path)).equals(bytes)) throw new Error('existing provenance bytes differ');
  }
  for (const [path] of ENTRIES) {
    const stat = lstatSync(join(root, path));
    if (lstatSync(join(root, 'receipts')).isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o644) throw new Error('receipt paths must be regular 0644 files with one link');
  }
  for (const [path, bytes] of output) {
    mkdirSync(join(root, PROVENANCE_DIRECTORY), { recursive: true });
    if (!existsSync(join(root, path))) writeFileSync(join(root, path), bytes, { flag: 'wx', mode: 0o644 });
  }
  for (const [path, , blob] of ENTRIES) writeFileSync(join(root, path), git(root, ['cat-file', 'blob', blob]), { mode: 0o644 });
  return { descriptor: descriptorPath, authority: false, preservedReceipts: ENTRIES.map(([path]) => path) };
}

export function verifiedEthCollisionPaths(root, commit, parents) {
  try {
    const { sourceParent } = validateParents(root, parents);
    for (const [path, bytes] of artifacts(root)) {
      if (parents.some(parent => text(root, ['ls-tree', parent, '--', path]))) return new Map();
      const blob = entry(root, commit, path);
      if (!blob || !git(root, ['cat-file', 'blob', blob]).equals(bytes)) return new Map();
    }
    if (!ENTRIES.every(([path, , blob]) => entry(root, commit, path) === blob)) return new Map();
    return new Map([[sourceParent, new Set(ENTRIES.map(([path]) => path))]]);
  } catch { return new Map(); }
}
