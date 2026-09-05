// Pro-rata manifest compiler.
//
// `createEligibilityPayoutManifest` is the frozen input contract shared with the direct
// Operations-wallet payout compiler in `payout-plan.mjs`. The compatibility distribution helpers
// below retain floor-and-carry semantics for commitment consumers; direct ERC-20 payouts use
// `compileDirectPayoutPlan`, which applies the same floor-and-carry conservation rule.
//
// Pure functions turning a finalized HKMN holder snapshot (see `snapshot-indexer.mjs`) and a
// cycle's returned USDG proceeds into per-holder distribution amounts:
//
//   amount_i = floor(directHkmnBalance_i * distributablePool / totalEligibleSupply)
//   distributablePool = proceedsAmount + previousDust
//
// Floor rounding always leaves an exact remainder ("dust"). Per decision D6's default, dust is
// never dropped: the caller carries a cycle's returned `dust` forward as the next cycle's
// `previousDust`, growing that cycle's distributable pool. A holder whose floor amount is zero
// this cycle is left out of `entries` -- `reconcile.mjs`'s holder candidate entries require a
// *positive* USDG amount per entry -- but the holder's balance still counts toward
// `totalEligibleSupply` and its unpaid share stays captured inside `dust`, to be paid once
// accumulated dust (or a larger proceeds figure) makes its floor share nonzero.
//
// Holder sets above 1024 are split into deterministic, address-sorted, <=1024-entry chunks
// (`chunkProRataEntries`), one per `PayoutCommitment.commitPayoutChunk` call (§3.6,
// `CanonicalMerkleSum.TREE_WIDTH` per chunk, `PayoutCommitment.MAX_CHUNKS_PER_PAYOUT` chunks).
// Today's default operational mode (D5) commits exactly one chunk, so `toHolderCandidateInput`
// feeds a single chunk's entries straight into `reconcile.mjs`'s
// `deriveHolderDistributionCandidate`/`manifest.mjs` pipeline unmodified, via
// `snapshot-indexer.mjs`'s `toSnapshotCandidate` projection.
//
// This module never mutates, weakens, or reimplements `reconcile.mjs`'s or `manifest.mjs`'s own
// verification invariants -- it only produces input that already conforms to them.

import { toSnapshotCandidate } from './snapshot-indexer.mjs';

// Mirrors `CanonicalMerkleSum.TREE_WIDTH` (packages/contracts/src/payout/CanonicalMerkleSum.sol).
export const CHUNK_ENTRY_LIMIT = 1024;
// Mirrors `PayoutCommitment.MAX_CHUNKS_PER_PAYOUT` (packages/contracts/src/payout/PayoutCommitment.sol).
export const MAX_CHUNKS_PER_DISTRIBUTION = 64;

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^(?:[1-9][0-9]*)$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_EVM_ADDRESS = `0x${'0'.repeat(40)}`;
const PAYABLE_ENTRY_FIELDS = ['index', 'recipient', 'directHkmnBalance', 'amountAtomicUSDG'];
const ELIGIBILITY_MANIFEST_INPUT_FIELDS = [
  'cycleId', 'snapshotBlock', 'snapshotHash', 'finality', 'supply', 'entries', 'exclusions', 'feasibility',
  'logCompleteness', 'holderSnapshotDigest', 'launchManifestDigest',
];
const ELIGIBILITY_ENTRY_FIELDS = ['recipient', 'hkmnBalance'];
const TYPED_AMOUNT_FIELDS = ['chainId', 'assetId', 'decimals', 'amountAtomic'];
const EXCLUSION_FIELDS = ['address', 'reason'];
const FEASIBILITY_FIELDS = [
  'recipientCount', 'transactionCount', 'maxRecipientCount', 'maxTransactionCount',
  'measuredTransferGas', 'maxGasPriceWei', 'estimatedNativeFee', 'nativeReserve',
  'nativeBalance', 'requiredNativeAmount', 'feasible', 'reason',
];
const LOG_COMPLETENESS_FIELDS = ['mode', 'primary', 'secondary'];
const LOG_SOURCE_FIELDS = ['sourceId', 'transferLogDigest', 'logCount'];
const FINALITY_FIELDS = ['policyId', 'depth'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/;

function assertDecimalString(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !(positive ? POSITIVE_DECIMAL : DECIMAL).test(value)) {
    throw new Error(positive ? `${label} must be positive` : `${label} must be a canonical decimal string`);
  }
}

