import { createHash } from 'node:crypto';
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from 'viem';

import {
  compileDirectPayoutPlan,
  createUsdgPayoutAmount,
  directPayoutPlanDigest,
} from '../../../../runner/src/distribution/payout-plan.mjs';
import { digest as canonicalDigest } from '../../../../runner/src/cycle/journal.mjs';
import { assertMoneyConfiguration } from '../../../../runner/src/cycle/money-schemas.mjs';
import { requireLiveRetainedCustodyMutationAuthority } from '../../../../runner/src/cycle/preflight.mjs';
import { buildAuthorizePayoutCall, buildFundPayoutFromPegCycleCall, readPendingAuthorization } from '../../hook-contract-client.mjs';
import {
  readFinalizedErc20TransferProof,
  readFinalizedTransactionReceipt,
  readTransaction,
} from '../../robinhood-rpc.mjs';
import {
  OPERATOR_EVM_ROLE,
  isTransactionPolicySignerClient,
  readTransactionPolicyApprovalContext,
  recoverTransactionPolicyApproval,
  TRANSACTION_POLICY_APPROVAL_SCHEMA,
  wrapTransactionPolicySignerClient,
} from '../../signing/signer-client.mjs';
import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  readTransactionPolicyRules,
} from '../../signing/transaction-policy.mjs';
import { deriveAuthorizationNonce, deriveOnchainCycleId } from './action-builder.mjs';
import { StageMutationRevertedError } from './errors.mjs';
import { walletNonceLeaseWindow } from '../wallet-nonce-lease.mjs';

const STAGE = 'payout';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;
const RAW_TRANSACTION = /^0x(?:[0-9a-f]{2})+$/i;
const PLAN_FIELDS = [
  'schema',
  'cycleId',
  'eligibility',
  'returnEvidence',
  'returnDelta',
  'previousDust',
  'previousDustSource',
  'distributablePool',
  'totalEligibleHkmn',
  'allocations',
  'totalAllocated',
  'dust',
  'feasibility',
  'payableRecipientCount',
  'planDigest',
];
const ERC20_TRANSFER_ABI = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: 'ok', type: 'bool' }],
}];
const FROZEN_ABI = [{
  type: 'function',
  name: 'isFrozen',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ type: 'bool' }],
}];

export class DirectPayoutError extends Error {}

export class DirectPayoutNonceInterferenceError extends DirectPayoutError {
  constructor({ recipient, expectedNonce, observedNonce }) {
    super(`direct payout nonce interference for ${recipient}: expected ${expectedNonce}, observed ${observedNonce}`);
    this.name = 'DirectPayoutNonceInterferenceError';
    this.recipient = recipient;
    this.expectedNonce = expectedNonce;
    this.observedNonce = observedNonce;
  }
}

function fail(message) {
  throw new DirectPayoutError(message);
}

function copy(value) {
  return structuredClone(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function signedTransactionSha256(rawSignedBytes) {
  if (typeof rawSignedBytes !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(rawSignedBytes)) {
    fail('direct payout signed transaction bytes are not canonical hexadecimal');
  }
  return `sha256:${createHash('sha256').update(Buffer.from(rawSignedBytes.slice(2), 'hex')).digest('hex')}`;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} is invalid`);
  return value;
}

function payoutFencingTokenDigest(fencingToken) {
  if (typeof fencingToken !== 'string' || fencingToken.length === 0) {
    fail('direct payout fencing token is invalid');
  }
  return canonicalDigest({
    schema: 'hookemon.wallet-nonce-fence.v1',
    fencingToken,
  });
}

function approvalContextForSignedPayout({ policyApproval, material, requestDigest, fencingToken }) {
  if (!policyApproval || typeof policyApproval !== 'object' || Array.isArray(policyApproval)
    || policyApproval.schema !== TRANSACTION_POLICY_APPROVAL_SCHEMA
    || policyApproval.family !== 'evm') {
    fail('direct payout signer did not provide a transaction-policy approval context');
  }
  for (const field of ['policyDigest', 'approvalDigest', 'approvedSemanticsDigest', 'signedMessageDigest']) {
    assertDigest(policyApproval[field], `direct payout signer ${field}`);
  }
  if ((requestDigest === null) !== (fencingToken === null)) {
    fail('direct payout signing context requires both request digest and fencing token');
  }
  if (requestDigest !== null) assertDigest(requestDigest, 'direct payout request digest');
  if (policyApproval.signedMessageDigest !== signedTransactionSha256(material.rawSignedBytes)) {
    fail('direct payout signer approval context does not bind the exact signed bytes');
  }
  return Object.freeze({
    requestDigest,
    fencingToken,
    fencingTokenDigest: fencingToken === null ? null : payoutFencingTokenDigest(fencingToken),
    policyDigest: policyApproval.policyDigest,
    approvalDigest: policyApproval.approvalDigest,
    approvedSemanticsDigest: policyApproval.approvedSemanticsDigest,
    signedMessageDigest: policyApproval.signedMessageDigest,
  });
}

function normalizePayoutApprovalContext(value, index, attempt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`direct payout recipient attempt ${index} approval context is invalid`);
  }
  const fields = [
    'requestDigest',
    'fencingToken',
    'fencingTokenDigest',
    'policyDigest',
    'approvalDigest',
    'approvedSemanticsDigest',
    'signedMessageDigest',
  ];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    fail(`direct payout recipient attempt ${index} approval context must use the exact schema`);
  }
  if ((value.requestDigest === null) !== (value.fencingToken === null)
    || (value.fencingToken === null) !== (value.fencingTokenDigest === null)) {
    fail(`direct payout recipient attempt ${index} approval context is incomplete`);
  }
  if (value.requestDigest !== null) {
    assertDigest(value.requestDigest, `direct payout recipient attempt ${index} request digest`);
    if (typeof value.fencingToken !== 'string' || value.fencingToken.length === 0
      || value.fencingTokenDigest !== payoutFencingTokenDigest(value.fencingToken)) {
      fail(`direct payout recipient attempt ${index} fencing token digest is invalid`);
    }
  }
  for (const field of ['policyDigest', 'approvalDigest', 'approvedSemanticsDigest', 'signedMessageDigest']) {
    assertDigest(value[field], `direct payout recipient attempt ${index} ${field}`);
  }
  if (value.signedMessageDigest !== signedTransactionSha256(attempt.rawSignedBytes)) {
    fail(`direct payout recipient attempt ${index} approval context does not bind the signed bytes`);
  }
  return {
    requestDigest: value.requestDigest,
    fencingToken: value.fencingToken,
    fencingTokenDigest: value.fencingTokenDigest,
    policyDigest: value.policyDigest,
    approvalDigest: value.approvalDigest,
    approvedSemanticsDigest: value.approvedSemanticsDigest,
    signedMessageDigest: value.signedMessageDigest,
  };
}

function assertAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value) || !ADDRESS.test(value)) fail(`${label} must be an EVM address`);
  return getAddress(value).toLowerCase();
}

function assertAtomic(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !ATOMIC.test(value) || (positive && value === '0')) {
    fail(`${label} must be a ${positive ? 'positive ' : ''}canonical atomic integer string`);
  }
  return value;
}

function assertUsdAmount(value, label, expectedAssetId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a typed USDG amount`);
  const fields = ['chainId', 'assetId', 'decimals', 'amountAtomic'];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    fail(`${label} must use the exact typed amount schema`);
  }
  if (!(value.chainId === 4663 || value.chainId === '4663') || value.decimals !== 6) {
    fail(`${label} must identify USDG on chain 4663 with six decimals`);
  }
  const assetId = assertAddress(value.assetId, `${label} assetId`);
  if (expectedAssetId !== null && assetId !== assertAddress(expectedAssetId, `${label} expected assetId`)) {
    fail(`${label} must identify the configured USDG asset`);
  }
  return createUsdgPayoutAmount({ assetId, amountAtomic: assertAtomic(value.amountAtomic, `${label} amountAtomic`) });
}

