import { isProcessQuoteUsdValuation } from '../relay-client.mjs';
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
// Payout evidence requires trusted context (see `projectCycleAccounting`'s own `trustedPayoutContext`
// doc): this module has no immutable anchor for "which token is actually the configured USDG" or
// "which address is actually Operations." It calls `stages/payout.mjs`'s own exported, read-only
// `assertFinalizedPayoutTransferEvidence` for finality-proof verification (never a reimplemented,
// divergent duplicate), but that call still needs the trusted asset/Operations identity from the
// caller's own config/cycle binding — without it, every payout amount stays `null`.
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
// actual Collector Crypt purchase/buyback debit is a different asset (Solana Circle USD,
// `collectorPurchaseDebit`/`collectorBuybackProceeds`). Neither may be relabeled as the other's
// asset or subtracted against it — see `outboundBridgeFee`'s and `projectCycleAccounting`'s own
// comments for the two concrete anti-patterns this module previously had and no longer has.
const USDG_PAYOUT_CHAIN_ID = 4663;
const USDG_PAYOUT_DECIMALS = 6; // Historical v1 proof identity, never native execution.
import * as payoutReaders from './stages/payout.mjs';
const { DirectPayoutError } = payoutReaders;

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

/** The outbound bridge's quoted origin (USDG) and destination (Solana Circle USD) amounts are two
 * different assets on two different chains. Equal decimals and an approximate peg are not a
 * same-asset fee: `origin - destination` would silently mix a USDG figure with a settlement-asset figure and
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
 * `sourceAmountAtomic`/`destinationAmountAtomic` here are real USDG amounts, not a Solana settlement-asset
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

/**
 * Sums one purchase/buyback stage's per-pack evidence into a single typed `Amount`, per Task C's
 * multi-pack `{packs: [...]}` lifecycle (C-interface.json revision 2). `select(pack)` must return:
 *   - a typed-amount-shaped value: verified same-asset (via `sameAsset`, never merely same
 *     decimals) and added to the running total with `BigInt` — never `Number` arithmetic.
 *   - `null`: this pack genuinely contributes zero (a real, verified fact — e.g. a pack that was
 *     never purchased, or a held pack carved out before ever being sold) — never conflated with an
 *     unknown amount.
 *   - `undefined`: this pack's amount is required but missing, invalid, or the pack is in an
 *     unexpected (non-terminal) state — the whole aggregate becomes `null`, never a fabricated
 *     partial sum that silently drops the ambiguous pack.
 * Also fails closed to `null` on an empty/malformed `packs` array, a pack entry missing its own
 * canonical `packIndex`/`memo` identity (every per-pack evidence shape C documents always carries a
 * `memo` — an entry without one is not a real record, never silently summed anyway), a duplicate or
 * contradictory `packIndex`/`memo`/non-null `mint` across entries (never double-counted), or a
 * mixed-asset sum (two packs' amounts on different chains/assets/decimals) — the same asset-identity
 * discipline `sameAsset` enforces everywhere else in this module. A batch where every pack verifiably
 * contributes zero (e.g. every pack `not_purchased`) still returns `null`: the total is honestly
 * zero, but with no real evidence pack establishing an asset identity to tag it with, this module
 * has no trusted context to guess one (unlike payout's `trustedPayoutContext` anchor).
 */
function sumPackAmounts(packs, select) {
  if (!Array.isArray(packs) || packs.length === 0) return null;
  const seenIndexes = new Set();
  const seenMemos = new Set();
  const seenMints = new Set();
  let asset = null;
  let total = 0n;
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return null;
    if (!Number.isInteger(pack.packIndex) || pack.packIndex < 0 || seenIndexes.has(pack.packIndex)) return null;
    seenIndexes.add(pack.packIndex);
    if (typeof pack.memo !== 'string' || pack.memo.length === 0 || seenMemos.has(pack.memo)) return null;
    seenMemos.add(pack.memo);
    if (typeof pack.mint === 'string') {
      if (seenMints.has(pack.mint)) return null;
      seenMints.add(pack.mint);
    }
    const selected = select(pack);
    if (selected === undefined) return null;
    if (selected === null) continue;
    const amount = publicAmount(selected);
    if (amount === null) return null;
    if (asset === null) asset = amount;
    else if (!sameAsset(amount, asset)) return null;
    total += BigInt(amount.units);
  }
  return asset === null ? null : Object.freeze({ ...asset, units: total.toString() });
}

