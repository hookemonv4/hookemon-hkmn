#!/usr/bin/env node
// Mines a CREATE2 salt for HookemonHook so the deployed address satisfies the hook's own
// finalized permission-mask requirement (mirrored below from
// packages/contracts/src/HookemonHook.sol -- ALL_HOOK_PERMISSION_MASK / REQUIRED_HOOK_PERMISSION_MASK;
// if that file's mask constants ever change, this mirror must change with them or mining
// against a stale mask silently produces a wrong address).
//
// The raw-salt mode remains for compatibility with earlier local evidence. Provider launch mining
// must supply the graph salt inputs and use mineProgrammableSalt(), which derives the factory
// effective salt before checking the address mask.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { keccak256 } from '../packages/contracts/tooling/payout/canonical-merkle-sum.mjs';
import { nowIso } from './lib/util.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const UINT256_MODULUS = 1n << 256n;
const LAUNCH_SOLC = '0.8.26+commit.8a97fa7a';
const LAUNCH_METADATA = Object.freeze({ appendCBOR: false, bytecodeHash: 'none', useLiteralContent: false });

// The historical (v1, USDG quote) and native (v2, ETH quote) launch profiles differ only in
// optimizer runs and viaIR. A profile is selected from the ConstructorConfig field identity
// (isNativeConstructorConfig), never from a caller flag.
export const HISTORICAL_LAUNCH_PROFILE = Object.freeze({
  solc: LAUNCH_SOLC,
  optimizer: Object.freeze({ enabled: true, runs: 1000 }),
  viaIR: false,
  evmVersion: 'cancun',
  metadata: LAUNCH_METADATA,
});
export const NATIVE_LAUNCH_PROFILE = Object.freeze({
  solc: LAUNCH_SOLC,
  optimizer: Object.freeze({ enabled: true, runs: 200 }),
  viaIR: true,
  evmVersion: 'cancun',
  metadata: LAUNCH_METADATA,
});

// Repository identity of the hook target, as recorded by release/phase3/deployment-manifest.json
// (packages/contracts/src/HookemonHook.sol) relative to the Foundry root.
const HOOK_SOURCE_PATH = 'src/HookemonHook.sol';
const HOOK_CONTRACT_NAME = 'HookemonHook';
const HOOK_CONSTRUCTOR_FIELDS = Object.freeze([
  'manager', 'positionManager', 'permit2', 'usdg', 'hkmn', 'tickSpacing', 'programmable', 'treasury', 'operations',
  'launchAuthority', 'issuanceAuthority', 'expectedDecimals', 'bindingDigest', 'runtimeDigest', 'processClaimLimit6h',
  'processClaimLimitMax', 'processClaimMaxCount', 'operationsRotationDelay',
]);
const NATIVE_CONSTRUCTOR_FIELD_NAMES = Object.freeze({
  usdg: 'quoteCurrency',
  processClaimLimit6h: 'processClaimLimit6hWei',
  processClaimLimitMax: 'processClaimLimitMaxWei',
});
const NATIVE_HOOK_CONSTRUCTOR_FIELDS = Object.freeze(
  HOOK_CONSTRUCTOR_FIELDS.map((field) => NATIVE_CONSTRUCTOR_FIELD_NAMES[field] ?? field),
);

// Mirrored from packages/contracts/src/HookemonHook.sol -- see the file-level comment above.
export const ALL_HOOK_PERMISSION_MASK = 0x3fffn; // (1 << 14) - 1
export const REQUIRED_HOOK_PERMISSION_MASK = 0x20ccn;

// The standard, widely-deployed deterministic CREATE2 deployer proxy (Arachnid's
// "deterministic-deployment-proxy", also Foundry's default `CREATE2_DEPLOYER`).
export const STANDARD_CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

export const PROGRAMMABLE_GRAPH_FACTORY = '0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd';
export const PROGRAMMABLE_LAUNCH_STAMP_ROUTER = '0x34965f2a2ee9254522232c32f02056e92be0c98a';
export const PROGRAMMABLE_TARGET_SALT_TYPE =
  'ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)';

