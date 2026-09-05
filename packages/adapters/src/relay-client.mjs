// Relay bridge provider adapter: a clean-room client for Relay's cross-chain USDG<->Circle USD
// bridge (https://api.relay.link), covering both legs the peg cycle needs:
//   OUTBOUND — Robinhood Chain (4663) USDG  -> Solana (792703809) Circle USD
//   RETURN   — Solana (792703809) Circle USD -> Robinhood Chain (4663) USDG
//
// Evidence base (R4 — every endpoint/field name below was independently re-verified against the
// live API on 2026-09-02, not assumed from prose docs):
//   - GET  /chains            — live response inspected directly; chain-level `depositEnabled`
//                                (boolean) and per-currency `supportsBridging` (erc20Currencies)
//                                confirmed present exactly as used below.
//   - POST /quote/v2          — live response inspected directly for both directions; `requestId`,
//                                `protocol.v2.orderId`, `details.currencyIn`/`currencyOut`
//                                (`amount`/`minimumAmount`/`currency.{chainId,address}`), and
//                                `steps` confirmed present exactly as used below. Error shape
//                                (`{message, errorCode}`) confirmed both live (INVALID_RECIPIENT)
//                                and via the published OpenAPI document.
//   - GET  /intents/status/v3 — live response inspected directly (`{"status":"waiting", ...}`,
//                                `{"status":"unknown"}` for a bogus/garbage requestId) and against
//                                the published OpenAPI schema (api.relay.link/documentation/json).
//                                CONFIRMED NEGATIVE FACT: this endpoint's response never carries an
//                                amount field and never echoes `requestId`/`orderId` — this changes
//                                how "authenticate the response to the submitted digest" and
//                                "compare executed vs quoted amount" must be implemented; see the
//                                module doc card (docs/modules/relay-bridge-client.md) for the full
//                                writeup of that gap and the design decision taken here instead of
//                                assuming a field that does not exist.
//   - GET  /requests/v3       — schema-verified via the published OpenAPI document only (this
//                                endpoint requires an `x-api-key` Relay has not issued this project
//                                — confirmed live: a keyless call returns
//                                `{"message":"headers must have required property 'x-api-key'"}`,
//                                matching product/SOURCE_BOUNDARY.md's "blocked on live credentials"
//                                note). `data.route.quoted`/`data.route.actual`
//                                (`.destination.outputCurrency.amount`) and
//                                `data.refundCurrencyData.amount` are the real, documented fields
//                                this adapter reads for the quote-vs-execution differential and the
//                                exact-refund amount; getIntentDetail() fails closed with
//                                RelayCredentialsRequiredError when no API key is configured, rather
//                                than silently skipping the check.
//
// This adapter never signs or broadcasts anything. `prepareExecution` (gated on `liveMode: true`)
// only returns the unsigned `steps` Relay's own quote response already carries, for an
// injected EVM/Solana policy-wallet signer (outside this package's boundary, see
// packages/adapters/README.md) to sign and broadcast. Quotes and status/detail reads are always
// real, read-only network calls — `simulateExecution` is the only "would have done X" stand-in,
// used when the caller does not want to expose the raw steps for signing.

const RELAY_BASE_URL = 'https://api.relay.link';
const ROBINHOOD_CHAIN_ID = 4663;
const SOLANA_CHAIN_ID = 792703809;
const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
// Solana asset identity is the mint address itself, never a ticker string — the mint address is
// what every equality check below (`addressEquals`) actually compares.
const CIRCLE_USD_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_TIMEOUT_MS = 15_000;
const RELAY_CHAIN_NAMES = Object.freeze({
  [ROBINHOOD_CHAIN_ID]: 'robinhood',
  [SOLANA_CHAIN_ID]: 'solana',
});

export const DIRECTIONS = Object.freeze({ OUTBOUND: 'OUTBOUND', RETURN: 'RETURN' });

const ROUTES = Object.freeze({
  [DIRECTIONS.OUTBOUND]: Object.freeze({
    origin: Object.freeze({ chainId: ROBINHOOD_CHAIN_ID, address: USDG_ADDRESS, symbol: 'USDG' }),
    destination: Object.freeze({ chainId: SOLANA_CHAIN_ID, address: CIRCLE_USD_MINT, symbol: 'CIRCLE_USD' }),
  }),
  [DIRECTIONS.RETURN]: Object.freeze({
    origin: Object.freeze({ chainId: SOLANA_CHAIN_ID, address: CIRCLE_USD_MINT, symbol: 'CIRCLE_USD' }),
    destination: Object.freeze({ chainId: ROBINHOOD_CHAIN_ID, address: USDG_ADDRESS, symbol: 'USDG' }),
  }),
});

function routeFor(direction, { originCurrency, destinationCurrency } = {}) {
  const base = ROUTES[direction];
  invariant(base !== undefined, RelayAdapterError, `Unknown bridge direction: ${direction}`);
  const configurableOrigin = base.origin.chainId === SOLANA_CHAIN_ID;
  const configurableDestination = base.destination.chainId === SOLANA_CHAIN_ID;
  invariant(
    originCurrency === undefined || configurableOrigin,
    RelayAdapterError,
    `Relay ${direction} origin currency is fixed by the bridge route`,
  );
  invariant(
    destinationCurrency === undefined || configurableDestination,
    RelayAdapterError,
    `Relay ${direction} destination currency is fixed by the bridge route`,
  );
  const applyCurrency = (leg, currency) => {
    if (currency === undefined) return leg;
    invariant(typeof currency === 'string' && currency.length > 0, RelayAdapterError, 'configured Solana mint must be a non-empty string');
    return Object.freeze({ ...leg, address: currency, symbol: 'configured Solana asset' });
  };
  return Object.freeze({
    origin: applyCurrency(base.origin, originCurrency),
    destination: applyCurrency(base.destination, destinationCurrency),
  });
}

