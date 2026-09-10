import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  deriveAssociatedTokenAddress,
  createSolanaRpcClient,
  MPL_CORE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../../src/solana-rpc.mjs';
import { createPreparedProviderMutationAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { CycleJournal, digest } from '../../../runner/src/cycle/journal.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { recoverHeldCardIdentity } from '../../src/app/stages/held-identity.mjs';
import { reconcileLiveOpen } from '../../src/app/stages/open.mjs';
import { createSupplementaryBuybackHandler } from '../../src/app/stages/supplementary-buyback.mjs';

const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const CARD_MINT = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const MEMO = 'memo-held-identity';
const OPEN_SIGNATURE = 'open-signature-held-identity';

async function repositoryWithHeld(t, { mint = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-held-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const cycleId = await repository.nextCycleId();
  const admission = await nativeProducedAdmissionFixture(cycleId, { costMicroUsd: '80' });
  admission.packId = 'pokemon_50';
  await repository.createCycle({ cycleId, admission, releaseAmount: '42', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pokemon_50',
    memo: MEMO,
    mint,
    cardRef: mint ?? MEMO,
    costMicroUsd: '80',
    valueMicroUsd: '80',
    insuredValue: null,
    reason: 'DATA_UNVERIFIED',
    terminalState: 'HELD_DATA_UNVERIFIED',
    evidence: { stage: 'open', memo: MEMO },
  });
  return { directory, repository, cycleId, position };
}

function rpcClient({ assetKind = 'spl', signatureStatus = 'finalized' } = {}) {
  const cardAta = deriveAssociatedTokenAddress(OPERATOR, CARD_MINT).toBase58();
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getTransaction') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              transaction: { message: {
                accountKeys: [{ pubkey: cardAta }],
                ...(assetKind === 'mpl-core'
                  ? {
                    instructions: [{
                      programId: MPL_CORE_PROGRAM_ID,
                      accounts: [CARD_MINT],
                      data: bs58.encode(Uint8Array.of(14)),
                    }],
                  }
                  : {}),
              } },
              meta: {
                preTokenBalances: assetKind === 'spl' ? [{
                  accountIndex: 0,
                  mint: CARD_MINT,
                  owner: OPERATOR,
                  uiTokenAmount: { amount: '0', decimals: 0 },
                }] : [],
                postTokenBalances: assetKind === 'spl' ? [{
                  accountIndex: 0,
                  mint: CARD_MINT,
                  owner: OPERATOR,
                  uiTokenAmount: { amount: '1', decimals: 0 },
                }] : [],
              },
            },
          }),
        };
      }
      if (body.method === 'getAccountInfo') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              value: assetKind === 'mpl-core'
                ? {
                  owner: MPL_CORE_PROGRAM_ID,
                  data: [
                    Buffer.concat([Buffer.from([1]), Buffer.from(new PublicKey(OPERATOR).toBytes())]).toString('base64'),
                    'base64',
                  ],
                }
                : {
                  owner: TOKEN_PROGRAM_ID,
                  data: {
                    program: 'spl-token',
                    parsed: {
                      type: 'account',
                      info: {
                        owner: OPERATOR,
                        mint: CARD_MINT,
                        tokenAmount: { amount: '1', decimals: 0 },
                      },
                    },
                  },
                },
            },
          }),
        };
      }
      if (body.method === 'getSignatureStatuses') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              value: [signatureStatus === 'pending'
                ? null
                : { slot: 1, confirmations: null, confirmationStatus: 'finalized', err: signatureStatus === 'error' ? { code: 1 } : null }],
            },
          }),
        };
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

function recoveryPosition(position) {
  return {
    ...position,
    identity: null,
  };
}

function recoveryRepository(position, {
  statusMint = CARD_MINT,
  signature = OPEN_SIGNATURE,
  packOverrides = {},
  playerAddress = OPERATOR,
} = {}) {
  let recorded = null;
  return {
    recorded: () => recorded,
    async readStage() {
      return {
        status: 'COMPLETE',
        evidence: { packs: [{ memo: position.memo, ...(signature === null ? {} : { signature }), assetKind: 'spl', ...packOverrides }] },
      };
    },
    async readPackBatchIntent() {
      return { intent: { playerAddress } };
    },
    async recordHeldPositionIdentity(positionId, input) {
      recorded = { positionId, input };
      return {
        ...position,
        identity: {
          mint: input.mint,
          verifiedAtMs: 1_700_000_000_001,
          evidenceDigest: `sha256:${'b'.repeat(64)}`,
          provenance: input.provenance,
        },
      };
    },
    statusMint,
  };
}

