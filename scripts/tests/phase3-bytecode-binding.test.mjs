import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import test from 'node:test';

import { keccak256Hex } from '../programmable/lib/keccak.mjs';
import {
  foundryCompilerVersion,
  PHASE_THREE_SOLC_LONG_VERSION,
  sourceContentCommitment,
} from '../programmable/lib/phase3-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const contractsRoot = resolve(root, 'packages/contracts');
const forge = process.env.FORGE_BIN ?? 'forge';
const node = process.execPath;
const rebuildRelease = resolve(root, 'scripts/programmable/rebuild-phase3-release.mjs');

const targets = [
  {
    targetId: 'token',
    artifactPath: 'HKMNToken.sol/HKMNToken.json',
    constants: ['TOKEN_CREATION_CODE_HASH', 'TOKEN_RUNTIME_TEMPLATE_CODE_HASH', 'TOKEN_ARTIFACT_SHA256'],
  },
  {
    targetId: 'custody',
    artifactPath: 'RobinhoodBindings.sol/PermanentPositionCustody.json',
    constants: ['CUSTODY_CREATION_CODE_HASH', 'CUSTODY_RUNTIME_TEMPLATE_CODE_HASH', 'CUSTODY_ARTIFACT_SHA256'],
  },
  {
    targetId: 'hook',
    artifactPath: 'HookemonHook.sol/HookemonHook.json',
    constants: ['HOOK_CREATION_CODE_HASH', 'HOOK_RUNTIME_TEMPLATE_CODE_HASH', 'HOOK_ARTIFACT_SHA256'],
  },
];

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactCodeHash(value) {
  const code = typeof value === 'string' ? value : value?.object;
  assert.match(code, /^0x[0-9a-f]+$/i);
  return keccak256Hex(Buffer.from(code.slice(2), 'hex'));
}

function releasePlanConstants() {
  const source = readFileSync(resolve(contractsRoot, 'script/release/PhaseThreeReleasePlan.sol'), 'utf8');
  const constants = new Map();
  for (const match of source.matchAll(/bytes32 public constant ([A-Z0-9_]+)\s*=\s*\n?\s*(0x[0-9a-fA-F]{64});/g)) {
    constants.set(match[1], match[2].toLowerCase());
  }
  return constants;
}

function compilePinnedTargets() {
  const buildDirectory = mkdtempSync(resolve(tmpdir(), 'hookemon-phase3-bytecode-'));
  const result = spawnSync(forge, [
    'build', '--root', contractsRoot, '--no-cache', '--build-info',
    '--out', resolve(buildDirectory, 'out'), '--build-info-path', resolve(buildDirectory, 'build-info'),
    'src/HookemonHook.sol', 'src/launch/HKMNToken.sol', 'src/bindings/RobinhoodBindings.sol',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FOUNDRY_PROFILE: 'launch',
      FOUNDRY_LIBS: '["lib/v4-core","lib/v4-periphery"]',
      FOUNDRY_REMAPPINGS: 'forge-std/=lib/v4-core/lib/forge-std/src/',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return buildDirectory;
}

function filesIn(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(directory, path));
    }
  };
  visit(directory);
  return files.sort();
}

function assertSameDirectory(expectedDirectory, actualDirectory) {
  const expectedFiles = filesIn(expectedDirectory);
  const actualFiles = filesIn(actualDirectory);
  assert.deepEqual(actualFiles, expectedFiles, 'materialization changed the Phase 3 release file set');
  for (const path of expectedFiles) {
    assert.deepEqual(
      readFileSync(resolve(actualDirectory, path)),
      readFileSync(resolve(expectedDirectory, path)),
      `materialization drifted ${path}`,
    );
  }
}

test('Phase 3 release evidence binds the pinned compiler artifacts', () => {
  const buildDirectory = compilePinnedTargets();
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'release/phase3/address-manifest.json'), 'utf8'));
    const graphDraft = JSON.parse(readFileSync(resolve(root, 'release/phase3/package/graph-draft.json'), 'utf8'));
    const plan = releasePlanConstants();

    for (const target of targets) {
      const artifactBytes = readFileSync(resolve(buildDirectory, 'out', target.artifactPath));
      const artifact = JSON.parse(artifactBytes.toString('utf8'));
      const expected = {
        creationBytecodeHash: artifactCodeHash(artifact.bytecode),
        runtimeTemplateCodeHash: artifactCodeHash(artifact.deployedBytecode),
        artifactSha256: sha256(artifactBytes),
      };
      const manifestTarget = manifest.targets.find((candidate) => candidate.targetId === target.targetId);
      const graphTarget = graphDraft.graph.targets.find((candidate) => candidate.targetId === target.targetId);
      assert.ok(manifestTarget, `missing manifest target ${target.targetId}`);
      assert.ok(graphTarget, `missing graph target ${target.targetId}`);
      assert.deepEqual(
        {
          creationBytecodeHash: manifestTarget.creationBytecodeHash,
          runtimeTemplateCodeHash: manifestTarget.runtimeTemplateCodeHash,
          artifactSha256: manifestTarget.artifactSha256,
        },
        expected,
        `address manifest drifted for ${target.targetId}`,
      );
      assert.deepEqual(
        {
          creationBytecodeHash: graphTarget.creationBytecodeHash,
          runtimeTemplateCodeHash: graphTarget.runtimeTemplateCodeHash,
          artifactSha256: graphTarget.artifactSha256,
        },
        expected,
        `graph draft drifted for ${target.targetId}`,
      );
      assert.equal(plan.get(target.constants[0]), expected.creationBytecodeHash, `release plan creation hash drifted for ${target.targetId}`);
      assert.equal(plan.get(target.constants[1]), expected.runtimeTemplateCodeHash, `release plan runtime hash drifted for ${target.targetId}`);
      assert.equal(plan.get(target.constants[2]), `0x${expected.artifactSha256.slice('sha256:'.length)}`, `release plan artifact hash drifted for ${target.targetId}`);
    }
  } finally {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
});