export const INTENT_STATUS = Object.freeze({
  WAITING: 'WAITING',
  DEPOSITING: 'DEPOSITING',
  PENDING: 'PENDING',
  SUBMITTED: 'SUBMITTED',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  REFUND: 'REFUND',
  UNKNOWN: 'UNKNOWN',
});

const RAW_STATUS_MAP = Object.freeze({
  waiting: INTENT_STATUS.WAITING,
  depositing: INTENT_STATUS.DEPOSITING,
  pending: INTENT_STATUS.PENDING,
  submitted: INTENT_STATUS.SUBMITTED,
  success: INTENT_STATUS.SUCCESS,
  failure: INTENT_STATUS.FAILURE,
  refund: INTENT_STATUS.REFUND,
  unknown: INTENT_STATUS.UNKNOWN,
});
const TERMINAL_INTENT_STATUSES = new Set([
  INTENT_STATUS.SUCCESS,
  INTENT_STATUS.FAILURE,
  INTENT_STATUS.REFUND,
]);

export const RECONCILE_OUTCOME = Object.freeze({
  FILLED_AS_QUOTED: 'FILLED_AS_QUOTED',
  FILLED_WITH_SHORTFALL: 'FILLED_WITH_SHORTFALL',
  FILLED_WITH_SURPLUS: 'FILLED_WITH_SURPLUS',
  REFUNDED: 'REFUNDED',
  FAILED_NO_FUNDS_MOVED: 'FAILED_NO_FUNDS_MOVED',
  AMOUNT_UNCONFIRMED: 'AMOUNT_UNCONFIRMED',
  PENDING: 'PENDING',
  UNKNOWN: 'UNKNOWN',
});

// ---------------------------------------------------------------------------
// Typed errors — every failure mode names itself; nothing falls through to a
// generic Error a caller could mistake for a different, unrelated failure.
// ---------------------------------------------------------------------------

export class RelayAdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}

/** The HTTP request itself never completed: DNS/timeout/abort/connection reset. */
export class RelayNetworkError extends RelayAdapterError {}

/** Relay answered with a non-2xx status and a parsed `{message, errorCode}`-shaped body. */
export class RelayApiError extends RelayAdapterError {}

/** The response was reached but did not parse as JSON or did not match the expected shape. */
export class RelayMalformedResponseError extends RelayAdapterError {}

/** A currency/chain pair required for the requested direction is not bridgeable right now. */
export class RelayRouteNotEnabledError extends RelayAdapterError {}

/** `prepareExecution` was called without `liveMode: true`. */
export class RelayLiveModeRequiredError extends RelayAdapterError {}

/** Status/detail was requested for a digest this adapter instance never submitted. */
export class RelayUnknownIntentError extends RelayAdapterError {}

/** A status/detail response's chain ids do not match the intent this adapter submitted. */
export class RelayIntentAuthenticationError extends RelayAdapterError {}

/** A quote's recorded Relay order deadline has elapsed and it must not be signed. */
export class RelayQuoteExpiredError extends RelayAdapterError {}

/** `getIntentDetail` was called without a configured Relay API key. */
export class RelayCredentialsRequiredError extends RelayAdapterError {}

function invariant(condition, ErrorClass, message, details) {
  if (!condition) throw new ErrorClass(message, details);
}

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
function assertCanonicalAmount(value, label) {
  invariant(
    typeof value === 'string' && CANONICAL_DECIMAL.test(value),
    RelayMalformedResponseError,
    `${label} must be a canonical unsigned decimal integer string, got ${JSON.stringify(value)}`,
  );
  return value;
}

function addressEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // EVM checksum casing is cosmetic. Solana base58 address bytes are case-sensitive, so any
  // non-EVM comparison must preserve its exact spelling.
  if (a.startsWith('0x') && b.startsWith('0x')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function relayChainName(chainId) {
  const name = RELAY_CHAIN_NAMES[chainId];
  invariant(name !== undefined, RelayMalformedResponseError, `unsupported Relay chain id: ${chainId}`);
  return name;
}

// ---------------------------------------------------------------------------
// Low-level HTTP
// ---------------------------------------------------------------------------

function defaultFetchImpl(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function relayRequest({
  baseUrl, path, method = 'GET', query, body, apiKey, fetchImpl, timeoutMs,
}) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiKey) headers['x-api-key'] = apiKey;

  let response;
  try {
    response = await fetchImpl(
      url,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      timeoutMs,
    );
  } catch (error) {
    // Covers DNS failure, connection reset, and AbortSignal.timeout firing — every one of these
    // must surface as "the call failed", never as an empty/default success-shaped object.
    throw new RelayNetworkError(`Relay request to ${path} failed: ${error.message}`, { cause: error, path });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch (error) {
    throw new RelayMalformedResponseError(
      `Relay response for ${path} was not valid JSON (HTTP ${response.status})`,
      { httpStatus: response.status, path, bodyPreview: text.slice(0, 500) },
    );
  }

  if (!response.ok) {
    throw new RelayApiError(
      `Relay ${path} returned HTTP ${response.status}${parsed?.message ? `: ${parsed.message}` : ''}`,
      { httpStatus: response.status, errorCode: parsed?.errorCode ?? null, relayMessage: parsed?.message ?? null, path, raw: parsed },
    );
  }

  invariant(
    parsed !== null && typeof parsed === 'object',
    RelayMalformedResponseError,
    `Relay response for ${path} was not a JSON object`,
    { httpStatus: response.status, path },
  );
  return parsed;
}

// ---------------------------------------------------------------------------
// /chains — depositEnabled + supportsBridging gate, checked before every quote
// ---------------------------------------------------------------------------

function findChain(chainsResponse, chainId) {
  const chains = Array.isArray(chainsResponse?.chains) ? chainsResponse.chains : null;
  invariant(chains !== null, RelayMalformedResponseError, "Relay /chains response is missing a 'chains' array");
  return chains.find((chain) => Number(chain?.id) === chainId) ?? null;
}

function currencyBridgingEnabled(chain, address) {
  if (!chain) return false;
  const inErc20 = Array.isArray(chain.erc20Currencies)
    ? chain.erc20Currencies.some((c) => addressEquals(c?.address, address) && c?.supportsBridging !== false)
    : false;
  if (inErc20) return true;
  // solverCurrencies entries carry no supportsBridging field of their own (verified live); presence
  // there means the solver itself accepts the currency, which is sufficient on its own.
  return Array.isArray(chain.solverCurrencies)
    ? chain.solverCurrencies.some((c) => addressEquals(c?.address, address))
    : false;
}

/**
 * Checks that both legs of `direction` are currently bridgeable, using only /chains fields
 * confirmed live: chain-level `depositEnabled` and per-currency `supportsBridging`/presence.
 * Never trusts a quote without this passing first.
 */
export function assertRouteEnabled({ direction, chainsResponse, originCurrency, destinationCurrency }) {
  const route = routeFor(direction, { originCurrency, destinationCurrency });

  const originChain = findChain(chainsResponse, route.origin.chainId);
  const destinationChain = findChain(chainsResponse, route.destination.chainId);

  const checks = {
    originChainListed: originChain !== null,
    originChainDepositEnabled: originChain?.depositEnabled === true,
    originCurrencyBridgingEnabled: currencyBridgingEnabled(originChain, route.origin.address),
    destinationChainListed: destinationChain !== null,
    destinationChainDepositEnabled: destinationChain?.depositEnabled === true,
    destinationCurrencyBridgingEnabled: currencyBridgingEnabled(destinationChain, route.destination.address),
  };
  const passed = Object.values(checks).every(Boolean);
  invariant(
    passed,
    RelayRouteNotEnabledError,
    `Relay route ${direction} (${route.origin.symbol}@${route.origin.chainId} -> `
      + `${route.destination.symbol}@${route.destination.chainId}) is not fully enabled right now`,
    { direction, checks },
  );
  return { direction, origin: route.origin, destination: route.destination, checks };
}

// ---------------------------------------------------------------------------
// /quote/v2
// ---------------------------------------------------------------------------

function currencyLegFromDetails(leg, label) {
  invariant(leg && typeof leg === 'object', RelayMalformedResponseError, `quote response is missing ${label}`);
  const currency = leg.currency;
  invariant(currency && typeof currency === 'object', RelayMalformedResponseError, `${label}.currency is missing`);
  invariant(Number.isInteger(currency.decimals) && currency.decimals >= 0, RelayMalformedResponseError, `${label}.currency.decimals is invalid`);
  return {
    chainId: Number(currency.chainId),
    address: currency.address,
    symbol: currency.symbol ?? null,
    decimals: currency.decimals,
    amount: assertCanonicalAmount(leg.amount, `${label}.amount`),
    amountFormatted: leg.amountFormatted ?? null,
    minimumAmount: leg.minimumAmount != null ? assertCanonicalAmount(leg.minimumAmount, `${label}.minimumAmount`) : null,
  };
}

function assertPositiveUnixSeconds(value, label) {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    RelayMalformedResponseError,
    `${label} must be a positive Unix-seconds integer`,
  );
  return value;
}

function assertQuoteIdentity(raw, { direction, origin, destination, user, recipient, amount }) {
  const sender = raw?.details?.sender;
  const quotedRecipient = raw?.details?.recipient;
  invariant(typeof sender === 'string' && sender.length > 0, RelayMalformedResponseError, 'quote response is missing details.sender');
  invariant(typeof quotedRecipient === 'string' && quotedRecipient.length > 0, RelayMalformedResponseError, 'quote response is missing details.recipient');

  if (user !== undefined) {
    invariant(
      addressEquals(sender, user),
      RelayMalformedResponseError,
      'quote response details.sender does not match the requested user',
      { expected: user, got: sender },
    );
  }
  if (recipient !== undefined) {
    invariant(
      addressEquals(quotedRecipient, recipient),
      RelayMalformedResponseError,
      'quote response details.recipient does not match the requested recipient',
      { expected: recipient, got: quotedRecipient },
    );
  }
  if (amount !== undefined) {
    invariant(
      origin.amount === amount,
      RelayMalformedResponseError,
      'quote response details.currencyIn.amount does not match the requested amount',
      { expected: amount, got: origin.amount },
    );
  }

  const orderId = raw?.protocol?.v2?.orderId;
  invariant(typeof orderId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(orderId), RelayMalformedResponseError, 'quote response is missing a valid protocol.v2.orderId');
  const orderData = raw?.protocol?.v2?.orderData;
  invariant(orderData && typeof orderData === 'object', RelayMalformedResponseError, 'quote response is missing protocol.v2.orderData');
  const deadlineUnixSeconds = assertPositiveUnixSeconds(orderData?.output?.deadline, 'protocol.v2.orderData.output.deadline');
  invariant(
    orderData.output.chainId === relayChainName(destination.chainId),
    RelayMalformedResponseError,
    'quote response order output chain does not match the destination route',
  );
  invariant(
    Array.isArray(orderData.output.calls) && orderData.output.calls.length === 0,
    RelayMalformedResponseError,
    'quote response order output contains unsupported destination calls',
  );
  const payments = orderData?.output?.payments;
  invariant(Array.isArray(payments) && payments.length > 0, RelayMalformedResponseError, 'quote response is missing protocol.v2.orderData.output.payments');
  invariant(
    payments.length === 1
      && addressEquals(payments[0]?.recipient, quotedRecipient)
      && addressEquals(payments[0]?.currency, destination.address)
      && payments[0]?.expectedAmount === destination.amount
      && payments[0]?.minimumAmount === destination.minimumAmount,
    RelayMalformedResponseError,
    'quote response order output does not exactly bind the displayed destination amount, mint, and recipient',
  );
  const inputs = orderData?.inputs;
  invariant(Array.isArray(inputs) && inputs.length > 0, RelayMalformedResponseError, 'quote response is missing protocol.v2.orderData.inputs');
  invariant(
    inputs.length === 1
      && inputs[0]?.payment?.chainId === relayChainName(origin.chainId)
      && addressEquals(inputs[0]?.payment?.currency, origin.address)
      && inputs[0]?.payment?.amount === origin.amount,
    RelayMalformedResponseError,
    'quote response order input does not exactly bind the displayed origin amount and asset',
  );
  const refunds = inputs[0].refunds;
  invariant(Array.isArray(refunds) && refunds.length > 0, RelayMalformedResponseError, 'quote response order input is missing refunds');
  let originRefundCount = 0;
  for (const refund of refunds) {
    if (addressEquals(refund?.currency, origin.address)) {
      originRefundCount += 1;
      invariant(
        refund?.chainId === relayChainName(origin.chainId)
          && addressEquals(refund?.recipient, sender)
          && assertPositiveUnixSeconds(refund?.deadline, 'protocol.v2.orderData.inputs[].refunds[].deadline') === deadlineUnixSeconds,
        RelayMalformedResponseError,
        'quote response does not bind an origin-asset refund to the sender, source chain, and order deadline',
      );
      continue;
    }
    invariant(
      refund?.chainId === relayChainName(destination.chainId)
        && addressEquals(refund?.currency, destination.address)
        && addressEquals(refund?.recipient, quotedRecipient)
        && assertPositiveUnixSeconds(refund?.deadline, 'protocol.v2.orderData.inputs[].refunds[].deadline') === deadlineUnixSeconds,
      RelayMalformedResponseError,
      'quote response includes a refund asset, recipient, chain, or deadline outside the bound bridge route',
    );
  }
  invariant(originRefundCount === 1, RelayMalformedResponseError, 'quote response must bind exactly one origin-asset refund to the sender');
  return Object.freeze({ sender, recipient: quotedRecipient, orderId, deadlineUnixSeconds });
}