function recoveryAdapters({ mint = CARD_MINT, send = {}, assetKind = 'spl', signatureStatus = 'finalized' } = {}) {
  return {
    solana: { client: rpcClient({ assetKind, signatureStatus }) },
    collectorCrypt: {
      async getPackStatus({ memo }) {
        return { memo, send: { nft_address: mint, ...send } };
      },
    },
  };
}

test('repository records and replays verified identity without changing immutable position fields', async t => {
  const { directory, repository, cycleId, position } = await repositoryWithHeld(t);
  const identity = await repository.recordHeldPositionIdentity(position.positionId, {
    mint: CARD_MINT,
    provenance: {
      memo: MEMO,
      openSignature: OPEN_SIGNATURE,
      packStatusMint: CARD_MINT,
      derivedMint: CARD_MINT,
      custodyOwner: OPERATOR,
      openSignatureSource: 'open-evidence',
      assetKind: 'spl',
    },
    evidence: { source: 'test' },
  });
  assert.equal(identity.positionId, position.positionId);
  assert.equal(identity.mint, null);
  assert.equal(identity.cardRef, position.cardRef);
  assert.equal(identity.positionRevision, position.positionRevision);
  assert.equal(identity.identity.mint, CARD_MINT);
  assert.deepEqual((await repository.listHeldPositions({ cycleId }))[0], identity);

  const replayed = await CycleRepository.open(directory, () => 1_700_000_000_002, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  assert.deepEqual(await replayed.readHeldPosition(position.positionId), identity);
});

for (const terminalState of ['HELD_DATA_UNVERIFIED', 'COMPLETED']) {
  test(`held identity recovery survives ${terminalState} and restart`, async t => {
    const { directory, repository, cycleId, position } = await repositoryWithHeld(t);
    if (terminalState === 'COMPLETED') {
      for (const stage of OPERATIONAL_CYCLE_STAGES) {
        await repository.prepareStage(cycleId, stage);
        await repository.completeStage(cycleId, stage, { stage, finalized: true });
      }
      await repository.completeCycle(cycleId);
    } else {
      await repository.holdCycle(cycleId, terminalState, { reason: 'provider unavailable' });
    }
    const before = await repository.describeCycle(cycleId);
    const input = {
      mint: CARD_MINT,
      provenance: {
        memo: MEMO, openSignature: OPEN_SIGNATURE, packStatusMint: CARD_MINT,
        derivedMint: CARD_MINT, custodyOwner: OPERATOR,
        openSignatureSource: 'open-evidence', assetKind: 'spl',
      },
      evidence: { source: 'finalized recovery' },
    };
    const recovered = await repository.recordHeldPositionIdentity(position.positionId, input);
    const reopened = await CycleRepository.open(directory, () => 1_700_000_000_002, {
      testAuthority: createTestProfileMutationAuthority(),
    });
    assert.deepEqual(await reopened.readHeldPosition(position.positionId), recovered);
    assert.deepEqual(await reopened.recordHeldPositionIdentity(position.positionId, input), recovered);
    assert.equal(recovered.mint, null);
    assert.equal(recovered.evidenceDigest, position.evidenceDigest);
    assert.equal(recovered.positionRevision, position.positionRevision);
    const after = await reopened.describeCycle(cycleId);
    assert.equal(after.terminalState, before.terminalState);
    assert.equal(after.terminalAtMs, before.terminalAtMs);
    assert.equal(after.completed, before.completed);
    await assert.rejects(() => reopened.prepareStage(cycleId, 'open'), /cycle is terminal/);
    await assert.rejects(() => reopened.recordHeldPositionIdentity(position.positionId, {
      ...input, mint: 'conflicting-mint',
    }), /conflicts with a previously verified identity/);
  });
}

test('repository identity recording is idempotent and rejects invalid transitions', async t => {
  const first = await repositoryWithHeld(t);
  const provenance = {
    memo: MEMO,
    openSignature: OPEN_SIGNATURE,
    packStatusMint: CARD_MINT,
    derivedMint: CARD_MINT,
    custodyOwner: OPERATOR,
    openSignatureSource: 'open-evidence',
    assetKind: 'spl',
  };
  const input = { mint: CARD_MINT, provenance, evidence: { source: 'test' } };
  const recorded = await first.repository.recordHeldPositionIdentity(first.position.positionId, input);
  assert.deepEqual(await first.repository.recordHeldPositionIdentity(first.position.positionId, { ...input, evidence: { changed: true } }), recorded);
  await assert.rejects(
    () => first.repository.recordHeldPositionIdentity(first.position.positionId, { ...input, mint: `${CARD_MINT.slice(0, -1)}A`, provenance: { ...provenance, packStatusMint: `${CARD_MINT.slice(0, -1)}A`, derivedMint: `${CARD_MINT.slice(0, -1)}A` } }),
    /held position identity conflicts with a previously verified identity/,
  );

  const nonNull = await repositoryWithHeld(t, { mint: CARD_MINT });
  await assert.rejects(() => nonNull.repository.recordHeldPositionIdentity(nonNull.position.positionId, input), /already has an immutable mint/);
  const resolved = await repositoryWithHeld(t);
  await resolved.repository.resolveHeldPosition(resolved.position.positionId, {
    heldEvidenceDigest: resolved.position.evidenceDigest,
    expectedRevision: 0,
    terminalState: 'NEVER_SENT',
    evidence: { source: 'test' },
  });
  await assert.rejects(() => resolved.repository.recordHeldPositionIdentity(resolved.position.positionId, input), /already resolved/);
});

test('repository replays legacy held identity provenance without the current source fields', async t => {
  const { directory, repository, cycleId, position } = await repositoryWithHeld(t);
  const provenance = {
    memo: MEMO,
    openSignature: OPEN_SIGNATURE,
    packStatusMint: CARD_MINT,
    derivedMint: CARD_MINT,
    custodyOwner: OPERATOR,
  };
  const identity = {
    mint: CARD_MINT,
    verifiedAtMs: 1_700_000_000_001,
    evidenceDigest: digest({
      schema: 'hookemon.held-position-identity.v1',
      positionId: position.positionId,
      positionEvidenceDigest: position.evidenceDigest,
      mint: CARD_MINT,
      provenance,
    }),
    provenance,
  };
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose('held-position-identity-verified', {
    positionId: position.positionId,
    identity,
    evidence: { source: 'legacy-test' },
  });
  const transaction = store.begin(cycleId, {
    expectedVersion: stored.version,
    expectedJournalHead: stored.journalHead,
  });
  transaction.stageEvent(entry);
  await store.commit(transaction);

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_002, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  assert.deepEqual((await reopened.readHeldPosition(position.positionId)).identity.provenance, provenance);
  assert.equal(repository !== reopened, true);
});

test('recovery derives and records a verified identity from read-only evidence', async t => {
  const { position } = await repositoryWithHeld(t);
  const cycleRepository = recoveryRepository(recoveryPosition(position));
  const recovered = await recoverHeldCardIdentity({
    adapters: recoveryAdapters(),
    config: { accounts: { solana: OPERATOR }, collectorCrypt: { epicGate: { nftAddressField: 'nft_address' } } },
    cycleRepository,
    position: recoveryPosition(position),
  });
  assert.equal(recovered.identity.mint, CARD_MINT);
  assert.equal(cycleRepository.recorded().input.provenance.openSignature, OPEN_SIGNATURE);
});

test('recovery uses finalized Collector send evidence and preserves the transaction asset kind', async t => {
  const { position } = await repositoryWithHeld(t);
  const cycleRepository = recoveryRepository(recoveryPosition(position), {
    signature: null,
    packOverrides: { candidateMints: [CARD_MINT] },
  });
  const recovered = await recoverHeldCardIdentity({
    adapters: recoveryAdapters({
      assetKind: 'mpl-core',
      send: { transaction_signature: 'collector-finalized-open', to_wallet: OPERATOR },
    }),
    config: { accounts: { solana: OPERATOR }, collectorCrypt: { epicGate: { nftAddressField: 'nft_address' } } },
    cycleRepository,
    position: recoveryPosition(position),
  });
  assert.equal(recovered.identity.provenance.openSignatureSource, 'collector-finalized-send');
  assert.equal(recovered.identity.provenance.assetKind, 'mpl-core');
  assert.equal(cycleRepository.recorded().input.evidence.playerAddress, OPERATOR);
  assert.equal(cycleRepository.recorded().input.evidence.signatureStatus.err, null);
});

test('a real open hold with no signature recovers from a later finalized Collector send', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-held-identity-open-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const cycleId = await repository.nextCycleId();
  const admission = await nativeProducedAdmissionFixture(cycleId, { costMicroUsd: '80' });
  admission.packId = 'pokemon_50';
  await repository.createCycle({ cycleId, admission, releaseAmount: '42', mode: 'production' });
  await repository.recordPackBatchIntent(cycleId, 'purchase', {
    quantity: 1, packType: 'pokemon_50', expectedCardCountPerPack: 1, playerAddress: OPERATOR,
  });
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'test' }],
    ['claim-process', { source: 'test' }],
    ['outbound', { source: 'test' }],
    ['purchase', {
      quantity: 1,
      packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', signature: 'purchase-signature', expectedCardCount: 1, packCost: { chainId: 'solana-mainnet', assetId: 'stablecoin', decimals: 6, amountAtomic: '80' } }],
      purchasedCount: 1,
    }],
  ]) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, evidence);
  }
  await repository.prepareStage(cycleId, 'open');
  const request = { provider: 'collector-crypt', operation: 'open', packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1 }] };
  await repository.prepareStageAttempt(cycleId, 'open', createPreparedProviderMutationAttempt({
    cycleId,
    stage: 'open',
    requestDigest: digest({ schema: 'hookemon.operational-stage-request.v1', cycleId, stage: 'open', request }),
  }));
  await repository.recordStageAttemptResponse(cycleId, 'open', { packs: [{ packIndex: 0, memo: MEMO }] });
  const held = await reconcileLiveOpen({
    adapters: {
      collectorCrypt: { async getPackStatus() { return { memo: MEMO, send: null }; } },
      solana: { client: rpcClient() },
    },
    config: { accounts: { solana: OPERATOR }, unresolvedCardDeadlineMinutes: 30 },
    cycleRepository: repository,
    context: { cycleId, nowMs: 1_700_000_000_000 },
  });
  assert.equal(held.packs[0].mint, null);
  assert.equal((await repository.readHeldPositionEvidence((await repository.listHeldPositions({ cycleId }))[0].positionId)).signature, undefined);
  await repository.reconcileStageAttempt(cycleId, 'open', held);
  await repository.completeStage(cycleId, 'open', held);

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_000, {
    testAuthority: createTestProfileMutationAuthority(),
  });
  const position = (await reopened.listHeldPositions({ cycleId }))[0];
  const recovered = await recoverHeldCardIdentity({
    adapters: recoveryAdapters({
      assetKind: 'mpl-core',
      send: { transaction_signature: 'collector-finalized-open', to_wallet: OPERATOR },
    }),
    config: { accounts: { solana: OPERATOR } },
    cycleRepository: reopened,
    position,
  });
  assert.equal(recovered.identity.provenance.openSignatureSource, 'collector-finalized-send');
  assert.equal(recovered.identity.provenance.assetKind, 'mpl-core');
  assert.equal((await reopened.readHeldPosition(position.positionId)).identity.provenance.assetKind, 'mpl-core');
});

