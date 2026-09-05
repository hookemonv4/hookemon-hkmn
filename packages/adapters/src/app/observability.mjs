import { encodeAbiParameters, keccak256, parseAbi, toHex } from 'viem';

import { buildAlert, createAlertWebhook, createPersistentAlertDeduper } from '../../../runner/src/observability/alert-webhook.mjs';
import { decodeCanonicalPoolSlot0, EIP1967_IMPLEMENTATION_SLOT, runPreSignatureCanaries } from '../../../runner/src/observability/canaries.mjs';
import { createLogger, redactForLogging } from '../../../runner/src/observability/logger.mjs';
import { createProtocolFeeMonitor } from '../../../runner/src/observability/protocol-fee-monitor.mjs';
import { readBlockhashValidity, readBlockHeight, readLatestBlockhash, readSolBalance } from '../solana-rpc.mjs';

const USDG_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function paused() view returns (bool)',
  'function isFrozen(address account) view returns (bool)',
]);

const EXTSLOAD_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

const HOOK_ROLES_ABI = Object.freeze([{
  type: 'function',
  name: 'readRoles',
  stateMutability: 'view',
  inputs: [{ name: 'cycleId', type: 'bytes32' }],
  outputs: [
    {
      name: 'roles',
      type: 'tuple',
      components: [
        { name: 'programmableBeneficiary', type: 'address' },
        { name: 'treasury', type: 'address' },
        { name: 'operations', type: 'address' },
      ],
    },
    {
      name: 'treasuryTransfer',
      type: 'tuple',
      components: [
        { name: 'role', type: 'bytes32' },
        { name: 'currentAccount', type: 'address' },
        { name: 'proposedAccount', type: 'address' },
      ],
    },
    {
      name: 'operationsTransfer',
      type: 'tuple',
      components: [
        { name: 'role', type: 'bytes32' },
        { name: 'currentAccount', type: 'address' },
        { name: 'proposedAccount', type: 'address' },
      ],
    },
    {
      name: 'cycle',
      type: 'tuple',
      components: [
        { name: 'cycleId', type: 'bytes32' },
        { name: 'operations', type: 'address' },
      ],
    },
  ],
}]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configValue(config, path) {
  return path.split('.').reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), config);
}

function missingConfig(path) {
  return Object.freeze({
    code: 'CONFIG_INCOMPLETE',
    target: path,
    expected: 'configured value',
    observed: null,
    action: `configure ${path} before starting the signer process`,
  });
}

