// AuthorizationProvider seam (WP-29): the reducer's step-authorization checkpoint
// (reducer.mjs verifyApproval, journal event kind 'owner-approval-recorded') is injected with an
// AuthorizationProvider — `{ kind, verifyStepAuthorization(intent) -> verified record }` — rather than
// calling a single hardcoded verifier. The reducer never branches on which provider is active; it only
// ever calls `authorizationProvider.verifyStepAuthorization(...)`.
//
// Two implementations live here:
//   - FixtureAuthorizationProvider: the existing Ed25519 fixture-owner verification
//     (authorization.mjs verifyFixtureAuthorization), used by every existing test and wired as
//     reduceCycleEvent's default so current behavior is unchanged byte-for-byte.
//   - StandingAuthorityProvider: verifies a policy-signed step authorization bound to an owner-signed
//     standing-authority document — per-cycle spend cap, cycles-per-day cap, allowed packs, allowed
//     destinations, and expiry are all enforced here, against keys injected by the caller (never read
//     from a file, never the fixture keypair). This is the production path: no fixture Ed25519 key is
//     ever required to construct or use a StandingAuthorityProvider.
//
// StandingAuthorityProvider operates on its own schema (hookemon.standing-authority-*.v1), independent
// of the fixture owner-approval schema in schemas.mjs — it is not (yet) threaded through the reducer's
// fixture-specific consumption bookkeeping (owner-approval-consumed / fixtureAuthorizationStoreRecord),
// which stays fixture-shaped. Wiring a verified standing-authority record all the way through that
// consumption path is integration work for whichever work package produces the real journal events for
// a live run (see docs/modules/cycle-runner.md); this module is the tested, self-contained verification
// primitive that integration builds on.

import { createHash, verify as verifySignature } from 'node:crypto';

import { canonicalJson, digest } from './journal.mjs';
import { fixtureAuthorizationNonceKey, fixtureAuthorizationStoreRecord, verifyFixtureAuthorization } from './authorization.mjs';
import { assertStandingAuthorityDecision } from './money-schemas.mjs';
import { reserveStandingAuthorityDecision } from '../automation/policy-engine.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const packCode = /^[a-z0-9][a-z0-9-]{1,63}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const base64urlSignature = /^[A-Za-z0-9_-]{86}$/;
const positiveDecimal = /^(?:[1-9][0-9]*)$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const standingAuthorityProviders = new WeakSet();

const standingAuthorityFields = [
  'schema', 'owner', 'policyPublicKeyFingerprint', 'perCycleSpendCap', 'maxCyclesPerDay',
  'allowedPacks', 'allowedDestinations', 'issuedAt', 'expiresAt', 'documentId',
  'documentDigest', 'ownerSignature',
];
const stepIntentFields = [
  'schema', 'standingAuthorityDigest', 'cycleId', 'actionKind', 'authorizationKind', 'subjectDigest',
  'destination', 'pack', 'spendAmount', 'nonce', 'issuedAt', 'policySignature',
];
const standingAuthorityArtifactFields = ['schema', 'authorityDigest', 'entries'];
const standingAuthorityArtifactEntryFields = ['signerRole', 'intent'];
// 'buyback-policy' is included alongside the five step-authorization kinds every action already uses so
// the post-open buyback policy approval (design section 2.5's Collector post-open step) can be verified
// through this same StandingAuthorityProvider seam too — see evidence-profile.mjs's postOpenBuyback.verify.
const authorizationKinds = Object.freeze(['mutation', 'sign', 'broadcast', 'asset-spend', 'gas-spend', 'buyback-policy']);
// 'generate'/'open' (the same bare action-kind spelling the reducer's Collector mutation-authorization
// records already use — see reducer.mjs collectorMutationAuthorization / cycle-store.mjs's own
// actionKinds set) use this same provider rather than a Collector-specific authority variant.
// `claim-process` and `payout` are also signable money stages in the approved cycle order, so their
// policy-signed intents must pass through the same first-use reservation and cap checks.
const actionKinds = Object.freeze([
  'claim-process', 'outbound', 'purchase', 'buyback', 'return', 'payout', 'generate', 'open',
]);

function assertExactSchema(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  canonicalJson(value);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) throw new Error(`${label} must use the exact schema`);
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`${label} is invalid`);
}