function assertHkmnAmount(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a typed HKMN amount`);
  const fields = ['chainId', 'assetId', 'decimals', 'amountAtomic'];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    fail(`${label} must use the exact typed amount schema`);
  }
  if (
    !(value.chainId === 4663 || value.chainId === '4663')
    || !Number.isInteger(value.decimals)
    || value.decimals < 0
    || value.decimals > 255
  ) {
    fail(`${label} must identify a configured HKMN amount on chain 4663`);
  }
  return {
    chainId: 4663,
    assetId: assertAddress(value.assetId, `${label} assetId`),
    decimals: value.decimals,
    amountAtomic: assertAtomic(value.amountAtomic, `${label} amountAtomic`, { positive: true }),
  };
}

function equalAddress(left, right) {
  return assertAddress(left, 'address') === assertAddress(right, 'address');
}

function stateRecipient(state, recipient) {
  const canonicalRecipient = assertAddress(recipient, 'recipient');
  const index = state.recipients.findIndex(entry => entry.recipient === canonicalRecipient);
  if (index === -1) fail(`direct payout recipient ${canonicalRecipient} is not in the payout plan`);
  return { index, recipient: canonicalRecipient, attempt: state.recipients[index] };
}

function eligibilityManifestAmount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...value, chainId: String(value.chainId) };
}

function rebuildPlanFromFrozenEvidence(value) {
  const eligibility = value.eligibility;
  const feasibility = value.feasibility;
  return compileDirectPayoutPlan({
    cycleId: value.cycleId,
    eligibilityManifest: {
      schema: 'hookemon.eligibility-payout-manifest.v1',
      cycleId: value.cycleId,
      snapshotBlock: eligibility?.snapshotBlock,
      snapshotHash: eligibility?.snapshotHash,
      finality: eligibility?.finality,
      supply: eligibilityManifestAmount(eligibility?.supply),
      entries: value.allocations.map(allocation => ({
        recipient: allocation?.recipient,
        hkmnBalance: eligibilityManifestAmount(allocation?.hkmnBalance),
      })),
      exclusions: eligibility?.exclusions,
      feasibility: {
        ...(feasibility ?? {}),
        estimatedNativeFee: eligibilityManifestAmount(feasibility?.estimatedNativeFee),
        nativeReserve: eligibilityManifestAmount(feasibility?.nativeReserve),
        nativeBalance: eligibilityManifestAmount(feasibility?.nativeBalance),
        requiredNativeAmount: eligibilityManifestAmount(feasibility?.requiredNativeAmount),
        feasible: true,
        reason: null,
      },
      logCompleteness: eligibility?.logCompleteness,
      holderSnapshotDigest: eligibility?.holderSnapshotDigest,
      launchManifestDigest: eligibility?.launchManifestDigest,
    },
    finalizedReturn: value.returnDelta,
    previousDust: value.previousDust,
    previousDustSource: value.previousDustSource,
    returnBinding: value.returnEvidence,
  });
}

function assertPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('direct payout plan is required');
  if (Object.keys(value).length !== PLAN_FIELDS.length || !PLAN_FIELDS.every(field => Object.hasOwn(value, field))) {
    fail('direct payout plan must use the immutable plan schema');
  }
  if (value.schema !== 'hookemon.direct-payout-plan.v1') fail('direct payout plan schema is invalid');
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) fail('direct payout plan cycleId is invalid');
  if (typeof value.planDigest !== 'string' || !DIGEST.test(value.planDigest)) fail('direct payout plan digest is invalid');
  if (!Array.isArray(value.allocations)) fail('direct payout plan allocations are invalid');
  if (value.planDigest !== directPayoutPlanDigest(value)) {
    fail('direct payout plan digest does not authenticate its immutable payload');
  }
  let rebuilt;
  try {
    rebuilt = rebuildPlanFromFrozenEvidence(value);
  } catch {
    fail('direct payout plan does not reconstruct from its frozen eligibility evidence');
  }
  if (rebuilt.planDigest !== value.planDigest) {
    fail('direct payout plan does not reconstruct from its frozen eligibility evidence');
  }
  const totalEligibleHkmn = assertHkmnAmount(value.totalEligibleHkmn, 'direct payout total eligible HKMN');
  if (!sameAmount(totalEligibleHkmn, rebuilt.totalEligibleHkmn)) {
    fail('direct payout plan total eligible HKMN does not match its frozen eligibility evidence');
  }
  const distributablePool = assertUsdAmount(value.distributablePool, 'direct payout distributable pool');
  const dust = assertUsdAmount(value.dust, 'direct payout dust');
  const totalAllocated = assertUsdAmount(value.totalAllocated, 'direct payout total allocated');
  const returnDelta = assertUsdAmount(value.returnDelta, 'direct payout return delta');
  const previousDust = assertUsdAmount(value.previousDust, 'direct payout previous dust');
  if (BigInt(returnDelta.amountAtomic) + BigInt(previousDust.amountAtomic) !== BigInt(distributablePool.amountAtomic)) {
    fail('direct payout plan return delta and prior dust do not match the distributable pool');
  }
  if (BigInt(totalAllocated.amountAtomic) + BigInt(dust.amountAtomic) !== BigInt(distributablePool.amountAtomic)) {
    fail('direct payout plan does not conserve its distributable pool');
  }
  if (!value.feasibility || value.feasibility.recipientCount !== value.allocations.length
    || value.feasibility.transactionCount !== value.allocations?.length
    || value.feasibility.maxRecipientCount < value.allocations.length
    || value.feasibility.maxTransactionCount < value.allocations.length) {
    fail('direct payout plan feasibility envelope is invalid');
  }
  const seen = new Set();
  const allocations = value.allocations.map((allocation, index) => {
    if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) fail(`direct payout allocation ${index} is invalid`);
    const fields = ['recipient', 'hkmnBalance', 'amount'];
    if (Object.keys(allocation).length !== fields.length || !fields.every(field => Object.hasOwn(allocation, field))) {
      fail(`direct payout allocation ${index} must use the immutable allocation schema`);
    }
    const recipient = assertAddress(allocation.recipient, `direct payout allocation ${index} recipient`);
    if (seen.has(recipient)) fail('direct payout plan recipients must be unique');
    seen.add(recipient);
    return { recipient, amount: assertUsdAmount(allocation.amount, `direct payout allocation ${index} amount`) };
  });
  const allocated = allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount.amountAtomic), 0n);
  if (allocated !== BigInt(totalAllocated.amountAtomic)) fail('direct payout plan allocation total is invalid');
  const payableRecipientCount = allocations.filter(allocation => allocation.amount.amountAtomic !== '0').length;
  if (!Number.isSafeInteger(value.payableRecipientCount) || value.payableRecipientCount !== payableRecipientCount) {
    fail('direct payout plan payableRecipientCount is invalid');
  }
  return {
    plan: value,
    distributablePool,
    dust,
    totalAllocated,
    returnDelta,
    previousDust,
    allocations,
  };
}

function directTransferCalldata(recipient, amountAtomic) {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [recipient, BigInt(amountAtomic)],
  }).toLowerCase();
}

function requiredNativeAmount(plan) {
  const amount = plan.feasibility?.requiredNativeAmount;
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)
    || !(amount.chainId === 4663 || amount.chainId === '4663')
    || amount.assetId !== 'native' || amount.decimals !== 18) {
    fail('direct payout plan lacks a native-balance feasibility envelope');
  }
  return BigInt(assertAtomic(amount.amountAtomic, 'direct payout required native amount'));
}

function normalizeNonce(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n) fail(`${label} must be nonnegative`);
    return value.toString();
  }
  return assertAtomic(String(value), label);
}

function normalizedState(stateValue) {
  const state = copy(stateValue);
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('direct payout state is invalid');
  if (state.schema !== 'hookemon.direct-payout-state.v1') fail('direct payout state schema is invalid');
  if (typeof state.cycleId !== 'string' || state.cycleId.length === 0) fail('direct payout state cycleId is invalid');
  if (typeof state.planDigest !== 'string' || !DIGEST.test(state.planDigest)) fail('direct payout state planDigest is invalid');
  const planInfo = assertPlan(state.plan);
  if (planInfo.plan.cycleId !== state.cycleId || planInfo.plan.planDigest !== state.planDigest) {
    fail('direct payout state does not retain its immutable payout plan');
  }
  state.operations = assertAddress(state.operations, 'direct payout state Operations address');
  state.usdgAddress = assertAddress(state.usdgAddress, 'direct payout state USDG address');
  if (state.operations !== planInfo.plan.returnEvidence.operations
    || state.usdgAddress !== planInfo.plan.returnEvidence.usdgAddress) {
    fail('direct payout state identities must match the bound finalized return identities');
  }
  if (typeof state.manifestFrozen !== 'boolean' || typeof state.feasibilityChecked !== 'boolean') {
    fail('direct payout state flags are invalid');
  }
  state.distributablePool = assertUsdAmount(state.distributablePool, 'direct payout state distributable pool');
  state.dust = assertUsdAmount(state.dust, 'direct payout state dust');
  if (state.distributablePool.amountAtomic !== planInfo.distributablePool.amountAtomic
    || state.dust.amountAtomic !== planInfo.dust.amountAtomic) {
    fail('direct payout state totals do not match its immutable payout plan');
  }
  state.firstNonce = assertAtomic(state.firstNonce, 'direct payout state firstNonce');
  state.nextNonce = assertAtomic(state.nextNonce, 'direct payout state nextNonce');
  state.gasPriceWei = assertAtomic(state.gasPriceWei, 'direct payout state gasPriceWei', { positive: true });
  if (BigInt(state.gasPriceWei) > BigInt(state.plan.feasibility.maxGasPriceWei)) {
    fail('direct payout state gasPriceWei exceeds its frozen gas-price cap');
  }
  if (BigInt(state.nextNonce) < BigInt(state.firstNonce)) fail('direct payout state nextNonce is invalid');
  if (!Array.isArray(state.recipients) || !Array.isArray(state.quarantine)) fail('direct payout state journals are invalid');
  const recipients = new Set();
  state.recipients = state.recipients.map((attempt, index) => normalizeAttempt(
    attempt,
    index,
    recipients,
    { operations: state.operations, maxGasPriceWei: state.plan.feasibility.maxGasPriceWei },
  ));
  state.quarantine = state.quarantine.map((liability, index) => normalizeQuarantine(liability, index));
  assertStateMatchesPlan(state, planInfo);
  return state;
}

function sameAmount(left, right) {
  return left.chainId === right.chainId
    && left.assetId === right.assetId
    && left.decimals === right.decimals
    && left.amountAtomic === right.amountAtomic;
}

function normalizeFinalizedTransfer(value, index, attempt, operations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`direct payout recipient attempt ${index} finality evidence is invalid`);
  }
  const fields = [
    'from', 'to', 'amount', 'finalizedBlockNumber', 'finalizedBlockHash',
    'receiptBlockNumber', 'receiptBlockHash', 'previousBlockNumber', 'previousBlockHash',
    'sourceBalanceBeforeAtomic', 'sourceBalanceAfterAtomic', 'sourceBalanceDeltaAtomic',
    'recipientBalanceBeforeAtomic', 'recipientBalanceAfterAtomic', 'recipientBalanceDeltaAtomic', 'logIndexes',
  ];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    fail(`direct payout recipient attempt ${index} finality evidence must use the exact schema`);
  }
  if (!equalAddress(value.from, operations) || !equalAddress(value.to, attempt.recipient)) {
    fail(`direct payout recipient attempt ${index} finality evidence has the wrong transfer endpoints`);
  }
  const amount = assertUsdAmount(value.amount, `direct payout recipient attempt ${index} finalized amount`);
  if (!sameAmount(amount, attempt.amount)) fail(`direct payout recipient attempt ${index} finality evidence has the wrong transfer amount`);
  const decimalFields = [
    'finalizedBlockNumber', 'receiptBlockNumber', 'previousBlockNumber',
    'sourceBalanceBeforeAtomic', 'sourceBalanceAfterAtomic', 'sourceBalanceDeltaAtomic',
    'recipientBalanceBeforeAtomic', 'recipientBalanceAfterAtomic', 'recipientBalanceDeltaAtomic',
  ];
  for (const field of decimalFields) {
    assertAtomic(value[field], `direct payout recipient attempt ${index} ${field}`, { positive: field === 'finalizedBlockNumber' || field === 'receiptBlockNumber' });
  }
  for (const field of ['finalizedBlockHash', 'receiptBlockHash', 'previousBlockHash']) {
    if (typeof value[field] !== 'string' || !TRANSACTION_HASH.test(value[field])) {
      fail(`direct payout recipient attempt ${index} ${field} is invalid`);
    }
  }
  if (value.sourceBalanceDeltaAtomic !== attempt.amount.amountAtomic
    || value.recipientBalanceDeltaAtomic !== attempt.amount.amountAtomic) {
    fail(`direct payout recipient attempt ${index} finality evidence has the wrong balance delta`);
  }
  if (!Array.isArray(value.logIndexes) || value.logIndexes.length === 0) {
    fail(`direct payout recipient attempt ${index} finality evidence must include transfer log indexes`);
  }
  const seenLogIndexes = new Set();
  for (const logIndex of value.logIndexes) {
    const canonical = assertAtomic(logIndex, `direct payout recipient attempt ${index} finality log index`);
    if (seenLogIndexes.has(canonical)) fail(`direct payout recipient attempt ${index} finality log indexes must be unique`);
    seenLogIndexes.add(canonical);
  }
  return {
    from: assertAddress(value.from, `direct payout recipient attempt ${index} finality from`),
    to: assertAddress(value.to, `direct payout recipient attempt ${index} finality to`),
    amount,
    finalizedBlockNumber: value.finalizedBlockNumber,
    finalizedBlockHash: value.finalizedBlockHash.toLowerCase(),
    receiptBlockNumber: value.receiptBlockNumber,
    receiptBlockHash: value.receiptBlockHash.toLowerCase(),
    previousBlockNumber: value.previousBlockNumber,
    previousBlockHash: value.previousBlockHash.toLowerCase(),
    sourceBalanceBeforeAtomic: value.sourceBalanceBeforeAtomic,
    sourceBalanceAfterAtomic: value.sourceBalanceAfterAtomic,
    sourceBalanceDeltaAtomic: value.sourceBalanceDeltaAtomic,
    recipientBalanceBeforeAtomic: value.recipientBalanceBeforeAtomic,
    recipientBalanceAfterAtomic: value.recipientBalanceAfterAtomic,
    recipientBalanceDeltaAtomic: value.recipientBalanceDeltaAtomic,
    logIndexes: [...value.logIndexes],
  };
}

function normalizeReplacementHistory(value, index, attempt, { maxGasPriceWei }) {
  if (!Array.isArray(value)) fail(`direct payout recipient attempt ${index} replacementHistory is invalid`);
  return value.map((entry, historyIndex) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`direct payout recipient attempt ${index} replacement history ${historyIndex} is invalid`);
    }
    const fields = ['rawSignedBytes', 'rawSignedBytesHash', 'txHash', 'nonce', 'calldataDigest', 'gasPriceWei'];
    if (Object.keys(entry).length !== fields.length || !fields.every(field => Object.hasOwn(entry, field))) {
      fail(`direct payout recipient attempt ${index} replacement history ${historyIndex} must use the exact schema`);
    }
    if (!RAW_TRANSACTION.test(entry.rawSignedBytes)
      || !TRANSACTION_HASH.test(entry.rawSignedBytesHash)
      || !TRANSACTION_HASH.test(entry.txHash)
      || entry.rawSignedBytesHash.toLowerCase() !== keccak256(entry.rawSignedBytes).toLowerCase()
      || entry.txHash.toLowerCase() !== entry.rawSignedBytesHash.toLowerCase()
      || assertAtomic(entry.nonce, `direct payout recipient attempt ${index} replacement history ${historyIndex} nonce`) !== attempt.nonce
      || entry.calldataDigest !== attempt.calldataDigest
      || BigInt(assertAtomic(entry.gasPriceWei, `direct payout recipient attempt ${index} replacement history ${historyIndex} gasPriceWei`, { positive: true }))
        > BigInt(maxGasPriceWei)) {
      fail(`direct payout recipient attempt ${index} replacement history ${historyIndex} is inconsistent`);
    }
    return {
      rawSignedBytes: entry.rawSignedBytes,
      rawSignedBytesHash: entry.rawSignedBytesHash.toLowerCase(),
      txHash: entry.txHash.toLowerCase(),
      nonce: entry.nonce,
      calldataDigest: entry.calldataDigest,
      gasPriceWei: entry.gasPriceWei,
    };
  });
}

function normalizeAttempt(value, index, recipients, { operations, maxGasPriceWei }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`direct payout recipient attempt ${index} is invalid`);
  const recipient = assertAddress(value.recipient, `direct payout recipient attempt ${index} recipient`);
  if (recipients.has(recipient)) fail('direct payout recipient attempts must be unique');
  recipients.add(recipient);
  const amount = assertUsdAmount(value.amount, `direct payout recipient attempt ${index} amount`);
  const states = new Set(['PREPARED', 'SIGNED', 'BROADCAST', 'FINALIZED', 'REFUSED', 'NONCE_INTERFERENCE']);
  if (!states.has(value.state)) fail(`direct payout recipient attempt ${index} state is invalid`);
  const nonce = value.nonce === null ? null : assertAtomic(value.nonce, `direct payout recipient attempt ${index} nonce`);
  if (nonce === null && !['PREPARED', 'REFUSED'].includes(value.state)) {
    fail(`direct payout recipient attempt ${index} is missing its persisted nonce`);
  }
  if (value.chainId !== 4663) fail(`direct payout recipient attempt ${index} chainId is invalid`);
  const gasPriceWei = assertAtomic(value.gasPriceWei, `direct payout recipient attempt ${index} gasPriceWei`, { positive: true });
  if (BigInt(gasPriceWei) > BigInt(maxGasPriceWei)) {
    fail(`direct payout recipient attempt ${index} gasPriceWei exceeds the frozen cap`);
  }
  if (typeof value.calldata !== 'string' || !/^0x[0-9a-f]*$/i.test(value.calldata)) fail(`direct payout recipient attempt ${index} calldata is invalid`);
  if (typeof value.calldataDigest !== 'string' || !DIGEST.test(value.calldataDigest)) fail(`direct payout recipient attempt ${index} calldataDigest is invalid`);
  const calldata = value.calldata.toLowerCase();
  if (calldata !== directTransferCalldata(recipient, amount.amountAtomic)
    || value.calldataDigest !== sha256(calldata)) {
    fail(`direct payout recipient attempt ${index} calldata does not match its recipient and amount`);
  }
  for (const field of ['rawSignedBytes', 'rawSignedBytesHash', 'txHash']) {
    if (value[field] !== null && typeof value[field] !== 'string') fail(`direct payout recipient attempt ${index} ${field} is invalid`);
  }
  const signed = ['SIGNED', 'BROADCAST', 'FINALIZED', 'NONCE_INTERFERENCE'].includes(value.state)
    || (value.state === 'REFUSED' && nonce !== null);
  if (signed) {
    if (typeof value.rawSignedBytes !== 'string' || !RAW_TRANSACTION.test(value.rawSignedBytes)
      || typeof value.rawSignedBytesHash !== 'string' || !TRANSACTION_HASH.test(value.rawSignedBytesHash)
      || typeof value.txHash !== 'string' || !TRANSACTION_HASH.test(value.txHash)) {
      fail(`direct payout recipient attempt ${index} is missing signed transaction evidence`);
    }
    if (value.rawSignedBytesHash.toLowerCase() !== keccak256(value.rawSignedBytes).toLowerCase()
      || value.txHash.toLowerCase() !== value.rawSignedBytesHash.toLowerCase()) {
      fail(`direct payout recipient attempt ${index} signed transaction hashes do not match raw bytes`);
    }
  } else if (value.rawSignedBytes !== null || value.rawSignedBytesHash !== null || value.txHash !== null) {
    fail(`direct payout recipient attempt ${index} has signed transaction evidence before signing`);
  }
  const attempt = {
    recipient,
    amount,
    state: value.state,
    nonce,
    chainId: 4663,
    gasPriceWei,
    calldata,
    calldataDigest: value.calldataDigest,
    rawSignedBytes: value.rawSignedBytes,
    rawSignedBytesHash: value.rawSignedBytesHash === null ? null : value.rawSignedBytesHash.toLowerCase(),
    txHash: value.txHash === null ? null : value.txHash.toLowerCase(),
    finalizedTransfer: null,
    replacementOf: value.replacementOf === null ? null : value.replacementOf,
    replacementHistory: [],
    refusalEvidence: null,
    nonceInterference: null,
    approvalContext: null,
  };
  attempt.replacementHistory = normalizeReplacementHistory(value.replacementHistory, index, attempt, { maxGasPriceWei });
  if (attempt.replacementOf !== null && (!TRANSACTION_HASH.test(attempt.replacementOf)
    || !attempt.replacementHistory.some(entry => entry.rawSignedBytesHash === attempt.replacementOf.toLowerCase()))) {
    fail(`direct payout recipient attempt ${index} replacementOf is invalid`);
  }
  if (attempt.state === 'FINALIZED') {
    attempt.finalizedTransfer = normalizeFinalizedTransfer(value.finalizedTransfer, index, attempt, operations);
  } else if (value.finalizedTransfer !== null) {
    fail(`direct payout recipient attempt ${index} has finality evidence before finalization`);
  }
  if (attempt.state === 'REFUSED') {
    attempt.refusalEvidence = normalizeRefusalEvidence(value.refusalEvidence, index, attempt);
  } else if (value.refusalEvidence !== null) {
    fail(`direct payout recipient attempt ${index} has refusal evidence before refusal`);
  }
  if (attempt.state === 'NONCE_INTERFERENCE') {
    const interference = value.nonceInterference;
    if (!interference || typeof interference !== 'object' || Array.isArray(interference)
      || Object.keys(interference).length !== 2
      || !Object.hasOwn(interference, 'expectedNonce') || !Object.hasOwn(interference, 'observedNonce')
      || assertAtomic(interference.expectedNonce, `direct payout recipient attempt ${index} expected nonce`) !== attempt.nonce
      || BigInt(assertAtomic(interference.observedNonce, `direct payout recipient attempt ${index} observed nonce`)) <= BigInt(attempt.nonce)) {
      fail(`direct payout recipient attempt ${index} nonce interference is invalid`);
    }
    attempt.nonceInterference = {
      expectedNonce: interference.expectedNonce,
      observedNonce: interference.observedNonce,
    };
  } else if (value.nonceInterference !== null) {
    fail(`direct payout recipient attempt ${index} has nonce interference before detection`);
  }
  if (signed && value.approvalContext !== null) {
    attempt.approvalContext = normalizePayoutApprovalContext(value.approvalContext, index, attempt);
  } else if (!signed && value.approvalContext !== null) {
    fail(`direct payout recipient attempt ${index} has approval context before signing`);
  }
  return attempt;
}

function normalizeRefusalEvidence(value, index, attempt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`direct payout recipient attempt ${index} refusal evidence is invalid`);
  }
  const fields = ['reason', 'transactionHash', 'receiptBlockNumber', 'receiptBlockHash', 'finalizedBlockNumber', 'finalizedBlockHash'];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    fail(`direct payout recipient attempt ${index} refusal evidence must use the exact schema`);
  }
  if (!['USDG_FROZEN', 'TRANSACTION_REVERTED'].includes(value.reason)) {
    fail(`direct payout recipient attempt ${index} refusal reason is invalid`);
  }
  const transactionRequired = attempt.nonce !== null;
  for (const field of ['transactionHash', 'receiptBlockHash', 'finalizedBlockHash']) {
    if (transactionRequired && (typeof value[field] !== 'string' || !TRANSACTION_HASH.test(value[field]))) {
      fail(`direct payout recipient attempt ${index} refusal ${field} is invalid`);
    }
    if (!transactionRequired && value[field] !== null) fail(`direct payout recipient attempt ${index} pre-sign refusal ${field} must be null`);
  }
  for (const field of ['receiptBlockNumber', 'finalizedBlockNumber']) {
    if (transactionRequired) assertAtomic(value[field], `direct payout recipient attempt ${index} refusal ${field}`, { positive: true });
    else if (value[field] !== null) fail(`direct payout recipient attempt ${index} pre-sign refusal ${field} must be null`);
  }
  return {
    reason: value.reason,
    transactionHash: value.transactionHash === null ? null : value.transactionHash.toLowerCase(),
    receiptBlockNumber: value.receiptBlockNumber,
    receiptBlockHash: value.receiptBlockHash === null ? null : value.receiptBlockHash.toLowerCase(),
    finalizedBlockNumber: value.finalizedBlockNumber,
    finalizedBlockHash: value.finalizedBlockHash === null ? null : value.finalizedBlockHash.toLowerCase(),
  };
}

function normalizeQuarantine(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`direct payout quarantine ${index} is invalid`);
  if (!['USDG_FROZEN', 'TRANSACTION_REVERTED', 'NONCE_INTERFERENCE'].includes(value.reason)) fail(`direct payout quarantine ${index} reason is invalid`);
  return {
    recipient: assertAddress(value.recipient, `direct payout quarantine ${index} recipient`),
    amount: assertUsdAmount(value.amount, `direct payout quarantine ${index} amount`),
    reason: value.reason,
  };
}

function assertStateMatchesPlan(state, planInfo) {
  const payableAllocations = planInfo.allocations.filter(allocation => allocation.amount.amountAtomic !== '0');
  if (state.recipients.length !== payableAllocations.length) {
    fail('direct payout state recipients do not match its immutable payable allocations');
  }
  const assignedNonces = new Set();
  for (const [index, attempt] of state.recipients.entries()) {
    const allocation = payableAllocations[index];
    if (!allocation || attempt.recipient !== allocation.recipient || !sameAmount(attempt.amount, allocation.amount)) {
      fail('direct payout state recipient attempts do not match their immutable payout plan');
    }
    if (attempt.nonce !== null) {
      if (assignedNonces.has(attempt.nonce)) fail('direct payout state recipient nonces must be unique');
      assignedNonces.add(attempt.nonce);
      if (BigInt(attempt.nonce) >= BigInt(state.nextNonce)) {
        fail('direct payout state nextNonce does not follow its persisted recipient attempts');
      }
    }
  }
  if (BigInt(state.nextNonce) !== BigInt(state.firstNonce) + BigInt(assignedNonces.size)) {
    fail('direct payout state nonce cursor is inconsistent with its persisted recipient attempts');
  }
  const terminalBroadcast = state.recipients.some(attempt => ['BROADCAST', 'FINALIZED', 'REFUSED', 'NONCE_INTERFERENCE'].includes(attempt.state) && attempt.nonce !== null);
  if (terminalBroadcast && !state.manifestFrozen) fail('direct payout state must freeze its manifest at first broadcast');
  if (state.recipients.some(attempt => ['SIGNED', 'BROADCAST', 'FINALIZED', 'NONCE_INTERFERENCE'].includes(attempt.state)
    || (attempt.state === 'REFUSED' && attempt.nonce !== null)) && !state.feasibilityChecked) {
    fail('direct payout state signed a transaction before recording its feasibility gate');
  }
  const quarantined = state.recipients.filter(attempt => ['REFUSED', 'NONCE_INTERFERENCE'].includes(attempt.state));
  if (state.quarantine.length !== quarantined.length) fail('direct payout quarantine liabilities must match quarantined recipients exactly once');
  const liabilities = new Map();
  for (const liability of state.quarantine) {
    if (liabilities.has(liability.recipient)) fail('direct payout quarantine liabilities must be unique by recipient');
    liabilities.set(liability.recipient, liability);
  }
  for (const attempt of quarantined) {
    const liability = liabilities.get(attempt.recipient);
    if (!liability || !sameAmount(liability.amount, attempt.amount)) {
      fail('direct payout quarantine liability does not match its recipient attempt');
    }
  }
}

function buildTransaction(state, attempt) {
  return {
    chainId: 4663,
    nonce: attempt.nonce,
    from: state.operations,
    to: state.usdgAddress,
    data: attempt.calldata,
    value: '0',
    gas: state.plan.feasibility.measuredTransferGas,
    gasPrice: attempt.gasPriceWei,
  };
}

function parsedFeePerGas(parsed, state) {
  const gasLimit = parsed.gas === undefined || parsed.gas === null ? null : BigInt(parsed.gas);
  const allowedGasLimit = BigInt(state.plan.feasibility.measuredTransferGas);
  if (gasLimit === null || gasLimit === 0n || gasLimit > allowedGasLimit) {
    fail('direct payout signed transaction exceeds the frozen transfer gas envelope');
  }
  if (BigInt(parsed.value ?? 0n) !== 0n) {
    fail('direct payout signed transaction must not transfer native value');
  }
  const fee = parsed.gasPrice ?? parsed.maxFeePerGas;
  if (fee === undefined || fee === null || BigInt(fee) === 0n
    || BigInt(fee) > BigInt(state.plan.feasibility.maxGasPriceWei)) {
    fail('direct payout signed transaction exceeds the frozen gas-price cap');
  }
  if (parsed.maxPriorityFeePerGas !== undefined && parsed.maxPriorityFeePerGas !== null
    && BigInt(parsed.maxPriorityFeePerGas) > BigInt(fee)) {
    fail('direct payout signed transaction has an invalid priority fee');
  }
  return BigInt(fee);
}

async function assertSignedTransaction({ rawSignedBytes, state, attempt }) {
  if (typeof rawSignedBytes !== 'string' || !RAW_TRANSACTION.test(rawSignedBytes)) {
    fail('direct payout signer did not return raw signed EVM bytes');
  }
  let parsed;
  let sender;
  try {
    parsed = parseTransaction(rawSignedBytes);
    sender = await recoverTransactionAddress({ serializedTransaction: rawSignedBytes });
  } catch (error) {
    fail(`direct payout signed transaction cannot be decoded: ${error.message}`);
  }
  const parsedChainId = parsed.chainId === undefined || parsed.chainId === null ? null : BigInt(parsed.chainId);
  if (parsedChainId !== 4663n || BigInt(parsed.nonce) !== BigInt(attempt.nonce)
    || !equalAddress(parsed.to, state.usdgAddress)
    || (parsed.data ?? '0x').toLowerCase() !== attempt.calldata
    || !equalAddress(sender, state.operations)) {
    fail('direct payout signed transaction does not match its persisted recipient, nonce, and calldata');
  }
  const feePerGas = parsedFeePerGas(parsed, state);
  if (feePerGas !== BigInt(attempt.gasPriceWei)) {
    fail('direct payout signed transaction fee does not match the persisted recipient fee');
  }
  return {
    rawSignedBytes,
    rawSignedBytesHash: keccak256(rawSignedBytes).toLowerCase(),
    txHash: keccak256(rawSignedBytes).toLowerCase(),
    feePerGas,
  };
}

async function assertFirstSignatureFeasibility({ state, client }) {
  const required = requiredNativeAmount(state.plan);
  if (typeof client?.getBalance !== 'function') {
    fail('direct payout requires getBalance before the first payout signature');
  }
  const observed = await client.getBalance({ address: state.operations });
  const observedAtomic = typeof observed === 'bigint' ? observed : BigInt(observed);
  if (observedAtomic < required) {
    fail('direct payout native balance is below the frozen feasibility envelope');
  }
}

async function isRecipientFrozen(client, token, recipient) {
  if (typeof client?.readContract !== 'function') fail('direct payout requires a USDG readContract client');
  const result = await client.readContract({ address: token, abi: FROZEN_ABI, functionName: 'isFrozen', args: [recipient] });
  if (typeof result !== 'boolean') fail('USDG isFrozen(address) returned a non-boolean value');
  return result;
}

async function persist(payoutStore, state) {
  if (!payoutStore || typeof payoutStore.persist !== 'function') fail('direct payout requires a durable payoutStore.persist()');
  await payoutStore.persist(copy(state));
  return state;
}

async function load(payoutStore) {
  if (!payoutStore || typeof payoutStore.load !== 'function') fail('direct payout requires a durable payoutStore.load()');
  const stored = await payoutStore.load();
  if (stored === null || stored === undefined) fail('direct payout has no durable prepared state');
  return normalizedState(stored);
}

function assertRuntimeConfiguration(state, config) {
  if (!config || typeof config !== 'object') fail('direct payout configuration is required');
  if (config.payout?.legacyVault === true) fail('legacy payout mode is explicitly disabled for Operations EOA payouts');
  if (config.chainId !== undefined && Number(config.chainId) !== 4663) fail('direct payout requires chainId 4663');
  if (!equalAddress(config.accounts?.evm, state.operations) || !equalAddress(config.contracts?.usdg, state.usdgAddress)) {
    fail('direct payout runtime configuration does not match the persisted Operations or USDG identity');
  }
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

function exactDirectPayoutPolicyRule(decoded) {
  return Object.freeze({
    id: 'direct-payout-recipient-transfer',
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

function assertDirectPayoutMoneyConfiguration(state, config) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, 'direct payout money configuration');
  } catch (error) {
    fail(`direct payout requires MoneyConfigurationV1: ${error.message}`);
  }
  if (money.assets.usdg.chainId !== '4663'
    || money.assets.usdg.decimals !== 6
    || money.assets.usdg.assetId.toLowerCase() !== state.usdgAddress) {
    fail('direct payout MoneyConfigurationV1 USDG asset does not match the persisted payout state');
  }
  const reserve = state.plan.feasibility.nativeReserve;
  if (!reserve || String(reserve.chainId) !== money.evm.nativeReserve.chainId
    || reserve.assetId !== money.evm.nativeReserve.assetId
    || reserve.decimals !== money.evm.nativeReserve.decimals
    || BigInt(reserve.amountAtomic) < BigInt(money.evm.nativeReserve.amountAtomic)) {
    fail('direct payout frozen feasibility reserve does not meet MoneyConfigurationV1');
  }
  if (BigInt(state.plan.feasibility.maxGasPriceWei) > BigInt(money.evm.perTransactionGasPriceCap.amountAtomic)) {
    fail('direct payout frozen gas-price envelope exceeds MoneyConfigurationV1');
  }
  return money;
}

function directPayoutDecodeOptions(state) {
  return Object.freeze({
    family: 'evm',
    chainId: '4663',
    tokenMetadata: Object.freeze({
      [state.usdgAddress]: Object.freeze({ assetId: state.usdgAddress, decimals: 6 }),
    }),
  });
}

function assertDecodedDirectPayout({ decoded, state, attempt, money }) {
  const decodedAmountMatchesAttempt = decoded.amount !== null
    && String(decoded.amount.chainId) === String(attempt.amount.chainId)
    && decoded.amount.assetId.toLowerCase() === attempt.amount.assetId.toLowerCase()
    && decoded.amount.decimals === attempt.amount.decimals
    && decoded.amount.amountAtomic === attempt.amount.amountAtomic;
  if (decoded.family !== 'evm'
    || decoded.chainId !== '4663'
    || !equalAddress(decoded.source, state.operations)
    || !equalAddress(decoded.target, state.usdgAddress)
    || !equalAddress(decoded.mint, state.usdgAddress)
    || !equalAddress(decoded.token, state.usdgAddress)
    || !equalAddress(decoded.destination, attempt.recipient)
    || !decodedAmountMatchesAttempt
    || decoded.nonce !== attempt.nonce
    || decoded.nativeValue?.amountAtomic !== '0') {
    fail('direct payout decoded transaction does not match the durable recipient attempt');
  }
  if (BigInt(attempt.gasPriceWei) > BigInt(money.evm.perTransactionGasPriceCap.amountAtomic)) {
    fail('direct payout recipient gas price exceeds MoneyConfigurationV1');
  }
}

/**
 * Builds an exact, one-recipient transaction-policy signer from a persisted payout attempt. The
 * wrapped signer remains the stage driver's guarded Operations facade, so standing-authority,
 * lease, policy-engine, and wallet-nonce checks run before the external signer sees bytes.
 */
async function createDirectPayoutPolicySignerForAttempt({ signerClient, state, attempt, config }) {
  if (attempt.nonce === null) fail('direct payout policy signer requires a persisted nonce reservation');
  const rawSigner = signerClient?.evm;
  if (!rawSigner || rawSigner.role !== OPERATOR_EVM_ROLE
    || typeof rawSigner.sign !== 'function' || typeof rawSigner.broadcast !== 'function') {
    fail('direct payout transaction-policy signer requires the guarded Operations EVM signer');
  }
  const money = assertDirectPayoutMoneyConfiguration(state, config);
  const decodeOptions = directPayoutDecodeOptions(state);
  const transaction = buildTransaction(state, attempt);
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction });
  assertDecodedDirectPayout({ decoded, state, attempt, money });
  const policy = createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({
      decoded,
      stage: STAGE,
      requestDigest: canonicalDigest({
        schema: 'hookemon.direct-payout-policy-request.v1',
        cycleId: state.cycleId,
        planDigest: state.planDigest,
        recipient: attempt.recipient,
        nonce: attempt.nonce,
        calldataDigest: attempt.calldataDigest,
      }),
    }),
    rules: [exactDirectPayoutPolicyRule(decoded)],
  });
  const policyRules = readTransactionPolicyRules(policy);
  const policySigner = wrapTransactionPolicySignerClient({ client: rawSigner, policy, rules: policyRules, decodeOptions });
  return Object.freeze({ decoded, policy, policyRules, policySigner });
}

export async function createDirectPayoutPolicySigner({ signerClient, state, recipient, config }) {
  const normalized = normalizedState(state);
  assertRuntimeConfiguration(normalized, config);
  const { attempt } = stateRecipient(normalized, recipient);
  return createDirectPayoutPolicySignerForAttempt({ signerClient, state: normalized, attempt, config });
}

/**
 * Creates PREPARED recipient records. The caller must persist this value before a signer sees a
 * transfer request. `createCycleRepositoryPayoutStore` persists the complete immutable plan and
 * its recipient records as one durable stage value, so recovery never reconstructs a nonce or
 * signed payload from transient process state.
 */
export function createDirectPayoutState({ plan, operations, usdgAddress, firstNonce, gasPriceWei }) {
  const { plan: sourcePlan, distributablePool, dust, allocations } = assertPlan(plan);
  const operationAddress = assertAddress(operations, 'Operations address');
  const tokenAddress = assertAddress(usdgAddress, 'USDG address');
  if (operationAddress !== sourcePlan.returnEvidence.operations || tokenAddress !== sourcePlan.returnEvidence.usdgAddress) {
    fail('direct payout state identities must match the bound finalized return identities');
  }
  const initialNonce = normalizeNonce(firstNonce, 'first payout nonce');
  const selectedGasPrice = assertAtomic(
    gasPriceWei ?? sourcePlan.feasibility.maxGasPriceWei,
    'initial payout gasPriceWei',
    { positive: true },
  );
  if (BigInt(selectedGasPrice) > BigInt(sourcePlan.feasibility.maxGasPriceWei)) {
    fail('initial payout gasPriceWei exceeds the frozen gas-price cap');
  }
  const recipients = [];
  for (const allocation of allocations) {
    if (allocation.amount.amountAtomic === '0') continue;
    const calldata = directTransferCalldata(allocation.recipient, allocation.amount.amountAtomic);
    recipients.push({
      recipient: allocation.recipient,
      amount: allocation.amount,
      state: 'PREPARED',
      nonce: null,
      chainId: 4663,
      gasPriceWei: selectedGasPrice,
      calldata,
      calldataDigest: sha256(calldata),
      rawSignedBytes: null,
      rawSignedBytesHash: null,
      txHash: null,
      finalizedTransfer: null,
      refusalEvidence: null,
      nonceInterference: null,
      approvalContext: null,
      replacementOf: null,
      replacementHistory: [],
    });
  }
  return {
    schema: 'hookemon.direct-payout-state.v1',
    cycleId: sourcePlan.cycleId,
    planDigest: sourcePlan.planDigest,
    plan: copy(sourcePlan),
    operations: operationAddress,
    usdgAddress: tokenAddress,
    manifestFrozen: false,
    feasibilityChecked: false,
    distributablePool,
    dust,
    firstNonce: initialNonce,
    nextNonce: initialNonce,
    gasPriceWei: selectedGasPrice,
    recipients,
    quarantine: [],
  };
}

export async function initializeDirectPayout({ payoutStore, plan, operations, usdgAddress, firstNonce, gasPriceWei }) {
  const state = createDirectPayoutState({ plan, operations, usdgAddress, firstNonce, gasPriceWei });
  if (!payoutStore || typeof payoutStore.load !== 'function') fail('direct payout requires a durable payoutStore.load()');
  const existing = await payoutStore.load();
  if (existing !== null && existing !== undefined) {
    const recovered = normalizedState(existing);
    if (recovered.planDigest !== state.planDigest
      || recovered.operations !== state.operations
      || recovered.usdgAddress !== state.usdgAddress) {
      fail('direct payout refuses to replace an existing immutable payout state');
    }
    return recovered;
  }
  await persist(payoutStore, state);
  return state;
}

/** Builds the exact direct ERC-20 transfer request from a persisted PREPARED record. */
export function buildDirectPayoutTransaction({ state, recipient }) {
  const normalized = normalizedState(state);
  const { attempt } = stateRecipient(normalized, recipient);
  if (attempt.nonce === null) fail('direct payout recipient has not persisted a nonce reservation');
  return buildTransaction(normalized, attempt);
}

function nextUnresolvedRecipient(state) {
  return state.recipients.find(attempt => !['FINALIZED', 'REFUSED', 'NONCE_INTERFERENCE'].includes(attempt.state)) ?? null;
}

function assertRecipientIsNext(state, attempt) {
  const next = nextUnresolvedRecipient(state);
  if (next && next.recipient !== attempt.recipient) {
    fail(`direct payout must reconcile ${next.recipient} before advancing ${attempt.recipient}`);
  }
}

function preSignRefusalEvidence(reason) {
  return {
    reason,
    transactionHash: null,
    receiptBlockNumber: null,
    receiptBlockHash: null,
    finalizedBlockNumber: null,
    finalizedBlockHash: null,
  };
}

function repositoryAmount(amount) {
  return { ...amount, chainId: String(amount.chainId) };
}

async function reservePayoutQuarantine({ cycleRepository, state, attempt, reason, evidence }) {
  if (cycleRepository === null || cycleRepository === undefined || typeof cycleRepository.reservePayoutQuarantine !== 'function') {
    fail('direct payout production execution requires a custody-backed quarantine repository');
  }
  await cycleRepository.reservePayoutQuarantine(state.cycleId, {
    planDigest: state.planDigest,
    recipient: attempt.recipient,
    amount: repositoryAmount(attempt.amount),
    reason,
    evidence,
  });
}

async function refuseRecipient({ payoutStore, cycleRepository, state, index, attempt, reason, evidence, releaseNonce = false }) {
  const refusalEvidence = evidence ?? preSignRefusalEvidence(reason);
  await reservePayoutQuarantine({ cycleRepository, state, attempt, reason, evidence: refusalEvidence });
  const next = copy(state);
  let nonce = attempt.nonce;
  if (releaseNonce) {
    if (nonce === null || BigInt(state.nextNonce) !== BigInt(nonce) + 1n) {
      fail('direct payout cannot release a nonce reservation that is not the serial tail');
    }
    next.nextNonce = nonce;
    nonce = null;
  }
  next.recipients[index] = {
    ...attempt,
    state: 'REFUSED',
    nonce,
    finalizedTransfer: null,
    refusalEvidence,
  };
  next.quarantine.push({ recipient: attempt.recipient, amount: attempt.amount, reason });
  await persist(payoutStore, next);
  return next;
}

function matchingFinalTransfer(proof, state, attempt) {
  if (!proof.successful || !proof.proofAvailable) {
    fail(`direct payout transaction ${attempt.txHash} lacks exact finalized transfer proof`);
  }
  const matching = proof.transfers.filter(transfer => transfer.from.toLowerCase() === state.operations
    && transfer.to.toLowerCase() === attempt.recipient);
  const amountAtomic = matching.reduce((sum, transfer) => sum + BigInt(transfer.amountAtomic), 0n).toString();
  if (matching.length === 0 || amountAtomic !== attempt.amount.amountAtomic) {
    fail('direct payout finality lacks the exact USDG transfer delta to the planned recipient');
  }
  return {
    from: state.operations,
    to: attempt.recipient,
    amount: attempt.amount,
    finalizedBlockNumber: proof.finalizedBlockNumber.toString(),
    finalizedBlockHash: proof.finalizedBlockHash,
    receiptBlockNumber: proof.receiptBlockNumber.toString(),
    receiptBlockHash: proof.receiptBlockHash,
    previousBlockNumber: proof.previousBlockNumber.toString(),
    previousBlockHash: proof.previousBlockHash,
    sourceBalanceBeforeAtomic: proof.sourceBalanceBeforeAtomic,
    sourceBalanceAfterAtomic: proof.sourceBalanceAfterAtomic,
    sourceBalanceDeltaAtomic: proof.sourceBalanceDeltaAtomic,
    recipientBalanceBeforeAtomic: proof.recipientBalanceBeforeAtomic,
    recipientBalanceAfterAtomic: proof.recipientBalanceAfterAtomic,
    recipientBalanceDeltaAtomic: proof.recipientBalanceDeltaAtomic,
    logIndexes: matching.map(transfer => transfer.logIndex),
  };
}

function currentMaterial(attempt) {
  return {
    rawSignedBytes: attempt.rawSignedBytes,
    rawSignedBytesHash: attempt.rawSignedBytesHash,
    txHash: attempt.txHash,
    nonce: attempt.nonce,
    calldataDigest: attempt.calldataDigest,
    gasPriceWei: attempt.gasPriceWei,
  };
}

function finalizingAttempt(attempt, candidate, finalizedTransfer) {
  const current = currentMaterial(attempt);
  const candidateIsCurrent = candidate.rawSignedBytesHash === current.rawSignedBytesHash;
  const history = [
    ...attempt.replacementHistory.filter(entry => entry.rawSignedBytesHash !== candidate.rawSignedBytesHash),
    ...(candidateIsCurrent ? [] : [current]),
  ];
  return {
    ...attempt,
    state: 'FINALIZED',
    rawSignedBytes: candidate.rawSignedBytes,
    rawSignedBytesHash: candidate.rawSignedBytesHash,
    txHash: candidate.txHash,
    approvalContext: candidateIsCurrent ? attempt.approvalContext : null,
    replacementOf: null,
    replacementHistory: history,
    finalizedTransfer,
  };
}

async function reconcileRecipientAttempt(client, evidenceClient, state, attempt) {
  const candidates = [currentMaterial(attempt), ...attempt.replacementHistory];
  for (const candidate of candidates) {
    const candidateAttempt = { ...attempt, ...candidate };
    await assertSignedTransaction({ rawSignedBytes: candidate.rawSignedBytes, state, attempt: candidateAttempt });
    let proof;
    try {
      proof = await readFinalizedErc20TransferProof(client, {
        hash: candidate.txHash,
        token: state.usdgAddress,
        source: state.operations,
        recipient: attempt.recipient,
        amountAtomic: attempt.amount.amountAtomic,
        evidenceClient,
      });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) continue;
      throw error;
    }
    if (!proof.finalized) continue;
    if (!proof.successful) {
      return {
        candidate,
        refused: true,
        refusalEvidence: {
          transactionHash: candidate.txHash,
          receiptBlockNumber: proof.receiptBlockNumber?.toString() ?? null,
          receiptBlockHash: proof.receiptBlockHash ?? null,
          finalizedBlockNumber: proof.finalizedBlockNumber?.toString() ?? null,
          finalizedBlockHash: proof.finalizedBlockHash ?? null,
          reason: 'TRANSACTION_REVERTED',
        },
      };
    }
    return {
      candidate,
      finalizedTransfer: matchingFinalTransfer(proof, state, candidateAttempt),
    };
  }
  return null;
}

function activePolicySigner({ signerClient, policySignerClient }) {
  const active = signerClient?.evm;
  const policy = policySignerClient?.evm ?? active;
  if (!active || typeof active.sign !== 'function' || typeof active.broadcast !== 'function'
    || !isTransactionPolicySignerClient(policy)) {
    fail('direct payout requires an Operations EVM transaction-policy signer');
  }
  return Object.freeze({ active, policy });
}

async function resolvePolicySignerClients({
  signerClient,
  policySignerClient,
  policySignerFactory = null,
  state,
  attempt,
}) {
  if (typeof policySignerFactory === 'function') {
    const dynamic = await policySignerFactory({ state, attempt });
    if (!isTransactionPolicySignerClient(dynamic)) {
      fail('direct payout dynamic policy signer factory did not return a transaction-policy signer');
    }
    const composed = Object.freeze({ evm: dynamic });
    return Object.freeze({ signerClient: composed, policySignerClient: composed });
  }
  const policy = policySignerClient?.evm ?? signerClient?.evm;
  if (isTransactionPolicySignerClient(policy)) {
    return Object.freeze({ signerClient, policySignerClient });
  }
  return Object.freeze({ signerClient, policySignerClient });
}

function payoutRecoveryContextPayload({ attempt }) {
  const context = attempt.approvalContext;
  if (context === null) return null;
  return Object.freeze({
    stage: STAGE,
    recipient: attempt.recipient,
    requestDigest: context.requestDigest,
    policyDigest: context.policyDigest,
    approvalDigest: context.approvalDigest,
    fencingToken: context.fencingToken,
    fencingTokenDigest: context.fencingTokenDigest,
    approvedSemanticsDigest: context.approvedSemanticsDigest,
    rawSignedBytesHash: attempt.rawSignedBytesHash,
    signedMessageDigest: context.signedMessageDigest,
  });
}

function durableRecoveryAttempt({ state, attempt }) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    fail('direct payout recovery requires a recipient attempt');
  }
  const durableState = normalizedState(state);
  const { attempt: durableAttempt } = stateRecipient(durableState, attempt.recipient);
  if (!['SIGNED', 'BROADCAST'].includes(durableAttempt.state)) {
    fail('direct payout recovery requires a durably persisted SIGNED or BROADCAST recipient');
  }
  if (canonicalDigest(durableAttempt) !== canonicalDigest(attempt)) {
    fail('direct payout recovery attempt does not match the durable signed recipient');
  }
  return Object.freeze({ state: durableState, attempt: durableAttempt });
}

async function currentDurableRecoveryAttempt({ cycleRepository, state, attempt }) {
  const caller = durableRecoveryAttempt({ state, attempt });
  if (!cycleRepository || typeof cycleRepository.readPagedPayoutState !== 'function') {
    fail('direct payout recovery requires the authoritative paged payout state');
  }
  const stored = await cycleRepository.readPagedPayoutState(caller.state.cycleId, STAGE);
  if (stored === null || stored === undefined) {
    fail('direct payout recovery has no authoritative paged payout state');
  }
  const current = durableRecoveryAttempt({ state: stored, attempt });
  if (current.state.cycleId !== caller.state.cycleId) {
    fail('direct payout recovery authoritative state does not match the caller cycle');
  }
  return current;
}

async function assertDurablePayoutRecoveryContext({ cycleRepository, state, attempt, nonceLeaseContext = null }) {
  const payload = payoutRecoveryContextPayload({ attempt });
  if (payload === null) fail('direct payout recovery requires persisted policy approval context');
  if (payload.requestDigest === null) return payload;
  if (!cycleRepository || typeof cycleRepository.assertWalletNonce !== 'function') {
    fail('direct payout recovery requires the wallet nonce reservation');
  }
  await cycleRepository.assertWalletNonce(state.cycleId, {
    chainId: '4663',
    wallet: state.operations,
    stage: STAGE,
    fencingToken: payload.fencingToken,
    ...walletNonceLeaseWindow({ ...nonceLeaseContext, fencingToken: payload.fencingToken }, 'direct payout recovery wallet nonce reservation'),
  });
  return payload;
}

/** Reauthorizes one persisted SIGNED or BROADCAST payout attempt without producing new bytes. */
export async function recoverDroppedBroadcast({
  signerClient,
  policySignerClient = null,
  policySignerFactory = null,
  cycleRepository = null,
  state,
  attempt,
  nonceLeaseContext = null,
}) {
  const durable = await currentDurableRecoveryAttempt({ cycleRepository, state, attempt });
  const payload = await assertDurablePayoutRecoveryContext({
    cycleRepository,
    state: durable.state,
    attempt: durable.attempt,
    nonceLeaseContext,
  });
  const resolved = await resolvePolicySignerClients({
    signerClient,
    policySignerClient,
    policySignerFactory,
    state: durable.state,
    attempt: durable.attempt,
  });
  const { active, policy } = activePolicySigner(resolved);
  await recoverTransactionPolicyApproval({
    client: policy,
    signed: { signedTx: durable.attempt.rawSignedBytes },
    recoveryContext: {
      schema: TRANSACTION_POLICY_APPROVAL_SCHEMA,
      family: 'evm',
      policyDigest: payload.policyDigest,
      approvalDigest: payload.approvalDigest,
      approvedSemanticsDigest: payload.approvedSemanticsDigest,
      signedMessageDigest: payload.signedMessageDigest,
    },
  });
  return active.broadcast({ signedTx: durable.attempt.rawSignedBytes });
}

const localDirectPayoutPolicySigners = new WeakMap();

function localDirectPayoutPolicySignerFactory({ signerClient, config }) {
  return async ({ state, attempt }) => {
    if (!signerClient || typeof signerClient !== 'object') {
      return (await createDirectPayoutPolicySigner({
        signerClient,
        state,
        recipient: attempt.recipient,
        config,
      })).policySigner;
    }
    const key = canonicalDigest({
      schema: 'hookemon.direct-payout-policy-signer-cache-key.v1',
      cycleId: state.cycleId,
      planDigest: state.planDigest,
      recipient: attempt.recipient,
      nonce: attempt.nonce,
      calldataDigest: attempt.calldataDigest,
      gasPriceWei: attempt.gasPriceWei,
    });
    let signers = localDirectPayoutPolicySigners.get(signerClient);
    if (signers === undefined) {
      signers = new Map();
      localDirectPayoutPolicySigners.set(signerClient, signers);
    }
    const cached = signers.get(key);
    if (cached !== undefined) return cached;
    const composed = await createDirectPayoutPolicySigner({
      signerClient,
      state,
      recipient: attempt.recipient,
      config,
    });
    signers.set(key, composed.policySigner);
    return composed.policySigner;
  };
}

async function broadcastExactSignedBytes({
  signerClient,
  policySignerClient,
  policySignerFactory = null,
  cycleRepository,
  state,
  attempt,
  nonceLeaseContext = null,
}) {
  const durable = durableRecoveryAttempt({ state, attempt });
  const resolved = await resolvePolicySignerClients({
    signerClient,
    policySignerClient,
    policySignerFactory,
    state: durable.state,
    attempt: durable.attempt,
  });
  const { active, policy } = activePolicySigner(resolved);
  const signedEnvelope = { signedTx: durable.attempt.rawSignedBytes };
  let response;
  let activeApproval = true;
  try {
    readTransactionPolicyApprovalContext(policy, signedEnvelope);
  } catch (error) {
    if (!/no approval for the signed message/.test(error?.message ?? '')) throw error;
    activeApproval = false;
  }
  if (!activeApproval) {
    response = await recoverDroppedBroadcast({
      ...resolved,
      cycleRepository,
      state: durable.state,
      attempt: durable.attempt,
      nonceLeaseContext,
    });
  } else {
    await assertDurablePayoutRecoveryContext({
      cycleRepository,
      state: durable.state,
      attempt: durable.attempt,
      nonceLeaseContext,
    });
    try {
      response = await active.broadcast(signedEnvelope);
    } catch (error) {
      if (!/unsigned or unapproved message/.test(error?.message ?? '')) throw error;
      response = await recoverDroppedBroadcast({
        ...resolved,
        cycleRepository,
        state: durable.state,
        attempt: durable.attempt,
        nonceLeaseContext,
      });
    }
  }
  const transactionHash = typeof response === 'string' ? response : response?.transactionHash;
  if (typeof transactionHash !== 'string' || !TRANSACTION_HASH.test(transactionHash)
    || transactionHash.toLowerCase() !== attempt.txHash.toLowerCase()) {
    fail('direct payout broadcast did not return the hash of the persisted raw signed bytes');
  }
  return transactionHash.toLowerCase();
}

async function recordNonceInterference({ payoutStore, cycleRepository, state, index, attempt, observedNonce }) {
  const evidence = {
    expectedNonce: attempt.nonce,
    observedNonce,
    transactionHash: attempt.txHash,
    rawSignedBytesHash: attempt.rawSignedBytesHash,
  };
  await reservePayoutQuarantine({
    cycleRepository,
    state,
    attempt,
    reason: 'NONCE_INTERFERENCE',
    evidence,
  });
  const next = copy(state);
  next.recipients[index] = {
    ...attempt,
    state: 'NONCE_INTERFERENCE',
    nonceInterference: {
      expectedNonce: attempt.nonce,
      observedNonce,
    },
  };
  next.quarantine.push({ recipient: attempt.recipient, amount: attempt.amount, reason: 'NONCE_INTERFERENCE' });
  await persist(payoutStore, next);
  return next;
}

/**
 * Advances exactly one recipient by one durable boundary. It persists the plan freeze before a
 * broadcast can reach the signer, then rebroadcasts exact approved bytes only through the
 * transaction-policy signer.
 */
export async function advanceDirectPayout({
  payoutStore,
  recipient,
  adapters,
  signerClient,
  policySignerClient = null,
  policySignerFactory = null,
  config,
  cycleRepository = null,
  requestDigest = null,
  fencingToken = null,
  evmNonceFence = null,
  nonceLeaseContext = null,
}) {
  const state = await load(payoutStore);
  assertRuntimeConfiguration(state, config);
  const exactPolicySignerFactory = localDirectPayoutPolicySignerFactory({ signerClient, config });
  const { index, attempt } = stateRecipient(state, recipient);
  const client = adapters?.robinhood?.client;
  const evidenceClient = adapters?.robinhood?.historicalEvidenceClient ?? client.historicalEvidenceClient ?? null;
  if (!client) fail('direct payout requires a chain 4663 client');
  if (attempt.state === 'FINALIZED' || attempt.state === 'REFUSED') return state;
  if (attempt.state === 'NONCE_INTERFERENCE') {
    throw new DirectPayoutNonceInterferenceError({
      recipient: attempt.recipient,
      expectedNonce: attempt.nonce,
      observedNonce: attempt.nonceInterference?.observedNonce ?? attempt.nonce,
    });
  }
  assertRecipientIsNext(state, attempt);

  if (attempt.state === 'PREPARED') {
    if (await isRecipientFrozen(client, state.usdgAddress, attempt.recipient)) {
      return refuseRecipient({
        payoutStore,
        cycleRepository,
        state,
        index,
        attempt,
        reason: 'USDG_FROZEN',
        releaseNonce: attempt.nonce !== null,
      });
    }
    if (typeof client.getTransactionCount !== 'function') fail('direct payout requires getTransactionCount for nonce interference checks');
    await evmNonceFence?.();
    const observedNonce = normalizeNonce(await client.getTransactionCount({ address: state.operations, blockTag: 'pending' }), 'observed payout nonce');
    if (attempt.nonce === null) {
      if (observedNonce !== state.nextNonce) {
        throw new DirectPayoutNonceInterferenceError({ recipient: attempt.recipient, expectedNonce: state.nextNonce, observedNonce });
      }
      const next = copy(state);
      next.recipients[index] = { ...attempt, nonce: state.nextNonce };
      next.nextNonce = (BigInt(state.nextNonce) + 1n).toString();
      await persist(payoutStore, next);
      return next;
    }
    if (observedNonce !== attempt.nonce) {
      throw new DirectPayoutNonceInterferenceError({ recipient: attempt.recipient, expectedNonce: attempt.nonce, observedNonce });
    }
    if (!state.feasibilityChecked) await assertFirstSignatureFeasibility({ state, client });
    const resolved = await resolvePolicySignerClients({
      signerClient,
      policySignerClient,
      policySignerFactory: exactPolicySignerFactory,
      state,
      attempt,
    });
    const { active, policy } = activePolicySigner(resolved);
    const signed = await active.sign({ transaction: buildTransaction(state, attempt) });
    const signedMaterial = await assertSignedTransaction({ rawSignedBytes: signed?.signedTx, state, attempt });
    const material = {
      rawSignedBytes: signedMaterial.rawSignedBytes,
      rawSignedBytesHash: signedMaterial.rawSignedBytesHash,
      txHash: signedMaterial.txHash,
    };
    const next = copy(state);
    next.feasibilityChecked = true;
    const approvalContext = approvalContextForSignedPayout({
      policyApproval: readTransactionPolicyApprovalContext(policy, signed),
      material,
      requestDigest,
      fencingToken,
    });
    next.recipients[index] = { ...attempt, state: 'SIGNED', ...material, approvalContext };
    await persist(payoutStore, next);
    return next;
  }

  if (attempt.state === 'SIGNED') {
    const reconciled = await reconcileRecipientAttempt(client, evidenceClient, state, attempt);
    if (reconciled) {
      if (reconciled.refused) {
        return refuseRecipient({
          payoutStore,
          cycleRepository,
          state,
          index,
          attempt,
          reason: 'TRANSACTION_REVERTED',
          evidence: reconciled.refusalEvidence,
        });
      }
      const next = copy(state);
      next.manifestFrozen = true;
      next.recipients[index] = finalizingAttempt(attempt, reconciled.candidate, reconciled.finalizedTransfer);
      await persist(payoutStore, next);
      return next;
    }
    await assertSignedTransaction({ rawSignedBytes: attempt.rawSignedBytes, state, attempt });
    let broadcastState = state;
    if (!state.manifestFrozen) {
      broadcastState = copy(state);
      broadcastState.manifestFrozen = true;
      await persist(payoutStore, broadcastState);
    }
    await broadcastExactSignedBytes({
      signerClient,
      policySignerClient,
      policySignerFactory: exactPolicySignerFactory,
      cycleRepository,
      state: broadcastState,
      attempt,
      nonceLeaseContext,
    });
    const next = copy(broadcastState);
    next.manifestFrozen = true;
    next.recipients[index] = { ...attempt, state: 'BROADCAST' };
    await persist(payoutStore, next);
    return next;
  }

  if (attempt.state === 'BROADCAST') {
    const reconciled = await reconcileRecipientAttempt(client, evidenceClient, state, attempt);
    if (reconciled?.refused) {
      return refuseRecipient({
        payoutStore,
        cycleRepository,
        state,
        index,
        attempt,
        reason: 'TRANSACTION_REVERTED',
        evidence: reconciled.refusalEvidence,
      });
    }
    if (!reconciled) {
      if (typeof client.getTransaction !== 'function' || typeof client.getTransactionCount !== 'function') return state;
      let observed;
      try {
        observed = await readTransaction(client, attempt.txHash);
      } catch (error) {
        if (!(error instanceof TransactionNotFoundError)) throw error;
        observed = null;
      }
      if (observed !== null && observed !== undefined) return state;
      const [pendingNonce, latestNonce] = await Promise.all([
        client.getTransactionCount({ address: state.operations, blockTag: 'pending' }),
        client.getTransactionCount({ address: state.operations, blockTag: 'latest' }),
      ]);
      const observedPendingNonce = normalizeNonce(pendingNonce, 'observed pending payout recovery nonce');
      const observedLatestNonce = normalizeNonce(latestNonce, 'observed latest payout recovery nonce');
      const observedNonce = BigInt(observedPendingNonce) > BigInt(observedLatestNonce)
        ? observedPendingNonce
        : observedLatestNonce;
      if (BigInt(observedNonce) > BigInt(attempt.nonce)) {
        return recordNonceInterference({ payoutStore, cycleRepository, state, index, attempt, observedNonce });
      }
      if (observedPendingNonce !== attempt.nonce || observedLatestNonce !== attempt.nonce) return state;
      await broadcastExactSignedBytes({
        signerClient,
        policySignerClient,
        policySignerFactory: exactPolicySignerFactory,
        cycleRepository,
        state,
        attempt,
        nonceLeaseContext,
      });
      return state;
    }
    const next = copy(state);
    next.recipients[index] = finalizingAttempt(attempt, reconciled.candidate, reconciled.finalizedTransfer);
    await persist(payoutStore, next);
    return next;
  }

  fail(`direct payout recipient ${attempt.recipient} has an unsupported state ${attempt.state}`);
}

/** Replaces an unresolved transaction only through the Operations transaction-policy signer. */
export async function replaceDirectPayout({
  payoutStore,
  recipient,
  replacementGasPriceWei,
  signerClient,
  policySignerClient = null,
  config,
  evmNonceFence,
  cycleRepository = null,
}) {
  const state = await load(payoutStore);
  assertRuntimeConfiguration(state, config);
  const { index, attempt } = stateRecipient(state, recipient);
  if (!['SIGNED', 'BROADCAST'].includes(attempt.state)) fail('direct payout replacement requires a signed or broadcast unresolved recipient attempt');
  assertRecipientIsNext(state, attempt);
  const prior = await assertSignedTransaction({ rawSignedBytes: attempt.rawSignedBytes, state, attempt });
  const nextGasPriceWei = assertAtomic(replacementGasPriceWei, 'direct payout replacement gasPriceWei', { positive: true });
  if (BigInt(nextGasPriceWei) > BigInt(state.plan.feasibility.maxGasPriceWei)) {
    fail('direct payout replacement exceeds the frozen gas-price cap');
  }
  if (BigInt(nextGasPriceWei) <= prior.feePerGas) {
    fail('direct payout replacement must increase the persisted transaction fee');
  }
  const replacementAttempt = { ...attempt, gasPriceWei: nextGasPriceWei };
  if (typeof evmNonceFence !== 'function') {
    fail('direct payout replacement requires a wallet-wide nonce fence before signing');
  }
  await evmNonceFence();
  const replacementPolicySignerFactory = async () => {
    const composed = await createDirectPayoutPolicySignerForAttempt({
      signerClient,
      state,
      attempt: replacementAttempt,
      config,
    });
    return composed.policySigner;
  };
  const resolved = await resolvePolicySignerClients({
    signerClient,
    policySignerClient,
    policySignerFactory: replacementPolicySignerFactory,
    state,
    attempt: replacementAttempt,
  });
  const { active, policy } = activePolicySigner(resolved);
  const signed = await active.sign({ transaction: buildTransaction(state, replacementAttempt) });
  const material = await assertSignedTransaction({ rawSignedBytes: signed?.signedTx, state, attempt: replacementAttempt });
  if (material.rawSignedBytesHash === attempt.rawSignedBytesHash) fail('direct payout replacement must use different fee-bumped raw bytes');
  if (material.feePerGas <= prior.feePerGas) fail('direct payout replacement must increase the persisted transaction fee');
  const persistedMaterial = {
    rawSignedBytes: material.rawSignedBytes,
    rawSignedBytesHash: material.rawSignedBytesHash,
    txHash: material.txHash,
  };
  const approvalContext = approvalContextForSignedPayout({
    policyApproval: readTransactionPolicyApprovalContext(policy, signed),
    material: persistedMaterial,
    requestDigest: attempt.approvalContext?.requestDigest ?? null,
    fencingToken: attempt.approvalContext?.fencingToken ?? null,
  });
  const next = copy(state);
  next.recipients[index] = {
    ...attempt,
    state: 'SIGNED',
    gasPriceWei: nextGasPriceWei,
    ...persistedMaterial,
    approvalContext,
    replacementOf: attempt.rawSignedBytesHash,
    replacementHistory: [
      ...attempt.replacementHistory,
      {
        rawSignedBytes: attempt.rawSignedBytes,
        rawSignedBytesHash: attempt.rawSignedBytesHash,
        txHash: attempt.txHash,
        nonce: attempt.nonce,
        calldataDigest: attempt.calldataDigest,
        gasPriceWei: attempt.gasPriceWei,
      },
    ],
    finalizedTransfer: null,
  };
  await persist(payoutStore, next);
  return next;
}

export function assertPayoutManifestUnchanged(stateValue, plan) {
  const state = normalizedState(stateValue);
  const candidate = assertPlan(plan).plan;
  if (state.manifestFrozen && state.planDigest !== candidate.planDigest) {
    fail('direct payout manifest is immutable after the first broadcast');
  }
  return true;
}

export function isDirectPayoutComplete(stateValue) {
  const state = normalizedState(stateValue);
  if (!state.recipients.every(attempt => ['FINALIZED', 'REFUSED', 'NONCE_INTERFERENCE'].includes(attempt.state))) return false;
  const paid = state.recipients
    .filter(attempt => attempt.state === 'FINALIZED')
    .reduce((sum, attempt) => sum + BigInt(attempt.amount.amountAtomic), 0n);
  const quarantined = state.quarantine.reduce((sum, liability) => sum + BigInt(liability.amount.amountAtomic), 0n);
  return paid + quarantined + BigInt(state.dust.amountAtomic) === BigInt(state.distributablePool.amountAtomic);
}

/**
 * Durable direct-payout state adapter. Production delegates recipient records to repository
 * pages so a large immutable manifest never enters a bounded journal payload.
 */
export function createCycleRepositoryPayoutStore({ cycleRepository, cycleId }) {
  const pagedStore = Boolean(cycleRepository
    && typeof cycleRepository.readPagedPayoutState === 'function'
    && typeof cycleRepository.persistPagedPayoutState === 'function');
  const legacyTestStore = Boolean(cycleRepository
    && typeof cycleRepository.readStageAttempt === 'function'
    && typeof cycleRepository.recordStageAttempt === 'function'
    && process.env.NODE_TEST_CONTEXT !== undefined);
  if (!pagedStore && !legacyTestStore) {
    fail('CycleRepository payout store requires readPagedPayoutState() and persistPagedPayoutState()');
  }
  if (typeof cycleId !== 'string' || cycleId.length === 0) fail('CycleRepository payout compatibility store cycleId is invalid');
  if (pagedStore) {
    return Object.freeze({
      load: () => cycleRepository.readPagedPayoutState(cycleId, STAGE),
      persist: state => {
        const normalized = normalizedState(state);
        if (normalized.cycleId !== cycleId) fail('CycleRepository payout store cycleId does not match payout state');
        return cycleRepository.persistPagedPayoutState(cycleId, STAGE, normalized);
      },
    });
  }
  return Object.freeze({
    load: () => cycleRepository.readStageAttempt(cycleId, STAGE),
    persist: state => {
      const normalized = normalizedState(state);
      if (normalized.cycleId !== cycleId) fail('CycleRepository payout compatibility store cycleId does not match payout state');
      return cycleRepository.recordStageAttempt(cycleId, STAGE, normalized);
    },
  });
}

function normalizedReturnDelta(returnEvidence, config) {
  if (!returnEvidence || returnEvidence.finalized !== true) fail('payout requires a finalized return evidence record');
  if (!equalAddress(returnEvidence.destinationAccount, config.accounts?.evm)
    || !equalAddress(returnEvidence.destinationAsset, config.contracts?.usdg)) {
    fail('payout return evidence does not prove a USDG credit to Operations');
  }
  return createUsdgPayoutAmount({
    assetId: config.contracts.usdg,
    amountAtomic: assertAtomic(returnEvidence.destinationCreditAmount, 'payout return delta'),
  });
}

function returnBinding(returnEvidence, config, cycleId) {
  return {
    operations: assertAddress(config.accounts?.evm, 'payout return Operations address'),
    usdgAddress: assertAddress(config.contracts?.usdg, 'payout return USDG address'),
    evidenceDigest: canonicalDigest({
      schema: 'hookemon.direct-payout-finalized-return.v1',
      cycleId,
      returnEvidence,
    }),
  };
}

function payoutRequestForPlan(planValue) {
  const plan = assertPlan(planValue).plan;
  return Object.freeze({
    schema: 'hookemon.direct-payout-request.v1',
    cycleId: plan.cycleId,
    planDigest: plan.planDigest,
    recipientCount: plan.payableRecipientCount,
    distributablePool: plan.distributablePool,
    plan,
  });
}

function existingPayoutStore({ cycleRepository, cycleId, payoutStore }) {
  if (payoutStore !== null) return payoutStore;
  if ((typeof cycleRepository?.readPagedPayoutState === 'function' && typeof cycleRepository?.persistPagedPayoutState === 'function')
    || (process.env.NODE_TEST_CONTEXT !== undefined
      && typeof cycleRepository?.readStageAttempt === 'function'
      && typeof cycleRepository?.recordStageAttempt === 'function')) {
    return createCycleRepositoryPayoutStore({ cycleRepository, cycleId });
  }
  return null;
}

function priorDustFromConsumption(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('payout consumed-dust recovery record is invalid');
  }
  const { sourceCycleId, sourceDigest, sourcePlanDigest, amount, planDigest } = value;
  if (typeof sourceCycleId !== 'string' || sourceCycleId.length === 0
    || typeof sourceDigest !== 'string' || !DIGEST.test(sourceDigest)
    || typeof sourcePlanDigest !== 'string' || !DIGEST.test(sourcePlanDigest)
    || typeof planDigest !== 'string' || !DIGEST.test(planDigest)) {
    fail('payout consumed-dust recovery record is invalid');
  }
  return {
    amount,
    source: {
      cycleId: sourceCycleId,
      digest: sourceDigest,
      planDigest: sourcePlanDigest,
    },
    planDigest,
  };
}

/** Builds a frozen direct-payout request for the coordinator-owned stage-driver integration. */
export async function preparePayoutRequest({ config, cycleRepository, context, payoutStore = null }) {
  if (config?.payout?.legacyVault === true) fail('legacy payout mode is explicitly disabled for Operations EOA payouts');
  const [snapshot, returned] = await Promise.all([
    cycleRepository.readStage(context.cycleId, 'eligibility-snapshot'),
    cycleRepository.readStage(context.cycleId, 'return'),
  ]);
  if (snapshot?.status !== 'COMPLETE' || !snapshot.evidence) fail('payout requires a completed frozen eligibility snapshot');
  if (returned?.status !== 'COMPLETE' || !returned.evidence) fail('payout requires a completed finalized return');
  const durablePayoutStore = existingPayoutStore({ cycleRepository, cycleId: context.cycleId, payoutStore });
  if (durablePayoutStore !== null) {
    if (typeof durablePayoutStore.load !== 'function') fail('direct payout requires a durable payoutStore.load()');
    const existing = await durablePayoutStore.load();
    if (existing !== null && existing !== undefined) {
      const state = normalizedState(existing);
      if (state.cycleId !== context.cycleId) fail('direct payout state cycleId does not match the prepared request');
      // Once a plan has consumed predecessor dust, retries must use the durable plan rather than
      // querying dust again. Its digest remains the mutation-policy request identity until payout
      // reaches terminal conservation.
      return payoutRequestForPlan(state.plan);
    }
  }
  if (typeof cycleRepository.readPayoutDust !== 'function') {
    fail('payout requires a durable prior-dust repository reader');
  }
  const dustAsset = {
    chainId: String(config.chainId ?? 4663),
    assetId: assertAddress(config.contracts?.usdg, 'payout USDG asset').toLowerCase(),
    decimals: 6,
  };
  const consumed = typeof cycleRepository.readPayoutDustConsumption === 'function'
    ? await cycleRepository.readPayoutDustConsumption(context.cycleId, dustAsset)
    : null;
  const priorDustRecord = consumed === null
    ? await cycleRepository.readPayoutDust(context.cycleId, dustAsset)
    : null;
  const priorDust = consumed === null
    ? (priorDustRecord?.amount === undefined
      ? { amount: priorDustRecord, source: null }
      : priorDustRecord)
    : priorDustFromConsumption(consumed);
  if (!priorDust.amount || !Object.hasOwn(priorDust, 'source')) fail('payout requires durable prior dust evidence');
  const plan = compileDirectPayoutPlan({
    cycleId: context.cycleId,
    eligibilityManifest: snapshot.evidence,
    finalizedReturn: normalizedReturnDelta(returned.evidence, config),
    previousDust: priorDust.amount,
    previousDustSource: priorDust.source,
    returnBinding: returnBinding(returned.evidence, config, context.cycleId),
  });
  if (consumed !== null && plan.planDigest !== priorDust.planDigest) {
    fail('payout consumed-dust recovery record does not match the reconstructed immutable plan');
  }
  return payoutRequestForPlan(plan);
}

function usesLegacyVaultPayout(config) {
  // A direct Operations payout still needs the Hook for the earlier claim stage and can run in a
  // configuration that retains historical vault addresses. Legacy settlement is therefore an
  // explicit compatibility mode, never inferred from unrelated configured identities.
  return config?.payout?.legacyVault === true;
}

function toLegacyBytes32(value) {
  return value.startsWith('sha256:') ? `0x${value.slice(7)}` : value;
}

function legacyPayoutConfigured({ adapters, config, signerClient }) {
  return Boolean(
    adapters?.robinhood?.client
    && config?.contracts?.vault
    && config?.contracts?.hook
    && config?.accounts?.evm
    && config?.accounts?.operationsTrigger
    && isTransactionPolicySignerClient(signerClient?.evm)
    && isTransactionPolicySignerClient(signerClient?.operationsTrigger)
  );
}

function buildLegacyPayoutAuthorization({
  config,
  bindingManifestDigest,
  onchainCycleId,
  payoutId,
  manifestDigest,
  rootHash,
  rootSum,
  returnActionDigest,
  returnReceiptDigest,
  expiresAt,
  nonce,
}) {
  return {
    requirementsRevision: 57,
    chainId: BigInt(config.chainId ?? 4663),
    cycleId: onchainCycleId,
    hook: config.contracts.hook,
    vault: config.contracts.vault,
    usdg: config.contracts.usdg,
    operationsTrigger: config.accounts.operationsTrigger,
    bindingManifestDigest: toLegacyBytes32(bindingManifestDigest),
    payoutId: toLegacyBytes32(payoutId),
    manifestDigest: toLegacyBytes32(manifestDigest),
    rootHash: toLegacyBytes32(rootHash),
    rootSum: BigInt(rootSum),
    returnActionDigest: toLegacyBytes32(returnActionDigest),
    returnReceiptDigest: toLegacyBytes32(returnReceiptDigest),
    expiresAt: BigInt(expiresAt),
    nonce: BigInt(nonce),
  };
}

async function readFinalizedLegacyOutcome(adapters, transactionHash) {
  if (!adapters?.robinhood?.client || !transactionHash) return null;
  let observation;
  try {
    observation = await readFinalizedTransactionReceipt(adapters.robinhood.client, transactionHash);
  } catch {
    return null;
  }
  return observation.finalized ? observation : null;
}

async function probeLegacyPayout({ adapters, config }) {
  if (!adapters?.robinhood?.client || !config?.contracts?.vault) {
    return {
      wouldPayout: true,
      configured: false,
      reason: 'HOOKEMON_VAULT_ADDRESS / robinhood RPC client is not configured',
    };
  }
  const pendingAuthorization = await readPendingAuthorization(adapters.robinhood.client, config.contracts.vault);
  return { wouldPayout: true, configured: true, pendingAuthorization };
}

async function mutateLegacyPayout({ liveMode, adapters, config, signerClient, cycleRepository, context }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutatePayout reached without liveMode');
  const existingAttempt = await cycleRepository.readStageAttempt(context.cycleId, STAGE);
  if (existingAttempt?.phase === 'fund') return existingAttempt;

  if (existingAttempt?.phase === 'authorize') {
    const observation = await readFinalizedLegacyOutcome(adapters, existingAttempt.transactionHash);
    if (!observation) return existingAttempt;
    if (observation.receipt.status !== 'success') {
      await cycleRepository.recordStageAttemptFailure(context.cycleId, STAGE, {
        phase: 'authorize',
        transactionHash: existingAttempt.transactionHash,
        receiptStatus: observation.receipt.status,
      });
      throw new StageMutationRevertedError(
        STAGE,
        `authorizePayout transaction ${existingAttempt.transactionHash} reverted on-chain`,
        { transactionHash: existingAttempt.transactionHash, receiptStatus: observation.receipt.status },
      );
    }
    const mutationAuthority = requireLiveRetainedCustodyMutationAuthority();
    if (!legacyPayoutConfigured({ adapters, config, signerClient })) {
      throw new Error(
        'payout mutate requires HOOKEMON_VAULT_ADDRESS, HOOKEMON_HOOK_ADDRESS, HOOKEMON_EVM_ACCOUNT, '
        + 'a configured robinhood RPC client, and policy-bound Operations signer clients; the legacy '
        + 'operations-trigger payout path is disabled',
      );
    }
    const authorization = buildLegacyPayoutAuthorization({
      config,
      bindingManifestDigest: mutationAuthority.bindingManifestDigest,
      ...existingAttempt,
    });
    const call = buildFundPayoutFromPegCycleCall(config.contracts.hook, authorization);
    requireLiveRetainedCustodyMutationAuthority();
    const signed = await signerClient.operationsTrigger.sign({
      to: call.to,
      data: call.data,
      chainId: config.chainId ?? 4663,
    });
    if (!signed?.signedTx) {
      throw new Error('operations-trigger signer client did not return signedTx for fundPayoutFromPegCycle');
    }
    requireLiveRetainedCustodyMutationAuthority();
    const broadcast = await signerClient.operationsTrigger.broadcast(signed);
    if (!broadcast?.transactionHash) {
      throw new Error('operations-trigger transaction-policy signer did not return transactionHash for fundPayoutFromPegCycle');
    }
    return {
      ...existingAttempt,
      phase: 'fund',
      authorizeTransactionHash: existingAttempt.transactionHash,
      transactionHash: broadcast.transactionHash,
    };
  }

  const funding = await cycleRepository.readStage(context.cycleId, 'funding');
  if (funding.status !== 'COMPLETE' || typeof funding.evidence?.returnActionDigest !== 'string') {
    throw new Error('payout mutate requires a completed funding stage with a recorded returnActionDigest');
  }
  const distribution = await cycleRepository.readStage(context.cycleId, 'distribution');
  if (distribution.status !== 'COMPLETE' || !distribution.evidence) {
    throw new Error('payout mutate requires a completed distribution stage with a recorded manifest/root/rootSum/payoutId');
  }
  const {
    manifestDigest,
    rootHash,
    rootSum,
    payoutId,
    distributionSignature,
    verifierSignature,
  } = distribution.evidence;
  if (!manifestDigest || !rootHash || rootSum === undefined || !payoutId) {
    throw new Error('payout mutate: distribution stage evidence is missing manifestDigest/rootHash/rootSum/payoutId');
  }
  if (typeof distributionSignature !== 'string' || typeof verifierSignature !== 'string') {
    throw new Error(
      'payout mutate: distribution stage evidence is missing the dual EIP-712 distributionSignature/'
      + 'verifierSignature; the distribution stage must run under the production profile before payout',
    );
  }
  const returned = await cycleRepository.readStage(context.cycleId, 'return');
  if (returned.status !== 'COMPLETE' || !returned.evidence) {
    throw new Error('payout mutate requires a completed return stage');
  }
  const returnReceiptDigest = canonicalDigest({
    domain: 'hookemon.stage-driver.return-receipt.v1',
    evidence: returned.evidence,
  });
  const onchainCycleId = deriveOnchainCycleId(context.cycleId);
  const expiresAt = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);
  const attemptIndex = await cycleRepository.nextStageAttemptIndex(context.cycleId, STAGE);
  const nonce = deriveAuthorizationNonce(onchainCycleId, STAGE, attemptIndex);
  const mutationAuthority = requireLiveRetainedCustodyMutationAuthority();
  if (!legacyPayoutConfigured({ adapters, config, signerClient })) {
    throw new Error(
      'payout mutate requires HOOKEMON_VAULT_ADDRESS, HOOKEMON_HOOK_ADDRESS, HOOKEMON_EVM_ACCOUNT, '
      + 'a configured robinhood RPC client, and policy-bound Operations signer clients; the legacy '
      + 'operations-trigger payout path is disabled',
    );
  }
  const authorization = buildLegacyPayoutAuthorization({
    config,
    bindingManifestDigest: mutationAuthority.bindingManifestDigest,
    onchainCycleId,
    payoutId,
    manifestDigest,
    rootHash,
    rootSum,
    returnActionDigest: funding.evidence.returnActionDigest,
    returnReceiptDigest,
    expiresAt,
    nonce: nonce.toString(),
  });
  const call = buildAuthorizePayoutCall(
    config.contracts.vault,
    authorization,
    distributionSignature,
    verifierSignature,
  );
  requireLiveRetainedCustodyMutationAuthority();
  const signed = await signerClient.evm.sign({
    to: call.to,
    data: call.data,
    chainId: config.chainId ?? 4663,
  });
  if (!signed?.signedTx) throw new Error('operator EVM signer client did not return signedTx for authorizePayout');
  requireLiveRetainedCustodyMutationAuthority();
  const broadcast = await signerClient.evm.broadcast(signed);
  if (!broadcast?.transactionHash) {
    throw new Error('operator EVM transaction-policy signer did not return transactionHash for authorizePayout');
  }
  return {
    phase: 'authorize',
    transactionHash: broadcast.transactionHash,
    onchainCycleId,
    payoutId,
    manifestDigest,
    rootHash,
    rootSum: authorization.rootSum.toString(),
    returnActionDigest: authorization.returnActionDigest,
    returnReceiptDigest: authorization.returnReceiptDigest,
    expiresAt: expiresAt.toString(),
    nonce: nonce.toString(),
    attemptIndex,
  };
}

async function reconcileLegacyPayout({ adapters, cycleRepository, context }) {
  const attempt = await cycleRepository.readStageAttempt(context.cycleId, STAGE);
  if (!attempt) return null;
  const observation = await readFinalizedLegacyOutcome(adapters, attempt.transactionHash);
  if (!observation) return null;
  if (observation.receipt.status !== 'success') {
    await cycleRepository.recordStageAttemptFailure(context.cycleId, STAGE, {
      phase: attempt.phase,
      transactionHash: attempt.transactionHash,
      receiptStatus: observation.receipt.status,
    });
    const action = attempt.phase === 'fund' ? 'fundPayoutFromPegCycle' : 'authorizePayout';
    throw new StageMutationRevertedError(
      STAGE,
      `${action} transaction ${attempt.transactionHash} reverted on-chain`,
      { transactionHash: attempt.transactionHash, receiptStatus: observation.receipt.status },
    );
  }
  return attempt.phase === 'fund' ? { ...attempt, finalized: true } : null;
}

function payoutTerminalEvidence(stateValue) {
  const state = normalizedState(stateValue);
  if (!isDirectPayoutComplete(state)) fail('direct payout terminal evidence requires exact recipient conservation');
  return {
    schema: 'hookemon.direct-payout-result.v1',
    cycleId: state.cycleId,
    planDigest: state.planDigest,
    distributablePool: state.distributablePool,
    totalAllocated: state.plan.totalAllocated,
    dust: state.dust,
    recipients: state.recipients.map(attempt => ({
      recipient: attempt.recipient,
      amount: attempt.amount,
      state: attempt.state,
      nonce: attempt.nonce,
      transactionHash: attempt.txHash,
      finalizedTransfer: attempt.finalizedTransfer,
      refusalEvidence: attempt.refusalEvidence,
    })),
    quarantine: state.quarantine,
  };
}

function payoutCustodyLedger(cycleId, amount) {
  const buckets = {
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: amount.amountAtomic,
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: String(amount.chainId),
    assetId: amount.assetId,
    decimals: amount.decimals,
    ...buckets,
  };
}

async function ensurePayoutCustodyLedger({ cycleRepository, cycleId, returnDelta }) {
  if (typeof cycleRepository.recordCustodyLedger !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    fail('direct payout production execution requires a custody ledger repository');
  }
  const expected = payoutCustodyLedger(cycleId, returnDelta);
  const state = await cycleRepository.describeCycle(cycleId);
  const existing = state?.custodyLedgers?.get?.(`${expected.chainId}\u0000${expected.assetId}`) ?? null;
  if (existing) {
    if (existing.decimals !== expected.decimals || BigInt(existing.returnReceived) < BigInt(expected.returnReceived)) {
      fail('direct payout custody ledger does not prove the finalized return backing');
    }
    return;
  }
  await cycleRepository.recordCustodyLedger(cycleId, expected);
}

function isPagedPayoutStateReference(value, planDigest) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schema === 'hookemon.paged-payout-state-reference.v1'
    && value.stage === STAGE
    && value.planDigest === planDigest;
}

async function recoverPagedPayoutInitialization({ cycleRepository, cycleId, plan, state }) {
  if (typeof cycleRepository.readStageAttempt !== 'function'
    || typeof cycleRepository.consumePayoutDustAndPersistPagedPayoutState !== 'function') {
    return;
  }
  const initialization = {
    source: plan.previousDustSource,
    amount: repositoryAmount(plan.previousDust),
    planDigest: plan.planDigest,
    stage: STAGE,
    evidence: state,
  };
  const recorded = await cycleRepository.readStageAttempt(cycleId, STAGE);
  if (recorded === null) {
    await cycleRepository.consumePayoutDustAndPersistPagedPayoutState(cycleId, initialization);
    const repaired = await cycleRepository.readStageAttempt(cycleId, STAGE);
    if (!isPagedPayoutStateReference(repaired, plan.planDigest)) {
      fail('direct payout recovery did not bind paged state to predecessor-dust consumption');
    }
    return;
  }
  if (!isPagedPayoutStateReference(recorded, plan.planDigest)) {
    fail('direct payout paged state is not bound to its immutable predecessor-dust consumption');
  }
}

async function ensureDirectPayoutState({ cycleRepository, context, request, adapters, config, evmNonceFence = null }) {
  const payoutStore = createCycleRepositoryPayoutStore({ cycleRepository, cycleId: context.cycleId });
  const existing = await payoutStore.load();
  if (existing !== null && existing !== undefined) {
    assertPayoutManifestUnchanged(existing, request.plan);
    await recoverPagedPayoutInitialization({
      cycleRepository,
      cycleId: context.cycleId,
      plan: request.plan,
      state: normalizedState(existing),
    });
    await ensurePayoutCustodyLedger({
      cycleRepository,
      cycleId: context.cycleId,
      returnDelta: request.plan.returnDelta,
    });
    return { payoutStore, state: normalizedState(existing) };
  }
  const pagedInitialization = typeof cycleRepository.consumePayoutDustAndPersistPagedPayoutState === 'function';
  const legacyTestInitialization = process.env.NODE_TEST_CONTEXT !== undefined
    && typeof cycleRepository.consumePayoutDustAndRecordStageAttempt === 'function';
  if (!pagedInitialization && !legacyTestInitialization) {
    fail('direct payout production execution requires atomic prior-dust consumption and payout-state storage');
  }
  const client = adapters?.robinhood?.client;
  if (!client || typeof client.getTransactionCount !== 'function') {
    fail('direct payout requires getTransactionCount before initializing recipient state');
  }
  await evmNonceFence?.();
  const firstNonce = normalizeNonce(
    await client.getTransactionCount({ address: config.accounts.evm, blockTag: 'pending' }),
    'initial direct payout nonce',
  );
  const initialState = createDirectPayoutState({
    plan: request.plan,
    operations: config.accounts.evm,
    usdgAddress: config.contracts.usdg,
    firstNonce,
  });
  const initialization = {
    source: request.plan.previousDustSource,
    amount: repositoryAmount(request.plan.previousDust),
    planDigest: request.plan.planDigest,
    stage: STAGE,
    evidence: initialState,
  };
  if (pagedInitialization) {
    await cycleRepository.consumePayoutDustAndPersistPagedPayoutState(context.cycleId, initialization);
  } else {
    await cycleRepository.consumePayoutDustAndRecordStageAttempt(context.cycleId, initialization);
  }
  const persisted = await payoutStore.load();
  if (persisted === null || persisted === undefined) {
    fail('direct payout atomic initialization did not persist its payout state');
  }
  const state = normalizedState(persisted);
  assertPayoutManifestUnchanged(state, request.plan);
  await ensurePayoutCustodyLedger({
    cycleRepository,
    cycleId: context.cycleId,
    returnDelta: request.plan.returnDelta,
  });
  return { payoutStore, state };
}

async function advanceDirectPayoutUntilPending({
  payoutStore,
  cycleRepository,
  adapters,
  signerClient,
  policySignerClient,
  policySignerFactory = null,
  config,
  requestDigest,
  fencingToken,
  evmNonceFence,
  nonceLeaseContext = null,
}) {
  const maximumBoundaries = (await load(payoutStore)).recipients.length * 5 + 1;
  for (let boundary = 0; boundary < maximumBoundaries; boundary += 1) {
    const state = await load(payoutStore);
    if (isDirectPayoutComplete(state)) return state;
    const next = nextUnresolvedRecipient(state);
    if (!next) fail('direct payout has no unresolved recipient before terminal conservation');
    const before = canonicalDigest(state);
    const advanced = await advanceDirectPayout({
      payoutStore,
      recipient: next.recipient,
      adapters,
      signerClient,
      policySignerClient,
      policySignerFactory,
      config,
      cycleRepository,
      requestDigest,
      fencingToken,
      evmNonceFence,
      nonceLeaseContext,
    });
    if (canonicalDigest(advanced) === before) return null;
  }
  fail('direct payout exceeded its durable recipient-boundary budget');
}

async function finalizeDirectPayoutResult({ cycleRepository, state }) {
  if (BigInt(state.dust.amountAtomic) > 0n) {
    if (typeof cycleRepository.recordPayoutDust !== 'function') {
      fail('direct payout production execution requires durable successor-dust storage');
    }
    await cycleRepository.recordPayoutDust(state.cycleId, {
      amount: repositoryAmount(state.dust),
      planDigest: state.planDigest,
    });
  }
  const evidence = payoutTerminalEvidence(state);
  const quarantined = state.recipients
    .filter(attempt => ['REFUSED', 'NONCE_INTERFERENCE'].includes(attempt.state))
    .map(attempt => ({
      recipient: attempt.recipient,
      amount: repositoryAmount(attempt.amount),
      reason: attempt.state === 'NONCE_INTERFERENCE' ? 'NONCE_INTERFERENCE' : attempt.refusalEvidence.reason,
    }));
  if (quarantined.length > 0) {
    if (typeof cycleRepository.holdCycle !== 'function') {
      fail('direct payout quarantined liabilities require cycleRepository.holdCycle');
    }
    await cycleRepository.holdCycle(state.cycleId, 'HELD_OWNER_DECISION', {
      stage: STAGE,
      reason: 'PAYOUT_QUARANTINED_LIABILITY',
      planDigest: state.planDigest,
      liabilities: quarantined,
    });
  }
  return evidence;
}

function directPayoutWalletNonceReservationInput({ context, config }) {
  if (typeof context?.fencingToken !== 'string' || context.fencingToken.length === 0) {
    fail('direct payout wallet nonce reservation requires a fencing token');
  }
  return {
    chainId: String(config.chainId ?? 4663),
    wallet: assertAddress(config.accounts?.evm, 'direct payout nonce-lock Operations address'),
    stage: STAGE,
    fencingToken: context.fencingToken,
    ...walletNonceLeaseWindow(context, 'direct payout wallet nonce reservation'),
  };
}

async function reserveDirectPayoutWalletNonce({ cycleRepository, context, config }) {
  if (typeof cycleRepository.reserveWalletNonce !== 'function' || typeof cycleRepository.assertWalletNonce !== 'function') {
    fail('direct payout production execution requires a global wallet nonce reservation repository');
  }
  const reservation = directPayoutWalletNonceReservationInput({ context, config });
  await cycleRepository.reserveWalletNonce(context.cycleId, reservation);
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
  return reservation;
}

async function assertDirectPayoutWalletNonce({ cycleRepository, context, config }) {
  if (typeof cycleRepository.assertWalletNonce !== 'function') {
    fail('direct payout production execution requires a global wallet nonce reservation repository');
  }
  await cycleRepository.assertWalletNonce(
    context.cycleId,
    directPayoutWalletNonceReservationInput({ context, config }),
  );
}

async function releaseDirectPayoutWalletNonce({ cycleRepository, context, config }) {
  if (typeof cycleRepository.releaseWalletNonce !== 'function') {
    fail('direct payout production execution requires a wallet-wide nonce lock release repository');
  }
  await cycleRepository.releaseWalletNonce(
    context.cycleId,
    directPayoutWalletNonceReservationInput({ context, config }),
  );
}

function recoverableNonceFenceReleaseError(error) {
  return /stale fencing token|wallet nonce (lock|reservation) is not held/.test(error?.message ?? '');
}

async function recoverDirectPayoutWalletNonce({ cycleRepository, context, config }) {
  if (!context?.fencingToken) return;
  if (typeof cycleRepository.releaseWalletNonce !== 'function'
    || typeof cycleRepository.reserveWalletNonce !== 'function'
    || typeof cycleRepository.assertWalletNonce !== 'function') {
    fail('direct payout recovery requires a wallet-wide nonce lock repository');
  }
  await context.assertMutationAllowed?.({
    boundary: 'mutation',
    cycleId: context.cycleId,
    stage: STAGE,
    fencingToken: context.fencingToken,
  });
  const input = directPayoutWalletNonceReservationInput({ context, config });
  try {
    await cycleRepository.releaseWalletNonce(context.cycleId, input);
    return;
  } catch (error) {
    if (!recoverableNonceFenceReleaseError(error)) throw error;
  }
  await cycleRepository.reserveWalletNonce(context.cycleId, input);
  await cycleRepository.assertWalletNonce(context.cycleId, input);
  await cycleRepository.releaseWalletNonce(context.cycleId, input);
}

export async function probePayout({ adapters, config }) {
  if (usesLegacyVaultPayout(config) || !(config?.contracts?.usdg && config?.accounts?.evm)) {
    return probeLegacyPayout({ adapters, config });
  }
  const configured = Boolean(adapters?.robinhood?.client && config?.contracts?.usdg && config?.accounts?.evm);
  return {
    wouldPayout: true,
    configured,
    reason: configured
      ? 'direct Operations payout is ready for its frozen eligibility and finalized return evidence'
      : 'USDG, Operations EVM account, or chain 4663 client is not configured',
  };
}

export async function mutatePayout(args) {
  const { liveMode, config } = args;
  if (usesLegacyVaultPayout(config)) return mutateLegacyPayout(args);
  if (liveMode !== true) fail('direct payout mutation requires liveMode');
  if (config?.payout?.legacyVault === true) fail('legacy payout mode is explicitly disabled for Operations EOA payouts');
  const {
    cycleRepository,
    context,
    request,
    adapters,
    signerClient,
    policySignerClient = null,
    evmNonceFence = null,
  } = args;
  if (!cycleRepository || !context || !request?.plan) fail('direct payout mutation requires cycle repository, stage context, and prepared request');
  if (typeof context.requestDigest !== 'string' || !DIGEST.test(context.requestDigest)
    || typeof context.fencingToken !== 'string' || context.fencingToken.length === 0) {
    fail('direct payout production execution requires a request digest and persisted fencing token');
  }
  // Bind every direct-payout signature to a policy decoded from its durable recipient attempt.
  // The factory receives the stage driver's guarded facade, never an unguarded keychain or
  // external-module client, so it cannot bypass standing-authority or lease checks.
  const policySignerFactory = async ({ state, attempt }) => {
    const composed = await createDirectPayoutPolicySigner({
      signerClient,
      state,
      recipient: attempt.recipient,
      config,
    });
    return composed.policySigner;
  };
  await reserveDirectPayoutWalletNonce({ cycleRepository, context, config });
  const walletNonceFence = async () => {
    await assertDirectPayoutWalletNonce({ cycleRepository, context, config });
    await evmNonceFence?.();
  };
  const { payoutStore } = await ensureDirectPayoutState({
    cycleRepository,
    context,
    request,
    adapters,
    config,
    evmNonceFence: walletNonceFence,
  });
  const terminal = await advanceDirectPayoutUntilPending({
    payoutStore,
    cycleRepository,
    adapters,
    signerClient,
    policySignerClient,
    policySignerFactory,
    config,
    requestDigest: context.requestDigest,
    fencingToken: context.fencingToken,
    evmNonceFence: walletNonceFence,
    nonceLeaseContext: context,
  });
  if (terminal === null) return undefined;
  await releaseDirectPayoutWalletNonce({ cycleRepository, context, config });
  const evidence = await finalizeDirectPayoutResult({ cycleRepository, state: terminal });
  return evidence;
}

export async function reconcileLivePayout(args = {}) {
  if (usesLegacyVaultPayout(args.config)) return reconcileLegacyPayout(args);
  if (!args.cycleRepository || !args.context) return null;
  const payoutStore = existingPayoutStore({
    cycleRepository: args.cycleRepository,
    cycleId: args.context.cycleId,
    payoutStore: null,
  });
  if (payoutStore === null) return null;
  const state = await payoutStore.load();
  if (state === null || state === undefined) return null;
  try {
    if (!isDirectPayoutComplete(state)) return null;
    // A crash after the final recipient boundary but before mutatePayout() returns must still
    // write successor dust before the stage can be reconciled and completed.
    await recoverDirectPayoutWalletNonce({
      cycleRepository: args.cycleRepository,
      context: args.context,
      config: args.config,
    });
    const evidence = await finalizeDirectPayoutResult({ cycleRepository: args.cycleRepository, state });
    return evidence;
  } catch (error) {
    if (error instanceof DirectPayoutError) return null;
    throw error;
  }
}
