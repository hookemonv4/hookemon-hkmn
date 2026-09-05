import { fixtureAuthorizationDigest, fixturePostOpenBuybackAuthorizationDigest } from '../../src/cycle/authorization.mjs';
import { fixtureBlockhashValidityDigest } from '../../src/cycle/blockhash-validity.mjs';
import {
  fixtureCollectorMutationAuthorizationDigest, fixtureCollectorOpenCustodyDigest, fixtureCollectorOpenExecutionDigest,
  fixtureCollectorRequestDigest, fixtureCollectorRpcFinalityDigest, fixtureCollectorStatusDigest,
} from '../../src/cycle/collector.mjs';
import { encodeFixtureOnlyMessage, fixtureMessageForAction } from '../../src/cycle/decoder.mjs';
import { fixtureExecutionAccountingDigest } from '../../src/cycle/execution-accounting.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST, fixtureCyclePreflightDigest, fixtureCycleReleaseVerificationDigest } from '../../src/cycle/preflight.mjs';
import { fixtureActionChainIdentity, fixtureReceiptVerificationDigest } from '../../src/cycle/schemas.mjs';
import {
  signFixtureCollectorMutationAuthorization, signFixtureCollectorOpenCustody, signFixtureCollectorOpenExecution,
  signFixtureCollectorRpcFinality, signFixtureCollectorStatus, signFixtureCyclePreflight, signFixtureCycleRelease,
  signFixtureBlockhashValidity, signFixtureExecutionAccounting, signFixtureOwnerApproval, signFixturePostOpenBuybackApproval,
  signFixtureProviderReceipt, signFixtureTransaction,
} from './fixture-crypto.mjs';

const circleDollarMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const operationsTrigger = '0x0000000000000000000000000000000000001004';
const cycleVaultAccount = '0x0000000000000000000000000000000000001002';
const returnAccount = '0x0000000000000000000000000000000000002002';
const defaultHook = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const defaultUsdg = '0x0000000000000000000000000000000000001003';
const policyAccount = 'fixture-solana-policy-account';
export const fixtureBinding = Object.freeze({
  sourceChainId: 4663, executionCluster: 'mainnet-beta', circleDollarMint, circleDollarDecimals: 6,
  pack: 'collector-ember', quantity: 1, turbo: false, executionWallet: policyAccount,
  refundTokenAccount: 'fixture-refund-token-account', refundTokenAccountOwner: policyAccount,
});

function signedValue(value, digestValue, signValue, digestField, signatureField) {
  const withDigest = { ...value, [digestField]: digestValue(value) };
  return { ...withDigest, [signatureField]: signValue(withDigest) };
}

function releaseEvidence(cycleId) {
  return signedValue({
    schema: 'hookemon.fixture-cycle-release.v1', authority: 'hookemon-fixture-release-verifier', chainId: '4663', cycleId,
    requirementsRevision: 57, operationsTrigger, cycleVaultAccount, asset: 'USDG', amount: '10',
    transactionId: digest({ domain: 'hookemon.fixture-cycle-release-transaction.v1', cycleId }), blockNumber: '100',
    blockHash: digest({ domain: 'hookemon.fixture-cycle-release-block.v1', cycleId }), finalized: true,
    verificationDigest: '', verificationSignature: '',
  }, fixtureCycleReleaseVerificationDigest, signFixtureCycleRelease, 'verificationDigest', 'verificationSignature');
}

export function fixtureCyclePreflight(cycleId, { hook = defaultHook, usdg = defaultUsdg } = {}) {
  return signedValue({
    schema: 'hookemon.fixture-cycle-preflight.v1', fixtureOwner: 'fixture-owner', cycleId,
    requirementsRevision: 57, operationsTrigger, cycleVaultAccount, policyAccount, returnAccount, hook, usdg,
    authorizationNonce: '1', authorizationExpiresAt: '2030-01-01T00:00:00.000Z', minimumRobinhoodReceive: '19',
    releasedAmount: '10', totalPrincipal: '10', spendCap: '10',
    // Bridge legs (outbound, return) each reserve 1 against the 'robinhood' cap; Collector Crypt legs
    // (purchase, buyback) each reserve 1 against the 'solana' cap — see nativeGasChainForActionKind.
    nativeGasCaps: { robinhood: '2', solana: '2' }, minimumReceives: { outbound: '10', purchase: '10', buyback: '10', return: '10' },
    bindingManifestDigest: FIXTURE_BINDING_MANIFEST_DIGEST, releaseEvidence: releaseEvidence(cycleId),
    preflightDigest: '', ownerAuthorizationSignature: '',
  }, fixtureCyclePreflightDigest, signFixtureCyclePreflight, 'preflightDigest', 'ownerAuthorizationSignature');
}

