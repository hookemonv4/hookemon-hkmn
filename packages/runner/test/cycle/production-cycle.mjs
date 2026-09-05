// Production-profile cycle fixture (WP-31): the production-evidence mirror of fixture-cycle.mjs's
// executeCompleteFixtureCycle — drives the exact same eight-stage CycleRunner sequence, but every piece
// of evidence is verified through evidence-profile.mjs's production profile (chain-observer
// confirmation, an injected signer registry, and a StandingAuthorityProvider) instead of a fixture
// Ed25519 signature. No key from fixture-crypto.mjs is imported or used anywhere in this file.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createStandingAuthorityProvider,
  publicKeyFingerprint,
  standingAuthorityDocumentDigest,
  stepAuthorizationIntentDigest,
} from '../../src/cycle/authorization-provider.mjs';
import { createTestProductionEvidenceProfile } from '../../src/cycle/evidence-profile.mjs';
import { canonicalJson, digest } from '../../src/cycle/journal.mjs';
import {
  productionCollectorOpenExecutionDigest,
  productionCollectorRequestDigest,
} from '../../src/cycle/collector.mjs';
import {
  encodeProductionMessage,
  productionMessageForAction,
} from '../../src/cycle/decoder.mjs';
import { TEST_PROFILE_BINDING_MANIFEST_DIGEST } from '../../src/cycle/preflight.mjs';
import { BRIDGE_CHAIN_IDS, PRODUCTION_PROVIDERS, fixtureActionChainIdentity, productionActionDigests } from '../../src/cycle/schemas.mjs';
import { createCycleDraft, createFrozenCycleControl, freezeCycleDraft } from '../../src/operator/cycle-plan.mjs';
import { createPackSnapshot } from '../../src/operator/pack-selection.mjs';
import { createFakeEvmObserver, createFakeSolanaObserver, createSignerRegistry } from './production-crypto.mjs';

// WP-34: the real, currently-deployed USDG contract address on Robinhood Chain (chain id 4663) — read
// live from the frozen `bindings/robinhood-chain.json` (never re-typed as a literal here, so a re-freeze
// of that binding takes effect without a source edit). The vault and hook are not deployed yet
// (`bindings/robinhood-chain.json`'s `market.poolKey.status` is `INTEGRATION_PENDING`, `hook: null`), so
// `cycleVaultAccount`/`hook` below stay synthetic test addresses — there is no real one to pin.
const robinhoodBinding = JSON.parse(readFileSync(new URL('../../../../bindings/robinhood-chain.json', import.meta.url), 'utf8'));

const circleDollarMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const operationsTrigger = '0x0000000000000000000000000000000000009001';
const cycleVaultAccount = '0x0000000000000000000000000000000000009002';
const returnAccount = '0x0000000000000000000000000000000000009003';
const hook = '0x0000000000000000000000000000000000009004';
const usdg = robinhoodBinding.contracts.usdg.address.toLowerCase();
const policyAccount = 'ProductionPolicyWallet01';
const purchaseDestination = 'ProductionPurchaseDest1';
const feePayer = 'ProductionFeePayer1';
const collectorSigner = policyAccount; // the same wallet signs its own Collector open execution

export function productionMoneyConfiguration(overrides = {}) {
  const configuration = {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: usdg, decimals: 6 },
      solanaStablecoin: { chainId: '792703809', assetId: circleDollarMint, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: usdg, decimals: 6, amountAtomic: '19' },
      solanaReceive: { chainId: '792703809', assetId: circleDollarMint, decimals: 6, amountAtomic: '10' },
      returnUsdg: { chainId: '4663', assetId: usdg, decimals: 6, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '100' },
    },
  };
  return {
    ...configuration,
    ...overrides,
    assets: { ...configuration.assets, ...(overrides.assets ?? {}) },
    minimums: { ...configuration.minimums, ...(overrides.minimums ?? {}) },
    evm: { ...configuration.evm, ...(overrides.evm ?? {}) },
    solana: { ...configuration.solana, ...(overrides.solana ?? {}) },
  };
}

export const productionBinding = Object.freeze({
  sourceChainId: 4663, executionCluster: 'mainnet-beta', circleDollarMint, circleDollarDecimals: 6,
  pack: 'collector-nova', quantity: 1, turbo: false, executionWallet: policyAccount,
  refundTokenAccount: 'ProductionRefundAccount1', refundTokenAccountOwner: policyAccount,
});

