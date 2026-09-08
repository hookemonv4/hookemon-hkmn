import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, encodeEventTopics, keccak256, parseAbi, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createNativePaymentProof, createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { createRelayClient, createQuoteUsdValuation, readProcessQuoteUsdProvenance } from '../../src/relay-client.mjs';
import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { setup as nativeRelaySetup } from '../native/relay-native-proof-fixture.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CYCLE_REPOSITORY_CLIENT_INTERFACE,
  CycleRepository,
  createCycleRepositoryClient,
} from '../../src/app/cycle-repository.mjs';
import { HELD_POSITION_CANONICAL_V1_FIXTURE } from './fixtures/held-position-canonical-v1-d5bd6a3e.mjs';
import { readOutboundOriginRefundProof } from '../../src/app/stages/outbound.mjs';
import { readReturnLegDestinationProof } from '../../src/app/stages/return.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { ERC20_TRANSFER_TOPIC, readFinalizedErc20TransferProof } from '../../src/robinhood-rpc.mjs';
import { createSolanaRpcClient, readFinalizedRelayDestinationObservation } from '../../src/solana-rpc.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { canonicalJson, CycleJournal, digest } from '../../../runner/src/cycle/journal.mjs';
import { CUSTODY_LEDGER_BUCKETS, MAXIMUM_PACK_BATCH_SIZE, OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createDefaultOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { deriveCyclePolicyDigest } from '../../../runner/src/automation/policy-engine.mjs';

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
    heldPositions: '0',
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

// The recorded production Operations identity `assertDurableCycleAdmission` validates a stored
// admission against by default (operations: null resolves to it on both write and replay).
const ADMISSION_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const ADMISSION_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const ADMISSION_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ADMISSION_SETTLEMENT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function onchainCycleIdFor(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

async function parsedAdmissionRelayQuote({ requestId, orderId, amountAtomic, purchaseAtomic, deadlineUnixSeconds = 2_000_000_000 }) {
  const origin = { chainId: 4663, address: `0x${'0'.repeat(40)}`, decimals: 18, amount: amountAtomic };
  const destination = { chainId: 792703809, address: ADMISSION_SETTLEMENT_MINT, decimals: 6, amount: purchaseAtomic, minimumAmount: purchaseAtomic };
  const raw = {
    requestId,
    details: {
      sender: ADMISSION_EVM,
      recipient: ADMISSION_SOLANA,
      currencyIn: { currency: { chainId: origin.chainId, address: origin.address, decimals: origin.decimals }, amount: origin.amount, amountUsd: '2.000000' },
      currencyOut: { currency: { chainId: destination.chainId, address: destination.address, decimals: destination.decimals }, amount: destination.amount, minimumAmount: destination.minimumAmount },
    },
    protocol: { v2: { orderId, orderData: {
      inputs: [{ payment: { chainId: 'robinhood', currency: origin.address, amount: origin.amount }, refunds: [{ chainId: 'robinhood', currency: origin.address, recipient: ADMISSION_EVM, deadline: deadlineUnixSeconds }] }],
      output: { chainId: 'solana', deadline: deadlineUnixSeconds, calls: [], payments: [{ recipient: ADMISSION_SOLANA, currency: destination.address, expectedAmount: destination.amount, minimumAmount: destination.minimumAmount }] },
    } } },
    steps: [],
  };
  const nowMs = Math.min(deadlineUnixSeconds * 1000 - 1000, 2_000_000_001_000);
  const client = createRelayClient({ now: () => nowMs, quoteValidityMs: 60000,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }) });
  return client.quote({ direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', amount: purchaseAtomic,
    user: ADMISSION_EVM, recipient: ADMISSION_SOLANA, skipRouteCheck: true });
}

/** A finalized hook process-liability evidence record covering exactly `ceilingAtomic`. */
function admissionProcessLiabilityEvidence(cycleId, ceilingAtomic) {
  return {
    schema: 'hookemon.process-liability-evidence.v2',
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    hook: `0x${'7'.repeat(40)}`,
    cycleId,
    onchainCycleId: onchainCycleIdFor(cycleId),
    blockNumber: '12345',
    blockHash: `0x${'3'.repeat(64)}`,
    finalized: true,
    processLiability: ceilingAtomic,
    remainingProcessClaimCapacity: ceilingAtomic,
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: ceilingAtomic,
    totalLiability: ceilingAtomic,
    hookNativeBalance: ceilingAtomic,
    isSolvent: true,
    operations: ADMISSION_EVM,
    ceilingAtomic,
  };
}

/** A complete, self-consistent quantity-1 admission, carrying finalized process liability evidence. */
async function admissionWithEvidence(cycleId, {
  amountAtomic = '1000000', purchaseAtomic = '500000', salt = cycleId, unitOrderByte = '1', aggregateOrderByte = '2', deadlineUnixSeconds = 2_000_000_000,
} = {}) {
  const unitRelayQuote = await parsedAdmissionRelayQuote({ requestId: `req-unit-${salt}`, orderId: `0x${unitOrderByte.repeat(64)}`, amountAtomic, purchaseAtomic, deadlineUnixSeconds });
  const relayQuote = await parsedAdmissionRelayQuote({ requestId: `req-aggregate-${salt}`, orderId: `0x${aggregateOrderByte.repeat(64)}`, amountAtomic, purchaseAtomic, deadlineUnixSeconds });
  const asset = () => ({ chainId: '4663', assetId: 'native', decimals: 18 });
  const settlementAsset = (address) => ({ chainId: '792703809', assetId: address, decimals: 6 });
  return {
    schema: 'hookemon.policy-admission.v3',
    cycleId,
    packId: 'base-pack',
    quantity: 1,
    quoteDigest: relayQuote.quoteDigest,
    unitPurchase: { ...settlementAsset(ADMISSION_SETTLEMENT_MINT), amountAtomic: purchaseAtomic },
    aggregatePurchase: { ...settlementAsset(ADMISSION_SETTLEMENT_MINT), amountAtomic: purchaseAtomic },
    unitFundingQuote: { ...asset(ADMISSION_USDG), amountAtomic },
    aggregateFundingQuote: { ...asset(ADMISSION_USDG), amountAtomic },
    unitRelay: {
      tradeType: 'EXACT_OUTPUT', requestId: unitRelayQuote.requestId, orderId: unitRelayQuote.orderId,
      quoteDigest: unitRelayQuote.quoteDigest, deadlineUnixSeconds: unitRelayQuote.deadlineUnixSeconds,
      sender: ADMISSION_EVM, recipient: ADMISSION_SOLANA, destinationAmount: purchaseAtomic, destinationMinimumAmount: purchaseAtomic,
    },
    unitRelayQuote,
    relayQuote,
    relay: {
      tradeType: 'EXACT_OUTPUT', requestId: relayQuote.requestId, orderId: relayQuote.orderId,
      quoteDigest: relayQuote.quoteDigest, deadlineUnixSeconds: relayQuote.deadlineUnixSeconds,
      sender: ADMISSION_EVM, recipient: ADMISSION_SOLANA, destinationAmount: purchaseAtomic, destinationMinimumAmount: purchaseAtomic,
    },
    unitFundingUsd: createQuoteUsdValuation({ quote: unitRelayQuote, side: 'origin', amount: { ...asset(), amountAtomic }, rounding: 'up', nowMs: Math.min(deadlineUnixSeconds * 1000 - 1000, 2_000_000_001_000) }),
    aggregateFundingUsd: createQuoteUsdValuation({ quote: relayQuote, side: 'origin', amount: { ...asset(), amountAtomic }, rounding: 'up', nowMs: Math.min(deadlineUnixSeconds * 1000 - 1000, 2_000_000_001_000) }),
    processLiabilityEvidence: admissionProcessLiabilityEvidence(cycleId, amountAtomic),
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

const nativeReturnTransports = new Map();
async function nativeReturnLeg(cycleId) {
  const transport = await nativeRelaySetup({ sourceTimestamp: 1700000010, seed: createHash('sha256').update(cycleId).digest() });
  const leg = returnRelayLeg(cycleId, { schema: 'hookemon.relay-leg.v2', sourceAmountAtomic: transport.expected.sourceAmountAtomic,
    destinationAssetId: 'native', destinationDecimals: 18 });
  Object.assign(leg.returnAttribution.intent, { orderId: transport.expected.orderId, sender: transport.expected.sourceOwner,
    recipient: transport.expected.recipient, originAmount: leg.sourceAmountAtomic,
    destinationAssetId: 'native', destinationDecimals: 18 });
  const intent = leg.returnAttribution.intent, zero = `0x${'00'.repeat(20)}`;
  const raw = { requestId: leg.relayRequestId, details: { sender: intent.sender, recipient: intent.recipient,
    currencyIn: { currency: { chainId: 792703809, address: leg.sourceAssetId, decimals: 6 }, amount: leg.sourceAmountAtomic, amountUsd: '25' },
    currencyOut: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: leg.destinationAmountAtomic, minimumAmount: leg.destinationAmountAtomic, amountUsd: '20.0000009' } },
    protocol: { v2: { orderId: intent.orderId, orderData: { inputs: [{ payment: { chainId: 'solana', currency: leg.sourceAssetId, amount: leg.sourceAmountAtomic },
      refunds: [{ chainId: 'solana', currency: leg.sourceAssetId, recipient: intent.sender, deadline: 2_000_000_000 }] }],
      output: { chainId: 'robinhood', deadline: 2_000_000_000, calls: [], payments: [{ recipient: intent.recipient, currency: zero, expectedAmount: leg.destinationAmountAtomic, minimumAmount: leg.destinationAmountAtomic }] } } } }, steps: [] };
  const client = createRelayClient({ now: () => 1_700_000_000_000, quoteValidityMs: 600000,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }) });
  const quote = await client.quoteReturnBridge({ user: intent.sender, recipient: intent.recipient, amount: leg.sourceAmountAtomic, skipRouteCheck: true });
  const destinationUsd = createQuoteUsdValuation({ quote, side: 'destination', amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: leg.destinationAmountAtomic }, rounding: 'down', nowMs: 1_700_000_000_000 });
  leg.quoteDigest = quote.quoteDigest;
  leg.returnAttribution = { ...leg.returnAttribution, schema: 'hookemon.return-leg-attribution-context.v2',
    intent: client.prepareExecution({ quote, liveMode: true }).intent, destinationUsd,
    destinationUsdEvidence: { ...readProcessQuoteUsdProvenance(destinationUsd), quote } };
  transport.destinationUsd = destinationUsd;
  nativeReturnTransports.set(leg.relayRequestId, transport);
  return leg;
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
  if (leg.schema === 'hookemon.relay-leg.v2') {
    const transport = nativeReturnTransports.get(leg.relayRequestId);
    const transactionHash = options.destinationTxHash ?? transport.expected.transactionHash;
    const receipt = structuredClone(transport.receipt);
    receipt.transactionHash = transactionHash;
    receipt.logs[0].transactionHash = transactionHash;
    receipt.logs[0].data = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
      [transport.route.emitter, options.observedRecipient ?? transport.expected.recipient,
        options.observedToken ?? `0x${'00'.repeat(20)}`, BigInt(options.observedAmountAtomic ?? leg.destinationAmountAtomic), transport.expected.orderId]);
    const client = { ...transport.client, getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: receipt.blockNumber, hash: receipt.blockHash, timestamp: BigInt(options.destinationTimestampUnixSeconds ?? '1700000011') }) };
    return readReturnLegDestinationProof({ client, pointer: { schema: 'hookemon.relay-terminal-destination-pointer.v1',
      relayRequestId: leg.relayRequestId, status: 'SUCCESS', destinationTxHash: transactionHash },
      leg, sourceProof: transport.sourceProof, nativePaymentBinding: transport.binding });
  }
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
    rawBytes: nativeReturnTransports.get(leg.relayRequestId)?.encoded ?? 'return-signed-bytes', nonce: null, blockhash: 'return-blockhash', hash: `sha256:${'6'.repeat(64)}`,
  });
  await repository.recordBroadcast(cycleId, 'return', requestDigest, { transactionHash: sourceTxHash });
  await repository.recordFinality(cycleId, 'return', requestDigest, {
    transactionHash: sourceTxHash,
    debitedAmountAtomic: leg.sourceAmountAtomic,
    finalizedAtSource: nativeReturnTransports.get(leg.relayRequestId)?.sourceProof.finality ?? { height: '52', hash: 'return-source-slot', timestampUnixSeconds: '1700000010' },
  });
  return requestDigest;
}

async function finalizedReturnFixture(t, {
  proof = {},
} = {}) {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordRelayLeg(cycleId, await nativeReturnLeg(cycleId));
  const sourceTxHash = nativeReturnTransports.get(recorded.relayRequestId).sourceProof.transactionHash;
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

/** ADR-0026: the canonical CAIP identity a caller (`return.mjs`, in production) resolves for the
 * EVM USDG row -- deliberately never equal to a Relay leg's own raw `(numeric chain id string,
 * lowercase address)` destination pair, so tests exercise the same raw/canonical distinction the
 * repository itself must never conflate. */
function canonicalEvmUsdgIdentity(leg) {
  return {
    chainId: `eip155:${leg.destinationChainId}`,
    assetId: leg.destinationAssetId === 'native' ? `eip155:${leg.destinationChainId}/native` : `eip155:${leg.destinationChainId}/erc20:${leg.destinationAssetId.toLowerCase()}`,
    decimals: leg.destinationDecimals,
  };
}

function expectationLedgerFor(leg, cycleId, identity = canonicalEvmUsdgIdentity(leg)) {
  return {
    schema: 'hookemon.custody-ledger.v2',
    cycleId,
    chainId: identity.chainId,
    assetId: identity.assetId,
    decimals: identity.decimals,
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
    heldPositions: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
    verifiedCurrentBalance: null,
    expectedCycleAsset: {
      chainId: identity.chainId,
      assetId: identity.assetId,
      decimals: identity.decimals,
      amountAtomic: leg.destinationAmountAtomic,
    },
  };
}

function canonicalReturnLedgerRow(state, leg) {
  const identity = canonicalEvmUsdgIdentity(leg);
  return [...state.custodyLedgers.values()]
    .find(candidate => candidate.chainId === identity.chainId && candidate.assetId === identity.assetId);
}

/** Same shape as `finalizedReturnFixture`, but the return leg is recorded through the ADR-0026
 * atomic `recordReturnRelayLegExpectation` primitive, so its v2 custody ledger row already carries
 * a populated `expectedCycleAsset` before settlement. */
async function finalizedReturnExpectationFixture(t, {
  proof = {},
} = {}) {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const leg = await nativeReturnLeg(cycleId);
  const recorded = await repository.recordReturnRelayLegExpectation(cycleId, leg, expectationLedgerFor(leg, cycleId), { destinationUsd: nativeReturnTransports.get(leg.relayRequestId).destinationUsd });
  const sourceTxHash = nativeReturnTransports.get(leg.relayRequestId).sourceProof.transactionHash;
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

test('historical return legs remain readable and cannot issue native settlement proofs', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const leg = await repository.recordRelayLeg(cycleId, returnRelayLeg(cycleId));
  await assert.rejects(returnDestinationProof(leg), /historical token legs/);
  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readRelayLeg(cycleId, leg.relayRequestId), leg);
});

