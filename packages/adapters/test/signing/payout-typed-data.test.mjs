import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvmPayoutSignerRegistry,
  payoutDistributionDigest,
  payoutDistributionTypedData,
  recoverPayoutDistributionSigner,
  verifyPayoutDistributionSignature,
} from '../../src/signing/payout-typed-data.mjs';

// Fixed input struct, mirrored exactly in a scratch Foundry test built from
// packages/contracts/test/helpers/PayoutSigning.sol (the same helper every real Forge suite that
// exercises `PegCycleVault.authorizePayout` uses to produce its own dual signature). The Foundry
// side computed `PayoutSigning.computeDomainSeparator(vault)` at chainId 4663 for vault
// 0x1111...1111, `PayoutSigning.digest(domainSeparator, authorization)`, and
// `PayoutSigning.signPair(...)` with its own fixed test private keys
// (DISTRIBUTION_SIGNER_KEY/DISTRIBUTION_VERIFIER_KEY) via `vm.sign` — the exact on-chain
// `ecrecover`-compatible (r,s,v) encoding `PayoutDistributionSignatures._recoverSigner` accepts.
// This test asserts this module's own, independent JS-side (viem) encoding reproduces the
// identical digest byte-for-byte, and that recovery of the Foundry-produced signatures against
// this module's own digest yields exactly the addresses `PayoutSigning.distributionSignerAddress()`/
// `distributionVerifierAddress()` reported.
const FIELDS = {
  requirementsRevision: 57,
  chainId: 4663,
  cycleId: `0x${'0'.repeat(63)}1`,
  hook: '0x2222222222222222222222222222222222222222',
  vault: '0x1111111111111111111111111111111111111111',
  usdg: '0x3333333333333333333333333333333333333333',
  operationsTrigger: '0x4444444444444444444444444444444444444444',
  bindingManifestDigest: `0x${'0'.repeat(63)}2`,
  payoutId: `0x${'0'.repeat(63)}3`,
  manifestDigest: `0x${'0'.repeat(63)}4`,
  rootHash: `0x${'0'.repeat(63)}5`,
  rootSum: '123456789',
};

const FOUNDRY_VECTOR = Object.freeze({
  domainSeparator: '0x984bc1188151777df895cddb30de64954fa61a76f3e95b91be7595235c13fa52',
  digest: '0x3f8df783669bdb7e465003a66a63c679ed38e98d5a42cdc74d729165dbd900b4',
  signerAddress: '0x2195c5b816e5d93a5818D73038990A9C20E6a0F8',
  verifierAddress: '0x8E8a7A79fB7e9C73b1BB423DCbdEfDE540838a3a',
  signerSig: '0x2b197425fa6e3cc7b5f3ebe6edd1ad835d2686ecc23170cecfa64dbe5703a3c10ba58b599cdc56f7287ddcf541230a4daa0868e04a1de0b5aef99389deb75f0b1b',
  verifierSig: '0x5dc78df986a092ad7d218906ec10f968090896285ad13e9c9641704873bc70c034b3c48194f1e40ebf76c81234f8ba8b3eefbe9270834b9b3f4b363d02d2d16c1c',
});

test('payoutDistributionDigest matches the Foundry-produced vector byte-for-byte', () => {
  const digest = payoutDistributionDigest(FIELDS);
  assert.equal(digest, FOUNDRY_VECTOR.digest);
});

test('payoutDistributionTypedData carries the exact domain/type IPegCycleVault.sol pins', () => {
  const typedData = payoutDistributionTypedData(FIELDS);
  assert.equal(typedData.domain.name, 'HookemonPayoutVault');
  assert.equal(typedData.domain.version, '1');
  assert.equal(typedData.domain.chainId, 4663n);
  assert.equal(typedData.domain.verifyingContract.toLowerCase(), FIELDS.vault);
  assert.equal(typedData.primaryType, 'PayoutDistribution');
  assert.deepEqual(typedData.types.PayoutDistribution.map(field => field.name), [
    'requirementsRevision', 'chainId', 'cycleId', 'hook', 'vault', 'usdg', 'operationsTrigger',
    'bindingManifestDigest', 'payoutId', 'manifestDigest', 'rootHash', 'rootSum',
  ]);
});

test('recoverPayoutDistributionSigner recovers the exact Foundry-pinned distribution-signer/verifier addresses', async () => {
  const digest = payoutDistributionDigest(FIELDS);
  const recoveredSigner = await recoverPayoutDistributionSigner(digest, FOUNDRY_VECTOR.signerSig);
  const recoveredVerifier = await recoverPayoutDistributionSigner(digest, FOUNDRY_VECTOR.verifierSig);
  assert.equal(recoveredSigner.toLowerCase(), FOUNDRY_VECTOR.signerAddress.toLowerCase());
  assert.equal(recoveredVerifier.toLowerCase(), FOUNDRY_VECTOR.verifierAddress.toLowerCase());
});

test('verifyPayoutDistributionSignature accepts the matching address and rejects a mismatched one', async () => {
  const digest = payoutDistributionDigest(FIELDS);
  assert.equal(await verifyPayoutDistributionSignature(FOUNDRY_VECTOR.signerAddress, digest, FOUNDRY_VECTOR.signerSig), true);
  assert.equal(await verifyPayoutDistributionSignature(FOUNDRY_VECTOR.verifierAddress, digest, FOUNDRY_VECTOR.signerSig), false);
});

test('verifyPayoutDistributionSignature returns false (never throws) on a malformed signature', async () => {
  const digest = payoutDistributionDigest(FIELDS);
  assert.equal(await verifyPayoutDistributionSignature(FOUNDRY_VECTOR.signerAddress, digest, '0xnotasignature'), false);
});

test('createEvmPayoutSignerRegistry exposes a verifyDigest matching the signerRegistry seam shape', async () => {
  const registry = createEvmPayoutSignerRegistry();
  const digest = payoutDistributionDigest(FIELDS);
  assert.equal(typeof registry.verifyDigest, 'function');
  assert.equal(await registry.verifyDigest(FOUNDRY_VECTOR.signerAddress, digest, FOUNDRY_VECTOR.signerSig), true);
  assert.equal(await registry.verifyDigest(FOUNDRY_VECTOR.verifierAddress, digest, FOUNDRY_VECTOR.signerSig), false);
});

test('payoutDistributionDigest rejects a malformed field before ever hashing', () => {
  assert.throws(() => payoutDistributionDigest({ ...FIELDS, hook: 'not-an-address' }), /valid 0x-prefixed EVM address/);
  assert.throws(() => payoutDistributionDigest({ ...FIELDS, payoutId: '0xdead' }), /32-byte hex string/);
  assert.throws(() => payoutDistributionDigest({ ...FIELDS, rootSum: '0' }), /rootSum must be positive/);
});
