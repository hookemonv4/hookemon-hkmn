import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`API input preparation: ${message}`); };
const forbidden = /(^|\/)(?:\.env(?:\..*)?|\.git|\.session|\.v4|node_modules|.*\.(?:pem|key|p12|keystore))($|\/)/i;
const standardPath = 'release/phase3/build-info/launch.json';
const manifestPath = 'release/phase3/address-manifest.json';
const artifactPath = id => `release/phase3/artifacts/${id}.json`;
const moduleHashes = {
  'v4-contract.mjs': 'f941e96560e9dca279d73845bfb0358ef86ef58d107936a2240a39e4b3959b08',
  'source-bundle.mjs': '17059a88e1e08c16ba60b18de30dba0023036bcdf424ec2bd0f8f6a4fd6ba624',
  'project-metadata.mjs': '22706fb75729093025cdc1fa1fb10ac69864d3f680b0eee8cbdf0910035d1214',
  'robinhood-native-fee-v1.mjs': '603b82fbc9914076963cda4102ee10f256d7ce0f29065b003b744fd7b09ad53a',
};

export function safeInputPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\')
    || name.split('/').some(part => !part || part === '.' || part === '..') || forbidden.test(name)) fail('unsafe source path');
  let path = root;
  for (const part of name.split('/')) {
    path = resolve(path, part);
    if (lstatSync(path).isSymbolicLink()) fail('linked source path');
  }
  if (!lstatSync(path).isFile()) fail('source path is not a regular file');
  return path;
}
function regularInput(path) {
  const full = resolve(path);
  if (forbidden.test(full)) fail('credential or private input path refused');
  let cursor = full;
  while (cursor !== dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) fail('linked input path');
    cursor = dirname(cursor);
  }
  if (!lstatSync(full).isFile()) fail('input must be a regular file');
  return readFileSync(full);
}
export function checkCapabilities(capabilities) {
  if (capabilities?.chain?.id !== '4663' || capabilities.chain.caip2 !== 'eip155:4663'
    || capabilities?.chainDeployment?.chainId !== '4663') fail('expected Robinhood chain 4663');
  if (capabilities?.profile?.profileVersion !== '4.1.0') fail('expected provider profile 4.1.0');
}
export function checkDeploymentDigest(actual, expected) {
  if (actual !== expected) fail('chain deployment digest mismatch');
}
export function checkOutput(source, output) {
  const root = realpathSync(source), destination = resolve(output);
  if (existsSync(destination)) fail('output exists; choose a new directory');
  // Require an existing real parent, so an absent nested parent cannot hide an alias.
  const parent = realpathSync(dirname(destination));
  const final = resolve(parent, relative(dirname(destination), destination));
  const rel = relative(root, final);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) fail('output must be outside source');
  return final;
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
function identity(root) {
  if (git(root, 'status', '--porcelain', '--untracked-files=no')) fail('source has tracked modifications');
  const revision = git(root, 'rev-parse', 'HEAD');
  const remote = git(root, 'remote', 'get-url', 'origin');
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match || !/^[a-f0-9]{40}$/.test(revision)) fail('source requires an exact commit and public GitHub origin');
  return { url: `https://github.com/${match[1]}`, revision };
}
async function officialModules(cliRoot) {
  const root = realpathSync(cliRoot);
  const pkg = JSON.parse(readFileSync(safeInputPath(root, 'package.json')));
  if (pkg.name !== '@programmable/launch' || pkg.version !== '4.1.0') fail('official CLI 4.1.0 required');
  // These entry modules are pinned from the independently verified official4.1 tarball.
  // The operator must install the complete checksum-verified release and shipped lockfile.
  for (const [name, digest] of Object.entries(moduleHashes)) {
    if (sha(readFileSync(safeInputPath(root, `src/${name}`))) !== digest) fail('official CLI module digest mismatch');
  }
  return Object.assign({}, ...await Promise.all(Object.keys(moduleHashes).map(name => import(pathToFileURL(resolve(root, 'src', name)).href))));
}

