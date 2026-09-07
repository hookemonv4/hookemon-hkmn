import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  COLLECTOR_BUYBACK_BINDING_SCHEMA,
  CollectorBuybackPolicyError,
  assertCollectorBuybackBindingV1,
  createCollectorBuybackPolicy,
} from '../../src/signing/collector-buyback-policy.mjs';
import { TransactionPolicyError, decodeProviderTransaction, evaluate } from '../../src/signing/transaction-policy.mjs';

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const COLLECTOR_PROGRAM_ID = Keypair.generate().publicKey.toBase58();
const DISCRIMINATOR_HEX = 'a1b2c3d4e5f60718';

const operator = Keypair.generate();
const authority = Keypair.generate();
const proceedsSource = Keypair.generate().publicKey;
const proceedsMint = Keypair.generate().publicKey;
const proceedsDestination = Keypair.generate().publicKey;
const collectorRecipient = Keypair.generate().publicKey;
const openedAssetMint = Keypair.generate().publicKey;
const recentBlockhash = Keypair.generate().publicKey.toBase58();

const RAW_BINDING = Object.freeze({
  schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  proceeds: {
    source: proceedsSource.toBase58(),
    mint: proceedsMint.toBase58(),
    decimals: 6,
  },
  collectorAuthority: authority.publicKey.toBase58(),
  collectorRecipient: collectorRecipient.toBase58(),
  instructions: [
    {
      kind: 'compute-budget-set-unit-limit',
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      accounts: [],
      computeUnitLimit: 40000,
      priorityFeeCapAtomic: null,
      discriminatorHex: null,
    },
    {
      kind: 'compute-budget-set-unit-price',
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      accounts: [],
      computeUnitLimit: null,
      priorityFeeCapAtomic: '5000',
      discriminatorHex: null,
    },
    {
      kind: 'unknown',
      programId: COLLECTOR_PROGRAM_ID,
      accounts: [
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
        { role: 'opened-asset-mint', isSigner: false, isWritable: true },
        { role: 'collector-recipient', isSigner: false, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: DISCRIMINATOR_HEX,
    },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'proceeds-source', isSigner: false, isWritable: true },
        { role: 'proceeds-mint', isSigner: false, isWritable: false },
        { role: 'proceeds-destination', isSigner: false, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: null,
    },
  ],
});
const EXPECTED_DIGEST = digest(RAW_BINDING);

const CYCLE_FACTS = Object.freeze({
  operatorFeePayer: operator.publicKey.toBase58(),
  proceedsDestination: proceedsDestination.toBase58(),
  openedAssetMint: openedAssetMint.toBase58(),
  currentOwner: operator.publicKey.toBase58(),
  quoteAtomic: '1000000',
  minimumAtomic: '900000',
  refundAtomic: '1000000',
  requestDigest: digest({ schema: 'test.collector-buyback-request.v1', cycleId: 'cycle-0001' }),
});

const BLOCKHASH_CONTEXT = Object.freeze({
  blockhash: recentBlockhash,
  lastValidBlockHeight: '1000',
  currentBlockHeight: '500',
});

function factoryInput(overrides = {}) {
  return {
    binding: RAW_BINDING,
    expectedDigest: EXPECTED_DIGEST,
    cycleFacts: CYCLE_FACTS,
    blockhashContext: BLOCKHASH_CONTEXT,
    ...overrides,
  };
}

function mutatedBinding(mutator) {
  const mutated = mutator(structuredClone(RAW_BINDING));
  return { binding: mutated, expectedDigest: digest(mutated) };
}

function transferCheckedData(amountAtomic, decimals) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amountAtomic), 1);
  data.writeUInt8(decimals, 9);
  return data;
}

function settleData(discriminatorHex, minimumAtomic, refundAtomic) {
  const data = Buffer.alloc(24);
  Buffer.from(discriminatorHex, 'hex').copy(data, 0);
  data.writeBigUInt64LE(BigInt(minimumAtomic), 8);
  data.writeBigUInt64LE(BigInt(refundAtomic), 16);
  return data;
}

