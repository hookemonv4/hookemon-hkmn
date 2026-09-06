// Projects one cycle's real per-cycle accounting from `cycleRepository`'s durable stage evidence
// (this package's own journal — see cycle-repository.mjs's header for why it is a fresh, independent
// journal rather than a wrapper around CycleRunner) into the exact `RoundAccounting` shape
// packages/dashboard/src/contracts/public-cycle-status.mjs's `readRoundAccounting` (schemaVersion 6)
// requires. Consumed as an injected `readAccounting(cycleId)` function — never imported by
// packages/runner or packages/dashboard directly, so neither package gains a dependency on this one
// (see compose.mjs's dashboard composition, which is the only real caller, and routes/public.mjs's
// `ctx.readAccounting` seam, the same "optional live capability the composition root wires in"
// pattern `ctx.triggerTick`/`ctx.requestRecovery` already use).
//
// Honesty rule (AGENTS.md R4/R5 — never guess a money-relevant value): every field below is either a
// real amount actually read back from a stage's own durably-recorded evidence, a value derived from
// two such real amounts by plain arithmetic (never assumed), or `null` ("nothing observed yet").
// Nothing here is invented to make a field "look complete," and nothing is reported as `'0'` merely
// because it hasn't happened yet — an unknown amount is `null`, exactly as the frozen `Amount`
// contract requires. Most fields stay `null` today because no stage's real mutation evidence
// produces them yet (see stage-driver.mjs's header for exactly which six of the eight stages still
// refuse under liveMode:true, and why).
//
// Units: every `*MicroUsdg` field here is the same six-decimal atomic USDG unit
// `packages/runner/src/automation/budget-gate.mjs`'s `parseAtomicUsdg` validates (its own name for
// exactly the same unit `environment.mjs`'s `budget.*Usdg` fields and `cycleRepository`'s own
// `releaseAmount` already use) — i.e. `cycleRepository`'s decimal-string amounts need no unit
// conversion to become a `*MicroUsdg` field; see docs/modules/composition-root.md for the citation.
//
// Asset identity discipline: a `*MicroUsdg` field is only ever populated from evidence already
// proven to be USDG on chain 4663 (payout evidence's own `assertUsdAmount`, or a relay leg's own
// `sourceChainId`/`destinationChainId` fields for the EVM side of a bridge leg). `packSpendMicroUsdg`/
// `buybackMicroUsdg`/`packGainMicroUsdg`/`packLossMicroUsdg` describe pack economics and have no
// same-asset USDG producer today — the only settled USDG amounts available are bridge *movements*
// (`outboundBridgeDebit`/`inboundBridgeProceeds`, kept as separately named typed fields), and the
// actual Collector Crypt purchase/buyback debit is a different asset (Solana USDC,
// `collectorPurchaseDebit`/`collectorBuybackProceeds`). Neither may be relabeled as the other's
// asset or subtracted against it — see `outboundBridgeFee`'s and `projectCycleAccounting`'s own
// comments for the two concrete anti-patterns this module previously had and no longer has.
import { USDG_PAYOUT_CHAIN_ID, USDG_PAYOUT_DECIMALS } from '../../../runner/src/distribution/payout-plan.mjs';

const ACCOUNTING_STAGES = Object.freeze(['funding', 'outbound', 'purchase', 'buyback', 'return', 'distribution', 'payout']);

function isCompleteStage(stageRecord) {
  return stageRecord?.status === 'COMPLETE';
}

/** `max(a - b, 0)` over two canonical unsigned-decimal strings, as a canonical unsigned-decimal
 * string — the same "gain/loss are the positive and negative half of one difference, one of the two
 * is always exactly '0'" shape `readLegacyRoundAccounting` in the website's own validator already
 * documents. Callers must have already verified both operands are the same asset — this function
 * has no asset identity to check. */
function subtractAtZero(a, b) {
  const result = BigInt(a) - BigInt(b);
  return result > 0n ? result.toString() : '0';
}

/** The outbound bridge's quoted origin (USDG) and destination (Solana USDC) amounts are two
 * different assets on two different chains. Equal decimals and an approximate peg are not a
 * same-asset fee: `origin - destination` would silently mix a USDG figure with a USDC figure and
 * report the difference as if it were a USDG cost. No same-asset bridge-fee evidence exists
 * anywhere in the current stage evidence, so this honestly stays `null` rather than fabricate a
 * cross-asset subtraction. A later work package may replace this once the relay adapter reports an
 * actual same-asset protocol fee or a trusted conversion rate. */
function outboundBridgeFee() {
  return null;
}