/** `packs[i].status === 'purchased'` requires its own `packCost`; `'not_purchased'` verifiably cost
 * nothing; any other status is unexpected for durably-COMPLETE evidence and fails the aggregate
 * closed rather than silently skip it. */
function purchasePackAmount(pack) {
  if (pack.status === 'purchased') return pack.packCost ?? undefined;
  if (pack.status === 'not_purchased') {
    // A declined purchase has no transaction or debit.  Accepting either field would hide a
    // contradictory durable record behind a zero contribution.
    if (Object.hasOwn(pack, 'packCost') || Object.hasOwn(pack, 'signature')) return undefined;
    return null;
  }
  return undefined;
}

/** `packs[i].decision === 'sold'` requires both its own `proceeds` and its own `mint` (C's schema
 * makes `mint` a mandatory, never-optional field on a sold-pack — a sold pack with no recorded mint
 * is not a real, canonical identity, and its proceeds are never trusted). `'held'` was carved out
 * before ever selling (real zero proceeds, tracked instead as a held-position custody fact
 * elsewhere; `mint` may be legitimately absent there, per the shared held-pack shape); any other
 * decision (e.g. a pre-reconcile `'submitted'`/`'unknown'`) is unexpected for durably-COMPLETE
 * evidence and fails the aggregate closed. */
function buybackPackAmount(pack) {
  if (pack.decision === 'sold') {
    if (typeof pack.mint !== 'string' || pack.mint.length === 0) return undefined;
    return pack.proceeds ?? undefined;
  }
  if (pack.decision === 'held') {
    // A held card was never sold, so it cannot carry sale proceeds or a sale signature.
    if (Object.hasOwn(pack, 'proceeds') || Object.hasOwn(pack, 'signature')) return undefined;
    return null;
  }
  return undefined;
}

/** Cross-checks C's own `quantity`/`purchasedCount` batch-level counters against the actual `packs`
 * array before ever trusting a sum over it — a `packs` array missing one or more entries relative to
 * `quantity` (or whose actual `purchased` count disagrees with `purchasedCount`) is an incomplete or
 * internally-contradictory record, and every pack in it becomes unavailable rather than partially
 * summing whichever subset happened to be present. */
function purchaseCoverageValid(evidence) {
  if (!Number.isInteger(evidence.quantity) || evidence.quantity !== evidence.packs.length) return false;
  if (!Number.isInteger(evidence.purchasedCount)) return false;
  if (!evidence.packs.every((pack, index) => pack && typeof pack === 'object' && pack.packIndex === index)) return false;
  const actualPurchased = evidence.packs.filter(pack => pack && typeof pack === 'object' && pack.status === 'purchased').length;
  return actualPurchased === evidence.purchasedCount;
}

/** Same discipline as `purchaseCoverageValid`, plus the predecessor binding: buyback's own `packs`
 * must cover exactly the packs that actually survived purchase (`purchase.evidence.purchasedCount`)
 * — a buyback batch that is shorter/longer than what purchase actually produced is evidence of a
 * broken or spoofed cross-stage ledger, never trusted for a partial sum. Requires purchase's own
 * evidence to already be durably COMPLETE and coverage-valid; buyback proceeds are never computed
 * from evidence whose predecessor cannot itself be verified. */
function buybackCoverageValid(evidence, purchase) {
  if (!Number.isInteger(evidence.soldCount)) return false;
  const actualSold = evidence.packs.filter(pack => pack && typeof pack === 'object' && pack.decision === 'sold').length;
  if (actualSold !== evidence.soldCount) return false;
  if (!isCompleteStage(purchase) || !purchase.evidence || typeof purchase.evidence !== 'object'
    || !Array.isArray(purchase.evidence.packs) || !purchaseCoverageValid(purchase.evidence)) {
    return false;
  }
  if (evidence.packs.length !== purchase.evidence.purchasedCount) return false;

  const purchasedByIndex = new Map();
  for (const pack of purchase.evidence.packs) {
    if (pack.status === 'purchased') purchasedByIndex.set(pack.packIndex, pack.memo);
  }
  if (purchasedByIndex.size !== purchase.evidence.purchasedCount) return false;

  const seenIndexes = new Set();
  for (const pack of evidence.packs) {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return false;
    if (seenIndexes.has(pack.packIndex) || purchasedByIndex.get(pack.packIndex) !== pack.memo) return false;
    seenIndexes.add(pack.packIndex);
  }
  return seenIndexes.size === purchasedByIndex.size;
}

