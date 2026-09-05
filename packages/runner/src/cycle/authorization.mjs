import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { canonicalJson, digest } from './journal.mjs';
import { assertDigest, assertVerifiedOwnerApproval, assertVerifiedPostOpenBuybackApproval, FIXTURE_AUTHORIZATION_KINDS } from './schemas.mjs';

const ownerPublicKey = createPublicKey({ key: Buffer.from('302a300506032b657003210070b70676c75b964bbef8ec0a3bd5ab483aea0f28a4e07fb800f0bafe92ca34ca', 'hex'), format: 'der', type: 'spki' });
export const FIXTURE_AUTHORIZATION_VALIDATED_AT = '2029-01-01T00:00:00.000Z';

export function fixtureAuthorizationDigest(authorization) {
  const { fixtureApprovalDigest, fixtureApprovalSignature, ...payload } = authorization ?? {};
  return digest({ domain: 'hookemon.fixture-owner-approval.v1', fixtureOwner: 'fixture-owner', payload });
}

export function verifyFixtureAuthorization(authorization) {
  const verified = assertVerifiedOwnerApproval(authorization);
  if (verified.fixtureApprovalDigest !== fixtureAuthorizationDigest(verified)) throw new Error('fixture owner approval digest is invalid');
  if (!verifySignature(null, Buffer.from(verified.fixtureApprovalDigest, 'utf8'), ownerPublicKey, Buffer.from(verified.fixtureApprovalSignature, 'base64url'))) throw new Error('fixture owner approval signature verification is invalid');
  return verified;
}

export function fixturePostOpenBuybackAuthorizationDigest(authorization) {
  const { fixtureApprovalDigest, fixtureApprovalSignature, ...payload } = authorization ?? {};
  return digest({ domain: 'hookemon.fixture-post-open-buyback-approval.v1', fixtureOwner: 'fixture-owner', payload });
}

export function verifyFixturePostOpenBuybackAuthorization(authorization) {
  const verified = assertVerifiedPostOpenBuybackApproval(authorization);
  if (verified.fixtureApprovalDigest !== fixturePostOpenBuybackAuthorizationDigest(verified)) throw new Error('fixture post-open buyback approval digest is invalid');
  if (!verifySignature(null, Buffer.from(verified.fixtureApprovalDigest, 'utf8'), ownerPublicKey, Buffer.from(verified.fixtureApprovalSignature, 'base64url'))) throw new Error('fixture post-open buyback approval signature verification is invalid');
  if (Date.parse(FIXTURE_AUTHORIZATION_VALIDATED_AT) >= Date.parse(verified.expiry)) throw new Error('fixture post-open buyback approval is expired');
  return verified;
}

export function fixtureAuthorizationNonceKey(fixtureOwner, nonce) {
  return digest({ domain: 'hookemon.fixture-authorization-nonce.v1', fixtureOwner, nonce });
}

export function fixtureAuthorizationSlot(actionDigest, authorizationKind) {
  assertDigest(actionDigest, 'fixture authorization action digest');
  if (!FIXTURE_AUTHORIZATION_KINDS.includes(authorizationKind)) throw new Error('fixture authorization kind is invalid');
  return digest({ domain: 'hookemon.fixture-authorization-slot.v1', actionDigest, authorizationKind });
}

export function fixtureAuthorizationStoreRecord(authorization, validatedAt) {
  const verified = verifyFixtureAuthorization(authorization);
  if (validatedAt !== FIXTURE_AUTHORIZATION_VALIDATED_AT) throw new Error('fixture authorization validation time is not trusted');
  if (Date.parse(validatedAt) >= Date.parse(verified.expiry)) throw new Error('fixture owner approval is expired');
  const nonceKey = fixtureAuthorizationNonceKey(verified.fixtureOwner, verified.nonce);
  return {
    key: verified.fixtureApprovalDigest,
    nonceKey,
    cycleId: verified.cycleId,
    actionKind: verified.actionKind,
    authorizationKind: verified.authorizationKind,
    actionDigest: verified.actionDigest,
    subjectDigest: verified.subjectDigest,
    commitment: digest({
      domain: 'hookemon.fixture-authorization-consumption.v1',
      authorizationKind: verified.authorizationKind,
      subjectDigest: verified.subjectDigest,
      approval: verified,
      nonceKey,
      validatedAt,
    }),
    validatedAt,
  };
}

export class AuthorizationLedger {
  #consumed;

  constructor({ consumed = [] } = {}) {
    if (!Array.isArray(consumed) || consumed.some(key => typeof key !== 'string')) throw new Error('authorization ledger snapshot is invalid');
    this.#consumed = new Set(consumed);
  }

  consume(authorization, expected) {
    const verified = verifyFixtureAuthorization(authorization);
    if (canonicalJson(verified) !== canonicalJson(expected)) throw new Error('authorization mismatch');
    const key = verified.fixtureApprovalDigest;
    if (this.#consumed.has(key)) throw new Error('authorization already consumed');
    this.#consumed.add(key);
    return key;
  }
}
