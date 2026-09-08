import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MoneyConfigurationRejected, readEnvironment } from '../../src/app/environment.mjs';
import { CIRCLE_USD_MINT, deriveAssociatedTokenAddress } from '../../src/solana-rpc.mjs';

const OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const PROCEEDS_ACCOUNT = deriveAssociatedTokenAddress(OPERATIONS_SOLANA, CIRCLE_USD_MINT).toBase58();

function completeProductionEnvironment(overrides = {}) {
  return {
    HOOKEMON_STATE_DIR: '/tmp/hookemon-state',
    HOOKEMON_CHAIN_ID: '4663',
    HOOKEMON_ROBINHOOD_RPC_URL: 'https://rpc.example.test',
    HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: 'https://archive-rpc.example.test',
    HOOKEMON_SOLANA_RPC_URL: 'https://solana.example.test',
    HOOKEMON_RELAY_BASE_URL: 'https://relay.example.test',
    HOOKEMON_RELAY_API_KEY: 'test-relay-key',
    HOOKEMON_RELAY_SOLANA_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    HOOKEMON_RELAY_SOLANA_DECIMALS: '6',
    HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: 'https://collector.example.test',
    HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'test-collector-key',
    HOOKEMON_EVM_ACCOUNT: `0x${'b'.repeat(40)}`,
    HOOKEMON_SOLANA_ACCOUNT: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t',
    HOOKEMON_VAULT_ADDRESS: `0x${'c'.repeat(40)}`,
    HOOKEMON_HOOK_ADDRESS: `0x${'d'.repeat(40)}`,
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'true',
    HOOKEMON_KEYCHAIN_COMMAND: '/tmp/hookemon-keychain-signer',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_PROVIDER_MODE: 'live',
    HOOKEMON_PACK_CODE: 'collector-25',
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
    ...overrides,
  };
}

test('production profile refuses an omitted money floor instead of supplying a placeholder', () => {
  assert.throws(
    () => readEnvironment(completeProductionEnvironment(), { profile: 'production' }),
    /HOOKEMON_MIN_ROBINHOOD_RECEIVE is required/,
  );
});

test('production profile refuses rehearsal flags even when Operations identities are complete', () => {
  assert.throws(
    () => readEnvironment(completeProductionEnvironment({
      HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
      HOOKEMON_REHEARSAL_MODE: 'collector-only',
      HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: '11111111111111111111111111111111',
      HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
      HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: '22222222222222222222222222222222',
    }), { profile: 'production' }),
    /production profile refuses HOOKEMON_REHEARSAL_MODE/,
  );
});

test('production profile refuses fake providers before signer construction', () => {
  assert.throws(
    () => readEnvironment(completeProductionEnvironment({
      HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
      HOOKEMON_PROVIDER_MODE: 'fake',
    }), { profile: 'production' }),
    /production profile requires HOOKEMON_PROVIDER_MODE=live/,
  );
});

test('collector-only rehearsal names the Circle settlement asset without Relay configuration', () => {
  const environment = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_PROVIDER_MODE: 'fake',
    HOOKEMON_SIGNER_LIVE_MODE: 'false',
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_SOLANA_ACCOUNT: OPERATIONS_SOLANA,
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: PROCEEDS_ACCOUNT,
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
  });
  for (const field of [
    'HOOKEMON_EVM_ACCOUNT',
    'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
    'HOOKEMON_RELAY_BASE_URL',
    'HOOKEMON_RELAY_API_KEY',
    'HOOKEMON_RELAY_SOLANA_MINT',
    'HOOKEMON_RELAY_SOLANA_DECIMALS',
    'HOOKEMON_RELAY_EVM_DEPOSITORY',
    'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
    'HOOKEMON_VAULT_ADDRESS',
    'HOOKEMON_HOOK_ADDRESS',
  ]) delete environment[field];

  const config = readEnvironment(environment, { profile: 'rehearsal' });
  assert.deepEqual(config.moneyConfiguration.assets.solanaStablecoin, {
    chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: 6,
  });
});

