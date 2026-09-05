#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateJsonSchema } from './programmable/lib/json-schema.mjs';
import { requireEip55Addresses } from './programmable/lib/eip55.mjs';

const root = resolve(import.meta.dirname, '..');
const MANIFEST_SCHEMA_VERSION = 'hookemon.phase3.deployment-manifest.v1';
const ADDRESS_MANIFEST_SCHEMA = 'release/phase3/address-manifest.schema.json';
const GENESIS_EVIDENCE_PATH = 'release/phase3/genesis-evidence.json';
const CREATED_BY = 'programmable graphFactory CREATE2 via launchAndStampV1';
const SALT_DERIVATION = `${ADDRESS_MANIFEST_SCHEMA}#/$defs/applicantSalt`;
const REQUIRED_TARGETS = new Map([
  ['HKMNToken', 'packages/contracts/src/launch/HKMNToken.sol'],
  ['HookemonHook', 'packages/contracts/src/HookemonHook.sol'],
  ['PermanentPositionCustody', 'packages/contracts/src/bindings/RobinhoodBindings.sol'],
]);
const EXCLUDED_CONTRACTS = new Set([
  'PegCycleVault',
  'PegCycleEscrowFactory',
  'PegCycleReturnEscrow',
  'PegCycleRouteExecutor',
  'PayoutCommitment',
  'CanonicalMerkleSum',
  'HolderSettlement',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CODE_HASH = /^0x[0-9a-f]{64}$/;
const HEX_BYTECODE = /^0x(?:[0-9a-f]{2})+$/i;
const GENESIS_LIMITS = Object.freeze({
  schemaVersion: 'hookemon.phase3.genesis-evidence.v1',
  sourceUrl: 'https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-genesis.json',
  sha256: 'sha256:353e6f6441b47695b41cee0c3645cde8dd7492d2f7f574bfb6aa4371e41bb6ba',
  retrievedAt: '2026-09-05',
  chainId: 4663,
  blockGasLimit: 30_000_000,
  maxCodeSize: 98_304,
  maxInitCodeSize: 196_608,
});
const RELEASE_ARTIFACTS = [
  ['HKMNToken', 'release/phase3/artifacts/token.json'],
  ['PermanentPositionCustody', 'release/phase3/artifacts/custody.json'],
  ['HookemonHook', 'release/phase3/artifacts/hook.json'],
];
const RUNTIME_CODE_DEPOSIT_GAS_PER_BYTE = 200;

function fail(message) {
  throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  fail(`manifest cannot contain ${typeof value}`);
}

function sha256CanonicalJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function expectExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function artifactBytecodeBytes(artifact, field, label) {
  const bytecode = typeof artifact?.[field] === 'string'
    ? artifact[field]
    : artifact?.[field]?.object;
  if (typeof bytecode !== 'string' || !HEX_BYTECODE.test(bytecode)) {
    fail(`${label}.${field} must be non-empty bytecode`);
  }
  return (bytecode.length - 2) / 2;
}

/**
 * Validates the pinned genesis limits and independently derives numeric byte and gas headroom
 * from the checked-in release artifacts. Code-deposit gas is the irreducible runtime-gas portion
 * of an EVM deployment; constructor execution is covered by the launch-profile Forge suite.
 */
export function assessGenesisDeploymentEvidence({ evidence, artifacts }) {
  expectExactKeys(evidence, Object.keys(GENESIS_LIMITS), 'genesis evidence');
  for (const [field, expected] of Object.entries(GENESIS_LIMITS)) {
    if (evidence[field] !== expected) fail(`genesis evidence ${field} is invalid`);
  }
  if (!(artifacts instanceof Map) || artifacts.size !== RELEASE_ARTIFACTS.length) {
    fail('genesis evidence must include exactly the three release artifacts');
  }

  const targets = RELEASE_ARTIFACTS.map(([name]) => {
    const artifact = artifacts.get(name);
    if (artifact === undefined) fail(`genesis evidence is missing ${name} artifact`);
    const runtimeBytes = artifactBytecodeBytes(artifact, 'deployedBytecode', `${name} artifact`);
    const initcodeBytes = artifactBytecodeBytes(artifact, 'bytecode', `${name} artifact`);
    const runtimeHeadroom = evidence.maxCodeSize - runtimeBytes;
    const initcodeHeadroom = evidence.maxInitCodeSize - initcodeBytes;
    const runtimeCodeDepositGas = runtimeBytes * RUNTIME_CODE_DEPOSIT_GAS_PER_BYTE;
    const runtimeCodeDepositGasHeadroom = evidence.blockGasLimit - runtimeCodeDepositGas;
    if (runtimeHeadroom <= 0) fail(`${name} runtime exceeds genesis maxCodeSize`);
    if (initcodeHeadroom <= 0) fail(`${name} initcode exceeds genesis maxInitCodeSize`);
    if (runtimeCodeDepositGasHeadroom <= 0) {
      fail(`${name} runtime code deposit exceeds genesis blockGasLimit`);
    }
    return {
      name,
      runtimeBytes,
      initcodeBytes,
      runtimeHeadroom,
      initcodeHeadroom,
      runtimeCodeDepositGas,
      runtimeCodeDepositGasHeadroom,
    };
  });
  return {
    sourceUrl: evidence.sourceUrl,
    sha256: evidence.sha256,
    retrievedAt: evidence.retrievedAt,
    limits: {
      blockGasLimit: evidence.blockGasLimit,
      maxCodeSize: evidence.maxCodeSize,
      maxInitCodeSize: evidence.maxInitCodeSize,
    },
    targets,
  };
}

function validateGenesisDeploymentEvidence(projectRoot) {
  const evidencePath = resolve(projectRoot, GENESIS_EVIDENCE_PATH);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch {
    fail('genesis evidence could not be parsed');
  }
  const artifacts = new Map();
  for (const [name, artifactPath] of RELEASE_ARTIFACTS) {
    try {
      artifacts.set(name, JSON.parse(readFileSync(resolve(projectRoot, artifactPath), 'utf8')));
    } catch {
      fail(`release artifact could not be parsed: ${artifactPath}`);
    }
  }
  return assessGenesisDeploymentEvidence({ evidence, artifacts });
}

function contractNames(sourceDirectory) {
  const names = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      if (!entry.isFile() || !entry.name.endsWith('.sol')) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\b(?:abstract\s+)?(?:contract|interface|library)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        names.add(match[1]);
      }
    }
  };
  visit(sourceDirectory);
  return names;
}

