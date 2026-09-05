import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// WP-19: release/phase2/submission.json + release/phase2/launch-plan.md are launch-admission
// evidence prepared ahead of Programmable's Robinhood Chain profile becoming available. This
// suite checks the two acceptance criteria the work package sets out (schema shape validity in
// an INTEGRATION_PENDING state, and that every knowable field is populated while every unknowable
// field is explicit null rather than omitted) without depending on any path outside this
// repository — the full submission.schema.json compatibility review lives in the
// programmable-v4-hook-builder skill and was used interactively while authoring this evidence,
// but is intentionally not a repo-committed dependency of this test suite.

const root = resolve(import.meta.dirname, '../..');
const submissionPath = resolve(root, 'release/phase2/submission.json');
const launchPlanPath = resolve(root, 'release/phase2/launch-plan.md');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The exact top-level `required` array from
// programmable-v4-hook-builder's references/submission.schema.json (urn:programmable:v4-hook-submission:1.5.0).
const REQUIRED_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'standardVersion',
  'stage',
  'model',
  'builder',
  'builderTemplate',
  'publicMetadata',
  'target',
  'assets',
  'launchLifecycle',
  'pool',
  'programmableFee',
  'hook',
  'noHookArchitecture',
  'valueFlows',
  'authorities',
  'dependencies',
  'operations',
  'integration',
  'projectSurfaces',
  'projectCapabilities',
  'capabilities',
  'capabilityExtensions',
  'security',
  'implementation',
  'risk',
  'disclosures',
  'unresolved',
];

// Optional top-level properties the schema also defines (not in `required`, but valid under
// `additionalProperties: false`): tokenMechanics and tokenBehaviorExtensions.
const OPTIONAL_TOP_LEVEL_KEYS = ['$schema', 'tokenMechanics', 'tokenBehaviorExtensions'];

// Every field WP-19's steps explicitly call out as knowable today: fee split, hook permission
// mask, hookData layout, and the pinned Programmable owner address (all per WP-05).
const KNOWABLE_PATHS = [
  ['target.chainId', 4663],
  ['programmableFee.policyId', 'programmable-volume-fee-v1'],
  ['programmableFee.rates.platformHundredthsOfBip', 1000],
  ['programmableFee.rates.projectHundredthsOfBip', 29000],
  ['programmableFee.ownership.owner', '0x4957f49620AFf3Adbbe8195a4f633E49cc93376c'],
  ['programmableFee.ownership.immutable', true],
  ['hook.used', true],
  ['hook.permissions.beforeSwap', true],
  ['hook.permissions.afterSwap', true],
  ['hook.permissions.beforeSwapReturnDelta', true],
  ['hook.permissions.afterSwapReturnDelta', true],
  ['hook.permissions.beforeInitialize', false],
  ['hook.permissions.beforeDonate', false],
  ['hook.hookData.used', true],
];

// Fields that are genuinely unresolved at this point in the plan (deployment addresses, the
// chain-deployment digest, and everything that can only be known once WP-20/WP-25 resolve). Each
// must be present as an explicit `null`, never omitted from the document.
const UNKNOWABLE_NULL_PATHS = [
  'target.officialLaunchProfileId',
  'assets.1.address',
  'pool.tickSpacing',
  'hook.hookData.identitySource',
  'integration.dataReconstruction.mode',
];

function getPath(value, path) {
  const segments = path.split('.');
  let cursor = value;
  for (const segment of segments) {
    assert.notStrictEqual(cursor, undefined, `path segment missing before "${segment}" in "${path}"`);
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      assert.ok(Number.isInteger(index), `expected an array index in path "${path}", got "${segment}"`);
      cursor = cursor[index];
    } else {
      assert.ok(
        cursor !== null && typeof cursor === 'object',
        `expected an object before "${segment}" in path "${path}"`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(cursor, segment),
        `key "${segment}" is missing (omitted, not null) at path "${path}"`,
      );
      cursor = cursor[segment];
    }
  }
  return cursor;
}

test('release/phase2/submission.json is present and is a single JSON object', () => {
  const submission = readJson(submissionPath);
  assert.equal(typeof submission, 'object');
  assert.ok(!Array.isArray(submission));
});

test('submission.json carries every top-level key the standard requires', () => {
  const submission = readJson(submissionPath);
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(submission, key),
      `submission.json is missing required top-level key "${key}"`,
    );
  }
  // additionalProperties: false at the top level.
  const extra = Object.keys(submission).filter(
    (key) => !REQUIRED_TOP_LEVEL_KEYS.includes(key) && !OPTIONAL_TOP_LEVEL_KEYS.includes(key),
  );
  assert.deepEqual(extra, [], `submission.json has unexpected top-level keys: ${extra.join(', ')}`);
});

test('submission.json pins the exact schema/version identity', () => {
  const submission = readJson(submissionPath);
  assert.equal(submission.$schema, 'urn:programmable:v4-hook-submission:1.5.0');
  assert.equal(submission.schemaVersion, 1);
  assert.equal(submission.standardVersion, '1.5.0');
  assert.equal(submission.stage, 'proposal');
});

