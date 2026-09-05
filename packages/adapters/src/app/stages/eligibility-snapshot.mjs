import {
  getPinnedTransferLogs,
  readBlockByNumber,
  selectFinalizedSnapshotBlock,
} from '../../robinhood-rpc.mjs';
import {
  buildEligibilityHolderSet,
  digestTransferLogReplay,
} from '../../../../runner/src/distribution/snapshot-indexer.mjs';
import { createEligibilityPayoutManifest } from '../../../../runner/src/distribution/pro-rata.mjs';
import { DIRECT_PAYOUT_RECIPIENT_LIMIT } from '../../../../runner/src/distribution/payout-plan.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^(?:[1-9][0-9]*)$/;
const FINALITY_POLICY_ID = 'robinhood-stage-finality-v1';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const TYPED_AMOUNT_FIELDS = ['chainId', 'assetId', 'decimals', 'amountAtomic'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class EligibilitySnapshotError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}

export class EligibilitySnapshotFeasibilityError extends EligibilitySnapshotError {}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new EligibilitySnapshotError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new EligibilitySnapshotError(`${label} symbols are unsupported`);
  return value;
}

function canonicalAddress(value, label, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new EligibilitySnapshotError(`${label} must be a valid EVM address`);
  }
  if (!allowZero && value === ZERO_ADDRESS) {
    throw new EligibilitySnapshotError(`${label} must not be the zero address`);
  }
  return value.toLowerCase();
}

function toInteger(value, label, { positive = false } = {}) {
  let result;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'string' && (positive ? POSITIVE_DECIMAL : DECIMAL).test(value)) result = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)) result = BigInt(value);
  else throw new EligibilitySnapshotError(`${label} must be a canonical unsigned integer`);
  if ((positive && result <= 0n) || (!positive && result < 0n)) {
    throw new EligibilitySnapshotError(`${label} must be ${positive ? 'positive' : 'nonnegative'}`);
  }
  return result;
}

function toSafeCount(value, label, { positive = false } = {}) {
  const parsed = toInteger(value, label, { positive });
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EligibilitySnapshotError(`${label} exceeds the supported safe count`);
  }
  return Number(parsed);
}

function typedAmount(value, label) {
  const amount = assertRecord(value, label);
  const keys = Object.keys(amount);
  if (keys.length !== TYPED_AMOUNT_FIELDS.length || !TYPED_AMOUNT_FIELDS.every(field => Object.hasOwn(amount, field))) {
    throw new EligibilitySnapshotError(`${label} must use the exact typed amount schema`);
  }
  if (typeof amount.chainId !== 'string' || !POSITIVE_DECIMAL.test(amount.chainId)) {
    throw new EligibilitySnapshotError(`${label} chainId must be a canonical decimal string`);
  }
  const canonicalAssetId = canonicalAddress(amount.assetId, `${label} assetId`);
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 255) {
    throw new EligibilitySnapshotError(`${label} decimals must be an integer between 0 and 255`);
  }
  if (typeof amount.amountAtomic !== 'string' || !DECIMAL.test(amount.amountAtomic)) {
    throw new EligibilitySnapshotError(`${label} amountAtomic must be a canonical decimal string`);
  }
  return {
    chainId: amount.chainId,
    assetId: canonicalAssetId,
    decimals: amount.decimals,
    amountAtomic: amount.amountAtomic,
  };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new EligibilitySnapshotError(`${label} must be an array`);
  return value;
}

