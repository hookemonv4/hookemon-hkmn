import {
  DIRECTIONS,
  RELAY_CONSTANTS,
  assertQuoteUsable,
} from '../../relay-client.mjs';
import { keccak256 } from 'viem';
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
import { walletNonceLeaseWindow } from '../wallet-nonce-lease.mjs';

const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_DATA = /^0x[0-9a-fA-F]*$/;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_WORD = /^0x[0-9a-fA-F]{64}$/;
const EVM_CHAIN_ID = String(RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID);
const SOLANA_CHAIN_ID = String(RELAY_CONSTANTS.SOLANA_CHAIN_ID);
const USDG_ADDRESS = RELAY_CONSTANTS.USDG_ADDRESS.toLowerCase();
const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const RELAY_DEPOSIT_SELECTOR = '0xe8017952';
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
    assetId: leg.chainId === RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID ? leg.address.toLowerCase() : leg.address,
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
    throw new Error(`outbound requires MoneyConfigurationV1: ${error.message}`);
  }
  if (money.assets.usdg.chainId !== EVM_CHAIN_ID || money.assets.usdg.assetId.toLowerCase() !== USDG_ADDRESS || money.assets.usdg.decimals !== 6) {
    throw new Error('outbound MoneyConfigurationV1 USDG asset does not match the configured Robinhood route');
  }
  if (money.assets.solanaStablecoin.chainId !== SOLANA_CHAIN_ID
    || money.assets.solanaStablecoin.assetId !== configured.solanaMint) {
    throw new Error('outbound MoneyConfigurationV1 Solana asset does not match the configured Relay route');
  }
  return money;
}