test('settleRelayLeg rejects a syntactically valid but unbranded return destination proof', async t => {
  const fixture = await finalizedReturnFixture(t);
  const unbrandedSubmission = {
    returnDestinationProof: structuredClone(fixture.submission.returnDestinationProof),
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
    // Settlement identity the canonical Relay intent carries: which trade type was quoted and the
    // digest of the quote it came from, so a resumed intent can be tied back to its admission.
    tradeType: 'EXACT_OUTPUT',
    quoteDigest: `sha256:${'d'.repeat(64)}`,
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
  { relayRoute = outboundRelayRoute(), signedBytes = '0x1234', relayIntent = outboundRelayIntent(leg, deadlineUnixSeconds) } = {},
) {
  const requestDigest = `sha256:${'e'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'outbound', preparedChainAttempt(cycleId, 'outbound', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'outbound', requestDigest, {
    rawBytes: signedBytes, nonce: '7', blockhash: null, hash: transactionHash,
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
    relayIntent,
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

const SUPPLEMENTARY_USDG = '0x0000000000000000000000000000000000000001';
const SUPPLEMENTARY_OPERATIONS = '0x0000000000000000000000000000000000000002';

function supplementaryReturnBoundary(position, settlement, {
  amountAtomic = '9',
  finalityEvidence = { transactionHash: `0x${'a'.repeat(64)}`, finalized: true },
} = {}) {
  return {
    schema: 'hookemon.supplementary-return-boundary.v1',
    positionId: position.positionId,
    cycleId: position.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturnEvidence: {
      schema: 'hookemon.supplementary-finalized-return.v1',
      positionId: position.positionId,
      cycleId: position.cycleId,
      manifestId: settlement.manifestId,
      operations: SUPPLEMENTARY_OPERATIONS,
      usdgAddress: SUPPLEMENTARY_USDG,
      amountAtomic,
      finalityEvidence,
    },
  };
}

function supplementaryPayoutSource(position, settlement, returnBoundary, {
  previousDust = {
    chainId: 4663,
    assetId: SUPPLEMENTARY_USDG,
    decimals: 6,
    amountAtomic: '0',
  },
  previousDustSource = null,
} = {}) {
  const finalizedReturnEvidence = returnBoundary.finalizedReturnEvidence;
  return {
    schema: 'hookemon.supplementary-payout-source.v1',
    positionId: position.positionId,
    cycleId: position.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn: {
      chainId: 4663,
      assetId: SUPPLEMENTARY_USDG,
      decimals: 6,
      amountAtomic: finalizedReturnEvidence.amountAtomic,
    },
    previousDust: {
      chainId: 4663,
      assetId: previousDust.assetId.toLowerCase(),
      decimals: previousDust.decimals,
      amountAtomic: previousDust.amountAtomic,
    },
    previousDustSource,
    returnBinding: {
      operations: SUPPLEMENTARY_OPERATIONS,
      usdgAddress: SUPPLEMENTARY_USDG,
      evidenceDigest: digest({
        schema: 'hookemon.supplementary-finalized-return-binding.v1',
        positionId: position.positionId,
        cycleId: position.cycleId,
        manifestId: settlement.manifestId,
        finalizedReturnEvidence,
      }),
    },
  };
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

test('holdCycle persists terminalAtMs from the repository clock', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.holdCycle(cycleId, 'HELD_DATA_UNVERIFIED', { reason: 'test' });
  assert.equal((await repository.describeCycle(cycleId)).terminalAtMs, 1_700_000_000_000);
});

test('completeCycle persists terminalAtMs from the repository clock', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  assert.equal((await repository.describeCycle(cycleId)).terminalAtMs, 1_700_000_000_000);
});

test('a legacy cycle-terminal event stored without terminalAtMs reads back null rather than a fabricated time', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose('cycle-terminal', { terminalState: 'HELD_UNAVAILABLE', evidence: {} });
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);
  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_000);
  assert.equal((await reopened.describeCycle(cycleId)).terminalAtMs, null);
});

test('peekActiveCycle skips a completed crash-recovery record without changing it', async t => {
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
  assert.equal(await reopened.peekActiveCycle(), null);
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

test('createCycle persists finalized process liability evidence and replay reproduces the same admission and policy digest', async t => {
  const directory = await tempDirectory(t);
  const cycleId = 'cycle-admission-evidence-roundtrip';
  const admission = await nativeProducedAdmissionFixture(cycleId, { amountWei: '1000000', costMicroUsd: '2000000', nowMs: Date.now() });
  const configuration = createDefaultOperatorConfiguration();
  const expectedDigest = deriveCyclePolicyDigest({
    configuration, cycleId, releaseCostMicroUsd: admission.aggregateFundingUsd.amountMicroUsd, releaseAmountWei: admission.aggregateFundingQuote.amountAtomic,
    packId: admission.packId, liveMode: true, mode: 'production', admission,
  });

  const before = await CycleRepository.open(directory, Date.now, { testAuthority: createTestProfileMutationAuthority() });
  const created = await before.createCycle({
    releaseAmount: admission.aggregateFundingQuote.amountAtomic, mode: 'production', cycleId, admission,
  });
  assert.deepEqual(created.admission.processLiabilityEvidence, admission.processLiabilityEvidence);

  const after = await CycleRepository.open(directory, Date.now, { testAuthority: createTestProfileMutationAuthority() });
  const active = await after.readActiveCycle();
  assert.deepEqual(active.admission, created.admission);
  const replayedDigest = deriveCyclePolicyDigest({
    configuration, cycleId, releaseCostMicroUsd: active.admission.aggregateFundingUsd.amountMicroUsd, releaseAmountWei: active.admission.aggregateFundingQuote.amountAtomic,
    packId: active.admission.packId, liveMode: true, mode: 'production', admission: active.admission,
  });
  assert.equal(replayedDigest, expectedDigest, 'replayed evidence must still determine the same policy digest');
  assert.equal((await after.describeCycle(cycleId)).admission.processLiabilityEvidence.ceilingAtomic, admission.processLiabilityEvidence.ceilingAtomic);
});

test('createCycle refuses a quote-bound production admission missing process liability evidence', async t => {
  const directory = await tempDirectory(t);
  const cycleId = 'cycle-missing-evidence-create';
  const admission = await nativeProducedAdmissionFixture(cycleId, { amountWei: '1000000', costMicroUsd: '2000000', nowMs: Date.now() });
  delete admission.processLiabilityEvidence;
  const repository = await CycleRepository.open(directory);
  await assert.rejects(
    () => repository.createCycle({
      releaseAmount: admission.aggregateFundingQuote.amountAtomic, mode: 'production', cycleId, admission,
    }),
    /processLiabilityEvidence is required/,
  );
});

test('reopening a stored production cycle-opened record without process liability evidence refuses replay', async t => {
  const directory = await tempDirectory(t);
  const cycleId = 'cycle-legacy-evidence-free';
  // Bootstrap the store's directory structure and identity exactly as CycleRepository.open() would
  // for a fresh state directory, then write the active-cycle file directly: this simulates a record
  // written before evidence was required (a legitimate createCycle() call can no longer produce one).
  await CycleRepository.open(directory);

  const admission = await nativeProducedAdmissionFixture(cycleId, { amountWei: '1000000', costMicroUsd: '2000000', nowMs: Date.now() });
  delete admission.processLiabilityEvidence;
  const payload = {
    releaseAmount: admission.aggregateFundingQuote.amountAtomic,
    mode: 'production',
    providerMode: 'live',
    admission,
    openedAtMs: 1_000,
  };
  const unsigned = { cycleId, index: 0, kind: 'cycle-opened', payload, previousDigest: null };
  const entry = { ...unsigned, digest: digest(unsigned) };
  const cycle = { cycleId, version: 1, journalHead: entry.digest, entries: [entry] };
  const fileValue = { schema: 'hookemon.durable-cycle-store.active-cycle.v1', cycle };
  const filePath = join(directory, 'active', `${encodeURIComponent(cycleId)}.json`);
  await writeFile(filePath, `${canonicalJson(fileValue)}\n`, { encoding: 'utf8', mode: 0o600 });

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(() => reopened.readActiveCycle(), /processLiabilityEvidence is required/);
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

function oversizedEligibilitySnapshotEvidence(overrides = {}) {
  return {
    entries: Array.from({ length: 200 }, (_, index) => ({ holder: `holder-${index}`, amount: `${index}` })),
    ...overrides,
  };
}

test('completeStage pages oversized evidence to durable storage and readStage transparently resolves it', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  const evidence = oversizedEligibilitySnapshotEvidence();

  await repository.completeStage(cycleId, 'eligibility-snapshot', evidence);
  assert.deepEqual(await repository.readStage(cycleId, 'eligibility-snapshot'), { status: 'COMPLETE', evidence });

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readStage(cycleId, 'eligibility-snapshot'), { status: 'COMPLETE', evidence }, 'survives a repository restart');
});

test('completeStage retried with identical oversized evidence is idempotent and reuses the durable blob', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  const evidence = oversizedEligibilitySnapshotEvidence();

  await repository.completeStage(cycleId, 'eligibility-snapshot', evidence);
  await repository.completeStage(cycleId, 'eligibility-snapshot', evidence); // no throw
  assert.deepEqual(await repository.readStage(cycleId, 'eligibility-snapshot'), { status: 'COMPLETE', evidence });
});

test('completeStage rejects a retry with different oversized evidence for the same stage', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', oversizedEligibilitySnapshotEvidence());
  await assert.rejects(
    () => repository.completeStage(cycleId, 'eligibility-snapshot', oversizedEligibilitySnapshotEvidence({ note: 'different' })),
    /already completed with different evidence/,
  );
});

test('readStage hard-fails when paged evidence is referenced but missing from durable storage', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', oversizedEligibilitySnapshotEvidence());

  await rm(join(directory, 'stage-evidence'), { recursive: true, force: true });

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(
    () => reopened.readStage(cycleId, 'eligibility-snapshot'),
    /durable cycle store stage evidence is missing/,
  );
});

test('readStage hard-fails when a paged evidence blob no longer matches its durable reference digest', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', oversizedEligibilitySnapshotEvidence());

  const stageDirectory = join(directory, 'stage-evidence', encodeURIComponent(cycleId), encodeURIComponent('eligibility-snapshot'));
  const manifest = JSON.parse(await readFile(join(stageDirectory, 'manifest.json'), 'utf8'));
  const generationDirectory = join(stageDirectory, manifest.generation);
  const firstPageFile = join(generationDirectory, '0000.json');
  const page = JSON.parse(await readFile(firstPageFile, 'utf8'));
  page.entries = page.entries.slice().reverse();
  await writeFile(firstPageFile, `${JSON.stringify(page)}\n`);

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(
    () => reopened.readStage(cycleId, 'eligibility-snapshot'),
    /page digest does not match its manifest|does not match its durable reference digest/,
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

test('records a held position without terminally holding its cycle', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');

  const recorded = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsd: '25000000',
    valueMicroUsd: '25000000',
    insuredValue: {
      chainId: '792703809',
      assetId: SETTLEMENT_SOLANA_MINT,
      decimals: 6,
      amountAtomic: '50000000',
    },
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });

  assert.match(recorded.positionId, /^held:[0-9a-f]{64}$/);
  assert.equal(recorded.cycleId, cycleId);
  assert.equal(recorded.openedAtMs, 1_700_000_000_000);
  const current = await repository.describeCycle(cycleId);
  assert.equal(current.terminalState, null);
  assert.deepEqual([...current.heldPositions.values()], [recorded]);
  assert.equal(current.custodyLedgers.size, 0, 'a card purchase cost is not fungible native principal');
  assert.deepEqual(await repository.readHeldPosition(recorded.positionId), recorded);
  assert.deepEqual(await repository.listHeldPositions(), [recorded]);

  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  assert.equal((await repository.describeCycle(cycleId)).terminalState, 'COMPLETED');
  assert.deepEqual(await repository.listHeldPositions(), [recorded]);
});

test('reuses a held position after restart timing changes without duplicating its frozen purchase cost', async t => {
  let nowMs = 1_700_000_000_000;
  const repository = await CycleRepository.open(await tempDirectory(t), () => nowMs, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const input = {
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsd: '25000000',
    valueMicroUsd: '25000000',
    insuredValue: null,
    reason: 'BUYBACK_UNAVAILABLE',
    terminalState: 'HELD_UNAVAILABLE',
    evidence: { stage: 'buyback', reason: 'unavailable' },
  };
  const first = await repository.recordHeldPosition(cycleId, input);
  nowMs += 60_000;
  const retry = await repository.recordHeldPosition(cycleId, input);

  assert.deepEqual(retry, first);
  const state = await repository.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.equal(state.custodyLedgers.size, 0, 'retry does not create native principal from USD purchase cost');
});

async function nativeSupplementaryBoundary(repository, position, settlement) {
  const leg = await nativeReturnLeg(`${position.cycleId}-supplementary`);
  const transport = nativeReturnTransports.get(leg.relayRequestId);
  leg.sourceTxHash = transport.sourceProof.transactionHash;
  const proof = await returnDestinationProof(leg);
  const asset = { chainId: '4663', assetId: 'native', decimals: 18 };
  const stage = `supplementary-${digest({ schema: 'hookemon.supplementary-return-stage.v1', positionId: position.positionId }).slice(7, 55)}`;
  await repository.persistPagedPayoutState(position.cycleId, stage, {
    schema: 'hookemon.supplementary-return-attempt.v2', cycleId: position.cycleId, positionId: position.positionId, manifestId: settlement.manifestId,
    recipients: [], rawSignedBytes: transport.encoded, relayRequestId: leg.relayRequestId, intent: leg.returnAttribution.intent,
    destinationAmount: { ...asset, amountAtomic: leg.destinationAmountAtomic }, destinationUsd: transport.destinationUsd,
    destinationUsdEvidence: leg.returnAttribution.destinationUsdEvidence,
  });
  return { schema: 'hookemon.supplementary-return-boundary.v2', positionId: position.positionId, cycleId: position.cycleId, manifestId: settlement.manifestId,
    finalizedReturnEvidence: { schema: 'hookemon.supplementary-finalized-return.v2', positionId: position.positionId, cycleId: position.cycleId, manifestId: settlement.manifestId,
      operations: transport.expected.recipient, assetId: 'native', amountAtomic: leg.destinationAmountAtomic, finalityEvidence: proof } };
}

async function createNativeHeldCycle(repository, costMicroUsd, packId) {
  const cycleId = repository.nextCycleId();
  const admission = await nativeProducedAdmissionFixture(cycleId, { costMicroUsd });
  admission.packId = packId;
  return repository.createCycle({ cycleId, releaseAmount: '42', mode: 'production', admission });
}

test('all held cards complete a cycle with zero main settlement', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsd: '25000000',
    valueMicroUsd: '25000000',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });

  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);

  const completed = await repository.describeCycle(cycleId);
  assert.equal(completed.terminalState, 'COMPLETED');
  assert.deepEqual([...completed.heldPositions.values()], [position]);
  assert.equal(position.costMicroUsd, '25000000');
  assert.equal(completed.custodyLedgers.size, 0, 'held USD purchase cost creates no native principal or main settlement');
});

test('records a position-bound held owner decision without terminally holding the cycle', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsd: '25000000',
    valueMicroUsd: '25000000',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  const decision = {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'position-decision-1',
    expectedRevision: 0,
    choice: 'keep-holding',
  };

  const recorded = await repository.recordHeldOwnerDecision(position.positionId, decision);
  assert.deepEqual(recorded, { positionId: position.positionId, ...decision });
  const updated = await repository.readHeldPosition(position.positionId);
  assert.equal(updated.positionRevision, 1);
  assert.deepEqual(updated.ownerDecision, recorded);
  assert.equal((await repository.describeCycle(cycleId)).terminalState, null);
  assert.deepEqual(await repository.recordHeldOwnerDecision(position.positionId, decision), recorded);
  await assert.rejects(
    () => repository.recordHeldOwnerDecision(position.positionId, { ...decision, choice: 'sell' }),
    /requestId conflict/,
  );
});

test('starts a supplementary settlement for a held position after its main cycle completes', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-supplementary',
    mint: 'mint-supplementary',
    cardRef: 'mint-supplementary',
    costMicroUsd: '25000000',
    valueMicroUsd: '25000000',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);

  const decision = await repository.recordHeldOwnerDecision(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'position-supplementary-sell',
    expectedRevision: 0,
    choice: 'sell',
  });

  assert.equal(decision.choice, 'sell');
  const settlement = await repository.readSupplementarySettlement(position.positionId);
  assert.deepEqual(settlement, {
    positionId: position.positionId,
    cycleId,
    manifestId: `${cycleId}:supplementary:1`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
    eligibilitySnapshotEvidenceDigest: digest({ stage: 'eligibility-snapshot', finalized: true }),
    payoutSourceDigest: null,
  });
  assert.equal((await repository.describeCycle(cycleId)).terminalState, 'COMPLETED');
  const next = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  assert.notEqual(next.cycleId, cycleId);
});

async function preparedSupplementarySettlement(repository, cycleId) {
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-supplementary',
    mint: 'mint-supplementary',
    cardRef: 'mint-supplementary',
    costMicroUsd: '25000000',
    valueMicroUsd: '25000000',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  await repository.recordHeldOwnerDecision(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'position-supplementary-sell',
    expectedRevision: 0,
    choice: 'sell',
  });
  return position.positionId;
}

function supplementaryChainAttempt(positionId, overrides = {}) {
  return {
    schema: 'hookemon.supplementary-chain-attempt.v1',
    positionId,
    requestDigest: `sha256:${'7'.repeat(64)}`,
    state: 'PREPARED',
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
    ...overrides,
  };
}

test('prepares, signs, and broadcasts a position-scoped supplementary chain attempt without colliding with the main cycle stage', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const positionId = await preparedSupplementarySettlement(repository, cycleId);
  const requestDigest = `sha256:${'7'.repeat(64)}`;

  const prepared = await repository.prepareSupplementaryChainTransactionAttempt(positionId, supplementaryChainAttempt(positionId));
  assert.deepEqual(prepared, { attempt: supplementaryChainAttempt(positionId), broadcastEvidence: null });
  // Idempotent retry with identical evidence.
  assert.deepEqual(await repository.prepareSupplementaryChainTransactionAttempt(positionId, supplementaryChainAttempt(positionId)), prepared);

  const signed = await repository.recordSupplementarySignedTransaction(positionId, requestDigest, {
    rawBytes: 'RAW', nonce: '1', blockhash: null, hash: `hash:${'a'.repeat(64)}`,
  });
  assert.equal(signed.attempt.state, 'SIGNED');
  assert.deepEqual(
    await repository.recordSupplementarySignedTransaction(positionId, requestDigest, { rawBytes: 'RAW', nonce: '1', blockhash: null, hash: `hash:${'a'.repeat(64)}` }),
    signed,
  );

  const broadcast = await repository.recordSupplementaryBroadcast(positionId, requestDigest, { schema: 'hookemon.chain-observation.v1', observed: true });
  assert.equal(broadcast.attempt.state, 'BROADCAST');
  assert.deepEqual(broadcast.broadcastEvidence, { schema: 'hookemon.chain-observation.v1', observed: true });

  assert.deepEqual(await repository.readSupplementaryChainTransactionAttempt(positionId, requestDigest), broadcast);
  // Ordinary per-cycle chain attempts remain untouched: nothing was ever written under the
  // 'buyback'/'return' stage keyspace for this cycleId.
  assert.equal(await repository.readChainTransactionAttempt(cycleId, 'buyback', requestDigest), null);
});

test('recordSupplementarySignedTransaction refuses to re-sign an already-broadcast attempt', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const positionId = await preparedSupplementarySettlement(repository, cycleId);
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  await repository.prepareSupplementaryChainTransactionAttempt(positionId, supplementaryChainAttempt(positionId));
  await repository.recordSupplementarySignedTransaction(positionId, requestDigest, { rawBytes: 'RAW', nonce: '1', blockhash: null, hash: `hash:${'a'.repeat(64)}` });
  await repository.recordSupplementaryBroadcast(positionId, requestDigest, { schema: 'hookemon.chain-observation.v1', observed: true });
  await assert.rejects(
    () => repository.recordSupplementarySignedTransaction(positionId, requestDigest, { rawBytes: 'RAW2', nonce: '2', blockhash: null, hash: `hash:${'b'.repeat(64)}` }),
    /already broadcast and cannot be re-signed/,
  );
});

test('supplementary chain attempt recovery context binds to the exact signed-bytes hash and rejects a conflicting retry', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const positionId = await preparedSupplementarySettlement(repository, cycleId);
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  const rawSignedBytesHash = `hash:${'a'.repeat(64)}`;
  await repository.prepareSupplementaryChainTransactionAttempt(positionId, supplementaryChainAttempt(positionId));
  await repository.recordSupplementarySignedTransaction(positionId, requestDigest, { rawBytes: 'RAW', nonce: '1', blockhash: null, hash: rawSignedBytesHash });

  await assert.rejects(
    () => repository.persistSupplementaryChainAttemptRecoveryContext(positionId, {
      positionId, requestDigest, rawSignedBytesHash: `hash:${'f'.repeat(64)}`, context: { approvalRef: 'x' },
    }),
    /does not bind signed bytes/,
  );

  const persisted = await repository.persistSupplementaryChainAttemptRecoveryContext(positionId, {
    positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'x' },
  });
  assert.deepEqual(persisted, { positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'x' } });
  assert.deepEqual(await repository.readSupplementaryChainAttemptRecoveryContext(positionId, requestDigest), persisted);
  // Idempotent identical retry.
  assert.deepEqual(
    await repository.persistSupplementaryChainAttemptRecoveryContext(positionId, { positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'x' } }),
    persisted,
  );
  await assert.rejects(
    () => repository.persistSupplementaryChainAttemptRecoveryContext(positionId, { positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'different' } }),
    /conflicts with prior context/,
  );
});

test('atomically persists supplementary signed bytes and recovery context across restart', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '25000000', 'pack-1');
  const positionId = await preparedSupplementarySettlement(repository, cycleId);
  const requestDigest = `sha256:${'7'.repeat(64)}`;
  const rawSignedBytesHash = `hash:${'a'.repeat(64)}`;
  await repository.prepareSupplementaryChainTransactionAttempt(positionId, supplementaryChainAttempt(positionId));

  await repository.recordSupplementarySignedTransactionWithRecoveryContext(positionId, requestDigest, {
    rawBytes: 'RAW', nonce: '1', blockhash: null, hash: rawSignedBytesHash,
  }, {
    positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'durable' },
  });

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_001);
  assert.equal((await reopened.readSupplementaryChainTransactionAttempt(positionId, requestDigest)).attempt.state, 'SIGNED');
  assert.deepEqual(await reopened.readSupplementaryChainAttemptRecoveryContext(positionId, requestDigest), {
    positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'durable' },
  });
  await assert.rejects(
    () => reopened.recordSupplementarySignedTransactionWithRecoveryContext(positionId, requestDigest, {
      rawBytes: 'RAW', nonce: '1', blockhash: null, hash: rawSignedBytesHash,
    }, { positionId, requestDigest, rawSignedBytesHash, context: { approvalRef: 'different' } }),
    /different signing material or recovery context/,
  );
});

test('persists the completed eligibility evidence and zero-dust return source for a sell settlement across restart', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const snapshotEvidence = {
    schema: 'fixture.eligibility-snapshot.v1',
    cycleId,
    snapshot: 'original',
  };
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', snapshotEvidence);
  for (const stage of OPERATIONAL_CYCLE_STAGES.slice(1)) {
    await repository.prepareStage(cycleId, stage);
    await repository.completeStage(cycleId, stage, { stage, finalized: true });
  }
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-supplementary-source',
    mint: 'mint-supplementary-source',
    cardRef: 'mint-supplementary-source',
    costMicroUsdg: '25',
    valueMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  await repository.recordPayoutDust(cycleId, {
    amount: {
      chainId: '4663',
      assetId: SUPPLEMENTARY_USDG,
      decimals: 6,
      amountAtomic: '1',
    },
    planDigest: digest({ schema: 'fixture.normal-payout-plan.v1', cycleId }),
  });
  await repository.completeCycle(cycleId);
  await repository.recordHeldOwnerDecision(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'position-supplementary-source',
    expectedRevision: 0,
    choice: 'sell',
  });
  const prepared = await repository.readSupplementarySettlement(position.positionId);
  assert.equal(prepared.eligibilitySnapshotEvidenceDigest, digest(snapshotEvidence));
  assert.equal(prepared.payoutSourceDigest, null);

  const returnBoundary = supplementaryReturnBoundary(position, prepared);
  const expectedPayoutSource = supplementaryPayoutSource(position, prepared, returnBoundary);
  await repository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'PREPARED',
    nextState: 'BUYBACK_SENT_UNKNOWN',
    evidence: { requestDigest: `sha256:${'b'.repeat(64)}` },
  });
  await assert.rejects(
    () => repository.advanceSupplementarySettlement(position.positionId, {
      expectedState: 'BUYBACK_SENT_UNKNOWN',
      nextState: 'RETURN_BROADCAST',
      evidence: returnBoundary,
      payoutSource: expectedPayoutSource,
    }),
    /exact schema/i,
  );
  await repository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'BUYBACK_SENT_UNKNOWN',
    nextState: 'RETURN_BROADCAST',
    evidence: returnBoundary,
  });

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_001);
  const recovered = await reopened.readSupplementarySettlement(position.positionId);
  assert.equal(recovered.eligibilitySnapshotEvidenceDigest, digest(snapshotEvidence));
  assert.equal(recovered.payoutSourceDigest, digest(expectedPayoutSource));
  const recoveredBoundary = await reopened.readSupplementarySettlementEvidence(position.positionId);
  assert.deepEqual(recoveredBoundary.payoutSource, expectedPayoutSource);
  assert.equal(recoveredBoundary.payoutSource.previousDust.amountAtomic, '0');
  assert.equal(recoveredBoundary.payoutSource.previousDustSource, null);
  assert.deepEqual(recoveredBoundary.evidence, returnBoundary);
  await assert.doesNotReject(() => reopened.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'BUYBACK_SENT_UNKNOWN',
    nextState: 'RETURN_BROADCAST',
    evidence: returnBoundary,
  }));
  await assert.rejects(
    () => reopened.advanceSupplementarySettlement(position.positionId, {
      expectedState: 'BUYBACK_SENT_UNKNOWN',
      nextState: 'RETURN_BROADCAST',
      evidence: supplementaryReturnBoundary(position, prepared, { amountAtomic: '8' }),
    }),
    /boundary evidence conflicts/i,
  );
});

test('does not reuse normal dust after a newer cycle consumes it', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-supplementary-consumed-dust',
    mint: 'mint-supplementary-consumed-dust',
    cardRef: 'mint-supplementary-consumed-dust',
    costMicroUsdg: '25',
    valueMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  const normalDust = await repository.recordPayoutDust(cycleId, {
    amount: {
      chainId: '4663',
      assetId: SUPPLEMENTARY_USDG,
      decimals: 6,
      amountAtomic: '1',
    },
    planDigest: digest({ schema: 'fixture.normal-payout-plan.v1', cycleId }),
  });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);

  const newer = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  await repository.consumePayoutDust(newer.cycleId, {
    source: normalDust.source,
    amount: normalDust.amount,
    planDigest: digest({ schema: 'fixture.newer-main-payout-plan.v1', cycleId: newer.cycleId }),
  });
  await repository.recordHeldOwnerDecision(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'position-supplementary-consumed-dust',
    expectedRevision: 0,
    choice: 'sell',
  });
  const settlement = await repository.readSupplementarySettlement(position.positionId);
  await repository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'PREPARED',
    nextState: 'BUYBACK_SENT_UNKNOWN',
    evidence: { requestDigest: `sha256:${'c'.repeat(64)}` },
  });
  await repository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'BUYBACK_SENT_UNKNOWN',
    nextState: 'RETURN_BROADCAST',
    evidence: supplementaryReturnBoundary(position, settlement),
  });

  const returnBoundary = await repository.readSupplementarySettlementEvidence(position.positionId);
  assert.equal(returnBoundary.payoutSource.previousDust.amountAtomic, '0');
  assert.equal(returnBoundary.payoutSource.previousDustSource, null);
});

test('peekActiveCycle skips a resolved completed cycle while a newer cycle is active', async t => {
  let nowMs = 1_700_000_000_000;
  const repository = await CycleRepository.open(await tempDirectory(t), () => nowMs);
  const older = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(older.cycleId, {
    packId: 'pack-1',
    memo: 'memo-resolved-peek',
    mint: 'mint-resolved-peek',
    cardRef: 'mint-resolved-peek',
    costMicroUsdg: '25',
    valueMicroUsdg: '25',
    insuredValue: null,
    reason: 'SENT_UNKNOWN_DEADLINE',
    terminalState: 'HELD_UNRESOLVED',
    evidence: { stage: 'buyback', status: 'sent-unknown' },
  });
  await completeOperationalStages(repository, older.cycleId);
  await repository.completeCycle(older.cycleId);
  nowMs += 1;
  const newer = await repository.createCycle({ releaseAmount: '2', mode: 'production' });
  await repository.resolveHeldPosition(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    expectedRevision: 0,
    terminalState: 'NEVER_SENT',
    evidence: { source: 'collector-status', status: 'not-found' },
  });

  assert.deepEqual(await repository.peekActiveCycle(), {
    cycleId: newer.cycleId,
    releaseAmount: '2',
  });
});

test('persists every supplementary settlement boundary across a restart without replacing the manifest', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-supplementary-restart',
    mint: 'mint-supplementary-restart',
    cardRef: 'mint-supplementary-restart',
    costMicroUsdg: '25000000',
    valueMicroUsdg: '25000000',
    ledgerAsset: { chainId: '4663', assetId: 'asset-usdg', decimals: 6 },
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  await repository.recordHeldOwnerDecision(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'position-supplementary-restart',
    expectedRevision: 0,
    choice: 'sell',
  });
  const prepared = await repository.readSupplementarySettlement(position.positionId);
  const returnBoundaryInput = supplementaryReturnBoundary(position, prepared, {
    finalityEvidence: { transactionHash: 'return-broadcast-1', finalizedBuyback: true },
  });

  await repository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'PREPARED',
    nextState: 'BUYBACK_SENT_UNKNOWN',
    evidence: { requestDigest: `sha256:${'1'.repeat(64)}`, attempt: 'persisted-before-provider' },
  });
  await repository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'BUYBACK_SENT_UNKNOWN',
    nextState: 'RETURN_BROADCAST',
    evidence: returnBoundaryInput,
  });

  const returnBoundary = await repository.readSupplementarySettlementEvidence(position.positionId);
  assert.equal(returnBoundary.state, 'RETURN_BROADCAST');
  assert.match(returnBoundary.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(returnBoundary.evidence, returnBoundaryInput);
  assert.equal(returnBoundary.payoutSource.previousDust.amountAtomic, '0');
  assert.equal(returnBoundary.payoutSource.previousDustSource, null);

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_001);
  const broadcast = await reopened.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'RETURN_BROADCAST',
    nextState: 'PAYOUT_BROADCAST',
    evidence: { manifestId: `${cycleId}:supplementary:1`, transactionHash: 'payout-broadcast-1' },
  });
  assert.equal(broadcast.manifestId, `${cycleId}:supplementary:1`);
  assert.deepEqual(
    (await reopened.readSupplementarySettlementEvidence(position.positionId)).returnBoundary,
    returnBoundary,
  );
  const complete = await reopened.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'PAYOUT_BROADCAST',
    nextState: 'COMPLETE',
    evidence: { manifestId: `${cycleId}:supplementary:1`, finalizedRecipients: 2 },
  });
  assert.equal(complete.state, 'COMPLETE');
  assert.deepEqual(await reopened.readSupplementarySettlement(position.positionId), complete);
});

test('closes a resolved held position after a completed cycle without retaining its limit value', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-resolve',
    mint: 'mint-resolve',
    cardRef: 'mint-resolve',
    costMicroUsdg: '17',
    valueMicroUsdg: '17',
    ledgerAsset: { chainId: '4663', assetId: 'asset-usdg', decimals: 6 },
    insuredValue: null,
    reason: 'SENT_UNKNOWN_DEADLINE',
    terminalState: 'HELD_UNRESOLVED',
    evidence: { stage: 'buyback', status: 'sent-unknown' },
  });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);

  const resolved = await repository.resolveHeldPosition(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    expectedRevision: 0,
    terminalState: 'NEVER_SENT',
    evidence: { source: 'collector-status', status: 'not-found' },
  });

  assert.equal(resolved.resolution.terminalState, 'NEVER_SENT');
  assert.deepEqual(await repository.listHeldPositions(), []);
  assert.deepEqual(await repository.readClaimPreconditions(), {
    heldAssets: false,
    unattributed: false,
    unresolvedObligations: false,
    heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
  });
  const state = await repository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.get('4663\u0000asset-usdg').heldPositions, '0');
  assert.deepEqual(await repository.listHeldPositions({ includeResolved: true }), [resolved]);
});

test('resolves a deadline-held position as sold, refunded, or never sent only on its attributable path', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  const { cycleId } = await createNativeHeldCycle(repository, '17', 'pack-1');
  const createPosition = async (suffix, reason = 'SENT_UNKNOWN_DEADLINE') => repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: `memo-resolution-${suffix}`,
    mint: `mint-resolution-${suffix}`,
    cardRef: `mint-resolution-${suffix}`,
    costMicroUsd: '17',
    valueMicroUsd: '17',
    insuredValue: null,
    reason,
    terminalState: 'HELD_UNRESOLVED',
    evidence: { stage: 'buyback', status: 'sent-unknown', suffix },
  });
  const sold = await createPosition('sold');
  const refunded = await createPosition('refunded');
  const neverSent = await createPosition('never-sent');
  const asset = { chainId: '4663', assetId: 'native', decimals: 18 };
  await repository.recordCustodyLedger(cycleId, { schema: 'hookemon.custody-ledger.v3', cycleId: cycleId, ...asset,
    ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, '0'])), expectedCycleAsset: null, verifiedCurrentBalance: null,
    gasReserve: { ...asset, amountAtomic: '200' }, gasSpent: { ...asset, amountAtomic: '0' }, gasPayments: [] });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);
  await repository.recordHeldOwnerDecision(sold.positionId, {
    heldEvidenceDigest: sold.evidenceDigest,
    requestId: 'position-resolution-sold',
    expectedRevision: 0,
    choice: 'sell',
  });
  const soldSettlement = await repository.readSupplementarySettlement(sold.positionId);
  await assert.rejects(
    () => repository.resolveHeldPosition(sold.positionId, {
      heldEvidenceDigest: sold.evidenceDigest,
      expectedRevision: 1,
      terminalState: 'SOLD',
      evidence: { source: 'collector-status', status: 'sold' },
    }),
    /supplementary settlement.*complete/i,
  );
  for (const [expectedState, nextState] of [
    ['PREPARED', 'BUYBACK_SENT_UNKNOWN'],
    ['BUYBACK_SENT_UNKNOWN', 'RETURN_BROADCAST'],
    ['RETURN_BROADCAST', 'PAYOUT_BROADCAST'],
    ['PAYOUT_BROADCAST', 'COMPLETE'],
  ]) {
    await repository.advanceSupplementarySettlement(sold.positionId, {
      expectedState,
      nextState,
      evidence: nextState === 'RETURN_BROADCAST'
        ? await nativeSupplementaryBoundary(repository, sold, soldSettlement)
        : { expectedState, nextState },
    });
  }

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_001, { testAuthority: createTestProfileMutationAuthority() });
  const outcomes = [];
  outcomes.push(await reopened.resolveHeldPosition(sold.positionId, {
      heldEvidenceDigest: sold.evidenceDigest,
      expectedRevision: 1,
      terminalState: 'SOLD',
      evidence: { source: 'collector-status', status: 'sold' },
    }));
  outcomes.push(await reopened.resolveHeldPosition(refunded.positionId, {
      heldEvidenceDigest: refunded.evidenceDigest,
      expectedRevision: 0,
      terminalState: 'REFUNDED',
      evidence: { source: 'collector-status', status: 'refunded' },
    }));
  outcomes.push(await reopened.resolveHeldPosition(neverSent.positionId, {
      heldEvidenceDigest: neverSent.evidenceDigest,
      expectedRevision: 0,
      terminalState: 'NEVER_SENT',
      evidence: { source: 'collector-status', status: 'not-found' },
    }));
  assert.deepEqual(outcomes.map(position => position.resolution.terminalState).sort(), ['NEVER_SENT', 'REFUNDED', 'SOLD']);
  assert.deepEqual(await reopened.listHeldPositions(), []);
});

test('projects open held positions from completed cycles as bounded claim exposure', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, {
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsdg: '25000000',
    valueMicroUsdg: '25000000',
    insuredValue: null,
    reason: 'BUYBACK_UNAVAILABLE',
    terminalState: 'HELD_UNAVAILABLE',
    evidence: { stage: 'buyback', reason: 'unavailable' },
  });
  await completeOperationalStages(repository, cycleId);
  await repository.completeCycle(cycleId);

  assert.deepEqual(await repository.readClaimPreconditions(), {
    heldAssets: false,
    unattributed: false,
    unresolvedObligations: false,
    heldPositions: {
      count: 1,
      valueMicroUsdg: '25000000',
      positions: [position],
    },
  });
});

test('keeps interleaved held positions and attributed proceeds in their original cycles', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });

  const first = await createNativeHeldCycle(repository, '11', 'pack-first');
  const firstPosition = await repository.recordHeldPosition(first.cycleId, {
    packId: 'pack-first',
    memo: 'memo-first',
    mint: 'mint-first',
    cardRef: 'mint-first',
    costMicroUsd: '11',
    valueMicroUsd: '11',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  await repository.recordCustodyLedger(first.cycleId, custodyLedger(first.cycleId, {
    buybackProceeds: '17',
    heldPositions: '0',
  }));
  await completeOperationalStages(repository, first.cycleId);
  await repository.completeCycle(first.cycleId);

  const second = await createNativeHeldCycle(repository, '19', 'pack-second');
  const secondPosition = await repository.recordHeldPosition(second.cycleId, {
    packId: 'pack-second',
    memo: 'memo-second',
    mint: 'mint-second',
    cardRef: 'mint-second',
    costMicroUsd: '19',
    valueMicroUsd: '19',
    insuredValue: null,
    reason: 'BUYBACK_UNAVAILABLE',
    terminalState: 'HELD_UNAVAILABLE',
    evidence: { stage: 'buyback', reason: 'unavailable' },
  });
  await repository.recordCustodyLedger(second.cycleId, custodyLedger(second.cycleId, {
    buybackProceeds: '29',
    heldPositions: '0',
  }));
  await completeOperationalStages(repository, second.cycleId);
  await repository.completeCycle(second.cycleId);

  const firstState = await repository.describeCycle(first.cycleId);
  const secondState = await repository.describeCycle(second.cycleId);
  const ledgerKey = `eip155:4663\u0000eip155:4663/erc20:stablecoin`;
  assert.deepEqual([...firstState.heldPositions.values()], [firstPosition]);
  assert.deepEqual([...secondState.heldPositions.values()], [secondPosition]);
  assert.equal(firstState.custodyLedgers.get(ledgerKey).buybackProceeds, '17');
  assert.equal(secondState.custodyLedgers.get(ledgerKey).buybackProceeds, '29');
  assert.equal(firstState.custodyLedgers.get(ledgerKey).heldPositions, '0');
  assert.equal(secondState.custodyLedgers.get(ledgerKey).heldPositions, '0');
  assert.deepEqual(await repository.listHeldPositions({ cycleId: first.cycleId }), [firstPosition]);
  assert.deepEqual(await repository.listHeldPositions({ cycleId: second.cycleId }), [secondPosition]);
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

  const active = await repository.readActiveCycle();
  assert.equal(Number.isSafeInteger(active.terminalAtMs), true);
  assert.deepEqual(active, {
    cycleId,
    releaseAmount: '1',
    mode: 'production',
    terminalState: 'HELD_DATA_UNVERIFIED',
    terminalAtMs: active.terminalAtMs,
  });
  await assert.rejects(() => repository.completeCycle(cycleId), /terminally held/);
  await assert.rejects(() => repository.completeStage(cycleId, 'outbound', { transactionId: 'must-not-append' }), /terminally held/);
  assert.equal((await repository.describeCycle(cycleId)).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('retains a legacy whole-cycle owner hold across restart', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const heldEvidence = { stage: 'epic-gate', memo: 'memo-1', mint: 'mint-1', decision: 'hold' };
  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', heldEvidence);

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, 'HELD_OWNER_DECISION');
  assert.deepEqual(state.terminalEvidence, heldEvidence);
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
    heldPositions: '0',
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

function custodyLedgerV2(cycleId, overrides = {}) {
  return {
    ...custodyLedger(cycleId),
    schema: 'hookemon.custody-ledger.v2',
    verifiedCurrentBalance: null,
    expectedCycleAsset: null,
    ...overrides,
  };
}

function custodyBalanceObservation(ledger, overrides = {}) {
  return {
    schema: 'hookemon.custody-balance-observation.v1',
    account: '0x2222222222222222222222222222222222222222',
    balance: { chainId: ledger.chainId, assetId: ledger.assetId, decimals: ledger.decimals, amountAtomic: '12300000000' },
    finality: { height: '18000000', hash: `0x${'3'.repeat(64)}`, timestampUnixSeconds: '1780000000' },
    ...overrides,
  };
}

test('recordCustodyLedger refuses a v2-to-v1 downgrade for the same key', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const v2 = custodyLedgerV2(cycleId, { claimed: '1' });
  await repository.recordCustodyLedger(cycleId, v2);
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, { claimed: '1' })),
    /cannot downgrade/,
  );
  const state = await repository.describeCycle(cycleId);
  const row = [...state.custodyLedgers.values()][0];
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
});

test('recordCustodyLedger refuses erasing a previously recorded verifiedCurrentBalance', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const v2 = custodyLedgerV2(cycleId, { claimed: '1' });
  const observation = custodyBalanceObservation(v2);
  await repository.recordCustodyLedger(cycleId, { ...v2, verifiedCurrentBalance: observation });
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, { ...v2, verifiedCurrentBalance: null }),
    /erase/,
  );
});

test('recordCustodyLedger refuses a null verifiedCurrentBalance for a v2 write when the key already exists as v1', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, { claimed: '1' }));
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, { claimed: '1' })),
    /first-ever write/,
  );
});

test('recordCustodyLedger refuses repeating a null verifiedCurrentBalance once a key already carries a v2 row', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, { claimed: '1' }));
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, { claimed: '2' })),
    /first-ever write/,
  );
});

test('recordCustodyLedger cannot populate expectedCycleAsset without going through the dedicated return-leg expectation writer', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const leg = returnRelayLeg(cycleId);
  const ledger = expectationLedgerFor(leg, cycleId);
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, ledger),
    /expectedCycleAsset can only be populated or cleared/,
  );
});

test('recordCustodyLedger cannot change or erase an expectedCycleAsset once the dedicated return-leg expectation writer has populated it', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const leg = returnRelayLeg(cycleId);
  const ledger = expectationLedgerFor(leg, cycleId);
  await repository.recordReturnRelayLegExpectation(cycleId, leg, ledger);
  // A key already exists after the expectation write above, so every further generic write must
  // also carry a non-null verifiedCurrentBalance -- isolate the expectedCycleAsset check below from
  // that separate, already-covered invariant.
  const observation = custodyBalanceObservation(ledger);

  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, { ...ledger, verifiedCurrentBalance: observation, expectedCycleAsset: null }),
    /expectedCycleAsset can only be populated or cleared/,
  );
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, {
      ...ledger,
      verifiedCurrentBalance: observation,
      expectedCycleAsset: { ...ledger.expectedCycleAsset, amountAtomic: '1' },
    }),
    /expectedCycleAsset can only be populated or cleared/,
  );

  // Buckets (and a fresh observation) may still be updated as long as expectedCycleAsset is
  // carried forward unchanged.
  await repository.recordCustodyLedger(cycleId, { ...ledger, verifiedCurrentBalance: observation, claimed: '5' });
  const state = await repository.describeCycle(cycleId);
  const row = canonicalReturnLedgerRow(state, leg);
  assert.equal(row.claimed, '5');
  assert.deepEqual(row.expectedCycleAsset, ledger.expectedCycleAsset);
  assert.deepEqual(row.verifiedCurrentBalance, observation);
});

test('recordCustodyLedger enforces monotonic, non-rewriting finality for verifiedCurrentBalance', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const v2 = custodyLedgerV2(cycleId, { claimed: '1' });
  const observation = custodyBalanceObservation(v2);
  await repository.recordCustodyLedger(cycleId, { ...v2, verifiedCurrentBalance: observation });

  // A lower height is stale.
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, {
      ...v2,
      verifiedCurrentBalance: { ...observation, finality: { ...observation.finality, height: '17999999' } },
    }),
    /backward/,
  );

  // An equal height with a different hash, balance, account, or timestamp is conflicting evidence.
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, {
      ...v2,
      verifiedCurrentBalance: { ...observation, finality: { ...observation.finality, hash: `0x${'4'.repeat(64)}` } },
    }),
    /conflicts/,
  );
  await assert.rejects(
    () => repository.recordCustodyLedger(cycleId, {
      ...v2,
      verifiedCurrentBalance: { ...observation, balance: { ...observation.balance, amountAtomic: '1' } },
    }),
    /conflicts/,
  );

  // An exact, fully-identical replay is idempotent and succeeds.
  await repository.recordCustodyLedger(cycleId, { ...v2, verifiedCurrentBalance: observation });

  // A strictly greater height succeeds and replaces the observation.
  const advanced = { ...observation, finality: { ...observation.finality, height: '18000001' } };
  await repository.recordCustodyLedger(cycleId, { ...v2, verifiedCurrentBalance: advanced });
  const state = await repository.describeCycle(cycleId);
  const row = [...state.custodyLedgers.values()][0];
  assert.deepEqual(row.verifiedCurrentBalance, advanced);
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

// ADR-0026 required quarantine integration: direct payout only ever writes the canonical-v2 USDG
// row (chain 4663, six decimals, `eip155:4663`/`eip155:4663/erc20:<token>`), so reservePayoutQuarantine
// must resolve that same relation independently -- never a raw lookup alone, never a caller-trusted
// alias, and never silently across a mismatched chain or decimals.
const QUARANTINE_USDG_RAW_CHAIN_ID = '4663';
const QUARANTINE_USDG_DECIMALS = 6;

function quarantineRecipient(suffix) {
  return `0x${'0'.repeat(38)}${suffix}`;
}

function quarantineLedgerKey(chainId, assetId) {
  return `${chainId}\u0000${assetId}`;
}

test('reservePayoutQuarantine reserves against the canonical-v2 USDG row, rejects conflicting evidence, and replays after reopen', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const canonicalChainId = `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}`;
  const canonicalAssetId = `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}/erc20:${token}`;
  const canonicalKey = quarantineLedgerKey(canonicalChainId, canonicalAssetId);
  await repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, {
    chainId: canonicalChainId,
    assetId: canonicalAssetId,
    returnReceived: '100',
  }));
  const amount = { chainId: QUARANTINE_USDG_RAW_CHAIN_ID, assetId: token, decimals: QUARANTINE_USDG_DECIMALS, amountAtomic: '30' };
  const input = {
    planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'canonical-only' }),
    recipient: quarantineRecipient('c1'),
    amount,
    reason: 'USDG_FROZEN',
    evidence: { frozenAt: 'finalized' },
  };
  const reservation = await repository.reservePayoutQuarantine(cycleId, input);
  assert.equal(reservation.ledger.chainId, canonicalChainId);
  assert.equal(reservation.ledger.assetId, canonicalAssetId);
  const state = await repository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.get(canonicalKey).payoutLiability, '30');
  assert.equal(
    state.custodyLedgers.get(quarantineLedgerKey(QUARANTINE_USDG_RAW_CHAIN_ID, token)),
    undefined,
    'reserving must never manufacture a competing raw row',
  );

  assert.deepEqual(await repository.reservePayoutQuarantine(cycleId, input), reservation, 'an exact retry does not reserve the amount twice');
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, { ...input, amount: { ...amount, amountAtomic: '31' } }),
    /already has different evidence/,
  );

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readPayoutQuarantine(cycleId, input.planDigest, input.recipient), reservation);
  assert.equal((await reopened.describeCycle(cycleId)).custodyLedgers.get(canonicalKey).payoutLiability, '30');
});

test('reservePayoutQuarantine refuses when a raw and canonical USDG row coexist for the same asset', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const token = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, {
    chainId: QUARANTINE_USDG_RAW_CHAIN_ID,
    assetId: token,
    returnReceived: '100',
  }));
  await repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, {
    chainId: `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}`,
    assetId: `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}/erc20:${token}`,
    returnReceived: '100',
  }));
  const amount = { chainId: QUARANTINE_USDG_RAW_CHAIN_ID, assetId: token, decimals: QUARANTINE_USDG_DECIMALS, amountAtomic: '10' };
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, {
      planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'coexisting' }),
      recipient: quarantineRecipient('c2'),
      amount,
      reason: 'USDG_FROZEN',
      evidence: { frozenAt: 'finalized' },
    }),
    /raw and canonical custody ledgers coexist/,
  );
});

test('reservePayoutQuarantine still reserves against a legacy raw-identity USDG row when no canonical row exists, and replays under the raw rule', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const token = '0xcccccccccccccccccccccccccccccccccccccccc';
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, {
    chainId: QUARANTINE_USDG_RAW_CHAIN_ID,
    assetId: token,
    returnReceived: '100',
  }));
  const amount = { chainId: QUARANTINE_USDG_RAW_CHAIN_ID, assetId: token, decimals: QUARANTINE_USDG_DECIMALS, amountAtomic: '15' };
  const input = {
    planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'raw-only' }),
    recipient: quarantineRecipient('c3'),
    amount,
    reason: 'USDG_FROZEN',
    evidence: { frozenAt: 'finalized' },
  };
  const reservation = await repository.reservePayoutQuarantine(cycleId, input);
  assert.equal(reservation.ledger.chainId, QUARANTINE_USDG_RAW_CHAIN_ID);
  assert.equal(reservation.ledger.assetId, token);

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readPayoutQuarantine(cycleId, input.planDigest, input.recipient), reservation);
  assert.equal(
    (await reopened.describeCycle(cycleId)).custodyLedgers.get(quarantineLedgerKey(QUARANTINE_USDG_RAW_CHAIN_ID, token)).payoutLiability,
    '15',
  );
});

test('reservePayoutQuarantine refuses a backing shortfall against the canonical USDG row', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const token = '0xdddddddddddddddddddddddddddddddddddddddd';
  await repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, {
    chainId: `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}`,
    assetId: `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}/erc20:${token}`,
    returnReceived: '5',
  }));
  const amount = { chainId: QUARANTINE_USDG_RAW_CHAIN_ID, assetId: token, decimals: QUARANTINE_USDG_DECIMALS, amountAtomic: '6' };
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, {
      planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'shortfall' }),
      recipient: quarantineRecipient('c4'),
      amount,
      reason: 'USDG_FROZEN',
      evidence: { frozenAt: 'finalized' },
    }),
    /recorded returned custody cannot back this liability/,
  );
});

test('reservePayoutQuarantine never splices a mismatched chain or decimals onto the canonical USDG row', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const token = '0x111111111111111111111111111111111111111a';
  await repository.recordCustodyLedger(cycleId, custodyLedgerV2(cycleId, {
    chainId: `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}`,
    assetId: `eip155:${QUARANTINE_USDG_RAW_CHAIN_ID}/erc20:${token}`,
    returnReceived: '100',
  }));
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, {
      planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'wrong-decimals' }),
      recipient: quarantineRecipient('c5'),
      amount: { chainId: QUARANTINE_USDG_RAW_CHAIN_ID, assetId: token, decimals: 18, amountAtomic: '1' },
      reason: 'USDG_FROZEN',
      evidence: { frozenAt: 'finalized' },
    }),
    /matching custody ledger is required/,
  );
  await assert.rejects(
    () => repository.reservePayoutQuarantine(cycleId, {
      planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'wrong-chain' }),
      recipient: quarantineRecipient('c6'),
      amount: { chainId: '1', assetId: token, decimals: QUARANTINE_USDG_DECIMALS, amountAtomic: '1' },
      reason: 'USDG_FROZEN',
      evidence: { frozenAt: 'finalized' },
    }),
    /matching custody ledger is required/,
  );
});

test('reservePayoutQuarantine preserves every other custody bucket, verifiedCurrentBalance, and a populated expectedCycleAsset', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const leg = returnRelayLeg(cycleId);
  const expectationLedger = expectationLedgerFor(leg, cycleId);
  await repository.recordReturnRelayLegExpectation(cycleId, leg, expectationLedger);
  const funded = {
    ...expectationLedger,
    claimed: '40',
    heldAssets: '3',
    returnReceived: '100',
    verifiedCurrentBalance: custodyBalanceObservation(expectationLedger),
  };
  await repository.recordCustodyLedger(cycleId, funded);

  const amount = {
    chainId: leg.destinationChainId,
    assetId: leg.destinationAssetId,
    decimals: leg.destinationDecimals,
    amountAtomic: '30',
  };
  const reservation = await repository.reservePayoutQuarantine(cycleId, {
    planDigest: digest({ schema: 'test-payout-plan.v1', cycleId, case: 'preserve-buckets' }),
    recipient: quarantineRecipient('c7'),
    amount,
    reason: 'USDG_FROZEN',
    evidence: { frozenAt: 'finalized' },
  });
  assert.deepEqual(reservation.ledger, { ...funded, payoutLiability: '30' });
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
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`); // Public fixture key, isolated transport only.
  const sender = account.address.toLowerCase(), depository = SETTLEMENT_DEPOSITORY.toLowerCase();
  const orderId = `0x${'c'.repeat(64)}`, runtime = '0x6000';
  const recorded = await repository.recordRelayLeg(cycleId, relayLeg(cycleId, {
    schema: 'hookemon.relay-leg.v2', sourceAssetId: 'native', sourceDecimals: 18,
    destinationAssetId: SETTLEMENT_SOLANA_MINT,
  }));
  const data = encodeFunctionData({ abi: parseAbi(['function depositNative(address depositor, bytes32 id)']),
    functionName: 'depositNative', args: [sender, orderId] });
  const signedSourceTransaction = await account.signTransaction({ chainId: 4663, type: 'eip1559', nonce: 7,
    to: depository, data, value: BigInt(recorded.sourceAmountAtomic), gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const sourceTxHash = keccak256(signedSourceTransaction), sourceHash = `0x${'6'.repeat(64)}`;
  const sourceFinality = { height: '100', hash: sourceHash, timestampUnixSeconds: '1700000000' };
  const parsed = parseTransaction(signedSourceTransaction);
  const sourceClient = { getChainId: async () => 4663,
    getTransaction: async () => ({ ...parsed, hash: sourceTxHash, from: sender, blockNumber: 100n, blockHash: sourceHash }),
    getTransactionReceipt: async () => ({ transactionHash: sourceTxHash, blockNumber: 100n, blockHash: sourceHash,
      status: 'success', gasUsed: 21000n, effectiveGasPrice: 1n, logs: [] }),
    getBlock: async () => ({ number: 100n, hash: sourceHash, timestamp: 1700000000n }) };
  const sourceProof = await createNativePaymentProof({ client: sourceClient, signedTransaction: signedSourceTransaction,
    expected: { kind: 'direct', chainId: '4663', assetId: 'native', decimals: 18, transactionHash: sourceTxHash,
      source: sender, recipient: depository, amountWei: recorded.sourceAmountAtomic, calldataDigest: keccak256(data), nonce: '7' } });
  const requestDigest = await prepareOutboundRelaySettlementAttempt(repository, cycleId, sourceTxHash, '1700000200', recorded, {
    signedBytes: signedSourceTransaction, relayRoute: { sourceSender: sender, sourceRecipient: depository, destinationOwner: SETTLEMENT_SOLANA_OWNER },
    relayIntent: createRelayClient().prepareExecution({ liveMode: true, quote: {
      direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', requestId: recorded.relayRequestId,
      orderId, sender, recipient: SETTLEMENT_SOLANA_OWNER, deadlineUnixSeconds: 1700000200,
      origin: { chainId: 4663, address: `0x${'00'.repeat(20)}`, decimals: 18, amount: recorded.sourceAmountAtomic },
      destination: { chainId: 792703809, address: SETTLEMENT_SOLANA_MINT, decimals: 6,
        amount: recorded.destinationAmountAtomic, minimumAmount: recorded.destinationAmountAtomic },
      raw: { steps: [] },
    } }).intent,
  });
  await repository.recordRelayLegSource(cycleId, recorded.relayRequestId, sourceTxHash);
  await repository.recordBroadcast(cycleId, 'outbound', requestDigest, { transactionHash: sourceTxHash });
  await repository.recordFinality(cycleId, 'outbound', requestDigest, { transactionHash: sourceTxHash, finalizedAtSource: sourceFinality });
  const refundTxHash = `0x${'8'.repeat(64)}`, refundReceiptBlockHash = `0x${'9'.repeat(64)}`;
  const eventAbi = parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']);
  const refundClient = { getChainId: async () => 4663, getCode: async () => runtime,
    getTransactionReceipt: async () => ({ transactionHash: refundTxHash, blockNumber: 200n, blockHash: refundReceiptBlockHash, status: 'success',
      logs: [{ address: depository, transactionHash: refundTxHash, blockHash: refundReceiptBlockHash, blockNumber: 200n, logIndex: 0,
        topics: encodeEventTopics({ abi: eventAbi, eventName: 'FundsMovement' }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
          [depository, sender, `0x${'00'.repeat(20)}`, BigInt(recorded.sourceAmountAtomic), orderId]) }] }),
    getBlock: async () => ({ number: 200n, hash: refundReceiptBlockHash, timestamp: 1700000100n }) };
  const nativePaymentBinding = createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663',
    relay: { schema: 'hookemon.relay-native-route.v1', emitter: depository, runtimeHash: keccak256(runtime), metadataEncoding: 'order-id', refundsSupported: true } }, createTestProfileMutationAuthority());
  const refundProof = await readOutboundOriginRefundProof({ client: refundClient,
    pointer: { schema: 'hookemon.relay-terminal-origin-refund-pointer.v1', relayRequestId: recorded.relayRequestId, status: 'REFUND', refundTxHash },
    leg: { ...recorded, sourceTxHash }, sourceFinality, sourceAccount: depository, operationsAccount: sender,
    sourceProof, signedSourceTransaction, nativePaymentBinding, orderId });
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
    state.custodyLedgers.get(`4663\u0000native`).returnReceived,
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
  assert.equal(state.custodyLedgers.get(`4663\u0000native`), undefined);
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

