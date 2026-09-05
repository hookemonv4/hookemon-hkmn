import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { digest, RECOVERY_LIMITS } from './journal.mjs';
import { assertDigest, assertPlainObject, assertTransactionSignatureLike } from './schemas.mjs';

const accountingPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b657003210070dbd84e3e437e7e5667fc84c4250aa58e45969ddf79444494f253e1b593a2f1', 'hex'),
  format: 'der',
  type: 'spki',
});
const actionKinds = new Set(['outbound', 'purchase', 'buyback', 'return']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const decimal = /^(?:0|[1-9][0-9]*)$/;
const positiveDecimal = /^(?:[1-9][0-9]*)$/;
const signature = /^[A-Za-z0-9_-]{80,128}$/;
const blockHash = /^(?:[0-9a-f]{2})+$/;
const evidenceFields = [
  'schema', 'authority', 'cycleId', 'actionKind', 'actionDigest', 'receiptDigest', 'transactionSignature',
  'blockHeight', 'blockHash', 'finalized', 'nativeGas', 'sourceActivity', 'accountActivity', 'verificationDigest',
  'verificationSignature',
];
const buybackEvidenceFields = [...evidenceFields, 'nftDestinationActivity'];
const gasFields = ['account', 'asset', 'preBalance', 'postBalance', 'actualDebit', 'transactionFee'];
const activityFields = [
  'account', 'asset', 'fromBlockHeight', 'fromBlockHash', 'toBlockHeight', 'toBlockHash',
  'openingBalance', 'closingBalance', 'finalized', 'movements',
];
const movementFields = ['transactionSignature', 'receiptDigest', 'blockHeight', 'blockHash', 'direction', 'asset', 'amount'];

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`${label} is invalid`);
}

function readDecimal(value, label, positive = false) {
  if (typeof value !== 'string' || !(positive ? positiveDecimal : decimal).test(value)) throw new Error(`${label} must be a canonical unsigned integer`);
  return BigInt(value);
}

function assertSignature(value, label) {
  if (typeof value !== 'string' || !signature.test(value)) throw new Error(`${label} is invalid`);
}

function assertBlockHash(value, label) {
  if (typeof value !== 'string' || !blockHash.test(value)) throw new Error(`${label} is invalid`);
}

function accountingPayload(value) {
  const actionKind = Object.getOwnPropertyDescriptor(value ?? {}, 'actionKind')?.value;
  if (actionKind === 'buyback' && !Object.hasOwn(value, 'nftDestinationActivity')) throw new Error('fixture buyback NFT destination activity evidence is required');
  const evidence = assertPlainObject(value, actionKind === 'buyback' ? buybackEvidenceFields : evidenceFields, 'fixture execution accounting evidence');
  const { verificationDigest, verificationSignature, ...payload } = evidence;
  return payload;
}

export function fixtureExecutionAccountingDigest(value) {
  return digest({
    domain: 'hookemon.fixture-execution-accounting-verification.v1',
    authority: 'hookemon-fixture-accounting-verifier',
    payload: accountingPayload(value),
  });
}

function verifyNativeGas(value) {
  const gas = assertPlainObject(value, gasFields, 'fixture actual native-gas evidence');
  assertIdentifier(gas.account, 'fixture native-gas account');
  if (gas.asset !== 'SOL') throw new Error('fixture native-gas asset is invalid');
  const preBalance = readDecimal(gas.preBalance, 'fixture native-gas pre-balance', true);
  const postBalance = readDecimal(gas.postBalance, 'fixture native-gas post-balance');
  const actualDebit = readDecimal(gas.actualDebit, 'fixture actual native-gas debit', true);
  const transactionFee = readDecimal(gas.transactionFee, 'fixture native-gas transaction fee', true);
  if (preBalance - postBalance !== actualDebit || actualDebit !== transactionFee) throw new Error('fixture actual native-gas debit does not reconcile to the verified transaction fee');
  return structuredClone(gas);
}

