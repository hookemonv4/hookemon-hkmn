import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveNativePriceCandidate } from '../programmable/lib/phase3-release.mjs';
import { SEED_CANONICAL_LIQUIDITY_SELECTOR, deriveSeedIntent, verifyMaterializedSeedTransaction } from '../programmable/lib/seed-intent.mjs';

const address = (digit) => `0x${digit.repeat(40)}`;
const stock = '1000000000000000000000000000';
function encode(params) {
  const values = [params.tickLower, params.tickUpper, params.liquidity, params.amount0Max,
    params.amount1Max, params.deadline, params.payer, params.custody];
  return SEED_CANONICAL_LIQUIDITY_SELECTOR + values.map(value => {
    const number = BigInt(value);
    return (number < 0n ? (1n << 256n) + number : number).toString(16).padStart(64, '0');
  }).join('');
}

test('native seed value binds the maximum, including refundable wei, and refuses historical zero-value funding', () => {
  // Synthetic funding vector, not a proposed owner funding or transaction.
  const candidate = deriveNativePriceCandidate({ nativeWei: '40000000000000000', hkmnAtomic: stock });
  assert.equal(candidate.consumedHkmn, stock);
  assert.equal(candidate.consumedAmount0, '39999999999999657');
  assert.equal(candidate.refundWei, '343');
  const intent = deriveSeedIntent({ ...candidate, payer: address('1'), tickLower: -887220,
    tickUpper: 887220, maxDeadlineSeconds: 900 });
  const params = { ...intent, deadline: '1700000900', custody: address('3') };
  const transaction = { to: address('2'), value: { chainId: '4663', assetId: 'native', decimals: 18,
    amountAtomic: candidate.amount0Max }, data: encode(params) };
  const verify = value => verifyMaterializedSeedTransaction({ transaction: { ...transaction, value },
    chainId: '4663', expectedHook: address('2'), expectedCustody: address('3'), expectedIntent: intent,
    referenceTimestamp: '1700000000' });
  assert.equal(verify(transaction.value).digest, intent.digest);
  for (const amountAtomic of ['0', candidate.consumedAmount0, '39999999999999999', '40000000000000001']) {
    assert.throws(() => verify({ ...transaction.value, amountAtomic }), /must equal the native amount0Max/);
  }
  for (const mutation of [{ assetId: 'USDG' }, { decimals: 6 }, { chainId: '1' }]) {
    assert.throws(() => verify({ ...transaction.value, ...mutation }), /native amount0Max|chainId mismatch/);
  }
});

test('native full-stock candidate preserves exact stock and maximum/refund conservation over integer scales', () => {
  for (const nativeWei of ['1', '1000', '1000000000000000', '40000000000000000', '1000000000000000000']) {
    const candidate = deriveNativePriceCandidate({ nativeWei, hkmnAtomic: stock });
    assert.equal(candidate.consumedAmount1, stock);
    assert.equal(BigInt(candidate.consumedAmount0) + BigInt(candidate.refundWei), BigInt(nativeWei));
    assert(BigInt(candidate.sqrtPriceX96) > BigInt(candidate.sqrtLowerX96));
    assert(BigInt(candidate.sqrtPriceX96) < BigInt(candidate.sqrtUpperX96));
  }
  for (const nativeWei of [undefined, null, 1000, '0', '-1', '01', '1.0', (1n << 128n).toString()]) {
    assert.throws(() => deriveNativePriceCandidate({ nativeWei, hkmnAtomic: stock }), /canonical integer|uint128/);
  }
  assert.throws(() => deriveNativePriceCandidate({ usdgAtomic: '1000', hkmnAtomic: stock }), /nativeWei/);
});
