#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import {
  buildLaunchPackage,
  derivePhaseThreeGraphCallsFromCompiledAbi,
  normalizePhaseThreeAddressManifestDraft,
  normalizePhaseThreeDeploymentManifest,
  normalizePhaseThreeSubmissionDraft,
} from './lib/package.mjs';
import { parsePhaseThreeReleaseRebuildOptions } from './lib/rebuild-options.mjs';
import {
  artifactHashes,
  derivePriceCandidates,
  extractFoundryStandardJsonInput,
  foundryCompilerVersion,
  PHASE_THREE_FACTORY,
  PHASE_THREE_SOLC_LONG_VERSION,
  PHASE_THREE_SOLC_SHORT_VERSION,
  PHASE_THREE_SOLC_VERSION,
  sha256,
  sourceContentCommitment,
  toEip55Address,
} from './lib/phase3-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const contractsDirectory = resolve(root, 'packages/contracts');
const {
  releaseDirectory,
  releasePlanPath,
} = parsePhaseThreeReleaseRebuildOptions(process.argv.slice(2), {
  releaseDirectory: resolve(root, 'release/phase3'),
  releasePlanPath: resolve(contractsDirectory, 'script/release/PhaseThreeReleasePlan.sol'),
});
const forge = process.env.FORGE_BIN ?? 'forge';
const artifactDirectory = resolve(releaseDirectory, 'artifacts');
const buildInfoDirectory = resolve(releaseDirectory, 'build-info');

const targets = [
  {
    targetId: 'token',
    artifactPath: 'HKMNToken.sol/HKMNToken.json',
    sourcePath: 'packages/contracts/src/launch/HKMNToken.sol',
    contractName: 'HKMNToken',
  },
  {
    targetId: 'custody',
    artifactPath: 'RobinhoodBindings.sol/PermanentPositionCustody.json',
    sourcePath: 'packages/contracts/src/bindings/RobinhoodBindings.sol',
    contractName: 'PermanentPositionCustody',
  },
  {
    targetId: 'hook',
    artifactPath: 'HookemonHook.sol/HookemonHook.json',
    sourcePath: 'packages/contracts/src/HookemonHook.sol',
    contractName: 'HookemonHook',
  },
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalDigest(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function expectObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function artifactCompilationTarget(target, artifact) {
  const label = `compiled ${target.targetId} artifact`;
  let metadata = artifact?.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      throw new Error(`${label}.metadata must be JSON`);
    }
  }
  const settings = expectObject(expectObject(metadata, `${label}.metadata`).settings, `${label}.metadata.settings`);
  const entries = Object.entries(expectObject(settings.compilationTarget, `${label}.metadata.settings.compilationTarget`));
  if (entries.length !== 1) {
    throw new Error(`${label}.metadata.settings.compilationTarget must identify exactly one contract`);
  }
  const [sourcePath, contractName] = entries[0];
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || typeof contractName !== 'string' || contractName.length === 0) {
    throw new Error(`${label}.metadata.settings.compilationTarget must contain a source path and contract name`);
  }
  return { sourcePath, contractName };
}

