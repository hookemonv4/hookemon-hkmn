// Fixture-only coverage for packages/adapters/src/collector-crypt.mjs. Every network call in this
// file goes through a stub `fetchImpl`; no real HTTP request is made. See
// collector-crypt.live-smoke.test.mjs for the separate, explicitly-labeled live-read-only check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CollectorCryptDryRunRefusalError,
  CollectorCryptError,
  CollectorCryptTimeoutError,
  DEFAULT_BASE_URL,
  MUTATION_ENDPOINT_NAMES,
  computeCollectorCryptRequestDigest,
  createCollectorCryptClient,
  hasDryRunFlag,
  parseCollectorMachineContains,
} from '../src/collector-crypt.mjs';
import { CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT } from '../src/solana-rpc.mjs';

const fixturesDir = fileURLToPath(new URL('./fixtures/collector-crypt/', import.meta.url));
function loadFixture(name) {
  return JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8'));
}

const PLAYER_ADDRESS = 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc';
const ALT_PLAYER_ADDRESS = 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm';
const NFT_ADDRESS = 'H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA';
const MEMO = 'me-953cc94e-fd51-4f5f-bbcc-5a35faf7df65';
const API_KEY = 'test-api-key';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
  };
}

function noSleep() {
  return Promise.resolve();
}

function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url instanceof URL ? url : new URL(url), init });
    return responder(calls.length, calls[calls.length - 1]);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeClient(fetchImpl, overrides = {}) {
  return createCollectorCryptClient({ apiKey: API_KEY, fetchImpl, sleep: noSleep, ...overrides });
}

function settlementAmount(amountAtomic) {
  return {
    chainId: 'solana-mainnet',
    assetId: CIRCLE_USD_MINT,
    decimals: CIRCLE_USD_DECIMALS,
    amountAtomic,
  };
}

// --- constructor validation --------------------------------------------------------------------

test('createCollectorCryptClient requires a non-empty apiKey', () => {
  assert.throws(() => createCollectorCryptClient({ fetchImpl: async () => jsonResponse(200, {}) }), TypeError);
  assert.throws(() => createCollectorCryptClient({ apiKey: '', fetchImpl: async () => jsonResponse(200, {}) }), TypeError);
});

test('createCollectorCryptClient requires a fetch implementation', () => {
  // `fetchImpl: undefined` falls back to the ambient global fetch (present under Node 24), so the
  // invariant under test is "a non-function value is rejected", not "the option is mandatory".
  assert.throws(() => createCollectorCryptClient({ apiKey: API_KEY, fetchImpl: 'not-a-function' }), TypeError);
});

test('createCollectorCryptClient rejects a non-integer maxAttempts', () => {
  assert.throws(() => makeClient(async () => jsonResponse(200, {}), { maxAttempts: 0 }), TypeError);
  assert.throws(() => makeClient(async () => jsonResponse(200, {}), { maxAttempts: 1.5 }), TypeError);
});

test('createCollectorCryptClient requires a positive integer request timeout', () => {
  assert.throws(() => makeClient(async () => jsonResponse(200, {}), { timeoutMs: 0 }), TypeError);
  assert.throws(() => makeClient(async () => jsonResponse(200, {}), { timeoutMs: 1.5 }), TypeError);
});

test('createCollectorCryptClient refuses a mutation retry override', () => {
  assert.throws(
    () => makeClient(async () => jsonResponse(200, {}), { mutationRetryableStatuses: [503] }),
    /must be empty/,
  );
});

test('DEFAULT_BASE_URL and MUTATION_ENDPOINT_NAMES are the documented values', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://gacha.collectorcrypt.com');
  assert.deepEqual([...MUTATION_ENDPOINT_NAMES].sort(), ['buyback', 'generatePack', 'openPack', 'submitTransaction'].sort());
});

// --- acceptance: every documented mutation endpoint has a typed client function -----------------

test('every documented mutation endpoint has a typed client function', () => {
  const client = makeClient(async () => jsonResponse(200, {}));
  for (const name of MUTATION_ENDPOINT_NAMES) assert.equal(typeof client[name], 'function', `missing client.${name}`);
});

