import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  canonicalJson,
  cloneJson,
  sha256Bytes,
  sha256CanonicalJson,
  stableJsonBytes,
} from './canonical-json.mjs';
import { keccak256Hex } from './keccak.mjs';
import {
  artifactHashes,
  derivePriceCandidates,
  PHASE_THREE_FACTORY,
  PHASE_THREE_SOLC_LONG_VERSION,
  PHASE_THREE_SOLC_VERSION,
  sourceContentCommitment,
} from './phase3-release.mjs';

const REQUEST_KEYS = [
  'schemaVersion',
  'chainId',
  'caip2',
  'chainDeployment',
  'chainDeploymentDescriptorDigest',
  'profile',
  'launchWallet',
  'nonce',
  'permitWindow',
  'sourceDescriptor',
  'sourceBundleManifest',
  'externalContracts',
  'graphBundle',
  'projectMetadata',
  'projectMetadataHash',
  'projectMetadataImageArtifact',
  'verificationBundle',
  'funding',
  'liquidityModel',
  'launchIntentHash',
  'agentAttestation',
];
const TARGET_KEYS = [
  'targetId',
  'applicantSalt',
  'creationBytecode',
  'constructorArguments',
  'initializerCalldata',
  'constructorAddressLocators',
  'initializerAddressLocators',
  'deploymentValueWei',
  'initializerValueWei',
  'expectedRuntimeCodeHash',
  'componentKind',
  'declaredHookPermissions',
];
const LOCAL_TARGET_KEYS = [
  'targetId',
  'artifactPath',
  'standardJsonInputPath',
  'compilationUnitId',
  'sourcePath',
  'contractName',
  'constructorArguments',
  'initializerCalldata',
  'constructorAddressLocators',
  'initializerAddressLocators',
  'deploymentValueWei',
  'initializerValueWei',
  'componentKind',
  'declaredHookPermissions',
  'runtimeImmutables',
];
const FUNDING_MODES = new Set(['none', 'wallet-transaction-value']);
const LIQUIDITY_MODELS = new Set([
  'none-empty-pool',
  'project-provided-liquidity',
  'hook-owned-liquidity',
  'externally-managed-position',
  'custom-bonding-or-curve',
]);
const LAUNCH_STATES = new Set([
  'pool-not-initialized',
  'pool-initialized-empty',
  'liquidity-required',
  'liquidity-provided-by-launch',
  'custom-settlement',
]);
const COMPONENT_KINDS = new Set(['token', 'hook', 'other']);
const HOOK_PERMISSIONS = new Set([
  'beforeInitialize',
  'afterInitialize',
  'beforeAddLiquidity',
  'afterAddLiquidity',
  'beforeRemoveLiquidity',
  'afterRemoveLiquidity',
  'beforeSwap',
  'afterSwap',
  'beforeDonate',
  'afterDonate',
  'beforeSwapReturnDelta',
  'afterSwapReturnDelta',
  'afterAddLiquidityReturnDelta',
  'afterRemoveLiquidityReturnDelta',
]);
const ZERO_SHA256 = `sha256:${'0'.repeat(64)}`;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;
const HEX_NONEMPTY = /^0x(?:[0-9a-f]{2})+$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASE_THREE_GRAPH_CALLS = [
  {
    callId: 'token-allocate',
    targetId: 'token',
    name: 'allocate',
    inputTypes: ['address'],
    caller: 'graph factory',
    argumentBindings: ['resolved HookemonHook address'],
    reason: 'The graph factory allocates the fixed supply after all target addresses are resolved.',
  },
  {
    callId: 'custody-bind-hook',
    targetId: 'custody',
    name: 'configureBindingHook',
    inputTypes: ['address'],
    caller: 'graph factory',
    argumentBindings: ['resolved HookemonHook address'],
    reason: 'The custody binds the resolved hook before the launch graph is initialized.',
  },
  {
    callId: 'hook-initialize-graph-launch',
    targetId: 'hook',
    name: 'initializeGraphLaunch',
    inputTypes: ['address', 'uint160'],
    caller: 'graph factory as graph initializer',
    argumentBindings: ['resolved PermanentPositionCustody address', 'selected address-order sqrtPriceX96 candidate'],
    reason: 'The graph initializer binds custody and initializes the canonical pool in one source-authorized call.',
  },
];
const PHASE_THREE_PROVIDER_ADDRESS_ENUM = 'nonzero-evm-address';
const PHASE_THREE_PRICE_CANDIDATE_ORDERINGS = ['usdgCurrency0', 'hkmnCurrency0'];
export const PHASE_THREE_TOKEN_SOURCE_PATH = 'packages/contracts/src/launch/HKMNToken.sol';
export const PHASE_THREE_GRAPH_OPEN_FACT = 'Missing: provider-supplied encoded preimage for the accepted three-call initialization sequence token.allocate(hook), custody.configureBindingHook(hook), and hook.initializeGraphLaunch(custody,sqrtPriceX96). Resolve: obtain the route namespace, route nonce, topology hash, target-id hashes, and serialized provider graph call data. Verified alternative: retain no encoded call data, target addresses, or signing payload.';
const PHASE_THREE_RELEASE_GRAPH_EVIDENCE_PATHS = [
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
  'release/phase3/launch-plan.md',
  'release/phase3/artifacts/token.json',
  'release/phase3/artifacts/custody.json',
  'release/phase3/artifacts/hook.json',
  'release/phase3/build-info/launch.json',
  'release/phase3/package/graph-draft.json',
  'release/phase3/package/package-manifest.json',
  'release/phase3/deployment-manifest.json',
  'release/phase3/tickmath-vectors.json',
];
const PHASE_THREE_DRAFT_README = `# Phase 3 draft package

This directory is a content-addressed draft for provider preflight. It is committed so review can bind the exact launch inputs, compiler evidence, target order, and unresolved provider facts that produced the package. It is not a signable provider request while address derivation remains pending.
`;

export class PackageValidationError extends Error {
  constructor(code, path) {
    super(`${code} at ${path}`);
    this.name = 'PackageValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path) {
  throw new PackageValidationError(code, path);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('EXPECTED_OBJECT', path);
  return value;
}

function assertArray(value, path) {
  if (!Array.isArray(value)) fail('EXPECTED_ARRAY', path);
  return value;
}

function assertExactKeys(value, keys, path) {
  assertObject(value, path);
  for (const key of keys) if (!hasOwn(value, key)) fail('MISSING_PROPERTY', `${path}/${key}`);
  for (const key of Object.keys(value).sort()) if (!keys.includes(key)) fail('UNEXPECTED_PROPERTY', `${path}/${key}`);
}

function assertString(value, path, pattern = null) {
  if (typeof value !== 'string') fail('EXPECTED_STRING', path);
  if (pattern && !pattern.test(value)) fail('INVALID_VALUE', path);
  return value;
}

function assertInteger(value, path, { minimum = null, maximum = null } = {}) {
  if (!Number.isInteger(value)) fail('EXPECTED_INTEGER', path);
  if (minimum !== null && value < minimum) fail('INVALID_VALUE', path);
  if (maximum !== null && value > maximum) fail('INVALID_VALUE', path);
  return value;
}

function assertHash(value, path) {
  return assertString(value, path, SHA256);
}

function assertHex32(value, path, { nonzero = false } = {}) {
  assertString(value, path, HEX32);
  if (nonzero && /^0x0{64}$/.test(value)) fail('INVALID_VALUE', path);
  return value;
}

function assertAddress(value, path) {
  return assertString(value, path, ADDRESS);
}

function assertExactAddress(value, expected, path) {
  assertAddress(value, path);
  if (value !== expected) fail('INVALID_VALUE', path);
}

function assertAmount(value, path) {
  return assertString(value, path, INTEGER);
}

function assertIdentifier(value, path) {
  return assertString(value, path, ID);
}

function assertHex(value, path, { nonempty = false } = {}) {
  return assertString(value, path, nonempty ? HEX_NONEMPTY : HEX);
}

function assertBase64(value, path) {
  assertString(value, path);
  if (value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('INVALID_VALUE', path);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('INVALID_VALUE', path);
  return bytes;
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function readJsonFile(path, pointer) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail('INPUT_READ_FAILED', pointer);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    fail('INVALID_JSON', pointer);
  }
}

function assertDirectory(path, pointer) {
  try {
    if (!lstatSync(path).isDirectory()) fail('EXPECTED_DIRECTORY', pointer);
  } catch (error) {
    if (error instanceof PackageValidationError) throw error;
    fail('INPUT_READ_FAILED', pointer);
  }
}

export function derivePhaseThreeGraphCallsFromCompiledAbi(artifactDirectory) {
  assertDirectory(artifactDirectory, '/artifactDirectory');
  return PHASE_THREE_GRAPH_CALLS.map((definition) => {
    const artifactPath = resolve(artifactDirectory, `${definition.targetId}.json`);
    const { value: artifact } = readJsonFile(artifactPath, `/artifactDirectory/${definition.targetId}.json`);
    const abi = assertArray(artifact.abi, `/artifactDirectory/${definition.targetId}.json/abi`);
    const entry = abi.find((candidate) => (
      candidate?.type === 'function'
      && candidate.name === definition.name
      && Array.isArray(candidate.inputs)
      && candidate.inputs.map(({ type }) => type).join(',') === definition.inputTypes.join(',')
    ));
    if (!entry) fail('MISSING_PACKAGE_FILE', `/artifactDirectory/${definition.targetId}.json/abi`);
    const signature = `${entry.name}(${entry.inputs.map(({ type }) => type).join(',')})`;
    const selector = keccak256Hex(Buffer.from(signature, 'utf8')).slice(0, 10);
    const methodIdentifier = artifact?.methodIdentifiers?.[signature];
    if (methodIdentifier !== selector.slice(2)) fail('HASH_MISMATCH', `/artifactDirectory/${definition.targetId}.json/methodIdentifiers/${signature}`);
    return {
      callId: definition.callId,
      targetId: definition.targetId,
      function: signature,
      selector,
      caller: definition.caller,
      argumentBindings: definition.argumentBindings,
      calldata: null,
      reason: definition.reason,
    };
  });
}

function isRetiredPhaseThreeGraphFact(value) {
  return /\bfour(?:-| )calls?\b/i.test(value)
    || /two on HookemonHook/i.test(value)
    || /token\.allocate\(hook,custody\)/i.test(value);
}

export function normalizePhaseThreeAddressManifestDraft(addressManifest) {
  const normalized = cloneJson(addressManifest);
  const facts = assertArray(normalized.openFacts, '/addressManifest/openFacts');
  normalized.openFacts = [
    PHASE_THREE_GRAPH_OPEN_FACT,
    ...facts.filter((fact, index) => {
      const text = assertString(fact, `/addressManifest/openFacts/${index}`);
      return text !== PHASE_THREE_GRAPH_OPEN_FACT && !isRetiredPhaseThreeGraphFact(text);
    }),
  ];
  return normalized;
}

export function normalizePhaseThreeDeploymentManifest(deploymentManifest) {
  const normalized = cloneJson(deploymentManifest);
  const deployed = assertArray(normalized.deployed, '/deploymentManifest/deployed');
  const token = deployed.find((target) => target?.name === 'HKMNToken');
  if (!token) fail('MISSING_PROPERTY', '/deploymentManifest/deployed/HKMNToken');
  assertObject(token, '/deploymentManifest/deployed/HKMNToken');
  token.sourcePath = PHASE_THREE_TOKEN_SOURCE_PATH;
  return normalized;
}

function normalizePhaseThreeSubmissionDisclosure(value) {
  if (/FEE-01 provider acceptance remains an open fact/i.test(value)) {
    return 'FEE-01 records the accepted 10 bps platform share confirmed with the owner on 2026-09-04.';
  }
  if (/Permit2 funding route for the 150 USDG owner seed/i.test(value)) {
    return 'The retained provider material does not establish an ERC-20 Permit2 funding route for the 240 USDG owner seed.';
  }
  if (/current HKMN source supply differs|Requirements revision [0-9]+ fixes a 1,000,000,000 HKMN supply|Revision [0-9]+ records the coordinator-selected 1,000,000,000 HKMN supply baseline/i.test(value)) {
    return "Requirements revision 65 records the owner's 2026-09-05 decision: the complete 1,000,000,000 HKMN supply is allocated to the canonical market, with zero other allocations. The DRAFT_UNSIGNED baseline records subject hashes and is not transaction authorization.";
  }
  if (/source-required graph needs four calls|The executable graph requires exactly three ABI-derived calls/i.test(value)) {
    return 'The executable graph requires exactly three ABI-derived calls in token, custody, hook order: token.allocate(hook), custody.configureBindingHook(hook), and hook.initializeGraphLaunch(custody,sqrtPriceX96). Provider-supplied encoding must bind their selectors, targets, arguments, and order before graph calldata can exist.';
  }
  if (/owner-requested two-transaction model is not authoritative|Requirements revision [0-9]+ authorizes separate graph deployment|Revision [0-9]+ describes separate graph deployment/i.test(value)) {
    return 'Requirements revision 65 describes separate graph deployment and owner seed transactions; it does not authorize either. Provider preimage fields, graph calldata, and preflight evidence remain required before either transaction is signed.';
  }
  if (/No checked-in compiler build-info path or exact Standard JSON input exists/i.test(value)) {
    return 'The checked-in launch profile binds one bare Standard JSON input and the full 0.8.26+commit.8a97fa7a compiler version. It remains template evidence until provider route fields materialize the graph.';
  }
  if (/source splits the combined 290 bps project policy share/i.test(value)) {
    return 'The source splits the combined 290 bps project policy share into 40 bps treasury and 250 bps process liabilities. The complete HKMN supply is allocated to the canonical market; permanent custody holds only the v4 position.';
  }
  return value;
}

function normalizePhaseThreeSubmissionUnresolved(value) {
  if (/source-required four calls|Provider graph encoding decision/i.test(value)) {
    return 'Provider graph preimage: route namespace, route nonce, topology hash, target-id hashes, and serialized calls for token.allocate(hook), custody.configureBindingHook(hook), and hook.initializeGraphLaunch(custody,sqrtPriceX96).';
  }
  return value;
}

export function normalizePhaseThreeSubmissionDraft(submission) {
  const normalized = cloneJson(submission);
  const builder = assertObject(normalized.builder, '/submission/builder');
  builder.github = null;
  builder.contact = null;
  delete builder.builderNote;
  const recipients = assertArray(normalized?.hook?.feeMechanism?.recipients, '/submission/hook/feeMechanism/recipients');
  for (const recipient of recipients) {
    if (recipient?.role === 'treasury' || recipient?.role === 'process') {
      recipient.mutationController = 'current-beneficiary-only';
      recipient.newAddressValidation = PHASE_THREE_PROVIDER_ADDRESS_ENUM;
    }
  }
  const extensions = assertArray(normalized.capabilityExtensions, '/submission/capabilityExtensions');
  const launchGraph = extensions.find((extension) => extension?.capabilityId === 'phase-three-launch-graph');
  if (!launchGraph) fail('MISSING_PROPERTY', '/submission/capabilityExtensions/phase-three-launch-graph');
  launchGraph.evidencePaths = cloneJson(PHASE_THREE_RELEASE_GRAPH_EVIDENCE_PATHS);
  launchGraph.summary = "Requirements revision 65 records the owner's 2026-09-05 full-pool allocation decision and the accepted 10 bps platform share. Provider preimage fields, salts, and materialized constructor values remain unresolved in the address-derivation-pending three-call graph.";
  launchGraph.trustBoundary = 'The package binds local facts and the recorded provider acceptance, but does not establish deployment authorization or a signing-ready calldata payload.';
  launchGraph.failureMode = 'A missing provider encoding, route field, or source-configuration match must stop the proposed seed path and require a new reviewed graph.';
  const launchLifecycle = assertObject(normalized.launchLifecycle, '/submission/launchLifecycle');
  const tokenCreation = assertObject(launchLifecycle.tokenCreation, '/submission/launchLifecycle/tokenCreation');
  const liquidityFormation = assertObject(launchLifecycle.liquidityFormation, '/submission/launchLifecycle/liquidityFormation');
  const initialTransaction = assertObject(launchLifecycle.initialTransaction, '/submission/launchLifecycle/initialTransaction');
  tokenCreation.valueFlow = 'The proposed graph creates the HKMN target and allocates the complete supply to the resolved canonical-market hook before the owner seed.';
  tokenCreation.custody = 'The hook receives the complete HKMN supply for exact full-range seeding; permanent custody receives only the minted v4 position.';
  liquidityFormation.valueFlow = 'Only after provider preimage and preflight facts are resolved, the owner would supply 240000000 USDG atomic units after the graph allocates 1000000000000000000000000000 HKMN atomic units to the resolved hook. No other HKMN allocation exists.';
  initialTransaction.valueFlow = 'Only after provider preimage and preflight facts are resolved would the wallet sign the zero-value graph call and, after assertions, the owner seed call. Requirements revision 65 is not transaction authorization for either transaction.';
  const valueFlows = assertArray(normalized.valueFlows, '/submission/valueFlows');
  const ownerSeed = valueFlows.find((flow) => flow?.id === 'owner-seed');
  if (!ownerSeed) fail('MISSING_PROPERTY', '/submission/valueFlows/owner-seed');
  ownerSeed.amountRule = 'USDG maximum is 240000000 atomic units; HKMN maximum is the selected 1000000000000000000000000000 candidate.';
  ownerSeed.settlement = 'Permit2 transfers the exact USDG allowance to the hook, which forms the permanent custody position, returns unused USDG to the payer, and rejects any graph-mode HKMN residual.';
  normalized.disclosures = assertArray(normalized.disclosures, '/submission/disclosures')
    .map((value, index) => normalizePhaseThreeSubmissionDisclosure(assertString(value, `/submission/disclosures/${index}`)));
  normalized.unresolved = assertArray(normalized.unresolved, '/submission/unresolved')
    .map((value, index) => normalizePhaseThreeSubmissionUnresolved(assertString(value, `/submission/unresolved/${index}`)))
    .filter((value) => !/TOK-01|destination decision/i.test(value));
  return normalized;
}

function filesRecursively(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(child);
    }
  };
  visit(directory);
  return files.sort();
}