function validConfigValue(path, value) {
  if (value === undefined || value === null || value === '') return false;
  if (path.endsWith('.address')) return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
  if (path.endsWith('.runtimeHash') || path.endsWith('.cycleId') || path.endsWith('.providerPolicyDigest')) {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
  }
  if (path.endsWith('.decimals')) return Number.isInteger(value) && value >= 0 && value <= 255;
  if (path.endsWith('.chainId')) return (typeof value === 'number' || typeof value === 'string') && String(value).length > 0;
  if (path === 'alert.webhookUrl') {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

function configDrifts(config) {
  if (!isPlainObject(config)) return [missingConfig('observability')];
  const required = [
    'canaries.chainId',
    'canaries.contracts.usdg.proxy.address',
    'canaries.contracts.usdg.proxy.runtimeHash',
    'canaries.contracts.usdg.implementation.address',
    'canaries.contracts.usdg.implementation.runtimeHash',
    'canaries.contracts.usdg.decimals',
    'canaries.contracts.poolManager.address',
    'canaries.contracts.poolManager.runtimeHash',
    'canaries.contracts.positionManager.address',
    'canaries.contracts.positionManager.runtimeHash',
    'canaries.contracts.router.address',
    'canaries.contracts.router.runtimeHash',
    'canaries.contracts.quoter.address',
    'canaries.contracts.quoter.runtimeHash',
    'canaries.roles.hookAddress',
    'canaries.roles.cycleId',
    'canaries.roles.treasury',
    'canaries.roles.operations',
    'canaries.canonicalPool.poolId',
    'canaries.providerPolicyDigest',
    'alert.webhookUrl',
    'alert.dedupePath',
  ];
  const drifts = required.filter(path => !validConfigValue(path, configValue(config, path))).map(missingConfig);
  if (!Array.isArray(config.canaries?.nativeGasReserves) || config.canaries.nativeGasReserves.length === 0) {
    drifts.push(missingConfig('canaries.nativeGasReserves'));
  }
  if (!Array.isArray(config.startPreflight?.requiredSignerRoles) || config.startPreflight.requiredSignerRoles.length === 0) {
    drifts.push(missingConfig('startPreflight.requiredSignerRoles'));
  }
  return drifts;
}

function makeLogger(deps) {
  if (isPlainObject(deps.logger)) return deps.logger;
  return createLogger(isPlainObject(deps.loggerOptions) ? deps.loggerOptions : {});
}

function log(logger, level, event, fields) {
  if (typeof logger?.[level] === 'function') logger[level](event, redactForLogging(fields));
}

function normalizeRoles(value) {
  const roles = value?.roles ?? value?.[0] ?? value;
  const cycle = value?.cycle ?? value?.[3];
  return {
    treasury: roles?.treasury ?? roles?.[1],
    operations: roles?.operations ?? roles?.[2],
    cycle: {
      cycleId: cycle?.cycleId ?? cycle?.[0],
      operations: cycle?.operations ?? cycle?.[1],
    },
  };
}

function reserveAccount(config, context, chainId) {
  const key = String(chainId);
  return context?.gasAccounts?.[key]
    ?? config?.canaries?.gasAccounts?.[key]
    ?? config?.gasAccounts?.[key]
    ?? null;
}

function isSolanaChain(chainId) {
  return String(chainId).toLowerCase() === 'solana';
}

/** Read v4 `Pool.State.slot0` through `IExtsload` using StateLibrary's `POOLS_SLOT == 6` mapping. */
export function createCanonicalPoolStateReader({ evmClient, poolManager }) {
  if (!evmClient || typeof evmClient.readContract !== 'function') throw new Error('canonical pool state reader requires evmClient.readContract');
  if (typeof poolManager !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(poolManager)) {
    throw new Error('canonical pool state reader requires a PoolManager address');
  }
  return async poolId => {
    if (typeof poolId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) throw new Error('canonical pool state reader requires a bytes32 pool id');
    const slot = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [poolId, toHex(6, { size: 32 })],
    ));
    const word = await evmClient.readContract({ address: poolManager, abi: EXTSLOAD_ABI, functionName: 'extsload', args: [slot] });
    return decodeCanonicalPoolSlot0(word);
  };
}