function assertDecimal(value, label) {
  if (typeof value !== 'string' || !positiveDecimal.test(value)) throw new Error(`${label} must be a canonical positive integer`);
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical UTC timestamp`);
}

function assertSignature(value, label) {
  if (typeof value !== 'string' || !base64urlSignature.test(value)) throw new Error(`${label} is invalid`);
}

export function publicKeyFingerprint(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

export function standingAuthorityDocumentDigest(value) {
  const { documentDigest, ownerSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.standing-authority-document.v1', payload });
}

// Verifies an owner-signed standing-authority document: the cryptographic ceiling a policy signer's
// step authorizations can never exceed. `ownerPublicKey` is caller-injected (never read from a file,
// never a fixture key) — this is the "signed standing authority" from coordinator directive D3/D4.
export function verifyStandingAuthorityDocument(value, { ownerPublicKey }) {
  assertExactSchema(value, standingAuthorityFields, 'standing authority document');
  if (value.schema !== 'hookemon.standing-authority-document.v1') throw new Error('standing authority document discriminator is invalid');
  assertIdentifier(value.owner, 'standing authority owner');
  if (typeof value.policyPublicKeyFingerprint !== 'string' || !fingerprintPattern.test(value.policyPublicKeyFingerprint)) throw new Error('standing authority policy key fingerprint is invalid');
  assertDecimal(value.perCycleSpendCap, 'standing authority per-cycle spend cap');
  if (!Number.isInteger(value.maxCyclesPerDay) || value.maxCyclesPerDay < 1) throw new Error('standing authority max cycles per day is invalid');
  if (!Array.isArray(value.allowedPacks) || value.allowedPacks.length === 0 || value.allowedPacks.some(pack => typeof pack !== 'string' || !packCode.test(pack)) || new Set(value.allowedPacks).size !== value.allowedPacks.length) throw new Error('standing authority allowed packs are invalid');
  if (!Array.isArray(value.allowedDestinations) || value.allowedDestinations.length === 0 || value.allowedDestinations.some(destination => typeof destination !== 'string' || !identifier.test(destination)) || new Set(value.allowedDestinations).size !== value.allowedDestinations.length) throw new Error('standing authority allowed destinations are invalid');
  assertTimestamp(value.issuedAt, 'standing authority issued-at');
  assertTimestamp(value.expiresAt, 'standing authority expiry');
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) throw new Error('standing authority expiry must be after issuance');
  assertIdentifier(value.documentId, 'standing authority document id');
  if (typeof value.documentDigest !== 'string' || !digestPattern.test(value.documentDigest)) throw new Error('standing authority document digest is invalid');
  const expectedDigest = standingAuthorityDocumentDigest(value);
  if (value.documentDigest !== expectedDigest) throw new Error('standing authority document digest mismatch');
  assertSignature(value.ownerSignature, 'standing authority owner signature');
  if (!verifySignature(null, Buffer.from(expectedDigest, 'utf8'), ownerPublicKey, Buffer.from(value.ownerSignature, 'base64url'))) throw new Error('standing authority owner signature verification is invalid');
  return structuredClone(value);
}

export function stepAuthorizationIntentDigest(value) {
  const { policySignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.standing-authority-step-intent.v1', payload });
}

function assertArtifactSignerRole(value) {
  if (value === null) return null;
  assertIdentifier(value, 'standing authority artifact signer role');
  return value;
}

function assertArtifactIntent(value, authorityDigest) {
  assertExactSchema(value, stepIntentFields, 'standing authority artifact intent');
  if (value.schema !== 'hookemon.standing-authority-step-intent.v1') {
    throw new Error('standing authority artifact intent discriminator is invalid');
  }
  if (value.standingAuthorityDigest !== authorityDigest) {
    throw new Error('standing authority artifact intent is not bound to its authority digest');
  }
  assertIdentifier(value.cycleId, 'standing authority artifact cycle');
  if (!actionKinds.includes(value.actionKind)) throw new Error('standing authority artifact action kind is invalid');
  if (!authorizationKinds.includes(value.authorizationKind)) throw new Error('standing authority artifact authorization kind is invalid');
  if (typeof value.subjectDigest !== 'string' || !digestPattern.test(value.subjectDigest)) {
    throw new Error('standing authority artifact request digest is invalid');
  }
  return Object.freeze(structuredClone(value));
}

function resolverEntryKey({ signerRole, intent }) {
  return canonicalJson({
    cycleId: intent.cycleId,
    stage: intent.actionKind,
    authorizationKind: intent.authorizationKind,
    requestDigest: intent.subjectDigest,
    signerRole,
  });
}

function assertResolverRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('standing authority step authorization request is invalid');
  }
  assertIdentifier(value.cycleId, 'standing authority step authorization cycle');
  if (!actionKinds.includes(value.stage)) throw new Error('standing authority step authorization stage is invalid');
  if (!authorizationKinds.includes(value.authorizationKind)) throw new Error('standing authority step authorization kind is invalid');
  if (typeof value.requestDigest !== 'string' || !digestPattern.test(value.requestDigest)) {
    throw new Error('standing authority step authorization request digest is invalid');
  }
  assertArtifactSignerRole(value.signerRole);
  return value;
}

/**
 * Builds the production signing-boundary resolver from a persisted artifact.
 * The artifact contains only policy-signed intents and is tied to the already
 * verified owner authority by digest; it contains no signing capability.
 */
export function createStandingAuthorityStepAuthorizationResolver({ authorityDigest, artifact } = {}) {
  if (typeof authorityDigest !== 'string' || !digestPattern.test(authorityDigest)) {
    throw new Error('standing authority artifact authority digest is invalid');
  }
  assertExactSchema(artifact, standingAuthorityArtifactFields, 'standing authority artifact');
  if (artifact.schema !== 'hookemon.standing-authority-step-authorizations.v1') {
    throw new Error('standing authority artifact schema is invalid');
  }
  if (artifact.authorityDigest !== authorityDigest) {
    throw new Error('standing authority artifact authority digest does not match the verified document');
  }
  if (!Array.isArray(artifact.entries)) throw new Error('standing authority artifact entries are invalid');

  const entries = new Map();
  for (const value of artifact.entries) {
    assertExactSchema(value, standingAuthorityArtifactEntryFields, 'standing authority artifact entry');
    const signerRole = assertArtifactSignerRole(value.signerRole);
    const intent = assertArtifactIntent(value.intent, authorityDigest);
    const key = resolverEntryKey({ signerRole, intent });
    if (entries.has(key)) throw new Error('standing authority artifact contains ambiguous step authorization entries');
    entries.set(key, intent);
  }

  return Object.freeze(async request => {
    const validated = assertResolverRequest(request);
    const key = resolverEntryKey({
      signerRole: validated.signerRole,
      intent: {
        cycleId: validated.cycleId,
        actionKind: validated.stage,
        authorizationKind: validated.authorizationKind,
        subjectDigest: validated.requestDigest,
      },
    });
    const intent = entries.get(key);
    if (!intent) throw new Error('standing authority artifact has no matching step authorization');
    return Object.freeze(structuredClone(intent));
  });
}

/** Returns true only for a provider constructed after document and policy-key verification here. */
export function isStandingAuthorityProvider(value) {
  return value !== null && typeof value === 'object' && standingAuthorityProviders.has(value);
}

// First-use authorization checks must use the real wall clock. A replayable consumer must persist
// that first-use verification separately and replay the persisted decision rather than re-running
// this helper against the historical intent timestamp.
export function stepAuthorizationNow() {
  return { now: new Date().toISOString() };
}

function assertStandingAuthorityDecisionRepository(value) {
  if (!value || typeof value !== 'object' || typeof value.recordStandingAuthorityDecision !== 'function') {
    throw new Error('standing authority decision repository is required');
  }
  if (value.readStandingAuthorityDecision !== undefined && typeof value.readStandingAuthorityDecision !== 'function') {
    throw new Error('standing authority decision repository reader is invalid');
  }
  return value;
}

function persistedDecisionFor({ authorityDigest, intentDigest, nonce, verifiedAt }) {
  assertTimestamp(verifiedAt, 'standing authority first-use verification time');
  const day = verifiedAt.slice(0, 10);
  return assertStandingAuthorityDecision({
    schema: 'hookemon.standing-authority-decision.v1',
    authorityDigest,
    verifiedAt,
    intentDigest,
    dayCapReservation: {
      day,
      reservationKey: digest({
        domain: 'hookemon.standing-authority-day-cap-reservation.v1',
        authorityDigest,
        day,
      }),
    },
    nonceReservation: {
      nonce,
      reservationKey: digest({
        domain: 'hookemon.standing-authority-nonce.v1',
        standingAuthorityDigest: authorityDigest,
        nonce,
      }),
    },
  });
}

function assertedStoredStandingAuthorityDecision(value, { authorityDigest, intentDigest }) {
  const decision = assertStandingAuthorityDecision(value, 'stored standing authority decision');
  if (decision.authorityDigest !== authorityDigest || decision.intentDigest !== intentDigest) {
    throw new Error('stored standing authority decision conflicts with the authorization intent');
  }
  return Object.freeze(decision);
}

function persistedVerifiedAuthorization(intent, { authorityDigest, intentDigest }) {
  assertExactSchema(intent, stepIntentFields, 'standing authority step authorization intent');
  if (intent.schema !== 'hookemon.standing-authority-step-intent.v1') throw new Error('standing authority step authorization discriminator is invalid');
  if (intent.standingAuthorityDigest !== authorityDigest) throw new Error('standing authority step authorization is not bound to the active standing authority');
  assertIdentifier(intent.cycleId, 'standing authority step authorization cycle');
  assertSignature(intent.policySignature, 'standing authority step authorization policy signature');
  return Object.freeze({
    verified: true,
    provider: 'standing-authority',
    standingAuthorityDigest: authorityDigest,
    cycleId: intent.cycleId,
    actionKind: intent.actionKind,
    authorizationKind: intent.authorizationKind,
    subjectDigest: intent.subjectDigest,
    destination: intent.destination,
    pack: intent.pack,
    spendAmount: intent.spendAmount,
    nonce: intent.nonce,
    issuedAt: intent.issuedAt,
    intentDigest,
  });
}

function withPersistedDecision(authorization, decision) {
  return Object.freeze({ ...authorization, standingAuthorityDecision: decision });
}

// The production AuthorizationProvider: every step authorization it verifies is bound to one active,
// owner-signed standing-authority document and checked against every cap that document carries. Keys
// are supplied by the caller (a local keychain-backed signer behind the injected seam per D3) — this
// function never reads a key from disk and never touches the fixture Ed25519 keys in schemas.mjs /
// authorization.mjs.
export function createStandingAuthorityProvider({ standingAuthority, ownerPublicKey, policyPublicKey }) {
  const verifiedAuthority = verifyStandingAuthorityDocument(standingAuthority, { ownerPublicKey });
  const policyFingerprint = publicKeyFingerprint(policyPublicKey);
  if (policyFingerprint !== verifiedAuthority.policyPublicKeyFingerprint) throw new Error('standing authority policy key does not match the injected policy signer');

  const provider = {
    kind: 'standing-authority',
    standingAuthorityDigest: verifiedAuthority.documentDigest,
    verifyStepAuthorization(intent, { now = new Date().toISOString(), cyclesToday = 0 } = {}) {
      assertExactSchema(intent, stepIntentFields, 'standing authority step authorization intent');
      if (intent.schema !== 'hookemon.standing-authority-step-intent.v1') throw new Error('standing authority step authorization discriminator is invalid');
      if (intent.standingAuthorityDigest !== verifiedAuthority.documentDigest) throw new Error('standing authority step authorization is not bound to the active standing authority');
      assertIdentifier(intent.cycleId, 'standing authority step authorization cycle');
      if (!actionKinds.includes(intent.actionKind)) throw new Error('standing authority step authorization action kind is invalid');
      if (!authorizationKinds.includes(intent.authorizationKind)) throw new Error('standing authority step authorization kind is invalid');
      if (typeof intent.subjectDigest !== 'string' || !digestPattern.test(intent.subjectDigest)) throw new Error('standing authority step authorization subject digest is invalid');
      assertIdentifier(intent.destination, 'standing authority step authorization destination');
      if (typeof intent.pack !== 'string' || !packCode.test(intent.pack)) throw new Error('standing authority step authorization pack is invalid');
      assertDecimal(intent.spendAmount, 'standing authority step authorization spend amount');
      assertIdentifier(intent.nonce, 'standing authority step authorization nonce');
      assertTimestamp(intent.issuedAt, 'standing authority step authorization issued-at');

      if (!Number.isInteger(cyclesToday) || cyclesToday < 0) throw new Error('standing authority cycles-today context is invalid');
      if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) throw new Error('standing authority verification time is invalid');
      if (Date.parse(now) >= Date.parse(verifiedAuthority.expiresAt)) throw new Error('standing authority is expired');
      if (Date.parse(intent.issuedAt) < Date.parse(verifiedAuthority.issuedAt) || Date.parse(intent.issuedAt) >= Date.parse(verifiedAuthority.expiresAt)) throw new Error('standing authority step authorization was issued outside the standing authority validity window');
      if (cyclesToday >= verifiedAuthority.maxCyclesPerDay) throw new Error('standing authority daily cycle cap exceeded');
      if (!verifiedAuthority.allowedPacks.includes(intent.pack)) throw new Error('standing authority does not allow this pack');
      if (!verifiedAuthority.allowedDestinations.includes(intent.destination)) throw new Error('standing authority does not allow this destination');
      if (BigInt(intent.spendAmount) > BigInt(verifiedAuthority.perCycleSpendCap)) throw new Error('standing authority per-cycle spend cap exceeded');

      assertSignature(intent.policySignature, 'standing authority step authorization policy signature');
      const expectedDigest = stepAuthorizationIntentDigest(intent);
      if (!verifySignature(null, Buffer.from(expectedDigest, 'utf8'), policyPublicKey, Buffer.from(intent.policySignature, 'base64url'))) throw new Error('standing authority step authorization policy signature verification is invalid');

      return Object.freeze({
        verified: true,
        provider: 'standing-authority',
        standingAuthorityDigest: verifiedAuthority.documentDigest,
        cycleId: intent.cycleId,
        actionKind: intent.actionKind,
        authorizationKind: intent.authorizationKind,
        subjectDigest: intent.subjectDigest,
        destination: intent.destination,
        pack: intent.pack,
        spendAmount: intent.spendAmount,
        nonce: intent.nonce,
        issuedAt: intent.issuedAt,
        intentDigest: expectedDigest,
      });
    },
    /**
     * Verifies a signable authority only at first use, then atomically persists its immutable
     * decision and both capacity reservations through the authoritative repository. A replay
     * reads the prior decision before checking wall-clock expiry, so it neither consumes another
     * daily slot nor reserves the nonce again.
     */
    async verifyAndRecordStepAuthorization(intent, {
      cycleRepository,
      now = new Date().toISOString(),
      expectedSubjectDigest = undefined,
    } = {}) {
      const repository = assertStandingAuthorityDecisionRepository(cycleRepository);
      if (expectedSubjectDigest !== undefined
        && (typeof expectedSubjectDigest !== 'string' || !digestPattern.test(expectedSubjectDigest))) {
        throw new Error('standing authority expected subject digest is invalid');
      }
      const intentDigest = stepAuthorizationIntentDigest(intent);
      if (typeof repository.readStandingAuthorityDecision === 'function') {
        const existing = await repository.readStandingAuthorityDecision(intent?.cycleId, intentDigest);
        if (existing !== null) {
          const decision = assertedStoredStandingAuthorityDecision(existing, {
            authorityDigest: verifiedAuthority.documentDigest,
            intentDigest,
          });
          const authorization = persistedVerifiedAuthorization(intent, {
            authorityDigest: verifiedAuthority.documentDigest,
            intentDigest,
          });
          if (expectedSubjectDigest !== undefined && authorization.subjectDigest !== expectedSubjectDigest) {
            throw new Error('standing authority step authorization does not bind the prepared request digest');
          }
          return withPersistedDecision(authorization, decision);
        }
      }

      assertTimestamp(now, 'standing authority first-use verification time');
      const authorization = provider.verifyStepAuthorization(intent, { now });
      if (expectedSubjectDigest !== undefined && authorization.subjectDigest !== expectedSubjectDigest) {
        throw new Error('standing authority step authorization does not bind the prepared request digest');
      }
      const decision = persistedDecisionFor({
        authorityDigest: authorization.standingAuthorityDigest,
        intentDigest: authorization.intentDigest,
        nonce: authorization.nonce,
        verifiedAt: now,
      });
      const stored = await reserveStandingAuthorityDecision({
        cycleRepository: repository,
        cycleId: authorization.cycleId,
        decision,
        maxCyclesPerDay: verifiedAuthority.maxCyclesPerDay,
      });
      const persisted = assertedStoredStandingAuthorityDecision(stored, {
        authorityDigest: authorization.standingAuthorityDigest,
        intentDigest: authorization.intentDigest,
      });
      if (canonicalJson(persisted) !== canonicalJson(decision)) {
        throw new Error('stored standing authority decision is not byte-equivalent to the first-use decision');
      }
      return withPersistedDecision(authorization, persisted);
    },
  };
  standingAuthorityProviders.add(provider);
  return Object.freeze(provider);
}

// The fixture-mode AuthorizationProvider: a thin passthrough to the existing Ed25519 fixture-owner
// verification, so every current test's behavior is unchanged. This is reduceCycleEvent's default.
export function createFixtureAuthorizationProvider() {
  return Object.freeze({
    kind: 'fixture',
    verifyStepAuthorization(approval) {
      return verifyFixtureAuthorization(approval);
    },
  });
}
