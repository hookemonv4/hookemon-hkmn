import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { keccak256, parseTransaction, encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createRelayClient, relayQuoteDigest, RelayIntentAuthenticationError, RelayQuoteExpiredError } from '../../src/relay-client.mjs';
import { createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  OutboundRecoveryRequiredError,
  createOutboundPolicySigner,
  mutateOutbound,
  prepareOutboundRequest,
  reconcileLiveOutbound,
} from '../../src/app/stages/outbound.mjs';

const EVM_ACCOUNT = '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384';
const SOLANA_ACCOUNT = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/relay/${name}`, import.meta.url)), 'utf8'));
}

const chains = fixture('chains.json');
const quoteFixture = JSON.parse(readFileSync(new URL('../native/relay-outbound-captured.json', import.meta.url), 'utf8'));
// This fixture remains a deterministic recorded EVM envelope, but the admission path below
// models an EXACT_OUTPUT quote: the requested settlement target and minimum are both 25 atomic units.
quoteFixture.details.currencyOut.amount = '25000000';
quoteFixture.details.currencyOut.minimumAmount = '25000000';
quoteFixture.protocol.v2.orderData.output.payments[0].expectedAmount = '25000000';
quoteFixture.protocol.v2.orderData.output.payments[0].minimumAmount = '25000000';
const RELAY_DEPOSITORY = quoteFixture.steps[0].items[0].data.to;

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function relayClient(quote = quoteFixture) {
  return createRelayClient({
    fetchImpl: async (url, options) => {
      if (options.method === 'GET' && url.pathname === '/chains') return response(chains);
      if (options.method === 'POST' && url.pathname === '/quote/v2') return response(quote);
      throw new Error(`unexpected Relay request ${options.method} ${url.pathname}`);
    },
  });
}

function admittedQuote(raw = quoteFixture) {
  const parsed = {
    direction: 'OUTBOUND',
    tradeType: 'EXACT_OUTPUT',
    requestId: raw.requestId,
    orderId: raw.protocol.v2.orderId,
    sender: raw.details.sender,
    recipient: raw.details.recipient,
    deadlineUnixSeconds: raw.protocol.v2.orderData.output.deadline,
    origin: {
      chainId: 4663,
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      amount: raw.details.currencyIn.amount,
    },
    destination: {
      chainId: 792703809,
      address: SOLANA_MINT,
      decimals: 6,
      amount: raw.details.currencyOut.amount,
      minimumAmount: raw.details.currencyOut.minimumAmount,
    },
    raw,
  };
  return { ...parsed, quoteDigest: relayQuoteDigest(parsed) };
}

function admission(cycleId, quote = admittedQuote()) {
  const eth = { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: quote.origin.amount };
  const destinationAsset = { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: quote.destination.amount };
  return {
    schema: 'hookemon.policy-admission.v3',
    cycleId,
    quoteDigest: quote.quoteDigest,
    quantity: 1,
    unitFundingQuote: eth,
    aggregateFundingQuote: eth,
    aggregatePurchase: destinationAsset,
    relay: {
      tradeType: 'EXACT_OUTPUT',
      requestId: quote.requestId,
      orderId: quote.orderId,
      deadlineUnixSeconds: quote.deadlineUnixSeconds,
      sender: quote.sender,
      recipient: quote.recipient,
      destinationAmount: destinationAsset.amountAtomic,
      destinationMinimumAmount: destinationAsset.amountAtomic,
    },
    relayQuote: quote,
  };
}

function repository(releaseAmount = quoteFixture.details.currencyIn.amount) {
  return { async describeCycle(cycleId) { return { releaseAmount, admission: admission(cycleId) }; } };
}

test('prepareOutboundRequest refuses an absent MoneyConfigurationV2 before requesting a Relay quote', async () => {
  let quoteCalls = 0;
  const adapters = {
    relay: {
      async quoteOutboundBridge() {
        quoteCalls += 1;
        throw new Error('Relay must not be queried without MoneyConfigurationV2');
      },
    },
  };
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters,
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      },
      cycleRepository: repository(),
      context: { cycleId: 'cycle-outbound-missing-money-configuration' },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /requires MoneyConfigurationV2/,
  );
  assert.equal(quoteCalls, 0);
});

test('prepareOutboundRequest binds the same cycle reserve to the configured Solana mint and preserves every recorded EVM Relay step', async () => {
  const request = await prepareOutboundRequest({
    adapters: { relay: relayClient() },
    config: {
      chainId: 4663,
      accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      moneyConfiguration: moneyConfiguration(),
    },
    cycleRepository: repository(),
    context: { cycleId: 'cycle-outbound-1' },
    nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
  });
  assert.equal(request.schema, 'hookemon.outbound-relay-request.v2');
  assert.deepEqual(request.inputAmount, {
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    amountAtomic: quoteFixture.details.currencyIn.amount,
  });
  assert.deepEqual(request.destinationAmount, {
    chainId: '792703809',
    assetId: SOLANA_MINT,
    decimals: 6,
    amountAtomic: quoteFixture.details.currencyOut.amount,
  });
  assert.equal(request.intent.requestId, quoteFixture.requestId);
  assert.equal(request.transactions.length, 1);
  assert.deepEqual(request.transactions.map(transaction => transaction.transaction), [
    quoteFixture.steps[0].items[0].data,
  ]);
});

test('prepareOutboundRequest consumes the admitted exact-output quote without requoting and refuses a short minimum output', async () => {
  const shortQuote = admittedQuote();
  shortQuote.destination.minimumAmount = '49999999';
  const cycleId = 'cycle-outbound-admission-shortfall';
  let requoteCalls = 0;
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: {
        relay: {
          async quoteOutboundBridge() { requoteCalls += 1; throw new Error('must not requote'); },
          prepareExecution() { throw new Error('must not prepare a short quote'); },
        },
      },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository: { async describeCycle() { return { releaseAmount: quoteFixture.details.currencyIn.amount, admission: admission(cycleId, shortQuote) }; } },
      context: { cycleId },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /differs from the durable policy admission/,
  );
  assert.equal(requoteCalls, 0);
});

test('prepareOutboundRequest refuses a context admission that differs from the repository-owned quote or reserve', async () => {
  const cycleId = 'cycle-outbound-context-conflict';
  const durable = admission(cycleId);
  const conflicting = structuredClone(durable);
  conflicting.quoteDigest = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: { relay: relayClient() },
      config: { chainId: 4663, accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT }, relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY }, moneyConfiguration: moneyConfiguration() },
      cycleRepository: { async describeCycle() { return { releaseAmount: durable.aggregateFundingQuote.amountAtomic, admission: durable }; } },
      context: { cycleId, admission: conflicting },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /context admission conflicts/,
  );
});

test('prepareOutboundRequest fails closed when the exact configured Solana mint does not match the quote', async () => {
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: { relay: relayClient() },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: `e${SOLANA_MINT.slice(1)}`, evmDepository: RELAY_DEPOSITORY },
        moneyConfiguration: moneyConfiguration({ solanaMint: `e${SOLANA_MINT.slice(1)}` }),
      },
      cycleRepository: repository(),
      context: { cycleId: 'cycle-outbound-2' },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /asset identity/,
  );
});

test('prepareOutboundRequest rejects a recorded-shaped Relay transaction whose depository is outside the explicit allowlist', async () => {
  const altered = structuredClone(quoteFixture);
  altered.steps[0].items[0].data.to = `0x${'9'.repeat(40)}`;
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: { relay: relayClient(altered) },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository: { async describeCycle(cycleId) { return { releaseAmount: altered.details.currencyIn.amount, admission: admission(cycleId, admittedQuote(altered)) }; } },
      context: { cycleId: 'cycle-outbound-depository' },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /native outbound deposit target\/value differs from the bound principal/,
  );
});

/**
 * `admission()` above omits `unitRelay`/`quoteDigest`-on-`relay` fields no other outbound.mjs check
 * needs, but ADR-0025 `refresh-after-readmission` evidence binds both admitted quote identities.
 * This augments it with exactly those fields for the tests below.
 */
function refreshableAdmission(cycleId, { quote = admittedQuote() } = {}) {
  const base = admission(cycleId, quote);
  return {
    ...base,
    relay: { ...base.relay, quoteDigest: quote.quoteDigest },
    unitRelay: {
      requestId: `unit-${quote.requestId}`,
      deadlineUnixSeconds: quote.deadlineUnixSeconds,
      quoteDigest: `sha256:${'9'.repeat(64)}`,
    },
  };
}

test('prepareOutboundRequest records ADR-0025 outbound quote expiry evidence exactly once before any effect, then rethrows the typed error', async () => {
  const cycleId = 'cycle-outbound-quote-expired';
  const deadline = quoteFixture.protocol.v2.orderData.output.deadline;
  const durable = refreshableAdmission(cycleId);
  const expiryCalls = [];
  const cycleRepository = {
    async describeCycle() { return { releaseAmount: durable.aggregateFundingQuote.amountAtomic, admission: durable }; },
    async readOutboundQuoteRefresh() { return null; },
    async recordOutboundQuoteExpired(id, evidence) { expiryCalls.push({ id, evidence }); },
  };
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: { relay: relayClient() },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository,
      context: { cycleId },
      nowMs: deadline * 1000,
    }),
    RelayQuoteExpiredError,
  );
  assert.equal(expiryCalls.length, 1);
  assert.equal(expiryCalls[0].id, cycleId);
  assert.deepEqual(expiryCalls[0].evidence, {
    schema: 'hookemon.outbound-quote-expiry-evidence.v1',
    cycleId,
    admissionDigest: digest(durable),
    aggregateQuote: {
      requestId: durable.relay.requestId,
      deadlineUnixSeconds: durable.relay.deadlineUnixSeconds,
      quoteDigest: durable.relay.quoteDigest,
    },
    unitQuote: {
      requestId: durable.unitRelay.requestId,
      deadlineUnixSeconds: durable.unitRelay.deadlineUnixSeconds,
      quoteDigest: durable.unitRelay.quoteDigest,
    },
    observedAtMs: deadline * 1000,
  });
});

test('prepareOutboundRequest does not record a second expiry once REFRESH_REQUIRED is already durable', async () => {
  const cycleId = 'cycle-outbound-quote-already-expired';
  const deadline = quoteFixture.protocol.v2.orderData.output.deadline;
  const durable = refreshableAdmission(cycleId);
  const cycleRepository = {
    async describeCycle() { return { releaseAmount: durable.aggregateFundingQuote.amountAtomic, admission: durable }; },
    async readOutboundQuoteRefresh() { return { state: 'REFRESH_REQUIRED', expiryDigest: `sha256:${'7'.repeat(64)}` }; },
    async recordOutboundQuoteExpired() { throw new Error('must not record a second expiry while REFRESH_REQUIRED'); },
  };
  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: { relay: relayClient() },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository,
      context: { cycleId },
      nowMs: deadline * 1000,
    }),
    RelayQuoteExpiredError,
  );
});

test('prepareOutboundRequest signs the ACTIVE selected replacement instead of the expired original admission', async () => {
  const cycleId = 'cycle-outbound-quote-refreshed';
  const original = refreshableAdmission(cycleId);
  const originalDeadline = original.relay.deadlineUnixSeconds;

  const replacementRaw = structuredClone(quoteFixture);
  replacementRaw.protocol.v2.orderData.output.deadline = originalDeadline + 10_000;
  const replacement = refreshableAdmission(cycleId, { quote: admittedQuote(replacementRaw) });

  const cycleRepository = {
    async describeCycle() { return { releaseAmount: original.aggregateFundingQuote.amountAtomic, admission: original }; },
    async readOutboundQuoteRefresh() { return { state: 'ACTIVE', replacement }; },
    async recordOutboundQuoteExpired() { throw new Error('must not record expiry once a replacement is already active'); },
    async holdCycle() { throw new Error('must not hold while the active replacement is still fresh'); },
  };

  const request = await prepareOutboundRequest({
    adapters: { relay: relayClient() },
    config: {
      chainId: 4663,
      accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      moneyConfiguration: moneyConfiguration(),
    },
    cycleRepository,
    context: { cycleId },
    // Past the original (immutable, durable) deadline -- the original admission would throw
    // RelayQuoteExpiredError here if it, rather than the ACTIVE replacement, were used.
    nowMs: (originalDeadline * 1000) + 1,
  });
  assert.equal(request.intent.requestId, replacement.relay.requestId);
});

test('prepareOutboundRequest holds the cycle for an owner decision when the selected replacement itself expires before preparation', async () => {
  const cycleId = 'cycle-outbound-replacement-expired';
  const original = refreshableAdmission(cycleId);
  const originalDeadline = original.relay.deadlineUnixSeconds;
  const replacementRaw = structuredClone(quoteFixture);
  replacementRaw.protocol.v2.orderData.output.deadline = originalDeadline + 1;
  const replacement = refreshableAdmission(cycleId, { quote: admittedQuote(replacementRaw) });
  const holdCalls = [];
  const cycleRepository = {
    async describeCycle() { return { releaseAmount: original.aggregateFundingQuote.amountAtomic, admission: original }; },
    async readOutboundQuoteRefresh() { return { state: 'ACTIVE', replacement }; },
    async recordOutboundQuoteExpired() { throw new Error('must not record a fresh expiry for an already-active replacement'); },
    async holdCycle(id, terminalState, evidence) { holdCalls.push({ id, terminalState, evidence }); },
  };

  await assert.rejects(
    () => prepareOutboundRequest({
      adapters: { relay: relayClient() },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository,
      context: { cycleId },
      // Past both the original and the replacement's deadlines.
      nowMs: (originalDeadline + 1) * 1000,
    }),
    RelayQuoteExpiredError,
  );
  assert.equal(holdCalls.length, 1);
  assert.equal(holdCalls[0].id, cycleId);
  assert.equal(holdCalls[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(holdCalls[0].evidence.stage, 'outbound');
  assert.equal(holdCalls[0].evidence.reason, 'OUTBOUND_QUOTE_REFRESH_REPLACEMENT_EXPIRED');
});

test('createOutboundPolicySigner refuses an unsigned Relay plan until a journal-owned EVM nonce is available', async () => {
  const request = await prepareOutboundRequest({
    adapters: { relay: relayClient() },
    config: {
      chainId: 4663,
      accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      moneyConfiguration: moneyConfiguration(),
    },
    cycleRepository: repository(),
    context: { cycleId: 'cycle-outbound-policy' },
    nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
  });
  const plan = request.transactions[0];
  let signCalls = 0;
  await assert.rejects(
    () => createOutboundPolicySigner({
      signerClient: {
        role: 'operator-evm',
        async sign() { signCalls += 1; return { signedTx: '0x01' }; },
        async broadcast() { throw new Error('broadcast must not be reached'); },
      },
      plan,
      operationsAccount: EVM_ACCOUNT,
    }),
    /reserved EVM nonce/,
  );
  assert.equal(signCalls, 0);
});

test('createOutboundPolicySigner refuses a verified Relay plan after its recorded quote deadline', async () => {
  const request = await prepareOutboundRequest({
    adapters: { relay: relayClient() },
    config: {
      chainId: 4663,
      accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      moneyConfiguration: moneyConfiguration(),
    },
    cycleRepository: repository(),
    context: { cycleId: 'cycle-outbound-expired-policy' },
    nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
  });
  let signCalls = 0;
  await assert.rejects(
    () => createOutboundPolicySigner({
      signerClient: {
        role: 'operator-evm',
        async sign() { signCalls += 1; return { signedTx: '0x01' }; },
        async broadcast() { throw new Error('broadcast must not be reached'); },
      },
      plan: request.transactions[0],
      operationsAccount: EVM_ACCOUNT,
      now: () => quoteFixture.protocol.v2.orderData.output.deadline * 1000,
    }),
    /expired/,
  );
  assert.equal(signCalls, 0);
});

test('createOutboundPolicySigner refuses the provisional authority before either signing or broadcasting', async () => {
  const quote = structuredClone(quoteFixture);
  quote.steps[0].items[0].data.nonce = '7';
  const nowMs = (quote.protocol.v2.orderData.output.deadline * 1000) - 1;
  const request = await prepareOutboundRequest({
    adapters: { relay: relayClient(quote) },
    config: {
      chainId: 4663,
      accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      moneyConfiguration: moneyConfiguration(),
    },
    cycleRepository: { async describeCycle(cycleId) { return { releaseAmount: quote.details.currencyIn.amount, admission: admission(cycleId, admittedQuote(quote)) }; } },
    context: { cycleId: 'cycle-outbound-authority' },
    nowMs,
  });
  let signCalls = 0;
  let broadcastCalls = 0;
  const policySigner = await createOutboundPolicySigner({
    signerClient: {
      role: 'operator-evm',
      async sign() { signCalls += 1; return { signedTx: '0x01' }; },
      async broadcast() { broadcastCalls += 1; return { transactionHash: '0x01' }; },
    },
    plan: request.transactions[0],
    operationsAccount: EVM_ACCOUNT,
    now: () => nowMs,
  });

  await assert.rejects(
    () => policySigner.signer.sign(request.transactions[0].transaction),
    /active frozen interface authority is invalid/,
  );
  await assert.rejects(
    () => policySigner.signer.broadcast({ signedTx: '0x01' }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(signCalls, 0);
  assert.equal(broadcastCalls, 0);
});

function outboundIntent() {
  return {
    schema: 'hookemon.relay-intent.v2',
    requestId: quoteFixture.requestId,
    orderId: quoteFixture.protocol.v2.orderId,
    direction: 'OUTBOUND',
    tradeType: 'EXACT_OUTPUT',
    quoteDigest: admittedQuote().quoteDigest,
    originChainId: 4663,
    destinationChainId: 792703809,
    originAssetId: 'native',
    originDecimals: 18,
    destinationAssetId: SOLANA_MINT,
    destinationDecimals: 6,
    originAmount: quoteFixture.details.currencyIn.amount,
    quotedDestinationAmount: quoteFixture.details.currencyOut.amount,
    quotedDestinationMinimumAmount: quoteFixture.details.currencyOut.minimumAmount,
    sender: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address,
    recipient: SOLANA_ACCOUNT,
    deadlineUnixSeconds: quoteFixture.protocol.v2.orderData.output.deadline,
  };
}

function solanaClientWithCredit(amount) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'getTransaction');
      return response({
        jsonrpc: '2.0',
        id: 1,
        result: {
          transaction: { message: { accountKeys: ['TokenAccount1111111111111111111111111111111'] } },
          meta: {
            preTokenBalances: [{ accountIndex: 0, mint: SOLANA_MINT, owner: SOLANA_ACCOUNT, uiTokenAmount: { amount: '0' } }],
            postTokenBalances: [{ accountIndex: 0, mint: SOLANA_MINT, owner: SOLANA_ACCOUNT, uiTokenAmount: { amount } }],
          },
        },
      });
    },
  });
}

const signedNativeDeposits = new Map();
async function signNativeOutboundSource() {
  const quote = quoteForOperationsAccount(OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT);
  const plan = quote.steps[0].items[0].data;
  const rawBytes = await OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.signTransaction({ chainId: 4663, to: plan.to,
    data: plan.data, value: BigInt(plan.value), nonce: 9, gas: 120000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const hash = keccak256(rawBytes);
  signedNativeDeposits.set(hash, rawBytes);
  return { rawBytes, hash };
}
function nativeCustodyRow() {
  return { schema: 'hookemon.custody-ledger.v3', cycleId: 'cycle-outbound-reconcile', chainId: '4663', assetId: 'native', decimals: 18,
    claimed: quoteFixture.details.currencyIn.amount, bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0', returnInput: '0',
    returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0', heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
    gasReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000000' },
    gasSpent: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' }, gasPayments: [], verifiedCurrentBalance: null, expectedCycleAsset: null };
}
function nativeRefundBinding() {
  return createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663',
    relay: { schema: 'hookemon.relay-native-route.v1', emitter: RELAY_DEPOSITORY, runtimeHash: keccak256('0x6000'), metadataEncoding: 'order-id', refundsSupported: true } }, TEST_PREFLIGHT_AUTHORITY);
}

function finalizedOutboundSourceClient({ transactionHash }) {
  const receiptBlockHash = `0x${'a'.repeat(64)}`;
  const parentBlockHash = `0x${'b'.repeat(64)}`;
  const finalizedBlockHash = `0x${'c'.repeat(64)}`;
  const receipt = {
    transactionHash,
    blockNumber: 100n,
    blockHash: receiptBlockHash,
    status: 'success',
    logs: [], gasUsed: 100000n, effectiveGasPrice: 2n,
  };
  const signed = parseTransaction(signedNativeDeposits.get(transactionHash));
  return {
    async getChainId() { return 4663; },
    async getCode() { return '0x6000'; },
    async getTransaction() { return { hash: transactionHash, from: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, to: signed.to, input: signed.data, value: signed.value, nonce: signed.nonce, blockNumber: 100n, blockHash: receiptBlockHash }; },
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, transactionHash);
      return structuredClone(receipt);
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized' || blockNumber === 101n) return { number: 101n, hash: finalizedBlockHash, timestamp: 1_700_000_090n };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, parentHash: parentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: parentBlockHash, parentHash: `0x${'d'.repeat(64)}`, timestamp: 1_700_000_070n };
      throw new Error(`unexpected outbound source block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

