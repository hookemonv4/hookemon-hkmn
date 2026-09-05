import {
  ComputeBudgetProgram,
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import {
  CANONICAL_TRANSACTION_POLICY_SCHEMA,
  CANONICAL_TRANSACTION_POLICY_VERSION,
  assertCanonicalTransactionPolicy as assertRunnerCanonicalTransactionPolicy,
} from '../../../runner/src/cycle/transaction-policy-schema.mjs';
import { digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';

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

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();
const DECODE_SCHEMA = 'hookemon.transaction-policy.decode.v1';
export const TRANSACTION_POLICY_SCHEMA = CANONICAL_TRANSACTION_POLICY_SCHEMA;
export const TRANSACTION_POLICY_VERSION = CANONICAL_TRANSACTION_POLICY_VERSION;
export { CANONICAL_TRANSACTION_POLICY_SCHEMA, CANONICAL_TRANSACTION_POLICY_VERSION };
const policyRuleSidecars = new WeakMap();
const SUPPORTED_EVM_TRANSACTION_TYPES = new Set(['legacy', 'eip1559']);
const UNSUPPORTED_EVM_TYPED_FIELDS = [
  'accessList',
  'authorizationList',
  'maxFeePerBlobGas',
  'blobVersionedHashes',
  'blobs',
  'kzgCommitments',
  'kzgProofs',
  'sidecars',
];
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const RULE_FIELDS = [
  'id',
  'family',
  'format',
  'chainId',
  'nonce',
  'programIds',
  'addressLookupTables',
  'target',
  'selector',
  'source',
  'destination',
  'mint',
  'token',
  'amount',
  'nativeValue',
  'gas',
  'feePayer',
  'requiredSigners',
  'coSigners',
  'instructions',
  'extraInstructions',
  'blockhash',
  'deadline',
  'priorityFee',
];
const INSTRUCTION_RULE_FIELDS = [
  'kind',
  'programId',
  'instructionId',
  'data',
  'accounts',
  'source',
  'destination',
  'mint',
  'token',
  'amount',
  'nativeValue',
  'computeUnitLimit',
  'priorityFee',
];
const SEMANTIC_DATA_KINDS = new Set([
  'compute-budget-set-unit-limit',
  'compute-budget-set-unit-price',
  'erc20-transfer',
  'spl-transfer-checked',
  'system-transfer',
]);

export class TransactionPolicyError extends Error {}

function fail(message) {
  throw new TransactionPolicyError(message);
}

/** Validates the runner-owned policy envelope before adapter details are evaluated. */
export function assertCanonicalTransactionPolicy(value, label = 'canonical transaction policy') {
  try {
    return assertRunnerCanonicalTransactionPolicy(value, label);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

function explicitRules(rules, label = 'transaction policy rules') {
  if (!Array.isArray(rules) || rules.length === 0) fail(`${label} must contain at least one explicit rule`);
  return frozenClone(rules);
}

/**
 * Binds adapter-only decoded-transaction rules beside, never inside, the runner-owned policy
 * envelope. The canonical policy remains the only policy object that crosses signing boundaries.
 */
export function createTransactionPolicy({ policy, rules }) {
  const canonicalPolicy = frozenClone(assertCanonicalTransactionPolicy(policy, 'transaction policy'));
  const frozenRules = explicitRules(rules);
  policyRuleSidecars.set(canonicalPolicy, frozenRules);
  return canonicalPolicy;
}

/** Validates a canonical policy together with its adapter-only, non-wire rule sidecar. */
export function bindTransactionPolicy(policy, rules = undefined) {
  const binding = policy !== null && typeof policy === 'object' && !Array.isArray(policy)
    && Object.keys(policy).length === 2 && Object.hasOwn(policy, 'policy') && Object.hasOwn(policy, 'rules')
    ? policy
    : { policy, rules: rules ?? policyRuleSidecars.get(policy) };
  const canonicalPolicy = frozenClone(assertCanonicalTransactionPolicy(binding.policy, 'transaction policy'));
  const frozenRules = explicitRules(binding.rules);
  policyRuleSidecars.set(canonicalPolicy, frozenRules);
  return Object.freeze({ policy: canonicalPolicy, rules: frozenRules });
}

/** Reads the non-wire rule sidecar for an in-process canonical policy. */
export function readTransactionPolicyRules(policy) {
  const rules = policyRuleSidecars.get(policy);
  if (rules === undefined) fail('transaction policy has no adapter rule sidecar');
  return rules;
}

/** Creates the runner-owned canonical policy from one decoded transaction and its stage. */
export function createCanonicalTransactionPolicy({
  decoded,
  stage,
  requestDigest = canonicalDigest({
    schema: 'hookemon.transaction-policy-request.v1',
    stage,
    decoded,
  }),
  expectedRecipient = decoded?.destination ?? decoded?.feePayer,
  amount = decoded?.amount ?? decoded?.nativeValue ?? {
    chainId: decoded?.chainId,
    assetId: 'native',
    decimals: decoded?.family === 'solana' ? 9 : 18,
    amountAtomic: '0',
  },
  allowedTargets = decoded?.target === null ? [] : [decoded?.target],
  allowedPrograms = decoded?.programIds,
}) {
  decodedDescription(decoded);
  return frozenClone(assertCanonicalTransactionPolicy({
    schema: TRANSACTION_POLICY_SCHEMA,
    chainId: decoded.chainId,
    stage,
    requestDigest,
    expectedRecipient,
    amount,
    allowedTargets,
    allowedPrograms,
  }, 'transaction policy'));
}

function decimalString(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    fail(`${label} must be an integer`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    fail(`${label} must not be an unsafe JavaScript number`);
  }
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) fail(`${label} must not be negative`);
    return parsed.toString();
  } catch (error) {
    if (error instanceof TransactionPolicyError) throw error;
    fail(`${label} must be an integer`);
  }
}

function assetAmount({ chainId, assetId, decimals, amountAtomic }) {
  if (typeof chainId !== 'string' || chainId.length === 0) fail('amount chainId must be a non-empty string');
  if (typeof assetId !== 'string' || assetId.length === 0) fail('amount assetId must be a non-empty string');
  if (!Number.isInteger(decimals) || decimals < 0) fail('asset decimals must be a non-negative integer');
  return Object.freeze({
    chainId,
    assetId,
    decimals,
    amountAtomic: decimalString(amountAtomic, 'amountAtomic'),
  });
}

function normalizeEvmAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) fail(`${label} must be a valid EVM address`);
  return getAddress(value).toLowerCase();
}

