import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { validateSubmissionFeeOrdering } from '../verify-release-package-closure.mjs';

const root = resolve(import.meta.dirname, '../..');
const launchInputs = JSON.parse(readFileSync(resolve(root, 'release/phase3/launch-inputs.json'), 'utf8'));
const submission = JSON.parse(readFileSync(resolve(root, 'release/phase3/submission.json'), 'utf8'));


test('native draft preserves currency0 fees while funding is unselected', () => {
  assert.doesNotThrow(() => validateSubmissionFeeOrdering(launchInputs, submission));
});

test('native ordering refuses reversed assets and a misplaced fee in every quadrant', () => {
  for (const name of Object.keys(submission.hook.feeMechanism.swapQuadrants)) {
    const changed = structuredClone(submission);
    changed.hook.feeMechanism.swapQuadrants[name].currency = 'currency1';
    assert.throws(() => validateSubmissionFeeOrdering(launchInputs, changed), /fee currency/);
  }
  const reversed = structuredClone(submission);
  reversed.pool.currency0 = 'hkmn'; reversed.pool.currency1 = 'native';
  assert.throws(() => validateSubmissionFeeOrdering(launchInputs, reversed), /pool order/);
  const legacy = structuredClone(launchInputs);
  legacy.pool.priceCandidates.selection.selectedOrdering = 'hkmnCurrency0';
  assert.throws(() => validateSubmissionFeeOrdering(legacy, submission), /pool order/);
});

test('native selected price requires the bound candidate and cannot invent a draft price', () => {
  const inputs = structuredClone(launchInputs);
  inputs.pool.priceCandidates.selection.selectedSqrtPriceX96 = '1';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, submission), /draft selection/);
  inputs.pool.priceCandidates.selection.status = 'DERIVED';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, submission), /selected candidate price/);
  inputs.pool.quoteAsset.amountAtomic = '40000000000000000';
  inputs.pool.priceCandidates.nativeCurrency0 = { sqrtPriceX96: '12527072418752396559322253362376889' };
  inputs.pool.priceCandidates.selection.selectedSqrtPriceX96 = inputs.pool.priceCandidates.nativeCurrency0.sqrtPriceX96;
  assert.doesNotThrow(() => validateSubmissionFeeOrdering(inputs, submission));
  inputs.pool.priceCandidates.selection.selectedSqrtPriceX96 = '1';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, submission), /selected candidate price/);
});

test('historical USDG ordering retains its separate fee currency checks', () => {
  const quadrants = Object.fromEntries(Object.keys(submission.hook.feeMechanism.swapQuadrants).map(name => [name, { currency: 'currency1' }]));
  const inputs = { schemaVersion: 'hookemon.phase3.release-launch-inputs.v1', pool: { priceCandidates: {
    hkmnCurrency0: { sqrtPriceX96: '38813714284914462669', swapFeeQuadrants: quadrants },
    selection: { selectedOrdering: 'hkmnCurrency0', selectedSqrtPriceX96: '38813714284914462669' },
  } } };
  const old = { pool: { currency0: 'hkmn', currency1: 'usdg' }, hook: { feeMechanism: { swapQuadrants: quadrants } } };
  assert.doesNotThrow(() => validateSubmissionFeeOrdering(inputs, old));
  const changed = structuredClone(old); changed.hook.feeMechanism.swapQuadrants.zeroForOneExactInput.currency = 'currency0';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, changed), /submission fee currency/);
});
