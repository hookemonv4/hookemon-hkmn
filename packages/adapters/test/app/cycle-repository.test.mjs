import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CYCLE_REPOSITORY_CLIENT_INTERFACE,
  CycleRepository,
  createCycleRepositoryClient,
} from '../../src/app/cycle-repository.mjs';
import { readOutboundOriginRefundProof } from '../../src/app/stages/outbound.mjs';
import { readReturnLegDestinationProof } from '../../src/app/stages/return.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { ERC20_TRANSFER_TOPIC, readFinalizedErc20TransferProof } from '../../src/robinhood-rpc.mjs';
import { createSolanaRpcClient, readFinalizedRelayDestinationObservation } from '../../src/solana-rpc.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { CycleJournal, digest } from '../../../runner/src/cycle/journal.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

const SETTLEMENT_SOURCE_ASSET = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SETTLEMENT_SOURCE_ACCOUNT = '0x000000000000000000000000000000000000dEaD';
const SETTLEMENT_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const SETTLEMENT_SOLANA_OWNER = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SETTLEMENT_SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const stageDriverTestAuthority = createTestProfileMutationAuthority();

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-cycle-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function custodyLedger(cycleId, overrides = {}) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:stablecoin',
    decimals: 6,
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
    ...overrides,
  };
}

function preparedChainAttempt(cycleId, stage = 'claim-process', requestDigest = `sha256:${'a'.repeat(64)}`) {
  return {
    schema: 'hookemon.chain-transaction-attempt.v1',
    cycleId,
    stage,
    state: 'PREPARED',
    requestDigest,
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
  };
}

function relayLeg(cycleId, overrides = {}) {
  return {
    schema: 'hookemon.relay-leg.v1',
    cycleId,
    direction: 'outbound',
    relayRequestId: `relay-${cycleId}`,
    quoteDigest: `sha256:${'1'.repeat(64)}`,
    sourceChainId: '4663',
    sourceTxHash: null,
    sourceAssetId: 'USDG',
    sourceDecimals: 6,
    sourceAmountAtomic: '25000000',
    destinationChainId: '792703809',
    destinationTxHash: null,
    destinationAssetId: 'Solana-stablecoin',
    destinationDecimals: 6,
    destinationAmountAtomic: '24694978',
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
    ...overrides,
  };
}

function returnRelayLeg(cycleId, overrides = {}) {
  const relayRequestId = `relay-return-${cycleId}`;
  return {
    schema: 'hookemon.relay-leg.v1',
    cycleId,
    direction: 'return',
    relayRequestId,
    quoteDigest: `sha256:${'9'.repeat(64)}`,
    sourceChainId: '792703809',
    sourceTxHash: null,
    sourceAssetId: SETTLEMENT_SOLANA_MINT,
    sourceDecimals: 6,
    sourceAmountAtomic: '17',
    destinationChainId: '4663',
    destinationTxHash: null,
    destinationAssetId: SETTLEMENT_SOURCE_ASSET,
    destinationDecimals: 6,
    destinationAmountAtomic: '16',
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: {
        schema: 'hookemon.relay-intent.v1',
        requestId: relayRequestId,
        orderId: `0x${'8'.repeat(64)}`,
        direction: 'RETURN',
        originChainId: 792703809,
        destinationChainId: 4663,
        originAssetId: SETTLEMENT_SOLANA_MINT,
        originDecimals: 6,
        destinationAssetId: SETTLEMENT_SOURCE_ASSET,
        destinationDecimals: 6,
        originAmount: '17',
        quotedDestinationAmount: '16',
        quotedDestinationMinimumAmount: '16',
        sender: SETTLEMENT_SOLANA_OWNER,
        recipient: SETTLEMENT_SOURCE_ACCOUNT.toLowerCase(),
        deadlineUnixSeconds: 1_800_000_000,
      },
      requestCreatedAtUnixSeconds: '1700000000',
      maxSettlementWindowSeconds: '600',
    },
    ...overrides,
  };
}

function unbrandedReturnDestinationProof(leg, {
  destinationTxHash = `0x${'f'.repeat(64)}`,
  observedToken = SETTLEMENT_SOURCE_ASSET,
  observedRecipient = SETTLEMENT_SOURCE_ACCOUNT.toLowerCase(),
  observedAmountAtomic = leg.destinationAmountAtomic,
  destinationTimestampUnixSeconds = '1700000011',
  } = {}) {
  return {
    schema: 'hookemon.return-leg-destination-proof.v1',
    relayRequestId: leg.relayRequestId,
    terminalStatus: { status: 'SUCCESS', destinationTxHash },
    sourceTxHash: leg.sourceTxHash,
    sourceFinality: { height: '52', hash: 'return-source-slot', timestampUnixSeconds: '1700000010' },
    destinationTxHash,
    destinationFinality: { height: '100', hash: `0x${'d'.repeat(64)}`, timestampUnixSeconds: destinationTimestampUnixSeconds },
    transferCount: 1,
    observedToken,
    observedRecipient,
    observedAmountAtomic,
  };
}

function returnDestinationReceiptClient({
  transactionHash,
  observedToken,
  observedRecipient,
  observedAmountAtomic,
  destinationTimestampUnixSeconds,
} = {}) {
  const receiptBlockHash = `0x${'a'.repeat(64)}`;
  const finalizedBlockHash = `0x${'b'.repeat(64)}`;
  return {
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, transactionHash);
      return {
        transactionHash,
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: 'success',
        logs: [{
          address: observedToken,
          topics: [
            ERC20_TRANSFER_TOPIC,
            addressTopic(`0x${'1'.repeat(40)}`),
            addressTopic(observedRecipient),
          ],
          data: `0x${BigInt(observedAmountAtomic).toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') {
        return { number: 101n, hash: finalizedBlockHash, timestamp: BigInt(destinationTimestampUnixSeconds) };
      }
      if (blockNumber === 100n) {
        return { number: 100n, hash: receiptBlockHash, timestamp: BigInt(destinationTimestampUnixSeconds) };
      }
      throw new Error(`unexpected return receipt block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

async function returnDestinationProof(leg, options = {}) {
  const raw = unbrandedReturnDestinationProof(leg, options);
  return readReturnLegDestinationProof({
    client: returnDestinationReceiptClient({
      transactionHash: raw.destinationTxHash,
      observedToken: raw.observedToken,
      observedRecipient: raw.observedRecipient,
      observedAmountAtomic: raw.observedAmountAtomic,
      destinationTimestampUnixSeconds: raw.destinationFinality.timestampUnixSeconds,
    }),
    pointer: {
      schema: 'hookemon.relay-terminal-destination-pointer.v1',
      relayRequestId: leg.relayRequestId,
      status: 'SUCCESS',
      destinationTxHash: raw.destinationTxHash,
    },
    leg,
    sourceFinality: raw.sourceFinality,
  });
}

async function prepareReturnRelaySettlementAttempt(repository, cycleId, leg, sourceTxHash) {
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'return', preparedChainAttempt(cycleId, 'return', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: 'return-signed-bytes', nonce: null, blockhash: 'return-blockhash', hash: `sha256:${'6'.repeat(64)}`,
  });
  await repository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: sourceTxHash });
  await repository.recordFinality(cycleId, 'return', requestDigest, {
    transactionHash: sourceTxHash,
    debitedAmountAtomic: leg.sourceAmountAtomic,
    finalizedAtSource: { height: '52', hash: 'return-source-slot', timestampUnixSeconds: '1700000010' },
  });
  return requestDigest;
}

async function finalizedReturnFixture(t, {
  proof = {},
} = {}) {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, returnRelayLeg(cycleId));
  const sourceTxHash = `return-source-${cycleId}`;
  const attributed = await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  const requestDigest = await prepareReturnRelaySettlementAttempt(repository, cycleId, attributed, sourceTxHash);
  return {
    directory,
    repository,
    cycleId,
    leg: attributed,
    requestDigest,
    submission: { returnDestinationProof: await returnDestinationProof(attributed, proof) },
  };
}

async function assertRelayHoldRecoveryTuple({
  repository,
  cycleId,
  stage,
  requestDigest,
  expectedTerminalState,
}) {
  const before = await repository.readChainTransactionAttempt(cycleId, stage, requestDigest);
  const state = await repository.describeCycle(cycleId);
  assert.deepEqual({
    terminalState: state.terminalState,
    attemptState: before.attempt.state,
    nextDecision: state.terminalState?.startsWith('HELD_RELAY_') ? 'owner-decision' : null,
  }, {
    terminalState: expectedTerminalState,
    attemptState: 'FINALIZED',
    nextDecision: 'owner-decision',
  });

  // A held Relay leg has no automatic next stage. The only recovery path is an owner decision.
  await assert.rejects(() => repository.prepareStage(cycleId, 'payout'), /terminal/i);
  const signerKey = stage === 'outbound' ? 'evm' : 'solana';
  let signerCalls = 0;
  const driver = createStageDriver({
    liveMode: true,
    adapters: {},
    signerClient: {
      [signerKey]: {
        async sign() {
          signerCalls += 1;
          return { schema: 'test-relay-recovery-signature.v1' };
        },
      },
    },
    config: {},
    cycleRepository: repository,
    preflightAuthority: stageDriverTestAuthority,
    stageHandlers: {
      [stage]: {
        async probe() { return null; },
        async prepareRequest() { return { schema: 'test-relay-recovery-request.v1' }; },
        async mutate({ signerClient }) { return signerClient[signerKey].sign({ bytes: 'test-relay-recovery-bytes' }); },
        async reconcileLive() { return null; },
      },
    },
  });
  await assert.rejects(
    () => driver.execute({
      cycleId,
      stage,
      intent: { recovery: 'held-relay' },
      async assertMutationAllowed() {},
    }),
    /terminal/i,
  );
  assert.equal(signerCalls, 0, 'a terminal Relay hold must reject before reaching a signer');
  // A finalized durable attempt cannot become a second signature, even when replay supplies its
  // exact original bytes. Keep the durable attempt byte-for-byte unchanged after that refusal.
  await assert.rejects(
    () => repository.recordSignedTransaction(cycleId, stage, requestDigest, {
      rawBytes: before.attempt.rawBytes,
      nonce: before.attempt.nonce,
      blockhash: before.attempt.blockhash,
      hash: before.attempt.hash,
    }),
    /terminal|already broadcast and cannot be re-signed/i,
  );
  assert.deepEqual((await repository.readChainTransactionAttempt(cycleId, stage, requestDigest)).attempt, before.attempt);
}

test('settleRelayLeg rejects a syntactically valid but unbranded return destination proof', async t => {
  const fixture = await finalizedReturnFixture(t);
  const unbrandedSubmission = {
    returnDestinationProof: unbrandedReturnDestinationProof(fixture.leg),
  };

  await assert.rejects(
    () => fixture.repository.settleRelayLeg(
      fixture.cycleId,
      fixture.leg.relayRequestId,
      unbrandedSubmission,
    ),
    /own process RPC return destination proof/i,
  );

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'RECORDED');
  assert.equal(state.custodyLedgers.get(`4663\u0000${SETTLEMENT_SOURCE_ASSET}`), undefined);
});

test('settleRelayLeg rejects a return destination proof changed after process-RPC observation', async t => {
  const fixture = await finalizedReturnFixture(t);
  fixture.submission.returnDestinationProof.observedAmountAtomic = '15';

  await assert.rejects(
    () => fixture.repository.settleRelayLeg(
      fixture.cycleId,
      fixture.leg.relayRequestId,
      fixture.submission,
    ),
    /own process RPC return destination proof/i,
  );

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'RECORDED');
  assert.equal(state.custodyLedgers.get(`4663\u0000${SETTLEMENT_SOURCE_ASSET}`), undefined);
});

function relayFinality(height, hash, timestampUnixSeconds) {
  return { height, hash, timestampUnixSeconds };
}

function rpcResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

