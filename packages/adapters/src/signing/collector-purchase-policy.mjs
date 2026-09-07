import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import { TRANSACTION_POLICY_SCHEMA, createTransactionPolicy } from './transaction-policy.mjs';

export const COLLECTOR_PURCHASE_BINDING_SCHEMA = 'hookemon.collector-purchase-binding.v1';
export const COLLECTOR_PURCHASE_BINDING_VERSION = 1;

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const BINDING_FIELDS = Object.freeze([
  'schema', 'version', 'provider', 'chainId', 'format', 'addressLookupTables', 'settlement', 'providerCoSigner', 'instructions',
]);
const SETTLEMENT_FIELDS = Object.freeze(['destination', 'mint', 'decimals']);
const INSTRUCTION_TEMPLATE_FIELDS = Object.freeze([
  'kind', 'programId', 'accounts', 'computeUnitLimit', 'priorityFeeCapAtomic', 'memoPrefix',
]);
const ACCOUNT_ROLE_ENTRY_FIELDS = Object.freeze(['role', 'isSigner', 'isWritable']);
const EXPECTED_INSTRUCTION_KINDS = Object.freeze([
  'compute-budget-set-unit-limit',
  'compute-budget-set-unit-price',
  'spl-transfer-checked',
  'unknown',
]);
const GENERATE_PACK_KINDS = Object.freeze([
  'compute-budget-set-unit-limit', 'unknown', 'spl-transfer-checked', 'compute-budget-set-unit-price',
]);
function isGeneratePackProfile(binding) {
  return Array.isArray(binding.instructions) && binding.instructions.length === GENERATE_PACK_KINDS.length
    && binding.instructions.every((instruction, index) => instruction?.kind === GENERATE_PACK_KINDS[index]);
}
const SPL_TRANSFER_CHECKED_ROLES = Object.freeze(['source-ata', 'settlement-mint', 'settlement-destination', 'operator-fee-payer']);
const CYCLE_FACT_FIELDS = Object.freeze(['operatorFeePayer', 'sourceAta', 'amountAtomic', 'memoValue', 'requestDigest']);
const BLOCKHASH_CONTEXT_FIELDS = Object.freeze(['blockhash', 'lastValidBlockHeight', 'currentBlockHeight']);
const FACTORY_INPUT_FIELDS = Object.freeze(['binding', 'expectedDigest', 'cycleFacts', 'blockhashContext']);
const CANONICAL_ATOMIC = /^(0|[1-9][0-9]*)$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MEMO_PREFIX_PATTERN = /^[A-Za-z0-9:_-]{0,64}$/;
const MEMO_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

const ACCOUNT_ROLE_RESOLVERS = Object.freeze({
  'operator-fee-payer': facts => facts.operatorFeePayer,
  'source-ata': facts => facts.sourceAta,
  'provider-co-signer': (_facts, binding) => binding.providerCoSigner,
  'settlement-destination': (_facts, binding) => binding.settlement.destination,
  'settlement-mint': (_facts, binding) => binding.settlement.mint,
});

export class CollectorPurchasePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectorPurchasePolicyError';
  }
}

function fail(message) {
  throw new CollectorPurchasePolicyError(message);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Rejects accessor properties and non-plain prototypes so a digest check cannot be bypassed by a
 * getter that returns different content the second time a field is read.
 */
function assertPlainDataDeep(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a plain array`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value')) fail(`${label} must not use property accessors`);
    }
    value.forEach((item, index) => assertPlainDataDeep(item, `${label}[${index}]`));
    return value;
  }
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) fail(`${label} must not use property accessors`);
      assertPlainDataDeep(value[key], `${label}.${key}`);
    }
    return value;
  }
  fail(`${label} must be JSON-compatible plain data`);
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, fields, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function assertDigestString(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail(`${label} must be a canonical sha256 digest`);
  return value;
}

function assertCanonicalAtomic(value, label) {
  if (typeof value !== 'string' || !CANONICAL_ATOMIC.test(value)) fail(`${label} must be a canonical atomic-unit string`);
  return value;
}

function assertSolanaPublicKey(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a base58 Solana public key`);
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value);
  } catch {
    fail(`${label} must be a valid Solana public key`);
  }
  return value;
}

function parseBindingInput(bindingInput) {
  if (typeof bindingInput === 'string') {
    try {
      return JSON.parse(bindingInput);
    } catch {
      fail('Collector purchase binding text must be valid JSON');
    }
  }
  if (bindingInput === null || typeof bindingInput !== 'object' || Array.isArray(bindingInput)) {
    fail('Collector purchase binding must be JSON text or a plain object');
  }
  return bindingInput;
}

