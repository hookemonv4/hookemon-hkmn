import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createRelayClient, relayQuoteDigest, RelayIntentAuthenticationError } from '../../src/relay-client.mjs';
import { createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  OutboundRecoveryRequiredError,
  createOutboundPolicySigner,
  mutateOutbound,
  prepareOutboundRequest,
  reconcileLiveOutbound,
} from '../../src/app/stages/outbound.mjs';

const EVM_ACCOUNT = '0x000000000000000000000000000000000000dEaD';
const SOLANA_ACCOUNT = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/relay/${name}`, import.meta.url)), 'utf8'));
}

const chains = fixture('chains.json');
const quoteFixture = fixture('quote-outbound.json');
// This fixture remains a deterministic recorded EVM envelope, but the admission path below
// models an EXACT_OUTPUT quote: the requested settlement target and minimum are both 25 atomic units.
quoteFixture.details.currencyOut.amount = '25000000';
quoteFixture.details.currencyOut.minimumAmount = '25000000';
quoteFixture.protocol.v2.orderData.output.payments[0].expectedAmount = '25000000';
quoteFixture.protocol.v2.orderData.output.payments[0].minimumAmount = '25000000';
const RELAY_DEPOSITORY = quoteFixture.steps[1].items[0].data.to;

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
      address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      decimals: 6,
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
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: quote.origin.amount };
  const destinationAsset = { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: quote.destination.amount };
  return {
    schema: 'hookemon.policy-admission.v2',
    cycleId,
    quoteDigest: quote.quoteDigest,
    quantity: 1,
    unitFundingQuote: usdg,
    aggregateFundingQuote: usdg,
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

function repository(releaseAmount = '25000000') {
  return { async describeCycle(cycleId) { return { releaseAmount, admission: admission(cycleId) }; } };
}

test('prepareOutboundRequest refuses an absent MoneyConfigurationV1 before requesting a Relay quote', async () => {
  let quoteCalls = 0;
  const adapters = {
    relay: {
      async quoteOutboundBridge() {
        quoteCalls += 1;
        throw new Error('Relay must not be queried without MoneyConfigurationV1');
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
    /requires MoneyConfigurationV1/,
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
  assert.equal(request.schema, 'hookemon.outbound-relay-request.v1');
  assert.deepEqual(request.inputAmount, {
    chainId: '4663',
    assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    decimals: 6,
    amountAtomic: '25000000',
  });
  assert.deepEqual(request.destinationAmount, {
    chainId: '792703809',
    assetId: SOLANA_MINT,
    decimals: 6,
    amountAtomic: quoteFixture.details.currencyOut.amount,
  });
  assert.equal(request.intent.requestId, quoteFixture.requestId);
  assert.equal(request.transactions.length, 2);
  assert.deepEqual(request.transactions.map(transaction => transaction.transaction), [
    quoteFixture.steps[0].items[0].data,
    quoteFixture.steps[1].items[0].data,
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
      cycleRepository: { async describeCycle() { return { releaseAmount: '25000000', admission: admission(cycleId, shortQuote) }; } },
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
  altered.steps[1].items[0].data.to = `0x${'9'.repeat(40)}`;
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
    /depository/,
  );
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
    schema: 'hookemon.relay-intent.v1',
    requestId: quoteFixture.requestId,
    orderId: quoteFixture.protocol.v2.orderId,
    direction: 'OUTBOUND',
    tradeType: 'EXACT_OUTPUT',
    quoteDigest: admittedQuote().quoteDigest,
    originChainId: 4663,
    destinationChainId: 792703809,
    originAssetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    originDecimals: 6,
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

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function finalizedOutboundSourceClient({ amountAtomic, transactionHash }) {
  const receiptBlockHash = `0x${'a'.repeat(64)}`;
  const parentBlockHash = `0x${'b'.repeat(64)}`;
  const finalizedBlockHash = `0x${'c'.repeat(64)}`;
  const amount = BigInt(amountAtomic);
  const receipt = {
    transactionHash,
    blockNumber: 100n,
    blockHash: receiptBlockHash,
    status: 'success',
    logs: [{
      address: quoteFixture.details.currencyIn.currency.address,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address), addressTopic(RELAY_DEPOSITORY)],
      data: `0x${amount.toString(16).padStart(64, '0')}`,
      logIndex: 0n,
    }],
  };
  return {
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, transactionHash);
      return structuredClone(receipt);
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') return { number: 101n, hash: finalizedBlockHash, timestamp: 1_700_000_090n };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, parentHash: parentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: parentBlockHash, parentHash: `0x${'d'.repeat(64)}`, timestamp: 1_700_000_070n };
      throw new Error(`unexpected outbound source block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

