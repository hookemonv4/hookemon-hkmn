import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { digest } from './journal.mjs';
import { assertDigest, assertPlainObject } from './schemas.mjs';

const rpcPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b6570032100d64a93bacc40d48ad76b9485eb78e2c0242d4ae1c7d31932cd1bcaeccd619f03', 'hex'),
  format: 'der',
  type: 'spki',
});
const fields = [
  'schema', 'authority', 'cycleId', 'actionDigest', 'messageDigest', 'signedBytesDigest', 'recentBlockhash',
  'observedHeight', 'lastValidHeight', 'finalized', 'verificationDigest', 'verificationSignature',
];
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const decimal = /^(?:0|[1-9][0-9]*)$/;
const hex = /^(?:[0-9a-f]{2})+$/;
const signature = /^[A-Za-z0-9_-]{86}$/;

function payload(value) {
  const evidence = assertPlainObject(value, fields, 'fixture blockhash validity evidence');
  const { verificationDigest, verificationSignature, ...unsigned } = evidence;
  return unsigned;
}

export function fixtureBlockhashValidityDigest(value) {
  return digest({
    domain: 'hookemon.fixture-blockhash-validity-verification.v1',
    authority: 'hookemon-fixture-rpc-verifier',
    payload: payload(value),
  });
}

export function verifyFixtureBlockhashValidity(value) {
  payload(value);
  if (
    value.schema !== 'hookemon.fixture-blockhash-validity.v1'
    || value.authority !== 'hookemon-fixture-rpc-verifier'
  ) throw new Error('fixture blockhash validity authority is invalid');
  if (typeof value.cycleId !== 'string' || !identifier.test(value.cycleId)) throw new Error('fixture blockhash validity cycle is invalid');
  for (const field of ['actionDigest', 'messageDigest', 'signedBytesDigest', 'verificationDigest']) {
    assertDigest(value[field], `fixture blockhash validity ${field}`);
  }
  if (typeof value.recentBlockhash !== 'string' || !hex.test(value.recentBlockhash)) throw new Error('fixture blockhash validity blockhash is invalid');
  if (typeof value.observedHeight !== 'string' || !decimal.test(value.observedHeight)) throw new Error('fixture blockhash validity observed height is invalid');
  if (typeof value.lastValidHeight !== 'string' || !decimal.test(value.lastValidHeight)) throw new Error('fixture blockhash validity last valid height is invalid');
  if (value.finalized !== true) throw new Error('fixture blockhash validity must be finalized');
  if (BigInt(value.observedHeight) > BigInt(value.lastValidHeight)) throw new Error('fixture blockhash validity is stale');
  if (
    typeof value.verificationSignature !== 'string'
    || !signature.test(value.verificationSignature)
    || Buffer.from(value.verificationSignature, 'base64url').toString('base64url') !== value.verificationSignature
  ) throw new Error('fixture blockhash validity signature is invalid');
  const expectedDigest = fixtureBlockhashValidityDigest(value);
  if (
    value.verificationDigest !== expectedDigest
    || !verifySignature(null, Buffer.from(expectedDigest, 'utf8'), rpcPublicKey, Buffer.from(value.verificationSignature, 'base64url'))
  ) throw new Error('fixture blockhash validity signature verification is invalid');
  return structuredClone(value);
}

// Production blockhash-validity (WP-31): identical structural shape, verified by asking the injected
// Solana RPC observer to independently confirm the same recentBlockhash/lastValidHeight window instead
// of trusting a bundled fixture-RPC signature.
const productionFields = ['schema', 'authority', 'cycleId', 'actionDigest', 'messageDigest', 'signedBytesDigest', 'recentBlockhash', 'observedHeight', 'lastValidHeight', 'finalized', 'observerConfirmationDigest'];

export function assertVerifiedProductionBlockhashValidity(value, deps = {}) {
  const evidence = assertPlainObject(value, productionFields, 'production blockhash validity evidence');
  if (evidence.schema !== 'hookemon.production-blockhash-validity.v1' || evidence.authority !== 'production-solana-rpc-observer') throw new Error('production blockhash validity authority is invalid');
  if (typeof evidence.cycleId !== 'string' || !identifier.test(evidence.cycleId)) throw new Error('production blockhash validity cycle is invalid');
  for (const field of ['actionDigest', 'messageDigest', 'signedBytesDigest']) assertDigest(evidence[field], `production blockhash validity ${field}`);
  if (typeof evidence.recentBlockhash !== 'string' || !hex.test(evidence.recentBlockhash)) throw new Error('production blockhash validity blockhash is invalid');
  if (typeof evidence.observedHeight !== 'string' || !decimal.test(evidence.observedHeight)) throw new Error('production blockhash validity observed height is invalid');
  if (typeof evidence.lastValidHeight !== 'string' || !decimal.test(evidence.lastValidHeight)) throw new Error('production blockhash validity last valid height is invalid');
  if (evidence.finalized !== true) throw new Error('production blockhash validity must be finalized');
  if (BigInt(evidence.observedHeight) > BigInt(evidence.lastValidHeight)) throw new Error('production blockhash validity is stale');
  assertDigest(evidence.observerConfirmationDigest, 'production blockhash validity observer confirmation digest');
  const { observers } = deps;
  if (!observers?.solana || typeof observers.solana.confirmBlockhashValidity !== 'function') throw new Error('injected Solana chain observer is required to verify production blockhash validity');
  const confirmation = observers.solana.confirmBlockhashValidity({ recentBlockhash: evidence.recentBlockhash, lastValidHeight: evidence.lastValidHeight, cycleId: evidence.cycleId, actionDigest: evidence.actionDigest });
  if (!confirmation || confirmation.finalized !== true || confirmation.recentBlockhash !== evidence.recentBlockhash || confirmation.lastValidHeight !== evidence.lastValidHeight || BigInt(confirmation.observedHeight ?? '-1') < BigInt(evidence.observedHeight)) throw new Error('production blockhash validity does not match the injected chain observer confirmation');
  if (digest({ domain: 'hookemon.production-blockhash-observer-confirmation.v1', confirmation }) !== evidence.observerConfirmationDigest) throw new Error('production blockhash validity observer confirmation digest mismatch');
  return structuredClone(evidence);
}
