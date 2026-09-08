import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createRelayClient, createQuoteUsdValuation, readProcessQuoteUsdProvenance } from '../../src/relay-client.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createRecordedRelayLeg, CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
import { nativeProducedAdmissionFixture } from './admission-fixture.mjs';
const eth = { chainId: '4663', assetId: 'native', decimals: 18 }, zero = `0x${'00'.repeat(20)}`;
test('native return freezes exact down-rounded producer proceeds before effects and preserves evidence on restart', async t => {
  const path = await mkdtemp(join(tmpdir(), 'native-return-usd-')); t.after(() => rm(path, { recursive: true, force: true }));
  let timestamp = 1_700_000_000_000; const now = () => timestamp, testAuthority = createTestProfileMutationAuthority();
  const repository = await CycleRepository.open(path, now, { testAuthority });
  const admission = await nativeProducedAdmissionFixture('synthetic-return-usd');
  await repository.createCycle({ cycleId: admission.cycleId, releaseAmount: '42', mode: 'production', admission });
  const sender = admission.relay.recipient, recipient = admission.relay.sender, mint = admission.aggregatePurchase.assetId;
  const raw = { requestId: 'synthetic-return', details: { sender, recipient,
    currencyIn: { currency: { chainId: 792703809, address: mint, decimals: 6 }, amount: '25000000', amountUsd: '25' },
    currencyOut: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: '21', minimumAmount: '21', amountUsd: '20.1234569' } },
    protocol: { v2: { orderId: `0x${'44'.repeat(32)}`, orderData: { inputs: [{ payment: { chainId: 'solana', currency: mint, amount: '25000000' },
      refunds: [{ chainId: 'solana', currency: mint, recipient: sender, deadline: 2_000_000_000 }] }],
      output: { chainId: 'robinhood', deadline: 2_000_000_000, calls: [], payments: [{ recipient, currency: zero, expectedAmount: '21', minimumAmount: '21' }] } } } }, steps: [] };
  const client = createRelayClient({ now, quoteValidityMs: 60000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }) });
  const quote = await client.quoteReturnBridge({ user: sender, recipient, amount: '25000000', skipRouteCheck: true });
  const destination = { ...eth, amountAtomic: '21' };
  const usd = createQuoteUsdValuation({ quote, side: 'destination', amount: destination, rounding: 'down', nowMs: timestamp });
  assert.equal(usd.amountMicroUsd, '20123456');
  const leg = createRecordedRelayLeg({ cycleId: admission.cycleId, direction: 'return', relayRequestId: quote.requestId, quoteDigest: quote.quoteDigest,
    source: admission.aggregatePurchase, destination, returnAttribution: { schema: 'hookemon.return-leg-attribution-context.v2', intent: client.prepareExecution({ quote, liveMode: true }).intent,
      requestCreatedAtUnixSeconds: String(timestamp / 1000), maxSettlementWindowSeconds: '60', destinationUsd: usd, destinationUsdEvidence: { ...readProcessQuoteUsdProvenance(usd), quote } } });
  const ledger = { schema: 'hookemon.custody-ledger.v3', cycleId: admission.cycleId, ...eth,
    ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, '0'])), claimed: '42', bridgeOut: '42', expectedCycleAsset: destination,
    verifiedCurrentBalance: null, gasReserve: { ...eth, amountAtomic: '200' }, gasSpent: { ...eth, amountAtomic: '0' }, gasPayments: [] };
  await assert.rejects(repository.recordReturnRelayLegExpectation(admission.cycleId, leg, ledger, { destinationUsd: structuredClone(usd) }), /producer USD proceeds capability/);
  const altered = structuredClone(leg); altered.returnAttribution.destinationUsdEvidence.quote.raw.details.currencyOut.amountUsd = '21';
  await assert.rejects(repository.recordReturnRelayLegExpectation(admission.cycleId, altered, ledger, { destinationUsd: usd }), /valuation evidence differs/);
  timestamp += 60000;
  await assert.rejects(repository.recordReturnRelayLegExpectation(admission.cycleId, leg, ledger, { destinationUsd: usd }), /producer USD proceeds capability/);
  timestamp -= 60000;
  await repository.recordReturnRelayLegExpectation(admission.cycleId, leg, ledger, { destinationUsd: usd });
  const restarted = await CycleRepository.open(path, now, { testAuthority });
  assert.deepEqual((await restarted.describeCycle(admission.cycleId)).relayLegs.get(quote.requestId).returnAttribution.destinationUsd, usd);
});
