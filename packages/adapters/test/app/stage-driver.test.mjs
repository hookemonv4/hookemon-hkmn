import { producedReturnSigningFixture } from '../native/return-signing-fixture.mjs';
import { createTestNativePaymentBinding, isReleaseNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { isProcessQuoteUsdValuation } from '../../src/relay-client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeFunctionData, parseAbi, keccak256, parseTransaction, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { LeaseLostError } from '../../../runner/src/automation/exclusive-lease.mjs';
import { LiveModeIntegrationPendingError, createStageDriver } from '../../src/app/stage-driver.mjs';
import { ReturnRecoveryRequiredError } from '../../src/app/stages/return.mjs';
import { preparePurchaseRequest } from '../../src/app/stages/purchase.mjs';
import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  TOKEN_PROGRAM_ID,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
  submitSignedTransaction,
} from '../../src/solana-rpc.mjs';
import { AUTOMATED_CYCLE_STAGES } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  CUSTODY_LEDGER_BUCKETS,
  createPreparedChainTransactionAttempt,
  createPreparedProviderMutationAttempt,
  createRecordedRelayLeg,
} from '../../../runner/src/cycle/money-schemas.mjs';
import { createNativePayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createHistoricalErc20EvidenceClient } from '../../src/robinhood-rpc.mjs';
import { createRelayClient, RelayQuoteExpiredError } from '../../src/relay-client.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { KeychainSignOnlyTimeoutError, createKeychainSignerClient } from '../../src/signing/keychain-signer.mjs';
import { TransactionPolicyError } from '../../src/signing/transaction-policy.mjs';
import { buildAndSignStepAuthorization, createProductionTestFixture } from '../../../runner/test/cycle/production-cycle.mjs';
import { nativeAdmissionFixture, nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

const CYCLE_ID = 'cycle-test-1';
const fixtureStageDriverOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

async function durableCycle(t, { amountWei = '1' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-stage-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const cycleId = 'cycle-stage-driver-durable';
  const admission = await nativeProducedAdmissionFixture(cycleId, { amountWei, nowMs: Date.now() });
  await repository.createCycle({ cycleId, releaseAmount: amountWei, mode: 'production', admission });
  return { directory, repository, cycleId };
}

function throwingSigner() {
  return {
    evm: { sign: () => { throw new Error('signerClient.evm.sign must never be called'); } },
    solana: { sign: () => { throw new Error('signerClient.solana.sign must never be called'); } },
  };
}

function throwingCollectorCrypt() {
  const boom = name => () => { throw new Error(`collector-crypt.${name} must never be called`); };
  return {
    getMachines: async () => ({ machines: [] }),
    getStatus: async () => ({ machineStatus: 'ok', gachas: [] }),
    getPackStatus: boom('getPackStatus'),
    generatePack: boom('generatePack'),
    openPack: boom('openPack'),
    getBuybackAvailable: boom('getBuybackAvailable'),
    buyback: boom('buyback'),
    submitTransaction: boom('submitTransaction'),
  };
}

function throwingRelay() {
  const boom = name => () => { throw new Error(`relay.${name} must never be called`); };
  return {
    quoteOutboundBridge: boom('quoteOutboundBridge'),
    quoteReturnBridge: boom('quoteReturnBridge'),
    simulateExecution: boom('simulateExecution'),
    prepareExecution: boom('prepareExecution'),
  };
}

function fakeCycleRepository(stages = new Map(), releaseAmount = '0', attempts = new Map()) {
  return {
    async readStage(cycleId, stage) { return stages.get(stage) ?? { status: 'PENDING' }; },
    async describeCycle() { return { releaseAmount }; },
    async readClaimPreconditions() { return { heldAssets: false, unattributed: false, unresolvedObligations: false }; },
    async readStageAttempt(cycleId, stage) {
      const record = attempts.get(stage);
      return record && !record.failed ? record.responseEvidence : null;
    },
    async readOperationalStageAttempt(cycleId, stage) { return attempts.get(stage) ?? null; },
    // reconcileLivePurchase's first read: no pack batch has been durably recorded yet, the correct
    // default for every existing caller of this shared fixture (none records one).
    async readPackBatchRequest() { return null; },
    async prepareStageAttempt(cycleId, stage, attempt) {
      attempts.set(stage, { attempt, responseEvidence: null, reconciliationEvidence: null });
    },
    async markStageAttemptSentUnknown(cycleId, stage) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'SENT_UNKNOWN' };
    },
    async markStageAttemptNotSent(cycleId, stage) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'NOT_SENT' };
    },
    async recordStageAttemptResponse(cycleId, stage, evidence) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'RESPONSE_RECORDED', responseDigest: `sha256:${'e'.repeat(64)}` };
      record.responseEvidence = evidence;
    },
    async reconcileStageAttempt(cycleId, stage, evidence) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'RECONCILED', reconciliationDigest: `sha256:${'f'.repeat(64)}` };
      record.reconciliationEvidence = evidence;
    },
    async recordStageAttemptFailure(cycleId, stage) {
      const record = attempts.get(stage);
      if (record) record.failed = true;
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    contracts: { vault: null, hook: null },
    accounts: { evm: null, solana: null },
    ...overrides,
  };
}

function claimMoneyConfiguration() {
  const native = { chainId: '4663', assetId: 'native', decimals: 18 };
  const solanaStablecoin = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: { eth: native, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...native, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnEth: { ...native, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

const CLAIM_HOOK_BLOCK_HASH = `0x${'9'.repeat(64)}`;

/**
 * A real hook process-liability archive read, bound to the exact production code path
 * (`createHistoricalErc20EvidenceClient`, `readFinalizedBlock`, `readBlockByNumber`) the pre-sign
 * veto in `assertClaimStillCoveredByHookLiability` requires -- the same real getter/block-binding
 * machinery `process-liability-admission.test.mjs`'s reader-level tests exercise, not an invented
 * shortcut. Every getter reports ample, self-consistent, always-solvent liability: these two tests
 * are about the chain-attempt/signing lifecycle, not the liability boundary itself, which has its
 * own focused coverage.
 */
function claimHookLiabilityArchive({ operations }) {
  const covers = 10n ** 12n;
  const values = {
    processLiability: covers, remainingProcessClaimCapacity: covers, processClaimsPaused: false,
    processClaimCycleUsed: false, activeProcessClaimLimit: covers, totalLiability: covers,
    hookEthBalance: covers, isSolvent: true,
  };
  const readContractClient = {
    async readContract({ functionName }) {
      if (functionName === 'readRoles') {
        return [{ programmableBeneficiary: operations, treasury: operations, operations }, {}, {}, {}];
      }
      if (!(functionName in values)) throw new Error(`unexpected getter ${functionName}`);
      return values[functionName];
    },
    async getBlock({ blockNumber } = {}) {
      return { number: blockNumber ?? 10n, hash: CLAIM_HOOK_BLOCK_HASH, timestamp: 1n };
    },
  };
  return {
    getBlock: readContractClient.getBlock,
    historicalEvidenceClient: createHistoricalErc20EvidenceClient({ client: readContractClient }),
  };
}

function driverWithThrowingEverything(liveMode) {
  return createStageDriver({
    liveMode,
    adapters: { collectorCrypt: throwingCollectorCrypt(), relay: throwingRelay(), robinhood: { client: null }, solana: { client: null } },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository: fakeCycleRepository(),
  });
}

test('every AUTOMATED_CYCLE_STAGES name has a registered handler (reconcile never throws "unknown stage")', async () => {
  const driver = driverWithThrowingEverything(false);
  for (const stage of AUTOMATED_CYCLE_STAGES) {
    const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage });
    assert.notEqual(evidence, undefined);
  }
});

test('requires a write-ahead repository even when a caller only intends to construct a driver', () => {
  assert.throws(
    () => createStageDriver({
      liveMode: false,
      adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
      signerClient: null,
      config: baseConfig(),
      cycleRepository: { async readStage() {}, async describeCycle() {}, async readClaimPreconditions() {} },
    }),
    /write-ahead mutation safety/,
  );
});

test('reads the current operator deadline while reconciling a card mutation', async () => {
  const attempt = createPreparedProviderMutationAttempt({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    requestDigest: `sha256:${'a'.repeat(64)}`,
  });
  const attempts = new Map([['purchase', {
    attempt: { ...attempt, state: 'SENT_UNKNOWN' },
    responseEvidence: null,
    reconciliationEvidence: null,
  }]]);
  let deadline = null;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    readOperatorConfiguration: async () => ({ unresolvedCardDeadlineMinutes: 37 }),
    cycleRepository: fakeCycleRepository(new Map(), '0', attempts),
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { request: 'unused' }; },
        async mutate() { throw new Error('reconciliation must not mutate'); },
        async reconcileLive({ config }) {
          deadline = config.unresolvedCardDeadlineMinutes;
          return { reconciled: true };
        },
      },
    },
  });

  assert.deepEqual(await driver.reconcile({ cycleId: CYCLE_ID, stage: 'purchase' }), { reconciled: true });
  assert.equal(deadline, 37);
});

test('limits held-position persistence to card-stage reconciliation', async () => {
  const sentUnknown = stage => ({
    attempt: {
      ...createPreparedProviderMutationAttempt({
        cycleId: CYCLE_ID,
        stage,
        requestDigest: `sha256:${(stage === 'open' ? 'b' : 'c').repeat(64)}`,
      }),
      state: 'SENT_UNKNOWN',
    },
    responseEvidence: null,
    reconciliationEvidence: null,
  });
  const attempts = new Map([
    ['open', sentUnknown('open')],
    ['return', sentUnknown('return')],
  ]);
  const repository = fakeCycleRepository(new Map(), '0', attempts);
  let heldWrites = 0;
  let wholeCycleHolds = 0;
  repository.recordHeldPosition = async (cycleId, input) => {
    assert.equal(cycleId, CYCLE_ID);
    assert.equal(input.reason, 'HELD_UNRESOLVED');
    heldWrites += 1;
    return { positionId: 'held-test' };
  };
  repository.holdCycle = async (cycleId, terminalState, evidence) => {
    assert.equal(cycleId, CYCLE_ID);
    assert.equal(terminalState, 'HELD_DATA_UNVERIFIED');
    assert.equal(evidence.reason, 'missing predecessor evidence');
    wholeCycleHolds += 1;
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    stageHandlers: {
      open: {
        async probe() { return null; },
        async prepareRequest() { return { request: 'unused' }; },
        async mutate() { throw new Error('reconciliation must not mutate'); },
        async reconcileLive({ context, cycleRepository }) {
          assert.equal(context.nowMs, 1_000);
          assert.equal(typeof cycleRepository.recordHeldPosition, 'function');
          assert.equal(typeof cycleRepository.holdCycle, 'function');
          await cycleRepository.recordHeldPosition(context.cycleId, { reason: 'HELD_UNRESOLVED' });
          await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', { reason: 'missing predecessor evidence' });
          return { decision: 'held' };
        },
      },
      return: {
        async probe() { return null; },
        async prepareRequest() { return { request: 'unused' }; },
        async mutate() { throw new Error('reconciliation must not mutate'); },
        async reconcileLive({ cycleRepository }) {
          assert.equal(cycleRepository.recordHeldPosition, undefined);
          assert.equal(cycleRepository.holdCycle, undefined);
          return { reconciled: true };
        },
      },
    },
  });

  await driver.reconcile({ cycleId: CYCLE_ID, stage: 'open', nowMs: 1_000 });
  await driver.reconcile({ cycleId: CYCLE_ID, stage: 'return', nowMs: 1_000 });
  assert.equal(heldWrites, 1);
  assert.equal(wholeCycleHolds, 1);
});

test('limits the custody-ledger writer to buyback reconciliation', async () => {
  const repository = fakeCycleRepository();
  let ledgerWrites = 0;
  repository.recordCustodyLedger = async (cycleId, ledger) => {
    assert.equal(cycleId, CYCLE_ID);
    assert.deepEqual(ledger, { schema: 'test-ledger' });
    ledgerWrites += 1;
  };
  let leaseChecks = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    stageHandlers: {
      buyback: {
        async probe() { return null; },
        async prepareRequest() { return { request: 'unused' }; },
        async mutate() { throw new Error('reconciliation must not mutate'); },
        async reconcileLive({ cycleRepository }) {
          assert.equal(typeof cycleRepository.recordCustodyLedger, 'function');
          await cycleRepository.recordCustodyLedger(CYCLE_ID, { schema: 'test-ledger' });
          return { reconciled: true };
        },
      },
      open: {
        async probe() { return null; },
        async prepareRequest() { return { request: 'unused' }; },
        async mutate() { throw new Error('reconciliation must not mutate'); },
        async reconcileLive({ cycleRepository }) {
          assert.equal(cycleRepository.recordCustodyLedger, undefined);
          return { reconciled: true };
        },
      },
    },
  });

  await driver.reconcile({ cycleId: CYCLE_ID, stage: 'buyback', assertLease() { leaseChecks += 1; } });
  await driver.reconcile({ cycleId: CYCLE_ID, stage: 'open' });
  assert.equal(ledgerWrites, 1);
  assert.equal(leaseChecks, 1);
});

test('a lease lost before the buyback custody-ledger write blocks the effect', async () => {
  const attempt = createPreparedProviderMutationAttempt({
    cycleId: CYCLE_ID,
    stage: 'buyback',
    requestDigest: `sha256:${'a'.repeat(64)}`,
  });
  const attempts = new Map([['buyback', {
    attempt: { ...attempt, state: 'SENT_UNKNOWN' },
    responseEvidence: null,
    reconciliationEvidence: null,
  }]]);
  const repository = fakeCycleRepository(new Map(), '0', attempts);
  let ledgerWrites = 0;
  repository.recordCustodyLedger = async () => { ledgerWrites += 1; };
  const lost = new LeaseLostError('expired', { owner: 'cycle-runner', version: 4 });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    stageHandlers: {
      buyback: {
        async probe() { return null; },
        async prepareRequest() { return { request: 'unused' }; },
        async mutate() { throw new Error('reconciliation must not mutate'); },
        async reconcileLive({ cycleRepository }) {
          // The lease check inside the fenced wrapper runs synchronously before it ever calls
          // through to the repository, so a lost lease throws here directly rather than
          // rejecting a promise.
          assert.throws(
            () => cycleRepository.recordCustodyLedger(CYCLE_ID, { schema: 'test-ledger' }),
            LeaseLostError,
          );
          return { reconciled: true };
        },
      },
    },
  });

  assert.deepEqual(
    await driver.reconcile({ cycleId: CYCLE_ID, stage: 'buyback', assertLease() { throw lost; } }),
    { reconciled: true },
  );
  assert.equal(ledgerWrites, 0);
});

test('dispatches a prepared supplementary settlement through its injected handler', async () => {
  const position = {
    positionId: `held:${'a'.repeat(64)}`,
    cycleId: CYCLE_ID,
    packId: 'base-pack',
    memo: 'memo-supplementary',
    mint: 'mint-supplementary',
    cardRef: 'mint-supplementary',
    costMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  let settlement = {
    positionId: position.positionId,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:1`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  const repository = fakeCycleRepository();
  repository.readSupplementarySettlement = async positionId => {
    assert.equal(positionId, position.positionId);
    return structuredClone(settlement);
  };
  repository.readSupplementarySettlementEvidence = async positionId => {
    assert.equal(positionId, position.positionId);
    return null;
  };
  repository.advanceSupplementarySettlement = async (positionId, input) => {
    assert.equal(positionId, position.positionId);
    assert.equal(input.expectedState, 'PREPARED');
    assert.equal(input.nextState, 'BUYBACK_SENT_UNKNOWN');
    settlement = { ...settlement, state: input.nextState };
    return structuredClone(settlement);
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    supplementaryStageHandlers: {
      PREPARED: {
        stage: 'supplementary-buyback',
        async reconcile({ context, cycleRepository, position: receivedPosition, settlement: receivedSettlement }) {
          assert.equal(context.stage, 'supplementary-buyback');
          assert.deepEqual(receivedPosition, position);
          assert.deepEqual(receivedSettlement, {
            positionId: position.positionId,
            cycleId: CYCLE_ID,
            manifestId: `${CYCLE_ID}:supplementary:1`,
            state: 'PREPARED',
            positionEvidenceDigest: position.evidenceDigest,
          });
          assert.equal(await cycleRepository.readSupplementarySettlementEvidence(position.positionId), null);
          return cycleRepository.advanceSupplementarySettlement(position.positionId, {
            expectedState: receivedSettlement.state,
            nextState: 'BUYBACK_SENT_UNKNOWN',
            evidence: { requestDigest: `sha256:${'c'.repeat(64)}` },
          });
        },
      },
    },
  });

  const result = await driver.runSupplementarySettlement({
    position,
    settlement,
    nowMs: 1_001,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {},
  });

  assert.deepEqual(result, {
    status: 'ADVANCED',
    positionId: position.positionId,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:1`,
    stage: 'supplementary-buyback',
    state: 'BUYBACK_SENT_UNKNOWN',
  });
});