/** `true` when `evidence` carries one of Task C's new multi-pack batch-level counter fields
 * (`quantity`/`purchasedCount` for purchase, `soldCount` for buyback) — the marker that this is a
 * genuinely new-shape record, even if its `packs` array is missing or malformed. Distinguishes that
 * case from a genuine pre-migration legacy single-card record (which never carries these fields at
 * all): a new-shape record missing `packs` is a broken/incomplete record and must fail closed, never
 * silently fall back to reading a top-level `packCost`/`proceeds` field as if it were legacy. */
function hasNewShapeMarker(evidence, markerFields) {
  return markerFields.some(field => Object.hasOwn(evidence, field));
}

/** Resolves one purchase stage's `collectorPurchaseDebit`. */
function purchaseDebit(purchase) {
  if (!isCompleteStage(purchase)) return null;
  const evidence = purchase.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  if (Array.isArray(evidence.packs)) {
    return purchaseCoverageValid(evidence) ? sumPackAmounts(evidence.packs, purchasePackAmount) : null;
  }
  if (hasNewShapeMarker(evidence, ['quantity', 'purchasedCount'])) return null;
  return publicAmount(evidence.packCost);
}

/** Resolves one buyback stage's `collectorBuybackProceeds`. */
function buybackProceeds(buyback, purchase) {
  if (!isCompleteStage(buyback)) return null;
  const evidence = buyback.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  if (Array.isArray(evidence.packs)) {
    return buybackCoverageValid(evidence, purchase) ? sumPackAmounts(evidence.packs, buybackPackAmount) : null;
  }
  if (hasNewShapeMarker(evidence, ['soldCount'])) return null;
  return publicAmount(evidence.proceeds);
}

const PAYOUT_EVIDENCE_SCHEMA = 'hookemon.direct-payout-result.v1';
// Reused from the authoritative producer (packages/runner/src/distribution/payout-plan.mjs) rather
// than re-declared, so this projection's notion of "real USDG" can never silently drift from the
// one payout.mjs itself enforces via assertUsdAmount.
const EXPECTED_USDG_CHAIN_ID = String(USDG_PAYOUT_CHAIN_ID);
const NON_PAID_RECIPIENT_STATES = new Set(['REFUSED', 'NONCE_INTERFERENCE']);

/**
 * A recipient is only ever counted as paid when `stages/payout.mjs`'s own exported, read-only
 * `assertFinalizedPayoutTransferEvidence` accepts its `transactionHash`/`finalizedTransfer` — the
 * exact same ~16-field schema/endpoint/amount/block/balance-delta/log-index checks that gate a live
 * FINALIZED transition, never a re-implemented or weakened duplicate. `operations`/`amount` are
 * built from `trustedPayoutContext` (the caller's own immutable cycle/config binding), never from
 * the evidence under verification — this is what rejects a fully-formed but foreign chain-4663/
 * six-decimal token even when its shape and amount otherwise match. Any thrown error (malformed
 * hash, incomplete proof, wrong endpoints, wrong amount/asset, ...) means "not verified," never
 * "assume paid."
 */
function finalizedRecipientAmount(recipient, expectedAsset, operationsAddress) {
  if (recipient?.state !== 'FINALIZED') return null;
  const recipientAmount = publicAmount(recipient.amount);
  if (recipientAmount === null || !sameAsset(recipientAmount, expectedAsset)) return null;
  try {
    const readProof = expectedAsset.decimals === 18
      ? payoutReaders.assertFinalizedPayoutTransferEvidence
      : payoutReaders.assertHistoricalFinalizedPayoutTransferEvidence ?? payoutReaders.assertFinalizedPayoutTransferEvidence;
    readProof({
      transactionHash: recipient.transactionHash,
      finalizedTransfer: recipient.finalizedTransfer,
      operations: operationsAddress,
      recipient: recipient.recipient,
      amount: {
        chainId: expectedAsset.chainId,
        assetId: expectedAsset.assetId,
        decimals: expectedAsset.decimals,
        amountAtomic: recipientAmount.units,
      },
    });
  } catch (error) {
    if (error instanceof DirectPayoutError) return null;
    throw error;
  }
  return recipientAmount;
}

