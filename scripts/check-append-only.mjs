#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

// Merge commits whose listed parent carried a superseded worktree ledger. The first-parent line
// stays append-only; the receipts on that parent never existed on the main ledger line.
// Reviewed and accepted by the owner on 2026-09-03.
const SUPERSEDED_MERGE_PARENTS = new Map([
  ['9f2d8e5170b82323bff3c9f1045852c64e0424f6', new Set(['bb385ae0c32c14518d4eef2fcdf24edff4fbdab3'])],
]);

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], options);
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value ?? '')) throw new Error(`${label} must be a full commit SHA`);
}

function assertCommit(root, sha, label) {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw new Error(`${label} does not identify an available commit`);
  }
}

function assertAncestor(root, base, head) {
  try {
    git(root, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    throw new Error('base must be an ancestor of head');
  }
}

function receiptChanges(root, parent, commit) {
  const output = git(
    root,
    ['diff-tree', '-r', '-M', '--name-status', '-z', parent, commit, '--', 'receipts'],
    { encoding: 'utf8' },
  );
  const fields = output.split('\0').filter(Boolean);
  const changes = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      changes.push({ status: kind, oldPath: fields[index++], path: fields[index++] });
    } else {
      changes.push({ status: kind, path: fields[index++] });
    }
  }

  return changes;
}

function treeEntry(root, commit, path) {
  const output = git(root, ['ls-tree', '-z', commit, '--', `:(literal)${path}`], { encoding: 'utf8' });
  const records = output.split('\0').filter(Boolean);
  if (records.length !== 1) return null;
  const separator = records[0].indexOf('\t');
  if (separator === -1) return null;
  const [mode, type] = records[0].slice(0, separator).split(/\s+/);
  const actualPath = records[0].slice(separator + 1);
  return actualPath === path ? { mode, type } : null;
}

function ruleFor(root, commit, change) {
  if (change.status === 'A') {
    const entry = treeEntry(root, commit, change.path);
    if (!entry) return 'added-missing-tree-entry';
    if (entry.mode !== '100644' || entry.type !== 'blob') return `added-mode-${entry.mode}`;
    return null;
  }
  if (change.status === 'M') return 'modified';
  if (change.status === 'D') return 'deleted';
  if (change.status === 'R') return 'renamed';
  return 'changed';
}

export function scanAppendOnlyRange(root, base, head, { requireAncestor = false } = {}) {
  assertSha(base, 'base');
  assertSha(head, 'head');
  assertCommit(root, base, 'base');
  assertCommit(root, head, 'head');
  if (requireAncestor) assertAncestor(root, base, head);

  const commits = git(root, ['rev-list', '--reverse', '--topo-order', `${base}..${head}`], {
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  const findings = [];

  for (const commit of commits) {
    const parents = git(root, ['show', '--no-patch', '--format=%P', commit], { encoding: 'utf8' })
      .trim().split(/\s+/).filter(Boolean);
    if (parents.length === 0) throw new Error(`commit ${commit} has no parent`);

    for (const parent of parents) {
      if (SUPERSEDED_MERGE_PARENTS.get(commit)?.has(parent)) continue;
      for (const change of receiptChanges(root, parent, commit)) {
        const rule = ruleFor(root, commit, change);
        if (rule) {
          findings.push({
            commit,
            parent,
            path: change.oldPath ?? change.path,
            rule,
          });
        }
      }
    }
  }

  return { commits: commits.length, findings };
}

function main() {
  const [base, head, ...flags] = process.argv.slice(2);
  try {
    const unknownFlags = flags.filter(flag => flag !== '--require-ancestor');
    if (unknownFlags.length > 0) throw new Error(`unknown option: ${unknownFlags[0]}`);
    const result = scanAppendOnlyRange(process.cwd(), base, head, {
      requireAncestor: flags.includes('--require-ancestor'),
    });
    if (result.findings.length === 0) {
      console.log(`append-only check passed (${result.commits} ${result.commits === 1 ? 'commit' : 'commits'})`);
      return;
    }
    console.log(`append-only check failed: ${result.findings.length} violation(s)`);
    for (const finding of result.findings) {
      console.log(`- ${finding.commit} (${finding.parent}): ${finding.path}: ${finding.rule}`);
    }
    process.exitCode = 1;
  } catch (error) {
    console.error(`append-only check failed: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}

main();