function normalizeAssetId(value) {
  return isAddress(value) ? normalizeEvmAddress(value, 'assetId') : value;
}

function nativeAmount(chainId, amountAtomic, decimals = 18) {
  return assetAmount({ chainId, assetId: 'native', decimals, amountAtomic });
}

function optionalNativeAmount(chainId, value, decimals = 18) {
  if (value === null || value === undefined) return null;
  return nativeAmount(chainId, value, decimals);
}

function solanaComputeUnitPrice(chainId, microLamports) {
  return assetAmount({
    chainId,
    assetId: 'microlamports-per-compute-unit',
    decimals: 0,
    amountAtomic: microLamports,
  });
}

function tokenMetadataFor(input, token) {
  if (!input.tokenMetadata || typeof input.tokenMetadata !== 'object' || Array.isArray(input.tokenMetadata)) {
    fail('ERC-20 transfer decoding requires explicit tokenMetadata');
  }
  const entry = Object.entries(input.tokenMetadata)
    .find(([address]) => normalizeEvmAddress(address, 'tokenMetadata address') === token)?.[1];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`missing tokenMetadata for ${token}`);
  const assetId = typeof entry.assetId === 'string' && entry.assetId.length > 0
    ? normalizeAssetId(entry.assetId)
    : token;
  return { assetId, decimals: entry.decimals };
}

function normalizedEvmData(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) fail('EVM transaction data must be hex');
  return value.toLowerCase();
}

async function readEvmTransaction(input) {
  if (typeof input.transaction === 'string') {
    const serializedTransaction = input.transaction;
    let parsed;
    let source;
    try {
      parsed = parseTransaction(serializedTransaction);
      source = await recoverTransactionAddress({ serializedTransaction });
    } catch (error) {
      fail(`EVM raw transaction could not be decoded and recovered: ${error.message}`);
    }
    return { ...parsed, from: source };
  }
  if (!input.transaction || typeof input.transaction !== 'object' || Array.isArray(input.transaction)) {
    fail('EVM transaction must be a viem-decodable raw transaction or an unsigned transaction object');
  }
  return input.transaction;
}

function assertSupportedEvmTransaction(transaction) {
  if (transaction.type !== undefined && !SUPPORTED_EVM_TRANSACTION_TYPES.has(transaction.type)) {
    fail(`transaction policy decoder does not support EVM transaction type ${String(transaction.type)}`);
  }
  for (const field of UNSUPPORTED_EVM_TYPED_FIELDS) {
    if (Object.hasOwn(transaction, field)) {
      fail(`transaction policy decoder does not support EVM typed transaction field ${field}`);
    }
  }
}

function assertSafeEvmAtomicInputs(transaction) {
  for (const field of ['chainId', 'nonce', 'value', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    if (typeof transaction[field] === 'number' && !Number.isSafeInteger(transaction[field])) {
      fail(`EVM transaction ${field} must not be an unsafe JavaScript number`);
    }
  }
}

function decodeErc20Transfer({ input, chainId, target, source, data, gas, transaction }) {
  let call;
  try {
    call = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data });
  } catch {
    fail('EVM ERC-20 transfer calldata is malformed');
  }
  const canonicalData = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: call.args,
  }).toLowerCase();
  if (canonicalData !== data) fail('EVM ERC-20 transfer calldata contains unapproved trailing data');

  const destination = normalizeEvmAddress(call.args[0], 'ERC-20 transfer destination');
  const metadata = tokenMetadataFor(input, target);
  const amount = assetAmount({
    chainId,
    assetId: metadata.assetId,
    decimals: metadata.decimals,
    amountAtomic: call.args[1],
  });
  const nativeValue = nativeAmount(chainId, transaction.value ?? 0);
  const instruction = Object.freeze({
    kind: 'erc20-transfer',
    programId: target,
    instructionId: '0xa9059cbb',
    data,
    accounts: Object.freeze([]),
    source,
    destination,
    mint: target,
    token: target,
    amount,
    nativeValue,
    computeUnitLimit: null,
    priorityFee: null,
  });
  return { destination, mint: target, token: target, amount, nativeValue, instruction, gas };
}