// A non-production ConstructorConfig. Every placeholder is replaced by WP04A's address manifest
// before production mining.
export const EXAMPLE_CONFIG = {
  manager: '0x1111111111111111111111111111111111111111', // PLACEHOLDER_WP04A
  positionManager: '0x2222222222222222222222222222222222222222', // PLACEHOLDER_WP04A
  permit2: '0x3333333333333333333333333333333333333333', // PLACEHOLDER_WP04A
  usdg: '0x4444444444444444444444444444444444444444', // PLACEHOLDER_WP04A
  hkmn: '0x5555555555555555555555555555555555555555', // PLACEHOLDER_WP04A
  tickSpacing: 60, // PLACEHOLDER_WP04A
  programmable: '0x6666666666666666666666666666666666666666', // PLACEHOLDER_WP04A
  treasury: '0x7777777777777777777777777777777777777777', // PLACEHOLDER_WP04A
  operations: '0x8888888888888888888888888888888888888888', // PLACEHOLDER_WP04A
  launchAuthority: '0x9999999999999999999999999999999999999999', // PLACEHOLDER_WP04A
  issuanceAuthority: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // PLACEHOLDER_WP04A
  expectedDecimals: 18, // PLACEHOLDER_WP04A
  bindingDigest: `0x${'77'.repeat(32)}`, // PLACEHOLDER_WP04A
  runtimeDigest: `0x${'88'.repeat(32)}`, // PLACEHOLDER_WP04A
  processClaimLimit6h: '1000000', // PLACEHOLDER_WP04A
  processClaimLimitMax: '2000000', // PLACEHOLDER_WP04A
  processClaimMaxCount: '8', // PLACEHOLDER_WP04A
  operationsRotationDelay: '259200', // PLACEHOLDER_WP04A
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function hexToBytes(value) {
  invariant(HEX_BYTES.test(value ?? ''), `invalid hex bytes: ${value}`);
  const digits = value.slice(2);
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Solidity ABI encoding of one static-only struct (HookemonHook.ConstructorConfig): every field
// is a value type (address/int24/uint8/bytes32), so the encoding is exactly the concatenation of
// each field's 32-byte word in declared order -- no dynamic-type head/tail indirection applies.
// ---------------------------------------------------------------------------

function addressWord(address) {
  invariant(ADDRESS.test(address ?? ''), `expected a 20-byte address, got ${address}`);
  return address.toLowerCase().slice(2).padStart(64, '0');
}

function uintWord(value, bits) {
  const big = BigInt(value);
  const max = (1n << BigInt(bits)) - 1n;
  invariant(big >= 0n && big <= max, `value ${value} out of range for uint${bits}`);
  return big.toString(16).padStart(64, '0');
}

function intWord(value, bits) {
  const big = BigInt(value);
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  invariant(big >= min && big <= max, `value ${value} out of range for int${bits}`);
  const twosComplement = big < 0n ? (1n << 256n) + big : big;
  return twosComplement.toString(16).padStart(64, '0');
}

function bytes32Word(value) {
  invariant(BYTES32.test(value ?? ''), `expected a bytes32 value, got ${value}`);
  return value.slice(2).toLowerCase();
}

function nonzeroBytes32Word(value, label) {
  const word = bytes32Word(value);
  invariant(word !== ZERO_BYTES32.slice(2), `${label} must not be zero`);
  return word;
}

function nonzeroAddressWord(value, label) {
  const word = addressWord(value);
  invariant(word !== '0'.repeat(64), `${label} must not be zero`);
  return word;
}

export const PROGRAMMABLE_TARGET_SALT_TYPEHASH = bytesToHex(
  keccak256(new TextEncoder().encode(PROGRAMMABLE_TARGET_SALT_TYPE)),
);

export function deriveProgrammableEffectiveSalt({
  chainId,
  factory,
  routeNamespace,
  routeNonce,
  targetIdHash,
  applicantSalt,
  authorizedLauncher,
}) {
  const normalizedChainId = BigInt(chainId);
  invariant(normalizedChainId > 0n, 'chainId must be positive');
  const encoded = `0x${[
    bytes32Word(PROGRAMMABLE_TARGET_SALT_TYPEHASH),
    uintWord(normalizedChainId, 256),
    nonzeroAddressWord(factory, 'factory'),
    nonzeroBytes32Word(routeNamespace, 'routeNamespace'),
    nonzeroBytes32Word(routeNonce, 'routeNonce'),
    nonzeroBytes32Word(targetIdHash, 'targetIdHash'),
    bytes32Word(applicantSalt),
    nonzeroAddressWord(authorizedLauncher, 'authorizedLauncher'),
  ].join('')}`;
  return bytesToHex(keccak256(hexToBytes(encoded))).toLowerCase();
}

/// Field order MUST match HookemonHook.ConstructorConfig exactly:
///   manager, positionManager, permit2, usdg, hkmn, tickSpacing, programmable, treasury,
///   operations, launchAuthority, issuanceAuthority, expectedDecimals, bindingDigest,
///   runtimeDigest, processClaimLimit6h, processClaimLimitMax, processClaimMaxCount,
///   operationsRotationDelay
export function encodeConstructorConfig(config) {
  const words = [
    addressWord(config.manager),
    addressWord(config.positionManager),
    addressWord(config.permit2),
    addressWord(config.usdg),
    addressWord(config.hkmn),
    intWord(config.tickSpacing, 24),
    addressWord(config.programmable),
    addressWord(config.treasury),
    addressWord(config.operations),
    addressWord(config.launchAuthority),
    addressWord(config.issuanceAuthority),
    uintWord(config.expectedDecimals, 8),
    bytes32Word(config.bindingDigest),
    bytes32Word(config.runtimeDigest),
    uintWord(config.processClaimLimit6h, 256),
    uintWord(config.processClaimLimitMax, 256),
    uintWord(config.processClaimMaxCount, 256),
    uintWord(config.operationsRotationDelay, 256),
  ];
  return `0x${words.join('')}`;
}

// Native constructor values retain the exact Solidity field order. Historical callers use
// encodeConstructorConfig; they cannot supply a native quote without this explicit interface.
export function encodeNativeConstructorConfig(config) {
  invariant(config && typeof config === 'object', 'native constructor config is required');
  invariant(!Object.hasOwn(config, 'usdg') && !Object.hasOwn(config, 'processClaimLimit6h')
    && !Object.hasOwn(config, 'processClaimLimitMax'), 'historical constructor fields cannot execute a native launch');
  invariant(addressWord(config.quoteCurrency) === '0'.repeat(64), 'native quoteCurrency must be zero');
  for (const name of ['processClaimLimit6hWei', 'processClaimLimitMaxWei']) {
    invariant(typeof config[name] === 'string' && /^[1-9][0-9]*$/.test(config[name]), `${name} must be an explicit positive wei integer`);
  }
  invariant(BigInt(config.processClaimLimit6hWei) <= BigInt(config.processClaimLimitMaxWei), 'native claim limit exceeds maximum');
  const { quoteCurrency, processClaimLimit6hWei, processClaimLimitMaxWei, ...shared } = config;
  return encodeConstructorConfig({ ...shared, usdg: quoteCurrency,
    processClaimLimit6h: processClaimLimit6hWei, processClaimLimitMax: processClaimLimitMaxWei });
}

// A native ConstructorConfig is identified by the complete native field set (quoteCurrency,
// processClaimLimit6hWei, processClaimLimitMaxWei); a historical config carries none of them.
export function isNativeConstructorConfig(config) {
  invariant(config !== null && typeof config === 'object' && !Array.isArray(config), 'constructor config is required');
  const nativeFields = Object.values(NATIVE_CONSTRUCTOR_FIELD_NAMES).filter((field) => Object.hasOwn(config, field)).length;
  const historicalFields = Object.keys(NATIVE_CONSTRUCTOR_FIELD_NAMES).filter((field) => Object.hasOwn(config, field)).length;
  invariant(
    nativeFields === 0 || (nativeFields === 3 && historicalFields === 0),
    'constructor config must use either the historical or the complete native field set',
  );
  return nativeFields === 3;
}

export function readHookCreationBytecode({
  contractsRoot,
  forgeBinary = 'forge',
  execImpl = execFileSync,
} = {}) {
  const stdout = execImpl(forgeBinary, ['inspect', 'HookemonHook', 'bytecode'], {
    cwd: contractsRoot,
    encoding: 'utf8',
  });
  const bytecode = stdout.trim();
  invariant(HEX_BYTES.test(bytecode) && bytecode.length > 2, 'forge inspect returned non-hex bytecode');
  return bytecode;
}

function artifactBytecode(value, label) {
  const bytecode = typeof value === 'string' ? value : value?.object;
  invariant(HEX_BYTES.test(bytecode ?? '') && bytecode.length > 2, `${label} must be non-empty hex bytecode`);
  return bytecode;
}

function parseArtifactMetadata(artifact, label) {
  let metadata = artifact.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch (error) {
      throw new Error(`${label}.metadata must be JSON: ${error.message}`);
    }
  }
  invariant(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata), `${label}.metadata is required`);
  return metadata;
}

