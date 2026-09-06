import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { projectCycleAccounting, projectPolicyCustody } from '../../src/app/accounting-projection.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { CycleJournal } from '../../../runner/src/cycle/journal.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';

async function openRepository(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-accounting-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return CycleRepository.open(directory, () => 1_000);
}

async function appendHistoricalStage(directory, cycleId, stage, evidence) {
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose('stage-completed', { stage, evidence });
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);
}

async function completeStageInOrder(repository, cycleId, stage, evidence) {
  const stageIndex = OPERATIONAL_CYCLE_STAGES.indexOf(stage);
  for (const current of OPERATIONAL_CYCLE_STAGES.slice(0, stageIndex + 1)) {
    const existing = await repository.readStage(cycleId, current);
    if (existing.status === 'COMPLETE') continue;
    await repository.prepareStage(cycleId, current);
    await repository.completeStage(cycleId, current, current === stage ? evidence : { seeded: true, stage: current });
  }
}

test('projectCycleAccounting requires a cycleRepository and a cycleId', async () => {
  await assert.rejects(() => projectCycleAccounting({ cycleRepository: null, cycleId: 'x' }), /cycleRepository/);
  const repository = { readStage: async () => null, describeCycle: async () => ({}) };
  await assert.rejects(() => projectCycleAccounting({ cycleRepository: repository, cycleId: '' }), /cycleId/);
});

function custodyLedger({ cycleId, chainId, assetId, decimals = 6, ...buckets }) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId,
    assetId,
    decimals,
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    heldPositions: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
    ...buckets,
  };
}

function custodyRepository(cycles) {
  return {
    async listKnownCycleIds() { return Object.keys(cycles).sort(); },
    async describeCycle(cycleId) { return cycles[cycleId]; },
  };
}

const evmUsdg = Object.freeze({ chainId: 'eip155:4663', assetId: 'erc20:usdg', decimals: 6 });

test('policy custody keeps each cycle partitioned and never converts a foreign stable balance into micro-USDG', async () => {
  const repository = custodyRepository({
    archived: {
      cycleId: 'archived',
      terminalState: 'COMPLETED',
      custodyLedgers: new Map([['evm', custodyLedger({
        cycleId: 'archived', chainId: evmUsdg.chainId, assetId: evmUsdg.assetId,
        claimed: '11', returnReceived: '7', residual: '2', payoutLiability: '3', dust: '1', refunds: '4',
      })]]),
    },
    active: {
      cycleId: 'active',
      terminalState: null,
      custodyLedgers: new Map([
        ['evm', custodyLedger({
          cycleId: 'active', chainId: evmUsdg.chainId, assetId: evmUsdg.assetId,
          claimed: '9', returnReceived: '5', residual: '6', payoutLiability: '7', dust: '8', refunds: '9',
        })],
        ['solana', custodyLedger({
          cycleId: 'active', chainId: 'solana:mainnet', assetId: 'spl:stable',
          packCost: '100', heldAssets: '1', unattributed: '1',
        })],
      ]),
    },
  });

  const custody = await projectPolicyCustody({ cycleRepository: repository, evmUsdg });
  assert.equal(custody.realizedLossMicroUsdg, '4');
  assert.equal(custody.atRiskMicroUsdg, '4');
  assert.equal(custody.outstandingMicroUsdg, '48');
  assert.equal(custody.heldAssets, true);
  assert.equal(custody.unattributed, true);
  assert.equal(custody.unvaluedExposure, true);
  assert.deepEqual(custody.cycles.map(cycle => [cycle.cycleId, cycle.outstandingMicroUsdg]), [
    ['active', '34'],
    ['archived', '14'],
  ]);
});