/**
 * Projects the payout stage's own finalized-transfer evidence (see `stages/payout.mjs`'s
 * `payoutTerminalEvidence` — durable `distributablePool`/`totalAllocated`/`dust`, each recipient's
 * final `state`/`amount`/`transactionHash`/`finalizedTransfer`, and `quarantine` liabilities) into
 * real paid/planned/liability/dust amounts and a recipient count. The payout stage reaching
 * `COMPLETE` only proves recipient conservation was reached, not that every recipient was actually
 * paid — some may be `REFUSED` or `NONCE_INTERFERENCE` (durably recorded as `quarantine` liabilities
 * instead of a transfer).
 *
 * This function cannot, on its own, honestly tell real finalized USDG payment evidence apart from a
 * fabricated or foreign-token bundle: the evidence itself carries no immutable anchor for "which
 * token is actually USDG" or "which address is actually the Operations sender." Both must come from
 * `trustedPayoutContext`, supplied by the caller from its own immutable cycle/config binding (e.g.
 * `config.contracts.usdg`/`config.accounts.evm` at composition time) — never derived from the
 * evidence. Without a complete `trustedPayoutContext` (`expectedUsdgAssetId` and
 * `operationsAddress`), every payout amount stays `null` and `holderRewardsStatus` stays
 * `awaiting-verification`, exactly as if the evidence were entirely missing. Every arithmetic
 * conservation/pairing invariant `stages/payout.mjs` itself enforces (`isDirectPayoutComplete`'s
 * `paid + quarantined + dust == distributablePool`, `assertPlan`'s `totalAllocated + dust ==
 * distributablePool`, and quarantine pairing exactly one-to-one with non-paid recipients) is
 * re-verified here before trusting any of it — a malformed, asset-inconsistent, non-conserving, or
 * mispaired bundle fails closed to all `null` rather than infer anything from the stage's `COMPLETE`
 * label alone.
 */
