import { canonicalJson, digest, assertJournalEntry, RECOVERY_LIMITS } from './journal.mjs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const cyclePattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const actionKinds = new Set(['outbound', 'generate', 'status', 'open', 'purchase', 'buyback', 'return', 'payout']);
const authorizationKinds = new Set(['mutation', 'sign', 'broadcast', 'asset-spend', 'gas-spend', 'buyback-policy', 'vault-payout']);

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  canonicalJson(value);
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) throw new Error(`${label} must use the exact schema`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
}

export function assertCycleId(value) {
  if (typeof value !== 'string' || !cyclePattern.test(value)) throw new Error('cycleId is invalid');
}

export function assertAuthorizationRecord(value) {
  exactObject(value, ['key', 'nonceKey', 'cycleId', 'actionKind', 'authorizationKind', 'actionDigest', 'subjectDigest', 'commitment', 'validatedAt'], 'fixture authorization store record');
  assertDigest(value.key, 'authorization key');
  assertDigest(value.nonceKey, 'authorization nonce key');
  assertDigest(value.actionDigest, 'authorization action digest');
  assertDigest(value.subjectDigest, 'authorization subject digest');
  assertDigest(value.commitment, 'authorization commitment');
  assertCycleId(value.cycleId);
  if (!actionKinds.has(value.actionKind) || !authorizationKinds.has(value.authorizationKind)) throw new Error('authorization ownership is invalid');
  if (typeof value.validatedAt !== 'string' || new Date(value.validatedAt).toISOString() !== value.validatedAt) throw new Error('authorization validation time is invalid');
  return structuredClone(value);
}

export function assertReceiptRecord(value) {
  exactObject(value, ['key', 'provider', 'providerReceiptId', 'cycleId', 'actionKind', 'receiptDigest', 'receiptCommitment'], 'fixture receipt store record');
  for (const field of ['key', 'receiptDigest', 'receiptCommitment']) assertDigest(value[field], `receipt ${field}`);
  assertCycleId(value.cycleId);
  if (!actionKinds.has(value.actionKind)) throw new Error('receipt action ownership is invalid');
  if (typeof value.provider !== 'string' || !/^[a-z0-9-]{2,64}$/.test(value.provider)) throw new Error('receipt provider is invalid');
  if (typeof value.providerReceiptId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.providerReceiptId)) throw new Error('receipt provider id is invalid');
  return structuredClone(value);
}

export function assertCycleSnapshot(value) {
  const entries = Object.getOwnPropertyDescriptor(value ?? {}, 'entries')?.value;
  if (Array.isArray(entries) && entries.length > RECOVERY_LIMITS.journalEvents) throw new Error('fixture cycle journal event count limit exceeded');
  exactObject(value, ['cycleId', 'version', 'journalHead', 'entries'], 'fixture cycle store snapshot');
  assertCycleId(value.cycleId);
  if (!Number.isInteger(value.version) || value.version < 0 || value.version !== value.entries.length) throw new Error('fixture cycle store version is invalid');
  if (!Array.isArray(value.entries)) throw new Error('fixture cycle store entries are invalid');
  let head = null;
  value.entries.forEach((entry, index) => {
    assertJournalEntry(entry, value.cycleId, index, head);
    head = entry.digest;
  });
  if (value.journalHead !== head) throw new Error('fixture cycle store head is invalid');
  return structuredClone(value);
}

class FixtureCycleTransaction {
  #closed = false;
  #store;
  #events = [];
  #authorizations = new Map();
  #receipts = new Map();

  constructor(store, cycleId, expectedVersion, expectedJournalHead) {
    this.#store = store;
    this.cycleId = cycleId;
    this.expectedVersion = expectedVersion;
    this.expectedJournalHead = expectedJournalHead;
  }

  #assertOpen() {
    if (this.#closed) throw new Error('fixture cycle transaction is closed');
  }

