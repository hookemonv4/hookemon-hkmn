import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';

import { keccak256 as oracleKeccak256 } from '../../packages/contracts/tooling/payout/canonical-merkle-sum.mjs';
import { validateJsonSchema } from '../programmable/lib/json-schema.mjs';
import { parsePhaseThreeReleaseRebuildOptions } from '../programmable/lib/rebuild-options.mjs';
import {
  derivePriceCandidates,
  extractFoundryStandardJsonInput,
  foundryCompilerVersion,
  sourceContentCommitment,
} from '../programmable/lib/phase3-release.mjs';
import {
  PackageValidationError,
  buildLaunchPackage,
  derivePhaseThreeGraphCallsFromCompiledAbi,
  materializePhaseThreePriceSelection,
  normalizePhaseThreeAddressManifestDraft,
  normalizePhaseThreeDeploymentManifest,
  normalizePhaseThreeSubmissionDraft,
  verifyLaunchPackage,
} from '../programmable/lib/package.mjs';

const root = resolve(import.meta.dirname, '../..');
const buildCli = resolve(root, 'scripts/programmable/build-launch-package.mjs');

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const bytesToHex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
const zeroHash = `sha256:${'0'.repeat(64)}`;
const hexHash = (digit) => `0x${digit.repeat(64)}`;
const address = (digit) => `0x${digit.repeat(40)}`;
const salt = (digit) => `0x${digit.repeat(64)}`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writePhaseThreeBuildInfoFixture(directory) {
  const evidence = readJson(resolve(root, 'release/phase3/build-info/launch.json'));
  const input = structuredClone(evidence.input ?? evidence);
  delete input.version;
  const standardInputDirectory = resolve(directory, 'build-info');
  writeJson(resolve(standardInputDirectory, 'launch.json'), input);
  return standardInputDirectory;
}

function writePhaseThreeDraftFixture(directory) {
  const launchInputs = readJson(resolve(root, 'release/phase3/launch-inputs.json'));
  const addressManifest = readJson(resolve(root, 'release/phase3/address-manifest.json'));
  addressManifest.compiler.solcLongVersion = '0.8.26+commit.8a97fa7a';
  addressManifest.targets.find(({ targetId }) => targetId === 'token').sourcePath = 'packages/contracts/src/launch/HKMNToken.sol';
  addressManifest.targets.find(({ targetId }) => targetId === 'hook').initializer.function = 'initializeGraphLaunch(address,uint160)';
  addressManifest.requiredGraphCalls = derivePhaseThreeGraphCallsFromCompiledAbi(resolve(root, 'release/phase3/artifacts'));
  addressManifest.postDeployAssertions[0] = 'No graph transaction is signable until the provider supplies the encoded token-allocate, custody-bind-hook and hook-initialize-graph-launch calls in that order.';
  const launchInputsPath = resolve(directory, 'launch-inputs.json');
  const addressManifestPath = resolve(directory, 'address-manifest.json');
  const standardInputDirectory = writePhaseThreeBuildInfoFixture(directory);
  writeJson(launchInputsPath, launchInputs);
  writeJson(addressManifestPath, addressManifest);
  return { launchInputs, addressManifest, launchInputsPath, addressManifestPath, standardInputDirectory };
}

function materializedPriceSelectionFixture(launchInputs, selectedOrdering = 'hkmnCurrency0') {
  const token = address('1');
  const hook = address('2');
  const usdg = launchInputs.roles.usdg;
  const currency0 = selectedOrdering === 'hkmnCurrency0' ? token : usdg;
  const currency1 = selectedOrdering === 'hkmnCurrency0' ? usdg : token;
  const poolKeyEncoded = `0x${[
    currency0.slice(2).toLowerCase().padStart(64, '0'),
    currency1.slice(2).toLowerCase().padStart(64, '0'),
    '0'.repeat(64),
    BigInt(launchInputs.pool.tickSpacing).toString(16).padStart(64, '0'),
    hook.slice(2).toLowerCase().padStart(64, '0'),
  ].join('')}`;
  const selected = launchInputs.pool.priceCandidates[selectedOrdering];
  return {
    schemaVersion: 'hookemon.phase3.address-manifest.v1',
    preimages: {
      targets: {
        token: { address: token },
        hook: { address: hook },
      },
      pool: {
        currency0,
        currency1,
        fee: 0,
        tickSpacing: launchInputs.pool.tickSpacing,
        hooks: hook,
        selectedOrdering,
        priceCandidate: {
          id: selectedOrdering,
          sqrtPriceX96: selected.sqrtPriceX96,
        },
        sqrtPriceX96: selected.sqrtPriceX96,
        poolKeyEncoded,
        poolId: bytesToHex(oracleKeccak256(Buffer.from(poolKeyEncoded.slice(2), 'hex'))),
      },
    },
  };
}

function packageBytes(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push([relative(directory, absolute), readFileSync(absolute)]);
    }
  };
  visit(directory);
  return files;
}

