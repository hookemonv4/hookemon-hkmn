import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  SOLANA_RELAY_CHAIN_ID,
  deriveAssociatedTokenAddress,
  createSolanaRpcClient,
} from '../../src/solana-rpc.mjs';
import { reconcileLiveOpen } from '../../src/app/stages/open.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  createPreparedProviderMutationAttempt,
  transitionProviderMutationAttempt,
} from '../../../runner/src/cycle/money-schemas.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { CycleJournal } from '../../../runner/src/cycle/journal.mjs';
import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';

const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const CARD_ASSET = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const OPEN_SIGNATURE = 'O4'.repeat(44);
const BASE_TIME = 1_700_000_000_000;

function config() {
  return {
    pack: { code: 'config-pack' },
    unresolvedCardDeadlineMinutes: 5,
  };
}

function packStatus(memo) {
  return {
    memo,
    pack: {},
    send: {
      nft_address: CARD_ASSET,
      transaction_signature: OPEN_SIGNATURE,
      to_wallet: OPERATOR,
    },
    buyback: [],
  };
}

function jsonRpc(result, id = 1) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function rpcClient({ throwOnSignatureStatus = false } = {}) {
  const tokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSignatureStatuses') {
        if (throwOnSignatureStatus) throw new Error('rpc signature status unavailable');
        return jsonRpc({ value: [{ err: null, confirmationStatus: 'finalized' }] }, body.id);
      }
      if (body.method === 'getTransaction') {
        return jsonRpc({
          transaction: { message: { accountKeys: [{ pubkey: tokenAccount }] } },
          meta: {
            preTokenBalances: [{
              accountIndex: 0,
              mint: CARD_ASSET,
              owner: OPERATOR,
              uiTokenAmount: { amount: '0', decimals: 0, uiAmountString: '0' },
            }],
            postTokenBalances: [{
              accountIndex: 0,
              mint: CARD_ASSET,
              owner: OPERATOR,
              uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' },
            }],
          },
        }, body.id);
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

async function openCycle(t, { memos = ['memo-1'], attemptState = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-open-outage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(
    directory,
    () => BASE_TIME,
    { testAuthority: createTestProfileMutationAuthority() },
  );
  const cycleId = await repository.nextCycleId();
  const admission = await nativeProducedAdmissionFixture(cycleId, {
    nowMs: BASE_TIME,
    purchaseAtoms: '40',
    costMicroUsd: '35000000',
  });
  admission.packId = 'pokemon_50';
  await repository.createCycle({ cycleId, releaseAmount: '42', mode: 'production', admission });

  const packs = memos.map((memo, packIndex) => ({
    packIndex,
    memo,
    status: 'purchased',
    signature: `P${packIndex + 1}`.repeat(44),
    expectedCardCount: 1,
    packCost: {
      chainId: SOLANA_RELAY_CHAIN_ID,
      assetId: CIRCLE_USD_MINT,
      decimals: CIRCLE_USD_DECIMALS,
      amountAtomic: '40',
    },
  }));
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'test' }],
    ['claim-process', { source: 'test' }],
    ['outbound', { source: 'test' }],
    ['purchase', { quantity: memos.length, packs, purchasedCount: memos.length }],
  ]) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, evidence);
  }
  await repository.recordPackBatchIntent(cycleId, 'purchase', {
    quantity: memos.length,
    packType: null,
    expectedCardCountPerPack: 1,
    playerAddress: OPERATOR,
  });
  await repository.recordPackBatchRequest(cycleId, 'purchase', memos.map((memo, packIndex) => ({
    packIndex,
    memo,
    expectedCardCount: 1,
    packType: 'pokemon_50',
  })));

  if (attemptState !== null) {
    const request = {
      provider: 'collector-crypt',
      operation: 'open',
      packs: memos.map((memo, packIndex) => ({ packIndex, memo, expectedCardCount: 1 })),
    };
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
    if (attemptState === 'SENT_UNKNOWN') {
      await repository.markStageAttemptSentUnknown(cycleId, 'open');
    } else if (attemptState === 'RESPONSE_RECORDED') {
      await repository.recordStageAttemptResponse(cycleId, 'open', {
        packs: memos.map((memo, packIndex) => ({
          packIndex,
          memo,
          opened: { success: true },
        })),
      });
    }
  }
  return { directory, repository, cycleId };
}

async function injectRawJournalEntry(directory, cycleId, kind, payload) {
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose(kind, payload);
  const transaction = store.begin(cycleId, {
    expectedVersion: stored.version,
    expectedJournalHead: stored.journalHead,
  });
  transaction.stageEvent(entry);
  await store.commit(transaction);
  return entry;
}

function openAdapters(getPackStatus, solana = rpcClient()) {
  return {
    collectorCrypt: { getPackStatus },
    solana: { client: solana },
  };
}

