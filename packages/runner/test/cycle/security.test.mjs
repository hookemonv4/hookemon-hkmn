import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  FIXTURE_AUTHORIZATION_VALIDATED_AT,
  fixtureAuthorizationDigest,
  fixturePostOpenBuybackAuthorizationDigest,
} from '../../src/cycle/authorization.mjs';
import { fixtureBlockhashValidityDigest } from '../../src/cycle/blockhash-validity.mjs';
import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import {
  fixtureCollectorMutationAuthorizationDigest,
  fixtureCollectorRequestDigest,
  fixtureCollectorOpenExecutionDigest,
  fixtureCollectorOpenCustodyDigest,
  fixtureCollectorRpcFinalityDigest,
  fixtureCollectorStatusDigest,
} from '../../src/cycle/collector.mjs';
import { encodeFixtureOnlyMessage, fixtureMessageForAction } from '../../src/cycle/decoder.mjs';
import { fixtureExecutionAccountingDigest } from '../../src/cycle/execution-accounting.mjs';
import { CycleJournal, digest } from '../../src/cycle/journal.mjs';
import {
  FIXTURE_BINDING_MANIFEST_DIGEST,
  fixtureCyclePreflightDigest,
  fixtureCycleReleaseVerificationDigest,
  verifyFixtureCyclePreflight,
} from '../../src/cycle/preflight.mjs';
import { assertFixtureAction, assertVerifiedProviderReceipt, BRIDGE_CHAIN_IDS, fixtureActionChainIdentity, fixtureReceiptVerificationDigest } from '../../src/cycle/schemas.mjs';
import {
  signFixtureCyclePreflight,
  signFixtureCycleRelease,
  signFixtureBlockhashValidity,
  signFixtureCollectorMutationAuthorization,
  signFixtureCollectorOpenExecution,
  signFixtureCollectorOpenCustody,
  signFixtureCollectorRpcFinality,
  signFixtureCollectorStatus,
  signFixtureExecutionAccounting,
  signFixtureOwnerApproval,
  signFixturePostOpenBuybackApproval,
  signFixtureProviderReceipt,
  signFixtureProviderVerificationDigest,
  signFixtureTransaction,
  signFixtureTransactionWithOwnerKey,
  rewriteFixtureSignedTransaction,
} from './fixture-crypto.mjs';

const CIRCLE_DOLLAR_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OPERATIONS_TRIGGER = '0x0000000000000000000000000000000000001004';
const CYCLE_VAULT_ACCOUNT = '0x0000000000000000000000000000000000001002';
const RETURN_ACCOUNT = '0x0000000000000000000000000000000000002002';
const HOOK_ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USDG_ACCOUNT = '0x0000000000000000000000000000000000001003';
const POLICY_ACCOUNT = 'fixture-solana-policy-account';
const binding = Object.freeze({
  sourceChainId: 4663,
  executionCluster: 'mainnet-beta',
  circleDollarMint: CIRCLE_DOLLAR_MINT,
  circleDollarDecimals: 6,
  pack: 'collector-ember',
  quantity: 1,
  turbo: false,
  executionWallet: POLICY_ACCOUNT,
  refundTokenAccount: 'fixture-refund-token-account',
  refundTokenAccountOwner: POLICY_ACCOUNT,
});

function releaseEvidence(cycleId, overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-cycle-release.v1',
    authority: 'hookemon-fixture-release-verifier',
    chainId: '4663',
    cycleId,
    requirementsRevision: 57,
    operationsTrigger: OPERATIONS_TRIGGER,
    cycleVaultAccount: CYCLE_VAULT_ACCOUNT,
    asset: 'USDG',
    amount: '10',
    transactionId: digest({ domain: 'hookemon.fixture-cycle-release-transaction.v1', cycleId }),
    blockNumber: '100',
    blockHash: digest({ domain: 'hookemon.fixture-cycle-release-block.v1', cycleId }),
    finalized: true,
    ...overrides,
    verificationDigest: '',
    verificationSignature: '',
  };
  const verificationDigest = fixtureCycleReleaseVerificationDigest(value);
  const unsigned = { ...value, verificationDigest };
  return { ...unsigned, verificationSignature: signFixtureCycleRelease(unsigned) };
}

function cyclePreflight(cycleId, overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-cycle-preflight.v1',
    fixtureOwner: 'fixture-owner',
    cycleId,
    requirementsRevision: 57,
    operationsTrigger: OPERATIONS_TRIGGER,
    cycleVaultAccount: CYCLE_VAULT_ACCOUNT,
    policyAccount: POLICY_ACCOUNT,
    returnAccount: RETURN_ACCOUNT,
    hook: HOOK_ACCOUNT,
    usdg: USDG_ACCOUNT,
    authorizationNonce: '1',
    authorizationExpiresAt: '2030-01-01T00:00:00.000Z',
    minimumRobinhoodReceive: '19',
    releasedAmount: '10',
    totalPrincipal: '10',
    spendCap: '10',
    // Bridge legs (outbound, return) each reserve 1 against the 'robinhood' cap; Collector Crypt legs
    // (purchase, buyback) each reserve 1 against the 'solana' cap — see nativeGasChainForActionKind.
    nativeGasCaps: { robinhood: '2', solana: '2' },
    minimumReceives: { outbound: '10', purchase: '10', buyback: '10', return: '10' },
    bindingManifestDigest: FIXTURE_BINDING_MANIFEST_DIGEST,
    releaseEvidence: releaseEvidence(cycleId),
    ...overrides,
    preflightDigest: '',
    ownerAuthorizationSignature: '',
  };
  const preflightDigest = fixtureCyclePreflightDigest(value);
  const unsigned = { ...value, preflightDigest };
  return { ...unsigned, ownerAuthorizationSignature: signFixtureCyclePreflight(unsigned) };
}

function fixtureRunner(cycleId = 'cycle-1', entries = [], cycleStore = new FixtureCycleStore()) {
  const runner = new CycleRunner(cycleId, entries, { cycleStore });
  if (entries.length === 0) runner.recordReleasedCyclePreflight(cyclePreflight(cycleId));
  return runner;
}

