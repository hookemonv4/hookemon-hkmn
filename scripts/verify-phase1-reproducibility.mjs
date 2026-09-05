import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  expectedArtifactIdentities,
  intentionallyUntrackedArtifactIdentities,
} from './verify-phase1-release.mjs';

const root = resolve(import.meta.dirname, '..');
const productionGasContracts = new Set([
  'ImmutableLaunchBinding',
  'PermanentPositionCustody',
]);
const productionGasSource = 'src/bindings/RobinhoodBindings.sol';
export const expectedRunnerPaths = Object.freeze([
  'packages/runner/src/cycle/authorization.mjs',
  'packages/runner/src/cycle/bindings.mjs',
  'packages/runner/src/cycle/blockhash-validity.mjs',
  'packages/runner/src/cycle/collector.mjs',
  'packages/runner/src/cycle/cycle-runner.mjs',
  'packages/runner/src/cycle/cycle-store.mjs',
  'packages/runner/src/cycle/decoder.mjs',
  'packages/runner/src/cycle/execution-accounting.mjs',
  'packages/runner/src/cycle/journal.mjs',
  'packages/runner/src/cycle/preflight.mjs',
  'packages/runner/src/cycle/receipt-registry.mjs',
  'packages/runner/src/cycle/reducer.mjs',
  'packages/runner/src/cycle/schemas.mjs',
  'packages/runner/src/cycle/verify-fixtures.mjs',
  'packages/runner/src/distribution/manifest.mjs',
  'packages/runner/src/distribution/merkle-sum.mjs',
  'packages/runner/src/distribution/reconcile.mjs',
  'packages/runner/test/cycle/fixture-crypto.mjs',
  'packages/runner/test/cycle/fixture-cycle.mjs',
  'packages/runner/test/cycle/security.test.mjs',
  'packages/runner/test/distribution/holder-candidate.test.mjs',
  'packages/runner/test/distribution/manifest.test.mjs',
  'packages/runner/test/distribution/reconcile.test.mjs',
  'packages/runner/test/integration/phase-one-local-loop-adapter.mjs',
]);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashJson(value) {
  return sha256(canonicalJson(value));
}

function bytecodeBytes(value, label) {
  const hex = value?.object?.replace(/^0x/, '') ?? '';
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`${label} is not fully linked hex bytecode`);
  return Buffer.from(hex, 'hex');
}