test('keeps supplementary test handlers from receiving provider capabilities', async () => {
  const position = {
    positionId: `held:${'d'.repeat(64)}`,
    cycleId: CYCLE_ID,
    packId: 'base-pack',
    memo: 'memo-supplementary-guard',
    mint: 'mint-supplementary-guard',
    cardRef: 'mint-supplementary-guard',
    costMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'e'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  const settlement = {
    positionId: position.positionId,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:2`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  const repository = fakeCycleRepository();
  repository.readSupplementarySettlement = async () => structuredClone(settlement);
  let handlerRan = false;
  let providerCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async buyback() { providerCalls += 1; },
      },
      relay: null,
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    supplementaryStageHandlers: {
      PREPARED: {
        stage: 'supplementary-buyback',
        async reconcile({ adapters }) {
          handlerRan = true;
          assert.deepEqual(adapters, {});
          assert.equal(adapters.collectorCrypt, undefined);
        },
      },
    },
  });

  const result = await driver.runSupplementarySettlement({
    position,
    settlement,
    nowMs: 1_001,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {},
  });
  assert.equal(result.status, 'PENDING');
  assert.equal(handlerRan, true);
  assert.equal(providerCalls, 0);
});

test('rejects supplementary handler injection outside the Node test runner', () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    assert.throws(
      () => createStageDriver({
        liveMode: true,
        adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
        signerClient: null,
        config: baseConfig(),
        cycleRepository: fakeCycleRepository(),
        supplementaryStageHandlers: {},
      }),
      /available only from the Node test runner/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('productionSupplementaryStageHandlers requires its own real adapters and signer client', () => {
  assert.throws(
    () => createStageDriver({
      liveMode: true,
      adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
      signerClient: null,
      config: baseConfig(),
      cycleRepository: fakeCycleRepository(),
      productionSupplementaryStageHandlers: { PREPARED: { stage: 'supplementary-buyback', async reconcile() {} } },
    }),
    /requires supplementaryAdapters and supplementarySignerClient/,
  );
});

test('productionSupplementaryStageHandlers cannot be combined with the Node-test-only seam', () => {
  assert.throws(
    () => createStageDriver({
      liveMode: true,
      adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
      signerClient: null,
      config: baseConfig(),
      cycleRepository: fakeCycleRepository(),
      supplementaryStageHandlers: {},
      supplementaryAdapters: {},
      supplementarySignerClient: {},
      productionSupplementaryStageHandlers: { PREPARED: { stage: 'supplementary-buyback', async reconcile() {} } },
    }),
    /cannot combine productionSupplementaryStageHandlers with the Node-test-only supplementaryStageHandlers seam/,
  );
});

test('productionSupplementaryStageHandlers dispatches outside the Node test runner with real capabilities, unrestricted to observation-only', async () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    const position = {
      positionId: `held:${'f'.repeat(64)}`,
      cycleId: CYCLE_ID,
      packId: 'base-pack',
      memo: 'memo-supplementary-production',
      mint: 'mint-supplementary-production',
      cardRef: 'mint-supplementary-production',
      costMicroUsdg: '25',
      insuredValue: null,
      reason: 'EPIC_THRESHOLD',
      terminalState: 'HELD_OWNER_DECISION',
      evidenceDigest: `sha256:${'1'.repeat(64)}`,
      openedAtMs: 1_000,
      ownerDecision: { choice: 'sell' },
      resolution: null,
    };
    let settlement = {
      positionId: position.positionId,
      cycleId: CYCLE_ID,
      manifestId: `${CYCLE_ID}:supplementary:3`,
      state: 'PREPARED',
      positionEvidenceDigest: position.evidenceDigest,
    };
    const repository = fakeCycleRepository();
    repository.readSupplementarySettlement = async () => structuredClone(settlement);
    repository.advanceSupplementarySettlement = async (positionId, input) => {
      settlement = { ...settlement, state: input.nextState };
      return structuredClone(settlement);
    };
    let buybackCalls = 0;
    let signingCalls = 0;
    let leaseChecks = 0;
    const productionAdapters = Object.freeze({ collectorCrypt: { async buyback() { buybackCalls += 1; return { signature: 'sig' }; } } });
    const productionSignerClient = Object.freeze({ solana: { async sign() { signingCalls += 1; return 'signed'; } } });
    let receivedAdapters = null;
    let receivedSignerClient = null;
    const driver = createStageDriver({
      liveMode: true,
      adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
      signerClient: null,
      config: baseConfig(),
      cycleRepository: repository,
      supplementaryAdapters: productionAdapters,
      supplementarySignerClient: productionSignerClient,
      productionSupplementaryStageHandlers: {
        PREPARED: {
          stage: 'supplementary-buyback',
          mutation: 'buyback',
          async reconcile({ adapters, signerClient, cycleRepository: injectedRepository, settlement: receivedSettlement }) {
            receivedAdapters = adapters;
            receivedSignerClient = signerClient;
            await adapters.collectorCrypt.buyback();
            await signerClient.solana.sign();
            return injectedRepository.advanceSupplementarySettlement(position.positionId, {
              expectedState: receivedSettlement.state,
              nextState: 'BUYBACK_SENT_UNKNOWN',
              evidence: { requestDigest: `sha256:${'2'.repeat(64)}` },
            });
          },
        },
      },
    });

    const result = await driver.runSupplementarySettlement({
      position,
      settlement,
      nowMs: 1_001,
      fencingToken: '11111111-1111-4111-8111-111111111111',
      assertLease() { leaseChecks += 1; },
    });

    assert.notEqual(receivedAdapters, productionAdapters, 'production capabilities are lease-fenced facades');
    assert.notEqual(receivedSignerClient, productionSignerClient, 'production signer is a lease-fenced facade');
    assert.equal(buybackCalls, 1);
    assert.equal(signingCalls, 1);
    assert.ok(leaseChecks >= 4, 'the driver checks the lease before dispatch and each capability use');
    assert.equal(result.status, 'ADVANCED');
    assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('liveMode false: execute() never reaches signerClient.sign or any collector-crypt/relay mutation, for every stage', async () => {
  const driver = driverWithThrowingEverything(false);
  for (const stage of AUTOMATED_CYCLE_STAGES) {
    await driver.execute({ cycleId: CYCLE_ID, stage }); // must resolve without throwing and without touching any throwing stub
  }
});

test('liveMode false: reconcile() alone produces non-null evidence for every stage, so AutomatedCycleService never even calls execute() in dry-run', async () => {
  const driver = driverWithThrowingEverything(false);
  for (const stage of AUTOMATED_CYCLE_STAGES) {
    const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage });
    assert.ok(evidence !== null, `stage "${stage}" must resolve immediately in dry-run`);
  }
});

test('eligibility snapshot probe reports configured:false when no token address or Robinhood client is set', async () => {
  const driver = createStageDriver({
    liveMode: false,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: fakeCycleRepository(),
  });
  const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'eligibility-snapshot' });
  assert.equal(evidence.configured, false);
});

test('eligibility snapshot probe reports configured:true without invoking an unfrozen RPC query', async () => {
  const calls = [];
  const fakeClient = {
    async readContract({ functionName }) {
      calls.push(functionName);
      return { requirementsRevision: 0n, chainId: 4663n, cycleId: `0x${'0'.repeat(64)}` };
    },
  };
  const driver = createStageDriver({
    liveMode: false,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: fakeClient }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({ hkmn: { address: `0x${'1'.repeat(40)}` } }),
    cycleRepository: fakeCycleRepository(),
  });
  const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'eligibility-snapshot' });
  assert.equal(evidence.configured, true);
  assert.deepEqual(calls, []);
});

test('probeOutbound records the real quote\'s origin/destination amounts on its evidence when the adapter\'s QuoteResult carries them', async () => {
  const driver = createStageDriver({
    liveMode: false,
    adapters: {
      collectorCrypt: null,
      relay: {
        async quoteOutboundBridge() {
          return {
            requestId: 'req-1',
            origin: { amount: '5000000' },
            destination: { amount: '4995000' },
          };
        },
        simulateExecution({ quote }) { return { wouldExecute: true, requestId: quote.requestId }; },
      },
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig({
      accounts: { evm: `0x${'3'.repeat(40)}`, solana: '11111111111111111111111111111111' },
      relay: {
        solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        evmDepository: `0x${'4'.repeat(40)}`,
      },
    }),
    cycleRepository: fakeCycleRepository(new Map(), '5000000'),
  });
  const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'outbound' });
  assert.equal(evidence.configured, true);
  assert.equal(evidence.quotedOriginAmount, '5000000');
  assert.equal(evidence.quotedDestinationAmount, '4995000');
});

test('probeOutbound honestly reports null quote amounts when the injected adapter\'s QuoteResult does not carry them (e.g. a minimal test fake)', async () => {
  const driver = createStageDriver({
    liveMode: false,
    adapters: {
      collectorCrypt: null,
      relay: {
        async quoteOutboundBridge() { return { requestId: 'req-1' }; },
        simulateExecution({ quote }) { return { wouldExecute: true, requestId: quote.requestId }; },
      },
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig({
      accounts: { evm: `0x${'3'.repeat(40)}`, solana: '11111111111111111111111111111111' },
      relay: {
        solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        evmDepository: `0x${'4'.repeat(40)}`,
      },
    }),
    cycleRepository: fakeCycleRepository(new Map(), '5000000'),
  });
  const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'outbound' });
  assert.equal(evidence.quotedOriginAmount, null);
  assert.equal(evidence.quotedDestinationAmount, null);
});

test('built-in outbound reconciliation completes a real CycleRepository stage from durable settlement evidence', async t => {
  const { repository, cycleId } = await durableCycle(t, { amountWei: '25' });
  // Public synthetic key signs the exact native deposit bytes consumed by reconciliation.
  const operationsAccount = privateKeyToAccount(`0x${'6'.repeat(64)}`);
  const operations = operationsAccount.address.toLowerCase();
  const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  const sourceAsset = 'native';
  const solanaOwner = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
  const solanaMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const sourceAmount = '25';
  const destinationAmount = '24';
  const sourceData = encodeFunctionData({ abi: parseAbi(['function depositNative(address depositor, bytes32 id)']), functionName: 'depositNative', args: [operations, `0x${'2'.repeat(64)}`] });
  const sourceRawBytes = await operationsAccount.signTransaction({ chainId: 4663, to: depository, value: 25n, data: sourceData, nonce: 9, gas: 60000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const sourceHash = keccak256(sourceRawBytes);
  const requestDigest = `sha256:${'b'.repeat(64)}`;
  const fencingToken = '11111111-1111-4111-8111-111111111111';
  const relayRequestId = 'relay-driver-settlement';

  for (const stage of ['eligibility-snapshot', 'claim-process']) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, { schema: 'test-complete-stage.v1', stage });
  }
  const intent = await repository.prepareStage(cycleId, 'outbound');
  await repository.recordRelayLeg(cycleId, createRecordedRelayLeg({
    cycleId,
    direction: 'outbound',
    relayRequestId,
    quoteDigest: `sha256:${'c'.repeat(64)}`,
    source: { chainId: '4663', assetId: sourceAsset, decimals: 18, amountAtomic: sourceAmount },
    destination: { chainId: '792703809', assetId: solanaMint, decimals: 6, amountAtomic: destinationAmount },
  }));
  await repository.reserveWalletNonce(cycleId, {
    chainId: '4663', wallet: operations, stage: 'outbound', fencingToken,
    leaseAcquiredAtMs: 0, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });

  // Shared by every step of this leg's Relay envelope, exactly as the real production planner
  // shares one `request.intent`/route across every signed step (outbound.mjs, mutateOutbound).
  // tradeType/quoteDigest are mandatory identity fields on the exact recovery-context schema
  // (OUTBOUND_RELAY_INTENT_FIELDS, cycle-repository.mjs) binding this intent to the quote it was
  // admitted under.
  const relayIntent = {
    schema: 'hookemon.relay-intent.v2',
    requestId: relayRequestId,
    orderId: `0x${'2'.repeat(64)}`,
    direction: 'OUTBOUND',
    tradeType: 'EXACT_OUTPUT',
    quoteDigest: `sha256:${'9'.repeat(64)}`,
    originChainId: 4663,
    destinationChainId: 792703809,
    originAssetId: '0x0000000000000000000000000000000000000000',
    originDecimals: 18,
    destinationAssetId: solanaMint,
    destinationDecimals: 6,
    originAmount: sourceAmount,
    quotedDestinationAmount: destinationAmount,
    quotedDestinationMinimumAmount: destinationAmount,
    sender: operations,
    recipient: solanaOwner,
    deadlineUnixSeconds: 1700000200,
  };
  const relayRoute = { sourceSender: operations, sourceRecipient: depository, destinationOwner: solanaOwner };

  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', createPreparedChainTransactionAttempt({
    cycleId,
    stage: 'outbound',
    requestDigest,
  }));
  await repository.recordSignedTransactionWithRecoveryContext(
    cycleId,
    'outbound',
    requestDigest,
    { rawBytes: sourceRawBytes, nonce: '9', blockhash: null, hash: sourceHash },
    {
      stage: 'outbound',
      recipient: null,
      requestDigest,
      policyDigest: `sha256:${'d'.repeat(64)}`,
      approvalDigest: `sha256:${'e'.repeat(64)}`,
      fencingToken,
      fencingTokenDigest: `sha256:${'f'.repeat(64)}`,
      approvedSemanticsDigest: `sha256:${'0'.repeat(64)}`,
      rawSignedBytesHash: sourceHash,
      signedMessageDigest: `sha256:${'1'.repeat(64)}`,
      relayQuoteDeadlineUnixSeconds: '1700000200',
      relayIntent,
      relayRoute,
    },
    { relayRequestId, sourceTxHash: sourceHash },
  );
  await repository.recordBroadcast(cycleId, 'outbound', requestDigest, { transactionHash: sourceHash });

  const receiptBlockHash = `0x${'2'.repeat(64)}`;
  const parentBlockHash = `0x${'3'.repeat(64)}`;
  const sourceClient = {
    async getChainId() { return 4663; },
    async getTransaction() { return { hash: sourceHash, from: operations, to: depository, value: 25n, input: sourceData, nonce: 9, blockNumber: 100n, blockHash: receiptBlockHash }; },
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, sourceHash);
      return {
        transactionHash: sourceHash,
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: 'success',
        logs: [], gasUsed: 21000n, effectiveGasPrice: 1n,
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized' || blockNumber === 101n) return { number: 101n, hash: `0x${'4'.repeat(64)}`, timestamp: 1_700_000_090n };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, parentHash: parentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: parentBlockHash, parentHash: `0x${'5'.repeat(64)}`, timestamp: 1_700_000_070n };
      throw new Error('unexpected outbound source block read');
    },
  };
  const historicalEvidenceClient = {
    async readNativeBalanceAtBlock({ account, blockNumber, blockHash }) {
      const source = account.toLowerCase() === operations;
      const value = source
        ? (blockNumber === 99n ? 100n : 100n - BigInt(sourceAmount))
        : (blockNumber === 99n ? 0n : BigInt(sourceAmount));
      return { value, blockNumber, blockHash };
    },
  };
  const destinationSignature = 'relay-durable-destination';
  const solanaClient = createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'getSignaturesForAddress') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [{ signature: destinationSignature, err: null }] }) };
      }
      if (request.method === 'getTransaction') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              slot: 88,
              blockTime: 1_700_000_100,
              transaction: {
                message: {
                  accountKeys: ['TokenAccount1111111111111111111111111111111'],
                  instructions: [{ program: 'spl-memo', parsed: relayRequestId }],
                },
              },
              meta: {
                err: null,
                preTokenBalances: [{ accountIndex: 0, mint: solanaMint, owner: solanaOwner, uiTokenAmount: { amount: '100' } }],
                postTokenBalances: [{ accountIndex: 0, mint: solanaMint, owner: solanaOwner, uiTokenAmount: { amount: (100n + BigInt(destinationAmount)).toString() } }],
              },
            },
          }),
        };
      }
      throw new Error(`unexpected Solana RPC ${request.method}`);
    },
  });
  const nativeAsset = { chainId: '4663', assetId: 'native', decimals: 18 };
  await repository.recordCustodyLedger(cycleId, { schema: 'hookemon.custody-ledger.v3', cycleId, ...nativeAsset,
    ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, '0'])), claimed: sourceAmount,
    verifiedCurrentBalance: null, expectedCycleAsset: null, gasReserve: { ...nativeAsset, amountAtomic: '30000' },
    gasSpent: { ...nativeAsset, amountAtomic: '0' }, gasPayments: [] });
  let leaseChecks = 0;
  const context = {
    cycleId,
    stage: 'outbound',
    intent,
    fencingToken,
    assertLease() { leaseChecks += 1; },
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    reconciliationAdapters: { robinhood: { client: sourceClient, historicalEvidenceClient }, solana: { client: solanaClient } },
    signerClient: null,
    config: baseConfig({
      accounts: { evm: operations, solana: solanaOwner },
      relay: { solanaMint, evmDepository: depository },
    }),
    cycleRepository: repository,
  });

  const evidence = await driver.reconcile(context);
  assert.equal(evidence.schema, 'hookemon.outbound-relay-settlement-evidence.v2');
  assert.equal(evidence.relayLeg.state, 'SETTLED');
  await driver.commit({ ...context, evidence });
  await repository.completeStage(cycleId, 'outbound', evidence);
  assert.equal((await repository.readStage(cycleId, 'outbound')).status, 'COMPLETE');
  assert.equal((await repository.readChainTransactionAttempt(cycleId, 'outbound', requestDigest)).attempt.state, 'FINALIZED');
  assert.equal((await repository.describeCycle(cycleId)).chainAttempts.size, 1, 'native outbound has one payable deposit and no ERC20 approval');
  assert.ok(leaseChecks > 0, 'the reconciliation facade fences durable reads and writes with the active lease');

  const replay = await driver.reconcile(context);
  assert.deepEqual(replay, evidence, 'a SETTLED replay returns canonical durable evidence without another settlement');
  const nativeLedger = (await repository.describeCycle(cycleId)).custodyLedgers.get('4663\u0000native');
  assert.equal(nativeLedger.bridgeOut, sourceAmount);
  assert.equal(nativeLedger.gasSpent.amountAtomic, '21000');
  assert.equal(nativeLedger.gasPayments.length, 1);
});

test('a provider response stays unresolved until an integration supplies independent reconciliation evidence', async () => {
  const attempts = new Map([['purchase', {
    attempt: {
      schema: 'hookemon.provider-mutation-attempt.v1',
      cycleId: CYCLE_ID,
      stage: 'purchase',
      state: 'RESPONSE_RECORDED',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      responseDigest: `sha256:${'b'.repeat(64)}`,
      reconciliationDigest: null,
    },
    responseEvidence: { memo: 'provider-response', signature: 'provider-signature' },
    reconciliationEvidence: null,
  }]]);
  const cycleRepository = fakeCycleRepository(new Map(), '0', attempts);
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: throwingCollectorCrypt(), relay: throwingRelay(), robinhood: { client: null }, solana: { client: null } },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository,
  });

  assert.equal(await driver.reconcile({ cycleId: CYCLE_ID, stage: 'purchase' }), null);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'RESPONSE_RECORDED');
});

test('a legacy Relay provider attempt cannot bypass the chain-attempt reconciliation path', async () => {
  for (const { stage, recoveryState } of [
    { stage: 'outbound', recoveryState: 'OUTBOUND_SETTLEMENT_UNATTESTED' },
    { stage: 'return', recoveryState: 'RETURN_SETTLEMENT_UNATTESTED' },
  ]) {
    const attempts = new Map([[stage, {
      attempt: {
        schema: 'hookemon.provider-mutation-attempt.v1',
        cycleId: CYCLE_ID,
        stage,
        state: 'RESPONSE_RECORDED',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        responseDigest: `sha256:${'b'.repeat(64)}`,
      },
      responseEvidence: { intent: { requestId: `unattested-${stage}-intent` } },
      reconciliationEvidence: null,
    }]]);
    const cycleRepository = fakeCycleRepository(new Map(), '0', attempts);
    const driver = createStageDriver({
      liveMode: true,
      adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
      signerClient: null,
      config: baseConfig(),
      cycleRepository,
    });
    await assert.rejects(
      () => driver.reconcile({ cycleId: CYCLE_ID, stage }),
      error => error?.recoveryState === recoveryState,
    );
  }
});

test('purchase request omits packType when no pack code is configured', async () => {
  const request = await preparePurchaseRequest({
    config: baseConfig({ accounts: { evm: null, solana: 'PLAYER11111111111111111111111111111111111' }, pack: { code: null } }),
  });
  assert.deepEqual(request, {
    provider: 'collector-crypt',
    operation: 'purchase',
    playerAddress: 'PLAYER11111111111111111111111111111111111',
    quantity: 1,
  });
});

test('collector-only rehearsal uses honest skip evidence for bridge stages', async () => {
  const driver = createStageDriver({
    liveMode: false,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({
      accounts: { evm: null, solana: '11111111111111111111111111111111' },
      rehearsal: { mode: 'collector-only', payoutRecipients: ['22222222222222222222222222222222'], split: 'equal' },
    }),
    cycleRepository: fakeCycleRepository(),
  });
  for (const stage of ['outbound', 'return']) {
    assert.deepEqual(await driver.reconcile({ cycleId: CYCLE_ID, stage }), {
      skipped: true,
      rehearsalMode: 'collector-only',
      stage,
      reason: 'Robinhood-chain leg is out of scope for the collector-only rehearsal',
    });
  }
});

test('the Collector-capable mutation stages reach their own real handler refusal in true production mode, never the frozen integration-pending error', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: throwingCollectorCrypt(), relay: throwingRelay(), robinhood: { client: null }, solana: { client: null } },
    signerClient: throwingSigner(),
    // A canonical isolated Solana identity (same placeholder as the other config.accounts.solana
    // fixtures in this file) is required so purchase's own prepareRequest clears its
    // HOOKEMON_SOLANA_ACCOUNT precondition and reaches the boundary this test actually targets.
    config: baseConfig({ accounts: { evm: null, solana: '11111111111111111111111111111111' } }),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  // purchase has no pack code configured here, so its own prepareRequest succeeds (using the now
  // real, lease-fenced collector-crypt catalog reader) and durably records PREPARED before its
  // mutate reaches its own Solana-configuration refusal. open/epic-gate/buyback each read their
  // real predecessor stage (also now genuinely wired) and refuse during preparation itself, before
  // any attempt is durably recorded.
  const expectations = {
    purchase: { duringPrepare: false, attemptState: 'NOT_SENT', message: /Collector purchase requires a configured Solana RPC client/ },
    open: { duringPrepare: true, attemptState: null, message: /open requires a completed purchase stage with a pack ledger/ },
    'epic-gate': { duringPrepare: true, attemptState: null, message: /epic gate requires a completed open stage with a pack ledger/ },
    buyback: { duringPrepare: true, attemptState: null, message: /buyback requires a completed epic-gate stage with a pack ledger/ },
  };

  for (const stage of AUTOMATED_CYCLE_STAGES.filter(stage => !['eligibility-snapshot', 'claim-process', 'outbound', 'return', 'payout'].includes(stage))) {
    const expected = expectations[stage];
    await assert.rejects(
      () => driver.execute({
        cycleId: CYCLE_ID,
        stage,
        intent: { journalHead: `pending-${stage}` },
        assertMutationAllowed: async () => {},
      }),
      error => {
        assert.equal(error instanceof LiveModeIntegrationPendingError, false, `${stage} must not hit the frozen integration-pending refusal`);
        assert.match(error.message, expected.message);
        return true;
      },
    );
    const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, stage);
    if (expected.attemptState === null) {
      assert.equal(attempt, null, `${stage} refuses during preparation, before any attempt is durably recorded`);
    } else {
      assert.equal(attempt.attempt.state, expected.attemptState);
    }
  }
});

test('a live collector-only rehearsal journals and invokes the real open handler instead of the frozen integration refusal', async () => {
  const operator = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const asset = { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };
  const attempts = new Map();
  const stages = new Map([['purchase', {
    status: 'COMPLETE',
    evidence: { quantity: 1, packs: [{ packIndex: 0, memo: 'collector-memo', status: 'purchased', expectedCardCount: 1 }] },
  }]]);
  const cycleRepository = fakeCycleRepository(stages, '0', attempts);
  let openCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async openPack({ memo }) {
          openCalls += 1;
          assert.equal(memo, 'collector-memo');
          return { nft_address: 'Card111111111111111111111111111111111111111' };
        },
      },
      relay: null,
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig({
      accounts: { evm: null, solana: operator },
      execution: { profile: 'rehearsal', providerMode: 'live' },
      signer: {
        backend: 'keychain',
        liveMode: true,
        roles: ['operator-solana'],
        keychain: { solanaAccount: 'operator-solana' },
      },
      solana: { chainId: 'solana-mainnet' },
      pack: { code: 'collector-25' },
      collectorCrypt: {
        settlementAsset: asset,
        packPrice: { ...asset, amountAtomic: '25000000' },
      },
      moneyConfiguration: {
        assets: { solanaStablecoin: asset },
        solana: { lamportReserve: { chainId: 'solana-mainnet', assetId: 'native', decimals: 9, amountAtomic: '5000000' } },
      },
      rehearsal: {
        mode: 'collector-only',
        proceedsAccount: deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58(),
        payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
        split: 'equal',
      },
    }),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'open',
    intent: { journalHead: 'collector-open' },
    assertMutationAllowed: async () => {},
  });

  assert.equal(openCalls, 1);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'open')).attempt.state, 'RESPONSE_RECORDED');
});

test('a live collector-only rehearsal records no-effect eligibility and claim stages without an EVM adapter', async () => {
  const operator = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const asset = { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({
      accounts: { evm: null, solana: operator },
      execution: { profile: 'rehearsal', providerMode: 'live' },
      signer: {
        backend: 'keychain',
        liveMode: true,
        roles: ['operator-solana'],
        keychain: { solanaAccount: 'operator-solana' },
      },
      solana: { chainId: 'solana-mainnet' },
      pack: { code: 'collector-25' },
      collectorCrypt: { settlementAsset: asset, packPrice: { ...asset, amountAtomic: '25000000' } },
      moneyConfiguration: {
        assets: { solanaStablecoin: asset },
        solana: { lamportReserve: { chainId: 'solana-mainnet', assetId: 'native', decimals: 9, amountAtomic: '5000000' } },
      },
      rehearsal: {
        mode: 'collector-only',
        proceedsAccount: deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58(),
        payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
        split: 'equal',
      },
    }),
    cycleRepository,
  });

  const eligibility = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'eligibility-snapshot' });
  assert.equal(eligibility.skipped, true);
  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    intent: { journalHead: 'collector-no-claim' },
    assertMutationAllowed: async () => {},
  });
  const claim = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'claim-process' });
  assert.equal(claim.skipped, true);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'claim-process')).attempt.state, 'RECONCILED');
});

test('the built-in eligibility snapshot completes only through read-only reconciliation', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: throwingCollectorCrypt(), relay: throwingRelay(), robinhood: { client: null }, solana: { client: null } },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository,
  });

  await assert.rejects(
    () => driver.execute({ cycleId: CYCLE_ID, stage: 'eligibility-snapshot', intent: { journalHead: 'snapshot-read-only' } }),
    /read-only reconciliation/i,
  );
  assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'eligibility-snapshot'), null);
});

test('claim-process writes a chain attempt before signing and broadcasts only its persisted bytes', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = writeAheadRepository();
  cycleRepository.readStage = async (_cycleId, stage) => stage === 'eligibility-snapshot'
    ? { status: 'COMPLETE', evidence: { finalized: true } }
    : { status: 'PENDING' };
  const broadcasted = [];
  let signCalls = 0;
  const config = baseConfig({
    contracts: {
      vault: null,
      hook: `0x${'1'.repeat(40)}`,
    },
    accounts: { evm: account.address, solana: null },
    nativeGasCaps: { robinhood: '100', solana: '1' },
    moneyConfiguration: claimMoneyConfiguration(),
  });
  const { getBlock, historicalEvidenceClient } = claimHookLiabilityArchive({ operations: account.address });
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: null,
      robinhood: {
        client: {
          async getChainId() { return 4663; },
          async getTransactionCount() { return 0n; },
          async estimateGas() { return 100n; },
          async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; },
          async getBalance() { return 1_000_000n; },
          async sendRawTransaction({ serializedTransaction }) {
            broadcasted.push(serializedTransaction);
            return keccak256(serializedTransaction);
          },
          getBlock,
        },
        historicalEvidenceClient,
      },
      solana: { client: null },
    },
    signerClient: {
      evm: {
        async sign({ transaction }) {
          signCalls += 1;
          const { from, ...unsigned } = transaction;
          return {
            signedTx: await account.signTransaction({
              ...unsigned,
              value: BigInt(unsigned.value),
              nonce: BigInt(unsigned.nonce),
              gas: BigInt(unsigned.gas),
              maxFeePerGas: BigInt(unsigned.maxFeePerGas),
              maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas),
            }),
          };
        },
      },
    },
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    intent: { journalHead: 'claim-chain-journal' },
    assertMutationAllowed: async () => {},
  });

  assert.equal(signCalls, 1);
  assert.equal(broadcasted.length, 1);
  assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'claim-process'), null);
  assert.equal(cycleRepository.chainAttempts.size, 1);
  const [{ attempt, broadcastEvidence }] = cycleRepository.chainAttempts.values();
  assert.equal(attempt.state, 'BROADCAST');
  assert.equal(attempt.rawBytes, broadcasted[0]);
  assert.equal(attempt.hash, keccak256(broadcasted[0]));
  assert.deepEqual(broadcastEvidence, { transactionHash: attempt.hash });

  const restartDriver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: null,
      robinhood: {
        client: {
          async sendRawTransaction() { throw new Error('an already-broadcast claim must reconcile before another send'); },
        },
      },
      solana: { client: null },
    },
    signerClient: { evm: { async sign() { throw new Error('an already-broadcast claim must not be signed again'); } } },
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });
  await restartDriver.execute({
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    intent: { journalHead: 'claim-chain-journal' },
    assertMutationAllowed: async () => {},
  });
  assert.equal(signCalls, 1);
  assert.equal(broadcasted.length, 1);
  assert.equal(cycleRepository.chainAttempts.size, 1);
});

test('claim-process reconciliation records a visible signed transaction after its broadcast response is lost', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = writeAheadRepository();
  cycleRepository.readStage = async (_cycleId, stage) => stage === 'eligibility-snapshot'
    ? { status: 'COMPLETE', evidence: { finalized: true } }
    : { status: 'PENDING' };
  const { getBlock, historicalEvidenceClient } = claimHookLiabilityArchive({ operations: account.address });
  const client = {
    async getChainId() { return 4663; },
    async getTransactionCount() { return 0n; },
    async estimateGas() { return 100n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; },
    async getBalance() { return 1_000_000n; },
    async sendRawTransaction() { throw new Error('broadcast response lost after acceptance'); },
    getBlock,
  };
  const config = baseConfig({
    contracts: {
      vault: null,
      hook: `0x${'1'.repeat(40)}`,
    },
    accounts: { evm: account.address, solana: null },
    nativeGasCaps: { robinhood: '100', solana: '1' },
    moneyConfiguration: claimMoneyConfiguration(),
  });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client, historicalEvidenceClient }, solana: { client: null } },
    signerClient: {
      evm: {
        async sign({ transaction }) {
          const { from, ...unsigned } = transaction;
          return {
            signedTx: await account.signTransaction({
              ...unsigned,
              value: BigInt(unsigned.value),
              nonce: BigInt(unsigned.nonce),
              gas: BigInt(unsigned.gas),
              maxFeePerGas: BigInt(unsigned.maxFeePerGas),
              maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas),
            }),
          };
        },
      },
    },
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });
  const context = {
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    intent: { journalHead: 'claim-visible-after-lost-response' },
    assertMutationAllowed: async () => {},
  };
  await assert.rejects(() => driver.execute(context), /broadcast response lost after acceptance/);
  const [{ attempt: signedAttempt }] = cycleRepository.chainAttempts.values();
  assert.equal(signedAttempt.state, 'SIGNED');
  const parsed = parseTransaction(signedAttempt.rawBytes);
  client.getTransaction = async () => ({
    hash: signedAttempt.hash,
    from: account.address,
    to: parsed.to,
    input: parsed.input ?? parsed.data,
    value: 0n,
  });
  client.getTransactionReceipt = async () => { throw new Error('accepted transaction is not mined yet'); };

  assert.equal(await driver.reconcile(context), null);
  const [{ attempt, broadcastEvidence }] = cycleRepository.chainAttempts.values();
  assert.equal(attempt.state, 'BROADCAST');
  assert.deepEqual(broadcastEvidence, { transactionHash: signedAttempt.hash });
});

test('claim-process refuses a legacy sent-unknown provider attempt before creating a chain attempt', async () => {
  const cycleRepository = writeAheadRepository();
  cycleRepository.readStage = async (_cycleId, stage) => stage === 'eligibility-snapshot'
    ? { status: 'COMPLETE', evidence: { finalized: true } }
    : { status: 'PENDING' };
  await cycleRepository.prepareStageAttempt(CYCLE_ID, 'claim-process', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    state: 'SENT_UNKNOWN',
    requestDigest: `sha256:${'d'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: throwingSigner(),
    config: baseConfig({
      contracts: { vault: null, hook: `0x${'1'.repeat(40)}` },
      accounts: { evm: `0x${'2'.repeat(40)}`, solana: null },
    }),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      intent: { journalHead: 'legacy-claim-send-unknown' },
      assertMutationAllowed: async () => {},
    }),
    /legacy provider attempt is sent-unknown and requires reconciliation/,
  );
  assert.equal(cycleRepository.chainAttempts.size, 0);
});