function finalizedOutboundSourceAndRefundClient({ sourceTransactionHash, refundTransactionHash, refundTransfers }) {
  const source = finalizedOutboundSourceClient({ amountAtomic: quoteFixture.details.currencyIn.amount, transactionHash: sourceTransactionHash });
  const refundBlockHash = `0x${'d'.repeat(64)}`, finalizedHash = `0x${'c'.repeat(64)}`;
  const receipt = { transactionHash: refundTransactionHash, blockNumber: 102n, blockHash: refundBlockHash, status: 'success',
    logs: refundTransfers.map(({ token = '0x0000000000000000000000000000000000000000', source = RELAY_DEPOSITORY,
      recipient = OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, amountAtomic }, index) => ({ address: RELAY_DEPOSITORY,
      transactionHash: refundTransactionHash, blockHash: refundBlockHash, blockNumber: 102n, logIndex: index,
      topics: encodeEventTopics({ abi: parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']), eventName: 'FundsMovement' }),
      data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
        [source, recipient, token, BigInt(amountAtomic), quoteFixture.protocol.v2.orderId]) })) };
  return { ...source,
    async getTransactionReceipt({ hash }) { return hash === refundTransactionHash ? structuredClone(receipt) : source.getTransactionReceipt({ hash }); },
    async getBlock(args) {
      if (args.blockTag === 'finalized' || args.blockNumber === 103n) return { number: 103n, hash: finalizedHash, timestamp: 1700000110n };
      if (args.blockNumber === 102n) return { number: 102n, hash: refundBlockHash, timestamp: 1700000100n };
      return source.getBlock(args);
    },
  };
}

function outboundArchiveEvidence() {
  return { async readNativeBalanceAtBlock({ blockNumber, blockHash }) { return { value: 1000000000000000000n, blockNumber, blockHash }; } };
}

function discoveredOutboundDestinationClient({ relayRequestId, mint, amountAtomic }) {
  const signature = 'relay-destination-observation';
  const calls = [];
  const client = createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.method);
      if (body.method === 'getSignaturesForAddress') {
        return response({
          jsonrpc: '2.0',
          id: body.id,
          result: [{ signature, err: null }],
        });
      }
      if (body.method === 'getTransaction') {
        return response({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            slot: 88,
            blockTime: 1_700_000_100,
            transaction: {
              message: {
                accountKeys: ['TokenAccount1111111111111111111111111111111'],
                instructions: [{ program: 'spl-memo', parsed: relayRequestId }],
              },
            },
            meta: {
              err: null,
              preTokenBalances: [{
                accountIndex: 0,
                mint,
                owner: SOLANA_ACCOUNT,
                uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' },
              }],
              postTokenBalances: [{
                accountIndex: 0,
                mint,
                owner: SOLANA_ACCOUNT,
                uiTokenAmount: { amount: (100n + BigInt(amountAtomic)).toString(), decimals: 6, uiAmountString: '0.0001' },
              }],
            },
          },
        });
      }
      throw new Error(`unexpected Solana RPC ${body.method}`);
    },
  });
  return { client, calls, signature };
}

