import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Keypair, Transaction } from '@solana/web3.js';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildTransferCheckedInstruction,
  buildUnsignedTransaction,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { TRANSACTION_POLICY_SCHEMA, decodeProviderTransaction } from '../../src/signing/transaction-policy.mjs';
import { policyFor } from '../signing/policy-fixture.mjs';
import {
  mutatePurchase,
  preparePurchaseRequest,
  reconcileLivePurchase,
} from '../../src/app/stages/purchase.mjs';
import {
  mutateOpen,
  prepareOpenRequest,
  reconcileLiveOpen,
} from '../../src/app/stages/open.mjs';
import {
  mutateEpicGate,
  prepareEpicGateRequest,
  probeEpicGate,
  reconcileLiveEpicGate,
} from '../../src/app/stages/epic-gate.mjs';
import {
  mutateBuyback,
  prepareBuybackRequest,
  reconcileLiveBuyback,
} from '../../src/app/stages/buyback.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createPreparedProviderMutationAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

const CYCLE_ID = 'cycle-collector-lifecycle';
const CHAIN_ID = 'solana-mainnet';
const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const PACK_ASSET = 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1';
const CARD_ASSET = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const SETTLEMENT_ASSET = CIRCLE_USD_MINT;
const COLLECTOR_RECIPIENT = '8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe';
const MEMO = 'memo-collector-lifecycle';
const PURCHASE_SIGNATURE = '5'.repeat(88);
const OPEN_SIGNATURE = '4'.repeat(88);
const BUYBACK_SIGNATURE = '3'.repeat(88);
const OPERATOR_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));

function jsonRpc(result, id = 1) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function tokenAccountResponse({ owner = OPERATOR, mint = PACK_ASSET, amount = '100', decimals = CIRCLE_USD_DECIMALS } = {}) {
  return {
    value: {
      owner: TOKEN_PROGRAM_ID,
      data: {
        program: 'spl-token',
        parsed: { type: 'account', info: { owner, mint, tokenAmount: { amount, decimals } } },
      },
    },
  };
}

function transactionResponse(entries) {
  const accountKeys = entries.map(entry => ({ pubkey: entry.tokenAccount, signer: false, writable: true }));
  const preTokenBalances = entries.map((entry, accountIndex) => ({
    accountIndex,
    mint: entry.mint,
    owner: entry.owner,
    uiTokenAmount: { amount: entry.preAmount, decimals: entry.decimals ?? 0, uiAmountString: entry.preAmount },
  }));
  const postTokenBalances = entries.map((entry, accountIndex) => ({
    accountIndex,
    mint: entry.mint,
    owner: entry.owner,
    uiTokenAmount: { amount: entry.postAmount, decimals: entry.decimals ?? 0, uiAmountString: entry.postAmount },
  }));
  return {
    transaction: { message: { accountKeys, instructions: [] } },
    meta: { preTokenBalances, postTokenBalances, innerInstructions: [] },
  };
}

function rpcClient({ tokenAccount = tokenAccountResponse(), entries = [], finalized = true, balance = 1_000_000 } = {}) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') return jsonRpc(tokenAccount, body.id);
      if (body.method === 'getBalance') return jsonRpc({ value: balance }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(99, body.id);
      if (body.method === 'getSignatureStatuses') {
        return jsonRpc({ value: [{ err: null, confirmationStatus: finalized ? 'finalized' : 'confirmed' }] }, body.id);
      }
      if (body.method === 'getTransaction') return jsonRpc(transactionResponse(entries), body.id);
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

function transactionFor({ mint = PACK_ASSET, amount = 1n, destination = COLLECTOR_RECIPIENT } = {}) {
  const source = deriveAssociatedTokenAddress(OPERATOR, mint).toBase58();
  const instruction = buildTransferCheckedInstruction({
    source,
    destination,
    owner: OPERATOR,
    mint,
    amount,
    decimals: CIRCLE_USD_DECIMALS,
  });
  return buildUnsignedTransaction({ feePayer: OPERATOR, recentBlockhash: SYSTEM_PROGRAM_ID, instructions: [instruction] });
}

async function policyForTransaction(transaction) {
  const decoded = await decodeProviderTransaction({
    family: 'solana',
    chainId: CHAIN_ID,
    transaction,
    currentBlockHeight: '99',
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
  });
  return policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
}

function signTransaction(transactionBase64) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
  transaction.partialSign(OPERATOR_KEYPAIR);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function settlementAsset(assetId = SETTLEMENT_ASSET) {
  return { chainId: CHAIN_ID, assetId, decimals: CIRCLE_USD_DECIMALS };
}

function collectorMoneyConfiguration() {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  const solanaStablecoin = settlementAsset();
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
    },
    solana: {
      priorityFeeCap: { chainId: CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

function reconciledSellDecision({
  rawInsuredValue = '100',
  insuredValueUnit = 'atomic',
  instantBuybackPercent = 85,
  matchedBuybackPercent = 85,
  prizeTier = '1',
  rarity = { 1: 'epic', 2: 'rare', 3: 'uncommon', 4: 'common' }[prizeTier],
  offerAtomic = (BigInt(rawInsuredValue) * BigInt(matchedBuybackPercent) / 100n).toString(),
} = {}) {
  const insuredAtomic = insuredValueUnit === 'whole-usd'
    ? (BigInt(rawInsuredValue) * 1_000_000n).toString()
    : rawInsuredValue;
  return {
    memo: MEMO,
    mint: CARD_ASSET,
    decision: 'sell',
    offer: { ...settlementAsset(), amountAtomic: offerAtomic },
    rawInsuredValue,
    insuredValue: { ...settlementAsset(), amountAtomic: insuredAtomic },
    insuredValueUnit,
    instantBuybackPercent,
    matchedBuybackPercent,
    prizeTier,
    rarity,
  };
}

function buybackResponseEvidence(amountAtomic = '85') {
  const amount = { ...settlementAsset(), amountAtomic };
  return {
    memo: MEMO,
    mint: CARD_ASSET,
    signature: BUYBACK_SIGNATURE,
    quote: amount,
    refundAmount: { ...amount },
  };
}

function repository({ stages = {}, attempts = {} } = {}) {
  const held = [];
  const ledgers = [];
  return {
    held,
    ledgers,
    async readStage(_cycleId, stage) { return stages[stage] ?? { status: 'PENDING' }; },
    async readOperationalStageAttempt(_cycleId, stage) { return attempts[stage] ?? null; },
    async holdCycle(cycleId, terminalState, evidence) { held.push({ cycleId, terminalState, evidence }); },
    async recordCustodyLedger(cycleId, ledger) { ledgers.push({ cycleId, ledger }); },
  };
}

function baseConfig(overrides = {}) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_50' },
    solana: {
      chainId: CHAIN_ID,
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
    },
    collectorCrypt: { settlementAsset: settlementAsset() },
    moneyConfiguration: collectorMoneyConfiguration(),
    ...overrides,
  };
}

function responseAttempt(evidence) {
  return {
    attempt: { state: 'RESPONSE_RECORDED' },
    responseEvidence: evidence,
    reconciliationEvidence: null,
  };
}

async function durableCycle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-open-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  return { directory, repository, cycleId };
}

