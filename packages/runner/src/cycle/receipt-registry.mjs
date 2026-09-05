import { canonicalJson, digest } from './journal.mjs';
import { assertDigest, assertPlainObject, FIXTURE_ACTION_KINDS } from './schemas.mjs';

const recordFields = ['key', 'provider', 'providerReceiptId', 'cycleId', 'actionKind', 'receiptDigest', 'receiptCommitment'];

function assertRecord(record) {
  assertPlainObject(record, recordFields, 'fixture receipt registry record');
  if (typeof record.provider !== 'string' || !/^[a-z0-9-]{2,64}$/.test(record.provider) || typeof record.providerReceiptId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(record.providerReceiptId)) throw new Error('fixture receipt registry provider identity is invalid');
  if (typeof record.cycleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/.test(record.cycleId) || !FIXTURE_ACTION_KINDS.includes(record.actionKind)) throw new Error('fixture receipt registry ownership action is invalid');
  for (const field of ['key', 'receiptDigest', 'receiptCommitment']) assertDigest(record[field], `fixture receipt registry ${field}`);
  const expectedKey = digest({ domain: 'hookemon.fixture-receipt-registry.v1', provider: record.provider, providerReceiptId: record.providerReceiptId });
  if (record.key !== expectedKey) throw new Error('fixture receipt registry key is invalid');
  return structuredClone(record);
}

class FixtureReceiptTransaction {
  #baseVersion;
  #records;
  #closed = false;

  constructor(version, records) {
    this.#baseVersion = version;
    this.#records = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
  }

  get baseVersion() { return this.#baseVersion; }
  get records() { return new Map([...this.#records].map(([key, value]) => [key, structuredClone(value)])); }

  consume(recordValue) {
    if (this.#closed) throw new Error('fixture receipt transaction is closed');
    const record = assertRecord(recordValue);
    const existing = this.#records.get(record.key);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new Error('provider receipt already consumed by a different cycle or receipt');
    this.#records.set(record.key, record);
    return record.key;
  }

  close() {
    if (this.#closed) throw new Error('fixture receipt transaction is closed');
    this.#closed = true;
  }
}

export class FixtureReceiptRegistry {
  #records = new Map();
  #version = 0;

  constructor(snapshot = []) {
    if (!Array.isArray(snapshot)) throw new Error('fixture receipt registry snapshot is invalid');
    for (const value of snapshot) {
      const record = assertRecord(value);
      if (this.#records.has(record.key)) throw new Error('fixture receipt registry snapshot contains duplicate keys');
      this.#records.set(record.key, record);
    }
  }

  static reopen(snapshot) { return new FixtureReceiptRegistry(snapshot); }

  get snapshot() {
    return [...this.#records.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(record => structuredClone(record));
  }

  begin() {
    return new FixtureReceiptTransaction(this.#version, this.#records);
  }

  commit(transaction) {
    if (!(transaction instanceof FixtureReceiptTransaction) || transaction.baseVersion !== this.#version) throw new Error('stale fixture receipt transaction');
    this.#records = transaction.records;
    transaction.close();
    this.#version += 1;
  }
}