function originRefundRelayClient(refundTxHash) {
  return createRelayClient({
    fetchImpl: async (url, options) => {
      if (options.method === 'GET' && url.pathname === '/intents/status/v3') {
        return response({
          status: 'refund',
          originChainId: 4663,
          destinationChainId: 792703809,
          inTxHashes: [`0x${'a'.repeat(64)}`],
          txHashes: [refundTxHash],
        });
      }
      throw new Error(`unexpected Relay request ${options.method} ${url.pathname}`);
    },
  });
}

async function outboundReconciliationRepository({
  transactionHash,
  relayRequestId,
  destinationAmountAtomic,
  quoteDeadlineUnixSeconds = null,
  relayIntent = null,
}) {
  let sourceRecord = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId: 'cycle-outbound-reconcile',
      stage: 'outbound',
      state: 'BROADCAST',
      requestDigest: `sha256:${'e'.repeat(64)}`,
      rawBytes: signedNativeDeposits.get(transactionHash),
      nonce: '9',
      blockhash: null,
      hash: transactionHash,
    },
  };
  let custody = nativeCustodyRow();
  const leg = {
    schema: 'hookemon.relay-leg.v2',
    cycleId: 'cycle-outbound-reconcile',
    direction: 'outbound',
    relayRequestId,
    quoteDigest: `sha256:${'f'.repeat(64)}`,
    sourceChainId: '4663',
    sourceTxHash: transactionHash,
    sourceAssetId: 'native',
    sourceDecimals: 18,
    sourceAmountAtomic: quoteFixture.details.currencyIn.amount,
    destinationChainId: '792703809',
    destinationTxHash: null,
    destinationAssetId: SOLANA_MINT,
    destinationDecimals: 6,
    destinationAmountAtomic,
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
  };
  const finalities = [];
  const settlements = [];
  const recoverySelectors = [];
  const walletReleases = [];
  return {
    get finalities() { return structuredClone(finalities); },
    get settlements() { return structuredClone(settlements); },
    get recoverySelectors() { return structuredClone(recoverySelectors); },
    get walletReleases() { return structuredClone(walletReleases); },
    get sourceAttemptState() { return sourceRecord.attempt.state; },
    async describeCycle() {
      return {
        custodyLedgers: new Map([['4663\u0000native', custody]]),
        relayLegs: new Map([[relayRequestId, structuredClone(leg)]]),
        chainAttempts: new Map([
          [`outbound\u0000${sourceRecord.attempt.requestDigest}`, structuredClone(sourceRecord)],
        ]),
      };
    },
    async recordCustodyLedger(_cycleId, row) { custody = row; },
    async recordBroadcast() {
      throw new Error('a broadcast attempt must not be rebroadcast during finality reconciliation');
    },
    async recordFinality(_cycleId, stage, requestDigest, evidence) {
      assert.equal(stage, 'outbound');
      assert.equal(requestDigest, sourceRecord.attempt.requestDigest);
      finalities.push(structuredClone(evidence));
      sourceRecord = { ...sourceRecord, attempt: { ...sourceRecord.attempt, state: 'FINALIZED' } };
      return structuredClone(sourceRecord);
    },
    async settleRelayLeg(cycleId, requestId, settlement) {
      assert.equal(cycleId, 'cycle-outbound-reconcile');
      assert.equal(requestId, relayRequestId);
      const { sourceProof, destinationObservation, refundProof } = settlement;
      let terminalState;
      let normalizedSettlement;
      if (refundProof !== undefined) {
        assert.equal(destinationObservation, undefined);
        terminalState = 'HELD_RELAY_REFUND';
        normalizedSettlement = {
          sourceFinality: {
            height: sourceProof.blockNumber,
            hash: sourceProof.blockHash,
            timestampUnixSeconds: sourceProof.timestampUnixSeconds,
          },
          destinationTxHash: refundProof.refundTxHash,
          destinationFinality: refundProof.refundFinality,
          netDeltaAtomic: refundProof.observedAmountAtomic,
          attribution: refundProof.terminalStatus,
          terminalState,
          refundProof: structuredClone(refundProof),
        };
      } else if (destinationObservation.mint !== leg.destinationAssetId) {
        terminalState = 'HELD_RELAY_WRONG_ASSET';
      } else if (destinationObservation.netDeltaAtomic !== leg.destinationAmountAtomic) {
        terminalState = 'HELD_RELAY_PARTIAL';
      } else {
        const sourceTimestamp = BigInt(sourceProof.timestampUnixSeconds);
        const destinationTimestamp = BigInt(destinationObservation.finality.timestampUnixSeconds);
        const deadline = BigInt(quoteDeadlineUnixSeconds);
        terminalState = destinationTimestamp >= sourceTimestamp && destinationTimestamp <= deadline
          ? 'SETTLED'
          : 'HELD_RELAY_LATE';
      }
      if (normalizedSettlement === undefined) {
        normalizedSettlement = {
          sourceFinality: {
            height: sourceProof.blockNumber,
            hash: sourceProof.blockHash,
            timestampUnixSeconds: sourceProof.timestampUnixSeconds,
          },
          destinationTxHash: destinationObservation.transactionHash,
          destinationFinality: destinationObservation.finality,
          netDeltaAtomic: destinationObservation.netDeltaAtomic,
          attribution: destinationObservation.attribution,
          terminalState,
        };
      }
      settlements.push(structuredClone(normalizedSettlement));
      Object.assign(leg, {
        destinationTxHash: normalizedSettlement.destinationTxHash,
        finalizedAtSource: normalizedSettlement.sourceFinality,
        finalizedAtDestination: normalizedSettlement.destinationFinality,
        netDeltaAtomic: normalizedSettlement.netDeltaAtomic,
        state: normalizedSettlement.terminalState,
      });
      return structuredClone(leg);
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      recoverySelectors.push(structuredClone(selector));
      return {
        ...(quoteDeadlineUnixSeconds === null ? {} : { relayQuoteDeadlineUnixSeconds: quoteDeadlineUnixSeconds }),
        relayIntent: structuredClone(relayIntent ?? { ...outboundIntent(), requestId: relayRequestId }),
      };
    },
    async releaseWalletNonce(cycleId, reservation) {
      walletReleases.push({ cycleId, reservation: structuredClone(reservation) });
    },
  };
}

