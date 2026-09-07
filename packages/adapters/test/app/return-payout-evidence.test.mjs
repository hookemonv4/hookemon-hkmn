import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRelayClient, RELAY_CONSTANTS } from '../../src/relay-client.mjs';
import { createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { reconcileLiveReturn } from '../../src/app/stages/return.mjs';
import { preparePayoutRequest } from '../../src/app/stages/payout.mjs';
import { createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';

// This file proves the return -> payout evidence seam end to end: the exact object
// `reconcileLiveReturn` durably produces for a SETTLED return leg is fed, unmodified, into the
// real `preparePayoutRequest`. It must carry a positive credit sourced from the leg's observed
// `netDeltaAtomic` (never the Relay quote), be byte-identical between the first observed
// settlement and a later replay, and refuse when recipient, cycle, asset, or finality identity
// does not genuinely check out.
//
// Note on "distinct from the quote": the validated settlement contract (money-schemas.mjs
// `assertReturnLegAttribution` plus cycle-repository.mjs `returnRelayTerminalState`) requires
// `intent.quotedDestinationAmount === leg.destinationAmountAtomic === observedAmountAtomic` for a
// leg to ever reach SETTLED -- a genuinely SETTLED leg's credit is therefore always numerically
// equal to its quote today. The test below proves the correction by field provenance instead: the
// evidence's `destinationCreditAmount` is asserted equal to the leg's own `netDeltaAtomic` (the
// repository-derived observed amount), never independently re-derived from the quote.

const EVM_ACCOUNT = '0x000000000000000000000000000000000000dEaD';
const SOLANA_ACCOUNT = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = RELAY_CONSTANTS.USDG_ADDRESS;
const EVM_CHAIN_ID = String(RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID);
const SOLANA_CHAIN_ID = String(RELAY_CONSTANTS.SOLANA_CHAIN_ID);
const CANONICAL_CHAIN_ID = `eip155:${EVM_CHAIN_ID}`;
const CANONICAL_ASSET_ID = `${CANONICAL_CHAIN_ID}/erc20:${TOKEN}`;
const CANONICAL_KEY = `${CANONICAL_CHAIN_ID}\0${CANONICAL_ASSET_ID}`;
const PAYOUT_RECIPIENT_A = `0x${'2'.repeat(40)}`;
const PAYOUT_RECIPIENT_B = `0x${'3'.repeat(40)}`;

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-return-payout-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function testConfig() {
  const usdg = { chainId: EVM_CHAIN_ID, assetId: TOKEN, decimals: 6 };
  const solanaStablecoin = { chainId: SOLANA_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 };
  return {
    chainId: 4663,
    accounts: { evm: EVM_ACCOUNT, solana: SOLANA_ACCOUNT },
    contracts: { usdg: TOKEN },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v1',
      assets: { usdg, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdg, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnUsdg: { ...usdg, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: EVM_CHAIN_ID, assetId: 'native', decimals: 18, amountAtomic: '100' },
        nativeReserve: { chainId: EVM_CHAIN_ID, assetId: 'native', decimals: 18, amountAtomic: '1000' },
      },
      solana: {
        priorityFeeCap: { chainId: SOLANA_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
        lamportReserve: { chainId: SOLANA_CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '1000' },
      },
    },
  };
}

function returnIntent({ relayRequestId, quotedDestinationAmount }) {
  return {
    schema: 'hookemon.relay-intent.v1',
    requestId: relayRequestId,
    orderId: `0x${'9'.repeat(64)}`,
    direction: 'RETURN',
    tradeType: 'EXACT_INPUT',
    quoteDigest: `sha256:${'7'.repeat(64)}`,
    originChainId: Number(SOLANA_CHAIN_ID),
    destinationChainId: Number(EVM_CHAIN_ID),
    originAssetId: SOLANA_MINT,
    originDecimals: 6,
    destinationAssetId: TOKEN,
    destinationDecimals: 6,
    originAmount: '17',
    quotedDestinationAmount,
    quotedDestinationMinimumAmount: quotedDestinationAmount,
    sender: SOLANA_ACCOUNT,
    recipient: EVM_ACCOUNT,
    deadlineUnixSeconds: 1800000000,
  };
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function returnSourceFinalityClient({ owner, amountAtomic }) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.method, 'getTransaction');
      return response({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          slot: 52,
          blockTime: 1_700_000_080,
          transaction: {
            message: { accountKeys: [{ pubkey: owner, signer: false, writable: true }], instructions: [] },
          },
          meta: {
            err: null,
            preTokenBalances: [{
              accountIndex: 0,
              mint: SOLANA_MINT,
              owner,
              uiTokenAmount: { amount: amountAtomic, decimals: 6, uiAmountString: '0' },
            }],
            postTokenBalances: [{
              accountIndex: 0,
              mint: SOLANA_MINT,
              owner,
              uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' },
            }],
          },
        },
      });
    },
  });
}