// solc 0.8.26 writes settings.metadata.useLiteralContent into the metadata JSON only when the
// Standard JSON input enabled it; the omitted key is the documented false default
// (https://docs.soliditylang.org/en/v0.8.26/metadata.html,
// https://docs.soliditylang.org/en/v0.8.26/using-the-compiler.html). Only the omitted key is
// normalized; an explicit value of any type is compared as written, and bytecodeHash and
// appendCBOR have no default.
export function artifactUseLiteralContent(settingsMetadata) {
  if (settingsMetadata === null || typeof settingsMetadata !== 'object' || Array.isArray(settingsMetadata)) return undefined;
  return Object.hasOwn(settingsMetadata, 'useLiteralContent') ? settingsMetadata.useLiteralContent : false;
}

// Compiler exports carry no top-level contractName; metadata.settings.compilationTarget is the
// required identity (https://docs.soliditylang.org/en/v0.8.26/metadata.html). A present
// contractName must agree with it.
function validateHookArtifactIdentity(artifact, metadata, label) {
  const settings = metadata.settings;
  invariant(settings !== null && typeof settings === 'object' && !Array.isArray(settings), `${label}.metadata.settings is required`);
  const compilationTarget = settings.compilationTarget;
  invariant(
    compilationTarget !== null && typeof compilationTarget === 'object' && !Array.isArray(compilationTarget),
    `${label}.metadata.settings.compilationTarget is required`,
  );
  const entries = Object.entries(compilationTarget);
  invariant(entries.length === 1, `${label}.metadata.settings.compilationTarget must identify exactly one contract`);
  const [sourcePath, contractName] = entries[0];
  invariant(
    sourcePath === HOOK_SOURCE_PATH && contractName === HOOK_CONTRACT_NAME,
    `${label} must compile ${HOOK_SOURCE_PATH}:${HOOK_CONTRACT_NAME}`,
  );
  invariant(
    artifact.contractName === undefined || artifact.contractName === contractName,
    `${label}.contractName conflicts with metadata.settings.compilationTarget`,
  );
}

