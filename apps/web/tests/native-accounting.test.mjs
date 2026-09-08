import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildBootstrap, buildDashboardReadModel } from '../../../packages/dashboard/src/projections/operator-projection.mjs';
import { assertBootstrap, assertDashboardResponse, readDecisionRequest } from '../../../packages/dashboard/src/contracts/operator-contracts.mjs';
import { assertNativeAmount, formatNativeAmount } from '../lib/native-accounting.mjs';

const now = '2026-09-08T12:00:00.000Z';
test('native bootstrap and decision contract use USD controls and reject executable USDG', () => {
  const bootstrap = buildBootstrap({ authorityStatus: {}, identity: { subject: 'owner', email: 'private-contact-sentinel', role: 'operator' } });
  assertBootstrap(bootstrap);
  assert.equal(bootstrap.hardCaps.maxUnitPriceMicroUsd, '55000000');
  assert.deepEqual(bootstrap.state.allowedPackIds, []);
  const request = { requestId: 'native-controls', expectedVersion: null, command: { type: 'update-configuration', configuration: { maxUnitPriceMicroUsd: '55000000' } } };
  assert.deepEqual(readDecisionRequest(request).command.configuration, request.command.configuration);
  assert.throws(() => readDecisionRequest({ ...request, command: { type: 'update-configuration', configuration: { maxUnitPriceMicroUsdg: '55000000' } } }));
  const dashboard = buildDashboardReadModel({ authorityStatus: {}, now: () => Date.parse(now) });
  assertDashboardResponse(dashboard);
  assert.equal(dashboard.schemaVersion, 7);
  assert.equal(dashboard.metrics.totalRewardsPaidWei, null);
});

test('standalone browser contract remains byte-identical and formats every wei', async () => {
  assert.equal(await readFile(new URL('../lib/native-accounting.mjs', import.meta.url), 'utf8'), await readFile(new URL('../../../packages/dashboard/src/contracts/native-accounting.mjs', import.meta.url), 'utf8'));
  assert.equal(await readFile(new URL('../public/comic-production/native-accounting.mjs', import.meta.url), 'utf8'), await readFile(new URL('../lib/native-accounting.mjs', import.meta.url), 'utf8'));
  assert.equal(formatNativeAmount('1'), '0.000000000000000001 ETH');
  assert.equal(formatNativeAmount('1234567890123456789'), '1.234567890123456789 ETH');
  assert.equal(formatNativeAmount('55000000', 6, 'USD'), '55 USD');
});


test('native browser amount validation rejects historical units and scalar coercion', () => {
  const amount = { chainId: '4663', assetId: 'native', decimals: 18, units: '1234567890123456789' };
  assert.doesNotThrow(() => assertNativeAmount(amount));
  for (const edit of [value => { value.decimals = 6; }, value => { value.assetId = '0x0000000000000000000000000000000000000000'; }, value => { value.units = 1; }]) {
    const invalid = structuredClone(amount); edit(invalid);
    assert.throws(() => assertNativeAmount(invalid));
  }
});
