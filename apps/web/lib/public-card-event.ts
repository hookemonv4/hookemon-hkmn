// Renderer-side port of the frozen plan contract (see docs/modules/public-website.md):
//   type Amount = { chainId: string; assetId: string; units: string; decimals: number };
//   type OperationIdentity = { cycleId; operationId; packIndex; memo: string | null; mint: string | null };
//   type PublicCardEvent = OperationIdentity & {
//     eventId; sequence; state; name: string | null; imageUrl: string | null;
//     observedAt; finalizedAt: string | null; transactionId: string | null; proceeds: Amount | null;
//   };
// This module only validates/normalizes/presents this shape; it does not fetch it from any
// endpoint. No backend route emitting this exact contract has landed yet (F3 is finalizing the
// public routes), so nothing here is wired to a live fetch call.

const MAX_TEXT_LENGTH = 512;
const MAX_UNITS_DIGITS = 78;

export type Amount = {
  chainId: string;
  assetId: string;
  units: string;
  decimals: number;
};

export type OperationIdentity = {
  cycleId: string;
  operationId: string;
  packIndex: number;
  memo: string | null;
  mint: string | null;
};

export type PublicCardEventState = "observed" | "finalized";

export type PublicCardEvent = OperationIdentity & {
  eventId: string;
  sequence: string;
  state: PublicCardEventState;
  name: string | null;
  imageUrl: string | null;
  observedAt: string;
  finalizedAt: string | null;
  transactionId: string | null;
  proceeds: Amount | null;
};

const CARD_STATES = new Set<PublicCardEventState>(["observed", "finalized"]);

export function normalizeAmount(value: unknown): Amount {
  const source = requiredRecord(value);
  exactKeys(source, AMOUNT_KEYS);
  requiredKeys(source, AMOUNT_KEYS);
  return {
    chainId: boundedText(source.chainId),
    assetId: boundedText(source.assetId),
    units: unitsText(source.units),
    decimals: decimalsInteger(source.decimals),
  };
}

export function normalizePublicCardEvent(value: unknown): PublicCardEvent {
  const source = requiredRecord(value);
  exactKeys(source, CARD_EVENT_KEYS);
  requiredKeys(source, CARD_EVENT_KEYS);
  const observedAt = isoTimestamp(source.observedAt);
  const finalizedAt = source.finalizedAt === null ? null : isoTimestamp(source.finalizedAt);
  if (finalizedAt !== null && Date.parse(finalizedAt) < Date.parse(observedAt)) invalid();
  if (typeof source.state !== "string" || !CARD_STATES.has(source.state as PublicCardEventState)) invalid();
  return {
    cycleId: boundedText(source.cycleId),
    operationId: boundedText(source.operationId),
    packIndex: nonNegativeInteger(source.packIndex),
    memo: nullableText(source.memo),
    mint: nullableText(source.mint),
    eventId: boundedText(source.eventId),
    sequence: boundedText(source.sequence),
    state: source.state as PublicCardEventState,
    name: nullableText(source.name),
    imageUrl: nullableImageUrl(source.imageUrl),
    observedAt,
    finalizedAt,
    transactionId: nullableText(source.transactionId),
    proceeds: source.proceeds === null ? null : normalizeAmount(source.proceeds),
  };
}

/**
 * Identity per the frozen contract: a card can have several observations, but public history
 * must never display them as several different cards. Keeps, per identity, only the most recently
 * observed event (by validated `observedAt`, a fixed-width ISO timestamp -- safe to compare
 * lexically or by `Date.parse`, unlike `sequence`), so a later re-observation (e.g. state moving
 * from "observed" to "finalized") replaces the earlier one in place rather than appending a
 * duplicate.
 *
 * Deliberately does NOT order by `sequence`: the frozen contract only promises `sequence` is a
 * stable string, not a zero-padded or fixed-width one (see F-sol-review.md's "9" vs "10" finding
 * against an earlier caller-side lexical-sequence assumption -- localeCompare("9", "10") is
 * positive, i.e. wrongly "newer"). `sequence` is used only to break an exact `observedAt` tie.
 *
 * Also rejects (rather than silently overwriting) two observations of the same identity that
 * disagree on `memo` or `mint`: per the same review, a durable key that excludes those fields lets
 * a later observation replace them without a conflict check. A public renderer must not paper over
 * that inconsistency by picking one silently.
 */
