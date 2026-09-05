import { assertTransactionPolicy as assertRunnerTransactionPolicy } from './money-schemas.mjs';

export const CANONICAL_TRANSACTION_POLICY_SCHEMA = 'hookemon.transaction-policy.v1';
export const CANONICAL_TRANSACTION_POLICY_VERSION = 1;

/**
 * The runner owns the exact policy envelope. Adapter-specific decoded transaction detail belongs
 * alongside this record, never inside it.
 */
export function assertCanonicalTransactionPolicy(value, label = 'canonical transaction policy') {
  return assertRunnerTransactionPolicy(value, label);
}
