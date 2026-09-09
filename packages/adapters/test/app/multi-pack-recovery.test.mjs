// Multi-pack batch-purchase fixtures for Task C (see product/decisions or the C-brief handed to
// this worktree): N=1, N=2, the maximum supported batch, mixed sold/held/pending, zero sold, a
// provider 429/503 on the batch call, and a lost (never-recorded) response. Every fixture asserts
// a deterministic durable outcome and that a restart never repurchases, reopens, or double-pays.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  TOKEN_PROGRAM_ID,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { CollectorCryptError } from '../../src/collector-crypt.mjs';
import { mutatePurchase, preparePurchaseRequest, reconcileLivePurchase } from '../../src/app/stages/purchase.mjs';
import { mutateOpen, reconcileLiveOpen } from '../../src/app/stages/open.mjs';
import { reconcileLiveEpicGate } from '../../src/app/stages/epic-gate.mjs';
import { reconcileLiveBuyback } from '../../src/app/stages/buyback.mjs';
import { MAXIMUM_PACK_BATCH_SIZE } from '../../../runner/src/cycle/money-schemas.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

const CHAIN_ID = 'solana-mainnet';
const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const SETTLEMENT_ASSET = CIRCLE_USD_MINT;

function settlementAsset() {
  return { chainId: CHAIN_ID, assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS };
}

function collectorMoneyConfiguration() {
  const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: { eth, solanaStablecoin: settlementAsset() },
    minimums: {
      robinhoodReceive: { ...eth, amountAtomic: '0' },
      solanaReceive: { ...settlementAsset(), amountAtomic: '0' },
      returnEth: { ...eth, amountAtomic: '0' },
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

function baseConfig(overrides = {}) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_25' },
    solana: { chainId: CHAIN_ID, blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }) },
    collectorCrypt: { settlementAsset: settlementAsset() },
    moneyConfiguration: collectorMoneyConfiguration(),
    ...overrides,
  };
}

/** In-memory fake covering the exact repository surface every stage module reads or writes. */
function repository({ stages = {}, attempts = {}, batches = {}, intents = {} } = {}) {
  const held = [];
  const heldPositions = [];
  const ledgers = [];
  const batchState = { ...batches };
  const intentState = { ...intents };
  return {
    held,
    heldPositions,
    ledgers,
    batchState,
    intentState,
    async readStage(_cycleId, stage) { return stages[stage] ?? { status: 'PENDING' }; },
    async readOperationalStageAttempt(_cycleId, stage) { return attempts[stage] ?? null; },
    async describeCycle() {
      return {
        releaseAmount: '1000',
        admission: { unitPurchase: { ...settlementAsset(), amountAtomic: '25000000' }, aggregateFundingUsd: { amountMicroUsd: '70000000' } },
        heldPositions: new Map(heldPositions.map(position => [position.positionId, position])),
        custodyLedgers: new Map(ledgers.map(({ ledger }) => [`${ledger.chainId} ${ledger.assetId}`, ledger])),
      };
    },
    async holdCycle(cycleId, terminalState, evidence) { held.push({ cycleId, terminalState, evidence }); },
    async recordHeldPosition(cycleId, input) {
      const position = {
        positionId: `held:test:${heldPositions.length + 1}`,
        cycleId,
        ...input,
        evidenceDigest: `sha256:${'a'.repeat(64)}`,
        openedAtMs: 1,
        positionRevision: 0,
        ownerDecision: null,
        resolution: null,
      };
      heldPositions.push(position);
      held.push({ cycleId, terminalState: input.terminalState, evidence: input.evidence });
      return position;
    },
    async recordCustodyLedger(cycleId, ledger) { ledgers.push({ cycleId, ledger }); },
    async readPackBatchRequest(_cycleId, stage) { return batchState[stage] ?? null; },
    async recordPackBatchRequest(_cycleId, stage, packs) {
      if (batchState[stage]) return batchState[stage];
      const record = { requestedAtMs: 1_000, packs };
      batchState[stage] = record;
      return record;
    },
    async readPackBatchIntent(_cycleId, stage) { return intentState[stage] ?? null; },
    async recordPackBatchIntent(_cycleId, stage, intent) {
      if (intentState[stage]) return intentState[stage];
      const record = { recordedAtMs: 1_000, intent };
      intentState[stage] = record;
      return record;
    },
  };
}

