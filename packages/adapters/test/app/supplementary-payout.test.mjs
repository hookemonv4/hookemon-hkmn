import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import {
  assertSupplementaryPayoutManifestUnchanged,
  createSupplementaryPayoutStore,
  prepareSupplementaryPayoutRequest,
  supplementaryPayoutStageId,
} from '../../src/app/stages/supplementary-payout.mjs';
import {
  advanceDirectPayout,
  createDirectPayoutState,
  initializeDirectPayout,
  isDirectPayoutComplete,
} from '../../src/app/stages/payout.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const OPERATIONS = `0x${'b'.repeat(40)}`;
const RECIPIENT_A = `0x${'c'.repeat(40)}`;
const RECIPIENT_B = `0x${'d'.repeat(40)}`;
const POSITION_ID = `held:${'e'.repeat(64)}`;
const POSITION_EVIDENCE_DIGEST = `sha256:${'f'.repeat(64)}`;
const PAYOUT_ACCOUNT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const PAYOUT_OPERATIONS = PAYOUT_ACCOUNT.address.toLowerCase();

function lifecycleConfig() {
  const usdg = { chainId: '4663', assetId: TOKEN, decimals: 6 };
  const solanaStablecoin = {
    chainId: '792703809',
    assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  };
  return {
    chainId: 4663,
    accounts: { evm: PAYOUT_OPERATIONS },
    contracts: { usdg: TOKEN },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v1',
      assets: { usdg, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdg, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnUsdg: { ...usdg, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '5' },
        nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      },
      solana: {
        priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
      },
    },
  };
}

function lifecycleSigner(counter) {
  return {
    evm: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      preflightAuthority: createTestProfileMutationAuthority(),
      inner: {
        async sign({ transaction }) {
          counter.sign += 1;
          const signingTransaction = { ...transaction };
          for (const field of ['nonce', 'value', 'gas', 'gasPrice']) {
            signingTransaction[field] = BigInt(signingTransaction[field]);
          }
          const signedTx = await PAYOUT_ACCOUNT.signTransaction(signingTransaction);
          counter.signed ??= [];
          counter.signed.push(signedTx);
          return { signedTx };
        },
        async broadcast({ signedTx }) {
          counter.broadcasts ??= [];
          counter.broadcasts.push(signedTx);
          return { transactionHash: keccak256(signedTx) };
        },
      },
    }),
  };
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function lifecycleReceipt({ transactionHash, recipient, amountAtomic }) {
  return {
    transactionHash,
    blockNumber: 100n,
    blockHash: `0x${'9'.repeat(64)}`,
    status: 'success',
    logs: [{
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYOUT_OPERATIONS), addressTopic(recipient)],
      data: `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`,
      logIndex: '0',
    }],
  };
}

function lifecycleRpc() {
  let nonce = 0n;
  let receiptResolver = null;
  let observedReceipt = null;
  const client = {
    async readContract({ functionName }) {
      assert.equal(functionName, 'isFrozen');
      return false;
    },
    async getTransactionCount() { return nonce; },
    async getBalance() { return 1_000_000n; },
    async getTransactionReceipt({ hash }) {
      const receipt = await receiptResolver?.(hash);
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      observedReceipt = receipt;
      return receipt;
    },
    async getBlock({ blockNumber } = {}) {
      if (blockNumber === 99n) {
        return {
          number: 99n,
          hash: `0x${'8'.repeat(64)}`,
          timestamp: 1_700_000_000n,
        };
      }
      return {
        number: 100n,
        hash: `0x${'9'.repeat(64)}`,
        parentHash: `0x${'8'.repeat(64)}`,
        timestamp: 1_700_000_012n,
      };
    },
    setNonce(value) { nonce = BigInt(value); },
    setReceiptResolver(resolver) { receiptResolver = resolver; },
  };
  client.historicalEvidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const transfer = observedReceipt?.logs?.[0] ?? null;
      const amount = transfer === null ? 0n : BigInt(transfer.data);
      const value = account.toLowerCase() === PAYOUT_OPERATIONS
        ? (blockNumber === 99n ? 1_000_000n : 1_000_000n - amount)
        : (blockNumber === 99n ? 0n : amount);
      return { value, blockNumber, blockHash };
    },
  };
  return client;
}