function projectPayoutEvidence(payoutStage, cycleId, trustedPayoutContext) {
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

  const expectedUsdgAssetId = trustedPayoutContext?.expectedUsdgAssetId;
  const operationsAddress = trustedPayoutContext?.operationsAddress;
  if (typeof expectedUsdgAssetId !== 'string' || expectedUsdgAssetId.length === 0
    || typeof operationsAddress !== 'string' || operationsAddress.length === 0) {
    return allNull;
  }
  const expectedAsset = Object.freeze({
    chainId: EXPECTED_USDG_CHAIN_ID,
    assetId: expectedUsdgAssetId,
    decimals: USDG_PAYOUT_DECIMALS,
  });

  const distributablePool = publicAmount(evidence.distributablePool);
  const totalAllocated = publicAmount(evidence.totalAllocated);
  const dust = publicAmount(evidence.dust);
  if (distributablePool === null || totalAllocated === null || dust === null) return allNull;
  if (!sameAsset(distributablePool, expectedAsset) || !sameAsset(totalAllocated, expectedAsset) || !sameAsset(dust, expectedAsset)) {
    return allNull;
  }
  // Plan-level conservation (assertPlan's own invariant): totalAllocated + dust == distributablePool.
  if (BigInt(totalAllocated.units) + BigInt(dust.units) !== BigInt(distributablePool.units)) return allNull;

  let paidAtomic = 0n;
  let recipientCount = 0;
  const nonPaidRecipients = [];
  for (const recipient of evidence.recipients) {
    if (!recipient || typeof recipient !== 'object') return allNull;
    const finalized = finalizedRecipientAmount(recipient, expectedAsset, operationsAddress);
    if (finalized !== null) {
      paidAtomic += BigInt(finalized.units);
      recipientCount += 1;
      continue;
    }
    if (!NON_PAID_RECIPIENT_STATES.has(recipient.state)) return allNull;
    const amount = publicAmount(recipient.amount);
    if (amount === null || !sameAsset(amount, expectedAsset)) return allNull;
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

function projectNativePayoutEvidence(payoutStage, cycleId, trustedPayoutContext) {
  const allNull = Object.freeze({
    plannedHolderRewardsWei: null,
    paidHolderRewardsWei: null,
    payoutLiabilityWei: null,
    payoutDustWei: null,
    paidHolderRewardsRecipientCount: null,
    holderRewardsPaidOut: false,
  });
  if (!isCompleteStage(payoutStage)) return allNull;
  const evidence = payoutStage.evidence;
  if (
    !evidence || evidence.schema !== 'hookemon.direct-payout-result.v2' || evidence.cycleId !== cycleId
    || !Array.isArray(evidence.recipients) || !Array.isArray(evidence.quarantine)
  ) {
    return allNull;
  }

  const configured = trustedPayoutContext?.nativeAsset;
  if (String(configured?.chainId) !== '4663' || configured?.assetId !== 'native' || configured?.decimals !== 18) return allNull;
  const expectedUsdgAssetId = 'native';
  const operationsAddress = trustedPayoutContext?.operationsAddress;
  if (typeof expectedUsdgAssetId !== 'string' || expectedUsdgAssetId.length === 0
    || typeof operationsAddress !== 'string' || operationsAddress.length === 0) {
    return allNull;
  }
  const expectedAsset = Object.freeze({
    chainId: EXPECTED_USDG_CHAIN_ID,
    assetId: expectedUsdgAssetId,
    decimals: 18,
  });

  const distributablePool = publicAmount(evidence.distributablePool);
  const totalAllocated = publicAmount(evidence.totalAllocated);
  const dust = publicAmount(evidence.dust);
  if (distributablePool === null || totalAllocated === null || dust === null) return allNull;
  if (!sameAsset(distributablePool, expectedAsset) || !sameAsset(totalAllocated, expectedAsset) || !sameAsset(dust, expectedAsset)) {
    return allNull;
  }
  // Plan-level conservation (assertPlan's own invariant): totalAllocated + dust == distributablePool.
  if (BigInt(totalAllocated.units) + BigInt(dust.units) !== BigInt(distributablePool.units)) return allNull;

  let paidAtomic = 0n;
  let recipientCount = 0;
  const nonPaidRecipients = [];
  const seenRecipients = new Set();
  const seenTransactions = new Set();
  for (const recipient of evidence.recipients) {
    const recipientKey = typeof recipient?.recipient === 'string' ? recipient.recipient.toLowerCase() : null;
    if (recipientKey === null || seenRecipients.has(recipientKey)) return allNull;
    seenRecipients.add(recipientKey);
    if (recipient.state === 'FINALIZED') {
      const transactionKey = typeof recipient.transactionHash === 'string' ? recipient.transactionHash.toLowerCase() : null;
      if (transactionKey === null || seenTransactions.has(transactionKey)) return allNull;
      seenTransactions.add(transactionKey);
    }
    if (!recipient || typeof recipient !== 'object') return allNull;
    const finalized = finalizedRecipientAmount(recipient, expectedAsset, operationsAddress);
    if (finalized !== null) {
      paidAtomic += BigInt(finalized.units);
      recipientCount += 1;
      continue;
    }
    if (!NON_PAID_RECIPIENT_STATES.has(recipient.state)) return allNull;
    const amount = publicAmount(recipient.amount);
    if (amount === null || !sameAsset(amount, expectedAsset)) return allNull;
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
    plannedHolderRewardsWei: totalAllocated.units,
    paidHolderRewardsWei: paidAtomic.toString(),
    payoutLiabilityWei: liabilityAtomic.toString(),
    payoutDustWei: dust.units,
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
 * @param {{expectedUsdgAssetId: string, operationsAddress: string}|null} [input.trustedPayoutContext] -
 *   required for `plannedHolderRewardsMicroUsdg`/`paidHolderRewardsMicroUsdg`/
 *   `payoutLiabilityMicroUsdg`/`payoutDustMicroUsdg`/`paidHolderRewardsRecipientCount` to ever be
 *   anything but `null` (and `holderRewardsStatus` anything but `awaiting-verification` once the
 *   payout stage completes). Both fields must come from the caller's own immutable cycle/config
 *   binding — `expectedUsdgAssetId` from `config.contracts.usdg`, `operationsAddress` from
 *   `config.accounts.evm` — never derived from the evidence itself, so a fully-formed but foreign
 *   chain-4663/six-decimal token can never pass as USDG. Used to call
 *   `stages/payout.mjs`'s own exported, read-only `assertFinalizedPayoutTransferEvidence` (the exact
 *   canonical finality-proof validator that gates a live FINALIZED transition) — this projection
 *   never reimplements that check itself. Omitted entirely, payout amounts stay `null` exactly as if
 *   the payout stage had no evidence at all.
 * @returns {Promise<object>} the exact schemaVersion-6 `RoundAccounting` shape
 *   `packages/dashboard/src/contracts/public-cycle-status.mjs`'s `readRoundAccounting` requires.
 *   `packSpendMicroUsdg`/`buybackMicroUsdg`/`packGainMicroUsdg`/`packLossMicroUsdg` describe pack
 *   economics in USDG and have no honest producer today: the only settled USDG-denominated amounts
 *   available are bridge movements (`outboundBridgeDebit`/`inboundBridgeProceeds`, typed and kept
 *   separately), not the actual Collector Crypt purchase/buyback debit (which is denominated in
 *   Solana Circle USD — `collectorPurchaseDebit`/`collectorBuybackProceeds`). Reporting a bridge amount or
 *   a cross-asset figure under a `MicroUsdg`-labeled pack-economics field would misrepresent it, so
 *   these four stay `null` until a same-asset USDG pack-economics producer exists.
 */
export async function projectCycleAccounting({ cycleRepository, cycleId, trustedPayoutContext = null }) {
  if (!cycleRepository || typeof cycleRepository.readStage !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('projectCycleAccounting requires a cycleRepository exposing readStage/describeCycle');
  }
  if (typeof cycleId !== 'string' || cycleId.length === 0) throw new Error('projectCycleAccounting requires a cycleId');

  const [description, ...stages] = await Promise.all([
    cycleRepository.describeCycle(cycleId),
    ...ACCOUNTING_STAGES.map(stage => cycleRepository.readStage(cycleId, stage)),
  ]);
  const [funding, outbound, purchase, buyback, returnStage, distribution, payout] = stages;
  if (['hookemon.policy-admission.v3', 'hookemon.policy-admission.v4'].includes(description?.admission?.schema)) {
    return projectNativeCycleAccounting(description, stages, cycleId, trustedPayoutContext);
  }
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
  // EVM bridge amounts above at any parity. Task C's current producer emits a per-pack
  // `{packs: [...]}` array (C-interface.json revision 2); an older completed cycle may still carry
  // the legacy single-card `packCost`/`proceeds` shape (no `packs` array, and no `quantity`/
  // `purchasedCount`/`soldCount` marker either — see `hasNewShapeMarker`) — recognized explicitly
  // and read as before, never guessed at or forced through the new per-pack summation.
  const collectorPurchaseDebit = purchaseDebit(purchase);
  const collectorBuybackProceeds = buybackProceeds(buyback, purchase);

  // The one honest USDG-denominated pack-spend figure is the principal this cycle actually released,
  // which is already USDG and needs no conversion. For an admitted cycle createCycle has bound that
  // release amount to the origin amount of its own N-quantity exact-output quote, so this is the
  // quoted principal rather than a configured guess. The Solana settlement debits above stay in
  // their own asset and are never restated here at any parity, and buyback gain/loss stay null
  // because computing them would have to mix the two assets. Reported only once purchase has durably
  // completed, so an authorization that was never spent is not shown as spend.
  // A zero release is not evidence of zero spend, it is absence of evidence, so it stays null; an
  // admitted cycle's aggregate funding quote is positive by construction anyway.
  const packSpendMicroUsdg = purchase?.status === 'COMPLETE'
    && typeof description?.releaseAmount === 'string'
    && /^[1-9][0-9]*$/.test(description.releaseAmount)
    ? description.releaseAmount
    : null;
  const buybackMicroUsdg = null;
  const packGainMicroUsdg = null;
  const packLossMicroUsdg = null;

  const payoutEvidence = projectPayoutEvidence(payout, cycleId, trustedPayoutContext);

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

// Native records never enter the historical six-decimal projection above.
function projectNativeCycleAccounting(description, stages, cycleId, trustedPayoutContext) {
  const [, , purchase, buyback, returnStage, distribution, payout] = stages;
  const native = value => {
    const amount = publicAmount(value);
    return amount?.chainId === '4663' && amount.assetId === 'native' && amount.decimals === 18 ? amount : null;
  };
  const outbound = settledRelayLeg(description.relayLegs, 'outbound');
  const inbound = settledRelayLeg(description.relayLegs, 'return');
  const payoutEvidence = projectNativePayoutEvidence(payout, cycleId, trustedPayoutContext);
  const releaseAmount = native({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: description.releaseAmount });
  return Object.freeze({
    schema: 'hookemon.native-round-accounting.v1',
    releaseAmount,
    outboundBridgeDebit: outbound?.schema === 'hookemon.relay-leg.v2' ? native({ chainId: outbound.sourceChainId, assetId: outbound.sourceAssetId, decimals: outbound.sourceDecimals, amountAtomic: outbound.sourceAmountAtomic }) : null,
    inboundBridgeProceeds: inbound?.schema === 'hookemon.relay-leg.v2' ? native({ chainId: inbound.destinationChainId, assetId: inbound.destinationAssetId, decimals: inbound.destinationDecimals, amountAtomic: inbound.destinationAmountAtomic }) : null,
    collectorPurchaseDebit: purchaseDebit(purchase),
    collectorBuybackProceeds: buybackProceeds(buyback, purchase),
    // Funding quotes describe funding, not actual per-card purchase costs or proceeds.
    packSpendMicroUsd: null, buybackMicroUsd: null, packGainMicroUsd: null, packLossMicroUsd: null,
    quotedCosts: Object.freeze({ outboundBridgeMicroUsd: null, inboundBridgeMicroUsd: null, collectorApiMicroUsd: null, evmNetworkMicroUsd: null, solanaNetworkMicroUsd: null, slippageMicroUsd: null }),
    protectedCostsMicroUsd: null, confirmedCostsMicroUsd: null, cycleGainMicroUsd: null, cycleLossMicroUsd: null,
    walletBalanceBeforeWei: null, walletBalanceAfterWei: null,
    networkFees: Object.freeze({ walletLamportsCharged: null, purchase: null, buyback: null }),
    feeReserveBeforeWei: null, feeReserveTargetWei: null, feeReserveTopUpWei: null, feeReserveAfterWei: null,
    plannedHolderRewardsWei: payoutEvidence.plannedHolderRewardsWei,
    paidHolderRewardsWei: payoutEvidence.paidHolderRewardsWei,
    payoutLiabilityWei: payoutEvidence.payoutLiabilityWei,
    payoutDustWei: payoutEvidence.payoutDustWei,
    paidHolderRewardsRecipientCount: payoutEvidence.paidHolderRewardsRecipientCount,
    holderRewardsStatus: isCompleteStage(payout) ? payoutEvidence.paidHolderRewardsWei === null ? 'awaiting-verification' : payoutEvidence.holderRewardsPaidOut ? 'paid' : 'paid-with-liabilities' : 'not-started',
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
    throw new Error('projectPolicyCustody requires a native asset identity');
  }
  if (value.chainId !== '4663' || value.assetId !== 'native' || value.decimals !== 18) {
    throw new Error('projectPolicyCustody nativeAsset asset identity is invalid');
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
    realizedLossMicroUsd: value.realizedLossMicroUsd.toString(),
    atRiskMicroUsd: value.atRiskMicroUsd.toString(),
    outstandingMicroUsd: value.outstandingMicroUsd.toString(),
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
    parsePolicyAtomic(position.costMicroUsd, 'held position costMicroUsd');
    const valueMicroUsd = parsePolicyAtomic(position.costMicroUsd, 'held position purchase cost');
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
      costMicroUsd: position.costMicroUsd,
      valueMicroUsd: valueMicroUsd.toString(),
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

/** Each cycle's native exposure requires current authenticated USD pricing. Held cards retain
 * original purchase cost; unsupported custody remains unvalued and stops new risk. */
export async function projectPolicyCustody({ cycleRepository, nativeAsset, valueAmountUsd, now = Date.now }) {
  if (!cycleRepository || typeof cycleRepository.listKnownCycleIds !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('projectPolicyCustody requires a cycleRepository exposing listKnownCycleIds/describeCycle');
  }
  const asset = assertPolicyAssetIdentity(nativeAsset);
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
  const cycleExposureMicroUsd = {};
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
      heldPositionValue += BigInt(position.valueMicroUsd);
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
      if (ledger.schema === 'hookemon.custody-ledger.v3' && ledger.verifiedCurrentBalance === null
        && (unresolvedClaim > 0n || ledgerHasCurrentCustody(ledger))) {
        unvaluedExposure = true;
      }
      let principalOutstanding = unresolvedClaim;
      for (const bucket of POLICY_CUSTODY_BUCKETS) principalOutstanding += parsePolicyAtomic(ledger[bucket], `custody ledger ${bucket}`);
      async function valueWei(amountAtomic) {
        if (amountAtomic === 0n) return 0n;
        if (typeof valueAmountUsd !== 'function') { unvaluedExposure = true; return null; }
        const amount = { ...asset, amountAtomic: amountAtomic.toString() };
        try {
          const valuation = await valueAmountUsd(amount, { rounding: 'up' });
          if (!isProcessQuoteUsdValuation(valuation, { amount, rounding: 'up', sourcePath: 'details.currencyIn.amountUsd' })
            || now() < valuation.observedAtMs || now() >= valuation.validUntilMs) { unvaluedExposure = true; return null; }
          return parsePolicyAtomic(valuation.amountMicroUsd, 'authenticated USD valuation');
        } catch { unvaluedExposure = true; return null; }
      }
      if (description.terminalState === 'COMPLETED') {
        const cost = description.admission?.aggregateFundingUsd;
        let proceedsWei = 0n, proceedsUsd = 0n, valued = ['hookemon.policy-admission.v3', 'hookemon.policy-admission.v4'].includes(description.admission?.schema)
          && cost?.amount?.amountAtomic === description.releaseAmount && cost?.rounding === 'up';
        for (const leg of description.relayLegs?.values?.() ?? []) {
          if (leg.direction !== 'return' || leg.state !== 'SETTLED') continue;
          const usd = leg.returnAttribution?.destinationUsd;
          const settledAtMs = Number(leg.finalizedAtDestination?.timestampUnixSeconds) * 1000;
          if (leg.returnAttribution?.schema !== 'hookemon.return-leg-attribution-context.v2' || !usd
            || usd.rounding !== 'down' || usd.sourcePath !== 'details.currencyOut.amountUsd'
            || usd.amount?.chainId !== asset.chainId || usd.amount?.assetId !== asset.assetId || usd.amount?.decimals !== asset.decimals
            || usd.amount?.amountAtomic !== leg.netDeltaAtomic || usd.quoteRequestId !== leg.relayRequestId
            || !Number.isSafeInteger(settledAtMs) || settledAtMs < usd.observedAtMs || settledAtMs >= usd.validUntilMs) { valued = false; continue; }
          proceedsWei += BigInt(leg.netDeltaAtomic);
          proceedsUsd += parsePolicyAtomic(usd.amountMicroUsd, 'frozen realized USD proceeds');
        }
        for (const realized of description.supplementaryRealizedProceedsUsd?.values?.() ?? []) {
          const usd = realized.destinationUsd;
          proceedsWei += parsePolicyAtomic(usd.amount.amountAtomic, 'frozen supplementary native proceeds');
          proceedsUsd += parsePolicyAtomic(usd.amountMicroUsd, 'frozen supplementary USD proceeds');
        }
        if (proceedsWei !== returned) valued = false;
        if (valued) {
          const committedCost = claimed === 0n ? 0n : parsePolicyAtomic(cost.amountMicroUsd, 'frozen committed USD cost');
          cycleRealizedLoss += committedCost > proceedsUsd ? committedCost - proceedsUsd : 0n;
        } else unvaluedExposure = true;
        // Completed expenses never change with current FX. Only remaining liquid custody uses a current quote.
        const liquid = principalOutstanding - unresolvedClaim;
        const liquidUsd = await valueWei(liquid);
        if (liquidUsd !== null) cycleOutstanding += liquidUsd;
      } else {
        const unresolvedUsd = await valueWei(unresolvedClaim);
        const outstandingUsd = principalOutstanding === unresolvedClaim ? unresolvedUsd : await valueWei(principalOutstanding);
        if (unresolvedUsd !== null) cycleAtRisk += unresolvedUsd;
        if (outstandingUsd !== null) cycleOutstanding += outstandingUsd;
      }
    }
    cycleExposureMicroUsd[cycleId] = cycleAtRisk.toString();
    realizedLoss += cycleRealizedLoss;
    atRisk += cycleAtRisk;
    outstanding += cycleOutstanding;
    cycles.push(freezePolicyCycle({
      cycleId,
      realizedLossMicroUsd: cycleRealizedLoss,
      atRiskMicroUsd: cycleAtRisk,
      outstandingMicroUsd: cycleOutstanding,
    }));
  }

  return Object.freeze({
    realizedLossMicroUsd: realizedLoss.toString(),
    atRiskMicroUsd: atRisk.toString(),
    outstandingMicroUsd: outstanding.toString(),
    heldAssets,
    heldPositions: Object.freeze({
      count: heldPositions.length,
      valueMicroUsd: heldPositionValue.toString(),
      positions: Object.freeze(heldPositions.sort((left, right) => (
        left.cycleId.localeCompare(right.cycleId) || left.positionId.localeCompare(right.positionId)
      ))),
    }),
    unattributed,
    unvaluedExposure,
    cycles: Object.freeze(cycles),
    cycleExposureMicroUsd: Object.freeze(cycleExposureMicroUsd),
  });
}
