import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  assertPairedProductionPayoutSignatures,
  signProductionDistributionApproval,
  signProductionDistributionVerification,
} from '../../src/signing/payout-distribution.mjs';
import { payoutDistributionDigest } from '../../src/signing/payout-typed-data.mjs';

// Same fixed vector as test/signing/payout-typed-data.test.mjs (see that file's own header for
// provenance): a Foundry-produced (vm.sign) digest/signature pair over a fixed PayoutDistribution
// struct, with fixed test private keys whose addresses are asserted here.
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
const SIGNER_ADDRESS = '0x2195c5b816e5d93a5818D73038990A9C20E6a0F8';
const VERIFIER_ADDRESS = '0x8E8a7A79fB7e9C73b1BB423DCbdEfDE540838a3a';
const SIGNER_SIG = '0x2b197425fa6e3cc7b5f3ebe6edd1ad835d2686ecc23170cecfa64dbe5703a3c10ba58b599cdc56f7287ddcf541230a4daa0868e04a1de0b5aef99389deb75f0b1b';
const VERIFIER_SIG = '0x5dc78df986a092ad7d218906ec10f968090896285ad13e9c9641704873bc70c034b3c48194f1e40ebf76c81234f8ba8b3eefbe9270834b9b3f4b363d02d2d16c1c';
const fixtureSigningOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function fakeSignerClient(role, signature) {
  const calls = [];
  return {
    calls,
    client: {
      role,
      async sign() { calls.push('sign'); return { signature }; },
    },
  };
}

test('signProductionDistributionApproval refuses the provisional authority before the signer is called', async () => {
  const { client, calls } = fakeSignerClient('distribution-signer', SIGNER_SIG);
  await assert.rejects(
    signProductionDistributionApproval(FIELDS, client),
    /active frozen interface authority is invalid/,
  );
  assert.deepEqual(calls, []);
});

test('signProductionDistributionApproval preserves digest and signature handling for the exact fixture authority', async () => {
  const { client, calls } = fakeSignerClient('distribution-signer', SIGNER_SIG);
  const result = await signProductionDistributionApproval(FIELDS, client, fixtureSigningOptions);
  assert.deepEqual(result, { digest: payoutDistributionDigest(FIELDS), signature: SIGNER_SIG });
  assert.deepEqual(calls, ['sign']);
});

test('signProductionDistributionVerification requires the verifier role', async () => {
  const { client } = fakeSignerClient('distribution-signer', VERIFIER_SIG);
  await assert.rejects(
    signProductionDistributionVerification(FIELDS, client),
    /role mismatch/,
  );
});

test('signProductionDistributionVerification refuses the provisional authority before the signer is called', async () => {
  const { client, calls } = fakeSignerClient('verifier', VERIFIER_SIG);
  await assert.rejects(
    signProductionDistributionVerification(FIELDS, client),
    /active frozen interface authority is invalid/,
  );
  assert.deepEqual(calls, []);
});

test('assertPairedProductionPayoutSignatures accepts a genuine, distinct, correctly-recovering pair', async () => {
  const { digest } = await assertPairedProductionPayoutSignatures({
    fields: FIELDS,
    distributionSignerAddress: SIGNER_ADDRESS,
    distributionVerifierAddress: VERIFIER_ADDRESS,
    distributionSignature: SIGNER_SIG,
    verifierSignature: VERIFIER_SIG,
  });
  assert.equal(digest, payoutDistributionDigest(FIELDS));
});

test('assertPairedProductionPayoutSignatures refuses when the two configured addresses are the same', async () => {
  await assert.rejects(
    assertPairedProductionPayoutSignatures({
      fields: FIELDS,
      distributionSignerAddress: SIGNER_ADDRESS,
      distributionVerifierAddress: SIGNER_ADDRESS,
      distributionSignature: SIGNER_SIG,
      verifierSignature: VERIFIER_SIG,
    }),
    /distinct configured identities/,
  );
});

test('assertPairedProductionPayoutSignatures refuses identical signatures', async () => {
  await assert.rejects(
    assertPairedProductionPayoutSignatures({
      fields: FIELDS,
      distributionSignerAddress: SIGNER_ADDRESS,
      distributionVerifierAddress: VERIFIER_ADDRESS,
      distributionSignature: SIGNER_SIG,
      verifierSignature: SIGNER_SIG,
    }),
    /must not be identical/,
  );
});

test('assertPairedProductionPayoutSignatures refuses a signature that does not recover to the claimed address', async () => {
  await assert.rejects(
    assertPairedProductionPayoutSignatures({
      fields: FIELDS,
      distributionSignerAddress: SIGNER_ADDRESS,
      distributionVerifierAddress: VERIFIER_ADDRESS,
      distributionSignature: VERIFIER_SIG,
      verifierSignature: SIGNER_SIG,
    }),
    /does not recover/,
  );
});

test('assertPairedProductionPayoutSignatures refuses an unconfigured (non-address) identity — never a fixture fallback', async () => {
  await assert.rejects(
    assertPairedProductionPayoutSignatures({
      fields: FIELDS,
      distributionSignerAddress: null,
      distributionVerifierAddress: VERIFIER_ADDRESS,
      distributionSignature: SIGNER_SIG,
      verifierSignature: VERIFIER_SIG,
    }),
    /must be a 0x-prefixed EVM address from configuration/,
  );
});

test('this module never imports the fixture Ed25519 manifest.mjs public keys (source-level check)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/signing/payout-distribution.mjs', import.meta.url), 'utf8');
  const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line));
  assert.equal(importLines.some(line => line.includes('manifest.mjs')), false);
  assert.equal(/OWNER_PUBLIC_KEY|DISTRIBUTION_VERIFIER_PUBLIC_KEY/.test(source), false);
});
