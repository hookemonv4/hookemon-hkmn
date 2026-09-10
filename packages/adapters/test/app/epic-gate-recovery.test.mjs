import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT } from '../../src/solana-rpc.mjs';
import { createPreparedProviderMutationAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { prepareEpicGateRequest } from '../../src/app/stages/epic-gate.mjs';
import { requestDigest } from '../../src/app/stages/request-digest.mjs';

const CHAIN_ID = 'solana-mainnet';
const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnV4A4m5tgebLHaRSZ9';
const CARD_ASSET = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const MEMO = 'memo-epic-gate-recovery';
const SETTLEMENT_ASSET = { chainId: CHAIN_ID, assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };

function epicGateConfig() {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_50' },
    solana: { chainId: CHAIN_ID },
    collectorCrypt: {
      settlementAsset: SETTLEMENT_ASSET,
      epicGate: {
        nftAddressField: 'nft_address',
        insuredValueField: 'insured_value',
        prizeTierField: 'prize_tier',
        rarityField: 'rarity',
        asset: SETTLEMENT_ASSET,
      },
    },
  };
}

function openedPack(overrides = {}) {
  return {
    packIndex: 0,
    memo: MEMO,
    decision: 'opened',
    signature: 'open-signature',
    mint: CARD_ASSET,
    assetKind: 'spl',
    ...overrides,
  };
}

function provider({ calls, failure = null, failureMemos = new Set() } = {}) {
  return {
    async getPackStatus({ memo }) {
      calls.push(['getPackStatus', memo]);
      if (failure || failureMemos.has(memo)) throw new Error(failure ?? 'collector unavailable');
      return {
        memo,
        pack: { pack_type: 'pokemon_50' },
        send: { nft_address: CARD_ASSET, prize_tier: 1, insured_value: 100 },
        buyback: [],
      };
    },
    async getNfts() {
      calls.push(['getNfts']);
      return {
        nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }],
        page: 1,
        limit: 50,
        hasMore: false,
      };
    },
    async getMachines() {
      calls.push(['getMachines']);
      return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] };
    },
    async getBuybackAvailable() {
      calls.push(['getBuybackAvailable']);
      return { available: true, amount: { ...SETTLEMENT_ASSET, amountAtomic: '85' } };
    },
  };
}

async function durableCycle(t, openPacks = [openedPack()]) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-epic-gate-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nowMs = 1_700_000_000_000;
  const repository = await CycleRepository.open(directory, () => nowMs, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const cycleId = await repository.nextCycleId();
  const admission = await nativeProducedAdmissionFixture(cycleId, {
    nowMs,
    purchaseAtoms: '40',
    costMicroUsd: '35000000',
  });
  admission.packId = 'pokemon_50';
  await repository.createCycle({ cycleId, releaseAmount: '42', mode: 'production', admission });
  const settlement = { ...SETTLEMENT_ASSET, amountAtomic: '40' };
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', {
      quantity: openPacks.length,
      packs: openPacks.map(pack => ({
        packIndex: pack.packIndex,
        memo: pack.memo,
        status: 'purchased',
        signature: 'purchase-signature',
        expectedCardCount: 1,
        packCost: settlement,
      })),
      purchasedCount: openPacks.length,
    }],
    ['open', { packs: openPacks }],
  ]) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, evidence);
  }
  return { repository, cycleId };
}

async function prepareAttempt(repository, cycleId, state = 'PREPARED') {
  const context = { cycleId, stage: 'epic-gate' };
  const request = await prepareEpicGateRequest({ cycleRepository: repository, context });
  await repository.prepareStageAttempt(cycleId, 'epic-gate', createPreparedProviderMutationAttempt({
    cycleId,
    stage: 'epic-gate',
    requestDigest: requestDigest(context, request),
  }));
  if (state === 'SENT_UNKNOWN') await repository.markStageAttemptSentUnknown(cycleId, 'epic-gate');
}

function stageDriver(repository, collectorCrypt) {
  const adapters = {
    collectorCrypt,
    solana: { client: null },
    relay: null,
    robinhood: { client: null },
  };
  return createStageDriver({
    liveMode: true,
    adapters,
    reconciliationAdapters: adapters,
    signerClient: null,
    config: epicGateConfig(),
    cycleRepository: repository,
  });
}

