import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCycleAttributableFinalizedAvailableReader } from '../../src/app/payout-availability.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { readReturnLegDestinationProof } from '../../src/app/stages/return.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';

const OPERATIONS = '0x000000000000000000000000000000000000dead';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FINALIZED_NUMBER = 100n;
const FINALIZED_HASH = `0x${'a'.repeat(64)}`;

function usdg(amountAtomic) {
  return createUsdgPayoutAmount({ assetId: USDG, amountAtomic });
}

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-payout-availability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function returnBindingFor(cycleId, evidence) {
  return {
    operations: OPERATIONS,
    usdgAddress: USDG,
    evidenceDigest: canonicalDigest({ schema: 'hookemon.direct-payout-finalized-return.v1', cycleId, returnEvidence: evidence }),
  };
}

function baseRequest(cycleId, { returnEvidence, returnDelta = usdg('0'), previousDust = usdg('0'), previousDustSource = null, planDigest = `sha256:${'1'.repeat(64)}` }) {
  return {
    cycleId,
    operations: OPERATIONS,
    usdgAddress: USDG,
    returnDelta,
    returnEvidence: returnBindingFor(cycleId, returnEvidence),
    previousDust,
    previousDustSource,
    planDigest,
  };
}

function fakePublicClient({ finalizedHash = FINALIZED_HASH, recheckHash = finalizedHash, calls = [] } = {}) {
  return {
    async getBlock({ blockTag, blockNumber } = {}) {
      if (blockTag === 'finalized') {
        calls.push('finalized');
        return { number: FINALIZED_NUMBER, hash: finalizedHash, timestamp: 1_700_000_000n };
      }
      if (blockNumber === FINALIZED_NUMBER) {
        calls.push('recheck');
        return { number: FINALIZED_NUMBER, hash: recheckHash, timestamp: 1_700_000_001n };
      }
      throw new Error(`unexpected public block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

function fakeArchiveClient({
  value = 1_000_000n,
  blockNumber = FINALIZED_NUMBER,
  blockHash = FINALIZED_HASH,
  calls = [],
  requests = [],
} = {}) {
  return {
    async readErc20BalanceAtBlock(request) {
      calls.push('archive');
      requests.push(request);
      return { value, blockNumber, blockHash };
    },
  };
}

/** `completeStage('return', ...)` requires every predecessor operational stage already complete;
 * none of them ever get a chain/operational attempt here, so `assertReconciledCompletion` accepts
 * arbitrary evidence for each. */
async function completeReturnStage(repository, cycleId, evidence) {
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    if (stage === 'return') break;
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, null);
  }
  await repository.prepareStage(cycleId, 'return');
  await repository.completeStage(cycleId, 'return', evidence);
}

/** Only one cycle may be active at a time. A predecessor cycle whose dust a later cycle carries
 * must be driven to full completion (every stage, trivial evidence) so it stops being "active"
 * and the target cycle can be created in the same durable repository. */
async function completeCycleFully(repository, cycleId) {
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, null);
  }
  await repository.completeCycle(cycleId);
}

function zeroProceedsEvidence(cycleId) {
  return {
    schema: 'hookemon.return-zero-proceeds-evidence.v1',
    cycleId,
    finalized: true,
    noBridge: true,
    destinationAccount: OPERATIONS,
    destinationAsset: USDG,
    destinationCreditAmount: '0',
  };
}

test('reads zero for a finalized zero-proceeds return with no carried dust, never touching an unrelated wallet balance', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);

  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: 999_999_999n }),
  });
  const result = await reader(baseRequest(cycleId, { returnEvidence: evidence }));
  assert.deepEqual(result, usdg('0'));

  // A restart reading unchanged durable evidence returns the identical amount without any write.
  const again = await reader(baseRequest(cycleId, { returnEvidence: evidence }));
  assert.deepEqual(again, result);
});

// --- Relay-settlement fixture: mirrors packages/adapters/test/app/cycle-repository.test.mjs's own
// finalizedReturnFixture, trimmed to only what this reader needs to reload and re-authenticate.
function returnRelayLeg(cycleId) {
  const relayRequestId = `relay-return-${cycleId}`;
  return {
    schema: 'hookemon.relay-leg.v1',
    cycleId,
    direction: 'return',
    relayRequestId,
    quoteDigest: `sha256:${'9'.repeat(64)}`,
    sourceChainId: '792703809',
    sourceTxHash: null,
    sourceAssetId: SOLANA_MINT,
    sourceDecimals: 6,
    sourceAmountAtomic: '17',
    destinationChainId: '4663',
    destinationTxHash: null,
    destinationAssetId: USDG,
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
        originAssetId: SOLANA_MINT,
        originDecimals: 6,
        destinationAssetId: USDG,
        destinationDecimals: 6,
        originAmount: '17',
        quotedDestinationAmount: '16',
        quotedDestinationMinimumAmount: '16',
        sender: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE',
        recipient: OPERATIONS,
        deadlineUnixSeconds: 1_800_000_000,
      },
      requestCreatedAtUnixSeconds: '1700000000',
      maxSettlementWindowSeconds: '600',
    },
  };
}

function preparedChainAttempt(cycleId, stage, requestDigest) {
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

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function returnDestinationReceiptClient({ transactionHash, observedAmountAtomic, destinationTimestampUnixSeconds }) {
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
          address: USDG,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(OPERATIONS)],
          data: `0x${BigInt(observedAmountAtomic).toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') return { number: 101n, hash: finalizedBlockHash, timestamp: BigInt(destinationTimestampUnixSeconds) };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, timestamp: BigInt(destinationTimestampUnixSeconds) };
      throw new Error(`unexpected return receipt block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

async function settledReturnFixture(t, { directory = null, repository = null } = {}) {
  if (repository === null) {
    directory = await tempDirectory(t);
    repository = await CycleRepository.open(directory);
  }
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, returnRelayLeg(cycleId));
  const sourceTxHash = `return-source-${cycleId}`;
  const attributed = await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'return', preparedChainAttempt(cycleId, 'return', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: 'return-signed-bytes', nonce: null, blockhash: 'return-blockhash', hash: `sha256:${'6'.repeat(64)}`,
  });
  await repository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: sourceTxHash });
  await repository.recordFinality(cycleId, 'return', requestDigest, {
    transactionHash: sourceTxHash,
    debitedAmountAtomic: attributed.sourceAmountAtomic,
    finalizedAtSource: { height: '52', hash: 'return-source-slot', timestampUnixSeconds: '1700000010' },
  });
  const destinationTxHash = `0x${'f'.repeat(64)}`;
  const proof = await readReturnLegDestinationProof({
    client: returnDestinationReceiptClient({
      transactionHash: destinationTxHash,
      observedAmountAtomic: attributed.destinationAmountAtomic,
      destinationTimestampUnixSeconds: '1700000011',
    }),
    pointer: { schema: 'hookemon.relay-terminal-destination-pointer.v1', relayRequestId: attributed.relayRequestId, status: 'SUCCESS', destinationTxHash },
    leg: attributed,
    sourceFinality: { height: '52', hash: 'return-source-slot', timestampUnixSeconds: '1700000010' },
  });
  const settled = await repository.settleRelayLeg(cycleId, attributed.relayRequestId, { returnDestinationProof: proof });
  const evidence = { schema: 'hookemon.return-relay-settlement-evidence.v1', relayLeg: settled };
  await completeReturnStage(repository, cycleId, evidence);
  return { directory, repository, cycleId, settled, evidence };
}

test('reads the settled return delta plus carried predecessor dust, refusing to count a larger wallet balance', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId: predecessorCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const dustAmount = usdg('3');
  const planDigest = `sha256:${'2'.repeat(64)}`;
  await repository.recordPayoutDust(predecessorCycleId, { amount: dustAmount, planDigest });
  await completeCycleFully(repository, predecessorCycleId);

  const { cycleId, settled, evidence } = await settledReturnFixture(t, { repository });
  const priorDust = await repository.readPayoutDust(cycleId, { chainId: dustAmount.chainId, assetId: dustAmount.assetId, decimals: dustAmount.decimals });
  assert.equal(priorDust.source.cycleId, predecessorCycleId);

  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: BigInt(settled.netDeltaAtomic) + 3n + 500n }),
  });
  const result = await reader(baseRequest(cycleId, {
    returnEvidence: evidence,
    returnDelta: usdg(settled.netDeltaAtomic),
    previousDust: dustAmount,
    previousDustSource: priorDust.source,
    planDigest: priorDust.source.planDigest,
  }));
  assert.deepEqual(result, usdg((BigInt(settled.netDeltaAtomic) + 3n).toString()));

  // The reader is read-only: two concurrent reads (racing ahead of the one atomic dust
  // consumption that may later win) both settle on the identical amount, and the durable dust
  // record stays unconsumed -- only the existing atomic payout initializer may ever consume it.
  const request = baseRequest(cycleId, {
    returnEvidence: evidence,
    returnDelta: usdg(settled.netDeltaAtomic),
    previousDust: dustAmount,
    previousDustSource: priorDust.source,
    planDigest: priorDust.source.planDigest,
  });
  const [first, second] = await Promise.all([reader(request), reader(request)]);
  assert.deepEqual(first, result);
  assert.deepEqual(second, result);
  const stillUnconsumed = await repository.readPayoutDust(cycleId, { chainId: dustAmount.chainId, assetId: dustAmount.assetId, decimals: dustAmount.decimals });
  assert.equal(stillUnconsumed.source.cycleId, predecessorCycleId);
});

test('reads the finalized Operations USDG balance through the shared public/archive/public reader, never before the finalized head and never rechecking before the archive read', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);

  const calls = [];
  const requests = [];
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient({ calls }),
    archiveClient: fakeArchiveClient({ calls, requests }),
  });
  await reader(baseRequest(cycleId, { returnEvidence: evidence }));
  assert.deepEqual(calls, ['finalized', 'archive', 'recheck']);

  // The producer converts the already-validated raw request identity into the canonical CAIP
  // identity internally, but the archive client itself is still handed the raw ERC20 address and
  // raw Operations account -- never a CAIP-wrapped string.
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { token: USDG, account: OPERATIONS, blockNumber: FINALIZED_NUMBER, blockHash: FINALIZED_HASH });
});

test('refuses a return stage with no completed evidence', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: zeroProceedsEvidence(cycleId) })),
    /no completed finalized evidence/,
  );
});

test('refuses a plan return binding that does not authenticate the reloaded return evidence', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  const request = baseRequest(cycleId, { returnEvidence: evidence });
  request.returnEvidence = { ...request.returnEvidence, evidenceDigest: `sha256:${'0'.repeat(64)}` };
  await assert.rejects(() => reader(request), /does not authenticate the plan/);
});

test('refuses a zero-proceeds return evidence credited to the wrong Operations recipient', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = { ...zeroProceedsEvidence(cycleId), destinationAccount: `0x${'2'.repeat(40)}` };
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence })),
    /does not credit the configured Operations account/,
  );
});

test('refuses when the attributed return delta does not match the reloaded observed amount', async t => {
  const { repository, cycleId, evidence } = await settledReturnFixture(t);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: 1_000_000n }),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg('999') })),
    /does not match the plan's attributed return delta/,
  );
});

test('refuses a settled return leg that is ambiguous against the cycle\'s recorded Relay legs', async t => {
  const { cycleId, settled, evidence } = await settledReturnFixture(t);
  const fakeRepository = {
    async readStage() { return { status: 'COMPLETE', evidence }; },
    async readStageAttempt() { return null; },
    async describeCycle() {
      const duplicate = { ...settled, relayRequestId: `${settled.relayRequestId}-duplicate` };
      return { relayLegs: new Map([[settled.relayRequestId, settled], [duplicate.relayRequestId, duplicate]]), custodyLedgers: new Map() };
    },
  };
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: fakeRepository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg(settled.netDeltaAtomic) })),
    /ambiguous/,
  );
});

test('refuses a settled return leg accompanied by a second unresolved recorded return leg', async t => {
  const { cycleId, settled, evidence } = await settledReturnFixture(t);
  const fakeRepository = {
    async readStage() { return { status: 'COMPLETE', evidence }; },
    async readStageAttempt() { return null; },
    async describeCycle() {
      const recorded = {
        ...settled,
        relayRequestId: `${settled.relayRequestId}-second`,
        state: 'RECORDED',
        destinationTxHash: null,
        finalizedAtSource: null,
        finalizedAtDestination: null,
        netDeltaAtomic: null,
        sourceTxHash: null,
      };
      return {
        relayLegs: new Map([[settled.relayRequestId, settled], [recorded.relayRequestId, recorded]]),
        custodyLedgers: new Map(),
      };
    },
  };
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: fakeRepository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg(settled.netDeltaAtomic) })),
    /ambiguous/,
  );
});

test('refuses a settled return leg accompanied by a second terminally held return leg', async t => {
  const { cycleId, settled, evidence } = await settledReturnFixture(t);
  const fakeRepository = {
    async readStage() { return { status: 'COMPLETE', evidence }; },
    async readStageAttempt() { return null; },
    async describeCycle() {
      const held = { ...settled, relayRequestId: `${settled.relayRequestId}-held`, state: 'HELD_RELAY_PARTIAL' };
      return {
        relayLegs: new Map([[settled.relayRequestId, settled], [held.relayRequestId, held]]),
        custodyLedgers: new Map(),
      };
    },
  };
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: fakeRepository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg(settled.netDeltaAtomic) })),
    /ambiguous/,
  );
});

test('refuses when the cycle\'s one recorded return leg is not yet settled', async t => {
  const { cycleId, settled, evidence } = await settledReturnFixture(t);
  const fakeRepository = {
    async readStage() { return { status: 'COMPLETE', evidence }; },
    async readStageAttempt() { return null; },
    async describeCycle() {
      const unsettled = { ...settled, state: 'RECORDED', destinationTxHash: null, finalizedAtDestination: null, netDeltaAtomic: null };
      return { relayLegs: new Map([[unsettled.relayRequestId, unsettled]]), custodyLedgers: new Map() };
    },
  };
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: fakeRepository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg(settled.netDeltaAtomic) })),
    /is not settled/,
  );
});

test('refuses when the cycle custody ledger does not bind the settled return leg', async t => {
  const { cycleId, settled, evidence } = await settledReturnFixture(t);
  const fakeRepository = {
    async readStage() { return { status: 'COMPLETE', evidence }; },
    async readStageAttempt() { return null; },
    async describeCycle() {
      return {
        relayLegs: new Map([[settled.relayRequestId, settled]]),
        custodyLedgers: new Map([[
          `${settled.destinationChainId}_${settled.destinationAssetId}`,
          { cycleId, chainId: settled.destinationChainId, assetId: settled.destinationAssetId, returnReceived: '1' },
        ]]),
      };
    },
  };
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: fakeRepository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg(settled.netDeltaAtomic) })),
    /custody ledger returnReceived does not match/,
  );
});

test('refuses a missing archive-capable historical evidence client', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: null,
  });
  await assert.rejects(() => reader(baseRequest(cycleId, { returnEvidence: evidence })), /archive-capable/);
});

test('refuses an archive client that is the same instance as the public client', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const client = fakePublicClient();
  client.readErc20BalanceAtBlock = async () => ({ value: 0n, blockNumber: FINALIZED_NUMBER, blockHash: FINALIZED_HASH });
  const reader = createCycleAttributableFinalizedAvailableReader({ cycleRepository: repository, publicClient: client, archiveClient: client });
  await assert.rejects(() => reader(baseRequest(cycleId, { returnEvidence: evidence })), /archive-capable/);
});

test('refuses a malformed archive balance amount', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: -1n }),
  });
  await assert.rejects(() => reader(baseRequest(cycleId, { returnEvidence: evidence })), /malformed amount/);
});

test('refuses an archive read whose block identity does not match the requested finalized block', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ blockNumber: FINALIZED_NUMBER + 1n }),
  });
  await assert.rejects(() => reader(baseRequest(cycleId, { returnEvidence: evidence })), /did not bind the requested finalized block/);
});

test('refuses when the public finalized block hash changes after the archive read', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient({ recheckHash: `0x${'c'.repeat(64)}` }),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(() => reader(baseRequest(cycleId, { returnEvidence: evidence })), /hash changed after the archive read/);
});

test('refuses when the finalized Operations USDG balance is below the attributed return and dust', async t => {
  const { repository, cycleId, settled, evidence } = await settledReturnFixture(t);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: BigInt(settled.netDeltaAtomic) - 1n }),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, { returnEvidence: evidence, returnDelta: usdg(settled.netDeltaAtomic) })),
    /below the attributed return and dust/,
  );
});

test('refuses nonzero carried dust with no durable unconsumed predecessor record', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, {
      returnEvidence: evidence,
      previousDust: usdg('5'),
      previousDustSource: { cycleId: 'cycle-ghost', digest: `sha256:${'3'.repeat(64)}`, planDigest: `sha256:${'4'.repeat(64)}` },
    })),
    /unconsumed durable predecessor record/,
  );
});

test('refuses carried dust whose durable provenance does not match the plan\'s claimed source', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId: predecessorCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const dustAmount = usdg('3');
  await repository.recordPayoutDust(predecessorCycleId, { amount: dustAmount, planDigest: `sha256:${'2'.repeat(64)}` });
  await completeCycleFully(repository, predecessorCycleId);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const priorDust = await repository.readPayoutDust(cycleId, { chainId: dustAmount.chainId, assetId: dustAmount.assetId, decimals: dustAmount.decimals });

  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, {
      returnEvidence: evidence,
      previousDust: dustAmount,
      previousDustSource: { ...priorDust.source, digest: `sha256:${'9'.repeat(64)}` },
      planDigest: priorDust.source.planDigest,
    })),
    /does not match the plan/,
  );
});

test('refuses carried dust that has already been consumed by a different payout plan', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId: predecessorCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const dustAmount = usdg('3');
  await repository.recordPayoutDust(predecessorCycleId, { amount: dustAmount, planDigest: `sha256:${'2'.repeat(64)}` });
  await completeCycleFully(repository, predecessorCycleId);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const priorDust = await repository.readPayoutDust(cycleId, { chainId: dustAmount.chainId, assetId: dustAmount.assetId, decimals: dustAmount.decimals });
  // Consumed under one plan digest; a request reconstructed for a genuinely different plan (a
  // different digest) must never reuse that consumption -- only the exact same restart may.
  await repository.consumePayoutDust(cycleId, { source: priorDust.source, amount: dustAmount, planDigest: `sha256:${'5'.repeat(64)}` });

  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(
    () => reader(baseRequest(cycleId, {
      returnEvidence: evidence,
      previousDust: dustAmount,
      previousDustSource: priorDust.source,
      planDigest: `sha256:${'6'.repeat(64)}`,
    })),
    /bound to a different payout plan digest/,
  );
});

test('accepts the exact same-cycle consume-only dust restart bound to the current plan digest, then the atomic initializer repairs it without a second consumption', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId: predecessorCycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const dustAmount = usdg('3');
  await repository.recordPayoutDust(predecessorCycleId, { amount: dustAmount, planDigest: `sha256:${'2'.repeat(64)}` });
  await completeCycleFully(repository, predecessorCycleId);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const evidence = zeroProceedsEvidence(cycleId);
  await completeReturnStage(repository, cycleId, evidence);
  const priorDust = await repository.readPayoutDust(cycleId, { chainId: dustAmount.chainId, assetId: dustAmount.assetId, decimals: dustAmount.decimals });
  const currentPlanDigest = `sha256:${'7'.repeat(64)}`;

  // An older process committed just the dust consumption before it recorded payout state -- the
  // durable two-commit crash window `consumePayoutDustAndRecordStageAttempt`'s docstring names.
  assert.equal(await repository.readStageAttempt(cycleId, 'payout'), null);
  await repository.consumePayoutDust(cycleId, { source: priorDust.source, amount: dustAmount, planDigest: currentPlanDigest });

  // Genuine repository-restart proof, not a same-process mock: reopen the durable store as a fresh
  // instance (a real process restart would only ever see the journal, not the in-memory object
  // above) and drive both the reader and the repair through that reopened instance.
  const reopened = await CycleRepository.open(directory);
  assert.equal(await reopened.readStageAttempt(cycleId, 'payout'), null);

  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: reopened,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: 1_000_000n }),
  });
  const result = await reader(baseRequest(cycleId, {
    returnEvidence: evidence,
    previousDust: dustAmount,
    previousDustSource: priorDust.source,
    planDigest: currentPlanDigest,
  }));
  assert.deepEqual(result, dustAmount);

  // The same atomic initializer production uses repairs the orphaned consumption into full payout
  // state without reusing (and so without re-authorizing) the dust source a second time.
  const repaired = await reopened.consumePayoutDustAndPersistPagedPayoutState(cycleId, {
    source: priorDust.source,
    amount: dustAmount,
    planDigest: currentPlanDigest,
    stage: 'payout',
    evidence: { schema: 'hookemon.test-paged-payout-state.v1', planDigest: currentPlanDigest, cycleId, recipients: [] },
  });
  assert.equal(repaired.evidence.planDigest, currentPlanDigest);
  const attempt = await reopened.readStageAttempt(cycleId, 'payout');
  assert.equal(attempt.planDigest, currentPlanDigest);
  const consumptionsAfterRepair = await reopened.readPayoutDustConsumption(cycleId, {
    chainId: dustAmount.chainId, assetId: dustAmount.assetId, decimals: dustAmount.decimals,
  });
  assert.equal(consumptionsAfterRepair.planDigest, currentPlanDigest);
});

test('refuses construction when the cycle repository is missing readStageAttempt', () => {
  assert.throws(
    () => createCycleAttributableFinalizedAvailableReader({
      cycleRepository: { async readStage() { return null; }, async describeCycle() { return null; } },
      publicClient: fakePublicClient(),
      archiveClient: fakeArchiveClient(),
    }),
    /readStage, describeCycle, and readStageAttempt is required/,
  );
});

test('refuses a request whose previous dust and previous dust source disagree on zero vs nonzero provenance', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const reader = createCycleAttributableFinalizedAvailableReader({
    cycleRepository: repository,
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  const request = baseRequest(cycleId, { returnEvidence: zeroProceedsEvidence(cycleId) });
  request.previousDustSource = { cycleId: 'cycle-x', digest: `sha256:${'3'.repeat(64)}`, planDigest: `sha256:${'4'.repeat(64)}` };
  await assert.rejects(() => reader(request), /previous dust provenance is inconsistent/);
});
