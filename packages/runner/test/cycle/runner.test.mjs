import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { CycleJournal } from '../../src/cycle/journal.mjs';
import { fixtureCyclePreflightDigest } from '../../src/cycle/preflight.mjs';
import { fixtureActionDigests } from '../../src/cycle/schemas.mjs';
import {
  createCycleDraft,
  createFrozenCycleControl,
  freezeCycleDraft,
} from '../../src/operator/cycle-plan.mjs';
import { createPackSnapshot } from '../../src/operator/pack-selection.mjs';
import {
  fixtureBinding,
  fixtureCollectorAuthorization,
  fixtureCollectorRequest,
  fixtureCycleAction,
  fixtureCyclePreflight,
} from './fixture-cycle.mjs';
import { signFixtureCyclePreflight } from './fixture-crypto.mjs';
import { signFixtureCycleEscrowObservation } from '../operator/fixture-crypto.mjs';

const hash = character => `sha256:${character.repeat(64)}`;
const operationsTrigger = '0x0000000000000000000000000000000000001004';
const cycleVaultAccount = '0x0000000000000000000000000000000000001002';
const returnAccount = '0x0000000000000000000000000000000000002002';

function frozenControl(cycleId = 'cycle-control-one', observationOverrides = {}) {
  const packSnapshot = createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: hash('1'),
    packs: [{ code: 'collector-crypt' }, { code: 'collector-ember' }],
  });
  const preflight = fixtureCyclePreflight(cycleId);
  const plan = freezeCycleDraft(createCycleDraft({
    cycleId,
    authorizationNonce: '1',
    packSnapshotDigest: packSnapshot.snapshotDigest,
    pack: fixtureBinding.pack,
    quantity: fixtureBinding.quantity,
    turbo: fixtureBinding.turbo,
    amount: '10',
    minimumRobinhoodReceive: '19',
    minimumSolanaReceive: '10',
    minimumReturnUsdg: '10',
    robinhoodNativeGasCap: '2',
    solanaNativeGasCap: '2',
    expiresAt: '2030-01-01T00:00:00.000Z',
    bindingManifestDigest: preflight.bindingManifestDigest,
    outboundActionDigest: fixtureActionDigests(fixtureCycleAction('outbound', cycleId, preflight.preflightDigest)).actionDigest,
    returnActionDigest: fixtureActionDigests(fixtureCycleAction('return', cycleId, preflight.preflightDigest)).actionDigest,
    operationsTrigger,
    cycleVaultAccount,
    returnAccount,
  }), packSnapshot);
  const escrowObservation = signFixtureCycleEscrowObservation({
    schema: 'hookemon.fixture-cycle-escrow-observation.v1',
    authority: 'hookemon-fixture-cycle-escrow-reader',
    requirementsRevision: 57,
    runnerCycleId: cycleId,
    onchainCycleId: `0x${'1'.repeat(64)}`,
    cycleVaultAccount,
    returnAccount,
    method: 'computeCycleEscrow(bytes32)',
    verificationDigest: '',
    verificationSignature: '',
    ...observationOverrides,
  });
  return createFrozenCycleControl({ plan, packSnapshot, binding: fixtureBinding, escrowObservation });
}

function changedMinimumPreflight(cycleId) {
  const original = fixtureCyclePreflight(cycleId);
  const value = {
    ...original,
    minimumReceives: { ...original.minimumReceives, outbound: '9' },
    preflightDigest: '',
    ownerAuthorizationSignature: '',
  };
  value.preflightDigest = fixtureCyclePreflightDigest(value);
  value.ownerAuthorizationSignature = signFixtureCyclePreflight(value);
  return value;
}

function changedFundingProjectionPreflight(cycleId, patch) {
  const original = fixtureCyclePreflight(cycleId);
  const value = {
    ...original,
    ...patch,
    preflightDigest: '',
    ownerAuthorizationSignature: '',
  };
  value.preflightDigest = fixtureCyclePreflightDigest(value);
  value.ownerAuthorizationSignature = signFixtureCyclePreflight(value);
  return value;
}

test('treats direct journal appends as untrusted recovery input', () => {
  const journal = new CycleJournal('cycle-1');
  journal.append('cycle-transitioned', {
    expectedVersion: 0,
    expectedJournalHead: null,
    from: 'prepared',
    next: 'open-reconciled',
    evidence: [],
  });
  assert.throws(
    () => CycleRunner.recover('cycle-1', journal.entries, { cycleStore: new FixtureCycleStore() }),
    /order|prefix/,
  );
});

test('does not expose self-attested reconciliation or closure evidence APIs', () => {
  const runner = new CycleRunner('cycle-1', [], { cycleStore: new FixtureCycleStore() });
  assert.equal(runner.recordReconciliationEvidence, undefined);
  assert.equal(runner.recordClosureEvidence, undefined);
});

// WP-31: verifyProductionProviderReceipt is real now (no longer INTEGRATION_PENDING) — a fixture-profile
// runner has no production observers/programIds to verify against, so it refuses with a clear,
// profile-specific error instead; packages/runner/test/integration/production-cycle.test.mjs exercises
// the real production-profile verification end to end.
test('rejects production provider receipt verification on a fixture-profile runner', () => {
  const runner = new CycleRunner('cycle-1', [], { cycleStore: new FixtureCycleStore() });
  assert.throws(() => runner.executeAuthorizedExternalMutationOnce('sha256:' + '1'.repeat(64)), /intent.*unknown|consumed owner approval|required/);
  assert.throws(() => runner.verifyProductionProviderReceipt({}), /production evidence profile/);
});