function assertInstructionTemplate(template, index, label, generatePack) {
  const kinds = generatePack ? GENERATE_PACK_KINDS : EXPECTED_INSTRUCTION_KINDS;
  exactKeys(template, INSTRUCTION_TEMPLATE_FIELDS, label);
  if (template.kind !== kinds[index]) {
    fail(`${label}.kind must be ${kinds[index]} at this fixed instruction position`);
  }
  assertSolanaPublicKey(template.programId, `${label}.programId`);
  if (!Array.isArray(template.accounts)) fail(`${label}.accounts must be an array`);
  template.accounts.forEach((account, accountIndex) => {
    exactKeys(account, ACCOUNT_ROLE_ENTRY_FIELDS, `${label}.accounts[${accountIndex}]`);
    if (!Object.hasOwn(ACCOUNT_ROLE_RESOLVERS, account.role)) {
      fail(`${label}.accounts[${accountIndex}].role is unknown`);
    }
    if (typeof account.isSigner !== 'boolean' || typeof account.isWritable !== 'boolean') {
      fail(`${label}.accounts[${accountIndex}] flags must be boolean`);
    }
  });

  if (template.kind === 'compute-budget-set-unit-limit' || template.kind === 'compute-budget-set-unit-price') {
    if (template.programId !== COMPUTE_BUDGET_PROGRAM_ID) fail(`${label}.programId must be the compute budget program`);
    if (template.accounts.length !== 0) fail(`${label}.accounts must be empty for a compute budget instruction`);
    if (template.memoPrefix !== null) fail(`${label}.memoPrefix must be null for a compute budget instruction`);
    if (template.kind === 'compute-budget-set-unit-limit') {
      if (!Number.isInteger(template.computeUnitLimit) || template.computeUnitLimit <= 0
        || template.computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT) {
        fail(`${label}.computeUnitLimit must be a positive integer within the Solana compute unit ceiling`);
      }
      if (template.priorityFeeCapAtomic !== null) fail(`${label}.priorityFeeCapAtomic must be null for a compute unit limit`);
    } else {
      if (template.computeUnitLimit !== null) fail(`${label}.computeUnitLimit must be null for a compute unit price`);
      assertCanonicalAtomic(template.priorityFeeCapAtomic, `${label}.priorityFeeCapAtomic`);
      if (BigInt(template.priorityFeeCapAtomic) <= 0n) fail(`${label}.priorityFeeCapAtomic must be positive`);
    }
    return;
  }

  if (template.kind === 'spl-transfer-checked') {
    if (!TOKEN_PROGRAM_IDS.has(template.programId)) fail(`${label}.programId must be a supported SPL token program`);
    const roles = generatePack ? [...SPL_TRANSFER_CHECKED_ROLES, 'operator-fee-payer'] : SPL_TRANSFER_CHECKED_ROLES;
    if (template.accounts.length !== roles.length) {
      fail(`${label}.accounts must declare exactly the fixed transfer-checked role sequence`);
    }
    template.accounts.forEach((account, accountIndex) => {
      if (account.role !== roles[accountIndex]) {
        fail(`${label}.accounts[${accountIndex}].role must be ${roles[accountIndex]}`);
      }
    });
    if (generatePack && template.accounts.some((account, index) =>
      account.isSigner !== (index >= 3) || account.isWritable !== (index !== 1))) {
      fail(`${label}.accounts flags must match the fixed generatePack transfer profile`);
    }
    if (template.computeUnitLimit !== null || template.priorityFeeCapAtomic !== null || template.memoPrefix !== null) {
      fail(`${label} must not declare compute-budget or memo fields`);
    }
    return;
  }

  // kind === 'unknown': the fixed memo instruction.
  if (template.programId !== MEMO_PROGRAM_ID) fail(`${label}.programId must be the Solana memo program`);
  if (typeof template.memoPrefix !== 'string' || !MEMO_PREFIX_PATTERN.test(template.memoPrefix)) {
    fail(`${label}.memoPrefix must be a bounded plain-text prefix`);
  }
  if (generatePack && (template.memoPrefix !== '' || template.accounts.length !== 1
    || template.accounts[0].role !== 'provider-co-signer'
    || !template.accounts[0].isSigner || template.accounts[0].isWritable)) {
    fail(`${label} must use the fixed generatePack provider memo and empty prefix`);
  }
  if (template.computeUnitLimit !== null || template.priorityFeeCapAtomic !== null) {
    fail(`${label} must not declare compute-budget fields`);
  }
}

