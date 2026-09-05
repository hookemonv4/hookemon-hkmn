import {
  DIRECTIONS,
  RELAY_CONSTANTS,
  assertQuoteUsable,
} from '../../relay-client.mjs';
import {
  buildRelayLegacyTransaction,
  readBlockHeight,
  readFinalizedRelaySourceDebit,
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
} from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  readTransactionPolicyRules,
} from '../../signing/transaction-policy.mjs';
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
import { walletNonceLeaseWindow } from '../wallet-nonce-lease.mjs';

const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_WORD = /^0x[0-9a-fA-F]{64}$/;
const USDG_ADDRESS = RELAY_CONSTANTS.USDG_ADDRESS.toLowerCase();
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

function typedAmount(leg) {
  return Object.freeze({
    chainId: String(leg.chainId),
    assetId: leg.chainId === RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID ? leg.address.toLowerCase() : leg.address,
    decimals: leg.decimals,
    amountAtomic: leg.amount,
  });
}

function assertReturnConfiguration(config) {
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

/** Only a ledger-attributed, not a wallet-wide, proceeds delta may enter the return quote. */
export function returnableProceedsDelta(ledger) {
  if (!ledger) throw new Error('return requires a cycle custody ledger for the configured Solana mint');
  const proceeds = BigInt(canonicalAmount(ledger.buybackProceeds, 'return custody buybackProceeds'));
  const committed = BigInt(canonicalAmount(ledger.returnInput, 'return custody returnInput'));
  if (committed > proceeds) throw new Error('return custody returnInput exceeds buybackProceeds');
  return (proceeds - committed).toString();
}

function assertReturnQuote(quote, config, money = null) {
  if (!quote || quote.direction !== DIRECTIONS.RETURN) throw new Error('return requires a RETURN Relay quote');
  if (quote.origin?.chainId !== RELAY_CONSTANTS.SOLANA_CHAIN_ID || quote.origin?.address !== config.solanaMint) {
    throw new Error('return quote origin does not match the configured Solana mint');
  }
  if (quote.destination?.chainId !== RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID || quote.destination?.address?.toLowerCase() !== USDG_ADDRESS) {
    throw new Error('return quote destination is not USDG on chain 4663');
  }
  if (quote.sender !== config.solana) throw new Error('return quote sender does not match Operations Solana account');
  if (quote.recipient?.toLowerCase() !== config.evm.toLowerCase()) throw new Error('return quote recipient does not match Operations EVM account');
  canonicalAmount(quote.origin.amount, 'return quote origin amount');
  canonicalAmount(quote.destination.amount, 'return quote destination amount');
  if (!Number.isInteger(quote.origin.decimals) || !Number.isInteger(quote.destination.decimals)) {
    throw new Error('return quote is missing asset decimals');
  }
  if (money !== null && (quote.origin.decimals !== money.assets.solanaStablecoin.decimals
    || quote.destination.decimals !== money.assets.usdg.decimals)) {
    throw new Error('return quote decimals do not match MoneyConfigurationV1 assets');
  }
  return quote;
}

/**
 * Relay's recorded Solana return shape contains instructions and ALT addresses, not a serialized
 * transaction. Preserve exactly that shape and fail before signing until the provider supplies a
 * documented serializable transaction plus a read-only ALT resolver.
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
  const ledger = custodyLedgerFor(cycle, { chainId: String(RELAY_CONSTANTS.SOLANA_CHAIN_ID), assetId: configured.solanaMint });
  const amountAtomic = returnableProceedsDelta(ledger);
  if (amountAtomic === '0') throw new Error('return has no uncommitted cycle-attributed proceeds');
  const quote = await adapters.relay.quoteReturnBridge({
    user: configured.solana,
    recipient: configured.evm,
    amount: amountAtomic,
    originCurrency: configured.solanaMint,
  });
  assertReturnQuote(quote, configured, money);
  assertQuoteUsable({ quote, nowMs });
  const execution = adapters.relay.prepareExecution({ quote, liveMode: true });
  return Object.freeze({
    schema: 'hookemon.return-relay-request.v1',
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
  const ledger = custodyLedgerFor(cycle, { chainId: String(RELAY_CONSTANTS.SOLANA_CHAIN_ID), assetId: config.relay.solanaMint });
  let amountAtomic;
  try {
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

function assertReturnMoneyConfiguration(config, configured) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, 'return money configuration');
  } catch (error) {
    throw new Error(`return requires MoneyConfigurationV1: ${error.message}`);
  }
  if (money.assets.usdg.chainId !== EVM_CHAIN_ID
    || money.assets.usdg.assetId.toLowerCase() !== USDG_ADDRESS
    || money.assets.usdg.decimals !== 6) {
    throw new Error('return MoneyConfigurationV1 USDG asset does not match the configured Robinhood route');
  }
  if (money.assets.solanaStablecoin.chainId !== SOLANA_CHAIN_ID
    || money.assets.solanaStablecoin.assetId !== configured.solanaMint) {
    throw new Error('return MoneyConfigurationV1 Solana asset does not match the configured Relay route');
  }
  return money;
}

function assertReturnMutationRepository(cycleRepository) {
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
  const reservation = returnWalletReservation(configured, context);
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
    returnWalletReservation(configured, context),
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
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: request.intent,
      requestCreatedAtUnixSeconds: request.requestCreatedAtUnixSeconds,
      maxSettlementWindowSeconds: request.maxSettlementWindowSeconds,
    },
  });
}

function assertReturnRequest({ request, context, cycle, configured, money }) {
  if (!request || request.schema !== 'hookemon.return-relay-request.v1' || request.cycleId !== context.cycleId) {
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
    assetId: USDG_ADDRESS,
    decimals: money.assets.usdg.decimals,
    amountAtomic: request.destinationAmount?.amountAtomic,
  })) {
    throw new Error('return request assets do not match MoneyConfigurationV1');
  }
  canonicalAmount(request.inputAmount.amountAtomic, 'return request input amount');
  canonicalAmount(request.destinationAmount.amountAtomic, 'return request destination amount');
  if (request.inputAmount.amountAtomic === '0') throw new Error('return requires positive cycle-attributed proceeds');
  const ledger = custodyLedgerFor(cycle, { chainId: SOLANA_CHAIN_ID, assetId: configured.solanaMint });
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

function canonicalPositiveInteger(value, label) {
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
    throw new Error('return Relay priority fee exceeds the configured MoneyConfigurationV1 cap');
  }
}

function maximumReturnPriorityFeeLamports(decoded) {
  if (decoded.priorityFee === null) return 0n;
  const computeUnitLimit = canonicalPositiveInteger(decoded.gas?.computeUnitLimit, 'return decoded compute-unit limit');
  const microLamports = BigInt(decoded.priorityFee.amountAtomic);
  return ((BigInt(computeUnitLimit) * microLamports) + 999_999n) / 1_000_000n;
}

async function assertReturnLamportReserve({ client, configured, money, decoded }) {
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

async function createReturnPolicySigner({ signerClient, client, configured, request, transaction, requestDigest, blockhash, blockhashLastValidHeight, money, now, preflightAuthority }) {
  if (!signerClient?.solana || typeof signerClient.solana.sign !== 'function' || typeof signerClient.solana.broadcast !== 'function') {
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
    || !sameAmount(decoded.amount, request.inputAmount)
    || decoded.mint !== request.inputAmount.assetId
    || decoded.blockhash !== blockhash) {
    throw new Error('return decoded Solana transaction does not match the frozen Relay instruction plan and cycle proceeds');
  }
  assertReturnPriorityFeeCap(decoded, money);
  const policy = createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage: 'return', requestDigest }),
    rules: [exactPolicyRule(decoded, 'relay-return-step')],
  });
  const policyRules = readTransactionPolicyRules(policy);
  const rawSigner = signerClient.solana;
  const policySigner = wrapTransactionPolicySignerClient({
    client: {
      role: rawSigner.role ?? OPERATOR_SOLANA_ROLE,
      sign: requestValue => rawSigner.sign(requestValue),
      broadcast: signed => rawSigner.broadcast(signed),
    },
    policy,
    rules: policyRules,
    decodeOptions,
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
      return policySigner.broadcast(signed);
    },
  });
}

function returnRecoveryContext({ context, requestDigest, rawSignedBytesHash, approval, blockhashLastValidHeight }) {
  return Object.freeze({
    stage: 'return',
    recipient: null,
    requestDigest,
    policyDigest: approval.policyDigest,
    approvalDigest: approval.approvalDigest,
    fencingToken: context.fencingToken,
    fencingTokenDigest: canonicalDigest({
      schema: 'hookemon.wallet-nonce-reservation.v1',
      chainId: SOLANA_CHAIN_ID,
      stage: 'return',
      fencingToken: context.fencingToken,
    }),
    approvedSemanticsDigest: approval.approvedSemanticsDigest,
    rawSignedBytesHash,
    signedMessageDigest: approval.signedMessageDigest,
    blockhashLastValidHeight,
  });
}

function returnPolicyRecoveryContext(recoveryContext) {
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

function assertReturnBroadcastHash(result, expectedHash) {
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
  context,
  request,
  preflightAuthority,
  now = Date.now,
}) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateReturn reached without liveMode');
  if (typeof context?.requestDigest !== 'string' || !DIGEST.test(context.requestDigest)) {
    throw new Error('return requires the durable stage request digest');
  }
  assertReturnMutationRepository(cycleRepository);
  const configured = assertReturnConfiguration(config);
  const money = assertReturnMoneyConfiguration(config, configured);
  const client = adapters?.solana?.client;
  if (!client) throw new Error('return requires a configured Solana RPC client');
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  assertReturnRequest({ request, context, cycle, configured, money });
  assertQuoteUsable({ quote: request.intent, nowMs: now() });
  await cycleRepository.recordRelayLeg(context.cycleId, returnRelayLeg(context, request));
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

function successfulEvmReceipt(receipt) {
  return receipt?.status === 'success' || receipt?.status === '0x1' || receipt?.status === 1 || receipt?.status === 1n;
}

function oneReturnTransfer(receipt) {
  if (!Array.isArray(receipt?.logs)) return null;
  const transfers = [];
  for (const log of receipt.logs) {
    if (typeof log?.topics?.[0] !== 'string' || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (typeof log.address !== 'string' || !EVM_ADDRESS.test(log.address)
      || log.topics.length !== 3 || !EVM_WORD.test(log.topics[1]) || !EVM_WORD.test(log.topics[2])
      || typeof log.data !== 'string' || !EVM_WORD.test(log.data)) {
      return null;
    }
    transfers.push({
      token: log.address.toLowerCase(),
      recipient: `0x${log.topics[2].slice(-40).toLowerCase()}`,
      amountAtomic: BigInt(log.data).toString(),
    });
  }
  return transfers.length === 1 ? transfers[0] : null;
}

/**
 * Builds ReturnLegDestinationProofV1 from Relay's authenticated hash pointer and this process's
 * own finalized Robinhood receipt. The Relay result supplies no amount or settlement conclusion.
 */
export async function readReturnLegDestinationProof({ client, pointer, leg, sourceFinality }) {
  if (!client || typeof client !== 'object') throw new Error('return destination proof requires a Robinhood RPC client');
  if (!pointer || pointer.schema !== 'hookemon.relay-terminal-destination-pointer.v1'
    || pointer.relayRequestId !== leg?.relayRequestId || pointer.status !== 'SUCCESS'
    || typeof pointer.destinationTxHash !== 'string' || !EVM_TRANSACTION_HASH.test(pointer.destinationTxHash)) {
    throw new Error('return destination proof requires an authenticated successful Relay transaction pointer');
  }
  const observation = await readFinalizedTransactionReceipt(client, pointer.destinationTxHash);
  if (!observation.finalized || !successfulEvmReceipt(observation.receipt)
    || observation.receiptBlockNumber === null || observation.receiptBlockHash === null) {
    return null;
  }
  const receiptBlock = await readBlockByNumber(client, observation.receiptBlockNumber);
  if (receiptBlock.hash !== observation.receiptBlockHash) return null;
  const transfer = oneReturnTransfer(observation.receipt);
  if (transfer === null) return null;
  const proof = assertReturnLegDestinationProof({
    schema: 'hookemon.return-leg-destination-proof.v1',
    relayRequestId: leg.relayRequestId,
    terminalStatus: {
      status: pointer.status,
      destinationTxHash: pointer.destinationTxHash.toLowerCase(),
    },
    sourceTxHash: leg.sourceTxHash,
    sourceFinality,
    destinationTxHash: pointer.destinationTxHash.toLowerCase(),
    destinationFinality: {
      height: receiptBlock.number.toString(),
      hash: receiptBlock.hash,
      timestampUnixSeconds: receiptBlock.timestamp.toString(),
    },
    transferCount: 1,
    observedToken: transfer.token,
    observedRecipient: transfer.recipient,
    observedAmountAtomic: transfer.amountAtomic,
  });
  processRpcReturnLegDestinationProofs.set(proof, Object.freeze({
    proofDigest: canonicalDigest(proof),
    relayRequestId: proof.relayRequestId,
    sourceTxHash: proof.sourceTxHash,
    destinationTxHash: proof.destinationTxHash.toLowerCase(),
  }));
  return proof;
}

/**
 * Finalizes the source chain attempt only after this process's own finalized Solana RPC proof,
 * then binds an authenticated Relay hash pointer to a separately finalized EVM receipt proof.
 */
export async function reconcileLiveReturn({ adapters, config, cycleRepository, context }) {
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
    return Object.freeze({
      schema: 'hookemon.return-relay-settlement-evidence.v1',
      relayLeg: Object.freeze(structuredClone(leg)),
    });
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
    source = await readFinalizedRelaySourceDebit(adapters.solana.client, {
      signature: leg.sourceTxHash,
      owner: config?.accounts?.solana,
      mint: leg.sourceAssetId,
      amountAtomic: leg.sourceAmountAtomic,
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
      sourceFinality: record.finalityEvidence.finalizedAtSource,
    });
  } catch {
    return null;
  }
  if (proof === null) return null;
  const settled = await cycleRepository.settleRelayLeg(context.cycleId, leg.relayRequestId, {
    returnDestinationProof: proof,
  });
  return settled.state === 'SETTLED'
    ? Object.freeze({
      schema: 'hookemon.return-relay-settlement-evidence.v1',
      relayLeg: Object.freeze(structuredClone(settled)),
    })
    : null;
}

/** Retained only to fail closed for a removed Phase 2 custody route. */
export async function submitDegradedReturnAcceptance() {
  throw new Error('accept-degraded-return is unavailable in the Phase 3 Operations model');
}
