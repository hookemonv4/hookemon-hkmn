import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson, digest } from './journal.mjs';
import { assertMoneyConfiguration } from './money-schemas.mjs';
import { assertDigest, assertPlainObject } from './schemas.mjs';
import { validateCycleCustody } from './bindings.mjs';

const releasePublicKey = createPublicKey({
  key: Buffer.from('302a300506032b657003210071baabb4aa3e2cd612676012956410c89fa9fb3823c3d9f46d04bdd6a1a96b93', 'hex'),
  format: 'der',
  type: 'spki',
});
const ownerPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b657003210070b70676c75b964bbef8ec0a3bd5ab483aea0f28a4e07fb800f0bafe92ca34ca', 'hex'),
  format: 'der',
  type: 'spki',
});
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const decimal = /^(?:0|[1-9][0-9]*)$/;
const positiveDecimal = /^(?:[1-9][0-9]*)$/;
const signature = /^[A-Za-z0-9_-]{80,128}$/;
const evmAddress = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${'0'.repeat(40)}`;

const activeInterfacesPath = new URL('../../../../architecture/interfaces.json', import.meta.url);
const testBindingManifest = JSON.parse(
  readFileSync(new URL('../../../../bindings/robinhood-chain.json', import.meta.url), 'utf8'),
);
const TEST_PROFILE_REQUIREMENTS_REVISION = 57;

function requireTestProfileBindingManifestDigest(value) {
  if (
    !['hookemon.robinhood-binding.v1', 'hookemon.robinhood-binding.v2'].includes(value?.schemaVersion)
    || value.productPhase !== 1
    || value.requirementsRevision !== 54
    || value.architectureRevision !== 3
    || value.bindingMode !== 'BUILD_ONLY_FAIL_CLOSED'
  ) throw new Error('test binding record is invalid');
  return assertDigest(value.manifestDigest, 'test binding manifest digest');
}

export const TEST_PROFILE_BINDING_MANIFEST_DIGEST = requireTestProfileBindingManifestDigest(testBindingManifest);
export const FIXTURE_BINDING_MANIFEST_DIGEST = TEST_PROFILE_BINDING_MANIFEST_DIGEST;

const TEST_PROFILE_MUTATION_AUTHORITY = Object.freeze({
  productPhase: 2,
  requirementsRevision: TEST_PROFILE_REQUIREMENTS_REVISION,
  architectureRevision: 5,
  bindingManifestDigest: TEST_PROFILE_BINDING_MANIFEST_DIGEST,
});

function assertMutationAuthority(value, label) {
  if (
    !value
    || !Number.isInteger(value.productPhase) || value.productPhase < 1
    || !Number.isInteger(value.requirementsRevision) || value.requirementsRevision < 1
    || !Number.isInteger(value.architectureRevision) || value.architectureRevision < 1
  ) throw new Error(`${label} is invalid`);
  return Object.freeze({
    productPhase: value.productPhase,
    requirementsRevision: value.requirementsRevision,
    architectureRevision: value.architectureRevision,
    bindingManifestDigest: assertDigest(value.bindingManifestDigest, `${label} binding manifest digest`),
  });
}

export function createTestProfileMutationAuthority() {
  return TEST_PROFILE_MUTATION_AUTHORITY;
}

function assertLiveMutationAuthority(activeInterfaces) {
  if (
    activeInterfaces?.schemaVersion !== 'hookemon.interfaces.v1'
    || !Number.isInteger(activeInterfaces.productPhase) || activeInterfaces.productPhase < 1
    || !Number.isInteger(activeInterfaces.requirementsRevision) || activeInterfaces.requirementsRevision < 1
    || !Number.isInteger(activeInterfaces.architectureRevision) || activeInterfaces.architectureRevision < 1
    || activeInterfaces.status !== 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING'
  ) throw new Error('active frozen interface authority is invalid');
  return assertMutationAuthority(activeInterfaces, 'active frozen interface authority');
}

export function requireLiveMutationAuthority() {
  return assertLiveMutationAuthority(JSON.parse(readFileSync(activeInterfacesPath, 'utf8')));
}

/**
 * The current Phase 3 interface explicitly excludes the retained vault/escrow/Merkle family.
 * This deliberately has no success case: a future architecture must add a distinct admitted
 * runtime path instead of making a generic frozen authority reactivate retained custody code.
 */
export function assertRetainedCustodyMutationAuthority(activeInterfaces) {
  assertLiveMutationAuthority(activeInterfaces);
  if (
    activeInterfaces?.productPhase === 3
    && activeInterfaces?.freezeRules?.legacyCustodyFamily === 'FROZEN_NOT_DEPLOYED'
    && activeInterfaces?.phaseBoundary?.legacyCustodyFamilyDeployment === 'FORBIDDEN'
  ) throw new Error('retained custody mutation is forbidden by the active Phase 3 interface authority');
  throw new Error('retained custody mutation requires a separately approved runtime interface');
}

export function requireLiveRetainedCustodyMutationAuthority() {
  return assertRetainedCustodyMutationAuthority(JSON.parse(readFileSync(activeInterfacesPath, 'utf8')));
}

export function requireLiveBindingManifestDigest() {
  return requireLiveMutationAuthority().bindingManifestDigest;
}

function requireProductionPreflightAuthority(deps) {
  if (!deps?.preflightAuthority) throw new Error('production cycle preflight authority must be explicitly supplied for read-only verification');
  return assertMutationAuthority(
    deps.preflightAuthority,
    'production cycle preflight authority',
  );
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`${label} is invalid`);
}

function readDecimal(value, label, positive = false) {
  if (typeof value !== 'string' || !(positive ? positiveDecimal : decimal).test(value)) throw new Error(`${label} must be a canonical unsigned integer`);
  return BigInt(value);
}

function verifyEd25519(value, digestValue, publicKey, label) {
  if (typeof value !== 'string' || !signature.test(value) || !verifySignature(null, Buffer.from(digestValue, 'utf8'), publicKey, Buffer.from(value, 'base64url'))) {
    throw new Error(`${label} signature verification is invalid`);
  }
}

export function fixtureCycleReleaseVerificationDigest(value) {
  const { verificationDigest, verificationSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-cycle-release-verification.v1', payload });
}

export function fixtureCyclePreflightDigest(value) {
  const { preflightDigest, ownerAuthorizationSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-cycle-preflight.v1', fixtureOwner: 'fixture-owner', payload });
}

function verifyFixtureCycleRelease(value) {
  const fields = [
    'schema', 'authority', 'requirementsRevision', 'chainId', 'cycleId', 'operationsTrigger',
    'cycleVaultAccount', 'asset', 'amount', 'transactionId',
    'blockNumber', 'blockHash', 'finalized', 'verificationDigest', 'verificationSignature',
  ];
  const release = assertPlainObject(value, fields, 'fixture cycle release evidence');
  if (release.schema !== 'hookemon.fixture-cycle-release.v1' || release.authority !== 'hookemon-fixture-release-verifier') throw new Error('fixture cycle release authority is invalid');
  if (release.requirementsRevision !== TEST_PROFILE_REQUIREMENTS_REVISION || release.chainId !== '4663' || release.asset !== 'USDG' || release.finalized !== true) throw new Error('fixture cycle release revision, chain, asset, or finality is invalid');
  assertIdentifier(release.cycleId, 'fixture cycle release cycle');
  assertIdentifier(release.operationsTrigger, 'fixture cycle release Operations trigger');
  assertIdentifier(release.cycleVaultAccount, 'fixture cycle release vault account');
  if (release.operationsTrigger === release.cycleVaultAccount) throw new Error('fixture cycle release cannot give Operations custody');
  readDecimal(release.amount, 'fixture cycle release amount', true);
  readDecimal(release.blockNumber, 'fixture cycle release block number', true);
  assertDigest(release.transactionId, 'fixture cycle release transaction');
  assertDigest(release.blockHash, 'fixture cycle release block hash');
  if (release.transactionId === `sha256:${'0'.repeat(64)}` || release.blockHash === `sha256:${'0'.repeat(64)}`) throw new Error('fixture cycle release transaction and block must be nonzero');
  assertDigest(release.verificationDigest, 'fixture cycle release verification digest');
  const expectedDigest = fixtureCycleReleaseVerificationDigest(release);
  if (release.verificationDigest !== expectedDigest) throw new Error('fixture cycle release verification digest mismatch');
  verifyEd25519(release.verificationSignature, expectedDigest, releasePublicKey, 'fixture cycle release');
  return structuredClone(release);
}

export function verifyFixtureCyclePreflight(value) {
  const fields = [
    'schema', 'fixtureOwner', 'requirementsRevision', 'cycleId', 'operationsTrigger', 'cycleVaultAccount',
    'policyAccount', 'returnAccount', 'hook', 'usdg', 'authorizationNonce', 'authorizationExpiresAt',
    'minimumRobinhoodReceive', 'releasedAmount', 'totalPrincipal', 'spendCap',
    'nativeGasCaps', 'minimumReceives', 'bindingManifestDigest', 'releaseEvidence', 'preflightDigest',
    'ownerAuthorizationSignature',
  ];
  const preflight = assertPlainObject(value, fields, 'fixture cycle spend preflight');
  if (preflight.schema !== 'hookemon.fixture-cycle-preflight.v1' || preflight.fixtureOwner !== 'fixture-owner' || preflight.requirementsRevision !== TEST_PROFILE_REQUIREMENTS_REVISION) throw new Error('fixture cycle spend preflight identity or revision is invalid');
  assertIdentifier(preflight.cycleId, 'fixture cycle spend preflight cycle');
  const custody = validateCycleCustody({
    operationsTrigger: preflight.operationsTrigger,
    cycleVaultAccount: preflight.cycleVaultAccount,
    policyAccount: preflight.policyAccount,
    returnAccount: preflight.returnAccount,
  });
  for (const field of ['operationsTrigger', 'cycleVaultAccount', 'returnAccount', 'hook', 'usdg']) {
    if (!evmAddress.test(preflight[field]) || preflight[field] === zeroAddress) throw new Error(`fixture cycle spend preflight ${field} must be a canonical nonzero EVM address`);
  }
  if (new Set([preflight.operationsTrigger, preflight.cycleVaultAccount, preflight.returnAccount, preflight.hook, preflight.usdg]).size !== 5) throw new Error('fixture cycle spend preflight EVM identities must be distinct');
  readDecimal(preflight.authorizationNonce, 'fixture funding authorization nonce', true);
  if (
    typeof preflight.authorizationExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(preflight.authorizationExpiresAt))
    || new Date(preflight.authorizationExpiresAt).toISOString() !== preflight.authorizationExpiresAt
  ) throw new Error('fixture funding authorization expiry must be a canonical UTC timestamp');
  readDecimal(preflight.minimumRobinhoodReceive, 'fixture Robinhood minimum receive', true);
  const releasedAmount = readDecimal(preflight.releasedAmount, 'fixture released amount', true);
  const totalPrincipal = readDecimal(preflight.totalPrincipal, 'fixture total principal', true);
  const spendCap = readDecimal(preflight.spendCap, 'fixture spend cap', true);
  if (totalPrincipal !== releasedAmount || totalPrincipal > spendCap) throw new Error('fixture total principal must equal the entire released amount and remain within the spend cap');
  assertPlainObject(preflight.nativeGasCaps, ['robinhood', 'solana'], 'fixture native gas caps');
  for (const [chain, cap] of Object.entries(preflight.nativeGasCaps)) readDecimal(cap, `fixture ${chain} native gas cap`);
  assertPlainObject(preflight.minimumReceives, ['outbound', 'purchase', 'buyback', 'return'], 'fixture minimum receives');
  for (const [actionKind, amount] of Object.entries(preflight.minimumReceives)) readDecimal(amount, `fixture ${actionKind} minimum receive`, true);
  assertDigest(preflight.bindingManifestDigest, 'fixture binding manifest digest');
  if (preflight.bindingManifestDigest !== FIXTURE_BINDING_MANIFEST_DIGEST) throw new Error('fixture binding manifest digest does not match the test binding authority');
  const release = verifyFixtureCycleRelease(preflight.releaseEvidence);
  if (
    release.cycleId !== preflight.cycleId
    || release.requirementsRevision !== preflight.requirementsRevision
    || release.operationsTrigger !== custody.operationsTrigger
    || release.cycleVaultAccount !== custody.cycleVaultAccount
    || release.amount !== preflight.releasedAmount
  ) throw new Error('fixture spend preflight does not match released-cycle evidence');
  assertDigest(preflight.preflightDigest, 'fixture cycle spend preflight digest');
  const expectedDigest = fixtureCyclePreflightDigest(preflight);
  if (preflight.preflightDigest !== expectedDigest) throw new Error('fixture cycle spend preflight digest mismatch');
  verifyEd25519(preflight.ownerAuthorizationSignature, expectedDigest, ownerPublicKey, 'fixture cycle spend preflight owner authorization');
  canonicalJson(preflight);
  return structuredClone(preflight);
}

// ---------------------------------------------------------------------------------------------------
// Production cycle preflight and release evidence (WP-31). Same structural shape and same custody/
// digest invariants as the fixture functions above. Read-only verification requires an explicitly
// supplied authority and never reads the active live mutation authority at module load or profile
// construction. The explicit test profile injects the retained historical authority and has no live
// signing or broadcast effect. Two things differ from
// the fixture path: (1) the released-funds evidence is accepted only once the injected Robinhood chain
// (EVM) observer independently confirms the same release, never a bundled fixture-release-verifier
// signature; (2) the preflight's spending authority is the injected, already owner-signed standing
// authority document (authorization-provider.mjs, coordinator decision D3/D4) checked against its own
// per-cycle spend cap and allowed destinations, rather than one more fixture-owner signature on the
// preflight object itself — a standing authority is deliberately a ceiling that covers many cycles, not
// a per-cycle re-authorization.
const productionReleaseFields = ['schema', 'authority', 'requirementsRevision', 'chainId', 'cycleId', 'operationsTrigger', 'cycleVaultAccount', 'asset', 'amount', 'transactionId', 'blockNumber', 'blockHash', 'finalized'];
const productionPreflightFields = [
  'schema', 'requirementsRevision', 'cycleId', 'operationsTrigger', 'cycleVaultAccount',
  'policyAccount', 'returnAccount', 'hook', 'usdg', 'authorizationNonce', 'authorizationExpiresAt',
  'moneyConfiguration', 'releasedAmount', 'totalPrincipal', 'spendCap',
  'bindingManifestDigest', 'releaseEvidence', 'preflightDigest',
];
const productionPreflightProjectionFields = [
  ...productionPreflightFields,
  'minimumRobinhoodReceive', 'nativeGasCaps', 'minimumReceives',
];

function productionPreflightHasProjection(value) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, 'minimumRobinhoodReceive');
}

function productionPreflightWireValue(value) {
  const { minimumRobinhoodReceive, nativeGasCaps, minimumReceives, ...wire } = value ?? {};
  return wire;
}

export function productionCyclePreflightDigest(value) {
  const { preflightDigest, ...payload } = productionPreflightWireValue(value);
  return digest({ domain: 'hookemon.production-cycle-preflight.v1', payload });
}

export function verifyProductionCycleRelease(value, deps = {}) {
  const authority = requireProductionPreflightAuthority(deps);
  const release = assertPlainObject(value, productionReleaseFields, 'production cycle release evidence');
  if (release.schema !== 'hookemon.production-cycle-release.v1' || release.authority !== 'production-robinhood-rpc-observer') throw new Error('production cycle release authority is invalid');
  if (release.requirementsRevision !== authority.requirementsRevision || release.chainId !== '4663' || release.asset !== 'USDG' || release.finalized !== true) throw new Error('production cycle release revision, chain, asset, or finality is invalid');
  assertIdentifier(release.cycleId, 'production cycle release cycle');
  assertIdentifier(release.operationsTrigger, 'production cycle release Operations trigger');
  assertIdentifier(release.cycleVaultAccount, 'production cycle release vault account');
  if (release.operationsTrigger === release.cycleVaultAccount) throw new Error('production cycle release cannot give Operations custody');
  readDecimal(release.amount, 'production cycle release amount', true);
  readDecimal(release.blockNumber, 'production cycle release block number', true);
  assertDigest(release.transactionId, 'production cycle release transaction');
  assertDigest(release.blockHash, 'production cycle release block hash');
  if (release.transactionId === `sha256:${'0'.repeat(64)}` || release.blockHash === `sha256:${'0'.repeat(64)}`) throw new Error('production cycle release transaction and block must be nonzero');
  const observer = deps.observers?.evm;
  if (!observer || typeof observer.confirmRelease !== 'function') throw new Error('injected Robinhood chain observer is required to verify a production cycle release');
  const confirmation = observer.confirmRelease({ cycleId: release.cycleId, operationsTrigger: release.operationsTrigger, cycleVaultAccount: release.cycleVaultAccount });
  if (
    !confirmation
    || confirmation.finalized !== true
    || confirmation.amount !== release.amount
    || confirmation.transactionId !== release.transactionId
    || confirmation.blockNumber !== release.blockNumber
    || confirmation.blockHash !== release.blockHash
  ) throw new Error('production cycle release does not match the injected chain observer confirmation');
  return structuredClone(release);
}

function requireProductionMoneyConfiguration(value, label) {
  let money;
  try {
    money = assertMoneyConfiguration(value, label);
  } catch (error) {
    throw new Error(`${label} must be a valid MoneyConfigurationV1: ${error.message}`);
  }
  if (money.assets.usdg.chainId !== '4663' || money.assets.usdg.decimals !== 6) {
    throw new Error(`${label} USDG asset must use chain 4663 with six decimals`);
  }
  if (money.assets.solanaStablecoin.chainId !== '792703809' || money.assets.solanaStablecoin.decimals !== 6) {
    throw new Error(`${label} Solana stablecoin asset must use chain 792703809 with six decimals`);
  }
  return money;
}

function sameMoneyConfiguration(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function productionPreflightProjection(money) {
  return Object.freeze({
    minimumRobinhoodReceive: money.minimums.robinhoodReceive.amountAtomic,
    nativeGasCaps: Object.freeze({
      robinhood: money.evm.perTransactionGasPriceCap.amountAtomic,
      solana: money.solana.priorityFeeCap.amountAtomic,
    }),
    minimumReceives: Object.freeze({
      outbound: money.minimums.solanaReceive.amountAtomic,
      purchase: money.minimums.solanaReceive.amountAtomic,
      buyback: money.minimums.solanaReceive.amountAtomic,
      return: money.minimums.returnUsdg.amountAtomic,
    }),
  });
}

export function verifyProductionCyclePreflight(value, deps = {}) {
  const authority = requireProductionPreflightAuthority(deps);
  const includesProjection = productionPreflightHasProjection(value);
  const preflight = assertPlainObject(
    value,
    includesProjection ? productionPreflightProjectionFields : productionPreflightFields,
    'production cycle spend preflight',
  );
  if (preflight.schema !== 'hookemon.production-cycle-preflight.v1' || preflight.requirementsRevision !== authority.requirementsRevision) throw new Error('production cycle spend preflight identity or revision is invalid');
  assertIdentifier(preflight.cycleId, 'production cycle spend preflight cycle');
  const custody = validateCycleCustody({
    operationsTrigger: preflight.operationsTrigger,
    cycleVaultAccount: preflight.cycleVaultAccount,
    policyAccount: preflight.policyAccount,
    returnAccount: preflight.returnAccount,
  });
  for (const field of ['operationsTrigger', 'cycleVaultAccount', 'returnAccount', 'hook', 'usdg']) {
    if (!evmAddress.test(preflight[field]) || preflight[field] === zeroAddress) throw new Error(`production cycle spend preflight ${field} must be a canonical nonzero EVM address`);
  }
  if (new Set([preflight.operationsTrigger, preflight.cycleVaultAccount, preflight.returnAccount, preflight.hook, preflight.usdg]).size !== 5) throw new Error('production cycle spend preflight EVM identities must be distinct');
  readDecimal(preflight.authorizationNonce, 'production funding authorization nonce', true);
  if (
    typeof preflight.authorizationExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(preflight.authorizationExpiresAt))
    || new Date(preflight.authorizationExpiresAt).toISOString() !== preflight.authorizationExpiresAt
  ) throw new Error('production funding authorization expiry must be a canonical UTC timestamp');
  const money = requireProductionMoneyConfiguration(preflight.moneyConfiguration, 'production cycle preflight money configuration');
  const configuredMoney = requireProductionMoneyConfiguration(deps.moneyConfiguration, 'production evidence profile money configuration');
  if (!sameMoneyConfiguration(money, configuredMoney)) {
    throw new Error('production cycle preflight MoneyConfigurationV1 does not match the evidence profile configuration');
  }
  if (money.assets.usdg.assetId.toLowerCase() !== preflight.usdg.toLowerCase()) {
    throw new Error('production cycle preflight USDG account does not match MoneyConfigurationV1');
  }
  const releasedAmount = readDecimal(preflight.releasedAmount, 'production released amount', true);
  const totalPrincipal = readDecimal(preflight.totalPrincipal, 'production total principal', true);
  const spendCap = readDecimal(preflight.spendCap, 'production spend cap', true);
  if (totalPrincipal !== releasedAmount || totalPrincipal > spendCap) throw new Error('production total principal must equal the entire released amount and remain within the spend cap');
  assertDigest(preflight.bindingManifestDigest, 'production binding manifest digest');
  if (preflight.bindingManifestDigest !== authority.bindingManifestDigest) throw new Error('production binding manifest digest does not match the preflight authority');
  const release = verifyProductionCycleRelease(preflight.releaseEvidence, { ...deps, preflightAuthority: authority });
  if (
    release.cycleId !== preflight.cycleId
    || release.requirementsRevision !== preflight.requirementsRevision
    || release.operationsTrigger !== custody.operationsTrigger
    || release.cycleVaultAccount !== custody.cycleVaultAccount
    || release.amount !== preflight.releasedAmount
  ) throw new Error('production spend preflight does not match released-cycle evidence');
  assertDigest(preflight.preflightDigest, 'production cycle spend preflight digest');
  const expectedDigest = productionCyclePreflightDigest(preflight);
  if (preflight.preflightDigest !== expectedDigest) throw new Error('production cycle spend preflight digest mismatch');
  const { standingAuthority } = deps;
  if (!standingAuthority || typeof standingAuthority.perCycleSpendCap !== 'string' || !Array.isArray(standingAuthority.allowedDestinations)) throw new Error('injected verified standing authority document is required to verify a production cycle preflight');
  if (totalPrincipal > BigInt(standingAuthority.perCycleSpendCap)) throw new Error('production cycle preflight exceeds the standing authority per-cycle spend cap');
  if (!standingAuthority.allowedDestinations.includes(preflight.policyAccount)) throw new Error('production cycle preflight policy account is outside the standing authority allowed destinations');
  const projection = productionPreflightProjection(money);
  if (includesProjection && !sameMoneyConfiguration(
    {
      minimumRobinhoodReceive: preflight.minimumRobinhoodReceive,
      nativeGasCaps: preflight.nativeGasCaps,
      minimumReceives: preflight.minimumReceives,
    },
    projection,
  )) {
    throw new Error('production cycle spend preflight scalar projection does not match the MoneyConfigurationV1 projection');
  }
  canonicalJson(preflight);
  return structuredClone({ ...productionPreflightWireValue(preflight), ...projection });
}
