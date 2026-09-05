import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertCleanDependencyStatus,
  collectSourceArtifacts,
  compareBuildRecords,
  expectedRunnerPaths,
  parseProductionGasReport,
  requireExactGasTestSummary,
  resolveSafeOutputPath,
  summarizeArtifact,
  validateCandidateManifest,
  validateToolchain,
  writeOutputAtomically,
} from '../verify-phase1-reproducibility.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const root = resolve(import.meta.dirname, '../..');

const artifact = {
  abi: [
    { type: 'event', name: 'Paid', anonymous: false, inputs: [{ name: 'amount', type: 'uint256', indexed: true }] },
    { type: 'function', name: 'pay', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  ],
  bytecode: { object: '0x6001600055' },
  deployedBytecode: { object: '0x60016000' },
  gasEstimates: { creation: { codeDepositCost: '800', executionCost: 'infinite', totalCost: 'infinite' } },
  methodIdentifiers: { 'pay()': '1b9265b8' },
  rawMetadata: JSON.stringify({ settings: { compilationTarget: { 'src/Pay.sol': 'Pay' } } }),
};

test('binds ABI, event schema, initcode, runtime, sizes, and local compiler gas', () => {
  assert.deepEqual(summarizeArtifact(artifact), {
    source: 'src/Pay.sol',
    contract: 'Pay',
    abiSha256: '0e003fbf4f4b95f60090d1ab56f3af46719b92d1ae2fdd26d5db046d1ee16805',
    eventSchemaSha256: 'e684064d80247177f3b613bf0c9a0adf5a63316fdba7412b1b978abcc0c01655',
    methodIdentifiers: { 'pay()': '1b9265b8' },
    initcodeSha256: '8880a54d03747df9eda6b310443a788558dc080c804db3fde94aee0382f66ea9',
    runtimeSha256: '33d34248ed4f2b6266d6fc2f4fa6be82f843c439534b3ac929e88f252292e23a',
    initcodeBytes: 5,
    runtimeBytes: 4,
    localCompilerGas: {
      codeDepositCost: '800',
      executionCost: 'infinite',
      totalCost: 'infinite',
    },
  });
});

test('fails a two-build comparison on any bound artifact drift', () => {
  const first = [summarizeArtifact(artifact)];
  assert.deepEqual(compareBuildRecords(first, structuredClone(first)), {
    reproducible: true,
    artifactSetSha256: '0aee5a8854b61ab2b00a0caacc4f61169c547d4bb91dd3db5b798f5483f8e675',
  });

  const second = structuredClone(first);
  second[0].runtimeBytes = 5;
  assert.throws(() => compareBuildRecords(first, second), /isolated build artifact mismatch/);
});

test('records only local production-contract gas without inventing official headroom', () => {
  const report = `
| src/bindings/RobinhoodBindings.sol:ImmutableLaunchBinding Contract |                 |
| Deployment Cost                                                    | Deployment Size |
|                                                             263331 |            5418 |
| src/bindings/RobinhoodBindings.sol:PermanentPositionCustody Contract |                 |
| Deployment Cost                                                      | Deployment Size |
|                                                               378903 |            1813 |
| test/bindings/RobinhoodBindings.t.sol:MockToken Contract |                 |
| Deployment Cost                                          | Deployment Size |
|                                                   180095 |             616 |
`;
  assert.deepEqual(parseProductionGasReport(report), [
    {
      source: 'src/bindings/RobinhoodBindings.sol',
      contract: 'ImmutableLaunchBinding',
      localDeploymentGas: 263331,
      observedDeploymentSizeBytes: 5418,
      officialLimit: 'INTEGRATION_PENDING',
      officialHeadroom: 'NOT_CLAIMED',
    },
    {
      source: 'src/bindings/RobinhoodBindings.sol',
      contract: 'PermanentPositionCustody',
      localDeploymentGas: 378903,
      observedDeploymentSizeBytes: 1813,
      officialLimit: 'INTEGRATION_PENDING',
      officialHeadroom: 'NOT_CLAIMED',
    },
  ]);
});

test('rejects gas sections that are foreign, duplicated, incomplete, or cross section bounds', () => {
  const immutable = `
| src/bindings/RobinhoodBindings.sol:ImmutableLaunchBinding Contract |                 |
| Deployment Cost                                                    | Deployment Size |
|                                                             263331 |            5418 |
`;
  const custody = `
| src/bindings/RobinhoodBindings.sol:PermanentPositionCustody Contract |                 |
| Deployment Cost                                                      | Deployment Size |
|                                                               378903 |            1813 |
`;
  assert.throws(
    () => parseProductionGasReport(`${immutable}${immutable}${custody}`),
    /exact production contract set/,
  );
  assert.throws(
    () => parseProductionGasReport(`
| src/bindings/Other.sol:ImmutableLaunchBinding Contract |                 |
| Deployment Cost                                      | Deployment Size |
|                                               999999 |            9999 |
${custody}`),
    /exact production contract set/,
  );
  assert.throws(
    () => parseProductionGasReport(`
| src/bindings/RobinhoodBindings.sol:ImmutableLaunchBinding Contract |                 |
| Deployment Cost                                                    | Deployment Size |
${custody}`),
    /missing local gas measurement/,
  );
});

test('requires the exact narrow seven-test completion summary', () => {
  assert.doesNotThrow(() => requireExactGasTestSummary(
    'Ran 1 test suite in 3.96ms: 7 tests passed, 0 failed, 0 skipped (7 total tests)\n',
  ));
  assert.throws(
    () => requireExactGasTestSummary(
      'Ran 1 test suite in 3.96ms: 6 tests passed, 0 failed, 0 skipped (6 total tests)\n',
    ),
    /exactly seven tests/,
  );
  assert.throws(
    () => requireExactGasTestSummary(
      'Ran 1 test suite in 3.96ms: 16 tests passed, 0 failed, 0 skipped (16 total tests)\n',
    ),
    /exactly seven tests/,
  );
});

test('rejects executable drift against trusted toolchain and frozen pins', () => {
  const trusted = {
    node: { version: 'v24.19.0', sha256: 'a'.repeat(64) },
    forge: { version: '1.7.1', commit: 'b'.repeat(40), sha256: 'c'.repeat(64) },
    solc: { version: '0.8.26+commit.8a97fa7a.Darwin.appleclang', sha256: 'd'.repeat(64) },
  };
  const pins = {
    controlRuntime: { node: '24.19.0' },
    phase1Toolchain: {
      foundry: { version: '1.7.1', commit: 'b'.repeat(40) },
      solidity: { solcVersion: '0.8.26' },
    },
  };
  assert.doesNotThrow(() => validateToolchain(structuredClone(trusted), trusted, pins));
  for (const mutate of [
    (actual) => { actual.node.sha256 = 'e'.repeat(64); },
    (actual) => { actual.forge.version = '1.7.2'; },
    (actual) => { actual.solc.version = '0.8.27+commit.fake'; },
  ]) {
    const actual = structuredClone(trusted);
    mutate(actual);
    assert.throws(() => validateToolchain(actual, trusted, pins), /toolchain mismatch/);
  }
});

test('requires a trusted manifest digest, unique paths, and the exact runner set', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hookemon-repro-manifest-test-'));
  try {
    const runnerPath = 'packages/runner/src/a.mjs';
    mkdirSync(join(fixture, 'packages/runner/src'), { recursive: true });
    writeFileSync(join(fixture, runnerPath), 'export const a = 1;\n');
    const record = { path: runnerPath, sha256: sha256('export const a = 1;\n') };
    const manifestBytes = Buffer.from(JSON.stringify({ files: [record] }));
    assert.doesNotThrow(() => validateCandidateManifest({
      checkout: fixture,
      manifestBytes,
      expectedManifestSha256: sha256(manifestBytes),
      expectedRunnerPaths: [runnerPath],
    }));
    assert.throws(() => validateCandidateManifest({
      checkout: fixture,
      manifestBytes,
      expectedManifestSha256: '0'.repeat(64),
      expectedRunnerPaths: [runnerPath],
    }), /trusted manifest digest/);
    const duplicateBytes = Buffer.from(JSON.stringify({ files: [record, record] }));
    assert.throws(() => validateCandidateManifest({
      checkout: fixture,
      manifestBytes: duplicateBytes,
      expectedManifestSha256: sha256(duplicateBytes),
      expectedRunnerPaths: [runnerPath],
    }), /duplicate candidate path/);
    assert.throws(() => validateCandidateManifest({
      checkout: fixture,
      manifestBytes,
      expectedManifestSha256: sha256(manifestBytes),
      expectedRunnerPaths: ['packages/runner/src/other.mjs'],
    }), /runner set drift/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the production default runner set matches the actual local candidate', () => {
  const manifestBytes = readFileSync(join(root, 'release/phase1/local-candidate.json'));
  const manifest = JSON.parse(manifestBytes);
  const candidateRunnerPaths = manifest.files
    .map((file) => file.path)
    .filter((path) => path.startsWith('packages/runner/'))
    .sort();
  assert.equal(expectedRunnerPaths.length, 24);
  assert.ok(expectedRunnerPaths.includes('packages/runner/test/cycle/security.test.mjs'));
  assert.deepEqual([...expectedRunnerPaths].sort(), candidateRunnerPaths);
  assert.doesNotThrow(() => validateCandidateManifest({
    checkout: root,
    manifestBytes,
    expectedManifestSha256: sha256(manifestBytes),
  }));
});

function writeFakeArtifact(outDirectory, filename, source, contract) {
  const fakeArtifact = {
    abi: [],
    bytecode: { object: '0x00' },
    deployedBytecode: { object: '0x00' },
    gasEstimates: { creation: { codeDepositCost: '1', executionCost: '1', totalCost: '2' } },
    methodIdentifiers: {},
    rawMetadata: JSON.stringify({ settings: { compilationTarget: { [source]: contract } } }),
  };
  writeFileSync(join(outDirectory, filename), JSON.stringify(fakeArtifact));
}

test('collectSourceArtifacts rejects an untracked production artifact instead of silently dropping it', () => {
  const outDirectory = mkdtempSync(join(tmpdir(), 'hookemon-repro-artifacts-test-'));
  try {
    // A tracked identity and a documented D10 placeholder both pass through the per-file filter
    // without complaint -- the placeholder is silently excluded, exactly as intended.
    writeFakeArtifact(outDirectory, 'tracked.json', 'src/access/MoneyRoles.sol', 'MoneyRoles');
    writeFakeArtifact(
      outDirectory,
      'placeholder.json',
      'src/launch/CustomLaunchStrategy.sol',
      'PlaceholderRemainderCustody',
    );
    // A production artifact that is neither tracked nor an intentionally-excluded placeholder
    // must fail loudly, not vanish from the reproducibility-tracked closure.
    writeFakeArtifact(outDirectory, 'unexpected.json', 'src/access/MoneyRoles.sol', 'UnexpectedHelper');
    assert.throws(
      () => collectSourceArtifacts(outDirectory),
      /build produced an untracked production Solidity artifact: src\/access\/MoneyRoles\.sol::UnexpectedHelper/,
    );
  } finally {
    rmSync(outDirectory, { recursive: true, force: true });
  }
});

test('dependency status includes untracked files and must remain clean', () => {
  assert.doesNotThrow(() => assertCleanDependencyStatus('v4-core', ''));
  assert.throws(
    () => assertCleanDependencyStatus('v4-core', '?? untracked.sol\n'),
    /dependency is not clean/,
  );
});

test('output stays below the repository, rejects symlinks, and is written atomically', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hookemon-repro-output-test-'));
  try {
    mkdirSync(join(fixture, 'release'), { recursive: true });
    assert.throws(() => resolveSafeOutputPath(fixture, '../escape.json'), /inside repository/);
    symlinkSync(join(fixture, 'release'), join(fixture, 'release-link'));
    assert.throws(
      () => resolveSafeOutputPath(fixture, 'release-link/report.json'),
      /symlink/,
    );
    writeOutputAtomically(fixture, 'release/report.json', '{"status":"PASS"}\n');
    assert.equal(readFileSync(join(fixture, 'release/report.json'), 'utf8'), '{"status":"PASS"}\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
