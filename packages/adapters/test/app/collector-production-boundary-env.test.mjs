// Exercises the real ordinary-CLI path this task's followthrough review found missing: an actual
// `HOOKEMON_*` environment -> `readEnvironment` -> `compose` pipeline that resolves a Collector
// production binding registry from a real file, through the same digest/schema validation
// `compose.mjs` applies to any other registry source, against the real Keychain child and isolated
// `security` fixture files this repository already ships. Network-identity probing and provider
// adapters are injected (the same seam `compose.test.mjs` already uses throughout) because standing
// up real loopback Collector/Solana/Relay/Robinhood servers is the literal full-flow CLI test the
// N2 worker owns; this test proves the config plumbing feeding that graph, not the graph itself.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import { readEnvironment } from '../../src/app/environment.mjs';
import { compose } from '../../src/app/compose.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { COLLECTOR_PURCHASE_BINDING_SCHEMA } from '../../src/signing/collector-purchase-policy.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA } from '../../src/signing/collector-buyback-policy.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE,
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
  COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
  COLLECTOR_SYNTHETIC_API_KEY,
  RELAY_SYNTHETIC_API_KEY,
  assertCollectorOfflineExecutionBoundary,
  createIsolatedKeychainChildSetup,
  loadCollectorProductionBindingRegistry,
  resolveCollectorProductionBinding,
} from '../../src/signing/collector-production-binding.mjs';
import { createKeychainSignerClient } from '../../src/signing/keychain-signer.mjs';
import { OPERATOR_SOLANA_ROLE } from '../../src/signing/signer-client.mjs';
import { createProcessExec } from '../../src/signing/keychain-process-exec.mjs';
import { decodeProviderTransaction } from '../../src/signing/transaction-policy.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { applySyntheticIsolatedChildSetup } from '../../bin/hookemon-runner.mjs';

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COLLECTOR_PROGRAM_ID = Keypair.generate().publicKey.toBase58();

// A real isolated child setup, built once for this whole file: a real ephemeral keypair generated
// through the real `bin/hookemon-wallet.mjs generate` CLI against this module's own fixed,
// reviewed fake `security` fixture, and a real wrapper spawning the real
// `bin/hookemon-keychain-signer.mjs` -- never a hand-built lookalike object. Reused as-is by every
// test below (`config.signer.keychain.command`/`isolatedChildSetup` always trace back to this one
// setup), exactly mirroring how an ordinary CLI launch would build and reuse a single setup for its
// process lifetime.
const cleanupFns = [];
let sharedSetup;
let sharedSyntheticRoot;
before(async () => {
  sharedSyntheticRoot = await mkdtemp(join(tmpdir(), 'hookemon-collector-boundary-child-'));
  cleanupFns.push(() => rm(sharedSyntheticRoot, { recursive: true, force: true }));
  sharedSetup = await createIsolatedKeychainChildSetup({ directory: sharedSyntheticRoot });
});
after(async () => {
  for (const fn of cleanupFns.splice(0).reverse()) await fn();
});

function purchaseBinding() {
  return {
    schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
    version: 1,
    provider: 'collector-crypt',
    chainId: 'solana-mainnet',
    format: 'legacy',
    addressLookupTables: [],
    settlement: { destination: Keypair.generate().publicKey.toBase58(), mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
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
  };
}

function buybackBinding() {
  return {
    schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
    version: 1,
    provider: 'collector-crypt',
    chainId: 'solana-mainnet',
    format: 'legacy',
    addressLookupTables: [],
    proceeds: { source: Keypair.generate().publicKey.toBase58(), mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
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
  };
}

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

function offlineRegistry() {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
    version: 1,
    entries: [
      registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: purchaseBinding() }),
      registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', binding: buybackBinding() }),
    ],
  };
}

async function withRegistryFile(t, registry) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-collector-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'registry.json');
  await writeFile(path, JSON.stringify(registry), 'utf8');
  return path;
}