function validateLaunchArtifactProfile(artifact, metadata, label, profile) {
  const artifactVersion = artifact.compiler?.version;
  const metadataVersion = metadata.compiler?.version;
  invariant(
    typeof artifactVersion !== 'string' || typeof metadataVersion !== 'string' || artifactVersion === metadataVersion,
    `${label} compiler version conflicts with metadata`,
  );
  const version = artifactVersion ?? metadataVersion;
  invariant(version === profile.solc, `${label} compiler must be ${profile.solc}`);
  const settings = metadata.settings;
  invariant(settings !== null && typeof settings === 'object' && !Array.isArray(settings), `${label}.metadata.settings is required`);
  invariant(
    settings.optimizer?.enabled === true && settings.optimizer?.runs === profile.optimizer.runs,
    `${label} optimizer must use ${profile.optimizer.runs} enabled runs`,
  );
  invariant(settings.viaIR === profile.viaIR, `${label} viaIR must be ${profile.viaIR}`);
  invariant(settings.evmVersion === profile.evmVersion, `${label} evmVersion must be ${profile.evmVersion}`);
  invariant(
    settings.metadata?.appendCBOR === profile.metadata.appendCBOR
      && settings.metadata?.bytecodeHash === profile.metadata.bytecodeHash
      && artifactUseLiteralContent(settings.metadata) === profile.metadata.useLiteralContent,
    `${label} metadata is not launch-compatible`,
  );
}