export function mergeCardEvents(events: readonly PublicCardEvent[]): PublicCardEvent[] {
  const byIdentity = new Map<string, PublicCardEvent>();
  for (const event of events) {
    const key = operationIdentityKey(event);
    const current = byIdentity.get(key);
    if (current === undefined) {
      byIdentity.set(key, event);
      continue;
    }
    if (current.memo !== event.memo || current.mint !== event.mint) invalid();
    if (isNewerEvent(event, current)) byIdentity.set(key, event);
  }
  return [...byIdentity.values()];
}

/**
 * Distinguishes the frozen `PublicCardEvent` recent-winners feed (schemaVersion 8+) from the
 * legacy productId/rarity card shape at a render call site, so a display helper can present each
 * honestly instead of forcing one shape's fields onto the other.
 */
export function isPublicCardEvent(value: object): value is PublicCardEvent {
  return "operationId" in value;
}

export function operationIdentityKey(identity: OperationIdentity): string {
  return `${identity.cycleId} ${identity.operationId} ${identity.packIndex}`;
}

// sequence is a caller-supplied, lexically-comparable stable string (see
// packages/adapters/src/collector/recent-winners.mjs), not a numeric value -- compare with
// localeCompare, matching that producer's own tie-break rule exactly (>= keeps the incoming
// event on an exact tie, i.e. the most recently merged observation wins).
function isNewerEvent(candidate: PublicCardEvent, current: PublicCardEvent): boolean {
  const candidateMs = Date.parse(candidate.observedAt);
  const currentMs = Date.parse(current.observedAt);
  if (candidateMs !== currentMs) return candidateMs > currentMs;
  // Only an exact observedAt tie falls back to sequence, purely as a deterministic (not
  // necessarily chronological) last resort -- never the primary ordering.
  return candidate.sequence.localeCompare(current.sequence) >= 0;
}

export type CardEventPresentation = {
  label: string;
  imageUrl: string | null;
  stateLabel: string;
  isFinalized: boolean;
  proceedsText: string;
};

/**
 * Presents one card for display. Never invents a name/image before it is actually observed
 * (both stay `null` -> a pending placeholder, not a guess), and never presents `proceeds: null`
 * (not yet sold, or provider-observed only, not finalized money) as "0" -- those are distinct
 * facts. A `state` alone is not proof of finalized money; only a non-null `proceeds` together
 * with a non-null `finalizedAt` is.
 */
export function presentCardEvent(event: PublicCardEvent): CardEventPresentation {
  const isFinalized = event.finalizedAt !== null && event.proceeds !== null;
  return {
    label: event.name ?? "Name pending",
    imageUrl: event.imageUrl,
    stateLabel: humanizeState(event.state),
    isFinalized,
    proceedsText: event.proceeds === null
      ? (isFinalized ? "Unavailable" : "Not yet sold")
      : formatAmount(event.proceeds),
  };
}

export function formatAmount(amount: Amount): string {
  if (!/^(0|[1-9]\d*)$/.test(amount.units)) invalid();
  const padded = amount.units.padStart(amount.decimals + 1, "0");
  const whole = amount.decimals === 0 ? padded : padded.slice(0, -amount.decimals);
  const fraction = amount.decimals === 0 ? "" : padded.slice(-amount.decimals).replace(/0+$/, "");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `${grouped}${fraction ? `.${fraction}` : ""} ${amount.assetId}`;
}

function humanizeState(state: string): string {
  return state
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

const AMOUNT_KEYS = new Set(["chainId", "assetId", "units", "decimals"]);
const CARD_EVENT_KEYS = new Set([
  "cycleId", "operationId", "packIndex", "memo", "mint",
  "eventId", "sequence", "state", "name", "imageUrl",
  "observedAt", "finalizedAt", "transactionId", "proceeds",
]);

function requiredRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  return value as Record<string, unknown>;
}

function requiredKeys(value: Record<string, unknown>, required: ReadonlySet<string>) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : boundedText(value);
}

function nullableImageUrl(value: unknown): string | null {
  if (value === null) return null;
  const text = boundedText(value);
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password) invalid();
  return url.toString();
}

function isoTimestamp(value: unknown): string {
  const text = boundedText(value);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== text) invalid();
  return text;
}

function unitsText(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || value.length > MAX_UNITS_DIGITS) {
    invalid();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function decimalsInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) invalid();
  return value as number;
}

function invalid(): never {
  throw new TypeError("PUBLIC_CARD_EVENT_INVALID");
}
