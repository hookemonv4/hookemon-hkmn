// Proves that the current Relay client's return-leg intent (18 fields, including tradeType and
// quoteDigest — see relay-client.mjs RELAY_INTENT_KEYS) survives createRecordedRelayLeg's
// returnAttribution unchanged, and restores through a fresh real Relay client. Also documents
// that a historical 16-field return intent (no tradeType/quoteDigest) is a durable-replay shape
// only: the current producer's restoreIntent requires the 18-field shape and must never invent
// missing quote evidence for a legacy record.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DIRECTIONS, RelayMalformedResponseError, createRelayClient } from '../src/relay-client.mjs';
import { createRecordedRelayLeg } from '../../runner/src/cycle/money-schemas.mjs';

function loadFixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/relay/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const chainsFixture = loadFixture('chains.json');
const quoteReturnFixture = loadFixture('quote-return.json');
const RETURN_QUOTE_INPUT = Object.freeze({
  user: quoteReturnFixture.details.sender,
  recipient: quoteReturnFixture.details.recipient,
  amount: quoteReturnFixture.details.currencyIn.amount,
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

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

const CURRENT_RELAY_INTENT_FIELDS = [
  'schema', 'requestId', 'orderId', 'direction', 'tradeType', 'quoteDigest', 'originChainId',
  'destinationChainId', 'originAssetId', 'originDecimals', 'destinationAssetId', 'destinationDecimals',
  'originAmount', 'quotedDestinationAmount', 'quotedDestinationMinimumAmount', 'sender', 'recipient',
  'deadlineUnixSeconds',
].sort();

test('the real Relay client\'s current 18-field return intent survives createRecordedRelayLeg and restores unchanged into a fresh client', async () => {
  const quoteFetch = createScriptedFetch({
    'GET /chains': jsonResponse(200, chainsFixture),
    'POST /quote/v2': jsonResponse(200, quoteReturnFixture),
  });
  const producingClient = createRelayClient({ fetchImpl: quoteFetch });
  const quote = await producingClient.quoteReturnBridge(RETURN_QUOTE_INPUT);
  const prepared = producingClient.prepareExecution({ quote, liveMode: true });

  // The real producer's exact output shape: 18 fields, tradeType and quoteDigest included.
  assert.deepEqual(Object.keys(prepared.intent).sort(), CURRENT_RELAY_INTENT_FIELDS);
  assert.equal(typeof prepared.intent.tradeType, 'string');
  assert.equal(typeof prepared.intent.quoteDigest, 'string');

  const leg = createRecordedRelayLeg({
    cycleId: 'cycle-return-compat-1',
    direction: 'return',
    relayRequestId: prepared.intent.requestId,
    quoteDigest: `sha256:${'7'.repeat(64)}`,
    source: {
      chainId: String(prepared.intent.originChainId),
      assetId: prepared.intent.originAssetId,
      decimals: prepared.intent.originDecimals,
      amountAtomic: prepared.intent.originAmount,
    },
    destination: {
      chainId: String(prepared.intent.destinationChainId),
      assetId: prepared.intent.destinationAssetId,
      decimals: prepared.intent.destinationDecimals,
      amountAtomic: prepared.intent.quotedDestinationAmount,
    },
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: prepared.intent,
      requestCreatedAtUnixSeconds: '1700000000',
      maxSettlementWindowSeconds: '600',
    },
  });

  // All 18 fields survive exactly — nothing dropped, nothing synthesized.
  assert.deepEqual(Object.keys(leg.returnAttribution.intent).sort(), CURRENT_RELAY_INTENT_FIELDS);
  assert.deepEqual(leg.returnAttribution.intent, { ...prepared.intent });
  assert.equal(leg.returnAttribution.intent.tradeType, prepared.intent.tradeType);
  assert.equal(leg.returnAttribution.intent.quoteDigest, prepared.intent.quoteDigest);

  // Restore the retained (post-storage) intent into a fresh real Relay client — no provider or
  // signer mutation, just the same producer's own restoreIntent authenticating its own shape.
  const restoredClient = createRelayClient({ fetchImpl: createScriptedFetch({}) });
  const restored = restoredClient.restoreIntent({ intent: leg.returnAttribution.intent });
  assert.equal(restored.requestId, prepared.intent.requestId);
  assert.equal(restored.tradeType, prepared.intent.tradeType);
  assert.equal(restored.quoteDigest, prepared.intent.quoteDigest);
  assert.equal(restored.direction, DIRECTIONS.RETURN);
});

test('a historical 16-field return intent (no tradeType/quoteDigest) is a durable-replay shape only: the current Relay client\'s restoreIntent refuses it rather than inventing missing quote evidence', () => {
  const historicalIntent = {
    schema: 'hookemon.relay-intent.v1',
    requestId: 'relay-return-historical-1',
    orderId: `0x${'e'.repeat(64)}`,
    direction: DIRECTIONS.RETURN,
    originChainId: 792703809,
    destinationChainId: 4663,
    originAssetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    originDecimals: 6,
    destinationAssetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    destinationDecimals: 6,
    originAmount: '17',
    quotedDestinationAmount: '16',
    quotedDestinationMinimumAmount: '16',
    sender: '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto',
    recipient: '0x000000000000000000000000000000000000dead',
    deadlineUnixSeconds: 1_800_000_000,
  };
  assert.equal(Object.keys(historicalIntent).length, 16);

  // money-schemas.mjs still accepts and round-trips this historical shape for durable replay
  // (see packages/runner/test/cycle/money-schemas.test.mjs), but the current Relay client's own
  // producer contract now requires 18 fields — restoreIntent must refuse the historical shape
  // rather than fabricate a tradeType/quoteDigest that was never recorded.
  const client = createRelayClient({ fetchImpl: createScriptedFetch({}) });
  assert.throws(
    () => client.restoreIntent({ intent: historicalIntent }),
    RelayMalformedResponseError,
  );
});
