import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
// Held card costs remain frozen USD accounting values and never become native principal.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PublicKey } from '@solana/web3.js';

import {
  CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT, MPL_CORE_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createSolanaRpcClient, deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
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

/** A minimal, correctly shaped Metaplex Core AssetV1 account (`readMplCoreAssetOwner`'s own
 * parsing) so buyback's finalized-ownership check resolves against the configured operator by
 * default -- mirrors stages-collector-lifecycle.test.mjs's own fixture. */
function mplCoreAssetResponse({ owner = OPERATOR } = {}) {
  const bytes = Buffer.concat([Buffer.from([1]), Buffer.from(new PublicKey(owner).toBytes())]);
  return { value: { owner: MPL_CORE_PROGRAM_ID, data: [bytes.toString('base64'), 'base64'] } };
}

function rpcClient({ tokenAccount = tokenAccountResponse(), cardOwner = OPERATOR, cardAssetId = CARD_ASSET } = {}) {
  const cardAta = deriveAssociatedTokenAddress(OPERATOR, cardAssetId).toBase58();
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') {
        const [address] = body.params;
        if (address === cardAssetId) return jsonRpc(mplCoreAssetResponse({ owner: cardOwner }), body.id);
        if (address === cardAta) {
          return jsonRpc(tokenAccountResponse({ owner: OPERATOR, mint: cardAssetId, amount: cardOwner === OPERATOR ? '1' : '0', decimals: 0 }), body.id);
        }
        return jsonRpc(tokenAccount, body.id);
      }
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

function moneyConfiguration(eth) {
  const solanaStablecoin = settlementAsset();
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: { eth, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...eth, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnEth: { ...eth, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: eth.chainId, assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: eth.chainId, assetId: 'native', decimals: 18, amountAtomic: '2' },
    },
    solana: {
      priorityFeeCap: { chainId: CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

function baseConfig({ eth = { chainId: '4663', assetId: 'native', decimals: 18 }, ...overrides } = {}) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_50' },
    solana: {
      chainId: CHAIN_ID,
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
    },
    collectorCrypt: { settlementAsset: settlementAsset() },
    moneyConfiguration: moneyConfiguration(eth),
    ...overrides,
  };
}

/** Minimal in-memory fake covering the exact repository surface these three stages read or write. */
function repository({ stages = {}, attempts = {}, intents = {}, costMicroUsd = '80' } = {}) {
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
        admission: { unitPurchase: { ...settlementAsset(), amountAtomic: '40' }, aggregateFundingUsd: { amountMicroUsd: costMicroUsd } },
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

test('reconcileLiveOpen records frozen USD purchase cost without native ledger attribution', async () => {
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
  assert.equal(cycleRepository.heldPositions[0].ledgerAsset, undefined);
  assert.equal(cycleRepository.heldPositions[0].costMicroUsd, '80');
});

test('open refuses to hold a card without a canonical committed USD purchase cost', async () => {
  const fixture = costMicroUsd => repository({ costMicroUsd,
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    attempts: { open: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const adapters = { collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; } }, solana: { client: rpcClient() } };
  const context = { cycleId: CYCLE_ID, nowMs: 31 * 60 * 1000 };

  for (const costMicroUsd of [null, '1.5', '-1', '01']) {
    const cycleRepository = fixture(costMicroUsd);
    await assert.rejects(
      () => reconcileLiveOpen({ adapters, config: baseConfig(), cycleRepository, context }),
      /committed USD purchase cost/,
    );
    assert.equal(cycleRepository.heldPositions.length, 0, 'refuses before any custody write');
  }
});

// --- epic-gate -------------------------------------------------------------------------------

test('reconcileLiveEpicGate records frozen USD purchase cost without native ledger attribution', async () => {
  const cycleRepository = repository({
    attempts: { 'epic-gate': { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [sellDecisionPack({ offerAtomic: '39', decision: 'hold' })] }, reconciliationEvidence: null } },
  });
  const evidence = await reconcileLiveEpicGate({ adapters: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.equal(cycleRepository.heldPositions[0].ledgerAsset, undefined);
  assert.equal(cycleRepository.heldPositions[0].costMicroUsd, '80');
});

test('epic-gate refuses to hold a card without a canonical committed USD purchase cost', async () => {
  const fixture = costMicroUsd => repository({ costMicroUsd,
    attempts: { 'epic-gate': { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [sellDecisionPack({ offerAtomic: '39', decision: 'hold' })] }, reconciliationEvidence: null } },
  });
  const context = { cycleId: CYCLE_ID };

  for (const costMicroUsd of [null, '1.5', '-1', '01']) {
    const cycleRepository = fixture(costMicroUsd);
    await assert.rejects(
      () => reconcileLiveEpicGate({ adapters: {}, config: baseConfig(), cycleRepository, context }),
      /committed USD purchase cost/,
    );
    assert.equal(cycleRepository.heldPositions.length, 0, 'refuses before any custody write');
  }
});

test('mutateEpicGate passing a held open pack through never derives a custody identity at all', async () => {
  const heldPack = { packIndex: 0, memo: MEMO, mint: null, decision: 'held', terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED', heldPosition: { positionId: 'held:test:1', evidenceDigest: `sha256:${'a'.repeat(64)}`, terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED' } };
  const cycleRepository = repository({ stages: { open: { status: 'COMPLETE', evidence: { packs: [heldPack] } } } });
  const evidence = await mutateEpicGate({ liveMode: true, adapters: {}, config: baseConfig({ eth: { chainId: '1', assetId: 'bad', decimals: 1 } }), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.deepEqual(evidence, { packs: [heldPack] });
  assert.equal(cycleRepository.heldPositions.length, 0);
});

// --- buyback ---------------------------------------------------------------------------------

test('mutateBuyback records HELD_UNAVAILABLE cost without native ledger attribution', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
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
  assert.equal(cycleRepository.heldPositions[0].ledgerAsset, undefined);
  assert.equal(cycleRepository.heldPositions[0].costMicroUsd, '80');
});

test('buyback refuses to hold a card without a canonical committed USD purchase cost', async () => {
  const fixture = costMicroUsd => repository({ costMicroUsd, stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
  const collectorCrypt = { async getBuybackAvailable() { return { available: false }; } };
  const context = { cycleId: CYCLE_ID };

  for (const costMicroUsd of [null, '1.5', '-1', '01']) {
    const cycleRepository = fixture(costMicroUsd);
    await assert.rejects(
      () => mutateBuyback({
        liveMode: true,
        adapters: { collectorCrypt, solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) } },
        signerClient: {},
        config: baseConfig(),
        cycleRepository,
        context,
      }),
      /attributable cycle purchase evidence/,
    );
    assert.equal(cycleRepository.heldPositions.length, 0, 'refuses before any custody write');
  }
});

// --- buyback HELD_UNAVAILABLE against the real repository (N2 gap1) -----------------------------

test('N2: buyback HELD_UNAVAILABLE against the real repository preserves USD held cost without creating fungible native custody', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-held-custody-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cycleRepository = await CycleRepository.open(directory, () => 1700000000000, { testAuthority: createTestProfileMutationAuthority() });
  const cycleId = cycleRepository.nextCycleId();
  const admission = await nativeProducedAdmissionFixture(cycleId, { amountWei: '1', costMicroUsd: '80' });
  admission.packId = 'pokemon_50';
  await cycleRepository.createCycle({ cycleId, admission, releaseAmount: '1', mode: 'production' });
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

  const reopened = await CycleRepository.open(directory, () => 1700000000001, { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.equal([...state.heldPositions.values()][0].costMicroUsd, '80');
  assert.equal(state.custodyLedgers.size, 0, 'USD purchase cost creates no native principal');
});
