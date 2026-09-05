#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { canonicalJson, sha256CanonicalJson, sha256Bytes } from '../programmable/lib/canonical-json.mjs';
import { requireEip55Address, toEip55Address } from '../programmable/lib/eip55.mjs';
import {
  ALL_HOOK_PERMISSION_MASK,
  PROGRAMMABLE_GRAPH_FACTORY,
  PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
  REQUIRED_HOOK_PERMISSION_MASK,
  computeCreate2Address,
  encodeConstructorConfig,
  mineProgrammableSalt,
  deriveProgrammableEffectiveSalt,
  satisfiesMask,
} from '../mine-hook-address.mjs';
import { keccak256 } from '../../packages/contracts/tooling/payout/canonical-merkle-sum.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const USDG = toEip55Address('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const PINNED_GRAPH_FACTORY = toEip55Address(PROGRAMMABLE_GRAPH_FACTORY);
const PINNED_LAUNCH_STAMP_ROUTER = toEip55Address(PROGRAMMABLE_LAUNCH_STAMP_ROUTER);
const LAUNCH_SOLC = '0.8.26+commit.8a97fa7a';
const TARGET_NAMES = ['token', 'custody', 'hook'];
const PRICE_CANDIDATE_IDS = ['usdgCurrency0', 'hkmnCurrency0'];
const TOKEN_PRICE_REFERENCE = 'pool.selectedPriceCandidate.sqrtPriceX96';
const APPROVED_PRICE_CANDIDATES = Object.freeze({
  usdgCurrency0: '161723809515207654588927258648643645224',
  hkmnCurrency0: '38813714284914462669',
});
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_DEPLOYMENT_MANIFEST_PATH = resolve(REPOSITORY_ROOT, 'release/phase3/deployment-manifest.json');
const DEPLOYMENT_TARGET_NAMES = Object.freeze({
  token: 'HKMNToken',
  custody: 'PermanentPositionCustody',
  hook: 'HookemonHook',
});
const UINT256_MODULUS = 1n << 256n;
const UINT160_MAX = (1n << 160n) - 1n;
const MAX_TARGET_INIT_CODE_BYTES = 49_152;
const MAX_TARGET_INITIALIZER_BYTES = 131_072;
const MAX_TOTAL_INPUT_BYTES = 524_288;
const NATIVE_VALUE_ASSET_ID = 'native';
const NATIVE_VALUE_DECIMALS = 18;

const GRAPH_TARGET_COMMITMENT_TYPE =
  'ProgrammableCreate2GraphTargetCommitmentV1(uint256 targetIndex,bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes32 initCodeHash,bytes32 initializerCalldataHash)';
const GRAPH_COMMITMENT_TYPE =
  'ProgrammableCreate2GraphCommitmentV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,address authorizedLauncher,uint256 totalValue,bytes32 targetCommitmentsHash)';
const GRAPH_AUTHORIZATION_KEY_TYPE =
  'ProgrammableCreate2GraphAuthorizationKeyV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,address authorizedLauncher)';
const GRAPH_DEPLOYMENT_ACCUMULATOR_TYPE =
  'ProgrammableCreate2GraphDeploymentAccumulatorV1(bytes32 previous,uint256 targetIndex,bytes32 targetIdHash,address deployment,bytes32 effectiveSalt,bytes32 initCodeHash,bytes32 initializerCalldataHash,bytes32 runtimeCodeHash,uint256 deploymentValue,uint256 initializerValue)';
const EXPECTED_GRAPH_OUTPUT_TYPE =
  'ProgrammableExpectedGraphOutputV1(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)';
const EXPECTED_GRAPH_RESULT_TYPE =
  'ProgrammableExpectedGraphResultV1(bytes32 expectedOutputsHash,bytes32 graphDeploymentHash)';

export class AddressDerivationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddressDerivationError';
  }
}

function fail(message) {
  throw new AddressDerivationError(message);
}

function expectObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function expectExactKeys(value, keys, label) {
  expectObject(value, label);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}.${key} is not supported`);
  return value;
}

function normalizeAddress(value, label, { nonzero = false } = {}) {
  if (!ADDRESS.test(value ?? '')) fail(`${label} must be an address`);
  let normalized;
  try {
    normalized = requireEip55Address(value, label);
  } catch (error) {
    fail(error.message);
  }
  if (nonzero && /^0x0{40}$/.test(normalized)) fail(`${label} must not be zero`);
  return normalized;
}

function normalizeBytes32(value, label, { nonzero = false } = {}) {
  if (!BYTES32.test(value ?? '')) fail(`${label} must be bytes32`);
  const normalized = value.toLowerCase();
  if (nonzero && /^0x0{64}$/.test(normalized)) fail(`${label} must not be zero`);
  return normalized;
}

function normalizeHex(value, label, { nonempty = false } = {}) {
  if (!HEX.test(value ?? '')) fail(`${label} must be even-length hex`);
  const normalized = value.toLowerCase();
  if (nonempty && normalized === '0x') fail(`${label} must not be empty`);
  return normalized;
}

function normalizeDecimal(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(`${label} must be a canonical integer string`);
  if (positive && value === '0') fail(`${label} must be positive`);
  return value;
}

function normalizeUint256(value, label, options = {}) {
  const normalized = normalizeDecimal(value, label, options);
  if (BigInt(normalized) >= UINT256_MODULUS) fail(`${label} is outside uint256`);
  return normalized;
}

function asSafeInteger(value, label, { minimum = null, maximum = null } = {}) {
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`);
  if (minimum !== null && value < minimum) fail(`${label} is below its minimum`);
  if (maximum !== null && value > maximum) fail(`${label} is above its maximum`);
  return value;
}

function hexToBytes(value, label) {
  const normalized = normalizeHex(value, label);
  return Uint8Array.from(Buffer.from(normalized.slice(2), 'hex'));
}

function bytesToHex(bytes) {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function keccakHex(value, label) {
  return bytesToHex(keccak256(hexToBytes(value, label)));
}

function keccakBytes(bytes) {
  return bytesToHex(keccak256(bytes));
}

function keccakText(value) {
  return bytesToHex(keccak256(new TextEncoder().encode(value)));
}

function wordFromUnsigned(value, bits, label) {
  const parsed = BigInt(value);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (parsed < 0n || parsed > maximum) fail(`${label} is outside uint${bits}`);
  return parsed.toString(16).padStart(64, '0');
}

function wordFromSigned(value, bits, label) {
  const parsed = BigInt(value);
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside int${bits}`);
  const encoded = parsed < 0n ? (1n << 256n) + parsed : parsed;
  return encoded.toString(16).padStart(64, '0');
}

function wordFromAddress(value, label) {
  return normalizeAddress(value, label).toLowerCase().slice(2).padStart(64, '0');
}

function wordFromBytes32(value, label) {
  return normalizeBytes32(value, label).slice(2);
}

function hashStaticWords(words, label) {
  return keccakHex(`0x${words.join('')}`, label);
}

function hashBytes32Array(values, label) {
  const words = values.map((value, index) => wordFromBytes32(value, `${label}[${index}]`));
  return hashStaticWords([
    wordFromUnsigned(32, 256, `${label} offset`),
    wordFromUnsigned(words.length, 256, `${label} length`),
    ...words,
  ], label);
}

function hashPackedBytes32Array(values, label) {
  return hashStaticWords(
    values.map((value, index) => wordFromBytes32(value, `${label}[${index}]`)),
    label,
  );
}

const GRAPH_TARGET_COMMITMENT_TYPEHASH = keccakText(GRAPH_TARGET_COMMITMENT_TYPE);
const GRAPH_COMMITMENT_TYPEHASH = keccakText(GRAPH_COMMITMENT_TYPE);
const GRAPH_AUTHORIZATION_KEY_TYPEHASH = keccakText(GRAPH_AUTHORIZATION_KEY_TYPE);
const GRAPH_DEPLOYMENT_ACCUMULATOR_TYPEHASH = keccakText(GRAPH_DEPLOYMENT_ACCUMULATOR_TYPE);
const EXPECTED_GRAPH_OUTPUT_TYPEHASH = keccakText(EXPECTED_GRAPH_OUTPUT_TYPE);
const EXPECTED_GRAPH_RESULT_TYPEHASH = keccakText(EXPECTED_GRAPH_RESULT_TYPE);
const TOKEN_INITIALIZER_SELECTOR = keccakText('allocate(address)').slice(2, 10);
const CUSTODY_INITIALIZER_SELECTOR = keccakText('configureBindingHook(address)').slice(2, 10);
const HOOK_INITIALIZER_SELECTOR = keccakText('initializeGraphLaunch(address,uint160)').slice(2, 10);

function concatHex(parts, label) {
  return `0x${parts.map((part, index) => normalizeHex(part, `${label}[${index}]`).slice(2)).join('')}`;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} could not be parsed: ${error.message}`);
  }
}