const programIds = Object.freeze({
  outbound: 'RelayBridgeContractV1',
  purchase: 'CollectorCryptGachaProgramV1',
  buyback: 'CollectorCryptGachaProgramV1',
  return: 'RelayBridgeContractV1',
});

const ownerKeys = generateKeyPairSync('ed25519');
const policyKeys = generateKeyPairSync('ed25519');
const { registry: signerRegistry, signHex, signDigest } = createSignerRegistry([feePayer, collectorSigner]);

function signedDoc(unsigned, digestFn, digestField, signatureField, privateKey) {
  const withDigest = { ...unsigned, [digestField]: digestFn(unsigned) };
  const signatureBuffer = sign(null, Buffer.from(withDigest[digestField], 'utf8'), privateKey);
  return { ...withDigest, [signatureField]: signatureBuffer.toString('base64url') };
}

export function buildStandingAuthority({ allowedDestinations, perCycleSpendCap = '10000', issuedAt = '2026-01-01T00:00:00.000Z', expiresAt = '2099-01-01T00:00:00.000Z' }) {
  return signedDoc({
    schema: 'hookemon.standing-authority-document.v1',
    owner: 'production-owner',
    policyPublicKeyFingerprint: publicKeyFingerprint(policyKeys.publicKey),
    perCycleSpendCap,
    maxCyclesPerDay: 72,
    allowedPacks: [productionBinding.pack],
    allowedDestinations,
    issuedAt,
    expiresAt,
    documentId: 'standing-authority-production-test',
  }, standingAuthorityDocumentDigest, 'documentDigest', 'ownerSignature', ownerKeys.privateKey);
}

let stepNonceCounter = 0;
function stepAuthorization({ standingAuthorityDigest, cycleId, actionKind, authorizationKind, subjectDigest, destination, pack, spendAmount, nonce, issuedAt = '2026-01-02T00:00:00.000Z' }) {
  stepNonceCounter += 1;
  const unsigned = {
    schema: 'hookemon.standing-authority-step-intent.v1',
    standingAuthorityDigest,
    cycleId,
    actionKind,
    authorizationKind,
    subjectDigest,
    destination,
    pack,
    spendAmount,
    nonce: nonce ?? `production-step-nonce-${stepNonceCounter}`,
    issuedAt,
  };
  const intentDigest = stepAuthorizationIntentDigest(unsigned);
  const policySignature = sign(null, Buffer.from(intentDigest, 'utf8'), policyKeys.privateKey).toString('base64url');
  return { ...unsigned, policySignature };
}

// Exported (WP-31) so packages/runner/test/integration/production-cycle.test.mjs can build and sign
// arbitrary, deliberately-adversarial standing-authority step intents (e.g. a reused nonce, or an
// `issuedAt` chosen to probe the replay-time-binding fix in authorization-provider.mjs's
// stepAuthorizationNow) against the exact same fixture without reaching into this module's private
// policy key.
export function buildAndSignStepAuthorization(fixture, { cycleId, actionKind, authorizationKind, subjectDigest, destination, pack, spendAmount, nonce, issuedAt }) {
  return stepAuthorization({
    standingAuthorityDigest: fixture.standingAuthority.documentDigest,
    cycleId, actionKind, authorizationKind, subjectDigest, destination, pack, spendAmount, nonce,
    ...(issuedAt === undefined ? {} : { issuedAt }),
  });
}

// `standingAuthorityIssuedAt`/`standingAuthorityExpiresAt` (WP-31) let a test build a fixture whose
// standing authority's own validity window is deliberately already in the past relative to the real
// wall clock — see production-cycle.test.mjs's replay-after-expiry regression test — without disturbing
// every other call site's default 2026-2099 window.
export function createProductionTestFixture({ standingAuthorityIssuedAt, standingAuthorityExpiresAt, moneyConfiguration = productionMoneyConfiguration() } = {}) {
  const solanaObserver = createFakeSolanaObserver();
  const evmObserver = createFakeEvmObserver();
  const allowedDestinations = [policyAccount, purchaseDestination, productionBinding.refundTokenAccount, returnAccount];
  const standingAuthority = buildStandingAuthority({
    allowedDestinations,
    ...(standingAuthorityIssuedAt === undefined ? {} : { issuedAt: standingAuthorityIssuedAt }),
    ...(standingAuthorityExpiresAt === undefined ? {} : { expiresAt: standingAuthorityExpiresAt }),
  });
  const standingAuthorityProvider = createStandingAuthorityProvider({
    standingAuthority,
    ownerPublicKey: ownerKeys.publicKey,
    policyPublicKey: policyKeys.publicKey,
  });
  const evidenceProfile = createTestProductionEvidenceProfile({
    observers: { solana: solanaObserver, evm: evmObserver },
    signerRegistry,
    standingAuthorityProvider,
    standingAuthorityDocument: standingAuthority,
    moneyConfiguration,
    programIds,
    purchaseDestination,
  });
  return { solanaObserver, evmObserver, standingAuthority, standingAuthorityProvider, moneyConfiguration, evidenceProfile };
}

