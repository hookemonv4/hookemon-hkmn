// Tests for packages/adapters/src/relay-client.mjs. Every test here runs against either a
// scripted (mocked) fetchImpl or a recorded/schema-verified fixture — none executes a live quote
// or any other live network call (see packages/adapters/test/relay-client.live-chains.mjs for the
// separate, non-blocking live /chains smoke test).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DIRECTIONS,
  INTENT_STATUS,
  RECONCILE_OUTCOME,
  RelayApiError,
  RelayCredentialsRequiredError,
  RelayIntentAuthenticationError,
  RelayLiveModeRequiredError,
  RelayMalformedResponseError,
  RelayNetworkError,
  RelayQuoteExpiredError,
  RelayRouteNotEnabledError,
  RelayUnknownIntentError,
  assertRouteEnabled,
  assertQuoteUsable,
  createRelayClient,
  parseIntentDetailResponse,
  parseIntentStatusResponse,
  parseQuoteResponse,
  reconcileIntentOutcome,
} from '../src/relay-client.mjs';

function loadFixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/relay/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const chainsFixture = loadFixture('chains.json');
const quoteOutboundFixture = loadFixture('quote-outbound.json');
const quoteReturnFixture = loadFixture('quote-return.json');
const statusRefundFixture = loadFixture('intents-status-refund.json');
const requestsRefundDetailFixture = loadFixture('requests-refund-detail.json');
const OUTBOUND_QUOTE_INPUT = Object.freeze({
  user: quoteOutboundFixture.details.sender,
  recipient: quoteOutboundFixture.details.recipient,
  amount: quoteOutboundFixture.details.currencyIn.amount,
});
const RETURN_QUOTE_INPUT = Object.freeze({
  user: quoteReturnFixture.details.sender,
  recipient: quoteReturnFixture.details.recipient,
  amount: quoteReturnFixture.details.currencyIn.amount,
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** A scripted fetchImpl keyed by "METHOD pathname"; each entry is a response or a
 * (url) => response function so a handler can inspect query params. */
function createScriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const key = `${options.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, url, options });
    const entry = script[key];
    if (!entry) throw new Error(`test harness: no scripted response for ${key}`);
    return typeof entry === 'function' ? entry(url, options) : entry;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ---------------------------------------------------------------------------
// Route-enable gate (depositEnabled + supportsBridging)
// ---------------------------------------------------------------------------

test('assertRouteEnabled passes for both directions against the real recorded /chains fixture', () => {
  const outbound = assertRouteEnabled({ direction: DIRECTIONS.OUTBOUND, chainsResponse: chainsFixture });
  assert.equal(outbound.origin.chainId, 4663);
  assert.equal(outbound.destination.chainId, 792703809);
  assert.ok(Object.values(outbound.checks).every(Boolean));

  const inbound = assertRouteEnabled({ direction: DIRECTIONS.RETURN, chainsResponse: chainsFixture });
  assert.equal(inbound.origin.chainId, 792703809);
  assert.equal(inbound.destination.chainId, 4663);
  assert.ok(Object.values(inbound.checks).every(Boolean));
});

test('assertRouteEnabled fails closed when the origin chain has depositEnabled: false', () => {
  const disabled = structuredClone(chainsFixture);
  disabled.chains.find((c) => c.id === 4663).depositEnabled = false;
  assert.throws(
    () => assertRouteEnabled({ direction: DIRECTIONS.OUTBOUND, chainsResponse: disabled }),
    (error) => {
      assert.ok(error instanceof RelayRouteNotEnabledError);
      assert.equal(error.checks.originChainDepositEnabled, false);
      assert.equal(error.checks.destinationChainDepositEnabled, true);
      return true;
    },
  );
});

test('assertRouteEnabled fails closed when the destination currency is missing from erc20Currencies/solverCurrencies', () => {
  const stripped = structuredClone(chainsFixture);
  const solana = stripped.chains.find((c) => c.id === 792703809);
  solana.erc20Currencies = solana.erc20Currencies.filter((c) => c.symbol !== 'CIRCLE_USD');
  solana.solverCurrencies = (solana.solverCurrencies ?? []).filter((c) => c.symbol !== 'CIRCLE_USD');
  assert.throws(
    () => assertRouteEnabled({ direction: DIRECTIONS.OUTBOUND, chainsResponse: stripped }),
    (error) => {
      assert.ok(error instanceof RelayRouteNotEnabledError);
      assert.equal(error.checks.destinationCurrencyBridgingEnabled, false);
      return true;
    },
  );
});

test('quote() checks the route before ever calling /quote/v2', async () => {
  const disabled = structuredClone(chainsFixture);
  disabled.chains.find((c) => c.id === 4663).depositEnabled = false;
  const fetchImpl = createScriptedFetch({ 'GET /chains': jsonResponse(200, disabled) });
  const client = createRelayClient({ fetchImpl });
  await assert.rejects(
    () => client.quoteOutboundBridge({ user: '0xdead', amount: '25000000' }),
    RelayRouteNotEnabledError,
  );
  assert.deepEqual(fetchImpl.calls.map((c) => c.key), ['GET /chains']);
});

// ---------------------------------------------------------------------------
// Both bridge directions have a typed client function
// ---------------------------------------------------------------------------

test('quoteOutboundBridge returns a typed QuoteResult for USDG(4663) -> Solana Circle USD', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  assert.equal(quote.direction, DIRECTIONS.OUTBOUND);
  assert.equal(quote.requestId, quoteOutboundFixture.requestId);
  assert.equal(quote.orderId, quoteOutboundFixture.protocol.v2.orderId);
  assert.equal(quote.origin.chainId, 4663);
  assert.equal(quote.origin.decimals, 6);
  assert.equal(quote.destination.chainId, 792703809);
  assert.equal(quote.destination.decimals, 6);
  assert.equal(quote.destination.amount, quoteOutboundFixture.details.currencyOut.amount);
  assert.equal(quote.destination.minimumAmount, quoteOutboundFixture.details.currencyOut.minimumAmount);
});

test('quoteReturnBridge returns a typed QuoteResult for Solana Circle USD -> USDG(4663)', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteReturnFixture),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteReturnBridge(RETURN_QUOTE_INPUT);
  assert.equal(quote.direction, DIRECTIONS.RETURN);
  assert.equal(quote.origin.chainId, 792703809);
  assert.equal(quote.destination.chainId, 4663);
  assert.equal(quote.destination.amount, quoteReturnFixture.details.currencyOut.amount);
});

test('quoteOutboundBridge binds its Relay route and persisted intent to the configured exact Solana mint', async () => {
  const configuredMint = `e${quoteOutboundFixture.details.currencyOut.currency.address.slice(1)}`;
  const quoteFixture = structuredClone(quoteOutboundFixture);
  quoteFixture.details.currencyOut.currency.address = configuredMint;
  quoteFixture.protocol.v2.orderData.output.payments[0].currency = configuredMint;
  quoteFixture.protocol.v2.orderData.inputs[0].refunds
    .filter((refund) => refund.currency === quoteOutboundFixture.details.currencyOut.currency.address)
    .forEach((refund) => { refund.currency = configuredMint; });
  const chains = structuredClone(chainsFixture);
  const solana = chains.chains.find((chain) => chain.id === 792703809);
  for (const collection of [solana.erc20Currencies, solana.solverCurrencies]) {
    const currency = collection.find((entry) => entry.address === quoteOutboundFixture.details.currencyOut.currency.address);
    if (currency) currency.address = configuredMint;
  }
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chains),
    'POST /quote/v2': (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.destinationCurrency, configuredMint);
      return jsonResponse(200, quoteFixture);
    },
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge({ ...OUTBOUND_QUOTE_INPUT, destinationCurrency: configuredMint });
  const prepared = client.prepareExecution({ quote, liveMode: true });
  assert.equal(quote.destination.address, configuredMint);
  assert.equal(prepared.intent.destinationAssetId, configuredMint);
});

test('parseQuoteResponse rejects a response whose route does not match what was requested', () => {
  // A quote response for the wrong direction must never be silently accepted as if it matched.
  assert.throws(
    () => parseQuoteResponse(quoteOutboundFixture, { direction: DIRECTIONS.RETURN }),
    RelayMalformedResponseError,
  );
});

test('parseQuoteResponse rejects a case-altered Solana mint', () => {
  const altered = structuredClone(quoteOutboundFixture);
  altered.details.currencyOut.currency.address = `e${altered.details.currencyOut.currency.address.slice(1)}`;
  assert.throws(
    () => parseQuoteResponse(altered, { direction: DIRECTIONS.OUTBOUND }),
    RelayMalformedResponseError,
  );
});

test('parseQuoteResponse accepts checksum-casing variation for an EVM currency address', () => {
  const altered = structuredClone(quoteOutboundFixture);
  const address = altered.details.currencyIn.currency.address;
  altered.details.currencyIn.currency.address = `0x${address.slice(2).toUpperCase()}`;
  assert.doesNotThrow(() => parseQuoteResponse(altered, { direction: DIRECTIONS.OUTBOUND }));
});

test('quoteOutboundBridge binds the recorded response to the requested sender, recipient, and input amount', async () => {
  const altered = structuredClone(quoteOutboundFixture);
  altered.details.sender = `0x${'1'.repeat(40)}`;
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, altered),
  });
  const client = createRelayClient({ fetchImpl });
  await assert.rejects(
    () => client.quoteOutboundBridge({
      user: quoteOutboundFixture.details.sender,
      recipient: quoteOutboundFixture.details.recipient,
      amount: quoteOutboundFixture.details.currencyIn.amount,
    }),
    RelayMalformedResponseError,
  );
});

test('parseQuoteResponse rejects an order that redirects an origin-asset refund away from the Operations sender', () => {
  const altered = structuredClone(quoteOutboundFixture);
  altered.protocol.v2.orderData.inputs[0].refunds[0].recipient = `0x${'1'.repeat(40)}`;
  assert.throws(
    () => parseQuoteResponse(altered, { direction: DIRECTIONS.OUTBOUND }),
    RelayMalformedResponseError,
  );
});

test('parseQuoteResponse rejects an order whose origin-asset refund names the destination chain', () => {
  const altered = structuredClone(quoteOutboundFixture);
  altered.protocol.v2.orderData.inputs[0].refunds[0].chainId = 'solana';
  assert.throws(
    () => parseQuoteResponse(altered, { direction: DIRECTIONS.OUTBOUND }),
    RelayMalformedResponseError,
  );
});

test('quoteOutboundBridge exposes the recorded order deadline and refuses a quote once it expires', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge({
    user: quoteOutboundFixture.details.sender,
    recipient: quoteOutboundFixture.details.recipient,
    amount: quoteOutboundFixture.details.currencyIn.amount,
  });
  assert.equal(quote.deadlineUnixSeconds, quoteOutboundFixture.protocol.v2.orderData.output.deadline);
  assert.doesNotThrow(() => assertQuoteUsable({ quote, nowMs: (quote.deadlineUnixSeconds * 1000) - 1 }));
  assert.throws(
    () => assertQuoteUsable({ quote, nowMs: quote.deadlineUnixSeconds * 1000 }),
    RelayQuoteExpiredError,
  );
});

// ---------------------------------------------------------------------------
// Dry-run vs liveMode gating
// ---------------------------------------------------------------------------

test('simulateExecution is always allowed and mutates nothing', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  const record = client.simulateExecution({ quote });
  assert.equal(record.wouldExecute, true);
  assert.equal(record.liveMode, false);
  assert.equal(record.requestId, quote.requestId);
  // A dry-run simulation must not register the intent for status/detail authentication.
  await assert.rejects(() => client.getIntentStatus({ intentDigest: quote.requestId }), RelayUnknownIntentError);
});

test('prepareExecution refuses execution unless liveMode is explicitly true', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  assert.throws(() => client.prepareExecution({ quote }), RelayLiveModeRequiredError);
  assert.throws(() => client.prepareExecution({ quote, liveMode: false }), RelayLiveModeRequiredError);
  const prepared = client.prepareExecution({ quote, liveMode: true });
  assert.equal(prepared.liveMode, true);
  assert.equal(prepared.intentDigest, quote.requestId);
  assert.deepEqual(prepared.steps, quoteOutboundFixture.steps);
});

test('a persisted Relay intent can be restored into a fresh client before status reconciliation', async () => {
  const quoteFetch = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
  });
  const quoteClient = createRelayClient({ fetchImpl: quoteFetch });
  const quote = await quoteClient.quoteOutboundBridge({
    user: quoteOutboundFixture.details.sender,
    recipient: quoteOutboundFixture.details.recipient,
    amount: quoteOutboundFixture.details.currencyIn.amount,
  });
  const prepared = quoteClient.prepareExecution({ quote, liveMode: true });

  const statusFetch = createScriptedFetch({
    'GET /intents/status/v3': jsonResponse(200, statusRefundFixture),
  });
  const restartedClient = createRelayClient({ fetchImpl: statusFetch });
  restartedClient.restoreIntent({ intent: prepared.intent });
  const status = await restartedClient.getIntentStatus({ intentDigest: prepared.intentDigest });
  assert.equal(status.status, INTENT_STATUS.REFUND);
  assert.equal(statusFetch.calls.length, 1);
});

test('restoreIntent rejects a tampered persisted destination chain before making a Relay request', () => {
  const client = createRelayClient({ fetchImpl: createScriptedFetch({}) });
  assert.throws(
    () => client.restoreIntent({
      intent: {
        schema: 'hookemon.relay-intent.v1',
        requestId: quoteOutboundFixture.requestId,
        orderId: quoteOutboundFixture.protocol.v2.orderId,
        direction: DIRECTIONS.OUTBOUND,
        originChainId: 4663,
        destinationChainId: 4663,
        quotedDestinationAmount: quoteOutboundFixture.details.currencyOut.amount,
        quotedDestinationMinimumAmount: quoteOutboundFixture.details.currencyOut.minimumAmount,
        deadlineUnixSeconds: quoteOutboundFixture.protocol.v2.orderData.output.deadline,
      },
    }),
    RelayMalformedResponseError,
  );
});

// ---------------------------------------------------------------------------
// Status authentication: never accept a response for a digest this adapter did not submit
// ---------------------------------------------------------------------------

test('getIntentStatus rejects a digest this adapter instance never submitted', async () => {
  const fetchImpl = createScriptedFetch({});
  const client = createRelayClient({ fetchImpl });
  await assert.rejects(
    () => client.getIntentStatus({ intentDigest: '0xneverseen' }),
    RelayUnknownIntentError,
  );
  assert.equal(fetchImpl.calls.length, 0, 'must not even attempt the network call for an unknown digest');
});

test('getIntentStatus rejects a response whose chain ids do not match the submitted intent', async () => {
  // Submit a RETURN-direction intent (origin=Solana, destination=Robinhood), then serve a status
  // response whose chain ids belong to the OUTBOUND direction — a real cross-wiring bug this must
  // catch rather than "loosely matching by chain/asset/amount alone".
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteReturnFixture),
    'GET /intents/status/v3': jsonResponse(200, {
      status: 'success', originChainId: 4663, destinationChainId: 792703809, inTxHashes: [], txHashes: [], updatedAt: 1,
    }),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteReturnBridge(RETURN_QUOTE_INPUT);
  client.prepareExecution({ quote, liveMode: true });
  await assert.rejects(
    () => client.getIntentStatus({ intentDigest: quote.requestId }),
    RelayIntentAuthenticationError,
  );
});

test('getIntentStatus accepts a correctly-authenticated response', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
    'GET /intents/status/v3': (url) => {
      assert.equal(url.searchParams.get('requestId'), quoteOutboundFixture.requestId);
      return jsonResponse(200, statusRefundFixture);
    },
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  client.prepareExecution({ quote, liveMode: true });
  const status = await client.getIntentStatus({ intentDigest: quote.requestId });
  assert.equal(status.status, INTENT_STATUS.REFUND);
  assert.equal(status.failReason, 'TOO_LITTLE_RECEIVED');
});

test('getTerminalDestinationTransactionPointer exposes one successful return hash only as a pointer', async () => {
  const destinationTxHash = `0x${'a'.repeat(64)}`;
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteReturnFixture),
    'GET /intents/status/v3': jsonResponse(200, {
      status: 'success',
      originChainId: 792703809,
      destinationChainId: 4663,
      inTxHashes: ['solana-source-signature'],
      txHashes: [destinationTxHash],
    }),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteReturnBridge(RETURN_QUOTE_INPUT);
  client.prepareExecution({ quote, liveMode: true });

  const pointer = await client.getTerminalDestinationTransactionPointer({ intentDigest: quote.requestId });
  assert.deepEqual(pointer, {
    schema: 'hookemon.relay-terminal-destination-pointer.v1',
    relayRequestId: quote.requestId,
    status: INTENT_STATUS.SUCCESS,
    destinationTxHash,
  });
});

test('getTerminalOriginRefundTransactionPointer exposes one authenticated outbound refund hash only as a pointer', async () => {
  const refundTxHash = `0x${'b'.repeat(64)}`;
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
    'GET /intents/status/v3': jsonResponse(200, {
      status: 'refund',
      originChainId: 4663,
      destinationChainId: 792703809,
      inTxHashes: [`0x${'a'.repeat(64)}`],
      txHashes: [refundTxHash],
    }),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  client.prepareExecution({ quote, liveMode: true });

  const pointer = await client.getTerminalOriginRefundTransactionPointer({ intentDigest: quote.requestId });
  assert.deepEqual(pointer, {
    schema: 'hookemon.relay-terminal-origin-refund-pointer.v1',
    relayRequestId: quote.requestId,
    status: INTENT_STATUS.REFUND,
    refundTxHash,
  });
});

test('getIntentStatus rejects a terminal response that omits either route chain identity', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
    'GET /intents/status/v3': jsonResponse(200, { status: 'success', txHashes: ['unverified-hash'] }),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  client.prepareExecution({ quote, liveMode: true });
  await assert.rejects(
    () => client.getIntentStatus({ intentDigest: quote.requestId }),
    RelayIntentAuthenticationError,
  );
});

test('parseIntentStatusResponse handles the live-verified {"status":"unknown"} shape for a garbage digest', () => {
  const result = parseIntentStatusResponse({ status: 'unknown' });
  assert.equal(result.status, INTENT_STATUS.UNKNOWN);
});

test('getIntentDetail fails closed without a configured Relay API key', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
  });
  const client = createRelayClient({ fetchImpl });
  const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
  client.prepareExecution({ quote, liveMode: true });
  await assert.rejects(
    () => client.getIntentDetail({ intentDigest: quote.requestId }),
    RelayCredentialsRequiredError,
  );
});

// ---------------------------------------------------------------------------
// Venue-failure / malformed-response isolation
// ---------------------------------------------------------------------------

test('a network failure (timeout/DNS/abort) surfaces as a typed RelayNetworkError, never a false success', async () => {
  const fetchImpl = async () => {
    throw new Error('simulated ECONNRESET');
  };
  const client = createRelayClient({ fetchImpl });
  await assert.rejects(() => client.getChains(), RelayNetworkError);
});

test('a non-JSON response body surfaces as a typed RelayMalformedResponseError', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': { ok: true, status: 200, text: async () => '<html>not json</html>' },
  });
  const client = createRelayClient({ fetchImpl });
  await assert.rejects(() => client.getChains(), RelayMalformedResponseError);
});

test('a non-2xx response surfaces as a typed RelayApiError carrying Relay\'s own errorCode', async () => {
  const fetchImpl = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(400, { message: 'Recipient address is a token contract and cannot receive funds', errorCode: 'INVALID_RECIPIENT' }),
  });
  const client = createRelayClient({ fetchImpl });
  await assert.rejects(
    () => client.quoteOutboundBridge({ user: '0xdead', amount: '25000000' }),
    (error) => {
      assert.ok(error instanceof RelayApiError);
      assert.equal(error.errorCode, 'INVALID_RECIPIENT');
      assert.equal(error.httpStatus, 400);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Quote-vs-execution differential + the recordDegradedReturn-eligible signal
// ---------------------------------------------------------------------------

test('reconcileIntentOutcome: an executed amount equal to the quote is FILLED_AS_QUOTED, not degraded', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.SUCCESS, failReason: null };
  const detailResult = { requestId: 'r1', actualDestinationAmount: '24694978' };
  const result = reconcileIntentOutcome({ submittedIntent, statusResult, detailResult });
  assert.equal(result.outcome, RECONCILE_OUTCOME.FILLED_AS_QUOTED);
  assert.equal(result.degradedCandidate, false);
  assert.equal(result.deltaFromQuote, '0');
});

test('reconcileIntentOutcome: an executed amount below the quote is flagged, not silently accepted', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.SUCCESS, failReason: null };
  const detailResult = { requestId: 'r1', actualDestinationAmount: '20000000' };
  const result = reconcileIntentOutcome({ submittedIntent, statusResult, detailResult });
  assert.equal(result.outcome, RECONCILE_OUTCOME.FILLED_WITH_SHORTFALL);
  assert.equal(result.degradedCandidate, true);
  assert.equal(result.deltaFromQuote, '4694978');
});

test('reconcileIntentOutcome: a SUCCESS with no amount evidence is AMOUNT_UNCONFIRMED, never assumed to match the quote', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.SUCCESS, failReason: null };
  const result = reconcileIntentOutcome({ submittedIntent, statusResult, detailResult: null });
  assert.equal(result.outcome, RECONCILE_OUTCOME.AMOUNT_UNCONFIRMED);
  assert.equal(result.executedAmountKnown, false);
  assert.equal(result.degradedCandidate, false);
});

test('reconcileIntentOutcome: a clean FAILURE is a terminal-failure candidate, distinct from degraded', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.FAILURE, failReason: 'SOLVER_CAPACITY_EXCEEDED' };
  const result = reconcileIntentOutcome({ submittedIntent, statusResult, detailResult: null });
  assert.equal(result.outcome, RECONCILE_OUTCOME.FAILED_NO_FUNDS_MOVED);
  assert.equal(result.terminalFailureCandidate, true);
  assert.equal(result.degradedCandidate, false);
});

test(
  'a recorded partial-fill/refund fixture, run through the real parse + reconcile code path, '
    + 'produces the recordDegradedReturn-eligible signal with an exact (not estimated) refund amount',
  async () => {
    const fetchImpl = createScriptedFetch({
      'GET /chains': jsonResponse(200, chainsFixture),
      'POST /quote/v2': jsonResponse(200, quoteOutboundFixture),
      'GET /intents/status/v3': jsonResponse(200, statusRefundFixture),
      'GET /requests/v3': (url) => {
        assert.equal(url.searchParams.get('id'), quoteOutboundFixture.requestId);
        return jsonResponse(200, requestsRefundDetailFixture);
      },
    });
    const client = createRelayClient({ fetchImpl, apiKey: 'test-relay-api-key' });

    // This is the real adapter code path end to end: quote -> prepareExecution -> status ->
    // detail -> reconcile, with the two Relay responses coming straight from recorded fixture
    // bytes (test/fixtures/relay), not a hand-authored journal entry.
    const quote = await client.quoteOutboundBridge(OUTBOUND_QUOTE_INPUT);
    const prepared = client.prepareExecution({ quote, liveMode: true });
    const outcome = await client.reconcile({ intentDigest: prepared.intentDigest });

    assert.equal(outcome.status, INTENT_STATUS.REFUND);
    assert.equal(outcome.outcome, RECONCILE_OUTCOME.REFUNDED);
    assert.equal(outcome.degradedCandidate, true, 'a nonzero refund must be flagged as a recordDegradedReturn-eligible signal');
    assert.equal(outcome.terminalFailureCandidate, false);
    assert.equal(outcome.exactRefundAmount, requestsRefundDetailFixture.requests[0].data.refundCurrencyData.amount);
    assert.equal(outcome.exactRefundAmount, '24500000', 'the refund amount must be the exact recorded figure, never an estimate');
  },
);

test('reconcileIntentOutcome: a REFUND with an exact zero refund amount is a terminal-failure candidate, not degraded', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.REFUND, refundFailReason: null };
  const detailResult = { requestId: 'r1', exactRefundAmount: '0' };
  const result = reconcileIntentOutcome({ submittedIntent, statusResult, detailResult });
  assert.equal(result.outcome, RECONCILE_OUTCOME.REFUNDED);
  assert.equal(result.terminalFailureCandidate, true);
  assert.equal(result.degradedCandidate, false);
});

test('reconcileIntentOutcome: UNKNOWN status is never inferred as success or failure', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.UNKNOWN };
  const result = reconcileIntentOutcome({ submittedIntent, statusResult, detailResult: null });
  assert.equal(result.outcome, RECONCILE_OUTCOME.UNKNOWN);
  assert.equal(result.degradedCandidate, false);
  assert.equal(result.terminalFailureCandidate, false);
});

test('reconcileIntentOutcome rejects a detail response for a different requestId than the one submitted', () => {
  const submittedIntent = { requestId: 'r1', direction: DIRECTIONS.OUTBOUND, quotedDestinationAmount: '24694978' };
  const statusResult = { status: INTENT_STATUS.SUCCESS };
  const detailResult = { requestId: 'some-other-intent', actualDestinationAmount: '24694978' };
  assert.throws(
    () => reconcileIntentOutcome({ submittedIntent, statusResult, detailResult }),
    RelayIntentAuthenticationError,
  );
});

test('parseIntentDetailResponse returns null when the requestId is not present in the /requests/v3 page', () => {
  const result = parseIntentDetailResponse({ requests: [] }, { requestId: 'not-there' });
  assert.equal(result, null);
});

test('parseIntentDetailResponse extracts the exact refund amount and the quoted route from the recorded fixture', () => {
  const result = parseIntentDetailResponse(requestsRefundDetailFixture, { requestId: quoteOutboundFixture.requestId });
  assert.equal(result.exactRefundAmount, '24500000');
  assert.equal(result.quotedDestinationAmount, '24694978');
  assert.equal(result.actualDestinationAmount, null);
  assert.equal(result.failReason, 'TOO_LITTLE_RECEIVED');
});
