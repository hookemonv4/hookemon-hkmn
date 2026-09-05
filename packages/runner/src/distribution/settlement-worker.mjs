// Payout submitter / settlement worker.
//
// After a distribution has been compiled (`manifest.mjs`'s `compileApprovedDistribution`) and
// both the distribution-signer approval and the independent verifier receipt exist
// (`distribution-signer.mjs`), this module actually pays every committed holder leaf by calling
// `HolderSettlement.payEntitlement` once per leaf (per chunk, once chunking is active). It holds
// no key material and never builds or signs a transaction itself: every on-chain call is made
// through a caller-injected `submitEntitlement(request)` async function -- in production that
// seam resolves to a policy-bound signer plus `hook-contract-client.mjs`'s calldata encoding and
// `robinhood-rpc.mjs`'s broadcast, exactly the "injected signer client, never key material"
// pattern `automation/policy-wallets.mjs` already uses for the cycle's other signed actions. This
// module only decides *what* to submit and *when to retry*, never *how* to sign it.
//
// Idempotent by construction at two layers, deliberately redundant (defense in depth, not either
// layer alone):
//   1. The durable per-leaf journal (`journalStore`, `{ read(key), write(key, value) }`) records
//      each leaf's terminal PAID/FAILED state. A leaf already marked PAID in the journal is never
//      resubmitted -- this is what makes a crash-and-restart resume without reattempting payments
//      the journal already knows succeeded.
//   2. `HolderSettlement.payEntitlement` itself reverts `EntitlementAlreadyPaid` on a retried
//      leaf. If the journal was not yet updated when the process died (broadcast succeeded, the
//      write to `journalStore` never happened), the resubmission on restart hits that revert; a
//      caller-injected `submitEntitlement` surfaces this as an `EntitlementAlreadyPaidError` (or
//      any error carrying `.code === 'ENTITLEMENT_ALREADY_PAID'`), which this module treats as a
//      terminal success rather than a failure to retry.
//
// Before ever submitting a leaf, this module (a) enforces `distribution-signer.mjs`'s
// `assertPairedDistributionApproval` so a distribution lacking two independent, agreeing
// signatures is never settled, and (b) locally re-derives and verifies each leaf's Merkle-sum
// proof against the artifact's own pinned root (using the exact canonical leaf/proof primitives
// `manifest.mjs`/`merkle-sum.mjs` build the artifact with) before it is ever handed to
// `submitEntitlement` -- a defense-in-depth check that a corrupted or tampered artifact bundle
// (proofs edited independently of entries/root) is caught locally and aborts the whole run,
// rather than silently spending gas against a bad proof or, worse, misreporting which leaves are
// actually payable.
//
// Chunking: `PayoutCommitment.sol`'s default operational mode commits exactly one chunk (index 0)
// whose root mirrors the whole payout's root -- unchunked behavior, per design.md decision D5
// (chunking is built and tested but shipped inactive). `resolveChunkIndex(entry)` defaults to a
// constant `0` for every leaf to match that default; a caller may inject a different resolver once
// multi-chunk payouts are activated, without any change to this module's settlement logic.

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { nonemptyLeaf, verifyProof, WIDTH } from '../../../contracts/tooling/payout/canonical-merkle-sum.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveRetainedCustodyMutationAuthority,
} from '../cycle/preflight.mjs';
import { assertPairedDistributionApproval } from './distribution-signer.mjs';