function validateCompiledTargetIdentities(records, deploymentManifest) {
  if (!Array.isArray(deploymentManifest?.deployed)) throw new Error('deployment manifest.deployed must be an array');
  for (const target of targets) {
    const record = records.get(target.targetId);
    if (!record) throw new Error(`compiled artifact is missing for ${target.targetId}`);
    const identity = artifactCompilationTarget(target, record.artifact);
    const matches = deploymentManifest.deployed.filter((entry) => entry?.name === target.contractName);
    if (matches.length !== 1 || typeof matches[0].sourcePath !== 'string') {
      throw new Error(`deployment manifest must define exactly one ${target.contractName} target`);
    }
    const deploymentSourcePath = matches[0].sourcePath;
    if (!deploymentSourcePath.startsWith('packages/contracts/')) {
      throw new Error(`deployment manifest source path is invalid for ${target.contractName}`);
    }
    const expectedSourcePath = deploymentSourcePath.slice('packages/contracts/'.length);
    if (
      identity.sourcePath !== expectedSourcePath
      || identity.contractName !== target.contractName
      || deploymentSourcePath !== target.sourcePath
    ) {
      throw new Error(`${target.targetId} artifact.metadata.settings.compilationTarget does not match the deployment target`);
    }
    if (record.artifact.contractName !== undefined && record.artifact.contractName !== identity.contractName) {
      throw new Error(`${target.targetId} artifact.contractName conflicts with metadata.settings.compilationTarget`);
    }
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function portableStandardJsonEvidence(buildInfoPath, records) {
  const buildInfo = readJson(buildInfoPath);
  if (buildInfo.solcVersion !== PHASE_THREE_SOLC_SHORT_VERSION) throw new Error('pinned launch compilation produced an unexpected solc version');
  const compilerVersions = new Set([...records.values()].map(({ artifact }) => foundryCompilerVersion(artifact)));
  if (compilerVersions.size !== 1 || compilerVersions.values().next().value !== PHASE_THREE_SOLC_LONG_VERSION) {
    throw new Error('pinned launch compilation produced an unexpected solc long version');
  }
  return extractFoundryStandardJsonInput(buildInfo);
}

function compiledTargets() {
  const directory = mkdtempSync(resolve(tmpdir(), 'hookemon-phase3-release-'));
  const result = spawnSync(forge, [
    'build', '--root', contractsDirectory, '--no-cache', '--build-info',
    '--out', resolve(directory, 'out'), '--build-info-path', resolve(directory, 'build-info'),
    'src/HookemonHook.sol', 'src/launch/HKMNToken.sol', 'src/bindings/RobinhoodBindings.sol',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FOUNDRY_PROFILE: 'launch',
      FOUNDRY_LIBS: '["lib/v4-core","lib/v4-periphery"]',
      FOUNDRY_REMAPPINGS: 'forge-std/=lib/v4-core/lib/forge-std/src/',
    },
  });
  if (result.status !== 0) throw new Error(`pinned launch compilation failed:\n${result.stdout}\n${result.stderr}`);
  const buildInfos = readdirSync(resolve(directory, 'build-info')).filter((name) => name.endsWith('.json')).sort();
  if (buildInfos.length !== 1) throw new Error(`expected exactly one build-info file, found ${buildInfos.length}`);
  const records = new Map();
  for (const target of targets) {
    const path = resolve(directory, 'out', target.artifactPath);
    const bytes = readFileSync(path);
    records.set(target.targetId, { bytes, artifact: JSON.parse(bytes.toString('utf8')), sourcePath: path });
  }
  return {
    directory,
    buildInfoPath: resolve(directory, 'build-info', buildInfos[0]),
    records,
  };
}

function normalizeAddresses(value) {
  if (Array.isArray(value)) return value.map(normalizeAddresses);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeAddresses(entry)]));
  }
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)) return toEip55Address(value);
  return value;
}

function updateLaunchInputs(launchInputs) {
  const candidates = derivePriceCandidates({
    usdgAtomic: launchInputs.pool.quoteAsset.amountAtomic,
    hkmnAtomic: launchInputs.pool.baseAsset.amountAtomic,
  });
  launchInputs.chain.graphFactory = PHASE_THREE_FACTORY;
  launchInputs.roles.issuanceAuthority = PHASE_THREE_FACTORY;
  launchInputs.token.sourceCompatibility = {
    status: 'VERIFIED',
    compiledSupplyAtomic: '1000000000000000000000000000',
    reason: "The pinned launch compiler profile confirms the Requirements revision 65 supply baseline: the owner's 2026-09-05 decision allocates the complete supply to the canonical market with zero other allocations. The DRAFT_UNSIGNED baseline records current subject hashes and is not transaction authorization.",
  };
  for (const name of ['usdgCurrency0', 'hkmnCurrency0']) {
    Object.assign(launchInputs.pool.priceCandidates[name], {
      sqrtPriceX96: candidates[name].sqrtPriceX96,
      sqrtLowerX96: candidates[name].sqrtLowerX96,
      sqrtUpperX96: candidates[name].sqrtUpperX96,
      liquidity: candidates[name].liquidity,
      amount0Max: candidates[name].amount0Max,
      amount1Max: candidates[name].amount1Max,
      consumedAmount0: candidates[name].consumedAmount0,
      consumedAmount1: candidates[name].consumedAmount1,
      consumedHkmn: candidates[name].consumedHkmn,
    });
  }
  launchInputs.metadata.x = 'https://x.com/hookemon4';
  delete launchInputs.metadata.xNote;
  launchInputs.openFacts = launchInputs.openFacts.filter((fact) => !fact.includes('compiled HKMNToken'));
  return normalizeAddresses(launchInputs);
}