async function decodeEvmTransaction(input) {
  const transaction = await readEvmTransaction(input);
  assertSupportedEvmTransaction(transaction);
  assertSafeEvmAtomicInputs(transaction);
  const chainId = decimalString(transaction.chainId, 'EVM chainId');
  if (input.chainId !== undefined && decimalString(input.chainId, 'decoder EVM chainId') !== chainId) {
    fail('decoder EVM chainId does not match the transaction chainId');
  }
  const target = normalizeEvmAddress(transaction.to, 'EVM transaction target');
  const source = transaction.from === undefined || transaction.from === null
    ? null
    : normalizeEvmAddress(transaction.from, 'EVM transaction source');
  const nonce = transaction.nonce === undefined ? null : decimalString(transaction.nonce, 'EVM nonce');
  const data = normalizedEvmData(transaction.data ?? '0x');
  const selector = data.length >= 10 ? data.slice(0, 10) : null;
  const gas = Object.freeze({
    limit: transaction.gas === undefined ? null : decimalString(transaction.gas, 'EVM gas limit'),
    gasPrice: optionalNativeAmount(chainId, transaction.gasPrice),
    maxFeePerGas: optionalNativeAmount(chainId, transaction.maxFeePerGas),
    maxPriorityFeePerGas: optionalNativeAmount(chainId, transaction.maxPriorityFeePerGas),
  });
  const isErc20Transfer = selector === '0xa9059cbb';
  const decoded = isErc20Transfer
    ? decodeErc20Transfer({ input, chainId, target, source, data, gas, transaction })
    : (() => {
      const nativeValue = nativeAmount(chainId, transaction.value ?? 0);
      return {
        destination: target,
        mint: null,
        token: null,
        amount: null,
        nativeValue,
        instruction: Object.freeze({
          kind: 'evm-call',
          programId: target,
          instructionId: selector,
          data,
          accounts: Object.freeze([]),
          source,
          destination: target,
          mint: null,
          token: null,
          amount: null,
          nativeValue,
          computeUnitLimit: null,
          priorityFee: null,
        }),
      };
    })();

  return Object.freeze({
    schema: DECODE_SCHEMA,
    family: 'evm',
    format: 'evm',
    chainId,
    nonce,
    programIds: Object.freeze([target]),
    addressLookupTables: Object.freeze([]),
    target,
    selector,
    source,
    destination: decoded.destination,
    mint: decoded.mint,
    token: decoded.token,
    amount: decoded.amount,
    nativeValue: decoded.nativeValue,
    gas,
    feePayer: source,
    requiredSigners: Object.freeze(source === null ? [] : [source]),
    coSigners: Object.freeze([]),
    instructions: Object.freeze([decoded.instruction]),
    extraInstructions: Object.freeze([]),
    blockhash: null,
    deadline: transaction.deadline ?? null,
    priorityFee: gas.maxPriorityFeePerGas,
  });
}

function instructionId(data) {
  return data.length === 0 ? 'none' : `0x${data.subarray(0, 1).toString('hex')}`;
}

function decodeSolanaInstruction({ chainId, programId, accounts, data }) {
  const base = {
    kind: 'unknown',
    programId,
    instructionId: instructionId(data),
    data: data.toString('base64'),
    accounts: Object.freeze(accounts),
    source: null,
    destination: null,
    mint: null,
    token: null,
    amount: null,
    nativeValue: null,
    computeUnitLimit: null,
    priorityFee: null,
  };
  if (programId === COMPUTE_BUDGET_PROGRAM_ID && data.length === 5 && data.readUInt8(0) === 2) {
    return Object.freeze({ ...base, kind: 'compute-budget-set-unit-limit', instructionId: 'set-compute-unit-limit', computeUnitLimit: String(data.readUInt32LE(1)) });
  }
  if (programId === COMPUTE_BUDGET_PROGRAM_ID && data.length === 9 && data.readUInt8(0) === 3) {
    const priorityFee = solanaComputeUnitPrice(chainId, data.readBigUInt64LE(1));
    return Object.freeze({ ...base, kind: 'compute-budget-set-unit-price', instructionId: 'set-compute-unit-price', priorityFee });
  }
  if (TOKEN_PROGRAM_IDS.has(programId) && data.length === 10 && data.readUInt8(0) === 12 && accounts.length >= 4) {
    const [source, mint, destination] = accounts.map(account => account.address);
    const amount = assetAmount({
      chainId,
      assetId: mint,
      decimals: data.readUInt8(9),
      amountAtomic: data.readBigUInt64LE(1),
    });
    return Object.freeze({
      ...base,
      kind: 'spl-transfer-checked',
      instructionId: 'transfer-checked',
      source,
      destination,
      mint,
      token: mint,
      amount,
    });
  }
  if (programId === SYSTEM_PROGRAM_ID && data.length === 12 && data.readUInt32LE(0) === 2 && accounts.length >= 2) {
    const source = accounts[0].address;
    const destination = accounts[1].address;
    const nativeValue = nativeAmount(chainId, data.readBigUInt64LE(4), 9);
    return Object.freeze({
      ...base,
      kind: 'system-transfer',
      instructionId: 'transfer',
      source,
      destination,
      amount: nativeValue,
      nativeValue,
    });
  }
  return Object.freeze(base);
}

