// Clean-room client for the real Collector Crypt gacha API (https://gacha.collectorcrypt.com).
//
// Implemented strictly from docs.collectorcrypt.com/gacha/api (fetched live 2026-09-02); no
// historical implementation was consulted (product/SOURCE_BOUNDARY.md). Covers the documented
// endpoints WP-08 names (GET /api/machines, POST /api/generatePack, POST /api/openPack,
// GET /api/buyback/available, GET /api/buyback/check, POST /api/buyback,
// POST /api/submitTransaction, GET /api/pack/status) plus the read-only GET /api/status the
// design's smoke test also names.
//
// Every request — GET included — carries the x-api-key header, per the documented requirement
// ("Each request to the API must include a valid x-api-key header"), even though some GET
// endpoints currently accept unauthenticated calls.
//
// UNVERIFIED (AGENTS.md R4, evidence first on money-relevant claims): the Solana API
// documentation does not establish server-side idempotency for generatePack/openPack/buyback/
// submitTransaction. The EVM API says that calling openPack twice returns the same award, but it
// does not establish a Solana retry contract. No idempotency-key header or provider request
// deduplication behavior is documented for the Solana mutation endpoints.
// The `x-idempotency-key` header this client sends (`computeCollectorCryptRequestDigest`, reusing
// the runner's canonical `digest()` from packages/runner/src/cycle/journal.mjs, the same
// sha256-over-canonical-JSON primitive `requestDigest` fields use elsewhere in the
// journal/reducer/operator-control code) is therefore a CLIENT-ONLY, BEST-EFFORT construct with
// no confirmed provider-side support: sending an unrecognized header changes nothing server-side.
// Concretely:
//   - it gives a byte-identical retry a stable key (useful if the provider ever adds real
//     server-side dedup) and it lets two in-process-overlapping calls for the same logical
//     mutation collapse into one network request (the `pendingMutations` map below) instead of
//     two;
//   - it does NOT protect against the classic lost-response case: the provider receives and
//     fully processes a mutation (for example, purchases a pack with the Solana stablecoin) but the
//     HTTP response is lost before the client observes it (timeout, gateway reset, etc). Because
//     there is no confirmed provider-side guard, retrying in that case would be a genuine second
//     POST that can execute the mutation twice.
// For that reason `postMutation` does NOT auto-retry a thrown network error the way GET calls do
// (see `retryOnNetworkError` below) — a network failure on a mutation throws immediately, once,
// and it is on the caller to reconcile actual provider state (e.g. via `getPackStatus` /
// `getBuybackAvailable`) before deciding whether it is safe to call the mutation again. A mutation
// HTTP response with a 5xx code is also ambiguous: it can arrive after the provider committed an
// effect. It is surfaced once so the durable stage journal can reconcile instead of issuing a
// second mutation.

import { digest } from '../../runner/src/cycle/journal.mjs';
import { assertTypedAmount } from '../../runner/src/cycle/money-schemas.mjs';
import { CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT } from './solana-rpc.mjs';

export const DEFAULT_BASE_URL = 'https://gacha.collectorcrypt.com';
export const COLLECTOR_CRYPT_SETTLEMENT_ASSET = Object.freeze({
  chainId: 'solana-mainnet',
  assetId: CIRCLE_USD_MINT,
  decimals: CIRCLE_USD_DECIMALS,
});

// Every documented endpoint that mutates provider state. --dry-run refuses all four.
export const MUTATION_ENDPOINT_NAMES = Object.freeze(['generatePack', 'openPack', 'buyback', 'submitTransaction']);

// GET responses carry no side effects: any of these statuses is safe to retry.
const DEFAULT_READ_RETRYABLE_STATUSES = Object.freeze([429, 500, 502, 503, 504]);
// A mutation is never retried automatically. A timeout, disconnect, or 5xx can follow a committed
// provider effect, so only durable reconciliation may decide what happened.
const DEFAULT_MUTATION_RETRYABLE_STATUSES = Object.freeze([]);
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const packTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const memoPattern = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no whitespace/control chars
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const numericString = /^[0-9]+$/;
const confirmationStatuses = new Set(['confirmed', 'finalized', 'submitted']);
const nftRarityPattern = /^(common|uncommon|rare|epic)$/;