export function fixtureCollectorRequest(actionKind, cycleId) {
  return {
    schema: `hookemon.fixture-collector-${actionKind}-request.v1`, cycleId, pack: fixtureBinding.pack,
    quantity: fixtureBinding.quantity, turbo: fixtureBinding.turbo, wallet: fixtureBinding.executionWallet,
    ...(actionKind === 'open' ? { prizeWallet: 'fixture-destination-purchase' } : {}), memo: `${cycleId}:collector-${actionKind}`,
  };
}

export function fixtureCollectorAuthorization(request, actionKind) {
  return signedValue({
    schema: 'hookemon.fixture-collector-mutation-authorization.v1', fixtureOwner: 'fixture-owner', cycleId: request.cycleId,
    action: actionKind, requestDigest: fixtureCollectorRequestDigest(request, actionKind), pack: request.pack,
    quantity: request.quantity, turbo: request.turbo, wallet: request.wallet,
    prizeWallet: request.prizeWallet ?? 'fixture-destination-purchase', memo: request.memo,
    nonce: `${request.cycleId}-collector-${actionKind}-nonce`, attempt: 1, expiry: '2030-01-01T00:00:00.000Z',
    fixtureApprovalDigest: '', fixtureApprovalSignature: '',
  }, fixtureCollectorMutationAuthorizationDigest, signFixtureCollectorMutationAuthorization, 'fixtureApprovalDigest', 'fixtureApprovalSignature');
}

// Exported (WP-07) alongside prepareSignedAction for the same reason: cycle/supersede-path.test.mjs
// needs a durable, real-CycleRunner unresolved Collector mutation attempt (never broadcast-based, so it
// must be rejected by the supersede path before any observer proof is even considered) without
// duplicating this sequence.
export function authorizeCollector(runner, actionKind, cycleId) {
  const request = fixtureCollectorRequest(actionKind, cycleId);
  if (actionKind === 'generate') runner.prepareCollectorGenerateIntent(request);
  else runner.prepareCollectorOpenIntent(request);
  const authorization = fixtureCollectorAuthorization(request, actionKind);
  runner.consumeCollectorMutationAuthorization({ request, binding: fixtureBinding, authorization });
  runner.executeAuthorizedExternalMutationOnce(authorization.requestDigest);
  return { request, authorization };
}

export function fixtureCycleAction(actionKind, cycleId, preflightDigest) {
  const sourceAccount = actionKind === 'outbound' ? returnAccount
    : actionKind === 'purchase' ? policyAccount
      : actionKind === 'buyback' ? 'fixture-destination-purchase' : fixtureBinding.refundTokenAccount;
  const destination = actionKind === 'buyback' ? fixtureBinding.refundTokenAccount
    : actionKind === 'return' ? returnAccount
      : actionKind === 'outbound' ? policyAccount : `fixture-destination-${actionKind}`;
  const tokenAccount = `fixture-token-${actionKind}`;
  return {
    schema: 'hookemon.fixture-action.v1', cycleId, actionKind, preflightDigest,
    operationsTrigger, cycleVaultAccount, policyAccount, returnAccount,
    principalAmount: '10', minimumReceive: '10', nativeGasAmount: '1',
    provider: 'fixture-provider', ...fixtureActionChainIdentity(actionKind),
    instructions: [{ program: 'fixture-program', accounts: [
      { address: 'fixture-fee-payer', isSigner: true, isWritable: true },
      { address: tokenAccount, isSigner: false, isWritable: true },
      { address: destination, isSigner: false, isWritable: true },
    ], data: `01${Buffer.from(actionKind).toString('hex')}` }],
    signers: [{ address: 'fixture-fee-payer', isFeePayer: true }], feePayer: 'fixture-fee-payer', sourceAccount,
    inputAsset: actionKind === 'outbound' ? 'USDG' : actionKind === 'buyback' ? 'fixture-nft-mint' : circleDollarMint,
    outputAsset: actionKind === 'return' ? 'USDG' : actionKind === 'purchase' ? 'collector-pack-nft' : circleDollarMint,
    mint: circleDollarMint, tokenAccount, destination,
    nftMint: actionKind === 'purchase' ? 'fixture-pack-token-mint' : 'fixture-nft-mint',
    nftCustodyAccount: actionKind === 'purchase' ? 'fixture-pack-token-account' : fixtureBinding.executionWallet,
    amount: actionKind === 'buyback' ? '1' : '10', memo: `${cycleId}:${actionKind}`, validity: { recentBlockhash: 'aabb', currentHeight: '10', lastValidHeight: '20' },
    binding: structuredClone(fixtureBinding),
  };
}

