// Synthetic quotes for runner integration tests; no adapter or live provider authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, digest } from '../../src/cycle/journal.mjs';
import { assertPolicyAdmission } from '../../src/automation/policy-engine.mjs';

const values = new WeakSet();
const fetchedAdmissions = new Map();
function valuationFixture(amount, quote, cost = '25000000') {
  const value = { schema: 'hookemon.quote-usd-valuation.v1', quoteDigest: quote.quoteDigest,
    requestDigest: digest({ fixtureRequest: quote.requestId }), quoteRequestId: quote.requestId,
    sourcePath: 'details.currencyIn.amountUsd', amount, amountMicroUsd: cost, rounding: 'up',
    observedAtMs: 0, validUntilMs: quote.deadlineUnixSeconds * 1000 };
  values.add(value);
  return value;
}
export function verifyFixtureQuoteUsdValuation(value, expected = {}) {
  return values.has(value) && Object.entries(expected).every(([key, entry]) => canonicalJson(value[key]) === canonicalJson(entry));
}
function parsedUnitRelayQuote({ cycleId, unitFunding, unitPurchase, deadlineUnixSeconds, requestId: overrideRequestId, orderId: overrideOrderId }) {
  const sender = '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384';
  const recipient = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const origin = {
    chainId: 4663, address: '0x0000000000000000000000000000000000000000', decimals: 18, amount: unitFunding,
  };
  const destination = {
    chainId: 792703809, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6,
    amount: unitPurchase, minimumAmount: unitPurchase,
  };
  const requestId = overrideRequestId ?? `relay-unit-${cycleId}`;
  const orderId = overrideOrderId ?? `0x${'1'.repeat(64)}`;
  const raw = {
    requestId,
    details: {
      sender,
      recipient,
      currencyIn: { currency: { chainId: origin.chainId, address: origin.address, decimals: origin.decimals }, amount: origin.amount },
      currencyOut: { currency: { chainId: destination.chainId, address: destination.address, decimals: destination.decimals }, amount: destination.amount, minimumAmount: destination.minimumAmount },
    },
    protocol: { v2: { orderId, orderData: {
      inputs: [{ payment: { chainId: 'robinhood', currency: origin.address, amount: origin.amount } }],
      output: { chainId: 'solana', deadline: deadlineUnixSeconds, calls: [], payments: [{ recipient, currency: destination.address, expectedAmount: destination.amount, minimumAmount: destination.minimumAmount }] },
    } } },
    steps: [],
  };
  const quote = {
    direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', requestId, orderId, sender, recipient,
    deadlineUnixSeconds, origin, destination, stepCount: raw.steps.length, raw,
  };
  return {
    ...quote,
    quoteDigest: digest({
      schema: 'hookemon.relay-quote.v1', direction: quote.direction, tradeType: quote.tradeType,
      requestId: quote.requestId, orderId: quote.orderId, sender: quote.sender, recipient: quote.recipient,
      deadlineUnixSeconds: quote.deadlineUnixSeconds, origin: quote.origin, destination: quote.destination, raw: quote.raw,
    }),
  };
}

