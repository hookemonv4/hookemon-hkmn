import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  EXCLUDED_DIRECTORY_NAMES,
  EXCLUDED_PATHS,
  SUITES,
  TEST_FILE_SUFFIX,
  TEST_TIMEOUT_MS,
  checkManifest,
  enumerateTestFiles,
  listSuite,
} from '../test-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts', 'test-manifest.mjs');
const workflow = readFileSync(join(root, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
const REQUIRED_SUITES = ['runner', 'adapters', 'dashboard', 'contracts-js', 'contracts-abi', 'scripts'];

function run(args, cwd = root) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function isSorted(files) {
  return files.every((file, index) => index === 0 || files[index - 1] < file);
}

function fixtureRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-test-manifest-'));
  for (const suite of Object.values(SUITES)) {
    for (const suiteRoot of suite.roots) {
      mkdirSync(join(directory, suiteRoot), { recursive: true });
      writeFileSync(join(directory, suiteRoot, 'a.test.mjs'), '');
    }
  }
  return directory;
}

test('the manifest declares the required suites in order with explicit recursive roots', () => {
  assert.deepEqual(Object.keys(SUITES), REQUIRED_SUITES);
  assert.deepEqual(SUITES.runner.roots, ['packages/runner/test']);
  assert.deepEqual(SUITES.adapters.roots, ['packages/adapters/test']);
  assert.deepEqual(SUITES.dashboard.roots, ['packages/dashboard/test']);
  assert.deepEqual(SUITES['contracts-js'].roots, ['packages/contracts/test-js', 'packages/contracts/test/blind']);
  assert.deepEqual(SUITES['contracts-abi'].roots, ['packages/contracts/test/process']);
  assert.deepEqual(SUITES.scripts.roots, ['scripts/tests']);
  for (const suite of Object.values(SUITES)) {
    for (const suiteRoot of suite.roots) {
      assert.doesNotMatch(suiteRoot, /[*?{}]/, 'suite roots are directories, not globs');
    }
  }
  assert.equal(TEST_FILE_SUFFIX, '.test.mjs');
  assert.equal(TEST_TIMEOUT_MS, 120000);
  assert.deepEqual([...EXCLUDED_PATHS], ['packages/contracts/lib']);
  assert.ok(EXCLUDED_DIRECTORY_NAMES.has('node_modules'));
  assert.ok(EXCLUDED_DIRECTORY_NAMES.has('.git'));
  assert.ok(EXCLUDED_DIRECTORY_NAMES.has('.worktrees'));
});

test('every suite is non-empty, sorted, explicit, and together they cover every test file in the repository', () => {
  const report = checkManifest(root);

  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.orphans, []);
  for (const name of REQUIRED_SUITES) {
    const files = report.suites[name].files;
    assert.ok(files.length > 0, `${name} must list at least one test file`);
    assert.ok(isSorted(files), `${name} must be sorted`);
    for (const file of files) {
      assert.doesNotMatch(file, /[*?{}]/);
      assert.ok(file.endsWith(TEST_FILE_SUFFIX), file);
      assert.ok(existsSync(join(root, file)), file);
    }
  }
  const adapters = report.suites.adapters.files;
  assert.ok(adapters.some(file => /^packages\/adapters\/test\/[^/]+\.test\.mjs$/.test(file)), 'adapters root tests');
  assert.ok(adapters.some(file => file.startsWith('packages/adapters/test/app/')), 'adapters app tests');
  assert.ok(adapters.some(file => file.startsWith('packages/adapters/test/signing/')), 'adapters signing tests');
  const runner = report.suites.runner.files;
  for (const directory of ['automation', 'config', 'cycle', 'distribution', 'integration', 'observability', 'operator', 'scheduler']) {
    assert.ok(runner.some(file => file.startsWith(`packages/runner/test/${directory}/`)), `runner ${directory} tests`);
  }
  assert.ok(report.suites.scripts.files.includes('scripts/tests/test-manifest.test.mjs'));
});

