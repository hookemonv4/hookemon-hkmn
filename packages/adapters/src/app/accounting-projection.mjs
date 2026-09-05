// Projects one cycle's real per-cycle accounting from `cycleRepository`'s durable stage evidence
// (this package's own journal — see cycle-repository.mjs's header for why it is a fresh, independent
// journal rather than a wrapper around CycleRunner) into the exact `RoundAccounting` shape
// packages/dashboard/src/contracts/public-cycle-status.mjs's `readRoundAccounting` (schemaVersion 3)
// requires. Consumed as an injected `readAccounting(cycleId)` function — never imported by
// packages/runner or packages/dashboard directly, so neither package gains a dependency on this one
// (see compose.mjs's dashboard composition, which is the only real caller, and routes/public.mjs's
// `ctx.readAccounting` seam, the same "optional live capability the composition root wires in"
// pattern `ctx.triggerTick`/`ctx.requestRecovery` already use).
//
// Honesty rule (AGENTS.md R4/R5 — never guess a money-relevant value): every field below is either a
// real amount actually read back from a stage's own durably-recorded evidence, a value derived from
// two such real amounts by plain arithmetic (never assumed), or the schema's own documented "nothing
// observed yet" default (`null`, or `'0'` for the four fields the contract requires to be present).
// Nothing here is invented to make a field "look complete" — most fields stay `null` today because no
// stage's real mutation evidence produces them yet (see stage-driver.mjs's header for exactly which
// six of the eight stages still refuse under liveMode:true, and why).
//
// Units: every `*MicroUsdg` field here is the same six-decimal atomic USDG unit
// `packages/runner/src/automation/budget-gate.mjs`'s `parseAtomicUsdg` validates (its own name for
// exactly the same unit `environment.mjs`'s `budget.*Usdg` fields and `cycleRepository`'s own
// `releaseAmount` already use) — i.e. `cycleRepository`'s decimal-string amounts need no unit
// conversion to become a `*MicroUsdg` field; see docs/modules/composition-root.md for the citation.
const ACCOUNTING_STAGES = Object.freeze(['funding', 'outbound', 'purchase', 'buyback', 'return', 'distribution', 'payout']);

function isCompleteStage(stageRecord) {
  return stageRecord?.status === 'COMPLETE';
}

/** `max(a - b, 0)` over two canonical unsigned-decimal strings, as a canonical unsigned-decimal
 * string — the same "gain/loss are the positive and negative half of one difference, one of the two
 * is always exactly '0'" shape `readLegacyRoundAccounting` in the website's own validator already
 * documents. */
function subtractAtZero(a, b) {
  const result = BigInt(a) - BigInt(b);
  return result > 0n ? result.toString() : '0';
}

/** The real, already-fetched outbound bridge quote's origin/destination amounts (see
 * stage-driver.mjs's `probeOutbound`, which now records `quotedOriginAmount`/
 * `quotedDestinationAmount` on the outbound stage's evidence whenever the injected relay adapter's
 * `QuoteResult` actually carries them — real relay-client.mjs always does; an injected test fake may
 * not, in which case this honestly reports `null` rather than guessing a fee). Origin (USDG on
 * Robinhood Chain) and destination (Circle USD on Solana) are both six-decimal, ~1:1-pegged stables,
 * so "amount in minus amount out" is a reasonable, clearly-derived bridge-fee estimate — never a
 * fabricated number. */
function outboundBridgeFee(outboundStage) {
  const evidence = outboundStage?.evidence;
  const origin = evidence?.quotedOriginAmount;
  const destination = evidence?.quotedDestinationAmount;
  if (typeof origin !== 'string' || typeof destination !== 'string') return null;
  return subtractAtZero(origin, destination);
}

/** Workflow-state labels derived directly from which stages are durably COMPLETE — never a
 * fabricated dollar figure, just an honest description of where the cycle's holder-reward path
 * actually is. Distribution/payout never durably complete today (both still refuse under
 * liveMode:true — see stage-driver.mjs), so every real cycle reports 'not-started' until a later
 * work package lands their production mutation. */
function rewardStatus(distributionStage, payoutStage) {
  if (isCompleteStage(payoutStage)) return 'paid';
  if (isCompleteStage(distributionStage)) return 'distribution-verified';
  return 'not-started';
}

function distributionStatus(returnStage, distributionStage, payoutStage) {
  if (isCompleteStage(payoutStage)) return 'settled';
  if (isCompleteStage(distributionStage)) return 'verified';
  if (isCompleteStage(returnStage)) return 'awaiting-distribution';
  return 'not-started';
}

/**
 * @param {object} input
 * @param {object} input.cycleRepository - a `CycleRepository`-shaped object (`readStage`/
 *   `describeCycle`); see cycle-repository.mjs.
 * @param {string} input.cycleId
 * @returns {Promise<object>} the exact `RoundAccounting` shape
 *   `packages/dashboard/src/contracts/public-cycle-status.mjs`'s `readRoundAccounting` requires.
 */
