// Robinhood Chain (EVM, chain id 4663) read/broadcast RPC wrapper, viem-based.
//
// Evidence base (R4 — every fact below was independently re-verified live on 2026-09-02, not
// assumed from prose docs; see scratchpad/w1/summaries/external-facts.json for the full record):
//   - https://rpc.mainnet.chain.robinhood.com serves eth_chainId -> 0x1237 (4663 decimal) and the
//     genesis block hash 0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c.
//   - eth_getBlockByNumber accepts the "finalized"/"safe"/"latest" block tags.
//   - CONFIRMED NEGATIVE FACT: eth_getCode / eth_getProof / eth_call (every *state* read) on this
//     public RPC serve ONLY the "latest" tag — "finalized", "safe", and any explicit historical
//     block number fail with "metadata is not found". This is the opposite of the usual assumption
//     that a public RPC supports historical/finalized state reads, and it shapes every finalized-
//     state read in this module: a state read is always performed at "latest" (recording the block
//     it was read at), then separately confirmed finalized (or not yet) by comparing that block
//     number against a fresh eth_getBlockByNumber("finalized") call — never by asking the state
//     read itself for a "finalized" block.
//
// This module never signs anything and holds no key material (see packages/adapters/README.md).
// `sendRawTransaction` only ever broadcasts bytes an injected signerClient already produced.

import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  isHex,
  parseAbi,
} from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ROBINHOOD_MAINNET_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_GENESIS_HASH = '0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c';

export const robinhoodChain = Object.freeze({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
  rpcUrls: Object.freeze({ default: Object.freeze({ http: Object.freeze([ROBINHOOD_MAINNET_RPC_URL]) }) }),
});

export class RobinhoodRpcError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}
export class RobinhoodFinalityUnavailableError extends RobinhoodRpcError {}
export class RobinhoodMalformedResponseError extends RobinhoodRpcError {}

const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const ERC20_TOTAL_SUPPLY_ABI = parseAbi(['function totalSupply() view returns (uint256)']);
// keccak256("Transfer(address,address,uint256)") — the canonical ERC20 Transfer event topic0,
// a fixed protocol constant, not sourced from any repo binding file.
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_TRANSFER_LOG_PAGE_SIZE = 5000n;
const DEFAULT_TRANSFER_LOG_PAGE_RETRIES = 3;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;
const processRpcFinalizedErc20TransferProofs = new WeakMap();

/**
 * A settlement capability is issued only by this module after it has read the finalized receipt
 * and independent historical balance deltas. It is intentionally runtime-only: callers journal
 * normalized facts, then obtain a fresh capability from a new RPC read on restart.
 */
export function isProcessRpcFinalizedErc20TransferProof(value, expected = {}) {
  if (value === null || typeof value !== 'object') return false;
  const observed = processRpcFinalizedErc20TransferProofs.get(value);
  if (!observed) return false;
  return (expected.hash === undefined || observed.hash === String(expected.hash).toLowerCase())
    && (expected.token === undefined || observed.token === String(expected.token).toLowerCase())
    && (expected.source === undefined || observed.source === String(expected.source).toLowerCase())
    && (expected.recipient === undefined || observed.recipient === String(expected.recipient).toLowerCase())
    && (expected.amountAtomic === undefined || observed.amountAtomic === String(expected.amountAtomic));
}

function assertAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new RobinhoodRpcError(`${label} must be a valid EVM address, got ${JSON.stringify(value)}`);
  }
  return getAddress(value);
}