test('policy custody carries open held positions at their recorded USDG values', async () => {
  const position = ({ positionId, cycleId, valueMicroUsdg, resolution = null }) => ({
    positionId,
    cycleId,
    costMicroUsdg: valueMicroUsdg,
    valueMicroUsdg,
    insuredValue: null,
    reason: 'HELD_UNRESOLVED',
    terminalState: 'HELD_UNRESOLVED',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    openedAtMs: 1_000,
    positionRevision: 0,
    ownerDecision: null,
    resolution,
  });
  const repository = custodyRepository({
    'cycle-alpha': {
      cycleId: 'cycle-alpha',
      terminalState: 'COMPLETED',
      custodyLedgers: new Map(),
      heldPositions: new Map([
        ['held-alpha', position({ positionId: 'held-alpha', cycleId: 'cycle-alpha', valueMicroUsdg: '19' })],
        ['held-resolved', position({
          positionId: 'held-resolved',
          cycleId: 'cycle-alpha',
          valueMicroUsdg: '23',
          resolution: { state: 'SOLD' },
        })],
      ]),
    },
    'cycle-beta': {
      cycleId: 'cycle-beta',
      terminalState: 'COMPLETED',
      custodyLedgers: new Map(),
      heldPositions: new Map([
        ['held-beta', position({ positionId: 'held-beta', cycleId: 'cycle-beta', valueMicroUsdg: '31' })],
      ]),
    },
  });

  const custody = await projectPolicyCustody({ cycleRepository: repository, evmUsdg });
  assert.equal(custody.heldPositions.count, 2);
  assert.equal(custody.heldPositions.valueMicroUsdg, '50');
  assert.deepEqual(
    custody.heldPositions.positions.map(({ positionId, cycleId, valueMicroUsdg }) => ({ positionId, cycleId, valueMicroUsdg })),
    [
      { positionId: 'held-alpha', cycleId: 'cycle-alpha', valueMicroUsdg: '19' },
      { positionId: 'held-beta', cycleId: 'cycle-beta', valueMicroUsdg: '31' },
    ],
  );
  assert.deepEqual(custody.heldPositions.positions[0], {
    positionId: 'held-alpha',
    cycleId: 'cycle-alpha',
    costMicroUsdg: '19',
    valueMicroUsdg: '19',
    insuredValue: null,
    reason: 'HELD_UNRESOLVED',
    terminalState: 'HELD_UNRESOLVED',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    openedAtMs: 1_000,
    positionRevision: 0,
    ownerDecision: null,
  });
});

test('does not classify a separately valued foreign held-position bucket as unvalued custody', async () => {
  const repository = custodyRepository({
    held: {
      cycleId: 'held',
      terminalState: 'COMPLETED',
      custodyLedgers: new Map([['solana', custodyLedger({
        cycleId: 'held',
        chainId: 'solana:mainnet',
        assetId: 'spl:card-custody',
        heldPositions: '40',
      })]]),
      heldPositions: new Map([['held-card', {
        positionId: 'held-card',
        cycleId: 'held',
        costMicroUsdg: '40',
        valueMicroUsdg: '40',
        insuredValue: null,
        reason: 'EPIC_THRESHOLD',
        terminalState: 'HELD_OWNER_DECISION',
        evidenceDigest: `sha256:${'b'.repeat(64)}`,
        openedAtMs: 1_000,
        positionRevision: 0,
        ownerDecision: null,
        resolution: null,
      }]]),
    },
  });

  const custody = await projectPolicyCustody({ cycleRepository: repository, evmUsdg });
  assert.equal(custody.unvaluedExposure, false);
  assert.equal(custody.heldPositions.count, 1);
  assert.equal(custody.heldPositions.valueMicroUsdg, '40');
});

test('policy custody partition property never offsets one cycle against another', async () => {
  const cycles = {};
  let expectedOutstanding = 0n;
  let expectedAtRisk = 0n;
  for (let index = 0; index < 64; index += 1) {
    const cycleId = `cycle-${index}`;
    const claimed = BigInt((index * 17) % 31);
    const returned = BigInt((index * 13) % 37);
    const residual = BigInt((index * 7) % 19);
    const payoutLiability = BigInt((index * 5) % 23);
    const dust = BigInt((index * 3) % 11);
    const refunds = BigInt((index * 11) % 29);
    const unresolved = claimed > returned ? claimed - returned : 0n;
    expectedOutstanding += unresolved + residual + payoutLiability + dust + refunds;
    expectedAtRisk += unresolved;
    cycles[cycleId] = {
      cycleId,
      terminalState: null,
      custodyLedgers: new Map([['evm', custodyLedger({
        cycleId, chainId: evmUsdg.chainId, assetId: evmUsdg.assetId,
        claimed: claimed.toString(), returnReceived: returned.toString(), residual: residual.toString(),
        payoutLiability: payoutLiability.toString(), dust: dust.toString(), refunds: refunds.toString(),
      })]]),
    };
  }

  const custody = await projectPolicyCustody({ cycleRepository: custodyRepository(cycles), evmUsdg });
  assert.equal(custody.outstandingMicroUsdg, expectedOutstanding.toString());
  assert.equal(custody.atRiskMicroUsdg, expectedAtRisk.toString());
  assert.equal(custody.cycles.length, 64);
});

