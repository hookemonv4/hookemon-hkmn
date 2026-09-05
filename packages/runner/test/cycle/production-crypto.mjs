// Test-only key material and fake chain observers for the production evidence profile (WP-31). None of
// this reuses fixture-crypto.mjs's keys or literals: every keypair here is freshly generated per test
// process, and every observer is a plain in-memory lookup table the test itself populates and queries —
// "fake observers (no network)", exactly as the production-cycle integration test requires. This models
// what a real chain-observer client (packages/adapters, out of this package's writeSet) would hand
// CycleRunner after resolving its own live RPC calls: already-confirmed, structured data, looked up
// synchronously by this seam rather than fetched over the network here.
import { generateKeyPairSync, sign, verify } from 'node:crypto';

export function createSignerRegistry(addresses) {
  const keys = new Map(addresses.map(address => [address, generateKeyPairSync('ed25519')]));
  const registry = {
    verify(address, messageBytesHex, signatureBase64url) {
      const pair = keys.get(address);
      if (!pair) return false;
      return verify(null, Buffer.from(messageBytesHex, 'hex'), pair.publicKey, Buffer.from(signatureBase64url, 'base64url'));
    },
    verifyDigest(address, digestString, signatureBase64url) {
      const pair = keys.get(address);
      if (!pair) return false;
      return verify(null, Buffer.from(digestString, 'utf8'), pair.publicKey, Buffer.from(signatureBase64url, 'base64url'));
    },
  };
  const signHex = (address, messageBytesHex) => sign(null, Buffer.from(messageBytesHex, 'hex'), keys.get(address).privateKey).toString('base64url');
  const signDigest = (address, digestString) => sign(null, Buffer.from(digestString, 'utf8'), keys.get(address).privateKey).toString('base64url');
  return { registry, signHex, signDigest };
}

// A fake Solana observer: `confirmTransaction`/`confirmAccountActivity`/`confirmBlockhashValidity`/
// `confirmPackStatus`/`confirmOpenCustody` all read from an in-memory map keyed by an opaque id the test
// controls (typically the transactionSignature) — never a live RPC call.
export function createFakeSolanaObserver() {
  const transactions = new Map();
  const activities = new Map();
  const blockhashes = new Map();
  const packStatuses = new Map();
  const openCustodies = new Map();
  return {
    seedTransaction(signature, confirmation) { transactions.set(signature, confirmation); },
    seedAccountActivity(key, confirmation) { activities.set(key, confirmation); },
    seedBlockhashValidity(key, confirmation) { blockhashes.set(key, confirmation); },
    seedPackStatus(key, confirmation) { packStatuses.set(key, confirmation); },
    seedOpenCustody(key, confirmation) { openCustodies.set(key, confirmation); },
    confirmTransaction({ transactionSignature }) { return transactions.get(transactionSignature) ?? null; },
    confirmAccountActivity({ actionDigest }) { return activities.get(actionDigest) ?? null; },
    confirmBlockhashValidity({ actionDigest }) { return blockhashes.get(actionDigest) ?? null; },
    confirmPackStatus({ wallet, pack }) { return packStatuses.get(`${wallet}:${pack}`) ?? null; },
    confirmOpenCustody({ broadcastSignature }) { return openCustodies.get(broadcastSignature) ?? null; },
  };
}

// A fake Robinhood-chain (EVM) observer: confirmTransaction for the outbound/return bridge-leg provider
// receipts, confirmAccountActivity for their execution accounting, confirmRelease for the released-
// funds evidence a production cycle preflight is bound to, and confirmCycleEscrow for the WP-34 production
// escrow observation (`packages/runner/src/operator/cycle-escrow-observation.mjs`'s
// verifyProductionCycleEscrowObservation) — keyed by `${cycleVaultAccount}:${onchainCycleId}`, exactly the
// pair that function's own `observer.confirmCycleEscrow({ cycleVaultAccount, onchainCycleId })` call reads.
export function createFakeEvmObserver() {
  const transactions = new Map();
  const activities = new Map();
  const releases = new Map();
  const cycleEscrows = new Map();
  return {
    seedTransaction(signature, confirmation) { transactions.set(signature, confirmation); },
    seedAccountActivity(key, confirmation) { activities.set(key, confirmation); },
    seedRelease(cycleId, confirmation) { releases.set(cycleId, confirmation); },
    seedCycleEscrow(key, confirmation) { cycleEscrows.set(key, confirmation); },
    confirmTransaction({ transactionSignature }) { return transactions.get(transactionSignature) ?? null; },
    confirmAccountActivity({ actionDigest }) { return activities.get(actionDigest) ?? null; },
    confirmRelease({ cycleId }) { return releases.get(cycleId) ?? null; },
    confirmCycleEscrow({ cycleVaultAccount, onchainCycleId }) { return cycleEscrows.get(`${cycleVaultAccount}:${onchainCycleId}`) ?? null; },
  };
}