function resolveInputPath(value, inputDirectory) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return isAbsolute(value) ? resolve(value) : resolve(inputDirectory, value);
}

function findArtifactByContractName(directory, contractName) {
  if (!directory || !existsSync(directory)) return null;
  const candidates = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name === `${contractName}.json`) candidates.push(child);
    }
  };
  visit(directory);
  const sorted = candidates.sort();
  if (sorted.length > 1) {
    fail(`multiple ${contractName} artifacts exist under ${directory}; supply targets artifactPath`);
  }
  return sorted[0] ?? null;
}

function resolveArtifactPath(targetName, target, options) {
  const direct = resolveInputPath(options.artifactPaths?.[targetName] ?? target.artifactPath, options.inputDirectory);
  if (direct) return direct;
  const artifactsDirectory = options.artifactsDirectory
    ? resolve(options.artifactsDirectory)
    : resolve(REPOSITORY_ROOT, 'packages/contracts/out');
  const found = findArtifactByContractName(artifactsDirectory, target.contractName);
  if (found) return found;
  fail(`targets.${targetName} needs artifactPath or a matching artifact under ${artifactsDirectory}`);
}

function artifactHex(value, label) {
  return normalizeHex(typeof value === 'string' ? value : value?.object, label, { nonempty: true });
}

function parseArtifactMetadata(artifact, label) {
  let metadata = artifact.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      fail(`${label}.metadata must be JSON`);
    }
  }
  expectObject(metadata, `${label}.metadata`);
  return metadata;
}

function artifactIdentity(metadata, label) {
  const settings = expectObject(metadata.settings, `${label}.settings`);
  const compilationTarget = expectObject(settings.compilationTarget, `${label}.settings.compilationTarget`);
  const entries = Object.entries(compilationTarget);
  if (entries.length !== 1) fail(`${label}.settings.compilationTarget must identify exactly one contract`);
  const [sourcePath, contractName] = entries[0];
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    fail(`${label}.settings.compilationTarget source path must be a string`);
  }
  if (typeof contractName !== 'string' || contractName.length === 0) {
    fail(`${label}.settings.compilationTarget contract name must be a string`);
  }
  return { sourcePath, contractName };
}

function deploymentArtifactIdentity(targetName, target, deploymentManifestPath) {
  const expectedContractName = DEPLOYMENT_TARGET_NAMES[targetName];
  if (target.contractName !== expectedContractName) {
    fail(`targets.${targetName}.contractName does not match the deployment manifest target`);
  }
  const manifest = readJson(deploymentManifestPath, 'deployment manifest');
  if (!Array.isArray(manifest.deployed)) fail('deployment manifest.deployed must be an array');
  const matches = manifest.deployed.filter((entry) => entry?.name === expectedContractName);
  if (matches.length !== 1 || typeof matches[0].sourcePath !== 'string') {
    fail(`deployment manifest must define exactly one ${expectedContractName} target`);
  }
  const deploymentSourcePath = matches[0].sourcePath;
  if (!deploymentSourcePath.startsWith('packages/contracts/')) {
    fail(`deployment manifest sourcePath is invalid for ${expectedContractName}`);
  }
  return {
    sourcePath: deploymentSourcePath.slice('packages/contracts/'.length),
    contractName: expectedContractName,
    deploymentSourcePath,
  };
}

function validateArtifactIdentity(targetName, target, artifact, metadata, deploymentManifestPath) {
  const label = `${targetName} artifact`;
  const identity = artifactIdentity(metadata, label);
  const expected = deploymentArtifactIdentity(targetName, target, deploymentManifestPath);
  if (
    identity.sourcePath !== expected.sourcePath
    || identity.contractName !== expected.contractName
  ) {
    fail(`${label}.metadata.settings.compilationTarget does not match the ${targetName} deployment target`);
  }
  if (identity.contractName !== target.contractName) {
    fail(`${label}.metadata.settings.compilationTarget does not match targets.${targetName}.contractName`);
  }
  if (artifact.contractName !== undefined && artifact.contractName !== identity.contractName) {
    fail(`${label}.contractName conflicts with metadata.settings.compilationTarget`);
  }
  return identity;
}

export function validateArtifactDeploymentIdentity({
  targetName,
  artifact,
  deploymentManifestPath = DEFAULT_DEPLOYMENT_MANIFEST_PATH,
} = {}) {
  if (!Object.hasOwn(DEPLOYMENT_TARGET_NAMES, targetName)) fail('targetName is unsupported');
  expectObject(artifact, `${targetName} artifact`);
  const metadata = parseArtifactMetadata(artifact, `${targetName} artifact`);
  return validateArtifactIdentity(
    targetName,
    { contractName: DEPLOYMENT_TARGET_NAMES[targetName] },
    artifact,
    metadata,
    resolve(deploymentManifestPath),
  );
}

function compilerVersion(artifact, metadata, label) {
  const artifactVersion = artifact.compiler?.version;
  const metadataVersion = metadata.compiler?.version;
  if (
    typeof artifactVersion === 'string'
    && typeof metadataVersion === 'string'
    && artifactVersion !== metadataVersion
  ) {
    fail(`${label} compiler version conflicts with metadata`);
  }
  if (typeof artifactVersion === 'string') return artifactVersion;
  if (typeof metadataVersion === 'string') return metadataVersion;
  fail(`${label} does not record a compiler version`);
}

function normalizeImmutableReferences(value, runtimeTemplate, label) {
  if (value === undefined || value === null) return {};
  expectObject(value, label);
  const runtimeBytes = hexToBytes(runtimeTemplate, `${label} runtime template`);
  const ranges = [];
  const normalized = {};
  for (const astId of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
    if (!/^[0-9]+$/.test(astId)) fail(`${label}.${astId} must be a numeric AST id`);
    if (!Array.isArray(value[astId]) || value[astId].length === 0) fail(`${label}.${astId} must be a non-empty array`);
    normalized[astId] = value[astId].map((reference, index) => {
      expectExactKeys(reference, ['start', 'length'], `${label}.${astId}[${index}]`);
      const start = asSafeInteger(reference.start, `${label}.${astId}[${index}].start`, { minimum: 0 });
      const length = asSafeInteger(reference.length, `${label}.${astId}[${index}].length`, { minimum: 1 });
      if (start + length > runtimeBytes.length) fail(`${label}.${astId}[${index}] exceeds runtime template`);
      ranges.push({ astId, start, length });
      return { start, length };
    });
  }
  ranges.sort((left, right) => left.start - right.start || left.length - right.length || left.astId.localeCompare(right.astId));
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].start + ranges[index - 1].length > ranges[index].start) {
      fail(`${label} contains overlapping immutable references`);
    }
  }
  return normalized;
}

function hasEntries(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
}

function readArtifact(targetName, target, options) {
  const path = resolveArtifactPath(targetName, target, options);
  let bytes;
  try {
    if (!lstatSync(path).isFile()) fail(`${targetName} artifact is not a file`);
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof AddressDerivationError) throw error;
    fail(`${targetName} artifact could not be read: ${error.message}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${targetName} artifact is not JSON`);
  }
  expectObject(artifact, `${targetName} artifact`);
  if (!Array.isArray(artifact.abi)) fail(`${targetName} artifact.abi must be an array`);
  const metadata = parseArtifactMetadata(artifact, `${targetName} artifact`);
  const identity = validateArtifactIdentity(
    targetName,
    target,
    artifact,
    metadata,
    options.deploymentManifestPath,
  );
  const runtimeTemplate = artifactHex(artifact.deployedBytecode, `${targetName} artifact.deployedBytecode`);
  const immutableReferences = normalizeImmutableReferences(
    typeof artifact.deployedBytecode === 'object' ? artifact.deployedBytecode?.immutableReferences : undefined,
    runtimeTemplate,
    `${targetName} artifact.deployedBytecode.immutableReferences`,
  );
  if (typeof artifact.deployedBytecode === 'object' && hasEntries(artifact.deployedBytecode?.linkReferences)) {
    fail(`${targetName} artifact.deployedBytecode has unresolved link references`);
  }
  return {
    path,
    reference: target.artifactPath ?? target.contractName,
    artifact,
    digest: sha256Bytes(bytes),
    compilerVersion: compilerVersion(artifact, metadata, `${targetName} artifact`),
    compilerMetadata: metadata,
    identity,
    creationBytecode: artifactHex(artifact.bytecode, `${targetName} artifact.bytecode`),
    runtimeTemplate,
    immutableReferences,
  };
}

