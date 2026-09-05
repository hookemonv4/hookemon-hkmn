import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../lib/util.mjs';
import { validatePack, composePacks } from '../lib/packs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const basePack = join(here, '..', '..', 'packs', 'base');
const basePackSha256 = 'fec3e938aa995e1bfc20d26bc2a42e7191176df419eb4bf64820b36337a6f7de';

function contributions(extra = {}) {
  return {
    feasibilityModels: [], gateItems: [], certifiedModules: [], releaseStates: [],
    sourceHierarchy: [], opsTemplates: [], advisories: [], discoveryQuestions: [], phaseAdapters: [],
    ...extra,
  };
}

function writePack(parent, id, overrides = {}) {
  const dir = join(parent, id); mkdirSync(dir);
  writeJson(join(dir, 'pack.json'), {
    id, version: '0.1.0', coreCompat: '>=0.1.0', namespaces: [id], pathOwnership: [],
    dependsOn: [], contributions: contributions(), ...overrides,
  });
  return dir;
}

test('base pack validates', () => {
  assert.deepEqual(validatePack(basePack), { ok: true, errors: [] });
});

test('base pack is vendored inside a sterile repository checkout', () => {
  assert.equal(basePack, join(repoRoot, 'packs', 'base'));
  const bytes = readFileSync(join(basePack, 'pack.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), basePackSha256);
});

test('pack validation and composition share one manifest read path', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'lib', 'packs.mjs'), 'utf8');
  assert.equal(source.match(/\breadJson\s*\(/g)?.length, 1);
});

test('blocking advisories and path conflicts are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  const bad = join(dir, 'bad'); mkdirSync(bad);
  writeJson(join(bad, 'pack.json'), {
    id: 'bad', version: '0.1.0', coreCompat: '>=0.1.0', namespaces: ['base'], pathOwnership: ['ops/'],
    dependsOn: [],
    contributions: contributions({ advisories: [{ id: 'x', blocking: true }] }),
  });
  const v = validatePack(bad);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /advisor/i);
  const twin = join(dir, 'twin'); mkdirSync(twin);
  writeJson(join(twin, 'pack.json'), {
    id: 'twin', version: '0.1.0', coreCompat: '>=0.1.0', namespaces: ['base'], pathOwnership: ['ops/'],
    dependsOn: [],
    contributions: contributions(),
  });
  const c = composePacks([basePack, twin, bad].map(String));
  assert.equal(c.ok, false);
  assert.match(c.errors.join(' '), /namespace|path/i);
});

test('composition rejects a missing pack dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-dependency-'));
  const dependent = writePack(root, 'dependent', { dependsOn: ['missing'] });

  const result = composePacks([dependent]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /dependent.*depends on missing pack missing/i);

  const dependency = writePack(root, 'missing');
  assert.deepEqual(composePacks([dependent, dependency]), { ok: true, errors: [] });
});

test('composition rejects a self dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-self-dependency-'));
  const selfDependent = writePack(root, 'self-dependent', { dependsOn: ['self-dependent'] });

  const result = composePacks([selfDependent]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /self-dependent.*depends on itself/i);
});

test('single-pack validation rejects a self dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-single-self-dependency-'));
  const selfDependent = writePack(root, 'self-dependent', { dependsOn: ['self-dependent'] });

  const result = validatePack(selfDependent);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /self-dependent.*depends on itself/i);
});

test('composition rejects multi-pack dependency cycles without rejecting an acyclic graph', () => {
  const cycles = [
    [['alpha', ['beta']], ['beta', ['alpha']]],
    [['alpha', ['beta']], ['beta', ['gamma']], ['gamma', ['alpha']]],
  ];
  for (const [index, definitions] of cycles.entries()) {
    const root = mkdtempSync(join(tmpdir(), `pack-cycle-${index}-`));
    const dirs = definitions.map(([id, dependsOn]) => writePack(root, id, { dependsOn }));
    const result = composePacks(dirs);
    assert.equal(result.ok, false, JSON.stringify(definitions));
    assert.match(result.errors.join('\n'), /dependency cycle/i);
  }

  const root = mkdtempSync(join(tmpdir(), 'pack-dag-'));
  const alpha = writePack(root, 'alpha');
  const beta = writePack(root, 'beta', { dependsOn: ['alpha'] });
  const gamma = writePack(root, 'gamma', { dependsOn: ['alpha'] });
  const delta = writePack(root, 'delta', { dependsOn: ['beta', 'gamma'] });
  assert.deepEqual(composePacks([delta, gamma, beta, alpha]), { ok: true, errors: [] });
});

test('composition rejects duplicate pack ids even when claims do not overlap', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-id-'));
  const first = writePack(root, 'first', { id: 'shared' });
  const second = writePack(root, 'second', { id: 'shared' });

  const result = composePacks([first, second]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate pack id shared/i);
});

test('validation evaluates supported core compatibility comparisons against this framework', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-compat-'));
  const incompatibleRanges = ['0.2.0', '>0.1.0', '>=0.2.0', '<0.1.0', '<=0.0.9', '>=0.1.0 <0.1.0'];
  for (const [index, coreCompat] of incompatibleRanges.entries()) {
    const dir = writePack(root, `incompatible-${index}`, { coreCompat });
    const result = validatePack(dir);
    assert.equal(result.ok, false, coreCompat);
    assert.match(result.errors.join('\n'), /coreCompat.*0\.1\.0/i);
  }

  const compatibleRanges = ['0.1.0', '=0.1.0', '>=0.1.0', '<=0.1.0', '>=0.1.0 <0.2.0'];
  for (const [index, coreCompat] of compatibleRanges.entries()) {
    const dir = writePack(root, `compatible-${index}`, { coreCompat });
    assert.deepEqual(validatePack(dir), { ok: true, errors: [] }, coreCompat);
  }
});

