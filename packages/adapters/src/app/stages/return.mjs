import { assertNativeReturnInstruction } from '../../signing/native-return-policy.mjs';
import { createRelayNativePaymentProof, readReleaseBoundRelaySourceDebit } from '../../native-payment-proof.mjs';
import {
  DIRECTIONS,
  RELAY_CONSTANTS,
  assertQuoteUsable,
  createQuoteUsdValuation,
  readProcessQuoteUsdProvenance,
} from '../../relay-client.mjs';
import {
  buildRelayLegacyTransaction,
  readBlockHeight,
  readCurrentRelaySourceRuntime,
  readSolBalance,
  readUsableLatestBlockhash,
  signedSolanaTransactionSignature,
} from '../../solana-rpc.mjs';
import {
  ERC20_TRANSFER_TOPIC,
  readBlockByNumber,
  readFinalizedTransactionReceipt,
} from '../../robinhood-rpc.mjs';
import { digest as canonicalDigest } from '../../../../runner/src/cycle/journal.mjs';
import {
  assertMoneyConfiguration,
  assertReturnLegDestinationProof,
  createPreparedChainTransactionAttempt,
  createRecordedRelayLeg,
  CUSTODY_LEDGER_BUCKETS,
} from '../../../../runner/src/cycle/money-schemas.mjs';
import { createNativeCustodyBalanceObservationReader } from '../../evm-custody-balance-observation.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  readTransactionPolicyRules,
} from '../../signing/transaction-policy.mjs';
import { forwardOwnedKeychainSignOnlyIdentity } from '../../signing/keychain-signer.mjs';
import {
  OPERATOR_SOLANA_ROLE,
  readTransactionPolicyApprovalContext,
  recoverTransactionPolicyBroadcast,
  wrapTransactionPolicySignerClient,
} from '../../signing/signer-client.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
} from '../../../../runner/src/cycle/preflight.mjs';
import { walletNonceLeaseWindow, resolveWalletNonceReservation } from '../wallet-nonce-lease.mjs';

const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_WORD = /^0x[0-9a-fA-F]{64}$/;
const NATIVE_ADDRESS = RELAY_CONSTANTS.NATIVE_ADDRESS.toLowerCase();
const NATIVE_ASSET = 'native';
const SOLANA_CHAIN_ID = String(RELAY_CONSTANTS.SOLANA_CHAIN_ID);
const EVM_CHAIN_ID = String(RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TERMINAL_RELAY_LEG_STATES = new Set([
  'SETTLED',
  'HELD_RELAY_PARTIAL',
  'HELD_RELAY_REFUND',
  'HELD_RELAY_LATE',
  'HELD_RELAY_WRONG_ASSET',
]);
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();
const processRpcReturnLegDestinationProofs = new WeakMap();

export class ReturnRecoveryRequiredError extends Error {
  constructor(recoveryState, message, details = {}) {
    super(message);
    this.name = 'ReturnRecoveryRequiredError';
    this.stage = 'return';
    this.recoveryState = recoveryState;
    this.retryable = false;
    Object.assign(this, details);
  }
}

/**
 * Runtime-only capability issued by readReturnLegDestinationProof after this process has read
 * and rechecked the finalized destination receipt. Durable records retain normalized facts only.
 */
export function isProcessRpcReturnLegDestinationProof(value, expected = {}) {
  if (value === null || typeof value !== 'object') return false;
  const observed = processRpcReturnLegDestinationProofs.get(value);
  if (!observed) return false;
  let proofDigest;
  try {
    proofDigest = canonicalDigest(value);
  } catch {
    return false;
  }
  return proofDigest === observed.proofDigest
    && (expected.relayRequestId === undefined || observed.relayRequestId === expected.relayRequestId)
    && (expected.sourceTxHash === undefined || observed.sourceTxHash === String(expected.sourceTxHash))
    && (expected.destinationTxHash === undefined || observed.destinationTxHash === String(expected.destinationTxHash).toLowerCase());
}

function canonicalAmount(value, label) {
  if (typeof value !== 'string' || !ATOMIC_AMOUNT.test(value)) throw new Error(`${label} must be a canonical atomic amount`);
  return value;
}

export function typedAmount(leg) {
  return Object.freeze({
    chainId: String(leg.chainId),
    assetId: leg.chainId === RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID && leg.address.toLowerCase() === NATIVE_ADDRESS ? NATIVE_ASSET : leg.address,
    decimals: leg.decimals,
    amountAtomic: leg.amount,
  });
}

export function assertReturnConfiguration(config) {
  const evm = config?.accounts?.evm;
  const solana = config?.accounts?.solana;
  const solanaMint = config?.relay?.solanaMint;
  const configuredSettlementWindow = config?.relay?.maxSettlementWindowSeconds;
  if (!EVM_ADDRESS.test(evm ?? '')) throw new Error('return requires a configured Operations EVM account');
  if (typeof solana !== 'string' || solana.length === 0) throw new Error('return requires a configured Operations Solana account');
  if (typeof solanaMint !== 'string' || solanaMint.length === 0) throw new Error('return requires a configured Solana mint');
  const maxSettlementWindowSeconds = configuredSettlementWindow === undefined || configuredSettlementWindow === null
    ? null
    : canonicalPositiveInteger(configuredSettlementWindow, 'return configured max settlement window seconds');
  return Object.freeze({ evm, solana, solanaMint, maxSettlementWindowSeconds });
}

function custodyLedgerFor(state, { chainId, assetId }) {
  const ledgers = state?.custodyLedgers;
  const values = ledgers instanceof Map ? [...ledgers.values()] : Array.isArray(ledgers) ? ledgers : [];
  return values.find(ledger => ledger?.chainId === chainId && ledger?.assetId === assetId) ?? null;
}

function sameReturnCustodyAsset(left, right) {
  return left?.chainId === right?.chainId && left?.assetId === right?.assetId && left?.decimals === right?.decimals;
}

/**
 * The native Solana custody identity that buyback.mjs actually attributes realized proceeds under
 * (`configuredSettlementAsset`/`COLLECTOR_CRYPT_SETTLEMENT_ASSET`, chain id `solana-mainnet` +
 * `CIRCLE_USD_MINT`) -- never Relay's own wire `SOLANA_CHAIN_ID` (792703809), which identifies a
 * transport route, not a custody attribution namespace. Matches
 * `assertSolanaSignerMoneyConfiguration` (`solana-money-controls.mjs`): the configured asset is
 * proven against the trusted constant `COLLECTOR_CRYPT_SETTLEMENT_ASSET` itself, not merely
 * checked for self-consistency between two configured fields (`config.solana.chainId` and
 * `config.collectorCrypt.settlementAsset.chainId` could otherwise both be wrongly set to the same
 * incorrect value and still "agree"). Then cross-checked against the Relay-facing
 * `configured.solanaMint` and `MoneyConfigurationV2.assets.solanaStablecoin` so the two namespaces
 * are proven to name the same mint before either is trusted.
 */
function resolveReturnNativeSolanaCustodyIdentity(config, configured, money) {
  const asset = config?.collectorCrypt?.settlementAsset;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)
    || typeof asset.chainId !== 'string' || asset.chainId.length === 0
    || typeof asset.assetId !== 'string' || asset.assetId.length === 0
    || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new Error('return requires a configured native Solana settlement asset');
  }
  if (!sameReturnCustodyAsset(asset, COLLECTOR_CRYPT_SETTLEMENT_ASSET) || config?.solana?.chainId !== asset.chainId) {
    throw new Error('return native Solana settlement asset does not match the trusted native Collector settlement identity');
  }
  if (asset.assetId !== configured.solanaMint) {
    throw new Error('return native Solana settlement asset does not match the configured Relay Solana mint');
  }
  if (asset.decimals !== money.assets.solanaStablecoin.decimals) {
    throw new Error('return native Solana settlement asset decimals do not match MoneyConfigurationV2');
  }
  return Object.freeze({ chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals });
}

/**
 * A custody row keyed by Relay's wire chain ID for the same mint is never a legitimate second
 * source of proceeds -- it is either stale data from before this identity fix or a conflicting
 * write from elsewhere. Either way this refuses rather than summing it with, or preferring it
 * over, the native-identity row.
 */
function competingReturnCustodyLedger(cycle, nativeIdentity) {
  if (nativeIdentity.chainId === SOLANA_CHAIN_ID) return null;
  return custodyLedgerFor(cycle, { chainId: SOLANA_CHAIN_ID, assetId: nativeIdentity.assetId });
}

function assertNoCompetingReturnCustodyLedger(cycle, nativeIdentity) {
  if (competingReturnCustodyLedger(cycle, nativeIdentity) !== null) {
    throw new Error('return has a Solana custody ledger row keyed by the Relay wire chain id, conflicting with the native settlement identity');
  }
}

/** Only a ledger-attributed, not a wallet-wide, proceeds delta may enter the return quote. */
export function returnableProceedsDelta(ledger) {
  if (!ledger) throw new Error('return requires a cycle custody ledger for the configured Solana mint');
  const proceeds = BigInt(canonicalAmount(ledger.buybackProceeds, 'return custody buybackProceeds'));
  const committed = BigInt(canonicalAmount(ledger.returnInput, 'return custody returnInput'));
  if (committed > proceeds) throw new Error('return custody returnInput exceeds buybackProceeds');
  return (proceeds - committed).toString();
}