test('epic gate treats an offer equal to forty percent of insured value as sellable', async () => {
  const stages = new Map([['open', {
    status: 'COMPLETE',
    evidence: {
      offer: {
        chainId: 'solana:mainnet',
        assetId: 'solana:mainnet/spl:stablecoin',
        decimals: 6,
        amountAtomic: '40',
      },
      insuredValue: {
        chainId: 'solana:mainnet',
        assetId: 'solana:mainnet/spl:stablecoin',
        decimals: 6,
        amountAtomic: '100',
      },
    },
  }]]);
  const driver = createStageDriver({
    liveMode: false,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: fakeCycleRepository(stages),
  });
  assert.deepEqual(await driver.reconcile({ cycleId: CYCLE_ID, stage: 'epic-gate' }), {
    wouldEvaluateEpicGate: true,
    configured: true,
    offer: {
      chainId: 'solana:mainnet',
      assetId: 'solana:mainnet/spl:stablecoin',
      decimals: 6,
      amountAtomic: '40',
    },
    insuredValue: {
      chainId: 'solana:mainnet',
      assetId: 'solana:mainnet/spl:stablecoin',
      decimals: 6,
      amountAtomic: '100',
    },
    belowFortyPercent: false,
    nextAction: 'sell',
  });
});

test('epic gate refuses incomparable typed amounts', async () => {
  const stages = new Map([['open', {
    status: 'COMPLETE',
    evidence: {
      offer: {
        chainId: 'solana:mainnet',
        assetId: 'solana:mainnet/spl:stablecoin',
        decimals: 6,
        amountAtomic: '39',
      },
      insuredValue: {
        chainId: 'eip155:4663',
        assetId: 'eip155:4663/erc20:stablecoin',
        decimals: 6,
        amountAtomic: '100',
      },
    },
  }]]);
  const driver = createStageDriver({
    liveMode: false,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: fakeCycleRepository(stages),
  });

  assert.deepEqual(await driver.reconcile({ cycleId: CYCLE_ID, stage: 'epic-gate' }), {
    wouldEvaluateEpicGate: true,
    configured: false,
    reason: 'open evidence does not contain comparable typed offer and insured-value amounts',
  });
});

function writeAheadRepository() {
  const attempts = new Map();
  const chainAttempts = new Map();
  const custodyLedgers = new Map();
  const keyFor = (cycleId, stage) => `${cycleId}:${stage}`;
  const chainKeyFor = (cycleId, stage, requestDigest) => `${cycleId}:${stage}:${requestDigest}`;
  const custodyKeyFor = ledger => `${ledger.chainId}\u0000${ledger.assetId}`;
  return {
    attempts,
    chainAttempts,
    custodyLedgers,
    async readStage() { return { status: 'PENDING' }; },
    async readClaimPreconditions() { return { heldAssets: false, unattributed: false, unresolvedObligations: false }; },
    async describeCycle() { return { releaseAmount: '1', admission: { ...nativeAdmissionFixture(CYCLE_ID, { amountWei: '1' }), packId: undefined }, chainAttempts: new Map(chainAttempts), custodyLedgers: new Map(custodyLedgers) }; },
    async readStageAttempt(cycleId, stage) {
      const record = attempts.get(keyFor(cycleId, stage));
      return record?.responseEvidence ?? null;
    },
    async readOperationalStageAttempt(cycleId, stage) {
      return attempts.get(keyFor(cycleId, stage)) ?? null;
    },
    async prepareStageAttempt(cycleId, stage, attempt) {
      attempts.set(keyFor(cycleId, stage), { attempt, responseEvidence: null, reconciliationEvidence: null });
    },
    async markStageAttemptSentUnknown(cycleId, stage) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'SENT_UNKNOWN' };
    },
    async markStageAttemptNotSent(cycleId, stage) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'NOT_SENT' };
    },
    async recordStageAttemptResponse(cycleId, stage, evidence) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'RESPONSE_RECORDED', responseDigest: `sha256:${'e'.repeat(64)}` };
      record.responseEvidence = evidence;
    },
    async reconcileStageAttempt(cycleId, stage, evidence) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'RECONCILED', reconciliationDigest: `sha256:${'f'.repeat(64)}` };
      record.reconciliationEvidence = evidence;
    },
    async readChainTransactionAttempt(cycleId, stage, requestDigest) {
      return chainAttempts.get(chainKeyFor(cycleId, stage, requestDigest)) ?? null;
    },
    async prepareChainTransactionAttempt(cycleId, stage, attempt) {
      const key = chainKeyFor(cycleId, stage, attempt.requestDigest);
      const record = { attempt, broadcastEvidence: null, finalityEvidence: null };
      chainAttempts.set(key, record);
      return record;
    },
    async recordSignedTransaction(cycleId, stage, requestDigest, material) {
      const key = chainKeyFor(cycleId, stage, requestDigest);
      const previous = chainAttempts.get(key);
      const record = { ...previous, attempt: { ...previous.attempt, state: 'SIGNED', ...material } };
      chainAttempts.set(key, record);
      return record;
    },
    async recordBroadcast(cycleId, stage, requestDigest, evidence) {
      const key = chainKeyFor(cycleId, stage, requestDigest);
      const previous = chainAttempts.get(key);
      const record = { ...previous, attempt: { ...previous.attempt, state: 'BROADCAST' }, broadcastEvidence: evidence };
      chainAttempts.set(key, record);
      return record;
    },
    async recordCustodyLedger(_cycleId, ledger) {
      custodyLedgers.set(custodyKeyFor(ledger), ledger);
    },
    async recordFinality(cycleId, stage, requestDigest, evidence) {
      const key = chainKeyFor(cycleId, stage, requestDigest);
      const previous = chainAttempts.get(key);
      const record = { ...previous, attempt: { ...previous.attempt, state: 'FINALIZED' }, finalityEvidence: evidence };
      chainAttempts.set(key, record);
      return record;
    },
  };
}

