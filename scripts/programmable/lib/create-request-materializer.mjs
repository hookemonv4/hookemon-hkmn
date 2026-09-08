import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cloneJson, sha256Bytes } from './canonical-json.mjs';
import { derivePhaseThreeSourceBundleCoverage } from './source-bundle-coverage.mjs';

const CHAIN_ID = '4663';
const CAIP2 = 'eip155:4663';
const REQUEST_SCHEMA_VERSION = 'programmable.custom-launch-create-request.v4';
const GRAPH_SCHEMA_VERSION = 'programmable.custom-graph-bundle.v1';
const FUNDING_SCHEMA_VERSION = 'programmable.custom-launch-funding-intent.v2';
const VERIFICATION_SCHEMA_VERSION = 'programmable.exact-source-verification-bundle.v2';
const LIQUIDITY_SCHEMA_VERSION = 'programmable.custom-launch-liquidity-model.v1';
// Added in provider profile 4.1.0 (profileRevision 2); required by the live schema at
// https://programmable.market/openapi/custom-launch-v4.1.json. Fetched and cross-checked
// against the live GET /v4/chains/4663/capabilities response on 2026-09-06.
const FUNDING_PLAN_SCHEMA_VERSION = 'programmable.robinhood-funding-plan.v1';
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const SOURCE_DESCRIPTOR_SCHEMA_VERSION = '2.0.0';
const SOURCE_DESCRIPTOR_KIND = 'deterministic-source-bundle';
const SOURCE_DESCRIPTOR_KEYS = [
  'schemaVersion',
  'kind',
  'controllerWallet',
  'sourceLineageNonce',
  'sourceBundleDigest',
  'bundleContentSha256',
  'publicOriginCommitment',
];
const SOURCE_BUNDLE_MANIFEST_KEYS = ['schemaVersion', 'entries'];
const SOURCE_BUNDLE_ENTRY_KEYS = ['path', 'kind', 'mode', 'byteLength', 'contentSha256', 'symlinkTarget'];

const TARGETS = [
  { targetId: 'token', artifact: 'token.json' },
  { targetId: 'custody', artifact: 'custody.json' },
  { targetId: 'hook', artifact: 'hook.json' },
];

const INTENTIONAL_NULL_PATHS = new Set([
  '/graphBundle/targets/0/declaredHookPermissions',
  '/graphBundle/targets/1/declaredHookPermissions',
]);

export class RecordedContractValidationError extends Error {
  constructor(message, path = null) {
    super(path === null ? message : `${message} at ${path}`);
    this.name = 'RecordedContractValidationError';
    this.path = path;
  }
}

function fail(message, path = null) {
  throw new RecordedContractValidationError(message, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('JSON input is unavailable', path);
  }
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('expected an object', path);
  return value;
}