function zeroProceedsReturnEvidence({ request, context, configured, money }) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || request.schema !== 'hookemon.return-zero-proceeds-request.v2'
    || request.cycleId !== context?.cycleId
    || !request.inputAmount || !request.destinationAmount) {
    throw new Error('return zero-proceeds request is invalid');
  }
  const input = request.inputAmount;
  const destination = request.destinationAmount;
  if (input.chainId !== SOLANA_CHAIN_ID || input.assetId !== configured.solanaMint
    || input.decimals !== money.assets.solanaStablecoin.decimals || input.amountAtomic !== '0'
    || destination.chainId !== EVM_CHAIN_ID || destination.assetId?.toLowerCase() !== NATIVE_ASSET
    || destination.decimals !== money.assets.eth.decimals || destination.amountAtomic !== '0') {
    throw new Error('return zero-proceeds request does not match the configured settlement assets');
  }
  return Object.freeze({
    schema: 'hookemon.return-zero-proceeds-evidence.v2',
    cycleId: context.cycleId,
    finalized: true,
    noBridge: true,
    destinationAccount: configured.evm,
    destinationAsset: NATIVE_ASSET,
    destinationCreditAmount: '0',
  });
}

function isZeroProceedsReturnEvidence(value, { cycleId, configured, money }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== 'hookemon.return-zero-proceeds-evidence.v2'
    || value.cycleId !== cycleId || value.finalized !== true || value.noBridge !== true
    || value.destinationAccount?.toLowerCase() !== configured.evm.toLowerCase()
    || value.destinationAsset?.toLowerCase() !== NATIVE_ASSET
    || value.destinationCreditAmount !== '0') return false;
  return money.assets.eth.chainId === EVM_CHAIN_ID && money.assets.eth.decimals === 18;
}

function zeroProceedsReturnRequest({ context, configured, money }) {
  return Object.freeze({
    schema: 'hookemon.return-zero-proceeds-request.v2',
    cycleId: context.cycleId,
    inputAmount: Object.freeze({
      chainId: SOLANA_CHAIN_ID,
      assetId: configured.solanaMint,
      decimals: money.assets.solanaStablecoin.decimals,
      amountAtomic: '0',
    }),
    destinationAmount: Object.freeze({
      chainId: EVM_CHAIN_ID,
      assetId: NATIVE_ASSET,
      decimals: money.assets.eth.decimals,
      amountAtomic: '0',
    }),
  });
}

function hasHeldPositionWithoutProceedsLedger(cycle) {
  return cycle?.heldPositions instanceof Map && cycle.heldPositions.size > 0;
}

/**
 * True when the durable buyback stage-attempt evidence (`stage-driver.mjs`'s generic
 * `recordStageAttempt`/`readStageAttempt('buyback', ...)`, populated from
 * `reconcileLiveBuyback`'s own `{ packs, soldCount }` result) already records a sold pack. The
 * custody-ledger write precedes the reconciled result in the normal buyback path. Sold evidence
 * without that ledger is inconsistent recovery state, not evidence of a normal interruption
 * between those writes. A held position cannot override that inconsistency.
 */
function hasDurableSoldBuybackEvidence(buybackAttempt) {
  return Boolean(buybackAttempt) && typeof buybackAttempt === 'object' && !Array.isArray(buybackAttempt)
    && Array.isArray(buybackAttempt.packs) && buybackAttempt.packs.some(pack => pack?.decision === 'sold');
}

async function assertReturnNoSoldEvidenceWithoutLedger({ cycleRepository, context }) {
  if (typeof cycleRepository?.readStageAttempt !== 'function') {
    throw new Error('return requires cycleRepository.readStageAttempt to rule out durable sold buyback evidence before a zero-proceeds return');
  }
  const buybackAttempt = await cycleRepository.readStageAttempt(context.cycleId, 'buyback');
  if (hasDurableSoldBuybackEvidence(buybackAttempt)) {
    throw new Error('return cannot treat this cycle as zero-proceeds: durable buyback evidence records a sold pack with no matching native custody ledger row');
  }
}

export function assertReturnQuote(quote, config, money = null) {
  if (!quote || quote.direction !== DIRECTIONS.RETURN) throw new Error('return requires a RETURN Relay quote');
  if (quote.origin?.chainId !== RELAY_CONSTANTS.SOLANA_CHAIN_ID || quote.origin?.address !== config.solanaMint) {
    throw new Error('return quote origin does not match the configured Solana mint');
  }
  if (quote.destination?.chainId !== RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID || quote.destination?.address?.toLowerCase() !== NATIVE_ADDRESS) {
    throw new Error('return quote destination is not native ETH on chain 4663');
  }
  if (quote.sender !== config.solana) throw new Error('return quote sender does not match Operations Solana account');
  if (quote.recipient?.toLowerCase() !== config.evm.toLowerCase()) throw new Error('return quote recipient does not match Operations EVM account');
  canonicalAmount(quote.origin.amount, 'return quote origin amount');
  canonicalAmount(quote.destination.amount, 'return quote destination amount');
  if (!Number.isInteger(quote.origin.decimals) || !Number.isInteger(quote.destination.decimals)) {
    throw new Error('return quote is missing asset decimals');
  }
  if (money !== null && (quote.origin.decimals !== money.assets.solanaStablecoin.decimals
    || quote.destination.decimals !== money.assets.eth.decimals)) {
    throw new Error('return quote decimals do not match MoneyConfigurationV2 assets');
  }
  return quote;
}

/**
 * Relay's recorded Solana return shape contains instructions and ALT addresses, not a serialized
 * transaction. Preserve the full keys and metadata; bounded legacy compilation is permitted only
 * when every key is explicit. The signer independently checks the release-bound deposit grammar.
 */
export function extractRelaySolanaInstructionPlan({ steps, requestId }) {
  if (!Array.isArray(steps) || steps.length !== 1) throw new Error('return Relay quote must contain exactly one recorded Solana transaction step');
  const step = steps[0];
  if (!step || step.kind !== 'transaction' || step.requestId !== requestId || !Array.isArray(step.items) || step.items.length !== 1) {
    throw new Error('return Relay quote does not contain one transaction item for this intent');
  }
  const data = step.items[0]?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.instructions) || data.instructions.length === 0
    || !Array.isArray(data.addressLookupTableAddresses)) {
    throw new Error('return Relay transaction does not match the recorded instruction and ALT shape');
  }
  for (const instruction of data.instructions) {
    if (!instruction || typeof instruction.programId !== 'string' || !Array.isArray(instruction.keys) || typeof instruction.data !== 'string') {
      throw new Error('return Relay instruction is malformed');
    }
  }
  return Object.freeze({
    instructions: Object.freeze(data.instructions.map(instruction => Object.freeze({ ...instruction, keys: Object.freeze(instruction.keys.map(key => Object.freeze({ ...key }))) }))),
    addressLookupTableAddresses: Object.freeze([...data.addressLookupTableAddresses]),
  });
}

/** Builds the immutable, attributed return request before a signer can be called. */
export async function prepareReturnRequest({ adapters, config, cycleRepository, context, nowMs = Date.now() }) {
  if (!adapters?.relay) throw new Error('return requires a configured Relay client');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('return request creation time must be a non-negative safe integer');
  const configured = assertReturnConfiguration(config);
  const money = assertReturnMoneyConfiguration(config, configured);
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  if (cycle.admission?.schema !== 'hookemon.policy-admission.v3') throw new Error('native return refuses historical cycle resume');
  const nativeIdentity = resolveReturnNativeSolanaCustodyIdentity(config, configured, money);
  assertNoCompetingReturnCustodyLedger(cycle, nativeIdentity);
  const ledger = custodyLedgerFor(cycle, { chainId: nativeIdentity.chainId, assetId: nativeIdentity.assetId });
  if (ledger === null && hasHeldPositionWithoutProceedsLedger(cycle)) {
    await assertReturnNoSoldEvidenceWithoutLedger({ cycleRepository, context });
    return zeroProceedsReturnRequest({ context, configured, money });
  }
  const amountAtomic = returnableProceedsDelta(ledger);
  if (amountAtomic === '0') {
    const proceeds = canonicalAmount(ledger.buybackProceeds, 'return custody buybackProceeds');
    if (proceeds !== '0') throw new Error('return has no uncommitted cycle-attributed proceeds');
    return zeroProceedsReturnRequest({ context, configured, money });
  }
  const quote = await adapters.relay.quoteReturnBridge({
    user: configured.solana,
    recipient: configured.evm,
    amount: amountAtomic,
    originCurrency: configured.solanaMint,
  });
  assertReturnQuote(quote, configured, money);
  assertQuoteUsable({ quote, nowMs });
  const execution = adapters.relay.prepareExecution({ quote, liveMode: true });
  const destinationUsd = createQuoteUsdValuation({ quote, side: 'destination', amount: typedAmount(quote.destination), rounding: 'down', nowMs });
  return Object.freeze({
    schema: 'hookemon.return-relay-request.v2',
    destinationUsd,
    destinationUsdEvidence: { ...readProcessQuoteUsdProvenance(destinationUsd), quote },
    cycleId: context.cycleId,
    inputAmount: typedAmount(quote.origin),
    destinationAmount: typedAmount(quote.destination),
    requestCreatedAtUnixSeconds: Math.floor(nowMs / 1000).toString(),
    maxSettlementWindowSeconds: configured.maxSettlementWindowSeconds,
    intent: execution.intent,
    solanaInstructionPlan: extractRelaySolanaInstructionPlan({ steps: execution.steps, requestId: quote.requestId }),
  });
}

