import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Keypair, Transaction } from '@solana/web3.js';

import { createRelayClient, RelayIntentAuthenticationError } from '../../src/relay-client.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { TOKEN_PROGRAM_ID, createSolanaRpcClient, signedSolanaTransactionSignature } from '../../src/solana-rpc.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  ReturnRecoveryRequiredError,
  isProcessRpcReturnLegDestinationProof,
  mutateReturn,
  prepareReturnRequest,
  readReturnLegDestinationProof,
  reconcileLiveReturn,
} from '../../src/app/stages/return.mjs';

const EVM_ACCOUNT = '0x000000000000000000000000000000000000dEaD';
const SOLANA_ACCOUNT = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-return-stage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/relay/${name}`, import.meta.url)), 'utf8'));
}

const chains = fixture('chains.json');
const quoteFixture = fixture('quote-return.json');

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function relayClient() {
  return createRelayClient({
    fetchImpl: async (url, options) => {
      if (options.method === 'GET' && url.pathname === '/chains') return response(chains);
      if (options.method === 'POST' && url.pathname === '/quote/v2') return response(quoteFixture);
      throw new Error(`unexpected Relay request ${options.method} ${url.pathname}`);
    },
  });
}

function custodyLedger({ proceeds = '24000000', committed = '0' } = {}) {
  return {
    chainId: '792703809',
    assetId: SOLANA_MINT,
    decimals: 6,
    buybackProceeds: proceeds,
    returnInput: committed,
  };
}

function repository(ledger = custodyLedger()) {
  return {
    async describeCycle() {
      return { custodyLedgers: new Map([[`${ledger.chainId}\u0000${ledger.assetId}`, ledger]]) };
    },
  };
}

test('prepareReturnRequest bridges only the custody-ledger-attributed proceeds delta and preserves the recorded Relay Solana instruction shape', async () => {
  const nowMs = (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1;
  const request = await prepareReturnRequest({
    adapters: { relay: relayClient() },
    config: {
      chainId: 4663,
      accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
      relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
      moneyConfiguration: moneyConfiguration(),
    },
    cycleRepository: repository(),
    context: { cycleId: 'cycle-return-1' },
    nowMs,
  });
  assert.equal(request.schema, 'hookemon.return-relay-request.v1');
  assert.deepEqual(request.inputAmount, {
    chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '24000000',
  });
  assert.deepEqual(request.destinationAmount, {
    chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '23843750',
  });
  assert.equal(request.intent.requestId, quoteFixture.requestId);
  assert.equal(request.requestCreatedAtUnixSeconds, String(Math.floor(nowMs / 1000)));
  assert.equal(request.maxSettlementWindowSeconds, '600');
  assert.deepEqual(request.solanaInstructionPlan, {
    instructions: quoteFixture.steps[0].items[0].data.instructions,
    addressLookupTableAddresses: quoteFixture.steps[0].items[0].data.addressLookupTableAddresses,
  });
});

test('prepareReturnRequest refuses a fresh return when every cycle-attributed proceed has already been committed', async () => {
  await assert.rejects(
    () => prepareReturnRequest({
      adapters: { relay: relayClient() },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository: repository(custodyLedger({ proceeds: '24000000', committed: '24000000' })),
      context: { cycleId: 'cycle-return-2' },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /no uncommitted cycle-attributed proceeds/,
  );
});

test('prepareReturnRequest refuses every nonzero return minimum before requesting a Relay quote', async () => {
  const configuredMoney = moneyConfiguration();
  await assert.rejects(
    () => prepareReturnRequest({
      adapters: { relay: relayClient() },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
        relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
        moneyConfiguration: {
          ...configuredMoney,
          minimums: {
            ...configuredMoney.minimums,
            returnUsdg: { ...configuredMoney.minimums.returnUsdg, amountAtomic: '2' },
          },
        },
      },
      cycleRepository: repository(),
      context: { cycleId: 'cycle-return-nonzero-minimum' },
      nowMs: (quoteFixture.protocol.v2.orderData.output.deadline * 1000) - 1,
    }),
    /returnUsdg.*zero/,
  );
});

function returnIntent() {
  return {
    schema: 'hookemon.relay-intent.v1',
    requestId: quoteFixture.requestId,
    orderId: quoteFixture.protocol.v2.orderId,
    direction: 'RETURN',
    originChainId: 792703809,
    destinationChainId: 4663,
    originAssetId: SOLANA_MINT,
    originDecimals: 6,
    destinationAssetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    destinationDecimals: 6,
    originAmount: quoteFixture.details.currencyIn.amount,
    quotedDestinationAmount: quoteFixture.details.currencyOut.amount,
    quotedDestinationMinimumAmount: quoteFixture.details.currencyOut.minimumAmount,
    sender: SOLANA_ACCOUNT,
    recipient: EVM_ACCOUNT,
    deadlineUnixSeconds: quoteFixture.protocol.v2.orderData.output.deadline,
  };
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function robinhoodClientWithCredit(amountAtomic, transactionHash = `0x${'a'.repeat(64)}`) {
  return {
    async getTransactionReceipt() {
      return {
        transactionHash,
        blockNumber: 100n,
        status: 'success',
        logs: amountAtomic === null ? [] : [{
          address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(EVM_ACCOUNT)],
          data: `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag }) {
      assert.equal(blockTag, 'finalized');
      return { number: 100n, hash: `0x${'b'.repeat(64)}` };
    },
  };
}

