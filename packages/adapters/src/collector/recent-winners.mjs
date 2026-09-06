// Observational, idempotent cache of recently revealed cards for the public recent-winners feed.
//
// This module is never the source of financial truth: `cycleRepository`'s durable stage journal
// (see accounting-projection.mjs's own header) is and remains the sole authority for money-moving
// facts. A card observation here is exactly that — an observation — never a substitute for a
// finalized transfer. This cache exists purely so the public site can show "recently revealed
// cards" promptly without querying the journal on every request; if it is ever lost or wrong, the
// journal is unaffected and `reconcileFromJournal` can rebuild it.
//
// Frozen shape (see F-brief's frozen contracts):
//   type OperationIdentity = { cycleId, operationId, packIndex, memo: string|null, mint: string|null };
//   type PublicCardEvent = OperationIdentity & {
//     eventId, sequence, state, name: string|null, imageUrl: string|null,
//     observedAt, finalizedAt: string|null, transactionId: string|null, proceeds: Amount|null,
//   };
//
// Events are idempotent by durable identity `${cycleId}:${operationId}:${packIndex}` (a pack
// reveal can be observed more than once — from a provider poll and from an Ably message, or
// out of order — and must always collapse to one card, never two). Ordering is by the event's own
// `sequence` (a caller-supplied, lexically-comparable stable string — e.g. a zero-padded provider
// cursor or a durable journal offset), never by local receipt order, so duplicate/out-of-order
// delivery is harmless.
//
// Provenance: `ingest` only accepts an observation that resolves, by `memo`, to a caller-supplied
// trusted operation record binding this project's own cycleId/operationId/packIndex (and mint/
// wallet when known) — memo membership alone is not attribution. An observation whose identity
// conflicts with its memo's trusted record, or with the memo/mint already retained under the same
// durable key, is dropped, never surfaced as one of this project's purchases and never silently
// overwriting an already-attributed card's identity.
//
// Transport-agnostic by design: this module has no network/Ably/provider-API code and needs no
// secret. Whatever wiring later calls `ingest` (a server-side Ably subscriber, a provider polling
// loop, or `reconcileFromJournal`) is free to fail or be entirely absent — recent-winners is purely
// observational, so its outage never blocks or delays settlement.

const DEFAULT_MAX_RETAINED = 200;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertOperationIdentity(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  if (!isNonEmptyString(value.cycleId) || !isNonEmptyString(value.operationId)) {
    throw new TypeError(`${label}.cycleId/operationId must be non-empty strings`);
  }
  if (!Number.isSafeInteger(value.packIndex) || value.packIndex < 0) {
    throw new TypeError(`${label}.packIndex must be a non-negative integer`);
  }
  if (value.memo !== null && !isNonEmptyString(value.memo)) throw new TypeError(`${label}.memo must be a string or null`);
  if (value.mint !== null && !isNonEmptyString(value.mint)) throw new TypeError(`${label}.mint must be a string or null`);
  return value;
}

/** The frozen `Amount` shape: `{chainId, assetId, units, decimals}`, `units` an unsigned decimal
 * string. An unknown amount is the entire `Amount` value being `null` (checked by the caller before
 * this is invoked) — never a present `Amount` object with a `null` `units`, which would let a
 * genuinely unknown proceeds value pass field-presence checks while carrying no real number. */
function assertAmount(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  if (!isNonEmptyString(value.chainId) || !isNonEmptyString(value.assetId)) {
    throw new TypeError(`${label}.chainId/assetId must be non-empty strings`);
  }
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
    throw new TypeError(`${label}.decimals is invalid`);
  }
  if (typeof value.units !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.units)) {
    throw new TypeError(`${label}.units must be an unsigned decimal string`);
  }
  return value;
}

const CARD_STATES = new Set(['observed', 'finalized']);
const STATE_RANK = Object.freeze({ observed: 0, finalized: 1 });
// A canonical unsigned integer string (no leading zeros other than "0" itself) — compared
// numerically via BigInt, never lexically. C's producer has not yet published its exact durable
// sequence format (see F-inbox.md); this is the concrete format requested from it. A caller-supplied
// zero-padded cursor must be normalized to this canonical form before calling ingest.
const CANONICAL_SEQUENCE = /^(0|[1-9][0-9]*)$/;

