// Pure, read-only reconstruction of `recent-winners.mjs`'s durable card-feed inputs from Task C's
// own authoritative persisted records — never a second authoritative store, and never a
// request-time fabricated observation/timestamp (see this module's own header discipline note
// below). This module has no network/provider/journal-write code and cannot itself call
// `cycleRepository`; a caller (task I's composition root) reads the real records and passes them in
// here, then feeds this module's output into `createRecentWinnersCollector`'s `ingest` — the same
// restart-recovery role `reconcileFromJournal` already documents, made concrete against C's actual
// multi-pack lifecycle shape (C-interface.json revision 2) instead of a generic injected
// `readOperations` callback.
//
// Real inputs, three distinct provenances, never conflated:
//   - `packBatchRequestPacks`: the exact `packs` array from `cycleRepository.readPackBatchRequest(
//     cycleId, 'purchase')` — C's own durable, pre-signing pack/memo/packIndex identity ledger (the
//     only one of the four `PACK_OPERATION_STAGES` currently populated; see C-interface.json's
//     `durableAttemptStateMemoTxMintLinks.packBatchRequestLedger.onlyUsedBy`). This is the immutable
//     cycle/operation/memo binding — never re-derived from a later stage's evidence, which could be
//     incomplete or (for a not-yet-purchased pack) entirely absent.
//   - `stages`: this cycle's own `{purchase, open, epicGate, buyback}` stage evidence, each exactly
//     what `cycleRepository.readStage(cycleId, stage)` returns (`{status, evidence}`) — the same
//     durable evidence `accounting-projection.mjs` itself reads, never a second copy of it.
//   - `purchaseRequestedAtMs`: the purchase batch-request ledger's own `requestedAtMs` — a real,
//     durably-recorded wall-clock time (when the provider's batch call durably returned), usable as
//     an honest `observedAt` for a pack still at the `PURCHASED` stage.
//   - `observedAtByOperationId` (optional): `Map<operationId, {observedAt, finalizedAt}>` of REAL
//     wall-clock evidence for a pack that has progressed past `PURCHASED` — sourced from an actual
//     validated provider observation or transport receipt (e.g. an Ably message's own receipt time,
//     or a provider status-poll response time), never synthesized here. Task C's own stage evidence
//     carries no per-pack wall-clock timestamp for `open`/`epic-gate`/`buyback` today (flagged as a
//     bounded field request in C-inbox.md) — a pack durably past `PURCHASED` but missing from this
//     map is simply not yet buildable into an observation; it is never assigned a fabricated "now"
//     or the unrelated cycle-level `terminalAtMs`.
//   - `operatorWallet` (optional): the single system-wide operator Solana wallet
//     (`config.contracts`/`config.accounts.solana`, per C-interface.json's `walletIdentity` — there
//     is no per-pack wallet variance to record), supplied once by the caller's own immutable trusted
//     context — never read from a mutable global at request time — and stamped onto every built
//     observation/trusted record for `createRecentWinnersCollector`'s wallet-linkage check.
//
// Deterministic and idempotent: calling `buildDurableCardFeed` twice with the same four inputs
// returns byte-identical output, in the same `packBatchRequestPacks` (packIndex) order, with the
// same `sequence`/`eventId` values — so a restart that re-reads the same durable records and
// re-ingests this output rebuilds exactly the same collector state, never a duplicate or reordered
// card. `sequence` is derived from `purchaseRequestedAtMs` (real, durable, monotonically increasing
// across a system's successive purchase batches) combined with `packIndex`, never from insertion
// order or a local clock.

/** Converts buyback's internal typed `{chainId, assetId, decimals, amountAtomic}` proceeds (see
 * `stages/buyback.mjs`'s own `typedAmount`) into the frozen public `Amount` shape
 * `recent-winners.mjs`'s `assertPublicCardEvent` requires (`{chainId, assetId, decimals, units}`) —
 * a field rename only, never a value conversion. Returns `null` for anything not shaped like a
 * typed amount, so malformed evidence degrades to "no proceeds shown," never a fabricated one. */
function publicProceeds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { chainId, assetId, decimals, amountAtomic } = value;
  if ((typeof chainId !== 'string' || chainId.length === 0) && !Number.isInteger(chainId)) return null;
  if (typeof assetId !== 'string' || assetId.length === 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  if (typeof amountAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amountAtomic)) return null;
  return Object.freeze({ chainId: String(chainId), assetId, decimals, units: amountAtomic });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function stagePacks(stage) {
  if (stage?.status !== 'COMPLETE') return null;
  return Array.isArray(stage.evidence?.packs) ? stage.evidence.packs : undefined;
}

function mapStagePacks(packs, expected, validate) {
  if (!Array.isArray(packs) || packs.length !== expected.size) return null;
  const result = new Map();
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return null;
    const predecessor = expected.get(pack.packIndex);
    if (!predecessor || result.has(pack.packIndex) || pack.memo !== predecessor.memo || !validate(pack, predecessor)) return null;
    result.set(pack.packIndex, pack);
  }
  return result.size === expected.size ? result : null;
}