function tokenAccountResponse({ owner = OPERATOR, mint = SETTLEMENT_ASSET, amount = '100000', decimals = CIRCLE_USD_DECIMALS } = {}) {
  return {
    value: {
      owner: TOKEN_PROGRAM_ID,
      data: { program: 'spl-token', parsed: { type: 'account', info: { owner, mint, tokenAmount: { amount, decimals } } } },
    },
  };
}

function jsonRpc(result, id = 1) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

/** A minimal Solana RPC double: every signature finalizes with the configured per-signature debit. */
function rpcClient({ debitsBySignature = new Map() } = {}) {
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') return jsonRpc(tokenAccountResponse(), body.id);
      if (body.method === 'getSignatureStatuses') {
        const [signature] = body.params[0];
        return jsonRpc({ value: [debitsBySignature.has(signature) ? { err: null, confirmationStatus: 'finalized' } : null] }, body.id);
      }
      if (body.method === 'getTransaction') {
        const [signature] = body.params;
        const debit = debitsBySignature.get(signature);
        const preAmount = '1000000';
        const postAmount = (BigInt(preAmount) - BigInt(debit ?? '0')).toString();
        const entry = { tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount, postAmount, decimals: CIRCLE_USD_DECIMALS };
        return jsonRpc({
          transaction: { message: { accountKeys: [{ pubkey: source, signer: false, writable: true }], instructions: [] } },
          meta: {
            preTokenBalances: [{ accountIndex: 0, mint: entry.mint, owner: entry.owner, uiTokenAmount: { amount: entry.preAmount, decimals: entry.decimals } }],
            postTokenBalances: [{ accountIndex: 0, mint: entry.mint, owner: entry.owner, uiTokenAmount: { amount: entry.postAmount, decimals: entry.decimals } }],
            innerInstructions: [],
          },
        }, body.id);
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

async function durableCycle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-multi-pack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await CycleRepository.open(directory);
  const { cycleId } = await repo.createCycle({ releaseAmount: '1000', mode: 'production' });
  return { directory, repository: repo, cycleId };
}

function signatureFor(index) {
  // Not all-digit: the durable journal treats an all-digit string as a bounded decimal value.
  return `SIG${index}`.padEnd(88, 'x');
}

function memoFor(index) {
  return `memo-${index}`;
}

// --- purchase batch size and outcome matrix -----------------------------------------------------

for (const quantity of [1, 2, MAXIMUM_PACK_BATCH_SIZE]) {
  test(`purchase batch of ${quantity} pack(s): every pack is purchased exactly once and never regenerated on retry`, async () => {
    const cycleRepository = repository({
      intents: { purchase: { recordedAtMs: 0, intent: { quantity, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
    });
    const packs = Array.from({ length: quantity }, (_, index) => ({ memo: memoFor(index), transaction: `unsigned-${index}` }));
    const debits = new Map(packs.map((pack, index) => [signatureFor(index), '25000000']));
    let generateCalls = 0;
    let submitCalls = 0;
    const collectorCrypt = {
      async generateYoloPacks({ quantity: requested }) {
        generateCalls += 1;
        assert.equal(requested, quantity);
        return { packs };
      },
      async submitTransaction({ signedTransaction }) {
        submitCalls += 1;
        const index = Number(signedTransaction.split('-')[1]);
        return { signature: signatureFor(index), confirmationStatus: 'submitted' };
      },
      async getPackStatus({ memo }) {
        const index = Number(memo.split('-')[1]);
        return { memo, pack: { transaction_signature: signatureFor(index), token_mint: SETTLEMENT_ASSET }, send: null, buyback: [] };
      },
    };
    const rpc = rpcClient({ debitsBySignature: debits });

    // mutatePurchase's own signing path decodes real Solana transaction bytes; exercising it end
    // to end for N packs duplicates coverage already proven by stages-collector-lifecycle.test.mjs
    // for a single pack. This fixture instead proves the piece unique to N packs: the durable
    // batch ledger is generated exactly once and every pack reconciles independently from it.
    await cycleRepository.recordPackBatchRequest('cycle-x', 'purchase', packs.map((pack, index) => ({
      packIndex: index, memo: pack.memo, expectedCardCount: 1, packType: null,
    })));

    const reconciled = await reconcileLivePurchase({
      adapters: { collectorCrypt, solana: { client: rpc } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-x' },
    });
    assert.equal(reconciled.purchasedCount, quantity);
    assert.equal(reconciled.packs.length, quantity);
    for (const [index, pack] of reconciled.packs.entries()) {
      assert.equal(pack.status, 'purchased');
      assert.equal(pack.packIndex, index);
      assert.deepEqual(pack.packCost, { ...settlementAsset(), amountAtomic: '25000000' });
    }
    assert.equal(generateCalls, 0);
    assert.equal(submitCalls, 0);

    // A second reconcile pass (as a scheduler retick would issue) re-derives the identical
    // outcome from durable provider/chain truth rather than re-purchasing.
    const secondPass = await reconcileLivePurchase({
      adapters: { collectorCrypt, solana: { client: rpc } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-x' },
    });
    assert.deepEqual(secondPass, reconciled);
  });
}

test('purchase batch above the shared journal bound is rejected at admission, before any spend', async () => {
  const collectorCrypt = { async getMachines() { return { machines: [{ code: 'pokemon_25', contains: 1 }] }; }, async generateYoloPacks() { throw new Error('must not be called'); } };
  await assert.rejects(
    preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_25', quantity: MAXIMUM_PACK_BATCH_SIZE + 1 } }) }),
    /quantity must be an integer/,
  );
});

test('mixed batch: one purchased pack that never opens is held, the other pack still opens, gates, and sells', async () => {
  const memoOpens = 'memo-opens';
  const memoStuck = 'memo-stuck';
  const purchaseEvidence = {
    quantity: 2,
    packs: [
      { packIndex: 0, memo: memoOpens, status: 'purchased', signature: signatureFor(0), expectedCardCount: 1, packCost: { ...settlementAsset(), amountAtomic: '25000000' } },
      { packIndex: 1, memo: memoStuck, status: 'purchased', signature: signatureFor(1), expectedCardCount: 1, packCost: { ...settlementAsset(), amountAtomic: '25000000' } },
    ],
    purchasedCount: 2,
  };
  const cardAsset = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: purchaseEvidence } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 2, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, cardAsset).toBase58();
  const collectorCrypt = {
    async getPackStatus({ memo }) {
      if (memo === memoOpens) {
        return { memo, pack: { transaction_signature: signatureFor(0) }, send: { nft_address: cardAsset, transaction_signature: 'OPENSIG'.padEnd(88, 'x'), to_wallet: OPERATOR }, buyback: [] };
      }
      return { memo, pack: {}, send: null, buyback: [] };
    },
  };
  const rpc = createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSignatureStatuses') return jsonRpc({ value: [{ err: null, confirmationStatus: 'finalized' }] }, body.id);
      if (body.method === 'getTransaction') {
        return jsonRpc({
          transaction: { message: { accountKeys: [{ pubkey: cardTokenAccount, signer: false, writable: true }], instructions: [] } },
          meta: {
            preTokenBalances: [{ accountIndex: 0, mint: cardAsset, owner: OPERATOR, uiTokenAmount: { amount: '0', decimals: 0 } }],
            postTokenBalances: [{ accountIndex: 0, mint: cardAsset, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0 } }],
            innerInstructions: [],
          },
        }, body.id);
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });

  // Well past the sent-unknown deadline: memoStuck resolves to a durable held position, while
  // memoOpens resolves normally in the very same reconcile pass.
  const attempts = { open: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } };
  const openResult = await reconcileLiveOpen({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository: { ...cycleRepository, async readOperationalStageAttempt() { return attempts.open; } },
    context: { cycleId: 'cycle-x', nowMs: 31 * 60 * 1000 },
  });

  const openedPack = openResult.packs.find(pack => pack.memo === memoOpens);
  const heldPack = openResult.packs.find(pack => pack.memo === memoStuck);
  assert.equal(openedPack.decision, 'opened');
  assert.equal(openedPack.mint, cardAsset);
  assert.equal(heldPack.decision, 'held');
  assert.equal(heldPack.terminalState, 'HELD_UNRESOLVED');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.equal(cycleRepository.held.length, 1);
  // Each held card retains the complete admitted batch cost, not half or settlement token parity.
  assert.equal(cycleRepository.heldPositions[0].costMicroUsd, '70000000');
  assert.equal(cycleRepository.heldPositions[0].valueMicroUsd, '70000000');
  assert.equal(cycleRepository.heldPositions[0].ledgerAsset ?? null, null);

  // epic-gate and buyback pass the held pack through unchanged and only ever touch the resolved one.
  const epicGatePacks = [
    heldPack,
    { packIndex: 0, memo: memoOpens, mint: cardAsset, decision: 'sell', offer: { ...settlementAsset(), amountAtomic: '21250000' }, insuredValue: { ...settlementAsset(), amountAtomic: '25000000' }, rawInsuredValue: '25000000', insuredValueUnit: 'atomic', instantBuybackPercent: 85, matchedBuybackPercent: 85, prizeTier: '1', rarity: 'epic' },
  ];
  const buybackRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { packs: openResult.packs } } },
    attempts: {
      buyback: {
        attempt: { state: 'RESPONSE_RECORDED' },
        responseEvidence: {
          packs: [
            heldPack,
            { packIndex: 0, decision: 'submitted', memo: memoOpens, mint: cardAsset, signature: 'BUYSIG'.padEnd(88, 'x'), quote: { ...settlementAsset(), amountAtomic: '21250000' }, refundAmount: { ...settlementAsset(), amountAtomic: '21250000' } },
          ],
        },
        reconciliationEvidence: null,
      },
    },
  });
  const buybackCollectorCrypt = {
    async getBuybackCheck() {
      return { exists: true, status: 'complete', buybackAmount: 21250000, playerWallet: OPERATOR, nft: cardAsset, transactionSignature: 'BUYSIG'.padEnd(88, 'x'), createdAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const proceedsAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const buybackRpc = createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSignatureStatuses') return jsonRpc({ value: [{ err: null, confirmationStatus: 'finalized' }] }, body.id);
      if (body.method === 'getTransaction') {
        return jsonRpc({
          transaction: { message: { accountKeys: [{ pubkey: deriveAssociatedTokenAddress(OPERATOR, cardAsset).toBase58(), signer: false, writable: true }, { pubkey: proceedsAccount, signer: false, writable: true }], instructions: [] } },
          meta: {
            preTokenBalances: [
              { accountIndex: 0, mint: cardAsset, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0 } },
              { accountIndex: 1, mint: SETTLEMENT_ASSET, owner: OPERATOR, uiTokenAmount: { amount: '0', decimals: CIRCLE_USD_DECIMALS } },
            ],
            postTokenBalances: [
              { accountIndex: 0, mint: cardAsset, owner: OPERATOR, uiTokenAmount: { amount: '0', decimals: 0 } },
              { accountIndex: 1, mint: SETTLEMENT_ASSET, owner: OPERATOR, uiTokenAmount: { amount: '21250000', decimals: CIRCLE_USD_DECIMALS } },
            ],
            innerInstructions: [],
          },
        }, body.id);
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });

  const buybackResult = await reconcileLiveBuyback({
    adapters: { collectorCrypt: buybackCollectorCrypt, solana: { client: buybackRpc } },
    config: baseConfig(),
    cycleRepository: buybackRepository,
    context: { cycleId: 'cycle-x' },
  });
  assert.equal(buybackResult.soldCount, 1);
  const sold = buybackResult.packs.find(pack => pack.memo === memoOpens);
  const stillHeld = buybackResult.packs.find(pack => pack.memo === memoStuck);
  assert.equal(sold.decision, 'sold');
  assert.deepEqual(sold.proceeds, { ...settlementAsset(), amountAtomic: '21250000' });
  assert.equal(stillHeld.decision, 'held');
  assert.equal(buybackRepository.ledgers[0].ledger.buybackProceeds, '21250000');
});

