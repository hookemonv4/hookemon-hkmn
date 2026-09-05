import { createHash } from 'node:crypto';

import { assertBoundedCanonicalValue } from '../cycle/journal.mjs';
import { createEligibilityPayoutManifest } from './pro-rata.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TYPED_AMOUNT_FIELDS = ['chainId', 'assetId', 'decimals', 'amountAtomic'];
const RETURN_BINDING_FIELDS = ['operations', 'usdgAddress', 'evidenceDigest'];
const PREVIOUS_DUST_SOURCE_FIELDS = ['cycleId', 'digest', 'planDigest'];
const FORBIDDEN_CANONICAL_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_UINT256 = (1n << 256n) - 1n;

export const DIRECT_PAYOUT_RECIPIENT_LIMIT = 1025;

const PAYOUT_PLAN_CANONICAL_LIMITS = Object.freeze({
  objects: 20_000,
  arrays: 10_000,
  arrayItems: DIRECT_PAYOUT_RECIPIENT_LIMIT,
  aggregateBytes: 4_194_304,
});

export const USDG_PAYOUT_CHAIN_ID = 4663;
export const USDG_PAYOUT_DECIMALS = 6;

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function assertExactFields(value, fields, label) {
  assertPlainObject(value, label);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

function assertAtomic(value, label) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`${label} must be a canonical atomic integer string`);
  }
  if (BigInt(value) > MAX_UINT256) {
    throw new Error(`${label} exceeds uint256`);
  }
  return value;
}

function assertAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(`${label} must be an EVM address`);
  return value.toLowerCase();
}

/**
 * Builds a canonical typed USDG amount bound to its deployed token address.
 * The token address comes from finalized return evidence, which keeps a persisted plan
 * reconstructable without relying on a symbolic asset identifier.
 */
export function createUsdgPayoutAmount({ assetId, amountAtomic }) {
  return Object.freeze({
    chainId: USDG_PAYOUT_CHAIN_ID,
    assetId: assertAddress(assetId, 'USDG assetId'),
    decimals: USDG_PAYOUT_DECIMALS,
    amountAtomic: assertAtomic(amountAtomic, 'USDG amountAtomic'),
  });
}

function copyUsdAmount(value, label, expectedAssetId) {
  const amount = assertExactFields(value, TYPED_AMOUNT_FIELDS, label);
  if (!(amount.chainId === USDG_PAYOUT_CHAIN_ID || amount.chainId === String(USDG_PAYOUT_CHAIN_ID))) {
    throw new Error(`${label} chainId must be ${USDG_PAYOUT_CHAIN_ID}`);
  }
  const configuredAssetId = assertAddress(expectedAssetId, 'configured USDG assetId');
  const assetId = assertAddress(amount.assetId, `${label} assetId`);
  if (assetId !== configuredAssetId || amount.decimals !== USDG_PAYOUT_DECIMALS) {
    throw new Error(`${label} must identify the configured USDG asset identity on chain ${USDG_PAYOUT_CHAIN_ID} with six decimals`);
  }
  return createUsdgPayoutAmount({ assetId: configuredAssetId, amountAtomic: amount.amountAtomic });
}

function copyNativeAmount(value, label) {
  const amount = assertExactFields(value, TYPED_AMOUNT_FIELDS, label);
  if (!(amount.chainId === 4663 || amount.chainId === '4663')) {
    throw new Error(`${label} chainId must be 4663`);
  }
  if (amount.assetId !== 'native' || amount.decimals !== 18) {
    throw new Error(`${label} must identify the chain 4663 native asset with eighteen decimals`);
  }
  return Object.freeze({
    chainId: 4663,
    assetId: 'native',
    decimals: 18,
    amountAtomic: assertAtomic(amount.amountAtomic, `${label} amountAtomic`),
  });
}