function validatePhaseThreeBuildEvidence(artifactDirectory, standardInputDirectory, addressManifest) {
  const artifacts = filesRecursively(artifactDirectory).filter((path) => path.endsWith('.json'));
  if (artifacts.length < 3) fail('MISSING_PACKAGE_FILE', '/artifactDirectory');
  const buildInfos = filesRecursively(standardInputDirectory).filter((path) => path.endsWith('.json'));
  if (buildInfos.length !== 1) fail('INVALID_VALUE', '/standardInputDirectory');
  let buildInfoBytes;
  let buildInfo;
  try {
    buildInfoBytes = readFileSync(buildInfos[0]);
    buildInfo = JSON.parse(buildInfoBytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', '/standardInputDirectory');
  }
  parseStandardInput(buildInfoBytes, `/standardInputDirectory/${basename(buildInfos[0])}`);
  let commitment;
  try {
    commitment = sourceContentCommitment(buildInfo);
  } catch {
    fail('INVALID_VALUE', '/standardInputDirectory');
  }
  const recorded = addressManifest.compiler.buildInfo;
  if (
    recorded.localBuildInfoCount !== buildInfos.length
    || recorded.sourceCount !== commitment.sourceCount
    || recorded.sourceContentSha256 !== commitment.sourceContentSha256
  ) fail('HASH_MISMATCH', '/addressManifest/compiler/buildInfo');
  for (const target of addressManifest.targets) {
    const artifactPath = resolve(artifactDirectory, `${target.targetId}.json`);
    let bytes;
    let artifact;
    try {
      bytes = readFileSync(artifactPath);
      artifact = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('INPUT_READ_FAILED', `/artifactDirectory/${target.targetId}.json`);
    }
    const hashes = artifactHashes(bytes, artifact);
    const targetPath = `/addressManifest/targets/${target.targetIndex}`;
    if (hashes.creationBytecodeHash !== target.creationBytecodeHash) {
      fail('HASH_MISMATCH', `${targetPath}/creationBytecodeHash`);
    }
    if (hashes.runtimeTemplateCodeHash !== target.runtimeTemplateCodeHash) {
      fail('HASH_MISMATCH', `${targetPath}/runtimeTemplateCodeHash`);
    }
    if (hashes.artifactSha256 !== target.artifactSha256) {
      fail('HASH_MISMATCH', `${targetPath}/artifactSha256`);
    }
  }
}

function readFileInside(directory, inputPath, pointer) {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || isAbsolute(inputPath)) fail('INVALID_PATH', pointer);
  const root = resolve(directory);
  const candidate = resolve(root, inputPath);
  const relativePath = relative(root, candidate);
  if (relativePath.length === 0 || relativePath === '..' || relativePath.split(/[\\/]/)[0] === '..') {
    fail('INVALID_PATH', pointer);
  }
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_PATH', pointer);
    return readFileSync(candidate);
  } catch (error) {
    if (error instanceof PackageValidationError) throw error;
    fail('INPUT_READ_FAILED', pointer);
  }
}

function validatePermitWindow(value, path) {
  assertExactKeys(value, ['validAfter', 'deadline'], path);
  assertAmount(value.validAfter, `${path}/validAfter`);
  assertAmount(value.deadline, `${path}/deadline`);
}

function validateFunding(value, path) {
  assertExactKeys(value, ['schemaVersion', 'mode', 'valueWei'], path);
  if (value.schemaVersion !== 'programmable.custom-launch-funding-intent.v2') fail('INVALID_VALUE', `${path}/schemaVersion`);
  if (!FUNDING_MODES.has(value.mode)) fail('FUNDING_MODE', `${path}/mode`);
  assertAmount(value.valueWei, `${path}/valueWei`);
  if (value.mode === 'none' && value.valueWei !== '0') fail('INVALID_VALUE', `${path}/valueWei`);
}

function validateLiquidityModel(value, path, { enforceMaximum = true } = {}) {
  assertExactKeys(value, ['schemaVersion', 'model', 'declaredLaunchState', 'targetIds'], path);
  if (value.schemaVersion !== 'programmable.custom-launch-liquidity-model.v1') fail('INVALID_VALUE', `${path}/schemaVersion`);
  if (!LIQUIDITY_MODELS.has(value.model)) fail('INVALID_VALUE', `${path}/model`);
  if (!LAUNCH_STATES.has(value.declaredLaunchState)) fail('INVALID_VALUE', `${path}/declaredLaunchState`);
  const ids = assertArray(value.targetIds, `${path}/targetIds`);
  if (enforceMaximum && ids.length > 16) fail('INVALID_VALUE', `${path}/targetIds`);
  const seen = new Set();
  ids.forEach((id, index) => {
    assertIdentifier(id, `${path}/targetIds/${index}`);
    if (seen.has(id)) fail('DUPLICATE_VALUE', `${path}/targetIds/${index}`);
    seen.add(id);
  });
}

function validateImage(value, path, imageBytes = null) {
  assertExactKeys(value, ['uri', 'contentSha256', 'mediaType', 'byteLength', 'width', 'height'], path);
  assertString(value.uri, `${path}/uri`);
  assertHash(value.contentSha256, `${path}/contentSha256`);
  if (!['image/png', 'image/gif'].includes(value.mediaType)) fail('INVALID_VALUE', `${path}/mediaType`);
  assertInteger(value.byteLength, `${path}/byteLength`, { minimum: 1, maximum: 5_242_880 });
  assertInteger(value.width, `${path}/width`, { minimum: 1, maximum: 8192 });
  assertInteger(value.height, `${path}/height`, { minimum: 1, maximum: 8192 });
  if (imageBytes) {
    if (value.contentSha256 !== sha256Bytes(imageBytes)) fail('HASH_MISMATCH', `${path}/contentSha256`);
    if (value.byteLength !== imageBytes.length) fail('INVALID_VALUE', `${path}/byteLength`);
  }
}

function validateMetadataBindingLeaf(value, path) {
  assertExactKeys(value, ['staticSource', 'argumentIndex', 'argumentName'], path);
  const staticSources = new Set(['constructor-argument', 'initializer-argument', 'not-deterministically-extractable']);
  if (!staticSources.has(value.staticSource)) fail('INVALID_VALUE', `${path}/staticSource`);
  if (value.staticSource === 'not-deterministically-extractable') {
    if (value.argumentIndex !== null) fail('INVALID_VALUE', `${path}/argumentIndex`);
    if (value.argumentName !== null) fail('INVALID_VALUE', `${path}/argumentName`);
    return;
  }
  assertInteger(value.argumentIndex, `${path}/argumentIndex`, { minimum: 0 });
  assertString(value.argumentName, `${path}/argumentName`);
}

function validateProjectMetadata(value, path, imageBytes = null) {
  assertExactKeys(value, ['schemaVersion', 'token', 'presentation', 'tokenMetadataBinding'], path);
  if (value.schemaVersion !== 'programmable.project-metadata.v1') fail('INVALID_VALUE', `${path}/schemaVersion`);
  assertExactKeys(value.token, ['name', 'symbol'], `${path}/token`);
  assertString(value.token.name, `${path}/token/name`);
  assertString(value.token.symbol, `${path}/token/symbol`);
  const presentationPath = `${path}/presentation`;
  assertExactKeys(value.presentation, ['schemaVersion', 'description', 'image', 'links'], presentationPath);
  if (value.presentation.schemaVersion !== 'programmable.launch-presentation-draft.v1') fail('INVALID_VALUE', `${presentationPath}/schemaVersion`);
  assertString(value.presentation.description, `${presentationPath}/description`);
  validateImage(value.presentation.image, `${presentationPath}/image`, imageBytes);
  const links = assertArray(value.presentation.links, `${presentationPath}/links`);
  if (links.length < 2 || links.length > 32) fail('INVALID_VALUE', `${presentationPath}/links`);
  const linkKinds = new Map();
  links.forEach((link, index) => {
    const linkPath = `${presentationPath}/links/${index}`;
    assertExactKeys(link, ['kind', 'uri'], linkPath);
    if (!['website', 'documentation', 'x', 'telegram', 'discord', 'github', 'other'].includes(link.kind)) fail('INVALID_VALUE', `${linkPath}/kind`);
    assertString(link.uri, `${linkPath}/uri`);
    linkKinds.set(link.kind, (linkKinds.get(link.kind) ?? 0) + 1);
  });
  if (linkKinds.get('website') !== 1 || linkKinds.get('x') !== 1) fail('INVALID_VALUE', `${presentationPath}/links`);

  const bindingPath = `${path}/tokenMetadataBinding`;
  assertExactKeys(value.tokenMetadataBinding, [
    'schemaVersion', 'tokenTargetId', 'declarationBinding', 'standardReadModel', 'name', 'symbol', 'postDeploymentReadback',
  ], bindingPath);
  if (value.tokenMetadataBinding.schemaVersion !== 'programmable.project-token-metadata-binding.v1') fail('INVALID_VALUE', `${bindingPath}/schemaVersion`);
  assertIdentifier(value.tokenMetadataBinding.tokenTargetId, `${bindingPath}/tokenTargetId`);
  if (value.tokenMetadataBinding.declarationBinding !== 'request-and-launch-id') fail('INVALID_VALUE', `${bindingPath}/declarationBinding`);
  assertExactKeys(value.tokenMetadataBinding.standardReadModel, ['name', 'symbol'], `${bindingPath}/standardReadModel`);
  if (typeof value.tokenMetadataBinding.standardReadModel.name !== 'boolean') fail('EXPECTED_BOOLEAN', `${bindingPath}/standardReadModel/name`);
  if (typeof value.tokenMetadataBinding.standardReadModel.symbol !== 'boolean') fail('EXPECTED_BOOLEAN', `${bindingPath}/standardReadModel/symbol`);
  validateMetadataBindingLeaf(value.tokenMetadataBinding.name, `${bindingPath}/name`);
  validateMetadataBindingLeaf(value.tokenMetadataBinding.symbol, `${bindingPath}/symbol`);
  if (value.tokenMetadataBinding.postDeploymentReadback !== 'required') fail('INVALID_VALUE', `${bindingPath}/postDeploymentReadback`);
}

function validateAttestationTemplate(value, path) {
  assertExactKeys(value, ['schemaVersion', 'agentId', 'checkedAt', 'checks'], path);
  if (value.schemaVersion !== 'programmable.agent-launch-attestation.v2') fail('INVALID_VALUE', `${path}/schemaVersion`);
  assertIdentifier(value.agentId, `${path}/agentId`);
  assertString(value.checkedAt, `${path}/checkedAt`, RFC3339_MILLIS);
  const checks = assertArray(value.checks, `${path}/checks`);
  if (checks.length === 0 || checks.length > 64) fail('INVALID_VALUE', `${path}/checks`);
  checks.forEach((check, index) => {
    const checkPath = `${path}/checks/${index}`;
    assertExactKeys(check, ['checkId', 'evidenceSha256'], checkPath);
    assertIdentifier(check.checkId, `${checkPath}/checkId`);
    assertHash(check.evidenceSha256, `${checkPath}/evidenceSha256`);
  });
}

function validateAmountRecord(value, path, chainId) {
  assertExactKeys(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], path);
  if (value.chainId !== chainId) fail('INVALID_VALUE', `${path}/chainId`);
  assertString(value.assetId, `${path}/assetId`);
  assertInteger(value.decimals, `${path}/decimals`, { minimum: 0, maximum: 255 });
  assertAmount(value.amountAtomic, `${path}/amountAtomic`);
}

