// Tests for src/evm-custody-balance-observation.mjs.
//
// This reader owns real public/archive/public-recheck reads through injected fake clients (never
// a live RPC): a fake public client answers `getBlock({blockTag:'finalized'})` and
// `getBlock({blockNumber})`, a fake archive client answers `readErc20BalanceAtBlock`. Tests assert
// on the returned CustodyBalanceObservationV1 shape (exact canonical CAIP identity), on the raw
// token/account the archive client actually receives, and on refusal reasons.
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
const CANONICAL_CHAIN_ID = `eip155:${USDG_PAYOUT_CHAIN_ID}`;
const CANONICAL_ASSET_ID = `${CANONICAL_CHAIN_ID}/erc20:${USDG}`;
const FINALIZED_NUMBER = 100n;
const FINALIZED_HASH = `0x${'a'.repeat(64)}`;

function baseIdentity(overrides = {}) {
  return { chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: USDG_PAYOUT_DECIMALS, account: OPERATIONS, ...overrides };
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

function fakeArchiveClient({ value = 1_000_000n, blockNumber = FINALIZED_NUMBER, blockHash = FINALIZED_HASH, calls = [], requests = [] } = {}) {
  return {
    async readErc20BalanceAtBlock(request) {
      calls.push('archive');
      requests.push(request);
      return { value, blockNumber, blockHash };
    },
  };
}

test('reads and returns the exact frozen CustodyBalanceObservationV1 shape with canonical CAIP identity', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: 12_300_000_000n }),
    identity: baseIdentity(),
  });
  const observation = await reader();
  assert.deepEqual(observation, {
    schema: EVM_CUSTODY_BALANCE_OBSERVATION_SCHEMA,
    account: OPERATIONS,
    balance: { chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: USDG_PAYOUT_DECIMALS, amountAtomic: '12300000000' },
    finality: { height: '100', hash: FINALIZED_HASH, timestampUnixSeconds: '1700000000' },
  });
  assert.ok(Object.isFrozen(observation));
  assert.ok(Object.isFrozen(observation.balance));
  assert.ok(Object.isFrozen(observation.finality));
});

test('passes the parsed raw ERC20 address and the raw account to the archive read, never the CAIP strings', async () => {
  const requests = [];
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ requests }),
    identity: baseIdentity(),
  });
  await reader();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { token: USDG, account: OPERATIONS, blockNumber: FINALIZED_NUMBER, blockHash: FINALIZED_HASH });
});

test('performs the public/archive/public reads in order, never touching the archive before the finalized head or the recheck before the archive read', async () => {
  const calls = [];
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient({ calls }),
    archiveClient: fakeArchiveClient({ calls }),
    identity: baseIdentity(),
  });
  await reader();
  assert.deepEqual(calls, ['finalized', 'archive', 'recheck']);
});

test('refuses a missing archive-capable historical evidence client', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: fakePublicClient(), archiveClient: null, identity: baseIdentity() }),
    /archive-capable/,
  );
});

test('refuses an archive client that is the same instance as the public client', async () => {
  const client = fakePublicClient();
  client.readErc20BalanceAtBlock = async () => ({ value: 0n, blockNumber: FINALIZED_NUMBER, blockHash: FINALIZED_HASH });
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: client, archiveClient: client, identity: baseIdentity() }),
    /archive-capable/,
  );
});

test('refuses a missing public client', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: null, archiveClient: fakeArchiveClient(), identity: baseIdentity() }),
    /public Robinhood RPC client is required/,
  );
});

test('refuses a malformed archive balance amount', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: -1n }),
    identity: baseIdentity(),
  });
  await assert.rejects(() => reader(), /malformed amount/);
});

test('refuses an archive read whose block number does not bind the requested finalized block', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ blockNumber: FINALIZED_NUMBER + 1n }),
    identity: baseIdentity(),
  });
  await assert.rejects(() => reader(), /did not bind the requested finalized block/);
});

test('refuses an archive read whose block hash does not bind the requested finalized block', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ blockHash: `0x${'c'.repeat(64)}` }),
    identity: baseIdentity(),
  });
  await assert.rejects(() => reader(), /did not bind the requested finalized block/);
});

