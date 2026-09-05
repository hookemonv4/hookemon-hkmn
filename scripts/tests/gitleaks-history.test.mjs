import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-gitleaks-history-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Hookemon');
  git(root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'fixture base');
  return root;
}

function commitAll(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '-m', message);
}

function history(root, base, head, forceText) {
  const args = ['log', '-p', '--full-history', '-m'];
  if (forceText) args.push('--text');
  args.push(`${base}..${head}`);
  return git(root, ...args);
}

test('text history reveals an add-then-delete payload hidden by a base binary attribute', t => {
  const root = repository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = 'HOOKEMON_BINARY_HISTORY_MARKER_BASE';

  writeFileSync(join(root, '.gitattributes'), 'payload.txt binary\n');
  commitAll(root, 'mark payload binary');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'payload.txt'), `${marker}\n`);
  commitAll(root, 'add payload');
  unlinkSync(join(root, 'payload.txt'));
  commitAll(root, 'delete payload');
  const head = git(root, 'rev-parse', 'HEAD').trim();

  assert.doesNotMatch(history(root, base, head, false), new RegExp(marker));
  assert.match(history(root, base, head, true), new RegExp(marker));
});

test('text history follows merge parents when a feature commit introduces the binary attribute', t => {
  const root = repository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = 'HOOKEMON_BINARY_HISTORY_MARKER_MERGE';
  const base = git(root, 'rev-parse', 'HEAD').trim();

  git(root, 'checkout', '-b', 'binary-feature');
  writeFileSync(join(root, '.gitattributes'), 'merged-payload.txt binary\n');
  writeFileSync(join(root, 'merged-payload.txt'), `${marker}\n`);
  commitAll(root, 'add binary-marked feature payload');
  git(root, 'checkout', 'main');
  writeFileSync(join(root, 'main.txt'), 'advance main\n');
  commitAll(root, 'advance main');
  git(root, 'merge', '--no-ff', 'binary-feature', '-m', 'merge binary feature');
  unlinkSync(join(root, 'merged-payload.txt'));
  commitAll(root, 'delete merged payload');
  const head = git(root, 'rev-parse', 'HEAD').trim();

  assert.doesNotMatch(history(root, base, head, false), new RegExp(marker));
  assert.match(history(root, base, head, true), new RegExp(marker));
});

test('no-textconv exposes content masked by a configured one-way diff driver', t => {
  const root = repository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = 'HOOKEMON_TEXTCONV_HISTORY_MARKER';
  const filter = join(root, 'mask-textconv.sh');

  writeFileSync(filter, "#!/bin/sh\nprintf 'MASKED_BY_TEXTCONV\\n'\n");
  chmodSync(filter, 0o755);
  git(root, 'config', 'diff.mask.textconv', filter);
  writeFileSync(join(root, '.gitattributes'), 'textconv-payload.txt diff=mask\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-m', 'configure textconv attribute');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'textconv-payload.txt'), `${marker}\n`);
  commitAll(root, 'add textconv payload');
  unlinkSync(join(root, 'textconv-payload.txt'));
  commitAll(root, 'delete textconv payload');
  const head = git(root, 'rev-parse', 'HEAD').trim();

  const transformed = git(root, 'log', '-p', '--full-history', '-m', '--textconv', `${base}..${head}`);
  const hardened = git(root, 'log', '-p', '--full-history', '-m', '--text', '--no-textconv', `${base}..${head}`);
  assert.doesNotMatch(transformed, new RegExp(marker));
  assert.match(hardened, new RegExp(marker));
});

test('CI forces text diffs across the complete explicit Gitleaks range', () => {
  assert.match(workflow, /--log-opts="--full-history -m --text --no-textconv \$range_base\.\.\$range_head"/);
});