export async function projectCycleAccounting({ cycleRepository, cycleId }) {
  if (!cycleRepository || typeof cycleRepository.readStage !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('projectCycleAccounting requires a cycleRepository exposing readStage/describeCycle');
  }
  if (typeof cycleId !== 'string' || cycleId.length === 0) throw new Error('projectCycleAccounting requires a cycleId');

  const [description, ...stages] = await Promise.all([
    cycleRepository.describeCycle(cycleId),
    ...ACCOUNTING_STAGES.map(stage => cycleRepository.readStage(cycleId, stage)),
  ]);
  const [funding, outbound, purchase, buyback, returnStage, distribution, payout] = stages;
  void funding; // read for symmetry/future use; funding carries no accounting amount today.

  // The cycle's own budgeted release amount, attributed as real spend once the purchase stage
  // durably completes — the closest honest proxy available: neither Collector Crypt's
  // generatePack/openPack response schema (collector-crypt.mjs's `assertGeneratePackResponse`/
  // `assertOpenPackResponse`) documents a settled price field, so there is no better real number to
  // report yet. Before purchase completes, nothing has been spent, so this stays '0'.
  const packSpendMicroUsdg = isCompleteStage(purchase) && typeof description.releaseAmount === 'string'
    ? description.releaseAmount
    : '0';

  // Rehearsal-only source: finalized Circle USD proceeds use six decimals and are treated 1:1 with
  // USDG. Never use buyback evidence's refundAmount, whose decimal scale is not documented.
  const buybackMicroSolanaStable = payout?.evidence?.proceedsMicroSolanaStable;
  const buybackMicroUsdg = isCompleteStage(payout) && typeof buybackMicroSolanaStable === 'string'
    ? buybackMicroSolanaStable
    : '0';

  return Object.freeze({
    packSpendMicroUsdg,
    buybackMicroUsdg,
    packGainMicroUsdg: subtractAtZero(buybackMicroUsdg, packSpendMicroUsdg),
    packLossMicroUsdg: subtractAtZero(packSpendMicroUsdg, buybackMicroUsdg),
    quotedCosts: Object.freeze({
      outboundBridgeMicroUsdg: outboundBridgeFee(outbound),
      inboundBridgeMicroUsdg: null, // return never quotes today — see stage-driver.mjs's probeReturn.
      collectorApiMicroUsdg: null,
      evmNetworkMicroUsdg: null,
      solanaNetworkMicroUsdg: null,
      slippageMicroUsdg: null,
    }),
    protectedCostsMicroUsdg: null,
    confirmedCostsMicroUsdg: null,
    cycleGainMicroUsdg: null,
    cycleLossMicroUsdg: null,
    walletBalanceBeforeMicroUsdg: null,
    walletBalanceAfterMicroUsdg: null,
    networkFees: Object.freeze({ walletLamportsCharged: null, purchase: null, buyback: null }),
    feeReserveBeforeMicroUsdg: null,
    feeReserveTargetMicroUsdg: null,
    feeReserveTopUpMicroUsdg: null,
    feeReserveAfterMicroUsdg: null,
    plannedHolderRewardsMicroUsdg: null,
    paidHolderRewardsMicroUsdg: null,
    holderRewardsStatus: rewardStatus(distribution, payout),
    distributionStatus: distributionStatus(returnStage, distribution, payout),
  });
}

const POLICY_CUSTODY_BUCKETS = Object.freeze(['residual', 'payoutLiability', 'dust', 'refunds']);
const POLICY_CUSTODY_CURRENT_BUCKETS = Object.freeze([
  'refunds',
  'residual',
  'heldAssets',
  'payoutLiability',
  'dust',
  'unattributed',
]);
const POLICY_CUSTODY_ALL_BUCKETS = Object.freeze([
  'claimed',
  'bridgeOut',
  'bridgeIn',
  'packCost',
  'buybackProceeds',
  'returnInput',
  'returnReceived',
  'refunds',
  'residual',
  'heldAssets',
  'payoutLiability',
  'dust',
  'unattributed',
]);
const atomicAmountPattern = /^(0|[1-9][0-9]*)$/;

function assertPolicyAssetIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('projectPolicyCustody requires an evmUsdg asset identity');
  }
  if (typeof value.chainId !== 'string' || value.chainId.length === 0
    || typeof value.assetId !== 'string' || value.assetId.length === 0
    || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
    throw new Error('projectPolicyCustody evmUsdg asset identity is invalid');
  }
  return value;
}

function parsePolicyAtomic(value, label) {
  if (typeof value !== 'string' || !atomicAmountPattern.test(value)) {
    throw new Error(`projectPolicyCustody ${label} must be a canonical unsigned decimal string`);
  }
  return BigInt(value);
}

