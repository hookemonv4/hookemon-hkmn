import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  readEnvironment,
  loadSignerClient,
  loadOperatorSignerClient,
  probeKeychainOperations,
  loadStandingAuthority,
  EnvironmentConfigurationError,
} from '../../src/app/environment.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';

const fixtureSignerOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function baseEnv(overrides = {}) {
  return { HOOKEMON_STATE_DIR: '/tmp/hookemon-state', ...overrides };
}

async function productionEnv(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-env-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  return baseEnv({
    HOOKEMON_STATE_DIR: directory,
    HOOKEMON_CHAIN_ID: '4663',
    HOOKEMON_ROBINHOOD_RPC_URL: 'https://public-rpc.example.test',
    HOOKEMON_SOLANA_RPC_URL: 'https://solana-rpc.example.test',
    HOOKEMON_RELAY_BASE_URL: 'https://relay.example.test',
    HOOKEMON_RELAY_API_KEY: 'relay-api-key',
    HOOKEMON_RELAY_SOLANA_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    HOOKEMON_RELAY_SOLANA_DECIMALS: '6',
    HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'d'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: 'https://collector.example.test',
    HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'collector-api-key',
    HOOKEMON_VAULT_ADDRESS: `0x${'a'.repeat(40)}`,
    HOOKEMON_HOOK_ADDRESS: `0x${'b'.repeat(40)}`,
    HOOKEMON_EVM_ACCOUNT: `0x${'c'.repeat(40)}`,
    HOOKEMON_SOLANA_ACCOUNT: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t',
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'true',
    HOOKEMON_KEYCHAIN_COMMAND: '/tmp/hookemon-keychain-signer',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_PACK_CODE: 'collector-25',
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_MIN_SOLANA_RECEIVE: '0',
    HOOKEMON_MIN_RETURN_USDG: '0',
    HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '2',
    HOOKEMON_NATIVE_GAS_CAP_SOLANA: '2',
    HOOKEMON_EVM_GAS_PRICE_CAP: '2',
    HOOKEMON_EVM_NATIVE_RESERVE: '2',
    HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2',
    HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '0',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '0',
    HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0',
    HOOKEMON_BUDGET_RETURN_CAP_USDG: '0',
    HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0',
    HOOKEMON_PROVIDER_MODE: 'live',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
    ...overrides,
  });
}

test('readEnvironment requires HOOKEMON_STATE_DIR to be set and absolute', () => {
  assert.throws(() => readEnvironment({}), EnvironmentConfigurationError);
  assert.throws(() => readEnvironment({ HOOKEMON_STATE_DIR: 'relative/path' }), /absolute path/);
});

test('readEnvironment rejects an unknown HOOKEMON_* variable', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_TOTALLY_MADE_UP: 'x' })), /unknown HOOKEMON_\* environment variable/);
});