test('enumeration is recursive, sorted by code unit, and skips excluded directories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-test-enumeration-'));
  try {
    mkdirSync(join(directory, 'suite', 'nested', 'deeper'), { recursive: true });
    mkdirSync(join(directory, 'suite', 'node_modules'), { recursive: true });
    writeFileSync(join(directory, 'suite', 'b.test.mjs'), '');
    writeFileSync(join(directory, 'suite', 'a.test.mjs'), '');
    writeFileSync(join(directory, 'suite', 'nested', 'deeper', 'z.test.mjs'), '');
    writeFileSync(join(directory, 'suite', 'nested', 'helper.mjs'), '');
    writeFileSync(join(directory, 'suite', 'node_modules', 'ignored.test.mjs'), '');

    assert.deepEqual(enumerateTestFiles(directory, 'suite'), [
      'suite/a.test.mjs',
      'suite/b.test.mjs',
      'suite/nested/deeper/z.test.mjs',
    ]);
    assert.deepEqual(enumerateTestFiles(directory, 'missing'), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the manifest rejects a symbolic repository root', () => {
  const directory = fixtureRoot();
  const linkParent = mkdtempSync(join(tmpdir(), 'hookemon-test-manifest-root-link-'));
  const link = join(linkParent, 'repository');
  try {
    symlinkSync(directory, link, 'dir');

    assert.throws(() => enumerateTestFiles(link, 'scripts/tests'), /repository root must not be a symbolic link/);
    const report = checkManifest(link);
    assert.equal(report.ok, false);
    assert.match(report.errors.join('\n'), /repository root must not be a symbolic link/);
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the manifest rejects a symbolic suite root even when it points to a populated in-repository directory', () => {
  const directory = fixtureRoot();
  try {
    const suiteRoot = join(directory, 'packages', 'dashboard', 'test');
    const target = join(directory, 'dashboard-target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'target.test.mjs'), '');
    rmSync(suiteRoot, { recursive: true, force: true });
    symlinkSync(target, suiteRoot, 'dir');

    assert.throws(() => enumerateTestFiles(directory, 'packages/dashboard/test'), /symbolic link: packages\/dashboard\/test/);
    const report = checkManifest(directory);
    assert.equal(report.ok, false);
    assert.match(report.errors.join('\n'), /symbolic link: packages\/dashboard\/test/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the manifest rejects a nested symbolic link, including one that resolves outside the repository root', () => {
  const directory = fixtureRoot();
  const outside = mkdtempSync(join(tmpdir(), 'hookemon-test-manifest-outside-'));
  try {
    writeFileSync(join(outside, 'outside.test.mjs'), '');
    const nested = join(directory, 'scripts', 'tests', 'linked');
    symlinkSync(outside, nested, 'dir');

    assert.throws(() => enumerateTestFiles(directory, 'scripts/tests'), /symbolic link: scripts\/tests\/linked/);
    const report = checkManifest(directory);
    assert.equal(report.ok, false);
    assert.match(report.errors.join('\n'), /symbolic link: scripts\/tests\/linked/);
    assert.throws(() => enumerateTestFiles(directory, '../outside'), /escapes repository root/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('check fails for a test file that belongs to no suite', () => {
  const directory = fixtureRoot();
  try {
    assert.equal(checkManifest(directory).ok, true);
    mkdirSync(join(directory, 'packages', 'orphan', 'test'), { recursive: true });
    writeFileSync(join(directory, 'packages', 'orphan', 'test', 'lonely.test.mjs'), '');

    const report = checkManifest(directory);

    assert.equal(report.ok, false);
    assert.deepEqual(report.orphans, ['packages/orphan/test/lonely.test.mjs']);
    assert.match(report.errors.join('\n'), /packages\/orphan\/test\/lonely\.test\.mjs is not in any suite/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check fails for an empty suite root', () => {
  const directory = fixtureRoot();
  try {
    rmSync(join(directory, 'packages', 'dashboard', 'test'), { recursive: true, force: true });

    const report = checkManifest(directory);

    assert.equal(report.ok, false);
    assert.match(report.errors.join('\n'), /suite dashboard has no test files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check rejects a missing suite root even when another root covers the same suite', () => {
  const directory = fixtureRoot();
  try {
    rmSync(join(directory, 'packages', 'contracts', 'test', 'blind'), { recursive: true, force: true });

    const report = checkManifest(directory);

    assert.equal(report.ok, false);
    assert.match(report.errors.join('\n'), /test suite root must exist: packages\/contracts\/test\/blind/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check rejects an empty suite root even when another root covers the same suite', () => {
  const directory = fixtureRoot();
  try {
    rmSync(join(directory, 'packages', 'contracts', 'test', 'blind', 'a.test.mjs'), { force: true });

    const report = checkManifest(directory);

    assert.equal(report.ok, false);
    assert.match(report.errors.join('\n'), /suite root packages\/contracts\/test\/blind has no test files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check rejects a test path claimed by more than one suite', () => {
  const directory = fixtureRoot();
  try {
    const suitesWithDuplicateOwner = {
      ...SUITES,
      duplicate: { roots: ['packages/runner/test'] },
    };

    const report = checkManifest(directory, suitesWithDuplicateOwner);

    assert.equal(report.ok, false);
    assert.match(
      report.errors.join('\n'),
      /packages\/runner\/test\/a\.test\.mjs belongs to multiple suites: runner, duplicate/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check ignores test files under the excluded contract dependency tree', () => {
  const directory = fixtureRoot();
  try {
    mkdirSync(join(directory, 'packages', 'contracts', 'lib', 'vendor', 'test'), { recursive: true });
    writeFileSync(join(directory, 'packages', 'contracts', 'lib', 'vendor', 'test', 'vendor.test.mjs'), '');

    assert.equal(checkManifest(directory).ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('list prints one sorted path per line and rejects unknown, empty, or missing suite roots', () => {
  const listed = run(['list', 'scripts']);
  assert.equal(listed.status, 0, listed.stderr);
  const lines = listed.stdout.trimEnd().split('\n');
  assert.deepEqual(lines, listSuite(root, 'scripts'));
  assert.ok(isSorted(lines));

  const unknown = run(['list', 'nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown suite nope/);

  const emptyDirectory = fixtureRoot();
  try {
    rmSync(join(emptyDirectory, 'scripts', 'tests', 'a.test.mjs'), { force: true });
    const empty = run(['list', 'scripts'], emptyDirectory);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /suite root scripts\/tests has no test files/);
    assert.equal(empty.stdout, '');
  } finally {
    rmSync(emptyDirectory, { recursive: true, force: true });
  }

  const missingDirectory = fixtureRoot();
  try {
    rmSync(join(missingDirectory, 'scripts', 'tests'), { recursive: true, force: true });
    const missing = run(['list', 'scripts'], missingDirectory);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /test suite root must exist: scripts\/tests/);
    assert.equal(missing.stdout, '');
  } finally {
    rmSync(missingDirectory, { recursive: true, force: true });
  }
  assert.throws(() => listSuite(root, 'nope'), /unknown suite nope/);
});

test('check exits nonzero and names the orphan from the command line', () => {
  const directory = fixtureRoot();
  try {
    assert.equal(run(['check'], directory).status, 0);
    mkdirSync(join(directory, 'stray'), { recursive: true });
    writeFileSync(join(directory, 'stray', 'x.test.mjs'), '');
    const result = run(['check'], directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stray\/x\.test\.mjs is not in any suite/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const usage = run([]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage/);
});

test('CI runs every suite from the manifest with the required timeout and no globs', () => {
  assert.match(workflow, /node scripts\/test-manifest\.mjs check/);
  for (const name of REQUIRED_SUITES) {
    const list = `files="$(node scripts/test-manifest.mjs list ${name})"`;
    assert.ok(workflow.includes(list), `${name} must be listed from the manifest`);
    const following = workflow.slice(workflow.indexOf(list) + list.length).split('\n')[1];
    assert.match(following, /node --test --test-timeout=120000 \$files$/, `${name} must run with the required timeout`);
  }
  assert.doesNotMatch(workflow, /\*\*/);
  assert.doesNotMatch(workflow, /\*\.test\.mjs/);
});