test('native return refuses a wrong-token or wrong-recipient receipt before settlement after reopen', async t => {
  for (const observation of [{ observedToken: `0x${'1'.repeat(40)}` }, { observedRecipient: `0x${'3'.repeat(40)}` }]) {
    const fixture = await finalizedReturnFixture(t);
    const before = await fixture.repository.describeCycle(fixture.cycleId);
    await assert.rejects(returnDestinationProof(fixture.leg, observation), /native payment event conflicts with the attributed order/);
    const reopened = await CycleRepository.open(fixture.directory);
    const state = await reopened.describeCycle(fixture.cycleId);
    assert.equal(state.terminalState, null);
    assert.equal(state.relayLegs.get(fixture.leg.relayRequestId).state, 'RECORDED');
    assert.deepEqual(state.custodyLedgers, before.custodyLedgers);
    assert.equal((await reopened.readChainTransactionAttempt(fixture.cycleId, 'return', fixture.requestDigest)).attempt.state, 'FINALIZED');
    // Repeating the rejected observation cannot credit custody or create a settlement.
    await assert.rejects(returnDestinationProof(fixture.leg, observation), /native payment event conflicts with the attributed order/);
    assert.deepEqual((await reopened.describeCycle(fixture.cycleId)).relayLegs, state.relayLegs);
  }
});