function parseAbiType(parameter, label) {
  if (!parameter || typeof parameter.type !== 'string') fail(`${label}.type is required`);
  const arrayMatch = parameter.type.match(/^(.*)(\[(\d*)\])$/);
  if (arrayMatch) {
    return {
      kind: 'array',
      length: arrayMatch[3] === '' ? null : Number.parseInt(arrayMatch[3], 10),
      element: parseAbiType({ ...parameter, type: arrayMatch[1] }, label),
    };
  }
  if (parameter.type === 'tuple') {
    if (!Array.isArray(parameter.components)) fail(`${label}.components is required`);
    return {
      kind: 'tuple',
      components: parameter.components.map((component, index) => ({
        name: component.name ?? '',
        descriptor: parseAbiType(component, `${label}.components[${index}]`),
      })),
    };
  }
  return { kind: parameter.type };
}

function isDynamicAbiType(descriptor) {
  if (descriptor.kind === 'string' || descriptor.kind === 'bytes') return true;
  if (descriptor.kind === 'array') return descriptor.length === null || isDynamicAbiType(descriptor.element);
  if (descriptor.kind === 'tuple') return descriptor.components.some(({ descriptor: child }) => isDynamicAbiType(child));
  return false;
}

function padRight(bytes) {
  const remainder = bytes.length % 32;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + 32 - remainder);
  padded.set(bytes);
  return padded;
}

function bytesFromWord(word) {
  return Uint8Array.from(Buffer.from(word, 'hex'));
}

function bigintValue(value, label) {
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(`${label} must be a safe integer or string`);
    if (typeof value === 'string' && !/^-?(?:0|[1-9][0-9]*)$/.test(value)) fail(`${label} must be an integer`);
    return BigInt(value);
  } catch (error) {
    if (error instanceof AddressDerivationError) throw error;
    fail(`${label} must be an integer`);
  }
}

function tupleValues(components, value, label) {
  if (Array.isArray(value)) {
    if (value.length !== components.length) fail(`${label} has the wrong tuple length`);
    return value;
  }
  expectObject(value, label);
  return components.map(({ name }, index) => {
    if (!name || !Object.hasOwn(value, name)) fail(`${label}.${name || index} is required`);
    return value[name];
  });
}

function encodeAbiSequence(descriptors, values, label) {
  const encoded = descriptors.map((descriptor, index) => encodeAbiValue(descriptor, values[index], `${label}[${index}]`));
  const headLength = encoded.reduce(
    (total, bytes, index) => total + (isDynamicAbiType(descriptors[index]) ? 32 : bytes.length),
    0,
  );
  const head = [];
  const tail = [];
  let offset = headLength;
  for (const [index, bytes] of encoded.entries()) {
    if (isDynamicAbiType(descriptors[index])) {
      head.push(bytesFromWord(wordFromUnsigned(offset, 256, `${label}[${index}] offset`)));
      tail.push(bytes);
      offset += bytes.length;
    } else {
      head.push(bytes);
    }
  }
  return Uint8Array.from(Buffer.concat([...head, ...tail].map((value) => Buffer.from(value))));
}

function encodeAbiValue(descriptor, value, label) {
  if (descriptor.kind === 'tuple') {
    return encodeAbiSequence(
      descriptor.components.map(({ descriptor: child }) => child),
      tupleValues(descriptor.components, value, label),
      label,
    );
  }
  if (descriptor.kind === 'array') {
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    if (descriptor.length !== null && value.length !== descriptor.length) fail(`${label} has the wrong array length`);
    const elements = encodeAbiSequence(
      Array.from({ length: value.length }, () => descriptor.element),
      value,
      label,
    );
    if (descriptor.length === null) {
      return Uint8Array.from(Buffer.concat([
        Buffer.from(bytesFromWord(wordFromUnsigned(value.length, 256, `${label} length`))),
        Buffer.from(elements),
      ]));
    }
    return elements;
  }
  if (descriptor.kind === 'string') {
    if (typeof value !== 'string') fail(`${label} must be a string`);
    const bytes = Buffer.from(value, 'utf8');
    return Uint8Array.from(Buffer.concat([
      Buffer.from(bytesFromWord(wordFromUnsigned(bytes.length, 256, `${label} length`))),
      Buffer.from(padRight(bytes)),
    ]));
  }
  if (descriptor.kind === 'bytes') {
    const bytes = hexToBytes(value, label);
    return Uint8Array.from(Buffer.concat([
      Buffer.from(bytesFromWord(wordFromUnsigned(bytes.length, 256, `${label} length`))),
      Buffer.from(padRight(bytes)),
    ]));
  }
  if (descriptor.kind === 'address') return bytesFromWord(wordFromAddress(value, label));
  if (descriptor.kind === 'bool') {
    if (typeof value !== 'boolean') fail(`${label} must be boolean`);
    return bytesFromWord(wordFromUnsigned(value ? 1 : 0, 8, label));
  }
  const uintMatch = descriptor.kind.match(/^uint([0-9]*)$/);
  if (uintMatch) {
    const bits = uintMatch[1] === '' ? 256 : Number.parseInt(uintMatch[1], 10);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) fail(`${label} uses an invalid uint width`);
    return bytesFromWord(wordFromUnsigned(bigintValue(value, label), bits, label));
  }
  const intMatch = descriptor.kind.match(/^int([0-9]*)$/);
  if (intMatch) {
    const bits = intMatch[1] === '' ? 256 : Number.parseInt(intMatch[1], 10);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) fail(`${label} uses an invalid int width`);
    return bytesFromWord(wordFromSigned(bigintValue(value, label), bits, label));
  }
  const bytesMatch = descriptor.kind.match(/^bytes([0-9]+)$/);
  if (bytesMatch) {
    const length = Number.parseInt(bytesMatch[1], 10);
    if (length < 1 || length > 32) fail(`${label} uses an invalid bytes width`);
    const bytes = hexToBytes(value, label);
    if (bytes.length !== length) fail(`${label} has the wrong bytes length`);
    return padRight(bytes);
  }
  fail(`${label} uses unsupported ABI type ${descriptor.kind}`);
}

function encodeConstructorArguments(artifact, values, label) {
  const constructor = artifact.abi.find((entry) => entry?.type === 'constructor') ?? {
    type: 'constructor',
    inputs: [],
  };
  if (!Array.isArray(constructor.inputs)) fail(`${label} constructor inputs must be an array`);
  if (!Array.isArray(values) || values.length !== constructor.inputs.length) {
    fail(`${label} constructor argument count does not match its artifact`);
  }
  return bytesToHex(encodeAbiSequence(
    constructor.inputs.map((parameter, index) => parseAbiType(parameter, `${label}.abi[${index}]`)),
    values,
    `${label}.constructorArguments`,
  ));
}

function lookupReference(path, context) {
  if (typeof path !== 'string' || path.length === 0) fail('reference must name a value');
  let current = context;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      fail(`reference ${path} is unresolved`);
    }
    current = current[segment];
  }
  return current;
}

function resolveReferences(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, context));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'ref') return lookupReference(value.ref, context);
    return Object.fromEntries(keys.map((key) => [key, resolveReferences(value[key], context)]));
  }
  return value;
}

function validateCompilerProfile(value) {
  expectExactKeys(value, ['solc', 'optimizer', 'viaIR', 'evmVersion', 'metadata'], 'compilerProfile');
  if (value.solc !== LAUNCH_SOLC) fail(`compilerProfile.solc must be ${LAUNCH_SOLC}`);
  expectExactKeys(value.optimizer, ['enabled', 'runs'], 'compilerProfile.optimizer');
  if (value.optimizer.enabled !== true || value.optimizer.runs !== 1000) fail('compilerProfile.optimizer must use 1000 enabled runs');
  if (value.viaIR !== false || value.evmVersion !== 'cancun') fail('compilerProfile uses an unsupported setting');
  expectExactKeys(value.metadata, ['appendCBOR', 'bytecodeHash', 'useLiteralContent'], 'compilerProfile.metadata');
  if (
    value.metadata.appendCBOR !== false
    || value.metadata.bytecodeHash !== 'none'
    || value.metadata.useLiteralContent !== false
  ) fail('compilerProfile metadata is not launch-compatible');
}

