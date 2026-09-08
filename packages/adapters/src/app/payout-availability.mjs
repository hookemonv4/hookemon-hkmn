// Production payout-availability reader: the only source `payout.mjs` may trust for the
// cycle-attributable finalized native ETH amount actually backing a direct payout right now. Read-only
// end to end -- it never mutates the cycle repository, never signs, and never broadcasts.
//
// The distributable pool a payout admits is `returnDelta + previousDust`, never a wallet-wide
// balance: the same Operations wallet can hold unrelated cycles' funds, and this reader must never
// let those fund a shortfall. It independently reloads and re-authenticates every input the
// prepared plan already computed -- the finalized `return` stage evidence, the durable custody
// ledger it produced, any carried predecessor dust provenance, and a finalized Operations native ETH
// balance proved at a public/archive/same-height-public checkpoint -- and refuses on any mismatch,
// absence, or ambiguity rather than trusting the plan's own arithmetic.
import { digest as canonicalDigest, canonicalJson } from '../../../runner/src/cycle/journal.mjs';
import { createNativePayoutAmount, NATIVE_PAYOUT_CHAIN_ID, NATIVE_PAYOUT_DECIMALS } from '../../../runner/src/distribution/payout-plan.mjs';
import { ROBINHOOD_CHAIN_ID } from '../robinhood-rpc.mjs';
import { createNativeCustodyBalanceObservationReader } from '../evm-custody-balance-observation.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUEST_FIELDS = [
  'cycleId', 'operations', 'assetId', 'returnDelta', 'returnEvidence', 'previousDust', 'previousDustSource', 'planDigest',
];
const RETURN_EVIDENCE_FIELDS = ['operations', 'assetId', 'evidenceDigest'];
const DUST_SOURCE_FIELDS = ['cycleId', 'digest', 'planDigest'];

function refuse(message) {
  throw new Error(`payout-availability reader refuses: ${message}`);
}

function assertNativeAsset(value) { if (value !== 'native') refuse('payout asset must be native'); return value; }

function assertAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) refuse(`${label} must be an EVM address`);
  return value.toLowerCase();
}