test('generic live reconciliation cannot complete without a prepared provider attempt', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async mutate() { throw new Error('mutation must not run during reconciliation'); },
        async reconcileLive() { return { observer: 'unexpected-without-attempt', finalized: true }; },
      },
    },
  });

  assert.equal(await driver.reconcile({ cycleId: CYCLE_ID, stage: 'purchase' }), null);
  assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase'), null);
});

test('records NOT_SENT when provisional authority refuses before an injected live handler can mutate', async () => {
  const cycleRepository = writeAheadRepository();
  let mutationCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return { dryRun: true }; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() { mutationCalls += 1; return { providerReceipt: 'should-not-exist' }; },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({ cycleId: CYCLE_ID, stage: 'purchase', intent: { journalHead: 'authority-head' } }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(mutationCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'NOT_SENT');
});

test('persists PREPARED before a provider call and lets reconcileLive perform the only completion advance', async () => {
  const cycleRepository = writeAheadRepository();
  let observedPrepared = false;
  let observedRequest = null;
  const preparedRequest = {
    provider: 'collector-test',
    playerAddress: 'PLAYER11111111111111111111111111111111111',
    packCode: 'pack-1',
  };
  const stageHandlers = {
    purchase: {
      async probe() { return { dryRun: true }; },
      async prepareRequest() { return preparedRequest; },
      async mutate({ request }) {
        const record = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase');
        observedPrepared = record?.attempt.state === 'PREPARED';
        assert.equal(Object.isFrozen(request), true);
        observedRequest = request;
        return { providerReceipt: 'provider-receipt-1' };
      },
      async reconcileLive() {
        const record = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase');
        return record?.responseEvidence === null || record?.responseEvidence === undefined
          ? null
          : { observer: 'test-finality', providerReceipt: record.responseEvidence.providerReceipt, finalized: true };
      },
    },
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers,
    ...fixtureStageDriverOptions,
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-1' },
    assertMutationAllowed: async () => {},
  });
  assert.equal(observedPrepared, true, 'the provider call must observe its persisted PREPARED attempt');
  assert.deepEqual(observedRequest, preparedRequest, 'the provider call receives the request whose digest was prepared');
  assert.equal(
    (await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.requestDigest,
    digest({ schema: 'hookemon.operational-stage-request.v1', cycleId: CYCLE_ID, stage: 'purchase', request: preparedRequest }),
  );
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'RESPONSE_RECORDED');

  const evidence = await driver.reconcile({ cycleId: CYCLE_ID, stage: 'purchase' });
  assert.deepEqual(evidence, { observer: 'test-finality', providerReceipt: 'provider-receipt-1', finalized: true });
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'RECONCILED');
});

test('limits request preparation to frozen canonical data without effectful capabilities', async () => {
  const cycleRepository = writeAheadRepository();
  const config = baseConfig({ pack: { code: 'pack-1' } });
  let preparationInput;
  let preparationComplete = false;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: { solana: { async sign() { throw new Error('signer must not be available during preparation'); } } },
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest(input) {
          preparationInput = input;
          preparationComplete = true;
          return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' };
        },
        async mutate() { return { providerReceipt: 'provider-receipt-1' }; },
        async reconcileLive() { return null; },
      },
    },
  });
  const context = {
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-capabilities' },
    lease: { fencingToken: 7 },
    runner: { async run() { throw new Error('runner must not be available during preparation'); } },
    assertLease() {},
    async assertMutationAllowed() {
      assert.equal(preparationComplete, true, 'mutation authority must not run during preparation');
    },
  };

  await driver.execute(context);

  assert.deepEqual(Object.keys(preparationInput).sort(), ['config', 'context', 'liveMode']);
  assert.equal(Object.isFrozen(preparationInput), true);
  assert.equal(Object.isFrozen(preparationInput.config), true);
  assert.equal(Object.isFrozen(preparationInput.context), true);
  assert.deepEqual(preparationInput.context, {
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-capabilities' },
  });
  assert.equal('adapters' in preparationInput, false);
  assert.equal('signerClient' in preparationInput, false);
  assert.equal('cycleRepository' in preparationInput, false);
  assert.notEqual(preparationInput.config, config);
});

test('removes standing authority providers and resolvers from handler configuration', async () => {
  const cycleRepository = writeAheadRepository();
  const provider = {
    verifyStepAuthorization() { throw new Error('provider must not reach request preparation'); },
  };
  const resolveStepAuthorization = () => {
    throw new Error('resolver must not reach request preparation');
  };
  let handlerConfig = null;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({
      standingAuthority: {
        documentDigest: `sha256:${'a'.repeat(64)}`,
        provider,
        resolveStepAuthorization,
      },
      standingAuthorityStepAuthorization: resolveStepAuthorization,
    }),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest({ config }) {
          handlerConfig = config;
          return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' };
        },
        async mutate() { return { providerReceipt: 'handler-config-redaction' }; },
        async reconcileLive() { return null; },
      },
    },
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'handler-config-redaction' },
    async assertMutationAllowed() {},
  });

  assert.equal('standingAuthorityStepAuthorization' in handlerConfig, false);
  assert.equal('provider' in handlerConfig.standingAuthority, false);
  assert.equal('resolveStepAuthorization' in handlerConfig.standingAuthority, false);
});

test('strips the trusted Solana blockhashContextResolver out of ordinary purchase request preparation', async () => {
  const cycleRepository = writeAheadRepository();
  let handlerConfig = null;
  const resolver = async blockhash => ({ blockhash, lastValidBlockHeight: '100' });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({ solana: { chainId: 'solana-mainnet', blockhashContextResolver: resolver } }),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest({ config }) {
          handlerConfig = config;
          return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' };
        },
        async mutate() { return { providerReceipt: 'handler-config-blockhash-redaction' }; },
        async reconcileLive() { return null; },
      },
    },
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'handler-config-blockhash-redaction' },
    async assertMutationAllowed() {},
  });

  assert.equal(handlerConfig.solana.chainId, 'solana-mainnet');
  assert.notEqual(typeof handlerConfig.solana.blockhashContextResolver, 'function');
});

test('the production supplementary reconcile mutation boundary receives the real trusted Solana blockhashContextResolver, while the rest of config stays frozen and canonical', async () => {
  const position = {
    positionId: `held:${'a'.repeat(64)}`,
    cycleId: CYCLE_ID,
    packId: 'base-pack',
    memo: 'memo-supplementary-blockhash',
    mint: 'mint-supplementary-blockhash',
    cardRef: 'mint-supplementary-blockhash',
    costMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'1'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  let settlement = {
    positionId: position.positionId,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:9`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  const repository = fakeCycleRepository();
  repository.readSupplementarySettlement = async () => structuredClone(settlement);
  repository.advanceSupplementarySettlement = async (positionId, input) => {
    settlement = { ...settlement, state: input.nextState };
    return structuredClone(settlement);
  };

  let resolverCalls = 0;
  let observedBlockhash = null;
  const resolver = async blockhash => {
    resolverCalls += 1;
    observedBlockhash = blockhash;
    return { blockhash, lastValidBlockHeight: '4242' };
  };
  let receivedConfig = null;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({ solana: { chainId: 'solana-mainnet', blockhashContextResolver: resolver } }),
    cycleRepository: repository,
    supplementaryAdapters: Object.freeze({}),
    supplementarySignerClient: Object.freeze({}),
    productionSupplementaryStageHandlers: {
      PREPARED: {
        stage: 'supplementary-buyback',
        mutation: 'buyback',
        async reconcile({ config, cycleRepository: injectedRepository, settlement: receivedSettlement }) {
          receivedConfig = config;
          return injectedRepository.advanceSupplementarySettlement(position.positionId, {
            expectedState: receivedSettlement.state,
            nextState: 'BUYBACK_SENT_UNKNOWN',
            evidence: { requestDigest: `sha256:${'2'.repeat(64)}` },
          });
        },
      },
    },
  });

  const result = await driver.runSupplementarySettlement({
    position,
    settlement,
    nowMs: 1_001,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {},
  });

  assert.equal(result.status, 'ADVANCED');
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(Object.isFrozen(receivedConfig), true);
  assert.equal(Object.isFrozen(receivedConfig.solana), true);
  assert.equal(receivedConfig.solana.chainId, 'solana-mainnet');
  assert.equal(typeof receivedConfig.solana.blockhashContextResolver, 'function');
  assert.deepEqual(
    await receivedConfig.solana.blockhashContextResolver('observed-blockhash-xyz'),
    { blockhash: 'observed-blockhash-xyz', lastValidBlockHeight: '4242' },
  );
  assert.equal(resolverCalls, 1);
  assert.equal(observedBlockhash, 'observed-blockhash-xyz');
});

test('fences injected provider and signer calls immediately before they run', async () => {
  const calls = { provider: 0, signer: 0 };
  const cases = [
    {
      name: 'provider',
      invoke({ adapters }) {
        return adapters.collectorCrypt.submitTransaction({});
      },
    },
    {
      name: 'signer',
      invoke({ signerClient }) {
        return signerClient.solana.sign({});
      },
    },
  ];

  for (const { name, invoke } of cases) {
    const cycleRepository = writeAheadRepository();
    let leaseCurrent = true;
    const adapters = Object.freeze({
      collectorCrypt: Object.freeze({
        async submitTransaction() {
          calls.provider += 1;
          return { signature: 'provider-signature-1' };
        },
      }),
      relay: null,
      robinhood: Object.freeze({ client: null }),
      solana: Object.freeze({ client: null }),
    });
    const signerClient = Object.freeze({
      solana: Object.freeze({
        async sign() {
          calls.signer += 1;
          return { signedTxBase64: 'signed' };
        },
      }),
    });
    const driver = createStageDriver({
      liveMode: true,
      adapters,
      signerClient,
      config: baseConfig(),
      cycleRepository,
      ...fixtureStageDriverOptions,
      stageHandlers: {
        purchase: {
          async probe() { return null; },
          async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
          async mutate(capabilities) {
            assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'PREPARED');
            leaseCurrent = false;
            return invoke(capabilities);
          },
          async reconcileLive() { return null; },
        },
      },
    });

    await assert.rejects(
      () => driver.execute({
        cycleId: CYCLE_ID,
        stage: 'purchase',
        intent: { journalHead: `head-fenced-${name}` },
        assertLease() {
          if (!leaseCurrent) throw new Error('lease expired before effectful call');
        },
        assertMutationAllowed: async () => {},
      }),
      /lease expired/,
    );
    assert.equal(calls[name], 0);
    assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'NOT_SENT');
  }
});

test('rejects undefined live reconciliation evidence without advancing the attempt', async () => {
  const cycleRepository = writeAheadRepository();
  await cycleRepository.prepareStageAttempt(CYCLE_ID, 'purchase', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId: CYCLE_ID,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });
  await cycleRepository.recordStageAttemptResponse(CYCLE_ID, 'purchase', { providerReceipt: 'provider-receipt-1' });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async mutate() { throw new Error('mutation must not run during reconciliation'); },
        async reconcileLive() { return undefined; },
      },
    },
  });

  await assert.rejects(
    () => driver.reconcile({ cycleId: CYCLE_ID, stage: 'purchase' }),
    /reconcileLive must return null or a canonical evidence value/,
  );
  const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase');
  assert.equal(attempt.attempt.state, 'RESPONSE_RECORDED');
  assert.equal(attempt.reconciliationEvidence, null);
});

test('persists NOT_SENT before an injected capability and retries the same request after reopen', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  let refusalsRemaining = 1;
  let effects = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() {
          if (refusalsRemaining > 0) {
            refusalsRemaining -= 1;
            throw new Error('policy refused before effect');
          }
          effects += 1;
          return { providerReceipt: 'retry-receipt' };
        },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'purchase',
      intent: { journalHead: 'head-pre-effect-refusal' },
      assertMutationAllowed: async () => {},
    }),
    /policy refused before effect/,
  );
  assert.equal(effects, 0);
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'NOT_SENT');

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'NOT_SENT');
  const retryDriver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: reopened,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() { effects += 1; return { providerReceipt: 'retry-receipt' }; },
        async reconcileLive() { return null; },
      },
    },
  });
  await retryDriver.execute({
    cycleId,
    stage: 'purchase',
    intent: { journalHead: 'head-pre-effect-refusal' },
    assertMutationAllowed: async () => {},
  });
  assert.equal(effects, 1);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'RESPONSE_RECORDED');
});

test('keeps a keychain interaction denial retryable with redacted OS text before any broadcast', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const secret = `0x${'a'.repeat(64)}`;
  let keychainCalls = 0;
  let broadcasts = 0;
  const keychain = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureStageDriverOptions,
    exec: async () => {
      keychainCalls += 1;
      return { code: 1, stdout: '', stderr: `User interaction is not allowed; credential=${secret}` };
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-primary',
  });
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: null,
      robinhood: { client: { async sendRawTransaction() { broadcasts += 1; } } },
      solana: { client: null },
    },
    signerClient: { solana: keychain },
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ signerClient }) { return signerClient.solana.sign({ bytes: 'unsigned' }); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'purchase',
      intent: { journalHead: 'keychain-interaction-denied' },
      assertMutationAllowed: async () => {},
    }),
    error => {
      assert.match(error.message, /User interaction is not allowed/);
      assert.doesNotMatch(error.message, new RegExp(secret.slice(2, 16)));
      return true;
    },
  );
  assert.equal(keychainCalls, 1);
  assert.equal(broadcasts, 0);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const cycle = await reopened.describeCycle(cycleId);
  assert.equal(cycle.terminalState, null);
  assert.equal(cycle.terminalEvidence, null);
  assert.equal(cycle.operationalAttempts.get('purchase').attempt.state, 'NOT_SENT');
  assert.equal((await reopened.readActiveCycle()).cycleId, cycleId);
});

test('keeps an expired Relay quote retryable before any request or broadcast', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  let requests = 0;
  let broadcasts = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: { async quoteOutboundBridge() { requests += 1; } },
      robinhood: { client: { async sendRawTransaction() { broadcasts += 1; } } },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      outbound: {
        async probe() { return null; },
        async prepareRequest() {
          throw new RelayQuoteExpiredError('Relay quote expired at the recorded deadline');
        },
        async mutate() { throw new Error('expired quote must not reach mutation'); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'outbound',
      intent: { journalHead: 'expired-relay-quote' },
      assertMutationAllowed: async () => {},
    }),
    RelayQuoteExpiredError,
  );
  assert.equal(requests, 0);
  assert.equal(broadcasts, 0);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, null);
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'outbound'), null);
  assert.equal((await reopened.readActiveCycle()).cycleId, cycleId);
});

test('keeps a lost lease retryable before a provider effect and retains a NOT_SENT record', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  let effects = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() { effects += 1; return { providerReceipt: 'must-not-exist' }; },
        async reconcileLive() { return null; },
      },
    },
  });
  const lost = new LeaseLostError('expired', { owner: 'cycle-runner', version: 4 });

  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'purchase',
      intent: { journalHead: 'lost-lease-before-effect' },
      assertLease() { throw lost; },
      assertMutationAllowed: async () => {},
    }),
    LeaseLostError,
  );
  assert.equal(effects, 0);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.terminalEvidence, null);
  assert.equal(state.operationalAttempts.get('purchase').attempt.state, 'NOT_SENT');
  assert.equal((await reopened.readActiveCycle()).cycleId, cycleId);
});

async function assertPolicyRefusalHeldForOwnerDecision(t, message) {
  const { directory, repository, cycleId } = await durableCycle(t);
  let broadcasts = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: null,
      robinhood: { client: { async sendRawTransaction() { broadcasts += 1; } } },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() { throw new TransactionPolicyError(message); },
        async reconcileLive() { return null; },
      },
    },
  });
  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'purchase',
      intent: { journalHead: `policy-${message}` },
      assertMutationAllowed: async () => {},
    }),
    TransactionPolicyError,
  );
  assert.equal(broadcasts, 0, 'a semantically wrong request must never reach a signature or broadcast');
  // Durable across reopen: a real repository, not an in-memory fixture, so this proves the hold and
  // the NOT_SENT attempt both survive a process restart rather than only living in this instance.
  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.deepEqual(state.terminalEvidence, { stage: 'purchase', reason: 'TRANSACTION_POLICY_REFUSED', error: message });
  assert.equal(state.operationalAttempts.get('purchase').attempt.state, 'NOT_SENT');
  // A held cycle stays "active" (not archived) until an explicit owner decision resolves it; it is
  // never automatically re-prepared.
  const active = await reopened.readActiveCycle();
  assert.equal(active.cycleId, cycleId);
  assert.equal(active.terminalState, 'HELD_DATA_UNVERIFIED');
}

test('holds a wrong-asset transaction policy refusal before signing', async t => {
  await assertPolicyRefusalHeldForOwnerDecision(t, 'transaction policy refused a wrong asset');
});

test('holds a wrong-recipient transaction policy refusal before signing', async t => {
  await assertPolicyRefusalHeldForOwnerDecision(t, 'transaction policy refused a wrong recipient');
});

test('keeps an expired return blockhash retryable while retaining a broadcast attempt after reopen', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const requestDigest = `sha256:${'d'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'return', createPreparedChainTransactionAttempt({
    cycleId,
    stage: 'return',
    requestDigest,
  }));
  await repository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: Buffer.from('return-signed-bytes').toString('base64'),
    nonce: null,
    blockhash: 'return-blockhash',
    hash: `sha256:${'e'.repeat(64)}`,
  });
  await repository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: 'return-broadcast-signature' });
  let effects = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      return: {
        async probe() { return null; },
        async prepareRequest() { return { source: 'durable-broadcast' }; },
        async mutate() { effects += 1; return null; },
        async reconcileLive() {
          throw new ReturnRecoveryRequiredError(
            'RETURN_SIGNED_BLOCKHASH_EXPIRED',
            'the stored return blockhash is expired',
          );
        },
      },
    },
  });

  await assert.rejects(
    () => driver.reconcile({ cycleId, stage: 'return' }),
    ReturnRecoveryRequiredError,
  );
  assert.equal(effects, 0);
  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, null);
  assert.equal((await reopened.readChainTransactionAttempt(cycleId, 'return', requestDigest)).attempt.state, 'BROADCAST');
  assert.equal((await reopened.readActiveCycle()).cycleId, cycleId);
});