test('recordReturnRelayLegExpectation appends the RECORDED leg and its ledger row expectedCycleAsset atomically', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const leg = returnRelayLeg(cycleId);
  const ledger = expectationLedgerFor(leg, cycleId);
  const recorded = await repository.recordReturnRelayLegExpectation(cycleId, leg, ledger);
  assert.equal(recorded.state, 'RECORDED');

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.relayLegs.get(leg.relayRequestId).state, 'RECORDED');
  const row = canonicalReturnLedgerRow(state, leg);
  assert.deepEqual(row.expectedCycleAsset, ledger.expectedCycleAsset);

  // Replaying the identical call is idempotent.
  const replayed = await repository.recordReturnRelayLegExpectation(cycleId, leg, ledger);
  assert.deepEqual(replayed, recorded);
});

test('recordReturnRelayLegExpectation refuses a second unresolved return leg for the same destination before append, leaving the first row unchanged', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const firstLeg = returnRelayLeg(cycleId);
  const firstLedger = expectationLedgerFor(firstLeg, cycleId);
  await repository.recordReturnRelayLegExpectation(cycleId, firstLeg, firstLedger);

  const secondLeg = { ...returnRelayLeg(`${cycleId}-second`), cycleId };
  const secondLedger = expectationLedgerFor(secondLeg, cycleId);
  await assert.rejects(
    () => repository.recordReturnRelayLegExpectation(cycleId, secondLeg, secondLedger),
    /unresolved return leg/,
  );

  const state = await repository.describeCycle(cycleId);
  assert.equal(state.relayLegs.get(secondLeg.relayRequestId), undefined);
  const row = canonicalReturnLedgerRow(state, firstLeg);
  assert.deepEqual(row.expectedCycleAsset, firstLedger.expectedCycleAsset);
});