test('reconcileLiveOutbound records own-RPC source finality and classifies only observed destination mismatches', async () => {
  const sourceTransactionHash = (await signNativeOutboundSource()).hash;
  const relayRequestId = 'relay-outbound-reconcile';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  const cases = [
    {
      name: 'exact destination credit lacks a persisted attribution window',
      mint: SOLANA_MINT,
      amountAtomic: destinationAmountAtomic,
      terminalState: null,
    },
    {
      name: 'wrong asset',
      mint: 'So11111111111111111111111111111111111111112',
      amountAtomic: destinationAmountAtomic,
      terminalState: 'HELD_RELAY_WRONG_ASSET',
    },
    {
      name: 'partial credit',
      mint: SOLANA_MINT,
      amountAtomic: (BigInt(destinationAmountAtomic) - 1n).toString(),
      terminalState: 'HELD_RELAY_PARTIAL',
    },
  ];

  for (const fixtureCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const cycleRepository = await outboundReconciliationRepository({
      transactionHash: sourceTransactionHash,
      relayRequestId,
      destinationAmountAtomic,
    });
    const destination = discoveredOutboundDestinationClient({
      relayRequestId,
      mint: fixtureCase.mint,
      amountAtomic: fixtureCase.amountAtomic,
    });
    const result = await reconcileLiveOutbound({
      adapters: {
        robinhood: {
          client: finalizedOutboundSourceClient({
            amountAtomic: quoteFixture.details.currencyIn.amount,
            transactionHash: sourceTransactionHash,
          }),
          historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }),
        },
        solana: { client: destination.client },
      },
      config: {
        nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      },
      cycleRepository,
      context: {
        cycleId: 'cycle-outbound-reconcile',
        fencingToken: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(result, null, fixtureCase.name);
    assert.equal(cycleRepository.sourceAttemptState, 'FINALIZED', fixtureCase.name);
    assert.equal(cycleRepository.finalities.length, 1, fixtureCase.name);
    assert.deepEqual(cycleRepository.finalities[0].finalizedAtSource, {
      height: '100', hash: `0x${'a'.repeat(64)}`, timestampUnixSeconds: '1700000080',
    }, fixtureCase.name);
    assert.equal(destination.calls.includes('getSignaturesForAddress'), true, fixtureCase.name);
    assert.equal(destination.calls.includes('getTransaction'), true, fixtureCase.name);
    assert.deepEqual(cycleRepository.walletReleases, [{
      cycleId: 'cycle-outbound-reconcile',
      reservation: {
        chainId: '4663',
        wallet: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address.toLowerCase(),
        stage: 'outbound',
        fencingToken: '11111111-1111-4111-8111-111111111111',
        leaseAcquiredAtMs: 0,
        leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
      },
    }], fixtureCase.name);
    if (fixtureCase.terminalState === null) {
      assert.deepEqual(cycleRepository.settlements, [], fixtureCase.name);
    } else {
      assert.equal(cycleRepository.settlements.length, 1, fixtureCase.name);
      assert.equal(cycleRepository.settlements[0].terminalState, fixtureCase.terminalState, fixtureCase.name);
      assert.equal(cycleRepository.settlements[0].destinationTxHash, destination.signature, fixtureCase.name);
    }
  }
});

test('reconcileLiveOutbound holds a request-bound origin refund credit observed through Robinhood RPC', async () => {
  const sourceTransactionHash = (await signNativeOutboundSource()).hash;
  const refundTransactionHash = `0x${'5'.repeat(64)}`;
  const relayRequestId = quoteFixture.requestId;
  const refundAmountAtomic = '24500000';
  const cycleRepository = await outboundReconciliationRepository({
    transactionHash: sourceTransactionHash,
    relayRequestId,
    destinationAmountAtomic: quoteFixture.details.currencyOut.amount,
    quoteDeadlineUnixSeconds: String(outboundIntent().deadlineUnixSeconds),
    relayIntent: outboundIntent(),
  });
  const result = await reconcileLiveOutbound({
    adapters: {
      robinhood: {
        client: finalizedOutboundSourceAndRefundClient({
          sourceTransactionHash,
          refundTransactionHash,
          refundTransfers: [{ amountAtomic: refundAmountAtomic }],
        }),
        historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }),
      },
      relay: originRefundRelayClient(refundTransactionHash),
    },
    config: {
      nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
    },
    cycleRepository,
    context: {
      cycleId: 'cycle-outbound-reconcile',
      fencingToken: '11111111-1111-4111-8111-111111111111',
    },
  });

  assert.equal(result, null);
  assert.equal(cycleRepository.sourceAttemptState, 'FINALIZED');
  assert.equal(cycleRepository.settlements.length, 1);
  const [settlement] = cycleRepository.settlements;
  assert.equal(settlement.terminalState, 'HELD_RELAY_REFUND');
  assert.equal(settlement.destinationTxHash, refundTransactionHash);
  assert.equal(settlement.netDeltaAtomic, refundAmountAtomic);
  const { nativePaymentProof, ...refundIdentity } = settlement.refundProof;
  assert.equal(nativePaymentProof.kind, 'relay-refund');
  assert.equal(nativePaymentProof.amountWei, refundAmountAtomic);
  assert.deepEqual(refundIdentity, {
    schema: 'hookemon.outbound-relay-origin-refund-proof.v2',
    sourceDepository: RELAY_DEPOSITORY.toLowerCase(),
    relayRequestId,
    terminalStatus: { status: 'REFUND', refundTxHash: refundTransactionHash },
    sourceTxHash: sourceTransactionHash,
    sourceFinality: {
      height: '100',
      hash: `0x${'a'.repeat(64)}`,
      timestampUnixSeconds: '1700000080',
    },
    refundTxHash: refundTransactionHash,
    refundFinality: {
      height: '102',
      hash: `0x${'d'.repeat(64)}`,
      timestampUnixSeconds: '1700000100',
    },
    transferCount: 1,
    observedToken: 'native',
    observedSource: RELAY_DEPOSITORY.toLowerCase(),
    observedRecipient: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address.toLowerCase(),
    observedAmountAtomic: refundAmountAtomic,
  });
});

