#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const VENDORED_BUILDER_PATH = 'scripts/programmable/vendor/programmable-v4-hook-builder';
const VENDORED_BUILDER_MANIFEST_PATH = `${VENDORED_BUILDER_PATH}/manifest.json`;
const VENDORED_BUILDER_ENTRYPOINT = 'scripts/cli-review-target.mjs';
const VENDORED_BUILDER_PACKAGE_VERIFIER = 'scripts/verify-package.mjs';
const VENDORED_BUILDER_MANIFEST_SHA256 = 'd3dd54f13b39f251a1cabb1253b19d155075409f68671eec07790eff12375c5b';
const VENDORED_BUILDER_SOURCE_TREE_SHA256 = '4795ee279dec6ae22e047e6fe6c032b85f242cc96797f40d4560f70b6e8559ae';
const VENDORED_BUILDER_SOURCE = Object.freeze({
  repositorySha256: '7cfbbd3098251021760b48e6bb57b934c9f8fbbb58dc2b053a2440dc0408cc19',
  ref: 'refs/tags/v0.4.0',
  tree: '237a64de92efdb0e84954e42c654f83f926e82c3',
  path: 'skills/programmable-v4-hook-builder',
  normalization: 'cleanroom-labels-v1',
});
const VENDORED_BUILDER_UPSTREAM = Object.freeze({
  ...VENDORED_BUILDER_SOURCE,
  version: 'v0.4.0',
});
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isContained(rootPath, candidate) {
  const path = relative(rootPath, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function readRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file`);
  return readFileSync(path);
}

function vendoredBuilderSourcePaths(builderRoot) {
  const paths = [];
  function visit(directory, prefix = '') {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      fail('vendored builder source tree is unavailable');
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`vendored builder source must not be a symlink: ${path}`);
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        if (path !== 'manifest.json') paths.push(path);
      } else {
        fail(`vendored builder source must be a regular file: ${path}`);
      }
    }
  }
  visit(builderRoot);
  return paths.sort();
}

function vendoredBuilderPath(builderRoot, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes('..')
  ) fail(`vendored builder path is invalid: ${String(relativePath)}`);
  const resolved = resolve(builderRoot, relativePath);
  if (!isContained(builderRoot, resolved)) fail(`vendored builder path escapes its root: ${relativePath}`);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`vendored builder entry must be a regular file: ${relativePath}`);
  const physical = realpathSync(resolved);
  if (!isContained(builderRoot, physical) || physical !== resolved) {
    fail(`vendored builder entry must remain inside its root: ${relativePath}`);
  }
  return physical;
}

function vendoredBuilderPin() {
  let pins;
  try {
    pins = JSON.parse(readFileSync(resolve(root, 'product/dependency-pins.json'), 'utf8'));
  } catch {
    fail('release-closure builder pin is unavailable');
  }
  const pin = pins?.controlScripts?.releaseClosureBuilder;
  if (!sameKeys(pin, ['path', 'sha256', 'sourceTreeSha256', 'entrypoint', 'upstream'])) {
    fail('release-closure builder pin must contain exactly path, sha256, sourceTreeSha256, entrypoint, upstream');
  }
  if (pin.path !== VENDORED_BUILDER_MANIFEST_PATH) fail('release-closure builder pin path is invalid');
  if (pin.sha256 !== VENDORED_BUILDER_MANIFEST_SHA256) fail('release-closure builder manifest pin is invalid');
  if (pin.sourceTreeSha256 !== VENDORED_BUILDER_SOURCE_TREE_SHA256) fail('release-closure builder source-tree pin is invalid');
  if (pin.entrypoint !== VENDORED_BUILDER_ENTRYPOINT) fail('release-closure builder entrypoint pin is invalid');
  if (!sameKeys(pin.upstream, Object.keys(VENDORED_BUILDER_UPSTREAM))
    || Object.entries(VENDORED_BUILDER_UPSTREAM).some(([key, value]) => pin.upstream[key] !== value)) {
    fail('release-closure builder upstream pin is invalid');
  }
  return pin;
}

export function verifyVendoredReviewTargetBuilder({
  builderRoot = resolve(root, VENDORED_BUILDER_PATH),
  manifestPath = resolve(builderRoot, 'manifest.json'),
} = {}) {
  const requestedBuilderRoot = resolve(builderRoot);
  const requestedManifestPath = resolve(manifestPath);
  let rootStat;
  try {
    rootStat = lstatSync(requestedBuilderRoot);
  } catch {
    fail('vendored review-target builder is unavailable');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('vendored review-target builder must be a regular directory');
  }
  const physicalBuilderRoot = realpathSync(requestedBuilderRoot);
  const defaultBuilderRoot = resolve(root, VENDORED_BUILDER_PATH);
  if (
    requestedBuilderRoot === defaultBuilderRoot
    && !isContained(realpathSync(root), physicalBuilderRoot)
  ) fail('vendored review-target builder must be repository-contained');

  const manifestBytes = readRegularFile(requestedManifestPath, 'vendored review-target builder manifest');
  let physicalManifestPath;
  try {
    physicalManifestPath = realpathSync(requestedManifestPath);
  } catch {
    fail('vendored review-target builder manifest is unavailable');
  }
  if (physicalManifestPath !== resolve(physicalBuilderRoot, 'manifest.json')) {
    fail('vendored review-target builder manifest path is invalid');
  }

  const pin = vendoredBuilderPin();
  if (sha256(manifestBytes) !== pin.sha256) fail('vendored review-target builder manifest digest mismatch');

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('vendored review-target builder manifest is invalid JSON');
  }
  if (!sameKeys(manifest, ['schemaVersion', 'name', 'license', 'source', 'entrypoint', 'sourceTreeSha256', 'files'])) {
    fail('vendored review-target builder manifest has an invalid schema');
  }
  if (manifest.schemaVersion !== 1 || manifest.name !== 'programmable-v4-hook-builder-review-target' || manifest.license !== 'MIT') {
    fail('vendored review-target builder manifest identity is invalid');
  }
  if (!sameKeys(manifest.source, Object.keys(VENDORED_BUILDER_SOURCE))
    || Object.entries(VENDORED_BUILDER_SOURCE).some(([key, value]) => manifest.source[key] !== value)) {
    fail('vendored review-target builder source provenance is invalid');
  }
  if (manifest.entrypoint !== pin.entrypoint || manifest.sourceTreeSha256 !== pin.sourceTreeSha256) {
    fail('vendored review-target builder manifest does not match its pin');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('vendored review-target builder manifest must list its source closure');
  }

  const sourceTree = createHash('sha256');
  let previousPath = null;
  let entrypoint = null;
  const declaredPaths = [];
  for (const entry of manifest.files) {
    if (!sameKeys(entry, ['path', 'bytes', 'sha256'])
      || typeof entry.path !== 'string'
      || !Number.isInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
      || !SHA256.test(entry.sha256)) {
      fail('vendored review-target builder manifest has an invalid source record');
    }
    if (previousPath !== null && entry.path <= previousPath) {
      fail('vendored review-target builder manifest source records must be uniquely sorted');
    }
    previousPath = entry.path;
    declaredPaths.push(entry.path);
    const sourcePath = vendoredBuilderPath(physicalBuilderRoot, entry.path);
    const bytes = readRegularFile(sourcePath, `vendored builder source ${entry.path}`);
    if (bytes.byteLength !== entry.bytes) fail(`vendored builder byte length mismatch: ${entry.path}`);
    if (sha256(bytes) !== entry.sha256) fail(`vendored builder digest mismatch: ${entry.path}`);
    sourceTree.update(entry.path);
    sourceTree.update('\0');
    sourceTree.update(bytes);
    sourceTree.update('\0');
    if (entry.path === pin.entrypoint) entrypoint = sourcePath;
  }
  const actualPaths = vendoredBuilderSourcePaths(physicalBuilderRoot);
  if (
    actualPaths.length !== declaredPaths.length
    || actualPaths.some((path, index) => path !== declaredPaths[index])
  ) fail('vendored builder manifest does not enumerate its source files');
  if (entrypoint === null) fail('vendored review-target builder manifest omits its entrypoint');
  if (sourceTree.digest('hex') !== pin.sourceTreeSha256) {
    fail('vendored review-target builder source-tree digest mismatch');
  }
  return { entrypoint, manifestPath: physicalManifestPath };
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function fileRecords(target, label, failures) {
  if (!Array.isArray(target?.files) || target.files.length === 0) {
    failures.push(`${label} files are required`);
    return new Map();
  }
  const records = new Map();
  for (const entry of target.files) {
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || typeof entry.path !== 'string'
      || entry.path.length === 0
      || !Number.isInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
    ) {
      failures.push(`${label} file entry is invalid`);
      continue;
    }
    if (records.has(entry.path)) {
      failures.push(`duplicate closure file: ${entry.path}`);
      continue;
    }
    records.set(entry.path, entry);
  }
  return records;
}

function compareClosureFiles(declared, derived, failures) {
  const declaredRecords = fileRecords(declared, 'review target', failures);
  const derivedRecords = fileRecords(derived, 'derived closure', failures);
  const declaredPaths = [...declaredRecords.keys()].sort();
  const derivedPaths = [...derivedRecords.keys()].sort();
  if (
    declaredPaths.length !== derivedPaths.length
    || declaredPaths.some((path, index) => path !== derivedPaths[index])
  ) failures.push('closure file set mismatch');
  for (const path of declaredPaths) {
    const expected = derivedRecords.get(path);
    const actual = declaredRecords.get(path);
    if (expected && (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)) {
      failures.push(`digest mismatch: ${path}`);
    } else if (expected && !canonicalEqual(actual, expected)) {
      failures.push(`closure file record mismatch: ${path}`);
    }
  }
}

function compareClosureMetadata(declared, derived, failures) {
  for (const field of ['schemaVersion', 'standardVersion', 'submissionHash', 'closureMethod']) {
    if (!canonicalEqual(declared?.[field], derived?.[field])) failures.push(`${field} mismatch`);
  }
  if (!canonicalEqual(declared?.closure?.status, derived?.closure?.status)) failures.push('closure status mismatch');
  if (!canonicalEqual(declared?.closure?.diagnostics, derived?.closure?.diagnostics)) failures.push('closure diagnostics mismatch');
  if (!canonicalEqual(declared?.externalImports, derived?.externalImports)) failures.push('external imports mismatch');
  if (!canonicalEqual(declared?.importResolutions, derived?.importResolutions)) failures.push('import resolutions mismatch');
  if (!canonicalEqual(declared?.javascriptImportResolutions, derived?.javascriptImportResolutions)) failures.push('javascript import resolutions mismatch');
  if (!canonicalEqual(declared?.runtimeAssets, derived?.runtimeAssets)) failures.push('runtime assets mismatch');
  if (!canonicalEqual(declared?.reviewTargetHash, derived?.reviewTargetHash)) failures.push('review target hash mismatch');
}

export function deriveReleasePackageClosure() {
  const builder = verifyVendoredReviewTargetBuilder();
  const result = spawnSync(process.execPath, [builder.entrypoint, root, 'release/phase3'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    const detail = result.stderr?.trim() || result.error?.message || 'unknown error';
    fail(`pinned builder review-target derivation failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('pinned builder review-target derivation returned invalid JSON');
  }
}