test('readEnvironment applies documented defaults when nothing else is set', async () => {
  const config = readEnvironment(baseEnv());
  const binding = JSON.parse(await readFile(new URL('../../../../bindings/robinhood-chain.json', import.meta.url), 'utf8'));
  assert.equal(config.robinhood.rpcUrl, 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(config.solana.rpcUrl, 'https://api.mainnet-beta.solana.com');
  assert.equal(config.relay.baseUrl, 'https://api.relay.link');
  assert.equal(config.relay.solanaMint, null);
  assert.equal(config.relay.evmDepository, null);
  assert.equal(config.collectorCrypt.baseUrl, 'https://gacha.collectorcrypt.com');
  assert.equal(config.leaseTtlMs, 90_000);
  assert.equal(config.chainId, 4663);
  assert.equal(config.contracts.vault, null);
  assert.equal(config.contracts.hook, null);
  assert.equal(config.contracts.usdg, binding.contracts.usdg.address.toLowerCase());
  assert.equal(config.contracts.usdgDecimals, binding.contracts.usdg.metadata.decimals);
  assert.equal(config.budget.availableProcessUsdg, '0');
  assert.equal(config.budget.packPriceUsdg, '0');
  assert.equal(config.signerModulePath, null);
  assert.equal(config.rehearsal, null);
});

test('readEnvironment requires a distinct archive RPC in production and retains the validated URL', async t => {
  const env = await productionEnv(t);
  assert.throws(
    () => readEnvironment(env, { profile: 'production' }),
    /HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL is required/,
  );

  const archiveRpcUrl = 'https://archive-rpc.example.test';
  const configured = readEnvironment({ ...env, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: archiveRpcUrl }, { profile: 'production' });
  assert.equal(configured.robinhood.archiveRpcUrl, archiveRpcUrl);

  assert.throws(
    () => readEnvironment({ ...env, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: env.HOOKEMON_ROBINHOOD_RPC_URL }, { profile: 'production' }),
    /must be distinct from HOOKEMON_ROBINHOOD_RPC_URL/,
  );
  assert.throws(
    () => readEnvironment({ ...env, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive-rpc.example.test' }, { profile: 'production' }),
    /https:\/\/ URL/,
  );
});

test('readEnvironment permits fake providers only for an explicit production dry run', async t => {
  const env = await productionEnv(t, {
    HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: 'https://archive-rpc.example.test',
    HOOKEMON_PROVIDER_MODE: 'fake',
  });
  assert.throws(() => readEnvironment(env, { profile: 'production' }), /HOOKEMON_PROVIDER_MODE=live/);

  const configured = readEnvironment(env, { profile: 'production', dryRun: true });
  assert.deepEqual(configured.execution, {
    profile: 'production',
    networkProfile: 'mainnet',
    providerMode: 'fake',
    dryRun: true,
  });
  assert.throws(
    () => readEnvironment({ ...env, HOOKEMON_PROVIDER_MODE: 'live' }, { profile: 'production', dryRun: true }),
    /dryRun requires HOOKEMON_PROVIDER_MODE=fake/,
  );
});


test('readEnvironment accepts an explicit Relay Solana settlement mint and rejects a malformed value', () => {
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const config = readEnvironment(baseEnv({ HOOKEMON_RELAY_SOLANA_MINT: mint }));
  assert.equal(config.relay.solanaMint, mint);
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_RELAY_SOLANA_MINT: 'not-a-solana-address' })),
    /base58 Solana address/,
  );
});

test('readEnvironment accepts an explicit Relay EVM depository allowlist address', () => {
  const depository = `0x${'d'.repeat(40)}`;
  const config = readEnvironment(baseEnv({ HOOKEMON_RELAY_EVM_DEPOSITORY: depository }));
  assert.equal(config.relay.evmDepository, depository);
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_RELAY_EVM_DEPOSITORY: 'not-an-address' })),
    /20-byte EVM address/,
  );
});

test('readEnvironment accepts the collector-only rehearsal configuration', () => {
  const operator = '11111111111111111111111111111111';
  const recipients = ['22222222222222222222222222222222', '33333333333333333333333333333333'];
  const config = readEnvironment(baseEnv({
    HOOKEMON_SOLANA_ACCOUNT: operator,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: recipients.join(', '),
  }));
  assert.deepEqual(config.rehearsal, {
    mode: 'collector-only',
    payoutRecipients: recipients,
    split: 'equal',
  });
  assert.equal(Object.isFrozen(config.rehearsal), true);
  assert.equal(Object.isFrozen(config.rehearsal.payoutRecipients), true);
});

test('readEnvironment rejects malformed rehearsal configuration', () => {
  const operator = '11111111111111111111111111111111';
  const recipient = '22222222222222222222222222222222';
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_REHEARSAL_MODE: 'live' })), /must be "collector-only"/);
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_REHEARSAL_MODE: 'collector-only', HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: recipient })), /HOOKEMON_SOLANA_ACCOUNT is required/);
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_SOLANA_ACCOUNT: operator, HOOKEMON_REHEARSAL_MODE: 'collector-only' })), /PAYOUT_RECIPIENTS is required/);
  assert.throws(() => readEnvironment(baseEnv({
    HOOKEMON_SOLANA_ACCOUNT: operator,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: `${recipient},${recipient}`,
  })), /distinct addresses/);
  assert.throws(() => readEnvironment(baseEnv({
    HOOKEMON_SOLANA_ACCOUNT: operator,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: `${operator}`,
  })), /must not include HOOKEMON_SOLANA_ACCOUNT/);
  assert.throws(() => readEnvironment(baseEnv({
    HOOKEMON_SOLANA_ACCOUNT: operator,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: 'not-a-solana-address',
  })), /base58 Solana address/);
  assert.throws(() => readEnvironment(baseEnv({
    HOOKEMON_SOLANA_ACCOUNT: operator,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: recipient,
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'weighted',
  })), /must be "equal"/);
});