function assertPolicyLedger(ledger, cycleId) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('projectPolicyCustody custody ledger is invalid');
  }
  if (ledger.cycleId !== cycleId || typeof ledger.chainId !== 'string' || typeof ledger.assetId !== 'string'
    || !Number.isInteger(ledger.decimals) || ledger.decimals < 0 || ledger.decimals > 255) {
    throw new Error('projectPolicyCustody custody ledger identity is invalid');
  }
  for (const bucket of POLICY_CUSTODY_ALL_BUCKETS) parsePolicyAtomic(ledger[bucket], `custody ledger ${bucket}`);
  return ledger;
}

function ledgerMatchesAsset(ledger, asset) {
  return ledger.chainId === asset.chainId && ledger.assetId === asset.assetId && ledger.decimals === asset.decimals;
}

function ledgerHasCurrentCustody(ledger) {
  return POLICY_CUSTODY_CURRENT_BUCKETS.some(bucket => parsePolicyAtomic(ledger[bucket], `custody ledger ${bucket}`) > 0n);
}

function freezePolicyCycle(value) {
  return Object.freeze({
    cycleId: value.cycleId,
    realizedLossMicroUsdg: value.realizedLossMicroUsdg.toString(),
    atRiskMicroUsdg: value.atRiskMicroUsdg.toString(),
    outstandingMicroUsdg: value.outstandingMicroUsdg.toString(),
  });
}

/**
 * Projects the policy engine's USDG-only custody controls from every active and archived cycle.
 * It never applies a price or decimal conversion: any non-USDG ledger with a nonzero balance marks
 * the projection unvalued so the policy engine pauses the next claim. Each cycle is reduced on its
 * own before totals are added, so a return or balance from one cycle cannot offset another cycle.
 */
export async function projectPolicyCustody({ cycleRepository, evmUsdg }) {
  if (!cycleRepository || typeof cycleRepository.listKnownCycleIds !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('projectPolicyCustody requires a cycleRepository exposing listKnownCycleIds/describeCycle');
  }
  const asset = assertPolicyAssetIdentity(evmUsdg);
  const cycleIds = await cycleRepository.listKnownCycleIds();
  if (!Array.isArray(cycleIds) || cycleIds.some(cycleId => typeof cycleId !== 'string' || cycleId.length === 0)) {
    throw new Error('projectPolicyCustody cycle repository returned invalid cycle ids');
  }

  let realizedLoss = 0n;
  let atRisk = 0n;
  let outstanding = 0n;
  let heldAssets = false;
  let unattributed = false;
  let unvaluedExposure = false;
  const cycles = [];

  for (const cycleId of [...cycleIds].sort()) {
    const description = await cycleRepository.describeCycle(cycleId);
    if (!description || typeof description !== 'object' || !(description.custodyLedgers instanceof Map)) {
      throw new Error('projectPolicyCustody cycle description is invalid');
    }
    let cycleRealizedLoss = 0n;
    let cycleAtRisk = 0n;
    let cycleOutstanding = 0n;
    for (const ledgerValue of description.custodyLedgers.values()) {
      const ledger = assertPolicyLedger(ledgerValue, cycleId);
      const held = parsePolicyAtomic(ledger.heldAssets, 'custody ledger heldAssets') > 0n;
      const unknownDeposit = parsePolicyAtomic(ledger.unattributed, 'custody ledger unattributed') > 0n;
      heldAssets ||= held;
      unattributed ||= unknownDeposit;

      if (!ledgerMatchesAsset(ledger, asset)) {
        if (ledgerHasCurrentCustody(ledger)) unvaluedExposure = true;
        continue;
      }

      const claimed = parsePolicyAtomic(ledger.claimed, 'custody ledger claimed');
      const returned = parsePolicyAtomic(ledger.returnReceived, 'custody ledger returnReceived');
      const unresolvedClaim = claimed > returned ? claimed - returned : 0n;
      if (description.terminalState === 'COMPLETED') cycleRealizedLoss += unresolvedClaim;
      else cycleAtRisk += unresolvedClaim;
      cycleOutstanding += unresolvedClaim;
      for (const bucket of POLICY_CUSTODY_BUCKETS) {
        cycleOutstanding += parsePolicyAtomic(ledger[bucket], `custody ledger ${bucket}`);
      }
    }
    realizedLoss += cycleRealizedLoss;
    atRisk += cycleAtRisk;
    outstanding += cycleOutstanding;
    cycles.push(freezePolicyCycle({
      cycleId,
      realizedLossMicroUsdg: cycleRealizedLoss,
      atRiskMicroUsdg: cycleAtRisk,
      outstandingMicroUsdg: cycleOutstanding,
    }));
  }

  return Object.freeze({
    realizedLossMicroUsdg: realizedLoss.toString(),
    atRiskMicroUsdg: atRisk.toString(),
    outstandingMicroUsdg: outstanding.toString(),
    heldAssets,
    unattributed,
    unvaluedExposure,
    cycles: Object.freeze(cycles),
  });
}