function createDefaultReaders(config, deps, logger, send) {
  const evmClient = deps.evmClient;
  const solanaClient = deps.solanaClient;
  const canaries = config?.canaries ?? {};
  let poolReader = null;
  if (evmClient && canaries.contracts?.poolManager?.address) {
    try {
      poolReader = createCanonicalPoolStateReader({ evmClient, poolManager: canaries.contracts.poolManager.address });
    } catch {
      poolReader = null;
    }
  }
  let feeMonitor = null;
  if (poolReader && typeof canaries.canonicalPool?.poolId === 'string') {
    try {
      feeMonitor = createProtocolFeeMonitor({
        poolId: canaries.canonicalPool.poolId,
        readPoolState: poolReader,
        send,
        logger,
      });
    } catch {
      feeMonitor = null;
    }
  }

  const defaults = {
    async readChainId() {
      if (typeof evmClient?.getChainId !== 'function') throw new Error('EVM chain-id reader is unavailable');
      return evmClient.getChainId();
    },
    async readRuntimeCodeHash(address) {
      if (typeof evmClient?.getCode !== 'function') throw new Error('EVM runtime-code reader is unavailable');
      const code = await evmClient.getCode({ address });
      if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) throw new Error('EVM runtime-code readback is malformed');
      return keccak256(code);
    },
    async readProxyImplementation(address) {
      if (typeof evmClient?.getStorageAt !== 'function') throw new Error('EVM proxy-storage reader is unavailable');
      const value = await evmClient.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT });
      if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('EIP-1967 implementation slot is malformed');
      return `0x${value.slice(-40)}`;
    },
    async readUsdgDecimals(address) {
      if (typeof evmClient?.readContract !== 'function') throw new Error('USDG decimals reader is unavailable');
      return evmClient.readContract({ address, abi: USDG_ABI, functionName: 'decimals' });
    },
    async readUsdgPaused(address) {
      if (typeof evmClient?.readContract !== 'function') throw new Error('USDG pause reader is unavailable');
      return evmClient.readContract({ address, abi: USDG_ABI, functionName: 'paused' });
    },
    async readUsdgFrozen(address, account) {
      if (typeof evmClient?.readContract !== 'function') throw new Error('USDG freeze reader is unavailable');
      return evmClient.readContract({ address, abi: USDG_ABI, functionName: 'isFrozen', args: [account] });
    },
    async readHookRoles(address, cycleId) {
      if (typeof evmClient?.readContract !== 'function') throw new Error('hook roles reader is unavailable');
      return normalizeRoles(await evmClient.readContract({ address, abi: HOOK_ROLES_ABI, functionName: 'readRoles', args: [cycleId] }));
    },
    async readCanonicalPoolState() {
      if (feeMonitor === null) throw new Error('canonical pool fee reader is unavailable');
      return feeMonitor.read();
    },
    async readProviderPolicyDigest() {
      if (typeof deps.readProviderPolicyDigest !== 'function') throw new Error('provider policy digest reader is unavailable');
      return deps.readProviderPolicyDigest();
    },
    async readEvmNonce(account) {
      if (typeof evmClient?.getTransactionCount !== 'function') throw new Error('EVM nonce reader is unavailable');
      return evmClient.getTransactionCount({ address: account, blockTag: 'pending' });
    },
    async readSolanaBlockhashValidity(blockhash) {
      if (!solanaClient) throw new Error('Solana blockhash validity reader is unavailable');
      return readBlockhashValidity(solanaClient, blockhash);
    },
    async readSolanaBlockHeight() {
      if (!solanaClient) throw new Error('Solana block height reader is unavailable');
      return readBlockHeight(solanaClient);
    },
    async readSolanaBalance(account) {
      if (!solanaClient) throw new Error('Solana native-balance reader is unavailable');
      return readSolBalance(solanaClient, account);
    },
    async readNativeBalance(reserve, context) {
      const account = reserveAccount(config, context, reserve.chainId);
      if (typeof account !== 'string' || account.length === 0) throw new Error('native gas account is unavailable');
      if (isSolanaChain(reserve.chainId)) {
        const balance = await defaults.readSolanaBalance(account);
        return { ...reserve, amountAtomic: String(balance) };
      }
      if (typeof evmClient?.getBalance !== 'function') throw new Error('EVM native-balance reader is unavailable');
      const balance = await evmClient.getBalance({ address: account });
      return { ...reserve, amountAtomic: String(balance) };
    },
    async readCustody(context) {
      if (typeof deps.cycleRepository?.readClaimPreconditions !== 'function') throw new Error('custody reader is unavailable');
      return deps.cycleRepository.readClaimPreconditions(context?.cycleId);
    },
  };
  return Object.freeze({ ...defaults, ...(isPlainObject(deps.readers) ? deps.readers : {}) });
}

function buildDriftAlert(reason, item) {
  return buildAlert({
    reason,
    severity: 'critical',
    message: reason === 'CANARY_DRIFT'
      ? `pre-signature canary failed: ${item.code}`
      : `start preflight failed: ${item.code}`,
    detail: redactForLogging({
      code: item.code,
      target: item.target,
      expected: item.expected,
      observed: item.observed,
      action: item.action,
    }),
  });
}

function alertDeduperReady(value) {
  return value !== null
    && typeof value?.ready === 'function'
    && typeof value?.claim === 'function'
    && typeof value?.markDelivered === 'function'
    && typeof value?.markPending === 'function'
    && typeof value?.resolve === 'function';
}

async function operationalAlertDeduperReady(value) {
  if (!alertDeduperReady(value)) return false;
  try {
    const result = await value.ready();
    return result === true || result?.ready === true;
  } catch {
    return false;
  }
}

function alertWebhookReady(value) {
  return value !== null && typeof value?.send === 'function';
}

function alertDeliveryLeaseMs({ dedupeWindowMs, maxAttempts, backoffMs, timeoutMs }) {
  if (!Number.isSafeInteger(dedupeWindowMs) || dedupeWindowMs < 0
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
    || !Number.isSafeInteger(backoffMs) || backoffMs < 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return dedupeWindowMs;
  }
  const minimumLeaseMs = Math.max(1, dedupeWindowMs);
  const retryBackoffMs = backoffMs * ((maxAttempts - 1) * maxAttempts / 2);
  const deliveryDurationMs = maxAttempts * timeoutMs + retryBackoffMs + 1;
  if (!Number.isSafeInteger(deliveryDurationMs)) return Number.MAX_SAFE_INTEGER;
  return Math.max(minimumLeaseMs, deliveryDurationMs);
}