test('a second cycle sharing the same destination is unaffected by another cycle\'s unresolved return leg', async t => {
  const directory = await tempDirectory(t);
  const first = await CycleRepository.open(directory);
  const { cycleId: firstCycleId } = await first.createCycle({ releaseAmount: '1', mode: 'production' });
  const firstLeg = returnRelayLeg(firstCycleId);
  await first.recordReturnRelayLegExpectation(firstCycleId, firstLeg, expectationLedgerFor(firstLeg, firstCycleId));

  const secondCycleId = 'cycle-return-expectation-sibling';
  await createSiblingCycle(directory, secondCycleId);
  const second = await CycleRepository.open(directory);
  const secondLeg = { ...returnRelayLeg(secondCycleId), cycleId: secondCycleId };
  const recorded = await second.recordReturnRelayLegExpectation(secondCycleId, secondLeg, expectationLedgerFor(secondLeg, secondCycleId));
  assert.equal(recorded.state, 'RECORDED');
});

test('settleRelayLeg clears a v2 expectedCycleAsset in the same atomic append that credits returnReceived', async t => {
  const fixture = await finalizedReturnExpectationFixture(t);
  const settled = await fixture.repository.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission);
  assert.equal(settled.state, 'SETTLED');

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  const row = canonicalReturnLedgerRow(state, fixture.leg);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.expectedCycleAsset, null);
  assert.equal(row.returnReceived, fixture.leg.destinationAmountAtomic);
});

test('settleRelayLeg clears a v2 expectedCycleAsset via its own atomic write when a return leg holds', async t => {
  const fixture = await finalizedReturnExpectationFixture(t, { proof: { observedAmountAtomic: '15' } });
  const settled = await fixture.repository.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission);
  assert.equal(settled.state, 'HELD_RELAY_PARTIAL');

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  const row = canonicalReturnLedgerRow(state, fixture.leg);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.expectedCycleAsset, null);
  assert.equal(row.returnReceived, '0');
});

test('settleRelayLeg locates its ledger row via the durable association, never a stray row written under the leg\'s raw destination identity', async t => {
  const fixture = await finalizedReturnExpectationFixture(t);
  const strayRow = custodyLedger(fixture.cycleId, {
    chainId: fixture.leg.destinationChainId,
    assetId: fixture.leg.destinationAssetId,
    claimed: '999',
  });
  await fixture.repository.recordCustodyLedger(fixture.cycleId, strayRow);

  const settled = await fixture.repository.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission);
  assert.equal(settled.state, 'SETTLED');

  const reopened = await CycleRepository.open(fixture.directory);
  const state = await reopened.describeCycle(fixture.cycleId);
  const canonicalRow = canonicalReturnLedgerRow(state, fixture.leg);
  assert.equal(canonicalRow.returnReceived, fixture.leg.destinationAmountAtomic);
  assert.equal(canonicalRow.expectedCycleAsset, null);

  const rawRow = [...state.custodyLedgers.values()]
    .find(candidate => candidate.chainId === fixture.leg.destinationChainId && candidate.assetId === fixture.leg.destinationAssetId);
  assert.equal(rawRow.claimed, '999');
  assert.equal(rawRow.returnReceived, '0');
  assert.equal(state.custodyLedgers.size, 2);
});

test('distinct canonical return ledger rows with identical expectedCycleAsset amounts never splice on settlement', async t => {
  const fixture = await finalizedReturnExpectationFixture(t);
  const otherDestinationAssetId = '0x00000000000000000000000000000000000abc';
  const otherLegBase = returnRelayLeg(`${fixture.cycleId}-other`);
  const otherLeg = {
    ...otherLegBase,
    cycleId: fixture.cycleId,
    destinationAssetId: otherDestinationAssetId,
    returnAttribution: {
      ...otherLegBase.returnAttribution,
      intent: { ...otherLegBase.returnAttribution.intent, destinationAssetId: otherDestinationAssetId },
    },
  };
  const otherLedger = expectationLedgerFor(otherLeg, fixture.cycleId);
  await fixture.repository.recordReturnRelayLegExpectation(fixture.cycleId, otherLeg, otherLedger);

  const settled = await fixture.repository.settleRelayLeg(fixture.cycleId, fixture.leg.relayRequestId, fixture.submission);
  assert.equal(settled.state, 'SETTLED');

  const state = await fixture.repository.describeCycle(fixture.cycleId);
  const settledRow = canonicalReturnLedgerRow(state, fixture.leg);
  assert.equal(settledRow.expectedCycleAsset, null);
  assert.equal(settledRow.returnReceived, fixture.leg.destinationAmountAtomic);

  const otherRow = canonicalReturnLedgerRow(state, otherLeg);
  assert.deepEqual(otherRow.expectedCycleAsset, otherLedger.expectedCycleAsset);
  assert.equal(otherRow.returnReceived, '0');
});

test('settleRelayLeg rejects a destination hash already attributed to another return leg after reopen', async t => {
  const first = await finalizedReturnFixture(t);
  await first.repository.settleRelayLeg(first.cycleId, first.leg.relayRequestId, first.submission);

  const secondCycleId = 'cycle-return-destination-conflict';
  await createSiblingCycle(first.directory, secondCycleId);
  const second = await CycleRepository.open(first.directory);
  const recorded = await second.recordRelayLeg(secondCycleId, await nativeReturnLeg(secondCycleId));
  const sourceTxHash = nativeReturnTransports.get(recorded.relayRequestId).sourceProof.transactionHash;
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
  const recorded = await repository.recordRelayLeg(cycleId, await nativeReturnLeg(cycleId));
  const sourceTxHash = nativeReturnTransports.get(recorded.relayRequestId).sourceProof.transactionHash;
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
    heldPositions: '0',
    payoutLiability: '1',
    dust: '0',
    unattributed: '0',
  });
  assert.deepEqual(await repository.readClaimPreconditions(), {
    heldAssets: false,
    unattributed: false,
    unresolvedObligations: true,
    heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
  });
});

