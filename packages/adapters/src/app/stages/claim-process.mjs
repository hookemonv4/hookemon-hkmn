import {
  decodeEventLog,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';

import { createEvmCustodyBalanceObservationReader } from '../../evm-custody-balance-observation.mjs';
import { buildClaimProcessCall, HOOK_ABI } from '../../hook-contract-client.mjs';
import {
  RobinhoodMalformedResponseError,
  readFinalizedErc20TransferCredit,
  readFinalizedTransactionReceipt,
  readTransaction,
  sendRawTransaction,
} from '../../robinhood-rpc.mjs';
import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  readTransactionPolicyRules,
} from '../../signing/transaction-policy.mjs';
import {
  assertMoneyConfiguration,
  createPreparedChainTransactionAttempt,
  CUSTODY_LEDGER_BUCKETS,
} from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
} from '../../../../runner/src/cycle/preflight.mjs';
import { deriveOnchainCycleId, readUsdgAddress } from './action-builder.mjs';
import { readBlockByNumber, readFinalizedBlock } from '../../robinhood-rpc.mjs';
import { StageMutationRevertedError } from './errors.mjs';
import { walletNonceLeaseWindow } from '../wallet-nonce-lease.mjs';

const USDG_DECIMALS = 6;
const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
const CLAIM_EVENT_ABI = parseAbi([
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountAtomicUsdg, address indexed destination, uint256 timestamp, uint256 cap, uint256 usedAfter)',
]);
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function hasUnresolvedCustody(custody) {
  return custody?.heldAssets === true || custody?.unattributed === true || custody?.unresolvedObligations === true;
}

function receiptSucceeded(status) {
  return status === 'success' || status === '0x1' || status === 1 || status === 1n;
}

function assertClaimConfiguration(config) {
  if (!config?.contracts?.hook || !config?.accounts?.evm) {
    throw new Error('claim-process requires HOOKEMON_HOOK_ADDRESS and HOOKEMON_EVM_ACCOUNT');
  }
  return {
    chainId: config.chainId ?? 4663,
    hook: config.contracts.hook,
    operations: config.accounts.evm,
    usdg: readUsdgAddress(config),
  };
}

function assertClaimMoneyConfiguration(config, configured) {
  let money;
  try {
    money = assertMoneyConfiguration(config?.moneyConfiguration, 'claim-process money configuration');
  } catch (error) {
    throw new Error(`claim-process requires MoneyConfigurationV1: ${error.message}`);
  }
  if (money.assets.usdg.chainId !== String(configured.chainId)
    || money.assets.usdg.assetId.toLowerCase() !== configured.usdg.toLowerCase()
    || money.assets.usdg.decimals !== USDG_DECIMALS) {
    throw new Error('claim-process MoneyConfigurationV1 USDG asset does not match the configured claim route');
  }
  return money;
}

function claimWalletNonceReservation({ configured, context }) {
  if (typeof context?.fencingToken !== 'string' || context.fencingToken.length === 0) {
    throw new Error('claim-process requires a fencing token for the global wallet nonce reservation');
  }
  return Object.freeze({
    chainId: String(configured.chainId),
    wallet: String(configured.operations).toLowerCase(),
    stage: 'claim-process',
    fencingToken: context.fencingToken,
    ...walletNonceLeaseWindow(context, 'claim-process wallet nonce reservation'),
  });
}

function hasWalletNonceReservationRepository(cycleRepository) {
  return typeof cycleRepository?.reserveWalletNonce === 'function'
    && typeof cycleRepository?.assertWalletNonce === 'function';
}

async function reserveClaimWalletNonce({ cycleRepository, context, configured }) {
  if (!hasWalletNonceReservationRepository(cycleRepository)) {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return null;
    throw new Error('claim-process requires a global wallet nonce reservation repository');
  }
  const reservation = claimWalletNonceReservation({ configured, context });
  await cycleRepository.reserveWalletNonce(context.cycleId, reservation);
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
  return reservation;
}

async function assertClaimWalletNonce({ cycleRepository, context, reservation }) {
  if (reservation === null) return;
  await cycleRepository.assertWalletNonce(context.cycleId, reservation);
}

