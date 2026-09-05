import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeCanonicalPoolSlot0, runPreSignatureCanaries } from '../../src/observability/canaries.mjs';

const addresses = Object.freeze({
  usdgProxy: '0x0000000000000000000000000000000000000001',
  usdgImplementation: '0x0000000000000000000000000000000000000002',
  poolManager: '0x0000000000000000000000000000000000000003',
  positionManager: '0x0000000000000000000000000000000000000004',
  router: '0x0000000000000000000000000000000000000005',
  quoter: '0x0000000000000000000000000000000000000006',
  hook: '0x0000000000000000000000000000000000000007',
  treasury: '0x0000000000000000000000000000000000000008',
  operations: '0x0000000000000000000000000000000000000009',
  destination: '0x000000000000000000000000000000000000000a',
  gas: '0x000000000000000000000000000000000000000b',
});

const hashes = Object.freeze({
  usdgProxy: `0x${'1'.repeat(64)}`,
  usdgImplementation: `0x${'2'.repeat(64)}`,
  poolManager: `0x${'3'.repeat(64)}`,
  positionManager: `0x${'4'.repeat(64)}`,
  router: `0x${'5'.repeat(64)}`,
  quoter: `0x${'6'.repeat(64)}`,
});

function createContext(overrides = {}) {
  const reported = [];
  const resolved = [];
  const config = {
    chainId: 4663,
    contracts: {
      usdg: {
        proxy: { address: addresses.usdgProxy, runtimeHash: hashes.usdgProxy },
        implementation: { address: addresses.usdgImplementation, runtimeHash: hashes.usdgImplementation },
        decimals: 6,
      },
      poolManager: { address: addresses.poolManager, runtimeHash: hashes.poolManager },
      positionManager: { address: addresses.positionManager, runtimeHash: hashes.positionManager },
      router: { address: addresses.router, runtimeHash: hashes.router },
      quoter: { address: addresses.quoter, runtimeHash: hashes.quoter },
    },
    roles: { hookAddress: addresses.hook, cycleId: `0x${'0'.repeat(64)}`, treasury: addresses.treasury, operations: addresses.operations },
    canonicalPool: { poolId: `0x${'f'.repeat(64)}` },
    providerPolicyDigest: `0x${'a'.repeat(64)}`,
    nativeGasReserves: [
      { chainId: 4663, assetId: 'native', decimals: 18, amountAtomic: '100' },
      { chainId: 'solana', assetId: 'native', decimals: 9, amountAtomic: '200' },
    ],
  };
  const runtimeHashes = new Map([
    [addresses.usdgProxy, hashes.usdgProxy],
    [addresses.usdgImplementation, hashes.usdgImplementation],
    [addresses.poolManager, hashes.poolManager],
    [addresses.positionManager, hashes.positionManager],
    [addresses.router, hashes.router],
    [addresses.quoter, hashes.quoter],
  ]);
  const readers = {
    readChainId: async () => 4663,
    readRuntimeCodeHash: async address => runtimeHashes.get(address),
    readProxyImplementation: async () => addresses.usdgImplementation,
    readUsdgDecimals: async () => 6,
    readUsdgPaused: async () => false,
    readUsdgFrozen: async () => false,
    readHookRoles: async () => ({
      treasury: addresses.treasury,
      operations: addresses.operations,
      cycle: { cycleId: config.roles.cycleId, operations: addresses.operations },
    }),
    readCanonicalPoolState: async () => ({ protocolFee: 0n, lpFee: 0n }),
    readProviderPolicyDigest: async () => config.providerPolicyDigest,
    readEvmNonce: async () => 7n,
    readNativeBalance: async reserve => ({ ...reserve, amountAtomic: reserve.chainId === 4663 ? '101' : '201' }),
  };
  return {
    config,
    readers,
    destinations: [addresses.destination],
    freshness: { kind: 'evm', account: addresses.operations, expectedNonce: '7' },
    gasAccounts: { 4663: addresses.gas, solana: 'solana-gas-account' },
    operatorState: { paused: false, executionPaused: false, policyPaused: false, killSwitch: false, lossLimitExceeded: false },
    custody: { unattributed: false },
    reportDrift: async drift => reported.push(drift),
    resolveDrift: async resolution => resolved.push(resolution),
    reported,
    resolved,
    ...overrides,
  };
}