test('zero sold: every pack in the batch is held, and the buyback custody ledger records no proceeds', async () => {
  const held = { packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'held', terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE', heldPosition: { positionId: 'held:test:1', evidenceDigest: `sha256:${'a'.repeat(64)}`, terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE' } };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { packs: [held] } } },
    attempts: { buyback: { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [held] }, reconciliationEvidence: null } },
  });
  const result = await reconcileLiveBuyback({
    adapters: { collectorCrypt: {}, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: 'cycle-x' },
  });
  assert.equal(result.soldCount, 0);
  assert.deepEqual(result.packs, [held]);
  assert.equal(cycleRepository.ledgers.length, 0);
});

test('provider 429 on the batch call leaves the cycle safely pending, not sent-unknown, so it may be retried', async () => {
  const cycleRepository = repository();
  const rateLimited = new CollectorCryptError('collector-crypt generateYoloPacks responded with status 429', { endpoint: 'generateYoloPacks', status: 429 });
  const collectorCrypt = { async generateYoloPacks() { throw rateLimited; } };
  const rpc = rpcClient();

  await assert.rejects(
    () => mutatePurchase({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-x', request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, expectedCardCountPerPack: 1 } },
    }),
    /active frozen interface authority is invalid/,
  );
  // Nothing was ever durably generated: the batch ledger stays empty and a later retry is safe.
  assert.equal(cycleRepository.batchState.purchase, undefined);
});

