import { createHash } from 'node:crypto';

import { canonicalJson, digest } from '../cycle/journal.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
} from '../cycle/preflight.mjs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const prohibitedSecretFields = new Set(['privateKey', 'secretKey', 'mnemonic', 'seed', 'keypair']);
const policyFields = ['policyDigest', 'chain', 'allowedDestinations', 'allowedFunctions', 'allowedAssets', 'maxAmount'];
const intentFields = ['idempotencyKey', 'policyDigest', 'chain', 'destination', 'functionOrProgram', 'asset', 'amount', 'cap', 'unsignedTransaction', 'payloadDigest'];
const authorizationFields = ['intentDigest', 'nonce', 'authorizationDigest', 'expiresAt'];
const signedResultFields = ['signedBytes', 'authorizationDigest'];
const signedIdentityFields = ['transactionId', 'chain', 'destination', 'functionOrProgram', 'asset', 'amount'];
const checkpointFields = ['intentDigest', 'authorizationDigest', 'nonce', 'signedBytes', 'signedBytesDigest', ...signedIdentityFields, 'status'];
const chainReceiptFields = ['transactionId', 'status', 'finalized'];
const creditFields = ['asset', 'destination', 'amount'];
const reconciliationFields = ['intentDigest', 'signedBytesDigest', ...signedIdentityFields, 'status', 'finalized', 'chainReceipt', 'credit'];
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function requirePolicyWalletMutationAuthority(preflightAuthority) {
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('fixture policy-wallet mutation authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('fixture policy-wallet mutation test authority is invalid');
  return requireLiveMutationAuthority();
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) throw new Error(`${label} must use the exact schema`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
}

function parseAmount(value, label) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new Error(`${label} must be canonical`);
  const amount = BigInt(value);
  if (amount > (1n << 256n) - 1n) throw new Error(`${label} exceeds uint256`);
  return amount;
}

function assertUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) throw new Error(`${label} is invalid`);
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

function validatePolicy(policy, chainPrefix) {
  exactObject(policy, policyFields, 'wallet policy');
  canonicalJson(policy);
  assertDigest(policy.policyDigest, 'wallet policy digest');
  if (typeof policy.chain !== 'string' || !policy.chain.startsWith(chainPrefix)) throw new Error('wallet policy chain is invalid');
  assertUniqueStrings(policy.allowedDestinations, 'wallet policy destinations');
  assertUniqueStrings(policy.allowedFunctions, 'wallet policy functions');
  assertUniqueStrings(policy.allowedAssets, 'wallet policy assets');
  parseAmount(policy.maxAmount, 'wallet policy maxAmount');
  return structuredClone(policy);
}

function validateIntent(intent, policy) {
  exactObject(intent, intentFields, 'wallet intent');
  canonicalJson(intent);
  assertDigest(intent.policyDigest, 'wallet intent policy digest');
  if (intent.policyDigest !== policy.policyDigest) throw new Error('wallet intent policy digest mismatch');
  if (intent.chain !== policy.chain) throw new Error('wallet intent policy chain mismatch');
  if (!policy.allowedDestinations.includes(intent.destination)) throw new Error('wallet intent destination violates policy');
  if (!policy.allowedFunctions.includes(intent.functionOrProgram)) throw new Error('wallet intent function violates policy');
  if (!policy.allowedAssets.includes(intent.asset)) throw new Error('wallet intent asset violates policy');
  if (typeof intent.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/.test(intent.idempotencyKey)) throw new Error('wallet intent idempotency key is invalid');
  const amount = parseAmount(intent.amount, 'wallet intent amount');
  const cap = parseAmount(intent.cap, 'wallet intent cap');
  const policyCap = parseAmount(policy.maxAmount, 'wallet policy maxAmount');
  if (amount === 0n || amount > cap) throw new Error('wallet intent amount exceeds cap');
  if (cap > policyCap) throw new Error('wallet intent cap exceeds policy cap');
  if (typeof intent.unsignedTransaction !== 'string' || intent.unsignedTransaction.length === 0) throw new Error('wallet unsigned transaction is invalid');
  const bytes = Buffer.from(intent.unsignedTransaction, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== intent.unsignedTransaction) throw new Error('wallet unsigned transaction encoding is invalid');
  const payloadDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (intent.payloadDigest !== payloadDigest) throw new Error('wallet payload digest mismatch');
  return structuredClone(intent);
}

export function walletIntentDigest(intent) {
  return digest({ domain: 'hookemon.policy-wallet-intent.v1', intent });
}

export function walletAuthorizationDigest(authorization) {
  const { authorizationDigest, ...payload } = authorization ?? {};
  return digest({ domain: 'hookemon.policy-wallet-authorization.v1', payload });
}