/** Validates binding text/object against the strict exact-key CollectorPurchaseBindingV1 schema and its externally supplied expected digest. Never trusts a self-declared digest field: this schema has none. */
export function assertCollectorPurchaseBindingV1(bindingInput, expectedDigest) {
  const parsed = parseBindingInput(bindingInput);
  assertPlainDataDeep(parsed, 'Collector purchase binding');
  assertDigestString(expectedDigest, 'expected Collector purchase binding digest');
  if (digest(parsed) !== expectedDigest) {
    fail('Collector purchase binding digest does not match the externally supplied expected digest');
  }

  exactKeys(parsed, BINDING_FIELDS, 'Collector purchase binding');
  if (parsed.schema !== COLLECTOR_PURCHASE_BINDING_SCHEMA) fail('Collector purchase binding schema is invalid');
  if (parsed.version !== COLLECTOR_PURCHASE_BINDING_VERSION) fail('Collector purchase binding version is invalid');
  if (parsed.provider !== 'collector-crypt') fail('Collector purchase binding provider is invalid');
  if (parsed.chainId !== 'solana-mainnet') fail('Collector purchase binding chainId is invalid');
  if (parsed.format !== 'legacy') fail('Collector purchase binding format must be legacy');
  if (!Array.isArray(parsed.addressLookupTables) || parsed.addressLookupTables.length !== 0) {
    fail('Collector purchase binding must declare no address lookup tables');
  }

  exactKeys(parsed.settlement, SETTLEMENT_FIELDS, 'Collector purchase binding settlement');
  assertSolanaPublicKey(parsed.settlement.destination, 'Collector purchase binding settlement destination');
  assertSolanaPublicKey(parsed.settlement.mint, 'Collector purchase binding settlement mint');
  if (!Number.isInteger(parsed.settlement.decimals) || parsed.settlement.decimals < 0 || parsed.settlement.decimals > 255) {
    fail('Collector purchase binding settlement decimals is invalid');
  }
  assertSolanaPublicKey(parsed.providerCoSigner, 'Collector purchase binding provider co-signer');

  if (!Array.isArray(parsed.instructions) || parsed.instructions.length !== EXPECTED_INSTRUCTION_KINDS.length) {
    fail('Collector purchase binding must declare exactly the fixed purchase instruction sequence');
  }
  parsed.instructions.forEach((template, index) => {
    assertInstructionTemplate(template, index, `Collector purchase binding instructions[${index}]`, isGeneratePackProfile(parsed));
  });

  return deepFreeze(structuredClone(parsed));
}

function assertCollectorPurchaseCycleFacts(facts) {
  exactKeys(facts, CYCLE_FACT_FIELDS, 'Collector purchase cycle facts');
  assertSolanaPublicKey(facts.operatorFeePayer, 'Collector purchase cycle facts operatorFeePayer');
  assertSolanaPublicKey(facts.sourceAta, 'Collector purchase cycle facts sourceAta');
  assertCanonicalAtomic(facts.amountAtomic, 'Collector purchase cycle facts amountAtomic');
  if (BigInt(facts.amountAtomic) <= 0n) fail('Collector purchase cycle facts amountAtomic must be positive');
  if (typeof facts.memoValue !== 'string' || !MEMO_VALUE_PATTERN.test(facts.memoValue)) {
    fail('Collector purchase cycle facts memoValue is invalid');
  }
  assertDigestString(facts.requestDigest, 'Collector purchase cycle facts requestDigest');
  return { ...facts };
}

function assertCollectorPurchaseBlockhashContext(context) {
  exactKeys(context, BLOCKHASH_CONTEXT_FIELDS, 'Collector purchase blockhash context');
  assertSolanaPublicKey(context.blockhash, 'Collector purchase blockhash context blockhash');
  assertCanonicalAtomic(context.lastValidBlockHeight, 'Collector purchase blockhash context lastValidBlockHeight');
  assertCanonicalAtomic(context.currentBlockHeight, 'Collector purchase blockhash context currentBlockHeight');
  if (BigInt(context.currentBlockHeight) > BigInt(context.lastValidBlockHeight)) {
    fail('Collector purchase blockhash context deadline has already expired');
  }
  return { ...context };
}

function resolveRoleAddress(role, facts, binding, label) {
  const resolver = ACCOUNT_ROLE_RESOLVERS[role];
  if (!resolver) fail(`${label} role is unknown`);
  return resolver(facts, binding);
}

function memoInstructionId(bytes) {
  return bytes.length === 0 ? 'none' : `0x${bytes.subarray(0, 1).toString('hex')}`;
}