function copyHkmnAmount(value, label, expected = null) {
  const amount = assertExactFields(value, TYPED_AMOUNT_FIELDS, label);
  if (!(amount.chainId === 4663 || amount.chainId === '4663')) {
    throw new Error(`${label} chainId must be 4663`);
  }
  if (
    typeof amount.assetId !== 'string'
    || !ADDRESS.test(amount.assetId)
    || !Number.isInteger(amount.decimals)
    || amount.decimals < 0
    || amount.decimals > 255
  ) {
    throw new Error(`${label} must identify a configured HKMN EVM asset`);
  }
  const amountAtomic = assertAtomic(amount.amountAtomic, `${label} amountAtomic`);
  if (amountAtomic === '0') throw new Error(`${label} amountAtomic must be positive`);
  if (expected && (amount.assetId.toLowerCase() !== expected.assetId || amount.decimals !== expected.decimals)) {
    throw new Error(`${label} must identify the frozen eligibility manifest HKMN asset`);
  }
  return Object.freeze({
    chainId: 4663,
    assetId: amount.assetId.toLowerCase(),
    decimals: amount.decimals,
    amountAtomic,
  });
}

function normalizeReturnBinding(value) {
  const binding = assertExactFields(value, RETURN_BINDING_FIELDS, 'finalized return binding');
  if (typeof binding.evidenceDigest !== 'string' || !DIGEST.test(binding.evidenceDigest)) {
    throw new Error('finalized return binding evidenceDigest is invalid');
  }
  return Object.freeze({
    operations: assertAddress(binding.operations, 'finalized return binding Operations address'),
    usdgAddress: assertAddress(binding.usdgAddress, 'finalized return binding USDG address'),
    evidenceDigest: binding.evidenceDigest,
  });
}

function normalizePreviousDustSource(value, previousDust) {
  if (value === null) {
    if (previousDust.amountAtomic !== '0') {
      throw new Error('previous dust source is required when previous dust is nonzero');
    }
    return null;
  }
  if (previousDust.amountAtomic === '0') {
    throw new Error('previous dust source must be null when previous dust is zero');
  }
  const source = assertExactFields(value, PREVIOUS_DUST_SOURCE_FIELDS, 'previous dust source');
  if (typeof source.cycleId !== 'string' || source.cycleId.length === 0) {
    throw new Error('previous dust source cycleId is invalid');
  }
  for (const field of ['digest', 'planDigest']) {
    if (typeof source[field] !== 'string' || !DIGEST.test(source[field])) {
      throw new Error(`previous dust source ${field} is invalid`);
    }
  }
  return Object.freeze({
    cycleId: source.cycleId,
    digest: source.digest,
    planDigest: source.planDigest,
  });
}

function compareAddress(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeEntries(entries, supply) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('eligibility manifest entries must be a nonempty array');
  const recipients = new Set();
  const normalized = entries.map((entry, index) => {
    assertExactFields(entry, ['recipient', 'hkmnBalance'], `eligibility manifest entry ${index}`);
    const recipient = assertAddress(entry.recipient, `eligibility manifest entry ${index} recipient`);
    if (recipients.has(recipient)) throw new Error('eligibility manifest recipients must be unique');
    recipients.add(recipient);
    return Object.freeze({
      recipient,
      hkmnBalance: copyHkmnAmount(
        entry.hkmnBalance,
        `eligibility manifest entry ${index} hkmnBalance`,
        supply,
      ),
    });
  });
  return Object.freeze(normalized.sort((left, right) => compareAddress(left.recipient, right.recipient)));
}