test('reconcileLiveOutbound rejects an origin refund credit that was not sent by the durable Relay depository', async () => {
  const sourceTransactionHash = (await signNativeOutboundSource()).hash;
  const refundTransactionHash = `0x${'1'.repeat(64)}`;
  const relayRequestId = quoteFixture.requestId;
  const cycleRepository = await outboundReconciliationRepository({
    transactionHash: sourceTransactionHash,
    relayRequestId,
    destinationAmountAtomic: quoteFixture.details.currencyOut.amount,
    quoteDeadlineUnixSeconds: String(outboundIntent().deadlineUnixSeconds),
    relayIntent: outboundIntent(),
  });

  const result = await reconcileLiveOutbound({
    adapters: {
      robinhood: {
        client: finalizedOutboundSourceAndRefundClient({
          sourceTransactionHash,
          refundTransactionHash,
          refundTransfers: [{ source: `0x${'f'.repeat(40)}`, amountAtomic: '24500000' }],
        }),
        historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }),
      },
      relay: originRefundRelayClient(refundTransactionHash),
    },
    config: {
      nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
    },
    cycleRepository,
    context: {
      cycleId: 'cycle-outbound-reconcile',
      fencingToken: '11111111-1111-4111-8111-111111111111',
    },
  });

  assert.equal(result, null);
  assert.equal(cycleRepository.sourceAttemptState, 'FINALIZED');
  assert.equal(cycleRepository.settlements.length, 0);
});

test('reconcileLiveOutbound does not treat a Solana debit as a refund without one exact origin credit', async () => {
  const sourceTransactionHash = (await signNativeOutboundSource()).hash;
  const refundTransactionHash = `0x${'3'.repeat(64)}`;
  const relayRequestId = quoteFixture.requestId;
  const cycleRepository = await outboundReconciliationRepository({
    transactionHash: sourceTransactionHash,
    relayRequestId,
    destinationAmountAtomic: quoteFixture.details.currencyOut.amount,
    quoteDeadlineUnixSeconds: String(outboundIntent().deadlineUnixSeconds),
    relayIntent: outboundIntent(),
  });
  const destination = discoveredOutboundDestinationClient({
    relayRequestId,
    mint: SOLANA_MINT,
    amountAtomic: '-1',
  });

  const result = await reconcileLiveOutbound({
    adapters: {
      robinhood: {
        client: finalizedOutboundSourceAndRefundClient({
          sourceTransactionHash,
          refundTransactionHash,
          refundTransfers: [{ amountAtomic: '24500000' }, { amountAtomic: '1' }],
        }),
        historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }),
      },
      relay: originRefundRelayClient(refundTransactionHash),
      solana: { client: destination.client },
    },
    config: {
      nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
    },
    cycleRepository,
    context: {
      cycleId: 'cycle-outbound-reconcile',
      fencingToken: '11111111-1111-4111-8111-111111111111',
    },
  });

  assert.equal(result, null);
  assert.equal(cycleRepository.sourceAttemptState, 'FINALIZED');
  assert.deepEqual(cycleRepository.settlements, []);
  assert.equal(destination.calls.includes('getTransaction'), true);
});

test('reconcileLiveOutbound settles an exact credit only inside its signed-attempt deadline and records late credits durably', async () => {
  const sourceTransactionHash = (await signNativeOutboundSource()).hash;
  const relayRequestId = 'relay-outbound-reconcile-window';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  const cases = [
    { name: 'inside', quoteDeadlineUnixSeconds: '1700000200', terminalState: 'SETTLED' },
    { name: 'late', quoteDeadlineUnixSeconds: '1700000099', terminalState: 'HELD_RELAY_LATE' },
  ];

  for (const fixtureCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const cycleRepository = await outboundReconciliationRepository({
      transactionHash: sourceTransactionHash,
      relayRequestId,
      destinationAmountAtomic,
      quoteDeadlineUnixSeconds: fixtureCase.quoteDeadlineUnixSeconds,
    });
    const destination = discoveredOutboundDestinationClient({
      relayRequestId,
      mint: SOLANA_MINT,
      amountAtomic: destinationAmountAtomic,
    });

    const result = await reconcileLiveOutbound({
      adapters: {
        robinhood: {
          client: finalizedOutboundSourceClient({
            amountAtomic: quoteFixture.details.currencyIn.amount,
            transactionHash: sourceTransactionHash,
          }),
          historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }),
        },
        solana: { client: destination.client },
      },
      config: {
        nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      },
      cycleRepository,
      context: {
        cycleId: 'cycle-outbound-reconcile',
        fencingToken: '11111111-1111-4111-8111-111111111111',
      },
    });

    assert.equal(cycleRepository.settlements.length, 1, fixtureCase.name);
    assert.equal(cycleRepository.settlements[0].terminalState, fixtureCase.terminalState, fixtureCase.name);
    if (fixtureCase.terminalState === 'SETTLED') {
      assert.equal(result.schema, 'hookemon.outbound-relay-settlement-evidence.v2', fixtureCase.name);
      assert.equal(result.relayLeg.state, 'SETTLED', fixtureCase.name);
    } else {
      assert.equal(result, null, fixtureCase.name);
    }
    assert.deepEqual(cycleRepository.recoverySelectors, Array.from({ length: 2 }, () => ({
      stage: 'outbound',
      recipient: null,
      requestDigest: `sha256:${'e'.repeat(64)}`,
      rawSignedBytesHash: sourceTransactionHash,
    })), fixtureCase.name);

    const replay = await reconcileLiveOutbound({
      adapters: {
        robinhood: {
          client: finalizedOutboundSourceClient({
            amountAtomic: quoteFixture.details.currencyIn.amount,
            transactionHash: sourceTransactionHash,
          }),
          historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }),
        },
        solana: { client: destination.client },
      },
      config: {
        nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
      },
      cycleRepository,
      context: {
        cycleId: 'cycle-outbound-reconcile',
        fencingToken: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(cycleRepository.settlements.length, 1, `${fixtureCase.name} restart`);
    assert.equal(
      cycleRepository.walletReleases.length,
      fixtureCase.terminalState === 'SETTLED' ? 1 : 2,
      `${fixtureCase.name} restart releases only the same durable fence`,
    );
    if (fixtureCase.terminalState === 'SETTLED') {
      assert.equal(replay.schema, 'hookemon.outbound-relay-settlement-evidence.v2', `${fixtureCase.name} restart`);
      assert.equal(replay.relayLeg.state, 'SETTLED', `${fixtureCase.name} restart`);
    } else {
      assert.equal(replay, null, `${fixtureCase.name} restart`);
    }
  }
});

