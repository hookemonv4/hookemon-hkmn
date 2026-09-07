// ADR-0025 `retry-sign-only-with-durable-binding`: focused proof for the recovery-aware
// decode/evaluate/sign facade in signer-client.mjs, exercised against a FAKE injected Keychain
// broker only (never a real keychain, credential, RPC, or broadcast). The durable repository side
// uses the real CycleRepository so the PREPARED/SIGNED chain-attempt gate is genuine, not simulated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import {
  createKeychainSignerClient,
  forwardOwnedKeychainSignOnlyIdentity,
  KeychainPreInvocationDenialError,
  KeychainSignOnlyTimeoutError,
} from '../../src/signing/keychain-signer.mjs';
import {
  OPERATOR_EVM_ROLE,
  OPERATOR_SOLANA_ROLE,
  wrapSignerClient,
  wrapTransactionPolicySignerClient,
} from '../../src/signing/signer-client.mjs';
import { decodeProviderTransaction, TRANSACTION_POLICY_SCHEMA } from '../../src/signing/transaction-policy.mjs';
import { createPreparedChainTransactionAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { policyFor } from './policy-fixture.mjs';

const fixtureSignerOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/transactions/${name}.json`, import.meta.url), 'utf8'));
}

async function evmPolicySetup() {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const decodeOptions = { family: 'evm', tokenMetadata };
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: evm.transaction });
  return {
    fixture: { transaction: evm.transaction, signedTx: evm.signedTx },
    decodeOptions,
    policy: policyFor(decoded, TRANSACTION_POLICY_SCHEMA),
  };
}

function solanaContextFixture() {
  return { chainId: 'solana-mainnet', lastValidBlockHeight: '100', currentBlockHeight: '99' };
}

async function solanaPolicySetup() {
  const context = solanaContextFixture();
  const transactionBase64 = 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWgH7SHxu7KMPO9isPXzpVaK2E9QAAx5pCymfgrNTpuf5Fb0KKWfX3IKGxzXQa72rFvgb3fBYanokEb/w8/iIKAgEDB4qI4910CfGV/VLbLTy6XXLKZwm/HZQSG/N0iAG0D29cgTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5RuehzdKbC3j9E69MVZj+/07yqXFm48pvLk+/zNgFBb8e1JKMYo0cLG6ukDOJBZlWEpWSc6XGP5NjbBRhSshzfRAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAADKk6wXBRhwcdZ7g8f/Dv6BCOjsRTBXXXcmh5Mz29q+fAbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCp/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hgDBAAFAkANAwAEAAkDAgAAAAAAAAAGBAMFAgEKDOgDAAAAAAAABg==';
  const decodeOptions = {
    family: 'solana',
    chainId: context.chainId,
    lastValidBlockHeight: context.lastValidBlockHeight,
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: context.lastValidBlockHeight }),
    currentBlockHeightResolver: async () => context.currentBlockHeight,
  };
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionBase64 });
  return {
    transactionBase64,
    decodeOptions,
    policy: policyFor(decoded, TRANSACTION_POLICY_SCHEMA),
    signedTxBase64: 'ZmFrZS1zaWduZWQtc29sYW5hLWJ5dGVz',
  };
}

async function tempRepository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-sign-only-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return CycleRepository.open(directory);
}

async function preparedRecovery({ repository, cycleId, stage, requestDigest }) {
  await repository.prepareChainTransactionAttempt(cycleId, stage, createPreparedChainTransactionAttempt({ cycleId, stage, requestDigest }));
  return { repository, cycleId, stage, requestDigest };
}

/**
 * Wraps a real repository so ordinal 2 can never be reserved through it -- simulating a process
 * that times out on ordinal 1, durably records that outcome (a real write, through the real
 * repository), and then dies before it can even attempt the in-process retry. Everything else
 * (the binding, ordinal 1's reservation and timeout) goes through the real repository unchanged,
 * so the durable state this leaves behind is exactly what a real crash would leave.
 */
function repositoryThatDiesBeforeOrdinal2(repository) {
  // CycleRepository's methods live on its class prototype, not as the instance's own enumerable
  // properties, so a plain `{...repository}` spread would silently produce an object with none of
  // them -- bind explicitly instead.
  return {
    persistSignOnlyPreSignBinding: repository.persistSignOnlyPreSignBinding.bind(repository),
    readSignOnlyPreSignBinding: repository.readSignOnlyPreSignBinding.bind(repository),
    recordSignOnlyInvocationTimeout: repository.recordSignOnlyInvocationTimeout.bind(repository),
    readSignOnlyInvocationLedger: repository.readSignOnlyInvocationLedger.bind(repository),
    async reserveSignOnlyInvocation(cycleId, stage, requestDigest, ordinal) {
      if (ordinal === 2) throw new Error('simulated process death before ordinal 2 could be reserved');
      return repository.reserveSignOnlyInvocation(cycleId, stage, requestDigest, ordinal);
    },
  };
}

function timeoutOnceThenSucceedExec(response) {
  let calls = 0;
  return {
    calls: () => calls,
    exec: async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return { code: 0, stdout: JSON.stringify(response), stderr: '' };
    },
  };
}

test('EVM: a classified sign-only timeout on an owned Keychain client retries exactly once, binder exists before the first call', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  const { calls, exec } = timeoutOnceThenSucceedExec({ signedTx: fixture.signedTx });
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    timeoutMs: 5,
    exec,
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-evm',
  });
  assert.equal(await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest), null);
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  const signed = await client.sign(fixture.transaction);
  assert.equal(signed.signedTx, fixture.signedTx);
  assert.equal(calls(), 2, 'exactly one retry after the classified timeout');

  const binding = await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest);
  assert.ok(binding, 'the pre-sign binding is durable');
  assert.equal(binding.role, OPERATOR_EVM_ROLE);
  assert.equal(binding.account, 'hookemon-operator-evm');
});

test('EVM: the durable binding captures the full signed envelope, not just the transaction, so a changed policy/rules/liveMode cannot reuse it', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'c'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  let brokerCalls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    timeoutMs: 5,
    exec: async () => {
      brokerCalls += 1;
      return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' };
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  // outbound.mjs's own `policySigner.sign()` call sends exactly this full envelope, never a bare
  // transaction string -- only the Solana Keychain transport narrows a request down to its bare
  // transaction (`solanaSignTransportPayload`); the EVM child receives this envelope unnarrowed. The
  // durable binding must hash exactly what crosses to that boundary.
  const envelope = {
    transaction: fixture.transaction,
    transactionPolicy: policy,
    transactionPolicyRules: [],
    transactionDecodeOptions: decodeOptions,
    liveMode: true,
  };
  const signed = await client.sign(envelope);
  assert.equal(signed.signedTx, fixture.signedTx);
  assert.equal(brokerCalls, 1);

  // The chain attempt is still PREPARED (nothing above recorded a signature), so a second sign()
  // for this same requestDigest is only eligible to bind if its envelope is byte-for-byte
  // identical. Changing just `transactionPolicyRules` (same transaction, same decodeOptions, same
  // liveMode) must be refused as a conflicting binding before the broker is ever reached again -- a
  // binding that hashed only `transaction` (the Solana-only narrowing this fix does not extend to
  // EVM) would have missed this.
  await assert.rejects(
    () => client.sign({ ...envelope, transactionPolicyRules: [{ id: 'different-rule' }] }),
    /request already has a different pre-sign binding/,
  );
  assert.equal(brokerCalls, 1, 'a conflicting envelope must never reach the broker a second time');
});

test('Solana: a classified sign-only timeout on an owned Keychain client retries exactly once', async t => {
  const { transactionBase64, decodeOptions, policy, signedTxBase64 } = await solanaPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'b'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'return', requestDigest });

  const { calls, exec } = timeoutOnceThenSucceedExec({ signedTxBase64 });
  const keychain = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    timeoutMs: 5,
    exec,
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-solana',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  const signed = await client.sign(transactionBase64);
  assert.equal(signed.signedTxBase64, signedTxBase64);
  assert.equal(calls(), 2, 'exactly one retry after the classified timeout');
});

test('a signature returned by either the timed-out or the retried attempt is recorded exactly once through the existing signed record', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });
  const { exec } = timeoutOnceThenSucceedExec({ signedTx: fixture.signedTx });
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5, exec,
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });
  const signed = await client.sign(fixture.transaction);

  const recorded = await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: signed.signedTx, nonce: '1', blockhash: null, hash: '0xdeadbeef',
  });
  assert.equal(recorded.attempt.state, 'SIGNED');
  const dedupedReplay = await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: signed.signedTx, nonce: '1', blockhash: null, hash: '0xdeadbeef',
  });
  assert.equal(dedupedReplay.attempt.state, 'SIGNED');
});

test('a non-PREPARED chain attempt refuses the binder before any Keychain call', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  // No prepareChainTransactionAttempt: there is no PREPARED chain attempt for this request at all.
  const recovery = { repository, cycleId, stage: 'claim-process', requestDigest };

  let calls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { calls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  await assert.rejects(() => client.sign(fixture.transaction), /chain attempt is not PREPARED/);
  assert.equal(calls, 0, 'Keychain must never be invoked when the binder cannot be persisted');
});

test('a concurrent conflicting binding refuses before signing', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });
  // Simulates a concurrent writer that already bound different material for this exact identity.
  await repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, {
    schema: 'hookemon.sign-only-pre-sign-binding.v1',
    cycleId,
    stage: 'claim-process',
    requestDigest,
    role: OPERATOR_EVM_ROLE,
    account: 'a-different-account',
    unsignedWireBytes: '{"different":true}',
    unsignedRequestDigest: `sha256:${'c'.repeat(64)}`,
    policyDigest: `sha256:${'d'.repeat(64)}`,
    validityContextDigest: `sha256:${'e'.repeat(64)}`,
  });

  let calls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { calls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({
    client: keychain, policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });

  await assert.rejects(() => client.sign(fixture.transaction), /already has a different pre-sign binding/);
  assert.equal(calls, 0, 'Keychain must never be invoked once the binder conflicts');
});

test('SIGNED restart is observation-only: a fresh sign attempt for an already-signed request is refused before Keychain', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });
  const first = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => ({ code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const firstClient = wrapTransactionPolicySignerClient({ client: first, policy, decodeOptions, recovery });
  const signed = await firstClient.sign(fixture.transaction);
  await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: signed.signedTx, nonce: '1', blockhash: null, hash: '0xdeadbeef',
  });

  let calls = 0;
  const restarted = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { calls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const restartedClient = wrapTransactionPolicySignerClient({
    client: restarted, policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });
  await assert.rejects(() => restartedClient.sign(fixture.transaction), /chain attempt is not PREPARED/);
  assert.equal(calls, 0, 'a SIGNED attempt must never be regenerated or re-signed through this path');
});

test('an owned Keychain client with a generic (non-timeout) error never retries', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  let calls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { calls += 1; return { code: 1, stdout: '', stderr: 'keychain locked' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  await assert.rejects(() => client.sign(fixture.transaction), /exited with code 1/);
  assert.equal(calls, 1, 'a generic exit-code failure is not a classified timeout and never retries');
});

test('a proven pre-invocation denial is distinct from the classified timeout and never retries', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  let calls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => {
      calls += 1;
      const error = new Error('spawn hookemon-keychain-sign ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  await assert.rejects(
    () => client.sign(fixture.transaction),
    error => error instanceof KeychainPreInvocationDenialError && !(error instanceof KeychainSignOnlyTimeoutError),
  );
  assert.equal(calls, 1, 'a proven pre-invocation denial is not the classified timeout and never retries');
});

test('an external-module-shaped signer never retries, even when it throws the classified timeout error itself', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  let calls = 0;
  const externalModuleShaped = wrapSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        calls += 1;
        // Deliberately imports and throws the *exact* classified error a real Keychain timeout
        // would -- proving the retry gate is the owned-client identity check, not the error type.
        throw new KeychainSignOnlyTimeoutError('external module pretends to be a sign-only timeout');
      },
      async broadcast() { throw new Error('must not broadcast'); },
    },
  });
  const client = wrapTransactionPolicySignerClient({ client: externalModuleShaped, policy, decodeOptions, recovery });

  await assert.rejects(() => client.sign(fixture.transaction), KeychainSignOnlyTimeoutError);
  assert.equal(calls, 1, 'a non-owned client never gets the bounded retry, regardless of the error it throws');
  assert.equal(
    await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest),
    null,
    'no durable binding is created for a signer this repository has not proven sign-only',
  );
});

test('a structurally cloned (spread) Keychain client is not recognized as owned and never retries', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  const { calls, exec } = timeoutOnceThenSucceedExec({ signedTx: fixture.signedTx });
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5, exec,
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const clone = { ...keychain };
  const client = wrapTransactionPolicySignerClient({ client: clone, policy, decodeOptions, recovery });

  await assert.rejects(() => client.sign(fixture.transaction), KeychainSignOnlyTimeoutError);
  assert.equal(calls(), 1, 'a spread clone must never receive the bounded retry');
  assert.equal(await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest), null);
});

test('broadcast never enters the sign-only retry facade and never retries on its own timeout', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  let signCalls = 0;
  let broadcastCalls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE,
    liveMode: true,
    ...fixtureSignerOptions,
    exec: async ({ args }) => {
      const operation = args[0];
      if (operation === 'sign') {
        signCalls += 1;
        return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' };
      }
      broadcastCalls += 1;
      return { code: 1, stdout: '', stderr: 'sign-only tool refuses broadcast' };
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-evm',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });
  const signed = await client.sign(fixture.transaction);
  assert.equal(signCalls, 1);

  await assert.rejects(() => client.broadcast(signed), /exited with code 1/);
  assert.equal(broadcastCalls, 1, 'broadcast is a distinct guarded method the retry facade never wraps');
  assert.equal(signCalls, 1, 'a broadcast failure must never cause a new sign call');
});

// P1 correction: the retry budget is durable and CAS-reserved, not a property of one function call.
// These tests exercise restart, crash-ambiguity, concurrency, and mid-flight revocation -- the
// exact gaps the independent review found in the original in-memory-only retry.

test('restart: a fresh wrapper constructed after the first timeout gets exactly the one remaining invocation, and nothing after that', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  // "Process 1": times out on ordinal 1 (a real timeout, through the real repository), then dies
  // before it can even attempt its own in-process retry -- simulated by refusing ordinal 2's
  // reservation, so this setup step cannot itself consume the one remaining invocation.
  let firstCalls = 0;
  const first = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5,
    exec: async () => { firstCalls += 1; return new Promise(() => {}); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const firstClient = wrapTransactionPolicySignerClient({
    client: first, policy, decodeOptions,
    recovery: { repository: repositoryThatDiesBeforeOrdinal2(repository), cycleId, stage: 'claim-process', requestDigest },
  });
  await assert.rejects(() => firstClient.sign(fixture.transaction), /simulated process death/);
  assert.equal(firstCalls, 1, 'only ordinal 1 was actually invoked before the simulated crash');
  assert.equal((await repository.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)).state, 'ORDINAL_1_TIMED_OUT');

  // "Restart": a brand-new wrapper and Keychain client, same durable repository/binding identity.
  let secondCalls = 0;
  const second = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { secondCalls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const secondClient = wrapTransactionPolicySignerClient({
    client: second, policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });
  const signed = await secondClient.sign(fixture.transaction);
  assert.equal(signed.signedTx, fixture.signedTx);
  assert.equal(secondCalls, 1, 'the restarted wrapper gets exactly the one remaining ordinal-2 invocation');
  await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: signed.signedTx, nonce: '1', blockhash: null, hash: '0xdeadbeef',
  });

  // A third wrapper (another restart, or the same process calling again) has nothing left.
  let thirdCalls = 0;
  const third = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { thirdCalls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const thirdClient = wrapTransactionPolicySignerClient({
    client: third, policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });
  await assert.rejects(() => thirdClient.sign(fixture.transaction), /chain attempt is not PREPARED/);
  assert.equal(thirdCalls, 0, 'nothing remains once the chain attempt is SIGNED');
});

test('a generic error or crash after ordinal 1 permits no further invocation, even from a fresh restarted wrapper', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  const first = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => ({ code: 1, stdout: '', stderr: 'keychain locked' }),
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const firstClient = wrapTransactionPolicySignerClient({ client: first, policy, decodeOptions, recovery });
  await assert.rejects(() => firstClient.sign(fixture.transaction), /exited with code 1/);
  assert.equal(
    (await repository.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)).state,
    'ORDINAL_1_ALLOCATED',
    'a non-timeout outcome never advances the ledger',
  );

  let secondCalls = 0;
  const second = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { secondCalls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const secondClient = wrapTransactionPolicySignerClient({
    client: second, policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });
  await assert.rejects(() => secondClient.sign(fixture.transaction), /budget is exhausted|ambiguous/);
  assert.equal(secondCalls, 0, 'an ambiguous ordinal-1 outcome must never be retried, even from a fresh wrapper');
});

test('concurrency: two concurrent retry attempts allocate only one ordinal 2, Keychain is reached exactly once across both', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  // Reaches ORDINAL_1_TIMED_OUT through a real timeout and a real repository write, without
  // consuming the one remaining ordinal-2 invocation the race below contests (see
  // repositoryThatDiesBeforeOrdinal2's own doc comment).
  const primer = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5,
    exec: async () => new Promise(() => {}),
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const primerClient = wrapTransactionPolicySignerClient({
    client: primer, policy, decodeOptions,
    recovery: { repository: repositoryThatDiesBeforeOrdinal2(repository), cycleId, stage: 'claim-process', requestDigest },
  });
  await assert.rejects(() => primerClient.sign(fixture.transaction), /simulated process death/);

  let callsA = 0;
  let callsB = 0;
  const clientA = wrapTransactionPolicySignerClient({
    client: createKeychainSignerClient({
      role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
      exec: async () => { callsA += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
      command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
    }),
    policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });
  const clientB = wrapTransactionPolicySignerClient({
    client: createKeychainSignerClient({
      role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
      exec: async () => { callsB += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
      command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
    }),
    policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });

  const results = await Promise.allSettled([clientA.sign(fixture.transaction), clientB.sign(fixture.transaction)]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one of the two racing retries succeeds');
  assert.equal(rejected.length, 1, 'the other refuses rather than also invoking Keychain');
  assert.equal(callsA + callsB, 1, 'Keychain is invoked exactly once across both racing retries');
});

test('a chain attempt that advances between the first timeout and the retry yields zero second Keychain calls', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  const first = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5,
    exec: async () => new Promise(() => {}),
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const firstClient = wrapTransactionPolicySignerClient({ client: first, policy, decodeOptions, recovery });
  await assert.rejects(() => firstClient.sign(fixture.transaction), KeychainSignOnlyTimeoutError);

  // Between the recorded timeout and the retry, something else (e.g. independent reconciliation)
  // advances the durable chain attempt past PREPARED.
  await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: '0xexternallysigned', nonce: '1', blockhash: null, hash: '0xdeadbeef',
  });

  let secondCalls = 0;
  const second = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions,
    exec: async () => { secondCalls += 1; return { code: 0, stdout: JSON.stringify({ signedTx: fixture.signedTx }), stderr: '' }; },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  const secondClient = wrapTransactionPolicySignerClient({
    client: second, policy, decodeOptions, recovery: { repository, cycleId, stage: 'claim-process', requestDigest },
  });
  await assert.rejects(() => secondClient.sign(fixture.transaction), /chain attempt is not PREPARED/);
  assert.equal(secondCalls, 0, 'the retry must never reach Keychain once the chain attempt has advanced');
});

test('an authority/lease guard revoked between the first timeout and the retry reaches zero second broker calls', async t => {
  const { fixture, decodeOptions, policy } = await evmPolicySetup();
  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'claim-process', requestDigest });

  let brokerCalls = 0;
  let guardCalls = 0;
  const rawKeychain = createKeychainSignerClient({
    role: OPERATOR_EVM_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5,
    exec: async () => { brokerCalls += 1; return new Promise(() => {}); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-evm',
  });
  // Mimics stage-driver.mjs's guardedSignerRole: re-runs a mutation-authority guard on every
  // sign() call (not only once at construction) and forwards the owned-Keychain capability exactly
  // as the real stage-driver wrapper does -- so this proves the *existing* per-call guard, not a
  // new callback, is what closes the "revoked between timeout and retry" gap.
  const guardedClient = forwardOwnedKeychainSignOnlyIdentity(rawKeychain, {
    ...rawKeychain,
    sign: async (...args) => {
      guardCalls += 1;
      if (guardCalls > 1) throw new Error('stage-driver: mutation authority was revoked');
      return rawKeychain.sign(...args);
    },
  });
  const client = wrapTransactionPolicySignerClient({ client: guardedClient, policy, decodeOptions, recovery });

  await assert.rejects(() => client.sign(fixture.transaction), /mutation authority was revoked/);
  assert.equal(brokerCalls, 1, 'the guard must refuse the retry before the real broker (raw exec) is ever reached a second time');
  assert.equal(guardCalls, 2, 'the guard is re-run for the retry exactly like every other sign() call');
});

test('a Solana blockhash validity context that drifts between the first timeout and the retry yields zero second Keychain calls', async t => {
  const context = solanaContextFixture();
  const { transactionBase64 } = await solanaPolicySetup();
  // Flips the moment the real broker is actually invoked for ordinal 1 -- so the top-level decode,
  // this module's own pre-bind decode, and ordinal 1's own re-approve decode all still agree (the
  // binding is created honestly), and only ordinal 2's re-approve, which runs strictly after the
  // broker call returned/timed out, observes the drift.
  let drifted = false;
  const decodeOptions = {
    family: 'solana',
    chainId: context.chainId,
    lastValidBlockHeight: context.lastValidBlockHeight,
    blockhashContextResolver: async blockhash => ({
      blockhash,
      lastValidBlockHeight: drifted ? String(Number(context.lastValidBlockHeight) + 1) : context.lastValidBlockHeight,
    }),
    currentBlockHeightResolver: async () => context.currentBlockHeight,
  };
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionBase64 });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);

  const repository = await tempRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const recovery = await preparedRecovery({ repository, cycleId, stage: 'return', requestDigest });

  let brokerCalls = 0;
  const keychain = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE, liveMode: true, ...fixtureSignerOptions, timeoutMs: 5,
    exec: async () => { brokerCalls += 1; drifted = true; return new Promise(() => {}); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign', account: 'hookemon-operator-solana',
  });
  const client = wrapTransactionPolicySignerClient({ client: keychain, policy, decodeOptions, recovery });

  // The fixture policy rule pins the original blockhash/deadline exactly, so a drifted redecode
  // is refused either by this module's own explicit digest comparison or, just as validly, by the
  // ordinary policy re-evaluation this same re-approve step already runs first -- both refuse
  // before a second broker call, which is the property this test exists to prove.
  await assert.rejects(
    () => client.sign(transactionBase64),
    /decoded validity semantics changed|is not explicitly allowed/,
  );
  assert.equal(brokerCalls, 1, 'the drifted validity context must refuse the retry before a second broker call');
});