function stepAuth(fixture, cycleId, actionKind, authorizationKind, subjectDigest, destination, pack, spendAmount) {
  return stepAuthorization({
    standingAuthorityDigest: fixture.standingAuthority.documentDigest,
    cycleId, actionKind, authorizationKind, subjectDigest, destination, pack, spendAmount,
  });
}

function releaseEvidence(cycleId, evmObserver) {
  const confirmation = { finalized: true, amount: '10', transactionId: digest({ domain: 'production-release-tx', cycleId }), blockNumber: '900', blockHash: digest({ domain: 'production-release-block', cycleId }) };
  evmObserver.seedRelease(cycleId, confirmation);
  return {
    schema: 'hookemon.production-cycle-release.v1', authority: 'production-robinhood-rpc-observer', chainId: '4663', cycleId,
    requirementsRevision: 57, operationsTrigger, cycleVaultAccount, asset: 'USDG', amount: confirmation.amount,
    transactionId: confirmation.transactionId, blockNumber: confirmation.blockNumber, blockHash: confirmation.blockHash, finalized: true,
  };
}

export function productionCyclePreflight(cycleId, fixture) {
  const unsigned = {
    schema: 'hookemon.production-cycle-preflight.v1', requirementsRevision: 57, cycleId,
    operationsTrigger, cycleVaultAccount, policyAccount, returnAccount, hook, usdg,
    authorizationNonce: '1', authorizationExpiresAt: '2099-01-01T00:00:00.000Z', moneyConfiguration: fixture.moneyConfiguration,
    releasedAmount: '10', totalPrincipal: '10', spendCap: '10',
    bindingManifestDigest: TEST_PROFILE_BINDING_MANIFEST_DIGEST, releaseEvidence: releaseEvidence(cycleId, fixture.evmObserver),
  };
  return { ...unsigned, preflightDigest: digest({ domain: 'hookemon.production-cycle-preflight.v1', payload: unsigned }) };
}