function fullSignedSolanaTransaction(transactionBase64) {
  if (typeof transactionBase64 !== 'string' || transactionBase64.length === 0) {
    fail('signed Solana message must provide a non-empty base64 transaction');
  }
  try {
    return VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  } catch (error) {
    fail(`signed Solana message must be a complete serialized transaction: ${error.message}`);
  }
}

function signatureIsNonzero(signature) {
  return signature instanceof Uint8Array && signature.length === 64 && signature.some(byte => byte !== 0);
}

function ed25519PublicKey(address) {
  let bytes;
  try {
    bytes = new PublicKey(address).toBytes();
  } catch (error) {
    fail(`Solana required signer ${address} is not a valid public key: ${error.message}`);
  }
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bytes)]),
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    fail(`Solana required signer ${address} could not be used for signature verification: ${error.message}`);
  }
}

function assertSolanaSignatureSlots(transaction, { expectedCoSignerSignatures, firstRequiredSlot = 0 } = {}) {
  const required = transaction.message.header.numRequiredSignatures;
  if (!Array.isArray(transaction.signatures) || transaction.signatures.length !== required) {
    fail('signed Solana transaction does not contain every required signature slot');
  }
  const serializedMessage = Buffer.from(transaction.message.serialize());
  for (let index = firstRequiredSlot; index < required; index += 1) {
    const signature = transaction.signatures[index];
    if (!signatureIsNonzero(signature)) {
      fail(`signed Solana transaction required signature slot ${index} is missing or zero`);
    }
    const signer = transaction.message.staticAccountKeys[index]?.toBase58();
    if (!signer) fail(`signed Solana transaction required signer ${index} was not resolved`);
    let valid;
    try {
      valid = verifySignature(null, serializedMessage, ed25519PublicKey(signer), Buffer.from(signature));
    } catch (error) {
      fail(`signed Solana transaction required signature slot ${index} could not be verified: ${error.message}`);
    }
    if (!valid) fail(`signed Solana transaction required signature slot ${index} is invalid`);
  }
  if (expectedCoSignerSignatures === undefined) return;
  if (!Array.isArray(expectedCoSignerSignatures) || expectedCoSignerSignatures.length !== Math.max(0, required - 1)) {
    fail('expected Solana co-signer signatures do not match the required signature slots');
  }
  for (let index = 1; index < required; index += 1) {
    const expected = expectedCoSignerSignatures[index - 1];
    if (typeof expected !== 'string') fail('expected Solana co-signer signatures must be base64 strings');
    if (!Buffer.from(transaction.signatures[index]).equals(Buffer.from(expected, 'base64'))) {
      fail(`signed Solana co-signer signature slot ${index} changed after approval`);
    }
  }
}

/** Captures existing co-signer signatures before the operator signs a provider transaction. */
export function captureSolanaCoSignerSignatures(transactionBase64) {
  const transaction = fullSignedSolanaTransaction(transactionBase64);
  const required = transaction.message.header.numRequiredSignatures;
  if (required <= 1) return Object.freeze([]);
  assertSolanaSignatureSlots(transaction, { firstRequiredSlot: 1 });
  return Object.freeze(transaction.signatures.slice(1).map(signature => Buffer.from(signature).toString('base64')));
}

async function resolveAddressLookupTables(message, input) {
  if (!message.addressTableLookups?.length) return [];
  const resolve = typeof input.lookupTableResolver === 'function'
    ? input.lookupTableResolver
    : input.lookupTableRpc?.getAddressLookupTable?.bind(input.lookupTableRpc);
  if (typeof resolve !== 'function') fail('Solana v0 transaction requires an injected read-only address lookup table resolver');
  const tables = [];
  for (const lookup of message.addressTableLookups) {
    let result;
    try {
      result = await resolve(lookup.accountKey, { commitment: 'finalized' });
    } catch (error) {
      fail(`could not resolve address lookup table ${lookup.accountKey.toBase58()}: ${error.message}`);
    }
    const table = result?.value ?? result;
    if (!table?.key || !table?.state?.addresses || !table.key.equals?.(lookup.accountKey)) {
      fail(`address lookup table ${lookup.accountKey.toBase58()} was missing or did not match the requested key`);
    }
    if (typeof table.isActive !== 'function' || table.isActive() !== true) {
      fail(`address lookup table ${lookup.accountKey.toBase58()} is inactive`);
    }
    tables.push(table);
  }
  return tables;
}

