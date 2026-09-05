import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDashboardProfile, dashboardExplorerHref } from '../../src/contracts/dashboard-profile.mjs';

test('mainnet profile targets Robinhood Chain 4663 and Solana mainnet', () => {
  const profile = readDashboardProfile('mainnet');
  assert.equal(profile.badge, 'MAINNET');
  assert.deepEqual(profile.network.evm, { name: 'robinhood', chainId: 4663, label: 'Robinhood Chain' });
  assert.deepEqual(profile.network.solana, {
    name: 'mainnet-beta',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    label: 'Solana',
  });
});

test('testnet profile is unchanged Sepolia + Solana devnet', () => {
  const profile = readDashboardProfile('testnet');
  assert.equal(profile.network.evm.chainId, 11155111);
  assert.equal(profile.network.solana.name, 'devnet');
});

test('rejects an unknown profile id', () => {
  assert.throws(() => readDashboardProfile('bogus'), /PUBLIC_DASHBOARD_PROFILE_INVALID/);
});

test('dashboardExplorerHref builds a solana devnet cluster link', () => {
  const href = dashboardExplorerHref('testnet', { chain: 'solana', purpose: 'collector-purchase', id: '1'.repeat(44) });
  assert.match(href, /^https:\/\/explorer\.solana\.com\/tx\//);
  assert.match(href, /cluster=devnet/);
});

test('dashboardExplorerHref rejects an invalid transaction reference', () => {
  assert.throws(() => dashboardExplorerHref('mainnet', { chain: 'evm', purpose: 'bogus', id: '0x' + '1'.repeat(64) }));
});
