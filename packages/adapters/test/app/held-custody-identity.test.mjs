// BOT-HELD-CUSTODY: the three stage-local held-position producers (open, epic-gate, buyback) must
// derive the same canonical eip155:4663/erc20:<address> USDG identity claim and payout already
// maintain their custody rows under, checking raw chain/token/decimals before construction. This
// file is deliberately separate from stages-collector-lifecycle.test.mjs (held worker's exclusive
// write set is the three local producers and the repository held methods, not that shared file).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT, TOKEN_PROGRAM_ID, createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { reconcileLiveOpen } from '../../src/app/stages/open.mjs';
import { mutateEpicGate, reconcileLiveEpicGate } from '../../src/app/stages/epic-gate.mjs';
import { mutateBuyback } from '../../src/app/stages/buyback.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

const CYCLE_ID = 'cycle-held-custody-identity';
const CHAIN_ID = 'solana-mainnet';
const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const CARD_ASSET = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const SETTLEMENT_ASSET = CIRCLE_USD_MINT;
const MEMO = 'memo-held-custody-identity';
const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const CANONICAL_USDG_ASSET = { chainId: 'eip155:4663', assetId: `eip155:4663/erc20:${USDG_ADDRESS}`, decimals: 6 };

function jsonRpc(result, id = 1) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function tokenAccountResponse({ owner = OPERATOR, mint = SETTLEMENT_ASSET, amount = '100', decimals = CIRCLE_USD_DECIMALS } = {}) {
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

function rpcClient({ tokenAccount = tokenAccountResponse() } = {}) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') return jsonRpc(tokenAccount, body.id);
      if (body.method === 'getBalance') return jsonRpc({ value: 1_000_000 }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(99, body.id);
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

function settlementAsset() {
  return { chainId: CHAIN_ID, assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS };
}

function moneyConfiguration(usdg) {
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
      perTransactionGasPriceCap: { chainId: usdg.chainId, assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: usdg.chainId, assetId: 'native', decimals: 18, amountAtomic: '2' },
    },
    solana: {
      priorityFeeCap: { chainId: CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

function baseConfig({ usdg = { chainId: '4663', assetId: USDG_ADDRESS, decimals: 6 }, ...overrides } = {}) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_50' },
    solana: {
      chainId: CHAIN_ID,
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
    },
    collectorCrypt: { settlementAsset: settlementAsset() },
    moneyConfiguration: moneyConfiguration(usdg),
    ...overrides,
  };
}

/** Minimal in-memory fake covering the exact repository surface these three stages read or write. */
function repository({ stages = {}, attempts = {}, intents = {} } = {}) {
  const held = [];
  const heldPositions = [];
  return {
    held,
    heldPositions,
    async readStage(_cycleId, stage) { return stages[stage] ?? { status: 'PENDING' }; },
    async readOperationalStageAttempt(_cycleId, stage) { return attempts[stage] ?? null; },
    async describeCycle() {
      return {
        releaseAmount: '40',
        admission: { unitPurchase: { ...settlementAsset(), amountAtomic: '40' } },
        heldPositions: new Map(heldPositions.map(position => [position.positionId, position])),
        custodyLedgers: new Map(),
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
    async recordCustodyLedger() { throw new Error('recordCustodyLedger must not be called by this fixture'); },
    async readPackBatchRequest(_cycleId, stage) { return intents[stage] ?? null; },
    async recordPackBatchRequest(_cycleId, _stage, packs) { return { requestedAtMs: 1_000, packs }; },
    async readPackBatchIntent(_cycleId, stage) { return intents[stage] ?? null; },
    async recordPackBatchIntent(_cycleId, _stage, intent) { return { recordedAtMs: 1_000, intent }; },
  };
}

function sellDecisionPack(overrides = {}) {
  const rawInsuredValue = overrides.rawInsuredValue ?? '100';
  const offerAtomic = overrides.offerAtomic ?? '39';
  return {
    packIndex: 0,
    memo: MEMO,
    mint: CARD_ASSET,
    decision: 'sell',
    offer: { ...settlementAsset(), amountAtomic: offerAtomic },
    rawInsuredValue,
    insuredValue: { ...settlementAsset(), amountAtomic: rawInsuredValue },
    insuredValueUnit: 'atomic',
    instantBuybackPercent: 85,
    matchedBuybackPercent: 85,
    prizeTier: '1',
    rarity: 'epic',
    ...overrides,
  };
}

function openedPack(overrides = {}) {
  return { packIndex: 0, memo: MEMO, decision: 'opened', signature: 'O4'.repeat(44), mint: CARD_ASSET, assetKind: 'spl', ...overrides };
}

// --- open ----------------------------------------------------------------------------------------

test('reconcileLiveOpen attributes a held position to the canonical eip155:4663 USDG custody identity', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    attempts: { open: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const result = await reconcileLiveOpen({
    adapters: { collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; } }, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, nowMs: 31 * 60 * 1000 },
  });
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.deepEqual(cycleRepository.heldPositions[0].ledgerAsset, CANONICAL_USDG_ASSET);
});

test('open refuses to hold a card when the configured USDG asset is not the recognized canonical chain, token, or decimals', async () => {
  const fixture = () => repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    attempts: { open: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const adapters = { collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; } }, solana: { client: rpcClient() } };
  const context = { cycleId: CYCLE_ID, nowMs: 31 * 60 * 1000 };

  for (const usdg of [
    { chainId: '1', assetId: USDG_ADDRESS, decimals: 6 },
    { chainId: '4663', assetId: '0xNOT-AN-ADDRESS', decimals: 6 },
    { chainId: '4663', assetId: USDG_ADDRESS.toUpperCase(), decimals: 6 },
    { chainId: '4663', assetId: USDG_ADDRESS, decimals: 18 },
  ]) {
    const cycleRepository = fixture();
    await assert.rejects(
      () => reconcileLiveOpen({ adapters, config: baseConfig({ usdg }), cycleRepository, context }),
      /held open USDG ledger asset must use the configured six-decimal normalized USDG asset/,
    );
    assert.equal(cycleRepository.heldPositions.length, 0, 'refuses before any custody write');
  }
});

// --- epic-gate -------------------------------------------------------------------------------

test('reconcileLiveEpicGate attributes a held position to the canonical eip155:4663 USDG custody identity', async () => {
  const cycleRepository = repository({
    attempts: { 'epic-gate': { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [sellDecisionPack({ offerAtomic: '39', decision: 'hold' })] }, reconciliationEvidence: null } },
  });
  const evidence = await reconcileLiveEpicGate({ adapters: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.deepEqual(cycleRepository.heldPositions[0].ledgerAsset, CANONICAL_USDG_ASSET);
});

test('epic-gate refuses to hold a card when the configured USDG asset is not the recognized canonical chain, token, or decimals', async () => {
  const fixture = () => repository({
    attempts: { 'epic-gate': { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [sellDecisionPack({ offerAtomic: '39', decision: 'hold' })] }, reconciliationEvidence: null } },
  });
  const context = { cycleId: CYCLE_ID };

  for (const usdg of [
    { chainId: '1', assetId: USDG_ADDRESS, decimals: 6 },
    { chainId: '4663', assetId: '0xNOT-AN-ADDRESS', decimals: 6 },
    { chainId: '4663', assetId: USDG_ADDRESS.toUpperCase(), decimals: 6 },
    { chainId: '4663', assetId: USDG_ADDRESS, decimals: 18 },
  ]) {
    const cycleRepository = fixture();
    await assert.rejects(
      () => reconcileLiveEpicGate({ adapters: {}, config: baseConfig({ usdg }), cycleRepository, context }),
      /held epic USDG ledger asset must use the configured six-decimal normalized USDG asset/,
    );
    assert.equal(cycleRepository.heldPositions.length, 0, 'refuses before any custody write');
  }
});

test('mutateEpicGate passing a held open pack through never derives a custody identity at all', async () => {
  const heldPack = { packIndex: 0, memo: MEMO, mint: null, decision: 'held', terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED', heldPosition: { positionId: 'held:test:1', evidenceDigest: `sha256:${'a'.repeat(64)}`, terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED' } };
  const cycleRepository = repository({ stages: { open: { status: 'COMPLETE', evidence: { packs: [heldPack] } } } });
  const evidence = await mutateEpicGate({ liveMode: true, adapters: {}, config: baseConfig({ usdg: { chainId: '1', assetId: 'bad', decimals: 1 } }), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.deepEqual(evidence, { packs: [heldPack] });
  assert.equal(cycleRepository.heldPositions.length, 0);
});

// --- buyback ---------------------------------------------------------------------------------

test('mutateBuyback attributes a HELD_UNAVAILABLE position to the canonical eip155:4663 USDG custody identity', async () => {
  const cycleRepository = repository({ stages: { 'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } } } });
  const collectorCrypt = { async getBuybackAvailable() { return { available: false }; } };
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) } },
    signerClient: {},
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.deepEqual(cycleRepository.heldPositions[0].ledgerAsset, CANONICAL_USDG_ASSET);
});

test('buyback refuses to hold a card when the configured USDG asset is not the recognized canonical chain, token, or decimals', async () => {
  const fixture = () => repository({ stages: { 'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } } } });
  const collectorCrypt = { async getBuybackAvailable() { return { available: false }; } };
  const context = { cycleId: CYCLE_ID };

  for (const usdg of [
    { chainId: '1', assetId: USDG_ADDRESS, decimals: 6 },
    { chainId: '4663', assetId: '0xNOT-AN-ADDRESS', decimals: 6 },
    { chainId: '4663', assetId: USDG_ADDRESS.toUpperCase(), decimals: 6 },
    { chainId: '4663', assetId: USDG_ADDRESS, decimals: 18 },
  ]) {
    const cycleRepository = fixture();
    await assert.rejects(
      () => mutateBuyback({
        liveMode: true,
        adapters: { collectorCrypt, solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) } },
        signerClient: {},
        config: baseConfig({ usdg }),
        cycleRepository,
        context,
      }),
      /held buyback USDG ledger asset must use the configured six-decimal normalized USDG asset/,
    );
    assert.equal(cycleRepository.heldPositions.length, 0, 'refuses before any custody write');
  }
});

// --- buyback HELD_UNAVAILABLE against the real repository (N2 gap1) -----------------------------

test('N2: buyback HELD_UNAVAILABLE against the real repository lands its held value on the canonical eip155:4663 USDG custody row', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-held-custody-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cycleRepository = await CycleRepository.open(directory);
  const { cycleId } = await cycleRepository.createCycle({ releaseAmount: '1', mode: 'production' });
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1, packCost: { ...settlementAsset(), amountAtomic: '40' } }], purchasedCount: 1 }],
    ['open', { packs: [openedPack()] }],
    ['epic-gate', { packs: [sellDecisionPack()] } ],
  ]) {
    await cycleRepository.prepareStage(cycleId, stage);
    await cycleRepository.completeStage(cycleId, stage, evidence);
  }

  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: { async getBuybackAvailable() { return { available: false }; } },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { throw new Error('signer must not run'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId },
  });
  assert.equal(result.packs[0].terminalState, 'HELD_UNAVAILABLE');

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  const key = `${CANONICAL_USDG_ASSET.chainId}\u0000${CANONICAL_USDG_ASSET.assetId}`;
  const row = state.custodyLedgers.get(key);
  assert.ok(row, 'held value lands on the canonical eip155:4663 row, not a competing raw row');
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.heldPositions, '1');
  assert.equal(row.verifiedCurrentBalance, null);
  assert.equal(row.expectedCycleAsset, null);
  assert.equal(state.custodyLedgers.size, 1, 'no separate raw-identity row was also created');
});