test('reconcileLiveReturn refuses unauthenticated Relay status data before it can settle a cycle', async () => {
  const intent = returnIntent();
  let statusCalls = 0;
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: {
        relay: {
          restoreIntent() {},
          async getIntentStatus() {
            statusCalls += 1;
            return { status: 'SUCCESS', originChainId: 792703809, destinationChainId: 4663, txHashes: [`0x${'a'.repeat(64)}`] };
          },
        },
        robinhood: { client: robinhoodClientWithCredit(quoteFixture.details.currencyOut.minimumAmount) },
      },
      config: { accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT }, relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' } },
      cycleRepository: { async readOperationalStageAttempt() { return { responseEvidence: { intent } }; } },
      context: { cycleId: 'cycle-return-unattested-status' },
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_SETTLEMENT_UNATTESTED',
  );
  assert.equal(statusCalls, 0);
});

function returnReconciliationRepository({ sourceTransactionHash, relayRequestId, sourceAmountAtomic, destinationAmountAtomic }) {
  let record = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId: 'cycle-return-reconcile',
      stage: 'return',
      state: 'BROADCAST',
      requestDigest: `sha256:${'d'.repeat(64)}`,
      rawBytes: 'signed-return-bytes',
      nonce: null,
      blockhash: 'return-blockhash',
      hash: `sha256:${'e'.repeat(64)}`,
    },
  };
  const leg = {
    schema: 'hookemon.relay-leg.v1',
    cycleId: 'cycle-return-reconcile',
    direction: 'return',
    relayRequestId,
    quoteDigest: `sha256:${'f'.repeat(64)}`,
    sourceChainId: '792703809',
    sourceTxHash: sourceTransactionHash,
    sourceAssetId: SOLANA_MINT,
    sourceDecimals: 6,
    sourceAmountAtomic,
    destinationChainId: '4663',
    destinationTxHash: null,
    destinationAssetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    destinationDecimals: 6,
    destinationAmountAtomic,
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
  };
  const finalities = [];
  const walletReleases = [];
  let settleCalls = 0;
  return {
    get finalities() { return structuredClone(finalities); },
    get walletReleases() { return structuredClone(walletReleases); },
    get settleCalls() { return settleCalls; },
    async describeCycle() {
      return {
        relayLegs: new Map([[relayRequestId, structuredClone(leg)]]),
        chainAttempts: new Map([[`return\u0000${record.attempt.requestDigest}`, structuredClone(record)]]),
      };
    },
    async recordBroadcast() {
      throw new Error('a broadcast attempt must not be rebroadcast during finality reconciliation');
    },
    async recordFinality(_cycleId, stage, requestDigest, evidence) {
      assert.equal(stage, 'return');
      assert.equal(requestDigest, record.attempt.requestDigest);
      finalities.push(structuredClone(evidence));
      record = { ...record, attempt: { ...record.attempt, state: 'FINALIZED' } };
      return structuredClone(record);
    },
    async settleRelayLeg() {
      settleCalls += 1;
      throw new Error('return may not settle an EVM credit without documented request attribution');
    },
    async releaseWalletNonce(cycleId, reservation) {
      walletReleases.push({ cycleId, reservation: structuredClone(reservation) });
    },
  };
}