function repositoryProxy(repository, overrides) {
  return new Proxy(repository, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('recovers PREPARED and SENT_UNKNOWN attempts, reconciles them, and makes completed execute a no-op', async t => {
  for (const state of ['PREPARED', 'SENT_UNKNOWN']) {
    await t.test(state, async tCase => {
      const { repository, cycleId } = await durableCycle(tCase);
      await prepareAttempt(repository, cycleId, state);
      const calls = [];
      const driver = stageDriver(repository, provider({ calls }));

      await repository.prepareStage(cycleId, 'epic-gate');
      const evidence = await driver.reconcile({ cycleId, stage: 'epic-gate' });
      assert.equal(evidence.recovered.fromAttemptState, state);
      assert.equal(evidence.packs[0].decision, 'sell');
      assert.equal((await repository.readOperationalStageAttempt(cycleId, 'epic-gate')).attempt.state, 'RECONCILED');
      await repository.completeStage(cycleId, 'epic-gate', evidence);
      assert.equal((await repository.readStage(cycleId, 'epic-gate')).status, 'COMPLETE');
      await assert.doesNotReject(() => driver.execute({ cycleId, stage: 'epic-gate' }));
      const incomplete = repositoryProxy(repository, {
        async readStage(id, stageName) {
          if (id === cycleId && stageName === 'epic-gate') return { status: 'PENDING' };
          return repository.readStage(id, stageName);
        },
      });
      await assert.rejects(
        () => stageDriver(incomplete, provider({ calls: [] })).execute({ cycleId, stage: 'epic-gate' }),
        /already has a prepared or sent attempt and requires reconciliation/,
      );
      assert.deepEqual(new Set(calls.map(([method]) => method)), new Set([
        'getPackStatus',
        'getNfts',
        'getMachines',
        'getBuybackAvailable',
      ]));
    });
  }
});

test('fails closed when the durable epic-gate request no longer matches', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await prepareAttempt(repository, cycleId);
  const tampered = repositoryProxy(repository, {
    async readStage(id, stage) {
      const value = await repository.readStage(id, stage);
      if (stage !== 'open') return value;
      return {
        ...value,
        evidence: {
          ...value.evidence,
          packs: value.evidence.packs.map(pack => ({ ...pack, memo: 'tampered-memo' })),
        },
      };
    },
  });
  const calls = [];
  const driver = stageDriver(tampered, provider({ calls }));

  await assert.rejects(
    () => driver.reconcile({ cycleId, stage: 'epic-gate' }),
    /epic-gate durable request no longer matches the prepared attempt; operator review required/,
  );
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'epic-gate')).attempt.state, 'PREPARED');
  assert.deepEqual(calls, []);
});

test('holds a provider failure during recovery as HELD_DATA_UNVERIFIED', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await prepareAttempt(repository, cycleId);
  const calls = [];
  const driver = stageDriver(repository, provider({ calls, failure: 'collector unavailable' }));

  const evidence = await driver.reconcile({ cycleId, stage: 'epic-gate' });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'epic-gate')).attempt.state, 'RECONCILED');
  assert.deepEqual(calls, [['getPackStatus', MEMO]]);
  assert.equal((await repository.listHeldPositions({ cycleId, includeResolved: true })).length, 1);
});

test('recovery reuses a held position when the process dies after the held write', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await prepareAttempt(repository, cycleId);
  let failReconcile = true;
  const recoveringRepository = repositoryProxy(repository, {
    async reconcileStageAttempt(...args) {
      if (failReconcile) {
        failReconcile = false;
        throw new Error('simulated process death');
      }
      return repository.reconcileStageAttempt(...args);
    },
  });
  const calls = [];
  const driver = stageDriver(recoveringRepository, provider({ calls, failure: 'collector unavailable' }));

  await assert.rejects(
    () => driver.reconcile({ cycleId, stage: 'epic-gate' }),
    /simulated process death/,
  );
  const [first] = await repository.listHeldPositions({ cycleId, includeResolved: true });
  assert.equal(
    ['PREPARED', 'SENT_UNKNOWN'].includes((await repository.readOperationalStageAttempt(cycleId, 'epic-gate')).attempt.state),
    true,
  );

  const evidence = await driver.reconcile({ cycleId, stage: 'epic-gate' });
  assert.equal(evidence.packs[0].heldPosition.positionId, first.positionId);
  assert.equal((await repository.listHeldPositions({ cycleId, includeResolved: true })).length, 1);
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'epic-gate')).attempt.state, 'RECONCILED');
});