function captureHeldWrites(repository) {
  const writes = [];
  const recordHeldPosition = repository.recordHeldPosition.bind(repository);
  repository.recordHeldPosition = async (cycleId, input) => {
    writes.push({ cycleId, input });
    return recordHeldPosition(cycleId, input);
  };
  return writes;
}

async function heldPositions(repository, cycleId) {
  return repository.listHeldPositions({ cycleId, includeResolved: true });
}

test('SENT_UNKNOWN Collector outage remains pending before the deadline and holds after it', async t => {
  const { repository, cycleId } = await openCycle(t, { attemptState: 'SENT_UNKNOWN' });
  const writes = captureHeldWrites(repository);
  const getPackStatus = async () => { throw new Error('collector outage before deadline'); };

  const before = await reconcileLiveOpen({
    adapters: openAdapters(getPackStatus),
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME + 4 * 60_000 },
  });
  assert.equal(before, null);
  assert.deepEqual(await heldPositions(repository, cycleId), []);

  const after = await reconcileLiveOpen({
    adapters: openAdapters(async () => { throw new Error('collector outage after deadline'); }),
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME + 5 * 60_000 },
  });
  assert.equal(after.packs[0].decision, 'held');
  assert.equal(after.packs[0].terminalState, 'HELD_UNRESOLVED');
  assert.equal(after.packs[0].reason, 'SENT_UNKNOWN_DEADLINE');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.evidence.failure.kind, 'pack-status');
  assert.equal(writes[0].input.evidence.failure.message, 'collector outage after deadline');
  const positions = await heldPositions(repository, cycleId);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].terminalState, 'HELD_UNRESOLVED');
});

test('a pending first pack does not prevent later packs from being inspected', async t => {
  const { repository, cycleId } = await openCycle(t, {
    memos: ['memo-1', 'memo-2'],
    attemptState: 'SENT_UNKNOWN',
  });
  const inspected = [];
  const getPackStatus = async ({ memo }) => {
    inspected.push(memo);
    if (memo === 'memo-1') throw new Error('first pack unavailable');
    return packStatus(memo);
  };

  const before = await reconcileLiveOpen({
    adapters: openAdapters(getPackStatus),
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME + 4 * 60_000 },
  });
  assert.equal(before, null);
  assert.deepEqual(inspected, ['memo-1', 'memo-2']);
  assert.deepEqual(await heldPositions(repository, cycleId), []);

  inspected.length = 0;
  const after = await reconcileLiveOpen({
    adapters: openAdapters(async ({ memo }) => {
      inspected.push(memo);
      if (memo === 'memo-1') throw new Error('first pack still unavailable');
      return packStatus(memo);
    }),
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME + 5 * 60_000 },
  });
  assert.deepEqual(inspected, ['memo-1', 'memo-2']);
  assert.equal(after.packs.length, 2);
  assert.equal(after.packs[0].decision, 'held');
  assert.equal(after.packs[1].decision, 'opened');
  assert.equal((await heldPositions(repository, cycleId)).length, 1);
});

test('RESPONSE_RECORDED signature-status outage holds data as unverified after its response deadline', async t => {
  const { repository, cycleId } = await openCycle(t, { attemptState: 'RESPONSE_RECORDED' });
  const writes = captureHeldWrites(repository);
  const record = await repository.readOperationalStageAttempt(cycleId, 'open');
  assert.equal(record.respondedAtMs, BASE_TIME);

  const result = await reconcileLiveOpen({
    adapters: openAdapters(async () => packStatus('memo-1'), rpcClient({ throwOnSignatureStatus: true })),
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME + 5 * 60_000 },
  });
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(result.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(result.packs[0].reason, 'DATA_UNVERIFIED');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.evidence.failure.kind, 'signature-status');
  const positions = await heldPositions(repository, cycleId);
  assert.equal(positions[0].terminalState, 'HELD_DATA_UNVERIFIED');
});

