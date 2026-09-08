import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Keypair } from '@solana/web3.js';
import { http } from 'viem';

import { createRobinhoodClient, readChainId } from '../../src/robinhood-rpc.mjs';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import { COLLECTOR_PURCHASE_BINDING_SCHEMA } from '../../src/signing/collector-purchase-policy.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA } from '../../src/signing/collector-buyback-policy.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE,
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
  COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
  CollectorProductionBindingError,
  assertCollectorOfflineExecutionBoundary,
  createIsolatedKeychainChildSetup,
  createLoopbackConfinedFetch,
  loadCollectorProductionBindingRegistry,
  resolveCollectorProductionBinding,
} from '../../src/signing/collector-production-binding.mjs';

// A real isolated child setup, built once for this whole file: a real ephemeral keypair generated
// through the real `bin/hookemon-wallet.mjs generate` CLI against this module's own fixed,
// reviewed fake `security` fixture (never a caller-supplied backend), and a real wrapper spawning
// the real `bin/hookemon-keychain-signer.mjs` -- never a hand-built lookalike object.
const cleanupFns = [];
let sharedSetup;
before(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-isolated-child-setup-'));
  cleanupFns.push(() => rm(directory, { recursive: true, force: true }));
  sharedSetup = await createIsolatedKeychainChildSetup({ directory });
});
after(async () => {
  for (const fn of cleanupFns.splice(0).reverse()) await fn();
});

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COLLECTOR_PROGRAM_ID = Keypair.generate().publicKey.toBase58();

const PURCHASE_BINDING = Object.freeze({
  schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  settlement: {
    destination: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    decimals: 6,
  },
  providerCoSigner: Keypair.generate().publicKey.toBase58(),
  instructions: [
    { kind: 'compute-budget-set-unit-limit', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: 40000, priorityFeeCapAtomic: null, memoPrefix: null },
    { kind: 'compute-budget-set-unit-price', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: null, priorityFeeCapAtomic: '5000', memoPrefix: null },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'source-ata', isSigner: false, isWritable: true },
        { role: 'settlement-mint', isSigner: false, isWritable: false },
        { role: 'settlement-destination', isSigner: false, isWritable: true },
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      memoPrefix: null,
    },
    {
      kind: 'unknown',
      programId: MEMO_PROGRAM_ID,
      accounts: [{ role: 'provider-co-signer', isSigner: true, isWritable: false }],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      memoPrefix: 'collector-purchase:v1:',
    },
  ],
});

const BUYBACK_BINDING = Object.freeze({
  schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  proceeds: {
    source: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    decimals: 6,
  },
  collectorAuthority: Keypair.generate().publicKey.toBase58(),
  collectorRecipient: Keypair.generate().publicKey.toBase58(),
  instructions: [
    { kind: 'compute-budget-set-unit-limit', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: 40000, priorityFeeCapAtomic: null, discriminatorHex: null },
    { kind: 'compute-budget-set-unit-price', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: null, priorityFeeCapAtomic: '5000', discriminatorHex: null },
    {
      kind: 'unknown',
      programId: COLLECTOR_PROGRAM_ID,
      accounts: [
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
        { role: 'opened-asset-mint', isSigner: false, isWritable: true },
        { role: 'collector-recipient', isSigner: false, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: 'a1b2c3d4e5f60718',
    },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'proceeds-source', isSigner: false, isWritable: true },
        { role: 'proceeds-mint', isSigner: false, isWritable: false },
        { role: 'proceeds-destination', isSigner: false, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: null,
    },
  ],
});

function registryEntry({ authority, stage, binding }) {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
    version: 1,
    authority,
    stage,
    chainId: 'solana-mainnet',
    provider: 'collector-crypt',
    binding,
    expectedDigest: digest(binding),
  };
}

function rawRegistry(entries) {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
    version: 1,
    entries,
  };
}

