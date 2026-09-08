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

/** Resolve a renewed context to its original durable nonce lease, without renewing that lease. */
export async function resolveWalletNonceReservation(cycleRepository, cycleId, input, { release = false } = {}) {
  if (typeof cycleRepository?.describeCycle !== 'function') return input;
  const state = await cycleRepository.describeCycle(cycleId);
  const reservations = state?.walletNonceReservations;
  if (!(reservations instanceof Map)) return input;
  for (const current of reservations.values()) {
    if (!(current.state === 'HELD' || (release && current.state === 'RELEASED')) || current.cycleId !== cycleId
      || current.chainId !== input.chainId || current.wallet.toLowerCase() !== input.wallet.toLowerCase()
      || current.stage !== input.stage || current.fencingToken !== input.fencingToken
      || current.leaseAcquiredAtMs !== input.leaseAcquiredAtMs
      || input.leaseExpiresAtMs < current.leaseExpiresAtMs) continue;
    // The repository still checks the complete original reservation and its original expiry.
    // A concurrent takeover between this read and the assertion cannot borrow the newer fence.
    return Object.freeze({ ...input, leaseExpiresAtMs: current.leaseExpiresAtMs });
  }
  return input;
}