test('binds fixture preflight to the retained test binding manifest', () => {
  const binding = JSON.parse(
    readFileSync(new URL('../../../../bindings/robinhood-chain.json', import.meta.url), 'utf8'),
  );
  const preflightSource = readFileSync(new URL('../../src/cycle/preflight.mjs', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../../../../docs/modules/cycle-runner.md', import.meta.url), 'utf8');
  assert.equal(binding.bindingMode, 'BUILD_ONLY_FAIL_CLOSED');
  assert.equal(FIXTURE_BINDING_MANIFEST_DIGEST, binding.manifestDigest);
  assert.doesNotMatch(preflightSource, /FIXTURE_BINDING_MANIFEST_DIGEST\s*=\s*['"]sha256:/);
  assert.match(card, /fixture and test profiles use the retained binding record/i);
  assert.doesNotThrow(() => verifyFixtureCyclePreflight(cyclePreflight('fresh-cycle', {
    returnAccount: '0x0000000000000000000000000000000000002003',
  })));
});

function collectorRequest(actionKind, cycleId) {
  return {
    schema: `hookemon.fixture-collector-${actionKind}-request.v1`,
    cycleId,
    pack: binding.pack,
    quantity: binding.quantity,
    turbo: binding.turbo,
    wallet: binding.executionWallet,
    ...(actionKind === 'open' ? { prizeWallet: 'fixture-destination-purchase' } : {}),
    memo: `${cycleId}:collector-${actionKind}`,
  };
}

function collectorMutationAuthorization(request, actionKind) {
  const value = {
    schema: 'hookemon.fixture-collector-mutation-authorization.v1',
    fixtureOwner: 'fixture-owner',
    cycleId: request.cycleId,
    action: actionKind,
    requestDigest: digest({ domain: `hookemon.fixture-collector-${actionKind}-request.v1`, request }),
    pack: request.pack,
    quantity: request.quantity,
    turbo: request.turbo,
    wallet: request.wallet,
    prizeWallet: request.prizeWallet ?? 'fixture-destination-purchase',
    memo: request.memo,
    nonce: `${request.cycleId}-collector-${actionKind}-nonce`,
    attempt: 1,
    expiry: '2030-01-01T00:00:00.000Z',
    fixtureApprovalDigest: '',
    fixtureApprovalSignature: '',
  };
  const fixtureApprovalDigest = fixtureCollectorMutationAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  return { ...unsigned, fixtureApprovalSignature: signFixtureCollectorMutationAuthorization(unsigned) };
}

function authorizeCollectorMutation(runner, actionKind, cycleId) {
  const request = collectorRequest(actionKind, cycleId);
  if (actionKind === 'generate') runner.prepareCollectorGenerateIntent(request);
  else runner.prepareCollectorOpenIntent(request);
  const authorization = collectorMutationAuthorization(request, actionKind);
  runner.consumeCollectorMutationAuthorization({
    request,
    binding,
    authorization,
  });
  runner.executeAuthorizedExternalMutationOnce(authorization.requestDigest);
  return { request, authorization };
}

function generateCollectorPackAuthorized(runner, cycleId) {
  const { authorization } = authorizeCollectorMutation(runner, 'generate', cycleId);
  const generated = runner.generateCollectorPack({ binding });
  runner.reconcileUnresolvedIntent(authorization.requestDigest);
  return generated;
}

function action(actionKind, cycleId = 'cycle-1', preflightDigest = cyclePreflight(cycleId).preflightDigest) {
  const sourceAccount = actionKind === 'outbound'
    ? RETURN_ACCOUNT
    : actionKind === 'purchase'
      ? POLICY_ACCOUNT
      : actionKind === 'buyback'
        ? 'fixture-destination-purchase'
        : binding.refundTokenAccount;
  const tokenAccount = `fixture-token-${actionKind}`;
  const destination = actionKind === 'buyback'
    ? binding.refundTokenAccount
    : actionKind === 'return'
      ? RETURN_ACCOUNT
      : actionKind === 'outbound'
        ? POLICY_ACCOUNT
        : `fixture-destination-${actionKind}`;
  return {
    schema: 'hookemon.fixture-action.v1',
    cycleId,
    actionKind,
    preflightDigest,
    operationsTrigger: OPERATIONS_TRIGGER,
    cycleVaultAccount: CYCLE_VAULT_ACCOUNT,
    policyAccount: POLICY_ACCOUNT,
    returnAccount: RETURN_ACCOUNT,
    principalAmount: '10',
    minimumReceive: '10',
    nativeGasAmount: '1',
    provider: 'fixture-provider',
    ...fixtureActionChainIdentity(actionKind),
    instructions: [{
      program: 'fixture-program',
      accounts: [
        { address: 'fixture-fee-payer', isSigner: true, isWritable: true },
        { address: tokenAccount, isSigner: false, isWritable: true },
        { address: destination, isSigner: false, isWritable: true },
      ],
      data: `01${Buffer.from(actionKind).toString('hex')}`,
    }],
    signers: [{ address: 'fixture-fee-payer', isFeePayer: true }],
    feePayer: 'fixture-fee-payer',
    sourceAccount,
    inputAsset: actionKind === 'outbound' ? 'USDG' : actionKind === 'buyback' ? 'fixture-nft-mint' : CIRCLE_DOLLAR_MINT,
    outputAsset: actionKind === 'return' ? 'USDG' : actionKind === 'purchase' ? 'collector-pack-nft' : CIRCLE_DOLLAR_MINT,
    mint: CIRCLE_DOLLAR_MINT,
    tokenAccount,
    destination,
    nftMint: actionKind === 'purchase' ? 'fixture-pack-token-mint' : 'fixture-nft-mint',
    nftCustodyAccount: actionKind === 'purchase' ? 'fixture-pack-token-account' : binding.executionWallet,
    // Buyback spends exactly one NFT unit; every other action kind moves a Circle-USD-denominated amount.
    amount: actionKind === 'buyback' ? '1' : '10',
    memo: `${cycleId}:${actionKind}`,
    validity: { recentBlockhash: 'aabb', currentHeight: '10', lastValidHeight: '20' },
    binding: structuredClone(binding),
  };
}

test('accepts only the fixed fixture action envelopes', () => {
  for (const actionKind of ['outbound', 'purchase', 'buyback', 'return']) {
    assert.doesNotThrow(() => assertFixtureAction(action(actionKind)), actionKind);
  }

  const outbound = action('outbound');
  const purchase = action('purchase');
  const buyback = action('buyback');
  const returned = action('return');
  const mutations = {
    provider: value => ({ ...value, provider: 'attacker-provider' }),
    program: value => ({ ...value, instructions: [{ ...value.instructions[0], program: 'attacker-program' }] }),
    data: value => ({ ...value, instructions: [{ ...value.instructions[0], data: '01ff' }] }),
    extraInstruction: value => ({ ...value, instructions: [...value.instructions, structuredClone(value.instructions[0])] }),
    accountOrder: value => ({ ...value, instructions: [{ ...value.instructions[0], accounts: [...value.instructions[0].accounts].reverse() }] }),
    accountAddress: value => ({ ...value, instructions: [{ ...value.instructions[0], accounts: value.instructions[0].accounts.map((account, index) => index === 1 ? { ...account, address: 'attacker-token-account' } : account) }] }),
    accountFlags: value => ({ ...value, instructions: [{ ...value.instructions[0], accounts: value.instructions[0].accounts.map((account, index) => index === 1 ? { ...account, isWritable: false } : account) }] }),
    source: value => ({ ...value, sourceAccount: 'attacker-source-account' }),
    token: value => ({ ...value, tokenAccount: 'attacker-token-account' }),
    destination: value => ({ ...value, destination: 'attacker-destination-account' }),
    inputAsset: value => ({ ...value, inputAsset: 'attacker-input-asset' }),
    outputAsset: value => ({ ...value, outputAsset: 'attacker-output-asset' }),
    mint: value => ({ ...value, mint: 'attacker-mint' }),
    nftMint: value => ({ ...value, nftMint: 'attacker-nft-mint' }),
    custody: value => ({ ...value, nftCustodyAccount: 'attacker-custody-account' }),
    amount: value => ({ ...value, amount: '11' }),
    operations: value => ({ ...value, operationsTrigger: 'attacker-operations-trigger' }),
    principal: value => ({ ...value, principalAmount: '11' }),
    minimum: value => ({ ...value, minimumReceive: '11' }),
    gas: value => ({ ...value, nativeGasAmount: '2' }),
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    assert.throws(() => assertFixtureAction(mutate(outbound)), /fixture action policy|does not match binding/, `outbound ${name}`);
    assert.throws(() => assertFixtureAction(mutate(purchase)), /fixture action policy|does not match binding/, `purchase ${name}`);
    assert.throws(() => assertFixtureAction(mutate(buyback)), /fixture action policy|does not match binding/, `buyback ${name}`);
    assert.throws(() => assertFixtureAction(mutate(returned)), /fixture action policy|does not match binding/, `return ${name}`);
  }
  assert.throws(() => assertFixtureAction({ ...buyback, destination: 'fixture-destination-buyback' }), /fixture action policy/);
  assert.throws(() => assertFixtureAction({ ...returned, destination: 'fixture-destination-return' }), /fixture action policy/);

  for (const [name, base] of [['outbound', outbound], ['purchase', purchase], ['buyback', buyback], ['return', returned]]) {
    assert.throws(() => assertFixtureAction({ ...base, chain: 'attacker-chain' }), /chain domain/, `${name} chain`);
    assert.throws(() => assertFixtureAction({ ...base, domain: 'attacker-domain' }), /chain domain/, `${name} domain`);
    assert.throws(() => assertFixtureAction({ ...base, cluster: 'attacker-cluster' }), /chain domain/, `${name} cluster`);
  }
});

test('models the outbound and return bridge legs on their own explicit chain, distinct from the Collector Crypt purchase and buyback legs', () => {
  const outbound = action('outbound');
  const purchase = action('purchase');
  const buyback = action('buyback');
  const returned = action('return');

  // The two bridge legs (Robinhood Chain USDG <-> Solana Circle USD) carry the Robinhood CAIP-2 chain
  // identity; the two Collector Crypt legs carry the Solana one. Every action kind is forced onto its
  // own chain, never onto the other leg's chain — closing the historical "every action forced onto
  // Solana" defect (HK-026).
  assert.equal(outbound.chain, BRIDGE_CHAIN_IDS.robinhood);
  assert.equal(returned.chain, BRIDGE_CHAIN_IDS.robinhood);
  assert.equal(purchase.chain, BRIDGE_CHAIN_IDS.solana);
  assert.equal(buyback.chain, BRIDGE_CHAIN_IDS.solana);
  assert.notEqual(outbound.domain, purchase.domain);
  assert.notEqual(outbound.cluster, purchase.cluster);

  // A bridge-leg action cannot borrow the Collector Crypt chain identity and vice versa — each kind's
  // explicit {chain, domain, cluster} triple is enforced, not just "not equal to some sentinel string".
  assert.throws(
    () => assertFixtureAction({ ...outbound, chain: purchase.chain, domain: purchase.domain, cluster: purchase.cluster }),
    /chain domain/,
  );
  assert.throws(
    () => assertFixtureAction({ ...purchase, chain: outbound.chain, domain: outbound.domain, cluster: outbound.cluster }),
    /chain domain/,
  );

  // The corresponding provider receipt for each action kind must carry the same chain identity as the
  // action it settles — a receipt cannot claim the wrong leg's chain either.
  const messageDigest = 'sha256:' + '6'.repeat(64);
  const broadcastSignature = signFixtureTransaction({ messageBytes: Buffer.from('bridge-leg-chain-identity-fixture').toString('hex'), messageDigest }).broadcastSignature;
  const execution = { intent: { actionDigest: 'sha256:' + '5'.repeat(64) }, messageDigest, signed: { broadcastSignature } };
  for (const preparedAction of [outbound, purchase, buyback, returned]) {
    assert.doesNotThrow(() => assertVerifiedProviderReceipt(receipt(preparedAction, execution)), preparedAction.actionKind);
  }
  const outboundReceipt = receipt(outbound, execution);
  assert.throws(
    () => assertVerifiedProviderReceipt({ ...outboundReceipt, chain: purchase.chain, cluster: purchase.cluster }),
    /provider receipt chain is invalid/,
  );
});

test('rejects Operations custody anywhere in the external cycle path', () => {
  const outbound = action('outbound');
  const purchase = action('purchase');
  const buyback = action('buyback');
  const returned = action('return');

  assert.throws(
    () => assertFixtureAction({ ...outbound, sourceAccount: OPERATIONS_TRIGGER }),
    /custody|policy/i,
  );
  assert.throws(
    () => assertFixtureAction({
      ...purchase,
      policyAccount: OPERATIONS_TRIGGER,
      binding: { ...purchase.binding, executionWallet: OPERATIONS_TRIGGER, refundTokenAccountOwner: OPERATIONS_TRIGGER },
    }),
    /custody|policy|Operations/i,
  );
  assert.throws(
    () => assertFixtureAction({ ...purchase, nftCustodyAccount: OPERATIONS_TRIGGER }),
    /custody|policy/i,
  );
  assert.throws(
    () => assertFixtureAction({ ...buyback, destination: OPERATIONS_TRIGGER }),
    /custody|policy/i,
  );
  assert.throws(
    () => assertFixtureAction({ ...returned, destination: OPERATIONS_TRIGGER }),
    /custody|policy/i,
  );
});

function approval(intent, preparedAction, overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-owner-approval.v1',
    fixtureOwner: 'fixture-owner',
    cycleId: preparedAction.cycleId,
    actionKind: preparedAction.actionKind,
    authorizationKind: 'mutation',
    subjectDigest: intent.actionDigest,
    preflightDigest: preparedAction.preflightDigest,
    operationsTrigger: preparedAction.operationsTrigger,
    cycleVaultAccount: preparedAction.cycleVaultAccount,
    policyAccount: preparedAction.policyAccount,
    returnAccount: preparedAction.returnAccount,
    principalAmount: preparedAction.principalAmount,
    minimumReceive: preparedAction.minimumReceive,
    nativeGasAmount: preparedAction.nativeGasAmount,
    provider: preparedAction.provider,
    actionDigest: intent.actionDigest,
    bindingDigest: intent.bindingDigest,
    destination: preparedAction.destination,
    sourceAccount: preparedAction.sourceAccount,
    inputAsset: preparedAction.inputAsset,
    outputAsset: preparedAction.outputAsset,
    mint: preparedAction.mint,
    nftMint: preparedAction.nftMint,
    nftCustodyAccount: preparedAction.nftCustodyAccount,
    amount: preparedAction.amount,
    instructionsDigest: intent.instructionsDigest,
    signersDigest: intent.signersDigest,
    nonce: `${preparedAction.actionKind}-nonce`,
    attempt: 1,
    expiry: '2030-01-01T00:00:00.000Z',
    ...overrides,
    fixtureApprovalDigest: '',
    fixtureApprovalSignature: '',
  };
  const fixtureApprovalDigest = fixtureAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  return { ...unsigned, fixtureApprovalSignature: signFixtureOwnerApproval(unsigned) };
}

function phaseApproval(intent, preparedAction, authorizationKind, subjectDigest) {
  return approval(intent, preparedAction, {
    authorizationKind,
    subjectDigest,
    nonce: `${preparedAction.cycleId}-${preparedAction.actionKind}-${authorizationKind}-nonce`,
  });
}

function blockhashValidityEvidence(preparedAction, execution, overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-blockhash-validity.v1',
    authority: 'hookemon-fixture-rpc-verifier',
    cycleId: preparedAction.cycleId,
    actionDigest: execution.intent.actionDigest,
    messageDigest: execution.messageDigest,
    signedBytesDigest: execution.signedBytesDigest,
    recentBlockhash: preparedAction.validity.recentBlockhash,
    observedHeight: (BigInt(preparedAction.validity.currentHeight) + 1n).toString(),
    lastValidHeight: preparedAction.validity.lastValidHeight,
    finalized: true,
    ...overrides,
    verificationDigest: '',
    verificationSignature: '',
  };
  const verificationDigest = fixtureBlockhashValidityDigest(value);
  const unsigned = { ...value, verificationDigest };
  return { ...unsigned, verificationSignature: signFixtureBlockhashValidity(unsigned) };
}

function prepareDecodedAction(runner, preparedAction, approvalOverrides = {}, preparedIntent = null) {
  const intent = preparedIntent ?? runner.prepareExternalIntent(preparedAction);
  const ownerApproval = approval(intent, preparedAction, approvalOverrides);
  runner.recordOwnerAuthorization(ownerApproval);
  const approvalKey = runner.consumeAuthorizationOnce(ownerApproval);
  runner.executeAuthorizedExternalMutationOnce(intent.requestDigest);
  const message = fixtureMessageForAction(preparedAction, { ...intent, approvalKey });
  const messageBytes = encodeFixtureOnlyMessage(message);
  const messageDigest = runner.recordFixtureDecodedTransaction({
    requestDigest: intent.requestDigest,
    messageBytes,
  });
  const signApproval = phaseApproval(intent, preparedAction, 'sign', messageDigest);
  runner.recordOwnerAuthorization(signApproval);
  runner.consumeAuthorizationOnce(signApproval);
  return { intent, ownerApproval, approvalKey, signApproval, message, messageBytes, messageDigest };
}

function prepareBroadcastReadyAction(runner, preparedAction, approvalOverrides = {}, preparedIntent = null) {
  const decoded = prepareDecodedAction(runner, preparedAction, approvalOverrides, preparedIntent);
  const { intent, messageBytes, messageDigest } = decoded;
  const signed = signFixtureTransaction({ messageBytes, messageDigest });
  const signedBytesDigest = runner.recordSignedBytes({ messageDigest, signedBytes: signed.signedBytes });
  const phaseApprovals = { sign: decoded.signApproval };
  for (const authorizationKind of ['broadcast', 'asset-spend', 'gas-spend']) {
    const phase = phaseApproval(intent, preparedAction, authorizationKind, signedBytesDigest);
    runner.recordOwnerAuthorization(phase);
    runner.consumeAuthorizationOnce(phase);
    phaseApprovals[authorizationKind] = phase;
  }
  return { ...decoded, phaseApprovals, signed, signedBytesDigest };
}

function prepareSignedAction(runner, preparedAction, approvalOverrides = {}, preparedIntent = null) {
  const execution = prepareBroadcastReadyAction(runner, preparedAction, approvalOverrides, preparedIntent);
  const validity = blockhashValidityEvidence(preparedAction, execution);
  runner.recordFixtureBlockhashValidity(validity);
  runner.broadcastPreparedTransactionOnce({
    messageDigest: execution.messageDigest,
    signedBytesDigest: execution.signedBytesDigest,
    broadcastSignature: execution.signed.broadcastSignature,
  });
  return { ...execution, validity };
}

test('cryptographically binds fixture signed bytes, signer set, and broadcast to the decoded message', () => {
  const mutations = {
    'wrong message bytes': envelope => ({ ...envelope, messageBytes: '00' }),
    'wrong message digest': envelope => ({ ...envelope, messageDigest: digest({ domain: 'attacker-message' }) }),
    'wrong signer': envelope => ({
      ...envelope,
      requiredSigners: ['attacker-signer'],
      signatures: envelope.signatures.map(signature => ({ ...signature, signer: 'attacker-signer' })),
    }),
    'partial signer set': envelope => ({ ...envelope, requiredSigners: [], signatures: [] }),
    'changed signature': envelope => ({
      ...envelope,
      signatures: envelope.signatures.map(signature => ({
        ...signature,
        signature: `${signature.signature.startsWith('A') ? 'B' : 'A'}${signature.signature.slice(1)}`,
      })),
    }),
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    const runner = fixtureRunner(`cycle-signed-${name.replaceAll(' ', '-')}`);
    const preparedAction = action('outbound', `cycle-signed-${name.replaceAll(' ', '-')}`);
    const decoded = prepareDecodedAction(runner, preparedAction);
    const signed = signFixtureTransaction({ messageBytes: decoded.messageBytes, messageDigest: decoded.messageDigest });
    const tampered = rewriteFixtureSignedTransaction(signed.signedBytes, mutate);
    assert.throws(
      () => runner.recordSignedBytes({ messageDigest: decoded.messageDigest, signedBytes: tampered }),
      /signed fixture transaction|signature|message|signer/i,
      name,
    );
  }

  const ownerRoleRunner = fixtureRunner('cycle-owner-key-substitution');
  const ownerRoleDecoded = prepareDecodedAction(ownerRoleRunner, action('outbound', 'cycle-owner-key-substitution'));
  const ownerSigned = signFixtureTransactionWithOwnerKey({ messageBytes: ownerRoleDecoded.messageBytes, messageDigest: ownerRoleDecoded.messageDigest });
  assert.throws(
    () => ownerRoleRunner.recordSignedBytes({ messageDigest: ownerRoleDecoded.messageDigest, signedBytes: ownerSigned.signedBytes }),
    /signature verification failed/i,
  );

  const runner = fixtureRunner('cycle-signed-broadcast');
  const preparedAction = action('outbound', 'cycle-signed-broadcast');
  const execution = prepareSignedAction(runner, preparedAction);
  assert.throws(
    () => runner.broadcastPreparedTransactionOnce({
      messageDigest: execution.messageDigest,
      signedBytesDigest: execution.signedBytesDigest,
      broadcastSignature: `${execution.signed.broadcastSignature}x`,
    }),
    /broadcast evidence does not match signed bytes/i,
  );
});

test('requires independently verified blockhash validity immediately before broadcast', () => {
  const runner = fixtureRunner('cycle-broadcast-validity-required');
  const preparedAction = action('outbound', 'cycle-broadcast-validity-required');
  const execution = prepareBroadcastReadyAction(runner, preparedAction);

  assert.throws(
    () => runner.broadcastPreparedTransactionOnce({
      messageDigest: execution.messageDigest,
      signedBytesDigest: execution.signedBytesDigest,
      broadcastSignature: execution.signed.broadcastSignature,
    }),
    /blockhash validity|validity evidence/i,
  );
});

test('rejects pending, stale, changed, forged, and nonadjacent blockhash validity', () => {
  const invalidCases = [
    ['pending', { finalized: false }, /finalized/i],
    ['stale', { observedHeight: '21' }, /stale|validity/i],
    ['changed', { recentBlockhash: 'ccdd' }, /signed action window|blockhash validity/i],
  ];
  for (const [name, overrides, expected] of invalidCases) {
    const cycleId = `cycle-blockhash-${name}`;
    const runner = fixtureRunner(cycleId);
    const preparedAction = action('outbound', cycleId);
    const execution = prepareBroadcastReadyAction(runner, preparedAction);
    const evidence = blockhashValidityEvidence(preparedAction, execution, overrides);
    assert.throws(() => runner.recordFixtureBlockhashValidity(evidence), expected, name);
  }

  const forgedCycleId = 'cycle-blockhash-forged';
  const forgedRunner = fixtureRunner(forgedCycleId);
  const forgedAction = action('outbound', forgedCycleId);
  const forgedExecution = prepareBroadcastReadyAction(forgedRunner, forgedAction);
  const forged = blockhashValidityEvidence(forgedAction, forgedExecution);
  forged.verificationSignature = `${forged.verificationSignature.startsWith('A') ? 'B' : 'A'}${forged.verificationSignature.slice(1)}`;
  assert.throws(() => forgedRunner.recordFixtureBlockhashValidity(forged), /signature verification/i);

  const cycleId = 'cycle-blockhash-nonadjacent';
  const runner = fixtureRunner(cycleId);
  const preparedAction = action('outbound', cycleId);
  const execution = prepareBroadcastReadyAction(runner, preparedAction);
  runner.recordFixtureBlockhashValidity(blockhashValidityEvidence(preparedAction, execution));
  runner.prepareCollectorGenerateIntent(collectorRequest('generate', cycleId));
  const broadcast = () => runner.broadcastPreparedTransactionOnce({
    messageDigest: execution.messageDigest,
    signedBytesDigest: execution.signedBytesDigest,
    broadcastSignature: execution.signed.broadcastSignature,
  });
  assert.throws(broadcast, /immediately before broadcast/i);
  runner.recordFixtureBlockhashValidity(blockhashValidityEvidence(preparedAction, execution, { observedHeight: '12' }));
  assert.equal(broadcast(), execution.signed.broadcastSignature);
});

test('accepts blockhash validity at the documented last-valid-height boundary', () => {
  const cycleId = 'cycle-blockhash-last-valid-boundary';
  const runner = fixtureRunner(cycleId);
  const preparedAction = action('outbound', cycleId);
  const execution = prepareBroadcastReadyAction(runner, preparedAction);
  const evidence = blockhashValidityEvidence(preparedAction, execution, {
    observedHeight: preparedAction.validity.lastValidHeight,
  });

  assert.doesNotThrow(() => runner.recordFixtureBlockhashValidity(evidence));
});

test('accepts canonical base64url transaction signatures in fixture receipts', () => {
  const runner = fixtureRunner('cycle-base64url-receipt');
  const preparedAction = action('outbound', 'cycle-base64url-receipt');
  const execution = prepareSignedAction(runner, preparedAction);
  const value = {
    ...receipt(preparedAction, execution),
    transactionSignature: `_${'A'.repeat(85)}`,
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  const fixtureVerificationDigest = fixtureReceiptVerificationDigest(value);
  const unsigned = { ...value, fixtureVerificationDigest };
  assert.doesNotThrow(() => assertVerifiedProviderReceipt({
    ...unsigned,
    fixtureVerificationSignature: signFixtureProviderReceipt(unsigned),
  }));
});

function relationFor(preparedAction) {
  const common = {
    sourceAccount: preparedAction.sourceAccount,
    destinationAccount: preparedAction.destination,
    inputAsset: preparedAction.inputAsset,
    outputAsset: preparedAction.outputAsset,
    preSourceBalance: '10',
    postSourceBalance: '0',
    preDestinationBalance: '0',
    postDestinationBalance: '10',
    amountIn: '10',
    amountOut: '10',
  };
  if (preparedAction.actionKind === 'purchase') return {
    ...common,
    nftMint: preparedAction.nftMint,
    nftCustodyAccount: preparedAction.nftCustodyAccount,
    preNftBalance: '0',
    postNftBalance: '1',
  };
  if (preparedAction.actionKind === 'buyback') return {
    ...common,
    // Source-side generic fields track the one NFT unit surrendered (action.amount === '1'), not a
    // Circle USD amount; the Circle USD refund stays on amountOut/postDestinationBalance from `common`, unchanged.
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
  return common;
}

function receipt(preparedAction, execution, providerReceiptId = `${preparedAction.actionKind}-receipt`, blockHeight = '15') {
  const value = {
    schema: 'hookemon.fixture-provider-receipt.v1',
    cycleId: preparedAction.cycleId,
    actionKind: preparedAction.actionKind,
    provider: 'fixture-provider',
    providerReceiptId,
    chain: preparedAction.chain,
    cluster: preparedAction.cluster,
    actionDigest: execution.intent.actionDigest,
    messageDigest: execution.messageDigest,
    transactionSignature: execution.signed.broadcastSignature,
    blockHeight,
    blockHash: 'ccdd',
    finalized: true,
    relation: relationFor(preparedAction),
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  const fixtureVerificationDigest = fixtureReceiptVerificationDigest(value);
  const unsigned = { ...value, fixtureVerificationDigest };
  return { ...unsigned, fixtureVerificationSignature: signFixtureProviderReceipt(unsigned) };
}

function receiptWithRelation(receiptValue, relationOverrides) {
  const value = {
    ...receiptValue,
    relation: { ...receiptValue.relation, ...relationOverrides },
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  const fixtureVerificationDigest = fixtureReceiptVerificationDigest(value);
  const unsigned = { ...value, fixtureVerificationDigest };
  return { ...unsigned, fixtureVerificationSignature: signFixtureProviderReceipt(unsigned) };
}

function buybackReceiptWithNftDestination(receiptValue, nftDestinationAccount) {
  const value = {
    ...receiptValue,
    relation: {
      ...receiptValue.relation,
      nftDestinationAccount,
      preNftDestinationBalance: '0',
      postNftDestinationBalance: '1',
    },
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  const { fixtureVerificationDigest: ignoredDigest, fixtureVerificationSignature: ignoredSignature, ...payload } = value;
  const fixtureVerificationDigest = digest({
    domain: 'hookemon.fixture-provider-verification.v1',
    fixtureProvider: payload.provider,
    payload,
  });
  return {
    ...value,
    fixtureVerificationDigest,
    fixtureVerificationSignature: signFixtureProviderVerificationDigest(fixtureVerificationDigest),
  };
}

function executionAccountingEvidence(preparedAction, execution, finalizedReceipt, receiptDigest, overrides = {}) {
  const { nativeGas: nativeGasOverrides = {}, sourceActivity: sourceActivityOverrides = {}, nftDestinationActivity: nftDestinationActivityOverrides = {}, accountActivity: activityOverrides = {}, ...topLevelOverrides } = overrides;
  const fromBlockHeight = (BigInt(finalizedReceipt.blockHeight) - 1n).toString();
  const nativeGas = {
    account: preparedAction.feePayer,
    asset: 'SOL',
    preBalance: '100',
    postBalance: '99',
    actualDebit: '1',
    transactionFee: '1',
    ...nativeGasOverrides,
  };
  const movement = {
    transactionSignature: finalizedReceipt.transactionSignature,
    receiptDigest,
    blockHeight: finalizedReceipt.blockHeight,
    blockHash: finalizedReceipt.blockHash,
    direction: 'credit',
    asset: finalizedReceipt.relation.outputAsset,
    amount: finalizedReceipt.relation.amountOut,
  };
  const sourceIsNft = preparedAction.actionKind === 'buyback';
  const sourceAsset = sourceIsNft ? finalizedReceipt.relation.nftMint : finalizedReceipt.relation.inputAsset;
  const sourceActivity = {
    account: sourceIsNft ? finalizedReceipt.relation.nftCustodyAccount : finalizedReceipt.relation.sourceAccount,
    asset: sourceAsset,
    fromBlockHeight,
    fromBlockHash: finalizedReceipt.blockHash,
    toBlockHeight: finalizedReceipt.blockHeight,
    toBlockHash: finalizedReceipt.blockHash,
    openingBalance: sourceIsNft ? finalizedReceipt.relation.preNftBalance : finalizedReceipt.relation.preSourceBalance,
    closingBalance: sourceIsNft ? finalizedReceipt.relation.postNftBalance : finalizedReceipt.relation.postSourceBalance,
    finalized: true,
    movements: [{
      transactionSignature: finalizedReceipt.transactionSignature,
      receiptDigest,
      blockHeight: finalizedReceipt.blockHeight,
      blockHash: finalizedReceipt.blockHash,
      direction: 'debit',
      asset: sourceAsset,
      amount: sourceIsNft
        ? (BigInt(finalizedReceipt.relation.preNftBalance) - BigInt(finalizedReceipt.relation.postNftBalance)).toString()
        : finalizedReceipt.relation.amountIn,
    }],
    ...sourceActivityOverrides,
  };
  const accountActivity = {
    account: finalizedReceipt.relation.destinationAccount,
    asset: finalizedReceipt.relation.outputAsset,
    fromBlockHeight,
    fromBlockHash: finalizedReceipt.blockHash,
    toBlockHeight: finalizedReceipt.blockHeight,
    toBlockHash: finalizedReceipt.blockHash,
    openingBalance: finalizedReceipt.relation.preDestinationBalance,
    closingBalance: finalizedReceipt.relation.postDestinationBalance,
    finalized: true,
    movements: [movement],
    ...activityOverrides,
  };
  const nftDestinationActivity = preparedAction.actionKind === 'buyback' ? {
    account: finalizedReceipt.relation.nftDestinationAccount,
    asset: finalizedReceipt.relation.nftMint,
    fromBlockHeight,
    fromBlockHash: finalizedReceipt.blockHash,
    toBlockHeight: finalizedReceipt.blockHeight,
    toBlockHash: finalizedReceipt.blockHash,
    openingBalance: finalizedReceipt.relation.preNftDestinationBalance,
    closingBalance: finalizedReceipt.relation.postNftDestinationBalance,
    finalized: true,
    movements: [{
      transactionSignature: finalizedReceipt.transactionSignature,
      receiptDigest,
      blockHeight: finalizedReceipt.blockHeight,
      blockHash: finalizedReceipt.blockHash,
      direction: 'credit',
      asset: finalizedReceipt.relation.nftMint,
      amount: '1',
    }],
    ...nftDestinationActivityOverrides,
  } : null;
  const value = {
    schema: 'hookemon.fixture-execution-accounting.v1',
    authority: 'hookemon-fixture-accounting-verifier',
    cycleId: preparedAction.cycleId,
    actionKind: preparedAction.actionKind,
    actionDigest: execution.intent.actionDigest,
    receiptDigest,
    transactionSignature: finalizedReceipt.transactionSignature,
    blockHeight: finalizedReceipt.blockHeight,
    blockHash: finalizedReceipt.blockHash,
    finalized: true,
    nativeGas,
    sourceActivity,
    ...(nftDestinationActivity ? { nftDestinationActivity } : {}),
    accountActivity,
    ...topLevelOverrides,
    verificationDigest: '',
    verificationSignature: '',
  };
  const verificationDigest = fixtureExecutionAccountingDigest(value);
  const unsigned = { ...value, verificationDigest };
  return { ...unsigned, verificationSignature: signFixtureExecutionAccounting(unsigned) };
}

function resignExecutionAccounting(value) {
  const unsignedValue = { ...value, verificationDigest: '', verificationSignature: '' };
  const verificationDigest = fixtureExecutionAccountingDigest(unsignedValue);
  const unsigned = { ...unsignedValue, verificationDigest };
  return { ...unsigned, verificationSignature: signFixtureExecutionAccounting(unsigned) };
}

function completeAction(runner, actionKind, cycleId = 'cycle-1', {
  preparedAction = action(actionKind, cycleId),
  preparedIntent = null,
  blockHeight = '15',
  relationOverrides = null,
  accountingMutator = null,
} = {}) {
  const execution = prepareSignedAction(runner, preparedAction, {}, preparedIntent);
  const canonicalReceipt = receipt(preparedAction, execution, undefined, blockHeight);
  const finalizedReceipt = relationOverrides ? receiptWithRelation(canonicalReceipt, relationOverrides) : canonicalReceipt;
  const receiptDigest = runner.appendCanonicalReceipt(finalizedReceipt);
  const accounting = executionAccountingEvidence(preparedAction, execution, finalizedReceipt, receiptDigest);
  runner.recordExecutionAccountingEvidence(accountingMutator ? accountingMutator(accounting) : accounting);
  const registryKey = runner.consumeReceiptOnce(receiptDigest);
  runner.reconcileUnresolvedIntent(execution.intent.requestDigest);
  return { preparedAction, execution, receiptDigest, registryKey, accounting };
}

function postOpenBuybackApproval(intent, preparedAction, overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-post-open-buyback-approval.v1', fixtureOwner: 'fixture-owner', cycleId: preparedAction.cycleId,
    actionDigest: intent.actionDigest, collectorPrizeWallet: 'fixture-destination-purchase', currentOwner: binding.executionWallet,
    // refundAmount is Circle USD proceeds, bound to the Circle USD floor (minimumReceive) — never to
    // preparedAction.amount, which is the NFT unit quantity (a different unit entirely).
    eligibility: true, refundAmount: preparedAction.minimumReceive, minimumReceive: preparedAction.minimumReceive,
    mint: preparedAction.mint, tokenAccount: preparedAction.tokenAccount, destination: preparedAction.destination,
    nonce: `${preparedAction.cycleId}-post-open-buyback-nonce`, expiry: '2030-01-01T00:00:00.000Z',
    ...overrides, fixtureApprovalDigest: '', fixtureApprovalSignature: '',
  };
  const fixtureApprovalDigest = fixturePostOpenBuybackAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  return { ...unsigned, fixtureApprovalSignature: signFixturePostOpenBuybackApproval(unsigned) };
}

function verifiedCollectorStatus(cycleId, overrides = {}) {
  const value = {
    schema: 'hookemon.fixture-collector-status.v1',
    cycleId,
    wallet: binding.executionWallet,
    status: 'ready',
    prizeWallet: 'fixture-destination-purchase',
    pack: binding.pack,
    quantity: binding.quantity,
    turbo: binding.turbo,
    memo: `${cycleId}:collector-status`,
    packTokenMint: 'fixture-pack-token-mint',
    ...overrides,
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  const fixtureVerificationDigest = fixtureCollectorStatusDigest(value);
  const unsigned = { ...value, fixtureVerificationDigest };
  return { ...unsigned, fixtureVerificationSignature: signFixtureCollectorStatus(unsigned) };
}

function verifiedCollectorOpenExecution(request, authorization) {
  const value = {
    schema: 'hookemon.fixture-collector-open-execution.v1',
    cycleId: request.cycleId,
    requestDigest: fixtureCollectorRequestDigest(request, 'open'),
    authorizationDigest: fixtureCollectorMutationAuthorizationDigest(authorization),
    wallet: request.wallet,
    prizeWallet: request.prizeWallet,
    packTokenMint: 'fixture-pack-token-mint',
    packTokenAccount: 'fixture-pack-token-account',
    memo: request.memo,
    executionDigest: '',
    broadcastSignature: '',
  };
  const executionDigest = fixtureCollectorOpenExecutionDigest(value);
  const unsigned = { ...value, executionDigest };
  return { ...unsigned, broadcastSignature: signFixtureCollectorOpenExecution(unsigned) };
}

function verifiedCollectorOpenCustody(cycleId, openExecution, overrides = {}) {
  const custodyValue = {
    schema: 'hookemon.fixture-collector-open-custody.v1',
    cycleId,
    requestDigest: openExecution.requestDigest,
    authorizationDigest: openExecution.authorizationDigest,
    openExecutionDigest: openExecution.executionDigest,
    wallet: binding.executionWallet,
    prizeWallet: 'fixture-destination-purchase',
    packTokenMint: 'fixture-pack-token-mint',
    packTokenAccount: 'fixture-pack-token-account',
    nftMint: 'fixture-nft-mint',
    nftCustodyAccount: binding.executionWallet,
    broadcastSignature: openExecution.broadcastSignature,
    blockHeight: '17',
    blockHash: 'ccdd',
    finalized: true,
    prePackBalance: '1',
    postPackBalance: '0',
    preNftBalance: '0',
    postNftBalance: '1',
    ...overrides,
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  const fixtureVerificationDigest = fixtureCollectorOpenCustodyDigest(custodyValue);
  const custodyUnsigned = { ...custodyValue, fixtureVerificationDigest };
  const custody = { ...custodyUnsigned, fixtureVerificationSignature: signFixtureCollectorOpenCustody(custodyUnsigned) };
  const finalityValue = {
    schema: 'hookemon.fixture-collector-rpc-finality.v1',
    cycleId,
    broadcastSignature: custody.broadcastSignature,
    providerCustodyDigest: digest({ domain: 'hookemon.fixture-collector-open-custody.v1', custody }),
    blockHeight: custody.blockHeight,
    blockHash: custody.blockHash,
    finalized: true,
    fixtureRpcDigest: '',
    fixtureRpcSignature: '',
  };
  const fixtureRpcDigest = fixtureCollectorRpcFinalityDigest(finalityValue);
  const finalityUnsigned = { ...finalityValue, fixtureRpcDigest };
  return {
    custody,
    rpcFinality: { ...finalityUnsigned, fixtureRpcSignature: signFixtureCollectorRpcFinality(finalityUnsigned) },
  };
}

function prepareVerifiedCollectorOpen(runner, cycleId) {
  const status = verifiedCollectorStatus(cycleId);
  runner.recordVerifiedCollectorStatus(status);
  const { request, authorization } = authorizeCollectorMutation(runner, 'open', cycleId);
  const execution = verifiedCollectorOpenExecution(request, authorization);
  const open = runner.openCollectorPack({ open: request, execution });
  const custody = verifiedCollectorOpenCustody(cycleId, execution);
  runner.recordFinalizedCollectorOpenCustody(custody);
  runner.reconcileUnresolvedIntent(authorization.requestDigest);
  return { status, open, custody };
}

function reconcileCollectorOpen(runner, cycleId) {
  prepareVerifiedCollectorOpen(runner, cycleId);
  return runner.deriveOpenReconciliation();
}

function completePostOpenBuyback(runner, cycleId, { preparedAction = action('buyback', cycleId), blockHeight = '18' } = {}) {
  const intent = runner.prepareExternalIntent(preparedAction);
  runner.recordPostOpenBuybackAuthorization(postOpenBuybackApproval(intent, preparedAction));
  return completeAction(runner, 'buyback', cycleId, { preparedAction, preparedIntent: intent, blockHeight });
}

function completeCollectorCycleToReturn(cycleId, {
  runner = fixtureRunner(cycleId),
  outboundRelationOverrides = null,
  purchaseRelationOverrides = null,
  returnRelationOverrides = null,
  returnAccountingMutator = null,
  buybackBlockHeight = '18',
  returnBlockHeight = '19',
} = {}) {
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15', relationOverrides: outboundRelationOverrides });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { blockHeight: '16', relationOverrides: purchaseRelationOverrides });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, cycleId);
  completePostOpenBuyback(runner, cycleId, { blockHeight: buybackBlockHeight });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'buyback-finalized' });
  const returned = completeAction(runner, 'return', cycleId, { blockHeight: returnBlockHeight, relationOverrides: returnRelationOverrides, accountingMutator: returnAccountingMutator });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'return-finalized' });
  return { runner, returned };
}

test('requires independently verified actual native-gas evidence for every finalized action', () => {
  const runner = fixtureRunner('cycle-accounting-gas');
  const preparedAction = action('outbound', 'cycle-accounting-gas');
  const execution = prepareSignedAction(runner, preparedAction);
  const finalizedReceipt = receipt(preparedAction, execution);
  const receiptDigest = runner.appendCanonicalReceipt(finalizedReceipt);
  const valid = executionAccountingEvidence(preparedAction, execution, finalizedReceipt, receiptDigest);

  const forged = structuredClone(valid);
  forged.verificationSignature = `${forged.verificationSignature.startsWith('A') ? 'B' : 'A'}${forged.verificationSignature.slice(1)}`;
  assert.throws(() => runner.recordExecutionAccountingEvidence(forged), /accounting.*verification|signature/i);

  const overAuthorized = executionAccountingEvidence(preparedAction, execution, finalizedReceipt, receiptDigest, {
    nativeGas: { postBalance: '98', actualDebit: '2', transactionFee: '2' },
  });
  assert.throws(
    () => runner.recordExecutionAccountingEvidence(overAuthorized),
    /actual native gas|gas.*authorization|authorized.*gas|exceeds/i,
  );

  assert.equal(runner.reconcileUnresolvedIntent(execution.intent.requestDigest).status, 'unresolved');
  assert.throws(() => runner.consumeReceiptOnce(receiptDigest), /execution accounting|accounting evidence/i);
  assert.equal(runner.recordExecutionAccountingEvidence(valid), valid.verificationDigest);
  assert.equal(runner.reconcileUnresolvedIntent(execution.intent.requestDigest).status, 'unresolved');
  runner.consumeReceiptOnce(receiptDigest);
  assert.equal(runner.reconcileUnresolvedIntent(execution.intent.requestDigest).status, 'externally-reconciled');
  const snapshot = runner.cycleStoreSnapshot;
  assert.throws(() => runner.recordExecutionAccountingEvidence(valid), /already|duplicate/i);
  assert.deepEqual(runner.cycleStoreSnapshot, snapshot);
  assert.equal(
    runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' }).stage,
    'outbound-finalized',
  );
});

test('requires exact return accounting before receipt consumption and reconciliation', () => {
  const cycleId = 'cycle-return-accounting-prefix';
  const runner = fixtureRunner(cycleId);
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { blockHeight: '16' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, cycleId);
  completePostOpenBuyback(runner, cycleId, { blockHeight: '18' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'buyback-finalized' });

  const preparedAction = action('return', cycleId);
  const execution = prepareSignedAction(runner, preparedAction);
  const finalizedReceipt = receipt(preparedAction, execution, 'return-accounting-prefix', '19');
  const receiptDigest = runner.appendCanonicalReceipt(finalizedReceipt);
  const accounting = executionAccountingEvidence(preparedAction, execution, finalizedReceipt, receiptDigest);

  assert.equal(runner.reconcileUnresolvedIntent(execution.intent.requestDigest).status, 'unresolved');
  assert.throws(() => runner.consumeReceiptOnce(receiptDigest), /execution accounting|accounting evidence/i);
  runner.recordExecutionAccountingEvidence(accounting);
  assert.equal(runner.reconcileUnresolvedIntent(execution.intent.requestDigest).status, 'unresolved');
  runner.consumeReceiptOnce(receiptDigest);
  assert.equal(runner.reconcileUnresolvedIntent(execution.intent.requestDigest).status, 'externally-reconciled');
});

test('requires independent finalized source custody evidence before consuming a purchase receipt', () => {
  const cycleId = 'cycle-purchase-source-custody';
  const runner = fixtureRunner(cycleId);
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });

  const preparedAction = action('purchase', cycleId);
  const execution = prepareSignedAction(runner, preparedAction);
  const finalizedReceipt = receipt(preparedAction, execution, 'purchase-source-custody', '16');
  const receiptDigest = runner.appendCanonicalReceipt(finalizedReceipt);

  assert.throws(() => runner.consumeReceiptOnce(receiptDigest), /source.*(?:custody|accounting|activity)|accounting.*source/i);

  const accounting = executionAccountingEvidence(preparedAction, execution, finalizedReceipt, receiptDigest);
  const sourceMovement = {
    transactionSignature: finalizedReceipt.transactionSignature,
    receiptDigest,
    blockHeight: finalizedReceipt.blockHeight,
    blockHash: finalizedReceipt.blockHash,
    direction: 'debit',
    asset: finalizedReceipt.relation.inputAsset,
    amount: finalizedReceipt.relation.amountIn,
  };
  const withSource = resignExecutionAccounting({
    ...accounting,
    sourceActivity: {
      account: finalizedReceipt.relation.sourceAccount,
      asset: finalizedReceipt.relation.inputAsset,
      fromBlockHeight: '15',
      fromBlockHash: finalizedReceipt.blockHash,
      toBlockHeight: finalizedReceipt.blockHeight,
      toBlockHash: finalizedReceipt.blockHash,
      openingBalance: finalizedReceipt.relation.preSourceBalance,
      closingBalance: finalizedReceipt.relation.postSourceBalance,
      finalized: true,
      movements: [sourceMovement],
    },
  });
  const forgedSource = resignExecutionAccounting({
    ...withSource,
    sourceActivity: { ...withSource.sourceActivity, account: 'attacker-source-account' },
  });

  assert.throws(() => runner.recordExecutionAccountingEvidence(forgedSource), /source.*(?:custody|accounting|activity|account)/i);
  assert.equal(runner.recordExecutionAccountingEvidence(withSource), withSource.verificationDigest);
  assert.doesNotThrow(() => runner.consumeReceiptOnce(receiptDigest));
});

test('rejects unrelated finalized vault-account movements even when they net to zero', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-accounting-activity', [], cycleStore);
  const beforeReturn = () => cycleStore.snapshot;
  const injectUnrelatedMovements = accounting => {
    const expected = accounting.accountActivity.movements[0];
    const unrelated = direction => ({
      ...expected,
      transactionSignature: `${direction === 'debit' ? '_' : '-'}${'B'.repeat(85)}`,
      receiptDigest: digest({ domain: 'attacker-unrelated-account-activity', direction }),
      direction,
      amount: '1',
    });
    return resignExecutionAccounting({
      ...accounting,
      accountActivity: {
        ...accounting.accountActivity,
        movements: [expected, unrelated('debit'), unrelated('credit')],
      },
    });
  };

  assert.throws(
    () => completeCollectorCycleToReturn('cycle-accounting-activity', { runner, returnAccountingMutator: injectUnrelatedMovements }),
    /activity.*movement|unrelated.*movement|activity-isolated/i,
  );
  const snapshot = beforeReturn();
  assert.equal(snapshot.cycles[0].entries.at(-1).kind, 'provider-receipt-verified');
  assert.equal(snapshot.cycles[0].entries.some(entry => entry.kind === 'execution-accounting-verified' && entry.payload.evidence.actionKind === 'return'), false);
});

test('requires the complete Collector generate, status, and open sequence before reconciliation', () => {
  // Vault-debit ordering: a purchase intent is rejected outright without a verified Collector generate
  // response — real Circle USD must never move toward an unverified destination before the funding stage it
  // is actually meant to follow exists. This is caught at intent preparation, before any purchase can
  // execute, which is strictly earlier (and strictly better) than catching the same gap only once
  // Collector open reconciliation is attempted afterward.
  const runner = fixtureRunner('cycle-collector-required');
  completeAction(runner, 'outbound', 'cycle-collector-required');
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  assert.throws(
    () => completeAction(runner, 'purchase', 'cycle-collector-required'),
    /verified Collector generate response is required before a purchase intent/i,
  );
});

test('rejects unauthenticated legacy Collector status events during recovery', () => {
  const cycleId = 'cycle-legacy-collector-status';
  const journal = new CycleJournal(cycleId);
  journal.append('collector-status-consumed', {
    status: { cycleId, wallet: binding.executionWallet, status: 'ready', prizeWallet: 'fixture-destination-purchase' },
  });
  assert.throws(
    () => CycleRunner.recover(cycleId, journal.entries, { cycleStore: new FixtureCycleStore() }),
    /unauthenticated legacy Collector status.*rejected/i,
  );
});

test('requires each authorized and independently finalized Collector open stage', () => {
  const cycleId = 'cycle-collector-open-evidence';
  const runner = fixtureRunner(cycleId);
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { blockHeight: '16' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });

  const open = collectorRequest('open', cycleId);
  assert.throws(() => runner.prepareCollectorOpenIntent(open), /verified.*status|status.*verified/i);
  assert.throws(
    () => runner.recordVerifiedCollectorStatus(verifiedCollectorStatus(cycleId, { pack: 'collector-crypt' })),
    /status.*binding|binding.*status/i,
  );
  runner.recordVerifiedCollectorStatus(verifiedCollectorStatus(cycleId));
  assert.throws(
    () => runner.prepareCollectorOpenIntent({ ...open, pack: 'collector-crypt' }),
    /status.*binding|binding.*status/i,
  );
  runner.prepareCollectorOpenIntent(open);
  const authorization = collectorMutationAuthorization(open, 'open');
  const execution = verifiedCollectorOpenExecution(open, authorization);
  assert.throws(() => runner.openCollectorPack({ open, execution }), /authorization/i);
  runner.consumeCollectorMutationAuthorization({ request: open, binding, authorization });
  runner.executeAuthorizedExternalMutationOnce(authorization.requestDigest);
  runner.openCollectorPack({ open, execution });
  assert.throws(() => runner.deriveOpenReconciliation(), /custody|finalized/i);

  const evidence = verifiedCollectorOpenCustody(cycleId, execution);
  const forged = structuredClone(evidence);
  forged.rpcFinality.fixtureRpcSignature = `${forged.rpcFinality.fixtureRpcSignature.startsWith('A') ? 'B' : 'A'}${forged.rpcFinality.fixtureRpcSignature.slice(1)}`;
  assert.throws(() => runner.recordFinalizedCollectorOpenCustody(forged), /RPC finality verification|signature/i);

  for (const [name, overrides] of [
    ['unrelated execution', { requestDigest: digest({ domain: 'attacker-open-request' }) }],
    ['arbitrary balances', { prePackBalance: '2', postPackBalance: '1', preNftBalance: '4', postNftBalance: '5' }],
    ['nonchronological block', { blockHeight: '16' }],
  ]) {
    assert.throws(
      () => runner.recordFinalizedCollectorOpenCustody(verifiedCollectorOpenCustody(cycleId, execution, overrides)),
      /binding|chronology/i,
      name,
    );
  }
  runner.recordFinalizedCollectorOpenCustody(evidence);
  runner.reconcileUnresolvedIntent(authorization.requestDigest);
  assert.equal(runner.deriveOpenReconciliation().stage, 'open-reconciled');
});