function validateAuthorization(authorization, expectedIntentDigest) {
  exactObject(authorization, authorizationFields, 'wallet authorization');
  assertDigest(authorization.intentDigest, 'wallet authorization intent digest');
  assertDigest(authorization.authorizationDigest, 'wallet authorization digest');
  if (authorization.intentDigest !== expectedIntentDigest) throw new Error('wallet authorization intent mismatch');
  if (authorization.authorizationDigest !== walletAuthorizationDigest(authorization)) throw new Error('wallet authorization digest mismatch');
  if (typeof authorization.nonce !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(authorization.nonce)) throw new Error('wallet authorization nonce is invalid');
  if (typeof authorization.expiresAt !== 'string' || new Date(authorization.expiresAt).toISOString() !== authorization.expiresAt) throw new Error('wallet authorization expiry is invalid');
  if (Date.parse(authorization.expiresAt) <= Date.now()) throw new Error('wallet authorization is expired');
  return structuredClone(authorization);
}

function signedBytesDigest(signedBytes) {
  return `sha256:${createHash('sha256').update(Buffer.from(signedBytes, 'base64')).digest('hex')}`;
}

function validateSignedIdentity(identity, intent) {
  exactObject(identity, signedIdentityFields, 'signed transaction identity');
  if (typeof identity.transactionId !== 'string' || identity.transactionId.length === 0) throw new Error('signed transaction identity is invalid');
  if (identity.chain !== intent.chain || identity.destination !== intent.destination || identity.functionOrProgram !== intent.functionOrProgram || identity.asset !== intent.asset || identity.amount !== intent.amount) throw new Error('signed transaction identity does not match intent');
  return structuredClone(identity);
}

function identityFields(value) {
  return Object.fromEntries(signedIdentityFields.map(field => [field, value[field]]));
}

function validateCheckpoint(checkpoint, intent, authorization) {
  exactObject(checkpoint, checkpointFields, 'wallet signed-bytes checkpoint');
  if (checkpoint.intentDigest !== walletIntentDigest(intent) || checkpoint.authorizationDigest !== authorization.authorizationDigest || checkpoint.nonce !== authorization.nonce) throw new Error('wallet checkpoint authorization binding is invalid');
  if (typeof checkpoint.signedBytes !== 'string' || checkpoint.signedBytes.length === 0 || Buffer.from(checkpoint.signedBytes, 'base64').length === 0 || Buffer.from(checkpoint.signedBytes, 'base64').toString('base64') !== checkpoint.signedBytes) throw new Error('wallet checkpoint signed bytes are invalid');
  assertDigest(checkpoint.signedBytesDigest, 'wallet checkpoint signed-bytes digest');
  if (checkpoint.signedBytesDigest !== signedBytesDigest(checkpoint.signedBytes)) throw new Error('wallet checkpoint signed-bytes digest mismatch');
  validateSignedIdentity(identityFields(checkpoint), intent);
  if (!['SIGNED', 'BROADCAST'].includes(checkpoint.status)) throw new Error('wallet checkpoint status is invalid');
  return structuredClone(checkpoint);
}

function validateReconciliation(evidence, checkpoint, intent) {
  exactObject(evidence, reconciliationFields, 'wallet reconciliation evidence');
  if (evidence.intentDigest !== checkpoint.intentDigest || evidence.signedBytesDigest !== checkpoint.signedBytesDigest) throw new Error('wallet reconciliation digest mismatch');
  const identity = validateSignedIdentity(identityFields(evidence), intent);
  if (identity.transactionId !== checkpoint.transactionId) throw new Error('wallet reconciliation transaction mismatch');
  if (evidence.status !== 'SUCCESS' || evidence.finalized !== true) throw new Error('wallet reconciliation is not finalized success');
  exactObject(evidence.chainReceipt, chainReceiptFields, 'wallet chain receipt');
  if (evidence.chainReceipt.transactionId !== checkpoint.transactionId || evidence.chainReceipt.status !== 'SUCCESS' || evidence.chainReceipt.finalized !== true) throw new Error('wallet chain receipt is not bound to finalized success');
  exactObject(evidence.credit, creditFields, 'wallet credit evidence');
  if (evidence.credit.asset !== intent.asset || evidence.credit.destination !== intent.destination || evidence.credit.amount !== intent.amount) throw new Error('wallet credit evidence does not match intent');
  return { ...identity, intentDigest: evidence.intentDigest, signedBytesDigest: evidence.signedBytesDigest, status: evidence.status, finalized: evidence.finalized, chainReceipt: structuredClone(evidence.chainReceipt), credit: structuredClone(evidence.credit) };
}

class PolicyWallet {
  #checkpointStore;
  #observerClient;
  #policy;
  #preflightAuthority;
  #signedBytesVerifier;
  #signerClient;