async function completeThroughOpen(repository, cycleId, openEvidence) {
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { memo: MEMO, expectedCardCount: 1 }],
    ['open', openEvidence],
  ]) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, evidence);
  }
}

async function completeThroughEpicGate(repository, cycleId) {
  await completeThroughOpen(repository, cycleId, { memo: MEMO, mint: CARD_ASSET });
  await repository.prepareStage(cycleId, 'epic-gate');
  await repository.completeStage(cycleId, 'epic-gate', reconciledSellDecision());
}

function sentUnknownAttempt(requestDigest) {
  return {
    attempt: { state: 'SENT_UNKNOWN', requestDigest },
    responseEvidence: null,
    reconciliationEvidence: null,
  };
}

test('purchase plans an expected card count from an integer or numeric-string machine contains value', async () => {
  for (const [contains, expectedCardCount] of [[1, 1], ['02', 2]]) {
    const collectorCrypt = {
      async getMachines() { return { machines: [{ code: 'pokemon_50', contains }] }; },
    };
    assert.deepEqual(
      await preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50' } }) }),
      { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, packType: 'pokemon_50', expectedCardCount },
    );
  }

  await assert.rejects(
    preparePurchaseRequest({
      adapters: { collectorCrypt: { async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 'description of contents' }] }; } } },
      config: baseConfig({ pack: { code: 'pokemon_50' } }),
    }),
    /contains/,
  );
});

test('purchase refuses the provisional authority before requesting a provider transaction', async () => {
  const transaction = transactionFor({ mint: SETTLEMENT_ASSET, amount: 40n });
  const policy = await policyForTransaction(transaction);
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const purchase = { memo: MEMO, signature: PURCHASE_SIGNATURE, expectedCardCount: 1 };
  let generated = 0;
  let signed = 0;
  let submitted = 0;
  const cycleRepository = repository({
    attempts: { purchase: responseAttempt(purchase) },
  });
  const collectorCrypt = {
    async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 1 }] }; },
    async generatePack() { generated += 1; return { memo: MEMO, transaction }; },
    async submitTransaction() { submitted += 1; return { signature: PURCHASE_SIGNATURE, confirmationStatus: 'submitted' }; },
    async getPackStatus() {
      return { memo: MEMO, pack: { transaction_signature: PURCHASE_SIGNATURE, token_mint: SETTLEMENT_ASSET }, send: null, buyback: [] };
    },
  };
  const rpc = rpcClient({
    tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }),
    entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }],
  });
  const config = baseConfig({
    collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy } },
  });
  await assert.rejects(
    () => mutatePurchase({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: { solana: { async sign(value) { signed += 1; return { signedTxBase64: value }; } } },
      config,
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(generated, 0);
  assert.equal(signed, 0);
  assert.equal(submitted, 0);

  assert.deepEqual(await reconcileLivePurchase({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'purchase' },
  }), {
    memo: MEMO,
    signature: PURCHASE_SIGNATURE,
    expectedCardCount: 1,
    packCost: { ...settlementAsset(), amountAtomic: '40' },
  });
});

test('purchase requires MoneyConfigurationV1 before requesting a provider transaction', async () => {
  const transaction = transactionFor({ mint: SETTLEMENT_ASSET, amount: 40n });
  const policy = await policyForTransaction(transaction);
  let generated = 0;

  await assert.rejects(
    () => mutatePurchase({
      liveMode: true,
      adapters: {
        collectorCrypt: {
          async generatePack() {
            generated += 1;
            return { memo: MEMO, transaction };
          },
        },
        solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
      },
      signerClient: { solana: { async sign() { throw new Error('signer must not be called'); } } },
      config: baseConfig({
        moneyConfiguration: null,
        collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy } },
      }),
      request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, expectedCardCount: 1 },
    }),
    /purchase requires MoneyConfigurationV1/,
  );
  assert.equal(generated, 0);
});

test('Collector Solana signers apply the typed priority-fee cap and post-fee reserve', async () => {
  const {
    assertSolanaSignerFeeEnvelope,
    assertSolanaSignerMoneyConfiguration,
  } = await import('../../src/app/stages/solana-money-controls.mjs');
  const money = assertSolanaSignerMoneyConfiguration({
    config: baseConfig(),
    asset: settlementAsset(),
    stage: 'purchase',
  });
  const decoded = {
    gas: { computeUnitLimit: '1000000' },
    priorityFee: {
      chainId: CHAIN_ID,
      assetId: 'microlamports-per-compute-unit',
      decimals: 0,
      amountAtomic: '2',
    },
  };

  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: rpcClient({ balance: 3 }),
      owner: OPERATOR,
      money,
      decoded,
      stage: 'purchase',
    }),
    /purchase Operations SOL balance does not retain the configured lamport reserve after the maximum priority fee/,
  );
  await assert.doesNotReject(
    () => assertSolanaSignerFeeEnvelope({
      client: rpcClient({ balance: 4 }),
      owner: OPERATOR,
      money,
      decoded,
      stage: 'purchase',
    }),
  );
  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: rpcClient({ balance: 1_000_000 }),
      owner: OPERATOR,
      money,
      decoded: {
        ...decoded,
        priorityFee: { ...decoded.priorityFee, amountAtomic: '3' },
      },
      stage: 'purchase',
    }),
    /purchase priority fee exceeds the configured MoneyConfigurationV1 cap/,
  );
});