/**
 * The subject digest a standing-authority step intent authorizing a degraded-return acceptance
 * must bind to (`intent.subjectDigest`) — cycle, receipt, and the literal `acceptDegraded: true`
 * claim, so a signed intent can never be replayed to accept a different cycle's receipt.
 */
export function degradedReturnAcceptanceSubjectDigest({ onchainCycleId, receiptDigest }) {
  return canonicalDigest({ domain: 'hookemon.degraded-return-acceptance.v1', onchainCycleId, receiptDigest, acceptDegraded: true });
}

export async function probeReturn({ adapters, config, cycleRepository, context }) {
  if (!adapters?.relay || !config?.accounts?.evm || !config?.accounts?.solana || !config?.relay?.solanaMint) {
    return { wouldBridgeReturn: true, configured: false, reason: 'Relay, Operations accounts, or the Solana mint is not configured' };
  }
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  let amountAtomic;
  try {
    const configured = assertReturnConfiguration(config);
    const money = assertReturnMoneyConfiguration(config, configured);
    const nativeIdentity = resolveReturnNativeSolanaCustodyIdentity(config, configured, money);
    assertNoCompetingReturnCustodyLedger(cycle, nativeIdentity);
    const ledger = custodyLedgerFor(cycle, { chainId: nativeIdentity.chainId, assetId: nativeIdentity.assetId });
    amountAtomic = returnableProceedsDelta(ledger);
  } catch (error) {
    return { wouldBridgeReturn: true, configured: true, reason: error.message };
  }
  if (amountAtomic === '0') return { wouldBridgeReturn: true, configured: true, reason: 'no uncommitted cycle-attributed proceeds' };
  const quote = await adapters.relay.quoteReturnBridge({
    amount: amountAtomic,
    user: config.accounts.solana,
    recipient: config.accounts.evm,
    originCurrency: config.relay.solanaMint,
  });
  return {
    wouldBridgeReturn: true,
    configured: true,
    quote: adapters.relay.simulateExecution({ quote }),
    availableAmount: amountAtomic,
  };
}

function sameAmount(left, right) {
  return left?.chainId === right?.chainId
    && left?.assetId === right?.assetId
    && left?.decimals === right?.decimals
    && left?.amountAtomic === right?.amountAtomic;
}

function exactAmountConstraint(value) {
  return value === null ? null : { exact: value };
}

function exactGasConstraint(gas) {
  return Object.freeze(Object.fromEntries(Object.entries(gas).map(([key, value]) => [
    key,
    value && typeof value === 'object' && Object.hasOwn(value, 'amountAtomic') ? exactAmountConstraint(value) : value,
  ])));
}

function exactPolicyRule(decoded, id) {
  return Object.freeze({
    id,
    family: decoded.family,
    format: decoded.format,
    chainId: decoded.chainId,
    nonce: decoded.nonce,
    programIds: decoded.programIds,
    addressLookupTables: decoded.addressLookupTables,
    target: decoded.target,
    selector: decoded.selector,
    source: decoded.source,
    destination: decoded.destination,
    mint: decoded.mint,
    token: decoded.token,
    amount: exactAmountConstraint(decoded.amount),
    nativeValue: exactAmountConstraint(decoded.nativeValue),
    gas: exactGasConstraint(decoded.gas),
    feePayer: decoded.feePayer,
    requiredSigners: decoded.requiredSigners,
    coSigners: decoded.coSigners,
    instructions: decoded.instructions.map(instruction => ({
      ...instruction,
      amount: exactAmountConstraint(instruction.amount),
      nativeValue: exactAmountConstraint(instruction.nativeValue),
      priorityFee: exactAmountConstraint(instruction.priorityFee),
    })),
    extraInstructions: decoded.extraInstructions.map(instruction => ({
      ...instruction,
      amount: exactAmountConstraint(instruction.amount),
      nativeValue: exactAmountConstraint(instruction.nativeValue),
      priorityFee: exactAmountConstraint(instruction.priorityFee),
    })),
    blockhash: decoded.blockhash,
    deadline: decoded.deadline,
    priorityFee: exactAmountConstraint(decoded.priorityFee),
  });
}

export function assertReturnMoneyConfiguration(config, configured) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, 'return money configuration');
  } catch (error) {
    throw new Error(`return requires MoneyConfigurationV2: ${error.message}`);
  }
  if (money.assets.eth.chainId !== EVM_CHAIN_ID
    || money.assets.eth.assetId.toLowerCase() !== NATIVE_ASSET
    || money.assets.eth.decimals !== 18) {
    throw new Error('return MoneyConfigurationV2 native ETH asset does not match the configured Robinhood route');
  }
  if (money.assets.solanaStablecoin.chainId !== SOLANA_CHAIN_ID
    || money.assets.solanaStablecoin.assetId !== configured.solanaMint) {
    throw new Error('return MoneyConfigurationV2 Solana asset does not match the configured Relay route');
  }
  return money;
}

function assertReturnMutationRepository(cycleRepository) {
  for (const method of [
    'readChainTransactionAttempt',
    'prepareChainTransactionAttempt',
    'recordSignedTransaction',
    'recordBroadcast',
    'recordReturnRelayLegExpectation',
    'recordRelayLegSource',
    'reserveWalletNonce',
    'assertWalletNonce',
    'persistChainAttemptRecoveryContext',
    'readChainAttemptRecoveryContext',
  ]) {
    if (typeof cycleRepository?.[method] !== 'function') {
      throw new Error(`return requires cycleRepository.${method} for durable Relay signing`);
    }
  }
  if (typeof cycleRepository.recordSignedTransactionWithRecoveryContext !== 'function'
    && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('return requires cycleRepository.recordSignedTransactionWithRecoveryContext for atomic Relay signing');
  }
}

function returnWalletReservation(configured, context) {
  if (typeof context?.fencingToken !== 'string' || context.fencingToken.length === 0) {
    throw new Error('return requires a fencing token for the global wallet nonce reservation');
  }
  return Object.freeze({
    chainId: SOLANA_CHAIN_ID,
    wallet: configured.solana,
    stage: 'return',
    fencingToken: context.fencingToken,
    ...walletNonceLeaseWindow(context, 'return wallet nonce reservation'),
  });
}

async function reserveReturnWalletNonce({ cycleRepository, configured, context }) {
  const reservation = await resolveWalletNonceReservation(
    cycleRepository, context.cycleId, returnWalletReservation(configured, context),
  );
  await cycleRepository.reserveWalletNonce(context.cycleId, reservation);
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
  return reservation;
}

async function assertReturnWalletNonce({ cycleRepository, context, reservation }) {
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
}

/** A finalized source transaction cannot be re-signed, so its wallet fence may advance. */
async function releaseReturnWalletNonce({ cycleRepository, configured, context }) {
  if (typeof cycleRepository?.releaseWalletNonce !== 'function') {
    throw new Error('return requires cycleRepository.releaseWalletNonce after durable source finality');
  }
  await cycleRepository.releaseWalletNonce(
    context.cycleId,
    await resolveWalletNonceReservation(
      cycleRepository, context.cycleId, returnWalletReservation(configured, context), { release: true },
    ),
  );
}

function returnStepRequestDigest(context, request) {
  return canonicalDigest({
    schema: 'hookemon.relay-chain-step.v1',
    cycleId: context.cycleId,
    stage: 'return',
    requestDigest: context.requestDigest,
    relayRequestId: request.intent.requestId,
    instructionPlan: request.solanaInstructionPlan,
  });
}

function returnRelayLeg(context, request) {
  return createRecordedRelayLeg({
    cycleId: context.cycleId,
    direction: 'return',
    relayRequestId: request.intent.requestId,
    quoteDigest: canonicalDigest({
      schema: 'hookemon.relay-quote-digest.v1',
      intent: request.intent,
      inputAmount: request.inputAmount,
      destinationAmount: request.destinationAmount,
    }),
    source: request.inputAmount,
    destination: request.destinationAmount,
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v2',
      destinationUsd: request.destinationUsd,
      destinationUsdEvidence: request.destinationUsdEvidence,
      intent: request.intent,
      requestCreatedAtUnixSeconds: request.requestCreatedAtUnixSeconds,
      maxSettlementWindowSeconds: request.maxSettlementWindowSeconds,
    },
  });
}

/** Native custody uses the exact active identity; historical token rows remain separate. */
function returnCustodyAsset(money) {
  return Object.freeze({ ...money.assets.eth });
}