test('reconcileLiveReturn does not inspect a destination receipt without an authenticated terminal Relay pointer', async () => {
  const sourceTransactionHash = 'return-source-signature';
  const sourceAmountAtomic = '17';
  const destinationAmountAtomic = '16';
  const cycleRepository = returnReconciliationRepository({
    sourceTransactionHash,
    relayRequestId: 'relay-return-unattributed-credit',
    sourceAmountAtomic,
    destinationAmountAtomic,
  });
  let evmReads = 0;

  const result = await reconcileLiveReturn({
    adapters: {
      solana: { client: returnSourceFinalityClient({ owner: SOLANA_ACCOUNT, amountAtomic: sourceAmountAtomic }) },
      robinhood: {
        client: new Proxy({}, {
          get() {
            evmReads += 1;
            throw new Error('EVM destination reads need a documented request-id or memo attribution contract');
          },
        }),
      },
    },
    config: { accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT }, relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' } },
    cycleRepository,
    context: {
      cycleId: 'cycle-return-reconcile',
      fencingToken: '22222222-2222-4222-8222-222222222222',
    },
  });

  assert.equal(result, null);
  assert.equal(evmReads, 0);
  assert.equal(cycleRepository.settleCalls, 0);
  assert.equal(cycleRepository.finalities.length, 1);
  assert.equal(cycleRepository.finalities[0].debitedAmountAtomic, sourceAmountAtomic);
  assert.deepEqual(cycleRepository.walletReleases, [{
    cycleId: 'cycle-return-reconcile',
    reservation: {
      chainId: '792703809',
      wallet: SOLANA_ACCOUNT,
      stage: 'return',
      fencingToken: '22222222-2222-4222-8222-222222222222',
      leaseAcquiredAtMs: 0,
      leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
    },
  }]);
});

test('reconcileLiveReturn retains the wallet nonce reservation while source finality is unavailable', async () => {
  const sourceTransactionHash = 'return-source-unfinalized';
  const cycleRepository = returnReconciliationRepository({
    sourceTransactionHash,
    relayRequestId: 'relay-return-unfinalized',
    sourceAmountAtomic: '17',
    destinationAmountAtomic: '16',
  });

  const result = await reconcileLiveReturn({
    adapters: {
      solana: {
        client: {
          async request() {
            throw new Error('source transaction is not finalized');
          },
        },
      },
    },
    config: { accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT }, relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' } },
    cycleRepository,
    context: {
      cycleId: 'cycle-return-reconcile',
      fencingToken: '22222222-2222-4222-8222-222222222222',
    },
  });

  assert.equal(result, null);
  assert.deepEqual(cycleRepository.finalities, []);
  assert.deepEqual(cycleRepository.walletReleases, []);
  assert.equal(cycleRepository.settleCalls, 0);
});

function moneyConfiguration() {
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
      solanaStablecoin: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '0' },
      solanaReceive: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '0' },
      returnUsdg: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '1000' },
    },
  };
}

function splTransferCheckedPlan({ owner, source, destination, amountAtomic }) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amountAtomic), 1);
  data.writeUInt8(6, 9);
  return {
    instructions: [{
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: SOLANA_MINT, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: data.toString('hex'),
    }],
    addressLookupTableAddresses: [],
  };
}

function computeBudgetInstruction({ owner, tag, value }) {
  const data = Buffer.alloc(tag === 2 ? 5 : 9);
  data.writeUInt8(tag, 0);
  if (tag === 2) data.writeUInt32LE(value, 1);
  else data.writeBigUInt64LE(BigInt(value), 1);
  return {
    programId: 'ComputeBudget111111111111111111111111111111',
    keys: [{ pubkey: owner, isSigner: false, isWritable: false }],
    data: data.toString('hex'),
  };
}

function priorityFeeReturnPlan({ owner, source, destination, amountAtomic }) {
  const transfer = splTransferCheckedPlan({ owner, source, destination, amountAtomic });
  return {
    instructions: [
      computeBudgetInstruction({ owner, tag: 2, value: 1_000_000 }),
      computeBudgetInstruction({ owner, tag: 3, value: '2' }),
      ...transfer.instructions,
    ],
    addressLookupTableAddresses: [],
  };
}

