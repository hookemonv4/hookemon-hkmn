// The production composition root: wires the real scheduler (packages/runner/src/scheduler), the
// real automation service (packages/runner/src/automation/automated-cycle-service.mjs), the durable
// cycle repository and on-disk lease store (this directory), and the real provider adapters
// (packages/adapters/src) into one object a CLI or test can drive. Every dependency comes from the
// explicit `config` object this module is called with — no file path, RPC URL, or credential is ever
// hardcoded here; see environment.mjs for how `config` is normally built from the process
// environment, and packages/adapters/README.md for the injected-transport pattern tests use instead.
import { join } from 'node:path';

import { AutomatedCycleService } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { createPolicyEngine } from '../../../runner/src/automation/policy-engine.mjs';
import { createRehearsalStageDriver } from '../../../runner/src/cycle/rehearsal-stage-driver.mjs';
import { collectRehearsalEvidence, ensureRehearsalEvidence } from '../../../runner/src/cycle/rehearsal-evidence.mjs';
import { createOperatorControl } from '../../../runner/src/operator/control.mjs';
import { inspectCycleRecovery } from '../../../runner/src/operator/cli.mjs';
import { createScheduler } from '../../../runner/src/scheduler/scheduler.mjs';
import { mutateOperatorState, readOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { createRequestListener } from '../../../dashboard/src/server.mjs';
import { openSqliteProjection } from '../../../dashboard/src/storage/sqlite-projection.mjs';
import { executeAuditedCommand, readAllAuditEntries, verifyAuditChain } from '../../../dashboard/src/auth/audit-log.mjs';
import { createAccessJwtVerifier } from '../../../dashboard/src/auth/access-jwt.mjs';
import { assertProxyCredentialConfigured } from '../../../dashboard/src/auth/proxy-credential.mjs';
import { readDashboardProfile } from '../../../dashboard/src/contracts/dashboard-profile.mjs';
import { createCollectorCryptClient } from '../collector-crypt.mjs';
import { createRelayClient } from '../relay-client.mjs';
import { createHistoricalErc20EvidenceClient, createRobinhoodClient, readChainId } from '../robinhood-rpc.mjs';
import { createSolanaRpcClient } from '../solana-rpc.mjs';
import {
  assertCycleRepositoryInterface,
  createCycleRepositoryClient,
  createCycleRepositoryRunner,
  CycleRepository,
} from './cycle-repository.mjs';
import { createFileLeaseStore } from './lease-store.mjs';
import { createObservability } from './observability.mjs';
import { createStageDriver } from './stage-driver.mjs';
import { projectCycleAccounting, projectPolicyCustody } from './accounting-projection.mjs';
import { MoneyConfigurationRejected, validateMoneyConfiguration } from './environment.mjs';

export { validateMoneyConfiguration } from './environment.mjs';

const decimalPattern = /^(0|[1-9][0-9]*)$/;
const solanaGenesisHashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

function assertDecimal(value, label) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new Error(`${label} must be a canonical unsigned decimal string`);
}

function resolveMoneyConfiguration(value, execution) {
  if (value === null || value === undefined) {
    if (execution.profile === 'inspection') return null;
    throw new MoneyConfigurationRejected('compose requires MoneyConfigurationV1 outside inspection');
  }
  return validateMoneyConfiguration(value);
}

const missingStateFileMessage = 'operator state file does not exist';

function emptyPolicyCustody({ unvaluedExposure = false } = {}) {
  return Object.freeze({
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    unattributed: false,
    unvaluedExposure,
    cycles: Object.freeze([]),
  });
}

function configuredEvmUsdgAsset(config) {
  const chainId = config.chainId;
  const address = config.contracts?.usdg;
  const decimals = config.contracts?.usdgDecimals;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)
    || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return null;
  }
  const normalizedAddress = address.toLowerCase();
  return Object.freeze({
    chainId: `eip155:${chainId}`,
    assetId: `eip155:${chainId}/erc20:${normalizedAddress}`,
    decimals,
  });
}

async function readPolicyConfiguration(statePath) {
  try {
    return (await readOperatorState(statePath)).configuration;
  } catch (error) {
    if (error?.message === missingStateFileMessage) return null;
    throw error;
  }
}

function retryablePolicyStateError(error) {
  return error?.message === 'stale operator state revision' || error?.message === 'operator state lock contention';
}

async function mutatePolicyConfiguration({ statePath, mutation, expectedRevision = undefined }) {
  if (expectedRevision !== undefined && expectedRevision !== null
    && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error('policy configuration expected revision is invalid');
  }
  const attempts = expectedRevision === undefined ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readOperatorState(statePath).catch(error => {
      if (error?.message === missingStateFileMessage) return null;
      throw error;
    });
    if (state === null || state.configuration === null) throw new Error('policy configuration is missing');
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new Error('stale operator state revision');
    }
    let result;
    try {
      await mutateOperatorState(statePath, expectedRevision ?? state.revision, async current => {
        if (current === null || current.configuration === null) throw new Error('policy configuration is missing');
        const outcome = await mutation(current.configuration);
        if (!outcome || typeof outcome !== 'object' || !Object.hasOwn(outcome, 'configuration') || !Object.hasOwn(outcome, 'result')) {
          throw new Error('policy configuration mutation returned an invalid outcome');
        }
        result = outcome.result;
        return { ...current, configuration: outcome.configuration };
      });
      return result;
    } catch (error) {
      if (expectedRevision !== undefined || !retryablePolicyStateError(error) || attempt === attempts - 1) throw error;
    }
  }
  throw new Error('policy configuration mutation retry loop was exhausted');
}

function buildPolicyCustodyReader({ config, cycleRepository }) {
  const evmUsdg = configuredEvmUsdgAsset(config);
  if (evmUsdg === null) return async () => emptyPolicyCustody({ unvaluedExposure: true });
  return async () => projectPolicyCustody({ cycleRepository, evmUsdg });
}

function operatorAuditResultCode(command, status) {
  if (command?.type === 'run-cycle-now') return 'TICK_TRIGGERED';
  if (command?.type === 'resume-cycle') {
    return status?.activeCycleId === null ? 'RECOVERY_NO_ACTIVE_CYCLE' : 'RECOVERY_DISPATCHED';
  }
  if (command?.type === 'reconcile') return 'RECONCILIATION_DISPATCHED';
  return 'DECISION_ACCEPTED';
}