const OFFLINE_ENTRIES = [
  registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: PURCHASE_BINDING }),
  registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', binding: BUYBACK_BINDING }),
];

function offlineConfig(overrides = {}) {
  return {
    execution: { profile: 'production' },
    rehearsal: null,
    collectorCrypt: {
      baseUrl: 'http://127.0.0.1:4001',
      apiKey: null,
      productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
    },
    robinhood: { rpcUrl: 'http://localhost:4002', archiveRpcUrl: 'http://localhost:4003' },
    solana: { rpcUrl: 'http://127.0.0.1:4004' },
    relay: { baseUrl: 'https://localhost:4005', apiKey: null },
    signer: {
      backend: 'keychain',
      liveMode: true,
      keychain: {
        command: sharedSetup.command,
        solanaAccount: 'operator-solana',
        isolatedChildSetup: sharedSetup,
      },
    },
    ...overrides,
  };
}

// Deliberately never uses structuredClone: `isolatedChildSetup` is an opaque, WeakSet-branded
// capability object whose identity (not its field values) is what the boundary checks. Cloning it
// would silently strip that identity from every test that does not explicitly touch the field.
// This merge instead preserves object references all the way down except where a patch actually
// replaces them.
function deepMerge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      && base[key] !== null && typeof base[key] === 'object'
      ? deepMerge(base[key], value)
      : value;
  }
  return result;
}

test('loads a registry carrying only a synthetic-offline purchase and buyback entry', () => {
  const registry = loadCollectorProductionBindingRegistry(rawRegistry(OFFLINE_ENTRIES));
  assert.equal(registry.entries.length, 2);
  assert.ok(registry.entries.every(entry => entry.authority === COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE));
});

test('refuses to load a registry entry declaring live authority even with a self-consistent digest', () => {
  const entries = [...OFFLINE_ENTRIES, registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE, stage: 'purchase', binding: PURCHASE_BINDING })];
  assert.throws(() => loadCollectorProductionBindingRegistry(rawRegistry(entries)), CollectorProductionBindingError);
});

test('refuses to load a registry entry whose digest does not match its own binding bytes', () => {
  const entry = registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: PURCHASE_BINDING });
  entry.expectedDigest = `sha256:${'0'.repeat(64)}`;
  // The per-stage validator (assertCollectorPurchaseBindingV1) throws its own typed error here,
  // not CollectorProductionBindingError: the registry loader delegates digest verification to it
  // rather than duplicating the check, so its error type propagates unchanged.
  assert.throws(() => loadCollectorProductionBindingRegistry(rawRegistry([entry])), /digest does not match/);
});

test('refuses to load a registry with a duplicate authority/stage identity', () => {
  const entries = [...OFFLINE_ENTRIES, registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: PURCHASE_BINDING })];
  assert.throws(() => loadCollectorProductionBindingRegistry(rawRegistry(entries)), CollectorProductionBindingError);
});

test('refuses to load a registry entry with an extra unexpected field', () => {
  const entry = { ...registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: PURCHASE_BINDING }), extra: 'nope' };
  assert.throws(() => loadCollectorProductionBindingRegistry(rawRegistry([entry])), CollectorProductionBindingError);
});

