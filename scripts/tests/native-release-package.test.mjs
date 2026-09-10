import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildLaunchPackage, normalizePhaseThreeSubmissionDraft, normalizePhaseThreeAddressManifestDraft } from '../programmable/lib/package.mjs';
import { deriveNativeSeedCandidate } from '../programmable/lib/phase3-release.mjs';
import { validateJsonSchema } from '../programmable/lib/json-schema.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = path => JSON.parse(readFileSync(resolve(root, path)));
function fixture(change = () => {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'native-release-'));
  const inputs = read('release/phase3/launch-inputs.json');
  const manifest = read('release/phase3/address-manifest.json');
  change(inputs, manifest);
  writeFileSync(resolve(directory, 'inputs.json'), JSON.stringify(inputs));
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, inputs, manifest, build: () => buildLaunchPackage({
    launchInputsPath: resolve(directory, 'inputs.json'),
    addressManifestPath: resolve(directory, 'manifest.json'),
    artifactDirectory: resolve(root, 'release/phase3/artifacts'),
    standardInputDirectory: resolve(root, 'release/phase3/build-info'),
    outputDirectory: resolve(directory, 'package'),
  }) };
}

test('native draft binds real compiler artifacts without inventing seed or claim ceilings', () => {
  const value = fixture();
  try {
    const result = value.build();
    assert.equal(result.mode, 'address-derivation-pending');
    const draft = JSON.parse(readFileSync(resolve(value.directory, 'package/graph-draft.json')));
    assert.equal(draft.schemaVersion, 'hookemon.phase3.graph-draft.v2');
    assert.equal(value.inputs.pool.quoteAsset.assetId, 'native');
    assert.equal(value.inputs.pool.quoteAsset.amountAtomic, '0');
    assert.deepEqual(value.inputs.pool.fullRange, { minimumTick: 133500, maximumTick: 161220 });
    assert.equal(value.inputs.pool.priceCandidates.nativeCurrency0.sqrtPriceX96, '250929875796514805540091219040452');
    assert.equal(value.manifest.targets[2].constructor.processClaimLimit6hWei, '9960873688152935270');
    assert.equal(value.manifest.targets[2].constructor.processClaimLimitMaxWei, '19921747376305870540');
    assert.equal(value.manifest.targets[2].constructor.processClaimMaxCount, 24);
    assert.equal(draft.seed.nativeFunding.amountWei, '0');
    assert.equal('permit2Allowance' in draft.seed, false);
    for (const name of ['address-manifest.schema.json', 'address-manifest-draft.schema.json']) {
      assert.deepEqual(validateJsonSchema(read(`release/phase3/${name}`), value.manifest), []);
    }
  } finally { rmSync(value.directory, { recursive: true, force: true }); }
});

test('native draft rejects mixed historical assets and one-sided or zero claim limits', () => {
  for (const change of [
    inputs => { inputs.pool.quoteAsset.decimals = 6; },
    inputs => { inputs.pool.quoteAsset.amountAtomic = '1'; },
    inputs => { inputs.roles.usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; },
    (inputs, manifest) => { manifest.targets[2].constructor.processClaimLimit6hWei = '0'; manifest.targets[2].constructor.processClaimLimitMaxWei = '1'; },
    (inputs, manifest) => { manifest.targets[2].constructor.processClaimLimit6hWei = '1'; },
    (inputs, manifest) => { manifest.targets[2].constructor.seedIntentDigest = null; },
  ]) {
    const value = fixture(change);
    try { assert.throws(value.build); } finally { rmSync(value.directory, { recursive: true, force: true }); }
  }
});

test('native submission uses protocol ETH identity and retains explicit provider admission uncertainty', () => {
  const submission = normalizePhaseThreeSubmissionDraft(read('release/phase3/submission.json'), { native: true });
  const quote = submission.assets.find(asset => asset.role === 'quote');
  assert.equal(quote.origin, 'native-eth');
  assert.equal(quote.address, null);
  assert.equal(quote.decimals, 18);
  assert.equal(quote.decimalsSource, 'native-eth-protocol');
  assert.equal(submission.pool.currency0, 'native');
  assert.equal(submission.pool.currency1, 'hkmn');
  assert.match(submission.integration.permit2, /Only HKMN/);
  assert.match(submission.disclosures.join(' '), /require current provider admission/);
  assert.doesNotMatch(JSON.stringify(submission), /USDG|240000000/);
});


