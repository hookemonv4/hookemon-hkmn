import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  OPERATIONS_TRIGGER_ROLE,
  OPERATOR_EVM_ROLE,
  ROLE_CAPABILITIES,
  SIGNER_ROLES,
  assertRole,
  wrapSignerClient,
} from '../../src/signing/signer-client.mjs';

test('SIGNER_ROLES includes the WP-39 operations-trigger role, distinct from operator-evm', () => {
  assert.equal(SIGNER_ROLES.includes(OPERATIONS_TRIGGER_ROLE), true);
  assert.notEqual(OPERATIONS_TRIGGER_ROLE, OPERATOR_EVM_ROLE);
  assert.equal(OPERATIONS_TRIGGER_ROLE, 'operations-trigger');
});

test('the operations-trigger role can broadcast, exactly like the two operator roles', () => {
  assert.deepEqual(ROLE_CAPABILITIES[OPERATIONS_TRIGGER_ROLE], { sign: true, broadcast: true });
});

test('assertRole accepts operations-trigger', () => {
  assert.equal(assertRole(OPERATIONS_TRIGGER_ROLE), OPERATIONS_TRIGGER_ROLE);
});

test('wrapSignerClient builds a working operations-trigger client with sign and broadcast', async () => {
  const calls = [];
  const client = wrapSignerClient({
    role: OPERATIONS_TRIGGER_ROLE,
    liveMode: true,
    preflightAuthority: createTestProfileMutationAuthority(),
    inner: {
      async sign(request) { calls.push(['sign', request]); return { signedTx: '0xdeadbeef' }; },
      async broadcast(signed) { calls.push(['broadcast', signed]); return { transactionHash: '0xhash' }; },
    },
  });
  assert.equal(client.role, OPERATIONS_TRIGGER_ROLE);
  const signed = await client.sign({ to: '0xabc', data: '0x', chainId: 4663 });
  assert.equal(signed.signedTx, '0xdeadbeef');
  const broadcast = await client.broadcast(signed);
  assert.equal(broadcast.transactionHash, '0xhash');
  assert.deepEqual(calls.map(([kind]) => kind), ['sign', 'broadcast']);
});

test('wrapSignerClient permits an EVM transaction hash from a broadcast result', async () => {
  const transactionHash = `0x${'a'.repeat(64)}`;
  const client = wrapSignerClient({
    role: OPERATIONS_TRIGGER_ROLE,
    liveMode: true,
    preflightAuthority: createTestProfileMutationAuthority(),
    inner: {
      async sign() { return { signedTx: '0xdeadbeef' }; },
      async broadcast() { return { transactionHash }; },
    },
  });

  assert.deepEqual(await client.broadcast({ signedTx: '0xdeadbeef' }), { transactionHash });
});

test('wrapSignerClient refuses a live mutation before its inner signer or broadcaster runs without an explicit fixture authority', async () => {
  const calls = [];
  const client = wrapSignerClient({
    role: OPERATIONS_TRIGGER_ROLE,
    liveMode: true,
    inner: {
      async sign() { calls.push('sign'); return { signedTx: '0xdeadbeef' }; },
      async broadcast() { calls.push('broadcast'); return { transactionHash: '0xhash' }; },
    },
  });

  await assert.rejects(() => client.sign({ to: '0xabc' }), /active frozen interface authority is invalid/);
  await assert.rejects(() => client.broadcast({ signedTx: '0xdeadbeef' }), /active frozen interface authority is invalid/);
  assert.deepEqual(calls, []);
});

test('wrapSignerClient rejects a copied fixture authority before its inner signer runs', async () => {
  const calls = [];
  const client = wrapSignerClient({
    role: OPERATIONS_TRIGGER_ROLE,
    liveMode: true,
    preflightAuthority: { ...createTestProfileMutationAuthority() },
    inner: { async sign() { calls.push('sign'); return { signedTx: '0xdeadbeef' }; }, async broadcast() { return {}; } },
  });

  await assert.rejects(() => client.sign({ to: '0xabc' }), /test authority is invalid/);
  assert.deepEqual(calls, []);
});

test('an operations-trigger client refuses to sign when constructed with liveMode: false', async () => {
  const client = wrapSignerClient({
    role: OPERATIONS_TRIGGER_ROLE,
    liveMode: false,
    inner: { async sign() { return { signedTx: '0x' }; }, async broadcast() { return {}; } },
  });
  await assert.rejects(client.sign({}), /liveMode is false/);
});
