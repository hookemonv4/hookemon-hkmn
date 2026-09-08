import assert from 'node:assert/strict';
import test from 'node:test';

import { CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT, SOLANA_RELAY_CHAIN_ID, SYSTEM_PROGRAM_ID, createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../src/collector-crypt.mjs';
import {
  assertSolanaAdmittedPurchaseAmount,
  assertSolanaSignerFeeEnvelope,
  assertSolanaSignerMoneyConfiguration,
} from '../../src/app/stages/solana-money-controls.mjs';

const NATIVE_CHAIN_ID = COLLECTOR_CRYPT_SETTLEMENT_ASSET.chainId;
const RELAY_CHAIN_ID = String(SOLANA_RELAY_CHAIN_ID);
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const OWNER = SYSTEM_PROGRAM_ID;

function nativeAsset(overrides = {}) {
  return { ...COLLECTOR_CRYPT_SETTLEMENT_ASSET, ...overrides };
}

function relayAsset(overrides = {}) {
  return { chainId: RELAY_CHAIN_ID, assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS, ...overrides };
}

function moneyConfiguration({ solanaStablecoin, priorityFeeCapChainId = solanaStablecoin.chainId, priorityFeeCapAmount = '100', lamportReserveAmount = '1000' } = {}) {
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: {
      eth: { chainId: '4663', assetId: 'native', decimals: 18 },
      solanaStablecoin,
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnEth: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '5' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
    },
    solana: {
      priorityFeeCap: { chainId: priorityFeeCapChainId, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: priorityFeeCapAmount },
      lamportReserve: { chainId: priorityFeeCapChainId, assetId: 'native', decimals: 9, amountAtomic: lamportReserveAmount },
    },
  };
}

function productionConfig(moneyOverrides = {}) {
  return {
    execution: { profile: 'production' },
    solana: { chainId: NATIVE_CHAIN_ID },
    moneyConfiguration: moneyConfiguration({ solanaStablecoin: relayAsset(), ...moneyOverrides }),
  };
}

function rehearsalConfig(moneyOverrides = {}) {
  return {
    execution: { profile: 'rehearsal' },
    solana: { chainId: NATIVE_CHAIN_ID },
    moneyConfiguration: moneyConfiguration({ solanaStablecoin: nativeAsset(), ...moneyOverrides }),
  };
}

function balanceClient(lamports) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.method, 'getBalance');
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: lamports } }) };
    },
  });
}

function decodedWithFee(fee, gasComputeUnitLimit = '100000') {
  return { priorityFee: fee, gas: { computeUnitLimit: gasComputeUnitLimit } };
}

test('assertSolanaSignerMoneyConfiguration: production accepts the exact closed native/Relay pair', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.deepEqual(money.assets.solanaStablecoin, relayAsset());
});

test('assertSolanaSignerMoneyConfiguration: collector-only rehearsal continues to accept the native tuple in both places', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: rehearsalConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.deepEqual(money.assets.solanaStablecoin, nativeAsset());
});

test('assertSolanaSignerMoneyConfiguration: production refuses a native settlement asset labeled with the Relay chain id', () => {
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset({ chainId: RELAY_CHAIN_ID }), stage: 'purchase' }),
    /does not match the trusted native Collector settlement identity/,
  );
});

test('assertSolanaSignerMoneyConfiguration: production refuses a MoneyConfiguration asset labeled with the native chain id', () => {
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig({ solanaStablecoin: nativeAsset() }), asset: nativeAsset(), stage: 'purchase' }),
    /MoneyConfigurationV1 Solana asset does not match/,
  );
});

test('assertSolanaSignerMoneyConfiguration: production refuses a third, unrecognized chain label on either side', () => {
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig({ solanaStablecoin: relayAsset({ chainId: '999999' }) }), asset: nativeAsset(), stage: 'purchase' }),
    /MoneyConfigurationV1 Solana asset does not match/,
  );
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset({ chainId: '999999' }), stage: 'purchase' }),
    /does not match the trusted native Collector settlement identity/,
  );
});

