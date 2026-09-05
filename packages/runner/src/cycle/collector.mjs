import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { validateBinding } from './bindings.mjs';
import { digest } from './journal.mjs';
import { assertDigest, assertPlainObject } from './schemas.mjs';

const ownerPublicKey = createPublicKey({ key: Buffer.from('302a300506032b657003210070b70676c75b964bbef8ec0a3bd5ab483aea0f28a4e07fb800f0bafe92ca34ca', 'hex'), format: 'der', type: 'spki' });
const transactionSignerPublicKey = createPublicKey({ key: Buffer.from('302a300506032b657003210082479392a69b88c7ef15e6cf9c24837fce7199a814ea1dae479849dbc0ca23f7', 'hex'), format: 'der', type: 'spki' });
const providerPublicKey = createPublicKey({ key: Buffer.from('302a300506032b65700321000378aa0da09b0890aeaf8c5a34a64834ce852dca35722fcafc12d0fcf1dddfd1', 'hex'), format: 'der', type: 'spki' });
const rpcPublicKey = createPublicKey({ key: Buffer.from('302a300506032b6570032100d64a93bacc40d48ad76b9485eb78e2c0242d4ae1c7d31932cd1bcaeccd619f03', 'hex'), format: 'der', type: 'spki' });
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const packCode = /^[a-z0-9][a-z0-9-]{1,63}$/;
const signature = /^[A-Za-z0-9_-]{86}$/;
const fixtureAuthorizationValidatedAt = '2029-01-01T00:00:00.000Z';

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`${label} is invalid`);
}