test('reconcileLiveOutbound retains the wallet nonce reservation while source finality is unresolved', async () => {
  const sourceTransactionHash = (await signNativeOutboundSource()).hash;
  const cycleRepository = await outboundReconciliationRepository({
    transactionHash: sourceTransactionHash,
    relayRequestId: 'relay-outbound-unfinalized',
    destinationAmountAtomic: quoteFixture.details.currencyOut.amount,
  });
  const sourceClient = {
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, sourceTransactionHash);
      return {
        transactionHash: sourceTransactionHash,
        blockNumber: 102n,
        blockHash: `0x${'a'.repeat(64)}`,
        status: 'success',
        logs: [],
      };
    },
    async getBlock({ blockTag }) {
      assert.equal(blockTag, 'finalized');
      return { number: 101n, hash: `0x${'b'.repeat(64)}`, timestamp: 1_700_000_090n };
    },
  };

  const result = await reconcileLiveOutbound({
    adapters: {
      robinhood: { client: sourceClient, historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount }) },
      solana: { client: discoveredOutboundDestinationClient({
        relayRequestId: 'relay-outbound-unfinalized',
        mint: SOLANA_MINT,
        amountAtomic: quoteFixture.details.currencyOut.amount,
      }).client },
    },
    config: {
      nativePaymentBinding: nativeRefundBinding(),
      accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
    },
    cycleRepository,
    context: {
      cycleId: 'cycle-outbound-reconcile',
      fencingToken: '11111111-1111-4111-8111-111111111111',
    },
  });

  assert.equal(result, null);
  assert.equal(cycleRepository.sourceAttemptState, 'BROADCAST');
  assert.deepEqual(cycleRepository.finalities, []);
  assert.deepEqual(cycleRepository.walletReleases, []);
  assert.deepEqual(cycleRepository.settlements, []);
});

test('reconcileLiveOutbound refuses unauthenticated Relay status data before it can settle a cycle', async () => {
  const intent = outboundIntent();
  let statusCalls = 0;
  await assert.rejects(
    () => reconcileLiveOutbound({
      adapters: {
        relay: {
          restoreIntent() {},
          async getIntentStatus() {
            statusCalls += 1;
            return { status: 'SUCCESS', originChainId: 4663, destinationChainId: 792703809, txHashes: ['solana-signature'] };
          },
        },
        solana: { client: solanaClientWithCredit(quoteFixture.details.currencyOut.minimumAmount) },
      },
      config: { accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT }, relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY } },
      cycleRepository: { async readOperationalStageAttempt() { return { responseEvidence: { intent } }; } },
      context: { cycleId: 'cycle-outbound-unattested-status' },
    }),
    error => error instanceof OutboundRecoveryRequiredError && error.recoveryState === 'OUTBOUND_SETTLEMENT_UNATTESTED',
  );
  assert.equal(statusCalls, 0);
});

const SOURCE_REQUEST_DIGEST = `sha256:${'e'.repeat(64)}`;
const APPROVAL_REQUEST_DIGEST = `sha256:${'d'.repeat(64)}`;
const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
// Real keypairs (not the placeholder `EVM_ACCOUNT` literal used by tests that never need a
// signature to recover): the approval-role check recovers the signer from raw bytes, so these
// tests need an account that can actually produce one.
const OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT = privateKeyToAccount(`0x${'3'.repeat(64)}`);
const OUTBOUND_APPROVAL_OTHER_ACCOUNT = privateKeyToAccount(`0x${'4'.repeat(64)}`);

function abiAddressWord(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function abiAmountWord(amountAtomic) {
  return BigInt(amountAtomic).toString(16).padStart(64, '0');
}

function outboundApproveCalldata(spender, amountAtomic) {
  return `${ERC20_APPROVE_SELECTOR}${abiAddressWord(spender)}${abiAmountWord(amountAtomic)}`;
}

// Historical USDG approvals are signed offline only to prove that no approval, valid or
// malformed, can enter the active native one-deposit envelope.
async function signOutboundApproval({
  signer = OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT,
  spender = RELAY_DEPOSITORY,
  amountAtomic = quoteFixture.details.currencyIn.amount,
  nonce = 8,
  to = '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  value = 0n,
} = {}) {
  const rawBytes = await signer.signTransaction({
    chainId: 4663,
    to,
    data: outboundApproveCalldata(spender, amountAtomic),
    value,
    nonce,
    gas: 60000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  return { rawBytes, hash: keccak256(rawBytes) };
}

function throwingRobinhoodClient() {
  return {
    async getTransactionReceipt() { throw new Error('no EVM receipt read is expected here'); },
    async getBlock() { throw new Error('no EVM block read is expected here'); },
  };
}

function throwingSolanaClient() {
  return createSolanaRpcClient({ fetchImpl: async () => { throw new Error('no Solana request is expected here'); } });
}

/**
 * A durable outbound repository shaped like `outboundReconciliationRepository` above, but with the
 * full canonical attempt set under caller control: the deposit (source) plus an explicit list of
 * every other durable "outbound" chain attempt (0, 1, or many), so a test can exercise the exact
 * membership and role invariants `reconcileLiveOutbound` now enforces.
 */
function outboundApprovalRepository({
  relayRequestId,
  destinationAmountAtomic,
  sourceHash,
  sourceNonce = '9',
  sourceState = 'BROADCAST',
  legState = 'RECORDED',
  legOverrides = {},
  attempts = [],
}) {
  const cycleId = 'cycle-outbound-reconcile';
  let sourceRecord = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId,
      stage: 'outbound',
      state: sourceState,
      requestDigest: SOURCE_REQUEST_DIGEST,
      rawBytes: signedNativeDeposits.get(sourceHash),
      nonce: sourceNonce,
      blockhash: null,
      hash: sourceHash,
    },
  };
  let extra = attempts.map(fields => ({
    attempt: { schema: 'hookemon.chain-transaction-attempt.v1', cycleId, stage: 'outbound', blockhash: null, ...fields },
  }));
  const leg = {
    schema: 'hookemon.relay-leg.v2',
    cycleId,
    direction: 'outbound',
    relayRequestId,
    quoteDigest: `sha256:${'f'.repeat(64)}`,
    sourceChainId: '4663',
    sourceTxHash: sourceHash,
    sourceAssetId: 'native',
    sourceDecimals: 18,
    sourceAmountAtomic: quoteFixture.details.currencyIn.amount,
    destinationChainId: '792703809',
    destinationTxHash: null,
    destinationAssetId: SOLANA_MINT,
    destinationDecimals: 6,
    destinationAmountAtomic,
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: legState,
    ...legOverrides,
  };
  const finalityCalls = [];
  const settlements = [];
  const walletReleases = [];
  return {
    get finalityCalls() { return structuredClone(finalityCalls); },
    get settlements() { return structuredClone(settlements); },
    get walletReleases() { return structuredClone(walletReleases); },
    get sourceAttemptState() { return sourceRecord.attempt.state; },
    get attemptStates() {
      return Object.fromEntries([sourceRecord, ...extra].map(entry => [entry.attempt.requestDigest, entry.attempt.state]));
    },
    async describeCycle() {
      return {
        relayLegs: new Map([[relayRequestId, structuredClone(leg)]]),
        chainAttempts: new Map([
          [`outbound\0${sourceRecord.attempt.requestDigest}`, structuredClone(sourceRecord)],
          ...extra.map(entry => [`outbound\0${entry.attempt.requestDigest}`, structuredClone(entry)]),
        ]),
      };
    },
    async recordBroadcast() {
      throw new Error('a broadcast attempt must not be rebroadcast during finality reconciliation');
    },
    async recordFinality(cycleIdArg, stage, requestDigest, evidence) {
      assert.equal(cycleIdArg, cycleId);
      assert.equal(stage, 'outbound');
      finalityCalls.push({ requestDigest, evidence: structuredClone(evidence) });
      if (requestDigest === sourceRecord.attempt.requestDigest) {
        sourceRecord = { ...sourceRecord, attempt: { ...sourceRecord.attempt, state: 'FINALIZED' } };
        return structuredClone(sourceRecord);
      }
      const index = extra.findIndex(entry => entry.attempt.requestDigest === requestDigest);
      assert.ok(index >= 0, `recordFinality for an unrecognized outbound attempt ${requestDigest}`);
      extra[index] = { attempt: { ...extra[index].attempt, state: 'FINALIZED' } };
      return structuredClone(extra[index]);
    },
    async settleRelayLeg(cycleIdArg, requestId, settlement) {
      assert.equal(cycleIdArg, cycleId);
      assert.equal(requestId, relayRequestId);
      const { destinationObservation } = settlement;
      assert.equal(destinationObservation.mint, leg.destinationAssetId, 'test only models the exact-credit settlement path');
      assert.equal(destinationObservation.netDeltaAtomic, leg.destinationAmountAtomic, 'test only models the exact-credit settlement path');
      const normalizedSettlement = {
        destinationTxHash: destinationObservation.transactionHash,
        finalizedAtDestination: destinationObservation.finality,
        netDeltaAtomic: destinationObservation.netDeltaAtomic,
        terminalState: 'SETTLED',
      };
      settlements.push(structuredClone(normalizedSettlement));
      Object.assign(leg, {
        destinationTxHash: normalizedSettlement.destinationTxHash,
        finalizedAtDestination: normalizedSettlement.finalizedAtDestination,
        netDeltaAtomic: normalizedSettlement.netDeltaAtomic,
        state: normalizedSettlement.terminalState,
      });
      return structuredClone(leg);
    },
    async readChainAttemptRecoveryContext() {
      return { relayQuoteDeadlineUnixSeconds: '1700000200' };
    },
    async releaseWalletNonce(cycleIdArg, reservation) {
      walletReleases.push({ cycleId: cycleIdArg, reservation: structuredClone(reservation) });
    },
  };
}

function outboundApprovalTestConfig() {
  return {
    accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
    relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
  };
}

test('reconcileLiveOutbound fails closed unless the durable outbound attempt set is exactly the canonical native one-step envelope', async () => {
  const sourceHash = (await signNativeOutboundSource()).hash;
  const relayRequestId = 'relay-outbound-approval-membership';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  const amountAtomic = quoteFixture.details.currencyIn.amount;

  const cases = [
    { name: 'legacy approval added to the native deposit', build: async () => { const approval = await signOutboundApproval(); return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: approval.hash, nonce: '8', state: 'BROADCAST', rawBytes: approval.rawBytes }]; } },
    {
      name: 'two prerequisite attempts',
      build: async () => {
        const valid = await signOutboundApproval();
        return [
          { requestDigest: APPROVAL_REQUEST_DIGEST, hash: valid.hash, nonce: '8', state: 'BROADCAST', rawBytes: valid.rawBytes },
          { requestDigest: `sha256:${'1'.repeat(64)}`, hash: `0x${'2'.repeat(64)}`, nonce: '7', state: 'BROADCAST', rawBytes: '0x1234' },
        ];
      },
    },
    {
      // Caught by the pre-existing deposit-matching guard (both the source and this attempt now
      // match `leg.sourceTxHash`), not by the prerequisite-role check -- still a hard refusal.
      name: 'prerequisite duplicates the deposit transaction hash',
      build: async () => {
        const valid = await signOutboundApproval();
        return [{ requestDigest: `sha256:${'1'.repeat(64)}`, hash: sourceHash, nonce: '8', state: 'BROADCAST', rawBytes: valid.rawBytes }];
      },
    },
    {
      name: 'prerequisite hash does not match its own durable raw bytes',
      build: async () => {
        const valid = await signOutboundApproval();
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: `0x${'3'.repeat(64)}`, nonce: '8', state: 'BROADCAST', rawBytes: valid.rawBytes }];
      },
    },
    {
      name: 'prerequisite raw bytes do not decode as a signed EVM transaction',
      build: async () => [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: keccak256('0xdeadbeef'), nonce: '8', state: 'BROADCAST', rawBytes: '0xdeadbeef' }],
    },
    {
      name: 'prerequisite was not signed by the Operations account',
      build: async () => {
        const wrong = await signOutboundApproval({ signer: OUTBOUND_APPROVAL_OTHER_ACCOUNT });
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '8', state: 'BROADCAST', rawBytes: wrong.rawBytes }];
      },
    },
    {
      name: 'prerequisite does not target USDG',
      build: async () => {
        const wrong = await signOutboundApproval({ to: RELAY_DEPOSITORY });
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '8', state: 'BROADCAST', rawBytes: wrong.rawBytes }];
      },
    },
    {
      name: 'prerequisite carries nonzero native value',
      build: async () => {
        const wrong = await signOutboundApproval({ value: 1n });
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '8', state: 'BROADCAST', rawBytes: wrong.rawBytes }];
      },
    },
    {
      name: 'prerequisite approval spender is not the configured Relay depository',
      build: async () => {
        const wrong = await signOutboundApproval({ spender: OUTBOUND_APPROVAL_OTHER_ACCOUNT.address });
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '8', state: 'BROADCAST', rawBytes: wrong.rawBytes }];
      },
    },
    {
      name: 'prerequisite approval amount does not equal the leg source amount',
      build: async () => {
        const wrong = await signOutboundApproval({ amountAtomic: String(BigInt(amountAtomic) + 1n) });
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '8', state: 'BROADCAST', rawBytes: wrong.rawBytes }];
      },
    },
    {
      name: 'prerequisite nonce does not immediately precede the deposit nonce',
      build: async () => {
        const wrong = await signOutboundApproval({ nonce: 7 });
        return [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '7', state: 'BROADCAST', rawBytes: wrong.rawBytes }];
      },
    },
  ];

  for (const fixtureCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const attempts = await fixtureCase.build();
    const cycleRepository = outboundApprovalRepository({ relayRequestId, destinationAmountAtomic, sourceHash, attempts });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => reconcileLiveOutbound({
        adapters: { robinhood: { client: throwingRobinhoodClient() }, solana: { client: throwingSolanaClient() } },
        config: outboundApprovalTestConfig(),
        cycleRepository,
        context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
      }),
      error => error instanceof OutboundRecoveryRequiredError && error.recoveryState === 'OUTBOUND_CHAIN_ATTEMPT_AMBIGUOUS',
      fixtureCase.name,
    );
    assert.deepEqual(cycleRepository.finalityCalls, [], fixtureCase.name);
    assert.deepEqual(cycleRepository.settlements, [], fixtureCase.name);
  }
});