function returnCustodyLedgerKey(asset) {
  return `${asset.chainId}\u0000${asset.assetId}`;
}

/**
 * The legacy, pre-canonical row identity for this same configured EVM USDG asset: the leg's own
 * raw `(chainId, address)` pair, the same raw shape `returnSettlementCustodyLedger` falls back to
 * for a leg with no durable canonical association (ADR-0026).
 */
function legacyRawReturnCustodyKey(leg) {
  return `${leg.destinationChainId}\u0000${leg.destinationAssetId}`;
}

/**
 * Reuses the reviewed public-finalized -> distinct-archive-at-height/hash -> public-recheck
 * `CustodyBalanceObservationV1` producer, pinned to the canonical return destination identity and
 * the configured Operations account -- never a supplied balance callback or a candidate row.
 */
async function observeReturnCustodyBalance({ adapters, asset, account }) {
  const observeBalance = createNativeCustodyBalanceObservationReader({
    publicClient: adapters?.robinhood?.client ?? null,
    archiveClient: adapters?.robinhood?.historicalEvidenceClient ?? null,
    identity: { chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals, account },
  });
  return observeBalance();
}

function returnCarriedCustodyBuckets(existing) {
  return Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => [bucket, existing?.[bucket] ?? '0']));
}

const RETURN_LEG_IDENTITY_FIELDS = Object.freeze([
  'schema', 'cycleId', 'direction', 'relayRequestId', 'quoteDigest',
  'sourceChainId', 'sourceAssetId', 'sourceDecimals', 'sourceAmountAtomic',
  'destinationChainId', 'destinationAssetId', 'destinationDecimals', 'destinationAmountAtomic',
  'returnAttribution',
]);

function returnLegIdentity(leg) {
  return Object.fromEntries(RETURN_LEG_IDENTITY_FIELDS.map(field => [field, leg[field]]));
}

/**
 * True when a different, already-recorded return leg already holds this same destination row's
 * singular `expectedCycleAsset` unresolved (ADR-0026). Checked before any observation or write --
 * `leg` itself is known not to be durably recorded yet (the caller only reaches this function for a
 * genuinely new leg), so a non-null existing expectation can only belong to a different leg.
 */
function hasConflictingUnresolvedReturnExpectation(existing) {
  return existing?.schema === 'hookemon.custody-ledger.v3' && existing.expectedCycleAsset !== null;
}

/**
 * Records the unsigned RECORDED return leg and its custody row's newly populated singular
 * `expectedCycleAsset` as one atomic journal entry through `recordReturnRelayLegExpectation`
 * (ADR-0026). A legacy raw-identity USDG row for this asset -- alone or alongside a canonical row
 * -- or a different leg's already-unresolved expectation on this same row is refused before any
 * observation or write, leg creation, nonce reservation, signing, or broadcast -- the row and
 * journal are left exactly as they were. Called only for a genuinely new leg (the caller never
 * invokes this again once the leg already exists -- `sourceTxHash`/`state` legitimately advance
 * afterward, so replaying this same atomic call against an advanced leg would wrongly look like
 * conflicting evidence): a fresh, non-null observation is always obtained, regardless of whether
 * the destination row already exists as v1, v2, or not at all -- every existing bucket is carried
 * forward unchanged. `context.assertLease` is rechecked immediately after each awaited durable step
 * -- the observation's own multi-RPC round trip, then the custody refresh write -- so a lease lost
 * during either await reaches zero further durable calls.
 */
async function recordReturnCustodyExpectation({ cycleRepository, cycle, leg, configured, money, adapters, context, destinationUsd }) {
  const asset = returnCustodyAsset(money);
  const canonicalKey = returnCustodyLedgerKey(asset);
  const rawKey = legacyRawReturnCustodyKey(leg);
  if (rawKey !== canonicalKey && (cycle?.custodyLedgers?.get?.(rawKey) ?? null) !== null) {
    throw new ReturnRecoveryRequiredError(
      'RETURN_LEGACY_RAW_CUSTODY_PREDECESSOR',
      'a legacy raw-identity USDG custody row exists for this asset, an unresolved raw/canonical '
      + 'identity conflict; resolve it before recording a new return leg expectation',
    );
  }
  const existing = cycle?.custodyLedgers?.get?.(canonicalKey) ?? null;
  if (existing && existing.schema !== 'hookemon.custody-ledger.v3') throw new Error('native return refuses historical custody reinterpretation');
  if (hasConflictingUnresolvedReturnExpectation(existing)) {
    throw new Error('cycle-repository recordReturnRelayLegExpectation: an unresolved return leg for this destination already exists');
  }
  if (typeof cycleRepository?.recordCustodyLedger !== 'function' && existing !== null) {
    throw new Error('return requires cycleRepository.recordCustodyLedger to refresh an existing custody row');
  }
  const expectedCycleAsset = Object.freeze({
    chainId: asset.chainId,
    assetId: asset.assetId,
    decimals: asset.decimals,
    amountAtomic: leg.destinationAmountAtomic,
  });
  const observation = await observeReturnCustodyBalance({ adapters, asset, account: configured.evm.toLowerCase() });
  context?.assertLease?.();
  const refreshed = Object.freeze({
    schema: 'hookemon.custody-ledger.v3',
    cycleId: leg.cycleId,
    chainId: asset.chainId,
    assetId: asset.assetId,
    decimals: asset.decimals,
    ...returnCarriedCustodyBuckets(existing),
    gasReserve: existing?.gasReserve ?? { ...asset, amountAtomic: '0' },
    gasSpent: existing?.gasSpent ?? { ...asset, amountAtomic: '0' },
    gasPayments: existing?.gasPayments ?? [],
    verifiedCurrentBalance: observation,
    expectedCycleAsset: null,
  });
  if (existing !== null) await cycleRepository.recordCustodyLedger(leg.cycleId, refreshed);
  context?.assertLease?.();
  const ledger = Object.freeze({ ...refreshed, expectedCycleAsset });
  return cycleRepository.recordReturnRelayLegExpectation(leg.cycleId, leg, ledger, { destinationUsd });
}

function assertReturnRequest({ request, context, cycle, configured, money, nativeIdentity }) {
  if (!request || request.schema !== 'hookemon.return-relay-request.v2' || request.cycleId !== context.cycleId) {
    throw new Error('return requires the canonical request prepared for this cycle');
  }
  canonicalAmount(request.requestCreatedAtUnixSeconds, 'return request creation time');
  if (configured.maxSettlementWindowSeconds === null) {
    throw new Error('return requires a configured positive max settlement window before signing');
  }
  if (canonicalPositiveInteger(request.maxSettlementWindowSeconds, 'return request max settlement window seconds')
    !== configured.maxSettlementWindowSeconds) {
    throw new Error('return request settlement window does not match the configured bound');
  }
  if (!request.intent || request.intent.direction !== DIRECTIONS.RETURN || typeof request.intent.requestId !== 'string') {
    throw new Error('return canonical request is missing a RETURN Relay intent');
  }
  if (!sameAmount(request.inputAmount, {
    chainId: SOLANA_CHAIN_ID,
    assetId: configured.solanaMint,
    decimals: money.assets.solanaStablecoin.decimals,
    amountAtomic: request.inputAmount?.amountAtomic,
  }) || !sameAmount(request.destinationAmount, {
    chainId: EVM_CHAIN_ID,
    assetId: NATIVE_ASSET,
    decimals: money.assets.eth.decimals,
    amountAtomic: request.destinationAmount?.amountAtomic,
  })) {
    throw new Error('return request assets do not match MoneyConfigurationV2');
  }
  canonicalAmount(request.inputAmount.amountAtomic, 'return request input amount');
  canonicalAmount(request.destinationAmount.amountAtomic, 'return request destination amount');
  if (request.inputAmount.amountAtomic === '0') throw new Error('return requires positive cycle-attributed proceeds');
  const ledger = custodyLedgerFor(cycle, { chainId: nativeIdentity.chainId, assetId: nativeIdentity.assetId });
  if (request.inputAmount.amountAtomic !== returnableProceedsDelta(ledger)) {
    throw new Error('return may sign only the cycle-attributed proceeds delta');
  }
  if (request.intent.originChainId !== RELAY_CONSTANTS.SOLANA_CHAIN_ID
    || request.intent.destinationChainId !== RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID
    || request.intent.originAssetId !== request.inputAmount.assetId
    || request.intent.originDecimals !== request.inputAmount.decimals
    || String(request.intent.originAmount) !== request.inputAmount.amountAtomic
    || request.intent.destinationAssetId?.toLowerCase() !== request.destinationAmount.assetId
    || request.intent.destinationDecimals !== request.destinationAmount.decimals
    || String(request.intent.quotedDestinationAmount) !== request.destinationAmount.amountAtomic
    || request.intent.sender !== configured.solana
    || request.intent.recipient?.toLowerCase() !== configured.evm.toLowerCase()) {
    throw new Error('return Relay intent does not bind the configured accounts and typed amounts');
  }
  if (!request.solanaInstructionPlan || !Array.isArray(request.solanaInstructionPlan.instructions)
    || !Array.isArray(request.solanaInstructionPlan.addressLookupTableAddresses)) {
    throw new Error('return canonical request is missing a frozen Solana instruction plan');
  }
  return request;
}