function assertSignature(value, label) {
  if (typeof value !== 'string' || !signature.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error(`${label} is invalid`);
}

function assertPackCode(value, label) {
  if (typeof value !== 'string' || !packCode.test(value)) throw new Error(`${label} is invalid`);
}

function assertExpiry(value, label) {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`);
}

export function assertFixtureCollectorRequest(value, action) {
  const fields = action === 'generate'
    ? ['schema', 'cycleId', 'pack', 'quantity', 'turbo', 'wallet', 'memo']
    : ['schema', 'cycleId', 'pack', 'quantity', 'turbo', 'wallet', 'prizeWallet', 'memo'];
  assertPlainObject(value, fields, `fixture Collector ${action} request`);
  if (value.schema !== `hookemon.fixture-collector-${action}-request.v1` || value.quantity !== 1 || value.turbo !== false) throw new Error(`fixture Collector ${action} request is invalid`);
  assertPackCode(value.pack, `fixture Collector ${action} request pack`);
  for (const field of action === 'generate' ? ['cycleId', 'wallet', 'memo'] : ['cycleId', 'wallet', 'prizeWallet', 'memo']) assertIdentifier(value[field], `fixture Collector ${action} request ${field}`);
  if (value.memo !== `${value.cycleId}:collector-${action}`) throw new Error(`fixture Collector ${action} request memo is invalid`);
  return structuredClone(value);
}

export function fixtureCollectorRequestDigest(request, action) {
  const verified = assertFixtureCollectorRequest(request, action);
  return digest({ domain: `hookemon.fixture-collector-${action}-request.v1`, request: verified });
}

export function assertFixtureCollectorMutationAuthorization(value) {
  assertPlainObject(value, ['schema', 'fixtureOwner', 'cycleId', 'action', 'requestDigest', 'pack', 'quantity', 'turbo', 'wallet', 'prizeWallet', 'memo', 'nonce', 'attempt', 'expiry', 'fixtureApprovalDigest', 'fixtureApprovalSignature'], 'fixture Collector mutation authorization');
  if (value.schema !== 'hookemon.fixture-collector-mutation-authorization.v1' || value.fixtureOwner !== 'fixture-owner' || !['generate', 'open'].includes(value.action) || value.quantity !== 1 || value.turbo !== false || !Number.isInteger(value.attempt) || value.attempt < 1) throw new Error('fixture Collector mutation authorization is invalid');
  assertPackCode(value.pack, 'fixture Collector mutation authorization pack');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'memo', 'nonce']) assertIdentifier(value[field], `fixture Collector mutation authorization ${field}`);
  assertDigest(value.requestDigest, 'fixture Collector mutation authorization request digest');
  assertDigest(value.fixtureApprovalDigest, 'fixture Collector mutation authorization digest');
  assertExpiry(value.expiry, 'fixture Collector mutation authorization expiry');
  if (Date.parse(fixtureAuthorizationValidatedAt) >= Date.parse(value.expiry)) throw new Error('fixture Collector mutation authorization is expired');
  assertSignature(value.fixtureApprovalSignature, 'fixture Collector mutation authorization signature');
  const expected = fixtureCollectorMutationAuthorizationDigest(value);
  if (value.fixtureApprovalDigest !== expected || !verifySignature(null, Buffer.from(expected, 'utf8'), ownerPublicKey, Buffer.from(value.fixtureApprovalSignature, 'base64url'))) throw new Error('fixture Collector mutation authorization signature verification is invalid');
  return structuredClone(value);
}

export function fixtureCollectorMutationAuthorizationDigest(value) {
  const { fixtureApprovalDigest, fixtureApprovalSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-collector-mutation-authorization.v1', fixtureOwner: 'fixture-owner', payload });
}

export function verifyFixtureCollectorMutationAuthorization(authorization, request, action, binding) {
  const approved = assertFixtureCollectorMutationAuthorization(authorization);
  const expectedRequest = assertFixtureCollectorRequest(request, action);
  const exactBinding = validateBinding(binding);
  if (approved.action !== action || approved.cycleId !== expectedRequest.cycleId || approved.requestDigest !== fixtureCollectorRequestDigest(expectedRequest, action) || approved.pack !== exactBinding.pack || approved.pack !== expectedRequest.pack || approved.quantity !== exactBinding.quantity || approved.quantity !== expectedRequest.quantity || approved.turbo !== exactBinding.turbo || approved.turbo !== expectedRequest.turbo || approved.wallet !== exactBinding.executionWallet || approved.wallet !== expectedRequest.wallet || approved.memo !== expectedRequest.memo || (action === 'open' && approved.prizeWallet !== expectedRequest.prizeWallet) || (action === 'generate' && approved.prizeWallet !== 'fixture-destination-purchase')) throw new Error('fixture Collector mutation authorization binding is invalid');
  return approved;
}

export function fixtureCollectorOpenExecutionDigest(value) {
  const { executionDigest, broadcastSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-collector-open-execution.v1', fixtureSigner: 'fixture-transaction-signer', payload });
}

export function assertVerifiedFixtureCollectorOpenExecution(value) {
  assertPlainObject(value, ['schema', 'cycleId', 'requestDigest', 'authorizationDigest', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'memo', 'executionDigest', 'broadcastSignature'], 'fixture Collector open execution');
  if (value.schema !== 'hookemon.fixture-collector-open-execution.v1') throw new Error('fixture Collector open execution is invalid');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'memo']) assertIdentifier(value[field], `fixture Collector open execution ${field}`);
  for (const field of ['requestDigest', 'authorizationDigest', 'executionDigest']) assertDigest(value[field], `fixture Collector open execution ${field}`);
  assertSignature(value.broadcastSignature, 'fixture Collector open execution broadcast signature');
  if (value.memo !== `${value.cycleId}:collector-open`) throw new Error('fixture Collector open execution memo is invalid');
  const expected = fixtureCollectorOpenExecutionDigest(value);
  if (value.executionDigest !== expected || !verifySignature(null, Buffer.from(expected, 'utf8'), transactionSignerPublicKey, Buffer.from(value.broadcastSignature, 'base64url'))) throw new Error('fixture Collector open execution signature verification is invalid');
  return structuredClone(value);
}

function providerDigest(domain, value) {
  const { fixtureVerificationDigest, fixtureVerificationSignature, ...payload } = value ?? {};
  return digest({ domain, fixtureProvider: 'fixture-provider', payload });
}

export function fixtureCollectorStatusDigest(value) { return providerDigest('hookemon.fixture-collector-status.v1', value); }

export function assertVerifiedFixtureCollectorStatus(value) {
  assertPlainObject(value, ['schema', 'cycleId', 'wallet', 'status', 'prizeWallet', 'pack', 'quantity', 'turbo', 'memo', 'packTokenMint', 'fixtureVerificationDigest', 'fixtureVerificationSignature'], 'fixture Collector status');
  if (value.schema !== 'hookemon.fixture-collector-status.v1' || value.status !== 'ready' || value.quantity !== 1 || value.turbo !== false) throw new Error('fixture Collector status is invalid');
  assertPackCode(value.pack, 'fixture Collector status pack');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'memo', 'packTokenMint']) assertIdentifier(value[field], `fixture Collector status ${field}`);
  assertDigest(value.fixtureVerificationDigest, 'fixture Collector status verification digest');
  assertSignature(value.fixtureVerificationSignature, 'fixture Collector status verification signature');
  const expected = fixtureCollectorStatusDigest(value);
  if (value.fixtureVerificationDigest !== expected || !verifySignature(null, Buffer.from(expected, 'utf8'), providerPublicKey, Buffer.from(value.fixtureVerificationSignature, 'base64url'))) throw new Error('fixture Collector status verification is invalid');
  return structuredClone(value);
}

export function fixtureCollectorOpenCustodyDigest(value) { return providerDigest('hookemon.fixture-collector-open-custody.v1', value); }

export function assertVerifiedFixtureCollectorOpenCustody(value) {
  assertPlainObject(value, ['schema', 'cycleId', 'requestDigest', 'authorizationDigest', 'openExecutionDigest', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'nftMint', 'nftCustodyAccount', 'broadcastSignature', 'blockHeight', 'blockHash', 'finalized', 'prePackBalance', 'postPackBalance', 'preNftBalance', 'postNftBalance', 'fixtureVerificationDigest', 'fixtureVerificationSignature'], 'fixture Collector open custody');
  if (value.schema !== 'hookemon.fixture-collector-open-custody.v1' || value.finalized !== true) throw new Error('fixture Collector open custody is not finalized');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'nftMint', 'nftCustodyAccount', 'blockHash']) assertIdentifier(value[field], `fixture Collector open custody ${field}`);
  for (const field of ['requestDigest', 'authorizationDigest', 'openExecutionDigest']) assertDigest(value[field], `fixture Collector open custody ${field}`);
  assertSignature(value.broadcastSignature, 'fixture Collector open custody broadcast signature');
  for (const field of ['blockHeight', 'prePackBalance', 'postPackBalance', 'preNftBalance', 'postNftBalance']) if (typeof value[field] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value[field])) throw new Error(`fixture Collector open custody ${field} is invalid`);
  if (BigInt(value.prePackBalance) - BigInt(value.postPackBalance) !== 1n || BigInt(value.postNftBalance) - BigInt(value.preNftBalance) !== 1n) throw new Error('fixture Collector open custody pack debit or NFT credit is invalid');
  assertDigest(value.fixtureVerificationDigest, 'fixture Collector open custody verification digest');
  assertSignature(value.fixtureVerificationSignature, 'fixture Collector open custody verification signature');
  const expected = fixtureCollectorOpenCustodyDigest(value);
  if (value.fixtureVerificationDigest !== expected || !verifySignature(null, Buffer.from(expected, 'utf8'), providerPublicKey, Buffer.from(value.fixtureVerificationSignature, 'base64url'))) throw new Error('fixture Collector open custody verification is invalid');
  return structuredClone(value);
}

export function fixtureCollectorRpcFinalityDigest(value) {
  const { fixtureRpcDigest, fixtureRpcSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-collector-rpc-finality.v1', fixtureRpc: 'fixture-rpc', payload });
}

export function assertVerifiedFixtureCollectorRpcFinality(value, custody) {
  assertPlainObject(value, ['schema', 'cycleId', 'broadcastSignature', 'providerCustodyDigest', 'blockHeight', 'blockHash', 'finalized', 'fixtureRpcDigest', 'fixtureRpcSignature'], 'fixture Collector RPC finality');
  if (value.schema !== 'hookemon.fixture-collector-rpc-finality.v1' || value.finalized !== true) throw new Error('fixture Collector RPC finality is invalid');
  for (const field of ['cycleId', 'blockHash']) assertIdentifier(value[field], `fixture Collector RPC finality ${field}`);
  if (typeof value.blockHeight !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value.blockHeight)) throw new Error('fixture Collector RPC finality block height is invalid');
  assertSignature(value.broadcastSignature, 'fixture Collector RPC finality broadcast signature');
  assertDigest(value.providerCustodyDigest, 'fixture Collector RPC finality custody digest');
  assertDigest(value.fixtureRpcDigest, 'fixture Collector RPC finality digest');
  assertSignature(value.fixtureRpcSignature, 'fixture Collector RPC finality signature');
  const verifiedCustody = assertVerifiedFixtureCollectorOpenCustody(custody);
  if (value.cycleId !== verifiedCustody.cycleId || value.broadcastSignature !== verifiedCustody.broadcastSignature || value.blockHeight !== verifiedCustody.blockHeight || value.blockHash !== verifiedCustody.blockHash || value.providerCustodyDigest !== digest({ domain: 'hookemon.fixture-collector-open-custody.v1', custody: verifiedCustody })) throw new Error('fixture Collector RPC finality custody binding is invalid');
  const expected = fixtureCollectorRpcFinalityDigest(value);
  if (value.fixtureRpcDigest !== expected || !verifySignature(null, Buffer.from(expected, 'utf8'), rpcPublicKey, Buffer.from(value.fixtureRpcSignature, 'base64url'))) throw new Error('fixture Collector RPC finality verification is invalid');
  return structuredClone(value);
}

// ---------------------------------------------------------------------------------------------------
// Production Collector Crypt evidence (WP-31). Same request/status/custody/rpc-finality shapes as the
// fixture functions above (a request itself carries no signature in either profile — see
// assertFixtureCollectorRequest); production status/custody/rpc-finality differ only in trust anchor:
// each is accepted once the injected Solana chain observer independently confirms it, never a bundled
// fixture-provider/fixture-rpc Ed25519 signature. Collector mutation authorization (generate/open) is
// intentionally NOT reimplemented here: production mutation authorizations for Collector actions are
// verified through the same injected StandingAuthorityProvider (authorization-provider.mjs) every other
// production step authorization uses — see evidence-profile.mjs's collector.verifyMutationAuthorization
// — rather than a second, Collector-specific standing-authority variant.

export function assertProductionCollectorRequest(value, action) {
  const fields = action === 'generate'
    ? ['schema', 'cycleId', 'pack', 'quantity', 'turbo', 'wallet', 'memo']
    : ['schema', 'cycleId', 'pack', 'quantity', 'turbo', 'wallet', 'prizeWallet', 'memo'];
  assertPlainObject(value, fields, `production Collector ${action} request`);
  if (value.schema !== `hookemon.production-collector-${action}-request.v1` || value.quantity !== 1 || value.turbo !== false) throw new Error(`production Collector ${action} request is invalid`);
  assertPackCode(value.pack, `production Collector ${action} request pack`);
  for (const field of action === 'generate' ? ['cycleId', 'wallet', 'memo'] : ['cycleId', 'wallet', 'prizeWallet', 'memo']) assertIdentifier(value[field], `production Collector ${action} request ${field}`);
  if (value.memo !== `${value.cycleId}:collector-${action}`) throw new Error(`production Collector ${action} request memo is invalid`);
  return structuredClone(value);
}

export function productionCollectorRequestDigest(request, action) {
  const verified = assertProductionCollectorRequest(request, action);
  return digest({ domain: `hookemon.production-collector-${action}-request.v1`, request: verified });
}

export function productionCollectorOpenExecutionDigest(value) {
  const { executionDigest, broadcastSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.production-collector-open-execution.v1', payload });
}

export function assertVerifiedProductionCollectorOpenExecution(value, deps = {}) {
  assertPlainObject(value, ['schema', 'cycleId', 'requestDigest', 'authorizationDigest', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'memo', 'executionDigest', 'broadcastSignature'], 'production Collector open execution');
  if (value.schema !== 'hookemon.production-collector-open-execution.v1') throw new Error('production Collector open execution is invalid');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'memo']) assertIdentifier(value[field], `production Collector open execution ${field}`);
  for (const field of ['requestDigest', 'authorizationDigest', 'executionDigest']) assertDigest(value[field], `production Collector open execution ${field}`);
  assertSignature(value.broadcastSignature, 'production Collector open execution broadcast signature');
  if (value.memo !== `${value.cycleId}:collector-open`) throw new Error('production Collector open execution memo is invalid');
  const expected = productionCollectorOpenExecutionDigest(value);
  if (value.executionDigest !== expected) throw new Error('production Collector open execution digest is invalid');
  const { signerRegistry } = deps;
  if (!signerRegistry || typeof signerRegistry.verifyDigest !== 'function') throw new Error('injected signer registry is required to verify a production Collector open execution');
  if (!signerRegistry.verifyDigest(value.wallet, expected, value.broadcastSignature)) throw new Error('production Collector open execution signature verification is invalid');
  return structuredClone(value);
}

export function assertVerifiedProductionCollectorStatus(value, deps = {}) {
  assertPlainObject(value, ['schema', 'cycleId', 'wallet', 'status', 'prizeWallet', 'pack', 'quantity', 'turbo', 'memo', 'packTokenMint', 'apiResponseDigest'], 'production Collector status');
  if (value.schema !== 'hookemon.production-collector-status.v1' || value.status !== 'ready' || value.quantity !== 1 || value.turbo !== false) throw new Error('production Collector status is invalid');
  assertPackCode(value.pack, 'production Collector status pack');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'memo', 'packTokenMint']) assertIdentifier(value[field], `production Collector status ${field}`);
  assertDigest(value.apiResponseDigest, 'production Collector status API response digest');
  const observer = deps.observers?.solana;
  if (!observer || typeof observer.confirmPackStatus !== 'function') throw new Error('injected Solana chain observer is required to verify production Collector status');
  const confirmation = observer.confirmPackStatus({ cycleId: value.cycleId, wallet: value.wallet, pack: value.pack });
  if (!confirmation || confirmation.status !== 'ready' || confirmation.packTokenMint !== value.packTokenMint) throw new Error('production Collector status does not match the injected chain observer confirmation');
  return structuredClone(value);
}

export function assertVerifiedProductionCollectorOpenCustody(value, deps = {}) {
  assertPlainObject(value, ['schema', 'cycleId', 'requestDigest', 'authorizationDigest', 'openExecutionDigest', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'nftMint', 'nftCustodyAccount', 'broadcastSignature', 'blockHeight', 'blockHash', 'finalized', 'prePackBalance', 'postPackBalance', 'preNftBalance', 'postNftBalance'], 'production Collector open custody');
  if (value.schema !== 'hookemon.production-collector-open-custody.v1' || value.finalized !== true) throw new Error('production Collector open custody is not finalized');
  for (const field of ['cycleId', 'wallet', 'prizeWallet', 'packTokenMint', 'packTokenAccount', 'nftMint', 'nftCustodyAccount', 'blockHash']) assertIdentifier(value[field], `production Collector open custody ${field}`);
  for (const field of ['requestDigest', 'authorizationDigest', 'openExecutionDigest']) assertDigest(value[field], `production Collector open custody ${field}`);
  assertSignature(value.broadcastSignature, 'production Collector open custody broadcast signature');
  for (const field of ['blockHeight', 'prePackBalance', 'postPackBalance', 'preNftBalance', 'postNftBalance']) if (typeof value[field] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value[field])) throw new Error(`production Collector open custody ${field} is invalid`);
  if (BigInt(value.prePackBalance) - BigInt(value.postPackBalance) !== 1n || BigInt(value.postNftBalance) - BigInt(value.preNftBalance) !== 1n) throw new Error('production Collector open custody pack debit or NFT credit is invalid');
  const observer = deps.observers?.solana;
  if (!observer || typeof observer.confirmOpenCustody !== 'function') throw new Error('injected Solana chain observer is required to verify production Collector open custody');
  // The card mint the pack actually minted is read from the observer's own post-open-transaction token
  // balances, never trusted as a caller-supplied literal (design requirement: "the open evidence yields
  // the card mint address from post token balances").
  const confirmation = observer.confirmOpenCustody({ broadcastSignature: value.broadcastSignature, wallet: value.wallet, packTokenAccount: value.packTokenAccount });
  if (
    !confirmation
    || confirmation.finalized !== true
    || confirmation.blockHeight !== value.blockHeight
    || confirmation.blockHash !== value.blockHash
    || confirmation.mintedCardMint !== value.nftMint
  ) throw new Error('production Collector open custody does not match the injected chain observer confirmation');
  return structuredClone(value);
}

export function assertVerifiedProductionCollectorRpcFinality(value, custody, deps = {}) {
  assertPlainObject(value, ['schema', 'cycleId', 'broadcastSignature', 'providerCustodyDigest', 'blockHeight', 'blockHash', 'finalized'], 'production Collector RPC finality');
  if (value.schema !== 'hookemon.production-collector-rpc-finality.v1' || value.finalized !== true) throw new Error('production Collector RPC finality is invalid');
  for (const field of ['cycleId', 'blockHash']) assertIdentifier(value[field], `production Collector RPC finality ${field}`);
  if (typeof value.blockHeight !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value.blockHeight)) throw new Error('production Collector RPC finality block height is invalid');
  assertSignature(value.broadcastSignature, 'production Collector RPC finality broadcast signature');
  assertDigest(value.providerCustodyDigest, 'production Collector RPC finality custody digest');
  const verifiedCustody = assertVerifiedProductionCollectorOpenCustody(custody, deps);
  if (value.cycleId !== verifiedCustody.cycleId || value.broadcastSignature !== verifiedCustody.broadcastSignature || value.blockHeight !== verifiedCustody.blockHeight || value.blockHash !== verifiedCustody.blockHash || value.providerCustodyDigest !== digest({ domain: 'hookemon.production-collector-open-custody.v1', custody: verifiedCustody })) throw new Error('production Collector RPC finality custody binding is invalid');
  return structuredClone(value);
}