export function summarizeArtifact(artifact) {
  const metadata = JSON.parse(artifact.rawMetadata);
  const targets = Object.entries(metadata.settings?.compilationTarget ?? {});
  if (targets.length !== 1) throw new Error('artifact must have exactly one compilation target');
  const [[source, contract]] = targets;
  const abi = artifact.abi ?? [];
  const events = abi.filter((entry) => entry.type === 'event');
  const initcode = bytecodeBytes(artifact.bytecode, `${source}:${contract} initcode`);
  const runtime = bytecodeBytes(artifact.deployedBytecode, `${source}:${contract} runtime`);
  const creationGas = artifact.gasEstimates?.creation ?? null;
  const methodIdentifiers = Object.fromEntries(
    Object.entries(artifact.methodIdentifiers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (Object.values(methodIdentifiers).some((selector) => !/^[0-9a-f]{8}$/.test(selector))) {
    throw new Error(`${source}:${contract} has an invalid compiler method identifier`);
  }
  return {
    source,
    contract,
    abiSha256: hashJson(abi),
    eventSchemaSha256: hashJson(events),
    methodIdentifiers,
    initcodeSha256: sha256(initcode),
    runtimeSha256: sha256(runtime),
    initcodeBytes: initcode.length,
    runtimeBytes: runtime.length,
    localCompilerGas: creationGas && {
      codeDepositCost: creationGas.codeDepositCost,
      executionCost: creationGas.executionCost,
      totalCost: creationGas.totalCost,
    },
  };
}

export function compareBuildRecords(first, second) {
  const firstBytes = canonicalJson(first);
  if (firstBytes !== canonicalJson(second)) {
    throw new Error('isolated build artifact mismatch');
  }
  return { reproducible: true, artifactSetSha256: sha256(firstBytes) };
}

export function parseProductionGasReport(output) {
  const lines = output.split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\|\s+([^:|]+):([A-Za-z0-9_]+) Contract\s+\|/);
    if (
      !header
      || header[1] !== productionGasSource
      || !productionGasContracts.has(header[2])
    ) continue;
    if (records.some((record) => record.contract === header[2])) {
      throw new Error('local gas report does not contain the exact production contract set');
    }
    let measurement;
    let sawDeploymentHeader = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\|\s+[^:|]+:[A-Za-z0-9_]+ Contract\s+\|/.test(lines[cursor])) break;
      if (/^\|\s*Deployment Cost\s*\|\s*Deployment Size\s*\|/.test(lines[cursor])) {
        sawDeploymentHeader = true;
        continue;
      }
      if (!sawDeploymentHeader) continue;
      const row = lines[cursor].match(/^\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
      if (row) {
        measurement = { gas: Number(row[1]), size: Number(row[2]) };
        break;
      }
    }
    if (!measurement) throw new Error(`missing local gas measurement for ${header[2]}`);
    records.push({
      source: header[1],
      contract: header[2],
      localDeploymentGas: measurement.gas,
      observedDeploymentSizeBytes: measurement.size,
      officialLimit: 'INTEGRATION_PENDING',
      officialHeadroom: 'NOT_CLAIMED',
    });
  }
  records.sort((left, right) => left.contract.localeCompare(right.contract));
  if (records.length !== productionGasContracts.size) {
    throw new Error('local gas report did not contain the exact production contract set');
  }
  return records;
}

export function requireExactGasTestSummary(output) {
  const summaries = output.match(
    /^Ran 1 test suite in [^\n]+: 7 tests passed, 0 failed, 0 skipped \(7 total tests\)$/gm,
  ) ?? [];
  if (summaries.length !== 1) throw new Error('narrow binding gas run must pass exactly seven tests');
}

export function validateToolchain(actual, trusted, dependencyPins) {
  const mismatch = (
    actual.node?.version !== trusted.node?.version
    || actual.node?.sha256 !== trusted.node?.sha256
    || actual.forge?.version !== trusted.forge?.version
    || actual.forge?.commit !== trusted.forge?.commit
    || actual.forge?.sha256 !== trusted.forge?.sha256
    || actual.solc?.version !== trusted.solc?.version
    || actual.solc?.sha256 !== trusted.solc?.sha256
    || trusted.node?.version?.replace(/^v/, '') !== dependencyPins.controlRuntime?.node
    || trusted.forge?.version !== dependencyPins.phase1Toolchain?.foundry?.version
    || trusted.forge?.commit !== dependencyPins.phase1Toolchain?.foundry?.commit
    || !trusted.solc?.version?.startsWith(`${dependencyPins.phase1Toolchain?.solidity?.solcVersion}+`)
  );
  if (mismatch) throw new Error('local executable toolchain mismatch');
}

export function assertCleanDependencyStatus(label, status) {
  if (status.trim() !== '') throw new Error(`${label} dependency is not clean`);
}

