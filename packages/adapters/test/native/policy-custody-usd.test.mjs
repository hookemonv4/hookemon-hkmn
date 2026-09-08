import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectPolicyCustody } from '../../src/app/accounting-projection.mjs';
import { createRelayClient, createQuoteUsdValuation } from '../../src/relay-client.mjs';
import { CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
const captured = JSON.parse(readFileSync(new URL('./relay-outbound-captured.json', import.meta.url)));
const nowMs = 1788855723000;
const nativeAsset = { chainId: '4663', assetId: 'native', decimals: 18 };
const amount = { ...nativeAsset, amountAtomic: captured.details.currencyIn.amount };
const ledger = { schema: 'hookemon.custody-ledger.v3', cycleId: 'cycle', ...nativeAsset,
  ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, key === 'claimed' ? amount.amountAtomic : '0'])),
  verifiedCurrentBalance: { observed: true }, expectedCycleAsset: null,
  gasReserve: { ...nativeAsset, amountAtomic: '123456789' }, gasSpent: { ...nativeAsset, amountAtomic: '987654321' } };
const cycleRepository = { listKnownCycleIds: async () => ['cycle'], describeCycle: async () => ({ custodyLedgers: new Map([['native', ledger]]), heldPositions: new Map() }) };
async function capability() {
  const client = createRelayClient({ quoteValidityMs: 60000, now: () => nowMs,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(captured) }) });
  const quote = await client.quote({ direction: 'OUTBOUND', amount: '25000000', tradeType: 'EXACT_OUTPUT', user: captured.details.sender, recipient: captured.details.recipient, skipRouteCheck: true });
  return createQuoteUsdValuation({ quote, side: 'origin', amount, rounding: 'up', nowMs });
}
test('native risk projection requires fresh exact quote valuation and does not relabel wei or gas as USD', async () => {
  const valuation = await capability();
  const result = await projectPolicyCustody({ cycleRepository, nativeAsset, valueAmountUsd: async () => valuation, now: () => nowMs });
  assert.equal(result.atRiskMicroUsd, '25327249');
  assert.equal(result.outstandingMicroUsd, '25327249');
  assert.deepEqual(result.cycleExposureMicroUsd, { cycle: '25327249' });
  assert.equal(result.unvaluedExposure, false);
});
test('native risk projection refuses cloned, expired and missing valuation authority', async () => {
  const valuation = await capability();
  for (const options of [{}, { valueAmountUsd: async () => structuredClone(valuation) }, { valueAmountUsd: async () => valuation, now: () => nowMs + 60000 }]) {
    const result = await projectPolicyCustody({ cycleRepository, nativeAsset, now: () => nowMs, ...options });
    assert.equal(result.unvaluedExposure, true);
    assert.equal(result.atRiskMicroUsd, '0');
  }
});
test('completed native loss freezes committed USD cost minus timely exact settled proceeds and never reprices with FX', async () => {
  const received = '5000000000000000', claimed = '10000000000000000';
  const settled = { direction: 'return', state: 'SETTLED', relayRequestId: 'settled-order', netDeltaAtomic: received,
    finalizedAtDestination: { timestampUnixSeconds: '100' }, returnAttribution: { schema: 'hookemon.return-leg-attribution-context.v2',
      destinationUsd: { amount: { ...nativeAsset, amountAtomic: received }, amountMicroUsd: '20000000', quoteRequestId: 'settled-order',
        sourcePath: 'details.currencyOut.amountUsd', rounding: 'down', observedAtMs: 90000, validUntilMs: 110000 } } };
  const description = { terminalState: 'COMPLETED', releaseAmount: claimed, admission: { schema: 'hookemon.policy-admission.v3',
      aggregateFundingUsd: { amount: { ...nativeAsset, amountAtomic: claimed }, amountMicroUsd: '30000000', rounding: 'up' } },
    custodyLedgers: new Map([['native', { ...ledger, claimed, returnReceived: received }]]), heldPositions: new Map(), relayLegs: new Map([['return', settled]]) };
  const repository = { listKnownCycleIds: async () => ['cycle'], describeCycle: async () => description };
  for (const timestamp of [200000, 900000]) {
    const result = await projectPolicyCustody({ cycleRepository: repository, nativeAsset, now: () => timestamp,
      valueAmountUsd: async () => assert.fail('completed loss cannot request a new price') });
    assert.equal(result.realizedLossMicroUsd, '10000000'); assert.equal(result.unvaluedExposure, false);
  }
  for (const mutate of [x => { x.netDeltaAtomic = '1'; }, x => { x.finalizedAtDestination.timestampUnixSeconds = '110'; },
    x => { delete x.returnAttribution.destinationUsd; }, x => { x.returnAttribution.destinationUsd.rounding = 'up'; }]) {
    const original = structuredClone(settled); mutate(settled);
    const result = await projectPolicyCustody({ cycleRepository: repository, nativeAsset, valueAmountUsd: async () => assert.fail('no FX fallback') });
    assert.equal(result.unvaluedExposure, true);
    Object.keys(settled).forEach(key => delete settled[key]); Object.assign(settled, original);
  }
});