function assertRecipient(value, label) {
  if (typeof value !== 'string' || !EVM_ADDRESS.test(value) || value === ZERO_EVM_ADDRESS) {
    throw new Error(`${label} must be a canonical nonzero EVM address`);
  }
}

function assertExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

function assertTypedAmount(value, label) {
  const amount = assertExactObject(value, TYPED_AMOUNT_FIELDS, label);
  assertDecimalString(amount.chainId, `${label} chainId`, { positive: true });
  if (typeof amount.assetId !== 'string' || amount.assetId.length === 0) {
    throw new Error(`${label} assetId is invalid`);
  }
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 255) {
    throw new Error(`${label} decimals is invalid`);
  }
  assertDecimalString(amount.amountAtomic, `${label} amountAtomic`);
  return amount;
}

function assertLogSource(value, label) {
  const source = assertExactObject(value, LOG_SOURCE_FIELDS, label);
  if (typeof source.sourceId !== 'string' || source.sourceId.length === 0) {
    throw new Error(`${label} sourceId is invalid`);
  }
  if (typeof source.transferLogDigest !== 'string' || !DIGEST.test(source.transferLogDigest)) {
    throw new Error(`${label} transferLogDigest is invalid`);
  }
  if (!Number.isInteger(source.logCount) || source.logCount < 0) {
    throw new Error(`${label} logCount is invalid`);
  }
  return source;
}

function assertEligibilityEntries(value, supply) {
  if (!Array.isArray(value)) throw new Error('eligibility manifest entries must be an array');
  const entries = [];
  let previousRecipient = null;
  for (const [index, rawEntry] of value.entries()) {
    const entry = assertExactObject(rawEntry, ELIGIBILITY_ENTRY_FIELDS, `eligibility manifest entry ${index}`);
    assertRecipient(entry.recipient, `eligibility manifest entry ${index} recipient`);
    const hkmnBalance = assertTypedAmount(entry.hkmnBalance, `eligibility manifest entry ${index} hkmnBalance`);
    if (
      hkmnBalance.chainId !== supply.chainId
      || hkmnBalance.assetId !== supply.assetId
      || hkmnBalance.decimals !== supply.decimals
      || hkmnBalance.amountAtomic === '0'
    ) throw new Error(`eligibility manifest entry ${index} balance does not match supply`);
    if (previousRecipient !== null && compareAddresses(previousRecipient, entry.recipient) >= 0) {
      throw new Error('eligibility manifest entries must be address-sorted and unique');
    }
    previousRecipient = entry.recipient;
    entries.push({
      recipient: entry.recipient,
      hkmnBalance: {
        chainId: hkmnBalance.chainId,
        assetId: hkmnBalance.assetId,
        decimals: hkmnBalance.decimals,
        amountAtomic: hkmnBalance.amountAtomic,
      },
    });
  }
  return entries;
}

function assertExclusions(value) {
  if (!Array.isArray(value)) throw new Error('eligibility manifest exclusions must be an array');
  const exclusions = [];
  let previousAddress = null;
  for (const [index, rawExclusion] of value.entries()) {
    const exclusion = assertExactObject(rawExclusion, EXCLUSION_FIELDS, `eligibility manifest exclusion ${index}`);
    if (typeof exclusion.address !== 'string' || !EVM_ADDRESS.test(exclusion.address)) {
      throw new Error(`eligibility manifest exclusion ${index} address is invalid`);
    }
    if (typeof exclusion.reason !== 'string' || exclusion.reason.length === 0) {
      throw new Error(`eligibility manifest exclusion ${index} reason is invalid`);
    }
    if (previousAddress !== null && compareAddresses(previousAddress, exclusion.address) >= 0) {
      throw new Error('eligibility manifest exclusions must be address-sorted and unique');
    }
    previousAddress = exclusion.address;
    exclusions.push({ address: exclusion.address, reason: exclusion.reason });
  }
  return exclusions;
}