/** Validates and canonicalizes a raw observation into the frozen `PublicCardEvent` shape. Throws on
 * a malformed observation — callers should treat that as a defect in the observation source, never
 * silently drop it (dropping only happens for a legitimately foreign `memo`, see `ingest`). */
export function assertPublicCardEvent(value) {
  assertOperationIdentity(value, 'PublicCardEvent');
  if (!isNonEmptyString(value.eventId)) throw new TypeError('PublicCardEvent.eventId must be a non-empty string');
  if (typeof value.sequence !== 'string' || !CANONICAL_SEQUENCE.test(value.sequence)) {
    throw new TypeError('PublicCardEvent.sequence must be a canonical unsigned integer string (no leading zeros)');
  }
  if (!CARD_STATES.has(value.state)) throw new TypeError('PublicCardEvent.state must be "observed" or "finalized"');
  if (value.name !== null && !isNonEmptyString(value.name)) throw new TypeError('PublicCardEvent.name must be a string or null');
  if (value.imageUrl !== null && !isNonEmptyString(value.imageUrl)) throw new TypeError('PublicCardEvent.imageUrl must be a string or null');
  if (!isIsoTimestamp(value.observedAt)) throw new TypeError('PublicCardEvent.observedAt must be an ISO timestamp');
  if (value.finalizedAt !== null && !isIsoTimestamp(value.finalizedAt)) throw new TypeError('PublicCardEvent.finalizedAt must be an ISO timestamp or null');
  if (value.transactionId !== null && !isNonEmptyString(value.transactionId)) throw new TypeError('PublicCardEvent.transactionId must be a string or null');
  if (value.proceeds !== null) assertAmount(value.proceeds, 'PublicCardEvent.proceeds');
  return Object.freeze({
    cycleId: value.cycleId,
    operationId: value.operationId,
    packIndex: value.packIndex,
    memo: value.memo,
    mint: value.mint,
    eventId: value.eventId,
    sequence: value.sequence,
    state: value.state,
    name: value.name,
    imageUrl: value.imageUrl,
    observedAt: value.observedAt,
    finalizedAt: value.finalizedAt,
    transactionId: value.transactionId,
    proceeds: value.proceeds === null ? null : Object.freeze({ ...value.proceeds }),
  });
}

function durableKey(identity) {
  return [identity.cycleId, identity.operationId, String(identity.packIndex)].join(':');
}

/** Numeric comparison of two canonical unsigned-integer sequence strings — never lexical, so
 * `"9"` vs `"10"` compares correctly regardless of caller-supplied padding. */
function compareSequence(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

/** Given the currently retained event (or `null`) and a newly ingested one for the same durable
 * identity, decides which one the cache should keep. `finalized` always outranks `observed`
 * (financial finality evidence, once observed, is never regressed back to a mere observation).
 * Within the same rank, the higher `sequence` wins, so out-of-order delivery is harmless. */
function preferred(existing, incoming) {
  if (existing === null) return incoming;
  const existingRank = STATE_RANK[existing.state];
  const incomingRank = STATE_RANK[incoming.state];
  if (incomingRank !== existingRank) return incomingRank > existingRank ? incoming : existing;
  return compareSequence(incoming.sequence, existing.sequence) >= 0 ? incoming : existing;
}

function isTrustedOperationRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!isNonEmptyString(value.cycleId) || !isNonEmptyString(value.operationId)) return false;
  if (!Number.isSafeInteger(value.packIndex) || value.packIndex < 0) return false;
  if (value.mint !== null && !isNonEmptyString(value.mint)) return false;
  if (value.wallet !== null && !isNonEmptyString(value.wallet)) return false;
  return true;
}

/**
 * @param {object} input
 * @param {Map<string, {cycleId: string, operationId: string, packIndex: number, mint: string|null, wallet: string|null}>} input.trustedOperations
 *   this project's own operations, keyed by memo — the concrete "memo AND wallet/mint linkage"
 *   attribution required over memo membership alone (see F-sol-review). An observation is only
 *   published if its memo resolves to a trusted record here AND its cycleId/operationId/packIndex
 *   match that record exactly, AND (when the record specifies one) its mint/wallet also match. A
 *   raw observation may carry an optional `wallet` field for this check alone — it is never part of
 *   the frozen `PublicCardEvent` shape and is discarded once trust is established.
 * @param {number} [input.maxRetained] - bounds memory use; oldest-by-sequence entries are evicted
 *   first once exceeded.
 */