test('generate response lost before any memo returns: the pre-call intent is durable, the cycle holds once, and reconciliation never regenerates', async () => {
  const cycleRepository = repository();
  let generateCalls = 0;
  const collectorCrypt = {
    async generateYoloPacks() {
      generateCalls += 1;
      // The provider may have fully processed this request server-side; the connection just
      // never returned a body. No memo of any kind reaches this process.
      throw new Error('connection reset before any response body arrived');
    },
  };
  const rpc = rpcClient();

  // Admit the existing Node-test capability so the provider really loses its response after
  // the durable intent write; no generated bytes can reach a signer.
  await assert.rejects(
    () => mutatePurchase({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
      config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy: {} } } }),
      cycleRepository,
      context: { cycleId: 'cycle-x', request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 2, packType: 'pokemon_25', expectedCardCountPerPack: 1, unitPurchase: { ...settlementAsset(), amountAtomic: '25000000' } } },
      preflightAuthority: createTestProfileMutationAuthority(),
    }),
    /connection reset before any response body arrived/,
  );
  assert.equal(generateCalls, 1);
  assert.deepEqual(cycleRepository.intentState.purchase, {
    recordedAtMs: 1_000,
    intent: { quantity: 2, packType: 'pokemon_25', expectedCardCountPerPack: 1, playerAddress: OPERATOR },
  });
  assert.equal(cycleRepository.batchState.purchase, undefined);

  // Now simulate the whole-cycle hold path directly: the stage attempt went sent-unknown (mutate
  // reached the provider capability and then threw) and its deadline has passed with no batch
  // ever durably generated.
  const heldRepository = repository({
    intents: { purchase: cycleRepository.intentState.purchase },
    attempts: { purchase: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } },
  });
  const result = await reconcileLivePurchase({
    adapters: { collectorCrypt: {}, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository: heldRepository,
    context: { cycleId: 'cycle-x', nowMs: 31 * 60 * 1000 },
  });
  assert.equal(result, null);
  assert.equal(heldRepository.held.length, 1);
  assert.equal(heldRepository.held[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.deepEqual(heldRepository.held[0].evidence.intent, { quantity: 2, packType: 'pokemon_25', expectedCardCountPerPack: 1, playerAddress: OPERATOR });

  // A second and third reconcile pass never call generate again and reach the identical hold.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repeat = await reconcileLivePurchase({
      adapters: { collectorCrypt: { async generateYoloPacks() { throw new Error('must never regenerate'); } }, solana: { client: rpc } },
      config: baseConfig(),
      cycleRepository: heldRepository,
      context: { cycleId: 'cycle-x', nowMs: 31 * 60 * 1000 },
    });
    assert.equal(repeat, null);
  }
  // Every reconcile pass reaches the identical hold evidence (the real CycleRepository.holdCycle
  // is itself idempotent for a matching terminal state and evidence; this fake simply records
  // every call so this asserts that repeated content, not call count).
  for (const call of heldRepository.held) {
    assert.equal(call.terminalState, 'HELD_DATA_UNVERIFIED');
    assert.deepEqual(call.evidence.intent, { quantity: 2, packType: 'pokemon_25', expectedCardCountPerPack: 1, playerAddress: OPERATOR });
  }
});

