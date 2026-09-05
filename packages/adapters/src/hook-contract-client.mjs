// Typed viem calls against the peg-cycle contracts: `PegCycleVault`
// (packages/contracts/src/process/PegCycleVault.sol, implementing
// packages/contracts/src/process/IPegCycleVault.sol) and the hook contract
// (packages/contracts/src/HookemonHook.sol, which exposes `openPegCycle` via
// packages/contracts/src/process/ProcessBudget.sol and `fundPayoutFromPegCycle` via
// packages/contracts/src/payout/PayoutCommitment.sol).
//
// Every ABI fragment below is transcribed directly from those Solidity interfaces (struct field
// order, parameter types, and names all match the source exactly) and every function selector is
// independently cross-checked in test/hook-contract-client.test.mjs against `cast sig` (Foundry,
// a completely separate tool from viem) computed from the equivalent canonical Solidity signature
// — so an accidental field-order or type transcription error cannot silently produce calldata a
// real deployment would reject.
//
// This module only builds and decodes calldata; it never signs or broadcasts. `build*Call`
// returns `{ to, data, abi, functionName, args }` for an injected signerClient (outside this
// package's boundary, see packages/adapters/README.md) to sign and this package's
// robinhood-rpc.mjs `sendRawTransaction` to broadcast. `read*` functions take an injected viem
// PublicClient (see robinhood-rpc.mjs's `createRobinhoodClient`) and perform a real state read.
//
// Naming note (`consumePayoutAuthorization`): `PegCycleVault.consumePayoutAuthorization` itself
// is `msg.sender == hook`-gated (see IPegCycleVault.sol / PegCycleVault.sol) — it is never
// directly callable by an EOA or an off-chain signer. The actual external entrypoint the cycle
// data flow's operations trigger calls is the hook's `fundPayoutFromPegCycle`, which invokes
// `consumePayoutAuthorization` internally. `buildFundPayoutFromPegCycleCall` is exported under
// that real name; `buildConsumePayoutAuthorizationCall` is kept as a documented alias to the name
// used in design.md §4.5 / PLAN.json's WP-10 step list, so a reader searching for that exact term
// finds the real entrypoint rather than a dead end.

import { encodeFunctionData, getAddress, isAddress, parseAbi } from 'viem';

function assertAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${label} must be a valid EVM address, got ${JSON.stringify(value)}`);
  }
  return getAddress(value);
}

function assertNonzeroBytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error(`${label} must be a nonzero bytes32 value`);
  }
  return value;
}

function assertPositiveAtomic(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a canonical positive atomic-unit string`);
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// ABI — struct declarations match IPegCycleVault.sol field-for-field, in declaration order.
// ---------------------------------------------------------------------------

const STRUCTS = [
  'struct FundingAuthorization { uint32 requirementsRevision; uint256 chainId; bytes32 cycleId; address hook; address vault; address usdg; address operationsTrigger; uint256 amount; bytes32 bindingManifestDigest; bytes32 outboundActionDigest; bytes32 returnActionDigest; address returnDestination; uint256 minimumRobinhoodReceive; uint256 minimumSolanaReceive; uint256 minimumReturnUsdg; uint256 robinhoodNativeGasCap; uint256 solanaNativeGasCap; uint64 expiresAt; uint256 nonce; }',
  'struct PayoutAuthorization { uint32 requirementsRevision; uint256 chainId; bytes32 cycleId; address hook; address vault; address usdg; address operationsTrigger; bytes32 bindingManifestDigest; bytes32 payoutId; bytes32 manifestDigest; bytes32 rootHash; uint256 rootSum; bytes32 returnActionDigest; bytes32 returnReceiptDigest; uint64 expiresAt; uint256 nonce; }',
];