function verifyAccountActivity(value, label) {
  const movements = Object.getOwnPropertyDescriptor(value ?? {}, 'movements')?.value;
  if (Array.isArray(movements) && movements.length > RECOVERY_LIMITS.activityMovements) throw new Error(`fixture ${label} activity movement count limit exceeded`);
  const activity = assertPlainObject(value, activityFields, `fixture finalized ${label} activity window`);
  assertIdentifier(activity.account, `fixture ${label} activity account`);
  assertIdentifier(activity.asset, `fixture ${label} activity asset`);
  const fromBlockHeight = readDecimal(activity.fromBlockHeight, `fixture ${label} activity from-block`, true);
  const toBlockHeight = readDecimal(activity.toBlockHeight, `fixture ${label} activity to-block`, true);
  if (fromBlockHeight >= toBlockHeight) throw new Error(`fixture ${label} activity window is invalid`);
  assertBlockHash(activity.fromBlockHash, `fixture ${label} activity from-block hash`);
  assertBlockHash(activity.toBlockHash, `fixture ${label} activity to-block hash`);
  readDecimal(activity.openingBalance, `fixture ${label} activity opening balance`);
  readDecimal(activity.closingBalance, `fixture ${label} activity closing balance`);
  if (activity.finalized !== true || !Array.isArray(activity.movements) || activity.movements.length === 0) throw new Error(`fixture finalized ${label} activity movements are invalid`);
  for (const movement of activity.movements) {
    assertPlainObject(movement, movementFields, `fixture ${label} activity movement`);
    assertSignature(movement.transactionSignature, `fixture ${label} activity transaction signature`);
    assertDigest(movement.receiptDigest, `fixture ${label} activity receipt digest`);
    const movementHeight = readDecimal(movement.blockHeight, `fixture ${label} activity movement block height`, true);
    if (movementHeight < fromBlockHeight || movementHeight > toBlockHeight) throw new Error(`fixture ${label} activity movement is outside the finalized window`);
    assertBlockHash(movement.blockHash, `fixture ${label} activity movement block hash`);
    if (movement.direction !== 'credit' && movement.direction !== 'debit') throw new Error(`fixture ${label} activity movement direction is invalid`);
    if (movement.asset !== activity.asset) throw new Error(`fixture ${label} activity movement asset is invalid`);
    readDecimal(movement.amount, `fixture ${label} activity movement amount`, true);
  }
  return structuredClone(activity);
}

export function verifyFixtureExecutionAccounting(value) {
  accountingPayload(value);
  if (value.schema !== 'hookemon.fixture-execution-accounting.v1' || value.authority !== 'hookemon-fixture-accounting-verifier') throw new Error('fixture execution accounting authority is invalid');
  assertIdentifier(value.cycleId, 'fixture execution accounting cycle');
  if (!actionKinds.has(value.actionKind)) throw new Error('fixture execution accounting action kind is invalid');
  assertDigest(value.actionDigest, 'fixture execution accounting action digest');
  assertDigest(value.receiptDigest, 'fixture execution accounting receipt digest');
  assertSignature(value.transactionSignature, 'fixture execution accounting transaction signature');
  readDecimal(value.blockHeight, 'fixture execution accounting block height', true);
  assertBlockHash(value.blockHash, 'fixture execution accounting block hash');
  if (value.finalized !== true) throw new Error('fixture execution accounting must be finalized');
  verifyNativeGas(value.nativeGas);
  const sourceActivity = verifyAccountActivity(value.sourceActivity, 'source custody');
  const nftDestinationActivity = value.actionKind === 'buyback'
    ? verifyAccountActivity(value.nftDestinationActivity, 'buyback NFT destination custody')
    : null;
  const activity = verifyAccountActivity(value.accountActivity, 'destination account');
  if (sourceActivity.toBlockHeight !== value.blockHeight || sourceActivity.toBlockHash !== value.blockHash) throw new Error('fixture source custody activity window does not bind the finalized execution block');
  if (nftDestinationActivity && (nftDestinationActivity.toBlockHeight !== value.blockHeight || nftDestinationActivity.toBlockHash !== value.blockHash)) throw new Error('fixture buyback NFT destination custody window does not bind the finalized execution block');
  if (activity.toBlockHeight !== value.blockHeight || activity.toBlockHash !== value.blockHash) throw new Error('fixture destination account activity window does not bind the finalized execution block');
  assertDigest(value.verificationDigest, 'fixture execution accounting verification digest');
  const expectedDigest = fixtureExecutionAccountingDigest(value);
  if (value.verificationDigest !== expectedDigest) throw new Error('fixture execution accounting verification digest mismatch');
  assertSignature(value.verificationSignature, 'fixture execution accounting verification signature');
  if (!verifySignature(null, Buffer.from(expectedDigest, 'utf8'), accountingPublicKey, Buffer.from(value.verificationSignature, 'base64url'))) throw new Error('fixture execution accounting signature verification is invalid');
  return structuredClone(value);
}

