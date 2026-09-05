// Shared-secret auth for /operator/api/* (design section 5, WP-17 steps: "require
// x-hookemon-proxy-credential (timing-safe) on /operator/api/*"). The Worker
// (apps/web/worker/operator-proxy.ts on the legacy branch) always sets this header itself from its
// own `OPERATOR_CONTROL_PROXY_CREDENTIAL` secret before forwarding a request here — a caller that
// reaches this service directly (bypassing the Worker) must present the identical value.
import { timingSafeEqual } from 'node:crypto';

const MIN_LENGTH = 32;
const MAX_LENGTH = 512;

export class ProxyCredentialConfigError extends Error {}

/** Validate a configured credential (same shape rule the Worker itself enforces on
 * `OPERATOR_CONTROL_PROXY_CREDENTIAL`: 32-512 bytes, no leading/trailing whitespace). Throws
 * `ProxyCredentialConfigError` if the configured value itself is unusable — this is a startup-time
 * configuration check, never something an untrusted request can trigger. */
export function assertProxyCredentialConfigured(value) {
  if (
    typeof value !== 'string'
    || value.length < MIN_LENGTH
    || value.length > MAX_LENGTH
    || value.trim() !== value
  ) {
    throw new ProxyCredentialConfigError('operator control proxy credential is missing or malformed');
  }
  return value;
}

/** Timing-safe compare of a request's `x-hookemon-proxy-credential` header against the configured
 * credential. Returns `false` (never throws) for any malformed/missing header — a byte-length
 * mismatch would otherwise make `timingSafeEqual` throw, which this normalizes into "not
 * authorized" without ever comparing unequal-length buffers by length first (an ordinary,
 * non-secret-dependent early return, not a timing side channel on the secret itself). */
export function proxyCredentialMatches(headerValue, configuredCredential) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return false;
  const presented = Buffer.from(headerValue, 'utf8');
  const expected = Buffer.from(configuredCredential, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