async function resolveSolanaBlockhashContext(message, input) {
  if (input.blockhashContextResolver === undefined) return input;
  if (typeof input.blockhashContextResolver !== 'function') {
    fail('Solana blockhashContextResolver must be a function');
  }
  let context;
  try {
    context = await input.blockhashContextResolver(message.recentBlockhash);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    fail(`Solana blockhashContextResolver failed: ${messageText}`);
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('Solana blockhashContextResolver must return a blockhash and lastValidBlockHeight pair');
  }
  if (context.blockhash !== message.recentBlockhash) {
    fail('Solana blockhashContextResolver returned a blockhash that does not match the transaction');
  }
  return {
    ...input,
    lastValidBlockHeight: decimalString(context.lastValidBlockHeight, 'Solana blockhash context lastValidBlockHeight'),
  };
}

async function decodeSolanaTransaction(input) {
  if (typeof input.chainId !== 'string' || input.chainId.length === 0) fail('Solana decoder requires an explicit chainId');
  if (typeof input.transaction !== 'string' || input.transaction.length === 0) fail('Solana transaction must be a non-empty base64 string');
  const bytes = Buffer.from(input.transaction, 'base64');
  let message;
  let format;
  try {
    const transaction = VersionedTransaction.deserialize(bytes);
    message = transaction.message;
    format = transaction.version === 'legacy' ? 'legacy' : 'v0';
  } catch {
    try {
      message = VersionedMessage.deserialize(bytes);
      format = message.version === 'legacy' ? 'legacy' : 'v0';
    } catch (error) {
      fail(`Solana transaction or message could not be deserialized: ${error.message}`);
    }
  }
  input = await resolveSolanaBlockhashContext(message, input);
  const tables = await resolveAddressLookupTables(message, input);
  let accountKeys;
  try {
    accountKeys = message.getAccountKeys(tables.length ? { addressLookupTableAccounts: tables } : undefined);
  } catch (error) {
    fail(`Solana transaction account keys could not be resolved: ${error.message}`);
  }
  const keyAt = (index, label) => {
    const key = accountKeys.get(index);
    if (!key) fail(`Solana ${label} index ${index} was not resolved`);
    return key.toBase58();
  };
  const requiredSigners = Object.freeze(Array.from(
    { length: message.header.numRequiredSignatures },
    (_, index) => keyAt(index, 'required signer'),
  ));
  if (requiredSigners.length === 0) fail('Solana transaction has no fee payer signature slot');
  const instructions = Object.freeze(message.compiledInstructions.map((compiled, index) => {
    const programId = keyAt(compiled.programIdIndex, `instruction ${index} program`);
    const accounts = compiled.accountKeyIndexes.map(accountIndex => Object.freeze({
      address: keyAt(accountIndex, `instruction ${index} account`),
      isSigner: message.isAccountSigner(accountIndex),
      isWritable: message.isAccountWritable(accountIndex),
    }));
    return decodeSolanaInstruction({
      chainId: input.chainId,
      programId,
      accounts,
      data: Buffer.from(compiled.data),
    });
  }));
  const valueInstructions = instructions.filter(instruction => instruction.kind === 'spl-transfer-checked' || instruction.kind === 'system-transfer');
  const primary = valueInstructions.length === 1 ? valueInstructions[0] : null;
  const priorityFees = instructions.map(instruction => instruction.priorityFee).filter(Boolean);
  const computeUnitLimits = instructions.map(instruction => instruction.computeUnitLimit).filter(Boolean);
  const lastValidBlockHeight = input.lastValidBlockHeight === undefined
    ? null
    : decimalString(input.lastValidBlockHeight, 'Solana lastValidBlockHeight');
  const currentBlockHeight = input.currentBlockHeight === undefined
    ? null
    : decimalString(input.currentBlockHeight, 'Solana currentBlockHeight');
  const deadline = lastValidBlockHeight === null ? null : Object.freeze({
    type: 'block-height',
    lastValidBlockHeight,
    observedBlockHeight: currentBlockHeight,
    expired: currentBlockHeight === null ? null : BigInt(currentBlockHeight) > BigInt(lastValidBlockHeight),
  });

  return Object.freeze({
    schema: DECODE_SCHEMA,
    family: 'solana',
    format,
    chainId: input.chainId,
    nonce: null,
    programIds: Object.freeze([...new Set(instructions.map(instruction => instruction.programId))]),
    addressLookupTables: Object.freeze(message.addressTableLookups?.map(lookup => lookup.accountKey.toBase58()) ?? []),
    target: null,
    selector: null,
    source: primary?.source ?? null,
    destination: primary?.destination ?? null,
    mint: primary?.mint ?? null,
    token: primary?.token ?? null,
    amount: primary?.amount ?? null,
    nativeValue: primary?.nativeValue ?? null,
    gas: Object.freeze({
      computeUnitLimit: computeUnitLimits.length === 1 ? computeUnitLimits[0] : null,
      pricePerComputeUnit: priorityFees.length === 1 ? priorityFees[0] : null,
    }),
    feePayer: requiredSigners[0],
    requiredSigners,
    coSigners: Object.freeze(requiredSigners.slice(1)),
    instructions,
    extraInstructions: Object.freeze(primary ? instructions.filter(instruction => instruction !== primary) : instructions),
    blockhash: message.recentBlockhash,
    deadline,
    priorityFee: priorityFees.length === 1 ? priorityFees[0] : null,
  });
}

