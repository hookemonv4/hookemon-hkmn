// EIP-712 typed-data encoding for `PegCycleVault.authorizePayout`'s `PayoutDistribution` subject
// (packages/contracts/src/process/IPegCycleVault.sol's `PayoutDomainTypedData` /
// `PayoutDistributionSignatures` — decision D7, WP-38/WP-39). This is the one place off-chain
// tooling computes the exact digest the vault's own `_recoverSigner` checks a signature against.
//
// `packages/runner` stays dependency-free (no keccak256 there), so this module — not
// `packages/runner/src/distribution/manifest.mjs`/`distribution-signer.mjs` — is where the actual
// EIP-712 hashing and secp256k1 public-key recovery happen, using viem (the one npm dependency
// this monorepo's `packages/adapters` boundary is allowed). Production distribution-signer/verifier
// signing (`payout-distribution.mjs`, this same directory) takes a digest computed here and calls
// through an injected `signerClient` (`signer-client.mjs`'s `distribution-signer`/`verifier`
// roles) — this module never holds or reads private key material, only public inputs (addresses,
// digests, signatures).
//
// Cross-checked against a Foundry vector: `test/signing/payout-typed-data.test.mjs` asserts this
// module's `payoutDistributionDigest` for a fixed input matches the exact digest/signature vector
// `packages/contracts/test/helpers/PayoutSigning.sol` produces for the same input, computed
// on-chain-side via `vm.sign` over the identical `keccak256("\x19\x01" || domainSeparator ||
// structHash)` encoding — so a transcription error in either the Solidity or the JS field
// order/typehash string would show up as a digest mismatch, not merely "code that runs".
import { getAddress, hashTypedData, isAddress, recoverAddress } from 'viem';

export const PAYOUT_DOMAIN_NAME = 'HookemonPayoutVault';
export const PAYOUT_DOMAIN_VERSION = '1';