test('submission.json declares itself for Robinhood Chain (4663), not chain id 1', () => {
  const submission = readJson(submissionPath);
  assert.equal(submission.target.chainId, 4663);
  // Only chain id 1 is production-launch-authorized today per the builder skill's
  // KNOWN_EVM_NETWORKS mapping; 4663 stays outside that closed set on purpose.
  assert.match(submission.target.network, /^robinhood/);
});

test('every knowable provider-bound field from WP-19\'s steps is populated with a real value', () => {
  const submission = readJson(submissionPath);
  for (const [path, expected] of KNOWABLE_PATHS) {
    const actual = getPath(submission, path);
    assert.notStrictEqual(actual, null, `expected "${path}" to be populated, found null`);
    assert.deepEqual(actual, expected, `unexpected value at "${path}"`);
  }
});

test('the hookData layout matches CanonicalSwapHookData.sol exactly', () => {
  const submission = readJson(submissionPath);
  const schemaText = getPath(submission, 'hook.hookData.schema');
  assert.match(schemaText, /bytes32 domain/);
  assert.match(schemaText, /bytes32 operationId/);
  assert.match(schemaText, /address sender/);
  assert.match(schemaText, /address recipient/);
  assert.match(schemaText, /HOOKEMON_CANONICAL_SWAP_R54_A3_V1/);
});

test('every genuinely unknowable field is explicit null, never omitted', () => {
  const submission = readJson(submissionPath);
  for (const path of UNKNOWABLE_NULL_PATHS) {
    const actual = getPath(submission, path);
    assert.strictEqual(actual, null, `expected "${path}" to be explicit null (INTEGRATION_PENDING), got ${JSON.stringify(actual)}`);
  }
});

test('the HKMN launched asset carries no deployment address yet, but every other field is fixed', () => {
  const submission = readJson(submissionPath);
  const hkmn = submission.assets.find((asset) => asset.id === 'hkmn');
  assert.ok(hkmn, 'submission.json must declare the hkmn asset');
  assert.strictEqual(hkmn.address, null);
  assert.equal(hkmn.decimals, 18);
  assert.equal(hkmn.initialSupply, '420690000000000000000000000000');
  assert.equal(hkmn.supplyPolicy, 'fixed-at-creation');
});

test('unresolved[] and disclosures[] are non-empty and every unresolved item is a real string', () => {
  const submission = readJson(submissionPath);
  assert.ok(Array.isArray(submission.unresolved));
  assert.ok(submission.unresolved.length > 0);
  assert.ok(Array.isArray(submission.disclosures));
  assert.ok(submission.disclosures.length > 0);
  for (const item of submission.unresolved) {
    assert.equal(typeof item, 'string');
    assert.ok(item.length >= 20, 'an unresolved item must be a real, specific sentence');
  }
});

test('every implementation source/test path in submission.json exists in this repository', () => {
  const submission = readJson(submissionPath);
  const paths = [
    ...submission.implementation.sourcePaths,
    ...submission.implementation.testPaths,
    ...submission.programmableFee.evidence.sourcePaths,
    ...submission.programmableFee.evidence.testPaths,
  ];
  assert.ok(paths.length > 0);
  for (const relativePath of paths) {
    const absolute = resolve(root, relativePath);
    assert.ok(
      absolute.startsWith(root),
      `implementation path "${relativePath}" escapes the repository root`,
    );
    assert.doesNotThrow(
      () => readFileSync(absolute),
      `implementation path "${relativePath}" declared in submission.json does not exist`,
    );
  }
});

test('release/phase2/launch-plan.md exists and covers the new escrow and chunked-payout contracts', () => {
  const text = readFileSync(launchPlanPath, 'utf8');
  assert.ok(text.length > 500, 'launch-plan.md should be a real document, not a stub');
  assert.match(text, /PhaseOneReleasePlan/, 'launch-plan.md should mirror PhaseOneReleasePlan.sol\'s pattern');
  assert.match(text, /PegCycleReturnEscrow/, 'launch-plan.md should cover the new escrow contract');
  assert.match(text, /PayoutCommitment/, 'launch-plan.md should cover the chunked-payout contract');
  assert.match(text, /CanonicalMerkleSum/, 'launch-plan.md should cover the chunked Merkle-sum payout');
  assert.match(text, /INTEGRATION_PENDING/, 'launch-plan.md should explicitly mark unresolved fields');
});

test('launch-plan.md cites the exact provider-bound facts also pinned in submission.json', () => {
  const submission = readJson(submissionPath);
  const text = readFileSync(launchPlanPath, 'utf8');
  const owner = getPath(submission, 'programmableFee.ownership.owner');
  assert.ok(text.includes(owner), 'launch-plan.md should cite the pinned Programmable owner address');
  assert.match(text, /0x00CC/i, 'launch-plan.md should cite the hook permission mask');
});

test('launch-plan.md is marked as superseded by the Phase 3 handoff', () => {
  const text = readFileSync(launchPlanPath, 'utf8');
  assert.match(text, /Superseded on 2026-09-04/, 'the archived plan needs a dated supersession note');
  assert.match(text, /release\/phase3\/launch-plan\.md/, 'the archive needs the active handoff path');
});
