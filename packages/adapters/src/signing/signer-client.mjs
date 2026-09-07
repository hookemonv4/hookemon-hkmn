// The signer-client seam (WP-33, decision D3): every production mutation this repository ever
// signs — the operator's own EVM/Solana broadcasts and the distribution-signer/verifier's manifest
// approvals — goes through the exact same `{ role, sign(request), broadcast(signed) }` interface
// this module defines, never a raw key held by application code. This module never holds, reads,
// or reconstructs key material itself; it only validates shapes, canonicalizes requests for a
// deterministic audit digest, and wraps a caller-supplied `inner` implementation (an operator
// module, per external-module-signer.mjs, or a keychain command, per keychain-signer.mjs) with the
// two structural guarantees every implementation must have: a liveMode gate that refuses to sign
// or broadcast at all when `liveMode` is not exactly `true`, and a scrub that refuses to let any
// obviously-secret-shaped field (a raw private key, a mnemonic, a seed) leave through a result.
//
// The module retains five compatibility roles: two Operations roles, a legacy operations-trigger
// role, and two imported distribution roles. Only Operations EVM and Operations Solana can enter
// the transaction-policy boundary. The distribution roles sign digests only.
import { createHash } from 'node:crypto';

import { canonicalJson, digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';
import { SIGN_ONLY_PRE_SIGN_BINDING_SCHEMA } from '../../../runner/src/cycle/money-schemas.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
  requireLiveRetainedCustodyMutationAuthority,
} from '../../../runner/src/cycle/preflight.mjs';
// ADR-0025 sign-only bounded retry: this is the one, mutual seam between the generic
// transaction-policy signer facade and the one signer backend this repository has proven a
// sign-only timeout is safe to auto-retry (see keychain-signer.mjs's own header). Circular at the
// module-graph level (keychain-signer.mjs imports the base signer-client exports above), but safe:
// these are plain functions, not classes, so nothing here reads their bindings until
// `wrapTransactionPolicySignerClient` actually runs a sign(), long after both modules finish
// evaluating (the error classes both modules need are defined directly above, precisely to avoid
// the top-level class-`extends` circularity a class import here would hit).
import {
  isOwnedKeychainSignOnlyClient,
  readOwnedKeychainSignOnlyIdentity,
} from './keychain-signer.mjs';
import {
  bindTransactionPolicy,
  captureSolanaCoSignerSignatures,
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
  expectedBroadcastIdentifier,
  revalidateSignedMessage,
} from './transaction-policy.mjs';
import {
  DISTRIBUTION_SIGNER_ROLE,
  VERIFIER_ROLE,
} from '../../../runner/src/distribution/distribution-signer.mjs';

export const OPERATOR_EVM_ROLE = 'operator-evm';
export const OPERATOR_SOLANA_ROLE = 'operator-solana';
const transactionPolicySigners = new WeakSet();
export const TRANSACTION_POLICY_APPROVAL_SCHEMA = 'hookemon.transaction-policy-approval.v1';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// Legacy compatibility role. It remains available to older non-policy integrations but cannot be
// wrapped by `wrapTransactionPolicySignerClient`.
export const OPERATIONS_TRIGGER_ROLE = 'operations-trigger';
export { DISTRIBUTION_SIGNER_ROLE, VERIFIER_ROLE };

export const SIGNER_ROLES = Object.freeze([
  OPERATOR_EVM_ROLE,
  OPERATOR_SOLANA_ROLE,
  OPERATIONS_TRIGGER_ROLE,
  DISTRIBUTION_SIGNER_ROLE,
  VERIFIER_ROLE,
]);

// The three EVM/Solana broadcast-capable roles (operator, operator-solana, and the operations
// trigger) can broadcast a transaction; the distribution-signer/verifier roles only ever sign a
// digest over an already-computed candidate (design section 4.8) — they have no broadcast concept
// at all.
export const ROLE_CAPABILITIES = Object.freeze({
  [OPERATOR_EVM_ROLE]: Object.freeze({ sign: true, broadcast: true }),
  [OPERATOR_SOLANA_ROLE]: Object.freeze({ sign: true, broadcast: true }),
  [OPERATIONS_TRIGGER_ROLE]: Object.freeze({ sign: true, broadcast: true }),
  [DISTRIBUTION_SIGNER_ROLE]: Object.freeze({ sign: true, broadcast: false }),
  [VERIFIER_ROLE]: Object.freeze({ sign: true, broadcast: false }),
});

const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

export class SignerClientError extends Error {}

// ADR-0025 sign-only bounded retry classification. Defined here, not in keychain-signer.mjs, purely
// to avoid a circular top-level class-`extends` evaluation between the two modules; keychain-signer.mjs
// is still the only module that ever constructs either one (see its own header comment) -- these are
// exported from the base module for the same reason `SignerClientError` itself is.
export class KeychainSignOnlyTimeoutError extends SignerClientError {}
export class KeychainPreInvocationDenialError extends SignerClientError {}

function fail(message) {
  throw new SignerClientError(message);
}

