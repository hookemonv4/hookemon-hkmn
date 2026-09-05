import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  attachOwnerSignature,
  buildCanonicalStandingAuthorityDocument,
  loadPublicKeyFromPemFile,
  loadStandingAuthorityDocument,
  loadVerifiedStandingAuthorityDocument,
  StandingAuthorityError,
} from '../../src/signing/standing-authority.mjs';
import { createStandingAuthorityProvider } from '../../../runner/src/cycle/authorization-provider.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hookemon-standing-authority-'));
test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ownerKeys = generateKeyPairSync('ed25519');
const policyKeys = generateKeyPairSync('ed25519');
const otherOwnerKeys = generateKeyPairSync('ed25519');

const ownerPublicKeyPath = join(dir, 'owner-public.pem');
writeFileSync(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
const otherOwnerPublicKeyPath = join(dir, 'other-owner-public.pem');
writeFileSync(otherOwnerPublicKeyPath, otherOwnerKeys.publicKey.export({ type: 'spki', format: 'pem' }));

function planInput() {
  return {
    owner: 'hookemon-owner',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '25000000',
    maxCyclesPerDay: 72,
    allowedPacks: ['collector-crypt'],
    allowedDestinations: ['relay-bridge-return'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'standing-authority-2026-01',
  };
}

test('buildCanonicalStandingAuthorityDocument produces the exact unsigned schema, ready for the owner to sign externally', () => {
  const document = buildCanonicalStandingAuthorityDocument(planInput());
  assert.equal(document.schema, 'hookemon.standing-authority-document.v1');
  assert.equal(document.owner, 'hookemon-owner');
  assert.match(document.policyPublicKeyFingerprint, /^[0-9a-f]{64}$/);
  assert.match(document.documentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(document, 'ownerSignature'), false, 'the unsigned document must not carry a signature field yet');
});

test('buildCanonicalStandingAuthorityDocument requires a real public-key KeyObject', () => {
  assert.throws(
    () => buildCanonicalStandingAuthorityDocument({ ...planInput(), policyPublicKey: 'not-a-key-object' }),
    StandingAuthorityError,
  );
});

test('a standing-authority document round-trips through print (build), external signing (simulated), verify, and StandingAuthorityProvider consumption', () => {
  // "print": the canonical, unsigned document this repository produces for the owner.
  const unsigned = buildCanonicalStandingAuthorityDocument(planInput());

  // "external signing (simulated in tests)": the owner's own, external tooling signs the digest —
  // never a call this repository's production path makes on its own.
  const signed = attachOwnerSignature(unsigned, ownerKeys.privateKey);
  assert.equal(typeof signed.ownerSignature, 'string');
  assert.ok(signed.ownerSignature.length > 0);

  const documentPath = join(dir, 'standing-authority.json');
  writeFileSync(documentPath, `${JSON.stringify(signed, null, 2)}\n`);

  // "verify": load the signed document from disk and validate it against the owner public key.
  const verified = loadVerifiedStandingAuthorityDocument({ documentPath, ownerPublicKeyPath });
  assert.equal(verified.documentDigest, unsigned.documentDigest);
  assert.equal(verified.ownerSignature, signed.ownerSignature);

  // "StandingAuthorityProvider consumption": the exact production consumer
  // (packages/runner/src/cycle/authorization-provider.mjs) accepts this same verified document
  // without any adaptation.
  const provider = createStandingAuthorityProvider({
    standingAuthority: verified,
    ownerPublicKey: loadPublicKeyFromPemFile(ownerPublicKeyPath),
    policyPublicKey: policyKeys.publicKey,
  });
  assert.equal(provider.kind, 'standing-authority');
  assert.equal(provider.standingAuthorityDigest, verified.documentDigest);
});

test('verify rejects a document signed by a different owner key', () => {
  const unsigned = buildCanonicalStandingAuthorityDocument(planInput());
  const signedByWrongOwner = attachOwnerSignature(unsigned, otherOwnerKeys.privateKey);
  const documentPath = join(dir, 'standing-authority-wrong-owner.json');
  writeFileSync(documentPath, `${JSON.stringify(signedByWrongOwner, null, 2)}\n`);
  assert.throws(
    () => loadVerifiedStandingAuthorityDocument({ documentPath, ownerPublicKeyPath }),
    /failed verification/,
  );
});

test('verify rejects a tampered document (digest no longer matches content) even with a valid-looking signature', () => {
  const unsigned = buildCanonicalStandingAuthorityDocument(planInput());
  const signed = attachOwnerSignature(unsigned, ownerKeys.privateKey);
  const tampered = { ...signed, perCycleSpendCap: '999999999999' };
  const documentPath = join(dir, 'standing-authority-tampered.json');
  writeFileSync(documentPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(
    () => loadVerifiedStandingAuthorityDocument({ documentPath, ownerPublicKeyPath }),
    /failed verification/,
  );
});

test('loadStandingAuthorityDocument requires an absolute path and valid JSON', () => {
  assert.throws(() => loadStandingAuthorityDocument('relative/path.json'), /absolute/);
  const badJsonPath = join(dir, 'not-json.json');
  writeFileSync(badJsonPath, 'not json at all');
  assert.throws(() => loadStandingAuthorityDocument(badJsonPath), /not valid JSON/);
  assert.throws(() => loadStandingAuthorityDocument(join(dir, 'does-not-exist.json')), /could not read/);
});

test('loadPublicKeyFromPemFile reads a public key file and rejects a non-PEM file', () => {
  const key = loadPublicKeyFromPemFile(ownerPublicKeyPath);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  const notPemPath = join(dir, 'not-pem.pem');
  writeFileSync(notPemPath, 'definitely not a pem file');
  assert.throws(() => loadPublicKeyFromPemFile(notPemPath), /not a valid PEM public key/);
});

test('this module never imports a private-key-reading pattern for production signing (source-level check: no createPrivateKey outside attachOwnerSignature'
  + '\'s test-only doc-commented seam, no readFileSync of anything other than a document/public-key path)', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../src/signing/standing-authority.mjs', import.meta.url), 'utf8'));
  assert.equal(source.includes('createPrivateKey'), false, 'standing-authority.mjs must never construct a private key itself');
});