test('purchase refuses the provisional authority before a signer can change the approved recipient', async () => {
  const transaction = transactionFor({ mint: SETTLEMENT_ASSET, amount: 40n });
  const changed = transactionFor({
    mint: SETTLEMENT_ASSET,
    amount: 40n,
    destination: Keypair.generate().publicKey.toBase58(),
  });
  const policy = await policyForTransaction(transaction);
  let signerCalls = 0;
  let submissions = 0;
  const collectorCrypt = {
    async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 1 }] }; },
    async generatePack() { return { memo: MEMO, transaction }; },
    async submitTransaction() {
      submissions += 1;
      return { signature: PURCHASE_SIGNATURE, confirmationStatus: 'submitted' };
    },
  };
  const config = baseConfig({
    collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy } },
  });

  await assert.rejects(
    mutatePurchase({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) } },
      signerClient: { solana: { async sign() { signerCalls += 1; return { signedTxBase64: signTransaction(changed) }; } } },
      config,
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(signerCalls, 0);
  assert.equal(submissions, 0);
});

test('open refuses the provisional authority before a provider mutation and reconciles persisted evidence', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { memo: MEMO, expectedCardCount: 1 } } },
    attempts: { open: responseAttempt({ memo: MEMO, expectedCardCount: 1, opened: { success: true, code: 'ALREADY_OPENED' } }) },
  });
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  let openPackCalls = 0;
  const collectorCrypt = {
    async openPack() { openPackCalls += 1; return { success: true, code: 'ALREADY_OPENED' }; },
    async getPackStatus() {
      return {
        memo: MEMO,
        pack: { transaction_signature: PURCHASE_SIGNATURE },
        send: { nft_address: CARD_ASSET, transaction_signature: OPEN_SIGNATURE, to_wallet: OPERATOR },
        buyback: [],
      };
    },
  };
  const rpc = rpcClient({
    entries: [{ tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '0', postAmount: '1' }],
  });
  const config = baseConfig();
  assert.deepEqual(await prepareOpenRequest({ cycleRepository, context: { cycleId: CYCLE_ID } }), {
    provider: 'collector-crypt', operation: 'open', memo: MEMO, expectedCardCount: 1,
  });
  await assert.rejects(
    () => mutateOpen({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(openPackCalls, 0);
  assert.deepEqual(await reconcileLiveOpen({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'open' },
  }), { memo: MEMO, signature: OPEN_SIGNATURE, mint: CARD_ASSET, assetKind: 'spl' });

  collectorCrypt.getPackStatus = async () => ({ memo: MEMO, pack: null, send: null, buyback: [] });
  assert.equal(await reconcileLiveOpen({
    adapters: { collectorCrypt, solana: { client: rpc } }, config, cycleRepository, context: { cycleId: CYCLE_ID, stage: 'open' },
  }), null);
  assert.equal(cycleRepository.held.length, 1);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('open requires memo-bound status evidence for the signature, card asset, and destination wallet', async () => {
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  const rpc = rpcClient({
    entries: [{ tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '0', postAmount: '1' }],
  });
  const opened = { transactionSignature: OPEN_SIGNATURE, nft_address: CARD_ASSET };
  const statuses = [
    { label: 'missing send record', send: null, expectedHold: true },
    {
      label: 'conflicting send signature',
      send: { nft_address: CARD_ASSET, transaction_signature: PURCHASE_SIGNATURE, to_wallet: OPERATOR },
      expectedHold: true,
    },
    {
      label: 'conflicting destination wallet',
      send: { nft_address: CARD_ASSET, transaction_signature: OPEN_SIGNATURE, to_wallet: COLLECTOR_RECIPIENT },
      expectedHold: true,
    },
  ];

  for (const entry of statuses) {
    const cycleRepository = repository({
      attempts: { open: responseAttempt({ memo: MEMO, expectedCardCount: 1, opened }) },
    });
    const collectorCrypt = {
      async getPackStatus() {
        return { memo: MEMO, pack: {}, send: entry.send, buyback: [] };
      },
    };

    assert.equal(await reconcileLiveOpen({
      adapters: { collectorCrypt, solana: { client: rpc } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'open' },
    }), null, entry.label);
    assert.equal(cycleRepository.held.length > 0, entry.expectedHold, entry.label);
    if (entry.expectedHold) assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  }
});

test('open response missing its memo-bound mint holds durably without a retry', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const request = { provider: 'collector-crypt', operation: 'open', memo: MEMO, expectedCardCount: 1 };
  await repository.prepareStageAttempt(cycleId, 'open', createPreparedProviderMutationAttempt({
    cycleId,
    stage: 'open',
    requestDigest: digest({
      schema: 'hookemon.operational-stage-request.v1',
      cycleId,
      stage: 'open',
      request,
    }),
  }));
  await repository.recordStageAttemptResponse(cycleId, 'open', {
    memo: MEMO,
    expectedCardCount: 1,
    opened: { transactionSignature: 'open-signature-recorded', nft_address: CARD_ASSET },
  });
  let statusReads = 0;

  assert.equal(await reconcileLiveOpen({
    adapters: {
      collectorCrypt: {
        async getPackStatus() {
          statusReads += 1;
          return { memo: MEMO, pack: {}, send: null, buyback: [] };
        },
      },
      solana: { client: rpcClient() },
    },
    config: baseConfig(),
    cycleRepository: repository,
    context: { cycleId, stage: 'open' },
  }), null);
  assert.equal(statusReads, 1);

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'open')).attempt.state, 'RESPONSE_RECORDED');
  await assert.rejects(() => reopened.prepareStage(cycleId, 'open'), /terminal as HELD_DATA_UNVERIFIED/);
});

test('open retries a SENT_UNKNOWN attempt only through a memo-bound award that agrees with pack status', async () => {
  const request = { provider: 'collector-crypt', operation: 'open', memo: MEMO, expectedCardCount: 1 };
  const requestDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: CYCLE_ID,
    stage: 'open',
    request,
  });
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { memo: MEMO, expectedCardCount: 1 } } },
    attempts: { open: sentUnknownAttempt(requestDigest) },
  });
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  let statusReads = 0;
  let openCalls = 0;
  const guards = [];
  const collectorCrypt = {
    async getPackStatus() {
      statusReads += 1;
      if (statusReads === 1) return { memo: MEMO, pack: null, send: null, buyback: [] };
      return {
        memo: MEMO,
        pack: { transaction_signature: PURCHASE_SIGNATURE },
        send: { nft_address: CARD_ASSET, transaction_signature: OPEN_SIGNATURE, to_wallet: OPERATOR },
        buyback: [],
      };
    },
    async openPack() {
      openCalls += 1;
      return { success: true, nft_address: CARD_ASSET, transactionSignature: OPEN_SIGNATURE };
    },
  };
  const result = await reconcileLiveOpen({
    adapters: { collectorCrypt, solana: { client: rpcClient({ entries: [{ tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '0', postAmount: '1' }] }) } },
    config: baseConfig(),
    cycleRepository,
    context: {
      cycleId: CYCLE_ID,
      stage: 'open',
      fencingToken: 'fence-1',
      assertLease() {},
      async assertMutationAllowed(value) { guards.push(value); },
    },
  });

  assert.deepEqual(result, { memo: MEMO, signature: OPEN_SIGNATURE, mint: CARD_ASSET, assetKind: 'spl' });
  assert.equal(openCalls, 1);
  assert.deepEqual(guards, [{ boundary: 'mutation', cycleId: CYCLE_ID, stage: 'open', requestDigest, fencingToken: 'fence-1' }]);
});