test('recovery prefers held-position signature evidence over open-stage and Collector signatures', async t => {
  const { position } = await repositoryWithHeld(t);
  const held = recoveryPosition({ ...position, evidence: { signature: OPEN_SIGNATURE, candidateMints: [CARD_MINT] } });
  const cycleRepository = recoveryRepository(held, { signature: null });
  const recovered = await recoverHeldCardIdentity({
    adapters: recoveryAdapters({ send: { transaction_signature: 'collector-signature', to_wallet: OPERATOR } }),
    config: { accounts: { solana: OPERATOR } },
    cycleRepository,
    position: held,
  });
  assert.equal(recovered.identity.provenance.openSignatureSource, 'held-evidence');
  assert.equal(recovered.identity.provenance.openSignature, OPEN_SIGNATURE);
});

test('recovery refuses Collector sends that are not bound to durable finalized evidence', async t => {
  const { position } = await repositoryWithHeld(t);
  const base = recoveryPosition(position);
  for (const [name, options, expected] of [
    ['wrong destination', { send: { transaction_signature: 'collector-open', to_wallet: 'wrong-player' } }, /destination does not match/],
    ['unfinalized', { send: { transaction_signature: 'collector-open', to_wallet: OPERATOR }, signatureStatus: 'pending' }, /successful finalized Collector send/],
    ['errored', { send: { transaction_signature: 'collector-open', to_wallet: OPERATOR }, signatureStatus: 'error' }, /successful finalized Collector send/],
    ['candidate mismatch', { send: { transaction_signature: 'collector-open', to_wallet: OPERATOR }, assetKind: 'spl' }, /candidate mints/],
  ]) {
    const candidatePosition = name === 'candidate mismatch'
      ? { ...base, evidence: { candidateMints: ['11111111111111111111111111111111'] } }
      : base;
    const cycleRepository = recoveryRepository(candidatePosition, { signature: null });
    await assert.rejects(
      () => recoverHeldCardIdentity({
        adapters: recoveryAdapters(options),
        config: { accounts: { solana: OPERATOR } },
        cycleRepository,
        position: candidatePosition,
      }),
      expected,
      name,
    );
    assert.equal(cycleRepository.recorded(), null, name);
  }
});

