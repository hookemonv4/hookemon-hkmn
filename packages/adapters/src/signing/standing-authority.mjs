// Standing-authority document handling (WP-33 part 2, coordinator directives D3/D4): builds the
// canonical, unsigned standing-authority document the owner must sign OUTSIDE this repository,
// loads a signed one from a path, and validates it with exactly the rules
// packages/runner/src/cycle/authorization-provider.mjs's `StandingAuthorityProvider` itself
// enforces — imported directly from there, never reimplemented, so this module and the reducer's
// own consumer can never silently drift on what a valid document looks like.
//
// This module never signs anything in its production path (`buildCanonicalStandingAuthorityDocument`
// only ever produces the *unsigned* document plus its digest) and never reads a private key.
// `attachOwnerSignature` exists only so a test can simulate the owner's own, external signing step
// end to end without a real production key ever touching this repository; `bin/hookemon-authority.mjs`
// deliberately does not expose it as a CLI subcommand — see that file's header.
import { createPublicKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  publicKeyFingerprint,
  standingAuthorityDocumentDigest,
  verifyStandingAuthorityDocument,
} from '../../../runner/src/cycle/authorization-provider.mjs';

export class StandingAuthorityError extends Error {}

function fail(message) {
  throw new StandingAuthorityError(message);
}

function requireAbsolutePath(path, label) {
  if (typeof path !== 'string' || path.length === 0) fail(`${label} is required`);
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  return path;
}

/**
 * Builds the exact canonical, unsigned `hookemon.standing-authority-document.v1` payload (schema,
 * owner, policyPublicKeyFingerprint, perCycleSpendCap, maxCyclesPerDay, allowedPacks,
 * allowedDestinations, issuedAt, expiresAt, documentId, documentDigest) — every field
 * `verifyStandingAuthorityDocument` requires except `ownerSignature`, which only the owner's own,
 * external signing step adds. This is what `hookemon-authority.mjs print` shows the owner.
 *
 * @param {object} input
 * @param {string} input.owner
 * @param {import('node:crypto').KeyObject} input.policyPublicKey - the policy signer's *public*
 *   key (never secret material) — `publicKeyFingerprint` binds the standing authority to this
 *   exact key, so a step authorization signed by any other key is rejected by
 *   `StandingAuthorityProvider` regardless of caps.
 * @param {string} input.perCycleSpendCap - canonical positive-integer decimal string.
 * @param {number} input.maxCyclesPerDay
 * @param {string[]} input.allowedPacks
 * @param {string[]} input.allowedDestinations
 * @param {string} input.issuedAt - canonical UTC timestamp (`new Date(x).toISOString() === x`).
 * @param {string} input.expiresAt
 * @param {string} input.documentId
 */
export function buildCanonicalStandingAuthorityDocument({
  owner,
  policyPublicKey,
  perCycleSpendCap,
  maxCyclesPerDay,
  allowedPacks,
  allowedDestinations,
  issuedAt,
  expiresAt,
  documentId,
} = {}) {
  if (!policyPublicKey || typeof policyPublicKey.export !== 'function') {
    fail('policyPublicKey must be a public-key KeyObject (see node:crypto createPublicKey)');
  }
  const unsigned = {
    schema: 'hookemon.standing-authority-document.v1',
    owner,
    policyPublicKeyFingerprint: publicKeyFingerprint(policyPublicKey),
    perCycleSpendCap,
    maxCyclesPerDay,
    allowedPacks,
    allowedDestinations,
    issuedAt,
    expiresAt,
    documentId,
  };
  const documentDigest = standingAuthorityDocumentDigest(unsigned);
  return { ...unsigned, documentDigest };
}

/**
 * Attaches an owner signature to a canonical document from `buildCanonicalStandingAuthorityDocument`.
 * Production signing happens entirely outside this repository, with the owner's own tooling, over
 * `document.documentDigest`; this function exists only so tests (and, if an operator chooses, a
 * script that genuinely runs on the owner's own separate signing device) can perform that exact
 * step programmatically. Never invoked by `bin/hookemon-authority.mjs`.
 */
export function attachOwnerSignature(document, ownerPrivateKey) {
  if (!document || typeof document.documentDigest !== 'string') fail('document is missing its documentDigest');
  if (!ownerPrivateKey || typeof ownerPrivateKey.export !== 'function') fail('ownerPrivateKey must be a KeyObject');
  const ownerSignature = cryptoSign(null, Buffer.from(document.documentDigest, 'utf8'), ownerPrivateKey).toString('base64url');
  return { ...document, ownerSignature };
}

/** Reads and JSON-parses a standing-authority document from an absolute path. Performs no
 * validation beyond "is this JSON" — `verifyStandingAuthorityDocument` (or
 * `loadVerifiedStandingAuthorityDocument` below) does the real validation. */
export function loadStandingAuthorityDocument(path) {
  requireAbsolutePath(path, 'standing authority document path');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`could not read standing authority document at "${path}": ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`standing authority document at "${path}" is not valid JSON`);
  }
  return undefined; // unreachable; keeps linters happy about a guaranteed return
}

/** Reads a PEM-encoded PUBLIC key from an absolute path — never secret material, so this is safe
 * to read directly from disk (unlike any private/signing key in this system, which is never read
 * from a file by any module in this repository). */
export function loadPublicKeyFromPemFile(path) {
  requireAbsolutePath(path, 'public key path');
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`could not read public key at "${path}": ${error.message}`);
  }
  try {
    return createPublicKey(pem);
  } catch (error) {
    fail(`"${path}" is not a valid PEM public key: ${error.message}`);
  }
  return undefined;
}

/**
 * Loads a signed standing-authority document from `documentPath` and fully verifies it (schema,
 * digest, expiry ordering, and the owner signature) against an owner public key loaded from
 * `ownerPublicKeyPath`, using `authorization-provider.mjs`'s own `verifyStandingAuthorityDocument`
 * — the exact rule set `StandingAuthorityProvider` itself enforces when consuming this document in
 * the cycle reducer. Throws on any validation failure; returns the verified, cloned document on
 * success. This is the function `environment.mjs`'s configured standing-authority path feeds.
 */
export function loadVerifiedStandingAuthorityDocument({ documentPath, ownerPublicKeyPath }) {
  const document = loadStandingAuthorityDocument(documentPath);
  const ownerPublicKey = loadPublicKeyFromPemFile(ownerPublicKeyPath);
  try {
    return verifyStandingAuthorityDocument(document, { ownerPublicKey });
  } catch (error) {
    fail(`standing authority document at "${documentPath}" failed verification: ${error.message}`);
  }
  return undefined;
}

export { publicKeyFingerprint, standingAuthorityDocumentDigest, verifyStandingAuthorityDocument };