// --- acceptance: x-api-key is sent on every request, GET included -------------------------------

test('x-api-key is sent on every GET call', async () => {
  const fetchImpl = recordingFetch(callIndex => {
    const map = [loadFixture('machines'), loadFixture('status'), loadFixture('buyback-available'), loadFixture('pack-status')];
    return jsonResponse(200, map[callIndex - 1]);
  });
  const client = makeClient(fetchImpl);

  await client.getMachines();
  await client.getStatus();
  await client.getBuybackAvailable({ nft: NFT_ADDRESS });
  await client.getPackStatus({ memo: MEMO });

  assert.equal(fetchImpl.calls.length, 4);
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers['x-api-key'], API_KEY);
  }
});

test('x-api-key is sent on every mutation call', async () => {
  const fetchImpl = recordingFetch(callIndex => {
    const map = [loadFixture('generate-pack'), loadFixture('open-pack'), loadFixture('buyback'), loadFixture('submit-transaction')];
    return jsonResponse(200, map[callIndex - 1]);
  });
  const client = makeClient(fetchImpl);

  await client.generatePack({ playerAddress: PLAYER_ADDRESS });
  await client.openPack({ memo: MEMO });
  await client.buyback({ playerAddress: PLAYER_ADDRESS, nftAddress: NFT_ADDRESS });
  await client.submitTransaction({ signedTransaction: 'QQ==' });

  assert.equal(fetchImpl.calls.length, 4);
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['x-api-key'], API_KEY);
  }
});

// --- endpoint-by-endpoint request/response shape ------------------------------------------------

test('getMachines calls GET /api/machines and returns the parsed catalog', async () => {
  const fixture = loadFixture('machines');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.getMachines();

  assert.equal(fetchImpl.calls[0].url.pathname, '/api/machines');
  assert.deepEqual(result, fixture);
});

test('Collector machine card counts accept integer and numeric-string values only', () => {
  assert.equal(parseCollectorMachineContains(1), 1);
  assert.equal(parseCollectorMachineContains('02'), 2);
  assert.equal(parseCollectorMachineContains(0), 0);
  assert.throws(() => parseCollectorMachineContains('description of contents'), /contains/);
  assert.throws(() => parseCollectorMachineContains(1.5), /contains/);
  assert.throws(() => parseCollectorMachineContains(-1), /contains/);
});

test('getStatus calls GET /api/status', async () => {
  const fixture = loadFixture('status');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.getStatus();

  assert.equal(fetchImpl.calls[0].url.pathname, '/api/status');
  assert.deepEqual(result, fixture);
});

test('getNfts calls the documented read-only endpoint with its optional filters', async () => {
  const fixture = loadFixture('get-nfts');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.getNfts({ code: 'pokemon_50', rarity: 'epic', page: 1, limit: 50 });

  const call = fetchImpl.calls[0];
  assert.equal(call.url.pathname, '/api/getNfts');
  assert.equal(call.url.searchParams.get('code'), 'pokemon_50');
  assert.equal(call.url.searchParams.get('rarity'), 'epic');
  assert.equal(call.url.searchParams.get('page'), '1');
  assert.equal(call.url.searchParams.get('limit'), '50');
  assert.deepEqual(result, fixture);
});

test('getNfts accepts the documented non-paginated response when page is omitted', async () => {
  const response = {
    nfts: [{ nft_address: NFT_ADDRESS, rarity: 'epic', insured_value: 50000000 }],
  };
  const fetchImpl = recordingFetch(() => jsonResponse(200, response));
  const client = makeClient(fetchImpl);

  const result = await client.getNfts({ code: 'pokemon_50', rarity: 'epic' });

  assert.deepEqual(result, response);
  assert.equal(fetchImpl.calls[0].url.searchParams.has('page'), false);
  assert.equal(fetchImpl.calls[0].url.searchParams.has('limit'), false);
});

