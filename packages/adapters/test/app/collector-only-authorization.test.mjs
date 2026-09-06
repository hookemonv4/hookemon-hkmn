import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../rehearsal/collector-only-authorization.mjs';

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