// A fresh, unforgeable token this module mints only inside `wrapTransactionPolicySignerClient`,
// immediately after it evaluates transaction policy for the exact request or signed bytes about
// to cross to a backend (Task B independent review: the Solana `--parent-policy-evaluated` marker
// must never be a caller-supplied construction knob). Neither the issuer nor the WeakSet is
// exported, so no code outside this module can construct a value that passes
// `assertPolicyEvaluationProof` — the only way to obtain a genuine proof is to go through this
// module's own, already-evaluated policy path.
const policyEvaluationProofs = new WeakSet();

function issuePolicyEvaluationProof() {
  const proof = Object.freeze(Object.create(null));
  policyEvaluationProofs.add(proof);
  return proof;
}

function assertPolicyEvaluationProof(proof, role) {
  if (typeof proof !== 'object' || proof === null || !policyEvaluationProofs.has(proof)) {
    fail(`signer client for role "${role}" requires a genuine parent transaction-policy evaluation proof`);
  }
}

function requireSignerMutationAuthority(role, preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      fail('signer client fixture authority is available only from the Node test runner');
    }
    return;
  }
  if (preflightAuthority !== undefined) {
    fail('signer client test authority is invalid');
  }
  if (role === DISTRIBUTION_SIGNER_ROLE || role === VERIFIER_ROLE) {
    return requireLiveRetainedCustodyMutationAuthority();
  }
  return requireLiveMutationAuthority();
}

export function assertRole(role) {
  if (!SIGNER_ROLES.includes(role)) fail(`unknown signer role: ${role}`);
  return role;
}

// A bare 32-byte or 64-byte hex string (with or without 0x) is exactly the shape of a raw EVM/
// ed25519 private key or a Solana secret-key seed — the same defense-in-depth heuristic
// packages/adapters/src/app/environment.mjs's `assertNoSecretLookingValue` already applies to
// configuration values, applied here to signer results instead.
const RAW_KEY_LOOKING_PATTERN = /^(0x)?[0-9a-fA-F]{64}$|^(0x)?[0-9a-fA-F]{128}$/;
const PROHIBITED_SECRET_FIELDS = new Set(['privateKey', 'secretKey', 'mnemonic', 'seed', 'seedPhrase', 'keypair']);

/**
 * Recursively refuses a value carrying an obviously-secret-shaped field name or an
 * obviously-key-shaped raw string. Opaque signed-bytes fields (a `Buffer`/`Uint8Array`, or a
 * base64/base64url string produced by an actual signature) are exempt from the raw-key-shape check
 * — a real signature or a real signed-transaction blob legitimately can be 64 or 128 hex-equivalent
 * bytes long, and this function's job is to catch a field that looks like it was never signed
 * (secret material passed straight through), not to reject legitimate signed output.
 */
export function assertNoSecretLookingValue(value, label, { checkRawKeyShape = false, seen = new Set() } = {}) {
  if (value === null || value === undefined) return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return;
  if (typeof value === 'string') {
    if (checkRawKeyShape && RAW_KEY_LOOKING_PATTERN.test(value.trim())) {
      fail(`${label} looks like raw key material and was refused`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLookingValue(item, `${label}[${index}]`, { checkRawKeyShape, seen }));
    return;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (PROHIBITED_SECRET_FIELDS.has(key)) fail(`${label}.${key} is a prohibited secret-looking field`);
      // Only fields that are not themselves the signed-output payload are checked for raw-key
      // shape; `signedBytes`/`signature`/`signedTx*` fields are the module's actual, legitimate
      // output and are exempt by name, matching environment.mjs's own "URLs/addresses/ids never
      // look like a key" reasoning applied in the opposite direction (an output field is expected
      // to look opaque).
      // Transaction hashes are public identifiers returned by a broadcaster, even though a
      // 32-byte hexadecimal hash has the same length as a private-key-shaped value. Keep the
      // raw-key heuristic for every other field, including any unknown hexadecimal output.
      const nestedChecksRawKeyShape = checkRawKeyShape && !/^signed|signature$|transactionHash$|txHash$/i.test(key);
      assertNoSecretLookingValue(nested, `${label}.${key}`, { checkRawKeyShape: nestedChecksRawKeyShape, seen });
    }
  }
}

/**
 * A deterministic digest of a sign/broadcast request, independent of the request's own key order
 * or representation. Used purely for audit/logging by `wrapSignerClient` (passed to `inner.sign`/
 * `inner.broadcast` as `{ digest }`) — never as a substitute for the actual bytes signed, and never
 * required to be understood by an implementation that ignores it.
 *
 *   - `Buffer`/`Uint8Array`: hashed as raw bytes (this is how
 *     packages/runner/src/distribution/distribution-signer.mjs already calls a signer client:
 *     `signerClient.sign(Buffer.from(digestHex, 'utf8'))`).
 *   - `string`: hashed as UTF-8 bytes.
 *   - anything else (a plain JSON-shaped request, e.g. a policy-wallet intent): hashed over its
 *     canonical JSON form (packages/runner/src/cycle/journal.mjs's `canonicalJson`, which sorts
 *     object keys and rejects prototype pollution / non-finite numbers / bigints), so two
 *     logically-identical requests that merely differ in key order always digest identically.
 */
