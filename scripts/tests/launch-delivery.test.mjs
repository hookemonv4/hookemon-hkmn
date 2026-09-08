import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { assembleLaunchDelivery, verifyLaunchDelivery } from '../programmable/lib/launch-delivery.mjs';

function fixture(t) {
  const base = mkdtempSync(resolve(tmpdir(), 'launch-delivery-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = resolve(base, 'repository'), output = resolve(base, 'snapshot');
  mkdirSync(root);
  const put = (name, value) => { const path = resolve(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' };
  put('packages/contracts/src/Hook.sol', 'contract Hook {}\n');
  put('release/phase3/build-info/launch.json', { settings, sources: { 'src/Hook.sol': { content: 'contract Hook {}\n' } } });
  for (const name of ['token', 'custody', 'hook']) put(`release/phase3/artifacts/${name}.json`, { deployedBytecode: { object: '0x60006000' }, metadata: { settings } });
  put('release/phase3/package/create-request.json', { nonce: null, fundingPlan: null });
  put('release/phase3/package/package-manifest.json', { status: 'ADDRESS_DERIVATION_PENDING', unverified: [] });
  put('release/phase3/launch-inputs.json', { roles: {}, metadata: {}, token: {}, openFacts: ['Unselected funding'] });
  put('scripts/programmable/example.mjs', 'export const value = 1;\n');
  put('.env', 'PROGRAMMABLE_API_KEY=must-never-enter-a-snapshot\n');
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', 'release', 'scripts', 'packages']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { base, root, output, put, settings, assemble: () => assembleLaunchDelivery({ sourceRoot: root, outputDirectory: output }) };
}

test('copies exact compiler source and release bytes without credentials or readiness claims', t => {
  const f = fixture(t), result = f.assemble();
  assert.equal(result.readyForPreflight, false);
  assert.equal(result.inspection.compilerSourceCount, 1);
  assert.equal(existsSync(resolve(f.output, 'source/.env')), false);
  assert.equal(readFileSync(resolve(f.output, 'source/packages/contracts/src/Hook.sol'), 'utf8'), 'contract Hook {}\n');
  assert.deepEqual(result.inspection.requestNullPaths, ['/nonce', '/fundingPlan']);
  assert.equal(verifyLaunchDelivery({ directory: f.output, sourceRoot: f.root }).freshness, 'CURRENT');
});

test('upstream change invalidates old snapshot and a new snapshot retains the new bytes', t => {
  const f = fixture(t); f.assemble();
  f.put('scripts/programmable/example.mjs', 'export const value = 2;\n');
  const check = verifyLaunchDelivery({ directory: f.output, sourceRoot: f.root });
  assert.equal(check.freshness, 'STALE');
  assert.deepEqual(check.changes, ['scripts/programmable/example.mjs']);
  const next = assembleLaunchDelivery({ sourceRoot: f.root, outputDirectory: resolve(f.base, 'next') });
  assert.notEqual(next.contentSha256, check.contentSha256);
  assert.equal(readFileSync(resolve(f.output, 'source/scripts/programmable/example.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('includes transitive local tool dependencies and invalidates their changes', t => {
  const f = fixture(t);
  f.put('scripts/programmable/example.mjs', "export { value } from '../launch/helper.mjs';\n");
  f.put('scripts/launch/helper.mjs', "import { value } from '../../packages/contracts/tooling/value.mjs'; export { value };\n");
  f.put('packages/contracts/tooling/value.mjs', 'export const value = 1;\n');
  f.assemble();
  assert.equal(existsSync(resolve(f.output, 'source/packages/contracts/tooling/value.mjs')), true);
  f.put('packages/contracts/tooling/value.mjs', 'export const value = 2;\n');
  assert.deepEqual(verifyLaunchDelivery({ directory: f.output, sourceRoot: f.root }).changes, ['packages/contracts/tooling/value.mjs']);
});

test('rejects retained JSON credentials and headers, including text disguised as an image', t => {
  const f = fixture(t);
  for (const value of [
    { PROGRAMMABLE_API_KEY: 'test-secret-not-real-0123456789' },
    { Authorization: 'Bearer test-secret-not-real-0123456789' },
    { privateKey: '0x' + 'ab'.repeat(32) },
  ]) {
    f.put('release/phase3/retained.png', value);
    assert.throws(f.assemble, /credential-like input refused/);
    assert.equal(existsSync(f.output), false);
  }
});

test('refuses stale compiled source before publishing any snapshot', t => {
  const f = fixture(t); f.put('packages/contracts/src/Hook.sol', 'contract Different {}');
  assert.throws(f.assemble, /compiler source differs/);
  assert.equal(existsSync(f.output), false);
});

test('refuses inconsistent compiler settings', t => {
  const f = fixture(t);
  f.put('release/phase3/artifacts/hook.json', { deployedBytecode: { object: '6000' }, metadata: { settings: { ...f.settings, viaIR: false } } });
  assert.throws(f.assemble, /artifact compiler setting mismatch/);
});

test('reports oversized runtime as preparation evidence without admitting it', t => {
  const f = fixture(t);
  f.put('release/phase3/artifacts/hook.json', { deployedBytecode: { object: '60'.repeat(24577) }, metadata: { settings: f.settings } });
  const result = f.assemble();
  assert.equal(result.inspection.artifacts.hook.withinEip170, false);
  assert.equal(result.readyForPreflight, false);
});

test('refuses links, path traversal and accidentally stored private-key material', t => {
  const f = fixture(t);
  symlinkSync(resolve(f.root, '.env'), resolve(f.root, 'scripts/programmable/leak.mjs'));
  assert.throws(f.assemble, /symbolic link refused/);
  rmSync(resolve(f.root, 'scripts/programmable/leak.mjs'));
  f.put('scripts/programmable/leak.mjs', '-----BEGIN PRIVATE KEY-----');
  assert.throws(f.assemble, /credential-like input refused/);
  rmSync(resolve(f.root, 'scripts/programmable/leak.mjs'));
  f.put('release/phase3/build-info/launch.json', { settings: f.settings, sources: { '../../.env': { content: 'secret' } } });
  assert.throws(f.assemble, /unsafe input path/);
});

test('refuses overwrite, source-contained output and altered snapshot bytes', t => {
  const f = fixture(t); f.assemble();
  assert.throws(f.assemble, /output exists/);
  assert.throws(() => assembleLaunchDelivery({ sourceRoot: f.root, outputDirectory: resolve(f.root, 'new') }), /outside source worktree/);
  writeFileSync(resolve(f.output, 'source/scripts/programmable/example.mjs'), 'tampered');
  assert.throws(() => verifyLaunchDelivery({ directory: f.output }), /delivery bytes changed/);
});

test('refuses unlisted files and readiness escalation in a delivery manifest', t => {
  const f = fixture(t); f.assemble();
  writeFileSync(resolve(f.output, 'source/extra.txt'), 'extra');
  assert.throws(() => verifyLaunchDelivery({ directory: f.output }), /unexpected delivery file/);
  rmSync(resolve(f.output, 'source/extra.txt'));
  const path = resolve(f.output, 'manifest.json'), manifest = JSON.parse(readFileSync(path));
  manifest.readyForPreflight = true; writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => verifyLaunchDelivery({ directory: f.output }), /unsupported delivery claims/);
});
