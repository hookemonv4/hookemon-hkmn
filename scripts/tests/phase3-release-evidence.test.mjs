import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const hookArtifactPath = resolve(root, 'release/phase3/artifacts/hook.json');
const deploymentManifestPath = resolve(root, 'release/phase3/deployment-manifest.json');
const graphGasEvidencePath = resolve(root, 'release/phase3/graph-gas-evidence.json');
const archiveForkPath = resolve(root, 'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function compiledHookConstructorComponents() {
  const artifact = readJson(hookArtifactPath);
  const constructor = artifact.abi.find((entry) => entry.type === 'constructor');
  assert.ok(constructor, 'HookemonHook compiled ABI must include a constructor');
  assert.equal(constructor.inputs.length, 1, 'HookemonHook constructor must take one config tuple');
  const [config] = constructor.inputs;
  assert.equal(config.type, 'tuple', 'HookemonHook constructor config must remain a tuple');
  return config.components.map(({ name, type }) => `${name}:${type}`);
}

function archivePinnedHash(source, constantName) {
  const match = source.match(new RegExp(
    `\\b${constantName}\\s*=\\s*\\n?\\s*(0x[0-9a-fA-F]{64})`,
  ));
  assert.ok(match, `archive fork must declare ${constantName}`);
  return match[1].toLowerCase();
}

test('deployment manifest derives HookemonHook ConstructorConfig fields from the compiled ABI', () => {
  const manifest = readJson(deploymentManifestPath);
  const hook = manifest.deployed.find(({ name }) => name === 'HookemonHook');

  assert.deepEqual(hook.constructorArgsSchema.components, compiledHookConstructorComponents());
  assert.equal(hook.constructorArgsSchema.components.includes('seedIntentDigest:bytes32'), true);
});

test('graph gas evidence pins the current archive-fork graph outputs', () => {
  const evidence = readJson(graphGasEvidencePath);
  const archiveFork = readFileSync(archiveForkPath, 'utf8');

  assert.equal(
    evidence.route.deployments.token.runtimeCodeHash.toLowerCase(),
    archivePinnedHash(archiveFork, 'PROVIDER_GAS_TOKEN_RUNTIME_CODEHASH'),
  );
  assert.equal(
    evidence.route.deployments.custody.runtimeCodeHash.toLowerCase(),
    archivePinnedHash(archiveFork, 'PROVIDER_GAS_CUSTODY_RUNTIME_CODEHASH'),
  );
  assert.equal(
    evidence.route.deployments.hook.runtimeCodeHash.toLowerCase(),
    archivePinnedHash(archiveFork, 'PROVIDER_GAS_HOOK_RUNTIME_CODEHASH'),
  );
  assert.equal(
    evidence.route.graphDeploymentHash.toLowerCase(),
    archivePinnedHash(archiveFork, 'PROVIDER_GAS_GRAPH_DEPLOYMENT_HASH'),
  );
});