function exactKeys(value, keys, path) {
  object(value, path);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('missing required property', `${path}/${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('unexpected property', `${path}/${key}`);
}

function requiredKeys(value, keys, path) {
  object(value, path);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('missing required property', `${path}/${key}`);
}

function requireString(value, path, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) fail('expected a string', path);
  return value;
}

function requireLowercaseBytes32(value, path) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail('expected a lowercase bytes32', path);
  }
  return value;
}

function requireSha256Digest(value, path) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail('expected a sha256 digest', path);
  }
  return value;
}

function requireSourceDescriptorFields(descriptor, path = '/sourceDescriptor') {
  exactKeys(descriptor, SOURCE_DESCRIPTOR_KEYS, path);
  if (descriptor.schemaVersion !== SOURCE_DESCRIPTOR_SCHEMA_VERSION) {
    fail('unexpected source descriptor schema version', `${path}/schemaVersion`);
  }
  if (descriptor.kind !== SOURCE_DESCRIPTOR_KIND) {
    fail('unexpected source descriptor kind', `${path}/kind`);
  }
  requireString(descriptor.controllerWallet, `${path}/controllerWallet`, /^0x[0-9a-f]{40}$/iu);
  requireString(descriptor.sourceLineageNonce, `${path}/sourceLineageNonce`, INTEGER);
  requireLowercaseBytes32(descriptor.sourceBundleDigest, `${path}/sourceBundleDigest`);
  requireSha256Digest(descriptor.bundleContentSha256, `${path}/bundleContentSha256`);
  requireLowercaseBytes32(descriptor.publicOriginCommitment, `${path}/publicOriginCommitment`);
  return descriptor;
}

function requireSourceBundleManifestFields(manifest, path = '/sourceBundleManifest') {
  exactKeys(manifest, SOURCE_BUNDLE_MANIFEST_KEYS, path);
  if (manifest.schemaVersion !== SOURCE_DESCRIPTOR_SCHEMA_VERSION) {
    fail('unexpected source bundle manifest schema version', `${path}/schemaVersion`);
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail('expected nonempty source bundle entries', `${path}/entries`);
  }
  manifest.entries.forEach((entry, index) => {
    const entryPath = `${path}/entries/${index}`;
    exactKeys(entry, SOURCE_BUNDLE_ENTRY_KEYS, entryPath);
    requireString(entry.path, `${entryPath}/path`);
    if (entry.kind !== 'file') fail('unexpected source bundle entry kind', `${entryPath}/kind`);
    if (entry.mode !== '100644') fail('unexpected source bundle entry mode', `${entryPath}/mode`);
    requireString(entry.byteLength, `${entryPath}/byteLength`, INTEGER);
    requireSha256Digest(entry.contentSha256, `${entryPath}/contentSha256`);
    if (entry.symlinkTarget !== null) fail('unexpected source bundle symlink target', `${entryPath}/symlinkTarget`);
  });
  return manifest;
}

/**
 * Builds the descriptor shape that reached the provider's source-manifest
 * digest check. It deliberately accepts caller-supplied digests because the
 * provider's digest preimage is still an open fact.
 */
export function buildV4SourceDescriptor({
  controllerWallet,
  sourceLineageNonce,
  sourceBundleDigest,
  bundleContentSha256,
  publicOriginCommitment,
} = {}) {
  return requireSourceDescriptorFields({
    schemaVersion: SOURCE_DESCRIPTOR_SCHEMA_VERSION,
    kind: SOURCE_DESCRIPTOR_KIND,
    controllerWallet,
    sourceLineageNonce,
    sourceBundleDigest,
    bundleContentSha256,
    publicOriginCommitment,
  });
}

/**
 * Builds the file-entry manifest shape that the provider parsed before its
 * source-descriptor digest check. The digest binding remains unresolved.
 */
export function buildV4SourceBundleManifest(entries) {
  return requireSourceBundleManifestFields({
    schemaVersion: SOURCE_DESCRIPTOR_SCHEMA_VERSION,
    entries: cloneJson(entries),
  });
}

function artifactBytecode(root, artifactName) {
  const artifact = readJson(resolve(root, 'release/phase3/artifacts', artifactName));
  const bytecode = typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object;
  if (typeof bytecode !== 'string' || !/^0x(?:[0-9a-f]{2})+$/iu.test(bytecode)) {
    fail('artifact does not contain creation bytecode', `/release/phase3/artifacts/${artifactName}/bytecode`);
  }
  return bytecode;
}

function sourcePathFor(target) {
  return target.sourcePath;
}

function contractNameFor(target) {
  return target.contractName;
}

function addressWord(value, path) {
  requireString(value, path, /^0x[0-9a-f]{40}$/iu);
  return value.slice(2).toLowerCase().padStart(64, '0');
}

function uint256Word(value, path) {
  if (!Number.isInteger(value) || value < 0) fail('expected a non-negative integer', path);
  return BigInt(value).toString(16).padStart(64, '0');
}

/**
 * Validates the provider nonce field shape confirmed by the preflight error.
 * The provider has not documented a derivation from an EVM account nonce.
 */
export function normalizeV4PreflightNonce(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail('expected a nonzero lowercase bytes32 value', '/nonce');
  }
  const nonce = BigInt(value);
  if (nonce === 0n) fail('expected a nonzero bytes32 value', '/nonce');
  return value;
}

function constructorArguments(target) {
  if (target.targetId !== 'custody') return null;
  return `0x${addressWord(target.constructor?.manager, '/targets/custody/constructor/manager')}${uint256Word(target.constructor?.tokenId, '/targets/custody/constructor/tokenId')}`;
}

function constructorAddressLocators(target) {
  return target.targetId === 'custody' ? [] : null;
}

function targetTemplate(target, artifactName, root) {
  return {
    targetId: target.targetId,
    applicantSalt: target.applicantSalt,
    creationBytecode: artifactBytecode(root, artifactName),
    constructorArguments: constructorArguments(target),
    initializerCalldata: target.targetId === 'hook' ? target.initializer?.calldata : target.initializerCalldata,
    constructorAddressLocators: constructorAddressLocators(target),
    initializerAddressLocators: null,
    deploymentValueWei: target.deploymentValue?.amountAtomic,
    initializerValueWei: target.initializerValue?.amountAtomic,
    expectedRuntimeCodeHash: target.runtimeCodeHash,
    componentKind: target.componentKind,
    declaredHookPermissions: target.componentKind === 'hook' ? cloneJson(target.declaredHookPermissions) : null,
  };
}

function verificationComponent(target) {
  return {
    targetId: target.targetId,
    compilationUnitId: 'phase3-launch',
    sourcePath: sourcePathFor(target),
    contractName: contractNameFor(target),
    constructorArguments: constructorArguments(target),
    runtimeMaterialization: null,
  };
}

function resolveTarget(addressManifest, targetId) {
  const target = addressManifest.targets?.find((candidate) => candidate?.targetId === targetId);
  if (target === undefined) fail('address manifest target is unavailable', `/targets/${targetId}`);
  return target;
}

function validateGraphDraft(graphDraft, targets) {
  if (!['hookemon.phase3.graph-draft.v1', 'hookemon.phase3.graph-draft.v2'].includes(graphDraft?.schemaVersion)) fail('graph draft is unavailable', '/package/graph-draft.json/schemaVersion');
  const graphTargets = graphDraft?.graph?.targets;
  if (!Array.isArray(graphTargets)) fail('graph draft targets are unavailable', '/package/graph-draft.json/graph/targets');
  const targetIds = targets.map(({ target }) => target.targetId);
  if (JSON.stringify(graphTargets.map(({ targetId }) => targetId)) !== JSON.stringify(targetIds)) {
    fail('graph draft target order does not match the address manifest', '/package/graph-draft.json/graph/targets');
  }
  for (const { target } of targets) {
    const graphTarget = graphTargets.find(({ targetId }) => targetId === target.targetId);
    if (graphTarget?.sourcePath !== target.sourcePath || graphTarget?.contractName !== target.contractName) {
      fail('graph draft target identity does not match the address manifest', `/package/graph-draft.json/graph/targets/${target.targetId}`);
    }
  }
}

function providerProfile(providerDocuments) {
  const profile = providerDocuments?.capabilities?.profile;
  if (profile === null || typeof profile !== 'object') fail('provider profile is unavailable', '/capabilities/profile');
  return cloneJson(profile);
}

function ownerLaunchWallet(ownerInputs) {
  return requireString(ownerInputs?.launchWallet?.address, '/launchWallet');
}

function contractRequired(contract) {
  if (!Array.isArray(contract?.required) || contract.required.length === 0) fail('recorded request contract is missing required fields', '/v4RequestContract/required');
  return contract.required;
}

function nullPaths(value, path = '') {
  if (value === null) return [path || '/'];
  if (Array.isArray(value)) return value.flatMap((entry, index) => nullPaths(entry, `${path}/${index}`));
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => nullPaths(entry, `${path}/${key}`));
  return [];
}

/**
 * Validates only the schema information retained in provider-documents.json.
 * It accepts null template leaves because that retained contract has no
 * nullability branch; callers must reject unresolved paths before a POST.
 */
export function validateRecordedV4RequestTemplate(request, contract) {
  const required = contractRequired(contract);
  exactKeys(request, required, '');
  if (contract.additionalProperties !== false) fail('recorded request contract must forbid additional properties', '/v4RequestContract/additionalProperties');
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION) fail('unexpected schema version', '/schemaVersion');
  if (request.chainId !== CHAIN_ID) fail('unexpected chain ID', '/chainId');
  if (request.caip2 !== CAIP2) fail('unexpected CAIP-2 chain', '/caip2');
  if (request.nonce !== null && contract?.nonce?.format === 'lowercase-bytes32') {
    requireLowercaseBytes32(request.nonce, '/nonce');
    if (contract.nonce.nonzero === true && request.nonce === `0x${'0'.repeat(64)}`) {
      fail('expected a nonzero lowercase bytes32', '/nonce');
    }
  }
  if (request.sourceDescriptor !== null && contract?.sourceDescriptor?.type === 'object') {
    const path = '/sourceDescriptor';
    const descriptor = object(request.sourceDescriptor, path);
    if (Array.isArray(contract.sourceDescriptor.required)) {
      exactKeys(descriptor, contract.sourceDescriptor.required, path);
    }
    requireSourceDescriptorFields(descriptor, path);
  }
  if (request.sourceBundleManifest !== null && contract?.sourceBundleManifest?.type === 'object') {
    const path = '/sourceBundleManifest';
    const manifest = object(request.sourceBundleManifest, path);
    if (Array.isArray(contract.sourceBundleManifest.required)) {
      exactKeys(manifest, contract.sourceBundleManifest.required, path);
    }
    requireSourceBundleManifestFields(manifest, path);
  }

  if (request.profile !== null && request.profile?.schemaVersion !== 'programmable.custom-launch-profile-ref.v4') {
    fail('unexpected profile schema version', '/profile/schemaVersion');
  }
  if (request.graphBundle !== null && request.graphBundle?.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    fail('unexpected graph schema version', '/graphBundle/schemaVersion');
  }
  if (request.funding !== null) {
    exactKeys(request.funding, ['schemaVersion', 'mode', 'valueWei'], '/funding');
    if (request.funding.schemaVersion !== contract?.funding?.schemaVersion || request.funding.schemaVersion !== FUNDING_SCHEMA_VERSION) {
      fail('unexpected funding schema version', '/funding/schemaVersion');
    }
    if (!Array.isArray(contract?.funding?.mode) || !contract.funding.mode.includes(request.funding.mode)) {
      fail('funding mode is not recorded', '/funding/mode');
    }
    requireString(request.funding.valueWei, '/funding/valueWei', INTEGER);
  }
  if (request.externalContracts !== null) {
    if (!Array.isArray(request.externalContracts)) fail('expected an array', '/externalContracts');
    const externalContractRequired = contract?.externalContract?.required;
    if (Array.isArray(externalContractRequired)) {
      request.externalContracts.forEach((externalContract, index) => {
        requiredKeys(externalContract, externalContractRequired, `/externalContracts/${index}`);
      });
    }
  }
  if (request.verificationBundle !== null) {
    if (request.verificationBundle?.schemaVersion !== contract?.verificationBundle?.schemaVersion) {
      fail('unexpected verification bundle schema version', '/verificationBundle/schemaVersion');
    }
    if (!Array.isArray(request.verificationBundle.compilationUnits)) {
      fail('expected an array', '/verificationBundle/compilationUnits');
    }
    if (!Array.isArray(request.verificationBundle.components)) {
      fail('expected an array', '/verificationBundle/components');
    }
    const compilationUnitRequired = contract?.verificationBundle?.compilationUnitRequired;
    if (Array.isArray(compilationUnitRequired)) {
      request.verificationBundle.compilationUnits.forEach((unit, index) => {
        requiredKeys(unit, compilationUnitRequired, `/verificationBundle/compilationUnits/${index}`);
      });
    }
    const componentRequired = contract?.verificationBundle?.componentRequired;
    if (Array.isArray(componentRequired)) {
      request.verificationBundle.components.forEach((component, index) => {
        requiredKeys(component, componentRequired, `/verificationBundle/components/${index}`);
      });
    }
  }
  if (request.liquidityModel !== null) {
    if (request.liquidityModel.schemaVersion !== LIQUIDITY_SCHEMA_VERSION) {
      fail('unexpected liquidity model schema version', '/liquidityModel/schemaVersion');
    }
    if (
      Array.isArray(contract?.liquidityModel?.model)
      && !contract.liquidityModel.model.includes(request.liquidityModel.model)
    ) {
      fail('liquidity model is not recorded', '/liquidityModel/model');
    }
    if (
      request.liquidityModel.declaredLaunchState !== null
      && Array.isArray(contract?.liquidityModel?.declaredLaunchState)
      && !contract.liquidityModel.declaredLaunchState.includes(request.liquidityModel.declaredLaunchState)
    ) {
      fail('declared launch state is not recorded', '/liquidityModel/declaredLaunchState');
    }
  }
  if (request.fundingPlan !== null) {
    const path = '/fundingPlan';
    const plan = object(request.fundingPlan, path);
    exactKeys(plan, [
      'schemaVersion', 'capitalSource', 'pricingModel', 'nativeAllocations',
      'maxLaunchValueWei', 'maxGasCostWei', 'launchMode',
    ], path);
    if (plan.schemaVersion !== FUNDING_PLAN_SCHEMA_VERSION) {
      fail('unexpected funding plan schema version', `${path}/schemaVersion`);
    }
    if (Array.isArray(contract?.fundingPlan?.capitalSource) && !contract.fundingPlan.capitalSource.includes(plan.capitalSource)) {
      fail('funding plan capital source is not recorded', `${path}/capitalSource`);
    }
    if (Array.isArray(contract?.fundingPlan?.pricingModel) && !contract.fundingPlan.pricingModel.includes(plan.pricingModel)) {
      fail('funding plan pricing model is not recorded', `${path}/pricingModel`);
    }
    if (Array.isArray(contract?.fundingPlan?.launchMode) && !contract.fundingPlan.launchMode.includes(plan.launchMode)) {
      fail('funding plan launch mode is not recorded', `${path}/launchMode`);
    }
    exactKeys(plan.nativeAllocations, ['initialLiquidityWei', 'initialBuyWei', 'reserveWei', 'otherLaunchValueWei'], `${path}/nativeAllocations`);
    for (const key of ['initialLiquidityWei', 'initialBuyWei', 'reserveWei', 'otherLaunchValueWei']) {
      requireString(plan.nativeAllocations[key], `${path}/nativeAllocations/${key}`, INTEGER);
    }
    requireString(plan.maxLaunchValueWei, `${path}/maxLaunchValueWei`, INTEGER);
    requireString(plan.maxGasCostWei, `${path}/maxGasCostWei`, INTEGER);
    if (plan.launchMode === 'fund-and-launch' && plan.nativeAllocations.initialBuyWei === '0') {
      fail('fund-and-launch requires a nonzero initial buy', `${path}/nativeAllocations/initialBuyWei`);
    }
  }
  if (Object.hasOwn(request, 'platformFeeConfiguration')) fail('platform fee configuration is not permitted', '/platformFeeConfiguration');
  return request;
}

export function unresolvedV4RequestPaths(request) {
  return nullPaths(request).filter((path) => !INTENTIONAL_NULL_PATHS.has(path));
}

/**
 * Produces the committed-evidence request template for the address-derivation
 * state. It keeps every unsupported value null instead of inventing a graph,
 * source commitment, or launch attestation.
 */
export function materializePhaseThreeCreateRequest({ root, graphDraft: suppliedGraphDraft } = {}) {
  const releaseRoot = resolve(root ?? '.');
  const providerDocuments = readJson(resolve(releaseRoot, 'release/phase3/admission/provider-documents.json'));
  const ownerInputs = readJson(resolve(releaseRoot, 'decisions/owner-inputs/launch-inputs-owner.json'));
  const addressManifest = readJson(resolve(releaseRoot, 'release/phase3/address-manifest.json'));
  const buildInfoPath = resolve(releaseRoot, 'release/phase3/build-info/launch.json');
  const buildInfoBytes = readFileSync(buildInfoPath);
  const buildInfo = readJson(buildInfoPath);
  const targets = TARGETS.map(({ targetId, artifact }) => ({
    target: resolveTarget(addressManifest, targetId),
    artifact,
  }));
  const graphDraft = suppliedGraphDraft ?? readJson(resolve(releaseRoot, 'release/phase3/package/graph-draft.json'));
  validateGraphDraft(graphDraft, targets);
  const contract = providerDocuments.v4RequestContract;

  const request = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    chainId: CHAIN_ID,
    caip2: CAIP2,
    chainDeployment: providerDocuments.capabilities?.chainDeployment ?? null,
    chainDeploymentDescriptorDigest: providerDocuments.capabilities?.chainDeploymentDescriptorDigest ?? null,
    profile: providerProfile(providerDocuments),
    launchWallet: ownerLaunchWallet(ownerInputs),
    nonce: null,
    permitWindow: { validAfter: null, deadline: null },
    sourceDescriptor: null,
    sourceBundleManifest: null,
    externalContracts: null,
    graphBundle: {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      sourceBundleSha256: null,
      targets: targets.map(({ target, artifact }) => targetTemplate(target, artifact, releaseRoot)),
      pool: {
        tokenTargetId: 'token',
        hookTargetId: 'hook',
        fee: addressManifest.pool?.fee,
        tickSpacing: addressManifest.pool?.tickSpacing,
      },
    },
    projectMetadata: null,
    projectMetadataHash: null,
    projectMetadataImageArtifact: null,
    verificationBundle: {
      schemaVersion: VERIFICATION_SCHEMA_VERSION,
      compilationUnits: [{
        compilationUnitId: 'phase3-launch',
        compilerVersion: buildInfo?.compiler?.version ?? addressManifest.compiler?.solcLongVersion ?? null,
        standardJsonInputBase64: buildInfoBytes.toString('base64'),
        standardJsonInputSha256: sha256Bytes(buildInfoBytes),
      }],
      components: targets.map(({ target }) => verificationComponent(target)),
    },
    funding: {
      schemaVersion: FUNDING_SCHEMA_VERSION,
      mode: 'none',
      valueWei: '0',
    },
    liquidityModel: {
      schemaVersion: LIQUIDITY_SCHEMA_VERSION,
      model: 'project-provided-liquidity',
      declaredLaunchState: null,
      targetIds: targets.map(({ target }) => target.targetId),
    },
    // Required since profile 4.1.0; value depends on an unresolved fund-and-launch decision (findings.md LIH-01).
    fundingPlan: null,
    launchIntentHash: null,
    agentAttestation: null,
  };

  validateRecordedV4RequestTemplate(request, contract);
  return {
    request,
    unresolvedPaths: unresolvedV4RequestPaths(request),
    sourceBundleCoverage: derivePhaseThreeSourceBundleCoverage({ root: releaseRoot }),
  };
}
