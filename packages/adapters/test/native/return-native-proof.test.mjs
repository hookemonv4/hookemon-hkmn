import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayNativePaymentProof, isProcessNativePaymentProof } from '../../src/native-payment-proof.mjs';
import { typedAmount, readReturnLegDestinationProof } from '../../src/app/stages/return.mjs';
import { isProcessRpcRelaySourceDebit } from '../../src/solana-rpc.mjs';

test('native return maps only the exact provider native sentinel to internal wei identity', () => {
  assert.deepEqual(typedAmount({ chainId: 4663, address: `0x${'00'.repeat(20)}`, decimals: 18, amount: '42' }),
    { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '42' });
  assert.notEqual(typedAmount({ chainId: 4663, address: `0x${'11'.repeat(20)}`, decimals: 6, amount: '42' }).assetId, 'native');
});

test('native return never converts caller JSON binding, ending balance, or synthetic token receipt into payment authority', async () => {
  let calls = 0;
  const client = { getChainId: async () => { calls++; return 4663; } };
  const candidate = { schema: 'hookemon.native-payment-binding.v1', chainId: '4663', relay: {
    schema: 'hookemon.relay-native-route.v1', metadataEncoding: 'order-id', emitter: `0x${'11'.repeat(20)}`, runtimeHash: `0x${'22'.repeat(32)}` } };
  for (const binding of [undefined, null, candidate, structuredClone(candidate)]) {
    await assert.rejects(createRelayNativePaymentProof({ client, binding, sourceProof: { debitedAmountAtomic: '42' }, expected: {} }), /not authenticated by this release/);
  }
  assert.equal(calls, 0);
  assert.equal(isProcessRpcRelaySourceDebit({ transactionHash: 'signed-looking-json' }), false);
  assert.equal(isProcessNativePaymentProof({ schema: 'hookemon.native-payment-proof.v1', kind: 'relay-return' }), false);
});

test('native return refuses historical legs before RPC observation', async () => {
  const pointer = { schema: 'hookemon.relay-terminal-destination-pointer.v1', relayRequestId: 'request', status: 'SUCCESS', destinationTxHash: `0x${'11'.repeat(32)}` };
  await assert.rejects(readReturnLegDestinationProof({ pointer, leg: { schema: 'hookemon.relay-leg.v1', relayRequestId: 'request' } }), /historical token legs/);
});