async function resolveSolanaCurrentBlockHeight(input) {
  if (input.currentBlockHeightResolver === undefined) return input;
  if (typeof input.currentBlockHeightResolver !== 'function') {
    fail('Solana currentBlockHeightResolver must be a function');
  }
  let currentBlockHeight;
  try {
    currentBlockHeight = await input.currentBlockHeightResolver();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Solana currentBlockHeightResolver failed: ${message}`);
  }
  if (typeof currentBlockHeight === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(currentBlockHeight)) {
      fail('Solana currentBlockHeightResolver must return a canonical non-negative integer');
    }
  } else if (typeof currentBlockHeight === 'number') {
    if (!Number.isSafeInteger(currentBlockHeight) || currentBlockHeight < 0) {
      fail('Solana currentBlockHeightResolver must return a canonical non-negative integer');
    }
    currentBlockHeight = String(currentBlockHeight);
  } else if (typeof currentBlockHeight === 'bigint') {
    if (currentBlockHeight < 0n) {
      fail('Solana currentBlockHeightResolver must return a canonical non-negative integer');
    }
    currentBlockHeight = currentBlockHeight.toString();
  } else {
    fail('Solana currentBlockHeightResolver must return a canonical non-negative integer');
  }
  return { ...input, currentBlockHeight };
}

export async function decodeProviderTransaction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('transaction decoder input must be an object');
  if (input.family === 'evm') return decodeEvmTransaction(input);
  if (input.family === 'solana') return decodeSolanaTransaction(await resolveSolanaCurrentBlockHeight(input));
  fail(`unsupported transaction family: ${JSON.stringify(input.family)}`);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(plainObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}`);
  }
}

function stableJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('policy value must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  fail('policy values must be JSON-compatible');
}

function exactValue(expected, actual, label) {
  if (stableJson(expected) !== stableJson(actual)) fail(`${label} is not explicitly allowed`);
}

