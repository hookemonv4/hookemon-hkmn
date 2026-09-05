import { createHash } from 'node:crypto';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) normalized[key] = normalize(value[key]);
    return normalized;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonical JSON cannot encode non-finite numbers');
  if (['string', 'number', 'boolean'].includes(typeof value) || value === null) return value;
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function stableJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(normalize(value), null, 2)}\n`, 'utf8');
}

export function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function sha256CanonicalJson(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
