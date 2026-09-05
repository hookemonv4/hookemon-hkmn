import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { validateBinding, validateCycleCustody } from './bindings.mjs';
import { canonicalJson, digest, RECOVERY_LIMITS } from './journal.mjs';

export const FIXTURE_ACTION_KINDS = Object.freeze(['outbound', 'purchase', 'buyback', 'return']);
export const FIXTURE_AUTHORIZATION_KINDS = Object.freeze(['mutation', 'sign', 'broadcast', 'asset-spend', 'gas-spend']);
const FIXTURE_FEE_PAYER = 'fixture-fee-payer';
const FIXTURE_OPERATIONS_TRIGGER = '0x0000000000000000000000000000000000001004';
const FIXTURE_CYCLE_VAULT_ACCOUNT = '0x0000000000000000000000000000000000001002';
const FIXTURE_POLICY_ACCOUNT = 'fixture-solana-policy-account';
const FIXTURE_CIRCLE_DOLLAR_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FIXTURE_NFT_MINT = 'fixture-nft-mint';
// The two chains a cycle actually touches: outbound (Robinhood Chain USDG -> Solana Circle USD via Relay) and
// return (Solana Circle USD -> Robinhood Chain USDG) are bridge legs that execute on the Robinhood chain;
// purchase and buyback are Collector Crypt operations that execute on Solana. `chain` carries the
// CAIP-2-style network identifier and is also the key `preflight.nativeGasCaps` and the reducer's
// per-chain native-gas accounting are bucketed by (see nativeGasChainForActionKind below), `domain` the
// internal fixture namespace, and `cluster` a human-readable network label. Every action/receipt kind is
// validated against its own explicit triple (assertFixtureAction, assertVerifiedProviderReceipt) instead
// of every kind being forced onto the same 'solana'/'mainnet-beta' pair.
export const BRIDGE_CHAIN_IDS = Object.freeze({
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  robinhood: 'eip155:4663',
});
const FIXTURE_ACTION_CHAIN_IDENTITY = Object.freeze({
  outbound: Object.freeze({ chain: BRIDGE_CHAIN_IDS.robinhood, domain: 'hookemon.robinhood.mainnet.v1', cluster: 'robinhood-mainnet', nativeGasChain: 'robinhood' }),
  purchase: Object.freeze({ chain: BRIDGE_CHAIN_IDS.solana, domain: 'hookemon.solana.mainnet.v1', cluster: 'mainnet-beta', nativeGasChain: 'solana' }),
  buyback: Object.freeze({ chain: BRIDGE_CHAIN_IDS.solana, domain: 'hookemon.solana.mainnet.v1', cluster: 'mainnet-beta', nativeGasChain: 'solana' }),
  return: Object.freeze({ chain: BRIDGE_CHAIN_IDS.robinhood, domain: 'hookemon.robinhood.mainnet.v1', cluster: 'robinhood-mainnet', nativeGasChain: 'robinhood' }),
});

export function nativeGasChainForActionKind(actionKind) {
  const identity = FIXTURE_ACTION_CHAIN_IDENTITY[actionKind];
  if (!identity) throw new Error('fixture action kind is invalid');
  return identity.nativeGasChain;
}

// Read-only accessor for the {chain, domain, cluster} triple a given action kind must carry — used by
// fixture builders (packages/runner/test/cycle/fixture-cycle.mjs and friends) so tests derive the
// correct bridge-leg vs Collector Crypt chain identity from the same source of truth this module
// enforces, instead of hand-duplicating the literals.
export function fixtureActionChainIdentity(actionKind) {
  const identity = FIXTURE_ACTION_CHAIN_IDENTITY[actionKind];
  if (!identity) throw new Error('fixture action kind is invalid');
  return { chain: identity.chain, domain: identity.domain, cluster: identity.cluster };
}

