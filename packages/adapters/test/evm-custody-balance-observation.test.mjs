// Tests for src/evm-custody-balance-observation.mjs.
//
// This reader owns real public/archive/public-recheck reads through injected fake clients (never
// a live RPC): a fake public client answers `getBlock({blockTag:'finalized'})` and
// `getBlock({blockNumber})`, a fake archive client answers `readErc20BalanceAtBlock`. Tests assert
// on the returned CustodyBalanceObservationV1 shape and on refusal reasons.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvmCustodyBalanceObservationReader,
  EVM_CUSTODY_BALANCE_OBSERVATION_SCHEMA,
  EvmCustodyBalanceObservationError,
} from '../src/evm-custody-balance-observation.mjs';
import { USDG_PAYOUT_CHAIN_ID, USDG_PAYOUT_DECIMALS } from '../../runner/src/distribution/payout-plan.mjs';

const OPERATIONS = '0x000000000000000000000000000000000000dead';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const FINALIZED_NUMBER = 100n;
const FINALIZED_HASH = `0x${'a'.repeat(64)}`;

function baseRequest(overrides = {}) {
  return { chainId: USDG_PAYOUT_CHAIN_ID, assetId: USDG, decimals: USDG_PAYOUT_DECIMALS, account: OPERATIONS, ...overrides };
}

function fakePublicClient({ finalizedHash = FINALIZED_HASH, recheckHash = finalizedHash, calls = [] } = {}) {
  return {
    async getBlock({ blockTag, blockNumber } = {}) {
      if (blockTag === 'finalized') {
        calls.push('finalized');
        return { number: FINALIZED_NUMBER, hash: finalizedHash, timestamp: 1_700_000_000n };
      }
      if (blockNumber === FINALIZED_NUMBER) {
        calls.push('recheck');
        return { number: FINALIZED_NUMBER, hash: recheckHash, timestamp: 1_700_000_001n };
      }
      throw new Error(`unexpected public block read ${String(blockTag ?? blockNumber)}`);
    },
  };
}

function fakeArchiveClient({ value = 1_000_000n, blockNumber = FINALIZED_NUMBER, blockHash = FINALIZED_HASH, calls = [] } = {}) {
  return {
    async readErc20BalanceAtBlock() {
      calls.push('archive');
      return { value, blockNumber, blockHash };
    },
  };
}

test('reads and returns the exact frozen CustodyBalanceObservationV1 shape', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: 12_300_000_000n }),
  });
  const observation = await reader(baseRequest());
  assert.deepEqual(observation, {
    schema: EVM_CUSTODY_BALANCE_OBSERVATION_SCHEMA,
    account: OPERATIONS,
    balance: { chainId: USDG_PAYOUT_CHAIN_ID, assetId: USDG, decimals: USDG_PAYOUT_DECIMALS, amountAtomic: '12300000000' },
    finality: { height: '100', hash: FINALIZED_HASH, timestampUnixSeconds: '1700000000' },
  });
  assert.ok(Object.isFrozen(observation));
  assert.ok(Object.isFrozen(observation.balance));
  assert.ok(Object.isFrozen(observation.finality));
});

test('performs the public/archive/public reads in order, never touching the archive before the finalized head or the recheck before the archive read', async () => {
  const calls = [];
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient({ calls }),
    archiveClient: fakeArchiveClient({ calls }),
  });
  await reader(baseRequest());
  assert.deepEqual(calls, ['finalized', 'archive', 'recheck']);
});

test('refuses a missing archive-capable historical evidence client', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: fakePublicClient(), archiveClient: null }),
    /archive-capable/,
  );
});

test('refuses an archive client that is the same instance as the public client', async () => {
  const client = fakePublicClient();
  client.readErc20BalanceAtBlock = async () => ({ value: 0n, blockNumber: FINALIZED_NUMBER, blockHash: FINALIZED_HASH });
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: client, archiveClient: client }),
    /archive-capable/,
  );
});

test('refuses a missing public client', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: null, archiveClient: fakeArchiveClient() }),
    /public Robinhood RPC client is required/,
  );
});

test('refuses a malformed archive balance amount', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: -1n }),
  });
  await assert.rejects(() => reader(baseRequest()), /malformed amount/);
});

test('refuses an archive read whose block number does not bind the requested finalized block', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ blockNumber: FINALIZED_NUMBER + 1n }),
  });
  await assert.rejects(() => reader(baseRequest()), /did not bind the requested finalized block/);
});

test('refuses an archive read whose block hash does not bind the requested finalized block', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ blockHash: `0x${'c'.repeat(64)}` }),
  });
  await assert.rejects(() => reader(baseRequest()), /did not bind the requested finalized block/);
});

test('refuses when the public finalized block hash changes after the archive read (reorg)', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient({ recheckHash: `0x${'d'.repeat(64)}` }),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(() => reader(baseRequest()), /hash changed after the archive read/);
});

test('refuses a request identity with a chain id other than the configured EVM chain', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(() => reader(baseRequest({ chainId: 999 })), /chainId must identify chain/);
});

test('refuses a request identity with decimals other than the configured USDG decimals', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(() => reader(baseRequest({ decimals: 18 })), /decimals must equal/);
});

test('refuses a request identity whose assetId is not a well-formed EVM address', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(() => reader(baseRequest({ assetId: 'not-an-address' })), /assetId must be an EVM address/);
});

test('refuses a request identity whose account is not a well-formed EVM address', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  await assert.rejects(() => reader(baseRequest({ account: 'not-an-address' })), /account must be an EVM address/);
});

test('refuses a request that does not use its exact identity schema', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient(),
  });
  const request = baseRequest();
  request.extra = 'unexpected';
  await assert.rejects(() => reader(request), /exact schema/);
});

test('every thrown refusal is an EvmCustodyBalanceObservationError', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: -1n }),
  });
  await assert.rejects(() => reader(baseRequest()), EvmCustodyBalanceObservationError);
});