export function signRequestDigest(request) {
  if (Buffer.isBuffer(request)) return `sha256:${createHash('sha256').update(request).digest('hex')}`;
  if (request instanceof Uint8Array) return `sha256:${createHash('sha256').update(Buffer.from(request)).digest('hex')}`;
  if (typeof request === 'string') return `sha256:${createHash('sha256').update(request, 'utf8').digest('hex')}`;
  return `sha256:${createHash('sha256').update(canonicalJson(request)).digest('hex')}`;
}

/** A durable, JSON-safe textual form of a wire payload -- mirrors `signRequestDigest`'s own
 * Buffer/Uint8Array/string/object type dispatch, since a durable pre-sign binding's
 * `unsignedWireBytes` must survive the same storage round trip `canonicalJson` requires. */
function canonicalWireBytesText(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'string') return value;
  return canonicalJson(value);
}

/**
 * Wraps a caller-supplied `inner` implementation (never holding key material of its own — `inner`
 * is where an implementation talks to whatever actually holds the key, an operator module or a
 * keychain command) into the shared, uniform `{ role, sign(request), broadcast(signed) }` client
 * every implementation in this directory returns. Both `external-module-signer.mjs` and
 * `keychain-signer.mjs` call this — it is the single place the two structural safety properties
 * ("refuses when liveMode is false", "never returns secret-looking material") are enforced, so
 * every implementation gets them identically rather than each reimplementing the check.
 *
 * @param {object} input
 * @param {string} input.role - one of `SIGNER_ROLES`.
 * @param {boolean} input.liveMode - fixed at construction; this client refuses every `sign`/
 *   `broadcast` call for its whole lifetime if this is not exactly `true`. This is a
 *   defense-in-depth, construction-time gate distinct from (and in addition to) any call-site
 *   liveMode gate a caller (e.g. `packages/adapters/src/app/stage-driver.mjs`) already applies —
 *   even if a caller forgets to gate, this client itself never signs or broadcasts.
 * @param {{sign: Function, broadcast?: Function, signApproved?: Function, broadcastApproved?: Function}} input.inner -
 *   the real implementation. `sign` is called as `inner.sign(request, { digest, role })`;
 *   `broadcast` (required only for roles whose `ROLE_CAPABILITIES` says `broadcast: true`, unless
 *   `broadcastApproved` is supplied instead) as `inner.broadcast(signed, { role })`. `signApproved`/
 *   `broadcastApproved` are optional, stronger variants an implementation exposes when a caller
 *   must first prove genuine parent transaction-policy evaluation (see `assertPolicyEvaluationProof`
 *   below) — this wrapper checks that proof itself, before `inner.signApproved`/
 *   `inner.broadcastApproved` ever runs, so every implementation gets that guarantee identically.
 * @param {object} [input.preflightAuthority] - exact object returned by
 *   `createTestProfileMutationAuthority()` for local fixture tests only. Production callers omit
 *   this field, causing every sign and broadcast call to re-read the active interface authority.
 */
export function wrapSignerClient({ role, liveMode, inner, preflightAuthority }) {
  assertRole(role);
  if (typeof liveMode !== 'boolean') fail('liveMode must be a boolean');
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) fail('signer client implementation must be a plain object');
  if (typeof inner.sign !== 'function') fail(`signer client for role "${role}" must expose sign()`);
  const capabilities = ROLE_CAPABILITIES[role];
  if (capabilities.broadcast && typeof inner.broadcast !== 'function' && typeof inner.broadcastApproved !== 'function') {
    fail(`signer client for role "${role}" must expose broadcast() or broadcastApproved()`);
  }
  if (inner.signApproved !== undefined && typeof inner.signApproved !== 'function') {
    fail(`signer client for role "${role}" signApproved must be a function`);
  }
  if (inner.broadcastApproved !== undefined && typeof inner.broadcastApproved !== 'function') {
    fail(`signer client for role "${role}" broadcastApproved must be a function`);
  }

  const client = {
    role,
    async sign(request) {
      if (liveMode !== true) fail(`signer client for role "${role}" refuses to sign: liveMode is false`);
      const requestDigest = signRequestDigest(request);
      requireSignerMutationAuthority(role, preflightAuthority);
      const result = await inner.sign(request, { digest: requestDigest, role });
      assertNoSecretLookingValue(result, `${role} sign() result`, { checkRawKeyShape: true });
      return result;
    },
  };
  if (typeof inner.signApproved === 'function') {
    client.signApproved = async (request, proof) => {
      if (liveMode !== true) fail(`signer client for role "${role}" refuses to sign: liveMode is false`);
      assertPolicyEvaluationProof(proof, role);
      const requestDigest = signRequestDigest(request);
      requireSignerMutationAuthority(role, preflightAuthority);
      const result = await inner.signApproved(request, proof, { digest: requestDigest, role });
      assertNoSecretLookingValue(result, `${role} signApproved() result`, { checkRawKeyShape: true });
      return result;
    };
  }
  if (capabilities.broadcast) {
    if (typeof inner.broadcast === 'function') {
      client.broadcast = async signed => {
        if (liveMode !== true) fail(`signer client for role "${role}" refuses to broadcast: liveMode is false`);
        requireSignerMutationAuthority(role, preflightAuthority);
        const result = await inner.broadcast(signed, { role });
        assertNoSecretLookingValue(result, `${role} broadcast() result`, { checkRawKeyShape: true });
        return result;
      };
    }
    if (typeof inner.broadcastApproved === 'function') {
      client.broadcastApproved = async (signed, proof) => {
        if (liveMode !== true) fail(`signer client for role "${role}" refuses to broadcast: liveMode is false`);
        assertPolicyEvaluationProof(proof, role);
        requireSignerMutationAuthority(role, preflightAuthority);
        const result = await inner.broadcastApproved(signed, proof, { role });
        assertNoSecretLookingValue(result, `${role} broadcastApproved() result`, { checkRawKeyShape: true });
        return result;
      };
    }
  }
  return Object.freeze(client);
}