test('collector-only rehearsal keeps its fake fixture profile Solana-only', () => {
  const environment = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_PROVIDER_MODE: 'fake',
    HOOKEMON_SIGNER_LIVE_MODE: 'false',
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_SOLANA_ACCOUNT: OPERATIONS_SOLANA,
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: PROCEEDS_ACCOUNT,
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm,H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
  });
  for (const field of [
    'HOOKEMON_ROBINHOOD_RPC_URL',
    'HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL',
    'HOOKEMON_EVM_ACCOUNT',
    'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
    'HOOKEMON_RELAY_BASE_URL',
    'HOOKEMON_RELAY_API_KEY',
    'HOOKEMON_RELAY_SOLANA_MINT',
    'HOOKEMON_RELAY_SOLANA_DECIMALS',
    'HOOKEMON_RELAY_EVM_DEPOSITORY',
    'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
    'HOOKEMON_VAULT_ADDRESS',
    'HOOKEMON_HOOK_ADDRESS',
  ]) delete environment[field];

  const config = readEnvironment(environment, { profile: 'rehearsal' });

  assert.equal(config.accounts.evm, null);
  assert.deepEqual(config.signer.roles, ['operator-solana']);
  assert.equal(config.relay.apiKey, null);
  assert.equal(config.observability, null);
});

test('collector-only rehearsal refuses production bridge and provider credentials', () => {
  assert.throws(
    () => readEnvironment(completeProductionEnvironment({
      HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
      HOOKEMON_PROVIDER_MODE: 'fake',
      HOOKEMON_SIGNER_LIVE_MODE: 'false',
      HOOKEMON_REHEARSAL_MODE: 'collector-only',
      HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: '11111111111111111111111111111111',
      HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
      HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: '22222222222222222222222222222222',
    }), { profile: 'rehearsal' }),
    /collector-only rehearsal refuses production bridge, contract, and provider credentials/,
  );
});

test('collector-only live rehearsal accepts the Solana Operations signer and dedicated proceeds account', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  const keyPath = join(directory, 'collector-key');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(keyPath, 'test-collector-key\n', 'utf8');
  await chmod(keyPath, 0o600);
  const environment = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_SOLANA_ACCOUNT: OPERATIONS_SOLANA,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: PROCEEDS_ACCOUNT,
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm,H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '25000000',
    HOOKEMON_COLLECTOR_CRYPT_API_KEY_PATH: keyPath,
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
  });
  for (const field of [
    'HOOKEMON_EVM_ACCOUNT',
    'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
    'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
    'HOOKEMON_RELAY_BASE_URL',
    'HOOKEMON_RELAY_API_KEY',
    'HOOKEMON_RELAY_SOLANA_MINT',
    'HOOKEMON_RELAY_SOLANA_DECIMALS',
    'HOOKEMON_RELAY_EVM_DEPOSITORY',
    'HOOKEMON_VAULT_ADDRESS',
    'HOOKEMON_HOOK_ADDRESS',
  ]) delete environment[field];

  assert.throws(
    () => readEnvironment({ ...environment, HOOKEMON_SOLANA_ACCOUNT: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t' }, { profile: 'rehearsal' }),
    /must use the configured Operations Solana public key/,
  );
  assert.throws(
    () => readEnvironment({ ...environment, HOOKEMON_SIGNER_MODULE: '/tmp/legacy-rehearsal-signer.mjs' }, { profile: 'rehearsal' }),
    /refuses HOOKEMON_SIGNER_MODULE/,
  );
  const config = readEnvironment(environment, { profile: 'rehearsal' });

  assert.equal(config.execution.providerMode, 'live');
  assert.equal(config.accounts.evm, null);
  assert.deepEqual(config.signer.roles, ['operator-solana']);
  assert.equal(config.rehearsal.proceedsAccount, PROCEEDS_ACCOUNT);
  assert.deepEqual(config.moneyConfiguration.assets.solanaStablecoin, {
    chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: 6,
  });
  assert.deepEqual(config.collectorCrypt.settlementAsset, {
    chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: 6,
  });
  assert.deepEqual(config.collectorCrypt.packPrice, {
    chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: 6, amountAtomic: '25000000',
  });
});

