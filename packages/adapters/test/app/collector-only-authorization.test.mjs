import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../rehearsal/collector-only-authorization.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

const OPERATOR = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const PROCEEDS = deriveAssociatedTokenAddress(OPERATOR, CIRCLE_USD_MINT).toBase58();
const ASSET = Object.freeze({ chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS });

function configuration(overrides = {}) {
  return {
    execution: { profile: 'rehearsal', providerMode: 'live' },
    accounts: { evm: null, solana: OPERATOR },
    signer: {
      backend: 'keychain',
      liveMode: true,
      roles: ['operator-solana'],
      keychain: { solanaAccount: 'operator-solana' },
    },
    solana: { chainId: 'solana-mainnet' },
    pack: { code: 'collector-25' },
    collectorCrypt: {
      settlementAsset: ASSET,
      packPrice: { ...ASSET, amountAtomic: '25000000' },
    },
    moneyConfiguration: {
      assets: { solanaStablecoin: ASSET },
      solana: { lamportReserve: { chainId: 'solana-mainnet', assetId: 'native', decimals: 9, amountAtomic: '5000000' } },
    },
    rehearsal: {
      mode: 'collector-only',
      proceedsAccount: PROCEEDS,
      payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
    },
    ...overrides,
  };
}

test('the selected live collector-only configuration has its own narrow mutation authority', () => {
  assert.equal(requireCollectorOnlyMutationAuthority(configuration()).profile, 'collector-only');
  assert.throws(
    () => requireCollectorOnlyMutationAuthority(configuration({ rehearsal: { mode: 'collector-only', proceedsAccount: OPERATOR, payoutRecipients: [] } })),
    /dedicated proceeds account/i,
  );
});

test('the exact Node-test-profile capability is admitted from the Node test runner, bypassing collector-only config validation', () => {
  assert.equal(
    requireCollectorOnlyMutationAuthority({}, TEST_PROFILE_MUTATION_AUTHORITY),
    TEST_PROFILE_MUTATION_AUTHORITY,
  );
});

test('the exact Node-test-profile capability refuses outside the Node test runner', () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    assert.throws(
      () => requireCollectorOnlyMutationAuthority(configuration(), TEST_PROFILE_MUTATION_AUTHORITY),
      /available only from the Node test runner/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('a structural clone of the test-profile capability refuses even though every field matches', () => {
  const clone = { ...TEST_PROFILE_MUTATION_AUTHORITY };
  assert.throws(
    () => requireCollectorOnlyMutationAuthority(configuration(), clone),
    /fixture authority is invalid/,
  );
});

test('an arbitrary capability object refuses', () => {
  assert.throws(
    () => requireCollectorOnlyMutationAuthority(configuration(), { anything: true }),
    /fixture authority is invalid/,
  );
});

test('a serialized config-flag capability refuses', () => {
  assert.throws(
    () => requireCollectorOnlyMutationAuthority(configuration(), 'test-profile'),
    /fixture authority is invalid/,
  );
  assert.throws(
    () => requireCollectorOnlyMutationAuthority(configuration(), true),
    /fixture authority is invalid/,
  );
});
