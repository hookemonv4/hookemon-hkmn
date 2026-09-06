#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const ZERO_SHA = '0'.repeat(40);

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value ?? '')) throw new Error(`${label} must be a full SHA`);
}

export function resolvePushRange({ before, head, parents, mode = 'before', mergeBase = null }) {
  assertSha(before, 'before');
  assertSha(head, 'head');
  if (!Array.isArray(parents) || parents.some(parent => !SHA_PATTERN.test(parent))) {
    throw new Error('parents must be an array of full SHAs');
  }
  if (!['before', 'merge-base'].includes(mode)) throw new Error(`unsupported base mode: ${mode}`);

  const initialPush = before.toLowerCase() === ZERO_SHA || parents.length === 0;
  if (initialPush) {
    return {
      initialPush: true,
      rangeBase: EMPTY_TREE_SHA,
      rangeHead: head,
      trustedBase: head,
      revisionArgs: [head],
      requireAncestor: false,
    };
  }

  const rangeBase = mode === 'merge-base' ? mergeBase : before;
  assertSha(rangeBase, 'range base');
  return {
    initialPush: false,
    rangeBase,
    rangeHead: head,
    trustedBase: rangeBase,
    revisionArgs: [`${rangeBase}..${head}`],
    requireAncestor: true,
  };
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', ...options });
}

export function resolvePushRangeFromGit(root, { before, head, mode = 'before' }) {
  const parents = git(root, ['show', '--no-patch', '--format=%P', head]).trim().split(/\s+/).filter(Boolean);
  const initialPush = before.toLowerCase() === ZERO_SHA || parents.length === 0;
  const mergeBase = !initialPush && mode === 'merge-base'
    ? git(root, ['merge-base', before, head]).trim()
    : null;
  return resolvePushRange({ before, head, parents, mode, mergeBase });
}

function receiptChanges(root, parent, commit) {
  const args = parent === null
    ? ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', commit, '--', 'receipts']
    : ['diff-tree', '-r', '-M', '--name-status', '-z', parent, commit, '--', 'receipts'];
  const fields = git(root, args).split('\0').filter(Boolean);
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
  const output = git(root, ['ls-tree', '-z', commit, '--', `:(literal)${path}`]);
  const records = output.split('\0').filter(Boolean);
  if (records.length !== 1) return null;
  const separator = records[0].indexOf('\t');
  if (separator === -1) return null;
  const [mode, type] = records[0].slice(0, separator).split(/\s+/);
  const actualPath = records[0].slice(separator + 1);
  return actualPath === path ? { mode, type } : null;
}

function appendOnlyRule(root, commit, change) {
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

export function scanInitialAppendOnlyRange(root, base, head) {
  if (base !== EMPTY_TREE_SHA) throw new Error('initial append-only checks require the empty tree base');
  assertSha(head, 'head');
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', head]).trim().split('\n').filter(Boolean);
  const findings = [];

  for (const commit of commits) {
    const parents = git(root, ['show', '--no-patch', '--format=%P', commit]).trim().split(/\s+/).filter(Boolean);
    const comparisonParents = parents.length === 0 ? [null] : parents;
    for (const parent of comparisonParents) {
      for (const change of receiptChanges(root, parent, commit)) {
        const rule = appendOnlyRule(root, commit, change);
        if (rule) findings.push({ commit, parent, path: change.oldPath ?? change.path, rule });
      }
    }
  }

  return { commits: commits.length, findings };
}

function writeOutput(path, result) {
  const lines = [
    `initial_push=${result.initialPush}`,
    `range_base=${result.rangeBase}`,
    `range_head=${result.rangeHead}`,
    `trusted_base=${result.trustedBase}`,
    `history_mode=${result.initialPush ? 'all-reachable' : 'range'}`,
  ];
  appendFileSync(path, `${lines.join('\n')}\n`);
}

function writeSummary(path, result) {
  if (!result.initialPush || !path) return;
  appendFileSync(path, [
    '### Initial push range',
    '',
    `No prior commit exists. The pushed commit \`${result.rangeHead}\` is the trusted base because this workflow is executing from the default branch's first tree.`,
    `Range checks use the empty tree \`${EMPTY_TREE_SHA}\` and inspect every commit reachable from the pushed commit.`,
    '',
  ].join('\n'));
}

function printAppendOnlyResult(result) {
  if (result.findings.length === 0) {
    process.stdout.write(`append-only check passed (${result.commits} ${result.commits === 1 ? 'commit' : 'commits'})\n`);
    return;
  }
  process.stdout.write(`append-only check failed: ${result.findings.length} violation(s)\n`);
  for (const finding of result.findings) {
    process.stdout.write(`- ${finding.commit} (${finding.parent ?? EMPTY_TREE_SHA}): ${finding.path}: ${finding.rule}\n`);
  }
  process.exitCode = 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'resolve') {
    const [before, head, mode, outputPath, summaryPath] = args;
    if (!before || !head || !mode || !outputPath) {
      throw new Error('usage: push-range.mjs resolve <before> <head> <before|merge-base> <github-output> [github-summary]');
    }
    const result = resolvePushRangeFromGit(process.cwd(), { before, head, mode });
    writeOutput(outputPath, result);
    writeSummary(summaryPath, result);
    return;
  }
  if (command === 'append-only') {
    const [base, head] = args;
    if (!base || !head || args.length !== 2) {
      throw new Error('usage: push-range.mjs append-only <empty-tree-base> <head>');
    }
    printAppendOnlyResult(scanInitialAppendOnlyRange(process.cwd(), base, head));
    return;
  }
  throw new Error('usage: push-range.mjs <resolve|append-only> ...');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`push range resolution failed: ${error.message ?? error}\n`);
    process.exitCode = 1;
  }
}