function validateLaunchInputs(value) {
  const path = '/launchInputs';
  assertExactKeys(value, [
    'schemaVersion', 'chainId', 'caip2', 'launchWallet', 'nonce', 'permitWindow', 'tickSpacing', 'sqrtPriceX96', 'liquidity',
    'roles', 'salts', 'funding', 'liquidityModel', 'projectMetadata', 'projectMetadataImage', 'agentAttestation',
  ], path);
  if (value.schemaVersion !== 'hookemon.programmable-launch-inputs.v1') fail('INVALID_VALUE', `${path}/schemaVersion`);
  if (value.chainId !== '4663') fail('INVALID_VALUE', `${path}/chainId`);
  if (value.caip2 !== 'eip155:4663') fail('INVALID_VALUE', `${path}/caip2`);
  assertAddress(value.launchWallet, `${path}/launchWallet`);
  assertHex32(value.nonce, `${path}/nonce`, { nonzero: true });
  validatePermitWindow(value.permitWindow, `${path}/permitWindow`);
  assertInteger(value.tickSpacing, `${path}/tickSpacing`, { minimum: 1, maximum: 32_767 });
  assertAmount(value.sqrtPriceX96, `${path}/sqrtPriceX96`);
  if (value.sqrtPriceX96 === '0') fail('INVALID_VALUE', `${path}/sqrtPriceX96`);
  validateAmountRecord(value.liquidity, `${path}/liquidity`, value.chainId);
  assertObject(value.roles, `${path}/roles`);
  if (Object.keys(value.roles).length === 0) fail('INVALID_VALUE', `${path}/roles`);
  for (const [name, role] of Object.entries(value.roles)) {
    assertIdentifier(name, `${path}/roles/${name}`);
    assertAddress(role, `${path}/roles/${name}`);
  }
  assertObject(value.salts, `${path}/salts`);
  validateFunding(value.funding, `${path}/funding`);
  validateLiquidityModel(value.liquidityModel, `${path}/liquidityModel`, { enforceMaximum: false });
  const imageBytes = assertBase64(value.projectMetadataImage.base64, `${path}/projectMetadataImage/base64`);
  assertExactKeys(value.projectMetadataImage, ['mediaType', 'base64'], `${path}/projectMetadataImage`);
  if (!['image/png', 'image/gif'].includes(value.projectMetadataImage.mediaType)) fail('INVALID_VALUE', `${path}/projectMetadataImage/mediaType`);
  validateProjectMetadata(value.projectMetadata, `${path}/projectMetadata`, imageBytes);
  if (value.projectMetadata.presentation.image.mediaType !== value.projectMetadataImage.mediaType) fail('INVALID_VALUE', `${path}/projectMetadataImage/mediaType`);
  validateAttestationTemplate(value.agentAttestation, `${path}/agentAttestation`);
}

function validateSourceDescriptor(value, path) {
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'controllerWallet', 'sourceLineageNonce', 'sourceBundleDigest', 'bundleContentSha256', 'publicOriginCommitment',
  ], path);
  if (value.schemaVersion !== '2.0.0') fail('INVALID_VALUE', `${path}/schemaVersion`);
  if (value.kind !== 'deterministic-source-bundle') fail('INVALID_VALUE', `${path}/kind`);
  assertAddress(value.controllerWallet, `${path}/controllerWallet`);
  assertAmount(value.sourceLineageNonce, `${path}/sourceLineageNonce`);
  assertHex32(value.sourceBundleDigest, `${path}/sourceBundleDigest`);
  assertHash(value.bundleContentSha256, `${path}/bundleContentSha256`);
  assertHex32(value.publicOriginCommitment, `${path}/publicOriginCommitment`);
}

function validateSourceBundleManifest(value, path) {
  assertExactKeys(value, ['schemaVersion', 'entries'], path);
  if (value.schemaVersion !== '2.0.0') fail('INVALID_VALUE', `${path}/schemaVersion`);
  const entries = assertArray(value.entries, `${path}/entries`);
  if (entries.length === 0) fail('INVALID_VALUE', `${path}/entries`);
  let previous = null;
  entries.forEach((entry, index) => {
    const entryPath = `${path}/entries/${index}`;
    assertExactKeys(entry, ['path', 'kind', 'mode', 'byteLength', 'contentSha256', 'symlinkTarget'], entryPath);
    assertString(entry.path, `${entryPath}/path`);
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) fail('INVALID_PATH', `${entryPath}/path`);
    if (previous !== null && Buffer.compare(Buffer.from(previous, 'utf8'), Buffer.from(entry.path, 'utf8')) >= 0) fail('SOURCE_MANIFEST_ORDER', `${entryPath}/path`);
    previous = entry.path;
    if (!['file', 'symlink'].includes(entry.kind)) fail('INVALID_VALUE', `${entryPath}/kind`);
    if (!['100644', '100755', '120000'].includes(entry.mode)) fail('INVALID_VALUE', `${entryPath}/mode`);
    assertAmount(entry.byteLength, `${entryPath}/byteLength`);
    assertHash(entry.contentSha256, `${entryPath}/contentSha256`);
    if (!(typeof entry.symlinkTarget === 'string' || entry.symlinkTarget === null)) fail('INVALID_VALUE', `${entryPath}/symlinkTarget`);
  });
}

function validateLocators(value, path) {
  const locators = assertArray(value, path);
  if (locators.length > 256) fail('INVALID_VALUE', path);
  locators.forEach((locator, index) => {
    const locatorPath = `${path}/${index}`;
    assertExactKeys(locator, ['targetId', 'byteOffset', 'encoding'], locatorPath);
    assertIdentifier(locator.targetId, `${locatorPath}/targetId`);
    assertInteger(locator.byteOffset, `${locatorPath}/byteOffset`, { minimum: 0 });
    if (!['abi-address-word', 'packed-address-20'].includes(locator.encoding)) fail('INVALID_VALUE', `${locatorPath}/encoding`);
  });
}

function validateHookPermissions(value, path, componentKind) {
  if (componentKind !== 'hook') {
    if (value !== null) fail('INVALID_VALUE', path);
    return;
  }
  const permissions = assertArray(value, path);
  if (permissions.length > 14) fail('INVALID_VALUE', path);
  const seen = new Set();
  permissions.forEach((permission, index) => {
    if (!HOOK_PERMISSIONS.has(permission)) fail('INVALID_VALUE', `${path}/${index}`);
    if (seen.has(permission)) fail('DUPLICATE_VALUE', `${path}/${index}`);
    seen.add(permission);
  });
}

function validateLocalTarget(value, path) {
  assertExactKeys(value, LOCAL_TARGET_KEYS, path);
  assertIdentifier(value.targetId, `${path}/targetId`);
  assertString(value.artifactPath, `${path}/artifactPath`);
  assertString(value.standardJsonInputPath, `${path}/standardJsonInputPath`);
  assertIdentifier(value.compilationUnitId, `${path}/compilationUnitId`);
  assertString(value.sourcePath, `${path}/sourcePath`);
  assertIdentifier(value.contractName, `${path}/contractName`);
  assertHex(value.constructorArguments, `${path}/constructorArguments`);
  assertHex(value.initializerCalldata, `${path}/initializerCalldata`);
  validateLocators(value.constructorAddressLocators, `${path}/constructorAddressLocators`);
  validateLocators(value.initializerAddressLocators, `${path}/initializerAddressLocators`);
  assertAmount(value.deploymentValueWei, `${path}/deploymentValueWei`);
  assertAmount(value.initializerValueWei, `${path}/initializerValueWei`);
  if (!COMPONENT_KINDS.has(value.componentKind)) fail('INVALID_VALUE', `${path}/componentKind`);
  validateHookPermissions(value.declaredHookPermissions, `${path}/declaredHookPermissions`, value.componentKind);
  assertArray(value.runtimeImmutables, `${path}/runtimeImmutables`);
}

function validateExternalContracts(value, path) {
  const contracts = assertArray(value, path);
  if (contracts.length > 64) fail('INVALID_VALUE', path);
  contracts.forEach((contract, index) => {
    const contractPath = `${path}/${index}`;
    assertExactKeys(contract, [
      'schemaVersion', 'chainId', 'caip2', 'address', 'runtimeCodeHash', 'sourceEvidenceDigest', 'role', 'startBlock', 'auditBlock', 'locator', 'mutability',
    ], contractPath);
    if (contract.schemaVersion !== 'programmable.custom-launch-external-contract.v1') fail('INVALID_VALUE', `${contractPath}/schemaVersion`);
    if (contract.chainId !== '4663' || contract.caip2 !== 'eip155:4663') fail('INVALID_VALUE', contract.chainId !== '4663' ? `${contractPath}/chainId` : `${contractPath}/caip2`);
    assertAddress(contract.address, `${contractPath}/address`);
    assertHex32(contract.runtimeCodeHash, `${contractPath}/runtimeCodeHash`, { nonzero: true });
    assertHash(contract.sourceEvidenceDigest, `${contractPath}/sourceEvidenceDigest`);
    assertIdentifier(contract.role, `${contractPath}/role`);
    assertAmount(contract.startBlock, `${contractPath}/startBlock`);
    if (contract.startBlock === '0') fail('INVALID_VALUE', `${contractPath}/startBlock`);
    assertAmount(contract.auditBlock, `${contractPath}/auditBlock`);
    assertExactKeys(contract.locator, ['targetId', 'phase', 'byteOffset', 'encoding'], `${contractPath}/locator`);
    assertIdentifier(contract.locator.targetId, `${contractPath}/locator/targetId`);
    if (!['constructor', 'initializer'].includes(contract.locator.phase)) fail('INVALID_VALUE', `${contractPath}/locator/phase`);
    assertInteger(contract.locator.byteOffset, `${contractPath}/locator/byteOffset`, { minimum: 0 });
    if (!['abi-address-word', 'packed-address-20'].includes(contract.locator.encoding)) fail('INVALID_VALUE', `${contractPath}/locator/encoding`);
    assertObject(contract.mutability, `${contractPath}/mutability`);
  });
}

function validateAddressManifest(value) {
  const path = '/addressManifest';
  assertExactKeys(value, [
    'schemaVersion', 'chainDeployment', 'chainDeploymentDescriptorDigest', 'profile', 'sourceDescriptor', 'sourceBundleManifest', 'externalContracts', 'pool', 'targets',
  ], path);
  if (value.schemaVersion !== 'hookemon.programmable-address-manifest.v1') fail('INVALID_VALUE', `${path}/schemaVersion`);
  assertObject(value.chainDeployment, `${path}/chainDeployment`);
  if (value.chainDeployment.schemaVersion !== 'programmable.custom-launch-chain-deployment.v1') fail('INVALID_VALUE', `${path}/chainDeployment/schemaVersion`);
  if (value.chainDeployment.chainId !== '4663') fail('INVALID_VALUE', `${path}/chainDeployment/chainId`);
  if (value.chainDeployment.caip2 !== 'eip155:4663') fail('INVALID_VALUE', `${path}/chainDeployment/caip2`);
  assertHex32(value.chainDeploymentDescriptorDigest, `${path}/chainDeploymentDescriptorDigest`, { nonzero: true });
  assertObject(value.profile, `${path}/profile`);
  if (value.profile.schemaVersion !== 'programmable.custom-launch-profile-ref.v4') fail('INVALID_VALUE', `${path}/profile/schemaVersion`);
  validateSourceDescriptor(value.sourceDescriptor, `${path}/sourceDescriptor`);
  validateSourceBundleManifest(value.sourceBundleManifest, `${path}/sourceBundleManifest`);
  validateExternalContracts(value.externalContracts, `${path}/externalContracts`);
  assertExactKeys(value.pool, ['tokenTargetId', 'hookTargetId', 'fee'], `${path}/pool`);
  assertIdentifier(value.pool.tokenTargetId, `${path}/pool/tokenTargetId`);
  assertIdentifier(value.pool.hookTargetId, `${path}/pool/hookTargetId`);
  assertInteger(value.pool.fee, `${path}/pool/fee`, { minimum: 0, maximum: 8_388_608 });
  const targets = assertArray(value.targets, `${path}/targets`);
  targets.forEach((target, index) => validateLocalTarget(target, `${path}/targets/${index}`));
}

function isPhaseThreeAddressDerivationDraft(launchInputs, addressManifest) {
  return (
    launchInputs?.schemaVersion === 'hookemon.phase3.release-launch-inputs.v1'
    && launchInputs?.status === 'ADDRESS_DERIVATION_PENDING'
    && addressManifest?.schemaVersion === 'hookemon.phase3.address-manifest-draft.v1'
    && addressManifest?.status === 'ADDRESS_DERIVATION_PENDING'
  );
}

function assertPhaseThreeAmount(value, path, { assetId, decimals, amountAtomic }) {
  assertExactKeys(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], path);
  if (value.chainId !== '4663' || value.assetId !== assetId || value.decimals !== decimals || value.amountAtomic !== amountAtomic) {
    fail('INVALID_VALUE', path);
  }
}

function assertPhaseThreeOpenFacts(value, path) {
  const facts = assertArray(value, path);
  if (facts.length === 0) fail('INVALID_VALUE', path);
  facts.forEach((fact, index) => {
    const factPath = `${path}/${index}`;
    const text = assertString(fact, factPath);
    if (!text.includes('Missing:') || !text.includes('Resolve:') || !text.includes('Verified alternative:')) {
      fail('INVALID_VALUE', factPath);
    }
  });
}

function assertPhaseThreeQuadrants(value, path, expected) {
  assertExactKeys(value, ['zeroForOneExactInput', 'zeroForOneExactOutput', 'oneForZeroExactInput', 'oneForZeroExactOutput'], path);
  for (const [name, expectedQuadrant] of Object.entries(expected)) {
    const quadrantPath = `${path}/${name}`;
    assertExactKeys(value[name], ['currency', 'basis', 'collectionPath'], quadrantPath);
    if (
      value[name].currency !== expectedQuadrant.currency
      || value[name].basis !== expectedQuadrant.basis
      || value[name].collectionPath !== expectedQuadrant.collectionPath
    ) fail('INVALID_VALUE', quadrantPath);
  }
}

function assertPhaseThreeTargetBase(target, path, expected) {
  if (
    target.targetId !== expected.targetId
    || target.targetIndex !== expected.targetIndex
    || target.componentKind !== expected.componentKind
    || target.sourcePath !== expected.sourcePath
    || target.contractName !== expected.contractName
    || target.applicantSalt !== null
    || target.effectiveSalt !== null
    || target.address !== null
    || target.runtimeCodeHash !== null
  ) fail('INVALID_VALUE', path);
  assertHex32(target.creationBytecodeHash, `${path}/creationBytecodeHash`, { nonzero: true });
  assertHex32(target.runtimeTemplateCodeHash, `${path}/runtimeTemplateCodeHash`, { nonzero: true });
  assertHash(target.artifactSha256, `${path}/artifactSha256`);
  if (expected.creationBytecodeHash !== undefined && target.creationBytecodeHash !== expected.creationBytecodeHash) fail('INVALID_VALUE', `${path}/creationBytecodeHash`);
  if (expected.runtimeTemplateCodeHash !== undefined && target.runtimeTemplateCodeHash !== expected.runtimeTemplateCodeHash) fail('INVALID_VALUE', `${path}/runtimeTemplateCodeHash`);
  if (expected.artifactSha256 !== undefined && target.artifactSha256 !== expected.artifactSha256) fail('INVALID_VALUE', `${path}/artifactSha256`);
  if (!Array.isArray(target.libraries) || target.libraries.length !== 0) fail('INVALID_VALUE', `${path}/libraries`);
  assertPhaseThreeAmount(target.deploymentValue, `${path}/deploymentValue`, {
    assetId: 'native', decimals: 18, amountAtomic: '0',
  });
  assertPhaseThreeAmount(target.initializerValue, `${path}/initializerValue`, {
    assetId: 'native', decimals: 18, amountAtomic: '0',
  });
}