function normalizeEligibilityManifest(value, cycleId) {
  const suppliedManifest = assertPlainObject(value, 'eligibility manifest');
  if (suppliedManifest.schema !== 'hookemon.eligibility-payout-manifest.v1') {
    throw new Error('eligibility manifest schema is invalid');
  }
  const manifestInput = { ...suppliedManifest };
  delete manifestInput.schema;
  const manifest = createEligibilityPayoutManifest(manifestInput);
  if (manifest.cycleId !== cycleId) throw new Error('eligibility manifest cycleId does not match payout cycleId');
  const supply = copyHkmnAmount(manifest.supply, 'eligibility manifest supply');
  const entries = normalizeEntries(manifest.entries, supply);
  if (entries.length > DIRECT_PAYOUT_RECIPIENT_LIMIT) {
    throw new Error(`direct payout supports at most ${DIRECT_PAYOUT_RECIPIENT_LIMIT} recipients`);
  }
  const aggregateEligibleBalance = entries.reduce((sum, entry) => sum + BigInt(entry.hkmnBalance.amountAtomic), 0n);
  if (aggregateEligibleBalance > BigInt(supply.amountAtomic)) {
    throw new Error('eligibility manifest aggregate eligible balance exceeds frozen gross supply');
  }
  const exclusions = Object.freeze(manifest.exclusions.map(({ address, reason }) => Object.freeze({
    address: address.toLowerCase(),
    reason,
  })));
  const excludedAddresses = new Set(exclusions.map(exclusion => exclusion.address));
  if (entries.some(entry => excludedAddresses.has(entry.recipient))) {
    throw new Error('eligibility manifest includes a recipient from its frozen exclusions');
  }
  const feasibility = assertPlainObject(manifest.feasibility, 'eligibility manifest feasibility');
  if (feasibility.feasible !== true) {
    throw new Error(`eligibility manifest feasibility must pass before payout${feasibility.reason ? `: ${feasibility.reason}` : ''}`);
  }
  for (const key of ['recipientCount', 'transactionCount', 'maxRecipientCount', 'maxTransactionCount']) {
    if (!Number.isSafeInteger(feasibility[key]) || feasibility[key] < 0) {
      throw new Error(`eligibility manifest feasibility ${key} is invalid`);
    }
  }
  if (feasibility.recipientCount !== entries.length || feasibility.transactionCount !== entries.length) {
    throw new Error('eligibility manifest feasibility counts do not match its frozen entries');
  }
  if (feasibility.maxRecipientCount < entries.length || feasibility.maxTransactionCount < entries.length) {
    throw new Error('eligibility manifest feasibility envelope cannot support every frozen recipient');
  }
  for (const key of ['measuredTransferGas', 'maxGasPriceWei']) {
    if (typeof feasibility[key] !== 'string' || !DECIMAL.test(feasibility[key]) || feasibility[key] === '0') {
      throw new Error(`eligibility manifest feasibility ${key} is invalid`);
    }
  }
  const estimatedNativeFee = copyNativeAmount(feasibility.estimatedNativeFee, 'eligibility manifest feasibility estimatedNativeFee');
  const nativeReserve = copyNativeAmount(feasibility.nativeReserve, 'eligibility manifest feasibility nativeReserve');
  const nativeBalance = copyNativeAmount(feasibility.nativeBalance, 'eligibility manifest feasibility nativeBalance');
  const requiredNativeAmount = copyNativeAmount(feasibility.requiredNativeAmount, 'eligibility manifest feasibility requiredNativeAmount');
  const expectedEstimatedNativeFee = BigInt(feasibility.transactionCount) * BigInt(feasibility.measuredTransferGas) * BigInt(feasibility.maxGasPriceWei);
  const expectedRequiredNativeAmount = expectedEstimatedNativeFee + BigInt(nativeReserve.amountAtomic);
  if (BigInt(estimatedNativeFee.amountAtomic) !== expectedEstimatedNativeFee
    || BigInt(requiredNativeAmount.amountAtomic) !== expectedRequiredNativeAmount
    || BigInt(nativeBalance.amountAtomic) < BigInt(requiredNativeAmount.amountAtomic)) {
    throw new Error('eligibility manifest native-balance feasibility envelope is inconsistent');
  }
  return Object.freeze({
    snapshotBlock: manifest.snapshotBlock,
    snapshotHash: manifest.snapshotHash.toLowerCase(),
    finality: Object.freeze({ ...manifest.finality }),
    supply,
    exclusions,
    logCompleteness: Object.freeze({
      mode: manifest.logCompleteness.mode,
      primary: Object.freeze({ ...manifest.logCompleteness.primary }),
      secondary: manifest.logCompleteness.secondary === null
        ? null
        : Object.freeze({ ...manifest.logCompleteness.secondary }),
    }),
    holderSnapshotDigest: manifest.holderSnapshotDigest,
    launchManifestDigest: manifest.launchManifestDigest,
    entries,
    feasibility: Object.freeze({
      recipientCount: feasibility.recipientCount,
      transactionCount: feasibility.transactionCount,
      maxRecipientCount: feasibility.maxRecipientCount,
      maxTransactionCount: feasibility.maxTransactionCount,
      measuredTransferGas: feasibility.measuredTransferGas,
      maxGasPriceWei: feasibility.maxGasPriceWei,
      estimatedNativeFee,
      nativeReserve,
      nativeBalance,
      requiredNativeAmount,
    }),
  });
}