/**
 * Freezes the holder-weight and operational evidence that exists before any USDG payout amount is
 * calculated. This is deliberately a shape validator only; payout construction remains in the
 * later distribution path.
 */
export function createEligibilityPayoutManifest(inputValue) {
  const input = assertExactObject(inputValue, ELIGIBILITY_MANIFEST_INPUT_FIELDS, 'eligibility manifest input');
  if (typeof input.cycleId !== 'string' || input.cycleId.length === 0) {
    throw new Error('eligibility manifest cycleId is invalid');
  }
  assertDecimalString(input.snapshotBlock, 'eligibility manifest snapshotBlock');
  if (typeof input.snapshotHash !== 'string' || !BLOCK_HASH.test(input.snapshotHash)) {
    throw new Error('eligibility manifest snapshotHash is invalid');
  }
  const finality = assertExactObject(input.finality, FINALITY_FIELDS, 'eligibility manifest finality');
  if (typeof finality.policyId !== 'string' || finality.policyId.length === 0) {
    throw new Error('eligibility manifest finality policyId is invalid');
  }
  assertDecimalString(finality.depth, 'eligibility manifest finality depth', { positive: true });
  const supply = assertTypedAmount(input.supply, 'eligibility manifest supply');
  const entries = assertEligibilityEntries(input.entries, supply);
  const exclusions = assertExclusions(input.exclusions);

  const feasibility = assertExactObject(input.feasibility, FEASIBILITY_FIELDS, 'eligibility manifest feasibility');
  for (const field of ['recipientCount', 'transactionCount', 'maxRecipientCount', 'maxTransactionCount']) {
    if (!Number.isInteger(feasibility[field]) || feasibility[field] < 0) {
      throw new Error(`eligibility manifest feasibility ${field} is invalid`);
    }
  }
  if (feasibility.recipientCount !== entries.length || feasibility.transactionCount !== entries.length) {
    throw new Error('eligibility manifest feasibility counts do not match entries');
  }
  assertDecimalString(feasibility.measuredTransferGas, 'eligibility manifest feasibility measuredTransferGas', { positive: true });
  assertDecimalString(feasibility.maxGasPriceWei, 'eligibility manifest feasibility maxGasPriceWei', { positive: true });
  const nativeAmounts = ['estimatedNativeFee', 'nativeReserve', 'nativeBalance', 'requiredNativeAmount']
    .map(field => [field, assertTypedAmount(feasibility[field], `eligibility manifest feasibility ${field}`)]);
  for (const [field, amount] of nativeAmounts) {
    if (amount.chainId !== supply.chainId || amount.assetId !== 'native' || amount.decimals !== 18) {
      throw new Error(`eligibility manifest feasibility ${field} is not a native amount for the snapshot chain`);
    }
  }
  if (typeof feasibility.feasible !== 'boolean') throw new Error('eligibility manifest feasibility feasible is invalid');
  if (feasibility.reason !== null && (typeof feasibility.reason !== 'string' || feasibility.reason.length === 0)) {
    throw new Error('eligibility manifest feasibility reason is invalid');
  }

  const logCompleteness = assertExactObject(input.logCompleteness, LOG_COMPLETENESS_FIELDS, 'eligibility manifest logCompleteness');
  if (!['dual-source', 'single-source-explicitly-allowed'].includes(logCompleteness.mode)) {
    throw new Error('eligibility manifest logCompleteness mode is invalid');
  }
  const primary = assertLogSource(logCompleteness.primary, 'eligibility manifest primary log source');
  const secondary = logCompleteness.secondary === null
    ? null
    : assertLogSource(logCompleteness.secondary, 'eligibility manifest secondary log source');
  if ((logCompleteness.mode === 'dual-source') !== (secondary !== null)) {
    throw new Error('eligibility manifest logCompleteness source mode is inconsistent');
  }
  if (
    secondary !== null
    && (secondary.sourceId === primary.sourceId || secondary.transferLogDigest !== primary.transferLogDigest)
  ) throw new Error('eligibility manifest dual-source evidence must use distinct matching sources');
  if (typeof input.holderSnapshotDigest !== 'string' || !DIGEST.test(input.holderSnapshotDigest)) {
    throw new Error('eligibility manifest holderSnapshotDigest is invalid');
  }
  if (typeof input.launchManifestDigest !== 'string' || !DIGEST.test(input.launchManifestDigest)) {
    throw new Error('eligibility manifest launchManifestDigest is invalid');
  }

  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId: input.cycleId,
    snapshotBlock: input.snapshotBlock,
    snapshotHash: input.snapshotHash,
    finality: { policyId: finality.policyId, depth: finality.depth },
    supply: {
      chainId: supply.chainId,
      assetId: supply.assetId,
      decimals: supply.decimals,
      amountAtomic: supply.amountAtomic,
    },
    entries,
    exclusions,
    feasibility: {
      recipientCount: feasibility.recipientCount,
      transactionCount: feasibility.transactionCount,
      maxRecipientCount: feasibility.maxRecipientCount,
      maxTransactionCount: feasibility.maxTransactionCount,
      measuredTransferGas: feasibility.measuredTransferGas,
      maxGasPriceWei: feasibility.maxGasPriceWei,
      estimatedNativeFee: nativeAmounts[0][1],
      nativeReserve: nativeAmounts[1][1],
      nativeBalance: nativeAmounts[2][1],
      requiredNativeAmount: nativeAmounts[3][1],
      feasible: feasibility.feasible,
      reason: feasibility.reason,
    },
    logCompleteness: {
      mode: logCompleteness.mode,
      primary: { ...primary },
      secondary: secondary === null ? null : { ...secondary },
    },
    holderSnapshotDigest: input.holderSnapshotDigest,
    launchManifestDigest: input.launchManifestDigest,
  };
}