test('persists an unresolved Collector attempt across restart and never retries it blindly', () => {
  const cycleId = 'cycle-attempt-restart';
  const store = new FixtureCycleStore();
  const runner = fixtureRunner(cycleId, [], store);
  const { authorization } = authorizeCollectorMutation(runner, 'generate', cycleId);
  const snapshot = JSON.parse(JSON.stringify(store.snapshot));
  const reopened = FixtureCycleStore.reopen(snapshot);
  const persistedEntries = reopened.readCycle(cycleId).entries;
  const recovered = CycleRunner.recover(cycleId, persistedEntries, { cycleStore: reopened });

  assert.equal(persistedEntries.at(-1).kind, 'external-mutation-attempted');
  assert.equal(recovered.reconcileUnresolvedIntent(authorization.requestDigest).status, 'unresolved');
  assert.throws(
    () => recovered.executeAuthorizedExternalMutationOnce(authorization.requestDigest),
    /unresolved.*reconciliation|required before any retry/i,
  );

  recovered.generateCollectorPack({ binding });
  assert.equal(recovered.reconcileUnresolvedIntent(authorization.requestDigest).status, 'externally-reconciled');
  assert.throws(
    () => recovered.executeAuthorizedExternalMutationOnce(authorization.requestDigest),
    /already externally reconciled|retry is prohibited/i,
  );
});