test('readEnvironment rejects a non-https URL override', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_RELAY_BASE_URL: 'http://insecure.example' })), /https:\/\/ URL/);
});

test('readEnvironment rejects a malformed EVM address', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_VAULT_ADDRESS: 'not-an-address' })), /0x-prefixed 20-byte EVM address/);
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_VAULT_ADDRESS: `0x${'1'.repeat(39)}` })), /0x-prefixed 20-byte EVM address/);
});

test('readEnvironment accepts a well-formed EVM vault/hook address', () => {
  const config = readEnvironment(baseEnv({ HOOKEMON_VAULT_ADDRESS: `0x${'a'.repeat(40)}`, HOOKEMON_HOOK_ADDRESS: `0x${'b'.repeat(40)}` }));
  assert.equal(config.contracts.vault, `0x${'a'.repeat(40)}`);
  assert.equal(config.contracts.hook, `0x${'b'.repeat(40)}`);
});

test('readEnvironment accepts lowercase pack codes containing underscores and rejects spaced names', () => {
  const config = readEnvironment(baseEnv({ HOOKEMON_PACK_CODE: 'pokemon_50' }));
  assert.equal(config.pack.code, 'pokemon_50');
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_PACK_CODE: 'Pokemon 50' })), /lowercase pack code/);
});

// --- WP-37: holder-exclusion-set configuration -------------------------------------------------

test('readEnvironment defaults contracts.treasury/contracts.pool to null and distribution.excludedHolderAddresses to []', () => {
  const config = readEnvironment(baseEnv());
  assert.equal(config.contracts.treasury, null);
  assert.equal(config.contracts.pool, null);
  assert.deepEqual(config.distribution.excludedHolderAddresses, []);
});

test('readEnvironment accepts well-formed HOOKEMON_TREASURY_ADDRESS/HOOKEMON_POOL_ADDRESS', () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_TREASURY_ADDRESS: `0x${'7'.repeat(40)}`,
    HOOKEMON_POOL_ADDRESS: `0x${'8'.repeat(40)}`,
  }));
  assert.equal(config.contracts.treasury, `0x${'7'.repeat(40)}`);
  assert.equal(config.contracts.pool, `0x${'8'.repeat(40)}`);
});

test('readEnvironment rejects a malformed HOOKEMON_TREASURY_ADDRESS/HOOKEMON_POOL_ADDRESS', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_TREASURY_ADDRESS: 'not-an-address' })), /0x-prefixed 20-byte EVM address/);
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_POOL_ADDRESS: `0x${'1'.repeat(39)}` })), /0x-prefixed 20-byte EVM address/);
});

test('readEnvironment parses HOOKEMON_EXCLUDED_HOLDER_ADDRESSES as a sorted, de-duplicated, lower-cased array, tolerating surrounding whitespace', () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_EXCLUDED_HOLDER_ADDRESSES: ` 0x${'B'.repeat(40)} , 0x${'a'.repeat(40)},0x${'a'.repeat(40)}`,
  }));
  assert.deepEqual(config.distribution.excludedHolderAddresses, [`0x${'a'.repeat(40)}`, `0x${'b'.repeat(40)}`]);
});

test('readEnvironment refuses a malformed entry anywhere in HOOKEMON_EXCLUDED_HOLDER_ADDRESSES, at construction time', () => {
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_EXCLUDED_HOLDER_ADDRESSES: `0x${'a'.repeat(40)},not-an-address` })),
    /HOOKEMON_EXCLUDED_HOLDER_ADDRESSES contains a malformed entry/,
  );
  // A trailing comma (or any other empty entry) is refused rather than silently dropped.
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_EXCLUDED_HOLDER_ADDRESSES: `0x${'a'.repeat(40)},` })),
    /HOOKEMON_EXCLUDED_HOLDER_ADDRESSES contains a malformed entry/,
  );
});

test('readEnvironment refuses a value that looks like raw key material, even in a non-secret field', () => {
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_WORKER_OWNER: '1'.repeat(64) })),
    /looks like raw key material/,
  );
});

test('readEnvironment rejects a non-canonical budget amount', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '01' })), /canonical unsigned decimal string/);
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '-5' })), /canonical unsigned decimal string/);
});

test('readEnvironment rejects a relative HOOKEMON_SIGNER_MODULE path', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_SIGNER_MODULE: 'relative/signer.mjs' })), /absolute path/);
});

test('loadSignerClient returns null when no module path is configured', async () => {
  assert.equal(await loadSignerClient(null), null);
});