test('reconcileLiveOutbound refuses an already-FINALIZED prerequisite whose durable role is invalid, even with the leg already SETTLED', async () => {
  const sourceHash = (await signNativeOutboundSource()).hash;
  const relayRequestId = 'relay-outbound-approval-finalized-invalid';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  // An extra historical approval remains forbidden even when both it and the native leg
  // were marked finalized by an earlier run.
  const wrong = await signOutboundApproval({ spender: OUTBOUND_APPROVAL_OTHER_ACCOUNT.address });
  const cycleRepository = outboundApprovalRepository({
    relayRequestId,
    destinationAmountAtomic,
    sourceHash,
    sourceState: 'FINALIZED',
    legState: 'SETTLED',
    legOverrides: {
      destinationTxHash: 'relay-destination-observation',
      finalizedAtDestination: { height: '88', hash: `0x${'c'.repeat(64)}`, timestampUnixSeconds: '1700000100' },
      netDeltaAtomic: destinationAmountAtomic,
    },
    attempts: [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: wrong.hash, nonce: '8', state: 'FINALIZED', rawBytes: wrong.rawBytes }],
  });

  await assert.rejects(
    () => reconcileLiveOutbound({
      adapters: { robinhood: { client: throwingRobinhoodClient() }, solana: { client: throwingSolanaClient() } },
      config: outboundApprovalTestConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
    }),
    error => error instanceof OutboundRecoveryRequiredError && error.recoveryState === 'OUTBOUND_CHAIN_ATTEMPT_AMBIGUOUS',
  );
  // No RPC (throwing clients above were never invoked) and no settlement or finality write, even
  // though both the prerequisite and the leg already looked durably resolved.
  assert.deepEqual(cycleRepository.finalityCalls, []);
  assert.deepEqual(cycleRepository.settlements, []);
});