async function releaseClaimWalletNonce({ cycleRepository, context, configured }) {
  if (typeof cycleRepository?.releaseWalletNonce !== 'function') {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;
    throw new Error('claim-process requires a global wallet nonce reservation release repository');
  }
  await cycleRepository.releaseWalletNonce(
    context.cycleId,
    claimWalletNonceReservation({ configured, context }),
  );
}

function positiveBigInt(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a positive integer`);
  }
}

function nonnegativeBigInt(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a nonnegative integer`);
  }
}

async function prepareClaimTransaction({ adapters, configured, call, money }) {
  if (!adapters) return null;
  const client = adapters?.robinhood?.client;
  for (const method of ['getChainId', 'getTransactionCount', 'estimateGas', 'estimateFeesPerGas', 'getBalance']) {
    if (typeof client?.[method] !== 'function') {
      throw new Error(`claim-process requires Robinhood RPC ${method} before signing`);
    }
  }
  const [chainId, nonce, gas, fees, balance] = await Promise.all([
    client.getChainId(),
    client.getTransactionCount({ address: configured.operations, blockTag: 'pending' }),
    client.estimateGas({ account: configured.operations, to: call.to, data: call.data, value: 0n }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: configured.operations }),
  ]);
  if (BigInt(chainId) !== BigInt(configured.chainId)) {
    throw new Error('claim-process Robinhood RPC chain id does not match the configured claim chain');
  }
  const maxFeePerGas = positiveBigInt(fees?.maxFeePerGas, 'claim-process EIP-1559 maxFeePerGas');
  const maxPriorityFeePerGas = positiveBigInt(fees?.maxPriorityFeePerGas, 'claim-process EIP-1559 maxPriorityFeePerGas');
  const gasLimit = positiveBigInt(gas, 'claim-process estimated gas');
  const gasPriceCap = positiveBigInt(money.evm.perTransactionGasPriceCap.amountAtomic, 'claim-process MoneyConfigurationV1 EVM gas-price cap');
  if (maxFeePerGas > gasPriceCap || maxPriorityFeePerGas > gasPriceCap || maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error('claim-process EIP-1559 gas price exceeds the configured MoneyConfigurationV1 cap');
  }
  const requiredNative = (gasLimit * maxFeePerGas)
    + nonnegativeBigInt(money.evm.nativeReserve.amountAtomic, 'claim-process MoneyConfigurationV1 EVM native reserve');
  if (nonnegativeBigInt(balance, 'claim-process Operations native balance') < requiredNative) {
    throw new Error('claim-process Operations native balance does not retain the configured reserve after quoted gas');
  }
  const transaction = {
    type: 'eip1559',
    to: call.to,
    data: call.data,
    value: '0',
    from: configured.operations,
    chainId: configured.chainId,
    nonce: nonnegativeBigInt(nonce, 'claim-process pending nonce').toString(),
    gas: gasLimit.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
  };
  return Object.freeze(transaction);
}

/**
 * Builds the immutable, typed Operations-self claim request before any signer is reached. The
 * stage driver persists this stable request digest before the chain-attempt path reads a nonce or
 * fee estimate.
 */
export async function prepareClaimProcessRequest({ config, cycleRepository, context }) {
  const [snapshot, custody, cycle] = await Promise.all([
    cycleRepository.readStage(context.cycleId, 'eligibility-snapshot'),
    cycleRepository.readClaimPreconditions(context.cycleId),
    cycleRepository.describeCycle(context.cycleId),
  ]);
  if (snapshot.status !== 'COMPLETE') {
    throw new Error('claim-process requires a completed eligibility snapshot');
  }
  if (hasUnresolvedCustody(custody)) {
    throw new Error('claim-process refuses while custody has unresolved assets or obligations');
  }
  const amountAtomic = cycle?.releaseAmount;
  if (typeof amountAtomic !== 'string' || !ATOMIC_AMOUNT.test(amountAtomic) || amountAtomic === '0') {
    throw new Error('claim-process requires a positive canonical cycle release amount');
  }
  const configured = assertClaimConfiguration(config);
  assertClaimMoneyConfiguration(config, configured);
  const onchainCycleId = deriveOnchainCycleId(context.cycleId);
  const call = buildClaimProcessCall(configured.hook, onchainCycleId, amountAtomic, configured.operations);
  return Object.freeze({
    schema: 'hookemon.claim-process-request.v1',
    cycleId: context.cycleId,
    onchainCycleId,
    destination: configured.operations,
    amount: Object.freeze({
      chainId: String(configured.chainId),
      assetId: configured.usdg.toLowerCase(),
      decimals: USDG_DECIMALS,
      amountAtomic,
    }),
    call,
  });
}