export function createRecentWinnersCollector({ trustedOperations, maxRetained = DEFAULT_MAX_RETAINED }) {
  if (!(trustedOperations instanceof Map) || trustedOperations.size === 0) {
    throw new Error('createRecentWinnersCollector requires a non-empty Map of trusted operation records keyed by memo');
  }
  for (const [memo, record] of trustedOperations) {
    if (!isNonEmptyString(memo) || !isTrustedOperationRecord(record)) {
      throw new Error('createRecentWinnersCollector: every trusted operation record must be well-formed');
    }
  }
  if (!Number.isSafeInteger(maxRetained) || maxRetained <= 0) {
    throw new Error('createRecentWinnersCollector requires a positive integer maxRetained');
  }
  const events = new Map();

  /** `null` when the observation cannot be trusted (unknown memo, or its identity conflicts with
   * the trusted record for that memo) — the same "dropped, not an error" treatment as a foreign
   * memo, since a legitimately-shaped event that simply isn't ours is not itself malformed. */
  function trustedMatch(rawObservation, observation) {
    const trusted = trustedOperations.get(observation.memo);
    if (trusted === undefined) return false;
    if (trusted.cycleId !== observation.cycleId) return false;
    if (trusted.operationId !== observation.operationId) return false;
    if (trusted.packIndex !== observation.packIndex) return false;
    if (trusted.mint !== null && observation.mint !== trusted.mint) return false;
    // When the trusted record requires a wallet, an observation must actually state the matching
    // one — omitting the field must never bypass the requirement.
    if (trusted.wallet !== null && rawObservation.wallet !== trusted.wallet) return false;
    return true;
  }

  /** Idempotently ingests one raw observation. Returns the `PublicCardEvent` now retained for its
   * durable identity, or `null` if the observation was dropped: an untrusted memo, an identity that
   * conflicts with the trusted record for its memo, or an identity that conflicts with the memo/mint
   * already retained under the same durable key (a later observation may never silently replace
   * those fields). */
  function ingest(rawObservation) {
    const observation = assertPublicCardEvent(rawObservation);
    if (observation.memo === null || !trustedMatch(rawObservation, observation)) return null;
    const key = durableKey(observation);
    const existing = events.get(key) ?? null;
    if (existing !== null && (existing.memo !== observation.memo || existing.mint !== observation.mint)) return null;
    const merged = preferred(existing, observation);
    events.set(key, merged);
    if (events.size > maxRetained) {
      const overflow = [...events.entries()].sort((a, b) => compareSequence(a[1].sequence, b[1].sequence));
      for (let index = 0; index < events.size - maxRetained; index += 1) events.delete(overflow[index][0]);
    }
    return merged;
  }

  /** Returns up to `limit` retained events, newest-`sequence`-first — a stable order across calls
   * as long as the retained set does not change. */
  function list({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('recent-winners list requires a positive integer limit');
    return [...events.values()].sort((a, b) => compareSequence(b.sequence, a.sequence)).slice(0, limit);
  }

  function size() {
    return events.size;
  }

  return Object.freeze({ ingest, list, size });
}

/**
 * Reconciles the collector's in-memory cache against durable evidence after a restart or a gap in
 * live delivery (e.g. an Ably outage) — restoring history without ever treating the cache itself as
 * authoritative. `readOperations(cycleId)` must resolve to an array of raw observations (the same
 * shape `ingest` accepts) sourced from the cycle journal or the provider's own history endpoint,
 * never from Ably (Ably delivery is not financial finality — see this module's header).
 * @returns {Promise<number>} the number of observations actually accepted (not dropped as foreign).
 */
export async function reconcileFromJournal(collector, { cycleId, readOperations }) {
  if (!collector || typeof collector.ingest !== 'function') {
    throw new Error('reconcileFromJournal requires a recent-winners collector');
  }
  if (typeof readOperations !== 'function') throw new Error('reconcileFromJournal requires a readOperations function');
  const operations = await readOperations(cycleId);
  if (!Array.isArray(operations)) throw new Error('reconcileFromJournal: readOperations must resolve to an array');
  let accepted = 0;
  for (const operation of operations) {
    if (collector.ingest(operation) !== null) accepted += 1;
  }
  return accepted;
}
