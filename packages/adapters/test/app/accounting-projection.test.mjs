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

test('a fresh cycle with no completed stages reports the honest all-zero/all-null shape', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });

  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.packSpendMicroUsdg, '0', 'nothing was spent before purchase completes');
  assert.equal(accounting.buybackMicroUsdg, '0');
  assert.equal(accounting.packGainMicroUsdg, '0');
  assert.equal(accounting.packLossMicroUsdg, '0');
  assert.equal(accounting.quotedCosts.outboundBridgeMicroUsdg, null);
  assert.equal(accounting.holderRewardsStatus, 'not-started');
  assert.equal(accounting.distributionStatus, 'not-started');
  // Every field the contract does not yet have real evidence for is null, never fabricated.
  assert.equal(accounting.protectedCostsMicroUsdg, null);
  assert.equal(accounting.confirmedCostsMicroUsdg, null);
  assert.equal(accounting.plannedHolderRewardsMicroUsdg, null);
});

test('packSpendMicroUsdg becomes the cycle release amount once purchase durably completes, and packLoss reflects it', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });
  await completeStageInOrder(repository, cycleId, 'purchase', { memo: 'memo-1', signature: 'sig-1' });

  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.packSpendMicroUsdg, '5000000');
  assert.equal(accounting.packLossMicroUsdg, '5000000', 'no buyback proceeds yet, so the full spend is currently a loss');
  assert.equal(accounting.packGainMicroUsdg, '0');
});

test('quotedCosts.outboundBridgeMicroUsdg is derived from the outbound stage evidence real quote amounts when present', async t => {
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
  assert.equal(accounting.quotedCosts.outboundBridgeMicroUsdg, '5000');
});

test('quotedCosts.outboundBridgeMicroUsdg stays null when the outbound evidence carries no real quote amounts (e.g. an injected test fake)', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });
  await completeStageInOrder(repository, cycleId, 'outbound', { wouldBridgeOutbound: true, configured: true, quote: { wouldExecute: true, requestId: 'req-1' } });

  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.quotedCosts.outboundBridgeMicroUsdg, null);
});

test('holderRewardsStatus/distributionStatus advance only as return/distribution/payout durably complete', async t => {
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

  await completeStageInOrder(repository, cycleId, 'payout', { seeded: true });
  accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.distributionStatus, 'settled');
  assert.equal(accounting.holderRewardsStatus, 'paid');
});

test('completed rehearsal payout evidence supplies the observed proceeds as buyback accounting', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });
  await completeStageInOrder(repository, cycleId, 'purchase', { signature: 'purchase-1' });
  await completeStageInOrder(repository, cycleId, 'payout', {
    signature: 'payout-1',
    proceedsMicroSolanaStable: '4995000',
  });
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.buybackMicroUsdg, '4995000');
  assert.equal(accounting.packGainMicroUsdg, '0');
  assert.equal(accounting.packLossMicroUsdg, '5000');
});

test('migrated historical rehearsal payout evidence preserves its atomic accounting totals', async t => {
  const repository = await openRepository(t);
  const { cycleId } = await repository.createCycle({ releaseAmount: '5000000', mode: 'production' });
  const migratedHistoricalEvidence = Object.freeze({
    signature: 'payout-1',
    proceedsMicroSolanaStable: '4995000',
  });
  await completeStageInOrder(repository, cycleId, 'purchase', { signature: 'purchase-1' });
  await completeStageInOrder(repository, cycleId, 'payout', migratedHistoricalEvidence);

  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.deepEqual(
    {
      buybackMicroUsdg: accounting.buybackMicroUsdg,
      packGainMicroUsdg: accounting.packGainMicroUsdg,
      packLossMicroUsdg: accounting.packLossMicroUsdg,
    },
    {
      buybackMicroUsdg: '4995000',
      packGainMicroUsdg: '0',
      packLossMicroUsdg: '5000',
    },
  );
  assert.match((await repository.describeCycle(cycleId)).journalHead, /^sha256:[0-9a-f]{64}$/);
});