const FIXTURE_ACTION_POLICY = Object.freeze({
  outbound: Object.freeze({ sourceAccount: 'cycle.returnAccount', inputAsset: 'USDG', outputAsset: FIXTURE_CIRCLE_DOLLAR_MINT, tokenAccount: 'fixture-token-outbound', destination: FIXTURE_POLICY_ACCOUNT }),
  purchase: Object.freeze({ sourceAccount: FIXTURE_POLICY_ACCOUNT, inputAsset: FIXTURE_CIRCLE_DOLLAR_MINT, outputAsset: 'collector-pack-nft', tokenAccount: 'fixture-token-purchase', destination: 'fixture-destination-purchase', nftMint: 'fixture-pack-token-mint', nftCustodyAccount: 'fixture-pack-token-account' }),
  buyback: Object.freeze({ sourceAccount: 'fixture-destination-purchase', inputAsset: FIXTURE_NFT_MINT, outputAsset: FIXTURE_CIRCLE_DOLLAR_MINT, tokenAccount: 'fixture-token-buyback', destination: 'binding.refundTokenAccount' }),
  return: Object.freeze({ sourceAccount: 'binding.refundTokenAccount', inputAsset: FIXTURE_CIRCLE_DOLLAR_MINT, outputAsset: 'USDG', tokenAccount: 'fixture-token-return', destination: 'cycle.returnAccount' }),
});
const actionFields = ['schema', 'cycleId', 'actionKind', 'preflightDigest', 'operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount', 'principalAmount', 'minimumReceive', 'nativeGasAmount', 'provider', 'chain', 'domain', 'cluster', 'instructions', 'signers', 'feePayer', 'sourceAccount', 'inputAsset', 'outputAsset', 'mint', 'tokenAccount', 'destination', 'nftMint', 'nftCustodyAccount', 'amount', 'memo', 'validity', 'binding'];
const instructionFields = ['program', 'accounts', 'data'];
const accountFields = ['address', 'isSigner', 'isWritable'];
const signerFields = ['address', 'isFeePayer'];
const validityFields = ['recentBlockhash', 'currentHeight', 'lastValidHeight'];
const approvalFields = ['schema', 'fixtureOwner', 'cycleId', 'actionKind', 'authorizationKind', 'subjectDigest', 'preflightDigest', 'operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount', 'principalAmount', 'minimumReceive', 'nativeGasAmount', 'provider', 'actionDigest', 'bindingDigest', 'sourceAccount', 'inputAsset', 'outputAsset', 'destination', 'mint', 'nftMint', 'nftCustodyAccount', 'amount', 'instructionsDigest', 'signersDigest', 'nonce', 'attempt', 'expiry', 'fixtureApprovalDigest', 'fixtureApprovalSignature'];
const postOpenBuybackApprovalFields = ['schema', 'fixtureOwner', 'cycleId', 'actionDigest', 'collectorPrizeWallet', 'currentOwner', 'eligibility', 'refundAmount', 'minimumReceive', 'mint', 'tokenAccount', 'destination', 'nonce', 'expiry', 'fixtureApprovalDigest', 'fixtureApprovalSignature'];
const receiptFields = ['schema', 'cycleId', 'actionKind', 'provider', 'providerReceiptId', 'chain', 'cluster', 'actionDigest', 'messageDigest', 'transactionSignature', 'blockHeight', 'blockHash', 'finalized', 'relation', 'fixtureVerificationDigest', 'fixtureVerificationSignature'];
const transferFields = ['sourceAccount', 'destinationAccount', 'inputAsset', 'outputAsset', 'preSourceBalance', 'postSourceBalance', 'preDestinationBalance', 'postDestinationBalance', 'amountIn', 'amountOut'];
const custodyFields = [...transferFields, 'nftMint', 'nftCustodyAccount', 'preNftBalance', 'postNftBalance'];
const buybackCustodyFields = [...custodyFields, 'nftDestinationAccount', 'preNftDestinationBalance', 'postNftDestinationBalance'];
const decimal = /^(?:0|[1-9][0-9]*)$/;
const positiveDecimal = /^(?:[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const hex = /^(?:[0-9a-f]{2})+$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const base64urlSignature = /^[A-Za-z0-9_-]{86}$/;
const providerPublicKey = createPublicKey({ key: Buffer.from('302a300506032b65700321000378aa0da09b0890aeaf8c5a34a64834ce852dca35722fcafc12d0fcf1dddfd1', 'hex'), format: 'der', type: 'spki' });

// Production-provider identity pinned per action kind: Collector Crypt executes purchase/buyback on
// Solana; Relay executes the outbound/return bridge legs observed on the Robinhood chain. Unlike the
// single hardcoded 'fixture-provider' literal, this is a per-action-kind table because a real cycle
// touches two structurally different providers, never one.
export const PRODUCTION_PROVIDERS = Object.freeze({ outbound: 'relay', purchase: 'collector-crypt', buyback: 'collector-crypt', return: 'relay' });

export function assertPlainObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  canonicalJson(value);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) throw new Error(`${label} must use the exact schema`);
  return value;
}

export function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`${label} is invalid`);
}

