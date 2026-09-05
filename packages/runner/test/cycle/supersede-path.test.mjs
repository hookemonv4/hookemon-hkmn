import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureAuthorizationDigest } from '../../src/cycle/authorization.mjs';
import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import {
  fixtureSupersessionAuthorizationDigest,
  supersedeObserverEvidenceDigest,
} from '../../src/cycle/reducer.mjs';
import { fixtureActionDigests } from '../../src/cycle/schemas.mjs';
import {
  authorizeCollector,
  fixtureCycleAction,
  fixtureCyclePreflight,
  prepareSignedAction,
} from './fixture-cycle.mjs';
import {
  signFixtureOwnerApproval,
  signFixtureSupersedeObserverEvidence,
  signFixtureSupersessionAuthorization,
} from './fixture-crypto.mjs';

// WP-07: real CycleRunner-level coverage for supersedeUnobservedIntent, the heavier, manual, dual-
// observer "kick a stuck cycle" recovery path (design section 2.5's recovery table, owner
// standing-authority key). Unlike void-path.test.mjs's lighter MiniRunner harness — which explicitly
// stops short of reaching a recorded broadcast, since the void path is defined never to apply once one
// exists — this suite drives a real outbound mutation all the way through decode/sign/blockhash/broadcast
// via the exact same CycleRunner the production stage driver will use, because supersession's whole
// precondition is a recorded broadcast that neither independent observer can find landed.

function observerEvidence({
  observer, cycleId, requestDigest, actionKind, signedBytesDigest, broadcastSignature, lastValidHeight, observedHeight,
}) {
  const value = {
    schema: 'hookemon.fixture-supersede-observer-evidence.v1', observer, cycleId, requestDigest, actionKind,
    signedBytesDigest, broadcastSignature, lastValidHeight, observedHeight, finalized: true, status: 'NOT_FOUND',
    evidenceDigest: '', evidenceSignature: '',
  };
  const evidenceDigest = supersedeObserverEvidenceDigest(value);
  const unsigned = { ...value, evidenceDigest };
  return { ...unsigned, evidenceSignature: signFixtureSupersedeObserverEvidence(unsigned, observer) };
}

function dualProof({
  cycleId, requestDigest, actionKind, signedBytesDigest, broadcastSignature, lastValidHeight,
  providerObservedHeight, rpcObservedHeight = providerObservedHeight,
}) {
  return {
    provider: observerEvidence({
      observer: 'provider', cycleId, requestDigest, actionKind, signedBytesDigest, broadcastSignature,
      lastValidHeight, observedHeight: providerObservedHeight,
    }),
    rpc: observerEvidence({
      observer: 'rpc', cycleId, requestDigest, actionKind, signedBytesDigest, broadcastSignature,
      lastValidHeight, observedHeight: rpcObservedHeight,
    }),
  };
}

function supersessionAuthorization({ cycleId, requestDigest, actionKind, nonce, expiry = '2030-01-01T00:00:00.000Z' }) {
  const value = {
    schema: 'hookemon.fixture-supersession-authorization.v1', fixtureOwner: 'fixture-owner', cycleId, requestDigest,
    actionKind, nonce, attempt: 1, expiry, fixtureApprovalDigest: '', fixtureApprovalSignature: '',
  };
  const fixtureApprovalDigest = fixtureSupersessionAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  return { ...unsigned, fixtureApprovalSignature: signFixtureSupersessionAuthorization(unsigned) };
}

function broadcastOutbound(cycleId) {
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
  const preflight = fixtureCyclePreflight(cycleId);
  runner.recordReleasedCyclePreflight(preflight);
  const action = fixtureCycleAction('outbound', cycleId, preflight.preflightDigest);
  const execution = prepareSignedAction(runner, action);
  return { runner, action, execution, requestDigest: execution.intent.requestDigest };
}