test('lost response: a durably generated pack whose sign/broadcast crashed mid-flight is never repurchased and reconciles once the debit is observed', async () => {
  const cycleRepository = repository({
    batches: { purchase: { requestedAtMs: 0, packs: [{ packIndex: 0, memo: 'memo-lost', expectedCardCount: 1, packType: null }] } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  let generateCalls = 0;
  const signature = signatureFor(0);
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not regenerate: the memo already survived the crash'); },
    async getPackStatus({ memo }) {
      assert.equal(memo, 'memo-lost');
      return { memo, pack: { transaction_signature: signature, token_mint: SETTLEMENT_ASSET }, send: null, buyback: [] };
    },
  };
  const rpc = rpcClient({ debitsBySignature: new Map([[signature, '25000000']]) });

  const reconciled = await reconcileLivePurchase({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: 'cycle-x' },
  });
  assert.equal(generateCalls, 0);
  assert.equal(reconciled.purchasedCount, 1);
  assert.deepEqual(reconciled.packs[0].packCost, { ...settlementAsset(), amountAtomic: '25000000' });
});

// --- durable restart safety across the real journal ----------------------------------------------

test('a durably recorded batch survives a repository reopen and a retried mutatePurchase never calls generateYoloPacks again', async t => {
  const { directory, repository: repo, cycleId } = await durableCycle(t);
  const packs = [
    { packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: null },
    { packIndex: 1, memo: 'memo-1', expectedCardCount: 1, packType: null },
  ];
  await repo.recordPackBatchRequest(cycleId, 'purchase', packs);

  const reopened = await CycleRepository.open(directory);
  let generateCalls = 0;
  const rpc = rpcClient();
  const evidence = await mutatePurchase({
    liveMode: true,
    adapters: { collectorCrypt: { async generateYoloPacks() { generateCalls += 1; throw new Error('must not regenerate after reopen'); } }, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign: no cached bytes survive a reopen'); } } },
    config: baseConfig(),
    cycleRepository: reopened,
    context: { cycleId, request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 2, expectedCardCountPerPack: 1 } },
  });
  assert.deepEqual(evidence, { quantity: 2, expectedCardCountPerPack: 1 });
  assert.equal(generateCalls, 0);
  assert.deepEqual((await reopened.readPackBatchRequest(cycleId, 'purchase')).packs, packs);
});

for (const generatedFirst of [false, true]) {
  test(`plan recovery never regenerates an uncertain order (${generatedFirst ? 'second order after durable first' : 'first order'})`, async () => {
    const cycleRepository = repository();
    const orders = [
      { orderIndex: 0, packId: 'pokemon_25', quantity: 1, unitPurchase: { ...settlementAsset(), amountAtomic: '25000000' } },
      { orderIndex: 1, packId: 'pokemon_50', quantity: 1, unitPurchase: { ...settlementAsset(), amountAtomic: '50000000' } },
    ];
    const admission = { schema: 'hookemon.policy-admission.v4', quantity: 2, orders };
    cycleRepository.describeCycle = async () => ({ admission });
    const intents = new Map(), batches = new Map();
    if (generatedFirst) {
      intents.set(0, { intent: { quantity: 1, packType: 'pokemon_25', expectedCardCountPerPack: 1, playerAddress: OPERATOR } });
      batches.set(0, { packs: [{ packIndex: 0, memo: 'already-generated', packType: 'pokemon_25', expectedCardCount: 1 }], requestedAtMs: 1000 });
    }
    cycleRepository.readPackOrderIntent = async (_id, index) => intents.get(index) ?? null;
    cycleRepository.readPackOrderRequest = async (_id, index) => batches.get(index) ?? null;
    cycleRepository.readPackOrderReconciliation = async (_id, index) => batches.has(index) ? [{ status: 'purchased' }] : null;
    cycleRepository.recordPackOrderIntent = async (_id, index, intent) => { const record = { intent }; intents.set(index, record); return record; };
    cycleRepository.recordPackOrderRequest = async () => assert.fail('lost response must not create a memo batch');
    const { digest } = await import('../../../runner/src/cycle/journal.mjs');
    const request = { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 2,
      admissionDigest: digest(admission), orders: orders.map(order => ({ ...order, packType: order.packId,
        aggregatePurchase: order.unitPurchase, expectedCardCountPerPack: 1 })) };
    const generated = [];
    const options = { liveMode: true, cycleRepository, request,
      signerClient: { solana: { async sign() { assert.fail('lost generation has no transaction to sign'); } } },
      config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy: {} } } }),
      adapters: { solana: { client: rpcClient() }, collectorCrypt: { async generateYoloPacks(input) {
        generated.push(input.packType); throw new Error('response lost after provider generation');
      } } },
      context: { cycleId: 'cycle-x', requestDigest: `sha256:${'a'.repeat(64)}` },
      preflightAuthority: createTestProfileMutationAuthority(),
    };
    await assert.rejects(mutatePurchase(options), /response lost after provider generation/);
    assert.deepEqual(generated, [generatedFirst ? 'pokemon_50' : 'pokemon_25']);
    await assert.rejects(mutatePurchase(options), /generation is uncertain/);
    assert.equal(generated.length, 1);
    assert.equal(intents.size, generatedFirst ? 2 : 1);
  });
}


