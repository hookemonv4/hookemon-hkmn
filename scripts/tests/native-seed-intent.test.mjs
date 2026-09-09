import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveNativePriceCandidate, deriveNativeSeedCandidate, deriveTokenInventoryCandidate, sqrtPriceAtTick } from '../programmable/lib/phase3-release.mjs';
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

test('zero-native inventory binds explicit aligned upper price and mechanical locked rounding', () => {
  for (const [tickUpper, expectedDust] of [[0, '0'], [60, '0'], [6000, '1'], [60000, '13']]) {
    const candidate = deriveNativeSeedCandidate({ nativeWei: '0', hkmnAtomic: stock,
      tickLower: -887220, tickUpper, tickSpacing: 60 });
    assert.equal(candidate.sqrtPriceX96, sqrtPriceAtTick(tickUpper).toString());
    assert.equal(candidate.sqrtPriceX96, candidate.sqrtUpperX96);
    assert.equal(candidate.amount0Max, '0');
    assert.equal(candidate.consumedAmount0, '0');
    assert.equal(candidate.lockedHkmnDust, expectedDust);
    assert.equal(BigInt(candidate.consumedHkmn) + BigInt(candidate.lockedHkmnDust), BigInt(stock));
    const span = BigInt(candidate.sqrtUpperX96) - BigInt(candidate.sqrtLowerX96);
    const Q96 = 1n << 96n;
    assert.equal(BigInt(candidate.liquidity), BigInt(stock) * Q96 / span);
    assert((BigInt(candidate.liquidity) + 1n) * span > BigInt(stock) * Q96);
    const intent = deriveSeedIntent({ ...candidate, payer: address('1'), tickLower: -887220, tickUpper, maxDeadlineSeconds: 900 });
    const transaction = { to: address('2'), value: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      data: encode({ ...intent, deadline: '1700000900', custody: address('3') }) };
    const verify = () => verifyMaterializedSeedTransaction({ transaction, chainId: '4663', expectedHook: address('2'),
      expectedCustody: address('3'), expectedIntent: intent, referenceTimestamp: '1700000000' });
    assert.equal(verify().digest, intent.digest);
    transaction.value.amountAtomic = '1';
    assert.throws(verify, /native amount0Max/);
  }
});

test('inventory derivation refuses missing inputs, invalid ranges and liquidity beyond pinned limits', () => {
  const input = { hkmnAtomic: stock, tickLower: -887220, tickUpper: 60, tickSpacing: 60 };
  for (const change of [{ tickLower: null }, { tickUpper: undefined }, { tickSpacing: undefined },
    { tickLower: 60 }, { tickUpper: -887220 }, { tickLower: -887280 }, { tickUpper: 887280 },
    { tickUpper: 61 }, { tickSpacing: 0 }, { tickSpacing: 32768 }]) {
    assert.throws(() => deriveTokenInventoryCandidate({ ...input, ...change }), /explicit valid aligned/);
  }
  assert.throws(() => deriveTokenInventoryCandidate({ ...input, tickLower: -887272, tickUpper: 887272, tickSpacing: 1 }), /initialization bounds/);
  assert.throws(() => deriveTokenInventoryCandidate({ ...input, hkmnAtomic: ((1n << 128n) - 1n).toString(), tickLower: 0 }), /per-tick bounds/);
  assert.throws(() => deriveTokenInventoryCandidate({ ...input, hkmnAtomic: '1', tickUpper: 887220 }), /per-tick bounds/);
});
