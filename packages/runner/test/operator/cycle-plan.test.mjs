import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFrozenCycleControl,
  assertFrozenCyclePlan,
  assertFrozenPlanBinding,
  createCycleDraft,
  createFrozenCycleControl,
  freezeCycleDraft,
  reviseCycleDraft,
} from '../../src/operator/cycle-plan.mjs';
import { createPackSnapshot } from '../../src/operator/pack-selection.mjs';
import { signFixtureCycleEscrowObservation } from './fixture-crypto.mjs';

const hash = character => `sha256:${character.repeat(64)}`;
const coordinator = '0x0000000000000000000000000000000000001002';
const operations = '0x0000000000000000000000000000000000001004';
const returnEscrow = '0x0000000000000000000000000000000000002002';
const maximumUint256 = (1n << 256n) - 1n;
const futureExpiry = () => new Date(Date.now() + 86_400_000).toISOString();

function snapshot() {
  return createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: hash('1'),
    packs: [{ code: 'collector-crypt' }, { code: 'collector-ember' }],
  });
}

function validDraft(packSnapshot, overrides = {}) {
  return {
    cycleId: 'cycle-two',
    authorizationNonce: '2',
    packSnapshotDigest: packSnapshot.snapshotDigest,
    pack: 'collector-ember',
    quantity: 1,
    turbo: false,
    amount: '20',
    minimumRobinhoodReceive: '19',
    minimumSolanaReceive: '18',
    minimumReturnUsdg: '17',
    robinhoodNativeGasCap: '3',
    solanaNativeGasCap: '4',
    expiresAt: futureExpiry(),
    bindingManifestDigest: hash('2'),
    outboundActionDigest: hash('3'),
    returnActionDigest: hash('4'),
    operationsTrigger: operations,
    cycleVaultAccount: coordinator,
    returnAccount: returnEscrow,
    ...overrides,
  };
}

function selectedBinding(overrides = {}) {
  return {
    sourceChainId: 4663,
    executionCluster: 'mainnet-beta',
    circleDollarMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    circleDollarDecimals: 6,
    pack: 'collector-ember',
    quantity: 1,
    turbo: false,
    executionWallet: 'fixture-solana-policy-account',
    refundTokenAccount: 'fixture-refund-token-account',
    refundTokenAccountOwner: 'fixture-solana-policy-account',
    ...overrides,
  };
}

test('revises a draft before freeze and freezes one immutable canonical plan', () => {
  const exactSnapshot = snapshot();
  const draft = createCycleDraft(validDraft(exactSnapshot));
  const revised = reviseCycleDraft(draft, { amount: '25', minimumReturnUsdg: '21' });
  const frozen = freezeCycleDraft(revised, exactSnapshot);

  assert.equal(revised.amount, '25');
  assert.equal(revised.failedCycleId, null);
  assert.equal(revised.failureReceiptDigest, null);
  assert.equal(frozen.schema, 'hookemon.frozen-cycle-plan.v1');
  assert.equal(frozen.amount, '25');
  assert.equal(frozen.minimumReturnUsdg, '21');
  assert.match(frozen.planDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(frozen), true);
  assert.deepEqual(assertFrozenPlanBinding(frozen, selectedBinding()), {
    plan: frozen,
    binding: selectedBinding(),
  });
  assert.throws(() => reviseCycleDraft(frozen, { amount: '26' }), /frozen/i);
});

test('accepts the revision-63 zero return minimum while retaining positive spend floors', () => {
  const exactSnapshot = snapshot();
  const draft = createCycleDraft(validDraft(exactSnapshot, { minimumReturnUsdg: '0' }));

  assert.equal(draft.minimumReturnUsdg, '0');
  assert.throws(
    () => createCycleDraft(validDraft(exactSnapshot, { minimumRobinhoodReceive: '0' })),
    /positive uint256/i,
  );
});

test('binds one immutable failed predecessor pair into the frozen plan', () => {
  const exactSnapshot = snapshot();
  const failedCycleId = `0x${'a'.repeat(64)}`;
  const failureReceiptDigest = `0x${'b'.repeat(64)}`;
  const draft = createCycleDraft(validDraft(exactSnapshot, {
    failedCycleId,
    failureReceiptDigest,
  }));
  const frozen = freezeCycleDraft(draft, exactSnapshot);

  assert.equal(frozen.failedCycleId, failedCycleId);
  assert.equal(frozen.failureReceiptDigest, failureReceiptDigest);
  assert.throws(
    () => reviseCycleDraft(draft, { failedCycleId: `0x${'c'.repeat(64)}` }),
    /editable/i,
  );
  for (const overrides of [
    { failedCycleId, failureReceiptDigest: null },
    { failedCycleId: null, failureReceiptDigest },
    { failedCycleId: `0x${'0'.repeat(64)}`, failureReceiptDigest },
    { failedCycleId, failureReceiptDigest: `0x${'0'.repeat(64)}` },
  ]) {
    assert.throws(
      () => createCycleDraft(validDraft(exactSnapshot, overrides)),
      /failed|failure|predecessor|receipt/i,
    );
  }
});