function updateAddressManifest(manifest, records, buildInfo) {
  manifest = normalizePhaseThreeAddressManifestDraft(manifest);
  manifest.deployer.factory = PHASE_THREE_FACTORY;
  manifest.compiler.solc = PHASE_THREE_SOLC_VERSION;
  manifest.compiler.solcLongVersion = PHASE_THREE_SOLC_LONG_VERSION;
  manifest.compiler.buildInfo = {
    status: 'OPEN_FACT',
    localBuildInfoCount: 1,
    sourceCount: buildInfo.sourceCount,
    sourceContentSha256: buildInfo.sourceContentSha256,
    reason: 'Missing: address-bound constructor values and provider route fields. Resolve: materialize the provider graph after preflight and retain a fresh launch build. Verified alternative: this single pinned-profile build binds template bytecode and source content while all signable graph fields remain unset.',
  };
  const byTarget = new Map(manifest.targets.map((target) => [target.targetId, target]));
  manifest.targets = targets.map((definition, targetIndex) => {
    const target = byTarget.get(definition.targetId);
    if (!target) throw new Error(`missing target template ${definition.targetId}`);
    const record = records.get(definition.targetId);
    Object.assign(target, artifactHashes(record.bytes, record.artifact), { targetIndex, sourcePath: definition.sourcePath });
    return target;
  });
  manifest.targets.find(({ targetId }) => targetId === 'hook').initializer = {
    function: 'initializeGraphLaunch(address,uint160)',
    sqrtPriceX96: null,
    calldata: null,
  };
  manifest.requiredGraphCalls = derivePhaseThreeGraphCallsFromCompiledAbi(artifactDirectory);
  manifest.postDeployAssertions[0] = 'No graph transaction is signable until the provider supplies the encoded token-allocate, custody-bind-hook and hook-initialize-graph-launch calls in that order.';
  manifest.openFacts = manifest.openFacts.filter((fact) => !fact.includes('owner supply'));
  return normalizeAddresses(manifest);
}

function updateDeploymentManifest(manifest) {
  manifest = normalizePhaseThreeDeploymentManifest(manifest);
  const schema = 'release/phase3/address-manifest.schema.json';
  manifest.addressManifestSchema = schema;
  const token = manifest.deployed.find((target) => target?.name === 'HKMNToken');
  if (!token?.constructorArgsSchema?.initializerSchema) {
    throw new Error('deployment manifest HKMNToken initializer schema is missing');
  }
  token.role = 'graph target 0: fixed-supply HKMN token';
  token.constructorArgsSchema.initializerSchema = {
    callCount: 1,
    targetIndex: 0,
    method: 'allocate(address)',
    selector: '0xffd7d983',
    arguments: ['hook:address'],
  };
  const custody = manifest.deployed.find((target) => target?.name === 'PermanentPositionCustody');
  if (!custody) throw new Error('deployment manifest PermanentPositionCustody target is missing');
  custody.role = 'graph target 1: permanent position NFT custody';
  for (const target of manifest.deployed) target.saltDerivation = `${schema}#/$defs/applicantSalt`;
  delete manifest.deploymentManifestDigest;
  manifest.deploymentManifestDigest = canonicalDigest(manifest);
  return normalizeAddresses(manifest);
}

function updateSubmission(submission) {
  submission = normalizePhaseThreeSubmissionDraft(submission);
  return normalizeAddresses(submission);
}

function updateReleasePlan(records, path) {
  const values = new Map();
  for (const [targetId, prefix] of [['token', 'TOKEN'], ['custody', 'CUSTODY'], ['hook', 'HOOK']]) {
    const hashes = artifactHashes(records.get(targetId).bytes, records.get(targetId).artifact);
    values.set(`${prefix}_CREATION_CODE_HASH`, hashes.creationBytecodeHash);
    values.set(`${prefix}_RUNTIME_TEMPLATE_CODE_HASH`, hashes.runtimeTemplateCodeHash);
    values.set(`${prefix}_ARTIFACT_SHA256`, `0x${hashes.artifactSha256.slice('sha256:'.length)}`);
  }
  const source = readFileSync(path, 'utf8')
    .replace(/\bTREASURY_ALLOCATION\b/g, 'REMAINDER_CUSTODY_ALLOCATION')
    .replace(/\btreasuryAllocation\b/g, 'remainderCustodyAllocation');
  const block = [
    ['TOKEN_CREATION_CODE_HASH', 'TOKEN_RUNTIME_TEMPLATE_CODE_HASH', 'TOKEN_ARTIFACT_SHA256'],
    ['HOOK_CREATION_CODE_HASH', 'HOOK_RUNTIME_TEMPLATE_CODE_HASH', 'HOOK_ARTIFACT_SHA256'],
    ['CUSTODY_CREATION_CODE_HASH', 'CUSTODY_RUNTIME_TEMPLATE_CODE_HASH', 'CUSTODY_ARTIFACT_SHA256'],
  ].flat().map((name) => `    bytes32 public constant ${name} =\n        ${values.get(name)};`).join('\n');
  const start = source.indexOf('    bytes32 public constant TOKEN_CREATION_CODE_HASH');
  const end = source.indexOf('    uint256 public constant TOTAL_SUPPLY');
  if (start < 0 || end < 0 || start >= end) throw new Error('release-plan hash constant block is missing');
  writeFileSync(path, `${source.slice(0, start)}${block}\n\n${source.slice(end)}`);
}