export function validateCandidateManifest({
  checkout,
  manifestBytes,
  expectedManifestSha256,
  expectedRunnerPaths: requiredRunnerPaths = expectedRunnerPaths,
}) {
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? '')) {
    throw new Error('caller must supply a trusted manifest digest');
  }
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error('candidate does not match the trusted manifest digest');
  }
  const manifest = JSON.parse(manifestBytes);
  if (!Array.isArray(manifest.files)) throw new Error('candidate files are missing');
  const paths = new Set();
  for (const file of manifest.files) {
    if (paths.has(file.path)) throw new Error(`duplicate candidate path: ${file.path}`);
    paths.add(file.path);
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? '')) {
      throw new Error(`invalid candidate hash: ${file.path}`);
    }
    if (sha256(readFileSync(join(checkout, file.path))) !== file.sha256) {
      throw new Error(`candidate input hash mismatch: ${file.path}`);
    }
  }
  const runnerFiles = manifest.files
    .filter((file) => file.path.startsWith('packages/runner/'))
    .sort((left, right) => left.path.localeCompare(right.path));
  const actualRunnerPaths = runnerFiles.map((file) => file.path);
  const expectedPaths = [...requiredRunnerPaths].sort();
  if (canonicalJson(actualRunnerPaths) !== canonicalJson(expectedPaths)) {
    throw new Error('candidate runner set drift');
  }
  return {
    candidateManifestSha256: sha256(manifestBytes),
    runnerSourceCount: runnerFiles.length,
    runnerSourceSetSha256: hashJson(runnerFiles),
  };
}

export function resolveSafeOutputPath(repositoryRoot, requested) {
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const outputPath = resolve(realRepositoryRoot, requested);
  if (!outputPath.startsWith(`${realRepositoryRoot}${sep}`)) {
    throw new Error('output must stay inside repository');
  }
  const parent = dirname(outputPath);
  const relativeParts = parent.slice(realRepositoryRoot.length + 1).split(sep).filter(Boolean);
  let cursor = realRepositoryRoot;
  for (const part of relativeParts) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) throw new Error('output parent must already exist inside repository');
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('output path may not traverse a symlink');
    if (!stat.isDirectory()) throw new Error('output parent must be a directory');
  }
  if (realpathSync(parent) !== parent) throw new Error('output path may not traverse a symlink');
  if (existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()) {
    throw new Error('output target may not be a symlink');
  }
  return outputPath;
}

export function writeOutputAtomically(repositoryRoot, requested, bytes) {
  const outputPath = resolveSafeOutputPath(repositoryRoot, requested);
  const temporaryPath = join(
    dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, outputPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${basename(command)} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function listJsonFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files;
}

// The reproducibility report tracks a fixed, curated set of source::contract identities (the
// same expectedArtifactIdentities the release verifier binds ABI/method-identifier drift
// against), not every contract the production source tree happens to compile -- a project can
// grow internal helper contracts (e.g. CustomLaunchStrategy's two documented D10 placeholder
// custody contracts, see intentionallyUntrackedArtifactIdentities) without expanding the
// reproducibility-tracked surface. Any OTHER compiled src/ artifact outside both lists is not
// silently dropped: a future production file added to packages/contracts/src without also
// extending expectedArtifactIdentities must fail this build loudly instead of shrinking the
// closure the byte-identical/high-risk-method-identifier checks actually cover.
const trackedArtifactIdentities = new Set(expectedArtifactIdentities);
const untrackedArtifactIdentities = new Set(intentionallyUntrackedArtifactIdentities);

export function collectSourceArtifacts(outDirectory) {
  const records = [];
  for (const path of listJsonFiles(outDirectory)) {
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof artifact.rawMetadata !== 'string') continue;
    const record = summarizeArtifact(artifact);
    if (!record.source.startsWith('src/')) continue;
    const identity = `${record.source}::${record.contract}`;
    if (untrackedArtifactIdentities.has(identity)) continue;
    if (!trackedArtifactIdentities.has(identity)) {
      throw new Error(`build produced an untracked production Solidity artifact: ${identity}`);
    }
    records.push(record);
  }
  records.sort((left, right) => (
    left.source.localeCompare(right.source) || left.contract.localeCompare(right.contract)
  ));
  if (records.length === 0) throw new Error('build produced no Phase 1 source artifacts');
  if (records.length !== trackedArtifactIdentities.size) {
    throw new Error('build did not produce the exact tracked artifact identity set');
  }
  return records;
}