async function finalizedOutboundSourceProof({ transactionHash, amountAtomic }) {
  const amount = BigInt(amountAtomic);
  const receiptBlockHash = `0x${'a'.repeat(64)}`;
  const parentBlockHash = `0x${'b'.repeat(64)}`;
  const client = {
    async getTransactionReceipt({ hash }) {
      assert.equal(hash, transactionHash);
      return {
        transactionHash,
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: 'success',
        logs: [{
          address: SETTLEMENT_SOURCE_ASSET,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(SETTLEMENT_SOURCE_ACCOUNT), addressTopic(SETTLEMENT_DEPOSITORY)],
          data: `0x${amount.toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') return { number: 101n, hash: `0x${'c'.repeat(64)}`, timestamp: 1_700_000_090n };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, parentHash: parentBlockHash, timestamp: 1_700_000_080n };
      if (blockNumber === 99n) return { number: 99n, hash: parentBlockHash, parentHash: `0x${'d'.repeat(64)}`, timestamp: 1_700_000_070n };
      throw new Error(`unexpected source proof block read ${String(blockTag ?? blockNumber)}`);
    },
  };
  const evidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const source = account.toLowerCase() === SETTLEMENT_SOURCE_ACCOUNT.toLowerCase();
      const value = source
        ? (blockNumber === 99n ? 100_000_000n : 100_000_000n - amount)
        : (blockNumber === 99n ? 5_000_000n : 5_000_000n + amount);
      return { value, blockNumber, blockHash };
    },
  };
  return readFinalizedErc20TransferProof(client, {
    hash: transactionHash,
    token: SETTLEMENT_SOURCE_ASSET,
    source: SETTLEMENT_SOURCE_ACCOUNT,
    recipient: SETTLEMENT_DEPOSITORY,
    amountAtomic,
    evidenceClient,
  });
}

async function finalizedDestinationObservation({ relayRequestId, mint, amountAtomic, timestampUnixSeconds = 1_700_000_100 }) {
  const signature = `relay-destination-${relayRequestId}`;
  const client = createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.method, 'getTransaction');
      return rpcResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          slot: 88,
          blockTime: timestampUnixSeconds,
          transaction: {
            message: {
              accountKeys: ['TokenAccount1111111111111111111111111111111'],
              instructions: [{ program: 'spl-memo', parsed: relayRequestId }],
            },
          },
          meta: {
            err: null,
            preTokenBalances: [{
              accountIndex: 0,
              mint,
              owner: SETTLEMENT_SOLANA_OWNER,
              uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' },
            }],
            postTokenBalances: [{
              accountIndex: 0,
              mint,
              owner: SETTLEMENT_SOLANA_OWNER,
              uiTokenAmount: { amount: (100n + BigInt(amountAtomic)).toString(), decimals: 6, uiAmountString: '0.0001' },
            }],
          },
        },
      });
    },
  });
  return readFinalizedRelayDestinationObservation(client, {
    signature,
    owner: SETTLEMENT_SOLANA_OWNER,
    relayRequestId,
  });
}

function outboundRelayIntent(leg, deadlineUnixSeconds) {
  return {
    schema: 'hookemon.relay-intent.v1',
    requestId: leg.relayRequestId,
    orderId: `0x${'c'.repeat(64)}`,
    direction: 'OUTBOUND',
    originChainId: Number(leg.sourceChainId),
    destinationChainId: Number(leg.destinationChainId),
    originAssetId: leg.sourceAssetId,
    originDecimals: leg.sourceDecimals,
    destinationAssetId: leg.destinationAssetId,
    destinationDecimals: leg.destinationDecimals,
    originAmount: leg.sourceAmountAtomic,
    quotedDestinationAmount: leg.destinationAmountAtomic,
    quotedDestinationMinimumAmount: leg.destinationAmountAtomic,
    sender: SETTLEMENT_SOURCE_ACCOUNT,
    recipient: SETTLEMENT_SOLANA_OWNER,
    deadlineUnixSeconds: Number(deadlineUnixSeconds),
  };
}

function outboundRelayRoute() {
  return {
    sourceSender: SETTLEMENT_SOURCE_ACCOUNT,
    sourceRecipient: SETTLEMENT_DEPOSITORY,
    destinationOwner: SETTLEMENT_SOLANA_OWNER,
  };
}

async function prepareOutboundRelaySettlementAttempt(
  repository,
  cycleId,
  transactionHash,
  deadlineUnixSeconds,
  leg,
  { relayRoute = outboundRelayRoute() } = {},
) {
  const requestDigest = `sha256:${'e'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', preparedChainAttempt(cycleId, 'outbound', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'outbound', requestDigest, {
    rawBytes: '0x1234', nonce: '7', blockhash: null, hash: transactionHash,
  });
  await repository.persistChainAttemptRecoveryContext(cycleId, {
    stage: 'outbound',
    recipient: null,
    requestDigest,
    policyDigest: `sha256:${'1'.repeat(64)}`,
    approvalDigest: `sha256:${'2'.repeat(64)}`,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    fencingTokenDigest: `sha256:${'3'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'4'.repeat(64)}`,
    rawSignedBytesHash: transactionHash,
    signedMessageDigest: `sha256:${'5'.repeat(64)}`,
    relayQuoteDeadlineUnixSeconds: deadlineUnixSeconds,
    relayIntent: outboundRelayIntent(leg, deadlineUnixSeconds),
    relayRoute,
  });
  return requestDigest;
}

test('records signed Relay bytes, recovery authority, and source reservation in one durable transaction', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recordedLeg = await repository.recordRelayLeg(cycleId, relayLeg(cycleId));
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const transactionHash = `0x${'b'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', preparedChainAttempt(cycleId, 'outbound', requestDigest));
  const before = await repository.describeCycle(cycleId);
  const recoveryContext = {
    stage: 'outbound',
    recipient: null,
    requestDigest,
    policyDigest: `sha256:${'c'.repeat(64)}`,
    approvalDigest: `sha256:${'d'.repeat(64)}`,
    fencingToken: '11111111-1111-4111-8111-111111111111',
    fencingTokenDigest: `sha256:${'e'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'f'.repeat(64)}`,
    rawSignedBytesHash: transactionHash,
    signedMessageDigest: `sha256:${'0'.repeat(64)}`,
    relayQuoteDeadlineUnixSeconds: '1700000200',
  };

  const signed = await repository.recordSignedTransactionWithRecoveryContext(
    cycleId,
    'outbound',
    requestDigest,
    { rawBytes: '0x1234', nonce: '7', blockhash: null, hash: transactionHash },
    recoveryContext,
    { relayRequestId: recordedLeg.relayRequestId, sourceTxHash: transactionHash },
  );

  assert.equal(signed.attempt.state, 'SIGNED');
  assert.equal((await repository.describeCycle(cycleId)).version, before.version + 3, 'one journal transaction records the three ordered signing facts');
  assert.deepEqual(
    await repository.readChainAttemptRecoveryContext(cycleId, {
      stage: 'outbound', recipient: null, requestDigest, rawSignedBytesHash: transactionHash,
    }),
    recoveryContext,
  );
  assert.equal((await repository.readRelayLeg(cycleId, recordedLeg.relayRequestId)).sourceTxHash, transactionHash);

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.readChainTransactionAttempt(cycleId, 'outbound', requestDigest)).attempt.state, 'SIGNED');
  assert.equal((await reopened.readRelayLeg(cycleId, recordedLeg.relayRequestId)).sourceTxHash, transactionHash);

  const rejectedRequestDigest = `sha256:${'1'.repeat(64)}`;
  await reopened.prepareChainTransactionAttempt(cycleId, 'outbound', preparedChainAttempt(cycleId, 'outbound', rejectedRequestDigest));
  await assert.rejects(
    () => reopened.recordSignedTransactionWithRecoveryContext(
      cycleId,
      'outbound',
      rejectedRequestDigest,
      { rawBytes: '0x5678', nonce: '8', blockhash: null, hash: `0x${'2'.repeat(64)}` },
      { ...recoveryContext, requestDigest: rejectedRequestDigest, rawSignedBytesHash: `0x${'3'.repeat(64)}` },
    ),
    /does not bind the signed bytes/,
  );
  assert.equal((await reopened.readChainTransactionAttempt(cycleId, 'outbound', rejectedRequestDigest)).attempt.state, 'PREPARED');
});

function standingAuthorityDecision(overrides = {}) {
  return {
    schema: 'hookemon.standing-authority-decision.v1',
    authorityDigest: `sha256:${'a'.repeat(64)}`,
    verifiedAt: '2026-09-05T10:00:00.000Z',
    intentDigest: `sha256:${'b'.repeat(64)}`,
    dayCapReservation: { day: '2026-09-05', reservationKey: `sha256:${'c'.repeat(64)}` },
    nonceReservation: { nonce: 'cycle-outbound-1', reservationKey: `sha256:${'d'.repeat(64)}` },
    ...overrides,
  };
}

async function createSiblingCycle(directory, cycleId) {
  const store = await DurableCycleStore.open(directory);
  const empty = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, empty.entries).propose('cycle-opened', {
    releaseAmount: '2', openedAtMs: 1,
  });
  const transaction = store.begin(cycleId, {
    expectedVersion: empty.version,
    expectedJournalHead: empty.journalHead,
  });
  transaction.stageEvent(entry);
  await store.commit(transaction);
}

async function completeOperationalStages(repository, cycleId) {
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, { stage, finalized: true });
  }
}

async function completePredecessors(repository, cycleId, stage) {
  const stageIndex = OPERATIONAL_CYCLE_STAGES.indexOf(stage);
  for (const predecessor of OPERATIONAL_CYCLE_STAGES.slice(0, stageIndex)) {
    await repository.prepareStage(cycleId, predecessor);
    await repository.completeStage(cycleId, predecessor, { stage: predecessor, finalized: true });
  }
}

test('readActiveCycle is null before any cycle is created', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  assert.equal(await repository.readActiveCycle(), null);
});

test('peekActiveCycle leaves a completed crash-recovery record byte-for-byte unchanged', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await completeOperationalStages(repository, cycleId);

  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose('cycle-completed', {});
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);
  const before = store.readCycle(cycleId);

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.peekActiveCycle(), {
    cycleId,
    releaseAmount: '1',
    terminalState: 'COMPLETED',
  });
  assert.deepEqual(store.readCycle(cycleId), before);
  assert.deepEqual(store.activeCycleIds, [cycleId]);
});

test('a cycle repository client exposes only the frozen read interface', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const client = createCycleRepositoryClient(repository);

  assert.deepEqual(Object.keys(client).sort(), [...CYCLE_REPOSITORY_CLIENT_INTERFACE].sort());
  assert.equal(Object.isFrozen(client), true);
  assert.equal(typeof client.createCycle, 'undefined');
  assert.equal(typeof client.holdCycle, 'undefined');
  assert.equal(await client.readActiveCycle(), null);
});

test('createCycle opens a durable cycle and readActiveCycle reports it', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const created = await repository.createCycle({ releaseAmount: '55000000', mode: 'production' });
  assert.match(created.cycleId, /^cycle-[a-z0-9]+-[0-9a-f-]{36}$/);
  assert.equal(created.releaseAmount, '55000000');
  const active = await repository.readActiveCycle();
  assert.deepEqual(active, { cycleId: created.cycleId, releaseAmount: '55000000', mode: 'production' });
});

test('createCycle persists an explicit execution mode and refuses an implicit mode', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  await assert.rejects(
    () => repository.createCycle({ releaseAmount: '55000000' }),
    /mode must be "production" or "rehearsal"/,
  );
  const created = await repository.createCycle({ releaseAmount: '55000000', mode: 'rehearsal' });
  assert.deepEqual(await repository.readActiveCycle(), {
    cycleId: created.cycleId,
    releaseAmount: '55000000',
    mode: 'rehearsal',
  });
  assert.equal((await repository.describeCycle(created.cycleId)).mode, 'rehearsal');
});

test('createCycle preserves a rehearsal provider mode and session identity across a repository reopen', async t => {
  const directory = await tempDirectory(t);
  const before = await CycleRepository.open(directory);
  const created = await before.createCycle({
    releaseAmount: '30', mode: 'rehearsal', providerMode: 'fake', rehearsalSessionId: 'rehearsal-11111111-1111-4111-8111-111111111111',
  });

  const after = await CycleRepository.open(directory);
  assert.deepEqual(await after.readActiveCycle(), {
    cycleId: created.cycleId,
    releaseAmount: '30',
    mode: 'rehearsal',
    providerMode: 'fake',
    rehearsalSessionId: 'rehearsal-11111111-1111-4111-8111-111111111111',
  });
  assert.equal((await after.describeCycle(created.cycleId)).providerMode, 'fake');
  assert.equal((await after.describeCycle(created.cycleId)).rehearsalSessionId, 'rehearsal-11111111-1111-4111-8111-111111111111');
});

test('createCycle persists an explicit fake-provider production dry run across a repository reopen', async t => {
  const directory = await tempDirectory(t);
  const before = await CycleRepository.open(directory);

  await assert.rejects(
    () => before.createCycle({ releaseAmount: '30', mode: 'production', providerMode: 'fake' }),
    /providerMode must be "live" for production/,
  );

  const created = await before.createCycle({
    releaseAmount: '30',
    mode: 'production',
    providerMode: 'fake',
    dryRun: true,
  });
  const after = await CycleRepository.open(directory);

  assert.deepEqual(await after.readActiveCycle(), {
    cycleId: created.cycleId,
    releaseAmount: '30',
    mode: 'production',
    providerMode: 'fake',
    dryRun: true,
  });
  assert.equal((await after.describeCycle(created.cycleId)).dryRun, true);
});

test('state-directory loss persists an owner-decision recovery hold instead of opening a fresh cycle', async t => {
  const parent = await tempDirectory(t);
  const directory = join(parent, 'cycles');
  const before = await CycleRepository.open(directory);
  await before.createCycle({ releaseAmount: '30', mode: 'production' });
  await rm(directory, { recursive: true, force: true });

  const recovered = await CycleRepository.open(directory);
  const active = await recovered.readActiveCycle();
  assert.equal(active.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal((await recovered.describeCycle(active.cycleId)).terminalEvidence.reason, 'missing');
  await assert.rejects(
    () => recovered.createCycle({ releaseAmount: '1', mode: 'production' }),
    /state-directory loss/,
  );
  await assert.rejects(
    () => recovered.prepareStage(active.cycleId, 'eligibility-snapshot'),
    /terminal as HELD_DATA_UNVERIFIED/,
  );

  await mkdir(directory);
  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readActiveCycle(), active);
  await assert.rejects(
    () => reopened.createCycle({ releaseAmount: '1', mode: 'production' }),
    /state-directory loss/,
  );
});

test('state-directory recreation persists an owner-decision recovery hold instead of accepting a replacement tree', async t => {
  const parent = await tempDirectory(t);
  const directory = join(parent, 'cycles');
  const before = await CycleRepository.open(directory);
  await before.createCycle({ releaseAmount: '30', mode: 'production' });
  await rm(directory, { recursive: true, force: true });
  for (const child of ['active', 'archive', 'payout']) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }

  const recovered = await CycleRepository.open(directory);
  const active = await recovered.readActiveCycle();
  assert.equal(active.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal((await recovered.describeCycle(active.cycleId)).terminalEvidence.reason, 'identity-marker-missing');
  await assert.rejects(
    () => recovered.createCycle({ releaseAmount: '1', mode: 'production' }),
    /state-directory loss/,
  );

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(active.cycleId)).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('a copied state-directory marker persists an owner-decision recovery hold instead of accepting a replacement tree', async t => {
  const parent = await tempDirectory(t);
  const directory = join(parent, 'cycles');
  const before = await CycleRepository.open(directory);
  await before.createCycle({ releaseAmount: '30', mode: 'production' });
  const marker = await readFile(join(directory, '.store-identity.json'), 'utf8');
  await rm(directory, { recursive: true, force: true });
  for (const child of ['active', 'archive', 'payout']) {
    await mkdir(join(directory, child), { recursive: true, mode: 0o700 });
  }
  await writeFile(join(directory, '.store-identity.json'), marker, { mode: 0o600 });

  const recovered = await CycleRepository.open(directory);
  const active = await recovered.readActiveCycle();
  assert.equal(active.terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal((await recovered.describeCycle(active.cycleId)).terminalEvidence.reason, 'identity-directory-mismatch');
  await assert.rejects(
    () => recovered.createCycle({ releaseAmount: '1', mode: 'production' }),
    /state-directory loss/,
  );
});

test('createCycle refuses while a cycle is already active', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await assert.rejects(() => repository.createCycle({ releaseAmount: '2', mode: 'production' }), /a cycle is already active/);
});

test('createCycle rejects a non-canonical releaseAmount', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  await assert.rejects(() => repository.createCycle({ releaseAmount: '01' }), /canonical unsigned decimal string/);
  await assert.rejects(() => repository.createCycle({ releaseAmount: -1 }), /canonical unsigned decimal string/);
});

test('readStage is PENDING for an unprepared stage and reflects prepare/complete transitions', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  assert.deepEqual(await repository.readStage(cycleId, 'eligibility-snapshot'), { status: 'PENDING' });

  await repository.prepareStage(cycleId, 'eligibility-snapshot', {});
  assert.deepEqual(await repository.readStage(cycleId, 'eligibility-snapshot'), { status: 'PENDING' }, 'prepare alone does not complete a stage');

  await repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-1' });
  assert.deepEqual(await repository.readStage(cycleId, 'eligibility-snapshot'), { status: 'COMPLETE', evidence: { transactionId: 'tx-1' } });
});

test('preparing the same stage twice returns the original durable preparation without appending another event', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  const first = await repository.prepareStage(cycleId, 'eligibility-snapshot');
  const before = await repository.describeCycle(cycleId);
  const second = await repository.prepareStage(cycleId, 'eligibility-snapshot');
  const after = await repository.describeCycle(cycleId);

  assert.deepEqual(second, first);
  assert.equal(after.version, before.version);
});

test('completion requires the prepared stage and all predecessor stages', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  await assert.rejects(
    () => repository.completeStage(cycleId, 'claim-process', { finalized: true }),
    /was not prepared/,
  );
  await repository.prepareStage(cycleId, 'claim-process');
  await assert.rejects(
    () => repository.completeStage(cycleId, 'claim-process', { finalized: true }),
    /requires completed predecessor "eligibility-snapshot"/,
  );
});

test('completeStage is idempotent when retried with identical evidence, and rejects a mismatched retry', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-1' });
  await repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-1' }); // no throw
  await assert.rejects(
    () => repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-2' }),
    /already completed with different evidence/,
  );
});

test('readStage/completeStage reject an unknown stage name', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await assert.rejects(() => repository.readStage(cycleId, 'not-a-real-stage'), /unknown stage/);
  await assert.rejects(() => repository.completeStage(cycleId, 'not-a-real-stage', {}), /unknown stage/);
});

test('completeCycle archives the cycle so readActiveCycle reports null and a new cycle may be created', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await assert.rejects(() => repository.completeCycle(cycleId), /requires every operational stage complete/);
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  assert.equal(await repository.readActiveCycle(), null);
  const second = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  assert.notEqual(second.cycleId, cycleId);
});

test('completeCycle rejects unfinalized chain attempts and unclosed custody before archiving', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await completeOperationalStages(repository, cycleId);

  const chainAttempt = preparedChainAttempt(cycleId);
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', chainAttempt);
  await assert.rejects(() => repository.completeCycle(cycleId), /unfinalized chain attempt/);

  const signingMaterial = {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: '0xdeadbeef',
  };
  await repository.recordSignedTransaction(cycleId, 'claim-process', chainAttempt.requestDigest, signingMaterial);
  await repository.recordSignedTransaction(cycleId, 'claim-process', chainAttempt.requestDigest, signingMaterial);
  await assert.rejects(
    () => repository.recordSignedTransaction(cycleId, 'claim-process', chainAttempt.requestDigest, { ...signingMaterial, rawBytes: '0x010203' }),
    /different signing material/,
  );
  await repository.recordBroadcast(cycleId, 'claim-process', chainAttempt.requestDigest, { transactionHash: signingMaterial.hash });
  await repository.recordFinality(cycleId, 'claim-process', chainAttempt.requestDigest, { transactionHash: signingMaterial.hash, blockNumber: '9' });
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, { heldAssets: '1' }));
  await assert.rejects(() => repository.completeCycle(cycleId), /unclosed custody/);
});

test('keys chain attempts by request digest and preserves broadcast and finality evidence', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const first = preparedChainAttempt(cycleId, 'payout', `sha256:${'a'.repeat(64)}`);
  const second = preparedChainAttempt(cycleId, 'payout', `sha256:${'b'.repeat(64)}`);
  const signingMaterial = {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: '0xdeadbeef',
  };
  const broadcastEvidence = { networkReceipt: '0xreceipt-1', submittedAtMs: '1000' };
  const finalityEvidence = { blockNumber: '22', transactionHash: '0xdeadbeef' };

  await repository.prepareChainTransactionAttempt(cycleId, 'payout', first);
  await repository.prepareChainTransactionAttempt(cycleId, 'payout', second);
  await repository.recordSignedTransaction(cycleId, 'payout', first.requestDigest, signingMaterial);
  await repository.recordBroadcast(cycleId, 'payout', first.requestDigest, broadcastEvidence);
  await repository.recordBroadcast(cycleId, 'payout', first.requestDigest, broadcastEvidence);
  await assert.rejects(
    () => repository.recordBroadcast(cycleId, 'payout', first.requestDigest, { ...broadcastEvidence, networkReceipt: '0xreceipt-2' }),
    /different broadcast evidence/,
  );
  await repository.recordFinality(cycleId, 'payout', first.requestDigest, finalityEvidence);
  await repository.recordFinality(cycleId, 'payout', first.requestDigest, finalityEvidence);
  await assert.rejects(
    () => repository.recordFinality(cycleId, 'payout', first.requestDigest, { ...finalityEvidence, blockNumber: '23' }),
    /different finality evidence/,
  );

  const expectedFirst = {
    attempt: { ...first, ...signingMaterial, state: 'FINALIZED' },
    broadcastEvidence,
    finalityEvidence,
  };
  assert.deepEqual(await repository.readChainTransactionAttempt(cycleId, 'payout', first.requestDigest), expectedFirst);
  assert.deepEqual(await repository.readChainTransactionAttempt(cycleId, 'payout', second.requestDigest), {
    attempt: second,
    broadcastEvidence: null,
    finalityEvidence: null,
  });

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readChainTransactionAttempt(cycleId, 'payout', first.requestDigest), expectedFirst);
});

test('a held terminal state stays active and prevents automatic completion', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.holdCycle(cycleId, 'HELD_DATA_UNVERIFIED', { reason: 'snapshot source disagreed' });

  assert.deepEqual(await repository.readActiveCycle(), {
    cycleId,
    releaseAmount: '1',
    mode: 'production',
    terminalState: 'HELD_DATA_UNVERIFIED',
  });
  await assert.rejects(() => repository.completeCycle(cycleId), /terminally held/);
  await assert.rejects(() => repository.completeStage(cycleId, 'outbound', { transactionId: 'must-not-append' }), /terminally held/);
  assert.equal((await repository.describeCycle(cycleId)).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('records a held owner decision idempotently and retains it across restart', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const heldEvidence = { stage: 'epic-gate', memo: 'memo-1', mint: 'mint-1', decision: 'hold' };
  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', heldEvidence);
  const held = await repository.describeCycle(cycleId);
  const decision = {
    heldEvidenceDigest: digest({
      schema: 'hookemon.cycle-held-owner-decision.v1',
      cycleId,
      terminalState: 'HELD_OWNER_DECISION',
      evidence: heldEvidence,
    }),
    requestId: 'owner-decision-1',
    expectedRevision: held.version,
    choice: 'keep-holding',
  };

  const recorded = await repository.recordHeldOwnerDecision(cycleId, decision);
  assert.deepEqual(recorded, { cycleId, ...decision });
  assert.equal((await repository.describeCycle(cycleId)).heldEvidenceDigest, decision.heldEvidenceDigest);
  assert.deepEqual((await repository.describeCycle(cycleId)).ownerDecision, recorded);

  assert.deepEqual(await repository.recordHeldOwnerDecision(cycleId, decision), recorded);
  await assert.rejects(
    () => repository.recordHeldOwnerDecision(cycleId, { ...decision, choice: 'sell' }),
    /held owner decision conflict/,
  );

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual((await reopened.describeCycle(cycleId)).ownerDecision, recorded);
});

test('an operator hold preserves its reason and rejects a conflicting retry', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = { reason: 'provider reconciliation failed', command: 'abort-cycle' };

  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', evidence);
  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', evidence);

  const description = await repository.describeCycle(cycleId);
  assert.deepEqual(description.terminalEvidence, evidence);
  await assert.rejects(
    () => repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', { reason: 'different reason', command: 'abort-cycle' }),
    /terminal evidence conflict/,
  );
});

test('an operator hold invokes its lease assertion before and after its durable append', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  let checks = 0;
  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', { reason: 'operator stop', command: 'abort-cycle' }, {
    assertLease: () => { checks += 1; },
  });
  assert.ok(checks >= 3);
  assert.equal((await repository.describeCycle(cycleId)).terminalState, 'HELD_OWNER_DECISION');
});

test('a hold fences new effects but retains append-only observation and custody facts', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const prepared = {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'c'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  };
  await repository.prepareStageAttempt(cycleId, 'purchase', prepared);
  await repository.holdCycle(cycleId, 'HELD_UNAVAILABLE', { reason: 'provider unavailable' });

  await repository.markStageAttemptSentUnknown(cycleId, 'purchase');
  await repository.recordStageAttemptResponse(cycleId, 'purchase', { providerReceipt: 'receipt-1' });
  await repository.reconcileStageAttempt(cycleId, 'purchase', { finalized: true, providerReceipt: 'receipt-1' });
  await repository.recordCustodyLedger(cycleId, {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:stablecoin',
    decimals: 6,
    claimed: '1',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '1',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  });

  await assert.rejects(() => repository.prepareStage(cycleId, 'outbound'), /terminal/);
  await assert.rejects(() => repository.prepareStageAttempt(cycleId, 'outbound', {
    ...prepared,
    stage: 'outbound',
    requestDigest: `sha256:${'d'.repeat(64)}`,
  }), /terminal/);
  await assert.rejects(() => repository.completeStage(cycleId, 'purchase', { finalized: true, providerReceipt: 'receipt-1' }), /terminal/);
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'RECONCILED');
});

test('custody ledgers freeze decimals for each cycle, chain, and asset in writes and replay', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const ledger = custodyLedger(cycleId, { claimed: '1' });
  await repository.recordCustodyLedger(cycleId, ledger);

  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, { ...ledger, decimals: 18 }),
    /custody ledger decimals/,
  );

  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose('custody-ledger-recorded', {
    ledger: { ...ledger, decimals: 18 },
  });
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(() => reopened.describeCycle(cycleId), /custody ledger decimals/);
});

test('retired accounting stages remain readable for history but cannot be written into a new operational cycle', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  assert.deepEqual(await repository.readStage(cycleId, 'funding'), { status: 'PENDING' });
  await assert.rejects(() => repository.prepareStage(cycleId, 'funding'), /retired stage/);
  await assert.rejects(() => repository.completeStage(cycleId, 'distribution', { seeded: true }), /retired stage/);
});

test('replay rejects a second terminal event instead of overwriting the first terminal state', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const store = await DurableCycleStore.open(directory);

  for (const terminalState of ['HELD_UNAVAILABLE', 'HELD_OWNER_DECISION']) {
    const stored = store.readCycle(cycleId);
    const entry = new CycleJournal(cycleId, stored.entries).propose('cycle-terminal', { terminalState, evidence: {} });
    const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
    transaction.stageEvent(entry);
    await store.commit(transaction);
  }

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(() => reopened.describeCycle(cycleId), /second terminal event/);
});

test('replay rejects a stored operational completion that bypassed preparation and predecessor checks', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose('stage-completed', {
    stage: 'purchase', evidence: { injected: true },
  });
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(() => reopened.describeCycle(cycleId), /was not prepared/);
});

test('crash-resume: a cycle-repository reopened from the same directory sees exactly the durably-completed stages', async t => {
  const directory = await tempDirectory(t);
  const before = await CycleRepository.open(directory);
  const { cycleId } = await before.createCycle({ releaseAmount: '55000000', mode: 'production' });
  await before.prepareStage(cycleId, 'eligibility-snapshot');
  await before.completeStage(cycleId, 'eligibility-snapshot', { step: 'eligibility-snapshot' });
  await before.prepareStage(cycleId, 'claim-process');
  await before.completeStage(cycleId, 'claim-process', { step: 'claim-process' });
  await before.prepareStage(cycleId, 'outbound');
  await before.completeStage(cycleId, 'outbound', { step: 'outbound' });
  // No process-level handle is closed here on purpose: the durable store's own file-based commit
  // protocol (packages/runner/src/cycle/durable-store.mjs) is what must survive a "crash" between
  // stages, not an explicit close call this repository does not expose.

  const after = await CycleRepository.open(directory);
  const active = await after.readActiveCycle();
  assert.deepEqual(active, { cycleId, releaseAmount: '55000000', mode: 'production' });
  assert.deepEqual(await after.readStage(cycleId, 'eligibility-snapshot'), { status: 'COMPLETE', evidence: { step: 'eligibility-snapshot' } });
  assert.deepEqual(await after.readStage(cycleId, 'outbound'), { status: 'COMPLETE', evidence: { step: 'outbound' } });
  assert.deepEqual(await after.readStage(cycleId, 'purchase'), { status: 'PENDING' });
});

test('crash-resume: a cycle whose "cycle-completed" event committed but was never archived is self-healed to inactive on the next open', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await completeOperationalStages(repository, cycleId);

  // Simulate exactly the crash window completeCycle()'s own comment names: the 'cycle-completed'
  // journal entry committed, but the process died before archiveCycle() ran. Reach straight into
  // the same durable directory (bypassing CycleRepository, which always archives immediately after
  // journaling) to produce that state.
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const journal = new CycleJournal(cycleId, stored.entries);
  const entry = journal.propose('cycle-completed', {});
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);
  assert.deepEqual(store.activeCycleIds, [cycleId], 'still active on disk: the crash window is real, not archived yet');

  const reopened = await CycleRepository.open(directory);
  assert.equal(await reopened.readActiveCycle(), null, 'self-healed: a completed-but-unarchived cycle is never reported as active');
  const second = await reopened.createCycle({ releaseAmount: '2', mode: 'production' });
  assert.notEqual(second.cycleId, cycleId);
});

// --- WP-37: listKnownCycleIds (holder-exclusion-set support) -----------------------------------

test('listKnownCycleIds is empty before any cycle is created', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  assert.deepEqual(await repository.listKnownCycleIds(), []);
});

test('listKnownCycleIds reports an active cycle, then reports it as archived (not duplicated) once completed', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  assert.deepEqual(await repository.listKnownCycleIds(), [cycleId]);

  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  assert.deepEqual(await repository.listKnownCycleIds(), [cycleId], 'archived, not duplicated, and not dropped');

  const second = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  const known = await repository.listKnownCycleIds();
  assert.equal(known.length, 2);
  assert.ok(known.includes(cycleId));
  assert.ok(known.includes(second.cycleId));
});

test('crash-resume: listKnownCycleIds survives a fresh CycleRepository opened from the same directory', async t => {
  const directory = await tempDirectory(t);
  const before = await CycleRepository.open(directory);
  const { cycleId: firstCycleId } = await before.createCycle({ releaseAmount: '1', mode: 'production' });
  await completeOperationalStages(before, firstCycleId);
  await before.completeCycle(firstCycleId);
  const { cycleId: secondCycleId } = await before.createCycle({ releaseAmount: '2', mode: 'production' });

  const after = await CycleRepository.open(directory);
  const known = await after.listKnownCycleIds();
  assert.equal(known.length, 2);
  assert.ok(known.includes(firstCycleId));
  assert.ok(known.includes(secondCycleId));
});

test('payout dust is provenance-bound, survives archival, and is consumed exactly once by a successor plan', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const asset = { chainId: '4663', assetId: '0x0000000000000000000000000000000000000001', decimals: 6 };
  const sourcePlanDigest = digest({ schema: 'test-payout-plan.v1', cycle: 'source' });
  const successorPlanDigest = digest({ schema: 'test-payout-plan.v1', cycle: 'successor' });
  const { cycleId: sourceCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  const recorded = await repository.recordPayoutDust(sourceCycleId, {
    amount: { ...asset, chainId: 4663, amountAtomic: '7' },
    planDigest: sourcePlanDigest,
  });
  assert.deepEqual(recorded.amount, { ...asset, amountAtomic: '7' });
  assert.equal(recorded.source.cycleId, sourceCycleId);
  assert.match(recorded.source.digest, /^sha256:[0-9a-f]{64}$/);

  await completeOperationalStages(repository, sourceCycleId);
  await repository.completeCycle(sourceCycleId);
  const { cycleId: successorCycleId } = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  const prior = await repository.readPayoutDust(successorCycleId, asset);
  assert.deepEqual(prior, recorded);

  await repository.consumePayoutDust(successorCycleId, {
    source: prior.source,
    amount: prior.amount,
    planDigest: successorPlanDigest,
  });

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readPayoutDust(successorCycleId, asset), {
    amount: { ...asset, amountAtomic: '0' },
    source: null,
  });
  await assert.rejects(
    () => reopened.consumePayoutDust(successorCycleId, {
      source: prior.source,
      amount: prior.amount,
      planDigest: digest({ schema: 'test-payout-plan.v1', cycle: 'different-successor-plan' }),
    }),
    /already consumed by a different payout plan/,
  );

  await completeOperationalStages(reopened, successorCycleId);
  await reopened.completeCycle(successorCycleId);
  const { cycleId: laterCycleId } = await reopened.createCycle({ releaseAmount: '3', mode: 'production' });
  await assert.rejects(
    () => reopened.consumePayoutDust(laterCycleId, {
      source: prior.source,
      amount: prior.amount,
      planDigest: digest({ schema: 'test-payout-plan.v1', cycle: 'later-successor-plan' }),
    }),
    /already consumed by a different payout plan/,
  );
});

test('atomically records a payout state with its dust consumption and resumes an interrupted pre-atomic consumption', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const asset = { chainId: '4663', assetId: '0x0000000000000000000000000000000000000001', decimals: 6 };
  const sourcePlanDigest = digest({ schema: 'test-payout-plan.v1', cycle: 'source' });
  const successorPlanDigest = digest({ schema: 'test-payout-plan.v1', cycle: 'successor' });
  const { cycleId: sourceCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordPayoutDust(sourceCycleId, {
    amount: { ...asset, amountAtomic: '7' },
    planDigest: sourcePlanDigest,
  });
  await completeOperationalStages(repository, sourceCycleId);
  await repository.completeCycle(sourceCycleId);

  const { cycleId: successorCycleId } = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  const input = {
    source: recorded.source,
    amount: recorded.amount,
    planDigest: successorPlanDigest,
    stage: 'payout',
    evidence: { schema: 'test-direct-payout-state.v1', planDigest: successorPlanDigest },
  };
  await repository.consumePayoutDustAndRecordStageAttempt(successorCycleId, input);
  assert.deepEqual(await repository.readStageAttempt(successorCycleId, 'payout'), input.evidence);
  assert.deepEqual(await repository.readPayoutDust(successorCycleId, asset), {
    amount: { ...asset, amountAtomic: '0' },
    source: null,
  });

  const reopened = await CycleRepository.open(directory);
  const beforeRetry = await reopened.describeCycle(successorCycleId);
  await reopened.consumePayoutDustAndRecordStageAttempt(successorCycleId, input);
  assert.equal((await reopened.describeCycle(successorCycleId)).version, beforeRetry.version, 'an exact retry adds no second consume or stage record');

  await completeOperationalStages(reopened, successorCycleId);
  await reopened.completeCycle(successorCycleId);
  const { cycleId: recoverySourceCycleId } = await reopened.createCycle({ releaseAmount: '3', mode: 'production' });
  const replayed = await reopened.recordPayoutDust(recoverySourceCycleId, {
    amount: { ...asset, amountAtomic: '9' },
    planDigest: digest({ schema: 'test-payout-plan.v1', cycle: 'recovery-source' }),
  });
  await completeOperationalStages(reopened, recoverySourceCycleId);
  await reopened.completeCycle(recoverySourceCycleId);
  const { cycleId: recoveredCycleId } = await reopened.createCycle({ releaseAmount: '4', mode: 'production' });
  const recoveryPlanDigest = digest({ schema: 'test-payout-plan.v1', cycle: 'recovery-successor' });
  await reopened.consumePayoutDust(recoveredCycleId, {
    source: replayed.source,
    amount: replayed.amount,
    planDigest: recoveryPlanDigest,
  });
  const recoveryState = { schema: 'test-direct-payout-state.v1', planDigest: recoveryPlanDigest };
  await reopened.consumePayoutDustAndRecordStageAttempt(recoveredCycleId, {
    source: replayed.source,
    amount: replayed.amount,
    planDigest: recoveryState.planDigest,
    stage: 'payout',
    evidence: recoveryState,
  });
  assert.deepEqual(await reopened.readStageAttempt(recoveredCycleId, 'payout'), recoveryState);
});

test('recovers a payout page-publication failpoint before predecessor dust can reach the next cycle', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const asset = { chainId: '4663', assetId: '0x0000000000000000000000000000000000000001', decimals: 6 };
  const { cycleId: sourceCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordPayoutDust(sourceCycleId, {
    amount: { ...asset, amountAtomic: '7' },
    planDigest: digest({ schema: 'test-payout-plan.v1', cycle: 'page-publication-source' }),
  });
  await completeOperationalStages(repository, sourceCycleId);
  await repository.completeCycle(sourceCycleId);

  const { cycleId: successorCycleId } = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  const planDigest = digest({ schema: 'test-payout-plan.v1', cycle: 'page-publication-successor' });
  const evidence = {
    schema: 'test-direct-payout-state.v1',
    cycleId: successorCycleId,
    planDigest,
    recipients: [{ recipient: 'recipient-page-0' }],
  };
  await repository.persistPagedPayoutState(successorCycleId, 'payout', evidence);

  const reopened = await CycleRepository.open(directory);
  assert.equal(await reopened.readStageAttempt(successorCycleId, 'payout'), null, 'the failpoint ran after page publication and before the journal boundary');
  assert.deepEqual(await reopened.readPagedPayoutState(successorCycleId, 'payout'), evidence);
  await reopened.consumePayoutDustAndPersistPagedPayoutState(successorCycleId, {
    source: recorded.source,
    amount: recorded.amount,
    planDigest,
    stage: 'payout',
    evidence,
  });
  assert.deepEqual(await reopened.readPayoutDust(successorCycleId, asset), {
    amount: { ...asset, amountAtomic: '0' },
    source: null,
  });

  await completeOperationalStages(reopened, successorCycleId);
  await reopened.completeCycle(successorCycleId);
  const { cycleId: nextCycleId } = await reopened.createCycle({ releaseAmount: '3', mode: 'production' });
  assert.deepEqual(await reopened.readPayoutDust(nextCycleId, asset), {
    amount: { ...asset, amountAtomic: '0' },
    source: null,
  });
});

test('payout quarantine atomically records its evidence and the matching custody liability', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const ledger = custodyLedger(cycleId, {
    assetId: '0x0000000000000000000000000000000000000001',
    returnReceived: '100',
  });
  const amount = {
    chainId: ledger.chainId,
    assetId: ledger.assetId,
    decimals: ledger.decimals,
    amountAtomic: '30',
  };
  const input = {
    planDigest: digest({ schema: 'test-payout-plan.v1', cycleId }),
    recipient: '0x00000000000000000000000000000000000000aa',
    amount,
    reason: 'USDG_FROZEN',
    evidence: { frozenAt: 'finalized' },
  };
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, input),
    /matching custody ledger is required/,
  );
  await repository.recordCustodyLedger(cycleId, ledger);

  const reservation = await repository.reservePayoutQuarantine(cycleId, input);
  assert.deepEqual(reservation.amount, amount);
  assert.equal(reservation.recipient, input.recipient);
  assert.equal(reservation.reason, input.reason);
  const state = await repository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.get(`${amount.chainId}\u0000${amount.assetId}`).payoutLiability, '30');

  assert.deepEqual(await repository.reservePayoutQuarantine(cycleId, input), reservation, 'an exact recovery retry does not reserve the amount twice');
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, { ...input, amount: { ...amount, amountAtomic: '31' } }),
    /already has different evidence/,
  );
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, {
      ...input,
      planDigest: digest({ schema: 'test-payout-plan.v1', cycle: 'second-plan' }),
      recipient: '0x00000000000000000000000000000000000000bb',
      amount: { ...amount, amountAtomic: '71' },
    }),
    /recorded returned custody cannot back this liability/,
  );

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(
    await reopened.readPayoutQuarantine(cycleId, input.planDigest, input.recipient),
    reservation,
  );
  assert.equal((await reopened.describeCycle(cycleId)).custodyLedgers.get(`${amount.chainId}\u0000${amount.assetId}`).payoutLiability, '30');
});

test('the EVM nonce lock fences stale signers and remains wallet-wide across recovery', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const lock = {
    chainId: '4663',
    wallet: '0x00000000000000000000000000000000000000aa',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
  };
  const replacement = { ...lock, fencingToken: '22345678-1234-4123-8123-123456789abc' };

  const acquired = await repository.acquireEvmNonceLock(cycleId, lock);
  assert.equal(acquired.fencingToken, lock.fencingToken);
  assert.equal(await repository.assertEvmNonceLock(cycleId, lock), true);

  await repository.acquireEvmNonceLock(cycleId, replacement);
  await assert.rejects(
    () => repository.assertEvmNonceLock(cycleId, lock),
    /stale fencing token/,
  );
  assert.equal(await repository.assertEvmNonceLock(cycleId, replacement), true);

  const reopened = await CycleRepository.open(directory);
  assert.equal(await reopened.assertEvmNonceLock(cycleId, replacement), true);

  const directStore = await DurableCycleStore.open(directory);
  const competingCycleId = 'cycle-competing-lock';
  const empty = directStore.readCycle(competingCycleId);
  const entry = new CycleJournal(competingCycleId, empty.entries).propose('cycle-opened', {
    releaseAmount: '2', openedAtMs: 1,
  });
  const transaction = directStore.begin(competingCycleId, {
    expectedVersion: empty.version,
    expectedJournalHead: empty.journalHead,
  });
  transaction.stageEvent(entry);
  await directStore.commit(transaction);
  const competingRepository = await CycleRepository.open(directory);
  await assert.rejects(
    () => competingRepository.acquireEvmNonceLock(competingCycleId, replacement),
    new RegExp(`wallet is locked by active cycle ${cycleId}`),
  );

  await reopened.releaseEvmNonceLock(cycleId, replacement);
  assert.equal(await reopened.releaseEvmNonceLock(cycleId, replacement), true, 'terminal payout recovery can repeat its release');
  await assert.rejects(
    () => reopened.assertEvmNonceLock(cycleId, replacement),
    /is not held/,
  );
});

test('records a Relay leg before signing, enforces global transaction-hash uniqueness, and never settles from relay status alone', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, relayLeg(cycleId));
  assert.equal(recorded.state, 'RECORDED');
  assert.equal(recorded.sourceTxHash, null);

  const sourceTxHash = `0x${'e'.repeat(64)}`;
  const attributed = await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  assert.equal(attributed.sourceTxHash, sourceTxHash);
  await assert.rejects(
    () => repository.settleRelayLeg(cycleId, recorded.relayRequestId, { relayStatus: 'complete' }),
    /schema|own process RPC|settlement/i,
  );

  await assert.rejects(
    () => repository.settleRelayLeg(cycleId, recorded.relayRequestId, {
      sourceProof: {
        finalized: true,
        successful: true,
        proofAvailable: true,
        amountAtomic: '25000000',
        sourceBalanceDeltaAtomic: '25000000',
        recipientBalanceDeltaAtomic: '25000000',
        receiptBlockNumber: 100n,
        receiptBlockHash: `0x${'1'.repeat(64)}`,
        receiptBlockTimestampUnixSeconds: '1788963000',
      },
      destinationObservation: {
        transactionHash: 'forged-relay-destination',
        mint: 'Solana-stablecoin',
        netDeltaAtomic: '24694978',
        finality: relayFinality('250', 'forged-destination-slot', '1788963100'),
        attribution: {
          schema: 'hookemon.relay-attribution.v1',
          observer: 'process-rpc',
          requestId: recorded.relayRequestId,
          memo: recorded.relayRequestId,
          observedAmountAtomic: '24694978',
        },
      },
    }),
    /own process RPC|process RPC evidence|durable outbound/i,
  );

  await createSiblingCycle(directory, 'cycle-relay-hash-conflict');
  const second = await CycleRepository.open(directory);
  const conflicting = relayLeg('cycle-relay-hash-conflict', { relayRequestId: 'relay-cycle-relay-hash-conflict' });
  await second.recordRelayLeg('cycle-relay-hash-conflict', conflicting);
  await assert.rejects(
    () => second.recordRelayLegSource('cycle-relay-hash-conflict', conflicting.relayRequestId, sourceTxHash),
    /transaction hash.*already|already.*transaction hash/i,
  );
});

test('keeps Solana Relay signatures byte-exact while canonicalizing EVM transaction hashes', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const firstReturn = await repository.recordRelayLeg(cycleId, returnRelayLeg(cycleId));
  const solanaSignature = 'AbCdEfGhJkLmNpQrStUvWxYz23456789AbCdEfGhJkLmNpQr';
  await repository.recordRelayLegSource(cycleId, firstReturn.relayRequestId, solanaSignature);

  const secondCycleId = 'cycle-solana-signature-case';
  await createSiblingCycle(directory, secondCycleId);
  const second = await CycleRepository.open(directory);
  const secondReturn = await second.recordRelayLeg(secondCycleId, returnRelayLeg(secondCycleId));
  await second.recordRelayLegSource(secondCycleId, secondReturn.relayRequestId, solanaSignature.toLowerCase());

  const evmHash = `0x${'A'.repeat(64)}`;
  const outbound = await repository.recordRelayLeg(cycleId, relayLeg(cycleId, {
    relayRequestId: 'relay-evm-case-sensitive-check',
    sourceAssetId: SETTLEMENT_SOURCE_ASSET,
    destinationAssetId: SETTLEMENT_SOLANA_MINT,
  }));
  await repository.recordRelayLegSource(cycleId, outbound.relayRequestId, evmHash);
  const thirdCycleId = 'cycle-evm-hash-case';
  await createSiblingCycle(directory, thirdCycleId);
  const third = await CycleRepository.open(directory);
  const conflicting = await third.recordRelayLeg(thirdCycleId, relayLeg(thirdCycleId, {
    relayRequestId: 'relay-evm-hash-case-conflict',
    sourceAssetId: SETTLEMENT_SOURCE_ASSET,
    destinationAssetId: SETTLEMENT_SOLANA_MINT,
  }));
  await assert.rejects(
    () => third.recordRelayLegSource(thirdCycleId, conflicting.relayRequestId, evmHash.toLowerCase()),
    /transaction hash.*already|already.*transaction hash/i,
  );
});

test('durable transaction reserves a Relay transaction hash atomically across stale concurrent commits', async t => {
  const store = await DurableCycleStore.open(await tempDirectory(t));
  const key = `relay-transaction:${'a'.repeat(64)}`;
  const firstOwner = { cycleId: 'cycle-relay-reservation-a', relayRequestId: 'relay-reservation-a', transactionHash: `0x${'a'.repeat(64)}` };
  const secondOwner = { cycleId: 'cycle-relay-reservation-b', relayRequestId: 'relay-reservation-b', transactionHash: `0x${'a'.repeat(64)}` };

  const firstSnapshot = store.readCycle(firstOwner.cycleId);
  const first = store.begin(firstOwner.cycleId, {
    expectedVersion: firstSnapshot.version,
    expectedJournalHead: firstSnapshot.journalHead,
  });
  first.stageEvent(new CycleJournal(firstOwner.cycleId, firstSnapshot.entries).propose('cycle-opened', {
    releaseAmount: '1', openedAtMs: 1,
  }));
  first.stageGlobalKey(key, firstOwner);

  const secondSnapshot = store.readCycle(secondOwner.cycleId);
  const second = store.begin(secondOwner.cycleId, {
    expectedVersion: secondSnapshot.version,
    expectedJournalHead: secondSnapshot.journalHead,
  });
  second.stageEvent(new CycleJournal(secondOwner.cycleId, secondSnapshot.entries).propose('cycle-opened', {
    releaseAmount: '1', openedAtMs: 1,
  }));
  second.stageGlobalKey(key, secondOwner);

  await store.commit(first);
  await assert.rejects(() => store.commit(second), /global reservation key is already reserved/);
});

test('Relay settlement writes the matrix hold exactly once after both process-RPC finality observations', async t => {
  const cases = [
    { expectedState: 'HELD_RELAY_PARTIAL', mint: SETTLEMENT_SOLANA_MINT, amountAtomic: '1', deadlineUnixSeconds: '1700000200' },
    { expectedState: 'HELD_RELAY_LATE', mint: SETTLEMENT_SOLANA_MINT, amountAtomic: '24694978', deadlineUnixSeconds: '1700000099' },
    { expectedState: 'HELD_RELAY_WRONG_ASSET', mint: 'So11111111111111111111111111111111111111112', amountAtomic: '24694978', deadlineUnixSeconds: '1700000200' },
  ];
  for (const [index, fixtureCase] of cases.entries()) {
    const directory = await tempDirectory(t);
    const repository = await CycleRepository.open(directory);
    const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
    const recorded = await repository.recordRelayLeg(cycleId, relayLeg(cycleId, {
      sourceAssetId: SETTLEMENT_SOURCE_ASSET,
      destinationAssetId: SETTLEMENT_SOLANA_MINT,
    }));
    const sourceTransactionHash = `0x${String(index + 6).repeat(64)}`;
    const requestDigest = await prepareOutboundRelaySettlementAttempt(
      repository,
      cycleId,
      sourceTransactionHash,
      fixtureCase.deadlineUnixSeconds,
      recorded,
    );
    await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTransactionHash);
    const sourceProof = await finalizedOutboundSourceProof({
      transactionHash: sourceTransactionHash,
      amountAtomic: recorded.sourceAmountAtomic,
    });
    await repository.recordBroadcast(cycleId, 'outbound', requestDigest, { transactionHash: sourceTransactionHash });
    await repository.recordFinality(cycleId, 'outbound', requestDigest, {
      transactionHash: sourceTransactionHash,
      finalizedAtSource: {
        height: sourceProof.receiptBlockNumber.toString(),
        hash: sourceProof.receiptBlockHash,
        timestampUnixSeconds: sourceProof.receiptBlockTimestampUnixSeconds,
      },
    });
    const submission = {
      sourceProof,
      destinationObservation: await finalizedDestinationObservation({
        relayRequestId: recorded.relayRequestId,
        mint: fixtureCase.mint,
        amountAtomic: fixtureCase.amountAtomic,
      }),
    };
    const settled = await repository.settleRelayLeg(cycleId, recorded.relayRequestId, submission);
    assert.equal(settled.state, fixtureCase.expectedState);
    const described = await repository.describeCycle(cycleId);
    assert.equal(described.terminalState, fixtureCase.expectedState);
    assert.equal((await repository.readChainTransactionAttempt(cycleId, 'outbound', requestDigest)).attempt.state, 'FINALIZED');
    await assert.rejects(
      () => repository.settleRelayLeg(cycleId, recorded.relayRequestId, submission),
      /terminal|transition/i,
    );
  }
});

test('settleRelayLeg holds a process-RPC origin refund credit after reopen without a second settlement', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, relayLeg(cycleId, {
    sourceAssetId: SETTLEMENT_SOURCE_ASSET,
    destinationAssetId: SETTLEMENT_SOLANA_MINT,
  }));
  const sourceTxHash = `0x${'7'.repeat(64)}`;
  const requestDigest = await prepareOutboundRelaySettlementAttempt(
    repository,
    cycleId,
    sourceTxHash,
    '1700000200',
    recorded,
  );
  await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  const sourceProof = await finalizedOutboundSourceProof({
    transactionHash: sourceTxHash,
    amountAtomic: recorded.sourceAmountAtomic,
  });
  await repository.recordBroadcast(cycleId, 'outbound', requestDigest, { transactionHash: sourceTxHash });
  await repository.recordFinality(cycleId, 'outbound', requestDigest, {
    transactionHash: sourceTxHash,
    finalizedAtSource: {
      height: sourceProof.receiptBlockNumber.toString(),
      hash: sourceProof.receiptBlockHash,
      timestampUnixSeconds: sourceProof.receiptBlockTimestampUnixSeconds,
    },
  });

  const refundTxHash = `0x${'8'.repeat(64)}`;
  const refundReceiptBlockHash = `0x${'9'.repeat(64)}`;
  const refundProof = await readOutboundOriginRefundProof({
    client: {
      async getTransactionReceipt({ hash }) {
        assert.equal(hash, refundTxHash);
        return {
          transactionHash: refundTxHash,
          blockNumber: 200n,
          blockHash: refundReceiptBlockHash,
          status: 'success',
          logs: [{
            address: SETTLEMENT_SOURCE_ASSET,
            topics: [ERC20_TRANSFER_TOPIC, addressTopic(SETTLEMENT_DEPOSITORY), addressTopic(SETTLEMENT_SOURCE_ACCOUNT)],
            data: `0x${BigInt(recorded.sourceAmountAtomic).toString(16).padStart(64, '0')}`,
            logIndex: 0n,
          }],
        };
      },
      async getBlock({ blockTag, blockNumber }) {
        if (blockTag === 'finalized') return { number: 201n, hash: `0x${'a'.repeat(64)}`, timestamp: 1_700_000_100n };
        if (blockNumber === 200n) return { number: 200n, hash: refundReceiptBlockHash, timestamp: 1_700_000_100n };
        throw new Error('unexpected refund block read');
      },
    },
    pointer: {
      schema: 'hookemon.relay-terminal-origin-refund-pointer.v1',
      relayRequestId: recorded.relayRequestId,
      status: 'REFUND',
      refundTxHash,
    },
    leg: { ...recorded, sourceTxHash },
    sourceFinality: {
      height: sourceProof.receiptBlockNumber.toString(),
      hash: sourceProof.receiptBlockHash,
      timestampUnixSeconds: sourceProof.receiptBlockTimestampUnixSeconds,
    },
    sourceAccount: SETTLEMENT_DEPOSITORY,
    operationsAccount: SETTLEMENT_SOURCE_ACCOUNT,
  });
  assert.notEqual(refundProof, null);

  const settled = await repository.settleRelayLeg(cycleId, recorded.relayRequestId, { sourceProof, refundProof });
  assert.equal(settled.state, 'HELD_RELAY_REFUND');
  assert.equal((await repository.readChainTransactionAttempt(cycleId, 'outbound', requestDigest)).attempt.state, 'FINALIZED');
  assert.equal((await repository.describeCycle(cycleId)).terminalState, 'HELD_RELAY_REFUND');

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).relayLegs.get(recorded.relayRequestId).state, 'HELD_RELAY_REFUND');
  await assertRelayHoldRecoveryTuple({
    repository: reopened,
    cycleId,
    stage: 'outbound',
    requestDigest,
    expectedTerminalState: 'HELD_RELAY_REFUND',
  });
  await assert.rejects(
    () => reopened.settleRelayLeg(cycleId, recorded.relayRequestId, { sourceProof, refundProof }),
    /terminal|transition/i,
  );
});

test('settleRelayLeg rejects branded outbound evidence whose accounts differ from the durable route', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, relayLeg(cycleId, {
    sourceAssetId: SETTLEMENT_SOURCE_ASSET,
    destinationAssetId: SETTLEMENT_SOLANA_MINT,
  }));
  const sourceTxHash = `0x${'d'.repeat(64)}`;
  await prepareOutboundRelaySettlementAttempt(
    repository,
    cycleId,
    sourceTxHash,
    '1700000200',
    recorded,
    {
      relayRoute: {
        ...outboundRelayRoute(),
        sourceSender: '0x00000000000000000000000000000000000000aa',
      },
    },
  );
  await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  const sourceProof = await finalizedOutboundSourceProof({
    transactionHash: sourceTxHash,
    amountAtomic: recorded.sourceAmountAtomic,
  });
  const destinationObservation = await finalizedDestinationObservation({
    relayRequestId: recorded.relayRequestId,
    mint: SETTLEMENT_SOLANA_MINT,
    amountAtomic: recorded.destinationAmountAtomic,
  });
  await assert.rejects(
    () => repository.settleRelayLeg(cycleId, recorded.relayRequestId, { sourceProof, destinationObservation }),
    /durable outbound route|own process RPC source proof/i,
  );
  assert.equal((await repository.describeCycle(cycleId)).relayLegs.get(recorded.relayRequestId).state, 'RECORDED');
});

test('settleRelayLeg binds an exact finalized return receipt to custody before payout and survives reopen', async t => {
  const fixture = await finalizedReturnFixture(t);
  const settled = await fixture.repository.settleRelayLeg(
    fixture.cycleId,
    fixture.leg.relayRequestId,
    fixture.submission,
  );
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.netDeltaAtomic, fixture.leg.destinationAmountAtomic);

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'SETTLED');
  assert.equal(
    state.custodyLedgers.get(`4663\u0000${SETTLEMENT_SOURCE_ASSET}`).returnReceived,
    fixture.leg.destinationAmountAtomic,
  );
  assert.equal((await reopened.readChainTransactionAttempt(fixture.cycleId, 'return', fixture.requestDigest)).attempt.state, 'FINALIZED');
});

test('settleRelayLeg holds a wrong-amount return receipt as HELD_RELAY_PARTIAL after reopen', async t => {
  const fixture = await finalizedReturnFixture(t, { proof: { observedAmountAtomic: '15' } });
  const settled = await fixture.repository.settleRelayLeg(
    fixture.cycleId,
    fixture.leg.relayRequestId,
    fixture.submission,
  );
  assert.equal(settled.state, 'HELD_RELAY_PARTIAL');

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, 'HELD_RELAY_PARTIAL');
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'HELD_RELAY_PARTIAL');
  assert.equal(state.custodyLedgers.get(`4663\u0000${SETTLEMENT_SOURCE_ASSET}`), undefined);
  await assertRelayHoldRecoveryTuple({
    repository: reopened,
    cycleId: fixture.cycleId,
    stage: 'return',
    requestDigest: fixture.requestDigest,
    expectedTerminalState: 'HELD_RELAY_PARTIAL',
  });
  await assert.rejects(
    () => reopened.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission),
    /terminal|transition/i,
  );
});

test('settleRelayLeg holds a late return receipt as HELD_RELAY_LATE after reopen', async t => {
  const fixture = await finalizedReturnFixture(t, { proof: { destinationTimestampUnixSeconds: '1700000601' } });
  const settled = await fixture.repository.settleRelayLeg(
    fixture.cycleId,
    fixture.leg.relayRequestId,
    fixture.submission,
  );
  assert.equal(settled.state, 'HELD_RELAY_LATE');

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  assert.equal(state.terminalState, 'HELD_RELAY_LATE');
  assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'HELD_RELAY_LATE');
  await assertRelayHoldRecoveryTuple({
    repository: reopened,
    cycleId: fixture.cycleId,
    stage: 'return',
    requestDigest: fixture.requestDigest,
    expectedTerminalState: 'HELD_RELAY_LATE',
  });
  await assert.rejects(
    () => reopened.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission),
    /terminal|transition/i,
  );
});

test('settleRelayLeg holds a wrong-token or wrong-recipient return receipt as HELD_RELAY_WRONG_ASSET after reopen', async t => {
  const cases = [
    { observedToken: `0x${'1'.repeat(40)}` },
    { observedRecipient: `0x${'2'.repeat(40)}` },
  ];
  for (const proof of cases) {
    const fixture = await finalizedReturnFixture(t, { proof });
    const settled = await fixture.repository.settleRelayLeg(
      fixture.cycleId,
      fixture.leg.relayRequestId,
      fixture.submission,
    );
    assert.equal(settled.state, 'HELD_RELAY_WRONG_ASSET');

    const reopened = await CycleRepository.open(fixture.directory);
    const state = await reopened.describeCycle(fixture.cycleId);
    assert.equal(state.terminalState, 'HELD_RELAY_WRONG_ASSET');
    assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'HELD_RELAY_WRONG_ASSET');
    await assertRelayHoldRecoveryTuple({
      repository: reopened,
      cycleId: fixture.cycleId,
      stage: 'return',
      requestDigest: fixture.requestDigest,
      expectedTerminalState: 'HELD_RELAY_WRONG_ASSET',
    });
    await assert.rejects(
      () => reopened.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission),
      /terminal|transition/i,
    );
  }
});

test('settleRelayLeg rejects a destination hash already attributed to another return leg after reopen', async t => {
  const first = await finalizedReturnFixture(t);
  await first.repository.settleRelayLeg(first.cycleId, first.leg.relayRequestId, first.submission);

  const secondCycleId = 'cycle-return-destination-conflict';
  await createSiblingCycle(first.directory, secondCycleId);
  const second = await CycleRepository.open(first.directory);
  const recorded = await second.recordRelayLeg(secondCycleId, returnRelayLeg(secondCycleId));
  const sourceTxHash = 'return-source-destination-conflict';
  const attributed = await second.recordRelayLegSource(secondCycleId, recorded.relayRequestId, sourceTxHash);
  await prepareReturnRelaySettlementAttempt(second, secondCycleId, attributed, sourceTxHash);
  const duplicate = {
    returnDestinationProof: await returnDestinationProof(attributed, {
      destinationTxHash: first.submission.returnDestinationProof.destinationTxHash,
    }),
  };
  await assert.rejects(
    () => second.settleRelayLeg(secondCycleId, attributed.relayRequestId, duplicate),
    /transaction hash.*already|already.*transaction hash/i,
  );

  const reopened = await CycleRepository.open(first.directory);
  const state = await reopened.describeCycle(secondCycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(attributed.relayRequestId).state, 'RECORDED');
});

test('settleRelayLeg leaves an unfinalized return source unsettled after reopen', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, returnRelayLeg(cycleId));
  const sourceTxHash = 'return-source-unfinalized';
  const attributed = await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  const requestDigest = `sha256:${'5'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'return', preparedChainAttempt(cycleId, 'return', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: 'return-signed-bytes', nonce: null, blockhash: 'return-blockhash', hash: `sha256:${'4'.repeat(64)}`,
  });
  await repository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: sourceTxHash });
  const proof = await returnDestinationProof(attributed);

  await assert.rejects(
    () => repository.settleRelayLeg(cycleId, attributed.relayRequestId, {
      returnDestinationProof: proof,
    }),
    /finalized return source|source finality|finalized/i,
  );

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.relayLegs.get(attributed.relayRequestId).state, 'RECORDED');
  assert.equal(state.custodyLedgers.get(`4663\u0000${SETTLEMENT_SOURCE_ASSET}`), undefined);
  assert.equal((await reopened.readChainTransactionAttempt(cycleId, 'return', requestDigest)).attempt.state, 'BROADCAST');
});