function buildExclusions(launchManifest) {
  const reasons = new Map();
  const add = (address, reason, options) => {
    const canonical = canonicalAddress(address, `launch manifest ${reason}`, options);
    const current = reasons.get(canonical) ?? new Set();
    current.add(reason);
    reasons.set(canonical, current);
  };

  add(ZERO_ADDRESS, 'zero-address', { allowZero: true });
  add(launchManifest.hook, 'hook');
  add(launchManifest.poolManager, 'pool-manager');
  add(launchManifest.custody, 'custody');
  add(launchManifest.operations, 'operations');
  add(launchManifest.treasury, 'treasury');
  add(launchManifest.programmableRecipient, 'programmable-recipient');
  for (const address of requireArray(launchManifest.launchContracts, 'launch manifest launchContracts')) {
    add(address, 'launch-contract');
  }
  for (const address of requireArray(launchManifest.burnAddresses, 'launch manifest burnAddresses')) {
    add(address, 'burn-address');
  }
  for (const [index, entry] of requireArray(launchManifest.roleHistory, 'launch manifest roleHistory').entries()) {
    const role = assertRecord(entry, `launch manifest roleHistory ${index}`).role;
    if (typeof role !== 'string' || role.length === 0) {
      throw new EligibilitySnapshotError(`launch manifest roleHistory ${index} role is invalid`);
    }
    add(entry.address, `role-history:${role}`);
  }
  return [...reasons.entries()]
    .map(([address, reasonSet]) => ({ address, reason: [...reasonSet].sort().join(',') }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

function normalizeLaunchManifest(config, { chainId, tokenAddress, tokenDecimals }) {
  const launchManifest = assertRecord(config.eligibilitySnapshot?.launchManifest, 'eligibilitySnapshot.launchManifest');
  const supply = typedAmount(launchManifest.supply, 'eligibilitySnapshot.launchManifest.supply');
  if (
    supply.chainId !== chainId
    || supply.assetId !== tokenAddress
    || supply.decimals !== tokenDecimals
  ) throw new EligibilitySnapshotError('launch manifest supply must identify the configured HKMN token');
  const exclusions = buildExclusions(launchManifest);
  const manifestForDigest = {
    supply,
    hook: canonicalAddress(launchManifest.hook, 'launch manifest hook'),
    poolManager: canonicalAddress(launchManifest.poolManager, 'launch manifest poolManager'),
    custody: canonicalAddress(launchManifest.custody, 'launch manifest custody'),
    operations: canonicalAddress(launchManifest.operations, 'launch manifest operations'),
    treasury: canonicalAddress(launchManifest.treasury, 'launch manifest treasury'),
    programmableRecipient: canonicalAddress(launchManifest.programmableRecipient, 'launch manifest programmableRecipient'),
    launchContracts: requireArray(launchManifest.launchContracts, 'launch manifest launchContracts')
      .map((address, index) => canonicalAddress(address, `launch manifest launchContracts ${index}`))
      .sort(),
    burnAddresses: requireArray(launchManifest.burnAddresses, 'launch manifest burnAddresses')
      .map((address, index) => canonicalAddress(address, `launch manifest burnAddresses ${index}`))
      .sort(),
    roleHistory: requireArray(launchManifest.roleHistory, 'launch manifest roleHistory')
      .map((entry, index) => {
        const roleEntry = assertRecord(entry, `launch manifest roleHistory ${index}`);
        if (typeof roleEntry.role !== 'string' || roleEntry.role.length === 0) {
          throw new EligibilitySnapshotError(`launch manifest roleHistory ${index} role is invalid`);
        }
        return {
          role: roleEntry.role,
          address: canonicalAddress(roleEntry.address, `launch manifest roleHistory ${index} address`),
        };
      })
      .sort((a, b) => (a.address === b.address ? a.role.localeCompare(b.role) : a.address.localeCompare(b.address))),
  };
  const launchManifestDigest = digest({
    domain: 'hookemon.eligibility-launch-manifest.v1',
    launchManifest: manifestForDigest,
  });
  const expectedManifestDigest = config.eligibilitySnapshot?.launchManifestDigest;
  if (typeof expectedManifestDigest !== 'string' || !DIGEST.test(expectedManifestDigest)) {
    throw new EligibilitySnapshotError('eligibilitySnapshot.launchManifestDigest is required and must be a SHA-256 digest');
  }
  if (expectedManifestDigest !== launchManifestDigest) {
    throw new EligibilitySnapshotError('eligibilitySnapshot.launchManifestDigest does not match the launch manifest contents');
  }
  return {
    supply,
    exclusions,
    launchManifestDigest,
  };
}

function normalizeFeasibility(value, chainId) {
  const feasibility = assertRecord(value, 'eligibilitySnapshot.feasibility');
  return {
    measuredTransferGas: toInteger(feasibility.measuredTransferGas, 'eligibilitySnapshot.feasibility.measuredTransferGas', { positive: true }),
    maxGasPriceWei: toInteger(feasibility.maxGasPriceWei, 'eligibilitySnapshot.feasibility.maxGasPriceWei', { positive: true }),
    nativeReserveWei: toInteger(feasibility.nativeReserveWei, 'eligibilitySnapshot.feasibility.nativeReserveWei'),
    nativeBalanceWei: toInteger(feasibility.nativeBalanceWei, 'eligibilitySnapshot.feasibility.nativeBalanceWei'),
    maxRecipientCount: toSafeCount(feasibility.maxRecipientCount, 'eligibilitySnapshot.feasibility.maxRecipientCount', { positive: true }),
    maxTransactionCount: toSafeCount(feasibility.maxTransactionCount, 'eligibilitySnapshot.feasibility.maxTransactionCount', { positive: true }),
    chainId,
  };
}

function normalizeLogSourceId(value, label) {
  const sourceId = value;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new EligibilitySnapshotError(`${label} must be a nonempty string`);
  }
  return sourceId;
}

function normalizeSnapshotConfig(config) {
  const root = assertRecord(config, 'snapshot configuration');
  const chainId = toInteger(root.chainId, 'snapshot configuration chainId', { positive: true }).toString();
  const hkmn = assertRecord(root.hkmn, 'snapshot configuration hkmn');
  const tokenAddress = canonicalAddress(hkmn.address, 'snapshot configuration hkmn.address');
  if (!Object.hasOwn(hkmn, 'deployBlock')) {
    throw new EligibilitySnapshotError('snapshot configuration hkmn.deployBlock is required');
  }
  const deployBlock = toInteger(hkmn.deployBlock, 'snapshot configuration hkmn.deployBlock');
  if (!Number.isInteger(hkmn.decimals) || hkmn.decimals < 0 || hkmn.decimals > 255) {
    throw new EligibilitySnapshotError('snapshot configuration hkmn.decimals is required');
  }
  const snapshot = assertRecord(root.eligibilitySnapshot, 'snapshot configuration eligibilitySnapshot');
  const finality = assertRecord(snapshot.finality, 'eligibilitySnapshot.finality');
  if (finality.policyId !== FINALITY_POLICY_ID) {
    throw new EligibilitySnapshotError(`eligibilitySnapshot.finality.policyId must be ${FINALITY_POLICY_ID}`);
  }
  if (!Object.hasOwn(finality, 'depth')) {
    throw new EligibilitySnapshotError(`eligibilitySnapshot.finality.depth is required for ${FINALITY_POLICY_ID}`);
  }
  const finalityDepth = toInteger(finality.depth, 'eligibilitySnapshot.finality.depth', { positive: true });
  const launch = normalizeLaunchManifest(root, { chainId, tokenAddress, tokenDecimals: hkmn.decimals });
  const logPageSize = snapshot.logPageSize === undefined
    ? 5000n
    : toInteger(snapshot.logPageSize, 'eligibilitySnapshot.logPageSize', { positive: true });
  const maxRetriesPerPage = snapshot.maxRetriesPerPage === undefined
    ? 3
    : toSafeCount(snapshot.maxRetriesPerPage, 'eligibilitySnapshot.maxRetriesPerPage', { positive: true });
  return {
    chainId,
    tokenAddress,
    tokenDecimals: hkmn.decimals,
    deployBlock,
    finality: { policyId: finality.policyId, depth: finalityDepth },
    ...launch,
    logPageSize,
    maxRetriesPerPage,
    feasibility: normalizeFeasibility(snapshot.feasibility, chainId),
    primarySourceId: normalizeLogSourceId(snapshot.primaryLogSourceId, 'eligibilitySnapshot.primaryLogSourceId'),
    secondarySourceId: normalizeLogSourceId(snapshot.secondaryLogSourceId, 'eligibilitySnapshot.secondaryLogSourceId'),
  };
}

export function evaluatePayoutFeasibility({ entries, feasibility }) {
  const recipientCount = entries.length;
  const transactionCount = recipientCount;
  const maxRecipientCount = Math.min(feasibility.maxRecipientCount, DIRECT_PAYOUT_RECIPIENT_LIMIT);
  const maxTransactionCount = Math.min(feasibility.maxTransactionCount, DIRECT_PAYOUT_RECIPIENT_LIMIT);
  const estimatedNativeFeeWei = BigInt(recipientCount) * feasibility.measuredTransferGas * feasibility.maxGasPriceWei;
  const requiredNativeWei = feasibility.nativeReserveWei + estimatedNativeFeeWei;
  const reasons = [];
  if (recipientCount === 0) reasons.push('no-eligible-recipients');
  if (recipientCount > DIRECT_PAYOUT_RECIPIENT_LIMIT) reasons.push('recipient-count-exceeds-direct-payout-capacity');
  if (recipientCount > feasibility.maxRecipientCount) reasons.push('recipient-count-exceeds-configured-maximum');
  if (transactionCount > feasibility.maxTransactionCount) reasons.push('transaction-count-exceeds-configured-maximum');
  if (feasibility.nativeBalanceWei < requiredNativeWei) reasons.push('native-balance-below-reserve-and-fee');
  const nativeAmount = amountAtomic => ({
    chainId: feasibility.chainId,
    assetId: 'native',
    decimals: 18,
    amountAtomic: amountAtomic.toString(),
  });
  return {
    recipientCount,
    transactionCount,
    maxRecipientCount,
    maxTransactionCount,
    measuredTransferGas: feasibility.measuredTransferGas.toString(),
    maxGasPriceWei: feasibility.maxGasPriceWei.toString(),
    estimatedNativeFee: nativeAmount(estimatedNativeFeeWei),
    nativeReserve: nativeAmount(feasibility.nativeReserveWei),
    nativeBalance: nativeAmount(feasibility.nativeBalanceWei),
    requiredNativeAmount: nativeAmount(requiredNativeWei),
    feasible: reasons.length === 0,
    reason: reasons.length === 0 ? null : reasons.join(', '),
  };
}

function sourceEvidence({ sourceId, transferLogDigest, logs }) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new EligibilitySnapshotError('configured log source id is invalid');
  }
  return { sourceId, transferLogDigest, logCount: logs.length };
}

