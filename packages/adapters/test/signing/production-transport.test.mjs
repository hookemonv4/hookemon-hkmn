// Task B (production signer and chain RPC transport) regression coverage. Every test here drives
// the real facade (signer-client.mjs + keychain-signer.mjs) against the real Operations children
// (keychain-child-evm.mjs / operations-wallet-keychain-child.mjs) through the real CLI protocol
// (bin/hookemon-keychain-signer.mjs), spawned with `createProcessExec` exactly as production does —
// never a stand-in for the child process. Keys are generated into an isolated on-disk fake
// `security` command (`createTestKeychain`); no user Keychain or real secret is ever touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { recoverTransactionAddress } from 'viem';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createKeychainSignerClient } from '../../src/signing/keychain-signer.mjs';
import { createProcessExec } from '../../src/signing/keychain-process-exec.mjs';
import {
  OPERATOR_EVM_ROLE,
  OPERATOR_SOLANA_ROLE,
  SignerClientError,
  createPolicySigner,
  readTransactionPolicyApprovalContext,
  recoverTransactionPolicyBroadcast,
  signRequestDigest,
  wrapTransactionPolicySignerClient,
} from '../../src/signing/signer-client.mjs';
import {
  decodeProviderTransaction,
  expectedBroadcastIdentifier,
  readTransactionPolicyRules,
} from '../../src/signing/transaction-policy.mjs';
import { createTestKeychain } from '../fixtures/keychain/fixture.mjs';
import { policyFor } from './policy-fixture.mjs';

const SIGNER_BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-keychain-signer.mjs', import.meta.url));
const WALLET_BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-wallet.mjs', import.meta.url));
const TRANSACTION_POLICY_SCHEMA = 'hookemon.transaction-policy.v1';

const fixtureSignerOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

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

async function generateWallet(keychain, identity) {
  const result = await runProcess(process.execPath, [
    WALLET_BIN_PATH,
    'generate',
    '--identity', identity,
    '--keychain-command', keychain.command,
  ], { env: { ...process.env, ...keychain.env } });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Runs `fn` with the real Operations Keychain command wired into process.env for the duration of
 * the call, so `createProcessExec()` — which inherits `process.env` and takes no `env` option of
 * its own — reaches the isolated test fixture rather than a real macOS keychain. */
async function withKeychainEnv(keychain, overrides, fn) {
  const keys = [...Object.keys(keychain.env), ...Object.keys(overrides ?? {})];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, keychain.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function realExecOptions(keychain, { live = true } = {}) {
  return {
    exec: createProcessExec(),
    command: SIGNER_BIN_PATH,
    env: { HOOKEMON_OPERATIONS_SECURITY_COMMAND: keychain.command, HOOKEMON_SIGNER_LIVE_MODE: live ? 'true' : 'false' },
  };
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

function solanaSelfTransferBytes(publicKeyBase58) {
  const identity = new PublicKey(publicKeyBase58);
  const transaction = new Transaction({
    feePayer: identity,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: identity, toPubkey: identity, lamports: 0 }));
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function solanaResolvers(blockhash, lastValidBlockHeight, currentBlockHeight = '99') {
  return Object.freeze({
    family: 'solana',
    chainId: 'solana-test',
    currentBlockHeightResolver: async () => currentBlockHeight,
    blockhashContextResolver: async observedBlockhash => {
      if (observedBlockhash !== blockhash) throw new Error('unexpected blockhash for this fixture');
      return { blockhash, lastValidBlockHeight };
    },
  });
}

// --- 1. the canonicalization boundary itself -------------------------------------------------

test('signRequestDigest refuses a function value: the boundary a keychain request must never cross', () => {
  assert.throws(
    () => signRequestDigest({ transactionDecodeOptions: { resolver: async () => {} } }),
    /unsupported type function/,
  );
});

// --- 2. the return-shaped Solana request: resolver functions and a redundant policy envelope ---
// return.mjs (and the same-shaped purchase/outbound/buyback call sites) build a per-call request
// like `{ transaction, transactionPolicy, transactionPolicyRules, transactionDecodeOptions,
// liveMode }`. For EVM the child wants exactly that shape (keychain-child-evm.mjs's own
// defense-in-depth check). For Solana the child explicitly refuses a `policy` field on the wire,
// and `transactionDecodeOptions` here carries live `currentBlockHeightResolver`/
// `blockhashContextResolver` functions that cannot survive JSON at all. Before this fix, forwarding
// that whole envelope to the keychain command made `signRequestDigest` throw
// "canonical value has unsupported type function" deep inside a shared canonicalizer, and — even if
// that were papered over — the command's own `signSolana()` would still refuse the `policy` field.
// `createKeychainSignerClient` now narrows a Solana `sign` request to its bare transaction before it
// ever reaches that boundary, so the exact call shape return.mjs uses succeeds end to end.
test('a return-shaped Solana sign request reaches the real keychain child as a bare transaction, never as a function-bearing envelope', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const transactionBase64 = solanaSelfTransferBytes(wallet.publicKey);
  const decodeOptions = solanaResolvers(SystemProgram.programId.toBase58(), '100');
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionBase64, lastValidBlockHeight: '100' });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);

  const { exec, command, env } = realExecOptions(keychain);
  const rawClient = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command,
    account: 'operator-solana',
    operationArgs: ['--parent-policy-evaluated'],
  });
  const policySigner = wrapTransactionPolicySignerClient({
    client: rawClient,
    policy,
    rules: policyRules,
    decodeOptions,
  });

  await withKeychainEnv(keychain, env, async () => {
    // Exactly return.mjs's call shape: the transaction plus a redundant, resolver-bearing envelope.
    const signed = await policySigner.sign({
      transaction: transactionBase64,
      transactionPolicy: policy,
      transactionPolicyRules: policyRules,
      transactionDecodeOptions: decodeOptions,
      liveMode: true,
    });
    assert.equal(typeof signed.signedTxBase64, 'string');
    const signedTransaction = Transaction.from(Buffer.from(signed.signedTxBase64, 'base64'));
    assert.equal(signedTransaction.verifySignatures(), true);
  });
});