/** The probe exposes only durable prerequisites; it never constructs or submits a claim. */
export async function probeClaimProcess({ cycleRepository, context }) {
  const [snapshot, custody] = await Promise.all([
    cycleRepository.readStage(context.cycleId, 'eligibility-snapshot'),
    cycleRepository.readClaimPreconditions(context.cycleId),
  ]);
  const blockedByCustody = hasUnresolvedCustody(custody);
  return {
    wouldProcessClaims: true,
    configured: snapshot.status === 'COMPLETE' && !blockedByCustody,
    snapshotComplete: snapshot.status === 'COMPLETE',
    custody,
    reason: blockedByCustody
      ? 'custody ledger has unresolved assets or obligations'
      : 'claim request is ready; durable chain-attempt signing is required before broadcast',
  };
}

function equalAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function canonicalAtomic(value, label) {
  if (typeof value !== 'string' || !ATOMIC_AMOUNT.test(value)) throw new Error(`${label} must be a canonical atomic amount`);
  return value;
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

function assertCanonicalClaimRequest(request, expected) {
  const amount = request?.amount;
  if (request?.schema !== expected.schema
    || request.cycleId !== expected.cycleId
    || request.onchainCycleId?.toLowerCase() !== expected.onchainCycleId.toLowerCase()
    || !equalAddress(request.destination, expected.destination)
    || amount?.chainId !== expected.amount.chainId
    || amount?.assetId?.toLowerCase() !== expected.amount.assetId.toLowerCase()
    || amount?.decimals !== expected.amount.decimals
    || amount?.amountAtomic !== expected.amount.amountAtomic
    || !equalAddress(request.call?.to, expected.call.to)
    || request.call?.data !== expected.call.data
    || request.call?.functionName !== 'claimProcess') {
    throw new Error('claim-process request does not match the canonical claim intent');
  }
}

async function claimTransactionPolicy({ request, transaction, requestDigest, configured }) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    throw new Error('claim-process requires a prepared EVM transaction before signing');
  }
  if (transaction.type !== 'eip1559'
    || !equalAddress(transaction.to, request.call?.to)
    || transaction.data !== request.call?.data
    || !equalAddress(transaction.from, configured.operations)
    || BigInt(transaction.value ?? '-1') !== 0n
    || BigInt(transaction.chainId ?? '-1') !== BigInt(configured.chainId)) {
    throw new Error('claim-process prepared transaction does not match the canonical claim call');
  }
  for (const field of ['nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    canonicalAtomic(String(transaction[field] ?? ''), `claim-process transaction ${field}`);
  }
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });
  if (decoded.chainId !== String(configured.chainId)
    || !equalAddress(decoded.source, configured.operations)
    || !equalAddress(decoded.target, request.call.to)
    || decoded.selector !== request.call.data.slice(0, 10)
    || decoded.nativeValue?.amountAtomic !== '0') {
    throw new Error('claim-process decoded transaction does not match the canonical claim call');
  }
  const policy = createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage: 'claim-process', requestDigest }),
    rules: [exactPolicyRule(decoded, 'claim-process')],
  });
  return Object.freeze({
    transaction: Object.freeze({ ...transaction }),
    policy,
    policyRules: readTransactionPolicyRules(policy),
  });
}

async function parseSignedClaim(rawBytes) {
  if (typeof rawBytes !== 'string' || !EVM_BYTES.test(rawBytes)) {
    throw new Error('claim-process signer did not return serialized EVM transaction bytes');
  }
  let parsed;
  let sender;
  try {
    parsed = parseTransaction(rawBytes);
    sender = await recoverTransactionAddress({ serializedTransaction: rawBytes });
  } catch (error) {
    throw new Error(`claim-process signer returned an undecodable signed transaction: ${error.message}`);
  }
  return { parsed, sender };
}

