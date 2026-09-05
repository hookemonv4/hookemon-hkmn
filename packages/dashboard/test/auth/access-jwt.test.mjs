import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { createAccessJwtVerifier, AccessJwtError } from '../../src/auth/access-jwt.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-key-1';

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function signToken(payload, { alg = 'RS256', kid = KID, key = privateKey } = {}) {
  const header = { alg, typ: 'JWT', kid };
  const headerSegment = base64Url(Buffer.from(JSON.stringify(header)));
  const payloadSegment = base64Url(Buffer.from(JSON.stringify(payload)));
  const signedInput = `${headerSegment}.${payloadSegment}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signedInput), key);
  return `${signedInput}.${base64Url(signature)}`;
}

function fakeFetch({ keys = [{ ...jwk, kid: KID }] } = {}) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ keys }) };
  };
  impl.calls = () => calls;
  return impl;
}

function buildVerifier(overrides = {}) {
  return createAccessJwtVerifier({
    jwksUrl: 'https://access.example.com/jwks',
    issuer: 'https://example.cloudflareaccess.com',
    audience: 'aud-123',
    fetchImpl: fakeFetch(),
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

function validPayload(overrides = {}) {
  return {
    iss: 'https://example.cloudflareaccess.com',
    aud: 'aud-123',
    email: 'operator-console',
    iat: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1_000) - 10,
    exp: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1_000) + 3_600,
    ...overrides,
  };
}

test('verifies a well-formed, correctly signed token', async () => {
  const verify = buildVerifier();
  const token = signToken(validPayload());
  const payload = await verify(token);
  assert.equal(payload.email, 'operator-console');
});

test('rejects a token signed by a different key', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verify = buildVerifier();
  const token = signToken(validPayload(), { key: other.privateKey });
  await assert.rejects(() => verify(token), AccessJwtError);
});

test('rejects an expired token', async () => {
  const verify = buildVerifier();
  const token = signToken(validPayload({ exp: Math.floor(Date.parse('2025-12-31T00:00:00.000Z') / 1_000) }));
  await assert.rejects(() => verify(token), /ACCESS_JWT_EXPIRED/);
});

test('rejects the wrong issuer', async () => {
  const verify = buildVerifier();
  const token = signToken(validPayload({ iss: 'https://evil.example.com' }));
  await assert.rejects(() => verify(token), /ACCESS_JWT_ISSUER_MISMATCH/);
});

test('rejects the wrong audience', async () => {
  const verify = buildVerifier();
  const token = signToken(validPayload({ aud: 'someone-else' }));
  await assert.rejects(() => verify(token), /ACCESS_JWT_AUDIENCE_MISMATCH/);
});

test('rejects a non-RS256 algorithm header', async () => {
  const verify = buildVerifier();
  const headerSegment = base64Url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })));
  const payloadSegment = base64Url(Buffer.from(JSON.stringify(validPayload())));
  const token = `${headerSegment}.${payloadSegment}.AAAA`;
  await assert.rejects(() => verify(token), /ACCESS_JWT_UNSUPPORTED_ALGORITHM/);
});

test('rejects a malformed token', async () => {
  const verify = buildVerifier();
  await assert.rejects(() => verify('not-a-jwt'), /ACCESS_JWT_MALFORMED/);
});

test('refreshes the JWKS once when the key id is unknown, then fails if still unknown', async () => {
  const fetchImpl = fakeFetch({ keys: [] });
  const verify = buildVerifier({ fetchImpl });
  const token = signToken(validPayload());
  await assert.rejects(() => verify(token), /ACCESS_JWT_UNKNOWN_KEY/);
  assert.equal(fetchImpl.calls(), 2);
});
