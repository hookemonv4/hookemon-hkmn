#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  computeManifestDigest,
  validateManifest,
  validatePhase3BindingEvidence,
  validateTrackedLocalProof,
} from './verify-robinhood-binding.mjs';

const MANIFEST_PATH = 'bindings/robinhood-chain.json';
const INDEX_PATH = 'bindings/index.json';
const EXPECTED_LOCAL_PROOF_PATHS = [
  'feasibility/model.mjs',
  'packages/contracts/src/bindings/RobinhoodBindings.sol',
  'packages/contracts/test/bindings/RobinhoodBindings.t.sol',
  'packages/contracts/test/bindings/RobinhoodV4PoolManager.t.sol',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactLocalProofPath(path) {
  return typeof path === 'string'
    && EXPECTED_LOCAL_PROOF_PATHS.includes(path)
    && !path.includes('\\')
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function readRegularRepositoryFile(projectRoot, relativePath) {
  invariant(exactLocalProofPath(relativePath), `unexpected local proof path: ${String(relativePath)}`);
  const rootReal = realpathSync(projectRoot);
  const filePath = join(rootReal, relativePath);
  const stat = lstatSync(filePath);
  const fileReal = realpathSync(filePath);
  invariant(stat.isFile() && !stat.isSymbolicLink(), `local proof is not a regular file: ${relativePath}`);
  const fromRoot = relative(rootReal, fileReal);
  invariant(fromRoot !== '' && !fromRoot.startsWith('..'), `local proof escapes repository: ${relativePath}`);
  return readFileSync(fileReal);
}

export function buildRobinhoodBinding(projectRoot, template) {
  invariant(template && typeof template === 'object' && !Array.isArray(template), 'binding template must be an object');
  const manifest = structuredClone(template);
  invariant(Array.isArray(manifest.localProof?.artifacts), 'binding localProof artifacts are required');
  const paths = manifest.localProof.artifacts.map((artifact) => artifact?.path);
  invariant(
    paths.length === EXPECTED_LOCAL_PROOF_PATHS.length
      && new Set(paths).size === EXPECTED_LOCAL_PROOF_PATHS.length
      && EXPECTED_LOCAL_PROOF_PATHS.every((path) => paths.includes(path)),
    'binding localProof must contain the exact tracked path set',
  );
  manifest.localProof.artifacts = manifest.localProof.artifacts.map(({ path }) => ({
    path,
    sha256: sha256(readRegularRepositoryFile(projectRoot, path)),
  }));
  manifest.manifestDigest = computeManifestDigest(manifest);
  validateManifest(manifest);
  validatePhase3BindingEvidence(manifest, projectRoot);
  validateTrackedLocalProof(manifest, projectRoot);
  return manifest;
}

export function buildBindingsIndex(manifest) {
  validateManifest(manifest);
  return {
    schemaVersion: 1,
    bindings: [{
      id: `robinhood-chain-r${manifest.requirementsRevision}-a${manifest.architectureRevision}`,
      path: MANIFEST_PATH,
      requirementsRevision: manifest.requirementsRevision,
      architectureRevision: manifest.architectureRevision,
      manifestDigest: manifest.manifestDigest,
      status: manifest.bindingMode,
    }],
  };
}

export function writeRobinhoodBinding(projectRoot, { check = false } = {}) {
  const root = realpathSync(projectRoot);
  const manifestPath = join(root, MANIFEST_PATH);
  const indexPath = join(root, INDEX_PATH);
  const template = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifest = buildRobinhoodBinding(root, template);
  const index = buildBindingsIndex(manifest);
  const manifestBytes = jsonBytes(manifest);
  const indexBytes = jsonBytes(index);

  if (check) {
    invariant(readFileSync(manifestPath).equals(manifestBytes), `${MANIFEST_PATH} is stale`);
    invariant(readFileSync(indexPath).equals(indexBytes), `${INDEX_PATH} is stale`);
    return { status: 'CURRENT', manifestDigest: manifest.manifestDigest, proofs: manifest.localProof.artifacts.length };
  }

  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(indexPath, indexBytes);
  return { status: 'REGENERATED', manifestDigest: manifest.manifestDigest, proofs: manifest.localProof.artifacts.length };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  invariant(
    args.length === 0 || (args.length === 1 && args[0] === '--check'),
    'usage: node feasibility/write-robinhood-binding.mjs [--check]',
  );
  return { check: args[0] === '--check' };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    process.stdout.write(`${JSON.stringify(writeRobinhoodBinding(root, parseArgs(process.argv)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
