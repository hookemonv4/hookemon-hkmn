import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import {
  assertVerifiedFixtureCollectorOpenExecution,
  assertVerifiedFixtureCollectorOpenCustody,
  assertVerifiedFixtureCollectorRpcFinality,
  assertVerifiedFixtureCollectorStatus,
  fixtureCollectorMutationAuthorizationDigest,
  fixtureCollectorOpenExecutionDigest,
  fixtureCollectorOpenCustodyDigest,
  fixtureCollectorStatusDigest,
} from '../../src/cycle/collector.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST, fixtureCyclePreflightDigest, fixtureCycleReleaseVerificationDigest } from '../../src/cycle/preflight.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { signFixtureCollectorMutationAuthorization, signFixtureCollectorOpenExecution, signFixtureCollectorOpenCustody, signFixtureCollectorRpcFinality, signFixtureCollectorStatus, signFixtureCyclePreflight, signFixtureCycleRelease } from './fixture-crypto.mjs';

const cycleId = 'collector-cycle';
const returnAccount = '0x0000000000000000000000000000000000002002';
const binding = Object.freeze({
  sourceChainId: 4663, executionCluster: 'mainnet-beta',
  circleDollarMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', circleDollarDecimals: 6,
  pack: 'collector-ember', quantity: 1, turbo: false,
  executionWallet: 'fixture-solana-policy-account', refundTokenAccount: 'fixture-refund-token-account', refundTokenAccountOwner: 'fixture-solana-policy-account',
});

function preflight() {
  const release = {
    schema: 'hookemon.fixture-cycle-release.v1', authority: 'hookemon-fixture-release-verifier', chainId: '4663', cycleId,
    requirementsRevision: 57, operationsTrigger: '0x0000000000000000000000000000000000001004', cycleVaultAccount: '0x0000000000000000000000000000000000001002', asset: 'USDG', amount: '10',
    transactionId: digest({ domain: 'collector-release-transaction', cycleId }), blockNumber: '100',
    blockHash: digest({ domain: 'collector-release-block', cycleId }), finalized: true, verificationDigest: '', verificationSignature: '',
  };
  const verificationDigest = fixtureCycleReleaseVerificationDigest(release);
  const signedRelease = { ...release, verificationDigest };
  signedRelease.verificationSignature = signFixtureCycleRelease(signedRelease);
  const value = {
    schema: 'hookemon.fixture-cycle-preflight.v1', fixtureOwner: 'fixture-owner', requirementsRevision: 57, cycleId,
    operationsTrigger: '0x0000000000000000000000000000000000001004', cycleVaultAccount: '0x0000000000000000000000000000000000001002',
    policyAccount: 'fixture-solana-policy-account', returnAccount,
    hook: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', usdg: '0x0000000000000000000000000000000000001003',
    authorizationNonce: '1', authorizationExpiresAt: '2030-01-01T00:00:00.000Z', minimumRobinhoodReceive: '19',
    releasedAmount: '10', totalPrincipal: '10', spendCap: '10', nativeGasCaps: { robinhood: '1', solana: '4' },
    minimumReceives: { outbound: '10', purchase: '10', buyback: '10', return: '10' }, bindingManifestDigest: FIXTURE_BINDING_MANIFEST_DIGEST,
    releaseEvidence: signedRelease, preflightDigest: '', ownerAuthorizationSignature: '',
  };
  const preflightDigest = fixtureCyclePreflightDigest(value);
  const signed = { ...value, preflightDigest };
  return { ...signed, ownerAuthorizationSignature: signFixtureCyclePreflight(signed) };
}

function preparedRunner() {
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
  runner.recordReleasedCyclePreflight(preflight());
  return runner;
}

function collectorRequest(action) {
  return {
    schema: `hookemon.fixture-collector-${action}-request.v1`,
    cycleId,
    pack: binding.pack,
    quantity: 1,
    turbo: false,
    wallet: binding.executionWallet,
    ...(action === 'open' ? { prizeWallet: 'fixture-destination-purchase' } : {}),
    memo: `${cycleId}:collector-${action}`,
  };
}

