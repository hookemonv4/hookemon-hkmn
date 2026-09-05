import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertVerifiedProductionBlockhashValidity,
  fixtureBlockhashValidityDigest,
  verifyFixtureBlockhashValidity,
} from '../../src/cycle/blockhash-validity.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { signFixtureBlockhashValidity } from './fixture-crypto.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function fixtureEvidence(observedHeight, lastValidHeight) {
  const value = {
    schema: 'hookemon.fixture-blockhash-validity.v1',
    authority: 'hookemon-fixture-rpc-verifier',
    cycleId: 'cycle-blockhash-boundary',
    actionDigest: DIGEST,
    messageDigest: DIGEST,
    signedBytesDigest: DIGEST,
    recentBlockhash: 'aabb',
    observedHeight,
    lastValidHeight,
    finalized: true,
    verificationDigest: '',
    verificationSignature: '',
  };
  const verificationDigest = fixtureBlockhashValidityDigest(value);
  const unsigned = { ...value, verificationDigest };
  return { ...unsigned, verificationSignature: signFixtureBlockhashValidity(unsigned) };
}

function productionEvidence(observedHeight, lastValidHeight) {
  const confirmation = { finalized: true, recentBlockhash: 'aabb', lastValidHeight, observedHeight };
  return {
    evidence: {
      schema: 'hookemon.production-blockhash-validity.v1',
      authority: 'production-solana-rpc-observer',
      cycleId: 'cycle-blockhash-boundary',
      actionDigest: DIGEST,
      messageDigest: DIGEST,
      signedBytesDigest: DIGEST,
      recentBlockhash: 'aabb',
      observedHeight,
      lastValidHeight,
      finalized: true,
      observerConfirmationDigest: digest({ domain: 'hookemon.production-blockhash-observer-confirmation.v1', confirmation }),
    },
    observers: { solana: { confirmBlockhashValidity: () => confirmation } },
  };
}

test('the last valid block height itself is still valid; only a greater observed height is stale', () => {
  assert.equal(verifyFixtureBlockhashValidity(fixtureEvidence('100', '100')).observedHeight, '100');
  assert.throws(() => verifyFixtureBlockhashValidity(fixtureEvidence('101', '100')), /stale/);

  const atBoundary = productionEvidence('100', '100');
  assert.equal(assertVerifiedProductionBlockhashValidity(atBoundary.evidence, { observers: atBoundary.observers }).observedHeight, '100');
  const pastBoundary = productionEvidence('101', '100');
  assert.throws(() => assertVerifiedProductionBlockhashValidity(pastBoundary.evidence, { observers: pastBoundary.observers }), /stale/);
});
