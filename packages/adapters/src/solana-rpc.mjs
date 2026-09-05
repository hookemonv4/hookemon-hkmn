// Solana RPC wrapper for the peg cycle's pack-purchase/buyback leg: raw JSON-RPC reads/broadcast
// (dependency-injected `fetchImpl`, mirroring packages/adapters/src/relay-client.mjs's house
// style exactly) plus @solana/web3.js for the parts that are genuinely transaction/instruction
// construction, not RPC I/O (`PublicKey`, `TransactionInstruction`, legacy `Transaction`).
//
// Evidence base (R4, cross-checked live 2026-09-02 — see scratchpad/w1/summaries/external-facts.json):
//   - Circle USD mainnet mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (6 decimals),
//     TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA SPL Token program — VERIFIED live via Relay's
//     Chains API and matches this repo's other pinned Solana reference (relay-client.mjs).
//   - ASSOCIATED_TOKEN_PROGRAM_ID (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL) is Solana's
//     well-known, immutable Associated Token Account program id — public, non-provider-specific
//     constant, not sourced from any repo binding file.
//   - `@solana/web3.js` 1.98.4 (pinned in package.json) is used only for `PublicKey` derivation
//     and `TransactionInstruction`/`Transaction` construction/(de)serialization — never for RPC
//     transport, so every RPC call in this module stays independently testable via an injected
//     `fetchImpl`, matching relay-client.mjs.
//
// This module never signs anything and holds no key material (see packages/adapters/README.md):
// `buildTokenTransferInstruction`/`buildUnsignedTransaction` produce unsigned transaction bytes
// for an injected signerClient to sign; `submitSignedTransaction` only ever broadcasts bytes that
// signer already produced.

import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';

export const SOLANA_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';
// Relay's own cross-chain numbering for Solana (not a Solana-native concept — Solana identifies
// its networks by cluster + genesis hash, not a chain id). Kept here only because relay-client.mjs
// and the peg-cycle authorization schema both reference it; never treated as a Solana RPC parameter.
export const SOLANA_RELAY_CHAIN_ID = 792703809;
export const CIRCLE_USD_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CIRCLE_USD_DECIMALS = 6;
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
/** Metaplex Core (mpl-core) program. Collector Crypt gacha cards are Core assets, not SPL mints:
 * an opened card reaches the operator wallet via a Core `TransferV1` (discriminator 14) whose
 * first account is the asset, and Core assets carry no token accounts, so they never appear in
 * `pre`/`postTokenBalances` (observed on the mainnet open transaction
 * 4Sou2f5Sb6tgSUrCjdyBGXFDGUStznwQRJErGZZmqjQzpeSmZzPgSvreRzgE9aVjvqGaXbnu1eKt2VmXbNKwM536). */
export const MPL_CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const MPL_CORE_TRANSFER_V1_DISCRIMINATOR = 14;
const MPL_CORE_KEY_ASSET_V1 = 1;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Minimal base58 decoder for jsonParsed instruction `data` (bs58 is not a direct dependency). */
function decodeBase58(value) {
  const bytes = [];
  for (const char of value) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) throw new SolanaMalformedResponseError(`invalid base58 character "${char}"`);
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingOnes = 0;
  while (leadingOnes < value.length && value[leadingOnes] === '1') leadingOnes += 1;
  return Uint8Array.from([...new Array(leadingOnes).fill(0), ...bytes.reverse()]);
}

function encodeBase58(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
  if (bytes.length === 0) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  return `${'1'.repeat(leadingZeros)}${digits.reverse().map(digit => BASE58_ALPHABET[digit]).join('')}`;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_COMMITMENT = 'finalized';
const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const processRpcRelayDestinationObservations = new WeakMap();

/**
 * Runtime-only capability for a finalized destination observation read through this module's RPC
 * client. Durable settlement records retain normalized facts, and a restart obtains new evidence.
 */
export function isProcessRpcRelayDestinationObservation(value, expected = {}) {
  if (value === null || typeof value !== 'object') return false;
  const observed = processRpcRelayDestinationObservations.get(value);
  if (!observed) return false;
  return (expected.owner === undefined || observed.owner === expected.owner)
    && (expected.relayRequestId === undefined || observed.relayRequestId === expected.relayRequestId);
}

export class SolanaAdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}
export class SolanaNetworkError extends SolanaAdapterError {}
export class SolanaRpcError extends SolanaAdapterError {}
export class SolanaMalformedResponseError extends SolanaAdapterError {}

function invariant(condition, ErrorClass, message, details) {
  if (!condition) throw new ErrorClass(message, details);
}

