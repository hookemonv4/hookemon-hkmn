import { createHash } from 'node:crypto';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
export const RECOVERY_LIMITS = Object.freeze({
  journalEvents: 512,
  storeCycles: 16,
  storeAuthorizations: 384,
  storeReceipts: 64,
  payloadObjects: 256,
  payloadArrays: 64,
  payloadArrayItems: 64,
  payloadAggregateBytes: 262_144,
  canonicalDepth: 32,
  canonicalObjectFields: 64,
  canonicalObjects: 20_000,
  canonicalArrays: 10_000,
  canonicalArrayItems: 512,
  canonicalAggregateBytes: 4_194_304,
  propertyKeyBytes: 256,
  decimalDigits: 78,
  hexChars: 131_072,
  stringChars: 262_144,
  messageHexChars: 131_072,
  signedHexChars: 262_144,
  instructions: 16,
  accountsPerInstruction: 64,
  signers: 16,
  activityMovements: 16,
});

export function assertBoundedCanonicalValue(value, label = 'canonical value', limits = {}) {
  const maximums = {
    objects: limits.objects ?? RECOVERY_LIMITS.canonicalObjects,
    arrays: limits.arrays ?? RECOVERY_LIMITS.canonicalArrays,
    arrayItems: limits.arrayItems ?? RECOVERY_LIMITS.canonicalArrayItems,
    aggregateBytes: limits.aggregateBytes ?? RECOVERY_LIMITS.canonicalAggregateBytes,
  };
  const active = new WeakSet();
  let objects = 0;
  let arrays = 0;
  let aggregateBytes = 0;

  function addEncodedBytes(value, kind) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (kind === 'property key' && bytes > RECOVERY_LIMITS.propertyKeyBytes) throw new Error(`${label} property key byte limit exceeded`);
    aggregateBytes += bytes;
    if (aggregateBytes > maximums.aggregateBytes) throw new Error(`${label} aggregate encoded byte budget exceeded`);
  }

  function visit(current, depth) {
    if (depth > RECOVERY_LIMITS.canonicalDepth) throw new Error(`${label} depth limit exceeded`);
    if (typeof current === 'string') {
      if (current.length > RECOVERY_LIMITS.stringChars) throw new Error(`${label} string length limit exceeded`);
      addEncodedBytes(current, 'string');
      if (/^[0-9]+$/.test(current) && current.length > RECOVERY_LIMITS.decimalDigits) throw new Error(`${label} decimal digit limit exceeded`);
      if (/^(?:[0-9a-f]{2})+$/.test(current) && current.length > RECOVERY_LIMITS.hexChars) throw new Error(`${label} hex byte limit exceeded`);
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (active.has(current)) throw new Error(`${label} cyclic value is unsupported`);
    active.add(current);
    if (Array.isArray(current)) {
      arrays += 1;
      if (arrays > maximums.arrays) throw new Error(`${label} array count limit exceeded`);
      if (current.length > maximums.arrayItems) throw new Error(`${label} array item limit exceeded`);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (let index = 0; index < current.length; index += 1) {
        const key = String(index);
        addEncodedBytes(key, 'property key');
        const descriptor = descriptors[key];
        if (descriptor && Object.hasOwn(descriptor, 'value')) visit(descriptor.value, depth + 1);
      }
    } else {
      objects += 1;
      if (objects > maximums.objects) throw new Error(`${label} object count limit exceeded`);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors);
      if (keys.length > RECOVERY_LIMITS.canonicalObjectFields) throw new Error(`${label} object field count limit exceeded`);
      for (const key of keys) {
        addEncodedBytes(key, 'property key');
        const descriptor = descriptors[key];
        if (Object.hasOwn(descriptor, 'value')) visit(descriptor.value, depth + 1);
      }
    }
    active.delete(current);
  }

  visit(value, 0);
}

function assertCanonicalArray(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('canonical array prototype is invalid');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('canonical array symbols are unsupported');
  const propertyNames = Object.getOwnPropertyNames(value);
  if (propertyNames.length !== value.length + 1 || !propertyNames.includes('length') || propertyNames.some(name => name !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length))) throw new Error('canonical array properties are invalid');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('canonical array must be dense and unadorned');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('canonical array property is invalid');
  }
}

function assertCanonicalObject(value) {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('canonical object must be plain');
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error('canonical object symbols are unsupported');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (forbiddenKeys.has(key)) throw new Error('canonical object prototype-pollution key is unsupported');
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`canonical object property ${key} is invalid`);
  }
}