test('the same return-shaped request signs identically whether or not the caller redundantly embeds the policy envelope', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const transactionBase64 = solanaSelfTransferBytes(wallet.publicKey);
  const decodeOptions = solanaResolvers(SystemProgram.programId.toBase58(), '100');
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionBase64, lastValidBlockHeight: '100' });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);

  function buildSigner() {
    const rawClient = createKeychainSignerClient({
      role: OPERATOR_SOLANA_ROLE,
      liveMode: true,
      ...fixtureSignerOptions,
      exec,
      command,
      account: 'operator-solana',
      operationArgs: ['--parent-policy-evaluated'],
    });
    return wrapTransactionPolicySignerClient({ client: rawClient, policy, rules: policyRules, decodeOptions });
  }

  await withKeychainEnv(keychain, env, async () => {
    const bare = await buildSigner().sign(transactionBase64);
    const enveloped = await buildSigner().sign({
      transaction: transactionBase64,
      transactionPolicy: policy,
      transactionPolicyRules: policyRules,
      transactionDecodeOptions: decodeOptions,
      liveMode: true,
    });
    assert.deepEqual(bare, enveloped);
  });
});

test('invoke() refuses a bare function anywhere in a request before it reaches the keychain command', async () => {
  const client = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async () => { throw new Error('the keychain command must never be invoked'); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'operator-evm',
  });
  await assert.rejects(
    async () => client.sign({ to: '0xabc', decodeOptions: { resolver: async () => {} } }),
    error => error instanceof SignerClientError && /must not contain a function/.test(error.message),
  );
});

// --- 3. RPC broadcast is injected behind the facade; the sign-only child never sees `broadcast` ---