function assertTxHash(value, label) {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66) {
    throw new RobinhoodRpcError(`${label} must be a 32-byte 0x-prefixed transaction hash, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Constructs a viem PublicClient bound to Robinhood Chain. `transport` may be supplied directly
 * (e.g. `custom({ request })` in tests) instead of `rpcUrl`, so this module never needs a real
 * network to be unit-tested.
 */
export function createRobinhoodClient({ rpcUrl = ROBINHOOD_MAINNET_RPC_URL, transport } = {}) {
  return createPublicClient({
    chain: robinhoodChain,
    transport: transport ?? http(rpcUrl),
  });
}

/**
 * Creates the narrow historical-state capability used only as independent settlement evidence.
 * The caller must construct this around a separately configured archive endpoint; the public
 * Robinhood RPC intentionally cannot satisfy an explicit historical `eth_call`. Each response is
 * paired with an explicit block lookup and rejected unless that lookup reproduces the requested
 * canonical block identity.
 */
export function createHistoricalErc20EvidenceClient({ client } = {}) {
  if (!client || typeof client.readContract !== 'function' || typeof client.getBlock !== 'function') {
    throw new RobinhoodRpcError('historical ERC20 evidence client requires readContract and getBlock');
  }
  return Object.freeze({
    async readErc20BalanceAtBlock({ token, account, blockNumber, blockHash } = {}) {
      const tokenAddress = assertAddress(token, 'token');
      const accountAddress = assertAddress(account, 'account');
      const requestedBlock = assertBlockNumber(blockNumber, 'blockNumber');
      if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash)) {
        throw new RobinhoodRpcError('blockHash must be a 32-byte 0x-prefixed hash');
      }
      const expectedHash = blockHash.toLowerCase();
      const [value, block] = await Promise.all([
        client.readContract({
          address: tokenAddress,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [accountAddress],
          blockNumber: requestedBlock,
        }),
        client.getBlock({ blockNumber: requestedBlock }),
      ]);
      if (typeof value !== 'bigint' || value < 0n) {
        throw new RobinhoodMalformedResponseError('historical ERC20 balance read returned an invalid atomic value');
      }
      const observed = normalizeBlockIdentity(block, requestedBlock, `historical Robinhood RPC block ${requestedBlock}`);
      if (observed.hash !== expectedHash) {
        throw new RobinhoodMalformedResponseError('historical ERC20 balance evidence block hash does not match the requested canonical block');
      }
      return Object.freeze({ value, blockNumber: observed.number, blockHash: observed.hash });
    },
  });
}

/** GET the current chain id directly from the RPC (never assumed from config). */
export async function readChainId(client) {
  return client.getChainId();
}

/** eth_getBlockByNumber("latest", false). Confirmed live to work on the public RPC. */
export async function readLatestBlock(client) {
  const block = await client.getBlock({ blockTag: 'latest' });
  return normalizeTaggedBlockIdentity(block, 'Robinhood RPC latest block');
}

/**
 * eth_getBlockByNumber("finalized", false). Confirmed live to work on the public RPC for block
 * fetches (unlike state reads — see the module header). Use this to learn the current finalized
 * block number/hash, never to read contract/account state directly.
 */
export async function readFinalizedBlock(client) {
  try {
    const block = await client.getBlock({ blockTag: 'finalized' });
    return normalizeTaggedBlockIdentity(block, 'Robinhood RPC finalized block');
  } catch (error) {
    throw new RobinhoodFinalityUnavailableError(
      `Robinhood RPC finalized-block read failed: ${error.message}`,
      { cause: error },
    );
  }
}

function assertBlockNumber(value, label) {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RobinhoodRpcError(`${label} must be a nonnegative bigint`);
  }
  return value;
}

function normalizeTaggedBlockIdentity(block, label) {
  if (!block || typeof block !== 'object') {
    throw new RobinhoodMalformedResponseError(`${label} did not return a block object`);
  }
  if (typeof block.number !== 'bigint' || block.number < 0n) {
    throw new RobinhoodMalformedResponseError(`${label} returned an invalid block number`);
  }
  if (typeof block.hash !== 'string' || !BLOCK_HASH.test(block.hash)) {
    throw new RobinhoodMalformedResponseError(`${label} returned an invalid block hash`);
  }
  if (typeof block.timestamp !== 'bigint') {
    throw new RobinhoodMalformedResponseError(`${label} returned an invalid block timestamp`);
  }
  return { number: block.number, hash: block.hash.toLowerCase(), timestamp: block.timestamp };
}

function normalizeBlockIdentity(block, expectedNumber, label) {
  const normalized = normalizeTaggedBlockIdentity(block, label);
  if (normalized.number !== expectedNumber) {
    throw new RobinhoodMalformedResponseError(`${label} returned an unexpected block number`);
  }
  return normalized;
}

/**
 * Reads one explicit block number and normalizes its identity. Snapshot callers use this only for
 * block metadata, never as a historical contract-state read.
 */
export async function readBlockByNumber(client, blockNumber) {
  const requestedBlock = assertBlockNumber(blockNumber, 'blockNumber');
  try {
    return normalizeBlockIdentity(
      await client.getBlock({ blockNumber: requestedBlock }),
      requestedBlock,
      `Robinhood RPC block ${requestedBlock}`,
    );
  } catch (error) {
    if (error instanceof RobinhoodRpcError) throw error;
    throw new RobinhoodFinalityUnavailableError(
      `Robinhood RPC block ${requestedBlock} read failed: ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * Selects the snapshot block `latest - finalityDepth` only after a finalized-head read proves the
 * candidate is finalized. The returned finalized-head identity is evidence for the caller to bind
 * into its durable snapshot record. The configured depth is intentionally required: the published
 * policy identifier does not encode a numerical depth in this package.
 */
export async function selectFinalizedSnapshotBlock(client, { finalityDepth } = {}) {
  if (typeof finalityDepth !== 'bigint' || finalityDepth <= 0n) {
    throw new RobinhoodFinalityUnavailableError('snapshot finalityDepth must be a positive bigint');
  }
  const [latest, finalizedHead] = await Promise.all([
    readLatestBlock(client),
    readFinalizedBlock(client),
  ]);
  if (typeof latest.number !== 'bigint' || latest.number < finalityDepth) {
    throw new RobinhoodFinalityUnavailableError(
      `snapshot finality depth ${finalityDepth} is unavailable at latest block ${String(latest.number)}`,
    );
  }
  const candidateNumber = latest.number - finalityDepth;
  if (candidateNumber > finalizedHead.number) {
    throw new RobinhoodFinalityUnavailableError(
      `snapshot candidate block ${candidateNumber} is newer than finalized head ${finalizedHead.number}`,
      { candidateNumber, finalizedHead },
    );
  }
  const selected = await readBlockByNumber(client, candidateNumber);
  return { ...selected, finalizedHead };
}

/**
 * Reads an ERC20 `balanceOf` at the chain's current "latest" state (the only tag the public RPC
 * accepts for state reads), and returns the block context of that read alongside the value —
 * never a bare number a caller could mistake for a finalized read.
 */
export async function readTokenBalanceAtLatest(client, { token, account }) {
  const tokenAddress = assertAddress(token, 'token');
  const accountAddress = assertAddress(account, 'account');
  const [value, block] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [accountAddress],
      blockTag: 'latest',
    }),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  return { value, blockNumber: block.number, blockHash: block.hash };
}