export const SETTLEMENT_STATUS = Object.freeze({
  PAID: 'PAID',
  FAILED: 'FAILED',
});

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 2000;
const ALREADY_PAID_CODE = 'ENTITLEMENT_ALREADY_PAID';
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function requireSettlementSubmissionAuthority(preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('fixture settlement authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('fixture settlement test authority is invalid');
  return requireLiveRetainedCustodyMutationAuthority();
}

/**
 * Marker error a caller-injected `submitEntitlement` should throw (or an error carrying
 * `.code === 'ENTITLEMENT_ALREADY_PAID'`) when the chain call reverts `EntitlementAlreadyPaid`.
 * This module treats it as a terminal success, never as a failure to retry.
 */
export class EntitlementAlreadyPaidError extends Error {
  constructor(message = 'entitlement already paid') {
    super(message);
    this.name = 'EntitlementAlreadyPaidError';
    this.code = ALREADY_PAID_CODE;
  }
}

function isAlreadyPaidError(error) {
  return error instanceof EntitlementAlreadyPaidError || error?.code === ALREADY_PAID_CODE;
}

function defaultBackoffMs(attempt, { baseDelayMs, maxDelayMs }) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 20);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Builds the durable journal key one leaf's settlement state is tracked under. */
export function settlementJournalKey(payoutId, chunkIndex, index) {
  if (typeof payoutId !== 'string' || payoutId.length === 0) {
    throw new Error('settlement journal key requires a nonempty payoutId');
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff) {
    throw new Error('settlement journal key requires a uint16 chunkIndex');
  }
  if (!Number.isInteger(index) || index < 0 || index >= WIDTH) {
    throw new Error('settlement journal key requires an in-range leaf index');
  }
  return `${payoutId}:${chunkIndex}:${index}`;
}

function assertArtifactShape(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('settlement worker requires a compiled distribution artifact');
  }
  if (artifact.schema !== 'hookemon.canonical-holder-distribution.v1') {
    throw new Error('settlement worker: unexpected artifact schema');
  }
  if (!artifact.domain || typeof artifact.domain.payoutId !== 'string' || artifact.domain.payoutId.length === 0) {
    throw new Error('settlement worker: artifact domain is invalid');
  }
  if (!Array.isArray(artifact.entries) || artifact.entries.length === 0) {
    throw new Error('settlement worker: artifact has no entries to settle');
  }
  if (!Array.isArray(artifact.proofs) || artifact.proofs.length !== WIDTH) {
    throw new Error('settlement worker: artifact proofs are invalid');
  }
  if (!artifact.root || typeof artifact.root.hash !== 'string' || typeof artifact.root.sum !== 'string') {
    throw new Error('settlement worker: artifact root is invalid');
  }
  if (!artifact.manifest || typeof artifact.manifest.digest !== 'string') {
    throw new Error('settlement worker: artifact manifest is invalid');
  }
}

function resolveChunkIndexFor(entry, resolveChunkIndex) {
  const chunkIndex = resolveChunkIndex ? resolveChunkIndex(entry) : 0;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff) {
    throw new Error(`settlement worker: chunk index for entry ${entry.index} is invalid`);
  }
  return chunkIndex;
}

/**
 * Defense-in-depth: locally rebuilds the leaf hash for one artifact entry and verifies it against
 * the artifact's own pinned root using the artifact's own proof for that leaf index. Throws (and
 * is never caught by this module's retry logic) on any mismatch -- a proof that fails to verify
 * against an already root-pinned artifact means the bundle is internally inconsistent, which this
 * module treats as a hard stop for the whole run rather than a per-leaf retry.
 */
function verifyEntryProofLocally(artifact, entry) {
  const proof = artifact.proofs[entry.index];
  if (!proof || !Array.isArray(proof.siblingHashes) || !Array.isArray(proof.siblingSums)) {
    throw new Error(`settlement worker: missing proof for entry index ${entry.index}`);
  }
  const leafDomain = { ...artifact.domain, manifestDigest: artifact.manifest.digest };
  const leaf = nonemptyLeaf(leafDomain, entry.index, entry.recipient, entry.amount);
  if (!verifyProof(leaf, entry.index, proof, artifact.root)) {
    throw new Error(`settlement worker: local proof verification failed for entry index ${entry.index}; refusing to submit against a possibly tampered artifact`);
  }
  return proof;
}

