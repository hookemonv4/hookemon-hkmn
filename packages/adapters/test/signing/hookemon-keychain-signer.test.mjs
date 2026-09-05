import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { recoverTransactionAddress } from 'viem';

import {
  decodeProviderTransaction,
  readTransactionPolicyRules,
  revalidateSignedMessage,
  TRANSACTION_POLICY_SCHEMA,
} from '../../src/signing/transaction-policy.mjs';
import { runSolanaWalletKeychainChildProcess } from '../../src/signing/operations-wallet-keychain-child.mjs';
import { signRequestDigest } from '../../src/signing/signer-client.mjs';
import { createTestKeychain } from '../fixtures/keychain/fixture.mjs';
import { policyFor } from './policy-fixture.mjs';

const SIGNER_BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-keychain-signer.mjs', import.meta.url));
const WALLET_BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-wallet.mjs', import.meta.url));
const SERVICE = 'hookemon-operations';

async function loadSignerBinary() {
  return import('../../bin/hookemon-keychain-signer.mjs');
}

function runProcess(command, args, { env = process.env, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function signerEnvironment(keychain, overrides = {}) {
  return {
    ...process.env,
    ...keychain.env,
    HOOKEMON_OPERATIONS_SECURITY_COMMAND: keychain.command,
    ...overrides,
  };
}

function wireInput({ operation, role, account, payload, request = { encoding: 'json', data: payload } }) {
  return `${JSON.stringify({
    operation,
    role,
    account,
    digest: signRequestDigest(payload),
    request,
  })}\n`;
}

async function generateWallet(keychain, identity) {
  const result = await runProcess(process.execPath, [
    WALLET_BIN_PATH,
    'generate',
    '--identity', identity,
    '--keychain-command', keychain.command,
  ], { env: signerEnvironment(keychain) });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function invokeSigner(keychain, { operation, role, account, payload, request, env }) {
  return runProcess(SIGNER_BIN_PATH, [operation, '--role', role, '--account', account], {
    env: signerEnvironment(keychain, env),
    input: wireInput({ operation, role, account, payload, request }),
  });
}

function evmTransaction(address, chainId = 4663) {
  return {
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    value: '0',
    nonce: 0,
    gas: '21000',
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '1',
    chainId,
    from: address,
  };
}

function serializedPolicyBinding(decoded) {
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  return {
    transactionPolicy: JSON.parse(JSON.stringify(policy)),
    transactionPolicyRules: structuredClone(readTransactionPolicyRules(policy)),
  };
}

test('keychain signer binary module loads through its signing child', async () => {
  const binary = await loadSignerBinary();
  assert.equal(typeof binary.parseWireArgs, 'function');
});

test('keychain signer accepts the generic command operation, role, and account labels', async () => {
  const { parseWireArgs } = await loadSignerBinary();
  assert.deepEqual(
    parseWireArgs(['probe', '--role', 'operator-evm', '--account', 'operator-evm']),
    { operation: 'probe', role: 'operator-evm', account: 'operator-evm' },
  );
});

test('keychain signer probe returns exactly the generic ready result after an EVM sign-only check', async t => {
  const keychain = await createTestKeychain(t);
  await generateWallet(keychain, 'operations-evm');
  const result = await invokeSigner(keychain, {
    operation: 'probe',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: { kind: 'hookemon-keychain-sign-only-readiness.v1' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ready: true });
});

test('keychain signer probe returns exactly the generic ready result after a Solana sign-only check', async t => {
  const keychain = await createTestKeychain(t);
  await generateWallet(keychain, 'operations-solana');
  const result = await invokeSigner(keychain, {
    operation: 'probe',
    role: 'operator-solana',
    account: 'operator-solana',
    payload: { kind: 'hookemon-keychain-sign-only-readiness.v1' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ready: true });
});

test('keychain signer returns a recoverable EVM transaction only after child policy evaluation', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policyBinding = serializedPolicyBinding(decoded);
  assert.equal(Object.hasOwn(policyBinding.transactionPolicy, 'rules'), false);
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: {
      transaction,
      ...policyBinding,
      transactionDecodeOptions: {},
    },
    env: { HOOKEMON_SIGNER_LIVE_MODE: 'true' },
  });
  assert.equal(result.code, 0, result.stderr);
  const signed = JSON.parse(result.stdout);
  assert.match(signed.signedTx, /^0x[0-9a-f]+$/i);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: signed.signedTx }), wallet.address);
});

test('keychain signer refuses an EVM transaction rejected by its supplied policy before signing', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policyBinding = serializedPolicyBinding(decoded);
  policyBinding.transactionPolicyRules[0].destination = '0x0000000000000000000000000000000000000002';
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: { transaction, ...policyBinding, transactionDecodeOptions: {} },
    env: { HOOKEMON_SIGNER_LIVE_MODE: 'true' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not explicitly allowed/i);
});

test('keychain signer refuses an EVM transaction on the wrong default chain', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address, 1);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: { transaction, transactionPolicy: policyFor(decoded, TRANSACTION_POLICY_SCHEMA), transactionDecodeOptions: {} },
    env: { HOOKEMON_SIGNER_LIVE_MODE: 'true' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /chainId must be 4663/i);
});

test('keychain signer refuses live EVM signing without an explicit transaction policy', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: { transaction: evmTransaction(wallet.address) },
    env: { HOOKEMON_SIGNER_LIVE_MODE: 'true' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /transaction policy/i);
});