function validatePhaseThreePriceSelection(priceCandidates, path) {
  const selectionPath = `${path}/selection`;
  assertExactKeys(priceCandidates.selection, [
    'status', 'rule', 'selectedOrdering', 'selectedSqrtPriceX96', 'poolKey', 'poolId',
  ], selectionPath);
  assertString(priceCandidates.selection.rule, `${selectionPath}/rule`);
  const selection = priceCandidates.selection;
  if (selection.status === 'OPEN_FACT') {
    if (
      selection.selectedOrdering !== null
      || selection.selectedSqrtPriceX96 !== null
      || selection.poolKey !== null
      || selection.poolId !== null
    ) fail('INVALID_VALUE', selectionPath);
    return selection;
  }
  if (selection.status !== 'DERIVED') fail('INVALID_VALUE', `${selectionPath}/status`);
  if (!PHASE_THREE_PRICE_CANDIDATE_ORDERINGS.includes(selection.selectedOrdering)) {
    fail('INVALID_VALUE', `${selectionPath}/selectedOrdering`);
  }
  assertAmount(selection.selectedSqrtPriceX96, `${selectionPath}/selectedSqrtPriceX96`);
  if (selection.selectedSqrtPriceX96 !== priceCandidates[selection.selectedOrdering].sqrtPriceX96) {
    fail('INVALID_VALUE', `${selectionPath}/selectedSqrtPriceX96`);
  }
  assertHex(selection.poolKey, `${selectionPath}/poolKey`, { nonempty: true });
  assertHex32(selection.poolId, `${selectionPath}/poolId`);
  return selection;
}

function phaseThreeOrderingRule(selectedOrdering, selectedSqrtPriceX96) {
  const currencies = selectedOrdering === 'hkmnCurrency0'
    ? 'HKMN is currency0; USDG is currency1.'
    : 'USDG is currency0; HKMN is currency1.';
  return `Materialized address-order selection: selectedOrdering=${selectedOrdering}; selectedSqrtPriceX96=${selectedSqrtPriceX96}. ${currencies}`;
}

function phaseThreePoolKey({ currency0, currency1, fee, tickSpacing, hooks }) {
  const addressWord = (value) => value.toLowerCase().slice(2).padStart(64, '0');
  const unsignedWord = (value) => BigInt(value).toString(16).padStart(64, '0');
  const signed24 = BigInt(tickSpacing);
  const signedWord = (signed24 < 0n ? (1n << 24n) + signed24 : signed24).toString(16).padStart(64, '0');
  return `0x${[
    addressWord(currency0),
    addressWord(currency1),
    unsignedWord(fee),
    signedWord,
    addressWord(hooks),
  ].join('')}`;
}

function selectionFromMaterializedManifest(launchInputs, materializedManifest) {
  assertObject(materializedManifest, '/materializedManifest');
  if (materializedManifest.schemaVersion !== 'hookemon.phase3.address-manifest.v1') {
    fail('INVALID_VALUE', '/materializedManifest/schemaVersion');
  }
  const preimages = assertObject(materializedManifest.preimages, '/materializedManifest/preimages');
  const targets = assertObject(preimages.targets, '/materializedManifest/preimages/targets');
  const token = assertObject(targets.token, '/materializedManifest/preimages/targets/token');
  const hook = assertObject(targets.hook, '/materializedManifest/preimages/targets/hook');
  const pool = assertObject(preimages.pool, '/materializedManifest/preimages/pool');
  assertAddress(token.address, '/materializedManifest/preimages/targets/token/address');
  assertAddress(hook.address, '/materializedManifest/preimages/targets/hook/address');
  assertAddress(pool.currency0, '/materializedManifest/preimages/pool/currency0');
  assertAddress(pool.currency1, '/materializedManifest/preimages/pool/currency1');
  assertAddress(pool.hooks, '/materializedManifest/preimages/pool/hooks');
  assertInteger(pool.fee, '/materializedManifest/preimages/pool/fee');
  assertInteger(pool.tickSpacing, '/materializedManifest/preimages/pool/tickSpacing');
  assertHex(pool.poolKeyEncoded, '/materializedManifest/preimages/pool/poolKeyEncoded', { nonempty: true });
  assertHex32(pool.poolId, '/materializedManifest/preimages/pool/poolId');
  assertExactKeys(pool.priceCandidate, ['id', 'sqrtPriceX96'], '/materializedManifest/preimages/pool/priceCandidate');
  assertString(pool.selectedOrdering, '/materializedManifest/preimages/pool/selectedOrdering');
  const selectedOrdering = pool.selectedOrdering;
  if (selectedOrdering !== pool.priceCandidate.id) {
    fail('INVALID_VALUE', '/materializedManifest/preimages/pool/selectedOrdering');
  }
  if (!PHASE_THREE_PRICE_CANDIDATE_ORDERINGS.includes(selectedOrdering)) {
    fail('INVALID_VALUE', '/materializedManifest/preimages/pool/priceCandidate/id');
  }
  assertAmount(pool.priceCandidate.sqrtPriceX96, '/materializedManifest/preimages/pool/priceCandidate/sqrtPriceX96');
  assertAmount(pool.sqrtPriceX96, '/materializedManifest/preimages/pool/sqrtPriceX96');
  if (pool.sqrtPriceX96 !== pool.priceCandidate.sqrtPriceX96) {
    fail('INVALID_VALUE', '/materializedManifest/preimages/pool/sqrtPriceX96');
  }
  const candidates = launchInputs?.pool?.priceCandidates;
  assertObject(candidates, '/launchInputs/pool/priceCandidates');
  const selectedCandidate = candidates[selectedOrdering];
  assertObject(selectedCandidate, `/launchInputs/pool/priceCandidates/${selectedOrdering}`);
  if (pool.priceCandidate.sqrtPriceX96 !== selectedCandidate.sqrtPriceX96) {
    fail('INVALID_VALUE', '/materializedManifest/preimages/pool/priceCandidate/sqrtPriceX96');
  }
  if (pool.fee !== launchInputs.pool.fee || pool.tickSpacing !== launchInputs.pool.tickSpacing) {
    fail('INVALID_VALUE', '/materializedManifest/preimages/pool');
  }
  if (BigInt(pool.currency0) >= BigInt(pool.currency1)) fail('INVALID_VALUE', '/materializedManifest/preimages/pool/currency0');
  const usdg = launchInputs.roles?.usdg;
  assertAddress(usdg, '/launchInputs/roles/usdg');
  const expectedCurrency0 = selectedOrdering === 'hkmnCurrency0' ? token.address : usdg;
  const expectedCurrency1 = selectedOrdering === 'hkmnCurrency0' ? usdg : token.address;
  if (!sameAddress(pool.currency0, expectedCurrency0) || !sameAddress(pool.currency1, expectedCurrency1)) {
    fail('INVALID_VALUE', '/materializedManifest/preimages/pool');
  }
  if (!sameAddress(pool.hooks, hook.address)) fail('INVALID_VALUE', '/materializedManifest/preimages/pool/hooks');
  const expectedPoolKey = phaseThreePoolKey(pool);
  if (pool.poolKeyEncoded !== expectedPoolKey) fail('INVALID_VALUE', '/materializedManifest/preimages/pool/poolKeyEncoded');
  if (
    pool.poolId !== keccak256Hex(Buffer.from(pool.poolKeyEncoded.slice(2), 'hex'))
  ) fail('INVALID_VALUE', '/materializedManifest/preimages/pool/poolId');
  return {
    selectedOrdering,
    selectedSqrtPriceX96: pool.priceCandidate.sqrtPriceX96,
    poolKey: pool.poolKeyEncoded,
    poolId: pool.poolId,
  };
}

export function materializePhaseThreePriceSelection({ launchInputs, submission, materializedManifest } = {}) {
  const materializedLaunchInputs = cloneJson(launchInputs);
  const materializedSubmission = cloneJson(submission);
  const candidates = assertObject(materializedLaunchInputs?.pool?.priceCandidates, '/launchInputs/pool/priceCandidates');
  const currentSelection = validatePhaseThreePriceSelection(candidates, '/launchInputs/pool/priceCandidates');
  if (currentSelection.status !== 'OPEN_FACT') fail('INVALID_VALUE', '/launchInputs/pool/priceCandidates/selection/status');
  const selected = selectionFromMaterializedManifest(materializedLaunchInputs, materializedManifest);
  candidates.selection = {
    status: 'DERIVED',
    rule: currentSelection.rule,
    selectedOrdering: selected.selectedOrdering,
    selectedSqrtPriceX96: selected.selectedSqrtPriceX96,
    poolKey: selected.poolKey,
    poolId: selected.poolId,
  };

  const pool = assertObject(materializedSubmission.pool, '/submission/pool');
  pool.currency0 = selected.selectedOrdering === 'hkmnCurrency0' ? 'hkmn' : 'usdg';
  pool.currency1 = selected.selectedOrdering === 'hkmnCurrency0' ? 'usdg' : 'hkmn';
  pool.orderingRule = phaseThreeOrderingRule(selected.selectedOrdering, selected.selectedSqrtPriceX96);
  const selectedQuadrants = assertObject(
    candidates[selected.selectedOrdering].swapFeeQuadrants,
    `/launchInputs/pool/priceCandidates/${selected.selectedOrdering}/swapFeeQuadrants`,
  );
  const submissionQuadrants = assertObject(
    materializedSubmission?.hook?.feeMechanism?.swapQuadrants,
    '/submission/hook/feeMechanism/swapQuadrants',
  );
  for (const name of [
    'zeroForOneExactInput', 'zeroForOneExactOutput', 'oneForZeroExactInput', 'oneForZeroExactOutput',
  ]) {
    const candidateQuadrant = assertObject(selectedQuadrants[name], `/launchInputs/pool/priceCandidates/${selected.selectedOrdering}/swapFeeQuadrants/${name}`);
    const submissionQuadrant = assertObject(submissionQuadrants[name], `/submission/hook/feeMechanism/swapQuadrants/${name}`);
    assertString(candidateQuadrant.currency, `/launchInputs/pool/priceCandidates/${selected.selectedOrdering}/swapFeeQuadrants/${name}/currency`);
    submissionQuadrant.currency = candidateQuadrant.currency;
  }
  return { launchInputs: materializedLaunchInputs, submission: materializedSubmission };
}

function materializePhaseThreeDraft(options, launchInputs, addressManifest) {
  if (!Object.hasOwn(options, 'phaseThreeMaterialization')) return null;
  if (!isPhaseThreeAddressDerivationDraft(launchInputs, addressManifest)) {
    fail('INVALID_VALUE', '/phaseThreeMaterialization');
  }
  const materialization = assertObject(options.phaseThreeMaterialization, '/phaseThreeMaterialization');
  assertExactKeys(materialization, ['materializedManifest', 'submission'], '/phaseThreeMaterialization');
  const result = materializePhaseThreePriceSelection({
    launchInputs,
    submission: materialization.submission,
    materializedManifest: materialization.materializedManifest,
  });
  return {
    launchInputs: result.launchInputs,
    materializedManifest: cloneJson(materialization.materializedManifest),
    submission: result.submission,
  };
}

