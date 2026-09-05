import { createPublicKey, verify } from 'node:crypto';

import { canonicalJson, digest, RECOVERY_LIMITS } from './journal.mjs';
import { assertDigest, assertFixtureAction, assertPlainObject, assertProductionAction, sameCanonical } from './schemas.mjs';

const messageFields = ['schema', 'cycleId', 'actionKind', 'preflightDigest', 'operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount', 'principalAmount', 'minimumReceive', 'nativeGasAmount', 'provider', 'chain', 'domain', 'cluster', 'instructions', 'signers', 'feePayer', 'sourceAccount', 'inputAsset', 'outputAsset', 'mint', 'tokenAccount', 'destination', 'nftMint', 'nftCustodyAccount', 'amount', 'memo', 'validity', 'binding', 'bindingDigest', 'actionDigest', 'approvalKey'];
const wrapperFields = ['messageBytes', 'decoded'];
const hex = /^(?:[0-9a-f]{2})+$/;
const signedTransactionFields = ['schema', 'messageBytes', 'messageDigest', 'requiredSigners', 'signatures'];
const signatureFields = ['signer', 'signature'];
const fixtureSignerKeys = new Map([
  ['fixture-fee-payer', createPublicKey({ key: Buffer.from('302a300506032b657003210082479392a69b88c7ef15e6cf9c24837fce7199a814ea1dae479849dbc0ca23f7', 'hex'), format: 'der', type: 'spki' })],
]);

export function fixtureMessageForAction(actionValue, { actionDigest, bindingDigest, approvalKey }) {
  const action = assertFixtureAction(actionValue);
  assertDigest(actionDigest, 'fixture message action digest');
  assertDigest(bindingDigest, 'fixture message binding digest');
  assertDigest(approvalKey, 'fixture message approval key');
  return {
    schema: 'hookemon.fixture-message.v1',
    cycleId: action.cycleId,
    actionKind: action.actionKind,
    preflightDigest: action.preflightDigest,
    operationsTrigger: action.operationsTrigger,
    cycleVaultAccount: action.cycleVaultAccount,
    policyAccount: action.policyAccount,
    returnAccount: action.returnAccount,
    principalAmount: action.principalAmount,
    minimumReceive: action.minimumReceive,
    nativeGasAmount: action.nativeGasAmount,
    provider: action.provider,
    chain: action.chain,
    domain: action.domain,
    cluster: action.cluster,
    instructions: action.instructions,
    signers: action.signers,
    feePayer: action.feePayer,
    sourceAccount: action.sourceAccount,
    inputAsset: action.inputAsset,
    outputAsset: action.outputAsset,
    mint: action.mint,
    tokenAccount: action.tokenAccount,
    destination: action.destination,
    nftMint: action.nftMint,
    nftCustodyAccount: action.nftCustodyAccount,
    amount: action.amount,
    memo: action.memo,
    validity: action.validity,
    binding: action.binding,
    bindingDigest,
    actionDigest,
    approvalKey,
  };
}

export function assertDecodedFixtureMessage(message) {
  assertPlainObject(message, messageFields, 'fixture decoded message');
  if (message.schema !== 'hookemon.fixture-message.v1') throw new Error('fixture decoded message discriminator is invalid');
  const actionShape = {
    schema: 'hookemon.fixture-action.v1',
    cycleId: message.cycleId,
    actionKind: message.actionKind,
    preflightDigest: message.preflightDigest,
    operationsTrigger: message.operationsTrigger,
    cycleVaultAccount: message.cycleVaultAccount,
    policyAccount: message.policyAccount,
    returnAccount: message.returnAccount,
    principalAmount: message.principalAmount,
    minimumReceive: message.minimumReceive,
    nativeGasAmount: message.nativeGasAmount,
    provider: message.provider,
    chain: message.chain,
    domain: message.domain,
    cluster: message.cluster,
    instructions: message.instructions,
    signers: message.signers,
    feePayer: message.feePayer,
    sourceAccount: message.sourceAccount,
    inputAsset: message.inputAsset,
    outputAsset: message.outputAsset,
    mint: message.mint,
    tokenAccount: message.tokenAccount,
    destination: message.destination,
    nftMint: message.nftMint,
    nftCustodyAccount: message.nftCustodyAccount,
    amount: message.amount,
    memo: message.memo,
    validity: message.validity,
    binding: message.binding,
  };
  assertFixtureAction(actionShape);
  for (const field of ['bindingDigest', 'actionDigest', 'approvalKey']) assertDigest(message[field], `fixture decoded message ${field}`);
  return structuredClone(message);
}