// WP-34: production frozen cycle control — the escrow-observation/frozen-control counterpart to this
// file's own preflight/action helpers above, and to fixture-cycle.mjs's frozen-control fixtures.
// `onchainCycleId` never repeats a runner cycle id, so it defaults to a fresh deterministic bytes32
// derived from the runner cycle id rather than reusing a literal that could collide with a hand-picked
// runner cycleId used elsewhere in this file's own tests.
function derivedOnchainCycleId(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

// Seeds `fixture.evmObserver.confirmCycleEscrow` and returns one production escrow observation whose
// fields are exactly what that seeded confirmation reports — schemas.mjs's PRODUCTION_CYCLE_ESCROW_
// OBSERVATION_SCHEMA verifier (cycle-escrow-observation.mjs) checks the two against each other field for
// field, never trusting a bundled signature the way the fixture observation does.
export function productionCycleEscrowObservation(cycleId, fixture, overrides = {}) {
  const onchainCycleId = overrides.onchainCycleId ?? derivedOnchainCycleId(cycleId);
  const usdgBalance = overrides.usdgBalance ?? '19';
  const confirmation = {
    escrowAddress: overrides.escrowAddress ?? returnAccount,
    blockNumber: overrides.blockNumber ?? '901',
    blockHash: overrides.blockHash ?? digest({ domain: 'production-escrow-block', cycleId }),
    usdgBalance,
    transferLogsDigest: overrides.transferLogsDigest ?? digest({ domain: 'production-escrow-transfer-logs', cycleId, usdgBalance }),
    finalized: true,
  };
  fixture.evmObserver.seedCycleEscrow(`${cycleVaultAccount}:${onchainCycleId}`, confirmation);
  return {
    schema: 'hookemon.production-cycle-escrow-observation.v1', authority: 'production-robinhood-rpc-observer',
    requirementsRevision: 57, chainId: '4663', runnerCycleId: cycleId, onchainCycleId, cycleVaultAccount,
    returnAccount: confirmation.escrowAddress, method: 'computeCycleEscrow(bytes32)',
    blockNumber: confirmation.blockNumber, blockHash: confirmation.blockHash, usdgBalance: confirmation.usdgBalance,
    transferLogsDigest: confirmation.transferLogsDigest, finalized: true,
  };
}

// Builds one complete `hookemon.frozen-cycle-control.v1` value bound to this file's own production
// preflight/action digests and a production escrow observation confirmed by `fixture.evmObserver` — the
// reference fixture for "a production-profile CycleRunner bound to a production frozen control"
// (production-cycle.test.mjs, WP-34). `escrowObservationOverrides` lets a negative test corrupt one field
// of the *submitted* observation (a mismatched block hash, a wrong escrow address, an amount below
// `minimumRobinhoodReceive`) without disturbing what the fake observer independently confirms — exactly
// the shape verifyProductionCycleEscrowObservation is meant to catch.
export function buildProductionFrozenControl(cycleId, fixture, { onchainCycleId, usdgBalance, escrowObservationOverrides = {} } = {}) {
  const packSnapshot = createPackSnapshot({
    source: 'collector', observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: digest({ domain: 'production-frozen-control-snapshot', cycleId }),
    packs: [{ code: productionBinding.pack }],
  });
  const preflight = fixture.evidenceProfile.preflight.verify(productionCyclePreflight(cycleId, fixture));
  const plan = freezeCycleDraft(createCycleDraft({
    cycleId, authorizationNonce: preflight.authorizationNonce, packSnapshotDigest: packSnapshot.snapshotDigest,
    pack: productionBinding.pack, quantity: productionBinding.quantity, turbo: productionBinding.turbo,
    amount: preflight.releasedAmount, minimumRobinhoodReceive: preflight.minimumRobinhoodReceive,
    minimumSolanaReceive: preflight.minimumReceives.outbound, minimumReturnUsdg: preflight.minimumReceives.return,
    robinhoodNativeGasCap: preflight.nativeGasCaps.robinhood, solanaNativeGasCap: preflight.nativeGasCaps.solana,
    expiresAt: preflight.authorizationExpiresAt, bindingManifestDigest: preflight.bindingManifestDigest,
    outboundActionDigest: productionActionDigests(productionCycleAction('outbound', cycleId, preflight.preflightDigest)).actionDigest,
    returnActionDigest: productionActionDigests(productionCycleAction('return', cycleId, preflight.preflightDigest)).actionDigest,
    operationsTrigger, cycleVaultAccount, returnAccount,
  }), packSnapshot);
  const escrowObservation = {
    ...productionCycleEscrowObservation(cycleId, fixture, { onchainCycleId, usdgBalance }),
    ...escrowObservationOverrides,
  };
  const control = createFrozenCycleControl(
    { plan, packSnapshot, binding: productionBinding, escrowObservation },
    { observers: { evm: fixture.evmObserver } },
  );
  return { control, plan, packSnapshot, preflight };
}

function productionCollectorRequest(actionKind, cycleId) {
  return {
    schema: `hookemon.production-collector-${actionKind}-request.v1`, cycleId, pack: productionBinding.pack,
    quantity: productionBinding.quantity, turbo: productionBinding.turbo, wallet: productionBinding.executionWallet,
    ...(actionKind === 'open' ? { prizeWallet: purchaseDestination } : {}), memo: `${cycleId}:collector-${actionKind}`,
  };
}

function authorizeCollector(fixture, runner, actionKind, cycleId) {
  const request = productionCollectorRequest(actionKind, cycleId);
  if (actionKind === 'generate') runner.prepareCollectorGenerateIntent(request);
  else runner.prepareCollectorOpenIntent(request);
  const requestDigest = productionCollectorRequestDigest(request, actionKind);
  const authorization = stepAuth(fixture, cycleId, actionKind, 'mutation', requestDigest, productionBinding.executionWallet, productionBinding.pack, '1');
  const authorizationDigest = stepAuthorizationIntentDigest(authorization);
  runner.consumeCollectorMutationAuthorization({ request, binding: productionBinding, authorization });
  runner.executeAuthorizedExternalMutationOnce(requestDigest);
  return { request, requestDigest, authorizationDigest };
}

export function productionCycleAction(actionKind, cycleId, preflightDigest) {
  const sourceAccount = actionKind === 'outbound' ? returnAccount
    : actionKind === 'purchase' ? policyAccount
      : actionKind === 'buyback' ? purchaseDestination : productionBinding.refundTokenAccount;
  const destination = actionKind === 'buyback' ? productionBinding.refundTokenAccount
    : actionKind === 'return' ? returnAccount
      : actionKind === 'outbound' ? policyAccount : purchaseDestination;
  const tokenAccount = `production-token-${actionKind}`;
  return {
    schema: 'hookemon.production-action.v1', cycleId, actionKind, preflightDigest,
    operationsTrigger, cycleVaultAccount, policyAccount, returnAccount,
    principalAmount: '10', minimumReceive: actionKind === 'return' ? '0' : '10', nativeGasAmount: '1',
    provider: PRODUCTION_PROVIDERS[actionKind], ...fixtureActionChainIdentity(actionKind),
    instructions: [{ program: 'production-program', accounts: [
      { address: feePayer, isSigner: true, isWritable: true },
      { address: tokenAccount, isSigner: false, isWritable: true },
      { address: destination, isSigner: false, isWritable: true },
    ], data: `01${Buffer.from(actionKind).toString('hex')}` }],
    signers: [{ address: feePayer, isFeePayer: true }], feePayer, sourceAccount,
    inputAsset: actionKind === 'outbound' ? 'USDG' : actionKind === 'buyback' ? 'production-card-mint' : circleDollarMint,
    outputAsset: actionKind === 'return' ? 'USDG' : actionKind === 'purchase' ? 'collector-pack-nft' : circleDollarMint,
    mint: circleDollarMint, tokenAccount, destination,
    nftMint: actionKind === 'purchase' ? 'production-pack-token-mint' : 'production-card-mint',
    nftCustodyAccount: actionKind === 'purchase' ? 'production-pack-token-account' : productionBinding.executionWallet,
    amount: actionKind === 'buyback' ? '1' : '10', memo: `${cycleId}:${actionKind}`,
    validity: { recentBlockhash: 'aabbcc', currentHeight: '10', lastValidHeight: '20' },
    binding: structuredClone(productionBinding),
  };
}

function prepareSignedAction(fixture, runner, preparedAction, preparedIntent = null) {
  const intent = preparedIntent ?? runner.prepareExternalIntent(preparedAction);
  const mutation = stepAuth(fixture, preparedAction.cycleId, preparedAction.actionKind, 'mutation', intent.actionDigest, preparedAction.destination, preparedAction.binding.pack, preparedAction.principalAmount);
  runner.recordOwnerAuthorization(mutation);
  const approvalKey = runner.consumeAuthorizationOnce(mutation);
  runner.executeAuthorizedExternalMutationOnce(intent.requestDigest);
  const message = productionMessageForAction(preparedAction, { ...intent, approvalKey });
  const messageBytes = encodeProductionMessage(message);
  const messageDigest = runner.recordFixtureDecodedTransaction({ requestDigest: intent.requestDigest, messageBytes });
  const signApproval = stepAuth(fixture, preparedAction.cycleId, preparedAction.actionKind, 'sign', messageDigest, preparedAction.destination, preparedAction.binding.pack, preparedAction.principalAmount);
  runner.recordOwnerAuthorization(signApproval);
  runner.consumeAuthorizationOnce(signApproval);
  const signature = signHex(preparedAction.feePayer, messageBytes);
  const envelope = { schema: 'hookemon.production-signed-transaction.v1', messageBytes, messageDigest, requiredSigners: [preparedAction.feePayer], signatures: [{ signer: preparedAction.feePayer, signature }] };
  const signedBytesDigest = runner.recordSignedBytes({ messageDigest, signedBytes: encodeCanonicalHex(envelope) });
  for (const authorizationKind of ['broadcast', 'asset-spend', 'gas-spend']) {
    const phaseApproval = stepAuth(fixture, preparedAction.cycleId, preparedAction.actionKind, authorizationKind, signedBytesDigest, preparedAction.destination, preparedAction.binding.pack, preparedAction.principalAmount);
    runner.recordOwnerAuthorization(phaseApproval);
    runner.consumeAuthorizationOnce(phaseApproval);
  }
  const observedHeight = (BigInt(preparedAction.validity.currentHeight) + 1n).toString();
  const blockhashConfirmation = { finalized: true, recentBlockhash: preparedAction.validity.recentBlockhash, lastValidHeight: preparedAction.validity.lastValidHeight, observedHeight };
  fixture.solanaObserver.seedBlockhashValidity(intent.actionDigest, blockhashConfirmation);
  const observerConfirmationDigest = digest({ domain: 'hookemon.production-blockhash-observer-confirmation.v1', confirmation: blockhashConfirmation });
  const validity = {
    schema: 'hookemon.production-blockhash-validity.v1', authority: 'production-solana-rpc-observer', cycleId: preparedAction.cycleId,
    actionDigest: intent.actionDigest, messageDigest, signedBytesDigest,
    recentBlockhash: preparedAction.validity.recentBlockhash, observedHeight, lastValidHeight: preparedAction.validity.lastValidHeight,
    finalized: true, observerConfirmationDigest,
  };
  runner.recordFixtureBlockhashValidity(validity);
  runner.broadcastPreparedTransactionOnce({ messageDigest, signedBytesDigest, broadcastSignature: signature });
  return { intent, messageDigest, signedBytesDigest, broadcastSignature: signature };
}

function encodeCanonicalHex(envelope) {
  return Buffer.from(canonicalJson(envelope), 'utf8').toString('hex');
}

function relationFor(preparedAction) {
  const relation = {
    sourceAccount: preparedAction.sourceAccount, destinationAccount: preparedAction.destination,
    inputAsset: preparedAction.inputAsset, outputAsset: preparedAction.outputAsset,
    preSourceBalance: '10', postSourceBalance: '0', preDestinationBalance: '0', postDestinationBalance: '10',
    amountIn: '10', amountOut: '10',
  };
  if (preparedAction.actionKind === 'purchase') return { ...relation, nftMint: preparedAction.nftMint, nftCustodyAccount: preparedAction.nftCustodyAccount, preNftBalance: '0', postNftBalance: '1' };
  if (preparedAction.actionKind === 'buyback') return {
    ...relation, preSourceBalance: '1', amountIn: '1',
    nftMint: preparedAction.nftMint, nftCustodyAccount: preparedAction.nftCustodyAccount, preNftBalance: '1', postNftBalance: '0',
    nftDestinationAccount: preparedAction.sourceAccount, preNftDestinationBalance: '0', postNftDestinationBalance: '1',
  };
  return relation;
}

function providerReceipt(fixture, preparedAction, execution, blockHeight) {
  const relation = relationFor(preparedAction);
  const chainIdentity = fixtureActionChainIdentity(preparedAction.actionKind);
  const receipt = {
    schema: 'hookemon.production-provider-receipt.v1', cycleId: preparedAction.cycleId, actionKind: preparedAction.actionKind,
    provider: PRODUCTION_PROVIDERS[preparedAction.actionKind], providerReceiptId: `${preparedAction.cycleId}-${preparedAction.actionKind}-receipt`,
    chain: chainIdentity.chain, cluster: chainIdentity.cluster, actionDigest: execution.intent.actionDigest,
    messageDigest: execution.messageDigest, transactionSignature: execution.broadcastSignature,
    blockHeight, blockHash: 'ccdd', finalized: true, relation,
    apiResponseDigest: digest({ domain: 'production-api-response', cycleId: preparedAction.cycleId, actionKind: preparedAction.actionKind }),
  };
  const confirmation = {
    schema: 'hookemon.production-observer-confirmation.v1', chain: chainIdentity.chain, cluster: chainIdentity.cluster,
    transactionSignature: execution.broadcastSignature, finalized: true, blockHeight, blockHash: receipt.blockHash,
    programId: programIds[preparedAction.actionKind], payer: preparedAction.feePayer, relation,
  };
  const observer = chainIdentity.chain === BRIDGE_CHAIN_IDS.solana ? fixture.solanaObserver : fixture.evmObserver;
  observer.seedTransaction(execution.broadcastSignature, confirmation);
  return receipt;
}

function accountingEvidence(fixture, preparedAction, execution, receipt, receiptDigest) {
  const fromBlockHeight = (BigInt(receipt.blockHeight) - 1n).toString();
  const sourceIsNft = preparedAction.actionKind === 'buyback';
  const sourceAsset = sourceIsNft ? receipt.relation.nftMint : receipt.relation.inputAsset;
  const movement = (direction, asset, amount) => ({ transactionSignature: receipt.transactionSignature, receiptDigest, blockHeight: receipt.blockHeight, blockHash: receipt.blockHash, direction, asset, amount });
  const nftDestinationActivity = preparedAction.actionKind === 'buyback' ? {
    account: receipt.relation.nftDestinationAccount, asset: receipt.relation.nftMint, fromBlockHeight, fromBlockHash: receipt.blockHash,
    toBlockHeight: receipt.blockHeight, toBlockHash: receipt.blockHash, openingBalance: receipt.relation.preNftDestinationBalance,
    closingBalance: receipt.relation.postNftDestinationBalance, finalized: true, movements: [movement('credit', receipt.relation.nftMint, '1')],
  } : null;
  const sourceActivity = {
    account: sourceIsNft ? receipt.relation.nftCustodyAccount : receipt.relation.sourceAccount, asset: sourceAsset,
    fromBlockHeight, fromBlockHash: receipt.blockHash, toBlockHeight: receipt.blockHeight, toBlockHash: receipt.blockHash,
    openingBalance: sourceIsNft ? receipt.relation.preNftBalance : receipt.relation.preSourceBalance,
    closingBalance: sourceIsNft ? receipt.relation.postNftBalance : receipt.relation.postSourceBalance,
    finalized: true, movements: [movement('debit', sourceAsset, sourceIsNft ? '1' : receipt.relation.amountIn)],
  };
  const accountActivity = {
    account: receipt.relation.destinationAccount, asset: receipt.relation.outputAsset, fromBlockHeight, fromBlockHash: receipt.blockHash,
    toBlockHeight: receipt.blockHeight, toBlockHash: receipt.blockHash, openingBalance: receipt.relation.preDestinationBalance,
    closingBalance: receipt.relation.postDestinationBalance, finalized: true, movements: [movement('credit', receipt.relation.outputAsset, receipt.relation.amountOut)],
  };
  const confirmation = { finalized: true, sourceActivity, accountActivity, ...(nftDestinationActivity ? { nftDestinationActivity } : {}) };
  const chainIdentity = fixtureActionChainIdentity(preparedAction.actionKind);
  const observer = chainIdentity.chain === BRIDGE_CHAIN_IDS.solana ? fixture.solanaObserver : fixture.evmObserver;
  observer.seedAccountActivity(execution.intent.actionDigest, confirmation);
  const evidence = {
    schema: 'hookemon.production-execution-accounting.v1', authority: 'production-chain-observer',
    cycleId: preparedAction.cycleId, actionKind: preparedAction.actionKind, actionDigest: execution.intent.actionDigest,
    receiptDigest, transactionSignature: receipt.transactionSignature, blockHeight: receipt.blockHeight, blockHash: receipt.blockHash, finalized: true,
    nativeGas: { account: preparedAction.feePayer, asset: 'SOL', preBalance: '100', postBalance: '99', actualDebit: '1', transactionFee: '1' },
    sourceActivity, ...(nftDestinationActivity ? { nftDestinationActivity } : {}), accountActivity,
    verificationDigest: '', verificationSignature: 'unused',
  };
  evidence.verificationDigest = digest({ domain: 'hookemon.production-execution-accounting-verification.v1', authority: 'production-chain-observer', payload: (() => { const { verificationDigest, verificationSignature, ...payload } = evidence; return payload; })() });
  return evidence;
}

function completeAction(fixture, runner, preparedAction, blockHeight, preparedIntent = null) {
  const execution = prepareSignedAction(fixture, runner, preparedAction, preparedIntent);
  const receipt = providerReceipt(fixture, preparedAction, execution, blockHeight);
  const receiptDigest = runner.appendCanonicalReceipt(receipt);
  runner.recordExecutionAccountingEvidence(accountingEvidence(fixture, preparedAction, execution, receipt, receiptDigest));
  runner.consumeReceiptOnce(receiptDigest);
  runner.reconcileUnresolvedIntent(execution.intent.requestDigest);
  return receiptDigest;
}

function recordCollectorOpen(fixture, runner, cycleId) {
  const status = {
    schema: 'hookemon.production-collector-status.v1', cycleId, wallet: productionBinding.executionWallet, status: 'ready',
    prizeWallet: purchaseDestination, pack: productionBinding.pack, quantity: productionBinding.quantity,
    turbo: productionBinding.turbo, memo: `${cycleId}:collector-status`, packTokenMint: 'production-pack-token-mint',
    apiResponseDigest: digest({ domain: 'production-collector-status-response', cycleId }),
  };
  fixture.solanaObserver.seedPackStatus(`${status.wallet}:${status.pack}`, { status: 'ready', packTokenMint: status.packTokenMint });
  runner.recordVerifiedCollectorStatus(status);
  const { request, requestDigest, authorizationDigest } = authorizeCollector(fixture, runner, 'open', cycleId);
  const executionUnsigned = {
    schema: 'hookemon.production-collector-open-execution.v1', cycleId, requestDigest,
    authorizationDigest, wallet: request.wallet, prizeWallet: request.prizeWallet, packTokenMint: 'production-pack-token-mint',
    packTokenAccount: 'production-pack-token-account', memo: request.memo,
  };
  const executionDigest = productionCollectorOpenExecutionDigest(executionUnsigned);
  const broadcastSignature = signDigest(collectorSigner, executionDigest);
  const execution = { ...executionUnsigned, executionDigest, broadcastSignature };
  runner.openCollectorPack({ open: request, execution });
  const custody = {
    schema: 'hookemon.production-collector-open-custody.v1', cycleId, requestDigest, authorizationDigest,
    openExecutionDigest: executionDigest, wallet: productionBinding.executionWallet, prizeWallet: purchaseDestination,
    packTokenMint: 'production-pack-token-mint', packTokenAccount: 'production-pack-token-account', nftMint: 'production-card-mint',
    nftCustodyAccount: productionBinding.executionWallet, broadcastSignature, blockHeight: '17', blockHash: 'production-block-open',
    finalized: true, prePackBalance: '1', postPackBalance: '0', preNftBalance: '0', postNftBalance: '1',
  };
  fixture.solanaObserver.seedOpenCustody(broadcastSignature, { finalized: true, blockHeight: '17', blockHash: 'production-block-open', mintedCardMint: 'production-card-mint' });
  const rpcFinality = {
    schema: 'hookemon.production-collector-rpc-finality.v1', cycleId, broadcastSignature,
    providerCustodyDigest: digest({ domain: 'hookemon.production-collector-open-custody.v1', custody }),
    blockHeight: '17', blockHash: 'production-block-open', finalized: true,
  };
  runner.recordFinalizedCollectorOpenCustody({ custody, rpcFinality });
  runner.reconcileUnresolvedIntent(requestDigest);
  runner.deriveOpenReconciliation();
}

function transition(runner, next) {
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next });
}