test('open SENT_UNKNOWN retry missing mint holds durably after reopen', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const request = { provider: 'collector-crypt', operation: 'open', memo: MEMO, expectedCardCount: 1 };
  const requestDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId,
    stage: 'open',
    request,
  });
  await repository.prepareStageAttempt(cycleId, 'open', createPreparedProviderMutationAttempt({
    cycleId,
    stage: 'open',
    requestDigest,
  }));
  await repository.markStageAttemptSentUnknown(cycleId, 'open');
  let openCalls = 0;
  const cycleRepository = {
    async readStage(requestCycleId, stage) {
      if (stage === 'purchase') return { status: 'COMPLETE', evidence: { memo: MEMO, expectedCardCount: 1 } };
      return repository.readStage(requestCycleId, stage);
    },
    readOperationalStageAttempt: repository.readOperationalStageAttempt.bind(repository),
    holdCycle: repository.holdCycle.bind(repository),
  };

  assert.equal(await reconcileLiveOpen({
    adapters: {
      collectorCrypt: {
        async getPackStatus() { return { memo: MEMO, pack: {}, send: null, buyback: [] }; },
        async openPack() { openCalls += 1; return { success: true }; },
      },
      solana: { client: rpcClient() },
    },
    config: baseConfig(),
    cycleRepository,
    context: {
      cycleId,
      stage: 'open',
      fencingToken: 'fence-1',
      assertLease() {},
      async assertMutationAllowed() {},
    },
  }), null);
  assert.equal(openCalls, 1);

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'open')).attempt.state, 'SENT_UNKNOWN');
  await assert.rejects(() => reopened.prepareStage(cycleId, 'open'), /terminal as HELD_DATA_UNVERIFIED/);
});

test('open refuses a SENT_UNKNOWN retry when the award response and memo-bound status name different cards', async () => {
  const request = { provider: 'collector-crypt', operation: 'open', memo: MEMO, expectedCardCount: 1 };
  const requestDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: CYCLE_ID,
    stage: 'open',
    request,
  });
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { memo: MEMO, expectedCardCount: 1 } } },
    attempts: { open: sentUnknownAttempt(requestDigest) },
  });
  let statusReads = 0;
  let openCalls = 0;
  const collectorCrypt = {
    async getPackStatus() {
      statusReads += 1;
      if (statusReads === 1) return { memo: MEMO, pack: null, send: null, buyback: [] };
      return {
        memo: MEMO,
        pack: {},
        send: { nft_address: CARD_ASSET, transaction_signature: OPEN_SIGNATURE, to_wallet: OPERATOR },
        buyback: [],
      };
    },
    async openPack() {
      openCalls += 1;
      return { success: true, nft_address: PACK_ASSET, transactionSignature: OPEN_SIGNATURE };
    },
  };

  assert.equal(await reconcileLiveOpen({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: {
      cycleId: CYCLE_ID,
      stage: 'open',
      fencingToken: 'fence-1',
      assertLease() {},
      async assertMutationAllowed() {},
    },
  }), null);
  assert.equal(openCalls, 1);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('open keeps a SENT_UNKNOWN attempt pending when its mutation guards are unavailable', async () => {
  const request = { provider: 'collector-crypt', operation: 'open', memo: MEMO, expectedCardCount: 1 };
  const requestDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: CYCLE_ID,
    stage: 'open',
    request,
  });
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { memo: MEMO, expectedCardCount: 1 } } },
    attempts: { open: sentUnknownAttempt(requestDigest) },
  });
  let openCalls = 0;
  const collectorCrypt = {
    async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; },
    async openPack() { openCalls += 1; throw new Error('open must not be retried without mutation guards'); },
  };

  assert.equal(await reconcileLiveOpen({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'open' },
  }), null);
  assert.equal(openCalls, 0);
  assert.equal(cycleRepository.held.length, 0);
});

test('open refuses a purchase whose documented card count needs an unsupported fan-out', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { memo: MEMO, expectedCardCount: 2 } } },
  });
  await assert.rejects(
    prepareOpenRequest({ cycleRepository, context: { cycleId: CYCLE_ID } }),
    /exactly one expected card/,
  );
});

test('keeps a forty-percent epic equality sellable after a real repository reopen', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const offer = { ...settlementAsset(), amountAtomic: '40' };
  const insuredValue = { ...settlementAsset(), amountAtomic: '100' };
  await completeThroughOpen(repository, cycleId, { memo: MEMO, mint: CARD_ASSET, offer, insuredValue });

  const outcome = await probeEpicGate({
    cycleRepository: repository,
    context: { cycleId },
  });
  assert.equal(outcome.belowFortyPercent, false);
  assert.equal(outcome.nextAction, 'sell');

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, null);
  assert.deepEqual(await reopened.readStage(cycleId, 'open'), {
    status: 'COMPLETE',
    evidence: { memo: MEMO, mint: CARD_ASSET, offer, insuredValue },
  });
  assert.equal((await reopened.prepareStage(cycleId, 'epic-gate')).status, 'PREPARED');
});

