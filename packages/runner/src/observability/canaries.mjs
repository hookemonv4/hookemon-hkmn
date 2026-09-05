export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalUnsigned(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && UNSIGNED_DECIMAL.test(value) ? value : null;
}

function canonicalAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function canonicalHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

function drift(code, target, expected, observed, action) {
  return Object.freeze({ code, target, expected, observed, action });
}

function missingConfiguration(target, expected) {
  return drift('CONFIGURATION_UNVERIFIED', target, expected, null, 'complete the pinned canary configuration before signing');
}

function readRequired(readers, name, ...args) {
  if (!readers || typeof readers[name] !== 'function') throw new Error(`missing reader ${name}`);
  return readers[name](...args);
}

function numericFee(value) {
  const normalized = canonicalUnsigned(value);
  return normalized === null ? null : BigInt(normalized);
}

function normalizeRoleReadback(value) {
  if (!isPlainObject(value)) return null;
  const roles = isPlainObject(value.roles) ? value.roles : value;
  const treasury = canonicalAddress(roles.treasury);
  const operations = canonicalAddress(roles.operations);
  const cycle = isPlainObject(value.cycle) ? value.cycle : null;
  const cycleId = canonicalHash(cycle?.cycleId);
  const cycleOperations = canonicalAddress(cycle?.operations);
  return treasury && operations && cycleId && cycleOperations
    ? { treasury, operations, cycle: { cycleId, operations: cycleOperations } }
    : null;
}

function reserveShape(value) {
  if (!isPlainObject(value)) return null;
  const amountAtomic = canonicalUnsigned(value.amountAtomic);
  if (amountAtomic === null || typeof value.assetId !== 'string' || value.assetId.length === 0) return null;
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) return null;
  if ((typeof value.chainId !== 'number' && typeof value.chainId !== 'string') || String(value.chainId).length === 0) return null;
  return { chainId: value.chainId, assetId: value.assetId, decimals: value.decimals, amountAtomic };
}

function canonicalFreezeTargets(config, destinations) {
  if (!Array.isArray(destinations) || destinations.length === 0) return null;
  const operations = canonicalAddress(config?.roles?.operations);
  const targets = destinations.map(canonicalAddress);
  if (!operations || targets.some(target => target === null)) return null;
  return [...new Set([operations, ...targets])].sort();
}

function requiredNativeGasReserves(config) {
  const expectedEvmChainId = config?.chainId;
  const rawReserves = Array.isArray(config?.nativeGasReserves) ? config.nativeGasReserves : [];
  if ((typeof expectedEvmChainId !== 'number' && typeof expectedEvmChainId !== 'string') || rawReserves.length !== 2) return null;
  const reserves = rawReserves.map(reserveShape);
  if (reserves.some(reserve => reserve === null)) return null;
  const evm = reserves.filter(reserve => String(reserve.chainId) === String(expectedEvmChainId));
  const solana = reserves.filter(reserve => String(reserve.chainId).toLowerCase() === 'solana');
  return evm.length === 1 && solana.length === 1 ? [evm[0], solana[0]] : null;
}

function isUnattributed(value) {
  if (value === true) return true;
  if (value === false) return false;
  const amount = canonicalUnsigned(value);
  return amount === null ? null : BigInt(amount) > 0n;
}

function checkOperatorState(value) {
  if (!isPlainObject(value)) return missingConfiguration('operator-state', 'persisted pause and loss-limit state');
  const pauseFields = ['paused', 'executionPaused', 'policyPaused', 'killSwitch'];
  if (pauseFields.some(field => typeof value[field] !== 'boolean')) {
    return drift('OPERATOR_STATE_UNVERIFIED', 'operator-state', 'persisted pause flags', null, 'load the current persisted operator state before signing');
  }
  if (pauseFields.some(field => value[field] === true)) {
    return drift('EXECUTION_PAUSED', 'operator-state', false, true, 'clear the persisted pause only after resolving its cause');
  }
  if (typeof value.lossLimitExceeded === 'boolean') {
    if (value.lossLimitExceeded) {
      return drift('LOSS_LIMIT_EXCEEDED', 'operator-state', false, true, 'resolve the loss-limit breach before signing');
    }
    return null;
  }
  const lossAtomic = canonicalUnsigned(value.lossAtomic ?? value.lossAmountAtomic);
  const lossLimitAtomic = canonicalUnsigned(value.lossLimitAtomic);
  if (lossAtomic === null || lossLimitAtomic === null) {
    return drift('LOSS_LIMIT_UNVERIFIED', 'operator-state', 'persisted loss-limit evaluation', null, 'persist a current loss-limit evaluation before signing');
  }
  if (BigInt(lossAtomic) > BigInt(lossLimitAtomic)) {
    return drift('LOSS_LIMIT_EXCEEDED', 'operator-state', lossLimitAtomic, lossAtomic, 'resolve the loss-limit breach before signing');
  }
  return null;
}

