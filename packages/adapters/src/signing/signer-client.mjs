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
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
  requireLiveRetainedCustodyMutationAuthority,
} from '../../../runner/src/cycle/preflight.mjs';
import {
  bindTransactionPolicy,
  captureSolanaCoSignerSignatures,
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
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

function fail(message) {
  throw new SignerClientError(message);
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
 * @param {{sign: Function, broadcast?: Function}} input.inner - the real implementation. `sign`
 *   is called as `inner.sign(request, { digest, role })`; `broadcast` (required only for roles
 *   whose `ROLE_CAPABILITIES` says `broadcast: true`) as `inner.broadcast(signed, { role })`.
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
  if (capabilities.broadcast && typeof inner.broadcast !== 'function') {
    fail(`signer client for role "${role}" must expose broadcast()`);
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
  if (capabilities.broadcast) {
    client.broadcast = async signed => {
      if (liveMode !== true) fail(`signer client for role "${role}" refuses to broadcast: liveMode is false`);
      requireSignerMutationAuthority(role, preflightAuthority);
      const result = await inner.broadcast(signed, { role });
      assertNoSecretLookingValue(result, `${role} broadcast() result`, { checkRawKeyShape: true });
      return result;
    };
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

function transactionPolicyApprovalContext({ family, policyDigest, approved, signed }) {
  const signedMessageDigest = `sha256:${createHash('sha256').update(decodedSignedMessageBytes(signed, family)).digest('hex')}`;
  const approvedSemanticsDigest = canonicalDigest(approved);
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
 */
export function wrapTransactionPolicySignerClient({ client, policy, rules, decodeOptions, broadcast }) {
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    fail('transaction policy signer requires a signer client');
  }
  const role = assertRole(client.role);
  const family = signerFamily(role);
  const trustedDecodeOptions = trustedTransactionDecodeOptions(family, decodeOptions);
  if (!ROLE_CAPABILITIES[role].broadcast || typeof client.sign !== 'function' || (broadcast === undefined && typeof client.broadcast !== 'function')) {
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
  const policyDigest = canonicalDigest(canonicalPolicy);
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
      const signed = signedEnvelope(await client.sign(requestSnapshot), family);
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
      const result = broadcast === undefined ? await client.broadcast(envelope) : await broadcast(envelope);
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