function assertFailure(action, code, path) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PackageValidationError, `expected PackageValidationError, received ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    return true;
  });
}

function launchStandardInput(contractName) {
  return JSON.stringify({
    language: 'Solidity',
    sources: {
      [`src/${contractName}.sol`]: { content: `contract ${contractName} {}` },
    },
    settings: {
      optimizer: { enabled: true, runs: 1000 },
      viaIR: false,
      evmVersion: 'cancun',
      metadata: {
        appendCBOR: false,
        bytecodeHash: 'none',
        useLiteralContent: false,
      },
    },
  });
}

function targetDefinitions(count) {
  const definitions = [
    { targetId: 'token', componentKind: 'token', declaredHookPermissions: null, saltDigit: '1' },
    {
      targetId: 'hook',
      componentKind: 'hook',
      declaredHookPermissions: ['beforeSwap', 'afterSwap'],
      saltDigit: '2',
    },
  ];
  for (let index = 0; definitions.length < count; index += 1) {
    definitions.push({
      targetId: index === 0 ? 'custody' : `other-${index}`,
      componentKind: 'other',
      declaredHookPermissions: null,
      saltDigit: (3 + (index % 7)).toString(),
    });
  }
  return definitions;
}

function writeFixture(directory, { targetCount = 3 } = {}) {
  const artifactDirectory = resolve(directory, 'artifacts');
  const standardInputDirectory = resolve(directory, 'standard-inputs');
  const launchInputsPath = resolve(directory, 'launch-inputs.json');
  const addressManifestPath = resolve(directory, 'address-manifest.json');
  const definitions = targetDefinitions(targetCount);
  const salts = {};
  const targets = [];

  for (const [index, definition] of definitions.entries()) {
    const contractName = `Fixture${index}`;
    const artifactPath = `${definition.targetId}.json`;
    const standardJsonInputPath = `${definition.targetId}.json`;
    const creationBytecode = `0x60${(16 + index).toString(16).padStart(2, '0')}`;
    const runtimeBytecode = `0x61${(32 + index).toString(16).padStart(2, '0')}`;
    writeJson(resolve(artifactDirectory, artifactPath), {
      contractName,
      sourceName: `src/${contractName}.sol`,
      bytecode: { object: creationBytecode },
      deployedBytecode: { object: runtimeBytecode, immutableReferences: {} },
      metadata: JSON.stringify({ compiler: { version: '0.8.26+commit.8a97fa7a' } }),
    });
    mkdirSync(standardInputDirectory, { recursive: true });
    writeFileSync(resolve(standardInputDirectory, standardJsonInputPath), launchStandardInput(contractName));
    salts[definition.targetId] = salt(definition.saltDigit);
    targets.push({
      targetId: definition.targetId,
      artifactPath,
      standardJsonInputPath,
      compilationUnitId: `${definition.targetId}-unit`,
      sourcePath: `src/${contractName}.sol`,
      contractName,
      constructorArguments: '0x',
      initializerCalldata: '0x',
      constructorAddressLocators: [],
      initializerAddressLocators: [],
      deploymentValueWei: '0',
      initializerValueWei: '0',
      componentKind: definition.componentKind,
      declaredHookPermissions: definition.declaredHookPermissions,
      runtimeImmutables: [],
    });
  }

  const imageBytes = Buffer.from('fixture-image-bytes');
  const projectMetadata = {
    schemaVersion: 'programmable.project-metadata.v1',
    token: { name: 'Fixture Token', symbol: 'FIX' },
    presentation: {
      schemaVersion: 'programmable.launch-presentation-draft.v1',
      description: 'A deterministic local package fixture.',
      image: {
        uri: 'https://example.invalid/fixture.png',
        contentSha256: sha256(imageBytes),
        mediaType: 'image/png',
        byteLength: imageBytes.length,
        width: 1,
        height: 1,
      },
      links: [
        { kind: 'website', uri: 'https://example.invalid' },
        { kind: 'x', uri: 'https://x.com/fixture' },
      ],
    },
    tokenMetadataBinding: {
      schemaVersion: 'programmable.project-token-metadata-binding.v1',
      tokenTargetId: 'token',
      declarationBinding: 'request-and-launch-id',
      standardReadModel: { name: true, symbol: true },
      name: { staticSource: 'not-deterministically-extractable', argumentIndex: null, argumentName: null },
      symbol: { staticSource: 'not-deterministically-extractable', argumentIndex: null, argumentName: null },
      postDeploymentReadback: 'required',
    },
  };

  const launchInputs = {
    schemaVersion: 'hookemon.programmable-launch-inputs.v1',
    chainId: '4663',
    caip2: 'eip155:4663',
    launchWallet: address('1'),
    nonce: salt('a'),
    permitWindow: { validAfter: '0', deadline: '4102444800' },
    tickSpacing: 60,
    sqrtPriceX96: '79228162514264337593543950336',
    liquidity: { chainId: '4663', assetId: 'pool-liquidity', decimals: 0, amountAtomic: '1000000' },
    roles: {
      launchAuthority: address('2'),
      tokenRecipient: address('3'),
      custodyRecipient: address('4'),
    },
    salts,
    funding: {
      schemaVersion: 'programmable.custom-launch-funding-intent.v2',
      mode: 'none',
      valueWei: '0',
    },
    liquidityModel: {
      schemaVersion: 'programmable.custom-launch-liquidity-model.v1',
      model: 'project-provided-liquidity',
      declaredLaunchState: 'liquidity-required',
      targetIds: definitions.map((definition) => definition.targetId),
    },
    projectMetadata,
    projectMetadataImage: {
      mediaType: 'image/png',
      base64: imageBytes.toString('base64'),
    },
    agentAttestation: {
      schemaVersion: 'programmable.agent-launch-attestation.v2',
      agentId: 'local-package-builder',
      checkedAt: '2026-09-04T00:00:00.000Z',
      checks: [{ checkId: 'fixture-evidence', evidenceSha256: sha256('fixture-evidence') }],
    },
  };

  const sourceBundleManifest = {
    schemaVersion: '2.0.0',
    entries: [{
      path: 'src/Fixture0.sol',
      kind: 'file',
      mode: '100644',
      byteLength: '20',
      contentSha256: sha256('fixture-source'),
      symlinkTarget: null,
    }],
  };
  const addressManifest = {
    schemaVersion: 'hookemon.programmable-address-manifest.v1',
    chainDeployment: {
      schemaVersion: 'programmable.custom-launch-chain-deployment.v1',
      chainDeploymentId: 'robinhood-mainnet-custom-launch-v1',
      chainId: '4663',
      caip2: 'eip155:4663',
    },
    chainDeploymentDescriptorDigest: hexHash('e'),
    profile: {
      schemaVersion: 'programmable.custom-launch-profile-ref.v4',
      structuralProfileId: 'programmable.custom-launch.robinhood-mainnet.v1',
      businessProfileId: 'robinhood-production-launch',
      profileRevision: 1,
      profileVersion: '4.0.0',
      profileDigest: sha256('fixture-profile'),
    },
    sourceDescriptor: {
      schemaVersion: '2.0.0',
      kind: 'deterministic-source-bundle',
      controllerWallet: address('1'),
      sourceLineageNonce: '1',
      sourceBundleDigest: hexHash('b'),
      bundleContentSha256: sha256(canonicalJson(sourceBundleManifest)),
      publicOriginCommitment: hexHash('c'),
    },
    sourceBundleManifest,
    externalContracts: [],
    pool: { tokenTargetId: 'token', hookTargetId: 'hook', fee: 0 },
    targets,
  };
  writeJson(launchInputsPath, launchInputs);
  writeJson(addressManifestPath, addressManifest);
  return {
    artifactDirectory,
    standardInputDirectory,
    launchInputsPath,
    addressManifestPath,
    launchInputs,
    addressManifest,
  };
}

function buildFixture(paths, outputDirectory) {
  return buildLaunchPackage({
    artifactDirectory: paths.artifactDirectory,
    standardInputDirectory: paths.standardInputDirectory,
    launchInputsPath: paths.launchInputsPath,
    addressManifestPath: paths.addressManifestPath,
    outputDirectory,
  });
}

test('generator produces byte-identical local packages and rederivable computed hashes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'programmable-package-test-'));
  try {
    const paths = writeFixture(directory);
    const firstDirectory = resolve(directory, 'first');
    const secondDirectory = resolve(directory, 'second');
    const first = buildFixture(paths, firstDirectory);
    const second = buildFixture(paths, secondDirectory);

    assert.deepEqual(packageBytes(firstDirectory), packageBytes(secondDirectory));
    assert.deepEqual(packageBytes(firstDirectory).map(([path]) => path).sort(), [
      'central-package/application.json',
      'central-package/compatibility-report.json',
      'central-package/evidence-index.json',
      'central-package/PROPOSAL.md',
      'central-package/TEST_PLAN.md',
      'central-package/THREAT_MODEL.md',
      'create-request.json',
      'package-manifest.json',
    ].sort());
    assert.equal(first.createRequestSha256, second.createRequestSha256);
    assert.deepEqual(first.unverified.map((entry) => entry.code), second.unverified.map((entry) => entry.code));

    const request = readJson(resolve(firstDirectory, 'create-request.json'));
    assert.deepEqual(Object.keys(request).sort(), [
      'agentAttestation',
      'caip2',
      'chainDeployment',
      'chainDeploymentDescriptorDigest',
      'chainId',
      'externalContracts',
      'funding',
      'graphBundle',
      'launchIntentHash',
      'launchWallet',
      'liquidityModel',
      'nonce',
      'permitWindow',
      'profile',
      'projectMetadata',
      'projectMetadataHash',
      'projectMetadataImageArtifact',
      'schemaVersion',
      'sourceBundleManifest',
      'sourceDescriptor',
      'verificationBundle',
    ]);
    assert.equal(request.graphBundle.targets.length, 3);
    assert.equal(request.graphBundle.targets.filter((target) => target.componentKind === 'token').length, 1);
    assert.equal(request.graphBundle.targets.filter((target) => target.componentKind === 'hook').length, 1);
    const expectedRuntimeHash = bytesToHex(oracleKeccak256(Buffer.from('6120', 'hex')));
    assert.equal(request.graphBundle.targets[0].expectedRuntimeCodeHash, expectedRuntimeHash);
    assert.equal(
      request.verificationBundle.compilationUnits.find((unit) => unit.compilationUnitId === 'token-unit').standardJsonInputSha256,
      sha256(readFileSync(resolve(paths.standardInputDirectory, 'token.json'))),
    );
    assert.equal(request.projectMetadataImageArtifact.contentSha256, sha256(Buffer.from('fixture-image-bytes')));
    assert.equal(request.projectMetadataHash, sha256(canonicalJson(request.projectMetadata)));
    assert.equal(request.graphBundle.sourceBundleSha256, sha256(canonicalJson(paths.addressManifest.sourceBundleManifest)));
    assert.equal(request.launchIntentHash, zeroHash);

    assertFailure(
      () => verifyLaunchPackage({ ...paths, packageDirectory: firstDirectory }),
      'UNVERIFIED_COMMITMENT',
      '/launchIntentHash',
    );
    const report = verifyLaunchPackage({ ...paths, packageDirectory: firstDirectory, allowUnverified: true });
    assert.equal(report.ok, true);
    assert.equal(report.readyForPreflight, false);
    assert.equal(report.unverified.some((entry) => entry.blocking), true);
    assert.ok(report.unverified.some((entry) => entry.path === '/launchIntentHash'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package materialization accepts Foundry object and raw metadata compiler records', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'programmable-foundry-metadata-test-'));
  try {
    const paths = writeFixture(directory);
    const tokenPath = resolve(paths.artifactDirectory, 'token.json');
    const token = readJson(tokenPath);
    token.metadata = { compiler: { version: '0.8.26+commit.8a97fa7a' } };
    writeJson(tokenPath, token);

    const hookPath = resolve(paths.artifactDirectory, 'hook.json');
    const hook = readJson(hookPath);
    delete hook.metadata;
    hook.rawMetadata = JSON.stringify({ compiler: { version: '0.8.26+commit.8a97fa7a' } });
    writeJson(hookPath, hook);

    assert.equal(buildFixture(paths, resolve(directory, 'package')).mode, 'provider-request-draft');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source content commitment accepts a bare Standard JSON input', () => {
  const evidence = readJson(resolve(root, 'release/phase3/build-info/launch.json'));
  const input = structuredClone(evidence.input ?? evidence);
  delete input.version;
  assert.doesNotThrow(() => sourceContentCommitment(input));
});

test('Foundry build evidence is reduced to a bare Standard JSON input', () => {
  const input = extractFoundryStandardJsonInput({
    version: '1',
    solcVersion: '0.8.26+commit.8a97fa7a',
    solcLongVersion: '0.8.26',
    input: {
      version: '0.8.26+commit.8a97fa7a',
      language: 'Solidity',
      sources: { 'src/HKMNToken.sol': { content: 'contract HKMNToken {}' } },
      settings: { optimizer: { enabled: true, runs: 1000 } },
    },
  });

  assert.deepEqual(input, {
    language: 'Solidity',
    sources: { 'src/HKMNToken.sol': { content: 'contract HKMNToken {}' } },
    settings: { optimizer: { enabled: true, runs: 1000 } },
  });
  assert.equal(Object.hasOwn(input, 'version'), false);
});

test('Foundry compiler records retain the full metadata version', () => {
  assert.equal(
    foundryCompilerVersion({ metadata: { compiler: { version: '0.8.26+commit.8a97fa7a' } } }),
    '0.8.26+commit.8a97fa7a',
  );
  assert.equal(
    foundryCompilerVersion({ rawMetadata: JSON.stringify({ compiler: { version: '0.8.26+commit.8a97fa7a' } }) }),
    '0.8.26+commit.8a97fa7a',
  );
});

test('the contracts launch profile pins the Phase 3 compiler settings', () => {
  const config = readFileSync(resolve(root, 'packages/contracts/foundry.toml'), 'utf8');
  const launchProfile = config.match(/\[profile\.launch\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
  for (const setting of [
    'solc_version = "0.8.26"',
    'optimizer = true',
    'optimizer_runs = 1000',
    'via_ir = false',
    'evm_version = "cancun"',
    'bytecode_hash = "none"',
    'cbor_metadata = false',
  ]) assert.ok(launchProfile.includes(setting), `launch profile is missing ${setting}`);
});

test('the Phase 3 rebuild can materialize into isolated output paths', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-rebuild-options-test-'));
  try {
    const defaults = {
      releaseDirectory: resolve(root, 'release/phase3'),
      releasePlanPath: resolve(root, 'packages/contracts/script/release/PhaseThreeReleasePlan.sol'),
    };
    assert.deepEqual(
      parsePhaseThreeReleaseRebuildOptions([
        '--release-directory', resolve(directory, 'phase3'),
        '--release-plan-output', resolve(directory, 'PhaseThreeReleasePlan.sol'),
      ], defaults),
      {
        releaseDirectory: resolve(directory, 'phase3'),
        releasePlanPath: resolve(directory, 'PhaseThreeReleasePlan.sol'),
      },
    );
    assert.throws(
      () => parsePhaseThreeReleaseRebuildOptions(['--release-directory'], defaults),
      /--release-directory requires a path/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('verifier rejects tampered request fields, hashes, component counts, and funding modes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'programmable-package-test-'));
  const packageDirectory = resolve(directory, 'package');
  const requestPath = resolve(packageDirectory, 'create-request.json');
  try {
    const paths = writeFixture(directory);
    buildFixture(paths, packageDirectory);

    const mutateAndCheck = (mutate, code, path) => {
      const original = readFileSync(requestPath);
      const request = JSON.parse(original);
      mutate(request);
      writeJson(requestPath, request);
      assertFailure(
        () => verifyLaunchPackage({ ...paths, packageDirectory, allowUnverified: true }),
        code,
        path,
      );
      writeFileSync(requestPath, original);
    };

    mutateAndCheck((request) => { request.unsupportedFeeField = true; }, 'UNEXPECTED_PROPERTY', '/unsupportedFeeField');
    mutateAndCheck((request) => { delete request.funding.valueWei; }, 'MISSING_PROPERTY', '/funding/valueWei');
    mutateAndCheck((request) => { request.graphBundle.targets[0].expectedRuntimeCodeHash = hexHash('f'); }, 'HASH_MISMATCH', '/graphBundle/targets/0/expectedRuntimeCodeHash');
    mutateAndCheck((request) => { request.graphBundle.targets[0].componentKind = 'other'; }, 'GRAPH_TOKEN_COUNT', '/graphBundle/targets');
    mutateAndCheck((request) => { request.funding.mode = 'asset-transfer'; }, 'FUNDING_MODE', '/funding/mode');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generator rejects graph bounds before package creation', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'programmable-package-test-'));
  try {
    for (const targetCount of [2, 17]) {
      const fixtureDirectory = resolve(directory, String(targetCount));
      const paths = writeFixture(fixtureDirectory, { targetCount });
      assertFailure(
        () => buildFixture(paths, resolve(fixtureDirectory, 'package')),
        'GRAPH_TARGET_COUNT',
        '/targets',
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI never serializes inherited environment values', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'programmable-package-test-'));
  try {
    const paths = writeFixture(directory);
    const outputDirectory = resolve(directory, 'package');
    const sentinelA = 'sentinel-alpha-91b14b';
    const sentinelB = 'sentinel-beta-7c032d';
    const result = spawnSync(process.execPath, [
      buildCli,
      '--artifacts', paths.artifactDirectory,
      '--standard-json-inputs', paths.standardInputDirectory,
      '--launch-inputs', paths.launchInputsPath,
      '--address-manifest', paths.addressManifestPath,
      '--output', outputDirectory,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PACKAGE_TOOLING_ENV_ALPHA: sentinelA,
        PACKAGE_TOOLING_ENV_BETA: sentinelB,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const serialized = [result.stdout, result.stderr, ...packageBytes(outputDirectory).map(([, bytes]) => bytes.toString('utf8'))].join('\n');
    assert.equal(serialized.includes(sentinelA), false);
    assert.equal(serialized.includes(sentinelB), false);
    assert.equal(existsSync(resolve(outputDirectory, 'central-package', 'application.json')), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three records both address-order price candidates and the C3 hook route', () => {
  const launchInputs = readJson(resolve(root, 'release/phase3/launch-inputs.json'));
  assert.equal(launchInputs.pool.tickSpacing, 60);
  assert.deepEqual(launchInputs.pool.fullRange, { minimumTick: -887220, maximumTick: 887220 });
  assert.equal(
    launchInputs.pool.priceCandidates.usdgCurrency0.sqrtPriceX96,
    '161723809515207654588927258648643645224',
  );
  assert.equal(
    launchInputs.pool.priceCandidates.hkmnCurrency0.sqrtPriceX96,
    '38813714284914462669',
  );
  assert.deepEqual(launchInputs.token.allocation, {
    canonicalPoolBps: 10000,
    remainderCustodyBps: 0,
    canonicalPool: {
      chainId: '4663', assetId: 'hkmn', decimals: 18, amountAtomic: '1000000000000000000000000000',
    },
    remainderCustody: {
      chainId: '4663', assetId: 'hkmn', decimals: 18, amountAtomic: '0',
    },
  });
  assert.equal(launchInputs.pool.quoteAsset.amountAtomic, '240000000');
  assert.equal(launchInputs.pool.baseAsset.amountAtomic, '1000000000000000000000000000');
  assert.equal(launchInputs.metadata.x, 'https://x.com/hookemon4');
  assert.match(launchInputs.token.sourceCompatibility.reason, /Requirements revision 65/i);
  assert.match(launchInputs.token.sourceCompatibility.reason, /complete supply.*zero other allocations/i);
  assert.deepEqual(
    launchInputs.pool.priceCandidates.usdgCurrency0.swapFeeQuadrants,
    {
      zeroForOneExactInput: { currency: 'currency0', basis: 'gross-input', collectionPath: 'before-swap-return-delta' },
      zeroForOneExactOutput: { currency: 'currency0', basis: 'gross-input', collectionPath: 'after-swap-return-delta' },
      oneForZeroExactInput: { currency: 'currency0', basis: 'gross-output', collectionPath: 'after-swap-return-delta' },
      oneForZeroExactOutput: { currency: 'currency0', basis: 'gross-output', collectionPath: 'before-swap-return-delta' },
    },
  );
  assert.deepEqual(
    launchInputs.pool.priceCandidates.hkmnCurrency0.swapFeeQuadrants,
    {
      zeroForOneExactInput: { currency: 'currency1', basis: 'gross-output', collectionPath: 'after-swap-return-delta' },
      zeroForOneExactOutput: { currency: 'currency1', basis: 'gross-output', collectionPath: 'before-swap-return-delta' },
      oneForZeroExactInput: { currency: 'currency1', basis: 'gross-input', collectionPath: 'before-swap-return-delta' },
      oneForZeroExactOutput: { currency: 'currency1', basis: 'gross-input', collectionPath: 'after-swap-return-delta' },
    },
  );

  const submission = readJson(resolve(root, 'release/phase3/submission.json'));
  assert.equal(submission.hook.permissions.beforeInitialize, true);
  assert.equal(submission.hook.permissions.beforeSwapReturnDelta, true);
  assert.equal(submission.hook.permissions.afterSwapReturnDelta, true);
  assert.equal(submission.hook.feeMechanism.collectionPath, 'quadrant-dependent-swap-return-delta');
  assert.equal(submission.hook.returnDeltaAccounting.used, true);
  assert.equal(submission.hook.postReturnDeltaAccounting.afterSwap.used, true);
  assert.equal(submission.hook.postReturnDeltaAccounting.afterAddLiquidity.used, false);
  assert.equal(submission.hook.postReturnDeltaAccounting.afterRemoveLiquidity.used, false);
  assert.deepEqual(submission.hook.hookData, {
    used: false,
    schema: null,
    identitySource: null,
    trustedRouterDeploymentRecordId: null,
    callbackSenderRule: null,
    validation: null,
  });
  assert.equal(submission.programmableFee.ownership.owner, '0x4957f49620AFf3Adbbe8195a4f633E49cc93376c');
  assert.equal(submission.programmableFee.ownership.immutable, true);
  assert.equal(submission.tokenMechanics, null);
  assert.ok(submission.builderTemplate.templateSelection.customCapabilities.some(
    (capability) => capability.reviewRoute === 'architecture-review-required',
  ));
});

test('phase three submission keeps resolved allocation and preflight disclosures complete', () => {
  const submission = readJson(resolve(root, 'release/phase3/submission.json'));
  assert.equal(submission.builder.github, null);
  assert.equal(submission.builder.contact, null);
  assert.equal(Object.hasOwn(submission.builder, 'builderNote'), false);
  assert.deepEqual(submission.unresolved.length, 1);
  assert.match(submission.unresolved[0], /Provider graph preimage/i);
  assert.match(submission.unresolved[0], /token\.allocate\(hook\)/i);
  assert.match(submission.disclosures.join('\n'), /FEE-01 records the accepted 10 bps platform share/i);
  assert.match(submission.disclosures.join('\n'), /Requirements revision 65.*zero other allocations/i);
  assert.match(submission.disclosures.join('\n'), /240 USDG owner seed/i);
  assert.equal(submission.integration.dataReconstruction.mode, 'events-with-confirmed-reads');
  assert.equal(
    submission.integration.dataReconstruction.cursor,
    'block-number-transaction-index-log-index',
  );
  assert.equal(submission.integration.dataReconstruction.reserveReconstruction.used, true);
  assert.ok(submission.projectCapabilities.some(({ id }) => id === 'canonical-v4-pool'));
  assert.ok(submission.projectCapabilities.some(({ id }) => id === 'security-properties'));
});

test('phase three submission mirrors the source accounting and initialization model', () => {
  const submission = readJson(resolve(root, 'release/phase3/submission.json'));
  const launchInputs = readJson(resolve(root, 'release/phase3/launch-inputs.json'));
  const manifest = readJson(resolve(root, 'release/phase3/address-manifest.json'));

  assert.equal(
    submission.publicMetadata.project.description,
    'Hookemon buys gacha card packs, opens them, sells the cards and pays the proceeds to HKMN holders. Trading fees fund the packs.',
  );
  assert.equal(submission.publicMetadata.project.metadataMutable, true);
  assert.equal(submission.publicMetadata.token.metadataMutable, true);
  assert.match(submission.hook.callbackPolicies[0].necessity, /unconditionally reverts/i);
  assert.deepEqual(
    submission.hook.feeMechanism.recipients.map(({ role, sharePpm }) => ({ role, sharePpm })),
    [
      { role: 'programmable-platform', sharePpm: 33333 },
      { role: 'treasury', sharePpm: 133333 },
      { role: 'process', sharePpm: 833334 },
    ],
  );
  assert.match(submission.hook.feeMechanism.ownership, /10\/40\/250 bps source streams/i);
  assert.match(submission.hook.customAccounting.conservationEquation, /process liability/i);
  assert.ok(submission.integration.events.includes('ProcessClaimed'));
  assert.equal(launchInputs.roles.issuanceAuthority, '0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd');
  assert.equal(manifest.targets.find(({ targetId }) => targetId === 'token').constructor.issuanceAuthority, launchInputs.roles.issuanceAuthority);
  assert.equal(manifest.targets.find(({ targetId }) => targetId === 'hook').constructor.issuanceAuthority, launchInputs.roles.issuanceAuthority);
  assert.equal(manifest.targets.find(({ targetId }) => targetId === 'custody').constructor.tokenId, 0);
  assert.deepEqual(
    manifest.requiredGraphCalls.map(({ callId }) => callId),
    ['token-allocate', 'custody-bind-hook', 'hook-initialize-graph-launch'],
  );
  assert.deepEqual(manifest.requiredGraphCalls[0], {
    callId: 'token-allocate',
    targetId: 'token',
    function: 'allocate(address)',
    selector: '0xffd7d983',
    caller: 'graph factory',
    argumentBindings: ['resolved HookemonHook address'],
    calldata: null,
    reason: 'The graph factory allocates the fixed supply after all target addresses are resolved.',
  });
});

test('phase three graph calls are ordered and selected from compiled target ABIs', () => {
  const calls = derivePhaseThreeGraphCallsFromCompiledAbi(resolve(root, 'release/phase3/artifacts'));
  const contracts = [
    ['token', 'token-allocate', 'allocate'],
    ['custody', 'custody-bind-hook', 'configureBindingHook'],
    ['hook', 'hook-initialize-graph-launch', 'initializeGraphLaunch'],
  ];
  const expected = contracts.map(([targetId, callId, name]) => {
    const artifact = readJson(resolve(root, 'release/phase3/artifacts', `${targetId}.json`));
    const entry = artifact.abi.find((candidate) => candidate.type === 'function' && candidate.name === name);
    assert.ok(entry, `${targetId} ABI must expose ${name}`);
    const signature = `${entry.name}(${entry.inputs.map(({ type }) => type).join(',')})`;
    return {
      callId,
      targetId,
      function: signature,
      selector: bytesToHex(oracleKeccak256(Buffer.from(signature, 'utf8')).subarray(0, 4)),
    };
  });

  assert.deepEqual(
    calls.map(({ callId, targetId, function: signature, selector }) => ({
      callId, targetId, function: signature, selector,
    })),
    expected,
  );
});

test('phase three draft accepts only the ABI-derived three-call graph', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-three-call-graph-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    const launchInputsPath = fixture.launchInputsPath;
    const addressManifestPath = resolve(directory, 'address-manifest.json');
    const manifest = readJson(resolve(root, 'release/phase3/address-manifest.json'));
    manifest.targets.find(({ targetId }) => targetId === 'token').sourcePath = 'packages/contracts/src/launch/HKMNToken.sol';
    manifest.targets.find(({ targetId }) => targetId === 'hook').initializer.function = 'initializeGraphLaunch(address,uint160)';
    manifest.requiredGraphCalls = derivePhaseThreeGraphCallsFromCompiledAbi(resolve(root, 'release/phase3/artifacts'));
    manifest.postDeployAssertions[0] = 'No graph transaction is signable until the provider can encode token-allocate, custody-bind-hook and hook-initialize-graph-launch in that order.';
    delete manifest.compiler.solcLongVersion;
    writeJson(addressManifestPath, manifest);

    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory: resolve(root, 'release/phase3/artifacts'),
        standardInputDirectory: fixture.standardInputDirectory,
        launchInputsPath,
        addressManifestPath,
        outputDirectory: resolve(directory, 'package-missing-long-version'),
      }),
      'MISSING_PROPERTY',
      '/addressManifest/compiler/solcLongVersion',
    );

    manifest.compiler.solcLongVersion = '0.8.26+commit.8a97fa7a';
    writeJson(addressManifestPath, manifest);

    const result = buildLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath,
      addressManifestPath,
      outputDirectory: resolve(directory, 'package'),
    });
    assert.equal(result.mode, 'address-derivation-pending');

    manifest.requiredGraphCalls[2].selector = '0x00000000';
    writeJson(addressManifestPath, manifest);
    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory: resolve(root, 'release/phase3/artifacts'),
        standardInputDirectory: fixture.standardInputDirectory,
        launchInputsPath,
        addressManifestPath,
        outputDirectory: resolve(directory, 'package-mutated-selector'),
      }),
      'INVALID_VALUE',
      '/addressManifest/requiredGraphCalls/2/selector',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three address-manifest schemas reject graph and target mutations', () => {
  const manifest = readJson(resolve(root, 'release/phase3/address-manifest.json'));
  manifest.targets.find(({ targetId }) => targetId === 'token').sourcePath = 'packages/contracts/src/launch/HKMNToken.sol';
  manifest.targets.find(({ targetId }) => targetId === 'hook').initializer.function = 'initializeGraphLaunch(address,uint160)';
  manifest.compiler.solcLongVersion = '0.8.26+commit.8a97fa7a';
  manifest.requiredGraphCalls = derivePhaseThreeGraphCallsFromCompiledAbi(resolve(root, 'release/phase3/artifacts'));
  manifest.postDeployAssertions[0] = 'No graph transaction is signable until the provider can encode token-allocate, custody-bind-hook and hook-initialize-graph-launch in that order.';
  const schemas = [
    readJson(resolve(root, 'release/phase3/address-manifest.schema.json')),
    readJson(resolve(root, 'release/phase3/address-manifest-draft.schema.json')),
  ];

  for (const schema of schemas) {
    const draftSchema = (() => {
      if (!schema.$defs?.addressDerivationDraft) return schema;
      const { oneOf, ...rootWithoutAlternatives } = schema;
      return { ...rootWithoutAlternatives, ...schema.$defs.addressDerivationDraft };
    })();
    assert.deepEqual(validateJsonSchema(draftSchema, manifest), []);

    const selectorMutation = structuredClone(manifest);
    selectorMutation.requiredGraphCalls[2].selector = '0x00000000';
    assert.ok(
      validateJsonSchema(draftSchema, selectorMutation).some((failure) => failure.includes('/requiredGraphCalls/2/selector')),
    );

    const compilerMutation = structuredClone(manifest);
    compilerMutation.compiler.solcLongVersion = '0.8.26';
    assert.ok(
      validateJsonSchema(draftSchema, compilerMutation).some((failure) => failure.includes('/compiler/solcLongVersion')),
    );

    const targetMutation = structuredClone(manifest);
    targetMutation.targets[0].unexpected = true;
    assert.ok(
      validateJsonSchema(draftSchema, targetMutation).some((failure) => failure.includes('/targets/0/unexpected')),
    );
  }
});

test('standalone draft schema pins each target definition', () => {
  const schema = readJson(resolve(root, 'release/phase3/address-manifest-draft.schema.json'));
  const manifest = readJson(resolve(root, 'release/phase3/address-manifest.json'));

  const sourceMutation = structuredClone(manifest);
  sourceMutation.targets[0].sourcePath = 'packages/contracts/src/fixtures/ResolvedTarget.sol';
  assert.ok(
    validateJsonSchema(schema, sourceMutation).some((failure) => failure.includes('/targets/0/sourcePath')),
  );

  const traversalMutation = structuredClone(manifest);
  traversalMutation.targets[0].sourcePath = 'packages/contracts/src/../launch/HKMNToken.sol';
  assert.ok(
    validateJsonSchema(schema, traversalMutation).some((failure) => failure.includes('/targets/0/sourcePath')),
  );

  const nameMutation = structuredClone(manifest);
  nameMutation.targets[1].contractName = 'ResolvedCustody';
  assert.ok(
    validateJsonSchema(schema, nameMutation).some((failure) => failure.includes('/targets/1/contractName')),
  );

  const constructorMutation = structuredClone(manifest);
  constructorMutation.targets[0].constructor = {};
  assert.ok(
    validateJsonSchema(schema, constructorMutation).some((failure) => failure.includes('/targets/0/constructor')),
  );

  const initializerMutation = structuredClone(manifest);
  delete initializerMutation.targets[2].initializer;
  assert.ok(
    validateJsonSchema(schema, initializerMutation).some((failure) => failure.includes('/targets/2/initializer')),
  );
});

test('phase three address-manifest schema pins provider addresses in EIP-55 form', () => {
  const schema = readJson(resolve(root, 'release/phase3/address-manifest.schema.json'));
  const router = '0x34965F2A2ee9254522232C32F02056E92BE0C98a';
  const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

  assert.deepEqual([
    schema.$defs.launchInputs.properties.chain.properties.authorizedLauncher.const,
    schema.$defs.launchInputs.properties.usdg.const,
    schema.$defs.graphPreimage.properties.authorization.properties.authorizedLauncher.const,
    schema.$defs.preimages.properties.authorizedLauncher.const,
  ], [router, usdg, router, router]);
});

test('phase three normalizers preserve the accepted graph and pin the token deployment source', () => {
  const addressManifest = normalizePhaseThreeAddressManifestDraft(
    readJson(resolve(root, 'release/phase3/address-manifest.json')),
  );
  assert.ok(addressManifest.openFacts.some((fact) => fact.includes('accepted three-call initialization sequence')));
  assert.match(addressManifest.openFacts.join('\n'), /token\.allocate\(hook\)/i);

  const deploymentManifest = readJson(resolve(root, 'release/phase3/deployment-manifest.json'));
  deploymentManifest.deployed.find(({ name }) => name === 'HKMNToken').sourcePath = 'packages/contracts/src/launch/HookemonIssuance.sol';
  assert.equal(
    normalizePhaseThreeDeploymentManifest(deploymentManifest).deployed.find(({ name }) => name === 'HKMNToken').sourcePath,
    'packages/contracts/src/launch/HKMNToken.sol',
  );

  const submission = normalizePhaseThreeSubmissionDraft(readJson(resolve(root, 'release/phase3/submission.json')));
  const submissionText = [
    ...submission.disclosures,
    ...submission.unresolved,
    ...submission.capabilityExtensions.map(({ summary, trustBoundary, failureMode }) => `${summary}\n${trustBoundary}\n${failureMode}`),
  ].join('\n');
  assert.match(submissionText, /exactly three ABI-derived calls/i);
  assert.match(submissionText, /complete 1,000,000,000 HKMN supply.*zero other allocations/i);
  assert.match(submissionText, /FEE-01 records the accepted 10 bps platform share/i);
  assert.match(submissionText, /240 USDG owner seed/i);
});

test('phase three draft retains the owner-recorded revision-65 baseline and provider preimage fact', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-delegated-baseline-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    assert.match(fixture.launchInputs.token.sourceCompatibility.reason, /Requirements revision 65/i);
    assert.match(fixture.launchInputs.token.sourceCompatibility.reason, /owner's 2026-09-05 decision/i);
    assert.match(fixture.launchInputs.token.sourceCompatibility.reason, /complete supply.*zero other allocations/i);
    assert.match(fixture.launchInputs.token.sourceCompatibility.reason, /DRAFT_UNSIGNED/i);
    const evidence = readFileSync(resolve(root, 'release/phase3/EVIDENCE.md'), 'utf8');
    assert.match(evidence, /Requirements revision 65/i);
    assert.match(evidence, /canonical market with zero other allocation/i);
    const launchPlan = readFileSync(resolve(root, 'release/phase3/launch-plan.md'), 'utf8');
    assert.match(launchPlan, /Requirements revision 65/i);
    assert.match(launchPlan, /canonical market.*no other HKMN allocation exists/i);
    assert.match(launchPlan, /DRAFT_UNSIGNED/i);

    const submission = normalizePhaseThreeSubmissionDraft(readJson(resolve(root, 'release/phase3/submission.json')));
    const submissionText = [
      ...submission.disclosures,
      ...submission.capabilityExtensions.map(({ summary }) => summary),
    ].join('\n');
    assert.match(submissionText, /Requirements revision 65/i);
    assert.match(submissionText, /full-pool allocation decision/i);
    assert.match(submissionText, /DRAFT_UNSIGNED/i);

    const graphFact = fixture.launchInputs.openFacts.find((fact) => fact.includes('accepted three-call initialization sequence'));
    assert.ok(graphFact);
    fixture.addressManifest.openFacts.push(graphFact);
    writeJson(fixture.addressManifestPath, fixture.addressManifest);
    const packageDirectory = resolve(directory, 'package');
    buildLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath: fixture.launchInputsPath,
      addressManifestPath: fixture.addressManifestPath,
      outputDirectory: packageDirectory,
    });
    const draft = readJson(resolve(packageDirectory, 'graph-draft.json'));
    assert.equal(draft.openFacts.filter((fact) => fact === graphFact).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three source documents retain the full-pool three-call launch model', () => {
  const source = [
    'release/phase3/PROPOSAL.md',
    'release/phase3/THREAT_MODEL.md',
    'release/phase3/TEST_PLAN.md',
    'release/phase3/EVIDENCE.md',
    'release/phase3/launch-plan.md',
  ].map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n');

  assert.match(source, /exactly three ABI-derived calls/i);
  assert.match(source, /token\.allocate\(hook\)/i);
  assert.match(source, /Requirements revision 65/i);
  assert.match(source, /canonical market/i);
  assert.match(source, /(?:zero other allocation|no other HKMN allocation exists)/i);
  assert.match(source, /(?:240000000.*USDG|240 USDG)/i);
  assert.match(source, /accepted 10 bps platform share/i);
});

test('phase three submission normalization removes builder notes and binds mutable recipient controls', () => {
  const source = readJson(resolve(root, 'release/phase3/submission.json'));
  for (const recipient of source.hook.feeMechanism.recipients) {
    if (recipient.role === 'treasury' || recipient.role === 'process') {
      recipient.mutationController = 'none';
      recipient.newAddressValidation = 'none';
    }
  }
  const submission = normalizePhaseThreeSubmissionDraft(source);
  const providerAddressEnum = 'nonzero-evm-address';

  assert.equal(submission.builder.github, null);
  assert.equal(submission.builder.contact, null);
  assert.equal(Object.hasOwn(submission.builder, 'builderNote'), false);
  for (const recipient of submission.hook.feeMechanism.recipients) {
    if (recipient.role === 'treasury' || recipient.role === 'process') {
      assert.equal(recipient.newAddressValidation, providerAddressEnum);
      assert.equal(recipient.mutationController, 'current-beneficiary-only');
    }
  }
  const launchGraph = submission.capabilityExtensions.find(({ capabilityId }) => capabilityId === 'phase-three-launch-graph');
  assert.deepEqual(launchGraph.evidencePaths.filter((path) => path.endsWith('.json')), [
    'release/phase3/launch-inputs.json',
    'release/phase3/address-manifest.json',
    'release/phase3/address-manifest.schema.json',
    'release/phase3/address-manifest-draft.schema.json',
    'release/phase3/admission/preflight-probe.json',
    'release/phase3/admission/provider-documents.json',
    'release/phase3/admission/route-log.json',
    'release/phase3/fork-pin.json',
    'release/phase3/genesis-evidence.json',
    'release/phase3/graph-gas-evidence.json',
    'release/phase3/launch-inputs.example.json',
    'release/phase3/artifacts/token.json',
    'release/phase3/artifacts/custody.json',
    'release/phase3/artifacts/hook.json',
    'release/phase3/build-info/launch.json',
    'release/phase3/package/graph-draft.json',
    'release/phase3/package/package-manifest.json',
    'release/phase3/deployment-manifest.json',
    'release/phase3/tickmath-vectors.json',
  ]);
});

test('phase three draft package binds unresolved graph inputs without materializing a provider request', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-package-test-'));
  try {
    const packageDirectory = resolve(directory, 'package');
    const fixture = writePhaseThreeDraftFixture(directory);
    const result = buildLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath: fixture.launchInputsPath,
      addressManifestPath: fixture.addressManifestPath,
      outputDirectory: packageDirectory,
    });

    assert.equal(result.mode, 'address-derivation-pending');
    assert.equal(result.createRequestSha256, null);
    assert.equal(Object.hasOwn(result, 'materializedSubmission'), false);
    assert.deepEqual(
      result.unverified.map((entry) => entry.code),
      [
        'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
        'PROVIDER_API_KEY_PENDING',
        'OWNER_WALLET_FUNDING_PENDING',
        'BUILDER_IDENTITY_PENDING',
      ],
    );
    assert.equal(result.unverified[0].blocking, true);
    assert.equal(result.unverified.find(({ code }) => code === 'PROVIDER_API_KEY_PENDING').blocking, false);
    assert.equal(result.unverified.find(({ code }) => code === 'OWNER_WALLET_FUNDING_PENDING').blocking, false);
    assert.equal(result.unverified.find(({ code }) => code === 'BUILDER_IDENTITY_PENDING').blocking, true);
    assert.equal(existsSync(resolve(packageDirectory, 'create-request.json')), false);

    const draft = readJson(resolve(packageDirectory, 'graph-draft.json'));
    assert.equal(draft.status, 'ADDRESS_DERIVATION_PENDING');
    assert.deepEqual(draft.graph.targets.map((target) => target.targetId), ['token', 'custody', 'hook']);
    assert.equal(draft.graph.pool.tickSpacing, 60);
    assert.deepEqual(
      draft.graph.requiredGraphCalls.map(({ callId }) => callId),
      ['token-allocate', 'custody-bind-hook', 'hook-initialize-graph-launch'],
    );
    assert.deepEqual(draft.unverified, result.unverified);
    assert.deepEqual(readJson(resolve(packageDirectory, 'package-manifest.json')).unverified, result.unverified);
    assert.equal(draft.seed.priceCandidates.usdgCurrency0.sqrtPriceX96, '161723809515207654588927258648643645224');

    assertFailure(
      () => verifyLaunchPackage({
        artifactDirectory: resolve(root, 'release/phase3/artifacts'),
        standardInputDirectory: fixture.standardInputDirectory,
        launchInputsPath: fixture.launchInputsPath,
        addressManifestPath: fixture.addressManifestPath,
        packageDirectory,
      }),
      'UNVERIFIED_COMMITMENT',
      '/launchIntentHash',
    );

    const verification = verifyLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath: fixture.launchInputsPath,
      addressManifestPath: fixture.addressManifestPath,
      packageDirectory,
      allowUnverified: true,
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.readyForPreflight, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('materializes the derived price selection into the manifest, graph draft, and submission', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-materialized-selection-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    const candidates = derivePriceCandidates({
      usdgAtomic: fixture.launchInputs.pool.quoteAsset.amountAtomic,
      hkmnAtomic: fixture.launchInputs.pool.baseAsset.amountAtomic,
    });
    for (const name of ['usdgCurrency0', 'hkmnCurrency0']) {
      for (const field of ['sqrtLowerX96', 'sqrtUpperX96', 'consumedAmount0', 'consumedAmount1']) {
        fixture.launchInputs.pool.priceCandidates[name][field] = candidates[name][field];
      }
    }
    const materializedManifest = materializedPriceSelectionFixture(fixture.launchInputs);
    const materialized = materializePhaseThreePriceSelection({
      launchInputs: fixture.launchInputs,
      submission: readJson(resolve(root, 'release/phase3/submission.json')),
      materializedManifest,
    });

    assert.equal(fixture.launchInputs.pool.priceCandidates.selection.status, 'OPEN_FACT');
    assert.equal(fixture.addressManifest.pool.poolId, null);
    assert.equal(materializedManifest.preimages.pool.selectedOrdering, 'hkmnCurrency0');
    assert.equal(
      materializedManifest.preimages.pool.sqrtPriceX96,
      fixture.launchInputs.pool.priceCandidates.hkmnCurrency0.sqrtPriceX96,
    );
    assert.deepEqual(materialized.launchInputs.pool.priceCandidates.selection, {
      status: 'DERIVED',
      rule: fixture.launchInputs.pool.priceCandidates.selection.rule,
      selectedOrdering: 'hkmnCurrency0',
      selectedSqrtPriceX96: fixture.launchInputs.pool.priceCandidates.hkmnCurrency0.sqrtPriceX96,
      poolKey: materializedManifest.preimages.pool.poolKeyEncoded,
      poolId: materializedManifest.preimages.pool.poolId,
    });
    assert.equal(materialized.submission.pool.currency0, 'hkmn');
    assert.equal(materialized.submission.pool.currency1, 'usdg');
    assert.match(materialized.submission.pool.orderingRule, /selectedOrdering=hkmnCurrency0/);
    assert.match(materialized.submission.pool.orderingRule, /selectedSqrtPriceX96=38813714284914462669/);
    for (const quadrant of Object.values(materialized.submission.hook.feeMechanism.swapQuadrants)) {
      assert.equal(quadrant.currency, 'currency1');
    }

    writeJson(fixture.launchInputsPath, materialized.launchInputs);
    const packageDirectory = resolve(directory, 'package');
    buildLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath: fixture.launchInputsPath,
      addressManifestPath: fixture.addressManifestPath,
      outputDirectory: packageDirectory,
    });
    const graphDraft = readJson(resolve(packageDirectory, 'graph-draft.json'));
    assert.deepEqual(
      graphDraft.seed.priceCandidates.selection,
      materialized.launchInputs.pool.priceCandidates.selection,
    );
    assert.deepEqual(graphDraft.graph.pool, fixture.addressManifest.pool);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('builds a materialized phase three graph draft and submission from one public selection flow', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-materialized-package-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    const candidates = derivePriceCandidates({
      usdgAtomic: fixture.launchInputs.pool.quoteAsset.amountAtomic,
      hkmnAtomic: fixture.launchInputs.pool.baseAsset.amountAtomic,
    });
    for (const name of ['usdgCurrency0', 'hkmnCurrency0']) {
      for (const field of ['sqrtLowerX96', 'sqrtUpperX96', 'consumedAmount0', 'consumedAmount1']) {
        fixture.launchInputs.pool.priceCandidates[name][field] = candidates[name][field];
      }
    }
    writeJson(fixture.launchInputsPath, fixture.launchInputs);
    const materializedManifest = materializedPriceSelectionFixture(fixture.launchInputs);
    const packageDirectory = resolve(directory, 'package');
    const phaseThreeMaterialization = {
      materializedManifest,
      submission: readJson(resolve(root, 'release/phase3/submission.json')),
    };

    const result = buildLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath: fixture.launchInputsPath,
      addressManifestPath: fixture.addressManifestPath,
      outputDirectory: packageDirectory,
      phaseThreeMaterialization,
    });

    const graphDraft = readJson(resolve(packageDirectory, 'graph-draft.json'));
    assert.deepEqual(graphDraft.graph.pool, materializedManifest.preimages.pool);
    assert.equal(
      graphDraft.inputDigests.materializedManifestSha256,
      sha256(canonicalJson(materializedManifest)),
    );
    assert.equal(
      graphDraft.inputDigests.submissionSha256,
      sha256(canonicalJson(result.materializedSubmission)),
    );
    assert.equal(graphDraft.seed.priceCandidates.selection.status, 'DERIVED');
    assert.equal(graphDraft.seed.priceCandidates.selection.selectedOrdering, 'hkmnCurrency0');
    assert.equal(
      graphDraft.seed.priceCandidates.selection.selectedSqrtPriceX96,
      materializedManifest.preimages.pool.priceCandidate.sqrtPriceX96,
    );
    assert.equal(result.materializedSubmission.pool.currency0, 'hkmn');
    assert.equal(result.materializedSubmission.pool.currency1, 'usdg');
    assert.match(result.materializedSubmission.pool.orderingRule, /selectedOrdering=hkmnCurrency0/);
    for (const quadrant of Object.values(result.materializedSubmission.hook.feeMechanism.swapQuadrants)) {
      assert.equal(quadrant.currency, 'currency1');
    }
    const verification = verifyLaunchPackage({
      artifactDirectory: resolve(root, 'release/phase3/artifacts'),
      standardInputDirectory: fixture.standardInputDirectory,
      launchInputsPath: fixture.launchInputsPath,
      addressManifestPath: fixture.addressManifestPath,
      packageDirectory,
      phaseThreeMaterialization,
      allowUnverified: true,
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.mode, 'address-derivation-pending');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI materializes one fixed-point selection and writes a separate submission file', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-materialized-cli-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    const candidates = derivePriceCandidates({
      usdgAtomic: fixture.launchInputs.pool.quoteAsset.amountAtomic,
      hkmnAtomic: fixture.launchInputs.pool.baseAsset.amountAtomic,
    });
    for (const name of ['usdgCurrency0', 'hkmnCurrency0']) {
      for (const field of ['sqrtLowerX96', 'sqrtUpperX96', 'consumedAmount0', 'consumedAmount1']) {
        fixture.launchInputs.pool.priceCandidates[name][field] = candidates[name][field];
      }
    }
    writeJson(fixture.launchInputsPath, fixture.launchInputs);
    const materializedManifestPath = resolve(directory, 'materialized-manifest.json');
    const submissionPath = resolve(directory, 'submission.json');
    const materializedSubmissionOutputPath = resolve(directory, 'materialized-submission.json');
    const packageDirectory = resolve(directory, 'package');
    const materializedManifest = materializedPriceSelectionFixture(fixture.launchInputs);
    const sourceSubmission = readJson(resolve(root, 'release/phase3/submission.json'));
    writeJson(materializedManifestPath, materializedManifest);
    writeJson(submissionPath, sourceSubmission);

    const result = spawnSync(process.execPath, [
      buildCli,
      '--artifacts', resolve(root, 'release/phase3/artifacts'),
      '--standard-json-inputs', fixture.standardInputDirectory,
      '--launch-inputs', fixture.launchInputsPath,
      '--address-manifest', fixture.addressManifestPath,
      '--output', packageDirectory,
      '--materialized-manifest', materializedManifestPath,
      '--submission', submissionPath,
      '--materialized-submission-output', materializedSubmissionOutputPath,
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      mode: 'address-derivation-pending',
      fileCount: 3,
      createRequestSha256: null,
      unverified: [
        'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
        'PROVIDER_API_KEY_PENDING',
        'OWNER_WALLET_FUNDING_PENDING',
        'BUILDER_IDENTITY_PENDING',
      ],
      materializedSubmissionOutput: materializedSubmissionOutputPath,
    });
    assert.deepEqual(readJson(submissionPath), sourceSubmission);
    const materializedSubmission = readJson(materializedSubmissionOutputPath);
    assert.equal(materializedSubmission.pool.currency0, 'hkmn');
    assert.equal(materializedSubmission.pool.currency1, 'usdg');
    assert.match(materializedSubmission.pool.orderingRule, /selectedOrdering=hkmnCurrency0/);
    const graphDraft = readJson(resolve(packageDirectory, 'graph-draft.json'));
    assert.equal(graphDraft.seed.priceCandidates.selection.selectedOrdering, 'hkmnCurrency0');
    assert.equal(graphDraft.inputDigests.submissionSha256, sha256(canonicalJson(materializedSubmission)));

    const overwrite = spawnSync(process.execPath, [
      buildCli,
      '--artifacts', resolve(root, 'release/phase3/artifacts'),
      '--standard-json-inputs', fixture.standardInputDirectory,
      '--launch-inputs', fixture.launchInputsPath,
      '--address-manifest', fixture.addressManifestPath,
      '--output', resolve(directory, 'second-package'),
      '--materialized-manifest', materializedManifestPath,
      '--submission', submissionPath,
      '--materialized-submission-output', materializedSubmissionOutputPath,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
    assert.deepEqual(JSON.parse(overwrite.stderr), {
      ok: false,
      code: 'OUTPUT_EXISTS',
      path: '/materializedSubmissionOutputPath',
    });
    assert.equal(existsSync(resolve(directory, 'second-package')), false);
    assert.deepEqual(readJson(materializedSubmissionOutputPath), materializedSubmission);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI rejects incomplete Phase 3 materialization arguments', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-materialized-cli-rejection-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    const result = spawnSync(process.execPath, [
      buildCli,
      '--artifacts', resolve(root, 'release/phase3/artifacts'),
      '--standard-json-inputs', fixture.standardInputDirectory,
      '--launch-inputs', fixture.launchInputsPath,
      '--address-manifest', fixture.addressManifestPath,
      '--output', resolve(directory, 'package'),
      '--materialized-manifest', resolve(directory, 'materialized-manifest.json'),
    ], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      code: 'INVALID_VALUE',
      path: '/phaseThreeMaterialization',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three package rejects a nonzero allocation outside the canonical pool', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-zero-other-allocation-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    fixture.launchInputs.token.allocation.remainderCustody.amountAtomic = '1';
    writeJson(fixture.launchInputsPath, fixture.launchInputs);

    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory: resolve(root, 'release/phase3/artifacts'),
        standardInputDirectory: fixture.standardInputDirectory,
        launchInputsPath: fixture.launchInputsPath,
        addressManifestPath: fixture.addressManifestPath,
        outputDirectory: resolve(directory, 'package'),
      }),
      'INVALID_VALUE',
      '/launchInputs/token/allocation/remainderCustody',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three package rejects Standard JSON evidence with a version field', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-standard-json-test-'));
  try {
    const fixture = writePhaseThreeDraftFixture(directory);
    const standardInputPath = resolve(fixture.standardInputDirectory, 'launch.json');
    const standardInput = readJson(standardInputPath);
    standardInput.version = '0.8.26+commit.8a97fa7a';
    writeJson(standardInputPath, standardInput);

    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory: resolve(root, 'release/phase3/artifacts'),
        standardInputDirectory: fixture.standardInputDirectory,
        launchInputsPath: fixture.launchInputsPath,
        addressManifestPath: fixture.addressManifestPath,
        outputDirectory: resolve(directory, 'package'),
      }),
      'LAUNCH_PROFILE_MISMATCH',
      '/standardInputDirectory/launch.json/version',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three draft rejects incomplete compiler and graph facts', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-package-validation-test-'));
  try {
    const launchInputs = readJson(resolve(root, 'release/phase3/launch-inputs.json'));
    const addressManifest = readJson(resolve(root, 'release/phase3/address-manifest.json'));
    const launchInputsPath = resolve(directory, 'launch-inputs.json');
    const addressManifestPath = resolve(directory, 'address-manifest.json');

    const assertDraftFailure = (mutate, code, path) => {
      const inputs = structuredClone(launchInputs);
      const manifest = structuredClone(addressManifest);
      mutate(manifest, inputs);
      writeJson(launchInputsPath, inputs);
      writeJson(addressManifestPath, manifest);
      assertFailure(
        () => buildLaunchPackage({
          artifactDirectory: resolve(root, 'release/phase3/artifacts'),
          standardInputDirectory: resolve(root, 'release/phase3/build-info'),
          launchInputsPath,
          addressManifestPath,
          outputDirectory: resolve(directory, 'package'),
        }),
        code,
        path,
      );
    };

    assertDraftFailure(
      (manifest) => { manifest.compiler.buildInfo.localBuildInfoCount = 0; },
      'INVALID_VALUE',
      '/addressManifest/compiler/buildInfo/localBuildInfoCount',
    );
    assertDraftFailure(
      (manifest) => { manifest.targets.find(({ targetId }) => targetId === 'custody').constructor.tokenId = 1; },
      'INVALID_VALUE',
      '/addressManifest/targets/1/constructor/tokenId',
    );
    assertDraftFailure(
      (manifest) => { manifest.targets.find(({ targetId }) => targetId === 'token').creationBytecodeHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; },
      'HASH_MISMATCH',
      '/addressManifest/targets/0/creationBytecodeHash',
    );
    assertDraftFailure(
      (manifest) => { manifest.requiredGraphCalls = manifest.requiredGraphCalls.slice(1); },
      'INVALID_VALUE',
      '/addressManifest/requiredGraphCalls',
    );
    assertDraftFailure(
      (_, inputs) => { inputs.roles.usdg = address('f'); },
      'INVALID_VALUE',
      '/launchInputs/roles/usdg',
    );
    assertDraftFailure(
      (_, inputs) => { inputs.roles.launchAuthority = null; },
      'EXPECTED_STRING',
      '/launchInputs/roles/launchAuthority',
    );
    assertDraftFailure(
      (_, inputs) => { inputs.roles.issuanceAuthority = null; },
      'EXPECTED_STRING',
      '/launchInputs/roles/issuanceAuthority',
    );
    assertDraftFailure(
      (manifest) => { manifest.targets.find(({ targetId }) => targetId === 'hook').constructor.launchAuthority = address('f'); },
      'INVALID_VALUE',
      '/addressManifest/targets/2/constructor/launchAuthority',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phase three draft checks compiler evidence directories before rendering a package', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'phase-three-build-evidence-test-'));
  const launchInputsPath = resolve(root, 'release/phase3/launch-inputs.json');
  const addressManifestPath = resolve(root, 'release/phase3/address-manifest.json');
  const artifactDirectory = resolve(root, 'release/phase3/artifacts');
  const buildInfoPath = resolve(root, 'release/phase3/build-info/launch.json');
  try {
    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory: resolve(directory, 'missing-artifacts'),
        standardInputDirectory: resolve(root, 'release/phase3/build-info'),
        launchInputsPath,
        addressManifestPath,
        outputDirectory: resolve(directory, 'package-missing'),
      }),
      'INPUT_READ_FAILED',
      '/artifactDirectory',
    );

    const multipleBuildInfoDirectory = resolve(directory, 'multiple-build-info');
    mkdirSync(multipleBuildInfoDirectory, { recursive: true });
    writeFileSync(resolve(multipleBuildInfoDirectory, 'one.json'), readFileSync(buildInfoPath));
    writeFileSync(resolve(multipleBuildInfoDirectory, 'two.json'), readFileSync(buildInfoPath));
    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory,
        standardInputDirectory: multipleBuildInfoDirectory,
        launchInputsPath,
        addressManifestPath,
        outputDirectory: resolve(directory, 'package-multiple'),
      }),
      'INVALID_VALUE',
      '/standardInputDirectory',
    );

    const manifest = readJson(addressManifestPath);
    manifest.compiler.buildInfo.sourceContentSha256 = zeroHash;
    const mismatchedManifestPath = resolve(directory, 'address-manifest.json');
    writeJson(mismatchedManifestPath, manifest);
    assertFailure(
      () => buildLaunchPackage({
        artifactDirectory,
        standardInputDirectory: resolve(root, 'release/phase3/build-info'),
        launchInputsPath,
        addressManifestPath: mismatchedManifestPath,
        outputDirectory: resolve(directory, 'package-mismatch'),
      }),
      'HASH_MISMATCH',
      '/addressManifest/compiler/buildInfo',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
