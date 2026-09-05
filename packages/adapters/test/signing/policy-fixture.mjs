export function amountRule(amount) {
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

export function policyFor(decoded, schema, id = 'fixture-allow', stage = 'payout') {
  if (schema !== TRANSACTION_POLICY_SCHEMA) throw new Error('fixture policy schema must use the canonical transaction-policy schema');
  return createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage }),
    rules: [{
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
    }],
  });
}
import {
  TRANSACTION_POLICY_SCHEMA,
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
} from '../../src/signing/transaction-policy.mjs';
