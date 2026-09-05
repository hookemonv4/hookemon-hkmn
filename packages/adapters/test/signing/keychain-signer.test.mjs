import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createKeychainSignerClient } from '../../src/signing/keychain-signer.mjs';
import { SignerClientError } from '../../src/signing/signer-client.mjs';
import {
  decodeProviderTransaction,
  readTransactionPolicyRules,
  TRANSACTION_POLICY_SCHEMA,
} from '../../src/signing/transaction-policy.mjs';
import { registerSignerClientConformanceSuite } from './conformance.mjs';
import { policyFor } from './policy-fixture.mjs';

const fixtureSignerOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function fakeExec(calls, { code = 0, response = { signedBytes: 'AAAA', transactionId: 'tx-1' }, stderr = '' } = {}) {
  return async ({ command, args, input }) => {
    const parsed = JSON.parse(input);
    calls.push({ method: parsed.operation, digest: parsed.digest, command, args });
    return { code, stdout: JSON.stringify(response), stderr };
  };
}

async function build(role, liveMode) {
  const calls = [];
  const client = createKeychainSignerClient({
    role,
    liveMode,
    ...fixtureSignerOptions,
    exec: fakeExec(calls),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  return { client, calls: () => calls };
}

registerSignerClientConformanceSuite(test, { name: 'keychain-signer', build });

test('keychain-signer requires an injected exec function and never spawns a process itself', () => {
  assert.throws(
    () => createKeychainSignerClient({ role: 'operator-evm', liveMode: true, exec: undefined, command: '/bin/x', account: 'a' }),
    /injected exec/,
  );
});

test('keychain-signer never imports node:child_process or node:fs (source-level check)', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../src/signing/keychain-signer.mjs', import.meta.url), 'utf8'));
  const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line));
  assert.equal(importLines.some(line => line.includes("'node:child_process'")), false);
  assert.equal(importLines.some(line => line.includes("'node:fs'")), false);
});

test('keychain-signer requires a command and an account identifier', () => {
  assert.throws(
    () => createKeychainSignerClient({ role: 'operator-evm', liveMode: true, exec: async () => ({}), command: '', account: 'a' }),
    /command/,
  );
  assert.throws(
    () => createKeychainSignerClient({ role: 'operator-evm', liveMode: true, exec: async () => ({}), command: '/bin/x', account: '' }),
    /account identifier/,
  );
});