export function encodeFixtureOnlyMessage(message) {
  const verified = assertDecodedFixtureMessage(message);
  return Buffer.from(canonicalJson(verified), 'utf8').toString('hex');
}

export function decodeFixtureOnlyMessage(messageBytes, wrapper) {
  if (typeof messageBytes === 'string' && messageBytes.length > RECOVERY_LIMITS.messageHexChars) throw new Error('fixture-only message byte limit exceeded');
  if (typeof messageBytes !== 'string' || !hex.test(messageBytes)) throw new Error('fixture-only message bytes are invalid');
  const text = Buffer.from(messageBytes, 'hex').toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('fixture-only message bytes are not canonical JSON'); }
  const decoded = assertDecodedFixtureMessage(parsed);
  if (Buffer.from(canonicalJson(decoded), 'utf8').toString('hex') !== messageBytes) throw new Error('fixture-only message bytes are noncanonical');
  if (wrapper !== undefined) {
    assertPlainObject(wrapper, wrapperFields, 'fixture message wrapper');
    if (wrapper.messageBytes !== messageBytes || !sameCanonical(wrapper.decoded, decoded)) throw new Error('fixture-only wrapper mismatch');
  }
  return decoded;
}

export function verifyDecodedTransaction(expected, decoded) {
  const expectedMessage = assertDecodedFixtureMessage(expected);
  const decodedMessage = assertDecodedFixtureMessage(decoded);
  if (!sameCanonical(expectedMessage, decodedMessage)) throw new Error('decoded transaction mismatch');
  return digest(decodedMessage);
}

export function verifyFixtureSignedTransaction(signedBytes, expected) {
  if (typeof signedBytes === 'string' && signedBytes.length > RECOVERY_LIMITS.signedHexChars) throw new Error('fixture signed transaction byte limit exceeded');
  if (typeof signedBytes !== 'string' || !hex.test(signedBytes)) throw new Error('fixture signed transaction bytes are invalid');
  assertPlainObject(expected, ['messageBytes', 'messageDigest', 'decoded'], 'fixture signed transaction expectation');
  const decoded = assertDecodedFixtureMessage(expected.decoded);
  const expectedMessageDigest = digest({ domain: 'hookemon.fixture-message.v1', message: decoded });
  if (expected.messageDigest !== expectedMessageDigest) throw new Error('fixture signed transaction expected message digest is invalid');
  if (encodeFixtureOnlyMessage(decoded) !== expected.messageBytes) throw new Error('fixture signed transaction expected message bytes are invalid');
  let envelope;
  try { envelope = JSON.parse(Buffer.from(signedBytes, 'hex').toString('utf8')); } catch { throw new Error('fixture signed transaction bytes are not canonical JSON'); }
  assertPlainObject(envelope, signedTransactionFields, 'fixture signed transaction');
  if (envelope.schema !== 'hookemon.fixture-signed-transaction.v1') throw new Error('fixture signed transaction discriminator is invalid');
  if (Buffer.from(canonicalJson(envelope), 'utf8').toString('hex') !== signedBytes) throw new Error('fixture signed transaction bytes are noncanonical');
  if (envelope.messageBytes !== expected.messageBytes || envelope.messageDigest !== expected.messageDigest) throw new Error('fixture signed transaction message binding mismatch');
  const requiredSigners = decoded.signers.map(signer => signer.address);
  if (!sameCanonical(envelope.requiredSigners, requiredSigners)) throw new Error('fixture signed transaction required signer set mismatch');
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== requiredSigners.length) throw new Error('fixture signed transaction signature set is incomplete');
  for (const [index, requiredSigner] of requiredSigners.entries()) {
    const signature = envelope.signatures[index];
    assertPlainObject(signature, signatureFields, 'fixture signed transaction signature');
    if (signature.signer !== requiredSigner) throw new Error('fixture signed transaction signer mismatch');
    if (typeof signature.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature.signature) || Buffer.from(signature.signature, 'base64url').toString('base64url') !== signature.signature) throw new Error('fixture signed transaction signature is invalid');
    const key = fixtureSignerKeys.get(requiredSigner);
    if (!key || !verify(null, Buffer.from(expected.messageBytes, 'hex'), key, Buffer.from(signature.signature, 'base64url'))) throw new Error('fixture signed transaction signature verification failed');
  }
  return { broadcastSignature: envelope.signatures[0].signature, envelope: structuredClone(envelope) };
}