// Production execution accounting (WP-31): identical field shape and identical structural checks
// (verifyNativeGas/verifyAccountActivity above are already provider-agnostic and are reused unchanged);
// the only difference is the trust anchor — a production accounting record is accepted once the
// injected chain observer independently reports the same account activity windows, never a bundled
// fixture-accounting-verifier signature.
function productionAccountingPayload(value) {
  const actionKind = Object.getOwnPropertyDescriptor(value ?? {}, 'actionKind')?.value;
  if (actionKind === 'buyback' && !Object.hasOwn(value, 'nftDestinationActivity')) throw new Error('production buyback NFT destination activity evidence is required');
  const evidence = assertPlainObject(value, actionKind === 'buyback' ? buybackEvidenceFields : evidenceFields, 'production execution accounting evidence');
  const { verificationDigest, verificationSignature, ...payload } = evidence;
  return payload;
}

export function productionExecutionAccountingDigest(value) {
  return digest({
    domain: 'hookemon.production-execution-accounting-verification.v1',
    authority: 'production-chain-observer',
    payload: productionAccountingPayload(value),
  });
}

export function assertVerifiedProductionExecutionAccounting(value, deps = {}) {
  productionAccountingPayload(value);
  if (value.schema !== 'hookemon.production-execution-accounting.v1' || value.authority !== 'production-chain-observer') throw new Error('production execution accounting authority is invalid');
  assertIdentifier(value.cycleId, 'production execution accounting cycle');
  if (!actionKinds.has(value.actionKind)) throw new Error('production execution accounting action kind is invalid');
  assertDigest(value.actionDigest, 'production execution accounting action digest');
  assertDigest(value.receiptDigest, 'production execution accounting receipt digest');
  assertTransactionSignatureLike(value.transactionSignature, 'production execution accounting transaction signature');
  readDecimal(value.blockHeight, 'production execution accounting block height', true);
  assertBlockHash(value.blockHash, 'production execution accounting block hash');
  if (value.finalized !== true) throw new Error('production execution accounting must be finalized');
  verifyNativeGas(value.nativeGas);
  const sourceActivity = verifyAccountActivity(value.sourceActivity, 'source custody');
  const nftDestinationActivity = value.actionKind === 'buyback'
    ? verifyAccountActivity(value.nftDestinationActivity, 'buyback NFT destination custody')
    : null;
  const activity = verifyAccountActivity(value.accountActivity, 'destination account');
  if (sourceActivity.toBlockHeight !== value.blockHeight || sourceActivity.toBlockHash !== value.blockHash) throw new Error('production source custody activity window does not bind the finalized execution block');
  if (nftDestinationActivity && (nftDestinationActivity.toBlockHeight !== value.blockHeight || nftDestinationActivity.toBlockHash !== value.blockHash)) throw new Error('production buyback NFT destination custody window does not bind the finalized execution block');
  if (activity.toBlockHeight !== value.blockHeight || activity.toBlockHash !== value.blockHash) throw new Error('production destination account activity window does not bind the finalized execution block');
  assertDigest(value.verificationDigest, 'production execution accounting verification digest');
  const expectedDigest = productionExecutionAccountingDigest(value);
  if (value.verificationDigest !== expectedDigest) throw new Error('production execution accounting verification digest mismatch');
  const { observers } = deps;
  const observerKey = value.actionKind === 'purchase' || value.actionKind === 'buyback' ? 'solana' : 'evm';
  const observer = observers?.[observerKey];
  if (!observer || typeof observer.confirmAccountActivity !== 'function') throw new Error(`injected ${observerKey} chain observer is required to verify production execution accounting`);
  const confirmation = observer.confirmAccountActivity({ cycleId: value.cycleId, actionKind: value.actionKind, actionDigest: value.actionDigest, receiptDigest: value.receiptDigest, transactionSignature: value.transactionSignature });
  if (
    !confirmation
    || confirmation.finalized !== true
    || !sameCanonicalActivity(confirmation.sourceActivity, sourceActivity)
    || !sameCanonicalActivity(confirmation.accountActivity, activity)
    || (nftDestinationActivity && !sameCanonicalActivity(confirmation.nftDestinationActivity, nftDestinationActivity))
  ) throw new Error('production execution accounting does not match the injected chain observer confirmation');
  return structuredClone(value);
}

function sameCanonicalActivity(left, right) {
  return digest(left ?? null) === digest(right ?? null);
}
