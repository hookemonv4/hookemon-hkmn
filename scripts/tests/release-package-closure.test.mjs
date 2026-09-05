import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  deriveReleasePackageClosure, runVendoredPackageVerifier, verifyVendoredReviewTargetBuilder,
} from '../verify-release-package-closure.mjs';
import { scanTree } from '../check-cleanroom.mjs';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/verify-release-package-closure.mjs');
const reviewTarget = resolve(root, 'release/phase3/review-target.json');
const vendoredBuilder = resolve(root, 'scripts/programmable/vendor/programmable-v4-hook-builder');
const genesisEvidencePath = resolve(root, 'release/phase3/genesis-evidence.json');
const graphGasEvidencePath = resolve(root, 'release/phase3/graph-gas-evidence.json');
const compatibilityReportPath = resolve(root, 'release/phase3/compatibility-report.json');

function run(target = reviewTarget, env = {}) {
  return spawnSync(process.execPath, [script, '--review-target', target], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeDerivedTarget(directory, mutate = null) {
  const target = structuredClone(deriveReleasePackageClosure());
  mutate?.(target);
  const targetPath = join(directory, 'review-target.json');
  writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`);
  return targetPath;
}

function assertProviderGraphProofClosure(paths) {
  assert.equal(
    paths.has('packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol'),
    true,
    'the archive-router gas test must be source-bound',
  );
  assert.equal(
    paths.has('release/phase3/graph-gas-evidence.json'),
    true,
    'the measured graph gas evidence must be source-bound',
  );
}

function assertProviderGraphGasEvidence(graphGasEvidence, genesisEvidence) {
  assert.equal(graphGasEvidence.gasLimitSource.kind, 'conservative-genesis-envelope');
  assert.equal(graphGasEvidence.gasLimitSource.path, 'release/phase3/genesis-evidence.json');
  assert.equal(graphGasEvidence.gasLimitSource.sha256, genesisEvidence.sha256);
  assert.equal(graphGasEvidence.gasLimitSource.blockGasLimit, genesisEvidence.blockGasLimit);
  assert.match(graphGasEvidence.gasLimitSource.reason, /not an archive block-header value/i);
  assert.equal(
    graphGasEvidence.observedTransactionGas,
    graphGasEvidence.observedCalleeGas + graphGasEvidence.intrinsicTransactionGas,
  );
  assert.equal(
    graphGasEvidence.intrinsicTransactionGas,
    graphGasEvidence.transactionBaseGas + graphGasEvidence.calldataGas,
  );
  assert.equal(
    graphGasEvidence.assertedGasEnvelope,
    graphGasEvidence.observedTransactionGas + graphGasEvidence.documentedMargin,
  );
  assert.ok(graphGasEvidence.assertedGasEnvelope < genesisEvidence.blockGasLimit);
}

test('the release closure verifier accepts current review-target file digests', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release package closure verified/);
});

test('the vendored builder contains no clean-room markers', () => {
  const { findings } = scanTree(vendoredBuilder);
  assert.deepEqual(findings, []);
});

test('the compatibility report does not disclose the local checkout path', () => {
  assert.equal(readFileSync(compatibilityReportPath, 'utf8').includes(root), false);
});

test('the release closure verifier rejects a drifted file digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-'));
  const targetPath = writeDerivedTarget(directory, (target) => {
    target.files[0].sha256 = '0'.repeat(64);
  });
  try {
    const result = run(targetPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest mismatch/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier accepts the independently derived builder closure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-'));
  try {
    const result = run(writeDerivedTarget(directory));
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure binds the provider graph gas proof and archive test', () => {
  const paths = new Set(deriveReleasePackageClosure().files.map(({ path }) => path));
  assertProviderGraphProofClosure(paths);
});

test('provider graph gas evidence binds genesis headroom and full transaction gas', () => {
  const graphGasEvidence = JSON.parse(readFileSync(graphGasEvidencePath, 'utf8'));
  const genesisEvidence = JSON.parse(readFileSync(genesisEvidencePath, 'utf8'));
  assertProviderGraphGasEvidence(graphGasEvidence, genesisEvidence);
});

test('provider graph gas evidence rejects an understated transaction total', () => {
  const graphGasEvidence = JSON.parse(readFileSync(graphGasEvidencePath, 'utf8'));
  const genesisEvidence = JSON.parse(readFileSync(genesisEvidencePath, 'utf8'));
  graphGasEvidence.observedTransactionGas -= 1;
  assert.throws(
    () => assertProviderGraphGasEvidence(graphGasEvidence, genesisEvidence),
    /Expected values to be strictly equal/,
  );
});

test('the provider graph closure assertion rejects omitted archive evidence', () => {
  const paths = new Set(deriveReleasePackageClosure().files.map(({ path }) => path));
  paths.delete('packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol');
  assert.throws(() => assertProviderGraphProofClosure(paths), /archive-router gas test must be source-bound/);

  paths.add('packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol');
  paths.delete('release/phase3/graph-gas-evidence.json');
  assert.throws(() => assertProviderGraphProofClosure(paths), /measured graph gas evidence must be source-bound/);
});

test('the release closure binds the TickMath oracle and generated vectors', () => {
  const paths = new Set(deriveReleasePackageClosure().files.map(({ path }) => path));
  assert.equal(
    paths.has('packages/contracts/test/release/PhaseThreePriceOracle.t.sol'),
    true,
    'the TickMath oracle test must be source-bound',
  );
  assert.equal(
    paths.has('packages/contracts/script/release/PhaseThreeTickMathVectors.s.sol'),
    true,
    'the TickMath vector writer must be source-bound through the oracle test',
  );
  assert.equal(
    paths.has('release/phase3/tickmath-vectors.json'),
    true,
    'the generated TickMath vectors must be source-bound',
  );
});

test('the release closure verifier ignores ambient builder locations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-'));
  try {
    const targetPath = writeDerivedTarget(directory);
    const result = run(targetPath, {
      HOME: directory,
      PROGRAMMABLE_V4_HOOK_BUILDER_ROOT: join(directory, 'attacker-controlled-builder'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release package closure verified/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier rejects a changed vendored builder dependency before derivation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-builder-'));
  const builder = join(directory, 'builder');
  try {
    cpSync(vendoredBuilder, builder, { recursive: true });
    const dependency = join(builder, 'scripts/submission-core.mjs');
    writeFileSync(dependency, `${readFileSync(dependency, 'utf8')}\n// tampered\n`);
    assert.throws(
      () => verifyVendoredReviewTargetBuilder({ builderRoot: builder }),
      /vendored builder (?:byte length|digest) mismatch: scripts\/submission-core\.mjs/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the vendored package verifier runs only after source-tree verification', () => {
  const report = runVendoredPackageVerifier();
  assert.equal(report.validationState, 'COMPLETED');
  assert.equal(report.package, 'release/phase3');
});

test('the vendored package verifier rejects a source mutation before execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-builder-'));
  const builder = join(directory, 'builder');
  try {
    cpSync(vendoredBuilder, builder, { recursive: true });
    const dependency = join(builder, 'scripts', 'cli-args.mjs');
    writeFileSync(dependency, `${readFileSync(dependency, 'utf8')}\nexport const PACKAGE_VERIFIER_MUTATION = true;\n`);

    assert.throws(
      () => runVendoredPackageVerifier({ builderRoot: builder }),
      /vendored builder (?:byte length|digest) mismatch: scripts\/cli-args\.mjs/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier rejects a changed vendored package-verifier dependency', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-builder-'));
  const builder = join(directory, 'builder');
  try {
    cpSync(vendoredBuilder, builder, { recursive: true });
    const dependency = join(builder, 'scripts/cli-args.mjs');
    writeFileSync(dependency, `${readFileSync(dependency, 'utf8')}\n// tampered\n`);
    assert.throws(
      () => verifyVendoredReviewTargetBuilder({ builderRoot: builder }),
      /vendored builder (?:byte length|digest) mismatch: scripts\/cli-args\.mjs/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier rejects an unlisted vendored builder file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-builder-'));
  const builder = join(directory, 'builder');
  try {
    cpSync(vendoredBuilder, builder, { recursive: true });
    writeFileSync(join(builder, 'scripts/unlisted-builder-input.mjs'), 'export const unlisted = true;\n');
    assert.throws(
      () => verifyVendoredReviewTargetBuilder({ builderRoot: builder }),
      /vendored builder manifest does not enumerate its source files/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier rejects a one-file review target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-'));
  try {
    const result = run(writeDerivedTarget(directory, (target) => {
      target.files = target.files.slice(0, 1);
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /closure file set mismatch/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier rejects duplicate closure entries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-'));
  try {
    const result = run(writeDerivedTarget(directory, (target) => {
      target.files.push(structuredClone(target.files[0]));
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate closure file/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release closure verifier rejects closure metadata and resolution mutations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-closure-'));
  const mutations = [
    ['closure status mismatch', (target) => { target.closure.status = 'incomplete'; }],
    ['closure diagnostics mismatch', (target) => { target.closure.diagnostics = [{ code: 'synthetic' }]; }],
    ['import resolutions mismatch', (target) => { target.importResolutions = target.importResolutions.slice(1); }],
    ['review target hash mismatch', (target) => { target.reviewTargetHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'; }],
  ];
  try {
    for (const [expected, mutate] of mutations) {
      const targetPath = writeDerivedTarget(directory, mutate);
      const result = run(targetPath);
      assert.notEqual(result.status, 0, expected);
      assert.match(result.stderr, new RegExp(expected, 'i'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