// The DecodedMessage contract a real Solana/EVM decoder (packages/adapters, WP-10) must produce: the
// exact field shape assertDecodedFixtureMessage validates above, exported here so a production decoder
// (and its own tests) can conform to the same schema without importing the fixture-specific verifier.
// The reducer only ever consumes a decoded message that has already passed a validator over this shape
// — it never parses raw provider bytes itself (see reducer.mjs verifyDecode).
//
// WP-31 unpins the field-level *policy* a production decoded message must satisfy: instead of
// FIXTURE_ACTION_POLICY's one hardcoded literal transaction, assertProductionAction (schemas.mjs)
// validates a production action structurally (instructions/signers shape, validateCycleCustody,
// validateBinding — already policy-agnostic) and productionMessageForAction/decodeProductionMessage/
// verifyProductionSignedTransaction below apply that same policy to the decoded message, the signed
// envelope, and their signatures (verified through an injected signerRegistry, never a fixture key).
export const DECODED_MESSAGE_FIELDS = Object.freeze([...messageFields]);

export function assertDecodedMessageShape(message) {
  return assertPlainObject(message, DECODED_MESSAGE_FIELDS, 'decoded message');
}

// ---------------------------------------------------------------------------------------------------
// Production message/signing (WP-31): mirrors the fixture functions above field-for-field (same
// wrapper/envelope shapes, same canonical-encoding discipline) so decodeProductionMessage/
// verifyProductionSignedTransaction slot into the reducer exactly where their fixture counterparts do.
// The only difference is the trust boundary: a fixture message validates against
// assertFixtureAction/one hardcoded Ed25519 map (fixtureSignerKeys); a production message validates
// against assertProductionAction, and a production signature is verified through an injected
// `signerRegistry` — `{ verify(address, messageBytesHex, signatureBase64url) -> boolean }` — the local
// keychain-backed signer seam (coordinator decision D3). This module never reads or holds key material
// itself; it only calls the injected registry's verify function.
const productionMessageFields = messageFields;

export function productionMessageForAction(actionValue, { actionDigest, bindingDigest, approvalKey }) {
  const action = assertProductionAction(actionValue);
  assertDigest(actionDigest, 'production message action digest');
  assertDigest(bindingDigest, 'production message binding digest');
  assertDigest(approvalKey, 'production message approval key');
  return {
    schema: 'hookemon.production-message.v1',
    cycleId: action.cycleId,
    actionKind: action.actionKind,
    preflightDigest: action.preflightDigest,
    operationsTrigger: action.operationsTrigger,
    cycleVaultAccount: action.cycleVaultAccount,
    policyAccount: action.policyAccount,
    returnAccount: action.returnAccount,
    principalAmount: action.principalAmount,
    minimumReceive: action.minimumReceive,
    nativeGasAmount: action.nativeGasAmount,
    provider: action.provider,
    chain: action.chain,
    domain: action.domain,
    cluster: action.cluster,
    instructions: action.instructions,
    signers: action.signers,
    feePayer: action.feePayer,
    sourceAccount: action.sourceAccount,
    inputAsset: action.inputAsset,
    outputAsset: action.outputAsset,
    mint: action.mint,
    tokenAccount: action.tokenAccount,
    destination: action.destination,
    nftMint: action.nftMint,
    nftCustodyAccount: action.nftCustodyAccount,
    amount: action.amount,
    memo: action.memo,
    validity: action.validity,
    binding: action.binding,
    bindingDigest,
    actionDigest,
    approvalKey,
  };
}

export function assertDecodedProductionMessage(message) {
  assertPlainObject(message, productionMessageFields, 'production decoded message');
  if (message.schema !== 'hookemon.production-message.v1') throw new Error('production decoded message discriminator is invalid');
  const actionShape = {
    schema: 'hookemon.production-action.v1',
    cycleId: message.cycleId,
    actionKind: message.actionKind,
    preflightDigest: message.preflightDigest,
    operationsTrigger: message.operationsTrigger,
    cycleVaultAccount: message.cycleVaultAccount,
    policyAccount: message.policyAccount,
    returnAccount: message.returnAccount,
    principalAmount: message.principalAmount,
    minimumReceive: message.minimumReceive,
    nativeGasAmount: message.nativeGasAmount,
    provider: message.provider,
    chain: message.chain,
    domain: message.domain,
    cluster: message.cluster,
    instructions: message.instructions,
    signers: message.signers,
    feePayer: message.feePayer,
    sourceAccount: message.sourceAccount,
    inputAsset: message.inputAsset,
    outputAsset: message.outputAsset,
    mint: message.mint,
    tokenAccount: message.tokenAccount,
    destination: message.destination,
    nftMint: message.nftMint,
    nftCustodyAccount: message.nftCustodyAccount,
    amount: message.amount,
    memo: message.memo,
    validity: message.validity,
    binding: message.binding,
  };
  assertProductionAction(actionShape);
  for (const field of ['bindingDigest', 'actionDigest', 'approvalKey']) assertDigest(message[field], `production decoded message ${field}`);
  return structuredClone(message);
}

