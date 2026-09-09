#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRelayClient, createQuoteUsdValuation } from '../src/relay-client.mjs';
import { collectorOnlyPackCostMicroUsd } from '../src/app/compose.mjs';
// Production entrypoint: one command that starts (or single-steps) the autonomous cycle loop against
// real configuration read from the environment (never from a file inside this repository — see
// environment.mjs). Subcommands:
//
//   hookemon-runner run [--state <path>] [--no-dashboard]
//                                                start the scheduler; runs until SIGINT/SIGTERM. Also
//                                                starts the dashboard control service
//                                                (packages/dashboard) in this same process, sharing
//                                                the scheduler's own cycleRepository/statePath and
//                                                wiring run-cycle-now/restart-request/
//                                                reconcile-request to the real scheduler/service
//                                                (see compose.mjs's composeDashboard), unless
//                                                --no-dashboard is given.
//   hookemon-runner dry-run [--mode inspection|production] [--state <path>]
//                                                drive exactly one tick with liveMode forced false,
//                                                regardless of what the operator state file says,
//                                                then exit. Exits 0 on a clean run, including the
//                                                ordinary "nothing to do yet" outcomes
//                                                (LEASE_HELD/NO_ACTIVE_CYCLE/WAITING_FOR_PROCESS_BUDGET).
//   hookemon-runner status [--state <path>]      print the current cycle-repository projection for
//                                                the active cycle (or "no active cycle") and exit.
//   hookemon-runner operator [--state <path>] <operator-command> [operator flags]
//                                                dispatch an operator command through the composed
//                                                authority and its durable audit executor.
//
// `--state <path>` overrides `HOOKEMON_STATE_DIR`'s derived operator-state.json location for a
// single invocation (mainly for tests / local dry runs); it must be an absolute path.
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  loadOperatorSignerClient,
  loadStandingAuthority,
  probeKeychainOperations,
  readEnvironment,
} from '../src/app/environment.mjs';
import { CycleRepository } from '../src/app/cycle-repository.mjs';
import { createFileLeaseStore } from '../src/app/lease-store.mjs';
import { acquireLease, assertLeaseCurrent, releaseLease } from '../../runner/src/automation/exclusive-lease.mjs';
import { collectRehearsalEvidence, ensureRehearsalEvidence } from '../../runner/src/cycle/rehearsal-evidence.mjs';
import { RehearsalRestartInjectedError } from '../../runner/src/cycle/rehearsal-stage-driver.mjs';
import {
  openOrCreateRehearsalSession,
  readRehearsalSession,
  recordRehearsalSessionCompletion,
  recordRehearsalSessionRestart,
} from '../../runner/src/cycle/rehearsal-session.mjs';
import { inspectCycleRecovery, projectCycleRepositoryStatus } from '../../runner/src/operator/cli.mjs';
import { createEmptyOperatorState, mutateOperatorState, readOperatorState } from '../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../runner/src/config/state-schema.mjs';
import {
  assertCollectorOnlyRehearsalPolicy,
  deriveCyclePolicyDigest,
  PolicyRefusalError,
} from '../../runner/src/automation/policy-engine.mjs';
import { createProcessExec } from '../src/signing/keychain-process-exec.mjs';
import {
  assertCollectorPolicyBundleRuntimeReady,
  attachCollectorPolicyBundle,
  loadCollectorPolicyBundle,
} from '../src/signing/collector-policy-loader.mjs';
import { http } from 'viem';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  createIsolatedKeychainChildSetup,
  createLoopbackConfinedFetch,
} from '../src/signing/collector-production-binding.mjs';
import { createCollectorCryptClient } from '../src/collector-crypt.mjs';
import { createSolanaRpcClient, submitSignedTransaction } from '../src/solana-rpc.mjs';
import { createRobinhoodClient, sendRawTransaction } from '../src/robinhood-rpc.mjs';
import { runCollectorOnlyPreflight as runCollectorOnlyPreflightPlan } from '../rehearsal/collector-only-preflight.mjs';

export { applySyntheticIsolatedChildSetup, chainBroadcastTransports, compositionInput, createProcessExec, parseArgv };

const USAGE = `Usage: hookemon-runner run --mode rehearsal --cycles <positive-integer> --cap-micro-usd <atomic-amount> (--collector-only|--relay-roundtrip) [--restart-inject]
   or: hookemon-runner preflight [--state <absolute-path-to-operator-state.json>]
   or: hookemon-runner run --mode production [--state <absolute-path-to-operator-state.json>] [--no-dashboard]
   or: hookemon-runner dry-run [--mode inspection|production] [--state <absolute-path-to-operator-state.json>]
   or: hookemon-runner status [--cycle <cycle-id>] [--state <absolute-path-to-operator-state.json>]
   or: hookemon-runner resume <cycle-id> [--state <absolute-path-to-operator-state.json>]
   or: hookemon-runner abort-cycle <cycle-id> --reason <reason> [--state <absolute-path-to-operator-state.json>]
   or: hookemon-runner operator [--state <absolute-path-to-operator-state.json>] initialize-collector-only-policy
   or: hookemon-runner operator [--state <absolute-path-to-operator-state.json>] <operator-command> [operator flags]

Configuration is read from HOOKEMON_* environment variables (see packages/adapters/src/app/environment.mjs)
and, optionally, HOOKEMON_SIGNER_MODULE for the injected signer client. Nothing is ever read from a
file inside this repository. "run" also starts the dashboard control service (HOOKEMON_DASHBOARD_*
environment variables, see packages/dashboard/src/server.mjs) in this same process unless
--no-dashboard is given.`;

function parseOperatorArgv(rest) {
  let statePathOverride = null;
  const operatorArgv = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--state') {
      if (statePathOverride !== null) throw new Error('operator --state must not be duplicated');
      statePathOverride = rest[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === '--no-dashboard') throw new Error('operator commands do not start a dashboard listener');
    operatorArgv.push(token);
  }
  return Object.freeze({ statePathOverride, operatorArgv });
}