test('exposes one frozen read-only runner projection', () => {
  const runner = new CycleRunner('cycle-inspection', [], { cycleStore: new FixtureCycleStore() });
  const inspection = runner.inspect();
  assert.deepEqual(inspection, {
    cycleId: 'cycle-inspection',
    stage: 'prepared',
    version: 0,
    journalHead: null,
    controlDigest: null,
    planDigest: null,
    packSnapshotDigest: null,
    payoutFundingPrepared: false,
    unresolvedRequestDigest: null,
  });
  assert.equal(Object.isFrozen(inspection), true);
  assert.throws(() => { inspection.stage = 'closed'; }, /read only|assign|frozen|extensible/i);
  assert.deepEqual(runner.inspect(), inspection);
});

test('journals the complete frozen control first and recovers only against the exact control', () => {
  const cycleId = 'cycle-control-one';
  const control = frozenControl(cycleId);
  const store = new FixtureCycleStore();
  const runner = new CycleRunner(cycleId, [], { cycleStore: store, frozenControl: control });
  assert.throws(() => runner.recordReleasedCyclePreflight(fixtureCyclePreflight(cycleId)), /control.*before|before.*control/i);
  runner.bindFrozenControl();
  runner.recordReleasedCyclePreflight(fixtureCyclePreflight(cycleId));
  assert.equal(runner.entries[0].kind, 'cycle-control-bound');
  assert.deepEqual(runner.entries[0].payload.control, control);

  const recovered = CycleRunner.recover(cycleId, runner.entries, { cycleStore: store, frozenControl: control });
  assert.equal(recovered.inspect().controlDigest, control.controlDigest);
  assert.throws(() => CycleRunner.recover(cycleId, runner.entries, { cycleStore: store }), /trusted.*control/i);
  const other = frozenControl(cycleId, { onchainCycleId: `0x${'2'.repeat(64)}` });
  assert.throws(
    () => CycleRunner.recover(cycleId, runner.entries, { cycleStore: store, frozenControl: other }),
    /control.*differs|differs.*control/i,
  );
});

test('fails closed when recovery starts with an intent instead of the frozen control', () => {
  const cycleId = 'cycle-control-prefix';
  const control = frozenControl(cycleId);
  const preflight = fixtureCyclePreflight(cycleId);
  const journal = new CycleJournal(cycleId);
  journal.append('cycle-preflight-recorded', { preflight, preflightDigest: preflight.preflightDigest });
  assert.throws(
    () => CycleRunner.recover(cycleId, journal.entries, { cycleStore: new FixtureCycleStore(), frozenControl: control }),
    /control.*differs|control.*first|before.*control/i,
  );
});

test('rejects preflight, Collector request, and action bytes that differ from the frozen control', () => {
  const cycleId = 'cycle-control-substitution';
  const control = frozenControl(cycleId);

  let runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore(), frozenControl: control });
  runner.bindFrozenControl();
  assert.throws(() => runner.recordReleasedCyclePreflight(changedMinimumPreflight(cycleId)), /preflight.*frozen|frozen.*preflight/i);
  assert.equal(runner.entries.length, 1);

  runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore(), frozenControl: control });
  runner.bindFrozenControl();
  const preflight = fixtureCyclePreflight(cycleId);
  runner.recordReleasedCyclePreflight(preflight);
  assert.throws(() => runner.prepareCollectorGenerateIntent({
    schema: 'hookemon.fixture-collector-generate-request.v1',
    cycleId,
    pack: 'collector-crypt',
    quantity: 1,
    turbo: false,
    wallet: fixtureBinding.executionWallet,
    memo: `${cycleId}:collector-generate`,
  }), /Collector request.*frozen|frozen.*Collector request/i);

  const request = fixtureCollectorRequest('generate', cycleId);
  runner.prepareCollectorGenerateIntent(request);
  assert.throws(() => runner.consumeCollectorMutationAuthorization({
    request,
    binding: { ...fixtureBinding, refundTokenAccount: 'fixture-refund-token-account-alternate' },
    authorization: fixtureCollectorAuthorization(request, 'generate'),
  }), /Collector authorization.*frozen|binding.*frozen|frozen.*binding/i);

  const changedAction = fixtureCycleAction('outbound', cycleId, preflight.preflightDigest);
  changedAction.binding.pack = 'collector-crypt';
  assert.throws(() => runner.prepareExternalIntent(changedAction), /action.*frozen|frozen.*action/i);
});

test('rejects a signed funding projection that differs from the frozen plan', () => {
  const cycleId = 'cycle-control-funding-projection';
  const control = frozenControl(cycleId);
  for (const patch of [
    { authorizationNonce: '2' },
    { authorizationExpiresAt: '2030-01-02T00:00:00.000Z' },
    { minimumRobinhoodReceive: '18' },
  ]) {
    const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore(), frozenControl: control });
    runner.bindFrozenControl();
    assert.throws(
      () => runner.recordReleasedCyclePreflight(changedFundingProjectionPreflight(cycleId, patch)),
      /preflight.*frozen|frozen.*preflight/i,
    );
    assert.equal(runner.entries.length, 1);
  }
});