function ownerApproval(intent, preparedAction, authorizationKind, subjectDigest) {
  return signedValue({
    schema: 'hookemon.fixture-owner-approval.v1', fixtureOwner: 'fixture-owner', cycleId: preparedAction.cycleId,
    actionKind: preparedAction.actionKind, authorizationKind, subjectDigest, preflightDigest: preparedAction.preflightDigest,
    operationsTrigger: preparedAction.operationsTrigger, cycleVaultAccount: preparedAction.cycleVaultAccount,
    policyAccount: preparedAction.policyAccount, returnAccount: preparedAction.returnAccount,
    principalAmount: preparedAction.principalAmount,
    minimumReceive: preparedAction.minimumReceive, nativeGasAmount: preparedAction.nativeGasAmount, provider: preparedAction.provider,
    actionDigest: intent.actionDigest, bindingDigest: intent.bindingDigest, sourceAccount: preparedAction.sourceAccount,
    inputAsset: preparedAction.inputAsset, outputAsset: preparedAction.outputAsset, destination: preparedAction.destination,
    mint: preparedAction.mint, nftMint: preparedAction.nftMint, nftCustodyAccount: preparedAction.nftCustodyAccount,
    amount: preparedAction.amount, instructionsDigest: intent.instructionsDigest, signersDigest: intent.signersDigest,
    nonce: `${preparedAction.cycleId}-${preparedAction.actionKind}-${authorizationKind}-nonce`, attempt: 1,
    expiry: '2030-01-01T00:00:00.000Z', fixtureApprovalDigest: '', fixtureApprovalSignature: '',
  }, fixtureAuthorizationDigest, signFixtureOwnerApproval, 'fixtureApprovalDigest', 'fixtureApprovalSignature');
}