function createAlertReporter(config, deps, logger) {
  const alertConfig = isPlainObject(config?.alert) ? config.alert : {};
  const dedupeWindowMs = alertConfig.dedupeWindowMs ?? 300_000;
  const maxAttempts = alertConfig.maxAttempts ?? 3;
  const backoffMs = alertConfig.backoffMs ?? 250;
  const timeoutMs = alertConfig.timeoutMs ?? 5_000;
  let deduper = deps.alertDeduper ?? null;
  let ownsDeduper = false;
  if (deduper === null && typeof alertConfig.dedupePath === 'string' && alertConfig.dedupePath.length > 0) {
    try {
      deduper = createPersistentAlertDeduper({
        path: alertConfig.dedupePath,
        windowMs: dedupeWindowMs,
        leaseMs: alertDeliveryLeaseMs({ dedupeWindowMs, maxAttempts, backoffMs, timeoutMs }),
        now: deps.now ?? (() => Date.now()),
      });
      ownsDeduper = true;
    } catch {
      log(logger, 'error', 'observability-alert-dedupe-unavailable', { reason: 'dedupe storage could not be opened' });
    }
  }
  let webhook = null;
  if (typeof alertConfig.webhookUrl === 'string' && alertConfig.webhookUrl.length > 0) {
    try {
      webhook = createAlertWebhook({
        url: alertConfig.webhookUrl,
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
        maxAttempts,
        backoffMs,
        timeoutMs,
        sleep: deps.sleep,
        now: deps.alertClock,
        logger,
      });
    } catch {
      log(logger, 'error', 'observability-alert-webhook-unavailable', { reason: 'alert webhook configuration is invalid' });
    }
  }

  async function report(item, reason) {
    if (!alertDeduperReady(deduper) || !alertWebhookReady(webhook)) {
      log(logger, 'error', 'observability-alert-sink-unavailable', { code: item.code, target: item.target });
      return Object.freeze({ delivered: false, attempts: 0, error: 'durable alert sink unavailable' });
    }
    let claim;
    try {
      claim = deduper.claim(item.key);
    } catch {
      log(logger, 'error', 'observability-alert-dedupe-unavailable', { code: item.code, target: item.target });
      return Object.freeze({ delivered: false, attempts: 0, error: 'durable alert state unavailable' });
    }
    if (!claim.deliver) return Object.freeze({ delivered: false, deduped: true });
    const alert = buildDriftAlert(reason, item);
    const delivery = await webhook.send(alert);
    try {
      if (delivery.delivered) deduper.markDelivered(item.key, claim.token);
      else deduper.markPending(item.key, claim.token);
    } catch {
      log(logger, 'error', 'observability-alert-dedupe-unavailable', { code: item.code, target: item.target });
      return Object.freeze({ delivered: false, attempts: delivery.attempts ?? 0, error: 'durable alert state unavailable' });
    }
    log(logger, 'error', reason === 'CANARY_DRIFT' ? 'pre-signature-canary-drift' : 'start-preflight-drift', {
      code: item.code,
      target: item.target,
      expected: item.expected,
      observed: item.observed,
      action: item.action,
      delivered: delivery.delivered,
    });
    return Object.freeze({ ...delivery, deduped: false });
  }

  async function resolve(item) {
    if (!alertDeduperReady(deduper)) throw new Error('durable alert state is unavailable');
    deduper.resolve(item.key);
  }

  return Object.freeze({
    report,
    resolve,
    async isReady() {
      if (!alertWebhookReady(webhook)) return false;
      return operationalAlertDeduperReady(deduper);
    },
    send: alertWebhookReady(webhook) ? webhook.send : async () => Object.freeze({ delivered: false, attempts: 0, error: 'alert sink unavailable' }),
    close() {
      if (ownsDeduper) deduper.close();
    },
  });
}

function preflightDrift(code, target, expected, observed, action) {
  return Object.freeze({ code, target, expected, observed, action });
}

function isPositiveEvmRpcProbe(result, expectedChainId) {
  const observed = isPlainObject(result) ? result.chainId : result;
  return (typeof observed === 'number' || typeof observed === 'string')
    && String(observed) === String(expectedChainId);
}

