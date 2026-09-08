import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scanner = join(repoRoot, 'scripts', 'check-commit-identity.mjs');
const identityGate = join(repoRoot, '.github', 'workflows', 'identity-gate.yml');
const projectIdentity = {
  name: 'Hookemon',
  email: '312745360+hookemonv4@users.noreply.github.com',
};

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-identity-'));
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  commit(root, 'base');
  return { root, base: head(root) };
}

function commit(root, subject, { author = projectIdentity, committer = projectIdentity, body } = {}) {
  const args = ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', subject];
  if (body) args.push('-m', body);
  execFileSync('git', args, {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    },
  });
}

function head(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function scan(root, base, tip) {
  return spawnSync(process.execPath, [scanner, base, tip], { cwd: root, encoding: 'utf8' });
}

test('commit scanner accepts the exact project author and committer', () => {
  const { root, base } = repository();
  try {
    commit(root, 'neutral change');

    const result = scan(root, base, head(root));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /commit identity check passed \(1 commit\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit scanner rejects a non-project author', () => {
  const { root, base } = repository();
  try {
    commit(root, 'wrong author', { author: { name: 'Unapproved Author', email: projectIdentity.email } });

    const result = scan(root, base, head(root));

    assert.equal(result.status, 1);
    assert.match(result.stdout, /author-identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit scanner rejects a non-project committer', () => {
  const { root, base } = repository();
  try {
    commit(root, 'wrong committer', { committer: { name: 'Unapproved Committer', email: projectIdentity.email } });

    const result = scan(root, base, head(root));

    assert.equal(result.status, 1);
    assert.match(result.stdout, /committer-identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit scanner rejects attribution trailers', () => {
  const { root, base } = repository();
  try {
    const trailer = ['Co-', 'Authored-By: Example <example', '@', 'example.com>'].join('');
    commit(root, 'forbidden trailer', { body: trailer });

    const result = scan(root, base, head(root));

    assert.equal(result.status, 1);
    assert.match(result.stdout, /attribution-trailer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit scanner rejects attribution trailers with whitespace before the separator', () => {
  const { root, base } = repository();
  try {
    const trailer = ['Co-', 'Authored-By', ' : Example <example', '@', 'example.com>'].join('');
    commit(root, 'spaced forbidden trailer', { body: trailer });

    const result = scan(root, base, head(root));

    assert.equal(result.status, 1);
    assert.match(result.stdout, /attribution-trailer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity gate extracts the base checker despite ref and replacement poisoning', () => {
  const workflow = readFileSync(identityGate, 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'hookemon-identity-poison-'));
  const trustedChecker = readFileSync(scanner, 'utf8');
  const candidateChecker = 'process.exit(0);\n';

  try {
    execFileSync('git', ['-C', root, 'init', '--quiet']);
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'check-commit-identity.mjs'), trustedChecker);
    execFileSync('git', ['-C', root, 'add', 'scripts/check-commit-identity.mjs']);
    commit(root, 'trusted checker');
    const base = head(root);

    writeFileSync(join(root, 'scripts', 'check-commit-identity.mjs'), candidateChecker);
    execFileSync('git', ['-C', root, 'add', 'scripts/check-commit-identity.mjs']);
    commit(root, 'candidate checker', {
      author: { name: 'Unapproved Author', email: projectIdentity.email },
    });
    const tip = head(root);
    execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main', tip]);
    execFileSync('git', ['-C', root, 'replace', base, tip]);

    const mutableRefChecker = execFileSync(
      'git',
      ['-C', root, 'show', 'origin/main:scripts/check-commit-identity.mjs'],
      { encoding: 'utf8' },
    );
    const replacementChecker = execFileSync(
      'git',
      ['-C', root, 'show', `${base}:scripts/check-commit-identity.mjs`],
      { encoding: 'utf8' },
    );
    const extractedBaseChecker = execFileSync(
      'git',
      ['-C', root, 'show', `${base}:scripts/check-commit-identity.mjs`],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      },
    );
    const extractedCheckerPath = join(root, 'base-check-commit-identity.mjs');
    writeFileSync(extractedCheckerPath, extractedBaseChecker);
    const result = spawnSync(process.execPath, [extractedCheckerPath, base, tip], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });

    assert.equal(mutableRefChecker, candidateChecker);
    assert.equal(replacementChecker, candidateChecker);
    assert.equal(extractedBaseChecker, trustedChecker);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /author-identity/);
    assert.match(workflow, /pull_request_target:/);
    assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.match(workflow, /GIT_NO_REPLACE_OBJECTS: '1'/);
    assert.match(workflow, /git show "\$\{range_base\}:scripts\/check-commit-identity\.mjs"/);
    assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'project GitHub merge', pass: true },
  { name: 'ordinary commit with GitHub metadata', singleParent: true, pass: false },
  { name: 'foreign repository merge', subject: 'Merge pull request #46 from foreign/codex/change', pass: false },
  { name: 'foreign author email', email: 'foreign.invalid', pass: false },
  { name: 'wrong GitHub committer email', committerEmail: 'wrong.invalid', pass: false },
  { name: 'merge with attribution trailer', trailer: true, pass: false },
]) {
  test(`commit scanner checks ${scenario.name}`, () => {
    const { root, base } = repository();
    try {
      commit(root, 'branch change');
      const parent = head(root);
      const tree = gitTree(root);
      const args = ['-C', root, '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', base];
      if (!scenario.singleParent) args.push('-p', parent);
      const subject = scenario.subject ?? 'Merge pull request #46 from hookemonv4/codex/change';
      const message = subject + (scenario.trailer ? '\n\n' + ['Co-', 'Authored-By: Person <person.invalid>'].join('') : '');
      const tip = execFileSync('git', args, { input: message, encoding: 'utf8', env: {
        ...process.env, GIT_AUTHOR_NAME: 'hookemon', GIT_AUTHOR_EMAIL: scenario.email ?? projectIdentity.email,
        GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: scenario.committerEmail ?? 'noreply@github.com',
      } }).trim();
      const result = scan(root, base, tip);
      assert.equal(result.status, scenario.pass ? 0 : 1, result.stdout + result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
function gitTree(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
}