function defaultFetchImpl(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

let nextRequestId = 1;

/**
 * Raw JSON-RPC 2.0 POST, one method per call — deliberately not web3.js's own batching
 * `Connection`, so every request this module makes is exactly the request a test asserts on.
 */
async function solanaRequest({ rpcUrl, method, params = [], fetchImpl, timeoutMs }) {
  const body = { jsonrpc: '2.0', id: nextRequestId++, method, params };
  let response;
  try {
    response = await fetchImpl(
      rpcUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
      timeoutMs,
    );
  } catch (error) {
    throw new SolanaNetworkError(`Solana RPC request ${method} failed: ${error.message}`, { cause: error, method });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch (error) {
    throw new SolanaMalformedResponseError(`Solana RPC response for ${method} was not valid JSON (HTTP ${response.status})`, {
      httpStatus: response.status, method, bodyPreview: text.slice(0, 500),
    });
  }

  if (!response.ok) {
    throw new SolanaRpcError(`Solana RPC ${method} returned HTTP ${response.status}`, { httpStatus: response.status, method, raw: parsed });
  }
  if (parsed.error) {
    throw new SolanaRpcError(`Solana RPC ${method} returned an error: ${parsed.error.message ?? 'unknown'}`, {
      method, code: parsed.error.code ?? null, rpcMessage: parsed.error.message ?? null, raw: parsed,
    });
  }
  invariant(Object.hasOwn(parsed, 'result'), SolanaMalformedResponseError, `Solana RPC response for ${method} is missing a result field`, { method, raw: parsed });
  return parsed.result;
}

/**
 * Constructs a lightweight RPC client. This is intentionally not a `@solana/web3.js` `Connection`
 * — every method call in this module goes through `solanaRequest` above with an injectable
 * `fetchImpl`, so tests never need a real network or a mocked `Connection` internals.
 */
export function createSolanaRpcClient({
  rpcUrl = SOLANA_MAINNET_RPC_URL,
  fetchImpl = defaultFetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  commitment = DEFAULT_COMMITMENT,
} = {}) {
  return Object.freeze({ rpcUrl, fetchImpl, timeoutMs, commitment });
}

function rpc(client, method, params) {
  return solanaRequest({ rpcUrl: client.rpcUrl, method, params, fetchImpl: client.fetchImpl, timeoutMs: client.timeoutMs });
}

function assertPublicKey(value, label) {
  try {
    return new PublicKey(value);
  } catch (error) {
    throw new SolanaAdapterError(`${label} is not a valid Solana public key: ${value}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** getBalance — lamports held directly by an account (native SOL, not an SPL token balance). */
export async function readSolBalance(client, pubkey) {
  const key = assertPublicKey(pubkey, 'pubkey');
  const result = await rpc(client, 'getBalance', [key.toBase58(), { commitment: client.commitment }]);
  invariant(typeof result?.value === 'number', SolanaMalformedResponseError, 'getBalance response is missing a numeric value');
  return BigInt(result.value);
}

/** getTokenAccountBalance — the SPL token balance held by a specific token account. */
export async function readTokenAccountBalance(client, tokenAccount) {
  const key = assertPublicKey(tokenAccount, 'tokenAccount');
  const result = await rpc(client, 'getTokenAccountBalance', [key.toBase58(), { commitment: client.commitment }]);
  invariant(result?.value?.amount !== undefined, SolanaMalformedResponseError, 'getTokenAccountBalance response is missing value.amount');
  return { amount: BigInt(result.value.amount), decimals: result.value.decimals, uiAmountString: result.value.uiAmountString };
}

/** getLatestBlockhash — required to build any unsigned transaction. */
export async function readLatestBlockhash(client) {
  const result = await rpc(client, 'getLatestBlockhash', [{ commitment: client.commitment }]);
  invariant(typeof result?.value?.blockhash === 'string', SolanaMalformedResponseError, 'getLatestBlockhash response is missing value.blockhash');
  return { blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight };
}

/** getBlockHeight at the client's commitment, used to evaluate a provider transaction deadline. */
export async function readBlockHeight(client) {
  const result = await rpc(client, 'getBlockHeight', [{ commitment: client.commitment }]);
  invariant(Number.isSafeInteger(result) && result >= 0, SolanaMalformedResponseError, 'getBlockHeight response is not a non-negative safe integer');
  return BigInt(result);
}

/** isBlockhashValid proves that a provider-supplied recent blockhash remains usable before signing. */
export async function readBlockhashValidity(client, blockhash) {
  const key = assertPublicKey(blockhash, 'blockhash');
  const result = await rpc(client, 'isBlockhashValid', [key.toBase58(), { commitment: client.commitment }]);
  invariant(typeof result?.value === 'boolean', SolanaMalformedResponseError, 'isBlockhashValid response is missing boolean value');
  return result.value;
}

/** Reads a fresh blockhash and rejects it when the RPC already considers it invalid. */
export async function readUsableLatestBlockhash(client) {
  const latest = await readLatestBlockhash(client);
  if (!(await readBlockhashValidity(client, latest.blockhash))) {
    throw new SolanaAdapterError('latest Solana blockhash is no longer valid before signing');
  }
  return latest;
}

/** getTransaction at a specific commitment. Defaults to `finalized` — never a lower commitment. */
export async function getTransaction(client, signature, { commitment = client.commitment, maxSupportedTransactionVersion = 0 } = {}) {
  invariant(typeof signature === 'string' && signature.length > 0, SolanaAdapterError, 'signature is required');
  return rpc(client, 'getTransaction', [signature, { commitment, maxSupportedTransactionVersion, encoding: 'json' }]);
}

/** Convenience wrapper: getTransaction pinned to `finalized` commitment — the only commitment the peg cycle ever treats as a settled fact. */
export function getFinalizedTransaction(client, signature) {
  return getTransaction(client, signature, { commitment: 'finalized' });
}

/** getSignatureStatuses — cheaper than getTransaction for polling whether a broadcast landed. */
export async function readSignatureStatus(client, signature) {
  const result = await rpc(client, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  invariant(Array.isArray(result?.value), SolanaMalformedResponseError, 'getSignatureStatuses response is missing value[]');
  return result.value[0] ?? null;
}

/** Returns an error-free or errored status only after finality; lower commitments stay unresolved. */
export async function readFinalizedSignatureStatus(client, signature) {
  const status = await readSignatureStatus(client, signature);
  return status?.confirmationStatus === 'finalized' ? status : null;
}

/**
 * getTransaction pinned to `jsonParsed` encoding (WP-36: the buyback stage needs the opened
 * card's mint, and the Collector Crypt API response carries no field documented to reliably name
 * it — see stages/buyback.mjs's own header) and, by default, `finalized` commitment (this
 * module's own `client.commitment` default) — never a lower-fidelity encoding or a lower
 * commitment for this specific read, since it is the one independent, chain-observed source of
 * truth for "what token account balance actually changed in this transaction" the open stage
 * trusts (matching `packages/runner/src/cycle/collector.mjs`'s own production evidence note: "the
 * card mint the pack actually minted is read from the observer's own post-open-transaction token
 * balances, never trusted as a caller-supplied literal").
 *
 * Returns one entry per SPL token account referenced anywhere in `meta.preTokenBalances`/
 * `meta.postTokenBalances`, in ascending `accountIndex` order, never collapsed, filtered, or
 * guessed at: `{accountIndex, tokenAccount, owner, mint, preAmount, postAmount}` (`preAmount`/
 * `postAmount` are raw base-unit decimal strings, `'0'` for an account absent from the
 * corresponding side — a token account with no prior balance, or one fully drained). Selecting
 * "the operator's own token account whose balance moved from `0` to `1`" (a newly-credited NFT)
 * versus e.g. `1` to `0` (the pack token being spent) is the caller's job — this generic RPC
 * wrapper never assumes which candidate is "the" mint, per product/SOURCE_BOUNDARY.md's evidence
 * rule ("never guess").
 */
function tokenBalanceChangesFromTransaction(result, signature, commitment = 'finalized') {
  invariant(result && typeof result === 'object', SolanaMalformedResponseError, `getTransaction ${signature} returned no result (not found at commitment "${commitment}")`);
  invariant(result.meta && typeof result.meta === 'object', SolanaMalformedResponseError, `getTransaction ${signature} response is missing meta`);
  const accountKeys = result.transaction?.message?.accountKeys;
  invariant(Array.isArray(accountKeys), SolanaMalformedResponseError, `getTransaction ${signature} response is missing transaction.message.accountKeys`);

  function addressAt(index) {
    const entry = accountKeys[index];
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry.pubkey === 'string') return entry.pubkey;
    throw new SolanaMalformedResponseError(`getTransaction ${signature} accountKeys[${index}] is not a recognizable address`);
  }

  function assertBalanceEntry(entry, side, position) {
    invariant(
      entry && typeof entry.accountIndex === 'number' && typeof entry.mint === 'string' && typeof entry.owner === 'string' && typeof entry.uiTokenAmount?.amount === 'string',
      SolanaMalformedResponseError,
      `getTransaction ${signature} ${side}TokenBalances[${position}] is malformed`,
    );
  }

  const byIndex = new Map();
  const preBalances = Array.isArray(result.meta.preTokenBalances) ? result.meta.preTokenBalances : [];
  const postBalances = Array.isArray(result.meta.postTokenBalances) ? result.meta.postTokenBalances : [];
  preBalances.forEach((entry, position) => {
    assertBalanceEntry(entry, 'pre', position);
    byIndex.set(entry.accountIndex, {
      accountIndex: entry.accountIndex, mint: entry.mint, owner: entry.owner,
      preAmount: entry.uiTokenAmount.amount, postAmount: '0',
    });
  });
  postBalances.forEach((entry, position) => {
    assertBalanceEntry(entry, 'post', position);
    const existing = byIndex.get(entry.accountIndex);
    if (existing) {
      invariant(
        existing.mint === entry.mint && existing.owner === entry.owner,
        SolanaMalformedResponseError,
        `getTransaction ${signature} pre/post token balances disagree on mint/owner for account index ${entry.accountIndex}`,
      );
      existing.postAmount = entry.uiTokenAmount.amount;
    } else {
      byIndex.set(entry.accountIndex, {
        accountIndex: entry.accountIndex, mint: entry.mint, owner: entry.owner,
        preAmount: '0', postAmount: entry.uiTokenAmount.amount,
      });
    }
  });

  return [...byIndex.values()]
    .sort((a, b) => a.accountIndex - b.accountIndex)
    .map(entry => ({ ...entry, tokenAccount: addressAt(entry.accountIndex) }));
}

export async function getTransactionTokenBalanceChanges(client, signature, { commitment = client.commitment } = {}) {
  invariant(typeof signature === 'string' && signature.length > 0, SolanaAdapterError, 'signature is required');
  const result = await rpc(client, 'getTransaction', [signature, { commitment, maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
  return tokenBalanceChangesFromTransaction(result, signature, commitment);
}

/** Finalized-only token deltas for money-stage reconciliation. */
export function getFinalizedTokenBalanceChanges(client, signature) {
  return getTransactionTokenBalanceChanges(client, signature, { commitment: 'finalized' });
}

function canonicalObservationInteger(value, label) {
  invariant(typeof value === 'string' && canonicalUnsignedInteger.test(value), SolanaAdapterError, `${label} must be a canonical unsigned integer string`);
  return value;
}

function finalizedRelayTransaction(result, signature, label) {
  invariant(result && typeof result === 'object', SolanaMalformedResponseError, `getTransaction ${signature} returned no finalized result`);
  invariant(result.meta && typeof result.meta === 'object' && result.meta.err === null, SolanaAdapterError, `${label} transaction ${signature} did not finalize successfully`);
  invariant(Number.isSafeInteger(result.slot) && result.slot >= 0, SolanaMalformedResponseError, `getTransaction ${signature} response has an invalid slot`);
  invariant(Number.isSafeInteger(result.blockTime) && result.blockTime >= 0, SolanaMalformedResponseError, `getTransaction ${signature} response has no canonical block time`);
  return Object.freeze({
    height: String(result.slot),
    hash: signature,
    timestampUnixSeconds: String(result.blockTime),
  });
}

function hasRelayRequestMemo(result, relayRequestId) {
  const memos = result.transaction?.message?.instructions
    ?.filter(instruction => instruction?.program === 'spl-memo')
    .map(instruction => instruction.parsed) ?? [];
  return memos.length === 1 && memos[0] === relayRequestId;
}

function relayRequestMemo(result, signature, relayRequestId) {
  invariant(
    hasRelayRequestMemo(result, relayRequestId),
    SolanaAdapterError,
    `Relay destination transaction ${signature} does not carry exactly one matching Relay request memo`,
  );
}

function relayOwnerTokenDelta(result, signature, owner) {
  const balanceChanges = tokenBalanceChangesFromTransaction(result, signature);
  const matchingChanges = balanceChanges
    .filter(change => change.owner === owner)
    .map(change => {
      canonicalObservationInteger(change.preAmount, `Relay transaction ${signature} pre-token amount`);
      canonicalObservationInteger(change.postAmount, `Relay transaction ${signature} post-token amount`);
      return { ...change, delta: BigInt(change.postAmount) - BigInt(change.preAmount) };
    })
    .filter(change => change.delta !== 0n);
  invariant(
    matchingChanges.length === 1,
    SolanaAdapterError,
    `Relay destination transaction ${signature} does not prove one owner token delta for ${owner}`,
  );
  return matchingChanges[0];
}

function exactRelayTokenDelta(result, signature, { owner, mint, amountAtomic, direction }) {
  const change = relayOwnerTokenDelta(result, signature, owner);
  const expected = direction === 'credit' ? BigInt(amountAtomic) : -BigInt(amountAtomic);
  invariant(
    change.mint === mint && change.delta === expected,
    SolanaAdapterError,
    `Relay ${direction} transaction ${signature} does not prove one exact ${mint} ${direction} for ${owner}`,
  );
}

function relayDestinationObservationFromFinalizedTransaction(result, { signature, owner, relayRequestId }) {
  const finality = finalizedRelayTransaction(result, signature, 'Relay destination');
  relayRequestMemo(result, signature, relayRequestId);
  const change = relayOwnerTokenDelta(result, signature, owner);
  const observation = Object.freeze({
    transactionHash: signature,
    mint: change.mint,
    netDeltaAtomic: change.delta.toString(),
    finality,
    attribution: Object.freeze({
      schema: 'hookemon.relay-attribution.v1',
      observer: 'process-rpc',
      requestId: relayRequestId,
      memo: relayRequestId,
      observedAmountAtomic: change.delta.toString(),
    }),
  });
  processRpcRelayDestinationObservations.set(observation, Object.freeze({ owner, relayRequestId }));
  return observation;
}

/**
 * Records the raw finalized destination-side observation before a caller classifies it against a
 * particular leg. It deliberately does not accept an expected asset, amount, or time window: a
 * mismatch is evidence for a held terminal state, not a reason to discard the observation.
 */
export async function readFinalizedRelayDestinationObservation(client, {
  signature,
  owner,
  relayRequestId,
}) {
  invariant(typeof signature === 'string' && signature.length > 0, SolanaAdapterError, 'Relay destination signature is required');
  assertPublicKey(owner, 'Relay destination owner');
  invariant(typeof relayRequestId === 'string' && relayRequestId.length > 0, SolanaAdapterError, 'Relay destination request id is required');

  const result = await rpc(client, 'getTransaction', [signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
    encoding: 'jsonParsed',
  }]);
  return relayDestinationObservationFromFinalizedTransaction(result, { signature, owner, relayRequestId });
}

/**
 * Searches a caller-bounded finalized owner history through this process's Solana RPC client.
 * Candidate signatures are never trusted as settlement evidence by themselves: every candidate
 * is re-read at finalized commitment and must carry exactly the request memo. Multiple matches
 * are ambiguous and therefore refused instead of selecting an arbitrary transaction.
 */
export async function discoverFinalizedRelayDestinationObservation(client, {
  owner,
  relayRequestId,
  maxSignatures = 25,
}) {
  assertPublicKey(owner, 'Relay destination owner');
  invariant(typeof relayRequestId === 'string' && relayRequestId.length > 0, SolanaAdapterError, 'Relay destination request id is required');
  invariant(Number.isSafeInteger(maxSignatures) && maxSignatures >= 1 && maxSignatures <= 1_000, SolanaAdapterError, 'Relay destination discovery maxSignatures must be an integer from 1 through 1000');
  const entries = await rpc(client, 'getSignaturesForAddress', [owner, { commitment: 'finalized', limit: maxSignatures }]);
  invariant(Array.isArray(entries), SolanaMalformedResponseError, 'getSignaturesForAddress response is not an array');
  const seenSignatures = new Set();
  const observations = [];
  for (const [index, entry] of entries.entries()) {
    invariant(entry && typeof entry === 'object' && typeof entry.signature === 'string' && entry.signature.length > 0, SolanaMalformedResponseError, `getSignaturesForAddress response entry ${index} is malformed`);
    invariant(!seenSignatures.has(entry.signature), SolanaMalformedResponseError, `getSignaturesForAddress response repeats signature ${entry.signature}`);
    seenSignatures.add(entry.signature);
    if (entry.err !== null) continue;
    const result = await rpc(client, 'getTransaction', [entry.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
      encoding: 'jsonParsed',
    }]);
    if (!hasRelayRequestMemo(result, relayRequestId)) continue;
    observations.push(relayDestinationObservationFromFinalizedTransaction(result, {
      signature: entry.signature,
      owner,
      relayRequestId,
    }));
  }
  invariant(observations.length <= 1, SolanaAdapterError, `Relay destination discovery for request ${relayRequestId} is ambiguous`);
  return observations[0] ?? null;
}

/**
 * Proves one Relay destination credit from this process's finalized Solana RPC observation. The
 * provider's status endpoint is intentionally absent: a settlement needs an exact token delta,
 * an in-window block time, and the request identifier carried by one parsed memo instruction.
 */
export async function readFinalizedRelayDestinationAttribution(client, {
  signature,
  owner,
  mint,
  amountAtomic,
  relayRequestId,
  earliestTimestampUnixSeconds,
  latestTimestampUnixSeconds,
}) {
  invariant(typeof signature === 'string' && signature.length > 0, SolanaAdapterError, 'Relay destination signature is required');
  assertPublicKey(owner, 'Relay destination owner');
  assertPublicKey(mint, 'Relay destination mint');
  canonicalObservationInteger(amountAtomic, 'Relay destination amountAtomic');
  invariant(BigInt(amountAtomic) > 0n, SolanaAdapterError, 'Relay destination amountAtomic must be positive');
  invariant(typeof relayRequestId === 'string' && relayRequestId.length > 0, SolanaAdapterError, 'Relay destination request id is required');
  canonicalObservationInteger(earliestTimestampUnixSeconds, 'Relay destination earliest timestamp');
  canonicalObservationInteger(latestTimestampUnixSeconds, 'Relay destination latest timestamp');
  invariant(
    BigInt(earliestTimestampUnixSeconds) <= BigInt(latestTimestampUnixSeconds),
    SolanaAdapterError,
    'Relay destination time window is invalid',
  );

  const observation = await readFinalizedRelayDestinationObservation(client, {
    signature,
    owner,
    relayRequestId,
  });
  const observedTimestamp = BigInt(observation.finality.timestampUnixSeconds);
  invariant(
    observedTimestamp >= BigInt(earliestTimestampUnixSeconds) && observedTimestamp <= BigInt(latestTimestampUnixSeconds),
    SolanaAdapterError,
    `Relay destination transaction ${signature} is outside the recorded attribution window`,
  );
  invariant(
    observation.mint === mint && observation.netDeltaAtomic === amountAtomic,
    SolanaAdapterError,
    `Relay destination transaction ${signature} does not prove one exact ${mint} credit for ${owner}`,
  );
  return observation;
}

/** Proves one exact finalized source debit before a Relay leg can be settled. */
export async function readFinalizedRelaySourceDebit(client, {
  signature,
  owner,
  mint,
  amountAtomic,
}) {
  invariant(typeof signature === 'string' && signature.length > 0, SolanaAdapterError, 'Relay source signature is required');
  assertPublicKey(owner, 'Relay source owner');
  assertPublicKey(mint, 'Relay source mint');
  canonicalObservationInteger(amountAtomic, 'Relay source amountAtomic');
  invariant(BigInt(amountAtomic) > 0n, SolanaAdapterError, 'Relay source amountAtomic must be positive');
  const result = await rpc(client, 'getTransaction', [signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
    encoding: 'jsonParsed',
  }]);
  const finality = finalizedRelayTransaction(result, signature, 'Relay source');
  exactRelayTokenDelta(result, signature, { owner, mint, amountAtomic, direction: 'debit' });
  return Object.freeze({
    transactionHash: signature,
    debitedAmountAtomic: amountAtomic,
    finality,
  });
}

/**
 * Lists the Metaplex Core assets moved by `TransferV1` instructions (top-level and inner) in a
 * transaction, in instruction order. Returns asset addresses only — the caller must confirm the
 * asset's current on-chain owner with `readMplCoreAssetOwner`; nothing here is trusted as a
 * caller-supplied literal.
 */
export async function getTransactionMplCoreTransfers(client, signature, { commitment = client.commitment } = {}) {
  invariant(typeof signature === 'string' && signature.length > 0, SolanaAdapterError, 'signature is required');
  const result = await rpc(client, 'getTransaction', [signature, { commitment, maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
  invariant(result && typeof result === 'object', SolanaMalformedResponseError, `getTransaction ${signature} returned no result (not found at commitment "${commitment}")`);
  const topLevel = result.transaction?.message?.instructions;
  invariant(Array.isArray(topLevel), SolanaMalformedResponseError, `getTransaction ${signature} response is missing transaction.message.instructions`);
  const inner = Array.isArray(result.meta?.innerInstructions)
    ? result.meta.innerInstructions.flatMap(group => (Array.isArray(group?.instructions) ? group.instructions : []))
    : [];
  const assets = [];
  for (const ix of [...topLevel, ...inner]) {
    if (ix?.programId !== MPL_CORE_PROGRAM_ID || !Array.isArray(ix.accounts) || typeof ix.data !== 'string') continue;
    let data;
    try {
      data = decodeBase58(ix.data);
    } catch {
      continue;
    }
    if (data.length === 0 || data[0] !== MPL_CORE_TRANSFER_V1_DISCRIMINATOR) continue;
    if (typeof ix.accounts[0] === 'string') assets.push(ix.accounts[0]);
  }
  return assets;
}

/**
 * getAccountInfo for a Metaplex Core asset: returns the asset's current owner (base58) after
 * verifying the account is owned by the Core program and its first byte is `Key::AssetV1`.
 * Returns `null` when the account does not exist.
 */
export async function readMplCoreAssetOwner(client, asset, { commitment = client.commitment } = {}) {
  const key = assertPublicKey(asset, 'asset');
  const result = await rpc(client, 'getAccountInfo', [key.toBase58(), { commitment, encoding: 'base64' }]);
  invariant(result && typeof result === 'object' && 'value' in result, SolanaMalformedResponseError, 'getAccountInfo response is missing value');
  if (result.value === null) return null;
  invariant(result.value.owner === MPL_CORE_PROGRAM_ID, SolanaAdapterError, `account ${asset} is not owned by the Metaplex Core program`);
  invariant(Array.isArray(result.value.data) && typeof result.value.data[0] === 'string', SolanaMalformedResponseError, `getAccountInfo ${asset} data is not base64`);
  const bytes = Buffer.from(result.value.data[0], 'base64');
  invariant(bytes.length >= 33 && bytes[0] === MPL_CORE_KEY_ASSET_V1, SolanaAdapterError, `account ${asset} is not a Metaplex Core AssetV1`);
  return new PublicKey(bytes.subarray(1, 33)).toBase58();
}

// ---------------------------------------------------------------------------
// Construction (no network, no signing — pure, testable without any client)
// ---------------------------------------------------------------------------

/**
 * Derives the associated token account address for (owner, mint), the same PDA every SPL wallet
 * uses. Computed locally via `PublicKey.findProgramAddressSync` against the well-known Associated
 * Token program id — no `@solana/spl-token` dependency (not pinned in this package).
 */
export function deriveAssociatedTokenAddress(owner, mint, { tokenProgramId = TOKEN_PROGRAM_ID } = {}) {
  const ownerKey = assertPublicKey(owner, 'owner');
  const mintKey = assertPublicKey(mint, 'mint');
  const tokenProgramKey = assertPublicKey(tokenProgramId, 'tokenProgramId');
  const [address] = PublicKey.findProgramAddressSync(
    [ownerKey.toBuffer(), tokenProgramKey.toBuffer(), mintKey.toBuffer()],
    assertPublicKey(ASSOCIATED_TOKEN_PROGRAM_ID, 'ASSOCIATED_TOKEN_PROGRAM_ID'),
  );
  return address;
}

/**
 * Reads the canonical associated token account and verifies its token program, mint, and owner.
 * A missing account is reported explicitly; a malformed or mismatched account is never accepted.
 */
export async function readAssociatedTokenAccount(client, owner, mint, { tokenProgramId = TOKEN_PROGRAM_ID } = {}) {
  const ownerKey = assertPublicKey(owner, 'owner');
  const mintKey = assertPublicKey(mint, 'mint');
  const tokenProgramKey = assertPublicKey(tokenProgramId, 'tokenProgramId');
  const address = deriveAssociatedTokenAddress(ownerKey.toBase58(), mintKey.toBase58(), { tokenProgramId: tokenProgramKey.toBase58() }).toBase58();
  const result = await rpc(client, 'getAccountInfo', [address, { commitment: client.commitment, encoding: 'jsonParsed' }]);
  invariant(result && typeof result === 'object' && Object.hasOwn(result, 'value'), SolanaMalformedResponseError, 'getAccountInfo response is missing value');
  if (result.value === null) return { address, exists: false, amount: null, decimals: null };
  const account = result.value;
  invariant(account && typeof account === 'object', SolanaMalformedResponseError, 'associated token account response is malformed');
  invariant(account.owner === tokenProgramKey.toBase58(), SolanaAdapterError, `associated token account ${address} is not owned by the expected token program`);
  const info = account.data?.parsed?.info;
  invariant(
    account.data?.program === 'spl-token' && account.data?.parsed?.type === 'account' && info && typeof info === 'object',
    SolanaMalformedResponseError,
    `associated token account ${address} is not a parsed token account`,
  );
  invariant(info.mint === mintKey.toBase58(), SolanaAdapterError, `associated token account ${address} mint does not match`);
  invariant(info.owner === ownerKey.toBase58(), SolanaAdapterError, `associated token account ${address} owner does not match`);
  const tokenAmount = info.tokenAmount;
  invariant(
    tokenAmount && typeof tokenAmount === 'object' && typeof tokenAmount.amount === 'string' && canonicalUnsignedInteger.test(tokenAmount.amount)
      && Number.isInteger(tokenAmount.decimals) && tokenAmount.decimals >= 0 && tokenAmount.decimals <= 255,
    SolanaMalformedResponseError,
    `associated token account ${address} token amount is malformed`,
  );
  return { address, exists: true, amount: BigInt(tokenAmount.amount), decimals: tokenAmount.decimals };
}

/**
 * Builds the SPL Token `TransferChecked` instruction (opcode 12): safer than plain `Transfer`
 * (opcode 3) because it validates `mint`/`decimals` on-chain, so a caller cannot silently move the
 * wrong token. Layout: tag(u8=12) || amount(u64 LE) || decimals(u8); keys
 * [source(writable), mint(readonly), destination(writable), owner(signer)].
 */
export function buildTransferCheckedInstruction({
  source, destination, owner, mint, amount, decimals, tokenProgramId = TOKEN_PROGRAM_ID,
}) {
  invariant(typeof amount === 'bigint' && amount >= 0n, SolanaAdapterError, 'amount must be a non-negative bigint');
  invariant(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, SolanaAdapterError, 'decimals must be a uint8');

  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);

  return new TransactionInstruction({
    programId: assertPublicKey(tokenProgramId, 'tokenProgramId'),
    keys: [
      { pubkey: assertPublicKey(source, 'source'), isSigner: false, isWritable: true },
      { pubkey: assertPublicKey(mint, 'mint'), isSigner: false, isWritable: false },
      { pubkey: assertPublicKey(destination, 'destination'), isSigner: false, isWritable: true },
      { pubkey: assertPublicKey(owner, 'owner'), isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Builds the exact Compute Budget pair required for a configured priority fee. */
export function buildPriorityFeeInstructions({ computeUnitLimit, microLamports }) {
  invariant(Number.isSafeInteger(computeUnitLimit) && computeUnitLimit > 0, SolanaAdapterError, 'computeUnitLimit must be a positive safe integer');
  invariant(typeof microLamports === 'string' && canonicalUnsignedInteger.test(microLamports), SolanaAdapterError, 'microLamports must be a canonical atomic-unit string');
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(microLamports) }),
  ];
}

/**
 * Assembles an unsigned legacy `Transaction` (fee payer + recent blockhash + instructions) and
 * returns its unsigned wire bytes as base64 — the same encoding
 * packages/runner/src/automation/policy-wallets.mjs's `unsignedTransaction` field expects, so the
 * output of this function can be handed directly to a `PolicyWallet` intent without reshaping.
 * This function never signs; `requireAllSignatures: false` is exactly what makes serialization of
 * an unsigned transaction possible at all.
 */
export function buildUnsignedTransaction({ feePayer, recentBlockhash, instructions }) {
  invariant(Array.isArray(instructions) && instructions.length > 0, SolanaAdapterError, 'instructions must be a non-empty array');
  const tx = new Transaction({ feePayer: assertPublicKey(feePayer, 'feePayer'), recentBlockhash });
  for (const instruction of instructions) tx.add(instruction);
  const wireBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return wireBytes.toString('base64');
}

function relayInstructionBytes(value, label) {
  invariant(typeof value === 'string', SolanaAdapterError, `${label} data must be a hex string`);
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  invariant(hex.length % 2 === 0 && /^[0-9a-f]*$/i.test(hex), SolanaAdapterError, `${label} data must be canonical hex`);
  return Buffer.from(hex, 'hex');
}

function relayInstruction(value, index) {
  const label = `Relay instruction ${index}`;
  invariant(value && typeof value === 'object' && !Array.isArray(value), SolanaAdapterError, `${label} is invalid`);
  invariant(typeof value.programId === 'string', SolanaAdapterError, `${label} programId is required`);
  invariant(Array.isArray(value.keys) && value.keys.length > 0, SolanaAdapterError, `${label} keys are required`);
  const keys = value.keys.map((key, keyIndex) => {
    invariant(key && typeof key === 'object' && !Array.isArray(key), SolanaAdapterError, `${label} key ${keyIndex} is invalid`);
    invariant(typeof key.pubkey === 'string' && typeof key.isSigner === 'boolean' && typeof key.isWritable === 'boolean', SolanaAdapterError, `${label} key ${keyIndex} is malformed`);
    return {
      pubkey: assertPublicKey(key.pubkey, `${label} key ${keyIndex}`),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    };
  });
  return new TransactionInstruction({
    programId: assertPublicKey(value.programId, `${label} programId`),
    keys,
    data: relayInstructionBytes(value.data, label),
  });
}

/**
 * Builds a legacy unsigned transaction from one frozen Relay instruction plan. A plan carrying an
 * address lookup table is a v0 layout, so this function deliberately refuses instead of guessing
 * which lookup accounts the provider intended.
 */
export function buildRelayLegacyTransaction({ feePayer, recentBlockhash, instructionPlan }) {
  invariant(instructionPlan && typeof instructionPlan === 'object' && !Array.isArray(instructionPlan), SolanaAdapterError, 'Relay instruction plan is required');
  invariant(Array.isArray(instructionPlan.instructions) && instructionPlan.instructions.length > 0, SolanaAdapterError, 'Relay instruction plan requires instructions');
  invariant(Array.isArray(instructionPlan.addressLookupTableAddresses), SolanaAdapterError, 'Relay instruction plan requires address lookup table addresses');
  invariant(instructionPlan.addressLookupTableAddresses.length === 0, SolanaAdapterError, 'Relay instruction plan has address lookup tables and cannot be reconstructed as a legacy transaction');
  return buildUnsignedTransaction({
    feePayer,
    recentBlockhash,
    instructions: instructionPlan.instructions.map(relayInstruction),
  });
}

/**
 * Returns the base58 signature embedded in complete signed Solana wire bytes. The signature,
 * rather than a local digest of the base64 envelope, is the transaction identity observed by the
 * Solana RPC and stored as the Relay leg's source transaction hash.
 */
export function signedSolanaTransactionSignature(signedTxBase64) {
  invariant(typeof signedTxBase64 === 'string' && signedTxBase64.length > 0, SolanaAdapterError, 'signed Solana transaction must be a non-empty base64 string');
  const bytes = Buffer.from(signedTxBase64, 'base64');
  invariant(bytes.length > 0 && bytes.toString('base64') === signedTxBase64, SolanaAdapterError, 'signed Solana transaction must be canonical base64');
  let transaction;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
  } catch (error) {
    throw new SolanaAdapterError(`signed Solana transaction could not be deserialized: ${error.message}`, { cause: error });
  }
  const signature = transaction.signatures[0];
  invariant(signature instanceof Uint8Array && signature.length === 64 && signature.some(byte => byte !== 0), SolanaAdapterError, 'signed Solana transaction has no fee-payer signature');
  return encodeBase58(signature);
}

// ---------------------------------------------------------------------------
// Broadcast (never signs — only submits bytes an injected signerClient already produced)
// ---------------------------------------------------------------------------

/** sendTransaction — broadcasts pre-signed wire bytes (base64), never mutates or re-signs them. */
export async function submitSignedTransaction(client, signedTxBase64, { skipPreflight = false } = {}) {
  invariant(typeof signedTxBase64 === 'string' && signedTxBase64.length > 0, SolanaAdapterError, 'signedTxBase64 must be a non-empty base64 string');
  return rpc(client, 'sendTransaction', [signedTxBase64, { encoding: 'base64', skipPreflight, preflightCommitment: client.commitment }]);
}

export const SOLANA_CONSTANTS = Object.freeze({
  SOLANA_MAINNET_RPC_URL,
  SOLANA_RELAY_CHAIN_ID,
  CIRCLE_USD_MINT,
  CIRCLE_USD_DECIMALS,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
});
