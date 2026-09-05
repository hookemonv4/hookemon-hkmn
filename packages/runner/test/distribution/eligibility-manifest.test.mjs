import assert from 'node:assert/strict';
import test from 'node:test';

import { createEligibilityPayoutManifest } from '../../src/distribution/pro-rata.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;

function holder(index) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

test('keeps every eligibility holder in the pre-payout manifest', () => {
  const entries = Array.from({ length: 1025 }, (_, index) => ({
    recipient: holder(index),
    hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
  }));
  const manifest = createEligibilityPayoutManifest({
    cycleId: 'cycle-manifest-1',
    snapshotBlock: '42',
    snapshotHash: `0x${'1'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1025' },
    entries,
    exclusions: [{ address: `0x${'0'.repeat(40)}`, reason: 'zero-address' }],
    feasibility: {
      recipientCount: 1025,
      transactionCount: 1025,
      maxRecipientCount: 1024,
      maxTransactionCount: 1024,
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '102500000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '200000000' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '102500010' },
      feasible: false,
      reason: 'recipient-count-exceeds-configured-maximum',
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'2'.repeat(64)}`, logCount: 1025 },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'3'.repeat(64)}`,
    launchManifestDigest: `sha256:${'4'.repeat(64)}`,
  });

  assert.equal(manifest.entries.length, 1025);
  assert.equal(manifest.entries.at(-1).recipient, holder(1024));
  assert.equal(manifest.feasibility.feasible, false);
});

test('rejects dual-source evidence with a repeated source or a mismatched replay digest', () => {
  const input = {
    cycleId: 'cycle-manifest-2',
    snapshotBlock: '42',
    snapshotHash: `0x${'1'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
    entries: [{
      recipient: holder(0),
      hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
    }],
    exclusions: [],
    feasibility: {
      recipientCount: 1,
      transactionCount: 1,
      maxRecipientCount: 1,
      maxTransactionCount: 1,
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100010' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100010' },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'dual-source',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'2'.repeat(64)}`, logCount: 1 },
      secondary: { sourceId: 'secondary', transferLogDigest: `sha256:${'3'.repeat(64)}`, logCount: 1 },
    },
    holderSnapshotDigest: `sha256:${'4'.repeat(64)}`,
    launchManifestDigest: `sha256:${'5'.repeat(64)}`,
  };
  assert.throws(() => createEligibilityPayoutManifest(input), /distinct matching sources/);
  assert.throws(
    () => createEligibilityPayoutManifest({
      ...input,
      logCompleteness: {
        ...input.logCompleteness,
        secondary: { ...input.logCompleteness.primary },
      },
    }),
    /distinct matching sources/,
  );
});