test('records NOT_SENT when a signer refuses before any provider send', async () => {
  const cycleRepository = writeAheadRepository();
  let signerCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      solana: {
        async sign() {
          signerCalls += 1;
          throw new Error('signer refused the request');
        },
      },
    },
    config: baseConfig(),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ signerClient }) { return signerClient.solana.sign({ bytes: 'unsigned' }); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'purchase',
      intent: { journalHead: 'head-signer-refusal' },
      assertMutationAllowed: async () => {},
    }),
    /signer refused/,
  );
  assert.equal(signerCalls, 1);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'NOT_SENT');
});

test('production signing refuses a missing standing authority before the raw signer', async () => {
  const cycleRepository = writeAheadRepository();
  let signerCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      evm: {
        async sign() {
          signerCalls += 1;
          return { signedTx: 'must-not-be-returned' };
        },
      },
    },
    config: baseConfig({ execution: { profile: 'production', providerMode: 'live' } }),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      outbound: {
        async probe() { return null; },
        async prepareRequest() { return { relayRequestId: 'authority-required' }; },
        async mutate({ signerClient }) { return signerClient.evm.sign({ transaction: 'unsigned' }); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'outbound',
      intent: { journalHead: 'missing-standing-authority' },
      async assertMutationAllowed() {},
    }),
    /production signing requires a verified standing authority document/,
  );
  assert.equal(signerCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'outbound')).attempt.state, 'NOT_SENT');
});

test('production signing refuses an expired standing authority before it reserves capacity or reaches the raw signer', async () => {
  const fixture = createProductionTestFixture({
    moneyConfiguration: claimMoneyConfiguration(),
    standingAuthorityIssuedAt: '2000-01-01T00:00:00.000Z',
    standingAuthorityExpiresAt: '2001-01-01T00:00:00.000Z',
  });
  const authorization = buildAndSignStepAuthorization(fixture, {
    cycleId: CYCLE_ID,
    actionKind: 'outbound',
    authorizationKind: 'sign',
    subjectDigest: `sha256:${'a'.repeat(64)}`,
    destination: fixture.standingAuthority.allowedDestinations[0],
    pack: fixture.standingAuthority.allowedPacks[0],
    spendAmount: '10',
    nonce: 'expired-standing-authority-sign',
    issuedAt: '2000-06-01T00:00:00.000Z',
  });
  let decisionWrites = 0;
  const cycleRepository = {
    ...writeAheadRepository(),
    async readStandingAuthorityDecision() { return null; },
    async recordStandingAuthorityDecision() {
      decisionWrites += 1;
      throw new Error('expired authority must not reserve a decision');
    },
  };
  let signerCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      evm: {
        async sign() {
          signerCalls += 1;
          return { signedTx: 'must-not-be-returned' };
        },
      },
    },
    config: baseConfig({
      execution: { profile: 'production', providerMode: 'live' },
      standingAuthority: { ...fixture.standingAuthority, provider: fixture.standingAuthorityProvider },
      standingAuthorityStepAuthorization() { return authorization; },
    }),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      outbound: {
        async probe() { return null; },
        async prepareRequest() { return { relayRequestId: 'expired-standing-authority' }; },
        async mutate({ signerClient }) { return signerClient.evm.sign({ transaction: 'unsigned' }); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'outbound',
      intent: { journalHead: 'expired-standing-authority' },
      async assertMutationAllowed() {},
    }),
    /standing authority is expired/,
  );
  assert.equal(decisionWrites, 0);
  assert.equal(signerCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'outbound')).attempt.state, 'NOT_SENT');
});

test('production signing rejects a policy-signed authorization for a different prepared request before signing or broadcast', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const fixture = createProductionTestFixture({ moneyConfiguration: claimMoneyConfiguration() });
  const authorization = buildAndSignStepAuthorization(fixture, {
    cycleId,
    actionKind: 'outbound',
    authorizationKind: 'sign',
    subjectDigest: `sha256:${'b'.repeat(64)}`,
    destination: fixture.standingAuthority.allowedDestinations[0],
    pack: fixture.standingAuthority.allowedPacks[0],
    spendAmount: '10',
    nonce: 'different-prepared-request',
  });
  let resolverRequest = null;
  let signerCalls = 0;
  let broadcasts = 0;
  let decisionWrites = 0;
  const recordStandingAuthorityDecision = repository.recordStandingAuthorityDecision.bind(repository);
  repository.recordStandingAuthorityDecision = async (...args) => {
    decisionWrites += 1;
    return recordStandingAuthorityDecision(...args);
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: null,
      robinhood: {
        client: {
          async sendRawTransaction() {
            broadcasts += 1;
            return 'must-not-broadcast';
          },
        },
      },
      solana: { client: null },
    },
    signerClient: {
      evm: {
        async sign() {
          signerCalls += 1;
          return { signedTx: 'must-not-sign' };
        },
      },
    },
    config: baseConfig({
      execution: { profile: 'production', providerMode: 'live' },
      standingAuthority: { ...fixture.standingAuthority, provider: fixture.standingAuthorityProvider },
      standingAuthorityStepAuthorization(request) {
        resolverRequest = request;
        return authorization;
      },
    }),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      outbound: {
        async probe() { return null; },
        async prepareRequest() { return { relayRequestId: 'different-prepared-request' }; },
        async mutate({ signerClient, adapters }) {
          await signerClient.evm.sign({ transaction: 'unsigned' });
          return adapters.robinhood.client.sendRawTransaction('must-not-broadcast');
        },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'outbound',
      intent: { journalHead: 'different-prepared-request' },
      async assertMutationAllowed() {},
    }),
    /does not bind the prepared request digest/,
  );
  assert.notEqual(resolverRequest.requestDigest, authorization.subjectDigest);
  assert.equal(signerCalls, 0);
  assert.equal(broadcasts, 0);
  assert.equal(decisionWrites, 0);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.standingAuthorityDecisions.size, 0);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'outbound')).attempt.state, 'NOT_SENT');
});

test('production signing replays a stored authority after expiry with one signer and a reopened reconciliation attempt', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const fixture = createProductionTestFixture({
    moneyConfiguration: claimMoneyConfiguration(),
    standingAuthorityIssuedAt: '2000-01-01T00:00:00.000Z',
    standingAuthorityExpiresAt: '2001-01-01T00:00:00.000Z',
  });
  const request = { relayRequestId: 'stored-authority-replay' };
  const requestDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId,
    stage: 'outbound',
    request,
  });
  const authorization = buildAndSignStepAuthorization(fixture, {
    cycleId,
    actionKind: 'outbound',
    authorizationKind: 'sign',
    subjectDigest: requestDigest,
    destination: fixture.standingAuthority.allowedDestinations[0],
    pack: fixture.standingAuthority.allowedPacks[0],
    spendAmount: '10',
    nonce: 'stored-authority-replay',
    issuedAt: '2000-06-01T00:00:00.000Z',
  });
  let decisionWrites = 0;
  const recordStandingAuthorityDecision = repository.recordStandingAuthorityDecision.bind(repository);
  repository.recordStandingAuthorityDecision = async (...args) => {
    decisionWrites += 1;
    return recordStandingAuthorityDecision(...args);
  };
  await fixture.standingAuthorityProvider.verifyAndRecordStepAuthorization(authorization, {
    cycleRepository: repository,
    now: '2000-06-01T00:00:01.000Z',
  });
  assert.equal(decisionWrites, 1);

  let signerCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      evm: {
        async sign() {
          signerCalls += 1;
          return { signedTx: 'replayed-signature' };
        },
      },
    },
    config: baseConfig({
      execution: { profile: 'production', providerMode: 'live' },
      standingAuthority: { ...fixture.standingAuthority, provider: fixture.standingAuthorityProvider },
      standingAuthorityStepAuthorization() { return authorization; },
    }),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      outbound: {
        async probe() { return null; },
        async prepareRequest() { return request; },
        async mutate({ signerClient }) { return signerClient.evm.sign({ transaction: 'replay' }); },
        async reconcileLive() { return null; },
      },
    },
  });

  await driver.execute({
    cycleId,
    stage: 'outbound',
    intent: { journalHead: 'stored-authority-replay' },
    async assertMutationAllowed() {},
  });
  assert.equal(signerCalls, 1);
  assert.equal(decisionWrites, 1);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.standingAuthorityDecisions.size, 1);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'outbound')).attempt.state, 'RESPONSE_RECORDED');

  const reopenedDriver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      evm: {
        async sign() {
          signerCalls += 1;
          return { signedTx: 'must-not-sign-again' };
        },
      },
    },
    config: baseConfig({
      execution: { profile: 'production', providerMode: 'live' },
      standingAuthority: { ...fixture.standingAuthority, provider: fixture.standingAuthorityProvider },
      standingAuthorityStepAuthorization() { return authorization; },
    }),
    cycleRepository: reopened,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      outbound: {
        async probe() { return null; },
        async prepareRequest() { return request; },
        async mutate({ signerClient }) { return signerClient.evm.sign({ transaction: 'must-not-sign-again' }); },
        async reconcileLive() { return null; },
      },
    },
  });
  const context = {
    cycleId,
    stage: 'outbound',
    intent: { journalHead: 'stored-authority-replay' },
    async assertMutationAllowed() {},
  };
  await assert.rejects(() => reopenedDriver.execute(context), /requires reconciliation/);
  assert.equal(await reopenedDriver.reconcile(context), null);
  assert.equal(signerCalls, 1);
  assert.equal(decisionWrites, 1);
});

test('reconciliation receives only lease-fenced read capabilities', async () => {
  const cycleRepository = {
    ...writeAheadRepository(),
    async holdCycle() { throw new Error('reconciliation must not receive a repository writer'); },
  };
  await cycleRepository.prepareStageAttempt(CYCLE_ID, 'return', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId: CYCLE_ID,
    stage: 'return',
    state: 'PREPARED',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });
  await cycleRepository.recordStageAttemptResponse(CYCLE_ID, 'return', { providerReceipt: 'provider-receipt-1' });
  let readCalls = 0;
  let leaseCurrent = true;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async submitTransaction() { throw new Error('reconciliation must not receive mutation adapters'); },
      },
      relay: null,
      robinhood: { client: null },
      solana: { client: null },
    },
    reconciliationAdapters: {
      collectorCrypt: {
        async readStatus() {
          readCalls += 1;
          return { status: 'finalized' };
        },
      },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      return: {
        async probe() { return null; },
        async mutate() { throw new Error('mutation must not run during reconciliation'); },
        async reconcileLive({ adapters, cycleRepository }) {
          assert.equal(typeof adapters.collectorCrypt.submitTransaction, 'undefined');
          assert.equal(typeof cycleRepository.holdCycle, 'undefined');
          leaseCurrent = false;
          return adapters.collectorCrypt.readStatus();
        },
      },
    },
  });

  await assert.rejects(
    () => driver.reconcile({
      cycleId: CYCLE_ID,
      stage: 'return',
      intent: { journalHead: 'head-read-fence' },
      assertLease() {
        if (!leaseCurrent) throw new Error('lease expired before reconciliation read');
      },
    }),
    /lease expired before reconciliation read/,
  );
  assert.equal(readCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'return')).attempt.state, 'RESPONSE_RECORDED');
});

test('does not repeat a provider mutation after a post-send error leaves an attempt unknown', async () => {
  const cycleRepository = writeAheadRepository();
  let providerCalls = 0;
  const stageHandlers = {
    purchase: {
      async probe() { return { dryRun: true }; },
      async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
      async mutate({ adapters }) {
        assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'PREPARED');
        await adapters.collectorCrypt.submitTransaction({ signedTransaction: 'signed-1' });
        throw new Error('response lost after provider acceptance');
      },
      async reconcileLive() { return null; },
    },
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async submitTransaction() {
          providerCalls += 1;
          return { signature: 'provider-signature-1' };
        },
      },
      relay: null,
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(() => driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-2' },
    assertMutationAllowed: async () => {},
  }), /response lost/);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'SENT_UNKNOWN');
  await assert.rejects(() => driver.execute({ cycleId: CYCLE_ID, stage: 'purchase', intent: { journalHead: 'head-2' } }), /reconciliation/);
  assert.equal(providerCalls, 1);
});

test('keeps a Collector committed-then-503 attempt SENT_UNKNOWN after reopen until reconciliation', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  let providerCalls = 0;
  const stageHandlers = {
    purchase: {
      async probe() { return null; },
      async prepareRequest() { return { provider: 'collector-test', operation: 'purchase' }; },
      async mutate({ adapters }) {
        await adapters.collectorCrypt.submitTransaction({ signedTransaction: 'durable-collector-request' });
        throw new Error('Collector accepted the request before returning HTTP 503');
      },
      async reconcileLive() { return null; },
    },
  };
  const createDriver = cycleRepository => createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async submitTransaction() {
          providerCalls += 1;
          return { signature: 'collector-accepted' };
        },
      },
      relay: null,
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository,
    stageHandlers,
    ...fixtureStageDriverOptions,
  });
  const context = {
    cycleId,
    stage: 'purchase',
    intent: { journalHead: 'collector-committed-then-503' },
    assertMutationAllowed: async () => {},
  };

  await assert.rejects(() => createDriver(repository).execute(context), /HTTP 503/);
  assert.equal(providerCalls, 1);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'SENT_UNKNOWN');
  await assert.rejects(() => createDriver(reopened).execute(context), /requires reconciliation/);
  assert.equal(await createDriver(reopened).reconcile(context), null);
  assert.equal(providerCalls, 1);
});

test('keeps a Relay lost-response attempt SENT_UNKNOWN after reopen until reconciliation', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  let relayCalls = 0;
  const stageHandlers = {
    outbound: {
      async probe() { return null; },
      async prepareRequest() { return { provider: 'relay', operation: 'outbound' }; },
      async mutate({ adapters }) {
        await adapters.relay.prepareExecution({ requestId: 'relay-lost-response' });
        throw new Error('Relay response was lost after request acceptance');
      },
      async reconcileLive() { return null; },
    },
  };
  const createDriver = cycleRepository => createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: {
        async prepareExecution() {
          relayCalls += 1;
          return { accepted: true };
        },
      },
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository,
    stageHandlers,
    ...fixtureStageDriverOptions,
  });
  const context = {
    cycleId,
    stage: 'outbound',
    intent: { journalHead: 'relay-lost-response' },
    assertMutationAllowed: async () => {},
  };

  await assert.rejects(() => createDriver(repository).execute(context), /response was lost/);
  assert.equal(relayCalls, 1);

  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'outbound')).attempt.state, 'SENT_UNKNOWN');
  await assert.rejects(() => createDriver(reopened).execute(context), /requires reconciliation/);
  assert.equal(await createDriver(reopened).reconcile(context), null);
  assert.equal(relayCalls, 1);
});

test('requires an injected live handler to prepare the request before recording PREPARED', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async mutate() { throw new Error('mutation must not run without a prepared request'); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({ cycleId: CYCLE_ID, stage: 'purchase', intent: { journalHead: 'head-missing-request' } }),
    /prepareRequest/,
  );
  assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase'), null);
});

test('a dry run cannot complete an unresolved live provider attempt from probe evidence', async () => {
  const cycleRepository = writeAheadRepository();
  await cycleRepository.prepareStageAttempt(CYCLE_ID, 'purchase', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId: CYCLE_ID,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });
  await cycleRepository.recordStageAttemptResponse(CYCLE_ID, 'purchase', { providerReceipt: 'live-response' });
  const driver = createStageDriver({
    liveMode: false,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: { purchase: { async probe() { return { hypothetical: true }; }, async mutate() {}, async reconcileLive() { return null; } } },
  });

  await assert.rejects(
    () => driver.reconcile({ cycleId: CYCLE_ID, stage: 'purchase' }),
    /requires live reconciliation/,
  );
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'RESPONSE_RECORDED');
});

test('rechecks the lease immediately before a provider mutation', async () => {
  const cycleRepository = writeAheadRepository();
  const originalPrepare = cycleRepository.prepareStageAttempt.bind(cycleRepository);
  let prepared = false;
  let mutationCalls = 0;
  cycleRepository.prepareStageAttempt = async (...args) => {
    await originalPrepare(...args);
    prepared = true;
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() { mutationCalls += 1; return { providerReceipt: 'should-not-exist' }; },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'purchase',
      intent: { journalHead: 'head-lease' },
      assertLease() { if (prepared) throw new Error('lease lost before provider call'); },
    }),
    /lease lost before provider call/,
  );
  assert.equal(mutationCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'NOT_SENT');
});

test('guards an injected live handler immediately before mutation, signing, and broadcast', async () => {
  const cycleRepository = writeAheadRepository();
  const calls = [];
  const guards = [];
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      evm: {
        async sign(request) { calls.push(['sign', request]); return { signed: true }; },
        async broadcast(request) { calls.push(['broadcast', request]); return { transactionId: 'tx-1' }; },
      },
    },
    config: baseConfig(),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ signerClient }) {
          calls.push(['mutate']);
          await signerClient.evm.sign({ transaction: 'unsigned' });
          await signerClient.evm.broadcast({ transaction: 'signed' });
          return { providerReceipt: 'provider-receipt-1' };
        },
        async reconcileLive() { return null; },
      },
    },
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-guard' },
    releaseAmountWei: '5', releaseCostMicroUsd: '7',
    packId: 'base-pack',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed(input) {
      guards.push(input);
      calls.push(['guard', input.boundary]);
    },
  });

  assert.deepEqual(calls.map(call => call[0]), ['guard', 'mutate', 'guard', 'sign', 'guard', 'broadcast']);
  assert.deepEqual(guards.map(guard => guard.boundary), ['mutation', 'signature', 'broadcast']);
  for (const guard of guards) {
    assert.equal(guard.cycleId, CYCLE_ID);
    assert.equal(guard.releaseAmountWei, '5');
    assert.equal(guard.packId, 'base-pack');
    assert.equal(guard.stage, 'purchase');
    assert.equal(guard.fencingToken, '12345678-1234-4123-8123-123456789abc');
    assert.match(guard.requestDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('uses the operations-trigger wallet for that role\'s shared EVM nonce fence', async () => {
  const operations = `0x${'1'.repeat(40)}`;
  const trigger = `0x${'2'.repeat(40)}`;
  const nonceCalls = [];
  const cycleRepository = {
    ...writeAheadRepository(),
    async acquireEvmNonceLock(cycleId, input) { nonceCalls.push(['acquire', cycleId, input]); },
    async assertEvmNonceLock(cycleId, input) { nonceCalls.push(['assert', cycleId, input]); },
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: {
      operationsTrigger: {
        role: 'operations-trigger',
        async sign() { return { signedTx: 'signed' }; },
        async broadcast() { return { transactionHash: `0x${'a'.repeat(64)}` }; },
      },
    },
    config: baseConfig({ accounts: { evm: operations, operationsTrigger: trigger, solana: null } }),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ signerClient }) {
          await signerClient.operationsTrigger.sign({ transaction: 'unsigned' });
          await signerClient.operationsTrigger.broadcast({ transaction: 'signed' });
          return { providerReceipt: 'provider-receipt-operations-trigger' };
        },
        async reconcileLive() { return null; },
      },
    },
    ...fixtureStageDriverOptions,
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'operations-trigger-nonce-fence' },
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed() {},
  });

  assert.equal(nonceCalls.length, 4);
  for (const [, cycleId, input] of nonceCalls) {
    assert.equal(cycleId, CYCLE_ID);
    assert.equal(input.wallet, trigger);
    assert.equal(input.fencingToken, '12345678-1234-4123-8123-123456789abc');
  }
});