/**
 * Confirms whether a state read taken at `blockNumber` (from readTokenBalanceAtLatest or any
 * other "latest" read this module performs) is now finalized, by comparing it against a fresh
 * finalized-block read. Never trusts the "finalized" tag for the state read itself (see header).
 */
export async function confirmReadFinalized(client, blockNumber) {
  if (typeof blockNumber !== 'bigint') {
    throw new RobinhoodRpcError(`blockNumber must be a bigint, got ${typeof blockNumber}`);
  }
  const finalizedBlock = await readFinalizedBlock(client);
  return {
    finalized: blockNumber <= finalizedBlock.number,
    finalizedBlockNumber: finalizedBlock.number,
    finalizedBlockHash: finalizedBlock.hash,
  };
}

/** eth_getTransactionByHash. */
export async function readTransaction(client, hash) {
  const txHash = assertTxHash(hash, 'hash');
  return client.getTransaction({ hash: txHash });
}

/** eth_getTransactionReceipt. */
export async function readTransactionReceipt(client, hash) {
  const txHash = assertTxHash(hash, 'hash');
  return client.getTransactionReceipt({ hash: txHash });
}

function normalizeReceiptInclusion(receipt, transactionHash) {
  invariantRpc(
    typeof receipt?.transactionHash === 'string' && receipt.transactionHash.toLowerCase() === transactionHash.toLowerCase(),
    `receipt for ${transactionHash} reports a different transaction hash`,
  );
  if (receipt.blockNumber === null) return null;
  invariantRpc(
    typeof receipt.blockNumber === 'bigint' && receipt.blockNumber >= 0n,
    `receipt for ${transactionHash} has an invalid block number`,
  );
  invariantRpc(
    typeof receipt.blockHash === 'string' && BLOCK_HASH.test(receipt.blockHash),
    `receipt for ${transactionHash} has an invalid block hash`,
  );
  return Object.freeze({
    number: receipt.blockNumber,
    hash: receipt.blockHash.toLowerCase(),
  });
}

function receiptStabilityFingerprint(receipt) {
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  return JSON.stringify({
    status: receipt?.status === undefined || receipt?.status === null ? null : String(receipt.status),
    logs: logs.map(log => ({
      address: typeof log?.address === 'string' ? log.address.toLowerCase() : null,
      topics: Array.isArray(log?.topics)
        ? log.topics.map(topic => (typeof topic === 'string' ? topic.toLowerCase() : null))
        : null,
      data: typeof log?.data === 'string' ? log.data.toLowerCase() : null,
      logIndex: log?.logIndex === undefined || log?.logIndex === null ? null : String(log.logIndex),
    })),
  });
}

function sameReceiptInclusion(firstReceipt, firstInclusion, secondReceipt, secondInclusion) {
  return firstInclusion?.number === secondInclusion?.number
    && firstInclusion?.hash === secondInclusion?.hash
    && receiptStabilityFingerprint(firstReceipt) === receiptStabilityFingerprint(secondReceipt);
}

function receiptObservation({ receipt, inclusion, finalizedBlock, finalized, reason = null }) {
  return {
    receipt,
    finalized,
    reason,
    receiptBlockNumber: inclusion?.number ?? null,
    receiptBlockHash: inclusion?.hash ?? null,
    finalizedBlockNumber: finalizedBlock.number,
    finalizedBlockHash: finalizedBlock.hash,
  };
}

/**
 * Reads a transaction receipt twice around canonical-block checks. A receipt is final only after
 * its inclusion hash matches the canonical block at or below a fresh finalized head and the
 * second receipt preserves the same inclusion and settlement material.
 */
export async function readFinalizedTransactionReceipt(client, hash) {
  const transactionHash = assertTxHash(hash, 'hash');
  const firstReceipt = await readTransactionReceipt(client, transactionHash);
  const firstInclusion = normalizeReceiptInclusion(firstReceipt, transactionHash);
  const finalizedBlock = await readFinalizedBlock(client);
  if (firstInclusion === null || firstInclusion.number > finalizedBlock.number) {
    return receiptObservation({
      receipt: firstReceipt,
      inclusion: firstInclusion,
      finalizedBlock,
      finalized: false,
      reason: 'RECEIPT_NOT_FINALIZED',
    });
  }
  if (firstInclusion.number === finalizedBlock.number && firstInclusion.hash !== finalizedBlock.hash) {
    return receiptObservation({
      receipt: firstReceipt,
      inclusion: firstInclusion,
      finalizedBlock,
      finalized: false,
      reason: 'RECEIPT_BLOCK_NOT_CANONICAL',
    });
  }
  const canonicalBefore = await readBlockByNumber(client, firstInclusion.number);
  if (canonicalBefore.hash !== firstInclusion.hash) {
    return receiptObservation({
      receipt: firstReceipt,
      inclusion: firstInclusion,
      finalizedBlock,
      finalized: false,
      reason: 'RECEIPT_BLOCK_NOT_CANONICAL',
    });
  }
  const secondReceipt = await readTransactionReceipt(client, transactionHash);
  const secondInclusion = normalizeReceiptInclusion(secondReceipt, transactionHash);
  if (!sameReceiptInclusion(firstReceipt, firstInclusion, secondReceipt, secondInclusion)) {
    return receiptObservation({
      receipt: secondReceipt,
      inclusion: secondInclusion,
      finalizedBlock,
      finalized: false,
      reason: 'RECEIPT_UNSTABLE',
    });
  }
  const canonicalAfter = await readBlockByNumber(client, firstInclusion.number);
  if (canonicalAfter.hash !== firstInclusion.hash) {
    return receiptObservation({
      receipt: secondReceipt,
      inclusion: secondInclusion,
      finalizedBlock,
      finalized: false,
      reason: 'RECEIPT_BLOCK_NOT_CANONICAL',
    });
  }
  return receiptObservation({
    receipt: secondReceipt,
    inclusion: secondInclusion,
    finalizedBlock,
    finalized: true,
  });
}