function contractPins(config) {
  const contracts = isPlainObject(config?.contracts) ? config.contracts : {};
  return [
    ['usdg-proxy-runtime', 'USDG proxy runtime', contracts.usdg?.proxy],
    ['usdg-implementation-runtime', 'USDG implementation runtime', contracts.usdg?.implementation],
    ['pool-manager-runtime', 'PoolManager runtime', contracts.poolManager],
    ['position-manager-runtime', 'PositionManager runtime', contracts.positionManager],
    ['router-runtime', 'router runtime', contracts.router],
    ['quoter-runtime', 'quoter runtime', contracts.quoter],
    ...(contracts.stateView === undefined ? [] : [['state-view-runtime', 'StateView runtime', contracts.stateView]]),
  ];
}

/** Decode the packed `Pool.State.slot0` word used by v4-core's `StateLibrary.getSlot0`.
 * `protocolFee` occupies bits 184..207 and the live LP fee bits 208..231. */
export function decodeCanonicalPoolSlot0(word) {
  const normalized = typeof word === 'bigint'
    ? word
    : (typeof word === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(word) ? BigInt(word) : null);
  if (normalized === null || normalized < 0n) throw new Error('pool slot0 word must be a nonnegative bigint or hex word');
  return Object.freeze({
    protocolFee: (normalized >> 184n) & 0xffffffn,
    lpFee: (normalized >> 208n) & 0xffffffn,
  });
}

/**
 * Run current, read-only evidence checks immediately before an irreversible signature.
 *
 * `context.config` carries immutable expected values. `context.readers` contains injected chain,
 * provider, and ledger reads. `context.reportDrift` receives one durable-alert request per failed
 * check, while `context.resolveDrift` receives the matching key after a current successful read.
 */