// Exported (WP-07) so cycle/supersede-path.test.mjs can drive a real, broadcast-recorded CycleRunner
// mutation through the ordinary prepare -> mutation-authorize -> decode -> sign -> blockhash-validate ->
// broadcast pipeline without duplicating this ~30-line sequence — the supersede path's precondition is
// specifically a recorded broadcast (see reducer.mjs's externalMutationSuperseded), which void-path.test
// .mjs's lighter MiniRunner harness deliberately stops short of reaching.
export function prepareSignedAction(runner, preparedAction, preparedIntent = null) {
  const intent = preparedIntent ?? runner.prepareExternalIntent(preparedAction);
  const mutation = ownerApproval(intent, preparedAction, 'mutation', intent.actionDigest);
  runner.recordOwnerAuthorization(mutation);
  const approvalKey = runner.consumeAuthorizationOnce(mutation);
  runner.executeAuthorizedExternalMutationOnce(intent.requestDigest);
  const message = fixtureMessageForAction(preparedAction, { ...intent, approvalKey });
  const messageBytes = encodeFixtureOnlyMessage(message);
  const messageDigest = runner.recordFixtureDecodedTransaction({ requestDigest: intent.requestDigest, messageBytes });
  const signApproval = ownerApproval(intent, preparedAction, 'sign', messageDigest);
  runner.recordOwnerAuthorization(signApproval);
  runner.consumeAuthorizationOnce(signApproval);
  const signed = signFixtureTransaction({ messageBytes, messageDigest });
  const signedBytesDigest = runner.recordSignedBytes({ messageDigest, signedBytes: signed.signedBytes });
  for (const authorizationKind of ['broadcast', 'asset-spend', 'gas-spend']) {
    const phaseApproval = ownerApproval(intent, preparedAction, authorizationKind, signedBytesDigest);
    runner.recordOwnerAuthorization(phaseApproval);
    runner.consumeAuthorizationOnce(phaseApproval);
  }
  const validity = signedValue({
    schema: 'hookemon.fixture-blockhash-validity.v1', authority: 'hookemon-fixture-rpc-verifier', cycleId: preparedAction.cycleId,
    actionDigest: intent.actionDigest, messageDigest, signedBytesDigest,
    recentBlockhash: preparedAction.validity.recentBlockhash,
    observedHeight: (BigInt(preparedAction.validity.currentHeight) + 1n).toString(),
    lastValidHeight: preparedAction.validity.lastValidHeight, finalized: true,
    verificationDigest: '', verificationSignature: '',
  }, fixtureBlockhashValidityDigest, signFixtureBlockhashValidity, 'verificationDigest', 'verificationSignature');
  runner.recordFixtureBlockhashValidity(validity);
  runner.broadcastPreparedTransactionOnce({ messageDigest, signedBytesDigest, broadcastSignature: signed.broadcastSignature });
  return { intent, messageDigest, signed };
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
    ...relation,
    // The buyback's generic source-side fields track the one NFT unit being surrendered (matching
    // action.amount === '1' and preNftBalance/postNftBalance), never the Circle USD refund amount — that
    // stays on amountOut/postDestinationBalance below, unmodified. See schemas.mjs assertFixtureActionPolicy.
    preSourceBalance: '1',
    amountIn: '1',
    nftMint: preparedAction.nftMint,
    nftCustodyAccount: preparedAction.nftCustodyAccount,
    preNftBalance: '1',
    postNftBalance: '0',
    nftDestinationAccount: preparedAction.sourceAccount,
    preNftDestinationBalance: '0',
    postNftDestinationBalance: '1',
  };
  return relation;
}

function providerReceipt(preparedAction, execution, blockHeight) {
  return signedValue({
    schema: 'hookemon.fixture-provider-receipt.v1', cycleId: preparedAction.cycleId, actionKind: preparedAction.actionKind,
    provider: 'fixture-provider', providerReceiptId: `${preparedAction.cycleId}-${preparedAction.actionKind}-receipt`,
    chain: preparedAction.chain, cluster: preparedAction.cluster, actionDigest: execution.intent.actionDigest,
    messageDigest: execution.messageDigest, transactionSignature: execution.signed.broadcastSignature,
    blockHeight, blockHash: 'ccdd', finalized: true, relation: relationFor(preparedAction),
    fixtureVerificationDigest: '', fixtureVerificationSignature: '',
  }, fixtureReceiptVerificationDigest, signFixtureProviderReceipt, 'fixtureVerificationDigest', 'fixtureVerificationSignature');
}

