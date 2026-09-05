// Holder snapshot indexer.
//
// Folds a finalized-block-bounded set of HKMN `Transfer` logs into an authenticated,
// content-addressed holder-balance snapshot. The fold is a pure function of its inputs
// (transfer logs, exclusion list, finalized block metadata, ground-truth total supply) —
// no RPC call, no clock, no local state. That is deliberate: it is what makes the output
// independently reproducible byte-for-byte by a second, unrelated builder given the same
// finalized block (TB-16's dual-builder requirement), which an `eth_call`-derived balance
// read (subject to node-implementation/state-pruning differences) would not guarantee.
//
// Two responsibilities are intentionally kept OUT of this module and pushed to its caller:
//
//   - Fetching the `Transfer` logs themselves belongs to the Robinhood adapter. This package
//     receives only the normalized tuple sequence and never dials an RPC endpoint.
//   - Resolving excluded addresses belongs to an immutable deployment manifest and its role
//     history. This module receives those addresses with a reason and ensures none becomes a
//     payable holder.
//
// All amounts and chain-scale integers are canonical decimal strings (never JS numbers), so
// nothing here loses precision or depends on floating-point rounding.

import { createHash } from 'node:crypto';

import { assertDigest } from '../cycle/schemas.mjs';

export const HOLDER_SNAPSHOT_SCHEMA = 'hookemon.hkmn-holder-snapshot.v1';
export const SNAPSHOT_CANDIDATE_SCHEMA = 'hookemon.input-bound-hkmn-snapshot-candidate.v1';
export const SNAPSHOT_CANDIDATE_AUTHORITY = 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED';
export const TRANSFER_LOG_REPLAY_SCHEMA = 'hookemon.hkmn-transfer-log-replay.v1';
export const ELIGIBILITY_HOLDER_SET_SCHEMA = 'hookemon.eligibility-holder-set.v1';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^(?:[1-9][0-9]*)$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

const SNAPSHOT_INPUT_FIELDS = [
  'chainId', 'tokenAddress', 'blockNumber', 'blockHash', 'finalized',
  'totalSupply', 'excludedAddresses', 'transferLogs',
];
const TRANSFER_LOG_FIELDS = ['blockNumber', 'logIndex', 'from', 'to', 'value'];
const EXCLUDED_ADDRESS_FIELDS = ['address', 'reason'];
const DIRECT_BALANCE_FIELDS = ['recipient', 'directHkmnBalance'];
const HOLDER_SNAPSHOT_CONTENT_FIELDS = [
  'schema', 'chainId', 'tokenAddress', 'blockNumber', 'blockHash', 'finalized',
  'totalSupply', 'totalHolderBalance', 'totalExcludedBalance', 'holderCount',
  'excludedAddresses', 'directBalances',
];
const HOLDER_SNAPSHOT_FIELDS = [...HOLDER_SNAPSHOT_CONTENT_FIELDS, 'holderSnapshotDigest'];
const ELIGIBILITY_HOLDER_SET_INPUT_FIELDS = [
  'chainId', 'tokenAddress', 'tokenDecimals', 'snapshotBlock', 'snapshotHash',
  'supply', 'exclusions', 'transferLogs',
];
const TYPED_AMOUNT_FIELDS = ['chainId', 'assetId', 'decimals', 'amountAtomic'];

function assertExactShape(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} symbols are unsupported`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.length !== fields.length
    || !fields.every(field => Object.hasOwn(descriptors, field))
    || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
  ) throw new Error(`${label} must use the exact schema`);
  return value;
}

function assertBoundedArray(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min
    || value.length > max
  ) throw new Error(`${label} must contain between ${min} and ${max} entries`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} symbols are unsupported`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) {
    throw new Error(`${label} must be dense and unadorned`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be dense and unadorned`);
    }
  }
  return value;
}

function assertAddress(value, label, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Error(`${label} must be a canonical lowercase EVM address`);
  if (!allowZero && value === ZERO_ADDRESS) throw new Error(`${label} must be nonzero`);
}

function assertDecimalString(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !(positive ? POSITIVE_DECIMAL : DECIMAL).test(value)) {
    throw new Error(`${label} must be a canonical decimal string`);
  }
}

function assertTokenDecimals(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} must be an integer between 0 and 255`);
  }
}