function receiptSucceeded(receipt) {
  return receipt?.status === 'success' || receipt?.status === '0x1' || receipt?.status === 1 || receipt?.status === 1n;
}

function receiptTransferLog(log, { token, recipient, source, hash }) {
  if (typeof log?.address !== 'string' || log.address.toLowerCase() !== token.toLowerCase()) return null;
  if (!Array.isArray(log.topics) || typeof log.topics[0] !== 'string' || log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) return null;
  invariantRpc(log.topics.length === 3, `receipt ${hash} has a malformed ERC20 Transfer topic count`);
  invariantRpc(
    typeof log.topics[1] === 'string' && typeof log.topics[2] === 'string'
      && /^0x[0-9a-fA-F]{64}$/.test(log.topics[1]) && /^0x[0-9a-fA-F]{64}$/.test(log.topics[2]),
    `receipt ${hash} has malformed ERC20 Transfer topics`,
  );
  invariantRpc(typeof log.data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(log.data), `receipt ${hash} has malformed ERC20 Transfer data`);
  const from = `0x${log.topics[1].slice(-40).toLowerCase()}`;
  const to = `0x${log.topics[2].slice(-40).toLowerCase()}`;
  if (to !== recipient.toLowerCase()) return null;
  if (source !== undefined && from !== source.toLowerCase()) return null;
  const logIndex = log.logIndex;
  invariantRpc(
    (typeof logIndex === 'bigint' && logIndex >= 0n)
      || (typeof logIndex === 'number' && Number.isSafeInteger(logIndex) && logIndex >= 0)
      || (typeof logIndex === 'string' && /^(0|[1-9][0-9]*)$/.test(logIndex)),
    `receipt ${hash} has an invalid ERC20 Transfer log index`,
  );
  return Object.freeze({
    from,
    to,
    amountAtomic: BigInt(log.data).toString(),
    logIndex: String(logIndex),
  });
}

/**
 * Returns finalized, receipt-local USDG credits only. A Relay terminal status is not accepted as
 * settlement evidence: the caller must observe a successful finalized EVM receipt containing an
 * ERC20 Transfer to the exact Operations address.
 */
export async function readFinalizedErc20TransferCredit(client, { hash, token, recipient }) {
  const transactionHash = assertTxHash(hash, 'hash');
  const tokenAddress = assertAddress(token, 'token');
  const recipientAddress = assertAddress(recipient, 'recipient');
  const observation = await readFinalizedTransactionReceipt(client, transactionHash);
  if (!observation.finalized) {
    return Object.freeze({
      ...observation,
      successful: null,
      transfers: Object.freeze([]),
      amountAtomic: null,
    });
  }
  const successful = receiptSucceeded(observation.receipt);
  if (!successful) {
    return Object.freeze({
      ...observation,
      successful: false,
      transfers: Object.freeze([]),
      amountAtomic: '0',
    });
  }
  const transfers = Object.freeze((observation.receipt.logs ?? [])
    .map(log => receiptTransferLog(log, { token: tokenAddress, recipient: recipientAddress, hash: transactionHash }))
    .filter(Boolean));
  const amountAtomic = transfers.reduce((total, transfer) => total + BigInt(transfer.amountAtomic), 0n).toString();
  return Object.freeze({
    ...observation,
    successful: true,
    transfers,
    amountAtomic,
  });
}

function assertAtomicAmount(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RobinhoodRpcError(`${label} must be a nonnegative integer string`);
  }
  return BigInt(value);
}

function unresolvedTransferProof(observation, {
  reason,
  transfers = Object.freeze([]),
  sourceBalanceDeltaAtomic = null,
  recipientBalanceDeltaAtomic = null,
} = {}) {
  return Object.freeze({
    ...observation,
    receiptFinalized: observation.finalized,
    finalized: false,
    successful: null,
    proofAvailable: false,
    reason,
    transfers,
    amountAtomic: null,
    previousBlockNumber: null,
    previousBlockHash: null,
    sourceBalanceBeforeAtomic: null,
    sourceBalanceAfterAtomic: null,
    sourceBalanceDeltaAtomic,
    recipientBalanceBeforeAtomic: null,
    recipientBalanceAfterAtomic: null,
    recipientBalanceDeltaAtomic,
  });
}

function normalizedHistoricalBalance(observation, { blockNumber, blockHash, label }) {
  if (!observation || typeof observation !== 'object') {
    throw new RobinhoodMalformedResponseError(`${label} historical balance evidence did not return an object`);
  }
  const value = observation.value;
  const atomic = typeof value === 'bigint'
    ? value
    : (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null);
  if (atomic === null || atomic < 0n) {
    throw new RobinhoodMalformedResponseError(`${label} historical balance evidence returned an invalid atomic value`);
  }
  if (observation.blockNumber !== blockNumber) {
    throw new RobinhoodMalformedResponseError(`${label} historical balance evidence returned the wrong block number`);
  }
  if (typeof observation.blockHash !== 'string' || observation.blockHash.toLowerCase() !== blockHash) {
    throw new RobinhoodMalformedResponseError(`${label} historical balance evidence returned the wrong block hash`);
  }
  return atomic;
}