function validatePhaseThreeAddressDerivationDraft(launchInputs, addressManifest, artifactDirectory) {
  const launchPath = '/launchInputs';
  const manifestPath = '/addressManifest';
  assertObject(launchInputs, launchPath);
  assertObject(addressManifest, manifestPath);
  if (!isPhaseThreeAddressDerivationDraft(launchInputs, addressManifest)) fail('INVALID_VALUE', `${launchPath}/status`);

  assertExactKeys(launchInputs, [
    'schemaVersion', 'status', 'ownerInputPath', 'chain', 'roles', 'token', 'pool', 'seed', 'metadata', 'openFacts',
  ], launchPath);
  assertExactKeys(launchInputs.chain, [
    'chainId', 'caip2', 'graphFactory', 'launchAndStampV1Router', 'routeNamespace', 'routeNonce', 'topologyHash',
  ], `${launchPath}/chain`);
  if (launchInputs.chain.chainId !== '4663' || launchInputs.chain.caip2 !== 'eip155:4663') {
    fail('INVALID_VALUE', `${launchPath}/chain`);
  }
  assertExactAddress(launchInputs.chain.graphFactory, PHASE_THREE_FACTORY, `${launchPath}/chain/graphFactory`);
  assertExactAddress(launchInputs.chain.launchAndStampV1Router, '0x34965F2A2ee9254522232C32F02056E92BE0C98a', `${launchPath}/chain/launchAndStampV1Router`);
  if (launchInputs.chain.routeNamespace !== null || launchInputs.chain.routeNonce !== null || launchInputs.chain.topologyHash !== null) {
    fail('INVALID_VALUE', `${launchPath}/chain`);
  }
  assertExactKeys(launchInputs.roles, [
    'launchWallet', 'treasury', 'operations', 'programmablePlatform', 'poolManager', 'positionManager', 'permit2', 'usdg', 'launchAuthority', 'issuanceAuthority',
  ], `${launchPath}/roles`);
  const expectedRoles = {
    launchWallet: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
    treasury: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
    operations: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384',
    programmablePlatform: '0x4957f49620AFf3Adbbe8195a4f633E49cc93376c',
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    launchAuthority: '0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729',
    issuanceAuthority: PHASE_THREE_FACTORY,
  };
  for (const [role, expected] of Object.entries(expectedRoles)) assertExactAddress(launchInputs.roles[role], expected, `${launchPath}/roles/${role}`);
  if (!sameAddress(launchInputs.roles.launchWallet, launchInputs.roles.treasury)) fail('INVALID_VALUE', `${launchPath}/roles/treasury`);

  assertExactKeys(launchInputs.token, ['name', 'symbol', 'decimals', 'totalSupply', 'allocation', 'sourceCompatibility'], `${launchPath}/token`);
  if (launchInputs.token.name !== 'Hookemon' || launchInputs.token.symbol !== 'HKMN' || launchInputs.token.decimals !== 18) {
    fail('INVALID_VALUE', `${launchPath}/token`);
  }
  assertPhaseThreeAmount(launchInputs.token.totalSupply, `${launchPath}/token/totalSupply`, {
    assetId: 'hkmn', decimals: 18, amountAtomic: '1000000000000000000000000000',
  });
  assertExactKeys(launchInputs.token.allocation, [
    'canonicalPoolBps', 'remainderCustodyBps', 'canonicalPool', 'remainderCustody',
  ], `${launchPath}/token/allocation`);
  if (launchInputs.token.allocation.canonicalPoolBps !== 10000 || launchInputs.token.allocation.remainderCustodyBps !== 0) {
    fail('INVALID_VALUE', `${launchPath}/token/allocation`);
  }
  assertPhaseThreeAmount(launchInputs.token.allocation.canonicalPool, `${launchPath}/token/allocation/canonicalPool`, {
    assetId: 'hkmn', decimals: 18, amountAtomic: '1000000000000000000000000000',
  });
  assertPhaseThreeAmount(launchInputs.token.allocation.remainderCustody, `${launchPath}/token/allocation/remainderCustody`, {
    assetId: 'hkmn', decimals: 18, amountAtomic: '0',
  });
  assertExactKeys(launchInputs.token.sourceCompatibility, ['status', 'compiledSupplyAtomic', 'reason'], `${launchPath}/token/sourceCompatibility`);
  if (
    launchInputs.token.sourceCompatibility.status !== 'VERIFIED'
    || launchInputs.token.sourceCompatibility.compiledSupplyAtomic !== '1000000000000000000000000000'
  ) fail('INVALID_VALUE', `${launchPath}/token/sourceCompatibility`);
  assertString(launchInputs.token.sourceCompatibility.reason, `${launchPath}/token/sourceCompatibility/reason`);

  assertExactKeys(launchInputs.pool, [
    'fee', 'tickSpacing', 'tickSpacingRationale', 'fullRange', 'quoteAsset', 'baseAsset', 'priceCandidates',
  ], `${launchPath}/pool`);
  if (launchInputs.pool.fee !== 0 || launchInputs.pool.tickSpacing !== 60) fail('INVALID_VALUE', `${launchPath}/pool`);
  assertExactKeys(launchInputs.pool.fullRange, ['minimumTick', 'maximumTick'], `${launchPath}/pool/fullRange`);
  if (launchInputs.pool.fullRange.minimumTick !== -887220 || launchInputs.pool.fullRange.maximumTick !== 887220) {
    fail('INVALID_VALUE', `${launchPath}/pool/fullRange`);
  }
  assertPhaseThreeAmount(launchInputs.pool.quoteAsset, `${launchPath}/pool/quoteAsset`, {
    assetId: 'usdg', decimals: 6, amountAtomic: '240000000',
  });
  assertPhaseThreeAmount(launchInputs.pool.baseAsset, `${launchPath}/pool/baseAsset`, {
    assetId: 'hkmn', decimals: 18, amountAtomic: '1000000000000000000000000000',
  });
  assertExactKeys(launchInputs.pool.priceCandidates, ['usdgCurrency0', 'hkmnCurrency0', 'selection'], `${launchPath}/pool/priceCandidates`);
  const derivedCandidates = derivePriceCandidates({
    usdgAtomic: launchInputs.pool.quoteAsset.amountAtomic,
    hkmnAtomic: launchInputs.pool.baseAsset.amountAtomic,
  });
  const expectedCandidates = {
    usdgCurrency0: {
      ...derivedCandidates.usdgCurrency0,
      swapFeeQuadrants: {
        zeroForOneExactInput: { currency: 'currency0', basis: 'gross-input', collectionPath: 'before-swap-return-delta' },
        zeroForOneExactOutput: { currency: 'currency0', basis: 'gross-input', collectionPath: 'after-swap-return-delta' },
        oneForZeroExactInput: { currency: 'currency0', basis: 'gross-output', collectionPath: 'after-swap-return-delta' },
        oneForZeroExactOutput: { currency: 'currency0', basis: 'gross-output', collectionPath: 'before-swap-return-delta' },
      },
    },
    hkmnCurrency0: {
      ...derivedCandidates.hkmnCurrency0,
      swapFeeQuadrants: {
        zeroForOneExactInput: { currency: 'currency1', basis: 'gross-output', collectionPath: 'after-swap-return-delta' },
        zeroForOneExactOutput: { currency: 'currency1', basis: 'gross-output', collectionPath: 'before-swap-return-delta' },
        oneForZeroExactInput: { currency: 'currency1', basis: 'gross-input', collectionPath: 'before-swap-return-delta' },
        oneForZeroExactOutput: { currency: 'currency1', basis: 'gross-input', collectionPath: 'after-swap-return-delta' },
      },
    },
  };
  for (const [candidate, expected] of Object.entries(expectedCandidates)) {
    const candidatePath = `${launchPath}/pool/priceCandidates/${candidate}`;
    assertExactKeys(launchInputs.pool.priceCandidates[candidate], [
      'sqrtPriceX96', 'sqrtLowerX96', 'sqrtUpperX96', 'liquidity', 'amount0Max', 'amount1Max',
      'consumedAmount0', 'consumedAmount1', 'consumedHkmn', 'swapFeeQuadrants',
    ], candidatePath);
    for (const field of [
      'sqrtPriceX96', 'sqrtLowerX96', 'sqrtUpperX96', 'liquidity', 'amount0Max', 'amount1Max',
      'consumedAmount0', 'consumedAmount1', 'consumedHkmn',
    ]) {
      assertAmount(launchInputs.pool.priceCandidates[candidate][field], `${candidatePath}/${field}`);
      if (launchInputs.pool.priceCandidates[candidate][field] !== expected[field]) fail('INVALID_VALUE', `${candidatePath}/${field}`);
    }
    assertPhaseThreeQuadrants(launchInputs.pool.priceCandidates[candidate].swapFeeQuadrants, `${candidatePath}/swapFeeQuadrants`, expected.swapFeeQuadrants);
  }
  validatePhaseThreePriceSelection(launchInputs.pool.priceCandidates, `${launchPath}/pool/priceCandidates`);

  assertExactKeys(launchInputs.seed, ['mode', 'graphFunding', 'permit2Allowance', 'deadlinePolicy', 'refundAndDust'], `${launchPath}/seed`);
  if (launchInputs.seed.mode !== 'separate-owner-transaction') fail('INVALID_VALUE', `${launchPath}/seed/mode`);
  assertPhaseThreeAmount(launchInputs.seed.graphFunding, `${launchPath}/seed/graphFunding`, {
    assetId: 'native', decimals: 18, amountAtomic: '0',
  });
  assertExactKeys(launchInputs.seed.permit2Allowance, ['owner', 'token', 'spender', 'amountRule', 'expiration'], `${launchPath}/seed/permit2Allowance`);
  assertExactAddress(launchInputs.seed.permit2Allowance.owner, expectedRoles.launchWallet, `${launchPath}/seed/permit2Allowance/owner`);
  assertExactAddress(launchInputs.seed.permit2Allowance.token, expectedRoles.usdg, `${launchPath}/seed/permit2Allowance/token`);
  if (launchInputs.seed.permit2Allowance.expiration !== null) fail('INVALID_VALUE', `${launchPath}/seed/permit2Allowance/expiration`);
  assertExactKeys(launchInputs.seed.deadlinePolicy, ['kind', 'maximumSecondsAfterWalletConfirmation', 'actualDeadline', 'reason'], `${launchPath}/seed/deadlinePolicy`);
  if (launchInputs.seed.deadlinePolicy.kind !== 'relative' || launchInputs.seed.deadlinePolicy.maximumSecondsAfterWalletConfirmation !== 900 || launchInputs.seed.deadlinePolicy.actualDeadline !== null) {
    fail('INVALID_VALUE', `${launchPath}/seed/deadlinePolicy`);
  }
  assertExactKeys(launchInputs.seed.refundAndDust, ['intendedDestination', 'sourceBehavior'], `${launchPath}/seed/refundAndDust`);
  assertExactAddress(launchInputs.seed.refundAndDust.intendedDestination, expectedRoles.treasury, `${launchPath}/seed/refundAndDust/intendedDestination`);
  assertExactKeys(launchInputs.metadata, ['name', 'symbol', 'description', 'website', 'x', 'icon', 'banner'], `${launchPath}/metadata`);
  if (launchInputs.metadata.name !== 'Hookemon' || launchInputs.metadata.symbol !== 'HKMN') fail('INVALID_VALUE', `${launchPath}/metadata`);
  if (launchInputs.metadata.x !== 'https://x.com/hookemon4') {
    fail('INVALID_VALUE', `${launchPath}/metadata`);
  }
  assertExactKeys(launchInputs.metadata.icon, ['expectedFile', 'status'], `${launchPath}/metadata/icon`);
  assertExactKeys(launchInputs.metadata.banner, ['expectedFile', 'status'], `${launchPath}/metadata/banner`);
  if (launchInputs.metadata.icon.status !== 'OPEN_FACT' || launchInputs.metadata.banner.status !== 'OPEN_FACT') fail('INVALID_VALUE', `${launchPath}/metadata`);
  assertPhaseThreeOpenFacts(launchInputs.openFacts, `${launchPath}/openFacts`);
  if (!launchInputs.openFacts.includes(PHASE_THREE_GRAPH_OPEN_FACT)) {
    fail('INVALID_VALUE', `${launchPath}/openFacts`);
  }

  assertExactKeys(addressManifest, [
    'schemaVersion', 'status', 'launchInputsPath', 'deployer', 'compiler', 'targets', 'pool', 'requiredGraphCalls', 'postDeployAssertions', 'openFacts',
  ], manifestPath);
  assertExactKeys(addressManifest.deployer, ['factory', 'entrypoint', 'router', 'routeNamespace', 'routeNonce', 'topologyHash'], `${manifestPath}/deployer`);
  assertExactAddress(addressManifest.deployer.factory, PHASE_THREE_FACTORY, `${manifestPath}/deployer/factory`);
  assertExactAddress(addressManifest.deployer.router, '0x34965F2A2ee9254522232C32F02056E92BE0C98a', `${manifestPath}/deployer/router`);
  if (addressManifest.deployer.entrypoint !== 'launchAndStampV1') fail('INVALID_VALUE', `${manifestPath}/deployer/entrypoint`);
  if (addressManifest.deployer.routeNamespace !== null || addressManifest.deployer.routeNonce !== null || addressManifest.deployer.topologyHash !== null) fail('INVALID_VALUE', `${manifestPath}/deployer`);
  assertExactKeys(addressManifest.compiler, ['solc', 'solcLongVersion', 'standardJson', 'buildInfo'], `${manifestPath}/compiler`);
  if (addressManifest.compiler.solc !== PHASE_THREE_SOLC_VERSION) fail('INVALID_VALUE', `${manifestPath}/compiler/solc`);
  if (addressManifest.compiler.solcLongVersion !== PHASE_THREE_SOLC_LONG_VERSION) fail('INVALID_VALUE', `${manifestPath}/compiler/solcLongVersion`);
  assertExactKeys(addressManifest.compiler.standardJson, ['optimizer', 'viaIR', 'evmVersion', 'metadata'], `${manifestPath}/compiler/standardJson`);
  assertExactKeys(addressManifest.compiler.standardJson.optimizer, ['enabled', 'runs'], `${manifestPath}/compiler/standardJson/optimizer`);
  assertExactKeys(addressManifest.compiler.standardJson.metadata, ['appendCBOR', 'bytecodeHash', 'useLiteralContent'], `${manifestPath}/compiler/standardJson/metadata`);
  if (
    addressManifest.compiler.standardJson.optimizer.enabled !== true
    || addressManifest.compiler.standardJson.optimizer.runs !== 1000
    || addressManifest.compiler.standardJson.viaIR !== false
    || addressManifest.compiler.standardJson.evmVersion !== 'cancun'
    || addressManifest.compiler.standardJson.metadata.appendCBOR !== false
    || addressManifest.compiler.standardJson.metadata.bytecodeHash !== 'none'
    || addressManifest.compiler.standardJson.metadata.useLiteralContent !== false
  ) fail('INVALID_VALUE', `${manifestPath}/compiler/standardJson`);
  assertExactKeys(addressManifest.compiler.buildInfo, ['status', 'localBuildInfoCount', 'sourceCount', 'sourceContentSha256', 'reason'], `${manifestPath}/compiler/buildInfo`);
  if (addressManifest.compiler.buildInfo.status !== 'OPEN_FACT') fail('INVALID_VALUE', `${manifestPath}/compiler/buildInfo/status`);
  assertInteger(addressManifest.compiler.buildInfo.localBuildInfoCount, `${manifestPath}/compiler/buildInfo/localBuildInfoCount`, { minimum: 1, maximum: 1 });
  assertInteger(addressManifest.compiler.buildInfo.sourceCount, `${manifestPath}/compiler/buildInfo/sourceCount`, { minimum: 1 });
  assertHash(addressManifest.compiler.buildInfo.sourceContentSha256, `${manifestPath}/compiler/buildInfo/sourceContentSha256`);
  assertString(addressManifest.compiler.buildInfo.reason, `${manifestPath}/compiler/buildInfo/reason`);
  const targets = assertArray(addressManifest.targets, `${manifestPath}/targets`);
  if (targets.length !== 3) fail('GRAPH_TARGET_COUNT', `${manifestPath}/targets`);
  const [token, custody, hook] = targets;
  assertExactKeys(token, ['targetId', 'targetIndex', 'componentKind', 'sourcePath', 'contractName', 'applicantSalt', 'effectiveSalt', 'address', 'constructor', 'initializerCalldata', 'deploymentValue', 'initializerValue', 'creationBytecodeHash', 'runtimeTemplateCodeHash', 'runtimeCodeHash', 'artifactSha256', 'libraries'], `${manifestPath}/targets/0`);
  assertPhaseThreeTargetBase(token, `${manifestPath}/targets/0`, {
    targetId: 'token', targetIndex: 0, componentKind: 'token', sourcePath: 'packages/contracts/src/launch/HKMNToken.sol', contractName: 'HKMNToken',
  });
  assertExactKeys(token.constructor, ['issuanceAuthority', 'expectedUsdg', 'decimals', 'launchSqrtPriceX96'], `${manifestPath}/targets/0/constructor`);
  if (token.constructor.issuanceAuthority !== expectedRoles.issuanceAuthority || token.constructor.decimals !== 18 || token.constructor.launchSqrtPriceX96 !== null || token.initializerCalldata !== null) fail('INVALID_VALUE', `${manifestPath}/targets/0`);
  assertExactAddress(token.constructor.expectedUsdg, expectedRoles.usdg, `${manifestPath}/targets/0/constructor/expectedUsdg`);

  assertExactKeys(custody, ['targetId', 'targetIndex', 'componentKind', 'sourcePath', 'contractName', 'applicantSalt', 'effectiveSalt', 'address', 'constructor', 'initializerCalldata', 'deploymentValue', 'initializerValue', 'creationBytecodeHash', 'runtimeTemplateCodeHash', 'runtimeCodeHash', 'artifactSha256', 'libraries'], `${manifestPath}/targets/1`);
  assertPhaseThreeTargetBase(custody, `${manifestPath}/targets/1`, {
    targetId: 'custody', targetIndex: 1, componentKind: 'other', sourcePath: 'packages/contracts/src/bindings/RobinhoodBindings.sol', contractName: 'PermanentPositionCustody',
  });
  assertExactKeys(custody.constructor, ['manager', 'tokenId'], `${manifestPath}/targets/1/constructor`);
  assertExactAddress(custody.constructor.manager, expectedRoles.positionManager, `${manifestPath}/targets/1/constructor/manager`);
  if (custody.constructor.tokenId !== 0 || custody.initializerCalldata !== null) fail('INVALID_VALUE', `${manifestPath}/targets/1/constructor/tokenId`);

  assertExactKeys(hook, ['targetId', 'targetIndex', 'componentKind', 'sourcePath', 'contractName', 'applicantSalt', 'effectiveSalt', 'address', 'declaredHookPermissions', 'permissionMask', 'constructor', 'initializer', 'deploymentValue', 'initializerValue', 'creationBytecodeHash', 'runtimeTemplateCodeHash', 'runtimeCodeHash', 'artifactSha256', 'libraries'], `${manifestPath}/targets/2`);
  assertPhaseThreeTargetBase(hook, `${manifestPath}/targets/2`, {
    targetId: 'hook', targetIndex: 2, componentKind: 'hook', sourcePath: 'packages/contracts/src/HookemonHook.sol', contractName: 'HookemonHook',
  });
  if (!sameStringSet(hook.declaredHookPermissions, ['beforeInitialize', 'beforeSwap', 'beforeSwapReturnDelta', 'afterSwap', 'afterSwapReturnDelta']) || hook.permissionMask !== '0x20cc') fail('INVALID_VALUE', `${manifestPath}/targets/2`);
  assertExactKeys(hook.constructor, ['manager', 'positionManager', 'permit2', 'usdg', 'hkmn', 'tickSpacing', 'programmable', 'treasury', 'operations', 'launchAuthority', 'issuanceAuthority', 'expectedDecimals', 'bindingDigest', 'runtimeDigest', 'processClaimLimit6h', 'processClaimLimitMax', 'processClaimMaxCount', 'operationsRotationDelay'], `${manifestPath}/targets/2/constructor`);
  const expectedHookConstructorAddresses = {
    manager: expectedRoles.poolManager,
    positionManager: expectedRoles.positionManager,
    permit2: expectedRoles.permit2,
    usdg: expectedRoles.usdg,
    programmable: expectedRoles.programmablePlatform,
    treasury: expectedRoles.treasury,
    operations: expectedRoles.operations,
    launchAuthority: expectedRoles.launchAuthority,
    issuanceAuthority: expectedRoles.issuanceAuthority,
  };
  for (const [field, expected] of Object.entries(expectedHookConstructorAddresses)) assertExactAddress(hook.constructor[field], expected, `${manifestPath}/targets/2/constructor/${field}`);
  if (
    hook.constructor.hkmn !== null || hook.constructor.tickSpacing !== 60
    || hook.constructor.expectedDecimals !== 18 || hook.constructor.bindingDigest !== null || hook.constructor.runtimeDigest !== null
    || hook.constructor.processClaimLimit6h !== '50000000000' || hook.constructor.processClaimLimitMax !== '500000000000'
    || hook.constructor.processClaimMaxCount !== 24 || hook.constructor.operationsRotationDelay !== '43200'
  ) fail('INVALID_VALUE', `${manifestPath}/targets/2/constructor`);
  assertExactKeys(hook.initializer, ['function', 'sqrtPriceX96', 'calldata'], `${manifestPath}/targets/2/initializer`);
  if (hook.initializer.function !== 'initializeGraphLaunch(address,uint160)' || hook.initializer.sqrtPriceX96 !== null || hook.initializer.calldata !== null) fail('INVALID_VALUE', `${manifestPath}/targets/2/initializer`);

  assertExactKeys(addressManifest.pool, ['fee', 'tickSpacing', 'currency0', 'currency1', 'poolKey', 'poolId'], `${manifestPath}/pool`);
  if (addressManifest.pool.fee !== 0 || addressManifest.pool.tickSpacing !== 60) fail('INVALID_VALUE', `${manifestPath}/pool`);
  if (addressManifest.pool.currency0 !== null || addressManifest.pool.currency1 !== null || addressManifest.pool.poolKey !== null || addressManifest.pool.poolId !== null) fail('INVALID_VALUE', `${manifestPath}/pool`);
  const graphCalls = assertArray(addressManifest.requiredGraphCalls, `${manifestPath}/requiredGraphCalls`);
  const expectedGraphCalls = derivePhaseThreeGraphCallsFromCompiledAbi(artifactDirectory);
  if (graphCalls.length !== expectedGraphCalls.length) fail('INVALID_VALUE', `${manifestPath}/requiredGraphCalls`);
  graphCalls.forEach((call, index) => {
    const callPath = `${manifestPath}/requiredGraphCalls/${index}`;
    assertExactKeys(call, ['callId', 'targetId', 'function', 'selector', 'caller', 'argumentBindings', 'calldata', 'reason'], callPath);
    const expected = expectedGraphCalls[index];
    if (call.callId !== expected.callId) fail('INVALID_VALUE', `${callPath}/callId`);
    if (call.targetId !== expected.targetId) fail('INVALID_VALUE', `${callPath}/targetId`);
    if (call.function !== expected.function) fail('INVALID_VALUE', `${callPath}/function`);
    if (call.selector !== expected.selector) fail('INVALID_VALUE', `${callPath}/selector`);
    if (call.caller !== expected.caller) fail('INVALID_VALUE', `${callPath}/caller`);
    if (canonicalJson(call.argumentBindings) !== canonicalJson(expected.argumentBindings)) fail('INVALID_VALUE', `${callPath}/argumentBindings`);
    if (call.calldata !== null) fail('INVALID_VALUE', `${callPath}/calldata`);
    if (call.reason !== expected.reason) fail('INVALID_VALUE', `${callPath}/reason`);
  });
  const assertions = assertArray(addressManifest.postDeployAssertions, `${manifestPath}/postDeployAssertions`);
  if (assertions.length < 6 || !assertions[0].includes('token-allocate')) fail('INVALID_VALUE', `${manifestPath}/postDeployAssertions`);
  assertPhaseThreeOpenFacts(addressManifest.openFacts, `${manifestPath}/openFacts`);
  if (!addressManifest.openFacts.includes(PHASE_THREE_GRAPH_OPEN_FACT)) fail('INVALID_VALUE', `${manifestPath}/openFacts`);
  if (addressManifest.openFacts.some((fact) => isRetiredPhaseThreeGraphFact(fact))) fail('INVALID_VALUE', `${manifestPath}/openFacts`);
}