function assertBase64urlSignature(value, label) {
  if (typeof value !== 'string' || !base64urlSignature.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error(`${label} is invalid`);
}

export function assertDecimal(value, label, positive = false) {
  if (typeof value !== 'string' || !(positive ? positiveDecimal : decimal).test(value)) throw new Error(`${label} is invalid`);
}

export function assertInstructions(instructions) {
  if (!Array.isArray(instructions) || Object.getPrototypeOf(instructions) !== Array.prototype || instructions.length === 0) throw new Error('fixture action instructions are invalid');
  for (const instruction of instructions) {
    assertPlainObject(instruction, instructionFields, 'fixture instruction');
    assertIdentifier(instruction.program, 'fixture instruction program');
    if (typeof instruction.data !== 'string' || !hex.test(instruction.data)) throw new Error('fixture instruction data is invalid');
    if (!Array.isArray(instruction.accounts) || instruction.accounts.length === 0) throw new Error('fixture instruction accounts are invalid');
    for (const account of instruction.accounts) {
      assertPlainObject(account, accountFields, 'fixture instruction account');
      assertIdentifier(account.address, 'fixture account address');
      if (typeof account.isSigner !== 'boolean' || typeof account.isWritable !== 'boolean') throw new Error('fixture account flags are invalid');
    }
  }
}

export function assertSigners(signers, instructions, feePayer) {
  if (!Array.isArray(signers) || signers.length === 0) throw new Error('fixture action signers are invalid');
  const addresses = [];
  for (const signer of signers) {
    assertPlainObject(signer, signerFields, 'fixture signer');
    assertIdentifier(signer.address, 'fixture signer address');
    if (typeof signer.isFeePayer !== 'boolean') throw new Error('fixture signer fee-payer flag is invalid');
    addresses.push(signer.address);
  }
  if (new Set(addresses).size !== addresses.length) throw new Error('fixture signers must be unique and ordered');
  const instructionSigners = [];
  for (const instruction of instructions) for (const account of instruction.accounts) if (account.isSigner && !instructionSigners.includes(account.address)) instructionSigners.push(account.address);
  if (canonicalJson(addresses) !== canonicalJson(instructionSigners)) throw new Error('fixture ordered signers do not match instruction account flags');
  if (signers.filter(signer => signer.isFeePayer).length !== 1 || !signers.some(signer => signer.address === feePayer && signer.isFeePayer)) throw new Error('fixture fee payer is invalid');
}

function assertFixtureActionPolicy(value, binding) {
  const policy = FIXTURE_ACTION_POLICY[value.actionKind];
  const sourceAccount = policy.sourceAccount === 'binding.refundTokenAccount' ? binding.refundTokenAccount
    : policy.sourceAccount === 'cycle.returnAccount' ? value.returnAccount : policy.sourceAccount;
  const destination = policy.destination === 'binding.refundTokenAccount' ? binding.refundTokenAccount
    : policy.destination === 'cycle.returnAccount' ? value.returnAccount : policy.destination;
  const nftMint = policy.nftMint ?? FIXTURE_NFT_MINT;
  const nftCustodyAccount = policy.nftCustodyAccount ?? binding.executionWallet;
  const accounts = [
    { address: FIXTURE_FEE_PAYER, isSigner: true, isWritable: true },
    { address: policy.tokenAccount, isSigner: false, isWritable: true },
    { address: destination, isSigner: false, isWritable: true },
  ];
  const instruction = { program: 'fixture-program', accounts, data: `01${Buffer.from(value.actionKind).toString('hex')}` };
  // Buyback spends exactly one NFT unit (the pack just opened), never a Circle-USD-denominated amount — the
  // Circle USD side of a buyback is the *proceeds* (minimumReceive is its floor, checked separately below and
  // against the finalized receipt/accounting elsewhere), not the "amount" being spent. Every other
  // action kind spends a Circle-USD-denominated amount, so only buyback's expected amount differs here; this
  // keeps the NFT unit quantity and the Circle USD refund amount on two separate fields with two separate
  // checks instead of conflating them under one "amount" that meant different units for different kinds.
  const expectedAmount = value.actionKind === 'buyback' ? '1' : '10';
  if (
    value.provider !== 'fixture-provider'
    || value.operationsTrigger !== FIXTURE_OPERATIONS_TRIGGER
    || value.cycleVaultAccount !== FIXTURE_CYCLE_VAULT_ACCOUNT
    || value.policyAccount !== FIXTURE_POLICY_ACCOUNT
    || value.principalAmount !== '10'
    || value.minimumReceive !== '10'
    || value.nativeGasAmount !== '1'
    || value.feePayer !== FIXTURE_FEE_PAYER
    || !sameCanonical(value.signers, [{ address: FIXTURE_FEE_PAYER, isFeePayer: true }])
    || !sameCanonical(value.instructions, [instruction])
    || value.sourceAccount !== sourceAccount
    || value.inputAsset !== policy.inputAsset
    || value.outputAsset !== policy.outputAsset
    || value.mint !== FIXTURE_CIRCLE_DOLLAR_MINT
    || value.tokenAccount !== policy.tokenAccount
    || value.destination !== destination
    || value.nftMint !== nftMint
    || value.nftCustodyAccount !== nftCustodyAccount
    || value.amount !== expectedAmount
  ) throw new Error('fixture action policy is invalid');
}

export function assertActionCollectionBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return;
  const instructions = Object.getOwnPropertyDescriptor(value, 'instructions')?.value;
  const signers = Object.getOwnPropertyDescriptor(value, 'signers')?.value;
  if (Array.isArray(instructions) && instructions.length > RECOVERY_LIMITS.instructions) throw new Error('fixture instruction count limit exceeded');
  if (Array.isArray(signers) && signers.length > RECOVERY_LIMITS.signers) throw new Error('fixture signer count limit exceeded');
  if (Array.isArray(instructions)) for (const instruction of instructions) {
    if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction)) continue;
    const accounts = Object.getOwnPropertyDescriptor(instruction, 'accounts')?.value;
    const data = Object.getOwnPropertyDescriptor(instruction, 'data')?.value;
    if (Array.isArray(accounts) && accounts.length > RECOVERY_LIMITS.accountsPerInstruction) throw new Error('fixture instruction account count limit exceeded');
    if (typeof data === 'string' && data.length > RECOVERY_LIMITS.hexChars) throw new Error('fixture instruction data hex byte limit exceeded');
  }
  for (const field of ['principalAmount', 'minimumReceive', 'nativeGasAmount', 'amount']) {
    const decimalValue = Object.getOwnPropertyDescriptor(value, field)?.value;
    if (typeof decimalValue === 'string' && decimalValue.length > RECOVERY_LIMITS.decimalDigits) throw new Error(`fixture action ${field} decimal digit limit exceeded`);
  }
}