function returnChainRepository({ operator, proceeds = '17' }) {
  const attempts = new Map();
  const recoveryContexts = new Map();
  const reservations = [];
  const walletReleases = [];
  let relayLeg = null;
  const ledger = custodyLedger({ proceeds, committed: '0' });
  return {
    get attempts() { return attempts; },
    get relayLeg() { return relayLeg; },
    get reservations() { return structuredClone(reservations); },
    get walletReleases() { return structuredClone(walletReleases); },
    async describeCycle() {
      return {
        custodyLedgers: new Map([[`${ledger.chainId}\u0000${ledger.assetId}`, ledger]]),
        chainAttempts: new Map(attempts),
        relayLegs: relayLeg === null ? new Map() : new Map([[relayLeg.relayRequestId, relayLeg]]),
      };
    },
    async readChainTransactionAttempt(_cycleId, stage, requestDigest) {
      return attempts.get(`${stage}\u0000${requestDigest}`) ?? null;
    },
    async prepareChainTransactionAttempt(_cycleId, stage, attempt) {
      const key = `${stage}\u0000${attempt.requestDigest}`;
      const record = attempts.get(key) ?? { attempt, broadcastEvidence: null, finalityEvidence: null };
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
    async recordFinality(_cycleId, stage, requestDigest, evidence) {
      const key = `${stage}\u0000${requestDigest}`;
      const existing = attempts.get(key);
      const record = { ...existing, attempt: { ...existing.attempt, state: 'FINALIZED' }, finalityEvidence: evidence };
      attempts.set(key, record);
      return record;
    },
    async recordRelayLeg(_cycleId, leg) {
      relayLeg ??= structuredClone(leg);
      return structuredClone(relayLeg);
    },
    async recordRelayLegSource(_cycleId, requestId, sourceTxHash) {
      assert.equal(requestId, relayLeg.relayRequestId);
      relayLeg = { ...relayLeg, sourceTxHash };
      return structuredClone(relayLeg);
    },
    async readRelayLeg() { return relayLeg === null ? null : structuredClone(relayLeg); },
    async reserveWalletNonce(cycleId, reservation) { reservations.push(['reserve', cycleId, structuredClone(reservation)]); },
    async assertWalletNonce(cycleId, reservation) { reservations.push(['assert', cycleId, structuredClone(reservation)]); },
    async releaseWalletNonce(cycleId, reservation) { walletReleases.push(['release', cycleId, structuredClone(reservation)]); },
    async persistChainAttemptRecoveryContext(_cycleId, context) {
      recoveryContexts.set(`${context.stage}\u0000${context.requestDigest}`, structuredClone(context));
      return structuredClone(context);
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      return recoveryContexts.get(`${selector.stage}\u0000${selector.requestDigest}`) ?? null;
    },
  };
}

function returnSolanaClient(blockhash, state = { blockHeight: 10, balance: 10_000 }) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const resultByMethod = {
        getBalance: { context: { slot: 9 }, value: state.balance ?? 10_000 },
        getLatestBlockhash: { context: { slot: 10 }, value: { blockhash, lastValidBlockHeight: 100 } },
        isBlockhashValid: { context: { slot: 10 }, value: true },
        getBlockHeight: state.blockHeight,
      };
      if (!Object.hasOwn(resultByMethod, body.method)) throw new Error(`unexpected Solana RPC ${body.method}`);
      return response({ jsonrpc: '2.0', id: body.id, result: resultByMethod[body.method] });
    },
  });
}

function returnSourceFinalityClient({ owner, amountAtomic }) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.method, 'getTransaction');
      return response({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          slot: 52,
          blockTime: 1_700_000_080,
          transaction: {
            message: {
              accountKeys: [{ pubkey: owner, signer: false, writable: true }],
              instructions: [],
            },
          },
          meta: {
            err: null,
            preTokenBalances: [{
              accountIndex: 0,
              mint: SOLANA_MINT,
              owner,
              uiTokenAmount: { amount: amountAtomic, decimals: 6, uiAmountString: '0.000017' },
            }],
            postTokenBalances: [{
              accountIndex: 0,
              mint: SOLANA_MINT,
              owner,
              uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' },
            }],
          },
        },
      });
    },
  });
}