async function tempSignerModule(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-signer-module-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'signer.mjs');
  await writeFile(path, contents, 'utf8');
  return path;
}

test('loadSignerClient dynamically imports an operator-supplied module exporting createSignerClient()', async t => {
  const path = await tempSignerModule(t, `
    export function createSignerClient() {
      return { evm: { async sign() { return { signedTx: '0xdeadbeef' }; } }, solana: null };
    }
  `);
  const signerClient = await loadSignerClient(path);
  assert.equal(typeof signerClient.evm.sign, 'function');
  assert.equal(signerClient.solana, null);
});

test('loadSignerClient accepts a default-export factory too', async t => {
  const path = await tempSignerModule(t, `
    export default function createSigner() { return { evm: null, solana: null }; }
  `);
  const signerClient = await loadSignerClient(path);
  assert.deepEqual(signerClient, { evm: null, solana: null });
});

test('loadSignerClient rejects a module with no usable factory export', async t => {
  const path = await tempSignerModule(t, `export const notAFactory = 42;`);
  await assert.rejects(() => loadSignerClient(path), /must export createSignerClient/);
});

// --- WP-33 additions: the signer/authority subsystem's environment wiring ------------------------

test('readEnvironment defaults the new WP-33 fields to their safe, backward-compatible values', () => {
  const config = readEnvironment(baseEnv());
  assert.equal(config.signer.backend, 'external-module');
  assert.equal(config.signer.liveMode, false);
  assert.equal(config.signer.keychain.command, null);
  assert.equal(config.standingAuthority.documentPath, null);
  assert.equal(config.standingAuthority.ownerPublicKeyPath, null);
  assert.equal(config.standingAuthority.policyPublicKeyPath, null);
});

test('readEnvironment defaults the new WP-36 distribution fields (HKMN never guessed, distribution directory unset)', () => {
  const config = readEnvironment(baseEnv());
  assert.equal(config.hkmn.address, null);
  assert.equal(config.hkmn.deployBlock, 0n);
  assert.equal(config.distribution.dir, null);
});

test('readEnvironment accepts HOOKEMON_HKMN_ADDRESS/HOOKEMON_HKMN_DEPLOY_BLOCK/HOOKEMON_DISTRIBUTION_DIR', () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_HKMN_ADDRESS: `0x${'7'.repeat(40)}`,
    HOOKEMON_HKMN_DEPLOY_BLOCK: '12345',
    HOOKEMON_DISTRIBUTION_DIR: '/var/hookemon/distribution',
  }));
  assert.equal(config.hkmn.address, `0x${'7'.repeat(40)}`);
  assert.equal(config.hkmn.deployBlock, 12345n);
  assert.equal(config.distribution.dir, '/var/hookemon/distribution');
});

test('readEnvironment rejects a relative HOOKEMON_DISTRIBUTION_DIR', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_DISTRIBUTION_DIR: 'relative/path' })), /absolute path/);
});

// --- WP-39: operations-trigger identity + production distribution profile ----------------------

test('readEnvironment exposes only the two Operations identities and defaults the distribution profile to "fixture"', () => {
  const config = readEnvironment(baseEnv());
  assert.deepEqual(Object.keys(config.accounts).sort(), ['evm', 'solana']);
  assert.equal(config.distribution.profile, 'fixture');
  assert.equal(config.distribution.signerAddress, null);
  assert.equal(config.distribution.verifierAddress, null);
});

test('readEnvironment rejects a third Operations EVM account', () => {
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_OPERATIONS_TRIGGER_ACCOUNT: `0x${'2'.repeat(40)}` })),
    /not supported; use HOOKEMON_EVM_ACCOUNT/,
  );
});

test('readEnvironment rejects an unrecognized HOOKEMON_DISTRIBUTION_PROFILE', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_DISTRIBUTION_PROFILE: 'not-a-profile' })), /"fixture" or "production"/);
});

test('readEnvironment requires both distribution-signer/verifier addresses when the profile is "production"', () => {
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_DISTRIBUTION_PROFILE: 'production' })),
    /both required when HOOKEMON_DISTRIBUTION_PROFILE is "production"/,
  );
  assert.throws(
    () => readEnvironment(baseEnv({
      HOOKEMON_DISTRIBUTION_PROFILE: 'production',
      HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS: `0x${'4'.repeat(40)}`,
    })),
    /both required when HOOKEMON_DISTRIBUTION_PROFILE is "production"/,
  );
});