export function assertFixtureAction(value) {
  assertActionCollectionBounds(value);
  assertPlainObject(value, actionFields, 'fixture action');
  if (value.schema !== 'hookemon.fixture-action.v1' || !FIXTURE_ACTION_KINDS.includes(value.actionKind)) throw new Error('fixture action discriminator is invalid');
  assertIdentifier(value.cycleId, 'fixture action cycle');
  assertDigest(value.preflightDigest, 'fixture action preflight digest');
  const custody = validateCycleCustody({
    operationsTrigger: value.operationsTrigger,
    cycleVaultAccount: value.cycleVaultAccount,
    policyAccount: value.policyAccount,
    returnAccount: value.returnAccount,
  });
  for (const field of ['principalAmount', 'minimumReceive', 'nativeGasAmount']) assertDecimal(value[field], `fixture action ${field}`, true);
  if (typeof value.provider !== 'string' || !/^[a-z0-9-]{2,64}$/.test(value.provider)) throw new Error('fixture action provider is invalid');
  const chainIdentity = FIXTURE_ACTION_CHAIN_IDENTITY[value.actionKind];
  if (value.chain !== chainIdentity.chain || value.domain !== chainIdentity.domain || value.cluster !== chainIdentity.cluster) throw new Error('fixture action chain domain is invalid');
  assertInstructions(value.instructions);
  assertIdentifier(value.feePayer, 'fixture fee payer');
  assertSigners(value.signers, value.instructions, value.feePayer);
  for (const field of ['sourceAccount', 'inputAsset', 'outputAsset', 'mint', 'tokenAccount', 'destination', 'nftMint', 'nftCustodyAccount']) assertIdentifier(value[field], `fixture action ${field}`);
  assertDecimal(value.amount, 'fixture action amount', true);
  if (value.memo !== `${value.cycleId}:${value.actionKind}`) throw new Error('fixture action memo is invalid');
  assertPlainObject(value.validity, validityFields, 'fixture validity');
  if (typeof value.validity.recentBlockhash !== 'string' || !hex.test(value.validity.recentBlockhash)) throw new Error('fixture recent blockhash is invalid');
  assertDecimal(value.validity.currentHeight, 'fixture current height');
  assertDecimal(value.validity.lastValidHeight, 'fixture last valid height');
  if (BigInt(value.validity.currentHeight) > BigInt(value.validity.lastValidHeight)) throw new Error('fixture validity window is invalid');
  assertPlainObject(value.binding, ['sourceChainId', 'executionCluster', 'circleDollarMint', 'circleDollarDecimals', 'pack', 'quantity', 'turbo', 'executionWallet', 'refundTokenAccount', 'refundTokenAccountOwner'], 'fixture binding');
  const binding = validateBinding(value.binding);
  // `binding` always describes the Collector Crypt Solana-side execution context (constant across every
  // action kind in a cycle), so its executionCluster ('mainnet-beta') is only meaningfully compared
  // against the action's own cluster for the two Collector Crypt kinds that actually execute there —
  // outbound and return execute on the Robinhood chain and are validated against their own chain
  // identity above instead.
  if (binding.circleDollarMint !== value.mint) throw new Error('fixture action does not match binding');
  if ((value.actionKind === 'purchase' || value.actionKind === 'buyback') && binding.executionCluster !== value.cluster) throw new Error('fixture action does not match binding');
  if (binding.executionWallet !== custody.policyAccount || binding.refundTokenAccountOwner !== custody.policyAccount) throw new Error('fixture action policy custody binding is invalid');
  if ([value.sourceAccount, value.destination, value.nftCustodyAccount, binding.executionWallet, binding.refundTokenAccount, binding.refundTokenAccountOwner].includes(custody.operationsTrigger)) throw new Error('fixture action gives Operations custody');
  assertFixtureActionPolicy(value, binding);
  return structuredClone(value);
}

export function fixtureActionDigests(value) {
  const action = assertFixtureAction(value);
  return {
    actionDigest: digest({ domain: 'hookemon.fixture-action.v1', action }),
    bindingDigest: digest({ domain: 'hookemon.fixture-binding.v1', binding: action.binding }),
    instructionsDigest: digest({ domain: 'hookemon.fixture-instructions.v1', instructions: action.instructions }),
    signersDigest: digest({ domain: 'hookemon.fixture-signers.v1', signers: action.signers, feePayer: action.feePayer }),
  };
}

export function assertVerifiedOwnerApproval(value) {
  assertPlainObject(value, approvalFields, 'fixture owner approval');
  if (value.schema !== 'hookemon.fixture-owner-approval.v1' || value.fixtureOwner !== 'fixture-owner' || !FIXTURE_ACTION_KINDS.includes(value.actionKind)) throw new Error('fixture owner approval discriminator is invalid');
  if (!FIXTURE_AUTHORIZATION_KINDS.includes(value.authorizationKind)) throw new Error('fixture owner approval authorization kind is invalid');
  if (typeof value.provider !== 'string' || !/^[a-z0-9-]{2,64}$/.test(value.provider)) throw new Error('fixture owner approval provider is invalid');
  for (const field of ['cycleId', 'operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount', 'sourceAccount', 'inputAsset', 'outputAsset', 'destination', 'mint', 'nftMint', 'nftCustodyAccount', 'nonce']) assertIdentifier(value[field], `fixture owner approval ${field}`);
  validateCycleCustody({ operationsTrigger: value.operationsTrigger, cycleVaultAccount: value.cycleVaultAccount, policyAccount: value.policyAccount, returnAccount: value.returnAccount });
  for (const field of ['subjectDigest', 'preflightDigest', 'actionDigest', 'bindingDigest', 'instructionsDigest', 'signersDigest', 'fixtureApprovalDigest']) assertDigest(value[field], `fixture owner approval ${field}`);
  if (typeof value.fixtureApprovalSignature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(value.fixtureApprovalSignature)) throw new Error('fixture owner approval signature is invalid');
  assertDecimal(value.amount, 'fixture owner approval amount', true);
  for (const field of ['principalAmount', 'minimumReceive', 'nativeGasAmount']) assertDecimal(value[field], `fixture owner approval ${field}`, true);
  if (!Number.isInteger(value.attempt) || value.attempt < 1) throw new Error('fixture owner approval attempt is invalid');
  if (typeof value.expiry !== 'string' || new Date(value.expiry).toISOString() !== value.expiry) throw new Error('fixture owner approval expiry is invalid');
  return structuredClone(value);
}

export function assertVerifiedPostOpenBuybackApproval(value) {
  assertPlainObject(value, postOpenBuybackApprovalFields, 'fixture post-open buyback approval');
  if (value.schema !== 'hookemon.fixture-post-open-buyback-approval.v1' || value.fixtureOwner !== 'fixture-owner' || value.eligibility !== true) throw new Error('fixture post-open buyback approval discriminator is invalid');
  for (const field of ['cycleId', 'collectorPrizeWallet', 'currentOwner', 'mint', 'tokenAccount', 'destination', 'nonce']) assertIdentifier(value[field], `fixture post-open buyback approval ${field}`);
  for (const field of ['actionDigest', 'fixtureApprovalDigest']) assertDigest(value[field], `fixture post-open buyback approval ${field}`);
  if (typeof value.fixtureApprovalSignature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(value.fixtureApprovalSignature)) throw new Error('fixture post-open buyback approval signature is invalid');
  for (const field of ['refundAmount', 'minimumReceive']) assertDecimal(value[field], `fixture post-open buyback approval ${field}`, true);
  if (BigInt(value.minimumReceive) > BigInt(value.refundAmount)) throw new Error('fixture post-open buyback minimum receive is invalid');
  if (typeof value.expiry !== 'string' || new Date(value.expiry).toISOString() !== value.expiry) throw new Error('fixture post-open buyback approval expiry is invalid');
  return structuredClone(value);
}