test('timestamps a sent-unknown provider attempt for deadline reconciliation', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_300_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.prepareStageAttempt(cycleId, 'buyback', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage: 'buyback',
    state: 'PREPARED',
    requestDigest: `sha256:${'c'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });

  await repository.markStageAttemptSentUnknown(cycleId, 'buyback');
  assert.equal((await repository.readOperationalStageAttempt(cycleId, 'buyback')).sentAtMs, 1_700_000_300_000);
});

function packBatch(count, overrides = {}) {
  return Array.from({ length: count }, (_, packIndex) => ({
    packIndex,
    memo: `memo-${packIndex}`,
    expectedCardCount: 1,
    packType: 'pokemon_25',
    ...overrides,
  }));
}

test('readPackBatchRequest is null before a batch is recorded', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  assert.equal(await repository.readPackBatchRequest(cycleId, 'purchase'), null);
});

test('recordPackBatchRequest persists every pack before signing and is idempotent for a retried identical batch', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const packs = packBatch(3);

  const recorded = await repository.recordPackBatchRequest(cycleId, 'purchase', packs);
  assert.deepEqual(recorded, { requestedAtMs: 1_700_000_000_000, packs });
  assert.deepEqual(await repository.readPackBatchRequest(cycleId, 'purchase'), { requestedAtMs: 1_700_000_000_000, packs });

  // A retried "generate the batch" call after a lost response replays the exact same durable
  // packs (and the original requestedAtMs) rather than raising a conflict.
  assert.deepEqual(await repository.recordPackBatchRequest(cycleId, 'purchase', packs), { requestedAtMs: 1_700_000_000_000, packs });
});

test('recordPackBatchRequest survives a repository reopen', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const packs = packBatch(2);
  const recorded = await repository.recordPackBatchRequest(cycleId, 'purchase', packs);

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readPackBatchRequest(cycleId, 'purchase'), recorded);
});

test('recordPackBatchRequest rejects a conflicting batch for the same stage', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordPackBatchRequest(cycleId, 'purchase', packBatch(2));
  await assert.rejects(
    () => repository.recordPackBatchRequest(cycleId, 'purchase', packBatch(3)),
    /already has a different pack batch/,
  );
});

test('recordPackBatchRequest keeps purchase and open batches independent and rejects a non-pack stage', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordPackBatchRequest(cycleId, 'purchase', packBatch(2));
  await repository.recordPackBatchRequest(cycleId, 'open', packBatch(1));
  assert.equal((await repository.readPackBatchRequest(cycleId, 'purchase')).packs.length, 2);
  assert.equal((await repository.readPackBatchRequest(cycleId, 'open')).packs.length, 1);
  await assert.rejects(
    () => repository.recordPackBatchRequest(cycleId, 'return', packBatch(1)),
    /not a pack-operation stage/,
  );
});

test('recordPackBatchRequest refuses more packs than the shared journal payload bound', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await assert.rejects(
    () => repository.recordPackBatchRequest(cycleId, 'purchase', packBatch(MAXIMUM_PACK_BATCH_SIZE + 1)),
    /at most/,
  );
  await repository.recordPackBatchRequest(cycleId, 'purchase', packBatch(MAXIMUM_PACK_BATCH_SIZE));
  assert.equal((await repository.readPackBatchRequest(cycleId, 'purchase')).packs.length, MAXIMUM_PACK_BATCH_SIZE);
});

test('recordPackBatchRequest refuses to add packs once the cycle is terminally held', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.holdCycle(cycleId, 'HELD_DATA_UNVERIFIED', { reason: 'test' });
  await assert.rejects(
    () => repository.recordPackBatchRequest(cycleId, 'purchase', packBatch(1)),
    /cycle is terminal/,
  );
});

function packBatchIntent(overrides = {}) {
  return { quantity: 2, packType: 'pokemon_25', expectedCardCountPerPack: 1, playerAddress: SETTLEMENT_SOLANA_OWNER, ...overrides };
}

test('readPackBatchIntent is null before an intent is recorded', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  assert.equal(await repository.readPackBatchIntent(cycleId, 'purchase'), null);
});

test('recordPackBatchIntent persists the requested quantity and pack code before any provider call, and is idempotent on retry', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t), () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const intent = packBatchIntent();

  const recorded = await repository.recordPackBatchIntent(cycleId, 'purchase', intent);
  assert.deepEqual(recorded, { recordedAtMs: 1_700_000_000_000, intent });
  assert.deepEqual(await repository.readPackBatchIntent(cycleId, 'purchase'), { recordedAtMs: 1_700_000_000_000, intent });
  assert.deepEqual(await repository.recordPackBatchIntent(cycleId, 'purchase', intent), { recordedAtMs: 1_700_000_000_000, intent });
});

test('recordPackBatchIntent survives a repository reopen and rejects a conflicting retry', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const recorded = await repository.recordPackBatchIntent(cycleId, 'purchase', packBatchIntent());

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readPackBatchIntent(cycleId, 'purchase'), recorded);
  await assert.rejects(
    () => reopened.recordPackBatchIntent(cycleId, 'purchase', packBatchIntent({ quantity: 5 })),
    /already has a different pack batch intent/,
  );
});

test('recordPackBatchIntent accepts the canonical pack-code grammar, hyphen and underscore alike', async t => {
  for (const packType of ['return-fixture', 'pokemon_50']) {
    const repository = await CycleRepository.open(await tempDirectory(t));
    const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
    const intent = packBatchIntent({ packType });
    const recorded = await repository.recordPackBatchIntent(cycleId, 'purchase', intent);
    assert.deepEqual(recorded.intent, intent);
    assert.deepEqual(await repository.readPackBatchIntent(cycleId, 'purchase'), recorded);
  }
});

test('recordPackBatchIntent refuses a pack code outside the canonical grammar', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  for (const packType of ['Pokemon_25', 'pokemon 25', '-pokemon25', '_pokemon25', 'pokemon/25', 'pokemon.25', 'p', 'p'.repeat(65)]) {
    await assert.rejects(
      () => repository.recordPackBatchIntent(cycleId, 'purchase', packBatchIntent({ packType })),
      /packType is invalid/,
    );
  }
});

test('a custody ledger journaled before heldPositions existed reopens with that bucket at zero', async t => {
  // Writes a real cycle, then rewrites its journal entry into the pre-change thirteen-bucket shape so
  // the reopen exercises the durable compatibility contract rather than a hand-built object.
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const cycle = await repository.createCycle({ releaseAmount: '25000000', mode: 'production' });
  await repository.recordCustodyLedger(cycle.cycleId, custodyLedger(cycle.cycleId, { claimed: '25000000' }));

  const cyclePath = join(directory, 'active', `${encodeURIComponent(cycle.cycleId)}.json`);
  const stored = JSON.parse(await readFile(cyclePath, 'utf8'));
  let rewritten = 0;
  for (const entry of stored.cycle.entries) {
    if (entry.kind !== 'custody-ledger-recorded') continue;
    delete entry.payload.ledger.heldPositions;
    rewritten += 1;
  }
  assert.equal(rewritten, 1, 'exactly one custody-ledger entry must be rewritten to the legacy shape');
  // The journal is a hash chain, so the rewritten entries are re-digested the way the store does.
  let previous = null;
  for (const [index, entry] of stored.cycle.entries.entries()) {
    entry.digest = digest({ cycleId: stored.cycle.cycleId, index, previousDigest: previous, kind: entry.kind, payload: entry.payload });
    previous = entry.digest;
  }
  stored.cycle.journalHead = previous;
  await writeFile(cyclePath, `${canonicalJson(stored)}\n`);

  const reopened = await CycleRepository.open(directory);
  const described = await reopened.describeCycle(cycle.cycleId);
  const ledger = [...described.custodyLedgers.values()][0];
  assert.equal(ledger.heldPositions, '0', 'the absent bucket reads as the truthful historical zero');
  assert.equal(ledger.claimed, '25000000', 'every other bucket survives the compatibility read unchanged');
});

test('the legacy allowance covers only heldPositions, and never a write', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const cycle = await repository.createCycle({ releaseAmount: '25000000', mode: 'production' });

  // A current write missing the bucket is still refused; compatibility is a read-only concession.
  const { heldPositions: _dropped, ...withoutHeldPositions } = custodyLedger(cycle.cycleId);
  await assert.rejects(
    () => repository.recordCustodyLedger(cycle.cycleId, withoutHeldPositions),
    /custody ledger/,
    'a new write may not omit the canonical bucket',
  );

  // And a stored record missing any other bucket is not normalized into existence.
  const cyclePath = join(directory, 'active', `${encodeURIComponent(cycle.cycleId)}.json`);
  await repository.recordCustodyLedger(cycle.cycleId, custodyLedger(cycle.cycleId));
  const stored = JSON.parse(await readFile(cyclePath, 'utf8'));
  let previous = null;
  for (const [index, entry] of stored.cycle.entries.entries()) {
    if (entry.kind === 'custody-ledger-recorded') delete entry.payload.ledger.dust;
    entry.digest = digest({ cycleId: stored.cycle.cycleId, index, previousDigest: previous, kind: entry.kind, payload: entry.payload });
    previous = entry.digest;
  }
  stored.cycle.journalHead = previous;
  await writeFile(cyclePath, `${canonicalJson(stored)}\n`);

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(() => reopened.describeCycle(cycle.cycleId), /custody ledger/);
});

// REQ-cycle-repository-2 / ADR-0025 `refresh-after-readmission`: a Relay quote expired before any
// outbound request or signature exists is proven-pre-effect-transient, not a HELD_* owner decision.

const OUTBOUND_QUOTE_EXPIRY_DEADLINE = 2_000_000_000; // matches parsedAdmissionRelayQuote()
const OUTBOUND_QUOTE_EXPIRED_OBSERVED_AT_MS = (OUTBOUND_QUOTE_EXPIRY_DEADLINE + 1) * 1000;
// The repository's trusted clock for this whole test section: fixed exactly at the observed expiry
// time, so recordOutboundQuoteExpired's observedAtMs-vs-now check and selectOutboundQuoteRefresh's
// deadline-vs-selectedAtMs check both have a single, deterministic "now" to compare against.
const OUTBOUND_QUOTE_REFRESH_NOW_MS = OUTBOUND_QUOTE_EXPIRED_OBSERVED_AT_MS;
// A replacement deadline strictly later than OUTBOUND_QUOTE_REFRESH_NOW_MS -- fresh at selection
// time, unlike the original's already-expired OUTBOUND_QUOTE_EXPIRY_DEADLINE.
const OUTBOUND_QUOTE_REPLACEMENT_DEADLINE = OUTBOUND_QUOTE_EXPIRY_DEADLINE + 1000;

function outboundQuoteExpiryEvidence(cycleId, admission, overrides = {}) {
  return {
    schema: 'hookemon.outbound-quote-expiry-evidence.v1',
    cycleId,
    admissionDigest: digest(admission),
    aggregateQuote: {
      requestId: admission.relay.requestId,
      deadlineUnixSeconds: admission.relay.deadlineUnixSeconds,
      quoteDigest: admission.relay.quoteDigest,
    },
    unitQuote: {
      requestId: admission.unitRelay.requestId,
      deadlineUnixSeconds: admission.unitRelay.deadlineUnixSeconds,
      quoteDigest: admission.unitRelay.quoteDigest,
    },
    observedAtMs: OUTBOUND_QUOTE_EXPIRED_OBSERVED_AT_MS,
    ...overrides,
  };
}

async function openCycleWithAdmission(t, { cycleId = 'cycle-quote-refresh', now = () => OUTBOUND_QUOTE_REFRESH_NOW_MS, ...admissionOverrides } = {}) {
  const directory = await tempDirectory(t);
  let creating = true;
  const repository = await CycleRepository.open(directory, () => creating ? Math.min((admissionOverrides.deadlineUnixSeconds ?? 2_000_000_000) * 1000 - 1000, 2_000_000_001_000) : now(), { testAuthority: createTestProfileMutationAuthority() });
  const admission = await admissionWithEvidence(cycleId, admissionOverrides);
  await repository.createCycle({
    releaseAmount: admission.aggregateFundingQuote.amountAtomic, mode: 'production', cycleId, admission,
  });
  creating = false;
  return { repository, cycleId, admission, directory };
}

test('recordOutboundQuoteExpired persists REFRESH_REQUIRED before any outbound effect and is idempotent', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);
  const evidence = outboundQuoteExpiryEvidence(cycleId, admission);

  const recorded = await repository.recordOutboundQuoteExpired(cycleId, evidence);
  assert.equal(recorded.state, 'REFRESH_REQUIRED');
  assert.deepEqual(recorded.expiry, evidence);

  const read = await repository.readOutboundQuoteRefresh(cycleId);
  assert.deepEqual(read, recorded);

  // Exact replay is idempotent.
  const replayed = await repository.recordOutboundQuoteExpired(cycleId, evidence);
  assert.deepEqual(replayed, recorded);

  // Changed evidence for the same cycle conflicts rather than silently overwriting. One tick
  // earlier (not later) so this stays nonfuture relative to the fixed trusted repository time
  // while still differing from the durable evidence and still actually expired at that time.
  await assert.rejects(
    () => repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission, { observedAtMs: evidence.observedAtMs - 1 })),
    /conflicting expiry evidence/,
  );
});

test('recordOutboundQuoteExpired refuses a nonexpired quote', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);
  const evidence = outboundQuoteExpiryEvidence(cycleId, admission, { observedAtMs: 1000 });
  await assert.rejects(
    () => repository.recordOutboundQuoteExpired(cycleId, evidence),
    /requires the aggregate or unit quote to actually be expired/,
  );
});

test('recordOutboundQuoteExpired refuses evidence naming the wrong cycle, admission, or quote digest', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);

  await assert.rejects(
    () => repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission, { admissionDigest: `sha256:${'0'.repeat(64)}` })),
    /admissionDigest does not match/,
  );
  await assert.rejects(
    () => repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission, {
      aggregateQuote: { ...outboundQuoteExpiryEvidence(cycleId, admission).aggregateQuote, quoteDigest: `sha256:${'0'.repeat(64)}` },
    })),
    /aggregateQuote does not match/,
  );
  await assert.rejects(
    () => repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission, {
      unitQuote: { ...outboundQuoteExpiryEvidence(cycleId, admission).unitQuote, requestId: 'req-wrong' },
    })),
    /unitQuote does not match/,
  );
});

test('recordOutboundQuoteExpired refuses once any outbound stage request digest, Relay leg, or chain attempt exists', async t => {
  {
    const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-request-digest' });
    await repository.recordStageRequestDigest(cycleId, 'outbound', `sha256:${'a'.repeat(64)}`);
    await assert.rejects(
      () => repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission)),
      /outbound stage request, Relay leg, or chain attempt already exists/,
    );
  }
  {
    const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-relay-leg' });
    await repository.recordRelayLeg(cycleId, relayLeg(cycleId));
    await assert.rejects(
      () => repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission)),
      /outbound stage request, Relay leg, or chain attempt already exists/,
    );
  }
});

test('selectOutboundQuoteRefresh requires an exact REFRESH_REQUIRED predecessor and refuses without one', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);
  const replacement = { ...admission };
  await assert.rejects(
    async () => repository.selectOutboundQuoteRefresh(cycleId, {
      predecessorExpiryDigest: `sha256:${'0'.repeat(64)}`,
      replacement,
      refreshPolicyDecisionDigest: `sha256:${'1'.repeat(64)}`,
    }),
    /requires an exact REFRESH_REQUIRED predecessor/,
  );
});

test('selectOutboundQuoteRefresh atomically selects one replacement bound to the exact expiry predecessor', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);
  const evidence = outboundQuoteExpiryEvidence(cycleId, admission);
  const expired = await repository.recordOutboundQuoteExpired(cycleId, evidence);

  const replacement = await admissionWithEvidence(cycleId, {
    salt: `${cycleId}-replacement`, unitOrderByte: '3', aggregateOrderByte: '4', deadlineUnixSeconds: OUTBOUND_QUOTE_REPLACEMENT_DEADLINE,
  });
  const refreshPolicyDecisionDigest = `sha256:${'2'.repeat(64)}`;
  const selected = await repository.selectOutboundQuoteRefresh(cycleId, {
    predecessorExpiryDigest: expired.expiryDigest,
    replacement,
    refreshPolicyDecisionDigest,
  });

  assert.equal(selected.state, 'ACTIVE');
  assert.equal(selected.expiryDigest, expired.expiryDigest);
  assert.equal(selected.refreshPolicyDecisionDigest, refreshPolicyDecisionDigest);
  assert.deepEqual(selected.replacement.relay.requestId, replacement.relay.requestId);

  const read = await repository.readOutboundQuoteRefresh(cycleId);
  assert.deepEqual(read, selected);

  // A second selection is refused: the projection is no longer REFRESH_REQUIRED.
  await assert.rejects(
    async () => repository.selectOutboundQuoteRefresh(cycleId, {
      predecessorExpiryDigest: expired.expiryDigest,
      replacement: await admissionWithEvidence(cycleId, { salt: `${cycleId}-second`, unitOrderByte: '5', aggregateOrderByte: '6' }),
      refreshPolicyDecisionDigest: `sha256:${'3'.repeat(64)}`,
    }),
    /requires an exact REFRESH_REQUIRED predecessor/,
  );
});

test('selectOutboundQuoteRefresh refuses a replacement whose source amount is not exactly the immutable releaseAmount', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));

  for (const amountAtomic of ['1000001', '999999']) {
    const replacement = await admissionWithEvidence(cycleId, { amountAtomic, salt: `${cycleId}-${amountAtomic}`, unitOrderByte: '7', aggregateOrderByte: '8' });
    await assert.rejects(
      async () => repository.selectOutboundQuoteRefresh(cycleId, {
        predecessorExpiryDigest: expired.expiryDigest,
        replacement,
        refreshPolicyDecisionDigest: `sha256:${'4'.repeat(64)}`,
      }),
      /replacement source amount does not exactly equal the immutable release amount/,
    );
  }

  // Once the cycle's own admission/releaseAmount is untouched, the exact original amount succeeds.
  const stillOriginal = await repository.describeCycle(cycleId);
  assert.equal(stillOriginal.admission.aggregateFundingQuote.amountAtomic, admission.aggregateFundingQuote.amountAtomic);
  assert.equal(stillOriginal.releaseAmount, admission.aggregateFundingQuote.amountAtomic);
  void expired;
});

test('selectOutboundQuoteRefresh refuses a replacement that changes pack, quantity, or destination target', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t);
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));

  const wrongPack = { ...await admissionWithEvidence(cycleId, { salt: `${cycleId}-pack`, unitOrderByte: '9', aggregateOrderByte: 'a' }), packId: 'a-different-pack' };
  await assert.rejects(
    async () => repository.selectOutboundQuoteRefresh(cycleId, {
      predecessorExpiryDigest: expired.expiryDigest, replacement: wrongPack, refreshPolicyDecisionDigest: `sha256:${'5'.repeat(64)}`,
    }),
    /replacement pack\/quantity does not match/,
  );
});

test('selectOutboundQuoteRefresh refuses once any outbound stage request digest exists, even after a valid expiry record', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-select-race' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));
  await repository.recordStageRequestDigest(cycleId, 'outbound', `sha256:${'b'.repeat(64)}`);

  const replacement = await admissionWithEvidence(cycleId, { salt: `${cycleId}-race`, unitOrderByte: 'c', aggregateOrderByte: 'd' });
  await assert.rejects(
    async () => repository.selectOutboundQuoteRefresh(cycleId, {
      predecessorExpiryDigest: expired.expiryDigest, replacement, refreshPolicyDecisionDigest: `sha256:${'6'.repeat(64)}`,
    }),
    /outbound stage request, Relay leg, or chain attempt already exists/,
  );
});

test('readFinalizedClaimCustodyEvidence is null until this cycle\'s own claim-process stage is durably COMPLETE, and stays null for arbitrary stage evidence with no finalized chain-owned proof', async t => {
  const { repository, cycleId } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-claim-evidence' });
  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);

  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-1' });
  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null, 'still null before claim-process itself completes');

  await repository.prepareStage(cycleId, 'claim-process');
  await repository.completeStage(cycleId, 'claim-process', { finalized: true });

  // COMPLETE alone proves nothing: with no cycle-owned FINALIZED claim-process chain attempt at
  // all, arbitrary caller-supplied stage evidence must never read back as finalized custody proof.
  assert.equal(
    await repository.readFinalizedClaimCustodyEvidence(cycleId), null,
    'a COMPLETE claim-process stage with no finalized chain-owned attempt is never finalized evidence',
  );
});

/**
 * Production `claim-process.mjs` shape: finality evidence carries `transactionHash`,
 * `claimedAmountAtomic`, and `destination` only after validating the exact ProcessClaimed event and
 * one finalized USDG transfer. Defaults are all correct/matching; each field is independently
 * overridable so negative tests can flip exactly one at a time.
 */
async function setupCompletedClaimProcess(t, {
  cycleId, transactionHash = '0xdeadbeef', finalityTransactionHash = transactionHash, claimedAmountAtomic, destination = ADMISSION_EVM,
} = {}) {
  const { repository, cycleId: id, admission, directory } = await openCycleWithAdmission(t, { cycleId });
  await repository.prepareStage(id, 'eligibility-snapshot');
  await repository.completeStage(id, 'eligibility-snapshot', { transactionId: 'tx-1' });
  await repository.prepareStage(id, 'claim-process');

  const chainAttempt = preparedChainAttempt(id, 'claim-process');
  await repository.prepareChainTransactionAttempt(id, 'claim-process', chainAttempt);
  await repository.recordSignedTransaction(id, 'claim-process', chainAttempt.requestDigest, {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: transactionHash,
  });
  await repository.recordBroadcast(id, 'claim-process', chainAttempt.requestDigest, { transactionHash });
  const finalityEvidence = Object.freeze({
    transactionHash: finalityTransactionHash,
    finalized: true,
    finalizedBlockNumber: '9',
    finalizedBlockHash: `0x${'a'.repeat(64)}`,
    receiptStatus: 1,
    claimedAmountAtomic: claimedAmountAtomic ?? admission.aggregateFundingQuote.amountAtomic,
    destination,
  });
  await repository.recordFinality(id, 'claim-process', chainAttempt.requestDigest, finalityEvidence);
  await repository.completeStage(id, 'claim-process', finalityEvidence);
  return { repository, cycleId: id, admission, chainAttempt, finalityEvidence, directory };
}

/** The exact custody row `claim-process.mjs`'s own identity rule derives for the funding asset. */
function claimCustodyLedger(cycleId, admission, overrides = {}) {
  const funding = admission.aggregateFundingQuote;
  return custodyLedger(cycleId, {
    chainId: `eip155:${funding.chainId}`,
    assetId: `eip155:${funding.chainId}/erc20:${funding.assetId.toLowerCase()}`,
    decimals: funding.decimals,
    claimed: funding.amountAtomic,
    ...overrides,
  });
}

test('readFinalizedClaimCustodyEvidence requires exactly one finalized cycle-owned claim-process chain attempt whose finality evidence the completed stage evidence exactly matches, plus the exact claim custody row', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-proven';
  const { repository, admission, finalityEvidence } = await setupCompletedClaimProcess(t, { cycleId });

  assert.equal(
    await repository.readFinalizedClaimCustodyEvidence(cycleId), null,
    'no custody has been recorded for this cycle yet',
  );

  const ledger = claimCustodyLedger(cycleId, admission);
  await repository.recordCustodyLedger(cycleId, ledger);

  const evidence = await repository.readFinalizedClaimCustodyEvidence(cycleId);
  assert.equal(evidence.cycleId, cycleId);
  assert.deepEqual(evidence.claimEvidence, finalityEvidence);
  assert.deepEqual(evidence.custodyLedgers, [ledger]);
});

test('readFinalizedClaimCustodyEvidence refuses a custody ledger for an unrelated chain or asset', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-foreign-asset';
  const { repository } = await setupCompletedClaimProcess(t, { cycleId });

  // Default custodyLedger() fixture asset ('eip155:4663/erc20:stablecoin') is not the admitted
  // funding asset ('eip155:4663/erc20:0x5fc5...') -- an unrelated row must never qualify.
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, { claimed: '1000000' }));

  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('readFinalizedClaimCustodyEvidence refuses the exact custody row when its claimed bucket is zero or does not equal the release amount', async t => {
  for (const [label, claimed] of [['zero', '0'], ['wrong nonzero', '999999']]) {
    const cycleId = `cycle-quote-refresh-claim-evidence-bad-claimed-${claimed}`;
    const { repository, admission } = await setupCompletedClaimProcess(t, { cycleId });
    await repository.recordCustodyLedger(cycleId, claimCustodyLedger(cycleId, admission, { claimed }));

    assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null, label);
  }
});

test('readFinalizedClaimCustodyEvidence refuses finality evidence whose transactionHash does not match the finalized attempt hash', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-wrong-tx-hash';
  const { repository, admission } = await setupCompletedClaimProcess(t, {
    cycleId, transactionHash: '0xdeadbeef', finalityTransactionHash: '0xFEEDFACE',
  });
  await repository.recordCustodyLedger(cycleId, claimCustodyLedger(cycleId, admission));

  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('a finality transactionHash differing only in case from the finalized attempt hash still qualifies', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-tx-hash-case';
  const { repository, admission } = await setupCompletedClaimProcess(t, {
    cycleId, transactionHash: '0xdeadbeef', finalityTransactionHash: '0xDEADBEEF',
  });
  await repository.recordCustodyLedger(cycleId, claimCustodyLedger(cycleId, admission));

  assert.notEqual(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('readFinalizedClaimCustodyEvidence refuses finality evidence whose claimedAmountAtomic does not equal the immutable releaseAmount', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-wrong-claimed-amount';
  const { repository, admission } = await setupCompletedClaimProcess(t, { cycleId, claimedAmountAtomic: '999999' });
  await repository.recordCustodyLedger(cycleId, claimCustodyLedger(cycleId, admission));

  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('readFinalizedClaimCustodyEvidence refuses finality evidence whose destination does not match the admitted Operations identity', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-wrong-destination';
  const { repository, admission } = await setupCompletedClaimProcess(t, {
    cycleId, destination: '0x000000000000000000000000000000000000dead',
  });
  await repository.recordCustodyLedger(cycleId, claimCustodyLedger(cycleId, admission));

  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('readFinalizedClaimCustodyEvidence proof survives a repository reopen', async t => {
  const cycleId = 'cycle-quote-refresh-claim-evidence-reopen';
  const { repository, admission, directory } = await setupCompletedClaimProcess(t, { cycleId });
  await repository.recordCustodyLedger(cycleId, claimCustodyLedger(cycleId, admission));

  const before = await repository.readFinalizedClaimCustodyEvidence(cycleId);
  const reopened = await CycleRepository.open(directory);
  const after = await reopened.readFinalizedClaimCustodyEvidence(cycleId);
  assert.deepEqual(after, before);
  assert.notEqual(after, null);
});

test('readFinalizedClaimCustodyEvidence refuses completed stage evidence that does not canonically equal the finalized chain attempt\'s own finality evidence', async t => {
  const { repository, cycleId } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-claim-evidence-mismatch' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-1' });
  await repository.prepareStage(cycleId, 'claim-process');

  const chainAttempt = preparedChainAttempt(cycleId, 'claim-process');
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', chainAttempt);
  await repository.recordSignedTransaction(cycleId, 'claim-process', chainAttempt.requestDigest, {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: '0xdeadbeef',
  });
  await repository.recordBroadcast(cycleId, 'claim-process', chainAttempt.requestDigest, { transactionHash: '0xdeadbeef' });
  await repository.recordFinality(cycleId, 'claim-process', chainAttempt.requestDigest, { transactionHash: '0xdeadbeef', blockNumber: '9' });

  // completeStage does not itself require chain-evidence content equality, so a caller can still
  // complete with unrelated evidence -- the accessor, not completeStage, must refuse to launder it.
  await repository.completeStage(cycleId, 'claim-process', { finalized: true });
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, { heldAssets: '1000000' }));

  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('readFinalizedClaimCustodyEvidence refuses more than one finalized cycle-owned claim-process chain attempt', async t => {
  const { repository, cycleId } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-claim-evidence-multiple' });
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', { transactionId: 'tx-1' });
  await repository.prepareStage(cycleId, 'claim-process');

  const finalize = async (requestDigest, hash) => {
    const attempt = preparedChainAttempt(cycleId, 'claim-process', requestDigest);
    await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', attempt);
    await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, { rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash });
    await repository.recordBroadcast(cycleId, 'claim-process', requestDigest, { transactionHash: hash });
    const finalityEvidence = { transactionHash: hash, blockNumber: '9' };
    await repository.recordFinality(cycleId, 'claim-process', requestDigest, finalityEvidence);
    return finalityEvidence;
  };
  const first = await finalize(`sha256:${'a'.repeat(64)}`, '0xdeadbeef');
  await finalize(`sha256:${'b'.repeat(64)}`, '0xfeedface');

  await repository.completeStage(cycleId, 'claim-process', first);
  await repository.recordCustodyLedger(cycleId, custodyLedger(cycleId, { heldAssets: '1000000' }));

  assert.equal(await repository.readFinalizedClaimCustodyEvidence(cycleId), null);
});

test('recordOutboundQuoteExpired refuses observedAtMs later than the repository\'s trusted current time', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-future-observed' });
  const evidence = outboundQuoteExpiryEvidence(cycleId, admission, { observedAtMs: OUTBOUND_QUOTE_REFRESH_NOW_MS + 1 });
  await assert.rejects(
    () => repository.recordOutboundQuoteExpired(cycleId, evidence),
    /observedAtMs is later than the repository's trusted current time/,
  );
});

test('selectOutboundQuoteRefresh refuses a replacement whose deadline is not strictly later than the selection time', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-stale-replacement' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));
  const selectedUnixSeconds = Math.floor(OUTBOUND_QUOTE_REFRESH_NOW_MS / 1000);

  for (const [label, deadlineUnixSeconds, unitOrderByte, aggregateOrderByte] of [
    ['equal', selectedUnixSeconds, 'e', 'f'],
    ['past', selectedUnixSeconds - 1, 'c', 'd'],
  ]) {
    const replacement = await admissionWithEvidence(cycleId, { salt: `${cycleId}-${label}`, unitOrderByte, aggregateOrderByte, deadlineUnixSeconds });
    await assert.rejects(
      async () => repository.selectOutboundQuoteRefresh(cycleId, {
        predecessorExpiryDigest: expired.expiryDigest, replacement, refreshPolicyDecisionDigest: `sha256:${'7'.repeat(64)}`,
      }),
      /replacement quote deadlines must be strictly later than the selection time/,
      label,
    );
  }

  const fresh = await admissionWithEvidence(cycleId, {
    salt: `${cycleId}-fresh`, unitOrderByte: 'a', aggregateOrderByte: '9', deadlineUnixSeconds: selectedUnixSeconds + 1,
  });
  const selected = await repository.selectOutboundQuoteRefresh(cycleId, {
    predecessorExpiryDigest: expired.expiryDigest, replacement: fresh, refreshPolicyDecisionDigest: `sha256:${'8'.repeat(64)}`,
  });
  assert.equal(selected.state, 'ACTIVE');
});

test('selectOutboundQuoteRefresh checks the lease fence before any validation and commits nothing on failure', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-fence-immediate' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));
  const replacement = await admissionWithEvidence(cycleId, {
    salt: `${cycleId}-fence`, unitOrderByte: '5', aggregateOrderByte: '6', deadlineUnixSeconds: OUTBOUND_QUOTE_REPLACEMENT_DEADLINE,
  });

  await assert.rejects(
    async () => repository.selectOutboundQuoteRefresh(cycleId, {
      predecessorExpiryDigest: expired.expiryDigest,
      replacement,
      refreshPolicyDecisionDigest: `sha256:${'a'.repeat(64)}`,
      assertLease: () => { throw new Error('lease fenced: stale owner'); },
    }),
    /lease fenced: stale owner/,
  );

  const read = await repository.readOutboundQuoteRefresh(cycleId);
  assert.equal(read.state, 'REFRESH_REQUIRED', 'a fenced-out selection must not mutate the projection');
});

test('selectOutboundQuoteRefresh refuses a selection whose lease is fenced out at the atomic append boundary', async t => {
  const { repository, cycleId, admission } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-fence-race' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));
  const replacement = await admissionWithEvidence(cycleId, {
    salt: `${cycleId}-fence-race`, unitOrderByte: '7', aggregateOrderByte: '8', deadlineUnixSeconds: OUTBOUND_QUOTE_REPLACEMENT_DEADLINE,
  });

  let checks = 0;
  const assertLease = () => {
    checks += 1;
    // Passes the up-front check, but a competing owner renews the lease before the atomic append commits.
    if (checks > 1) throw new Error('lease fenced: renewed by another owner');
  };

  await assert.rejects(
    async () => repository.selectOutboundQuoteRefresh(cycleId, {
      predecessorExpiryDigest: expired.expiryDigest, replacement, refreshPolicyDecisionDigest: `sha256:${'b'.repeat(64)}`, assertLease,
    }),
    /lease fenced: renewed by another owner/,
  );
  assert.ok(checks >= 2, 'the fence must be re-checked at the append boundary, not only up front');

  const read = await repository.readOutboundQuoteRefresh(cycleId);
  assert.equal(read.state, 'REFRESH_REQUIRED', 'the fenced-out attempt must not have committed a selection');
});

async function injectRawJournalEntry(directory, cycleId, kind, payload) {
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored.entries).propose(kind, payload);
  const transaction = store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
  transaction.stageEvent(entry);
  await store.commit(transaction);
  return entry;
}

test('a stored outbound quote expiry event recorded after an outbound effect record is refused on replay', async t => {
  const { cycleId, admission, directory } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-tamper-expiry-after-effect' });
  await injectRawJournalEntry(directory, cycleId, 'stage-request-prepared', { stage: 'outbound', requestDigest: `sha256:${'d'.repeat(64)}` });
  await injectRawJournalEntry(directory, cycleId, 'outbound-quote-expired', { evidence: outboundQuoteExpiryEvidence(cycleId, admission) });

  const reopened = await CycleRepository.open(directory, () => OUTBOUND_QUOTE_REFRESH_NOW_MS);
  await assert.rejects(
    () => reopened.readOutboundQuoteRefresh(cycleId),
    /recorded outbound quote expiry evidence after an outbound effect record/,
  );
});

test('a stored outbound quote refresh selection recorded after an outbound chain attempt is refused on replay', async t => {
  const { repository, cycleId, admission, directory } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-tamper-effect' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));

  await injectRawJournalEntry(directory, cycleId, 'chain-attempt-prepared', {
    stage: 'outbound', attempt: preparedChainAttempt(cycleId, 'outbound', `sha256:${'c'.repeat(64)}`),
  });

  const replacement = await admissionWithEvidence(cycleId, {
    salt: `${cycleId}-tamper`, unitOrderByte: '3', aggregateOrderByte: '4', deadlineUnixSeconds: OUTBOUND_QUOTE_REPLACEMENT_DEADLINE,
  });
  await injectRawJournalEntry(directory, cycleId, 'outbound-quote-refresh-selected', {
    predecessorExpiryDigest: expired.expiryDigest,
    replacement,
    replacementDigest: digest(replacement),
    refreshPolicyDecisionDigest: `sha256:${'9'.repeat(64)}`,
    selectedAtMs: OUTBOUND_QUOTE_REFRESH_NOW_MS,
  });

  const reopened = await CycleRepository.open(directory, () => OUTBOUND_QUOTE_REFRESH_NOW_MS);
  await assert.rejects(
    () => reopened.readOutboundQuoteRefresh(cycleId),
    /selected an outbound quote refresh replacement after an outbound effect record/,
  );
});

test('a stored outbound quote refresh selection naming a replacement with the wrong principal or identity is refused on replay', async t => {
  const { repository, cycleId, admission, directory } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-tamper-identity' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));

  const wrongPack = {
    ...await admissionWithEvidence(cycleId, {
      salt: `${cycleId}-wrong-pack`, unitOrderByte: '5', aggregateOrderByte: '6', deadlineUnixSeconds: OUTBOUND_QUOTE_REPLACEMENT_DEADLINE,
    }),
    packId: 'a-different-pack',
  };
  await injectRawJournalEntry(directory, cycleId, 'outbound-quote-refresh-selected', {
    predecessorExpiryDigest: expired.expiryDigest,
    replacement: wrongPack,
    replacementDigest: digest(wrongPack),
    refreshPolicyDecisionDigest: `sha256:${'0'.repeat(64)}`,
    selectedAtMs: OUTBOUND_QUOTE_REFRESH_NOW_MS,
  });

  const reopened = await CycleRepository.open(directory, () => OUTBOUND_QUOTE_REFRESH_NOW_MS);
  await assert.rejects(
    () => reopened.readOutboundQuoteRefresh(cycleId),
    /replacement pack\/quantity does not match/,
  );
});

test('a stored outbound quote refresh selection naming an already-expired replacement is refused on replay', async t => {
  const { repository, cycleId, admission, directory } = await openCycleWithAdmission(t, { cycleId: 'cycle-quote-refresh-tamper-stale' });
  const expired = await repository.recordOutboundQuoteExpired(cycleId, outboundQuoteExpiryEvidence(cycleId, admission));

  const staleReplacement = await admissionWithEvidence(cycleId, {
    salt: `${cycleId}-stale`, unitOrderByte: '1', aggregateOrderByte: '2', deadlineUnixSeconds: Math.floor(OUTBOUND_QUOTE_REFRESH_NOW_MS / 1000),
  });
  await injectRawJournalEntry(directory, cycleId, 'outbound-quote-refresh-selected', {
    predecessorExpiryDigest: expired.expiryDigest,
    replacement: staleReplacement,
    replacementDigest: digest(staleReplacement),
    refreshPolicyDecisionDigest: `sha256:${'1'.repeat(64)}`,
    selectedAtMs: OUTBOUND_QUOTE_REFRESH_NOW_MS,
  });

  const reopened = await CycleRepository.open(directory, () => OUTBOUND_QUOTE_REFRESH_NOW_MS);
  await assert.rejects(
    () => reopened.readOutboundQuoteRefresh(cycleId),
    /replacement quote deadlines must be strictly later than the selection time/,
  );
});

// REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: the durable pre-sign binder a
// bounded Keychain sign-only retry reuses. These focused tests exercise the repository/money-schema
// CAS contract in isolation, independent of signer-client.mjs's retry facade (covered separately).
function signOnlyPreSignBinding(cycleId, stage, requestDigest, overrides = {}) {
  return {
    schema: 'hookemon.sign-only-pre-sign-binding.v1',
    cycleId,
    stage,
    requestDigest,
    role: 'operator-evm',
    account: 'hookemon-operator-primary',
    unsignedWireBytes: canonicalJson({ to: '0x1', nonce: '1' }),
    unsignedRequestDigest: digest({ to: '0x1', nonce: '1' }),
    policyDigest: digest({ policy: 'p' }),
    validityContextDigest: digest({ validity: 'v' }),
    ...overrides,
  };
}

test('persistSignOnlyPreSignBinding requires an existing PREPARED chain attempt', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    () => repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, signOnlyPreSignBinding(cycleId, 'claim-process', requestDigest)),
    /chain attempt is not PREPARED/,
  );
  assert.equal(await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest), null);
});

test('persistSignOnlyPreSignBinding binds exactly once before signing and replays byte-identical material idempotently', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', preparedChainAttempt(cycleId, 'claim-process', requestDigest));
  const binding = signOnlyPreSignBinding(cycleId, 'claim-process', requestDigest);

  const first = await repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, binding);
  assert.deepEqual(first, binding);
  assert.deepEqual(await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest), binding);

  // Idempotent replay of the exact same material -- as a restart's regenerated request must be --
  // never throws and never creates a second durable record.
  const second = await repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, binding);
  assert.deepEqual(second, binding);
});

test('persistSignOnlyPreSignBinding refuses changed wire bytes, role, account, digest, or validity context for the same request', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', preparedChainAttempt(cycleId, 'claim-process', requestDigest));
  const binding = signOnlyPreSignBinding(cycleId, 'claim-process', requestDigest);
  await repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, binding);

  const conflictCases = {
    unsignedWireBytes: canonicalJson({ to: '0x1', nonce: '2' }),
    role: 'operator-solana',
    account: 'a-different-account',
    policyDigest: digest({ policy: 'a different policy' }),
    validityContextDigest: digest({ validity: 'a different validity' }),
  };
  for (const [field, value] of Object.entries(conflictCases)) {
    await assert.rejects(
      () => repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, { ...binding, [field]: value }),
      /already has a different pre-sign binding/,
      `expected a conflict on ${field}`,
    );
  }
  // The durable record is untouched by every refused conflict above.
  assert.deepEqual(await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest), binding);
});

test('persistSignOnlyPreSignBinding refuses once the chain attempt is no longer PREPARED', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', preparedChainAttempt(cycleId, 'claim-process', requestDigest));
  await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: '0xdeadbeef',
  });
  await assert.rejects(
    () => repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, signOnlyPreSignBinding(cycleId, 'claim-process', requestDigest)),
    /chain attempt is not PREPARED/,
  );
});

test('a durable sign-only pre-sign binding survives restart and is read back unchanged', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', preparedChainAttempt(cycleId, 'claim-process', requestDigest));
  const binding = signOnlyPreSignBinding(cycleId, 'claim-process', requestDigest);
  await repository.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, binding);

  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.readSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest), binding);
  // Restart never regenerates: a second bind attempt against the reopened repository with the exact
  // same material is still the idempotent no-op, not a new record.
  await reopened.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, binding);
  await assert.rejects(
    () => reopened.persistSignOnlyPreSignBinding(cycleId, 'claim-process', requestDigest, { ...binding, unsignedWireBytes: canonicalJson({ to: '0x1', nonce: '999' }) }),
    /already has a different pre-sign binding/,
  );
});

test('readSignOnlyPreSignBinding returns null for a request with no durable binding', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  assert.equal(await repository.readSignOnlyPreSignBinding(cycleId, 'claim-process', `sha256:${'a'.repeat(64)}`), null);
});

// REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: the durable invocation ledger a
// bounded Keychain sign-only retry consumes -- distinct from the immutable pre-sign binding above.
async function preparedBindingFixture(repository, cycleId, stage, requestDigest) {
  await repository.prepareChainTransactionAttempt(cycleId, stage, preparedChainAttempt(cycleId, stage, requestDigest));
  return repository.persistSignOnlyPreSignBinding(cycleId, stage, requestDigest, signOnlyPreSignBinding(cycleId, stage, requestDigest));
}

test('reserveSignOnlyInvocation requires a durable pre-sign binding and a PREPARED chain attempt', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1),
    /no durable pre-sign binding/,
  );
  await repository.prepareChainTransactionAttempt(cycleId, 'claim-process', preparedChainAttempt(cycleId, 'claim-process', requestDigest));
  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1),
    /no durable pre-sign binding/,
  );
});

test('reserveSignOnlyInvocation permits ordinal 1 only from a fresh binding and refuses a second ordinal-1 reservation', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);

  const ledger = await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  assert.equal(ledger.state, 'ORDINAL_1_ALLOCATED');
  assert.deepEqual(await repository.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest), ledger);

  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1),
    /ordinal 1 was already reserved/,
  );
});

test('reserveSignOnlyInvocation refuses ordinal 2 before ordinal 1 has a recorded timeout', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);

  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
    /ordinal 2 requires a recorded ordinal 1 timeout/,
  );

  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  // Allocated but no outcome yet (simulates a crash, or a generic non-timeout error) -- ordinal 2
  // must remain ineligible.
  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
    /ordinal 2 requires a recorded ordinal 1 timeout/,
  );
});

test('recordSignOnlyInvocationTimeout requires the exact allocated ordinal and rejects gaps or reordering', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);

  await assert.rejects(
    () => repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1),
    /ordinal 1 is not in the allocated state/,
  );
  await assert.rejects(
    () => repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 2),
    /ordinal 2 is not in the allocated state/,
  );

  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  await assert.rejects(
    () => repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 2),
    /ordinal 2 is not in the allocated state/,
  );
  const timedOut1 = await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1);
  assert.equal(timedOut1.state, 'ORDINAL_1_TIMED_OUT');
  // Recording the identical true outcome again is idempotent.
  assert.deepEqual(await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1), timedOut1);

  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2);
  const timedOut2 = await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 2);
  assert.equal(timedOut2.state, 'ORDINAL_2_TIMED_OUT');
  // Exhausted: no third ordinal exists, and nothing can be reserved or recorded past this point.
  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1),
    /ordinal 1 was already reserved/,
  );
  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
    /ordinal 2 requires a recorded ordinal 1 timeout/,
  );
});

test('reserveSignOnlyInvocation re-checks PREPARED atomically: a chain attempt that advanced refuses ordinal 2 before signing', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1);

  // The attempt advances to SIGNED between the recorded timeout and the retry (e.g. the timed-out
  // call actually produced a signature that reached the repository through another path).
  await repository.recordSignedTransaction(cycleId, 'claim-process', requestDigest, {
    rawBytes: '0xabcdef', nonce: '8', blockhash: null, hash: '0xdeadbeef',
  });

  await assert.rejects(
    () => repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
    /chain attempt is not PREPARED/,
  );
});

test('restart: reopening after the first timeout permits exactly one remaining invocation, never two', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1);

  const reopened = await CycleRepository.open(directory);
  const ledger = await reopened.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest);
  assert.equal(ledger.state, 'ORDINAL_1_TIMED_OUT');

  const ordinal2 = await reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2);
  assert.equal(ordinal2.state, 'ORDINAL_2_ALLOCATED');
  // No third invocation exists under any restart.
  await assert.rejects(
    () => reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1),
    /ordinal 1 was already reserved/,
  );
  await reopened.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 2);
  await assert.rejects(
    () => reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
    /ordinal 2 requires a recorded ordinal 1 timeout/,
  );
});

test('restart: reopening after both ordinals timed out grants no remaining invocation', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2);
  await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 2);

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)).state, 'ORDINAL_2_TIMED_OUT');
  await assert.rejects(() => reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1), /ordinal 1 was already reserved/);
  await assert.rejects(() => reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2), /ordinal 2 requires a recorded ordinal 1 timeout/);
});

test('restart: reopening after an allocated-but-unrecorded ordinal 1 (crash or unknown result) grants no invocation', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  // No outcome ever recorded -- simulates a crash, or a generic error the ledger never advances for.

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)).state, 'ORDINAL_1_ALLOCATED');
  await assert.rejects(() => reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1), /ordinal 1 was already reserved/);
  await assert.rejects(() => reopened.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2), /ordinal 2 requires a recorded ordinal 1 timeout/);
});

test('concurrency: two racing callers for ordinal 2 allocate exactly one, the loser refuses before signing', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);
  await repository.recordSignOnlyInvocationTimeout(cycleId, 'claim-process', requestDigest, 1);

  const results = await Promise.allSettled([
    repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
    repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 2),
  ]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent caller wins the ordinal-2 reservation');
  assert.equal(rejected.length, 1, 'the other concurrent caller refuses rather than also winning');
  // The loser refuses either through this method's own eligibility check or through the durable
  // store's own optimistic-concurrency conflict at commit time; both mean it never won the right
  // to invoke Keychain.
  assert.match(rejected[0].reason.message, /ordinal 2 requires a recorded ordinal 1 timeout|already reserved|stale cycle journal version/);
  assert.equal((await repository.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)).state, 'ORDINAL_2_ALLOCATED');
});

test('replay rejects an invocation-outcome record without a matching prior allocation or with an ordinal gap', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);

  await injectRawJournalEntry(directory, cycleId, 'sign-only-invocation-timed-out', {
    ledger: {
      schema: 'hookemon.sign-only-invocation-ledger.v1',
      cycleId, stage: 'claim-process', requestDigest, state: 'ORDINAL_1_TIMED_OUT',
    },
  });
  await assert.rejects(
    () => CycleRepository.open(directory).then(reopened => reopened.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)),
    /timeout transition is invalid/,
  );
});

test('replay rejects an ordinal-2 reservation that skips a recorded ordinal-1 timeout', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  await preparedBindingFixture(repository, cycleId, 'claim-process', requestDigest);
  await repository.reserveSignOnlyInvocation(cycleId, 'claim-process', requestDigest, 1);

  await injectRawJournalEntry(directory, cycleId, 'sign-only-invocation-reserved', {
    ledger: {
      schema: 'hookemon.sign-only-invocation-ledger.v1',
      cycleId, stage: 'claim-process', requestDigest, state: 'ORDINAL_2_ALLOCATED',
    },
  });
  await assert.rejects(
    () => CycleRepository.open(directory).then(reopened => reopened.readSignOnlyInvocationLedger(cycleId, 'claim-process', requestDigest)),
    /ordinal 2 reservation is invalid/,
  );
});

// --- BOT-HELD-CUSTODY: held-position writes land on the canonical EVM USDG custody identity ----

const HELD_CANONICAL_CHAIN_ID = 'eip155:4663';
const HELD_CANONICAL_ASSET_ID = `${HELD_CANONICAL_CHAIN_ID}/erc20:${SETTLEMENT_SOURCE_ASSET}`;
const HELD_CANONICAL_ASSET = { chainId: HELD_CANONICAL_CHAIN_ID, assetId: HELD_CANONICAL_ASSET_ID, decimals: 6 };
const HELD_CANONICAL_KEY = `${HELD_CANONICAL_CHAIN_ID}\u0000${HELD_CANONICAL_ASSET_ID}`;
const HELD_RAW_ASSET = { chainId: '4663', assetId: SETTLEMENT_SOURCE_ASSET, decimals: 6 };
const HELD_RAW_KEY = `4663\u0000${SETTLEMENT_SOURCE_ASSET}`;

function heldPositionFixture(overrides = {}) {
  return {
    packId: 'pack-1',
    memo: 'memo-1',
    mint: 'mint-1',
    cardRef: 'mint-1',
    costMicroUsdg: '25000000',
    valueMicroUsdg: '25000000',
    ledgerAsset: HELD_CANONICAL_ASSET,
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
    ...overrides,
  };
}

test('recordHeldPosition on an existing canonical v2 row preserves verifiedCurrentBalance and expectedCycleAsset and only increments heldPositions', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  // Seed the exact row claim/payout would already maintain for this canonical identity, through
  // the one dedicated writer that may populate a non-null expectedCycleAsset (ADR-0026), with a
  // non-null verifiedCurrentBalance alongside it -- both must survive the held write untouched.
  const leg = returnRelayLeg(cycleId);
  const identity = canonicalEvmUsdgIdentity(leg);
  assert.deepEqual(identity, HELD_CANONICAL_ASSET);
  const observation = custodyBalanceObservation(identity);
  const seededLedger = {
    ...expectationLedgerFor(leg, cycleId, identity),
    claimed: '500',
    returnReceived: '500',
    verifiedCurrentBalance: observation,
  };
  await repository.recordReturnRelayLegExpectation(cycleId, leg, seededLedger);

  const position = await repository.recordHeldPosition(cycleId, heldPositionFixture());

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  const row = state.custodyLedgers.get(HELD_CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.heldPositions, '25000000');
  assert.equal(row.claimed, '500');
  assert.equal(row.returnReceived, '500');
  assert.deepEqual(row.verifiedCurrentBalance, observation);
  assert.deepEqual(row.expectedCycleAsset, seededLedger.expectedCycleAsset);
  assert.deepEqual(await reopened.readHeldPosition(position.positionId), position);
});

test('recordHeldPosition against an absent canonical row creates a v2 row with honest null observation fields', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  const position = await repository.recordHeldPosition(cycleId, heldPositionFixture());

  const state = await repository.describeCycle(cycleId);
  const row = state.custodyLedgers.get(HELD_CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.heldPositions, position.valueMicroUsdg);
  assert.equal(row.claimed, '0');
  assert.equal(row.verifiedCurrentBalance, null);
  assert.equal(row.expectedCycleAsset, null);
});

test('recordHeldPosition upgrades a canonical v1 predecessor to v2 with honest null observation fields on a live write', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await injectRawJournalEntry(directory, cycleId, 'custody-ledger-recorded', {
    ledger: custodyLedger(cycleId, { chainId: HELD_CANONICAL_CHAIN_ID, assetId: HELD_CANONICAL_ASSET_ID, claimed: '9' }),
  });

  const reopened = await CycleRepository.open(directory);
  await reopened.recordHeldPosition(cycleId, heldPositionFixture({ memo: 'memo-upgrade', mint: 'mint-upgrade', cardRef: 'mint-upgrade' }));

  const state = await (await CycleRepository.open(directory)).describeCycle(cycleId);
  const row = state.custodyLedgers.get(HELD_CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.claimed, '9');
  assert.equal(row.heldPositions, '25000000');
  assert.equal(row.verifiedCurrentBalance, null);
  assert.equal(row.expectedCycleAsset, null);
});

test('recordHeldPosition refuses a canonical write while a legacy raw-identity row exists for the same asset, without journal growth', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordHeldPosition(cycleId, heldPositionFixture({
    memo: 'memo-raw', mint: 'mint-raw', cardRef: 'mint-raw', ledgerAsset: HELD_RAW_ASSET,
  }));

  await assert.rejects(
    () => repository.recordHeldPosition(cycleId, heldPositionFixture({
      memo: 'memo-canonical', mint: 'mint-canonical', cardRef: 'mint-canonical', terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE',
    })),
    /legacy raw-identity custody row exists/,
  );

  const state = await repository.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.equal(state.custodyLedgers.size, 1);
  assert.equal(state.custodyLedgers.get(HELD_RAW_KEY).heldPositions, '25000000');
});

test('recordHeldPosition still refuses a canonical write once a raw row and a canonical row already coexist for the same asset', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  await repository.recordHeldPosition(cycleId, heldPositionFixture({
    memo: 'memo-raw', mint: 'mint-raw', cardRef: 'mint-raw', ledgerAsset: HELD_RAW_ASSET,
  }));
  // A canonical row now also durably exists -- a coexistence this repository never produces on its
  // own, injected only to prove the raw-predecessor refusal holds even once both rows are present,
  // not merely while the canonical row is still absent.
  await injectRawJournalEntry(directory, cycleId, 'custody-ledger-recorded', {
    ledger: custodyLedgerV2(cycleId, { chainId: HELD_CANONICAL_CHAIN_ID, assetId: HELD_CANONICAL_ASSET_ID }),
  });

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(
    () => reopened.recordHeldPosition(cycleId, heldPositionFixture({
      memo: 'memo-canonical', mint: 'mint-canonical', cardRef: 'mint-canonical', terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE',
    })),
    /legacy raw-identity custody row exists/,
  );

  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.deepEqual([...state.heldPositions.values()].map(position => position.memo), ['memo-raw']);
});

test('recordHeldPosition retry after reopen with the same canonical ledger identity counts once', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const input = heldPositionFixture({ terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE' });
  const first = await repository.recordHeldPosition(cycleId, input);

  const reopened = await CycleRepository.open(directory);
  const retry = await reopened.recordHeldPosition(cycleId, input);
  assert.deepEqual(retry, first);

  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.equal(state.custodyLedgers.get(HELD_CANONICAL_KEY).heldPositions, '25000000');
});

test('recordHeldPosition retry refuses when it names a different custody ledger identity than the position already recorded', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const input = heldPositionFixture({ terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE' });
  await repository.recordHeldPosition(cycleId, input);

  const driftedAsset = { ...HELD_CANONICAL_ASSET, assetId: `${HELD_CANONICAL_CHAIN_ID}/erc20:0x${'7'.repeat(40)}` };
  await assert.rejects(
    () => repository.recordHeldPosition(cycleId, { ...input, ledgerAsset: driftedAsset }),
    /retry supplies a custody ledger identity that does not match/,
  );
});

test('recordHeldPosition retry refuses when it omits the custody ledger identity the position was actually recorded with, without journal growth', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const input = heldPositionFixture({ terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE' });
  await repository.recordHeldPosition(cycleId, input);
  const { ledgerAsset: _omitted, ...retryWithoutLedgerAsset } = input;

  const beforeStore = await DurableCycleStore.open(directory);
  const beforeStored = beforeStore.readCycle(cycleId);
  await assert.rejects(
    () => repository.recordHeldPosition(cycleId, retryWithoutLedgerAsset),
    /retry omits the custody ledger identity/,
  );
  const afterFirstStore = await DurableCycleStore.open(directory);
  const afterFirstStored = afterFirstStore.readCycle(cycleId);
  assert.equal(afterFirstStored.version, beforeStored.version, 'refusal must not advance the journal version');
  assert.equal(afterFirstStored.journalHead, beforeStored.journalHead, 'refusal must not append a new journal entry');
  assert.equal(afterFirstStored.entries.length, beforeStored.entries.length);

  // Same refusal holds even once a legacy raw-identity row also coexists for this asset: the
  // omitted-attribution check fires before any raw-coexistence check ever runs.
  await injectRawJournalEntry(directory, cycleId, 'custody-ledger-recorded', {
    ledger: custodyLedger(cycleId, { chainId: HELD_RAW_ASSET.chainId, assetId: HELD_RAW_ASSET.assetId }),
  });
  const reopened = await CycleRepository.open(directory);
  const beforeSecondStore = await DurableCycleStore.open(directory);
  const beforeSecondStored = beforeSecondStore.readCycle(cycleId);
  await assert.rejects(
    () => reopened.recordHeldPosition(cycleId, retryWithoutLedgerAsset),
    /retry omits the custody ledger identity/,
  );
  const afterSecondStore = await DurableCycleStore.open(directory);
  const afterSecondStored = afterSecondStore.readCycle(cycleId);
  assert.equal(afterSecondStored.version, beforeSecondStored.version, 'refusal must not advance the journal version');
  assert.equal(afterSecondStored.journalHead, beforeSecondStored.journalHead, 'refusal must not append a new journal entry');
  assert.equal(afterSecondStored.entries.length, beforeSecondStored.entries.length);

  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.equal(state.custodyLedgers.get(HELD_CANONICAL_KEY).heldPositions, '25000000');
});

test('recordHeldPosition retry for a position genuinely recorded without any ledger attribution still counts once', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const { ledgerAsset: _omitted, ...input } = heldPositionFixture({ terminalState: 'HELD_UNAVAILABLE', reason: 'BUYBACK_UNAVAILABLE' });

  const first = await repository.recordHeldPosition(cycleId, input);
  const retry = await repository.recordHeldPosition(cycleId, input);
  assert.deepEqual(retry, first);

  const state = await repository.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 1);
  assert.equal(state.custodyLedgers.size, 0);
});

test('two distinct held positions attributing to the same canonical row each count their own value exactly once', async t => {
  const repository = await CycleRepository.open(await tempDirectory(t));
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });

  await repository.recordHeldPosition(cycleId, heldPositionFixture({
    memo: 'memo-a', mint: 'mint-a', cardRef: 'mint-a', costMicroUsdg: '10', valueMicroUsdg: '10',
  }));
  await repository.recordHeldPosition(cycleId, heldPositionFixture({
    memo: 'memo-b', mint: 'mint-b', cardRef: 'mint-b', costMicroUsdg: '20', valueMicroUsdg: '20',
  }));

  const state = await repository.describeCycle(cycleId);
  assert.equal(state.heldPositions.size, 2);
  assert.equal(state.custodyLedgers.get(HELD_CANONICAL_KEY).heldPositions, '30');
});

test('resolveHeldPosition after reopen removes its value from the same canonical custody row it opened', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, heldPositionFixture({
    costMicroUsdg: '17', valueMicroUsdg: '17', reason: 'SENT_UNKNOWN_DEADLINE', terminalState: 'HELD_UNRESOLVED',
    evidence: { stage: 'buyback', status: 'sent-unknown' },
  }));
  const before = await repository.describeCycle(cycleId);
  assert.equal(before.custodyLedgers.get(HELD_CANONICAL_KEY).heldPositions, '17');

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_001);
  await reopened.resolveHeldPosition(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    expectedRevision: 0,
    terminalState: 'REFUNDED',
    evidence: { source: 'collector-status', status: 'refunded' },
  });

  const after = await reopened.describeCycle(cycleId);
  assert.equal(after.custodyLedgers.get(HELD_CANONICAL_KEY).heldPositions, '0');
  assert.equal(after.custodyLedgers.size, 1);
});

test('a raw-identity held position and its v1 custody row replay byte-identically after reopen', async t => {
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const position = await repository.recordHeldPosition(cycleId, heldPositionFixture({
    costMicroUsdg: '17', valueMicroUsdg: '17', ledgerAsset: HELD_RAW_ASSET,
    reason: 'SENT_UNKNOWN_DEADLINE', terminalState: 'HELD_UNRESOLVED', evidence: { stage: 'buyback', status: 'sent-unknown' },
  }));
  const before = await repository.describeCycle(cycleId);
  const beforeRow = before.custodyLedgers.get(HELD_RAW_KEY);
  assert.equal(beforeRow.schema, 'hookemon.custody-ledger.v1');

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const after = await reopened.describeCycle(cycleId);
  assert.deepEqual(after.custodyLedgers.get(HELD_RAW_KEY), beforeRow);
  assert.deepEqual(await reopened.readHeldPosition(position.positionId), position);
});

test('a stored historical canonical-v1 held event (the real pinned-base d5bd6a3e API output, committed as a fixture) replays byte-identically under the current fix', async t => {
  const fixture = HELD_POSITION_CANONICAL_V1_FIXTURE;
  const directory = await tempDirectory(t);
  const repository = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production', cycleId: fixture.position.cycleId });
  assert.equal(cycleId, fixture.position.cycleId);

  // Confirms the fixture is genuinely the shape under test before it is ever replayed: a v1 row at
  // the canonical identity, which only the pre-fix repository (with no identity-aware branching)
  // would ever have produced -- not something this test or the current writer constructs.
  assert.equal(fixture.ledger.schema, 'hookemon.custody-ledger.v1');
  assert.equal(fixture.ledger.chainId, HELD_CANONICAL_CHAIN_ID);
  assert.equal(fixture.ledger.assetId, HELD_CANONICAL_ASSET_ID);
  assert.equal(fixture.ledger.heldPositions, '17');

  await injectRawJournalEntry(directory, cycleId, 'held-position-recorded', {
    position: fixture.position,
    evidence: fixture.evidence,
    ledger: fixture.ledger,
  });

  const reopened = await CycleRepository.open(directory, () => 1_700_000_000_000);
  const after = await reopened.describeCycle(cycleId);
  assert.deepEqual(after.custodyLedgers.get(HELD_CANONICAL_KEY), fixture.ledger, 'replay must not upgrade or migrate the stored v1 row');
  assert.equal(after.custodyLedgers.size, 1, 'replay must not synthesize a second (v2) row alongside it');
  assert.deepEqual(await reopened.readHeldPosition(fixture.position.positionId), fixture.position);
});