/** The single relay leg of the given direction that is durably `SETTLED`, i.e. actually confirmed
 * on both chains — never a probe-time quote. Returns `null` when no such leg exists yet (nothing
 * has settled) or when more than one exists (ambiguous; a later work package's recovery/operator
 * tooling resolves that, this read-only projection never guesses which one is real). `outbound`
 * legs originate on the Robinhood Chain in USDG by construction (see stages/outbound.mjs); `return`
 * legs land back on the Robinhood Chain in USDG by construction (see stages/return.mjs) — so
 * `sourceAmountAtomic`/`destinationAmountAtomic` here are real USDG amounts, not a Solana-USDC
 * figure treated at an assumed parity. */
function settledRelayLeg(relayLegs, direction) {
  if (!(relayLegs instanceof Map)) return null;
  const matches = [...relayLegs.values()].filter(leg => leg?.direction === direction && leg?.state === 'SETTLED');
  return matches.length === 1 ? matches[0] : null;
}

/** Projects a typed amount (`{chainId, assetId, decimals, amountAtomic}` — `chainId` may be a
 * number, as `payout-plan.mjs`'s `createUsdgPayoutAmount`/`money-schemas.mjs`'s `assertTypedAmount`
 * both produce, depending on the producer) into the frozen public `Amount` shape (`{chainId,
 * assetId, decimals, units}`, `chainId` always a string) — a field rename/stringify at the public
 * boundary only, never a value conversion. Returns `null` for anything not shaped like a typed
 * amount, so a missing/malformed evidence field degrades to "unknown," never a fabricated zero. */
function publicAmount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { chainId, assetId, decimals, amountAtomic } = value;
  if ((typeof chainId !== 'string' || chainId.length === 0) && !Number.isInteger(chainId)) return null;
  if (typeof assetId !== 'string' || assetId.length === 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  if (typeof amountAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amountAtomic)) return null;
  return Object.freeze({ chainId: String(chainId), assetId, decimals, units: amountAtomic });
}

/** Two typed amounts identify the exact same asset on the exact same chain (never merely "same
 * decimals" — that was the cross-asset bug this projection previously had). Used to verify a
 * payout evidence bundle is internally consistent before trusting any arithmetic across its parts. */
function sameAsset(left, right) {
  return left !== null && right !== null
    && left.chainId === right.chainId && left.assetId === right.assetId && left.decimals === right.decimals;
}

const PAYOUT_EVIDENCE_SCHEMA = 'hookemon.direct-payout-result.v1';
// Reused from the authoritative producer (packages/runner/src/distribution/payout-plan.mjs) rather
// than re-declared, so this projection's notion of "real USDG" can never silently drift from the
// one payout.mjs itself enforces via assertUsdAmount.
const EXPECTED_USDG_CHAIN_ID = String(USDG_PAYOUT_CHAIN_ID);
const NON_PAID_RECIPIENT_STATES = new Set(['REFUSED', 'NONCE_INTERFERENCE']);

function isExpectedUsdg(amount) {
  return amount !== null && amount.chainId === EXPECTED_USDG_CHAIN_ID && amount.decimals === USDG_PAYOUT_DECIMALS;
}

/** A recipient is only ever counted as paid when it carries the same finality proof
 * `stages/payout.mjs`'s own `normalizeAttempt`/`finalizingAttempt` require before a durable write
 * ever sets `state: 'FINALIZED'`: a `transactionHash` and a `finalizedTransfer` whose own `amount`
 * matches the recipient's allocated amount exactly. The `FINALIZED` label alone (e.g. a malformed
 * or injected evidence bundle claiming it without the proof) is never sufficient. */
function finalizedRecipientAmount(recipient, expectedAsset) {
  if (recipient?.state !== 'FINALIZED') return null;
  if (typeof recipient.transactionHash !== 'string' || recipient.transactionHash.length === 0) return null;
  if (!recipient.finalizedTransfer || typeof recipient.finalizedTransfer !== 'object' || Array.isArray(recipient.finalizedTransfer)) return null;
  const recipientAmount = publicAmount(recipient.amount);
  const transferAmount = publicAmount(recipient.finalizedTransfer.amount);
  if (recipientAmount === null || transferAmount === null) return null;
  if (!sameAsset(recipientAmount, expectedAsset) || !sameAsset(transferAmount, expectedAsset)) return null;
  if (transferAmount.units !== recipientAmount.units) return null;
  return recipientAmount;
}