function collectorAuthorization(request, action, overrides = {}) {
  const requestDigest = digest({ domain: `hookemon.fixture-collector-${action}-request.v1`, request });
  const authorization = {
    schema: 'hookemon.fixture-collector-mutation-authorization.v1',
    fixtureOwner: 'fixture-owner',
    cycleId,
    action,
    requestDigest,
    pack: request.pack,
    quantity: request.quantity,
    turbo: request.turbo,
    wallet: request.wallet,
    prizeWallet: request.prizeWallet ?? 'fixture-destination-purchase',
    memo: request.memo,
    nonce: `collector-${action}-nonce`,
    attempt: 1,
    expiry: '2030-01-01T00:00:00.000Z',
    ...overrides,
    fixtureApprovalDigest: '',
    fixtureApprovalSignature: '',
  };
  authorization.fixtureApprovalDigest = digest({
    domain: 'hookemon.fixture-collector-mutation-authorization.v1',
    fixtureOwner: 'fixture-owner',
    payload: Object.fromEntries(Object.entries(authorization).filter(([key]) => !['fixtureApprovalDigest', 'fixtureApprovalSignature'].includes(key))),
  });
  authorization.fixtureApprovalSignature = signFixtureCollectorMutationAuthorization(authorization);
  return authorization;
}

function authorizeCollectorMutation(runner, action) {
  const request = collectorRequest(action);
  if (action === 'generate') runner.prepareCollectorGenerateIntent(request);
  else runner.prepareCollectorOpenIntent(request);
  const authorization = collectorAuthorization(request, action);
  runner.consumeCollectorMutationAuthorization({ request, binding, authorization });
  runner.executeAuthorizedExternalMutationOnce(authorization.requestDigest);
  return request;
}

test('Collector generation requires the signed prepared-cycle preflight and consumes one exact response', () => {
  const unprepared = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
  assert.throws(() => unprepared.generateCollectorPack({ binding }), /preflight|prepared/i);

  const runner = preparedRunner();
  assert.throws(() => runner.generateCollectorPack({ binding }), /intent|authorization/i);
  authorizeCollectorMutation(runner, 'generate');
  const generated = runner.generateCollectorPack({ binding });
  assert.deepEqual(generated, {
    schema: 'hookemon.fixture-collector-generate.v1', responseId: `fixture-collector-generate-${cycleId}`,
    cycleId, pack: binding.pack, quantity: 1, turbo: false,
    wallet: binding.executionWallet, prizeWallet: 'fixture-destination-purchase',
  });
  assert.throws(() => runner.generateCollectorPack({ binding }), /already|duplicate/i);
});

test('prepares an exact durable Collector generate intent before an authorized mutation', () => {
  const runner = preparedRunner();
  const request = {
    schema: 'hookemon.fixture-collector-generate-request.v1',
    cycleId,
    pack: binding.pack,
    quantity: 1,
    turbo: false,
    wallet: binding.executionWallet,
    memo: `${cycleId}:collector-generate`,
  };

  const prepared = runner.prepareCollectorGenerateIntent(request);
  assert.deepEqual(prepared, {
    ...request,
    requestDigest: digest({ domain: 'hookemon.fixture-collector-generate-request.v1', request }),
  });
  const authorization = { schema: 'hookemon.fixture-collector-mutation-authorization.v1', fixtureOwner: 'fixture-owner', cycleId, action: 'generate', requestDigest: prepared.requestDigest, pack: request.pack, quantity: request.quantity, turbo: request.turbo, wallet: request.wallet, prizeWallet: 'fixture-destination-purchase', memo: request.memo, nonce: 'collector-generate-nonce', attempt: 1, expiry: '2030-01-01T00:00:00.000Z', fixtureApprovalDigest: '', fixtureApprovalSignature: '' };
  authorization.fixtureApprovalDigest = digest({ domain: 'hookemon.fixture-collector-mutation-authorization.v1', fixtureOwner: 'fixture-owner', payload: { schema: authorization.schema, fixtureOwner: authorization.fixtureOwner, cycleId, action: authorization.action, requestDigest: authorization.requestDigest, pack: authorization.pack, quantity: authorization.quantity, turbo: authorization.turbo, wallet: authorization.wallet, prizeWallet: authorization.prizeWallet, memo: authorization.memo, nonce: authorization.nonce, attempt: authorization.attempt, expiry: authorization.expiry } });
  authorization.fixtureApprovalSignature = signFixtureCollectorMutationAuthorization(authorization);
  assert.throws(
    () => runner.consumeCollectorMutationAuthorization({ request, binding: { ...binding, pack: 'collector-crypt' }, authorization }),
    /binding/i,
  );
  assert.equal(runner.consumeCollectorMutationAuthorization({ request, binding, authorization }), authorization.fixtureApprovalDigest);
  assert.throws(() => runner.consumeCollectorMutationAuthorization({ request, binding, authorization }), /already consumed/i);
});

test('rejects expired Collector mutation authorization before durable consumption', () => {
  const runner = preparedRunner();
  const request = collectorRequest('generate');
  runner.prepareCollectorGenerateIntent(request);
  const before = runner.cycleStoreSnapshot;
  const expired = collectorAuthorization(request, 'generate', { expiry: '2028-12-31T23:59:59.999Z' });
  assert.throws(
    () => runner.consumeCollectorMutationAuthorization({ request, binding, authorization: expired }),
    /expired/i,
  );
  assert.deepEqual(runner.cycleStoreSnapshot, before);
});

