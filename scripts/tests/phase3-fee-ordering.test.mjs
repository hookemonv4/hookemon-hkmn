import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { validateSubmissionFeeOrdering } from '../verify-release-package-closure.mjs';

const root = resolve(import.meta.dirname, '../..');
const launchInputs = JSON.parse(readFileSync(resolve(root, 'release/phase3/launch-inputs.json'), 'utf8'));
const submission = JSON.parse(readFileSync(resolve(root, 'release/phase3/submission.json'), 'utf8'));

test('the draft submission fee currency follows its USDG-currency0 candidate', () => {
  assert.doesNotThrow(() => validateSubmissionFeeOrdering(launchInputs, submission));
});

test('a selected HKMN-currency0 ordering requires currency1 fee collection', () => {
  const inputs = structuredClone(launchInputs);
  inputs.pool.priceCandidates.selection.selectedOrdering = 'hkmnCurrency0';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, submission), /pool order|fee currency/i);
});

test('the selected candidate binds pool order, selected price, and both quadrant currency sets', () => {
  const inputs = structuredClone(launchInputs);
  const selectedOrdering = 'hkmnCurrency0';
  const selectedCandidate = inputs.pool.priceCandidates[selectedOrdering];
  inputs.pool.priceCandidates.selection.selectedOrdering = selectedOrdering;
  inputs.pool.priceCandidates.selection.selectedSqrtPriceX96 = selectedCandidate.sqrtPriceX96;

  const selectedSubmission = structuredClone(submission);
  selectedSubmission.pool.currency0 = 'hkmn';
  selectedSubmission.pool.currency1 = 'usdg';
  for (const quadrant of Object.values(selectedSubmission.hook.feeMechanism.swapQuadrants)) quadrant.currency = 'currency1';
  assert.doesNotThrow(() => validateSubmissionFeeOrdering(inputs, selectedSubmission));

  const priceMutation = structuredClone(inputs);
  priceMutation.pool.priceCandidates.selection.selectedSqrtPriceX96 = '1';
  assert.throws(() => validateSubmissionFeeOrdering(priceMutation, selectedSubmission), /selected candidate price/i);

  const candidateQuadrantMutation = structuredClone(inputs);
  candidateQuadrantMutation.pool.priceCandidates[selectedOrdering].swapFeeQuadrants.zeroForOneExactInput.currency = 'currency0';
  assert.throws(() => validateSubmissionFeeOrdering(candidateQuadrantMutation, selectedSubmission), /selected candidate fee currency/i);

  const submissionQuadrantMutation = structuredClone(selectedSubmission);
  submissionQuadrantMutation.hook.feeMechanism.swapQuadrants.zeroForOneExactInput.currency = 'currency0';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, submissionQuadrantMutation), /submission fee currency/i);

  const poolOrderMutation = structuredClone(selectedSubmission);
  poolOrderMutation.pool.currency0 = 'usdg';
  poolOrderMutation.pool.currency1 = 'hkmn';
  assert.throws(() => validateSubmissionFeeOrdering(inputs, poolOrderMutation), /submission pool order/i);
});
