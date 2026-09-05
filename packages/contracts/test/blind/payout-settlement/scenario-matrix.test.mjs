import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'scenario-matrix.json');

const requiredScenarioIds = new Set([
  'process-release-exact-liability',
  'process-release-zero-amount',
  'process-release-liability-plus-one',
  'process-release-stale-operations',
  'process-release-alternate-destination',
  'process-release-cycle-replay',
  'process-release-replay-mutated-amount',
  'process-release-handover-preserves-cycle',
  'process-release-false-return',
  'process-release-revert',
  'process-release-malformed-return',
  'process-release-short-source-delta',
  'process-release-short-destination-delta',
  'process-release-excess-source-delta',
  'process-release-excess-destination-delta',
  'process-release-reentrancy',
  'process-release-failure-isolates-other-money-paths',
  'process-release-forbidden-policy-surface',
  'payout-funding-cycle-bound-operations',
  'payout-funding-current-non-cycle-operations',
  'payout-funding-payer-mismatch',
  'payout-funding-unknown-cycle',
  'payout-funding-zero-identity-field',
  'payout-funding-identifier-replay',
  'payout-funding-field-mutation',
  'payout-funding-same-cycle-new-identifier',
  'payout-funding-false-return',
  'payout-funding-revert',
  'payout-funding-malformed-return',
  'payout-funding-short-source-delta',
  'payout-funding-short-destination-delta',
  'payout-funding-excess-source-delta',
  'payout-funding-excess-destination-delta',
  'payout-funding-direct-transfer',
  'payout-funding-reentrancy',
  'payout-funding-conservation',
  'payout-funding-forbidden-surplus-path',
  'settlement-permissionless-exact-recipient-credit',
  'settlement-index-zero',
  'settlement-index-1023',
  'settlement-replay',
  'settlement-altered-recipient',
  'settlement-altered-amount',
  'settlement-malformed-depth',
  'settlement-reordered-proof',
  'settlement-recipient-failure-isolation',
  'settlement-recipient-retry',
  'settlement-before-300-seconds',
  'settlement-at-300-seconds',
  'settlement-after-300-seconds',
  'settlement-long-horizon',
  'settlement-manual-wallet-replacement-same-cycle-treasury',
  'settlement-manual-wallet-replacement-cross-cycle',
  'settlement-false-return',
  'settlement-revert',
  'settlement-malformed-return',
  'settlement-short-source-delta',
  'settlement-short-recipient-delta',
  'settlement-excess-source-delta',
  'settlement-excess-recipient-delta',
  'settlement-proxy-behavior',
  'settlement-reentrancy',
]);

function readFixture() {
  assert.equal(
    existsSync(fixturePath),
    true,
    'blind payout/settlement scenario fixture is missing',
  );
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

test('blind matrix covers the approved payout and settlement boundary without inventing an ABI', () => {
  const fixture = readFixture();

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.requirementsRevision, 55);
  assert.equal(fixture.sourceCommit, 'ceb3510ceb8111f534d5f5d60011f77722439c81');
  assert.equal(fixture.interfaceBinding, 'deferred-until-frozen');
  assert.equal(fixture.constants.merkleDepth, 10);
  assert.equal(fixture.constants.merklePositions, 1024);
  assert.equal(fixture.constants.entitlementDelaySeconds, 0);
  assert.equal(fixture.constants.recipientReplacement, 'forbidden');

  const ids = fixture.scenarios.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique');
  for (const id of requiredScenarioIds) {
    assert.equal(ids.includes(id), true, `missing blind scenario: ${id}`);
  }

  for (const scenario of fixture.scenarios) {
    assert.match(scenario.id, /^(process-release|payout-funding|settlement)-/);
    assert.ok(['P1-006', 'P1-007', 'P1-008'].includes(scenario.task));
    assert.ok(scenario.requirements.length > 0);
    assert.ok(['commit', 'revert', 'no-liability', 'absent-surface'].includes(scenario.expected.outcome));
    assert.equal(Object.hasOwn(scenario, 'abi'), false);
    assert.equal(Object.hasOwn(scenario, 'selector'), false);
    assert.equal(Object.hasOwn(scenario, 'constructor'), false);

    if (scenario.expected.outcome === 'revert') {
      assert.equal(scenario.expected.stateMutation, 'none');
    }
  }
});

test('cycle authority, exact credits, timing, and replacement policy stay explicit', () => {
  const fixture = readFixture();
  const byId = new Map(fixture.scenarios.map((scenario) => [scenario.id, scenario]));

  const release = byId.get('process-release-exact-liability');
  assert.equal(release.expected.hookUsdgDelta, '-amount');
  assert.equal(release.expected.operationsUsdgDelta, '+amount');
  assert.equal(release.expected.cycleAuthority, 'current-operations-at-release');

  const handover = byId.get('process-release-handover-preserves-cycle');
  assert.equal(handover.expected.cycleAuthority, 'historical-cycle-bound-operations');

  const funding = byId.get('payout-funding-cycle-bound-operations');
  assert.equal(funding.expected.payer, 'historical-cycle-bound-operations');
  assert.equal(funding.expected.operationsUsdgDelta, '-rootSum');
  assert.equal(funding.expected.hookUsdgDelta, '+rootSum');

  const payment = byId.get('settlement-permissionless-exact-recipient-credit');
  assert.equal(payment.expected.destination, 'committed-recipient');
  assert.equal(payment.expected.hookUsdgDelta, '-amount');
  assert.equal(payment.expected.recipientUsdgDelta, '+amount');

  for (const id of [
    'settlement-before-300-seconds',
    'settlement-at-300-seconds',
    'settlement-after-300-seconds',
  ]) {
    assert.equal(byId.get(id).expected.outcome, 'commit');
    assert.equal(byId.get(id).expected.validationRule, 'same-immediate-permissionless-path');
  }

  for (const id of [
    'settlement-manual-wallet-replacement-same-cycle-treasury',
    'settlement-manual-wallet-replacement-cross-cycle',
  ]) {
    assert.equal(byId.get(id).expected.outcome, 'absent-surface');
    assert.equal(byId.get(id).expected.recipientMutation, 'impossible');
  }
});
