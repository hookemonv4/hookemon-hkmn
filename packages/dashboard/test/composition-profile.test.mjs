import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compose } from '../../adapters/src/app/compose.mjs';
import { readDashboardProfile } from '../src/contracts/dashboard-profile.mjs';

const CREDENTIAL = 'p'.repeat(40);

async function composeInput(t, dashboard) {
  const stateDir = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-profile-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return {
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'dashboard-profile-test',
    leaseTtlMs: 30_000,
    chainId: 4663,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    networkIdentity: {
      async readEvmChainId() { return 4663; },
      async readSolanaGenesisHash() {
        return readDashboardProfile('mainnet').network.solana.genesisHash;
      },
    },
    dashboard,
  };
}

test('compose refuses a testnet dashboard profile for Robinhood Chain before a listener exists', async (t) => {
  await assert.rejects(
    compose(await composeInput(t, { profileId: 'testnet', proxyCredential: CREDENTIAL, sqlitePath: ':memory:' })),
    /dashboard.*profile|profile.*chain/i,
  );
});

test('compose refuses a mainnet dashboard profile for the testnet chain before a listener exists', async (t) => {
  const input = await composeInput(t, { profileId: 'mainnet', proxyCredential: CREDENTIAL, sqlitePath: ':memory:' });
  input.chainId = 11155111;
  await assert.rejects(compose(input), { message: 'compose only accepts the verified mainnet network profile' });
});

test('compose defaults a Robinhood Chain dashboard to mainnet', async (t) => {
  const composition = await compose(await composeInput(t, { proxyCredential: CREDENTIAL, sqlitePath: ':memory:' }));
  t.after(() => composition.shutdown());
  assert.equal(composition.dashboard.ctx.profileId, 'mainnet');
});
