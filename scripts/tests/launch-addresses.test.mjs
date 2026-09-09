import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  ALL_HOOK_PERMISSION_MASK,
  EXAMPLE_CONFIG,
  PROGRAMMABLE_GRAPH_FACTORY,
  PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
  REQUIRED_HOOK_PERMISSION_MASK,
  computeCreate2Address,
  deriveProgrammableEffectiveSalt,
  encodeConstructorConfig,
  encodeNativeConstructorConfig,
  mineHookAddress,
  mineProgrammableSalt,
  mineSalt,
  readHookLaunchArtifactBytecode,
  satisfiesMask,
} from '../mine-hook-address.mjs';
import { keccak256 } from '../../packages/contracts/tooling/payout/canonical-merkle-sum.mjs';
import { sha256Bytes } from '../programmable/lib/canonical-json.mjs';
import {
  deriveAddresses,
  deriveGraphCommitment,
  validateArtifactDeploymentIdentity,
  verifyDerivedAddresses,
} from '../launch/derive-addresses.mjs';
import {
  buildAddressManifest,
  verifyAddressManifest,
} from '../launch/build-address-manifest.mjs';
import { materializePhaseThreePriceSelection, verifyPhaseThreeMaterializedSeedManifest } from '../programmable/lib/package.mjs';
import { deriveNativePriceCandidate } from '../programmable/lib/phase3-release.mjs';
import { isEip55Address, toEip55Address } from '../programmable/lib/eip55.mjs';
import { validateJsonSchema } from '../programmable/lib/json-schema.mjs';

