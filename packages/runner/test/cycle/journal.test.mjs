import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureAuthorizationDigest, AuthorizationLedger } from '../../src/cycle/authorization.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { decodeFixtureOnlyMessage, verifyFixtureSignedTransaction } from '../../src/cycle/decoder.mjs';
import { CycleJournal, RECOVERY_LIMITS, canonicalJson, digest } from '../../src/cycle/journal.mjs';
import { signFixtureOwnerApproval } from './fixture-crypto.mjs';

function approval() {
  const value = {
    schema: 'hookemon.fixture-owner-approval.v1',
    fixtureOwner: 'fixture-owner',
    cycleId: 'cycle-1',
    actionKind: 'outbound',
    authorizationKind: 'mutation',
    subjectDigest: 'sha256:' + '1'.repeat(64),
    preflightDigest: 'sha256:' + '9'.repeat(64),
    operationsTrigger: '0x0000000000000000000000000000000000001004',
    cycleVaultAccount: '0x0000000000000000000000000000000000001002',
    policyAccount: 'fixture-solana-policy-account',
    returnAccount: '0x0000000000000000000000000000000000002002',
    principalAmount: '10',
    minimumReceive: '10',
    nativeGasAmount: '1',
    provider: 'fixture-provider',
    actionDigest: 'sha256:' + '1'.repeat(64),
    bindingDigest: 'sha256:' + '2'.repeat(64),
    sourceAccount: 'fixture-source-account',
    inputAsset: 'USDG',
    outputAsset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    destination: 'fixture-destination',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    nftMint: 'fixture-nft-mint',
    nftCustodyAccount: 'fixture-solana-policy-account',
    amount: '10',
    instructionsDigest: 'sha256:' + '3'.repeat(64),
    signersDigest: 'sha256:' + '4'.repeat(64),
    nonce: 'outbound-nonce',
    attempt: 1,
    expiry: '2030-01-01T00:00:00.000Z',
    fixtureApprovalDigest: '',
    fixtureApprovalSignature: '',
  };
  const fixtureApprovalDigest = fixtureAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  return { ...unsigned, fixtureApprovalSignature: signFixtureOwnerApproval(unsigned) };
}

test('hash chains exact journal events and restores exact approval consumption', () => {
  const journal = new CycleJournal('cycle-1');
  const entry = journal.append('fixture-event', { value: 'one' });
  assert.equal(entry.previousDigest, null);
  assert.equal(journal.verify(), true);
  const ledger = new AuthorizationLedger();
  const verified = approval();
  assert.equal(ledger.consume(verified, structuredClone(verified)), verified.fixtureApprovalDigest);
  assert.throws(() => ledger.consume(verified, structuredClone(verified)), /already consumed/);
  assert.throws(() => new AuthorizationLedger().consume(verified, { ...verified, amount: '11' }), /mismatch/);
});

test('rejects values without a stable canonical JSON-safe representation', () => {
  const sparse = [];
  sparse.length = 1;
  const customArray = [1];
  customArray.extra = true;
  const hiddenArray = [1];
  Object.defineProperty(hiddenArray, 'hidden', { value: true });
  const pollutedJson = JSON.parse('{"__proto__":{"polluted":true}}');
  for (const value of [
    undefined,
    () => {},
    Symbol('x'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    new Map(),
    new Set(),
    new Date(),
    new Uint8Array([1]),
    { get x() { return 1; } },
    Object.create({ polluted: true }),
    sparse,
    customArray,
    hiddenArray,
    pollutedJson,
  ]) assert.throws(() => canonicalJson(value));
});

test('keeps primitive types collision-free in canonical digests', () => {
  const values = [null, true, false, 0, 1, '0', '1', [], {}, [1], { value: 1 }];
  const digests = values.map(value => digest(value));
  assert.equal(new Set(digests).size, digests.length);
});

test('rejects forged journal indices, predecessors, digests, prototypes, and payload accessors', () => {
  const journal = new CycleJournal('cycle-1');
  journal.append('fixture-event', { value: 'one' });
  const mutations = [
    entries => { entries[0].index = 2; },
    entries => { entries[0].previousDigest = 'sha256:' + '1'.repeat(64); },
    entries => { entries[0].digest = 'sha256:' + '2'.repeat(64); },
    entries => { entries[0].payload = Object.create({ attacker: true }); },
  ];
  for (const mutate of mutations) {
    const entries = journal.entries;
    mutate(entries);
    assert.throws(() => new CycleJournal('cycle-1', entries));
  }
});

test('rejects oversized recovery collections and payload shapes at the outer boundary', () => {
  assert.throws(
    () => new CycleJournal('cycle-bounded', Array.from({ length: RECOVERY_LIMITS.journalEvents + 1 }, () => ({}))),
    /journal.*(?:count|limit|bound|large)/i,
  );
  assert.throws(
    () => new FixtureCycleStore({
      schema: 'hookemon.fixture-cycle-store.v1',
      cycles: [],
      authorizations: Array.from({ length: RECOVERY_LIMITS.storeAuthorizations + 1 }, () => ({})),
      receipts: [],
    }),
    /authorization.*(?:count|limit|bound|large)/i,
  );
  assert.throws(
    () => new CycleJournal('cycle-object-bound').append('fixture-event', Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, index]))),
    /object.*(?:count|limit|bound|large)|payload.*(?:count|limit|bound|large)/i,
  );
  assert.throws(
    () => new CycleJournal('cycle-array-bound').append('fixture-event', { values: Array.from({ length: 65 }, (_, index) => index) }),
    /array.*(?:count|limit|bound|large)|payload.*(?:count|limit|bound|large)/i,
  );
  assert.throws(
    () => new CycleJournal('cycle-decimal-bound').append('fixture-event', { amount: '9'.repeat(79) }),
    /decimal.*(?:digit|limit|bound|large)/i,
  );
});

test('rejects oversized message and signed bytes before allocation or parsing', () => {
  assert.throws(() => decodeFixtureOnlyMessage('aa'.repeat(65_537)), /message.*(?:byte|limit|bound|large)/i);
  assert.throws(() => verifyFixtureSignedTransaction('aa'.repeat(131_073), {}), /signed.*(?:byte|limit|bound|large)/i);
});

test('rejects oversized property keys before journal serialization', () => {
  const oversizedKey = `key-${'x'.repeat(1_025)}`;
  assert.throws(
    () => new CycleJournal('cycle-key-budget').append('fixture-event', { [oversizedKey]: 'value' }),
    /property key.*(?:byte|limit|budget|large)/i,
  );
});

test('rejects aggregate payload string bytes even when every string is individually allowed', () => {
  const payload = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field-${index}`, 'z'.repeat(5_000)]));
  assert.throws(
    () => new CycleJournal('cycle-aggregate-budget').append('fixture-event', payload),
    /aggregate.*(?:byte|limit|budget)|payload.*byte budget/i,
  );
});

test('rejects a journal payload accessor without evaluating it', () => {
  let evaluated = false;
  const entry = {
    cycleId: 'cycle-payload-accessor',
    index: 0,
    kind: 'fixture-event',
    previousDigest: null,
    digest: 'sha256:' + '0'.repeat(64),
  };
  Object.defineProperty(entry, 'payload', {
    enumerable: true,
    get() {
      evaluated = true;
      throw new Error('payload accessor evaluated');
    },
  });

  assert.throws(() => new CycleJournal('cycle-payload-accessor', [entry]), /payload.*(?:accessor|data property|descriptor)/i);
  assert.equal(evaluated, false);
});
