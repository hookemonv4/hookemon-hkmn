// Production distribution-signer / verifier signing over the vault's own EIP-712
// `PayoutDistribution` typed data (decision D7, WP-38/WP-39) — the secp256k1 counterpart to
// `packages/runner/src/distribution/distribution-signer.mjs`'s Ed25519 fixture scheme, which stays
// exactly as it is and is used only under the fixture evidence profile.
//
// Why this lives here, not in `packages/runner`: the runner core is dependency-free (no
// keccak256/secp256k1 there); `payout-typed-data.mjs` (this same directory) is where the actual
// EIP-712 hashing and public-key recovery happen, via viem. This module is the thin orchestration
// on top: ask an injected `signerClient` (`signer-client.mjs`'s `distribution-signer`/`verifier`
// roles) to sign the digest, and independently verify a pair of signatures before either is ever
// trusted. Same two signatures, same digest, gate the manifest off-chain (this module's own
// `assertPairedProductionPayoutSignatures`) and the vault on-chain
// (`PayoutDistributionSignatures.verify`) — there is exactly one signature scheme here, not two
// that happen to agree.
//
// Production identities always come from configuration (the two addresses `compose.mjs`/
// `environment.mjs` resolve from `HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS`/
// `HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS` or `bindings/robinhood-chain.json`) — this module never
// contains, defaults to, or falls back onto any hardcoded address, and structurally cannot
// reach `manifest.mjs`'s fixture Ed25519 public keys (it never imports them).
import { assertRole } from './signer-client.mjs';
import { payoutDistributionDigest, verifyPayoutDistributionSignature } from './payout-typed-data.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveRetainedCustodyMutationAuthority,
} from '../../../runner/src/cycle/preflight.mjs';

const DISTRIBUTION_SIGNER_ROLE = 'distribution-signer';
const VERIFIER_ROLE = 'verifier';
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_65 = /^0x[0-9a-fA-F]{130}$/;
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function requireProductionDistributionSigningAuthority(options = {}) {
  if (options?.preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('fixture production distribution authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (options?.preflightAuthority !== undefined) {
    throw new Error('fixture production distribution test authority is invalid');
  }
  return requireLiveRetainedCustodyMutationAuthority();
}

function assertSignerClient(signerClient, expectedRole) {
  assertRole(expectedRole);
  if (!signerClient || typeof signerClient !== 'object' || typeof signerClient.sign !== 'function') {
    throw new Error(`${expectedRole} requires an injected signer client exposing { role, sign(request) }`);
  }
  if (signerClient.role !== expectedRole) {
    throw new Error(`${expectedRole} signer client role mismatch: expected "${expectedRole}", got "${signerClient.role}"`);
  }
}

function extractSignature(result, role) {
  const signature = typeof result === 'string' ? result : result?.signature;
  if (typeof signature !== 'string' || !SIGNATURE_65.test(signature)) {
    throw new Error(`${role} signer client did not return a well-formed 0x-prefixed 65-byte EIP-712 signature`);
  }
  return signature;
}

/**
 * Production distribution-signer mode: computes the vault's own EIP-712 `PayoutDistribution`
 * digest over `fields` and signs it through the injected `distribution-signer`-role signer client
 * (a secp256k1 key behind the injected seam, per D3 — never read or held by this process). Returns
 * `{ digest, signature }`.
 */
export async function signProductionDistributionApproval(fields, signerClient, options = {}) {
  assertSignerClient(signerClient, DISTRIBUTION_SIGNER_ROLE);
  const digest = payoutDistributionDigest(fields);
  requireProductionDistributionSigningAuthority(options);
  const result = await signerClient.sign({ kind: 'hookemon.payout-distribution-signature.v1', digest });
  const signature = extractSignature(result, DISTRIBUTION_SIGNER_ROLE);
  return { digest, signature };
}

/**
 * Production verifier mode: identical shape to `signProductionDistributionApproval`, through the
 * injected `verifier`-role signer client — a distinct key, on a distinct process (decision D7;
 * `bin/hookemon-verifier.mjs` is where this is actually invoked in production, never the
 * scheduler/runner process).
 */
export async function signProductionDistributionVerification(fields, signerClient, options = {}) {
  assertSignerClient(signerClient, VERIFIER_ROLE);
  const digest = payoutDistributionDigest(fields);
  requireProductionDistributionSigningAuthority(options);
  const result = await signerClient.sign({ kind: 'hookemon.payout-distribution-signature.v1', digest });
  const signature = extractSignature(result, VERIFIER_ROLE);
  return { digest, signature };
}

function assertConfiguredAddress(value, label) {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed EVM address from configuration (bindings/robinhood-chain.json or the operator configuration) — the production profile never falls back to a fixture identity`);
  }
  return value.toLowerCase();
}

/**
 * Recomputes the EIP-712 digest from `fields` and verifies that `distributionSignature` recovers
 * to `distributionSignerAddress`, `verifierSignature` recovers to `distributionVerifierAddress`,
 * the two addresses are distinct and configured (never guessed, never the fixture Ed25519 scheme),
 * and the two signatures are not byte-identical — mirroring
 * `PayoutDistributionSignatures.verify`'s own on-chain checks exactly, so a pair this function
 * accepts is a pair the vault will also accept (same digest, same recovery rule). Throws with a
 * specific reason on any mismatch; returns `{ digest }` on success.
 */
export async function assertPairedProductionPayoutSignatures({
  fields, distributionSignerAddress, distributionVerifierAddress, distributionSignature, verifierSignature,
}) {
  const signerAddress = assertConfiguredAddress(distributionSignerAddress, 'distributionSignerAddress');
  const verifierAddress = assertConfiguredAddress(distributionVerifierAddress, 'distributionVerifierAddress');
  if (signerAddress === verifierAddress) {
    throw new Error('distribution-signer and verifier addresses must be distinct configured identities');
  }
  if (typeof distributionSignature !== 'string' || !SIGNATURE_65.test(distributionSignature)) {
    throw new Error('distributionSignature must be a 0x-prefixed 65-byte hex signature');
  }
  if (typeof verifierSignature !== 'string' || !SIGNATURE_65.test(verifierSignature)) {
    throw new Error('verifierSignature must be a 0x-prefixed 65-byte hex signature');
  }
  if (distributionSignature.toLowerCase() === verifierSignature.toLowerCase()) {
    throw new Error('distributionSignature and verifierSignature must not be identical');
  }
  const digest = payoutDistributionDigest(fields);
  if (!(await verifyPayoutDistributionSignature(signerAddress, digest, distributionSignature))) {
    throw new Error('distributionSignature does not recover to the configured distribution-signer address');
  }
  if (!(await verifyPayoutDistributionSignature(verifierAddress, digest, verifierSignature))) {
    throw new Error('verifierSignature does not recover to the configured distribution-verifier address');
  }
  return { digest };
}