test('guards direct provider and RPC mutation methods immediately before they execute', async () => {
  const cycleRepository = writeAheadRepository();
  const calls = [];
  const guards = [];
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: Object.freeze({
        async generatePack() { calls.push(['generatePack']); return { transaction: 'unsigned' }; },
        async generateYoloPacks() { calls.push(['generateYoloPacks']); return { transactions: ['unsigned'] }; },
        async submitTransaction() { calls.push(['submitTransaction']); return { signature: 'signature-1' }; },
      }),
      relay: null,
      robinhood: {
        client: {
          async sendRawTransaction() { calls.push(['sendRawTransaction']); return '0xabc'; },
        },
      },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ adapters }) {
          calls.push(['mutate']);
          await adapters.collectorCrypt.generatePack({ playerAddress: 'PLAYER11111111111111111111111111111111111' });
          await adapters.collectorCrypt.generateYoloPacks({ playerAddress: 'PLAYER11111111111111111111111111111111111' });
          await adapters.collectorCrypt.submitTransaction({ signedTransaction: 'signed' });
          await adapters.robinhood.client.sendRawTransaction({ serializedTransaction: '0xabc' });
          return { providerReceipt: 'provider-receipt-2' };
        },
        async reconcileLive() { return null; },
      },
    },
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-adapter-guard' },
    releaseAmountWei: '5', releaseCostMicroUsd: '7',
    packId: 'base-pack',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed(input) {
      guards.push(input);
      calls.push(['guard', input.boundary]);
    },
  });

  assert.deepEqual(calls.map(call => call[0]), [
    'guard', 'mutate', 'guard', 'generatePack', 'guard', 'generateYoloPacks', 'guard', 'submitTransaction', 'guard', 'sendRawTransaction',
  ]);
  assert.deepEqual(guards.map(guard => guard.boundary), ['mutation', 'mutation', 'mutation', 'broadcast', 'broadcast']);
  for (const guard of guards) {
    assert.equal(guard.stage, 'purchase');
    assert.match(guard.requestDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('refuses a stale-policy generateYoloPacks batch call after initial admission and preserves NOT_SENT', async () => {
  const cycleRepository = writeAheadRepository();
  const calls = [];
  let batchCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: Object.freeze({
        async generateYoloPacks() { batchCalls += 1; return { transactions: ['unsigned'] }; },
      }),
      relay: null,
      robinhood: { client: null },
      solana: { client: null },
    },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ adapters }) {
          calls.push(['mutate']);
          return adapters.collectorCrypt.generateYoloPacks({ playerAddress: 'PLAYER11111111111111111111111111111111111' });
        },
        async reconcileLive() { return null; },
      },
    },
  });

  let guardCalls = 0;
  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'purchase',
      intent: { journalHead: 'head-batch-guard-refusal' },
      fencingToken: '12345678-1234-4123-8123-123456789abc',
      async assertMutationAllowed(input) {
        guardCalls += 1;
        calls.push(['guard', input.boundary]);
        // First call is the stage-level admission before the handler runs; the second is the
        // per-call guard immediately before generateYoloPacks, where a policy change between
        // admission and batch generation must be caught.
        if (guardCalls === 2) throw new Error('policy became ineligible after admission');
      },
    }),
    /policy became ineligible after admission/,
  );

  assert.equal(guardCalls, 2);
  assert.equal(batchCalls, 0);
  assert.deepEqual(calls.map(call => call[0]), ['guard', 'mutate', 'guard']);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'NOT_SENT');
});

test('guards the production Solana RPC transport immediately before sendTransaction', async () => {
  const cycleRepository = writeAheadRepository();
  const calls = [];
  const guards = [];
  const solanaClient = createSolanaRpcClient({
    rpcUrl: 'https://example.invalid',
    async fetchImpl(_url, options) {
      calls.push(['fetch', JSON.parse(options.body).method]);
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'solana-signature-1' }); },
      };
    },
  });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: solanaClient } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    ...fixtureStageDriverOptions,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate({ adapters }) {
          const signature = await submitSignedTransaction(adapters.solana.client, 'c2lnbmVkLXRyYW5zYWN0aW9u');
          return { providerReceipt: signature };
        },
        async reconcileLive() { return null; },
      },
    },
  });

  await driver.execute({
    cycleId: CYCLE_ID,
    stage: 'purchase',
    intent: { journalHead: 'head-solana-rpc-guard' },
    releaseAmountWei: '5', releaseCostMicroUsd: '7',
    packId: 'base-pack',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed(input) {
      guards.push(input);
      calls.push(['guard', input.boundary]);
    },
  });

  assert.deepEqual(calls, [
    ['guard', 'mutation'],
    ['guard', 'broadcast'],
    ['fetch', 'sendTransaction'],
  ]);
  assert.deepEqual(guards.map(guard => guard.boundary), ['mutation', 'broadcast']);
});

test('records NOT_SENT when an injected live mutation guard hook is absent', async () => {
  const cycleRepository = writeAheadRepository();
  let mutationCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    stageHandlers: {
      purchase: {
        async probe() { return null; },
        async prepareRequest() { return { provider: 'collector-test', playerAddress: 'PLAYER11111111111111111111111111111111111' }; },
        async mutate() { mutationCalls += 1; return { providerReceipt: 'must-not-exist' }; },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({ cycleId: CYCLE_ID, stage: 'purchase', intent: { journalHead: 'head-missing-guard' } }),
    /requires context\.assertMutationAllowed/,
  );
  assert.equal(mutationCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'NOT_SENT');
});

test('Collector-capable stages reach their own real refusal while the eligibility snapshot stays read-only', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    // Same canonical isolated Solana identity as the analogous test above, required to clear
    // purchase's own HOOKEMON_SOLANA_ACCOUNT precondition before its real collector-crypt refusal.
    config: baseConfig({ accounts: { evm: null, solana: '11111111111111111111111111111111' } }),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });
  const expectations = {
    purchase: { attemptState: 'NOT_SENT', message: /purchase mutate requires a configured collector-crypt client/ },
    open: { attemptState: null, message: /open requires a completed purchase stage with a pack ledger/ },
    'epic-gate': { attemptState: null, message: /epic gate requires a completed open stage with a pack ledger/ },
    buyback: { attemptState: null, message: /buyback requires a completed epic-gate stage with a pack ledger/ },
  };
  for (const stage of AUTOMATED_CYCLE_STAGES.filter(stage => !['eligibility-snapshot', 'claim-process', 'outbound', 'return', 'payout'].includes(stage))) {
    const expected = expectations[stage];
    await assert.rejects(
      () => driver.execute({
        cycleId: CYCLE_ID,
        stage,
        intent: { journalHead: `head-${stage}` },
        assertMutationAllowed: async () => {},
      }),
      error => {
        assert.equal(error instanceof LiveModeIntegrationPendingError, false, `${stage} must not hit the frozen integration-pending refusal`);
        assert.match(error.message, expected.message);
        return true;
      },
    );
    const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, stage);
    if (expected.attemptState === null) {
      assert.equal(attempt, null, `${stage} refuses during preparation, before any attempt is durably recorded`);
    } else {
      assert.equal(attempt.attempt.state, expected.attemptState);
    }
  }
  await assert.rejects(
    () => driver.execute({ cycleId: CYCLE_ID, stage: 'eligibility-snapshot', intent: { journalHead: 'head-eligibility-snapshot' } }),
    /read-only reconciliation/i,
  );
  assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'eligibility-snapshot'), null);
});

test('built-in payout keeps a lost lease retryable before payout preparation or signing', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const lost = new LeaseLostError('payout lease expired', { owner: 'cycle-runner', version: 9 });
  let broadcasts = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      collectorCrypt: null,
      relay: null,
      robinhood: { client: { async sendRawTransaction() { broadcasts += 1; } } },
      solana: { client: null },
    },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage: 'payout',
      intent: { journalHead: 'payout-lost-lease-before-preparation' },
      assertLease() { throw lost; },
      assertMutationAllowed: async () => {},
    }),
    LeaseLostError,
  );
  assert.equal(broadcasts, 0);
  const reopened = await CycleRepository.open(directory, () => Date.now(), { testAuthority: createTestProfileMutationAuthority() });
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, null);
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'payout'), null);
  assert.equal((await reopened.readActiveCycle()).cycleId, cycleId);
});

test('the built-in driver derives direct payout policy around a guarded raw signer', async () => {
  const token = `0x${'a'.repeat(40)}`;
  const recipient = `0x${'2'.repeat(40)}`;
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const operations = account.address.toLowerCase();
  const cycleId = 'cycle-direct-payout-driver';
  const amount = createNativePayoutAmount({ assetId: 'native', amountAtomic: '9' });
  const snapshot = {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: token, decimals: 18, amountAtomic: '1' },
    entries: [{ recipient, hkmnBalance: { chainId: '4663', assetId: token, decimals: 18, amountAtomic: '1' } }],
    exclusions: [],
    feasibility: {
      recipientCount: 1,
      transactionCount: 1,
      maxRecipientCount: 1,
      maxTransactionCount: 1,
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100010' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100010' },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: 1 },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
  };
  const returnEvidence = {
    finalized: true,
    destinationAccount: operations,
    destinationAsset: 'native',
    destinationCreditAmount: amount.amountAtomic,
  };
  let broadcastHash = null;
  let broadcastBytes = null;
  let signCount = 0;
  let broadcastCount = 0;
  const baseSigner = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    preflightAuthority: fixtureStageDriverOptions.preflightAuthority,
    inner: {
      async sign({ transaction }) {
        signCount += 1;
        return {
          signedTx: await account.signTransaction({
            ...transaction,
            nonce: BigInt(transaction.nonce),
            value: BigInt(transaction.value),
            gas: BigInt(transaction.gas),
            gasPrice: BigInt(transaction.gasPrice),
          }),
        };
      },
      async broadcast({ signedTx }) {
        broadcastCount += 1;
        broadcastBytes = signedTx;
        broadcastHash = keccak256(signedTx);
        return { transactionHash: broadcastHash };
      },
    },
  });
  const receipt = () => {
    if (!broadcastHash) return null;
    return {
      transactionHash: broadcastHash,
      blockNumber: 100n,
      blockHash: `0x${'f'.repeat(64)}`,
      status: 'success',
      logs: [], gasUsed: 21000n, effectiveGasPrice: 1n,
    };
  };
  const client = {
    async getChainId() { return 4663; },
    async readContract({ functionName }) { assert.equal(functionName, 'isFrozen'); return false; },
    async getTransactionCount() { return 0n; },
    async getBalance() { return 1_000_000n; },
    async getTransaction({ hash }) { return hash === broadcastHash ? { ...parseTransaction(broadcastBytes), hash, from: operations, input: parseTransaction(broadcastBytes).data ?? '0x', blockNumber: 100n, blockHash: `0x${'f'.repeat(64)}` } : null; },
    async getTransactionReceipt({ hash }) {
      const value = receipt();
      if (!value || hash !== broadcastHash) throw new TransactionReceiptNotFoundError({ hash });
      return value;
    },
    async getBlock({ blockNumber } = {}) {
      if (blockNumber === 99n) return { number: 99n, hash: `0x${'e'.repeat(64)}`, timestamp: 99n };
      return { number: 100n, hash: `0x${'f'.repeat(64)}`, parentHash: `0x${'e'.repeat(64)}`, timestamp: 100n };
    },
    // Cycle-attributed native principal remains separate from its gas reserve.
    async readCycleAttributableFinalizedAvailable() {
      return { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '999999999999999999999999' };
    },
  };
  const historicalEvidenceClient = {
    async readNativeBalanceAtBlock({ account: observedAccount, blockNumber, blockHash }) {
      const isSource = observedAccount.toLowerCase() === operations;
      const value = isSource
        ? (blockNumber === 99n ? 1_000_000n : 1_000_000n - BigInt(amount.amountAtomic))
        : (blockNumber === 99n ? 0n : BigInt(amount.amountAtomic));
      return { value, blockNumber, blockHash };
    },
  };
  let payoutState = null;
  let releaseCount = 0;
  let walletNonceReservation = null;
  let releasedWalletNonceReservation = null;
  const recoveryContexts = new Map();
  const ledgers = new Map();
  const operationalAttempts = new Map();
  const stages = new Map([
    ['eligibility-snapshot', { status: 'COMPLETE', evidence: snapshot }],
  ]);
  const repository = {
    async readStage(_cycleId, stage) { return stages.get(stage) ?? { status: 'PENDING' }; },
    async readPagedPayoutState(_cycleId, stage) {
      assert.equal(stage, 'payout');
      return payoutState === null ? null : structuredClone(payoutState);
    },
    async persistPagedPayoutState(_cycleId, stage, value) {
      assert.equal(stage, 'payout');
      payoutState = structuredClone(value);
    },
    async readPayoutDust() { return { amount: { ...amount, amountAtomic: '0' }, source: null }; },
    async consumePayoutDustAndPersistPagedPayoutState(_cycleId, input) {
      payoutState = structuredClone(input.evidence);
      return { evidence: structuredClone(input.evidence), consumption: null };
    },
    async persistChainAttemptRecoveryContext(_cycleId, context) {
      recoveryContexts.set(`${context.stage}\u0000${context.recipient}\u0000${context.requestDigest}`, structuredClone(context));
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      return structuredClone(recoveryContexts.get(`${selector.stage}\u0000${selector.recipient}\u0000${selector.requestDigest}`) ?? null);
    },
    async recordPayoutDust() { throw new Error('zero dust must not be recorded'); },
    async describeCycle() { return { custodyLedgers: ledgers }; },
    async recordCustodyLedger(_cycleId, ledger) { ledgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, structuredClone(ledger)); },
    async reservePayoutQuarantine() { throw new Error('the composed success path must not quarantine'); },
    async reserveWalletNonce(_cycleId, reservation) {
      if (walletNonceReservation !== null) assert.deepEqual(reservation, walletNonceReservation);
      walletNonceReservation = structuredClone(reservation);
      return true;
    },
    async assertWalletNonce(_cycleId, reservation) {
      assert.deepEqual(reservation, walletNonceReservation);
      return true;
    },
    async releaseWalletNonce(_cycleId, reservation) {
      if (walletNonceReservation === null) {
        assert.deepEqual(reservation, releasedWalletNonceReservation);
        return true;
      }
      assert.deepEqual(reservation, walletNonceReservation);
      releasedWalletNonceReservation = walletNonceReservation;
      walletNonceReservation = null;
      releaseCount += 1;
      return true;
    },
    async readOperationalStageAttempt(_cycleId, stage) {
      const attempt = operationalAttempts.get(stage);
      return attempt === undefined ? null : structuredClone(attempt);
    },
    async prepareStageAttempt(_cycleId, stage, attempt) {
      operationalAttempts.set(stage, { attempt: structuredClone(attempt), responseEvidence: null, reconciliationEvidence: null });
    },
    async markStageAttemptSentUnknown(_cycleId, stage) {
      const current = operationalAttempts.get(stage);
      operationalAttempts.set(stage, { ...current, attempt: { ...current.attempt, state: 'SENT_UNKNOWN' } });
    },
    async markStageAttemptNotSent(_cycleId, stage) {
      const current = operationalAttempts.get(stage);
      operationalAttempts.set(stage, { ...current, attempt: { ...current.attempt, state: 'NOT_SENT' } });
    },
    async recordStageAttemptResponse(_cycleId, stage, evidence) {
      const current = operationalAttempts.get(stage);
      operationalAttempts.set(stage, {
        ...current,
        attempt: { ...current.attempt, state: 'RESPONSE_RECORDED' },
        responseEvidence: structuredClone(evidence),
      });
    },
    async reconcileStageAttempt(_cycleId, stage, evidence) {
      const current = operationalAttempts.get(stage);
      if (current) {
        operationalAttempts.set(stage, {
          ...current,
          attempt: { ...current.attempt, state: 'RECONCILED' },
          reconciliationEvidence: structuredClone(evidence),
        });
      }
      stages.set(stage, { status: 'COMPLETE', evidence: structuredClone(evidence) });
    },
  };
  const liveConfig = {
    chainId: 4663,
    // These historical identities remain present in the composed production configuration.
    // They must not select the retired vault settlement path over direct Operations transfers.
    contracts: { usdg: token, hook: `0x${'3'.repeat(40)}`, vault: `0x${'4'.repeat(40)}` },
    accounts: { evm: operations, operationsTrigger: `0x${'5'.repeat(40)}` },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v2',
      assets: {
        eth: { chainId: '4663', assetId: 'native', decimals: 18 },
        solanaStablecoin: {
          chainId: '792703809',
          assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
        },
      },
      minimums: {
        robinhoodReceive: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
        solanaReceive: {
          chainId: '792703809',
          assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
          amountAtomic: '0',
        },
        returnEth: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
        nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      },
      solana: {
        priorityFeeCap: {
          chainId: '792703809',
          assetId: 'microlamports-per-compute-unit',
          decimals: 0,
          amountAtomic: '2',
        },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
      },
    },
  };
  const returnContext = {
    cycleId,
    stage: 'return',
    intent: { journalHead: 'buyback-complete' },
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed() {},
  };
  const returnDriver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client, historicalEvidenceClient }, solana: { client: null } },
    signerClient: null,
    config: liveConfig,
    cycleRepository: repository,
    stageHandlers: {
      return: {
        async probe() { return null; },
        async prepareRequest() { return { source: 'fake-finalized-return' }; },
        async mutate() { return returnEvidence; },
        async reconcileLive() { return returnEvidence; },
      },
    },
    ...fixtureStageDriverOptions,
  });

  await returnDriver.execute(returnContext);
  assert.deepEqual(await returnDriver.reconcile(returnContext), returnEvidence);
  assert.deepEqual(await repository.readStage(cycleId, 'return'), { status: 'COMPLETE', evidence: returnEvidence });

  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client, historicalEvidenceClient }, solana: { client: null } },
    signerClient: { evm: baseSigner },
    config: liveConfig,
    cycleRepository: repository,
    ...fixtureStageDriverOptions,
  });
  const context = {
    cycleId,
    stage: 'payout',
    intent: { journalHead: 'return-complete' },
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed() {},
  };

  assert.equal(await driver.reconcile(context), null);
  await driver.execute(context);
  const evidence = await driver.reconcile(context);

  assert.equal(signCount, 1);
  assert.equal(broadcastCount, 1);
  assert.equal(releaseCount, 1);
  assert.equal(evidence.recipients[0].state, 'FINALIZED');
  assert.equal(evidence.recipients[0].amount.amountAtomic, amount.amountAtomic);
  const payment = parseTransaction(broadcastBytes);
  assert.equal(payment.to.toLowerCase(), recipient);
  assert.equal(payment.value, 9n);
  assert.equal(payment.data ?? '0x', '0x');
});