test('resolves the synthetic-offline purchase binding under a fully satisfied offline boundary', () => {
  const registry = loadCollectorProductionBindingRegistry(rawRegistry(OFFLINE_ENTRIES));
  const config = offlineConfig();
  const resolved = resolveCollectorProductionBinding({ registry, authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', config });
  assert.equal(resolved.binding.schema, COLLECTOR_PURCHASE_BINDING_SCHEMA);
  assert.equal(resolved.expectedDigest, digest(PURCHASE_BINDING));
});

test('resolves the synthetic-offline buyback binding under a fully satisfied offline boundary', () => {
  const registry = loadCollectorProductionBindingRegistry(rawRegistry(OFFLINE_ENTRIES));
  const config = offlineConfig();
  const resolved = resolveCollectorProductionBinding({ registry, authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', config });
  assert.equal(resolved.binding.schema, COLLECTOR_BUYBACK_BINDING_SCHEMA);
});

test('refuses live authority resolution unconditionally even against a hand-built registry object', () => {
  const registry = { schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA, version: 1, entries: [{ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE, stage: 'purchase', chainId: 'solana-mainnet', provider: 'collector-crypt', expectedDigest: digest(PURCHASE_BINDING), binding: PURCHASE_BINDING }] };
  assert.throws(
    () => resolveCollectorProductionBinding({ registry, authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE, stage: 'purchase', config: offlineConfig({ collectorCrypt: { productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE } }) }),
    CollectorProductionBindingError,
  );
});

test('refuses resolution for a missing authority/stage combination', () => {
  const registry = loadCollectorProductionBindingRegistry(rawRegistry([OFFLINE_ENTRIES[0]]));
  assert.throws(
    () => resolveCollectorProductionBinding({ registry, authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', config: offlineConfig() }),
    CollectorProductionBindingError,
  );
});

const OFFLINE_BOUNDARY_REFUSALS = [
  ['a non-production execution profile', { execution: { profile: 'rehearsal' } }],
  ['a rehearsal configuration', { rehearsal: { mode: 'collector-only' } }],
  ['a missing productionBindingAuthority', { collectorCrypt: { productionBindingAuthority: null } }],
  ['a nonlocal Collector base URL', { collectorCrypt: { baseUrl: 'https://collector.example.com' } }],
  ['a missing Collector base URL', { collectorCrypt: { baseUrl: null } }],
  ['a nonlocal Solana RPC URL', { solana: { rpcUrl: 'https://mainnet.example.com' } }],
  ['a missing Robinhood archive RPC URL', { robinhood: { archiveRpcUrl: null } }],
  ['a nonlocal Relay base URL', { relay: { baseUrl: 'https://relay.example.com' } }],
  ['a non-HTTP endpoint protocol', { collectorCrypt: { baseUrl: 'ftp://127.0.0.1:4001' } }],
  ['embedded userinfo in an endpoint', { collectorCrypt: { baseUrl: 'http://user:pass@127.0.0.1:4001' } }],
  ['a non-live signer protocol', { signer: { liveMode: false } }],
  ['a non-Keychain signer backend', { signer: { backend: 'external-module' } }],
  ['a command that does not match its authenticated isolated setup', { signer: { keychain: { command: '/tmp/some-other-path' } } }],
  ['a missing Keychain child command', { signer: { keychain: { command: undefined } } }],
  ['a missing isolated child setup', { signer: { keychain: { isolatedChildSetup: undefined } } }],
];

for (const [label, patch] of OFFLINE_BOUNDARY_REFUSALS) {
  test(`refuses the offline execution boundary given ${label}`, () => {
    const config = deepMerge(offlineConfig(), patch);
    assert.throws(() => assertCollectorOfflineExecutionBoundary(config), CollectorProductionBindingError);
  });
}

test('refuses an isolated child setup reconstructed as a lookalike object, even with matching fields', () => {
  const lookalike = { command: sharedSetup.command, evmAddress: sharedSetup.evmAddress, solanaPublicKey: sharedSetup.solanaPublicKey };
  const config = offlineConfig({ signer: { ...offlineConfig().signer, keychain: { ...offlineConfig().signer.keychain, isolatedChildSetup: lookalike } } });
  assert.throws(() => assertCollectorOfflineExecutionBoundary(config), CollectorProductionBindingError);
});

test('createIsolatedKeychainChildSetup mints a distinct authenticated setup on each call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-isolated-child-setup-second-'));
  cleanupFns.push(() => rm(directory, { recursive: true, force: true }));
  const second = await createIsolatedKeychainChildSetup({ directory });
  assert.notEqual(second.command, sharedSetup.command);
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(offlineConfig({
    signer: { ...offlineConfig().signer, keychain: { command: second.command, solanaAccount: 'operator-solana', isolatedChildSetup: second } },
  })));
});

test('accepts the offline execution boundary once every independent check holds together, including a configured Collector/Relay credential (harmless once every endpoint is loopback)', () => {
  const config = deepMerge(offlineConfig(), { collectorCrypt: { apiKey: 'anything' }, relay: { apiKey: 'anything' } });
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(config));
});

test('accepts the offline execution boundary once every independent check holds together', () => {
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(offlineConfig()));
});