function lifecycleFinalizedReturnEvidence(identity) {
  return finalizedReturnEvidence(identity, { operations: PAYOUT_OPERATIONS });
}

function lifecyclePayoutSource(identity, finalized = lifecycleFinalizedReturnEvidence(identity)) {
  return {
    ...payoutSource(identity, finalized),
    returnBinding: {
      operations: PAYOUT_OPERATIONS,
      usdgAddress: TOKEN,
      evidenceDigest: digest({
        schema: 'hookemon.supplementary-finalized-return-binding.v1',
        positionId: finalized.positionId,
        cycleId: finalized.cycleId,
        manifestId: finalized.manifestId,
        finalizedReturnEvidence: finalized,
      }),
    },
  };
}

function directStore(store, requestValue) {
  return {
    async load() { return store.load(requestValue); },
    async persist(state) { return store.persist(requestValue, state); },
  };
}

function usdg(amountAtomic) {
  return createUsdgPayoutAmount({ assetId: TOKEN, amountAtomic });
}

function eligibilityManifest(cycleId) {
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'1'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '3' },
    entries: [
      { recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '2' } },
      { recipient: RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
    ],
    exclusions: [],
    feasibility: {
      recipientCount: 2,
      transactionCount: 2,
      maxRecipientCount: 2,
      maxTransactionCount: 2,
      measuredTransferGas: '50000',
      maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500010' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500010' },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'2'.repeat(64)}`, logCount: 2 },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'3'.repeat(64)}`,
    launchManifestDigest: `sha256:${'4'.repeat(64)}`,
  };
}

function returnBinding(finalizedReturnEvidence) {
  return {
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-finalized-return-binding.v1',
      positionId: finalizedReturnEvidence.positionId,
      cycleId: finalizedReturnEvidence.cycleId,
      manifestId: finalizedReturnEvidence.manifestId,
      finalizedReturnEvidence,
    }),
  };
}

function settlementIdentity(cycleId = 'cycle-supplementary-payout') {
  return {
    positionId: POSITION_ID,
    cycleId,
    manifestId: `${cycleId}:supplementary:1`,
  };
}

function finalizedReturnEvidence(identity, overrides = {}) {
  return {
    schema: 'hookemon.supplementary-finalized-return.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    amountAtomic: '9',
    finalityEvidence: { transactionHash: `0x${'5'.repeat(64)}`, finalized: true },
    ...overrides,
  };
}

function payoutSource(identity, finalized = finalizedReturnEvidence(identity), overrides = {}) {
  return {
    schema: 'hookemon.supplementary-payout-source.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturn: usdg(finalized.amountAtomic),
    previousDust: usdg('0'),
    previousDustSource: null,
    returnBinding: returnBinding(finalized),
    ...overrides,
  };
}

function returnBoundary(identity, { finalized = finalizedReturnEvidence(identity), source = payoutSource(identity, finalized) } = {}) {
  const evidence = {
    schema: 'hookemon.supplementary-return-boundary.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturnEvidence: finalized,
  };
  return {
    state: 'RETURN_BROADCAST',
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-settlement-evidence.v1',
      positionId: identity.positionId,
      manifestId: identity.manifestId,
      state: 'RETURN_BROADCAST',
      evidence,
      payoutSourceDigest: digest(source),
    }),
    evidence,
    payoutSource: source,
  };
}

function settlement(cycleId = 'cycle-supplementary-payout', source = payoutSource(settlementIdentity(cycleId))) {
  const identity = settlementIdentity(cycleId);
  return {
    ...identity,
    state: 'RETURN_BROADCAST',
    positionEvidenceDigest: POSITION_EVIDENCE_DIGEST,
    eligibilitySnapshotEvidenceDigest: digest(eligibilityManifest(cycleId)),
    payoutSourceDigest: digest(source),
  };
}

function request(sourceSettlement = settlement(), overrides = {}) {
  return prepareSupplementaryPayoutRequest({
    settlement: sourceSettlement,
    eligibilityManifest: overrides.eligibilityManifest ?? eligibilityManifest(sourceSettlement.cycleId),
    returnBoundary: overrides.returnBoundary ?? returnBoundary(settlementIdentity(sourceSettlement.cycleId)),
  });
}

