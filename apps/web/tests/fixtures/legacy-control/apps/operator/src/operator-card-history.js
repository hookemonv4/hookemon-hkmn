const ALLOWED_PARAMETERS = new Set([
  "cursor",
  "limit",
  "sort",
  "cycleId",
  "productId",
  "rarity",
  "from",
  "to",
  "minBuybackMicroUsdc",
  "maxBuybackMicroUsdc",
]);
const CURSOR_KEYS = new Set([
  "v",
  "sort",
  "observedAt",
  "cycleId",
  "packIndex",
  "buybackMicroUsdc",
]);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MONEY_PATTERN = /^(0|[1-9]\d{0,77})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const CARD_HISTORY_SORTS = Object.freeze([
  "recent",
  "buyback-desc",
  "buyback-asc",
]);

export function cardHistoryOptions(searchParams) {
  if (!searchParams || typeof searchParams.keys !== "function") invalidQuery();
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => !ALLOWED_PARAMETERS.has(key)) ||
    new Set(keys).size !== keys.length
  ) invalidQuery();

  const limitText = searchParams.get("limit");
  const limit = limitText === null ? 24 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalidQuery();

  const sort = searchParams.get("sort") ?? "recent";
  if (!CARD_HISTORY_SORTS.includes(sort)) invalidQuery();

  const filters = {
    cycleId: optionalId(searchParams.get("cycleId")),
    productId: optionalId(searchParams.get("productId")),
    rarity: optionalBoundedText(searchParams.get("rarity")),
    from: optionalTimestamp(searchParams.get("from")),
    to: optionalTimestamp(searchParams.get("to")),
    minBuybackMicroUsdc: optionalMoney(searchParams.get("minBuybackMicroUsdc")),
    maxBuybackMicroUsdc: optionalMoney(searchParams.get("maxBuybackMicroUsdc")),
  };
  if (filters.from !== null && filters.to !== null && filters.from > filters.to) invalidQuery();
  if (
    filters.minBuybackMicroUsdc !== null &&
    filters.maxBuybackMicroUsdc !== null &&
    BigInt(filters.minBuybackMicroUsdc) > BigInt(filters.maxBuybackMicroUsdc)
  ) invalidQuery();

  const cursorText = searchParams.get("cursor");
  const cursor = cursorText === null ? null : decodeCursor(cursorText, sort);
  return { limit, sort, cursor, filters };
}

export function encodeCardHistoryCursor(card, sort) {
  try {
    if (!CARD_HISTORY_SORTS.includes(sort)) invalidCursor();
    const normalized = normalizedCursorCard(card, "OPERATOR_CARD_CURSOR_INVALID");
    return Buffer.from(JSON.stringify({
      v: 1,
      sort,
      observedAt: normalized.observedAt,
      cycleId: normalized.cycleId,
      packIndex: normalized.packIndex,
      buybackMicroUsdc: normalized.buybackMicroUsdc,
    })).toString("base64url");
  } catch (error) {
    if (error?.message === "OPERATOR_CARD_CURSOR_INVALID") throw error;
    invalidCursor();
  }
}

function decodeCursor(value, requestedSort) {
  try {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      !BASE64URL_PATTERN.test(value)
    ) invalidQuery();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) invalidQuery();
    const decoded = JSON.parse(bytes.toString("utf8"));
    if (
      !plainObject(decoded) ||
      Object.keys(decoded).length !== CURSOR_KEYS.size ||
      Object.keys(decoded).some((key) => !CURSOR_KEYS.has(key)) ||
      decoded.v !== 1 ||
      decoded.sort !== requestedSort
    ) invalidQuery();
    return normalizedCursorCard(decoded, "OPERATOR_QUERY_INVALID");
  } catch (error) {
    if (error?.message === "OPERATOR_QUERY_INVALID") throw error;
    invalidQuery();
  }
}

function normalizedCursorCard(value, errorCode) {
  if (!plainObject(value)) throw new Error(errorCode);
  const cycleId = value.cycleId;
  const packIndex = value.packIndex;
  const observedAt = value.observedAt;
  const buybackMicroUsdc = value.buybackMicroUsdc;
  if (
    typeof cycleId !== "string" ||
    !ID_PATTERN.test(cycleId) ||
    !Number.isSafeInteger(packIndex) ||
    packIndex < 0 ||
    packIndex > 9_999 ||
    !validTimestamp(observedAt) ||
    (buybackMicroUsdc !== null && !validMoney(buybackMicroUsdc))
  ) throw new Error(errorCode);
  return { cycleId, packIndex, observedAt, buybackMicroUsdc };
}

function optionalId(value) {
  if (value === null) return null;
  if (!ID_PATTERN.test(value)) invalidQuery();
  return value;
}

function optionalBoundedText(value) {
  if (value === null) return null;
  if (
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) invalidQuery();
  return value;
}

function optionalTimestamp(value) {
  if (value === null) return null;
  if (!validTimestamp(value)) invalidQuery();
  return value;
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function optionalMoney(value) {
  if (value === null) return null;
  if (!validMoney(value)) invalidQuery();
  return value;
}

function validMoney(value) {
  return typeof value === "string" && MONEY_PATTERN.test(value);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidQuery() {
  throw new Error("OPERATOR_QUERY_INVALID");
}

function invalidCursor() {
  throw new Error("OPERATOR_CARD_CURSOR_INVALID");
}