export const PEG_CYCLE_VAULT_ABI = parseAbi([
  ...STRUCTS,
  'function authorizeFunding(FundingAuthorization authorization)',
  'function authorizeFundingAfterFailure(FundingAuthorization authorization, bytes32 failedCycleId, bytes32 failureReceiptDigest)',
  'function cancelExpiredFundingAuthorization(bytes32 cycleId)',
  'function renewFundingAuthorizationDeadline(FundingAuthorization renewal)',
  'function executeOutbound(bytes32 cycleId, bytes routeData)',
  // WP-39: `authorizePayout` now takes the two EIP-712 signatures `PayoutDistributionSignatures.verify`
  // requires (decision D7/WP-38) — the distribution-signer's and the independent verifier's, both over
  // the same `PayoutDistribution` digest (`../signing/payout-typed-data.mjs`). Field order matches
  // `IPegCycleVault.authorizePayout`'s declaration exactly.
  'function authorizePayout(PayoutAuthorization authorization, bytes distributionSignature, bytes verifierSignature)',
  'function renewPayoutAuthorizationDeadline(PayoutAuthorization renewal)',
  'function recordTerminalFailure(bytes32 cycleId, bytes32 failureReceiptDigest)',
  'function recordDegradedReturn(bytes32 cycleId, bytes32 receiptDigest, bool acceptDegraded)',
  'function computeCycleEscrow(bytes32 cycleId) view returns (address)',
  'function cycleEscrows(bytes32 cycleId) view returns (address)',
  'function cycleLifecycles(bytes32 cycleId) view returns (uint8)',
  'function failureReceiptDigests(bytes32 cycleId) view returns (bytes32)',
  'function failedCycleSuccessors(bytes32 failedCycleId) view returns (bytes32)',
  'function recoveryPredecessors(bytes32 successorCycleId) view returns (bytes32)',
  'function readPendingAuthorization() view returns (FundingAuthorization)',
  'function readActiveAuthorization() view returns (FundingAuthorization)',
  'function isNonceConsumed(uint256 nonce) view returns (bool)',
  'function isCycleConsumed(bytes32 cycleId) view returns (bool)',
  'function readCommittedPayoutBinding(bytes32 cycleId) view returns (bytes32 authorizationDigest, bytes32 payoutId, bytes32 returnReceiptDigest)',
  'function isPayoutIdConsumed(bytes32 payoutId) view returns (bool)',
  'function isReturnReceiptDigestConsumed(bytes32 returnReceiptDigest) view returns (bool)',
]);

export const HOOK_ABI = parseAbi([
  ...STRUCTS,
  'struct ReleasedCycle { bytes32 cycleId; uint256 amount; address operationsTrigger; }',
  'function claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)',
  'function openPegCycle(bytes32 cycleId) returns (ReleasedCycle released)',
  'function readReleasedCycle(bytes32 cycleId) view returns (ReleasedCycle)',
  'function fundPayoutFromPegCycle(PayoutAuthorization authorization) returns ((bytes32 cycleId, address operationsTrigger, bytes32 payoutId, bytes32 manifestDigest, bytes32 rootHash, uint256 rootSum, uint256 paidTotal, uint256 unpaidTotal, bool funded) record)',
]);

function buildCall(abi, address, functionName, args) {
  return Object.freeze({
    to: address,
    abi,
    functionName,
    args,
    data: encodeFunctionData({ abi, functionName, args }),
  });
}

// ---------------------------------------------------------------------------
// PegCycleVault — state-changing calls (unsigned; every arg validated before encoding)
// ---------------------------------------------------------------------------

export function buildAuthorizeFundingCall(vault, authorization) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'authorizeFunding', [authorization]);
}

export function buildAuthorizeFundingAfterFailureCall(vault, authorization, failedCycleId, failureReceiptDigest) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'authorizeFundingAfterFailure', [
    authorization,
    failedCycleId,
    failureReceiptDigest,
  ]);
}

export function buildCancelExpiredFundingAuthorizationCall(vault, cycleId) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'cancelExpiredFundingAuthorization', [cycleId]);
}

export function buildRenewFundingAuthorizationDeadlineCall(vault, renewal) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'renewFundingAuthorizationDeadline', [renewal]);
}

export function buildExecuteOutboundCall(vault, cycleId, routeData) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'executeOutbound', [cycleId, routeData]);
}

const HEX_BYTES = /^0x[0-9a-fA-F]*$/;

function assertHexBytes(value, label) {
  if (typeof value !== 'string' || !HEX_BYTES.test(value) || value.length % 2 !== 0) {
    throw new Error(`${label} must be a 0x-prefixed hex byte string`);
  }
  return value;
}

/**
 * `distributionSignature`/`verifierSignature` (WP-39, decision D7): the two EIP-712 signatures
 * `PayoutDistributionSignatures.verify` requires — the distribution-signer's and the independent
 * verifier's, both over the exact same `PayoutDistribution` digest
 * (`../signing/payout-typed-data.mjs`'s `payoutDistributionDigest`, over this same `authorization`).
 * This module never produces either signature itself — see `../signing/payout-distribution.mjs`
 * (production, secp256k1) or `packages/runner/src/distribution/distribution-signer.mjs` (fixture,
 * Ed25519, local pairing only — never submitted on-chain).
 */
export function buildAuthorizePayoutCall(vault, authorization, distributionSignature, verifierSignature) {
  assertHexBytes(distributionSignature, 'distributionSignature');
  assertHexBytes(verifierSignature, 'verifierSignature');
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'authorizePayout', [
    authorization,
    distributionSignature,
    verifierSignature,
  ]);
}

export function buildRenewPayoutAuthorizationDeadlineCall(vault, renewal) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'renewPayoutAuthorizationDeadline', [renewal]);
}