function phaseThreeDraftUnverified() {
  return [
    {
      code: 'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
      path: '/launchIntentHash',
      blocking: true,
      reason: 'Missing provider-supplied route namespace, route nonce, topology hash, target-id hashes, and serialized graph call data needed to derive the launchIntentHash preimage.',
    },
    {
      code: 'PROVIDER_API_KEY_PENDING',
      path: '/provider/apiKey',
      blocking: false,
      reason: 'Provider preflight requires an authorized API key in the execution environment; the key is never persisted in this package.',
    },
    {
      code: 'OWNER_WALLET_FUNDING_PENDING',
      path: '/funding',
      blocking: false,
      reason: 'The owner must fund the launch wallet and bind the final nonce, gas parameters and deadline after provider preflight.',
    },
    {
      code: 'BUILDER_IDENTITY_PENDING',
      path: '/builder',
      blocking: true,
      reason: 'Missing: the builder public repository and contact. Resolve: bind the owner-provided public repository identity before preflight. Verified alternative: retain anonymous builder fields and block a provider-ready package.',
    },
  ];
}

function assemblePhaseThreeAddressDerivationDraft(launchInputs, addressManifest, materialization = null) {
  const unverified = phaseThreeDraftUnverified(launchInputs, addressManifest);
  const inputDigests = {
    launchInputsSha256: sha256CanonicalJson(launchInputs),
    addressManifestSha256: sha256CanonicalJson(addressManifest),
  };
  if (materialization) {
    inputDigests.materializedManifestSha256 = sha256CanonicalJson(materialization.materializedManifest);
    inputDigests.submissionSha256 = sha256CanonicalJson(materialization.submission);
  }
  const graphDraft = {
    schemaVersion: 'hookemon.phase3.graph-draft.v1',
    status: 'ADDRESS_DERIVATION_PENDING',
    inputDigests,
    chain: {
      chainId: launchInputs.chain.chainId,
      caip2: launchInputs.chain.caip2,
      graphFactory: launchInputs.chain.graphFactory,
      router: launchInputs.chain.launchAndStampV1Router,
      entrypoint: addressManifest.deployer.entrypoint,
    },
    graph: {
      targetCount: addressManifest.targets.length,
      compiler: cloneJson(addressManifest.compiler),
      targets: addressManifest.targets.map((target) => ({
        targetId: target.targetId,
        targetIndex: target.targetIndex,
        componentKind: target.componentKind,
        sourcePath: target.sourcePath,
        contractName: target.contractName,
        applicantSalt: target.applicantSalt,
        effectiveSalt: target.effectiveSalt,
        address: target.address,
        creationBytecodeHash: target.creationBytecodeHash,
        runtimeTemplateCodeHash: target.runtimeTemplateCodeHash,
        runtimeCodeHash: target.runtimeCodeHash,
        artifactSha256: target.artifactSha256,
        libraries: cloneJson(target.libraries),
      })),
      pool: cloneJson(materialization?.materializedManifest.preimages.pool ?? addressManifest.pool),
      requiredGraphCalls: cloneJson(addressManifest.requiredGraphCalls),
      postDeployAssertions: cloneJson(addressManifest.postDeployAssertions),
    },
    seed: {
      priceCandidates: cloneJson(launchInputs.pool.priceCandidates),
      permit2Allowance: cloneJson(launchInputs.seed.permit2Allowance),
      deadlinePolicy: cloneJson(launchInputs.seed.deadlinePolicy),
      refundAndDust: cloneJson(launchInputs.seed.refundAndDust),
    },
    metadata: cloneJson(launchInputs.metadata),
    openFacts: [...new Set([...launchInputs.openFacts, ...addressManifest.openFacts])],
    unverified,
  };
  const graphDraftBytes = stableJsonBytes(graphDraft);
  const packageManifest = {
    schemaVersion: 'hookemon.phase3.local-package-manifest.v1',
    status: 'ADDRESS_DERIVATION_PENDING',
    graphDraftSha256: sha256Bytes(graphDraftBytes),
    inputDigests: graphDraft.inputDigests,
    unverified,
  };
  return {
    mode: 'address-derivation-pending',
    createRequestSha256: null,
    unverified,
    materializedSubmission: materialization?.submission ?? null,
    files: [
      { path: 'README.md', bytes: Buffer.from(PHASE_THREE_DRAFT_README, 'utf8') },
      { path: 'graph-draft.json', bytes: graphDraftBytes },
      { path: 'package-manifest.json', bytes: stableJsonBytes(packageManifest) },
    ],
  };
}

function validateGraphTargets(targets, path) {
  if (targets.length < 3 || targets.length > 16) fail('GRAPH_TARGET_COUNT', path);
  const targetIds = new Set();
  let tokenCount = 0;
  let hookCount = 0;
  targets.forEach((target, index) => {
    if (targetIds.has(target.targetId)) fail('DUPLICATE_TARGET_ID', `${path}/${index}/targetId`);
    targetIds.add(target.targetId);
    if (target.componentKind === 'token') tokenCount += 1;
    if (target.componentKind === 'hook') hookCount += 1;
  });
  if (tokenCount !== 1) fail('GRAPH_TOKEN_COUNT', path);
  if (hookCount !== 1) fail('GRAPH_HOOK_COUNT', path);
  return targetIds;
}

function validateRelationships(launchInputs, addressManifest) {
  const targetIds = validateGraphTargets(addressManifest.targets, '/targets');
  for (const target of addressManifest.targets) {
    if (!hasOwn(launchInputs.salts, target.targetId)) fail('MISSING_PROPERTY', `/launchInputs/salts/${target.targetId}`);
    assertHex32(launchInputs.salts[target.targetId], `/launchInputs/salts/${target.targetId}`);
    for (const locator of [...target.constructorAddressLocators, ...target.initializerAddressLocators]) {
      if (!targetIds.has(locator.targetId)) fail('UNKNOWN_TARGET_REFERENCE', `/targets/${target.targetId}`);
    }
  }
  if (!targetIds.has(addressManifest.pool.tokenTargetId)) fail('UNKNOWN_TARGET_REFERENCE', '/addressManifest/pool/tokenTargetId');
  if (!targetIds.has(addressManifest.pool.hookTargetId)) fail('UNKNOWN_TARGET_REFERENCE', '/addressManifest/pool/hookTargetId');
  const tokenTarget = addressManifest.targets.find((target) => target.targetId === addressManifest.pool.tokenTargetId);
  const hookTarget = addressManifest.targets.find((target) => target.targetId === addressManifest.pool.hookTargetId);
  if (tokenTarget.componentKind !== 'token') fail('GRAPH_TOKEN_COUNT', '/addressManifest/pool/tokenTargetId');
  if (hookTarget.componentKind !== 'hook') fail('GRAPH_HOOK_COUNT', '/addressManifest/pool/hookTargetId');
  if (!sameStringSet(launchInputs.liquidityModel.targetIds, addressManifest.targets.map((target) => target.targetId))) {
    fail('INVALID_VALUE', '/launchInputs/liquidityModel/targetIds');
  }
  if (!sameAddress(launchInputs.launchWallet, addressManifest.sourceDescriptor.controllerWallet)) {
    fail('INVALID_VALUE', '/addressManifest/sourceDescriptor/controllerWallet');
  }
  const bundleHash = sha256CanonicalJson(addressManifest.sourceBundleManifest);
  if (addressManifest.sourceDescriptor.bundleContentSha256 !== bundleHash) {
    fail('HASH_MISMATCH', '/addressManifest/sourceDescriptor/bundleContentSha256');
  }
  if (launchInputs.projectMetadata.tokenMetadataBinding.tokenTargetId !== addressManifest.pool.tokenTargetId) {
    fail('INVALID_VALUE', '/launchInputs/projectMetadata/tokenMetadataBinding/tokenTargetId');
  }
}

function parseStandardInput(bytes, path) {
  let input;
  try {
    input = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', path);
  }
  assertObject(input, path);
  if (hasOwn(input, 'version')) fail('LAUNCH_PROFILE_MISMATCH', `${path}/version`);
  if (input.language !== 'Solidity') fail('LAUNCH_PROFILE_MISMATCH', `${path}/language`);
  assertObject(input.settings, `${path}/settings`);
  assertObject(input.settings.optimizer, `${path}/settings/optimizer`);
  if (input.settings.optimizer.enabled !== true || input.settings.optimizer.runs !== 1000) fail('LAUNCH_PROFILE_MISMATCH', `${path}/settings/optimizer`);
  if (input.settings.viaIR !== false) fail('LAUNCH_PROFILE_MISMATCH', `${path}/settings/viaIR`);
  if (input.settings.evmVersion !== 'cancun') fail('LAUNCH_PROFILE_MISMATCH', `${path}/settings/evmVersion`);
  assertObject(input.settings.metadata, `${path}/settings/metadata`);
  if (
    input.settings.metadata.appendCBOR !== false
    || input.settings.metadata.bytecodeHash !== 'none'
    || input.settings.metadata.useLiteralContent !== false
  ) fail('LAUNCH_PROFILE_MISMATCH', `${path}/settings/metadata`);
}

function compilerVersion(artifact, path) {
  if (typeof artifact.compiler?.version === 'string') return artifact.compiler.version;
  for (const field of ['metadata', 'rawMetadata']) {
    const value = artifact[field];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.compiler?.version === 'string') return value.compiler.version;
      continue;
    }
    if (typeof value !== 'string') continue;
    try {
      const metadata = JSON.parse(value);
      if (typeof metadata.compiler?.version === 'string') return metadata.compiler.version;
    } catch {
      fail('INVALID_JSON', `${path}/${field}`);
    }
  }
  fail('MISSING_PROPERTY', `${path}/compilerVersion`);
}

function artifactHex(value, path, { nonempty = true } = {}) {
  const hex = typeof value === 'string' ? value : value?.object;
  assertHex(hex, path, { nonempty });
  return hex;
}

function normalizeImmutableReferences(value, path) {
  if (value === undefined || value === null) return [];
  assertObject(value, path);
  return Object.entries(value)
    .sort(([left], [right]) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)
    .map(([immutableId, ranges]) => {
      assertString(immutableId, `${path}/${immutableId}`, /^(?:0|[1-9][0-9]*)$/);
      const normalizedRanges = assertArray(ranges, `${path}/${immutableId}`).map((range, index) => {
        const rangePath = `${path}/${immutableId}/${index}`;
        assertExactKeys(range, ['start', 'length'], rangePath);
        assertInteger(range.start, `${rangePath}/start`, { minimum: 0 });
        if (range.length !== 32) fail('INVALID_VALUE', `${rangePath}/length`);
        return { start: range.start, length: range.length };
      });
      return { immutableId, ranges: normalizedRanges };
    });
}