export function encodeProductionMessage(message) {
  const verified = assertDecodedProductionMessage(message);
  return Buffer.from(canonicalJson(verified), 'utf8').toString('hex');
}

export function decodeProductionMessage(messageBytes, wrapper) {
  if (typeof messageBytes === 'string' && messageBytes.length > RECOVERY_LIMITS.messageHexChars) throw new Error('production message byte limit exceeded');
  if (typeof messageBytes !== 'string' || !hex.test(messageBytes)) throw new Error('production message bytes are invalid');
  const text = Buffer.from(messageBytes, 'hex').toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('production message bytes are not canonical JSON'); }
  const decoded = assertDecodedProductionMessage(parsed);
  if (Buffer.from(canonicalJson(decoded), 'utf8').toString('hex') !== messageBytes) throw new Error('production message bytes are noncanonical');
  if (wrapper !== undefined) {
    assertPlainObject(wrapper, wrapperFields, 'production message wrapper');
    if (wrapper.messageBytes !== messageBytes || !sameCanonical(wrapper.decoded, decoded)) throw new Error('production wrapper mismatch');
  }
  return decoded;
}

export function verifyProductionSignedTransaction(signedBytes, expected, deps = {}) {
  const { signerRegistry } = deps;
  if (!signerRegistry || typeof signerRegistry.verify !== 'function') throw new Error('injected signer registry is required to verify a production signed transaction');
  if (typeof signedBytes === 'string' && signedBytes.length > RECOVERY_LIMITS.signedHexChars) throw new Error('production signed transaction byte limit exceeded');
  if (typeof signedBytes !== 'string' || !hex.test(signedBytes)) throw new Error('production signed transaction bytes are invalid');
  assertPlainObject(expected, ['messageBytes', 'messageDigest', 'decoded'], 'production signed transaction expectation');
  const decoded = assertDecodedProductionMessage(expected.decoded);
  const expectedMessageDigest = digest({ domain: 'hookemon.production-message.v1', message: decoded });
  if (expected.messageDigest !== expectedMessageDigest) throw new Error('production signed transaction expected message digest is invalid');
  if (encodeProductionMessage(decoded) !== expected.messageBytes) throw new Error('production signed transaction expected message bytes are invalid');
  let envelope;
  try { envelope = JSON.parse(Buffer.from(signedBytes, 'hex').toString('utf8')); } catch { throw new Error('production signed transaction bytes are not canonical JSON'); }
  assertPlainObject(envelope, signedTransactionFields, 'production signed transaction');
  if (envelope.schema !== 'hookemon.production-signed-transaction.v1') throw new Error('production signed transaction discriminator is invalid');
  if (Buffer.from(canonicalJson(envelope), 'utf8').toString('hex') !== signedBytes) throw new Error('production signed transaction bytes are noncanonical');
  if (envelope.messageBytes !== expected.messageBytes || envelope.messageDigest !== expected.messageDigest) throw new Error('production signed transaction message binding mismatch');
  const requiredSigners = decoded.signers.map(signer => signer.address);
  if (!sameCanonical(envelope.requiredSigners, requiredSigners)) throw new Error('production signed transaction required signer set mismatch');
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== requiredSigners.length) throw new Error('production signed transaction signature set is incomplete');
  for (const [index, requiredSigner] of requiredSigners.entries()) {
    const signature = envelope.signatures[index];
    assertPlainObject(signature, signatureFields, 'production signed transaction signature');
    if (signature.signer !== requiredSigner) throw new Error('production signed transaction signer mismatch');
    if (typeof signature.signature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(signature.signature) || Buffer.from(signature.signature, 'base64url').toString('base64url') !== signature.signature) throw new Error('production signed transaction signature is invalid');
    if (!signerRegistry.verify(requiredSigner, expected.messageBytes, signature.signature)) throw new Error('production signed transaction signature verification failed');
  }
  return { broadcastSignature: envelope.signatures[0].signature, envelope: structuredClone(envelope) };
}