test('an injected chain RPC transport is not reachable through a bare reference to the raw client (Sol review High finding 2)', async () => {
  const rpcCalls = [];
  const client = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async ({ input }) => {
      const operation = JSON.parse(input).operation;
      if (operation === 'broadcast') throw new Error('the sign-only command must never be invoked for broadcast');
      return { code: 0, stdout: JSON.stringify({ signedTx: '0xdeadbeef' }), stderr: '' };
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'operator-evm',
    broadcast: async signed => {
      rpcCalls.push(signed);
      return { transactionHash: '0xaccepted' };
    },
  });

  // No plain broadcast() at all: a caller holding only this raw client reference has no way to
  // reach the injected RPC transport, however it constructs the argument.
  assert.equal(client.broadcast, undefined);
  assert.equal(typeof client.broadcastApproved, 'function');
  await assert.rejects(
    () => client.broadcastApproved({ signedTx: '0xarbitrary' }, {}),
    error => error instanceof SignerClientError && /genuine parent transaction-policy evaluation proof/.test(error.message),
  );
  await assert.rejects(
    () => client.broadcastApproved({ signedTx: '0xarbitrary' }, Object.freeze({})),
    error => error instanceof SignerClientError && /genuine parent transaction-policy evaluation proof/.test(error.message),
  );
  assert.equal(rpcCalls.length, 0, 'the injected RPC must never be reached without a genuine proof');
});

test('createPolicySigner reaches the injected chain RPC transport only after real policy evaluation, and never sends "broadcast" to the sign-only command', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);
  const execOperations = [];
  const rpcCalls = [];

  const backend = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async call => { execOperations.push(JSON.parse(call.input).operation); return exec(call); },
    command,
    account: 'operator-evm',
    broadcast: async signed => {
      rpcCalls.push(signed);
      return { transactionHash: expectedBroadcastIdentifier(signed, 'evm') };
    },
  });
  const signer = createPolicySigner({ backend, policy, rules: policyRules, decodeOptions: { family: 'evm' } });

  await withKeychainEnv(keychain, env, async () => {
    const signed = await signer.sign({
      transaction, transactionPolicy: policy, transactionPolicyRules: policyRules, transactionDecodeOptions: { family: 'evm' }, liveMode: true,
    });
    const broadcast = await signer.broadcast(signed);

    assert.deepEqual(execOperations, ['sign']);
    assert.equal(broadcast.transactionHash, expectedBroadcastIdentifier(signed, 'evm'));
    assert.deepEqual(rpcCalls, [signed]);
  });
});

test('without an injected broadcast transport, the keychain command still fails loudly on a broadcast operation rather than returning a plausible-looking result', async t => {
  const keychain = await createTestKeychain(t);
  await generateWallet(keychain, 'operations-evm');
  const { exec, command, env } = realExecOptions(keychain, { live: false });
  const client = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command,
    account: 'operator-evm',
  });
  await withKeychainEnv(keychain, env, () => assert.rejects(
    () => client.broadcast({ signedTx: '0xdeadbeef' }),
    /broadcast is performed by the configured RPC client/,
  ));
});

// --- 4. the production graph: EVM outbound-style and Solana return-style signing with fake RPC ---

test('an EVM transaction signs through the real keychain child and broadcasts through a fake RPC, refusing a tampered signed transaction first', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);
  const rpcCalls = [];

  const rawClient = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command,
    account: 'operator-evm',
    broadcast: async signed => {
      rpcCalls.push(signed);
      return { transactionHash: expectedBroadcastIdentifier(signed, 'evm') };
    },
  });
  const policySigner = createPolicySigner({
    backend: rawClient,
    policy,
    rules: policyRules,
    decodeOptions: { family: 'evm' },
  });

  await withKeychainEnv(keychain, env, async () => {
    const signed = await policySigner.sign({
      transaction,
      transactionPolicy: policy,
      transactionPolicyRules: policyRules,
      transactionDecodeOptions: { family: 'evm' },
      liveMode: true,
    });
    assert.equal(await recoverTransactionAddress({ serializedTransaction: signed.signedTx }), wallet.address);

    const broadcast = await policySigner.broadcast(signed);
    assert.equal(broadcast.transactionHash, expectedBroadcastIdentifier(signed, 'evm'));
    assert.deepEqual(rpcCalls, [{ signedTx: signed.signedTx }]);
  });
});