function receiptPayload(value) {
  assertPlainObject(value, receiptFields, 'fixture provider receipt');
  const { fixtureVerificationDigest, fixtureVerificationSignature, ...payload } = value;
  return payload;
}

export function fixtureReceiptVerificationDigest(value) {
  const payload = receiptPayload(value);
  return digest({ domain: 'hookemon.fixture-provider-verification.v1', fixtureProvider: payload.provider, payload });
}

export function assertTransferRelation(relation, actionKind) {
  const custody = actionKind === 'purchase' || actionKind === 'buyback';
  if (
    actionKind === 'buyback'
    && relation
    && typeof relation === 'object'
    && !Array.isArray(relation)
    && !buybackCustodyFields.every(field => Object.hasOwn(relation, field))
  ) throw new Error('fixture buyback NFT destination custody evidence is required');
  const fields = actionKind === 'buyback' ? buybackCustodyFields : custody ? custodyFields : transferFields;
  assertPlainObject(relation, fields, 'fixture receipt relation');
  for (const field of ['sourceAccount', 'destinationAccount', 'inputAsset', 'outputAsset']) assertIdentifier(relation[field], `fixture receipt relation ${field}`);
  for (const field of ['preSourceBalance', 'postSourceBalance', 'preDestinationBalance', 'postDestinationBalance', 'amountIn', 'amountOut']) assertDecimal(relation[field], `fixture receipt relation ${field}`);
  if (BigInt(relation.preSourceBalance) - BigInt(relation.postSourceBalance) !== BigInt(relation.amountIn)) throw new Error('fixture receipt source delta is invalid');
  if (BigInt(relation.postDestinationBalance) - BigInt(relation.preDestinationBalance) !== BigInt(relation.amountOut) || BigInt(relation.amountOut) <= 0n) throw new Error('fixture receipt destination delta is invalid');
  if (custody) {
    assertIdentifier(relation.nftMint, 'fixture receipt NFT mint');
    assertIdentifier(relation.nftCustodyAccount, 'fixture receipt NFT custody account');
    assertDecimal(relation.preNftBalance, 'fixture receipt pre NFT balance');
    assertDecimal(relation.postNftBalance, 'fixture receipt post NFT balance');
  }
  if (actionKind === 'buyback') {
    assertIdentifier(relation.nftDestinationAccount, 'fixture receipt buyback NFT destination account');
    assertDecimal(relation.preNftDestinationBalance, 'fixture receipt pre buyback NFT destination balance');
    assertDecimal(relation.postNftDestinationBalance, 'fixture receipt post buyback NFT destination balance');
  }
}

export function assertVerifiedProviderReceipt(value) {
  receiptPayload(value);
  if (value.schema !== 'hookemon.fixture-provider-receipt.v1' || !FIXTURE_ACTION_KINDS.includes(value.actionKind)) throw new Error('fixture provider receipt discriminator is invalid');
  for (const field of ['cycleId', 'provider', 'providerReceiptId']) assertIdentifier(value[field], `fixture provider receipt ${field}`);
  assertBase64urlSignature(value.transactionSignature, 'fixture provider receipt transactionSignature');
  if (!/^[a-z0-9-]{2,64}$/.test(value.provider) || !/^[A-Za-z0-9-]{1,128}$/.test(value.providerReceiptId)) throw new Error('fixture provider receipt identity is invalid');
  const receiptChainIdentity = FIXTURE_ACTION_CHAIN_IDENTITY[value.actionKind];
  if (value.chain !== receiptChainIdentity.chain || value.cluster !== receiptChainIdentity.cluster) throw new Error('fixture provider receipt chain is invalid');
  for (const field of ['actionDigest', 'messageDigest', 'fixtureVerificationDigest']) assertDigest(value[field], `fixture provider receipt ${field}`);
  if (typeof value.fixtureVerificationSignature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(value.fixtureVerificationSignature)) throw new Error('fixture provider receipt signature is invalid');
  assertDecimal(value.blockHeight, 'fixture provider receipt block height', true);
  if (typeof value.blockHash !== 'string' || !hex.test(value.blockHash)) throw new Error('fixture provider receipt block hash is invalid');
  if (value.finalized !== true) throw new Error('fixture provider receipt must be finalized');
  assertTransferRelation(value.relation, value.actionKind);
  if (value.actionKind === 'purchase' && (value.relation.preNftBalance !== '0' || value.relation.postNftBalance !== '1')) throw new Error('fixture purchase custody delta is invalid');
  if (value.actionKind === 'buyback' && (
    value.relation.preNftBalance !== '1'
    || value.relation.postNftBalance !== '0'
    || value.relation.preNftDestinationBalance !== '0'
    || value.relation.postNftDestinationBalance !== '1'
    || value.relation.nftDestinationAccount === value.relation.nftCustodyAccount
  )) throw new Error('fixture buyback NFT source and destination custody deltas are invalid');
  if (value.fixtureVerificationDigest !== fixtureReceiptVerificationDigest(value)) throw new Error('fixture provider receipt verification is invalid');
  if (value.provider !== 'fixture-provider' || !verifySignature(null, Buffer.from(value.fixtureVerificationDigest, 'utf8'), providerPublicKey, Buffer.from(value.fixtureVerificationSignature, 'base64url'))) throw new Error('fixture provider receipt signature verification is invalid');
  return structuredClone(value);
}