/** Produces reusable API inputs only. No key access, network call, funding choice or launch request. */
export async function prepareApiInputs({ source, cliRoot, capabilitiesPath, metadataPath, output }) {
  const root = realpathSync(source), destination = checkOutput(root, output);
  const capabilitiesBytes = regularInput(capabilitiesPath), metadataBytes = regularInput(metadataPath);
  const capabilities = JSON.parse(capabilitiesBytes), metadataInput = JSON.parse(metadataBytes);
  checkCapabilities(capabilities);
  const origin = identity(root);
  if (metadataInput?.token?.name !== 'Hookemon' || metadataInput?.token?.symbol !== 'HKMN') fail('expected Hookemon / HKMN metadata');
  const imagePath = metadataInput.presentation?.image?.sourcePath;
  const bytes = new Map();
  const read = name => {
    if (!bytes.has(name)) bytes.set(name, readFileSync(safeInputPath(root, name)));
    return bytes.get(name);
  };
  const standard = JSON.parse(read(standardPath));
  if (!standard.sources || Object.keys(standard.sources).length === 0) fail('empty compiler source inventory');
  for (const [name, entry] of Object.entries(standard.sources)) {
    if (typeof entry.content !== 'string' || !read(`packages/contracts/${name}`).equals(Buffer.from(entry.content))) fail('compiler/source bytes differ');
  }
  read(imagePath);
  const manifest = JSON.parse(read(manifestPath));
  const artifacts = Object.fromEntries(['token', 'custody', 'hook'].map(id => [id, JSON.parse(read(artifactPath(id)))]));
  // Pin top-level inputs to the named commit; inline compiler sources are compared above.
  for (const name of [standardPath, manifestPath, ...['token', 'custody', 'hook'].map(artifactPath), imagePath]) {
    const committed = execFileSync('git', ['-C', root, 'show', `${origin.revision}:${name}`], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!committed.equals(bytes.get(name))) fail('source input differs from named commit');
  }
  const official = await officialModules(cliRoot);
  const chainDeployment = official.normalizeV4ChainDeployment(capabilities.chainDeployment);
  const chainDeploymentDescriptorDigest = official.hashV4ChainDeployment(chainDeployment);
  checkDeploymentDigest(chainDeploymentDescriptorDigest, capabilities.chainDeploymentDescriptorDigest);
  const profile = official.normalizeV4ProfileRef(capabilities.profile);
  const sourceBundle = await official.buildSourceBundle(root, [...bytes.keys()].sort());
  for (const entry of sourceBundle.bundleContent.entries) {
    if (!bytes.get(entry.path)?.equals(Buffer.from(entry.contentBase64, 'base64'))) fail('source changed during bundle preparation');
  }
  const metadata = await official.buildProjectMetadata(metadataInput, { sourceRoot: root, requireComplete: true,
    tokenTarget: { targetId: 'token', componentKind: 'token', abi: artifacts.token.abi, constructorArguments: [], initializer: null } });
  const image = await official.buildProjectMetadataImageArtifactV4({ sourceRoot: root, sourcePath: imagePath, projectMetadata: metadata.projectMetadata });
  const hookTarget = manifest.targets.find(target => target.targetId === 'hook');
  if (!hookTarget) fail('hook target missing');
  const artifact = artifacts.hook;
  let kernelCompatibility;
  try {
    official.assertRobinhoodNativeFeeKernelBuildV1({ target: { sourcePath: hookTarget.sourcePath, contractName: hookTarget.contractName,
      compilerVersion: manifest.compiler.solcLongVersion, creationBytecode: artifact.bytecode.object,
      runtimeCode: artifact.deployedBytecode.object }, unit: { standardJsonInput: standard } });
    kernelCompatibility = { accepted: true, scope: 'Exact local kernel build matching only; no provider admission.' };
  } catch (error) {
    if (error.code !== 'ROBINHOOD_NATIVE_FEE_KERNEL_REQUIRED') throw error;
    kernelCompatibility = { accepted: false, scope: 'Selected public profile 4.1 exact kernel check only; other provider routes are not assessed.', code: error.code, message: error.message };
  }
  if (JSON.stringify(identity(root)) !== JSON.stringify(origin)) fail('source identity changed during preparation');
  for (const [name, original] of bytes) if (!readFileSync(safeInputPath(root, name)).equals(original)) fail('source bytes changed during preparation');
  if (!regularInput(capabilitiesPath).equals(capabilitiesBytes) || !regularInput(metadataPath).equals(metadataBytes)) fail('input changed during preparation');
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  const report = { schemaVersion: 'hookemon.api-input-preparation.v1', status: 'API_INPUTS_ONLY', readyForPreflight: false,
    sourceOrigin: origin, nonce, kernelCompatibility,
    inputHashes: { capabilities: sha(capabilitiesBytes), metadata: sha(metadataBytes) },
    officialCli: { version: '4.1.0', pinnedEntryModuleSha256: moduleHashes, boundary: 'Complete release and installed dependencies must come from the verified official tarball and lockfile.' },
    boundaries: ['Not a create request or pack config.', 'No constructor binding, funding plan, launch intent or agent attestation is invented.',
      'Source bundle contains only compiler sources, three artifacts, build input, address manifest and selected image; it is not a complete release tool inventory.',
      'Provider source publication, metadata URL availability, compiler reproduction and runtime authority are separate checks.'],
    preparedAt: new Date().toISOString() };
  mkdirSync(destination); // Exclusive directory creation refuses a competing writer.
  try {
    const outputs = { 'provider-binding.json': { chainDeployment, chainDeploymentDescriptorDigest, profile },
      'source-bundle.json': sourceBundle, 'source-origin.json': origin,
      'project-metadata.json': { projectMetadata: metadata.projectMetadata, projectMetadataHash: metadata.projectMetadataHash },
      'project-image-artifact.json': image, 'preparation-report.json': report };
    for (const [name, data] of Object.entries(outputs)) writeFileSync(resolve(destination, name), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
  return report;
}
