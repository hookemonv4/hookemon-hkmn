import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRelayClient, createQuoteUsdValuation, isProcessQuoteUsdValuation, parseQuoteResponse } from '../../src/relay-client.mjs';
const captured = JSON.parse(readFileSync(new URL('./relay-outbound-captured.json', import.meta.url)));
const input = { direction: 'OUTBOUND', amount: '25000000', tradeType: 'EXACT_OUTPUT', user: captured.details.sender,
  recipient: captured.details.recipient, skipRouteCheck: true };
const nowMs = 1788855723000;
async function quote(raw = captured, options = {}) {
  const client = createRelayClient({ quoteValidityMs: 60000, now: () => nowMs,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }), ...options });
  return client.quote(input);
}
const amount = { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: captured.details.currencyIn.amount };
test('fetched native quote yields exact conservative USD capability, not JSON or parser authority', async () => {
  const fetched = await quote();
  const proof = createQuoteUsdValuation({ quote: fetched, side: 'origin', amount, rounding: 'up', nowMs });
  assert.equal(proof.amountMicroUsd, '25327249');
  assert.equal(proof.validUntilMs, nowMs + 60000);
  assert.ok(isProcessQuoteUsdValuation(proof, { amount, rounding: 'up' }));
  assert.equal(isProcessQuoteUsdValuation(structuredClone(proof)), false);
  assert.throws(() => createQuoteUsdValuation({ quote: parseQuoteResponse(captured, input), side: 'origin', amount, rounding: 'up', nowMs }));
});
test('valuation refuses stale, substituted, mutated and unbounded quotes and rounds fraction conservatively', async () => {
  const fetched = await quote();
  const base = { quote: fetched, side: 'origin', amount, rounding: 'up', nowMs };
  for (const patch of [{ nowMs: nowMs + 60000 }, { nowMs: nowMs - 1 }, { requestDigest: 'sha256:wrong' },
    { amount: { ...amount, amountAtomic: '1' } }, { amount: { ...amount, assetId: 'USDG' } }, { rounding: 'nearest' }]) {
    assert.throws(() => createQuoteUsdValuation({ ...base, ...patch }));
  }
  const fractional = structuredClone(captured); fractional.details.currencyIn.amountUsd = '25.3272491';
  const fractionalQuote = await quote(fractional);
  assert.equal(createQuoteUsdValuation({ ...base, quote: fractionalQuote }).amountMicroUsd, '25327250');
  assert.equal(createQuoteUsdValuation({ ...base, quote: fractionalQuote, rounding: 'down' }).amountMicroUsd, '25327249');
  fractionalQuote.raw.details.currencyIn.amountUsd = '1';
  assert.throws(() => createQuoteUsdValuation({ ...base, quote: fractionalQuote }));
  assert.throws(() => createQuoteUsdValuation({ ...base, quote: fetched, amount: { ...amount, decimals: 6 } }));
  const unbounded = await quote(captured, { quoteValidityMs: null });
  assert.throws(() => createQuoteUsdValuation({ ...base, quote: unbounded }));
});

test('Collector-only USD policy refuses USDC atom parity and JSON prices', async () => {
  const { collectorOnlyPackUsdCost } = await import('../../src/app/compose.mjs');
  const config = { now: () => nowMs, pack: { code: 'synthetic' }, collectorCrypt: { packPrice: { chainId: 'solana-mainnet', assetId: captured.details.currencyOut.currency.address, decimals: 6, amountAtomic: '25000000' } } };
  assert.throws(() => collectorOnlyPackUsdCost(config), /fresh authenticated/);
  config.collectorCrypt.packFundingUsd = { amountMicroUsd: '25000000' };
  assert.throws(() => collectorOnlyPackUsdCost(config), /fresh authenticated/);
  config.collectorCrypt.packFundingUsd = await capabilityForWrongAsset();
  assert.throws(() => collectorOnlyPackUsdCost(config), /fresh authenticated/);
  async function capabilityForWrongAsset() { return createQuoteUsdValuation({ quote: await quote(), side: 'origin', amount, rounding: 'up', nowMs }); }
});
