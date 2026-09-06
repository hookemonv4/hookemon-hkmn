import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildSourceBundleManifest } from './source-bundle.mjs';

const STANDARD_JSON_INPUT_PATHS = ['release/phase3/build-info/launch.json'];
const COMPILER_ARTIFACT_PATHS = [
  'release/phase3/artifacts/custody.json',
  'release/phase3/artifacts/hook.json',
  'release/phase3/artifacts/token.json',
];

// The existing project mark, committed by the website task at
// apps/web/public/hookemon-mark.png (codex/launch-g, db88106af97289cb2d5550fc0de35b387fd16ace).
// This is a byte-identical copy read from that Git blob, not a new asset.
const DEFAULT_METADATA_IMAGE_PATH = 'release/phase3/metadata/hookemon-mark.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validDefaultMetadataImage(root) {
  const path = resolve(root, DEFAULT_METADATA_IMAGE_PATH);
  if (!existsSync(path)) return false;
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return false;
  }
  return bytes.length > 0 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function compareUtf8Path(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function fail(message) {
  throw new Error(`invalid Phase 3 source bundle coverage: ${message}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`cannot read ${path}`);
  }
}

function pathList(value, field) {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a nonempty list`);
  if (value.some((path) => typeof path !== 'string' || path.length === 0)) fail(`${field} must contain nonempty paths`);
  if (new Set(value).size !== value.length) fail(`${field} must not contain duplicates`);
  return [...value].sort(compareUtf8Path);
}

function coverageOpenFacts(hasMetadataImage) {
  const facts = [
    {
      category: 'attestationEvidencePaths',
      missing: 'No committed attestation evidence file is available for the V4 launch request.',
      resolve: 'Generate and commit the attestation evidence file, then record its repository-relative path.',
      verifiedAlternative: 'Keep the attestation coverage unresolved and refuse source-bundle materialization.',
    },
  ];
  if (!hasMetadataImage) {
    facts.push({
      category: 'metadataImagePath',
      missing: 'No committed project metadata image is available for the V4 launch request.',
      resolve: 'Commit the selected metadata image and record its repository-relative path.',
      verifiedAlternative: 'Keep the metadata coverage unresolved and refuse source-bundle materialization.',
    });
  }
  return facts;
}

/**
 * Returns the package-owned declaration of every currently known source input.
 * The metadata image defaults to the existing project mark once a valid PNG is
 * committed at DEFAULT_METADATA_IMAGE_PATH; attestation evidence has no such
 * existing asset and stays null instead of guessing a file name.
 */
export function derivePhaseThreeSourceBundleCoverage({ root } = {}) {
  if (typeof root !== 'string' || root.length === 0) fail('root must be a repository path');
  const submission = readJson(resolve(root, 'release/phase3/submission.json'));
  const sourcePaths = pathList(submission?.implementation?.sourcePaths, 'submission.implementation.sourcePaths');
  const hasMetadataImage = validDefaultMetadataImage(root);
  return {
    schemaVersion: 'hookemon.phase3.source-bundle-coverage.v1',
    sourcePaths,
    standardJsonInputPaths: [...STANDARD_JSON_INPUT_PATHS],
    compilerArtifactPaths: [...COMPILER_ARTIFACT_PATHS],
    attestationEvidencePaths: null,
    metadataImagePath: hasMetadataImage ? DEFAULT_METADATA_IMAGE_PATH : null,
    unresolved: coverageOpenFacts(hasMetadataImage),
  };
}

export function buildPhaseThreeSourceBundle({ root, coverage = derivePhaseThreeSourceBundleCoverage({ root }), sourceCommit } = {}) {
  if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) fail('coverage must be an object');
  if (coverage.schemaVersion !== 'hookemon.phase3.source-bundle-coverage.v1') fail('coverage schemaVersion is not supported');
  const expectedKeys = [
    'schemaVersion',
    'sourcePaths',
    'standardJsonInputPaths',
    'compilerArtifactPaths',
    'attestationEvidencePaths',
    'metadataImagePath',
    'unresolved',
  ];
  for (const key of expectedKeys) if (!Object.hasOwn(coverage, key)) fail(`coverage.${key} is required`);
  for (const key of Object.keys(coverage)) if (!expectedKeys.includes(key)) fail(`coverage.${key} is not allowed`);
  const sourcePaths = pathList(coverage.sourcePaths, 'coverage.sourcePaths');
  const standardJsonInputPaths = pathList(coverage.standardJsonInputPaths, 'coverage.standardJsonInputPaths');
  const compilerArtifactPaths = pathList(coverage.compilerArtifactPaths, 'coverage.compilerArtifactPaths');
  const incomplete = [];
  if (!Array.isArray(coverage.attestationEvidencePaths) || coverage.attestationEvidencePaths.length === 0) incomplete.push('attestation evidence paths');
  if (typeof coverage.metadataImagePath !== 'string' || coverage.metadataImagePath.length === 0) incomplete.push('metadata image path');
  if (!Array.isArray(coverage.unresolved)) fail('coverage.unresolved must be a list');
  if (coverage.unresolved.length > 0) incomplete.push('unresolved coverage facts');
  if (incomplete.length > 0) fail(`source bundle coverage is incomplete: ${incomplete.join(', ')}`);

  return {
    coverage,
    manifest: buildSourceBundleManifest({
      root,
      sourcePaths,
      standardJsonInputPaths,
      compilerArtifactPaths,
      attestationEvidencePaths: pathList(coverage.attestationEvidencePaths, 'coverage.attestationEvidencePaths'),
      metadataImagePath: coverage.metadataImagePath,
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
    }),
  };
}