function normalizeNativeValue(value, label) {
  expectExactKeys(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], label);
  if (value.chainId !== '4663') fail(`${label}.chainId must be 4663`);
  if (value.assetId !== NATIVE_VALUE_ASSET_ID) fail(`${label}.assetId must be ${NATIVE_VALUE_ASSET_ID}`);
  if (value.decimals !== NATIVE_VALUE_DECIMALS) fail(`${label}.decimals must be ${NATIVE_VALUE_DECIMALS}`);
  return {
    chainId: value.chainId,
    assetId: value.assetId,
    decimals: value.decimals,
    amountAtomic: normalizeUint256(value.amountAtomic, `${label}.amountAtomic`),
  };
}

function validateApplicantSalt(value, label) {
  expectObject(value, label);
  if (value.mode === 'fixed') {
    expectExactKeys(value, ['mode', 'value'], label);
    return { mode: 'fixed', value: normalizeBytes32(value.value, `${label}.value`) };
  }
  if (value.mode === 'mine') {
    expectExactKeys(value, ['mode', 'start', 'maxAttempts'], label);
    const start = normalizeDecimal(value.start, `${label}.start`);
    const maxAttempts = normalizeDecimal(value.maxAttempts, `${label}.maxAttempts`, { positive: true });
    if (BigInt(start) >= 1n << 256n) fail(`${label}.start is outside bytes32`);
    if (BigInt(maxAttempts) > 2_000_000n) fail(`${label}.maxAttempts exceeds the local mining bound`);
    return { mode: 'mine', start, maxAttempts };
  }
  fail(`${label}.mode must be fixed or mine`);
}

function normalizeRuntimeImmutablePatches(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const patches = value.map((patch, index) => {
    expectExactKeys(patch, ['astId', 'start', 'length', 'value'], `${label}[${index}]`);
    if (typeof patch.astId !== 'string' || !/^[0-9]+$/.test(patch.astId)) {
      fail(`${label}[${index}].astId must be a numeric AST id`);
    }
    const start = asSafeInteger(patch.start, `${label}[${index}].start`, { minimum: 0 });
    const length = asSafeInteger(patch.length, `${label}[${index}].length`, { minimum: 1 });
    const valueHex = normalizeHex(patch.value, `${label}[${index}].value`);
    if (hexToBytes(valueHex, `${label}[${index}].value`).length !== length) {
      fail(`${label}[${index}].value does not match its byte length`);
    }
    return { astId: patch.astId, start, length, value: valueHex };
  });
  patches.sort((left, right) => (
    left.astId.localeCompare(right.astId, 'en')
    || left.start - right.start
    || left.length - right.length
    || left.value.localeCompare(right.value, 'en')
  ));
  for (let index = 1; index < patches.length; index += 1) {
    const previous = patches[index - 1];
    const current = patches[index];
    if (previous.astId === current.astId && previous.start === current.start && previous.length === current.length) {
      fail(`${label} duplicates an immutable patch range`);
    }
  }
  return patches;
}