test('a settled foreign custody flow without a current balance does not remain unvalued', async () => {
  const repository = custodyRepository({
    foreign: {
      cycleId: 'foreign',
      terminalState: null,
      custodyLedgers: new Map([['foreign', custodyLedger({
        cycleId: 'foreign', chainId: 'solana:mainnet', assetId: 'spl:stable', packCost: '1',
      })]]),
    },
  });
  const custody = await projectPolicyCustody({ cycleRepository: repository, evmUsdg });
  assert.equal(custody.unvaluedExposure, false);
});

test('a foreign current balance remains unvalued until it is reconciled or classified', async () => {
  const repository = custodyRepository({
    foreign: {
      cycleId: 'foreign',
      terminalState: null,
      custodyLedgers: new Map([['foreign', custodyLedger({
        cycleId: 'foreign', chainId: 'solana:mainnet', assetId: 'spl:stable', residual: '1',
      })]]),
    },
  });
  const custody = await projectPolicyCustody({ cycleRepository: repository, evmUsdg });
  assert.equal(custody.unvaluedExposure, true);
});

test('accounting projection does not reconstruct retired rehearsal evidence at runtime', async () => {
  const source = await readFile(new URL('../../src/app/accounting-projection.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /String\.fromCharCode/);
});

test('a fresh cycle with no completed stages reports the honest all-null shape (never an invented zero)', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });

  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.packSpendMicroUsdg, null);
  assert.equal(accounting.buybackMicroUsdg, null);
  assert.equal(accounting.outboundBridgeDebit, null);
  assert.equal(accounting.inboundBridgeProceeds, null);
  assert.equal(accounting.collectorPurchaseDebit, null);
  assert.equal(accounting.collectorBuybackProceeds, null);
  assert.equal(accounting.packGainMicroUsdg, null);
  assert.equal(accounting.packLossMicroUsdg, null);
  assert.equal(accounting.quotedCosts.outboundBridgeMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'not-started');
  assert.equal(accounting.distributionStatus, 'not-started');
  // Every field the contract does not yet have real evidence for is null, never fabricated.
  assert.equal(accounting.protectedCostsMicroUsdg, null);
  assert.equal(accounting.confirmedCostsMicroUsdg, null);
  assert.equal(accounting.plannedHolderRewardsMicroUsdg, null);
  assert.equal(accounting.payoutLiabilityMicroUsdg, null);
  assert.equal(accounting.payoutDustMicroUsdg, null);
  assert.equal(accounting.paidHolderRewardsRecipientCount, null);
});

function relayLeg({
  direction, state = 'SETTLED',
  sourceChainId = '4663', sourceAssetId = EXPECTED_USDG_ASSET_ID, sourceDecimals = 6, sourceAmountAtomic = '0',
  destinationChainId = '4663', destinationAssetId = EXPECTED_USDG_ASSET_ID, destinationDecimals = 6, destinationAmountAtomic = '0',
}) {
  return {
    direction, state,
    sourceChainId, sourceAssetId, sourceDecimals, sourceAmountAtomic,
    destinationChainId, destinationAssetId, destinationDecimals, destinationAmountAtomic,
  };
}

function relayLegRepository({ releaseAmount = '0', relayLegs = new Map(), stages = {} }) {
  return {
    async describeCycle() { return { releaseAmount, relayLegs }; },
    async readStage(_cycleId, stage) { return stages[stage] ?? { status: 'PENDING' }; },
  };
}

test('outboundBridgeDebit is the settled outbound bridge amount, never the allocated cycle budget; packSpendMicroUsdg has no honest USDG pack-economics producer and stays null', async () => {
  const repository = relayLegRepository({
    releaseAmount: '100', // the cycle's allocated budget
    relayLegs: new Map([['leg-1', relayLeg({ direction: 'outbound', sourceAmountAtomic: '50' })]]),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.deepEqual(accounting.outboundBridgeDebit, { chainId: '4663', assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, units: '50' });
  assert.equal(accounting.packSpendMicroUsdg, null, 'no honest same-asset USDG pack-economics producer exists');
  assert.equal(accounting.buybackMicroUsdg, null);
  assert.equal(accounting.packGainMicroUsdg, null);
  assert.equal(accounting.packLossMicroUsdg, null);
});

test('outboundBridgeDebit stays null (unknown) until the outbound leg is durably settled', async () => {
  const repository = relayLegRepository({
    releaseAmount: '100',
    relayLegs: new Map([['leg-1', relayLeg({ direction: 'outbound', state: 'RECORDED', sourceAmountAtomic: '50' })]]),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.outboundBridgeDebit, null);
});

test('outboundBridgeDebit stays null when more than one settled outbound leg exists (ambiguous, never guessed)', async () => {
  const repository = relayLegRepository({
    releaseAmount: '100',
    relayLegs: new Map([
      ['leg-1', relayLeg({ direction: 'outbound', sourceAmountAtomic: '50' })],
      ['leg-2', relayLeg({ direction: 'outbound', sourceAmountAtomic: '60' })],
    ]),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.outboundBridgeDebit, null);
});

test('quotedCosts.outboundBridgeMicroUsdg is always null: the quoted origin (USDG) and destination (Solana USDC) are different assets, never subtracted', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });
  await completeStageInOrder(repository, cycleId, 'outbound', {
    wouldBridgeOutbound: true,
    configured: true,
    quote: { wouldExecute: true, requestId: 'req-1' },
    quotedOriginAmount: '5000000',
    quotedDestinationAmount: '4995000',
  });

  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.quotedCosts.outboundBridgeMicroUsdg, null);
});

