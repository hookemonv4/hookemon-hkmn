import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionTestFixture, productionMoneyConfiguration, historicalProductionMoneyConfiguration } from '../cycle/production-cycle.mjs';
import { assertMoneyConfiguration, assertHistoricalMoneyConfiguration } from '../../src/cycle/money-schemas.mjs';

test('native production fixture defaults to wei while historical USDG configuration stays explicit', () => {
  const native = productionMoneyConfiguration();
  assert.deepEqual(assertMoneyConfiguration(native).assets.eth, { chainId: '4663', assetId: 'native', decimals: 18 });
  assert.equal(createProductionTestFixture().moneyConfiguration.schema, 'hookemon.money-configuration.v2');
  const historical = historicalProductionMoneyConfiguration();
  assert.equal(historical.assets.usdg.decimals, 6);
  assert.equal(assertHistoricalMoneyConfiguration(historical).schema, 'hookemon.money-configuration.v1');
  assert.throws(() => assertMoneyConfiguration(historical), /schema/);
  assert.throws(() => createProductionTestFixture({ moneyConfiguration: historical }), /requires MoneyConfigurationV2/);
});
