import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { derivePriceCandidates, isEip55Address } from '../programmable/lib/phase3-release.mjs';
import { PROGRAMMABLE_GRAPH_FACTORY } from '../mine-hook-address.mjs';
import { deriveReleasePackageClosure } from '../verify-release-package-closure.mjs';

const root = resolve(import.meta.dirname, '../..');
const node = process.execPath;
const expectedPhaseThreeJsonPaths = [
  'release/phase3/address-manifest-draft.schema.json',
  'release/phase3/address-manifest.json',
  'release/phase3/address-manifest.schema.json',
  'release/phase3/admission/preflight-probe.json',
  'release/phase3/admission/provider-documents.json',
  'release/phase3/admission/route-log.json',
  'release/phase3/artifacts/custody.json',
  'release/phase3/artifacts/hook.json',
  'release/phase3/artifacts/token.json',
  'release/phase3/build-info/launch.json',
  'release/phase3/compatibility-report.json',
  'release/phase3/deployment-manifest.json',
  'release/phase3/fork-pin.json',
  'release/phase3/genesis-evidence.json',
  'release/phase3/graph-gas-evidence.json',
  'release/phase3/launch-inputs.example.json',
  'release/phase3/launch-inputs.json',
  'release/phase3/package/graph-draft.json',
  'release/phase3/package/package-manifest.json',
  'release/phase3/submission.json',
  'release/phase3/tickmath-vectors.json',
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
}

function collectAddresses(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectAddresses(entry, result));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectAddresses(entry, result));
  } else if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)) {
    result.push(value);
  }
  return result;
}

function phaseThreeJsonPathsOnDisk() {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (path.endsWith('.json') && path !== 'release/phase3/review-target.json') paths.push(path);
    }
  };
  visit('release/phase3');
  return paths.sort();
}

function phaseThreeClosurePaths() {
  return deriveReleasePackageClosure().files
    .map(({ path }) => path)
    .filter((path) => path.startsWith('release/phase3/'))
    .filter((path) => path !== 'release/phase3/review-target.json')
    .sort();
}

function phaseThreeJsonRecords() {
  const closurePaths = phaseThreeClosurePaths()
    .filter((path) => path.startsWith('release/phase3/') && path.endsWith('.json'))
    .sort();
  assert.deepEqual(closurePaths, expectedPhaseThreeJsonPaths, 'the derived closure must cover the Phase 3 JSON evidence set');
  assert.deepEqual(phaseThreeJsonPathsOnDisk(), expectedPhaseThreeJsonPaths, 'the Phase 3 JSON evidence set drifted on disk');
  return closurePaths.map((path) => ({ path, value: readJson(path) }));
}

function assertClosureAddressesAndTargetOrder(records) {
  for (const { path, value } of records) {
    for (const address of collectAddresses(value)) {
      assert.equal(isEip55Address(address), true, `${path} contains a non-checksummed address: ${address}`);
    }
  }
  const valueAt = (path) => records.find((record) => record.path === path)?.value;
  const manifest = valueAt('release/phase3/address-manifest.json');
  const graphDraft = valueAt('release/phase3/package/graph-draft.json');
  const example = valueAt('release/phase3/launch-inputs.example.json');
  assert.ok(manifest, 'derived closure omitted the address manifest');
  assert.ok(graphDraft, 'derived closure omitted the graph draft');
  assert.ok(example, 'derived closure omitted the launch-input example');
  assert.deepEqual(manifest.targets.map((target) => target.targetId), ['token', 'custody', 'hook']);
  assert.deepEqual(graphDraft.graph.targets.map((target) => target.targetId), ['token', 'custody', 'hook']);
  assert.deepEqual(Object.keys(example.targets), ['token', 'custody', 'hook']);
  assert.deepEqual(Object.values(example.targets).map((target) => target.targetIndex), [0, 1, 2]);
  assert.equal(example.targets.token.contractName, 'HKMNToken');
  assert.deepEqual(example.targets.token.constructorArguments, [
    { ref: 'chain.factory' },
    { ref: 'usdg' },
    18,
    { ref: 'pool.selectedPriceCandidate.sqrtPriceX96' },
  ]);
  assert.equal(example.targets.custody.contractName, 'PermanentPositionCustody');
  assert.deepEqual(example.targets.custody.constructorArguments, [{ ref: 'roles.positionManager' }, 0]);
  assert.equal(example.targets.hook.contractName, 'HookemonHook');
}

