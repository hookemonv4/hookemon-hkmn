import { canonicalJson, digest } from '../cycle/journal.mjs';

const snapshotInputFields = ['source', 'observedAt', 'sourcePayloadDigest', 'packs'];
const snapshotFields = ['schema', ...snapshotInputFields, 'snapshotDigest'];
const packFields = ['code'];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function assertExactPlainObject(value, fields, label) {
  canonicalJson(value);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
  ) throw new Error(`${label} must use the exact schema`);
}

function assertPackRecords(packs) {
  if (!Array.isArray(packs) || packs.length === 0) throw new Error('pack snapshot packs are invalid');
  let previous = null;
  for (const record of packs) {
    assertExactPlainObject(record, packFields, 'pack snapshot record');
    if (typeof record.code !== 'string' || !packCodePattern.test(record.code)) throw new Error('pack snapshot code is invalid');
    if (previous !== null && record.code <= previous) throw new Error('pack snapshot records must be unique and sorted');
    previous = record.code;
  }
}

function assertSnapshotBody(value, fields) {
  assertExactPlainObject(value, fields, 'pack snapshot');
  if (value.source !== 'collector') throw new Error('pack snapshot source is invalid');
  if (typeof value.observedAt !== 'string' || new Date(value.observedAt).toISOString() !== value.observedAt) throw new Error('pack snapshot observedAt is invalid');
  if (typeof value.sourcePayloadDigest !== 'string' || !digestPattern.test(value.sourcePayloadDigest)) throw new Error('pack snapshot source payload digest is invalid');
  assertPackRecords(value.packs);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createPackSnapshot(input) {
  assertSnapshotBody(input, snapshotInputFields);
  const body = {
    schema: 'hookemon.pack-snapshot.v1',
    source: input.source,
    observedAt: input.observedAt,
    sourcePayloadDigest: input.sourcePayloadDigest,
    packs: structuredClone(input.packs),
  };
  return deepFreeze({
    ...body,
    snapshotDigest: digest({ domain: body.schema, snapshot: body }),
  });
}

export function assertPackSnapshot(value) {
  assertSnapshotBody(value, snapshotFields);
  if (value.schema !== 'hookemon.pack-snapshot.v1') throw new Error('pack snapshot schema is invalid');
  if (typeof value.snapshotDigest !== 'string' || !digestPattern.test(value.snapshotDigest)) throw new Error('pack snapshot digest is invalid');
  const { snapshotDigest, ...body } = value;
  if (snapshotDigest !== digest({ domain: body.schema, snapshot: body })) throw new Error('pack snapshot digest mismatch');
  return value;
}

export function selectPack(snapshotValue, packCode) {
  const snapshot = assertPackSnapshot(snapshotValue);
  if (typeof packCode !== 'string' || !packCodePattern.test(packCode)) throw new Error('selected pack code is invalid');
  if (!snapshot.packs.some(record => record.code === packCode)) throw new Error('selected pack is absent from the exact snapshot');
  return Object.freeze({ snapshotDigest: snapshot.snapshotDigest, pack: packCode });
}