test('readEnvironment accepts a complete production distribution profile with distinct signer/verifier addresses', () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_DISTRIBUTION_PROFILE: 'production',
    HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS: `0x${'4'.repeat(40)}`,
    HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS: `0x${'5'.repeat(40)}`,
  }));
  assert.equal(config.distribution.profile, 'production');
  assert.equal(config.distribution.signerAddress, `0x${'4'.repeat(40)}`);
  assert.equal(config.distribution.verifierAddress, `0x${'5'.repeat(40)}`);
});

test('readEnvironment rejects the distribution-signer and verifier addresses being the same identity', () => {
  const shared = `0x${'6'.repeat(40)}`;
  assert.throws(
    () => readEnvironment(baseEnv({
      HOOKEMON_DISTRIBUTION_PROFILE: 'production',
      HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS: shared,
      HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS: shared,
    })),
    /must be distinct EVM identities/,
  );
});

test('loadOperatorSignerClient(external-module backend) rejects an exported third Operations signer', async t => {
  const path = await tempSignerModule(t, `
    export function createSignerClient() {
      return {
        evm: { sign: async () => ({}), broadcast: async () => ({}) },
        operationsTrigger: { sign: async () => ({}), broadcast: async () => ({}) },
      };
    }
  `);
  const config = readEnvironment(baseEnv({ HOOKEMON_SIGNER_MODULE: path }));
  await assert.rejects(
    () => loadOperatorSignerClient(config),
    /third Operations signer; this is not supported/,
  );
});

test('loadOperatorSignerClient(keychain backend) exposes only the two Operations signers', async () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_KEYCHAIN_COMMAND: '/usr/local/bin/hookemon-keychain-sign',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'hookemon-operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'hookemon-operator-solana',
  }));
  const client = await loadOperatorSignerClient(config, { exec: async () => ({ code: 0, stdout: '{}' }) });
  assert.deepEqual(Object.keys(client).sort(), ['distributionSigner', 'evm', 'solana']);
});

test('loadOperatorSignerClient(external-module backend): also wraps an exported distributionSigner client under the distribution-signer role, and reports null when the module does not export one', async t => {
  const path = await tempSignerModule(t, `
    export function createSignerClient() {
      return {
        evm: null,
        solana: null,
        distributionSigner: { async sign() { return 'signed-approval-digest'; } },
      };
    }
  `);
  const config = readEnvironment(baseEnv({ HOOKEMON_SIGNER_MODULE: path, HOOKEMON_SIGNER_LIVE_MODE: 'true' }));
  const signerClient = await loadOperatorSignerClient(config, fixtureSignerOptions);
  assert.equal(signerClient.distributionSigner.role, 'distribution-signer');
  assert.equal(await signerClient.distributionSigner.sign(Buffer.from('x')), 'signed-approval-digest');
});

test('loadOperatorSignerClient(keychain backend) never offers a distributionSigner client — a distinct, documented scope boundary (decision D7)', async () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_KEYCHAIN_COMMAND: '/opt/hookemon/bin/keychain-sign',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'hookemon-operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'hookemon-operator-solana',
  }));
  const signerClient = await loadOperatorSignerClient(config, { exec: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
  assert.equal(signerClient.distributionSigner, null);
});

test('readEnvironment rejects an unrecognized HOOKEMON_SIGNER_BACKEND', () => {
  assert.throws(() => readEnvironment(baseEnv({ HOOKEMON_SIGNER_BACKEND: 'carrier-pigeon' })), /"external-module" or "keychain"/);
});

test('readEnvironment requires the keychain accounts and command when the keychain backend is selected', () => {
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_SIGNER_BACKEND: 'keychain' })),
    /HOOKEMON_KEYCHAIN_COMMAND/,
  );
  assert.throws(
    () => readEnvironment(baseEnv({
      HOOKEMON_SIGNER_BACKEND: 'keychain',
      HOOKEMON_KEYCHAIN_COMMAND: '/opt/hookemon/bin/keychain-sign',
    })),
    /HOOKEMON_KEYCHAIN_EVM_ACCOUNT/,
  );
  const config = readEnvironment(baseEnv({
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'true',
    HOOKEMON_KEYCHAIN_COMMAND: '/opt/hookemon/bin/keychain-sign',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'hookemon-operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'hookemon-operator-solana',
  }));
  assert.equal(config.signer.backend, 'keychain');
  assert.equal(config.signer.liveMode, true);
  assert.equal(config.signer.keychain.command, '/opt/hookemon/bin/keychain-sign');
});