test('persists a standing-authority decision atomically at first use and replays it without a second reservation', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const decision = standingAuthorityDecision();
  const first = await repository.recordStandingAuthorityDecision(cycleId, decision, { maxCyclesPerDay: 1 });
  const before = await repository.describeCycle(cycleId);
  const replay = await repository.recordStandingAuthorityDecision(cycleId, decision, { maxCyclesPerDay: 1 });
  assert.deepEqual(replay, first);
  assert.equal((await repository.describeCycle(cycleId)).version, before.version);

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readStandingAuthorityDecision(cycleId, decision.intentDigest), decision);
  await assert.rejects(
    () => reopened.recordStandingAuthorityDecision(cycleId, standingAuthorityDecision({ nonceReservation: { nonce: 'cycle-outbound-2', reservationKey: `sha256:${'e'.repeat(64)}` } }), { maxCyclesPerDay: 1 }),
    /conflict/i,
  );

  await createSiblingCycle(directory, 'cycle-standing-authority-cap');
  const competing = await CycleRepository.open(directory);
  await assert.rejects(
    () => competing.recordStandingAuthorityDecision('cycle-standing-authority-cap', standingAuthorityDecision({
      intentDigest: `sha256:${'f'.repeat(64)}`,
      nonceReservation: { nonce: 'cycle-outbound-3', reservationKey: `sha256:${'0'.repeat(64)}` },
    }), { maxCyclesPerDay: 1 }),
    /day cap|reservation/i,
  );
});

