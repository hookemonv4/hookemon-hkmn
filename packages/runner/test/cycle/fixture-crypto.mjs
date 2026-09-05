import { createPrivateKey, sign } from 'node:crypto';

import { fixtureAuthorizationDigest, fixturePostOpenBuybackAuthorizationDigest } from '../../src/cycle/authorization.mjs';
import { fixtureBlockhashValidityDigest } from '../../src/cycle/blockhash-validity.mjs';
import { fixtureExecutionAccountingDigest } from '../../src/cycle/execution-accounting.mjs';
import { canonicalJson } from '../../src/cycle/journal.mjs';
import {
  fixtureSupersessionAuthorizationDigest,
  supersedeObserverEvidenceDigest,
  voidObserverProofDigest,
} from '../../src/cycle/reducer.mjs';
import {
  fixtureCyclePreflightDigest,
  fixtureCycleReleaseVerificationDigest,
} from '../../src/cycle/preflight.mjs';
import { fixtureReceiptVerificationDigest } from '../../src/cycle/schemas.mjs';
import {
  fixtureCollectorMutationAuthorizationDigest,
  fixtureCollectorOpenExecutionDigest,
  fixtureCollectorOpenCustodyDigest,
  fixtureCollectorRpcFinalityDigest,
  fixtureCollectorStatusDigest,
} from '../../src/cycle/collector.mjs';

const OWNER_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204208566b1706357d4653313d88defec8219a3f4ad9d2abca8484765a4af92b12cb9', 'hex'), format: 'der', type: 'pkcs8' });
const TRANSACTION_SIGNER_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204205d5ff41d325604b1d7abbffb20c45e4b9b54ad24c634d59cbd61861e7681f5be', 'hex'), format: 'der', type: 'pkcs8' });
const PROVIDER_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420a80ec1014648a5467b8b48c5bcb91dc61829b6164811f35468e67df6551b2361', 'hex'), format: 'der', type: 'pkcs8' });
const RELEASE_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420db510186b199320584a3df4d37b05c0c1b03aa7bbced5eded28cca03af3a2e16', 'hex'), format: 'der', type: 'pkcs8' });
const ACCOUNTING_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b65700422042037e5d51de19a71550a499711e95137e356cf290b5216bce03c4a9f4787baffb2', 'hex'), format: 'der', type: 'pkcs8' });
const RPC_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b65700422042036f3f936fb486a73840cc61b633bdb6278d5121765aa4085807957b700823ad3', 'hex'), format: 'der', type: 'pkcs8' });
const VOID_OBSERVER_PRIVATE_KEY = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420fcc9912cb51f97a17847f6399febaa2ef586b3df464a455571cba64aa5497f0b', 'hex'), format: 'der', type: 'pkcs8' });

export function signFixtureOwnerApproval(value) {
  return sign(null, Buffer.from(fixtureAuthorizationDigest(value), 'utf8'), OWNER_PRIVATE_KEY).toString('base64url');
}

export function signFixturePostOpenBuybackApproval(value) {
  return sign(null, Buffer.from(fixturePostOpenBuybackAuthorizationDigest(value), 'utf8'), OWNER_PRIVATE_KEY).toString('base64url');
}

export function signFixtureProviderReceipt(value) {
  return sign(null, Buffer.from(fixtureReceiptVerificationDigest(value), 'utf8'), PROVIDER_PRIVATE_KEY).toString('base64url');
}

export function signFixtureProviderVerificationDigest(verificationDigest) {
  return sign(null, Buffer.from(verificationDigest, 'utf8'), PROVIDER_PRIVATE_KEY).toString('base64url');
}

export function signFixtureCycleRelease(value) {
  return sign(null, Buffer.from(fixtureCycleReleaseVerificationDigest(value), 'utf8'), RELEASE_PRIVATE_KEY).toString('base64url');
}

export function signFixtureExecutionAccounting(value) {
  return sign(null, Buffer.from(fixtureExecutionAccountingDigest(value), 'utf8'), ACCOUNTING_PRIVATE_KEY).toString('base64url');
}

export function signFixtureBlockhashValidity(value) {
  return sign(null, Buffer.from(fixtureBlockhashValidityDigest(value), 'utf8'), RPC_PRIVATE_KEY).toString('base64url');
}