test('readEnvironment requires every standing-authority verification path together', () => {
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_STANDING_AUTHORITY_PATH: '/abs/standing-authority.json' })),
    /must be set together/,
  );
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: '/abs/owner-public.pem' })),
    /must be set together/,
  );
  assert.throws(
    () => readEnvironment(baseEnv({ HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: '/abs/policy-public.pem' })),
    /must be set together/,
  );
  const config = readEnvironment(baseEnv({
    HOOKEMON_STANDING_AUTHORITY_PATH: '/abs/standing-authority.json',
    HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: '/abs/owner-public.pem',
    HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: '/abs/policy-public.pem',
  }));
  assert.equal(config.standingAuthority.documentPath, '/abs/standing-authority.json');
  assert.equal(config.standingAuthority.policyPublicKeyPath, '/abs/policy-public.pem');
});

test('loadOperatorSignerClient refuses live Operations clients until pinned transaction policies are wired', async t => {
  const path = await tempSignerModule(t, `
    export function createSignerClient() {
      return {
        evm: { async sign() { return { signedBytes: 'AAAA' }; }, async broadcast() { return { transactionId: 'tx-1' }; } },
        solana: null,
      };
    }
  `);
  const config = readEnvironment(baseEnv({ HOOKEMON_SIGNER_MODULE: path, HOOKEMON_SIGNER_LIVE_MODE: 'false' }));
  const signerClient = await loadOperatorSignerClient(config);
  assert.equal(signerClient.solana, null);
  await assert.rejects(() => signerClient.evm.sign({}), /liveMode is false/);

  const liveConfig = readEnvironment(baseEnv({ HOOKEMON_SIGNER_MODULE: path, HOOKEMON_SIGNER_LIVE_MODE: 'true' }));
  await assert.rejects(
    () => loadOperatorSignerClient(liveConfig),
    /requires pinned transaction policies and trusted decode context/,
  );
  await assert.rejects(
    () => loadOperatorSignerClient(liveConfig, fixtureSignerOptions),
    /requires pinned transaction policies and trusted decode context/,
  );
});

test('loadOperatorSignerClient(keychain backend): constructs a live client only after the keychain command remains the policy boundary', async () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'true',
    HOOKEMON_KEYCHAIN_COMMAND: '/opt/hookemon/bin/keychain-sign',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'hookemon-operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'hookemon-operator-solana',
  }));
  const calls = [];
  const exec = async ({ command, args, input }) => {
    calls.push({ command, args, operation: JSON.parse(input).operation, account: JSON.parse(input).account });
    return { code: 0, stdout: JSON.stringify({ signedBytes: 'AAAA' }), stderr: '' };
  };
  const productionClient = await loadOperatorSignerClient(config, { exec });
  const fixtureClient = await loadOperatorSignerClient(config, { exec, ...fixtureSignerOptions });
  assert.equal(typeof productionClient.evm.sign, 'function');
  assert.equal(typeof fixtureClient.solana.sign, 'function');
  assert.equal(calls.length, 0);
});

test('loadOperatorSignerClient(keychain backend) requires an injected exec function', async () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_KEYCHAIN_COMMAND: '/opt/hookemon/bin/keychain-sign',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'hookemon-operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'hookemon-operator-solana',
  }));
  await assert.rejects(() => loadOperatorSignerClient(config), /injected exec/);
});

test('probeKeychainOperations checks both configured Operations identities before signer construction', async () => {
  const config = readEnvironment(baseEnv({
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_KEYCHAIN_COMMAND: '/opt/hookemon/bin/keychain-sign',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
  }));
  const calls = [];
  const result = await probeKeychainOperations(config, {
    exec: async call => {
      calls.push(call);
      return { code: 0, stdout: JSON.stringify({ ready: true }), stderr: '' };
    },
  });
  assert.deepEqual(calls.map(call => call.args), [
    ['probe', '--role', 'operator-evm', '--account', 'operator-evm'],
    ['probe', '--role', 'operator-solana', '--account', 'operator-solana'],
  ]);
  assert.deepEqual(result, { 'operator-evm': { ready: true }, 'operator-solana': { ready: true } });
});