export function canonicalPositiveInteger(value, label) {
  canonicalAmount(value, label);
  if (BigInt(value) === 0n) throw new Error(`${label} must be positive`);
  return value;
}

function assertReturnPriorityFeeCap(decoded, money) {
  if (decoded.priorityFee === null) return;
  if (decoded.priorityFee.chainId !== SOLANA_CHAIN_ID
    || decoded.priorityFee.assetId !== money.solana.priorityFeeCap.assetId
    || decoded.priorityFee.decimals !== money.solana.priorityFeeCap.decimals
    || BigInt(decoded.priorityFee.amountAtomic) > BigInt(money.solana.priorityFeeCap.amountAtomic)) {
    throw new Error('return Relay priority fee exceeds the configured MoneyConfigurationV2 cap');
  }
}

function maximumReturnPriorityFeeLamports(decoded) {
  if (decoded.priorityFee === null) return 0n;
  const computeUnitLimit = canonicalPositiveInteger(decoded.gas?.computeUnitLimit, 'return decoded compute-unit limit');
  const microLamports = BigInt(decoded.priorityFee.amountAtomic);
  return ((BigInt(computeUnitLimit) * microLamports) + 999_999n) / 1_000_000n;
}

export async function assertReturnLamportReserve({ client, configured, money, decoded }) {
  const balance = await readSolBalance(client, configured.solana);
  const reserve = BigInt(money.solana.lamportReserve.amountAtomic);
  const required = reserve + maximumReturnPriorityFeeLamports(decoded);
  if (balance < required) {
    throw new Error('return Operations SOL balance does not retain the configured lamport reserve after the maximum priority fee');
  }
}

function returnDecodeOptions({ client, blockhash, blockhashLastValidHeight }) {
  canonicalPositiveInteger(blockhashLastValidHeight, 'return blockhash last valid height');
  return Object.freeze({
    family: 'solana',
    chainId: SOLANA_CHAIN_ID,
    currentBlockHeightResolver: async () => readBlockHeight(client),
    blockhashContextResolver: async observedBlockhash => {
      if (observedBlockhash !== blockhash) {
        throw new Error('return signed Solana transaction blockhash does not match durable attempt evidence');
      }
      return Object.freeze({ blockhash, lastValidBlockHeight: blockhashLastValidHeight });
    },
  });
}

function requireReturnMutationAuthority(preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('return fixture authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('return fixture authority is invalid');
  return requireLiveMutationAuthority();
}

export async function createReturnPolicySigner({ signerClient, client, configured, request, transaction, requestDigest, blockhash, blockhashLastValidHeight, money, now, preflightAuthority, stage = 'return', recoveryRepository, context, nativePaymentBinding }) {
  if (!signerClient?.solana || typeof signerClient.solana.sign !== 'function'
    || (typeof signerClient.solana.broadcast !== 'function' && typeof signerClient.solana.broadcastApproved !== 'function')) {
    throw new Error('return requires an Operations Solana signer with sign and broadcast capabilities');
  }
  if (typeof now !== 'function') throw new Error('return requires a wall-clock function');
  const decodeOptions = returnDecodeOptions({ client, blockhash, blockhashLastValidHeight });
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction });
  if (decoded.format !== 'legacy'
    || decoded.chainId !== SOLANA_CHAIN_ID
    || decoded.addressLookupTables.length !== 0
    || decoded.feePayer !== configured.solana
    || !decoded.requiredSigners.includes(configured.solana)
    || decoded.blockhash !== blockhash) {
    throw new Error('return decoded Solana transaction does not match the frozen Relay instruction plan and cycle proceeds');
  }
  const sourceRuntime = assertNativeReturnInstruction({ binding: nativePaymentBinding, request, configured, transaction, blockhash });
  assertReturnPriorityFeeCap(decoded, money);
  const policy = createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage, requestDigest }),
    rules: [exactPolicyRule(decoded, 'relay-return-step')],
  });
  const policyRules = readTransactionPolicyRules(policy);
  const rawSigner = signerClient.solana;
  // ADR-0025 `retry-sign-only-with-durable-binding`: this facade only ever delegates to
  // `rawSigner`'s own methods unchanged, so it can carry the owned-Keychain attestation through to
  // the object `wrapTransactionPolicySignerClient` actually checks. `signApproved`/
  // `broadcastApproved` -- the stronger variants a Solana Keychain backend exposes once a real
  // broadcast transport is wired -- are forwarded only when `rawSigner` itself exposes them, so this
  // facade is a faithful, complete delegate rather than one that silently drops the path
  // `wrapTransactionPolicySignerClient` actually prefers.
  const delegatingClient = forwardOwnedKeychainSignOnlyIdentity(rawSigner, {
    role: rawSigner.role ?? OPERATOR_SOLANA_ROLE,
    sign: requestValue => rawSigner.sign(requestValue),
    ...(typeof rawSigner.broadcast === 'function'
      ? { broadcast: signed => rawSigner.broadcast(signed) }
      : {}),
    ...(typeof rawSigner.signApproved === 'function'
      ? { signApproved: (requestValue, proof) => rawSigner.signApproved(requestValue, proof) }
      : {}),
    ...(typeof rawSigner.broadcastApproved === 'function'
      ? { broadcastApproved: (signed, proof) => rawSigner.broadcastApproved(signed, proof) }
      : {}),
  });
  // `recoveryRepository` is the narrow, lease-fenced sign-only-recovery facade the stage driver
  // builds -- never the raw, unfenced `cycleRepository` `mutateReturn` uses for every other write.
  const recovery = recoveryRepository && context
    ? { repository: recoveryRepository, cycleId: context.cycleId, stage, requestDigest }
    : undefined;
  const policySigner = wrapTransactionPolicySignerClient({
    client: delegatingClient,
    policy,
    rules: policyRules,
    decodeOptions,
    recovery,
  });
  const quoteUsable = () => assertQuoteUsable({ quote: request.intent, nowMs: now() });
  return Object.freeze({
    decoded,
    policy,
    policyRules,
    policySigner,
    async sign() {
      quoteUsable();
      requireReturnMutationAuthority(preflightAuthority);
      await readCurrentRelaySourceRuntime(client, sourceRuntime);
      quoteUsable();
      return policySigner.sign({
        transaction,
        transactionPolicy: policy,
        transactionPolicyRules: policyRules,
        transactionDecodeOptions: decodeOptions,
        liveMode: true,
      });
    },
    async broadcast(signed) {
      quoteUsable();
      requireReturnMutationAuthority(preflightAuthority);
      await readCurrentRelaySourceRuntime(client, sourceRuntime);
      quoteUsable();
      return policySigner.broadcast(signed);
    },
  });
}

export function returnRecoveryContext({ context, requestDigest, rawSignedBytesHash, approval, blockhashLastValidHeight, stage = 'return' }) {
  return Object.freeze({
    stage,
    recipient: null,
    requestDigest,
    policyDigest: approval.policyDigest,
    approvalDigest: approval.approvalDigest,
    fencingToken: context.fencingToken,
    fencingTokenDigest: canonicalDigest({
      schema: 'hookemon.wallet-nonce-reservation.v1',
      chainId: SOLANA_CHAIN_ID,
      stage,
      fencingToken: context.fencingToken,
    }),
    approvedSemanticsDigest: approval.approvedSemanticsDigest,
    rawSignedBytesHash,
    signedMessageDigest: approval.signedMessageDigest,
    blockhashLastValidHeight,
  });
}

export function returnPolicyRecoveryContext(recoveryContext) {
  if (!recoveryContext || typeof recoveryContext !== 'object' || typeof recoveryContext.blockhashLastValidHeight !== 'string') {
    throw new ReturnRecoveryRequiredError(
      'RETURN_SIGNED_BLOCKHASH_CONTEXT_MISSING',
      'the signed return bytes have no durable blockhash validity context and cannot be reauthorized',
    );
  }
  canonicalPositiveInteger(recoveryContext.blockhashLastValidHeight, 'return durable blockhash last valid height');
  for (const field of ['policyDigest', 'approvalDigest', 'approvedSemanticsDigest', 'signedMessageDigest']) {
    if (!DIGEST.test(recoveryContext[field] ?? '')) {
      throw new ReturnRecoveryRequiredError('RETURN_SIGNED_POLICY_CONTEXT_INVALID', 'the signed return bytes have an invalid policy recovery context');
    }
  }
  return Object.freeze({
    schema: 'hookemon.transaction-policy-approval.v1',
    family: 'solana',
    policyDigest: recoveryContext.policyDigest,
    approvalDigest: recoveryContext.approvalDigest,
    approvedSemanticsDigest: recoveryContext.approvedSemanticsDigest,
    signedMessageDigest: recoveryContext.signedMessageDigest,
  });
}