function rebuildPackage() {
  const packageDirectory = resolve(releaseDirectory, 'package');
  const backupDirectory = resolve(releaseDirectory, '.package-rebuild-backup');
  if (existsSync(backupDirectory)) throw new Error('package rebuild backup already exists');
  renameSync(packageDirectory, backupDirectory);
  try {
    buildLaunchPackage({
      artifactDirectory,
      standardInputDirectory: buildInfoDirectory,
      launchInputsPath: resolve(releaseDirectory, 'launch-inputs.json'),
      addressManifestPath: resolve(releaseDirectory, 'address-manifest.json'),
      outputDirectory: packageDirectory,
    });
    rmSync(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(packageDirectory)) rmSync(packageDirectory, { recursive: true, force: true });
    renameSync(backupDirectory, packageDirectory);
    throw error;
  }
}

function rebuildReviewTarget() {
  const builder = resolve(
    root,
    'scripts/programmable/vendor/programmable-v4-hook-builder/scripts/cli-review-target.mjs',
  );
  const result = spawnSync(process.execPath, [builder, root, releaseDirectory], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || 'unknown review-target error';
    throw new Error(`review-target rebuild failed: ${detail}`);
  }
  let target;
  try {
    target = JSON.parse(result.stdout);
  } catch {
    throw new Error('review-target rebuild returned invalid JSON');
  }
  writeJson(resolve(releaseDirectory, 'review-target.json'), target);
}

function main() {
  const compilation = compiledTargets();
  try {
    const standardJsonEvidence = portableStandardJsonEvidence(compilation.buildInfoPath, compilation.records);
    const buildInfo = sourceContentCommitment(standardJsonEvidence);
    const deploymentManifestPath = resolve(releaseDirectory, 'deployment-manifest.json');
    validateCompiledTargetIdentities(compilation.records, readJson(deploymentManifestPath));
    rmSync(artifactDirectory, { recursive: true, force: true });
    rmSync(buildInfoDirectory, { recursive: true, force: true });
    mkdirSync(artifactDirectory, { recursive: true });
    mkdirSync(buildInfoDirectory, { recursive: true });
    for (const target of targets) copyFileSync(compilation.records.get(target.targetId).sourcePath, resolve(artifactDirectory, `${target.targetId}.json`));
    writeJson(resolve(buildInfoDirectory, 'launch.json'), standardJsonEvidence);

    const launchInputsPath = resolve(releaseDirectory, 'launch-inputs.json');
    const addressManifestPath = resolve(releaseDirectory, 'address-manifest.json');
    const submissionPath = resolve(releaseDirectory, 'submission.json');
    writeJson(launchInputsPath, updateLaunchInputs(readJson(launchInputsPath)));
    writeJson(addressManifestPath, updateAddressManifest(readJson(addressManifestPath), compilation.records, buildInfo));
    writeJson(deploymentManifestPath, updateDeploymentManifest(readJson(deploymentManifestPath)));
    writeJson(submissionPath, updateSubmission(readJson(submissionPath)));
    updateReleasePlan(compilation.records, releasePlanPath);
    rebuildPackage();
    if (releaseDirectory === resolve(root, 'release/phase3')) rebuildReviewTarget();
    process.stdout.write(`${JSON.stringify({ ok: true, targets: targets.map(({ targetId }) => targetId), sourceContentSha256: buildInfo.sourceContentSha256 })}\n`);
  } finally {
    rmSync(compilation.directory, { recursive: true, force: true });
  }
}

main();
