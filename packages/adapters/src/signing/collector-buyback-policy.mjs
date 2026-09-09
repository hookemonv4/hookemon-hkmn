import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import { TRANSACTION_POLICY_SCHEMA, createTransactionPolicy } from './transaction-policy.mjs';

export const COLLECTOR_BUYBACK_BINDING_SCHEMA = 'hookemon.collector-buyback-binding.v1';
export const COLLECTOR_BUYBACK_BINDING_VERSION = 1;

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();
const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

const BINDING_FIELDS = Object.freeze([
  'schema', 'version', 'provider', 'chainId', 'format', 'addressLookupTables', 'proceeds', 'collectorAuthority', 'collectorRecipient', 'instructions',
]);
const PROCEEDS_FIELDS = Object.freeze(['source', 'mint', 'decimals']);
const INSTRUCTION_TEMPLATE_FIELDS = Object.freeze([
  'kind', 'programId', 'accounts', 'computeUnitLimit', 'priorityFeeCapAtomic', 'discriminatorHex',
]);
const ACCOUNT_ROLE_ENTRY_FIELDS = Object.freeze(['role', 'isSigner', 'isWritable']);
const EXPECTED_INSTRUCTION_KINDS = Object.freeze([
  'compute-budget-set-unit-limit',
  'compute-budget-set-unit-price',
  'unknown',
  'spl-transfer-checked',
]);
export const COLLECTOR_BUYBACK_SETTLE_INSTRUCTION_INDEX = 2;
const SETTLE_INSTRUCTION_INDEX = COLLECTOR_BUYBACK_SETTLE_INSTRUCTION_INDEX;
const TRANSFER_INSTRUCTION_INDEX = 3;
const BUYBACK_TRANSFER_ROLES = Object.freeze(['proceeds-source', 'proceeds-mint', 'proceeds-destination', 'collector-authority']);
const BUYBACK_SETTLE_ROLES = Object.freeze(['operator-fee-payer', 'collector-authority', 'opened-asset-mint', 'collector-recipient']);
const CYCLE_FACT_FIELDS = Object.freeze([
  'operatorFeePayer', 'proceedsDestination', 'openedAssetMint', 'currentOwner', 'quoteAtomic', 'minimumAtomic', 'refundAtomic', 'requestDigest',
]);
const BLOCKHASH_CONTEXT_FIELDS = Object.freeze(['blockhash', 'lastValidBlockHeight', 'currentBlockHeight']);
const FACTORY_INPUT_FIELDS = Object.freeze(['binding', 'expectedDigest', 'cycleFacts', 'blockhashContext']);
const CANONICAL_ATOMIC = /^(0|[1-9][0-9]*)$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DISCRIMINATOR_HEX_PATTERN = /^[0-9a-f]{16}$/;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

const ACCOUNT_ROLE_RESOLVERS = Object.freeze({
  'operator-fee-payer': facts => facts.operatorFeePayer,
  'opened-asset-mint': facts => facts.openedAssetMint,
  'proceeds-destination': facts => facts.proceedsDestination,
  'collector-authority': (_facts, binding) => binding.collectorAuthority,
  'collector-recipient': (_facts, binding) => binding.collectorRecipient,
  'proceeds-source': (_facts, binding) => binding.proceeds.source,
  'proceeds-mint': (_facts, binding) => binding.proceeds.mint,
});

export class CollectorBuybackPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectorBuybackPolicyError';
  }
}

function fail(message) {
  throw new CollectorBuybackPolicyError(message);
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
      fail('Collector buyback binding text must be valid JSON');
    }
  }
  if (bindingInput === null || typeof bindingInput !== 'object' || Array.isArray(bindingInput)) {
    fail('Collector buyback binding must be JSON text or a plain object');
  }
  return bindingInput;
}

