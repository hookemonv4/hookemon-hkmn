// GET /public/api/cycle-history's contract, schemaVersion 1 (F-sol-review: stable paginated
// history was previously missing entirely — this is the new dedicated route/contract, not an
// extension of public-community-snapshot.mjs's single `latestCycle`).
//
// Requires each terminal cycle to carry a verified `terminalAtMs` (persisted terminal completion
// epoch-ms — the exact producer field agreed with task C, see C-inbox.md; not yet emitted by any
// real `operatorControl` implementation in this codebase). Ordering is `terminalAtMs` descending,
// ties broken by `cycleId` ascending — fully deterministic regardless of input array order.
// Pagination is an opaque `cursor` string encoding the last returned item's own
// (terminalAtMs, cycleId); a page is only ever computed from a source set where *every* cycle has a
// verified timestamp — if even one is missing, the entire response fails closed (`items: []`,
// `nextCursor: null`, `historyComplete: false`) rather than silently ordering the reachable subset
// and hiding the gap. `asOf` is the source snapshot's own freshness marker, kept separate from
// `generatedAt` (the HTTP response's own creation time) so a client can tell a stale upstream read
// from a fresh one even when the response itself is freshly served.
import { readDashboardProfile } from './dashboard-profile.mjs';
import {
  boundedArray,
  boundedText,
  ContractValidationError,
  exactKeys,
  invalidWith,
  isoTimestamp,
  nonNegativeInteger,
  optionalTimestamp,
  requiredKeys,
  requiredRecord,
} from './primitives.mjs';

const invalid = invalidWith('PUBLIC_CYCLE_HISTORY_INVALID');

const RESPONSE_KEYS = new Set([
  'schemaVersion', 'profile', 'network', 'generatedAt', 'asOf', 'historyComplete', 'items', 'nextCursor',
]);
const ITEM_KEYS = new Set(['cycleId', 'status', 'terminalAt', 'updatedAt']);
const NETWORK_KEYS = new Set(['evm', 'solana']);
const EVM_NETWORK_KEYS = new Set(['name', 'chainId', 'label']);
const SOLANA_NETWORK_KEYS = new Set(['name', 'genesisHash', 'label']);
export const MAX_HISTORY_PAGE_SIZE = 20;

export function normalizePublicCycleHistory(value, expectedProfile) {
  try {
    return readPublicCycleHistory(value, expectedProfile);
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    throw new ContractValidationError('PUBLIC_CYCLE_HISTORY_INVALID');
  }
}

function readPublicCycleHistory(value, expectedProfile) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, RESPONSE_KEYS, invalid);
  requiredKeys(source, RESPONSE_KEYS, invalid);
  if (source.schemaVersion !== 1) invalid();
  const selected = readDashboardProfile(source.profile);
  if (expectedProfile !== undefined && readDashboardProfile(expectedProfile).id !== selected.id) invalid();
  const generatedAt = isoTimestamp(source.generatedAt, invalid);
  const asOf = isoTimestamp(source.asOf, invalid);
  if (Date.parse(asOf) > Date.parse(generatedAt)) invalid();
  if (typeof source.historyComplete !== 'boolean') invalid();
  const items = boundedArray(source.items, MAX_HISTORY_PAGE_SIZE, invalid).map(readItem);
  // The whole-page fail-closed rule (see this module's own header) means a returned item may never
  // carry a null terminalAt: if even one source cycle lacked a verified timestamp, the producer must
  // have failed the entire response closed (historyComplete:false, items:[]) instead of reaching
  // here at all. A null terminalAt on any item — even one item in an otherwise complete page — is
  // the exact contradiction G6-terra-review found: reject it rather than render it as completed
  // history (G6-terra-review.md).
  if (items.some(item => item.terminalAt === null)) invalid();
  for (let index = 1; index < items.length; index += 1) {
    if (!itemOrderDescends(items[index - 1], items[index])) invalid();
  }
  if (!source.historyComplete && (items.length !== 0 || source.nextCursor !== null)) invalid();
  return {
    schemaVersion: 1,
    profile: selected.id,
    network: readNetwork(source.network, selected.network),
    generatedAt,
    asOf,
    historyComplete: source.historyComplete,
    items,
    nextCursor: source.nextCursor === null ? null : boundedText(source.nextCursor, invalid),
  };
}

function itemOrderDescends(previous, current) {
  // A null terminalAt is already rejected before this is ever called (see readPublicCycleHistory's
  // own check above) — treating a null operand as "order not violated" would be exactly the
  // fail-open gap G6-terra-review found, so this rejects rather than waves it through defensively.
  if (previous.terminalAt === null || current.terminalAt === null) return false;
  const previousMs = Date.parse(previous.terminalAt);
  const currentMs = Date.parse(current.terminalAt);
  if (previousMs !== currentMs) return previousMs > currentMs;
  return previous.cycleId.localeCompare(current.cycleId) < 0;
}

function readNetwork(value, expected) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, NETWORK_KEYS, invalid);
  requiredKeys(source, NETWORK_KEYS, invalid);
  const evm = requiredRecord(source.evm, invalid);
  const solana = requiredRecord(source.solana, invalid);
  exactKeys(evm, EVM_NETWORK_KEYS, invalid);
  exactKeys(solana, SOLANA_NETWORK_KEYS, invalid);
  requiredKeys(evm, EVM_NETWORK_KEYS, invalid);
  requiredKeys(solana, SOLANA_NETWORK_KEYS, invalid);
  if (
    evm.name !== expected.evm.name || evm.chainId !== expected.evm.chainId || evm.label !== expected.evm.label
    || solana.name !== expected.solana.name || solana.genesisHash !== expected.solana.genesisHash || solana.label !== expected.solana.label
  ) invalid();
  return expected;
}

function readItem(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, ITEM_KEYS, invalid);
  requiredKeys(source, ITEM_KEYS, invalid);
  return {
    cycleId: boundedText(source.cycleId, invalid),
    status: boundedText(source.status, invalid),
    terminalAt: optionalTimestamp(source.terminalAt, invalid),
    updatedAt: optionalTimestamp(source.updatedAt, invalid),
  };
}

// Exported so the projection can build a cursor the validator above will also accept back — the
// contract and the projection must agree on exactly one cursor format.
export function encodeHistoryCursor({ terminalAtMs, cycleId }) {
  nonNegativeInteger(terminalAtMs, invalid);
  boundedText(cycleId, invalid);
  return Buffer.from(JSON.stringify({ t: terminalAtMs, c: cycleId }), 'utf8').toString('base64url');
}

export function decodeHistoryCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    invalid();
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Number.isSafeInteger(parsed.t) || parsed.t < 0
    || typeof parsed.c !== 'string' || parsed.c.length === 0
  ) invalid();
  return { terminalAtMs: parsed.t, cycleId: parsed.c };
}
