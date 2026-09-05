// Shared production-action construction (WP-35): every live stage that moves value through one of
// the four CycleRunner action kinds (outbound/purchase/buyback/return) builds its
// `hookemon.production-action.v1` value through `buildProductionAction` below, so the exact same
// deterministic fields feed both `funding`'s `outboundActionDigest`/`returnActionDigest` (computed
// once, before either action ever executes) and `outbound`/`return`'s own action object at execution
// time — the vault only ever accepts an `executeOutbound` call whose route digest the operator
// authorized at funding time, so the two computations must be byte-identical.
//
// `assertProductionAction` (packages/runner/src/cycle/schemas.mjs) validates only structure and
// custody separation — never one hardcoded literal transaction (see that module's own header:
// "a production action's instruction bytes come from an injected provider adapter ... and are trusted
// structurally rather than matched byte-for-byte against one canned transaction"). The real security
// boundary is downstream: the chain observer that later confirms a receipt (this package's own
// robinhood-rpc.mjs/solana-rpc.mjs reads) is what independently verifies what actually happened
// on-chain — this module's `instructions` field is therefore a real-account-populated but
// structurally-representational encoding of "what this action does" (mirroring exactly how
// packages/runner/test/cycle/fixture-cycle.mjs's own fixture actions represent an instruction: one
// entry, `01` + the action-kind bytes as `data`, real accounts as keys), never a byte-for-byte replay
// of the real provider-specific wire format (Relay's/Collector Crypt's own transaction bytes, built
// and signed separately by hook-contract-client.mjs / collector-crypt.mjs / relay-client.mjs / the
// injected signerClient — see each stage module's own header).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { digest } from '../../../../runner/src/cycle/journal.mjs';
import {
  PRODUCTION_PROVIDERS,
  fixtureActionChainIdentity,
  productionActionDigests,
} from '../../../../runner/src/cycle/schemas.mjs';

/** Deterministic bytes32 onchain cycle id derived from the local (off-chain) cycle id — the same
 * technique packages/runner/test/cycle/production-cycle.mjs's own `derivedOnchainCycleId` helper
 * uses, so a given local cycleId always maps to the same onchain identifier across a crash/resume. */
export function deriveOnchainCycleId(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

/** The real, currently-deployed USDG contract address on Robinhood Chain (chain id 4663), read
 * live from the frozen `bindings/robinhood-chain.json` — never re-typed as a literal, matching
 * exactly how packages/runner/test/cycle/production-cycle.mjs sources the same value. Cached
 * after the first read since the binding file is static per process lifetime.
 * `config.contracts.usdg` (a test-only override — see stage-driver.mjs's app wiring) takes
 * precedence when supplied. Shared by every stage that needs the USDG address (funding.mjs,
 * distribution.mjs) so it is read/cached exactly once per process. */
let cachedUsdgAddress = null;
export function readUsdgAddress(config) {
  if (config.contracts.usdg) return config.contracts.usdg;
  if (cachedUsdgAddress) return cachedUsdgAddress;
  const bindingUrl = new URL('../../../../../bindings/robinhood-chain.json', import.meta.url);
  const binding = JSON.parse(readFileSync(bindingUrl, 'utf8'));
  cachedUsdgAddress = binding.contracts.usdg.address.toLowerCase();
  return cachedUsdgAddress;
}

/**
 * WP-36 review fix: `PegCycleVault`'s `consumedNonces` mapping (packages/contracts/src/process/
 * PegCycleVault.sol) is a single *global* replay-protection registry shared by every
 * `authorizeFunding`/`authorizePayout` call for every cycle — a nonce, once consumed on-chain, can
 * never be reused, by this cycle or any other. `funding.mjs`/`payout.mjs` used to derive their
 * nonce purely from `onchainCycleId` (a disjoint hex slice each, to keep the two calls from
 * colliding with *each other*) — deterministic and therefore IDENTICAL every time the same cycle's
 * funding/payout is (re-)authorized. A legitimate second `authorizeFunding` for the same cycle
 * (after an operator calls `cancelExpiredFundingAuthorization` or `authorizeFundingAfterFailure`)
 * would then compute the exact same, already-consumed nonce as the first attempt and revert
 * on-chain (`consumedNonces[nonce]` true).
 *
 * The fix: fold in `attemptIndex` — the number of times this stage has ever durably attempted an
 * authorization for this cycle, as tracked by `cycle-repository.mjs`'s own attempt-sequence
 * bookkeeping (`nextStageAttemptIndex`/`recordStageAttemptFailure`). `attemptIndex` only advances
 * when a *fresh* attempt is built (never on a crash-resume of the still-current attempt, which
 * reuses its own already-recorded nonce verbatim rather than calling this function again — see
 * funding.mjs's/payout.mjs's own idempotency guard). `stageTag` keeps the two call sites'
 * nonce spaces disjoint exactly as the old hex-slice scheme did, without them needing to agree on
 * which bits of a shared value belong to whom.
 *
 * A SHA-256 digest is used, not the on-chain `keccak256`, because this is off-chain replay-space
 * bookkeeping (any collision-resistant hash is fine here — the contract only ever checks equality
 * / set-membership on whatever `uint256` it is given, never recomputes it), matching this
 * package's own house style of using `journal.mjs`'s `digest()` for its own bookkeeping values
 * (see e.g. `computeFundingPreflightDigest`) and reserving the real `keccak256` implementation
 * for values a Solidity contract itself hashes and compares against (`outboundActionDigest`).
 */
export function deriveAuthorizationNonce(onchainCycleId, stageTag, attemptIndex) {
  if (typeof onchainCycleId !== 'string' || onchainCycleId.length === 0) {
    throw new Error('deriveAuthorizationNonce: onchainCycleId is required');
  }
  if (typeof stageTag !== 'string' || stageTag.length === 0) {
    throw new Error('deriveAuthorizationNonce: stageTag is required');
  }
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) {
    throw new Error('deriveAuthorizationNonce: attemptIndex must be a non-negative integer');
  }
  const nonceDigest = digest({ domain: 'hookemon.stage-driver.vault-nonce.v1', onchainCycleId, stageTag, attemptIndex });
  const hex = nonceDigest.startsWith('sha256:') ? nonceDigest.slice(7, 7 + 32) : nonceDigest.slice(0, 32);
  const nonce = BigInt(`0x${hex}`);
  // PegCycleVault treats nonce === 0 as "unset"/invalid (see IPegCycleVault.sol's authorization
  // checks) — astronomically unlikely for a SHA-256 digest slice, but guarded explicitly rather
  // than left to chance, matching this codebase's fail-closed style.
  return nonce === 0n ? 1n : nonce;
}

