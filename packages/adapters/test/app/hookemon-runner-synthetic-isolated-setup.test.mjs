// Proves the exact seam the boundary correction review found missing: the real
// `bin/hookemon-runner.mjs` entrypoint (not a test-side overlay) constructs its own
// WeakSet-branded isolated Keychain child setup and threads it into the real, exported
// `compositionInput` before composing. Both functions under test here are the runner's own,
// unmodified code -- `applySyntheticIsolatedChildSetup` is exactly what `buildComposition` calls,
// extracted only so a focused test can drive it directly without needing real loopback mock RPC
// servers for the full `compose()`/network-identity path (that remains the N2 worker's literal
// full-flow CLI proof).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySyntheticIsolatedChildSetup,
  compositionInput,
} from '../../bin/hookemon-runner.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  assertCollectorOfflineExecutionBoundary,
} from '../../src/signing/collector-production-binding.mjs';

function baseCompositionInputArgs(env) {
  return {
    env,
    statePath: '/tmp/hookemon-runner-synthetic-isolated-setup/operator-state.json',
    dashboard: null,
    signerClient: null,
    signerReadiness: null,
    rehearsalCapUsdg: null,
    rehearsalSessionId: null,
    restartInjector: null,
    operatorAuditLogPath: undefined,
    logTicks: false,
  };
}

function baseSyntheticEnv(syntheticRoot) {
  return {
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: false },
    rehearsal: null,
    collectorCrypt: {
      baseUrl: 'https://127.0.0.1:4201',
      apiKey: 'hookemon-synthetic-offline-collector-key',
      productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
      syntheticRoot,
    },
    robinhood: { rpcUrl: 'https://127.0.0.1:4202', archiveRpcUrl: 'https://127.0.0.1:4203' },
    solana: { rpcUrl: 'https://127.0.0.1:4204' },
    relay: { baseUrl: 'https://127.0.0.1:4205', apiKey: 'hookemon-synthetic-offline-relay-key' },
    accounts: { evm: null, solana: null },
    standingAuthority: { documentPath: null },
    signer: {
      backend: 'keychain',
      liveMode: true,
      keychain: { command: '/tmp/unused-placeholder', evmAccount: 'operator-evm', solanaAccount: 'operator-solana' },
    },
  };
}

async function isolatedRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-runner-synthetic-root-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('applySyntheticIsolatedChildSetup leaves a non-synthetic env untouched, with no isolated setup constructed', async () => {
  const env = { collectorCrypt: { productionBindingAuthority: null }, signer: { keychain: { command: '/tmp/real-command' } } };
  const result = await applySyntheticIsolatedChildSetup(env);
  assert.equal(result, env, 'the exact same object must be returned, unmodified');
  assert.equal(result.signer.keychain.command, '/tmp/real-command');
});

test('applySyntheticIsolatedChildSetup constructs a real, authenticated isolated child setup that satisfies the offline boundary', async t => {
  const directory = await isolatedRoot(t);
  const env = baseSyntheticEnv(directory);
  const result = await applySyntheticIsolatedChildSetup(env);

  assert.notEqual(result.signer.keychain.command, '/tmp/unused-placeholder', 'the operator-supplied placeholder command must be overridden');
  assert.equal(typeof result.signer.keychain.isolatedChildSetup, 'object');
  assert.equal(result.signer.keychain.command, result.signer.keychain.isolatedChildSetup.command);

  // The exact real function compositionInput really is, not a reimplementation, and the exact
  // real boundary check purchase.mjs/buyback.mjs really call.
  const composed = compositionInput(baseCompositionInputArgs(result));
  assert.equal(composed.signer, result.signer, 'compositionInput must forward the real signer config through to the composed stage config');
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(composed));
});

test('applySyntheticIsolatedChildSetup reopens the same ephemeral identities across a simulated restart, without minting a replacement pair', async t => {
  const directory = await isolatedRoot(t);
  const first = await applySyntheticIsolatedChildSetup(baseSyntheticEnv(directory));
  const second = await applySyntheticIsolatedChildSetup(baseSyntheticEnv(directory));

  const firstSetup = first.signer.keychain.isolatedChildSetup;
  const secondSetup = second.signer.keychain.isolatedChildSetup;
  assert.notEqual(firstSetup, secondSetup, 'each call mints its own authenticated setup object');
  assert.equal(secondSetup.evmAddress, firstSetup.evmAddress, 'the ephemeral EVM identity must be reopened, not regenerated');
  assert.equal(secondSetup.solanaPublicKey, firstSetup.solanaPublicKey, 'the ephemeral Solana identity must be reopened, not regenerated');

  // Both are still independently authenticated: the boundary accepts whichever one the config
  // actually carries.
  const composedSecond = compositionInput(baseCompositionInputArgs(second));
  assert.doesNotThrow(() => assertCollectorOfflineExecutionBoundary(composedSecond));
});

test('compositionInput never fabricates a signer config for an env that never carried one', () => {
  const env = { ...baseSyntheticEnv('/tmp/unused-root'), collectorCrypt: { productionBindingAuthority: null } };
  delete env.signer;
  const composed = compositionInput(baseCompositionInputArgs(env));
  assert.equal(composed.signer, undefined);
});