export function assertReturnBroadcastHash(result, expectedHash) {
  const transactionHash = typeof result === 'string' ? result : result?.transactionHash ?? result?.signature;
  if (typeof transactionHash !== 'string' || transactionHash !== expectedHash) {
    throw new Error('return broadcaster returned a hash that does not match the persisted signed Solana bytes');
  }
  return expectedHash;
}

async function readOrPrepareReturnAttempt({ cycleRepository, context, request }) {
  const requestDigest = returnStepRequestDigest(context, request);
  let record = await cycleRepository.readChainTransactionAttempt(context.cycleId, 'return', requestDigest);
  if (record === null) {
    await cycleRepository.prepareChainTransactionAttempt(
      context.cycleId,
      'return',
      createPreparedChainTransactionAttempt({ cycleId: context.cycleId, stage: 'return', requestDigest }),
    );
    record = await cycleRepository.readChainTransactionAttempt(context.cycleId, 'return', requestDigest);
  }
  if (!record) throw new Error('return chain attempt was not persisted before signing');
  return { requestDigest, record };
}

/**
 * Persists the Relay leg and exact raw Solana bytes before broadcast. A restart cannot create a
 * replacement transaction: it reauthorizes only those bytes against the recorded policy approval
 * and the original blockhash lifetime.
 */
export async function mutateReturn({
  liveMode,
  adapters,
  signerClient,
  config,
  cycleRepository,
  signOnlyRecoveryRepository,
  context,
  request,
  preflightAuthority,
  now = Date.now,
}) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateReturn reached without liveMode');
  if (typeof context?.requestDigest !== 'string' || !DIGEST.test(context.requestDigest)) {
    throw new Error('return requires the durable stage request digest');
  }
  const configured = assertReturnConfiguration(config);
  const money = assertReturnMoneyConfiguration(config, configured);
  if (request?.schema === 'hookemon.return-zero-proceeds-request.v2') {
    const evidence = zeroProceedsReturnEvidence({ request, context, configured, money });
    if (typeof cycleRepository?.readStageAttempt !== 'function' || typeof cycleRepository?.recordStageAttempt !== 'function') {
      throw new Error('return zero-proceeds settlement requires a durable stage-attempt repository');
    }
    if (typeof cycleRepository?.describeCycle !== 'function') {
      throw new Error('return zero-proceeds settlement requires cycleRepository.describeCycle to recheck current proceeds');
    }
    // A durable zero-proceeds request or its already-recorded evidence is never trusted from its
    // own shape alone: this rechecks the current native ledger (and refuses a competing row)
    // every time, first creation and every replay alike, so a stale false-zero produced before
    // this identity fix can never finalize or replay while positive attributed proceeds exist now.
    const cycle = await cycleRepository.describeCycle(context.cycleId);
    const nativeIdentity = resolveReturnNativeSolanaCustodyIdentity(config, configured, money);
    assertNoCompetingReturnCustodyLedger(cycle, nativeIdentity);
    const ledger = custodyLedgerFor(cycle, { chainId: nativeIdentity.chainId, assetId: nativeIdentity.assetId });
    if (ledger !== null && returnableProceedsDelta(ledger) !== '0') {
      throw new Error('return zero-proceeds request conflicts with a positive cycle-attributed proceeds delta observed now');
    }
    if (ledger === null) {
      await assertReturnNoSoldEvidenceWithoutLedger({ cycleRepository, context });
    }
    const existing = await cycleRepository.readStageAttempt(context.cycleId, 'return');
    if (existing !== null && existing !== undefined) {
      if (canonicalDigest(existing) !== canonicalDigest(evidence)) {
        throw new Error('return zero-proceeds settlement conflicts with recorded evidence');
      }
      return evidence;
    }
    await cycleRepository.recordStageAttempt(context.cycleId, 'return', evidence);
    return evidence;
  }
  assertReturnMutationRepository(cycleRepository);
  const client = adapters?.solana?.client;
  if (!client) throw new Error('return requires a configured Solana RPC client');
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  const nativeIdentity = resolveReturnNativeSolanaCustodyIdentity(config, configured, money);
  assertNoCompetingReturnCustodyLedger(cycle, nativeIdentity);
  assertReturnRequest({ request, context, cycle, configured, money, nativeIdentity });
  assertQuoteUsable({ quote: request.intent, nowMs: now() });
  const candidateLeg = returnRelayLeg(context, request);
  const existingLeg = cycle?.relayLegs?.get?.(candidateLeg.relayRequestId) ?? null;
  if (existingLeg === null) {
    // A genuinely new leg: the atomic custody-v2 creator runs exactly once, here, before any
    // nonce reservation or signing. `sourceTxHash`/`state` only ever advance after this point, so
    // this call is never repeated against the same relayRequestId.
    await recordReturnCustodyExpectation({ cycleRepository, cycle, leg: candidateLeg, configured, money, adapters, context, destinationUsd: request.destinationUsd });
  } else {
    if (canonicalDigest(returnLegIdentity(existingLeg)) !== canonicalDigest(returnLegIdentity(candidateLeg))) {
      throw new Error('return Relay request id already has different durable leg evidence');
    }
    // A resume of an already-durable leg: prove its canonical association and open expectation
    // before any nonce reservation or signing resumes, rather than trusting matching request
    // identity alone -- a leg durably created only through the legacy bare `recordRelayLeg` would
    // otherwise reach new effects here with no association at all.
    assertReturnCustodyExpectationOpenForLeg(cycle, existingLeg, money);
  }
  const reservation = await reserveReturnWalletNonce({ cycleRepository, configured, context });
  const attempt = await readOrPrepareReturnAttempt({ cycleRepository, context, request });
  let { record } = attempt;

  if (record.attempt.state === 'PREPARED') {
    await assertReturnWalletNonce({ cycleRepository, context, reservation });
    const latest = await readUsableLatestBlockhash(client);
    const blockhashLastValidHeight = canonicalPositiveInteger(String(latest.lastValidBlockHeight), 'return latest blockhash last valid height');
    const transaction = buildRelayLegacyTransaction({
      feePayer: configured.solana,
      recentBlockhash: latest.blockhash,
      instructionPlan: request.solanaInstructionPlan,
    });
    const approved = await createReturnPolicySigner({
      nativePaymentBinding: config.nativePaymentBinding,
      signerClient,
      client,
      configured,
      request,
      transaction,
      requestDigest: attempt.requestDigest,
      blockhash: latest.blockhash,
      blockhashLastValidHeight,
      money,
      now,
      preflightAuthority,
      recoveryRepository: signOnlyRecoveryRepository,
      context,
    });
    await assertReturnLamportReserve({ client, configured, money, decoded: approved.decoded });
    const signed = await approved.sign();
    if (typeof signed?.signedTxBase64 !== 'string' || signed.signedTxBase64.length === 0) {
      throw new Error('return signer did not return serialized Solana bytes');
    }
    const approval = readTransactionPolicyApprovalContext(approved.policySigner, signed);
    const rawSignedBytesHash = approval.signedMessageDigest;
    const sourceTransactionHash = signedSolanaTransactionSignature(signed.signedTxBase64);
    const recoveryContext = returnRecoveryContext({
      context,
      requestDigest: attempt.requestDigest,
      rawSignedBytesHash,
      approval,
      blockhashLastValidHeight,
    });
    const signingMaterial = {
      rawBytes: signed.signedTxBase64,
      nonce: null,
      blockhash: latest.blockhash,
      hash: rawSignedBytesHash,
    };
    if (typeof cycleRepository.recordSignedTransactionWithRecoveryContext === 'function') {
      record = await cycleRepository.recordSignedTransactionWithRecoveryContext(
        context.cycleId,
        'return',
        attempt.requestDigest,
        signingMaterial,
        recoveryContext,
        { relayRequestId: request.intent.requestId, sourceTxHash: sourceTransactionHash },
      );
    } else {
      record = await cycleRepository.recordSignedTransaction(context.cycleId, 'return', attempt.requestDigest, signingMaterial);
      await cycleRepository.persistChainAttemptRecoveryContext(context.cycleId, recoveryContext);
      await cycleRepository.recordRelayLegSource(context.cycleId, request.intent.requestId, sourceTransactionHash);
    }
  }

  if (record.attempt.state === 'SIGNED') {
    await assertReturnWalletNonce({ cycleRepository, context, reservation });
    const recoveryContext = await cycleRepository.readChainAttemptRecoveryContext(context.cycleId, {
      stage: 'return',
      recipient: null,
      requestDigest: attempt.requestDigest,
      rawSignedBytesHash: record.attempt.hash,
    });
    const policyRecovery = returnPolicyRecoveryContext(recoveryContext);
    const blockhashLastValidHeight = recoveryContext.blockhashLastValidHeight;
    const currentBlockHeight = await readBlockHeight(client);
    if (currentBlockHeight > BigInt(blockhashLastValidHeight)) {
      throw new ReturnRecoveryRequiredError(
        'RETURN_SIGNED_BLOCKHASH_EXPIRED',
        'the signed return bytes have expired and cannot be re-signed automatically',
        { blockhash: record.attempt.blockhash, blockhashLastValidHeight },
      );
    }
    const approved = await createReturnPolicySigner({
      nativePaymentBinding: config.nativePaymentBinding,
      signerClient,
      client,
      configured,
      request,
      transaction: record.attempt.rawBytes,
      requestDigest: attempt.requestDigest,
      blockhash: record.attempt.blockhash,
      blockhashLastValidHeight,
      money,
      now,
      preflightAuthority,
    });
    await assertReturnLamportReserve({ client, configured, money, decoded: approved.decoded });
    requireReturnMutationAuthority(preflightAuthority);
    const result = await recoverTransactionPolicyBroadcast({
      client: approved.policySigner,
      signed: { signedTxBase64: record.attempt.rawBytes },
      recoveryContext: policyRecovery,
    });
    const sourceTransactionHash = signedSolanaTransactionSignature(record.attempt.rawBytes);
    assertReturnBroadcastHash(result, sourceTransactionHash);
    record = await cycleRepository.recordBroadcast(
      context.cycleId,
      'return',
      attempt.requestDigest,
      Object.freeze({ transactionHash: sourceTransactionHash }),
    );
  }
  if (!['BROADCAST', 'FINALIZED'].includes(record.attempt.state)) {
    throw new Error(`return chain attempt is in unexpected state ${record.attempt.state}`);
  }
  return Object.freeze({
    relayRequestId: request.intent.requestId,
    sourceTransactionHash: signedSolanaTransactionSignature(record.attempt.rawBytes),
    chainAttemptState: record.attempt.state,
  });
}