test('reconcileLiveOutbound reuses a durably SETTLED native leg without RPC or repeated finality', async () => {
  const sourceHash = (await signNativeOutboundSource()).hash;
  const cycleRepository = outboundApprovalRepository({
    relayRequestId: 'native-settled-restart', destinationAmountAtomic: quoteFixture.details.currencyOut.amount,
    sourceHash, sourceState: 'FINALIZED', legState: 'SETTLED',
    legOverrides: { destinationTxHash: 'relay-destination-observation',
      finalizedAtDestination: { height: '88', hash: `0x${'c'.repeat(64)}`, timestampUnixSeconds: '1700000100' },
      netDeltaAtomic: quoteFixture.details.currencyOut.amount },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await reconcileLiveOutbound({
      adapters: { robinhood: { client: throwingRobinhoodClient() }, solana: { client: throwingSolanaClient() } },
      config: outboundApprovalTestConfig(), cycleRepository,
      context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
    });
    assert.equal(result.schema, 'hookemon.outbound-relay-settlement-evidence.v2');
    assert.equal(result.relayLeg.state, 'SETTLED');
    assert.deepEqual(cycleRepository.finalityCalls, []);
    assert.deepEqual(cycleRepository.settlements, []);
  }
});

test('reconcileLiveOutbound finalizes one native deposit and accounts principal and gas once after restart', async () => {
  const sourceHash = (await signNativeOutboundSource()).hash;
  const relayRequestId = 'native-deposit-restart';
  const cycleRepository = await outboundReconciliationRepository({ transactionHash: sourceHash, relayRequestId,
    destinationAmountAtomic: quoteFixture.details.currencyOut.amount, quoteDeadlineUnixSeconds: '1700000200' });
  const destination = discoveredOutboundDestinationClient({ relayRequestId, mint: SOLANA_MINT, amountAtomic: quoteFixture.details.currencyOut.amount });
  const context = { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' };
  const config = outboundApprovalTestConfig();
  const result = await reconcileLiveOutbound({
    adapters: { robinhood: { client: finalizedOutboundSourceClient({ transactionHash: sourceHash, amountAtomic: quoteFixture.details.currencyIn.amount }),
      historicalEvidenceClient: outboundArchiveEvidence() }, solana: { client: destination.client } },
    config, cycleRepository, context,
  });
  assert.equal(result.relayLeg.state, 'SETTLED');
  assert.equal(cycleRepository.sourceAttemptState, 'FINALIZED');
  assert.equal(cycleRepository.finalities.length, 1);
  assert.equal(cycleRepository.settlements.length, 1);
  const before = (await cycleRepository.describeCycle()).custodyLedgers.get('4663\0native');
  assert.equal(before.bridgeOut, quoteFixture.details.currencyIn.amount);
  assert.equal(before.gasSpent.amountAtomic, '200000');
  assert.deepEqual(before.gasPayments, [{ transactionHash: sourceHash, amountWei: '200000' }]);
  const replay = await reconcileLiveOutbound({
    adapters: { robinhood: { client: throwingRobinhoodClient() }, solana: { client: throwingSolanaClient() } },
    config, cycleRepository, context,
  });
  assert.equal(replay.relayLeg.state, 'SETTLED');
  assert.equal(cycleRepository.finalities.length, 1);
  assert.equal(cycleRepository.settlements.length, 1);
  assert.deepEqual((await cycleRepository.describeCycle()).custodyLedgers.get('4663\0native'), before);
});

function moneyConfiguration({ solanaMint = SOLANA_MINT } = {}) {
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: {
      eth: { chainId: '4663', assetId: 'native', decimals: 18 },
      solanaStablecoin: { chainId: '792703809', assetId: solanaMint, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      solanaReceive: { chainId: '792703809', assetId: solanaMint, decimals: 6, amountAtomic: '0' },
      returnEth: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '600000000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000000000000000' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '1000' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '1000000' },
    },
  };
}

function quoteForOperationsAccount(account) {
  const quote = structuredClone(quoteFixture);
  const address = account.address.toLowerCase();
  const encoded = address.slice(2).padStart(64, '0');
  quote.details.sender = address;
  quote.protocol.v2.orderData.inputs[0].refunds[0].recipient = address;
  for (const step of quote.steps) step.items[0].data.from = address;
  const deposit = quote.steps[0].items[0].data;
  deposit.data = `${deposit.data.slice(0, 10)}${encoded}${deposit.data.slice(74)}`;
  return quote;
}

function outboundChainRepository(releaseAmount = quoteFixture.details.currencyIn.amount, durableAdmission = null) {
  const attempts = new Map();
  const recoveryContexts = new Map();
  const reservations = [];
  let relayLeg = null;
  return {
    get attempts() { return attempts; },
    get relayLeg() { return relayLeg; },
    get recoveryContexts() { return [...recoveryContexts.values()].map(context => structuredClone(context)); },
    get reservations() { return structuredClone(reservations); },
    async describeCycle() { return { releaseAmount, ...(durableAdmission === null ? {} : { admission: durableAdmission }), chainAttempts: new Map(attempts) }; },
    async readChainTransactionAttempt(_cycleId, stage, requestDigest) {
      return attempts.get(`${stage}\u0000${requestDigest}`) ?? null;
    },
    async prepareChainTransactionAttempt(_cycleId, stage, attempt) {
      const key = `${stage}\u0000${attempt.requestDigest}`;
      const existing = attempts.get(key);
      if (existing) return existing;
      const record = { attempt, broadcastEvidence: null, finalityEvidence: null };
      attempts.set(key, record);
      return record;
    },
    async recordSignedTransaction(_cycleId, stage, requestDigest, material) {
      const key = `${stage}\u0000${requestDigest}`;
      const existing = attempts.get(key);
      const record = { ...existing, attempt: { ...existing.attempt, state: 'SIGNED', ...material } };
      attempts.set(key, record);
      return record;
    },
    async recordBroadcast(_cycleId, stage, requestDigest, evidence) {
      const key = `${stage}\u0000${requestDigest}`;
      const existing = attempts.get(key);
      const record = { ...existing, attempt: { ...existing.attempt, state: 'BROADCAST' }, broadcastEvidence: evidence };
      attempts.set(key, record);
      return record;
    },
    async recordRelayLeg(_cycleId, leg) {
      if (relayLeg === null) relayLeg = structuredClone(leg);
      return structuredClone(relayLeg);
    },
    async recordRelayLegSource(_cycleId, requestId, hash) {
      assert.equal(requestId, relayLeg.relayRequestId);
      relayLeg = { ...relayLeg, sourceTxHash: hash, state: 'SOURCE_SIGNED' };
      return structuredClone(relayLeg);
    },
    async readRelayLeg() { return relayLeg === null ? null : structuredClone(relayLeg); },
    async reserveWalletNonce(cycleId, reservation) { reservations.push(['reserve', cycleId, structuredClone(reservation)]); },
    async assertWalletNonce(cycleId, reservation) { reservations.push(['assert', cycleId, structuredClone(reservation)]); },
    async persistChainAttemptRecoveryContext(_cycleId, context) {
      recoveryContexts.set(`${context.stage}\u0000${context.requestDigest}`, structuredClone(context));
      return structuredClone(context);
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      return recoveryContexts.get(`${selector.stage}\u0000${selector.requestDigest}`) ?? null;
    },
  };
}

test('mutateOutbound records the Relay leg before signing and rebroadcasts durable bytes without a second signature', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const quote = quoteForOperationsAccount(account);
  const config = {
    chainId: 4663,
    accounts: { evm: account.address, solana: SOLANA_ACCOUNT },
    relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
    moneyConfiguration: moneyConfiguration(),
  };
  const durableAdmission = admission('cycle-outbound-durable', admittedQuote(quote));
  const cycleRepository = outboundChainRepository(quote.details.currencyIn.amount, durableAdmission);
  const request = await prepareOutboundRequest({
    adapters: { relay: relayClient(quote) },
    config,
    cycleRepository,
    context: {
      cycleId: 'cycle-outbound-durable',
      admission: durableAdmission,
    },
    nowMs: (quote.protocol.v2.orderData.output.deadline * 1000) - 1,
  });
  const context = {
    cycleId: 'cycle-outbound-durable',
    stage: 'outbound',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    fencingToken: '11111111-1111-4111-8111-111111111111',
  };
  let signCalls = 0;
  let broadcastCalls = 0;
  let firstRawBytes = null;
  const signerClient = {
    evm: {
      role: 'operator-evm',
      async sign({ transaction }) {
        signCalls += 1;
        assert.equal(cycleRepository.relayLeg.state, 'RECORDED');
        assert.equal(cycleRepository.relayLeg.sourceTxHash, null);
        const { from, ...unsigned } = transaction;
        return {
          signedTx: await account.signTransaction({
            ...unsigned,
            value: BigInt(unsigned.value),
            nonce: BigInt(unsigned.nonce),
            gas: BigInt(unsigned.gas),
            maxFeePerGas: BigInt(unsigned.maxFeePerGas),
            ...(unsigned.maxPriorityFeePerGas === undefined
              ? {}
              : { maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas) }),
          }),
        };
      },
      async broadcast({ signedTx }) {
        broadcastCalls += 1;
        if (firstRawBytes === null) {
          firstRawBytes = signedTx;
          throw new Error('broadcast interrupted after durable signature');
        }
        if (broadcastCalls === 2) assert.equal(signedTx, firstRawBytes);
        return { transactionHash: keccak256(signedTx) };
      },
    },
  };
  const adapters = {
    robinhood: {
      client: {
        async getChainId() { return 4663; },
        async getTransactionCount() { return 7n; },
        async getBalance() { return 1_000_000_000_000_000_000n; },
      },
    },
  };

  await assert.rejects(
    () => mutateOutbound({
      liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
      now: () => (quote.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /broadcast interrupted after durable signature/,
  );
  assert.equal(signCalls, 1);
  assert.equal(cycleRepository.relayLeg.state, 'SOURCE_SIGNED');
  assert.equal([...cycleRepository.attempts.values()][0].attempt.state, 'SIGNED');
  const persisted = [...cycleRepository.attempts.values()][0].attempt.rawBytes;

  await mutateOutbound({
    liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    now: () => (quote.protocol.v2.orderData.output.deadline * 1000) - 1,
  });
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 2);
  assert.equal(firstRawBytes, persisted);
  assert.equal(cycleRepository.relayLeg.sourceTxHash, keccak256([...cycleRepository.attempts.values()][0].attempt.rawBytes));
  assert.deepEqual(
    cycleRepository.recoveryContexts.map(recovery => recovery.relayQuoteDeadlineUnixSeconds),
    [String(quote.protocol.v2.orderData.output.deadline)],
  );
  assert.equal(cycleRepository.reservations.some(([kind]) => kind === 'reserve'), true);
});