/** Builds the dashboard request context in-process, beside the scheduler. The injected
 * `operatorControl` owns every operation through the scheduler's writable repository, policy
 * engine, and state file. The dashboard receives only a frozen read-only client over that same
 * repository, so it cannot create a second lifecycle store or turn reconciliation into recovery.
 *
 * @param {object} input
 * @param {object} input.dashboardConfig - `{ profileId, proxyCredential, port, sqlitePath,
 *   auditLogPath, access }` (see `resolveDashboardConfig`).
 * @param {object} input.cycleRepository - a frozen read-only client over the repository the
 * scheduler uses.
 * @param {number} input.chainId - the runner's validated EVM chain ID.
 * @param {object} input.operatorControl - the composed runner control authority.
 * @param {() => {at: number, intervalMs: number}|null} input.readLastTick
 */
function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function buildDashboardIdentities(config) {
  const contracts = config.contracts ?? {};
  const accounts = config.accounts ?? {};
  const signer = config.signer ?? {};
  const distribution = config.distribution ?? {};
  return Object.freeze({
    treasuryAddress: nullableString(contracts.treasury),
    vaultAddress: nullableString(contracts.vault),
    hookAddress: nullableString(contracts.hook),
    hkmnAddress: nullableString(config.hkmn?.address),
    poolAddress: nullableString(contracts.pool),
    evmAccount: nullableString(accounts.evm),
    solanaAccount: nullableString(accounts.solana),
    signerBackend: nullableString(signer.backend),
    distributionProfile: nullableString(distribution.profile),
    distributionSignerAddress: nullableString(distribution.signerAddress),
    distributionVerifierAddress: nullableString(distribution.verifierAddress),
    collectorCryptConfigured: Boolean(config.collectorCrypt?.apiKey),
    relayConfigured: Boolean(config.relay?.apiKey),
    rehearsalMode: nullableString(config.rehearsal?.mode),
  });
}

async function composeDashboard({ dashboardConfig, chainId, cycleRepository, operatorControl, readLastTick, adapters, identities }) {
  const auditVerification = await verifyAuditChain(dashboardConfig.auditLogPath);
  if (!auditVerification.valid) {
    throw new Error(`compose dashboard audit chain is invalid at sequence ${auditVerification.brokenAtSequence}: ${auditVerification.reason}`);
  }
  const sqliteProjection = openSqliteProjection(dashboardConfig.sqlitePath);
  const auditEntries = await readAllAuditEntries(dashboardConfig.auditLogPath);
  sqliteProjection.rebuildAuditProjection(auditEntries);

  const accessJwtVerifier = dashboardConfig.access
    ? createAccessJwtVerifier({
      jwksUrl: dashboardConfig.access.jwksUrl,
      issuer: dashboardConfig.access.issuer,
      audience: dashboardConfig.access.audience,
    })
    : undefined;

  const ctx = {
    profileId: dashboardConfig.profileId,
    chainId,
    proxyCredential: dashboardConfig.proxyCredential,
    cycleRepository,
    operatorControl,
    sqliteProjection,
    auditLogPath: dashboardConfig.auditLogPath,
    accessJwtVerifier,
    lastTick: readLastTick,
    listPacks: adapters.collectorCrypt
      ? async () => adapters.collectorCrypt.getMachines()
      : null,
    identities,
    // Real per-cycle accounting (routes/public.mjs's `ctx.readAccounting` seam, threaded through
    // status-projection.mjs's own `readAccounting` parameter) — see accounting-projection.mjs's own
    // header for exactly which fields this can and cannot honestly report today.
    async readAccounting(cycleId) {
      return projectCycleAccounting({ cycleRepository, cycleId });
    },
    onError(route, error) {
      // eslint-disable-next-line no-console -- this composition has no injected logger seam; stderr
      // is the whole observability story for a dependency-free node:http process.
      console.error(`[dashboard] ${route} failed:`, error);
    },
    async close() {
      sqliteProjection.close();
    },
  };

  return {
    ctx,
    port: dashboardConfig.port,
    listener: createRequestListener(ctx),
    async close() {
      await ctx.close();
    },
  };
}

/** Fills in the same defaults packages/dashboard/src/server.mjs's own `readEnvironmentConfig` uses
 * (`sqlitePath`/`auditLogPath` under `stateDir` unless overridden), and validates the proxy
 * credential the same fail-loud way. Returns `null` when `dashboardInput` itself is `null`/
 * `undefined` — the composition simply has no dashboard in that case (see `bin/hookemon-runner.mjs`'s
 * `--no-dashboard`). */
function resolveDashboardConfig(stateDir, dashboardInput, chainId) {
  if (dashboardInput === null || dashboardInput === undefined) return null;
  if (typeof dashboardInput !== 'object' || Array.isArray(dashboardInput)) throw new Error('compose config.dashboard must be an object or null');
  const {
    profileId = 'mainnet',
    proxyCredential,
    port = 8787,
    sqlitePath = join(stateDir, 'dashboard-projection.sqlite'),
    auditLogPath = join(stateDir, 'dashboard-audit.log'),
    access = null,
  } = dashboardInput;
  if (profileId !== 'testnet' && profileId !== 'mainnet') throw new Error('compose config.dashboard.profileId must be "testnet" or "mainnet"');
  const profileChainId = readDashboardProfile(profileId).network.evm.chainId;
  if (chainId !== profileChainId) {
    throw new Error(`compose dashboard profile ${profileId} does not match chain ${chainId} (${profileChainId} required)`);
  }
  assertProxyCredentialConfigured(proxyCredential);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('compose config.dashboard.port must be a valid port number');
  if (access !== null) {
    if (typeof access !== 'object' || typeof access.jwksUrl !== 'string' || typeof access.issuer !== 'string' || typeof access.audience !== 'string') {
      throw new Error('compose config.dashboard.access must be {jwksUrl, issuer, audience} or null');
    }
  }
  return Object.freeze({ profileId, proxyCredential, port, sqlitePath, auditLogPath, access });
}

/** Resolve the one append-only audit ledger used by all local operator entry points. A dashboard
 * listener and the listener-free installed CLI may only coexist when they name the same ledger. */
function resolveOperatorAuditLogPath(stateDir, dashboardConfig, override) {
  if (override !== undefined && (typeof override !== 'string' || override.length === 0)) {
    throw new Error('compose config.operatorAuditLogPath must be a nonempty string when supplied');
  }
  if (dashboardConfig !== null && override !== undefined && override !== dashboardConfig.auditLogPath) {
    throw new Error('compose config.operatorAuditLogPath must match dashboard.auditLogPath');
  }
  return override ?? dashboardConfig?.auditLogPath ?? join(stateDir, 'dashboard-audit.log');
}