test('the committed launch package retains only the current owner and provider inputs', () => {
  const command = ['scripts/programmable/verify-launch-package.mjs'];
  const blocked = spawnSync(node, command, { cwd: root, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0, blocked.stdout);
  const permitted = spawnSync(node, [...command, '--allow-unverified'], { cwd: root, encoding: 'utf8' });
  assert.equal(permitted.status, 0, permitted.stderr);
  assert.deepEqual(JSON.parse(permitted.stdout).unverified, [
    'UNVERIFIED_LAUNCH_INTENT_PREIMAGE',
    'PROVIDER_API_KEY_PENDING',
    'OWNER_WALLET_FUNDING_PENDING',
    'BUILDER_IDENTITY_PENDING',
  ]);
});

test('the unsigned revision 65 baseline pins its current approval subjects', () => {
  const baseline = readJson('decisions/owner-approvals/revision-65-baseline.json');
  assert.equal(baseline.approvalToken, 'DRAFT_UNSIGNED_NOT_YET_APPROVED');
  for (const [path, digest] of Object.entries(baseline.subjectHashes)) {
    assert.equal(digest, sha256(path), `${path} drifted from the unsigned baseline`);
  }
});

test('the release draft keeps provider target order and source-bound artifact evidence', () => {
  const manifest = readJson('release/phase3/address-manifest.json');
  const graphDraft = readJson('release/phase3/package/graph-draft.json');
  assert.deepEqual(manifest.targets.map((target) => target.targetId), ['token', 'custody', 'hook']);
  assert.deepEqual(graphDraft.graph.targets.map((target) => target.targetId), ['token', 'custody', 'hook']);
  assert.deepEqual(graphDraft.graph.targets.map((target) => target.targetIndex), [0, 1, 2]);
  assert.equal(manifest.compiler.buildInfo.localBuildInfoCount, 1);
  assert.equal(typeof manifest.compiler.buildInfo.sourceContentSha256, 'string');
  assert.equal(manifest.compiler.buildInfo.sourceCount > 0, true);
  assert.equal(Object.hasOwn(manifest.compiler.buildInfo, 'localBuildInfoSha256'), false);
  assert.equal(Object.hasOwn(graphDraft.seed, 'liquidity'), false);
  for (const target of graphDraft.graph.targets) assert.match(target.artifactSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(PROGRAMMABLE_GRAPH_FACTORY, '0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd');
});

test('the two seed candidates are independently derived from the owner amounts', () => {
  const launchInputs = readJson('release/phase3/launch-inputs.json');
  assert.equal(launchInputs.token.allocation.canonicalPoolBps, 10_000);
  assert.equal(launchInputs.token.allocation.remainderCustodyBps, 0);
  assert.equal(launchInputs.token.allocation.canonicalPool.amountAtomic, '1000000000000000000000000000');
  assert.equal(launchInputs.token.allocation.remainderCustody.amountAtomic, '0');
  assert.equal(launchInputs.pool.quoteAsset.amountAtomic, '240000000');
  assert.equal(launchInputs.pool.baseAsset.amountAtomic, '1000000000000000000000000000');
  assert.equal(Math.abs(launchInputs.pool.fullRange.minimumTick % launchInputs.pool.tickSpacing), 0);
  assert.equal(Math.abs(launchInputs.pool.fullRange.maximumTick % launchInputs.pool.tickSpacing), 0);
  const candidates = derivePriceCandidates({
    usdgAtomic: launchInputs.pool.quoteAsset.amountAtomic,
    hkmnAtomic: launchInputs.pool.baseAsset.amountAtomic,
  });
  for (const name of ['usdgCurrency0', 'hkmnCurrency0']) {
    const actual = launchInputs.pool.priceCandidates[name];
    assert.deepEqual(
      {
        sqrtPriceX96: actual.sqrtPriceX96,
        sqrtLowerX96: actual.sqrtLowerX96,
        sqrtUpperX96: actual.sqrtUpperX96,
        liquidity: actual.liquidity,
        amount0Max: actual.amount0Max,
        amount1Max: actual.amount1Max,
        consumedAmount0: actual.consumedAmount0,
        consumedAmount1: actual.consumedAmount1,
        consumedHkmn: actual.consumedHkmn,
      },
      {
        sqrtPriceX96: candidates[name].sqrtPriceX96,
        sqrtLowerX96: candidates[name].sqrtLowerX96,
        sqrtUpperX96: candidates[name].sqrtUpperX96,
        liquidity: candidates[name].liquidity,
        amount0Max: candidates[name].amount0Max,
        amount1Max: candidates[name].amount1Max,
        consumedAmount0: candidates[name].consumedAmount0,
        consumedAmount1: candidates[name].consumedAmount1,
        consumedHkmn: candidates[name].consumedHkmn,
      },
    );
  }
  for (const candidate of Object.values(candidates)) {
    assert.equal(candidate.consumedAmount0, candidate.amount0Max);
    assert.equal(candidate.consumedAmount1, candidate.amount1Max);
  }
});

test('the independently derived Phase 3 JSON closure uses EIP-55 and provider target order', () => {
  assertClosureAddressesAndTargetOrder(phaseThreeJsonRecords());
});

test('the closure address and target-order checks reject a mutation', () => {
  const records = structuredClone(phaseThreeJsonRecords());
  const forkPin = records.find(({ path }) => path === 'release/phase3/fork-pin.json');
  forkPin.value.contracts.usdg.implementation.address = forkPin.value.contracts.usdg.implementation.address.toLowerCase();
  assert.throws(() => assertClosureAddressesAndTargetOrder(records), /non-checksummed address/);

  const reordered = structuredClone(phaseThreeJsonRecords());
  const example = reordered.find(({ path }) => path === 'release/phase3/launch-inputs.example.json');
  example.value.targets = Object.fromEntries(Object.entries(example.value.targets).reverse());
  assert.throws(() => assertClosureAddressesAndTargetOrder(reordered), /Expected values to be strictly deep-equal/);
});

test('the independently derived closure only describes the three-call launch graph', () => {
  for (const path of phaseThreeClosurePaths()) {
    const source = readFileSync(resolve(root, path), 'utf8');
    assert.doesNotMatch(source, /\bfour(?:-| )calls?\b/i, `${path} still contains a retired graph label`);
  }
});

test('release artifacts keep anonymous builder metadata', () => {
  const launchInputs = readJson('release/phase3/launch-inputs.json');
  const submission = readJson('release/phase3/submission.json');
  assert.equal(launchInputs.metadata.x, 'https://x.com/hookemon4');
  assert.equal(Object.hasOwn(launchInputs.metadata, 'xNote'), false);
  assert.equal(submission.builder.github, null);
  assert.equal(submission.builder.contact, null);
  assert.equal(Object.hasOwn(submission.builder, 'builderNote'), false);
});