/**
 * Projects the payout stage's own finalized-transfer evidence (see `stages/payout.mjs`'s
 * `payoutTerminalEvidence` — durable `distributablePool`/`totalAllocated`/`dust`, each recipient's
 * final `state`/`amount`/`transactionHash`/`finalizedTransfer`, and `quarantine` liabilities) into
 * real paid/planned/liability/dust amounts and a recipient count. The payout stage reaching
 * `COMPLETE` only proves recipient conservation was reached, not that every recipient was actually
 * paid — some may be `REFUSED` or `NONCE_INTERFERENCE` (durably recorded as `quarantine` liabilities
 * instead of a transfer). Every amount here is verified to be real USDG on chain 4663 (the same
 * identity `assertUsdAmount` enforces at write time) and every conservation/pairing invariant
 * `stages/payout.mjs` itself enforces (`isDirectPayoutComplete`'s `paid + quarantined + dust ==
 * distributablePool`, `assertPlan`'s `totalAllocated + dust == distributablePool`, and quarantine
 * pairing exactly one-to-one with non-paid recipients) is re-verified here before trusting any of
 * it — a malformed, asset-inconsistent, non-conserving, or mispaired bundle fails closed to all
 * `null` rather than infer anything from the stage's `COMPLETE` label alone. */
function projectPayoutEvidence(payoutStage, cycleId) {
  const allNull = Object.freeze({
    plannedHolderRewardsMicroUsdg: null,
    paidHolderRewardsMicroUsdg: null,
    payoutLiabilityMicroUsdg: null,
    payoutDustMicroUsdg: null,
    paidHolderRewardsRecipientCount: null,
    holderRewardsPaidOut: false,
  });
  if (!isCompleteStage(payoutStage)) return allNull;
  const evidence = payoutStage.evidence;
  if (
    !evidence || evidence.schema !== PAYOUT_EVIDENCE_SCHEMA || evidence.cycleId !== cycleId
    || !Array.isArray(evidence.recipients) || !Array.isArray(evidence.quarantine)
  ) {
    return allNull;
  }
  const distributablePool = publicAmount(evidence.distributablePool);
  const totalAllocated = publicAmount(evidence.totalAllocated);
  const dust = publicAmount(evidence.dust);
  if (distributablePool === null || totalAllocated === null || dust === null) return allNull;
  if (!isExpectedUsdg(distributablePool) || !sameAsset(distributablePool, totalAllocated) || !sameAsset(distributablePool, dust)) {
    return allNull;
  }
  // Plan-level conservation (assertPlan's own invariant): totalAllocated + dust == distributablePool.
  if (BigInt(totalAllocated.units) + BigInt(dust.units) !== BigInt(distributablePool.units)) return allNull;

  let paidAtomic = 0n;
  let recipientCount = 0;
  const nonPaidRecipients = [];
  for (const recipient of evidence.recipients) {
    if (!recipient || typeof recipient !== 'object') return allNull;
    const finalized = finalizedRecipientAmount(recipient, distributablePool);
    if (finalized !== null) {
      paidAtomic += BigInt(finalized.units);
      recipientCount += 1;
      continue;
    }
    if (!NON_PAID_RECIPIENT_STATES.has(recipient.state)) return allNull;
    const amount = publicAmount(recipient.amount);
    if (amount === null || !sameAsset(amount, distributablePool)) return allNull;
    nonPaidRecipients.push({ recipient: recipient.recipient, units: amount.units });
  }

  // Quarantine must pair exactly one-to-one with non-paid recipients — the same invariant
  // finalizeDirectPayoutResult itself enforces before ever writing this evidence.
  if (evidence.quarantine.length !== nonPaidRecipients.length) return allNull;
  const remainingNonPaid = [...nonPaidRecipients];
  let liabilityAtomic = 0n;
  for (const liability of evidence.quarantine) {
    const amount = publicAmount(liability?.amount);
    if (amount === null || !sameAsset(amount, distributablePool)) return allNull;
    const matchIndex = remainingNonPaid.findIndex(
      entry => entry.recipient === liability?.recipient && entry.units === amount.units,
    );
    if (matchIndex === -1) return allNull;
    remainingNonPaid.splice(matchIndex, 1);
    liabilityAtomic += BigInt(amount.units);
  }

  // Full conservation (isDirectPayoutComplete's own invariant): paid + quarantined + dust ==
  // distributablePool.
  if (paidAtomic + liabilityAtomic + BigInt(dust.units) !== BigInt(distributablePool.units)) return allNull;

  return Object.freeze({
    plannedHolderRewardsMicroUsdg: totalAllocated.units,
    paidHolderRewardsMicroUsdg: paidAtomic.toString(),
    payoutLiabilityMicroUsdg: liabilityAtomic.toString(),
    payoutDustMicroUsdg: dust.units,
    paidHolderRewardsRecipientCount: recipientCount,
    holderRewardsPaidOut: liabilityAtomic === 0n && paidAtomic === BigInt(totalAllocated.units),
  });
}