test('keeps blocked Collector status and pending RPC finality unresolved', () => {
  const blockedCycleId = 'cycle-blocked-wallet';
  const blocked = fixtureRunner(blockedCycleId);
  generateCollectorPackAuthorized(blocked, blockedCycleId);
  completeAction(blocked, 'outbound', blockedCycleId);
  blocked.advanceCycleState({ expectedVersion: blocked.state.version, expectedJournalHead: blocked.state.journalHead, next: 'outbound-finalized' });
  completeAction(blocked, 'purchase', blockedCycleId, { blockHeight: '16' });
  blocked.advanceCycleState({ expectedVersion: blocked.state.version, expectedJournalHead: blocked.state.journalHead, next: 'purchase-finalized' });
  const blockedStatusValue = { ...verifiedCollectorStatus(blockedCycleId), status: 'blocked', fixtureVerificationDigest: '', fixtureVerificationSignature: '' };
  const blockedDigest = fixtureCollectorStatusDigest(blockedStatusValue);
  const blockedUnsigned = { ...blockedStatusValue, fixtureVerificationDigest: blockedDigest };
  const blockedStatus = { ...blockedUnsigned, fixtureVerificationSignature: signFixtureCollectorStatus(blockedUnsigned) };
  assert.throws(() => blocked.recordVerifiedCollectorStatus(blockedStatus), /status is invalid|blocked/i);
  assert.throws(() => blocked.prepareCollectorOpenIntent(collectorRequest('open', blockedCycleId)), /verified.*status/i);

  const pendingCycleId = 'cycle-pending-open-finality';
  const pending = fixtureRunner(pendingCycleId);
  generateCollectorPackAuthorized(pending, pendingCycleId);
  completeAction(pending, 'outbound', pendingCycleId);
  pending.advanceCycleState({ expectedVersion: pending.state.version, expectedJournalHead: pending.state.journalHead, next: 'outbound-finalized' });
  completeAction(pending, 'purchase', pendingCycleId, { blockHeight: '16' });
  pending.advanceCycleState({ expectedVersion: pending.state.version, expectedJournalHead: pending.state.journalHead, next: 'purchase-finalized' });
  pending.recordVerifiedCollectorStatus(verifiedCollectorStatus(pendingCycleId));
  const { request, authorization } = authorizeCollectorMutation(pending, 'open', pendingCycleId);
  const execution = verifiedCollectorOpenExecution(request, authorization);
  pending.openCollectorPack({ open: request, execution });
  const evidence = verifiedCollectorOpenCustody(pendingCycleId, execution);
  const pendingFinalityValue = { ...evidence.rpcFinality, finalized: false, fixtureRpcDigest: '', fixtureRpcSignature: '' };
  const pendingDigest = fixtureCollectorRpcFinalityDigest(pendingFinalityValue);
  const pendingUnsigned = { ...pendingFinalityValue, fixtureRpcDigest: pendingDigest };
  const pendingFinality = { ...pendingUnsigned, fixtureRpcSignature: signFixtureCollectorRpcFinality(pendingUnsigned) };

  assert.throws(
    () => pending.recordFinalizedCollectorOpenCustody({ custody: evidence.custody, rpcFinality: pendingFinality }),
    /RPC finality is invalid|finalized/i,
  );
  assert.equal(pending.reconcileUnresolvedIntent(authorization.requestDigest).status, 'unresolved');
  assert.throws(() => pending.deriveOpenReconciliation(), /custody|unresolved|finalized/i);
});

