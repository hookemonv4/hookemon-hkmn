import { applyNativeCustodyGasPayment } from '../../native-payment-proof.mjs';
import { createRelayNativePaymentProof } from '../../native-payment-proof.mjs';
import { createNativeCustodyBalanceObservationReader } from '../../evm-custody-balance-observation.mjs';
import { createNativePaymentProof, createNativeTransactionGasProof, isProcessNativePaymentProof } from '../../native-payment-proof.mjs';
import {
  DIRECTIONS,
  RELAY_CONSTANTS,
  RelayQuoteExpiredError,
  assertQuoteUsable,
  relayQuoteDigest,
} from '../../relay-client.mjs';
import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import {
  ERC20_TRANSFER_TOPIC,
  readBlockByNumber,
  readFinalizedErc20TransferProof,
  readFinalizedTransactionReceipt,
} from '../../robinhood-rpc.mjs';
import { discoverFinalizedRelayDestinationObservation } from '../../solana-rpc.mjs';
import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  readTransactionPolicyRules,
} from '../../signing/transaction-policy.mjs';
import {
  readTransactionPolicyApprovalContext,
  recoverTransactionPolicyBroadcast,
  wrapTransactionPolicySignerClient,
} from '../../signing/signer-client.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';
import {
  assertMoneyConfiguration,
  createPreparedChainTransactionAttempt,
} from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
} from '../../../../runner/src/cycle/preflight.mjs';
import { walletNonceLeaseWindow, resolveWalletNonceReservation } from '../wallet-nonce-lease.mjs';

const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_DATA = /^0x[0-9a-fA-F]*$/;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_WORD = /^0x[0-9a-fA-F]{64}$/;
const EVM_CHAIN_ID = String(RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID);
const SOLANA_CHAIN_ID = String(RELAY_CONSTANTS.SOLANA_CHAIN_ID);
const NATIVE_ADDRESS = RELAY_CONSTANTS.NATIVE_ADDRESS;
const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const RELAY_DEPOSIT_SELECTOR = '0x49290c1c';
const TERMINAL_RELAY_LEG_STATES = new Set([
  'SETTLED',
  'HELD_RELAY_PARTIAL',
  'HELD_RELAY_REFUND',
  'HELD_RELAY_LATE',
  'HELD_RELAY_WRONG_ASSET',
]);
const outboundPlanBrand = new WeakSet();
const processRpcOutboundRefundProofs = new WeakMap();
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

export class OutboundRecoveryRequiredError extends Error {
  constructor(recoveryState, message, details = {}) {
    super(message);
    this.name = 'OutboundRecoveryRequiredError';
    this.stage = 'outbound';
    this.recoveryState = recoveryState;
    this.retryable = false;
    Object.assign(this, details);
  }
}

/**
 * Runtime-only proof capability issued after a request-bound refund pointer is re-read through
 * this process's Robinhood RPC client. Durable state retains only normalized evidence.
 */
export function isProcessRpcOutboundRefundProof(value, expected = {}) {
  if (value === null || typeof value !== 'object') return false;
  const observed = processRpcOutboundRefundProofs.get(value);
  if (!observed) return false;
  let proofDigest;
  try {
    proofDigest = digest(value);
  } catch {
    return false;
  }
  return proofDigest === observed.proofDigest
    && (expected.relayRequestId === undefined || observed.relayRequestId === expected.relayRequestId)
    && (expected.sourceTxHash === undefined || observed.sourceTxHash === String(expected.sourceTxHash).toLowerCase())
    && (expected.refundTxHash === undefined || observed.refundTxHash === String(expected.refundTxHash).toLowerCase())
    && (expected.observedSource === undefined || observed.observedSource === String(expected.observedSource).toLowerCase());
}

function canonicalAmount(value, label) {
  if (typeof value !== 'string' || !ATOMIC_AMOUNT.test(value)) throw new Error(`${label} must be a canonical atomic amount`);
  return value;
}

function equalEvmAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function typedAmount(leg) {
  return Object.freeze({
    chainId: String(leg.chainId),
    assetId: leg.chainId === RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID && leg.address.toLowerCase() === NATIVE_ADDRESS ? 'native' : leg.address,
    decimals: leg.decimals,
    amountAtomic: leg.amount,
  });
}

function assertOutboundConfiguration(config, { requireDepository = true } = {}) {
  const evm = config?.accounts?.evm;
  const solana = config?.accounts?.solana;
  const solanaMint = config?.relay?.solanaMint;
  const evmDepository = config?.relay?.evmDepository;
  if (!EVM_ADDRESS.test(evm ?? '')) throw new Error('outbound requires a configured Operations EVM account');
  if (typeof solana !== 'string' || solana.length === 0) throw new Error('outbound requires a configured Operations Solana account');
  if (typeof solanaMint !== 'string' || solanaMint.length === 0) throw new Error('outbound requires a configured Solana mint');
  if (requireDepository && !EVM_ADDRESS.test(evmDepository ?? '')) {
    throw new Error('outbound requires a configured Relay EVM depository allowlist address');
  }
  return Object.freeze({
    evm,
    solana,
    solanaMint,
    evmDepository,
    chainId: config.chainId ?? RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID,
  });
}

function assertOutboundMoneyConfiguration(config, configured) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, 'outbound money configuration');
  } catch (error) {
    throw new Error(`outbound requires MoneyConfigurationV2: ${error.message}`);
  }
  if (money.assets.eth.chainId !== EVM_CHAIN_ID || money.assets.eth.assetId !== 'native' || money.assets.eth.decimals !== 18) {
    throw new Error('outbound MoneyConfigurationV2 USDG asset does not match the configured Robinhood route');
  }
  if (money.assets.solanaStablecoin.chainId !== SOLANA_CHAIN_ID
    || money.assets.solanaStablecoin.assetId !== configured.solanaMint) {
    throw new Error('outbound MoneyConfigurationV2 Solana asset does not match the configured Relay route');
  }
  return money;
}

function assertOutboundQuote(quote, config, money = null) {
  if (!quote || quote.direction !== DIRECTIONS.OUTBOUND) throw new Error('outbound requires an OUTBOUND Relay quote');
  if (quote.tradeType !== 'EXACT_OUTPUT') throw new Error('outbound requires an EXACT_OUTPUT Relay quote');
  if (quote.origin?.chainId !== RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID || quote.origin?.address?.toLowerCase() !== NATIVE_ADDRESS) {
    throw new Error('outbound quote origin is not USDG on chain 4663');
  }
  if (quote.destination?.chainId !== RELAY_CONSTANTS.SOLANA_CHAIN_ID || quote.destination?.address !== config.solanaMint) {
    throw new Error('outbound quote destination does not match the configured Solana mint');
  }
  if (!equalEvmAddress(quote.sender, config.evm)) throw new Error('outbound quote sender does not match Operations EVM account');
  if (quote.recipient !== config.solana) throw new Error('outbound quote recipient does not match Operations Solana account');
  canonicalAmount(quote.origin.amount, 'outbound quote origin amount');
  canonicalAmount(quote.destination.amount, 'outbound quote destination amount');
  if (!Number.isInteger(quote.origin.decimals) || !Number.isInteger(quote.destination.decimals)) {
    throw new Error('outbound quote is missing asset decimals');
  }
  if (money !== null && (quote.origin.decimals !== money.assets.eth.decimals
    || quote.destination.decimals !== money.assets.solanaStablecoin.decimals)) {
    throw new Error('outbound quote decimals do not match MoneyConfigurationV2 assets');
  }
  return quote;
}