const COMMANDS = new Set(['run', 'preflight', 'tick', 'dry-run', 'status', 'resume', 'abort-cycle', 'operator']);
const BOOLEAN_FLAGS = new Set(['no-dashboard', 'collector-only', 'relay-roundtrip', 'restart-inject']);
const FLAG_ALLOWLIST = Object.freeze({
  run: new Set(['state', 'no-dashboard', 'mode', 'cycles', 'cap-micro-usd', 'collector-only', 'relay-roundtrip', 'restart-inject']),
  preflight: new Set(['state']),
  tick: new Set(['state']),
  'dry-run': new Set(['state', 'mode']),
  status: new Set(['state', 'cycle']),
  resume: new Set(['state']),
  'abort-cycle': new Set(['state', 'reason']),
});
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const REHEARSAL_RESTART_EXIT_CODE = 75;
const REHEARSAL_RESTART_WORKER_ENV = 'HKMN_REHEARSAL_RESTART_WORKER';
const REHEARSAL_SESSION_PATH_ENV = 'HKMN_REHEARSAL_SESSION_PATH';

function usageError(message) {
  return new Error(`${message}\n\n${USAGE}`);
}

function parsePositiveInteger(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw usageError(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw usageError(`${label} exceeds the supported range`);
  return parsed;
}

function parseArgv(argv) {
  const [command, ...tokens] = argv;
  if (!command || !COMMANDS.has(command)) return { command: command ?? null, invalidCommand: true };
  if (command === 'operator') {
    const { statePathOverride, operatorArgv } = parseOperatorArgv(tokens);
    return Object.freeze({
      command,
      statePathOverride,
      noDashboard: false,
      cycleId: null,
      operatorArgv,
    });
  }
  const allowedFlags = FLAG_ALLOWLIST[command];
  const flags = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowedFlags.has(name)) throw usageError(`--${name} is not allowed for ${command}`);
    if (Object.hasOwn(flags, name)) throw usageError(`--${name} must not be repeated`);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw usageError(`--${name} requires a value`);
    }
    flags[name] = value;
    index += 1;
  }
  if (command === 'run') {
    if (positionals.length !== 0) throw usageError('run does not accept positional arguments');
    const mode = flags.mode ?? null;
    if (mode === null) throw usageError('run requires --mode production or rehearsal');
    if (mode !== 'production' && mode !== 'rehearsal') throw usageError('--mode must be production or rehearsal');
    if (mode === 'rehearsal') {
      if (!Object.hasOwn(flags, 'cycles') || !Object.hasOwn(flags, 'cap-micro-usd')) {
        throw usageError('rehearsal run requires --cycles and --cap-micro-usd');
      }
      if (flags['cap-micro-usd'] === '0' || !decimalPattern.test(flags['cap-micro-usd'])) {
        throw usageError('--cap-micro-usd must be a positive atomic amount');
      }
      if (flags['collector-only'] && flags['relay-roundtrip']) {
        throw usageError('cannot combine --collector-only and --relay-roundtrip');
      }
      if (!flags['collector-only'] && !flags['relay-roundtrip']) {
        throw usageError('rehearsal requires --collector-only or --relay-roundtrip');
      }
    } else if (Object.hasOwn(flags, 'cycles') || Object.hasOwn(flags, 'cap-micro-usd') || flags['collector-only'] || flags['relay-roundtrip'] || flags['restart-inject']) {
      throw usageError('--cycles, --cap-micro-usd, --collector-only, --relay-roundtrip, and --restart-inject require --mode rehearsal');
    }
    return Object.freeze({
      command,
      statePathOverride: flags.state ?? null,
      noDashboard: flags['no-dashboard'] === true,
      mode,
      cycles: mode === 'rehearsal' ? parsePositiveInteger(flags.cycles, '--cycles') : null,
      capMicroUsd: mode === 'rehearsal' ? flags['cap-micro-usd'] : null,
      collectorOnly: flags['collector-only'] === true,
      relayRoundtrip: flags['relay-roundtrip'] === true,
      restartInject: flags['restart-inject'] === true,
    });
  }
  if (command === 'dry-run') {
    if (positionals.length !== 0) throw usageError('dry-run does not accept positional arguments');
    const mode = flags.mode ?? 'inspection';
    if (mode !== 'inspection' && mode !== 'production') {
      throw usageError('dry-run --mode must be inspection or production');
    }
    return Object.freeze({
      command,
      statePathOverride: flags.state ?? null,
      noDashboard: false,
      cycleId: null,
      mode,
      operatorArgv: null,
    });
  }
  if (command === 'preflight') {
    if (positionals.length !== 0) throw usageError('preflight does not accept positional arguments');
    return Object.freeze({
      command,
      statePathOverride: flags.state ?? null,
      noDashboard: false,
      cycleId: null,
      operatorArgv: null,
    });
  }
  if (command === 'resume' || command === 'abort-cycle') {
    if (positionals.length !== 1 || positionals[0].startsWith('--')) throw usageError(`${command} requires one cycleId`);
    if (command === 'abort-cycle' && (!flags.reason || flags.reason.length > 512 || /[\u0000-\u001f\u007f]/.test(flags.reason))) {
      throw usageError('abort-cycle requires a bounded printable --reason');
    }
    return Object.freeze({
      command,
      statePathOverride: flags.state ?? null,
      cycleId: positionals[0],
      reason: flags.reason ?? null,
    });
  }
  if (positionals.length !== 0) throw usageError(`${command} does not accept positional arguments`);
  return Object.freeze({
    command,
    statePathOverride: flags.state ?? null,
    noDashboard: flags['no-dashboard'] === true,
    cycleId: flags.cycle ?? null,
    operatorArgv: null,
  });
}

/** Reads the dashboard-only subset of `HOOKEMON_DASHBOARD_*` (via packages/dashboard/src/server.mjs's
 * own `readEnvironmentConfig`, so the two entrypoints never hand-maintain two copies of the same
 * validation) and reshapes it into `compose.mjs`'s `config.dashboard` input. The dashboard's own
 * `statePath`/`stateDir` fields are deliberately dropped here — compose.mjs always composes the
 * dashboard against the *scheduler's* resolved `statePath`/`cycleRepository` (this command's own
 * `--state` override included), never a second, independently-derived path. */
