import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'sequence-invariants.json');

const releaseFailures = ['wrong-caller', 'replay', 'over-liability', 'token-failure'];
const supportedOperations = [
  'canonical-trading',
  'fee-accrual',
  'fee-claim',
  'valid-payout-funding',
  'funded-holder-payment',
];

function readFixture() {
  assert.equal(existsSync(fixturePath), true, 'blind sequence-invariant fixture is missing');
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

test('release failure matrix preserves every supported operation', () => {
  const fixture = readFixture();
  const cases = fixture.processReleaseIsolation.cases;

  assert.equal(fixture.requirementsRevision, 55);
  assert.equal(cases.length, releaseFailures.length * supportedOperations.length);
  for (const failure of releaseFailures) {
    for (const operation of supportedOperations) {
      const row = cases.find((candidate) => (
        candidate.releaseFailure === failure && candidate.followingOperation === operation
      ));
      assert.ok(row, `missing ${failure} -> ${operation} isolation case`);
      assert.equal(row.expected.releaseMutation, 'none');
      assert.equal(row.expected.unusedProcessLiability, 'unchanged');
      assert.equal(row.expected.followingOperation, 'same-outcome-as-clean-baseline');
    }
  }
});

test('stateful and gas plans bind quantitative acceptance thresholds without guessing provider limits', () => {
  const fixture = readFixture();

  assert.equal(fixture.stateful.minimumSequences, 100000);
  assert.deepEqual(fixture.stateful.operations, [
    'fee-accrual',
    'fee-claim',
    'process-release',
    'payout-funding',
    'holder-payment',
    'retry',
    'transfer-failure',
    'direct-transfer',
    'treasury-handover',
    'operations-handover',
  ]);
  assert.deepEqual(fixture.stateful.invariants, [
    'hookUsdgBalance>=allRecognizedLiabilities',
    'payoutFunded=payoutPaid+payoutUnpaid',
    'onePayoutCannotMutateAnotherPayout',
    'directOrExcessTransferCreatesNoLiability',
    'failedCallLeavesNoPartialState',
  ]);

  assert.equal(fixture.gas.providerLimit, 'integration-pending');
  assert.equal(fixture.gas.requiredHeadroom, 'positive');
  assert.deepEqual(fixture.gas.cases, [
    'index-0-valid-first-payment',
    'index-1023-valid-first-payment',
    'replay',
    'malformed-depth',
    'malformed-proof',
    'maximum-subtree-sums',
    'transfer-failure',
  ]);
});