test('createLoopbackConfinedFetch sends a loopback request through unchanged', async () => {
  const calls = [];
  const fakeFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('ok', { status: 200 });
  };
  const confined = createLoopbackConfinedFetch(fakeFetch);
  const response = await confined('http://127.0.0.1:4001/status');
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('createLoopbackConfinedFetch refuses a nonlocal request URL before ever calling the base fetch', async () => {
  const confined = createLoopbackConfinedFetch(async () => { throw new Error('base fetch must never be reached'); });
  await assert.rejects(() => confined('https://collector.example.com/status'), CollectorProductionBindingError);
});

test('createLoopbackConfinedFetch refuses a redirect response instead of letting a caller follow it', async () => {
  const fakeFetch = async () => new Response(null, { status: 302, headers: { location: 'https://collector.example.com/elsewhere' } });
  const confined = createLoopbackConfinedFetch(fakeFetch);
  await assert.rejects(() => confined('http://127.0.0.1:4001/status'), CollectorProductionBindingError);
});

test('a real loopback Robinhood/EVM RPC redirecting outward is refused by the confined viem http transport before its effect', async t => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: 'https://mainnet.example.com/rpc-took-over' });
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const client = createRobinhoodClient({ rpcUrl, transport: http(rpcUrl, { fetchFn: createLoopbackConfinedFetch() }) });
  await assert.rejects(() => readChainId(client), /refuses a transport redirect/);
});

test('the real constructed wrapper embeds only the fixed, allowlisted child environment -- no PATH inheritance, no caller environment', async () => {
  const content = await readFile(sharedSetup.command, 'utf8');
  const match = content.match(/env: (\{.*\})\s*\}\);/);
  assert.ok(match, 'wrapper source must embed a literal env object for the spawned child');
  const embeddedEnv = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(embeddedEnv).sort(), [
    'HOOKEMON_OPERATIONS_SECURITY_COMMAND',
    'HOOKEMON_TEST_KEYCHAIN_MODE',
    'HOOKEMON_TEST_KEYCHAIN_PATH',
    'HOOKEMON_TEST_KEYCHAIN_PID_PATH',
    'HOOKEMON_TEST_KEYCHAIN_RECORD_PATH',
    'HOOKEMON_TEST_KEYCHAIN_STORE_PATH',
    'PATH',
  ]);
  // PATH is fixed to the pinned interpreter's own directory, never this test process's own
  // inherited PATH (which would almost certainly differ and would typically list several
  // directories, not exactly one).
  assert.equal(embeddedEnv.PATH, dirname(process.execPath));
});

test('createIsolatedKeychainChildSetup refuses a symlinked isolated root before spawning any child, fast and with no side effect', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'hookemon-isolated-root-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const realDirectory = join(parent, 'real');
  await mkdir(realDirectory);
  const symlinkedDirectory = join(parent, 'symlinked');
  await symlink(realDirectory, symlinkedDirectory);

  const startedAtMs = Date.now();
  await assert.rejects(() => createIsolatedKeychainChildSetup({ directory: symlinkedDirectory }), CollectorProductionBindingError);
  // A real wallet-generate/wrapper-write round trip takes several hundred milliseconds (see the
  // real-child tests elsewhere in this file); refusing in a handful of milliseconds is strong
  // evidence the directory check ran and refused before any subprocess was ever spawned, not that
  // one merely failed for some unrelated reason.
  assert.ok(Date.now() - startedAtMs < 200, 'refusal must happen before any child process is spawned');
  assert.deepEqual(await readdir(realDirectory), [], 'no wrapper or store file must ever be written into a refused root');
});