function accountingEvidence(preparedAction, execution, receipt, receiptDigest) {
  const fromBlockHeight = (BigInt(receipt.blockHeight) - 1n).toString();
  const sourceIsNft = preparedAction.actionKind === 'buyback';
  const sourceAsset = sourceIsNft ? receipt.relation.nftMint : receipt.relation.inputAsset;
  const movement = (direction, asset, amount) => ({
    transactionSignature: receipt.transactionSignature, receiptDigest, blockHeight: receipt.blockHeight,
    blockHash: receipt.blockHash, direction, asset, amount,
  });
  const nftDestinationActivity = preparedAction.actionKind === 'buyback' ? {
    account: receipt.relation.nftDestinationAccount,
    asset: receipt.relation.nftMint,
    fromBlockHeight,
    fromBlockHash: receipt.blockHash,
    toBlockHeight: receipt.blockHeight,
    toBlockHash: receipt.blockHash,
    openingBalance: receipt.relation.preNftDestinationBalance,
    closingBalance: receipt.relation.postNftDestinationBalance,
    finalized: true,
    movements: [movement('credit', receipt.relation.nftMint, '1')],
  } : null;
  return signedValue({
    schema: 'hookemon.fixture-execution-accounting.v1', authority: 'hookemon-fixture-accounting-verifier',
    cycleId: preparedAction.cycleId, actionKind: preparedAction.actionKind, actionDigest: execution.intent.actionDigest,
    receiptDigest, transactionSignature: receipt.transactionSignature, blockHeight: receipt.blockHeight,
    blockHash: receipt.blockHash, finalized: true,
    nativeGas: { account: preparedAction.feePayer, asset: 'SOL', preBalance: '100', postBalance: '99', actualDebit: '1', transactionFee: '1' },
    sourceActivity: {
      account: sourceIsNft ? receipt.relation.nftCustodyAccount : receipt.relation.sourceAccount, asset: sourceAsset,
      fromBlockHeight, fromBlockHash: receipt.blockHash, toBlockHeight: receipt.blockHeight, toBlockHash: receipt.blockHash,
      openingBalance: sourceIsNft ? receipt.relation.preNftBalance : receipt.relation.preSourceBalance,
      closingBalance: sourceIsNft ? receipt.relation.postNftBalance : receipt.relation.postSourceBalance,
      finalized: true, movements: [movement('debit', sourceAsset, sourceIsNft ? '1' : receipt.relation.amountIn)],
    },
    ...(nftDestinationActivity ? { nftDestinationActivity } : {}),
    accountActivity: {
      account: receipt.relation.destinationAccount, asset: receipt.relation.outputAsset,
      fromBlockHeight, fromBlockHash: receipt.blockHash, toBlockHeight: receipt.blockHeight, toBlockHash: receipt.blockHash,
      openingBalance: receipt.relation.preDestinationBalance, closingBalance: receipt.relation.postDestinationBalance,
      finalized: true, movements: [movement('credit', receipt.relation.outputAsset, receipt.relation.amountOut)],
    },
    verificationDigest: '', verificationSignature: '',
  }, fixtureExecutionAccountingDigest, signFixtureExecutionAccounting, 'verificationDigest', 'verificationSignature');
}

function completeAction(runner, preparedAction, blockHeight, preparedIntent = null) {
  const execution = prepareSignedAction(runner, preparedAction, preparedIntent);
  const receipt = providerReceipt(preparedAction, execution, blockHeight);
  const receiptDigest = runner.appendCanonicalReceipt(receipt);
  runner.recordExecutionAccountingEvidence(accountingEvidence(preparedAction, execution, receipt, receiptDigest));
  runner.consumeReceiptOnce(receiptDigest);
  runner.reconcileUnresolvedIntent(execution.intent.requestDigest);
  return receiptDigest;
}

function recordCollectorOpen(runner, cycleId) {
  const status = signedValue({
    schema: 'hookemon.fixture-collector-status.v1', cycleId, wallet: fixtureBinding.executionWallet, status: 'ready',
    prizeWallet: 'fixture-destination-purchase', pack: fixtureBinding.pack, quantity: fixtureBinding.quantity,
    turbo: fixtureBinding.turbo, memo: `${cycleId}:collector-status`, packTokenMint: 'fixture-pack-token-mint',
    fixtureVerificationDigest: '', fixtureVerificationSignature: '',
  }, fixtureCollectorStatusDigest, signFixtureCollectorStatus, 'fixtureVerificationDigest', 'fixtureVerificationSignature');
  runner.recordVerifiedCollectorStatus(status);
  const { request, authorization } = authorizeCollector(runner, 'open', cycleId);
  const execution = signedValue({
    schema: 'hookemon.fixture-collector-open-execution.v1', cycleId,
    requestDigest: fixtureCollectorRequestDigest(request, 'open'), authorizationDigest: fixtureCollectorMutationAuthorizationDigest(authorization),
    wallet: request.wallet, prizeWallet: request.prizeWallet, packTokenMint: 'fixture-pack-token-mint',
    packTokenAccount: 'fixture-pack-token-account', memo: request.memo, executionDigest: '', broadcastSignature: '',
  }, fixtureCollectorOpenExecutionDigest, signFixtureCollectorOpenExecution, 'executionDigest', 'broadcastSignature');
  runner.openCollectorPack({ open: request, execution });
  const custody = signedValue({
    schema: 'hookemon.fixture-collector-open-custody.v1', cycleId, requestDigest: execution.requestDigest,
    authorizationDigest: execution.authorizationDigest, openExecutionDigest: execution.executionDigest,
    wallet: fixtureBinding.executionWallet, prizeWallet: 'fixture-destination-purchase', packTokenMint: 'fixture-pack-token-mint',
    packTokenAccount: 'fixture-pack-token-account', nftMint: 'fixture-nft-mint', nftCustodyAccount: fixtureBinding.executionWallet,
    broadcastSignature: execution.broadcastSignature, blockHeight: '17', blockHash: 'ccdd', finalized: true,
    prePackBalance: '1', postPackBalance: '0', preNftBalance: '0', postNftBalance: '1',
    fixtureVerificationDigest: '', fixtureVerificationSignature: '',
  }, fixtureCollectorOpenCustodyDigest, signFixtureCollectorOpenCustody, 'fixtureVerificationDigest', 'fixtureVerificationSignature');
  const rpcFinality = signedValue({
    schema: 'hookemon.fixture-collector-rpc-finality.v1', cycleId, broadcastSignature: custody.broadcastSignature,
    providerCustodyDigest: digest({ domain: 'hookemon.fixture-collector-open-custody.v1', custody }),
    blockHeight: custody.blockHeight, blockHash: custody.blockHash, finalized: true, fixtureRpcDigest: '', fixtureRpcSignature: '',
  }, fixtureCollectorRpcFinalityDigest, signFixtureCollectorRpcFinality, 'fixtureRpcDigest', 'fixtureRpcSignature');
  runner.recordFinalizedCollectorOpenCustody({ custody, rpcFinality });
  runner.reconcileUnresolvedIntent(authorization.requestDigest);
  runner.deriveOpenReconciliation();
}