function returnReconciliationConfig() {
  return {
    accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
  };
}

function returnDestinationReceiptClient({
  transactionHash,
  observedToken = '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  observedRecipient = EVM_ACCOUNT,
  observedAmountAtomic = '16',
  timestampUnixSeconds = '1700000100',
  finalized = true,
} = {}) {
  const receiptBlockHash = `0x${'a'.repeat(64)}`;
  const finalizedBlockHash = `0x${'b'.repeat(64)}`;
  return {
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, transactionHash);
      return {
        transactionHash,
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: 'success',
        logs: [{
          address: observedToken,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(observedRecipient)],
          data: `0x${BigInt(observedAmountAtomic).toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') {
        return {
          number: finalized ? 101n : 99n,
          hash: finalizedBlockHash,
          timestamp: BigInt(timestampUnixSeconds),
        };
      }
      if (blockNumber === 100n) {
        return { number: 100n, hash: receiptBlockHash, timestamp: BigInt(timestampUnixSeconds) };
      }
      throw new Error(`unexpected return receipt block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

test('return destination proof rejects a case-altered Solana source signature while accepting a canonicalized EVM destination hash', async () => {
  const sourceTxHash = 'A'.repeat(88);
  const destinationTxHash = `0x${'C'.repeat(64)}`;
  const proof = await readReturnLegDestinationProof({
    client: returnDestinationReceiptClient({ transactionHash: destinationTxHash }),
    pointer: {
      schema: 'hookemon.relay-terminal-destination-pointer.v1',
      relayRequestId: 'relay-return-byte-exact-source',
      status: 'SUCCESS',
      destinationTxHash,
    },
    leg: {
      relayRequestId: 'relay-return-byte-exact-source',
      sourceTxHash,
    },
    sourceFinality: {
      height: '52',
      hash: 'solana-finality-hash',
      timestampUnixSeconds: '1700000080',
    },
  });

  assert.equal(isProcessRpcReturnLegDestinationProof(proof, {
    sourceTxHash,
    destinationTxHash: destinationTxHash.toLowerCase(),
  }), true);
  assert.equal(isProcessRpcReturnLegDestinationProof(proof, {
    sourceTxHash: sourceTxHash.toLowerCase(),
  }), false);
});

function terminalReturnPointerClient({ intent, destinationTxHash }) {
  return createRelayClient({
    fetchImpl: async (url, options) => {
      if (options.method === 'GET' && url.pathname === '/intents/status/v3') {
        return response({
          status: 'success',
          originChainId: intent.originChainId,
          destinationChainId: intent.destinationChainId,
          inTxHashes: ['return-source-signature'],
          txHashes: [destinationTxHash],
        });
      }
      throw new Error(`unexpected Relay reconciliation request ${options.method} ${url.pathname}`);
    },
  });
}

async function seededReturnReconciliation(t, {
  requestCreatedAtUnixSeconds = '1700000000',
  maxSettlementWindowSeconds = '600',
} = {}) {
  const directory = await tempDirectory(t);
  const cycleRepository = await CycleRepository.open(directory);
  const { cycleId } = await cycleRepository.createCycle({ releaseAmount: '1', mode: 'production' });
  const relayRequestId = `relay-return-${cycleId}`;
  const intent = {
    ...returnIntent(),
    requestId: relayRequestId,
    originAmount: '17',
    quotedDestinationAmount: '16',
    quotedDestinationMinimumAmount: '16',
    deadlineUnixSeconds: 1800000000,
  };
  const recorded = await cycleRepository.recordRelayLeg(cycleId, {
    schema: 'hookemon.relay-leg.v1',
    cycleId,
    direction: 'return',
    relayRequestId,
    quoteDigest: `sha256:${'9'.repeat(64)}`,
    sourceChainId: '792703809',
    sourceTxHash: null,
    sourceAssetId: SOLANA_MINT,
    sourceDecimals: 6,
    sourceAmountAtomic: '17',
    destinationChainId: '4663',
    destinationTxHash: null,
    destinationAssetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    destinationDecimals: 6,
    destinationAmountAtomic: '16',
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent,
      requestCreatedAtUnixSeconds,
      maxSettlementWindowSeconds,
    },
  });
  const sourceTxHash = `return-source-${cycleId}`;
  const leg = await cycleRepository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  await cycleRepository.prepareChainTransactionAttempt(cycleId, 'return', {
    schema: 'hookemon.chain-transaction-attempt.v1',
    cycleId,
    stage: 'return',
    state: 'PREPARED',
    requestDigest,
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
  });
  await cycleRepository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: 'return-signed-bytes',
    nonce: null,
    blockhash: 'return-blockhash',
    hash: `sha256:${'6'.repeat(64)}`,
  });
  await cycleRepository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: sourceTxHash });
  const context = {
    cycleId,
    fencingToken: '22222222-2222-4222-8222-222222222222',
  };
  await cycleRepository.reserveWalletNonce(cycleId, {
    chainId: '792703809',
    wallet: SOLANA_ACCOUNT,
    stage: 'return',
    fencingToken: context.fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  return { directory, cycleRepository, cycleId, context, intent, leg, requestDigest };
}

async function reconcileSeededReturn(fixture, receipt) {
  const destinationTxHash = receipt.transactionHash;
  return reconcileLiveReturn({
    adapters: {
      solana: { client: returnSourceFinalityClient({ owner: SOLANA_ACCOUNT, amountAtomic: fixture.leg.sourceAmountAtomic }) },
      relay: terminalReturnPointerClient({ intent: fixture.intent, destinationTxHash }),
      robinhood: { client: receipt.client },
    },
    config: returnReconciliationConfig(),
    cycleRepository: fixture.cycleRepository,
    context: fixture.context,
  });
}

test('reconcileLiveReturn settles an exact terminal Relay pointer through a finalized process-RPC receipt and reopens custody', async t => {
  const fixture = await seededReturnReconciliation(t);
  const transactionHash = `0x${'c'.repeat(64)}`;
  const result = await reconcileSeededReturn(fixture, {
    transactionHash,
    client: returnDestinationReceiptClient({ transactionHash }),
  });

  assert.equal(result.schema, 'hookemon.return-relay-settlement-evidence.v1');
  assert.equal(result.relayLeg.state, 'SETTLED');
  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'SETTLED');
  assert.equal(state.custodyLedgers.get('4663\u00000x5fc5360d0400a0fd4f2af552add042d716f1d168').returnReceived, '16');
  assert.equal((await reopened.readChainTransactionAttempt(fixture.cycleId, 'return', fixture.requestDigest)).attempt.state, 'FINALIZED');
});