function canonicalJsonUnchecked(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('canonical number must be finite and not -0');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') throw new Error('canonical bigint is unsupported');
  if (Array.isArray(value)) {
    assertCanonicalArray(value);
    return `[${value.map(canonicalJsonUnchecked).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    assertCanonicalObject(value);
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJsonUnchecked(value[key])}`).join(',')}}`;
  }
  throw new Error(`canonical value has unsupported type ${typeof value}`);
}

export function canonicalJson(value) {
  assertBoundedCanonicalValue(value);
  return canonicalJsonUnchecked(value);
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function assertJournalEntry(entry, cycleId, index, previousDigest) {
  const payloadDescriptor = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.getOwnPropertyDescriptor(entry, 'payload')
    : undefined;
  if (!payloadDescriptor || !Object.hasOwn(payloadDescriptor, 'value')) throw new Error('journal payload must be an own data property without an accessor');
  assertBoundedCanonicalValue(payloadDescriptor.value, 'journal payload', {
    objects: RECOVERY_LIMITS.payloadObjects,
    arrays: RECOVERY_LIMITS.payloadArrays,
    arrayItems: RECOVERY_LIMITS.payloadArrayItems,
    aggregateBytes: RECOVERY_LIMITS.payloadAggregateBytes,
  });
  assertCanonicalObject(entry);
  const fields = ['cycleId', 'index', 'kind', 'payload', 'previousDigest', 'digest'];
  if (Object.keys(entry).length !== fields.length || !fields.every(field => Object.hasOwn(entry, field))) throw new Error('journal event must use the exact schema');
  if (entry.cycleId !== cycleId || entry.index !== index || entry.previousDigest !== previousDigest) throw new Error('journal event predecessor is invalid');
  if (typeof entry.kind !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(entry.kind)) throw new Error('journal event kind is invalid');
  assertCanonicalObject(entry.payload);
  const { digest: entryDigest, ...unsigned } = entry;
  if (entryDigest !== digest(unsigned)) throw new Error('journal event digest is invalid');
}

export class CycleJournal {
  #cycleId;
  #entries = [];

  constructor(cycleId, entries = []) {
    if (typeof cycleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/.test(cycleId)) throw new Error('cycleId is invalid');
    if (!Array.isArray(entries)) throw new Error('journal entries must be an array');
    if (entries.length > RECOVERY_LIMITS.journalEvents) throw new Error('journal event count limit exceeded');
    this.#cycleId = cycleId;
    entries.forEach((entry, index) => {
      const previousDigest = index === 0 ? null : entries[index - 1].digest;
      assertJournalEntry(entry, cycleId, index, previousDigest);
    });
    this.#entries = structuredClone(entries);
  }

  get head() { return this.#entries.at(-1)?.digest ?? null; }
  get cycleId() { return this.#cycleId; }
  get entries() { return structuredClone(this.#entries); }

  propose(kind, payload) {
    assertBoundedCanonicalValue(payload, 'journal payload', {
      objects: RECOVERY_LIMITS.payloadObjects,
      arrays: RECOVERY_LIMITS.payloadArrays,
      arrayItems: RECOVERY_LIMITS.payloadArrayItems,
      aggregateBytes: RECOVERY_LIMITS.payloadAggregateBytes,
    });
    canonicalJson(payload);
    const entry = {
      cycleId: this.#cycleId,
      index: this.#entries.length,
      kind,
      payload: structuredClone(payload),
      previousDigest: this.head,
    };
    entry.digest = digest(entry);
    assertJournalEntry(entry, this.#cycleId, this.#entries.length, this.head);
    return structuredClone(entry);
  }

  appendEvent(entry) {
    assertJournalEntry(entry, this.#cycleId, this.#entries.length, this.head);
    this.#entries.push(structuredClone(entry));
    return structuredClone(entry);
  }

  append(kind, payload) {
    return this.appendEvent(this.propose(kind, payload));
  }

  prepareIntent({ actionKind, request, bindingDigest }) {
    if (!actionKind || !request || !bindingDigest) throw new Error('intent requires actionKind, request, and bindingDigest');
    const requestDigest = digest(request);
    const entry = this.append('intent', { actionKind, request, requestDigest, bindingDigest });
    return { cycleId: this.#cycleId, actionKind, requestDigest, bindingDigest, journalHead: entry.digest };
  }

  verify() {
    try {
      this.#entries.forEach((entry, index) => assertJournalEntry(entry, this.#cycleId, index, index === 0 ? null : this.#entries[index - 1].digest));
      return true;
    } catch {
      return false;
    }
  }
}