export function receiptIdentityKey(receipt) {
  const verified = assertVerifiedProviderReceipt(receipt);
  return digest({ domain: 'hookemon.fixture-receipt-registry.v1', provider: verified.provider, providerReceiptId: verified.providerReceiptId });
}

export function receiptRegistryRecord(receipt, receiptDigest) {
  const verified = assertVerifiedProviderReceipt(receipt);
  assertDigest(receiptDigest, 'receipt digest');
  return {
    key: receiptIdentityKey(verified),
    provider: verified.provider,
    providerReceiptId: verified.providerReceiptId,
    cycleId: verified.cycleId,
    actionKind: verified.actionKind,
    receiptDigest,
    receiptCommitment: digest({ domain: 'hookemon.fixture-receipt-commitment.v1', receipt: verified }),
  };
}

export function assertReceiptRelationship(receipt, action, execution) {
  const verified = assertVerifiedProviderReceipt(receipt);
  const prepared = assertFixtureAction(action);
  if (verified.cycleId !== prepared.cycleId || verified.actionKind !== prepared.actionKind || verified.provider !== prepared.provider || verified.chain !== prepared.chain || verified.cluster !== prepared.cluster) throw new Error('fixture receipt action relationship is invalid');
  if (verified.actionDigest !== execution.actionDigest || verified.messageDigest !== execution.messageDigest || verified.transactionSignature !== execution.broadcastSignature) throw new Error('fixture receipt execution relationship is invalid');
  if (verified.relation.sourceAccount !== prepared.sourceAccount || verified.relation.destinationAccount !== prepared.destination || verified.relation.inputAsset !== prepared.inputAsset || verified.relation.outputAsset !== prepared.outputAsset || verified.relation.amountIn !== prepared.amount) throw new Error('fixture receipt balance relationship is invalid');
  if (BigInt(verified.relation.amountOut) < BigInt(prepared.minimumReceive)) throw new Error('fixture receipt output is below the approved minimum receive');
  if ((prepared.actionKind === 'purchase' || prepared.actionKind === 'buyback') && (verified.relation.nftMint !== prepared.nftMint || verified.relation.nftCustodyAccount !== prepared.nftCustodyAccount)) throw new Error('fixture receipt NFT custody relationship is invalid');
  if (prepared.actionKind === 'buyback' && verified.relation.nftDestinationAccount !== prepared.sourceAccount) throw new Error('fixture buyback NFT destination is not bound to the signed transaction message');
  if (BigInt(verified.blockHeight) < BigInt(prepared.validity.currentHeight) || BigInt(verified.blockHeight) > BigInt(prepared.validity.lastValidHeight)) throw new Error('fixture receipt block is outside the approved validity window');
  return verified;
}

export function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

// ---------------------------------------------------------------------------------------------------
// Production evidence schemas (WP-31). These mirror the fixture schemas above field-for-field wherever
// the shape is genuinely provider-agnostic (custody separation, instruction/signer structure, transfer
// relation deltas — assertInstructions/assertSigners/assertTransferRelation/validateBinding/
// validateCycleCustody are already policy-agnostic and are reused unchanged), and differ only where the
// fixture path pinned one hardcoded literal transaction/signature (FIXTURE_ACTION_POLICY, the fixture
// Ed25519 provider key): a production action's instruction bytes come from an injected provider adapter
// (packages/adapters, out of this module's writeSet) and are trusted structurally rather than matched
// byte-for-byte against one canned transaction, and a production receipt is trusted only once an
// injected, independent chain observer confirms it — never a bundled signature. Every function here is
// a pure addition; nothing above this line is modified in behavior.
const productionHexBlockHash = /^(?:0x)?(?:[0-9a-f]{2})+$/;
// Transaction-signature-shaped strings (base58 Solana signatures, base64url signatures, 0x-hex EVM
// transaction hashes) are opaque blobs, not account-name-like identifiers — unlike assertIdentifier,
// nothing here requires an alphanumeric first character, since a base64url/base58 encoding routinely
// starts with '-', '_', or any other alphabet character.
export function assertTransactionSignatureLike(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
}

export function assertProductionAction(value) {
  assertActionCollectionBounds(value);
  assertPlainObject(value, actionFields, 'production action');
  if (value.schema !== 'hookemon.production-action.v1' || !FIXTURE_ACTION_KINDS.includes(value.actionKind)) throw new Error('production action discriminator is invalid');
  assertIdentifier(value.cycleId, 'production action cycle');
  assertDigest(value.preflightDigest, 'production action preflight digest');
  const custody = validateCycleCustody({
    operationsTrigger: value.operationsTrigger,
    cycleVaultAccount: value.cycleVaultAccount,
    policyAccount: value.policyAccount,
    returnAccount: value.returnAccount,
  });
  for (const field of ['principalAmount', 'nativeGasAmount']) assertDecimal(value[field], `production action ${field}`, true);
  assertDecimal(value.minimumReceive, 'production action minimumReceive', value.actionKind !== 'return');
  if (value.provider !== PRODUCTION_PROVIDERS[value.actionKind]) throw new Error('production action provider is invalid');
  const chainIdentity = FIXTURE_ACTION_CHAIN_IDENTITY[value.actionKind];
  if (value.chain !== chainIdentity.chain || value.domain !== chainIdentity.domain || value.cluster !== chainIdentity.cluster) throw new Error('production action chain domain is invalid');
  assertInstructions(value.instructions);
  assertIdentifier(value.feePayer, 'production fee payer');
  assertSigners(value.signers, value.instructions, value.feePayer);
  for (const field of ['sourceAccount', 'inputAsset', 'outputAsset', 'mint', 'tokenAccount', 'destination', 'nftMint', 'nftCustodyAccount']) assertIdentifier(value[field], `production action ${field}`);
  assertDecimal(value.amount, 'production action amount', true);
  if (value.memo !== `${value.cycleId}:${value.actionKind}`) throw new Error('production action memo is invalid');
  assertPlainObject(value.validity, validityFields, 'production validity');
  if (typeof value.validity.recentBlockhash !== 'string' || !hex.test(value.validity.recentBlockhash)) throw new Error('production recent blockhash is invalid');
  assertDecimal(value.validity.currentHeight, 'production current height');
  assertDecimal(value.validity.lastValidHeight, 'production last valid height');
  if (BigInt(value.validity.currentHeight) > BigInt(value.validity.lastValidHeight)) throw new Error('production validity window is invalid');
  assertPlainObject(value.binding, ['sourceChainId', 'executionCluster', 'circleDollarMint', 'circleDollarDecimals', 'pack', 'quantity', 'turbo', 'executionWallet', 'refundTokenAccount', 'refundTokenAccountOwner'], 'production binding');
  const binding = validateBinding(value.binding);
  if (binding.circleDollarMint !== value.mint) throw new Error('production action does not match binding');
  if ((value.actionKind === 'purchase' || value.actionKind === 'buyback') && binding.executionCluster !== value.cluster) throw new Error('production action does not match binding');
  if (binding.executionWallet !== custody.policyAccount || binding.refundTokenAccountOwner !== custody.policyAccount) throw new Error('production action policy custody binding is invalid');
  if ([value.sourceAccount, value.destination, value.nftCustodyAccount, binding.executionWallet, binding.refundTokenAccount, binding.refundTokenAccountOwner].includes(custody.operationsTrigger)) throw new Error('production action gives Operations custody');
  return structuredClone(value);
}