// Field order/types mirror `IPegCycleVault.sol`'s `PayoutDistribution` struct and
// `PayoutDomainTypedData.PAYOUT_DISTRIBUTION_TYPEHASH` string exactly — viem's `hashTypedData`
// derives the identical typehash from this array, so there is exactly one place either side's
// field order could silently drift, and the cross-check test above catches it.
export const PAYOUT_DISTRIBUTION_TYPES = Object.freeze({
  PayoutDistribution: [
    { name: 'requirementsRevision', type: 'uint32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'cycleId', type: 'bytes32' },
    { name: 'hook', type: 'address' },
    { name: 'vault', type: 'address' },
    { name: 'usdg', type: 'address' },
    { name: 'operationsTrigger', type: 'address' },
    { name: 'bindingManifestDigest', type: 'bytes32' },
    { name: 'payoutId', type: 'bytes32' },
    { name: 'manifestDigest', type: 'bytes32' },
    { name: 'rootHash', type: 'bytes32' },
    { name: 'rootSum', type: 'uint256' },
  ],
});

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_65 = /^0x[0-9a-fA-F]{130}$/;

function assertAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${label} must be a valid 0x-prefixed EVM address`);
  return getAddress(value);
}

function assertBytes32(value, label) {
  if (typeof value !== 'string' || !BYTES32.test(value)) throw new Error(`${label} must be a 0x-prefixed 32-byte hex string`);
  return value.toLowerCase();
}

function assertRequirementsRevision(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('requirementsRevision must be a uint32');
  return value;
}

/**
 * Builds the exact viem-shaped typed-data value (`domain`, `types`, `primaryType`, `message`)
 * `PegCycleVault.authorizePayout` verifies a signature over — every field validated before it is
 * ever hashed, so a malformed caller input fails loudly here rather than silently hashing to a
 * digest nobody actually authorized.
 */
export function payoutDistributionTypedData({
  chainId, vault, requirementsRevision, cycleId, hook, usdg, operationsTrigger,
  bindingManifestDigest, payoutId, manifestDigest, rootHash, rootSum,
} = {}) {
  const chainIdValue = BigInt(chainId);
  if (chainIdValue <= 0n) throw new Error('chainId must be positive');
  const rootSumValue = BigInt(rootSum);
  if (rootSumValue <= 0n) throw new Error('rootSum must be positive');
  const vaultAddress = assertAddress(vault, 'vault');
  const message = {
    requirementsRevision: assertRequirementsRevision(requirementsRevision),
    chainId: chainIdValue,
    cycleId: assertBytes32(cycleId, 'cycleId'),
    hook: assertAddress(hook, 'hook'),
    vault: vaultAddress,
    usdg: assertAddress(usdg, 'usdg'),
    operationsTrigger: assertAddress(operationsTrigger, 'operationsTrigger'),
    bindingManifestDigest: assertBytes32(bindingManifestDigest, 'bindingManifestDigest'),
    payoutId: assertBytes32(payoutId, 'payoutId'),
    manifestDigest: assertBytes32(manifestDigest, 'manifestDigest'),
    rootHash: assertBytes32(rootHash, 'rootHash'),
    rootSum: rootSumValue,
  };
  return {
    domain: {
      name: PAYOUT_DOMAIN_NAME,
      version: PAYOUT_DOMAIN_VERSION,
      chainId: chainIdValue,
      verifyingContract: vaultAddress,
    },
    types: PAYOUT_DISTRIBUTION_TYPES,
    primaryType: 'PayoutDistribution',
    message,
  };
}

/**
 * The bytes32 digest `PegCycleVault`'s `PayoutDistributionSignatures._recoverSigner` checks a
 * signature against — the standard EIP-712 `keccak256("\x19\x01" || domainSeparator ||
 * structHash)`, computed via viem's `hashTypedData`.
 */
export function payoutDistributionDigest(fields) {
  return hashTypedData(payoutDistributionTypedData(fields));
}

function assertSignature65(signature, label) {
  if (typeof signature !== 'string' || !SIGNATURE_65.test(signature)) {
    throw new Error(`${label} must be a 0x-prefixed 65-byte (r,s,v) hex signature`);
  }
  return signature;
}

/**
 * Recovers the address that produced `signature` over `digest` — a public-key-recovery
 * operation, never a private-key one. `digest`/`signature` must already be the exact 32-byte /
 * 65-byte (r,s,v) hex shapes the vault's own `_recoverSigner` accepts.
 */
export async function recoverPayoutDistributionSigner(digest, signature) {
  assertBytes32(digest, 'digest');
  assertSignature65(signature, 'signature');
  return recoverAddress({ hash: digest, signature });
}

/**
 * `true` iff `signature` recovers to exactly `expectedAddress` over `digest` — the boolean
 * verification primitive this WP's production distribution-signature validation is built on,
 * matching the `signerRegistry.verifyDigest(address, digestHex, signature)` shape
 * `packages/runner/src/cycle/evidence-profile.mjs`/`decoder.mjs`/`collector.mjs` already use for
 * the identical "does this address's signature verify over this digest" question. Never throws on
 * a malformed signature — returns `false`, exactly like every other boolean verification
 * primitive in this codebase.
 */
export async function verifyPayoutDistributionSignature(expectedAddress, digest, signature) {
  const expected = assertAddress(expectedAddress, 'expected address');
  try {
    const recovered = await recoverPayoutDistributionSigner(digest, signature);
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * A minimal, concrete `signerRegistry`-shaped object (`{ verifyDigest }`) backed by this module's
 * own EIP-712/secp256k1 recovery. Construction never touches key material — only the public
 * `recoverAddress` operation — so this is safe to construct unconditionally in the production
 * composition path.
 */
export function createEvmPayoutSignerRegistry() {
  return Object.freeze({
    async verifyDigest(address, digestHex, signature) {
      return verifyPayoutDistributionSignature(address, digestHex, signature);
    },
  });
}