async function readCanonicalBlockWithParent(client, blockNumber) {
  const requestedBlock = assertBlockNumber(blockNumber, 'blockNumber');
  const block = await client.getBlock({ blockNumber: requestedBlock });
  const identity = normalizeBlockIdentity(block, requestedBlock, `Robinhood RPC block ${requestedBlock}`);
  invariantRpc(
    typeof block.parentHash === 'string' && BLOCK_HASH.test(block.parentHash),
    `Robinhood RPC block ${requestedBlock} returned an invalid parent hash`,
  );
  return Object.freeze({ ...identity, parentHash: block.parentHash.toLowerCase() });
}

async function readHistoricalTransferBalances(evidenceClient, {
  token,
  source,
  recipient,
  previousBlock,
  receiptBlock,
}) {
  if (!evidenceClient || typeof evidenceClient.readErc20BalanceAtBlock !== 'function') {
    return null;
  }
  const requests = [
    { token, account: source, blockNumber: previousBlock.number, blockHash: previousBlock.hash },
    { token, account: source, blockNumber: receiptBlock.number, blockHash: receiptBlock.hash },
    { token, account: recipient, blockNumber: previousBlock.number, blockHash: previousBlock.hash },
    { token, account: recipient, blockNumber: receiptBlock.number, blockHash: receiptBlock.hash },
  ];
  const observations = await Promise.all(requests.map(request => evidenceClient.readErc20BalanceAtBlock(request)));
  const [sourceBefore, sourceAfter, recipientBefore, recipientAfter] = observations.map((observation, index) => normalizedHistoricalBalance(
    observation,
    {
      blockNumber: requests[index].blockNumber,
      blockHash: requests[index].blockHash,
      label: index < 2 ? 'source' : 'recipient',
    },
  ));
  return Object.freeze({
    sourceBefore,
    sourceAfter,
    recipientBefore,
    recipientAfter,
  });
}

/**
 * Proves a finalized direct ERC20 transfer with independently capable historical balance
 * evidence. `evidenceClient` must implement
 * `readErc20BalanceAtBlock({ token, account, blockNumber, blockHash })`; the public Robinhood
 * RPC is deliberately not used for those reads because it has no historical-state capability.
 *
 * `finalized: true` means the receipt is stable/canonical, the transfer log exactly matches the
 * requested source, recipient, and amount, and both canonical balance deltas equal that amount.
 * A missing, unavailable, or insufficient historical-evidence source returns `finalized: false`
 * with `receiptFinalized: true` when the receipt itself is final, so callers keep the attempt
 * unresolved rather than treating receipt logs as settlement proof.
 */