// ADR-0025 production integration gap: the real built-in RETURN chain handler seam (Solana) -- the
// one stage whose owned Keychain client actually exposes the preferred `signApproved` method
// `wrapTransactionPolicySignerClient` prefers over the bare `sign`. Proves the stage driver's
// `signOnlyRecoveryRepository` -- not the raw `cycleRepository` -- is what `createReturnPolicySigner`
// receives; that it exposes the complete five-method sign-only recovery surface; that every one of
// those calls is lease-fenced exactly like every other durable repository write the driver already
// fences; that `signApproved` itself now runs the same lease/mutation/nonce/standing-authority guard
// chain as `sign` (`guardedSignerRole` no longer copies it unguarded through its spread); and that a
// lease lost between the recorded ordinal-1 timeout and the ordinal-2 retry refuses before a second
// `signApproved` broker call -- never a broadcast. A companion negative proves the committed
// WeakMap-by-reference ownership design in keychain-signer.mjs: a plain spread/clone of the real
// owned client, carried through the exact same stage-driver wrapping, is never recognized as owned.
function returnSignOnlyMoneyConfiguration(solanaMint) {
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: {
      eth: { chainId: '4663', assetId: 'native', decimals: 18 },
      solanaStablecoin: { chainId: '792703809', assetId: solanaMint, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      solanaReceive: { chainId: '792703809', assetId: solanaMint, decimals: 6, amountAtomic: '0' },
      returnEth: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '1000' },
    },
  };
}

function returnSignOnlySolanaClient(blockhash, observation, state = { blockHeight: 10, balance: 10_000 }) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const resultByMethod = {
        getBalance: { context: { slot: 9 }, value: state.balance ?? 10_000 },
        getLatestBlockhash: { context: { slot: 10 }, value: { blockhash, lastValidBlockHeight: 100 } },
        isBlockhashValid: { context: { slot: 10 }, value: true },
        getBlockHeight: state.blockHeight,
        getSlot: 11,
        getMultipleAccounts: observation,
      };
      if (!Object.hasOwn(resultByMethod, body.method)) throw new Error(`unexpected Solana RPC ${body.method}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: resultByMethod[body.method] }) };
    },
  });
}

/**
 * The exact five-method sign-only recovery contract, self-contained (no chain-attempt CAS reuse
 * from cycle-repository.mjs -- this fake exists only to prove the *stage-driver wiring and lease
 * fencing*, not to re-prove the repository's own CAS semantics, which cycle-repository.test.mjs
 * already covers).
 */
function returnSignOnlyRecoveryFake(attempts) {
  const bindings = new Map();
  const ledgers = new Map();
  const key = (stage, requestDigest) => `${stage} ${requestDigest}`;
  const isPrepared = (stage, requestDigest) => attempts.get(key(stage, requestDigest))?.attempt.state === 'PREPARED';
  return {
    async persistSignOnlyPreSignBinding(_cycleId, stage, requestDigest, binding) {
      if (!isPrepared(stage, requestDigest)) throw new Error('fake sign-only repository: chain attempt is not PREPARED');
      const k = key(stage, requestDigest);
      const current = bindings.get(k);
      if (current) {
        if (JSON.stringify(current) !== JSON.stringify(binding)) throw new Error('fake sign-only repository: binding conflict');
        return current;
      }
      bindings.set(k, binding);
      return binding;
    },
    async readSignOnlyPreSignBinding(_cycleId, stage, requestDigest) {
      return bindings.get(key(stage, requestDigest)) ?? null;
    },
    async reserveSignOnlyInvocation(_cycleId, stage, requestDigest, ordinal) {
      if (!bindings.has(key(stage, requestDigest))) throw new Error('fake sign-only repository: no durable pre-sign binding for this request');
      if (!isPrepared(stage, requestDigest)) throw new Error('fake sign-only repository: chain attempt is not PREPARED');
      const k = key(stage, requestDigest);
      const current = ledgers.get(k) ?? null;
      if (ordinal === 1) {
        if (current) throw new Error('fake sign-only repository: ordinal 1 was already reserved');
        ledgers.set(k, { state: 'ORDINAL_1_ALLOCATED' });
      } else {
        if (!current || current.state !== 'ORDINAL_1_TIMED_OUT') throw new Error('fake sign-only repository: ordinal 2 requires a recorded ordinal 1 timeout');
        ledgers.set(k, { state: 'ORDINAL_2_ALLOCATED' });
      }
      return ledgers.get(k);
    },
    async recordSignOnlyInvocationTimeout(_cycleId, stage, requestDigest, ordinal) {
      const k = key(stage, requestDigest);
      const current = ledgers.get(k) ?? null;
      const expected = ordinal === 1 ? 'ORDINAL_1_ALLOCATED' : 'ORDINAL_2_ALLOCATED';
      const next = ordinal === 1 ? 'ORDINAL_1_TIMED_OUT' : 'ORDINAL_2_TIMED_OUT';
      if (current?.state === next) return current;
      if (!current || current.state !== expected) throw new Error(`fake sign-only repository: ordinal ${ordinal} is not in the allocated state`);
      ledgers.set(k, { state: next });
      return ledgers.get(k);
    },
    async readSignOnlyInvocationLedger(_cycleId, stage, requestDigest) {
      return ledgers.get(key(stage, requestDigest)) ?? null;
    },
  };
}

// Return's own custody-v2 writer always obtains a real finalized public/archive/public-recheck
// observation for a genuinely new leg -- `returnSignOnlyRobinhoodClient` below supplies it once,
// so these sign-only lease-fencing fixtures no longer run with a null Robinhood client.

function returnSignOnlyRobinhoodClient() {
  return {
    client: {
      async getBlock() {
        return { number: 100n, hash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_000n };
      },
    },
    historicalEvidenceClient: {
      async readNativeBalanceAtBlock({ blockNumber, blockHash }) {
        return { value: 0n, blockNumber, blockHash };
      },
    },
  };
}

function returnSignOnlyChainRepository(proceeds, solanaMint) {
  const attempts = new Map();
  let relayLeg = null;
  const reservations = [];
  const returnLegLedgerKeys = new Map();
  let evmLedger = null;
  const signOnly = returnSignOnlyRecoveryFake(attempts);
  return {
    get attempts() { return attempts; },
    async describeCycle() {
      const custodyLedgers = new Map([['ledger', {
        chainId: 'solana-mainnet', assetId: solanaMint, decimals: 6, buybackProceeds: proceeds, returnInput: '0',
      }]]);
      if (evmLedger !== null) custodyLedgers.set(`${evmLedger.chainId} ${evmLedger.assetId}`, evmLedger);
      return {
        admission: nativeAdmissionFixture('cycle-return-sign-only'),
        custodyLedgers,
        chainAttempts: new Map(attempts),
        relayLegs: relayLeg === null ? new Map() : new Map([[relayLeg.relayRequestId, relayLeg]]),
        returnLegLedgerKeys: new Map(returnLegLedgerKeys),
      };
    },
    async recordCustodyLedger(_cycleId, ledgerValue) {
      evmLedger = structuredClone(ledgerValue);
    },
    // Return is a chain-journal stage: it never touches the generic write-ahead provider-attempt
    // store this driver also requires at construction. `readOperationalStageAttempt` genuinely runs
    // (and must report "none") before every execute(); the rest are unreachable safety nets.
    async readOperationalStageAttempt() { return null; },
    async prepareStageAttempt() { throw new Error('sign-only lease-fencing test must never use the generic write-ahead journal'); },
    async markStageAttemptNotSent() { throw new Error('sign-only lease-fencing test must never use the generic write-ahead journal'); },
    async markStageAttemptSentUnknown() { throw new Error('sign-only lease-fencing test must never use the generic write-ahead journal'); },
    async recordStageAttemptResponse() { throw new Error('sign-only lease-fencing test must never use the generic write-ahead journal'); },
    async reconcileStageAttempt() { throw new Error('sign-only lease-fencing test must never use the generic write-ahead journal'); },
    async readChainTransactionAttempt(_cycleId, stage, requestDigest) {
      return attempts.get(`${stage} ${requestDigest}`) ?? null;
    },
    async prepareChainTransactionAttempt(_cycleId, stage, attempt) {
      const key = `${stage} ${attempt.requestDigest}`;
      const existing = attempts.get(key);
      if (existing) return existing;
      const record = { attempt, broadcastEvidence: null, finalityEvidence: null };
      attempts.set(key, record);
      return record;
    },
    async recordSignedTransaction(_cycleId, stage, requestDigest, material) {
      throw new Error('sign-only lease-fencing test must never durably record a signature');
    },
    async recordBroadcast() {
      throw new Error('sign-only lease-fencing test must never broadcast');
    },
    async recordCustodyLedger() {
      throw new Error('sign-only lease-fencing test must never reach custody ledger recording');
    },
    async recordFinality() {
      throw new Error('sign-only lease-fencing test must never reach finality');
    },
    async recordReturnRelayLegExpectation(_cycleId, leg, ledgerValue) {
      if (relayLeg === null) relayLeg = structuredClone(leg);
      evmLedger = structuredClone(ledgerValue);
      returnLegLedgerKeys.set(relayLeg.relayRequestId, `${evmLedger.chainId} ${evmLedger.assetId}`);
      return structuredClone(relayLeg);
    },
    async recordRelayLegSource() {
      throw new Error('sign-only lease-fencing test must never reach source attribution');
    },
    async readRelayLeg() { return relayLeg === null ? null : structuredClone(relayLeg); },
    async reserveWalletNonce(cycleId, reservation) { reservations.push(['reserve', cycleId, structuredClone(reservation)]); },
    async assertWalletNonce() {},
    async persistChainAttemptRecoveryContext() {
      throw new Error('sign-only lease-fencing test must never persist a signed-bytes recovery context');
    },
    async readChainAttemptRecoveryContext() { return null; },
    ...signOnly,
  };
}




// Native return uses the captured deposit grammar and a real Relay quote producer. The
// loopback runtime observation authorizes only these public synthetic fixture transactions.
async function returnSignOnlyFixture() {
  const cycleId = 'cycle-return-sign-only';
  const sender = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
  const recipient = '0x000000000000000000000000000000000000dEaD';
  const proceeds = '24000000';
  const nowMs = Date.now();
  const native = await producedReturnSigningFixture({ cycleId, sender, recipient, amount: proceeds, nowMs });
  const solanaMint = native.request.inputAmount.assetId;
  const config = {
    chainId: 4663, now: () => nowMs,
    accounts: { evm: recipient, solana: sender },
    relay: { solanaMint, maxSettlementWindowSeconds: '600' },
    nativePaymentBinding: native.nativePaymentBinding,
    moneyConfiguration: returnSignOnlyMoneyConfiguration(solanaMint),
    solana: { chainId: 'solana-mainnet' },
    collectorCrypt: { settlementAsset: { chainId: 'solana-mainnet', assetId: solanaMint, decimals: 6 } },
  };
  return { cycleId, solanaMint, config, relay: { ...native.relay, quoteReturnBridge: args => native.relay.quoteReturnBridge({ ...args, skipRouteCheck: true }) }, proceeds,
    solanaClient: returnSignOnlySolanaClient('11111111111111111111111111111111', native.observation) };
}
test('the real built-in return handler receives a lease-fenced sign-only recovery facade with the complete method surface, and a lost lease refuses before a second Keychain signApproved call', async () => {
  const { cycleId, solanaMint, config, relay, proceeds, solanaClient } = await returnSignOnlyFixture();
  const cycleRepository = returnSignOnlyChainRepository(proceeds, solanaMint);

  let brokerCalls = 0;
  let broadcastCalls = 0;
  const keychain = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureStageDriverOptions,
    timeoutMs: 5,
    // Always times out: the real broker is never reached a second time if lease fencing works.
    exec: async call => {
      if (call.args[0] === 'broadcast') {
        broadcastCalls += 1;
        throw new Error('sign-only lease-fencing test must never broadcast');
      }
      brokerCalls += 1;
      return new Promise(() => {});
    },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-solana-sign-only-test',
  });

  const adapters = {
    collectorCrypt: null,
    relay,
    robinhood: returnSignOnlyRobinhoodClient(),
    solana: { client: solanaClient },
  };

  const driver = createStageDriver({
    liveMode: true,
    adapters,
    signerClient: { solana: keychain },
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  // Lease loss is expressed exactly like every other lease-fencing test in this file: a stateful
  // `assertLease` that starts failing once a specific durable fact becomes true. Here, that fact is
  // "the ordinal-1 timeout was already durably recorded" -- i.e. exactly the boundary between the
  // classified timeout and the one bounded retry. It is set from the *outside*, by wrapping the
  // fake's own recordSignOnlyInvocationTimeout, never by the facade itself, so this proves the
  // driver's lease fencing independently of the retry facade's own internal logic.
  const originalRecordTimeout = cycleRepository.recordSignOnlyInvocationTimeout.bind(cycleRepository);
  let ordinal1TimedOutRecorded = false;
  cycleRepository.recordSignOnlyInvocationTimeout = async (...args) => {
    const result = await originalRecordTimeout(...args);
    ordinal1TimedOutRecorded = true;
    return result;
  };

  const context = {
    cycleId,
    stage: 'return',
    intent: { journalHead: 'sign-only-lease-fencing-return' },
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {
      if (ordinal1TimedOutRecorded) throw new LeaseLostError('expired', { owner: 'cycle-runner', version: 1 });
    },
    async assertMutationAllowed() {},
  };

  await assert.rejects(() => driver.execute(context), LeaseLostError);

  // The complete method surface was genuinely exercised (not stubbed out): a real durable binding,
  // a real ordinal-1 reservation, and a real recorded timeout all happened before the lease refused
  // anything further.
  const requestDigest = [...cycleRepository.attempts.keys()][0].split(' ')[1];
  assert.notEqual(await cycleRepository.readSignOnlyPreSignBinding(cycleId, 'return', requestDigest), null);
  const ledger = await cycleRepository.readSignOnlyInvocationLedger(cycleId, 'return', requestDigest);
  assert.equal(ledger.state, 'ORDINAL_1_TIMED_OUT');

  // The lease refused before the owned Keychain client's preferred signApproved() was invoked a
  // second time, and broadcast was never reached at all.
  assert.equal(brokerCalls, 1, 'the lost lease must refuse ordinal 2 before a second signApproved broker call');
  assert.equal(broadcastCalls, 0, 'the lost lease must refuse before any broadcast');
});

test('a plain clone of the real owned Keychain client is never recognized as owned, so a sign-only timeout is never retried through the durable ledger', async () => {
  const { solanaMint, config, relay, proceeds, solanaClient } = await returnSignOnlyFixture();
  const cycleId = 'cycle-return-sign-only-clone';
  const cycleRepository = returnSignOnlyChainRepository(proceeds, solanaMint);

  let brokerCalls = 0;
  const realKeychain = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureStageDriverOptions,
    timeoutMs: 5,
    exec: async () => { brokerCalls += 1; return new Promise(() => {}); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-solana-sign-only-clone-test',
  });
  // The committed WeakMap-by-reference design (keychain-signer.mjs): a spread copies every
  // property -- role, sign, signApproved, broadcast -- but produces a new object reference the
  // module's own WeakMap never saw, so it is structurally identical yet never recognized as owned.
  const clonedKeychain = { ...realKeychain };

  const adapters = {
    collectorCrypt: null,
    relay,
    robinhood: returnSignOnlyRobinhoodClient(),
    solana: { client: solanaClient },
  };

  const driver = createStageDriver({
    liveMode: true,
    adapters,
    signerClient: { solana: clonedKeychain },
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  const context = {
    cycleId,
    stage: 'return',
    intent: { journalHead: 'sign-only-lease-fencing-return-clone' },
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {},
    async assertMutationAllowed() {},
  };

  // Never a LeaseLostError/ledger-mediated refusal: with no owned client, `wrapTransactionPolicySignerClient`
  // never touches the sign-only recovery repository at all, so the raw classified timeout surfaces
  // directly from the single unmodified sign call.
  await assert.rejects(() => driver.execute(context), KeychainSignOnlyTimeoutError);
  assert.equal(brokerCalls, 1, 'an unowned client must never be retried a second time');

  const requestDigest = [...cycleRepository.attempts.keys()][0].split(' ')[1];
  assert.equal(
    await cycleRepository.readSignOnlyPreSignBinding(cycleId, 'return', requestDigest),
    null,
    'an unowned client must never even reach the durable pre-sign binding',
  );
});

test('a lease lost while the standing-authority guard await is genuinely suspended refuses the preferred signApproved call before the broker is ever reached', async () => {
  // Reuses the exact same real owned Keychain client + real built-in return handler + real
  // signOnlyRecoveryRepository facade as the positive sign-only test above -- this test is only
  // about the standing-authority guard's own recheck, not a second huge fixture.
  const { cycleId, solanaMint, config, relay, proceeds, solanaClient } = await returnSignOnlyFixture();
  const cycleRepository = returnSignOnlyChainRepository(proceeds, solanaMint);
  // The only method the real standing-authority provider's own first-use reservation needs beyond
  // the narrow sign-only recovery surface above -- added directly since this is the one test in
  // the file that exercises a real (not custom-stubbed) standing-authority guard.
  cycleRepository.recordStandingAuthorityDecision = async (_cycleId, decision) => decision;

  let brokerCalls = 0;
  const keychain = createKeychainSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureStageDriverOptions,
    timeoutMs: 60_000,
    // The race below never lets this resolve either way -- the driver must refuse before ever
    // calling it, not because it happens to time out.
    exec: async () => { brokerCalls += 1; return new Promise(() => {}); },
    command: '/opt/hookemon/bin/hookemon-keychain-sign',
    account: 'hookemon-operator-solana-standing-authority-race',
  });

  const adapters = {
    collectorCrypt: null,
    relay,
    robinhood: returnSignOnlyRobinhoodClient(),
    solana: { client: solanaClient },
  };

  // Default-dated (issued 2026-01-01, expires 2099-01-01): genuinely valid right now, so the
  // standing-authority guard's real verification actually runs to completion instead of being
  // refused outright on an expired fixture.
  const fixture = createProductionTestFixture({ moneyConfiguration: claimMoneyConfiguration() });

  // `createStandingAuthoritySigningGuard`'s guard body is exactly two awaits in sequence: first
  // `authority.resolveStepAuthorization(...)` (this hook -- entirely caller-supplied), then
  // `authority.provider.verifyAndRecordStepAuthorization(...)` (the real, WeakSet-branded
  // provider, which -- like the owned Keychain client -- cannot be wrapped or spread without
  // losing its own unforgeable identity, so it is used completely unmodified below). Suspending
  // this first await genuinely suspends the guard as a whole, the same race window as suspending
  // the second one, without needing to touch the branded provider at all.
  let signalSuspended;
  const suspended = new Promise(resolve => { signalSuspended = resolve; });
  let releaseAuthority;
  const releaseGate = new Promise(resolve => { releaseAuthority = resolve; });

  const driver = createStageDriver({
    liveMode: true,
    adapters,
    signerClient: { solana: keychain },
    config: {
      ...config,
      execution: { profile: 'production', providerMode: 'live' },
      standingAuthority: { ...fixture.standingAuthority, provider: fixture.standingAuthorityProvider },
      // Called with the driver's own real, freshly-prepared requestDigest -- built here rather
      // than precomputed, since `prepareReturnRequest` embeds a wall-clock-dependent field.
      async standingAuthorityStepAuthorization(intent) {
        signalSuspended();
        await releaseGate;
        return buildAndSignStepAuthorization(fixture, {
          cycleId: intent.cycleId,
          actionKind: intent.stage,
          authorizationKind: intent.authorizationKind,
          subjectDigest: intent.requestDigest,
          destination: fixture.standingAuthority.allowedDestinations[0],
          pack: fixture.standingAuthority.allowedPacks[0],
          spendAmount: '10',
          nonce: 'return-standing-authority-race',
        });
      },
    },
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  // The lease-fenced Proxy wrapping `signerClient.solana` re-checks `assertLease` at the exact
  // moment `signApproved` would actually be invoked (its own `get` trap's returned wrapper, called
  // only when `guardedSignerRole` finally forwards through it) -- immediately after the
  // standing-authority guard's `await` above resolves. Flipping this only once that await is
  // genuinely suspended, then releasing it, proves a lease lost *during* the await refuses before
  // any broker call, not merely before some later unrelated step. `assertMutationAllowed` -- the
  // guard `guardedSignerRole` also reruns right after the same await, covering an authority
  // revocation through the identical call site -- is left permissive here to isolate the lease.
  let leaseLost = false;
  const context = {
    cycleId,
    stage: 'return',
    intent: { journalHead: 'standing-authority-race' },
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {
      if (leaseLost) throw new LeaseLostError('expired', { owner: 'cycle-runner', version: 1 });
    },
    async assertMutationAllowed() {},
  };

  const executed = driver.execute(context);
  await suspended;
  leaseLost = true;
  releaseAuthority();

  await assert.rejects(() => executed, LeaseLostError);
  assert.equal(brokerCalls, 0, 'a lease lost during the standing-authority await must refuse before the broker is ever reached');
});


for (const explicit of [false, true]) {
  test(`built-in production purchase reconciliation observes default adapters with explicit precedence=${explicit}`, async () => {
    const repository = writeAheadRepository();
    const owner = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
    const money = claimMoneyConfiguration();
    const amount = { ...money.assets.solanaStablecoin, amountAtomic: '17' };
    repository.describeCycle = async () => ({ admission: { unitPurchase: amount } });
    repository.readPackBatchIntent = async () => ({ intent: { playerAddress: owner } });
    repository.readPackBatchRequest = async () => ({ requestedAtMs: 0, packs: [{ packIndex: 0, memo: 'accepted-pack', expectedCardCount: 1 }] });
    await repository.prepareStageAttempt(CYCLE_ID, 'purchase', {
      schema: 'hookemon.provider-mutation-attempt.v1', cycleId: CYCLE_ID, stage: 'purchase',
      state: 'PREPARED', requestDigest: `sha256:${'a'.repeat(64)}`, responseDigest: null, reconciliationDigest: null,
    });
    let statusReads = 0;
    let rpcReads = 0;
    let leaseCurrent = true;
    const observedAdapters = {
      collectorCrypt: {
        async getPackStatus({ memo }) {
          statusReads += 1;
          return { memo, pack: { transaction_signature: 'accepted-signature', token_mint: CIRCLE_USD_MINT } };
        },
        async submitTransaction() { assert.fail('reconciliation must never submit again'); },
        async generateYoloPacks() { assert.fail('reconciliation must never generate again'); },
      },
      solana: { client: createSolanaRpcClient({ rpcUrl: 'https://solana.invalid', fetchImpl: async (_url, options) => {
        const { method, id } = JSON.parse(options.body);
        const reply = result => ({ ok: true, async text() { return JSON.stringify({ jsonrpc: '2.0', id, result }); } });
        rpcReads += 1;
        if (method === 'getSignatureStatuses') return reply({ value: [{ confirmationStatus: 'finalized', err: null }] });
        assert.equal(method, 'getTransaction');
        return reply({ meta: { err: null,
          preTokenBalances: [{ accountIndex: 0, owner, mint: CIRCLE_USD_MINT, uiTokenAmount: { amount: '20' } }],
          postTokenBalances: [{ accountIndex: 0, owner, mint: CIRCLE_USD_MINT, uiTokenAmount: { amount: '3' } }],
        }, transaction: { message: { accountKeys: [owner] } } });
      } }) },
    };
    const driver = createStageDriver({ liveMode: true,
      adapters: explicit ? { collectorCrypt: throwingCollectorCrypt(), solana: { client: null } } : observedAdapters,
      ...(explicit ? { reconciliationAdapters: observedAdapters } : {}),
      signerClient: throwingSigner(), cycleRepository: repository,
      config: baseConfig({ execution: { profile: 'production', providerMode: 'live' },
        accounts: { solana: owner }, solana: { chainId: 'solana-mainnet' },
        collectorCrypt: { settlementAsset: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: 6 } },
        moneyConfiguration: money,
      }),
    });
    const context = { cycleId: CYCLE_ID, stage: 'purchase', assertLease() { if (!leaseCurrent) throw new Error('lost reconciliation lease'); } };
    await assert.rejects(() => driver.execute(context), /requires reconciliation/);
    const evidence = await driver.reconcile(context);
    assert.equal(evidence.purchasedCount, 1);
    assert.equal(evidence.packs[0].packCost.amountAtomic, '17');
    assert.equal(statusReads, 1);
    assert.equal(rpcReads, 2);
    assert.deepEqual(await driver.reconcile(context), evidence);
    assert.equal(statusReads, 1, 'durably reconciled attempt must not query or resend again');
    // Re-open the unresolved boundary in this narrow journal fixture to isolate the existing fence.
    repository.attempts.get(`${CYCLE_ID}:purchase`).attempt.state = 'PREPARED';
    leaseCurrent = false;
    await assert.rejects(() => driver.reconcile(context), /lost reconciliation lease/);
    assert.equal(statusReads, 1, 'expired lease must prevent the provider observation');
  });
}


test('supplementary payout completion validates terminal identity without dispatching completed settlements', async () => {
  const position = { positionId: `held:${'a'.repeat(64)}`, cycleId: CYCLE_ID, evidenceDigest: `sha256:${'b'.repeat(64)}`, ownerDecision: { choice: 'sell' }, resolution: null };
  const initial = { positionId: position.positionId, cycleId: CYCLE_ID, manifestId: `${CYCLE_ID}:supplementary:1`, state: 'PAYOUT_BROADCAST', positionEvidenceDigest: position.evidenceDigest, eligibilitySnapshotEvidenceDigest: `sha256:${'c'.repeat(64)}`, payoutSourceDigest: `sha256:${'d'.repeat(64)}` };
  let refreshed = initial;
  let nextPatch = {};
  let calls = 0;
  let loseLease = false;
  const repository = fakeCycleRepository();
  repository.readSupplementarySettlement = async () => structuredClone(refreshed);
  repository.advanceSupplementarySettlement = async (id, input) => {
    assert.equal(id, position.positionId);
    assert.equal(input.expectedState, 'PAYOUT_BROADCAST');
    assert.equal(input.nextState, 'COMPLETE');
    refreshed = { ...initial, state: input.nextState, ...nextPatch };
    return refreshed;
  };
  const driver = createStageDriver({
    liveMode: true, adapters: {}, signerClient: null, config: baseConfig(), cycleRepository: repository,
    supplementaryAdapters: {}, supplementarySignerClient: {},
    productionSupplementaryStageHandlers: {
      PAYOUT_BROADCAST: { stage: 'supplementary-payout', async reconcile({ cycleRepository }) {
        calls += 1;
        await cycleRepository.advanceSupplementarySettlement(position.positionId, { expectedState: 'PAYOUT_BROADCAST', nextState: 'COMPLETE', evidence: { schema: 'hookemon.supplementary-payout-complete-evidence.v1', planDigest: `sha256:${'e'.repeat(64)}` } });
      } },
    },
  });
  const run = settlement => driver.runSupplementarySettlement({ position, settlement, assertLease() { if (loseLease && refreshed.state === 'COMPLETE') throw new Error('completion lease lost'); } });
  assert.deepEqual(await run(initial), { status: 'ADVANCED', positionId: position.positionId, cycleId: CYCLE_ID, manifestId: initial.manifestId, stage: 'supplementary-payout', state: 'COMPLETE' });
  await assert.rejects(() => run(refreshed), /not dispatchable/);
  assert.equal(calls, 1);
  for (const patch of [
    { positionId: `held:${'f'.repeat(64)}` },
    { cycleId: 'foreign-cycle' },
    { manifestId: `${CYCLE_ID}:supplementary:2` },
    { eligibilitySnapshotEvidenceDigest: `sha256:${'f'.repeat(64)}` },
    { payoutSourceDigest: `sha256:${'f'.repeat(64)}` },
  ]) {
    nextPatch = patch;
    refreshed = initial;
    await assert.rejects(() => run(initial), /does not bind|identity changed/);
  }
  nextPatch = {};
  refreshed = initial;
  loseLease = true;
  await assert.rejects(() => run(initial), /completion lease lost/);
});

test('return preparation preserves producer valuation identity without granting it to JSON', async () => {
  const admission = await nativeProducedAdmissionFixture(CYCLE_ID);
  const original = admission.aggregateFundingUsd;
  for (const [valuation, authenticated] of [[original, true], [JSON.parse(JSON.stringify(original)), false]]) {
    const cycleRepository = writeAheadRepository();
    const prepared = { provider: 'relay', destinationUsd: valuation };
    let observed;
    const driver = createStageDriver({
      liveMode: true,
      adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
      signerClient: null, config: baseConfig(), cycleRepository,
      ...fixtureStageDriverOptions,
      stageHandlers: { return: {
        async probe() { return {}; },
        async prepareRequest() { return prepared; },
        async mutate({ request }) {
          observed = request;
          assert.equal(isProcessQuoteUsdValuation(request.destinationUsd), authenticated);
          assert(Object.isFrozen(request));
          return { observed: true };
        },
        async reconcileLive() { return null; },
      } },
    });
    await driver.execute({ cycleId: CYCLE_ID, stage: 'return', intent: { journalHead: 'head-1' },
      assertMutationAllowed: async () => {} });
    if (authenticated) assert.equal(observed.destinationUsd, original);
    else assert.notEqual(observed.destinationUsd, original);
    assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'return')).attempt.requestDigest,
      digest({ schema: 'hookemon.operational-stage-request.v1', cycleId: CYCLE_ID, stage: 'return', request: prepared }));
  }
});

test('supplementary reconciliation preserves authenticated native payment binding', async () => {
  const authenticatedBinding = createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663' }, createTestProfileMutationAuthority());
  const nativePaymentBinding = authenticatedBinding;
  const position = {
    positionId: `held:${'a'.repeat(64)}`,
    cycleId: CYCLE_ID,
    packId: 'base-pack',
    memo: 'memo-supplementary-blockhash',
    mint: 'mint-supplementary-blockhash',
    cardRef: 'mint-supplementary-blockhash',
    costMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'1'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  let settlement = {
    positionId: position.positionId,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:9`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  const repository = fakeCycleRepository();
  repository.readSupplementarySettlement = async () => structuredClone(settlement);
  repository.advanceSupplementarySettlement = async (positionId, input) => {
    settlement = { ...settlement, state: input.nextState };
    return structuredClone(settlement);
  };

  let resolverCalls = 0;
  let observedBlockhash = null;
  const resolver = async blockhash => {
    resolverCalls += 1;
    observedBlockhash = blockhash;
    return { blockhash, lastValidBlockHeight: '4242' };
  };
  let receivedConfig = null;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({ nativePaymentBinding, solana: { chainId: 'solana-mainnet', blockhashContextResolver: resolver } }),
    cycleRepository: repository,
    supplementaryAdapters: Object.freeze({}),
    supplementarySignerClient: Object.freeze({}),
    productionSupplementaryStageHandlers: {
      PREPARED: {
        stage: 'supplementary-buyback',
        mutation: 'buyback',
        async reconcile({ config, cycleRepository: injectedRepository, settlement: receivedSettlement }) {
          receivedConfig = config;
          return injectedRepository.advanceSupplementarySettlement(position.positionId, {
            expectedState: receivedSettlement.state,
            nextState: 'BUYBACK_SENT_UNKNOWN',
            evidence: { requestDigest: `sha256:${'2'.repeat(64)}` },
          });
        },
      },
    },
  });

  const result = await driver.runSupplementarySettlement({
    position,
    settlement,
    nowMs: 1_001,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {},
  });

  assert.equal(isReleaseNativePaymentBinding(receivedConfig.nativePaymentBinding), true);
  assert.deepEqual(receivedConfig.nativePaymentBinding, nativePaymentBinding);
  assert.equal(Object.isFrozen(receivedConfig.nativePaymentBinding), true);
  assert.equal(result.status, 'ADVANCED');
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(Object.isFrozen(receivedConfig), true);
  assert.equal(Object.isFrozen(receivedConfig.solana), true);
  assert.equal(receivedConfig.solana.chainId, 'solana-mainnet');
  assert.equal(typeof receivedConfig.solana.blockhashContextResolver, 'function');
  assert.deepEqual(
    await receivedConfig.solana.blockhashContextResolver('observed-blockhash-xyz'),
    { blockhash: 'observed-blockhash-xyz', lastValidBlockHeight: '4242' },
  );
  assert.equal(resolverCalls, 1);
  assert.equal(observedBlockhash, 'observed-blockhash-xyz');
});