function assertOutboundQuote(quote, config, money = null) {
  if (!quote || quote.direction !== DIRECTIONS.OUTBOUND) throw new Error('outbound requires an OUTBOUND Relay quote');
  if (quote.origin?.chainId !== RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID || quote.origin?.address?.toLowerCase() !== USDG_ADDRESS) {
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
  if (money !== null && (quote.origin.decimals !== money.assets.usdg.decimals
    || quote.destination.decimals !== money.assets.solanaStablecoin.decimals)) {
    throw new Error('outbound quote decimals do not match MoneyConfigurationV1 assets');
  }
  return quote;
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
  if (transactions.length !== 2) throw new Error('outbound Relay quote must contain exactly the recorded approval and deposit transactions');
  const [approvalPlan, depositPlan] = transactions;
  const approval = approvalPlan.transaction;
  const deposit = depositPlan.transaction;
  if (!equalEvmAddress(approval.to, USDG_ADDRESS) || String(approval.value) !== '0') {
    throw new Error('outbound Relay approval must target USDG with zero native value');
  }
  const [approvalSpenderWord, approvalAmountWord] = calldataWords(approval.data, ERC20_APPROVE_SELECTOR, 2, 'outbound Relay approval');
  if (!equalEvmAddress(evmAddressFromWord(approvalSpenderWord, 'outbound Relay approval spender'), depository)) {
    throw new Error('outbound Relay approval spender is outside the configured depository allowlist');
  }
  if (atomicAmountFromWord(approvalAmountWord, 'outbound Relay approval amount') !== amountAtomic) {
    throw new Error('outbound Relay approval amount does not equal the cycle reserve');
  }
  if (!equalEvmAddress(deposit.to, depository) || String(deposit.value) !== '0') {
    throw new Error('outbound Relay deposit does not target the configured depository with zero native value');
  }
  const [depositSenderWord, depositAssetWord, depositAmountWord, depositOrderIdWord] = calldataWords(
    deposit.data,
    RELAY_DEPOSIT_SELECTOR,
    4,
    'outbound Relay deposit',
  );
  if (!equalEvmAddress(evmAddressFromWord(depositSenderWord, 'outbound Relay deposit sender'), operationsAccount)
    || !equalEvmAddress(evmAddressFromWord(depositAssetWord, 'outbound Relay deposit asset'), USDG_ADDRESS)
    || atomicAmountFromWord(depositAmountWord, 'outbound Relay deposit amount') !== amountAtomic
    || `0x${depositOrderIdWord}`.toLowerCase() !== orderId.toLowerCase()) {
    throw new Error('outbound Relay deposit does not exactly bind Operations, USDG, the cycle reserve, and the Relay order');
  }
}

export function extractRelayEvmTransactions({
  steps, requestId, operationsAccount, depository, amountAtomic, orderId,
}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('outbound Relay quote has no steps');
  const transactions = [];
  for (const step of steps) {
    if (!step || step.kind !== 'transaction' || step.requestId !== requestId || !Array.isArray(step.items) || step.items.length === 0) {
      throw new Error('outbound Relay step is not a recorded transaction step for this quote');
    }
    for (let itemIndex = 0; itemIndex < step.items.length; itemIndex += 1) {
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
    tokenMetadata: Object.freeze({ [USDG_ADDRESS]: Object.freeze({ assetId: USDG_ADDRESS, decimals: 6 }) }),
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

/** Builds the immutable Relay request whose digest must be persisted before any signature. */
export async function prepareOutboundRequest({ adapters, config, cycleRepository, context, nowMs = Date.now() }) {
  if (!adapters?.relay) throw new Error('outbound requires a configured Relay client');
  const configured = assertOutboundConfiguration(config);
  const money = assertOutboundMoneyConfiguration(config, configured);
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  const amountAtomic = canonicalAmount(cycle?.releaseAmount, 'outbound cycle release amount');
  if (amountAtomic === '0') throw new Error('outbound requires a positive cycle release amount');
  const quote = await adapters.relay.quoteOutboundBridge({
    user: configured.evm,
    recipient: configured.solana,
    amount: amountAtomic,
    destinationCurrency: configured.solanaMint,
  });
  assertOutboundQuote(quote, configured, money);
  assertQuoteUsable({ quote, nowMs });
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
    schema: 'hookemon.outbound-relay-request.v1',
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
  const signer = wrapTransactionPolicySignerClient({ client: signerClient, policy, rules: policyRules, decodeOptions });
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
    schema: 'hookemon.relay-leg.v1',
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
  const reservation = outboundWalletReservation(configured, context);
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
    outboundWalletReservation(configured, context),
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
      throw new Error('outbound Relay gas price exceeds the configured MoneyConfigurationV1 cap');
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
  context,
  request,
  preflightAuthority,
  now = Date.now,
}) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateOutbound reached without liveMode');
  if (!signerClient?.evm || typeof signerClient.evm.sign !== 'function' || typeof signerClient.evm.broadcast !== 'function') {
    throw new Error('outbound requires an Operations EVM signer with sign and broadcast capabilities');
  }
  if (typeof context?.requestDigest !== 'string') throw new Error('outbound requires the durable stage request digest');
  if (typeof now !== 'function') throw new Error('outbound requires a wall-clock function');
  assertOutboundMutationRepository(cycleRepository);
  const configured = assertOutboundConfiguration(config);
  const money = assertOutboundMoneyConfiguration(config, configured);
  if (!request || request.schema !== 'hookemon.outbound-relay-request.v1' || request.cycleId !== context.cycleId) {
    throw new Error('outbound requires the canonical request prepared for this cycle');
  }
  if (request.inputAmount.amountAtomic === '0' || request.inputAmount.amountAtomic !== (await cycleRepository.describeCycle(context.cycleId)).releaseAmount) {
    throw new Error('outbound may sign only the cycle claimed principal');
  }
  if (request.inputAmount.chainId !== money.assets.usdg.chainId || request.inputAmount.assetId.toLowerCase() !== money.assets.usdg.assetId.toLowerCase()
    || request.inputAmount.decimals !== money.assets.usdg.decimals
    || request.destinationAmount.chainId !== money.assets.solanaStablecoin.chainId
    || request.destinationAmount.assetId !== money.assets.solanaStablecoin.assetId
    || request.destinationAmount.decimals !== money.assets.solanaStablecoin.decimals) {
    throw new Error('outbound request assets do not match MoneyConfigurationV1');
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
  if (proof?.finalized !== true || proof.successful !== true || proof.proofAvailable !== true) return null;
  if (proof.amountAtomic !== leg.sourceAmountAtomic
    || proof.sourceBalanceDeltaAtomic !== leg.sourceAmountAtomic
    || proof.recipientBalanceDeltaAtomic !== leg.sourceAmountAtomic) return null;
  return outboundSourceFinality(proof);
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
    || intent.schema !== 'hookemon.relay-intent.v1'
    || intent.direction !== DIRECTIONS.OUTBOUND
    || intent.requestId !== leg.relayRequestId
    || String(intent.originChainId) !== leg.sourceChainId
    || !equalEvmAddress(intent.originAssetId, leg.sourceAssetId)
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

function outboundRefundTransfer(receipt, { token, source, recipient }) {
  if (!Array.isArray(receipt?.logs)) return null;
  const transfers = [];
  for (const log of receipt.logs) {
    if (typeof log?.topics?.[0] !== 'string' || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (typeof log.address !== 'string' || !EVM_ADDRESS.test(log.address)
      || log.topics.length !== 3 || !EVM_WORD.test(log.topics[1]) || !EVM_WORD.test(log.topics[2])
      || typeof log.data !== 'string' || !EVM_WORD.test(log.data)) {
      return null;
    }
    const observedSource = `0x${log.topics[1].slice(-40).toLowerCase()}`;
    const observedRecipient = `0x${log.topics[2].slice(-40).toLowerCase()}`;
    if (!equalEvmAddress(log.address, token)
      || !equalEvmAddress(observedSource, source)
      || !equalEvmAddress(observedRecipient, recipient)) continue;
    transfers.push({
      token: log.address.toLowerCase(),
      source: observedSource,
      recipient: observedRecipient,
      amountAtomic: BigInt(log.data).toString(),
    });
  }
  return transfers.length === 1 ? transfers[0] : null;
}

/**
 * Binds Relay's authenticated refund hash pointer to one finalized origin-chain USDG credit
 * observed through this process's Robinhood RPC client. The pointer remains only a locator.
 */
export async function readOutboundOriginRefundProof({ client, pointer, leg, sourceFinality, sourceAccount, operationsAccount }) {
  if (!client || typeof client !== 'object') throw new Error('outbound refund proof requires a Robinhood RPC client');
  if (!pointer || pointer.schema !== 'hookemon.relay-terminal-origin-refund-pointer.v1'
    || pointer.relayRequestId !== leg?.relayRequestId || pointer.status !== 'REFUND'
    || typeof pointer.refundTxHash !== 'string' || !EVM_TRANSACTION_HASH.test(pointer.refundTxHash)) {
    throw new Error('outbound refund proof requires an authenticated refunded Relay transaction pointer');
  }
  if (!EVM_ADDRESS.test(sourceAccount ?? '') || !EVM_ADDRESS.test(operationsAccount ?? '') || typeof leg?.sourceTxHash !== 'string'
    || !EVM_TRANSACTION_HASH.test(leg.sourceTxHash)
    || pointer.refundTxHash.toLowerCase() === leg.sourceTxHash.toLowerCase()) {
    return null;
  }
  if (canonicalUnixSeconds(sourceFinality?.timestampUnixSeconds) === null) return null;
  const observation = await readFinalizedTransactionReceipt(client, pointer.refundTxHash);
  if (!observation.finalized || !successfulEvmReceipt(observation.receipt)
    || observation.receiptBlockNumber === null || observation.receiptBlockHash === null) {
    return null;
  }
  const receiptBlock = await readBlockByNumber(client, observation.receiptBlockNumber);
  if (receiptBlock.hash !== observation.receiptBlockHash) return null;
  const transfer = outboundRefundTransfer(observation.receipt, {
    token: leg.sourceAssetId,
    source: sourceAccount,
    recipient: operationsAccount,
  });
  if (transfer === null || BigInt(transfer.amountAtomic) === 0n
    || BigInt(transfer.amountAtomic) > BigInt(leg.sourceAmountAtomic)) {
    return null;
  }
  const timestampUnixSeconds = canonicalUnixSeconds(String(receiptBlock.timestamp));
  if (timestampUnixSeconds === null || BigInt(timestampUnixSeconds) < BigInt(sourceFinality.timestampUnixSeconds)) {
    return null;
  }
  const proof = Object.freeze({
    schema: 'hookemon.outbound-relay-origin-refund-proof.v1',
    relayRequestId: leg.relayRequestId,
    terminalStatus: Object.freeze({ status: pointer.status, refundTxHash: pointer.refundTxHash.toLowerCase() }),
    sourceTxHash: leg.sourceTxHash,
    sourceFinality: Object.freeze(structuredClone(sourceFinality)),
    refundTxHash: pointer.refundTxHash.toLowerCase(),
    refundFinality: Object.freeze({
      height: receiptBlock.number.toString(),
      hash: receiptBlock.hash,
      timestampUnixSeconds,
    }),
    transferCount: 1,
    observedToken: transfer.token,
    observedSource: transfer.source,
    observedRecipient: transfer.recipient,
    observedAmountAtomic: transfer.amountAtomic,
  });
  processRpcOutboundRefundProofs.set(proof, Object.freeze({
    proofDigest: digest(proof),
    relayRequestId: proof.relayRequestId,
    sourceTxHash: proof.sourceTxHash.toLowerCase(),
    refundTxHash: proof.refundTxHash.toLowerCase(),
    observedSource: proof.observedSource,
  }));
  return proof;
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
    schema: 'hookemon.outbound-relay-settlement-evidence.v1',
    relayLeg: Object.freeze(structuredClone(leg)),
  });
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
  const records = stateValues(cycle?.chainAttempts)
    .filter(record => record?.attempt?.stage === 'outbound'
      && typeof record.attempt.hash === 'string'
      && record.attempt.hash.toLowerCase() === leg.sourceTxHash.toLowerCase());
  if (leg.state === 'SETTLED') return outboundSettlementEvidence(leg);
  if (leg.state !== 'RECORDED') {
    if (TERMINAL_RELAY_LEG_STATES.has(leg.state) && records.length === 1 && records[0].attempt?.state === 'FINALIZED') {
      const configured = assertOutboundConfiguration(config);
      await releaseOutboundWalletNonce({ cycleRepository, configured, context });
    }
    return null;
  }
  if (records.length !== 1) {
    throw new OutboundRecoveryRequiredError('OUTBOUND_CHAIN_ATTEMPT_AMBIGUOUS', 'the outbound Relay leg cannot be matched to one durable chain attempt');
  }
  const record = records[0];
  if (!['SIGNED', 'BROADCAST', 'FINALIZED'].includes(record.attempt.state)) return null;
  const configured = assertOutboundConfiguration(config);
  const robinhoodClient = adapters?.robinhood?.client;
  const solanaClient = adapters?.solana?.client;
  if (!robinhoodClient) return null;

  let sourceProof;
  try {
    sourceProof = await readFinalizedErc20TransferProof(robinhoodClient, {
      hash: leg.sourceTxHash,
      token: leg.sourceAssetId,
      source: configured.evm,
      recipient: configured.evmDepository,
      amountAtomic: leg.sourceAmountAtomic,
      evidenceClient: adapters?.robinhood?.historicalEvidenceClient,
    });
  } catch {
    return null;
  }
  const sourceFinality = observedOutboundSourceProof(sourceProof, leg);
  if (sourceFinality === null) return null;
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