function compactHeldManifest(manifest) {
  if (!manifest) return null;
  return {
    schema: manifest.schema,
    cycleId: manifest.cycleId,
    snapshotBlock: manifest.snapshotBlock,
    snapshotHash: manifest.snapshotHash,
    finality: manifest.finality,
    supply: manifest.supply,
    holderSnapshotDigest: manifest.holderSnapshotDigest,
    launchManifestDigest: manifest.launchManifestDigest,
    logCompleteness: manifest.logCompleteness,
    feasibility: manifest.feasibility,
  };
}

function assertLogClient(client, label) {
  if (!client || typeof client.getBlock !== 'function' || typeof client.request !== 'function') {
    throw new EligibilitySnapshotError(`${label} is required`);
  }
  return client;
}

function assertSnapshotClient(adapters) {
  return assertLogClient(adapters?.robinhood?.client, 'Robinhood primary log client');
}

/**
 * Builds the complete pre-claim holder manifest from a finalized, hash-pinned Transfer replay.
 * It makes no contract-state read and performs no provider mutation.
 */
export async function freezeEligibilityBeforeClaim({ adapters, config, context }) {
  const normalized = normalizeSnapshotConfig(config);
  if (!context || typeof context.cycleId !== 'string' || context.cycleId.length === 0) {
    throw new EligibilitySnapshotError('eligibility snapshot context.cycleId is required');
  }
  const primaryClient = assertSnapshotClient(adapters);
  const secondaryClient = assertLogClient(adapters?.robinhood?.secondaryLogClient, 'Robinhood independent log client');
  if (secondaryClient === primaryClient || normalized.secondarySourceId === normalized.primarySourceId) {
    throw new EligibilitySnapshotError('independent log sources must use distinct clients and source identifiers');
  }
  context.assertLease?.();
  const snapshotBlock = await selectFinalizedSnapshotBlock(primaryClient, {
    finalityDepth: normalized.finality.depth,
  });
  if (snapshotBlock.number < normalized.deployBlock) {
    throw new EligibilitySnapshotError(
      `snapshot block ${snapshotBlock.number} is before HKMN deploy block ${normalized.deployBlock}`,
    );
  }
  context.assertLease?.();
  const primaryScan = await getPinnedTransferLogs(primaryClient, {
    token: normalized.tokenAddress,
    fromBlock: normalized.deployBlock,
    toBlock: snapshotBlock.number,
    snapshotHash: snapshotBlock.hash,
    pageSize: normalized.logPageSize,
    maxRetriesPerPage: normalized.maxRetriesPerPage,
  });
  context.assertLease?.();
  const holderSet = buildEligibilityHolderSet({
    chainId: normalized.chainId,
    tokenAddress: normalized.tokenAddress,
    tokenDecimals: normalized.tokenDecimals,
    snapshotBlock: snapshotBlock.number.toString(),
    snapshotHash: snapshotBlock.hash,
    supply: normalized.supply,
    exclusions: normalized.exclusions,
    transferLogs: primaryScan.logs,
  });

  const secondaryScan = await getPinnedTransferLogs(secondaryClient, {
    token: normalized.tokenAddress,
    fromBlock: normalized.deployBlock,
    toBlock: snapshotBlock.number,
    snapshotHash: snapshotBlock.hash,
    pageSize: normalized.logPageSize,
    maxRetriesPerPage: normalized.maxRetriesPerPage,
  });
  const secondaryDigest = digestTransferLogReplay({
    snapshotBlock: snapshotBlock.number.toString(),
    transferLogs: secondaryScan.logs,
  });
  if (secondaryDigest !== holderSet.transferLogDigest) {
    throw new EligibilitySnapshotError('independent Transfer-log source digest does not match the primary source');
  }
  const logCompleteness = {
    mode: 'dual-source',
    primary: sourceEvidence({
      sourceId: normalized.primarySourceId,
      transferLogDigest: holderSet.transferLogDigest,
      logs: primaryScan.logs,
    }),
    secondary: sourceEvidence({
      sourceId: normalized.secondarySourceId,
      transferLogDigest: secondaryDigest,
      logs: secondaryScan.logs,
    }),
  };

  const finalHash = await readBlockByNumber(primaryClient, snapshotBlock.number);
  if (finalHash.hash !== snapshotBlock.hash) {
    throw new EligibilitySnapshotError(`snapshot block ${snapshotBlock.number} hash changed after log paging`);
  }
  context.assertLease?.();
  const feasibility = evaluatePayoutFeasibility({ entries: holderSet.entries, feasibility: normalized.feasibility });
  const manifest = createEligibilityPayoutManifest({
    cycleId: context.cycleId,
    snapshotBlock: snapshotBlock.number.toString(),
    snapshotHash: snapshotBlock.hash,
    finality: {
      policyId: normalized.finality.policyId,
      depth: normalized.finality.depth.toString(),
    },
    supply: holderSet.supply,
    entries: holderSet.entries,
    exclusions: holderSet.exclusions,
    feasibility,
    logCompleteness,
    holderSnapshotDigest: holderSet.holderSnapshotDigest,
    launchManifestDigest: normalized.launchManifestDigest,
  });
  if (!manifest.feasibility.feasible) {
    throw new EligibilitySnapshotFeasibilityError(
      `eligibility snapshot feasibility envelope failed: ${manifest.feasibility.reason}`,
      { manifest },
    );
  }
  return manifest;
}