// Mirrors void-path.test.mjs's own local ownerApproval helper exactly (that file duplicates it rather
// than importing fixture-cycle.mjs's internal, unexported copy — the same established convention this
// test follows) so an outbound action can be prepared and its mutation authorized and attempted without
// driving it all the way through decode/sign/blockhash/broadcast.
function ownerApproval(intent, preparedAction, authorizationKind, subjectDigest) {
  const value = {
    schema: 'hookemon.fixture-owner-approval.v1', fixtureOwner: 'fixture-owner', cycleId: preparedAction.cycleId,
    actionKind: preparedAction.actionKind, authorizationKind, subjectDigest, preflightDigest: preparedAction.preflightDigest,
    operationsTrigger: preparedAction.operationsTrigger, cycleVaultAccount: preparedAction.cycleVaultAccount,
    policyAccount: preparedAction.policyAccount, returnAccount: preparedAction.returnAccount,
    principalAmount: preparedAction.principalAmount,
    minimumReceive: preparedAction.minimumReceive, nativeGasAmount: preparedAction.nativeGasAmount, provider: preparedAction.provider,
    actionDigest: intent.actionDigest, bindingDigest: intent.bindingDigest, sourceAccount: preparedAction.sourceAccount,
    inputAsset: preparedAction.inputAsset, outputAsset: preparedAction.outputAsset, destination: preparedAction.destination,
    mint: preparedAction.mint, nftMint: preparedAction.nftMint, nftCustodyAccount: preparedAction.nftCustodyAccount,
    amount: preparedAction.amount, instructionsDigest: intent.instructionsDigest, signersDigest: intent.signersDigest,
    nonce: `${preparedAction.cycleId}-${preparedAction.actionKind}-${authorizationKind}-nonce`, attempt: 1,
    expiry: '2030-01-01T00:00:00.000Z', fixtureApprovalDigest: '', fixtureApprovalSignature: '',
  };
  const fixtureApprovalDigest = fixtureAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  return { ...unsigned, fixtureApprovalSignature: signFixtureOwnerApproval(unsigned) };
}

function attemptedOutbound(cycleId) {
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
  const preflight = fixtureCyclePreflight(cycleId);
  runner.recordReleasedCyclePreflight(preflight);
  const action = fixtureCycleAction('outbound', cycleId, preflight.preflightDigest);
  const intent = runner.prepareExternalIntent(action);
  const mutation = ownerApproval(intent, action, 'mutation', intent.actionDigest);
  runner.recordOwnerAuthorization(mutation);
  runner.consumeAuthorizationOnce(mutation);
  runner.executeAuthorizedExternalMutationOnce(intent.requestDigest);
  return { runner, action, requestDigest: intent.requestDigest };
}

test('supersedes a broadcast-but-unobserved outbound mutation given a valid dual proof and fresh owner authorization, freeing a new intent', () => {
  const cycleId = 'cycle-supersede-outbound';
  const { runner, action, requestDigest } = broadcastOutbound(cycleId);
  assert.equal(runner.inspect().unresolvedRequestDigest, requestDigest);

  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'outbound',
    signedBytesDigest: runner.entries.find(entry => entry.kind === 'signed-bytes-recorded').payload.signedBytesDigest,
    broadcastSignature: runner.entries.find(entry => entry.kind === 'broadcast-recorded').payload.broadcastSignature,
    lastValidHeight: action.validity.lastValidHeight,
    providerObservedHeight: (BigInt(action.validity.lastValidHeight) + 5n).toString(),
  });
  const authorization = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'outbound', nonce: `${cycleId}-supersede-1` });

  const result = runner.supersedeUnobservedIntent({ requestDigest, proof, authorization });
  assert.equal(result.status, 'SUPERSEDED');
  assert.equal(result.requestDigest, requestDigest);
  assert.equal(runner.inspect().unresolvedRequestDigest, null);

  // A fresh outbound action — a distinct validity window, hence a distinct digest — can now be prepared
  // for the same cycle slot, exactly as the void path already proves for its own retirement.
  const freshAction = { ...fixtureCycleAction('outbound', cycleId, action.preflightDigest), validity: { recentBlockhash: 'eeff', currentHeight: '30', lastValidHeight: '40' } };
  const freshDigests = fixtureActionDigests(freshAction);
  assert.notEqual(freshDigests.actionDigest, requestDigest);
  assert.doesNotThrow(() => runner.prepareExternalIntent(freshAction));
});

test('rejects superseding a mutation that was attempted but never actually broadcast', () => {
  const cycleId = 'cycle-supersede-not-broadcast';
  const { runner, action, requestDigest } = attemptedOutbound(cycleId);
  assert.equal(runner.inspect().unresolvedRequestDigest, requestDigest);
  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'outbound', signedBytesDigest: `sha256:${'a'.repeat(64)}`,
    broadcastSignature: 'irrelevant', lastValidHeight: action.validity.lastValidHeight, providerObservedHeight: '999999',
  });
  const authorization = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'outbound', nonce: `${cycleId}-n` });
  assert.throws(
    () => runner.supersedeUnobservedIntent({ requestDigest, proof, authorization }),
    /a recorded broadcast is required/,
  );
});