test('commits concurrent first-use authority decisions with their global reservations and survives reopen', async t => {
  const directory = await tempDirectory(t);
  const initial = await CycleRepository.open(directory);
  const { cycleId: firstCycleId } = await initial.createCycle({ releaseAmount: '1', mode: 'production' });
  const secondCycleId = 'cycle-standing-authority-concurrent';
  await createSiblingCycle(directory, secondCycleId);
  const first = await CycleRepository.open(directory);
  const second = await CycleRepository.open(directory);
  const firstDecision = standingAuthorityDecision();
  const secondDecision = standingAuthorityDecision({
    intentDigest: `sha256:${'f'.repeat(64)}`,
    nonceReservation: { nonce: 'cycle-outbound-concurrent', reservationKey: `sha256:${'0'.repeat(64)}` },
  });

  const results = await Promise.all([
    first.recordStandingAuthorityDecision(firstCycleId, firstDecision, { maxCyclesPerDay: 2 }),
    second.recordStandingAuthorityDecision(secondCycleId, secondDecision, { maxCyclesPerDay: 2 }),
  ]);
  assert.deepEqual(results, [firstDecision, secondDecision]);

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readStandingAuthorityDecision(firstCycleId, firstDecision.intentDigest), firstDecision);
  assert.deepEqual(await reopened.readStandingAuthorityDecision(secondCycleId, secondDecision.intentDigest), secondDecision);
});