test('native review disclosures remove obsolete seed instructions and remain idempotent', () => {
  const submission = read('release/phase3/submission.json');
  submission.disclosures.push('Native ETH is currency0. An obsolete complete-budget prerequisite.');
  const normalized = normalizePhaseThreeSubmissionDraft(submission, { native: true });
  assert.deepEqual(normalizePhaseThreeSubmissionDraft(normalized, { native: true }), normalized);
  assert.deepEqual(normalized.hook.feeMechanism.recipients.map(({sharePpm}) => sharePpm), [66667, 133333, 800000]);
  assert.equal(normalized.hook.feeMechanism.recipients[0].address, '0xD88539d3c4C460136a733A3Fd60cf6BF269079da');
  assert.equal(normalized.disclosures.filter(value => value.startsWith('Native ETH is currency0.')).length, 1);
  assert.match(normalized.launchLifecycle.liquidityFormation.actor, /native ETH/);
  assert.match(normalized.launchLifecycle.liquidityFormation.failure, /native value/);
  assert.match(normalized.operations.monitoring, /native seed value/);
  assert.match(normalized.integration.permit2, /Only HKMN approvals/);
  assert.match(normalized.capabilityExtensions.find(x => x.capabilityId === 'phase-three-launch-graph').trustBoundary, /current provider admission/);
  const manifest = read('release/phase3/address-manifest.json');
  manifest.postDeployAssertions.push('The Permit2 allowance must be exact, live at signing time and cleared by the seed path.');
  const bound = normalizePhaseThreeAddressManifestDraft(manifest);
  assert.deepEqual(normalizePhaseThreeAddressManifestDraft(bound), bound);
  assert.equal(bound.postDeployAssertions.some(value => value.startsWith('The Permit2 allowance must')), false);
  assert.equal(bound.openFacts.some(value => value.includes('two address-order')), false);
});


test('native address schemas require the IR launch profile and preserve historical compiler settings', () => {
  const manifest = read('release/phase3/address-manifest.json');
  for (const name of ['address-manifest.schema.json', 'address-manifest-draft.schema.json']) {
    const schema = read(`release/phase3/${name}`);
    assert.deepEqual(validateJsonSchema(schema, manifest), []);
    for (const [runs, viaIR] of [[1000, false], [200, false], [1000, true]]) {
      const changed = structuredClone(manifest);
      changed.compiler.standardJson.optimizer.runs = runs;
      changed.compiler.standardJson.viaIR = viaIR;
      assert.notDeepEqual(validateJsonSchema(schema, changed), [], `${name}: ${runs}/${viaIR}`);
    }
  }
  const schema = read('release/phase3/address-manifest.schema.json');
  const historical = structuredClone(manifest.compiler);
  historical.standardJson.optimizer.runs = 1000;
  historical.standardJson.viaIR = false;
  const historicalSchema = { $defs: schema.$defs, $ref: '#/$defs/draftCompiler' };
  assert.deepEqual(validateJsonSchema(historicalSchema, historical), []);
  assert.notDeepEqual(validateJsonSchema(historicalSchema, manifest.compiler), []);
  // The materialized profile carries the same exact compiler values as its draft.
  assert.equal(schema.$defs.nativeCompilerProfile.properties.optimizer.properties.runs.const, 200);
  assert.equal(schema.$defs.nativeCompilerProfile.properties.viaIR.const, true);
  assert.equal(schema.$defs.compilerProfile.properties.optimizer.properties.runs.const, 1000);
  assert.equal(schema.$defs.compilerProfile.properties.viaIR.const, false);
});

test('zero-native drafts retain unselected ranges and validate explicit inventory with locked dust', () => {
  for (const tickUpper of [null, 60, 6000]) {
    const value = fixture(inputs => {
      inputs.pool.quoteAsset.amountAtomic = '0';
      inputs.seed.nativeFunding.amountWei = '0';
      inputs.pool.fullRange = { minimumTick: tickUpper === null ? null : -887220, maximumTick: tickUpper };
      inputs.pool.priceCandidates.nativeCurrency0 = tickUpper === null ? null : deriveNativeSeedCandidate({
        nativeWei: '0', hkmnAtomic: inputs.pool.baseAsset.amountAtomic, tickLower: -887220, tickUpper, tickSpacing: 60 });
    });
    try { assert.equal(value.build().mode, 'address-derivation-pending'); }
    finally { rmSync(value.directory, { recursive: true, force: true }); }
  }
});