function stateValues(value) {
  return value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
}

function legacyUnauthenticatedReturnAttempt(attempt) {
  const intent = attempt?.responseEvidence?.intent ?? attempt?.intent ?? null;
  if (!intent || typeof intent !== 'object') return null;
  return intent;
}

/** Native return facts are reconstructed from finalized source bytes and release-bound router semantics. */
export async function readReturnLegDestinationProof({ client, pointer, leg, sourceProof, nativePaymentBinding }) {
  if (!pointer || pointer.schema !== 'hookemon.relay-terminal-destination-pointer.v1'
    || pointer.relayRequestId !== leg?.relayRequestId || pointer.status !== 'SUCCESS'
    || typeof pointer.destinationTxHash !== 'string' || !EVM_TRANSACTION_HASH.test(pointer.destinationTxHash)) {
    throw new Error('return destination proof requires an authenticated successful Relay transaction pointer');
  }
  if (leg.schema !== 'hookemon.relay-leg.v2' || leg.destinationAssetId !== NATIVE_ASSET || leg.destinationDecimals !== 18) {
    throw new Error('native return refuses historical token legs');
  }
  const native = await createRelayNativePaymentProof({ client, binding: nativePaymentBinding, sourceProof,
    expected: { kind: 'relay-return', chainId: EVM_CHAIN_ID, assetId: NATIVE_ASSET, decimals: 18,
      transactionHash: pointer.destinationTxHash, relayRequestId: leg.relayRequestId,
      orderId: leg.returnAttribution.intent.orderId, recipient: leg.returnAttribution.intent.recipient,
      sourceTransactionHash: leg.sourceTxHash, sourceOwner: leg.returnAttribution.intent.sender,
      sourceMint: leg.sourceAssetId, sourceAmountAtomic: leg.sourceAmountAtomic } });
  const proof = assertReturnLegDestinationProof({
    schema: 'hookemon.return-leg-destination-proof.v2', relayRequestId: leg.relayRequestId,
    terminalStatus: { status: 'SUCCESS', destinationTxHash: native.transactionHash },
    sourceTxHash: leg.sourceTxHash, sourceFinality: sourceProof.finality,
    destinationTxHash: native.transactionHash,
    destinationFinality: { height: native.blockNumber, hash: native.blockHash, timestampUnixSeconds: native.timestampUnixSeconds },
    transferCount: 1, observedToken: NATIVE_ASSET, observedRecipient: native.recipient, observedAmountAtomic: native.amountWei,
    nativePaymentProof: native,
  });
  processRpcReturnLegDestinationProofs.set(proof, Object.freeze({ proofDigest: canonicalDigest(proof),
    relayRequestId: proof.relayRequestId, sourceTxHash: proof.sourceTxHash, destinationTxHash: proof.destinationTxHash }));
  return proof;
}

/**
 * Before trusting a return leg's settlement -- whether about to credit it for the first time or
 * returning a durably SETTLED leg's cached success -- proves the leg has an exact durable canonical
 * custody association (ADR-0026), never derived or accepted from its raw destination identity. A
 * leg with no association (including one settled before this migration, or one this repository
 * only ever recorded through the legacy bare `recordRelayLeg`) refuses rather than being trusted
 * from its raw identity; a legacy raw-identity row for this asset -- present at all, whether or not
 * it is where the leg's own credit landed -- also refuses, since only the canonical association is
 * ever a legitimate identity going forward. Preserves every historical row and leg byte; recovery
 * is an explicit owner decision, never a silent migration performed here.
 */
function assertReturnCanonicalCustodyAssociation(cycle, leg, money) {
  const asset = returnCustodyAsset(money);
  const canonicalKey = returnCustodyLedgerKey(asset);
  const rawKey = legacyRawReturnCustodyKey(leg);
  const associatedKey = cycle?.returnLegLedgerKeys?.get?.(leg.relayRequestId) ?? null;
  if (associatedKey !== canonicalKey) {
    throw new ReturnRecoveryRequiredError(
      'RETURN_CUSTODY_ASSOCIATION_MISSING',
      'the return leg has no durable canonical custody ledger association and cannot be trusted from its raw identity',
    );
  }
  const row = cycle?.custodyLedgers?.get?.(canonicalKey) ?? null;
  if (row === null || row.schema !== 'hookemon.custody-ledger.v3'
    || row.chainId !== asset.chainId || row.assetId !== asset.assetId || row.decimals !== asset.decimals) {
    throw new ReturnRecoveryRequiredError(
      'RETURN_CUSTODY_ASSOCIATION_MISSING',
      "the return leg's durable canonical association does not resolve to a matching v2 custody ledger row",
    );
  }
  if (rawKey !== canonicalKey && (cycle?.custodyLedgers?.get?.(rawKey) ?? null) !== null) {
    throw new ReturnRecoveryRequiredError(
      'RETURN_CUSTODY_IDENTITY_SPLIT',
      'a legacy raw-identity USDG custody row exists for this asset alongside the return leg\'s canonical association and requires operator recovery',
    );
  }
}

/**
 * For a resumed RECORDED leg only, on top of the canonical association above: proves the row's
 * still-open `expectedCycleAsset` is this exact leg's own unresolved destination obligation --
 * never a different leg's, and never one already cleared by a settlement this process has not yet
 * observed. `mutateReturn` calls this before any nonce reservation or signing resumes on an
 * already-durable leg, so a leg that only ever reached durable state through the legacy bare
 * `recordRelayLeg` (identical immutable request identity, no association) refuses here exactly as
 * a genuinely new leg would, instead of quietly reaching new effects on resume.
 */
function assertReturnCustodyExpectationOpenForLeg(cycle, leg, money) {
  assertReturnCanonicalCustodyAssociation(cycle, leg, money);
  const asset = returnCustodyAsset(money);
  const canonicalKey = returnCustodyLedgerKey(asset);
  const row = cycle?.custodyLedgers?.get?.(canonicalKey) ?? null;
  const expected = {
    chainId: asset.chainId,
    assetId: asset.assetId,
    decimals: asset.decimals,
    amountAtomic: leg.destinationAmountAtomic,
  };
  if (canonicalDigest(row?.expectedCycleAsset ?? null) !== canonicalDigest(expected)) {
    throw new ReturnRecoveryRequiredError(
      'RETURN_CUSTODY_ASSOCIATION_MISSING',
      "the return leg's durable custody row does not carry this leg's own unresolved expectation",
    );
  }
}

/**
 * The one payout-facing projection of a SETTLED return leg, built identically whether this is the
 * first observed settlement or a later durable replay of the same leg -- so the returnBinding
 * digest downstream (payout.mjs) never diverges between the two. Never trusts the leg's own
 * `destinationAmountAtomic` as received proceeds -- that field is the Relay quote, not a receipt.
 * The credited amount is always `netDeltaAtomic`, the repository-derived observed amount proven
 * from the finalized destination receipt (ADR-0026 / cycle-repository settleRelayLeg). `finalized`
 * is only ever true once every check below -- cycle, finality, recipient, and asset identity --
 * has independently passed, never assumed from the leg's recorded `state` alone.
 */
