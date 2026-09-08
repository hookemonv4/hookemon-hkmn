import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  COLLECTOR_PURCHASE_BINDING_SCHEMA,
  CollectorPurchasePolicyError,
  assertCollectorPurchaseBindingV1,
  createCollectorPurchasePolicy,
} from '../../src/signing/collector-purchase-policy.mjs';
import { TransactionPolicyError, decodeProviderTransaction, evaluate } from '../../src/signing/transaction-policy.mjs';

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PREFIX = 'collector-purchase:v1:';

const operator = Keypair.generate();
const coSigner = Keypair.generate();
const sourceAta = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const destination = Keypair.generate().publicKey;
const recentBlockhash = Keypair.generate().publicKey.toBase58();

const RAW_BINDING = Object.freeze({
  schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  settlement: {
    destination: destination.toBase58(),
    mint: mint.toBase58(),
    decimals: 6,
  },
  providerCoSigner: coSigner.publicKey.toBase58(),
  instructions: [
    {
      kind: 'compute-budget-set-unit-limit',
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      accounts: [],
      computeUnitLimit: 40000,
      priorityFeeCapAtomic: null,
      memoPrefix: null,
    },
    {
      kind: 'compute-budget-set-unit-price',
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      accounts: [],
      computeUnitLimit: null,
      priorityFeeCapAtomic: '5000',
      memoPrefix: null,
    },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'source-ata', isSigner: false, isWritable: true },
        { role: 'settlement-mint', isSigner: false, isWritable: false },
        { role: 'settlement-destination', isSigner: false, isWritable: true },
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      memoPrefix: null,
    },
    {
      kind: 'unknown',
      programId: MEMO_PROGRAM_ID,
      accounts: [
        { role: 'provider-co-signer', isSigner: true, isWritable: false },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      memoPrefix: MEMO_PREFIX,
    },
  ],
});
const EXPECTED_DIGEST = digest(RAW_BINDING);

const CYCLE_FACTS = Object.freeze({
  operatorFeePayer: operator.publicKey.toBase58(),
  sourceAta: sourceAta.toBase58(),
  amountAtomic: '1000000',
  memoValue: 'cycle-0001',
  requestDigest: digest({ schema: 'test.collector-purchase-request.v1', cycleId: 'cycle-0001' }),
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

function buildCandidateTransaction(overrides = {}) {
  const {
    feePayer = operator,
    coSignerKey = coSigner,
    sourceAtaKey = sourceAta,
    mintKey = mint,
    destinationKey = destination,
    destinationWritable = true,
    sourceWritable = true,
    amountAtomic = CYCLE_FACTS.amountAtomic,
    decimals = RAW_BINDING.settlement.decimals,
    computeUnitLimit = RAW_BINDING.instructions[0].computeUnitLimit,
    priorityFeeMicroLamports = 4000,
    memoText = `${MEMO_PREFIX}${CYCLE_FACTS.memoValue}`,
    blockhash = BLOCKHASH_CONTEXT.blockhash,
    instructionOrder = ['limit', 'price', 'transfer', 'memo'],
    extraInstruction = false,
  } = overrides;

  const instructionsByKind = {
    limit: ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    price: ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    transfer: new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: sourceAtaKey, isSigner: false, isWritable: sourceWritable },
        { pubkey: mintKey, isSigner: false, isWritable: false },
        { pubkey: destinationKey, isSigner: false, isWritable: destinationWritable },
        { pubkey: feePayer.publicKey, isSigner: true, isWritable: false },
      ],
      data: transferCheckedData(amountAtomic, decimals),
    }),
    memo: new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [{ pubkey: coSignerKey.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  };

  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash });
  for (const kind of instructionOrder) transaction.add(instructionsByKind[kind]);
  if (extraInstruction) {
    transaction.add(new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: feePayer.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.alloc(0),
    }));
  }
  transaction.partialSign(feePayer, coSignerKey);
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

test('accepts a legacy Collector purchase transaction built exactly from the binding and facts', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction());
  const result = evaluate(policy, decoded);
  assert.equal(result.allowed, true);
  assert.equal(result.ruleId, 'collector-purchase-v1');
});

test('refuses a factory input that adds a candidate-shaped field beside the trusted inputs', () => {
  assert.throws(
    () => createCollectorPurchasePolicy(factoryInput({ candidateTransaction: 'anything' })),
    CollectorPurchasePolicyError,
  );
});

test('refuses construction with no blockhash context at all', () => {
  const input = factoryInput();
  delete input.blockhashContext;
  assert.throws(() => createCollectorPurchasePolicy(input), CollectorPurchasePolicyError);
});