test('holderRewardsStatus fails closed to awaiting-verification when the payout stage is COMPLETE but carries no real finalized-payout evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-accounting-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let repository = await CycleRepository.open(directory, () => 1_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });

  assert.equal((await projectCycleAccounting({ cycleRepository: repository, cycleId })).distributionStatus, 'not-started');

  await completeStageInOrder(repository, cycleId, 'return', { seeded: true });
  assert.equal((await projectCycleAccounting({ cycleRepository: repository, cycleId })).distributionStatus, 'awaiting-distribution');

  await appendHistoricalStage(directory, cycleId, 'distribution', { seeded: true });
  repository = await CycleRepository.open(directory, () => 1_000);
  let accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.distributionStatus, 'verified');
  assert.equal(accounting.holderRewardsStatus, 'distribution-verified');

  // The payout stage completes with test-seed evidence ({ seeded: true }), not a real
  // hookemon.direct-payout-result.v1 bundle — COMPLETE alone must never be read as "paid".
  await completeStageInOrder(repository, cycleId, 'payout', { seeded: true });
  accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.distributionStatus, 'settled');
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
});

test('inboundBridgeProceeds is the settled return bridge amount, never the Solana proceeds at an assumed USDG parity; buybackMicroUsdg stays null', async () => {
  const repository = relayLegRepository({
    releaseAmount: '5000000',
    relayLegs: new Map([
      ['out', relayLeg({ direction: 'outbound', sourceAmountAtomic: '5000000' })],
      ['ret', relayLeg({ direction: 'return', destinationAmountAtomic: '4995000' })],
    ]),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.deepEqual(accounting.inboundBridgeProceeds, { chainId: '4663', assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, units: '4995000' });
  assert.equal(accounting.buybackMicroUsdg, null);
  assert.equal(accounting.packGainMicroUsdg, null);
  assert.equal(accounting.packLossMicroUsdg, null);
});

test('a completed production payout stage carrying only rehearsal Solana proceeds does not populate inboundBridgeProceeds or buybackMicroUsdg', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });
  await completeStageInOrder(repository, cycleId, 'purchase', { signature: 'purchase-1' });
  await completeStageInOrder(repository, cycleId, 'payout', {
    signature: 'payout-1',
    proceedsMicroSolanaStable: '4995000',
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.buybackMicroUsdg, null, 'no settled return bridge leg exists, so this is honestly unknown, not a rehearsal-derived figure');
  assert.equal(accounting.inboundBridgeProceeds, null);
});

test('collectorPurchaseDebit/collectorBuybackProceeds carry the real Collector-Crypt-side (Solana) typed amounts, distinct from the EVM bridge amounts', async () => {
  const repository = relayLegRepository({
    relayLegs: new Map([
      ['out', relayLeg({ direction: 'outbound', sourceAmountAtomic: '50' })],
      ['ret', relayLeg({ direction: 'return', destinationAmountAtomic: '48' })],
    ]),
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          packCost: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '49' },
        },
      },
      buyback: {
        status: 'COMPLETE',
        evidence: {
          proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, amountAtomic: '47' },
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.deepEqual(accounting.outboundBridgeDebit, { chainId: '4663', assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, units: '50' });
  assert.deepEqual(accounting.collectorPurchaseDebit, {
    chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, units: '49',
  });
  assert.deepEqual(accounting.inboundBridgeProceeds, { chainId: '4663', assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, units: '48' });
  assert.deepEqual(accounting.collectorBuybackProceeds, {
    chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, units: '47',
  });
  // The bridge amount and the Collector amount are genuinely different real numbers (bridge
  // fees/slippage) - never equated, and packSpendMicroUsdg never reports either as pack economics.
  assert.notEqual(accounting.outboundBridgeDebit.units, accounting.collectorPurchaseDebit.units);
  assert.equal(accounting.packSpendMicroUsdg, null);
});