export function runVendoredPackageVerifier(options = {}) {
  const builder = verifyVendoredReviewTargetBuilder(options);
  const packageVerifier = vendoredBuilderPath(dirname(builder.manifestPath), VENDORED_BUILDER_PACKAGE_VERIFIER);
  const result = spawnSync(process.execPath, [
    packageVerifier,
    '--repository-root',
    root,
    'release/phase3',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) {
    const detail = result.stderr?.trim() || result.error?.message || 'unknown error';
    fail(`pinned builder package verification failed: ${detail}`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    fail('pinned builder package verification returned invalid JSON');
  }
  if (!isPlainObject(report) || report.validationState !== 'COMPLETED' || report.package !== 'release/phase3') {
    fail('pinned builder package verification returned an invalid report');
  }
  return report;
}

export function validateSubmissionFeeOrdering(launchInputs, submission) {
  const candidates = launchInputs?.pool?.priceCandidates;
  const selection = candidates?.selection;
  const selectedOrdering = selection?.selectedOrdering;
  if (!['usdgCurrency0', 'hkmnCurrency0', null].includes(selectedOrdering)) fail('launch input selection is invalid');
  const effectiveOrdering = selectedOrdering ?? 'usdgCurrency0';
  const selectedCandidate = candidates?.[effectiveOrdering];
  if (selectedCandidate === null || typeof selectedCandidate !== 'object') fail('selected price candidate is missing');
  const expectedPool = effectiveOrdering === 'hkmnCurrency0'
    ? { currency0: 'hkmn', currency1: 'usdg', feeCurrency: 'currency1' }
    : { currency0: 'usdg', currency1: 'hkmn', feeCurrency: 'currency0' };
  if (
    submission?.pool?.currency0 !== expectedPool.currency0
    || submission?.pool?.currency1 !== expectedPool.currency1
  ) fail('submission pool order does not match the selected candidate');
  if (selectedOrdering === null) {
    if (selection.selectedSqrtPriceX96 !== null) fail('draft selection must not bind a candidate price');
  } else if (selection.selectedSqrtPriceX96 !== selectedCandidate.sqrtPriceX96) {
    fail('selected candidate price does not match the selected ordering');
  }
  const selectedQuadrants = selectedCandidate.swapFeeQuadrants;
  if (selectedQuadrants === null || typeof selectedQuadrants !== 'object') fail('selected candidate fee quadrants are missing');
  const quadrants = submission?.hook?.feeMechanism?.swapQuadrants;
  if (quadrants === null || typeof quadrants !== 'object') fail('submission fee quadrants are missing');
  for (const name of ['zeroForOneExactInput', 'zeroForOneExactOutput', 'oneForZeroExactInput', 'oneForZeroExactOutput']) {
    if (selectedQuadrants[name]?.currency !== expectedPool.feeCurrency) {
      fail(`selected candidate fee currency mismatch in ${name}`);
    }
    if (quadrants[name]?.currency !== expectedPool.feeCurrency) fail(`submission fee currency mismatch in ${name}`);
  }
}

export function verifyReleasePackageClosure(reviewTargetPath = resolve(root, 'release/phase3/review-target.json')) {
  let reviewTarget;
  try {
    reviewTarget = JSON.parse(readFileSync(reviewTargetPath, 'utf8'));
  } catch {
    fail('review target is invalid JSON');
  }
  runVendoredPackageVerifier();
  const derived = deriveReleasePackageClosure();
  const failures = [];
  compareClosureFiles(reviewTarget, derived, failures);
  compareClosureMetadata(reviewTarget, derived, failures);
  validateSubmissionFeeOrdering(
    JSON.parse(readFileSync(resolve(root, 'release/phase3/launch-inputs.json'), 'utf8')),
    JSON.parse(readFileSync(resolve(root, 'release/phase3/submission.json'), 'utf8')),
  );
  if (failures.length > 0) fail(failures.join('\n'));
  return { files: reviewTarget.files.length, submissionHash: reviewTarget.submissionHash };
}

function parseArgs(argv) {
  if (argv.length === 0) return resolve(root, 'release/phase3/review-target.json');
  if (argv.length === 2 && argv[0] === '--review-target') return resolve(argv[1]);
  fail('usage: node scripts/verify-release-package-closure.mjs [--review-target <path>]');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = verifyReleasePackageClosure(parseArgs(process.argv.slice(2)));
    process.stdout.write(`release package closure verified: ${result.files} files\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