test('recovery gives a persisted held pack precedence over a healthy provider while gating later packs', async t => {
  const laterMemo = `${MEMO}-later`;
  const { repository, cycleId } = await durableCycle(t, [
    openedPack(),
    openedPack({ packIndex: 1, memo: laterMemo }),
  ]);
  await prepareAttempt(repository, cycleId);
  let failReconcile = true;
  const recoveringRepository = repositoryProxy(repository, {
    async reconcileStageAttempt(...args) {
      if (failReconcile) {
        failReconcile = false;
        throw new Error('simulated process death');
      }
      return repository.reconcileStageAttempt(...args);
    },
  });
  const calls = [];
  await assert.rejects(
    () => stageDriver(
      recoveringRepository,
      provider({ calls, failureMemos: new Set([MEMO]) }),
    ).reconcile({ cycleId, stage: 'epic-gate' }),
    /simulated process death/,
  );
  const [held] = await repository.listHeldPositions({ cycleId, includeResolved: true });

  const evidence = await stageDriver(repository, provider({ calls })).reconcile({
    cycleId,
    stage: 'epic-gate',
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].heldPosition.positionId, held.positionId);
  assert.equal(evidence.packs[0].heldPosition.evidenceDigest, held.evidenceDigest);
  assert.equal(evidence.packs[1].decision, 'sell');
  assert.equal(calls.filter(([method, memo]) => method === 'getPackStatus' && memo === MEMO).length, 1);
  assert.equal(calls.filter(([method, memo]) => method === 'getPackStatus' && memo === laterMemo).length, 2);
  assert.equal((await repository.listHeldPositions({ cycleId, includeResolved: true })).length, 1);
});

test('reconciliation gives a persisted held pack precedence over recorded sell evidence', async t => {
  const { repository, cycleId } = await durableCycle(t);
  const held = await repository.recordHeldPosition(cycleId, {
    packId: 'pokemon_50',
    memo: MEMO,
    mint: CARD_ASSET,
    cardRef: CARD_ASSET,
    costMicroUsd: '35000000',
    valueMicroUsd: '35000000',
    insuredValue: null,
    reason: 'DATA_UNVERIFIED',
    terminalState: 'HELD_DATA_UNVERIFIED',
    evidence: { stage: 'epic-gate', memo: MEMO, reason: 'provider outage' },
  });
  await prepareAttempt(repository, cycleId);
  await repository.prepareStage(cycleId, 'epic-gate');
  await repository.recordStageAttemptResponse(cycleId, 'epic-gate', {
    packs: [{ packIndex: 0, memo: MEMO, mint: CARD_ASSET, decision: 'sell' }],
  });
  const calls = [];
  const evidence = await stageDriver(repository, provider({ calls })).reconcile({
    cycleId,
    stage: 'epic-gate',
  });

  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].heldPosition.positionId, held.positionId);
  assert.equal(evidence.packs[0].heldPosition.evidenceDigest, held.evidenceDigest);
  assert.deepEqual(calls, []);
  assert.equal((await repository.listHeldPositions({ cycleId, includeResolved: true })).length, 1);
});

test('recovery passes through a held open pack without querying the provider', async t => {
  const held = openedPack({
    decision: 'held',
    terminalState: 'HELD_DATA_UNVERIFIED',
    reason: 'DATA_UNVERIFIED',
    heldPosition: {
      positionId: 'held:open:1',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      terminalState: 'HELD_DATA_UNVERIFIED',
      reason: 'DATA_UNVERIFIED',
    },
  });
  const { repository, cycleId } = await durableCycle(t, [held]);
  await prepareAttempt(repository, cycleId);
  const calls = [];
  const driver = stageDriver(repository, provider({ calls }));

  const evidence = await driver.reconcile({ cycleId, stage: 'epic-gate' });
  assert.deepEqual(evidence.packs, [held]);
  assert.deepEqual(calls, []);
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'epic-gate')).attempt.state, 'RECONCILED');
});

test('requestDigest remains identical to the stage-driver request schema', () => {
  const context = { cycleId: 'cycle-digest', stage: 'epic-gate' };
  const request = { provider: 'collector-crypt', operation: 'epic-gate', packs: [] };
  assert.equal(
    requestDigest(context, request),
    digest({ schema: 'hookemon.operational-stage-request.v1', ...context, request }),
  );
});