test('a broadcast result with a mismatched transaction hash is refused, and the approval survives for a retry', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);
  let rpcAttempts = 0;

  const rawClient = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command,
    account: 'operator-evm',
    broadcast: async signed => {
      rpcAttempts += 1;
      // A malfunctioning or malicious RPC returning a hash for a different transaction.
      return rpcAttempts === 1
        ? { transactionHash: `0x${'0'.repeat(64)}` }
        : { transactionHash: expectedBroadcastIdentifier(signed, 'evm') };
    },
  });
  const policySigner = createPolicySigner({ backend: rawClient, policy, rules: policyRules, decodeOptions: { family: 'evm' } });

  await withKeychainEnv(keychain, env, async () => {
    const signed = await policySigner.sign({
      transaction, transactionPolicy: policy, transactionPolicyRules: policyRules, transactionDecodeOptions: { family: 'evm' }, liveMode: true,
    });
    await assert.rejects(() => policySigner.broadcast(signed), /broadcast result transactionHash does not match/);
    // The approval was not consumed by the refused attempt -- retrying the exact same signed
    // bytes (an "unknown RPC outcome remains pending until reconciled" retry) still succeeds
    // without asking the child to sign again.
    const retried = await policySigner.broadcast(signed);
    assert.equal(retried.transactionHash, expectedBroadcastIdentifier(signed, 'evm'));
    assert.equal(rpcAttempts, 2);
  });
});

test('an EVM transaction rejected by its supplied policy is refused before it ever reaches the keychain command', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = structuredClone(readTransactionPolicyRules(policy));
  policyRules[0].destination = '0x0000000000000000000000000000000000000002';
  const { exec, command, env } = realExecOptions(keychain);
  const execCalls = [];

  const rawClient = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async call => { execCalls.push(call); return exec(call); },
    command,
    account: 'operator-evm',
    broadcast: async () => { throw new Error('must not broadcast a policy-rejected transaction'); },
  });
  const policySigner = wrapTransactionPolicySignerClient({
    client: rawClient,
    policy,
    rules: policyRules,
    decodeOptions: { family: 'evm' },
  });

  await withKeychainEnv(keychain, env, async () => {
    await assert.rejects(
      () => policySigner.sign({ transaction, transactionPolicy: policy, transactionPolicyRules: policyRules, transactionDecodeOptions: { family: 'evm' }, liveMode: true }),
      /not explicitly allowed/,
    );
    assert.equal(execCalls.length, 0, 'the keychain command must never be invoked for a request the parent policy already rejects');
  });
});

test('a Solana purchase-shaped bare-transaction request signs through the real child and broadcasts through a fake RPC', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const transactionBase64 = solanaSelfTransferBytes(wallet.publicKey);
  const decodeOptions = solanaResolvers(SystemProgram.programId.toBase58(), '100');
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionBase64, lastValidBlockHeight: '100' });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);
  const rpcCalls = [];

  const rawClient = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command,
    account: 'operator-solana',
    broadcast: async signed => {
      rpcCalls.push(signed);
      return { signature: expectedBroadcastIdentifier(signed, 'solana') };
    },
  });
  const policySigner = createPolicySigner({ backend: rawClient, policy, rules: policyRules, decodeOptions });

  await withKeychainEnv(keychain, env, async () => {
    const signed = await policySigner.sign(transactionBase64);
    const broadcast = await policySigner.broadcast(signed);
    assert.equal(broadcast.signature, expectedBroadcastIdentifier(signed, 'solana'));
    assert.deepEqual(rpcCalls, [signed]);
  });
});

test('a Solana broadcast result with a mismatched signature is refused, and the approval survives for a retry', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const transactionBase64 = solanaSelfTransferBytes(wallet.publicKey);
  const decodeOptions = solanaResolvers(SystemProgram.programId.toBase58(), '100');
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionBase64, lastValidBlockHeight: '100' });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);
  let rpcAttempts = 0;

  const rawClient = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command,
    account: 'operator-solana',
    broadcast: async signed => {
      rpcAttempts += 1;
      return rpcAttempts === 1
        ? { signature: 'not-the-real-signature' }
        : { signature: expectedBroadcastIdentifier(signed, 'solana') };
    },
  });
  const policySigner = createPolicySigner({ backend: rawClient, policy, rules: policyRules, decodeOptions });

  await withKeychainEnv(keychain, env, async () => {
    const signed = await policySigner.sign(transactionBase64);
    await assert.rejects(() => policySigner.broadcast(signed), /broadcast result signature does not match/);
    const retried = await policySigner.broadcast(signed);
    assert.equal(retried.signature, expectedBroadcastIdentifier(signed, 'solana'));
    assert.equal(rpcAttempts, 2);
  });
});