function validateHookConstructorAbi(artifact, label, native) {
  const expected = native ? NATIVE_HOOK_CONSTRUCTOR_FIELDS : HOOK_CONSTRUCTOR_FIELDS;
  const constructor = Array.isArray(artifact.abi) ? artifact.abi.find((entry) => entry?.type === 'constructor') : undefined;
  const components = constructor?.inputs?.length === 1 && constructor.inputs[0]?.type === 'tuple'
    ? constructor.inputs[0].components
    : undefined;
  invariant(
    Array.isArray(components)
      && components.length === expected.length
      && components.every((component, index) => component?.name === expected[index]),
    `${label} constructor ABI does not match the ${native ? 'native' : 'historical'} ConstructorConfig`,
  );
}

// The historical profile is the default; native callers select it through the config identity.
export function readHookLaunchArtifactBytecode(artifactPath, { native = false } = {}) {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new Error(`hook artifact could not be parsed: ${error.message}`);
  }
  invariant(artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact), 'hook artifact must be an object');
  const metadata = parseArtifactMetadata(artifact, 'hook artifact');
  validateHookArtifactIdentity(artifact, metadata, 'hook artifact');
  validateLaunchArtifactProfile(artifact, metadata, 'hook artifact', native ? NATIVE_LAUNCH_PROFILE : HISTORICAL_LAUNCH_PROFILE);
  validateHookConstructorAbi(artifact, 'hook artifact', native);
  return artifactBytecode(artifact.bytecode, 'hook artifact.bytecode');
}

export function computeInitCodeHash(creationBytecodeHex, constructorConfigHex) {
  const initCode = concatBytes([hexToBytes(creationBytecodeHex), hexToBytes(constructorConfigHex)]);
  return bytesToHex(keccak256(initCode));
}

export function computeCreate2Address(deployer, saltHex, initCodeHashHex) {
  invariant(ADDRESS.test(deployer ?? ''), 'deployer must be a 20-byte address');
  invariant(BYTES32.test(saltHex ?? ''), 'salt must be bytes32');
  invariant(BYTES32.test(initCodeHashHex ?? ''), 'initCodeHash must be bytes32');
  const packed = concatBytes([
    Uint8Array.of(0xff),
    hexToBytes(deployer),
    hexToBytes(saltHex),
    hexToBytes(initCodeHashHex),
  ]);
  const hash = keccak256(packed);
  return `0x${bytesToHex(hash).slice(-40)}`;
}

export function satisfiesMask(address, mask, required) {
  return (BigInt(address) & mask) === required;
}

function normalizeSaltSearchRange(startSalt, maxAttempts) {
  let normalizedStart;
  try {
    normalizedStart = BigInt(startSalt);
  } catch {
    throw new Error('startSalt must be an integer');
  }
  const normalizedAttempts = Number(maxAttempts);
  invariant(normalizedStart >= 0n && normalizedStart < UINT256_MODULUS, 'startSalt must fit bytes32');
  invariant(Number.isSafeInteger(normalizedAttempts) && normalizedAttempts > 0, 'maxAttempts must be a positive safe integer');
  invariant(
    normalizedStart + BigInt(normalizedAttempts) <= UINT256_MODULUS,
    'salt search range exceeds bytes32',
  );
  return { startSalt: normalizedStart, maxAttempts: normalizedAttempts };
}