function assertTypedHkmnAmount(value, label, { chainId, tokenAddress, decimals }) {
  const amount = assertExactShape(value, TYPED_AMOUNT_FIELDS, label);
  assertDecimalString(amount.chainId, `${label} chainId`, { positive: true });
  assertAddress(amount.assetId, `${label} assetId`);
  assertTokenDecimals(amount.decimals, `${label} decimals`);
  assertDecimalString(amount.amountAtomic, `${label} amountAtomic`);
  if (amount.chainId !== chainId || amount.assetId !== tokenAddress || amount.decimals !== decimals) {
    throw new Error(`${label} does not identify the snapshot token`);
  }
  return amount;
}

function appendCanonicalJson(hash, value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('snapshot digest value is unsupported');
    hash.update(encoded);
    return;
  }
  if (Array.isArray(value)) {
    hash.update('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) hash.update(',');
      appendCanonicalJson(hash, value[index]);
    }
    hash.update(']');
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    hash.update('{');
    const keys = Object.keys(value).sort();
    for (const [index, key] of keys.entries()) {
      if (index > 0) hash.update(',');
      hash.update(JSON.stringify(key));
      hash.update(':');
      appendCanonicalJson(hash, value[key]);
    }
    hash.update('}');
    return;
  }
  throw new Error('snapshot digest value is unsupported');
}

function snapshotDigest(value) {
  const hash = createHash('sha256');
  appendCanonicalJson(hash, value);
  return `sha256:${hash.digest('hex')}`;
}