function readStaticInputs(checkout, expectedManifestSha256) {
  const manifestPath = join(checkout, 'release/phase1/local-candidate.json');
  const manifestBytes = readFileSync(manifestPath);
  return validateCandidateManifest({ checkout, manifestBytes, expectedManifestSha256 });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--output', '--source-commit'].includes(key) || !value) {
      throw new Error('usage: verify-phase1-reproducibility.mjs [--source-commit <sha>] [--output <path>]');
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function actualToolchain(forge, solc) {
  const env = { ...process.env, OPENSSL_CONF: '/dev/null' };
  const forgeVersion = run(forge, ['--version'], { env });
  const solcVersion = run(solc, ['--version'], { env });
  const forgeMatch = forgeVersion.match(/forge Version: ([^\s]+)[\s\S]*Commit SHA: ([0-9a-f]{40})/);
  const solcMatch = solcVersion.match(/Version: ([^\s]+)/);
  if (!forgeMatch || !solcMatch) throw new Error('unable to parse local executable toolchain');
  return {
    node: { version: process.version, sha256: sha256(readFileSync(process.execPath)) },
    forge: { version: forgeMatch[1], commit: forgeMatch[2], sha256: sha256(readFileSync(forge)) },
    solc: { version: solcMatch[1], sha256: sha256(readFileSync(solc)) },
  };
}

function pinnedGitRecord(label, pinPath, repositoryPath, dependencyPins, recordPath = pinPath) {
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const pin = dependencyPins.phase1Toolchain.uniswap.dependencyGitlinks.find((entry) => entry.path === pinPath);
  const commit = run('git', ['-c', 'core.excludesfile=/dev/null', 'rev-parse', 'HEAD'], {
    cwd: repositoryPath,
    env: gitEnv,
  }).trim();
  const status = run('git', [
    '-c', 'core.excludesfile=/dev/null', 'status', '--porcelain', '--untracked-files=all',
  ], { cwd: repositoryPath, env: gitEnv });
  if (!pin || commit !== pin.commit) throw new Error(`declared ${label} dependency pin mismatch`);
  assertCleanDependencyStatus(label, status);
  return { path: recordPath, commit };
}

function dependencyRecord(v4CorePath, dependencyPins) {
  const { path, commit } = pinnedGitRecord(
    'v4-core', 'packages/contracts/lib/v4-core', v4CorePath, dependencyPins,
  );
  const nested = ['lib/solmate', 'lib/openzeppelin-contracts'].map((nestedPath) => (
    pinnedGitRecord(
      nestedPath,
      `packages/contracts/lib/v4-core/${nestedPath}`,
      join(v4CorePath, nestedPath),
      dependencyPins,
      nestedPath,
    )
  ));
  return { path, commit, nested };
}

// The market-routing launch strategy pulls its second pinned submodule dependency, the Uniswap
// liquidity launcher, which needs no nested submodule of its own for the interfaces and types
// CustomLaunchStrategy.sol actually imports.
function additionalDependencyRecord(liquidityLauncherPath, dependencyPins) {
  return pinnedGitRecord(
    'liquidity-launcher', 'packages/contracts/lib/liquidity-launcher', liquidityLauncherPath, dependencyPins,
  );
}

// Test-only fixtures (RobinhoodV4Fork.t.sol, RobinhoodV4PoolManager.t.sol) pull the third pinned
// dependency, Uniswap's v4-periphery, with its own nested Permit2 pin -- required for
// measureLocalGas below because Foundry compiles the whole project, not just the matched test.
function v4PeripheryRecord(v4PeripheryPath, dependencyPins) {
  const { path, commit } = pinnedGitRecord(
    'v4-periphery', 'packages/contracts/lib/v4-periphery', v4PeripheryPath, dependencyPins,
  );
  const nested = [pinnedGitRecord(
    'permit2',
    'packages/contracts/lib/v4-periphery/lib/permit2',
    join(v4PeripheryPath, 'lib/permit2'),
    dependencyPins,
  )];
  return { path, commit, nested };
}

function copyDependency(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => basename(path) !== '.git',
  });
}

