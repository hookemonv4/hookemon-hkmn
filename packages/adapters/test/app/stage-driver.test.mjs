import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keccak256, parseTransaction, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { LeaseLostError } from '../../../runner/src/automation/exclusive-lease.mjs';
import { LiveModeIntegrationPendingError, createStageDriver } from '../../src/app/stage-driver.mjs';
import { ReturnRecoveryRequiredError } from '../../src/app/stages/return.mjs';
import { preparePurchaseRequest } from '../../src/app/stages/purchase.mjs';
import { createSolanaRpcClient, submitSignedTransaction } from '../../src/solana-rpc.mjs';
import { AUTOMATED_CYCLE_STAGES } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createPreparedChainTransactionAttempt, createRecordedRelayLeg } from '../../../runner/src/cycle/money-schemas.mjs';
import { createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { RelayQuoteExpiredError } from '../../src/relay-client.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { createKeychainSignerClient } from '../../src/signing/keychain-signer.mjs';
import { TransactionPolicyError } from '../../src/signing/transaction-policy.mjs';
import { buildAndSignStepAuthorization, createProductionTestFixture } from '../../../runner/test/cycle/production-cycle.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

const CYCLE_ID = 'cycle-test-1';
const fixtureStageDriverOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

async function durableCycle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-stage-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
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
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  const solanaStablecoin = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
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
  const { repository, cycleId } = await durableCycle(t);
  const operations = '0x000000000000000000000000000000000000dead';
  const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  const sourceAsset = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const solanaOwner = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
  const solanaMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const sourceAmount = '25';
  const destinationAmount = '24';
  const sourceHash = `0x${'a'.repeat(64)}`;
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
    source: { chainId: '4663', assetId: sourceAsset, decimals: 6, amountAtomic: sourceAmount },
    destination: { chainId: '792703809', assetId: solanaMint, decimals: 6, amountAtomic: destinationAmount },
  }));
  await repository.reserveWalletNonce(cycleId, {
    chainId: '4663', wallet: operations, stage: 'outbound', fencingToken,
    leaseAcquiredAtMs: 0, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', createPreparedChainTransactionAttempt({
    cycleId,
    stage: 'outbound',
    requestDigest,
  }));
  await repository.recordSignedTransactionWithRecoveryContext(
    cycleId,
    'outbound',
    requestDigest,
    { rawBytes: '0x1234', nonce: '9', blockhash: null, hash: sourceHash },
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
      relayIntent: {
        schema: 'hookemon.relay-intent.v1',
        requestId: relayRequestId,
        orderId: `0x${'2'.repeat(64)}`,
        direction: 'OUTBOUND',
        originChainId: 4663,
        destinationChainId: 792703809,
        originAssetId: sourceAsset,
        originDecimals: 6,
        destinationAssetId: solanaMint,
        destinationDecimals: 6,
        originAmount: sourceAmount,
        quotedDestinationAmount: destinationAmount,
        quotedDestinationMinimumAmount: destinationAmount,
        sender: operations,
        recipient: solanaOwner,
        deadlineUnixSeconds: 1700000200,
      },
      relayRoute: {
        sourceSender: operations,
        sourceRecipient: depository,
        destinationOwner: solanaOwner,
      },
    },
    { relayRequestId, sourceTxHash: sourceHash },
  );
  await repository.recordBroadcast(cycleId, 'outbound', requestDigest, { transactionHash: sourceHash });

  const receiptBlockHash = `0x${'2'.repeat(64)}`;
  const parentBlockHash = `0x${'3'.repeat(64)}`;
  const sourceClient = {
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, sourceHash);
      return {
        transactionHash: sourceHash,
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: 'success',
        logs: [{
          address: sourceAsset,
          topics: [
            ERC20_TRANSFER_TOPIC,
            `0x${'0'.repeat(24)}${operations.slice(2)}`,
            `0x${'0'.repeat(24)}${depository.slice(2)}`,
          ],
          data: `0x${BigInt(sourceAmount).toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') return { number: 101n, hash: `0x${'4'.repeat(64)}`, timestamp: 1_700_000_090n };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, parentHash: parentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: parentBlockHash, parentHash: `0x${'5'.repeat(64)}`, timestamp: 1_700_000_070n };
      throw new Error('unexpected outbound source block read');
    },
  };
  const historicalEvidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
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
  assert.equal(evidence.schema, 'hookemon.outbound-relay-settlement-evidence.v1');
  assert.equal(evidence.relayLeg.state, 'SETTLED');
  await driver.commit({ ...context, evidence });
  await repository.completeStage(cycleId, 'outbound', evidence);
  assert.equal((await repository.readStage(cycleId, 'outbound')).status, 'COMPLETE');
  assert.equal((await repository.readChainTransactionAttempt(cycleId, 'outbound', requestDigest)).attempt.state, 'FINALIZED');
  assert.ok(leaseChecks > 0, 'the reconciliation facade fences durable reads and writes with the active lease');

  const replay = await driver.reconcile(context);
  assert.deepEqual(replay, evidence, 'a SETTLED replay returns canonical durable evidence without another settlement');
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

test('the remaining frozen built-in mutation stages refuse live mutations before legacy provider handlers run', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: throwingCollectorCrypt(), relay: throwingRelay(), robinhood: { client: null }, solana: { client: null } },
    signerClient: throwingSigner(),
    config: baseConfig(),
    cycleRepository,
  });

  for (const stage of AUTOMATED_CYCLE_STAGES.filter(stage => !['eligibility-snapshot', 'claim-process', 'outbound', 'return', 'payout'].includes(stage))) {
    await assert.rejects(
      () => driver.execute({ cycleId: CYCLE_ID, stage, intent: { journalHead: `pending-${stage}` } }),
      error => error instanceof LiveModeIntegrationPendingError && error.stage === stage,
    );
    const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, stage);
    assert.equal(attempt.attempt.state, 'PREPARED');
  }
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
      usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    },
    accounts: { evm: account.address, solana: null },
    nativeGasCaps: { robinhood: '100', solana: '1' },
    moneyConfiguration: claimMoneyConfiguration(),
  });
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
        },
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
  const client = {
    async getChainId() { return 4663; },
    async getTransactionCount() { return 0n; },
    async estimateGas() { return 100n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; },
    async getBalance() { return 1_000_000n; },
    async sendRawTransaction() { throw new Error('broadcast response lost after acceptance'); },
  };
  const config = baseConfig({
    contracts: {
      vault: null,
      hook: `0x${'1'.repeat(40)}`,
      usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    },
    accounts: { evm: account.address, solana: null },
    nativeGasCaps: { robinhood: '100', solana: '1' },
    moneyConfiguration: claimMoneyConfiguration(),
  });
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client }, solana: { client: null } },
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
      contracts: { vault: null, hook: `0x${'1'.repeat(40)}`, usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
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
    async describeCycle() { return { releaseAmount: '1', chainAttempts: new Map(chainAttempts), custodyLedgers: new Map(custodyLedgers) }; },
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

  const reopened = await CycleRepository.open(directory);
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

test('holds a keychain interaction denial with redacted OS text before any broadcast', async t => {
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
    /User interaction is not allowed/,
  );
  assert.equal(keychainCalls, 1);
  assert.equal(broadcasts, 0);

  const reopened = await CycleRepository.open(directory);
  const cycle = await reopened.describeCycle(cycleId);
  assert.equal(cycle.terminalState, 'HELD_UNAVAILABLE');
  assert.equal(cycle.operationalAttempts.get('purchase').attempt.state, 'NOT_SENT');
  assert.match(cycle.terminalEvidence.error, /User interaction is not allowed/);
  assert.doesNotMatch(cycle.terminalEvidence.error, new RegExp(secret.slice(2, 16)));
  await assert.rejects(() => reopened.prepareStage(cycleId, 'purchase'), /terminal as HELD_UNAVAILABLE/);
});

test('holds an expired Relay quote before any request or broadcast', async t => {
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

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_UNAVAILABLE');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'outbound'), null);
  await assert.rejects(() => reopened.prepareStage(cycleId, 'outbound'), /terminal as HELD_UNAVAILABLE/);
});

test('holds a lost lease before a provider effect and retains a NOT_SENT retry record', async t => {
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

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, 'HELD_UNAVAILABLE');
  assert.equal(state.operationalAttempts.get('purchase').attempt.state, 'NOT_SENT');
  assert.deepEqual(state.terminalEvidence.lease, { owner: 'cycle-runner', version: 4 });
  await assert.rejects(() => reopened.prepareStage(cycleId, 'purchase'), /terminal as HELD_UNAVAILABLE/);
});

async function assertPolicyRefusalHeld(t, message) {
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
  assert.equal(broadcasts, 0);
  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(state.operationalAttempts.get('purchase').attempt.state, 'NOT_SENT');
  await assert.rejects(() => reopened.prepareStage(cycleId, 'purchase'), /terminal as HELD_DATA_UNVERIFIED/);
}

test('holds a wrong-asset transaction policy refusal before signing', async t => {
  await assertPolicyRefusalHeld(t, 'transaction policy refused a wrong asset');
});

test('holds a wrong-recipient transaction policy refusal before signing', async t => {
  await assertPolicyRefusalHeld(t, 'transaction policy refused a wrong recipient');
});

test('holds an expired return blockhash while retaining a broadcast attempt after reopen', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const requestDigest = `sha256:${'d'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'return', createPreparedChainTransactionAttempt({
    cycleId,
    stage: 'return',
    requestDigest,
  }));
  await repository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: 'return-signed-bytes',
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
  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_UNAVAILABLE');
  assert.equal((await reopened.readChainTransactionAttempt(cycleId, 'return', requestDigest)).attempt.state, 'BROADCAST');
  await assert.rejects(() => reopened.prepareStage(cycleId, 'return'), /terminal as HELD_UNAVAILABLE/);
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
  const fixture = createProductionTestFixture();
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

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.standingAuthorityDecisions.size, 0);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'outbound')).attempt.state, 'NOT_SENT');
});