test('refuses when the public finalized block hash changes after the archive read (reorg)', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient({ recheckHash: `0x${'d'.repeat(64)}` }),
    archiveClient: fakeArchiveClient(),
    identity: baseIdentity(),
  });
  await assert.rejects(() => reader(), /hash changed after the archive read/);
});

test('refuses construction with a missing identity', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: null }),
    /canonical identity object is required/,
  );
});

test('refuses a raw numeric (non-CAIP) chain id', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ chainId: USDG_PAYOUT_CHAIN_ID }),
    }),
    /chainId must be the canonical CAIP-2 identifier/,
  );
});

test('refuses a raw un-wrapped ERC20 address as assetId', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ assetId: USDG }),
    }),
    /canonical erc20 CAIP-19 prefix/,
  );
});

test('refuses a wrong CAIP namespace', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ chainId: `solana:${USDG_PAYOUT_CHAIN_ID}` }),
    }),
    /chainId must be the canonical CAIP-2 identifier/,
  );
});

test('refuses a wrong CAIP chain reference', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ chainId: 'eip155:1' }),
    }),
    /chainId must be the canonical CAIP-2 identifier/,
  );
});

test('refuses a wrong CAIP-19 asset type prefix', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ assetId: `${CANONICAL_CHAIN_ID}/erc721:${USDG}` }),
    }),
    /canonical erc20 CAIP-19 prefix/,
  );
});

test('refuses a chain/asset splice: valid chainId paired with an assetId naming a different chain', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(),
      archiveClient: fakeArchiveClient(),
      identity: baseIdentity({ assetId: `eip155:1/erc20:${USDG}` }),
    }),
    /canonical erc20 CAIP-19 prefix/,
  );
});

test('refuses decimals other than the configured USDG decimals', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ decimals: 18 }),
    }),
    /decimals must equal/,
  );
});

test('refuses an assetId whose address portion is malformed', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ assetId: `${CANONICAL_CHAIN_ID}/erc20:not-an-address` }),
    }),
    /assetId must encode a canonical lowercase EVM address/,
  );
});

test('refuses an assetId whose address portion is noncanonical (mixed-case checksummed)', async () => {
  const checksummed = `0x5Fc5360D0400a0fd4f2Af552Add042d716F1d168`;
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ assetId: `${CANONICAL_CHAIN_ID}/erc20:${checksummed}` }),
    }),
    /assetId must encode a canonical lowercase EVM address/,
  );
});

test('refuses a malformed account address', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ account: 'not-an-address' }),
    }),
    /account must be a canonical lowercase EVM address/,
  );
});

test('refuses a noncanonical (mixed-case checksummed) account address', async () => {
  const checksummed = `0x000000000000000000000000000000000000dEaD`;
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: baseIdentity({ account: checksummed }),
    }),
    /account must be a canonical lowercase EVM address/,
  );
});

test('refuses an identity object with an extra field', async () => {
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({
      publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity: { ...baseIdentity(), extra: 'unexpected' },
    }),
    /exact canonical schema/,
  );
});

test('refuses an identity object missing a required field', async () => {
  const identity = baseIdentity();
  delete identity.decimals;
  assert.throws(
    () => createEvmCustodyBalanceObservationReader({ publicClient: fakePublicClient(), archiveClient: fakeArchiveClient(), identity }),
    /exact canonical schema/,
  );
});

test('freezes the pinned identity: mutating the original object after construction never affects the reader', async () => {
  const identity = baseIdentity();
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: 42n }),
    identity,
  });
  identity.account = '0x0000000000000000000000000000000000000001';
  identity.assetId = `${CANONICAL_CHAIN_ID}/erc20:0x0000000000000000000000000000000000000002`;
  const observation = await reader();
  assert.equal(observation.account, OPERATIONS);
  assert.equal(observation.balance.assetId, CANONICAL_ASSET_ID);
});

test('every thrown refusal is an EvmCustodyBalanceObservationError', async () => {
  const reader = createEvmCustodyBalanceObservationReader({
    publicClient: fakePublicClient(),
    archiveClient: fakeArchiveClient({ value: -1n }),
    identity: baseIdentity(),
  });
  await assert.rejects(() => reader(), EvmCustodyBalanceObservationError);
});