function validateTarget(value, targetName) {
  const keys = targetName === 'hook'
    ? [
      'targetIndex', 'targetId', 'targetIdHash', 'applicantSalt', 'artifactPath', 'contractName', 'initializerCalldata',
      'deploymentValue', 'initializerValue', 'runtimeImmutablePatches',
    ]
    : [
      'targetIndex', 'targetId', 'targetIdHash', 'applicantSalt', 'artifactPath', 'contractName', 'constructorArguments',
      'initializerCalldata', 'deploymentValue', 'initializerValue', 'runtimeImmutablePatches',
    ];
  expectObject(value, `targets.${targetName}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`targets.${targetName}.${key} is not supported`);
  for (const key of [
    'targetIndex', 'targetId', 'targetIdHash', 'applicantSalt', 'contractName', 'initializerCalldata', 'deploymentValue',
    'initializerValue', 'runtimeImmutablePatches',
  ]) {
    if (!Object.hasOwn(value, key)) fail(`targets.${targetName}.${key} is required`);
  }
  if (targetName !== 'hook' && !Object.hasOwn(value, 'constructorArguments')) {
    fail(`targets.${targetName}.constructorArguments is required`);
  }
  if (typeof value.targetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/.test(value.targetId)) {
    fail(`targets.${targetName}.targetId is invalid`);
  }
  if (Object.hasOwn(value, 'artifactPath') && (typeof value.artifactPath !== 'string' || value.artifactPath.length === 0)) {
    fail(`targets.${targetName}.artifactPath must be a path`);
  }
  if (typeof value.contractName !== 'string' || value.contractName.length === 0) {
    fail(`targets.${targetName}.contractName must be a string`);
  }
  if (targetName === 'hook' && value.contractName !== 'HookemonHook') {
    fail('targets.hook.contractName must be HookemonHook');
  }
  if (targetName !== 'hook' && !Array.isArray(value.constructorArguments)) fail(`targets.${targetName}.constructorArguments must be an array`);
  return {
    ...value,
    targetIndex: asSafeInteger(value.targetIndex, `targets.${targetName}.targetIndex`, { minimum: 0, maximum: 255 }),
    targetIdHash: normalizeBytes32(value.targetIdHash, `targets.${targetName}.targetIdHash`, { nonzero: true }),
    applicantSalt: validateApplicantSalt(value.applicantSalt, `targets.${targetName}.applicantSalt`),
    initializerCalldata: normalizeHex(value.initializerCalldata, `targets.${targetName}.initializerCalldata`),
    deploymentValue: normalizeNativeValue(value.deploymentValue, `targets.${targetName}.deploymentValue`),
    initializerValue: normalizeNativeValue(value.initializerValue, `targets.${targetName}.initializerValue`),
    runtimeImmutablePatches: normalizeRuntimeImmutablePatches(
      value.runtimeImmutablePatches,
      `targets.${targetName}.runtimeImmutablePatches`,
    ),
  };
}

function validatePriceCandidate(value, id, label) {
  expectExactKeys(value, ['sqrtPriceX96'], label);
  const sqrtPriceX96 = normalizeDecimal(value.sqrtPriceX96, `${label}.sqrtPriceX96`, { positive: true });
  if (BigInt(sqrtPriceX96) > UINT160_MAX) fail(`${label}.sqrtPriceX96 is outside uint160`);
  if (sqrtPriceX96 !== APPROVED_PRICE_CANDIDATES[id]) {
    fail(`${label}.sqrtPriceX96 is not the approved ${id} price`);
  }
  return { sqrtPriceX96 };
}

function validateLaunchInputs(value) {
  expectExactKeys(value, [
    'schemaVersion', 'chain', 'graphAuthorization', 'compilerProfile', 'usdg', 'roles', 'pool',
    'hookConstructorConfig', 'targets',
  ], 'launchInputs');
  if (value.schemaVersion !== 'hookemon.phase3.launch-inputs.v1') fail('launchInputs.schemaVersion is unsupported');
  expectExactKeys(value.chain, ['chainId', 'factory', 'authorizedLauncher', 'routeNamespace', 'routeNonce'], 'chain');
  if (normalizeDecimal(value.chain.chainId, 'chain.chainId', { positive: true }) !== '4663') fail('chain.chainId must be 4663');
  const factory = normalizeAddress(value.chain.factory, 'chain.factory');
  if (factory !== PINNED_GRAPH_FACTORY) fail('chain.factory does not match the pinned graph factory');
  const authorizedLauncher = normalizeAddress(value.chain.authorizedLauncher, 'chain.authorizedLauncher');
  if (authorizedLauncher !== PINNED_LAUNCH_STAMP_ROUTER) {
    fail('chain.authorizedLauncher does not match the pinned launch-stamp router');
  }
  normalizeBytes32(value.chain.routeNamespace, 'chain.routeNamespace', { nonzero: true });
  normalizeBytes32(value.chain.routeNonce, 'chain.routeNonce', { nonzero: true });
  expectExactKeys(value.graphAuthorization, ['topologyHash', 'totalValue'], 'graphAuthorization');
  const graphAuthorization = {
    topologyHash: normalizeBytes32(value.graphAuthorization.topologyHash, 'graphAuthorization.topologyHash', { nonzero: true }),
    totalValue: normalizeNativeValue(value.graphAuthorization.totalValue, 'graphAuthorization.totalValue'),
  };
  validateCompilerProfile(value.compilerProfile);
  const usdg = normalizeAddress(value.usdg, 'usdg');
  if (usdg !== USDG) fail('usdg does not match the pinned chain-4663 asset');
  const roleNames = ['manager', 'positionManager', 'permit2', 'programmable', 'treasury', 'operations', 'launchAuthority', 'issuanceAuthority'];
  expectExactKeys(value.roles, roleNames, 'roles');
  const roles = Object.fromEntries(roleNames.map((name) => [
    name,
    normalizeAddress(value.roles[name], `roles.${name}`, { nonzero: true }),
  ]));
  if (roles.issuanceAuthority !== factory) {
    fail('roles.issuanceAuthority must match chain.factory');
  }
  if (roles.launchAuthority === factory) {
    fail('roles.launchAuthority must differ from chain.factory');
  }
  expectExactKeys(value.pool, ['fee', 'tickSpacing', 'priceCandidates'], 'pool');
  if (value.pool.fee !== 0) fail('pool.fee must be zero');
  asSafeInteger(value.pool.tickSpacing, 'pool.tickSpacing', { minimum: 1, maximum: 32_767 });
  expectExactKeys(value.pool.priceCandidates, PRICE_CANDIDATE_IDS, 'pool.priceCandidates');
  const priceCandidates = Object.fromEntries(PRICE_CANDIDATE_IDS.map((id) => [
    id,
    validatePriceCandidate(value.pool.priceCandidates[id], id, `pool.priceCandidates.${id}`),
  ]));
  expectObject(value.hookConstructorConfig, 'hookConstructorConfig');
  if (value.hookConstructorConfig.expectedDecimals !== 18) {
    fail('hookConstructorConfig.expectedDecimals must be 18 for HKMNToken');
  }
  expectExactKeys(value.targets, TARGET_NAMES, 'targets');
  const targets = Object.fromEntries(TARGET_NAMES.map((name) => [name, validateTarget(value.targets[name], name)]));
  const targetIds = new Set();
  const targetHashes = new Set();
  for (const name of TARGET_NAMES) {
    if (targetIds.has(targets[name].targetId)) fail(`targets.${name}.targetId duplicates another target`);
    if (targetHashes.has(targets[name].targetIdHash)) fail(`targets.${name}.targetIdHash duplicates another target`);
    targetIds.add(targets[name].targetId);
    targetHashes.add(targets[name].targetIdHash);
    if (targets[name].targetIndex !== TARGET_NAMES.indexOf(name)) {
      fail(`targets.${name}.targetIndex must be ${TARGET_NAMES.indexOf(name)}`);
    }
    if (targets[name].initializerCalldata === '0x') {
      fail(`targets.${name}.initializerCalldata must contain exactly one raw initializer call`);
    }
  }
  const graphValueSum = TARGET_NAMES.reduce(
    (sum, name) => (
      sum
      + BigInt(targets[name].deploymentValue.amountAtomic)
      + BigInt(targets[name].initializerValue.amountAtomic)
    ),
    0n,
  );
  if (graphValueSum !== BigInt(graphAuthorization.totalValue.amountAtomic)) {
    fail('graphAuthorization.totalValue does not equal target deployment and initializer values');
  }
  return {
    ...value,
    chain: {
      chainId: value.chain.chainId,
      factory,
      authorizedLauncher,
      routeNamespace: value.chain.routeNamespace.toLowerCase(),
      routeNonce: value.chain.routeNonce.toLowerCase(),
    },
    graphAuthorization,
    usdg,
    roles,
    pool: {
      fee: value.pool.fee,
      tickSpacing: value.pool.tickSpacing,
      priceCandidates,
    },
    targets,
  };
}

function flattenImmutableReferences(immutableReferences) {
  return Object.entries(immutableReferences)
    .flatMap(([astId, references]) => references.map(({ start, length }) => ({ astId, start, length })))
    .sort((left, right) => (
      left.astId.localeCompare(right.astId, 'en')
      || left.start - right.start
      || left.length - right.length
    ));
}

function materializeRuntimeCode(targetName, target, artifact) {
  const references = flattenImmutableReferences(artifact.immutableReferences);
  const patches = target.runtimeImmutablePatches;
  if (patches.length !== references.length) {
    fail(`targets.${targetName}.runtimeImmutablePatches must cover every artifact immutable reference`);
  }
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const patch = patches[index];
    if (
      patch.astId !== reference.astId
      || patch.start !== reference.start
      || patch.length !== reference.length
    ) {
      fail(`targets.${targetName}.runtimeImmutablePatches does not match artifact immutable references`);
    }
  }
  const runtime = Buffer.from(hexToBytes(artifact.runtimeTemplate, `${targetName} runtime template`));
  for (const patch of patches) {
    Buffer.from(hexToBytes(patch.value, `targets.${targetName}.runtimeImmutablePatches value`)).copy(runtime, patch.start);
  }
  return {
    runtimeTemplateCode: artifact.runtimeTemplate,
    runtimeTemplateCodeHash: keccakHex(artifact.runtimeTemplate, `${targetName}.runtimeTemplateCode`),
    runtimeImmutableReferences: artifact.immutableReferences,
    runtimeImmutablePatches: patches,
    runtimeCode: bytesToHex(runtime),
    runtimeCodeHash: keccakBytes(runtime),
  };
}

function targetResult({ targetName, target, artifact, constructorArguments, applicantSalt, effectiveSalt, address, mode }) {
  const initCode = concatHex([artifact.creationBytecode, constructorArguments], `${targetName}.initCode`);
  const initCodeHash = keccakHex(initCode, `${targetName}.initCode`);
  if (hexToBytes(initCode, `${targetName}.initCode`).length > MAX_TARGET_INIT_CODE_BYTES) {
    fail(`${targetName}.initCode exceeds the factory limit`);
  }
  if (hexToBytes(target.initializerCalldata, `${targetName}.initializerCalldata`).length > MAX_TARGET_INITIALIZER_BYTES) {
    fail(`targets.${targetName}.initializerCalldata exceeds the factory limit`);
  }
  const runtime = materializeRuntimeCode(targetName, target, artifact);
  return {
    targetIndex: target.targetIndex,
    targetId: target.targetId,
    targetIdHash: target.targetIdHash,
    artifactPath: artifact.reference,
    artifactDigest: artifact.digest,
    compilerVersion: artifact.compilerVersion,
    creationBytecode: artifact.creationBytecode,
    constructorArguments,
    initCode,
    initCodeHash,
    initializerCalldata: target.initializerCalldata,
    initializerCalldataHash: keccakHex(target.initializerCalldata, `${targetName}.initializerCalldata`),
    deploymentValue: target.deploymentValue.amountAtomic,
    initializerValue: target.initializerValue.amountAtomic,
    ...runtime,
    applicantSalt,
    applicantSaltMode: mode,
    effectiveSalt,
    address,
  };
}

function deriveFixedTarget({ targetName, target, artifact, constructorArguments, inputs }) {
  const initCode = concatHex([artifact.creationBytecode, constructorArguments], `${targetName}.initCode`);
  const initCodeHash = keccakHex(initCode, `${targetName}.initCode`);
  if (target.applicantSalt.mode !== 'fixed') fail(`targets.${targetName} must use a fixed applicant salt`);
  const effectiveSalt = deriveProgrammableEffectiveSalt({
    chainId: inputs.chain.chainId,
    factory: inputs.chain.factory,
    routeNamespace: inputs.chain.routeNamespace,
    routeNonce: inputs.chain.routeNonce,
    targetIdHash: target.targetIdHash,
    applicantSalt: target.applicantSalt.value,
    authorizedLauncher: inputs.chain.authorizedLauncher,
  });
  const address = toEip55Address(computeCreate2Address(inputs.chain.factory, effectiveSalt, initCodeHash));
  return targetResult({
    targetName,
    target,
    artifact,
    constructorArguments,
    applicantSalt: target.applicantSalt.value,
    effectiveSalt,
    address,
    mode: 'fixed',
  });
}

function deriveHookTarget({ target, artifact, config, inputs }) {
  const constructorArguments = encodeConstructorConfig(config).toLowerCase();
  const expectedByArtifact = encodeConstructorArguments(artifact.artifact, [config], 'hook artifact').toLowerCase();
  if (constructorArguments !== expectedByArtifact) fail('hook artifact constructor ABI does not match ConstructorConfig');
  const initCode = concatHex([artifact.creationBytecode, constructorArguments], 'hook.initCode');
  const initCodeHash = keccakHex(initCode, 'hook.initCode');
  let mined;
  if (target.applicantSalt.mode === 'mine') {
    mined = mineProgrammableSalt({
      chainId: inputs.chain.chainId,
      factory: inputs.chain.factory,
      routeNamespace: inputs.chain.routeNamespace,
      routeNonce: inputs.chain.routeNonce,
      targetIdHash: target.targetIdHash,
      authorizedLauncher: inputs.chain.authorizedLauncher,
      initCodeHashHex: initCodeHash,
      mask: ALL_HOOK_PERMISSION_MASK,
      required: REQUIRED_HOOK_PERMISSION_MASK,
      startSalt: BigInt(target.applicantSalt.start),
      maxAttempts: Number(target.applicantSalt.maxAttempts),
    });
  } else {
    const effectiveSalt = deriveProgrammableEffectiveSalt({
      chainId: inputs.chain.chainId,
      factory: inputs.chain.factory,
      routeNamespace: inputs.chain.routeNamespace,
      routeNonce: inputs.chain.routeNonce,
      targetIdHash: target.targetIdHash,
      applicantSalt: target.applicantSalt.value,
      authorizedLauncher: inputs.chain.authorizedLauncher,
    });
    mined = {
      applicantSalt: target.applicantSalt.value,
      effectiveSalt,
      address: toEip55Address(computeCreate2Address(inputs.chain.factory, effectiveSalt, initCodeHash)),
    };
  }
  if (!satisfiesMask(mined.address, ALL_HOOK_PERMISSION_MASK, REQUIRED_HOOK_PERMISSION_MASK)) {
    fail('hook address does not satisfy permission bits 0x20cc');
  }
  return targetResult({
    targetName: 'hook',
    target,
    artifact,
    constructorArguments,
    applicantSalt: mined.applicantSalt,
    effectiveSalt: mined.effectiveSalt,
    address: toEip55Address(mined.address),
    mode: target.applicantSalt.mode === 'mine' ? 'mined' : 'fixed',
  });
}

function derivePool(tokenAddress, hookAddress, inputs, priceCandidate) {
  const tokenFirst = BigInt(tokenAddress) < BigInt(inputs.usdg);
  const currency0 = tokenFirst ? tokenAddress : inputs.usdg;
  const currency1 = tokenFirst ? inputs.usdg : tokenAddress;
  const poolKeyEncoded = `0x${[
    wordFromAddress(currency0, 'pool.currency0'),
    wordFromAddress(currency1, 'pool.currency1'),
    wordFromUnsigned(inputs.pool.fee, 24, 'pool.fee'),
    wordFromSigned(inputs.pool.tickSpacing, 24, 'pool.tickSpacing'),
    wordFromAddress(hookAddress, 'pool.hooks'),
  ].join('')}`;
  return {
    currency0,
    currency1,
    fee: inputs.pool.fee,
    tickSpacing: inputs.pool.tickSpacing,
    hooks: hookAddress,
    selectedOrdering: priceCandidate.id,
    priceCandidate: {
      id: priceCandidate.id,
      sqrtPriceX96: priceCandidate.sqrtPriceX96,
    },
    sqrtPriceX96: priceCandidate.sqrtPriceX96,
    poolKeyEncoded,
    poolId: keccakHex(poolKeyEncoded, 'pool key'),
  };
}

function targetCommitment(target) {
  return hashStaticWords([
    wordFromBytes32(GRAPH_TARGET_COMMITMENT_TYPEHASH, 'graph target commitment typehash'),
    wordFromUnsigned(target.targetIndex, 256, `${target.targetId}.targetIndex`),
    wordFromBytes32(target.targetIdHash, `${target.targetId}.targetIdHash`),
    wordFromBytes32(target.applicantSalt, `${target.targetId}.applicantSalt`),
    wordFromUnsigned(target.deploymentValue, 256, `${target.targetId}.deploymentValue`),
    wordFromUnsigned(target.initializerValue, 256, `${target.targetId}.initializerValue`),
    wordFromBytes32(target.initCodeHash, `${target.targetId}.initCodeHash`),
    wordFromBytes32(target.initializerCalldataHash, `${target.targetId}.initializerCalldataHash`),
  ], `${target.targetId}.graphTargetCommitment`);
}

function expectedOutputHash(output) {
  return hashStaticWords([
    wordFromBytes32(EXPECTED_GRAPH_OUTPUT_TYPEHASH, 'expected graph output typehash'),
    wordFromUnsigned(output.targetIndex, 8, `expected output ${output.targetIndex}.targetIndex`),
    wordFromBytes32(output.targetIdHash, `expected output ${output.targetIndex}.targetIdHash`),
    wordFromAddress(output.account, `expected output ${output.targetIndex}.account`),
    wordFromBytes32(output.runtimeCodeHash, `expected output ${output.targetIndex}.runtimeCodeHash`),
  ], `expected output ${output.targetIndex}`);
}

export function deriveGraphCommitment({ chain, graphAuthorization, targets }) {
  if (!Array.isArray(targets) || targets.length !== TARGET_NAMES.length) {
    fail(`graph must contain exactly ${TARGET_NAMES.length} targets`);
  }
  const orderedTargets = [...targets].sort((left, right) => left.targetIndex - right.targetIndex);
  for (let index = 0; index < orderedTargets.length; index += 1) {
    if (orderedTargets[index].targetIndex !== index) fail('graph target indexes must be contiguous from zero');
  }
  const totalValue = normalizeUint256(graphAuthorization.totalValue, 'graphAuthorization.totalValue');
  const targetValueSum = orderedTargets.reduce(
    (sum, target) => sum + BigInt(target.deploymentValue) + BigInt(target.initializerValue),
    0n,
  );
  if (targetValueSum !== BigInt(totalValue)) {
    fail('graphAuthorization.totalValue does not equal target deployment and initializer values');
  }
  const totalInputBytes = orderedTargets.reduce(
    (sum, target) => sum
      + hexToBytes(target.initCode, `${target.targetId}.initCode`).length
      + hexToBytes(target.initializerCalldata, `${target.targetId}.initializerCalldata`).length,
    0,
  );
  if (totalInputBytes > MAX_TOTAL_INPUT_BYTES) fail('graph input bytes exceed the factory limit');

  const targetCommitments = orderedTargets.map((target) => ({
    targetIndex: target.targetIndex,
    targetId: target.targetId,
    targetIdHash: target.targetIdHash,
    applicantSalt: target.applicantSalt,
    deploymentValue: target.deploymentValue,
    initializerValue: target.initializerValue,
    initCodeHash: target.initCodeHash,
    initializerCalldataHash: target.initializerCalldataHash,
    commitment: targetCommitment(target),
  }));
  const targetCommitmentsHash = hashBytes32Array(
    targetCommitments.map((target) => target.commitment),
    'graph target commitments',
  );
  const graphCommitment = hashStaticWords([
    wordFromBytes32(GRAPH_COMMITMENT_TYPEHASH, 'graph commitment typehash'),
    wordFromUnsigned(chain.chainId, 256, 'chain.chainId'),
    wordFromAddress(chain.factory, 'chain.factory'),
    wordFromBytes32(chain.routeNamespace, 'chain.routeNamespace'),
    wordFromBytes32(chain.routeNonce, 'chain.routeNonce'),
    wordFromBytes32(graphAuthorization.topologyHash, 'graphAuthorization.topologyHash'),
    wordFromAddress(chain.authorizedLauncher, 'chain.authorizedLauncher'),
    wordFromUnsigned(totalValue, 256, 'graphAuthorization.totalValue'),
    wordFromBytes32(targetCommitmentsHash, 'graph target commitments hash'),
  ], 'graph commitment');
  const authorizationKey = hashStaticWords([
    wordFromBytes32(GRAPH_AUTHORIZATION_KEY_TYPEHASH, 'graph authorization key typehash'),
    wordFromUnsigned(chain.chainId, 256, 'chain.chainId'),
    wordFromAddress(chain.factory, 'chain.factory'),
    wordFromBytes32(chain.routeNamespace, 'chain.routeNamespace'),
    wordFromBytes32(chain.routeNonce, 'chain.routeNonce'),
    wordFromAddress(chain.authorizedLauncher, 'chain.authorizedLauncher'),
  ], 'graph authorization key');
  const expectedOutputs = orderedTargets.map((target) => ({
    targetIndex: target.targetIndex,
    targetIdHash: target.targetIdHash,
    account: target.address,
    runtimeCodeHash: target.runtimeCodeHash,
  }));
  const expectedOutputsHash = hashPackedBytes32Array(
    expectedOutputs.map((output) => expectedOutputHash(output)),
    'expected graph outputs',
  );

  let previous = graphCommitment;
  const steps = orderedTargets.map((target) => {
    const next = hashStaticWords([
      wordFromBytes32(GRAPH_DEPLOYMENT_ACCUMULATOR_TYPEHASH, 'graph deployment accumulator typehash'),
      wordFromBytes32(previous, `graph deployment ${target.targetIndex}.previous`),
      wordFromUnsigned(target.targetIndex, 256, `${target.targetId}.targetIndex`),
      wordFromBytes32(target.targetIdHash, `${target.targetId}.targetIdHash`),
      wordFromAddress(target.address, `${target.targetId}.address`),
      wordFromBytes32(target.effectiveSalt, `${target.targetId}.effectiveSalt`),
      wordFromBytes32(target.initCodeHash, `${target.targetId}.initCodeHash`),
      wordFromBytes32(target.initializerCalldataHash, `${target.targetId}.initializerCalldataHash`),
      wordFromBytes32(target.runtimeCodeHash, `${target.targetId}.runtimeCodeHash`),
      wordFromUnsigned(target.deploymentValue, 256, `${target.targetId}.deploymentValue`),
      wordFromUnsigned(target.initializerValue, 256, `${target.targetId}.initializerValue`),
    ], `graph deployment ${target.targetIndex}`);
    const step = { targetIndex: target.targetIndex, previous, next };
    previous = next;
    return step;
  });
  const expectedGraphDeploymentHash = previous;
  const expectedResultHash = hashStaticWords([
    wordFromBytes32(EXPECTED_GRAPH_RESULT_TYPEHASH, 'expected graph result typehash'),
    wordFromBytes32(expectedOutputsHash, 'expected graph outputs hash'),
    wordFromBytes32(expectedGraphDeploymentHash, 'expected graph deployment hash'),
  ], 'expected graph result');
  return {
    typeHashes: {
      targetCommitment: GRAPH_TARGET_COMMITMENT_TYPEHASH,
      graphCommitment: GRAPH_COMMITMENT_TYPEHASH,
      authorizationKey: GRAPH_AUTHORIZATION_KEY_TYPEHASH,
      deploymentAccumulator: GRAPH_DEPLOYMENT_ACCUMULATOR_TYPEHASH,
      expectedOutput: EXPECTED_GRAPH_OUTPUT_TYPEHASH,
      expectedResult: EXPECTED_GRAPH_RESULT_TYPEHASH,
    },
    orderedTargetIds: orderedTargets.map((target) => target.targetId),
    authorization: {
      routeNamespace: chain.routeNamespace,
      routeNonce: chain.routeNonce,
      topologyHash: graphAuthorization.topologyHash,
      graphCommitment,
      authorizedLauncher: chain.authorizedLauncher,
      totalValue,
      authorizationKey,
    },
    targetCommitments,
    targetCommitmentsHash,
    expectedOutputs,
    expectedOutputsHash,
    deploymentAccumulator: {
      initial: graphCommitment,
      steps,
      final: expectedGraphDeploymentHash,
    },
    expectedGraphDeploymentHash,
    expectedResultHash,
    totalInputBytes,
  };
}

function verifyArtifactCompiler(targetName, artifact, inputs) {
  if (artifact.compilerVersion !== inputs.compilerProfile.solc) {
    fail(`${targetName} artifact compiler ${artifact.compilerVersion} does not match the launch profile`);
  }
  const settings = artifact.compilerMetadata.settings;
  expectObject(settings, `${targetName} artifact.metadata.settings`);
  if (
    settings.optimizer?.enabled !== inputs.compilerProfile.optimizer.enabled
    || settings.optimizer?.runs !== inputs.compilerProfile.optimizer.runs
  ) {
    fail(`${targetName} artifact optimizer does not match the launch profile`);
  }
  if (settings.viaIR !== inputs.compilerProfile.viaIR) {
    fail(`${targetName} artifact viaIR does not match the launch profile`);
  }
  if (settings.evmVersion !== inputs.compilerProfile.evmVersion) {
    fail(`${targetName} artifact evmVersion does not match the launch profile`);
  }
  if (
    settings.metadata?.appendCBOR !== inputs.compilerProfile.metadata.appendCBOR
    || settings.metadata?.bytecodeHash !== inputs.compilerProfile.metadata.bytecodeHash
    || settings.metadata?.useLiteralContent !== inputs.compilerProfile.metadata.useLiteralContent
  ) {
    fail(`${targetName} artifact metadata does not match the launch profile`);
  }
}

function requireHookConfig(config, inputs, tokenAddress) {
  const expectedKeys = [
    'manager', 'positionManager', 'permit2', 'usdg', 'hkmn', 'tickSpacing', 'programmable', 'treasury', 'operations',
    'launchAuthority', 'issuanceAuthority', 'expectedDecimals', 'bindingDigest', 'runtimeDigest', 'processClaimLimit6h',
    'processClaimLimitMax', 'processClaimMaxCount', 'operationsRotationDelay',
  ];
  expectExactKeys(config, expectedKeys, 'hookConstructorConfig');
  const expectedAddresses = {
    manager: inputs.roles.manager,
    positionManager: inputs.roles.positionManager,
    permit2: inputs.roles.permit2,
    usdg: inputs.usdg,
    hkmn: tokenAddress,
    programmable: inputs.roles.programmable,
    treasury: inputs.roles.treasury,
    operations: inputs.roles.operations,
    launchAuthority: inputs.roles.launchAuthority,
    issuanceAuthority: inputs.roles.issuanceAuthority,
  };
  const normalizedAddresses = {};
  for (const [name, expected] of Object.entries(expectedAddresses)) {
    const address = normalizeAddress(config[name], `hookConstructorConfig.${name}`);
    if (address !== expected) {
      fail(`hookConstructorConfig.${name} does not bind the frozen launch input`);
    }
    normalizedAddresses[name] = address;
  }
  if (config.tickSpacing !== inputs.pool.tickSpacing) fail('hookConstructorConfig.tickSpacing does not match pool.tickSpacing');
  asSafeInteger(config.expectedDecimals, 'hookConstructorConfig.expectedDecimals', { minimum: 0, maximum: 255 });
  normalizeBytes32(config.bindingDigest, 'hookConstructorConfig.bindingDigest', { nonzero: true });
  normalizeBytes32(config.runtimeDigest, 'hookConstructorConfig.runtimeDigest', { nonzero: true });
  normalizeDecimal(String(config.processClaimLimit6h), 'hookConstructorConfig.processClaimLimit6h');
  normalizeDecimal(String(config.processClaimLimitMax), 'hookConstructorConfig.processClaimLimitMax');
  normalizeDecimal(String(config.processClaimMaxCount), 'hookConstructorConfig.processClaimMaxCount', { positive: true });
  normalizeDecimal(String(config.operationsRotationDelay), 'hookConstructorConfig.operationsRotationDelay', { positive: true });
  if (BigInt(config.processClaimLimit6h) > BigInt(config.processClaimLimitMax)) {
    fail('hookConstructorConfig.processClaimLimit6h exceeds its maximum');
  }
  return {
    ...config,
    ...normalizedAddresses,
    bindingDigest: config.bindingDigest.toLowerCase(),
    runtimeDigest: config.runtimeDigest.toLowerCase(),
  };
}

function requireConstructorShape(artifact, expectedInputs, label) {
  const constructor = artifact.abi.find((entry) => entry?.type === 'constructor') ?? {
    type: 'constructor',
    inputs: [],
  };
  if (!Array.isArray(constructor.inputs) || constructor.inputs.length !== expectedInputs.length) {
    fail(`${label} constructor ABI does not match the graph target`);
  }
  for (const [index, expected] of expectedInputs.entries()) {
    const actual = constructor.inputs[index];
    if (actual?.name !== expected.name || actual?.type !== expected.type) {
      fail(`${label} constructor ABI does not match the graph target`);
    }
  }
}

function requireTokenConstructorTemplate(target) {
  const expected = [
    { ref: 'chain.factory' },
    { ref: 'usdg' },
    18,
    { ref: TOKEN_PRICE_REFERENCE },
  ];
  if (canonicalJson(target.constructorArguments) !== canonicalJson(expected)) {
    fail('targets.token.constructorArguments must bind the selected address-order price candidate');
  }
}

function requireTokenConstructorArguments(target, artifact, constructorArguments, inputs, sqrtPriceX96) {
  if (target.contractName !== 'HKMNToken') fail('targets.token.contractName must be HKMNToken');
  requireConstructorShape(artifact.artifact, [
    { name: 'issuanceAuthority', type: 'address' },
    { name: 'expectedUsdg', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'launchSqrtPriceX96', type: 'uint160' },
  ], 'token artifact');
  const expected = encodeConstructorArguments(artifact.artifact, [
    inputs.chain.factory,
    inputs.usdg,
    inputs.hookConstructorConfig.expectedDecimals,
    sqrtPriceX96,
  ], 'token artifact').toLowerCase();
  if (constructorArguments !== expected) {
    fail('targets.token.constructorArguments must bind factory, USDG, hook decimals, and pool price');
  }
}

function deriveTokenFromPriceCandidates(inputs, artifact) {
  const target = inputs.targets.token;
  requireTokenConstructorTemplate(target);
  const candidates = PRICE_CANDIDATE_IDS.map((id) => {
    const priceCandidate = { id, ...inputs.pool.priceCandidates[id] };
    const candidateContext = structuredClone(inputs);
    candidateContext.pool.selectedPriceCandidate = priceCandidate;
    const constructorArguments = encodeConstructorArguments(
      artifact.artifact,
      resolveReferences(target.constructorArguments, candidateContext),
      'token artifact',
    ).toLowerCase();
    requireTokenConstructorArguments(
      target,
      artifact,
      constructorArguments,
      inputs,
      priceCandidate.sqrtPriceX96,
    );
    const token = deriveFixedTarget({
      targetName: 'token',
      target,
      artifact,
      constructorArguments,
      inputs,
    });
    const tokenIsCurrency0 = BigInt(token.address) < BigInt(inputs.usdg);
    return {
      priceCandidate,
      token,
      matchesAddressOrder: id === 'hkmnCurrency0' ? tokenIsCurrency0 : !tokenIsCurrency0,
    };
  });
  const fixedPoints = candidates.filter(({ matchesAddressOrder }) => matchesAddressOrder);
  if (fixedPoints.length !== 1) {
    fail('pool.priceCandidates must produce exactly one address-order fixed point');
  }
  return fixedPoints[0];
}

function requireCustodyConstructorArguments(target, artifact, constructorArguments, inputs) {
  if (target.contractName !== 'PermanentPositionCustody') {
    fail('targets.custody.contractName must be PermanentPositionCustody');
  }
  requireConstructorShape(artifact.artifact, [
    { name: 'manager', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
  ], 'custody artifact');
  const expected = encodeConstructorArguments(
    artifact.artifact,
    [inputs.roles.positionManager, 0],
    'custody artifact',
  ).toLowerCase();
  if (constructorArguments !== expected) {
    fail('targets.custody.constructorArguments must bind the PositionManager and token ID zero');
  }
}

function requireCanonicalInitializers(inputs, targets, priceCandidate) {
  const expectedInitializers = {
    token: `0x${TOKEN_INITIALIZER_SELECTOR}${wordFromAddress(
      targets.hook.address,
      'targets.hook.address',
    )}`,
    custody: `0x${CUSTODY_INITIALIZER_SELECTOR}${wordFromAddress(
      targets.hook.address,
      'targets.hook.address',
    )}`,
    hook: `0x${HOOK_INITIALIZER_SELECTOR}${wordFromAddress(
      targets.custody.address,
      'targets.custody.address',
    )}${wordFromUnsigned(priceCandidate.sqrtPriceX96, 160, 'pool.priceCandidates selected sqrtPriceX96')}`,
  };
  for (const name of TARGET_NAMES) {
    if (inputs.targets[name].initializerCalldata !== expectedInitializers[name]) {
      fail(`targets.${name}.initializerCalldata does not match its required raw initializer`);
    }
  }
}

function ensureUniqueTargetResults(targets) {
  const effectiveSalts = new Set();
  const addresses = new Set();
  for (const target of Object.values(targets)) {
    if (effectiveSalts.has(target.effectiveSalt)) fail('graph has duplicate effective salts');
    if (addresses.has(target.address)) fail('graph has duplicate target addresses');
    effectiveSalts.add(target.effectiveSalt);
    addresses.add(target.address);
  }
}

export function deriveAddresses({
  launchInputs,
  inputDirectory = process.cwd(),
  artifactPaths = {},
  artifactsDirectory,
  deploymentManifestPath = DEFAULT_DEPLOYMENT_MANIFEST_PATH,
} = {}) {
  const inputs = validateLaunchInputs(launchInputs);
  const options = {
    inputDirectory: resolve(inputDirectory),
    artifactPaths,
    artifactsDirectory,
    deploymentManifestPath: resolve(deploymentManifestPath),
  };
  const tokenArtifact = readArtifact('token', inputs.targets.token, options);
  verifyArtifactCompiler('token', tokenArtifact, inputs);
  const { priceCandidate, token } = deriveTokenFromPriceCandidates(inputs, tokenArtifact);
  const context = structuredClone(inputs);
  context.pool.selectedPriceCandidate = priceCandidate;
  context.addresses = {};
  context.addresses.token = token.address;

  const hookArtifact = readArtifact('hook', inputs.targets.hook, options);
  verifyArtifactCompiler('hook', hookArtifact, inputs);
  const hookConfig = requireHookConfig(resolveReferences(inputs.hookConstructorConfig, context), inputs, token.address);
  const hook = deriveHookTarget({ target: inputs.targets.hook, artifact: hookArtifact, config: hookConfig, inputs });
  context.addresses.hook = hook.address;

  const pool = derivePool(token.address, hook.address, inputs, priceCandidate);
  context.pool.poolId = pool.poolId;
  context.pool.currency0 = pool.currency0;
  context.pool.currency1 = pool.currency1;

  const custodyArtifact = readArtifact('custody', inputs.targets.custody, options);
  verifyArtifactCompiler('custody', custodyArtifact, inputs);
  const custodyConstructorArguments = encodeConstructorArguments(
    custodyArtifact.artifact,
    resolveReferences(inputs.targets.custody.constructorArguments, context),
    'custody artifact',
  ).toLowerCase();
  requireCustodyConstructorArguments(
    inputs.targets.custody,
    custodyArtifact,
    custodyConstructorArguments,
    inputs,
  );
  const custody = deriveFixedTarget({
    targetName: 'custody',
    target: inputs.targets.custody,
    artifact: custodyArtifact,
    constructorArguments: custodyConstructorArguments,
    inputs,
  });
  context.addresses.custody = custody.address;

  const targets = { token, hook, custody };
  ensureUniqueTargetResults(targets);
  requireCanonicalInitializers(inputs, targets, priceCandidate);
  const graph = deriveGraphCommitment({
    chain: inputs.chain,
    graphAuthorization: {
      topologyHash: inputs.graphAuthorization.topologyHash,
      totalValue: inputs.graphAuthorization.totalValue.amountAtomic,
    },
    targets: TARGET_NAMES.map((name) => targets[name]),
  });
  return {
    schemaVersion: 'hookemon.phase3.derived-addresses.v1',
    chain: inputs.chain,
    compilerProfileDigest: sha256CanonicalJson(inputs.compilerProfile),
    launchInputsDigest: sha256CanonicalJson(inputs),
    targets,
    pool,
    graph,
  };
}

export function verifyDerivedAddresses({
  launchInputs,
  derived,
  inputDirectory = process.cwd(),
  artifactPaths = {},
  artifactsDirectory,
  deploymentManifestPath = DEFAULT_DEPLOYMENT_MANIFEST_PATH,
} = {}) {
  expectObject(derived, 'derived');
  const recomputed = deriveAddresses({
    launchInputs,
    inputDirectory,
    artifactPaths,
    artifactsDirectory,
    deploymentManifestPath,
  });
  if (canonicalJson(recomputed) !== canonicalJson(derived)) fail('derived address mismatch');
  return true;
}

function parseArgs(argv) {
  const options = {
    inputPath: null,
    outputPath: null,
    verifyPath: null,
    artifactsDirectory: null,
    artifactPaths: {},
  };
  const artifactFlags = new Map([
    ['--token-artifact', 'token'],
    ['--hook-artifact', 'hook'],
    ['--custody-artifact', 'custody'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.inputPath = argv[++index];
    else if (argument === '--output') options.outputPath = argv[++index];
    else if (argument === '--verify') options.verifyPath = argv[++index];
    else if (argument === '--artifacts') options.artifactsDirectory = argv[++index];
    else if (artifactFlags.has(argument)) options.artifactPaths[artifactFlags.get(argument)] = argv[++index];
    else fail(`unrecognized argument: ${argument}`);
  }
  if (!options.inputPath) fail('--input is required');
  if (options.outputPath && options.verifyPath) fail('--output and --verify cannot be combined');
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const inputPath = resolve(options.inputPath);
  const inputDirectory = dirname(inputPath);
  const launchInputs = readJson(inputPath, 'launch inputs');
  const common = {
    launchInputs,
    inputDirectory,
    artifactPaths: options.artifactPaths,
    artifactsDirectory: options.artifactsDirectory,
  };
  if (options.verifyPath) {
    const derived = readJson(resolve(options.verifyPath), 'derived addresses');
    verifyDerivedAddresses({ ...common, derived });
    process.stdout.write(`${JSON.stringify({ verified: true, schemaVersion: derived.schemaVersion }, null, 2)}\n`);
    return;
  }
  const derived = deriveAddresses(common);
  if (options.outputPath) {
    writeFileSync(resolve(options.outputPath), `${JSON.stringify(derived, null, 2)}\n`, { flag: 'wx' });
    return;
  }
  process.stdout.write(`${JSON.stringify(derived, null, 2)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
