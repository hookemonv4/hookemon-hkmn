// Evidence profiles (WP-31): CycleRunner and the reducer never hardcode which verification mechanism a
// cycle's evidence must pass — they call an injected `evidenceProfile` object that exposes exactly the
// verifier/digest/authorization surface reduceCycleEvent's handlers need (see reducer.mjs's dispatcher).
// Two named profiles live here:
//
//   - FIXTURE_PROFILE: re-exports reducer.mjs's FIXTURE_EVIDENCE_PROFILE unchanged — the exact functions
//     every existing fixture test already exercises, byte-for-byte. This is CycleRunner's default, so
//     every existing caller (every current test) is unaffected.
//
//   - createProductionEvidenceProfile(deps): builds the production profile from injected dependencies
//     and an explicit read-only preflight authority — chain observers (`deps.observers.solana` / `.evm`, synchronous `{ confirmTransaction, ... }`
//     clients — the caller resolves any live RPC round trip before invoking CycleRunner, exactly as every
//     other injected client here is already resolved data, never a live network dependency of the
//     deterministic core itself), a signer registry (`deps.signerRegistry`, the local keychain-backed
//     signer seam, decision D3), an already owner-verified StandingAuthorityProvider
//     (`deps.standingAuthorityProvider`, authorization-provider.mjs, decision D3/D4) plus its already-
//     verified document (`deps.standingAuthorityDocument`), and configuration values that must never be
//     guessed (`deps.programIds` — the pinned Collector Crypt / Relay on-chain program or contract
//     identity per action kind — and `deps.purchaseDestination`, the wallet a Collector Crypt pack
//     generation actually targets). No fixture Ed25519 key is ever read to construct or use this profile.
//
//   - createTestProductionEvidenceProfile(deps): builds the same reducer-facing shape with the retained
//     historical authority. It is the only simulation entry point for production-shaped test evidence.
//
// Both profiles implement the identical shape (action/preflight/authorization/message/signedTransaction/
// blockhashValidity/providerReceipt/executionAccounting/collector/postOpenBuyback/cycleStore) so the
// reducer and CycleRunner never branch on which profile is active — they only ever call through it.
import { FixtureCycleStore } from './cycle-store.mjs';
import { DurableCycleStore } from './durable-store.mjs';
import { validateBinding } from './bindings.mjs';
import { digest } from './journal.mjs';
import { FIXTURE_AUTHORIZATION_VALIDATED_AT } from './authorization.mjs';
import { stepAuthorizationNow } from './authorization-provider.mjs';
import { FIXTURE_EVIDENCE_PROFILE } from './reducer.mjs';
import {
  assertProductionAction,
  assertProductionReceiptRelationship,
  assertVerifiedProductionProviderReceipt,
  productionActionDigests,
  productionReceiptIdentityKey,
  productionReceiptRegistryRecord,
} from './schemas.mjs';
import {
  decodeProductionMessage,
  productionMessageForAction,
  verifyProductionSignedTransaction,
} from './decoder.mjs';
import { assertVerifiedProductionBlockhashValidity } from './blockhash-validity.mjs';
import { assertVerifiedProductionExecutionAccounting } from './execution-accounting.mjs';
import { assertMoneyConfiguration } from './money-schemas.mjs';
import {
  createTestProfileMutationAuthority,
  verifyProductionCyclePreflight,
} from './preflight.mjs';
import {
  assertProductionCollectorRequest,
  assertVerifiedProductionCollectorOpenCustody,
  assertVerifiedProductionCollectorOpenExecution,
  assertVerifiedProductionCollectorRpcFinality,
  assertVerifiedProductionCollectorStatus,
  productionCollectorRequestDigest,
} from './collector.mjs';

export const FIXTURE_PROFILE = Object.freeze({
  ...FIXTURE_EVIDENCE_PROFILE,
  cycleStore: Object.freeze({
    accepts(store) { return store instanceof FixtureCycleStore; },
  }),
});