test('collector-only live rehearsal reads its Collector credential from a private path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-collector-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'collector-key');
  await writeFile(keyPath, 'test-collector-key\n', 'utf8');
  await chmod(keyPath, 0o600);
  const environment = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_SOLANA_ACCOUNT: OPERATIONS_SOLANA,
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: PROCEEDS_ACCOUNT,
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm,H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '25000000',
    HOOKEMON_COLLECTOR_CRYPT_API_KEY_PATH: keyPath,
  });
  for (const field of [
    'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
    'HOOKEMON_EVM_ACCOUNT',
    'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
    'HOOKEMON_RELAY_BASE_URL',
    'HOOKEMON_RELAY_API_KEY',
    'HOOKEMON_RELAY_SOLANA_MINT',
    'HOOKEMON_RELAY_SOLANA_DECIMALS',
    'HOOKEMON_RELAY_EVM_DEPOSITORY',
    'HOOKEMON_VAULT_ADDRESS',
    'HOOKEMON_HOOK_ADDRESS',
  ]) delete environment[field];

  assert.equal(readEnvironment(environment, { profile: 'rehearsal' }).collectorCrypt.apiKey, 'test-collector-key');
});

test('production profile accepts an explicit complete configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(eligibilitySnapshotPath, '{}\n', 'utf8');
  const config = readEnvironment(completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
    HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath,
  }), { profile: 'production' });
  assert.equal(config.execution.profile, 'production');
  assert.equal(config.relay.solanaMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.deepEqual(config.observability, {});
});

test('production profile wires solana.chainId and collectorCrypt.settlementAsset from the Collector settlement asset, distinct from the Relay money namespace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(eligibilitySnapshotPath, '{}\n', 'utf8');
  const config = readEnvironment(completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
    HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath,
  }), { profile: 'production' });

  assert.equal(config.solana.chainId, 'solana-mainnet');
  assert.deepEqual(config.collectorCrypt.settlementAsset, {
    chainId: 'solana-mainnet',
    assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  });
  // The Relay-side MoneyConfigurationV1 asset keeps its own numeric chain-id namespace (Relay's
  // cross-chain identifier, 792703809) — distinct from the native Collector transaction-policy
  // label above, even though both currently name the same mint and decimals.
  assert.equal(config.moneyConfiguration.assets.solanaStablecoin.chainId, '792703809');
  assert.notDeepEqual(config.collectorCrypt.settlementAsset, config.moneyConfiguration.assets.solanaStablecoin);
});

test('production profile refuses a Relay Solana mint that is not the documented Collector settlement asset', () => {
  assert.throws(
    () => readEnvironment(completeProductionEnvironment({
      HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
      HOOKEMON_RELAY_SOLANA_MINT: 'So11111111111111111111111111111111111111112',
    }), { profile: 'production' }),
    /HOOKEMON_RELAY_SOLANA_MINT and HOOKEMON_RELAY_SOLANA_DECIMALS to match the documented Collector settlement asset/,
  );
  assert.throws(
    () => readEnvironment(completeProductionEnvironment({
      HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
      HOOKEMON_RELAY_SOLANA_DECIMALS: '9',
    }), { profile: 'production' }),
    /HOOKEMON_RELAY_SOLANA_MINT and HOOKEMON_RELAY_SOLANA_DECIMALS to match the documented Collector settlement asset/,
  );
});