export function signFixtureCyclePreflight(value) {
  return sign(null, Buffer.from(fixtureCyclePreflightDigest(value), 'utf8'), OWNER_PRIVATE_KEY).toString('base64url');
}

export function signFixtureVoidObserverProof(value) {
  return sign(null, Buffer.from(voidObserverProofDigest(value), 'utf8'), VOID_OBSERVER_PRIVATE_KEY).toString('base64url');
}

// The heavier, dual-observer "supersede an unobserved intent" recovery path (WP-07): the provider and
// rpc observer evidences reuse the exact same fixture identities (and private keys) already used
// elsewhere for provider receipts and RPC-signed blockhash validity — they are the same two independent
// parties the rest of the reducer already trusts for those roles, just attesting a different claim
// (NOT_FOUND rather than a landed receipt). The supersession authorization itself reuses the same
// fixture owner identity as every other owner approval in this file.
export function signFixtureSupersedeObserverEvidence(value, observer) {
  const key = observer === 'provider' ? PROVIDER_PRIVATE_KEY : observer === 'rpc' ? RPC_PRIVATE_KEY : null;
  if (!key) throw new Error(`unknown supersede observer: ${observer}`);
  return sign(null, Buffer.from(supersedeObserverEvidenceDigest(value), 'utf8'), key).toString('base64url');
}

export function signFixtureSupersessionAuthorization(value) {
  return sign(null, Buffer.from(fixtureSupersessionAuthorizationDigest(value), 'utf8'), OWNER_PRIVATE_KEY).toString('base64url');
}

export function signFixtureCollectorMutationAuthorization(value) { return sign(null, Buffer.from(fixtureCollectorMutationAuthorizationDigest(value), 'utf8'), OWNER_PRIVATE_KEY).toString('base64url'); }
export function signFixtureCollectorOpenExecution(value) { return sign(null, Buffer.from(fixtureCollectorOpenExecutionDigest(value), 'utf8'), TRANSACTION_SIGNER_PRIVATE_KEY).toString('base64url'); }
export function signFixtureCollectorStatus(value) { return sign(null, Buffer.from(fixtureCollectorStatusDigest(value), 'utf8'), PROVIDER_PRIVATE_KEY).toString('base64url'); }
export function signFixtureCollectorOpenCustody(value) { return sign(null, Buffer.from(fixtureCollectorOpenCustodyDigest(value), 'utf8'), PROVIDER_PRIVATE_KEY).toString('base64url'); }
export function signFixtureCollectorRpcFinality(value) { return sign(null, Buffer.from(fixtureCollectorRpcFinalityDigest(value), 'utf8'), RPC_PRIVATE_KEY).toString('base64url'); }

function signedFixtureTransaction({ messageBytes, messageDigest, signers }, privateKey) {
  const signatures = signers.map(signer => ({
    signer,
    signature: sign(null, Buffer.from(messageBytes, 'hex'), privateKey).toString('base64url'),
  }));
  const envelope = {
    schema: 'hookemon.fixture-signed-transaction.v1',
    messageBytes,
    messageDigest,
    requiredSigners: signers,
    signatures,
  };
  return {
    signedBytes: Buffer.from(canonicalJson(envelope), 'utf8').toString('hex'),
    broadcastSignature: signatures[0]?.signature,
  };
}

export function signFixtureTransaction({ messageBytes, messageDigest, signers = ['fixture-fee-payer'] }) {
  return signedFixtureTransaction({ messageBytes, messageDigest, signers }, TRANSACTION_SIGNER_PRIVATE_KEY);
}

export function signFixtureTransactionWithOwnerKey({ messageBytes, messageDigest, signers = ['fixture-fee-payer'] }) {
  return signedFixtureTransaction({ messageBytes, messageDigest, signers }, OWNER_PRIVATE_KEY);
}

export function rewriteFixtureSignedTransaction(signedBytes, mutate) {
  const envelope = JSON.parse(Buffer.from(signedBytes, 'hex').toString('utf8'));
  return Buffer.from(canonicalJson(mutate(envelope)), 'utf8').toString('hex');
}
