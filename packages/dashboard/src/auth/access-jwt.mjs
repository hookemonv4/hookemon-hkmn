// Optional second factor for /operator/api/*: verifies a Cloudflare Access JWT (the
// `cf-access-jwt-assertion` header the Worker forwards verbatim — see
// apps/web/worker/operator-proxy.ts's `FORWARDED_REQUEST_HEADERS` on the legacy branch) against a
// configured JWKS endpoint, entirely with `node:crypto` (RS256 / RSASSA-PKCS1-v1_5 SHA-256) — no JWT
// library. This check is optional: a deployment that has not configured `jwksUrl` skips it (the
// x-hookemon-proxy-credential check in proxy-credential.mjs is the mandatory factor).
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const DEFAULT_JWKS_CACHE_MS = 10 * 60_000;
const MAX_TOKEN_LENGTH = 8_192;
const CLOCK_SKEW_SECONDS = 60;

export class AccessJwtError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid(code) {
  throw new AccessJwtError(code);
}

function base64UrlDecode(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) invalid('ACCESS_JWT_MALFORMED');
  return Buffer.from(segment, 'base64url');
}

function parseJson(buffer, code) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    invalid(code);
  }
}

/**
 * Build a verifier bound to one JWKS endpoint. `fetchImpl` defaults to the global `fetch`; tests
 * inject a fake so no network access is required. The JWKS document is cached in memory for
 * `cacheMs` (default 10 minutes) and re-fetched afterward, keyed by `kid` so a key rotation is
 * picked up automatically on the next verification after the cache expires.
 *
 * @param {object} options
 * @param {string} options.jwksUrl
 * @param {string} options.issuer
 * @param {string} options.audience
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.cacheMs]
 * @param {() => number} [options.now]
 */
export function createAccessJwtVerifier(options) {
  if (!options || typeof options !== 'object') throw new Error('createAccessJwtVerifier options must be an object');
  const {
    jwksUrl,
    issuer,
    audience,
    fetchImpl = globalThis.fetch,
    cacheMs = DEFAULT_JWKS_CACHE_MS,
    now = () => Date.now(),
  } = options;
  if (typeof jwksUrl !== 'string' || jwksUrl.length === 0) throw new Error('createAccessJwtVerifier requires jwksUrl');
  if (typeof issuer !== 'string' || issuer.length === 0) throw new Error('createAccessJwtVerifier requires issuer');
  if (typeof audience !== 'string' || audience.length === 0) throw new Error('createAccessJwtVerifier requires audience');
  if (typeof fetchImpl !== 'function') throw new Error('createAccessJwtVerifier requires a fetch implementation');

  let cachedAt = 0;
  let cachedKeys = new Map();

  async function loadKeys({ forceRefresh = false } = {}) {
    if (!forceRefresh && cachedKeys.size > 0 && now() - cachedAt < cacheMs) return cachedKeys;
    const response = await fetchImpl(jwksUrl, { method: 'GET' });
    if (!response || !response.ok) invalid('ACCESS_JWT_JWKS_UNAVAILABLE');
    const body = await response.json();
    if (!body || !Array.isArray(body.keys)) invalid('ACCESS_JWT_JWKS_MALFORMED');
    const next = new Map();
    for (const jwk of body.keys) {
      if (!jwk || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // A single malformed JWKS entry must not take down every other key; it is simply unusable.
      }
    }
    cachedKeys = next;
    cachedAt = now();
    return cachedKeys;
  }

  /** Verify `token` (the raw `cf-access-jwt-assertion` header value). Resolves to the decoded
   * payload on success; rejects with `AccessJwtError` (a stable `.code`) on any failure — expired,
   * wrong issuer/audience, bad signature, unknown key id, or malformed token. */
  return async function verifyAccessJwt(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) invalid('ACCESS_JWT_MALFORMED');
    const parts = token.split('.');
    if (parts.length !== 3) invalid('ACCESS_JWT_MALFORMED');
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    const header = parseJson(base64UrlDecode(headerSegment), 'ACCESS_JWT_MALFORMED');
    const payload = parseJson(base64UrlDecode(payloadSegment), 'ACCESS_JWT_MALFORMED');
    const signature = base64UrlDecode(signatureSegment);
    if (header.alg !== 'RS256') invalid('ACCESS_JWT_UNSUPPORTED_ALGORITHM');
    if (typeof header.kid !== 'string' || header.kid.length === 0) invalid('ACCESS_JWT_MALFORMED');

    let keys = await loadKeys();
    let publicKey = keys.get(header.kid);
    if (!publicKey) {
      // A key id this cache has never seen might be a fresh rotation; refresh once before failing.
      keys = await loadKeys({ forceRefresh: true });
      publicKey = keys.get(header.kid);
    }
    if (!publicKey) invalid('ACCESS_JWT_UNKNOWN_KEY');

    const signedInput = `${headerSegment}.${payloadSegment}`;
    let signatureValid = false;
    try {
      signatureValid = cryptoVerify('RSA-SHA256', Buffer.from(signedInput, 'utf8'), publicKey, signature);
    } catch {
      invalid('ACCESS_JWT_SIGNATURE_INVALID');
    }
    if (!signatureValid) invalid('ACCESS_JWT_SIGNATURE_INVALID');

    const nowSeconds = Math.floor(now() / 1_000);
    if (typeof payload.exp !== 'number' || nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) invalid('ACCESS_JWT_EXPIRED');
    if (typeof payload.iat === 'number' && nowSeconds + CLOCK_SKEW_SECONDS < payload.iat) invalid('ACCESS_JWT_NOT_YET_VALID');
    if (payload.iss !== issuer) invalid('ACCESS_JWT_ISSUER_MISMATCH');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) invalid('ACCESS_JWT_AUDIENCE_MISMATCH');

    return payload;
  };
}
