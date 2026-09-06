// Negative cases for the admission bypasses an independent review found: caller-supplied deployment
// identity, an aggregate executable quote that is only shallowly checked, and evidence that is
// missing or unbound. Every case here asserts a refusal; none of them exercise a live provider.
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPolicyAdmission, createTestOnlyAdmissionIdentity } from '../../src/automation/policy-engine.mjs';

const OPERATIONS_EVM = '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384';
const OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FUNDING = Object.freeze({ chainId: '4663', assetId: USDG, decimals: 6 });
const SETTLEMENT = Object.freeze({ chainId: '792703809', assetId: USDC_MINT, decimals: 6 });
const DEADLINE = 2_000_000_000;

function typed(asset, amountAtomic) {
  return { ...asset, amountAtomic };
}

function rawQuote({ requestId, orderId, originAmount, destinationAmount, sender, recipient }) {
  return {
    requestId,
    steps: [{ kind: 'transaction', id: 'step-1', requestId, items: [] }],
    details: {
      sender,
      recipient,
      currencyIn: { currency: { chainId: 4663, address: USDG, symbol: 'USDG', decimals: 6 }, amount: originAmount },
      currencyOut: {
        currency: { chainId: 792703809, address: USDC_MINT, symbol: 'CIRCLE_USD', decimals: 6 },
        amount: destinationAmount,
        minimumAmount: destinationAmount,
      },
    },
    protocol: {
      v2: {
        orderId,
        orderData: {
          output: {
            chainId: 'solana',
            deadline: DEADLINE,
            calls: [],
            payments: [{ recipient, currency: USDC_MINT, expectedAmount: destinationAmount, minimumAmount: destinationAmount }],
          },
          inputs: [{
            payment: { chainId: 'robinhood', currency: USDG, amount: originAmount },
            refunds: [{ chainId: 'robinhood', currency: USDG, recipient: sender, deadline: DEADLINE }],
          }],
        },
      },
    },
  };
}

/**
 * Builds a parsed quote whose digest is the one the policy engine itself recomputes, by asking the
 * engine to normalize a throwaway admission built around it. This deliberately avoids hardcoding a
 * digest: a test that pinned one would keep passing if the recomputation stopped happening.
 */
function parsedQuote({ requestId, orderId, originAmount, destinationAmount, sender, recipient }) {
  const raw = rawQuote({ requestId, orderId, originAmount, destinationAmount, sender, recipient });
  return {
    direction: 'OUTBOUND',
    tradeType: 'EXACT_OUTPUT',
    requestId,
    orderId,
    sender,
    recipient,
    deadlineUnixSeconds: DEADLINE,
    origin: { chainId: 4663, address: USDG, symbol: 'USDG', decimals: 6, amount: originAmount, amountFormatted: null, minimumAmount: null },
    destination: {
      chainId: 792703809, address: USDC_MINT, symbol: 'CIRCLE_USD', decimals: 6,
      amount: destinationAmount, amountFormatted: null, minimumAmount: destinationAmount,
    },
    stepCount: raw.steps.length,
    raw,
    quoteDigest: null,
  };
}

function relayIdentity(quote, destinationAmount) {
  return {
    tradeType: 'EXACT_OUTPUT',
    requestId: quote.requestId,
    orderId: quote.orderId,
    deadlineUnixSeconds: quote.deadlineUnixSeconds,
    sender: quote.sender,
    recipient: quote.recipient,
    destinationAmount,
    destinationMinimumAmount: destinationAmount,
    quoteDigest: quote.quoteDigest,
  };
}

/** A complete, self-consistent admission whose two quote digests are the engine's own. */
function admissionFor({ sender = OPERATIONS_EVM, recipient = OPERATIONS_SOLANA, identity } = {}) {
  const unit = parsedQuote({ requestId: 'req-unit', orderId: `0x${'1'.repeat(64)}`, originAmount: '17', destinationAmount: '8', sender, recipient });
  const aggregate = parsedQuote({ requestId: 'req-aggregate', orderId: `0x${'2'.repeat(64)}`, originAmount: '33', destinationAmount: '16', sender, recipient });
  // Digests are discovered by letting the engine recompute them once from the same evidence.
  for (const quote of [unit, aggregate]) {
    try {
      assertPolicyAdmission({ schema: 'x' });
    } catch {
      // ignored; the engine is asked for a digest through the probe below instead.
    }
    quote.quoteDigest = probeDigest(quote, identity);
  }
  return {
    schema: 'hookemon.policy-admission.v2',
    cycleId: 'cycle-admission-identity-1',
    packId: 'return-fixture',
    quantity: 2,
    quoteDigest: aggregate.quoteDigest,
    unitPurchase: typed(SETTLEMENT, '8'),
    aggregatePurchase: typed(SETTLEMENT, '16'),
    unitFundingQuote: typed(FUNDING, '17'),
    aggregateFundingQuote: typed(FUNDING, '33'),
    relay: relayIdentity(aggregate, '16'),
    unitRelay: relayIdentity(unit, '8'),
    unitRelayQuote: unit,
    relayQuote: aggregate,
  };
}

/**
 * Recovers the digest the engine computes for a quote by submitting it with a deliberately wrong
 * digest and reading the value the refusal reports back. The engine is the only source of truth for
 * this value, which is the point of the aggregate-quote finding.
 */