function assertCanonicalPayoutArray(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('direct payout plan canonical array prototype is invalid');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('direct payout plan canonical array symbols are unsupported');
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1
    || !names.includes('length')
    || names.some(name => name !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length))
  ) throw new Error('direct payout plan canonical array properties are invalid');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error('direct payout plan canonical array must be dense and unadorned');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('direct payout plan canonical array property is invalid');
    }
  }
}

function assertCanonicalPayoutObject(value) {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('direct payout plan canonical object must be plain');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('direct payout plan canonical object symbols are unsupported');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (FORBIDDEN_CANONICAL_KEYS.has(key)) throw new Error('direct payout plan canonical object key is unsupported');
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`direct payout plan canonical object property ${key} is invalid`);
    }
  }
}

function canonicalPayoutPlanJsonUnchecked(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('direct payout plan canonical number is invalid');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') throw new Error('direct payout plan canonical bigint is unsupported');
  if (Array.isArray(value)) {
    assertCanonicalPayoutArray(value);
    return `[${value.map(canonicalPayoutPlanJsonUnchecked).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    assertCanonicalPayoutObject(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPayoutPlanJsonUnchecked(value[key])}`).join(',')}}`;
  }
  throw new Error(`direct payout plan canonical value type ${typeof value} is unsupported`);
}

function canonicalPayoutPlanJson(value) {
  assertBoundedCanonicalValue(value, 'direct payout plan', PAYOUT_PLAN_CANONICAL_LIMITS);
  return canonicalPayoutPlanJsonUnchecked(value);
}

function payoutPlanDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalPayoutPlanJson(value)).digest('hex')}`;
}

function unsignedPlan(value) {
  return {
    schema: value.schema,
    cycleId: value.cycleId,
    eligibility: value.eligibility,
    returnEvidence: value.returnEvidence,
    returnDelta: value.returnDelta,
    previousDust: value.previousDust,
    previousDustSource: value.previousDustSource,
    distributablePool: value.distributablePool,
    totalEligibleHkmn: value.totalEligibleHkmn,
    allocations: value.allocations,
    totalAllocated: value.totalAllocated,
    dust: value.dust,
    feasibility: value.feasibility,
  };
}

/** Returns the canonical digest for the immutable, unsigned payout plan payload. */
export function directPayoutPlanDigest(value) {
  return payoutPlanDigest(unsignedPlan(value));
}

function freezePlan(value) {
  if (Array.isArray(value)) {
    value.forEach(freezePlan);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(freezePlan);
  }
  return Object.freeze(value);
}

/**
 * Compiles the immutable direct-transfer plan from the pre-claim eligibility manifest and a
 * finalized return delta. Each allocation is floored, leaving residual atomic units as durable
 * dust for the successor cycle.
 */