/** Validates every COMPLETE stage as one full transition before resolving an individual pack. A
 * corrupt later stage must reject the feed, not quietly fall back to an earlier lifecycle fact. */
export function validateCompleteStages(requests, stages = {}) {
  const requestByIndex = new Map(requests.map(request => [request.packIndex, request]));
  const purchasePacks = stagePacks(stages.purchase);
  let purchase = null;
  if (purchasePacks !== null) {
    purchase = mapStagePacks(purchasePacks, requestByIndex, pack => (
      pack.status === 'purchased'
      || (pack.status === 'not_purchased' && !Object.hasOwn(pack, 'packCost') && !Object.hasOwn(pack, 'signature'))
    ));
    if (purchase === null) return null;
  }

  const purchased = purchase === null ? new Map() : new Map([...purchase].filter(([, pack]) => pack.status === 'purchased'));
  const openPacks = stagePacks(stages.open);
  let open = null;
  if (openPacks !== null) {
    if (purchase === null) return null;
    open = mapStagePacks(openPacks, purchased, pack => {
      if (pack.decision === 'held') return true;
      return pack.decision === 'opened' && nonEmptyString(pack.mint) && nonEmptyString(pack.signature);
    });
    if (open === null) return null;
  }

  const opened = open === null ? new Map() : new Map([...open].filter(([, pack]) => pack.decision === 'opened'));
  const epicGatePacks = stagePacks(stages.epicGate);
  let epicGate = null;
  if (epicGatePacks !== null) {
    if (open === null) return null;
    epicGate = mapStagePacks(epicGatePacks, opened, (pack, predecessor) => {
      if (pack.mint !== predecessor.mint) return false;
      return pack.decision === 'sell' || pack.decision === 'held';
    });
    if (epicGate === null) return null;
  }

  const saleCandidates = epicGate === null ? new Map() : new Map([...epicGate].filter(([, pack]) => pack.decision === 'sell'));
  const buybackPacks = stagePacks(stages.buyback);
  let buyback = null;
  if (buybackPacks !== null) {
    if (epicGate === null || !Number.isInteger(stages.buyback.evidence.soldCount)) return null;
    buyback = mapStagePacks(buybackPacks, saleCandidates, (pack, predecessor) => {
      if (pack.mint !== predecessor.mint) return false;
      if (pack.decision === 'held') return !Object.hasOwn(pack, 'proceeds') && !Object.hasOwn(pack, 'signature');
      return pack.decision === 'sold'
        && nonEmptyString(pack.signature)
        && publicProceeds(pack.proceeds) !== null;
    });
    if (buyback === null) return null;
    const soldCount = [...buyback.values()].filter(pack => pack.decision === 'sold').length;
    if (soldCount !== stages.buyback.evidence.soldCount) return null;
  }

  return { purchase, open, epicGate, buyback };
}

/** Resolves a lifecycle only after `validateCompleteStages` has verified all available COMPLETE
 * evidence. Pending stages are absent from the maps; malformed complete stages never reach here. */
export function resolvePackLifecycle(packIndex, { purchase, open, epicGate, buyback }) {
  const buybackPack = buyback?.get(packIndex) ?? null;
  if (buybackPack) {
    if (buybackPack.decision === 'sold') {
      return { state: 'SOLD', publicState: 'finalized', mint: buybackPack.mint, transactionId: buybackPack.signature, proceeds: publicProceeds(buybackPack.proceeds) };
    }
    if (buybackPack.decision === 'held') {
      return { state: 'HELD', publicState: 'finalized', mint: buybackPack.mint ?? null, transactionId: null, proceeds: null };
    }
    return null;
  }
  const epicGatePack = epicGate?.get(packIndex) ?? null;
  if (epicGatePack) {
    if (epicGatePack.decision === 'sell') {
      if (typeof epicGatePack.mint !== 'string' || epicGatePack.mint.length === 0) return null;
      return { state: 'GATED', publicState: 'observed', mint: epicGatePack.mint, transactionId: null, proceeds: null };
    }
    if (epicGatePack.decision === 'held') {
      return { state: 'HELD', publicState: 'finalized', mint: epicGatePack.mint ?? null, transactionId: null, proceeds: null };
    }
    return null;
  }
  const openPack = open?.get(packIndex) ?? null;
  if (openPack) {
    if (openPack.decision === 'opened') {
      if (typeof openPack.mint !== 'string' || openPack.mint.length === 0) return null;
      return { state: 'OPENED', publicState: 'observed', mint: openPack.mint, transactionId: openPack.signature, proceeds: null };
    }
    if (openPack.decision === 'held') {
      return { state: 'HELD', publicState: 'finalized', mint: openPack.mint ?? null, transactionId: null, proceeds: null };
    }
    return null;
  }
  const purchasePack = purchase?.get(packIndex) ?? null;
  if (purchasePack && purchasePack.status === 'purchased') {
    return { state: 'PURCHASED', publicState: 'observed', mint: null, transactionId: purchasePack.signature ?? null, proceeds: null };
  }
  return null;
}