function compareAddresses(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function assertDirectBalances(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty array`);
  const seen = new Set();
  const normalized = [];
  for (const [position, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} entry ${position} must be an object`);
    }
    const { recipient, directHkmnBalance, ...rest } = entry;
    if (Object.keys(rest).length !== 0) throw new Error(`${label} entry ${position} must use the exact schema`);
    assertRecipient(recipient, `${label} entry ${position} recipient`);
    assertDecimalString(directHkmnBalance, `${label} entry ${position} balance`, { positive: true });
    if (seen.has(recipient)) throw new Error(`${label} recipients must be unique`);
    seen.add(recipient);
    normalized.push({ recipient, directHkmnBalance });
  }
  return normalized;
}

function assertPayableEntries(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty array`);
  const seen = new Set();
  const normalized = [];
  for (const [position, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} entry ${position} must be an object`);
    }
    const keys = Object.keys(entry);
    if (
      keys.length !== PAYABLE_ENTRY_FIELDS.length
      || !PAYABLE_ENTRY_FIELDS.every((field) => Object.hasOwn(entry, field))
    ) throw new Error(`${label} entry ${position} must use the exact schema`);
    assertRecipient(entry.recipient, `${label} entry ${position} recipient`);
    assertDecimalString(entry.directHkmnBalance, `${label} entry ${position} balance`, { positive: true });
    assertDecimalString(entry.amountAtomicUSDG, `${label} entry ${position} amount`, { positive: true });
    if (seen.has(entry.recipient)) throw new Error(`${label} recipients must be unique`);
    seen.add(entry.recipient);
    normalized.push({
      recipient: entry.recipient,
      directHkmnBalance: entry.directHkmnBalance,
      amountAtomicUSDG: entry.amountAtomicUSDG,
    });
  }
  return normalized;
}