function archiveSource(sourceCommit, destination, archivePath, gitEnv) {
  mkdirSync(destination, { recursive: true });
  run('git', [
    '-c', 'core.excludesfile=/dev/null', 'archive', '--format=tar',
    `--output=${archivePath}`, sourceCommit,
  ], { cwd: root, env: gitEnv });
  run('/usr/bin/tar', ['-xf', archivePath, '-C', destination]);
}

function dependencyRemappings(v4CorePath, liquidityLauncherPath) {
  return [
    '-R', `@uniswap/v4-core/=${v4CorePath}/`,
    '-R', `solmate/=${join(v4CorePath, 'lib/solmate')}/`,
    '-R', `@openzeppelin/=${join(v4CorePath, 'lib/openzeppelin-contracts')}/`,
    '-R', `@uniswap/liquidity-launcher/=${liquidityLauncherPath}/`,
  ];
}

// WP-38 split three narrowly scoped `external` libraries out of PegCycleVault
// (FundingAuthorizationValidation, PayoutDistributionSignatures, PegCycleEscrowFactory; see each
// file's own docstring). `forge test`/`forge script` link and deploy `external` libraries
// automatically and transparently at EVM-execution time -- there is no plumbing anywhere in this
// project's Solidity for a fixed library address because none is needed for that path -- but a
// compile-only `forge build` (this function, and no other build step in this file) never deploys
// anything, so it never resolves those references and instead leaves each one as an unlinked
// `__$<hash>$__` placeholder, which is not valid hex and makes bytecodeBytes() below throw. These
// three fixed addresses exist solely to make the *static build artifact* fully linked, valid hex
// so it can be content-addressed at all; they carry no on-chain meaning (a real deployment always
// computes its own library addresses live) and are deliberately identical between the two
// isolated checkouts this script builds, so pinning them changes nothing about what the
// byte-identical comparison below actually proves.
const pinnedExternalLibraryLinks = Object.freeze([
  [
    'src/process/FundingAuthorizationValidation.sol:FundingAuthorizationValidation',
    '0x0000000000000000000000000000000000000001',
  ],
  [
    'src/process/PayoutDistributionSignatures.sol:PayoutDistributionSignatures',
    '0x0000000000000000000000000000000000000002',
  ],
  [
    'src/process/PegCycleEscrowFactory.sol:PegCycleEscrowFactory',
    '0x0000000000000000000000000000000000000003',
  ],
]);

function externalLibraryLinkArgs() {
  return pinnedExternalLibraryLinks.flatMap(([target, address]) => (
    ['--libraries', `${target}:${address}`]
  ));
}

function buildSource(checkout, buildDirectory, binaries, v4CorePath, liquidityLauncherPath, childEnv) {
  const out = join(buildDirectory, 'out');
  const cache = join(buildDirectory, 'cache');
  run(binaries.forge, [
    // "src" restricts compilation to packages/contracts/src, so this build never needs the
    // test-only v4-periphery/permit2 dependency below.
    'build', 'src', '--root', join(checkout, 'packages/contracts'), '--offline',
    '--use', binaries.solc, '--out', out, '--cache-path', cache,
    ...dependencyRemappings(v4CorePath, liquidityLauncherPath),
    ...externalLibraryLinkArgs(),
    '--extra-output', 'evm.gasEstimates', '--force', '--quiet',
  ], { cwd: checkout, env: childEnv });
  return collectSourceArtifacts(out);
}