/**
 * Validates the ENTIRE purchase batch-request ledger before trusting any single entry in it: every
 * `packIndex` must be the request array's dense zero-based position, every `memo` a unique non-empty string. A
 * request ledger that itself contains a duplicate or contradictory identity is a broken or corrupted
 * durable record — the whole batch is rejected (no trusted operations, no observations for any pack
 * in it), never a partial publication that trusts the non-conflicting subset while silently dropping
 * the conflicting entries (which would let two different memos race for the same `packIndex`/
 * `operationId`, or leave a canonically-real pack invisible with no trace it was ever rejected).
 */
function packBatchRequestPacksValid(packBatchRequestPacks) {
  if (!Array.isArray(packBatchRequestPacks) || packBatchRequestPacks.length === 0) return false;
  const seenIndexes = new Set();
  const seenMemos = new Set();
  for (const [index, request] of packBatchRequestPacks.entries()) {
    if (!request || typeof request !== 'object' || request.packIndex !== index) return false;
    if (seenIndexes.has(request.packIndex)) return false;
    seenIndexes.add(request.packIndex);
    if (typeof request.memo !== 'string' || request.memo.length === 0 || seenMemos.has(request.memo)) return false;
    seenMemos.add(request.memo);
  }
  return true;
}

/**
 * @param {object} input
 * @param {string} input.cycleId
 * @param {Array<{packIndex: number, memo: string, expectedCardCount: number, packType: string|null}>} input.packBatchRequestPacks
 * @param {number} input.purchaseRequestedAtMs
 * @param {{purchase?: object, open?: object, epicGate?: object, buyback?: object}} input.stages
 * @param {Map<string, {observedAt: string, finalizedAt: string|null}>} [input.observedAtByOperationId]
 * @param {string|null} [input.operatorWallet]
 * @returns {{trustedOperations: Map<string, object>, observations: object[]}} `trustedOperations` is
 *   ready to pass directly to `createRecentWinnersCollector`; `observations` is ready to pass one at
 *   a time to the resulting collector's `ingest`.
 */
export function buildDurableCardFeed({
  cycleId,
  packBatchRequestPacks,
  purchaseRequestedAtMs,
  stages,
  observedAtByOperationId = new Map(),
  operatorWallet = null,
}) {
  if (typeof cycleId !== 'string' || cycleId.length === 0) {
    throw new TypeError('buildDurableCardFeed requires a cycleId');
  }
  if (!Number.isSafeInteger(purchaseRequestedAtMs) || purchaseRequestedAtMs < 0) {
    throw new TypeError("buildDurableCardFeed requires the purchase batch's own durable requestedAtMs");
  }
  const trustedOperations = new Map();
  const observations = [];
  if (!packBatchRequestPacksValid(packBatchRequestPacks)) return { trustedOperations, observations };
  const validatedStages = validateCompleteStages(packBatchRequestPacks, stages);
  if (validatedStages === null) return { trustedOperations, observations };

  for (const request of packBatchRequestPacks) {
    const operationId = `pack:${cycleId}:${request.packIndex}`;
    const lifecycle = resolvePackLifecycle(request.packIndex, validatedStages);

    trustedOperations.set(request.memo, Object.freeze({
      cycleId,
      operationId,
      packIndex: request.packIndex,
      mint: lifecycle?.mint ?? null,
      wallet: operatorWallet,
    }));

    if (lifecycle === null) continue; // not yet purchased, or a pending/ambiguous decision -- nothing to show yet

    let observedAt;
    let finalizedAt = null;
    if (lifecycle.state === 'PURCHASED') {
      observedAt = new Date(purchaseRequestedAtMs).toISOString();
    } else {
      const real = observedAtByOperationId.get(operationId);
      if (!real || typeof real.observedAt !== 'string') continue; // no real timestamp evidence yet -- skip, never invent one
      observedAt = real.observedAt;
      if (lifecycle.publicState === 'finalized' && typeof real.finalizedAt === 'string') finalizedAt = real.finalizedAt;
    }

    observations.push(Object.freeze({
      cycleId,
      operationId,
      packIndex: request.packIndex,
      memo: request.memo,
      mint: lifecycle.mint,
      eventId: `${operationId}:${lifecycle.state}`,
      sequence: String(BigInt(purchaseRequestedAtMs) * 1_000_000n + BigInt(request.packIndex)),
      state: lifecycle.publicState,
      name: null,
      imageUrl: null,
      observedAt,
      finalizedAt,
      transactionId: lifecycle.transactionId,
      proceeds: lifecycle.proceeds,
      wallet: operatorWallet,
    }));
  }
  return { trustedOperations, observations };
}