test('epic gate uses configured field names, reconciles an atomic insured value, and holds a changed quote', async () => {
  const epicGate = {
    nftAddressField: 'nft_address',
    insuredValueField: 'insured_value',
    prizeTierField: 'prize_tier',
    rarityField: 'rarity',
    asset: settlementAsset(),
  };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
  });
  let quoteAmount = { ...settlementAsset(), amountAtomic: '85' };
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { pack_type: 'pokemon_50' }, send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 1, rarity: 'epic' }, buyback: [] };
    },
    async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }], hasMore: false, page: 1, limit: 50 }; },
    async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
    async getBuybackAvailable() { return { available: true, amount: quoteAmount }; },
  };
  const config = baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), epicGate } });
  assert.deepEqual(await prepareEpicGateRequest({ cycleRepository, context: { cycleId: CYCLE_ID } }), {
    provider: 'collector-crypt', operation: 'epic-gate', memo: MEMO, mint: CARD_ASSET,
  });
  const evidence = await mutateEpicGate({
    liveMode: true, adapters: { collectorCrypt }, config, cycleRepository, context: { cycleId: CYCLE_ID },
  });
  assert.equal(evidence.decision, 'sell');
  assert.equal(evidence.offer.amountAtomic, '85');
  assert.equal(evidence.insuredValueUnit, 'atomic');
  cycleRepository.readOperationalStageAttempt = async () => responseAttempt(evidence);
  quoteAmount = { ...settlementAsset(), amountAtomic: '40' };
  assert.equal(await reconcileLiveEpicGate({
    adapters: { collectorCrypt }, config, cycleRepository, context: { cycleId: CYCLE_ID, stage: 'epic-gate' },
  }), null);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('epic gate reconciles a whole-dollar insured value against the machine buyback percentage before selling', async () => {
  const epicGate = {
    nftAddressField: 'nft_address',
    insuredValueField: 'insured_value',
    prizeTierField: 'prize_tier',
    rarityField: 'rarity',
    asset: settlementAsset(),
  };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
  });
  const collectorCrypt = {
    async getPackStatus() {
      return {
        memo: MEMO,
        pack: { pack_type: 'pokemon_50' },
        send: { nft_address: CARD_ASSET, insured_value: 50, prize_tier: '1', rarity: 'epic' },
        buyback: [],
      };
    },
    async getNfts() {
      return {
        nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 50 }],
        hasMore: false,
        page: 1,
        limit: 50,
      };
    },
    async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
    async getBuybackAvailable() {
      return { available: true, amount: { ...settlementAsset(), amountAtomic: '42500000' } };
    },
  };

  const evidence = await mutateEpicGate({
    liveMode: true,
    adapters: { collectorCrypt },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), epicGate } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(evidence.decision, 'sell');
  assert.deepEqual(evidence.insuredValue, { ...settlementAsset(), amountAtomic: '50000000' });
  assert.equal(evidence.insuredValueUnit, 'whole-usd');
});

test('epic gate accepts a one-point lower rounded buyback percentage', async () => {
  const epicGate = {
    nftAddressField: 'nft_address',
    insuredValueField: 'insured_value',
    prizeTierField: 'prize_tier',
    rarityField: 'rarity',
    asset: settlementAsset(),
  };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
  });
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { pack_type: 'pokemon_50' }, send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 1, rarity: 'epic' }, buyback: [] };
    },
    async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, insured_value: 100, rarity: 'epic' }], hasMore: false, page: 1, limit: 50 }; },
    async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '84' } }; },
  };

  const evidence = await mutateEpicGate({
    liveMode: true,
    adapters: { collectorCrypt },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), epicGate } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(evidence.decision, 'sell');
  assert.equal(evidence.insuredValueUnit, 'atomic');
  assert.equal(evidence.matchedBuybackPercent, 84);
});

test('epic gate holds when zero or two insured-value unit candidates reconcile', async () => {
  const epicGate = {
    nftAddressField: 'nft_address',
    insuredValueField: 'insured_value',
    prizeTierField: 'prize_tier',
    rarityField: 'rarity',
    asset: settlementAsset(),
  };
  for (const entry of [
    { label: 'no candidate', insuredValue: 100, offerAtomic: '40' },
    { label: 'two candidates', insuredValue: 0, offerAtomic: '0' },
  ]) {
    const cycleRepository = repository({
      stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
    });
    const collectorCrypt = {
      async getPackStatus() {
        return {
          memo: MEMO,
          pack: { pack_type: 'pokemon_50' },
          send: { nft_address: CARD_ASSET, insured_value: entry.insuredValue, prize_tier: 1, rarity: 'epic' },
          buyback: [],
        };
      },
      async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, insured_value: entry.insuredValue, rarity: 'epic' }], hasMore: false, page: 1, limit: 50 }; },
      async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
      async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: entry.offerAtomic } }; },
    };

    const result = await mutateEpicGate({
      liveMode: true,
      adapters: { collectorCrypt },
      config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), epicGate } }),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    });

    assert.equal(result.terminalState, 'HELD_DATA_UNVERIFIED', entry.label);
    assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED', entry.label);
  }
});

test('epic gate holds a conflict between the numeric tier and string rarity', async () => {
  const epicGate = {
    nftAddressField: 'nft_address',
    insuredValueField: 'insured_value',
    prizeTierField: 'prize_tier',
    rarityField: 'rarity',
    asset: settlementAsset(),
  };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
  });
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { pack_type: 'pokemon_50' }, send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: '1', rarity: 'rare' }, buyback: [] };
    },
    async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, insured_value: 100, rarity: 'epic' }], hasMore: false, page: 1, limit: 50 }; },
    async getMachines() { throw new Error('machine lookup must not happen after a rarity conflict'); },
    async getBuybackAvailable() { throw new Error('quote lookup must not happen after a rarity conflict'); },
  };

  const result = await mutateEpicGate({
    liveMode: true,
    adapters: { collectorCrypt },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), epicGate } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(result.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('epic gate holds when the configured insured-value asset differs from the buyback settlement asset', async () => {
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
  });
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { pack_type: 'pokemon_50' }, send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 4 }, buyback: [] };
    },
    async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, rarity: 'epic' }], hasMore: false, page: 1, limit: 50 }; },
    async getBuybackAvailable() { return { available: true, amount: 40 }; },
  };
  const result = await mutateEpicGate({
    liveMode: true,
    adapters: { collectorCrypt },
    config: baseConfig({
      collectorCrypt: {
        settlementAsset: settlementAsset(),
        epicGate: {
          nftAddressField: 'nft_address',
          insuredValueField: 'insured_value',
          prizeTierField: 'prize_tier',
          rarityField: 'rarity',
          epicPrizeTier: '4',
          epicRarity: 'epic',
          asset: settlementAsset(PACK_ASSET),
        },
      },
    }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(result.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('epic gate treats malformed provider responses as unverified data', async () => {
  const cases = [
    {
      label: 'card listing',
      pack: { pack_type: 'pokemon_50' },
      send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 1 },
      getNfts: async () => ({ nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }], page: 1, limit: 50 }),
      getBuybackAvailable: async () => ({ available: true, amount: { ...settlementAsset(), amountAtomic: '40' } }),
    },
    {
      label: 'buyback offer',
      pack: { pack_type: 'pokemon_50' },
      send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 1 },
      getNfts: async () => ({ nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }], hasMore: false, page: 1, limit: 50 }),
      getBuybackAvailable: async () => ({}),
    },
    {
      label: 'documented numeric fields',
      pack: { pack_type: 'pokemon_50' },
      send: { nft_address: CARD_ASSET, insured_value: '100', prize_tier: '1' },
      getNfts: async () => ({ nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: '100' }], hasMore: false, page: 1, limit: 50 }),
      getBuybackAvailable: async () => ({ available: true, amount: { ...settlementAsset(), amountAtomic: '40' } }),
    },
    {
      label: 'pack type',
      pack: {},
      send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 1 },
      getNfts: async () => ({ nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }], hasMore: false, page: 1, limit: 50 }),
      getBuybackAvailable: async () => ({ available: true, amount: { ...settlementAsset(), amountAtomic: '40' } }),
    },
  ];

  for (const entry of cases) {
    const cycleRepository = repository({
      stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
    });
    const collectorCrypt = {
      async getPackStatus() {
        return {
          memo: MEMO,
          pack: entry.pack,
          send: entry.send,
          buyback: [],
        };
      },
      getNfts: entry.getNfts,
      async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
      getBuybackAvailable: entry.getBuybackAvailable,
    };
    const result = await mutateEpicGate({
      liveMode: true,
      adapters: { collectorCrypt },
      config: baseConfig({
        collectorCrypt: {
          settlementAsset: settlementAsset(),
          epicGate: {
            nftAddressField: 'nft_address',
            insuredValueField: 'insured_value',
            prizeTierField: 'prize_tier',
            rarityField: 'rarity',
            asset: settlementAsset(),
          },
        },
      }),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    });

    assert.equal(result.terminalState, 'HELD_DATA_UNVERIFIED', entry.label);
    assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED', entry.label);
  }
});