function assertDigestString(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) refuse(`${label} must be a canonical sha256 digest`);
  return value;
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} must be an object`);
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    refuse(`${label} must use its exact request schema`);
  }
  return value;
}

function assertNativeAmount(value, label, assetId) {
  assertExactFields(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], label);
  if (!(value.chainId === NATIVE_PAYOUT_CHAIN_ID || value.chainId === String(NATIVE_PAYOUT_CHAIN_ID)) || value.decimals !== NATIVE_PAYOUT_DECIMALS) {
    refuse(`${label} must identify native ETH on chain ${NATIVE_PAYOUT_CHAIN_ID} with ${NATIVE_PAYOUT_DECIMALS} decimals`);
  }
  if (assertNativeAsset(value.assetId) !== assetId) refuse(`${label} must identify the configured native ETH asset`);
  if (typeof value.amountAtomic !== 'string' || !ATOMIC.test(value.amountAtomic)) refuse(`${label} amountAtomic must be a canonical atomic integer string`);
  return value;
}

function sameTypedAmount(a, b) {
  return String(a.chainId) === String(b.chainId) && a.assetId === b.assetId && a.decimals === b.decimals && a.amountAtomic === b.amountAtomic;
}

function assertRequest(value) {
  assertExactFields(value, REQUEST_FIELDS, 'payout-availability request');
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) refuse('request cycleId must be a nonempty string');
  const operations = assertAddress(value.operations, 'request operations');
  const assetId = assertNativeAsset(value.assetId);
  const returnDelta = assertNativeAmount(value.returnDelta, 'request returnDelta', assetId);
  const previousDust = assertNativeAmount(value.previousDust, 'request previousDust', assetId);
  assertExactFields(value.returnEvidence, RETURN_EVIDENCE_FIELDS, 'request returnEvidence');
  if (assertAddress(value.returnEvidence.operations, 'request returnEvidence operations') !== operations
    || assertNativeAsset(value.returnEvidence.assetId) !== assetId) {
    refuse('request returnEvidence identities do not match the request');
  }
  const evidenceDigest = assertDigestString(value.returnEvidence.evidenceDigest, 'request returnEvidence evidenceDigest');
  let previousDustSource = null;
  if (value.previousDustSource !== null) {
    assertExactFields(value.previousDustSource, DUST_SOURCE_FIELDS, 'request previousDustSource');
    if (typeof value.previousDustSource.cycleId !== 'string' || value.previousDustSource.cycleId.length === 0) {
      refuse('request previousDustSource cycleId must be a nonempty string');
    }
    previousDustSource = {
      cycleId: value.previousDustSource.cycleId,
      digest: assertDigestString(value.previousDustSource.digest, 'request previousDustSource digest'),
      planDigest: assertDigestString(value.previousDustSource.planDigest, 'request previousDustSource planDigest'),
    };
  }
  if ((previousDust.amountAtomic === '0') !== (previousDustSource === null)) {
    refuse('request previous dust provenance is inconsistent with the previous dust amount');
  }
  const planDigest = assertDigestString(value.planDigest, 'request planDigest');
  return { cycleId: value.cycleId, operations, assetId, returnDelta, evidenceDigest, previousDust, previousDustSource, planDigest };
}

function stateValues(value) {
  return value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
}

/** Reloads the exact completed `return` stage evidence, authenticates it against the plan's frozen
 * evidence digest, and returns the observed finalized native ETH credit amount it proves. */
async function reloadFinalizedReturnAmount({ cycleRepository, cycleId, operations, assetId, evidenceDigest, cycle }) {
  const stage = await cycleRepository.readStage(cycleId, 'return');
  if (stage?.status !== 'COMPLETE' || !stage.evidence) refuse('the return stage has no completed finalized evidence');
  const evidence = stage.evidence;
  const boundDigest = canonicalDigest({ schema: 'hookemon.direct-payout-finalized-return.v2', cycleId, returnEvidence: evidence });
  if (boundDigest !== evidenceDigest) refuse('the reloaded return evidence does not authenticate the plan\'s frozen return binding');

  if (evidence.schema === 'hookemon.return-zero-proceeds-evidence.v2') {
    if (evidence.cycleId !== cycleId) refuse('the zero-proceeds return evidence names a different cycle');
    if (evidence.finalized !== true || evidence.noBridge !== true) refuse('the zero-proceeds return evidence is not finalized');
    if (assertAddress(evidence.destinationAccount, 'zero-proceeds destinationAccount') !== operations) {
      refuse('the zero-proceeds return evidence does not credit the configured Operations account');
    }
    if (assertNativeAsset(evidence.destinationAsset) !== assetId) {
      refuse('the zero-proceeds return evidence does not credit the configured native ETH asset');
    }
    if (evidence.destinationCreditAmount !== '0') refuse('the zero-proceeds return evidence must credit a zero amount');
    const returnLegs = stateValues(cycle?.relayLegs).filter(leg => leg?.direction === 'return');
    if (returnLegs.length !== 0) refuse('the zero-proceeds return evidence is ambiguous against a recorded return Relay leg');
    return '0';
  }

  if (evidence.schema === 'hookemon.return-relay-settlement-evidence.v2') {
    const leg = evidence.relayLeg;
    if (!leg || leg.direction !== 'return' || leg.state !== 'SETTLED') refuse('the return relay settlement evidence has no settled return leg');
    if (leg.cycleId !== cycleId) refuse('the settled return leg names a different cycle');
    if (String(leg.destinationChainId) !== String(ROBINHOOD_CHAIN_ID)) refuse('the settled return leg does not credit the configured destination chain');
    if (assertNativeAsset(leg.destinationAssetId) !== assetId) {
      refuse('the settled return leg does not credit the configured native ETH asset');
    }
    if (leg.destinationDecimals !== NATIVE_PAYOUT_DECIMALS) refuse('the settled return leg does not use the configured native ETH decimals');
    const recipient = leg.returnAttribution?.intent?.recipient;
    if (typeof recipient !== 'string' || assertAddress(recipient, 'settled return leg recipient') !== operations) {
      refuse('the settled return leg does not credit the configured Operations account');
    }
    if (leg.finalizedAtDestination === null || leg.finalizedAtDestination === undefined) {
      refuse('the settled return leg has no finalized destination evidence');
    }
    if (typeof leg.netDeltaAtomic !== 'string' || !ATOMIC.test(leg.netDeltaAtomic) || leg.netDeltaAtomic === '0') {
      refuse('the settled return leg does not carry a positive observed amount');
    }
    const returnLegs = stateValues(cycle?.relayLegs).filter(candidate => candidate?.direction === 'return');
    if (returnLegs.length !== 1) refuse('the settled return leg is ambiguous against the cycle\'s recorded return Relay legs');
    if (returnLegs[0]?.state !== 'SETTLED') refuse('the cycle\'s one recorded return Relay leg is not settled');
    if (canonicalJson(returnLegs[0]) !== canonicalJson(leg)) {
      refuse('the settled return leg does not match the cycle\'s durable Relay leg record');
    }
    // The durable custody ledger is keyed by canonical CAIP identity, never the leg's raw
    // destinationChainId/destinationAssetId pair -- the same canonical formula this file already
    // uses to identify the Operations native ETH balance below. `returnLegLedgerKeys` is the settlement
    // writer's own durable association of this exact relayRequestId to the row it actually wrote;
    // trusting it (rather than recomputing a key from the leg) is what makes this refuse any
    // competing or legacy-raw row instead of quietly accepting one.
    const canonicalChainId = NATIVE_PAYOUT_CHAIN_ID;
    const canonicalAssetId = 'native';
    const canonicalKey = `${canonicalChainId} ${canonicalAssetId}`;
    const associatedKey = cycle?.returnLegLedgerKeys?.get?.(leg.relayRequestId) ?? null;
    if (associatedKey !== canonicalKey) {
      refuse('the settled return leg has no durable association with the configured canonical native ETH custody ledger');
    }
    const rawKey = `${leg.destinationChainId} ${leg.destinationAssetId}`;
    if (rawKey !== canonicalKey && (cycle?.custodyLedgers?.get?.(rawKey) ?? null) !== null) {
      refuse('the settled return leg has a competing legacy raw-identity custody ledger row');
    }
    const ledger = cycle?.custodyLedgers?.get?.(canonicalKey) ?? null;
    if (!ledger || ledger.schema !== 'hookemon.custody-ledger.v3' || ledger.cycleId !== cycleId
      || ledger.chainId !== canonicalChainId || ledger.assetId !== canonicalAssetId || ledger.decimals !== NATIVE_PAYOUT_DECIMALS) {
      refuse('the settled return leg has no matching canonical cycle custody ledger');
    }
    if (ledger.returnReceived !== leg.netDeltaAtomic) refuse('the cycle custody ledger returnReceived does not match the settled return leg');
    return leg.netDeltaAtomic;
  }

  refuse('the return stage evidence does not use a recognized finalized-return schema');
  return undefined;
}

/** Reloads the exact provenance-bound predecessor dust record and requires either that it remain
 * an unconsumed durable predecessor record, or that this exact cycle already consumed it under the
 * current plan digest with no conflicting payout state -- the durable restart of a crash between
 * dust consumption and payout-state persistence that the existing atomic initializer repairs
 * idempotently rather than re-consuming. Every other consumed source stays refused. */
async function reloadPreviousDust({ cycleRepository, cycleId, previousDust, previousDustSource, planDigest }) {
  if (previousDust.amountAtomic === '0') return;
  if (typeof cycleRepository.readPayoutDust !== 'function') refuse('the cycle repository has no durable payout-dust reader');
  const asset = { chainId: previousDust.chainId, assetId: previousDust.assetId, decimals: previousDust.decimals };
  const reloaded = await cycleRepository.readPayoutDust(cycleId, asset);
  if (reloaded && reloaded.source !== null) {
    if (!sameTypedAmount(reloaded.amount, previousDust)) refuse('the reloaded predecessor dust amount does not match the plan');
    if (reloaded.source.cycleId !== previousDustSource.cycleId
      || reloaded.source.digest !== previousDustSource.digest
      || reloaded.source.planDigest !== previousDustSource.planDigest) {
      refuse('the reloaded predecessor dust provenance does not match the plan');
    }
    return;
  }
  if (typeof cycleRepository.readPayoutDustConsumption !== 'function') {
    refuse('the plan\'s carried dust is not an unconsumed durable predecessor record');
  }
  const consumption = await cycleRepository.readPayoutDustConsumption(cycleId, asset);
  if (!consumption
    || consumption.sourceCycleId !== previousDustSource.cycleId
    || consumption.sourceDigest !== previousDustSource.digest
    || consumption.sourcePlanDigest !== previousDustSource.planDigest
    || !sameTypedAmount(consumption.amount, previousDust)) {
    refuse('the plan\'s carried dust is not an unconsumed durable predecessor record');
  }
  if (consumption.planDigest !== planDigest) {
    refuse('the plan\'s already-consumed dust is bound to a different payout plan digest');
  }
  const attempt = await cycleRepository.readStageAttempt(cycleId, 'payout');
  if (attempt !== null && attempt !== undefined) {
    refuse('the plan\'s already-consumed dust conflicts with existing payout state');
  }
}

/** Proves the Operations native ETH balance at a finalized height through the dedicated EVM native ETH
 * `CustodyBalanceObservationV1` producer (evm-custody-balance-observation.mjs), which owns the
 * public/archive/same-height-public read discipline. This function only pins the request identity
 * and enforces the rule that reader deliberately never enforces itself: the observed wallet-wide
 * balance is never distributable on its own, it must at least cover the exact cycle-attributed
 * return-plus-dust sum. */
async function reloadFinalizedOperationsNativeBalance({ publicClient, archiveClient, assetId, operations, attributedAtomic }) {
  // Convert this reader's already independently validated raw request identity (a raw EVM chain id
  // and a raw ERC20 address) into the exact canonical CAIP identity the producer requires -- never
  // trusted from anywhere else, since `assetId`/`operations` were already checked against
  // `NATIVE_PAYOUT_CHAIN_ID`/an EVM address pattern by this file's own `assertRequest`.
  const observeBalance = createNativeCustodyBalanceObservationReader({
    publicClient,
    archiveClient,
    identity: {
      chainId: NATIVE_PAYOUT_CHAIN_ID,
      assetId: 'native',
      decimals: NATIVE_PAYOUT_DECIMALS,
      account: operations,
    },
  });
  const observation = await observeBalance();
  if (BigInt(observation.balance.amountAtomic) < attributedAtomic) {
    refuse('the finalized Operations native ETH balance is below the attributed return and dust');
  }
}

/**
 * Builds the owned `readCycleAttributableFinalizedAvailable` reader composition wires onto the
 * production Robinhood client. `cycleRepository` must be the private, durable repository instance
 * (never a client-facing subset) and `archiveClient` the distinct archive-capable evidence client;
 * both are closed over here so an injected raw client can never substitute its own attribution.
 */
export function createCycleAttributableFinalizedAvailableReader({ cycleRepository, publicClient, archiveClient }) {
  if (!cycleRepository || typeof cycleRepository.readStage !== 'function' || typeof cycleRepository.describeCycle !== 'function'
    || typeof cycleRepository.readStageAttempt !== 'function') {
    refuse('a durable cycle repository with readStage, describeCycle, and readStageAttempt is required');
  }
  return async function readCycleAttributableFinalizedAvailable(requestValue) {
    const request = assertRequest(requestValue);
    const cycle = await cycleRepository.describeCycle(request.cycleId);
    const observedReturnAtomic = await reloadFinalizedReturnAmount({
      cycleRepository,
      cycleId: request.cycleId,
      operations: request.operations,
      assetId: request.assetId,
      evidenceDigest: request.evidenceDigest,
      cycle,
    });
    if (observedReturnAtomic !== request.returnDelta.amountAtomic) {
      refuse('the reloaded finalized return amount does not match the plan\'s attributed return delta');
    }
    await reloadPreviousDust({
      cycleRepository,
      cycleId: request.cycleId,
      previousDust: request.previousDust,
      previousDustSource: request.previousDustSource,
      planDigest: request.planDigest,
    });
    const attributedAtomic = BigInt(request.returnDelta.amountAtomic) + BigInt(request.previousDust.amountAtomic);
    if (attributedAtomic > 0n) await reloadFinalizedOperationsNativeBalance({
      publicClient,
      archiveClient,
      assetId: request.assetId,
      operations: request.operations,
      attributedAtomic,
    });
    return createNativePayoutAmount({ assetId: request.assetId, amountAtomic: attributedAtomic.toString() });
  };
}