function probeDigest(quote, identity) {
  const probe = { ...quote, quoteDigest: `sha256:${'0'.repeat(64)}` };
  const candidate = {
    schema: 'hookemon.policy-admission.v2',
    cycleId: 'cycle-admission-identity-1',
    packId: 'return-fixture',
    quantity: 1,
    quoteDigest: `sha256:${'0'.repeat(64)}`,
    unitPurchase: typed(SETTLEMENT, probe.destination.amount),
    aggregatePurchase: typed(SETTLEMENT, probe.destination.amount),
    unitFundingQuote: typed(FUNDING, probe.origin.amount),
    aggregateFundingQuote: typed(FUNDING, probe.origin.amount),
    relay: relayIdentity(probe, probe.destination.amount),
    unitRelay: relayIdentity(probe, probe.destination.amount),
    unitRelayQuote: probe,
    relayQuote: probe,
  };
  try {
    assertPolicyAdmission(candidate, identity);
  } catch (error) {
    const match = /recomputed (sha256:[0-9a-f]{64})/.exec(error.message);
    if (match) return match[1];
  }
  throw new Error('policy engine did not report a recomputed quote digest');
}

test('an ordinary object cannot stand in for the approved deployment identity', () => {
  assert.throws(
    () => assertPolicyAdmission(admissionFor(), {
      evm: `0x${'a'.repeat(40)}`,
      solana: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc',
      fundingRoute: FUNDING,
      settlementRoute: SETTLEMENT,
    }),
    /not the approved production identity/,
  );
});

test('a fixture-shaped identity object cannot re-point the funding or settlement asset', () => {
  assert.throws(
    () => assertPolicyAdmission(admissionFor(), {
      evm: OPERATIONS_EVM,
      solana: OPERATIONS_SOLANA,
      fundingRoute: { chainId: '4663', assetId: `0x${'e'.repeat(40)}`, decimals: 6 },
      settlementRoute: SETTLEMENT,
    }),
    /not the approved production identity/,
  );
});

test('an admission routed to accounts other than the approved Operations identity is refused', () => {
  assert.throws(
    () => assertPolicyAdmission(admissionFor({
      sender: `0x${'c'.repeat(40)}`,
      recipient: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc',
      identity: createTestOnlyAdmissionIdentity({
        evm: `0x${'c'.repeat(40)}`,
        solana: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc',
        fundingRoute: FUNDING,
        settlementRoute: SETTLEMENT,
      }),
    })),
    /Relay exact-output identity is invalid/,
  );
});

test('the test-only identity is honoured only for the exact object the factory minted', () => {
  const identity = createTestOnlyAdmissionIdentity({
    evm: `0x${'c'.repeat(40)}`,
    solana: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc',
    fundingRoute: FUNDING,
    settlementRoute: SETTLEMENT,
  });
  const admission = admissionFor({
    sender: `0x${'c'.repeat(40)}`,
    recipient: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc',
    identity,
  });
  assert.equal(assertPolicyAdmission(admission, identity).cycleId, 'cycle-admission-identity-1');
  // A structurally identical copy is a different object, so it carries no approval.
  assert.throws(() => assertPolicyAdmission(admission, { ...identity }), /not the approved production identity/);
});

test('the aggregate quote is authenticated, not accepted on a matching digest string', () => {
  const admission = admissionFor();
  // Same supplied digest, different executable raw steps: the shallow check this replaces passed.
  const tampered = {
    ...admission,
    relayQuote: {
      ...admission.relayQuote,
      raw: { ...admission.relayQuote.raw, steps: [] },
    },
  };
  assert.throws(() => assertPolicyAdmission(tampered), /relayQuote raw identity is invalid/);
});

test('the aggregate quote cannot carry a different order, deadline or recipient', () => {
  const admission = admissionFor();
  for (const [field, value, pattern] of [
    ['orderId', `0x${'9'.repeat(64)}`, /relayQuote identity is invalid/],
    ['deadlineUnixSeconds', DEADLINE + 1, /relayQuote identity is invalid/],
    ['recipient', 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc', /relayQuote identity is invalid/],
  ]) {
    assert.throws(
      () => assertPolicyAdmission({ ...admission, relayQuote: { ...admission.relayQuote, [field]: value } }),
      pattern,
      `${field} must be rebound`,
    );
  }
});

test('the aggregate quote cannot restate an amount the admission did not bind', () => {
  const admission = admissionFor();
  const tampered = {
    ...admission,
    relayQuote: {
      ...admission.relayQuote,
      origin: { ...admission.relayQuote.origin, amount: '32' },
    },
  };
  assert.throws(() => assertPolicyAdmission(tampered), /relayQuote origin/);
});

test('a supplied aggregate digest that is not the recomputed one is refused', () => {
  const admission = admissionFor();
  const tampered = {
    ...admission,
    quoteDigest: `sha256:${'b'.repeat(64)}`,
    relay: { ...admission.relay, quoteDigest: `sha256:${'b'.repeat(64)}` },
    relayQuote: { ...admission.relayQuote, quoteDigest: `sha256:${'b'.repeat(64)}` },
  };
  assert.throws(() => assertPolicyAdmission(tampered), /digest does not match its immutable parsed evidence/);
});
