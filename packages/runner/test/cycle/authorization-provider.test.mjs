import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import test from 'node:test';

import * as authorizationProvider from '../../src/cycle/authorization-provider.mjs';
import {
  createFixtureAuthorizationProvider,
  createStandingAuthorityProvider,
  isStandingAuthorityProvider,
  publicKeyFingerprint,
  stepAuthorizationNow,
  standingAuthorityDocumentDigest,
  stepAuthorizationIntentDigest,
  verifyStandingAuthorityDocument,
} from '../../src/cycle/authorization-provider.mjs';
import { verifyFixtureAuthorization } from '../../src/cycle/authorization.mjs';
import { digest } from '../../src/cycle/journal.mjs';

// Every key used in this file is generated fresh at test time — never the fixture Ed25519 keypair
// embedded in schemas.mjs/authorization.mjs. This is the point: the standing-authority production path
// must work end to end without ever touching fixture key material.
function freshKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

function sign(privateKey, digestValue) {
  return signMessage(null, Buffer.from(digestValue, 'utf8'), privateKey).toString('base64url');
}

function standingAuthority(ownerKeys, policyKeys, overrides = {}) {
  const base = {
    schema: 'hookemon.standing-authority-document.v1',
    owner: 'owner-standing-authority-key',
    policyPublicKeyFingerprint: publicKeyFingerprint(policyKeys.publicKey),
    perCycleSpendCap: '25000000',
    maxCyclesPerDay: 72,
    allowedPacks: ['collector-ember'],
    allowedDestinations: ['fixture-solana-policy-account'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'standing-authority-2026-01',
    documentDigest: '',
    ownerSignature: '',
    ...overrides,
  };
  const withDigest = { ...base, documentDigest: standingAuthorityDocumentDigest(base) };
  return { ...withDigest, ownerSignature: sign(ownerKeys.privateKey, withDigest.documentDigest) };
}

function stepIntent(authorityDigest, policyKeys, overrides = {}) {
  const base = {
    schema: 'hookemon.standing-authority-step-intent.v1',
    standingAuthorityDigest: authorityDigest,
    cycleId: 'cycle-1',
    actionKind: 'outbound',
    authorizationKind: 'mutation',
    subjectDigest: `sha256:${'a'.repeat(64)}`,
    destination: 'fixture-solana-policy-account',
    pack: 'collector-ember',
    spendAmount: '25000000',
    nonce: 'cycle-1-outbound-mutation-nonce',
    issuedAt: '2026-06-01T00:00:00.000Z',
    policySignature: '',
    ...overrides,
  };
  const digestValue = stepAuthorizationIntentDigest(base);
  return { ...base, policySignature: sign(policyKeys.privateKey, digestValue) };
}

test('resolves one exact policy-signed intent from a document-bound authority artifact', async () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const intent = stepIntent(document.documentDigest, policy, {
    authorizationKind: 'sign',
    subjectDigest: `sha256:${'d'.repeat(64)}`,
    nonce: 'cycle-1-outbound-sign-nonce',
  });
  const artifact = {
    schema: 'hookemon.standing-authority-step-authorizations.v1',
    authorityDigest: document.documentDigest,
    entries: [{ signerRole: 'operator-evm', intent }],
  };

  assert.equal(typeof authorizationProvider.createStandingAuthorityStepAuthorizationResolver, 'function');
  const resolveStepAuthorization = authorizationProvider.createStandingAuthorityStepAuthorizationResolver({
    authorityDigest: document.documentDigest,
    artifact,
  });
  const resolved = await resolveStepAuthorization({
    cycleId: 'cycle-1',
    stage: 'outbound',
    authorizationKind: 'sign',
    requestDigest: intent.subjectDigest,
    signerRole: 'operator-evm',
  });
  assert.deepEqual(resolved, intent);
  assert.notEqual(resolved, intent);
  await assert.rejects(
    () => resolveStepAuthorization({
      cycleId: 'cycle-1',
      stage: 'outbound',
      authorizationKind: 'sign',
      requestDigest: `sha256:${'e'.repeat(64)}`,
      signerRole: 'operator-evm',
    }),
    /no matching/i,
  );
});