/// Iterates salts starting at `startSalt`, incrementing by one, until the resulting CREATE2
/// address's low bits match `required` under `mask`. Expected iterations for a 14-bit mask
/// average 2^13; `maxAttempts` bounds worst case so this never spins forever on a bad input.
export function mineSalt({
  deployer,
  initCodeHashHex,
  mask,
  required,
  startSalt = 0n,
  maxAttempts = 2_000_000,
}) {
  const range = normalizeSaltSearchRange(startSalt, maxAttempts);
  for (let attempt = 0; attempt < range.maxAttempts; attempt += 1) {
    const saltValue = range.startSalt + BigInt(attempt);
    const saltHex = `0x${saltValue.toString(16).padStart(64, '0')}`;
    const address = computeCreate2Address(deployer, saltHex, initCodeHashHex);
    if (satisfiesMask(address, mask, required)) {
      return { salt: saltHex, address, attempts: attempt + 1 };
    }
  }
  throw new Error(`no salt found matching the permission mask within ${maxAttempts} attempts`);
}

export function mineProgrammableSalt({
  chainId,
  factory = PROGRAMMABLE_GRAPH_FACTORY,
  routeNamespace,
  routeNonce,
  targetIdHash,
  authorizedLauncher = PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
  initCodeHashHex,
  mask,
  required,
  startSalt = 0n,
  maxAttempts = 2_000_000,
}) {
  invariant(BYTES32.test(initCodeHashHex ?? ''), `expected a bytes32 value, got ${initCodeHashHex}`);
  const range = normalizeSaltSearchRange(startSalt, maxAttempts);
  for (let attempt = 0; attempt < range.maxAttempts; attempt += 1) {
    const applicantSalt = `0x${(range.startSalt + BigInt(attempt)).toString(16).padStart(64, '0')}`;
    const effectiveSalt = deriveProgrammableEffectiveSalt({
      chainId,
      factory,
      routeNamespace,
      routeNonce,
      targetIdHash,
      applicantSalt,
      authorizedLauncher,
    });
    const address = computeCreate2Address(factory, effectiveSalt, initCodeHashHex);
    if (satisfiesMask(address, mask, required)) {
      return { applicantSalt, effectiveSalt, address, attempts: attempt + 1 };
    }
  }
  throw new Error(`no applicant salt found matching the permission mask within ${maxAttempts} attempts`);
}