function canonicalAtomic(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label} must be a canonical atomic-unit string`);
  }
  return value;
}

function validateAmount(value, label) {
  exactKeys(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], label);
  if (typeof value.chainId !== 'string' || value.chainId.length === 0) fail(`${label}.chainId must be a non-empty string`);
  if (typeof value.assetId !== 'string' || value.assetId.length === 0) fail(`${label}.assetId must be a non-empty string`);
  if (!Number.isInteger(value.decimals) || value.decimals < 0) fail(`${label}.decimals must be a non-negative integer`);
  canonicalAtomic(value.amountAtomic, `${label}.amountAtomic`);
}

function amountConstraint(expected, actual, label) {
  if (actual === null) {
    if (expected !== null) fail(`${label} is not explicitly allowed`);
    return;
  }
  if (expected === null) fail(`${label} is not explicitly allowed`);
  validateAmount(actual, `${label} decoded value`);
  plainObject(expected, `${label} policy rule`);
  if (Object.hasOwn(expected, 'exact')) {
    exactKeys(expected, ['exact'], `${label} exact policy rule`);
    validateAmount(expected.exact, `${label} exact policy amount`);
    exactValue(expected.exact, actual, label);
    return;
  }
  const allowedKeys = new Set(['chainId', 'assetId', 'decimals', 'minAtomic', 'maxAtomic']);
  const keys = Object.keys(expected);
  if (keys.some(key => !allowedKeys.has(key))
    || !Object.hasOwn(expected, 'chainId')
    || !Object.hasOwn(expected, 'assetId')
    || !Object.hasOwn(expected, 'decimals')
    || (!Object.hasOwn(expected, 'minAtomic') && !Object.hasOwn(expected, 'maxAtomic'))) {
    fail(`${label} policy range must declare asset metadata and at least one bound`);
  }
  if (typeof expected.chainId !== 'string' || typeof expected.assetId !== 'string'
    || !Number.isInteger(expected.decimals) || expected.decimals < 0) {
    fail(`${label} policy range has invalid asset metadata`);
  }
  exactValue(expected.chainId, actual.chainId, `${label}.chainId`);
  exactValue(expected.assetId, actual.assetId, `${label}.assetId`);
  exactValue(expected.decimals, actual.decimals, `${label}.decimals`);
  const actualAtomic = BigInt(actual.amountAtomic);
  if (Object.hasOwn(expected, 'minAtomic') && actualAtomic < BigInt(canonicalAtomic(expected.minAtomic, `${label}.minAtomic`))) {
    fail(`${label} is below its explicit bound`);
  }
  if (Object.hasOwn(expected, 'maxAtomic') && actualAtomic > BigInt(canonicalAtomic(expected.maxAtomic, `${label}.maxAtomic`))) {
    fail(`${label} is above its explicit bound`);
  }
}

function gasConstraint(expected, actual, label) {
  exactKeys(expected, Object.keys(actual), `${label} policy rule`);
  for (const key of Object.keys(actual)) {
    const actualValue = actual[key];
    const expectedValue = expected[key];
    if (actualValue && typeof actualValue === 'object' && !Array.isArray(actualValue)
      && Object.hasOwn(actualValue, 'amountAtomic')) {
      amountConstraint(expectedValue, actualValue, `${label}.${key}`);
    } else {
      exactValue(expectedValue, actualValue, `${label}.${key}`);
    }
  }
}

function instructionConstraint(expected, actual, label) {
  exactKeys(expected, INSTRUCTION_RULE_FIELDS, `${label} policy rule`);
  for (const key of ['kind', 'programId', 'instructionId', 'accounts', 'source', 'destination', 'mint', 'token', 'computeUnitLimit']) {
    exactValue(expected[key], actual[key], `${label}.${key}`);
  }
  if (expected.data === 'semantic') {
    if (!SEMANTIC_DATA_KINDS.has(actual.kind)) fail(`${label}.data cannot be semantically matched for ${actual.kind}`);
  } else {
    exactValue(expected.data, actual.data, `${label}.data`);
  }
  amountConstraint(expected.amount, actual.amount, `${label}.amount`);
  amountConstraint(expected.nativeValue, actual.nativeValue, `${label}.nativeValue`);
  amountConstraint(expected.priorityFee, actual.priorityFee, `${label}.priorityFee`);
}

function instructionsConstraint(expected, actual, label) {
  if (!Array.isArray(expected) || expected.length !== actual.length) fail(`${label} is not explicitly allowed`);
  actual.forEach((instruction, index) => instructionConstraint(expected[index], instruction, `${label}[${index}]`));
}

function blockhashConstraint(expected, actual) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    exactKeys(expected, ['present'], 'blockhash policy rule');
    if (expected.present !== true || typeof actual !== 'string' || actual.length === 0) {
      fail('blockhash is not explicitly allowed');
    }
    return;
  }
  exactValue(expected, actual, 'blockhash');
}

function deadlineConstraint(expected, actual) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.hasOwn(expected, 'notExpired')) {
    const allowedKeys = new Set(['type', 'notExpired', 'minLastValidBlockHeight', 'maxLastValidBlockHeight']);
    const keys = Object.keys(expected);
    if (keys.some(key => !allowedKeys.has(key)) || expected.type !== 'block-height' || expected.notExpired !== true) {
      fail('deadline policy rule is invalid');
    }
    if (!actual || actual.type !== 'block-height' || actual.expired !== false
      || typeof actual.observedBlockHeight !== 'string' || !/^(0|[1-9][0-9]*)$/.test(actual.observedBlockHeight)) {
      fail('deadline is not explicitly allowed');
    }
    for (const bound of ['minLastValidBlockHeight', 'maxLastValidBlockHeight']) {
      if (!Object.hasOwn(expected, bound)) continue;
      const expectedHeight = BigInt(canonicalAtomic(expected[bound], `deadline.${bound}`));
      const actualHeight = BigInt(canonicalAtomic(actual.lastValidBlockHeight, 'deadline.lastValidBlockHeight'));
      if (bound === 'minLastValidBlockHeight' && actualHeight < expectedHeight) fail('deadline is before its explicit bound');
      if (bound === 'maxLastValidBlockHeight' && actualHeight > expectedHeight) fail('deadline is after its explicit bound');
    }
    return;
  }
  exactValue(expected, actual, 'deadline');
}

function decodedDescription(decoded) {
  plainObject(decoded, 'decoded transaction');
  if (decoded.schema !== DECODE_SCHEMA) fail('decoded transaction did not come from this decoder version');
  return decoded;
}

function transactionPolicyEnvelope(policy, options = undefined) {
  const binding = bindTransactionPolicy(policy, options?.rules);
  return Object.freeze({ canonicalPolicy: binding.policy, rules: binding.rules });
}

function canonicalPolicyConstraint(policy, decoded) {
  if (policy.chainId !== decoded.chainId) fail('canonical policy chainId is not explicitly allowed');
  if (decoded.destination !== null && policy.expectedRecipient !== decoded.destination) {
    fail('canonical policy expectedRecipient is not explicitly allowed');
  }
  const amount = decoded.amount ?? decoded.nativeValue ?? {
    chainId: decoded.chainId,
    assetId: 'native',
    decimals: decoded.family === 'solana' ? 9 : 18,
    amountAtomic: '0',
  };
  exactValue(policy.amount, amount, 'canonical policy amount');
  if (!Array.isArray(decoded.programIds)) fail('decoded transaction programIds are invalid');
  const targetAllowed = decoded.target !== null && policy.allowedTargets.includes(decoded.target);
  const programsAllowed = decoded.programIds.length > 0
    && decoded.programIds.every(programId => policy.allowedPrograms.includes(programId));
  if (!targetAllowed && !programsAllowed) fail('canonical policy target or programs are not explicitly allowed');
}

function ruleConstraint(rule, decoded) {
  exactKeys(rule, RULE_FIELDS, 'policy rule');
  if (typeof rule.id !== 'string' || rule.id.length === 0) fail('policy rule id must be a non-empty string');
  for (const key of [
    'family',
    'format',
    'chainId',
    'nonce',
    'programIds',
    'addressLookupTables',
    'target',
    'selector',
    'source',
    'destination',
    'mint',
    'token',
    'feePayer',
    'requiredSigners',
    'coSigners',
  ]) {
    exactValue(rule[key], decoded[key], key);
  }
  amountConstraint(rule.amount, decoded.amount, 'amount');
  amountConstraint(rule.nativeValue, decoded.nativeValue, 'nativeValue');
  gasConstraint(rule.gas, decoded.gas, 'gas');
  instructionsConstraint(rule.instructions, decoded.instructions, 'instructions');
  instructionsConstraint(rule.extraInstructions, decoded.extraInstructions, 'extraInstructions');
  blockhashConstraint(rule.blockhash, decoded.blockhash);
  deadlineConstraint(rule.deadline, decoded.deadline);
  amountConstraint(rule.priorityFee, decoded.priorityFee, 'priorityFee');
}

export function evaluate(policy, decoded, options = undefined) {
  decodedDescription(decoded);
  const envelope = transactionPolicyEnvelope(policy, options);
  canonicalPolicyConstraint(envelope.canonicalPolicy, decoded);
  if (decoded.deadline?.expired === true) fail('transaction deadline has expired');
  let firstFailure = null;
  for (const rule of envelope.rules) {
    try {
      ruleConstraint(rule, decoded);
      return Object.freeze({ schema: TRANSACTION_POLICY_SCHEMA, allowed: true, ruleId: rule.id });
    } catch (error) {
      if (!(error instanceof TransactionPolicyError)) throw error;
      firstFailure ??= error;
    }
  }
  fail(`transaction was not explicitly allowed${firstFailure ? `: ${firstFailure.message}` : ''}`);
}

function signedTransactionPayload(signedMessage, family) {
  if (typeof signedMessage === 'string') return signedMessage;
  plainObject(signedMessage, 'signed message');
  const field = family === 'solana' ? 'signedTxBase64' : 'signedTx';
  if (typeof signedMessage[field] !== 'string' || signedMessage[field].length === 0) {
    fail(`signed ${family} message must provide ${field}`);
  }
  return signedMessage[field];
}

function comparableDescription(description) {
  if (description.family !== 'solana' || description.deadline?.type !== 'block-height') return description;
  const { observedBlockHeight, expired, ...deadline } = description.deadline;
  return { ...description, deadline };
}

export async function revalidateSignedMessage(signedMessage, approved, options = {}) {
  const approvedDescription = decodedDescription(approved);
  if (approvedDescription.deadline?.expired === true) fail('approved message deadline has expired');
  plainObject(options, 'revalidation options');
  const transaction = signedTransactionPayload(signedMessage, approvedDescription.family);
  const input = {
    ...options,
    family: approvedDescription.family,
    chainId: approvedDescription.chainId,
    transaction,
  };
  if (approvedDescription.family === 'solana') {
    if (typeof options.currentBlockHeightResolver !== 'function') {
      fail('signed Solana message revalidation requires a currentBlockHeightResolver');
    }
    if (typeof options.blockhashContextResolver !== 'function') {
      fail('signed Solana message revalidation requires a blockhashContextResolver');
    }
    assertSolanaSignatureSlots(fullSignedSolanaTransaction(transaction), {
      expectedCoSignerSignatures: options.expectedCoSignerSignatures,
    });
    input.lastValidBlockHeight = options.lastValidBlockHeight ?? approvedDescription.deadline?.lastValidBlockHeight;
    input.currentBlockHeight = options.currentBlockHeight ?? approvedDescription.deadline?.observedBlockHeight;
  }
  const redecoded = await decodeProviderTransaction(input);
  if (redecoded.deadline?.expired === true) fail('signed message deadline has expired');
  if (stableJson(comparableDescription(redecoded)) !== stableJson(comparableDescription(approvedDescription))) {
    fail('signed message differs from its approved semantic description');
  }
  return redecoded;
}