test('binds freeze to the exact snapshot and selected pack', () => {
  const exactSnapshot = snapshot();
  const otherSnapshot = createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:01.000Z',
    sourcePayloadDigest: hash('5'),
    packs: [{ code: 'collector-ember' }],
  });
  const draft = createCycleDraft(validDraft(exactSnapshot));

  assert.throws(() => freezeCycleDraft(draft, otherSnapshot), /snapshot/i);
  assert.throws(
    () => freezeCycleDraft(createCycleDraft(validDraft(exactSnapshot, { pack: 'collector-missing' })), exactSnapshot),
    /snapshot/i,
  );

  const successorEscrow = '0x0000000000000000000000000000000000002003';
  const successorPlan = freezeCycleDraft(createCycleDraft(validDraft(exactSnapshot, {
    cycleId: 'cycle-three',
    authorizationNonce: '3',
    returnAccount: successorEscrow,
  })), exactSnapshot);
  assert.equal(assertFrozenPlanBinding(successorPlan, selectedBinding()).plan.returnAccount, successorEscrow);
});

test('rejects invalid identities, money, pack mode, digests, and unknown draft fields', () => {
  const exactSnapshot = snapshot();
  const cases = [
    validDraft(exactSnapshot, { cycleId: '' }),
    validDraft(exactSnapshot, { authorizationNonce: '0' }),
    validDraft(exactSnapshot, { authorizationNonce: (maximumUint256 + 1n).toString() }),
    validDraft(exactSnapshot, { amount: '0' }),
    validDraft(exactSnapshot, { amount: (maximumUint256 + 1n).toString() }),
    validDraft(exactSnapshot, { minimumReturnUsdg: '01' }),
    validDraft(exactSnapshot, { quantity: 2 }),
    validDraft(exactSnapshot, { turbo: true }),
    validDraft(exactSnapshot, { bindingManifestDigest: hash('A') }),
    validDraft(exactSnapshot, { bindingManifestDigest: hash('0') }),
    validDraft(exactSnapshot, { outboundActionDigest: hash('0') }),
    validDraft(exactSnapshot, { returnAccount: coordinator }),
    validDraft(exactSnapshot, { returnAccount: operations }),
    validDraft(exactSnapshot, { returnAccount: '0x0000000000000000000000000000000000000000' }),
    { ...validDraft(exactSnapshot), automaticRetry: true },
  ];

  for (const value of cases) {
    assert.throws(() => createCycleDraft(value), /cycle|nonce|amount|minimum|quantity|turbo|digest|return|schema/i);
  }
});

test('allows only explicit draft-editable fields and revalidates the complete candidate', () => {
  const exactSnapshot = snapshot();
  const draft = createCycleDraft(validDraft(exactSnapshot));

  assert.throws(() => reviseCycleDraft(draft, { cycleId: 'another-cycle' }), /editable/i);
  assert.throws(() => reviseCycleDraft(draft, { authorizationNonce: '3' }), /editable/i);
  assert.throws(() => reviseCycleDraft(draft, { amount: '0' }), /amount/i);
  assert.equal(reviseCycleDraft(draft, { pack: 'collector-crypt' }).pack, 'collector-crypt');
});

test('rejects a mutable, tampered, or differently bound frozen plan', () => {
  const exactSnapshot = snapshot();
  const frozen = freezeCycleDraft(createCycleDraft(validDraft(exactSnapshot)), exactSnapshot);

  assert.equal(assertFrozenCyclePlan(frozen), frozen);
  assert.throws(() => assertFrozenCyclePlan({ ...frozen }), /frozen|immutable/i);
  const mutableTamper = { ...frozen, amount: '26' };
  Object.freeze(mutableTamper);
  assert.throws(() => assertFrozenCyclePlan(mutableTamper), /digest/i);
  assert.throws(() => assertFrozenPlanBinding(frozen, selectedBinding({ pack: 'collector-crypt' })), /pack/i);
});

// WP-34: createFrozenCycleControl/assertFrozenCycleControl bound to a *production* escrow observation
// (cycle-escrow-observation.mjs's PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA) instead of the fixture one —
// see cycle-plan.mjs's own module comments for why the live-observer check is deps-optional (state-
// file.mjs and control.mjs's existing deps-free callers must keep working unchanged) and why
// assertFrozenCycleControl itself never takes deps at all (it is what reducer.mjs's journal replay and
// CycleRunner's own constructor call, both always deps-free).
const productionCycleId = 'production-cycle-two';
const productionOnchainCycleId = `0x${'5'.repeat(64)}`;