test('keeps the cycle open when finalized receipt balances do not form one continuous ledger', () => {
  const { runner } = completeCollectorCycleToReturn('cycle-discontinuous-ledger', {
    outboundRelationOverrides: { postDestinationBalance: '11', amountOut: '11' },
  });

  assert.throws(() => runner.deriveClosedCycle(), /ledger|continuity|reconcile/i);
});

test('keeps the cycle open unless the buyback finalizes after the Collector open', () => {
  const { runner } = completeCollectorCycleToReturn('cycle-open-buyback-chronology', {
    buybackBlockHeight: '17',
    returnBlockHeight: '18',
  });
  assert.throws(() => runner.deriveClosedCycle(), /Collector open.*buyback chronology/i);
});

test('accepts a stray donation on the policy account before the outbound bridge credit lands', () => {
  // The policy account (outbound's destination, purchase's source) is publicly fundable exactly like
  // the vault return account: a prior donation must never wedge the cycle, as long as the outbound
  // credit's own delta (post - pre === the authorized amountOut) is exact, and purchase's continuity
  // handoff (its preSourceBalance === outbound's postDestinationBalance) still holds.
  const { runner } = completeCollectorCycleToReturn('cycle-donated-policy-account', {
    outboundRelationOverrides: { preDestinationBalance: '7', postDestinationBalance: '17' },
    purchaseRelationOverrides: { preSourceBalance: '17', postSourceBalance: '7' },
  });
  assert.doesNotThrow(() => runner.deriveClosedCycle());
});

test('accepts a final vault USDG credit over a positive prior balance when the delta is exactly the attributable amount', () => {
  // A stray donation landing on the vault's publicly fundable return account before the cycle's own
  // return leg lands must never wedge the cycle: exact expected-delta accounting (post - pre === the
  // authorized amountOut) is what is enforced, not an absolute starting balance of zero.
  const { runner } = completeCollectorCycleToReturn('cycle-positive-prior-return', {
    returnRelationOverrides: { preDestinationBalance: '5', postDestinationBalance: '15' },
  });
  assert.doesNotThrow(() => runner.deriveClosedCycle());
});

test('rejects a final vault USDG credit whose delta does not match the attributable return amount', () => {
  // Delta accounting still rejects a mismatched credit: the receipt's own internal delta check
  // (schemas.mjs assertTransferRelation) is what actually enforces this, and it must still fire even
  // once the pre-balance is no longer required to be literal zero.
  assert.throws(
    () => completeCollectorCycleToReturn('cycle-mismatched-prior-return', {
      returnRelationOverrides: { preDestinationBalance: '5', postDestinationBalance: '16' },
    }),
    /delta|balance/i,
  );
});

test('rejects a final vault USDG credit whose independently verified opening balance disagrees with the receipt', () => {
  // The independent execution-accounting evidence must still agree with the receipt relation about what
  // the account's pre-credit balance actually was — delta accounting drops the "must start at zero"
  // requirement, not the requirement that the two independently-produced records agree with each other.
  assert.throws(
    () => completeCollectorCycleToReturn('cycle-disagreeing-prior-return', {
      returnRelationOverrides: { preDestinationBalance: '5', postDestinationBalance: '15' },
      returnAccountingMutator: accounting => resignExecutionAccounting({
        ...accounting,
        accountActivity: { ...accounting.accountActivity, openingBalance: '0' },
      }),
    }),
    /activity|delta|balance/i,
  );
});

test('rejects a finalized buyback refund below the owner minimum receive', () => {
  const cycleId = 'cycle-short-buyback-refund';
  const runner = fixtureRunner(cycleId);
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { blockHeight: '16' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, cycleId);

  const buybackAction = action('buyback', cycleId);
  const buybackIntent = runner.prepareExternalIntent(buybackAction);
  runner.recordPostOpenBuybackAuthorization(postOpenBuybackApproval(buybackIntent, buybackAction));
  const execution = prepareSignedAction(runner, buybackAction, {}, buybackIntent);
  const shortRefund = receiptWithRelation(receipt(buybackAction, execution, 'short-buyback-refund', '17'), {
    postDestinationBalance: '9',
    amountOut: '9',
  });

  assert.throws(() => runner.appendCanonicalReceipt(shortRefund), /minimum receive|below.*minimum/i);
});

test('requires exact equality between the post-open refund approval, buyback receipt, and independent destination delta', () => {
  const cycleId = 'cycle-buyback-refund-equality';
  const runner = fixtureRunner(cycleId);
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { blockHeight: '16' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, cycleId);

  const buybackAction = action('buyback', cycleId);
  const buybackIntent = runner.prepareExternalIntent(buybackAction);
  runner.recordPostOpenBuybackAuthorization(postOpenBuybackApproval(buybackIntent, buybackAction));
  const execution = prepareSignedAction(runner, buybackAction, {}, buybackIntent);
  const overRefund = receiptWithRelation(receipt(buybackAction, execution, 'over-buyback-refund', '18'), {
    postDestinationBalance: '11',
    amountOut: '11',
  });
  const receiptDigest = runner.appendCanonicalReceipt(overRefund);
  const accounting = executionAccountingEvidence(buybackAction, execution, overRefund, receiptDigest);

  assert.throws(
    () => runner.recordExecutionAccountingEvidence(accounting),
    /refund.*(?:equality|amount|approval)|amount.*post-open/i,
  );
  assert.throws(() => runner.consumeReceiptOnce(receiptDigest), /accounting|refund|source custody/i);
});

test('requires an approved signed and independently verified atomic buyback NFT destination credit', () => {
  const cycleId = 'cycle-buyback-nft-destination';
  const runner = fixtureRunner(cycleId);
  generateCollectorPackAuthorized(runner, cycleId);
  completeAction(runner, 'outbound', cycleId, { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { blockHeight: '16' });
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, cycleId);

  const buybackAction = action('buyback', cycleId);
  const buybackIntent = runner.prepareExternalIntent(buybackAction);
  const policy = postOpenBuybackApproval(buybackIntent, buybackAction);
  runner.recordPostOpenBuybackAuthorization(policy);
  const execution = prepareSignedAction(runner, buybackAction, {}, buybackIntent);
  const completeReceipt = receipt(buybackAction, execution, 'missing-buyback-nft-target', '18');
  const legacyReceiptValue = {
    ...completeReceipt,
    relation: { ...completeReceipt.relation },
    fixtureVerificationDigest: '',
    fixtureVerificationSignature: '',
  };
  delete legacyReceiptValue.relation.nftDestinationAccount;
  delete legacyReceiptValue.relation.preNftDestinationBalance;
  delete legacyReceiptValue.relation.postNftDestinationBalance;
  const { fixtureVerificationDigest: ignoredDigest, fixtureVerificationSignature: ignoredSignature, ...legacyPayload } = legacyReceiptValue;
  const legacyDigest = digest({ domain: 'hookemon.fixture-provider-verification.v1', fixtureProvider: legacyPayload.provider, payload: legacyPayload });
  const legacyReceipt = {
    ...legacyReceiptValue,
    fixtureVerificationDigest: legacyDigest,
    fixtureVerificationSignature: signFixtureProviderVerificationDigest(legacyDigest),
  };

  assert.throws(() => runner.appendCanonicalReceipt(legacyReceipt), /buyback.*NFT destination.*required/i);
  assert.throws(
    () => runner.appendCanonicalReceipt(buybackReceiptWithNftDestination(completeReceipt, 'attacker-nft-destination')),
    /buyback.*NFT destination.*(?:approval|signed|message|collector prize wallet)/i,
  );

  const verifiedReceipt = buybackReceiptWithNftDestination(completeReceipt, policy.collectorPrizeWallet);
  const receiptDigest = runner.appendCanonicalReceipt(verifiedReceipt);
  const accounting = executionAccountingEvidence(buybackAction, execution, verifiedReceipt, receiptDigest);
  const wrongIndependentTarget = resignExecutionAccounting({
    ...accounting,
    nftDestinationActivity: { ...accounting.nftDestinationActivity, account: 'attacker-nft-destination' },
  });
  assert.throws(
    () => runner.recordExecutionAccountingEvidence(wrongIndependentTarget),
    /independent.*buyback.*NFT destination|buyback.*NFT destination.*activity/i,
  );
  assert.throws(() => runner.consumeReceiptOnce(receiptDigest), /buyback.*NFT destination|accounting/i);
  assert.equal(runner.recordExecutionAccountingEvidence(accounting), accounting.verificationDigest);
  assert.doesNotThrow(() => runner.consumeReceiptOnce(receiptDigest));
});