test('persists a supplementary payout separately while binding the original frozen eligibility manifest', async () => {
  const sourceSettlement = settlement();
  const prepared = request(sourceSettlement);
  const durableBoundary = returnBoundary(settlementIdentity(sourceSettlement.cycleId));
  const records = new Map();
  const repository = {
    async readPagedPayoutState(cycleId, stage) {
      return structuredClone(records.get(`${cycleId}\u0000${stage}`) ?? null);
    },
    async persistPagedPayoutState(cycleId, stage, value) {
      records.set(`${cycleId}\u0000${stage}`, structuredClone(value));
    },
    async readSupplementarySettlementEvidence(positionId) {
      assert.equal(positionId, sourceSettlement.positionId);
      return structuredClone(durableBoundary);
    },
  };
  const store = createSupplementaryPayoutStore({ cycleRepository: repository, settlement: sourceSettlement });
  const state = createDirectPayoutState({
    plan: prepared.plan.payoutPlan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '7',
  });

  assert.equal(prepared.manifestId, `${sourceSettlement.cycleId}:supplementary:1`);
  assert.equal(prepared.plan.payoutPlan.eligibility.holderSnapshotDigest, `sha256:${'3'.repeat(64)}`);
  assert.equal(supplementaryPayoutStageId(POSITION_ID), `supplementary-${'e'.repeat(48)}`);

  assert.deepEqual(await store.persist(prepared, state), state);
  assert.deepEqual(await store.load(prepared), state);
  assert.equal(records.size, 1);
  assertSupplementaryPayoutManifestUnchanged(await store.load(prepared), prepared);

  const changedFinalized = finalizedReturnEvidence(settlementIdentity(sourceSettlement.cycleId), { amountAtomic: '8' });
  const changedSource = payoutSource(settlementIdentity(sourceSettlement.cycleId), changedFinalized);
  const changed = request(
    settlement(sourceSettlement.cycleId, changedSource),
    { returnBoundary: returnBoundary(settlementIdentity(sourceSettlement.cycleId), { finalized: changedFinalized, source: changedSource }) },
  );
  const frozen = { ...state, manifestFrozen: true };
  assert.throws(
    () => assertSupplementaryPayoutManifestUnchanged(frozen, changed),
    /manifest is immutable/i,
  );
});

test('rejects a newer same-cycle eligibility manifest and alternate return or dust sources', () => {
  const sourceSettlement = settlement();
  assert.doesNotThrow(() => request(sourceSettlement));
  const identity = settlementIdentity(sourceSettlement.cycleId);

  const replacementManifest = {
    ...eligibilityManifest(sourceSettlement.cycleId),
    snapshotBlock: '13',
    snapshotHash: `0x${'6'.repeat(64)}`,
  };
  assert.throws(
    () => request(sourceSettlement, { eligibilityManifest: replacementManifest }),
    /eligibility snapshot evidence digest/i,
  );
  assert.throws(
    () => request(sourceSettlement, {
      returnBoundary: returnBoundary(identity, {
        finalized: finalizedReturnEvidence(identity, { amountAtomic: '8' }),
      }),
    }),
    /durable settlement/i,
  );
  const alternateDustSource = payoutSource(identity, finalizedReturnEvidence(identity), {
    previousDust: usdg('1'),
    previousDustSource: {
      cycleId: sourceSettlement.cycleId,
      digest: `sha256:${'7'.repeat(64)}`,
      planDigest: `sha256:${'8'.repeat(64)}`,
    },
  });
  assert.throws(
    () => request(sourceSettlement, {
      returnBoundary: returnBoundary(identity, { source: alternateDustSource }),
    }),
    /durable settlement/i,
  );
  const nonzeroSourceSettlement = settlement(sourceSettlement.cycleId, alternateDustSource);
  assert.throws(
    () => request(nonzeroSourceSettlement, {
      returnBoundary: returnBoundary(identity, { source: alternateDustSource }),
    }),
    /position-aware atomic dust reservation/i,
  );
  const foreignDustSource = payoutSource(identity, finalizedReturnEvidence(identity), {
    previousDust: usdg('1'),
    previousDustSource: {
      cycleId: 'cycle-other',
      digest: `sha256:${'7'.repeat(64)}`,
      planDigest: `sha256:${'8'.repeat(64)}`,
    },
  });
  assert.throws(
    () => request(sourceSettlement, {
      returnBoundary: returnBoundary(identity, { source: foreignDustSource }),
    }),
    /original cycle normal dust/i,
  );
});