test('supplementary reconciliation rejects a serialized binding capability', async () => {
  const authenticatedBinding = createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663' }, createTestProfileMutationAuthority());
  const nativePaymentBinding = structuredClone(authenticatedBinding);
  const position = {
    positionId: `held:${'a'.repeat(64)}`,
    cycleId: CYCLE_ID,
    packId: 'base-pack',
    memo: 'memo-supplementary-blockhash',
    mint: 'mint-supplementary-blockhash',
    cardRef: 'mint-supplementary-blockhash',
    costMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: `sha256:${'1'.repeat(64)}`,
    openedAtMs: 1_000,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  };
  let settlement = {
    positionId: position.positionId,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:9`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
  };
  const repository = fakeCycleRepository();
  repository.readSupplementarySettlement = async () => structuredClone(settlement);
  repository.advanceSupplementarySettlement = async (positionId, input) => {
    settlement = { ...settlement, state: input.nextState };
    return structuredClone(settlement);
  };

  let resolverCalls = 0;
  let observedBlockhash = null;
  const resolver = async blockhash => {
    resolverCalls += 1;
    observedBlockhash = blockhash;
    return { blockhash, lastValidBlockHeight: '4242' };
  };
  let receivedConfig = null;
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig({ nativePaymentBinding, solana: { chainId: 'solana-mainnet', blockhashContextResolver: resolver } }),
    cycleRepository: repository,
    supplementaryAdapters: Object.freeze({}),
    supplementarySignerClient: Object.freeze({}),
    productionSupplementaryStageHandlers: {
      PREPARED: {
        stage: 'supplementary-buyback',
        mutation: 'buyback',
        async reconcile({ config, cycleRepository: injectedRepository, settlement: receivedSettlement }) {
          receivedConfig = config;
          return injectedRepository.advanceSupplementarySettlement(position.positionId, {
            expectedState: receivedSettlement.state,
            nextState: 'BUYBACK_SENT_UNKNOWN',
            evidence: { requestDigest: `sha256:${'2'.repeat(64)}` },
          });
        },
      },
    },
  });

  const result = await driver.runSupplementarySettlement({
    position,
    settlement,
    nowMs: 1_001,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    assertLease() {},
  });

  assert.equal(isReleaseNativePaymentBinding(receivedConfig.nativePaymentBinding), false);
  assert.deepEqual(receivedConfig.nativePaymentBinding, nativePaymentBinding);
  assert.equal(Object.isFrozen(receivedConfig.nativePaymentBinding), true);
  assert.equal(result.status, 'ADVANCED');
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(Object.isFrozen(receivedConfig), true);
  assert.equal(Object.isFrozen(receivedConfig.solana), true);
  assert.equal(receivedConfig.solana.chainId, 'solana-mainnet');
  assert.equal(typeof receivedConfig.solana.blockhashContextResolver, 'function');
  assert.deepEqual(
    await receivedConfig.solana.blockhashContextResolver('observed-blockhash-xyz'),
    { blockhash: 'observed-blockhash-xyz', lastValidBlockHeight: '4242' },
  );
  assert.equal(resolverCalls, 1);
  assert.equal(observedBlockhash, 'observed-blockhash-xyz');
});


test('chain preparation retains only the explicit live clock across canonical configuration', async () => {
  let timestamp = 1_700_000_000_000;
  const now = () => timestamp;
  const cycleRepository = writeAheadRepository();
  const marker = new Error('stop after read-only clock preparation');
  const driver = createStageDriver({ liveMode: true,
    adapters: { relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null, config: baseConfig({ now, effectfulCapability() { throw new Error('must not execute'); } }),
    cycleRepository, ...fixtureStageDriverOptions,
    stageHandlers: { return: { chainJournal: true,
      async probe() { return {}; },
      async prepareRequest(input) {
        assert.equal(input.now, now);
        assert.equal(input.now(), timestamp);
        assert.notEqual(typeof input.config.now, 'function');
        assert.notEqual(typeof input.config.effectfulCapability, 'function');
        await Promise.resolve();
        timestamp += 7;
        assert.equal(input.now(), 1_700_000_000_007, 'post-response valuation receives the current clock');
        throw marker;
      },
      async mutate() { throw new Error('must not sign'); },
      async reconcileLive() { return null; },
    } },
  });
  await assert.rejects(() => driver.execute({ cycleId: CYCLE_ID, stage: 'return',
    intent: { journalHead: 'clock-preparation' }, assertMutationAllowed: async () => {} }), error => error === marker);
});