function assertInstructionTemplate(template, index, label) {
  exactKeys(template, INSTRUCTION_TEMPLATE_FIELDS, label);
  if (template.kind !== EXPECTED_INSTRUCTION_KINDS[index]) {
    fail(`${label}.kind must be ${EXPECTED_INSTRUCTION_KINDS[index]} at this fixed instruction position`);
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
    if (template.discriminatorHex !== null) fail(`${label}.discriminatorHex must be null for a compute budget instruction`);
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
    if (template.accounts.length !== BUYBACK_TRANSFER_ROLES.length) {
      fail(`${label}.accounts must declare exactly the fixed proceeds transfer role sequence`);
    }
    template.accounts.forEach((account, accountIndex) => {
      if (account.role !== BUYBACK_TRANSFER_ROLES[accountIndex]) {
        fail(`${label}.accounts[${accountIndex}].role must be ${BUYBACK_TRANSFER_ROLES[accountIndex]}`);
      }
    });
    if (template.computeUnitLimit !== null || template.priorityFeeCapAtomic !== null || template.discriminatorHex !== null) {
      fail(`${label} must not declare compute-budget or discriminator fields`);
    }
    return;
  }

  // kind === 'unknown': the fixed Collector program buyback-settlement call at SETTLE_INSTRUCTION_INDEX.
  if (index !== SETTLE_INSTRUCTION_INDEX) fail(`${label} unknown-kind instruction is only defined at the fixed settle position`);
  if (template.accounts.length !== BUYBACK_SETTLE_ROLES.length) {
    fail(`${label}.accounts must declare exactly the fixed buyback-settle role sequence`);
  }
  template.accounts.forEach((account, accountIndex) => {
    if (account.role !== BUYBACK_SETTLE_ROLES[accountIndex]) {
      fail(`${label}.accounts[${accountIndex}].role must be ${BUYBACK_SETTLE_ROLES[accountIndex]}`);
    }
  });
  if (typeof template.discriminatorHex !== 'string' || !DISCRIMINATOR_HEX_PATTERN.test(template.discriminatorHex)) {
    fail(`${label}.discriminatorHex must be an 8-byte hex-encoded instruction discriminator`);
  }
  if (template.computeUnitLimit !== null || template.priorityFeeCapAtomic !== null) {
    fail(`${label} must not declare compute-budget fields`);
  }
}

/** Validates binding text/object against the strict exact-key CollectorBuybackBindingV1 schema and
 * its externally supplied expected digest. Never trusts a self-declared digest field: this schema
 * has none. */
export function assertCollectorBuybackBindingV1(bindingInput, expectedDigest) {
  const parsed = parseBindingInput(bindingInput);
  assertPlainDataDeep(parsed, 'Collector buyback binding');
  assertDigestString(expectedDigest, 'expected Collector buyback binding digest');
  if (digest(parsed) !== expectedDigest) {
    fail('Collector buyback binding digest does not match the externally supplied expected digest');
  }

  if (parsed.profile === 'core-transfer-v1') return assertCoreBinding(parsed);
  exactKeys(parsed, BINDING_FIELDS, 'Collector buyback binding');
  if (parsed.schema !== COLLECTOR_BUYBACK_BINDING_SCHEMA) fail('Collector buyback binding schema is invalid');
  if (parsed.version !== COLLECTOR_BUYBACK_BINDING_VERSION) fail('Collector buyback binding version is invalid');
  if (parsed.provider !== 'collector-crypt') fail('Collector buyback binding provider is invalid');
  if (parsed.chainId !== 'solana-mainnet') fail('Collector buyback binding chainId is invalid');
  if (parsed.format !== 'legacy') fail('Collector buyback binding format must be legacy');
  if (!Array.isArray(parsed.addressLookupTables) || parsed.addressLookupTables.length !== 0) {
    fail('Collector buyback binding must declare no address lookup tables');
  }

  exactKeys(parsed.proceeds, PROCEEDS_FIELDS, 'Collector buyback binding proceeds');
  assertSolanaPublicKey(parsed.proceeds.source, 'Collector buyback binding proceeds source');
  assertSolanaPublicKey(parsed.proceeds.mint, 'Collector buyback binding proceeds mint');
  if (!Number.isInteger(parsed.proceeds.decimals) || parsed.proceeds.decimals < 0 || parsed.proceeds.decimals > 255) {
    fail('Collector buyback binding proceeds decimals is invalid');
  }
  assertSolanaPublicKey(parsed.collectorAuthority, 'Collector buyback binding collector authority');
  assertSolanaPublicKey(parsed.collectorRecipient, 'Collector buyback binding collector recipient');
  if (parsed.collectorAuthority === parsed.collectorRecipient) {
    fail('Collector buyback binding collector authority and recipient must be distinct');
  }

  if (!Array.isArray(parsed.instructions) || parsed.instructions.length !== EXPECTED_INSTRUCTION_KINDS.length) {
    fail('Collector buyback binding must declare exactly the fixed buyback instruction sequence');
  }
  parsed.instructions.forEach((template, index) => {
    assertInstructionTemplate(template, index, `Collector buyback binding instructions[${index}]`);
  });

  return deepFreeze(structuredClone(parsed));
}