function validateDeployedTargets(manifest, projectRoot) {
  if (!Array.isArray(manifest.deployed)) fail('manifest.deployed must be an array');
  const declaredContracts = contractNames(resolve(projectRoot, 'packages/contracts/src'));
  const deployedNames = new Set();
  for (const target of manifest.deployed) {
    expectExactKeys(target, [
      'name',
      'sourcePath',
      'role',
      'constructorArgsSchema',
      'createdBy',
      'saltDerivation',
      'runtimeCodeHash',
      'initCodeHash',
    ], 'manifest.deployed entry');
    if (typeof target.name !== 'string' || target.name.length === 0) fail('manifest.deployed entry name must be a non-empty string');
    if (!deployedNames.add(target.name)) fail(`manifest.deployed contains duplicate target ${target.name}`);
    if (EXCLUDED_CONTRACTS.has(target.name) && declaredContracts.has(target.name)) {
      fail(`excluded contract appears in deployed targets: ${target.name}`);
    }
    if (typeof target.sourcePath !== 'string' || !target.sourcePath.endsWith('.sol') || !existsSync(resolve(projectRoot, target.sourcePath))) {
      fail(`manifest.deployed sourcePath is missing: ${target.sourcePath}`);
    }
    if (typeof target.role !== 'string' || target.role.length === 0) fail(`manifest.deployed role is invalid for ${target.name}`);
    if (target.constructorArgsSchema === null || typeof target.constructorArgsSchema !== 'object' || Array.isArray(target.constructorArgsSchema)) {
      fail(`manifest.deployed constructorArgsSchema is invalid for ${target.name}`);
    }
    if (target.createdBy !== CREATED_BY) fail(`manifest.deployed createdBy is invalid for ${target.name}`);
    if (target.saltDerivation !== SALT_DERIVATION) fail(`manifest.deployed saltDerivation is invalid for ${target.name}`);
    for (const field of ['runtimeCodeHash', 'initCodeHash']) {
      if (target[field] !== null && (typeof target[field] !== 'string' || !CODE_HASH.test(target[field]))) {
        fail(`manifest.deployed ${field} is invalid for ${target.name}`);
      }
    }
  }
  if (deployedNames.size !== REQUIRED_TARGETS.size) fail('manifest must contain exactly the three project targets');
  for (const [name, sourcePath] of REQUIRED_TARGETS) {
    const target = manifest.deployed.find(candidate => candidate.name === name);
    if (!target) fail(`manifest is missing required target ${name}`);
    if (target.sourcePath !== sourcePath) fail(`manifest sourcePath is invalid for ${name}`);
  }
}