/** Real Collector Crypt / Relay / Robinhood / Solana clients from `config`, or `null` where the
 * operator has not supplied enough configuration to construct one — stage-driver.mjs's probes and
 * mutations both treat `null` as "not configured" rather than throwing at composition time, so a
 * partially-configured operator can still run a dry-run cycle against whichever adapters are ready.
 * Tests override any of these by passing pre-built fake-transport clients directly as
 * `config.adapters.*` instead (see packages/adapters/README.md's injected-transport pattern; every
 * existing adapter test uses `fetchImpl`/`transport` injection the same way). */
function archiveEvidenceClientFromConfig(config) {
  const archiveRpcUrl = config?.robinhood?.archiveRpcUrl;
  if (archiveRpcUrl === null || archiveRpcUrl === undefined) return null;
  if (typeof archiveRpcUrl !== 'string' || archiveRpcUrl.length === 0) {
    throw new Error('compose robinhood.archiveRpcUrl must be a nonempty URL when supplied');
  }
  if (archiveRpcUrl === config?.robinhood?.rpcUrl) {
    throw new Error('compose robinhood.archiveRpcUrl must be distinct from robinhood.rpcUrl');
  }
  return createHistoricalErc20EvidenceClient({
    client: createRobinhoodClient({ rpcUrl: archiveRpcUrl }),
  });
}

function buildAdapters(config) {
  const injectedEvidenceClient = config.historicalEvidenceClient;
  if (config.adapters) {
    const configuredEvidenceClient = config.adapters?.robinhood?.historicalEvidenceClient;
    if (injectedEvidenceClient !== undefined && configuredEvidenceClient !== undefined
      && injectedEvidenceClient !== configuredEvidenceClient) {
      throw new Error('compose historical evidence client conflicts with adapters.robinhood.historicalEvidenceClient');
    }
    const evidenceClient = injectedEvidenceClient ?? configuredEvidenceClient ?? archiveEvidenceClientFromConfig(config);
    if (evidenceClient === configuredEvidenceClient) return config.adapters;
    return {
      ...config.adapters,
      robinhood: {
        ...config.adapters.robinhood,
        historicalEvidenceClient: evidenceClient,
      },
    };
  }

  const fakeProvider = kind => Object.freeze({
    kind: 'hookemon.rehearsal-fake-provider.v1',
    async executeRehearsalEffect(effect) {
      if (!effect || typeof effect !== 'object' || effect.provider !== kind || typeof effect.effectId !== 'string') {
        throw new Error(`rehearsal fake ${kind} provider received an invalid effect`);
      }
      return Object.freeze({ provider: kind, effectId: effect.effectId });
    },
  });

  const collectorCrypt = config.execution?.providerMode === 'fake'
    ? fakeProvider('collector')
    : config.collectorCrypt.apiKey
    ? createCollectorCryptClient({ apiKey: config.collectorCrypt.apiKey, baseUrl: config.collectorCrypt.baseUrl })
    : null;
  const relay = config.execution?.providerMode === 'fake'
    ? fakeProvider('relay')
    : createRelayClient({ baseUrl: config.relay.baseUrl, apiKey: config.relay.apiKey ?? undefined });
  const robinhoodClient = createRobinhoodClient({ rpcUrl: config.robinhood.rpcUrl });
  const solanaClient = createSolanaRpcClient({ rpcUrl: config.solana.rpcUrl });
  const historicalEvidenceClient = injectedEvidenceClient ?? archiveEvidenceClientFromConfig(config);

  return {
    collectorCrypt,
    relay,
    robinhood: {
      client: robinhoodClient,
      ...(historicalEvidenceClient === null ? {} : { historicalEvidenceClient }),
    },
    solana: { client: solanaClient },
  };
}

/** The public Robinhood endpoint has verified latest-only state reads, so it is never a valid
 * source of historical settlement evidence. Production requires a separate archive-capable
 * client, either injected explicitly or built from the distinct configured archive endpoint. */
function assertProductionHistoricalEvidenceClient(adapters) {
  const publicClient = adapters?.robinhood?.client;
  const evidenceClient = adapters?.robinhood?.historicalEvidenceClient;
  if (!evidenceClient || typeof evidenceClient.readErc20BalanceAtBlock !== 'function') {
    throw new Error('compose production requires an archive-capable historical evidence client with readErc20BalanceAtBlock');
  }
  if (evidenceClient === publicClient) {
    throw new Error('compose historical evidence client must be distinct from the public Robinhood RPC client');
  }
  return evidenceClient;
}

function unavailableNetworkIdentity(network) {
  throw new Error(`compose ${network} network identity unavailable`);
}

function requireNetworkIdentity(value) {
  if (!value || typeof value.readEvmChainId !== 'function' || typeof value.readSolanaGenesisHash !== 'function') {
    unavailableNetworkIdentity('injected');
  }
  return value;
}

async function readSolanaGenesisHash(client) {
  if (!client || typeof client.rpcUrl !== 'string' || typeof client.fetchImpl !== 'function') {
    unavailableNetworkIdentity('Solana');
  }
  let response;
  try {
    response = await client.fetchImpl(
      client.rpcUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'compose-network-identity', method: 'getGenesisHash', params: [] }),
      },
      client.timeoutMs,
    );
  } catch {
    unavailableNetworkIdentity('Solana');
  }
  if (!response?.ok || typeof response.text !== 'function') unavailableNetworkIdentity('Solana');

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    unavailableNetworkIdentity('Solana');
  }
  if (payload?.error || typeof payload?.result !== 'string' || !solanaGenesisHashPattern.test(payload.result)) {
    unavailableNetworkIdentity('Solana');
  }
  return payload.result;
}

function networkIdentityFor(config, adapters) {
  if (config.networkIdentity !== undefined) return requireNetworkIdentity(config.networkIdentity);
  if (config.adapters) unavailableNetworkIdentity('injected');
  return Object.freeze({
    readEvmChainId: () => readChainId(adapters?.robinhood?.client),
    readSolanaGenesisHash: () => readSolanaGenesisHash(adapters?.solana?.client),
  });
}

async function assertNetworkIdentity({ config, adapters, profileId }) {
  const profile = readDashboardProfile(profileId);
  const identity = networkIdentityFor(config, adapters);
  let evmChainId;
  try {
    evmChainId = await identity.readEvmChainId();
  } catch {
    unavailableNetworkIdentity('EVM');
  }
  if (!Number.isSafeInteger(evmChainId) || evmChainId <= 0) unavailableNetworkIdentity('EVM');
  if (evmChainId !== config.chainId) {
    throw new Error(`compose EVM network identity mismatch: expected chain ${config.chainId}, received ${evmChainId}`);
  }

  let solanaGenesisHash;
  try {
    solanaGenesisHash = await identity.readSolanaGenesisHash();
  } catch {
    unavailableNetworkIdentity('Solana');
  }
  if (solanaGenesisHash !== profile.network.solana.genesisHash) {
    throw new Error('compose Solana network identity mismatch');
  }
}