function isPositiveSolanaRpcProbe(result) {
  return isPlainObject(result)
    && typeof result.blockhash === 'string'
    && result.blockhash.length > 0
    && Number.isSafeInteger(result.lastValidBlockHeight)
    && result.lastValidBlockHeight >= 0;
}

/** Build observability without wiring a scheduler or signer. Callers must invoke its canary method
 * immediately before every irreversible signature and its start preflight before process start. */
export function createObservability(config, deps = {}) {
  const dependencies = isPlainObject(deps) ? deps : {};
  const logger = makeLogger(dependencies);
  const reporter = createAlertReporter(config, dependencies, logger);
  const readers = createDefaultReaders(config, dependencies, logger, reporter.send);

  async function runUsdgStatusCanary(input = {}) {
    const source = isPlainObject(input) ? input : {};
    const drift = [];
    const address = value => (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
      ? value.toLowerCase()
      : null);
    async function fail(checkId, item) {
      drift.push(item);
      await reporter.report(Object.freeze({ key: `canary:${checkId}`, ...item }), 'CANARY_DRIFT');
    }
    async function clear(checkId) {
      try {
        await reporter.resolve(Object.freeze({ key: `canary:${checkId}` }));
      } catch {
        await fail('usdg-status-alert-state', preflightDrift(
          'ALERT_STATE_UNVERIFIED',
          'USDG status canary',
          'durable alert resolution',
          null,
          'restore durable alert state before signing',
        ));
      }
    }

    const proxyAddress = address(config?.canaries?.contracts?.usdg?.proxy?.address);
    if (proxyAddress === null) {
      await fail('usdg-paused', preflightDrift(
        'USDG_PAUSE_UNVERIFIED',
        'USDG pause state',
        false,
        null,
        'restore the configured USDG pause readback before signing',
      ));
    } else {
      try {
        const paused = await readers.readUsdgPaused(proxyAddress);
        if (paused === true) {
          await fail('usdg-paused', preflightDrift(
            'USDG_PAUSED',
            'USDG pause state',
            false,
            true,
            'wait for the USDG pause to be lifted before signing',
          ));
        } else if (paused !== false) {
          await fail('usdg-paused', preflightDrift(
            'USDG_PAUSE_UNVERIFIED',
            'USDG pause state',
            false,
            null,
            'restore the USDG pause readback before signing',
          ));
        } else {
          await clear('usdg-paused');
        }
      } catch {
        await fail('usdg-paused', preflightDrift(
          'USDG_PAUSE_UNVERIFIED',
          'USDG pause state',
          false,
          null,
          'restore the USDG pause readback before signing',
        ));
      }
    }

    const configuredOperations = address(config?.canaries?.roles?.operations);
    const requestedDestinations = source.destinations === undefined ? [] : source.destinations;
    const destinations = Array.isArray(requestedDestinations)
      ? requestedDestinations.map(address)
      : null;
    if (proxyAddress === null || configuredOperations === null || destinations === null || destinations.some(destination => destination === null)) {
      await fail('usdg-frozen:configuration', preflightDrift(
        'USDG_FREEZE_UNVERIFIED',
        'USDG freeze state',
        false,
        null,
        'restore the configured USDG freeze targets before signing',
      ));
    } else {
      const targets = [...new Set([configuredOperations, ...destinations])];
      for (const target of targets) {
        const checkId = `usdg-frozen:${target}`;
        try {
          // eslint-disable-next-line no-await-in-loop -- every freeze target is an independently attributable safety boundary.
          const frozen = await readers.readUsdgFrozen(proxyAddress, target);
          if (frozen === true) {
            // eslint-disable-next-line no-await-in-loop -- every failed target must produce its own durable alert.
            await fail(checkId, preflightDrift(
              'USDG_FROZEN',
              'USDG freeze state',
              false,
              true,
              'use an unfrozen operations or destination account before signing',
            ));
          } else if (frozen !== false) {
            // eslint-disable-next-line no-await-in-loop -- every unknown target remains independently actionable.
            await fail(checkId, preflightDrift(
              'USDG_FREEZE_UNVERIFIED',
              'USDG freeze state',
              false,
              null,
              'restore the USDG freeze readback before signing',
            ));
          } else {
            // eslint-disable-next-line no-await-in-loop -- a verified target must clear only its own alert key.
            await clear(checkId);
          }
        } catch {
          // eslint-disable-next-line no-await-in-loop -- failures remain target-specific in the durable alert stream.
          await fail(checkId, preflightDrift(
            'USDG_FREEZE_UNVERIFIED',
            'USDG freeze state',
            false,
            null,
            'restore the USDG freeze readback before signing',
          ));
        }
      }
    }
    return Object.freeze({ ok: drift.length === 0, drift: Object.freeze(drift) });
  }

  async function reportPreflight(item) {
    await reporter.report(Object.freeze({ key: `preflight:${item.target}:${item.code}`, ...item }), 'START_PREFLIGHT_FAILED');
  }

  async function runStartPreflight() {
    const drift = [];
    async function fail(item) {
      drift.push(item);
      await reportPreflight(item);
    }

    if (!(await reporter.isReady())) {
      await fail(preflightDrift(
        'ALERT_SINK_UNAVAILABLE',
        'alert reporter',
        'durable dedupe storage and webhook delivery',
        null,
        'restore the durable alert sink before starting',
      ));
    }

    for (const item of configDrifts(config)) {
      // eslint-disable-next-line no-await-in-loop -- each configuration drift gets one durable alert request in a stable order.
      await fail(item);
    }

    const preflight = config?.startPreflight;
    const roles = Array.isArray(preflight?.requiredSignerRoles) ? preflight.requiredSignerRoles : [];
    for (const role of roles) {
      // eslint-disable-next-line no-await-in-loop -- readiness probes are sign-only process calls and remain individually attributable.
      try {
        const signer = dependencies.signers?.[role];
        if (typeof signer?.probe !== 'function') {
          await fail(preflightDrift('SIGNER_READINESS_UNAVAILABLE', `signer:${role}`, 'sign-only readiness probe', null, 'configure the WP08a signer readiness probe before starting'));
          continue;
        }
        const result = await signer.probe();
        if (result?.ready !== true) {
          await fail(preflightDrift('SIGNER_NOT_READY', `signer:${role}`, { ready: true }, null, 'restore signer readiness before starting'));
        }
      } catch {
        await fail(preflightDrift('SIGNER_NOT_READY', `signer:${role}`, { ready: true }, null, 'restore signer readiness before starting'));
      }
    }

    async function probe(required, code, target, explicitProbe, fallbackProbe, validate) {
      if (!required) return;
      try {
        const result = await (typeof explicitProbe === 'function' ? explicitProbe() : fallbackProbe());
        if (!validate(result)) {
          await fail(preflightDrift(code, target, 'positive chain-specific RPC evidence', null, 'restore RPC reachability before starting'));
        }
      } catch {
        await fail(preflightDrift(code, target, 'positive chain-specific RPC evidence', null, 'restore RPC reachability before starting'));
      }
    }

    await probe(
      preflight?.requireEvmRpc === true,
      'EVM_RPC_UNREACHABLE',
      'EVM RPC',
      dependencies.probeEvmRpc,
      async () => {
        if (typeof dependencies.evmClient?.getChainId !== 'function') throw new Error('EVM RPC probe is unavailable');
        return dependencies.evmClient.getChainId();
      },
      result => isPositiveEvmRpcProbe(result, config?.canaries?.chainId),
    );
    await probe(
      preflight?.requireSolanaRpc === true,
      'SOLANA_RPC_UNREACHABLE',
      'Solana RPC',
      dependencies.probeSolanaRpc,
      async () => {
        if (!dependencies.solanaClient) throw new Error('Solana RPC probe is unavailable');
        return readLatestBlockhash(dependencies.solanaClient);
      },
      isPositiveSolanaRpcProbe,
    );
    return Object.freeze({ ok: drift.length === 0, drift: Object.freeze(drift) });
  }

  return Object.freeze({
    logger,
    runUsdgStatusCanary,
    async runPreSignatureCanaries(context = {}) {
      return runPreSignatureCanaries({
        ...(isPlainObject(context) ? context : {}),
        config: config?.canaries,
        readers,
        reportDrift: item => reporter.report(item, 'CANARY_DRIFT'),
        resolveDrift: item => reporter.resolve(item),
      });
    },
    runStartPreflight,
    close: () => reporter.close(),
  });
}