  constructor(config, chainPrefix) {
    if (config && typeof config === 'object' && Object.keys(config).some(key => prohibitedSecretFields.has(key))) throw new Error('raw key configuration is forbidden');
    const fields = config && typeof config === 'object' && Object.hasOwn(config, 'preflightAuthority')
      ? ['policy', 'signerClient', 'observerClient', 'checkpointStore', 'signedBytesVerifier', 'preflightAuthority']
      : ['policy', 'signerClient', 'observerClient', 'checkpointStore', 'signedBytesVerifier'];
    exactObject(config, fields, 'policy wallet configuration');
    if (!config.signerClient || typeof config.signerClient.sign !== 'function' || typeof config.signerClient.broadcast !== 'function') throw new Error('staged remote signer client is invalid');
    if (!config.observerClient || typeof config.observerClient.reconcile !== 'function') throw new Error('transaction observer client is invalid');
    if (!config.checkpointStore || typeof config.checkpointStore.read !== 'function' || typeof config.checkpointStore.write !== 'function') throw new Error('wallet checkpoint store is invalid');
    if (typeof config.signedBytesVerifier !== 'function') throw new Error('signed-bytes verifier is invalid');
    this.#policy = validatePolicy(config.policy, chainPrefix);
    this.#signerClient = config.signerClient;
    this.#observerClient = config.observerClient;
    this.#checkpointStore = config.checkpointStore;
    this.#signedBytesVerifier = config.signedBytesVerifier;
    this.#preflightAuthority = config.preflightAuthority;
  }

  #boundIntent(intent) {
    const verified = validateIntent(intent, this.#policy);
    return { verified, intentDigest: walletIntentDigest(verified) };
  }

  async sign(intent, authorization) {
    const { verified, intentDigest: boundDigest } = this.#boundIntent(intent);
    const boundAuthorization = validateAuthorization(authorization, boundDigest);
    const existing = await this.#checkpointStore.read(boundDigest);
    if (existing) return validateCheckpoint(existing, verified, boundAuthorization);
    requirePolicyWalletMutationAuthority(this.#preflightAuthority);
    const result = await this.#signerClient.sign({ ...verified, intentDigest: boundDigest, authorizationDigest: boundAuthorization.authorizationDigest, nonce: boundAuthorization.nonce });
    exactObject(result, signedResultFields, 'signer response');
    if (result.authorizationDigest !== boundAuthorization.authorizationDigest) throw new Error('signer authorization digest mismatch');
    if (typeof result.signedBytes !== 'string' || result.signedBytes.length === 0 || Buffer.from(result.signedBytes, 'base64').toString('base64') !== result.signedBytes) throw new Error('signer signed bytes are invalid');
    const identity = validateSignedIdentity(await this.#signedBytesVerifier({ intent: verified, signedBytes: result.signedBytes }), verified);
    const checkpoint = validateCheckpoint({ intentDigest: boundDigest, authorizationDigest: boundAuthorization.authorizationDigest, nonce: boundAuthorization.nonce, signedBytes: result.signedBytes, signedBytesDigest: signedBytesDigest(result.signedBytes), ...identity, status: 'SIGNED' }, verified, boundAuthorization);
    await this.#checkpointStore.write(boundDigest, checkpoint);
    return checkpoint;
  }

  async broadcast(intent, authorization) {
    const { verified, intentDigest: boundDigest } = this.#boundIntent(intent);
    const boundAuthorization = validateAuthorization(authorization, boundDigest);
    const stored = await this.#checkpointStore.read(boundDigest);
    if (!stored) throw new Error('signed-bytes checkpoint is required before broadcast');
    const checkpoint = validateCheckpoint(stored, verified, boundAuthorization);
    if (checkpoint.status === 'BROADCAST') return checkpoint;
    requirePolicyWalletMutationAuthority(this.#preflightAuthority);
    const result = await this.#signerClient.broadcast({ ...checkpoint });
    exactObject(result, ['transactionId'], 'broadcast response');
    if (result.transactionId !== checkpoint.transactionId) throw new Error('broadcast transaction identity mismatch');
    const broadcasted = { ...checkpoint, status: 'BROADCAST' };
    await this.#checkpointStore.write(boundDigest, broadcasted);
    return broadcasted;
  }

  async reconcile(intent, authorization) {
    const { verified, intentDigest: boundDigest } = this.#boundIntent(intent);
    const boundAuthorization = validateAuthorization(authorization, boundDigest);
    const stored = await this.#checkpointStore.read(boundDigest);
    if (!stored) throw new Error('signed-bytes checkpoint is required before reconciliation');
    const checkpoint = validateCheckpoint(stored, verified, boundAuthorization);
    const evidence = await this.#observerClient.reconcile({ idempotencyKey: verified.idempotencyKey, intentDigest: boundDigest, authorizationDigest: boundAuthorization.authorizationDigest, nonce: boundAuthorization.nonce, signedBytesDigest: checkpoint.signedBytesDigest, transactionId: checkpoint.transactionId });
    if (evidence === null || evidence === undefined) throw new Error('reconciliation evidence is missing');
    return validateReconciliation(evidence, checkpoint, verified);
  }

  async signAndBroadcast(intent, authorization) {
    await this.sign(intent, authorization);
    return this.broadcast(intent, authorization);
  }
}

export class EvmPolicyWallet extends PolicyWallet {
  constructor(config) { super(config, 'eip155:'); }
}

export class SolanaPolicyWallet extends PolicyWallet {
  constructor(config) { super(config, 'solana:'); }
}