function composeObservability({ config, adapters, cycleRepository }) {
  if (config.observability === undefined || config.observability === null) return null;
  if (typeof config.observability !== 'object' || Array.isArray(config.observability)) {
    throw new Error('compose config.observability must be an object or null');
  }
  const injected = config.observabilityDeps ?? {};
  if (typeof injected !== 'object' || Array.isArray(injected)) {
    throw new Error('compose config.observabilityDeps must be an object when provided');
  }
  return createObservability(config.observability, {
    ...injected,
    evmClient: injected.evmClient ?? adapters?.robinhood?.client,
    solanaClient: injected.solanaClient ?? adapters?.solana?.client,
    cycleRepository,
    signers: config.signerReadiness ?? config.signerClient,
  });
}

function withRestartInjection(stageDriver, restartInjector) {
  if (restartInjector === null || restartInjector === undefined) return stageDriver;
  if (typeof restartInjector !== 'function') throw new Error('compose restartInjector must be a function');
  return Object.freeze({
    ...stageDriver,
    async execute(context) {
      await stageDriver.execute(context);
      await restartInjector(Object.freeze({
        cycleId: context.cycleId,
        stage: context.stage,
        fencingToken: context.fencingToken,
      }));
    },
  });
}

/** Reads observed reserve inputs from composition config and the spend limit from the current
 * operator state. A missing or disabled configuration returns a non-ready budget for a live
 * service, while a dry-run remains able to exercise its explicitly supplied read-only budget. */
function buildBudgetReader({ config, cycleRepository, readConfiguration, liveMode }) {
  return {
    async read() {
      const active = await cycleRepository.readActiveCycle();
      const configuration = await readConfiguration();
      const disabled = liveMode && (configuration === null || (configuration.liveMode && (
        configuration.requestedOrders === 0
        || configuration.allowedPackIds.length === 0
        || configuration.maxUnitPriceMicroUsdg === '0'
        || configuration.perCycleCapMicroUsdg === '0'
      )));
      return {
        availableProcessUsdg: disabled ? '0' : config.budget.availableProcessUsdg,
        packPriceUsdg: disabled ? config.budget.packPriceUsdg : (liveMode && configuration?.liveMode ? configuration.maxUnitPriceMicroUsdg : config.budget.packPriceUsdg),
        outboundCapUsdg: config.budget.outboundCapUsdg,
        returnCapUsdg: config.budget.returnCapUsdg,
        operatingMarginUsdg: config.budget.operatingMarginUsdg,
        activeCycleId: active ? active.cycleId : null,
      };
    },
  };
}

/** Read-only fee-settlement observation. A real production observer (reading
 * `SwapLiabilitiesAccrued`-derived liabilities off the hook, per design section 4.10) is future work
 * for whichever package owns that adapter surface; this reports the same conservative
 * `PENDING_BENEFICIARY_CLAIMS` status `AutomatedCycleService`'s own fixture integration tests use as
 * a safe default rather than fabricating settlement data this composition cannot yet observe for
 * real. `AutomatedCycleService` already treats an `observe()` failure as non-fatal
 * (`OBSERVATION_FAILED`), so this never blocks cycle completion either way. */
function buildFeeSettlementObserver() {
  return { async observe(cycleId) { return { cycleId, status: 'PENDING_BENEFICIARY_CLAIMS' }; } };
}