test('refuses ambiguous or wrong-authority persisted step authorization artifacts', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const intent = stepIntent(document.documentDigest, policy, {
    authorizationKind: 'sign',
    nonce: 'cycle-1-outbound-sign-nonce',
  });
  const entry = { signerRole: 'operator-evm', intent };

  assert.equal(typeof authorizationProvider.createStandingAuthorityStepAuthorizationResolver, 'function');
  assert.throws(
    () => authorizationProvider.createStandingAuthorityStepAuthorizationResolver({
      authorityDigest: document.documentDigest,
      artifact: {
        schema: 'hookemon.standing-authority-step-authorizations.v1',
        authorityDigest: document.documentDigest,
        entries: [entry, structuredClone(entry)],
      },
    }),
    /ambiguous/i,
  );
  assert.throws(
    () => authorizationProvider.createStandingAuthorityStepAuthorizationResolver({
      authorityDigest: document.documentDigest,
      artifact: {
        schema: 'hookemon.standing-authority-step-authorizations.v1',
        authorityDigest: `sha256:${'f'.repeat(64)}`,
        entries: [entry],
      },
    }),
    /digest/i,
  );
});

test('verifies a well-formed owner-signed standing authority document', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const verified = verifyStandingAuthorityDocument(document, { ownerPublicKey: owner.publicKey });
  assert.equal(verified.documentId, 'standing-authority-2026-01');
  assert.equal(verified.maxCyclesPerDay, 72);
});

test('rejects a standing authority document signed by the wrong key', () => {
  const owner = freshKeyPair();
  const impostor = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(impostor, policy);
  assert.throws(() => verifyStandingAuthorityDocument(document, { ownerPublicKey: owner.publicKey }), /signature/i);
});

test('rejects a standing authority document with a tampered field after signing', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const tampered = { ...document, perCycleSpendCap: '999999999999' };
  assert.throws(() => verifyStandingAuthorityDocument(tampered, { ownerPublicKey: owner.publicKey }), /digest/i);
});

test('constructs a branded StandingAuthorityProvider only when the injected policy key matches the document', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const wrongPolicy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  assert.throws(
    () => createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: wrongPolicy.publicKey }),
    /policy key/i,
  );
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  assert.equal(isStandingAuthorityProvider(provider), true);
  assert.equal(isStandingAuthorityProvider({ ...provider }), false);
});

test('StandingAuthorityProvider accepts a step authorization that satisfies every cap and returns a verified record', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy);
  const verified = provider.verifyStepAuthorization(intent, { now: '2026-06-01T00:00:01.000Z', cyclesToday: 5 });
  assert.equal(verified.verified, true);
  assert.equal(verified.provider, 'standing-authority');
  assert.equal(verified.cycleId, 'cycle-1');
  assert.equal(verified.spendAmount, '25000000');
});

test('StandingAuthorityProvider accepts every remaining signable money-stage action kind', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({
    standingAuthority: document,
    ownerPublicKey: owner.publicKey,
    policyPublicKey: policy.publicKey,
  });

  for (const actionKind of ['claim-process', 'payout']) {
    const intent = stepIntent(document.documentDigest, policy, {
      actionKind,
      nonce: `cycle-1-${actionKind}-sign-nonce`,
      authorizationKind: 'sign',
    });
    assert.equal(
      provider.verifyStepAuthorization(intent, { now: '2026-06-01T00:00:01.000Z' }).actionKind,
      actionKind,
    );
  }
});

test('StandingAuthorityProvider rejects a step authorization over the per-cycle spend cap', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy, { spendAmount: '25000001' });
  assert.throws(() => provider.verifyStepAuthorization(intent), /spend cap/i);
});

test('StandingAuthorityProvider rejects a step authorization for a pack outside the allowlist', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy, { pack: 'collector-mythic' });
  assert.throws(() => provider.verifyStepAuthorization(intent), /pack/i);
});

test('StandingAuthorityProvider rejects a step authorization to a destination outside the allowlist', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy, { destination: 'attacker-controlled-account' });
  assert.throws(() => provider.verifyStepAuthorization(intent), /destination/i);
});

test('StandingAuthorityProvider rejects a step authorization once the standing authority has expired', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy);
  assert.throws(() => provider.verifyStepAuthorization(intent, { now: '2027-06-01T00:00:00.000Z' }), /expired/i);
});

test('stepAuthorizationNow rejects an authority that expired after the intent was issued', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy, {
    issuedAt: '2000-01-01T00:00:00.000Z',
    expiresAt: '2001-01-01T00:00:00.000Z',
  });
  const provider = createStandingAuthorityProvider({
    standingAuthority: document,
    ownerPublicKey: owner.publicKey,
    policyPublicKey: policy.publicKey,
  });
  const intent = stepIntent(document.documentDigest, policy, { issuedAt: '2000-06-01T00:00:00.000Z' });

  assert.throws(
    () => provider.verifyStepAuthorization(intent, stepAuthorizationNow(intent)),
    /expired/,
  );
});