test('validation rejects malformed core compatibility ranges', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-range-'));
  const malformed = writePack(root, 'malformed-range', { coreCompat: 'latest' });

  const result = validatePack(malformed);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /invalid coreCompat/i);
});

test('composition rejects exact and hierarchical path ownership overlaps in either order', () => {
  const cases = [
    ['src/', 'src/contracts/'],
    ['src/contracts/', 'src/'],
    ['src/contracts/', 'src/contracts/'],
  ];
  for (const [index, [firstPath, secondPath]] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `pack-path-${index}-`));
    const first = writePack(root, 'first', { pathOwnership: [firstPath] });
    const second = writePack(root, 'second', { pathOwnership: [secondPath] });

    const result = composePacks([first, second]);

    assert.equal(result.ok, false, `${firstPath} and ${secondPath}`);
    assert.match(result.errors.join('\n'), /path/i);
  }
});

test('composition case-folds path ownership before collision checks', () => {
  const cases = [
    ['SRC/', 'src/contracts/'],
    ['src/contracts/', 'SRC/'],
    ['Docs/', 'docs/'],
  ];
  for (const [index, [firstPath, secondPath]] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `pack-case-path-${index}-`));
    const first = writePack(root, 'first', { pathOwnership: [firstPath] });
    const second = writePack(root, 'second', { pathOwnership: [secondPath] });
    const result = composePacks([first, second]);
    assert.equal(result.ok, false, `${firstPath} and ${secondPath}`);
    assert.match(result.errors.join('\n'), /path/i);
  }
});

test('validation rejects Windows-ambiguous path segments without rejecting near misses', () => {
  const invalidPaths = [
    'src./', 'src /', 'CON/', 'src/NuL.txt', 'safe/aux.log/child/', 'COM1/', 'com9.txt/',
    'LPT1/', 'lPt9.config/',
  ];
  const root = mkdtempSync(join(tmpdir(), 'pack-windows-path-'));
  for (const [index, path] of invalidPaths.entries()) {
    const dir = writePack(root, `invalid-${index}`, { pathOwnership: [path] });
    const result = validatePack(dir);
    assert.equal(result.ok, false, path);
    assert.match(result.errors.join('\n'), /invalid path/i);
  }

  const validPaths = ['com0/', 'com10/', 'console/', 'lpt0.txt/', 'auxiliary/'];
  for (const [index, path] of validPaths.entries()) {
    const dir = writePack(root, `valid-${index}`, { pathOwnership: [path] });
    assert.deepEqual(validatePack(dir), { ok: true, errors: [] }, path);
  }
});

test('validation fails closed on malformed ids, versions, paths, and collection fields', () => {
  const cases = [
    ['id', { id: '../escape' }],
    ['version', { version: 'v0.1.0' }],
    ['namespace', { namespaces: ['bad namespace'] }],
    ['dependency id', { dependsOn: ['../missing'] }],
    ['path', { pathOwnership: ['../src/'] }],
    ['path', { pathOwnership: ['/src/'] }],
    ['path', { pathOwnership: ['src//contracts/'] }],
    ['path', { pathOwnership: ['src\\contracts/'] }],
    ['namespaces', { namespaces: 'base' }],
    ['dependsOn', { dependsOn: 'base' }],
    ['pathOwnership', { pathOwnership: 'src/' }],
  ];
  const root = mkdtempSync(join(tmpdir(), 'pack-malformed-'));
  for (const [index, [label, overrides]] of cases.entries()) {
    const dir = writePack(root, `case-${index}`, overrides);
    const result = validatePack(dir);
    assert.equal(result.ok, false, `${label}: ${JSON.stringify(overrides)}`);
    assert.match(result.errors.join('\n'), new RegExp(label, 'i'));
  }
});

test('validation returns an error for a malformed manifest root', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-root-'));
  const dir = join(root, 'invalid'); mkdirSync(dir);
  writeJson(join(dir, 'pack.json'), null);

  assert.doesNotThrow(() => validatePack(dir));
  assert.equal(validatePack(dir).ok, false);
  assert.match(validatePack(dir).errors.join('\n'), /manifest/i);
});

test('validation requires contributions to be a non-array object', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-contributions-root-'));
  for (const [index, contributionsValue] of [null, [], 'invalid'].entries()) {
    const dir = writePack(root, `case-${index}`, { contributions: contributionsValue });
    const result = validatePack(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /contributions must be a non-array object/i);
  }
});

test('validation requires every contribution field to be an array', () => {
  const keys = [
    'feasibilityModels', 'gateItems', 'certifiedModules', 'releaseStates', 'sourceHierarchy',
    'opsTemplates', 'advisories', 'discoveryQuestions', 'phaseAdapters',
  ];
  const root = mkdtempSync(join(tmpdir(), 'pack-contribution-arrays-'));
  for (const [index, key] of keys.entries()) {
    const dir = writePack(root, `case-${index}`, { contributions: contributions({ [key]: {} }) });
    const result = validatePack(dir);
    assert.equal(result.ok, false, key);
    assert.match(result.errors.join('\n'), new RegExp(`contributions\\.${key} must be an array`, 'i'));
  }
});