function terminalReturnPointerClient({ intent, destinationTxHash }) {
  return createRelayClient({
    fetchImpl: async (url, options) => {
      if (options.method === 'GET' && url.pathname === '/intents/status/v3') {
        return response({
          status: 'success',
          originChainId: intent.originChainId,
          destinationChainId: intent.destinationChainId,
          inTxHashes: ['return-source-signature'],
          txHashes: [destinationTxHash],
        });
      }
      throw new Error(`unexpected Relay reconciliation request ${options.method} ${url.pathname}`);
    },
  });
}

function returnDestinationReceiptClient({
  transactionHash,
  observedToken = TOKEN,
  observedRecipient = EVM_ACCOUNT,
  observedAmountAtomic,
  timestampUnixSeconds = '1700000100',
}) {
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
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(observedRecipient)],
          data: `0x${BigInt(observedAmountAtomic).toString(16).padStart(64, '0')}`,
          logIndex: 0n,
        }],
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized') return { number: 101n, hash: finalizedBlockHash, timestamp: BigInt(timestampUnixSeconds) };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, timestamp: BigInt(timestampUnixSeconds) };
      throw new Error(`unexpected return receipt block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

/**
 * Seeds a RECORDED return leg through the real CycleRepository, exactly as production's
 * `mutateReturn` would durably leave it after signing and broadcast -- so the settlement this
 * fixture drives afterward is proven by the same repository invariants production relies on.
 * `destinationAmountAtomic` must equal `quotedDestinationAmount` here: money-schemas.mjs's
 * `assertReturnLegAttribution` refuses to durably record a leg whose destination amount diverges
 * from its own bound intent quote, so the validated settlement contract never allows the two to
 * differ for a leg that can reach SETTLED (see the file-level note above).
 */
async function seededReturnFixture(t, { destinationAmountAtomic = '20' } = {}) {
  const quotedDestinationAmount = destinationAmountAtomic;
  const directory = await tempDirectory(t);
  const cycleRepository = await CycleRepository.open(directory);
  const { cycleId } = await cycleRepository.createCycle({ releaseAmount: '1', mode: 'production' });
  const relayRequestId = `relay-return-payout-evidence-${cycleId}`;
  const intent = returnIntent({ relayRequestId, quotedDestinationAmount });
  await cycleRepository.recordReturnRelayLegExpectation(cycleId, {
    schema: 'hookemon.relay-leg.v1',
    cycleId,
    direction: 'return',
    relayRequestId,
    quoteDigest: `sha256:${'9'.repeat(64)}`,
    sourceChainId: SOLANA_CHAIN_ID,
    sourceTxHash: null,
    sourceAssetId: SOLANA_MINT,
    sourceDecimals: 6,
    sourceAmountAtomic: '17',
    destinationChainId: EVM_CHAIN_ID,
    destinationTxHash: null,
    destinationAssetId: TOKEN,
    destinationDecimals: 6,
    destinationAmountAtomic,
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent,
      requestCreatedAtUnixSeconds: '1700000000',
      maxSettlementWindowSeconds: '600',
    },
  }, {
    schema: 'hookemon.custody-ledger.v2',
    cycleId,
    chainId: CANONICAL_CHAIN_ID,
    assetId: CANONICAL_ASSET_ID,
    decimals: 6,
    claimed: '0', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0',
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
    verifiedCurrentBalance: {
      schema: 'hookemon.custody-balance-observation.v1',
      account: EVM_ACCOUNT.toLowerCase(),
      balance: { chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: '0' },
      finality: { height: '1', hash: `0x${'a'.repeat(64)}`, timestampUnixSeconds: '1700000000' },
    },
    expectedCycleAsset: { chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: destinationAmountAtomic },
  });
  const sourceTxHash = `return-source-${cycleId}`;
  await cycleRepository.recordRelayLegSource(cycleId, relayRequestId, sourceTxHash);
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  await cycleRepository.prepareChainTransactionAttempt(cycleId, 'return', {
    schema: 'hookemon.chain-transaction-attempt.v1',
    cycleId,
    stage: 'return',
    state: 'PREPARED',
    requestDigest,
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
  });
  await cycleRepository.recordSignedTransaction(cycleId, 'return', requestDigest, {
    rawBytes: 'return-signed-bytes',
    nonce: null,
    blockhash: 'return-blockhash',
    hash: `sha256:${'6'.repeat(64)}`,
  });
  await cycleRepository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: sourceTxHash });
  const context = { cycleId, fencingToken: '22222222-2222-4222-8222-222222222222' };
  await cycleRepository.reserveWalletNonce(cycleId, {
    chainId: SOLANA_CHAIN_ID,
    wallet: SOLANA_ACCOUNT,
    stage: 'return',
    fencingToken: context.fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  return { directory, cycleId, context, intent };
}

async function reconcileSeededReturn(fixture, { transactionHash, observedAmountAtomic }) {
  const cycleRepository = await CycleRepository.open(fixture.directory);
  return reconcileLiveReturn({
    adapters: {
      solana: { client: returnSourceFinalityClient({ owner: SOLANA_ACCOUNT, amountAtomic: '17' }) },
      relay: terminalReturnPointerClient({ intent: fixture.intent, destinationTxHash: transactionHash }),
      robinhood: { client: returnDestinationReceiptClient({ transactionHash, observedAmountAtomic }) },
    },
    config: testConfig(),
    cycleRepository,
    context: fixture.context,
  });
}

function payoutManifest(cycleId) {
  const entries = [
    { recipient: PAYOUT_RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '2' } },
    { recipient: PAYOUT_RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
  ];
  const total = entries.reduce((sum, entry) => sum + BigInt(entry.hkmnBalance.amountAtomic), 0n).toString();
  const estimatedNativeFee = (BigInt(entries.length) * 250_000n).toString();
  const requiredNativeAmount = (BigInt(estimatedNativeFee) + 10n).toString();
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: total },
    entries,
    exclusions: [],
    feasibility: {
      recipientCount: entries.length,
      transactionCount: entries.length,
      maxRecipientCount: entries.length,
      maxTransactionCount: entries.length,
      measuredTransferGas: '50000',
      maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: estimatedNativeFee },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: entries.length },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
  };
}

function payoutCycleRepositoryFor(cycleId, returnEvidence) {
  const manifest = payoutManifest(cycleId);
  return {
    async readStage(readCycleId, stage) {
      assert.equal(readCycleId, cycleId);
      if (stage === 'eligibility-snapshot') return { status: 'COMPLETE', evidence: manifest };
      if (stage === 'return') return { status: 'COMPLETE', evidence: returnEvidence };
      throw new Error(`unexpected stage ${stage}`);
    },
    async readPayoutDust() { return createUsdgPayoutAmount({ assetId: TOKEN, amountAtomic: '0' }); },
  };
}

/**
 * A synthetic SETTLED return leg that satisfies the preserved canonical custody association
 * (ADR-0026) by construction, so each refusal test below isolates exactly one of the new payout
 * -evidence guards -- cycle identity, finality, or destination asset identity -- rather than
 * re-exercising the pre-existing custody-association check.
 */
function syntheticSettledReturnRepository(legPatch) {
  const leg = {
    relayRequestId: 'relay-return-payout-evidence-synthetic',
    direction: 'return',
    cycleId: 'cycle-return-payout-evidence-synthetic',
    state: 'SETTLED',
    sourceTxHash: 'return-source-payout-evidence-synthetic',
    destinationChainId: EVM_CHAIN_ID,
    destinationAssetId: TOKEN,
    destinationDecimals: 6,
    destinationAmountAtomic: '20',
    netDeltaAtomic: '20',
    finalizedAtSource: { hash: 'solana-finality-hash', height: '5', timestampUnixSeconds: '1700000000' },
    finalizedAtDestination: { hash: `0x${'d'.repeat(64)}`, height: '50', timestampUnixSeconds: '2000000000' },
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: { recipient: EVM_ACCOUNT },
    },
    ...legPatch,
  };
  const custodyLedgers = new Map([[CANONICAL_KEY, {
    schema: 'hookemon.custody-ledger.v2',
    chainId: CANONICAL_CHAIN_ID,
    assetId: CANONICAL_ASSET_ID,
    decimals: 6,
  }]]);
  const returnLegLedgerKeys = new Map([[leg.relayRequestId, CANONICAL_KEY]]);
  return {
    async describeCycle() {
      return { relayLegs: new Map([[leg.relayRequestId, leg]]), custodyLedgers, returnLegLedgerKeys, chainAttempts: new Map() };
    },
  };
}

test('fresh settlement and its replay produce identical finalized payout evidence with a positive credit sourced from the observed leg\'s netDeltaAtomic, and both bind real preparePayoutRequest to the same digest', async t => {
  const fixture = await seededReturnFixture(t, { destinationAmountAtomic: '20' });
  const transactionHash = `0x${'c'.repeat(64)}`;
  const fresh = await reconcileSeededReturn(fixture, { transactionHash, observedAmountAtomic: '20' });

  assert.equal(fresh.schema, 'hookemon.return-relay-settlement-evidence.v1');
  assert.equal(fresh.finalized, true);
  assert.equal(fresh.destinationCreditAmount, '20');
  // Field provenance: the credit is the leg's own repository-derived netDeltaAtomic, not an
  // independently re-derived value -- see the file-level note on why the two are equal here.
  assert.equal(fresh.destinationCreditAmount, fresh.relayLeg.netDeltaAtomic);
  assert.equal(fresh.destinationAccount.toLowerCase(), EVM_ACCOUNT.toLowerCase());
  assert.equal(fresh.destinationAsset.toLowerCase(), TOKEN);
  assert.equal(fresh.relayLeg.state, 'SETTLED');
  assert.equal(fresh.relayLeg.netDeltaAtomic, '20');

  const reopened = await CycleRepository.open(fixture.directory);
  const replay = await reconcileLiveReturn({
    adapters: null,
    config: testConfig(),
    cycleRepository: reopened,
    context: fixture.context,
  });
  assert.deepEqual(replay, fresh);

  const freshRequest = await preparePayoutRequest({
    config: testConfig(),
    cycleRepository: payoutCycleRepositoryFor(fixture.cycleId, fresh),
    context: { cycleId: fixture.cycleId },
  });
  const replayRequest = await preparePayoutRequest({
    config: testConfig(),
    cycleRepository: payoutCycleRepositoryFor(fixture.cycleId, replay),
    context: { cycleId: fixture.cycleId },
  });

  assert.deepEqual(freshRequest.plan.returnEvidence, replayRequest.plan.returnEvidence);
  assert.equal(freshRequest.plan.returnEvidence.evidenceDigest, canonicalDigest({
    schema: 'hookemon.direct-payout-finalized-return.v1',
    cycleId: fixture.cycleId,
    returnEvidence: fresh,
  }));
});

test('a genuine zero-proceeds return evidence still binds real preparePayoutRequest to a zero credit', async () => {
  const cycleId = 'cycle-return-payout-evidence-zero';
  const zeroEvidence = Object.freeze({
    schema: 'hookemon.return-zero-proceeds-evidence.v1',
    cycleId,
    finalized: true,
    noBridge: true,
    destinationAccount: EVM_ACCOUNT,
    destinationAsset: TOKEN,
    destinationCreditAmount: '0',
  });

  const request = await preparePayoutRequest({
    config: testConfig(),
    cycleRepository: payoutCycleRepositoryFor(cycleId, zeroEvidence),
    context: { cycleId },
  });

  assert.equal(request.plan.returnEvidence.evidenceDigest, canonicalDigest({
    schema: 'hookemon.direct-payout-finalized-return.v1',
    cycleId,
    returnEvidence: zeroEvidence,
  }));
});

test('reconcileLiveReturn refuses to bind payout evidence to a SETTLED leg attributed to a different recipient than the configured Operations account', async t => {
  const fixture = await seededReturnFixture(t, { destinationAmountAtomic: '16' });
  await reconcileSeededReturn(fixture, { transactionHash: `0x${'c'.repeat(64)}`, observedAmountAtomic: '16' });

  const reopened = await CycleRepository.open(fixture.directory);
  const wrongRecipientConfig = { ...testConfig(), accounts: { ...testConfig().accounts, evm: `0x${'4'.repeat(40)}` } };
  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config: wrongRecipientConfig, cycleRepository: reopened, context: fixture.context }),
    /return leg attributed recipient does not match the configured Operations EVM account/,
  );
});

test('reconcileLiveReturn refuses a SETTLED leg missing finalized source or destination evidence', async () => {
  const cycleRepository = syntheticSettledReturnRepository({ finalizedAtDestination: null });
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: null,
      config: testConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-return-payout-evidence-synthetic' },
    }),
    /return leg is missing finalized source or destination evidence/,
  );
});

test('reconcileLiveReturn refuses a SETTLED leg whose cycleId does not match the reconciling cycle', async () => {
  const cycleRepository = syntheticSettledReturnRepository({ cycleId: 'cycle-return-payout-evidence-other' });
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: null,
      config: testConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-return-payout-evidence-synthetic' },
    }),
    /return leg cycleId does not match the reconciling cycle/,
  );
});

test('reconcileLiveReturn refuses a SETTLED leg whose destination asset does not match the configured USDG identity', async () => {
  const cycleRepository = syntheticSettledReturnRepository({ destinationAssetId: `0x${'5'.repeat(40)}` });
  await assert.rejects(
    () => reconcileLiveReturn({
      adapters: null,
      config: testConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-return-payout-evidence-synthetic' },
    }),
    /return leg destination asset does not match the configured USDG identity/,
  );
});