test('epic gate finds a later-page card and verifies each documented tier mapping', async () => {
  const insuredValue = 100000000;
  const offerAmount = { ...settlementAsset(), amountAtomic: '85000000' };
  const tierRarities = new Map([
    [1, 'epic'],
    [2, 'rare'],
    [3, 'uncommon'],
    [4, 'common'],
  ]);

  for (const [prizeTier, rarity] of tierRarities) {
    const requests = [];
    const cycleRepository = repository({
      stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
    });
    const collectorCrypt = {
      async getPackStatus() {
        return {
          memo: MEMO,
          pack: { pack_type: 'pokemon_50' },
          send: { nft_address: CARD_ASSET, insured_value: insuredValue, prize_tier: prizeTier },
          buyback: [],
        };
      },
      async getNfts(request) {
        requests.push(request);
        if (request.page === 1) return { nfts: [], hasMore: true, page: 1, limit: 50 };
        return {
          nfts: [{ nft_address: CARD_ASSET, rarity, insured_value: insuredValue }],
          hasMore: false,
          page: 2,
          limit: 50,
        };
      },
      async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
      async getBuybackAvailable() { return { available: true, amount: offerAmount }; },
    };
    const config = baseConfig({
      collectorCrypt: {
        settlementAsset: settlementAsset(),
        epicGate: {
          nftAddressField: 'nft_address',
          insuredValueField: 'insured_value',
          prizeTierField: 'prize_tier',
          rarityField: 'rarity',
          asset: settlementAsset(),
        },
      },
    });

    const evidence = await mutateEpicGate({
      liveMode: true,
      adapters: { collectorCrypt },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    });

    assert.equal(evidence.decision, 'sell', `tier ${prizeTier}`);
    assert.deepEqual(requests, [
      { code: 'pokemon_50', page: 1, limit: 50 },
      { code: 'pokemon_50', page: 2, limit: 50 },
    ], `tier ${prizeTier}`);
  }
});

test('epic gate holds when card insured value disagrees with memo status', async () => {
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { memo: MEMO, mint: CARD_ASSET } } },
  });
  const collectorCrypt = {
    async getPackStatus() {
      return {
        memo: MEMO,
        pack: { pack_type: 'pokemon_50' },
        send: { nft_address: CARD_ASSET, insured_value: 100, prize_tier: 1 },
        buyback: [],
      };
    },
    async getNfts() {
      return { nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 101 }], hasMore: false, page: 1, limit: 50 };
    },
    async getBuybackAvailable() { return { available: true, amount: 40 }; },
  };
  const config = baseConfig({
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      epicGate: {
        nftAddressField: 'nft_address',
        insuredValueField: 'insured_value',
        prizeTierField: 'prize_tier',
        rarityField: 'rarity',
        epicPrizeTier: '1',
        epicRarity: 'epic',
        asset: settlementAsset(),
      },
    },
  });

  const evidence = await mutateEpicGate({
    liveMode: true,
    adapters: { collectorCrypt },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(evidence.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('buyback refuses the provisional authority before requesting an unbound provider transaction', async () => {
  const transaction = transactionFor({ mint: PACK_ASSET });
  const policy = await policyForTransaction(transaction);
  let signed = false;
  let buybackCalls = 0;
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': {
        status: 'COMPLETE',
        evidence: reconciledSellDecision(),
      },
    },
  });
  const config = baseConfig({
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      buyback: { policy, collectorProgramId: TOKEN_PROGRAM_ID, collectorRecipient: COLLECTOR_RECIPIENT },
    },
  });
  await assert.rejects(() => mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
        async buyback() {
          buybackCalls += 1;
          return { success: true, serializedTransaction: transaction, refundAmount: { ...settlementAsset(), amountAtomic: '85' }, memo: MEMO };
        },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { signed = true; return { signedTxBase64: transaction }; } } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  }), /active frozen interface authority is invalid/);
  assert.equal(signed, false);
  assert.equal(buybackCalls, 0);
});

test('buyback requires MoneyConfigurationV1 before querying or constructing a provider transaction', async () => {
  const transaction = transactionFor({ mint: PACK_ASSET });
  const policy = await policyForTransaction(transaction);
  let availabilityCalls = 0;
  let buybackCalls = 0;
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': { status: 'COMPLETE', evidence: reconciledSellDecision() },
    },
  });

  await assert.rejects(
    () => mutateBuyback({
      liveMode: true,
      adapters: {
        collectorCrypt: {
          async getBuybackAvailable() {
            availabilityCalls += 1;
            return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } };
          },
          async buyback() {
            buybackCalls += 1;
            return { success: true, serializedTransaction: transaction, refundAmount: { ...settlementAsset(), amountAtomic: '85' }, memo: MEMO };
          },
        },
        solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
      },
      signerClient: { solana: { async sign() { throw new Error('signer must not be called'); } } },
      config: baseConfig({
        moneyConfiguration: null,
        collectorCrypt: {
          settlementAsset: settlementAsset(),
          buyback: { policy, collectorProgramId: TOKEN_PROGRAM_ID, collectorRecipient: COLLECTOR_RECIPIENT },
        },
      }),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /buyback requires MoneyConfigurationV1/,
  );
  assert.equal(availabilityCalls, 0);
  assert.equal(buybackCalls, 0);
});

