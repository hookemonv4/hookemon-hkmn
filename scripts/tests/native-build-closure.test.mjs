import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collectNativeBuildClosure } from '../programmable/lib/native-build-closure.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, sourceRoot = '.') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-build-closure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(path, bytes) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes, { mode: 0o644 }); }
  const sources = { 'src/Main.sol': { content: 'pragma solidity ^0.8.26; import {Dep} from "../lib/Dep.sol"; contract Main is Dep {}\n' },
    'lib/Dep.sol': { content: 'pragma solidity ^0.8.26; contract Dep {}\n' } };
  const input = { language: 'Solidity', sources, settings: { libraries: {}, remappings: [], optimizer: { enabled: true, runs: 200 } } };
  const physical = key => sourceRoot === '.' ? key : `${sourceRoot}/${key}`;
  for (const [path, source] of Object.entries(sources)) write(physical(path), source.content);
  // Synthetic binary bytes prove inventory mechanics only; never executed or called approved.
  write('tools/solc', Buffer.from([0, 1, 2, 3]));
  write('build/input.json', JSON.stringify(input));
  write('config/toolchain.lock', 'synthetic locked build tool\n');
  function entry(path) { const bytes = readFileSync(join(root, path)); return { path, kind: 'file', mode: '100644', byteLength: String(bytes.length), contentSha256: `sha256:${hash(bytes)}`, symlinkTarget: null }; }
  const options = { root, sourceRoot, compilerPath: 'tools/solc', compilerSha256: `0x${hash(readFileSync(join(root, 'tools/solc')))}`,
    standardInputPath: 'build/input.json', excludedOutputPaths: ['release/final.json', 'release/final-output'],
    sourceBundleManifest: { schemaVersion: '2.0.0', entries: [entry('config/toolchain.lock')] } };
  function updateInput() { write('build/input.json', JSON.stringify(input)); }
  return { root, options, input, write, entry, updateInput, physical };
}
test('collects the sorted union of exact compiler, input, embedded sources and every bundle byte', t => {
  const f = fixture(t); f.options.sourceBundleManifest.entries.push(f.entry('src/Main.sol'));
  const result = collectNativeBuildClosure(f.options);
  assert.deepEqual(Object.keys(result).sort(), ['sourceBytes', 'sourceClosure']);
  assert.deepEqual(result.sourceClosure.files.map(file => file.path), ['build/input.json', 'config/toolchain.lock', 'lib/Dep.sol', 'src/Main.sol', 'tools/solc']);
  for (const file of result.sourceClosure.files) {
    assert.deepEqual(result.sourceBytes[file.path], readFileSync(join(f.root, file.path)));
    assert.equal(file.sha256, `0x${hash(result.sourceBytes[file.path])}`);
  }
  assert.equal(result.sourceClosure.compilerPath, f.options.compilerPath);
  assert.equal(result.sourceClosure.standardInputPath, f.options.standardInputPath);
});
test('maps compiler source units beneath explicit sourceRoot while retaining logical byte keys', t => {
  const f = fixture(t, 'packages/contracts');
  f.options.sourceBundleManifest.entries.push(f.entry('packages/contracts/src/Main.sol'));
  const result = collectNativeBuildClosure(f.options);
  assert.deepEqual(result.sourceBytes['src/Main.sol'], result.sourceBytes['packages/contracts/src/Main.sol']);
  assert.equal(result.sourceClosure.files.length, 6);
});
for (const [name, change, expected] of [
  ['missing compiler', f => rmSync(join(f.root, 'tools/solc')), /ENOENT/],
  ['omitted compiler argument', f => delete f.options.compilerPath, /relative POSIX/],
  ['wrong compiler digest', f => f.options.compilerSha256 = `0x${'f'.repeat(64)}`, /compiler SHA-256 mismatch/],
  ['omitted source file', f => rmSync(join(f.root, 'lib/Dep.sol')), /ENOENT/],
  ['rebound embedded bytes', f => f.write('src/Main.sol', 'contract Changed {}'), /embedded source bytes mismatch/],
  ['missing bundle byte', f => rmSync(join(f.root, 'config/toolchain.lock')), /ENOENT/],
  ['rebound bundle bytes', f => f.write('config/toolchain.lock', 'different'), /bundle filesystem mismatch/],
  ['bundle file mode', f => chmodSync(join(f.root, 'config/toolchain.lock'), 0o755), /bundle filesystem mismatch/],
  ['bundle declared size', f => f.options.sourceBundleManifest.entries[0].byteLength = '1', /bundle filesystem mismatch/],
  ['duplicate bundle path', f => f.options.sourceBundleManifest.entries.push(f.options.sourceBundleManifest.entries[0]), /unique/],
  ['URL-only source', f => { f.input.sources['src/Main.sol'] = { urls: ['https://example.invalid/Main.sol'] }; f.updateInput(); }, /inline content only/],
  ['content plus URL', f => { f.input.sources['src/Main.sol'].urls = ['Main.sol']; f.updateInput(); }, /inline content only/],
  ['omitted imported source', f => { delete f.input.sources['lib/Dep.sol']; f.updateInput(); }, /external callback/],
  ['external libraries', f => { f.input.settings.libraries = { 'lib/Dep.sol': { Dep: `0x${'1'.repeat(40)}` } }; f.updateInput(); }, /external library/],
  ['callback option', f => { f.input.importCallback = 'external'; f.updateInput(); }, /inline Solidity/],
  ['compiler escape', f => f.options.compilerPath = '../solc', /relative POSIX/],
  ['absolute source root', f => f.options.sourceRoot = '/private/tmp', /relative POSIX/],
  ['source root escape', f => f.options.sourceRoot = '../outside', /relative POSIX/],
  ['missing explicit exclusions', f => delete f.options.excludedOutputPaths, /excluded output/],
  ['direct forbidden compiler', f => f.options.excludedOutputPaths.push('tools/solc'), /forbidden output/],
  ['forbidden standard input', f => f.options.excludedOutputPaths.push('build/input.json'), /forbidden output/],
  ['forbidden embedded source', f => f.options.excludedOutputPaths.push('lib/Dep.sol'), /forbidden output/],
  ['forbidden output inside bundle', f => { f.write('release/final.json', '{}'); f.options.sourceBundleManifest.entries.push(f.entry('release/final.json')); }, /forbidden output/],
  ['forbidden directory inside bundle', f => { f.write('release/final-output/runtime.json', '{}'); f.options.sourceBundleManifest.entries.push(f.entry('release/final-output/runtime.json')); }, /forbidden output/],
]) test(`refuses ${name}`, t => { const f = fixture(t); change(f); assert.throws(() => collectNativeBuildClosure(f.options), expected); });
for (const kind of ['leaf', 'component', 'root', 'sourceRoot']) test(`refuses a symlink in the ${kind}`, t => {
  const f = fixture(t);
  if (kind === 'leaf') { f.write('tools/other', Buffer.from([0, 1, 2, 3])); rmSync(join(f.root, 'tools/solc')); symlinkSync('other', join(f.root, 'tools/solc')); }
  if (kind === 'component') { f.write('other/solc', Buffer.from([0, 1, 2, 3])); rmSync(join(f.root, 'tools'), { recursive: true }); symlinkSync('other', join(f.root, 'tools')); }
  if (kind === 'root') { const alias = `${f.root}-alias`; symlinkSync(f.root, alias); t.after(() => rmSync(alias)); f.options.root = alias; }
  if (kind === 'sourceRoot') { symlinkSync('src', join(f.root, 'alias')); f.options.sourceRoot = 'alias'; }
  assert.throws(() => collectNativeBuildClosure(f.options), /regular file|real directory/);
});
test('refuses identical bytes at an ambiguous logical versus repository bundle key', t => {
  const f = fixture(t, 'packages/contracts');
  f.write('src/Main.sol', f.input.sources['src/Main.sol'].content);
  f.options.sourceBundleManifest.entries.push(f.entry('src/Main.sol'));
  assert.throws(() => collectNativeBuildClosure(f.options), /ambiguous/);
});
test('checks physical mapped paths against forbidden outputs', t => {
  const f = fixture(t, 'packages/contracts'); f.options.excludedOutputPaths.push('packages/contracts/src/Main.sol');
  assert.throws(() => collectNativeBuildClosure(f.options), /forbidden output/);
});
test('refuses duplicate source keys before JSON parsing can discard them', t => {
  const f = fixture(t); f.write('build/input.json', '{"language":"Solidity","sources":{"A.sol":{"content":""},"A.sol":{"content":""}}}');
  assert.throws(() => collectNativeBuildClosure(f.options), /duplicate standard-input key/);
});
test('resolves remapped imports and ignores comments and strings mentioning imports', t => {
  const f = fixture(t);
  f.input.sources['src/Main.sol'].content = '// import "missing.sol";\nimport "@dep/Dep.sol"; contract Main { string constant x = "import ghost"; }';
  f.input.settings.remappings = ['@dep/=lib/']; f.write('src/Main.sol', f.input.sources['src/Main.sol'].content); f.updateInput();
  assert.equal(collectNativeBuildClosure(f.options).sourceClosure.files.length, 5);
  f.input.settings.remappings = ['@dep/=elsewhere/']; f.updateInput();
  assert.throws(() => collectNativeBuildClosure(f.options), /external callback/);
});
test('applies context remappings and longest-prefix selection without a second remap', t => {
  const f = fixture(t);
  f.input.sources['src/Main.sol'].content = 'import "@dep/deep/Dep.sol"; contract Main {}';
  f.write('src/Main.sol', f.input.sources['src/Main.sol'].content);
  f.input.settings.remappings = ['@dep/=missing/', 'src/:@dep/deep/=lib/', 'lib/=not-applied/']; f.updateInput();
  assert.equal(collectNativeBuildClosure(f.options).sourceClosure.files.length, 5);
  f.input.settings.remappings[1] = 'other/:@dep/deep/=lib/'; f.updateInput();
  assert.throws(() => collectNativeBuildClosure(f.options), /external callback/);
});
test('checks the bundle content hash independently of unchanged size and mode', t => {
  const f = fixture(t); f.options.sourceBundleManifest.entries[0].contentSha256 = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => collectNativeBuildClosure(f.options), /bundle filesystem mismatch/);
});