export function buildRecordTerminalFailureCall(vault, cycleId, failureReceiptDigest) {
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'recordTerminalFailure', [cycleId, failureReceiptDigest]);
}

/**
 * `acceptDegraded` MUST be true only after the off-chain, separately-logged human confirmation
 * design.md §2.5 requires — this module performs no such confirmation itself; the caller is
 * responsible for having obtained it before this call is ever built.
 */
export function buildRecordDegradedReturnCall(vault, cycleId, receiptDigest, acceptDegraded) {
  if (typeof acceptDegraded !== 'boolean') throw new Error('acceptDegraded must be a boolean');
  return buildCall(PEG_CYCLE_VAULT_ABI, assertAddress(vault, 'vault'), 'recordDegradedReturn', [
    cycleId,
    receiptDigest,
    acceptDegraded,
  ]);
}

// ---------------------------------------------------------------------------
// Hook — state-changing calls
// ---------------------------------------------------------------------------

export function buildClaimProcessCall(hook, cycleId, amountAtomicUsdg, destination) {
  return buildCall(HOOK_ABI, assertAddress(hook, 'hook'), 'claimProcess', [
    assertNonzeroBytes32(cycleId, 'cycleId'),
    assertPositiveAtomic(amountAtomicUsdg, 'amountAtomicUsdg'),
    assertAddress(destination, 'destination'),
  ]);
}

export function buildOpenPegCycleCall(hook, cycleId) {
  return buildCall(HOOK_ABI, assertAddress(hook, 'hook'), 'openPegCycle', [cycleId]);
}

export function buildFundPayoutFromPegCycleCall(hook, authorization) {
  return buildCall(HOOK_ABI, assertAddress(hook, 'hook'), 'fundPayoutFromPegCycle', [authorization]);
}

/** Alias for buildFundPayoutFromPegCycleCall — see the module header's naming note. */
export const buildConsumePayoutAuthorizationCall = buildFundPayoutFromPegCycleCall;

// ---------------------------------------------------------------------------
// PegCycleVault — reads (each takes an injected viem PublicClient, e.g. from robinhood-rpc.mjs)
// ---------------------------------------------------------------------------

function readVault(client, vault, functionName, args = []) {
  return client.readContract({ address: assertAddress(vault, 'vault'), abi: PEG_CYCLE_VAULT_ABI, functionName, args });
}

export const readComputeCycleEscrow = (client, vault, cycleId) => readVault(client, vault, 'computeCycleEscrow', [cycleId]);
export const readCycleEscrow = (client, vault, cycleId) => readVault(client, vault, 'cycleEscrows', [cycleId]);
export const readCycleLifecycle = (client, vault, cycleId) => readVault(client, vault, 'cycleLifecycles', [cycleId]);
export const readFailureReceiptDigest = (client, vault, cycleId) => readVault(client, vault, 'failureReceiptDigests', [cycleId]);
export const readFailedCycleSuccessor = (client, vault, failedCycleId) => readVault(client, vault, 'failedCycleSuccessors', [failedCycleId]);
export const readRecoveryPredecessor = (client, vault, successorCycleId) => readVault(client, vault, 'recoveryPredecessors', [successorCycleId]);
export const readPendingAuthorization = (client, vault) => readVault(client, vault, 'readPendingAuthorization');
export const readActiveAuthorization = (client, vault) => readVault(client, vault, 'readActiveAuthorization');
export const readIsNonceConsumed = (client, vault, nonce) => readVault(client, vault, 'isNonceConsumed', [nonce]);
export const readIsCycleConsumed = (client, vault, cycleId) => readVault(client, vault, 'isCycleConsumed', [cycleId]);
export const readCommittedPayoutBinding = (client, vault, cycleId) => readVault(client, vault, 'readCommittedPayoutBinding', [cycleId]);
export const readIsPayoutIdConsumed = (client, vault, payoutId) => readVault(client, vault, 'isPayoutIdConsumed', [payoutId]);
export const readIsReturnReceiptDigestConsumed = (client, vault, digest) => readVault(client, vault, 'isReturnReceiptDigestConsumed', [digest]);

// ---------------------------------------------------------------------------
// Hook — reads
// ---------------------------------------------------------------------------

export function readReleasedCycle(client, hook, cycleId) {
  return client.readContract({ address: assertAddress(hook, 'hook'), abi: HOOK_ABI, functionName: 'readReleasedCycle', args: [cycleId] });
}

export const CYCLE_LIFECYCLE = Object.freeze({
  EMPTY: 0,
  FUNDED: 1,
  OUTBOUND: 2,
  RETURNED: 3,
  PAYOUT_COMMITTED: 4,
  FAILED: 5,
  DEGRADED: 6,
});