test('reconcileLiveReturn holds a wrong-amount return receipt as HELD_RELAY_PARTIAL after reopen', async t => {
  const fixture = await seededReturnReconciliation(t);
  const transactionHash = `0x${'d'.repeat(64)}`;
  const result = await reconcileSeededReturn(fixture, {
    transactionHash,
    client: returnDestinationReceiptClient({ transactionHash, observedAmountAtomic: '15' }),
  });

  assert.equal(result, null);
  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, 'HELD_RELAY_PARTIAL');
  assert.equal(state.custodyLedgers.get('4663\u00000x5fc5360d0400a0fd4f2af552add042d716f1d168'), undefined);
});

test('reconcileLiveReturn holds a late return receipt as HELD_RELAY_LATE after reopen', async t => {
  const fixture = await seededReturnReconciliation(t);
  const transactionHash = `0x${'e'.repeat(64)}`;
  const result = await reconcileSeededReturn(fixture, {
    transactionHash,
    client: returnDestinationReceiptClient({ transactionHash, timestampUnixSeconds: '1700000601' }),
  });

  assert.equal(result, null);
  const reopened = await CycleRepository.open(fixture.directory);
  assert.equal((await reopened.describeCycle(fixture.cycleId)).terminalState, 'HELD_RELAY_LATE');
});

test('reconcileLiveReturn holds a wrong-token or wrong-recipient return receipt as HELD_RELAY_WRONG_ASSET after reopen', async t => {
  for (const [index, receiptFields] of [
    { observedToken: `0x${'1'.repeat(40)}` },
    { observedRecipient: `0x${'2'.repeat(40)}` },
  ].entries()) {
    const fixture = await seededReturnReconciliation(t);
    const transactionHash = `0x${String(index + 3).repeat(64)}`;
    const result = await reconcileSeededReturn(fixture, {
      transactionHash,
      client: returnDestinationReceiptClient({ transactionHash, ...receiptFields }),
    });
    assert.equal(result, null);

    const reopened = await CycleRepository.open(fixture.directory);
    assert.equal((await reopened.describeCycle(fixture.cycleId)).terminalState, 'HELD_RELAY_WRONG_ASSET');
  }
});