test('getNfts requires pagination metadata when a page size is supplied', async () => {
  const response = {
    nfts: [{ nft_address: NFT_ADDRESS, rarity: 'epic', insured_value: 50000000 }],
  };
  const client = makeClient(recordingFetch(() => jsonResponse(200, response)));

  await assert.rejects(() => client.getNfts({ limit: 50 }), CollectorCryptError);
});

test('generatePack posts the documented body to /api/generatePack', async () => {
  const fixture = loadFixture('generate-pack');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.generatePack({ playerAddress: PLAYER_ADDRESS, packType: 'pokemon_50', turbo: true, altPlayerAddress: ALT_PLAYER_ADDRESS });

  const call = fetchImpl.calls[0];
  assert.equal(call.url.pathname, '/api/generatePack');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), { playerAddress: PLAYER_ADDRESS, packType: 'pokemon_50', turbo: true, altPlayerAddress: ALT_PLAYER_ADDRESS });
  assert.deepEqual(result, fixture);
});

test('generatePack rejects an invalid playerAddress before any network call', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {}));
  const client = makeClient(fetchImpl);

  await assert.rejects(() => client.generatePack({ playerAddress: 'not-a-real-address' }), TypeError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('generatePack rejects an unknown request field before any network call', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {}));
  const client = makeClient(fetchImpl);

  await assert.rejects(() => client.generatePack({ playerAddress: PLAYER_ADDRESS, unknownField: true }), TypeError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('openPack posts { memo } to /api/openPack and passes through every documented response variant', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { success: true, code: 'WAITING_FOR_WEBHOOK', memo: MEMO }));
  const client = makeClient(fetchImpl);

  const result = await client.openPack({ memo: MEMO });

  assert.equal(fetchImpl.calls[0].url.pathname, '/api/openPack');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { memo: MEMO });
  assert.deepEqual(result, { success: true, code: 'WAITING_FOR_WEBHOOK', memo: MEMO });
});

test('openPack normalizes a documented snake-case transaction signature and rejects an incomplete award', async () => {
  const documentedAward = {
    success: true,
    nft_address: NFT_ADDRESS,
    transaction_signature: '3'.repeat(88),
  };
  const client = makeClient(recordingFetch(() => jsonResponse(200, documentedAward)));

  assert.deepEqual(await client.openPack({ memo: MEMO }), {
    ...documentedAward,
    transactionSignature: documentedAward.transaction_signature,
  });

  const incompleteAward = makeClient(recordingFetch(() => jsonResponse(200, {
    success: true,
    nft_address: NFT_ADDRESS,
  })));
  await assert.rejects(() => incompleteAward.openPack({ memo: MEMO }), CollectorCryptError);
});

test('getBuybackAvailable sends nft (and optional wallet) as query parameters', async () => {
  const fixture = loadFixture('buyback-available');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.getBuybackAvailable({ nft: NFT_ADDRESS, wallet: PLAYER_ADDRESS });

  const call = fetchImpl.calls[0];
  assert.equal(call.url.pathname, '/api/buyback/available');
  assert.equal(call.url.searchParams.get('nft'), NFT_ADDRESS);
  assert.equal(call.url.searchParams.get('wallet'), PLAYER_ADDRESS);
  assert.deepEqual(result, { ...fixture, amount: settlementAmount('42500000') });
});

test('buyback offer and refund values are normalized to the pinned Solana amount envelope', async () => {
  const fetchImpl = recordingFetch(callIndex => jsonResponse(200, callIndex === 1
    ? loadFixture('buyback-available')
    : loadFixture('buyback')));
  const client = makeClient(fetchImpl);
  const amount = settlementAmount('42500000');

  const available = await client.getBuybackAvailable({ nft: NFT_ADDRESS });
  const buyback = await client.buyback({ playerAddress: PLAYER_ADDRESS, nftAddress: NFT_ADDRESS });

  assert.deepEqual(available.amount, amount);
  assert.deepEqual(buyback.refundAmount, amount);
});

test('getBuybackAvailable requires a valid nft address', async () => {
  const client = makeClient(async () => jsonResponse(200, {}));
  await assert.rejects(() => client.getBuybackAvailable({}), TypeError);
});