function validateExclusions(manifest) {
  if (!Array.isArray(manifest.excluded)) fail('manifest.excluded must be an array');
  const actual = new Set(manifest.excluded);
  if (actual.size !== manifest.excluded.length || actual.size !== EXCLUDED_CONTRACTS.size) fail('manifest.excluded must list each excluded contract exactly once');
  for (const name of EXCLUDED_CONTRACTS) {
    if (!actual.has(name)) fail(`manifest.excluded is missing ${name}`);
  }
}

function validateAddressManifest(addressManifestPath, projectRoot) {
  const schemaPath = resolve(projectRoot, ADDRESS_MANIFEST_SCHEMA);
  let schema;
  let addressManifest;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    addressManifest = JSON.parse(readFileSync(addressManifestPath, 'utf8'));
  } catch {
    fail('address manifest or schema could not be parsed');
  }
  if (addressManifest.schemaVersion === 'hookemon.phase3.address-manifest-draft.v1') {
    const targetOrder = addressManifest.targets?.map((target) => target.targetId);
    if (JSON.stringify(targetOrder) !== JSON.stringify(['token', 'custody', 'hook'])) {
      fail('address manifest draft targets are not provider ordered');
    }
  }
  const failures = validateJsonSchema(schema, addressManifest);
  if (failures.length > 0) fail(`address manifest schema validation failed: ${failures[0]}`);
  try {
    requireEip55Addresses(addressManifest, 'address manifest');
  } catch (error) {
    fail(error.message);
  }
  return addressManifest.schemaVersion;
}

export function verifyDeploymentManifest(manifest, projectRoot = root, addressManifestPath = resolve(projectRoot, 'release/phase3/address-manifest.json')) {
  expectExactKeys(manifest, [
    'schemaVersion',
    'addressManifestSchema',
    'deployed',
    'excluded',
    'deploymentManifestDigest',
  ], 'manifest');
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) fail('manifest schemaVersion is unsupported');
  if (manifest.addressManifestSchema !== ADDRESS_MANIFEST_SCHEMA || !existsSync(resolve(projectRoot, manifest.addressManifestSchema))) {
    fail('manifest address-manifest schema reference is invalid');
  }
  const addressManifestSchemaVersion = validateAddressManifest(addressManifestPath, projectRoot);
  validateDeployedTargets(manifest, projectRoot);
  validateExclusions(manifest);
  if (typeof manifest.deploymentManifestDigest !== 'string' || !SHA256.test(manifest.deploymentManifestDigest)) {
    fail('manifest digest is invalid');
  }
  const candidate = structuredClone(manifest);
  delete candidate.deploymentManifestDigest;
  const actualDigest = sha256CanonicalJson(candidate);
  if (actualDigest !== manifest.deploymentManifestDigest) {
    fail(`manifest digest mismatch: expected ${manifest.deploymentManifestDigest}, got ${actualDigest}`);
  }
  const genesis = validateGenesisDeploymentEvidence(projectRoot);
  return {
    digest: actualDigest,
    targets: manifest.deployed.map(target => target.name),
    addressManifestSchemaVersion,
    genesis,
  };
}

function parseArgs(argv) {
  const options = {
    manifestPath: resolve(root, 'release/phase3/deployment-manifest.json'),
    addressManifestPath: resolve(root, 'release/phase3/address-manifest.json'),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || (flag !== '--manifest' && flag !== '--address-manifest')) {
      fail('usage: node scripts/verify-deployment-manifest.mjs [--manifest <path>] [--address-manifest <path>]');
    }
    if (flag === '--manifest') options.manifestPath = resolve(value);
    else options.addressManifestPath = resolve(value);
  }
  return options;
}

function main() {
  const { manifestPath, addressManifestPath } = parseArgs(process.argv);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const result = verifyDeploymentManifest(manifest, root, addressManifestPath);
  process.stdout.write(`deployment manifest verified: ${result.digest}\n`);
  process.stdout.write(
    `genesis limits: runtime ${result.genesis.limits.maxCodeSize}, initcode ${result.genesis.limits.maxInitCodeSize}, block gas ${result.genesis.limits.blockGasLimit}\n`,
  );
  for (const target of result.genesis.targets) {
    process.stdout.write(
      `${target.name}: runtime ${target.runtimeBytes}/${target.runtimeHeadroom} headroom, initcode ${target.initcodeBytes}/${target.initcodeHeadroom} headroom, code-deposit gas ${target.runtimeCodeDepositGas}/${target.runtimeCodeDepositGasHeadroom} headroom\n`,
    );
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
