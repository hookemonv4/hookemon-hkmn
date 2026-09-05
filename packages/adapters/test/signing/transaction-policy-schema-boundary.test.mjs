import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTransactionPolicy as assertRunnerTransactionPolicy } from '../../../runner/src/cycle/money-schemas.mjs';
import * as transactionPolicyAdapter from '../../src/signing/transaction-policy.mjs';

const INDEPENDENT_CANONICAL_POLICY = Object.freeze({
  schema: 'hookemon.transaction-policy.v1',
  chainId: '4663',
  stage: 'outbound',
  requestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  expectedRecipient: '0x2222222222222222222222222222222222222222',
  amount: Object.freeze({
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    amountAtomic: '0',
  }),
  allowedTargets: Object.freeze(['0x1111111111111111111111111111111111111111']),
  allowedPrograms: Object.freeze([]),
});

const INDEPENDENT_DECODED_TRANSACTION = Object.freeze({
  schema: 'hookemon.transaction-policy.decode.v1',
  family: 'evm',
  format: 'evm',
  chainId: '4663',
  nonce: '7',
  programIds: Object.freeze(['0x1111111111111111111111111111111111111111']),
  addressLookupTables: Object.freeze([]),
  target: '0x1111111111111111111111111111111111111111',
  selector: '0x12345678',
  source: '0x3333333333333333333333333333333333333333',
  destination: '0x2222222222222222222222222222222222222222',
  mint: null,
  token: null,
  amount: null,
  nativeValue: Object.freeze({
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    amountAtomic: '0',
  }),
  gas: Object.freeze({
    limit: '21000',
    gasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  }),
  feePayer: '0x3333333333333333333333333333333333333333',
  requiredSigners: Object.freeze(['0x3333333333333333333333333333333333333333']),
  coSigners: Object.freeze([]),
  instructions: Object.freeze([Object.freeze({
    kind: 'evm-call',
    programId: '0x1111111111111111111111111111111111111111',
    instructionId: '0x12345678',
    data: '0x12345678',
    accounts: Object.freeze([]),
    source: '0x3333333333333333333333333333333333333333',
    destination: '0x2222222222222222222222222222222222222222',
    mint: null,
    token: null,
    amount: null,
    nativeValue: Object.freeze({
      chainId: '4663',
      assetId: 'native',
      decimals: 18,
      amountAtomic: '0',
    }),
    computeUnitLimit: null,
    priorityFee: null,
  })]),
  extraInstructions: Object.freeze([]),
  blockhash: null,
  deadline: null,
  priorityFee: null,
});

const INDEPENDENT_ADAPTER_RULE = Object.freeze({
  id: 'literal-evm-call',
  family: 'evm',
  format: 'evm',
  chainId: '4663',
  nonce: '7',
  programIds: Object.freeze(['0x1111111111111111111111111111111111111111']),
  addressLookupTables: Object.freeze([]),
  target: '0x1111111111111111111111111111111111111111',
  selector: '0x12345678',
  source: '0x3333333333333333333333333333333333333333',
  destination: '0x2222222222222222222222222222222222222222',
  mint: null,
  token: null,
  amount: null,
  nativeValue: Object.freeze({ exact: INDEPENDENT_CANONICAL_POLICY.amount }),
  gas: Object.freeze({
    limit: '21000',
    gasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  }),
  feePayer: '0x3333333333333333333333333333333333333333',
  requiredSigners: Object.freeze(['0x3333333333333333333333333333333333333333']),
  coSigners: Object.freeze([]),
  instructions: Object.freeze([Object.freeze({
    kind: 'evm-call',
    programId: '0x1111111111111111111111111111111111111111',
    instructionId: '0x12345678',
    data: '0x12345678',
    accounts: Object.freeze([]),
    source: '0x3333333333333333333333333333333333333333',
    destination: '0x2222222222222222222222222222222222222222',
    mint: null,
    token: null,
    amount: null,
    nativeValue: Object.freeze({ exact: INDEPENDENT_CANONICAL_POLICY.amount }),
    computeUnitLimit: null,
    priorityFee: null,
  })]),
  extraInstructions: Object.freeze([]),
  blockhash: null,
  deadline: null,
  priorityFee: null,
});

function independentAdapterPolicy(canonicalPolicy = INDEPENDENT_CANONICAL_POLICY) {
  return transactionPolicyAdapter.createTransactionPolicy({
    policy: canonicalPolicy,
    rules: [INDEPENDENT_ADAPTER_RULE],
  });
}

test('runner and adapter accept the same independently authored canonical policy', () => {
  assert.equal(transactionPolicyAdapter.CANONICAL_TRANSACTION_POLICY_SCHEMA, 'hookemon.transaction-policy.v1');
  assert.equal(typeof transactionPolicyAdapter.assertCanonicalTransactionPolicy, 'function');
  assert.deepEqual(assertRunnerTransactionPolicy(INDEPENDENT_CANONICAL_POLICY), INDEPENDENT_CANONICAL_POLICY);
  assert.deepEqual(transactionPolicyAdapter.assertCanonicalTransactionPolicy(INDEPENDENT_CANONICAL_POLICY), INDEPENDENT_CANONICAL_POLICY);

  const policy = independentAdapterPolicy();
  assert.equal(policy.schema, 'hookemon.transaction-policy.v1');
  assert.deepEqual(assertRunnerTransactionPolicy(policy), INDEPENDENT_CANONICAL_POLICY);
  const approval = transactionPolicyAdapter.evaluate(
    policy,
    INDEPENDENT_DECODED_TRANSACTION,
  );
  assert.equal(approval.schema, 'hookemon.transaction-policy.v1');
  assert.equal(approval.allowed, true);
  assert.equal(approval.ruleId, 'literal-evm-call');
});

test('runner and adapter reject the same malformed canonical policy', () => {
  const malformed = { ...INDEPENDENT_CANONICAL_POLICY, schema: 'hookemon.transaction-policy.v2' };

  assert.throws(() => assertRunnerTransactionPolicy(malformed), /schema is invalid/);
  assert.throws(() => transactionPolicyAdapter.assertCanonicalTransactionPolicy(malformed), /schema is invalid/);
  const malformedPolicy = { policy: malformed, rules: [INDEPENDENT_ADAPTER_RULE] };
  assert.throws(
    () => transactionPolicyAdapter.evaluate(malformedPolicy, INDEPENDENT_DECODED_TRANSACTION),
    /schema is invalid/,
  );
});