test('loadStandingAuthority returns null when no document path is configured, and the real verified document otherwise', async t => {
  const config = readEnvironment(baseEnv());
  assert.equal(loadStandingAuthority(config), null);

  const directory = await mkdtemp(join(tmpdir(), 'hookemon-env-standing-authority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownerKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const ownerPublicKeyPath = join(directory, 'owner-public.pem');
  const policyPublicKeyPath = join(directory, 'policy-public.pem');
  await writeFile(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(policyPublicKeyPath, policyKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  const unsigned = buildCanonicalStandingAuthorityDocument({
    owner: 'hookemon-owner',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '25000000',
    maxCyclesPerDay: 72,
    allowedPacks: ['collector-crypt'],
    allowedDestinations: ['relay-bridge-return'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'standing-authority-2026-01',
  });
  const signed = attachOwnerSignature(unsigned, ownerKeys.privateKey);
  const documentPath = join(directory, 'standing-authority.json');
  await writeFile(documentPath, JSON.stringify(signed));

  const configuredEnv = readEnvironment(baseEnv({
    HOOKEMON_STANDING_AUTHORITY_PATH: documentPath,
    HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: ownerPublicKeyPath,
    HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: policyPublicKeyPath,
  }));
  const verified = loadStandingAuthority(configuredEnv);
  assert.equal(verified.documentDigest, unsigned.documentDigest);
  assert.equal(verified.provider.standingAuthorityDigest, unsigned.documentDigest);
});

test('loadStandingAuthority rejects a configured policy key that is not bound by the owner-signed document', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-env-standing-authority-mismatch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ownerKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const otherPolicyKeys = generateKeyPairSync('ed25519');
  const ownerPublicKeyPath = join(directory, 'owner-public.pem');
  const policyPublicKeyPath = join(directory, 'policy-public.pem');
  await writeFile(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(policyPublicKeyPath, otherPolicyKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  const unsigned = buildCanonicalStandingAuthorityDocument({
    owner: 'hookemon-owner',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '25000000',
    maxCyclesPerDay: 72,
    allowedPacks: ['collector-crypt'],
    allowedDestinations: ['relay-bridge-return'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'standing-authority-2026-01',
  });
  const documentPath = join(directory, 'standing-authority.json');
  await writeFile(documentPath, JSON.stringify(attachOwnerSignature(unsigned, ownerKeys.privateKey)));

  const config = readEnvironment(baseEnv({
    HOOKEMON_STANDING_AUTHORITY_PATH: documentPath,
    HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: ownerPublicKeyPath,
    HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: policyPublicKeyPath,
  }));
  assert.throws(() => loadStandingAuthority(config), /policy key does not match/);
});

test('loadStandingAuthority rejects symlinked and non-private production artifacts', async t => {
  const env = await productionEnv(t, {
    HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: 'https://archive-rpc.example.test',
  });
  const directory = env.HOOKEMON_STATE_DIR;
  const ownerKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const ownerPublicKeyPath = join(directory, 'owner-public.pem');
  const policyPublicKeyPath = join(directory, 'policy-public.pem');
  const documentPath = join(directory, 'standing-authority.json');
  await writeFile(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(policyPublicKeyPath, policyKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  const unsigned = buildCanonicalStandingAuthorityDocument({
    owner: 'hookemon-owner',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '25000000',
    maxCyclesPerDay: 72,
    allowedPacks: ['collector-crypt'],
    allowedDestinations: ['relay-bridge-return'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'standing-authority-2026-01',
  });
  await writeFile(documentPath, JSON.stringify(attachOwnerSignature(unsigned, ownerKeys.privateKey)));
  const config = readEnvironment({
    ...env,
    HOOKEMON_STANDING_AUTHORITY_PATH: documentPath,
    HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: ownerPublicKeyPath,
    HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: policyPublicKeyPath,
  }, { profile: 'production' });
  const artifactPath = join(directory, 'standing-authority-step-authorizations.json');
  const artifactTarget = join(directory, 'authority-artifact-target.json');
  await writeFile(artifactTarget, '{}\n', { mode: 0o600 });
  await symlink(artifactTarget, artifactPath);
  assert.throws(
    () => loadStandingAuthority(config),
    /standing authority artifact must be a private regular file/,
  );

  await unlink(artifactPath);
  await writeFile(artifactPath, '{}\n', { mode: 0o644 });
  assert.throws(
    () => loadStandingAuthority(config),
    /standing authority artifact must be a private regular file/,
  );
});