test('buyback holds as unavailable before it can request or sign a provider transaction', async () => {
  let buybackCalls = 0;
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': {
        status: 'COMPLETE',
        evidence: reconciledSellDecision(),
      },
    },
  });
  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { return { available: false }; },
        async buyback() { buybackCalls += 1; throw new Error('provider buyback must not be called'); },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { throw new Error('signer must not be called'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.deepEqual(result, {
    memo: MEMO,
    mint: CARD_ASSET,
    decision: 'held',
    terminalState: 'HELD_UNAVAILABLE',
  });
  assert.equal(buybackCalls, 0);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_UNAVAILABLE');
});

test('holds unavailable buyback durably after reopen before its sole owner decision', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  await completeThroughEpicGate(cycleRepository, cycleId);
  let buybackCalls = 0;
  let signCalls = 0;
  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { return { available: false }; },
        async buyback() { buybackCalls += 1; throw new Error('buyback provider must not run'); },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { signCalls += 1; throw new Error('signer must not run'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId, stage: 'buyback' },
  });

  assert.equal(result.terminalState, 'HELD_UNAVAILABLE');
  assert.equal(buybackCalls, 0);
  assert.equal(signCalls, 0);
  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_UNAVAILABLE');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'buyback'), null);
  await assert.rejects(() => reopened.prepareStage(cycleId, 'buyback'), /terminal as HELD_UNAVAILABLE/);
});

test('buyback binds the completed sell decision into its prepared request', async () => {
  const decision = reconciledSellDecision({ rawInsuredValue: '100000000000000000000' });
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': { status: 'COMPLETE', evidence: decision },
    },
  });

  assert.deepEqual(await prepareBuybackRequest({ cycleRepository, context: { cycleId: CYCLE_ID } }), {
    provider: 'collector-crypt',
    operation: 'buyback',
    memo: MEMO,
    mint: CARD_ASSET,
    epicDecision: {
      ...decision,
      decisionDigest: digest({
        schema: 'hookemon.collector-crypt-epic-decision.v1',
        cycleId: CYCLE_ID,
        ...decision,
      }),
    },
  });
});

test('buyback holds before a provider request when the completed decision is missing', async () => {
  let availabilityCalls = 0;
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } } },
  });
  const request = await prepareBuybackRequest({ cycleRepository, context: { cycleId: CYCLE_ID } });

  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { availabilityCalls += 1; return { available: true, amount: '40' }; },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { throw new Error('signer must not be called'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    request,
  });

  assert.equal(result.terminalState, 'HELD_OWNER_DECISION');
  assert.equal(availabilityCalls, 0);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_OWNER_DECISION');
});

test('buyback prepares a canonical non-authorizing request when the completed decision is missing', async () => {
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } } },
  });

  assert.deepEqual(await prepareBuybackRequest({ cycleRepository, context: { cycleId: CYCLE_ID } }), {
    provider: 'collector-crypt',
    operation: 'buyback',
    memo: MEMO,
    mint: CARD_ASSET,
    epicDecision: null,
  });
});

test('buyback holds a changed quote before requesting a provider transaction or signature', async () => {
  const decision = reconciledSellDecision({ rawInsuredValue: '100000000000000000000' });
  const { offer, insuredValue } = decision;
  let buybackCalls = 0;
  let signerCalls = 0;
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': {
        status: 'COMPLETE',
        evidence: decision,
      },
    },
  });

  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { return { available: true, amount: { ...offer, amountAtomic: (BigInt(offer.amountAtomic) - 1n).toString() } }; },
        async buyback() { buybackCalls += 1; throw new Error('provider buyback must not be called'); },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { signerCalls += 1; throw new Error('signer must not be called'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(result.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(buybackCalls, 0);
  assert.equal(signerCalls, 0);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('buyback rechecks the completed sell decision immediately before signing', () => {
  const source = readFileSync(new URL('../../src/app/stages/buyback.mjs', import.meta.url), 'utf8');
  const beforeSign = source.indexOf('beforeSign: async () => {');
  const decisionRead = source.indexOf('readCompletedSellDecision', beforeSign);
  const preparedCheck = source.indexOf('assertPreparedBuybackRequest(prepared, currentDecision);', decisionRead);
  const beforeSignInvocation = source.indexOf('if (beforeSign !== null) await beforeSign();');
  const authorityCheck = source.indexOf('requireLiveMutationAuthority();', beforeSignInvocation);
  const signerCall = source.indexOf('return signerClient.solana.sign(request);', authorityCheck);

  assert.notEqual(beforeSign, -1);
  assert.notEqual(decisionRead, -1);
  assert.notEqual(preparedCheck, -1);
  assert.notEqual(beforeSignInvocation, -1);
  assert.notEqual(authorityCheck, -1);
  assert.notEqual(signerCall, -1);
  assert.ok(beforeSign < decisionRead && decisionRead < preparedCheck);
  assert.ok(beforeSignInvocation < authorityCheck && authorityCheck < signerCall);
});

test('buyback holds a quote that does not use the fixed Collector settlement asset', async () => {
  let buybackCalls = 0;
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': { status: 'COMPLETE', evidence: reconciledSellDecision() },
    },
  });

  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(PACK_ASSET), amountAtomic: '85' } }; },
        async buyback() { buybackCalls += 1; throw new Error('buyback must not be called with an invalid quote'); },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { throw new Error('signer must not be called'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(result.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(buybackCalls, 0);
  assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('buyback rechecks the unit-bound quote after provider construction and before authority-gated signing', () => {
  const source = readFileSync(new URL('../../src/app/stages/buyback.mjs', import.meta.url), 'utf8');
  const providerBuild = source.indexOf('const built = await adapters.collectorCrypt.buyback');
  const beforeSign = source.indexOf('beforeSign: async () => {', providerBuild);
  const decisionRead = source.indexOf('readCompletedSellDecision', beforeSign);
  const preparedCheck = source.indexOf('assertPreparedBuybackRequest(prepared, currentDecision);', decisionRead);
  const quoteCheck = source.indexOf('if (!sameAmount(quote, currentDecision.offer))', preparedCheck);
  const beforeSignInvocation = source.indexOf('if (beforeSign !== null) await beforeSign();');
  const authorityCheck = source.indexOf('requireLiveMutationAuthority();', beforeSignInvocation);
  const signerCall = source.indexOf('return signerClient.solana.sign(request);', authorityCheck);

  assert.notEqual(providerBuild, -1);
  assert.notEqual(beforeSign, -1);
  assert.notEqual(decisionRead, -1);
  assert.notEqual(preparedCheck, -1);
  assert.notEqual(quoteCheck, -1);
  assert.notEqual(beforeSignInvocation, -1);
  assert.notEqual(authorityCheck, -1);
  assert.notEqual(signerCall, -1);
  assert.ok(providerBuild < beforeSign && beforeSign < decisionRead && decisionRead < preparedCheck && preparedCheck < quoteCheck);
  assert.ok(beforeSignInvocation < authorityCheck && authorityCheck < signerCall);
});

test('buyback reconciles a completed memo check even after sale eligibility becomes unavailable', async () => {
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  const settlementTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const evidence = buybackResponseEvidence();
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': {
        status: 'COMPLETE',
        evidence: reconciledSellDecision(),
      },
    },
    attempts: { buyback: responseAttempt(evidence) },
  });
  const collectorCrypt = {
    async getPackStatus() { return { memo: MEMO, pack: {}, send: {}, buyback: [] }; },
    async getBuybackAvailable() { throw new Error('post-sale eligibility must not be checked'); },
    async getBuybackCheck() {
      return {
        exists: true,
        playerWallet: OPERATOR,
        nft: CARD_ASSET,
        transactionSignature: BUYBACK_SIGNATURE,
        buybackAmount: '85',
        createdAt: '2025-05-26T17:32:33.588Z',
        status: 'complete',
      };
    },
  };
  const rpc = rpcClient({
    entries: [
      { tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: settlementTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '0', postAmount: '85', decimals: CIRCLE_USD_DECIMALS },
    ],
  });

  assert.deepEqual(await reconcileLiveBuyback({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'buyback' },
  }), {
    ...evidence,
    proceeds: { ...settlementAsset(), amountAtomic: '85' },
  });
});