function buildArtifactTarget({ target, index, launchInputs, artifactDirectory, standardInputDirectory }) {
  const pointer = `/addressManifest/targets/${index}`;
  const artifactBytes = readFileInside(artifactDirectory, target.artifactPath, `${pointer}/artifactPath`);
  let artifact;
  try {
    artifact = JSON.parse(artifactBytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', `${pointer}/artifactPath`);
  }
  assertObject(artifact, `${pointer}/artifactPath`);
  const version = compilerVersion(artifact, `${pointer}/artifactPath`);
  if (version !== '0.8.26+commit.8a97fa7a') fail('COMPILER_VERSION', `${pointer}/artifactPath`);
  const creationBytecode = artifactHex(artifact.bytecode, `${pointer}/artifactPath/bytecode`);
  const deployedRuntime = artifactHex(artifact.deployedBytecode, `${pointer}/artifactPath/deployedBytecode`);
  const runtimeBytes = Buffer.from(deployedRuntime.slice(2), 'hex');
  const runtimeCodeHash = keccak256Hex(runtimeBytes);

  const standardInputBytes = readFileInside(standardInputDirectory, target.standardJsonInputPath, `${pointer}/standardJsonInputPath`);
  parseStandardInput(standardInputBytes, `${pointer}/standardJsonInputPath`);
  const immutableReferences = normalizeImmutableReferences(
    artifact.deployedBytecode?.immutableReferences ?? artifact.immutableReferences,
    `${pointer}/artifactPath/immutableReferences`,
  );
  const requestTarget = {
    targetId: target.targetId,
    applicantSalt: launchInputs.salts[target.targetId],
    creationBytecode,
    constructorArguments: target.constructorArguments,
    initializerCalldata: target.initializerCalldata,
    constructorAddressLocators: cloneJson(target.constructorAddressLocators),
    initializerAddressLocators: cloneJson(target.initializerAddressLocators),
    deploymentValueWei: target.deploymentValueWei,
    initializerValueWei: target.initializerValueWei,
    expectedRuntimeCodeHash: runtimeCodeHash,
    componentKind: target.componentKind,
    declaredHookPermissions: cloneJson(target.declaredHookPermissions),
  };
  const component = {
    targetId: target.targetId,
    compilationUnitId: target.compilationUnitId,
    sourcePath: target.sourcePath,
    contractName: target.contractName,
    constructorArguments: target.constructorArguments,
    runtimeMaterialization: {
      immutableReferences,
      runtimeImmutables: cloneJson(target.runtimeImmutables),
      deployedRuntimeCodeBase64: runtimeBytes.toString('base64'),
      deployedRuntimeCodeHash: runtimeCodeHash,
    },
  };
  return {
    requestTarget,
    component,
    compilationUnit: {
      compilationUnitId: target.compilationUnitId,
      compilerVersion: version,
      standardJsonInputBase64: standardInputBytes.toString('base64'),
      standardJsonInputSha256: sha256Bytes(standardInputBytes),
    },
    artifactDigest: {
      targetId: target.targetId,
      sha256: sha256CanonicalJson(artifact),
    },
    standardInputDigest: {
      compilationUnitId: target.compilationUnitId,
      sha256: sha256Bytes(standardInputBytes),
    },
  };
}

function buildVerificationBundle(builtTargets) {
  const units = new Map();
  for (const built of builtTargets) {
    const current = units.get(built.compilationUnit.compilationUnitId);
    if (current && canonicalJson(current) !== canonicalJson(built.compilationUnit)) {
      fail('DUPLICATE_COMPILATION_UNIT', `/verificationBundle/compilationUnits/${built.compilationUnit.compilationUnitId}`);
    }
    units.set(built.compilationUnit.compilationUnitId, built.compilationUnit);
  }
  return {
    schemaVersion: 'programmable.exact-source-verification-bundle.v2',
    compilationUnits: [...units.values()].sort((left, right) => left.compilationUnitId.localeCompare(right.compilationUnitId)),
    components: builtTargets.map((built) => built.component),
  };
}

function buildImageArtifact(launchInputs) {
  const bytes = Buffer.from(launchInputs.projectMetadataImage.base64, 'base64');
  return {
    schemaVersion: 'programmable.project-metadata-image-artifact.v1',
    mediaType: launchInputs.projectMetadataImage.mediaType,
    byteLength: String(bytes.length),
    contentSha256: sha256Bytes(bytes),
    base64: bytes.toString('base64'),
  };
}

function buildRequest({ launchInputs, addressManifest, artifactDirectory, standardInputDirectory }) {
  const builtTargets = addressManifest.targets.map((target, index) => buildArtifactTarget({
    target,
    index,
    launchInputs,
    artifactDirectory,
    standardInputDirectory,
  }));
  const sourceBundleSha256 = sha256CanonicalJson(addressManifest.sourceBundleManifest);
  const imageArtifact = buildImageArtifact(launchInputs);
  const metadataHash = sha256CanonicalJson(launchInputs.projectMetadata);
  const verificationBundle = buildVerificationBundle(builtTargets);
  const agentAttestation = {
    schemaVersion: launchInputs.agentAttestation.schemaVersion,
    subjectLaunchIntentHash: ZERO_SHA256,
    agentId: launchInputs.agentAttestation.agentId,
    checkedAt: launchInputs.agentAttestation.checkedAt,
    checks: cloneJson(launchInputs.agentAttestation.checks),
  };
  const request = {
    schemaVersion: 'programmable.custom-launch-create-request.v4',
    chainId: launchInputs.chainId,
    caip2: launchInputs.caip2,
    chainDeployment: cloneJson(addressManifest.chainDeployment),
    chainDeploymentDescriptorDigest: addressManifest.chainDeploymentDescriptorDigest,
    profile: cloneJson(addressManifest.profile),
    launchWallet: launchInputs.launchWallet,
    nonce: launchInputs.nonce,
    permitWindow: cloneJson(launchInputs.permitWindow),
    sourceDescriptor: cloneJson(addressManifest.sourceDescriptor),
    sourceBundleManifest: cloneJson(addressManifest.sourceBundleManifest),
    externalContracts: cloneJson(addressManifest.externalContracts),
    graphBundle: {
      schemaVersion: 'programmable.custom-graph-bundle.v1',
      sourceBundleSha256,
      targets: builtTargets.map((built) => built.requestTarget),
      pool: {
        tokenTargetId: addressManifest.pool.tokenTargetId,
        hookTargetId: addressManifest.pool.hookTargetId,
        fee: addressManifest.pool.fee,
        tickSpacing: launchInputs.tickSpacing,
      },
    },
    projectMetadata: cloneJson(launchInputs.projectMetadata),
    projectMetadataHash: metadataHash,
    projectMetadataImageArtifact: imageArtifact,
    verificationBundle,
    funding: cloneJson(launchInputs.funding),
    liquidityModel: cloneJson(launchInputs.liquidityModel),
    launchIntentHash: ZERO_SHA256,
    agentAttestation,
  };
  const unverified = [
    {
      code: 'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
      path: '/launchIntentHash',
      blocking: true,
      reason: 'The saved provider material does not define the launch-intent hash preimage; local integrity verification remains valid, but provider preflight is not ready.',
    },
    {
      code: 'UNVERIFIED_SOURCE_BUNDLE_PREIMAGE',
      path: '/sourceDescriptor/bundleContentSha256',
      blocking: false,
      reason: 'The local source-manifest canonicalization is deterministic but not a retained provider preimage.',
    },
    {
      code: 'UNVERIFIED_METADATA_PREIMAGE',
      path: '/projectMetadataHash',
      blocking: false,
      reason: 'The local metadata canonicalization is deterministic but not a retained provider preimage.',
    },
    {
      code: 'UNVERIFIED_VERIFICATION_COMPONENT_COVERAGE',
      path: '/verificationBundle/components',
      blocking: false,
      reason: 'The saved V4 bundle description refers to five graph targets while the frozen project model has three.',
    },
    {
      code: 'UNVERIFIED_EXTERNAL_DESCRIPTOR_PREIMAGE',
      path: '/chainDeploymentDescriptorDigest',
      blocking: false,
      reason: 'The descriptor digest is preserved from the frozen address manifest and cannot be rederived locally.',
    },
  ];
  return { request, unverified, builtTargets, sourceBundleSha256, metadataHash };
}

function markdown(title, lines) {
  return Buffer.from(`# ${title}\n\n${lines.join('\n')}\n`, 'utf8');
}

function centralPackageFiles(request, createRequestSha256, unverified) {
  const targetSummary = request.graphBundle.targets.map((target) => `${target.targetId} (${target.componentKind})`).join(', ');
  const application = {
    schemaVersion: 'hookemon.programmable-local-central-application.v1',
    status: 'LOCAL_DRAFT_NOT_PREFLIGHT_READY',
    createRequestSha256,
    sourceBundleSha256: request.graphBundle.sourceBundleSha256,
    launchIntentHash: request.launchIntentHash,
  };
  const compatibility = {
    schemaVersion: 'hookemon.programmable-local-compatibility-report.v1',
    status: 'UNVERIFIED',
    checks: [
      { id: 'request-shape', status: 'PASSED' },
      { id: 'launch-intent-preimage', status: 'UNVERIFIED' },
      { id: 'central-application-schema', status: 'UNVERIFIED' },
    ],
  };
  const evidenceIndex = {
    schemaVersion: 'hookemon.programmable-local-evidence-index.v1',
    requestSha256: createRequestSha256,
    sourceBundleSha256: request.graphBundle.sourceBundleSha256,
    runtimeCodeHashes: request.graphBundle.targets.map((target) => ({
      targetId: target.targetId,
      expectedRuntimeCodeHash: target.expectedRuntimeCodeHash,
    })),
    unverified,
  };
  return [
    { path: 'central-package/application.json', bytes: stableJsonBytes(application) },
    {
      path: 'central-package/PROPOSAL.md',
      bytes: markdown('Local programmable launch package', [
        'This deterministic local rendering binds the frozen inputs without creating, signing, or sending a request.',
        `Graph targets: ${targetSummary}.`,
        'The launch-intent commitment remains unresolved and this package is not ready for provider preflight.',
      ]),
    },
    {
      path: 'central-package/TEST_PLAN.md',
      bytes: markdown('Local verification plan', [
        'Rebuild from the frozen artifacts and Standard JSON inputs.',
        'Recompute artifact, image, source-manifest, runtime, and package hashes.',
        'Reject any unresolved launch-intent commitment before preflight.',
      ]),
    },
    {
      path: 'central-package/THREAT_MODEL.md',
      bytes: markdown('Local threat model', [
        'The generator reads no credentials and does not contact a provider.',
        'The verifier rejects changed bytecode, source inputs, package fields, graph composition, and funding mode.',
        'A local package does not establish admission, authorization, wallet approval, or deployment readiness.',
      ]),
    },
    { path: 'central-package/compatibility-report.json', bytes: stableJsonBytes(compatibility) },
    { path: 'central-package/evidence-index.json', bytes: stableJsonBytes(evidenceIndex) },
  ];
}

function assemblePackage(options) {
  const artifactDirectory = options.artifactDirectory;
  const standardInputDirectory = options.standardInputDirectory;
  const launchInputsPath = options.launchInputsPath;
  const addressManifestPath = options.addressManifestPath;
  const launchInputFile = readJsonFile(launchInputsPath, '/launchInputs');
  const addressManifestFile = readJsonFile(addressManifestPath, '/addressManifest');
  const launchInputs = launchInputFile.value;
  const addressManifest = addressManifestFile.value;
  assertDirectory(artifactDirectory, '/artifactDirectory');
  assertDirectory(standardInputDirectory, '/standardInputDirectory');
  if (isPhaseThreeAddressDerivationDraft(launchInputs, addressManifest)) {
    const materialization = materializePhaseThreeDraft(options, launchInputs, addressManifest);
    const materializedLaunchInputs = materialization?.launchInputs ?? launchInputs;
    validatePhaseThreeAddressDerivationDraft(materializedLaunchInputs, addressManifest, artifactDirectory);
    validatePhaseThreeBuildEvidence(artifactDirectory, standardInputDirectory, addressManifest);
    return assemblePhaseThreeAddressDerivationDraft(materializedLaunchInputs, addressManifest, materialization);
  }
  if (Object.hasOwn(options, 'phaseThreeMaterialization')) fail('INVALID_VALUE', '/phaseThreeMaterialization');
  validateLaunchInputs(launchInputs);
  validateAddressManifest(addressManifest);
  validateRelationships(launchInputs, addressManifest);
  const rendered = buildRequest({ launchInputs, addressManifest, artifactDirectory, standardInputDirectory });
  const requestBytes = stableJsonBytes(rendered.request);
  const createRequestSha256 = sha256Bytes(requestBytes);
  const centralFiles = centralPackageFiles(rendered.request, createRequestSha256, rendered.unverified);
  const packageManifest = {
    schemaVersion: 'hookemon.programmable-local-package-manifest.v1',
    status: 'LOCAL_DRAFT_NOT_PREFLIGHT_READY',
    createRequestSha256,
    inputDigests: {
      launchInputsSha256: sha256CanonicalJson(launchInputs),
      addressManifestSha256: sha256CanonicalJson(addressManifest),
      artifacts: rendered.builtTargets.map((target) => target.artifactDigest),
      standardJsonInputs: rendered.builtTargets.map((target) => target.standardInputDigest),
    },
    computed: {
      sourceBundleSha256: rendered.sourceBundleSha256,
      projectMetadataHash: rendered.metadataHash,
      launchIntentHash: rendered.request.launchIntentHash,
    },
    centralPackage: {
      files: centralFiles.map((file) => ({ path: file.path.replace('central-package/', ''), sha256: sha256Bytes(file.bytes) })),
    },
    unverified: rendered.unverified,
  };
  return {
    mode: 'provider-request-draft',
    createRequestSha256,
    unverified: rendered.unverified,
    request: rendered.request,
    files: [
      { path: 'create-request.json', bytes: requestBytes },
      { path: 'package-manifest.json', bytes: stableJsonBytes(packageManifest) },
      ...centralFiles,
    ],
  };
}

function writePackage(outputDirectory, files) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) fail('INVALID_PATH', '/outputDirectory');
  const output = resolve(outputDirectory);
  if (existsSync(output)) fail('OUTPUT_EXISTS', '/outputDirectory');
  const parent = dirname(output);
  try {
    if (!lstatSync(parent).isDirectory()) fail('EXPECTED_DIRECTORY', '/outputDirectory');
  } catch (error) {
    if (error instanceof PackageValidationError) throw error;
    fail('INPUT_READ_FAILED', '/outputDirectory');
  }
  const staging = mkdtempSync(join(parent, `.${basename(output)}.tmp-`));
  try {
    for (const file of files) {
      const destination = resolve(staging, file.path);
      if (!destination.startsWith(`${staging}/`)) fail('INVALID_PATH', '/outputDirectory');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes, { flag: 'wx' });
    }
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof PackageValidationError) throw error;
    fail('OUTPUT_WRITE_FAILED', '/outputDirectory');
  }
}