export async function runPreSignatureCanaries(context = {}) {
  const source = isPlainObject(context) ? context : {};
  const config = isPlainObject(source.config) ? source.config : null;
  const readers = isPlainObject(source.readers) ? source.readers : {};
  const drifts = [];

  async function report(checkId, item) {
    drifts.push(item);
    if (typeof source.reportDrift === 'function') {
      try {
        await source.reportDrift(Object.freeze({ key: `canary:${checkId}`, ...item }));
      } catch {
        // The canary remains failed if alert delivery itself is unavailable. Do not put a delivery
        // error into an alert or log field because upstream failures may contain credentials.
      }
    }
  }

  async function resolve(checkId) {
    if (typeof source.resolveDrift !== 'function') return;
    try {
      await source.resolveDrift(Object.freeze({ key: `canary:${checkId}` }));
    } catch {
      await report(checkId, drift('ALERT_STATE_UNVERIFIED', checkId, 'durable alert resolution', null, 'restore alert-state storage before signing'));
    }
  }

  async function check(checkId, target, evaluate) {
    try {
      const result = await evaluate();
      if (result) {
        await report(checkId, result);
        return;
      }
      await resolve(checkId);
    } catch {
      await report(checkId, drift(`${checkId.toUpperCase().replace(/-/g, '_')}_UNVERIFIED`, target, 'current verified readback', null, 'restore the required readback before signing'));
    }
  }

  await check('chain-id', 'chain id', async () => {
    if (config === null || (typeof config.chainId !== 'number' && typeof config.chainId !== 'string')) return missingConfiguration('chain id', 'configured chain id');
    const observed = await readRequired(readers, 'readChainId');
    return String(observed) === String(config.chainId)
      ? null
      : drift('CHAIN_ID_MISMATCH', 'chain id', String(config.chainId), String(observed), 'stop signing and restore the configured chain connection');
  });

  await check('usdg-proxy-implementation', 'USDG proxy implementation', async () => {
    const proxy = config?.contracts?.usdg?.proxy;
    const implementation = config?.contracts?.usdg?.implementation;
    const proxyAddress = canonicalAddress(proxy?.address);
    const expected = canonicalAddress(implementation?.address);
    if (!proxyAddress || !expected) return missingConfiguration('USDG proxy implementation', 'pinned proxy and implementation addresses');
    const observed = canonicalAddress(await readRequired(readers, 'readProxyImplementation', proxyAddress));
    if (!observed) return drift('USDG_PROXY_IMPLEMENTATION_UNVERIFIED', 'USDG proxy implementation', expected, null, 'restore proxy implementation readback before signing');
    return observed === expected
      ? null
      : drift('USDG_PROXY_IMPLEMENTATION_MISMATCH', 'USDG proxy implementation', expected, observed, 'stop signing and investigate the proxy implementation change');
  });

  for (const [checkId, target, pin] of contractPins(config)) {
    // eslint-disable-next-line no-await-in-loop -- chain reads are intentionally ordered for an auditable pre-signature record.
    await check(checkId, target, async () => {
      const address = canonicalAddress(pin?.address);
      const expected = canonicalHash(pin?.runtimeHash);
      if (!address || !expected) return missingConfiguration(target, 'pinned address and runtime hash');
      const observed = canonicalHash(await readRequired(readers, 'readRuntimeCodeHash', address));
      if (!observed) return drift('RUNTIME_HASH_UNVERIFIED', target, expected, null, 'restore runtime-code readback before signing');
      return observed === expected
        ? null
        : drift('RUNTIME_HASH_MISMATCH', target, expected, observed, 'stop signing and investigate the runtime change');
    });
  }

  await check('usdg-decimals', 'USDG decimals', async () => {
    const proxyAddress = canonicalAddress(config?.contracts?.usdg?.proxy?.address);
    const expected = config?.contracts?.usdg?.decimals;
    if (!proxyAddress || !Number.isInteger(expected) || expected < 0 || expected > 255) return missingConfiguration('USDG decimals', 'pinned USDG decimals');
    const observed = await readRequired(readers, 'readUsdgDecimals', proxyAddress);
    const normalized = typeof observed === 'bigint' ? Number(observed) : observed;
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 255) {
      return drift('USDG_DECIMALS_UNVERIFIED', 'USDG decimals', expected, null, 'restore USDG decimals readback before signing');
    }
    return normalized === expected
      ? null
      : drift('USDG_DECIMALS_MISMATCH', 'USDG decimals', expected, normalized, 'stop signing and investigate the USDG contract');
  });

  await check('usdg-paused', 'USDG pause state', async () => {
    const proxyAddress = canonicalAddress(config?.contracts?.usdg?.proxy?.address);
    if (!proxyAddress) return missingConfiguration('USDG pause state', 'USDG proxy address');
    const paused = await readRequired(readers, 'readUsdgPaused', proxyAddress);
    if (typeof paused !== 'boolean') return drift('USDG_PAUSE_UNVERIFIED', 'USDG pause state', false, null, 'restore USDG pause readback before signing');
    return paused ? drift('USDG_PAUSED', 'USDG pause state', false, true, 'wait for the USDG pause to be lifted before signing') : null;
  });

  const freezeTargets = canonicalFreezeTargets(config, source.destinations);
  if (freezeTargets === null) {
    await check('usdg-destinations', 'USDG freeze targets', async () => missingConfiguration('USDG freeze targets', 'operations address and at least one canonical signature destination'));
  } else for (const target of freezeTargets) {
    // eslint-disable-next-line no-await-in-loop -- each target requires a separate exact USDG readback.
    await check(`usdg-frozen:${target}`, 'USDG freeze state', async () => {
      const proxyAddress = canonicalAddress(config?.contracts?.usdg?.proxy?.address);
      if (!proxyAddress || !target) return missingConfiguration('USDG freeze state', 'operations or destination address');
      const frozen = await readRequired(readers, 'readUsdgFrozen', proxyAddress, target);
      if (typeof frozen !== 'boolean') return drift('USDG_FREEZE_UNVERIFIED', 'USDG freeze state', false, null, 'restore USDG freeze readback before signing');
      return frozen ? drift('USDG_FROZEN', 'USDG freeze state', false, true, 'use an unfrozen operations or destination account before signing') : null;
    });
  }

  await check('hook-roles', 'hook treasury and operations roles', async () => {
    const hookAddress = canonicalAddress(config?.roles?.hookAddress);
    const cycleId = canonicalHash(config?.roles?.cycleId);
    const expectedTreasury = canonicalAddress(config?.roles?.treasury);
    const expectedOperations = canonicalAddress(config?.roles?.operations);
    if (!hookAddress || !cycleId || !expectedTreasury || !expectedOperations) {
      return missingConfiguration('hook treasury and operations roles', 'hook address, cycle id, treasury, and operations pins');
    }
    const expected = { treasury: expectedTreasury, operations: expectedOperations, cycle: { cycleId, operations: expectedOperations } };
    const observed = normalizeRoleReadback(await readRequired(readers, 'readHookRoles', hookAddress, cycleId));
    if (!observed) return drift('HOOK_ROLES_UNVERIFIED', 'hook treasury and operations roles', expected, null, 'restore hook role readback before signing');
    return observed.treasury === expectedTreasury
      && observed.operations === expectedOperations
      && observed.cycle.cycleId === cycleId
      && observed.cycle.operations === expectedOperations
      ? null
      : drift('HOOK_ROLES_MISMATCH', 'hook treasury and operations roles', expected, observed, 'stop signing and investigate the hook role change');
  });

  await check('pool-fee', 'canonical pool fee', async () => {
    const poolId = canonicalHash(config?.canonicalPool?.poolId);
    if (!poolId) return missingConfiguration('canonical pool fee', 'canonical pool id');
    const state = await readRequired(readers, 'readCanonicalPoolState', poolId);
    const protocolFee = numericFee(state?.protocolFee);
    const lpFee = numericFee(state?.lpFee);
    if (protocolFee === null || lpFee === null) {
      return drift('POOL_FEE_UNVERIFIED', 'canonical pool fee', { protocolFee: '0', lpFee: '0' }, null, 'restore canonical pool slot0 readback before signing');
    }
    return protocolFee === 0n && lpFee === 0n
      ? null
      : drift('POOL_FEE_NONZERO', 'canonical pool fee', { protocolFee: '0', lpFee: '0' }, { protocolFee: protocolFee.toString(), lpFee: lpFee.toString() }, 'stop signing until the canonical pool fee is zero');
  });

  await check('provider-policy-digest', 'provider policy digest', async () => {
    const expected = canonicalHash(config?.providerPolicyDigest);
    if (!expected) return missingConfiguration('provider policy digest', 'pinned provider policy digest');
    const observed = canonicalHash(await readRequired(readers, 'readProviderPolicyDigest'));
    if (!observed) return drift('PROVIDER_POLICY_DIGEST_UNVERIFIED', 'provider policy digest', expected, null, 'restore provider policy digest readback before signing');
    return observed === expected
      ? null
      : drift('PROVIDER_POLICY_DIGEST_MISMATCH', 'provider policy digest', expected, observed, 'stop signing and investigate provider policy drift');
  });

  await check('signature-freshness', 'signature freshness', async () => {
    const freshness = source.freshness;
    if (!isPlainObject(freshness) || typeof freshness.kind !== 'string') {
      return drift('SIGNATURE_FRESHNESS_UNVERIFIED', 'signature freshness', 'current nonce or blockhash', null, 'load a current signature freshness record before signing');
    }
    if (freshness.kind === 'evm') {
      const account = canonicalAddress(freshness.account);
      const expectedNonce = canonicalUnsigned(freshness.expectedNonce);
      if (!account || expectedNonce === null) return missingConfiguration('signature freshness', 'EVM account and expected nonce');
      const observedNonce = canonicalUnsigned(await readRequired(readers, 'readEvmNonce', account));
      if (observedNonce === null) return drift('EVM_NONCE_UNVERIFIED', 'signature freshness', expectedNonce, null, 'restore nonce readback before signing');
      return observedNonce === expectedNonce
        ? null
        : drift('EVM_NONCE_STALE', 'signature freshness', expectedNonce, observedNonce, 'rebuild the signature request with the current nonce');
    }
    if (freshness.kind === 'solana') {
      const lastValidBlockHeight = canonicalUnsigned(freshness.lastValidBlockHeight);
      if (typeof freshness.blockhash !== 'string' || freshness.blockhash.length === 0 || lastValidBlockHeight === null) {
        return missingConfiguration('signature freshness', 'Solana blockhash and last valid block height');
      }
      const [isValid, currentBlockHeight] = await Promise.all([
        readRequired(readers, 'readSolanaBlockhashValidity', freshness.blockhash),
        readRequired(readers, 'readSolanaBlockHeight'),
      ]);
      const current = canonicalUnsigned(currentBlockHeight);
      if (typeof isValid !== 'boolean' || current === null) {
        return drift('SOLANA_BLOCKHASH_UNVERIFIED', 'signature freshness', freshness.blockhash, null, 'restore blockhash readback before signing');
      }
      if (!isValid || BigInt(current) > BigInt(lastValidBlockHeight)) {
        return drift('SOLANA_BLOCKHASH_STALE', 'signature freshness', { blockhash: freshness.blockhash, lastValidBlockHeight }, { isValid, currentBlockHeight: current }, 'rebuild the signature request with a current blockhash');
      }
      return null;
    }
    return drift('SIGNATURE_FRESHNESS_UNVERIFIED', 'signature freshness', 'evm or solana freshness record', freshness.kind, 'load a supported signature freshness record before signing');
  });

  const reserves = requiredNativeGasReserves(config);
  if (reserves === null) {
    await check('native-gas-reserves', 'native gas reserves', async () => missingConfiguration('native gas reserves', 'EVM and Solana minimum reserves'));
  } else for (const reserve of reserves) {
    // eslint-disable-next-line no-await-in-loop -- each reserve must be a current chain-specific balance read.
    await check(`native-gas-reserve:${String(reserve.chainId).toLowerCase()}`, 'native gas reserve', async () => {
      const observed = reserveShape(await readRequired(readers, 'readNativeBalance', reserve, source));
      if (!observed) return drift('NATIVE_GAS_UNVERIFIED', 'native gas reserve', reserve, null, 'restore native balance readback before signing');
      if (String(observed.chainId) !== String(reserve.chainId) || observed.assetId !== reserve.assetId || observed.decimals !== reserve.decimals) {
        return drift('NATIVE_GAS_ASSET_MISMATCH', 'native gas reserve', { chainId: reserve.chainId, assetId: reserve.assetId, decimals: reserve.decimals }, { chainId: observed.chainId, assetId: observed.assetId, decimals: observed.decimals }, 'restore the configured native balance reader before signing');
      }
      return BigInt(observed.amountAtomic) >= BigInt(reserve.amountAtomic)
        ? null
        : drift('NATIVE_GAS_BELOW_MINIMUM', 'native gas reserve', reserve.amountAtomic, observed.amountAtomic, 'fund the native gas reserve before signing');
    });
  }

  await check('operator-state', 'operator state', async () => checkOperatorState(source.operatorState));

  await check('custody', 'unattributed custody', async () => {
    const custody = source.custody === undefined ? await readRequired(readers, 'readCustody', source) : source.custody;
    if (!isPlainObject(custody) || !Object.hasOwn(custody, 'unattributed')) {
      return drift('CUSTODY_UNVERIFIED', 'unattributed custody', false, null, 'load current custody preconditions before signing');
    }
    const unattributed = isUnattributed(custody.unattributed);
    if (unattributed === null) return drift('CUSTODY_UNVERIFIED', 'unattributed custody', false, null, 'load current custody preconditions before signing');
    return unattributed
      ? drift('UNATTRIBUTED_CUSTODY', 'unattributed custody', false, true, 'reconcile custody before signing')
      : null;
  });

  return Object.freeze({ ok: drifts.length === 0, drift: Object.freeze(drifts) });
}