function measureLocalGas(
  checkout, gasDirectory, binaries, v4CorePath, liquidityLauncherPath, v4PeripheryPath, childEnv,
) {
  const output = run(binaries.forge, [
    // Unlike "build src" above, "forge test" has no positional path filter: it always compiles
    // the whole project (src + test), so the test-only v4-periphery/permit2 dependency below is
    // required even though --match-path only runs test/bindings/RobinhoodBindings.t.sol.
    'test', '--root', join(checkout, 'packages/contracts'), '--offline', '--use', binaries.solc,
    '--match-path', 'test/bindings/RobinhoodBindings.t.sol',
    '--skip', 'FeeAccountingInvariant', '--skip', 'RobinhoodV4PoolManager', '--skip', 'market-fees',
    '--out', join(gasDirectory, 'out'), '--cache-path', join(gasDirectory, 'cache'),
    ...dependencyRemappings(v4CorePath, liquidityLauncherPath),
    '-R', `@uniswap/v4-periphery/=${v4PeripheryPath}/`,
    '-R', `permit2/=${join(v4PeripheryPath, 'lib/permit2')}/`,
    '--gas-report', '--md',
  ], { cwd: checkout, env: childEnv });
  requireExactGasTestSummary(output);
  return parseProductionGasReport(output);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const forge = process.env.HOOKEMON_FORGE_BINARY;
  const solc = process.env.HOOKEMON_SOLC_BINARY;
  const v4CorePath = process.env.HOOKEMON_V4_CORE_PATH;
  const liquidityLauncherPath = process.env.HOOKEMON_LIQUIDITY_LAUNCHER_PATH;
  const v4PeripheryPath = process.env.HOOKEMON_V4_PERIPHERY_PATH;
  const expectedManifestSha256 = process.env.HOOKEMON_PHASE1_MANIFEST_SHA256;
  if (!forge || !solc || !v4CorePath || !liquidityLauncherPath || !v4PeripheryPath) {
    throw new Error(
      'HOOKEMON_FORGE_BINARY, HOOKEMON_SOLC_BINARY, HOOKEMON_V4_CORE_PATH, '
      + 'HOOKEMON_LIQUIDITY_LAUNCHER_PATH, and HOOKEMON_V4_PERIPHERY_PATH are required',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? '')) {
    throw new Error('HOOKEMON_PHASE1_MANIFEST_SHA256 must be a caller-supplied trusted digest');
  }
  for (const path of [forge, solc, v4CorePath, liquidityLauncherPath, v4PeripheryPath]) lstatSync(path);

  const sourceCommit = args['source-commit'] ?? run('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('source commit must be an exact SHA');
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'hookemon-p1-repro-'));
  try {
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const checkouts = [join(temporaryRoot, 'checkout-a'), join(temporaryRoot, 'checkout-b')];
    archiveSource(sourceCommit, checkouts[0], join(temporaryRoot, 'source-a.tar'), gitEnv);
    archiveSource(sourceCommit, checkouts[1], join(temporaryRoot, 'source-b.tar'), gitEnv);
    const dependencyPins = JSON.parse(readFileSync(join(checkouts[0], 'product/dependency-pins.json')));
    const dependencySource = resolve(v4CorePath);
    const additionalDependencySource = resolve(liquidityLauncherPath);
    const secondaryDependencySource = resolve(v4PeripheryPath);
    const dependencyBefore = dependencyRecord(dependencySource, dependencyPins);
    const additionalDependencyBefore = additionalDependencyRecord(additionalDependencySource, dependencyPins);
    const secondaryDependencyBefore = v4PeripheryRecord(secondaryDependencySource, dependencyPins);
    const dependencyCopies = checkouts.map((checkout) => (
      join(checkout, 'packages/contracts/lib/v4-core')
    ));
    const additionalDependencyCopies = checkouts.map((checkout) => (
      join(checkout, 'packages/contracts/lib/liquidity-launcher')
    ));
    const secondaryDependencyCopies = checkouts.map((checkout) => (
      join(checkout, 'packages/contracts/lib/v4-periphery')
    ));
    for (const dependencyCopy of [
      ...dependencyCopies, ...additionalDependencyCopies, ...secondaryDependencyCopies,
    ]) {
      rmSync(dependencyCopy, { recursive: true, force: true });
    }
    copyDependency(dependencySource, dependencyCopies[0]);
    copyDependency(dependencySource, dependencyCopies[1]);
    copyDependency(additionalDependencySource, additionalDependencyCopies[0]);
    copyDependency(additionalDependencySource, additionalDependencyCopies[1]);
    copyDependency(secondaryDependencySource, secondaryDependencyCopies[0]);
    copyDependency(secondaryDependencySource, secondaryDependencyCopies[1]);
    const childEnv = {
      HOME: temporaryRoot,
      PATH: '/usr/bin:/bin',
      TMPDIR: temporaryRoot,
      OPENSSL_CONF: '/dev/null',
      NO_COLOR: '1',
      FOUNDRY_OFFLINE: 'true',
    };
    const buildA = buildSource(
      checkouts[0], join(temporaryRoot, 'build-a'), { forge, solc },
      'lib/v4-core', 'lib/liquidity-launcher', childEnv,
    );
    const buildB = buildSource(
      checkouts[1], join(temporaryRoot, 'build-b'), { forge, solc },
      'lib/v4-core', 'lib/liquidity-launcher', childEnv,
    );
    const comparison = compareBuildRecords(buildA, buildB);
    const staticA = readStaticInputs(checkouts[0], expectedManifestSha256);
    const staticB = readStaticInputs(checkouts[1], expectedManifestSha256);
    if (canonicalJson(staticA) !== canonicalJson(staticB)) throw new Error('isolated build static input mismatch');
    const trustedToolchain = JSON.parse(
      readFileSync(join(checkouts[0], 'release/phase1/local-toolchain.json')),
    );
    const toolchain = actualToolchain(forge, solc);
    validateToolchain(toolchain, trustedToolchain, dependencyPins);
    const localGas = measureLocalGas(
      checkouts[0], join(temporaryRoot, 'gas'), { forge, solc },
      'lib/v4-core', 'lib/liquidity-launcher', 'lib/v4-periphery', childEnv,
    );
    const dependencyAfter = dependencyRecord(dependencySource, dependencyPins);
    if (canonicalJson(dependencyBefore) !== canonicalJson(dependencyAfter)) {
      throw new Error('declared dependency changed during isolated builds');
    }
    const additionalDependencyAfter = additionalDependencyRecord(additionalDependencySource, dependencyPins);
    if (canonicalJson(additionalDependencyBefore) !== canonicalJson(additionalDependencyAfter)) {
      throw new Error('declared additional dependency changed during isolated builds');
    }
    const secondaryDependencyAfter = v4PeripheryRecord(secondaryDependencySource, dependencyPins);
    if (canonicalJson(secondaryDependencyBefore) !== canonicalJson(secondaryDependencyAfter)) {
      throw new Error('declared secondary dependency changed during isolated builds');
    }
    const report = {
      schema: 'hookemon.phase1-local-reproducibility.v1',
      authority: 'LOCAL_BUILD_EVIDENCE_ONLY_NO_RELEASE_APPROVAL',
      sourceCommit,
      isolation: {
        sourceTrees: 2,
        sourceMethod: 'INDEPENDENT_GIT_ARCHIVES_FROM_EXACT_COMMIT',
        independentOutputAndCacheDirectories: true,
        network: 'OFFLINE',
        dependencyCopies: 2,
        dependencyMethod: 'INDEPENDENT_CLEAN_COPIES_INSIDE_EACH_SOURCE_TREE',
        dependency: dependencyBefore,
        additionalDependency: additionalDependencyBefore,
        secondaryDependency: secondaryDependencyBefore,
      },
      toolchain,
      staticInputs: staticA,
      reproducibility: {
        ...comparison,
        buildCount: 2,
        artifactCount: buildA.length,
      },
      artifacts: buildA,
      localGas: {
        authority: 'LOCAL_FOUNDRY_TEST_MEASUREMENT_ONLY',
        test: 'test/bindings/RobinhoodBindings.t.sol',
        passed: 7,
        contracts: localGas,
      },
      productionLimits: {
        status: 'INTEGRATION_PENDING',
        headroom: 'NOT_CLAIMED',
        reason: 'Official Robinhood deployment and gas limits are not bound by current local evidence.',
      },
    };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      writeOutputAtomically(root, args.output, output);
    } else {
      process.stdout.write(output);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