function assertSignedClaimStatic({ parsed, sender, call, configured }) {
  if (parsed.type !== 'eip1559'
    || !equalAddress(sender, configured.operations)
    || !equalAddress(parsed.to, call.to)
    || parsed.data !== call.data
    || BigInt(parsed.chainId) !== BigInt(configured.chainId)
    || BigInt(parsed.value ?? 0n) !== 0n) {
    throw new Error('claim-process signer returned bytes that do not match the approved transaction');
  }
  nonnegativeBigInt(parsed.nonce, 'claim-process signed nonce');
  positiveBigInt(parsed.gas, 'claim-process signed gas');
  positiveBigInt(parsed.maxFeePerGas, 'claim-process signed maxFeePerGas');
  positiveBigInt(parsed.maxPriorityFeePerGas, 'claim-process signed maxPriorityFeePerGas');
}

async function signingMaterialForClaim(rawBytes, { transaction = null, call, configured }) {
  const { parsed, sender } = await parseSignedClaim(rawBytes);
  assertSignedClaimStatic({ parsed, sender, call, configured });
  if (transaction !== null && (BigInt(parsed.nonce) !== BigInt(transaction.nonce)
    || BigInt(parsed.gas) !== BigInt(transaction.gas)
    || BigInt(parsed.maxFeePerGas) !== BigInt(transaction.maxFeePerGas)
    || BigInt(parsed.maxPriorityFeePerGas) !== BigInt(transaction.maxPriorityFeePerGas))) {
    throw new Error('claim-process signer returned bytes that do not match the approved transaction');
  }
  return Object.freeze({
    rawBytes,
    nonce: BigInt(parsed.nonce).toString(),
    blockhash: null,
    hash: keccak256(rawBytes),
  });
}

function assertChainAttemptHash(attempt, transactionHash) {
  if (!attempt || typeof attempt !== 'object' || !EVM_HASH.test(attempt.hash ?? '')) {
    throw new Error('claim-process chain attempt has no canonical signed transaction hash');
  }
  if (attempt.hash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new Error('claim-process chain attempt hash does not match the signed bytes');
  }
}