export function productionActionDigests(value) {
  const action = assertProductionAction(value);
  return {
    actionDigest: digest({ domain: 'hookemon.production-action.v1', action }),
    bindingDigest: digest({ domain: 'hookemon.production-binding.v1', binding: action.binding }),
    instructionsDigest: digest({ domain: 'hookemon.production-instructions.v1', instructions: action.instructions }),
    signersDigest: digest({ domain: 'hookemon.production-signers.v1', signers: action.signers, feePayer: action.feePayer }),
  };
}

const productionReceiptFields = ['schema', 'cycleId', 'actionKind', 'provider', 'providerReceiptId', 'chain', 'cluster', 'actionDigest', 'messageDigest', 'transactionSignature', 'blockHeight', 'blockHash', 'finalized', 'relation', 'apiResponseDigest'];
const observerConfirmationFields = ['schema', 'chain', 'cluster', 'transactionSignature', 'finalized', 'blockHeight', 'blockHash', 'programId', 'payer', 'relation'];

// The shape a chain observer (packages/adapters solana-rpc.mjs / robinhood-rpc.mjs, injected — never
// imported here) must hand back after independently confirming a transaction: its own account of what
// actually happened on chain, in the exact `relation` shape assertTransferRelation already validates.
export function assertProductionObserverConfirmation(value, actionKind) {
  assertPlainObject(value, observerConfirmationFields, 'production observer confirmation');
  if (value.schema !== 'hookemon.production-observer-confirmation.v1') throw new Error('production observer confirmation discriminator is invalid');
  const chainIdentity = FIXTURE_ACTION_CHAIN_IDENTITY[actionKind];
  if (!chainIdentity) throw new Error('production observer confirmation action kind is invalid');
  if (value.chain !== chainIdentity.chain || value.cluster !== chainIdentity.cluster) throw new Error('production observer confirmation chain is invalid');
  assertTransactionSignatureLike(value.transactionSignature, 'production observer confirmation transaction signature');
  if (value.finalized !== true) throw new Error('production observer confirmation must be finalized');
  assertDecimal(value.blockHeight, 'production observer confirmation block height', true);
  if (typeof value.blockHash !== 'string' || !productionHexBlockHash.test(value.blockHash)) throw new Error('production observer confirmation block hash is invalid');
  assertIdentifier(value.programId, 'production observer confirmation program id');
  assertIdentifier(value.payer, 'production observer confirmation payer');
  assertTransferRelation(value.relation, actionKind);
  return structuredClone(value);
}

// Structural-only shape check (no observer call): reused by receipt-identity/registry helpers that must
// stay cheap and side-effect-free once a receipt has already passed assertVerifiedProductionProviderReceipt
// once, instead of re-invoking a live chain observer on every subsequent read.
function productionReceiptPayload(value) {
  const receipt = assertPlainObject(value, productionReceiptFields, 'production provider receipt');
  if (receipt.schema !== 'hookemon.production-provider-receipt.v1' || !FIXTURE_ACTION_KINDS.includes(receipt.actionKind)) throw new Error('production provider receipt discriminator is invalid');
  assertIdentifier(receipt.cycleId, 'production provider receipt cycle');
  if (receipt.provider !== PRODUCTION_PROVIDERS[receipt.actionKind]) throw new Error('production provider receipt provider is invalid');
  if (typeof receipt.providerReceiptId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(receipt.providerReceiptId)) throw new Error('production provider receipt id is invalid');
  assertTransactionSignatureLike(receipt.transactionSignature, 'production provider receipt transaction signature');
  const chainIdentity = FIXTURE_ACTION_CHAIN_IDENTITY[receipt.actionKind];
  if (receipt.chain !== chainIdentity.chain || receipt.cluster !== chainIdentity.cluster) throw new Error('production provider receipt chain is invalid');
  for (const field of ['actionDigest', 'messageDigest', 'apiResponseDigest']) assertDigest(receipt[field], `production provider receipt ${field}`);
  assertDecimal(receipt.blockHeight, 'production provider receipt block height', true);
  if (typeof receipt.blockHash !== 'string' || !productionHexBlockHash.test(receipt.blockHash)) throw new Error('production provider receipt block hash is invalid');
  if (receipt.finalized !== true) throw new Error('production provider receipt must be finalized');
  assertTransferRelation(receipt.relation, receipt.actionKind);
  if (receipt.actionKind === 'purchase' && (receipt.relation.preNftBalance !== '0' || receipt.relation.postNftBalance !== '1')) throw new Error('production purchase custody delta is invalid');
  if (receipt.actionKind === 'buyback' && (
    receipt.relation.preNftBalance !== '1'
    || receipt.relation.postNftBalance !== '0'
    || receipt.relation.preNftDestinationBalance !== '0'
    || receipt.relation.postNftDestinationBalance !== '1'
    || receipt.relation.nftDestinationAccount === receipt.relation.nftCustodyAccount
  )) throw new Error('production buyback NFT source and destination custody deltas are invalid');
  return structuredClone(receipt);
}