function finalizedOutboundSourceAndRefundClient({
  sourceTransactionHash,
  refundTransactionHash,
  refundTransfers,
}) {
  const sourceReceiptBlockHash = `0x${'a'.repeat(64)}`;
  const sourceParentBlockHash = `0x${'b'.repeat(64)}`;
  const refundReceiptBlockHash = `0x${'d'.repeat(64)}`;
  const finalizedBlockHash = `0x${'c'.repeat(64)}`;
  const sourceAmount = BigInt(quoteFixture.details.currencyIn.amount);
  const sourceReceipt = {
    transactionHash: sourceTransactionHash,
    blockNumber: 100n,
    blockHash: sourceReceiptBlockHash,
    status: 'success',
    logs: [{
      address: quoteFixture.details.currencyIn.currency.address,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address), addressTopic(RELAY_DEPOSITORY)],
      data: `0x${sourceAmount.toString(16).padStart(64, '0')}`,
      logIndex: 0n,
    }],
  };
  const refundReceipt = {
    transactionHash: refundTransactionHash,
    blockNumber: 102n,
    blockHash: refundReceiptBlockHash,
    status: 'success',
    logs: refundTransfers.map(({
      token = quoteFixture.details.currencyIn.currency.address,
      source = RELAY_DEPOSITORY,
      recipient = OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address,
      amountAtomic,
    }, index) => ({
      address: token,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(source), addressTopic(recipient)],
      data: `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`,
      logIndex: BigInt(index),
    })),
  };
  return {
    async getTransactionReceipt({ hash }) {
      if (hash === sourceTransactionHash) return structuredClone(sourceReceipt);
      if (hash === refundTransactionHash) return structuredClone(refundReceipt);
      throw new Error(`unexpected transaction receipt ${hash}`);
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') return { number: 103n, hash: finalizedBlockHash, timestamp: 1_700_000_110n };
      if (blockNumber === 100n) return { number: 100n, hash: sourceReceiptBlockHash, parentHash: sourceParentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: sourceParentBlockHash, parentHash: `0x${'e'.repeat(64)}`, timestamp: 1_700_000_070n };
      if (blockNumber === 102n) return { number: 102n, hash: refundReceiptBlockHash, parentHash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_100n };
      throw new Error(`unexpected outbound block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

function outboundArchiveEvidence({ amountAtomic, sourceAccount = OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address }) {
  const amount = BigInt(amountAtomic);
  return {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      assert.equal(typeof blockHash, 'string');
      const source = account.toLowerCase() === sourceAccount.toLowerCase();
      const value = source
        ? (blockNumber === 99n ? 100_000_000n : 100_000_000n - amount)
        : (blockNumber === 99n ? 5_000_000n : 5_000_000n + amount);
      return { value, blockNumber, blockHash };
    },
  };
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
      rawBytes: '0x1234',
      nonce: '9',
      blockhash: null,
      hash: transactionHash,
    },
  };
  // The canonical two-step Relay envelope's other durable attempt: this shared repository is used
  // by every reconcile test in this file that does not itself exercise prerequisite-role/finality
  // behavior. It is already FINALIZED, but `reconcileLiveOutbound` still validates a FINALIZED
  // prerequisite's role from its own durable bytes, so this must be a real, canonically valid
  // signed USDG approval -- never a placeholder -- for `OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT` (the
  // Operations account these reconcile tests configure).
  const canonicalApproval = await signOutboundApproval();
  const approvalRecord = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId: 'cycle-outbound-reconcile',
      stage: 'outbound',
      state: 'FINALIZED',
      requestDigest: `sha256:${'0'.repeat(64)}`,
      rawBytes: canonicalApproval.rawBytes,
      nonce: '8',
      blockhash: null,
      hash: canonicalApproval.hash,
    },
  };
  const leg = {
    schema: 'hookemon.relay-leg.v1',
    cycleId: 'cycle-outbound-reconcile',
    direction: 'outbound',
    relayRequestId,
    quoteDigest: `sha256:${'f'.repeat(64)}`,
    sourceChainId: '4663',
    sourceTxHash: transactionHash,
    sourceAssetId: quoteFixture.details.currencyIn.currency.address.toLowerCase(),
    sourceDecimals: 6,
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
        relayLegs: new Map([[relayRequestId, structuredClone(leg)]]),
        chainAttempts: new Map([
          [`outbound\u0000${sourceRecord.attempt.requestDigest}`, structuredClone(sourceRecord)],
          [`outbound\u0000${approvalRecord.attempt.requestDigest}`, structuredClone(approvalRecord)],
        ]),
      };
    },
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
            height: sourceProof.receiptBlockNumber.toString(),
            hash: sourceProof.receiptBlockHash,
            timestampUnixSeconds: sourceProof.receiptBlockTimestampUnixSeconds,
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
        const sourceTimestamp = BigInt(sourceProof.receiptBlockTimestampUnixSeconds);
        const destinationTimestamp = BigInt(destinationObservation.finality.timestampUnixSeconds);
        const deadline = BigInt(quoteDeadlineUnixSeconds);
        terminalState = destinationTimestamp >= sourceTimestamp && destinationTimestamp <= deadline
          ? 'SETTLED'
          : 'HELD_RELAY_LATE';
      }
      if (normalizedSettlement === undefined) {
        normalizedSettlement = {
          sourceFinality: {
            height: sourceProof.receiptBlockNumber.toString(),
            hash: sourceProof.receiptBlockHash,
            timestampUnixSeconds: sourceProof.receiptBlockTimestampUnixSeconds,
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
      if (quoteDeadlineUnixSeconds === null && relayIntent === null) return null;
      return {
        ...(quoteDeadlineUnixSeconds === null ? {} : { relayQuoteDeadlineUnixSeconds: quoteDeadlineUnixSeconds }),
        ...(relayIntent === null ? {} : { relayIntent: structuredClone(relayIntent) }),
      };
    },
    async releaseWalletNonce(cycleId, reservation) {
      walletReleases.push({ cycleId, reservation: structuredClone(reservation) });
    },
  };
}

test('reconcileLiveOutbound records own-RPC source finality and classifies only observed destination mismatches', async () => {
  const sourceTransactionHash = `0x${'9'.repeat(64)}`;
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
  const sourceTransactionHash = `0x${'6'.repeat(64)}`;
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
  assert.deepEqual(settlement.refundProof, {
    schema: 'hookemon.outbound-relay-origin-refund-proof.v1',
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
    observedToken: quoteFixture.details.currencyIn.currency.address.toLowerCase(),
    observedSource: RELAY_DEPOSITORY.toLowerCase(),
    observedRecipient: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address.toLowerCase(),
    observedAmountAtomic: refundAmountAtomic,
  });
});

test('reconcileLiveOutbound rejects an origin refund credit that was not sent by the durable Relay depository', async () => {
  const sourceTransactionHash = `0x${'2'.repeat(64)}`;
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
  const sourceTransactionHash = `0x${'4'.repeat(64)}`;
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
  const sourceTransactionHash = `0x${'8'.repeat(64)}`;
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
      assert.equal(result.schema, 'hookemon.outbound-relay-settlement-evidence.v1', fixtureCase.name);
      assert.equal(result.relayLeg.state, 'SETTLED', fixtureCase.name);
    } else {
      assert.equal(result, null, fixtureCase.name);
    }
    assert.deepEqual(cycleRepository.recoverySelectors, [{
      stage: 'outbound',
      recipient: null,
      requestDigest: `sha256:${'e'.repeat(64)}`,
      rawSignedBytesHash: sourceTransactionHash,
    }], fixtureCase.name);

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
      assert.equal(replay.schema, 'hookemon.outbound-relay-settlement-evidence.v1', `${fixtureCase.name} restart`);
      assert.equal(replay.relayLeg.state, 'SETTLED', `${fixtureCase.name} restart`);
    } else {
      assert.equal(replay, null, `${fixtureCase.name} restart`);
    }
  }
});

test('reconcileLiveOutbound retains the wallet nonce reservation while source finality is unresolved', async () => {
  const sourceTransactionHash = `0x${'7'.repeat(64)}`;
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

/**
 * A real, offline-signed EVM transaction for the exact USDG `approve` call the outbound leg's
 * prerequisite must be -- never a placeholder. Defaults to the canonical role (Operations signer,
 * Relay depository spender, the leg's own source amount, zero value, nonce 8 immediately preceding
 * the deposit's durable nonce 9); overrides let a case deviate along exactly one dimension.
 */
async function signOutboundApproval({
  signer = OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT,
  spender = RELAY_DEPOSITORY,
  amountAtomic = quoteFixture.details.currencyIn.amount,
  nonce = 8,
  to = quoteFixture.details.currencyIn.currency.address,
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
      rawBytes: '0x1234',
      nonce: sourceNonce,
      blockhash: null,
      hash: sourceHash,
    },
  };
  let extra = attempts.map(fields => ({
    attempt: { schema: 'hookemon.chain-transaction-attempt.v1', cycleId, stage: 'outbound', blockhash: null, ...fields },
  }));
  const leg = {
    schema: 'hookemon.relay-leg.v1',
    cycleId,
    direction: 'outbound',
    relayRequestId,
    quoteDigest: `sha256:${'f'.repeat(64)}`,
    sourceChainId: '4663',
    sourceTxHash: sourceHash,
    sourceAssetId: quoteFixture.details.currencyIn.currency.address.toLowerCase(),
    sourceDecimals: 6,
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
          [`outbound ${sourceRecord.attempt.requestDigest}`, structuredClone(sourceRecord)],
          ...extra.map(entry => [`outbound ${entry.attempt.requestDigest}`, structuredClone(entry)]),
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

/**
 * One Robinhood RPC client answering for both outbound EVM transactions on their own hashes: the
 * deposit (source, same finalized-and-successful shape as `finalizedOutboundSourceClient`) and the
 * approval (prerequisite), independently parameterized so a test can make only the approval's own
 * receipt missing, reverted, or non-canonical without touching the deposit's evidence at all.
 */
function outboundApprovalEvmClient({
  sourceTransactionHash,
  sourceAmountAtomic,
  approvalHash,
  approvalIncluded = true,
  approvalStatus = 'success',
  approvalBlockNumber = 90n,
  approvalBlockHash = `0x${'7'.repeat(64)}`,
  approvalCanonicalBlockHash = approvalBlockHash,
}) {
  const sourceReceiptBlockHash = `0x${'a'.repeat(64)}`;
  const sourceParentBlockHash = `0x${'b'.repeat(64)}`;
  const finalizedBlockHash = `0x${'c'.repeat(64)}`;
  const amount = BigInt(sourceAmountAtomic);
  const sourceReceipt = {
    transactionHash: sourceTransactionHash,
    blockNumber: 100n,
    blockHash: sourceReceiptBlockHash,
    status: 'success',
    logs: [{
      address: quoteFixture.details.currencyIn.currency.address,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address), addressTopic(RELAY_DEPOSITORY)],
      data: `0x${amount.toString(16).padStart(64, '0')}`,
      logIndex: 0n,
    }],
  };
  const approvalReceipt = approvalIncluded
    ? {
      transactionHash: approvalHash, blockNumber: approvalBlockNumber, blockHash: approvalBlockHash, status: approvalStatus, logs: [],
    }
    : {
      transactionHash: approvalHash, blockNumber: null, blockHash: null, status: null, logs: [],
    };
  const calls = [];
  return {
    calls,
    async getTransactionReceipt({ hash }) {
      calls.push(`receipt:${hash}`);
      if (hash === sourceTransactionHash) return structuredClone(sourceReceipt);
      if (hash === approvalHash) return structuredClone(approvalReceipt);
      throw new Error(`unexpected transaction receipt ${hash}`);
    },
    async getBlock({ blockTag, blockNumber }) {
      calls.push(`block:${blockTag ?? blockNumber}`);
      if (blockTag === 'finalized') return { number: 101n, hash: finalizedBlockHash, timestamp: 1_700_000_090n };
      if (blockNumber === 100n) return { number: 100n, hash: sourceReceiptBlockHash, parentHash: sourceParentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: sourceParentBlockHash, parentHash: `0x${'d'.repeat(64)}`, timestamp: 1_700_000_070n };
      if (blockNumber === approvalBlockNumber) return { number: approvalBlockNumber, hash: approvalCanonicalBlockHash, timestamp: 1_700_000_060n };
      throw new Error(`unexpected outbound block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

function outboundApprovalTestConfig() {
  return {
    accounts: { evm: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address, solana: SOLANA_ACCOUNT },
    relay: { solanaMint: SOLANA_MINT, evmDepository: RELAY_DEPOSITORY },
  };
}

test('reconcileLiveOutbound fails closed unless the durable outbound attempt set is exactly the canonical two-step envelope', async () => {
  const sourceHash = `0x${'6'.repeat(64)}`;
  const relayRequestId = 'relay-outbound-approval-membership';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  const amountAtomic = quoteFixture.details.currencyIn.amount;

  const cases = [
    { name: 'no prerequisite attempt', build: async () => [] },
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
  const sourceHash = `0x${'6'.repeat(64)}`;
  const relayRequestId = 'relay-outbound-approval-finalized-invalid';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  // Wrong spender: a durable FINALIZED attempt's role is still checked from its own bytes, never
  // trusted merely because an earlier run marked it finalized.
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

test('reconcileLiveOutbound reconciles a durably SETTLED leg whose approval attempt is still BROADCAST, without re-settling', async () => {
  const sourceHash = `0x${'6'.repeat(64)}`;
  const relayRequestId = 'relay-outbound-approval-restart';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  const approval = await signOutboundApproval();
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
    attempts: [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: approval.hash, nonce: '8', state: 'BROADCAST', rawBytes: approval.rawBytes }],
  });
  const client = outboundApprovalEvmClient({
    sourceTransactionHash: sourceHash,
    sourceAmountAtomic: quoteFixture.details.currencyIn.amount,
    approvalHash: approval.hash,
  });
  const config = outboundApprovalTestConfig();

  const result = await reconcileLiveOutbound({
    adapters: {
      robinhood: { client, historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount, sourceAccount: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address }) },
      solana: { client: throwingSolanaClient() },
    },
    config,
    cycleRepository,
    context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
  });

  assert.equal(result.schema, 'hookemon.outbound-relay-settlement-evidence.v1');
  assert.equal(result.relayLeg.state, 'SETTLED');
  assert.equal(cycleRepository.attemptStates[APPROVAL_REQUEST_DIGEST], 'FINALIZED');
  assert.equal(cycleRepository.finalityCalls.length, 1);
  assert.equal(cycleRepository.finalityCalls[0].requestDigest, APPROVAL_REQUEST_DIGEST);
  assert.equal(client.calls.includes(`receipt:${approval.hash}`), true);
  // The leg was already durably SETTLED: no new settlement may be recorded, and (proven by the
  // throwing Solana client above) destination evidence is never re-inspected.
  assert.deepEqual(cycleRepository.settlements, []);

  const replay = await reconcileLiveOutbound({
    adapters: { robinhood: { client: throwingRobinhoodClient() }, solana: { client: throwingSolanaClient() } },
    config,
    cycleRepository,
    context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
  });
  assert.equal(replay.schema, 'hookemon.outbound-relay-settlement-evidence.v1');
  assert.equal(replay.relayLeg.state, 'SETTLED');
  assert.equal(cycleRepository.finalityCalls.length, 1);
  assert.deepEqual(cycleRepository.settlements, []);
});

test('reconcileLiveOutbound independently finalizes the approval and deposit before settling, and is restart-idempotent', async () => {
  const sourceHash = `0x${'6'.repeat(64)}`;
  const relayRequestId = 'relay-outbound-approval-success';
  const destinationAmountAtomic = quoteFixture.details.currencyOut.amount;
  const approval = await signOutboundApproval();
  const cycleRepository = outboundApprovalRepository({
    relayRequestId,
    destinationAmountAtomic,
    sourceHash,
    attempts: [{ requestDigest: APPROVAL_REQUEST_DIGEST, hash: approval.hash, nonce: '8', state: 'BROADCAST', rawBytes: approval.rawBytes }],
  });
  const destination = discoveredOutboundDestinationClient({ relayRequestId, mint: SOLANA_MINT, amountAtomic: destinationAmountAtomic });
  const client = outboundApprovalEvmClient({
    sourceTransactionHash: sourceHash,
    sourceAmountAtomic: quoteFixture.details.currencyIn.amount,
    approvalHash: approval.hash,
  });
  const config = outboundApprovalTestConfig();

  const result = await reconcileLiveOutbound({
    adapters: {
      robinhood: { client, historicalEvidenceClient: outboundArchiveEvidence({ amountAtomic: quoteFixture.details.currencyIn.amount, sourceAccount: OUTBOUND_APPROVAL_OPERATIONS_ACCOUNT.address }) },
      solana: { client: destination.client },
    },
    config,
    cycleRepository,
    context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
  });

  assert.equal(result.schema, 'hookemon.outbound-relay-settlement-evidence.v1');
  assert.equal(result.relayLeg.state, 'SETTLED');
  assert.equal(cycleRepository.attemptStates[APPROVAL_REQUEST_DIGEST], 'FINALIZED');
  assert.equal(cycleRepository.sourceAttemptState, 'FINALIZED');
  assert.equal(cycleRepository.finalityCalls.length, 2);
  const approvalFinality = cycleRepository.finalityCalls.find(entry => entry.requestDigest === APPROVAL_REQUEST_DIGEST);
  assert.equal(approvalFinality.evidence.transactionHash, approval.hash.toLowerCase());
  assert.deepEqual(approvalFinality.evidence.finalizedAt, { height: '90', hash: `0x${'7'.repeat(64)}`, timestampUnixSeconds: '1700000060' });
  assert.equal(cycleRepository.settlements.length, 1);
  assert.equal(cycleRepository.settlements[0].terminalState, 'SETTLED');
  assert.equal(client.calls.includes(`receipt:${approval.hash}`), true);
  assert.equal(client.calls.includes(`receipt:${sourceHash}`), true);

  // Restart: the durable repository already reflects FINALIZED/SETTLED. No EVM or Solana read of
  // any kind -- not even a re-check of the already-proven approval -- may happen, and nothing is
  // recorded or settled a second time.
  const replay = await reconcileLiveOutbound({
    adapters: { robinhood: { client: throwingRobinhoodClient() }, solana: { client: throwingSolanaClient() } },
    config,
    cycleRepository,
    context: { cycleId: 'cycle-outbound-reconcile', fencingToken: '11111111-1111-4111-8111-111111111111' },
  });
  assert.equal(replay.schema, 'hookemon.outbound-relay-settlement-evidence.v1');
  assert.equal(replay.relayLeg.state, 'SETTLED');
  assert.equal(cycleRepository.finalityCalls.length, 2);
  assert.equal(cycleRepository.settlements.length, 1);
});

function moneyConfiguration({ solanaMint = SOLANA_MINT } = {}) {
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: quoteFixture.details.currencyIn.currency.address.toLowerCase(), decimals: 6 },
      solanaStablecoin: { chainId: '792703809', assetId: solanaMint, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: quoteFixture.details.currencyIn.currency.address.toLowerCase(), decimals: 6, amountAtomic: '0' },
      solanaReceive: { chainId: '792703809', assetId: solanaMint, decimals: 6, amountAtomic: '0' },
      returnUsdg: { chainId: '4663', assetId: quoteFixture.details.currencyIn.currency.address.toLowerCase(), decimals: 6, amountAtomic: '0' },
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
  const deposit = quote.steps[1].items[0].data;
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
        async getBalance() { return 10_000_000_000_000_000n; },
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
  assert.equal(cycleRepository.relayLeg.state, 'RECORDED');
  assert.equal([...cycleRepository.attempts.values()][0].attempt.state, 'SIGNED');
  const persisted = [...cycleRepository.attempts.values()][0].attempt.rawBytes;

  await mutateOutbound({
    liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    now: () => (quote.protocol.v2.orderData.output.deadline * 1000) - 1,
  });
  assert.equal(signCalls, 2);
  assert.equal(broadcastCalls, 3);
  assert.equal(firstRawBytes, persisted);
  assert.equal(cycleRepository.relayLeg.sourceTxHash, keccak256([...cycleRepository.attempts.values()][1].attempt.rawBytes));
  assert.deepEqual(
    cycleRepository.recoveryContexts.map(recovery => recovery.relayQuoteDeadlineUnixSeconds),
    [String(quote.protocol.v2.orderData.output.deadline), String(quote.protocol.v2.orderData.output.deadline)],
  );
  assert.equal(cycleRepository.reservations.some(([kind]) => kind === 'reserve'), true);
});