test('keeps the cycle open while a verified provider receipt remains unconsumed', () => {
  const { runner, returned } = completeCollectorCycleToReturn('cycle-unconsumed-receipt');
  runner.appendCanonicalReceipt(receipt(returned.preparedAction, returned.execution, 'unmatched-return-receipt', '19'));

  assert.throws(() => runner.deriveClosedCycle(), /unconsumed|unmatched|ledger|receipt/i);
});

test('binds Collector generation, purchase, open, and signed buyback policy to one preflight and wallet', () => {
  const runner = fixtureRunner('collector-secure-cycle');
  const generated = generateCollectorPackAuthorized(runner, 'collector-secure-cycle');
  assert.equal(generated.wallet, binding.executionWallet);
  assert.throws(() => runner.prepareExternalIntent({ ...action('outbound', 'collector-secure-cycle'), binding: { ...binding, executionWallet: 'attacker-wallet', refundTokenAccountOwner: 'attacker-wallet' } }), /Collector.*binding|policy/i);

  completeAction(runner, 'outbound', 'collector-secure-cycle');
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'outbound-finalized' });
  const purchase = action('purchase', 'collector-secure-cycle');
  assert.throws(() => runner.prepareExternalIntent({ ...purchase, destination: 'attacker-prize-wallet', instructions: [{ ...purchase.instructions[0], accounts: purchase.instructions[0].accounts.map((account, index) => index === 2 ? { ...account, address: 'attacker-prize-wallet' } : account) }] }), /policy|Collector/i);
  completeAction(runner, 'purchase', 'collector-secure-cycle');
  runner.advanceCycleState({ expectedVersion: runner.state.version, expectedJournalHead: runner.state.journalHead, next: 'purchase-finalized' });

  const { open: opened } = prepareVerifiedCollectorOpen(runner, 'collector-secure-cycle');
  const snapshot = runner.cycleStoreSnapshot;
  const recovered = CycleRunner.recover('collector-secure-cycle', runner.entries, { cycleStore: FixtureCycleStore.reopen(snapshot) });
  assert.deepEqual(recovered.openCollectorPack(opened), opened);
  assert.throws(() => recovered.openCollectorPack({ ...opened, open: { ...opened.open, wallet: 'attacker-wallet' } }), /binding/i);
  recovered.deriveOpenReconciliation();

  const buyback = action('buyback', 'collector-secure-cycle');
  const intent = recovered.prepareExternalIntent(buyback);
  const ownerMutation = approval(intent, buyback);
  assert.throws(() => recovered.recordOwnerAuthorization(ownerMutation), /post-open buyback/i);
  const policy = postOpenBuybackApproval(intent, buyback);
  assert.equal(recovered.recordPostOpenBuybackAuthorization(policy), policy.fixtureApprovalDigest);
  assert.throws(() => recovered.recordPostOpenBuybackAuthorization(policy), /already|nonce/i);
  assert.doesNotThrow(() => recovered.recordOwnerAuthorization(ownerMutation));
});

test('serializes parallel runners through one durable cycle CAS', () => {
  const cycleStore = new FixtureCycleStore();
  const setup = new CycleRunner('cycle-cas', [], { cycleStore });
  setup.recordReleasedCyclePreflight(cyclePreflight('cycle-cas'));
  const first = CycleRunner.recover('cycle-cas', setup.entries, { cycleStore });
  const stale = CycleRunner.recover('cycle-cas', setup.entries, { cycleStore });

  first.prepareExternalIntent(action('outbound', 'cycle-cas'));
  assert.throws(
    () => stale.prepareExternalIntent(action('outbound', 'cycle-cas')),
    /stale cycle journal (?:version|head)/,
  );
  assert.equal(cycleStore.readCycle('cycle-cas').entries.length, 2);
});

test('requires an explicit durable cycle store for live and recovery runners', () => {
  assert.throws(() => new CycleRunner('cycle-1'), /cycle store.*required/);
  assert.throws(() => CycleRunner.recover('cycle-1', []), /cycle store.*required/);
});

test('requires a durable released-cycle spend preflight before any external intent', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner('cycle-preflight-required', [], { cycleStore });
  const before = cycleStore.snapshot;
  assert.throws(
    () => runner.prepareExternalIntent(action('outbound', 'cycle-preflight-required')),
    /released-cycle.*preflight|spend preflight|preflight.*required/i,
  );
  assert.deepEqual(cycleStore.snapshot, before);
});

test('records one exact signed released-cycle preflight and recovers it durably', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner('cycle-preflight', [], { cycleStore });
  const preflight = cyclePreflight('cycle-preflight');
  assert.equal(runner.recordReleasedCyclePreflight(preflight), preflight.preflightDigest);
  const snapshot = cycleStore.snapshot;
  assert.equal(snapshot.cycles[0].entries.length, 1);
  assert.doesNotThrow(() => CycleRunner.recover('cycle-preflight', runner.entries, { cycleStore: FixtureCycleStore.reopen(snapshot) }));

  assert.throws(() => runner.recordReleasedCyclePreflight(preflight), /duplicate|late/);
  assert.deepEqual(cycleStore.snapshot, snapshot);
  runner.prepareExternalIntent(action('outbound', 'cycle-preflight'));
  assert.throws(() => runner.recordReleasedCyclePreflight(cyclePreflight('cycle-preflight')), /duplicate|late/);
});

test('rejects incomplete, forged, mismatched, and over-cap released-cycle preflights', () => {
  const valid = cyclePreflight('cycle-preflight-schema');
  for (const field of Object.keys(valid)) {
    const missing = structuredClone(valid);
    delete missing[field];
    assert.throws(() => verifyFixtureCyclePreflight(missing), /exact schema/, field);
  }
  for (const [field, container] of [
    ['robinhood', 'nativeGasCaps'],
    ['solana', 'nativeGasCaps'],
    ['outbound', 'minimumReceives'],
    ['purchase', 'minimumReceives'],
    ['buyback', 'minimumReceives'],
    ['return', 'minimumReceives'],
  ]) {
    const missing = cyclePreflight('cycle-preflight-schema');
    delete missing[container][field];
    assert.throws(() => verifyFixtureCyclePreflight(missing), /exact schema/, `${container}.${field}`);
  }
  for (const field of Object.keys(valid.releaseEvidence)) {
    const missing = cyclePreflight('cycle-preflight-schema');
    delete missing.releaseEvidence[field];
    assert.throws(() => verifyFixtureCyclePreflight(missing), /exact schema/, `releaseEvidence.${field}`);
  }

  const cases = [
    ['partial principal leaves vault residue', cyclePreflight('cycle-preflight-schema', { totalPrincipal: '9' }), /entire|full|released|principal/i],
    ['principal above release', cyclePreflight('cycle-preflight-schema', { totalPrincipal: '11' }), /principal.*released|spend cap/],
    ['principal above spend cap', cyclePreflight('cycle-preflight-schema', { totalPrincipal: '10', spendCap: '9' }), /principal.*released|spend cap/],
    ['zero binding digest', cyclePreflight('cycle-preflight-schema', { bindingManifestDigest: `sha256:${'0'.repeat(64)}` }), /binding manifest/],
    ['foreign binding digest', cyclePreflight('cycle-preflight-schema', { bindingManifestDigest: `sha256:${'1'.repeat(64)}` }), /binding manifest/],
    ['wrong release cycle', cyclePreflight('cycle-preflight-schema', { releaseEvidence: releaseEvidence('foreign-cycle') }), /released-cycle evidence/],
    ['wrong release trigger', cyclePreflight('cycle-preflight-schema', { releaseEvidence: releaseEvidence('cycle-preflight-schema', { operationsTrigger: 'foreign-operations-trigger' }) }), /released-cycle evidence/],
    ['wrong release vault', cyclePreflight('cycle-preflight-schema', { releaseEvidence: releaseEvidence('cycle-preflight-schema', { cycleVaultAccount: 'foreign-cycle-vault' }) }), /released-cycle evidence/],
    ['invalid return account', cyclePreflight('cycle-preflight-schema', { returnAccount: 'foreign-return-account' }), /return.?account|custody/i],
    ['Operations as vault', cyclePreflight('cycle-preflight-schema', { cycleVaultAccount: OPERATIONS_TRIGGER, returnAccount: OPERATIONS_TRIGGER }), /Operations|custody/i],
    ['Operations as policy', cyclePreflight('cycle-preflight-schema', { policyAccount: OPERATIONS_TRIGGER }), /Operations|custody/i],
    ['wrong release amount', cyclePreflight('cycle-preflight-schema', { releaseEvidence: releaseEvidence('cycle-preflight-schema', { amount: '9' }) }), /released-cycle evidence/],
    ['zero release transaction', cyclePreflight('cycle-preflight-schema', { releaseEvidence: releaseEvidence('cycle-preflight-schema', { transactionId: `sha256:${'0'.repeat(64)}` }) }), /transaction.*nonzero/],
  ];
  for (const [name, candidate, expected] of cases) assert.throws(() => verifyFixtureCyclePreflight(candidate), expected, name);

  const forgedRelease = cyclePreflight('cycle-preflight-schema');
  forgedRelease.releaseEvidence.amount = '9';
  assert.throws(() => verifyFixtureCyclePreflight(forgedRelease), /verification digest|signature/);
  const forgedOwner = cyclePreflight('cycle-preflight-schema');
  forgedOwner.minimumReceives.outbound = '11';
  assert.throws(() => verifyFixtureCyclePreflight(forgedOwner), /preflight digest|signature/);
  assert.throws(
    () => new CycleRunner('other-cycle', [], { cycleStore: new FixtureCycleStore() }).recordReleasedCyclePreflight(valid),
    /cycle mismatch/,
  );
});

test('binds every action to the exact preflight gas, minimum, and custody roles', () => {
  const cases = [
    ['native gas', { nativeGasCaps: { robinhood: '0', solana: '0' } }],
    ['minimum receive', { minimumReceives: { outbound: '11', purchase: '10', buyback: '10', return: '10' } }],
  ];
  for (const [name, overrides] of cases) {
    const cycleId = `cycle-preflight-${name.replace(' ', '-')}`;
    const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
    const preflight = cyclePreflight(cycleId, overrides);
    runner.recordReleasedCyclePreflight(preflight);
    assert.throws(
      () => runner.prepareExternalIntent(action('outbound', cycleId, preflight.preflightDigest)),
      /exceeds|mismatches.*preflight/,
      name,
    );
  }

  const runner = fixtureRunner('cycle-preflight-action-binding');
  const exact = action('outbound', 'cycle-preflight-action-binding');
  for (const [name, changed] of Object.entries({
    digest: { preflightDigest: `sha256:${'2'.repeat(64)}` },
    operationsTrigger: { operationsTrigger: 'attacker-operations-trigger' },
    cycleVaultAccount: { cycleVaultAccount: 'attacker-cycle-vault' },
    policyAccount: { policyAccount: 'attacker-policy-account' },
    returnAccount: { returnAccount: 'attacker-return-account' },
    principal: { principalAmount: '11' },
    minimum: { minimumReceive: '11' },
    gas: { nativeGasAmount: '2' },
  })) assert.throws(() => runner.prepareExternalIntent({ ...exact, ...changed }), /custody|policy|preflight|exceeds|mismatches/, name);
});