test('accepts only independently signed complete Collector status and bound RPC-finalized open custody', () => {
  const statusValue = { schema: 'hookemon.fixture-collector-status.v1', cycleId, wallet: binding.executionWallet, status: 'ready', prizeWallet: 'fixture-destination-purchase', pack: binding.pack, quantity: 1, turbo: false, memo: `${cycleId}:collector-status`, packTokenMint: 'fixture-pack-token-mint', fixtureVerificationDigest: '', fixtureVerificationSignature: '' };
  statusValue.fixtureVerificationDigest = fixtureCollectorStatusDigest(statusValue);
  statusValue.fixtureVerificationSignature = signFixtureCollectorStatus(statusValue);
  assert.equal(assertVerifiedFixtureCollectorStatus(statusValue).packTokenMint, 'fixture-pack-token-mint');

  const open = collectorRequest('open');
  const authorization = collectorAuthorization(open, 'open');
  const execution = { schema: 'hookemon.fixture-collector-open-execution.v1', cycleId, requestDigest: authorization.requestDigest, authorizationDigest: fixtureCollectorMutationAuthorizationDigest(authorization), wallet: binding.executionWallet, prizeWallet: 'fixture-destination-purchase', packTokenMint: 'fixture-pack-token-mint', packTokenAccount: 'fixture-pack-token-account', memo: open.memo, executionDigest: '', broadcastSignature: '' };
  execution.executionDigest = fixtureCollectorOpenExecutionDigest(execution);
  execution.broadcastSignature = signFixtureCollectorOpenExecution(execution);
  assert.equal(assertVerifiedFixtureCollectorOpenExecution(execution).requestDigest, authorization.requestDigest);

  const custody = { schema: 'hookemon.fixture-collector-open-custody.v1', cycleId, requestDigest: execution.requestDigest, authorizationDigest: execution.authorizationDigest, openExecutionDigest: execution.executionDigest, wallet: binding.executionWallet, prizeWallet: 'fixture-destination-purchase', packTokenMint: 'fixture-pack-token-mint', packTokenAccount: 'fixture-pack-token-account', nftMint: 'fixture-nft-mint', nftCustodyAccount: binding.executionWallet, broadcastSignature: execution.broadcastSignature, blockHeight: '15', blockHash: 'aabb', finalized: true, prePackBalance: '1', postPackBalance: '0', preNftBalance: '0', postNftBalance: '1', fixtureVerificationDigest: '', fixtureVerificationSignature: '' };
  custody.fixtureVerificationDigest = fixtureCollectorOpenCustodyDigest(custody);
  custody.fixtureVerificationSignature = signFixtureCollectorOpenCustody(custody);
  const verifiedCustody = assertVerifiedFixtureCollectorOpenCustody(custody);
  const finality = { schema: 'hookemon.fixture-collector-rpc-finality.v1', cycleId, broadcastSignature: custody.broadcastSignature, providerCustodyDigest: digest({ domain: 'hookemon.fixture-collector-open-custody.v1', custody: verifiedCustody }), blockHeight: custody.blockHeight, blockHash: custody.blockHash, finalized: true, fixtureRpcDigest: '', fixtureRpcSignature: '' };
  finality.fixtureRpcDigest = digest({ domain: 'hookemon.fixture-collector-rpc-finality.v1', fixtureRpc: 'fixture-rpc', payload: { schema: finality.schema, cycleId, broadcastSignature: finality.broadcastSignature, providerCustodyDigest: finality.providerCustodyDigest, blockHeight: finality.blockHeight, blockHash: finality.blockHash, finalized: true } });
  finality.fixtureRpcSignature = signFixtureCollectorRpcFinality(finality);
  assert.equal(assertVerifiedFixtureCollectorRpcFinality(finality, custody).broadcastSignature, custody.broadcastSignature);
  assert.throws(() => assertVerifiedFixtureCollectorOpenCustody({ ...custody, postNftBalance: '0' }), /credit/i);
});

test('Collector status and open are durable, exact, and idempotent after recovery', () => {
  const runner = preparedRunner();
  authorizeCollectorMutation(runner, 'generate');
  runner.generateCollectorPack({ binding });
  assert.throws(() => runner.recordCollectorStatus({ cycleId, wallet: binding.executionWallet, status: 'ready', prizeWallet: 'fixture-destination-purchase' }), /signed|complete|verified/i);
  assert.throws(() => runner.openCollectorPack({ cycleId, wallet: binding.executionWallet, prizeWallet: 'fixture-destination-purchase' }), /schema|status|intent|authorization/i);
});