function signerFamily(role) {
  if (role === OPERATOR_SOLANA_ROLE) return 'solana';
  if (role === OPERATOR_EVM_ROLE) return 'evm';
  fail(`signer client for role "${role}" cannot use a transaction policy`);
}

function trustedTransactionDecodeOptions(family, decodeOptions) {
  if (!decodeOptions || typeof decodeOptions !== 'object' || Array.isArray(decodeOptions)) {
    fail('transaction policy signer requires decodeOptions');
  }
  if (decodeOptions.family !== undefined && decodeOptions.family !== family) {
    fail(`transaction policy signer family must be ${family}`);
  }
  return Object.freeze({ ...decodeOptions, family });
}

function immutableSnapshot(value, label, seen = new Map()) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (typeof value === 'function') return value;
  if (typeof value !== 'object') fail(`${label} must be a cloneable value`);
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(immutableSnapshot(item, label, seen));
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const copy = {};
  seen.set(value, copy);
  for (const [key, nested] of Object.entries(value)) {
    copy[key] = immutableSnapshot(nested, `${label}.${key}`, seen);
  }
  return Object.freeze(copy);
}

function transactionDecodeInput(request, decodeOptions) {
  const requestSnapshot = immutableSnapshot(request, 'transaction policy request');
  const transaction = requestSnapshot && typeof requestSnapshot === 'object' && !Array.isArray(requestSnapshot)
    && Object.hasOwn(requestSnapshot, 'transaction')
    ? requestSnapshot.transaction
    : requestSnapshot;
  return Object.freeze({
    request: requestSnapshot,
    input: Object.freeze({ ...decodeOptions, transaction }),
  });
}

function signedApprovalKey(signed, family) {
  if (typeof signed === 'string') return `${family}:${signed}`;
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    fail(`transaction policy signer received an invalid signed ${family} message`);
  }
  const field = family === 'solana' ? 'signedTxBase64' : 'signedTx';
  if (typeof signed[field] !== 'string' || signed[field].length === 0) {
    fail(`transaction policy signer requires ${field} from the signing backend`);
  }
  return `${family}:${signed[field]}`;
}

function signedEnvelope(signed, family) {
  const field = family === 'solana' ? 'signedTxBase64' : 'signedTx';
  const key = signedApprovalKey(signed, family);
  return Object.freeze({ [field]: key.slice(`${family}:`.length) });
}

/** Refuses a broadcast result that is not a well-formed, matching identifier for these exact
 * authorized signed bytes — an EVM transaction hash or a Solana signature, per
 * `expectedBroadcastIdentifier`'s own contract. Applies identically regardless of which of
 * `wrapTransactionPolicySignerClient`'s two transport shapes (a caller-supplied `broadcast`
 * callback or a backend's guarded `broadcastApproved`) produced the result — neither is a
 * lesser-trusted seam than the other. */
function assertBroadcastResultMatchesSignedBytes(envelope, family, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('broadcast result must be an object');
  }
  const expectedIdentifier = expectedBroadcastIdentifier(envelope, family);
  const identifierField = family === 'solana' ? 'signature' : 'transactionHash';
  const actualIdentifier = typeof result[identifierField] === 'string' && family === 'evm'
    ? result[identifierField].toLowerCase()
    : result[identifierField];
  if (actualIdentifier !== expectedIdentifier) {
    fail(`broadcast result ${identifierField} does not match the signed ${family} transaction bytes`);
  }
}

function decodedSignedMessageBytes(signed, family) {
  const envelope = signedEnvelope(signed, family);
  const field = family === 'solana' ? 'signedTxBase64' : 'signedTx';
  const encoded = envelope[field];
  if (family === 'evm') {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(encoded)) {
      fail('transaction policy approval requires even-length hexadecimal EVM signed bytes');
    }
    return Buffer.from(encoded.slice(2), 'hex');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    fail('transaction policy approval requires canonical base64 Solana signed bytes');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) fail('transaction policy approval requires non-empty Solana signed bytes');
  return bytes;
}

// RPC observation slots advance without changing the approved message. The policy digest
// separately pins their minimum; every fresh decode still checks that bound before use.
function stableApprovalSemantics(approved) {
  if (approved.family !== 'solana' || approved.deadline?.type !== 'rpc-blockhash-validity') return approved;
  const { observedSlot, ...deadline } = approved.deadline;
  return { ...approved, deadline };
}