/** Workflow-state label derived from real evidence, never from the payout stage's `COMPLETE` status
 * alone — `COMPLETE` only proves recipient conservation was reached, which can include quarantined
 * (`REFUSED`/`NONCE_INTERFERENCE`) recipients that were never actually paid. `payoutEvidence` is
 * `projectPayoutEvidence`'s own output. */
function rewardStatus(distributionStage, payoutStage, payoutEvidence) {
  if (isCompleteStage(payoutStage)) {
    if (payoutEvidence.paidHolderRewardsMicroUsdg === null) return 'awaiting-verification';
    return payoutEvidence.holderRewardsPaidOut ? 'paid' : 'paid-with-liabilities';
  }
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
 * @returns {Promise<object>} the exact schemaVersion-6 `RoundAccounting` shape
 *   `packages/dashboard/src/contracts/public-cycle-status.mjs`'s `readRoundAccounting` requires.
 *   `packSpendMicroUsdg`/`buybackMicroUsdg`/`packGainMicroUsdg`/`packLossMicroUsdg` describe pack
 *   economics in USDG and have no honest producer today: the only settled USDG-denominated amounts
 *   available are bridge movements (`outboundBridgeDebit`/`inboundBridgeProceeds`, typed and kept
 *   separately), not the actual Collector Crypt purchase/buyback debit (which is denominated in
 *   Solana USDC — `collectorPurchaseDebit`/`collectorBuybackProceeds`). Reporting a bridge amount or
 *   a cross-asset figure under a `MicroUsdg`-labeled pack-economics field would misrepresent it, so
 *   these four stay `null` until a same-asset USDG pack-economics producer exists.
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
  void outbound; // no same-asset bridge-fee evidence exists yet — see outboundBridgeFee's own header.

  // Real, settled EVM-side bridge movements — how much USDG left/returned to operator custody.
  // Explicitly named as bridge amounts, never folded into a pack-economics field: bridging
  // fees/slippage/unspent balance mean this is not the same number as the actual Collector Crypt
  // purchase/buyback debit (see collectorPurchaseDebit/collectorBuybackProceeds below).
  const outboundLeg = settledRelayLeg(description.relayLegs, 'outbound');
  const outboundBridgeDebit = outboundLeg !== null
    ? publicAmount({ chainId: outboundLeg.sourceChainId, assetId: outboundLeg.sourceAssetId, decimals: outboundLeg.sourceDecimals, amountAtomic: outboundLeg.sourceAmountAtomic })
    : null;
  const returnLeg = settledRelayLeg(description.relayLegs, 'return');
  const inboundBridgeProceeds = returnLeg !== null
    ? publicAmount({ chainId: returnLeg.destinationChainId, assetId: returnLeg.destinationAssetId, decimals: returnLeg.destinationDecimals, amountAtomic: returnLeg.destinationAmountAtomic })
    : null;

  // The real, chain/asset-tagged Collector Crypt purchase debit / buyback proceeds (Solana), from
  // the purchase/buyback stages' own finalized settlement evidence — never assumed equal to the
  // EVM bridge amounts above at any parity.
  const collectorPurchaseDebit = isCompleteStage(purchase) ? publicAmount(purchase?.evidence?.packCost) : null;
  const collectorBuybackProceeds = isCompleteStage(buyback) ? publicAmount(buyback?.evidence?.proceeds) : null;

  // No honest USDG-denominated pack-spend/buyback/gain/loss producer exists: the bridge amounts are
  // a different fact (custody movement) and the Collector amounts are a different asset (Solana
  // USDC). Computing a "gain/loss" from either would either mix assets or silently relabel a bridge
  // movement as pack economics — both are exactly the anti-patterns this projection must avoid.
  const packSpendMicroUsdg = null;
  const buybackMicroUsdg = null;
  const packGainMicroUsdg = null;
  const packLossMicroUsdg = null;

  const payoutEvidence = projectPayoutEvidence(payout, cycleId);

  return Object.freeze({
    packSpendMicroUsdg,
    buybackMicroUsdg,
    outboundBridgeDebit,
    inboundBridgeProceeds,
    collectorPurchaseDebit,
    collectorBuybackProceeds,
    packGainMicroUsdg,
    packLossMicroUsdg,
    quotedCosts: Object.freeze({
      outboundBridgeMicroUsdg: outboundBridgeFee(),
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
    plannedHolderRewardsMicroUsdg: payoutEvidence.plannedHolderRewardsMicroUsdg,
    paidHolderRewardsMicroUsdg: payoutEvidence.paidHolderRewardsMicroUsdg,
    payoutLiabilityMicroUsdg: payoutEvidence.payoutLiabilityMicroUsdg,
    payoutDustMicroUsdg: payoutEvidence.payoutDustMicroUsdg,
    paidHolderRewardsRecipientCount: payoutEvidence.paidHolderRewardsRecipientCount,
    holderRewardsStatus: rewardStatus(distribution, payout, payoutEvidence),
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
  'heldPositions',
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

function openHeldPositions(description, cycleId) {
  if (description.heldPositions === undefined) return [];
  if (!(description.heldPositions instanceof Map)) {
    throw new Error('projectPolicyCustody held positions are invalid');
  }
  const positions = [];
  for (const [positionId, position] of description.heldPositions) {
    if (!position || typeof position !== 'object' || Array.isArray(position)
      || typeof positionId !== 'string' || position.positionId !== positionId
      || position.cycleId !== cycleId || !Object.hasOwn(position, 'resolution')) {
      throw new Error('projectPolicyCustody held position identity is invalid');
    }
    parsePolicyAtomic(position.costMicroUsdg, 'held position costMicroUsdg');
    const valueMicroUsdg = parsePolicyAtomic(position.valueMicroUsdg, 'held position valueMicroUsdg');
    if (typeof position.reason !== 'string' || position.reason.length === 0
      || typeof position.terminalState !== 'string' || position.terminalState.length === 0
      || typeof position.evidenceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(position.evidenceDigest)
      || !Number.isSafeInteger(position.openedAtMs) || position.openedAtMs < 0
      || !Number.isSafeInteger(position.positionRevision) || position.positionRevision < 0
      || !Object.hasOwn(position, 'insuredValue') || !Object.hasOwn(position, 'ownerDecision')) {
      throw new Error('projectPolicyCustody held position evidence is invalid');
    }
    if (position.insuredValue !== null && (typeof position.insuredValue !== 'object' || Array.isArray(position.insuredValue))) {
      throw new Error('projectPolicyCustody held position insuredValue is invalid');
    }
    if (position.ownerDecision !== null && (typeof position.ownerDecision !== 'object' || Array.isArray(position.ownerDecision))) {
      throw new Error('projectPolicyCustody held position ownerDecision is invalid');
    }
    if (position.resolution !== null) continue;
    positions.push(Object.freeze({
      positionId,
      cycleId,
      costMicroUsdg: position.costMicroUsdg,
      valueMicroUsdg: valueMicroUsdg.toString(),
      insuredValue: position.insuredValue === null ? null : structuredClone(position.insuredValue),
      reason: position.reason,
      terminalState: position.terminalState,
      evidenceDigest: position.evidenceDigest,
      openedAtMs: position.openedAtMs,
      positionRevision: position.positionRevision,
      ownerDecision: position.ownerDecision === null ? null : structuredClone(position.ownerDecision),
    }));
  }
  return positions.sort((left, right) => left.positionId.localeCompare(right.positionId));
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
  let heldPositionValue = 0n;
  let unattributed = false;
  let unvaluedExposure = false;
  const cycles = [];
  const heldPositions = [];

  for (const cycleId of [...cycleIds].sort()) {
    const description = await cycleRepository.describeCycle(cycleId);
    if (!description || typeof description !== 'object' || !(description.custodyLedgers instanceof Map)) {
      throw new Error('projectPolicyCustody cycle description is invalid');
    }
    let cycleRealizedLoss = 0n;
    let cycleAtRisk = 0n;
    let cycleOutstanding = 0n;
    const cycleHeldPositions = openHeldPositions(description, cycleId);
    for (const position of cycleHeldPositions) {
      heldPositionValue += BigInt(position.valueMicroUsdg);
      heldPositions.push(position);
    }
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
    heldPositions: Object.freeze({
      count: heldPositions.length,
      valueMicroUsdg: heldPositionValue.toString(),
      positions: Object.freeze(heldPositions.sort((left, right) => (
        left.cycleId.localeCompare(right.cycleId) || left.positionId.localeCompare(right.positionId)
      ))),
    }),
    unattributed,
    unvaluedExposure,
    cycles: Object.freeze(cycles),
  });
}