function assertCollectorBuybackCycleFacts(facts) {
  exactKeys(facts, CYCLE_FACT_FIELDS, 'Collector buyback cycle facts');
  assertSolanaPublicKey(facts.operatorFeePayer, 'Collector buyback cycle facts operatorFeePayer');
  assertSolanaPublicKey(facts.proceedsDestination, 'Collector buyback cycle facts proceedsDestination');
  assertSolanaPublicKey(facts.openedAssetMint, 'Collector buyback cycle facts openedAssetMint');
  assertSolanaPublicKey(facts.currentOwner, 'Collector buyback cycle facts currentOwner');
  if (facts.currentOwner !== facts.operatorFeePayer) {
    fail('Collector buyback cycle facts currentOwner must be the operator, matching the independently finalized open ownership');
  }
  assertCanonicalAtomic(facts.quoteAtomic, 'Collector buyback cycle facts quoteAtomic');
  assertCanonicalAtomic(facts.minimumAtomic, 'Collector buyback cycle facts minimumAtomic');
  assertCanonicalAtomic(facts.refundAtomic, 'Collector buyback cycle facts refundAtomic');
  if (BigInt(facts.quoteAtomic) <= 0n) fail('Collector buyback cycle facts quoteAtomic must be positive');
  if (BigInt(facts.minimumAtomic) > BigInt(facts.quoteAtomic)) {
    fail('Collector buyback cycle facts minimumAtomic must not exceed the persisted quote');
  }
  if (facts.refundAtomic !== facts.quoteAtomic) {
    fail('Collector buyback cycle facts refundAtomic must equal the persisted quote');
  }
  assertDigestString(facts.requestDigest, 'Collector buyback cycle facts requestDigest');
  return { ...facts };
}

function assertCollectorBuybackBlockhashContext(context) {
  exactKeys(context, BLOCKHASH_CONTEXT_FIELDS, 'Collector buyback blockhash context');
  assertSolanaPublicKey(context.blockhash, 'Collector buyback blockhash context blockhash');
  assertCanonicalAtomic(context.lastValidBlockHeight, 'Collector buyback blockhash context lastValidBlockHeight');
  assertCanonicalAtomic(context.currentBlockHeight, 'Collector buyback blockhash context currentBlockHeight');
  if (BigInt(context.currentBlockHeight) > BigInt(context.lastValidBlockHeight)) {
    fail('Collector buyback blockhash context deadline has already expired');
  }
  return { ...context };
}

function resolveRoleAddress(role, facts, binding, label) {
  const resolver = ACCOUNT_ROLE_RESOLVERS[role];
  if (!resolver) fail(`${label} role is unknown`);
  return resolver(facts, binding);
}

function settleInstructionData(discriminatorHex, minimumAtomic, refundAtomic) {
  const buffer = Buffer.alloc(24);
  Buffer.from(discriminatorHex, 'hex').copy(buffer, 0);
  buffer.writeBigUInt64LE(BigInt(minimumAtomic), 8);
  buffer.writeBigUInt64LE(BigInt(refundAtomic), 16);
  return buffer;
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
          decimals: binding.proceeds.decimals,
          amountAtomic: facts.quoteAtomic,
        }),
      }),
    });
  }

  // kind === 'unknown': the fixed Collector program buyback-settlement call.
  const data = settleInstructionData(template.discriminatorHex, facts.minimumAtomic, facts.refundAtomic);
  return Object.freeze({
    ...base,
    instructionId: `0x${template.discriminatorHex.slice(0, 2)}`,
    data: data.toString('base64'),
  });
}

/**
 * Constructs the canonical policy and its complete adapter rule sidecar for one Collector buyback
 * from a validated binding, durable cycle facts, and independently trusted blockhash/deadline
 * context only. No candidate transaction, decoded semantics, or self-declared digest ever
 * contributes a field: every canonical value below is built explicitly, then handed to
 * `createTransactionPolicy` directly. This is a distinct factory from
 * `createCollectorPurchasePolicy`: buyback stage facts are only valid after the open stage has
 * independently finalized the opened mint and current owner, and after the separate sell decision
 * (quote/minimum/refund) has already been authorized upstream.
 */
