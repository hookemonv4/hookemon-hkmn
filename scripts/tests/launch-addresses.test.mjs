import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  ALL_HOOK_PERMISSION_MASK,
  PROGRAMMABLE_GRAPH_FACTORY,
  PROGRAMMABLE_LAUNCH_STAMP_ROUTER,
  REQUIRED_HOOK_PERMISSION_MASK,
  computeCreate2Address,
  deriveProgrammableEffectiveSalt,
  encodeConstructorConfig,
  mineHookAddress,
  mineProgrammableSalt,
  mineSalt,
  satisfiesMask,
} from '../mine-hook-address.mjs';
import { keccak256 } from '../../packages/contracts/tooling/payout/canonical-merkle-sum.mjs';
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
    usdg: input.usdg,
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
    processClaimLimit6h: input.hookConstructorConfig.processClaimLimit6h,
    processClaimLimitMax: input.hookConstructorConfig.processClaimLimitMax,
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
      addressWord(input.usdg),
      uintWord(input.hookConstructorConfig.expectedDecimals),
      uintWord(candidate.sqrtPriceX96),
    ].join('');
    const tokenInitCodeHash = keccakHex(`${TOKEN_CREATION_BYTECODE}${tokenConstructorArguments}`);
    const token = toEip55Address(computeCreate2Address(input.chain.factory, tokenEffectiveSalt, tokenInitCodeHash));
    return { id, sqrtPriceX96: candidate.sqrtPriceX96, token };
  });
  if (candidates.length === 1 && candidates[0].id === 'scalar') return candidates[0];
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
    `${HOOK_CREATION_BYTECODE}${encodeConstructorConfig(fixtureHookConfig(input, token)).slice(2)}`,
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

function launchMetadata(compilationTarget) {
  return JSON.stringify({
    compiler: { version: '0.8.26+commit.8a97fa7a' },
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      viaIR: false,
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

function makeFixture() {
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
    metadata: launchMetadata({ 'src/launch/HKMNToken.sol': 'HKMNToken' }),
  });
  writeJson(hookArtifactPath, {
    contractName: 'HookemonHook',
    abi: [{
      type: 'constructor',
      inputs: [{ name: 'config', type: 'tuple', components: hookConstructorComponents() }],
    }],
    bytecode: { object: HOOK_CREATION_BYTECODE },
    deployedBytecode: { object: '0x6001600055' },
    metadata: launchMetadata({ 'src/HookemonHook.sol': 'HookemonHook' }),
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
    metadata: launchMetadata({ 'src/bindings/RobinhoodBindings.sol': 'PermanentPositionCustody' }),
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
  setCanonicalInitializerCalldata(fixture.input);
  return fixture;
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
});
