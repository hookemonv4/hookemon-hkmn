import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAbiParameters, keccak256, toHex } from 'viem';

import { createCanonicalPoolStateReader, createObservability } from '../../src/app/observability.mjs';
import { createSolanaRpcClient } from '../../src/solana-rpc.mjs';

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
});

const hashes = Object.freeze({
  usdgProxy: `0x${'1'.repeat(64)}`,
  usdgImplementation: `0x${'2'.repeat(64)}`,
  poolManager: `0x${'3'.repeat(64)}`,
  positionManager: `0x${'4'.repeat(64)}`,
  router: `0x${'5'.repeat(64)}`,
  quoter: `0x${'6'.repeat(64)}`,
});

const SOLANA_ACCOUNT = '11111111111111111111111111111111';
const SOLANA_BLOCKHASH = 'SysvarC1ock11111111111111111111111111111111';

function canaryConfig() {
  return {
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
}

function createReaders(config) {
  const runtimeHashes = new Map([
    [addresses.usdgProxy, hashes.usdgProxy],
    [addresses.usdgImplementation, hashes.usdgImplementation],
    [addresses.poolManager, hashes.poolManager],
    [addresses.positionManager, hashes.positionManager],
    [addresses.router, hashes.router],
    [addresses.quoter, hashes.quoter],
  ]);
  return {
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
    readCustody: async () => ({ unattributed: false }),
  };
}

function createConfig() {
  return {
    canaries: canaryConfig(),
    alert: {
      webhookUrl: 'https://alerts.example.test/hooks?access=not-for-output',
      dedupePath: ':memory:',
      dedupeWindowMs: 1_000,
      maxAttempts: 3,
      backoffMs: 1,
    },
    startPreflight: {
      requiredSignerRoles: ['evm', 'solana'],
      requireEvmRpc: true,
      requireSolanaRpc: true,
    },
  };
}

function canaryContext() {
  return {
    destinations: [addresses.destination],
    freshness: { kind: 'evm', account: addresses.operations, expectedNonce: '7' },
    operatorState: {
      paused: false,
      executionPaused: false,
      policyPaused: false,
      killSwitch: false,
      lossLimitExceeded: false,
    },
    custody: { unattributed: false },
  };
}

test('composer exposes pre-signature canaries with one deduplicated, redacted webhook alert path', async () => {
  const config = createConfig();
  const alerts = [];
  const logRecords = [];
  const observability = createObservability(config, {
    readers: createReaders(config.canaries),
    signers: {
      evm: { probe: async () => ({ ready: true }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => config.canaries.chainId,
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async (_url, request) => {
      alerts.push(JSON.parse(request.body));
      return { ok: true, status: 204 };
    },
    sleep: async () => {},
    logger: {
      debug: (event, fields) => logRecords.push({ event, fields }),
      info: (event, fields) => logRecords.push({ event, fields }),
      warn: (event, fields) => logRecords.push({ event, fields }),
      error: (event, fields) => logRecords.push({ event, fields }),
    },
  });
  try {
    assert.equal(typeof observability.runPreSignatureCanaries, 'function');
    assert.equal(typeof observability.runStartPreflight, 'function');

    assert.deepEqual(await observability.runStartPreflight(), { ok: true, drift: [] });
    assert.deepEqual(await observability.runPreSignatureCanaries(canaryContext()), { ok: true, drift: [] });

    const pausedContext = {
      ...canaryContext(),
      operatorState: {
        paused: true,
        executionPaused: false,
        policyPaused: false,
        killSwitch: false,
        lossLimitExceeded: false,
      },
    };
    assert.equal((await observability.runPreSignatureCanaries(pausedContext)).ok, false);
    assert.equal((await observability.runPreSignatureCanaries(pausedContext)).ok, false);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].reason, 'CANARY_DRIFT');
    assert.equal(alerts[0].detail.code, 'EXECUTION_PAUSED');

    await observability.runPreSignatureCanaries(canaryContext());
    await observability.runPreSignatureCanaries(pausedContext);
    assert.equal(alerts.length, 2, 'a verified clear condition must rearm the persistent dedupe key');
    assert.doesNotMatch(JSON.stringify({ alerts, logRecords }), /not-for-output/);
  } finally {
    observability.close();
  }
});

test('start preflight fails closed for incomplete config, unavailable sign-only probes, and unreachable RPCs', async () => {
  const config = createConfig();
  const observability = createObservability({ ...config, canaries: null }, {
    signers: { evm: {} },
    probeEvmRpc: async () => { throw new Error('endpoint unavailable'); },
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async () => ({ ok: true, status: 204 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const result = await observability.runStartPreflight();

    assert.equal(result.ok, false);
    assert.ok(result.drift.some(item => item.code === 'CONFIG_INCOMPLETE'));
    assert.ok(result.drift.some(item => item.code === 'SIGNER_READINESS_UNAVAILABLE'));
    assert.ok(result.drift.some(item => item.code === 'EVM_RPC_UNREACHABLE'));
  } finally {
    observability.close();
  }
});

test('start preflight reports one durable alert when a signer is not ready', async () => {
  const config = createConfig();
  const alerts = [];
  const observability = createObservability(config, {
    signers: {
      evm: { probe: async () => ({ ready: false }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => config.canaries.chainId,
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async (_url, request) => {
      alerts.push(JSON.parse(request.body));
      return { ok: true, status: 204 };
    },
    sleep: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const result = await observability.runStartPreflight();

    assert.equal(result.ok, false);
    assert.deepEqual(result.drift.map(item => item.code), ['SIGNER_NOT_READY']);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].reason, 'START_PREFLIGHT_FAILED');
    assert.deepEqual(alerts[0].detail.expected, { ready: true });
  } finally {
    observability.close();
  }
});

test('start preflight requires a durable alert sink and positive EVM and Solana RPC evidence', async () => {
  const config = createConfig();
  const observability = createObservability(config, {
    alertDeduper: {},
    signers: {
      evm: { probe: async () => ({ ready: true }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => undefined,
    probeSolanaRpc: async () => ({}),
    fetchImpl: async () => ({ ok: true, status: 204 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const result = await observability.runStartPreflight();

    assert.equal(result.ok, false);
    assert.ok(result.drift.some(item => item.code === 'ALERT_SINK_UNAVAILABLE'));
    assert.ok(result.drift.some(item => item.code === 'EVM_RPC_UNREACHABLE'));
    assert.ok(result.drift.some(item => item.code === 'SOLANA_RPC_UNREACHABLE'));
  } finally {
    observability.close();
  }
});

test('start preflight rejects a method-shaped deduper whose readiness probe fails', async () => {
  const config = createConfig();
  const observability = createObservability(config, {
    alertDeduper: {
      ready() { throw new Error('storage unavailable'); },
      claim: () => ({ deliver: true, state: 'PENDING', token: 1 }),
      markPending() {},
      markDelivered() {},
      resolve() {},
    },
    signers: {
      evm: { probe: async () => ({ ready: true }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => config.canaries.chainId,
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async () => ({ ok: true, status: 204 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const result = await observability.runStartPreflight();

    assert.equal(result.ok, false);
    assert.ok(result.drift.some(item => item.code === 'ALERT_SINK_UNAVAILABLE'));
  } finally {
    observability.close();
  }
});

test('start preflight accepts a zero dedupe window while retaining a positive delivery lease', async () => {
  const config = createConfig();
  config.alert.dedupeWindowMs = 0;
  const observability = createObservability(config, {
    signers: {
      evm: { probe: async () => ({ ready: true }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => config.canaries.chainId,
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async () => ({ ok: true, status: 204 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    assert.deepEqual(await observability.runStartPreflight(), { ok: true, drift: [] });
  } finally {
    observability.close();
  }
});

test('reporter leaves a failed delivery pending and marks its successful retry delivered with each claim token', async () => {
  const config = createConfig();
  config.alert.maxAttempts = 1;
  const transitions = [];
  let token = 0;
  let attempts = 0;
  const observability = createObservability(config, {
    alertDeduper: {
      ready: () => true,
      claim(key) {
        token += 1;
        transitions.push({ operation: 'claim', key, token });
        return { deliver: true, state: 'PENDING', token };
      },
      markPending(key, claimToken) {
        transitions.push({ operation: 'pending', key, token: claimToken });
      },
      markDelivered(key, claimToken) {
        transitions.push({ operation: 'delivered', key, token: claimToken });
      },
      resolve() {},
    },
    readers: createReaders(config.canaries),
    signers: {
      evm: { probe: async () => ({ ready: true }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => config.canaries.chainId,
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async () => {
      attempts += 1;
      return { ok: attempts === 2, status: attempts === 2 ? 204 : 503 };
    },
    sleep: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const paused = {
      ...canaryContext(),
      operatorState: {
        paused: true,
        executionPaused: false,
        policyPaused: false,
        killSwitch: false,
        lossLimitExceeded: false,
      },
    };
    assert.equal((await observability.runPreSignatureCanaries(paused)).ok, false);
    assert.equal((await observability.runPreSignatureCanaries(paused)).ok, false);

    assert.deepEqual(transitions.filter(transition => transition.operation !== 'resolve'), [
      { operation: 'claim', key: 'canary:operator-state', token: 1 },
      { operation: 'pending', key: 'canary:operator-state', token: 1 },
      { operation: 'claim', key: 'canary:operator-state', token: 2 },
      { operation: 'delivered', key: 'canary:operator-state', token: 2 },
    ]);
  } finally {
    observability.close();
  }
});

test('reporter leases a pending delivery for the full retry window before another canary can retry it', async () => {
  const config = createConfig();
  config.alert.dedupeWindowMs = 1;
  config.alert.maxAttempts = 2;
  config.alert.backoffMs = 10;
  config.alert.timeoutMs = 1_000;
  let now = 0;
  let fetchCalls = 0;
  let releaseFirstDelivery;
  let firstDeliveryStarted;
  const firstDelivery = new Promise(resolve => { releaseFirstDelivery = resolve; });
  const started = new Promise(resolve => { firstDeliveryStarted = resolve; });
  const observability = createObservability(config, {
    readers: createReaders(config.canaries),
    now: () => now,
    signers: {
      evm: { probe: async () => ({ ready: true }) },
      solana: { probe: async () => ({ ready: true }) },
    },
    probeEvmRpc: async () => config.canaries.chainId,
    probeSolanaRpc: async () => ({ blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 }),
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        firstDeliveryStarted();
        await firstDelivery;
      }
      return { ok: true, status: 204 };
    },
    sleep: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const paused = {
      ...canaryContext(),
      operatorState: {
        paused: true,
        executionPaused: false,
        policyPaused: false,
        killSwitch: false,
        lossLimitExceeded: false,
      },
    };
    const first = observability.runPreSignatureCanaries(paused);
    await started;
    now = 2;
    const second = await observability.runPreSignatureCanaries(paused);

    assert.equal(second.ok, false);
    assert.equal(fetchCalls, 1);

    releaseFirstDelivery();
    assert.equal((await first).ok, false);
  } finally {
    releaseFirstDelivery?.();
    observability.close();
  }
});

test('the default PoolManager reader uses extsload over the v4 canonical pool slot', async () => {
  const poolId = `0x${'f'.repeat(64)}`;
  const word = (500n << 184n) | (3000n << 208n);
  let request;
  const reader = createCanonicalPoolStateReader({
    evmClient: {
      readContract: async value => {
        request = value;
        return `0x${word.toString(16).padStart(64, '0')}`;
      },
    },
    poolManager: addresses.poolManager,
  });

  const result = await reader(poolId);
  const expectedSlot = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }],
    [poolId, toHex(6, { size: 32 })],
  ));

  assert.deepEqual(result, { protocolFee: 500n, lpFee: 3000n });
  assert.equal(request.address, addresses.poolManager);
  assert.equal(request.functionName, 'extsload');
  assert.deepEqual(request.args, [expectedSlot]);
});

test('default readers collect EVM pending nonce and Solana standalone RPC evidence', async () => {
  const config = createConfig();
  const codeByAddress = new Map([
    [addresses.usdgProxy, '0x01'],
    [addresses.usdgImplementation, '0x02'],
    [addresses.poolManager, '0x03'],
    [addresses.positionManager, '0x04'],
    [addresses.router, '0x05'],
    [addresses.quoter, '0x06'],
  ]);
  config.canaries.contracts.usdg.proxy.runtimeHash = keccak256(codeByAddress.get(addresses.usdgProxy));
  config.canaries.contracts.usdg.implementation.runtimeHash = keccak256(codeByAddress.get(addresses.usdgImplementation));
  config.canaries.contracts.poolManager.runtimeHash = keccak256(codeByAddress.get(addresses.poolManager));
  config.canaries.contracts.positionManager.runtimeHash = keccak256(codeByAddress.get(addresses.positionManager));
  config.canaries.contracts.router.runtimeHash = keccak256(codeByAddress.get(addresses.router));
  config.canaries.contracts.quoter.runtimeHash = keccak256(codeByAddress.get(addresses.quoter));
  config.canaries.gasAccounts = { 4663: addresses.operations, solana: SOLANA_ACCOUNT };
  const calls = [];
  const solanaMethods = [];
  const poolWord = (0n << 184n) | (0n << 208n);
  const observability = createObservability(config, {
    evmClient: {
      getChainId: async () => 4663,
      getCode: async ({ address }) => codeByAddress.get(address),
      getStorageAt: async request => {
        calls.push({ method: 'getStorageAt', request });
        return `0x${addresses.usdgImplementation.slice(2).padStart(64, '0')}`;
      },
      readContract: async request => {
        calls.push({ method: 'readContract', request });
        if (request.functionName === 'decimals') return 6;
        if (request.functionName === 'paused' || request.functionName === 'isFrozen') return false;
        if (request.functionName === 'readRoles') {
          return {
            roles: { treasury: addresses.treasury, operations: addresses.operations },
            cycle: { cycleId: config.canaries.roles.cycleId, operations: addresses.operations },
          };
        }
        if (request.functionName === 'extsload') return `0x${poolWord.toString(16).padStart(64, '0')}`;
        throw new Error(`unexpected function ${request.functionName}`);
      },
      getTransactionCount: async request => {
        calls.push({ method: 'getTransactionCount', request });
        return 7n;
      },
      getBalance: async () => 101n,
    },
    solanaClient: createSolanaRpcClient({
      rpcUrl: 'https://solana.example.test',
      fetchImpl: async (_url, request) => {
        const body = JSON.parse(request.body);
        solanaMethods.push(body.method);
        const result = body.method === 'isBlockhashValid'
          ? { value: true }
          : body.method === 'getBlockHeight'
            ? 99
            : body.method === 'getBalance'
              ? { value: 201 }
              : null;
        if (result === null) throw new Error(`unexpected Solana method ${body.method}`);
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
      },
    }),
    cycleRepository: {
      readClaimPreconditions: async () => ({ unattributed: false }),
    },
    readProviderPolicyDigest: async () => config.canaries.providerPolicyDigest,
    fetchImpl: async () => ({ ok: true, status: 204 }),
  });
  try {
    const result = await observability.runPreSignatureCanaries({
      destinations: [addresses.destination],
      freshness: { kind: 'solana', blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 100 },
      operatorState: {
        paused: false,
        executionPaused: false,
        policyPaused: false,
        killSwitch: false,
        lossLimitExceeded: false,
      },
    });

    assert.deepEqual(result, { ok: true, drift: [] });
    assert.equal(calls.find(call => call.method === 'getStorageAt').request.slot, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
    assert.ok(calls.some(call => call.method === 'readContract' && call.request.functionName === 'decimals'));
    assert.ok(calls.some(call => call.method === 'readContract' && call.request.functionName === 'paused'));
    assert.equal(calls.filter(call => call.method === 'readContract' && call.request.functionName === 'isFrozen').length, 2);
    assert.ok(calls.some(call => call.method === 'readContract' && call.request.functionName === 'readRoles'));
    assert.ok(calls.some(call => call.method === 'readContract' && call.request.functionName === 'extsload'));
    assert.deepEqual(solanaMethods.sort(), ['getBalance', 'getBlockHeight', 'isBlockhashValid']);

    const evmResult = await observability.runPreSignatureCanaries({
      destinations: [addresses.destination],
      freshness: { kind: 'evm', account: addresses.operations, expectedNonce: '7' },
      operatorState: {
        paused: false,
        executionPaused: false,
        policyPaused: false,
        killSwitch: false,
        lossLimitExceeded: false,
      },
    });
    assert.deepEqual(evmResult, { ok: true, drift: [] });
    assert.deepEqual(calls.find(call => call.method === 'getTransactionCount').request, {
      address: addresses.operations,
      blockTag: 'pending',
    });
  } finally {
    observability.close();
  }
});

test('malformed pin configuration fails the start preflight instead of throwing during composition', async () => {
  const config = createConfig();
  config.canaries.contracts.poolManager.address = 'not-an-address';
  const observability = createObservability(config, {
    evmClient: { readContract: async () => '0x' },
    fetchImpl: async () => ({ ok: true, status: 204 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const result = await observability.runStartPreflight();

    assert.equal(result.ok, false);
    assert.ok(result.drift.some(item => item.target === 'canaries.contracts.poolManager.address'));
  } finally {
    observability.close();
  }
});