test('all required pre-signature checks pass only with current matching evidence', async () => {
  const context = createContext();

  const result = await runPreSignatureCanaries(context);

  assert.deepEqual(result, { ok: true, drift: [] });
  assert.equal(context.reported.length, 0);
  assert.ok(context.resolved.length >= 10);
});

test('requires every persisted pause flag before permitting a signature', async () => {
  for (const field of ['paused', 'executionPaused', 'policyPaused', 'killSwitch']) {
    const operatorState = { ...createContext().operatorState };
    delete operatorState[field];
    const result = await runPreSignatureCanaries(createContext({ operatorState }));

    assert.equal(result.ok, false, `${field} must be present`);
    assert.deepEqual(result.drift.map(item => item.code), ['OPERATOR_STATE_UNVERIFIED']);
  }
});

test('uses canonical USDG freeze keys for each unique freeze target', async () => {
  const context = createContext({
    destinations: [
      `0x${addresses.destination.slice(2).toUpperCase()}`,
      addresses.operations,
      addresses.destination,
    ],
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, true);
  assert.deepEqual(context.resolved
    .filter(item => item.key.startsWith('canary:usdg-frozen:'))
    .map(item => item.key), [
      `canary:usdg-frozen:${addresses.operations}`,
      `canary:usdg-frozen:${addresses.destination}`,
    ]);
});

test('requires at least one canonical signature destination for USDG freeze checks', async () => {
  const result = await runPreSignatureCanaries(createContext({ destinations: [] }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.drift.map(item => item.code), ['CONFIGURATION_UNVERIFIED']);
  assert.equal(result.drift[0].target, 'USDG freeze targets');
});

test('requires one configured EVM reserve and one configured Solana reserve', async () => {
  const reserves = createContext().config.nativeGasReserves;
  for (const nativeGasReserves of [
    [reserves[0]],
    [reserves[0], reserves[1], reserves[0]],
  ]) {
    const context = createContext({
      config: { ...createContext().config, nativeGasReserves },
    });

    const result = await runPreSignatureCanaries(context);

    assert.equal(result.ok, false);
    assert.ok(result.drift.some(item => item.code === 'CONFIGURATION_UNVERIFIED' && item.target === 'native gas reserves'));
  }
});

test('fails closed when the returned cycle role binding differs from the configured cycle', async () => {
  const expectedCycleId = createContext().config.roles.cycleId;
  for (const cycle of [
    { cycleId: `0x${'1'.repeat(64)}`, operations: addresses.operations },
    { cycleId: expectedCycleId, operations: addresses.treasury },
  ]) {
    const context = createContext({
      readers: {
        ...createContext().readers,
        readHookRoles: async () => ({
          treasury: addresses.treasury,
          operations: addresses.operations,
          cycle,
        }),
      },
    });

    const result = await runPreSignatureCanaries(context);

    assert.equal(result.ok, false);
    assert.deepEqual(result.drift.map(item => item.code), ['HOOK_ROLES_MISMATCH']);
  }
});

test('accepts a valid non-latest Solana blockhash at a bigint block height', async () => {
  const requestedBlockhash = 'older-but-still-valid';
  const checkedBlockhashes = [];
  const context = createContext({
    readers: {
      ...createContext().readers,
      readSolanaBlockhashValidity: async blockhash => {
        checkedBlockhashes.push(blockhash);
        return true;
      },
      readSolanaBlockHeight: async () => 9007199254740993n,
    },
    freshness: {
      kind: 'solana',
      blockhash: requestedBlockhash,
      lastValidBlockHeight: '9007199254740994',
    },
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, true);
  assert.deepEqual(checkedBlockhashes, [requestedBlockhash]);
});

test('rejects an expired Solana request blockhash at a bigint block height', async () => {
  const context = createContext({
    readers: {
      ...createContext().readers,
      readSolanaBlockhashValidity: async () => true,
      readSolanaBlockHeight: async () => 9007199254740995n,
    },
    freshness: {
      kind: 'solana',
      blockhash: 'expired-blockhash',
      lastValidBlockHeight: '9007199254740994',
    },
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, false);
  assert.deepEqual(result.drift.map(item => item.code), ['SOLANA_BLOCKHASH_STALE']);
});

test('every unsafe canary observation blocks signing and requests one actionable alert', async () => {
  const context = createContext({
    readers: {
      ...createContext().readers,
      readChainId: async () => 1,
      readRuntimeCodeHash: async address => address === addresses.router ? hashes.quoter : createContext().readers.readRuntimeCodeHash(address),
      readUsdgDecimals: async () => 18,
      readUsdgPaused: async () => true,
      readUsdgFrozen: async () => true,
      readHookRoles: async () => ({
        treasury: addresses.operations,
        operations: addresses.treasury,
        cycle: { cycleId: createContext().config.roles.cycleId, operations: addresses.treasury },
      }),
      readCanonicalPoolState: async () => ({ protocolFee: 500n, lpFee: 1n }),
      readProviderPolicyDigest: async () => `0x${'b'.repeat(64)}`,
      readEvmNonce: async () => 8n,
      readNativeBalance: async reserve => ({ ...reserve, amountAtomic: '0' }),
    },
    operatorState: { paused: true, executionPaused: false, policyPaused: false, killSwitch: false, lossLimitExceeded: false },
    custody: { unattributed: '1' },
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, false);
  assert.equal(context.reported.length, result.drift.length);
  assert.equal(new Set(context.reported.map(item => item.key)).size, context.reported.length);
  for (const item of result.drift) {
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.action, 'string');
    assert.ok(item.action.length > 0);
  }
  assert.deepEqual(new Set(result.drift.map(item => item.code)), new Set([
    'CHAIN_ID_MISMATCH',
    'RUNTIME_HASH_MISMATCH',
    'USDG_DECIMALS_MISMATCH',
    'USDG_PAUSED',
    'USDG_FROZEN',
    'HOOK_ROLES_MISMATCH',
    'POOL_FEE_NONZERO',
    'PROVIDER_POLICY_DIGEST_MISMATCH',
    'EVM_NONCE_STALE',
    'NATIVE_GAS_BELOW_MINIMUM',
    'EXECUTION_PAUSED',
    'UNATTRIBUTED_CUSTODY',
  ]));
});

test('missing or failed evidence fails closed without exposing reader errors', async () => {
  const context = createContext({
    readers: {
      ...createContext().readers,
      readRuntimeCodeHash: async () => { throw new Error('credential=value-that-must-not-escape'); },
    },
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, false);
  assert.equal(result.drift.filter(item => item.target.endsWith('runtime') && item.code.endsWith('_UNVERIFIED')).length, 6);
  assert.doesNotMatch(JSON.stringify(result), /value-that-must-not-escape/);
});

test('Solana blockhash freshness, persisted loss limits, and custody amounts fail closed', async () => {
  const context = createContext({
    readers: {
      ...createContext().readers,
      readSolanaBlockhashValidity: async () => true,
      readSolanaBlockHeight: async () => 30n,
    },
    freshness: { kind: 'solana', blockhash: 'expected', lastValidBlockHeight: 20 },
    operatorState: { paused: false, executionPaused: false, policyPaused: false, killSwitch: false, lossAtomic: '101', lossLimitAtomic: '100' },
    custody: { unattributed: '2' },
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.drift.map(item => item.code)), new Set([
    'SOLANA_BLOCKHASH_STALE',
    'LOSS_LIMIT_EXCEEDED',
    'UNATTRIBUTED_CUSTODY',
  ]));
});

test('Solana freshness rejects an invalid request blockhash', async () => {
  const context = createContext({
    readers: {
      ...createContext().readers,
      readSolanaBlockhashValidity: async () => false,
      readSolanaBlockHeight: async () => 20n,
    },
    freshness: { kind: 'solana', blockhash: 'expected', lastValidBlockHeight: 20 },
  });

  const result = await runPreSignatureCanaries(context);

  assert.equal(result.ok, false);
  assert.deepEqual(result.drift.map(item => item.code), ['SOLANA_BLOCKHASH_STALE']);
});

test('decodes the protocol and live LP fees from the canonical pool slot0 word', () => {
  const word = (500n << 184n) | (3000n << 208n);

  assert.deepEqual(decodeCanonicalPoolSlot0(`0x${word.toString(16)}`), { protocolFee: 500n, lpFee: 3000n });
  assert.throws(() => decodeCanonicalPoolSlot0('not-hex'), /slot0 word/);
});