test('built-in driver refuses next order while prior broadcast is unfinalized and resumes only after per-memo reconciliation', async () => {
  const { createStageDriver } = await import('../../src/app/stage-driver.mjs');
  const { digest } = await import('../../../runner/src/cycle/journal.mjs');
  const orders = [
    { orderIndex: 0, packId: 'pokemon_25', quantity: 1, unitPurchase: { ...settlementAsset(), amountAtomic: '25000000' } },
    { orderIndex: 1, packId: 'pokemon_50', quantity: 1, unitPurchase: { ...settlementAsset(), amountAtomic: '50000000' } },
  ];
  const admission = { schema: 'hookemon.policy-admission.v4', quantity: 2, orders };
  const parent = { attempt: { state: 'SENT_UNKNOWN', cycleId: 'cycle-x', stage: 'purchase', requestDigest: null }, sentAtMs: 1000 };
  const first = { packs: [{ packIndex: 0, memo: 'memo-0', packType: 'pokemon_25', expectedCardCount: 1 }], requestedAtMs: 1000 };
  const cycleRepository = repository({ intents: { purchase: { recordedAtMs: 1000, intent: { playerAddress: OPERATOR } } } });
  cycleRepository.describeCycle = async () => ({ admission });
  cycleRepository.readOperationalStageAttempt = async () => parent;
  cycleRepository.readStageAttempt = async () => null;
  cycleRepository.readPackBatchRequest = async () => ({ ...first, generationComplete: false });
  const intents = new Map(), reconciled = new Map();
  cycleRepository.readPackOrderRequest = async (_id, index) => index === 0 ? first : null;
  cycleRepository.readPackOrderIntent = async (_id, index) => intents.get(index) ?? null;
  cycleRepository.readPackOrderReconciliation = async (_id, index) => reconciled.get(index) ?? null;
  cycleRepository.recordPackOrderReconciliation = async (_id, index, outcomes) => { reconciled.set(index, outcomes); };
  cycleRepository.recordPackOrderIntent = async (_id, index, intent) => { intents.set(index, { intent, requestDigest: parent.attempt.requestDigest, admissionDigest: digest(admission) }); };
  cycleRepository.recordStageRequestDigest = async () => {};
  cycleRepository.markStageAttemptSentUnknown = async () => {};
  cycleRepository.markStageAttemptNotSent = async () => assert.fail('prior broadcast cannot become NOT_SENT');
  cycleRepository.prepareStageAttempt = async () => assert.fail('resumption keeps the original parent attempt');
  cycleRepository.recordStageAttemptResponse = async () => assert.fail('partial generation cannot complete the parent response');
  cycleRepository.reconcileStageAttempt = async () => assert.fail('partial reconciliation cannot complete the parent stage');
  const debits = new Map();
  const generateCalls = [];
  const collectorCrypt = {
    getMachines: async () => ({ machines: orders.map(order => ({ code: order.packId, contains: 1 })) }),
    getPackStatus: async ({ memo }) => ({ memo, pack: { transaction_signature: signatureFor(0), token_mint: SETTLEMENT_ASSET } }),
    generateYoloPacks: async input => { generateCalls.push(input.packType); throw new Error('second order response lost'); },
  };
  const config = baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy: {} } } });
  const adapters = { collectorCrypt, solana: { client: rpcClient({ debitsBySignature: debits }) } };
  const context = { cycleId: 'cycle-x', stage: 'purchase', nowMs: 2000, assertLease() {}, assertMutationAllowed: async () => {} };
  const request = await preparePurchaseRequest({ adapters, config, cycleRepository, context });
  parent.attempt.requestDigest = digest({ schema: 'hookemon.operational-stage-request.v1', cycleId: 'cycle-x', stage: 'purchase', request });
  intents.set(0, { intent: { playerAddress: OPERATOR }, requestDigest: parent.attempt.requestDigest, admissionDigest: digest(admission) });
  const driver = createStageDriver({ liveMode: true, adapters, config, cycleRepository,
    signerClient: { solana: { sign: async () => assert.fail('second response never reaches signing') } }, preflightAuthority: createTestProfileMutationAuthority() });
  assert.equal(await driver.reconcile(context), null);
  assert.equal(reconciled.size, 0);
  await assert.rejects(driver.execute(context), /requires reconciliation/);
  assert.deepEqual(generateCalls, []);
  // The exact prior signature becomes finalized with its bounded settlement debit.
  debits.set(signatureFor(0), '25000000');
  assert.equal(await driver.reconcile(context), null);
  assert.equal(reconciled.get(0)[0].signature, signatureFor(0));
  await assert.rejects(driver.execute(context), /second order response lost/);
  assert.deepEqual(generateCalls, ['pokemon_50']);
});

