import { createHash } from 'node:crypto';

import { getAddress, isAddress } from 'viem';

import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  evaluate,
  readTransactionPolicyRules,
} from '../signing/transaction-policy.mjs';

export const ORIGIN_CHAIN_ID = 1;
export const DESTINATION_CHAIN_ID = 4663;
export const EVM_NATIVE_ASSET = '0x0000000000000000000000000000000000000000';
export const NATIVE_DECIMALS = 18;
export const GAS_LIMIT_MARGIN_BPS = 12_000n;
export const GAS_RESERVE_MARGIN_BPS = 20_000n;

const NATIVE_TRANSFER_GAS = 21_000n;

const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const NATIVE_AMOUNT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;
const REQUEST_ID = /^0x[0-9a-f]{64}$/i;

export class NativeBridgeError extends Error {}
export class NativeBridgePolicyError extends NativeBridgeError {}

function fail(message, ErrorClass = NativeBridgeError) {
  throw new ErrorClass(message);
}

function atomic(value, label) {
  if (typeof value !== 'string' || !CANONICAL_INTEGER.test(value)) fail(`${label} must be a canonical unsigned integer string`);
  return BigInt(value);
}

function chainId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive chain ID`);
  return parsed;
}

function normalizedAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) fail(`${label} must be an EVM address`, NativeBridgePolicyError);
  return getAddress(value);
}

function equalAddress(left, right) {
  return normalizedAddress(left, 'address').toLowerCase() === normalizedAddress(right, 'address').toLowerCase();
}

function amount(chain, amountAtomic) {
  return Object.freeze({
    chainId: String(chain),
    assetId: 'native',
    decimals: NATIVE_DECIMALS,
    amountAtomic: atomic(String(amountAtomic), 'amount').toString(),
  });
}

function parseNativeAmount(value) {
  if (typeof value !== 'string' || !NATIVE_AMOUNT.test(value)) fail('--amount must be max or a positive native amount with at most 18 decimal places');
  const [whole, fractional = ''] = value.split('.');
  const parsed = BigInt(whole) * 10n ** 18n + BigInt(`${fractional}${'0'.repeat(18 - fractional.length)}`);
  if (parsed <= 0n) fail('--amount must be greater than zero');
  return parsed;
}

function hexQuantity(value) {
  return `0x${atomic(String(value), 'RPC quantity').toString(16)}`;
}

function parsedQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) fail(`${label} RPC result must be a hex quantity`);
  return BigInt(value).toString();
}

function quotedCurrency(quote, key, expectedChain) {
  const leg = quote?.details?.[key];
  const currency = leg?.currency;
  if (!currency || Number(currency.chainId) !== expectedChain || !equalAddress(currency.address, EVM_NATIVE_ASSET)) {
    fail(`Relay quote ${key} must be the native asset on chain ${expectedChain}`, NativeBridgePolicyError);
  }
  if (currency.decimals !== NATIVE_DECIMALS) fail(`Relay quote ${key} must declare ${NATIVE_DECIMALS} decimals`, NativeBridgePolicyError);
  return atomic(leg.amount, `Relay quote ${key}.amount`).toString();
}

function quotedMinimumInputAmount(quote) {
  const minimum = quote?.details?.currencyIn?.minimumAmount;
  return minimum == null ? null : atomic(minimum, 'Relay quote input minimum amount');
}

function transactionItems(quote) {
  if (!Array.isArray(quote?.steps) || quote.steps.length !== 1) {
    fail('Relay quote must contain exactly one transaction step', NativeBridgePolicyError);
  }
  const [step] = quote.steps;
  if (step?.kind !== 'transaction' || !Array.isArray(step.items) || step.items.length !== 1 || !step.items[0]?.data) {
    fail('Relay quote must contain exactly one executable transaction item', NativeBridgePolicyError);
  }
  return step.items[0].data;
}

function policyRule(decoded) {
  const exactAmount = value => (value === null ? null : { exact: value });
  const exactGas = Object.fromEntries(Object.entries(decoded.gas).map(([key, value]) => [
    key,
    value && typeof value === 'object' && Object.hasOwn(value, 'amountAtomic') ? exactAmount(value) : value,
  ]));
  const exactInstruction = instruction => ({
    ...instruction,
    amount: exactAmount(instruction.amount),
    nativeValue: exactAmount(instruction.nativeValue),
    priorityFee: exactAmount(instruction.priorityFee),
  });
  return {
    id: 'native-bridge-deposit',
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
    amount: exactAmount(decoded.amount),
    nativeValue: exactAmount(decoded.nativeValue),
    gas: exactGas,
    feePayer: decoded.feePayer,
    requiredSigners: decoded.requiredSigners,
    coSigners: decoded.coSigners,
    instructions: decoded.instructions.map(exactInstruction),
    extraInstructions: decoded.extraInstructions.map(exactInstruction),
    blockhash: decoded.blockhash,
    deadline: decoded.deadline,
    priorityFee: exactAmount(decoded.priorityFee),
  };
}

async function decodeAllowedTransaction(transaction, operationsAddress, amountAtomic) {
  const decoded = await decodeProviderTransaction({
    family: 'evm',
    chainId: ORIGIN_CHAIN_ID,
    transaction,
  });
  if (decoded.instructions.length !== 1 || decoded.instructions[0].kind !== 'evm-call') {
    fail('Relay quote must contain one native transfer or one native-value call', NativeBridgePolicyError);
  }
  if (decoded.amount !== null || decoded.mint !== null || decoded.token !== null) {
    fail('Relay quote must not include an ERC-20 transfer or approval', NativeBridgePolicyError);
  }
  if (decoded.nativeValue.amountAtomic !== amountAtomic) {
    fail('Relay quote transaction value does not equal the quoted native amount', NativeBridgePolicyError);
  }
  if (decoded.source === null || !equalAddress(decoded.source, operationsAddress)) {
    fail('Relay quote transaction source does not match the Operations EVM identity', NativeBridgePolicyError);
  }
  const canonical = createCanonicalTransactionPolicy({
    decoded,
    stage: 'outbound',
    expectedRecipient: decoded.destination,
    amount: decoded.nativeValue,
    allowedTargets: [decoded.target],
  });
  const policy = createTransactionPolicy({ policy: canonical, rules: [policyRule(decoded)] });
  evaluate(policy, decoded);
  return Object.freeze({ transaction: Object.freeze({ ...transaction, from: normalizedAddress(operationsAddress, 'Operations address') }), decoded, policy });
}

function maxFee(transaction) {
  const value = transaction.maxFeePerGas ?? transaction.gasPrice;
  if (value === undefined) fail('Relay quote transaction must include maxFeePerGas or gasPrice', NativeBridgePolicyError);
  return atomic(String(value), 'Relay quote max fee per gas').toString();
}

function requestId(quote) {
  if (typeof quote?.requestId !== 'string' || !REQUEST_ID.test(quote.requestId)) fail('Relay quote must include a 32-byte request ID', NativeBridgePolicyError);
  return quote.requestId;
}

export async function validateBridgeQuote({ quote, operationsAddress, amountAtomic }) {
  const requestedAmount = atomic(amountAtomic, 'requested amount').toString();
  const owner = normalizedAddress(operationsAddress, 'Operations address');
  if (!equalAddress(quote?.details?.sender, owner) || !equalAddress(quote?.details?.recipient, owner)) {
    fail('Relay quote sender and recipient must both equal the Operations EVM identity', NativeBridgePolicyError);
  }
  if (quotedCurrency(quote, 'currencyIn', ORIGIN_CHAIN_ID) !== requestedAmount) {
    fail('Relay quote input amount does not equal the requested native amount', NativeBridgePolicyError);
  }
  const minimumInputAmount = quotedMinimumInputAmount(quote);
  if (minimumInputAmount !== null && BigInt(requestedAmount) < minimumInputAmount) {
    fail('Relay quote input amount is below its minimum', NativeBridgePolicyError);
  }
  const destinationAmount = quotedCurrency(quote, 'currencyOut', DESTINATION_CHAIN_ID);
  const transaction = transactionItems(quote);
  if (chainId(transaction.chainId, 'Relay quote transaction') !== ORIGIN_CHAIN_ID) {
    fail('Relay quote transaction must execute on origin chain 1', NativeBridgePolicyError);
  }
  const approved = await decodeAllowedTransaction(transaction, owner, requestedAmount);
  return Object.freeze({
    requestId: requestId(quote),
    deadline: quote?.protocol?.v2?.orderData?.deadline ?? null,
    expectedReceivedAtomic: destinationAmount,
    transaction: approved.transaction,
    decoded: approved.decoded,
    policy: approved.policy,
    policyRules: readTransactionPolicyRules(approved.policy),
  });
}

function gasReserve({ gasLimit, maxFeePerGas }) {
  return (atomic(gasLimit, 'gas limit') * atomic(maxFeePerGas, 'max fee per gas') * GAS_RESERVE_MARGIN_BPS + 9_999n) / 10_000n;
}

function currentMaxFeePerGas(feeData) {
  const value = feeData?.maxFeePerGas ?? feeData?.gasPrice;
  if (value === undefined) fail('origin-chain fee data must include maxFeePerGas or gasPrice');
  return atomic(String(value), 'origin-chain max fee per gas');
}

function provisionalGasReserve(maxFeePerGas) {
  return (NATIVE_TRANSFER_GAS * maxFeePerGas * GAS_RESERVE_MARGIN_BPS + 9_999n) / 10_000n;
}

async function quoteAndEstimate({ relay, originRpc, operationsAddress, amountAtomic }) {
  const quote = await relay.quote({
    user: operationsAddress,
    recipient: operationsAddress,
    originChainId: ORIGIN_CHAIN_ID,
    destinationChainId: DESTINATION_CHAIN_ID,
    originCurrency: EVM_NATIVE_ASSET,
    destinationCurrency: EVM_NATIVE_ASSET,
    amount: amountAtomic,
    tradeType: 'EXACT_INPUT',
  });
  const validated = await validateBridgeQuote({ quote, operationsAddress, amountAtomic });
  const estimatedGas = atomic(await originRpc.estimateGas(validated.transaction), 'origin-chain gas estimate').toString();
  const limit = (atomic(estimatedGas, 'origin-chain gas estimate') * GAS_LIMIT_MARGIN_BPS + 9_999n) / 10_000n;
  const fee = maxFee(validated.transaction);
  return Object.freeze({ quote, validated, estimatedGas, gasLimit: limit.toString(), maxFeePerGas: fee });
}

export async function planNativeBridge({ amount: requested, signer, originRpc, relay }) {
  if (!signer || typeof signer.showAddress !== 'function') fail('signer.showAddress is required');
  if (!originRpc || typeof originRpc.getBalance !== 'function' || typeof originRpc.estimateGas !== 'function') fail('origin RPC balance and gas estimate methods are required');
  if (!relay || typeof relay.quote !== 'function') fail('Relay quote method is required');
  const operationsAddress = normalizedAddress(await signer.showAddress(), 'Operations address');
  const balanceAtomic = atomic(await originRpc.getBalance(operationsAddress), 'origin-chain balance').toString();
  let candidateAmount = requested === 'max' ? balanceAtomic : parseNativeAmount(requested).toString();
  let quoted;
  if (requested === 'max') {
    if (typeof originRpc.getFeeData !== 'function') fail('origin RPC fee data method is required for --amount max');
    const provisionalReserve = provisionalGasReserve(currentMaxFeePerGas(await originRpc.getFeeData()));
    candidateAmount = (atomic(balanceAtomic, 'origin-chain balance') - provisionalReserve).toString();
    if (BigInt(candidateAmount) <= 0n) fail('origin-chain balance cannot cover the provisional Relay gas reserve');
    quoted = await quoteAndEstimate({ relay, originRpc, operationsAddress, amountAtomic: candidateAmount });
    const available = atomic(balanceAtomic, 'origin-chain balance') - gasReserve(quoted);
    if (available <= 0n) fail('origin-chain balance cannot cover the Relay deposit gas reserve');
    if (available < BigInt(candidateAmount)) {
      candidateAmount = available.toString();
      quoted = await quoteAndEstimate({ relay, originRpc, operationsAddress, amountAtomic: candidateAmount });
    }
  } else {
    quoted = await quoteAndEstimate({ relay, originRpc, operationsAddress, amountAtomic: candidateAmount });
  }
  const reserve = gasReserve(quoted);
  if (atomic(balanceAtomic, 'origin-chain balance') < atomic(candidateAmount, 'bridge amount') + reserve) {
    fail('origin-chain balance cannot cover the requested bridge amount and gas reserve');
  }
  const signingTransaction = {
    ...quoted.validated.transaction,
    gas: quoted.gasLimit,
    ...(typeof originRpc.getTransactionCount === 'function'
      ? { nonce: await originRpc.getTransactionCount(operationsAddress) }
      : {}),
    type: quoted.validated.transaction.maxFeePerGas !== undefined ? 'eip1559' : 'legacy',
  };
  const signingApproval = await decodeAllowedTransaction(signingTransaction, operationsAddress, candidateAmount);
  return Object.freeze({
    schema: 'hookemon.ops-native-bridge-plan.v1',
    requestId: quoted.validated.requestId,
    operationsAddress,
    from: Object.freeze({ chainId: String(ORIGIN_CHAIN_ID), assetId: 'native', decimals: NATIVE_DECIMALS, balanceAtomic }),
    to: Object.freeze({ chainId: String(DESTINATION_CHAIN_ID), assetId: 'native', decimals: NATIVE_DECIMALS }),
    amount: amount(ORIGIN_CHAIN_ID, candidateAmount),
    destination: Object.freeze({ amount: amount(DESTINATION_CHAIN_ID, quoted.validated.expectedReceivedAtomic) }),
    gas: Object.freeze({
      limit: quoted.gasLimit,
      maxFeePerGas: amount(ORIGIN_CHAIN_ID, quoted.maxFeePerGas),
      reserve: amount(ORIGIN_CHAIN_ID, reserve),
    }),
    expiry: quoted.validated.deadline,
    transaction: signingApproval.transaction,
    policy: signingApproval.policy,
    policyRules: readTransactionPolicyRules(signingApproval.policy),
  });
}

function stateRecord(plan, signedTx = null, transactionHash = null, destinationBalanceBeforeAtomic = null) {
  return {
    schema: 'hookemon.ops-native-bridge-record.v1',
    requestId: plan.requestId,
    transaction: plan.transaction,
    rawSignedBytesDigest: signedTx === null ? null : `sha256:${createHash('sha256').update(signedTx).digest('hex')}`,
    signedTx,
    transactionHash,
    destinationBalanceBeforeAtomic,
    expectedDestinationAmountAtomic: plan.destination.amount.amountAtomic,
    operationsAddress: plan.operationsAddress,
  };
}

function assertState(state) {
  if (!state || typeof state.get !== 'function' || typeof state.set !== 'function') fail('state must provide get() and set()');
}

export async function executeNativeBridge({ plan, confirm, signer, originRpc, state, destinationBalanceBeforeAtomic = null }) {
  if (confirm !== true) return Object.freeze({ outcome: 'dry-run', exitCode: 2, plan });
  if (!signer || typeof signer.sign !== 'function') fail('signer.sign is required');
  if (!originRpc || typeof originRpc.sendRawTransaction !== 'function') fail('originRpc.sendRawTransaction is required');
  assertState(state);
  let record = await state.get(plan.requestId);
  if (record === undefined || record === null) {
    const signedTx = await signer.sign({
      liveMode: true,
      declaredChainId: ORIGIN_CHAIN_ID,
      allowNonDefaultChain: true,
      transaction: plan.transaction,
      transactionPolicy: plan.policy,
      transactionPolicyRules: plan.policyRules,
    });
    if (typeof signedTx !== 'string' || !signedTx.startsWith('0x')) fail('signer returned invalid signed transaction bytes');
    record = stateRecord(plan, signedTx, null, destinationBalanceBeforeAtomic);
    await state.set(plan.requestId, record);
  }
  if (typeof record.signedTx !== 'string' || !record.signedTx.startsWith('0x')) fail('persisted bridge record does not contain signed transaction bytes');
  if (record.transactionHash) return Object.freeze({ outcome: 'broadcast', transactionHash: record.transactionHash, record });
  const transactionHash = await originRpc.sendRawTransaction(record.signedTx);
  if (typeof transactionHash !== 'string' || !REQUEST_ID.test(transactionHash)) fail('origin-chain RPC returned an invalid transaction hash');
  record = { ...record, transactionHash };
  await state.set(plan.requestId, record);
  return Object.freeze({ outcome: 'broadcast', transactionHash, record });
}

export async function monitorNativeBridge({
  requestId: relayRequestId,
  expectedDestinationBalanceAtomic,
  relay,
  destinationRpc,
  maxAttempts = 180,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  intervalMs = 5_000,
}) {
  if (!relay || typeof relay.status !== 'function') fail('relay.status is required');
  if (!destinationRpc || typeof destinationRpc.getBalance !== 'function') fail('destinationRpc.getBalance is required');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) fail('maxAttempts must be a positive safe integer');
  const required = atomic(expectedDestinationBalanceAtomic, 'expected destination balance');
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [status, balance] = await Promise.all([relay.status(relayRequestId), destinationRpc.getBalance()]);
    if (atomic(balance, 'destination-chain native balance') >= required) {
      return Object.freeze({ outcome: 'credited', attempts: attempt, status, balanceAtomic: String(balance) });
    }
    if (attempt < maxAttempts) await delay(intervalMs);
  }
  return Object.freeze({ outcome: 'timeout', attempts: maxAttempts, exitCode: 1 });
}

export function formatNative(amountAtomic) {
  const value = atomic(amountAtomic, 'native amount');
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function rpcQuantity(value) {
  return hexQuantity(value);
}

export function parseRpcQuantity(value, label) {
  return parsedQuantity(value, label);
}