function resolveInstruction(template, binding, facts) {
  const accounts = Object.freeze(template.accounts.map((account, index) => Object.freeze({
    address: resolveRoleAddress(account.role, facts, binding, `instruction account ${index}`),
    isSigner: account.isSigner,
    isWritable: account.isWritable,
  })));
  const base = {
    kind: template.kind,
    programId: template.programId,
    accounts,
    source: null,
    destination: null,
    mint: null,
    token: null,
    amount: null,
    nativeValue: null,
    computeUnitLimit: null,
    priorityFee: null,
  };

  if (template.kind === 'compute-budget-set-unit-limit') {
    return Object.freeze({
      ...base,
      instructionId: 'set-compute-unit-limit',
      data: 'semantic',
      computeUnitLimit: String(template.computeUnitLimit),
    });
  }
  if (template.kind === 'compute-budget-set-unit-price') {
    return Object.freeze({
      ...base,
      instructionId: 'set-compute-unit-price',
      data: 'semantic',
      priorityFee: Object.freeze({
        chainId: binding.chainId,
        assetId: 'microlamports-per-compute-unit',
        decimals: 0,
        maxAtomic: template.priorityFeeCapAtomic,
      }),
    });
  }
  if (template.kind === 'spl-transfer-checked') {
    const [source, mint, destination] = accounts;
    return Object.freeze({
      ...base,
      instructionId: 'transfer-checked',
      data: 'semantic',
      source: source.address,
      destination: destination.address,
      mint: mint.address,
      token: mint.address,
      amount: Object.freeze({
        exact: Object.freeze({
          chainId: binding.chainId,
          assetId: mint.address,
          decimals: binding.settlement.decimals,
          amountAtomic: facts.amountAtomic,
        }),
      }),
    });
  }

  const memoBytes = Buffer.from(`${template.memoPrefix}${facts.memoValue}${isGeneratePackProfile(binding) ? ':open' : ''}`, 'utf8');
  return Object.freeze({
    ...base,
    instructionId: memoInstructionId(memoBytes),
    data: memoBytes.toString('base64'),
  });
}

/**
 * Constructs the canonical policy and its complete adapter rule sidecar for one Collector purchase
 * from a validated binding, durable cycle facts, and independently trusted blockhash/deadline
 * context only. No candidate transaction, decoded semantics, or self-declared digest ever
 * contributes a field: every canonical value below is built explicitly, then handed to
 * `createTransactionPolicy` directly, bypassing `createCanonicalTransactionPolicy`'s
 * candidate-derived defaults entirely.
 */
export function createCollectorPurchasePolicy(input) {
  exactKeys(input, FACTORY_INPUT_FIELDS, 'Collector purchase policy factory input');
  const binding = assertCollectorPurchaseBindingV1(input.binding, input.expectedDigest);
  const facts = assertCollectorPurchaseCycleFacts(input.cycleFacts);
  const trusted = assertCollectorPurchaseBlockhashContext(input.blockhashContext);

  const resolvedInstructions = Object.freeze(binding.instructions.map(template => resolveInstruction(template, binding, facts)));
  const primary = resolvedInstructions.find(instruction => instruction.kind === 'spl-transfer-checked');
  const computeLimit = resolvedInstructions.find(instruction => instruction.kind === 'compute-budget-set-unit-limit');
  const computePrice = resolvedInstructions.find(instruction => instruction.kind === 'compute-budget-set-unit-price');
  const programIds = Object.freeze([...new Set(resolvedInstructions.map(instruction => instruction.programId))]);
  const amount = structuredClone(primary.amount.exact);

  const rule = {
    id: 'collector-purchase-v1',
    family: 'solana',
    format: binding.format,
    chainId: binding.chainId,
    nonce: null,
    programIds: structuredClone(programIds),
    addressLookupTables: [],
    target: null,
    selector: null,
    source: primary.source,
    destination: primary.destination,
    mint: primary.mint,
    token: primary.token,
    amount: structuredClone(primary.amount),
    nativeValue: null,
    gas: {
      computeUnitLimit: computeLimit.computeUnitLimit,
      pricePerComputeUnit: structuredClone(computePrice.priorityFee),
    },
    feePayer: facts.operatorFeePayer,
    requiredSigners: [facts.operatorFeePayer, binding.providerCoSigner],
    coSigners: [binding.providerCoSigner],
    instructions: resolvedInstructions.map(instruction => structuredClone(instruction)),
    extraInstructions: resolvedInstructions.filter(instruction => instruction !== primary).map(instruction => structuredClone(instruction)),
    blockhash: trusted.blockhash,
    deadline: {
      type: 'block-height',
      notExpired: true,
      minLastValidBlockHeight: trusted.lastValidBlockHeight,
      maxLastValidBlockHeight: trusted.lastValidBlockHeight,
    },
    priorityFee: structuredClone(computePrice.priorityFee),
  };

  const canonicalPolicy = {
    schema: TRANSACTION_POLICY_SCHEMA,
    chainId: binding.chainId,
    stage: 'purchase',
    requestDigest: facts.requestDigest,
    expectedRecipient: primary.destination,
    amount,
    allowedTargets: [],
    allowedPrograms: structuredClone(programIds),
  };

  return createTransactionPolicy({ policy: canonicalPolicy, rules: [rule] });
}