test('keychain-signer surfaces a nonzero exit code as a clear error, never a partial success', async () => {
  const calls = [];
  const client = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: fakeExec(calls, { code: 1, stderr: 'keychain locked' }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(() => client.sign({ example: 1 }), /exited with code 1/);
});

test('keychain-signer preserves the OS error text when the keychain denies interaction', async () => {
  const client = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: fakeExec([], { code: 1, stderr: 'User interaction is not allowed' }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(() => client.sign({ example: 1 }), /User interaction is not allowed/);
});

test('keychain-signer redacts credential-shaped executor errors and stderr', async () => {
  const credential = `0x${'a'.repeat(64)}`;
  const thrown = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async () => { throw new Error(`credential=${credential}`); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(
    () => thrown.sign({ example: 1 }),
    error => error instanceof SignerClientError && !error.message.includes(credential) && /\[redacted\]/i.test(error.message),
  );

  const stderr = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: fakeExec([], { code: 1, stderr: `seed=${credential}` }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(
    () => stderr.sign({ example: 1 }),
    error => error instanceof SignerClientError && !error.message.includes(credential) && /\[redacted\]/i.test(error.message),
  );

  const mnemonic = 'albatross beacon canary daylight ember furnace glacier harbor indigo jasmine kettle lantern';
  const mnemonicError = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async () => { throw new Error(`mnemonic=${mnemonic}`); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(
    () => mnemonicError.sign({ example: 1 }),
    error => error instanceof SignerClientError && !error.message.includes('beacon') && /\[redacted\]/i.test(error.message),
  );

  const rawHex = 'abcdef0123456789'.repeat(4);
  const truncatedRawHex = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async () => { throw new Error(`${'x'.repeat(480)}${rawHex}`); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(
    () => truncatedRawHex.sign({ example: 1 }),
    error => error instanceof SignerClientError && !error.message.includes(rawHex.slice(0, 16)) && /\[redacted\]/i.test(error.message),
  );
});

test('keychain-signer aborts a command that exceeds its configured timeout', async () => {
  let received;
  const client = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    timeoutMs: 5,
    exec: async call => {
      received = call;
      return new Promise(() => {});
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(() => client.sign({ example: 1 }), /timed out after 5ms/);
  assert.equal(received.timeoutMs, 5);
  assert.equal(received.signal.aborted, true);
});

test('keychain-signer reports a timeout when an abort-aware executor rejects its signal', async () => {
  const client = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    timeoutMs: 5,
    exec: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('executor saw abort')));
    }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(() => client.sign({ example: 1 }), /timed out after 5ms/);
});

test('keychain-signer exposes a sign-only readiness probe without broadcasting', async () => {
  const calls = [];
  const client = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: false,
    exec: async ({ args, input }) => {
      calls.push({ args, request: JSON.parse(input) });
      return { code: 0, stdout: JSON.stringify({ ready: true }), stderr: '' };
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  assert.deepEqual(await client.probe(), { ready: true });
  assert.deepEqual(calls[0].args, ['probe', '--role', 'operator-solana', '--account', 'hookemon-operator-primary']);
  assert.equal(calls[0].request.operation, 'probe');
  assert.equal(calls[0].request.request.data.kind, 'hookemon-keychain-sign-only-readiness.v1');
});

test('keychain-signer returns a fixed readiness result and does not pass backend fields through', async () => {
  const client = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: false,
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({ ready: true, privateKey: 'must-not-leave-the-backend' }),
      stderr: '',
    }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  assert.deepEqual(await client.probe(), { ready: true });
});

function canonicalWirePolicy() {
  return {
    schema: 'hookemon.transaction-policy.v1',
    chainId: '4663',
    stage: 'payout',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    expectedRecipient: '0x4444444444444444444444444444444444444444',
    amount: {
      chainId: '4663',
      assetId: 'native',
      decimals: 18,
      amountAtomic: '0',
    },
    allowedTargets: ['0x4444444444444444444444444444444444444444'],
    allowedPrograms: [],
  };
}

function policyRequest() {
  return {
    to: '0x4444444444444444444444444444444444444444',
    data: '0x',
    value: '0',
    chainId: '4663',
    from: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  };
}

test('keychain-signer recognizes the independent canonical v1 envelope before adapter rules', async () => {
  const calls = [];
  assert.throws(
    () => createKeychainSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      exec: fakeExec(calls),
      command: '/opt/hookemon/bin/hookemon-keychain-sign',
      account: 'hookemon-operator-primary',
      transactionPolicy: canonicalWirePolicy(),
      transactionPolicyRules: [],
      transactionDecodeOptions: { family: 'evm' },
    }),
    /at least one explicit rule/,
  );
  assert.equal(calls.length, 0);
});

test('keychain-signer evaluates separately serialized adapter rules before invoking the command', async () => {
  const calls = [];
  const request = policyRequest();
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction: request });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const wirePolicy = JSON.parse(JSON.stringify(policy));
  const wireRules = structuredClone(readTransactionPolicyRules(policy));
  assert.equal(Object.hasOwn(wirePolicy, 'rules'), false);
  const client = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: fakeExec(calls, { response: { signedTx: '0xdead' } }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
    transactionPolicy: wirePolicy,
    transactionPolicyRules: wireRules,
    transactionDecodeOptions: { family: 'evm' },
  });

  assert.deepEqual(await client.sign(request), { signedTx: '0xdead' });
  assert.equal(calls.length, 1);
});

test('keychain-signer surfaces non-JSON stdout as a clear error', async () => {
  const client = createKeychainSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async () => ({ code: 0, stdout: 'not json', stderr: '' }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await assert.rejects(() => client.sign({ example: 1 }), /non-JSON stdout/);
});

test('keychain-signer forwards the account/role/operation into the invocation, never a raw key', async () => {
  const calls = [];
  const exec = async ({ command, args, input }) => {
    const parsed = JSON.parse(input);
    calls.push(parsed);
    assert.equal(command, '/opt/hookemon/bin/hookemon-keychain-sign');
    assert.deepEqual(args, ['sign', '--role', 'operator-solana', '--account', 'hookemon-operator-primary']);
    return { code: 0, stdout: JSON.stringify({ signedBytes: 'AAAA' }), stderr: '' };
  };
  const client = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  await client.sign({ nested: { a: 1 } });
  assert.equal(calls[0].role, 'operator-solana');
  assert.equal(calls[0].account, 'hookemon-operator-primary');
  assert.equal(calls[0].operation, 'sign');
  assert.match(calls[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls[0].request.encoding, 'json');
  assert.deepEqual(calls[0].request.data, { nested: { a: 1 } });
});

test('keychain-signer transports a Buffer request as base64, not as a raw byte-array JSON blob', async () => {
  let sentRequest;
  const exec = async ({ input }) => {
    sentRequest = JSON.parse(input).request;
    return { code: 0, stdout: JSON.stringify({ signature: 'ZmFrZQ==' }), stderr: '' };
  };
  const client = createKeychainSignerClient({
    role: 'verifier',
    liveMode: true,
    ...fixtureSignerOptions,
    exec,
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-verifier',
  });
  await client.sign(Buffer.from('a-digest-buffer'));
  assert.equal(sentRequest.encoding, 'base64');
  assert.equal(Buffer.from(sentRequest.data, 'base64').toString('utf8'), 'a-digest-buffer');
});