/**
 * Parses a raw POST /quote/v2 response into a typed QuoteResult, verifying the response actually
 * quotes the route that was requested (defends against a proxy/cache/mock returning a
 * differently-shaped route, which "loosely matched by chain/asset/amount alone" would miss).
 */
export function parseQuoteResponse(raw, {
  direction, user, recipient, amount, originCurrency, destinationCurrency,
} = {}) {
  const route = routeFor(direction, { originCurrency, destinationCurrency });
  invariant(typeof raw?.requestId === 'string' && raw.requestId.length > 0, RelayMalformedResponseError, 'quote response is missing requestId');
  invariant(Array.isArray(raw?.steps), RelayMalformedResponseError, 'quote response is missing a steps array');

  const origin = currencyLegFromDetails(raw?.details?.currencyIn, 'details.currencyIn');
  const destination = currencyLegFromDetails(raw?.details?.currencyOut, 'details.currencyOut');

  invariant(
    origin.chainId === route.origin.chainId && addressEquals(origin.address, route.origin.address),
    RelayMalformedResponseError,
    `quote response's origin currency does not match the requested ${direction} route`,
    { expected: route.origin, got: origin },
  );
  invariant(
    destination.chainId === route.destination.chainId && addressEquals(destination.address, route.destination.address),
    RelayMalformedResponseError,
    `quote response's destination currency does not match the requested ${direction} route`,
    { expected: route.destination, got: destination },
  );

  const identity = assertQuoteIdentity(raw, { direction, origin, destination, user, recipient, amount });
  return Object.freeze({
    direction,
    requestId: raw.requestId,
    orderId: identity.orderId,
    sender: identity.sender,
    recipient: identity.recipient,
    deadlineUnixSeconds: identity.deadlineUnixSeconds,
    origin: Object.freeze(origin),
    destination: Object.freeze(destination),
    stepCount: raw.steps.length,
    raw,
  });
}

/** Refuses a quote at its exact deadline; callers must obtain a fresh quote from the same reserve. */
export function assertQuoteUsable({ quote, nowMs = Date.now() }) {
  invariant(quote && typeof quote === 'object', RelayAdapterError, 'quote is required');
  invariant(Number.isSafeInteger(nowMs) && nowMs >= 0, RelayAdapterError, 'nowMs must be a non-negative safe integer');
  const deadlineUnixSeconds = assertPositiveUnixSeconds(quote.deadlineUnixSeconds, 'quote.deadlineUnixSeconds');
  const deadlineMs = deadlineUnixSeconds * 1000;
  if (nowMs >= deadlineMs) {
    throw new RelayQuoteExpiredError(
      `Relay quote ${quote.requestId ?? '(unknown)'} expired at ${deadlineUnixSeconds}`,
      { requestId: quote.requestId ?? null, deadlineUnixSeconds, nowMs },
    );
  }
  return Object.freeze({ deadlineUnixSeconds, remainingMs: deadlineMs - nowMs });
}

const RELAY_INTENT_KEYS = Object.freeze([
  'schema',
  'requestId',
  'orderId',
  'direction',
  'originChainId',
  'destinationChainId',
  'originAssetId',
  'originDecimals',
  'destinationAssetId',
  'destinationDecimals',
  'originAmount',
  'quotedDestinationAmount',
  'quotedDestinationMinimumAmount',
  'sender',
  'recipient',
  'deadlineUnixSeconds',
]);

