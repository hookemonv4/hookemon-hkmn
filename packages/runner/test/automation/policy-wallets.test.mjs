import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  EvmPolicyWallet,
  SolanaPolicyWallet,
  walletAuthorizationDigest,
  walletIntentDigest,
} from '../../src/automation/policy-wallets.mjs';
import { createTestProfileMutationAuthority } from '../../src/cycle/preflight.mjs';

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const policyDigest = 'sha256:' + '1'.repeat(64);
const transactionBytes = Buffer.from('bound transaction').toString('base64');
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

const evmPolicy = () => ({
  policyDigest,
  chain: 'eip155:4663',
  allowedDestinations: ['0x000000000000000000000000000000000000beef'],
  allowedFunctions: ['0x12345678'],
  allowedAssets: ['USDG'],
  maxAmount: '55000000',
});

const intent = (overrides = {}) => ({
  idempotencyKey: 'cycle-1:outbound',
  policyDigest,
  chain: 'eip155:4663',
  destination: '0x000000000000000000000000000000000000beef',
  functionOrProgram: '0x12345678',
  asset: 'USDG',
  amount: '50000000',
  cap: '55000000',
  unsignedTransaction: transactionBytes,
  payloadDigest: sha256(Buffer.from(transactionBytes, 'base64')),
  ...overrides,
});

function clients() {
  const submissions = new Map();
  const checkpoints = new Map();
  return {
    checkpointStore: {
      async read(key) { return checkpoints.get(key) ?? null; },
      async write(key, value) { checkpoints.set(key, structuredClone(value)); return structuredClone(value); },
    },
    signedBytesVerifier: ({ intent: verifiedIntent }) => ({
      transactionId: '0xtx1',
      chain: verifiedIntent.chain,
      destination: verifiedIntent.destination,
      functionOrProgram: verifiedIntent.functionOrProgram,
      asset: verifiedIntent.asset,
      amount: verifiedIntent.amount,
    }),
    signerClient: {
      async sign(request) {
        const result = { signedBytes: transactionBytes, authorizationDigest: request.authorizationDigest };
        submissions.set(request.idempotencyKey, { result, request });
        return result;
      },
      async broadcast(request) {
        return { transactionId: request.transactionId };
      },
    },
    observerClient: {
      async reconcile(request) {
        const submission = submissions.get(request.idempotencyKey);
        return submission && {
          intentDigest: request.intentDigest,
          signedBytesDigest: request.signedBytesDigest,
          transactionId: request.transactionId,
          chain: submission.request.chain,
          destination: submission.request.destination,
          functionOrProgram: submission.request.functionOrProgram,
          asset: submission.request.asset,
          amount: submission.request.amount,
          status: 'SUCCESS',
          finalized: true,
          chainReceipt: { transactionId: request.transactionId, status: 'SUCCESS', finalized: true },
          credit: { asset: submission.request.asset, destination: submission.request.destination, amount: submission.request.amount },
        };
      },
    },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  };
}