/**
 * Computes `amount_i = floor(directHkmnBalance_i * distributablePool / totalEligibleSupply)`
 * for every holder, address-sorted for determinism, and returns the exact floor-rounding dust
 * alongside them: `totalAmountAtomicUSDG + dust === distributablePool` always holds exactly.
 *
 * - `distributablePool = proceedsAmount + previousDust`. Pass a prior cycle's returned `dust`
 *   back in as `previousDust` (default `'0'`) to carry it forward, per D6's default.
 * - `totalEligibleSupply` defaults to the sum of `directBalances`; pass it explicitly when the
 *   eligible supply is wider than the balances handed in (e.g. a pre-filtered page).
 * - Holders whose floor amount is zero this cycle are omitted from `entries` --
 *   `reconcile.mjs`'s holder candidate entries require a positive USDG amount per entry -- but
 *   still count toward `totalEligibleSupply`; their unpaid share remains inside `dust`.
 */
export function computeProRataDistribution(inputValue) {
  const input = inputValue && typeof inputValue === 'object' && !Array.isArray(inputValue) ? inputValue : {};
  const directBalances = assertDirectBalances(input.directBalances, 'pro-rata direct balances');
  assertDecimalString(input.proceedsAmount, 'pro-rata proceeds amount');
  const previousDust = input.previousDust === undefined ? '0' : input.previousDust;
  assertDecimalString(previousDust, 'pro-rata previous dust');

  const sorted = [...directBalances].sort((a, b) => compareAddresses(a.recipient, b.recipient));
  const suppliedBalanceTotal = sorted.reduce((sum, entry) => sum + BigInt(entry.directHkmnBalance), 0n);

  let totalEligibleSupply = suppliedBalanceTotal;
  if (input.totalEligibleSupply !== undefined) {
    assertDecimalString(input.totalEligibleSupply, 'pro-rata total eligible supply', { positive: true });
    totalEligibleSupply = BigInt(input.totalEligibleSupply);
    if (totalEligibleSupply < suppliedBalanceTotal) {
      throw new Error('pro-rata total eligible supply must be at least the sum of the supplied direct balances');
    }
  }

  const distributablePool = BigInt(input.proceedsAmount) + BigInt(previousDust);

  let totalDistributed = 0n;
  const entries = [];
  for (const holder of sorted) {
    const balance = BigInt(holder.directHkmnBalance);
    const amount = (balance * distributablePool) / totalEligibleSupply;
    if (amount === 0n) continue;
    totalDistributed += amount;
    entries.push({
      index: entries.length,
      recipient: holder.recipient,
      directHkmnBalance: holder.directHkmnBalance,
      amountAtomicUSDG: amount.toString(),
    });
  }
  const dust = distributablePool - totalDistributed;

  return {
    schema: 'hookemon.pro-rata-distribution.v1',
    proceedsAmount: input.proceedsAmount,
    previousDust,
    distributablePool: distributablePool.toString(),
    totalEligibleSupply: totalEligibleSupply.toString(),
    holderCount: sorted.length,
    payableHolderCount: entries.length,
    totalAmountAtomicUSDG: totalDistributed.toString(),
    dust: dust.toString(),
    entries,
  };
}

/**
 * Convenience wrapper computing the pro-rata distribution directly from a
 * `hookemon.hkmn-holder-snapshot.v1` record (`snapshot-indexer.mjs`'s `buildHolderSnapshot`
 * output): its `directBalances` become the holder set and its `totalHolderBalance` (the
 * post-exclusion eligible supply) becomes `totalEligibleSupply` unless overridden.
 */
export function computeProRataDistributionFromSnapshot(holderSnapshot, {
  proceedsAmount, previousDust, totalEligibleSupply,
} = {}) {
  if (!holderSnapshot || typeof holderSnapshot !== 'object' || !Array.isArray(holderSnapshot.directBalances)) {
    throw new Error('pro-rata holder snapshot is required');
  }
  return computeProRataDistribution({
    directBalances: holderSnapshot.directBalances,
    proceedsAmount,
    previousDust,
    totalEligibleSupply: totalEligibleSupply ?? holderSnapshot.totalHolderBalance,
  });
}