function transactionPolicyApprovalContext({ family, policyDigest, approved, signed }) {
  const signedMessageDigest = `sha256:${createHash('sha256').update(decodedSignedMessageBytes(signed, family)).digest('hex')}`;
  const approvedSemanticsDigest = canonicalDigest(stableApprovalSemantics(approved));
  const approvalDigest = canonicalDigest({
    schema: TRANSACTION_POLICY_APPROVAL_SCHEMA,
    family,
    policyDigest,
    approvedSemanticsDigest,
    signedMessageDigest,
  });
  return Object.freeze({
    schema: TRANSACTION_POLICY_APPROVAL_SCHEMA,
    family,
    policyDigest,
    approvedSemanticsDigest,
    signedMessageDigest,
    approvalDigest,
  });
}

function normalizeTransactionPolicyApprovalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('transaction policy recovery context is invalid');
  }
  const fields = [
    'schema',
    'family',
    'policyDigest',
    'approvedSemanticsDigest',
    'signedMessageDigest',
    'approvalDigest',
  ];
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    fail('transaction policy recovery context must use the exact schema');
  }
  if (value.schema !== TRANSACTION_POLICY_APPROVAL_SCHEMA || !['evm', 'solana'].includes(value.family)) {
    fail('transaction policy recovery context schema is invalid');
  }
  for (const field of ['policyDigest', 'approvedSemanticsDigest', 'signedMessageDigest', 'approvalDigest']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) {
      fail(`transaction policy recovery context ${field} is invalid`);
    }
  }
  return Object.freeze({
    schema: value.schema,
    family: value.family,
    policyDigest: value.policyDigest,
    approvedSemanticsDigest: value.approvedSemanticsDigest,
    signedMessageDigest: value.signedMessageDigest,
    approvalDigest: value.approvalDigest,
  });
}

function sameTransactionPolicyApprovalContext(left, right) {
  return left.schema === right.schema
    && left.family === right.family
    && left.policyDigest === right.policyDigest
    && left.approvedSemanticsDigest === right.approvedSemanticsDigest
    && left.signedMessageDigest === right.signedMessageDigest
    && left.approvalDigest === right.approvalDigest;
}

/** Returns whether a client can sign and broadcast through this module's transaction-policy gate. */
export function isTransactionPolicySignerClient(client) {
  return Boolean(client && typeof client === 'object' && transactionPolicySigners.has(client));
}

/** Returns the immutable policy approval record that must be stored beside signed bytes. */
export function readTransactionPolicyApprovalContext(client, signed) {
  if (!isTransactionPolicySignerClient(client) || typeof client.readApprovalContext !== 'function') {
    fail('transaction policy recovery requires a transaction-policy signer');
  }
  return client.readApprovalContext(signed);
}

/** Reauthorizes exact durable bytes so a guarded caller can perform the broadcast boundary. */
export async function recoverTransactionPolicyApproval({ client, signed, recoveryContext }) {
  if (!isTransactionPolicySignerClient(client) || typeof client.recoverApproval !== 'function') {
    fail('transaction policy recovery requires a transaction-policy signer');
  }
  return client.recoverApproval(signed, recoveryContext);
}

/** Reauthorizes exact durable signed bytes against the persisted transaction-policy approval. */
export async function recoverTransactionPolicyBroadcast({ client, signed, recoveryContext }) {
  if (!isTransactionPolicySignerClient(client) || typeof client.recoverBroadcast !== 'function') {
    fail('transaction policy recovery requires a transaction-policy signer');
  }
  return client.recoverBroadcast(signed, recoveryContext);
}

/**
 * Adds decode, allowlist evaluation, and signed-message revalidation to a broadcast-capable
 * signer client. The wrapped client sees the original request unchanged. Its signed bytes are
 * never broadcast unless they decode to exactly the semantic description approved before sign().
 *
 * REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: `recovery`, when supplied, is the
 * `{repository, cycleId, stage, requestDigest}` this exact request's chain attempt was PREPARED
 * under. Passing it is what makes a classified Keychain sign-only timeout eligible for exactly one
 * bounded, identical-bytes retry -- and only when `client` also carries the owned-Keychain
 * capability (see keychain-signer.mjs); every other backend, and every call with no `recovery`,
 * keeps today's no-automatic-retry behavior unchanged.
 */
function assertSignOnlyRecoveryOption(recovery) {
  if (recovery === undefined) return undefined;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    fail('transaction policy signer recovery option must be an object');
  }
  if (!recovery.repository || typeof recovery.repository !== 'object') {
    fail('transaction policy signer recovery option requires a repository');
  }
  if (typeof recovery.cycleId !== 'string' || recovery.cycleId.length === 0) {
    fail('transaction policy signer recovery option cycleId is invalid');
  }
  if (typeof recovery.stage !== 'string' || recovery.stage.length === 0) {
    fail('transaction policy signer recovery option stage is invalid');
  }
  if (typeof recovery.requestDigest !== 'string' || recovery.requestDigest.length === 0) {
    fail('transaction policy signer recovery option requestDigest is invalid');
  }
  return recovery;
}