for (const [envKey, label] of [
  ['HOOKEMON_TEST_KEYCHAIN_STORE_PATH', 'security-store.json'],
  ['HOOKEMON_TEST_KEYCHAIN_RECORD_PATH', 'security-records.jsonl'],
  ['HOOKEMON_TEST_KEYCHAIN_PID_PATH', 'security.pid'],
]) {
  test(`createIsolatedKeychainChildSetup refuses a symlinked ${label} path before spawning any wallet child`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'hookemon-isolated-root-symlinked-child-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // An external sentinel file outside `directory` entirely -- never a real Keychain/credential
    // target -- stands in for whatever a symlink at this fixed path might otherwise redirect a real
    // read or write to.
    const sentinelPath = join(await mkdtemp(join(tmpdir(), 'hookemon-external-sentinel-')), 'sentinel.txt');
    const sentinelContent = 'untouched-external-sentinel-content\n';
    await writeFile(sentinelPath, sentinelContent, 'utf8');
    t.after(() => rm(dirname(sentinelPath), { recursive: true, force: true }));
    const fixedPath = { HOOKEMON_TEST_KEYCHAIN_STORE_PATH: 'security-store.json', HOOKEMON_TEST_KEYCHAIN_RECORD_PATH: 'security-records.jsonl', HOOKEMON_TEST_KEYCHAIN_PID_PATH: 'security.pid' }[envKey];
    await symlink(sentinelPath, join(directory, fixedPath));

    const startedAtMs = Date.now();
    await assert.rejects(() => createIsolatedKeychainChildSetup({ directory }), CollectorProductionBindingError);
    // No wallet child (a real `wallet show`/`wallet generate` round trip takes hundreds of
    // milliseconds elsewhere in this file) is ever spawned once this refusal fires.
    assert.ok(Date.now() - startedAtMs < 200, 'refusal must happen before any wallet child process is spawned');
    assert.equal(await readFile(sentinelPath, 'utf8'), sentinelContent, 'the external sentinel target must never be read through or written to');
    assert.deepEqual(
      (await readdir(directory)).filter(name => name !== fixedPath),
      [],
      'no other fixed child path (store/record/pid/wrapper) may be created for a root refused this early',
    );
  });
}

test('createIsolatedKeychainChildSetup reopens an ordinary preexisting regular security store without refusing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-isolated-root-regular-reopen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createIsolatedKeychainChildSetup({ directory });
  // A genuine restart against the same root: the store/record/pid paths this setup itself created
  // are now ordinary regular files on disk, exactly what a real reopen looks like.
  const second = await createIsolatedKeychainChildSetup({ directory });
  assert.equal(second.evmAddress, first.evmAddress);
  assert.equal(second.solanaPublicKey, first.solanaPublicKey);
});

test('assertCollectorOfflineExecutionBoundary refuses an isolated child wrapper that was modified after construction', async () => {
  const config = offlineConfig();
  const originalContent = await readFile(sharedSetup.command, 'utf8');
  // The wrapper is written read-only (0o500); a real tamper attempt against a file the process
  // still owns would chmod it writable first, exactly like this.
  await chmod(sharedSetup.command, 0o700);
  await writeFile(sharedSetup.command, `${originalContent}\n// tampered\n`);
  try {
    assert.throws(() => assertCollectorOfflineExecutionBoundary(config), /no longer matches its authenticated content/);
  } finally {
    // Rebuild a fresh, authentic setup at the same isolated root rather than trying to reverse the
    // edit above -- simplest and guaranteed correct for every later test in this file that reuses
    // `sharedSetup`.
    sharedSetup = await createIsolatedKeychainChildSetup({ directory: dirname(sharedSetup.command) });
  }
});