/**
 * Pays every committed holder leaf in a compiled distribution exactly once, resuming cleanly
 * across a crash: leaves the durable `journalStore` already marks `PAID` are skipped without a
 * resubmission attempt, and a leaf whose on-chain call reverts `EntitlementAlreadyPaid` (surfaced
 * as an `EntitlementAlreadyPaidError`) is recorded `PAID` without being treated as a failure.
 *
 * @param {object} args
 * @param {object} args.artifact - `manifest.mjs`'s `compileApprovedDistribution` output.
 * @param {object} args.approval - the distribution-signer approval bound to `artifact`.
 * @param {object} args.verification - the verifier receipt bound to `artifact`.
 * @param {(request: {payoutId, chunkIndex, index, recipient, amount, siblingHashes, siblingSums}) => Promise<{transactionId?: string}>} args.submitEntitlement -
 *   injected chain-submission client; this module holds no signer or key material of its own.
 * @param {{read(key): Promise<any>, write(key, value): Promise<void>}} args.journalStore - the
 *   durable per-leaf journal.
 * @param {(entry: {index, recipient, amount, directBalance}) => number} [args.resolveChunkIndex] -
 *   defaults to a constant `0` (today's single-chunk default operational mode, design.md D5).
 * @param {number} [args.maxAttempts]
 * @param {number} [args.baseDelayMs]
 * @param {number} [args.maxDelayMs]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {(record: object) => (void | Promise<void>)} [args.onLeafSettled] - optional
 *   observability hook, called once per leaf after its journal record is written.
 * @param {object} [args.preflightAuthority] - exact Node-test fixture authority. Production
 *   callers omit it and the retained custody authority refuses this Phase 3 path at submission.
 */
export async function settleDistribution({
  artifact,
  approval,
  verification,
  submitEntitlement,
  journalStore,
  resolveChunkIndex,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  sleep = defaultSleep,
  onLeafSettled,
  preflightAuthority,
  // WP-39: pluggable pairing check — defaults to the fixture Ed25519 scheme
  // (`assertPairedDistributionApproval`), unchanged for every existing caller. A production caller
  // (settling against `manifest.mjs`'s `buildProductionDistributionArtifact` output) injects the
  // EIP-712 secp256k1 analog instead (`packages/adapters/src/signing/payout-distribution.mjs`'s
  // `assertPairedProductionPayoutSignatures`) — this module itself never chooses which scheme
  // applies, and never imports the production one (no viem dependency here).
  verifyPairing = assertPairedDistributionApproval,
} = {}) {
  if (typeof submitEntitlement !== 'function') {
    throw new Error(
      'settlement worker requires an injected submitEntitlement(request) client; '
      + 'it holds no signer or key material of its own',
    );
  }
  if (!journalStore || typeof journalStore.read !== 'function' || typeof journalStore.write !== 'function') {
    throw new Error('settlement worker requires an injected durable journal store exposing { read(key), write(key, value) }');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('settlement worker maxAttempts must be a positive integer');
  }
  if (typeof verifyPairing !== 'function') {
    throw new Error('settlement worker verifyPairing must be a function');
  }
  assertArtifactShape(artifact);
  // Gate: refuse to settle anything unless the distribution-signer approval and the independent
  // verifier receipt agree on the exact same rootHash/rootSum as this compiled artifact.
  await verifyPairing(approval, artifact, verification);

  const payoutId = artifact.domain.payoutId;
  const sortedEntries = [...artifact.entries].sort((a, b) => a.index - b.index);
  const results = [];

  for (const entry of sortedEntries) {
    const chunkIndex = resolveChunkIndexFor(entry, resolveChunkIndex);
    const key = settlementJournalKey(payoutId, chunkIndex, entry.index);
    const existing = await journalStore.read(key);
    if (existing?.status === SETTLEMENT_STATUS.PAID) {
      results.push({ ...existing, skipped: true });
      continue;
    }

    // Hard stop, not a per-leaf retry: a proof that fails to verify locally against an
    // already-pinned root means the artifact bundle itself cannot be trusted.
    const proof = verifyEntryProofLocally(artifact, entry);
    const request = Object.freeze({
      payoutId,
      chunkIndex,
      index: entry.index,
      recipient: entry.recipient,
      amount: entry.amount,
      siblingHashes: proof.siblingHashes,
      siblingSums: proof.siblingSums,
    });

    let attempt = 0;
    let settled = null;
    let lastError = null;
    while (attempt < maxAttempts && !settled) {
      attempt += 1;
      requireSettlementSubmissionAuthority(preflightAuthority);
      try {
        // eslint-disable-next-line no-await-in-loop -- leaves are settled sequentially so a
        // durable journal write always follows the submission it records, in order.
        const response = await submitEntitlement(request);
        settled = {
          status: SETTLEMENT_STATUS.PAID,
          transactionId: response?.transactionId ?? null,
          attempts: attempt,
          alreadyPaid: false,
        };
      } catch (error) {
        if (isAlreadyPaidError(error)) {
          settled = {
            status: SETTLEMENT_STATUS.PAID,
            transactionId: null,
            attempts: attempt,
            alreadyPaid: true,
          };
          break;
        }
        lastError = error;
        if (attempt < maxAttempts) {
          // eslint-disable-next-line no-await-in-loop -- intentional retry backoff
          await sleep(defaultBackoffMs(attempt, { baseDelayMs, maxDelayMs }));
        }
      }
    }

    const outcome = settled ?? {
      status: SETTLEMENT_STATUS.FAILED,
      attempts: attempt,
      error: lastError?.message ?? 'unknown settlement error',
    };
    const journalRecord = {
      key,
      payoutId,
      chunkIndex,
      index: entry.index,
      recipient: entry.recipient,
      amount: entry.amount,
      ...outcome,
    };
    // eslint-disable-next-line no-await-in-loop -- must persist before moving to the next leaf
    await journalStore.write(key, journalRecord);
    if (onLeafSettled) await onLeafSettled(journalRecord);
    results.push({ ...journalRecord, skipped: false });
  }

  const paid = results.filter((record) => record.status === SETTLEMENT_STATUS.PAID).length;
  const failed = results.filter((record) => record.status === SETTLEMENT_STATUS.FAILED).length;
  return {
    payoutId,
    totalLeaves: results.length,
    paid,
    failed,
    results,
  };
}