test('enforces the native-gas cap across the complete cycle rather than per action', () => {
  const cycleId = 'cycle-preflight-cumulative-gas';
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore() });
  const preflight = cyclePreflight(cycleId, { nativeGasCaps: { robinhood: '1', solana: '3' } });
  runner.recordReleasedCyclePreflight(preflight);
  const preparedAction = actionKind => action(actionKind, cycleId, preflight.preflightDigest);
  generateCollectorPackAuthorized(runner, cycleId);

  completeAction(runner, 'outbound', cycleId, { preparedAction: preparedAction('outbound') });
  runner.advanceCycleState({ expectedVersion: 0, expectedJournalHead: runner.entries.at(-1).digest, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', cycleId, { preparedAction: preparedAction('purchase') });
  runner.advanceCycleState({ expectedVersion: 1, expectedJournalHead: runner.entries.at(-1).digest, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, cycleId);
  completePostOpenBuyback(runner, cycleId, { preparedAction: preparedAction('buyback') });
  runner.advanceCycleState({ expectedVersion: 3, expectedJournalHead: runner.entries.at(-1).digest, next: 'buyback-finalized' });
  const recovered = CycleRunner.recover(cycleId, runner.entries, {
    cycleStore: FixtureCycleStore.reopen(runner.cycleStoreSnapshot),
  });

  assert.throws(
    () => recovered.prepareExternalIntent(preparedAction('return')),
    /native gas|exceeds|preflight/,
  );
});

test('durably consumes only unexpired single-use authorization nonces', () => {
  const store = new FixtureCycleStore();
  const first = fixtureRunner('cycle-auth-1', [], store);
  const firstAction = action('outbound', 'cycle-auth-1');
  const firstIntent = first.prepareExternalIntent(firstAction);
  const firstApproval = approval(firstIntent, firstAction, { nonce: 'shared-authorization-nonce' });
  first.recordOwnerAuthorization(firstApproval);
  first.consumeAuthorizationOnce(firstApproval);

  const firstSnapshot = store.snapshot;
  assert.equal(firstSnapshot.authorizations.length, 1);
  assert.equal(firstSnapshot.authorizations[0].key, firstApproval.fixtureApprovalDigest);
  assert.equal(firstSnapshot.authorizations[0].validatedAt, FIXTURE_AUTHORIZATION_VALIDATED_AT);

  const reopened = FixtureCycleStore.reopen(firstSnapshot);
  assert.doesNotThrow(() => CycleRunner.recover('cycle-auth-1', first.entries, { cycleStore: reopened }));
  assert.deepEqual(reopened.snapshot, firstSnapshot);

  const poisonedSnapshot = structuredClone(firstSnapshot);
  poisonedSnapshot.authorizations[0].commitment = 'sha256:' + 'f'.repeat(64);
  const poisonedStore = FixtureCycleStore.reopen(poisonedSnapshot);
  assert.throws(
    () => CycleRunner.recover('cycle-auth-1', first.entries, { cycleStore: poisonedStore }),
    /different evidence/i,
  );

  const second = fixtureRunner('cycle-auth-2', [], reopened);
  const secondAction = action('outbound', 'cycle-auth-2');
  const secondIntent = second.prepareExternalIntent(secondAction);
  const secondApproval = approval(secondIntent, secondAction, { nonce: 'shared-authorization-nonce' });
  second.recordOwnerAuthorization(secondApproval);
  assert.throws(() => second.consumeAuthorizationOnce(secondApproval), /authorization nonce/i);
  assert.equal(reopened.snapshot.authorizations.length, 1);
  assert.equal(reopened.readCycle('cycle-auth-2').entries.length, 3);

  const expiredStore = new FixtureCycleStore();
  const expired = fixtureRunner('cycle-auth-expired', [], expiredStore);
  const expiredAction = action('outbound', 'cycle-auth-expired');
  const expiredIntent = expired.prepareExternalIntent(expiredAction);
  const expiredApproval = approval(expiredIntent, expiredAction, { expiry: '2028-12-31T23:59:59.999Z' });
  const poisoned = new CycleJournal('cycle-auth-expired', expired.entries);
  poisoned.append('owner-approval-recorded', { approval: expiredApproval });
  poisoned.append('owner-approval-consumed', {
    actionDigest: expiredApproval.actionDigest,
    authorizationKind: expiredApproval.authorizationKind,
    subjectDigest: expiredApproval.subjectDigest,
    approvalKey: expiredApproval.fixtureApprovalDigest,
    validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
  });
  const recoveryStore = new FixtureCycleStore();
  assert.throws(
    () => CycleRunner.recover('cycle-auth-expired', poisoned.entries, { cycleStore: recoveryStore }),
    /expired/i,
  );
  assert.deepEqual(recoveryStore.snapshot.cycles, []);
  assert.deepEqual(recoveryStore.snapshot.authorizations, []);
});

test('uses one global owner nonce namespace across action and Collector authorizations', () => {
  const cycleId = 'cycle-global-owner-nonce';
  const runner = fixtureRunner(cycleId);
  const preparedAction = action('outbound', cycleId);
  const intent = runner.prepareExternalIntent(preparedAction);
  const actionApproval = approval(intent, preparedAction, { nonce: 'shared-owner-nonce' });
  runner.recordOwnerAuthorization(actionApproval);
  runner.consumeAuthorizationOnce(actionApproval);

  const request = collectorRequest('generate', cycleId);
  runner.prepareCollectorGenerateIntent(request);
  const original = collectorMutationAuthorization(request, 'generate');
  const value = { ...original, nonce: 'shared-owner-nonce', fixtureApprovalDigest: '', fixtureApprovalSignature: '' };
  const fixtureApprovalDigest = fixtureCollectorMutationAuthorizationDigest(value);
  const unsigned = { ...value, fixtureApprovalDigest };
  const collectorApproval = { ...unsigned, fixtureApprovalSignature: signFixtureCollectorMutationAuthorization(unsigned) };

  assert.throws(
    () => runner.consumeCollectorMutationAuthorization({ request, binding, authorization: collectorApproval }),
    /authorization nonce/i,
  );
});

test('rejects an expired approval before it occupies the action slot', () => {
  const store = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-expired-recording', [], store);
  const preparedAction = action('outbound', 'cycle-expired-recording');
  const intent = runner.prepareExternalIntent(preparedAction);
  const expired = approval(intent, preparedAction, { expiry: '2028-12-31T23:59:59.999Z' });
  const beforeExpiredApproval = store.snapshot;
  const beforeExpiredEntries = runner.entries;

  assert.throws(() => runner.recordOwnerAuthorization(expired), /expired/i);
  assert.deepEqual(store.snapshot, beforeExpiredApproval);
  assert.deepEqual(runner.entries, beforeExpiredEntries);

  const valid = approval(intent, preparedAction, { nonce: 'fresh-outbound-nonce' });
  assert.doesNotThrow(() => runner.recordOwnerAuthorization(valid));
  assert.equal(runner.consumeAuthorizationOnce(valid), valid.fixtureApprovalDigest);
});

test('recovery requires every journal-derived authorization and receipt record from an existing store', () => {
  const source = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-recovery-records', [], source);
  completeAction(runner, 'outbound', 'cycle-recovery-records');
  const snapshot = source.snapshot;

  for (const [name, mutate] of Object.entries({
    missingAuthorization: value => { value.authorizations = []; },
    mismatchedAuthorization: value => { value.authorizations[0].commitment = 'sha256:' + 'f'.repeat(64); },
    missingReceipt: value => { value.receipts = []; },
    mismatchedReceipt: value => { value.receipts[0].receiptCommitment = 'sha256:' + 'e'.repeat(64); },
  })) {
    const damaged = structuredClone(snapshot);
    mutate(damaged);
    assert.throws(
      () => CycleRunner.recover('cycle-recovery-records', runner.entries, { cycleStore: FixtureCycleStore.reopen(damaged) }),
      /durable|missing|different evidence|already consumed/i,
      name,
    );
  }
});

test('recovery against an exact reopened snapshot is idempotent', () => {
  const source = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-recovery-idempotent', [], source);
  completeAction(runner, 'outbound', 'cycle-recovery-idempotent');
  const snapshot = source.snapshot;
  const reopened = FixtureCycleStore.reopen(snapshot);

  assert.doesNotThrow(() => CycleRunner.recover('cycle-recovery-idempotent', runner.entries, { cycleStore: reopened }));
  assert.deepEqual(reopened.snapshot, snapshot);
});

test('binds every decoded message field to the exact action and consumed approval', () => {
  const preparedAction = action('outbound');
  const mutations = {
    chain: value => ({ ...value, chain: 'evm' }),
    provider: value => ({ ...value, provider: 'attacker-provider' }),
    preflightDigest: value => ({ ...value, preflightDigest: 'sha256:' + '4'.repeat(64) }),
    operationsTrigger: value => ({ ...value, operationsTrigger: 'attacker-operations-trigger' }),
    cycleVaultAccount: value => ({ ...value, cycleVaultAccount: 'attacker-cycle-vault' }),
    policyAccount: value => ({ ...value, policyAccount: 'attacker-policy-account' }),
    returnAccount: value => ({ ...value, returnAccount: 'attacker-return-account' }),
    principalAmount: value => ({ ...value, principalAmount: '11' }),
    minimumReceive: value => ({ ...value, minimumReceive: '11' }),
    nativeGasAmount: value => ({ ...value, nativeGasAmount: '2' }),
    domain: value => ({ ...value, domain: 'attacker-domain' }),
    cluster: value => ({ ...value, cluster: 'devnet' }),
    instructions: value => ({ ...value, instructions: [{ ...value.instructions[0], data: '02' }] }),
    accounts: value => ({ ...value, instructions: [{ ...value.instructions[0], accounts: value.instructions[0].accounts.map((account, index) => index === 1 ? { ...account, isWritable: false } : account) }] }),
    signers: value => ({ ...value, signers: [{ address: 'attacker-signer', isFeePayer: true }] }),
    feePayer: value => ({ ...value, feePayer: 'attacker-fee-payer' }),
    sourceAccount: value => ({ ...value, sourceAccount: 'attacker-source' }),
    inputAsset: value => ({ ...value, inputAsset: 'attacker-input-asset' }),
    outputAsset: value => ({ ...value, outputAsset: 'attacker-output-asset' }),
    mint: value => ({ ...value, mint: 'attacker-mint' }),
    tokenAccount: value => ({ ...value, tokenAccount: 'attacker-token-account' }),
    destination: value => ({ ...value, destination: 'attacker-destination' }),
    nftMint: value => ({ ...value, nftMint: 'attacker-nft-mint' }),
    nftCustodyAccount: value => ({ ...value, nftCustodyAccount: 'attacker-nft-custody' }),
    amount: value => ({ ...value, amount: '11' }),
    memo: value => ({ ...value, memo: 'attacker-memo' }),
    validity: value => ({ ...value, validity: { ...value.validity, lastValidHeight: '21' } }),
    bindingDigest: value => ({ ...value, bindingDigest: 'sha256:' + '1'.repeat(64) }),
    actionDigest: value => ({ ...value, actionDigest: 'sha256:' + '2'.repeat(64) }),
    approvalKey: value => ({ ...value, approvalKey: 'sha256:' + '3'.repeat(64) }),
    binding: value => ({ ...value, binding: { ...value.binding, executionWallet: 'attacker-execution-wallet', refundTokenAccountOwner: 'attacker-execution-wallet' } }),
  };

  for (const [field, mutate] of Object.entries(mutations)) {
    const runner = fixtureRunner();
    const intent = runner.prepareExternalIntent(preparedAction);
    const ownerApproval = approval(intent, preparedAction);
    runner.recordOwnerAuthorization(ownerApproval);
    const approvalKey = runner.consumeAuthorizationOnce(ownerApproval);
    runner.executeAuthorizedExternalMutationOnce(intent.requestDigest);
    const valid = fixtureMessageForAction(preparedAction, { ...intent, approvalKey });
    assert.deepEqual(valid.binding, preparedAction.binding);
    const attackerMessage = mutate(valid);
    let bytes;
    try { bytes = encodeFixtureOnlyMessage(attackerMessage); } catch { continue; }
    assert.throws(
      () => runner.recordFixtureDecodedTransaction({ requestDigest: intent.requestDigest, messageBytes: bytes }),
      /(?:invalid|mismatch|bound)/,
      field,
    );
  }
});

test('requires separate durable authorizations for signing, broadcast, asset spend, and gas spend', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-phase-auth', [], cycleStore);
  const preparedAction = action('outbound', 'cycle-phase-auth');
  const intent = runner.prepareExternalIntent(preparedAction);
  const mutationApproval = phaseApproval(intent, preparedAction, 'mutation', intent.actionDigest);
  runner.recordOwnerAuthorization(mutationApproval);
  const mutationKey = runner.consumeAuthorizationOnce(mutationApproval);
  runner.executeAuthorizedExternalMutationOnce(intent.requestDigest);
  const message = fixtureMessageForAction(preparedAction, { ...intent, approvalKey: mutationKey });
  const messageBytes = encodeFixtureOnlyMessage(message);
  const messageDigest = runner.recordFixtureDecodedTransaction({ requestDigest: intent.requestDigest, messageBytes });

  const beforeUnauthorizedSign = cycleStore.snapshot;
  assert.throws(
    () => runner.recordSignedBytes({ messageDigest, signedBytes: signFixtureTransaction({ messageBytes, messageDigest }).signedBytes }),
    /sign.*authorization|authorization.*sign/i,
  );
  assert.deepEqual(cycleStore.snapshot, beforeUnauthorizedSign);

  const wrongSignApproval = phaseApproval(intent, preparedAction, 'sign', 'sha256:' + '9'.repeat(64));
  assert.throws(() => runner.recordOwnerAuthorization(wrongSignApproval), /subject|message digest/i);
  const signApproval = phaseApproval(intent, preparedAction, 'sign', messageDigest);
  runner.recordOwnerAuthorization(signApproval);
  runner.consumeAuthorizationOnce(signApproval);
  const signed = signFixtureTransaction({ messageBytes, messageDigest });
  const signedBytesDigest = runner.recordSignedBytes({ messageDigest, signedBytes: signed.signedBytes });

  const beforeUnauthorizedBroadcast = cycleStore.snapshot;
  assert.throws(
    () => runner.broadcastPreparedTransactionOnce({ messageDigest, signedBytesDigest, broadcastSignature: signed.broadcastSignature }),
    /broadcast.*authorization|authorization.*broadcast/i,
  );
  assert.deepEqual(cycleStore.snapshot, beforeUnauthorizedBroadcast);

  for (const authorizationKind of ['broadcast', 'asset-spend']) {
    const phase = phaseApproval(intent, preparedAction, authorizationKind, signedBytesDigest);
    runner.recordOwnerAuthorization(phase);
    runner.consumeAuthorizationOnce(phase);
    assert.throws(
      () => runner.broadcastPreparedTransactionOnce({ messageDigest, signedBytesDigest, broadcastSignature: signed.broadcastSignature }),
      /asset-spend|gas-spend|spend.*authorization|authorization.*spend/i,
    );
  }
  const gasApproval = phaseApproval(intent, preparedAction, 'gas-spend', signedBytesDigest);
  runner.recordOwnerAuthorization(gasApproval);
  runner.consumeAuthorizationOnce(gasApproval);
  runner.recordFixtureBlockhashValidity(blockhashValidityEvidence(preparedAction, { intent, messageDigest, signedBytesDigest }));
  assert.equal(
    runner.broadcastPreparedTransactionOnce({ messageDigest, signedBytesDigest, broadcastSignature: signed.broadcastSignature }),
    signed.broadcastSignature,
  );

  assert.deepEqual(
    cycleStore.snapshot.authorizations.map(record => record.authorizationKind).sort(),
    ['asset-spend', 'broadcast', 'gas-spend', 'mutation', 'sign'],
  );
  assert.doesNotThrow(() => CycleRunner.recover('cycle-phase-auth', runner.entries, { cycleStore: FixtureCycleStore.reopen(cycleStore.snapshot) }));
});