function assertRelayIntent(value, label = 'Relay intent') {
  invariant(value && typeof value === 'object' && !Array.isArray(value), RelayMalformedResponseError, `${label} must be an object`);
  const keys = Object.keys(value).sort();
  const expectedKeys = [...RELAY_INTENT_KEYS].sort();
  invariant(
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]),
    RelayMalformedResponseError,
    `${label} has an invalid shape`,
  );
  invariant(value.schema === 'hookemon.relay-intent.v1', RelayMalformedResponseError, `${label} schema is invalid`);
  invariant(typeof value.requestId === 'string' && value.requestId.length > 0, RelayMalformedResponseError, `${label}.requestId is invalid`);
  invariant(typeof value.orderId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value.orderId), RelayMalformedResponseError, `${label}.orderId is invalid`);
  const route = ROUTES[value.direction];
  invariant(route !== undefined, RelayMalformedResponseError, `${label}.direction is invalid`);
  invariant(value.originChainId === route.origin.chainId, RelayMalformedResponseError, `${label}.originChainId does not match its direction`);
  invariant(value.destinationChainId === route.destination.chainId, RelayMalformedResponseError, `${label}.destinationChainId does not match its direction`);
  invariant(typeof value.originAssetId === 'string' && value.originAssetId.length > 0, RelayMalformedResponseError, `${label}.originAssetId is invalid`);
  invariant(typeof value.destinationAssetId === 'string' && value.destinationAssetId.length > 0, RelayMalformedResponseError, `${label}.destinationAssetId is invalid`);
  invariant(Number.isInteger(value.originDecimals) && value.originDecimals >= 0, RelayMalformedResponseError, `${label}.originDecimals is invalid`);
  invariant(Number.isInteger(value.destinationDecimals) && value.destinationDecimals >= 0, RelayMalformedResponseError, `${label}.destinationDecimals is invalid`);
  if (route.origin.chainId !== SOLANA_CHAIN_ID) {
    invariant(addressEquals(value.originAssetId, route.origin.address), RelayMalformedResponseError, `${label}.originAssetId is not the fixed route asset`);
  }
  if (route.destination.chainId !== SOLANA_CHAIN_ID) {
    invariant(addressEquals(value.destinationAssetId, route.destination.address), RelayMalformedResponseError, `${label}.destinationAssetId is not the fixed route asset`);
  }
  assertCanonicalAmount(value.originAmount, `${label}.originAmount`);
  assertCanonicalAmount(value.quotedDestinationAmount, `${label}.quotedDestinationAmount`);
  if (value.quotedDestinationMinimumAmount !== null) {
    assertCanonicalAmount(value.quotedDestinationMinimumAmount, `${label}.quotedDestinationMinimumAmount`);
  }
  invariant(typeof value.sender === 'string' && value.sender.length > 0, RelayMalformedResponseError, `${label}.sender is invalid`);
  invariant(typeof value.recipient === 'string' && value.recipient.length > 0, RelayMalformedResponseError, `${label}.recipient is invalid`);
  assertPositiveUnixSeconds(value.deadlineUnixSeconds, `${label}.deadlineUnixSeconds`);
  return Object.freeze({ ...value });
}

function canonicalIntentEquals(left, right) {
  return RELAY_INTENT_KEYS.every(key => left[key] === right[key]);
}

// ---------------------------------------------------------------------------
// /intents/status/v3
// ---------------------------------------------------------------------------

/**
 * Parses a raw GET /intents/status/v3 response. This endpoint (verified live and against Relay's
 * published OpenAPI schema) never echoes requestId/orderId and never carries an amount — callers
 * must correlate it to a submitted intent by the digest they queried it with, not by anything in
 * the body itself.
 */
export function parseIntentStatusResponse(raw) {
  invariant(raw && typeof raw === 'object', RelayMalformedResponseError, 'intent status response is not an object');
  const rawStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : null;
  const status = rawStatus !== null ? RAW_STATUS_MAP[rawStatus] : undefined;
  invariant(status !== undefined, RelayMalformedResponseError, `intent status response has an unrecognized status: ${JSON.stringify(raw.status)}`, { raw });
  return Object.freeze({
    status,
    originChainId: raw.originChainId != null ? Number(raw.originChainId) : null,
    destinationChainId: raw.destinationChainId != null ? Number(raw.destinationChainId) : null,
    inTxHashes: Array.isArray(raw.inTxHashes) ? raw.inTxHashes : [],
    txHashes: Array.isArray(raw.txHashes) ? raw.txHashes : [],
    failReason: raw.failReason ?? null,
    refundFailReason: raw.refundFailReason ?? null,
    updatedAt: raw.updatedAt ?? null,
    quoteCreatedAt: raw.quoteCreatedAt ?? null,
    raw,
  });
}

// ---------------------------------------------------------------------------
// /requests/v3 — the quote-vs-execution differential and the exact refund amount
// ---------------------------------------------------------------------------

function optionalAmount(leg) {
  if (leg == null || leg.amount == null) return null;
  return assertCanonicalAmount(leg.amount, 'requests/v3 route leg amount');
}

/**
 * Parses one record from a raw GET /requests/v3 response (`{requests: [...]}`), matched by
 * `requestId`. Returns null when the requestId is not present in the response (nothing to parse
 * — never fabricated).
 */
export function parseIntentDetailResponse(raw, { requestId }) {
  invariant(Array.isArray(raw?.requests), RelayMalformedResponseError, "requests/v3 response is missing a 'requests' array");
  const record = raw.requests.find((entry) => entry?.id === requestId);
  if (!record) return null;

  const data = record.data ?? {};
  const route = data.route ?? {};
  const quotedDestination = optionalAmount(route.quoted?.destination?.outputCurrency);
  const actualDestination = optionalAmount(route.actual?.destination?.outputCurrency);
  const refundCurrencyData = data.refundCurrencyData ?? null;

  return Object.freeze({
    requestId: record.id,
    orderId: record.protocol?.v2?.orderId ?? null,
    status: RAW_STATUS_MAP[typeof record.status === 'string' ? record.status.toLowerCase() : ''] ?? INTENT_STATUS.UNKNOWN,
    quotedDestinationAmount: quotedDestination,
    actualDestinationAmount: actualDestination,
    exactRefundAmount: refundCurrencyData?.amount != null ? assertCanonicalAmount(refundCurrencyData.amount, 'refundCurrencyData.amount') : null,
    failReason: data.failReason ?? null,
    refundFailReason: data.refundFailReason ?? null,
    raw: record,
  });
}