function requireClaimMutationAuthority(preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('claim-process fixture authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('claim-process fixture authority is invalid');
  return requireLiveMutationAuthority();
}

async function readExistingClaimAttempt(cycleRepository, cycleId, requestDigest) {
  const direct = await cycleRepository.readChainTransactionAttempt(cycleId, 'claim-process', requestDigest);
  if (direct !== null) return direct;
  const cycle = await cycleRepository.describeCycle(cycleId);
  const attempts = claimChainAttempts(cycle);
  if (attempts.length > 1) throw new Error('claim-process refuses multiple chain attempts for one cycle');
  const existing = attempts[0] ?? null;
  if (existing !== null && existing.attempt.requestDigest !== requestDigest) {
    throw new Error('claim-process refuses an unresolved chain attempt with a different request digest');
  }
  return existing;
}

export async function mutateClaimProcess({
  liveMode,
  adapters,
  signerClient,
  config,
  cycleRepository,
  context,
  request,
  preflightAuthority,
}) {
  if (liveMode !== true) throw new Error('claim-process mutate reached without live mode');
  if (!adapters?.robinhood?.client || typeof adapters.robinhood.client.sendRawTransaction !== 'function') {
    throw new Error('claim-process requires a Robinhood raw-transaction broadcaster');
  }
  if (!signerClient?.evm || typeof signerClient.evm.sign !== 'function') {
    throw new Error('claim-process requires an Operations EVM signer');
  }
  if (typeof context?.requestDigest !== 'string') throw new Error('claim-process requires the durable request digest');
  const configured = assertClaimConfiguration(config);
  const money = assertClaimMoneyConfiguration(config, configured);
  const canonicalRequest = await prepareClaimProcessRequest({ config, cycleRepository, context });
  assertCanonicalClaimRequest(request, canonicalRequest);
  const walletReservation = await reserveClaimWalletNonce({ cycleRepository, context, configured });
  let record = await readExistingClaimAttempt(cycleRepository, context.cycleId, context.requestDigest);
  if (record === null) {
    await cycleRepository.prepareChainTransactionAttempt(
      context.cycleId,
      'claim-process',
      createPreparedChainTransactionAttempt({
        cycleId: context.cycleId,
        stage: 'claim-process',
        requestDigest: context.requestDigest,
      }),
    );
    record = await cycleRepository.readChainTransactionAttempt(context.cycleId, 'claim-process', context.requestDigest);
  }
  if (!record) throw new Error('claim-process chain attempt was not persisted before signing');
  const chainRequestDigest = record.attempt.requestDigest;

  if (record.attempt.state === 'PREPARED') {
    await assertClaimWalletNonce({ cycleRepository, context, reservation: walletReservation });
    const transaction = await prepareClaimTransaction({
      adapters,
      configured,
      call: canonicalRequest.call,
      money,
    });
    const approved = await claimTransactionPolicy({
      request: canonicalRequest,
      transaction,
      requestDigest: chainRequestDigest,
      configured,
    });
    await assertClaimWalletNonce({ cycleRepository, context, reservation: walletReservation });
    requireClaimMutationAuthority(preflightAuthority);
    // After the authority check, which needs no network, and still before any signer call.
    await assertClaimStillCoveredByHookLiability({ adapters, configured, context, request });
    const signed = await signerClient.evm.sign({
      transaction: approved.transaction,
      transactionPolicy: approved.policy,
      transactionPolicyRules: approved.policyRules,
      transactionDecodeOptions: Object.freeze({}),
      liveMode: true,
    });
    const material = await signingMaterialForClaim(signed?.signedTx, {
      transaction: approved.transaction,
      call: canonicalRequest.call,
      configured,
    });
    record = await cycleRepository.recordSignedTransaction(
      context.cycleId,
      'claim-process',
      chainRequestDigest,
      material,
    );
  }

  if (record.attempt.state === 'SIGNED') {
    const material = await signingMaterialForClaim(record.attempt.rawBytes, {
      call: canonicalRequest.call,
      configured,
    });
    assertChainAttemptHash(record.attempt, material.hash);
    await assertClaimWalletNonce({ cycleRepository, context, reservation: walletReservation });
    requireClaimMutationAuthority(preflightAuthority);
    const transactionHash = await sendRawTransaction(adapters.robinhood.client, record.attempt.rawBytes);
    if (typeof transactionHash !== 'string' || transactionHash.toLowerCase() !== record.attempt.hash.toLowerCase()) {
      throw new Error('claim-process broadcaster returned a hash that does not match the persisted signed bytes');
    }
    record = await cycleRepository.recordBroadcast(
      context.cycleId,
      'claim-process',
      chainRequestDigest,
      Object.freeze({ transactionHash: record.attempt.hash }),
    );
  }

  if (!['BROADCAST', 'FINALIZED'].includes(record.attempt.state)) {
    throw new Error(`claim-process chain attempt is in unexpected state ${record.attempt.state}`);
  }
  return Object.freeze({
    transactionHash: record.attempt.hash,
    chainAttemptState: record.attempt.state,
  });
}

/**
 * Reconciles a previously persisted claim broadcast. A finalized revert is terminal: Operations
 * must inspect capacity or liability evidence and prepare a new owner-authorized cycle, never
 * retry the same claimed cycle identifier.
 */
/**
 * Last veto before a signature: re-read the hook's liability and claim controls, and let the
 * canonical claim call itself be estimated.
 *
 * This may only refuse. It never raises the admitted amount, reprices, or mints a new quote or cycle
 * identity -- the persisted admission stays immutable, and a snapshot that has dropped below it means
 * the cycle stops rather than adapts. The estimate is what catches state a getter cannot express,
 * notably a full active-entry ring (`ProcessClaimEntryLimitReached`), and it runs before any signer
 * call so a refusal costs no signature.
 *
 * Absent capability is not silent success: if neither the archive state read nor the estimate is
 * available, the claim refuses.
 */
async function assertClaimStillCoveredByHookLiability({ adapters, configured, context, request }) {
  const publicClient = adapters?.robinhood?.client ?? null;
  const archive = adapters?.robinhood?.historicalEvidenceClient ?? null;
  if (publicClient === null || typeof archive?.readHookProcessStateAtBlock !== 'function') {
    throw new Error('claim-process requires finalized hook process-liability evidence before signing');
  }
  const amount = BigInt(request.amount.amountAtomic);
  const onchainCycleId = deriveOnchainCycleId(context.cycleId);
  const finalized = await readFinalizedBlock(publicClient);
  const state = await archive.readHookProcessStateAtBlock({
    hook: configured.hook,
    onchainCycleId,
    blockNumber: finalized.number,
    blockHash: finalized.hash,
  });
  // The archive read binds its values to `finalized.hash`, but the archive itself could sit behind a
  // reorg the public chain has already abandoned. Re-reading the same height from the public client
  // now -- after the archive read, before any control check, estimate, or signer call -- catches that
  // window instead of signing off a hash the canonical chain no longer reports.
  const recheck = await readBlockByNumber(publicClient, finalized.number);
  if (recheck.hash?.toLowerCase() !== state.blockHash) {
    throw new Error('claim-process refuses to sign: the public finalized block hash changed after the archive read');
  }
  if (state.processClaimsPaused) throw new Error('claim-process refuses to sign while hook process claims are paused');
  if (state.processClaimCycleUsed) throw new Error('claim-process refuses to sign a cycle the hook already claimed');
  if (!state.isSolvent) throw new Error('claim-process refuses to sign while the hook is not solvent');
  if (state.operations !== configured.operations.toLowerCase()) {
    throw new Error('claim-process refuses to sign against a changed hook Operations role');
  }
  if (amount > state.processLiability || amount > state.remainingProcessClaimCapacity) {
    throw new Error('claim-process refuses to sign: the admitted amount is no longer covered by hook liability and capacity');
  }
  // The canonical call, estimated as Operations would send it. A revert here is a refusal.
  if (typeof publicClient.estimateContractGas === 'function') {
    await publicClient.estimateContractGas({
      address: configured.hook,
      abi: HOOK_ABI,
      functionName: 'claimProcess',
      args: [onchainCycleId, amount, configured.operations],
      account: configured.operations,
    });
  }
}

function claimChainAttempts(cycle) {
  const entries = cycle?.chainAttempts instanceof Map ? [...cycle.chainAttempts.values()] : [];
  return entries.filter(record => record?.attempt?.stage === 'claim-process');
}

function claimEvent(receipt, { hook, onchainCycleId, destination, amountAtomic }) {
  const matches = [];
  for (const log of receipt.logs ?? []) {
    if (!equalAddress(log?.address, hook)) continue;
    try {
      const decoded = decodeEventLog({ abi: CLAIM_EVENT_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'ProcessClaimed') continue;
      if (decoded.args.cycleId?.toLowerCase() !== onchainCycleId.toLowerCase()
        || !equalAddress(decoded.args.destination, destination)
        || decoded.args.amountAtomicUsdg !== BigInt(amountAtomic)) {
        continue;
      }
      matches.push(decoded);
    } catch {
      // A hook receipt may carry other events; only the exact ProcessClaimed event is evidence.
    }
  }
  if (matches.length !== 1) {
    throw new Error('claim-process receipt does not contain exactly one canonical ProcessClaimed event');
  }
  return matches[0];
}

function claimCustodyAsset(configured) {
  const chainId = `eip155:${configured.chainId}`;
  return Object.freeze({
    chainId,
    assetId: `${chainId}/erc20:${configured.usdg.toLowerCase()}`,
    decimals: USDG_DECIMALS,
  });
}

/**
 * The legacy, pre-canonical row identity for this same configured EVM USDG asset: a raw
 * `(chainId, address)` pair (no `eip155:`/`erc20:` CAIP wrapping), the same raw shape
 * `returnSettlementCustodyLedger` keys its own row by (ADR-0026). This claim writer has always used
 * the canonical CAIP identity from `claimCustodyAsset` -- it never produced this raw key itself --
 * but `custodyLedgerKey` is an exact string match, so a row already durable under this raw key for
 * this asset is invisible to a canonical-only lookup. Derived only from `assertClaimConfiguration`
 * output, matching `claimCustodyAsset`'s own trusted inputs exactly.
 */
function legacyRawClaimCustodyKey(configured) {
  return `${String(configured.chainId)}${String.fromCharCode(0)}${configured.usdg.toLowerCase()}`;
}

/**
 * ADR-0026's dedicated EVM USDG `CustodyBalanceObservationV1` producer, invoked at the moment this
 * writer records a v2 row for the claim key. `identity` is built only from `assertClaimConfiguration`
 * output (`asset`, already the canonical CAIP identity `claimCustodyAsset` derives, plus the
 * configured Operations address) -- never from any RPC response or candidate evidence. Reuses the
 * public-finalized-head -> distinct-archive-read-at-that-height/hash -> public-same-height-recheck
 * discipline `createEvmCustodyBalanceObservationReader` already owns; this function neither reads
 * chain state directly nor claims causal provenance for the claim -- that authority is the already
 * -verified canonical transaction/event/credit this is only ever called after.
 */
async function observeClaimCustodyBalance({ adapters, configured, asset }) {
  const observeBalance = createEvmCustodyBalanceObservationReader({
    publicClient: adapters?.robinhood?.client ?? null,
    archiveClient: adapters?.robinhood?.historicalEvidenceClient ?? null,
    identity: {
      chainId: asset.chainId,
      assetId: asset.assetId,
      decimals: asset.decimals,
      account: String(configured.operations).toLowerCase(),
    },
  });
  return observeBalance();
}

async function recordClaimCustodyLedger(cycleRepository, cycle, request, configured, adapters) {
  if (typeof cycleRepository?.recordCustodyLedger !== 'function') {
    throw new Error('claim-process requires custody-ledger persistence before finality');
  }
  // Refuse before any balance read or custody write -- and before finality ever advances -- if a
  // durable legacy raw-identity row for this same configured asset exists at all, regardless of its
  // bucket values (an all-zero row, or the common historical-return shape of claimed='0' with a
  // nonzero returnReceived, is exactly as ambiguous as a nonzero claimed row: the identity split
  // itself is the problem, not any one bucket), and whether or not a canonical row also already
  // coexists. This is detection only: no bucket is copied or aliased across the two keys, no row is
  // touched or migrated, and the already-legitimate canonical v1-to-v2 upgrade path is unaffected
  // when no such row exists.
  const legacyRawRow = cycle?.custodyLedgers?.get?.(legacyRawClaimCustodyKey(configured)) ?? null;
  if (legacyRawRow !== null) {
    throw new Error('claim-process refuses: a legacy raw-identity custody row exists for this asset, an unresolved raw/canonical identity conflict; resolve it before any canonical custody write or finality advancement');
  }
  const asset = claimCustodyAsset(configured);
  const key = `${asset.chainId}\u0000${asset.assetId}`;
  const existing = cycle?.custodyLedgers?.get?.(key) ?? null;
  const amountAtomic = request.amount.amountAtomic;
  if (existing !== null) {
    if (existing.cycleId !== request.cycleId
      || existing.chainId !== asset.chainId
      || existing.assetId !== asset.assetId
      || existing.decimals !== asset.decimals) {
      throw new Error('claim-process existing custody ledger does not match the finalized USDG credit');
    }
    if (existing.claimed !== '0' && existing.claimed !== amountAtomic) {
      throw new Error('claim-process existing custody ledger has a conflicting claimed amount');
    }
  }
  // The observation is fetched, and can refuse, before any write -- a missing/drifted/malformed
  // read never reaches `recordCustodyLedger` and never advances finality (both callers only proceed
  // to `recordFinality` after this resolves).
  const verifiedCurrentBalance = await observeClaimCustodyBalance({ adapters, configured, asset });
  const buckets = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => [
    bucket,
    bucket === 'claimed' ? amountAtomic : (existing?.[bucket] ?? '0'),
  ]));
  // ADR-0026: only the dedicated return-leg writers may populate or clear `expectedCycleAsset`; this
  // generic claim writer must carry an existing v2 row's value forward unchanged, never null it out
  // from under an in-flight return expectation.
  const expectedCycleAsset = existing?.schema === 'hookemon.custody-ledger.v2' ? existing.expectedCycleAsset : null;
  await cycleRepository.recordCustodyLedger(
    request.cycleId,
    Object.freeze({
      schema: 'hookemon.custody-ledger.v2',
      cycleId: request.cycleId,
      ...asset,
      ...buckets,
      verifiedCurrentBalance,
      expectedCycleAsset,
    }),
  );
}