test('rejects duplicate decode, signed bytes, and broadcast events live and during recovery', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-1', [], cycleStore);
  const preparedAction = action('outbound');
  const execution = prepareSignedAction(runner, preparedAction);
  assert.throws(() => runner.recordFixtureDecodedTransaction({ requestDigest: execution.intent.requestDigest, messageBytes: execution.messageBytes }), /already/);
  assert.throws(() => runner.recordSignedBytes({ messageDigest: execution.messageDigest, signedBytes: execution.signed.signedBytes }), /already/);
  assert.throws(() => runner.broadcastPreparedTransactionOnce({ messageDigest: execution.messageDigest, signedBytesDigest: execution.signedBytesDigest, broadcastSignature: execution.signed.broadcastSignature }), /already/);

  for (const duplicateKind of ['fixture-message-decoded', 'signed-bytes-recorded', 'broadcast-recorded']) {
    const forged = new CycleJournal('cycle-1', runner.entries);
    const original = runner.entries.find(entry => entry.kind === duplicateKind);
    forged.append(duplicateKind, original.payload);
    assert.throws(() => CycleRunner.recover('cycle-1', forged.entries, { cycleStore: new FixtureCycleStore() }), /duplicate|already/);
  }
});

test('rejects hash-valid forged approvals, keys, signatures, and unknown journal events', () => {
  const cases = [
    ['owner-approval-recorded', { approval: { attacker: true } }],
    ['owner-approval-consumed', { actionDigest: 'sha256:' + '1'.repeat(64), approvalKey: 'sha256:' + '2'.repeat(64) }],
    ['signed-bytes-recorded', { actionDigest: 'sha256:' + '1'.repeat(64), messageDigest: 'sha256:' + '2'.repeat(64), signedBytes: 'aa', signedBytesDigest: 'sha256:' + '3'.repeat(64), signature: '' }],
    ['attacker-event', { approved: true }],
  ];
  for (const [kind, payload] of cases) {
    const journal = new CycleJournal('cycle-1');
    journal.append(kind, payload);
    assert.throws(() => CycleRunner.recover('cycle-1', journal.entries, { cycleStore: new FixtureCycleStore() }));
  }

  const runner = fixtureRunner();
  const preparedAction = action('outbound');
  const intent = runner.prepareExternalIntent(preparedAction);
  const valid = approval(intent, preparedAction);
  const forged = { ...valid, amount: '11' };
  forged.fixtureApprovalDigest = fixtureAuthorizationDigest(forged);
  assert.throws(() => runner.recordOwnerAuthorization(forged), /signature verification/);
});

test('requires exact verified and consumed receipts before reducer-derived transitions', () => {
  const runner = fixtureRunner();
  generateCollectorPackAuthorized(runner, 'cycle-1');
  assert.throws(() => runner.advanceCycleState({ expectedVersion: 0, expectedJournalHead: null, next: 'open-reconciled' }), /prefix|order|evidence/);

  const outbound = completeAction(runner, 'outbound');
  assert.throws(() => runner.appendCanonicalReceipt({ ...receipt(outbound.preparedAction, outbound.execution, 'forged-finality'), finalized: false }), /finalized|verification/);
  const outsideWindow = receipt(outbound.preparedAction, outbound.execution, 'outside-window');
  outsideWindow.blockHeight = '21';
  outsideWindow.fixtureVerificationDigest = fixtureReceiptVerificationDigest(outsideWindow);
  outsideWindow.fixtureVerificationSignature = signFixtureProviderReceipt(outsideWindow);
  assert.throws(() => runner.appendCanonicalReceipt(outsideWindow), /validity window/);
  let state = runner.advanceCycleState({ expectedVersion: 0, expectedJournalHead: runner.entries.at(-1).digest, next: 'outbound-finalized' });
  assert.equal(state.stage, 'outbound-finalized');
  assert.doesNotThrow(() => CycleRunner.recover('cycle-1', runner.entries, { cycleStore: FixtureCycleStore.reopen(runner.cycleStoreSnapshot) }));

  completeAction(runner, 'purchase');
  state = runner.advanceCycleState({ expectedVersion: 1, expectedJournalHead: runner.entries.at(-1).digest, next: 'purchase-finalized' });
  assert.equal(state.stage, 'purchase-finalized');
  assert.equal(reconcileCollectorOpen(runner, 'cycle-1').stage, 'open-reconciled');
});

test('rejects receipt replay across cycles and reopened stores even when attacker fields change', () => {
  const cycleStore = new FixtureCycleStore();
  const first = fixtureRunner('cycle-1', [], cycleStore);
  const outbound = completeAction(first, 'outbound');
  const snapshot = cycleStore.snapshot;
  const poisonedSnapshot = structuredClone(snapshot);
  poisonedSnapshot.receipts[0].actionKind = 'attacker';
  assert.throws(() => FixtureCycleStore.reopen(poisonedSnapshot), /ownership|action/);
  const reopenedStore = FixtureCycleStore.reopen(snapshot);
  const second = fixtureRunner('cycle-2', [], reopenedStore);
  const secondAction = action('outbound', 'cycle-2');
  const secondExecution = prepareSignedAction(second, secondAction, { nonce: 'cycle-2-outbound-nonce' });
  const changed = receipt(secondAction, secondExecution, 'outbound-receipt');
  changed.relation.amountOut = '11';
  changed.relation.postDestinationBalance = '11';
  changed.fixtureVerificationDigest = fixtureReceiptVerificationDigest(changed);
  changed.fixtureVerificationSignature = signFixtureProviderReceipt(changed);
  const changedDigest = second.appendCanonicalReceipt(changed);
  second.recordExecutionAccountingEvidence(executionAccountingEvidence(secondAction, secondExecution, changed, changedDigest));
  assert.throws(() => second.consumeReceiptOnce(changedDigest), /already consumed|different cycle|registry/);

  const reopened = fixtureRunner('cycle-1', first.entries, FixtureCycleStore.reopen(snapshot));
  assert.throws(() => reopened.consumeReceiptOnce(outbound.receiptDigest), /already|duplicate/);
});

test('rolls back staged receipt consumption when a later recovery event is poisoned', () => {
  const sourceStore = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-1', [], sourceStore);
  completeAction(runner, 'outbound');
  const poison = new CycleJournal('cycle-1', runner.entries);
  const consumed = runner.entries.find(entry => entry.kind === 'receipt-consumed');
  poison.append('receipt-consumed', consumed.payload);
  const reopened = new FixtureCycleStore();
  assert.throws(() => CycleRunner.recover('cycle-1', poison.entries, { cycleStore: reopened }), /duplicate|already/);
  assert.deepEqual(reopened.snapshot.cycles, []);
  assert.deepEqual(reopened.snapshot.receipts, []);
});

test('derives closure and proceeds only from the exact legitimate interleaved prefix', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-1', [], cycleStore);
  const { returned } = completeCollectorCycleToReturn('cycle-1', { runner });
  runner.deriveClosedCycle();

  assert.throws(() => runner.consumeReturnedProceedsOnce({ transaction: 'fabricated', amount: '999' }), /receipt digest|required|verified|exact schema/);
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returned.receiptDigest });
  const beforeFundingAttempt = cycleStore.snapshot;
  assert.throws(
    () => runner.preparePayoutFunding({
      proceedsKey,
      verificationReceiptDigest: 'sha256:' + '4'.repeat(64),
      expiresAt: '1893456000',
      nonce: '9',
    }),
    /recorded distribution verification/i,
  );
  assert.deepEqual(cycleStore.snapshot, beforeFundingAttempt);

  const forgedFunding = new CycleJournal('cycle-1', runner.entries);
  const verificationReceiptDigest = 'sha256:' + '4'.repeat(64);
  forgedFunding.append('payout-funding-prepared', {
    proceedsKey,
    verificationReceiptDigest,
    onchainCycleId: '0x' + '1'.repeat(64),
    payoutId: '0x' + '2'.repeat(64),
    manifestDigest: '0x' + '3'.repeat(64),
    rootHash: '0x' + '4'.repeat(64),
    rootSum: '1',
    vaultPayoutAuthorization: {
      requirementsRevision: 57,
      chainId: '4663',
      cycleId: '0x' + '1'.repeat(64),
      hook: '0x' + 'a'.repeat(40),
      vault: '0x0000000000000000000000000000000000001002',
      usdg: '0x0000000000000000000000000000000000001003',
      operationsTrigger: '0x0000000000000000000000000000000000001004',
      bindingManifestDigest: '0x' + '2'.repeat(64),
      payoutId: '0x' + '3'.repeat(64),
      manifestDigest: '0x' + '4'.repeat(64),
      rootHash: '0x' + '5'.repeat(64),
      rootSum: '1',
      returnActionDigest: '0x' + '6'.repeat(64),
      returnReceiptDigest: '0x' + '7'.repeat(64),
      expiresAt: '1893456000',
      nonce: '9',
    },
    vaultPayoutAuthorizationDigest: '0x' + '7'.repeat(64),
    replayKey: 'sha256:' + '5'.repeat(64),
    intent: 'sha256:' + '6'.repeat(64),
  });
  assert.throws(
    () => CycleRunner.recover('cycle-1', forgedFunding.entries, { cycleStore: new FixtureCycleStore() }),
    /recorded distribution verification/i,
  );
  for (let index = 1; index <= runner.entries.length; index += 1) {
    assert.doesNotThrow(() => CycleRunner.recover('cycle-1', runner.entries.slice(0, index), { cycleStore: new FixtureCycleStore() }), `prefix ${index}`);
  }
});

test('consumes one immutable closed-ledger proceeds attribution across live and reopened runners', () => {
  const cycleStore = new FixtureCycleStore();
  const runner = fixtureRunner('cycle-proceeds-replay', [], cycleStore);
  const { returned } = completeCollectorCycleToReturn('cycle-proceeds-replay', { runner });
  runner.deriveClosedCycle();

  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returned.receiptDigest });
  const consumedSnapshot = cycleStore.snapshot;
  assert.throws(
    () => runner.consumeReturnedProceedsOnce({ receiptDigest: returned.receiptDigest }),
    /proceeds already consumed/i,
  );
  assert.deepEqual(cycleStore.snapshot, consumedSnapshot);

  const reopenedStore = FixtureCycleStore.reopen(consumedSnapshot);
  const reopened = CycleRunner.recover('cycle-proceeds-replay', runner.entries, { cycleStore: reopenedStore });
  assert.throws(
    () => reopened.consumeReturnedProceedsOnce({ receiptDigest: returned.receiptDigest }),
    /proceeds already consumed/i,
  );
  assert.deepEqual(reopenedStore.snapshot, consumedSnapshot);
  assert.equal(proceedsKey, runner.entries.find(entry => entry.kind === 'proceeds-consumed').payload.proceedsKey);
});

test('rejects a later fixture action that switches the cycle execution, custody, and refund wallets', () => {
  const runner = fixtureRunner();
  generateCollectorPackAuthorized(runner, 'cycle-1');
  completeAction(runner, 'outbound');
  runner.advanceCycleState({ expectedVersion: 0, expectedJournalHead: runner.entries.at(-1).digest, next: 'outbound-finalized' });
  completeAction(runner, 'purchase');
  runner.advanceCycleState({ expectedVersion: 1, expectedJournalHead: runner.entries.at(-1).digest, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, 'cycle-1');
  completePostOpenBuyback(runner, 'cycle-1');
  runner.advanceCycleState({ expectedVersion: 3, expectedJournalHead: runner.entries.at(-1).digest, next: 'buyback-finalized' });

  const switchedBinding = {
    ...binding,
    executionWallet: 'fixture-second-execution-wallet',
    refundTokenAccount: 'fixture-second-refund-token-account',
    refundTokenAccountOwner: 'fixture-second-execution-wallet',
  };
  const switchedReturn = {
    ...action('return'),
    nftCustodyAccount: switchedBinding.executionWallet,
    binding: switchedBinding,
  };

  assert.throws(
    () => completeAction(runner, 'return', 'cycle-1', { preparedAction: switchedReturn }),
    /cycle.*wallet|wallet.*cycle|action policy/i,
  );
});

test('rejects a later finalized fixture receipt below the earlier action height on the same chain', () => {
  // outbound and return both settle on the Robinhood chain; purchase and buyback both settle on Solana.
  // Monotonicity is only meaningful within a chain, so the two same-chain heights (outbound then return)
  // must be increasing, while the interleaved cross-chain heights (purchase, buyback) are independent.
  const runner = fixtureRunner();
  generateCollectorPackAuthorized(runner, 'cycle-1');
  completeAction(runner, 'outbound', 'cycle-1', { blockHeight: '17' });
  runner.advanceCycleState({ expectedVersion: 0, expectedJournalHead: runner.entries.at(-1).digest, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', 'cycle-1', { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: 1, expectedJournalHead: runner.entries.at(-1).digest, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, 'cycle-1');
  completePostOpenBuyback(runner, 'cycle-1', { blockHeight: '16' });
  runner.advanceCycleState({ expectedVersion: 3, expectedJournalHead: runner.entries.at(-1).digest, next: 'buyback-finalized' });

  assert.throws(
    () => completeAction(runner, 'return', 'cycle-1', { blockHeight: '15' }),
    /finalized.*height|height.*finalized/i,
  );
});

test('does not compare finalized block heights across the Robinhood and Solana chains', () => {
  // The mirror of the test above: a same-chain height that stays monotone on its OWN chain must not be
  // rejected just because it is lower than an unrelated action's height on the OTHER chain. Before this
  // work package every action kind shared one chain key, so this exact interleaving (return=12 landing
  // after a Solana-chain buyback=19) would have spuriously failed; see HK-026 and chainKeyForReceipt.
  const runner = fixtureRunner();
  generateCollectorPackAuthorized(runner, 'cycle-1');
  completeAction(runner, 'outbound', 'cycle-1', { blockHeight: '11' });
  runner.advanceCycleState({ expectedVersion: 0, expectedJournalHead: runner.entries.at(-1).digest, next: 'outbound-finalized' });
  completeAction(runner, 'purchase', 'cycle-1', { blockHeight: '15' });
  runner.advanceCycleState({ expectedVersion: 1, expectedJournalHead: runner.entries.at(-1).digest, next: 'purchase-finalized' });
  reconcileCollectorOpen(runner, 'cycle-1');
  completePostOpenBuyback(runner, 'cycle-1', { blockHeight: '19' });
  runner.advanceCycleState({ expectedVersion: 3, expectedJournalHead: runner.entries.at(-1).digest, next: 'buyback-finalized' });

  // return=12 is monotone against its own chain's prior height (outbound=11) even though it is below
  // the unrelated Solana-chain buyback height (19) — the two chains are never compared.
  assert.doesNotThrow(() => completeAction(runner, 'return', 'cycle-1', { blockHeight: '12' }));
});