test('StandingAuthorityProvider rejects a step authorization once the daily cycle cap is exhausted', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy);
  assert.throws(() => provider.verifyStepAuthorization(intent, { cyclesToday: 72 }), /daily cycle cap/i);
  assert.doesNotThrow(() => provider.verifyStepAuthorization(intent, { cyclesToday: 71 }));
});

test('StandingAuthorityProvider rejects a step authorization not signed by the standing authority policy key', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const impostorPolicy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, impostorPolicy);
  assert.throws(() => provider.verifyStepAuthorization(intent), /signature/i);
});

test('StandingAuthorityProvider rejects a step authorization bound to a different standing authority', () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const otherDocument = standingAuthority(owner, policy, { documentId: 'standing-authority-2026-02' });
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(otherDocument.documentDigest, policy);
  assert.throws(() => provider.verifyStepAuthorization(intent), /not bound/i);
});

test('StandingAuthorityProvider persists its first-use decision once and reuses it after authority expiry', async () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy);
  let stored = null;
  let recordCalls = 0;
  const repository = {
    async readStandingAuthorityDecision(cycleId, intentDigest) {
      assert.equal(cycleId, intent.cycleId);
      assert.equal(intentDigest, stepAuthorizationIntentDigest(intent));
      return stored;
    },
    async recordStandingAuthorityDecision(cycleId, decision, options) {
      recordCalls += 1;
      assert.equal(cycleId, intent.cycleId);
      assert.deepEqual(options, { maxCyclesPerDay: 72 });
      stored = structuredClone(decision);
      return stored;
    },
  };

  const first = await provider.verifyAndRecordStepAuthorization(intent, {
    cycleRepository: repository,
    now: '2026-06-01T00:00:01.000Z',
  });

  assert.deepEqual(first.standingAuthorityDecision, {
    schema: 'hookemon.standing-authority-decision.v1',
    authorityDigest: document.documentDigest,
    verifiedAt: '2026-06-01T00:00:01.000Z',
    intentDigest: stepAuthorizationIntentDigest(intent),
    dayCapReservation: {
      day: '2026-06-01',
      reservationKey: digest({
        domain: 'hookemon.standing-authority-day-cap-reservation.v1',
        authorityDigest: document.documentDigest,
        day: '2026-06-01',
      }),
    },
    nonceReservation: {
      nonce: intent.nonce,
      reservationKey: digest({
        domain: 'hookemon.standing-authority-nonce.v1',
        standingAuthorityDigest: document.documentDigest,
        nonce: intent.nonce,
      }),
    },
  });
  assert.equal(recordCalls, 1);

  const replay = await provider.verifyAndRecordStepAuthorization(intent, {
    cycleRepository: repository,
    now: '2027-06-01T00:00:00.000Z',
  });

  assert.equal(replay.intentDigest, first.intentDigest);
  assert.deepEqual(replay.standingAuthorityDecision, first.standingAuthorityDecision);
  assert.equal(recordCalls, 1);
});

test('StandingAuthorityProvider refuses an expired first use before it can reserve authority capacity', async () => {
  const owner = freshKeyPair();
  const policy = freshKeyPair();
  const document = standingAuthority(owner, policy);
  const provider = createStandingAuthorityProvider({ standingAuthority: document, ownerPublicKey: owner.publicKey, policyPublicKey: policy.publicKey });
  const intent = stepIntent(document.documentDigest, policy);
  let recordCalls = 0;
  const repository = {
    async recordStandingAuthorityDecision() {
      recordCalls += 1;
      throw new Error('recordStandingAuthorityDecision must not be called for expired authority');
    },
  };

  await assert.rejects(
    () => provider.verifyAndRecordStepAuthorization(intent, {
      cycleRepository: repository,
      now: '2027-01-01T00:00:00.000Z',
    }),
    /expired/,
  );
  assert.equal(recordCalls, 0);
});

test('FixtureAuthorizationProvider.verifyStepAuthorization is a passthrough to verifyFixtureAuthorization', () => {
  const fixtureProvider = createFixtureAuthorizationProvider();
  assert.equal(fixtureProvider.kind, 'fixture');
  // Any malformed input rejected by the underlying verifier must be rejected identically through the
  // provider seam — the reducer must see the exact same failure mode either way.
  assert.throws(() => fixtureProvider.verifyStepAuthorization({}), Error);
  assert.throws(() => verifyFixtureAuthorization({}), Error);
});