/**
 * Builds the full composition from an explicit config object. Returns `{ scheduler, service,
 * shutdown }`:
 *   - `scheduler`: the real `createScheduler()` result (`start/stop/triggerTick/settled/...`),
 *     already wired to re-read `config.statePath` and rebuild the worker fresh every tick.
 *   - `service`: a `{ runOnce(), recoverActiveCycle(), tick() }` convenience for one-shot CLI use
 *     (`bin/hookemon-runner.mjs tick`/`dry-run`) that builds one `AutomatedCycleService` instance
 *     against the config's own `liveMode` (or an override for `dry-run`), matching exactly what a
 *     scheduler tick would have built.
 *   - `shutdown()`: stops the scheduler if it was started; idempotent.
 *
 * @param {object} config
 * @param {string} config.stateDir - absolute path; holds the durable cycle-repository directory and
 *   the lease file. Never inside this repository's own tree in real use.
 * @param {string} config.statePath - absolute path to the operator state file
 *   (packages/runner/src/operator/state-file.mjs) the scheduler re-reads every tick.
 * @param {string} config.workerOwner
 * @param {number} config.leaseTtlMs
 * @param {number} [config.defaultIntervalMs]
 * @param {object} config.robinhood - `{ rpcUrl }`
 * @param {object} config.solana - `{ rpcUrl }`
 * @param {object} config.relay - `{ baseUrl, apiKey }`
 * @param {object} config.collectorCrypt - `{ baseUrl, apiKey }`
 * @param {object} config.contracts - `{ vault, hook, usdg }` (0x addresses or null); `usdg` is
 *   required to classify nonzero custody for production policy. WP-37 adds
 *   `treasury`/`pool` (operator-configured fallbacks `distribution.mjs`'s holder-exclusion-set
 *   builder consumes — see `environment.mjs`'s own header) and a test-only `poolManager` override
 *   (defaults to `bindings/robinhood-chain.json`'s `contracts.poolManager`, mirroring `usdg`).
 * @param {object} config.accounts - `{ evm, solana }` (addresses or null)
 * @param {object} [config.budget] - `{ availableProcessUsdg, packPriceUsdg, outboundCapUsdg,
 *   returnCapUsdg, operatingMarginUsdg }`, all canonical decimal strings; defaults to all-zero
 *   (never ready to spend) when omitted.
 * @param {object|null} [config.signerClient] - `{ evm, solana, distributionSigner }` (see
 *   packages/adapters/README.md's injected signerClient seam); `null` unless the operator supplied
 *   `HOOKEMON_SIGNER_MODULE` (environment.mjs) or a test injects one directly.
 *   `distributionSigner` (WP-36) is a distinct role — never the operator `evm`/`solana` signer,
 *   never worker-held key material per decision D7 — `distribution.mjs`'s own mutate() calls
 *   through to obtain the distribution-signer approval; the separate verifier role is never
 *   constructed here at all (see `bin/hookemon-verifier.mjs`'s own process).
 * @param {object} [config.hkmn] - `{ address, deployBlock }` — the HKMN token contract
 *   `distribution.mjs` reads `Transfer` logs from (WP-36); `address: null` (the default) leaves
 *   distribution reporting "not configured" until launch.
 * @param {object} [config.distribution] - `{ dir, excludedHolderAddresses }` — the absolute
 *   directory `distribution.mjs` shares with the separate `bin/hookemon-verifier.mjs` process
 *   (`pending`/`receipts`/`failed`), and (WP-37) an operator-supplied array of additional 0x
 *   addresses its holder-exclusion-set builder always includes, alongside the vault/hook/pool
 *   manager/canonical pool/Programmable/treasury/every prior return escrow/zero address it derives
 *   on its own.
 * @param {object|null} [config.standingAuthority] - an owner-signature- and policy-key-verified
 *   standing-authority document with the branded provider created by `environment.mjs`'s
 *   `loadStandingAuthority`. A production signer refuses when this is absent or invalid.
 * @param {(context: {cycleId: string, stage: string, authorizationKind: 'sign', requestDigest:
 *   string, signerRole: string|null}) => Promise<object>|object} [config.standingAuthorityStepAuthorization]
 *   - supplies an already policy-signed standing-authority step intent at a production signing
 *   boundary. This capability is never exposed to stage handlers or journal preparation.
 * @param {object} [config.adapters] - test-only escape hatch: pre-built adapter clients (fake
 *   transports) instead of constructing real ones from the URLs above. Injected adapters must
 *   include the separate `networkIdentity` seam below.
 * @param {{readErc20BalanceAtBlock: ({token: string, account: string, blockNumber: string,
 *   blockHash: string}) => Promise<object>}} [config.historicalEvidenceClient] - independent
 *   archive-capable EVM balance evidence. Production requires this client or the equivalent
 *   `config.adapters.robinhood.historicalEvidenceClient`; the public Robinhood RPC is rejected.
 * @param {{readEvmChainId: () => Promise<number>, readSolanaGenesisHash: () => Promise<string>}}
 *   [config.networkIdentity] - test-only startup identity seam for deterministic checks with
 *   `config.adapters`; it must report the configured EVM chain and selected Solana genesis hash.
 * @param {object|null} [config.dashboard] - `{ profileId, proxyCredential, port, sqlitePath,
 *   auditLogPath, access }` (see `resolveDashboardConfig`); `null`/omitted composes no dashboard at
 *   all (`composition.dashboard` is then `null`) — `bin/hookemon-runner.mjs`'s `--no-dashboard` maps
 *   straight onto this. When present, the dashboard control service (packages/dashboard) is composed
 *   in this same process with a read-only client over the scheduler's repository and a composed
 *   operator-control authority. `run-cycle-now`, `resume-cycle`, and `reconcile` reach the real
 *   scheduler and automation service above.
 * @param {string} [config.operatorAuditLogPath] - the append-only ledger for the listener-free
 *   operator facade. It defaults to `<stateDir>/dashboard-audit.log` and must equal
 *   `dashboard.auditLogPath` whenever a dashboard listener is composed.
 * @param {() => number} [config.now]
 */