function assertConfiguredIdentifier(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is a required production configuration value (never guessed) — see docs/modules/cycle-runner.md`);
}

export function createProductionEvidenceProfile(deps = {}) {
  return createEvidenceProfile(deps, deps.preflightAuthority);
}

export function createTestProductionEvidenceProfile(deps = {}) {
  return createEvidenceProfile(deps, createTestProfileMutationAuthority());
}

function createEvidenceProfile(deps, preflightAuthority) {
  const { observers, signerRegistry, standingAuthorityProvider, programIds, purchaseDestination } = deps;
  if (!observers?.solana || typeof observers.solana.confirmTransaction !== 'function') throw new Error('production evidence profile requires an injected Solana chain observer');
  if (!observers?.evm || typeof observers.evm.confirmTransaction !== 'function') throw new Error('production evidence profile requires an injected Robinhood (EVM) chain observer');
  if (!signerRegistry || typeof signerRegistry.verify !== 'function' || typeof signerRegistry.verifyDigest !== 'function') throw new Error('production evidence profile requires an injected signer registry exposing both verify(address, messageBytesHex, signature) and verifyDigest(address, digestString, signature)');
  if (!standingAuthorityProvider || typeof standingAuthorityProvider.verifyStepAuthorization !== 'function') throw new Error('production evidence profile requires an injected, already owner-verified StandingAuthorityProvider');
  if (!programIds || typeof programIds !== 'object') throw new Error('production evidence profile requires a pinned programIds configuration map');
  for (const actionKind of ['outbound', 'purchase', 'buyback', 'return']) assertConfiguredIdentifier(programIds[actionKind], `programIds.${actionKind}`);
  assertConfiguredIdentifier(purchaseDestination, 'purchaseDestination');
  let moneyConfiguration;
  try {
    moneyConfiguration = assertMoneyConfiguration(deps.moneyConfiguration, 'production evidence profile money configuration');
  } catch (error) {
    throw new Error(`production evidence profile requires MoneyConfigurationV1: ${error.message}`);
  }

  const receiptDeps = { observers, programIds };

  const profile = {
    name: 'production',
    action: Object.freeze({
      assert: assertProductionAction,
      digests: productionActionDigests,
    }),
    preflight: Object.freeze({
      verify(value) {
        return verifyProductionCyclePreflight(value, {
          observers,
          standingAuthority: deps.standingAuthorityDocument,
          preflightAuthority,
          moneyConfiguration,
        });
      },
    }),
    authorization: Object.freeze({
      provider: standingAuthorityProvider,
      // A standing-authority step intent carries no actionDigest field of its own (see
      // authorization-provider.mjs's stepIntentFields) — it authorizes "the currently prepared action of
      // this kind", resolved the same way the reducer already tracks one action per kind per cycle.
      resolveActionDigest(state, approval) {
        return state.actionByKind.get(approval.actionKind) ?? null;
      },
      // Field cross-checks only (approval vs. the prepared action it claims to authorize); the caller
      // (reducer.mjs verifyApproval) separately checks approval.subjectDigest against the real,
      // stage-appropriate subject (action/message/signed-bytes digest) using its own live state.
      matchApproval(approval, prepared) {
        if (approval.cycleId !== prepared.action.cycleId) throw new Error('production owner approval cycle mismatch');
        if (approval.actionKind !== prepared.action.actionKind) throw new Error('production owner approval action kind mismatch');
        if (approval.destination !== prepared.action.destination) throw new Error('production owner approval destination mismatch');
        if (approval.pack !== prepared.action.binding.pack) throw new Error('production owner approval pack mismatch');
      },
      approvalKey(approval) { return approval.intentDigest; },
      // A standing-authority step intent has no retry-attempt counter of its own (each carries its own
      // fresh nonce instead, single-use); this reports a constant 1, matching the "first and only
      // attempt" a fresh nonce always represents.
      attempt() { return 1; },
      storeRecord(verified, validatedAt) {
        if (typeof validatedAt !== 'string' || Number.isNaN(Date.parse(validatedAt))) throw new Error('production authorization validation time is invalid');
        const nonceKey = digest({ domain: 'hookemon.standing-authority-nonce.v1', standingAuthorityDigest: verified.standingAuthorityDigest, nonce: verified.nonce });
        return {
          key: verified.intentDigest,
          nonceKey,
          cycleId: verified.cycleId,
          actionKind: verified.actionKind,
          authorizationKind: verified.authorizationKind,
          actionDigest: verified.subjectDigest,
          subjectDigest: verified.subjectDigest,
          commitment: digest({ domain: 'hookemon.standing-authority-consumption.v1', authorizationKind: verified.authorizationKind, subjectDigest: verified.subjectDigest, authorization: verified, nonceKey, validatedAt }),
          validatedAt,
        };
      },
    }),
    message: Object.freeze({
      forAction: productionMessageForAction,
      decode: decodeProductionMessage,
      digestDomain: 'hookemon.production-message.v1',
    }),
    signedTransaction: Object.freeze({
      verify(signedBytes, expected) { return verifyProductionSignedTransaction(signedBytes, expected, { signerRegistry }); },
      digestDomain: 'hookemon.production-signed-transaction.v1',
    }),
    blockhashValidity: Object.freeze({
      verify(value) { return assertVerifiedProductionBlockhashValidity(value, { observers }); },
    }),
    providerReceipt: Object.freeze({
      verify(value) { return assertVerifiedProductionProviderReceipt(value, receiptDeps); },
      digestDomain: 'hookemon.production-provider-receipt.v1',
      identityKey: productionReceiptIdentityKey,
      registryRecord: productionReceiptRegistryRecord,
      relationship: assertProductionReceiptRelationship,
    }),
    executionAccounting: Object.freeze({
      verify(value) { return assertVerifiedProductionExecutionAccounting(value, { observers }); },
    }),
    collector: Object.freeze({
      assertRequest: assertProductionCollectorRequest,
      requestDigest: productionCollectorRequestDigest,
      verifyMutationAuthorization(rawIntent, request, action, binding) {
        // See authorization-provider.mjs's stepAuthorizationNow: `now` is bound to the signed intent's
        // own `issuedAt`, never the wall clock, so a journal replay re-derives the same verdict it did
        // on first commit instead of re-checking standing-authority expiry against reconstruction time.
        const verified = standingAuthorityProvider.verifyStepAuthorization(rawIntent, stepAuthorizationNow(rawIntent));
        const expectedRequest = assertProductionCollectorRequest(request, action);
        const exactBinding = validateBinding(binding);
        const requestDigestValue = productionCollectorRequestDigest(expectedRequest, action);
        if (verified.actionKind !== action || verified.authorizationKind !== 'mutation') throw new Error('production Collector mutation authorization kind is invalid');
        if (verified.subjectDigest !== requestDigestValue) throw new Error('production Collector mutation authorization subject digest mismatch');
        if (verified.cycleId !== expectedRequest.cycleId) throw new Error('production Collector mutation authorization cycle mismatch');
        if (verified.destination !== exactBinding.executionWallet) throw new Error('production Collector mutation authorization destination mismatch');
        if (verified.pack !== exactBinding.pack || verified.pack !== expectedRequest.pack) throw new Error('production Collector mutation authorization pack mismatch');
        return {
          provider: 'standing-authority',
          cycleId: verified.cycleId,
          action,
          requestDigest: requestDigestValue,
          // WP-34: pack/quantity/turbo are carried here (not just wallet) so a production-profile
          // CycleRunner bound to a frozen cycle control can pass reducer.mjs's assertFrozenControlBindings
          // Collector-authorization cross-check, which compares against the frozen control's binding on
          // every one of these four fields — exactly as the fixture profile's own
          // verifyFixtureCollectorMutationAuthorization already returns them (collector.mjs).
          pack: exactBinding.pack,
          quantity: exactBinding.quantity,
          turbo: exactBinding.turbo,
          wallet: exactBinding.executionWallet,
          prizeWallet: expectedRequest.prizeWallet ?? purchaseDestination,
          memo: expectedRequest.memo,
          nonce: verified.nonce,
          attempt: 1,
          standingAuthorityDigest: verified.standingAuthorityDigest,
          intentDigest: verified.intentDigest,
        };
      },
      mutationAuthorizationDigest(authorization) {
        return authorization.intentDigest;
      },
      mutationAuthorizationStoreRecord(authorization, action) {
        return {
          key: authorization.intentDigest,
          nonceKey: digest({ domain: 'hookemon.standing-authority-nonce.v1', standingAuthorityDigest: authorization.standingAuthorityDigest, nonce: authorization.nonce }),
          cycleId: authorization.cycleId,
          actionKind: action,
          authorizationKind: 'mutation',
          actionDigest: authorization.requestDigest,
          subjectDigest: authorization.requestDigest,
          commitment: digest({ domain: 'hookemon.production-collector-mutation-authorization-consumption.v1', authorization }),
          validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
        };
      },
      assertVerifiedStatus(value) { return assertVerifiedProductionCollectorStatus(value, { observers }); },
      assertVerifiedOpenExecution(value) { return assertVerifiedProductionCollectorOpenExecution(value, { signerRegistry }); },
      assertVerifiedOpenCustody(value) { return assertVerifiedProductionCollectorOpenCustody(value, { observers }); },
      assertVerifiedRpcFinality(value, custody) { return assertVerifiedProductionCollectorRpcFinality(value, custody, { observers }); },
      acceptsOpenCustodyNftMint() { return true; },
      acceptsGenerateResponse(response) { return response.schema === 'hookemon.production-collector-generate.v1'; },
    }),
    postOpenBuyback: Object.freeze({
      verify(rawIntent) {
        // See the identical note on collector.verifyMutationAuthorization above.
        return standingAuthorityProvider.verifyStepAuthorization(rawIntent, stepAuthorizationNow(rawIntent));
      },
      resolveActionDigest(state, approval) { return state.actionByKind.get('buyback') ?? null; },
      // The generic standing-authority schema has no collectorPrizeWallet field of its own — it is the
      // buyback action's own sourceAccount (the wallet currently holding the opened card, already tied
      // to this exact approval by matchPolicy's destination check above at approval-recording time).
      prizeWallet(approval, action) { return action.sourceAccount; },
      refundAmount(approval) { return approval.spendAmount; },
      // The generic standing-authority step-intent schema carries destination/pack/spendAmount, not the
      // full fixture-shaped policy fields (collectorPrizeWallet/currentOwner/mint/tokenAccount) — those
      // are already independently enforced by assertProductionAction/validateBinding when the buyback
      // action itself was prepared, so this checks the two fields that are this approval's own claim:
      // the refund lands at the action's own refund destination, and it is at least the approved floor.
      matchPolicy(approval, prepared) {
        const action = prepared.action;
        if (approval.destination !== action.destination || approval.destination !== action.binding.refundTokenAccount) throw new Error('production post-open buyback destination mismatch');
        if (BigInt(approval.spendAmount) < BigInt(action.minimumReceive)) throw new Error('production post-open buyback refund is below the approved minimum receive');
      },
      storeRecord(verified) {
        const nonceKey = digest({ domain: 'hookemon.standing-authority-nonce.v1', standingAuthorityDigest: verified.standingAuthorityDigest, nonce: verified.nonce });
        return {
          key: verified.intentDigest,
          nonceKey,
          cycleId: verified.cycleId,
          actionKind: 'buyback',
          authorizationKind: 'buyback-policy',
          actionDigest: verified.subjectDigest,
          subjectDigest: verified.subjectDigest,
          commitment: digest({ domain: 'hookemon.standing-authority-consumption.v1', authorizationKind: 'buyback-policy', subjectDigest: verified.subjectDigest, authorization: verified, nonceKey, validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT }),
          validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
        };
      },
    }),
    cycleStore: Object.freeze({
      // Interface check, not instanceof — WP-27's DurableCycleStore is accepted directly; any store
      // conforming to the same {readCycle, begin, commit(Sync)} shape (FixtureCycleStore included) works
      // too, since the production profile's trust boundary is the evidence, never the storage engine.
      accepts(store) {
        if (!store || typeof store !== 'object') return false;
        if (typeof store.readCycle !== 'function' || typeof store.begin !== 'function') return false;
        if (typeof store.commitSync === 'function') return true;
        if (typeof store.commit === 'function' && !(store instanceof DurableCycleStore)) return true;
        return false;
      },
    }),
  };

  return Object.freeze(profile);
}
