import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';

import {
  TRANSACTION_POLICY_SCHEMA,
  decodeProviderTransaction,
} from '../src/signing/transaction-policy.mjs';
import { policyFor } from './signing/policy-fixture.mjs';
import { createSignerClient } from '../rehearsal/macos-keychain-solana-signer.mjs';

const SOLANA_OPTIONS = Object.freeze({
  family: 'solana',
  chainId: 'solana-rehearsal',
  lastValidBlockHeight: '100',
  currentBlockHeight: '99',
  blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
  currentBlockHeightResolver: async () => '99',
});

function unsignedTransfer(keypair, destination = SystemProgram.programId) {
  return new Transaction({
    feePayer: keypair.publicKey,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: destination,
    lamports: 1,
  })).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function signTransfer(transactionBase64, keypair) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
  transaction.partialSign(keypair);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function transactionPolicy(transactionBase64) {
  const decoded = await decodeProviderTransaction({ ...SOLANA_OPTIONS, transaction: transactionBase64 });
  return policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
}

test('rehearsal signer refuses the retired child-process credential path', () => {
  const expectedAccount = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () => createSignerClient({ expectedAccount, readSecret: () => 'not-allowed' }),
    /does not accept readSecret/,
  );
  assert.throws(
    () => createSignerClient({ expectedAccount, runSigningChild: async () => ({}) }),
    /requires an external secret-free signer/,
  );
});

test('rehearsal signer requires a policy before reaching the external signer', async () => {
  const keypair = Keypair.generate();
  const calls = [];
  const signer = createSignerClient({
    expectedAccount: keypair.publicKey.toBase58(),
    externalSigner: async request => { calls.push(request); return { signedTxBase64: 'unused' }; },
  });
  await assert.rejects(signer.solana.sign(unsignedTransfer(keypair)), /requires an explicit transaction policy/);
  assert.equal(calls.length, 0);
});

test('rehearsal signer requires fresh Solana context before reaching the external signer', async () => {
  const keypair = Keypair.generate();
  const transactionBase64 = unsignedTransfer(keypair);
  const policy = await transactionPolicy(transactionBase64);
  const calls = [];
  const signer = createSignerClient({
    expectedAccount: keypair.publicKey.toBase58(),
    transactionPolicy: policy,
    transactionDecodeOptions: { ...SOLANA_OPTIONS, currentBlockHeightResolver: undefined },
    externalSigner: async request => {
      calls.push(request);
      return { signedTxBase64: signTransfer(request.transactionBase64, keypair) };
    },
  });

  await assert.rejects(signer.solana.sign(transactionBase64), /requires a currentBlockHeightResolver/);
  assert.equal(calls.length, 0);
});

test('rehearsal signer sends only public request data to an external signer and revalidates its bytes', async () => {
  const keypair = Keypair.generate();
  const transactionBase64 = unsignedTransfer(keypair);
  const policy = await transactionPolicy(transactionBase64);
  const calls = [];
  const signer = createSignerClient({
    expectedAccount: keypair.publicKey.toBase58(),
    transactionPolicy: policy,
    transactionDecodeOptions: SOLANA_OPTIONS,
    externalSigner: async request => {
      calls.push(request);
      if (request.operation === 'probe') return { ready: true };
      return { signedTxBase64: signTransfer(request.transactionBase64, keypair) };
    },
  });

  assert.deepEqual(await signer.solana.probe(), { ready: true });
  const signed = await signer.solana.sign(transactionBase64);
  assert.equal(typeof signed.signedTxBase64, 'string');
  assert.equal(calls[1].operation, 'sign');
  assert.equal(calls[1].expectedAccount, keypair.publicKey.toBase58());
  assert.equal(Object.hasOwn(calls[1], 'credential'), false);
  assert.throws(() => signer.solana.broadcast(), /does not broadcast/);
});

test('rehearsal signer refuses an external signer response that changes the approved message', async () => {
  const keypair = Keypair.generate();
  const transactionBase64 = unsignedTransfer(keypair);
  const policy = await transactionPolicy(transactionBase64);
  const changed = signTransfer(unsignedTransfer(keypair, Keypair.generate().publicKey), keypair);
  const signer = createSignerClient({
    expectedAccount: keypair.publicKey.toBase58(),
    transactionPolicy: policy,
    transactionDecodeOptions: SOLANA_OPTIONS,
    externalSigner: async () => ({ signedTxBase64: changed }),
  });

  await assert.rejects(signer.solana.sign(transactionBase64), /differs from its approved semantic description/);
});