test('production signing replays a stored authority after expiry with one signer and a reopened reconciliation attempt', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const fixture = createProductionTestFixture({
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

  const reopened = await CycleRepository.open(directory);
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
      purchase: {
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
      stage: 'purchase',
      intent: { journalHead: 'head-read-fence' },
      assertLease() {
        if (!leaseCurrent) throw new Error('lease expired before reconciliation read');
      },
    }),
    /lease expired before reconciliation read/,
  );
  assert.equal(readCalls, 0);
  assert.equal((await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase')).attempt.state, 'RESPONSE_RECORDED');
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

  const reopened = await CycleRepository.open(directory);
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

  const reopened = await CycleRepository.open(directory);
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
    releaseAmountMicroUsdg: '5',
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
    assert.equal(guard.releaseAmountMicroUsdg, '5');
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
    releaseAmountMicroUsdg: '5',
    packId: 'base-pack',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    async assertMutationAllowed(input) {
      guards.push(input);
      calls.push(['guard', input.boundary]);
    },
  });

  assert.deepEqual(calls.map(call => call[0]), [
    'guard', 'mutate', 'guard', 'generatePack', 'guard', 'submitTransaction', 'guard', 'sendRawTransaction',
  ]);
  assert.deepEqual(guards.map(guard => guard.boundary), ['mutation', 'mutation', 'broadcast', 'broadcast']);
  for (const guard of guards) {
    assert.equal(guard.stage, 'purchase');
    assert.match(guard.requestDigest, /^sha256:[0-9a-f]{64}$/);
  }
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
    releaseAmountMicroUsdg: '5',
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

test('pending provider stages refuse live mutations while the eligibility snapshot stays read-only', async () => {
  const cycleRepository = writeAheadRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
  });
  for (const stage of AUTOMATED_CYCLE_STAGES.filter(stage => !['eligibility-snapshot', 'claim-process', 'outbound', 'return', 'payout'].includes(stage))) {
    await assert.rejects(
      () => driver.execute({ cycleId: CYCLE_ID, stage, intent: { journalHead: `head-${stage}` } }),
      error => error instanceof LiveModeIntegrationPendingError && error.stage === stage,
    );
    const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, stage);
    assert.equal(attempt.attempt.state, 'PREPARED');
  }
  await assert.rejects(
    () => driver.execute({ cycleId: CYCLE_ID, stage: 'eligibility-snapshot', intent: { journalHead: 'head-eligibility-snapshot' } }),
    /read-only reconciliation/i,
  );
  assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'eligibility-snapshot'), null);
});