function postOpenBuybackApproval(intent, preparedAction) {
  return signedValue({
    schema: 'hookemon.fixture-post-open-buyback-approval.v1', fixtureOwner: 'fixture-owner', cycleId: preparedAction.cycleId,
    actionDigest: intent.actionDigest, collectorPrizeWallet: 'fixture-destination-purchase', currentOwner: fixtureBinding.executionWallet,
    // refundAmount is the Circle USD proceeds the owner is authorizing post-open; it is bound to the Circle USD
    // floor (minimumReceive), never to the NFT unit quantity carried on preparedAction.amount.
    eligibility: true, refundAmount: preparedAction.minimumReceive, minimumReceive: preparedAction.minimumReceive,
    mint: preparedAction.mint, tokenAccount: preparedAction.tokenAccount, destination: preparedAction.destination,
    nonce: `${preparedAction.cycleId}-post-open-buyback-nonce`, expiry: '2030-01-01T00:00:00.000Z',
    fixtureApprovalDigest: '', fixtureApprovalSignature: '',
  }, fixturePostOpenBuybackAuthorizationDigest, signFixturePostOpenBuybackApproval, 'fixtureApprovalDigest', 'fixtureApprovalSignature');
}

function transition(runner, next) {
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next });
}

export function executeCompleteFixtureCycle(runner, cycleId, options = {}) {
  const preflight = fixtureCyclePreflight(cycleId, options);
  runner.recordReleasedCyclePreflight(preflight);
  const generate = authorizeCollector(runner, 'generate', cycleId);
  runner.generateCollectorPack({ binding: fixtureBinding });
  runner.reconcileUnresolvedIntent(generate.authorization.requestDigest);
  completeAction(runner, fixtureCycleAction('outbound', cycleId, preflight.preflightDigest), '15');
  transition(runner, 'outbound-finalized');
  completeAction(runner, fixtureCycleAction('purchase', cycleId, preflight.preflightDigest), '16');
  transition(runner, 'purchase-finalized');
  recordCollectorOpen(runner, cycleId);
  const buyback = fixtureCycleAction('buyback', cycleId, preflight.preflightDigest);
  const buybackIntent = runner.prepareExternalIntent(buyback);
  runner.recordPostOpenBuybackAuthorization(postOpenBuybackApproval(buybackIntent, buyback));
  completeAction(runner, buyback, '18', buybackIntent);
  transition(runner, 'buyback-finalized');
  const returnReceiptDigest = completeAction(runner, fixtureCycleAction('return', cycleId, preflight.preflightDigest), '19');
  transition(runner, 'return-finalized');
  return { returnReceiptDigest };
}