/**
 * @param {object} input
 * @param {'outbound'|'purchase'|'buyback'|'return'} input.actionKind
 * @param {string} input.cycleId
 * @param {string} input.preflightDigest - a `sha256:` digest binding this action to one funding
 *   decision; callers with no separately-journaled preflight (this package does not construct a
 *   full CycleRunner journal — see stage-driver.mjs's header) pass a digest of the funding facts
 *   themselves (see `funding.mjs`'s `computeFundingPreflightDigest`).
 * @param {object} input.custody - `{operationsTrigger, cycleVaultAccount, policyAccount, returnAccount}`
 * @param {object} input.binding - the `hookemon.pack-binding.v1`-shaped object `validateBinding` accepts.
 * @param {string} input.principalAmount
 * @param {string} input.minimumReceive
 * @param {string} input.nativeGasAmount
 * @param {string} input.feePayer - the real signer address (EVM 0x… for outbound/return, base58 for
 *   purchase/buyback) that will actually sign and broadcast this action's transaction.
 * @param {string} input.sourceAccount
 * @param {string} input.inputAsset
 * @param {string} input.outputAsset
 * @param {string} input.mint
 * @param {string} input.tokenAccount
 * @param {string} input.destination
 * @param {string} [input.nftMint] - required (and meaningful) only for purchase/buyback; a
 *   syntactically-valid placeholder identifier is supplied for outbound/return, which never touch an NFT.
 * @param {string} [input.nftCustodyAccount]
 * @param {string} [input.amount] - defaults to `principalAmount` except for buyback, whose `amount`
 *   is always the single NFT unit `'1'` (see schemas.mjs's own note: buyback's Circle-USD proceeds are
 *   a separate field, `minimumReceive`, never conflated with the NFT unit being surrendered).
 * @param {object} input.validity - `{recentBlockhash, currentHeight, lastValidHeight}`.
 */
export function buildProductionAction(input) {
  const {
    actionKind, cycleId, preflightDigest, custody, binding,
    principalAmount, minimumReceive, nativeGasAmount, feePayer,
    sourceAccount, inputAsset, outputAsset, mint, tokenAccount, destination,
    nftMint = `${cycleId}-no-nft-${actionKind}`,
    nftCustodyAccount = binding.executionWallet,
    amount = actionKind === 'buyback' ? '1' : principalAmount,
    validity,
  } = input;

  const chainIdentity = fixtureActionChainIdentity(actionKind);
  const instruction = {
    program: PRODUCTION_PROVIDERS[actionKind],
    accounts: [
      { address: feePayer, isSigner: true, isWritable: true },
      { address: tokenAccount, isSigner: false, isWritable: true },
      { address: destination, isSigner: false, isWritable: true },
    ],
    data: `01${Buffer.from(actionKind, 'utf8').toString('hex')}`,
  };

  const action = {
    schema: 'hookemon.production-action.v1',
    cycleId,
    actionKind,
    preflightDigest,
    operationsTrigger: custody.operationsTrigger,
    cycleVaultAccount: custody.cycleVaultAccount,
    policyAccount: custody.policyAccount,
    returnAccount: custody.returnAccount,
    principalAmount,
    minimumReceive,
    nativeGasAmount,
    provider: PRODUCTION_PROVIDERS[actionKind],
    chain: chainIdentity.chain,
    domain: chainIdentity.domain,
    cluster: chainIdentity.cluster,
    instructions: [instruction],
    signers: [{ address: feePayer, isFeePayer: true }],
    feePayer,
    sourceAccount,
    inputAsset,
    outputAsset,
    mint,
    tokenAccount,
    destination,
    nftMint,
    nftCustodyAccount,
    amount,
    memo: `${cycleId}:${actionKind}`,
    validity,
    binding: { ...binding },
  };
  return action;
}

/** Computes the same `{actionDigest, bindingDigest, instructionsDigest, signersDigest}` tuple —
 * a pure, deterministic function of `buildProductionAction`'s output, structurally validated by
 * `assertProductionAction` first (never trusted unchecked). This is `packages/runner`'s own
 * off-chain bookkeeping digest scheme (SHA-256 canonical JSON — see `schemas.mjs`), used here for
 * `returnActionDigest` (funding.mjs computes it once; payout.mjs reuses it verbatim — see that
 * module's own header for why nothing ever recomputes it independently) and for structural
 * cross-checks. It is **not** what `PegCycleVault.executeOutbound` requires for
 * `outboundActionDigest` — see `extractRouteData` below and funding.mjs's/outbound.mjs's headers
 * for why that field is a literal `keccak256` of real route calldata instead. */
export function actionDigests(action) {
  return productionActionDigests(action);
}

export { digest };