test('assertSolanaSignerMoneyConfiguration: refuses native/config chain disagreement', () => {
  const config = productionConfig();
  config.solana = { chainId: RELAY_CHAIN_ID };
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config, asset: nativeAsset(), stage: 'purchase' }),
    /does not match the trusted native Collector settlement identity/,
  );
});

test('assertSolanaSignerMoneyConfiguration: refuses wrong mint on either side', () => {
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset({ assetId: OTHER_MINT }), stage: 'purchase' }),
    /does not match the trusted native Collector settlement identity/,
  );
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig({ solanaStablecoin: relayAsset({ assetId: OTHER_MINT }) }), asset: nativeAsset(), stage: 'purchase' }),
    /MoneyConfigurationV1 Solana asset does not match/,
  );
});

test('assertSolanaSignerMoneyConfiguration: refuses wrong decimals on either side', () => {
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset({ decimals: 9 }), stage: 'purchase' }),
    /does not match the trusted native Collector settlement identity/,
  );
  assert.throws(
    () => assertSolanaSignerMoneyConfiguration({ config: productionConfig({ solanaStablecoin: relayAsset({ decimals: 9 }) }), asset: nativeAsset(), stage: 'purchase' }),
    /MoneyConfigurationV1 Solana asset does not match/,
  );
});

test('assertSolanaSignerFeeEnvelope: a decoded native-chain priority fee at the Relay-namespaced cap succeeds with sufficient SOL', async () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  const decoded = decodedWithFee({ chainId: NATIVE_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' });
  await assertSolanaSignerFeeEnvelope({
    client: balanceClient(1_000_000_000),
    owner: OWNER,
    money,
    decoded,
    nativeChainId: NATIVE_CHAIN_ID,
    stage: 'purchase',
  });
});

test('assertSolanaSignerFeeEnvelope: refuses a decoded fee carrying the Relay chain label', async () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  const decoded = decodedWithFee({ chainId: RELAY_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' });
  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: balanceClient(1_000_000_000),
      owner: OWNER,
      money,
      decoded,
      nativeChainId: NATIVE_CHAIN_ID,
      stage: 'purchase',
    }),
    /priority fee exceeds the configured MoneyConfigurationV1 cap/,
  );
});

test('assertSolanaSignerFeeEnvelope: refuses wrong denomination/decimals before signing', async () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: balanceClient(1_000_000_000),
      owner: OWNER,
      money,
      decoded: decodedWithFee({ chainId: NATIVE_CHAIN_ID, assetId: 'native', decimals: 0, amountAtomic: '100' }),
      nativeChainId: NATIVE_CHAIN_ID,
      stage: 'purchase',
    }),
    /priority fee exceeds the configured MoneyConfigurationV1 cap/,
  );
  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: balanceClient(1_000_000_000),
      owner: OWNER,
      money,
      decoded: decodedWithFee({ chainId: NATIVE_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 6, amountAtomic: '100' }),
      nativeChainId: NATIVE_CHAIN_ID,
      stage: 'purchase',
    }),
    /priority fee exceeds the configured MoneyConfigurationV1 cap/,
  );
});

test('assertSolanaSignerFeeEnvelope: refuses an amount above the cap', async () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: balanceClient(1_000_000_000),
      owner: OWNER,
      money,
      decoded: decodedWithFee({ chainId: NATIVE_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '101' }),
      nativeChainId: NATIVE_CHAIN_ID,
      stage: 'purchase',
    }),
    /priority fee exceeds the configured MoneyConfigurationV1 cap/,
  );
});

test('assertSolanaAdmittedPurchaseAmount: production maps the exact admitted Relay tuple back onto the native tuple, keeping amountAtomic', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  const normalized = assertSolanaAdmittedPurchaseAmount({
    money,
    asset: nativeAsset(),
    amount: relayAsset({ amountAtomic: '1500000' }),
    label: 'admitted unitPurchase',
  });
  assert.deepEqual(normalized, nativeAsset({ amountAtomic: '1500000' }));
});