export function loadConfig(configPath) {
  if (!configPath) return { config: EXAMPLE_CONFIG, source: 'EXAMPLE_CONFIG (documented placeholder; see file header)' };
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return { config, source: path.resolve(configPath) };
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    configPath: null,
    deployer: STANDARD_CREATE2_DEPLOYER,
    startSalt: 0n,
    maxAttempts: 2_000_000,
    contractsRoot: 'packages/contracts',
    forgeBinary: 'forge',
    hookArtifactPath: null,
    providerSalt: null,
  };
  const providerSalt = {};
  let providerFlagUsed = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--config') {
      options.configPath = args[++i];
    } else if (arg === '--deployer') {
      options.deployer = args[++i];
    } else if (arg === '--start-salt') {
      options.startSalt = BigInt(args[++i]);
    } else if (arg === '--max-attempts') {
      options.maxAttempts = Number.parseInt(args[++i], 10);
    } else if (arg === '--contracts-root') {
      options.contractsRoot = args[++i];
    } else if (arg === '--forge-binary') {
      options.forgeBinary = args[++i];
    } else if (arg === '--hook-artifact') {
      options.hookArtifactPath = args[++i];
    } else if (arg === '--provider-chain-id') {
      providerSalt.chainId = args[++i];
      providerFlagUsed = true;
    } else if (arg === '--provider-factory') {
      providerSalt.factory = args[++i];
      providerFlagUsed = true;
    } else if (arg === '--route-namespace') {
      providerSalt.routeNamespace = args[++i];
      providerFlagUsed = true;
    } else if (arg === '--route-nonce') {
      providerSalt.routeNonce = args[++i];
      providerFlagUsed = true;
    } else if (arg === '--target-id-hash') {
      providerSalt.targetIdHash = args[++i];
      providerFlagUsed = true;
    } else if (arg === '--authorized-launcher') {
      providerSalt.authorizedLauncher = args[++i];
      providerFlagUsed = true;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  if (providerFlagUsed) {
    const providerFlags = {
      chainId: '--provider-chain-id',
      factory: '--provider-factory',
      routeNamespace: '--route-namespace',
      routeNonce: '--route-nonce',
      targetIdHash: '--target-id-hash',
      authorizedLauncher: '--authorized-launcher',
    };
    for (const field of ['chainId', 'factory', 'routeNamespace', 'routeNonce', 'targetIdHash', 'authorizedLauncher']) {
      invariant(providerSalt[field] !== undefined, `${providerFlags[field]} is required for provider mining`);
    }
    options.providerSalt = providerSalt;
  }
  return options;
}

export function mineHookAddress(options) {
  const { config, source } = loadConfig(options.configPath);
  const native = isNativeConstructorConfig(config);

  if (options.providerSalt && !options.hookArtifactPath) {
    throw new Error('provider mining requires --hook-artifact compiled with the frozen launch profile');
  }
  const creationBytecode = options.providerSalt
    ? readHookLaunchArtifactBytecode(options.hookArtifactPath, { native })
    : readHookCreationBytecode({
      contractsRoot: options.contractsRoot,
      forgeBinary: options.forgeBinary,
    });
  const constructorConfigHex = (native ? encodeNativeConstructorConfig : encodeConstructorConfig)(config);
  const initCodeHash = computeInitCodeHash(creationBytecode, constructorConfigHex);

  const mined = options.providerSalt
    ? mineProgrammableSalt({
      ...options.providerSalt,
      initCodeHashHex: initCodeHash,
      mask: ALL_HOOK_PERMISSION_MASK,
      required: REQUIRED_HOOK_PERMISSION_MASK,
      startSalt: options.startSalt,
      maxAttempts: options.maxAttempts,
    })
    : mineSalt({
      deployer: options.deployer,
      initCodeHashHex: initCodeHash,
      mask: ALL_HOOK_PERMISSION_MASK,
      required: REQUIRED_HOOK_PERMISSION_MASK,
      startSalt: options.startSalt,
      maxAttempts: options.maxAttempts,
    });

  return {
    schemaVersion: options.providerSalt
      ? 'hookemon.mined-provider-hook-address.v1'
      : 'hookemon.mined-hook-address.v1',
    observedAt: nowIso(),
    configSource: source,
    ...(options.providerSalt ? { hookArtifact: path.resolve(options.hookArtifactPath) } : {}),
    deployer: options.providerSalt?.factory ?? options.deployer,
    permissionMask: `0x${ALL_HOOK_PERMISSION_MASK.toString(16)}`,
    requiredPermissionBits: `0x${REQUIRED_HOOK_PERMISSION_MASK.toString(16)}`,
    initCodeHash,
    ...(options.providerSalt
      ? {
        providerSalt: options.providerSalt,
        applicantSalt: mined.applicantSalt,
        effectiveSalt: mined.effectiveSalt,
      }
      : { salt: mined.salt }),
    minedAddress: mined.address,
    maskCheckPassed: satisfiesMask(mined.address, ALL_HOOK_PERMISSION_MASK, REQUIRED_HOOK_PERMISSION_MASK),
    attempts: mined.attempts,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const report = mineHookAddress(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