const SOLANA_USDC = { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6 };
function solAmount(amountAtomic) { return { ...SOLANA_USDC, amountAtomic }; }

test('collectorPurchaseDebit sums an N-pack purchase batch: verified purchased packs plus genuinely zero-cost not_purchased packs', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 3,
          purchasedCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('30') },
            { packIndex: 1, memo: 'memo-1', status: 'not_purchased' },
            { packIndex: 2, memo: 'memo-2', status: 'purchased', packCost: solAmount('20') },
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.deepEqual(accounting.collectorPurchaseDebit, { ...SOLANA_USDC, units: '50' });
});

test('collectorBuybackProceeds sums only sold packs; held (never-sold) packs are a real verified zero, not unknown', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 3,
          purchasedCount: 3,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('10') },
            { packIndex: 1, memo: 'memo-1', status: 'purchased', packCost: solAmount('10') },
            { packIndex: 2, memo: 'memo-2', status: 'purchased', packCost: solAmount('10') },
          ],
        },
      },
      buyback: {
        status: 'COMPLETE',
        evidence: {
          soldCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sold', signature: 'sig-0', proceeds: solAmount('40') },
            { packIndex: 1, memo: 'memo-1', mint: 'mint-1', decision: 'held', terminalState: 'HELD_OWNER_DECISION', reason: 'insured value exceeds cap' },
            { packIndex: 2, memo: 'memo-2', mint: 'mint-2', decision: 'sold', signature: 'sig-2', proceeds: solAmount('35') },
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.deepEqual(accounting.collectorBuybackProceeds, { ...SOLANA_USDC, units: '75' });
});

test('collectorPurchaseDebit fails closed to null when a purchased pack is missing its own packCost (never a fabricated zero or a silently dropped pack)', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          purchasedCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('30') },
            { packIndex: 1, memo: 'memo-1', status: 'purchased' }, // packCost missing
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorPurchaseDebit, null);
});

test('collectorBuybackProceeds fails closed to null on a mixed-denomination pack batch instead of silently double-mixing assets', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          purchasedCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('10') },
            { packIndex: 1, memo: 'memo-1', status: 'purchased', packCost: solAmount('10') },
          ],
        },
      },
      buyback: {
        status: 'COMPLETE',
        evidence: {
          soldCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sold', signature: 'sig-0', proceeds: solAmount('40') },
            { packIndex: 1, memo: 'memo-1', mint: 'mint-1', decision: 'sold', signature: 'sig-1', proceeds: { chainId: 1, assetId: '0xforeign', decimals: 18, amountAtomic: '35' } },
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorBuybackProceeds, null);
});

test('collectorPurchaseDebit fails closed to null on a duplicate packIndex instead of double-counting it', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          purchasedCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('30') },
            { packIndex: 0, memo: 'memo-0-dup', status: 'purchased', packCost: solAmount('30') },
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorPurchaseDebit, null);
});

test('F8-sol-verification repro: quantity/purchasedCount claim 2 packs but only one pack entry is present -- fails closed, never a partial sum over the incomplete batch', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          purchasedCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('30') },
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorPurchaseDebit, null);
});

test('F8-sol-verification repro: soldCount claims a sale but buyback\'s own packs are fewer than the purchase batch actually produced -- fails closed on the missing predecessor coverage', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          purchasedCount: 2,
          packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('10') },
            { packIndex: 1, memo: 'memo-1', status: 'purchased', packCost: solAmount('10') },
          ],
        },
      },
      buyback: {
        status: 'COMPLETE',
        evidence: {
          soldCount: 1,
          packs: [
            { packIndex: 0, memo: 'memo-0', mint: 'mint-0', decision: 'sold', signature: 'sig-0', proceeds: solAmount('40') },
          ],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorBuybackProceeds, null);
});

test('F8-sol-verification repro: a new-shape purchase record (carries quantity/purchasedCount) missing its own packs array never falls back to a legacy top-level packCost', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: { quantity: 2, purchasedCount: 2, packCost: solAmount('30') },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorPurchaseDebit, null);
});

