import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTrackedProjectFiles } from './helpers/tracked-project.mjs';

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function project() {
  const root = tempDir('v4-tracked-project-source-');
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  return root;
}

test('tracked project copy retains regular files and internal symlinks but excludes ignored files', () => {
  const source = project();
  const target = tempDir('v4-tracked-project-target-');
  writeFileSync(join(source, 'tracked.txt'), 'tracked');
  symlinkSync('tracked.txt', join(source, 'tracked-link'));
  mkdirSync(join(source, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(join(source, 'node_modules', 'ignored', 'sentinel.txt'), 'ignored');
  execFileSync('git', ['-C', source, 'add', 'tracked.txt', 'tracked-link']);

  copyTrackedProjectFiles(source, target);

  assert.equal(readFileSync(join(target, 'tracked.txt'), 'utf8'), 'tracked');
  assert.ok(lstatSync(join(target, 'tracked-link')).isSymbolicLink());
  assert.equal(readFileSync(join(target, 'tracked-link'), 'utf8'), 'tracked');
  assert.equal(existsSync(join(target, 'node_modules', 'ignored', 'sentinel.txt')), false);
});

test('tracked project copy ignores gitlinks whose contents are not tracked by the superproject', () => {
  const source = project();
  const target = tempDir('v4-tracked-project-target-');
  execFileSync('git', [
    '-C', source, 'update-index', '--add', '--cacheinfo',
    '160000,1111111111111111111111111111111111111111,vendor/dependency',
  ]);

  copyTrackedProjectFiles(source, target);

  assert.equal(existsSync(join(target, 'vendor', 'dependency')), false);
});

test('tracked project copy rejects tracked symlinks that point outside the project', () => {
  const source = project();
  const target = tempDir('v4-tracked-project-target-');
  symlinkSync('/private/tmp', join(source, 'outside-link'));
  execFileSync('git', ['-C', source, 'add', 'outside-link']);

  assert.throws(() => copyTrackedProjectFiles(source, target), /symlink escapes project root/);
});

test('tracked project copy rejects a tracked file reached through an external parent symlink', () => {
  const source = project();
  const target = tempDir('v4-tracked-project-target-');
  const external = tempDir('v4-tracked-project-external-');
  mkdirSync(join(source, 'nested'));
  writeFileSync(join(source, 'nested', 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', source, 'add', 'nested/tracked.txt']);
  writeFileSync(join(external, 'tracked.txt'), 'external');
  rmSync(join(source, 'nested'), { recursive: true, force: true });
  symlinkSync(external, join(source, 'nested'));

  assert.throws(() => copyTrackedProjectFiles(source, target), /path escapes project root/);
});

test('tracked project copy rejects tracked symlink chains that end outside the project', () => {
  const source = project();
  const target = tempDir('v4-tracked-project-target-');
  const external = tempDir('v4-tracked-project-external-');
  symlinkSync(external, join(source, 'bridge'));
  symlinkSync('bridge', join(source, 'tracked-link'));
  execFileSync('git', ['-C', source, 'add', 'tracked-link']);

  assert.throws(() => copyTrackedProjectFiles(source, target), /symlink escapes project root/);
});

test('tracked project copy rejects source and target roots that overlap', () => {
  const source = project();
  writeFileSync(join(source, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', source, 'add', 'tracked.txt']);

  assert.throws(
    () => copyTrackedProjectFiles(source, join(source, 'fixture')),
    /source and target roots must not overlap/,
  );
});

test('tracked project copy rejects an aliased target inside the source before creating it', () => {
  const source = project();
  const targetParent = tempDir('v4-tracked-project-target-parent-');
  writeFileSync(join(source, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', source, 'add', 'tracked.txt']);
  symlinkSync(source, join(targetParent, 'source-alias'));

  assert.throws(
    () => copyTrackedProjectFiles(source, join(targetParent, 'source-alias', 'fixture')),
    /target path must not contain symlinks/,
  );
  assert.equal(existsSync(join(source, 'fixture')), false);
});

test('tracked project copy rejects a target child symlink before creating external directories', () => {
  const source = project();
  const target = tempDir('v4-tracked-project-target-');
  const external = tempDir('v4-tracked-project-external-');
  mkdirSync(join(source, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(source, 'nested', 'deeper', 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', source, 'add', 'nested/deeper/tracked.txt']);
  symlinkSync(external, join(target, 'nested'));

  assert.throws(
    () => copyTrackedProjectFiles(source, target),
    /target path must not contain symlinks/,
  );
  assert.equal(existsSync(join(external, 'deeper')), false);
});

test('tracked project copy rejects an external target-root alias before creating it', () => {
  const source = project();
  const targetParent = tempDir('v4-tracked-project-target-parent-');
  const external = tempDir('v4-tracked-project-external-');
  writeFileSync(join(source, 'tracked.txt'), 'tracked');
  execFileSync('git', ['-C', source, 'add', 'tracked.txt']);
  symlinkSync(external, join(targetParent, 'external-alias'));

  assert.throws(
    () => copyTrackedProjectFiles(source, join(targetParent, 'external-alias', 'fixture')),
    /target path must not contain symlinks/,
  );
  assert.equal(existsSync(join(external, 'fixture')), false);
});

test('tracked project copy validates deleted tracked files before creating the target', () => {
  const source = project();
  const targetParent = tempDir('v4-tracked-project-target-parent-');
  const target = join(targetParent, 'fixture');
  const tracked = join(source, 'deleted.txt');
  writeFileSync(tracked, 'tracked');
  execFileSync('git', ['-C', source, 'add', 'deleted.txt']);
  rmSync(tracked);

  assert.throws(() => copyTrackedProjectFiles(source, target), /ENOENT/);
  assert.equal(existsSync(target), false);
});