export function compileDirectPayoutPlan({
  cycleId,
  eligibilityManifest,
  finalizedReturn,
  previousDust,
  previousDustSource = null,
  returnBinding,
}) {
  if (typeof cycleId !== 'string' || cycleId.length === 0) throw new Error('payout plan cycleId is invalid');
  const eligibility = normalizeEligibilityManifest(eligibilityManifest, cycleId);
  const returnEvidence = normalizeReturnBinding(returnBinding);
  const returnDelta = copyUsdAmount(finalizedReturn, 'finalized return', returnEvidence.usdgAddress);
  const carryInDust = copyUsdAmount(previousDust, 'previous dust', returnEvidence.usdgAddress);
  const carryInDustSource = normalizePreviousDustSource(previousDustSource, carryInDust);
  const distributablePool = BigInt(returnDelta.amountAtomic) + BigInt(carryInDust.amountAtomic);
  if (distributablePool > MAX_UINT256) {
    throw new Error('direct payout distributable pool exceeds uint256');
  }
  const totalEligibleHkmn = eligibility.entries.reduce((sum, entry) => sum + BigInt(entry.hkmnBalance.amountAtomic), 0n);
  if (totalEligibleHkmn === 0n) throw new Error('eligibility manifest has no positive HKMN balance');

  const candidates = eligibility.entries.map(entry => {
    const numerator = BigInt(entry.hkmnBalance.amountAtomic) * distributablePool;
    return {
      recipient: entry.recipient,
      hkmnBalance: entry.hkmnBalance,
      amountAtomic: numerator / totalEligibleHkmn,
    };
  });
  const flooredTotal = candidates.reduce((sum, candidate) => sum + candidate.amountAtomic, 0n);
  const dustAtomic = distributablePool - flooredTotal;

  const allocations = candidates
    .sort((left, right) => compareAddress(left.recipient, right.recipient))
    .map(candidate => ({
      recipient: candidate.recipient,
      hkmnBalance: candidate.hkmnBalance,
      amount: createUsdgPayoutAmount({
        assetId: returnEvidence.usdgAddress,
        amountAtomic: candidate.amountAtomic.toString(),
      }),
    }));
  const totalAllocated = allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount.amountAtomic), 0n);
  const dust = createUsdgPayoutAmount({
    assetId: returnEvidence.usdgAddress,
    amountAtomic: dustAtomic.toString(),
  });
  const unsigned = {
    schema: 'hookemon.direct-payout-plan.v1',
    cycleId,
    eligibility: {
      snapshotBlock: eligibility.snapshotBlock,
      snapshotHash: eligibility.snapshotHash,
      finality: eligibility.finality,
      supply: eligibility.supply,
      exclusions: eligibility.exclusions,
      logCompleteness: eligibility.logCompleteness,
      holderSnapshotDigest: eligibility.holderSnapshotDigest,
      launchManifestDigest: eligibility.launchManifestDigest,
    },
    returnEvidence,
    returnDelta,
    previousDust: carryInDust,
    previousDustSource: carryInDustSource,
    distributablePool: createUsdgPayoutAmount({
      assetId: returnEvidence.usdgAddress,
      amountAtomic: distributablePool.toString(),
    }),
    totalEligibleHkmn: {
      chainId: eligibility.supply.chainId,
      assetId: eligibility.supply.assetId,
      decimals: eligibility.supply.decimals,
      amountAtomic: totalEligibleHkmn.toString(),
    },
    allocations,
    totalAllocated: createUsdgPayoutAmount({
      assetId: returnEvidence.usdgAddress,
      amountAtomic: totalAllocated.toString(),
    }),
    dust,
    feasibility: eligibility.feasibility,
  };
  return freezePlan({
    ...unsigned,
    payableRecipientCount: allocations.filter(allocation => allocation.amount.amountAtomic !== '0').length,
    planDigest: directPayoutPlanDigest(unsigned),
  });
}