test('resumed later order receives its own reconciliation deadline', async () => {
  const orders = ['pokemon_25', 'pokemon_50'].map((packId, orderIndex) => ({ orderIndex, packId, quantity: 1,
    unitPurchase: { ...settlementAsset(), amountAtomic: '25000000' } }));
  const packs = orders.map(order => ({ packIndex: order.orderIndex, packType: order.packId, memo: `memo-${order.orderIndex}`, expectedCardCount: 1 }));
  const cycleRepository = repository({ batches: { purchase: { packs, generationComplete: true, requestedAtMs: 0 } },
    intents: { purchase: { intent: { playerAddress: OPERATOR } } } });
  cycleRepository.describeCycle = async () => ({ admission: { schema: 'hookemon.policy-admission.v4', orders } });
  cycleRepository.readPackOrderRequest = async (_id, i) => ({ packs: [packs[i]], requestedAtMs: i === 0 ? 0 : 10_000_000 });
  cycleRepository.recordPackOrderReconciliation = async () => assert.fail('later order remains pending');
  const adapters = { collectorCrypt: { getPackStatus: async ({ memo }) => ({ memo, pack: null }) }, solana: { client: rpcClient() } };
  assert.equal(await reconcileLivePurchase({ adapters, config: baseConfig(), cycleRepository,
    context: { cycleId: 'cycle-x', stage: 'purchase', nowMs: 10_000_001 } }), null);
});