// Same sha256-of-the-plain-cycleId formula as `deriveOnchainCycleId` in
// packages/adapters/src/app/stages/action-builder.mjs, duplicated to keep this package boundary
// clean; the policy engine's own evidence normalizer computes it the same way.
function onchainCycleIdFor(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

const PRODUCTION_HOOK = `0x${'7'.repeat(40)}`;

/** A finalized hook process-liability evidence record covering exactly `ceilingAtomic`. */
function processLiabilityEvidenceFixture({ cycleId, ceilingAtomic }) {
  return {
    schema: 'hookemon.process-liability-evidence.v2',
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    hook: PRODUCTION_HOOK,
    cycleId,
    onchainCycleId: onchainCycleIdFor(cycleId),
    blockNumber: '12345',
    blockHash: `0x${'3'.repeat(64)}`,
    finalized: true,
    processLiability: ceilingAtomic,
    remainingProcessClaimCapacity: ceilingAtomic,
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: ceilingAtomic,
    totalLiability: ceilingAtomic,
    hookNativeBalance: ceilingAtomic,
    isSolvent: true,
    operations: '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384',
    ceilingAtomic,
  };
}

function exactOutputAdmission({
  cycleId, quantity = 1, unitPurchase = '25000000', unitFunding = '30000000',
  aggregateFunding = unitFunding, deadlineUnixSeconds = 1_000_000,
} = {}) {
  const aggregatePurchase = (BigInt(unitPurchase) * BigInt(quantity)).toString();
  const unitRelayQuote = parsedUnitRelayQuote({ cycleId, unitFunding, unitPurchase, deadlineUnixSeconds });
  // The aggregate quote is the one restart and outbound execute, so it now carries the same parsed
  // and raw evidence as the unit quote and its digest is recomputed from that evidence too.
  const relayQuote = parsedUnitRelayQuote({
    cycleId,
    unitFunding: aggregateFunding,
    unitPurchase: aggregatePurchase,
    deadlineUnixSeconds,
    requestId: 'relay-n2',
    orderId: `0x${'2'.repeat(64)}`,
  });
  return {
    schema: 'hookemon.policy-admission.v3',
    cycleId,
    packId: 'base-pack',
    quantity,
    quoteDigest: relayQuote.quoteDigest,
    unitPurchase: { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: unitPurchase },
    aggregatePurchase: { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: aggregatePurchase },
    unitFundingQuote: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: unitFunding },
    aggregateFundingQuote: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: aggregateFunding },
    unitFundingUsd: valuationFixture({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: unitFunding }, unitRelayQuote),
    aggregateFundingUsd: valuationFixture({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: aggregateFunding }, relayQuote),
    unitRelay: {
      tradeType: 'EXACT_OUTPUT', requestId: `relay-unit-${cycleId}`, orderId: `0x${'1'.repeat(64)}`,
      quoteDigest: unitRelayQuote.quoteDigest, deadlineUnixSeconds,
      sender: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384', recipient: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE',
      destinationAmount: unitPurchase, destinationMinimumAmount: unitPurchase,
    },
    unitRelayQuote,
    relayQuote,
    relay: {
      tradeType: 'EXACT_OUTPUT', requestId: 'relay-n2', orderId: `0x${'2'.repeat(64)}`,
      quoteDigest: relayQuote.quoteDigest,
      deadlineUnixSeconds, sender: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384',
      recipient: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE', destinationAmount: aggregatePurchase, destinationMinimumAmount: aggregatePurchase,
    },
    processLiabilityEvidence: processLiabilityEvidenceFixture({ cycleId, ceilingAtomic: aggregateFunding }),
  };
}


export function createNativeAdmissionFixture({ cycleId, packId = 'base-pack', fundingWei = '30000000', costMicroUsd = '25000000', purchaseAtoms = '25000000' }) {
  const admission = exactOutputAdmission({ cycleId, unitFunding: fundingWei, unitPurchase: purchaseAtoms });
  admission.packId = packId;
  admission.unitFundingUsd = valuationFixture(admission.unitFundingQuote, admission.unitRelayQuote, costMicroUsd);
  admission.aggregateFundingUsd = valuationFixture(admission.aggregateFundingQuote, admission.relayQuote, costMicroUsd);
  fetchedAdmissions.set(cycleId, admission);
  assertPolicyAdmission(admission);
  return admission;
}
/** Re-read the independent test quote source; durable JSON alone never grants its capability. */
export function reauthenticateNativeAdmissionFixture(persisted) {
  if (!persisted) return persisted;
  const fetched = fetchedAdmissions.get(persisted.cycleId);
  assert.ok(fetched, 'a fresh independent fixture quote is required');
  assert.deepEqual(assertPolicyAdmission(persisted), assertPolicyAdmission(fetched));
  return { ...persisted, unitFundingUsd: fetched.unitFundingUsd, aggregateFundingUsd: fetched.aggregateFundingUsd };
}