function authorizationFor(value) {
  const base = {
    intentDigest: walletIntentDigest(value),
    nonce: 'nonce-1',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return { ...base, authorizationDigest: walletAuthorizationDigest(base) };
}

test('signs and reconciles only an exact EVM policy-bound intent', async () => {
  const wallet = new EvmPolicyWallet({ policy: evmPolicy(), ...clients() });
  const action = intent();
  const authorization = authorizationFor(action);
  const submission = await wallet.signAndBroadcast(action, authorization);
  assert.equal(submission.transactionId, '0xtx1');
  assert.match(submission.intentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(submission.status, 'BROADCAST');

  const evidence = await wallet.reconcile(action, authorization);
  assert.equal(evidence.finalized, true);
  assert.equal(evidence.status, 'SUCCESS');
  assert.equal(evidence.intentDigest, submission.intentDigest);
});

test('rejects raw-key configuration and every policy mismatch before signing', async () => {
  assert.throws(
    () => new EvmPolicyWallet({ policy: evmPolicy(), ...clients(), privateKey: 'secret' }),
    /raw key/,
  );
  const wallet = new EvmPolicyWallet({ policy: evmPolicy(), ...clients() });
  for (const changed of [
    { chain: 'eip155:1' },
    { destination: '0x000000000000000000000000000000000000dead' },
    { functionOrProgram: '0xdeadbeef' },
    { asset: 'HKMN' },
    { amount: '55000001' },
    { cap: '55000001' },
    { policyDigest: 'sha256:' + '9'.repeat(64) },
  ]) {
    const action = intent(changed);
    await assert.rejects(() => wallet.signAndBroadcast(action, authorizationFor(action)), /policy|cap|amount/);
  }
});

test('rejects altered unsigned bytes and missing reconciliation evidence', async () => {
  const configured = clients();
  configured.observerClient.reconcile = async () => null;
  const wallet = new EvmPolicyWallet({ policy: evmPolicy(), ...configured });
  await assert.rejects(
    () => wallet.signAndBroadcast(intent({ unsignedTransaction: Buffer.from('altered').toString('base64') }), authorizationFor(intent())),
    /payload digest/,
  );
  await assert.rejects(() => wallet.reconcile(intent(), authorizationFor(intent())), /checkpoint/);
});

test('applies the same boundary to a Solana policy wallet', async () => {
  const policy = {
    ...evmPolicy(),
    chain: 'solana:mainnet',
    allowedDestinations: ['11111111111111111111111111111111'],
    allowedFunctions: ['buy-pack-v1'],
    allowedAssets: ['USDG'],
  };
  const wallet = new SolanaPolicyWallet({ policy, ...clients() });
  const action = intent({
    chain: policy.chain,
    destination: policy.allowedDestinations[0],
    functionOrProgram: policy.allowedFunctions[0],
    asset: 'USDG',
  });
  const submission = await wallet.signAndBroadcast(action, authorizationFor(action));
  assert.equal(submission.transactionId, '0xtx1');
});

test('checkpoints exact signed bytes before broadcast and reconciles the same finalized transaction', async () => {
  const signedBytes = Buffer.from('canonical signed transaction').toString('base64');
  const preparedIntent = intent();
  const authorization = authorizationFor(preparedIntent);
  const records = new Map();
  const calls = [];
  const wallet = new EvmPolicyWallet({
    policy: evmPolicy(),
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
    checkpointStore: {
      async read(key) { return records.get(key) ?? null; },
      async write(key, value) { records.set(key, structuredClone(value)); },
    },
    signedBytesVerifier: ({ intent: verifiedIntent }) => ({
      transactionId: '0xtx1',
      chain: verifiedIntent.chain,
      destination: verifiedIntent.destination,
      functionOrProgram: verifiedIntent.functionOrProgram,
      asset: verifiedIntent.asset,
      amount: verifiedIntent.amount,
    }),
    signerClient: {
      async sign(request) {
        calls.push('sign');
        return { signedBytes, authorizationDigest: request.authorizationDigest };
      },
      async broadcast(request) {
        calls.push('broadcast');
        return { transactionId: request.transactionId };
      },
    },
    observerClient: {
      async reconcile(request) {
        calls.push('reconcile');
        return {
          intentDigest: request.intentDigest,
          signedBytesDigest: request.signedBytesDigest,
          transactionId: request.transactionId,
          status: 'SUCCESS',
          finalized: true,
          chainReceipt: { transactionId: request.transactionId, status: 'SUCCESS', finalized: true },
          chain: preparedIntent.chain,
          destination: preparedIntent.destination,
          functionOrProgram: preparedIntent.functionOrProgram,
          asset: preparedIntent.asset,
          amount: preparedIntent.amount,
          credit: { asset: preparedIntent.asset, destination: preparedIntent.destination, amount: preparedIntent.amount },
        };
      },
    },
  });

  const signed = await wallet.sign(preparedIntent, authorization);
  assert.equal(signed.signedBytes, signedBytes);
  assert.equal(records.get(signed.intentDigest).status, 'SIGNED');
  const emptyCheckpoint = { ...records.get(signed.intentDigest), signedBytes: '', signedBytesDigest: sha256(Buffer.alloc(0)) };
  records.set(signed.intentDigest, emptyCheckpoint);
  await assert.rejects(() => wallet.broadcast(preparedIntent, authorization), /empty|invalid/i);
  records.set(signed.intentDigest, signed);
  await wallet.broadcast(preparedIntent, authorization);
  const evidence = await wallet.reconcile(preparedIntent, authorization);
  assert.equal(evidence.transactionId, '0xtx1');
  assert.deepEqual(calls, ['sign', 'broadcast', 'reconcile']);
});

test('rejects signer identity tampering and an unrelated observer transaction', async () => {
  const action = intent();
  const authorization = authorizationFor(action);
  const configured = clients();
  configured.signedBytesVerifier = ({ intent: verifiedIntent }) => ({
    transactionId: '0xtx1',
    chain: verifiedIntent.chain,
    destination: '0x000000000000000000000000000000000000dead',
    functionOrProgram: verifiedIntent.functionOrProgram,
    asset: verifiedIntent.asset,
    amount: verifiedIntent.amount,
  });
  const wallet = new EvmPolicyWallet({ policy: evmPolicy(), ...configured });
  await assert.rejects(() => wallet.sign(action, authorization), /identity.*match/);

  const valid = clients();
  const validWallet = new EvmPolicyWallet({ policy: evmPolicy(), ...valid });
  await validWallet.sign(action, authorization);
  await validWallet.broadcast(action, authorization);
  valid.observerClient.reconcile = async request => ({
    intentDigest: request.intentDigest,
    signedBytesDigest: request.signedBytesDigest,
    transactionId: '0xunrelated',
    chain: action.chain,
    destination: action.destination,
    functionOrProgram: action.functionOrProgram,
    asset: action.asset,
    amount: action.amount,
    status: 'SUCCESS',
    finalized: true,
    chainReceipt: { transactionId: '0xunrelated', status: 'SUCCESS', finalized: true },
    credit: { asset: action.asset, destination: action.destination, amount: action.amount },
  });
  await assert.rejects(() => validWallet.reconcile(action, authorization), /transaction mismatch/);
});

test('refuses provisional authority before calling a policy-wallet signer or broadcaster', async () => {
  const action = intent();
  const authorization = authorizationFor(action);
  const fixtureConfig = clients();
  const fixtureWallet = new EvmPolicyWallet({ policy: evmPolicy(), ...fixtureConfig });
  await fixtureWallet.sign(action, authorization);

  const calls = [];
  const wallet = new EvmPolicyWallet({
    policy: evmPolicy(),
    checkpointStore: fixtureConfig.checkpointStore,
    signedBytesVerifier: fixtureConfig.signedBytesVerifier,
    observerClient: fixtureConfig.observerClient,
    signerClient: {
      async sign(request) {
        calls.push('sign');
        return { signedBytes: transactionBytes, authorizationDigest: request.authorizationDigest };
      },
      async broadcast(request) {
        calls.push('broadcast');
        return { transactionId: request.transactionId };
      },
    },
  });
  const signingIntent = intent({ idempotencyKey: 'cycle-1:preflight-sign' });

  await Promise.all([
    assert.rejects(
      () => wallet.sign(signingIntent, authorizationFor(signingIntent)),
      /active frozen interface authority is invalid/,
    ),
    assert.rejects(
      () => wallet.broadcast(action, authorization),
      /active frozen interface authority is invalid/,
    ),
  ]);
  assert.deepEqual(calls, []);
});
