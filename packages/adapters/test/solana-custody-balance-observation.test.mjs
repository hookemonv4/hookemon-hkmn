// Tests for src/solana-custody-balance-observation.mjs.
//
// Pure combiner: no fetch, no RPC client, no network — every test builds plain fixture objects
// for the two read sides and asserts on the returned observation or the rejection reason.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  combineFinalizedBalanceObservation,
  observeFinalizedBalanceWithRetry,
  SolanaCustodyObservationError,
} from '../src/solana-custody-balance-observation.mjs';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ADDRESS = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
const GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function side(overrides = {}) {
  return {
    commitment: 'finalized',
    context: { slot: 123 },
    tokenAccount: {
      address: ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ID,
      owner: OWNER,
      mint: MINT,
      amountAtomic: '1000000',
      decimals: 6,
    },
    block: { blockhash: 'HASH_123', blockTime: 1_800_000_000 },
    ...overrides,
  };
}

const CANONICAL = {
  chainId: 'test-chain', assetId: 'test-usd', decimals: 6, mint: MINT, owner: OWNER, tokenProgramId: TOKEN_PROGRAM_ID,
};

test('accepts two agreeing finalized sides and binds only the caller-supplied canonical identity', () => {
  const observation = combineFinalizedBalanceObservation(side(), side(), CANONICAL);
  assert.deepEqual(observation, {
    account: ADDRESS,
    balance: { chainId: 'test-chain', assetId: 'test-usd', decimals: 6, amountAtomic: '1000000' },
    finality: { height: '123', hash: 'HASH_123', timestampUnixSeconds: '1800000000' },
  });
});

test('preserves a null blockTime as timestampUnixSeconds: null rather than inventing one', () => {
  const observation = combineFinalizedBalanceObservation(
    side({ block: { blockhash: 'HASH_123', blockTime: null } }),
    side({ block: { blockhash: 'HASH_123', blockTime: null } }),
    CANONICAL,
  );
  assert.equal(observation.finality.timestampUnixSeconds, null);
});

test('rejects mismatched context slots between the two sides', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(side(), side({ context: { slot: 124 } }), CANONICAL),
    SolanaCustodyObservationError,
  );
});

test('rejects mismatched block hashes between the two sides', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(side(), side({ block: { blockhash: 'HASH_OTHER', blockTime: 1_800_000_000 } }), CANONICAL),
    SolanaCustodyObservationError,
  );
});

test('rejects a token account mint that does not match the expected canonical mint', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(
      side({ tokenAccount: { ...side().tokenAccount, mint: 'So11111111111111111111111111111111111111112' } }),
      side(),
      CANONICAL,
    ),
    SolanaCustodyObservationError,
  );
});

test('rejects a token account owner that does not match the expected canonical owner', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(
      side({ tokenAccount: { ...side().tokenAccount, owner: 'Cvfyvvv2asfHnhpMj2XysoLnA5EAgqNAJ2rQXGtc4NyV' } }),
      side(),
      CANONICAL,
    ),
    SolanaCustodyObservationError,
  );
});

test('rejects a token account address mismatch between the two sides', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(
      side(),
      side({ tokenAccount: { ...side().tokenAccount, address: 'Cvfyvvv2asfHnhpMj2XysoLnA5EAgqNAJ2rQXGtc4NyV' } }),
      CANONICAL,
    ),
    SolanaCustodyObservationError,
  );
});

test('rejects an amount mismatch between the two sides', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(
      side(),
      side({ tokenAccount: { ...side().tokenAccount, amountAtomic: '999999' } }),
      CANONICAL,
    ),
    SolanaCustodyObservationError,
  );
});

test('rejects a decimals mismatch against the canonical identity', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(
      side({ tokenAccount: { ...side().tokenAccount, decimals: 9 } }),
      side({ tokenAccount: { ...side().tokenAccount, decimals: 9 } }),
      CANONICAL,
    ),
    SolanaCustodyObservationError,
  );
});

test('rejects a non-finalized commitment on either side', () => {
  assert.throws(
    () => combineFinalizedBalanceObservation(side({ commitment: 'confirmed' }), side(), CANONICAL),
    SolanaCustodyObservationError,
  );
});

test('rejects a null or malformed side instead of coercing it', () => {
  assert.throws(() => combineFinalizedBalanceObservation(null, side(), CANONICAL), SolanaCustodyObservationError);
  assert.throws(() => combineFinalizedBalanceObservation(side(), { commitment: 'finalized' }, CANONICAL), SolanaCustodyObservationError);
});

test('genesis identity validation: both sides must prove the same expected genesis hash', () => {
  const observation = combineFinalizedBalanceObservation(
    side({ genesisHash: GENESIS_HASH }),
    side({ genesisHash: GENESIS_HASH }),
    { ...CANONICAL, expectedGenesisHash: GENESIS_HASH },
  );
  assert.equal(observation.account, ADDRESS);

  assert.throws(
    () => combineFinalizedBalanceObservation(
      side({ genesisHash: 'wrong-genesis-hash-000000000000000000000000000' }),
      side({ genesisHash: GENESIS_HASH }),
      { ...CANONICAL, expectedGenesisHash: GENESIS_HASH },
    ),
    SolanaCustodyObservationError,
  );
});

test('observeFinalizedBalanceWithRetry accepts on the first agreeing round and never over-calls readRound', async () => {
  let calls = 0;
  const observation = await observeFinalizedBalanceWithRetry(async () => {
    calls += 1;
    return { sideA: side(), sideB: side() };
  }, CANONICAL, { maxAttempts: 3 });
  assert.equal(calls, 1);
  assert.equal(observation.balance.amountAtomic, '1000000');
});

test('observeFinalizedBalanceWithRetry retries a transient mismatch and then succeeds within the bound', async () => {
  let calls = 0;
  const observation = await observeFinalizedBalanceWithRetry(async () => {
    calls += 1;
    if (calls === 1) return { sideA: side(), sideB: side({ context: { slot: 999 } }) };
    return { sideA: side(), sideB: side() };
  }, CANONICAL, { maxAttempts: 3 });
  assert.equal(calls, 2);
  assert.equal(observation.finality.height, '123');
});

test('observeFinalizedBalanceWithRetry exhausts its bounded attempts and throws, never returning a partial result', async () => {
  let calls = 0;
  await assert.rejects(
    observeFinalizedBalanceWithRetry(async () => {
      calls += 1;
      return { sideA: side(), sideB: side({ context: { slot: 999 } }) };
    }, CANONICAL, { maxAttempts: 3 }),
    SolanaCustodyObservationError,
  );
  assert.equal(calls, 3);
});