test('refuses construction with an incomplete durable cycle fact set', () => {
  const { memoValue, ...incompleteFacts } = CYCLE_FACTS;
  assert.throws(
    () => createCollectorPurchasePolicy(factoryInput({ cycleFacts: incompleteFacts })),
    CollectorPurchasePolicyError,
  );
});

test('refuses a blockhash context whose current height already passed the last valid height', () => {
  assert.throws(
    () => createCollectorPurchasePolicy(factoryInput({
      blockhashContext: { ...BLOCKHASH_CONTEXT, currentBlockHeight: '1500' },
    })),
    CollectorPurchasePolicyError,
  );
});

test('refuses a binding digest that does not match the externally supplied expected digest', () => {
  const wrongDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => assertCollectorPurchaseBindingV1(RAW_BINDING, wrongDigest), CollectorPurchasePolicyError);
});

test('refuses a binding with an extra unexpected field', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, extra: 'nope' }));
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, expectedDigest), CollectorPurchasePolicyError);
});

test('refuses a binding missing a required field', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    const { providerCoSigner, ...rest } = value;
    return rest;
  });
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, expectedDigest), CollectorPurchasePolicyError);
});

test('refuses a binding declaring an unknown account role', () => {
  const { binding, expectedDigest } = mutatedBinding((value) => {
    value.instructions[2].accounts[0].role = 'nonexistent-role';
    return value;
  });
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, expectedDigest), CollectorPurchasePolicyError);
});

test('refuses a binding declaring an invalid Solana public key', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, providerCoSigner: 'not-a-valid-key' }));
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, expectedDigest), CollectorPurchasePolicyError);
});

test('refuses a binding declaring an accessor property instead of plain data', () => {
  const binding = structuredClone(RAW_BINDING);
  Object.defineProperty(binding, 'provider', { get: () => 'collector-crypt', enumerable: true, configurable: true });
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, EXPECTED_DIGEST), CollectorPurchasePolicyError);
});

test('refuses a binding declaring the unsupported v0 format', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, format: 'v0' }));
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, expectedDigest), CollectorPurchasePolicyError);
});

test('refuses a binding declaring a non-empty address lookup table list', () => {
  const { binding, expectedDigest } = mutatedBinding(value => ({ ...value, addressLookupTables: ['placeholder'] }));
  assert.throws(() => assertCollectorPurchaseBindingV1(binding, expectedDigest), CollectorPurchasePolicyError);
});

test('refuses a candidate transaction paying a different settlement destination', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ destinationKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction with a swapped instruction order', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ instructionOrder: ['price', 'limit', 'transfer', 'memo'] }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction with a flipped account writable flag', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ sourceWritable: false }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction signed by a different operator fee payer', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ feePayer: Keypair.generate() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction moving funds from a different source ATA', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ sourceAtaKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction signed by a different provider co-signer', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ coSignerKey: Keypair.generate() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction using a different settlement mint', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ mintKey: Keypair.generate().publicKey }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction using the wrong settlement decimals', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ decimals: 9 }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction moving a different amount than the durable fact', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ amountAtomic: '2000000' }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction carrying a different memo', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ memoText: `${MEMO_PREFIX}forged-cycle` }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction declaring a different exact compute unit limit', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ computeUnitLimit: 50000 }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction whose priority fee exceeds the binding cap', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ priorityFeeMicroLamports: 6000 }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction using a different blockhash than the trusted context', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ blockhash: Keypair.generate().publicKey.toBase58() }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction observed after its trusted deadline has expired', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction(), { currentBlockHeight: '1500' });
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a candidate transaction carrying an extra instruction', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const decoded = await decodeCandidate(buildCandidateTransaction({ extraInstruction: true }));
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});

test('refuses a v0 candidate transaction because the binding only ever authorizes legacy transactions', async () => {
  const policy = createCollectorPurchasePolicy(factoryInput());
  const message = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: BLOCKHASH_CONTEXT.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 4000 }),
      new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROGRAM_ID),
        keys: [
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: operator.publicKey, isSigner: true, isWritable: false },
        ],
        data: transferCheckedData(CYCLE_FACTS.amountAtomic, RAW_BINDING.settlement.decimals),
      }),
      new TransactionInstruction({
        programId: new PublicKey(MEMO_PROGRAM_ID),
        keys: [{ pubkey: coSigner.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.from(`${MEMO_PREFIX}${CYCLE_FACTS.memoValue}`, 'utf8'),
      }),
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([operator, coSigner]);
  const transactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
  const decoded = await decodeCandidate(transactionBase64);
  assert.throws(() => evaluate(policy, decoded), TransactionPolicyError);
});