  assertOwner(store) {
    this.#assertOpen();
    if (this.#store !== store) throw new Error('fixture cycle transaction belongs to a different store');
  }

  stageEvent(value) {
    this.#assertOpen();
    this.#events.push(structuredClone(value));
  }

  consumeAuthorization(value) {
    this.#assertOpen();
    const record = assertAuthorizationRecord(value);
    if (this.#authorizations.has(record.key)) throw new Error('fixture authorization was staged more than once');
    const persisted = this.#store.authorizationRecord(record.key);
    if (persisted && canonicalJson(persisted) !== canonicalJson(record)) throw new Error('authorization already consumed by different evidence');
    const nonceOwner = this.#store.authorizationKeyForNonce(record.nonceKey);
    if (nonceOwner && nonceOwner !== record.key) throw new Error('authorization nonce already consumed');
    for (const staged of this.#authorizations.values()) {
      if (staged.nonceKey === record.nonceKey && staged.key !== record.key) throw new Error('authorization nonce already staged');
    }
    this.#authorizations.set(record.key, record);
    return record.key;
  }

  consumeReceipt(value) {
    this.#assertOpen();
    const record = assertReceiptRecord(value);
    if (this.#receipts.has(record.key)) throw new Error('fixture receipt was staged more than once');
    const persisted = this.#store.receiptRecord(record.key);
    if (persisted && canonicalJson(persisted) !== canonicalJson(record)) throw new Error('provider receipt already consumed by a different cycle or receipt');
    this.#receipts.set(record.key, record);
    return record.key;
  }

  consume(value) { return this.consumeReceipt(value); }

  authorizationRecord(key) { return this.#store.authorizationRecord(key); }
  receiptRecord(key) { return this.#store.receiptRecord(key); }
  assertStagedRecordsPersisted() {
    this.#assertOpen();
    for (const [key, record] of this.#authorizations) {
      const persisted = this.#store.authorizationRecord(key);
      if (!persisted) throw new Error('journal-derived authorization is missing from durable cycle store');
      if (canonicalJson(persisted) !== canonicalJson(record)) throw new Error('journal-derived authorization differs from durable cycle store');
    }
    for (const [key, record] of this.#receipts) {
      const persisted = this.#store.receiptRecord(key);
      if (!persisted) throw new Error('journal-derived receipt is missing from durable cycle store');
      if (canonicalJson(persisted) !== canonicalJson(record)) throw new Error('journal-derived receipt differs from durable cycle store');
    }
  }
  get stagedEvents() { return structuredClone(this.#events); }
  get stagedAuthorizations() { return new Map([...this.#authorizations].map(([key, value]) => [key, structuredClone(value)])); }
  get stagedReceipts() { return new Map([...this.#receipts].map(([key, value]) => [key, structuredClone(value)])); }
  close() { this.#closed = true; }
}

export class FixtureCycleStore {
  #cycles = new Map();
  #authorizations = new Map();
  #authorizationNonces = new Map();
  #receipts = new Map();

  constructor(snapshot = { schema: 'hookemon.fixture-cycle-store.v1', cycles: [], authorizations: [], receipts: [] }) {
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      const cycles = Object.getOwnPropertyDescriptor(snapshot, 'cycles')?.value;
      const authorizations = Object.getOwnPropertyDescriptor(snapshot, 'authorizations')?.value;
      const receipts = Object.getOwnPropertyDescriptor(snapshot, 'receipts')?.value;
      if (Array.isArray(cycles) && cycles.length > RECOVERY_LIMITS.storeCycles) throw new Error('fixture cycle store cycle count limit exceeded');
      if (Array.isArray(authorizations) && authorizations.length > RECOVERY_LIMITS.storeAuthorizations) throw new Error('fixture authorization count limit exceeded');
      if (Array.isArray(receipts) && receipts.length > RECOVERY_LIMITS.storeReceipts) throw new Error('fixture receipt count limit exceeded');
    }
    exactObject(snapshot, ['schema', 'cycles', 'authorizations', 'receipts'], 'fixture cycle store');
    if (snapshot.schema !== 'hookemon.fixture-cycle-store.v1' || !Array.isArray(snapshot.cycles) || !Array.isArray(snapshot.authorizations) || !Array.isArray(snapshot.receipts)) throw new Error('fixture cycle store snapshot is invalid');
    for (const value of snapshot.cycles) {
      const cycle = assertCycleSnapshot(value);
      if (this.#cycles.has(cycle.cycleId)) throw new Error('duplicate fixture cycle store cycle');
      this.#cycles.set(cycle.cycleId, cycle);
    }
    for (const value of snapshot.authorizations) {
      const record = assertAuthorizationRecord(value);
      if (this.#authorizations.has(record.key) || this.#authorizationNonces.has(record.nonceKey)) throw new Error('duplicate fixture authorization store record');
      this.#authorizations.set(record.key, record);
      this.#authorizationNonces.set(record.nonceKey, record.key);
    }
    for (const value of snapshot.receipts) {
      const record = assertReceiptRecord(value);
      if (this.#receipts.has(record.key)) throw new Error('duplicate fixture receipt store record');
      this.#receipts.set(record.key, record);
    }
  }

  static reopen(snapshot) { return new FixtureCycleStore(snapshot); }

  get snapshot() {
    return {
      schema: 'hookemon.fixture-cycle-store.v1',
      cycles: [...this.#cycles.values()].sort((a, b) => a.cycleId.localeCompare(b.cycleId)).map(value => structuredClone(value)),
      authorizations: [...this.#authorizations.values()].sort((a, b) => a.key.localeCompare(b.key)).map(value => structuredClone(value)),
      receipts: [...this.#receipts.values()].sort((a, b) => a.key.localeCompare(b.key)).map(value => structuredClone(value)),
    };
  }

  readCycle(cycleId) {
    assertCycleId(cycleId);
    const cycle = this.#cycles.get(cycleId);
    return cycle ? structuredClone(cycle) : { cycleId, version: 0, journalHead: null, entries: [] };
  }

  authorizationRecord(key) { return this.#authorizations.has(key) ? structuredClone(this.#authorizations.get(key)) : null; }
  authorizationKeyForNonce(nonceKey) { return this.#authorizationNonces.get(nonceKey) ?? null; }
  receiptRecord(key) { return this.#receipts.has(key) ? structuredClone(this.#receipts.get(key)) : null; }

  begin(cycleId, { expectedVersion, expectedJournalHead }) {
    assertCycleId(cycleId);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('expected cycle version is invalid');
    if (expectedJournalHead !== null) assertDigest(expectedJournalHead, 'expected cycle head');
    return new FixtureCycleTransaction(this, cycleId, expectedVersion, expectedJournalHead);
  }

  commit(transaction) {
    if (!(transaction instanceof FixtureCycleTransaction)) throw new Error('fixture cycle transaction is invalid');
    transaction.assertOwner(this);
    try {
      const stagedEvents = transaction.stagedEvents;
      const stagedAuthorizations = transaction.stagedAuthorizations;
      const stagedReceipts = transaction.stagedReceipts;
      if (stagedEvents.length === 0) throw new Error('fixture cycle transaction requires a journal event');

      const current = this.readCycle(transaction.cycleId);
      if (current.version !== transaction.expectedVersion) throw new Error('stale cycle journal version');
      if (current.journalHead !== transaction.expectedJournalHead) throw new Error('stale cycle journal head');

      const candidateEntries = structuredClone(current.entries);
      let head = current.journalHead;
      for (const entry of stagedEvents) {
        assertJournalEntry(entry, transaction.cycleId, candidateEntries.length, head);
        candidateEntries.push(entry);
        head = entry.digest;
      }

      const stagedNonces = new Map();
      for (const [key, record] of stagedAuthorizations) {
        if (record.cycleId !== transaction.cycleId) throw new Error('authorization cycle mismatch');
        const existing = this.#authorizations.get(key);
        if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new Error('authorization already consumed by different evidence');
        const nonceOwner = this.#authorizationNonces.get(record.nonceKey) ?? stagedNonces.get(record.nonceKey);
        if (nonceOwner && nonceOwner !== key) throw new Error('authorization nonce already consumed');
        stagedNonces.set(record.nonceKey, key);
      }
      for (const [key, record] of stagedReceipts) {
        if (record.cycleId !== transaction.cycleId) throw new Error('receipt cycle mismatch');
        const existing = this.#receipts.get(key);
        if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new Error('provider receipt already consumed by a different cycle or receipt');
      }

      this.#cycles.set(transaction.cycleId, { cycleId: transaction.cycleId, version: candidateEntries.length, journalHead: head, entries: candidateEntries });
      for (const [key, record] of stagedAuthorizations) {
        this.#authorizations.set(key, record);
        this.#authorizationNonces.set(record.nonceKey, key);
      }
      for (const [key, record] of stagedReceipts) this.#receipts.set(key, record);
    } finally {
      transaction.close();
    }
  }
}