export class CollectorCryptError extends Error {
  constructor(message, { endpoint, status, body, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'CollectorCryptError';
    this.endpoint = endpoint;
    if (status !== undefined) this.status = status;
    if (body !== undefined) this.body = body;
  }
}

export class CollectorCryptDryRunRefusalError extends CollectorCryptError {
  constructor(endpoint) {
    super(`collector-crypt dry-run refuses to call mutation endpoint "${endpoint}"`, { endpoint });
    this.name = 'CollectorCryptDryRunRefusalError';
  }
}

export class CollectorCryptTimeoutError extends CollectorCryptError {
  constructor(endpoint, timeoutMs, cause) {
    super(`collector-crypt ${endpoint} request timed out after ${timeoutMs}ms`, { endpoint, cause });
    this.name = 'CollectorCryptTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function parseCollectorMachineContains(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && numericString.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  throw new CollectorCryptError('collector-crypt machines returned an invalid contains value', { endpoint: 'machines', body: value });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireSolanaAddress(value, label) {
  if (typeof value !== 'string' || !solanaAddressPattern.test(value)) throw new TypeError(`${label} must be a base58 Solana address`);
  return value;
}

function rejectUnknownFields(request, allowed, label) {
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has an unexpected field "${key}"`);
  }
}

/** Computes the stable idempotency identifier a mutation call carries across every retry attempt. */
export function computeCollectorCryptRequestDigest(endpoint, request) {
  return digest({ domain: 'hookemon.collector-crypt-request.v1', endpoint, request: request ?? null });
}

/** True when argv (default process.argv.slice(2)) carries a --dry-run flag. */
export function hasDryRunFlag(argv = process.argv.slice(2)) {
  return Array.isArray(argv) && argv.includes('--dry-run');
}

function defaultSleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function backoffDelayMs(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function timeoutError(endpoint, timeoutMs, error, signal) {
  return signal.aborted || error?.name === 'TimeoutError'
    ? new CollectorCryptTimeoutError(endpoint, timeoutMs, error)
    : null;
}

async function performRequest({ fetchImpl, sleep, method, url, headers, body, endpoint, maxAttempts, baseDelayMs, maxDelayMs, retryableStatuses, retryOnNetworkError, timeoutMs }) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let response;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      response = await fetchImpl(url, { method, headers, body, signal });
    } catch (networkError) {
      if (!retryOnNetworkError || attempt >= maxAttempts) {
        const timedOut = timeoutError(endpoint, timeoutMs, networkError, signal);
        if (timedOut) throw timedOut;
        throw new CollectorCryptError(`collector-crypt ${endpoint} request failed`, { endpoint, cause: networkError });
      }
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
      continue;
    }

    let rawBody;
    try {
      rawBody = await response.text();
    } catch (bodyError) {
      const timedOut = timeoutError(endpoint, timeoutMs, bodyError, signal);
      if (timedOut) throw timedOut;
      throw new CollectorCryptError(`collector-crypt ${endpoint} response body could not be read`, {
        endpoint,
        status: response.status,
        cause: bodyError,
      });
    }
    let parsedBody = null;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (parseError) {
        throw new CollectorCryptError(`collector-crypt ${endpoint} returned a non-JSON response`, { endpoint, status: response.status, body: rawBody, cause: parseError });
      }
    }

    if (response.ok) return parsedBody;

    if (retryableStatuses.has(response.status) && attempt < maxAttempts) {
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs));
      continue;
    }
    throw new CollectorCryptError(`collector-crypt ${endpoint} responded with status ${response.status}`, { endpoint, status: response.status, body: parsedBody });
  }
}

// ---------------------------------------------------------------------------------------------
// Request validation (outgoing bodies/query params) — rejects unknown fields and malformed
// values before any network call, matching the rest of this repository's fail-closed style.
// ---------------------------------------------------------------------------------------------

function validateGeneratePackRequest(request) {
  if (!isPlainObject(request)) throw new TypeError('collector-crypt generatePack request must be a plain object');
  const out = { playerAddress: requireSolanaAddress(request.playerAddress, 'collector-crypt generatePack playerAddress') };
  if (request.packType !== undefined) {
    if (typeof request.packType !== 'string' || !packTypePattern.test(request.packType)) throw new TypeError('collector-crypt generatePack packType must be a lowercase machine code');
    out.packType = request.packType;
  }
  if (request.turbo !== undefined) {
    if (typeof request.turbo !== 'boolean') throw new TypeError('collector-crypt generatePack turbo must be a boolean');
    out.turbo = request.turbo;
  }
  if (request.altPlayerAddress !== undefined) out.altPlayerAddress = requireSolanaAddress(request.altPlayerAddress, 'collector-crypt generatePack altPlayerAddress');
  if (request.altFundsRecipient !== undefined) out.altFundsRecipient = requireSolanaAddress(request.altFundsRecipient, 'collector-crypt generatePack altFundsRecipient');
  rejectUnknownFields(request, new Set(['playerAddress', 'packType', 'turbo', 'altPlayerAddress', 'altFundsRecipient']), 'collector-crypt generatePack request');
  return out;
}

function validateOpenPackRequest(request) {
  if (!isPlainObject(request)) throw new TypeError('collector-crypt openPack request must be a plain object');
  if (typeof request.memo !== 'string' || !memoPattern.test(request.memo)) throw new TypeError('collector-crypt openPack memo must be a non-empty printable-ASCII string');
  rejectUnknownFields(request, new Set(['memo']), 'collector-crypt openPack request');
  return { memo: request.memo };
}

function validateBuybackRequest(request) {
  if (!isPlainObject(request)) throw new TypeError('collector-crypt buyback request must be a plain object');
  const out = {
    playerAddress: requireSolanaAddress(request.playerAddress, 'collector-crypt buyback playerAddress'),
    nftAddress: requireSolanaAddress(request.nftAddress, 'collector-crypt buyback nftAddress'),
  };
  if (request.altRecipient !== undefined) out.altRecipient = requireSolanaAddress(request.altRecipient, 'collector-crypt buyback altRecipient');
  rejectUnknownFields(request, new Set(['playerAddress', 'nftAddress', 'altRecipient']), 'collector-crypt buyback request');
  return out;
}

function validateSubmitTransactionRequest(request) {
  if (!isPlainObject(request)) throw new TypeError('collector-crypt submitTransaction request must be a plain object');
  if (typeof request.signedTransaction !== 'string' || request.signedTransaction.length === 0 || !base64Pattern.test(request.signedTransaction)) {
    throw new TypeError('collector-crypt submitTransaction signedTransaction must be a non-empty base64 string');
  }
  rejectUnknownFields(request, new Set(['signedTransaction']), 'collector-crypt submitTransaction request');
  return { signedTransaction: request.signedTransaction };
}

// ---------------------------------------------------------------------------------------------
// Response validation (incoming bodies) — checks only the fields the docs guarantee are always
// present for each documented response variant; unrecognized extra fields pass through untouched.
// ---------------------------------------------------------------------------------------------

function assertResponseShape(condition, endpoint, value) {
  if (!condition) throw new CollectorCryptError(`collector-crypt ${endpoint} returned an unexpected response shape`, { endpoint, body: value });
  return value;
}

function assertMachinesResponse(value) {
  return assertResponseShape(isPlainObject(value) && Array.isArray(value.machines), 'machines', value);
}

function assertStatusResponse(value) {
  return assertResponseShape(isPlainObject(value) && typeof value.machineStatus === 'string' && Array.isArray(value.gachas), 'status', value);
}

function assertGeneratePackResponse(value) {
  return assertResponseShape(isPlainObject(value) && typeof value.memo === 'string' && value.memo.length > 0 && typeof value.transaction === 'string' && value.transaction.length > 0, 'generatePack', value);
}

function assertOpenPackResponse(value) {
  // Waiting variants carry only `success`. A documented award carries both its card asset and
  // transaction signature, which we normalize to the camel-case field used by reconciliation.
  assertResponseShape(isPlainObject(value) && typeof value.success === 'boolean', 'openPack', value);
  const hasNftAddress = Object.hasOwn(value, 'nft_address');
  const hasSnakeSignature = Object.hasOwn(value, 'transaction_signature');
  const hasCamelSignature = Object.hasOwn(value, 'transactionSignature');
  if (!hasNftAddress && !hasSnakeSignature && !hasCamelSignature) return value;
  const validAward = typeof value.nft_address === 'string' && solanaAddressPattern.test(value.nft_address)
    && (!hasSnakeSignature || (typeof value.transaction_signature === 'string' && value.transaction_signature.length > 0))
    && (!hasCamelSignature || (typeof value.transactionSignature === 'string' && value.transactionSignature.length > 0))
    && (hasSnakeSignature || hasCamelSignature)
    && (!hasSnakeSignature || !hasCamelSignature || value.transaction_signature === value.transactionSignature);
  assertResponseShape(validAward, 'openPack', value);
  if (hasCamelSignature) return value;
  return { ...value, transactionSignature: value.transaction_signature };
}

function typedBuybackAmount(value, endpoint, field) {
  const amountAtomic = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === 'string' && canonicalUnsignedInteger.test(value)
      ? value
      : null;
  if (amountAtomic === null) {
    throw new CollectorCryptError(`collector-crypt ${endpoint} returned an invalid ${field}`, { endpoint, body: value });
  }
  return assertTypedAmount({
    ...COLLECTOR_CRYPT_SETTLEMENT_ASSET,
    amountAtomic,
  }, `collector-crypt ${endpoint} ${field}`);
}

function assertBuybackAvailableResponse(value) {
  if (!isPlainObject(value) || typeof value.available !== 'boolean') {
    throw new CollectorCryptError('collector-crypt buyback/available returned an unexpected response shape', { endpoint: 'buyback/available', body: value });
  }
  if (!value.available) return value;
  return { ...value, amount: typedBuybackAmount(value.amount, 'buyback/available', 'amount') };
}

function assertBuybackResponse(value) {
  const response = assertResponseShape(
    isPlainObject(value) && value.success === true && typeof value.serializedTransaction === 'string' && value.serializedTransaction.length > 0 && typeof value.memo === 'string',
    'buyback',
    value,
  );
  return { ...response, refundAmount: typedBuybackAmount(response.refundAmount, 'buyback', 'refundAmount') };
}

function assertBuybackCheckResponse(value) {
  if (!isPlainObject(value) || typeof value.exists !== 'boolean') {
    throw new CollectorCryptError('collector-crypt buyback/check returned an unexpected response shape', { endpoint: 'buyback/check', body: value });
  }
  if (!value.exists) return value;
  return assertResponseShape(
    typeof value.playerWallet === 'string' && solanaAddressPattern.test(value.playerWallet)
      && typeof value.nft === 'string' && solanaAddressPattern.test(value.nft)
      && typeof value.transactionSignature === 'string' && value.transactionSignature.length > 0
      && typeof value.buybackAmount === 'string' && canonicalUnsignedInteger.test(value.buybackAmount)
      && typeof value.createdAt === 'string' && value.createdAt.length > 0
      && typeof value.status === 'string',
    'buyback/check',
    value,
  );
}

function assertSubmitTransactionResponse(value) {
  return assertResponseShape(
    isPlainObject(value) && value.success === true && typeof value.signature === 'string' && value.signature.length > 0 && confirmationStatuses.has(value.confirmationStatus),
    'submitTransaction',
    value,
  );
}

function assertPackStatusResponse(value) {
  return assertResponseShape(
    isPlainObject(value) && typeof value.memo === 'string' && (value.pack === null || isPlainObject(value.pack)) && (value.send === null || isPlainObject(value.send)) && Array.isArray(value.buyback),
    'pack/status',
    value,
  );
}

function assertNftsResponse(value, { paginationRequested }) {
  if (!isPlainObject(value) || !Array.isArray(value.nfts)) {
    throw new CollectorCryptError('collector-crypt getNfts returned an unexpected response shape', { endpoint: 'getNfts', body: value });
  }
  if (!paginationRequested) return value;
  return assertResponseShape(
    typeof value.hasMore === 'boolean'
      && Number.isSafeInteger(value.page)
      && value.page >= 1
      && Number.isSafeInteger(value.limit)
      && value.limit >= 1,
    'getNfts',
    value,
  );
}

function validateGetNftsRequest(request = {}) {
  if (!isPlainObject(request)) throw new TypeError('collector-crypt getNfts request must be a plain object');
  rejectUnknownFields(request, new Set(['code', 'rarity', 'page', 'limit']), 'collector-crypt getNfts request');
  const query = {};
  if (request.code !== undefined) {
    if (typeof request.code !== 'string' || !packTypePattern.test(request.code)) throw new TypeError('collector-crypt getNfts code must be a lowercase machine code');
    query.code = request.code;
  }
  if (request.rarity !== undefined) {
    if (typeof request.rarity !== 'string' || !nftRarityPattern.test(request.rarity)) throw new TypeError('collector-crypt getNfts rarity must be a documented rarity');
    query.rarity = request.rarity;
  }
  for (const field of ['page', 'limit']) {
    if (request[field] !== undefined) {
      if (!Number.isSafeInteger(request[field]) || request[field] < 1) throw new TypeError(`collector-crypt getNfts ${field} must be a positive safe integer`);
      query[field] = request[field];
    }
  }
  return query;
}

/**
 * Creates a Collector Crypt gacha API client.
 *
 * @param {object} options
 * @param {string} options.apiKey - sent as `x-api-key` on every call, GET included.
 * @param {string} [options.baseUrl] - defaults to https://gacha.collectorcrypt.com.
 * @param {typeof fetch} [options.fetchImpl] - defaults to the global fetch.
 * @param {boolean} [options.dryRun] - when true, every mutation endpoint refuses to run.
 * @param {number} [options.maxAttempts] - total attempts per call, including the first (default 5).
 * @param {number} [options.baseDelayMs] - first retry delay (default 250); doubles each attempt.
 * @param {number} [options.maxDelayMs] - delay ceiling (default 8000).
 * @param {(ms: number) => Promise<void>} [options.sleep] - injectable for deterministic tests.
 * @param {number[]} [options.readRetryableStatuses]
 * @param {number} [options.timeoutMs] - deadline for one HTTP attempt (default 15000).
 */
export function createCollectorCryptClient(options = {}) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    dryRun = false,
    maxAttempts = 5,
    baseDelayMs = 250,
    maxDelayMs = 8_000,
    sleep = defaultSleep,
    readRetryableStatuses = DEFAULT_READ_RETRYABLE_STATUSES,
    mutationRetryableStatuses = DEFAULT_MUTATION_RETRYABLE_STATUSES,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;

  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new TypeError('collector-crypt client requires a non-empty apiKey');
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('collector-crypt client baseUrl must be a non-empty string');
  if (typeof fetchImpl !== 'function') throw new TypeError('collector-crypt client requires a fetch implementation (global fetch is unavailable)');
  if (typeof dryRun !== 'boolean') throw new TypeError('collector-crypt client dryRun must be a boolean');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('collector-crypt client maxAttempts must be a positive integer');
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) throw new TypeError('collector-crypt client baseDelayMs must be a non-negative integer');
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new TypeError('collector-crypt client maxDelayMs must be an integer at least baseDelayMs');
  if (typeof sleep !== 'function') throw new TypeError('collector-crypt client sleep must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('collector-crypt client timeoutMs must be a positive safe integer');
  if (!Array.isArray(mutationRetryableStatuses) || mutationRetryableStatuses.length !== 0) {
    throw new TypeError('collector-crypt client mutationRetryableStatuses must be empty');
  }

  const readStatuses = new Set(readRetryableStatuses);
  const pendingMutations = new Map();

  async function getJson(endpoint, path, query) {
    const url = buildUrl(baseUrl, path, query);
    const headers = { 'x-api-key': apiKey, accept: 'application/json' };
    return performRequest({ fetchImpl, sleep, method: 'GET', url, headers, body: undefined, endpoint, maxAttempts, baseDelayMs, maxDelayMs, retryableStatuses: readStatuses, retryOnNetworkError: true, timeoutMs });
  }

  async function postMutation(endpoint, path, request) {
    if (dryRun) throw new CollectorCryptDryRunRefusalError(endpoint);

    const idempotencyKey = computeCollectorCryptRequestDigest(endpoint, request);
    const dedupeKey = `${endpoint}:${idempotencyKey}`;
    const inFlight = pendingMutations.get(dedupeKey);
    if (inFlight) return inFlight;

    const url = buildUrl(baseUrl, path);
    const headers = { 'x-api-key': apiKey, accept: 'application/json', 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey };
    const body = JSON.stringify(request);
    // retryOnNetworkError: false — see the UNVERIFIED block at the top of this file. The provider
    // documents no server-side idempotency, so a thrown network error (the request may or may not
    // have reached and been fully processed by the provider) is surfaced once, immediately, rather
    // than auto-retried; the caller decides whether it is safe to call again after checking actual
    // provider state. Every non-success status is likewise ambiguous for a mutation and is surfaced
    // once for durable reconciliation; this client never issues a second mutation request.
    const promise = performRequest({ fetchImpl, sleep, method: 'POST', url, headers, body, endpoint, maxAttempts, baseDelayMs, maxDelayMs, retryableStatuses: new Set(DEFAULT_MUTATION_RETRYABLE_STATUSES), retryOnNetworkError: false, timeoutMs });
    pendingMutations.set(dedupeKey, promise);
    try {
      return await promise;
    } finally {
      pendingMutations.delete(dedupeKey);
    }
  }

  async function getMachines() {
    return assertMachinesResponse(await getJson('machines', '/api/machines'));
  }

  async function getStatus() {
    return assertStatusResponse(await getJson('status', '/api/status'));
  }

  async function getNfts(request = {}) {
    const query = validateGetNftsRequest(request);
    return assertNftsResponse(await getJson('getNfts', '/api/getNfts', query), {
      paginationRequested: request.page !== undefined || request.limit !== undefined,
    });
  }

  async function generatePack(request) {
    const validated = validateGeneratePackRequest(request);
    return assertGeneratePackResponse(await postMutation('generatePack', '/api/generatePack', validated));
  }

  async function openPack(request) {
    const validated = validateOpenPackRequest(request);
    return assertOpenPackResponse(await postMutation('openPack', '/api/openPack', validated));
  }

  async function getBuybackAvailable({ nft, wallet } = {}) {
    requireSolanaAddress(nft, 'collector-crypt getBuybackAvailable nft');
    const query = { nft };
    if (wallet !== undefined) {
      requireSolanaAddress(wallet, 'collector-crypt getBuybackAvailable wallet');
      query.wallet = wallet;
    }
    return assertBuybackAvailableResponse(await getJson('buyback/available', '/api/buyback/available', query));
  }

  async function getBuybackCheck({ memo } = {}) {
    if (typeof memo !== 'string' || !memoPattern.test(memo)) throw new TypeError('collector-crypt getBuybackCheck requires a memo');
    return assertBuybackCheckResponse(await getJson('buyback/check', '/api/buyback/check', { memo }));
  }

  async function buyback(request) {
    const validated = validateBuybackRequest(request);
    return assertBuybackResponse(await postMutation('buyback', '/api/buyback', validated));
  }

  async function submitTransaction(request) {
    const validated = validateSubmitTransactionRequest(request);
    return assertSubmitTransactionResponse(await postMutation('submitTransaction', '/api/submitTransaction', validated));
  }

  async function getPackStatus({ memo } = {}) {
    if (typeof memo !== 'string' || !memoPattern.test(memo)) throw new TypeError('collector-crypt getPackStatus requires a memo');
    return assertPackStatusResponse(await getJson('pack/status', '/api/pack/status', { memo }));
  }

  return Object.freeze({
    dryRun,
    getMachines,
    getStatus,
    getNfts,
    generatePack,
    openPack,
    getBuybackAvailable,
    getBuybackCheck,
    buyback,
    submitTransaction,
    getPackStatus,
  });
}