export async function readFinalizedErc20TransferProof(client, {
  hash,
  token,
  source,
  recipient,
  amountAtomic,
  evidenceClient,
} = {}) {
  const transactionHash = assertTxHash(hash, 'hash');
  const tokenAddress = assertAddress(token, 'token');
  const sourceAddress = assertAddress(source, 'source');
  const recipientAddress = assertAddress(recipient, 'recipient');
  if (sourceAddress === recipientAddress) {
    throw new RobinhoodRpcError('source and recipient must be different addresses');
  }
  const expectedAmount = assertAtomicAmount(amountAtomic, 'amountAtomic');
  const observation = await readFinalizedTransactionReceipt(client, transactionHash);
  if (!observation.finalized) {
    return unresolvedTransferProof(observation, { reason: observation.reason ?? 'RECEIPT_NOT_FINALIZED' });
  }
  if (!receiptSucceeded(observation.receipt)) {
    return Object.freeze({
      ...observation,
      receiptFinalized: true,
      successful: false,
      proofAvailable: true,
      transfers: Object.freeze([]),
      amountAtomic: '0',
      previousBlockNumber: null,
      previousBlockHash: null,
      sourceBalanceBeforeAtomic: null,
      sourceBalanceAfterAtomic: null,
      sourceBalanceDeltaAtomic: null,
      recipientBalanceBeforeAtomic: null,
      recipientBalanceAfterAtomic: null,
      recipientBalanceDeltaAtomic: null,
    });
  }
  const transfers = Object.freeze((observation.receipt.logs ?? [])
    .map(log => receiptTransferLog(log, {
      token: tokenAddress,
      source: sourceAddress,
      recipient: recipientAddress,
      hash: transactionHash,
    }))
    .filter(Boolean));
  const loggedAmount = transfers.reduce((total, transfer) => total + BigInt(transfer.amountAtomic), 0n);
  if (transfers.length === 0 || loggedAmount !== expectedAmount) {
    return unresolvedTransferProof(observation, {
      reason: 'TRANSFER_LOG_MISMATCH',
      transfers,
    });
  }
  if (observation.receiptBlockNumber === null || observation.receiptBlockNumber === 0n) {
    return unresolvedTransferProof(observation, { reason: 'HISTORICAL_BALANCE_EVIDENCE_UNAVAILABLE', transfers });
  }
  let receiptBlock;
  let previousBlock;
  try {
    receiptBlock = await readCanonicalBlockWithParent(client, observation.receiptBlockNumber);
    if (receiptBlock.hash !== observation.receiptBlockHash) {
      return unresolvedTransferProof(observation, { reason: 'RECEIPT_BLOCK_NOT_CANONICAL', transfers });
    }
    previousBlock = await readBlockByNumber(client, observation.receiptBlockNumber - 1n);
    if (receiptBlock.parentHash !== previousBlock.hash) {
      return unresolvedTransferProof(observation, { reason: 'RECEIPT_PARENT_NOT_CANONICAL', transfers });
    }
  } catch (error) {
    if (error instanceof RobinhoodFinalityUnavailableError || error instanceof RobinhoodMalformedResponseError) {
      return unresolvedTransferProof(observation, { reason: 'RECEIPT_BLOCK_NOT_CANONICAL', transfers });
    }
    throw error;
  }
  let balances;
  try {
    balances = await readHistoricalTransferBalances(evidenceClient, {
      token: tokenAddress,
      source: sourceAddress,
      recipient: recipientAddress,
      previousBlock,
      receiptBlock,
    });
  } catch {
    return unresolvedTransferProof(observation, { reason: 'HISTORICAL_BALANCE_EVIDENCE_UNAVAILABLE', transfers });
  }
  if (balances === null) {
    return unresolvedTransferProof(observation, { reason: 'HISTORICAL_BALANCE_EVIDENCE_UNAVAILABLE', transfers });
  }
  const sourceBalanceDelta = balances.sourceBefore - balances.sourceAfter;
  const recipientBalanceDelta = balances.recipientAfter - balances.recipientBefore;
  const sourceBalanceDeltaAtomic = sourceBalanceDelta.toString();
  const recipientBalanceDeltaAtomic = recipientBalanceDelta.toString();
  if (sourceBalanceDelta !== expectedAmount || recipientBalanceDelta !== expectedAmount) {
    return Object.freeze({
      ...unresolvedTransferProof(observation, {
        reason: 'BALANCE_DELTA_MISMATCH',
        transfers,
        sourceBalanceDeltaAtomic,
        recipientBalanceDeltaAtomic,
      }),
      previousBlockNumber: previousBlock.number,
      previousBlockHash: previousBlock.hash,
      receiptBlockTimestampUnixSeconds: receiptBlock.timestamp.toString(),
      sourceBalanceBeforeAtomic: balances.sourceBefore.toString(),
      sourceBalanceAfterAtomic: balances.sourceAfter.toString(),
      recipientBalanceBeforeAtomic: balances.recipientBefore.toString(),
      recipientBalanceAfterAtomic: balances.recipientAfter.toString(),
    });
  }
  const proof = Object.freeze({
    ...observation,
    receiptFinalized: true,
    successful: true,
    proofAvailable: true,
    reason: null,
    transfers,
    amountAtomic: expectedAmount.toString(),
    previousBlockNumber: previousBlock.number,
    previousBlockHash: previousBlock.hash,
    receiptBlockTimestampUnixSeconds: receiptBlock.timestamp.toString(),
    sourceBalanceBeforeAtomic: balances.sourceBefore.toString(),
    sourceBalanceAfterAtomic: balances.sourceAfter.toString(),
    sourceBalanceDeltaAtomic,
    recipientBalanceBeforeAtomic: balances.recipientBefore.toString(),
    recipientBalanceAfterAtomic: balances.recipientAfter.toString(),
    recipientBalanceDeltaAtomic,
  });
  processRpcFinalizedErc20TransferProofs.set(proof, Object.freeze({
    hash: transactionHash.toLowerCase(),
    token: tokenAddress.toLowerCase(),
    source: sourceAddress.toLowerCase(),
    recipient: recipientAddress.toLowerCase(),
    amountAtomic: expectedAmount.toString(),
  }));
  return proof;
}

/**
 * Reads an ERC20 `totalSupply()` at the chain's current "latest" state, alongside the block
 * context of that read — same shape and same "latest only" reasoning as
 * `readTokenBalanceAtLatest` (see this module's header). WP-36: the holder snapshot indexer
 * (`packages/runner/src/distribution/snapshot-indexer.mjs`) requires a ground-truth total supply
 * independently sourced from the same `Transfer` log set it folds, specifically so an incomplete
 * or wrong-range log fetch is caught rather than silently producing a plausible-but-wrong
 * snapshot — this is that independent source.
 */
export async function readTokenTotalSupplyAtLatest(client, { token }) {
  const tokenAddress = assertAddress(token, 'token');
  const [value, block] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: ERC20_TOTAL_SUPPLY_ABI,
      functionName: 'totalSupply',
      blockTag: 'latest',
    }),
    client.getBlock({ blockTag: 'latest' }),
  ]);
  return { value, blockNumber: block.number, blockHash: block.hash };
}

function toHexQuantity(value) {
  return `0x${value.toString(16)}`;
}

function fromHexQuantity(value, label) {
  invariantRpc(typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value), `${label} is not a hex quantity`);
  return BigInt(value);
}