test('reconcileLiveReturn leaves an unfinalized return source without payout custody after reopen', async t => {
  const fixture = await seededReturnReconciliation(t);
  let pointerCalls = 0;
  const result = await reconcileLiveReturn({
    adapters: {
      solana: { client: { async request() { throw new Error('source finality is unavailable'); } } },
      relay: {
        restoreIntent() { pointerCalls += 1; },
        async getTerminalDestinationTransactionPointer() { pointerCalls += 1; return null; },
      },
      robinhood: { client: new Proxy({}, { get() { throw new Error('destination receipt must not be read'); } }) },
    },
    config: returnReconciliationConfig(),
    cycleRepository: fixture.cycleRepository,
    context: fixture.context,
  });

  assert.equal(result, null);
  assert.equal(pointerCalls, 0);
  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'RECORDED');
  assert.equal(state.custodyLedgers.get('4663\u00000x5fc5360d0400a0fd4f2af552add042d716f1d168'), undefined);
  assert.equal((await reopened.readChainTransactionAttempt(fixture.cycleId, 'return', fixture.requestDigest)).attempt.state, 'BROADCAST');
});

test('reconcileLiveReturn leaves a Relay pointer unsettled until the process-RPC destination receipt is finalized', async t => {
  const fixture = await seededReturnReconciliation(t);
  const transactionHash = `0x${'f'.repeat(64)}`;
  const result = await reconcileSeededReturn(fixture, {
    transactionHash,
    client: returnDestinationReceiptClient({ transactionHash, finalized: false }),
  });

  assert.equal(result, null);
  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'RECORDED');
  assert.equal(state.custodyLedgers.get('4663\u00000x5fc5360d0400a0fd4f2af552add042d716f1d168'), undefined);
});

test('mutateReturn preserves the configured lamport reserve after the maximum priority fee', async () => {
  const operator = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 11));
  const source = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 43));
  const destination = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 75));
  const blockhash = '11111111111111111111111111111111';
  const cycleId = 'cycle-return-reserve-after-fee';
  const cycleRepository = returnChainRepository({ operator: operator.publicKey.toBase58() });
  const request = {
    schema: 'hookemon.return-relay-request.v1',
    cycleId,
    inputAmount: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '17' },
    destinationAmount: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '16' },
    requestCreatedAtUnixSeconds: '1700000000',
    maxSettlementWindowSeconds: '600',
    intent: {
      ...returnIntent(),
      requestId: 'relay-return-reserve-after-fee',
      sender: operator.publicKey.toBase58(),
      originAmount: '17',
      quotedDestinationAmount: '16',
      quotedDestinationMinimumAmount: '16',
      deadlineUnixSeconds: 2_000_000_000,
    },
    solanaInstructionPlan: priorityFeeReturnPlan({
      owner: operator.publicKey.toBase58(),
      source: source.publicKey.toBase58(),
      destination: destination.publicKey.toBase58(),
      amountAtomic: '17',
    }),
  };
  let signCalls = 0;

  await assert.rejects(
    () => mutateReturn({
      liveMode: true,
      adapters: { solana: { client: returnSolanaClient(blockhash, { blockHeight: 10, balance: 1_001 }) } },
      signerClient: { solana: { async sign() { signCalls += 1; throw new Error('signer must not be reached'); }, async broadcast() {} } },
      config: {
        chainId: 4663,
        accounts: { evm: EVM_ACCOUNT, solana: operator.publicKey.toBase58() },
        relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
        moneyConfiguration: moneyConfiguration(),
      },
      cycleRepository,
      context: {
        cycleId,
        stage: 'return',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        fencingToken: '22222222-2222-4222-8222-222222222222',
      },
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
      now: () => 1_700_000_000_000,
    }),
    /lamport reserve after the maximum priority fee/,
  );
  assert.equal(signCalls, 0);
});

