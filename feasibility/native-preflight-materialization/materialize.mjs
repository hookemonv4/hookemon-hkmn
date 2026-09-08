import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const cli = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass the extracted, checksum-verified official CLI 4.1.0 package directory');
const provenance = JSON.parse(await readFile('feasibility/native-preflight-materialization/sources.json', 'utf8'));
for (const [path, expected] of Object.entries(provenance.officialCli.moduleSha256)) {
  if (createHash('sha256').update(await readFile(resolve(cli, path))).digest('hex') !== expected) throw new Error(`Official CLI file mismatch: ${path}`);
}
const module = name => import(pathToFileURL(resolve(cli, 'src', name)));
const { buildProjectMetadata, buildProjectMetadataImageArtifactV4 } = await module('project-metadata.mjs');
const { buildSourceBundle } = await module('source-bundle.mjs');
const { canonicalizeJson } = await module('canonical-json.mjs');
const { hashV4ChainDeployment, v4GraphChainContext } = await module('v4-contract.mjs');
const { normalizeRuntimeMaterialization, materializeRuntimeCode } = await module('runtime-immutables.mjs');
const { deriveRouteNamespace } = await module('graph.mjs');
const { assertRobinhoodNativeFeeKernelBuildV1 } = await module('robinhood-native-fee-v1.mjs');
const { keccak256 } = await import(pathToFileURL(resolve(cli, 'node_modules/viem/_esm/index.js')));
const root = process.cwd(), out = 'feasibility/native-preflight-materialization';
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, v) => writeFile(`${out}/${p}`, JSON.stringify(v, null, 2) + '\n');
const request = await read('release/phase3/package/create-request.json');
const original = structuredClone(request);
const inputs = await read('release/phase3/launch-inputs.json');
const descriptor = await read('feasibility/native-provider-admission/chain-deployment-preimage.json');
const actualDescriptorHash = hashV4ChainDeployment(descriptor.chainDeployment);
if (actualDescriptorHash !== descriptor.chainDeploymentDescriptorDigest) throw new Error('Published chain deployment hash does not recompute');
request.chainDeployment = descriptor.chainDeployment;
request.externalContracts = [];
request.nonce = '0x' + createHash('sha256').update(await readFile('release/phase3/package/create-request.json')).digest('hex');
const checkpoint = (await read(`${out}/finalized-block-response.json`)).result;
if (!checkpoint?.timestamp) throw new Error('Finalized checkpoint missing');
const timestamp = BigInt(checkpoint.timestamp);
request.permitWindow = { validAfter: String(timestamp - 60n), deadline: String(timestamp - 60n + 3600n) };
request.chainDeploymentDescriptorDigest = actualDescriptorHash;
const artifact = await read('release/phase3/artifacts/token.json');
const metadataInput = { schemaVersion: 'programmable.project-metadata-input.v1', token: { name: inputs.metadata.name, symbol: inputs.metadata.symbol },
  presentation: { description: inputs.metadata.description, image: { sourcePath: 'apps/web/public/comic/coin.png', uri: 'https://hookemon.com/comic/coin.png' },
    links: [{ kind: 'website', uri: new URL(inputs.metadata.website).href }, { kind: 'x', uri: inputs.metadata.x }] } };
const metadata = await buildProjectMetadata(metadataInput, { sourceRoot: root, requireComplete: true,
  tokenTarget: { targetId: 'token', componentKind: 'token', abi: artifact.abi, constructorArguments: [], initializer: null } });
request.projectMetadata = metadata.projectMetadata;
request.projectMetadataHash = metadata.projectMetadataHash;
request.projectMetadataImageArtifact = await buildProjectMetadataImageArtifactV4({ sourceRoot: root, sourcePath: metadata.imageSourcePath, projectMetadata: metadata.projectMetadata });
request.fundingPlan = { schemaVersion: 'programmable.robinhood-funding-plan.v1', capitalSource: 'custom', pricingModel: 'concentrated-liquidity',
  nativeAllocations: { initialLiquidityWei: '0', initialBuyWei: '0', reserveWei: '0', otherLaunchValueWei: '0' }, maxLaunchValueWei: '0', maxGasCostWei: '0', launchMode: 'build-only' };
request.liquidityModel.declaredLaunchState = 'pool-initialized-empty';
const coverage = (await read('release/phase3/package/package-manifest.json')).sourceBundleCoverage;
const paths = [...coverage.sourcePaths, ...coverage.compilerArtifactPaths, ...coverage.standardJsonInputPaths,
  metadata.imageSourcePath, 'feasibility/native-provider-admission/inspection.json'];