// --- Journal store implementations -----------------------------------------------------------
//
// `settleDistribution` only needs `{ read(key), write(key, value) }`; either of the following
// (or a caller's own store, e.g. wrapping `node:sqlite` on the dashboard side) satisfies it.

/** A non-durable, in-process journal store -- for tests and short-lived local runs only. */
export function createInMemorySettlementJournal() {
  const records = new Map();
  return {
    async read(key) {
      return records.has(key) ? structuredClone(records.get(key)) : undefined;
    },
    async write(key, value) {
      records.set(key, structuredClone(value));
    },
  };
}

function encodeJournalFileName(key) {
  return `${encodeURIComponent(key)}.json`;
}

async function atomicWriteFile(directory, path, text) {
  const tempPath = join(directory, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const handle = await open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * A disk-backed, crash-safe journal store: one file per leaf key, written by temp-file-then-rename
 * so a read after a restart never observes a torn write. Assumes a single settlement-worker
 * process owns one payout's journal directory at a time (matching the always-on worker's single-
 * writer architecture elsewhere in this design) -- concurrent-writer arbitration is intentionally
 * left to the contract's own `EntitlementAlreadyPaid` revert, the second idempotency layer this
 * module already treats as authoritative.
 */
export function createFileSettlementJournal(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('settlement journal directory must be a nonempty path');
  }
  const ready = mkdir(directory, { recursive: true });
  return {
    async read(key) {
      await ready;
      const path = join(directory, encodeJournalFileName(key));
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
      return JSON.parse(text);
    },
    async write(key, value) {
      await ready;
      const path = join(directory, encodeJournalFileName(key));
      await atomicWriteFile(directory, path, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