test('Phase 3 keeps one portable Standard JSON evidence record', () => {
  const path = resolve(root, 'release/phase3/build-info/launch.json');
  const buildInfo = JSON.parse(readFileSync(path, 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(root, 'release/phase3/address-manifest.json'), 'utf8'));
  assert.ok(statSync(path).size < 2_000_000);
  assert.deepEqual(Object.keys(buildInfo).sort(), ['language', 'settings', 'sources']);
  assert.equal(Object.hasOwn(buildInfo, 'version'), false);
  assert.equal(buildInfo.language, 'Solidity');
  assert.equal(buildInfo.settings.optimizer.runs, 1000);
  assert.equal(manifest.compiler.solcLongVersion, PHASE_THREE_SOLC_LONG_VERSION);
  assert.deepEqual(sourceContentCommitment(buildInfo), {
    sourceCount: manifest.compiler.buildInfo.sourceCount,
    sourceContentSha256: manifest.compiler.buildInfo.sourceContentSha256,
  });
});

test('the committed Phase 3 inputs materialize the pinned compiler evidence exactly', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'hookemon-phase3-materialize-'));
  const outputReleaseDirectory = resolve(directory, 'phase3');
  const outputReleasePlan = resolve(directory, 'PhaseThreeReleasePlan.sol');
  try {
    cpSync(resolve(root, 'release/phase3'), outputReleaseDirectory, { recursive: true });
    cpSync(resolve(contractsRoot, 'script/release/PhaseThreeReleasePlan.sol'), outputReleasePlan);
    const result = spawnSync(node, [
      rebuildRelease,
      '--release-directory', outputReleaseDirectory,
      '--release-plan-output', outputReleasePlan,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGE_BIN: forge,
        FOUNDRY_LIBS: '["lib/v4-core","lib/v4-periphery"]',
        FOUNDRY_REMAPPINGS: 'forge-std/=lib/v4-core/lib/forge-std/src/',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assertSameDirectory(resolve(root, 'release/phase3'), outputReleaseDirectory);
    assert.deepEqual(
      readFileSync(outputReleasePlan),
      readFileSync(resolve(contractsRoot, 'script/release/PhaseThreeReleasePlan.sol')),
      'materialization drifted the pinned release-plan hashes',
    );

    const manifest = JSON.parse(readFileSync(resolve(outputReleaseDirectory, 'address-manifest.json'), 'utf8'));
    assert.equal(manifest.compiler.solcLongVersion, PHASE_THREE_SOLC_LONG_VERSION);
    for (const target of targets) {
      const artifact = JSON.parse(readFileSync(resolve(outputReleaseDirectory, 'artifacts', `${target.targetId}.json`), 'utf8'));
      assert.equal(foundryCompilerVersion(artifact), PHASE_THREE_SOLC_LONG_VERSION, `${target.targetId} artifact compiler version drifted`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release rebuild rejects a compiled artifact whose compilation target differs from deployment evidence', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'hookemon-phase3-identity-'));
  const outputReleaseDirectory = resolve(directory, 'phase3');
  const outputReleasePlan = resolve(directory, 'PhaseThreeReleasePlan.sol');
  const forgeWrapper = resolve(directory, 'mutate-compilation-target.mjs');
  try {
    cpSync(resolve(root, 'release/phase3'), outputReleaseDirectory, { recursive: true });
    cpSync(resolve(contractsRoot, 'script/release/PhaseThreeReleasePlan.sol'), outputReleasePlan);
    writeFileSync(forgeWrapper, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const result = spawnSync(process.env.REAL_FORGE, process.argv.slice(2), { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const outIndex = process.argv.indexOf('--out');
if (outIndex === -1) throw new Error('forge output path is missing');
const artifactPath = join(process.argv[outIndex + 1], 'HKMNToken.sol', 'HKMNToken.json');
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
metadata.settings.compilationTarget = { 'src/HookemonHook.sol': 'HookemonHook' };
artifact.metadata = metadata;
writeFileSync(artifactPath, JSON.stringify(artifact) + '\\n');
`, { mode: 0o755 });

    const result = spawnSync(node, [
      rebuildRelease,
      '--release-directory', outputReleaseDirectory,
      '--release-plan-output', outputReleasePlan,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGE_BIN: forgeWrapper,
        REAL_FORGE: forge,
        FOUNDRY_LIBS: '["lib/v4-core","lib/v4-periphery"]',
        FOUNDRY_REMAPPINGS: 'forge-std/=lib/v4-core/lib/forge-std/src/',
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /compilationTarget.*deployment target|compiled artifact identity/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