async function readDashboardConfig() {
  const { readEnvironmentConfig: readDashboardEnvironmentConfig } = await import('../../dashboard/src/server.mjs');
  const dashboardEnv = readDashboardEnvironmentConfig(process.env);
  return {
    profileId: dashboardEnv.profileId,
    proxyCredential: dashboardEnv.proxyCredential,
    port: dashboardEnv.port,
    sqlitePath: dashboardEnv.sqlitePath,
    auditLogPath: dashboardEnv.auditLogPath,
    access: dashboardEnv.access,
  };
}

/** `run` logs every scheduler tick outcome to stderr so an operator watching the terminal can see
 * whether a tick started a cycle, what it did, or why it failed. Secrets never appear in tick events. */
function logTick(event) {
  const base = `[hookemon-runner] tick ${event.tick} ${event.type} paused=${event.paused} liveMode=${event.liveMode} at=${new Date(event.at).toISOString()}`;
  if (event.error) {
    process.stderr.write(`${base}\n  ${event.error?.stack ?? event.error?.message ?? String(event.error)}\n`);
    return;
  }
  const result = event.result === undefined ? '' : `\n  result: ${JSON.stringify(event.result, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
  process.stderr.write(`${base}${result}\n`);
}

function resolveStatePath(env, statePathOverride) {
  const statePath = statePathOverride ?? `${env.stateDir}/operator-state.json`;
  if (!isAbsolute(statePath)) throw new Error('--state must be an absolute path');
  return statePath;
}

function keychainReadinessSigners(readiness) {
  if (readiness === null) return null;
  const signers = {};
  for (const role of ['operator-evm', 'operator-solana']) {
    if (readiness[role] !== undefined) {
      signers[role] = Object.freeze({ probe: async () => readiness[role] });
    }
  }
  return Object.freeze(signers);
}

async function assertRepositoryIntegrityAt(stateDir) {
  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const cycleIds = await repository.listKnownCycleIds();
  for (const cycleId of cycleIds) await repository.describeCycle(cycleId);
  return Object.freeze({ cycleCount: cycleIds.length });
}

function compositionInput({
  env,
  statePath,
  dashboard,
  signerClient,
  signerReadiness,
  rehearsalCapMicroUsd,
  rehearsalSessionId,
  restartInjector,
  operatorAuditLogPath,
  logTicks,
}) {
  const standingAuthority = loadStandingAuthority(env);
  return {
    stateDir: env.stateDir,
    statePath,
    workerOwner: env.workerOwner,
    leaseTtlMs: env.leaseTtlMs,
    defaultIntervalMs: env.defaultIntervalMs,
    chainId: env.chainId,
    robinhood: env.robinhood,
    solana: env.solana,
    relay: env.relay,
    relayQuoteValidityMs: env.relayQuoteValidityMs,
    nativePaymentBindingPath: env.nativePaymentBindingPath,
    ...(env.now ? { now: env.now } : {}),
    collectorCrypt: env.collectorCrypt,
    ...(env.collectorProductionBindingRegistry === undefined ? {} : { collectorProductionBindingRegistry: env.collectorProductionBindingRegistry }),
    // Forwarded so `../signing/collector-production-binding.mjs`'s offline execution boundary
    // (`config.signer.keychain.command`/`.isolatedChildSetup`/`.backend`/`.liveMode`, read by
    // `purchase.mjs`/`buyback.mjs` at stage-mutation time) actually reaches the composed stage
    // config in an ordinary CLI launch -- previously this function only forwarded the already
    // constructed `signerClient` object, never the raw `env.signer` configuration itself.
    signer: env.signer,
    contracts: env.contracts,
    accounts: env.accounts,
    budget: env.budget,
    pack: env.pack,
    minimums: env.minimums,
    nativeGasCaps: env.nativeGasCaps,
    moneyConfiguration: env.moneyConfiguration,
    hkmn: env.hkmn,
    eligibilitySnapshot: env.eligibilitySnapshot,
    distribution: env.distribution,
    rehearsal: env.rehearsal,
    execution: {
      ...env.execution,
      rehearsalCapMicroUsd,
      ...(rehearsalSessionId === null ? {} : { rehearsalSessionId }),
      enforceProfile: true,
    },
    observability: env.observability,
    signerClient,
    signerReadiness,
    standingAuthority,
    ...(standingAuthority?.resolveStepAuthorization === undefined
      ? {}
      : { standingAuthorityStepAuthorization: standingAuthority.resolveStepAuthorization }),
    dashboard,
    ...(operatorAuditLogPath === undefined ? {} : { operatorAuditLogPath }),
    ...(restartInjector === null ? {} : { restartInjector }),
    ...(logTicks ? { onTick: logTick } : {}),
  };
}

/**
 * The chain RPC transports that actually broadcast already-authorized signed bytes.
 *
 * The keychain command is sign-only and refuses a broadcast verb, so without these a live cycle
 * signs and can never send. Supplying them also narrows the signer: the bare broadcast() is replaced
 * by a path reachable only through a genuine transaction-policy evaluation proof, so holding a
 * reference to the client is not enough to send arbitrary bytes.
 *
 * Under the `synthetic-offline` authority these are the same actual signed-byte send clients
 * `compose.mjs`'s own `buildAdapters` confines -- an already-loopback `rpcUrl` alone does not stop
 * a misbehaving local mock from handing either client an outward-pointing 3xx, so both get the same
 * `createLoopbackConfinedFetch` wrapper, via viem's `http(url, {fetchFn})` transport for the EVM
 * client and `fetchImpl` directly for the Solana client. Non-synthetic env is unaffected: no
 * confinement is threaded in unless the authority is explicitly synthetic-offline.
 */
function chainBroadcastTransports(env) {
  const offlineTransportFetch = env.collectorCrypt?.productionBindingAuthority === COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE
    ? createLoopbackConfinedFetch()
    : null;
  const transports = {};
  if (env.robinhood?.rpcUrl) {
    const client = createRobinhoodClient({
      rpcUrl: env.robinhood.rpcUrl,
      ...(offlineTransportFetch === null ? {} : { transport: http(env.robinhood.rpcUrl, { fetchFn: offlineTransportFetch }) }),
    });
    transports.evm = async signed => {
      const serialized = typeof signed === 'string' ? signed : signed?.signedTx;
      return { transactionHash: await sendRawTransaction(client, serialized) };
    };
  }
  if (env.solana?.rpcUrl) {
    const client = createSolanaRpcClient({
      rpcUrl: env.solana.rpcUrl,
      ...(offlineTransportFetch === null ? {} : { fetchImpl: offlineTransportFetch }),
    });
    transports.solana = async signed => {
      const serialized = typeof signed === 'string' ? signed : signed?.signedTxBase64 ?? signed?.signedTx;
      return { signature: await submitSignedTransaction(client, serialized) };
    };
  }
  return transports;
}

/**
 * The ordinary runner entrypoint's own construction of its process-local branded isolated child
 * setup, applied before this same `env` is ever composed -- not a test overlay. Reused, unmodified,
 * as the one call site `buildComposition` (the real production/dry-run/rehearsal-adjacent path) and
 * this function's own focused tests both drive.
 *
 * When `env.collectorCrypt.productionBindingAuthority` is not the synthetic-offline authority, `env`
 * is returned unchanged. Otherwise `createIsolatedKeychainChildSetup({ directory:
 * env.collectorCrypt.syntheticRoot })` is called -- reusing the same isolated root across a
 * stopped/restarted process reopens the ephemeral identities and wrapper already provisioned there
 * rather than minting a replacement pair on every launch (see that function's own header) -- and its
 * result overrides `signer.keychain.command`/`.isolatedChildSetup`. `HOOKEMON_KEYCHAIN_COMMAND` is
 * never trusted for this authority: the constructed wrapper's own path always wins.
 */
async function applySyntheticIsolatedChildSetup(env) {
  if (env.collectorCrypt?.productionBindingAuthority !== COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE) {
    return env;
  }
  const isolatedChildSetup = await createIsolatedKeychainChildSetup({ directory: env.collectorCrypt.syntheticRoot });
  return {
    ...env,
    signer: {
      ...env.signer,
      keychain: { ...env.signer.keychain, command: isolatedChildSetup.command, isolatedChildSetup },
    },
  };
}

async function buildComposition({
  statePathOverride,
  withDashboard = false,
  logTicks = false,
  profile = 'inspection',
  rehearsalCapMicroUsd = null,
  rehearsalSessionId = null,
  restartInjector = null,
  operatorAuditLogPath = undefined,
  constructSigner = true,
  dryRun = false,
  environmentConfig = null,
} = {}) {
  if (typeof dryRun !== 'boolean') throw new Error('buildComposition dryRun must be a boolean');
  if (dryRun && profile !== 'production') throw new Error('buildComposition dryRun requires the production profile');
  const env = await priceCollectorOnlyConfig(await applySyntheticIsolatedChildSetup(environmentConfig ?? readEnvironment(process.env, { profile, dryRun })));
  const statePath = resolveStatePath(env, statePathOverride);
  const dashboard = withDashboard ? await readDashboardConfig() : null;
  const { compose } = await import('../src/app/compose.mjs');

  if (profile === 'inspection' || dryRun) {
    return compose(compositionInput({
      env,
      statePath,
      dashboard,
      signerClient: null,
      signerReadiness: null,
      rehearsalCapMicroUsd,
      rehearsalSessionId,
      restartInjector,
      operatorAuditLogPath,
      logTicks,
    }));
  }

  await assertRepositoryIntegrityAt(env.stateDir);
  let readiness = null;
  if (env.signer.backend === 'keychain') {
    readiness = await probeKeychainOperations(env, { exec: createProcessExec() });
  }
  const readinessComposition = await compose(compositionInput({
    env,
    statePath,
    dashboard: null,
    signerClient: null,
    signerReadiness: keychainReadinessSigners(readiness),
    rehearsalCapMicroUsd,
    rehearsalSessionId,
    restartInjector,
    operatorAuditLogPath,
    logTicks: false,
  }));
  try {
    await readinessComposition.assertStartReadiness({
      liveMode: env.execution.providerMode === 'live',
      mode: profile,
      requirePolicyConfiguration: true,
      requireCanaryPreflight: true,
    });
  } finally {
    await readinessComposition.shutdown();
  }

  // Fake rehearsals have no transaction-capable signer. Live profiles construct the selected
  // Operations signer only after repository integrity, keychain readiness, and canary preflight passed.
  const signerClient = env.execution.providerMode === 'fake' || !constructSigner
    ? null
    : await loadOperatorSignerClient(env, {
      exec: createProcessExec(),
      broadcast: chainBroadcastTransports(env),
    });
  return compose(compositionInput({
    env,
    statePath,
    dashboard,
    signerClient,
    signerReadiness: keychainReadinessSigners(readiness),
    rehearsalCapMicroUsd,
    rehearsalSessionId,
    restartInjector,
    operatorAuditLogPath,
    logTicks,
  }));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runRun(composition) {
  let dashboardServer = null;
  if (composition.dashboard) {
    dashboardServer = createHttpServer(composition.dashboard.listener);
    await new Promise((resolve, reject) => {
      dashboardServer.once('error', reject);
      dashboardServer.listen(composition.dashboard.port, () => {
        dashboardServer.removeListener('error', reject);
        resolve();
      });
    });
    process.stderr.write(`[hookemon-runner] dashboard listening on :${composition.dashboard.port} (profile=${composition.dashboard.ctx.profileId})\n`);
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    dashboardServer?.close();
    composition.shutdown().catch(error => {
      process.stderr.write(`${error?.stack ?? error?.message ?? String(error)}\n`);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  composition.scheduler.start();
  // Keep the process alive: the scheduler's own timers are unref'd by design (never keep a process
  // alive on their own — see scheduler.mjs), so this command holds an explicit ref'd interval until a
  // shutdown signal arrives.
  const keepAlive = setInterval(() => {}, 60_000);
  await new Promise(resolve => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
  clearInterval(keepAlive);
  await composition.scheduler.settled();
}

async function runDryRun(composition, emitJson = writeJson) {
  const result = await composition.service.runOnce({ liveMode: false });
  emitJson(result);
}

/** This owner-facing admission path deliberately constructs neither a scheduler nor a signer. */
async function runCollectorOnlyPreflight({ statePathOverride, environment = process.env, environmentConfig: suppliedConfig = null } = {}) {
  const environmentConfig = await priceCollectorOnlyConfig(suppliedConfig ?? readEnvironment(environment, { profile: 'rehearsal' }));
  const bundle = await loadCollectorPolicyBundle();
  const env = attachCollectorPolicyBundle(environmentConfig, bundle);
  assertCollectorPolicyBundleRuntimeReady(bundle);
  if (env.execution.providerMode !== 'live' || env.rehearsal?.mode !== 'collector-only') {
    throw new Error('preflight requires HOOKEMON_REHEARSAL_MODE=collector-only and HOOKEMON_PROVIDER_MODE=live');
  }
  const statePath = resolveStatePath(env, statePathOverride);
  const state = await readOperatorState(statePath);
  if (state.configuration === null) throw new Error('collector-only preflight refused: policy configuration is missing');
  const adapters = Object.freeze({
    collectorCrypt: createCollectorCryptClient({ apiKey: env.collectorCrypt.apiKey, baseUrl: env.collectorCrypt.baseUrl }),
    solana: Object.freeze({ client: createSolanaRpcClient({ rpcUrl: env.solana.rpcUrl }) }),
  });
  return runCollectorOnlyPreflightPlan({
    config: env,
    policyConfiguration: state.configuration,
    adapters,
    probeKeychain: () => probeKeychainOperations(env, { exec: createProcessExec() }),
  });
}

/** Fetches pricing only. The public release role is a quote coordinate, never live authority. */
export async function priceCollectorOnlyConfig(env, { fetchImpl = globalThis.fetch, now = env.now ?? Date.now } = {}) {
  if (env.execution?.profile !== 'rehearsal' || env.execution?.providerMode !== 'live'
    || env.rehearsal?.mode !== 'collector-only') return env;
  if (env.collectorCrypt?.packFundingUsd) {
    collectorOnlyPackCostMicroUsd(env);
    return env;
  }
  if (!Number.isSafeInteger(env.relayQuoteValidityMs) || env.relayQuoteValidityMs <= 0) {
    throw new Error('Collector USD pricing requires explicit HOOKEMON_RELAY_QUOTE_VALIDITY_MS');
  }
  const release = JSON.parse(await readFile(new URL('../../../release/phase3/launch-inputs.json', import.meta.url), 'utf8'));
  const recipient = release.roles?.operations;
  if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Collector USD quote requires the public Operations release role');
  const price = env.collectorCrypt?.packPrice;
  if (!price || price.decimals !== 6 || price.assetId !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') throw new Error('Collector USD quote requires exact settlement token identity');
  const amount = { chainId: '792703809', assetId: price.assetId, decimals: price.decimals, amountAtomic: price.amountAtomic };
  const relay = createRelayClient({ baseUrl: env.relay.baseUrl, quoteValidityMs: env.relayQuoteValidityMs, fetchImpl, now });
  const quote = await relay.quoteReturnBridge({ user: env.accounts.solana, recipient, amount: amount.amountAtomic,
    originCurrency: amount.assetId, skipRouteCheck: true });
  const packFundingUsd = createQuoteUsdValuation({ quote, side: 'origin', amount, rounding: 'up', nowMs: now() });
  const priced = { ...env, now, collectorCrypt: { ...env.collectorCrypt, packFundingUsd } };
  collectorOnlyPackCostMicroUsd(priced);
  return priced;
}

/** Creates the sealed first-use policy only when the dedicated rehearsal state does not exist. */
export async function initializeCollectorOnlyPolicy({
  statePathOverride,
  environment = process.env,
  readEnvironmentFn = readEnvironment,
  fetchImpl = globalThis.fetch,
  now,
} = {}) {
  const env = await priceCollectorOnlyConfig(readEnvironmentFn(environment, { profile: 'rehearsal' }), { fetchImpl, ...(now ? { now } : {}) });
  assertRehearsalProfile({ env, collectorOnly: true, relayRoundtrip: false });
  const packPriceAtomic = env.collectorCrypt?.packPrice?.amountAtomic;
  const packCostMicroUsd = collectorOnlyPackCostMicroUsd(env);
  assertLiveCollectorOnlyRunOptions({
    env,
    cycles: 1,
    capMicroUsd: packCostMicroUsd,
    restartInject: false,
  });
  const statePath = resolveStatePath(env, statePathOverride);
  const configurationPatch = Object.freeze({
    allowedPackIds: Object.freeze([env.pack.code]),
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: packCostMicroUsd,
    maxCycleBudgetMicroUsd: packCostMicroUsd,
    max24HourBudgetMicroUsd: packCostMicroUsd,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsd: packCostMicroUsd,
    lossCapMicroUsd: packCostMicroUsd,
    maxOutstandingCustodyMicroUsd: packCostMicroUsd,
    manualApprovalCycles: 1,
    liveMode: true,
  });
  const state = await mutateOperatorState(statePath, null, current => {
    if (current !== null) throw new Error('collector-only policy initializer only initializes an absent operator state');
    const configuration = applyOperatorConfiguration(null, configurationPatch);
    assertCollectorOnlyRehearsalPolicy(configuration, {
      packCode: env.pack.code,
      packPriceAtomic,
      packCostMicroUsd,
    });
    return { ...createEmptyOperatorState(), configuration };
  });
  return Object.freeze({
    action: 'initialize-collector-only-policy',
    revision: state.revision,
    configuration: state.configuration,
  });
}

async function runOperator(composition, operatorArgv, runComposedOperatorCli) {
  const execute = runComposedOperatorCli ?? (await import('../../runner/src/operator/cli.mjs')).runOperatorCli;
  if (typeof execute !== 'function') throw new Error('operator CLI dispatcher is required');
  return execute(operatorArgv, {
    operatorControl: composition.operatorControl,
    executeAudited: composition.executeAudited,
  });
}

async function openCycleRepository({ statePathOverride = null } = {}) {
  const env = readEnvironment();
  resolveStatePath(env, statePathOverride);
  const repository = await CycleRepository.open(join(env.stateDir, 'cycles'));
  return { env, repository };
}

async function runStatus({ statePathOverride, cycleId }) {
  const { repository } = await openCycleRepository({ statePathOverride });
  if (cycleId !== null) {
    const description = await repository.describeCycle(cycleId);
    writeJson({ status: 'CYCLE', ...projectCycleRepositoryStatus(description) });
    return;
  }
  const cycleIds = await repository.listKnownCycleIds();
  for (const knownCycleId of cycleIds) {
    const description = await repository.describeCycle(knownCycleId);
    if (!description.archived) {
      writeJson({ status: 'ACTIVE_CYCLE', ...projectCycleRepositoryStatus(description) });
      return;
    }
  }
  writeJson({ status: 'NO_ACTIVE_CYCLE' });
}

async function runAbortCycle({ statePathOverride, cycleId, reason }) {
  const { env, repository } = await openCycleRepository({ statePathOverride });
  const leaseStore = createFileLeaseStore(join(env.stateDir, 'lease.json'));
  const lease = acquireLease({ store: leaseStore, owner: env.workerOwner, now: Date.now(), ttlMs: env.leaseTtlMs });
  try {
    assertLeaseCurrent({ store: leaseStore, lease, now: Date.now() });
    const description = await repository.describeCycle(cycleId);
    if (description.archived) throw new Error('abort-cycle refuses an archived cycle');
    await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', { command: 'abort-cycle', reason }, {
      assertLease: () => assertLeaseCurrent({ store: leaseStore, lease, now: Date.now() }),
    });
    assertLeaseCurrent({ store: leaseStore, lease, now: Date.now() });
    writeJson({
      status: 'CYCLE_ABORTED',
      ...projectCycleRepositoryStatus(await repository.describeCycle(cycleId)),
    });
  } finally {
    releaseLease({ store: leaseStore, lease });
  }
}

async function runResume({ statePathOverride, cycleId }) {
  const { repository } = await openCycleRepository({ statePathOverride });
  const description = await repository.describeCycle(cycleId);
  const recovery = inspectCycleRecovery(description);
  if (!recovery.resumable) {
    writeJson({ status: 'RESUME_REFUSED', cycleId, reason: recovery.reason });
    return;
  }
  const env = readEnvironment(process.env, { profile: description.mode });
  if (description.providerMode !== 'live' && description.providerMode !== 'fake') {
    writeJson({ status: 'RESUME_REFUSED', cycleId, reason: 'CYCLE_PROVIDER_MODE_UNRESOLVED' });
    return;
  }
  if (env.execution.providerMode !== description.providerMode) {
    writeJson({ status: 'RESUME_REFUSED', cycleId, reason: 'CYCLE_PROVIDER_MODE_MISMATCH' });
    return;
  }
  const composition = await buildComposition({
    statePathOverride,
    withDashboard: false,
    profile: description.mode,
    rehearsalSessionId: description.rehearsalSessionId ?? null,
  });
  try {
    const result = await composition.service.recoverActiveCycle({
      liveMode: description.mode === 'production' || env.execution.providerMode === 'live',
      mode: description.mode,
    });
    writeJson(result);
  } finally {
    await composition.shutdown();
  }
}

export function assertRehearsalProfile({ env, collectorOnly, relayRoundtrip }) {
  const requested = collectorOnly ? 'collector-only' : relayRoundtrip ? 'relay-roundtrip' : null;
  if (requested === null) throw new Error('rehearsal requires one explicit profile flag');
  if (env.rehearsal?.mode !== requested) {
    throw new Error(`${requested} rehearsal flag does not match HOOKEMON_REHEARSAL_MODE`);
  }
  if (env.execution.providerMode === 'fake') return;
  if (env.execution.providerMode === 'live' && requested === 'collector-only') return;
  throw new Error(`${requested} rehearsal requires HOOKEMON_PROVIDER_MODE=fake`);
}

export function assertLiveCollectorOnlyRunOptions({ env, cycles, capMicroUsd, restartInject }) {
  const liveCollectorOnly = env?.execution?.providerMode === 'live' && env?.rehearsal?.mode === 'collector-only';
  if (!liveCollectorOnly) return false;
  if (cycles !== 1) throw new Error('live collector-only rehearsal requires exactly one cycle');
  if (restartInject === true) throw new Error('live collector-only rehearsal refuses restart injection');
  const packPrice = env.collectorCrypt?.packPrice?.amountAtomic;
  if (typeof packPrice !== 'string' || !/^(0|[1-9][0-9]*)$/.test(packPrice)) {
    throw new Error('live collector-only rehearsal requires a typed configured pack price');
  }
  if (capMicroUsd !== collectorOnlyPackCostMicroUsd(env)) throw new Error('live collector-only rehearsal requires the exact authenticated USD purchase cost cap');
  return true;
}

function assertRehearsalSessionMatches(session, { cycles, capMicroUsd, collectorOnly }) {
  if (session.cycles !== cycles || session.capMicroUsd !== capMicroUsd || session.collectorOnly !== collectorOnly) {
    throw new Error('rehearsal restart session does not match the requested run');
  }
}

async function repairCompletedSessionCycles({ composition, stateDir, sessionPath }) {
  let session = await readRehearsalSession({ path: sessionPath });
  for (const cycleId of await composition.cycleRepository.listKnownCycleIds()) {
    const description = await composition.cycleRepository.describeCycle(cycleId);
    if (description.rehearsalSessionId !== session.sessionId || description.completed !== true) continue;
    const evidence = collectRehearsalEvidence(description);
    const evidencePath = await ensureRehearsalEvidence({ stateDir, evidence });
    if (!session.completed.some(entry => entry.cycleId === cycleId)) {
      session = await recordRehearsalSessionCompletion({ path: sessionPath, cycleId, evidencePath });
    }
  }
  return session;
}

export async function buildManualApprovalHandoff({ composition, env, statePath }) {
  const active = await composition.cycleRepository.readActiveCycle();
  const liveCollectorOnly = active?.mode === 'rehearsal'
    && active.providerMode === 'live'
    && env.execution?.providerMode === 'live'
    && env.rehearsal?.mode === 'collector-only';
  const fakeRehearsal = active?.mode === 'rehearsal' && active.providerMode === 'fake';
  if (!fakeRehearsal && !liveCollectorOnly) {
    throw new Error('manual approval handoff requires an active fake rehearsal or live collector-only cycle');
  }
  const state = await readOperatorState(statePath);
  if (state.configuration === null) throw new Error('manual approval handoff requires a persisted policy configuration');
  if (env.pack?.code === null || env.pack?.code === undefined) throw new Error('manual approval handoff requires a configured pack');
  const cycleDigest = deriveCyclePolicyDigest({
    configuration: state.configuration,
    cycleId: active.cycleId,
    releaseAmountWei: active.releaseAmount,
    releaseCostMicroUsd: active.admission?.aggregateFundingUsd?.amountMicroUsd ?? collectorOnlyPackCostMicroUsd(env),
    ...(active.admission ? { admission: active.admission } : {}),
    packId: env.pack.code,
    liveMode: liveCollectorOnly,
    mode: 'rehearsal',
  });
  return Object.freeze({ status: 'AWAITING_MANUAL_APPROVAL', cycleId: active.cycleId, cycleDigest });
}

export async function runRehearsal({ statePathOverride, cycles, capMicroUsd, collectorOnly, relayRoundtrip, restartInject }, {
  environment = process.env,
  readEnvironmentFn = readEnvironment,
  runCollectorOnlyPreflightFn = runCollectorOnlyPreflight,
  buildCompositionFn = buildComposition,
  fetchImpl = globalThis.fetch,
} = {}) {
  const env = await priceCollectorOnlyConfig(readEnvironmentFn(environment, { profile: 'rehearsal' }), { fetchImpl });
  assertRehearsalProfile({ env, collectorOnly, relayRoundtrip });
  const liveCollectorOnly = assertLiveCollectorOnlyRunOptions({ env, cycles, capMicroUsd, restartInject });
  if (liveCollectorOnly) {
    await runCollectorOnlyPreflightFn({ statePathOverride, environment, environmentConfig: env });
  }
  const statePath = resolveStatePath(env, statePathOverride);
  const sessionPath = restartInject ? environment[REHEARSAL_SESSION_PATH_ENV] ?? null : null;
  let session = sessionPath === null ? null : await readRehearsalSession({ path: sessionPath });
  const localCompleted = [];
  if (session !== null) assertRehearsalSessionMatches(session, { cycles, capMicroUsd, collectorOnly });
  const completed = () => session === null ? localCompleted : session.completed;

  while (completed().length < cycles) {
    const restartInjector = restartInject
      ? async () => { throw new RehearsalRestartInjectedError(); }
      : null;
    const composition = await buildCompositionFn({
      environmentConfig: env,
      statePathOverride,
      withDashboard: false,
      profile: 'rehearsal',
      rehearsalCapMicroUsd: capMicroUsd,
      rehearsalSessionId: session?.sessionId ?? null,
      restartInjector,
    });
    try {
      if (session !== null) {
        session = await repairCompletedSessionCycles({ composition, stateDir: env.stateDir, sessionPath });
        if (session.state === 'COMPLETE') break;
      }
      const result = await composition.service.runOnce({
        liveMode: liveCollectorOnly,
        mode: 'rehearsal',
      });
      if (result.status !== 'COMPLETE') {
        throw new Error(`rehearsal cycle did not complete: ${result.status}`);
      }
      const description = await composition.cycleRepository.describeCycle(result.cycleId);
      const evidence = collectRehearsalEvidence(description);
      const evidencePath = await ensureRehearsalEvidence({ stateDir: env.stateDir, evidence });
      if (session === null) {
        localCompleted.push(Object.freeze({ cycleId: result.cycleId, evidencePath }));
      } else {
        session = await recordRehearsalSessionCompletion({ path: sessionPath, cycleId: result.cycleId, evidencePath });
      }
    } catch (error) {
      if (error instanceof PolicyRefusalError && error.reason === 'MANUAL_APPROVAL_REQUIRED') {
        writeJson(await buildManualApprovalHandoff({ composition, env, statePath }));
        return;
      }
      throw error;
    } finally {
      await composition.shutdown();
    }
  }
  writeJson({ mode: 'rehearsal', capMicroUsd, restartCount: session?.restartCount ?? 0, cycles: completed() });
}

function rehearsalWorkerArgs({ statePathOverride, cycles, capMicroUsd, collectorOnly, relayRoundtrip }) {
  return [
    'run', '--mode', 'rehearsal', '--cycles', String(cycles), '--cap-micro-usd', capMicroUsd,
    ...(collectorOnly ? ['--collector-only'] : relayRoundtrip ? ['--relay-roundtrip'] : []),
    '--restart-inject',
    ...(statePathOverride === null ? [] : ['--state', statePathOverride]),
  ];
}

function runRehearsalWorker({ argv, sessionPath }) {
  const runnerPath = resolvePath(process.argv[1] ?? '');
  if (!isAbsolute(runnerPath)) throw new Error('rehearsal restart worker cannot resolve the runner entrypoint');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ...argv], {
      env: {
        ...process.env,
        [REHEARSAL_RESTART_WORKER_ENV]: '1',
        [REHEARSAL_SESSION_PATH_ENV]: sessionPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

export async function runRehearsalSupervisor(parsed, {
  readEnvironmentFn = readEnvironment,
  openSessionFn = openOrCreateRehearsalSession,
  recordRestartFn = recordRehearsalSessionRestart,
  runWorkerFn = runRehearsalWorker,
  writeStdout = value => process.stdout.write(value),
} = {}) {
  const env = readEnvironmentFn(process.env, { profile: 'rehearsal' });
  assertRehearsalProfile({
    env,
    collectorOnly: parsed.collectorOnly,
    relayRoundtrip: parsed.relayRoundtrip,
  });
  assertLiveCollectorOnlyRunOptions({
    env,
    cycles: parsed.cycles,
    capMicroUsd: parsed.capMicroUsd,
    restartInject: true,
  });
  const session = await openSessionFn({
    stateDir: env.stateDir,
    cycles: parsed.cycles,
    capMicroUsd: parsed.capMicroUsd,
    collectorOnly: parsed.collectorOnly,
  });
  const argv = rehearsalWorkerArgs(parsed);
  while (true) {
    const outcome = await runWorkerFn({ argv, sessionPath: session.path });
    if (outcome.code === REHEARSAL_RESTART_EXIT_CODE) {
      await recordRestartFn({ path: session.path });
      continue;
    }
    if (outcome.code !== 0) {
      throw new Error(`rehearsal restart worker failed${outcome.stderr.length > 0 ? `: ${outcome.stderr.trim()}` : ''}`);
    }
    if (outcome.stdout.length > 0) writeStdout(outcome.stdout);
    return;
  }
}
async function runComposedStatus(composition, emitJson = writeJson) {
  if (!composition?.cycleRepository || typeof composition.cycleRepository.peekActiveCycle !== 'function') {
    throw new Error('composed cycle repository peekActiveCycle is required');
  }
  const active = await composition.cycleRepository.peekActiveCycle();
  if (!active) {
    emitJson({ status: 'NO_ACTIVE_CYCLE' });
    return;
  }
  const description = await composition.cycleRepository.describeCycle(active.cycleId);
  emitJson({
    status: 'ACTIVE_CYCLE',
    cycleId: description.cycleId,
    releaseAmount: description.releaseAmount,
    stages: Object.fromEntries(description.stages),
    completed: description.completed,
  });
}

export async function runCli(argv, options = {}) {
  const composeRuntime = options.buildComposition ?? buildComposition;
  const runComposedOperatorCli = options.runComposedOperatorCli;
  const emitJson = options.emitJson ?? writeJson;
  const environment = options.environment ?? process.env;
  const runRehearsalFn = options.runRehearsalFn ?? runRehearsal;
  const runRehearsalSupervisorFn = options.runRehearsalSupervisorFn ?? runRehearsalSupervisor;
  const runCollectorOnlyPreflightFn = options.runCollectorOnlyPreflightFn ?? runCollectorOnlyPreflight;
  const initializeCollectorOnlyPolicyFn = options.initializeCollectorOnlyPolicyFn ?? initializeCollectorOnlyPolicy;
  const parsed = parseArgv(argv);
  if (parsed.invalidCommand) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = parsed.command ? 1 : 0;
    return;
  }
  if (parsed.command === 'tick') {
    throw new Error('the unaudited tick command is prohibited; use an audited operator run-cycle-now command');
  }
  const {
    command,
    statePathOverride,
    noDashboard,
    cycleId,
    operatorArgv,
  } = parsed;
  if (command === 'status' && !Object.hasOwn(options, 'buildComposition')) {
    await runStatus({ statePathOverride, cycleId });
    return;
  }
  if (command === 'abort-cycle') {
    await runAbortCycle(parsed);
    return;
  }
  if (command === 'preflight') {
    emitJson(await runCollectorOnlyPreflightFn({ statePathOverride }));
    return;
  }
  if (command === 'resume') {
    await runResume(parsed);
    return;
  }
  if (command === 'operator' && operatorArgv.length === 1 && operatorArgv[0] === 'initialize-collector-only-policy') {
    emitJson(await initializeCollectorOnlyPolicyFn({ statePathOverride, environment }));
    return;
  }
  if (command === 'run' && parsed.mode === 'rehearsal') {
    if (parsed.restartInject && process.env[REHEARSAL_RESTART_WORKER_ENV] !== '1') {
      await runRehearsalSupervisorFn(parsed);
    } else {
      await runRehearsalFn(parsed);
    }
    return;
  }
  const productionDryRun = command === 'dry-run' && parsed.mode === 'production';
  const profile = (command === 'run' && parsed.mode === 'production') || productionDryRun
    ? 'production'
    : 'inspection';
  const operatorAuditLogPath = command === 'operator'
    ? environment?.HOOKEMON_DASHBOARD_AUDIT_LOG_PATH
    : undefined;
  const composition = await composeRuntime({
    statePathOverride,
    withDashboard: command === 'run' && !noDashboard,
    logTicks: command === 'run',
    ...(command === 'operator' || command === 'status' ? {} : { profile }),
    ...(productionDryRun ? { dryRun: true } : {}),
    ...(operatorAuditLogPath === undefined ? {} : { operatorAuditLogPath }),
  });
  try {
    if (command === 'run') await runRun(composition);
    else if (command === 'dry-run') await runDryRun(composition, emitJson);
    else if (command === 'operator') emitJson(await runOperator(composition, operatorArgv, runComposedOperatorCli));
    else await runComposedStatus(composition, emitJson);
  } finally {
    // "run" already shut itself down (dashboard included) from inside its own SIGINT/SIGTERM handler
    // by the time this resolves; every other command has no long-lived listener to close but still
    // owns durable-store/lease-store handles this closes here.
    if (command !== 'run') await composition.shutdown();
  }
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(resolvePath(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runCli(process.argv.slice(2)).catch(error => {
    if (error instanceof RehearsalRestartInjectedError && process.env[REHEARSAL_RESTART_WORKER_ENV] === '1') {
      process.exitCode = REHEARSAL_RESTART_EXIT_CODE;
      return;
    }
    process.stderr.write(`${error?.stack ?? error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
