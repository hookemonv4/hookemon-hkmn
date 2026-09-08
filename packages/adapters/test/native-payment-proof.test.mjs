import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256 } from 'viem';
import { createNativePaymentProof, isProcessNativePaymentProof } from '../src/native-payment-proof.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/transactions/evm-relay-step.json', import.meta.url)));
const blockHash = `0x${'ab'.repeat(32)}`;
function setup() {
  const transactionHash = keccak256(fixture.signedTx);
  const expected = { kind: 'direct', chainId: '4663', assetId: 'native', decimals: 18, source: fixture.source.toLowerCase(),
    recipient: fixture.target, amountWei: '42', transactionHash, calldataDigest: keccak256(fixture.transaction.data), nonce: '8' };
  const tx = { hash: transactionHash, from: fixture.source, to: fixture.target, value: 42n, input: fixture.transaction.data,
    nonce: 8, blockNumber: 10n, blockHash };
  const receipt = { transactionHash, blockNumber: 10n, blockHash, status: 'success', logs: [], gasUsed: 21000n, effectiveGasPrice: 3n };
  const client = { getChainId: async () => 4663, getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 100n }) };
  return { client, expected, tx, receipt, signedTransaction: fixture.signedTx };
}
test('native payment capability binds existing signed bytes and finalized RPC, without recipient balance assumptions', async () => {
  const input = setup();
  const proof = await createNativePaymentProof(input);
  assert.equal(proof.amountWei, '42');
  assert.equal(proof.gasSpentWei, '63000');
  assert.ok(isProcessNativePaymentProof(proof, { recipient: input.expected.recipient, amountWei: '42' }));
  assert.equal(isProcessNativePaymentProof(proof, { amountWei: '43' }), false);
  assert.equal(isProcessNativePaymentProof(JSON.parse(JSON.stringify(proof))), false);
  assert.ok(Object.isFrozen(proof));
});
test('native proof refuses substituted identity, amount, signed intent and unsuccessful observations', async () => {
  for (const patch of [{ chainId: '1' }, { assetId: 'USDG' }, { decimals: 6 }, { amountWei: '43' },
    { recipient: `0x${'33'.repeat(20)}` }, { source: `0x${'33'.repeat(20)}` }, { nonce: '9' },
    { calldataDigest: `0x${'00'.repeat(32)}` }, { kind: 'relay-return' }, { kind: 'hook-claim' }]) {
    const input = setup(); Object.assign(input.expected, patch);
    await assert.rejects(createNativePaymentProof(input));
  }
  for (const mutate of [x => { x.receipt.status = 'reverted'; }, x => { x.tx.value = 43n; },
    x => { x.tx.blockHash = `0x${'cd'.repeat(32)}`; }, x => { x.receipt.gasUsed = null; },
    x => { x.client.getChainId = async () => 1; },
    x => { x.client.getBlock = async () => ({ number: 10n, hash: `0x${'cd'.repeat(32)}`, timestamp: 100n }); }]) {
    const input = setup(); mutate(input); await assert.rejects(createNativePaymentProof(input));
  }
});

test('finalized native outbound spends principal once and records gas separately on replay', async () => {
  const { nativeOutboundCustodyAfterPayment } = await import('../src/app/stages/outbound.mjs');
  const proof = await createNativePaymentProof(setup());
  const asset = { chainId: '4663', assetId: 'native', decimals: 18 };
  const row = { schema: 'hookemon.custody-ledger.v3', ...asset, claimed: '42', bridgeOut: '0',
    gasReserve: { ...asset, amountAtomic: '100000' }, gasSpent: { ...asset, amountAtomic: '12' }, gasPayments: [{ transactionHash: `0x${'99'.repeat(32)}`, amountWei: '12' }] };
  const spent = nativeOutboundCustodyAfterPayment(row, proof, null);
  assert.equal(spent.claimed, '42');
  assert.equal(spent.bridgeOut, '42');
  assert.equal(spent.gasSpent.amountAtomic, '63012');
  assert.deepEqual(nativeOutboundCustodyAfterPayment(spent, proof, null), spent);
  assert.throws(() => nativeOutboundCustodyAfterPayment(row, structuredClone(proof), null));
  assert.throws(() => nativeOutboundCustodyAfterPayment({ ...row, claimed: '41' }, proof, null));
});

test('reverted native transaction grants only idempotent gas cost authority', async () => {
  const { createNativeTransactionGasProof, applyNativeCustodyGasPayment } = await import('../src/native-payment-proof.mjs');
  const input = setup(); input.receipt.status = 'reverted';
  const proof = await createNativeTransactionGasProof(input);
  assert.equal(proof.receiptStatus, 'reverted');
  assert.equal(isProcessNativePaymentProof(proof), false);
  assert.equal(Object.hasOwn(proof, 'amountWei'), false);
  const asset = { chainId: '4663', assetId: 'native', decimals: 18 };
  const row = { schema: 'hookemon.custody-ledger.v3', ...asset, gasPayments: [], gasSpent: { ...asset, amountAtomic: '0' } };
  const recorded = applyNativeCustodyGasPayment(row, proof);
  assert.equal(recorded.gasSpent.amountAtomic, '63000');
  assert.deepEqual(applyNativeCustodyGasPayment({ ...row, ...recorded }, proof), recorded);
  assert.throws(() => applyNativeCustodyGasPayment(row, structuredClone(proof)));
  input.expected.amountWei = '43';
  await assert.rejects(createNativeTransactionGasProof(input));
});