/**
 * Re-decodes and re-evaluates the exact persisted unsigned bytes immediately before every actual
 * sign-only invocation -- including the first -- and refuses if the decoded validity semantics
 * (nonce/blockhash/deadline/etc., pinned at bind time as `expectedValidityContextDigest`) have
 * drifted. This never regenerates the request: `input` is the same immutable decode input every
 * caller already built from the same durably bound bytes; a mismatch here means something about
 * chain state or policy changed underneath the binding, not that new material was substituted.
 */
async function reapproveBeforeSignOnlyInvocation({ input, canonicalPolicy, policyRules, expectedValidityContextDigest }) {
  const reApproved = await decodeProviderTransaction(input);
  evaluateTransactionPolicy(canonicalPolicy, reApproved, { rules: policyRules });
  if (canonicalDigest(stableApprovalSemantics(reApproved)) !== expectedValidityContextDigest) {
    fail('sign-only retry refuses: decoded validity semantics changed since the pre-sign binding was recorded');
  }
}

/**
 * Binds, then invokes, the exact bounded Keychain sign-only sequence this ADR-0025 retry guarantee
 * covers. Every branch that is not "an owned Keychain client, with a recovery binding, that threw
 * the classified timeout" falls straight through to a single unmodified sign call -- an external
 * module, a spoofed/cloned object, a generic error, and a denial before invocation all take that
 * same single-call path, exactly like before this guarantee existed. The repository's sign-only
 * recovery API is required only once `client` has already proven ownership -- a `recovery` option
 * paired with an ordinary fixture signer (the common case in this repository's non-Keychain tests)
 * never touches `recovery.repository` at all.
 *
 * The retry budget itself is durable, not a property of this one function call: every actual
 * invocation, at either ordinal, is preceded by `recovery.repository.reserveSignOnlyInvocation`, an
 * atomic CAS that only succeeds from the exact expected predecessor state (no record for ordinal 1,
 * an ordinal-1 timeout for ordinal 2) and while the bound chain attempt is still PREPARED. A fresh
 * `wrapTransactionPolicySignerClient` call -- whether a genuine in-process retry or an unrelated
 * process that reopened the repository after a restart -- always re-reads the durable ledger before
 * deciding what, if anything, it may still invoke; it never infers eligibility from having caught a
 * timeout locally. A timeout at ordinal 2 is terminal: this guarantee never retries more than once.
 */
async function signWithBoundedSignOnlyRecovery({
  client, family, requestSnapshot, input, canonicalPolicy, policyRules, approved, policyDigest, recovery, invokeSign,
}) {
  if (recovery === undefined || !isOwnedKeychainSignOnlyClient(client)) {
    return invokeSign();
  }
  if (typeof recovery.repository.persistSignOnlyPreSignBinding !== 'function'
    || typeof recovery.repository.readSignOnlyPreSignBinding !== 'function'
    || typeof recovery.repository.reserveSignOnlyInvocation !== 'function'
    || typeof recovery.repository.recordSignOnlyInvocationTimeout !== 'function'
    || typeof recovery.repository.readSignOnlyInvocationLedger !== 'function') {
    fail('transaction policy signer recovery option requires a repository with the sign-only recovery API');
  }
  const identity = readOwnedKeychainSignOnlyIdentity(client);
  // Only the Solana Keychain transport narrows a `sign()`/`signApproved()` request down to the bare
  // transaction before it reaches a wire (keychain-signer.mjs's `solanaSignTransportPayload`) --
  // the EVM child sends the full envelope this caller built (`{transaction, transactionPolicy,
  // transactionPolicyRules, transactionDecodeOptions, liveMode}`, see e.g. outbound.mjs's own
  // `policySigner.sign()` call), unnarrowed. The durable binding must record exactly what a given
  // family actually sends, or a caller could change `transactionPolicy`/`transactionPolicyRules`/
  // `liveMode` between a bound request and a retried one without the binding ever detecting it.
  // `family` is the same trusted value `wrapTransactionPolicySignerClient` itself derived from
  // `assertRole(client.role)` above -- never inferred here from `input`/a caller-supplied flag.
  const wireBytes = family === 'solana' ? input.transaction : requestSnapshot;
  const binding = {
    schema: SIGN_ONLY_PRE_SIGN_BINDING_SCHEMA,
    cycleId: recovery.cycleId,
    stage: recovery.stage,
    requestDigest: recovery.requestDigest,
    role: identity.role,
    account: identity.account,
    unsignedWireBytes: canonicalWireBytesText(wireBytes),
    unsignedRequestDigest: signRequestDigest(wireBytes),
    policyDigest,
    validityContextDigest: canonicalDigest(stableApprovalSemantics(approved)),
  };
  // Binds before the first invocation, unconditionally -- not only on a timeout -- so a restart
  // that reaches this exact call again (with regenerated request material) is CAS-refused before
  // ever reaching Keychain if that material silently differs, and is a no-op idempotent replay if
  // it does not. Neither outcome is distinguishable from "this is the first attempt" from here.
  const bound = await recovery.repository.persistSignOnlyPreSignBinding(
    recovery.cycleId,
    recovery.stage,
    recovery.requestDigest,
    binding,
  );

  async function attempt(ordinal) {
    // Atomically re-verifies the bound chain attempt is still PREPARED and that this exact ordinal
    // is the durable ledger's next eligible step. A concurrent second caller racing for the same
    // ordinal, a chain attempt that advanced or was refused, or an already-exhausted ledger all
    // throw here -- before this function ever calls `invokeSign()`.
    await recovery.repository.reserveSignOnlyInvocation(recovery.cycleId, recovery.stage, recovery.requestDigest, ordinal);
    await reapproveBeforeSignOnlyInvocation({
      input, canonicalPolicy, policyRules, expectedValidityContextDigest: bound.validityContextDigest,
    });
    try {
      return await invokeSign();
    } catch (error) {
      if (!(error instanceof KeychainSignOnlyTimeoutError) || ordinal === 2) throw error;
      await recovery.repository.recordSignOnlyInvocationTimeout(recovery.cycleId, recovery.stage, recovery.requestDigest, ordinal);
      return attemptNextEligible();
    }
  }

  async function attemptNextEligible() {
    const ledger = await recovery.repository.readSignOnlyInvocationLedger(recovery.cycleId, recovery.stage, recovery.requestDigest);
    if (ledger === null) return attempt(1);
    if (ledger.state === 'ORDINAL_1_TIMED_OUT') return attempt(2);
    // Ordinal 1 is allocated but has no recorded outcome (a crash or an unknown/generic-error
    // result), or ordinal 2 already exists (timed out or, in a benign race, still being attempted
    // by whoever legitimately won it): either way this call has nothing left it may invoke.
    fail('sign-only invocation budget is exhausted or its outcome is ambiguous; refusing to invoke Keychain');
  }

  return attemptNextEligible();
}