test('legacy timestamp-less RESPONSE_RECORDED outage anchors once instead of never reaching the deadline', async t => {
  const { directory, cycleId } = await openCycle(t, { attemptState: null, memos: ['memo-1', 'memo-2'] });
  let repository = await CycleRepository.open(directory, () => BASE_TIME, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const request = {
    provider: 'collector-crypt',
    operation: 'open',
    packs: [
      { packIndex: 0, memo: 'memo-1', expectedCardCount: 1 },
      { packIndex: 1, memo: 'memo-2', expectedCardCount: 1 },
    ],
  };
  const prepared = createPreparedProviderMutationAttempt({
    cycleId,
    stage: 'open',
    requestDigest: digest({
      schema: 'hookemon.operational-stage-request.v1',
      cycleId,
      stage: 'open',
      request,
    }),
  });
  await repository.prepareStageAttempt(cycleId, 'open', prepared);
  const evidence = {
    packs: [],
  };
  const responseDigest = digest({
    domain: 'hookemon.provider-mutation-response.v1',
    cycleId,
    stage: 'open',
    evidence,
  });
  await injectRawJournalEntry(directory, cycleId, 'stage-attempt-response-recorded', {
    stage: 'open',
    attempt: transitionProviderMutationAttempt(prepared, 'RESPONSE_RECORDED', { responseDigest }),
    evidence,
  });
  repository = await CycleRepository.open(directory, () => BASE_TIME, {
    testAuthority: createTestProfileMutationAuthority(),
  });

  const writes = captureHeldWrites(repository);
  const inspected = [];
  const failingAdapters = openAdapters(async ({ memo }) => {
    inspected.push(memo);
    throw new Error('legacy provider outage');
  });
  const first = await reconcileLiveOpen({
    adapters: failingAdapters,
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME },
  });
  assert.equal(first, null);
  assert.deepEqual(inspected, ['memo-1', 'memo-2']);
  assert.equal(writes.length, 0);
  let stored = (await DurableCycleStore.open(directory)).readCycle(cycleId);
  assert.equal(stored.entries.filter(entry => entry.kind === 'stage-attempt-deadline-anchored').length, 1);
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'open')).deadlineAnchorMs, BASE_TIME);

  inspected.length = 0;
  const second = await reconcileLiveOpen({
    adapters: failingAdapters,
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME },
  });
  assert.equal(second, null);
  assert.deepEqual(inspected, ['memo-1', 'memo-2']);
  stored = (await DurableCycleStore.open(directory)).readCycle(cycleId);
  assert.equal(stored.entries.filter(entry => entry.kind === 'stage-attempt-deadline-anchored').length, 1);

  inspected.length = 0;
  const third = await reconcileLiveOpen({
    adapters: failingAdapters,
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME + 5 * 60_000 },
  });
  assert.equal(third.packs.length, 2);
  assert.deepEqual(inspected, ['memo-1', 'memo-2']);
  assert.equal(third.packs[0].decision, 'held');
  assert.equal(third.packs[0].reason, 'DATA_UNVERIFIED');
  assert.equal(writes.length, 2);

  const reopened = await CycleRepository.open(directory, () => BASE_TIME);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'open')).deadlineAnchorMs, BASE_TIME);
});

test('legacy RESPONSE_RECORDED reached from SENT_UNKNOWN uses sentAtMs without anchoring', async t => {
  const { directory, cycleId } = await openCycle(t, { attemptState: 'SENT_UNKNOWN' });
  let repository = await CycleRepository.open(directory, () => BASE_TIME, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const current = await repository.readOperationalStageAttempt(cycleId, 'open');
  const evidence = {
    packs: [{ packIndex: 0, memo: 'memo-1', opened: { success: true } }],
  };
  const responseDigest = digest({
    domain: 'hookemon.provider-mutation-response.v1',
    cycleId,
    stage: 'open',
    evidence,
  });
  await injectRawJournalEntry(directory, cycleId, 'stage-attempt-response-recorded', {
    stage: 'open',
    attempt: transitionProviderMutationAttempt(current.attempt, 'RESPONSE_RECORDED', { responseDigest }),
    evidence,
  });
  repository = await CycleRepository.open(directory, () => BASE_TIME, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const record = await repository.readOperationalStageAttempt(cycleId, 'open');
  assert.equal(record.respondedAtMs, null);
  assert.equal(record.sentAtMs, BASE_TIME);
  assert.equal(record.deadlineAnchorMs, null);

  await reconcileLiveOpen({
    adapters: openAdapters(async () => { throw new Error('provider outage'); }),
    config: config(),
    cycleRepository: repository,
    context: { cycleId, nowMs: BASE_TIME },
  });
  const stored = (await DurableCycleStore.open(directory)).readCycle(cycleId);
  assert.equal(stored.entries.filter(entry => entry.kind === 'stage-attempt-deadline-anchored').length, 0);
});

test('repeated deadline holds reuse the same position despite changed failure messages', async t => {
  const { repository, cycleId } = await openCycle(t, { attemptState: 'SENT_UNKNOWN' });
  const context = { cycleId, nowMs: BASE_TIME + 5 * 60_000 };

  const first = await reconcileLiveOpen({
    adapters: openAdapters(async () => { throw new Error('first outage message'); }),
    config: config(),
    cycleRepository: repository,
    context,
  });
  const firstPositionId = first.packs[0].heldPosition.positionId;
  const second = await reconcileLiveOpen({
    adapters: openAdapters(async () => { throw new Error('different outage message'); }),
    config: config(),
    cycleRepository: repository,
    context,
  });
  assert.equal(second.packs[0].heldPosition.positionId, firstPositionId);
  assert.equal((await heldPositions(repository, cycleId)).length, 1);
});

test('clean open reconciliation still returns an opened pack', async t => {
  const { repository, cycleId } = await openCycle(t);
  const result = await reconcileLiveOpen({
    adapters: openAdapters(async () => packStatus('memo-1')),
    config: config(),
    cycleRepository: repository,
    context: { cycleId },
  });
  assert.equal(result.packs[0].decision, 'opened');
  assert.equal(result.packs[0].mint, CARD_ASSET);
});