function buildCandidateTransaction(overrides = {}) {
  const {
    feePayer = operator,
    authorityKey = authority,
    proceedsSourceKey = proceedsSource,
    proceedsMintKey = proceedsMint,
    proceedsDestinationKey = proceedsDestination,
    collectorRecipientKey = collectorRecipient,
    openedAssetMintKey = openedAssetMint,
    proceedsWritable = true,
    amountAtomic = CYCLE_FACTS.quoteAtomic,
    decimals = RAW_BINDING.proceeds.decimals,
    computeUnitLimit = RAW_BINDING.instructions[0].computeUnitLimit,
    priorityFeeMicroLamports = 4000,
    minimumAtomic = CYCLE_FACTS.minimumAtomic,
    refundAtomic = CYCLE_FACTS.refundAtomic,
    discriminatorHex = DISCRIMINATOR_HEX,
    blockhash = BLOCKHASH_CONTEXT.blockhash,
    instructionOrder = ['limit', 'price', 'settle', 'transfer'],
    extraInstruction = false,
  } = overrides;

  const instructionsByKind = {
    limit: ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    price: ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    settle: new TransactionInstruction({
      programId: new PublicKey(COLLECTOR_PROGRAM_ID),
      keys: [
        { pubkey: feePayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: authorityKey.publicKey, isSigner: true, isWritable: false },
        { pubkey: openedAssetMintKey, isSigner: false, isWritable: true },
        { pubkey: collectorRecipientKey, isSigner: false, isWritable: true },
      ],
      data: settleData(discriminatorHex, minimumAtomic, refundAtomic),
    }),
    transfer: new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: proceedsSourceKey, isSigner: false, isWritable: proceedsWritable },
        { pubkey: proceedsMintKey, isSigner: false, isWritable: false },
        { pubkey: proceedsDestinationKey, isSigner: false, isWritable: true },
        { pubkey: authorityKey.publicKey, isSigner: true, isWritable: false },
      ],
      data: transferCheckedData(amountAtomic, decimals),
    }),
  };

  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash });
  for (const kind of instructionOrder) transaction.add(instructionsByKind[kind]);
  if (extraInstruction) {
    transaction.add(new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID.slice(0, -1) === TOKEN_PROGRAM_ID ? TOKEN_PROGRAM_ID : COMPUTE_BUDGET_PROGRAM_ID),
      keys: [],
      data: Buffer.from([9, 9, 9, 9, 9]),
    }));
  }
  transaction.partialSign(feePayer, authorityKey);
  return Buffer.from(transaction.serialize()).toString('base64');
}

async function decodeCandidate(transactionBase64, decodeOverrides = {}) {
  return decodeProviderTransaction({
    family: 'solana',
    chainId: 'solana-mainnet',
    transaction: transactionBase64,
    lastValidBlockHeight: BLOCKHASH_CONTEXT.lastValidBlockHeight,
    currentBlockHeight: BLOCKHASH_CONTEXT.currentBlockHeight,
    ...decodeOverrides,
  });
}

test('accepts a legacy Collector buyback transaction built exactly from the binding and facts', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction());
  const result = evaluate(policy, decoded);
  assert.equal(result.allowed, true);
  assert.equal(result.ruleId, 'collector-buyback-v1');
});

test('refuses a factory input that adds a candidate-shaped field beside the trusted inputs', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({ candidateTransaction: 'anything' })),
    CollectorBuybackPolicyError,
  );
});

test('refuses construction with no blockhash context at all', () => {
  const input = factoryInput();
  delete input.blockhashContext;
  assert.throws(() => createCollectorBuybackPolicy(input), CollectorBuybackPolicyError);
});

test('refuses construction with an incomplete durable cycle fact set', () => {
  const { minimumAtomic, ...incompleteFacts } = CYCLE_FACTS;
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({ cycleFacts: incompleteFacts })),
    CollectorBuybackPolicyError,
  );
});

test('refuses cycle facts whose currentOwner is not the operator fee payer', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      cycleFacts: { ...CYCLE_FACTS, currentOwner: Keypair.generate().publicKey.toBase58() },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses cycle facts whose minimum exceeds the persisted quote', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      cycleFacts: { ...CYCLE_FACTS, minimumAtomic: '1500000' },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses cycle facts whose refund does not equal the persisted quote', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      cycleFacts: { ...CYCLE_FACTS, refundAtomic: '999999' },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses a blockhash context whose current height already passed the last valid height', () => {
  assert.throws(
    () => createCollectorBuybackPolicy(factoryInput({
      blockhashContext: { ...BLOCKHASH_CONTEXT, currentBlockHeight: '1500' },
    })),
    CollectorBuybackPolicyError,
  );
});

test('refuses a binding digest that does not match the externally supplied expected digest', () => {
  const wrongDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => assertCollectorBuybackBindingV1(RAW_BINDING, wrongDigest), CollectorBuybackPolicyError);
});

test('refuses a binding with an extra unexpected field', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, extra: 'nope' }));
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding missing a required field', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    const { collectorRecipient: _drop, ...rest } = value;
    return rest;
  });
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring the same collector authority and recipient', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, collectorRecipient: value.collectorAuthority }));
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring an unknown account role', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    value.instructions[2].accounts[0].role = 'nonexistent-role';
    return value;
  });
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring an invalid discriminator', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    value.instructions[2].discriminatorHex = 'zz';
    return value;
  });
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a binding declaring a non-empty address lookup table list', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, addressLookupTables: ['placeholder'] }));
  assert.throws(() => assertCollectorBuybackBindingV1(binding, expectedDigest), CollectorBuybackPolicyError);
});

test('refuses a candidate transaction paying a different proceeds destination', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ proceedsDestinationKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction naming a different collector recipient', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ collectorRecipientKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction settling a different opened asset', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ openedAssetMintKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction signed by a different collector authority co-signer', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ authorityKey: Keypair.generate() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction moving proceeds to a different mint', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ proceedsMintKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction crediting a different proceeds amount than the persisted quote', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ amountAtomic: '2000000' }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction encoding a different minimum than the persisted fact', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ minimumAtomic: '1' }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction with a swapped instruction order', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ instructionOrder: ['price', 'limit', 'settle', 'transfer'] }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction using a different blockhash than the trusted context', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ blockhash: Keypair.generate().publicKey.toBase58() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction observed after its trusted deadline has expired', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction(), { currentBlockHeight: '1500' });
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction carrying an extra instruction', async () => {
  const policy = createCollectorBuybackPolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ extraInstruction: true }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});