export function createCollectorBuybackPolicy(input) {
  exactKeys(input, FACTORY_INPUT_FIELDS, 'Collector buyback policy factory input');
  const binding = assertCollectorBuybackBindingV1(input.binding, input.expectedDigest);
  if (binding.profile === 'core-transfer-v1') return createCoreBuybackPolicy(binding, input);
  const facts = assertCollectorBuybackCycleFacts(input.cycleFacts);
  const trusted = assertCollectorBuybackBlockhashContext(input.blockhashContext);

  const resolvedInstructions = Object.freeze(binding.instructions.map(template => resolveInstruction(template, binding, facts)));
  const primary = resolvedInstructions[TRANSFER_INSTRUCTION_INDEX];
  const settle = resolvedInstructions[SETTLE_INSTRUCTION_INDEX];
  const computeLimit = resolvedInstructions.find(instruction => instruction.kind === 'compute-budget-set-unit-limit');
  const computePrice = resolvedInstructions.find(instruction => instruction.kind === 'compute-budget-set-unit-price');
  const programIds = Object.freeze([...new Set(resolvedInstructions.map(instruction => instruction.programId))]);
  const amount = structuredClone(primary.amount.exact);

  const rule = {
    id: 'collector-buyback-v1',
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
    requiredSigners: [facts.operatorFeePayer, binding.collectorAuthority],
    coSigners: [binding.collectorAuthority],
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

  // Referenced only to keep the settle instruction's opaque program call reachable for future
  // account-relation review; the amount/recipient authority itself always comes from the
  // transfer-checked instruction above, never from this opaque call.
  void settle;

  const canonicalPolicy = {
    schema: TRANSACTION_POLICY_SCHEMA,
    chainId: binding.chainId,
    stage: 'buyback',
    requestDigest: facts.requestDigest,
    expectedRecipient: primary.destination,
    amount,
    allowedTargets: [],
    allowedPrograms: structuredClone(programIds),
  };

  return createTransactionPolicy({ policy: canonicalPolicy, rules: [rule] });
}

// TransferV1 source: metaplex-foundation/mpl-core commit
// e72d63e4118a0a95ac9b40221e81b19d49e1e102, clients/js/src/generated/instructions/transferV1.ts.
// This structural profile conveys no authority for the deployed program or live binding values.
const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const CLASSIC_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const role = (name, isSigner = false, isWritable = false) => ({ role: name, isSigner, isWritable });
const CORE_ACCOUNTS = [
 [],
 [role('opened-asset-mint',false,true),role('collection'),role('collector-authority',true,true),role('operator-owner',true),role('collector-recipient'),role('core-program'),role('core-program')],
 [],
 [role('collector-authority',true,true),role('proceeds-destination',false,true),role('operator-owner',true),role('proceeds-mint'),role('system-program'),role('token-program')],
 [role('proceeds-source',false,true),role('proceeds-mint'),role('proceeds-destination',false,true),role('collector-authority',true,true)],
 [],
];
const CORE_KINDS = ['compute-budget-set-unit-limit','unknown','compute-budget-set-unit-price','unknown','spl-transfer-checked','unknown'];
const CORE_PROGRAMS = [COMPUTE_BUDGET_PROGRAM_ID,CORE_PROGRAM,COMPUTE_BUDGET_PROGRAM_ID,ATA_PROGRAM,CLASSIC_TOKEN,MEMO_PROGRAM];
export function isCollectorCoreBuybackBinding(binding) { return binding?.profile === 'core-transfer-v1'; }
export function collectorBuybackProgramId(binding) {
 return binding.instructions[isCollectorCoreBuybackBinding(binding) ? 1 : SETTLE_INSTRUCTION_INDEX].programId;
}
function assertCoreBinding(binding) {
 exactKeys(binding,[...BINDING_FIELDS,'profile','collection'],'Collector Core binding');
 if(binding.schema!==COLLECTOR_BUYBACK_BINDING_SCHEMA || binding.version!==1 || binding.provider!=='collector-crypt'
  || binding.chainId!=='solana-mainnet' || binding.format!=='legacy' || !Array.isArray(binding.addressLookupTables) || binding.addressLookupTables.length) fail('invalid Core binding identity');
 exactKeys(binding.proceeds,PROCEEDS_FIELDS,'Core proceeds');
 if(binding.proceeds.mint!==USDC_MINT || binding.proceeds.decimals!==6) fail('Core proceeds must be canonical USDC');
 for(const key of ['collectorAuthority','collectorRecipient','collection']) assertSolanaPublicKey(binding[key],`Core ${key}`);
 assertSolanaPublicKey(binding.proceeds.source,'Core proceeds source');
 if(new Set([binding.collectorAuthority,binding.collectorRecipient,binding.collection,binding.proceeds.source]).size!==4) fail('Core binding roles must be distinct');
 if(!Array.isArray(binding.instructions)||binding.instructions.length!==6) fail('Core buyback requires exactly six instructions');
 binding.instructions.forEach((t,i)=>{
  exactKeys(t,INSTRUCTION_TEMPLATE_FIELDS,`Core instruction ${i}`);
  if(t.kind!==CORE_KINDS[i] || t.programId!==CORE_PROGRAMS[i] || digest(t.accounts)!==digest(CORE_ACCOUNTS[i])) fail(`Core instruction ${i} shape mismatch`);
  if(i===0 || i===2) {
   // The existing compute template checker expects price at index 1.
   assertInstructionTemplate(t,i===0?0:1,`Core compute instruction ${i}`);
  } else if(t.computeUnitLimit!==null || t.priorityFeeCapAtomic!==null || t.discriminatorHex!==(i===1?'0e00':i===3?'01':null)) fail(`Core instruction ${i} data mismatch`);
 });
 return deepFreeze(structuredClone(binding));
}
function createCoreBuybackPolicy(binding,input) {
 assertPlainDataDeep(input.cycleFacts,'Core cycle facts');
 exactKeys(input.cycleFacts,[...CYCLE_FACT_FIELDS,'memoValue'],'Core cycle facts');
 const {memoValue,...legacyFacts}=input.cycleFacts;
 const facts=assertCollectorBuybackCycleFacts(legacyFacts);
 if(typeof memoValue!=='string'||!/^cc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(memoValue)) fail('Core memo must be the durable Collector memo');
 if(BigInt(facts.minimumAtomic)<=0n || facts.operatorFeePayer===binding.collectorAuthority || facts.operatorFeePayer===binding.collectorRecipient) fail('invalid Core owner or minimum');
 const [ata]=PublicKey.findProgramAddressSync([new PublicKey(facts.operatorFeePayer).toBuffer(),new PublicKey(CLASSIC_TOKEN).toBuffer(),new PublicKey(USDC_MINT).toBuffer()],new PublicKey(ATA_PROGRAM));
 if(facts.proceedsDestination!==ata.toBase58() || facts.proceedsDestination===binding.proceeds.source) fail('Core proceeds destination must be canonical Operations ATA');
 const context=input.blockhashContext;
 assertPlainDataDeep(context,'Core blockhash context');
 exactKeys(context,['type','blockhash','valid','observedSlot'],'Core blockhash context');
 if(context.type!=='rpc-blockhash-validity'||context.valid!==true) fail('Core buyback requires valid original blockhash');
 assertSolanaPublicKey(context.blockhash,'Core original blockhash');assertCanonicalAtomic(context.observedSlot,'Core observed slot');
 const addresses={
  'operator-owner':facts.operatorFeePayer,'opened-asset-mint':facts.openedAssetMint,collection:binding.collection,
  'collector-authority':binding.collectorAuthority,'collector-recipient':binding.collectorRecipient,
  'proceeds-source':binding.proceeds.source,'proceeds-destination':facts.proceedsDestination,'proceeds-mint':binding.proceeds.mint,
  'core-program':CORE_PROGRAM,'system-program':SYSTEM_PROGRAM,'token-program':CLASSIC_TOKEN,
 };
 const instructions=binding.instructions.map((t,i)=>{
  if(i===0||i===2||i===4) return resolveInstruction(t,binding,facts);
  const data=i===1?Buffer.from('0e00','hex'):i===3?Buffer.from([1]):Buffer.from(`${memoValue}:buyback`,'utf8');
  return {kind:'unknown',programId:t.programId,instructionId:`0x${data[0].toString(16).padStart(2,'0')}`,data:data.toString('base64'),
   accounts:t.accounts.map(a=>({address:addresses[a.role],isSigner:a.isSigner,isWritable:a.isWritable})),
   source:null,destination:null,mint:null,token:null,amount:null,nativeValue:null,computeUnitLimit:null,priorityFee:null};
 });
 const primary=instructions[4],price=instructions[2].priorityFee,programIds=[...new Set(CORE_PROGRAMS)];
 const rule={id:'collector-core-buyback-v1',family:'solana',format:'legacy',chainId:binding.chainId,nonce:null,
  programIds,addressLookupTables:[],target:null,selector:null,source:primary.source,destination:primary.destination,mint:primary.mint,token:primary.token,
  amount:primary.amount,nativeValue:null,gas:{computeUnitLimit:instructions[0].computeUnitLimit,pricePerComputeUnit:price},
  feePayer:binding.collectorAuthority,requiredSigners:[binding.collectorAuthority,facts.operatorFeePayer],coSigners:[facts.operatorFeePayer],
  instructions,extraInstructions:instructions.filter((_,i)=>i!==4),blockhash:context.blockhash,
  deadline:{type:'rpc-blockhash-validity',valid:true,minObservedSlot:context.observedSlot},priorityFee:price};
 return createTransactionPolicy({policy:{schema:TRANSACTION_POLICY_SCHEMA,chainId:binding.chainId,stage:'buyback',requestDigest:facts.requestDigest,
  expectedRecipient:primary.destination,amount:primary.amount.exact,allowedTargets:[],allowedPrograms:programIds},rules:[rule]});
}