function assertAdmittedAmount(value, expected, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} is required`);
  if (String(value.chainId) !== expected.chainId
    || value.assetId !== expected.assetId
    || value.decimals !== expected.decimals) {
    throw new Error(`${label} asset identity does not match the configured money asset`);
  }
  return canonicalAmount(value.amountAtomic, `${label} amount`);
}

/**
 * The admission is produced and durably bound by the policy layer before this stage. This stage
 * deliberately has no quote fallback: the signed Relay steps must be for that one admission.
 */
function assertOutboundAdmission(admission, configured, money, cycleId) {
  if (!admission || typeof admission !== 'object' || !['hookemon.policy-admission.v3', 'hookemon.policy-admission.v4'].includes(admission.schema)) {
    throw new Error('outbound requires a durable policy-admission.v3 record');
  }
  if (admission.cycleId !== cycleId) throw new Error('outbound admission cycle identity does not match the request');
  if (typeof admission.quoteDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(admission.quoteDigest)) {
    throw new Error('outbound admission quote digest is invalid');
  }
  const usdg = { chainId: EVM_CHAIN_ID, assetId: 'native', decimals: money.assets.eth.decimals };
  const solana = { chainId: SOLANA_CHAIN_ID, assetId: configured.solanaMint, decimals: money.assets.solanaStablecoin.decimals };
  const units = admission.schema === 'hookemon.policy-admission.v4' ? admission.orders : [admission];
  if (!Array.isArray(units) || units.length === 0) throw new Error('outbound admission requires unit orders');
  const unitFunding = units.map(order => assertAdmittedAmount(order.unitFundingQuote, usdg, 'outbound admission unit funding quote'));
  if (admission.schema === 'hookemon.policy-admission.v4') {
    for (const order of units) {
      if (assertAdmittedAmount(order.unitPurchase, solana, 'outbound admission unit purchase target') === '0') {
        throw new Error('outbound admission amounts must be positive');
      }
    }
  }
  const aggregateFunding = assertAdmittedAmount(admission.aggregateFundingQuote, usdg, 'outbound admission aggregate funding quote');
  const aggregatePurchase = assertAdmittedAmount(admission.aggregatePurchase, solana, 'outbound admission aggregate purchase target');
  if (aggregatePurchase === '0' || aggregateFunding === '0' || unitFunding.some(amount => amount === '0')) {
    throw new Error('outbound admission amounts must be positive');
  }
  const relay = admission.relay;
  if (!relay || relay.tradeType !== 'EXACT_OUTPUT'
    || typeof relay.requestId !== 'string' || relay.requestId.length === 0
    || !/^0x[0-9a-fA-F]{64}$/.test(relay.orderId ?? '')
    || !Number.isSafeInteger(relay.deadlineUnixSeconds) || relay.deadlineUnixSeconds <= 0
    || !equalEvmAddress(relay.sender, configured.evm) || relay.recipient !== configured.solana) {
    throw new Error('outbound admission Relay identity is invalid');
  }
  if (canonicalAmount(relay.destinationAmount, 'outbound admission Relay destination amount') !== aggregatePurchase
    || canonicalAmount(relay.destinationMinimumAmount, 'outbound admission Relay destination minimum amount') !== aggregatePurchase) {
    throw new Error('outbound admission Relay destination does not exactly cover the aggregate purchase target');
  }
  const quote = admission.relayQuote;
  if (!quote || typeof quote !== 'object') throw new Error('outbound admission is missing the immutable Relay quote');
  return Object.freeze({ admission, relay, quote, aggregateFunding, aggregatePurchase });
}

function assertQuoteMatchesAdmission(quote, admitted) {
  if (quote.requestId !== admitted.relay.requestId || quote.orderId !== admitted.relay.orderId
    || quote.deadlineUnixSeconds !== admitted.relay.deadlineUnixSeconds
    || quote.sender !== admitted.relay.sender || quote.recipient !== admitted.relay.recipient
    || quote.tradeType !== 'EXACT_OUTPUT'
    || quote.origin.amount !== admitted.aggregateFunding
    || quote.destination.amount !== admitted.aggregatePurchase
    || quote.destination.minimumAmount !== admitted.aggregatePurchase
    || quote.quoteDigest !== admitted.admission.quoteDigest
    || relayQuoteDigest(quote) !== admitted.admission.quoteDigest) {
    throw new Error('outbound Relay quote differs from the durable policy admission');
  }
}

/**
 * Extracts only the nested transaction payloads observed in recorded Relay outbound quotes. The
 * old RouteParams payload is intentionally not accepted: every item must be decoded on its own.
 */
function calldataWords(data, selector, wordCount, label) {
  if (typeof data !== 'string' || data.toLowerCase().slice(0, 10) !== selector || data.length !== 10 + (wordCount * 64)) {
    throw new Error(`${label} does not match the recorded Relay calldata shape`);
  }
  return Array.from({ length: wordCount }, (_unused, index) => data.slice(10 + (index * 64), 10 + ((index + 1) * 64)));
}

function evmAddressFromWord(word, label) {
  if (typeof word !== 'string' || !/^[0-9a-fA-F]{64}$/.test(word) || !/^0{24}/i.test(word)) {
    throw new Error(`${label} is not ABI-encoded as an EVM address`);
  }
  return `0x${word.slice(-40)}`;
}

function atomicAmountFromWord(word, label) {
  if (typeof word !== 'string' || !/^[0-9a-fA-F]{64}$/.test(word)) throw new Error(`${label} is not ABI-encoded as uint256`);
  return BigInt(`0x${word}`).toString();
}

function assertOutboundRelayEnvelope(transactions, {
  operationsAccount, depository, amountAtomic, orderId,
}) {
  if (transactions.length !== 1) throw new Error('native outbound requires exactly one deposit and no token approval');
  const deposit = transactions[0].transaction;
  if (!equalEvmAddress(deposit.to, depository) || String(deposit.value) !== amountAtomic) {
    throw new Error('native outbound deposit target/value differs from the bound principal');
  }
  const [senderWord, orderWord] = calldataWords(deposit.data, RELAY_DEPOSIT_SELECTOR, 2, 'native Relay deposit');
  if (!equalEvmAddress(evmAddressFromWord(senderWord, 'native deposit sender'), operationsAccount)
    || `0x${orderWord}`.toLowerCase() !== orderId.toLowerCase()) {
    throw new Error('native outbound deposit does not bind Operations and the Relay order');
  }

}

export function extractRelayEvmTransactions({
  steps, requestId, operationsAccount, depository, amountAtomic, orderId,
}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('outbound Relay quote has no steps');
  const transactions = [];
  for (const step of steps) {
    if (!step || step.kind !== 'transaction' || (step.requestId !== undefined && step.requestId !== requestId) || !Array.isArray(step.items) || step.items.length === 0) {
      throw new Error('outbound Relay step is not a recorded transaction step for this quote');
    }
    for (let itemIndex = 0; itemIndex < step.items.length; itemIndex += 1) {
      if (step.requestId === undefined && (step.items[itemIndex]?.check?.method !== 'GET' || step.items[itemIndex]?.check?.endpoint !== `/intents/status/v3?requestId=${requestId}`)) throw new Error('native outbound step lacks exact request binding');
      const transaction = step.items[itemIndex]?.data;
      if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
        throw new Error('outbound Relay transaction item is missing data');
      }
      if (String(transaction.chainId) !== EVM_CHAIN_ID || !EVM_ADDRESS.test(transaction.to ?? '') || !EVM_DATA.test(transaction.data ?? '')) {
        throw new Error('outbound Relay transaction item is not a valid chain-4663 EVM transaction');
      }
      if (!equalEvmAddress(transaction.from, operationsAccount)) {
        throw new Error('outbound Relay transaction item does not use the Operations EVM account');
      }
      canonicalAmount(String(transaction.value), 'outbound Relay transaction value');
      transactions.push(Object.freeze({ stepId: step.id ?? null, itemIndex, transaction: Object.freeze({ ...transaction }) }));
    }
  }
  assertOutboundRelayEnvelope(transactions, {
    operationsAccount,
    depository,
    amountAtomic: canonicalAmount(amountAtomic, 'outbound cycle reserve'),
    orderId,
  });
  return Object.freeze(transactions);
}

async function verifiedOutboundPlans({
  steps, requestId, operationsAccount, depository, amountAtomic, orderId, deadlineUnixSeconds,
}) {
  const transactions = extractRelayEvmTransactions({
    steps,
    requestId,
    operationsAccount,
    depository,
    amountAtomic,
    orderId,
  });
  const decodeOptions = Object.freeze({
    family: 'evm',
    chainId: EVM_CHAIN_ID,
    tokenMetadata: Object.freeze({}),
  });
  const plans = await Promise.all(transactions.map(async (transactionPlan) => {
    const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: transactionPlan.transaction });
    if (decoded.chainId !== EVM_CHAIN_ID || !equalEvmAddress(decoded.source, operationsAccount)) {
      throw new Error('decoded outbound Relay transaction does not bind the Operations EVM account on chain 4663');
    }
    const plan = Object.freeze({
      ...transactionPlan,
      decoded,
      decodeOptions,
      relayQuote: Object.freeze({ requestId, deadlineUnixSeconds }),
    });
    outboundPlanBrand.add(plan);
    return plan;
  }));
  return Object.freeze(plans);
}

/**
 * ADR-0025 `refresh-after-readmission` evidence: the exact, narrow record cycle-repository's
 * `recordOutboundQuoteExpired` accepts, binding this cycle's *immutable original* admission and
 * both its admitted quote identities to the moment a Relay quote was observed expired -- never the
 * raw Relay steps, and never a replacement's identity, which could not match this cycle's original
 * admission digest even if supplied.
 */
function outboundQuoteExpiryEvidence(admission, observedAtMs) {
  return {
    schema: admission.schema === 'hookemon.policy-admission.v4'
      ? 'hookemon.outbound-quote-expiry-evidence.v2' : 'hookemon.outbound-quote-expiry-evidence.v1',
    cycleId: admission.cycleId,
    admissionDigest: digest(admission),
    aggregateQuote: {
      requestId: admission.relay.requestId,
      deadlineUnixSeconds: admission.relay.deadlineUnixSeconds,
      quoteDigest: admission.relay.quoteDigest,
    },
    ...(admission.schema === 'hookemon.policy-admission.v4' ? {
      unitQuotes: admission.orders.map(order => ({
        requestId: order.unitRelay.requestId,
        deadlineUnixSeconds: order.unitRelay.deadlineUnixSeconds,
        quoteDigest: order.unitRelay.quoteDigest,
      })),
    } : { unitQuote: {
      requestId: admission.unitRelay.requestId,
      deadlineUnixSeconds: admission.unitRelay.deadlineUnixSeconds,
      quoteDigest: admission.unitRelay.quoteDigest,
    } }),
    observedAtMs,
  };
}

/** Builds the immutable Relay request whose digest must be persisted before any signature. */
export async function prepareOutboundRequest({ adapters, config, cycleRepository, context, nowMs = Date.now() }) {
  if (!adapters?.relay) throw new Error('outbound requires a configured Relay client');
  const configured = assertOutboundConfiguration(config);
  const money = assertOutboundMoneyConfiguration(config, configured);
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  if (!cycle?.admission) throw new Error('outbound requires a repository-owned durable policy admission');
  if (context.admission !== undefined && digest(context.admission) !== digest(cycle.admission)) {
    throw new Error('outbound context admission conflicts with the repository-owned admission');
  }
  // ADR-0025 `refresh-after-readmission`: once a replacement is durably selected, outbound signs
  // and broadcasts that replacement -- never the original, now-expired quote -- while every other
  // check above and below still binds to the immutable original cycle admission and releaseAmount.
  const refresh = typeof cycleRepository.readOutboundQuoteRefresh === 'function'
    ? await cycleRepository.readOutboundQuoteRefresh(context.cycleId)
    : null;
  const effectiveAdmission = refresh?.state === 'ACTIVE' ? refresh.replacement : cycle.admission;
  const admitted = assertOutboundAdmission(effectiveAdmission, configured, money, context.cycleId);
  if (canonicalAmount(cycle.releaseAmount, 'outbound cycle release amount') !== admitted.aggregateFunding) {
    throw new Error('outbound cycle release amount does not match the durable aggregate funding quote');
  }
  const { quote, aggregateFunding: amountAtomic } = admitted;
  assertOutboundQuote(quote, configured, money);
  assertQuoteMatchesAdmission(quote, admitted);
  try {
    assertQuoteUsable({ quote, nowMs });
    if (effectiveAdmission.schema === 'hookemon.policy-admission.v4') {
      for (const order of effectiveAdmission.orders) assertQuoteUsable({ quote: order.unitRelayQuote, nowMs });
    }
  } catch (error) {
    if (!(error instanceof RelayQuoteExpiredError)) throw error;
    if (refresh === null) {
      // The one and only typed pre-effect recovery boundary: this is reached before any stage
      // request digest, Relay leg, or chain attempt exists, so the repository still accepts this
      // as the first (and only) expiry evidence for the immutable original admission.
      if (typeof cycleRepository.recordOutboundQuoteExpired === 'function') {
        await cycleRepository.recordOutboundQuoteExpired(context.cycleId, outboundQuoteExpiryEvidence(cycle.admission, nowMs));
      }
      throw error;
    }
    if (refresh.state === 'ACTIVE' && typeof cycleRepository.holdCycle === 'function') {
      // The one-replacement scope has no second refresh: a replacement that itself expires before
      // preparation leaves a durable, zero-effect owner-decision hold rather than fetching again.
      await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', {
        stage: 'outbound',
        reason: 'OUTBOUND_QUOTE_REFRESH_REPLACEMENT_EXPIRED',
        error: error.message,
      });
    }
    throw error;
  }
  const execution = adapters.relay.prepareExecution({ quote, liveMode: true });
  const transactions = await verifiedOutboundPlans({
    steps: execution.steps,
    requestId: quote.requestId,
    operationsAccount: configured.evm,
    depository: configured.evmDepository,
    amountAtomic,
    orderId: quote.orderId,
    deadlineUnixSeconds: quote.deadlineUnixSeconds,
  });
  return Object.freeze({
    schema: 'hookemon.outbound-relay-request.v2',
    cycleId: context.cycleId,
    inputAmount: typedAmount(quote.origin),
    destinationAmount: typedAmount(quote.destination),
    intent: execution.intent,
    transactions,
  });
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

/**
 * Decodes one Relay step before it reaches the Operations signer, then wraps that signer so the
 * signed bytes are re-decoded against the same exact policy before a future journaled broadcast.
 */
function requireOutboundMutationAuthority(preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('outbound fixture authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('outbound fixture authority is invalid');
  return requireLiveMutationAuthority();
}

export async function createOutboundPolicySigner({
  signerClient,
  plan,
  operationsAccount,
  requestDigest = digest({
    schema: 'hookemon.outbound-policy-request.v1',
    relayRequestId: plan?.relayQuote?.requestId,
    transaction: plan?.transaction,
  }),
  now = Date.now,
  preflightAuthority,
  recoveryRepository,
  context,
}) {
  if (!outboundPlanBrand.has(plan)) {
    throw new Error('outbound policy signer requires a verified Relay plan produced by prepareOutboundRequest');
  }
  if (typeof now !== 'function') throw new Error('outbound policy signer requires a wall-clock function');
  const { decoded, decodeOptions } = plan;
  assertQuoteUsable({ quote: plan.relayQuote, nowMs: now() });
  if (decoded.chainId !== EVM_CHAIN_ID || !equalEvmAddress(decoded.source, operationsAccount)) {
    throw new Error('decoded outbound Relay transaction does not bind the Operations EVM account on chain 4663');
  }
  if (decoded.nonce === null) {
    throw new Error('outbound policy signer requires a journal-owned reserved EVM nonce before signing');
  }
  const policy = createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage: 'outbound', requestDigest }),
    rules: [exactPolicyRule(decoded, 'relay-outbound-step')],
  });
  const policyRules = readTransactionPolicyRules(policy);
  // ADR-0025 `retry-sign-only-with-durable-binding`: `recoveryRepository`/`context` are supplied
  // only by the live `mutateOutbound` caller, which already holds the durable stage identity this
  // exact chain attempt was PREPARED under; a bare policy-signer construction (e.g. a fixture test)
  // omits them and gets today's unchanged, non-retrying behavior. `recoveryRepository` is the
  // narrow, lease-fenced sign-only-recovery facade the stage driver builds -- never the raw,
  // unfenced `cycleRepository` this same caller uses for every other durable write.
  const recovery = recoveryRepository && context
    ? { repository: recoveryRepository, cycleId: context.cycleId, stage: 'outbound', requestDigest }
    : undefined;
  const signer = wrapTransactionPolicySignerClient({ client: signerClient, policy, rules: policyRules, decodeOptions, recovery });
  const assertPlanQuoteUsable = () => assertQuoteUsable({ quote: plan.relayQuote, nowMs: now() });
  return Object.freeze({
    decoded,
    policy,
    policyRules,
    policySigner: signer,
    signer: Object.freeze({
      ...signer,
      async sign(request) {
        assertPlanQuoteUsable();
        requireOutboundMutationAuthority(preflightAuthority);
        return signer.sign(request);
      },
      async broadcast(signed) {
        assertPlanQuoteUsable();
        requireOutboundMutationAuthority(preflightAuthority);
        return signer.broadcast(signed);
      },
    }),
  });
}

export async function probeOutbound({ adapters, config, cycleRepository, context }) {
  if (!adapters.relay || !config.accounts.evm || !config.accounts.solana || !config.relay?.solanaMint || !config.relay?.evmDepository) {
    return { wouldBridgeOutbound: true, configured: false, reason: 'Relay, Operations accounts, the Solana mint, or the EVM depository allowlist is not configured' };
  }
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  if (!cycle.releaseAmount || cycle.releaseAmount === '0') {
    return { wouldBridgeOutbound: true, configured: true, reason: 'cycle release amount is zero' };
  }
  const quote = await adapters.relay.quoteOutboundBridge({
    amount: cycle.releaseAmount,
    user: config.accounts.evm,
    recipient: config.accounts.solana,
    destinationCurrency: config.relay.solanaMint,
  });
  return {
    wouldBridgeOutbound: true,
    configured: true,
    quote: adapters.relay.simulateExecution({ quote }),
    quotedOriginAmount: quote?.origin?.amount ?? null,
    quotedDestinationAmount: quote?.destination?.amount ?? null,
  };
}

function assertOutboundMutationRepository(cycleRepository) {
  for (const method of [
    'readChainTransactionAttempt',
    'prepareChainTransactionAttempt',
    'recordSignedTransaction',
    'recordBroadcast',
    'recordRelayLeg',
    'recordRelayLegSource',
    'reserveWalletNonce',
    'assertWalletNonce',
    'persistChainAttemptRecoveryContext',
    'readChainAttemptRecoveryContext',
  ]) {
    if (typeof cycleRepository?.[method] !== 'function') {
      throw new Error(`outbound requires cycleRepository.${method} for durable Relay signing`);
    }
  }
  if (typeof cycleRepository.recordSignedTransactionWithRecoveryContext !== 'function'
    && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('outbound requires cycleRepository.recordSignedTransactionWithRecoveryContext for atomic Relay signing');
  }
}

function outboundStepRequestDigest(context, plan, index) {
  return digest({
    schema: 'hookemon.relay-chain-step.v1',
    cycleId: context.cycleId,
    stage: 'outbound',
    requestDigest: context.requestDigest,
    relayRequestId: plan.relayQuote.requestId,
    index,
    transaction: plan.transaction,
  });
}

function outboundRelayLeg(context, request) {
  const { inputAmount, destinationAmount } = request;
  return Object.freeze({
    schema: 'hookemon.relay-leg.v2',
    cycleId: context.cycleId,
    direction: 'outbound',
    relayRequestId: request.intent.requestId,
    quoteDigest: digest({
      schema: 'hookemon.relay-quote-digest.v1',
      intent: request.intent,
      inputAmount,
      destinationAmount,
    }),
    sourceChainId: inputAmount.chainId,
    sourceTxHash: null,
    sourceAssetId: inputAmount.assetId,
    sourceDecimals: inputAmount.decimals,
    sourceAmountAtomic: inputAmount.amountAtomic,
    destinationChainId: destinationAmount.chainId,
    destinationTxHash: null,
    destinationAssetId: destinationAmount.assetId,
    destinationDecimals: destinationAmount.decimals,
    destinationAmountAtomic: destinationAmount.amountAtomic,
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
  });
}

function outboundWalletReservation(configured, context) {
  if (typeof context?.fencingToken !== 'string' || context.fencingToken.length === 0) {
    throw new Error('outbound requires a fencing token for the global wallet nonce reservation');
  }
  return Object.freeze({
    chainId: EVM_CHAIN_ID,
    wallet: configured.evm.toLowerCase(),
    stage: 'outbound',
    fencingToken: context.fencingToken,
    ...walletNonceLeaseWindow(context, 'outbound wallet nonce reservation'),
  });
}

async function reserveOutboundWalletNonce({ cycleRepository, configured, context }) {
  const reservation = await resolveWalletNonceReservation(cycleRepository, context.cycleId, outboundWalletReservation(configured, context));
  await cycleRepository.reserveWalletNonce(context.cycleId, reservation);
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
  return reservation;
}

async function assertOutboundWalletNonce({ cycleRepository, context, reservation }) {
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
}

/** A finalized source transaction cannot be re-signed, so its wallet fence may advance. */
async function releaseOutboundWalletNonce({ cycleRepository, configured, context }) {
  if (typeof cycleRepository?.releaseWalletNonce !== 'function') {
    throw new Error('outbound requires cycleRepository.releaseWalletNonce after durable source finality');
  }
  await cycleRepository.releaseWalletNonce(
    context.cycleId,
    await resolveWalletNonceReservation(cycleRepository, context.cycleId, outboundWalletReservation(configured, context), { release: true }),
  );
}

function asNonnegativeBigInt(value, label) {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new Error(`${label} must be a nonnegative integer`);
  }
}

function asPositiveBigInt(value, label) {
  const result = asNonnegativeBigInt(value, label);
  if (result === 0n) throw new Error(`${label} must be positive`);
  return result;
}

async function outboundPlanWithNonce(plan, nonce) {
  const transactionValue = {
    ...plan.transaction,
    type: 'eip1559',
    nonce: asNonnegativeBigInt(nonce, 'outbound EVM nonce').toString(),
  };
  // A zero EIP-1559 priority fee is encoded as an omitted field by the signer transport. Normalize
  // it before policy decoding so the post-sign decode compares the exact wire semantics.
  if (asNonnegativeBigInt(transactionValue.maxPriorityFeePerGas, 'outbound Relay maxPriorityFeePerGas') === 0n) {
    delete transactionValue.maxPriorityFeePerGas;
  }
  const transaction = Object.freeze(transactionValue);
  const decoded = await decodeProviderTransaction({ ...plan.decodeOptions, transaction });
  if (decoded.nonce !== transaction.nonce || decoded.chainId !== EVM_CHAIN_ID) {
    throw new Error('outbound transaction decoder did not bind the reserved EVM nonce');
  }
  const signedPlan = Object.freeze({ ...plan, transaction, decoded });
  outboundPlanBrand.add(signedPlan);
  return signedPlan;
}

function assertOutboundGasCaps(plans, money) {
  const gasPriceCap = asPositiveBigInt(money.evm.perTransactionGasPriceCap.amountAtomic, 'outbound EVM gas-price cap');
  let maximumCost = 0n;
  for (const plan of plans) {
    const gas = asPositiveBigInt(plan.transaction.gas, 'outbound Relay gas limit');
    const maxFeePerGas = asNonnegativeBigInt(plan.transaction.maxFeePerGas, 'outbound Relay maxFeePerGas');
    const maxPriorityFeePerGas = asNonnegativeBigInt(plan.transaction.maxPriorityFeePerGas, 'outbound Relay maxPriorityFeePerGas');
    if (maxFeePerGas > gasPriceCap || maxPriorityFeePerGas > gasPriceCap || maxPriorityFeePerGas > maxFeePerGas) {
      throw new Error('outbound Relay gas price exceeds the configured MoneyConfigurationV2 cap');
    }
    maximumCost += gas * maxFeePerGas;
  }
  return maximumCost;
}

async function assertOutboundNativeReserve({ client, configured, plans, money }) {
  if (!client || typeof client.getChainId !== 'function' || typeof client.getBalance !== 'function') {
    throw new Error('outbound requires Robinhood RPC chain-id and native-balance reads before signing');
  }
  const [chainId, balance] = await Promise.all([
    client.getChainId(),
    client.getBalance({ address: configured.evm }),
  ]);
  if (String(chainId) !== EVM_CHAIN_ID) throw new Error('outbound Robinhood RPC chain id does not match chain 4663');
  const required = assertOutboundGasCaps(plans, money)
    + asNonnegativeBigInt(money.evm.nativeReserve.amountAtomic, 'outbound EVM native reserve');
  if (asNonnegativeBigInt(balance, 'outbound Operations native balance') < required) {
    throw new Error('outbound Operations native balance does not retain the configured reserve after quoted gas');
  }
}

function chainAttemptNonceBase(records) {
  let base = null;
  for (const { index, record } of records) {
    if (!record || !['SIGNED', 'BROADCAST', 'FINALIZED'].includes(record.attempt?.state)) continue;
    const candidate = asNonnegativeBigInt(record.attempt.nonce, 'stored outbound EVM nonce') - BigInt(index);
    if (candidate < 0n) throw new Error('stored outbound EVM nonce cannot precede the Relay step index');
    if (base !== null && base !== candidate) throw new Error('stored outbound Relay attempts do not share one reserved nonce sequence');
    base = candidate;
  }
  return base;
}

async function readOrPrepareOutboundAttempt({ cycleRepository, context, plan, index }) {
  const requestDigest = outboundStepRequestDigest(context, plan, index);
  let record = await cycleRepository.readChainTransactionAttempt(context.cycleId, 'outbound', requestDigest);
  if (record === null) {
    await cycleRepository.prepareChainTransactionAttempt(
      context.cycleId,
      'outbound',
      createPreparedChainTransactionAttempt({ cycleId: context.cycleId, stage: 'outbound', requestDigest }),
    );
    record = await cycleRepository.readChainTransactionAttempt(context.cycleId, 'outbound', requestDigest);
  }
  if (!record) throw new Error('outbound chain attempt was not persisted before signing');
  return { index, plan, requestDigest, record };
}

function recordedRelayQuoteDeadlineUnixSeconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('outbound requires a positive recorded Relay quote deadline');
  }
  return String(value);
}

function outboundRecoveryContext({
  context,
  requestDigest,
  rawSignedBytesHash,
  approval,
  relayQuoteDeadlineUnixSeconds,
  relayIntent,
  relaySourceRecipient,
}) {
  if (!EVM_ADDRESS.test(relaySourceRecipient ?? '')) {
    throw new Error('outbound requires the persisted Relay EVM source recipient');
  }
  return Object.freeze({
    stage: 'outbound',
    recipient: null,
    requestDigest,
    policyDigest: approval.policyDigest,
    approvalDigest: approval.approvalDigest,
    fencingToken: context.fencingToken,
    fencingTokenDigest: digest({
      schema: 'hookemon.wallet-nonce-reservation.v1',
      chainId: EVM_CHAIN_ID,
      stage: 'outbound',
      fencingToken: context.fencingToken,
    }),
    approvedSemanticsDigest: approval.approvedSemanticsDigest,
    rawSignedBytesHash,
    signedMessageDigest: approval.signedMessageDigest,
    relayQuoteDeadlineUnixSeconds: recordedRelayQuoteDeadlineUnixSeconds(relayQuoteDeadlineUnixSeconds),
    relayIntent: structuredClone(relayIntent),
    relayRoute: Object.freeze({
      sourceSender: relayIntent.sender,
      sourceRecipient: relaySourceRecipient,
      destinationOwner: relayIntent.recipient,
    }),
  });
}

function assertOutboundBroadcastHash(result, expectedHash) {
  const transactionHash = typeof result === 'string' ? result : result?.transactionHash;
  if (typeof transactionHash !== 'string' || transactionHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('outbound broadcaster returned a hash that does not match the persisted signed bytes');
  }
  return expectedHash;
}

/**
 * Persists every outbound Relay step before it can obtain a signature, then resumes from the
 * exact raw bytes. Relay status is deliberately absent from this path.
 */
export async function mutateOutbound({
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
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateOutbound reached without liveMode');
  // broadcast() or broadcastApproved(), the same pair signer-client.mjs itself accepts. A client
  // wired to a real chain RPC transport deliberately exposes only the approved variant, so insisting
  // on the bare method here would reject exactly the production configuration.
  if (!signerClient?.evm || typeof signerClient.evm.sign !== 'function'
    || (typeof signerClient.evm.broadcast !== 'function' && typeof signerClient.evm.broadcastApproved !== 'function')) {
    throw new Error('outbound requires an Operations EVM signer with sign and broadcast capabilities');
  }
  if (typeof context?.requestDigest !== 'string') throw new Error('outbound requires the durable stage request digest');
  if (typeof now !== 'function') throw new Error('outbound requires a wall-clock function');
  assertOutboundMutationRepository(cycleRepository);
  const configured = assertOutboundConfiguration(config);
  const money = assertOutboundMoneyConfiguration(config, configured);
  if (!request || request.schema !== 'hookemon.outbound-relay-request.v2' || request.cycleId !== context.cycleId) {
    throw new Error('outbound requires the canonical request prepared for this cycle');
  }
  if (request.inputAmount.amountAtomic === '0' || request.inputAmount.amountAtomic !== (await cycleRepository.describeCycle(context.cycleId)).releaseAmount) {
    throw new Error('outbound may sign only the cycle claimed principal');
  }
  if (request.inputAmount.chainId !== money.assets.eth.chainId || request.inputAmount.assetId.toLowerCase() !== money.assets.eth.assetId.toLowerCase()
    || request.inputAmount.decimals !== money.assets.eth.decimals
    || request.destinationAmount.chainId !== money.assets.solanaStablecoin.chainId
    || request.destinationAmount.assetId !== money.assets.solanaStablecoin.assetId
    || request.destinationAmount.decimals !== money.assets.solanaStablecoin.decimals) {
    throw new Error('outbound request assets do not match MoneyConfigurationV2');
  }
  if (!Array.isArray(request.transactions) || request.transactions.length === 0 || typeof request.intent?.requestId !== 'string') {
    throw new Error('outbound canonical request is missing Relay steps or request identity');
  }
  await cycleRepository.recordRelayLeg(context.cycleId, outboundRelayLeg(context, request));
  const reservation = await reserveOutboundWalletNonce({ cycleRepository, configured, context });
  const records = [];
  for (let index = 0; index < request.transactions.length; index += 1) {
    records.push(await readOrPrepareOutboundAttempt({
      cycleRepository,
      context,
      plan: request.transactions[index],
      index,
    }));
  }
  let nonceBase = chainAttemptNonceBase(records);
  if (nonceBase === null && records.some(entry => entry.record.attempt.state === 'PREPARED')) {
    const client = adapters?.robinhood?.client;
    if (typeof client?.getTransactionCount !== 'function') {
      throw new Error('outbound requires a Robinhood RPC pending nonce read before signing');
    }
    await assertOutboundNativeReserve({ client, configured, plans: records.map(entry => entry.plan), money });
    nonceBase = asNonnegativeBigInt(
      await client.getTransactionCount({ address: configured.evm, blockTag: 'pending' }),
      'outbound Robinhood pending nonce',
    );
  }
  if (nonceBase === null) throw new Error('outbound has no nonce sequence for the durable Relay attempts');

  for (const entry of records) {
    let { record } = entry;
    const plan = await outboundPlanWithNonce(entry.plan, nonceBase + BigInt(entry.index));
    if (record.attempt.state === 'PREPARED') {
      await assertOutboundWalletNonce({ cycleRepository, context, reservation });
      const approved = await createOutboundPolicySigner({
        signerClient: signerClient.evm,
        plan,
        operationsAccount: configured.evm,
        requestDigest: entry.requestDigest,
        now,
        preflightAuthority,
        recoveryRepository: signOnlyRecoveryRepository,
        context,
      });
      const signed = await approved.signer.sign({
        transaction: plan.transaction,
        transactionPolicy: approved.policy,
        transactionPolicyRules: approved.policyRules,
        transactionDecodeOptions: plan.decodeOptions,
        liveMode: true,
      });
      if (typeof signed?.signedTx !== 'string') throw new Error('outbound signer did not return serialized EVM bytes');
      const hash = keccak256(signed.signedTx);
      const approval = readTransactionPolicyApprovalContext(approved.policySigner, signed);
      const recoveryContext = outboundRecoveryContext({
        context,
        requestDigest: entry.requestDigest,
        rawSignedBytesHash: hash,
        approval,
        relayQuoteDeadlineUnixSeconds: plan.relayQuote.deadlineUnixSeconds,
        relayIntent: request.intent,
        relaySourceRecipient: configured.evmDepository,
      });
      const signingMaterial = {
        rawBytes: signed.signedTx,
        nonce: plan.transaction.nonce,
        blockhash: null,
        hash,
      };
      if (typeof cycleRepository.recordSignedTransactionWithRecoveryContext === 'function') {
        record = await cycleRepository.recordSignedTransactionWithRecoveryContext(
          context.cycleId,
          'outbound',
          entry.requestDigest,
          signingMaterial,
          recoveryContext,
          entry.index === request.transactions.length - 1
            ? { relayRequestId: request.intent.requestId, sourceTxHash: hash }
            : null,
        );
      } else {
        record = await cycleRepository.recordSignedTransaction(context.cycleId, 'outbound', entry.requestDigest, signingMaterial);
        await cycleRepository.persistChainAttemptRecoveryContext(context.cycleId, recoveryContext);
      }
    }
    if (record.attempt.state === 'SIGNED' && entry.index === request.transactions.length - 1) {
      await cycleRepository.recordRelayLegSource(context.cycleId, request.intent.requestId, record.attempt.hash);
    }
    if (record.attempt.state === 'SIGNED') {
      await assertOutboundWalletNonce({ cycleRepository, context, reservation });
      const approved = await createOutboundPolicySigner({
        signerClient: signerClient.evm,
        plan,
        operationsAccount: configured.evm,
        requestDigest: entry.requestDigest,
        now,
        preflightAuthority,
      });
      requireOutboundMutationAuthority(preflightAuthority);
      const recoveryContext = await cycleRepository.readChainAttemptRecoveryContext(context.cycleId, {
        stage: 'outbound',
        recipient: null,
        requestDigest: entry.requestDigest,
        rawSignedBytesHash: record.attempt.hash,
      });
      if (recoveryContext === null) throw new Error('outbound signed bytes have no durable policy recovery context');
      const result = await recoverTransactionPolicyBroadcast({
        client: approved.policySigner,
        signed: { signedTx: record.attempt.rawBytes },
        recoveryContext: {
          schema: 'hookemon.transaction-policy-approval.v1',
          family: 'evm',
          policyDigest: recoveryContext.policyDigest,
          approvalDigest: recoveryContext.approvalDigest,
          approvedSemanticsDigest: recoveryContext.approvedSemanticsDigest,
          signedMessageDigest: recoveryContext.signedMessageDigest,
        },
      });
      assertOutboundBroadcastHash(result, record.attempt.hash);
      record = await cycleRepository.recordBroadcast(
        context.cycleId,
        'outbound',
        entry.requestDigest,
        Object.freeze({ transactionHash: record.attempt.hash }),
      );
    }
    if (!['BROADCAST', 'FINALIZED'].includes(record.attempt.state)) {
      throw new Error(`outbound chain attempt is in unexpected state ${record.attempt.state}`);
    }
  }
  const sourceRecord = records[records.length - 1];
  const source = await cycleRepository.readChainTransactionAttempt(context.cycleId, 'outbound', sourceRecord.requestDigest);
  return Object.freeze({
    relayRequestId: request.intent.requestId,
    sourceTransactionHash: source?.attempt?.hash ?? null,
    chainAttemptState: source?.attempt?.state ?? null,
  });
}

function stateValues(value) {
  return value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
}

function legacyUnauthenticatedOutboundIntent(attempt) {
  const intent = attempt?.responseEvidence?.intent ?? attempt?.intent ?? null;
  return intent && typeof intent === 'object' ? intent : null;
}

function outboundSourceFinality(proof) {
  if (proof?.receiptBlockNumber === null || proof?.receiptBlockNumber === undefined
    || typeof proof?.receiptBlockHash !== 'string' || proof.receiptBlockHash.length === 0) {
    return null;
  }
  return Object.freeze({
    height: BigInt(proof.receiptBlockNumber).toString(),
    hash: proof.receiptBlockHash,
    timestampUnixSeconds: canonicalUnixSeconds(proof.receiptBlockTimestampUnixSeconds),
  });
}

function canonicalUnixSeconds(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? value : null;
}

function observedOutboundSourceProof(proof, leg) {
  if (!isProcessNativePaymentProof(proof, { transactionHash: leg.sourceTxHash.toLowerCase(), amountWei: leg.sourceAmountAtomic })) return null;
  return { height: proof.blockNumber, hash: proof.blockHash, timestampUnixSeconds: proof.timestampUnixSeconds };
}

function observedPositiveDestinationCredit(observation) {
  try {
    return observation !== null && BigInt(observation.netDeltaAtomic) > 0n;
  } catch {
    return false;
  }
}

function successfulEvmReceipt(receipt) {
  return receipt?.status === 'success' || receipt?.status === '0x1' || receipt?.status === 1 || receipt?.status === 1n;
}

function boundOutboundRecoveryIntent(recoveryContext, leg, configured) {
  const intent = recoveryContext?.relayIntent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.schema !== 'hookemon.relay-intent.v2'
    || intent.direction !== DIRECTIONS.OUTBOUND
    || intent.requestId !== leg.relayRequestId
    || String(intent.originChainId) !== leg.sourceChainId
    || intent.originAssetId !== leg.sourceAssetId
    || intent.originDecimals !== leg.sourceDecimals
    || intent.originAmount !== leg.sourceAmountAtomic
    || String(intent.destinationChainId) !== leg.destinationChainId
    || intent.destinationAssetId !== leg.destinationAssetId
    || intent.destinationDecimals !== leg.destinationDecimals
    || intent.quotedDestinationAmount !== leg.destinationAmountAtomic
    || !equalEvmAddress(intent.sender, configured.evm)
    || intent.recipient !== configured.solana
    || String(intent.deadlineUnixSeconds) !== recoveryContext.relayQuoteDeadlineUnixSeconds) {
    return null;
  }
  return intent;
}

/** Refund pointers locate receipts; release-bound native payment facts establish the credit. */
export async function readOutboundOriginRefundProof({ client, pointer, leg, sourceFinality, sourceAccount, operationsAccount,
  sourceProof, signedSourceTransaction, nativePaymentBinding, orderId }) {
  if (!pointer || pointer.schema !== 'hookemon.relay-terminal-origin-refund-pointer.v1'
    || pointer.relayRequestId !== leg?.relayRequestId || pointer.status !== 'REFUND'
    || typeof pointer.refundTxHash !== 'string' || !EVM_TRANSACTION_HASH.test(pointer.refundTxHash)) {
    throw new Error('outbound refund proof requires an authenticated refunded Relay transaction pointer');
  }
  if (leg.schema !== 'hookemon.relay-leg.v2' || leg.sourceAssetId !== 'native' || leg.sourceDecimals !== 18
    || pointer.refundTxHash.toLowerCase() === leg.sourceTxHash.toLowerCase()) return null;
  const native = await createRelayNativePaymentProof({ client, binding: nativePaymentBinding, sourceProof, signedSourceTransaction,
    expected: { kind: 'relay-refund', chainId: '4663', assetId: 'native', decimals: 18,
      transactionHash: pointer.refundTxHash, sourceTransactionHash: leg.sourceTxHash, relayRequestId: leg.relayRequestId,
      orderId, recipient: operationsAccount, depository: sourceAccount, sourceAmountAtomic: leg.sourceAmountAtomic } });
  if (BigInt(native.amountWei) > BigInt(leg.sourceAmountAtomic)
    || BigInt(native.timestampUnixSeconds) < BigInt(sourceFinality.timestampUnixSeconds)) return null;
  const proof = Object.freeze({ schema: 'hookemon.outbound-relay-origin-refund-proof.v2', relayRequestId: leg.relayRequestId,
    terminalStatus: Object.freeze({ status: 'REFUND', refundTxHash: native.transactionHash }),
    sourceTxHash: leg.sourceTxHash, sourceFinality: Object.freeze(structuredClone(sourceFinality)),
    refundTxHash: native.transactionHash,
    refundFinality: Object.freeze({ height: native.blockNumber, hash: native.blockHash, timestampUnixSeconds: native.timestampUnixSeconds }),
    transferCount: 1, observedToken: 'native', observedSource: native.source, sourceDepository: sourceAccount.toLowerCase(),
    observedRecipient: native.recipient, observedAmountAtomic: native.amountWei, nativePaymentProof: native });
  processRpcOutboundRefundProofs.set(proof, Object.freeze({ proofDigest: digest(proof), relayRequestId: proof.relayRequestId,
    sourceTxHash: proof.sourceTxHash.toLowerCase(), refundTxHash: proof.refundTxHash, sourceDepository: proof.sourceDepository }));
  return proof;
}

/**
 * Independently proves one prerequisite (non-source) outbound EVM transaction -- the USDG
 * approval that must precede the Relay depository deposit -- is canonically finalized and
 * succeeded, from its own hash alone. The deposit's own finality (an independent ERC20 transfer
 * proof against a different hash) is never accepted as evidence for this transaction: a caller
 * must supply this attempt's own durably recorded hash, never the leg's `sourceTxHash`.
 */
async function readOutboundPrerequisiteFinality(client, hash) {
  const observation = await readFinalizedTransactionReceipt(client, hash);
  if (!observation.finalized || !successfulEvmReceipt(observation.receipt)
    || observation.receiptBlockNumber === null || observation.receiptBlockHash === null) {
    return null;
  }
  const receiptBlock = await readBlockByNumber(client, observation.receiptBlockNumber);
  if (receiptBlock.hash !== observation.receiptBlockHash) return null;
  const timestampUnixSeconds = canonicalUnixSeconds(String(receiptBlock.timestamp));
  if (timestampUnixSeconds === null) return null;
  return Object.freeze({
    transactionHash: hash.toLowerCase(),
    finalizedAt: Object.freeze({ height: receiptBlock.number.toString(), hash: receiptBlock.hash, timestampUnixSeconds }),
  });
}

/**
 * Fails closed unless this durable outbound attempt is exactly the canonical USDG approval the
 * matched deposit required: its own recorded raw bytes decode to a zero-value chain-4663 call to
 * USDG `approve(depository, leg.sourceAmountAtomic)`, signed by the Operations account, at the
 * nonce immediately preceding the deposit's own reserved nonce. Reuses the exact calldata decoding
 * this stage already trusts before signing (`calldataWords`/`evmAddressFromWord`/
 * `atomicAmountFromWord`, the same primitives `assertOutboundRelayEnvelope` above verifies
 * pre-signature) -- never a new decoder, and never inferred from the deposit's own, separate
 * evidence.
 */
async function assertOutboundApprovalAttemptRole(entry, {
  operationsAccount, depository, amountAtomic, sourceNonce, sourceHash,
}) {
  const { attempt } = entry;
  const refuse = (message, cause) => {
    throw new OutboundRecoveryRequiredError('OUTBOUND_CHAIN_ATTEMPT_AMBIGUOUS', message, cause === undefined ? {} : { cause });
  };
  if (typeof attempt.hash === 'string' && attempt.hash.toLowerCase() === sourceHash.toLowerCase()) {
    refuse('an outbound prerequisite attempt duplicates the deposit transaction hash');
  }
  if (typeof attempt.rawBytes !== 'string' || attempt.rawBytes.length === 0) {
    refuse('an outbound prerequisite attempt has no durable signed bytes');
  }
  if (keccak256(attempt.rawBytes).toLowerCase() !== String(attempt.hash).toLowerCase()) {
    refuse('an outbound prerequisite attempt hash does not match its own durable raw bytes');
  }
  let parsed;
  let signer;
  try {
    parsed = parseTransaction(attempt.rawBytes);
    signer = await recoverTransactionAddress({ serializedTransaction: attempt.rawBytes });
  } catch (error) {
    refuse('an outbound prerequisite attempt raw bytes do not decode as a signed EVM transaction', error);
  }
  if (!equalEvmAddress(signer, operationsAccount)) {
    refuse('the outbound prerequisite attempt was not signed by the Operations account');
  }
  if (String(parsed.chainId) !== EVM_CHAIN_ID || !equalEvmAddress(parsed.to, NATIVE_ADDRESS) || BigInt(parsed.value ?? 0n) !== 0n) {
    refuse('the outbound prerequisite attempt is not a zero-value chain-4663 USDG call');
  }
  let spenderWord;
  let amountWord;
  try {
    [spenderWord, amountWord] = calldataWords(parsed.data ?? '0x', ERC20_APPROVE_SELECTOR, 2, 'outbound prerequisite approval');
  } catch (error) {
    refuse('the outbound prerequisite attempt is not a canonical USDG approval call', error);
  }
  if (!equalEvmAddress(evmAddressFromWord(spenderWord, 'outbound prerequisite approval spender'), depository)) {
    refuse('the outbound prerequisite approval spender is not the configured Relay depository');
  }
  if (atomicAmountFromWord(amountWord, 'outbound prerequisite approval amount') !== amountAtomic) {
    refuse('the outbound prerequisite approval amount does not equal the leg source amount');
  }
  if (parsed.nonce === null || parsed.nonce === undefined
    || sourceNonce === null || sourceNonce === undefined
    || BigInt(parsed.nonce) + 1n !== BigInt(sourceNonce)) {
    refuse('the outbound prerequisite attempt nonce does not immediately precede the deposit nonce');
  }
}

/**
 * Resolves the leg's one durable prerequisite attempt. Its role is verified from its own durable
 * bytes unconditionally -- including when already FINALIZED, so a durable attempt that was never
 * actually the expected approval cannot ride through as trusted just because some earlier run
 * marked it finalized. Only the RPC finality read and the `recordFinality` write are skipped once
 * FINALIZED (restart-safe: `recordFinality` itself also refuses conflicting evidence). Not-yet-
 * BROADCAST means nothing to check or read yet. A missing, reverted, or non-canonical receipt
 * leaves the attempt -- and therefore the whole stage -- unresolved rather than fabricating success
 * from the deposit's separate evidence.
 */
async function finalizeOutboundApprovalAttempt({
  cycleRepository, context, client, prerequisite, operationsAccount, depository, amountAtomic, sourceNonce, sourceHash,
}) {
  if (!['BROADCAST', 'FINALIZED'].includes(prerequisite.attempt.state)) return false;
  await assertOutboundApprovalAttemptRole(prerequisite, {
    operationsAccount, depository, amountAtomic, sourceNonce, sourceHash,
  });
  if (prerequisite.attempt.state === 'FINALIZED') return true;
  let finality;
  try {
    finality = await readOutboundPrerequisiteFinality(client, prerequisite.attempt.hash);
  } catch {
    finality = null;
  }
  if (finality === null) return false;
  await cycleRepository.recordFinality(context.cycleId, 'outbound', prerequisite.attempt.requestDigest, finality);
  return true;
}

function isExactOutboundDestinationCredit(leg, observation) {
  return observation.mint === leg.destinationAssetId
    && BigInt(observation.netDeltaAtomic) === BigInt(leg.destinationAmountAtomic);
}

function outboundSettlementEvidence(leg) {
  if (leg?.state !== 'SETTLED') {
    throw new Error('outbound settlement evidence requires a durably settled Relay leg');
  }
  return Object.freeze({
    schema: 'hookemon.outbound-relay-settlement-evidence.v2',
    relayLeg: Object.freeze(structuredClone(leg)),
  });
}

export function nativeOutboundCustodyAfterPayment(existing, proof, observation) {
  if (!existing || existing.schema !== 'hookemon.custody-ledger.v3' || existing.chainId !== '4663'
    || existing.assetId !== 'native' || existing.decimals !== 18 || !isProcessNativePaymentProof(proof, { kind: 'direct' })) {
    throw new Error('native outbound custody requires native claimed principal and process payment proof');
  }
  const paid = BigInt(proof.amountWei);
  if (BigInt(existing.claimed) < paid || (existing.bridgeOut !== '0' && existing.bridgeOut !== proof.amountWei)) {
    throw new Error('native outbound custody principal conflicts with finalized payment');
  }
  return { ...existing, bridgeOut: proof.amountWei, verifiedCurrentBalance: observation,
    ...applyNativeCustodyGasPayment(existing, proof) };
}

async function recordNativeOutboundCustody({ cycleRepository, context, adapters, configured, proof, gasOnly = false }) {
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  const key = '4663\u0000native';
  const existing = cycle.custodyLedgers?.get(key);
  const observation = await createNativeCustodyBalanceObservationReader({
    publicClient: adapters.robinhood.client, archiveClient: adapters.robinhood.historicalEvidenceClient,
    identity: { chainId: '4663', assetId: 'native', decimals: 18, account: configured.evm.toLowerCase() },
  })();
  context.assertLease?.();
  const next = gasOnly
    ? { ...existing, verifiedCurrentBalance: observation, ...applyNativeCustodyGasPayment(existing, proof) }
    : nativeOutboundCustodyAfterPayment(existing, proof, observation);
  await cycleRepository.recordCustodyLedger(context.cycleId, next);
  context.assertLease?.();
}

async function finalizeOutboundSourceAttempt({ cycleRepository, context, record, leg, sourceFinality }) {
  let current = record;
  if (current.attempt.state === 'SIGNED') {
    current = await cycleRepository.recordBroadcast(
      context.cycleId,
      'outbound',
      current.attempt.requestDigest,
      Object.freeze({ transactionHash: leg.sourceTxHash }),
    );
  }
  if (current.attempt.state === 'BROADCAST') {
    current = await cycleRepository.recordFinality(
      context.cycleId,
      'outbound',
      current.attempt.requestDigest,
      Object.freeze({
        transactionHash: leg.sourceTxHash,
        sourceAssetId: leg.sourceAssetId,
        sourceAmountAtomic: leg.sourceAmountAtomic,
        finalizedAtSource: sourceFinality,
      }),
    );
  }
  return current;
}

/**
 * Reconciliation reads only the durable Relay leg and independently-finalized chain evidence.
 * Relay status is deliberately never queried. An exact destination credit can settle only from
 * the deadline journaled next to the signed source bytes, never from a runtime quote object.
 */
export async function reconcileLiveOutbound({ adapters, config, cycleRepository, context }) {
  if (typeof cycleRepository?.describeCycle !== 'function') {
    const intent = legacyUnauthenticatedOutboundIntent(await cycleRepository?.readOperationalStageAttempt?.(context.cycleId, 'outbound'));
    if (intent === null) return null;
    throw new OutboundRecoveryRequiredError(
      'OUTBOUND_SETTLEMENT_UNATTESTED',
      'Relay status cannot authenticate the source transfer, destination receipt, and one-time cycle settlement',
      { intent },
    );
  }
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  const legs = stateValues(cycle?.relayLegs).filter(leg => leg?.direction === 'outbound');
  if (legs.length === 0) return null;
  if (legs.length !== 1) {
    throw new OutboundRecoveryRequiredError('OUTBOUND_RELAY_LEG_AMBIGUOUS', 'more than one recorded outbound Relay leg requires operator recovery');
  }
  const leg = legs[0];
  if (typeof leg.sourceTxHash !== 'string' || leg.sourceTxHash.length === 0) return null;
  const allOutboundAttempts = stateValues(cycle?.chainAttempts).filter(candidate => candidate?.attempt?.stage === 'outbound');
  const records = allOutboundAttempts.filter(record => typeof record.attempt.hash === 'string'
    && record.attempt.hash.toLowerCase() === leg.sourceTxHash.toLowerCase());
  if (records.length !== 1) {
    throw new OutboundRecoveryRequiredError('OUTBOUND_CHAIN_ATTEMPT_AMBIGUOUS', 'the outbound Relay leg cannot be matched to one durable chain attempt');
  }
  const record = records[0];
  const configured = assertOutboundConfiguration(config);

  if (leg.schema !== 'hookemon.relay-leg.v2' || leg.sourceAssetId !== 'native' || leg.sourceDecimals !== 18
    || allOutboundAttempts.length !== 1) throw new OutboundRecoveryRequiredError('OUTBOUND_CHAIN_ATTEMPT_AMBIGUOUS', 'native outbound requires one exact native deposit attempt');
  if (leg.state === 'SETTLED') return outboundSettlementEvidence(leg);
  if (leg.state !== 'RECORDED') {
    if (TERMINAL_RELAY_LEG_STATES.has(leg.state) && record.attempt?.state === 'FINALIZED') {
      await releaseOutboundWalletNonce({ cycleRepository, configured, context });
    }
    return null;
  }
  if (!['SIGNED', 'BROADCAST', 'FINALIZED'].includes(record.attempt.state)) return null;
  const robinhoodClient = adapters?.robinhood?.client;
  const solanaClient = adapters?.solana?.client;
  if (!robinhoodClient) return null;

  let sourceProof;
  let gasProof;
  try {
    const signed = parseTransaction(record.attempt.rawBytes);
    const recovery = await cycleRepository.readChainAttemptRecoveryContext(context.cycleId, { stage: 'outbound', recipient: null, requestDigest: record.attempt.requestDigest, rawSignedBytesHash: record.attempt.hash });
    const recoveryIntent = recovery?.relayIntent;
    if (!recoveryIntent?.orderId) return null;
    assertOutboundRelayEnvelope([{ transaction: { to: signed.to, value: String(signed.value), data: signed.data } }], {
      operationsAccount: configured.evm, depository: configured.evmDepository, amountAtomic: leg.sourceAmountAtomic, orderId: recoveryIntent.orderId,
    });
    const proofInput = { client: robinhoodClient, signedTransaction: record.attempt.rawBytes,
      expected: { kind: 'direct', chainId: EVM_CHAIN_ID, assetId: 'native', decimals: 18, source: configured.evm,
        recipient: configured.evmDepository, amountWei: leg.sourceAmountAtomic, transactionHash: leg.sourceTxHash,
        calldataDigest: keccak256(signed.data), nonce: String(signed.nonce) } };
    gasProof = await createNativeTransactionGasProof(proofInput);
    if (gasProof.receiptStatus === 'success') sourceProof = await createNativePaymentProof(proofInput);
  } catch {
    return null;
  }
  if (gasProof.receiptStatus === 'reverted') {
    await recordNativeOutboundCustody({ cycleRepository, context, adapters, configured, proof: gasProof, gasOnly: true });
    throw new OutboundRecoveryRequiredError('OUTBOUND_SOURCE_REVERTED', 'the finalized outbound source reverted; gas is recorded and principal remains reserved');
  }

  const sourceFinality = observedOutboundSourceProof(sourceProof, leg);
  if (sourceFinality === null) return null;
  await recordNativeOutboundCustody({ cycleRepository, context, adapters, configured, proof: sourceProof });
  const finalizedAttempt = await finalizeOutboundSourceAttempt({ cycleRepository, context, record, leg, sourceFinality });
  if (finalizedAttempt.attempt.state !== 'FINALIZED') {
    throw new OutboundRecoveryRequiredError(
      'OUTBOUND_SOURCE_FINALITY_UNRECORDED',
      'the observed outbound source finality did not durably finalize its chain attempt',
    );
  }
  await releaseOutboundWalletNonce({ cycleRepository, configured, context });

  let destination = null;
  if (solanaClient) {
    try {
      destination = await discoverFinalizedRelayDestinationObservation(solanaClient, {
        owner: configured.solana,
        relayRequestId: leg.relayRequestId,
      });
    } catch {
      destination = null;
    }
  }
  if (observedPositiveDestinationCredit(destination)) {
    if (isExactOutboundDestinationCredit(leg, destination)) {
      const recoveryContext = await cycleRepository.readChainAttemptRecoveryContext(context.cycleId, {
        stage: 'outbound',
        recipient: null,
        requestDigest: record.attempt.requestDigest,
        rawSignedBytesHash: record.attempt.hash,
      });
      if (recoveryContext?.relayQuoteDeadlineUnixSeconds === undefined || recoveryContext.relayQuoteDeadlineUnixSeconds === null) {
        return null;
      }
    }
    const settled = await cycleRepository.settleRelayLeg(
      context.cycleId,
      leg.relayRequestId,
      Object.freeze({
        sourceProof,
        destinationObservation: destination,
      }),
    );
    return settled.state === 'SETTLED' ? outboundSettlementEvidence(settled) : null;
  }

  const recoveryContext = await cycleRepository.readChainAttemptRecoveryContext(context.cycleId, {
    stage: 'outbound',
    recipient: null,
    requestDigest: record.attempt.requestDigest,
    rawSignedBytesHash: record.attempt.hash,
  });
  const intent = boundOutboundRecoveryIntent(recoveryContext, leg, configured);
  if (intent === null || !adapters?.relay || !robinhoodClient) return null;
  let refundProof;
  try {
    adapters.relay.restoreIntent({ intent });
    const pointer = await adapters.relay.getTerminalOriginRefundTransactionPointer({
      intentDigest: intent.requestId,
    });
    if (pointer === null) return null;
    refundProof = await readOutboundOriginRefundProof({
      client: robinhoodClient,
      pointer,
      leg,
      sourceFinality,
      sourceAccount: configured.evmDepository,
      operationsAccount: configured.evm,
      sourceProof, signedSourceTransaction: record.attempt.rawBytes, nativePaymentBinding: config.nativePaymentBinding, orderId: intent.orderId,
    });
  } catch {
    return null;
  }
  if (refundProof === null) return null;
  const settled = await cycleRepository.settleRelayLeg(
    context.cycleId,
    leg.relayRequestId,
    Object.freeze({
      sourceProof,
      refundProof,
    }),
  );
  return settled.state === 'SETTLED' ? outboundSettlementEvidence(settled) : null;
}