function productionFrozenPlan(exactSnapshot, overrides = {}) {
  return freezeCycleDraft(createCycleDraft(validDraft(exactSnapshot, { cycleId: productionCycleId, ...overrides })), exactSnapshot);
}

function productionEscrowObservation(overrides = {}) {
  return {
    schema: 'hookemon.production-cycle-escrow-observation.v1',
    authority: 'production-robinhood-rpc-observer',
    requirementsRevision: 57,
    chainId: '4663',
    runnerCycleId: productionCycleId,
    onchainCycleId: productionOnchainCycleId,
    cycleVaultAccount: coordinator,
    returnAccount: returnEscrow,
    method: 'computeCycleEscrow(bytes32)',
    blockNumber: '901',
    blockHash: hash('6'),
    usdgBalance: '19',
    transferLogsDigest: hash('7'),
    finalized: true,
    ...overrides,
  };
}

function fakeEvmObserver() {
  const confirmations = new Map();
  return {
    seed(key, confirmation) { confirmations.set(key, confirmation); },
    confirmCycleEscrow({ cycleVaultAccount: account, onchainCycleId }) { return confirmations.get(`${account}:${onchainCycleId}`) ?? null; },
  };
}

function seedMatchingConfirmation(observer, observation) {
  observer.seed(`${observation.cycleVaultAccount}:${observation.onchainCycleId}`, {
    escrowAddress: observation.returnAccount,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    usdgBalance: observation.usdgBalance,
    transferLogsDigest: observation.transferLogsDigest,
    finalized: true,
  });
}

test('creates and replays one production frozen cycle control without a live observer (deps-free, structural-only, replay-safe)', () => {
  const exactSnapshot = snapshot();
  const plan = productionFrozenPlan(exactSnapshot);
  const escrowObservation = productionEscrowObservation();
  // No `deps` argument at all — the exact call shape state-file.mjs's assertOperatorState and
  // control.mjs's start/recoverActiveRunner already use for every existing (fixture) frozen control.
  const control = createFrozenCycleControl({ plan, packSnapshot: exactSnapshot, binding: selectedBinding(), escrowObservation });
  assert.equal(control.schema, 'hookemon.frozen-cycle-control.v1');
  assert.equal(control.escrowObservation.schema, 'hookemon.production-cycle-escrow-observation.v1');
  const replayed = assertFrozenCycleControl(control);
  assert.equal(replayed.controlDigest, control.controlDigest);
  assert.throws(() => assertFrozenCycleControl({ ...control, escrowObservation: { ...control.escrowObservation, usdgBalance: '999' } }), /digest mismatch/i);
});

test('rejects a production escrow observation whose USDG balance is below the frozen minimum Robinhood receive', () => {
  const exactSnapshot = snapshot();
  const plan = productionFrozenPlan(exactSnapshot);
  const escrowObservation = productionEscrowObservation({ usdgBalance: '18' });
  assert.throws(
    () => createFrozenCycleControl({ plan, packSnapshot: exactSnapshot, binding: selectedBinding(), escrowObservation }),
    /below the frozen minimum/i,
  );
});

test('with an injected live observer, createFrozenCycleControl verifies the production escrow observation and rejects a mismatched block hash or wrong escrow address', () => {
  const exactSnapshot = snapshot();
  const plan = productionFrozenPlan(exactSnapshot);
  const escrowObservation = productionEscrowObservation();
  const observer = fakeEvmObserver();
  seedMatchingConfirmation(observer, escrowObservation);
  const control = createFrozenCycleControl(
    { plan, packSnapshot: exactSnapshot, binding: selectedBinding(), escrowObservation },
    { observers: { evm: observer } },
  );
  assert.ok(control.controlDigest);

  assert.throws(
    () => createFrozenCycleControl(
      { plan, packSnapshot: exactSnapshot, binding: selectedBinding(), escrowObservation: { ...escrowObservation, blockHash: hash('9') } },
      { observers: { evm: observer } },
    ),
    /does not match the injected chain observer confirmation/i,
  );

  // The observer's own live computeCycleEscrow read disagrees with the claimed escrow address.
  const disagreeingObserver = fakeEvmObserver();
  disagreeingObserver.seed(`${escrowObservation.cycleVaultAccount}:${escrowObservation.onchainCycleId}`, {
    escrowAddress: '0x0000000000000000000000000000000000009999',
    blockNumber: escrowObservation.blockNumber,
    blockHash: escrowObservation.blockHash,
    usdgBalance: escrowObservation.usdgBalance,
    transferLogsDigest: escrowObservation.transferLogsDigest,
    finalized: true,
  });
  assert.throws(
    () => createFrozenCycleControl(
      { plan, packSnapshot: exactSnapshot, binding: selectedBinding(), escrowObservation },
      { observers: { evm: disagreeingObserver } },
    ),
    /does not match the injected chain observer confirmation/i,
  );
});
