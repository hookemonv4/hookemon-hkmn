import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scanner = join(import.meta.dirname, '..', 'check-append-only.mjs');
const identity = {
  GIT_AUTHOR_NAME: 'Hookemon',
  GIT_AUTHOR_EMAIL: '312745360+hookemonv4@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Hookemon',
  GIT_COMMITTER_EMAIL: '312745360+hookemonv4@users.noreply.github.com',
};

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function commit(root, subject) {
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'add', '.']);
  execFileSync(
    'git',
    ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', subject],
    { env: { ...process.env, ...identity } },
  );
  return git(root, 'rev-parse', 'HEAD');
}

function commitStaged(root, subject) {
  execFileSync(
    'git',
    ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', subject],
    { env: { ...process.env, ...identity } },
  );
  return git(root, 'rev-parse', 'HEAD');
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-append-only-'));
  execFileSync('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  mkdirSync(join(root, 'receipts'), { recursive: true });
  writeFileSync(join(root, 'receipts', 'existing.json'), '{"sequence":1}\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  const base = commit(root, 'base');
  return { root, base };
}

function scan(root, base, head, ...options) {
  return spawnSync(process.execPath, [scanner, base, head, ...options], { cwd: root, encoding: 'utf8' });
}

test('allows new receipt files and unrelated changes', () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, 'receipts', 'new.json'), '{"sequence":2}\n');
    writeFileSync(join(root, 'README.md'), 'changed\n');
    const head = commit(root, 'append receipt');

    const result = scan(root, base, head);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /append-only check passed \(1 commit\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a newly added receipt symlink', () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, 'mutable.json'), '{"result":"PASSED"}\n');
    symlinkSync('../mutable.json', join(root, 'receipts', 'linked.json'));
    const head = commit(root, 'add linked receipt');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/linked\.json: added-mode-120000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a newly added executable receipt blob', () => {
  const { root, base } = repository();
  try {
    const receipt = join(root, 'receipts', 'executable.json');
    writeFileSync(receipt, '{"result":"PASSED"}\n');
    chmodSync(receipt, 0o755);
    const head = commit(root, 'add executable receipt');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/executable\.json: added-mode-100755/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a newly added receipt gitlink', () => {
  const { root, base } = repository();
  try {
    execFileSync(
      'git',
      ['-C', root, 'update-index', '--add', '--cacheinfo', `160000,${base},receipts/nested.json`],
    );
    const head = commitStaged(root, 'add receipt gitlink');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/nested\.json: added-mode-160000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects modification of a pre-existing receipt', () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, 'receipts', 'existing.json'), '{"sequence":999}\n');
    const head = commit(root, 'modify receipt');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/existing\.json: modified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects deletion and rename of pre-existing receipts', () => {
  const { root, base } = repository();
  try {
    execFileSync('git', ['-C', root, 'mv', 'receipts/existing.json', 'receipts/renamed.json']);
    const head = commit(root, 'rename receipt');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/existing\.json: (deleted|renamed)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a transient receipt edit that a later commit reverts', () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, 'receipts', 'existing.json'), '{"sequence":999}\n');
    commit(root, 'temporarily modify receipt');
    writeFileSync(join(root, 'receipts', 'existing.json'), '{"sequence":1}\n');
    const head = commit(root, 'restore receipt');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/existing\.json: modified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inspects merge commits against every parent', () => {
  const { root, base } = repository();
  try {
    execFileSync('git', ['-C', root, 'switch', '--quiet', '-c', 'feature']);
    writeFileSync(join(root, 'feature.txt'), 'feature\n');
    commit(root, 'feature');
    execFileSync('git', ['-C', root, 'switch', '--quiet', 'main']);
    writeFileSync(join(root, 'main.txt'), 'main\n');
    commit(root, 'main work');
    execFileSync(
      'git',
      ['-C', root, 'merge', '--quiet', '--no-ff', '--no-commit', 'feature'],
      { env: { ...process.env, ...identity }, stdio: 'ignore' },
    );
    writeFileSync(join(root, 'receipts', 'existing.json'), '{"sequence":2}\n');
    const head = commit(root, 'merge feature');

    const result = scan(root, base, head);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /receipts\/existing\.json: modified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a divergent PR base while inspecting the explicit base..head range', () => {
  const { root, base } = repository();
  try {
    execFileSync('git', ['-C', root, 'switch', '--quiet', '-c', 'feature']);
    writeFileSync(join(root, 'receipts', 'feature.json'), '{"sequence":2}\n');
    const head = commit(root, 'append feature receipt');
    execFileSync('git', ['-C', root, 'switch', '--quiet', 'main']);
    writeFileSync(join(root, 'main.txt'), 'main moved\n');
    const advancedBase = commit(root, 'advance main');
    assert.notEqual(advancedBase, base);

    const result = scan(root, advancedBase, head);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /append-only check passed \(1 commit\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a non-fast-forward range when ancestor enforcement is requested for a push', () => {
  const { root, base } = repository();
  try {
    writeFileSync(join(root, 'README.md'), 'advanced\n');
    const before = commit(root, 'advance main');

    const result = scan(root, before, base, '--require-ancestor');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /base must be an ancestor of head/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed for abbreviated or unknown commit SHAs', () => {
  const { root, base } = repository();
  try {
    const abbreviated = base.slice(0, 12);
    const result = scan(root, abbreviated, 'f'.repeat(40));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a full commit SHA|could not inspect commit range/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