// Verifies a production provider receipt by independently re-deriving it from chain state through the
// injected observer, rather than trusting a bundled signature: `deps.observers` supplies `{ solana, evm }`
// clients (each `{ confirmTransaction(request) -> confirmation }`, synchronous — the caller resolves any
// live RPC round trip before invoking this, exactly as CycleRunner's other injected clients are already
// pre-resolved data, never a live network dependency of the deterministic core itself); `deps.programIds`
// pins the expected on-chain program/contract identity per action kind (a configuration value, validated
// here, never guessed — see docs/modules/cycle-runner.md).
export function assertVerifiedProductionProviderReceipt(value, deps = {}) {
  const receipt = productionReceiptPayload(value);
  const { observers, programIds } = deps;
  if (!observers || typeof observers !== 'object') throw new Error('injected chain observers are required to verify a production provider receipt');
  if (!programIds || typeof programIds !== 'object') throw new Error('pinned program/contract identities are required to verify a production provider receipt');
  const expectedProgramId = programIds[receipt.actionKind];
  if (typeof expectedProgramId !== 'string' || expectedProgramId.length === 0) throw new Error(`pinned program/contract identity for ${receipt.actionKind} is missing`);
  const observerKey = receipt.chain === BRIDGE_CHAIN_IDS.solana ? 'solana' : 'evm';
  const observer = observers[observerKey];
  if (!observer || typeof observer.confirmTransaction !== 'function') throw new Error(`injected ${observerKey} chain observer is required to verify a production provider receipt`);
  const rawConfirmation = observer.confirmTransaction({ cycleId: receipt.cycleId, actionKind: receipt.actionKind, transactionSignature: receipt.transactionSignature });
  if (!rawConfirmation) throw new Error('production provider receipt transaction was never confirmed by the injected chain observer');
  const confirmation = assertProductionObserverConfirmation(rawConfirmation, receipt.actionKind);
  if (
    confirmation.transactionSignature !== receipt.transactionSignature
    || confirmation.blockHeight !== receipt.blockHeight
    || confirmation.blockHash !== receipt.blockHash
    || !sameCanonical(confirmation.relation, receipt.relation)
  ) throw new Error('production provider receipt does not match the injected chain observer confirmation');
  if (confirmation.programId !== expectedProgramId) throw new Error('production provider receipt observed program id does not match the pinned configuration');
  return receipt;
}

export function productionReceiptIdentityKey(receipt) {
  const verified = productionReceiptPayload(receipt);
  return digest({ domain: 'hookemon.production-receipt-registry.v1', provider: verified.provider, providerReceiptId: verified.providerReceiptId });
}

export function productionReceiptRegistryRecord(receipt, receiptDigest) {
  const verified = productionReceiptPayload(receipt);
  assertDigest(receiptDigest, 'receipt digest');
  return {
    key: productionReceiptIdentityKey(verified),
    provider: verified.provider,
    providerReceiptId: verified.providerReceiptId,
    cycleId: verified.cycleId,
    actionKind: verified.actionKind,
    receiptDigest,
    receiptCommitment: digest({ domain: 'hookemon.production-receipt-commitment.v1', receipt: verified }),
  };
}

export function assertProductionReceiptRelationship(receipt, action, execution) {
  const verified = productionReceiptPayload(receipt);
  const prepared = assertProductionAction(action);
  if (verified.cycleId !== prepared.cycleId || verified.actionKind !== prepared.actionKind || verified.provider !== prepared.provider || verified.chain !== prepared.chain || verified.cluster !== prepared.cluster) throw new Error('production receipt action relationship is invalid');
  if (verified.actionDigest !== execution.actionDigest || verified.messageDigest !== execution.messageDigest || verified.transactionSignature !== execution.broadcastSignature) throw new Error('production receipt execution relationship is invalid');
  if (verified.relation.sourceAccount !== prepared.sourceAccount || verified.relation.destinationAccount !== prepared.destination || verified.relation.inputAsset !== prepared.inputAsset || verified.relation.outputAsset !== prepared.outputAsset || verified.relation.amountIn !== prepared.amount) throw new Error('production receipt balance relationship is invalid');
  if (BigInt(verified.relation.amountOut) < BigInt(prepared.minimumReceive)) throw new Error('production receipt output is below the approved minimum receive');
  if ((prepared.actionKind === 'purchase' || prepared.actionKind === 'buyback') && (verified.relation.nftMint !== prepared.nftMint || verified.relation.nftCustodyAccount !== prepared.nftCustodyAccount)) throw new Error('production receipt NFT custody relationship is invalid');
  if (prepared.actionKind === 'buyback' && verified.relation.nftDestinationAccount !== prepared.sourceAccount) throw new Error('production buyback NFT destination is not bound to the signed transaction message');
  if (BigInt(verified.blockHeight) < BigInt(prepared.validity.currentHeight) || BigInt(verified.blockHeight) > BigInt(prepared.validity.lastValidHeight)) throw new Error('production receipt block is outside the approved validity window');
  return verified;
}
