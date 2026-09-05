import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertProductionCycleEscrowObservationShape,
  fixtureCycleEscrowObservationDigest,
  verifyFixtureCycleEscrowObservation,
  verifyProductionCycleEscrowObservation,
} from '../../src/operator/cycle-escrow-observation.mjs';
import { signFixtureCycleEscrowObservationDigest } from './fixture-crypto.mjs';

const runnerCycleId = 'operator-cycle-one';
const onchainCycleId = `0x${'1'.repeat(64)}`;
const cycleVaultAccount = '0x0000000000000000000000000000000000001002';
const returnAccount = '0x0000000000000000000000000000000000002002';

function observation(overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-cycle-escrow-observation.v1',
    authority: 'hookemon-fixture-cycle-escrow-reader',
    requirementsRevision: 57,
    runnerCycleId,
    onchainCycleId,
    cycleVaultAccount,
    returnAccount,
    method: 'computeCycleEscrow(bytes32)',
    verificationDigest: '',
    verificationSignature: '',
    ...overrides,
  };
  value.verificationDigest = fixtureCycleEscrowObservationDigest(value);
  value.verificationSignature = signFixtureCycleEscrowObservationDigest(value.verificationDigest);
  return value;
}

test('verifies one signed fixture-only computeCycleEscrow observation', () => {
  const verified = verifyFixtureCycleEscrowObservation(observation());
  assert.equal(verified.runnerCycleId, runnerCycleId);
  assert.equal(verified.onchainCycleId, onchainCycleId);
  assert.equal(verified.returnAccount, returnAccount);
  assert.equal(Object.isFrozen(verified), true);
});

test('rejects forged, changed, zero, and decorated escrow observations', () => {
  const valid = observation();
  const changedReturn = { ...valid, returnAccount: '0x0000000000000000000000000000000000002003' };
  const changedCycle = { ...valid, onchainCycleId: `0x${'2'.repeat(64)}` };
  const forgedSignature = { ...valid, verificationSignature: `${valid.verificationSignature.slice(0, -1)}A` };

  assert.throws(() => verifyFixtureCycleEscrowObservation(changedReturn), /digest|signature|verification/i);
  assert.throws(() => verifyFixtureCycleEscrowObservation(changedCycle), /digest|signature|verification/i);
  assert.throws(() => verifyFixtureCycleEscrowObservation(forgedSignature), /signature|verification/i);
  assert.throws(() => verifyFixtureCycleEscrowObservation(observation({ onchainCycleId: `0x${'0'.repeat(64)}` })), /onchain|cycle|zero/i);
  assert.throws(() => verifyFixtureCycleEscrowObservation(observation({ expectedReturnAccount: returnAccount })), /exact schema/i);
});

// WP-34: the production counterpart, anchored in an injected Robinhood (EVM) chain observer instead of a
// bundled Ed25519 signature — see cycle-escrow-observation.mjs's own module comment for the full rationale
// (why the live check runs only where deps are supplied, and why the deps-free shape check alone is what
// replay re-validates).
const productionOnchainCycleId = `0x${'2'.repeat(64)}`;

function fakeEvmObserver(confirmations = new Map()) {
  return {
    seed(key, confirmation) { confirmations.set(key, confirmation); },
    confirmCycleEscrow({ cycleVaultAccount: account, onchainCycleId: cycle }) {
      return confirmations.get(`${account}:${cycle}`) ?? null;
    },
  };
}

function productionObservation(overrides = {}) {
  return {
    schema: 'hookemon.production-cycle-escrow-observation.v1',
    authority: 'production-robinhood-rpc-observer',
    requirementsRevision: 57,
    chainId: '4663',
    runnerCycleId,
    onchainCycleId: productionOnchainCycleId,
    cycleVaultAccount,
    returnAccount,
    method: 'computeCycleEscrow(bytes32)',
    blockNumber: '901',
    blockHash: `sha256:${'3'.repeat(64)}`,
    usdgBalance: '19',
    transferLogsDigest: `sha256:${'4'.repeat(64)}`,
    finalized: true,
    ...overrides,
  };
}

