import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeVaultPayoutAuthorization,
  validateVaultPayoutAuthorization,
  vaultPayoutAuthorizationDigest,
} from '../../src/cycle/vault-payout-authorization.mjs';

const authorization = Object.freeze({
  requirementsRevision: 57,
  chainId: '4663',
  cycleId: `0x${'1'.repeat(64)}`,
  hook: '0x0000000000000000000000000000000000001001',
  vault: '0x0000000000000000000000000000000000001002',
  usdg: '0x0000000000000000000000000000000000001003',
  operationsTrigger: '0x0000000000000000000000000000000000001004',
  bindingManifestDigest: `0x${'2'.repeat(64)}`,
  payoutId: `0x${'3'.repeat(64)}`,
  manifestDigest: `0x${'4'.repeat(64)}`,
  rootHash: `0x${'5'.repeat(64)}`,
  rootSum: '10',
  returnActionDigest: `0x${'6'.repeat(64)}`,
  returnReceiptDigest: `0x${'7'.repeat(64)}`,
  expiresAt: '1893456000',
  nonce: '9',
});

const expectedAbiEncoding = `0x${[
  '39'.padStart(64, '0'),
  '1237'.padStart(64, '0'),
  '1'.repeat(64),
  '1001'.padStart(64, '0'),
  '1002'.padStart(64, '0'),
  '1003'.padStart(64, '0'),
  '1004'.padStart(64, '0'),
  '2'.repeat(64),
  '3'.repeat(64),
  '4'.repeat(64),
  '5'.repeat(64),
  'a'.padStart(64, '0'),
  '6'.repeat(64),
  '7'.repeat(64),
  '70dbd880'.padStart(64, '0'),
  '9'.padStart(64, '0'),
].join('')}`;

test('matches Solidity abi.encode and keccak256 for the exact payout authorization tuple', () => {
  assert.deepEqual(validateVaultPayoutAuthorization(authorization), authorization);
  assert.equal(encodeVaultPayoutAuthorization(authorization), expectedAbiEncoding);
  assert.equal(vaultPayoutAuthorizationDigest(authorization), '0xd020889a423d5e0bce7fa540c894b1d5242bbc28f7f24e673481269b291ee01e');
});

test('rejects every missing, malformed, zero, aliased, or extra payout authorization field', () => {
  for (const field of Object.keys(authorization)) {
    const missing = { ...authorization };
    delete missing[field];
    assert.throws(() => validateVaultPayoutAuthorization(missing), /exact schema/, field);
  }
  for (const [field, value] of [
    ['requirementsRevision', 56],
    ['chainId', '0'],
    ['cycleId', `0x${'0'.repeat(64)}`],
    ['hook', '0x0000000000000000000000000000000000000000'],
    ['vault', authorization.operationsTrigger],
    ['usdg', '0x0000000000000000000000000000000000000000'],
    ['operationsTrigger', authorization.hook],
    ['bindingManifestDigest', `0x${'0'.repeat(64)}`],
    ['payoutId', `0x${'0'.repeat(64)}`],
    ['manifestDigest', `0x${'0'.repeat(64)}`],
    ['rootHash', `0x${'0'.repeat(64)}`],
    ['rootSum', '0'],
    ['returnActionDigest', `0x${'0'.repeat(64)}`],
    ['returnReceiptDigest', `0x${'0'.repeat(64)}`],
    ['expiresAt', '0'],
    ['nonce', '01'],
  ]) assert.throws(() => validateVaultPayoutAuthorization({ ...authorization, [field]: value }), /invalid|distinct|zero|revision/i, field);
  assert.throws(() => validateVaultPayoutAuthorization({ ...authorization, extra: true }), /exact schema/);
});