function compareAddresses(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Folds an ordered set of `Transfer` logs into a balance map, failing closed the moment the
 * log set is provably incomplete (a debit exceeding the running balance) or out of the chain's
 * own canonical (blockNumber, logIndex) order. Returns the running balances plus the total
 * minted (from the zero address) and burned (to the zero address) so the caller can cross-check
 * the fold against an independently sourced ground-truth total supply.
 */
function foldTransferLogs(transferLogs, snapshotBlockNumber) {
  assertBoundedArray(transferLogs, 'holder snapshot transfer logs');
  const snapshotBlock = BigInt(snapshotBlockNumber);
  const balances = new Map();
  let previousBlock = -1n;
  let previousLogIndex = -1n;
  let mintedTotal = 0n;
  let burnedTotal = 0n;
  for (const [position, entry] of transferLogs.entries()) {
    const log = assertExactShape(entry, TRANSFER_LOG_FIELDS, `holder snapshot transfer log ${position}`);
    assertDecimalString(log.blockNumber, `holder snapshot transfer log ${position} block number`);
    assertDecimalString(log.logIndex, `holder snapshot transfer log ${position} log index`);
    assertAddress(log.from, `holder snapshot transfer log ${position} from`, { allowZero: true });
    assertAddress(log.to, `holder snapshot transfer log ${position} to`, { allowZero: true });
    assertDecimalString(log.value, `holder snapshot transfer log ${position} value`);

    const blockNumber = BigInt(log.blockNumber);
    const logIndex = BigInt(log.logIndex);
    if (blockNumber > snapshotBlock) {
      throw new Error(`holder snapshot transfer log ${position} is newer than the finalized snapshot block`);
    }
    if (blockNumber < previousBlock || (blockNumber === previousBlock && logIndex <= previousLogIndex)) {
      throw new Error(`holder snapshot transfer log ${position} is out of canonical (blockNumber, logIndex) order`);
    }
    previousBlock = blockNumber;
    previousLogIndex = logIndex;

    const value = BigInt(log.value);
    if (value === 0n) continue;

    if (log.from === ZERO_ADDRESS) {
      mintedTotal += value;
    } else {
      const current = balances.get(log.from) ?? 0n;
      if (current < value) {
        throw new Error(
          `holder snapshot transfer log ${position} debits more than the running balance — the transfer-log set is incomplete`,
        );
      }
      balances.set(log.from, current - value);
    }

    if (log.to === ZERO_ADDRESS) {
      burnedTotal += value;
    } else {
      balances.set(log.to, (balances.get(log.to) ?? 0n) + value);
    }
  }
  return { balances, mintedTotal, burnedTotal };
}

/**
 * Builds `hookemon.hkmn-holder-snapshot.v1` from a caller-supplied finalized-block bundle:
 * chain/token/block identity, a ground-truth total supply (independently sourced — NOT
 * derived from the same log set, so it can act as a completeness check on that log set),
 * the exclusion list (pool, hook, vault, every per-cycle escrow, treasury — each with a
 * justification), and the ordered transfer-log fixture itself.
 *
 * Excluded addresses are removed from `directBalances` unconditionally — their balances are
 * still accounted for (in `totalExcludedBalance`, disclosed, never hidden) but they can never
 * be emitted as a payable holder.
 *
 * Throws if the folded (minted - burned) total disagrees with the supplied `totalSupply`: this
 * is the primary defense against an incomplete or wrong-range log fetch producing a plausible
 * but wrong snapshot.
 */
export function buildHolderSnapshot(input) {
  const value = assertExactShape(input, SNAPSHOT_INPUT_FIELDS, 'holder snapshot input');
  assertDecimalString(value.chainId, 'holder snapshot chainId', { positive: true });
  assertAddress(value.tokenAddress, 'holder snapshot token address');
  assertDecimalString(value.blockNumber, 'holder snapshot block number');
  if (typeof value.blockHash !== 'string' || !BLOCK_HASH.test(value.blockHash)) {
    throw new Error('holder snapshot block hash is invalid');
  }
  if (value.finalized !== true) throw new Error('holder snapshot must be built from a finalized block');
  assertDecimalString(value.totalSupply, 'holder snapshot total supply');

  const excludedAddressesInput = assertBoundedArray(
    value.excludedAddresses,
    'holder snapshot excluded addresses',
    {},
  );
  const excludedByAddress = new Map();
  for (const [position, entry] of excludedAddressesInput.entries()) {
    const excluded = assertExactShape(entry, EXCLUDED_ADDRESS_FIELDS, `holder snapshot excluded address ${position}`);
    assertAddress(excluded.address, `holder snapshot excluded address ${position} address`, { allowZero: true });
    if (typeof excluded.reason !== 'string' || excluded.reason.length === 0) {
      throw new Error(`holder snapshot excluded address ${position} reason is invalid`);
    }
    if (excludedByAddress.has(excluded.address)) throw new Error('holder snapshot excluded addresses must be unique');
    excludedByAddress.set(excluded.address, excluded.reason);
  }

  const { balances, mintedTotal, burnedTotal } = foldTransferLogs(value.transferLogs, value.blockNumber);
  const derivedTotalSupply = mintedTotal - burnedTotal;
  if (derivedTotalSupply !== BigInt(value.totalSupply)) {
    throw new Error(
      'holder snapshot total supply does not reconcile with the folded transfer-log set '
      + '(mint minus burn) — the log range is incomplete or the supplied total supply is wrong',
    );
  }

  let totalHolderBalance = 0n;
  let totalExcludedBalance = 0n;
  const directBalances = [];
  for (const [address, balance] of balances) {
    if (balance <= 0n) continue;
    if (excludedByAddress.has(address)) {
      totalExcludedBalance += balance;
      continue;
    }
    totalHolderBalance += balance;
    directBalances.push({ recipient: address, directHkmnBalance: balance.toString() });
  }
  directBalances.sort((a, b) => compareAddresses(a.recipient, b.recipient));

  const excludedAddresses = [...excludedByAddress.entries()]
    .map(([address, reason]) => ({ address, reason }))
    .sort((a, b) => compareAddresses(a.address, b.address));

  const content = {
    schema: HOLDER_SNAPSHOT_SCHEMA,
    chainId: value.chainId,
    tokenAddress: value.tokenAddress,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    finalized: true,
    totalSupply: value.totalSupply,
    totalHolderBalance: totalHolderBalance.toString(),
    totalExcludedBalance: totalExcludedBalance.toString(),
    holderCount: directBalances.length,
    excludedAddresses,
    directBalances,
  };
  return {
    ...content,
    holderSnapshotDigest: snapshotDigest({ domain: HOLDER_SNAPSHOT_SCHEMA, snapshot: content }),
  };
}

/**
 * Re-validates a fully-formed `hookemon.hkmn-holder-snapshot.v1` record (e.g. one loaded from
 * disk, or received from a second, independent builder) and recomputes its digest, failing
 * closed on any structural or digest mismatch. This is what lets a verifier confirm two
 * independently produced snapshots for the same finalized block are byte-identical: build
 * both, then compare `holderSnapshotDigest` (or the full parsed record).
 */
export function assertHolderSnapshot(value) {
  const snapshot = assertExactShape(value, HOLDER_SNAPSHOT_FIELDS, 'holder snapshot');
  if (snapshot.schema !== HOLDER_SNAPSHOT_SCHEMA) throw new Error('holder snapshot schema is invalid');
  assertDecimalString(snapshot.chainId, 'holder snapshot chainId', { positive: true });
  assertAddress(snapshot.tokenAddress, 'holder snapshot token address');
  assertDecimalString(snapshot.blockNumber, 'holder snapshot block number');
  if (typeof snapshot.blockHash !== 'string' || !BLOCK_HASH.test(snapshot.blockHash)) {
    throw new Error('holder snapshot block hash is invalid');
  }
  if (snapshot.finalized !== true) throw new Error('holder snapshot must be finalized');
  assertDecimalString(snapshot.totalSupply, 'holder snapshot total supply');
  assertDecimalString(snapshot.totalHolderBalance, 'holder snapshot total holder balance');
  assertDecimalString(snapshot.totalExcludedBalance, 'holder snapshot total excluded balance');
  if (!Number.isInteger(snapshot.holderCount) || snapshot.holderCount < 0) {
    throw new Error('holder snapshot holder count is invalid');
  }

  const excludedAddresses = assertBoundedArray(
    snapshot.excludedAddresses,
    'holder snapshot excluded addresses',
    {},
  );
  const excludedSet = new Set();
  let previousExcluded = null;
  for (const [position, entry] of excludedAddresses.entries()) {
    const excluded = assertExactShape(entry, EXCLUDED_ADDRESS_FIELDS, `holder snapshot excluded address ${position}`);
    assertAddress(excluded.address, `holder snapshot excluded address ${position} address`, { allowZero: true });
    if (typeof excluded.reason !== 'string' || excluded.reason.length === 0) {
      throw new Error(`holder snapshot excluded address ${position} reason is invalid`);
    }
    if (previousExcluded !== null && compareAddresses(previousExcluded, excluded.address) >= 0) {
      throw new Error('holder snapshot excluded addresses must be sorted and unique');
    }
    previousExcluded = excluded.address;
    excludedSet.add(excluded.address);
  }

  const directBalances = assertBoundedArray(
    snapshot.directBalances,
    'holder snapshot direct balances',
    {},
  );
  let totalHolderBalance = 0n;
  let previousRecipient = null;
  for (const [position, entry] of directBalances.entries()) {
    const balance = assertExactShape(entry, DIRECT_BALANCE_FIELDS, `holder snapshot direct balance ${position}`);
    assertAddress(balance.recipient, `holder snapshot direct balance ${position} recipient`);
    assertDecimalString(balance.directHkmnBalance, `holder snapshot direct balance ${position} balance`, { positive: true });
    if (excludedSet.has(balance.recipient)) throw new Error('holder snapshot excluded addresses must never appear as a recipient');
    if (previousRecipient !== null && compareAddresses(previousRecipient, balance.recipient) >= 0) {
      throw new Error('holder snapshot direct balances must be sorted and unique');
    }
    previousRecipient = balance.recipient;
    totalHolderBalance += BigInt(balance.directHkmnBalance);
  }
  if (directBalances.length !== snapshot.holderCount) throw new Error('holder snapshot holder count mismatch');
  if (totalHolderBalance !== BigInt(snapshot.totalHolderBalance)) {
    throw new Error('holder snapshot total holder balance does not match its direct balances');
  }

  const { holderSnapshotDigest, ...content } = snapshot;
  assertDigest(holderSnapshotDigest, 'holder snapshot digest');
  if (holderSnapshotDigest !== snapshotDigest({ domain: HOLDER_SNAPSHOT_SCHEMA, snapshot: content })) {
    throw new Error('holder snapshot digest mismatch');
  }
  return snapshot;
}

/**
 * Hashes the exact canonical Transfer tuple sequence before balances are folded. A second log
 * source compares this value to detect an omitted ordinary transfer even when mint-minus-burn
 * still matches the immutable supply.
 */
export function digestTransferLogReplay({ snapshotBlock, transferLogs } = {}) {
  assertDecimalString(snapshotBlock, 'transfer-log replay snapshot block');
  foldTransferLogs(transferLogs, snapshotBlock);
  return snapshotDigest({
    domain: TRANSFER_LOG_REPLAY_SCHEMA,
    snapshotBlock,
    transferLogs,
  });
}

/**
 * Materializes the holder side of a pre-claim eligibility manifest. It intentionally retains
 * every positive non-excluded holder; downstream feasibility, not a fixed holder limit, decides
 * whether a cycle can proceed.
 */
export function buildEligibilityHolderSet(input) {
  const value = assertExactShape(input, ELIGIBILITY_HOLDER_SET_INPUT_FIELDS, 'eligibility holder set input');
  assertDecimalString(value.chainId, 'eligibility holder set chainId', { positive: true });
  assertAddress(value.tokenAddress, 'eligibility holder set token address');
  assertTokenDecimals(value.tokenDecimals, 'eligibility holder set token decimals');
  assertDecimalString(value.snapshotBlock, 'eligibility holder set snapshot block');
  if (typeof value.snapshotHash !== 'string' || !BLOCK_HASH.test(value.snapshotHash)) {
    throw new Error('eligibility holder set snapshot hash is invalid');
  }
  const supply = assertTypedHkmnAmount(value.supply, 'eligibility holder set supply', {
    chainId: value.chainId,
    tokenAddress: value.tokenAddress,
    decimals: value.tokenDecimals,
  });
  const holderSnapshot = buildHolderSnapshot({
    chainId: value.chainId,
    tokenAddress: value.tokenAddress,
    blockNumber: value.snapshotBlock,
    blockHash: value.snapshotHash,
    finalized: true,
    totalSupply: supply.amountAtomic,
    excludedAddresses: value.exclusions,
    transferLogs: value.transferLogs,
  });
  return {
    schema: ELIGIBILITY_HOLDER_SET_SCHEMA,
    snapshotBlock: value.snapshotBlock,
    snapshotHash: value.snapshotHash,
    supply: {
      chainId: supply.chainId,
      assetId: supply.assetId,
      decimals: supply.decimals,
      amountAtomic: supply.amountAtomic,
    },
    entries: holderSnapshot.directBalances.map(({ recipient, directHkmnBalance }) => ({
      recipient,
      hkmnBalance: {
        chainId: supply.chainId,
        assetId: supply.assetId,
        decimals: supply.decimals,
        amountAtomic: directHkmnBalance,
      },
    })),
    exclusions: holderSnapshot.excludedAddresses.map(({ address, reason }) => ({ address, reason })),
    transferLogDigest: digestTransferLogReplay({
      snapshotBlock: value.snapshotBlock,
      transferLogs: value.transferLogs,
    }),
    holderSnapshotDigest: holderSnapshot.holderSnapshotDigest,
  };
}

/**
 * Projects a `hookemon.hkmn-holder-snapshot.v1` record into the exact
 * `hookemon.input-bound-hkmn-snapshot-candidate.v1` shape `reconcile.mjs`'s `validateSnapshot`
 * already expects, so the output of this module can be handed straight to
 * `deriveHolderDistributionCandidate` unmodified.
 *
 * A holder set larger than 1024 must be chunked (the pro-rata compiler's job, not this
 * module's) before conversion; pass the chunk's own `directBalances` via `directBalances` to
 * build a per-chunk candidate without hand-rolling the projection again.
 */
export function toSnapshotCandidate(holderSnapshot, { directBalances } = {}) {
  if (!holderSnapshot || typeof holderSnapshot !== 'object') throw new Error('holder snapshot is required');
  const balances = assertBoundedArray(
    directBalances ?? holderSnapshot.directBalances,
    'holder snapshot candidate direct balances',
    { min: 1, max: 1024 },
  );
  return {
    schema: SNAPSHOT_CANDIDATE_SCHEMA,
    authority: SNAPSHOT_CANDIDATE_AUTHORITY,
    asset: 'HKMN',
    chainId: holderSnapshot.chainId,
    tokenAddress: holderSnapshot.tokenAddress,
    blockNumber: holderSnapshot.blockNumber,
    blockHash: holderSnapshot.blockHash,
    finalized: true,
    directBalances: balances.map(({ recipient, directHkmnBalance }) => ({ recipient, directHkmnBalance })),
  };
}