test('rejects a persisted supplementary payout envelope for a different manifest', async () => {
  const sourceSettlement = settlement();
  const prepared = request(sourceSettlement);
  const stage = supplementaryPayoutStageId(POSITION_ID);
  const directState = createDirectPayoutState({
    plan: prepared.plan.payoutPlan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
  });
  const { recipients, ...payoutState } = directState;
  const records = new Map([[`${sourceSettlement.cycleId}\u0000${stage}`, {
    schema: 'hookemon.supplementary-payout-state.v1',
    positionId: POSITION_ID,
    cycleId: sourceSettlement.cycleId,
    manifestId: `${sourceSettlement.cycleId}:supplementary:2`,
    positionEvidenceDigest: POSITION_EVIDENCE_DIGEST,
    eligibilitySnapshotEvidenceDigest: prepared.eligibilitySnapshotEvidenceDigest,
    payoutSourceDigest: prepared.payoutSourceDigest,
    returnBoundaryEvidenceDigest: prepared.returnBoundaryEvidenceDigest,
    supplementaryPlanDigest: prepared.supplementaryPlanDigest,
    recipients,
    payoutState,
  }]]);
  const store = createSupplementaryPayoutStore({
    cycleRepository: {
      async readPagedPayoutState(cycleId, requestedStage) {
        return structuredClone(records.get(`${cycleId}\u0000${requestedStage}`) ?? null);
      },
      async persistPagedPayoutState() {},
      async readSupplementarySettlementEvidence() {
        return returnBoundary(settlementIdentity(sourceSettlement.cycleId));
      },
    },
    settlement: sourceSettlement,
  });

  await assert.rejects(() => store.load(prepared), /manifestId/i);
});