test('recovery refuses missing signatures, conflicting mints, and custody mismatch without recording', async t => {
  const { position } = await repositoryWithHeld(t);
  const noSignature = recoveryRepository(recoveryPosition(position), { signature: '' });
  await assert.rejects(
    () => recoverHeldCardIdentity({ adapters: recoveryAdapters(), config: { accounts: { solana: OPERATOR } }, cycleRepository: noSignature, position: recoveryPosition(position) }),
    /held card identity recovery requires a finalized Collector send signature/,
  );
  assert.equal(noSignature.recorded(), null);

  const conflict = recoveryRepository(recoveryPosition(position), { statusMint: '11111111111111111111111111111111' });
  const conflictAdapters = recoveryAdapters({ mint: '11111111111111111111111111111111' });
  await assert.rejects(
    () => recoverHeldCardIdentity({ adapters: conflictAdapters, config: { accounts: { solana: OPERATOR } }, cycleRepository: conflict, position: recoveryPosition(position) }),
    /conflicting Collector and transaction card mints/,
  );
  assert.equal(conflict.recorded(), null);

  const custody = recoveryRepository(recoveryPosition(position));
  const badAdapters = recoveryAdapters();
  badAdapters.solana.client = createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getTransaction') {
        const healthy = await rpcClient().fetchImpl(_url, init);
        return healthy;
      }
      if (body.method === 'getSignatureStatuses') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { value: [{ slot: 1, confirmations: null, confirmationStatus: 'finalized', err: null }] },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { value: null } }),
      };
    },
  });
  await assert.rejects(
    () => recoverHeldCardIdentity({ adapters: badAdapters, config: { accounts: { solana: OPERATOR } }, cycleRepository: custody, position: recoveryPosition(position) }),
    /positive finalized card balance/,
  );
  assert.equal(custody.recorded(), null);
});