function collectPackageFiles(directory) {
  assertDirectory(directory, '/packageDirectory');
  const root = resolve(directory);
  const files = new Map();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      const outputPath = relative(root, absolute).replaceAll('\\', '/');
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('INVALID_PACKAGE_ENTRY', `/${outputPath}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.set(outputPath, readFileSync(absolute));
      else fail('INVALID_PACKAGE_ENTRY', `/${outputPath}`);
    }
  };
  visit(root);
  return files;
}

function parsePackageJson(files, path) {
  const bytes = files.get(path);
  if (!bytes) fail('MISSING_PACKAGE_FILE', `/${path}`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', `/${path}`);
  }
}

function validateGraphBundle(value, path) {
  assertExactKeys(value, ['schemaVersion', 'sourceBundleSha256', 'targets', 'pool'], path);
  if (value.schemaVersion !== 'programmable.custom-graph-bundle.v1') fail('INVALID_VALUE', `${path}/schemaVersion`);
  assertHash(value.sourceBundleSha256, `${path}/sourceBundleSha256`);
  const targets = assertArray(value.targets, `${path}/targets`);
  targets.forEach((target, index) => {
    const targetPath = `${path}/targets/${index}`;
    assertExactKeys(target, TARGET_KEYS, targetPath);
    assertIdentifier(target.targetId, `${targetPath}/targetId`);
    assertHex32(target.applicantSalt, `${targetPath}/applicantSalt`);
    assertHex(target.creationBytecode, `${targetPath}/creationBytecode`, { nonempty: true });
    assertHex(target.constructorArguments, `${targetPath}/constructorArguments`);
    assertHex(target.initializerCalldata, `${targetPath}/initializerCalldata`);
    validateLocators(target.constructorAddressLocators, `${targetPath}/constructorAddressLocators`);
    validateLocators(target.initializerAddressLocators, `${targetPath}/initializerAddressLocators`);
    assertAmount(target.deploymentValueWei, `${targetPath}/deploymentValueWei`);
    assertAmount(target.initializerValueWei, `${targetPath}/initializerValueWei`);
    assertHex32(target.expectedRuntimeCodeHash, `${targetPath}/expectedRuntimeCodeHash`, { nonzero: true });
    if (!COMPONENT_KINDS.has(target.componentKind)) fail('INVALID_VALUE', `${targetPath}/componentKind`);
    validateHookPermissions(target.declaredHookPermissions, `${targetPath}/declaredHookPermissions`, target.componentKind);
  });
  const targetIds = validateGraphTargets(targets, `${path}/targets`);
  assertExactKeys(value.pool, ['tokenTargetId', 'hookTargetId', 'fee', 'tickSpacing'], `${path}/pool`);
  assertIdentifier(value.pool.tokenTargetId, `${path}/pool/tokenTargetId`);
  assertIdentifier(value.pool.hookTargetId, `${path}/pool/hookTargetId`);
  assertInteger(value.pool.fee, `${path}/pool/fee`, { minimum: 0, maximum: 8_388_608 });
  assertInteger(value.pool.tickSpacing, `${path}/pool/tickSpacing`, { minimum: 1, maximum: 32_767 });
  if (!targetIds.has(value.pool.tokenTargetId) || !targetIds.has(value.pool.hookTargetId)) fail('UNKNOWN_TARGET_REFERENCE', `${path}/pool`);
}

function validateVerificationBundle(value, path) {
  assertExactKeys(value, ['schemaVersion', 'compilationUnits', 'components'], path);
  if (value.schemaVersion !== 'programmable.exact-source-verification-bundle.v2') fail('INVALID_VALUE', `${path}/schemaVersion`);
  const units = assertArray(value.compilationUnits, `${path}/compilationUnits`);
  if (units.length === 0 || units.length > 16) fail('INVALID_VALUE', `${path}/compilationUnits`);
  const unitIds = new Set();
  units.forEach((unit, index) => {
    const unitPath = `${path}/compilationUnits/${index}`;
    assertExactKeys(unit, ['compilationUnitId', 'compilerVersion', 'standardJsonInputBase64', 'standardJsonInputSha256'], unitPath);
    assertIdentifier(unit.compilationUnitId, `${unitPath}/compilationUnitId`);
    if (unitIds.has(unit.compilationUnitId)) fail('DUPLICATE_COMPILATION_UNIT', `${unitPath}/compilationUnitId`);
    unitIds.add(unit.compilationUnitId);
    assertString(unit.compilerVersion, `${unitPath}/compilerVersion`, /^0\.[0-9]+\.[0-9]+\+commit\.[0-9a-f]{8}$/);
    const bytes = assertBase64(unit.standardJsonInputBase64, `${unitPath}/standardJsonInputBase64`);
    if (unit.standardJsonInputSha256 !== sha256Bytes(bytes)) fail('HASH_MISMATCH', `${unitPath}/standardJsonInputSha256`);
  });
  const components = assertArray(value.components, `${path}/components`);
  if (components.length === 0 || components.length > 16) fail('INVALID_VALUE', `${path}/components`);
  const componentIds = new Set();
  components.forEach((component, index) => {
    const componentPath = `${path}/components/${index}`;
    assertExactKeys(component, ['targetId', 'compilationUnitId', 'sourcePath', 'contractName', 'constructorArguments', 'runtimeMaterialization'], componentPath);
    assertIdentifier(component.targetId, `${componentPath}/targetId`);
    if (componentIds.has(component.targetId)) fail('DUPLICATE_TARGET_ID', `${componentPath}/targetId`);
    componentIds.add(component.targetId);
    assertIdentifier(component.compilationUnitId, `${componentPath}/compilationUnitId`);
    if (!unitIds.has(component.compilationUnitId)) fail('UNKNOWN_COMPILATION_UNIT', `${componentPath}/compilationUnitId`);
    assertString(component.sourcePath, `${componentPath}/sourcePath`);
    assertIdentifier(component.contractName, `${componentPath}/contractName`);
    assertHex(component.constructorArguments, `${componentPath}/constructorArguments`);
    const materializationPath = `${componentPath}/runtimeMaterialization`;
    assertExactKeys(component.runtimeMaterialization, ['immutableReferences', 'runtimeImmutables', 'deployedRuntimeCodeBase64', 'deployedRuntimeCodeHash'], materializationPath);
    assertArray(component.runtimeMaterialization.immutableReferences, `${materializationPath}/immutableReferences`);
    assertArray(component.runtimeMaterialization.runtimeImmutables, `${materializationPath}/runtimeImmutables`);
    const runtimeBytes = assertBase64(component.runtimeMaterialization.deployedRuntimeCodeBase64, `${materializationPath}/deployedRuntimeCodeBase64`);
    if (runtimeBytes.length === 0) fail('INVALID_VALUE', `${materializationPath}/deployedRuntimeCodeBase64`);
    const runtimeHash = keccak256Hex(runtimeBytes);
    if (component.runtimeMaterialization.deployedRuntimeCodeHash !== runtimeHash) fail('HASH_MISMATCH', `${materializationPath}/deployedRuntimeCodeHash`);
  });
}

function validateRequest(request) {
  assertExactKeys(request, REQUEST_KEYS, '');
  if (request.schemaVersion !== 'programmable.custom-launch-create-request.v4') fail('INVALID_VALUE', '/schemaVersion');
  if (request.chainId !== '4663') fail('INVALID_VALUE', '/chainId');
  if (request.caip2 !== 'eip155:4663') fail('INVALID_VALUE', '/caip2');
  assertObject(request.chainDeployment, '/chainDeployment');
  if (request.chainDeployment.schemaVersion !== 'programmable.custom-launch-chain-deployment.v1') fail('INVALID_VALUE', '/chainDeployment/schemaVersion');
  if (request.chainDeployment.chainId !== '4663') fail('INVALID_VALUE', '/chainDeployment/chainId');
  if (request.chainDeployment.caip2 !== 'eip155:4663') fail('INVALID_VALUE', '/chainDeployment/caip2');
  assertHex32(request.chainDeploymentDescriptorDigest, '/chainDeploymentDescriptorDigest', { nonzero: true });
  assertObject(request.profile, '/profile');
  if (request.profile.schemaVersion !== 'programmable.custom-launch-profile-ref.v4') fail('INVALID_VALUE', '/profile/schemaVersion');
  assertAddress(request.launchWallet, '/launchWallet');
  assertHex32(request.nonce, '/nonce', { nonzero: true });
  validatePermitWindow(request.permitWindow, '/permitWindow');
  validateSourceDescriptor(request.sourceDescriptor, '/sourceDescriptor');
  validateSourceBundleManifest(request.sourceBundleManifest, '/sourceBundleManifest');
  validateExternalContracts(request.externalContracts, '/externalContracts');
  validateGraphBundle(request.graphBundle, '/graphBundle');
  validateProjectMetadata(request.projectMetadata, '/projectMetadata', assertBase64(request.projectMetadataImageArtifact.base64, '/projectMetadataImageArtifact/base64'));
  assertHash(request.projectMetadataHash, '/projectMetadataHash');
  assertExactKeys(request.projectMetadataImageArtifact, ['schemaVersion', 'mediaType', 'byteLength', 'contentSha256', 'base64'], '/projectMetadataImageArtifact');
  if (request.projectMetadataImageArtifact.schemaVersion !== 'programmable.project-metadata-image-artifact.v1') fail('INVALID_VALUE', '/projectMetadataImageArtifact/schemaVersion');
  if (!['image/png', 'image/gif'].includes(request.projectMetadataImageArtifact.mediaType)) fail('INVALID_VALUE', '/projectMetadataImageArtifact/mediaType');
  assertAmount(request.projectMetadataImageArtifact.byteLength, '/projectMetadataImageArtifact/byteLength');
  assertHash(request.projectMetadataImageArtifact.contentSha256, '/projectMetadataImageArtifact/contentSha256');
  const imageBytes = assertBase64(request.projectMetadataImageArtifact.base64, '/projectMetadataImageArtifact/base64');
  if (request.projectMetadataImageArtifact.contentSha256 !== sha256Bytes(imageBytes)) fail('HASH_MISMATCH', '/projectMetadataImageArtifact/contentSha256');
  if (request.projectMetadataImageArtifact.byteLength !== String(imageBytes.length)) fail('INVALID_VALUE', '/projectMetadataImageArtifact/byteLength');
  validateVerificationBundle(request.verificationBundle, '/verificationBundle');
  validateFunding(request.funding, '/funding');
  validateLiquidityModel(request.liquidityModel, '/liquidityModel');
  assertHash(request.launchIntentHash, '/launchIntentHash');
  assertExactKeys(request.agentAttestation, ['schemaVersion', 'subjectLaunchIntentHash', 'agentId', 'checkedAt', 'checks'], '/agentAttestation');
  if (request.agentAttestation.schemaVersion !== 'programmable.agent-launch-attestation.v2') fail('INVALID_VALUE', '/agentAttestation/schemaVersion');
  assertHash(request.agentAttestation.subjectLaunchIntentHash, '/agentAttestation/subjectLaunchIntentHash');
  if (request.agentAttestation.subjectLaunchIntentHash !== request.launchIntentHash) fail('HASH_MISMATCH', '/agentAttestation/subjectLaunchIntentHash');
  validateAttestationTemplate({
    schemaVersion: request.agentAttestation.schemaVersion,
    agentId: request.agentAttestation.agentId,
    checkedAt: request.agentAttestation.checkedAt,
    checks: request.agentAttestation.checks,
  }, '/agentAttestation');
}

function verifyDerivedRequestHashes(request) {
  const sourceBundleHash = sha256CanonicalJson(request.sourceBundleManifest);
  if (request.sourceDescriptor.bundleContentSha256 !== sourceBundleHash) fail('HASH_MISMATCH', '/sourceDescriptor/bundleContentSha256');
  if (request.graphBundle.sourceBundleSha256 !== sourceBundleHash) fail('HASH_MISMATCH', '/graphBundle/sourceBundleSha256');
  const metadataHash = sha256CanonicalJson(request.projectMetadata);
  if (request.projectMetadataHash !== metadataHash) fail('HASH_MISMATCH', '/projectMetadataHash');
  const targets = new Map(request.graphBundle.targets.map((target, index) => [target.targetId, { target, index }]));
  for (const component of request.verificationBundle.components) {
    const graphTarget = targets.get(component.targetId);
    if (!graphTarget) fail('UNKNOWN_TARGET_REFERENCE', '/verificationBundle/components');
    const hash = component.runtimeMaterialization.deployedRuntimeCodeHash;
    if (graphTarget.target.expectedRuntimeCodeHash !== hash) {
      fail('HASH_MISMATCH', `/graphBundle/targets/${graphTarget.index}/expectedRuntimeCodeHash`);
    }
  }
}

function compareExpectedFiles(actualFiles, expectedFiles) {
  const expectedPaths = new Set(expectedFiles.map((file) => file.path));
  for (const path of [...actualFiles.keys()].sort()) if (!expectedPaths.has(path)) fail('UNEXPECTED_PACKAGE_FILE', `/${path}`);
  for (const expected of expectedFiles) {
    const actual = actualFiles.get(expected.path);
    if (!actual) fail('MISSING_PACKAGE_FILE', `/${expected.path}`);
    if (!actual.equals(expected.bytes)) fail('PACKAGE_FILE_MISMATCH', `/${expected.path}`);
  }
}

export function buildLaunchPackage(options) {
  const assembled = assemblePackage(options);
  writePackage(options.outputDirectory, assembled.files);
  const result = {
    mode: assembled.mode,
    createRequestSha256: assembled.createRequestSha256,
    fileCount: assembled.files.length,
    unverified: assembled.unverified,
  };
  if (assembled.materializedSubmission !== null && assembled.materializedSubmission !== undefined) {
    result.materializedSubmission = assembled.materializedSubmission;
  }
  return result;
}

export function verifyLaunchPackage(options) {
  const assembled = assemblePackage(options);
  const actualFiles = collectPackageFiles(options.packageDirectory);
  const packageManifest = parsePackageJson(actualFiles, 'package-manifest.json');
  if (packageManifest.schemaVersion === 'hookemon.phase3.local-package-manifest.v1') {
    const graphDraft = parsePackageJson(actualFiles, 'graph-draft.json');
    if (graphDraft.schemaVersion !== 'hookemon.phase3.graph-draft.v1') fail('INVALID_VALUE', '/graph-draft.json/schemaVersion');
    if (graphDraft.status !== 'ADDRESS_DERIVATION_PENDING') fail('INVALID_VALUE', '/graph-draft.json/status');
    compareExpectedFiles(actualFiles, assembled.files);
    const blocking = assembled.unverified.find((entry) => entry.blocking);
    if (blocking && !options.allowUnverified) fail('UNVERIFIED_COMMITMENT', blocking.path);
    if (!options.allowUnverified) fail('UNVERIFIED_COMMITMENT', '/readyForPreflight');
    return {
      ok: true,
      mode: assembled.mode,
      readyForPreflight: false,
      createRequestSha256: null,
      unverified: assembled.unverified,
    };
  }
  const actualRequest = parsePackageJson(actualFiles, 'create-request.json');
  validateRequest(actualRequest);
  verifyDerivedRequestHashes(actualRequest);
  compareExpectedFiles(actualFiles, assembled.files);
  const blocking = assembled.unverified.find((entry) => entry.blocking);
  if (blocking && !options.allowUnverified) fail('UNVERIFIED_COMMITMENT', blocking.path);
  return {
    ok: true,
    mode: assembled.mode,
    readyForPreflight: assembled.unverified.length === 0,
    createRequestSha256: assembled.createRequestSha256,
    unverified: assembled.unverified,
  };
}

export function cliErrorPayload(error) {
  if (error instanceof PackageValidationError) return { ok: false, code: error.code, path: error.path };
  return { ok: false, code: 'UNEXPECTED_ERROR' };
}
