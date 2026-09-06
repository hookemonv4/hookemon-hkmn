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

/**
 * Finds `packIndex`'s own entry in one stage's `packs` array, requiring it to attribute to
 * `expectedMemo` — the trusted memo the purchase batch-request ledger itself durably assigned to
 * that `packIndex`. A later stage's entry at the same `packIndex` but a DIFFERENT memo is a broken
 * or spoofed cross-stage ledger, never trusted: this returns `null` (as if the pack never reached
 * this stage at all) rather than silently rebinding that entry's signature/mint/proceeds onto the
 * trusted identity — the caller falls through to check the previous stage instead.
 */
function findPack(stage, packIndex, expectedMemo) {
  if (stage?.status !== 'COMPLETE' || !Array.isArray(stage.evidence?.packs)) return null;
  const pack = stage.evidence.packs.find(entry => entry && typeof entry === 'object' && entry.packIndex === packIndex);
  if (!pack || pack.memo !== expectedMemo) return null;
  return pack;
}

/**
 * Resolves one pack's current lifecycle fact from the latest stage that actually reached it —
 * `buyback` overrides `epicGate` overrides `open` overrides `purchase`. Every stage's own entry must
 * attribute to `expectedMemo` (see `findPack`'s own doc) — a stage skipped this way because its
 * entry's memo doesn't match falls through exactly as if that stage had no entry for this pack at
 * all. Returns `null` when the pack has no publicly-showable fact yet: never purchased, or a
 * pending/ambiguous provider decision (`buyback`'s pre-reconcile `'submitted'`/`'unknown'`) that is
 * never surfaced as a public card state (see C-interface.json's own
 * `publicCardEventProducerShape.perPackFieldsAvailableToF.state`). A `'not_purchased'` pack is
 * deliberately excluded too: no card was ever created for it, so it is never shown, not even under a
 * `'PURCHASED'` label (a bounded clarification on this exact point is requested in C-inbox.md; this
 * is the conservative reading pending C's answer).
 */
function resolvePackLifecycle(packIndex, expectedMemo, { purchase, open, epicGate, buyback } = {}) {
  const buybackPack = findPack(buyback, packIndex, expectedMemo);
  if (buybackPack) {
    if (buybackPack.decision === 'sold') {
      if (typeof buybackPack.mint !== 'string' || buybackPack.mint.length === 0) return null;
      return { state: 'SOLD', publicState: 'finalized', mint: buybackPack.mint, transactionId: buybackPack.signature ?? null, proceeds: publicProceeds(buybackPack.proceeds) };
    }
    if (buybackPack.decision === 'held') {
      return { state: 'HELD', publicState: 'finalized', mint: buybackPack.mint ?? null, transactionId: null, proceeds: null };
    }
    return null;
  }
  const epicGatePack = findPack(epicGate, packIndex, expectedMemo);
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
  const openPack = findPack(open, packIndex, expectedMemo);
  if (openPack) {
    if (openPack.decision === 'opened') {
      if (typeof openPack.mint !== 'string' || openPack.mint.length === 0) return null;
      return { state: 'OPENED', publicState: 'observed', mint: openPack.mint, transactionId: openPack.signature ?? null, proceeds: null };
    }
    if (openPack.decision === 'held') {
      return { state: 'HELD', publicState: 'finalized', mint: openPack.mint ?? null, transactionId: null, proceeds: null };
    }
    return null;
  }
  const purchasePack = findPack(purchase, packIndex, expectedMemo);
  if (purchasePack && purchasePack.status === 'purchased') {
    return { state: 'PURCHASED', publicState: 'observed', mint: null, transactionId: purchasePack.signature ?? null, proceeds: null };
  }
  return null;
}

/**
 * Validates the ENTIRE purchase batch-request ledger before trusting any single entry in it: every
 * `packIndex` must be a unique non-negative integer, every `memo` a unique non-empty string. A
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
  for (const request of packBatchRequestPacks) {
    if (!request || typeof request !== 'object' || !Number.isInteger(request.packIndex) || request.packIndex < 0) return false;
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

  for (const request of packBatchRequestPacks) {
    const operationId = `pack:${cycleId}:${request.packIndex}`;
    const lifecycle = resolvePackLifecycle(request.packIndex, request.memo, stages);

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