/** The dry-run probe never reaches an RPC endpoint. */
export async function probeEligibilitySnapshot({ adapters, config, cycleRepository, context }) {
  const active = await cycleRepository.readStage(context.cycleId, 'eligibility-snapshot');
  const configured = Boolean(adapters.robinhood?.client && config.hkmn?.address);
  return {
    wouldFreezeEligibilitySnapshot: true,
    configured,
    existingSnapshot: active.status === 'COMPLETE',
    tokenAddress: config.hkmn?.address ?? null,
    reason: configured
      ? 'live reconciliation validates finality, immutable manifest evidence, and source completeness'
      : 'Robinhood RPC client or token address is not configured',
  };
}

/** This stage is read-only; a direct live call returns the same frozen evidence as reconciliation. */
export async function mutateEligibilitySnapshot({ liveMode, adapters, config, context }) {
  if (liveMode !== true) throw new Error('eligibility-snapshot mutate reached without live mode');
  return freezeEligibilityBeforeClaim({ adapters, config, context });
}

/**
 * Reconciliation freezes the snapshot before claim processing. Any verification failure creates a
 * terminal hold rather than leaving a claimable cycle with partial holder evidence.
 */
export async function reconcileLiveEligibilitySnapshot({ adapters, config, cycleRepository, context }) {
  try {
    return await freezeEligibilityBeforeClaim({ adapters, config, context });
  } catch (error) {
    context?.assertLease?.();
    if (cycleRepository && typeof cycleRepository.holdCycle === 'function' && context?.cycleId) {
      const terminalState = error instanceof EligibilitySnapshotFeasibilityError
        ? 'HELD_UNAVAILABLE'
        : 'HELD_DATA_UNVERIFIED';
      await cycleRepository.holdCycle(context.cycleId, terminalState, {
        stage: 'eligibility-snapshot',
        category: terminalState === 'HELD_UNAVAILABLE' ? 'feasibility' : 'verification',
        reason: error.message,
        manifest: compactHeldManifest(error.manifest),
      });
    }
    throw error;
  }
}