test('getBuybackCheck reads the memo-bound completed buyback record', async () => {
  const response = {
    exists: true,
    playerWallet: PLAYER_ADDRESS,
    nft: NFT_ADDRESS,
    transactionSignature: '3'.repeat(88),
    buybackAmount: '42500000',
    createdAt: '2025-05-26T17:32:33.588Z',
    status: 'complete',
  };
  const fetchImpl = recordingFetch(() => jsonResponse(200, response));
  const client = makeClient(fetchImpl);

  const result = await client.getBuybackCheck({ memo: MEMO });

  assert.deepEqual(result, response);
  assert.equal(fetchImpl.calls[0].url.pathname, '/api/buyback/check');
  assert.equal(fetchImpl.calls[0].url.searchParams.get('memo'), MEMO);
});

test('buyback posts the documented body to /api/buyback', async () => {
  const fixture = loadFixture('buyback');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.buyback({ playerAddress: PLAYER_ADDRESS, nftAddress: NFT_ADDRESS });

  assert.equal(fetchImpl.calls[0].url.pathname, '/api/buyback');
  assert.deepEqual(result, { ...fixture, refundAmount: settlementAmount('42500000') });
});

test('submitTransaction posts { signedTransaction } and validates confirmationStatus', async () => {
  const fixture = loadFixture('submit-transaction');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.submitTransaction({ signedTransaction: 'QQ==' });

  assert.equal(fetchImpl.calls[0].url.pathname, '/api/submitTransaction');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { signedTransaction: 'QQ==' });
  assert.deepEqual(result, fixture);
});

test('submitTransaction rejects a non-base64 signedTransaction before any network call', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {}));
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.submitTransaction({ signedTransaction: 'not base64!' }), TypeError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('getPackStatus sends memo as a query parameter and passes through nullable pack/send fields', async () => {
  const fixture = loadFixture('pack-status');
  const fetchImpl = recordingFetch(() => jsonResponse(200, fixture));
  const client = makeClient(fetchImpl);

  const result = await client.getPackStatus({ memo: MEMO });

  const call = fetchImpl.calls[0];
  assert.equal(call.url.pathname, '/api/pack/status');
  assert.equal(call.url.searchParams.get('memo'), MEMO);
  assert.deepEqual(result, fixture);
});

test('getPackStatus accepts a response with null pack/send and an empty buyback array', async () => {
  const empty = { memo: MEMO, pack: null, send: null, buyback: [] };
  const client = makeClient(async () => jsonResponse(200, empty));
  const result = await client.getPackStatus({ memo: MEMO });
  assert.deepEqual(result, empty);
});

// --- acceptance: --dry-run never calls a mutation endpoint --------------------------------------

test('dry-run refuses every mutation endpoint without ever calling fetch', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {}));
  const client = makeClient(fetchImpl, { dryRun: true });

  await assert.rejects(() => client.generatePack({ playerAddress: PLAYER_ADDRESS }), CollectorCryptDryRunRefusalError);
  await assert.rejects(() => client.openPack({ memo: MEMO }), CollectorCryptDryRunRefusalError);
  await assert.rejects(() => client.buyback({ playerAddress: PLAYER_ADDRESS, nftAddress: NFT_ADDRESS }), CollectorCryptDryRunRefusalError);
  await assert.rejects(() => client.submitTransaction({ signedTransaction: 'QQ==' }), CollectorCryptDryRunRefusalError);

  assert.equal(fetchImpl.calls.length, 0, 'dry-run must never invoke fetch for a mutation endpoint');
});

test('dry-run still permits real read-only calls', async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, loadFixture('machines')));
  const client = makeClient(fetchImpl, { dryRun: true });

  await client.getMachines();

  assert.equal(fetchImpl.calls.length, 1);
});

test('hasDryRunFlag detects --dry-run in an argv array', () => {
  assert.equal(hasDryRunFlag(['--dry-run']), true);
  assert.equal(hasDryRunFlag(['--live']), false);
  assert.equal(hasDryRunFlag([]), false);
});

