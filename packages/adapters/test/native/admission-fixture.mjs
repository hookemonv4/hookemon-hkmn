import { createRelayClient, createQuoteUsdValuation } from '../../src/relay-client.mjs';
// Synthetic journal fixture, never a live valuation capability or provider approval.
import { createHash } from 'node:crypto';
import { digest } from '../../../runner/src/cycle/journal.mjs';
const evm = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const solana = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
const usdc = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
export function nativeAdmissionFixture(cycleId, { amountWei = '42', costMicroUsd = '35000000', purchaseAtoms = '25000000' } = {}) {
  function quoted(suffix, byte) {
    const requestId = `${cycleId}-${suffix}`, orderId = `0x${byte.repeat(64)}`, deadlineUnixSeconds = 2_000_000_000;
    const origin = { chainId: 4663, address: `0x${'00'.repeat(20)}`, decimals: 18, amount: amountWei };
    const destination = { chainId: 792703809, address: usdc.assetId, decimals: 6, amount: purchaseAtoms, minimumAmount: purchaseAtoms };
    const raw = { requestId, details: { sender: evm, recipient: solana,
      currencyIn: { currency: { chainId: origin.chainId, address: origin.address, decimals: origin.decimals }, amount: origin.amount },
      currencyOut: { currency: { chainId: destination.chainId, address: destination.address, decimals: destination.decimals }, amount: destination.amount, minimumAmount: destination.minimumAmount } },
      protocol: { v2: { orderId, orderData: { inputs: [{ payment: { chainId: 'robinhood', currency: origin.address, amount: origin.amount } }],
        output: { chainId: 'solana', deadline: deadlineUnixSeconds, calls: [], payments: [{ recipient: solana, currency: destination.address, expectedAmount: destination.amount, minimumAmount: destination.minimumAmount }] } } } }, steps: [] };
    const quote = { direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', requestId, orderId, sender: evm, recipient: solana, deadlineUnixSeconds, origin, destination, raw };
    return { ...quote, stepCount: 0, quoteDigest: digest({ schema: 'hookemon.relay-quote.v1', ...quote }) };
  }
  const unit = quoted('unit', '1'), aggregate = quoted('aggregate', '2');
  const relay = quote => ({ tradeType: 'EXACT_OUTPUT', requestId: quote.requestId, orderId: quote.orderId, quoteDigest: quote.quoteDigest,
    deadlineUnixSeconds: quote.deadlineUnixSeconds, sender: evm, recipient: solana, destinationAmount: purchaseAtoms, destinationMinimumAmount: purchaseAtoms });
  const valuation = quote => ({ schema: 'hookemon.quote-usd-valuation.v1', quoteDigest: quote.quoteDigest,
    requestDigest: digest({ synthetic: quote.requestId }), quoteRequestId: quote.requestId, sourcePath: 'details.currencyIn.amountUsd',
    amount: { ...eth, amountAtomic: amountWei }, amountMicroUsd: costMicroUsd, rounding: 'up', observedAtMs: 0, validUntilMs: 2_000_000_000_000 });
  return { schema: 'hookemon.policy-admission.v3', cycleId, packId: 'base-pack', quantity: 1, quoteDigest: aggregate.quoteDigest,
    unitPurchase: { ...usdc, amountAtomic: purchaseAtoms }, aggregatePurchase: { ...usdc, amountAtomic: purchaseAtoms },
    unitFundingQuote: { ...eth, amountAtomic: amountWei }, aggregateFundingQuote: { ...eth, amountAtomic: amountWei },
    unitFundingUsd: valuation(unit), aggregateFundingUsd: valuation(aggregate), unitRelay: relay(unit), relay: relay(aggregate), unitRelayQuote: unit, relayQuote: aggregate,
    processLiabilityEvidence: { schema: 'hookemon.process-liability-evidence.v2', ...eth, hook: `0x${'77'.repeat(20)}`, cycleId,
      onchainCycleId: `0x${createHash('sha256').update(cycleId).digest('hex')}`, blockNumber: '12345', blockHash: `0x${'33'.repeat(32)}`, finalized: true,
      processLiability: amountWei, remainingProcessClaimCapacity: amountWei, processClaimsPaused: false, processClaimCycleUsed: false,
      activeProcessClaimLimit: amountWei, totalLiability: amountWei, hookNativeBalance: amountWei, isSolvent: true, operations: evm, ceilingAtomic: amountWei } };
}

// Uses the real adapter producer against an isolated synthetic HTTP response.
export async function nativeProducedAdmissionFixture(cycleId, options = {}) {
  const admission = nativeAdmissionFixture(cycleId, options);
  const nowMs = options.nowMs ?? 1_700_000_000_000;
  for (const [quoteField, relayField, valueField, amountField] of [
    ['unitRelayQuote', 'unitRelay', 'unitFundingUsd', 'unitFundingQuote'], ['relayQuote', 'relay', 'aggregateFundingUsd', 'aggregateFundingQuote']]) {
    const raw = admission[quoteField].raw;
    raw.protocol.v2.orderData.inputs[0].refunds = [{ chainId: 'robinhood', currency: raw.details.currencyIn.currency.address, recipient: evm, deadline: 2_000_000_000 }];
    raw.details.currencyIn.amountUsd = `${BigInt(admission[valueField].amountMicroUsd) / 1000000n}.${(BigInt(admission[valueField].amountMicroUsd) % 1000000n).toString().padStart(6, '0')}`;
    const client = createRelayClient({ quoteValidityMs: 60000, now: () => nowMs, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }) });
    const quote = await client.quote({ direction: 'OUTBOUND', amount: admission.aggregatePurchase.amountAtomic, tradeType: 'EXACT_OUTPUT', user: evm, recipient: solana, skipRouteCheck: true });
    admission[quoteField] = quote;
    admission[relayField].quoteDigest = quote.quoteDigest;
    admission[valueField] = createQuoteUsdValuation({ quote, side: 'origin', amount: admission[amountField], rounding: 'up', nowMs });
  }
  admission.quoteDigest = admission.relayQuote.quoteDigest;
  return admission;
}
