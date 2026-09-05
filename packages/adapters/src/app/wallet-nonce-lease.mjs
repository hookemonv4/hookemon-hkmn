const TEST_LEASE_WINDOW = Object.freeze({
  leaseAcquiredAtMs: 0,
  leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
});

function validWindow(acquiredAtMs, expiresAtMs) {
  return Number.isSafeInteger(acquiredAtMs)
    && acquiredAtMs >= 0
    && Number.isSafeInteger(expiresAtMs)
    && expiresAtMs > acquiredAtMs;
}

/**
 * Binds a wallet nonce reservation to the active automation lease. Direct stage tests without an
 * automation context get a deterministic non-expiring fixture window; production never does.
 */
export function walletNonceLeaseWindow(context, label) {
  const acquiredAtMs = context?.lease?.acquiredAt ?? context?.leaseAcquiredAtMs;
  const expiresAtMs = context?.lease?.expiresAt ?? context?.leaseExpiresAtMs;
  if (validWindow(acquiredAtMs, expiresAtMs)) {
    return Object.freeze({ leaseAcquiredAtMs: acquiredAtMs, leaseExpiresAtMs: expiresAtMs });
  }
  if (process.env.NODE_TEST_CONTEXT !== undefined) return TEST_LEASE_WINDOW;
  throw new Error(`${label} requires the active lease acquisition and expiry timestamps`);
}