// --- acceptance: a network failure never triggers a duplicate mutation --------------------------
//
// docs.collectorcrypt.com/gacha/api documents no server-side idempotency mechanism for any
// mutation endpoint (see the UNVERIFIED block atop collector-crypt.mjs and the docs card's
// Invariants section). A network failure leaves the outcome ambiguous — the provider may have
// already fully processed the mutation before the response was lost — so postMutation does NOT
// auto-retry a network failure the way GET calls do: it surfaces the error once, immediately, and
// leaves it to the caller to reconcile actual provider state before trying again. This is what
// actually "never a duplicate mutation" means for a provider with no confirmed dedup support: the
// client only ever sends one POST per network failure, not a guess-and-retry.

test('a network failure on a mutation (generatePack) throws immediately, once, without an automatic retry', async () => {
  let calls = 0;
  const seenKeys = [];
  const fetchImpl = async (url, init) => {
    calls += 1;
    seenKeys.push(init.headers['x-idempotency-key']);
    throw new TypeError('fetch failed');
  };
  const client = makeClient(fetchImpl, { maxAttempts: 5 });

  await assert.rejects(() => client.generatePack({ playerAddress: PLAYER_ADDRESS }), error => {
    assert.ok(error instanceof CollectorCryptError);
    assert.equal(error.status, undefined, 'a network-failure error carries no HTTP status');
    return true;
  });

  assert.equal(calls, 1, 'a mutation network failure must never be auto-retried, even with maxAttempts > 1');
  assert.ok(seenKeys[0], 'an idempotency key is still sent on the single attempt');
});

test('a network failure on a GET (read-only) call is retried, unlike a mutation', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return jsonResponse(200, loadFixture('machines'));
  };
  const client = makeClient(fetchImpl, { maxAttempts: 5 });

  const result = await client.getMachines();

  assert.equal(calls, 2, 'a GET network failure is retried because reads have no side effect');
  assert.deepEqual(result, loadFixture('machines'));
});

test('generatePack idempotency key is the deterministic requestDigest of the validated request', async () => {
  let seenKey;
  const fetchImpl = async (url, init) => {
    seenKey = init.headers['x-idempotency-key'];
    return jsonResponse(200, loadFixture('generate-pack'));
  };
  const client = makeClient(fetchImpl);

  await client.generatePack({ playerAddress: PLAYER_ADDRESS });

  assert.equal(seenKey, computeCollectorCryptRequestDigest('generatePack', { playerAddress: PLAYER_ADDRESS }));
});

test('a repeated network failure on a GET surfaces a CollectorCryptError without exceeding maxAttempts calls', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  const client = makeClient(fetchImpl, { maxAttempts: 3 });

  await assert.rejects(() => client.getMachines(), CollectorCryptError);
  assert.equal(calls, 3);
});

test('a mutation 503 is surfaced after one request; a 400 is also not retried', async () => {
  let calls503 = 0;
  const fetch503 = async () => {
    calls503 += 1;
    return jsonResponse(503, { error: 'Machine has too many packs currently open' });
  };
  const client503 = makeClient(fetch503, { maxAttempts: 5 });
  await assert.rejects(() => client503.generatePack({ playerAddress: PLAYER_ADDRESS }), error => {
    assert.ok(error instanceof CollectorCryptError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(calls503, 1, 'a mutation response cannot prove that no provider effect occurred');

  let calls400 = 0;
  const fetch400 = async () => {
    calls400 += 1;
    return jsonResponse(400, { error: 'Invalid request body' });
  };
  const client400 = makeClient(fetch400, { maxAttempts: 5 });
  await assert.rejects(() => client400.generatePack({ playerAddress: PLAYER_ADDRESS }), error => {
    assert.ok(error instanceof CollectorCryptError);
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(calls400, 1, 'a 400 must never be retried');
});

test('a mutation request carries an abort signal bounded by the configured timeout', async () => {
  let signal;
  const client = makeClient(async (_url, init) => {
    signal = init.signal;
    return jsonResponse(200, loadFixture('generate-pack'));
  }, { timeoutMs: 123 });

  await client.generatePack({ playerAddress: PLAYER_ADDRESS });

  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test('a mutation timeout is typed and never retried', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    const error = new Error('timeout');
    error.name = 'TimeoutError';
    throw error;
  }, { maxAttempts: 5, timeoutMs: 123 });

  await assert.rejects(
    () => client.generatePack({ playerAddress: PLAYER_ADDRESS }),
    error => error instanceof CollectorCryptTimeoutError && error.timeoutMs === 123,
  );
  assert.equal(calls, 1);
});

test('a mutation response-body timeout is typed and never retried', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        const error = new Error('response body timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    };
  }, { maxAttempts: 5, timeoutMs: 123 });

  await assert.rejects(
    () => client.generatePack({ playerAddress: PLAYER_ADDRESS }),
    error => error instanceof CollectorCryptTimeoutError && error.timeoutMs === 123,
  );
  assert.equal(calls, 1);
});

test('a GET 500 is retried (reads are always safe to retry)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(500, { error: 'internal' });
    return jsonResponse(200, loadFixture('machines'));
  };
  const client = makeClient(fetchImpl, { maxAttempts: 3 });
  const result = await client.getMachines();
  assert.equal(calls, 2);
  assert.deepEqual(result, loadFixture('machines'));
});