function assertCanonicalClaimTransactionValue(transaction, transactionHash, request, configured) {
  const input = transaction?.input ?? transaction?.data;
  if (transaction?.hash?.toLowerCase() !== transactionHash.toLowerCase()
    || !equalAddress(transaction?.from, configured.operations)
    || !equalAddress(transaction?.to, request.call.to)
    || input !== request.call.data
    || BigInt(transaction?.value ?? '-1') !== 0n) {
    throw new Error('claim-process transaction does not match the canonical claim intent');
  }
}

async function assertCanonicalClaimTransaction(client, transactionHash, request, configured) {
  assertCanonicalClaimTransactionValue(
    await readTransaction(client, transactionHash),
    transactionHash,
    request,
    configured,
  );
}

export async function reconcileLiveClaimProcess({ adapters, config, cycleRepository, context }) {
  const cycle = await cycleRepository.describeCycle(context.cycleId);
  const attempts = claimChainAttempts(cycle);
  if (attempts.length === 0) return null;
  if (attempts.length !== 1) throw new Error('claim-process refuses multiple chain attempts for one cycle');
  let chain = attempts[0];
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context });
  const configured = assertClaimConfiguration(config);
  if (chain.attempt.state === 'FINALIZED') {
    await recordClaimCustodyLedger(cycleRepository, cycle, request, configured, adapters);
    await releaseClaimWalletNonce({ cycleRepository, context, configured });
    return Object.freeze(chain.finalityEvidence);
  }
  if (!adapters?.robinhood?.client) return null;
  if (chain.attempt.state === 'PREPARED') return null;
  if (!['SIGNED', 'BROADCAST'].includes(chain.attempt.state)) {
    throw new Error(`claim-process chain attempt is in unexpected state ${chain.attempt.state}`);
  }
  const transactionHash = chain.attempt.hash;
  if (typeof transactionHash !== 'string') throw new Error('claim-process broadcast has no transaction hash');
  if (chain.attempt.state === 'SIGNED') {
    const material = await signingMaterialForClaim(chain.attempt.rawBytes, {
      call: request.call,
      configured,
    });
    assertChainAttemptHash(chain.attempt, material.hash);
    let transaction;
    try {
      transaction = await readTransaction(adapters.robinhood.client, transactionHash);
    } catch {
      return null;
    }
    if (transaction === null || transaction === undefined) return null;
    assertCanonicalClaimTransactionValue(transaction, transactionHash, request, configured);
    chain = await cycleRepository.recordBroadcast(
      context.cycleId,
      'claim-process',
      chain.attempt.requestDigest,
      Object.freeze({ transactionHash }),
    );
  }
  if (chain.attempt.state !== 'BROADCAST') return null;
  let observation;
  try {
    observation = await readFinalizedTransactionReceipt(adapters.robinhood.client, transactionHash);
  } catch (error) {
    if (error instanceof RobinhoodMalformedResponseError) throw error;
    return null;
  }
  if (!observation.finalized) return null;
  if (typeof observation.receipt?.transactionHash !== 'string'
    || observation.receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new Error(`claimProcess receipt reports a different transaction hash than ${transactionHash}`);
  }
  if (!receiptSucceeded(observation.receipt.status)) {
    throw new StageMutationRevertedError(
      'claim-process',
      `claimProcess transaction ${transactionHash} reverted on-chain`,
      {
        transactionHash,
        receiptStatus: observation.receipt.status,
        terminalOutcome: 'CLAIM_REVERTED',
        retryable: false,
      },
    );
  }
  await assertCanonicalClaimTransaction(adapters.robinhood.client, transactionHash, request, configured);
  claimEvent(observation.receipt, {
    hook: configured.hook,
    onchainCycleId: request.onchainCycleId,
    destination: request.destination,
    amountAtomic: request.amount.amountAtomic,
  });
  const credit = await readFinalizedErc20TransferCredit(adapters.robinhood.client, {
    hash: transactionHash,
    token: configured.usdg,
    recipient: configured.operations,
  });
  const matchingTransfers = credit.transfers.filter(transfer => equalAddress(transfer.from, configured.hook)
    && transfer.amountAtomic === request.amount.amountAtomic);
  if (!credit.finalized || credit.successful !== true || matchingTransfers.length !== 1 || credit.transfers.length !== 1) {
    throw new Error('claim-process receipt does not prove one exact USDG credit from the hook to Operations');
  }
  const evidence = Object.freeze({
    transactionHash,
    finalized: true,
    finalizedBlockNumber: observation.finalizedBlockNumber.toString(),
    finalizedBlockHash: observation.receipt.blockHash.toLowerCase(),
    receiptStatus: observation.receipt.status,
    claimedAmountAtomic: request.amount.amountAtomic,
    destination: request.destination,
  });
  await recordClaimCustodyLedger(cycleRepository, cycle, request, configured, adapters);
  await cycleRepository.recordFinality(context.cycleId, 'claim-process', chain.attempt.requestDigest, evidence);
  await releaseClaimWalletNonce({ cycleRepository, context, configured });
  return evidence;
}