function confirmationFor(observation) {
  return {
    escrowAddress: observation.returnAccount,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    usdgBalance: observation.usdgBalance,
    transferLogsDigest: observation.transferLogsDigest,
    finalized: true,
  };
}

test('verifies a production computeCycleEscrow observation against an injected chain observer confirmation', () => {
  const value = productionObservation();
  const observer = fakeEvmObserver();
  observer.seed(`${cycleVaultAccount}:${productionOnchainCycleId}`, confirmationFor(value));
  const verified = verifyProductionCycleEscrowObservation(value, { observers: { evm: observer } });
  assert.equal(verified.returnAccount, returnAccount);
  assert.equal(verified.usdgBalance, '19');
  assert.equal(Object.isFrozen(verified), true);
});

test('the deps-free shape check accepts well-formed production observations without ever contacting an observer', () => {
  const verified = assertProductionCycleEscrowObservationShape(productionObservation());
  assert.equal(verified.schema, 'hookemon.production-cycle-escrow-observation.v1');
  assert.equal(Object.isFrozen(verified), true);
});

test('rejects a malformed, zero, or decorated production observation before any observer is consulted', () => {
  for (const overrides of [
    { onchainCycleId: `0x${'0'.repeat(64)}` },
    { cycleVaultAccount: returnAccount },
    { blockHash: `sha256:${'0'.repeat(64)}` },
    { blockNumber: '01' },
    { usdgBalance: '-1' },
    { finalized: false },
    { extraField: true },
  ]) {
    assert.throws(() => assertProductionCycleEscrowObservationShape(productionObservation(overrides)), /invalid|zero|schema|differ|canonical/i);
  }
});

test('requires an injected Robinhood chain observer exposing confirmCycleEscrow', () => {
  assert.throws(() => verifyProductionCycleEscrowObservation(productionObservation(), {}), /injected Robinhood chain observer is required/i);
  assert.throws(() => verifyProductionCycleEscrowObservation(productionObservation(), { observers: { evm: {} } }), /injected Robinhood chain observer is required/i);
});

test('rejects a production observation the injected observer never confirmed', () => {
  const observer = fakeEvmObserver();
  assert.throws(
    () => verifyProductionCycleEscrowObservation(productionObservation(), { observers: { evm: observer } }),
    /does not match the injected chain observer confirmation/i,
  );
});

test('rejects a production observation whose escrow address the observer disagrees with (a wrong or stale claimed escrow)', () => {
  const value = productionObservation();
  const observer = fakeEvmObserver();
  // The observer's own live computeCycleEscrow read disagrees with what the observation claims — the
  // exact "wrong escrow address" scenario: a claim that is internally well-formed but not what the chain
  // actually holds for this cycleVaultAccount/onchainCycleId pair.
  observer.seed(`${cycleVaultAccount}:${productionOnchainCycleId}`, { ...confirmationFor(value), escrowAddress: '0x0000000000000000000000000000000000009999' });
  assert.throws(
    () => verifyProductionCycleEscrowObservation(value, { observers: { evm: observer } }),
    /does not match the injected chain observer confirmation/i,
  );
});

test('rejects a production observation whose block hash the observer disagrees with', () => {
  const value = productionObservation();
  const observer = fakeEvmObserver();
  observer.seed(`${cycleVaultAccount}:${productionOnchainCycleId}`, { ...confirmationFor(value), blockHash: `sha256:${'9'.repeat(64)}` });
  assert.throws(
    () => verifyProductionCycleEscrowObservation(value, { observers: { evm: observer } }),
    /does not match the injected chain observer confirmation/i,
  );
});

test('rejects a production observation the observer confirms as not yet finalized', () => {
  const value = productionObservation();
  const observer = fakeEvmObserver();
  observer.seed(`${cycleVaultAccount}:${productionOnchainCycleId}`, { ...confirmationFor(value), finalized: false });
  assert.throws(
    () => verifyProductionCycleEscrowObservation(value, { observers: { evm: observer } }),
    /does not match the injected chain observer confirmation/i,
  );
});