test('backoff delay doubles per attempt up to the configured ceiling', async () => {
  const delays = [];
  const sleep = async ms => {
    delays.push(ms);
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 4) throw new TypeError('fetch failed');
    return jsonResponse(200, loadFixture('machines'));
  };
  const client = createCollectorCryptClient({ apiKey: API_KEY, fetchImpl, sleep, maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 250 });

  await client.getMachines();

  assert.deepEqual(delays, [100, 200, 250]);
});

test('two concurrent calls for the identical mutation body collapse into one network request', async () => {
  let calls = 0;
  let resolveFetch;
  const gate = new Promise(resolve => {
    resolveFetch = resolve;
  });
  const fetchImpl = async () => {
    calls += 1;
    await gate;
    return jsonResponse(200, loadFixture('generate-pack'));
  };
  const client = makeClient(fetchImpl);

  const first = client.generatePack({ playerAddress: PLAYER_ADDRESS });
  const second = client.generatePack({ playerAddress: PLAYER_ADDRESS });
  resolveFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1, 'a second overlapping call for the same logical mutation must not hit the network again');
  assert.deepEqual(firstResult, loadFixture('generate-pack'));
  assert.deepEqual(secondResult, loadFixture('generate-pack'));
});

test('after an in-flight mutation settles, a later call for the same body is a fresh attempt', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, loadFixture('generate-pack'));
  };
  const client = makeClient(fetchImpl);

  await client.generatePack({ playerAddress: PLAYER_ADDRESS });
  await client.generatePack({ playerAddress: PLAYER_ADDRESS });

  assert.equal(calls, 2, 'a call after the prior one settled is a distinct, deliberate attempt');
});

test('a malformed (non-JSON) response surfaces as a CollectorCryptError', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, async text() { return 'not json'; } });
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.getMachines(), CollectorCryptError);
});

test('a response missing required fields surfaces as a CollectorCryptError', async () => {
  const fetchImpl = async () => jsonResponse(200, { unexpected: true });
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.getMachines(), CollectorCryptError);
});

test('error classes report the correct name and endpoint', async () => {
  const client = makeClient(async () => jsonResponse(400, { error: 'nope' }));
  await assert.rejects(() => client.generatePack({ playerAddress: PLAYER_ADDRESS }), error => {
    assert.equal(error.name, 'CollectorCryptError');
    assert.equal(error.endpoint, 'generatePack');
    assert.equal(error.status, 400);
    return true;
  });

  const dryRunClient = makeClient(async () => jsonResponse(200, {}), { dryRun: true });
  await assert.rejects(() => dryRunClient.openPack({ memo: MEMO }), error => {
    assert.equal(error.name, 'CollectorCryptDryRunRefusalError');
    assert.ok(error instanceof CollectorCryptError);
    return true;
  });
});
