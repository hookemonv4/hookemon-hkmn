import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signEd25519 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  TRANSACTION_POLICY_SCHEMA,
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
  evaluate,
  readTransactionPolicyRules,
  revalidateSignedMessage,
} from '../../src/signing/transaction-policy.mjs';
import * as signerClientModule from '../../src/signing/signer-client.mjs';
import { isTransactionPolicySignerClient, wrapSignerClient, wrapTransactionPolicySignerClient } from '../../src/signing/signer-client.mjs';

const fixtureSignerOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/transactions/${name}.json`, import.meta.url), 'utf8'));
}

const solanaContext = fixture('solana-context');

function solanaInput(transaction, options = {}) {
  const lastValidBlockHeight = options.lastValidBlockHeight ?? transaction.lastValidBlockHeight ?? solanaContext.lastValidBlockHeight;
  return {
    family: 'solana',
    transaction: transaction.transactionBase64 ?? transaction.messageBase64,
    chainId: solanaContext.chainId,
    lastValidBlockHeight,
    currentBlockHeight: options.currentBlockHeight ?? transaction.currentBlockHeight ?? solanaContext.currentBlockHeight,
    lookupTableResolver: options.lookupTableResolver,
    lookupTableRpc: options.lookupTableRpc,
    blockhashContextResolver: Object.hasOwn(options, 'blockhashContextResolver')
      ? options.blockhashContextResolver
      : async blockhash => ({ blockhash, lastValidBlockHeight }),
  };
}

function lookupTableResolver() {
  return async key => {
    const table = solanaContext.lookupTables.find(candidate => candidate.key === key.toBase58());
    if (!table) return null;
    return addressLookupTable(table);
  };
}

function addressLookupTable(table) {
  return new AddressLookupTableAccount({
    key: new PublicKey(table.key),
    state: {
      deactivationSlot: (2n ** 64n) - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: table.addresses.map(address => new PublicKey(address)),
    },
  });
}

function amountRule(amount) {
  return amount === null ? null : { exact: structuredClone(amount) };
}

function instructionRule(instruction) {
  const semanticDataKinds = new Set([
    'compute-budget-set-unit-limit',
    'compute-budget-set-unit-price',
    'erc20-transfer',
    'spl-transfer-checked',
    'system-transfer',
  ]);
  return {
    kind: instruction.kind,
    programId: instruction.programId,
    instructionId: instruction.instructionId,
    data: semanticDataKinds.has(instruction.kind) ? 'semantic' : instruction.data,
    accounts: structuredClone(instruction.accounts),
    source: instruction.source,
    destination: instruction.destination,
    mint: instruction.mint,
    token: instruction.token,
    amount: amountRule(instruction.amount),
    nativeValue: amountRule(instruction.nativeValue),
    computeUnitLimit: instruction.computeUnitLimit,
    priorityFee: amountRule(instruction.priorityFee),
  };
}

function gasRule(gas) {
  return Object.fromEntries(Object.entries(gas).map(([key, value]) => [
    key,
    value && typeof value === 'object' && 'amountAtomic' in value ? amountRule(value) : value,
  ]));
}

function policyRuleFor(decoded, id = 'fixture-allow') {
  return {
      id,
      family: decoded.family,
      format: decoded.format,
      chainId: decoded.chainId,
      nonce: decoded.nonce,
      programIds: structuredClone(decoded.programIds),
      addressLookupTables: structuredClone(decoded.addressLookupTables),
      target: decoded.target,
      selector: decoded.selector,
      source: decoded.source,
      destination: decoded.destination,
      mint: decoded.mint,
      token: decoded.token,
      amount: amountRule(decoded.amount),
      nativeValue: amountRule(decoded.nativeValue),
      gas: gasRule(decoded.gas),
      feePayer: decoded.feePayer,
      requiredSigners: structuredClone(decoded.requiredSigners),
      coSigners: structuredClone(decoded.coSigners),
      instructions: decoded.instructions.map(instructionRule),
      extraInstructions: decoded.extraInstructions.map(instructionRule),
      blockhash: structuredClone(decoded.blockhash),
      deadline: structuredClone(decoded.deadline),
      priorityFee: amountRule(decoded.priorityFee),
  };
}

function policyFor(decoded, id = 'fixture-allow') {
  return createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage: 'payout' }),
    rules: [policyRuleFor(decoded, id)],
  });
}

function withPolicyRules(policy, mutate) {
  const rules = structuredClone(readTransactionPolicyRules(policy));
  mutate(rules);
  return createTransactionPolicy({ policy: structuredClone(policy), rules });
}

const INDEPENDENT_SOLANA_AMOUNT = Object.freeze({
  chainId: 'solana-mainnet',
  assetId: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
  decimals: 6,
  amountAtomic: '1000',
});
const INDEPENDENT_SOLANA_PRIORITY_FEE = Object.freeze({
  chainId: 'solana-mainnet',
  assetId: 'microlamports-per-compute-unit',
  decimals: 0,
  amountAtomic: '2',
});

function independentSolanaPolicy(format, addressLookupTables) {
  const operator = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
  const coSigner = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu';
  const source = 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse';
  const mint = 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1';
  const destination = '8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe';
  const computeBudget = 'ComputeBudget111111111111111111111111111111';
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const limit = {
    kind: 'compute-budget-set-unit-limit', programId: computeBudget, instructionId: 'set-compute-unit-limit',
    data: 'AkANAwA=', accounts: [], source: null, destination: null, mint: null, token: null,
    amount: null, nativeValue: null, computeUnitLimit: '200000', priorityFee: null,
  };
  const price = {
    kind: 'compute-budget-set-unit-price', programId: computeBudget, instructionId: 'set-compute-unit-price',
    data: 'AwIAAAAAAAAA', accounts: [], source: null, destination: null, mint: null, token: null,
    amount: null, nativeValue: null, computeUnitLimit: null, priorityFee: { exact: INDEPENDENT_SOLANA_PRIORITY_FEE },
  };
  const transfer = {
    kind: 'spl-transfer-checked', programId: tokenProgram, instructionId: 'transfer-checked', data: 'semantic',
    accounts: [
      { address: source, isSigner: false, isWritable: true },
      { address: mint, isSigner: false, isWritable: false },
      { address: destination, isSigner: false, isWritable: true },
      { address: coSigner, isSigner: true, isWritable: false },
    ],
    source, destination, mint, token: mint, amount: { exact: INDEPENDENT_SOLANA_AMOUNT }, nativeValue: null,
    computeUnitLimit: null, priorityFee: null,
  };
  const rule = {
      id: `independent-${format}-transfer`, family: 'solana', format, chainId: 'solana-mainnet', nonce: null,
      programIds: [computeBudget, tokenProgram], addressLookupTables, target: null, selector: null,
      source, destination, mint, token: mint, amount: { exact: INDEPENDENT_SOLANA_AMOUNT }, nativeValue: null,
      gas: { computeUnitLimit: '200000', pricePerComputeUnit: { exact: INDEPENDENT_SOLANA_PRIORITY_FEE } },
      feePayer: operator, requiredSigners: [operator, coSigner], coSigners: [coSigner],
      instructions: [limit, price, transfer], extraInstructions: [limit, price],
      blockhash: 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf',
      deadline: { type: 'block-height', notExpired: true, minLastValidBlockHeight: '100', maxLastValidBlockHeight: '100' },
      priorityFee: { exact: INDEPENDENT_SOLANA_PRIORITY_FEE },
  };
  return createTransactionPolicy({
    policy: {
      schema: TRANSACTION_POLICY_SCHEMA,
      chainId: 'solana-mainnet',
      stage: 'payout',
      requestDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      expectedRecipient: destination,
      amount: INDEPENDENT_SOLANA_AMOUNT,
      allowedTargets: [],
      allowedPrograms: [computeBudget, tokenProgram],
    },
    rules: [rule],
  });
}

function independentErc20Policy() {
  const token = '0x1111111111111111111111111111111111111111';
  const source = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
  const destination = '0x2222222222222222222222222222222222222222';
  const amount = { chainId: '4663', assetId: token, decimals: 6, amountAtomic: '1000' };
  const native = { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' };
  const fee = { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' };
  const rule = {
      id: 'independent-erc20-transfer', family: 'evm', format: 'evm', chainId: '4663', nonce: '7',
      programIds: [token], addressLookupTables: [], target: token, selector: '0xa9059cbb', source, destination,
      mint: token, token, amount: { exact: amount }, nativeValue: { exact: native },
      gas: {
        limit: '65000', gasPrice: null,
        maxFeePerGas: { exact: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '5' } },
        maxPriorityFeePerGas: { exact: fee },
      },
      feePayer: source, requiredSigners: [source], coSigners: [],
      instructions: [{
        kind: 'erc20-transfer', programId: token, instructionId: '0xa9059cbb', data: 'semantic', accounts: [],
        source, destination, mint: token, token, amount: { exact: amount }, nativeValue: { exact: native },
        computeUnitLimit: null, priorityFee: null,
      }],
      extraInstructions: [], blockhash: null, deadline: null, priorityFee: { exact: fee },
  };
  return createTransactionPolicy({
    policy: {
      schema: TRANSACTION_POLICY_SCHEMA,
      chainId: '4663',
      stage: 'payout',
      requestDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      expectedRecipient: destination,
      amount,
      allowedTargets: [token],
      allowedPrograms: [],
    },
    rules: [rule],
  });
}

const ALLOWLIST_FIELDS = Object.freeze([
  'family', 'format', 'chainId', 'nonce', 'programIds', 'addressLookupTables', 'target', 'selector',
  'source', 'destination', 'mint', 'token', 'amount', 'nativeValue', 'gas', 'feePayer',
  'requiredSigners', 'coSigners', 'instructions', 'extraInstructions', 'blockhash', 'deadline', 'priorityFee',
]);

function mismatchedAmountConstraint(value) {
  if (value === null) return { exact: structuredClone(INDEPENDENT_SOLANA_AMOUNT) };
  const mismatch = structuredClone(value);
  const amount = mismatch.exact;
  assert.ok(amount, 'independent test policy must use an exact amount constraint');
  amount.amountAtomic = amount.amountAtomic === '0' ? '1' : '0';
  return mismatch;
}

function oneFieldMismatch(policy, field) {
  const canonicalPolicy = structuredClone(policy);
  const rules = structuredClone(readTransactionPolicyRules(policy));
  const rule = rules[0];
  const differentString = value => (value === 'mismatch' ? 'different' : 'mismatch');
  switch (field) {
    case 'family':
    case 'format':
    case 'chainId':
    case 'target':
    case 'selector':
    case 'source':
    case 'destination':
    case 'mint':
    case 'token':
    case 'feePayer':
    case 'blockhash':
      rule[field] = differentString(rule[field]);
      break;
    case 'nonce':
      rule.nonce = rule.nonce === null ? '1' : '0';
      break;
    case 'programIds':
    case 'addressLookupTables':
    case 'requiredSigners':
    case 'coSigners':
      rule[field] = [differentString(rule[field][0] ?? '')];
      break;
    case 'amount':
    case 'nativeValue':
    case 'priorityFee':
      rule[field] = mismatchedAmountConstraint(rule[field]);
      break;
    case 'gas': {
      const key = Object.keys(rule.gas).find(candidate => rule.gas[candidate] !== null);
      assert.ok(key, 'independent test policy must constrain one gas field');
      rule.gas[key] = typeof rule.gas[key] === 'object'
        ? mismatchedAmountConstraint(rule.gas[key])
        : differentString(rule.gas[key]);
      break;
    }
    case 'instructions':
      rule.instructions[0].kind = differentString(rule.instructions[0].kind);
      break;
    case 'extraInstructions':
      if (rule.extraInstructions.length === 0) rule.extraInstructions = [structuredClone(rule.instructions[0])];
      else rule.extraInstructions[0].kind = differentString(rule.extraInstructions[0].kind);
      break;
    case 'deadline':
      if (rule.deadline === null) rule.deadline = { type: 'block-height', notExpired: true };
      else rule.deadline.maxLastValidBlockHeight = '99';
      break;
    default:
      throw new Error(`missing independent mismatch for ${field}`);
  }
  return createTransactionPolicy({ policy: canonicalPolicy, rules });
}

function signedSolanaTransaction(format) {
  const operator = Keypair.generate();
  const coSigner = Keypair.generate();
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: operator.publicKey, isSigner: true, isWritable: false },
      { pubkey: coSigner.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
  if (format === 'legacy') {
    const transaction = new Transaction({
      feePayer: operator.publicKey,
      recentBlockhash: SystemProgram.programId.toBase58(),
    }).add(instruction);
    transaction.partialSign(operator, coSigner);
    return Buffer.from(transaction.serialize()).toString('base64');
  }
  const message = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: SystemProgram.programId.toBase58(),
    instructions: [instruction],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([operator, coSigner]);
  return Buffer.from(transaction.serialize()).toString('base64');
}

function signedSolanaFixture(format = 'legacy') {
  return {
    transactionBase64: signedSolanaTransaction(format),
    lastValidBlockHeight: '100',
    currentBlockHeight: '99',
  };
}

test('decodes an unsigned ERC-20 transfer into typed semantic fields', async () => {
  const transfer = fixture('evm-erc20-transfer');
  const decoded = await decodeProviderTransaction({
    family: 'evm',
    transaction: transfer.transaction,
    tokenMetadata: {
      [transfer.token]: { assetId: transfer.token, decimals: transfer.decimals },
    },
  });

  assert.equal(decoded.family, 'evm');
  assert.equal(decoded.chainId, '4663');
  assert.equal(decoded.target, transfer.token.toLowerCase());
  assert.equal(decoded.selector, '0xa9059cbb');
  assert.equal(decoded.source, transfer.source.toLowerCase());
  assert.equal(decoded.destination, transfer.recipient.toLowerCase());
  assert.deepEqual(decoded.amount, {
    chainId: '4663',
    assetId: transfer.token.toLowerCase(),
    decimals: 6,
    amountAtomic: '1000',
  });
});

test('decodes a raw signed ERC-20 transfer and recovers its fee payer', async () => {
  const transfer = fixture('evm-erc20-transfer');
  const decoded = await decodeProviderTransaction({
    family: 'evm',
    transaction: transfer.signedTx,
    tokenMetadata: {
      [transfer.token]: { assetId: transfer.token, decimals: transfer.decimals },
    },
  });

  assert.equal(decoded.source, transfer.source.toLowerCase());
  assert.equal(decoded.feePayer, transfer.source.toLowerCase());
  assert.equal(decoded.instructions[0].kind, 'erc20-transfer');
});

test('decodes a Relay-style EVM call without inventing a token transfer', async () => {
  const relay = fixture('evm-relay-step');
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction: relay.transaction });

  assert.equal(decoded.target, relay.target.toLowerCase());
  assert.equal(decoded.selector, '0x12345678');
  assert.equal(decoded.destination, relay.target.toLowerCase());
  assert.equal(decoded.token, null);
  assert.equal(decoded.amount, null);
  assert.deepEqual(decoded.nativeValue, {
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    amountAtomic: '42',
  });
});

test('decodes an unsigned EVM object with no provider source as an explicitly source-less request', async () => {
  const relay = fixture('evm-relay-step');
  const transaction = structuredClone(relay.transaction);
  delete transaction.from;
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction });

  assert.equal(decoded.source, null);
  assert.equal(decoded.feePayer, null);
  assert.deepEqual(decoded.requiredSigners, []);
  assert.equal(decoded.destination, relay.target.toLowerCase());
});

test('rejects EVM typed transaction fields that the policy schema does not model', async () => {
  const relay = fixture('evm-relay-step');
  for (const extraFields of [
    { type: 'eip2930' },
    { type: 'eip1559', accessList: [] },
    { type: 'eip1559', authorizationList: [] },
    {
      type: 'eip1559',
      maxFeePerBlobGas: '1',
      blobVersionedHashes: ['0x0100000000000000000000000000000000000000000000000000000000000000'],
    },
  ]) {
    await assert.rejects(
      decodeProviderTransaction({
        family: 'evm',
        transaction: { ...relay.transaction, ...extraFields },
      }),
      /does not support EVM typed transaction field|does not support EVM transaction type/,
    );
  }
});

test('rejects an unsafe JavaScript number in an EVM atomic transaction field', async () => {
  const relay = fixture('evm-relay-step');
  await assert.rejects(
    decodeProviderTransaction({
      family: 'evm',
      transaction: { ...relay.transaction, value: 9_007_199_254_740_993 },
    }),
    /EVM transaction value must not be an unsafe JavaScript number/,
  );
});

test('rejects a nonnumeric EVM atomic transaction value', async () => {
  const relay = fixture('evm-relay-step');
  await assert.rejects(
    decodeProviderTransaction({
      family: 'evm',
      transaction: { ...relay.transaction, value: true },
    }),
    /amountAtomic must be an integer/,
  );
});

test('binds an EVM nonce into the decoded policy semantics', async () => {
  const transfer = fixture('evm-erc20-transfer');
  const tokenMetadata = { [transfer.token]: { assetId: transfer.token, decimals: transfer.decimals } };
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction: transfer.transaction, tokenMetadata });
  const nextNonce = await decodeProviderTransaction({
    family: 'evm',
    transaction: { ...transfer.transaction, nonce: '8' },
    tokenMetadata,
  });

  assert.equal(decoded.nonce, '7');
  assert.notEqual(nextNonce.nonce, decoded.nonce);
});

test('decodes a legacy Solana transaction with a pre-existing co-signer', async () => {
  const transaction = fixture('solana-legacy');
  const decoded = await decodeProviderTransaction(solanaInput(transaction));

  assert.equal(decoded.family, 'solana');
  assert.equal(decoded.format, 'legacy');
  assert.equal(decoded.feePayer, solanaContext.publicKeys.operator);
  assert.deepEqual(decoded.requiredSigners, [solanaContext.publicKeys.operator, solanaContext.publicKeys.coSigner]);
  assert.deepEqual(decoded.coSigners, [solanaContext.publicKeys.coSigner]);
  assert.equal(decoded.mint, solanaContext.publicKeys.mint);
  assert.equal(decoded.destination, solanaContext.publicKeys.destination);
  assert.deepEqual(decoded.amount, {
    chainId: solanaContext.chainId,
    assetId: solanaContext.publicKeys.mint,
    decimals: 6,
    amountAtomic: '1000',
  });
  assert.equal(decoded.blockhash, solanaContext.publicKeys.recentBlockhash);
  assert.deepEqual(decoded.priorityFee, {
    chainId: solanaContext.chainId,
    assetId: 'microlamports-per-compute-unit',
    decimals: 0,
    amountAtomic: '2',
  });
});

test('treats the last valid Solana block height as valid and expires only above it', async () => {
  const transaction = fixture('solana-legacy');
  const atLastValidHeight = await decodeProviderTransaction(solanaInput(transaction, {
    lastValidBlockHeight: '100',
    currentBlockHeight: '100',
  }));
  const aboveLastValidHeight = await decodeProviderTransaction(solanaInput(transaction, {
    lastValidBlockHeight: '100',
    currentBlockHeight: '101',
  }));

  assert.equal(atLastValidHeight.deadline.expired, false);
  assert.equal(aboveLastValidHeight.deadline.expired, true);
});

test('decodes a v0 Solana transaction without address lookup tables', async () => {
  const transaction = fixture('solana-v0');
  const decoded = await decodeProviderTransaction(solanaInput(transaction));

  assert.equal(decoded.format, 'v0');
  assert.deepEqual(decoded.addressLookupTables, []);
  assert.equal(decoded.destination, solanaContext.publicKeys.destination);
});

test('decodes bare legacy and v0 Solana messages', async () => {
  const legacy = await decodeProviderTransaction(solanaInput(fixture('solana-legacy-message')));
  const v0 = await decodeProviderTransaction(solanaInput(fixture('solana-v0-message')));

  assert.equal(legacy.format, 'legacy');
  assert.equal(v0.format, 'v0');
  assert.equal(legacy.destination, solanaContext.publicKeys.destination);
  assert.equal(v0.destination, solanaContext.publicKeys.destination);
});

test('resolves address lookup tables through the injected read-only resolver', async () => {
  const transaction = fixture('solana-v0-alt');
  const decoded = await decodeProviderTransaction(solanaInput(transaction, { lookupTableResolver: lookupTableResolver() }));

  assert.equal(decoded.format, 'v0');
  assert.deepEqual(decoded.addressLookupTables, [solanaContext.publicKeys.altKey]);
  assert.equal(decoded.destination, solanaContext.publicKeys.destination);
  assert.equal(decoded.instructions.at(-1).programId, solanaContext.publicKeys.tokenProgram);
});

test('resolves address lookup tables through the read-only RPC interface', async () => {
  const transaction = fixture('solana-v0-alt');
  const decoded = await decodeProviderTransaction(solanaInput(transaction, {
    lookupTableResolver: undefined,
    lookupTableRpc: {
      async getAddressLookupTable(key) {
        const table = solanaContext.lookupTables.find(candidate => candidate.key === key.toBase58());
        return { value: table ? addressLookupTable(table) : null };
      },
    },
  }));

  assert.equal(decoded.destination, solanaContext.publicKeys.destination);
});

test('rejects a v0 address lookup table that resolves to an unapproved account layout', async () => {
  const approvedFixture = fixture('solana-v0-alt');
  const approved = await decodeProviderTransaction(solanaInput(approvedFixture, { lookupTableResolver: lookupTableResolver() }));
  const policy = independentSolanaPolicy('v0', [solanaContext.publicKeys.altKey]);
  assert.equal(evaluate(policy, approved).allowed, true);
  const alteredFixture = fixture('solana-v0-alt-wrong-resolution');
  const altered = await decodeProviderTransaction(solanaInput(alteredFixture, {
    lookupTableResolver: async () => addressLookupTable(alteredFixture.lookupTable),
  }));

  assert.throws(
    () => evaluate(policy, altered),
    /not explicitly allowed/,
  );
});

test('rejects an inactive Solana address lookup table before decoding a v0 transaction', async () => {
  const transaction = fixture('solana-v0-alt');
  const table = solanaContext.lookupTables[0];
  const inactive = new AddressLookupTableAccount({
    key: new PublicKey(table.key),
    state: {
      deactivationSlot: 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: table.addresses.map(address => new PublicKey(address)),
    },
  });

  await assert.rejects(
    decodeProviderTransaction(solanaInput(transaction, { lookupTableResolver: async () => inactive })),
    /inactive/,
  );
});

test('resolves address lookup tables for a bare v0 Solana message', async () => {
  const message = fixture('solana-v0-alt-message');
  const decoded = await decodeProviderTransaction(solanaInput(message, { lookupTableResolver: lookupTableResolver() }));

  assert.equal(decoded.format, 'v0');
  assert.deepEqual(decoded.addressLookupTables, [solanaContext.publicKeys.altKey]);
  assert.equal(decoded.destination, solanaContext.publicKeys.destination);
});

test('rejects a v0 transaction whose lookup table cannot be resolved through an injected read-only interface', async () => {
  const transaction = fixture('solana-v0-alt');
  await assert.rejects(
    decodeProviderTransaction(solanaInput(transaction)),
    /requires an injected read-only address lookup table resolver/,
  );
});

test('allows only the exact ERC-20 transfer rule and rejects the wrong recipient and chain fixtures', async () => {
  const transfer = fixture('evm-erc20-transfer');
  const tokenMetadata = { [transfer.token]: { assetId: transfer.token, decimals: transfer.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: transfer.transaction, tokenMetadata });
  const policy = independentErc20Policy();

  assert.deepEqual(evaluate(policy, approved), {
    schema: TRANSACTION_POLICY_SCHEMA,
    allowed: true,
    ruleId: 'independent-erc20-transfer',
  });

  const wrongRecipient = fixture('evm-wrong-recipient');
  const wrongRecipientDecoded = await decodeProviderTransaction({
    family: 'evm',
    transaction: wrongRecipient.signedTx,
    tokenMetadata,
  });
  assert.throws(() => evaluate(policy, wrongRecipientDecoded), /not explicitly allowed/);

  const wrongChain = fixture('evm-wrong-chain');
  const wrongChainDecoded = await decodeProviderTransaction({ family: 'evm', transaction: wrongChain.transaction, tokenMetadata });
  assert.throws(() => evaluate(policy, wrongChainDecoded), /not explicitly allowed/);
});

test('applies Solana rules byte-for-byte and rejects every negative fixture', async () => {
  const approvedFixture = fixture('solana-legacy');
  const approved = await decodeProviderTransaction(solanaInput(approvedFixture));
  const policy = independentSolanaPolicy('legacy', []);
  const amountBound = {
    chainId: approved.amount.chainId,
    assetId: approved.amount.assetId,
    decimals: approved.amount.decimals,
    maxAtomic: approved.amount.amountAtomic,
  };
  const bounded = withPolicyRules(policy, rules => {
    rules[0].amount = amountBound;
    rules[0].instructions.find(instruction => instruction.kind === 'spl-transfer-checked').amount = amountBound;
  });

  assert.equal(evaluate(bounded, approved).allowed, true);

  for (const name of [
    'solana-wrong-recipient',
    'solana-wrong-mint',
    'solana-extra-instruction',
    'solana-amount-above-bound',
    'solana-foreign-fee-payer',
    'solana-expired-blockhash',
  ]) {
    const candidate = fixture(name);
    const decoded = await decodeProviderTransaction(solanaInput(candidate));
    assert.throws(() => evaluate(bounded, decoded), /not explicitly allowed|expired/);
  }

  const alteredCasePolicy = withPolicyRules(bounded, rules => {
    rules[0].feePayer = rules[0].feePayer.replace(/[A-Z]/, letter => letter.toLowerCase());
  });
  assert.notEqual(readTransactionPolicyRules(alteredCasePolicy)[0].feePayer, approved.feePayer);
  assert.throws(() => evaluate(alteredCasePolicy, approved), /not explicitly allowed/);
});

test('independent policies reject a one-field allowlist mismatch for EVM, legacy Solana, and v0 ALT', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const cases = [
    {
      name: 'EVM',
      policy: independentErc20Policy(),
      decoded: await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata }),
    },
    {
      name: 'legacy Solana',
      policy: independentSolanaPolicy('legacy', []),
      decoded: await decodeProviderTransaction(solanaInput(fixture('solana-legacy'))),
    },
    {
      name: 'v0 Solana with ALT',
      policy: independentSolanaPolicy('v0', [solanaContext.publicKeys.altKey]),
      decoded: await decodeProviderTransaction(solanaInput(fixture('solana-v0-alt'), { lookupTableResolver: lookupTableResolver() })),
    },
  ];

  for (const entry of cases) {
    assert.equal(evaluate(entry.policy, entry.decoded).allowed, true, `${entry.name} independently authored baseline`);
    for (const field of ALLOWLIST_FIELDS) {
      assert.throws(
        () => evaluate(oneFieldMismatch(entry.policy, field), entry.decoded),
        /not explicitly allowed|deadline is after its explicit bound/,
        `${entry.name} must reject a mismatch in ${field}`,
      );
    }
  }
});

test('re-decodes signed messages and rejects any semantic change before broadcast', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approvedEvm = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  const revalidatedEvm = await revalidateSignedMessage({ signedTx: evm.signedTx }, approvedEvm, { tokenMetadata });
  assert.deepEqual(revalidatedEvm, approvedEvm);

  const wrongRecipient = fixture('evm-wrong-recipient');
  await assert.rejects(
    revalidateSignedMessage({ signedTx: wrongRecipient.signedTx }, approvedEvm, { tokenMetadata }),
    /differs from its approved semantic description/,
  );

  const solana = signedSolanaFixture();
  const approvedSolana = await decodeProviderTransaction(solanaInput(solana));
  const revalidatedSolana = await revalidateSignedMessage(
    { signedTxBase64: solana.transactionBase64 },
    approvedSolana,
    { ...solanaInput(solana), currentBlockHeightResolver: async () => '99' },
  );
  assert.deepEqual(revalidatedSolana, approvedSolana);
});

test('requires a complete, valid signature set for every signed Solana transaction format', async () => {
  for (const format of ['legacy', 'v0']) {
    const transactionBase64 = signedSolanaTransaction(format);
    const input = {
      family: 'solana',
      chainId: 'solana-signature-test',
      transaction: transactionBase64,
      lastValidBlockHeight: '100',
      currentBlockHeight: '99',
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
      currentBlockHeightResolver: async () => '99',
    };
    const approved = await decodeProviderTransaction(input);
    const altered = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    altered.signatures[1][0] ^= 0xff;

    await assert.rejects(
      revalidateSignedMessage(
        { signedTxBase64: Buffer.from(altered.serialize()).toString('base64') },
        approved,
        input,
      ),
      /signature/i,
      `${format} must reject a corrupted co-signer signature`,
    );

    const zeroOperator = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    zeroOperator.signatures[0].fill(0);
    await assert.rejects(
      revalidateSignedMessage(
        { signedTxBase64: Buffer.from(zeroOperator.serialize()).toString('base64') },
        approved,
        input,
      ),
      /signature/i,
      `${format} must reject a zero operator signature`,
    );

    const zeroCoSigner = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    zeroCoSigner.signatures[1].fill(0);
    await assert.rejects(
      revalidateSignedMessage(
        { signedTxBase64: Buffer.from(zeroCoSigner.serialize()).toString('base64') },
        approved,
        input,
      ),
      /signature/i,
      `${format} must reject a zero co-signer signature`,
    );

    const wrongKey = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    const outsider = generateKeyPairSync('ed25519');
    wrongKey.signatures[1] = Uint8Array.from(signEd25519(null, Buffer.from(wrongKey.message.serialize()), outsider.privateKey));
    await assert.rejects(
      revalidateSignedMessage(
        { signedTxBase64: Buffer.from(wrongKey.serialize()).toString('base64') },
        approved,
        input,
      ),
      /signature/i,
      `${format} must reject a co-signer signature from another key`,
    );

    const bareMessage = fixture(`solana-${format}-message`).messageBase64;
    await assert.rejects(
      revalidateSignedMessage({ signedTxBase64: bareMessage }, approved, input),
      /complete serialized transaction|signature/i,
      `${format} must reject a bare message after signing`,
    );
  }
});

test('requires a fresh Solana height resolver while revalidating signed bytes', async () => {
  const transaction = signedSolanaFixture();
  const approved = await decodeProviderTransaction({
    ...solanaInput(transaction),
    currentBlockHeightResolver: async () => '99',
  });

  await assert.rejects(
    revalidateSignedMessage(
      { signedTxBase64: transaction.transactionBase64 },
      approved,
      solanaInput(transaction),
    ),
    /requires a currentBlockHeightResolver/,
  );
});

test('treats an unobserved Solana block height as unknown instead of not expired', async () => {
  const transaction = fixture('solana-legacy');
  const input = solanaInput(transaction);
  delete input.currentBlockHeight;
  const decoded = await decodeProviderTransaction(input);
  const policy = withPolicyRules(policyFor(decoded), rules => {
    rules[0].deadline = { type: 'block-height', notExpired: true };
  });

  assert.throws(() => evaluate(policy, decoded), /deadline is not explicitly allowed/);
});

test('refreshes an injected Solana height during revalidation and rejects an expired signed message', async () => {
  const transaction = signedSolanaFixture();
  const heights = ['99', '101'];
  const options = {
    ...solanaInput(transaction),
    currentBlockHeightResolver: async () => heights.shift(),
  };
  const approved = await decodeProviderTransaction(options);
  await assert.rejects(
    revalidateSignedMessage({ signedTxBase64: transaction.transactionBase64 }, approved, options),
    /deadline has expired/,
  );
});

test('rejects an absent response from a Solana current-block-height resolver', async () => {
  const transaction = fixture('solana-legacy');
  await assert.rejects(
    decodeProviderTransaction({
      ...solanaInput(transaction),
      currentBlockHeightResolver: async () => undefined,
    }),
    /currentBlockHeightResolver must return a canonical non-negative integer/,
  );
});

test('policy signer wrapper revalidates the returned bytes before an underlying broadcast', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  const calls = [];
  const client = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        calls.push('sign');
        return { signedTx: evm.signedTx };
      },
      async broadcast() {
        calls.push('broadcast');
        return { transactionHash: '0xaccepted' };
      },
    },
  });
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy: policyFor(approved),
    decodeOptions: { family: 'evm', tokenMetadata },
  });

  const signed = await protectedClient.sign(evm.transaction);
  const broadcast = await protectedClient.broadcast(signed);
  assert.equal(broadcast.transactionHash, '0xaccepted');
  assert.deepEqual(calls, ['sign', 'broadcast']);

  const alteredCalls = [];
  const alteredClient = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        alteredCalls.push('sign');
        return { signedTx: fixture('evm-wrong-recipient').signedTx };
      },
      async broadcast() {
        alteredCalls.push('broadcast');
        return { transactionHash: '0xshould-not-broadcast' };
      },
    },
  });
  const protectedAlteredClient = wrapTransactionPolicySignerClient({
    client: alteredClient,
    policy: policyFor(approved),
    decodeOptions: { family: 'evm', tokenMetadata },
  });
  const alteredSigned = await protectedAlteredClient.sign(evm.transaction);
  await assert.rejects(
    protectedAlteredClient.broadcast(alteredSigned),
    /differs from its approved semantic description/,
  );
  assert.deepEqual(alteredCalls, ['sign']);
});

test('policy signer reauthorizes exact durable bytes after restart without signing', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  const policy = policyFor(approved);
  const initialClient = wrapTransactionPolicySignerClient({
    client: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      inner: {
        async sign() { return { signedTx: evm.signedTx }; },
        async broadcast() { throw new Error('the original process must not broadcast'); },
      },
    }),
    policy,
    decodeOptions: { family: 'evm', tokenMetadata },
  });
  const signed = await initialClient.sign(evm.transaction);

  assert.equal(typeof signerClientModule.readTransactionPolicyApprovalContext, 'function');
  assert.equal(typeof signerClientModule.recoverTransactionPolicyBroadcast, 'function');
  const recoveryContext = signerClientModule.readTransactionPolicyApprovalContext(initialClient, signed);
  let freshSignCalls = 0;
  const broadcasts = [];
  const restartedClient = wrapTransactionPolicySignerClient({
    client: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      inner: {
        async sign() {
          freshSignCalls += 1;
          throw new Error('recovery must not sign');
        },
        async broadcast(candidate) {
          broadcasts.push(candidate.signedTx);
          return { transactionHash: '0xaccepted' };
        },
      },
    }),
    policy,
    decodeOptions: { family: 'evm', tokenMetadata },
  });

  const result = await signerClientModule.recoverTransactionPolicyBroadcast({
    client: restartedClient,
    signed,
    recoveryContext,
  });

  assert.equal(result.transactionHash, '0xaccepted');
  assert.equal(freshSignCalls, 0);
  assert.deepEqual(broadcasts, [evm.signedTx]);
});

test('policy approval hashes decoded EVM signed bytes instead of the transport string', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  const client = wrapTransactionPolicySignerClient({
    client: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      inner: {
        async sign() { return { signedTx: evm.signedTx }; },
        async broadcast() { throw new Error('broadcast is not part of this digest vector'); },
      },
    }),
    policy: policyFor(approved),
    decodeOptions: { family: 'evm', tokenMetadata },
  });

  const signed = await client.sign(evm.transaction);
  const approval = signerClientModule.readTransactionPolicyApprovalContext(client, signed);
  const rawBytesDigest = `sha256:${createHash('sha256').update(Buffer.from(evm.signedTx.slice(2), 'hex')).digest('hex')}`;

  assert.equal(rawBytesDigest, 'sha256:a8a982ea3da304d0bbf90cf3b3557cd32cec0a5fa018afc5d3e0534c68de174c');
  assert.equal(approval.signedMessageDigest, rawBytesDigest);
  assert.notEqual(approval.signedMessageDigest, `sha256:${createHash('sha256').update(evm.signedTx, 'utf8').digest('hex')}`);
});

test('policy signer restores an exact approval before a guarded facade broadcasts', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  const policy = policyFor(approved);
  const initialClient = wrapTransactionPolicySignerClient({
    client: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      inner: {
        async sign() { return { signedTx: evm.signedTx }; },
        async broadcast() { throw new Error('the original process must not broadcast'); },
      },
    }),
    policy,
    decodeOptions: { family: 'evm', tokenMetadata },
  });
  const signed = await initialClient.sign(evm.transaction);
  const recoveryContext = signerClientModule.readTransactionPolicyApprovalContext(initialClient, signed);
  let freshSignCalls = 0;
  const broadcasts = [];
  const restartedClient = wrapTransactionPolicySignerClient({
    client: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      inner: {
        async sign() {
          freshSignCalls += 1;
          throw new Error('recovery must not sign');
        },
        async broadcast(candidate) {
          broadcasts.push(candidate.signedTx);
          return { transactionHash: '0xaccepted' };
        },
      },
    }),
    policy,
    decodeOptions: { family: 'evm', tokenMetadata },
  });
  let guardedBroadcasts = 0;
  const guardedFacade = {
    async broadcast(candidate) {
      guardedBroadcasts += 1;
      return restartedClient.broadcast(candidate);
    },
  };

  assert.equal(typeof signerClientModule.recoverTransactionPolicyApproval, 'function');
  await signerClientModule.recoverTransactionPolicyApproval({
    client: restartedClient,
    signed,
    recoveryContext,
  });
  const result = await guardedFacade.broadcast(signed);

  assert.equal(result.transactionHash, '0xaccepted');
  assert.equal(freshSignCalls, 0);
  assert.equal(guardedBroadcasts, 1);
  assert.deepEqual(broadcasts, [evm.signedTx]);
});

test('policy signer snapshots provider requests and signed bytes across asynchronous boundaries', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  const request = structuredClone(evm.transaction);
  const submitted = [];
  const client = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign(candidate) {
        return { signedTx: candidate === request ? fixture('evm-wrong-recipient').signedTx : evm.signedTx };
      },
      async broadcast(candidate) {
        submitted.push(candidate.signedTx);
        return { transactionHash: '0xaccepted' };
      },
    },
  });
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy: policyFor(approved),
    decodeOptions: { family: 'evm', tokenMetadata },
  });

  const signed = await protectedClient.sign(request);
  assert.equal(Object.isFrozen(signed), true);
  assert.throws(() => { signed.signedTx = fixture('evm-wrong-recipient').signedTx; }, /read only/);
  await protectedClient.broadcast(signed);

  assert.deepEqual(submitted, [evm.signedTx]);
});

test('policy signer rejects mutable non-plain transaction objects before decoding', async () => {
  const evm = fixture('evm-erc20-transfer');
  const tokenMetadata = { [evm.token]: { assetId: evm.token, decimals: evm.decimals } };
  const approved = await decodeProviderTransaction({ family: 'evm', transaction: evm.transaction, tokenMetadata });
  class ProviderTransaction {
    constructor(value) {
      Object.assign(this, value);
    }
  }
  let signCalls = 0;
  const client = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    inner: {
      async sign() {
        signCalls += 1;
        return { signedTx: evm.signedTx };
      },
      async broadcast() {
        return { transactionHash: '0xshould-not-broadcast' };
      },
    },
  });
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy: policyFor(approved),
    decodeOptions: { family: 'evm', tokenMetadata },
  });

  await assert.rejects(
    protectedClient.sign(new ProviderTransaction(evm.transaction)),
    /canonical object must be plain/,
  );
  assert.equal(signCalls, 0);
});

test('transaction policy wrappers reject the retired third broadcast role', () => {
  const client = wrapSignerClient({
    role: 'operations-trigger',
    liveMode: true,
    inner: { async sign() { return { signedTx: '0xdeadbeef' }; }, async broadcast() { return {}; } },
  });

  assert.throws(
    () => wrapTransactionPolicySignerClient({
      client,
      policy: independentErc20Policy(),
      decodeOptions: { family: 'evm' },
    }),
    /cannot use a transaction policy/,
  );
});

test('transaction policy signer identity cannot be copied onto an unguarded client', () => {
  const client = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    inner: {
      async sign() { return { signedTx: '0xdeadbeef' }; },
      async broadcast() { return { transactionHash: '0xdeadbeef' }; },
    },
  });
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy: independentErc20Policy(),
    decodeOptions: { family: 'evm' },
  });
  const copiedBrand = Object.getOwnPropertySymbols(protectedClient)[0];

  assert.equal(isTransactionPolicySignerClient(protectedClient), true);
  assert.equal(isTransactionPolicySignerClient({ [copiedBrand]: true }), false);
});

test('policy signer wrapper requires a fresh Solana height and refuses a message that expires before broadcast', async () => {
  const transaction = signedSolanaFixture();
  const approved = await decodeProviderTransaction(solanaInput(transaction));
  const policy = withPolicyRules(policyFor(approved), rules => {
    rules[0].deadline = { type: 'block-height', notExpired: true };
  });
  const calls = [];
  const client = wrapSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        calls.push('sign');
        return { signedTxBase64: transaction.transactionBase64 };
      },
      async broadcast() {
        calls.push('broadcast');
        return { signature: 'should-not-broadcast' };
      },
    },
  });
  assert.throws(
    () => wrapTransactionPolicySignerClient({
      client,
      policy,
      decodeOptions: solanaInput(transaction),
    }),
    /requires a currentBlockHeightResolver/,
  );

  const heights = ['99', '101'];
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy,
    decodeOptions: {
      ...solanaInput(transaction),
      currentBlockHeightResolver: async () => heights.shift(),
    },
  });
  const signed = await protectedClient.sign(transaction.transactionBase64);
  await assert.rejects(protectedClient.broadcast(signed), /deadline has expired/);
  assert.deepEqual(calls, ['sign']);
});

test('policy signer wrapper requires a trusted Solana blockhash context resolver', () => {
  const transaction = fixture('solana-legacy');
  const decodeOptions = solanaInput(transaction, { blockhashContextResolver: undefined });
  const client = wrapSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        return { signedTxBase64: transaction.transactionBase64 };
      },
      async broadcast() {
        return { signature: 'should-not-broadcast' };
      },
    },
  });

  assert.throws(
    () => wrapTransactionPolicySignerClient({
      client,
      policy: independentErc20Policy(),
      decodeOptions: {
        ...decodeOptions,
        currentBlockHeightResolver: async () => '99',
      },
    }),
    /requires a blockhashContextResolver/,
  );
});

test('policy signer refuses broadcast when its fresh Solana height is unavailable', async () => {
  const transaction = signedSolanaFixture();
  const approved = await decodeProviderTransaction(solanaInput(transaction));
  const policy = withPolicyRules(policyFor(approved), rules => {
    rules[0].deadline = { type: 'block-height', notExpired: true };
  });
  const calls = [];
  const client = wrapSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        calls.push('sign');
        return { signedTxBase64: transaction.transactionBase64 };
      },
      async broadcast() {
        calls.push('broadcast');
        return { signature: 'should-not-broadcast' };
      },
    },
  });
  const heights = ['99', undefined];
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy,
    decodeOptions: {
      ...solanaInput(transaction),
      currentBlockHeightResolver: async () => heights.shift(),
    },
  });

  const signed = await protectedClient.sign(transaction.transactionBase64);
  await assert.rejects(
    protectedClient.broadcast(signed),
    /currentBlockHeightResolver must return a canonical non-negative integer/,
  );
  assert.deepEqual(calls, ['sign']);
});

test('policy signer ignores provider replacements for trusted Solana decode controls', async () => {
  const transaction = signedSolanaFixture();
  const approved = await decodeProviderTransaction(solanaInput(transaction));
  const policy = withPolicyRules(policyFor(approved), rules => {
    rules[0].deadline = { type: 'block-height', notExpired: true };
  });
  const calls = [];
  const client = wrapSignerClient({
    role: 'operator-solana',
    liveMode: true,
    ...fixtureSignerOptions,
    inner: {
      async sign() {
        calls.push('sign');
        return { signedTxBase64: transaction.transactionBase64 };
      },
      async broadcast() {
        calls.push('broadcast');
        return { signature: 'should-not-broadcast' };
      },
    },
  });
  const heights = ['99', '101'];
  const protectedClient = wrapTransactionPolicySignerClient({
    client,
    policy,
    decodeOptions: {
      ...solanaInput(transaction),
      currentBlockHeightResolver: async () => heights.shift(),
    },
  });

  const signed = await protectedClient.sign({
    transaction: transaction.transactionBase64,
    lastValidBlockHeight: '999',
  });
  await assert.rejects(protectedClient.broadcast(signed), /deadline has expired/);
  assert.deepEqual(calls, ['sign']);
});