test('pays the original supplementary snapshot recipients once when finality resumes after a restart', async () => {
  const cycleId = 'cycle-supplementary-payout-restart';
  const identity = settlementIdentity(cycleId);
  const finalizedReturn = lifecycleFinalizedReturnEvidence(identity);
  const source = lifecyclePayoutSource(identity, finalizedReturn);
  const sourceSettlement = settlement(cycleId, source);
  const boundary = returnBoundary(identity, { finalized: finalizedReturn, source });
  const prepared = request(sourceSettlement, { returnBoundary: boundary });
  const expectedRecipients = prepared.plan.payoutPlan.allocations
    .filter(allocation => allocation.amount.amountAtomic !== '0')
    .map(allocation => allocation.recipient);
  const replacementManifest = {
    ...eligibilityManifest(cycleId),
    snapshotBlock: '13',
    snapshotHash: `0x${'6'.repeat(64)}`,
  };

  assert.throws(
    () => prepareSupplementaryPayoutRequest({
      settlement: sourceSettlement,
      eligibilityManifest: replacementManifest,
      returnBoundary: boundary,
    }),
    /eligibility snapshot evidence digest/i,
  );

  const records = new Map();
  const repository = {
    async readPagedPayoutState(cycle, stage) {
      return structuredClone(records.get(`${cycle}\u0000${stage}`) ?? null);
    },
    async persistPagedPayoutState(cycle, stage, value) {
      records.set(`${cycle}\u0000${stage}`, structuredClone(value));
    },
    async readSupplementarySettlementEvidence(positionId) {
      assert.equal(positionId, sourceSettlement.positionId);
      return structuredClone(boundary);
    },
  };
  const chain = lifecycleRpc();
  const firstStore = createSupplementaryPayoutStore({ cycleRepository: repository, settlement: sourceSettlement });
  const firstPayoutStore = directStore(firstStore, prepared);
  const firstSignerCounter = { sign: 0 };
  const firstSigner = lifecycleSigner(firstSignerCounter);

  await initializeDirectPayout({
    payoutStore: firstPayoutStore,
    plan: prepared.plan.payoutPlan,
    operations: PAYOUT_OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  assert.deepEqual((await firstPayoutStore.load()).recipients.map(record => record.recipient), expectedRecipients);

  for (let step = 0; step < 3; step += 1) {
    await advanceDirectPayout({
      payoutStore: firstPayoutStore,
      recipient: RECIPIENT_A,
      adapters: { robinhood: { client: chain } },
      signerClient: firstSigner,
      config: lifecycleConfig(),
    });
  }
  const broadcastState = await firstPayoutStore.load();
  const firstAttempt = broadcastState.recipients.find(record => record.recipient === RECIPIENT_A);
  assert.equal(firstAttempt.state, 'BROADCAST');
  assert.equal(firstSignerCounter.sign, 1);
  assert.equal(firstSignerCounter.broadcasts.length, 1);

  const restartedStore = createSupplementaryPayoutStore({ cycleRepository: repository, settlement: sourceSettlement });
  const restartedPayoutStore = directStore(restartedStore, prepared);
  assert.deepEqual(await restartedPayoutStore.load(), broadcastState);
  assertSupplementaryPayoutManifestUnchanged(await restartedPayoutStore.load(), prepared);

  const restartSignerCounter = { sign: 0 };
  const restartSigner = lifecycleSigner(restartSignerCounter);
  chain.setReceiptResolver(async hash => (hash === firstAttempt.txHash
    ? lifecycleReceipt({
      transactionHash: firstAttempt.txHash,
      recipient: firstAttempt.recipient,
      amountAtomic: firstAttempt.amount.amountAtomic,
    })
    : null));
  await advanceDirectPayout({
    payoutStore: restartedPayoutStore,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client: chain } },
    signerClient: restartSigner,
    config: lifecycleConfig(),
  });
  assert.equal(restartSignerCounter.sign, 0);
  assert.equal(restartSignerCounter.broadcasts?.length ?? 0, 0);

  chain.setNonce('1');
  for (let step = 0; step < 3; step += 1) {
    await advanceDirectPayout({
      payoutStore: restartedPayoutStore,
      recipient: RECIPIENT_B,
      adapters: { robinhood: { client: chain } },
      signerClient: restartSigner,
      config: lifecycleConfig(),
    });
  }
  const secondAttempt = (await restartedPayoutStore.load()).recipients.find(record => record.recipient === RECIPIENT_B);
  assert.equal(secondAttempt.state, 'BROADCAST');
  chain.setReceiptResolver(async hash => (hash === secondAttempt.txHash
    ? lifecycleReceipt({
      transactionHash: secondAttempt.txHash,
      recipient: secondAttempt.recipient,
      amountAtomic: secondAttempt.amount.amountAtomic,
    })
    : null));
  await advanceDirectPayout({
    payoutStore: restartedPayoutStore,
    recipient: RECIPIENT_B,
    adapters: { robinhood: { client: chain } },
    signerClient: restartSigner,
    config: lifecycleConfig(),
  });

  const finalized = await restartedPayoutStore.load();
  assert.equal(isDirectPayoutComplete(finalized), true);
  assert.deepEqual(finalized.recipients.map(record => record.recipient), expectedRecipients);
  assert.deepEqual(finalized.recipients.map(record => record.state), ['FINALIZED', 'FINALIZED']);
  assert.equal(firstSignerCounter.broadcasts.length + restartSignerCounter.broadcasts.length, expectedRecipients.length);
  assert.equal(new Set(finalized.recipients.map(record => record.txHash)).size, expectedRecipients.length);
});

test('uses a separate paged durable namespace for the supplementary manifest', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-supplementary-payout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const stage = supplementaryPayoutStageId(POSITION_ID);
  const evidence = { schema: 'fixture-supplementary-payout.v1', cycleId, positionId: POSITION_ID, recipients: [] };

  await repository.persistPagedPayoutState(cycleId, stage, evidence);

  assert.deepEqual(await repository.readPagedPayoutState(cycleId, stage), evidence);
  await assert.rejects(
    () => repository.persistPagedPayoutState(cycleId, 'supplementary-not-a-position', evidence),
    /supplementary payout stage/i,
  );
});