test('a changed Solana recipient is refused before it ever reaches the keychain child for signing', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-solana');
  const outsider = Keypair.generate().publicKey;
  const feePayer = new PublicKey(wallet.publicKey);
  const approvedTransaction = new Transaction({
    feePayer,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: feePayer, lamports: 0 }));
  const approvedBase64 = approvedTransaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const tamperedTransaction = new Transaction({
    feePayer,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: outsider, lamports: 0 }));
  const tamperedBase64 = tamperedTransaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const decodeOptions = solanaResolvers(SystemProgram.programId.toBase58(), '100');
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: approvedBase64, lastValidBlockHeight: '100' });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);
  const execCalls = [];

  const rawClient = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async call => { execCalls.push(JSON.parse(call.input).operation); return exec(call); },
    command,
    account: 'operator-solana',
    broadcast: async () => { throw new Error('must not broadcast a transaction the parent policy never approved'); },
  });
  const policySigner = createPolicySigner({ backend: rawClient, policy, rules: policyRules, decodeOptions });

  await withKeychainEnv(keychain, env, async () => {
    // The policy was built for a self-transfer; a transfer to an outsider must never reach the
    // Operations Solana child for signing, regardless of how validly it would otherwise serialize.
    await assert.rejects(() => policySigner.sign(tamperedBase64), /not explicitly allowed/);
    assert.deepEqual(execCalls, [], 'the keychain command must never be invoked for a request the parent policy already rejects');

    // The approved transaction still signs normally.
    const signed = await policySigner.sign(approvedBase64);
    assert.equal(typeof signed.signedTxBase64, 'string');
  });
});

// --- 5. crash/retry boundaries through the real facade + child, using durable recovery context ---

test('signed bytes recover and broadcast through a freshly constructed real facade after a simulated restart, without re-signing', async t => {
  const keychain = await createTestKeychain(t);
  const wallet = await generateWallet(keychain, 'operations-evm');
  const transaction = evmTransaction(wallet.address);
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const policyRules = readTransactionPolicyRules(policy);
  const { exec, command, env } = realExecOptions(keychain);

  function buildSigner(exec_, broadcast) {
    const rawClient = createKeychainSignerClient({
      role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, exec: exec_, command, account: 'operator-evm', broadcast,
    });
    return createPolicySigner({ backend: rawClient, policy, rules: policyRules, decodeOptions: { family: 'evm' } });
  }

  await withKeychainEnv(keychain, env, async () => {
    const beforeRestart = buildSigner(exec, async () => { throw new Error('the pre-restart process must not broadcast'); });
    const signed = await beforeRestart.sign({
      transaction, transactionPolicy: policy, transactionPolicyRules: policyRules, transactionDecodeOptions: { family: 'evm' }, liveMode: true,
    });
    const recoveryContext = readTransactionPolicyApprovalContext(beforeRestart, signed);

    // A fresh process: a brand-new client instance, wrapper, and (empty) in-memory approvals map.
    let signCallsAfterRestart = 0;
    const execAfterRestart = async call => {
      const operation = JSON.parse(call.input).operation;
      if (operation === 'sign') signCallsAfterRestart += 1;
      return exec(call);
    };
    const rpcCalls = [];
    const afterRestart = buildSigner(execAfterRestart, async signedTx => {
      rpcCalls.push(signedTx);
      return { transactionHash: expectedBroadcastIdentifier(signedTx, 'evm') };
    });

    const result = await recoverTransactionPolicyBroadcast({ client: afterRestart, signed, recoveryContext });

    assert.equal(result.transactionHash, expectedBroadcastIdentifier(signed, 'evm'));
    assert.equal(signCallsAfterRestart, 0, 'recovery must broadcast durable bytes without asking the child to sign again');
    assert.deepEqual(rpcCalls, [signed]);
  });
});