test('keychain signer refuses live Solana signing without an explicit transaction policy', async t => {
  const keychain = await createTestKeychain(t);
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-solana',
    account: 'operator-solana',
    payload: { transaction: 'AQ==' },
    env: { HOOKEMON_SIGNER_LIVE_MODE: 'true' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /transaction policy/i);
});

test('keychain signer refuses a serialized live Solana policy without trusted parent resolvers', async t => {
  const keychain = await createTestKeychain(t);
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-solana',
    account: 'operator-solana',
    payload: {
      transaction: 'AQ==',
      transactionPolicy: { schema: TRANSACTION_POLICY_SCHEMA },
      transactionDecodeOptions: { family: 'solana', chainId: 'solana-test' },
    },
    env: { HOOKEMON_SIGNER_LIVE_MODE: 'true' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /parent transaction policy evaluation with trusted chain resolvers/i);
});

test('keychain signer returns its bounded Keychain timeout to the caller', { timeout: 1_000 }, async t => {
  const keychain = await createTestKeychain(t, { mode: 'hang' });
  const result = await invokeSigner(keychain, {
    operation: 'probe',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: { kind: 'hookemon-keychain-sign-only-readiness.v1' },
    env: { HOOKEMON_KEYCHAIN_TIMEOUT_MS: '50' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /timed out after 50ms/i);
});

test('keychain signer re-encodes a binary Solana wire request before delegating to the Operations child', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const operator = new PublicKey(wallet.publicKey);
  const transaction = new Transaction({
    feePayer: operator,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({
    fromPubkey: operator,
    toPubkey: operator,
    lamports: 0,
  }));
  const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-solana',
    account: 'operator-solana',
    payload: bytes,
    request: { encoding: 'base64', data: Buffer.from(bytes).toString('base64') },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(Transaction.from(Buffer.from(JSON.parse(result.stdout).signedTxBase64, 'base64')).verifySignatures(), true);
});

test('keychain signer preserves a Solana co-signer slot through the Operations child', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const operator = new PublicKey(wallet.publicKey);
  const coSigner = Keypair.generate();
  const transaction = new Transaction({
    feePayer: operator,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: operator, isSigner: true, isWritable: false },
      { pubkey: coSigner.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([7]),
  }));
  transaction.partialSign(coSigner);
  const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-solana',
    account: 'operator-solana',
    payload: unsigned,
  });
  assert.equal(result.code, 0, result.stderr);
  const signed = Transaction.from(Buffer.from(JSON.parse(result.stdout).signedTxBase64, 'base64'));
  const coSignerIndex = signed.signatures.findIndex(entry => entry.publicKey.equals(coSigner.publicKey));
  assert.notEqual(coSignerIndex, -1);
  assert.deepEqual(signed.signatures[coSignerIndex].signature, transaction.signatures[coSignerIndex].signature);
  assert.equal(signed.verifySignatures(), true);
});

test('keychain signer preserves a v0 Solana co-signer slot through the Operations child', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const operator = new PublicKey(wallet.publicKey);
  const coSigner = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: operator,
    recentBlockhash: SystemProgram.programId.toBase58(),
    instructions: [new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: operator, isSigner: true, isWritable: false },
        { pubkey: coSigner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([7]),
    })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([coSigner]);
  const unsigned = Buffer.from(transaction.serialize()).toString('base64');
  const result = await invokeSigner(keychain, {
    operation: 'sign',
    role: 'operator-solana',
    account: 'operator-solana',
    payload: unsigned,
  });
  assert.equal(result.code, 0, result.stderr);

  const signedTxBase64 = JSON.parse(result.stdout).signedTxBase64;
  const signed = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, 'base64'));
  const coSignerIndex = signed.message.staticAccountKeys.findIndex(key => key.equals(coSigner.publicKey));
  assert.notEqual(coSignerIndex, -1);
  assert.deepEqual(signed.signatures[coSignerIndex], transaction.signatures[coSignerIndex]);
  assert.equal(signed.signatures[0].some(byte => byte !== 0), true);

  const decodeOptions = {
    family: 'solana',
    chainId: 'solana-test',
    lastValidBlockHeight: '100',
    currentBlockHeight: '99',
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
    currentBlockHeightResolver: async () => '99',
  };
  const approved = await decodeProviderTransaction({ ...decodeOptions, transaction: unsigned });
  assert.deepEqual(
    await revalidateSignedMessage({ signedTxBase64 }, approved, decodeOptions),
    approved,
  );
});

test('Operations Solana child refuses a transaction for a mismatched public identity', async t => {
  const keychain = await createTestKeychain(t);
  await generateWallet(keychain, 'operations-solana');
  const previous = Object.fromEntries(Object.keys(keychain.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, keychain.env);
  try {
    await assert.rejects(
      () => runSolanaWalletKeychainChildProcess({
        operation: 'sign',
        transactionBase64: 'AQ==',
        service: SERVICE,
        account: 'operator-solana',
        expectedAccount: Keypair.generate().publicKey.toBase58(),
        keychainCommand: keychain.command,
      }),
      /does not match the configured account/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('keychain signer returns a structured broadcast refusal', async t => {
  const keychain = await createTestKeychain(t);
  const result = await invokeSigner(keychain, {
    operation: 'broadcast',
    role: 'operator-evm',
    account: 'operator-evm',
    payload: { signedTx: '0x' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: { code: 'broadcast_not_supported', message: 'broadcast is performed by the configured RPC client' },
  });
});
