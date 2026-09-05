import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { assessGenesisDeploymentEvidence } from '../verify-deployment-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/verify-deployment-manifest.mjs');
const manifestPath = resolve(root, 'release/phase3/deployment-manifest.json');
const addressManifestPath = resolve(root, 'release/phase3/address-manifest.json');
const genesisEvidencePath = resolve(root, 'release/phase3/genesis-evidence.json');

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function readGenesisEvidence() {
  return JSON.parse(readFileSync(genesisEvidencePath, 'utf8'));
}

function readReleaseArtifacts() {
  return new Map([
    ['HKMNToken', JSON.parse(readFileSync(resolve(root, 'release/phase3/artifacts/token.json'), 'utf8'))],
    ['PermanentPositionCustody', JSON.parse(readFileSync(resolve(root, 'release/phase3/artifacts/custody.json'), 'utf8'))],
    ['HookemonHook', JSON.parse(readFileSync(resolve(root, 'release/phase3/artifacts/hook.json'), 'utf8'))],
  ]);
}

function writeFixture(manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-deployment-manifest-'));
  const path = join(directory, 'deployment-manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, path };
}

function verify(path = manifestPath, addressPath = addressManifestPath) {
  return spawnSync(process.execPath, [script, '--manifest', path, '--address-manifest', addressPath], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('validates the checked-in three-target deployment manifest', () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deployment manifest verified/);
});

test('points to the rich address-manifest schema with a draft branch', () => {
  const manifest = readManifest();
  const schema = JSON.parse(readFileSync(resolve(root, manifest.addressManifestSchema), 'utf8'));

  assert.equal(manifest.addressManifestSchema, 'release/phase3/address-manifest.schema.json');
  assert.equal(schema.$defs.materializedManifest.properties.schemaVersion.const, 'hookemon.phase3.address-manifest.v1');
  assert.equal(schema.$defs.addressDerivationDraft.properties.schemaVersion.const, 'hookemon.phase3.address-manifest-draft.v1');
});

test('pins the Phase 3 token target to the dedicated token source', () => {
  const manifest = readManifest();
  const token = manifest.deployed.find((target) => target.name === 'HKMNToken');
  assert.equal(token?.sourcePath, 'packages/contracts/src/launch/HKMNToken.sol');
});

test('rejects a deployment manifest that restores the historical token source', () => {
  const manifest = readManifest();
  manifest.deployed.find((target) => target.name === 'HKMNToken').sourcePath = 'packages/contracts/src/launch/HookemonIssuance.sol';
  const fixture = writeFixture(manifest);
  try {
    const result = verify(fixture.path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest sourcePath is invalid for HKMNToken/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('derives numeric Robinhood genesis size and code-deposit-gas headroom for every target', () => {
  const assessment = assessGenesisDeploymentEvidence({
    evidence: readGenesisEvidence(),
    artifacts: readReleaseArtifacts(),
  });

  assert.deepEqual(assessment.targets.map((target) => target.name), [
    'HKMNToken',
    'PermanentPositionCustody',
    'HookemonHook',
  ]);
  assert.equal(assessment.limits.maxCodeSize, 98_304);
  assert.equal(assessment.limits.maxInitCodeSize, 196_608);
  assert.equal(assessment.limits.blockGasLimit, 30_000_000);
  for (const target of assessment.targets) {
    assert.ok(target.runtimeBytes > 0);
    assert.ok(target.initcodeBytes > 0);
    assert.equal(target.runtimeHeadroom, assessment.limits.maxCodeSize - target.runtimeBytes);
    assert.equal(target.initcodeHeadroom, assessment.limits.maxInitCodeSize - target.initcodeBytes);
    assert.equal(target.runtimeCodeDepositGas, target.runtimeBytes * 200);
    assert.equal(
      target.runtimeCodeDepositGasHeadroom,
      assessment.limits.blockGasLimit - target.runtimeCodeDepositGas,
    );
    assert.ok(target.runtimeHeadroom > 0);
    assert.ok(target.initcodeHeadroom > 0);
    assert.ok(target.runtimeCodeDepositGasHeadroom > 0);
  }
});

test('rejects a mutated Robinhood genesis code-size limit before accepting release evidence', () => {
  const evidence = readGenesisEvidence();
  evidence.maxCodeSize = 1;

  assert.throws(
    () => assessGenesisDeploymentEvidence({ evidence, artifacts: readReleaseArtifacts() }),
    /maxCodeSize/i,
  );
});

test('rejects a release artifact whose runtime consumes all pinned genesis code headroom', () => {
  const artifacts = readReleaseArtifacts();
  artifacts.get('HookemonHook').deployedBytecode = `0x${'00'.repeat(98_304)}`;

  assert.throws(
    () => assessGenesisDeploymentEvidence({ evidence: readGenesisEvidence(), artifacts }),
    /HookemonHook runtime exceeds genesis maxCodeSize/,
  );
});

test('rejects an address manifest that breaks provider target order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-address-manifest-'));
  const path = join(directory, 'address-manifest.json');
  const addressManifest = JSON.parse(readFileSync(addressManifestPath, 'utf8'));
  [addressManifest.targets[1], addressManifest.targets[2]] = [addressManifest.targets[2], addressManifest.targets[1]];
  writeFileSync(path, `${JSON.stringify(addressManifest, null, 2)}\n`);
  try {
    const result = verify(manifestPath, path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider ordered/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a lower-case address that otherwise passes the manifest schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-address-manifest-'));
  const path = join(directory, 'address-manifest.json');
  const addressManifest = JSON.parse(readFileSync(addressManifestPath, 'utf8'));
  addressManifest.targets[0].constructor.issuanceAuthority = addressManifest.targets[0].constructor.issuanceAuthority.toLowerCase();
  writeFileSync(path, `${JSON.stringify(addressManifest, null, 2)}\n`);
  try {
    const result = verify(manifestPath, path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EIP-55|checksum/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects an upper-case address that otherwise passes the manifest schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-address-manifest-'));
  const path = join(directory, 'address-manifest.json');
  const addressManifest = JSON.parse(readFileSync(addressManifestPath, 'utf8'));
  const value = addressManifest.targets[0].constructor.issuanceAuthority;
  addressManifest.targets[0].constructor.issuanceAuthority = `0x${value.slice(2).toUpperCase()}`;
  writeFileSync(path, `${JSON.stringify(addressManifest, null, 2)}\n`);
  try {
    const result = verify(manifestPath, path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EIP-55|checksum/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects an incorrectly mixed-case address that otherwise passes the manifest schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hookemon-address-manifest-'));
  const path = join(directory, 'address-manifest.json');
  const addressManifest = JSON.parse(readFileSync(addressManifestPath, 'utf8'));
  const value = addressManifest.targets[0].constructor.issuanceAuthority;
  const index = [...value].findIndex((character, offset) => offset > 1 && /[a-fA-F]/.test(character));
  assert.notEqual(index, -1);
  const character = value[index];
  addressManifest.targets[0].constructor.issuanceAuthority = `${value.slice(0, index)}${character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()}${value.slice(index + 1)}`;
  writeFileSync(path, `${JSON.stringify(addressManifest, null, 2)}\n`);
  try {
    const result = verify(manifestPath, path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EIP-55|checksum/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a deployment manifest that includes an excluded process contract', () => {
  const manifest = readManifest();
  manifest.deployed.push({
    ...manifest.deployed[0],
    name: 'PegCycleVault',
    sourcePath: 'packages/contracts/src/process/PegCycleVault.sol',
  });
  const fixture = writeFixture(manifest);
  try {
    const result = verify(fixture.path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /excluded contract/i);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects a manifest whose content digest does not match its payload', () => {
  const manifest = readManifest();
  manifest.deployed[0].role = 'modified role';
  const fixture = writeFixture(manifest);
  try {
    const result = verify(fixture.path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest mismatch/i);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('uses Node 24 for manifest verification', () => {
  const version = execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, 'v24.19.0');
});