test('F8-sol-verification repro: a new-shape buyback record (carries soldCount) missing its own packs array never falls back to a legacy top-level proceeds', async () => {
  const repository = relayLegRepository({
    stages: {
      buyback: {
        status: 'COMPLETE',
        evidence: { soldCount: 1, proceeds: solAmount('40') },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorBuybackProceeds, null);
});

test('F8-sol-verification repro: a sold pack missing its own memo and mint never contributes proceeds -- canonical identity is required, not just amount presence', async () => {
  const repository = relayLegRepository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: { quantity: 1, purchasedCount: 1, packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', packCost: solAmount('10') }] },
      },
      buyback: {
        status: 'COMPLETE',
        evidence: { soldCount: 1, packs: [{ packIndex: 0, decision: 'sold', proceeds: solAmount('40') }] },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorBuybackProceeds, null);
});

// The configured USDG token address, standing in for `config.contracts.usdg` at composition time.
// Every "real" fixture in this file uses this exact assetId; a "foreign token" fixture deliberately
// uses a different one to prove the asset anchor is a trusted, external identity, never derived from
// the evidence itself. Real EVM-address-shaped (assertFinalizedPayoutTransferEvidence validates it
// with the same viem isAddress() check stages/payout.mjs's own assertAddress uses).
const EXPECTED_USDG_ASSET_ID = `0x${'a'.repeat(40)}`;
// Standing in for config.accounts.evm (the configured Operations sender) at composition time.
const OPERATIONS_ADDRESS = `0x${'1'.repeat(40)}`;
const RECIPIENT_A = `0x${'2'.repeat(40)}`;
const RECIPIENT_B = `0x${'3'.repeat(40)}`;

/** A fully producer-shaped `finalizedTransfer` object (all 16 fields
 * `stages/payout.mjs`'s own `normalizeFinalizedTransfer` requires), for the one fixture that must
 * still project as paid. */
function realFinalizedTransfer({ recipient, amountAtomic }) {
  return {
    from: OPERATIONS_ADDRESS, to: recipient,
    amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic },
    finalizedBlockNumber: '100', finalizedBlockHash: '0x' + 'b'.repeat(64),
    receiptBlockNumber: '99', receiptBlockHash: '0x' + 'c'.repeat(64),
    previousBlockNumber: '98', previousBlockHash: '0x' + 'd'.repeat(64),
    sourceBalanceBeforeAtomic: '1000', sourceBalanceAfterAtomic: String(1000 - Number(amountAtomic)), sourceBalanceDeltaAtomic: amountAtomic,
    recipientBalanceBeforeAtomic: '0', recipientBalanceAfterAtomic: amountAtomic, recipientBalanceDeltaAtomic: amountAtomic,
    logIndexes: ['0'],
  };
}

const trustedPayoutContext = Object.freeze({
  expectedUsdgAssetId: EXPECTED_USDG_ASSET_ID,
  operationsAddress: OPERATIONS_ADDRESS,
});

test('projectPayoutEvidence: without trustedPayoutContext, even a fully producer-shaped valid payout stays all-null/awaiting-verification', async () => {
  const repository = relayLegRepository({
    stages: {
      payout: {
        status: 'COMPLETE',
        evidence: {
          schema: 'hookemon.direct-payout-result.v1',
          cycleId: 'cycle-1',
          planDigest: 'sha256:' + 'a'.repeat(64),
          distributablePool: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          totalAllocated: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          dust: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '0' },
          recipients: [{
            recipient: RECIPIENT_A,
            amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
            state: 'FINALIZED',
            nonce: 1,
            transactionHash: '0x' + '1'.repeat(64),
            finalizedTransfer: realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '100' }),
            refusalEvidence: null,
          }],
          quarantine: [],
          heldPositionExclusions: [],
        },
      },
    },
  });
  // No trustedPayoutContext supplied - this projection has no immutable anchor for "which token is
  // USDG" and no finality-proof validator of its own, so it must never guess.
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('F6-sol-verification repro: a non-empty malformed hash plus an amount-only finalizedTransfer never reports paid, even with trustedPayoutContext supplied', async () => {
  const repository = relayLegRepository({
    stages: payoutEvidenceStages({
      recipients: [{
        recipient: RECIPIENT_A,
        amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
        state: 'FINALIZED',
        nonce: 1,
        transactionHash: 'not-a-transaction-hash',
        finalizedTransfer: { amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' } },
        refusalEvidence: null,
      }],
      quarantine: [],
    }),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(accounting.payoutLiabilityMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('F6-sol-verification repro: a fully shaped, internally consistent foreign chain-4663 six-decimal token never reports paid', async () => {
  const foreignAssetId = '0xforeigntoken';
  const repository = relayLegRepository({
    stages: {
      payout: {
        status: 'COMPLETE',
        evidence: {
          schema: 'hookemon.direct-payout-result.v1',
          cycleId: 'cycle-1',
          planDigest: 'sha256:' + 'a'.repeat(64),
          // Internally consistent (all three amounts agree, conservation holds) but NOT the
          // configured USDG token - the exact class of foreign-token repro F6 demonstrated.
          distributablePool: { chainId: 4663, assetId: foreignAssetId, decimals: 6, amountAtomic: '100' },
          totalAllocated: { chainId: 4663, assetId: foreignAssetId, decimals: 6, amountAtomic: '100' },
          dust: { chainId: 4663, assetId: foreignAssetId, decimals: 6, amountAtomic: '0' },
          recipients: [{
            recipient: RECIPIENT_A,
            amount: { chainId: 4663, assetId: foreignAssetId, decimals: 6, amountAtomic: '100' },
            state: 'FINALIZED',
            nonce: 1,
            transactionHash: '0x' + '1'.repeat(64),
            finalizedTransfer: {
              ...realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '100' }),
              amount: { chainId: 4663, assetId: foreignAssetId, decimals: 6, amountAtomic: '100' },
            },
            refusalEvidence: null,
          }],
          quarantine: [],
          heldPositionExclusions: [],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null, 'a fully-formed but foreign chain-4663/six-decimal token must never pass as USDG');
  assert.equal(accounting.plannedHolderRewardsMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('projectPayoutEvidence: a real finalized payout with a quarantined recipient reports paid-with-liabilities, not paid', async () => {
  const repository = relayLegRepository({
    stages: {
      payout: {
        status: 'COMPLETE',
        evidence: {
          schema: 'hookemon.direct-payout-result.v1',
          cycleId: 'cycle-1',
          planDigest: 'sha256:' + 'a'.repeat(64),
          distributablePool: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          totalAllocated: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          dust: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '0' },
          recipients: [
            {
              recipient: RECIPIENT_A,
              amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '70' },
              state: 'FINALIZED',
              nonce: 1,
              transactionHash: '0x' + '1'.repeat(64),
              finalizedTransfer: realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '70' }),
              refusalEvidence: null,
            },
            { recipient: RECIPIENT_B, amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '30' }, state: 'REFUSED', nonce: 2, transactionHash: null, finalizedTransfer: null, refusalEvidence: { reason: 'REFUSED' } },
          ],
          quarantine: [
            { recipient: RECIPIENT_B, amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '30' }, reason: 'REFUSED' },
          ],
          heldPositionExclusions: [],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.plannedHolderRewardsMicroUsdg, '100');
  assert.equal(accounting.paidHolderRewardsMicroUsdg, '70');
  assert.equal(accounting.payoutLiabilityMicroUsdg, '30');
  assert.equal(accounting.payoutDustMicroUsdg, '0');
  assert.equal(accounting.paidHolderRewardsRecipientCount, 1);
  assert.equal(accounting.holderRewardsStatus, 'paid-with-liabilities');
});

test('projectPayoutEvidence: every recipient finalized with zero liability reports paid', async () => {
  const repository = relayLegRepository({
    stages: {
      payout: {
        status: 'COMPLETE',
        evidence: {
          schema: 'hookemon.direct-payout-result.v1',
          cycleId: 'cycle-1',
          planDigest: 'sha256:' + 'a'.repeat(64),
          distributablePool: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          totalAllocated: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          dust: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '0' },
          recipients: [
            {
              recipient: RECIPIENT_A,
              amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
              state: 'FINALIZED',
              nonce: 1,
              transactionHash: '0x' + '1'.repeat(64),
              finalizedTransfer: realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '100' }),
              refusalEvidence: null,
            },
          ],
          quarantine: [],
          heldPositionExclusions: [],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, '100');
  assert.equal(accounting.payoutLiabilityMicroUsdg, '0');
  assert.equal(accounting.paidHolderRewardsRecipientCount, 1);
  assert.equal(accounting.holderRewardsStatus, 'paid');
});

test('projectPayoutEvidence fails closed to all-null when the payout evidence has an asset-inconsistent amount', async () => {
  const repository = relayLegRepository({
    stages: {
      payout: {
        status: 'COMPLETE',
        evidence: {
          schema: 'hookemon.direct-payout-result.v1',
          cycleId: 'cycle-1',
          planDigest: 'sha256:' + 'a'.repeat(64),
          distributablePool: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          totalAllocated: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
          dust: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '0' },
          recipients: [
            // Wrong asset for this recipient's amount - must fail closed, never silently sum it in.
            { recipient: RECIPIENT_A, amount: { chainId: 1, assetId: '0xother', decimals: 18, amountAtomic: '100' }, state: 'FINALIZED', nonce: 1, transactionHash: '0x' + '1'.repeat(64), finalizedTransfer: {}, refusalEvidence: null },
          ],
          quarantine: [],
          heldPositionExclusions: [],
        },
      },
    },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(accounting.plannedHolderRewardsMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

function payoutEvidenceStages({ recipients, quarantine = [], distributablePool = '100', totalAllocated = '100', dust = '0', cycleId = 'cycle-1' }) {
  const usdg = amount => ({ chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: amount });
  return {
    payout: {
      status: 'COMPLETE',
      evidence: {
        schema: 'hookemon.direct-payout-result.v1',
        cycleId,
        planDigest: 'sha256:' + 'a'.repeat(64),
        distributablePool: usdg(distributablePool),
        totalAllocated: usdg(totalAllocated),
        dust: usdg(dust),
        recipients,
        quarantine,
        heldPositionExclusions: [],
      },
    },
  };
}

test('F4-sol-verification repro: a FINALIZED label alone, without transactionHash/finalizedTransfer, is never reported as paid', async () => {
  const repository = relayLegRepository({
    stages: payoutEvidenceStages({
      recipients: [{
        recipient: RECIPIENT_A,
        amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
        state: 'FINALIZED',
        nonce: 1,
        transactionHash: null,
        finalizedTransfer: null,
        refusalEvidence: null,
      }],
      quarantine: [],
    }),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null, 'no fabricated paid amount from the FINALIZED label alone');
  assert.equal(accounting.payoutLiabilityMicroUsdg, null, 'no fabricated zero liability either');
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('projectPayoutEvidence fails closed when the evidence cycleId does not match the cycle actually being projected', async () => {
  const repository = relayLegRepository({
    stages: payoutEvidenceStages({
      cycleId: 'some-other-cycle',
      recipients: [{
        recipient: RECIPIENT_A,
        amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
        state: 'FINALIZED',
        nonce: 1,
        transactionHash: '0x' + '1'.repeat(64),
        finalizedTransfer: realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '100' }),
        refusalEvidence: null,
      }],
      quarantine: [],
    }),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('projectPayoutEvidence fails closed when a quarantine entry does not pair 1:1 with a non-paid recipient', async () => {
  const repository = relayLegRepository({
    stages: payoutEvidenceStages({
      recipients: [{
        recipient: RECIPIENT_A,
        amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
        state: 'FINALIZED',
        nonce: 1,
        transactionHash: '0x' + '1'.repeat(64),
        finalizedTransfer: realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '100' }),
        refusalEvidence: null,
      }],
      // A quarantine entry with no corresponding non-paid recipient - must never be summed in.
      quarantine: [{ recipient: RECIPIENT_B, amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '30' }, reason: 'REFUSED' }],
    }),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('projectPayoutEvidence fails closed when totalAllocated + dust does not conserve against distributablePool', async () => {
  const repository = relayLegRepository({
    stages: payoutEvidenceStages({
      distributablePool: '100',
      totalAllocated: '100',
      dust: '5', // 100 + 5 != 100 - inconsistent with the plan's own conservation invariant
      recipients: [{
        recipient: RECIPIENT_A,
        amount: { chainId: 4663, assetId: EXPECTED_USDG_ASSET_ID, decimals: 6, amountAtomic: '100' },
        state: 'FINALIZED',
        nonce: 1,
        transactionHash: '0x' + '1'.repeat(64),
        finalizedTransfer: realFinalizedTransfer({ recipient: RECIPIENT_A, amountAtomic: '100' }),
        refusalEvidence: null,
      }],
      quarantine: [],
    }),
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1', trustedPayoutContext });
  assert.equal(accounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'awaiting-verification');
});

test('collectorPurchaseDebit stays null while the purchase stage has not durably completed', async () => {
  const repository = relayLegRepository({
    stages: { purchase: { status: 'PENDING' } },
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId: 'cycle-1' });
  assert.equal(accounting.collectorPurchaseDebit, null);
});
