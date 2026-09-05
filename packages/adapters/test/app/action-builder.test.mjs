import assert from 'node:assert/strict';
import test from 'node:test';

import * as actionBuilder from '../../src/app/stages/action-builder.mjs';
import {
  buildBuybackAction,
  buildOutboundAction,
  buildPurchaseAction,
  buildReturnAction,
} from '../../src/app/stages/leg-actions.mjs';

test('action builder exposes no route payload extraction helper', () => {
  assert.equal(Object.hasOwn(actionBuilder, 'extractRouteData'), false);
});

function moneyConfiguration() {
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
      solanaStablecoin: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
      },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '2' },
      solanaReceive: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        amountAtomic: '3',
      },
      returnUsdg: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2000000000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '3000000000000000' },
    },
    solana: {
      priorityFeeCap: {
        chainId: '792703809',
        assetId: 'microlamports-per-compute-unit',
        decimals: 0,
        amountAtomic: '25000',
      },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '5000000' },
    },
  };
}

const CONFIG = {
  accounts: {
    evm: '0x1111111111111111111111111111111111111111',
    solana: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t',
  },
  pack: { code: 'collector-ember' },
  moneyConfiguration: moneyConfiguration(),
};
const CUSTODY = {
  operationsTrigger: 'operations-trigger',
  cycleVaultAccount: 'cycle-vault-account',
  policyAccount: 'policy-wallet-account',
  returnAccount: 'return-escrow-account',
};
const VALIDITY = { recentBlockhash: '00', currentHeight: '2', lastValidHeight: '9' };
const INPUT = {
  cycleId: 'cycle-money-config',
  preflightDigest: `sha256:${'a'.repeat(64)}`,
  custody: CUSTODY,
  config: CONFIG,
  principalAmount: '20',
  validity: VALIDITY,
};

test('leg actions use MoneyConfigurationV1 amounts and require explicit validity evidence', () => {
  const outbound = buildOutboundAction(INPUT);
  const purchase = buildPurchaseAction(INPUT);
  const buyback = buildBuybackAction({
    ...INPUT,
    minimumReceive: '5',
    nftMint: 'card-mint',
    nftCustodyAccount: 'card-custody-account',
  });
  const returned = buildReturnAction(INPUT);

  assert.equal(outbound.minimumReceive, '3');
  assert.equal(outbound.nativeGasAmount, '3000000000000000');
  assert.equal(purchase.minimumReceive, '3');
  assert.equal(purchase.nativeGasAmount, '5000000');
  assert.equal(buyback.minimumReceive, '5');
  assert.equal(buyback.nativeGasAmount, '5000000');
  assert.equal(returned.minimumReceive, '0');
  assert.equal(returned.nativeGasAmount, '5000000');
  assert.deepEqual(outbound.validity, VALIDITY);
  assert.equal(outbound.binding.circleDollarDecimals, 6);

  assert.throws(
    () => buildOutboundAction({ ...INPUT, config: { ...CONFIG, moneyConfiguration: null } }),
    /MoneyConfigurationV1/,
  );
  const { validity, ...withoutValidity } = INPUT;
  assert.throws(() => buildOutboundAction(withoutValidity), /explicit validity evidence/);
});