/**
 * Decodes one raw `eth_getLogs` log entry into the canonical `{blockNumber, logIndex, from, to,
 * value}` shape `packages/runner/src/distribution/snapshot-indexer.mjs`'s `buildHolderSnapshot`
 * requires. Deliberately a raw `client.request({method:'eth_getLogs'})` call rather than viem's
 * higher-level `getLogs({event})` action (which silently drops a log it cannot ABI-decode when
 * `strict` is not explicitly `true`, and its event-topic filtering path was independently found,
 * while implementing this function, to not forward a raw `topics` filter at all on the pinned
 * viem version — a caller passing `topics` directly gets every log for the address, unfiltered):
 * manual, explicit, exactly what this module's own house style already uses for `readContract`/
 * `getBlock`, and exactly what a test can assert byte-for-byte.
 */
function decodeTransferLog(log, { signature, token, fromBlockNumber, toBlockNumber }) {
  invariantRpc(
    Array.isArray(log.topics) && log.topics.length === 3 && typeof log.topics[0] === 'string' && log.topics[0].toLowerCase() === ERC20_TRANSFER_TOPIC,
    `${signature} returned a log that is not a well-formed ERC20 Transfer event (topic0 or topic count mismatch)`,
  );
  invariantRpc(
    typeof log.address === 'string' && isAddress(log.address) && log.address.toLowerCase() === token.toLowerCase(),
    `${signature} returned a log for a different token`,
  );
  invariantRpc(log.removed !== true, `${signature} returned a removed log`);
  invariantRpc(
    log.topics.slice(1).every(topic => typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic)),
    `${signature} returned a log with malformed address topics`,
  );
  invariantRpc(typeof log.data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(log.data), `${signature} returned malformed Transfer data`);
  const blockNumber = fromHexQuantity(log.blockNumber, `${signature} log blockNumber`);
  const logIndex = fromHexQuantity(log.logIndex, `${signature} log logIndex`);
  invariantRpc(
    blockNumber >= fromBlockNumber && blockNumber <= toBlockNumber,
    `${signature} returned a log outside its requested block range`,
  );
  return {
    blockNumber: blockNumber.toString(),
    logIndex: logIndex.toString(),
    from: `0x${log.topics[1].slice(-40).toLowerCase()}`,
    to: `0x${log.topics[2].slice(-40).toLowerCase()}`,
    value: BigInt(log.data).toString(),
  };
}

function invariantRpc(condition, message) {
  if (!condition) throw new RobinhoodMalformedResponseError(message);
}

/**
 * Reads one page of ERC20 `Transfer` logs for `[fromBlockNumber, toBlockNumber]` (inclusive),
 * plus the block hash of `toBlockNumber` — read *twice*, once immediately before and once
 * immediately after the `eth_getLogs` call, and compared. A mismatch means the chain reorged the
 * tip of this page's range while the logs were being fetched (the log set collected may now be
 * stale/wrong for that range); this function retries the whole page (fresh hash, fresh
 * `eth_getLogs`) up to `maxRetries` times before giving up with a named error, rather than ever
 * returning a log page whose own recorded block hash cannot be trusted. This is the mechanism the
 * module header's "read at latest with the block hash recorded, then re-confirm" principle takes
 * for a ranged log read, where (unlike a single state read) there is no separate "finalized"
 * comparison available mid-page.
 */
async function readTransferLogPage(client, { token, fromBlockNumber, toBlockNumber, maxRetries }) {
  const params = [{
    address: token,
    topics: [ERC20_TRANSFER_TOPIC],
    fromBlock: toHexQuantity(fromBlockNumber),
    toBlock: toHexQuantity(toBlockNumber),
  }];
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- a genuine sequential read-compare-retry loop.
    const before = await readBlockByNumber(client, toBlockNumber);
    // eslint-disable-next-line no-await-in-loop
    const rawLogs = await client.request({ method: 'eth_getLogs', params });
    invariantRpc(Array.isArray(rawLogs), `eth_getLogs(token=${token}, blocks=${fromBlockNumber}..${toBlockNumber}) did not return an array`);
    // eslint-disable-next-line no-await-in-loop
    const after = await readBlockByNumber(client, toBlockNumber);
    if (before.hash !== after.hash) continue; // reorg mid-fetch: retry the whole page
    return {
      fromBlockNumber,
      toBlockNumber,
      blockHash: after.hash.toLowerCase(),
      logs: rawLogs.map(log => decodeTransferLog(log, {
        signature: `eth_getLogs(token=${token}, blocks=${fromBlockNumber}..${toBlockNumber})`,
        token,
        fromBlockNumber,
        toBlockNumber,
      })),
    };
  }
  throw new RobinhoodFinalityUnavailableError(
    `getTransferLogs: block ${toBlockNumber} reorged on every retry (${maxRetries}) while paging Transfer logs for token ${token} — the page's own block hash could never be confirmed stable`,
  );
}

/**
 * Pages `eth_getLogs` (topic-filtered to the ERC20 `Transfer` event) across `[fromBlock,
 * toBlock]` in `pageSize`-block windows, each page's own block hash recorded and reorg-checked
 * (see `readTransferLogPage`) — never a single unbounded range call, and never a range trusted
 * without its own hash confirmation. Returns `{blockHash, pages, logs}`: `logs` is every decoded
 * `Transfer` in canonical `(blockNumber, logIndex)` ascending order (the exact shape
 * `packages/runner/src/distribution/snapshot-indexer.mjs`'s `buildHolderSnapshot` requires),
 * `pages` is each page's own `{fromBlockNumber, toBlockNumber, blockHash}` for audit, and
 * `blockHash` is the final page's (i.e. `toBlock`'s) confirmed block hash — the snapshot's own
 * `blockHash` field.
 *
 * Never call this with a `toBlock` more recent than a separately-confirmed finalized block (see
 * `readFinalizedBlock`) — this function itself performs no finality check, only reorg detection
 * during the read; a not-yet-finalized `toBlock` can still reorg *after* this function returns.
 */