test('mutateReturn records a Relay leg before signing, resumes signed bytes, and leaves a broadcast attempt untouched on restart', async () => {
  const operator = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 11));
  const source = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 43));
  const destination = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 75));
  const blockhash = '11111111111111111111111111111111';
  const rpcState = { blockHeight: 10 };
  const cycleRepository = returnChainRepository({ operator: operator.publicKey.toBase58() });
  const request = {
    schema: 'hookemon.return-relay-request.v1',
    cycleId: 'cycle-return-durable',
    inputAmount: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '17' },
    destinationAmount: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '16' },
    requestCreatedAtUnixSeconds: '1700000000',
    maxSettlementWindowSeconds: '600',
    intent: {
      ...returnIntent(),
      requestId: 'relay-return-durable',
      sender: operator.publicKey.toBase58(),
      originAmount: '17',
      quotedDestinationAmount: '16',
      quotedDestinationMinimumAmount: '16',
      deadlineUnixSeconds: 2_000_000_000,
    },
    solanaInstructionPlan: splTransferCheckedPlan({
      owner: operator.publicKey.toBase58(),
      source: source.publicKey.toBase58(),
      destination: destination.publicKey.toBase58(),
      amountAtomic: '17',
    }),
  };
  const context = {
    cycleId: request.cycleId,
    stage: 'return',
    requestDigest: `sha256:${'c'.repeat(64)}`,
    fencingToken: '22222222-2222-4222-8222-222222222222',
  };
  const config = {
    chainId: 4663,
    accounts: { evm: EVM_ACCOUNT, solana: operator.publicKey.toBase58() },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: moneyConfiguration(),
  };
  let signCalls = 0;
  let broadcastCalls = 0;
  let persistedBytes = null;
  let sourceTransactionHash = null;
  const signerClient = {
    solana: {
      role: 'operator-solana',
      async sign({ transaction }) {
        signCalls += 1;
        const signed = Transaction.from(Buffer.from(transaction, 'base64'));
        signed.sign(operator);
        const signedTxBase64 = signed.serialize().toString('base64');
        sourceTransactionHash = signedSolanaTransactionSignature(signedTxBase64);
        return { signedTxBase64 };
      },
      async broadcast({ signedTxBase64 }) {
        broadcastCalls += 1;
        if (persistedBytes === null) {
          persistedBytes = signedTxBase64;
          throw new Error('broadcast interrupted after durable signature');
        }
        assert.equal(signedTxBase64, persistedBytes);
        return { transactionHash: sourceTransactionHash };
      },
    },
  };
  const adapters = { solana: { client: returnSolanaClient(blockhash, rpcState) } };

  await assert.rejects(
    () => mutateReturn({
      liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
      now: () => 1_700_000_000_000,
    }),
    /broadcast interrupted after durable signature/,
  );
  assert.equal(signCalls, 1);
  assert.equal(cycleRepository.relayLeg.state, 'RECORDED');
  assert.equal([...cycleRepository.attempts.values()][0].attempt.state, 'SIGNED');

  rpcState.blockHeight = 101;
  await assert.rejects(
    () => mutateReturn({
      liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
      now: () => 1_700_000_000_000,
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_SIGNED_BLOCKHASH_EXPIRED',
  );
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 1);
  rpcState.blockHeight = 10;

  await mutateReturn({
    liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    now: () => 1_700_000_000_000,
  });
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 2);
  assert.equal([...cycleRepository.attempts.values()][0].attempt.rawBytes, persistedBytes);
  assert.match(cycleRepository.relayLeg.sourceTxHash, /^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
  assert.equal(cycleRepository.reservations.some(([kind]) => kind === 'reserve'), true);

  await mutateReturn({
    liveMode: true, adapters, signerClient, config, cycleRepository, context, request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    now: () => 1_700_000_000_000,
  });
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 2);

  const reconciliation = await reconcileLiveReturn({
    adapters: { solana: { client: returnSourceFinalityClient({ owner: operator.publicKey.toBase58(), amountAtomic: '17' }) } },
    config,
    cycleRepository,
    context,
  });
  assert.equal(reconciliation, null);
  assert.equal([...cycleRepository.attempts.values()][0].attempt.state, 'FINALIZED');
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 2);
  assert.deepEqual(cycleRepository.walletReleases, [['release', request.cycleId, {
    chainId: '792703809',
    wallet: operator.publicKey.toBase58(),
    stage: 'return',
    fencingToken: context.fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  }]]);
});