/**
 * Splits `entries` (the `entries` array `computeProRataDistribution` returns) into
 * deterministic, address-sorted, `<=chunkEntryLimit`-entry groups. Each chunk carries its own
 * dense, chunk-local 0-based `index` (matching `CanonicalMerkleSum.TREE_WIDTH` per chunk) and
 * `rootSum` -- the exact amount `PayoutCommitment.commitPayoutChunk(payoutId, chunkIndex,
 * rootHash, rootSum)` would bind for that chunk. Every entry is placed in exactly one chunk, so
 * `sum(chunk.rootSum for chunk in chunks) === totalLiability` exactly, with no entry dropped,
 * reordered, or double counted.
 */
export function chunkProRataEntries(entries, { chunkEntryLimit = CHUNK_ENTRY_LIMIT } = {}) {
  if (!Number.isInteger(chunkEntryLimit) || chunkEntryLimit < 1 || chunkEntryLimit > CHUNK_ENTRY_LIMIT) {
    throw new Error('pro-rata chunk entry limit is invalid');
  }
  const normalized = assertPayableEntries(entries, 'pro-rata chunk entries');
  const sorted = [...normalized].sort((a, b) => compareAddresses(a.recipient, b.recipient));
  const chunkCount = Math.ceil(sorted.length / chunkEntryLimit);
  if (chunkCount > MAX_CHUNKS_PER_DISTRIBUTION) {
    throw new Error(
      `pro-rata distribution requires ${chunkCount} chunks, exceeding MAX_CHUNKS_PER_PAYOUT (${MAX_CHUNKS_PER_DISTRIBUTION})`,
    );
  }

  const chunks = [];
  let totalLiability = 0n;
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const slice = sorted.slice(chunkIndex * chunkEntryLimit, (chunkIndex + 1) * chunkEntryLimit);
    let rootSum = 0n;
    const chunkEntries = slice.map((entry, localIndex) => {
      rootSum += BigInt(entry.amountAtomicUSDG);
      return {
        index: localIndex,
        recipient: entry.recipient,
        directHkmnBalance: entry.directHkmnBalance,
        amountAtomicUSDG: entry.amountAtomicUSDG,
      };
    });
    totalLiability += rootSum;
    chunks.push({ chunkIndex, entryCount: chunkEntries.length, rootSum: rootSum.toString(), entries: chunkEntries });
  }

  return { chunkEntryLimit, chunkCount, totalLiability: totalLiability.toString(), chunks };
}

/**
 * Wraps one chunk (index 0 in today's default single-chunk operational mode, D5) into the exact
 * `{ closedProceedsBasis, snapshot, entries }` shape `reconcile.mjs`'s
 * `deriveHolderDistributionCandidate` already expects, via `snapshot-indexer.mjs`'s
 * `toSnapshotCandidate` projection -- so the compiler's output feeds unmodified into the
 * existing verification pipeline. Only usable while the chunk itself fits within
 * `reconcile.mjs`'s own <=1024-entry candidate ceiling (true for every chunk this module
 * produces, by construction).
 */
export function toHolderCandidateInput({ closedProceedsBasis, holderSnapshot, chunk }) {
  if (!chunk || !Array.isArray(chunk.entries) || chunk.entries.length === 0) {
    throw new Error('pro-rata candidate input requires a nonempty chunk');
  }
  const directBalances = chunk.entries.map(({ recipient, directHkmnBalance }) => ({ recipient, directHkmnBalance }));
  const snapshot = toSnapshotCandidate(holderSnapshot, { directBalances });
  return {
    closedProceedsBasis,
    snapshot,
    entries: chunk.entries.map(({ index, recipient, directHkmnBalance, amountAtomicUSDG }) => (
      { index, recipient, directHkmnBalance, amountAtomicUSDG }
    )),
  };
}