export async function getTransferLogs(client, {
  token, fromBlock, toBlock, pageSize = DEFAULT_TRANSFER_LOG_PAGE_SIZE, maxRetriesPerPage = DEFAULT_TRANSFER_LOG_PAGE_RETRIES,
} = {}) {
  const tokenAddress = assertAddress(token, 'token');
  if (typeof fromBlock !== 'bigint' || typeof toBlock !== 'bigint') {
    throw new RobinhoodRpcError('getTransferLogs fromBlock/toBlock must be bigints');
  }
  if (fromBlock < 0n || toBlock < fromBlock) {
    throw new RobinhoodRpcError('getTransferLogs requires 0 <= fromBlock <= toBlock');
  }
  if (typeof pageSize !== 'bigint' || pageSize <= 0n) {
    throw new RobinhoodRpcError('getTransferLogs pageSize must be a positive bigint');
  }
  if (!Number.isInteger(maxRetriesPerPage) || maxRetriesPerPage < 1) {
    throw new RobinhoodRpcError('getTransferLogs maxRetriesPerPage must be a positive integer');
  }

  const pageSummaries = [];
  const logs = [];
  let lastBlockHash = null;
  let previousBlockNumber = -1n;
  let previousLogIndex = -1n;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const pageToBlock = (cursor + pageSize - 1n > toBlock) ? toBlock : (cursor + pageSize - 1n);
    // eslint-disable-next-line no-await-in-loop -- pages are read one at a time, in block order,
    // so a later page's reorg-check can never race an earlier page's own read.
    const page = await readTransferLogPage(client, {
      token: tokenAddress, fromBlockNumber: cursor, toBlockNumber: pageToBlock, maxRetries: maxRetriesPerPage,
    });
    pageSummaries.push({ fromBlockNumber: page.fromBlockNumber, toBlockNumber: page.toBlockNumber, blockHash: page.blockHash });
    for (const log of page.logs) {
      const blockNumber = BigInt(log.blockNumber);
      const logIndex = BigInt(log.logIndex);
      if (blockNumber < previousBlockNumber || (blockNumber === previousBlockNumber && logIndex <= previousLogIndex)) {
        throw new RobinhoodMalformedResponseError(
          `getTransferLogs returned logs outside strict canonical (blockNumber, logIndex) order at ${log.blockNumber}:${log.logIndex}`,
        );
      }
      previousBlockNumber = blockNumber;
      previousLogIndex = logIndex;
      logs.push(log);
    }
    lastBlockHash = page.blockHash;
    cursor = pageToBlock + 1n;
  }
  return { blockHash: lastBlockHash, pages: pageSummaries, logs };
}

/**
 * Reads a bounded Transfer-log range tied to an already-selected snapshot hash. The target block
 * is read before and after the complete page scan; either mismatch rejects the entire scan.
 */
export async function getPinnedTransferLogs(client, {
  token,
  fromBlock,
  toBlock,
  snapshotHash,
  pageSize = DEFAULT_TRANSFER_LOG_PAGE_SIZE,
  maxRetriesPerPage = DEFAULT_TRANSFER_LOG_PAGE_RETRIES,
} = {}) {
  if (typeof snapshotHash !== 'string' || !BLOCK_HASH.test(snapshotHash)) {
    throw new RobinhoodRpcError('getPinnedTransferLogs snapshotHash must be a 32-byte hex hash');
  }
  const expectedHash = snapshotHash.toLowerCase();
  const before = await readBlockByNumber(client, toBlock);
  if (before.hash !== expectedHash) {
    throw new RobinhoodFinalityUnavailableError(
      `getPinnedTransferLogs snapshot block ${toBlock} hash changed before log paging`,
    );
  }
  const scanned = await getTransferLogs(client, {
    token,
    fromBlock,
    toBlock,
    pageSize,
    maxRetriesPerPage,
  });
  if (typeof scanned.blockHash !== 'string' || scanned.blockHash.toLowerCase() !== expectedHash) {
    throw new RobinhoodFinalityUnavailableError(
      `getPinnedTransferLogs final page hash does not match snapshot block ${toBlock}`,
    );
  }
  const after = await readBlockByNumber(client, toBlock);
  if (after.hash !== expectedHash) {
    throw new RobinhoodFinalityUnavailableError(
      `getPinnedTransferLogs snapshot block ${toBlock} hash changed after log paging`,
    );
  }
  return { snapshotBlock: toBlock, snapshotHash: expectedHash, ...scanned };
}

/**
 * Broadcasts a pre-signed raw transaction. This module never produces `signedTx` itself — it is
 * handed a signer-produced value (see packages/adapters/README.md's injected signerClient seam).
 */
export async function sendRawTransaction(client, signedTx) {
  if (typeof signedTx !== 'string' || !isHex(signedTx)) {
    throw new RobinhoodRpcError('signedTx must be a 0x-prefixed hex string');
  }
  return client.sendRawTransaction({ serializedTransaction: signedTx });
}

export const ROBINHOOD_CONSTANTS = Object.freeze({
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  ROBINHOOD_MAINNET_RPC_URL,
  ROBINHOOD_GENESIS_HASH,
});