test('reserves one wallet nonce fence across stages and cycles, then persists recovery context next to signed bytes', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const reservation = {
    chainId: '4663',
    wallet: '0x00000000000000000000000000000000000000aa',
    stage: 'outbound',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  assert.equal((await repository.reserveWalletNonce(cycleId, reservation)).state, 'HELD');
  assert.equal(await repository.assertWalletNonce(cycleId, reservation), true);

  const requestDigest = `sha256:${'f'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', preparedChainAttempt(cycleId, 'outbound', requestDigest));
  const signingMaterial = {
    rawBytes: 'deadbeef', nonce: '9', blockhash: null, hash: `0x${'f'.repeat(64)}`,
  };
  await repository.recordSignedTransaction(cycleId, 'outbound', requestDigest, signingMaterial);
  const recovery = {
    stage: 'outbound',
    recipient: null,
    requestDigest,
    policyDigest: `sha256:${'a'.repeat(64)}`,
    approvalDigest: `sha256:${'b'.repeat(64)}`,
    fencingToken: reservation.fencingToken,
    fencingTokenDigest: `sha256:${'d'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'c'.repeat(64)}`,
    rawSignedBytesHash: signingMaterial.hash,
    signedMessageDigest: `sha256:${'e'.repeat(64)}`,
    relayQuoteDeadlineUnixSeconds: '1700000200',
  };
  await repository.persistChainAttemptRecoveryContext(cycleId, recovery);
  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readChainAttemptRecoveryContext(cycleId, recovery), recovery);
  assert.deepEqual(await reopened.readChainAttemptRecoveryContext(cycleId, {
    stage: recovery.stage,
    recipient: recovery.recipient,
    requestDigest: recovery.requestDigest,
    rawSignedBytesHash: recovery.rawSignedBytesHash,
  }), recovery);

  await createSiblingCycle(directory, 'cycle-wallet-reservation-conflict');
  const competing = await CycleRepository.open(directory);
  await assert.rejects(
    () => competing.reserveWalletNonce('cycle-wallet-reservation-conflict', { ...reservation, stage: 'payout' }),
    /wallet.*reserved|wallet.*locked/i,
  );
});

test('takes over an expired wallet nonce after reopen without reviving the prior signing fence', async t => {
  const directory = await tempDirectory(t);
  let now = 9_999;
  const repository = await CycleRepository.open(directory, () => now);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const expired = {
    chainId: '4663',
    wallet: '0x00000000000000000000000000000000000000aa',
    stage: 'outbound',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    leaseAcquiredAtMs: 9_000,
    leaseExpiresAtMs: 10_000,
  };
  await repository.reserveWalletNonce(cycleId, expired);
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const signingMaterial = {
    rawBytes: 'deadbeef', nonce: '9', blockhash: null, hash: `0x${'b'.repeat(64)}`,
  };
  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', preparedChainAttempt(cycleId, 'outbound', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'outbound', requestDigest, signingMaterial);
  const recovery = {
    stage: 'outbound',
    recipient: null,
    requestDigest,
    policyDigest: `sha256:${'c'.repeat(64)}`,
    approvalDigest: `sha256:${'d'.repeat(64)}`,
    fencingToken: expired.fencingToken,
    fencingTokenDigest: `sha256:${'e'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'f'.repeat(64)}`,
    rawSignedBytesHash: signingMaterial.hash,
    signedMessageDigest: `sha256:${'0'.repeat(64)}`,
    relayQuoteDeadlineUnixSeconds: '1700000200',
  };
  await repository.persistChainAttemptRecoveryContext(cycleId, recovery);

  now = 10_001;
  const reopened = await CycleRepository.open(directory, () => now);
  const replacement = {
    ...expired,
    fencingToken: '22345678-1234-4123-8123-123456789abc',
    leaseAcquiredAtMs: now,
    leaseExpiresAtMs: 20_000,
  };
  assert.equal((await reopened.reserveWalletNonce(cycleId, replacement)).fencingToken, replacement.fencingToken);
  await assert.rejects(
    () => reopened.assertWalletNonce(cycleId, expired),
    /expired|stale/i,
  );
  assert.equal(await reopened.assertWalletNonce(cycleId, replacement), true);
  assert.deepEqual((await reopened.readChainTransactionAttempt(cycleId, 'outbound', requestDigest)).attempt, {
    ...preparedChainAttempt(cycleId, 'outbound', requestDigest),
    state: 'SIGNED',
    ...signingMaterial,
  });
  assert.deepEqual(await reopened.readChainAttemptRecoveryContext(cycleId, recovery), recovery);

  await reopened.releaseWalletNonce(cycleId, replacement);
  const afterRelease = await CycleRepository.open(directory, () => now);
  assert.equal((await afterRelease.reserveWalletNonce(cycleId, {
    ...replacement,
    stage: 'payout',
    fencingToken: '32345678-1234-4123-8123-123456789abc',
  })).state, 'HELD');
});

test('reacquires a released wallet nonce for a different stage in the same cycle', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const outboundReservation = {
    chainId: '4663',
    wallet: '0x00000000000000000000000000000000000000aa',
    stage: 'outbound',
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  };

  await repository.reserveWalletNonce(cycleId, outboundReservation);
  await repository.releaseWalletNonce(cycleId, outboundReservation);

  const payoutReservation = {
    ...outboundReservation,
    stage: 'payout',
    fencingToken: '22345678-1234-4123-8123-123456789abc',
  };
  assert.deepEqual(await repository.reserveWalletNonce(cycleId, payoutReservation), {
    schema: 'hookemon.wallet-nonce-reservation.v1',
    chainId: payoutReservation.chainId,
    wallet: payoutReservation.wallet,
    cycleId,
    stage: payoutReservation.stage,
    fencingToken: payoutReservation.fencingToken,
    leaseAcquiredAtMs: payoutReservation.leaseAcquiredAtMs,
    leaseExpiresAtMs: payoutReservation.leaseExpiresAtMs,
    state: 'HELD',
  });

  await assert.rejects(
    () => repository.reserveWalletNonce(cycleId, {
      ...payoutReservation,
      stage: 'return',
      fencingToken: '32345678-1234-4123-8123-123456789abc',
    }),
    /wallet is already reserved with different fence/,
  );
});

test('persists a recipient-keyed payout recovery context before its paged signed attempt exists', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  const recovery = {
    stage: 'payout',
    recipient: '0x00000000000000000000000000000000000000bb',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    policyDigest: `sha256:${'b'.repeat(64)}`,
    approvalDigest: `sha256:${'c'.repeat(64)}`,
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    fencingTokenDigest: `sha256:${'d'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'e'.repeat(64)}`,
    rawSignedBytesHash: `0x${'f'.repeat(64)}`,
    signedMessageDigest: `sha256:${'0'.repeat(64)}`,
  };
  await repository.persistChainAttemptRecoveryContext(cycleId, recovery);
  assert.deepEqual(await repository.readChainAttemptRecoveryContext(cycleId, {
    stage: recovery.stage,
    recipient: recovery.recipient,
    requestDigest: recovery.requestDigest,
    rawSignedBytesHash: recovery.rawSignedBytesHash,
  }), recovery);
});

test('retains exact payout recovery contexts for a replacement and its predecessor', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  const first = {
    stage: 'payout',
    recipient: '0x00000000000000000000000000000000000000bb',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    policyDigest: `sha256:${'b'.repeat(64)}`,
    approvalDigest: `sha256:${'c'.repeat(64)}`,
    fencingToken: '12345678-1234-4123-8123-123456789abc',
    fencingTokenDigest: `sha256:${'d'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'e'.repeat(64)}`,
    rawSignedBytesHash: `0x${'f'.repeat(64)}`,
    signedMessageDigest: `sha256:${'0'.repeat(64)}`,
  };
  const replacement = {
    ...first,
    approvalDigest: `sha256:${'1'.repeat(64)}`,
    approvedSemanticsDigest: `sha256:${'2'.repeat(64)}`,
    rawSignedBytesHash: `0x${'3'.repeat(64)}`,
    signedMessageDigest: `sha256:${'4'.repeat(64)}`,
  };

  await repository.persistChainAttemptRecoveryContext(cycleId, first);
  await repository.persistChainAttemptRecoveryContext(cycleId, replacement);

  assert.deepEqual(await repository.readChainAttemptRecoveryContext(cycleId, {
    stage: first.stage,
    recipient: first.recipient,
    requestDigest: first.requestDigest,
    rawSignedBytesHash: first.rawSignedBytesHash,
  }), first);
  assert.deepEqual(await repository.readChainAttemptRecoveryContext(cycleId, {
    stage: replacement.stage,
    recipient: replacement.recipient,
    requestDigest: replacement.requestDigest,
    rawSignedBytesHash: replacement.rawSignedBytesHash,
  }), replacement);
});

// --- Stage-attempt bookkeeping (WP-36: attempt index + failure tracking for nonce derivation) --

test('readStageAttempt/nextStageAttemptIndex are null/0 before any attempt is recorded', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  assert.equal(await repository.readStageAttempt(cycleId, 'eligibility-snapshot'), null);
  assert.equal(await repository.nextStageAttemptIndex(cycleId, 'eligibility-snapshot'), 0);
});

test('recordStageAttempt is read back by readStageAttempt, and does not advance nextStageAttemptIndex for a still-resumable (not failed) attempt', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordStageAttempt(cycleId, 'eligibility-snapshot', { transactionHash: '0xabc' });
  assert.deepEqual(await repository.readStageAttempt(cycleId, 'eligibility-snapshot'), { transactionHash: '0xabc' });
  // A still-resumable attempt is not "used up" — its own recorded evidence (and nonce) is exactly
  // what a caller resumes; nextStageAttemptIndex(1) would only matter once this attempt is
  // superseded, which never happens for a merely-not-yet-finalized attempt.
  assert.equal(await repository.nextStageAttemptIndex(cycleId, 'eligibility-snapshot'), 1);
});

test('recordStageAttemptFailure marks the current attempt as never-resumable: readStageAttempt reports null, but nextStageAttemptIndex advances past it', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordStageAttempt(cycleId, 'eligibility-snapshot', { transactionHash: '0xabc' });
  await repository.recordStageAttemptFailure(cycleId, 'eligibility-snapshot', { reason: 'reverted' });
  assert.equal(await repository.readStageAttempt(cycleId, 'eligibility-snapshot'), null, 'a failed attempt must never be reported as resumable');
  assert.equal(await repository.nextStageAttemptIndex(cycleId, 'eligibility-snapshot'), 1, 'the next fresh attempt gets index 1, never colliding with the failed attempt\'s own index (0)');

  // A fresh attempt recorded after the failure is itself resumable again, and the index keeps
  // advancing monotonically — never reused, never decreasing.
  await repository.recordStageAttempt(cycleId, 'eligibility-snapshot', { transactionHash: '0xdef' });
  assert.deepEqual(await repository.readStageAttempt(cycleId, 'eligibility-snapshot'), { transactionHash: '0xdef' });
  assert.equal(await repository.nextStageAttemptIndex(cycleId, 'eligibility-snapshot'), 2);
});

test('stage-attempt bookkeeping is per-stage: recording/failing one stage\'s attempt never affects another stage\'s', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordStageAttempt(cycleId, 'eligibility-snapshot', { transactionHash: '0xsnapshot' });
  await repository.recordStageAttemptFailure(cycleId, 'eligibility-snapshot');
  await repository.recordStageAttempt(cycleId, 'payout', { transactionHash: '0xpayout' });
  assert.equal(await repository.readStageAttempt(cycleId, 'eligibility-snapshot'), null);
  assert.deepEqual(await repository.readStageAttempt(cycleId, 'payout'), { transactionHash: '0xpayout' });
  assert.equal(await repository.nextStageAttemptIndex(cycleId, 'eligibility-snapshot'), 1);
  assert.equal(await repository.nextStageAttemptIndex(cycleId, 'payout'), 1);
});

test('crash-resume: stage-attempt failure bookkeeping survives a fresh CycleRepository opened from the same directory', async t => {
  const directory = await tempDirectory(t);
  const before = await CycleRepository.open(directory);
  const { cycleId } = await before.createCycle({ releaseAmount: '1', mode: 'production' });
  await before.recordStageAttempt(cycleId, 'eligibility-snapshot', { transactionHash: '0xabc' });
  await before.recordStageAttemptFailure(cycleId, 'eligibility-snapshot');

  const after = await CycleRepository.open(directory);
  assert.equal(await after.readStageAttempt(cycleId, 'eligibility-snapshot'), null);
  assert.equal(await after.nextStageAttemptIndex(cycleId, 'eligibility-snapshot'), 1);
});

test('recordStageAttempt/readStageAttempt/nextStageAttemptIndex/recordStageAttemptFailure reject an unknown stage name', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await assert.rejects(() => repository.recordStageAttempt(cycleId, 'not-a-real-stage', {}), /unknown stage/);
  await assert.rejects(() => repository.readStageAttempt(cycleId, 'not-a-real-stage'), /unknown stage/);
  await assert.rejects(() => repository.nextStageAttemptIndex(cycleId, 'not-a-real-stage'), /unknown stage/);
  await assert.rejects(() => repository.recordStageAttemptFailure(cycleId, 'not-a-real-stage'), /unknown stage/);
});

test('persists a write-ahead provider attempt before mutation and only reconciles it after recorded evidence', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const prepared = {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  };

  await repository.prepareStageAttempt(cycleId, 'purchase', prepared);
  assert.deepEqual(await repository.readStageAttempt(cycleId, 'purchase'), null);
  assert.deepEqual((await repository.readOperationalStageAttempt(cycleId, 'purchase')).attempt, prepared);

  await repository.recordStageAttemptResponse(cycleId, 'purchase', { memo: 'purchase-1' });
  assert.deepEqual(await repository.readStageAttempt(cycleId, 'purchase'), { memo: 'purchase-1' });
  await repository.reconcileStageAttempt(cycleId, 'purchase', { memo: 'purchase-1', finalized: true });

  const reopened = await CycleRepository.open(directory);
  const recovered = await reopened.readOperationalStageAttempt(cycleId, 'purchase');
  assert.equal(recovered.attempt.state, 'RECONCILED');
  assert.deepEqual(recovered.reconciliationEvidence, { memo: 'purchase-1', finalized: true });
});

test('persists a pre-call NOT_SENT attempt and resets the same request to PREPARED after reopen', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const prepared = {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'f'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  };

  await repository.prepareStageAttempt(cycleId, 'purchase', prepared);
  await repository.markStageAttemptNotSent(cycleId, 'purchase');
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'NOT_SENT');

  const reopened = await CycleRepository.open(directory);
  await reopened.prepareStageAttempt(cycleId, 'purchase', prepared);
  const retried = await reopened.readOperationalStageAttempt(cycleId, 'purchase');
  assert.deepEqual(retried.attempt, prepared);
  assert.equal(retried.responseEvidence, null);
  assert.equal(retried.reconciliationEvidence, null);
});

test('an operational stage can complete only from matching reconciled evidence', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await completePredecessors(repository, cycleId, 'purchase');
  await repository.prepareStage(cycleId, 'purchase');
  await repository.prepareStageAttempt(cycleId, 'purchase', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'e'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });
  await repository.recordStageAttemptResponse(cycleId, 'purchase', { providerReceipt: 'receipt-2' });

  await assert.rejects(
    () => repository.completeStage(cycleId, 'purchase', { providerReceipt: 'receipt-2' }),
    /requires reconciled operational evidence/,
  );
  await repository.reconcileStageAttempt(cycleId, 'purchase', { providerReceipt: 'receipt-2', finalized: true });
  await assert.rejects(
    () => repository.completeStage(cycleId, 'purchase', { providerReceipt: 'receipt-2' }),
    /must match reconciled operational evidence/,
  );
  await repository.completeStage(cycleId, 'purchase', { providerReceipt: 'receipt-2', finalized: true });
});

test('marks a thrown post-send mutation unknown and retains custody obligations as a claim precondition', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStageAttempt(cycleId, 'purchase', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });
  await repository.markStageAttemptSentUnknown(cycleId, 'purchase');
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'purchase')).attempt.state, 'SENT_UNKNOWN');

  await repository.recordCustodyLedger(cycleId, {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:stablecoin',
    decimals: 6,
    claimed: '1',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '1',
    dust: '0',
    unattributed: '0',
  });
  assert.deepEqual(await repository.readClaimPreconditions(), {
    heldAssets: false,
    unattributed: false,
    unresolvedObligations: true,
  });
});