test('assertSolanaAdmittedPurchaseAmount: rehearsal maps the exact admitted native tuple onto itself, keeping amountAtomic', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: rehearsalConfig(), asset: nativeAsset(), stage: 'purchase' });
  const normalized = assertSolanaAdmittedPurchaseAmount({
    money,
    asset: nativeAsset(),
    amount: nativeAsset({ amountAtomic: '2500000' }),
    label: 'admitted unitPurchase',
  });
  assert.deepEqual(normalized, nativeAsset({ amountAtomic: '2500000' }));
});

test('assertSolanaAdmittedPurchaseAmount: production refuses a native-labelled admitted amount', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money, asset: nativeAsset(), amount: nativeAsset({ amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
});

test('assertSolanaAdmittedPurchaseAmount: rehearsal refuses a Relay-labelled admitted amount', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: rehearsalConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money, asset: nativeAsset(), amount: relayAsset({ amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
});

test('assertSolanaAdmittedPurchaseAmount: refuses a third, unrecognized chain label in either profile', () => {
  const productionMoney = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money: productionMoney, asset: nativeAsset(), amount: relayAsset({ chainId: '999999', amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
  const rehearsalMoney = assertSolanaSignerMoneyConfiguration({ config: rehearsalConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money: rehearsalMoney, asset: nativeAsset(), amount: nativeAsset({ chainId: '999999', amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
});

test('assertSolanaAdmittedPurchaseAmount: refuses wrong mint in either profile', () => {
  const productionMoney = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money: productionMoney, asset: nativeAsset(), amount: relayAsset({ assetId: OTHER_MINT, amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
  const rehearsalMoney = assertSolanaSignerMoneyConfiguration({ config: rehearsalConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money: rehearsalMoney, asset: nativeAsset(), amount: nativeAsset({ assetId: OTHER_MINT, amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
});

test('assertSolanaAdmittedPurchaseAmount: refuses wrong decimals in either profile', () => {
  const productionMoney = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money: productionMoney, asset: nativeAsset(), amount: relayAsset({ decimals: 9, amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
  const rehearsalMoney = assertSolanaSignerMoneyConfiguration({ config: rehearsalConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money: rehearsalMoney, asset: nativeAsset(), amount: nativeAsset({ decimals: 9, amountAtomic: '100' }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
});

test('assertSolanaAdmittedPurchaseAmount: refuses a malformed or noncanonical amountAtomic before the asset comparison', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  for (const amountAtomic of ['01', '-5', '1.5', '', ' 5', '5 ', '0x5']) {
    assert.throws(
      () => assertSolanaAdmittedPurchaseAmount({ money, asset: nativeAsset(), amount: relayAsset({ amountAtomic }), label: 'admitted unitPurchase' }),
      /admitted unitPurchase amountAtomic is invalid/,
    );
  }
});

test('assertSolanaAdmittedPurchaseAmount: rejects a non-canonical amount type outright', () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  assert.throws(
    () => assertSolanaAdmittedPurchaseAmount({ money, asset: nativeAsset(), amount: relayAsset({ amountAtomic: 100 }), label: 'admitted unitPurchase' }),
    /admitted unitPurchase amountAtomic is invalid/,
  );
});

test('assertSolanaSignerFeeEnvelope: null priority fee still retains the configured lamport reserve', async () => {
  const money = assertSolanaSignerMoneyConfiguration({ config: productionConfig(), asset: nativeAsset(), stage: 'purchase' });
  const decoded = { priorityFee: null, gas: { computeUnitLimit: '100000' } };
  await assertSolanaSignerFeeEnvelope({
    client: balanceClient(1000),
    owner: OWNER,
    money,
    decoded,
    nativeChainId: NATIVE_CHAIN_ID,
    stage: 'purchase',
  });
  await assert.rejects(
    () => assertSolanaSignerFeeEnvelope({
      client: balanceClient(999),
      owner: OWNER,
      money,
      decoded,
      nativeChainId: NATIVE_CHAIN_ID,
      stage: 'purchase',
    }),
    /Operations SOL balance does not retain the configured lamport reserve/,
  );
});
