import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayNativePaymentProof, isProcessNativePaymentProof } from '../../src/native-payment-proof.mjs';
import { setup, orderId, recipient, mint, emitter } from './relay-native-proof-fixture.mjs';
test('synthetic native return binds finalized signed source bytes, order, runtime and unique post-payment event', async () => {
  const input = await setup(); const proof = await createRelayNativePaymentProof(input);
  assert.equal(proof.amountWei, '42');
  assert.equal(proof.sourceTransactionHash, input.sourceProof.transactionHash);
  assert.ok(isProcessNativePaymentProof(proof, { kind: 'relay-return', orderId, recipient }));
  assert.equal(isProcessNativePaymentProof(structuredClone(proof)), false);
});
test('synthetic native return refuses wrong order, owner, amount, runtime, duplicate or reverted payment and forged source', async () => {
  for (const mutate of [x => { x.expected.orderId = `0x${'cd'.repeat(32)}`; }, x => { x.expected.sourceOwner = mint; },
    x => { x.expected.sourceAmountAtomic = '1'; }, x => { x.client.getCode = async () => '0x6001'; },
    x => { x.receipt.logs.push(x.receipt.logs[0]); }, x => { x.receipt.status = 'reverted'; },
    x => { x.sourceProof = structuredClone(x.sourceProof); }, x => { x.expected.recipient = emitter; }]) {
    const input = await setup(); mutate(input); await assert.rejects(createRelayNativePaymentProof(input));
  }
});

test('synthetic source proof refuses different finalized bytes or inclusion slot', async () => {
  await assert.rejects(setup({ corruptSourceBytes: true }), /finalized bytes differ/);
  await assert.rejects(setup({ corruptSourceSlot: true }), /finalized bytes differ/);
});