test('built-in payout holds a lost lease before payout preparation or signing', async t => {
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
  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_UNAVAILABLE');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'payout'), null);
  await assert.rejects(() => reopened.prepareStage(cycleId, 'payout'), /terminal as HELD_UNAVAILABLE/);
});

test('the built-in driver derives direct payout policy around a guarded raw signer', async () => {
  const token = `0x${'a'.repeat(40)}`;
  const recipient = `0x${'2'.repeat(40)}`;
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const operations = account.address.toLowerCase();
  const cycleId = 'cycle-direct-payout-driver';
  const amount = createUsdgPayoutAmount({ assetId: token, amountAtomic: '9' });
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
    destinationAsset: token,
    destinationCreditAmount: amount.amountAtomic,
  };
  let broadcastHash = null;
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
      logs: [{
        address: token,
        topics: [
          ERC20_TRANSFER_TOPIC,
          `0x${'0'.repeat(24)}${operations.slice(2)}`,
          `0x${'0'.repeat(24)}${recipient.slice(2)}`,
        ],
        data: `0x${BigInt(amount.amountAtomic).toString(16).padStart(64, '0')}`,
        logIndex: '0',
      }],
    };
  };
  const client = {
    async readContract({ functionName }) { assert.equal(functionName, 'isFrozen'); return false; },
    async getTransactionCount() { return 0n; },
    async getBalance() { return 1_000_000n; },
    async getTransaction({ hash }) { return hash === broadcastHash ? { hash } : null; },
    async getTransactionReceipt({ hash }) {
      const value = receipt();
      if (!value || hash !== broadcastHash) throw new TransactionReceiptNotFoundError({ hash });
      return value;
    },
    async getBlock({ blockNumber } = {}) {
      if (blockNumber === 99n) return { number: 99n, hash: `0x${'e'.repeat(64)}`, timestamp: 99n };
      return { number: 100n, hash: `0x${'f'.repeat(64)}`, parentHash: `0x${'e'.repeat(64)}`, timestamp: 100n };
    },
  };
  const historicalEvidenceClient = {
    async readErc20BalanceAtBlock({ account: observedAccount, blockNumber, blockHash }) {
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
      schema: 'hookemon.money-configuration.v1',
      assets: {
        usdg: { chainId: '4663', assetId: token, decimals: 6 },
        solanaStablecoin: {
          chainId: '792703809',
          assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
        },
      },
      minimums: {
        robinhoodReceive: { chainId: '4663', assetId: token, decimals: 6, amountAtomic: '0' },
        solanaReceive: {
          chainId: '792703809',
          assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
          amountAtomic: '0',
        },
        returnUsdg: { chainId: '4663', assetId: token, decimals: 6, amountAtomic: '0' },
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
});