const USDG = toEip55Address('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const ROUTER = toEip55Address(PROGRAMMABLE_LAUNCH_STAMP_ROUTER);
const root = resolve(import.meta.dirname, '../..');
const TOKEN_CREATION_BYTECODE = '0x600a600c600039600a6000f3602a60005260206000f3';
const HOOK_CREATION_BYTECODE = '0x600b600c600039600b6000f3602b60005260206000f3';
const CUSTODY_CREATION_BYTECODE = '0x600c600c600039600c6000f3602c60005260206000f3';
const PRICE_CANDIDATES = Object.freeze({
  usdgCurrency0: '161723809515207654588927258648643645224',
  hkmnCurrency0: '38813714284914462669',
});

function address(digit) {
  return `0x${digit.repeat(40)}`;
}

function bytes32(digit) {
  return `0x${digit.repeat(64)}`;
}

function salt(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function nativeValue(amountAtomic = '0') {
  return {
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    amountAtomic,
  };
}

function addressWord(value) {
  return value.toLowerCase().slice(2).padStart(64, '0');
}

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function keccakHex(value) {
  return `0x${Buffer.from(keccak256(Buffer.from(value.slice(2), 'hex'))).toString('hex')}`;
}

function selector(signature) {
  return Buffer.from(keccak256(new TextEncoder().encode(signature))).toString('hex').slice(0, 8);
}

function initializer(signature, words) {
  return `0x${selector(signature)}${words.join('')}`;
}

function fixtureHookConfig(input, token) {
  return {
    manager: input.roles.manager,
    positionManager: input.roles.positionManager,
    permit2: input.roles.permit2,
    ...(input.quoteCurrency ? { quoteCurrency: input.quoteCurrency } : { usdg: input.usdg }),
    hkmn: token,
    tickSpacing: input.pool.tickSpacing,
    programmable: input.roles.programmable,
    treasury: input.roles.treasury,
    operations: input.roles.operations,
    launchAuthority: input.roles.launchAuthority,
    issuanceAuthority: input.roles.issuanceAuthority,
    expectedDecimals: input.hookConstructorConfig.expectedDecimals,
    bindingDigest: input.hookConstructorConfig.bindingDigest,
    runtimeDigest: input.hookConstructorConfig.runtimeDigest,
    ...(input.quoteCurrency ? {
      processClaimLimit6hWei: input.hookConstructorConfig.processClaimLimit6hWei,
      processClaimLimitMaxWei: input.hookConstructorConfig.processClaimLimitMaxWei,
    } : {
      processClaimLimit6h: input.hookConstructorConfig.processClaimLimit6h,
      processClaimLimitMax: input.hookConstructorConfig.processClaimLimitMax,
    }),
    processClaimMaxCount: input.hookConstructorConfig.processClaimMaxCount,
    operationsRotationDelay: input.hookConstructorConfig.operationsRotationDelay,
  };
}

function fixturePriceCandidates(input) {
  if (input.pool.priceCandidates) return input.pool.priceCandidates;
  return { scalar: { sqrtPriceX96: input.pool.sqrtPriceX96 } };
}

function selectFixturePriceCandidate(input) {
  const tokenEffectiveSalt = deriveProgrammableEffectiveSalt({
    chainId: input.chain.chainId,
    factory: input.chain.factory,
    routeNamespace: input.chain.routeNamespace,
    routeNonce: input.chain.routeNonce,
    targetIdHash: input.targets.token.targetIdHash,
    applicantSalt: input.targets.token.applicantSalt.value,
    authorizedLauncher: input.chain.authorizedLauncher,
  });
  const candidates = Object.entries(fixturePriceCandidates(input)).map(([id, candidate]) => {
    const tokenConstructorArguments = [
      addressWord(input.chain.factory),
      addressWord(input.quoteCurrency ?? input.usdg),
      uintWord(input.hookConstructorConfig.expectedDecimals),
      uintWord(candidate.sqrtPriceX96),
    ].join('');
    const tokenInitCodeHash = keccakHex(`${TOKEN_CREATION_BYTECODE}${tokenConstructorArguments}`);
    const token = toEip55Address(computeCreate2Address(input.chain.factory, tokenEffectiveSalt, tokenInitCodeHash));
    return { id, sqrtPriceX96: candidate.sqrtPriceX96, token };
  });
  if (candidates.length === 1 && ['scalar', 'nativeCurrency0'].includes(candidates[0].id)) return candidates[0];
  const selected = candidates.filter(({ id, token }) => (
    id === 'usdgCurrency0' ? BigInt(token) > BigInt(input.usdg) : BigInt(token) < BigInt(input.usdg)
  ));
  assert.equal(selected.length, 1, 'test fixture must have exactly one price fixed point');
  return selected[0];
}

function withPriceCandidates(input) {
  const candidateInput = structuredClone(input);
  candidateInput.pool = {
    fee: candidateInput.pool.fee,
    tickSpacing: candidateInput.pool.tickSpacing,
    priceCandidates: Object.fromEntries(
      Object.entries(PRICE_CANDIDATES).map(([id, sqrtPriceX96]) => [id, { sqrtPriceX96 }]),
    ),
  };
  candidateInput.targets.token.constructorArguments[3] = { ref: 'pool.selectedPriceCandidate.sqrtPriceX96' };
  return candidateInput;
}

function setCanonicalInitializerCalldata(input) {
  const selectedPrice = selectFixturePriceCandidate(input);
  const token = selectedPrice.token;

  const hookInitCodeHash = keccakHex(
    `${HOOK_CREATION_BYTECODE}${(input.quoteCurrency ? encodeNativeConstructorConfig : encodeConstructorConfig)(fixtureHookConfig(input, token)).slice(2)}`,
  );
  const minedHook = mineProgrammableSalt({
    chainId: input.chain.chainId,
    factory: input.chain.factory,
    routeNamespace: input.chain.routeNamespace,
    routeNonce: input.chain.routeNonce,
    targetIdHash: input.targets.hook.targetIdHash,
    authorizedLauncher: input.chain.authorizedLauncher,
    initCodeHashHex: hookInitCodeHash,
    mask: ALL_HOOK_PERMISSION_MASK,
    required: REQUIRED_HOOK_PERMISSION_MASK,
    startSalt: BigInt(input.targets.hook.applicantSalt.start),
    maxAttempts: Number(input.targets.hook.applicantSalt.maxAttempts),
  });
  const hook = minedHook.address.toLowerCase();

  const custodyInitCodeHash = keccakHex(
    `${CUSTODY_CREATION_BYTECODE}${addressWord(input.roles.positionManager)}${uintWord(0)}`,
  );
  const custodyEffectiveSalt = deriveProgrammableEffectiveSalt({
    chainId: input.chain.chainId,
    factory: input.chain.factory,
    routeNamespace: input.chain.routeNamespace,
    routeNonce: input.chain.routeNonce,
    targetIdHash: input.targets.custody.targetIdHash,
    applicantSalt: input.targets.custody.applicantSalt.value,
    authorizedLauncher: input.chain.authorizedLauncher,
  });
  const custody = computeCreate2Address(
    input.chain.factory,
    custodyEffectiveSalt,
    custodyInitCodeHash,
  ).toLowerCase();

  input.targets.token.initializerCalldata = initializer('allocate(address)', [addressWord(hook)]);
  input.targets.custody.initializerCalldata = initializer('configureBindingHook(address)', [
    addressWord(hook),
  ]);
  input.targets.hook.initializerCalldata = initializer('initializeGraphLaunch(address,uint160)', [
    addressWord(custody),
    uintWord(selectedPrice.sqrtPriceX96),
  ]);
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function launchMetadata(compilationTarget, native = false) {
  return JSON.stringify({
    compiler: { version: '0.8.26+commit.8a97fa7a' },
    settings: {
      optimizer: { enabled: true, runs: native ? 200 : 1000 },
      viaIR: native,
      evmVersion: 'cancun',
      metadata: {
        appendCBOR: false,
        bytecodeHash: 'none',
        useLiteralContent: false,
      },
      compilationTarget,
    },
  });
}

function setFoundryCompilationTarget(path, sourcePath, contractName) {
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const metadata = JSON.parse(artifact.metadata);
  delete artifact.contractName;
  metadata.settings.compilationTarget = { [sourcePath]: contractName };
  artifact.metadata = JSON.stringify(metadata);
  writeJson(path, artifact);
}

function hookConstructorComponents() {
  return [
    { name: 'manager', type: 'address' },
    { name: 'positionManager', type: 'address' },
    { name: 'permit2', type: 'address' },
    { name: 'usdg', type: 'address' },
    { name: 'hkmn', type: 'address' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'programmable', type: 'address' },
    { name: 'treasury', type: 'address' },
    { name: 'operations', type: 'address' },
    { name: 'launchAuthority', type: 'address' },
    { name: 'issuanceAuthority', type: 'address' },
    { name: 'expectedDecimals', type: 'uint8' },
    { name: 'bindingDigest', type: 'bytes32' },
    { name: 'runtimeDigest', type: 'bytes32' },
    { name: 'processClaimLimit6h', type: 'uint256' },
    { name: 'processClaimLimitMax', type: 'uint256' },
    { name: 'processClaimMaxCount', type: 'uint256' },
    { name: 'operationsRotationDelay', type: 'uint256' },
  ];
}

function makeFixture({ native = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-launch-addresses-'));
  const tokenArtifactPath = resolve(directory, 'token.json');
  const hookArtifactPath = resolve(directory, 'hook.json');
  const custodyArtifactPath = resolve(directory, 'custody.json');

  writeJson(tokenArtifactPath, {
    contractName: 'HKMNToken',
    abi: [{
      type: 'constructor',
      inputs: [
        { name: 'issuanceAuthority', type: 'address' },
        { name: 'expectedUsdg', type: 'address' },
        { name: 'decimals', type: 'uint8' },
        { name: 'launchSqrtPriceX96', type: 'uint160' },
      ],
    }],
    bytecode: { object: TOKEN_CREATION_BYTECODE },
    deployedBytecode: { object: '0x60006000f3' },
    metadata: launchMetadata({ 'src/launch/HKMNToken.sol': 'HKMNToken' }, native),
  });
  writeJson(hookArtifactPath, {
    contractName: 'HookemonHook',
    abi: [{
      type: 'constructor',
      inputs: [{ name: 'config', type: 'tuple', components: hookConstructorComponents() }],
    }],
    bytecode: { object: HOOK_CREATION_BYTECODE },
    deployedBytecode: { object: '0x6001600055' },
    metadata: launchMetadata({ 'src/HookemonHook.sol': 'HookemonHook' }, native),
  });
  writeJson(custodyArtifactPath, {
    contractName: 'PermanentPositionCustody',
    abi: [{
      type: 'constructor',
      inputs: [
        { name: 'manager', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
      ],
    }],
    bytecode: { object: CUSTODY_CREATION_BYTECODE },
    deployedBytecode: { object: '0x6002600055' },
    metadata: launchMetadata({ 'src/bindings/RobinhoodBindings.sol': 'PermanentPositionCustody' }, native),
  });

  const fixture = {
    directory,
    input: {
      schemaVersion: 'hookemon.phase3.launch-inputs.v1',
      chain: {
        chainId: '4663',
        factory: PROGRAMMABLE_GRAPH_FACTORY,
        authorizedLauncher: ROUTER,
        routeNamespace: bytes32('a'),
        routeNonce: bytes32('b'),
      },
      graphAuthorization: {
        topologyHash: bytes32('e'),
        totalValue: nativeValue(),
      },
      compilerProfile: {
        solc: '0.8.26+commit.8a97fa7a',
        optimizer: { enabled: true, runs: 1000 },
        viaIR: false,
        evmVersion: 'cancun',
        metadata: {
          appendCBOR: false,
          bytecodeHash: 'none',
          useLiteralContent: false,
        },
      },
      usdg: USDG,
      roles: {
        manager: address('1'),
        positionManager: address('2'),
        permit2: address('3'),
        programmable: address('4'),
        treasury: address('5'),
        operations: address('6'),
        launchAuthority: address('7'),
        issuanceAuthority: PROGRAMMABLE_GRAPH_FACTORY,
      },
      pool: {
        fee: 0,
        tickSpacing: 60,
        priceCandidates: Object.fromEntries(
          Object.entries(PRICE_CANDIDATES).map(([id, sqrtPriceX96]) => [id, { sqrtPriceX96 }]),
        ),
      },
      hookConstructorConfig: {
        manager: { ref: 'roles.manager' },
        positionManager: { ref: 'roles.positionManager' },
        permit2: { ref: 'roles.permit2' },
        usdg: { ref: 'usdg' },
        hkmn: { ref: 'addresses.token' },
        tickSpacing: { ref: 'pool.tickSpacing' },
        programmable: { ref: 'roles.programmable' },
        treasury: { ref: 'roles.treasury' },
        operations: { ref: 'roles.operations' },
        launchAuthority: { ref: 'roles.launchAuthority' },
        issuanceAuthority: { ref: 'roles.issuanceAuthority' },
        expectedDecimals: 18,
        bindingDigest: bytes32('c'),
        runtimeDigest: bytes32('d'),
        processClaimLimit6h: '1000000',
        processClaimLimitMax: '2000000',
        processClaimMaxCount: '8',
        operationsRotationDelay: '259200',
      },
      targets: {
        token: {
          targetIndex: 0,
          targetId: 'token',
          targetIdHash: bytes32('1'),
          applicantSalt: { mode: 'fixed', value: salt(4) },
          artifactPath: 'token.json',
          contractName: 'HKMNToken',
          constructorArguments: [
            { ref: 'chain.factory' },
            { ref: 'usdg' },
            18,
            { ref: 'pool.selectedPriceCandidate.sqrtPriceX96' },
          ],
          initializerCalldata: '0x00',
          deploymentValue: nativeValue(),
          initializerValue: nativeValue(),
          runtimeImmutablePatches: [],
        },
        hook: {
          targetIndex: 2,
          targetId: 'hook',
          targetIdHash: bytes32('2'),
          applicantSalt: { mode: 'mine', start: '0', maxAttempts: '200000' },
          artifactPath: 'hook.json',
          contractName: 'HookemonHook',
          initializerCalldata: '0x00',
          deploymentValue: nativeValue(),
          initializerValue: nativeValue(),
          runtimeImmutablePatches: [],
        },
        custody: {
          targetIndex: 1,
          targetId: 'custody',
          targetIdHash: bytes32('3'),
          applicantSalt: { mode: 'fixed', value: salt(3) },
          artifactPath: 'custody.json',
          contractName: 'PermanentPositionCustody',
          constructorArguments: [{ ref: 'roles.positionManager' }, 0],
          initializerCalldata: '0x00',
          deploymentValue: nativeValue(),
          initializerValue: nativeValue(),
          runtimeImmutablePatches: [],
        },
      },
    },
  };
  if (native) {
    const input = fixture.input;
    input.schemaVersion = 'hookemon.phase3.launch-inputs.v2';
    input.compilerProfile.optimizer.runs = 200;
    input.compilerProfile.viaIR = true;
    input.quoteCurrency = '0x0000000000000000000000000000000000000000';
    input.seedIntent = { payer: input.roles.launchAuthority, tickLower: -887220, tickUpper: 887220, maxDeadlineSeconds: 900 };
    delete input.usdg;
    input.pool.seedMaximumWei = '40000000000000000';
    input.pool.hkmnAtomic = '1000000000000000000000000000';
    const candidate = deriveNativePriceCandidate({ nativeWei: input.pool.seedMaximumWei, hkmnAtomic: input.pool.hkmnAtomic });
    input.pool.priceCandidates = { nativeCurrency0: { sqrtPriceX96: candidate.sqrtPriceX96 } };
    input.hookConstructorConfig.quoteCurrency = { ref: 'quoteCurrency' };
    delete input.hookConstructorConfig.usdg;
    input.hookConstructorConfig.processClaimLimit6hWei = '10000000000000000';
    input.hookConstructorConfig.processClaimLimitMaxWei = '20000000000000000';
    delete input.hookConstructorConfig.processClaimLimit6h;
    delete input.hookConstructorConfig.processClaimLimitMax;
    input.targets.token.constructorArguments[1] = { ref: 'quoteCurrency' };
    const tokenArtifact = JSON.parse(readFileSync(tokenArtifactPath));
    tokenArtifact.abi[0].inputs.forEach((entry, i) => { entry.name = ['issuanceAuthority_', 'expectedQuoteCurrency_', 'decimals_', 'launchSqrtPriceX96_'][i]; });
    writeJson(tokenArtifactPath, tokenArtifact);
    const hookArtifact = JSON.parse(readFileSync(hookArtifactPath));
    for (const entry of hookArtifact.abi[0].inputs[0].components) {
      entry.name = ({ usdg: 'quoteCurrency', processClaimLimit6h: 'processClaimLimit6hWei', processClaimLimitMax: 'processClaimLimitMaxWei' })[entry.name] ?? entry.name;
    }
    writeJson(hookArtifactPath, hookArtifact);
  }
  setCanonicalInitializerCalldata(fixture.input);
  return fixture;
}

const RELEASE_ARTIFACTS_DIRECTORY = resolve(root, 'release/phase3/artifacts');

function readReleaseArtifacts() {
  return Object.fromEntries(['token', 'hook', 'custody'].map((name) => {
    const path = resolve(RELEASE_ARTIFACTS_DIRECTORY, `${name}.json`);
    const bytes = readFileSync(path);
    return [name, { path, bytes, artifact: JSON.parse(bytes.toString('utf8')) }];
  }));
}

function syntheticImmutablePatches(artifact, byte) {
  return Object.entries(artifact.deployedBytecode.immutableReferences).flatMap(([astId, references]) => (
    references.map(({ start, length }) => ({ astId, start, length, value: `0x${byte.repeat(length)}` }))
  ));
}

// Synthetic local roles, salts, digests and seed plan bound to the checked-in compiler exports.
// Build-only derivation input; it is not a deployment record or a provider claim.
function releaseArtifactLaunchInputs(artifacts) {
  const roles = {
    manager: address('1'),
    positionManager: address('2'),
    permit2: address('3'),
    programmable: address('4'),
    treasury: address('5'),
    operations: address('6'),
    launchAuthority: address('7'),
    issuanceAuthority: PROGRAMMABLE_GRAPH_FACTORY,
  };
  const pool = { fee: 0, tickSpacing: 60, seedMaximumWei: '40000000000000000', hkmnAtomic: '1000000000000000000000000000' };
  const candidate = deriveNativePriceCandidate({ nativeWei: pool.seedMaximumWei, hkmnAtomic: pool.hkmnAtomic });
  const target = (name, targetIndex, targetIdHash, applicantSalt, byte) => ({
    targetIndex,
    targetId: name,
    targetIdHash,
    applicantSalt,
    artifactPath: `${name}.json`,
    contractName: { token: 'HKMNToken', hook: 'HookemonHook', custody: 'PermanentPositionCustody' }[name],
    initializerCalldata: '0x00',
    deploymentValue: nativeValue(),
    initializerValue: nativeValue(),
    runtimeImmutablePatches: syntheticImmutablePatches(artifacts[name].artifact, byte),
  });
  return {
    schemaVersion: 'hookemon.phase3.launch-inputs.v2',
    chain: {
      chainId: '4663',
      factory: PROGRAMMABLE_GRAPH_FACTORY,
      authorizedLauncher: ROUTER,
      routeNamespace: bytes32('a'),
      routeNonce: bytes32('b'),
    },
    graphAuthorization: { topologyHash: bytes32('e'), totalValue: nativeValue() },
    compilerProfile: {
      solc: '0.8.26+commit.8a97fa7a',
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
      metadata: { appendCBOR: false, bytecodeHash: 'none', useLiteralContent: false },
    },
    quoteCurrency: '0x0000000000000000000000000000000000000000',
    roles,
    pool: { ...pool, priceCandidates: { nativeCurrency0: { sqrtPriceX96: candidate.sqrtPriceX96 } } },
    seedIntent: { payer: roles.launchAuthority, tickLower: -887220, tickUpper: 887220, maxDeadlineSeconds: 900 },
    hookConstructorConfig: {
      manager: { ref: 'roles.manager' },
      positionManager: { ref: 'roles.positionManager' },
      permit2: { ref: 'roles.permit2' },
      quoteCurrency: { ref: 'quoteCurrency' },
      hkmn: { ref: 'addresses.token' },
      tickSpacing: { ref: 'pool.tickSpacing' },
      programmable: { ref: 'roles.programmable' },
      treasury: { ref: 'roles.treasury' },
      operations: { ref: 'roles.operations' },
      launchAuthority: { ref: 'roles.launchAuthority' },
      issuanceAuthority: { ref: 'roles.issuanceAuthority' },
      expectedDecimals: 18,
      bindingDigest: bytes32('c'),
      runtimeDigest: bytes32('d'),
      processClaimLimit6hWei: '10000000000000000',
      processClaimLimitMaxWei: '20000000000000000',
      processClaimMaxCount: '8',
      operationsRotationDelay: '259200',
    },
    targets: {
      token: {
        ...target('token', 0, bytes32('1'), { mode: 'fixed', value: salt(4) }, '11'),
        constructorArguments: [
          { ref: 'chain.factory' },
          { ref: 'quoteCurrency' },
          18,
          { ref: 'pool.selectedPriceCandidate.sqrtPriceX96' },
        ],
      },
      hook: target('hook', 2, bytes32('2'), { mode: 'mine', start: '0', maxAttempts: '200000' }, '22'),
      custody: {
        ...target('custody', 1, bytes32('3'), { mode: 'fixed', value: salt(3) }, '33'),
        constructorArguments: [{ ref: 'roles.positionManager' }, 0],
      },
    },
  };
}

test('derives the provider effective salt from the pinned factory ABI preimage', () => {
  const effectiveSalt = deriveProgrammableEffectiveSalt({
    chainId: '4663',
    factory: PROGRAMMABLE_GRAPH_FACTORY,
    routeNamespace: '0x5629a34ee50548752b7d2963dfe015c9ca78d47ae72d8178ac116f622d82beb2',
    routeNonce: salt(1),
    targetIdHash: '0x67e3949ef8db66aae8e09e9bf74c58b8aac1ab66624af799b92148365c9e7ca9',
    applicantSalt: salt(0xc0ffee),
    authorizedLauncher: PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
  });

  assert.equal(effectiveSalt, '0x7c0ddc271644b2a0518d149a1c52585f38bf017763600dd64d88bd767b6b0b4e');
  assert.equal(
    computeCreate2Address(
      PROGRAMMABLE_GRAPH_FACTORY,
      effectiveSalt,
      '0xfb9fb2e46931e8f1035a5e589b31d7d69ea44e15806b1c71dfee37cebbbf6b16',
    ).toLowerCase(),
    '0x949c4800eba0516aedb644aa63a40e9c7fe32e79',
  );
});

test('matches the pinned factory graph commitment and deployment accumulator vector', () => {
  const graph = deriveGraphCommitment({
    chain: {
      chainId: '4663',
      factory: PROGRAMMABLE_GRAPH_FACTORY,
      authorizedLauncher: ROUTER,
      routeNamespace: bytes32('1'),
      routeNonce: salt(0x42),
    },
    graphAuthorization: {
      topologyHash: bytes32('2'),
      totalValue: '21',
    },
    targets: [
      {
        targetIndex: 0,
        targetId: 'token',
        targetIdHash: salt(1),
        applicantSalt: salt(0x1001),
        deploymentValue: '1',
        initializerValue: '4',
        initCode: '0x6002600c60003960026000f36000',
        initCodeHash: '0x80bef3d7bb3779e9f8d1d4c2d106a7696d12de93a130a673a3178c65958c13f5',
        initializerCalldata: '0x00',
        initializerCalldataHash: '0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a',
        effectiveSalt: '0x2abbf62e30452499647fbbd5def5ec4a45b840a9c2c7d75e35b87b1fb57a4878',
        address: toEip55Address('0x517ed232b8e879b70756097bcc6c66252afd24f2'),
        runtimeCodeHash: '0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d',
      },
      {
        targetIndex: 1,
        targetId: 'hook',
        targetIdHash: salt(2),
        applicantSalt: salt(0x1002),
        deploymentValue: '2',
        initializerValue: '5',
        initCode: '0x6002600c60003960026000f36001',
        initCodeHash: '0x75dd51a378590ec788050ee260e10f29fdb19bed27c8ed5b2188c158e8e1f64b',
        initializerCalldata: '0x00',
        initializerCalldataHash: '0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a',
        effectiveSalt: '0x7b28f358e64edbad0e71cef3e313f13ed7db608869c4adca2ceb45943c500376',
        address: toEip55Address('0xa009ae9dadb65352580dbc039d9f68b2d11471d2'),
        runtimeCodeHash: '0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb',
      },
      {
        targetIndex: 2,
        targetId: 'custody',
        targetIdHash: salt(3),
        applicantSalt: salt(0x1003),
        deploymentValue: '3',
        initializerValue: '6',
        initCode: '0x6002600c60003960026000f36002',
        initCodeHash: '0x6f9115fef9861e6a7e62cc6ab844ec002b1e06adbbdc81d8543ce9112cbe91e9',
        initializerCalldata: '0x00',
        initializerCalldataHash: '0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a',
        effectiveSalt: '0x3ca2a14cfe525946c95ce4e9eca738c600d930881d4970424b27509dfa58d6fd',
        address: toEip55Address('0xa927938f5f499254e9e7aa6e03aeee994ffb91fe'),
        runtimeCodeHash: '0xcde7aac41575d8b30bd84f598371d46d266fadb09c9dcfcdd047fd087ef8763e',
      },
    ],
  });

  assert.deepEqual(graph.targetCommitments.map((target) => target.commitment), [
    '0x1ef85ff05cdbb93635b10e494feac20fcb72ad5c492da08d6d93e53f2910907f',
    '0x383f71168007eebc8968ff68935f9f2b8289557246da18d1366fbabb1e0bbd61',
    '0x7d7e03b7a235452ef6737a67290ec9bd60ebe3a84c14dd3a716e7ae6926a42ec',
  ]);
  assert.equal(graph.typeHashes.targetCommitment, '0x21142ca1468949571eb96688c42886a7ec36f4c99d14bf556489935289890340');
  assert.equal(graph.typeHashes.graphCommitment, '0x16d2fbfa7bf3b16fcae1b6ebfef12955e0c4fbdab482dcc140708780c6f3d81f');
  assert.equal(graph.typeHashes.expectedOutput, '0xbb3b89c4feaa987f443390264fe393e227b8d205d1eb77ceb2b0a5e5dfdeeb7f');
  assert.equal(graph.typeHashes.expectedResult, '0xb87089bcff971cb32d09e3f27f2472a9aa38fec88c320e25f683bbb10715efc9');
  assert.equal(graph.targetCommitmentsHash, '0x7ab467a086be7983bbe0331d2fae3c43bc2208b67b98430b3d07ad7d85c70d87');
  assert.equal(graph.authorization.graphCommitment, '0x9dbd02dfa7925f1369480f002da0587d0e7c6c58c30c9bcf41c064500a9b75f5');
  assert.equal(graph.authorization.authorizationKey, '0x14076ebea07b46811d6e5c050cca813ef6e1afd1e05544957052f7d03532084d');
  assert.deepEqual(graph.deploymentAccumulator.steps.map((step) => step.next), [
    '0x32bf60e23419aac1ca347eee54d75c98c012a8b7b11a16a5ca39a7a6b383974c',
    '0xec55053ef9a31c8145d92ade33b412b3bdaafab3a918d20d58a500502b7f2f7b',
    '0x07adf7a141a1df06a5f56d4f871c6b82630e2bc2ca483c51c2bc733a4b4c9e88',
  ]);
  assert.equal(graph.expectedOutputsHash, '0x012c1a4aca187acf60186e3fb03093f6c486ff8650ae60d9987097772dff0e6d');
  assert.equal(graph.expectedResultHash, '0x74d276421e1c263202b78ee94f254080ae29fcd87522fdc58677c0aac4e513d3');
});

test('derives a deterministic three-target graph and mines a provider-effective hook salt', () => {
  const fixture = makeFixture();
  try {
    const first = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    const second = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });

    assert.deepEqual(second, first);
    assert.equal(first.targets.token.targetId, 'token');
    assert.equal(first.targets.hook.targetId, 'hook');
    assert.equal(first.targets.custody.targetId, 'custody');
    assert.equal(first.targets.hook.applicantSaltMode, 'mined');
    assert.equal(
      satisfiesMask(first.targets.hook.address, ALL_HOOK_PERMISSION_MASK, REQUIRED_HOOK_PERMISSION_MASK),
      true,
    );
    assert.equal(first.pool.poolId.length, 66);
    assert.equal(verifyDerivedAddresses({ launchInputs: fixture.input, derived: first, inputDirectory: fixture.directory }), true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('derives target identity from a sole Foundry compilation target', () => {
  const fixture = makeFixture();
  try {
    setFoundryCompilationTarget(resolve(fixture.directory, 'token.json'), 'src/launch/HKMNToken.sol', 'HKMNToken');
    setFoundryCompilationTarget(resolve(fixture.directory, 'custody.json'), 'src/bindings/RobinhoodBindings.sol', 'PermanentPositionCustody');
    setFoundryCompilationTarget(resolve(fixture.directory, 'hook.json'), 'src/HookemonHook.sol', 'HookemonHook');

    const derived = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    assert.deepEqual(
      Object.keys(derived.targets),
      ['token', 'hook', 'custody'],
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('binds committed Foundry artifact identities to deployment-manifest targets', () => {
  const expected = {
    token: { sourcePath: 'src/launch/HKMNToken.sol', contractName: 'HKMNToken' },
    custody: { sourcePath: 'src/bindings/RobinhoodBindings.sol', contractName: 'PermanentPositionCustody' },
    hook: { sourcePath: 'src/HookemonHook.sol', contractName: 'HookemonHook' },
  };
  for (const [targetName, identity] of Object.entries(expected)) {
    const artifact = JSON.parse(readFileSync(resolve(root, `release/phase3/artifacts/${targetName}.json`), 'utf8'));
    assert.deepEqual(validateArtifactDeploymentIdentity({ targetName, artifact }), {
      ...identity,
    });
  }
});

test('selects exactly one address-order price candidate for the token preimage', () => {
  const fixture = makeFixture();
  try {
    const input = withPriceCandidates(fixture.input);
    setCanonicalInitializerCalldata(input);

    const derived = deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory });
    assert.deepEqual(derived.pool.priceCandidate, {
      id: 'usdgCurrency0',
      sqrtPriceX96: PRICE_CANDIDATES.usdgCurrency0,
    });
    assert.equal(derived.pool.selectedOrdering, 'usdgCurrency0');
    assert.equal(derived.pool.sqrtPriceX96, PRICE_CANDIDATES.usdgCurrency0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('requires checksummed inputs and preserves EIP-55 addresses in derivation output', () => {
  const fixture = makeFixture();
  try {
    const derived = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    for (const value of [
      derived.targets.token.address,
      derived.targets.hook.address,
      derived.targets.custody.address,
      derived.pool.currency0,
      derived.pool.currency1,
      derived.pool.hooks,
    ]) {
      assert.equal(isEip55Address(value), true, `${value} must preserve EIP-55 casing`);
    }

    const lowerCaseUsdg = structuredClone(fixture.input);
    lowerCaseUsdg.usdg = lowerCaseUsdg.usdg.toLowerCase();
    assert.throws(
      () => deriveAddresses({ launchInputs: lowerCaseUsdg, inputDirectory: fixture.directory }),
      /EIP-55|checksum/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects an arbitrary address-order price candidate', () => {
  const fixture = makeFixture();
  try {
    const input = withPriceCandidates(fixture.input);
    input.pool.priceCandidates.usdgCurrency0.sqrtPriceX96 = '1';
    setCanonicalInitializerCalldata(input);
    assert.throws(
      () => deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory }),
      /not the approved usdgCurrency0 price/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects a reciprocal price assigned to the wrong address order', () => {
  const fixture = makeFixture();
  try {
    const input = withPriceCandidates(fixture.input);
    const usdgPrice = input.pool.priceCandidates.usdgCurrency0.sqrtPriceX96;
    input.pool.priceCandidates.usdgCurrency0.sqrtPriceX96 = input.pool.priceCandidates.hkmnCurrency0.sqrtPriceX96;
    input.pool.priceCandidates.hkmnCurrency0.sqrtPriceX96 = usdgPrice;
    setCanonicalInitializerCalldata(input);
    assert.throws(
      () => deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory }),
      /not the approved usdgCurrency0 price/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects price candidates with no address-order fixed point', () => {
  const fixture = makeFixture();
  try {
    const input = withPriceCandidates(fixture.input);
    input.targets.token.applicantSalt = { mode: 'fixed', value: salt(1) };
    assert.throws(
      () => deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory }),
      /exactly one address-order fixed point/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects price candidates with multiple address-order fixed points', () => {
  const fixture = makeFixture();
  try {
    const input = withPriceCandidates(fixture.input);
    input.targets.token.applicantSalt = { mode: 'fixed', value: salt(2) };
    assert.throws(
      () => deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory }),
      /exactly one address-order fixed point/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects a graph token authority that is not the graph factory', () => {
  const fixture = makeFixture();
  try {
    const input = structuredClone(fixture.input);
    input.roles.issuanceAuthority = address('8');
    assert.throws(
      () => deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory }),
      /roles\.issuanceAuthority must match chain\.factory/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('orders HKMN and USDG numerically in either address order', () => {
  const fixture = makeFixture();
  try {
    const findInput = (selectedId) => {
      for (let candidate = 1n; candidate < 1000n; candidate += 1n) {
        const input = structuredClone(fixture.input);
        input.targets.token.applicantSalt = { mode: 'fixed', value: salt(candidate) };
        try {
          if (selectFixturePriceCandidate(input).id === selectedId) {
            setCanonicalInitializerCalldata(input);
            return input;
          }
        } catch {
          continue;
        }
      }
      throw new Error('test fixture did not produce the required currency ordering');
    };

    const tokenFirst = deriveAddresses({
      launchInputs: findInput('hkmnCurrency0'),
      inputDirectory: fixture.directory,
    });
    const usdgFirst = deriveAddresses({
      launchInputs: findInput('usdgCurrency0'),
      inputDirectory: fixture.directory,
    });

    assert.equal(tokenFirst.pool.priceCandidate.id, 'hkmnCurrency0');
    assert.equal(usdgFirst.pool.priceCandidate.id, 'usdgCurrency0');
    assert.equal(tokenFirst.pool.currency0, tokenFirst.targets.token.address);
    assert.equal(tokenFirst.pool.currency1, USDG);
    assert.equal(usdgFirst.pool.currency0, USDG);
    assert.equal(usdgFirst.pool.currency1, usdgFirst.targets.token.address);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('builds a chained manifest and rejects a changed downstream preimage', () => {
  const fixture = makeFixture();
  try {
    const manifest = buildAddressManifest({
      launchInputs: fixture.input,
      inputDirectory: fixture.directory,
    });
    assert.equal(verifyAddressManifest({ manifest, inputDirectory: fixture.directory }), true);
    const schema = JSON.parse(readFileSync(resolve(root, 'release/phase3/address-manifest.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonSchema(schema, manifest), []);
    assert.equal(manifest.preimages.factory, PROGRAMMABLE_GRAPH_FACTORY);
    assert.deepEqual(manifest.preimages.pool.priceCandidate, {
      id: 'usdgCurrency0',
      sqrtPriceX96: PRICE_CANDIDATES.usdgCurrency0,
    });
    assert.equal(manifest.preimages.pool.selectedOrdering, 'usdgCurrency0');
    assert.equal(manifest.preimages.compilerProfileDigest.length, 71);

    const changed = structuredClone(manifest);
    changed.launchInputs.targets.custody.initializerCalldata = '0xdeadbeef';
    assert.throws(
      () => verifyAddressManifest({ manifest: changed, inputDirectory: fixture.directory }),
      /initializerCalldata does not match|manifest mismatch|digest mismatch/i,
    );

    const changedInputFile = structuredClone(fixture.input);
    changedInputFile.targets.token.constructorArguments[1] = '420690000000000000000000000001';
    assert.throws(
      () => verifyAddressManifest({
        manifest,
        launchInputs: changedInputFile,
        inputDirectory: fixture.directory,
      }),
      /launch inputs mismatch/i,
    );

    const manifestPath = resolve(fixture.directory, 'address-manifest.json');
    const changedInputPath = resolve(fixture.directory, 'changed-launch-inputs.json');
    writeJson(manifestPath, manifest);
    writeJson(changedInputPath, changedInputFile);
    assert.throws(
      () => execFileSync(process.execPath, [
        resolve(root, 'scripts/launch/build-address-manifest.mjs'),
        '--input', changedInputPath,
        '--verify', manifestPath,
      ], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => {
        assert.match(error.stderr, /launch inputs mismatch/i);
        return true;
      },
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects a non-checksummed nested address before recomputing the manifest', () => {
  const fixture = makeFixture();
  try {
    const manifest = buildAddressManifest({
      launchInputs: fixture.input,
      inputDirectory: fixture.directory,
    });
    const changed = structuredClone(manifest);
    changed.preimages.targets.token.address = changed.preimages.targets.token.address.toLowerCase();

    assert.throws(
      () => verifyAddressManifest({ manifest: changed, inputDirectory: fixture.directory }),
      /EIP-55 checksum/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects artifacts that do not prove the frozen launch compiler profile', () => {
  const fixture = makeFixture();
  try {
    const tokenArtifactPath = resolve(fixture.directory, 'token.json');
    const tokenArtifact = JSON.parse(readFileSync(tokenArtifactPath, 'utf8'));
    const metadata = JSON.parse(tokenArtifact.metadata);
    metadata.settings.optimizer.runs = 999;
    tokenArtifact.metadata = JSON.stringify(metadata);
    writeJson(tokenArtifactPath, tokenArtifact);

    assert.throws(
      () => deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory }),
      /optimizer|launch profile/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects noncanonical and zero provider graph authorization fields before mining', () => {
  const fixture = makeFixture();
  try {
    const noncanonicalFactory = structuredClone(fixture.input);
    noncanonicalFactory.chain.factory = `0x${PROGRAMMABLE_GRAPH_FACTORY.slice(2).toUpperCase()}`;
    assert.throws(
      () => deriveAddresses({ launchInputs: noncanonicalFactory, inputDirectory: fixture.directory }),
      /EIP-55|checksum/i,
    );
    fixture.input.chain.routeNamespace = bytes32('0');
    assert.throws(
      () => deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory }),
      /routeNamespace must not be zero/i,
    );
    assert.throws(
      () => deriveProgrammableEffectiveSalt({
        chainId: fixture.input.chain.chainId,
        factory: fixture.input.chain.factory,
        routeNamespace: bytes32('0'),
        routeNonce: fixture.input.chain.routeNonce,
        targetIdHash: fixture.input.targets.token.targetIdHash,
        applicantSalt: salt(1),
        authorizedLauncher: fixture.input.chain.authorizedLauncher,
      }),
      /routeNamespace must not be zero/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('materializes immutable runtime references before deriving expected output hashes', () => {
  const fixture = makeFixture();
  try {
    const hookArtifactPath = resolve(fixture.directory, 'hook.json');
    const hookArtifact = JSON.parse(readFileSync(hookArtifactPath, 'utf8'));
    hookArtifact.deployedBytecode = {
      object: '0xaaaaaaaaaaaaaaaaaaaaaaaa',
      immutableReferences: {
        '17': [{ start: 2, length: 2 }, { start: 8, length: 2 }],
        '29': [{ start: 5, length: 1 }],
      },
    };
    writeJson(hookArtifactPath, hookArtifact);
    fixture.input.targets.hook.runtimeImmutablePatches = [{
      astId: '17',
      start: 2,
      length: 2,
      value: '0x1122',
    }, {
      astId: '17',
      start: 8,
      length: 2,
      value: '0x3344',
    }, {
      astId: '29',
      start: 5,
      length: 1,
      value: '0xff',
    }];

    const derived = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    assert.equal(derived.targets.hook.runtimeCode, '0xaaaa1122aaffaaaa3344aaaa');
    assert.notEqual(derived.targets.hook.runtimeCodeHash, derived.targets.hook.runtimeTemplateCodeHash);
    assert.deepEqual(derived.targets.hook.runtimeImmutablePatches, fixture.input.targets.hook.runtimeImmutablePatches);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('derives the factory graph authorization, ordered commitments, and router output hash', () => {
  const fixture = makeFixture();
  try {
    const derived = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    assert.deepEqual(derived.graph.orderedTargetIds, ['token', 'custody', 'hook']);
    assert.equal(derived.graph.authorization.topologyHash, bytes32('e'));
    assert.equal(derived.graph.authorization.totalValue, '0');
    assert.equal(derived.graph.targetCommitments.length, 3);
    assert.equal(derived.graph.expectedOutputs.length, 3);
    assert.equal(derived.graph.expectedOutputs[2].account, derived.targets.hook.address);
    assert.equal(derived.graph.expectedGraphDeploymentHash, derived.graph.deploymentAccumulator.final);
    assert.equal(derived.graph.authorization.graphCommitment.length, 66);
    assert.equal(derived.graph.expectedResultHash.length, 66);

    const changed = structuredClone(fixture.input);
    changed.targets.custody.deploymentValue = nativeValue('1');
    assert.throws(
      () => deriveAddresses({ launchInputs: changed, inputDirectory: fixture.directory }),
      /totalValue does not equal target deployment and initializer values/i,
    );
    const wrongHookInitializer = structuredClone(fixture.input);
    wrongHookInitializer.targets.hook.initializerCalldata = '0x00000000';
    assert.throws(
      () => deriveAddresses({ launchInputs: wrongHookInitializer, inputDirectory: fixture.directory }),
      /targets\.hook\.initializerCalldata does not match its required raw initializer/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('requires the provider target order and one exact initializer per target', () => {
  const fixture = makeFixture();
  try {
    const derived = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    assert.deepEqual(
      [
        derived.targets.token.targetIndex,
        derived.targets.custody.targetIndex,
        derived.targets.hook.targetIndex,
      ],
      [0, 1, 2],
    );
    assert.equal(derived.targets.token.initializerCalldata.slice(0, 10), `0x${selector('allocate(address)')}`);
    assert.equal(derived.targets.custody.initializerCalldata.slice(0, 10), `0x${selector('configureBindingHook(address)')}`);
    assert.equal(derived.targets.hook.initializerCalldata.slice(0, 10), `0x${selector('initializeGraphLaunch(address,uint160)')}`);

    const wrongOrder = structuredClone(fixture.input);
    wrongOrder.targets.custody.targetIndex = 2;
    wrongOrder.targets.hook.targetIndex = 1;
    assert.throws(
      () => deriveAddresses({ launchInputs: wrongOrder, inputDirectory: fixture.directory }),
      /targets\.custody\.targetIndex must be 1/i,
    );

    const wrongTokenInitializer = structuredClone(fixture.input);
    wrongTokenInitializer.targets.token.initializerCalldata = '0x00000000';
    assert.throws(
      () => deriveAddresses({ launchInputs: wrongTokenInitializer, inputDirectory: fixture.directory }),
      /targets\.token\.initializerCalldata does not match its required raw initializer/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects artifact identity mismatches and uint160-incompatible pool prices', () => {
  const fixture = makeFixture();
  try {
    const tokenArtifactPath = resolve(fixture.directory, 'token.json');
    const tokenArtifact = JSON.parse(readFileSync(tokenArtifactPath, 'utf8'));
    tokenArtifact.contractName = 'DifferentToken';
    writeJson(tokenArtifactPath, tokenArtifact);
    assert.throws(
      () => deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory }),
      /contractName conflicts with metadata/i,
    );

    const priceInput = structuredClone(fixture.input);
    priceInput.pool.priceCandidates.usdgCurrency0.sqrtPriceX96 = (1n << 160n).toString();
    assert.throws(
      () => deriveAddresses({ launchInputs: priceInput, inputDirectory: fixture.directory }),
      /sqrtPriceX96 is outside uint160/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects malformed CREATE2 values, salt-range overflow, and default-profile provider mining', () => {
  assert.throws(
    () => computeCreate2Address('0x12', salt(1), bytes32('a')),
    /deployer must be a 20-byte address/i,
  );

  const finalSalt = (1n << 256n) - 1n;
  assert.throws(
    () => mineSalt({
      deployer: PROGRAMMABLE_GRAPH_FACTORY,
      initCodeHashHex: bytes32('a'),
      mask: ALL_HOOK_PERMISSION_MASK,
      required: REQUIRED_HOOK_PERMISSION_MASK,
      startSalt: finalSalt,
      maxAttempts: 2,
    }),
    /salt search range exceeds bytes32/i,
  );
  assert.throws(
    () => mineProgrammableSalt({
      chainId: '4663',
      factory: PROGRAMMABLE_GRAPH_FACTORY,
      routeNamespace: bytes32('a'),
      routeNonce: bytes32('b'),
      targetIdHash: bytes32('c'),
      authorizedLauncher: PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
      initCodeHashHex: bytes32('d'),
      mask: ALL_HOOK_PERMISSION_MASK,
      required: REQUIRED_HOOK_PERMISSION_MASK,
      startSalt: finalSalt,
      maxAttempts: 2,
    }),
    /salt search range exceeds bytes32/i,
  );
  assert.throws(
    () => mineHookAddress({
      configPath: null,
      providerSalt: {
        chainId: '4663',
        factory: PROGRAMMABLE_GRAPH_FACTORY,
        routeNamespace: bytes32('a'),
        routeNonce: bytes32('b'),
        targetIdHash: bytes32('c'),
        authorizedLauncher: PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
      },
      contractsRoot: 'not-used',
      forgeBinary: 'not-used',
      startSalt: 0n,
      maxAttempts: 1,
    }),
    /--hook-artifact/i,
  );
});

test('rejects detached token metadata outside the artifact-bound constructor preimage', () => {
  const fixture = makeFixture();
  try {
    const detached = structuredClone(fixture.input);
    detached.token = {
      name: 'Detached metadata',
      symbol: 'DETACHED',
      decimals: 18,
      totalSupply: '1',
    };
    assert.throws(
      () => deriveAddresses({ launchInputs: detached, inputDirectory: fixture.directory }),
      /launchInputs.token is not supported/i,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('ships a strict manifest schema and a visibly non-production input example', () => {
  const schemaPath = resolve(root, 'release/phase3/address-manifest.schema.json');
  const examplePath = resolve(root, 'release/phase3/launch-inputs.example.json');
  assert.equal(existsSync(schemaPath), true);
  assert.equal(existsSync(examplePath), true);

  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const example = JSON.parse(readFileSync(examplePath, 'utf8'));
  assert.equal(schema.$id, 'https://hookemon.example/schemas/phase3-address-manifest-v1.json');
  assert.deepEqual(schema.oneOf, [
    { $ref: '#/$defs/materializedManifest' },
    { $ref: '#/$defs/addressDerivationDraft' },
    { $ref: '#/$defs/nativeMaterializedManifest' },
    { $ref: '#/$defs/nativeAddressDerivationDraft' },
  ]);
  assert.equal(schema.$defs.materializedManifest.properties.launchInputs.$ref, '#/$defs/launchInputs');
  assert.equal(schema.$defs.addressDerivationDraft.properties.targets.prefixItems[0].properties.targetId.const, 'token');
  assert.equal(schema.$defs.addressDerivationDraft.properties.targets.prefixItems[1].properties.targetId.const, 'custody');
  assert.equal(schema.$defs.addressDerivationDraft.properties.targets.prefixItems[2].properties.targetId.const, 'hook');
  assert.equal(
    schema.$defs.ordinaryTarget.allOf[1].properties.applicantSalt.$ref,
    '#/$defs/fixedApplicantSalt',
  );
  assert.equal(
    schema.$defs.minedApplicantSalt.properties.maxAttempts.pattern,
    '^(?:[1-9][0-9]{0,5}|1[0-9]{6}|2000000)$',
  );
  assert.equal(schema.$defs.launchInputs.properties.graphAuthorization.$ref, '#/$defs/graphAuthorization');
  assert.equal(Object.hasOwn(schema.$defs.launchInputs.properties, 'token'), false);
  assert.equal(schema.$defs.tokenTarget.allOf[1].properties.targetIndex.const, 0);
  assert.equal(schema.$defs.custodyTarget.allOf[1].properties.targetIndex.const, 1);
  assert.equal(schema.$defs.graphHookTarget.allOf[1].properties.targetIndex.const, 2);
  assert.equal(schema.$defs.tokenInitializer.pattern, '^0xffd7d983[0-9a-fA-F]{64}$');
  assert.equal(schema.$defs.custodyInitializer.pattern, '^0xc81cbd43[0-9a-fA-F]{64}$');
  assert.equal(schema.$defs.hookInitializer.pattern, '^0x726bb4ae[0-9a-fA-F]{128}$');
  assert.equal(schema.$defs.graphPreimage.properties.targetCommitments.prefixItems[1].allOf[1].properties.targetIndex.const, 1);
  assert.equal(
    schema.$defs.launchInputs.properties.chain.properties.factory.const,
    PROGRAMMABLE_GRAPH_FACTORY,
  );
  assert.equal(
    schema.$defs.launchInputs.properties.chain.properties.authorizedLauncher.const,
    '0x34965F2A2ee9254522232C32F02056E92BE0C98a',
  );
  assert.equal(
    schema.$defs.launchInputs.properties.usdg.const,
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  );
  assert.equal(
    schema.$defs.graphPreimage.properties.authorization.properties.authorizedLauncher.const,
    '0x34965F2A2ee9254522232C32F02056E92BE0C98a',
  );
  assert.equal(schema.$defs.preimages.properties.factory.const, PROGRAMMABLE_GRAPH_FACTORY);
  assert.equal(
    schema.$defs.preimages.properties.authorizedLauncher.const,
    '0x34965F2A2ee9254522232C32F02056E92BE0C98a',
  );
  assert.equal(example.exampleOnly, true);
  assert.match(JSON.stringify(example), /PLACEHOLDER/);
  assert.equal(example.schemaVersion, 'hookemon.phase3.launch-inputs.v2');
  assert.deepEqual(
    validateJsonSchema({ $defs: schema.$defs, $ref: '#/$defs/nativeCompilerProfile' }, example.compilerProfile),
    [],
  );
});


test('native version derives a single zero-quote graph from explicit wei and complete stock', () => {
  const fixture = makeFixture({ native: true });
  try {
    const result = deriveAddresses({ launchInputs: fixture.input, inputDirectory: fixture.directory });
    assert.equal(result.schemaVersion, 'hookemon.phase3.derived-addresses.v2');
    assert.equal(result.pool.currency0, fixture.input.quoteCurrency);
    assert.equal(result.pool.currency1, result.targets.token.address);
    assert.equal(result.pool.selectedOrdering, 'nativeCurrency0');
    assert.equal(result.pool.priceCandidate.sqrtPriceX96, '12527072418752396559322253362376889');
    assert.equal(verifyDerivedAddresses({ launchInputs: fixture.input, derived: result, inputDirectory: fixture.directory }), true);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('native version requires the IR launch profile while the historical version stays strict', () => {
  const native = makeFixture({ native: true });
  const historical = makeFixture();
  try {
    assert.deepEqual(native.input.compilerProfile.optimizer, { enabled: true, runs: 200 });
    assert.equal(native.input.compilerProfile.viaIR, true);
    assert.equal(deriveAddresses({ launchInputs: native.input, inputDirectory: native.directory }).targets.hook.applicantSaltMode, 'mined');
    for (const [runs, viaIR, message] of [
      [1000, false, /compilerProfile\.optimizer must use 200 enabled runs/],
      [200, false, /compilerProfile uses an unsupported setting/],
      [1000, true, /compilerProfile\.optimizer must use 200 enabled runs/],
    ]) {
      const input = structuredClone(native.input);
      input.compilerProfile.optimizer.runs = runs;
      input.compilerProfile.viaIR = viaIR;
      assert.throws(() => deriveAddresses({ launchInputs: input, inputDirectory: native.directory }), message);
    }
    for (const [runs, viaIR, message] of [
      [200, true, /compilerProfile\.optimizer must use 1000 enabled runs/],
      [1000, true, /compilerProfile uses an unsupported setting/],
      [200, false, /compilerProfile\.optimizer must use 1000 enabled runs/],
    ]) {
      const input = structuredClone(historical.input);
      input.compilerProfile.optimizer.runs = runs;
      input.compilerProfile.viaIR = viaIR;
      assert.throws(() => deriveAddresses({ launchInputs: input, inputDirectory: historical.directory }), message);
    }

    const hookArtifactPath = resolve(native.directory, 'hook.json');
    const hookArtifact = JSON.parse(readFileSync(hookArtifactPath, 'utf8'));
    hookArtifact.metadata = launchMetadata({ 'src/HookemonHook.sol': 'HookemonHook' });
    writeJson(hookArtifactPath, hookArtifact);
    assert.throws(
      () => deriveAddresses({ launchInputs: native.input, inputDirectory: native.directory }),
      /hook artifact optimizer does not match the launch profile/,
    );

    const releaseToken = structuredClone(historical.input);
    releaseToken.targets.token.artifactPath = resolve(RELEASE_ARTIFACTS_DIRECTORY, 'token.json');
    assert.throws(
      () => deriveAddresses({ launchInputs: releaseToken, inputDirectory: historical.directory }),
      /token artifact optimizer does not match the launch profile/,
    );
  } finally {
    rmSync(native.directory, { recursive: true, force: true });
    rmSync(historical.directory, { recursive: true, force: true });
  }
});

test('mines a native provider hook address from the native config identity and IR-profile artifact', () => {
  const fixture = makeFixture({ native: true });
  try {
    const input = fixture.input;
    const derived = deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory });
    const hookArtifactPath = resolve(fixture.directory, 'hook.json');
    const nativeArtifact = JSON.parse(readFileSync(hookArtifactPath, 'utf8'));
    const config = fixtureHookConfig(input, derived.targets.token.address);
    const configPath = resolve(fixture.directory, 'native-config.json');
    writeJson(configPath, config);
    const providerSalt = {
      chainId: input.chain.chainId,
      factory: input.chain.factory,
      routeNamespace: input.chain.routeNamespace,
      routeNonce: input.chain.routeNonce,
      targetIdHash: input.targets.hook.targetIdHash,
      authorizedLauncher: input.chain.authorizedLauncher,
    };
    const options = {
      configPath,
      providerSalt,
      hookArtifactPath,
      contractsRoot: 'not-used',
      forgeBinary: 'not-used',
      startSalt: 0n,
      maxAttempts: 200_000,
    };

    const report = mineHookAddress(options);
    assert.equal(report.schemaVersion, 'hookemon.mined-provider-hook-address.v1');
    assert.equal(report.initCodeHash, keccakHex(`${HOOK_CREATION_BYTECODE}${encodeNativeConstructorConfig(config).slice(2)}`));
    assert.equal(report.initCodeHash, derived.targets.hook.initCodeHash);
    assert.equal(report.applicantSalt, derived.targets.hook.applicantSalt);
    assert.equal(report.effectiveSalt, derived.targets.hook.effectiveSalt);
    assert.equal(toEip55Address(report.minedAddress), derived.targets.hook.address);
    assert.equal(report.maskCheckPassed, true);

    const cliReport = JSON.parse(execFileSync(process.execPath, [
      resolve(root, 'scripts/mine-hook-address.mjs'),
      '--config', configPath,
      '--hook-artifact', hookArtifactPath,
      '--provider-chain-id', providerSalt.chainId,
      '--provider-factory', providerSalt.factory,
      '--route-namespace', providerSalt.routeNamespace,
      '--route-nonce', providerSalt.routeNonce,
      '--target-id-hash', providerSalt.targetIdHash,
      '--authorized-launcher', providerSalt.authorizedLauncher,
      '--max-attempts', '200000',
    ], { encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(cliReport.minedAddress, report.minedAddress);
    assert.equal(cliReport.initCodeHash, report.initCodeHash);
    assert.equal(cliReport.applicantSalt, report.applicantSalt);

    const historicalArtifactPath = resolve(fixture.directory, 'historical-hook.json');
    writeJson(historicalArtifactPath, {
      ...nativeArtifact,
      abi: [{ type: 'constructor', inputs: [{ name: 'config', type: 'tuple', components: hookConstructorComponents() }] }],
      metadata: launchMetadata({ 'src/HookemonHook.sol': 'HookemonHook' }),
    });
    assert.throws(
      () => mineHookAddress({ ...options, hookArtifactPath: historicalArtifactPath }),
      /hook artifact optimizer must use 200 enabled runs/,
    );
    assert.throws(
      () => mineHookAddress({ ...options, configPath: null }),
      /hook artifact optimizer must use 1000 enabled runs/,
    );
    const historicalAbiArtifactPath = resolve(fixture.directory, 'historical-abi-hook.json');
    writeJson(historicalAbiArtifactPath, {
      ...nativeArtifact,
      abi: [{ type: 'constructor', inputs: [{ name: 'config', type: 'tuple', components: hookConstructorComponents() }] }],
    });
    assert.throws(
      () => mineHookAddress({ ...options, hookArtifactPath: historicalAbiArtifactPath }),
      /constructor ABI does not match the native ConstructorConfig/,
    );
    const mixedConfigPath = resolve(fixture.directory, 'mixed-config.json');
    writeJson(mixedConfigPath, { ...config, usdg: USDG });
    assert.throws(
      () => mineHookAddress({ ...options, configPath: mixedConfigPath }),
      /either the historical or the complete native field set/,
    );

    const historicalReport = mineHookAddress({ ...options, configPath: null, hookArtifactPath: historicalArtifactPath });
    assert.equal(historicalReport.initCodeHash, keccakHex(`${HOOK_CREATION_BYTECODE}${encodeConstructorConfig(EXAMPLE_CONFIG).slice(2)}`));
    assert.equal(historicalReport.maskCheckPassed, true);
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('mines and derives a native v2 graph from the checked-in compiler exports without mutating them', () => {
  const artifacts = readReleaseArtifacts();
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-artifacts-'));
  try {
    for (const { artifact } of Object.values(artifacts)) {
      assert.equal(Object.hasOwn(artifact, 'contractName'), false);
      assert.equal(Object.keys(artifact.metadata.settings.compilationTarget).length, 1);
      assert.deepEqual(artifact.metadata.settings.metadata, { bytecodeHash: 'none', appendCBOR: false });
    }
    const input = releaseArtifactLaunchInputs(artifacts);
    const sqrtPriceX96 = input.pool.priceCandidates.nativeCurrency0.sqrtPriceX96;
    const effectiveSalt = (name) => deriveProgrammableEffectiveSalt({
      ...input.chain,
      targetIdHash: input.targets[name].targetIdHash,
      applicantSalt: input.targets[name].applicantSalt.value,
    });
    const token = toEip55Address(computeCreate2Address(
      input.chain.factory,
      effectiveSalt('token'),
      keccakHex(`${artifacts.token.artifact.bytecode.object}${addressWord(input.chain.factory)}${addressWord(input.quoteCurrency)}${uintWord(18)}${uintWord(sqrtPriceX96)}`),
    ));
    const custody = toEip55Address(computeCreate2Address(
      input.chain.factory,
      effectiveSalt('custody'),
      keccakHex(`${artifacts.custody.artifact.bytecode.object}${addressWord(input.roles.positionManager)}${uintWord(0)}`),
    ));
    const config = fixtureHookConfig(input, token);
    const configPath = resolve(directory, 'hook-config.json');
    writeJson(configPath, config);

    // One mining pass over the real hook preimage; derivation below reuses the mined salt.
    const report = mineHookAddress({
      configPath,
      providerSalt: { ...input.chain, targetIdHash: input.targets.hook.targetIdHash },
      hookArtifactPath: artifacts.hook.path,
      contractsRoot: 'not-used',
      forgeBinary: 'not-used',
      startSalt: 0n,
      maxAttempts: 200_000,
    });
    assert.equal(report.hookArtifact, artifacts.hook.path);
    assert.equal(report.initCodeHash, keccakHex(`${artifacts.hook.artifact.bytecode.object}${encodeNativeConstructorConfig(config).slice(2)}`));
    assert.equal(report.maskCheckPassed, true);

    input.targets.hook.applicantSalt = { mode: 'fixed', value: report.applicantSalt };
    input.targets.token.initializerCalldata = initializer('allocate(address)', [addressWord(report.minedAddress)]);
    input.targets.custody.initializerCalldata = initializer('configureBindingHook(address)', [addressWord(report.minedAddress)]);
    input.targets.hook.initializerCalldata = initializer('initializeGraphLaunch(address,uint160)', [
      addressWord(custody),
      uintWord(sqrtPriceX96),
    ]);

    const derived = deriveAddresses({ launchInputs: input, inputDirectory: RELEASE_ARTIFACTS_DIRECTORY });
    assert.equal(derived.schemaVersion, 'hookemon.phase3.derived-addresses.v2');
    assert.equal(derived.targets.token.address, token);
    assert.equal(derived.targets.custody.address, custody);
    assert.equal(derived.targets.hook.address, toEip55Address(report.minedAddress));
    assert.equal(derived.targets.hook.applicantSaltMode, 'fixed');
    assert.equal(derived.targets.hook.applicantSalt, report.applicantSalt);
    assert.equal(derived.targets.hook.effectiveSalt, report.effectiveSalt);
    assert.equal(derived.targets.hook.initCodeHash, report.initCodeHash);
    assert.equal(derived.targets.hook.constructorArguments, encodeNativeConstructorConfig(config).toLowerCase());
    assert.equal(derived.targets.hook.constructorArguments.length, 2 + 18 * 64);
    assert.equal(satisfiesMask(derived.targets.hook.address, ALL_HOOK_PERMISSION_MASK, REQUIRED_HOOK_PERMISSION_MASK), true);
    for (const name of ['token', 'hook', 'custody']) {
      const { artifact, bytes } = artifacts[name];
      assert.equal(derived.targets[name].creationBytecode, artifact.bytecode.object.toLowerCase());
      assert.equal(derived.targets[name].compilerVersion, '0.8.26+commit.8a97fa7a');
      assert.equal(derived.targets[name].artifactDigest, sha256Bytes(bytes));
      assert.deepEqual(derived.targets[name].runtimeImmutableReferences, artifact.deployedBytecode.immutableReferences);
      assert.equal(
        derived.targets[name].runtimeImmutablePatches.length,
        Object.values(artifact.deployedBytecode.immutableReferences).flat().length,
      );
      assert.notEqual(derived.targets[name].runtimeCodeHash, derived.targets[name].runtimeTemplateCodeHash);
    }
    assert.equal(derived.pool.currency0, input.quoteCurrency);
    assert.equal(derived.pool.currency1, token);
    assert.equal(derived.pool.selectedOrdering, 'nativeCurrency0');
    assert.equal(derived.pool.sqrtPriceX96, sqrtPriceX96);
    assert.deepEqual(derived.graph.orderedTargetIds, ['token', 'custody', 'hook']);
    assert.equal(verifyDerivedAddresses({ launchInputs: input, derived, inputDirectory: RELEASE_ARTIFACTS_DIRECTORY }), true);

    const manifest = buildAddressManifest({ launchInputs: input, inputDirectory: RELEASE_ARTIFACTS_DIRECTORY });
    assert.equal(manifest.schemaVersion, 'hookemon.phase3.address-manifest.v2');
    const schema = JSON.parse(readFileSync(resolve(root, 'release/phase3/address-manifest.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonSchema(schema, manifest), []);
    assert.equal(verifyAddressManifest({ manifest, inputDirectory: RELEASE_ARTIFACTS_DIRECTORY }), true);

    for (const { path, bytes } of Object.values(artifacts)) assert.equal(readFileSync(path).equals(bytes), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('refuses compiler exports with conflicting identity or explicit non-default metadata settings', () => {
  const artifacts = readReleaseArtifacts();
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-release-variants-'));
  try {
    const hookPath = resolve(directory, 'hook-variant.json');
    const hookVariant = (change) => {
      const copy = structuredClone(artifacts.hook.artifact);
      change(copy);
      writeJson(hookPath, copy);
      return () => readHookLaunchArtifactBytecode(hookPath, { native: true });
    };
    assert.equal(readHookLaunchArtifactBytecode(artifacts.hook.path, { native: true }), artifacts.hook.artifact.bytecode.object);
    assert.equal(hookVariant((a) => { a.contractName = 'HookemonHook'; })(), artifacts.hook.artifact.bytecode.object);
    assert.equal(hookVariant((a) => { a.metadata.settings.metadata.useLiteralContent = false; })(), artifacts.hook.artifact.bytecode.object);
    assert.throws(() => readHookLaunchArtifactBytecode(artifacts.hook.path), /hook artifact optimizer must use 1000 enabled runs/);
    for (const [change, message] of [
      [(a) => { a.contractName = 'HookemonHookV1'; }, /hook artifact\.contractName conflicts with metadata\.settings\.compilationTarget/],
      [(a) => { delete a.metadata.settings.compilationTarget; }, /compilationTarget is required/],
      [(a) => { a.metadata.settings.compilationTarget['src/Other.sol'] = 'Other'; }, /compilationTarget must identify exactly one contract/],
      [(a) => { a.metadata.settings.compilationTarget = { 'src/HookemonHook.sol': 'OtherHook' }; }, /must compile src\/HookemonHook\.sol:HookemonHook/],
      [(a) => { a.metadata.settings.compilationTarget = { 'src/Other.sol': 'HookemonHook' }; }, /must compile src\/HookemonHook\.sol:HookemonHook/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = true; }, /hook artifact metadata is not launch-compatible/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = null; }, /hook artifact metadata is not launch-compatible/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = 'false'; }, /hook artifact metadata is not launch-compatible/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = 0; }, /hook artifact metadata is not launch-compatible/],
      [(a) => { delete a.metadata.settings.metadata.bytecodeHash; }, /hook artifact metadata is not launch-compatible/],
      [(a) => { delete a.metadata.settings.metadata.appendCBOR; }, /hook artifact metadata is not launch-compatible/],
      [
        (a) => { a.abi.find((entry) => entry.type === 'constructor').inputs[0].components[3].name = 'usdg'; },
        /constructor ABI does not match the native ConstructorConfig/,
      ],
    ]) {
      assert.throws(hookVariant(change), message);
    }

    const tokenPath = resolve(directory, 'token-variant.json');
    const tokenVariant = (change) => {
      const copy = structuredClone(artifacts.token.artifact);
      change(copy);
      writeJson(tokenPath, copy);
      const input = releaseArtifactLaunchInputs(artifacts);
      input.targets.token.artifactPath = tokenPath;
      return () => deriveAddresses({ launchInputs: input, inputDirectory: RELEASE_ARTIFACTS_DIRECTORY });
    };
    for (const [change, message] of [
      [(a) => { a.contractName = 'HKMNTokenV1'; }, /token artifact\.contractName conflicts with metadata\.settings\.compilationTarget/],
      [(a) => { delete a.metadata.settings.compilationTarget; }, /compilationTarget must be an object/],
      [(a) => { a.metadata.settings.compilationTarget['src/Other.sol'] = 'Other'; }, /compilationTarget must identify exactly one contract/],
      [(a) => { a.metadata.settings.compilationTarget = { 'src/launch/Other.sol': 'HKMNToken' }; }, /does not match the token deployment target/],
      [(a) => { a.metadata.settings.compilationTarget = { 'src/launch/HKMNToken.sol': 'OtherToken' }; }, /does not match the token deployment target/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = true; }, /token artifact metadata does not match the launch profile/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = null; }, /token artifact metadata does not match the launch profile/],
      [(a) => { a.metadata.settings.metadata.useLiteralContent = 'false'; }, /token artifact metadata does not match the launch profile/],
      [(a) => { delete a.metadata.settings.metadata.bytecodeHash; }, /token artifact metadata does not match the launch profile/],
      [(a) => { delete a.metadata.settings.metadata.appendCBOR; }, /token artifact metadata does not match the launch profile/],
    ]) {
      assert.throws(tokenVariant(change), message);
    }
    for (const { path, bytes } of Object.values(artifacts)) assert.equal(readFileSync(path).equals(bytes), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native version refuses historical quote, implicit limits and unbound seed price', () => {
  const fixture = makeFixture({ native: true });
  try {
    for (const change of [
      input => { input.quoteCurrency = USDG; },
      input => { input.usdg = USDG; },
      input => { input.hookConstructorConfig.processClaimLimit6hWei = '0'; },
      input => { input.hookConstructorConfig.processClaimLimit6h = '1000000'; },
      input => { input.pool.seedMaximumWei = '40000000000000001'; },
      input => { input.pool.hkmnAtomic = '999999999999999999999999999'; },
    ]) {
      const input = structuredClone(fixture.input); change(input);
      assert.throws(() => deriveAddresses({ launchInputs: input, inputDirectory: fixture.directory }));
    }
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});


test('native materialized seed binds explicit funding and eighteen-word hook policy without historical approval reuse', () => {
  const fixture = makeFixture({ native: true });
  try {
    const inputs = fixture.input;
    const manifest = buildAddressManifest({ launchInputs: inputs, inputDirectory: fixture.directory });
    const candidate = deriveNativePriceCandidate({ nativeWei: inputs.pool.seedMaximumWei, hkmnAtomic: inputs.pool.hkmnAtomic });
    const release = JSON.parse(readFileSync(resolve(root, 'release/phase3/launch-inputs.json')));
    release.roles.quoteCurrency = inputs.quoteCurrency;
    release.pool.quoteAsset.amountAtomic = candidate.amount0Max;
    release.pool.priceCandidates.nativeCurrency0 = candidate;
    release.seed.nativeFunding = { payer: inputs.seedIntent.payer, amountWei: candidate.amount0Max, valueRule: 'msg.value == amount0Max' };
    const submission = JSON.parse(readFileSync(resolve(root, 'release/phase3/submission.json')));
    const selected = materializePhaseThreePriceSelection({ launchInputs: release, submission, materializedManifest: manifest });
    assert.equal(selected.submission.pool.currency0, 'native');
    assert.equal(selected.submission.pool.currency1, 'hkmn');
    assert.equal(selected.seedIntent.amount0Max, candidate.amount0Max);
    assert.equal(selected.seedIntent.liquidity, candidate.liquidity);
    assert.equal(manifest.preimages.targets.hook.constructorArguments.length, 2 + 18 * 64);
    const policy = {
      schema: 'hookemon.native-frozen-seed-policy.v1',
      chain: { ...inputs.chain, totalValue: '0' },
      roles: { ...inputs.roles, quoteCurrency: inputs.quoteCurrency },
      pool: { fee: 0, tickSpacing: 60, priceCandidates: { nativeCurrency0: candidate } },
      seedIntent: inputs.seedIntent,
      hook: { expectedDecimals: 18, processClaimLimit6hWei: inputs.hookConstructorConfig.processClaimLimit6hWei,
        processClaimLimitMaxWei: inputs.hookConstructorConfig.processClaimLimitMaxWei,
        processClaimMaxCount: inputs.hookConstructorConfig.processClaimMaxCount,
        operationsRotationDelay: inputs.hookConstructorConfig.operationsRotationDelay },
      artifacts: Object.fromEntries(['token', 'hook', 'custody'].map(id => [id, manifest.preimages.targets[id].artifactDigest])),
    };
    const verify = (frozenSeedPolicy = policy, expectedSeedIntentDigest = selected.seedIntent.digest) => verifyPhaseThreeMaterializedSeedManifest({ materializedManifest: manifest,
      inputDirectory: fixture.directory, frozenSeedPolicy, expectedSeedIntentDigest });
    assert.equal(verify(), true);
    assert.equal(validateJsonSchema(JSON.parse(readFileSync(resolve(root, 'release/phase3/address-manifest.schema.json'))), manifest).length, 0);
    for (const change of [
      p => { delete p.schema; },
      p => { p.roles.quoteCurrency = USDG; },
      p => { p.pool.priceCandidates.nativeCurrency0.amount0Max = '240000000'; },
      p => { p.seedIntent.payer = address('9'); },
      p => { p.hook.processClaimLimit6hWei = '1'; },
      p => { p.artifacts.hook = 'sha256:' + '0'.repeat(64); },
    ]) {
      const changed = structuredClone(policy); change(changed); assert.throws(() => verify(changed));
    }
    assert.throws(() => verify(policy, bytes32('1')));
    const repriced = structuredClone(release); repriced.pool.quoteAsset.amountAtomic = '80000000000000000'; repriced.seed.nativeFunding.amountWei = '80000000000000000';
    assert.throws(() => materializePhaseThreePriceSelection({ launchInputs: repriced, submission, materializedManifest: manifest }));
    const unfunded = structuredClone(release); unfunded.pool.quoteAsset.amountAtomic = null;
    assert.throws(() => materializePhaseThreePriceSelection({ launchInputs: unfunded, submission, materializedManifest: manifest }));
  } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
});