/**
 * A real, complete `HOOKEMON_*` production environment, with every endpoint pinned to loopback and
 * the two Keychain-related paths pinned to this repository's real, reviewed files -- exactly what
 * an isolated offline evidence CLI run must set. Every other field matches an ordinary production
 * launch (`environment-production-profile.test.mjs`'s own `completeProductionEnvironment`).
 */
function isolatedProductionEnvironment(stateDir, { registryPath, overrides = {} } = {}) {
  return {
    HOOKEMON_STATE_DIR: stateDir,
    HOOKEMON_CHAIN_ID: '4663',
    HOOKEMON_ROBINHOOD_RPC_URL: 'https://127.0.0.1:4101',
    HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: 'https://127.0.0.1:4102',
    HOOKEMON_SOLANA_RPC_URL: 'https://127.0.0.1:4103',
    HOOKEMON_RELAY_BASE_URL: 'https://127.0.0.1:4104',
    HOOKEMON_RELAY_API_KEY: RELAY_SYNTHETIC_API_KEY,
    HOOKEMON_RELAY_SOLANA_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    HOOKEMON_RELAY_SOLANA_DECIMALS: '6',
    HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: 'https://127.0.0.1:4105',
    HOOKEMON_COLLECTOR_CRYPT_API_KEY: COLLECTOR_SYNTHETIC_API_KEY,
    HOOKEMON_EVM_ACCOUNT: sharedSetup.evmAddress,
    HOOKEMON_SOLANA_ACCOUNT: sharedSetup.solanaPublicKey,
    HOOKEMON_VAULT_ADDRESS: `0x${'c'.repeat(40)}`,
    HOOKEMON_HOOK_ADDRESS: `0x${'d'.repeat(40)}`,
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'true',
    HOOKEMON_KEYCHAIN_COMMAND: sharedSetup.command,
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_PROVIDER_MODE: 'live',
    HOOKEMON_PACK_CODE: 'collector-25',
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_MIN_SOLANA_RECEIVE: '0',
    HOOKEMON_MIN_RETURN_USDG: '0',
    HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0',
    HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0',
    HOOKEMON_EVM_GAS_PRICE_CAP: '2000000000',
    HOOKEMON_EVM_NATIVE_RESERVE: '3000000000000000',
    HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '25000',
    HOOKEMON_SOLANA_LAMPORT_RESERVE: '5000000',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '0',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '0',
    HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0',
    HOOKEMON_BUDGET_RETURN_CAP_USDG: '0',
    HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0',
    HOOKEMON_COLLECTOR_PRODUCTION_BINDING_AUTHORITY: 'synthetic-offline',
    HOOKEMON_COLLECTOR_SYNTHETIC_ROOT: sharedSyntheticRoot,
    ...(registryPath === undefined ? {} : { HOOKEMON_COLLECTOR_PRODUCTION_BINDING_REGISTRY_PATH: registryPath }),
    ...overrides,
  };
}

function minimalInjectedAdapters() {
  return { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } };
}

function networkIdentity() {
  return {
    async readEvmChainId() { return 4663; },
    async readSolanaGenesisHash() { return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; },
  };
}

async function tempStateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-collector-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Builds a real, complete production `readEnvironment()` config: a fresh state directory, the
 * two required JSON config files, and the registry file, all real files on disk -- not injected
 * objects. */