export async function compose(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('compose(config) requires a config object');
  if (typeof config.stateDir !== 'string' || config.stateDir.length === 0) throw new Error('compose config.stateDir is required');
  if (typeof config.statePath !== 'string' || config.statePath.length === 0) throw new Error('compose config.statePath is required');

  const now = config.now ?? (() => Date.now());
  const budget = {
    availableProcessUsdg: '0',
    packPriceUsdg: '0',
    outboundCapUsdg: '0',
    returnCapUsdg: '0',
    operatingMarginUsdg: '0',
    ...(config.budget ?? {}),
  };
  for (const [key, value] of Object.entries(budget)) assertDecimal(value, `compose config.budget.${key}`);

  const resolved = {
    chainId: 4663,
    // WP-37: `treasury`/`pool` are operator/test-configured fallbacks for `distribution.mjs`'s own
    // holder-exclusion-set builder (see environment.mjs's own header — `pool` only matters until
    // `bindings/robinhood-chain.json`'s `market.poolKey` resolves; `poolManager` is deliberately
    // absent from this default — like `usdg`, it is always read from that binding file directly,
    // and exists on `config.contracts` only as a test-only override, never operator configuration).
    contracts: { vault: null, hook: null, usdg: null, usdgDecimals: null, treasury: null, pool: null, poolManager: null },
    accounts: { evm: null, solana: null },
    pack: { code: null },
    moneyConfiguration: null,
    execution: {
      profile: 'inspection', networkProfile: 'mainnet', providerMode: 'live', dryRun: false, rehearsalCapUsdg: null, rehearsalSessionId: null, enforceProfile: false,
    },
    // WP-36: distribution.mjs's own configuration — the HKMN token contract (once launched; see
    // docs/modules/composition-root.md's "What remains unimplemented" for the current
    // INTEGRATION_PENDING launch status) and the on-disk directory it shares with the separate
    // `bin/hookemon-verifier.mjs` process (pending/receipts/failed). WP-37: `excludedHolderAddresses`
    // is the operator-supplied addition to `distribution.mjs`'s own exclusion set. WP-39:
    // `profile` ('fixture', the default, or 'production') and `signerAddress`/`verifierAddress`
    // (production-only, the two configured EIP-712 identities — never the fixture Ed25519 keys).
    hkmn: { address: null, deployBlock: 0n },
    distribution: { dir: null, excludedHolderAddresses: [], profile: 'fixture', signerAddress: null, verifierAddress: null },
    signerClient: null,
    reconciliationAdapters: null,
    standingAuthority: null,
    ...config,
    budget,
  };
  if (resolved.accounts?.operationsTrigger !== undefined && resolved.accounts.operationsTrigger !== null) {
    throw new Error('compose: a third Operations EVM identity is not supported');
  }
  if (resolved.stageHandlers !== undefined && resolved.stageHandlers !== null
    && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('compose stageHandlers are available only from the Node test runner');
  }

  if (!resolved.execution || typeof resolved.execution !== 'object' || Array.isArray(resolved.execution)) {
    throw new Error('compose execution profile is invalid');
  }
  if (resolved.execution.dryRun === undefined) {
    resolved.execution = { ...resolved.execution, dryRun: false };
  }
  if (!['inspection', 'production', 'rehearsal'].includes(resolved.execution.profile)) {
    throw new Error('compose execution profile is invalid');
  }
  if (resolved.execution.networkProfile !== 'mainnet' || resolved.chainId !== 4663) {
    throw new Error('compose only accepts the verified mainnet network profile');
  }
  if (!['live', 'fake'].includes(resolved.execution.providerMode)) {
    throw new Error('compose provider mode is invalid');
  }
  if (typeof resolved.execution.enforceProfile !== 'boolean') {
    throw new Error('compose execution enforceProfile is invalid');
  }
  if (typeof resolved.execution.dryRun !== 'boolean') {
    throw new Error('compose execution dryRun is invalid');
  }
  if (resolved.execution.rehearsalCapUsdg !== null && resolved.execution.rehearsalCapUsdg !== undefined) {
    assertDecimal(resolved.execution.rehearsalCapUsdg, 'compose execution rehearsalCapUsdg');
  }
  if (resolved.rehearsal?.mode === 'relay-roundtrip') {
    if (resolved.execution.profile !== 'rehearsal' || resolved.execution.providerMode !== 'fake') {
      throw new Error('compose relay-roundtrip rehearsal requires fake rehearsal execution');
    }
    if (resolved.execution.rehearsalCapUsdg === null || resolved.execution.rehearsalCapUsdg === undefined
      || resolved.execution.rehearsalCapUsdg === '0') {
      throw new Error('compose relay-roundtrip rehearsal requires a positive explicit rehearsalCapUsdg');
    }
  }
  if (resolved.execution.rehearsalSessionId !== null && resolved.execution.rehearsalSessionId !== undefined
    && (typeof resolved.execution.rehearsalSessionId !== 'string' || !/^rehearsal-[0-9a-f-]{36}$/.test(resolved.execution.rehearsalSessionId))) {
    throw new Error('compose execution rehearsalSessionId is invalid');
  }
  if (resolved.execution.rehearsalSessionId !== null && resolved.execution.rehearsalSessionId !== undefined
    && (resolved.execution.profile !== 'rehearsal' || resolved.execution.providerMode !== 'fake')) {
    throw new Error('compose execution rehearsalSessionId requires fake rehearsal execution');
  }
  if (resolved.execution.profile === 'production' && (
    (resolved.execution.dryRun
      ? resolved.execution.providerMode !== 'fake'
      : resolved.execution.providerMode !== 'live')
    || (resolved.rehearsal !== null && resolved.rehearsal !== undefined)
  )) {
    throw new Error('compose production profile requires live providers unless dryRun uses fake providers without rehearsal flags');
  }
  if (resolved.execution.profile === 'rehearsal' && resolved.execution.providerMode === 'fake'
    && (!resolved.rehearsal || resolved.rehearsal.proceedsAccount === undefined)) {
    throw new Error('compose fake rehearsal requires a dedicated proceeds account');
  }
  resolved.moneyConfiguration = resolveMoneyConfiguration(resolved.moneyConfiguration, resolved.execution);

  // The dashboard profile is part of the same network boundary as the runner. Resolve and check
  // it before opening durable services so an EVM mainnet/testnet mismatch never reaches a listener.
  const dashboardConfig = resolveDashboardConfig(config.stateDir, config.dashboard, resolved.chainId);
  const operatorAuditLogPath = resolveOperatorAuditLogPath(
    resolved.stateDir,
    dashboardConfig,
    resolved.operatorAuditLogPath,
  );

  const adapters = buildAdapters(resolved);
  if (resolved.execution.profile === 'production') {
    assertProductionHistoricalEvidenceClient(adapters);
  }
  // Inspection with the built-in adapters is the offline dry-run path: it never constructs a
  // signer or sends an effect, so it remains usable while RPC endpoints are unavailable. Explicit
  // injected identities are still verified in inspection, and every production/rehearsal profile
  // verifies both networks before durable services open.
  if (resolved.execution.profile !== 'inspection' || config.adapters || config.networkIdentity !== undefined) {
    await assertNetworkIdentity({
      config: resolved,
      adapters,
      profileId: dashboardConfig?.profileId ?? 'mainnet',
    });
  }

  const cycleRepository = await CycleRepository.open(join(config.stateDir, 'cycles'), now);
  assertCycleRepositoryInterface(cycleRepository);
  const cycleRepositoryClient = createCycleRepositoryClient(cycleRepository);
  const createCycleRunner = cycleId => createCycleRepositoryRunner(cycleRepository, cycleId);
  const leaseStore = createFileLeaseStore(join(config.stateDir, 'lease.json'));
  const observability = composeObservability({ config: resolved, adapters, cycleRepository });
  const readConfiguration = () => readPolicyConfiguration(resolved.statePath);
  const readCustody = buildPolicyCustodyReader({ config: resolved, cycleRepository });
  const policyEngine = createPolicyEngine({
    now,
    readConfiguration,
    readCustody,
    mutateConfiguration: (mutation, { expectedRevision } = {}) => mutatePolicyConfiguration({
      statePath: resolved.statePath,
      mutation,
      expectedRevision,
    }),
  });
  const feeSettlementObserver = buildFeeSettlementObserver();
  let successfulStartPreflight = null;
  let successfulMainnetRpcIdentity = null;

  async function requireStartPreflight({ requireCanonicalEvmIdentity = true } = {}) {
    if (observability === null) throw new Error('observability configuration is required before live service startup');
    if (requireCanonicalEvmIdentity) await assertMainnetRpcChainId();
    if (successfulStartPreflight !== null) {
      await successfulStartPreflight;
      return;
    }
    const pending = observability.runStartPreflight().then(result => {
      if (result.ok) return result;
      const codes = result.drift.map(item => item.code).join(', ');
      throw new Error(`observability start preflight failed${codes.length > 0 ? `: ${codes}` : ''}`);
    });
    successfulStartPreflight = pending;
    try {
      await pending;
    } catch (error) {
      successfulStartPreflight = null;
      throw error;
    }
  }

  function redactedUsdgStatusEvidence(stage, drift) {
    return Object.freeze({
      schema: 'hookemon.usdg-status-canary-hold.v1',
      stage,
      drift: Object.freeze(drift.map(item => Object.freeze({
        code: item.code,
        target: item.target,
        expected: item.expected,
        observed: item.observed,
      }))),
    });
  }

  async function requireUsdgStatusCanary({ cycleId, stage, assertLease }) {
    if (observability === null || typeof observability.runUsdgStatusCanary !== 'function') {
      throw new Error('USDG status canary is required before a production mutation');
    }
    assertLease();
    const result = await observability.runUsdgStatusCanary({ destinations: [] });
    if (!result || !Array.isArray(result.drift) || typeof result.ok !== 'boolean') {
      throw new Error('USDG status canary returned an invalid result');
    }
    const heldDrift = result.drift.filter(item => item?.code === 'USDG_PAUSED' || item?.code === 'USDG_FROZEN');
    if (heldDrift.length > 0) {
      assertLease();
      const active = await cycleRepository.readActiveCycle();
      if (active !== null && active.cycleId === cycleId && active.terminalState === undefined) {
        await cycleRepository.holdCycle(
          cycleId,
          'HELD_UNAVAILABLE',
          redactedUsdgStatusEvidence(stage, heldDrift),
          { assertLease },
        );
      }
      const codes = heldDrift.map(item => item.code).join(', ');
      throw new Error(`USDG status canary failed: ${codes}`);
    }
    if (!result.ok) {
      const codes = result.drift.map(item => item?.code ?? 'UNVERIFIED').join(', ');
      throw new Error(`USDG status canary failed: ${codes}`);
    }
  }

  async function assertRepositoryIntegrity() {
    const cycleIds = await cycleRepository.listKnownCycleIds();
    for (const cycleId of cycleIds) await cycleRepository.describeCycle(cycleId);
    return Object.freeze({ cycleCount: cycleIds.length });
  }

  async function assertMainnetRpcChainId() {
    if (successfulMainnetRpcIdentity !== null) {
      await successfulMainnetRpcIdentity;
      return;
    }
    const pending = (async () => {
      const client = adapters?.robinhood?.client;
      if (typeof client?.getChainId !== 'function') throw new Error('EVM RPC chain-id reader is unavailable');
      const reported = await client.getChainId();
      const chainId = typeof reported === 'bigint'
        ? (reported <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reported) : null)
        : reported;
      if (chainId !== 4663) {
        throw new Error(`EVM RPC chain id must equal 4663, got ${typeof reported === 'bigint' ? reported.toString() : String(reported)}`);
      }
    })();
    successfulMainnetRpcIdentity = pending;
    try {
      await pending;
    } catch (error) {
      successfulMainnetRpcIdentity = null;
      throw error;
    }
  }

  /**
   * Performs the non-mutating process-start checks. Callers invoke this before constructing a
   * transaction-capable signer; the signer readiness dependency may therefore be a direct
   * keychain probe rather than a signer client.
   */
  async function assertStartReadiness({
    liveMode = false,
    mode = liveMode ? 'production' : 'rehearsal',
    requirePolicyConfiguration = false,
    requireCanaryPreflight = false,
  } = {}) {
    if (mode !== 'production' && mode !== 'rehearsal') throw new Error('compose readiness mode is invalid');
    if (typeof requireCanaryPreflight !== 'boolean') throw new Error('compose readiness canary requirement is invalid');
    const repository = await assertRepositoryIntegrity();
    await assertMainnetRpcChainId();
    if (requirePolicyConfiguration) {
      const configuration = await readConfiguration();
      if (configuration === null) throw new Error('policy configuration is required before service startup');
      if (configuration.liveMode !== liveMode) {
        throw new Error('policy configuration liveMode does not match the execution profile');
      }
      const minimumApprovals = mode === 'production' ? 3 : 1;
      if (configuration.manualApprovalCycles < minimumApprovals) {
        throw new Error(`policy configuration manualApprovalCycles must be at least ${minimumApprovals} for ${mode} startup`);
      }
    }
    if (requireCanaryPreflight || liveMode === true) await requireStartPreflight();
    return Object.freeze({ ...repository, preflight: requireCanaryPreflight || liveMode === true ? 'PASSED' : 'NOT_REQUIRED' });
  }

  function buildAutomatedCycleService(liveMode, mode = liveMode ? 'production' : 'rehearsal') {
    if (mode !== 'production' && mode !== 'rehearsal') throw new Error('compose execution mode is invalid');
    if (!resolved.execution || typeof resolved.execution !== 'object') throw new Error('compose execution profile is invalid');
    if (resolved.execution.networkProfile !== 'mainnet' || resolved.chainId !== 4663) {
      throw new Error('compose only accepts the verified mainnet network profile');
    }
    if (resolved.execution.profile !== 'inspection' && resolved.execution.profile !== mode) {
      throw new Error('compose execution profile does not match the requested cycle mode');
    }
    if (resolved.execution.enforceProfile) {
      if (resolved.execution.profile === 'inspection' && liveMode === true) {
        throw new Error('compose inspection profile refuses live execution');
      }
      if (resolved.execution.profile === 'production' && (
        mode !== 'production'
        || (resolved.execution.dryRun ? liveMode !== false : liveMode !== true)
      )) {
        throw new Error('compose production profile requires live production execution unless dryRun is explicit');
      }
      if (resolved.execution.profile === 'rehearsal'
        && (mode !== 'rehearsal' || liveMode !== (resolved.execution.providerMode === 'live'))) {
        throw new Error('compose rehearsal profile does not match its provider execution mode');
      }
    }
    if (mode === 'production' && resolved.execution.providerMode !== 'live' && !resolved.execution.dryRun) {
      throw new Error('compose production mode requires live providers unless dryRun is explicit');
    }
    if (mode === 'production' && resolved.rehearsal !== null && resolved.rehearsal !== undefined) {
      throw new Error('compose production mode refuses rehearsal configuration');
    }
    if (mode === 'rehearsal' && resolved.execution.providerMode === 'fake'
      && (!resolved.rehearsal || resolved.rehearsal.proceedsAccount === undefined)) {
      throw new Error('compose fake rehearsal requires a dedicated proceeds account');
    }
    const stageDriver = mode === 'rehearsal' && resolved.execution.providerMode === 'fake'
      ? createRehearsalStageDriver({
        cycleRepository,
        config: resolved,
        providers: Object.freeze({ relay: adapters.relay, collector: adapters.collectorCrypt }),
        onEffect: resolved.onRehearsalEffect ?? (async () => {}),
        restartInjector: resolved.restartInjector ?? null,
      })
      : withRestartInjection(createStageDriver({
        liveMode,
        adapters,
        reconciliationAdapters: resolved.reconciliationAdapters ?? null,
        signerClient: resolved.signerClient,
        config: resolved,
        cycleRepository,
        stageHandlers: resolved.stageHandlers ?? null,
        preflightAuthority: resolved.preflightAuthority,
      }), resolved.restartInjector ?? null);
    const serviceConfig = {
      owner: resolved.workerOwner,
      leaseTtlMs: resolved.leaseTtlMs,
      now,
      leaseStore,
      budgetReader: buildBudgetReader({ config: resolved, cycleRepository, readConfiguration, liveMode }),
      cycleRepository,
      runnerFactory: createCycleRunner,
      stageDriver,
      feeSettlementObserver,
      liveMode,
      mode,
      ...(resolved.execution.profile === 'inspection' ? {} : { providerMode: resolved.execution.providerMode }),
      ...(resolved.execution.dryRun ? { dryRun: true } : {}),
      // Inspection preserves the original offline dry-run contract: non-live probes never reserve
      // policy budget or require an operator configuration. Explicit production and rehearsal
      // profiles always use the policy engine, including fake-provider rehearsals.
      ...(resolved.execution.dryRun || (resolved.execution.profile === 'inspection' && liveMode === false) ? {} : { policyEngine }),
      recoveryGuard: async ({ cycleId }) => inspectCycleRecovery(await cycleRepository.describeCycle(cycleId)),
    };
    if (mode === 'production'
      && resolved.execution.profile === 'production'
      && resolved.execution.providerMode === 'live'
      && resolved.execution.dryRun !== true) {
      serviceConfig.beforeMutation = requireUsdgStatusCanary;
    }
    if (mode === 'rehearsal' && resolved.execution.rehearsalCapUsdg !== null && resolved.execution.rehearsalCapUsdg !== undefined) {
      serviceConfig.policyCapUsdg = resolved.execution.rehearsalCapUsdg;
    }
    if (resolved.execution.rehearsalSessionId !== null && resolved.execution.rehearsalSessionId !== undefined) {
      serviceConfig.rehearsalSessionId = resolved.execution.rehearsalSessionId;
    }
    if (mode === 'rehearsal' && resolved.execution.providerMode === 'fake') {
      serviceConfig.beforeComplete = async ({ runner }) => {
        const evidence = collectRehearsalEvidence(await runner.describe(), { allowReadyToComplete: true });
        await ensureRehearsalEvidence({ stateDir: resolved.stateDir, evidence });
      };
    }
    // `AutomatedCycleService` distinguishes an absent optional pack ID from an invalid supplied
    // value. The environment's conservative default is `null`, which means no process budget is
    // configured yet and must remain a valid dry-run state.
    if (resolved.pack.code !== null) serviceConfig.packId = resolved.pack.code;
    const automatedService = new AutomatedCycleService(serviceConfig);
    if (liveMode !== true) return automatedService;
    return Object.freeze({
      async runOnce(options = {}) {
        await requireStartPreflight({ requireCanonicalEvmIdentity: resolved.execution.profile === 'production' });
        return automatedService.runOnce(options);
      },
      async recoverActiveCycle(options = {}) {
        await requireStartPreflight({ requireCanonicalEvmIdentity: resolved.execution.profile === 'production' });
        return automatedService.recoverActiveCycle(options);
      },
    });
  }

  // Tracked so the composed dashboard's `ctx.lastTick()` (status-projection.mjs's `nextRunAt`) always
  // reflects the real, most recent tick this exact scheduler ran — never a value the dashboard
  // guessed or cached independently. Updated on every tick outcome, not only a successful one, since
  // "when does the next tick happen" is meaningful even after a failed one.
  let lastTick = null;
  const scheduler = createScheduler({
    statePath: resolved.statePath,
    now,
    defaultIntervalMs: resolved.defaultIntervalMs,
    buildWorker: ({ liveMode }) => buildAutomatedCycleService(liveMode, liveMode ? 'production' : 'rehearsal'),
    onTick(event) {
      lastTick = { at: event.at, intervalMs: event.intervalMs };
      resolved.onTick?.(event);
    },
  });

  const operatorControl = createOperatorControl({
    statePath: resolved.statePath,
    cycleRepository,
    policyEngine,
    now,
    readCustody,
    triggerTick: () => scheduler.triggerTick(),
    async resumeActiveCycle() {
      const active = await cycleRepository.readActiveCycle();
      if (active === null) return { status: 'NO_ACTIVE_CYCLE', cycleId: null, stage: null };
      if (active.mode !== 'production' && active.mode !== 'rehearsal') {
        return { status: 'CYCLE_MODE_UNRESOLVED', cycleId: active.cycleId, stage: null };
      }
      return buildAutomatedCycleService(active.mode === 'production', active.mode).recoverActiveCycle({});
    },
    recordHeldOwnerDecision: ({ cycleId, ...decision }) => cycleRepository.recordHeldOwnerDecision(cycleId, decision),
  });

  async function executeAudited({ requestId, expectedRevision, command, effect, note = null } = {}) {
    const status = await operatorControl.status();
    return executeAuditedCommand({
      path: operatorAuditLogPath,
      requestId,
      expectedVersion: expectedRevision,
      observedVersion: status.revision ?? 0,
      command,
      actor: { email: 'local-operator' },
      actorRole: 'operator',
      note,
      resultCode: operatorAuditResultCode(command, status),
      effect,
    });
  }

  const service = {
    async runOnce({ liveMode = false, mode = liveMode ? 'production' : (resolved.execution.dryRun ? 'production' : 'rehearsal'), signal } = {}) {
      return buildAutomatedCycleService(liveMode, mode).runOnce({ signal });
    },
    async recoverActiveCycle({ liveMode = false, mode = liveMode ? 'production' : (resolved.execution.dryRun ? 'production' : 'rehearsal'), signal } = {}) {
      return buildAutomatedCycleService(liveMode, mode).recoverActiveCycle({ signal });
    },
  };

  const dashboard = dashboardConfig
    ? await composeDashboard({
      dashboardConfig,
      chainId: resolved.chainId,
      cycleRepository: cycleRepositoryClient,
      operatorControl,
      readLastTick: () => lastTick,
      adapters,
      identities: buildDashboardIdentities(resolved),
    })
    : null;

  return {
    scheduler,
    service,
    cycleRepository: cycleRepositoryClient,
    createCycleRunner,
    operatorControl,
    executeAudited,
    dashboard,
    policyEngine,
    // WP-39: the real, composed adapter clients — exposed read-only for a one-off caller (e.g.
    // `bin/hookemon-runner.mjs`'s `accept-degraded-return`) that needs a live adapter without
    // driving a full `AutomatedCycleService` stage. Never mutated by this composition itself.
    adapters,
    // The verified document and branded provider passed to the stage driver. The provider records
    // the first-use authority decision before a production signer is reached; this return value
    // remains a read-only configuration projection, not a signing capability.
    standingAuthority: resolved.standingAuthority ? Object.freeze({ ...resolved.standingAuthority }) : null,
    assertRepositoryIntegrity,
    assertStartReadiness,
    async shutdown() {
      scheduler.stop();
      await dashboard?.close();
      observability?.close();
    },
  };
}