export function executeCompleteProductionCycle(fixture, runner, cycleId) {
  const preflight = productionCyclePreflight(cycleId, fixture);
  runner.recordReleasedCyclePreflight(preflight);
  const generate = authorizeCollector(fixture, runner, 'generate', cycleId);
  const generateResponse = {
    schema: 'hookemon.production-collector-generate.v1', responseId: `production-collector-generate-${cycleId}`, cycleId,
    pack: productionBinding.pack, quantity: productionBinding.quantity, turbo: productionBinding.turbo,
    wallet: productionBinding.executionWallet, prizeWallet: purchaseDestination,
  };
  runner.generateCollectorPack({ binding: productionBinding, response: generateResponse });
  runner.reconcileUnresolvedIntent(generate.requestDigest);
  completeAction(fixture, runner, productionCycleAction('outbound', cycleId, preflight.preflightDigest), '15');
  transition(runner, 'outbound-finalized');
  completeAction(fixture, runner, productionCycleAction('purchase', cycleId, preflight.preflightDigest), '16');
  transition(runner, 'purchase-finalized');
  recordCollectorOpen(fixture, runner, cycleId);
  const buyback = productionCycleAction('buyback', cycleId, preflight.preflightDigest);
  const buybackIntent = runner.prepareExternalIntent(buyback);
  const buybackApproval = stepAuth(fixture, cycleId, 'buyback', 'buyback-policy', buybackIntent.actionDigest, buyback.destination, buyback.binding.pack, buyback.minimumReceive);
  runner.recordPostOpenBuybackAuthorization(buybackApproval);
  completeAction(fixture, runner, buyback, '18', buybackIntent);
  transition(runner, 'buyback-finalized');
  const returnReceiptDigest = completeAction(fixture, runner, productionCycleAction('return', cycleId, preflight.preflightDigest), '19');
  transition(runner, 'return-finalized');
  return { returnReceiptDigest, preflight };
}