async function readIsolatedEnvironment(t, { registry = offlineRegistry(), overrides = {} } = {}) {
  const stateDir = await tempStateDir(t);
  const registryPath = await withRegistryFile(t, registry);
  const observabilityPath = join(stateDir, 'observability.json');
  const eligibilitySnapshotPath = join(stateDir, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(eligibilitySnapshotPath, '{}\n', 'utf8');
  const envConfig = readEnvironment(isolatedProductionEnvironment(stateDir, {
    registryPath,
    overrides: {
      HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
      HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath,
      ...overrides,
    },
  }), { profile: 'production' });
  // The real exported runner entrypoint constructs and overlays the isolated child setup itself --
  // never a manual test overlay. `HOOKEMON_COLLECTOR_SYNTHETIC_ROOT` above already points at this
  // file's own `sharedSyntheticRoot`, so this reopens the exact same on-disk identity/wrapper
  // `sharedSetup` already established, through a freshly minted (but equally authenticated) setup
  // object every time this helper runs.
  const config = await applySyntheticIsolatedChildSetup(envConfig);
  return { config, stateDir };
}

const ENVIRONMENT_MODULE_PATH = fileURLToPath(new URL('../../src/app/environment.mjs', import.meta.url));
const RUNNER_MODULE_PATH = fileURLToPath(new URL('../../bin/hookemon-runner.mjs', import.meta.url));

/** A tiny real script file (never an inline `-e` string) that drives exactly the ordinary CLI's
 * own construction path -- `readEnvironment` then the real exported `applySyntheticIsolatedChildSetup`
 * -- and prints the resulting Keychain command and both ephemeral identities. Run as two genuinely
 * separate `node` processes against the same `HOOKEMON_COLLECTOR_SYNTHETIC_ROOT`, this is the literal
 * "separate process reopen" proof a single test process calling the function twice cannot give. */
async function writeRunnerSetupProbeScript(t, stateDir) {
  const scriptPath = join(stateDir, 'probe-runner-setup.mjs');
  const source = [
    `import { readEnvironment } from ${JSON.stringify(ENVIRONMENT_MODULE_PATH)};`,
    `import { applySyntheticIsolatedChildSetup } from ${JSON.stringify(RUNNER_MODULE_PATH)};`,
    "const resolved = await applySyntheticIsolatedChildSetup(readEnvironment(process.env, { profile: 'production' }));",
    'process.stdout.write(JSON.stringify({',
    '  command: resolved.signer.keychain.command,',
    '  evmAddress: resolved.signer.keychain.isolatedChildSetup.evmAddress,',
    '  solanaPublicKey: resolved.signer.keychain.isolatedChildSetup.solanaPublicKey,',
    '}));',
    '',
  ].join('\n');
  await writeFile(scriptPath, source, 'utf8');
  t.after(() => rm(scriptPath, { force: true }));
  return scriptPath;
}

function runSetupProbeScript(scriptPath, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`probe script failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

// Mirrors exactly the one execution field `bin/hookemon-runner.mjs`'s own `compositionInput()`
// adds on top of `readEnvironment()`'s output before calling `compose()` (`enforceProfile: true`);
// every other field compose() reads comes straight from the real env-sourced config.
function composeReadyConfig(config, extra) {
  return { ...config, execution: { ...config.execution, enforceProfile: true }, ...extra };
}

async function composeIsolated(t, envOverrides = {}, registry = offlineRegistry()) {
  const { config, stateDir } = await readIsolatedEnvironment(t, { registry, overrides: envOverrides });
  return compose(composeReadyConfig(config, {
    statePath: join(stateDir, 'operator-state.json'),
    adapters: minimalInjectedAdapters(),
    networkIdentity: networkIdentity(),
  }));
}

test('readEnvironment reads the registry file into typed config, and compose validates it end to end without throwing', async t => {
  const { config } = await readIsolatedEnvironment(t);
  assert.equal(config.collectorCrypt.productionBindingAuthority, 'synthetic-offline');
  assert.equal(config.signer.keychain.command, sharedSetup.command);
  // Not yet validated: readEnvironment only parses JSON, exactly like its other JSON config
  // readers -- compose.mjs still runs the full schema/digest check on this exact raw object.
  assert.equal(Array.isArray(config.collectorProductionBindingRegistry.entries), true);

  // compose() does not expose its internal resolved config (its return value is the composed
  // service graph, not a config projection), so a successful, non-throwing compose() call is
  // itself the proof that compose.mjs's own `loadCollectorProductionBindingRegistry` call on this
  // exact env-sourced object succeeded, using the real production graph -- not a bypassed unit
  // call. The following tests use `config` directly (identical to what compose.mjs validates
  // internally) to inspect the specific resolved binding/boundary outcomes compose()'s return
  // value cannot expose.
  await composeIsolated(t);
});

test('the real env-sourced registry resolves through the real offline boundary for both purchase and buyback', async t => {
  const { config } = await readIsolatedEnvironment(t);
  const registry = loadCollectorProductionBindingRegistry(config.collectorProductionBindingRegistry);
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(config));
  const purchase = resolveCollectorProductionBinding({
    registry, authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', config,
  });
  assert.equal(purchase.binding.schema, COLLECTOR_PURCHASE_BINDING_SCHEMA);
  const buyback = resolveCollectorProductionBinding({
    registry, authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', config,
  });
  assert.equal(buyback.binding.schema, COLLECTOR_BUYBACK_BINDING_SCHEMA);
});

test('compose refuses an env-sourced registry entry declaring live authority', async t => {
  const registry = offlineRegistry();
  registry.entries.push(registryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_LIVE, stage: 'purchase', binding: purchaseBinding() }));
  await assert.rejects(() => composeIsolated(t, {}, registry), /live/);
});

test('compose refuses an env-sourced registry entry whose digest does not match its own binding bytes', async t => {
  const registry = offlineRegistry();
  registry.entries[0].expectedDigest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(() => composeIsolated(t, {}, registry), /digest does not match/);
});

test('the offline boundary refuses a nonlocal Collector endpoint from the real env-sourced config', async t => {
  const { config } = await readIsolatedEnvironment(t, { overrides: { HOOKEMON_COLLECTOR_CRYPT_BASE_URL: 'https://collector.example.com' } });
  assert.throws(() => assertCollectorOfflineExecutionBoundary(config), /nonlocal endpoint/);
});

test('the offline boundary refuses a Keychain command that does not match the authenticated isolated setup, from the real env-sourced config', async t => {
  // The real runner overlay (`applySyntheticIsolatedChildSetup`) always fixes
  // `config.signer.keychain.command` to its own constructed setup's own `command`, so an
  // `HOOKEMON_KEYCHAIN_COMMAND` override can no longer survive into the final config the way it
  // could when this test scaffolding manually overlaid only `isolatedChildSetup`. Corrupting the
  // already-overlaid config afterward instead proves `assertCollectorOfflineExecutionBoundary`
  // itself still refuses this mismatch, regardless of how a config came to carry it.
  const { config } = await readIsolatedEnvironment(t);
  const corrupted = { ...config, signer: { ...config.signer, keychain: { ...config.signer.keychain, command: '/tmp/some-other-path' } } };
  assert.throws(() => assertCollectorOfflineExecutionBoundary(corrupted), /does not match its authenticated isolated setup/);
});

test('a valid synthetic signing request succeeds through the real owned child, launched via the real env-sourced Keychain command', async t => {
  const { config } = await readIsolatedEnvironment(t);
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(config));

  const feePayer = new PublicKey(config.accounts.solana);
  const transaction = new Transaction({
    feePayer,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: feePayer, lamports: 0 }));
  const transactionBase64 = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  await decodeProviderTransaction({
    family: 'solana',
    chainId: 'solana-test',
    transaction: transactionBase64,
    lastValidBlockHeight: '100',
    currentBlockHeight: '99',
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
  });

  const client = createKeychainSignerClient({
    role: OPERATOR_SOLANA_ROLE,
    liveMode: true,
    preflightAuthority: createTestProfileMutationAuthority(),
    exec: createProcessExec(),
    command: config.signer.keychain.command,
    account: config.signer.keychain.solanaAccount,
  });
  // The real owned child, launched exactly through the config this ordinary env carrier produced:
  // a non-broadcast readiness round-trip against the isolated fake `security` store the ephemeral
  // `operator-solana` identity was actually generated into.
  assert.deepEqual(await client.probe(), { ready: true });

  const signed = await client.sign(transactionBase64);
  assert.equal(typeof signed.signedTxBase64, 'string');
  const signedTransaction = Transaction.from(Buffer.from(signed.signedTxBase64, 'base64'));
  assert.equal(signedTransaction.verifySignatures(), true);
});

test('two genuinely separate Node processes reopen the same fixture directory and identities through the real applySyntheticIsolatedChildSetup, with no manual setup overlay', async t => {
  const stateDir = await tempStateDir(t);
  const registryPath = await withRegistryFile(t, offlineRegistry());
  const observabilityPath = join(stateDir, 'observability.json');
  const eligibilitySnapshotPath = join(stateDir, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(eligibilitySnapshotPath, '{}\n', 'utf8');
  const env = isolatedProductionEnvironment(stateDir, {
    registryPath,
    overrides: {
      HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
      HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath,
    },
  });
  const scriptPath = await writeRunnerSetupProbeScript(t, stateDir);

  // Two separate `node <script>` invocations, not one process calling the function twice --
  // exactly the "restart" this task's own review found unproved.
  const first = await runSetupProbeScript(scriptPath, env);
  const second = await runSetupProbeScript(scriptPath, env);
  assert.equal(second.command, first.command, 'a second, genuinely separate process must reopen the identical wrapper path');
  assert.equal(second.evmAddress, first.evmAddress, 'a second, genuinely separate process must reopen the identical EVM identity, never mint a replacement');
  assert.equal(second.solanaPublicKey, first.solanaPublicKey, 'a second, genuinely separate process must reopen the identical Solana identity, never mint a replacement');
  assert.equal(first.command, sharedSetup.command, 'this reopens the exact same on-disk wrapper this file\'s own shared setup already established');
});

test('readEnvironment refuses HOOKEMON_COLLECTOR_PRODUCTION_BINDING_AUTHORITY set to anything but synthetic-offline', async t => {
  const stateDir = await tempStateDir(t);
  assert.throws(
    () => readEnvironment(isolatedProductionEnvironment(stateDir, { registryPath: '/tmp/unused.json', overrides: { HOOKEMON_COLLECTOR_PRODUCTION_BINDING_AUTHORITY: 'live' } }), { profile: 'production' }),
    /no live authority is ever accepted here/,
  );
});

test('readEnvironment refuses a real Collector API credential file selector before ever touching the filesystem', async t => {
  const stateDir = await tempStateDir(t);
  // A path to a file that does not exist: if the refusal happened after a filesystem read was
  // attempted, the failure here would instead be a file-not-found error from
  // readPrivateCredentialFile, not this module's own early sentinel-authority message.
  const nonexistentCredentialPath = join(stateDir, 'this-file-does-not-exist.key');
  assert.throws(
    () => readEnvironment(isolatedProductionEnvironment(stateDir, {
      overrides: { HOOKEMON_COLLECTOR_CRYPT_API_KEY_PATH: nonexistentCredentialPath },
    }), { profile: 'production' }),
    /synthetic-offline authority refuses a real Collector API credential file selector/,
  );
});

test('readEnvironment requires the fixed synthetic Collector API credential value', async t => {
  const stateDir = await tempStateDir(t);
  assert.throws(
    () => readEnvironment(isolatedProductionEnvironment(stateDir, {
      overrides: { HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'some-other-value-even-if-it-looks-like-a-real-key' },
    }), { profile: 'production' }),
    /synthetic-offline authority requires the fixed synthetic Collector API credential value/,
  );
});

test('readEnvironment requires the fixed synthetic Relay API credential value', async t => {
  const stateDir = await tempStateDir(t);
  assert.throws(
    () => readEnvironment(isolatedProductionEnvironment(stateDir, {
      overrides: { HOOKEMON_RELAY_API_KEY: 'some-other-value-even-if-it-looks-like-a-real-key' },
    }), { profile: 'production' }),
    /synthetic-offline authority requires the fixed synthetic Relay API credential value/,
  );
});