// ---------------------------------------------------------------------------
// Reconciliation — the recordDegradedReturn-eligible signal
// ---------------------------------------------------------------------------

/**
 * Pure reconciliation: given what this adapter itself submitted (`submittedIntent`, produced by
 * `prepareExecution`) and Relay's own status/detail responses, decides whether the bridge leg
 * completed as quoted, needs to be flagged as an ambiguous/short "degraded" return, or is a clean
 * zero-funds-moved failure. This function does not read chain state itself (the vault escrow's
 * live balance, per the design's §2.4 step 8, is the actual finalized fact for the on-chain
 * decision) — it produces the Relay-side evidence that decision consumes, never a silent
 * assumption that a Relay "success" equals "delivered exactly as quoted".
 *
 * `detailResult` is optional (it requires a Relay API key this project may not have — see
 * getIntentDetail); when absent for a SUCCESS status, the amount is honestly reported as unknown
 * (AMOUNT_UNCONFIRMED) rather than assumed equal to the quote.
 */
export function reconcileIntentOutcome({ submittedIntent, statusResult, detailResult = null }) {
  invariant(submittedIntent && typeof submittedIntent === 'object', RelayAdapterError, 'submittedIntent is required');
  invariant(statusResult && typeof statusResult === 'object', RelayAdapterError, 'statusResult is required');
  if (detailResult && detailResult.requestId !== submittedIntent.requestId) {
    throw new RelayIntentAuthenticationError(
      'detailResult.requestId does not match the intent this adapter submitted',
      { expected: submittedIntent.requestId, got: detailResult.requestId },
    );
  }

  const quotedAmount = BigInt(assertCanonicalAmount(submittedIntent.quotedDestinationAmount, 'submittedIntent.quotedDestinationAmount'));
  const base = {
    intentDigest: submittedIntent.requestId,
    direction: submittedIntent.direction,
    status: statusResult.status,
    quotedAmount: quotedAmount.toString(),
  };

  switch (statusResult.status) {
    case INTENT_STATUS.SUCCESS: {
      const actual = detailResult?.actualDestinationAmount ?? null;
      if (actual === null) {
        return Object.freeze({
          ...base, outcome: RECONCILE_OUTCOME.AMOUNT_UNCONFIRMED, executedAmount: null, executedAmountKnown: false,
          deltaFromQuote: null, exactRefundAmount: null, degradedCandidate: false, terminalFailureCandidate: false,
          reason: 'Relay reports success but no executed-amount evidence (Relay API key) was available to confirm the actual delivered amount; do not treat this as a confirmed clean fill.',
        });
      }
      const executed = BigInt(actual);
      const delta = quotedAmount - executed; // positive => shortfall, negative => surplus
      const outcome = delta === 0n
        ? RECONCILE_OUTCOME.FILLED_AS_QUOTED
        : delta > 0n ? RECONCILE_OUTCOME.FILLED_WITH_SHORTFALL : RECONCILE_OUTCOME.FILLED_WITH_SURPLUS;
      return Object.freeze({
        ...base, outcome, executedAmount: executed.toString(), executedAmountKnown: true,
        deltaFromQuote: delta.toString(), exactRefundAmount: null,
        degradedCandidate: outcome === RECONCILE_OUTCOME.FILLED_WITH_SHORTFALL,
        terminalFailureCandidate: false,
        reason: outcome === RECONCILE_OUTCOME.FILLED_AS_QUOTED
          ? 'Executed amount matches the quote exactly.'
          : `Executed amount differs from the quote by ${delta.toString()} (positive = shortfall).`,
      });
    }
    case INTENT_STATUS.REFUND: {
      const exactRefundAmount = detailResult?.exactRefundAmount ?? null;
      const isZeroRefund = exactRefundAmount !== null && BigInt(exactRefundAmount) === 0n;
      return Object.freeze({
        ...base, outcome: RECONCILE_OUTCOME.REFUNDED, executedAmount: null, executedAmountKnown: false,
        deltaFromQuote: null, exactRefundAmount,
        degradedCandidate: !isZeroRefund,
        terminalFailureCandidate: isZeroRefund,
        reason: exactRefundAmount !== null
          ? `Relay refunded exactly ${exactRefundAmount} on the origin chain instead of delivering to the destination.`
          : 'Relay reports a refund but no exact refund amount evidence (Relay API key) was available.',
      });
    }
    case INTENT_STATUS.FAILURE: {
      return Object.freeze({
        ...base, outcome: RECONCILE_OUTCOME.FAILED_NO_FUNDS_MOVED, executedAmount: null, executedAmountKnown: false,
        deltaFromQuote: null, exactRefundAmount: null, degradedCandidate: false, terminalFailureCandidate: true,
        reason: `Relay reports a clean failure (failReason=${statusResult.failReason ?? 'unknown'}); no funds should have moved.`,
      });
    }
    case INTENT_STATUS.UNKNOWN: {
      return Object.freeze({
        ...base, outcome: RECONCILE_OUTCOME.UNKNOWN, executedAmount: null, executedAmountKnown: false,
        deltaFromQuote: null, exactRefundAmount: null, degradedCandidate: false, terminalFailureCandidate: false,
        reason: 'Relay has no record of this intent digest; this must never be inferred as either success or failure.',
      });
    }
    default: {
      return Object.freeze({
        ...base, outcome: RECONCILE_OUTCOME.PENDING, executedAmount: null, executedAmountKnown: false,
        deltaFromQuote: null, exactRefundAmount: null, degradedCandidate: false, terminalFailureCandidate: false,
        reason: `Relay reports ${statusResult.status}; the intent has not resolved yet.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Creates a Relay bridge client. Every network call is real and read-only except
 * `prepareExecution`, which is gated on `liveMode: true` and never itself signs or broadcasts —
 * it only releases the unsigned steps Relay's own quote already returned, for an injected signer
 * elsewhere to act on.
 */
export function createRelayClient({
  baseUrl = RELAY_BASE_URL,
  apiKey = null,
  fetchImpl = defaultFetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // Keyed by requestId (Relay's own intent identifier). Recorded only by prepareExecution, so
  // getIntentStatus/getIntentDetail can never be asked to authenticate a digest this adapter
  // instance did not itself submit.
  const submittedIntents = new Map();

  async function getChains() {
    return relayRequest({ baseUrl, path: '/chains', fetchImpl, timeoutMs });
  }

  async function quote({
    direction, amount, user, recipient, originCurrency, destinationCurrency, tradeType = 'EXACT_INPUT', referrer, slippageTolerance, skipRouteCheck = false,
  }) {
    const route = routeFor(direction, { originCurrency, destinationCurrency });
    invariant(typeof user === 'string' && user.length > 0, RelayAdapterError, 'user is required');
    assertCanonicalAmount(amount, 'amount');

    if (!skipRouteCheck) {
      const chainsResponse = await getChains();
      assertRouteEnabled({ direction, chainsResponse, originCurrency, destinationCurrency });
    }

    const body = {
      user,
      originChainId: route.origin.chainId,
      originCurrency: route.origin.address,
      destinationChainId: route.destination.chainId,
      destinationCurrency: route.destination.address,
      recipient: recipient ?? user,
      amount,
      tradeType,
      ...(referrer ? { referrer } : {}),
      ...(slippageTolerance ? { slippageTolerance } : {}),
    };
    const raw = await relayRequest({ baseUrl, path: '/quote/v2', method: 'POST', body, fetchImpl, timeoutMs });
    return parseQuoteResponse(raw, {
      direction,
      user,
      recipient: body.recipient,
      amount,
      originCurrency,
      destinationCurrency,
    });
  }

  function quoteOutboundBridge(params) {
    return quote({ ...params, direction: DIRECTIONS.OUTBOUND });
  }

  function quoteReturnBridge(params) {
    return quote({ ...params, direction: DIRECTIONS.RETURN });
  }

  /** Always allowed, never mutates anything: the structured "would have executed X" record. */
  function simulateExecution({ quote: quoteResult }) {
    invariant(quoteResult?.requestId, RelayAdapterError, 'a QuoteResult (from quote/quoteOutboundBridge/quoteReturnBridge) is required');
    return Object.freeze({
      wouldExecute: true,
      liveMode: false,
      direction: quoteResult.direction,
      requestId: quoteResult.requestId,
      quotedDestinationAmount: quoteResult.destination.amount,
      stepCount: quoteResult.stepCount,
    });
  }

  /**
   * Releases the unsigned steps for signing, and records the submission so getIntentStatus /
   * getIntentDetail can later authenticate their responses to it. Refuses outright unless
   * `liveMode: true` is passed explicitly — there is no default that lets a caller drift into a
   * live submission.
   */
  function prepareExecution({ quote: quoteResult, liveMode }) {
    if (liveMode !== true) {
      throw new RelayLiveModeRequiredError(
        'Relay execution refused: liveMode must be explicitly true. Call simulateExecution() for a dry-run preview.',
      );
    }
    invariant(quoteResult?.requestId, RelayAdapterError, 'a QuoteResult (from quote/quoteOutboundBridge/quoteReturnBridge) is required');

    const record = assertRelayIntent({
      schema: 'hookemon.relay-intent.v1',
      requestId: quoteResult.requestId,
      orderId: quoteResult.orderId,
      direction: quoteResult.direction,
      originChainId: quoteResult.origin.chainId,
      destinationChainId: quoteResult.destination.chainId,
      originAssetId: quoteResult.origin.address,
      originDecimals: quoteResult.origin.decimals,
      destinationAssetId: quoteResult.destination.address,
      destinationDecimals: quoteResult.destination.decimals,
      originAmount: quoteResult.origin.amount,
      quotedDestinationAmount: quoteResult.destination.amount,
      quotedDestinationMinimumAmount: quoteResult.destination.minimumAmount,
      sender: quoteResult.sender,
      recipient: quoteResult.recipient,
      deadlineUnixSeconds: quoteResult.deadlineUnixSeconds,
    });
    submittedIntents.set(record.requestId, record);
    return Object.freeze({
      intentDigest: record.requestId,
      orderId: record.orderId,
      direction: record.direction,
      liveMode: true,
      steps: quoteResult.raw.steps,
      intent: record,
    });
  }

  function restoreIntent({ intent }) {
    const restored = assertRelayIntent(intent, 'persisted Relay intent');
    const existing = submittedIntents.get(restored.requestId);
    if (existing) {
      invariant(
        canonicalIntentEquals(existing, restored),
        RelayIntentAuthenticationError,
        `persisted Relay intent ${restored.requestId} conflicts with the in-memory intent`,
      );
      return existing;
    }
    submittedIntents.set(restored.requestId, restored);
    return restored;
  }

  function requireSubmitted(intentDigest) {
    const submitted = submittedIntents.get(intentDigest);
    invariant(
      submitted !== undefined,
      RelayUnknownIntentError,
      `No intent with digest ${intentDigest} was submitted by this adapter instance; status/detail may only be `
        + 'queried for a digest this adapter itself produced via prepareExecution — never a caller-supplied value '
        + 'matched loosely by chain/asset/amount.',
      { intentDigest },
    );
    return submitted;
  }

  function authenticateChainIds(submitted, result, label) {
    if (TERMINAL_INTENT_STATUSES.has(result.status)
      && (result.originChainId === null || result.destinationChainId === null)) {
      throw new RelayIntentAuthenticationError(
        `${label} terminal response is missing the route chain identities required for settlement reconciliation`,
        { expectedOriginChainId: submitted.originChainId, expectedDestinationChainId: submitted.destinationChainId },
      );
    }
    if (result.originChainId !== null && result.originChainId !== submitted.originChainId) {
      throw new RelayIntentAuthenticationError(
        `${label} originChainId does not match the intent this adapter submitted`,
        { expected: submitted.originChainId, got: result.originChainId },
      );
    }
    if (result.destinationChainId !== null && result.destinationChainId !== submitted.destinationChainId) {
      throw new RelayIntentAuthenticationError(
        `${label} destinationChainId does not match the intent this adapter submitted`,
        { expected: submitted.destinationChainId, got: result.destinationChainId },
      );
    }
  }

  async function getIntentStatus({ intentDigest }) {
    const submitted = requireSubmitted(intentDigest);
    const raw = await relayRequest({
      baseUrl, path: '/intents/status/v3', query: { requestId: intentDigest }, fetchImpl, timeoutMs,
    });
    const result = parseIntentStatusResponse(raw);
    authenticateChainIds(submitted, result, '/intents/status/v3 response');
    return { ...result, intentDigest };
  }

  /**
   * Returns Relay's terminal destination hash only as a pointer for a separate process-RPC
   * receipt read. It intentionally contains no amount or settlement conclusion.
   */
  async function getTerminalDestinationTransactionPointer({ intentDigest }) {
    const submitted = requireSubmitted(intentDigest);
    invariant(
      submitted.direction === DIRECTIONS.RETURN,
      RelayIntentAuthenticationError,
      'a terminal destination transaction pointer is available only for a RETURN Relay intent',
    );
    const status = await getIntentStatus({ intentDigest });
    if (status.status !== INTENT_STATUS.SUCCESS) return null;
    invariant(
      Array.isArray(status.txHashes) && status.txHashes.length === 1,
      RelayMalformedResponseError,
      'a successful return status must report exactly one destination transaction hash pointer',
    );
    const destinationTxHash = status.txHashes[0];
    invariant(
      typeof destinationTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(destinationTxHash),
      RelayMalformedResponseError,
      'a successful return status reported an invalid destination transaction hash pointer',
    );
    return Object.freeze({
      schema: 'hookemon.relay-terminal-destination-pointer.v1',
      relayRequestId: submitted.requestId,
      status: INTENT_STATUS.SUCCESS,
      destinationTxHash: destinationTxHash.toLowerCase(),
    });
  }

  /**
   * Returns an outbound refund hash only as a request-bound pointer for a separate process-RPC
   * receipt read. The status supplies neither a balance delta nor settlement evidence.
   */
  async function getTerminalOriginRefundTransactionPointer({ intentDigest }) {
    const submitted = requireSubmitted(intentDigest);
    invariant(
      submitted.direction === DIRECTIONS.OUTBOUND,
      RelayIntentAuthenticationError,
      'an origin refund transaction pointer is available only for an OUTBOUND Relay intent',
    );
    const status = await getIntentStatus({ intentDigest });
    if (status.status !== INTENT_STATUS.REFUND) return null;
    invariant(
      Array.isArray(status.txHashes) && status.txHashes.length === 1,
      RelayMalformedResponseError,
      'a refunded outbound status must report exactly one origin refund transaction hash pointer',
    );
    const refundTxHash = status.txHashes[0];
    invariant(
      typeof refundTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(refundTxHash),
      RelayMalformedResponseError,
      'a refunded outbound status has an invalid origin refund transaction hash pointer',
    );
    return Object.freeze({
      schema: 'hookemon.relay-terminal-origin-refund-pointer.v1',
      relayRequestId: submitted.requestId,
      status: INTENT_STATUS.REFUND,
      refundTxHash: refundTxHash.toLowerCase(),
    });
  }

  async function getIntentDetail({ intentDigest }) {
    invariant(
      typeof apiKey === 'string' && apiKey.length > 0,
      RelayCredentialsRequiredError,
      'GET /requests/v3 requires a Relay API key; none is configured for this client. '
        + 'See product/SOURCE_BOUNDARY.md — this is a recorded external-readiness blocker, not a bug.',
    );
    requireSubmitted(intentDigest);
    const raw = await relayRequest({
      baseUrl, path: '/requests/v3', query: { id: intentDigest }, apiKey, fetchImpl, timeoutMs,
    });
    return parseIntentDetailResponse(raw, { requestId: intentDigest });
  }

  async function reconcile({ intentDigest, statusResult, detailResult }) {
    const submitted = requireSubmitted(intentDigest);
    const status = statusResult ?? await getIntentStatus({ intentDigest });
    let detail = detailResult;
    if (detail === undefined && typeof apiKey === 'string' && apiKey.length > 0) {
      detail = await getIntentDetail({ intentDigest });
    }
    return reconcileIntentOutcome({ submittedIntent: submitted, statusResult: status, detailResult: detail ?? null });
  }

  return Object.freeze({
    getChains,
    quote,
    quoteOutboundBridge,
    quoteReturnBridge,
    simulateExecution,
    prepareExecution,
    restoreIntent,
    getIntentStatus,
    getTerminalDestinationTransactionPointer,
    getTerminalOriginRefundTransactionPointer,
    getIntentDetail,
    reconcile,
  });
}

export const RELAY_CONSTANTS = Object.freeze({
  RELAY_BASE_URL,
  ROBINHOOD_CHAIN_ID,
  SOLANA_CHAIN_ID,
  USDG_ADDRESS,
  CIRCLE_USD_MINT,
  ROUTES,
});