test('production profile builds MoneyConfigurationV1 from explicit assets, minima, caps, and reserves', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(eligibilitySnapshotPath, '{}\n', 'utf8');
  const config = readEnvironment(completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '2',
    HOOKEMON_MIN_SOLANA_RECEIVE: '3',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
    HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath,
  }), { profile: 'production' });

  assert.deepEqual(config.moneyConfiguration, {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: config.contracts.usdg, decimals: 6 },
      solanaStablecoin: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
      },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: config.contracts.usdg, decimals: 6, amountAtomic: '2' },
      solanaReceive: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        amountAtomic: '3',
      },
      returnUsdg: { chainId: '4663', assetId: config.contracts.usdg, decimals: 6, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2000000000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '3000000000000000' },
    },
    solana: {
      priorityFeeCap: {
        chainId: '792703809',
        assetId: 'microlamports-per-compute-unit',
        decimals: 0,
        amountAtomic: '25000',
      },
      lamportReserve: {
        chainId: '792703809',
        assetId: 'native',
        decimals: 9,
        amountAtomic: '5000000',
      },
    },
  });
  assert.equal(config.minimums.returnUsdg, '0');
  assert.equal(config.nativeGasCaps.robinhood, '0');
});

test('production profile rejects the atomic placeholder and refuses legacy native caps as a substitute', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  await writeFile(eligibilitySnapshotPath, '{}\n', 'utf8');
  const complete = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
    HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath,
  });

  assert.throws(
    () => readEnvironment({ ...complete, HOOKEMON_EVM_GAS_PRICE_CAP: '1' }, { profile: 'production' }),
    MoneyConfigurationRejected,
  );
  const legacyOnly = { ...complete };
  delete legacyOnly.HOOKEMON_EVM_GAS_PRICE_CAP;
  assert.throws(
    () => readEnvironment(legacyOnly, { profile: 'production' }),
    /HOOKEMON_EVM_GAS_PRICE_CAP is required/,
  );
});

test('collector-only rehearsal accepts an explicit fake-provider profile without production credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  const config = readEnvironment({
    HOOKEMON_STATE_DIR: '/tmp/hookemon-state',
    HOOKEMON_CHAIN_ID: '4663',
    HOOKEMON_ROBINHOOD_RPC_URL: 'https://rpc.example.test',
    HOOKEMON_SOLANA_RPC_URL: 'https://solana.example.test',
    HOOKEMON_EVM_ACCOUNT: `0x${'b'.repeat(40)}`,
    HOOKEMON_SOLANA_ACCOUNT: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t',
    HOOKEMON_SIGNER_BACKEND: 'keychain',
    HOOKEMON_SIGNER_LIVE_MODE: 'false',
    HOOKEMON_KEYCHAIN_COMMAND: '/tmp/hookemon-keychain-signer',
    HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm',
    HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
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
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '30',
    HOOKEMON_BUDGET_PACK_PRICE_USDG: '30',
    HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0',
    HOOKEMON_BUDGET_RETURN_CAP_USDG: '0',
    HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0',
    HOOKEMON_PROVIDER_MODE: 'fake',
    HOOKEMON_RELAY_SOLANA_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    HOOKEMON_RELAY_SOLANA_DECIMALS: '6',
    HOOKEMON_REHEARSAL_MODE: 'collector-only',
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: '11111111111111111111111111111111',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: '22222222222222222222222222222222',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
  }, { profile: 'rehearsal' });
  assert.equal(config.execution.providerMode, 'fake');
  assert.equal(config.rehearsal.proceedsAccount, '11111111111111111111111111111111');
});

