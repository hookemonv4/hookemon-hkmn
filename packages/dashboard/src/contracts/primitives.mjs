// Shared validation primitives used by every contracts/*.mjs port of a website validator (readSet:
// apps/web/lib/public-cycle-status.ts, public-community-snapshot.ts on the legacy
// codex/mainnet-cycle-canary branch). Kept in one place so every port shares byte-identical rules for
// money strings, ISO timestamps, and bounded text/arrays instead of six near-duplicate copies drifting
// apart.
export const MAX_TEXT_LENGTH = 512;

export class ContractValidationError extends TypeError {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function invalidWith(code) {
  return () => {
    throw new ContractValidationError(code);
  };
}

export function requiredRecord(value, invalid) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  return value;
}

export function requiredKeys(value, required, invalid) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
}

export function exactKeys(value, allowed, invalid) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

export function boundedArray(value, maximumLength, invalid) {
  if (!Array.isArray(value) || value.length > maximumLength) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
  }
  return value;
}

export function boundedText(value, invalid) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) invalid();
  return value;
}

export function optionalText(value, invalid) {
  return value === null ? null : boundedText(value, invalid);
}

export function nullableText(value, invalid) {
  return value === undefined || value === null ? null : boundedText(value, invalid);
}

export function isoTimestamp(value, invalid) {
  const text = boundedText(value, invalid);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== text) invalid();
  return text;
}

export function optionalTimestamp(value, invalid) {
  return value === null ? null : isoTimestamp(value, invalid);
}

export function money(value, invalid) {
  const result = optionalMoney(value, invalid);
  if (result === null) invalid();
  return result;
}

export function optionalMoney(value, invalid) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

export function nullableMoney(value, invalid) {
  return value === undefined || value === null ? null : money(value, invalid);
}

export function optionalSignedMoney(value, invalid) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

export function nullableSignedMoney(value, invalid) {
  return value === undefined || value === null ? null : optionalSignedMoney(value, invalid);
}

export function nonNegativeInteger(value, invalid) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function positiveSafeInteger(value, invalid) {
  const result = nonNegativeInteger(value, invalid);
  if (result === 0) invalid();
  return result;
}

export function count(value, invalid) {
  return nonNegativeInteger(value, invalid);
}

export function httpsUrl(value, invalid) {
  let url;
  try {
    url = new URL(boundedText(value, invalid));
  } catch {
    invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password) invalid();
  return url.toString();
}

export function subtractAtZero(minuend, subtrahend) {
  if (
    minuend.length < subtrahend.length
    || (minuend.length === subtrahend.length && minuend.localeCompare(subtrahend) <= 0)
  ) return '0';
  let borrow = 0;
  let result = '';
  for (let offset = 0; offset < minuend.length; offset += 1) {
    let digit = Number(minuend.at(-1 - offset)) - Number(subtrahend.at(-1 - offset) ?? 0) - borrow;
    borrow = digit < 0 ? 1 : 0;
    if (digit < 0) digit += 10;
    result = String(digit) + result;
  }
  return result.replace(/^0+/, '') || '0';
}

export function subtractBigIntAtZero(minuend, subtrahend) {
  return (minuend > subtrahend ? minuend - subtrahend : 0n).toString();
}