const bundle = await buildSourceBundle(root, paths);
request.sourceBundleManifest = bundle.manifest;
const sourceRevision = 'e21bccdf5b6af56742f1999255e334750d8e6efb';
for (const path of paths) {
  const committed = execFileSync('git', ['show', `${sourceRevision}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
  if (!committed.equals(await readFile(path))) throw new Error(`Source differs from pinned origin: ${path}`);
}
const origin = { url: 'https://github.com/hookemonv4/hookemon-hkmn', revision: sourceRevision };
const originBytes = Buffer.concat([Buffer.from('programmable.public-source-origin.v1'), Buffer.from([0]), Buffer.from(canonicalizeJson(origin))]);
request.sourceDescriptor = { schemaVersion: '2.0.0', kind: 'deterministic-source-bundle', controllerWallet: request.launchWallet,
  sourceLineageNonce: '1', sourceBundleDigest: bundle.sourceBundleDigest, bundleContentSha256: bundle.bundleContentSha256,
  publicOriginCommitment: keccak256(`0x${originBytes.toString('hex')}`) };
request.graphBundle.sourceBundleSha256 = bundle.bundleContentSha256;
request.graphBundle.targets[0].constructorAddressLocators = [];
request.graphBundle.targets[0].initializerAddressLocators = [{ targetId: 'hook', byteOffset: 4, encoding: 'abi-address-word' }];
request.graphBundle.targets[1].initializerAddressLocators = [{ targetId: 'hook', byteOffset: 4, encoding: 'abi-address-word' }];
request.graphBundle.targets[2].constructorAddressLocators = [{ targetId: 'token', byteOffset: 128, encoding: 'abi-address-word' }];
request.graphBundle.targets[2].initializerAddressLocators = [{ targetId: 'custody', byteOffset: 4, encoding: 'abi-address-word' }];
request.graphBundle.targets[0].applicantSalt = `0x${'01'.repeat(32)}`;
request.graphBundle.targets[1].applicantSalt = `0x${'02'.repeat(32)}`;
const custody = await read('release/phase3/artifacts/custody.json');
const custodyContract = custody.ast.nodes.find(node => node.nodeType === 'ContractDefinition' && node.name === 'PermanentPositionCustody');
for (const [id, name] of [['10893', 'deployer'], ['10895', 'positionManager']]) {
  if (!custodyContract.nodes.some(node => String(node.id) === id && node.name === name && node.mutability === 'immutable')) throw new Error(`Unverified custody immutable: ${id}`);
}
const custodyPlan = normalizeRuntimeMaterialization({ runtimeCode: custody.deployedBytecode.object,
  immutableReferences: custody.deployedBytecode.immutableReferences,
  runtimeImmutables: [
    { immutableId: '10893', abiType: 'address', literal: descriptor.chainDeployment.contracts.graphFactory.address },
    { immutableId: '10895', abiType: 'address', literal: descriptor.chainDeployment.contracts.positionManager.address },
  ], label: 'custody' });
const custodyRuntime = materializeRuntimeCode(custodyPlan, new Map(), 'custody');
request.graphBundle.targets[1].expectedRuntimeCodeHash = keccak256(custodyRuntime);
request.verificationBundle.components[1].runtimeMaterialization = {
  immutableReferences: custodyPlan.immutableReferences, runtimeImmutables: custodyPlan.runtimeImmutables,
  deployedRuntimeCodeBase64: Buffer.from(custodyRuntime.slice(2), 'hex').toString('base64'), deployedRuntimeCodeHash: keccak256(custodyRuntime),
};
const hook = await read('release/phase3/artifacts/hook.json');
let kernelCheck;
try { assertRobinhoodNativeFeeKernelBuildV1({ target: { sourcePath: 'packages/contracts/src/HookemonHook.sol', contractName: 'HookemonHook', compilerVersion: '0.8.26+commit.8a97fa7a', creationBytecode: hook.bytecode.object, runtimeCode: hook.deployedBytecode.object }, unit: { standardJsonInput: await read('release/phase3/build-info/launch.json') } }); kernelCheck = { accepted: true }; }
catch (error) { kernelCheck = { accepted: false, code: error.code, message: error.message }; }
await save('proposed-create-request.json', request);
await save('metadata-input.json', metadataInput);
await save('derived-source-coordinates.json', { sourceRevision, publicOrigin: origin, publicationVerified: false, nonceStatus: 'Proposed deterministic build-only replay coordinate: SHA256 of original request bytes. Not a wallet nonce or funded launch choice.', permitWindowStatus: 'Official example finalized timestamp minus60, plus3600; refresh before preflight. Not seed deadline.', sourceLineageNonceStatus: 'Proposed build-only lineage coordinate from official example default; not a final lineage selection.',
  chainDeploymentHashVerified: actualDescriptorHash,
  routeNamespace: deriveRouteNamespace(bundle.bundleContentSha256, request.launchWallet, v4GraphChainContext(descriptor.chainDeployment)),
  applicantSaltStatus: 'Proposed public build-only fixed salts 0x01 repeated for token and 0x02 repeated for custody; documented fixed-salt syntax, not final address selections. Hook requires documented permission grind after constructor inputs exist.',
  routeNonceRule: 'official graph uses applicant request.nonce; choose a fresh public bytes32 before final packing',
  officialCliKernelCheck: kernelCheck,
  filledRootFields: Object.keys(original).filter(k => original[k] === null && request[k] !== null) });
console.log(JSON.stringify({ chainDeploymentHashVerified: actualDescriptorHash, kernelCheck, sourceEntryCount: bundle.manifest.entries.length }));