test('supplementary buyback entry recovers null-mint identity before its resale guards', async t => {
  const { repository, cycleId, position } = await repositoryWithHeld(t);
  const decided = {
    ...position,
    ownerDecision: {
      positionId: position.positionId,
      heldEvidenceDigest: position.evidenceDigest,
      requestId: 'owner-request-held-identity',
      expectedRevision: 0,
      choice: 'sell',
    },
    positionRevision: 1,
  };
  let recoveryCalls = 0;
  let signerCalls = 0;
  const recovery = recoveryRepository(decided);
  const cycleRepository = {
    ...recovery,
    async recordHeldPositionIdentity(positionId, input) {
      recoveryCalls += 1;
      return recovery.recordHeldPositionIdentity(positionId, input);
    },
  };
  const handler = createSupplementaryBuybackHandler();
  await assert.rejects(
    () => handler.reconcile({
      adapters: recoveryAdapters(),
      signerClient: { solana: { async sign() { signerCalls += 1; } } },
      config: { accounts: { solana: OPERATOR }, collectorCrypt: { epicGate: { nftAddressField: 'nft_address' } } },
      cycleRepository,
      context: {},
      position: decided,
      settlement: { state: 'PREPARED' },
    }),
    /cycleRepository\.readSupplementaryChainTransactionAttempt/,
  );
  assert.equal(recoveryCalls, 1);
  assert.equal(signerCalls, 0);
});