export function wrapTransactionPolicySignerClient({ client, policy, rules, decodeOptions, broadcast, recovery }) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    fail('transaction policy signer requires a signer client');
  }
  const recoveryOption = assertSignOnlyRecoveryOption(recovery);
  const role = assertRole(client.role);
  const family = signerFamily(role);
  const trustedDecodeOptions = trustedTransactionDecodeOptions(family, decodeOptions);
  if (!ROLE_CAPABILITIES[role].broadcast || typeof client.sign !== 'function'
    || (broadcast === undefined && typeof client.broadcast !== 'function' && typeof client.broadcastApproved !== 'function')) {
    fail(`transaction policy signer for role "${role}" requires sign() and broadcast()`);
  }
  if (broadcast !== undefined && typeof broadcast !== 'function') {
    fail(`transaction policy signer for role "${role}" broadcast must be a function`);
  }
  if (family === 'solana' && typeof trustedDecodeOptions.currentBlockHeightResolver !== 'function') {
    fail('transaction policy signer for Solana requires a currentBlockHeightResolver for every broadcast');
  }
  if (family === 'solana' && typeof trustedDecodeOptions.blockhashContextResolver !== 'function') {
    fail('transaction policy signer for Solana requires a blockhashContextResolver for every broadcast');
  }
  const policyBinding = bindTransactionPolicy(policy, rules);
  const canonicalPolicy = policyBinding.policy;
  const policyRules = policyBinding.rules;
  const approvals = new Map();
  const policyDigest = policyRules.some(rule => rule.deadline?.type === 'rpc-blockhash-validity')
    ? canonicalDigest({ policy: canonicalPolicy, rules: policyRules })
    : canonicalDigest(canonicalPolicy);
  async function recoveredApproval(signed, recoveryContext) {
    const envelope = signedEnvelope(signed, family);
    const expected = normalizeTransactionPolicyApprovalContext(recoveryContext);
    if (expected.family !== family || expected.policyDigest !== policyDigest) {
      fail('transaction policy recovery context does not match the active policy');
    }
    const field = family === 'solana' ? 'signedTxBase64' : 'signedTx';
    const { input } = transactionDecodeInput({ transaction: envelope[field] }, trustedDecodeOptions);
    const redecoded = await decodeProviderTransaction(input);
    evaluateTransactionPolicy(canonicalPolicy, redecoded, { rules: policyRules });
    const actual = transactionPolicyApprovalContext({ family, policyDigest, approved: redecoded, signed: envelope });
    if (!sameTransactionPolicyApprovalContext(actual, expected)) {
      fail('transaction policy recovery context does not authenticate the exact signed message');
    }
    return Object.freeze({
      approved: redecoded,
      input,
      coSignerSignatures: family === 'solana' ? captureSolanaCoSignerSignatures(input.transaction) : undefined,
      recoveryContext: actual,
    });
  }
  const wrapped = {
    ...client,
    async sign(request) {
      const { request: requestSnapshot, input } = transactionDecodeInput(request, trustedDecodeOptions);
      const approved = await decodeProviderTransaction(input);
      evaluateTransactionPolicy(canonicalPolicy, approved, { rules: policyRules });
      const coSignerSignatures = family === 'solana'
        ? captureSolanaCoSignerSignatures(input.transaction)
        : undefined;
      // `signApproved`, when the backend exposes it, requires the proof below — minted only here,
      // only after the policy evaluation immediately above succeeded. A backend cannot receive this
      // proof any other way (see `assertPolicyEvaluationProof`'s own doc comment), so a backend
      // that gates a trust marker on this proof can never emit that marker for an unevaluated
      // request, regardless of how a caller constructs or configures that backend.
      const rawSigned = await signWithBoundedSignOnlyRecovery({
        client,
        family,
        requestSnapshot,
        input,
        canonicalPolicy,
        policyRules,
        approved,
        policyDigest,
        recovery: recoveryOption,
        invokeSign: () => (typeof client.signApproved === 'function'
          ? client.signApproved(requestSnapshot, issuePolicyEvaluationProof())
          : client.sign(requestSnapshot)),
      });
      const signed = signedEnvelope(rawSigned, family);
      approvals.set(signedApprovalKey(signed, family), Object.freeze({
        approved,
        input,
        coSignerSignatures,
        recoveryContext: transactionPolicyApprovalContext({ family, policyDigest, approved, signed }),
      }));
      return signed;
    },
    readApprovalContext(signed) {
      const envelope = signedEnvelope(signed, family);
      const approval = approvals.get(signedApprovalKey(envelope, family));
      if (!approval) fail('transaction policy signer has no approval for the signed message');
      return approval.recoveryContext;
    },
    async recoverApproval(signed, recoveryContext) {
      const envelope = signedEnvelope(signed, family);
      const approval = await recoveredApproval(envelope, recoveryContext);
      approvals.set(signedApprovalKey(envelope, family), approval);
      return envelope;
    },
    async broadcast(signed) {
      const envelope = signedEnvelope(signed, family);
      const key = signedApprovalKey(envelope, family);
      const approval = approvals.get(key);
      if (!approval) fail('transaction policy signer refuses to broadcast an unsigned or unapproved message');
      const redecoded = await revalidateSignedMessage(envelope, approval.approved, {
        ...approval.input,
        ...(family === 'solana' ? { expectedCoSignerSignatures: approval.coSignerSignatures } : {}),
      });
      evaluateTransactionPolicy(canonicalPolicy, redecoded, { rules: policyRules });
      // All three ways this method can reach a real chain RPC — a directly-supplied `broadcast`
      // callback, a backend's guarded `broadcastApproved`, and a plain `client.broadcast` (the
      // live-capable shape `createExternalModuleSignerClient`/`outbound.mjs`/`payout.mjs` construct
      // this wrapper around with no direct callback) — are the same kind of untrusted transport
      // boundary. `result` is selected among them first, then validated and the approval consumed
      // exactly once below, so no branch can be added or reordered without the check applying to it.
      let result;
      if (broadcast !== undefined) {
        result = await broadcast(envelope);
      } else if (typeof client.broadcastApproved === 'function') {
        // Mirrors `sign()`'s `signApproved` gate: a real chain RPC transport is reachable only
        // through this freshly-minted proof, immediately after the revalidation and policy
        // re-check above — never through a caller holding a bare reference to the backend.
        result = await client.broadcastApproved(envelope, issuePolicyEvaluationProof());
      } else {
        result = await client.broadcast(envelope);
      }
      // A mismatched or malformed result is refused and the approval is left in place, so a
      // caller can retry the same signed bytes exactly like an RPC failure would.
      assertBroadcastResultMatchesSignedBytes(envelope, family, result);
      approvals.delete(key);
      return result;
    },
    async recoverBroadcast(signed, recoveryContext) {
      const envelope = signedEnvelope(signed, family);
      await wrapped.recoverApproval(envelope, recoveryContext);
      return wrapped.broadcast(envelope);
    },
  };
  const frozen = Object.freeze(wrapped);
  transactionPolicySigners.add(frozen);
  return frozen;
}

/**
 * The frozen production entry point (launch-repair Task B, "production signer and chain RPC
 * transport"): constructs a policy-guarded signer/broadcaster in one call, matching this module's
 * one signing route rather than a second one.
 *
 *   createPolicySigner({ backend, policy, rules, decodeOptions, broadcast });
 *   // decodeOptions may contain resolver functions and stays in the parent.
 *   // backend receives only validated JSON signing data.
 *   // broadcast sends already-authorized signed bytes through the correct chain RPC.
 *
 * `backend` is a `{ role, sign, broadcast? }` implementation — typically what
 * `createKeychainSignerClient`/`createExternalModuleSignerClient` returns — optionally exposing the
 * stronger `signApproved`/`broadcastApproved` a backend uses to gate a trust marker (e.g. the
 * Solana keychain child's `--parent-policy-evaluated` CLI argument) on proof that this exact call
 * genuinely evaluated policy first. This is a thin, clearly-named alias for
 * `wrapTransactionPolicySignerClient` — the same function, same guarantees.
 */
export function createPolicySigner({ backend, policy, rules, decodeOptions, broadcast, recovery }) {
  return wrapTransactionPolicySignerClient({ client: backend, policy, rules, decodeOptions, broadcast, recovery });
}