test('rejects superseding a Collector mutation (broadcast-based supersession only)', () => {
  const cycleId = 'cycle-supersede-collector';
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
  const preflight = fixtureCyclePreflight(cycleId);
  runner.recordReleasedCyclePreflight(preflight);
  const { authorization } = authorizeCollector(runner, 'generate', cycleId);
  const requestDigest = authorization.requestDigest;
  assert.equal(runner.inspect().unresolvedRequestDigest, requestDigest);
  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'collector-generate', signedBytesDigest: `sha256:${'a'.repeat(64)}`,
    broadcastSignature: 'irrelevant', lastValidHeight: '10', providerObservedHeight: '20',
  });
  const supersession = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'collector-generate', nonce: `${cycleId}-n` });
  assert.throws(
    () => runner.supersedeUnobservedIntent({ requestDigest, proof, authorization: supersession }),
    /broadcast-based action mutations/,
  );
});

test('rejects a supersede proof bound to the wrong action kind', () => {
  const cycleId = 'cycle-supersede-wrong-kind';
  const { runner, action, requestDigest } = broadcastOutbound(cycleId);
  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'purchase',
    signedBytesDigest: runner.entries.find(entry => entry.kind === 'signed-bytes-recorded').payload.signedBytesDigest,
    broadcastSignature: runner.entries.find(entry => entry.kind === 'broadcast-recorded').payload.broadcastSignature,
    lastValidHeight: action.validity.lastValidHeight,
    providerObservedHeight: (BigInt(action.validity.lastValidHeight) + 5n).toString(),
  });
  const authorization = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'outbound', nonce: `${cycleId}-n` });
  assert.throws(() => runner.supersedeUnobservedIntent({ requestDigest, proof, authorization }), /supersede observer evidence is invalid/);
});

test('rejects dual observer evidence that disagrees on the observed height', () => {
  const cycleId = 'cycle-supersede-height-mismatch';
  const { runner, action, requestDigest } = broadcastOutbound(cycleId);
  const lastValidHeight = action.validity.lastValidHeight;
  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'outbound',
    signedBytesDigest: runner.entries.find(entry => entry.kind === 'signed-bytes-recorded').payload.signedBytesDigest,
    broadcastSignature: runner.entries.find(entry => entry.kind === 'broadcast-recorded').payload.broadcastSignature,
    lastValidHeight,
    providerObservedHeight: (BigInt(lastValidHeight) + 5n).toString(),
    rpcObservedHeight: (BigInt(lastValidHeight) + 6n).toString(),
  });
  const authorization = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'outbound', nonce: `${cycleId}-n` });
  assert.throws(() => runner.supersedeUnobservedIntent({ requestDigest, proof, authorization }), /independently agree on the observed height/);
});

test('rejects a forged supersession authorization signature', () => {
  const cycleId = 'cycle-supersede-forged-owner';
  const { runner, action, requestDigest } = broadcastOutbound(cycleId);
  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'outbound',
    signedBytesDigest: runner.entries.find(entry => entry.kind === 'signed-bytes-recorded').payload.signedBytesDigest,
    broadcastSignature: runner.entries.find(entry => entry.kind === 'broadcast-recorded').payload.broadcastSignature,
    lastValidHeight: action.validity.lastValidHeight,
    providerObservedHeight: (BigInt(action.validity.lastValidHeight) + 5n).toString(),
  });
  const authorization = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'outbound', nonce: `${cycleId}-n` });
  const forged = { ...authorization, fixtureApprovalSignature: `${authorization.fixtureApprovalSignature.startsWith('A') ? 'B' : 'A'}${authorization.fixtureApprovalSignature.slice(1)}` };
  assert.throws(() => runner.supersedeUnobservedIntent({ requestDigest, proof, authorization: forged }), /signature is invalid/);
});

test('rejects an expired supersession authorization', () => {
  const cycleId = 'cycle-supersede-expired-owner';
  const { runner, action, requestDigest } = broadcastOutbound(cycleId);
  const proof = dualProof({
    cycleId, requestDigest, actionKind: 'outbound',
    signedBytesDigest: runner.entries.find(entry => entry.kind === 'signed-bytes-recorded').payload.signedBytesDigest,
    broadcastSignature: runner.entries.find(entry => entry.kind === 'broadcast-recorded').payload.broadcastSignature,
    lastValidHeight: action.validity.lastValidHeight,
    providerObservedHeight: (BigInt(action.validity.lastValidHeight) + 5n).toString(),
  });
  const authorization = supersessionAuthorization({ cycleId, requestDigest, actionKind: 'outbound', nonce: `${cycleId}-n`, expiry: '2028-01-01T00:00:00.000Z' });
  assert.throws(() => runner.supersedeUnobservedIntent({ requestDigest, proof, authorization }), /expired/);
});
