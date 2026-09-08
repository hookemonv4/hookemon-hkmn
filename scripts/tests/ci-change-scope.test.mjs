import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyCiChanges } from '../ci-change-scope.mjs';

const classifier = join(import.meta.dirname, '..', 'ci-change-scope.mjs');
const css = 'apps/web/app/globals.css';
const page = 'apps/web/app/page.tsx';
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'CI Scope Fixture', GIT_AUTHOR_EMAIL: '312745360+hookemonv4@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'CI Scope Fixture', GIT_COMMITTER_EMAIL: '312745360+hookemonv4@users.noreply.github.com',
};

function fixture(t, paths = [css]) {
  const cwd = mkdtempSync(join(tmpdir(), 'hookemon-ci-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], { cwd, env, encoding: 'utf8' }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const commit = () => {
    git('add', '--all');
    git('-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  for (const path of paths) write(path, 'before\n');
  const base = commit();
  const classify = (head, event = 'pull_request') => classifyCiChanges({ base, head, event, cwd });
  return { cwd, git, write, commit, base, classify };
}

test('existing presentation components, styles, named tests and narrow media require web checks', t => {
  const paths = [page, css, 'apps/web/lib/scroll-reveal.ts', 'apps/web/public/comic-production/index.html',
    'apps/web/tests/rendered-html.test.mjs', 'apps/web/public/audio/pokemon/025.mp3',
    'apps/web/public/showcase/card.webp', 'apps/web/public/comic/scene.png', 'apps/web/public/comic/scene.mp4'];
  const f = fixture(t, paths);
  for (const path of paths) f.write(path, 'after\n');
  const head = f.commit();
  assert.deepEqual(f.classify(head), {
    schema: 'hookemon.ci-scope.v1', base: f.base, head,
    scope: 'presentation', webRequired: true, reason: 'presentation-only', paths: paths.sort(),
  });
  assert.equal(f.classify(head, 'push').scope, 'presentation');
});

test('mixed shared, operator, worker, dynamic, config and classifier edits require full and web', t => {
  const protectedPaths = ['config/pack-provider.json', 'packages/contracts/src/Hook.sol',
    'apps/web/app/OperatorControlPanel.tsx', 'apps/web/app/layout.tsx', 'apps/web/worker/pack-catalog.ts',
    'apps/web/public/comic-production/packs.mjs', 'apps/web/lib/public-dashboard-schema.ts',
    'apps/web/package-lock.json', 'scripts/ci-change-scope.mjs', '.github/workflows/v4-gates.yml',
    'apps/web/public/comic/nested/scene.png', 'apps/web/public/comic/scene.js'];
  const f = fixture(t, [css, ...protectedPaths]);
  let base = f.base;
  for (const [index, path] of protectedPaths.entries()) {
    f.write(css, `css ${index}\n`);
    f.write(path, 'after\n');
    const head = f.commit();
    const result = classifyCiChanges({ base, head, event: 'pull_request', cwd: f.cwd });
    assert.equal(result.scope, 'full', path);
    assert.equal(result.webRequired, true, path);
    assert.deepEqual(result.paths, [css, path].sort());
    base = head;
  }
});

test('renames retain both paths and cannot hide an outside path behind an allowed destination', t => {
  const f = fixture(t, ['protected.txt']);
  mkdirSync(dirname(join(f.cwd, page)), { recursive: true });
  renameSync(join(f.cwd, 'protected.txt'), join(f.cwd, page));
  const result = f.classify(f.commit());
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.paths, [page, 'protected.txt']);
});

test('additions and deletions of allowed names stay full', t => {
  const f = fixture(t);
  f.write(page, 'new\n');
  const added = f.commit();
  assert.equal(f.classify(added).scope, 'full');
  unlinkSync(join(f.cwd, css));
  const result = classifyCiChanges({ base: added, head: f.commit(), event: 'pull_request', cwd: f.cwd });
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.paths, [css]);
});

test('executable mode, symlink and gitlink changes to allowed names stay full', async t => {
  for (const kind of ['executable', 'symlink', 'gitlink']) {
    await t.test(kind, t => {
      const f = fixture(t);
      let head;
      if (kind === 'executable') {
        chmodSync(join(f.cwd, css), 0o755);
        f.git('config', 'core.fileMode', 'true');
        head = f.commit();
      } else if (kind === 'symlink') {
        unlinkSync(join(f.cwd, css));
        symlinkSync('outside.css', join(f.cwd, css));
        head = f.commit();
      } else {
        unlinkSync(join(f.cwd, css));
        f.git('update-index', '--cacheinfo', `160000,${f.base},${css}`);
        f.git('-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'gitlink');
        head = f.git('rev-parse', 'HEAD');
      }
      assert.equal(f.classify(head).scope, 'full');
    });
  }
});

test('complete NUL inventory preserves special characters and examines more than 300 paths', t => {
  const media = Array.from({ length: 305 }, (_, i) => `apps/web/public/showcase/card-${i}.webp`);
  const unusual = 'zz-protected\nwith\ttabs and spaces.txt';
  const f = fixture(t, [...media, unusual]);
  for (const path of media) f.write(path, 'after\n');
  const presentation = f.classify(f.commit());
  assert.equal(presentation.scope, 'presentation');
  assert.equal(presentation.paths.length, 305);
  f.write(unusual, 'protected change\n');
  const full = f.classify(f.commit());
  assert.equal(full.scope, 'full');
  assert.deepEqual(full.paths, [...media, unusual].sort());
});

test('manual dispatch and empty diffs always require full and web', t => {
  const f = fixture(t);
  f.write(css, 'after\n');
  const manual = f.classify(f.commit(), 'workflow_dispatch');
  assert.equal(manual.scope, 'full');
  assert.equal(manual.webRequired, true);
  assert.equal(manual.reason, 'manual-event');
  assert.equal(f.classify(f.base).scope, 'full');
});

test('missing, malformed, absent, non-commit and non-ancestor identifiers fail closed', t => {
  const f = fixture(t);
  const input = { base: f.base, head: f.base, event: 'pull_request', cwd: f.cwd };
  for (const base of [undefined, '', 'HEAD', '0'.repeat(40), f.git('rev-parse', `${f.base}:${css}`)]) {
    assert.throws(() => classifyCiChanges({ ...input, base }));
  }
  for (const head of [undefined, 'HEAD', '0'.repeat(40)]) assert.throws(() => classifyCiChanges({ ...input, head }));
  assert.throws(() => classifyCiChanges({ ...input, event: 'pull_request_target' }));
  const orphan = f.git('commit-tree', `${f.base}^{tree}`, '-m', 'unrelated');
  assert.throws(() => classifyCiChanges({ ...input, base: orphan }), /ancestor/);
});

test('replacement objects and external diff configuration cannot conceal a protected change', t => {
  const f = fixture(t, ['config/pack-provider.json']);
  f.write('config/pack-provider.json', 'after\n');
  const head = f.commit();
  const replacement = f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'empty replacement');
  f.git('replace', head, replacement);
  f.git('config', 'diff.external', 'must-not-execute-ci-scope');
  const result = f.classify(head);
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.paths, ['config/pack-provider.json']);
});

test('standalone CLI emits exact JSON and only the four documented GitHub outputs', t => {
  const f = fixture(t);
  f.write(css, 'after\n');
  const head = f.commit();
  const output = join(f.cwd, 'github-output');
  writeFileSync(output, 'existing=value\n');
  const args = [classifier, '--base', f.base, '--head', head, '--event', 'pull_request'];
  const run = spawnSync(process.execPath, [...args, '--github-output', output], { cwd: f.cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), f.classify(head));
  assert.equal(readFileSync(output, 'utf8'), `existing=value\nscope=presentation\nweb-required=true\nbase=${f.base}\nhead=${head}\n`);
  for (const invalid of [[], [...args.slice(1), '--unknown', 'value'], [...args.slice(1), '--base', f.base]]) {
    const refused = spawnSync(process.execPath, [classifier, ...invalid], { cwd: f.cwd, env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
  }
});