test('relay-roundtrip rehearsal accepts only the sealed fake-provider configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  const environment = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_PROVIDER_MODE: 'fake',
    HOOKEMON_SIGNER_LIVE_MODE: 'false',
    HOOKEMON_REHEARSAL_MODE: 'relay-roundtrip',
    HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT: '11111111111111111111111111111111',
    HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS: '22222222222222222222222222222222',
    HOOKEMON_REHEARSAL_PAYOUT_SPLIT: 'equal',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
  });
  delete environment.HOOKEMON_RELAY_API_KEY;
  delete environment.HOOKEMON_RELAY_EVM_DEPOSITORY;
  delete environment.HOOKEMON_VAULT_ADDRESS;
  delete environment.HOOKEMON_HOOK_ADDRESS;
  delete environment.HOOKEMON_COLLECTOR_CRYPT_API_KEY;

  const config = readEnvironment(environment, { profile: 'rehearsal' });
  assert.equal(config.execution.providerMode, 'fake');
  assert.equal(config.signer.liveMode, false);
  assert.equal(config.rehearsal.mode, 'relay-roundtrip');
  assert.throws(
    () => readEnvironment({ ...environment, HOOKEMON_RELAY_API_KEY: 'test-relay-key' }, { profile: 'rehearsal' }),
    /relay-roundtrip rehearsal refuses production bridge, contract, and provider credentials/,
  );
  assert.throws(
    () => readEnvironment({ ...environment, HOOKEMON_PROVIDER_MODE: 'live' }, { profile: 'rehearsal' }),
    /relay-roundtrip rehearsal requires HOOKEMON_PROVIDER_MODE=fake/,
  );
});

test('production profile names every required money and execution field when it is absent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-observability-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observabilityPath = join(directory, 'observability.json');
  await writeFile(observabilityPath, '{}\n', 'utf8');
  const complete = completeProductionEnvironment({
    HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0',
    HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath,
  });
  const mandatory = [
    'HOOKEMON_CHAIN_ID',
    'HOOKEMON_ROBINHOOD_RPC_URL',
    'HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL',
    'HOOKEMON_SOLANA_RPC_URL',
    'HOOKEMON_COLLECTOR_CRYPT_BASE_URL',
    'HOOKEMON_COLLECTOR_CRYPT_API_KEY',
    'HOOKEMON_SOLANA_ACCOUNT',
    'HOOKEMON_SIGNER_BACKEND',
    'HOOKEMON_SIGNER_LIVE_MODE',
    'HOOKEMON_KEYCHAIN_COMMAND',
    'HOOKEMON_KEYCHAIN_EVM_ACCOUNT',
    'HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT',
    'HOOKEMON_PACK_CODE',
    'HOOKEMON_MIN_ROBINHOOD_RECEIVE',
    'HOOKEMON_MIN_SOLANA_RECEIVE',
    'HOOKEMON_MIN_RETURN_USDG',
    'HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD',
    'HOOKEMON_NATIVE_GAS_CAP_SOLANA',
    'HOOKEMON_EVM_GAS_PRICE_CAP',
    'HOOKEMON_EVM_NATIVE_RESERVE',
    'HOOKEMON_SOLANA_PRIORITY_FEE_CAP',
    'HOOKEMON_SOLANA_LAMPORT_RESERVE',
    'HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG',
    'HOOKEMON_BUDGET_PACK_PRICE_USDG',
    'HOOKEMON_BUDGET_OUTBOUND_CAP_USDG',
    'HOOKEMON_BUDGET_RETURN_CAP_USDG',
    'HOOKEMON_BUDGET_OPERATING_MARGIN_USDG',
    'HOOKEMON_PROVIDER_MODE',
    'HOOKEMON_RELAY_BASE_URL',
    'HOOKEMON_RELAY_API_KEY',
    'HOOKEMON_RELAY_SOLANA_MINT',
    'HOOKEMON_RELAY_SOLANA_DECIMALS',
    'HOOKEMON_RELAY_EVM_DEPOSITORY',
    'HOOKEMON_EVM_ACCOUNT',
    'HOOKEMON_VAULT_ADDRESS',
    'HOOKEMON_HOOK_ADDRESS',
    'HOOKEMON_OBSERVABILITY_CONFIG_PATH',
  ];
  for (const field of mandatory) {
    const environment = { ...complete };
    delete environment[field];
    assert.throws(() => readEnvironment(environment, { profile: 'production' }), new RegExp(`${field} is required`));
  }
});