function returnPayoutSettlementEvidence(leg, { configured, money, context }) {
  if (leg.state !== 'SETTLED') {
    throw new Error('return payout evidence requires a SETTLED relay leg');
  }
  if (leg.cycleId !== context.cycleId) {
    throw new Error('return leg cycleId does not match the reconciling cycle');
  }
  if (!leg.finalizedAtSource || !leg.finalizedAtDestination) {
    throw new Error('return leg is missing finalized source or destination evidence');
  }
  const recipient = leg.returnAttribution?.intent?.recipient;
  if (typeof recipient !== 'string' || recipient.toLowerCase() !== configured.evm.toLowerCase()) {
    throw new Error('return leg attributed recipient does not match the configured Operations EVM account');
  }
  if (leg.destinationChainId !== EVM_CHAIN_ID
    || typeof leg.destinationAssetId !== 'string' || leg.destinationAssetId.toLowerCase() !== NATIVE_ASSET
    || leg.destinationDecimals !== money.assets.eth.decimals) {
    throw new Error('return leg destination asset does not match the configured native ETH identity');
  }
  const destinationCreditAmount = canonicalAmount(leg.netDeltaAtomic, 'return leg netDeltaAtomic');
  return Object.freeze({
    schema: 'hookemon.return-relay-settlement-evidence.v2',
    finalized: true,
    destinationAccount: recipient,
    destinationAsset: leg.destinationAssetId,
    destinationCreditAmount,
    relayLeg: Object.freeze(structuredClone(leg)),
  });
}

/**
 * Finalizes the source chain attempt only after this process's own finalized Solana RPC proof,
 * then binds an authenticated Relay hash pointer to a separately finalized EVM receipt proof.
 */
export async function reconcileLiveReturn({ adapters, config, cycleRepository, context }) {
  if (typeof cycleRepository?.readStageAttempt === 'function') {
    const zeroEvidence = await cycleRepository.readStageAttempt(context.cycleId, 'return');
    if (zeroEvidence?.schema === 'hookemon.return-zero-proceeds-evidence.v2') {
      const configured = assertReturnConfiguration(config);
      const money = assertReturnMoneyConfiguration(config, configured);
      if (!isZeroProceedsReturnEvidence(zeroEvidence, { cycleId: context.cycleId, configured, money })) {
        throw new ReturnRecoveryRequiredError(
          'RETURN_ZERO_PROCEEDS_EVIDENCE_INVALID',
          'the durable zero-proceeds return evidence does not bind the configured cycle route',
        );
      }
      // A durably recorded zero-proceeds evidence is not trusted from its recorded shape alone: a
      // record produced before this identity fix (via the wrong Relay-wire lookup) could be a false
      // zero for a genuinely sold cycle. Reverify against the current native ledger every time this
      // reconciles, so a stale false zero can never keep reporting settled while positive
      // cycle-attributed proceeds now exist.
      if (typeof cycleRepository?.describeCycle !== 'function') {
        throw new ReturnRecoveryRequiredError(
          'RETURN_ZERO_PROCEEDS_EVIDENCE_UNVERIFIABLE',
          'the durable zero-proceeds return evidence cannot be rechecked against current custody without cycleRepository.describeCycle',
        );
      }
      const zeroCycle = await cycleRepository.describeCycle(context.cycleId);
      const zeroNativeIdentity = resolveReturnNativeSolanaCustodyIdentity(config, configured, money);
      assertNoCompetingReturnCustodyLedger(zeroCycle, zeroNativeIdentity);
      const zeroLedger = custodyLedgerFor(zeroCycle, { chainId: zeroNativeIdentity.chainId, assetId: zeroNativeIdentity.assetId });
      if (zeroLedger !== null && returnableProceedsDelta(zeroLedger) !== '0') {
        throw new ReturnRecoveryRequiredError(
          'RETURN_ZERO_PROCEEDS_EVIDENCE_STALE',
          'the durable zero-proceeds return evidence conflicts with a positive cycle-attributed proceeds delta observed now',
        );
      }
      if (zeroLedger === null) {
        if (typeof cycleRepository?.readStageAttempt !== 'function') {
          throw new ReturnRecoveryRequiredError(
            'RETURN_ZERO_PROCEEDS_EVIDENCE_UNVERIFIABLE',
            'the durable zero-proceeds return evidence cannot be rechecked against durable buyback evidence without cycleRepository.readStageAttempt',
          );
        }
        const zeroBuybackAttempt = await cycleRepository.readStageAttempt(context.cycleId, 'buyback');
        if (hasDurableSoldBuybackEvidence(zeroBuybackAttempt)) {
          throw new ReturnRecoveryRequiredError(
            'RETURN_ZERO_PROCEEDS_EVIDENCE_SOLD_WITHOUT_LEDGER',
            'the durable zero-proceeds return evidence conflicts with durable buyback evidence recording a sold pack with no matching native custody ledger row',
          );
        }
      }
      return Object.freeze(structuredClone(zeroEvidence));
    }
  }
  if (typeof cycleRepository?.describeCycle !== 'function') {
    const intent = legacyUnauthenticatedReturnAttempt(await cycleRepository.readOperationalStageAttempt?.(context.cycleId, 'return'));
    if (intent === null) return null;
    throw new ReturnRecoveryRequiredError(
      'RETURN_SETTLEMENT_UNATTESTED',
      'Relay status cannot authenticate the source transfer, destination receipt, and one-time cycle settlement',
      { intent },
    );
  }
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  const legs = stateValues(cycle?.relayLegs).filter(leg => leg?.direction === 'return');
  if (legs.length === 0) return null;
  if (legs.length !== 1) throw new ReturnRecoveryRequiredError('RETURN_RELAY_LEG_AMBIGUOUS', 'more than one recorded return Relay leg requires operator recovery');
  const leg = legs[0];
  const records = stateValues(cycle?.chainAttempts).filter(record => record?.attempt?.stage === 'return');
  if (leg.state === 'SETTLED') {
    const configured = assertReturnConfiguration(config);
    const money = assertReturnMoneyConfiguration(config, configured);
    assertReturnCanonicalCustodyAssociation(cycle, leg, money);
    return returnPayoutSettlementEvidence(leg, { configured, money, context });
  }
  if (leg.state === 'RECORDED') {
    const configured = assertReturnConfiguration(config);
    const money = assertReturnMoneyConfiguration(config, configured);
    assertReturnCanonicalCustodyAssociation(cycle, leg, money);
  }
  if (leg.state !== 'RECORDED') {
    if (TERMINAL_RELAY_LEG_STATES.has(leg.state) && records.length === 1 && records[0].attempt?.state === 'FINALIZED') {
      const configured = assertReturnConfiguration(config);
      await releaseReturnWalletNonce({ cycleRepository, configured, context });
    }
    return null;
  }
  if (typeof leg.sourceTxHash !== 'string' || leg.sourceTxHash.length === 0) return null;
  if (records.length !== 1) throw new ReturnRecoveryRequiredError('RETURN_CHAIN_ATTEMPT_AMBIGUOUS', 'the return Relay leg cannot be matched to one durable chain attempt');
  let record = records[0];
  if (!['SIGNED', 'BROADCAST', 'FINALIZED'].includes(record.attempt.state) || !adapters?.solana?.client) return null;
  const configured = assertReturnConfiguration(config);
  let source;
  try {
    source = await readReleaseBoundRelaySourceDebit({ client: adapters.solana.client, binding: config.nativePaymentBinding,
      signature: leg.sourceTxHash,
      owner: config?.accounts?.solana,
      mint: leg.sourceAssetId,
      amountAtomic: leg.sourceAmountAtomic,
      signedTransactionBase64: record.attempt.rawBytes,
    });
  } catch {
    return null;
  }
  if (record.attempt.state === 'SIGNED') {
    record = await cycleRepository.recordBroadcast(context.cycleId, 'return', record.attempt.requestDigest, {
      transactionHash: leg.sourceTxHash,
    });
  }
  if (record.attempt.state !== 'FINALIZED') {
    record = await cycleRepository.recordFinality(context.cycleId, 'return', record.attempt.requestDigest, {
      transactionHash: source.transactionHash,
      debitedAmountAtomic: source.debitedAmountAtomic,
      finalizedAtSource: source.finality,
    });
  }
  if (record.attempt.state !== 'FINALIZED') {
    throw new ReturnRecoveryRequiredError(
      'RETURN_SOURCE_FINALITY_UNRECORDED',
      'the observed return source finality did not durably finalize its chain attempt',
    );
  }
  await releaseReturnWalletNonce({ cycleRepository, configured, context });
  if (!adapters?.relay || !adapters?.robinhood?.client || !leg.returnAttribution) return null;
  let proof;
  try {
    adapters.relay.restoreIntent({ intent: leg.returnAttribution.intent });
    const pointer = await adapters.relay.getTerminalDestinationTransactionPointer({
      intentDigest: leg.returnAttribution.intent.requestId,
    });
    if (pointer === null) return null;
    proof = await readReturnLegDestinationProof({
      client: adapters.robinhood.client,
      pointer,
      leg,
      sourceProof: source,
      nativePaymentBinding: config.nativePaymentBinding,
    });
  } catch {
    return null;
  }
  if (proof === null) return null;
  const settled = await cycleRepository.settleRelayLeg(context.cycleId, leg.relayRequestId, {
    returnDestinationProof: proof,
  });
  if (settled.state !== 'SETTLED') return null;
  const money = assertReturnMoneyConfiguration(config, configured);
  return returnPayoutSettlementEvidence(settled, { configured, money, context });
}

/** Retained only to fail closed for a removed Phase 2 custody route. */
export async function submitDegradedReturnAcceptance() {
  throw new Error('accept-degraded-return is unavailable in the Phase 3 Operations model');
}