test('buyback leaves absent or pending checks unresolved and holds a conflicting completed check', async () => {
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  const settlementTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const evidence = buybackResponseEvidence();
  const checks = [
    { label: 'absent', value: { exists: false }, expectedHold: false },
    {
      label: 'pending',
      value: {
        exists: true, playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE,
        buybackAmount: '85', createdAt: '2025-05-26T17:32:33.588Z', status: '',
      },
      expectedHold: false,
    },
    {
      label: 'unknown status',
      value: {
        exists: true, playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE,
        buybackAmount: '85', createdAt: '2025-05-26T17:32:33.588Z', status: 'failed',
      },
      expectedHold: true,
    },
    {
      label: 'conflicting',
      value: {
        exists: true, playerWallet: OPERATOR, nft: PACK_ASSET, transactionSignature: BUYBACK_SIGNATURE,
        buybackAmount: '85', createdAt: '2025-05-26T17:32:33.588Z', status: 'complete',
      },
      expectedHold: true,
    },
  ];
  const rpc = rpcClient({
    entries: [
      { tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: settlementTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '0', postAmount: '85', decimals: CIRCLE_USD_DECIMALS },
    ],
  });

  for (const check of checks) {
    const cycleRepository = repository({
      stages: { open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } } },
      attempts: { buyback: responseAttempt(evidence) },
    });
    const collectorCrypt = {
      async getPackStatus() { return { memo: MEMO, pack: {}, send: {}, buyback: [{ transaction_signature: BUYBACK_SIGNATURE }] }; },
      async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
      async getBuybackCheck() { return check.value; },
    };

    assert.equal(await reconcileLiveBuyback({
      adapters: { collectorCrypt, solana: { client: rpc } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'buyback' },
    }), null, check.label);
    assert.equal(cycleRepository.held.length > 0, check.expectedHold, check.label);
    if (check.expectedHold) assert.equal(cycleRepository.held.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  }
});

test('buyback refuses the provisional authority before mutation and still reconciles typed finalized proceeds', async () => {
  const transaction = transactionFor({ mint: CARD_ASSET });
  const policy = await policyForTransaction(transaction);
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  const settlementTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const evidence = buybackResponseEvidence();
  const cycleRepository = repository({
    stages: {
      open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } },
      'epic-gate': {
        status: 'COMPLETE',
        evidence: reconciledSellDecision(),
      },
    },
    attempts: { buyback: responseAttempt(evidence) },
  });
  let signed = 0;
  let submitted = 0;
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; return { success: true, serializedTransaction: transaction, refundAmount: { ...settlementAsset(), amountAtomic: '85' }, memo: MEMO }; },
    async submitTransaction() { submitted += 1; return { success: true, signature: BUYBACK_SIGNATURE, confirmationStatus: 'submitted' }; },
    async getBuybackCheck() {
      return {
        exists: true,
        playerWallet: OPERATOR,
        nft: CARD_ASSET,
        transactionSignature: BUYBACK_SIGNATURE,
        buybackAmount: '85',
        createdAt: '2025-05-26T17:32:33.588Z',
        status: 'complete',
      };
    },
  };
  const rpc = rpcClient({
    tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }),
    entries: [
      { tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: settlementTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '0', postAmount: '85', decimals: CIRCLE_USD_DECIMALS },
    ],
  });
  const config = baseConfig({
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      buyback: { policy, collectorProgramId: TOKEN_PROGRAM_ID, collectorRecipient: COLLECTOR_RECIPIENT },
    },
  });
  await assert.rejects(
    () => mutateBuyback({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: { solana: { async sign(value) { signed += 1; return { signedTxBase64: value }; } } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(signed, 0);
  assert.equal(submitted, 0);
  assert.equal(buybackCalls, 0);
  assert.deepEqual(await reconcileLiveBuyback({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'buyback' },
  }), {
    ...evidence,
    proceeds: { ...settlementAsset(), amountAtomic: '85' },
  });
  assert.equal(cycleRepository.ledgers.length, 1);
  assert.equal(cycleRepository.ledgers[0].ledger.buybackProceeds, '85');
});
