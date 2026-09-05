#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const USDG_ATOMIC_PER_UNIT = 1_000_000n;
const BPS_DENOMINATOR = 10_000n;
const TOTAL_FEE_BPS = 300n;
const PROGRAMMABLE_BPS = 10n;
const TREASURY_BPS = 40n;
const STATIC_LP_FEE = 0;
const LAUNCH_ALLOCATION_BPS = 9_000;
const REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
const TREE_DEPTH = 10;
const TREE_POSITIONS = 1 << TREE_DEPTH;
const ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC = 100n * USDG_ATOMIC_PER_UNIT;
const COMPROMISED_OPERATIONS_ACCRUAL_QUOTE_ATOMIC = 40_000n * USDG_ATOMIC_PER_UNIT;
const ZERO_RECIPIENT = "0x0000000000000000000000000000000000000000";
const MODELED_OPERATIONS_IDENTITY = "0x0000000000000000000000000000000000000a11";
const CORRECTED_BOUNDS_APPROVAL_STATE = "OWNER_REAPPROVAL_REQUIRED_AFTER_EXPOSURE_CORRECTION";
const CORRECTED_BOUNDS_SCOPE =
  "One separately authorized cooperative thin-V1 runner cycle and its payout, plus an adversarial compromised-Operations trigger case proving zero Operations custody; later unchanged V1 cycles and total future process accrual are not capped by this model instance";
const COOPERATIVE_RUNNER_CAP_STATUS = "OWNER_REAPPROVAL_REQUIRED_FOR_CORRECTED_SCOPE";
const COOPERATIVE_RUNNER_CAP_SCOPE =
  "One separately authorized cooperative runner action bundle only; not an onchain process-release cap or system-wide loss bound";
const COOPERATIVE_RUNNER_CAP_DISPLAY = "100 USDG";
const COOPERATIVE_RUNNER_CAP_ABSORBER =
  "The cooperative runner rejects its own action above the separately authorized cap. Operations can trigger only an exact authorization whose immutable destination is PegCycleVault and never receives the principal.";
const OPERATIONS_COMPROMISE_THREAT = "CURRENT_OPERATIONS_CREDENTIAL_COMPROMISE";
const OPERATIONS_COMPROMISE_STATUS = "ZERO_CUSTODY_BY_CONSTRUCTION";
const OPERATIONS_COMPROMISE_RELEASE_RULE = "EXACT_AUTHORIZATION_TO_IMMUTABLE_PEG_CYCLE_VAULT";
const OPERATIONS_COMPROMISE_DISPLAY =
  "0 USDG process-principal exposure and 0 USDG returned-proceeds exposure in the adversarial vector";
const OPERATIONS_COMPROMISE_ABSORBER =
  "The hook transfers only an immutable authorizer-approved amount to its mutually bound PegCycleVault, and returned proceeds enter that vault before payout commitment. Operations is only the recorded trigger and never a USDG source or destination.";
const UNRESOLVED_EXTERNAL_COMPROMISE_CLASSES = Object.freeze([
  "provider", "authorizer", "routeExecutor", "bridge", "policyWallet"
]);
const SURVIVABILITY_BOUNDS_ROOT_KEYS = Object.freeze([
  "schemaVersion",
  "productPhase",
  "requirementsRevision",
  "architectureRevision",
  "approvalState",
  "scope",
  "measurementBasis",
  "immutableMarketBounds",
  "candidateBounds",
  "currentOperationsCompromiseExposure",
  "unresolvedExternalCompromiseExposure",
  "releaseBoundNumericCaps",
  "modelComparison",
  "ownerApprovalRequest",
  "scopeClarifications",
  "modelEvidence"
]);
const MEASUREMENT_BASIS_KEYS = Object.freeze([
  "stableAssets", "stableAssetDecimals", "nativeGas", "excluded"
]);
const IMMUTABLE_MARKET_BOUNDS_KEYS = Object.freeze([
  "staticLpFeeBasisPoints",
  "additionalTradingFeeBasisPoints",
  "inclusiveHookFeeBasisPoints",
  "launchAllocationBasisPoints",
  "maximumProjectControllableLaunchPositions",
  "absorber"
]);
const DEFAULT_CANDIDATE_BOUND_KEYS = Object.freeze(["value", "absorber"]);
const RUNWAY_BOUND_KEYS = Object.freeze(["value", "display", "evidenceKind", "absorber"]);
const UNPAID_ENTITLEMENT_BOUND_KEYS = Object.freeze(["value", "scope", "absorber"]);
const COOPERATIVE_RUNNER_CAP_KEYS = Object.freeze(["value", "display", "status", "scope", "absorber"]);
const CURRENT_OPERATIONS_COMPROMISE_EXPOSURE_KEYS = Object.freeze([
  "threat",
  "status",
  "maximumReleaseRule",
  "processPrincipalExposureAtomicUSDG",
  "returnedProceedsExposureAtomicUSDG",
  "modelObservedExposureAtomicUSDG",
  "modelObservedDisplay",
  "systemwideCustodyLossUpperBoundAtomicUSDG",
  "absorber"
]);
const UNRESOLVED_EXTERNAL_EXPOSURE_KEYS = Object.freeze([
  "status", "modeledLowerBoundAtomicUSDG", "systemwideLossUpperBoundAtomicUSDG", "reason"
]);
const OWNER_APPROVAL_REQUEST_KEYS = Object.freeze(["pending", "numbers", "notAnActionAuthorization"]);
const OWNER_APPROVAL_NUMBER_KEYS = Object.freeze([
  "maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG",
  "minimumNoNewInflowRunwaySeconds",
  "maximumUnpaidEntitlementsInTheSinglePhaseOnePayout",
  "allListedConservationAndRejectedCooperativeRunnerMutationBounds"
]);
const RELEASE_BOUND_NUMERIC_CAP_KEYS = Object.freeze(["status", "requiredBeforeLiveAction", "rule"]);
const RELEASE_BOUND_NUMERIC_CAP_STATUS =
  "PENDING_PROVIDER_BINDING_EVIDENCE_AND_SEPARATE_ACTION_AUTHORIZATION";
const RELEASE_BOUND_REQUIRED_ACTION_CAPS = Object.freeze([
  "maximum Robinhood USDG debit in atomic units",
  "maximum Solana Circle USD Coin debit in atomic units",
  "maximum Robinhood native-gas spend in wei",
  "maximum Solana native-gas spend in lamports",
  "maximum native-gas spend for any additional chain selected by the fixed conversion route"
]);
const RELEASE_BOUND_RULE =
  "Every value must be a concrete number derived from the final independently decoded action bundle. Exceeding any approved value is forbidden; these caps do not become hook policy or a long-term reserve.";
const MODEL_COMPARISON_KEYS = Object.freeze(["command", "source", "candidateResult", "authority"]);
const MODEL_COMPARISON_COMMAND =
  "node feasibility/model.mjs --verify feasibility/model-results.json --verify-bounds feasibility/survivability-bounds.json";
const MODEL_COMPARISON_SOURCE = "feasibility/model-results.json#/candidateBoundComparison";
const MODEL_COMPARISON_RESULT = "PASS_COOPERATIVE_RUNNER_SCOPE_ONLY";
const MODEL_COMPARISON_AUTHORITY =
  "The comparison covers separately authorized cooperative runner actions only. It proves zero Operations custody but does not bound unresolved provider, authorizer, route-executor, bridge, or policy-wallet compromise exposure, approve candidates, or authorize an external action.";

const MODEL_CANDIDATE_BOUNDS = Object.freeze({
  maximumFeeConservationErrorAtomicUSDG: 0n,
  maximumRecordedLiabilityLossAtomicUSDG: 0n,
  maximumPayoutUnderfundingAtomicUSDG: 0n,
  maximumCommitmentAboveActualReturnedAtomicUSDG: 0n,
  maximumDuplicateMisdirectedOrShortHolderPaymentAtomicUSDG: 0n,
  maximumRejectedCooperativeRunnerRobinhoodUSDGActionMutationAtomicUSDG: 0n,
  maximumRejectedCooperativeRunnerSolanaCircleCoinActionMutationAtomic: 0n,
  maximumRejectedCooperativeRunnerNftActionMutationCount: 0n,
  minimumNoNewInflowRunwaySeconds: 0n,
  maximumUnpaidEntitlementsInTheSinglePhaseOnePayout: BigInt(TREE_POSITIONS),
  maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC
});

const modelDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultResultPath = path.join(modelDirectory, "model-results.json");

function invariant(condition, message) {
  if (!condition) throw new Error(`INVARIANT_FAILED: ${message}`);
}

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function json(value) {
  return `${JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function maximumBigInt(values) {
  return values.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
}

function splitFee(executedQuoteAtomic) {
  invariant(executedQuoteAtomic >= 0n, "executed quote volume cannot be negative");
  const total = executedQuoteAtomic * TOTAL_FEE_BPS / BPS_DENOMINATOR;
  const programmable = executedQuoteAtomic * PROGRAMMABLE_BPS / BPS_DENOMINATOR;
  const treasury = executedQuoteAtomic * TREASURY_BPS / BPS_DENOMINATOR;
  const process = total - programmable - treasury;
  invariant(process >= 0n, "process liability cannot be negative");
  invariant(programmable + treasury + process === total, "fee split does not conserve collected USDG");
  return { total, programmable, treasury, process };
}

function buildFeeConformanceProof() {
  const roundingInputs = [
    0n, 1n, 32n, 33n, 34n, 35n,
    248n, 249n, 250n, 251n,
    998n, 999n, 1_000n, 1_001n,
    3_332n, 3_333n, 3_334n
  ];
  const roundingTransitions = roundingInputs.map((executedUsdg) => ({
    executedUsdg,
    ...splitFee(executedUsdg)
  }));

  const sampleCount = 100_000;
  const mask64 = (1n << 64n) - 1n;
  let state = 0x484f4f4b454d4f4en;
  const digest = createHash("sha256");
  for (let index = 0; index < sampleCount; ++index) {
    state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & mask64;
    const fee = splitFee(state);
    invariant(fee.total <= state, "fee exceeds executed USDG");
    digest.update(`${state}:${fee.total}:${fee.programmable}:${fee.treasury}:${fee.process}\n`);
  }

  return {
    roundingTransitions,
    deterministicFuzz: {
      algorithm: "LCG64",
      seed: "0x484f4f4b454d4f4e",
      domain: "0..2^64-1 atomic USDG",
      sampleCount,
      conservationFailures: 0,
      vectorDigest: `sha256:${digest.digest("hex")}`
    }
  };
}

function buildCanonicalMarketProof() {
  const swapQuadrants = [];
  for (const usdgIsCurrency0 of [true, false]) {
    for (const zeroForOne of [true, false]) {
      for (const exactInput of [true, false]) {
        const amountSpecified = exactInput ? -100_000n : 80_000n;
        const specifiedIsCurrency0 = exactInput === zeroForOne;
        const specifiedIsUsdg = specifiedIsCurrency0 === usdgIsCurrency0;
        const rawPoolUnspecifiedDelta = exactInput ? 80_000n : -100_000n;
        const executedUsdg = specifiedIsUsdg
          ? absolute(amountSpecified)
          : absolute(rawPoolUnspecifiedDelta);
        const fee = splitFee(executedUsdg);
        const beforeSwapSpecifiedHookDelta = specifiedIsUsdg ? fee.total : 0n;
        const afterSwapUnspecifiedHookDelta = specifiedIsUsdg ? 0n : fee.total;

        // Pinned v4-core adds the beforeSwap specified delta to amountSpecified before
        // the pool swap, then subtracts the complete hook delta from the caller delta.
        const rawPoolSpecifiedDelta = amountSpecified + beforeSwapSpecifiedHookDelta;
        const rawPoolAmount0 = specifiedIsCurrency0
          ? rawPoolSpecifiedDelta
          : rawPoolUnspecifiedDelta;
        const rawPoolAmount1 = specifiedIsCurrency0
          ? rawPoolUnspecifiedDelta
          : rawPoolSpecifiedDelta;
        const hookAmount0 = specifiedIsCurrency0
          ? beforeSwapSpecifiedHookDelta
          : afterSwapUnspecifiedHookDelta;
        const hookAmount1 = specifiedIsCurrency0
          ? afterSwapUnspecifiedHookDelta
          : beforeSwapSpecifiedHookDelta;
        const callerAmount0 = rawPoolAmount0 - hookAmount0;
        const callerAmount1 = rawPoolAmount1 - hookAmount1;
        const callerSpecifiedDelta = specifiedIsCurrency0 ? callerAmount0 : callerAmount1;
        const collectedUsdg = usdgIsCurrency0 ? hookAmount0 : hookAmount1;
        const fullFill = callerSpecifiedDelta === amountSpecified;
        invariant(fullFill, "canonical-market quadrant does not fully fill the specified side");
        invariant(collectedUsdg === fee.total, "canonical-market quadrant does not collect the exact USDG fee");
        invariant(STATIC_LP_FEE === 0, "canonical PoolKey LP fee is not zero");
        invariant(fee.total === fee.programmable + fee.treasury + fee.process, "quadrant fee split does not conserve USDG");

        swapQuadrants.push({
          id: [
            usdgIsCurrency0 ? "USDG_CURRENCY0" : "USDG_CURRENCY1",
            zeroForOne ? "ZERO_FOR_ONE" : "ONE_FOR_ZERO",
            exactInput ? "EXACT_INPUT" : "EXACT_OUTPUT"
          ].join("_"),
          tokenOrder: usdgIsCurrency0 ? "USDG_HKMN" : "HKMN_USDG",
          side: zeroForOne === usdgIsCurrency0 ? "BUY_HKMN" : "SELL_HKMN",
          exactness: exactInput ? "EXACT_INPUT" : "EXACT_OUTPUT",
          specifiedCurrency: specifiedIsCurrency0 ? "CURRENCY0" : "CURRENCY1",
          amountSpecified,
          rawPoolDelta: {
            amount0: rawPoolAmount0,
            amount1: rawPoolAmount1
          },
          hookDelta: {
            beforeSwapSpecified: beforeSwapSpecifiedHookDelta,
            afterSwapUnspecified: afterSwapUnspecifiedHookDelta,
            amount0: hookAmount0,
            amount1: hookAmount1
          },
          callerDelta: {
            amount0: callerAmount0,
            amount1: callerAmount1
          },
          executedUsdg,
          executedUsdgSource: specifiedIsUsdg
            ? "FINAL_CALLER_SPECIFIED_DELTA_AFTER_FULL_FILL"
            : "RAW_POOL_UNSPECIFIED_DELTA_BEFORE_AFTERSWAP_HOOK_DELTA",
          collectedUsdg,
          usdgFeeCollectionStage: specifiedIsUsdg
            ? "BEFORE_SWAP_SPECIFIED_DELTA_VERIFIED_AFTER_SWAP"
            : "AFTER_SWAP_UNSPECIFIED_DELTA",
          fullFill,
          staticLpFee: STATIC_LP_FEE,
          additionalTradingFeeBasisPoints: 0,
          fee
        });
      }
    }
  }
  invariant(swapQuadrants.length === 8, "canonical-market proof must cover eight swap quadrants");

  return {
    poolKey: {
      staticLpFee: STATIC_LP_FEE,
      dynamicFee: false
    },
    hookPermissions: {
      mask: `0x${REQUIRED_HOOK_PERMISSION_MASK.toString(16).padStart(4, "0")}`,
      beforeInitialize: true,
      beforeSwap: true,
      afterSwap: true,
      beforeSwapReturnDelta: true,
      afterSwapReturnDelta: true,
      allOtherPermissions: false
    },
    hookFeeBasisPoints: {
      total: Number(TOTAL_FEE_BPS),
      programmable: Number(PROGRAMMABLE_BPS),
      treasury: Number(TREASURY_BPS),
      process: "total minus independently rounded Programmable and treasury amounts"
    },
    executedUsdgNormalization: {
      specifiedUsdg: "abs(params.amountSpecified), after the returned hook delta restores the final caller specified delta exactly",
      unspecifiedUsdg: "abs(raw PoolManager swap delta), before the afterSwap unspecified hook delta is subtracted from the caller delta",
      partialFillPolicy: "REVERT_WHOLE_SWAP"
    },
    additionalTradingFeeBasisPoints: {
      protocol: 0,
      router: 0,
      provider: 0,
      integrator: 0,
      tokenTransfer: 0,
      other: 0
    },
    launchAllocationBasisPoints: LAUNCH_ALLOCATION_BPS,
    custody: {
      path: "IMMUTABLE_SINGLE_POSITION_RECEIVER",
      projectControlled: false,
      upgradeable: false,
      forbiddenAuthorityPaths: {
        transfer: false,
        approval: false,
        liquidityDecrease: false,
        principalWithdrawal: false,
        feeCollection: false,
        rescue: false,
        upgrade: false,
        delegatecall: false,
        successorControl: false
      }
    },
    postCustodyAvailability: {
      supportedBuy: true,
      supportedSell: true,
      userBalanceTransfer: true
    },
    feeConformance: buildFeeConformanceProof(),
    swapQuadrants
  };
}

function freshState() {
  return {
    hookUsdgBalance: 0n,
    pegCycleVaultUsdgBalance: 0n,
    operationsUsdgBalance: 0n,
    solanaCircleCoinBalance: 0n,
    heldNftMints: new Set(),
    liabilities: { programmable: 0n, treasury: 0n, process: 0n, payouts: 0n },
    currentOperationsIdentity: MODELED_OPERATIONS_IDENTITY,
    releasedCycles: new Set(),
    releasedCycleRecords: new Map(),
    terminalCycles: new Set(),
    payoutIds: new Set(),
    paidKeys: new Set(),
    consumedAuthorizationKeys: new Set(),
    consumedReceiptKeys: new Set(),
    proceedsAttribution: new Map(),
    consumedProceedsKeys: new Set(),
    payout: null,
    recipientCredits: new Map(),
    actionSequence: [],
    minimumSolvencyHeadroomAtomic: null,
    rejectedOperations: []
  };
}

function totalLiabilities(state) {
  return state.liabilities.programmable
    + state.liabilities.treasury
    + state.liabilities.process
    + state.liabilities.payouts;
}

function totalRecipientCredits(state) {
  return [...state.recipientCredits.values()].reduce((sum, amount) => sum + amount, 0n);
}

function checkpoint(state, label) {
  const liabilities = totalLiabilities(state);
  invariant(state.hookUsdgBalance >= liabilities, `${label}: hook balance is below recorded liabilities`);
  if (state.payout) {
    invariant(
      state.payout.fundedAtomic === state.payout.paidAtomic + state.payout.unpaidAtomic,
      `${label}: payout conservation failed`
    );
    invariant(
      state.payout.unpaidAtomic === state.liabilities.payouts,
      `${label}: payout liability differs from unpaid amount`
    );
  } else {
    invariant(state.liabilities.payouts === 0n, `${label}: payout liability exists without a payout`);
  }
  const headroom = state.hookUsdgBalance - liabilities;
  state.minimumSolvencyHeadroomAtomic = state.minimumSolvencyHeadroomAtomic === null
    ? headroom
    : headroom < state.minimumSolvencyHeadroomAtomic
      ? headroom
      : state.minimumSolvencyHeadroomAtomic;
}

function reject(state, operation, reason) {
  state.rejectedOperations.push({ operation, reason, stateMutation: false });
  checkpoint(state, `${operation}-rejected`);
  return false;
}

function economicSnapshot(state) {
  const payout = state.payout
    ? {
        id: state.payout.id,
        fundedAtomic: state.payout.fundedAtomic,
        paidAtomic: state.payout.paidAtomic,
        unpaidAtomic: state.payout.unpaidAtomic
      }
    : null;
  return {
    hookUsdgBalance: state.hookUsdgBalance,
    pegCycleVaultUsdgBalance: state.pegCycleVaultUsdgBalance,
    operationsUsdgBalance: state.operationsUsdgBalance,
    solanaCircleCoinBalance: state.solanaCircleCoinBalance,
    heldNftMints: [...state.heldNftMints].sort(),
    liabilities: { ...state.liabilities },
    currentOperationsIdentity: state.currentOperationsIdentity,
    releasedCycles: [...state.releasedCycles].sort(),
    releasedCycleRecords: [...state.releasedCycleRecords.entries()].sort(([left], [right]) => left.localeCompare(right)),
    terminalCycles: [...state.terminalCycles].sort(),
    payoutIds: [...state.payoutIds].sort(),
    paidKeys: [...state.paidKeys].sort(),
    consumedAuthorizationKeys: [...state.consumedAuthorizationKeys].sort(),
    consumedReceiptKeys: [...state.consumedReceiptKeys].sort(),
    proceedsAttribution: [...state.proceedsAttribution.entries()].sort(([left], [right]) => left.localeCompare(right)),
    consumedProceedsKeys: [...state.consumedProceedsKeys].sort(),
    payout,
    recipientCredits: [...state.recipientCredits.entries()].sort(([left], [right]) => left.localeCompare(right)),
    actionSequence: [...state.actionSequence],
    minimumSolvencyHeadroomAtomic: state.minimumSolvencyHeadroomAtomic
  };
}

function rejectionDeltas(before, after) {
  const beforePayout = before.payout ?? { fundedAtomic: 0n, paidAtomic: 0n, unpaidAtomic: 0n };
  const afterPayout = after.payout ?? { fundedAtomic: 0n, paidAtomic: 0n, unpaidAtomic: 0n };
  const beforeRecipientTotal = before.recipientCredits.reduce((sum, [, amount]) => sum + amount, 0n);
  const afterRecipientTotal = after.recipientCredits.reduce((sum, [, amount]) => sum + amount, 0n);
  return {
    usdgAtomic: maximumBigInt([
      absolute(after.hookUsdgBalance - before.hookUsdgBalance),
      absolute(after.pegCycleVaultUsdgBalance - before.pegCycleVaultUsdgBalance),
      absolute(after.operationsUsdgBalance - before.operationsUsdgBalance),
      absolute(after.liabilities.programmable - before.liabilities.programmable),
      absolute(after.liabilities.treasury - before.liabilities.treasury),
      absolute(after.liabilities.process - before.liabilities.process),
      absolute(after.liabilities.payouts - before.liabilities.payouts),
      absolute(afterPayout.fundedAtomic - beforePayout.fundedAtomic),
      absolute(afterPayout.paidAtomic - beforePayout.paidAtomic),
      absolute(afterPayout.unpaidAtomic - beforePayout.unpaidAtomic),
      absolute(afterRecipientTotal - beforeRecipientTotal)
    ]),
    solanaCircleCoinAtomic: absolute(after.solanaCircleCoinBalance - before.solanaCircleCoinBalance),
    nftCount: BigInt(Math.abs(after.heldNftMints.length - before.heldNftMints.length))
  };
}

function probeRejectedOperation(state, operationName, operation) {
  const before = economicSnapshot(state);
  const accepted = operation();
  const after = economicSnapshot(state);
  invariant(!accepted, `${operationName}: invalid operation was accepted`);
  const deltas = rejectionDeltas(before, after);
  invariant(json(before) === json(after), `${operationName}: rejected operation changed state`);
  return deltas;
}

function accrueCanonicalFee(state, executedQuoteAtomic) {
  const fee = splitFee(executedQuoteAtomic);
  state.hookUsdgBalance += fee.total;
  state.liabilities.programmable += fee.programmable;
  state.liabilities.treasury += fee.treasury;
  state.liabilities.process += fee.process;
  checkpoint(state, "canonical-fee-accrual");
  return fee;
}

function openPegCycle(state, { cycleId, amountAtomic, callerIdentity }) {
  if (state.releasedCycles.has(cycleId)) return reject(state, "peg-cycle-opening", "CYCLE_REPLAY");
  if (callerIdentity !== state.currentOperationsIdentity) {
    return reject(state, "peg-cycle-opening", "UNAUTHORIZED_OPERATIONS_TRIGGER");
  }
  if (amountAtomic <= 0n || amountAtomic > state.liabilities.process) {
    return reject(state, "peg-cycle-opening", "AMOUNT_OUT_OF_BOUNDS");
  }
  state.releasedCycles.add(cycleId);
  state.releasedCycleRecords.set(cycleId, {
    amountAtomic,
    operationsTrigger: callerIdentity,
    destination: "IMMUTABLE_PEG_CYCLE_VAULT"
  });
  state.liabilities.process -= amountAtomic;
  state.hookUsdgBalance -= amountAtomic;
  state.pegCycleVaultUsdgBalance += amountAtomic;
  invariant(state.operationsUsdgBalance === 0n, "process funding exposed principal to Operations");
  checkpoint(state, "peg-cycle-opening");
  return true;
}

function balanceForAsset(state, asset) {
  if (asset === "ROBINHOOD_USDG") return state.pegCycleVaultUsdgBalance;
  if (asset === "SOLANA_CIRCLE_COIN") return state.solanaCircleCoinBalance;
  throw new Error(`UNSUPPORTED_ASSET: ${asset}`);
}

function setBalanceForAsset(state, asset, value) {
  if (asset === "ROBINHOOD_USDG") {
    state.pegCycleVaultUsdgBalance = value;
    return;
  }
  if (asset === "SOLANA_CIRCLE_COIN") {
    state.solanaCircleCoinBalance = value;
    return;
  }
  throw new Error(`UNSUPPORTED_ASSET: ${asset}`);
}

function executeFungibleExternalAction(state, action) {
  const operation = `external-${action.kind}`;
  if (!action.ownerAuthorized) return reject(state, operation, "OWNER_AUTHORIZATION_MISSING");
  if (action.spendAtomic <= 0n || action.spendCapAtomic < 0n || action.spendAtomic > action.spendCapAtomic) {
    return reject(state, operation, "SPEND_CAP_EXCEEDED");
  }
  if (state.consumedAuthorizationKeys.has(action.authorizationKey)) {
    return reject(state, operation, "AUTHORIZATION_REPLAY");
  }
  if (state.consumedReceiptKeys.has(action.receiptKey)) return reject(state, operation, "RECEIPT_REPLAY");
  const sourceBalance = balanceForAsset(state, action.sourceAsset);
  if (sourceBalance < action.spendAtomic) return reject(state, operation, "SOURCE_BALANCE_TOO_LOW");
  if (action.creditAtomic < 0n) return reject(state, operation, "NEGATIVE_OBSERVED_CREDIT");

  state.consumedAuthorizationKeys.add(action.authorizationKey);
  state.consumedReceiptKeys.add(action.receiptKey);
  setBalanceForAsset(state, action.sourceAsset, sourceBalance - action.spendAtomic);
  if (action.destinationAsset) {
    const destinationBalance = balanceForAsset(state, action.destinationAsset);
    setBalanceForAsset(state, action.destinationAsset, destinationBalance + action.creditAtomic);
  } else if (action.creditAtomic !== 0n) {
    throw new Error(`${operation}: credit exists without a destination asset`);
  }
  state.actionSequence.push(action.kind);
  checkpoint(state, operation);
  return true;
}

function executeOpen(state, action) {
  const operation = "external-open";
  if (!action.ownerAuthorized) return reject(state, operation, "OWNER_AUTHORIZATION_MISSING");
  if (state.consumedAuthorizationKeys.has(action.authorizationKey)) {
    return reject(state, operation, "AUTHORIZATION_REPLAY");
  }
  if (!action.nftMint || state.heldNftMints.has(action.nftMint)) {
    return reject(state, operation, "NFT_CUSTODY_MISMATCH");
  }
  state.consumedAuthorizationKeys.add(action.authorizationKey);
  state.heldNftMints.add(action.nftMint);
  state.actionSequence.push(action.kind);
  checkpoint(state, operation);
  return true;
}

function executeBuyback(state, action) {
  const operation = "external-buyback";
  if (!action.ownerAuthorized) return reject(state, operation, "OWNER_AUTHORIZATION_MISSING");
  if (state.consumedAuthorizationKeys.has(action.authorizationKey)) {
    return reject(state, operation, "AUTHORIZATION_REPLAY");
  }
  if (state.consumedReceiptKeys.has(action.receiptKey)) return reject(state, operation, "RECEIPT_REPLAY");
  if (!state.heldNftMints.has(action.nftMint)) return reject(state, operation, "NFT_NOT_HELD");
  if (action.refundAtomic <= 0n || action.refundAtomic < action.minimumReceiveAtomic) {
    return reject(state, operation, "BUYBACK_MINIMUM_NOT_MET");
  }
  state.consumedAuthorizationKeys.add(action.authorizationKey);
  state.consumedReceiptKeys.add(action.receiptKey);
  state.heldNftMints.delete(action.nftMint);
  state.solanaCircleCoinBalance += action.refundAtomic;
  state.actionSequence.push(action.kind);
  checkpoint(state, operation);
  return true;
}

function runExternalLedger(state, scenario) {
  const external = scenario.externalLedger;
  const outbound = external.outbound;
  invariant(outbound.spendAtomic > 0n, `${scenario.id}: outbound debit must be positive`);
  invariant(outbound.spendAtomic <= scenario.processFundingAtomic, `${scenario.id}: outbound debit exceeds vault funding`);
  invariant(outbound.spendAtomic <= scenario.authorizedPrincipalAtomic, `${scenario.id}: outbound debit exceeds principal authorization`);
  invariant(executeFungibleExternalAction(state, outbound), `${scenario.id}: valid outbound action failed`);

  if (external.outcome === "TERMINAL_PRINCIPAL_LOSS") {
    invariant(external.terminalLossEvidence === true, `${scenario.id}: terminal loss lacks final evidence`);
    invariant(outbound.creditAtomic === 0n, `${scenario.id}: terminal loss cannot claim destination credit`);
    invariant(state.solanaCircleCoinBalance === 0n, `${scenario.id}: terminal loss leaves Circle Coin custody`);
    invariant(state.heldNftMints.size === 0, `${scenario.id}: terminal loss leaves NFT custody`);
    state.terminalCycles.add(scenario.cycleId);
    checkpoint(state, "external-terminal-loss");
    return {
      completed: false,
      externalLedgerClosed: true,
      payoutEligible: false,
      pegCycleVaultUsdgDebitAtomic: outbound.spendAtomic,
      pegCycleVaultUsdgCreditAtomic: 0n,
      externalPrincipalLossAtomic: outbound.spendAtomic,
      unresolvedExternalPrincipalAtomic: 0n,
      proceedsAttributionKey: null
    };
  }

  invariant(external.outcome === "FINALIZED_RETURN", `${scenario.id}: unsupported external outcome`);
  invariant(executeFungibleExternalAction(state, external.pack), `${scenario.id}: valid pack action failed`);
  invariant(executeOpen(state, external.open), `${scenario.id}: valid open action failed`);
  invariant(executeBuyback(state, external.buyback), `${scenario.id}: valid buyback action failed`);
  invariant(executeFungibleExternalAction(state, external.return), `${scenario.id}: valid return action failed`);
  invariant(state.solanaCircleCoinBalance === 0n, `${scenario.id}: finalized cycle leaves Circle Coin unresolved`);
  invariant(state.heldNftMints.size === 0, `${scenario.id}: finalized cycle leaves NFT custody unresolved`);
  invariant(external.return.creditAtomic > 0n, `${scenario.id}: finalized return lacks actual positive USDG credit`);

  const proceedsAttributionKey = `${scenario.id}:actual-returned-usdg`;
  invariant(!state.proceedsAttribution.has(proceedsAttributionKey), `${scenario.id}: proceeds key already exists`);
  state.proceedsAttribution.set(proceedsAttributionKey, {
    cycleId: scenario.cycleId,
    actualReturnedUsdgAtomic: external.return.creditAtomic
  });
  checkpoint(state, "external-cycle-finalized");
  const principalLoss = outbound.spendAtomic > external.return.creditAtomic
    ? outbound.spendAtomic - external.return.creditAtomic
    : 0n;
  return {
    completed: true,
    externalLedgerClosed: true,
    payoutEligible: true,
    pegCycleVaultUsdgDebitAtomic: outbound.spendAtomic,
    pegCycleVaultUsdgCreditAtomic: external.return.creditAtomic,
    externalPrincipalLossAtomic: principalLoss,
    unresolvedExternalPrincipalAtomic: 0n,
    proceedsAttributionKey
  };
}

function validatePayoutEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > TREE_POSITIONS) {
    return "POSITION_COUNT_INVALID";
  }
  const indices = new Set();
  const recipients = new Set();
  for (const entry of entries) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= TREE_POSITIONS) return "INDEX_INVALID";
    if (indices.has(entry.index)) return "INDEX_DUPLICATE";
    if (!entry.recipient || entry.recipient === ZERO_RECIPIENT || recipients.has(entry.recipient)) {
      return "RECIPIENT_INVALID";
    }
    if (entry.directHkmnBalanceAtomic <= 0n) return "RECIPIENT_NOT_DIRECT_HOLDER";
    if (entry.amountAtomic <= 0n) return "AMOUNT_INVALID";
    indices.add(entry.index);
    recipients.add(entry.recipient);
  }
  return null;
}

function fundPayout(state, request) {
  const operation = "payout-funding";
  const releasedCycle = state.releasedCycleRecords.get(request.cycleId);
  if (
    !releasedCycle
      || request.operationsTrigger !== releasedCycle.operationsTrigger
      || request.payerIdentity !== "IMMUTABLE_PEG_CYCLE_VAULT"
  ) {
    return reject(state, operation, "EXACT_VAULT_AUTHORIZATION_REQUIRED");
  }
  if (state.payoutIds.has(request.payoutId)) return reject(state, operation, "PAYOUT_REPLAY");
  if (state.consumedProceedsKeys.has(request.proceedsAttributionKey)) {
    return reject(state, operation, "PROCEEDS_REPLAY");
  }
  const proceeds = state.proceedsAttribution.get(request.proceedsAttributionKey);
  if (!proceeds || proceeds.cycleId !== request.cycleId) return reject(state, operation, "PROCEEDS_CYCLE_MISMATCH");
  if (!request.ownerApprovedManifest || !request.manifestDigest || request.manifestDigest === "0x0") {
    return reject(state, operation, "MANIFEST_NOT_APPROVED");
  }
  if (!request.rootHash || request.rootHash === "0x0") return reject(state, operation, "ROOT_INVALID");
  if (
    !Array.isArray(request.fetchedPublicationDigests)
      || request.fetchedPublicationDigests.length !== 2
      || request.fetchedPublicationDigests.some((digest) => digest !== request.manifestDigest)
  ) {
    return reject(state, operation, "PUBLICATION_PREFLIGHT_FAILED");
  }
  const entryError = validatePayoutEntries(request.entries);
  if (entryError) return reject(state, operation, entryError);
  const rootSum = request.entries.reduce((sum, entry) => sum + entry.amountAtomic, 0n);
  if (rootSum !== proceeds.actualReturnedUsdgAtomic) return reject(state, operation, "ROOT_SUM_MISMATCH");
  if (state.pegCycleVaultUsdgBalance !== rootSum) return reject(state, operation, "VAULT_BALANCE_MISMATCH");

  state.consumedProceedsKeys.add(request.proceedsAttributionKey);
  state.payoutIds.add(request.payoutId);
  state.pegCycleVaultUsdgBalance -= rootSum;
  state.hookUsdgBalance += rootSum;
  invariant(state.operationsUsdgBalance === 0n, "payout funding exposed returned proceeds to Operations");
  state.liabilities.payouts += rootSum;
  state.payout = {
    id: request.payoutId,
    cycleId: request.cycleId,
    proceedsAttributionKey: request.proceedsAttributionKey,
    manifestDigest: request.manifestDigest,
    rootHash: request.rootHash,
    entries: request.entries,
    fundedAtomic: rootSum,
    paidAtomic: 0n,
    unpaidAtomic: rootSum
  };
  checkpoint(state, operation);
  return true;
}

function payEntitlement(state, request) {
  const operation = "entitlement-payment";
  if (!state.payout || request.payoutId !== state.payout.id) return reject(state, operation, "PAYOUT_NOT_FOUND");
  const entry = state.payout.entries.find((candidate) => candidate.index === request.index);
  if (!entry) return reject(state, operation, "INDEX_NOT_COMMITTED");
  if (
    request.recipient !== entry.recipient
      || request.amountAtomic !== entry.amountAtomic
      || request.directHkmnBalanceAtomic !== entry.directHkmnBalanceAtomic
  ) {
    return reject(state, operation, "LEAF_MISMATCH");
  }
  const paidKey = `${state.payout.id}:${request.index}`;
  if (state.paidKeys.has(paidKey)) return reject(state, operation, "PAID_KEY_REPLAY");
  if (!request.transferSucceeds) return reject(state, operation, "RECIPIENT_TRANSFER_FAILED");
  const observedHookDebitAtomic = request.observedHookDebitAtomic ?? entry.amountAtomic;
  const observedRecipientCreditAtomic = request.observedRecipientCreditAtomic ?? entry.amountAtomic;
  if (observedHookDebitAtomic !== entry.amountAtomic || observedRecipientCreditAtomic !== entry.amountAtomic) {
    return reject(state, operation, "NON_EXACT_TRANSFER_DELTA");
  }

  state.paidKeys.add(paidKey);
  state.payout.paidAtomic += entry.amountAtomic;
  state.payout.unpaidAtomic -= entry.amountAtomic;
  state.liabilities.payouts -= entry.amountAtomic;
  state.hookUsdgBalance -= entry.amountAtomic;
  state.recipientCredits.set(entry.recipient, (state.recipientCredits.get(entry.recipient) ?? 0n) + entry.amountAtomic);
  checkpoint(state, operation);
  return true;
}

function probeProcessFundingGuards(state, scenario) {
  const probes = [
    probeRejectedOperation(state, `${scenario.id}:peg-cycle-opening-replay`, () => openPegCycle(state, {
      cycleId: scenario.cycleId,
      amountAtomic: scenario.processFundingAtomic,
      callerIdentity: MODELED_OPERATIONS_IDENTITY
    })),
    probeRejectedOperation(state, `${scenario.id}:peg-cycle-opening-unauthorized`, () => openPegCycle(state, {
      cycleId: `${scenario.cycleId}-unauthorized`,
      amountAtomic: 1n,
      callerIdentity: "0xffffffffffffffffffffffffffffffffffffffff"
    }))
  ];
  return maximumBigInt(probes.map((probe) => probe.usdgAtomic));
}

function probeExternalGuards(state, scenario) {
  const outbound = scenario.externalLedger.outbound;
  const probes = [
    probeRejectedOperation(state, `${scenario.id}:outbound-authorization-replay`, () => executeFungibleExternalAction(state, outbound)),
    probeRejectedOperation(state, `${scenario.id}:outbound-receipt-replay`, () => executeFungibleExternalAction(state, {
      ...outbound,
      authorizationKey: `${scenario.id}:fresh-authorization-for-receipt-replay`,
      ownerAuthorized: true,
      spendAtomic: 1n,
      spendCapAtomic: 1n,
      creditAtomic: 0n
    })),
    probeRejectedOperation(state, `${scenario.id}:outbound-unauthorized`, () => executeFungibleExternalAction(state, {
      ...outbound,
      authorizationKey: `${scenario.id}:unauthorized-outbound-authorization`,
      receiptKey: `${scenario.id}:unauthorized-outbound-receipt`,
      ownerAuthorized: false,
      spendAtomic: 1n,
      spendCapAtomic: 1n,
      creditAtomic: 0n
    })),
    probeRejectedOperation(state, `${scenario.id}:outbound-cap-plus-one`, () => executeFungibleExternalAction(state, {
      ...outbound,
      authorizationKey: `${scenario.id}:over-cap-outbound-authorization`,
      receiptKey: `${scenario.id}:over-cap-outbound-receipt`,
      ownerAuthorized: true,
      spendAtomic: outbound.spendCapAtomic + 1n,
      creditAtomic: 0n
    }))
  ];

  if (scenario.externalLedger.outcome === "FINALIZED_RETURN") {
    probes.push(
      probeRejectedOperation(state, `${scenario.id}:pack-authorization-replay`, () => executeFungibleExternalAction(state, scenario.externalLedger.pack)),
      probeRejectedOperation(state, `${scenario.id}:open-authorization-replay`, () => executeOpen(state, scenario.externalLedger.open)),
      probeRejectedOperation(state, `${scenario.id}:buyback-authorization-replay`, () => executeBuyback(state, scenario.externalLedger.buyback)),
      probeRejectedOperation(state, `${scenario.id}:return-authorization-replay`, () => executeFungibleExternalAction(state, scenario.externalLedger.return)),
      probeRejectedOperation(state, `${scenario.id}:circle-coin-cap-plus-one`, () => executeFungibleExternalAction(state, {
        ...scenario.externalLedger.pack,
        authorizationKey: `${scenario.id}:over-cap-pack-authorization`,
        receiptKey: `${scenario.id}:over-cap-pack-receipt`,
        ownerAuthorized: true,
        spendAtomic: scenario.externalLedger.pack.spendCapAtomic + 1n
      }))
    );
  }

  return {
    robinhoodUsdgAtomic: maximumBigInt(probes.map((probe) => probe.usdgAtomic)),
    solanaCircleCoinAtomic: maximumBigInt(probes.map((probe) => probe.solanaCircleCoinAtomic)),
    nftCount: maximumBigInt(probes.map((probe) => probe.nftCount))
  };
}

function probeInvalidPayoutFunding(state, scenario, payoutRequest) {
  const rootSumMismatchEntries = payoutRequest.entries.map((entry, index) => index === 0
    ? { ...entry, amountAtomic: entry.amountAtomic + 1n }
    : entry);
  const duplicateIndexEntries = payoutRequest.entries.map((entry, index) => index === 1
    ? { ...entry, index: payoutRequest.entries[0].index }
    : entry);
  const duplicateRecipientEntries = payoutRequest.entries.map((entry, index) => index === 1
    ? { ...entry, recipient: payoutRequest.entries[0].recipient }
    : entry);
  const nonholderEntries = payoutRequest.entries.map((entry, index) => index === 0
    ? { ...entry, directHkmnBalanceAtomic: 0n }
    : entry);
  const probes = [
    probeRejectedOperation(state, `${scenario.id}:wrong-operations-trigger`, () => fundPayout(state, {
      ...payoutRequest,
      operationsTrigger: "0xffffffffffffffffffffffffffffffffffffffff"
    })),
    probeRejectedOperation(state, `${scenario.id}:operations-payer`, () => fundPayout(state, {
      ...payoutRequest,
      payerIdentity: MODELED_OPERATIONS_IDENTITY
    })),
    probeRejectedOperation(state, `${scenario.id}:publication-digest-mismatch`, () => fundPayout(state, {
      ...payoutRequest,
      fetchedPublicationDigests: [payoutRequest.manifestDigest, "0xffff"]
    })),
    probeRejectedOperation(state, `${scenario.id}:root-sum-mismatch`, () => fundPayout(state, {
      ...payoutRequest,
      entries: rootSumMismatchEntries
    })),
    probeRejectedOperation(state, `${scenario.id}:duplicate-leaf-index`, () => fundPayout(state, {
      ...payoutRequest,
      entries: duplicateIndexEntries
    })),
    probeRejectedOperation(state, `${scenario.id}:duplicate-leaf-recipient`, () => fundPayout(state, {
      ...payoutRequest,
      entries: duplicateRecipientEntries
    })),
    probeRejectedOperation(state, `${scenario.id}:nonholder-leaf`, () => fundPayout(state, {
      ...payoutRequest,
      entries: nonholderEntries
    })),
    probeRejectedOperation(state, `${scenario.id}:zero-root`, () => fundPayout(state, {
      ...payoutRequest,
      rootHash: "0x0"
    })),
    probeRejectedOperation(state, `${scenario.id}:unapproved-manifest`, () => fundPayout(state, {
      ...payoutRequest,
      ownerApprovedManifest: false
    }))
  ];
  return maximumBigInt(probes.map((probe) => probe.usdgAtomic));
}

function probeInvalidPayments(state, scenario) {
  if (!state.payout) return 0n;
  const first = state.payout.entries[0];
  const probes = [
    probeRejectedOperation(state, `${scenario.id}:misdirected-payment`, () => payEntitlement(state, {
      payoutId: state.payout.id,
      index: first.index,
      recipient: "0xffffffffffffffffffffffffffffffffffffffff",
      directHkmnBalanceAtomic: first.directHkmnBalanceAtomic,
      amountAtomic: first.amountAtomic,
      transferSucceeds: true
    })),
    probeRejectedOperation(state, `${scenario.id}:short-recipient-credit`, () => payEntitlement(state, {
      payoutId: state.payout.id,
      index: first.index,
      recipient: first.recipient,
      directHkmnBalanceAtomic: first.directHkmnBalanceAtomic,
      amountAtomic: first.amountAtomic,
      transferSucceeds: true,
      observedHookDebitAtomic: first.amountAtomic,
      observedRecipientCreditAtomic: first.amountAtomic > 1n ? first.amountAtomic - 1n : 0n
    })),
    probeRejectedOperation(state, `${scenario.id}:failed-recipient-transfer`, () => payEntitlement(state, {
      payoutId: state.payout.id,
      index: first.index,
      recipient: first.recipient,
      directHkmnBalanceAtomic: first.directHkmnBalanceAtomic,
      amountAtomic: first.amountAtomic,
      transferSucceeds: false
    }))
  ];
  return maximumBigInt(probes.map((probe) => probe.usdgAtomic));
}

function probePayoutReplay(state, scenario, payoutRequest) {
  if (!state.payout) return 0n;
  const probes = [
    probeRejectedOperation(state, `${scenario.id}:payout-id-replay`, () => fundPayout(state, payoutRequest)),
    probeRejectedOperation(state, `${scenario.id}:proceeds-key-replay`, () => fundPayout(state, {
      ...payoutRequest,
      payoutId: `${payoutRequest.payoutId}-alternate`
    }))
  ];
  return maximumBigInt(probes.map((probe) => probe.usdgAtomic));
}

function leaf(index, recipientSuffix, amountAtomic) {
  return {
    index,
    recipient: `0x${recipientSuffix.padStart(40, "0")}`,
    directHkmnBalanceAtomic: BigInt(index + 1),
    amountAtomic
  };
}

function payoutRequestForScenario(scenario, externalResult) {
  const digestDigit = scenario.id === "best" ? "1" : scenario.id === "expected" ? "2" : "3";
  const manifestDigest = `0x${digestDigit.repeat(64)}`;
  return {
    cycleId: scenario.cycleId,
    payoutId: scenario.payoutId,
    proceedsAttributionKey: externalResult.proceedsAttributionKey,
    operationsTrigger: MODELED_OPERATIONS_IDENTITY,
    payerIdentity: "IMMUTABLE_PEG_CYCLE_VAULT",
    ownerApprovedManifest: true,
    manifestDigest,
    rootHash: `0x${digestDigit.repeat(63)}a`,
    fetchedPublicationDigests: [manifestDigest, manifestDigest],
    entries: scenario.payoutEntries
  };
}

function runScenario(scenario) {
  const state = freshState();
  const fee = accrueCanonicalFee(state, scenario.executedQuoteAtomic);
  invariant(openPegCycle(state, {
    cycleId: scenario.cycleId,
    amountAtomic: scenario.processFundingAtomic,
    callerIdentity: MODELED_OPERATIONS_IDENTITY
  }), `${scenario.id}: valid process release failed`);
  const processFundingGuardMutationAtomic = probeProcessFundingGuards(state, scenario);

  const externalResult = runExternalLedger(state, scenario);
  const externalGuardMutation = probeExternalGuards(state, scenario);
  let invalidPaymentMutationAtomic = 0n;
  let invalidPayoutFundingMutationAtomic = 0n;
  let payoutReplayMutationAtomic = 0n;

  if (externalResult.payoutEligible) {
    const payoutRequest = payoutRequestForScenario(scenario, externalResult);
    invalidPayoutFundingMutationAtomic = probeInvalidPayoutFunding(state, scenario, payoutRequest);
    invariant(fundPayout(state, payoutRequest), `${scenario.id}: valid payout funding failed`);
    invalidPaymentMutationAtomic = probeInvalidPayments(state, scenario);

    const successful = new Set(scenario.successfulPaymentIndices);
    const failed = new Set(scenario.failedPaymentIndices);
    invariant(successful.size === scenario.successfulPaymentIndices.length, `${scenario.id}: duplicate success index`);
    invariant(failed.size === scenario.failedPaymentIndices.length, `${scenario.id}: duplicate failure index`);
    for (const index of successful) {
      invariant(!failed.has(index), `${scenario.id}: payment index is both successful and failed`);
      const entry = scenario.payoutEntries.find((candidate) => candidate.index === index);
      invariant(entry, `${scenario.id}: successful payment index is absent`);
      invariant(payEntitlement(state, {
        payoutId: scenario.payoutId,
        ...entry,
        transferSucceeds: true
      }), `${scenario.id}: valid entitlement payment failed`);
    }
    for (const index of failed) {
      invariant(!successful.has(index), `${scenario.id}: payment index is both successful and failed`);
      const entry = scenario.payoutEntries.find((candidate) => candidate.index === index);
      invariant(entry, `${scenario.id}: failed payment index is absent`);
      const failureProbe = probeRejectedOperation(state, `${scenario.id}:listed-transfer-failure`, () => payEntitlement(state, {
        payoutId: scenario.payoutId,
        ...entry,
        transferSucceeds: false
      }));
      invalidPaymentMutationAtomic = maximumBigInt([invalidPaymentMutationAtomic, failureProbe.usdgAtomic]);
    }

    const firstPaid = scenario.payoutEntries.find((entry) => successful.has(entry.index));
    if (firstPaid) {
      const duplicateProbe = probeRejectedOperation(state, `${scenario.id}:paid-key-replay`, () => payEntitlement(state, {
        payoutId: scenario.payoutId,
        ...firstPaid,
        transferSucceeds: true
      }));
      invalidPaymentMutationAtomic = maximumBigInt([invalidPaymentMutationAtomic, duplicateProbe.usdgAtomic]);
    }
    payoutReplayMutationAtomic = probePayoutReplay(state, scenario, payoutRequest);
  } else {
    invariant(scenario.payoutEntries.length === 0, `${scenario.id}: nonpaying cycle cannot define a payout`);
  }

  checkpoint(state, "scenario-final");
  const recordedLiabilities = totalLiabilities(state);
  const payout = state.payout ?? { fundedAtomic: 0n, paidAtomic: 0n, unpaidAtomic: 0n, entries: [] };
  const commitmentAboveReturn = payout.fundedAtomic > externalResult.pegCycleVaultUsdgCreditAtomic
    ? payout.fundedAtomic - externalResult.pegCycleVaultUsdgCreditAtomic
    : 0n;

  return {
    id: scenario.id,
    classification: scenario.classification,
    inputs: {
      executedQuoteAtomic: scenario.executedQuoteAtomic,
      operationsTrigger: MODELED_OPERATIONS_IDENTITY,
      authorizedPrincipalAtomic: scenario.authorizedPrincipalAtomic,
      processFundingAtomic: scenario.processFundingAtomic,
      externalLedger: scenario.externalLedger,
      payoutEntries: scenario.payoutEntries,
      successfulPaymentIndices: scenario.successfulPaymentIndices,
      failedPaymentIndices: scenario.failedPaymentIndices
    },
    outcomes: {
      fee,
      externalLedgerClosed: externalResult.externalLedgerClosed,
      cycleCompleted: externalResult.completed,
      payoutCreated: Boolean(state.payout),
      pegCycleVaultUsdgDebitAtomic: externalResult.pegCycleVaultUsdgDebitAtomic,
      actualReturnedUsdgCreditAtomic: externalResult.pegCycleVaultUsdgCreditAtomic,
      operationsProcessPrincipalExposureAtomicUSDG: 0n,
      operationsReturnedProceedsExposureAtomicUSDG: 0n,
      operationsUsdgBalanceAtomicUSDG: state.operationsUsdgBalance,
      pegCycleVaultUsdgBalanceAtomicUSDG: state.pegCycleVaultUsdgBalance,
      externalPrincipalLossAtomic: externalResult.externalPrincipalLossAtomic,
      unresolvedExternalPrincipalAtomic: externalResult.unresolvedExternalPrincipalAtomic,
      payoutFundedAtomic: payout.fundedAtomic,
      payoutPaidAtomic: payout.paidAtomic,
      payoutUnpaidAtomic: payout.unpaidAtomic,
      unpaidEntitlementCount: payout.entries.length - state.paidKeys.size,
      paidRecipientTotalAtomic: totalRecipientCredits(state),
      hookUsdgBalanceAtomic: state.hookUsdgBalance,
      recordedLiabilitiesAtomic: recordedLiabilities,
      solvencyHeadroomAtomic: state.hookUsdgBalance - recordedLiabilities,
      minimumSolvencyHeadroomAtomic: state.minimumSolvencyHeadroomAtomic,
      feeConservationErrorAtomic: fee.total - fee.programmable - fee.treasury - fee.process,
      payoutUnderfundingAtomic: maximumBigInt([
        absolute(payout.unpaidAtomic - state.liabilities.payouts),
        invalidPayoutFundingMutationAtomic
      ]),
      commitmentAboveActualReturnedAtomic: commitmentAboveReturn,
      duplicateMisdirectedOrShortPaymentAtomic: invalidPaymentMutationAtomic,
      rejectedCooperativeRunnerActionMutationByAsset: externalGuardMutation,
      processFundingReplayMutationAtomic: processFundingGuardMutationAtomic,
      payoutReplayMutationAtomic,
      consumedProceedsKeyCount: state.consumedProceedsKeys.size,
      actionSequence: state.actionSequence,
      rejectionCount: state.rejectedOperations.length
    }
  };
}

function successfulExternalLedger(id, values) {
  return {
    outcome: "FINALIZED_RETURN",
    outbound: {
      kind: "outbound",
      sourceAsset: "ROBINHOOD_USDG",
      destinationAsset: "SOLANA_CIRCLE_COIN",
      spendAtomic: 100_000_000n,
      spendCapAtomic: 100_000_000n,
      creditAtomic: values.solanaCreditAtomic,
      ownerAuthorized: true,
      authorizationKey: `${id}:outbound-authorization`,
      receiptKey: `${id}:outbound-receipt`
    },
    pack: {
      kind: "pack",
      sourceAsset: "SOLANA_CIRCLE_COIN",
      destinationAsset: null,
      spendAtomic: 50_000_000n,
      spendCapAtomic: 50_000_000n,
      creditAtomic: 0n,
      ownerAuthorized: true,
      authorizationKey: `${id}:pack-authorization`,
      receiptKey: `${id}:pack-receipt`
    },
    open: {
      kind: "open",
      nftMint: `${id}-awarded-nft-mint`,
      ownerAuthorized: true,
      authorizationKey: `${id}:open-authorization`
    },
    buyback: {
      kind: "buyback",
      nftMint: `${id}-awarded-nft-mint`,
      refundAtomic: values.buybackCreditAtomic,
      minimumReceiveAtomic: values.buybackCreditAtomic,
      ownerAuthorized: true,
      authorizationKey: `${id}:buyback-authorization`,
      receiptKey: `${id}:buyback-receipt`
    },
    return: {
      kind: "return",
      sourceAsset: "SOLANA_CIRCLE_COIN",
      destinationAsset: "ROBINHOOD_USDG",
      spendAtomic: values.returnCircleCoinDebitAtomic,
      spendCapAtomic: values.returnCircleCoinDebitAtomic,
      creditAtomic: values.actualReturnedUsdgAtomic,
      ownerAuthorized: true,
      authorizationKey: `${id}:return-authorization`,
      receiptKey: `${id}:return-receipt`
    }
  };
}

const scenarios = [
  {
    id: "best",
    classification: "best",
    cycleId: "cycle-best",
    payoutId: "payout-best",
    executedQuoteAtomic: 4_000_000_000n,
    authorizedPrincipalAtomic: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
    processFundingAtomic: 100_000_000n,
    externalLedger: successfulExternalLedger("best", {
      solanaCreditAtomic: 100_000_000n,
      buybackCreditAtomic: 50_000_000n,
      returnCircleCoinDebitAtomic: 100_000_000n,
      actualReturnedUsdgAtomic: 100_000_000n
    }),
    payoutEntries: [leaf(0, "101", 60_000_000n), leaf(1, "102", 40_000_000n)],
    successfulPaymentIndices: [0, 1],
    failedPaymentIndices: []
  },
  {
    id: "expected",
    classification: "expected",
    cycleId: "cycle-expected",
    payoutId: "payout-expected",
    executedQuoteAtomic: 4_000_009_999n,
    authorizedPrincipalAtomic: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
    processFundingAtomic: 100_000_000n,
    externalLedger: successfulExternalLedger("expected", {
      solanaCreditAtomic: 99_000_000n,
      buybackCreditAtomic: 21_000_000n,
      returnCircleCoinDebitAtomic: 70_000_000n,
      actualReturnedUsdgAtomic: 70_000_000n
    }),
    payoutEntries: [leaf(0, "201", 40_000_000n), leaf(1, "202", 20_000_000n), leaf(2, "203", 10_000_000n)],
    successfulPaymentIndices: [0, 1],
    failedPaymentIndices: [2]
  },
  {
    id: "worst",
    classification: "worst",
    cycleId: "cycle-worst",
    payoutId: "payout-worst-unused",
    executedQuoteAtomic: 4_000_000_000n,
    authorizedPrincipalAtomic: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
    processFundingAtomic: 100_000_000n,
    externalLedger: {
      outcome: "TERMINAL_PRINCIPAL_LOSS",
      terminalLossEvidence: true,
      outbound: {
        kind: "outbound",
        sourceAsset: "ROBINHOOD_USDG",
        destinationAsset: null,
        spendAtomic: 100_000_000n,
        spendCapAtomic: 100_000_000n,
        creditAtomic: 0n,
        ownerAuthorized: true,
        authorizationKey: "worst:outbound-authorization",
        receiptKey: "worst:terminal-loss-receipt"
      }
    },
    payoutEntries: [],
    successfulPaymentIndices: [],
    failedPaymentIndices: []
  }
];

const backlogBoundaryScenario = {
  id: "backlog-boundary",
  classification: "stress",
  cycleId: "cycle-backlog-boundary",
  payoutId: "payout-backlog-boundary",
  executedQuoteAtomic: 4_000_000_000n,
  authorizedPrincipalAtomic: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
  processFundingAtomic: 100_000_000n,
  externalLedger: successfulExternalLedger("backlog-boundary", {
    solanaCreditAtomic: 50_000_000n,
    buybackCreditAtomic: 1_024n,
    returnCircleCoinDebitAtomic: 1_024n,
    actualReturnedUsdgAtomic: 1_024n
  }),
  payoutEntries: Array.from({ length: TREE_POSITIONS }, (_, index) => leaf(index, (10_000 + index).toString(), 1n)),
  successfulPaymentIndices: [],
  failedPaymentIndices: Array.from({ length: TREE_POSITIONS }, (_, index) => index)
};

function runCompromisedOperationsCase() {
  const state = freshState();
  const fee = accrueCanonicalFee(state, COMPROMISED_OPERATIONS_ACCRUAL_QUOTE_ATOMIC);
  const accruedProcessLiability = state.liabilities.process;
  invariant(
    accruedProcessLiability > ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
    "compromised Operations trigger case must exceed the cooperative runner cycle cap"
  );
  const releaseAccepted = openPegCycle(state, {
    cycleId: "cycle-compromised-current-operations",
    amountAtomic: accruedProcessLiability,
    callerIdentity: MODELED_OPERATIONS_IDENTITY
  });
  invariant(releaseAccepted, "current Operations could not trigger the exact authorized vault funding");
  invariant(
    state.pegCycleVaultUsdgBalance === accruedProcessLiability
      && state.operationsUsdgBalance === 0n,
    "compromised Operations trigger changed the immutable vault destination"
  );

  return {
    id: "compromised-current-operations-trigger-zero-custody",
    classification: "adversarial",
    threat: "CURRENT_OPERATIONS_CREDENTIAL_COMPROMISE",
    inputs: {
      executedQuoteAtomic: COMPROMISED_OPERATIONS_ACCRUAL_QUOTE_ATOMIC,
      currentOperationsIdentity: MODELED_OPERATIONS_IDENTITY,
      releaseAuthority: "TRIGGER_ONLY_EXACT_AUTHORIZATION",
      cooperativeRunnerCyclePrincipalCapAtomicUSDG: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
      requestedReleaseAtomicUSDG: accruedProcessLiability
    },
    outcomes: {
      fee,
      releaseAccepted,
      accruedProcessLiabilityBeforeReleaseAtomicUSDG: accruedProcessLiability,
      fundedToPegCycleVaultAtomicUSDG: state.pegCycleVaultUsdgBalance,
      operationsUsdgBalanceAtomicUSDG: state.operationsUsdgBalance,
      operationsProcessPrincipalExposureAtomicUSDG: 0n,
      operationsReturnedProceedsExposureAtomicUSDG: 0n,
      potentialOperationsCustodyLossAtomicUSDG: 0n,
      exceedsCooperativeRunnerCycleCapAtomicUSDG:
        state.pegCycleVaultUsdgBalance - ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
      remainingProcessLiabilityAtomicUSDG: state.liabilities.process,
      exposureRule: "IMMUTABLE_VAULT_DESTINATION_AND_RETURN"
    }
  };
}

function buildBoundComparisons(aggregate) {
  const observed = {
    maximumFeeConservationErrorAtomicUSDG: aggregate.maximumFeeConservationErrorAtomicUSDG,
    maximumRecordedLiabilityLossAtomicUSDG: aggregate.maximumRecordedLiabilityLossAtomicUSDG,
    maximumPayoutUnderfundingAtomicUSDG: aggregate.maximumPayoutUnderfundingAtomicUSDG,
    maximumCommitmentAboveActualReturnedAtomicUSDG: aggregate.maximumCommitmentAboveActualReturnedAtomicUSDG,
    maximumDuplicateMisdirectedOrShortHolderPaymentAtomicUSDG: aggregate.maximumDuplicateMisdirectedOrShortHolderPaymentAtomicUSDG,
    maximumRejectedCooperativeRunnerRobinhoodUSDGActionMutationAtomicUSDG: aggregate.maximumRejectedCooperativeRunnerRobinhoodUSDGActionMutationAtomicUSDG,
    maximumRejectedCooperativeRunnerSolanaCircleCoinActionMutationAtomic: aggregate.maximumRejectedCooperativeRunnerSolanaCircleCoinActionMutationAtomic,
    maximumRejectedCooperativeRunnerNftActionMutationCount: aggregate.maximumRejectedCooperativeRunnerNftActionMutationCount,
    minimumNoNewInflowRunwaySeconds: aggregate.minimumNoNewInflowRunwaySeconds,
    maximumUnpaidEntitlementsInTheSinglePhaseOnePayout: aggregate.maximumUnpaidEntitlementsInTheSinglePhaseOnePayout,
    maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG:
      aggregate.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG
  };
  const comparisons = {};
  for (const [key, value] of Object.entries(observed)) {
    const candidate = MODEL_CANDIDATE_BOUNDS[key];
    const isMinimum = key.startsWith("minimum");
    comparisons[key] = {
      observed: value,
      candidateBound: candidate,
      operator: isMinimum ? ">=" : "<=",
      passes: isMinimum ? value >= candidate : value <= candidate
    };
  }
  return {
    scope: "COOPERATIVE_SEPARATELY_AUTHORIZED_RUNNER_ACTIONS_ONLY",
    excludedThreats: UNRESOLVED_EXTERNAL_COMPROMISE_CLASSES.map((riskClass) => `${riskClass.toUpperCase()}_COMPROMISE`),
    comparisons,
    withinCooperativeCandidateBounds: Object.values(comparisons).every((comparison) => comparison.passes)
  };
}

function buildResults() {
  const scenarioResults = scenarios.map(runScenario);
  const backlogBoundary = runScenario(backlogBoundaryScenario);
  const compromisedOperations = runCompromisedOperationsCase();
  const all = [...scenarioResults, backlogBoundary];
  const maximum = (selector) => maximumBigInt(all.map(selector));
  const aggregate = {
    printedScenarioOrder: ["best", "expected", "worst"],
    maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG:
      maximum((item) => item.outcomes.externalPrincipalLossAtomic),
    maximumModeledCompromisedOperationsCustodyExposureAtomicUSDG:
      compromisedOperations.outcomes.potentialOperationsCustodyLossAtomicUSDG,
    systemwideCompromisedOperationsCustodyLossUpperBoundAtomicUSDG: 0n,
    compromisedOperationsExposureRule: "IMMUTABLE_VAULT_DESTINATION_AND_RETURN",
    maximumFeeConservationErrorAtomicUSDG: maximum((item) => absolute(item.outcomes.feeConservationErrorAtomic)),
    maximumRecordedLiabilityLossAtomicUSDG: maximum((item) => {
      const deficit = item.outcomes.recordedLiabilitiesAtomic - item.outcomes.hookUsdgBalanceAtomic;
      return deficit > 0n ? deficit : 0n;
    }),
    maximumPayoutUnderfundingAtomicUSDG: maximum((item) => item.outcomes.payoutUnderfundingAtomic),
    maximumCommitmentAboveActualReturnedAtomicUSDG: maximum((item) => item.outcomes.commitmentAboveActualReturnedAtomic),
    maximumDuplicateMisdirectedOrShortHolderPaymentAtomicUSDG: maximum((item) => item.outcomes.duplicateMisdirectedOrShortPaymentAtomic),
    maximumRejectedCooperativeRunnerRobinhoodUSDGActionMutationAtomicUSDG:
      maximum((item) => item.outcomes.rejectedCooperativeRunnerActionMutationByAsset.robinhoodUsdgAtomic),
    maximumRejectedCooperativeRunnerSolanaCircleCoinActionMutationAtomic:
      maximum((item) => item.outcomes.rejectedCooperativeRunnerActionMutationByAsset.solanaCircleCoinAtomic),
    maximumRejectedCooperativeRunnerNftActionMutationCount:
      maximum((item) => item.outcomes.rejectedCooperativeRunnerActionMutationByAsset.nftCount),
    maximumUnpaidEntitlementsInTheSinglePhaseOnePayout: maximum((item) => BigInt(item.outcomes.unpaidEntitlementCount)),
    minimumSolvencyHeadroomAtomicUSDG: all.reduce((value, item) => {
      const next = item.outcomes.minimumSolvencyHeadroomAtomic;
      return next < value ? next : value;
    }, all[0].outcomes.minimumSolvencyHeadroomAtomic),
    minimumNoNewInflowRunwaySeconds: 0n,
    runwayEvidenceKind: "DECLARED_PHASE_SCOPE_NOT_A_TIME_SERIES_RESULT",
    modelInstanceScope: "ONE_CYCLE_AND_ITS_PAYOUT_WITHOUT_LIMITING_LATER_IDENTICAL_V1_CYCLES"
  };
  const boundComparison = buildBoundComparisons(aggregate);

  return {
    schemaVersion: "hookemon.feasibility-model-results.v5",
    productPhase: 1,
    requirementsRevision: 56,
    architectureRevision: 4,
    purpose: "Deterministic nominal-atomic-unit survivability model for one thin-V1 end-to-end cycle",
    authorityBoundary: {
      illustrativePrincipalAtomic: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
      cooperativeRunnerCyclePrincipalCapAtomicUSDG: ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC,
      capScope: "SEPARATELY_AUTHORIZED_COOPERATIVE_RUNNER_CYCLE_ONLY",
      status: "OWNER_REAPPROVAL_REQUIRED_AFTER_EXPOSURE_CORRECTION",
      statement: "The cooperative runner cap is not an onchain system-wide loss bound. Operations custody is zero by construction, while provider, authorizer, route-executor, bridge, and policy-wallet risks remain unresolved. The model does not authorize signing, broadcast, deployment, provider mutation, asset movement, or spending."
    },
    numericBasis: {
      robinhoodAsset: "USDG",
      solanaAsset: "Circle USD Coin",
      crossAssetRule: "No exchange rate or atomic-unit equality is assumed; the model records each finalized asset delta independently.",
      stableAssetDecimals: 6,
      feeBasisPoints: {
        total: TOTAL_FEE_BPS,
        programmable: PROGRAMMABLE_BPS,
        treasury: TREASURY_BPS,
        process: "total minus rounded Programmable and treasury liabilities"
      },
      payoutTreeDepth: TREE_DEPTH,
      maximumPayoutPositions: TREE_POSITIONS
    },
    canonicalMarketProof: buildCanonicalMarketProof(),
    scenarios: scenarioResults,
    stressCases: [backlogBoundary],
    adversarialCases: [compromisedOperations],
    unresolvedCompromiseClasses: Object.fromEntries(UNRESOLVED_EXTERNAL_COMPROMISE_CLASSES.map((riskClass) => [
      riskClass,
      {
        status: "UNRESOLVED_NONZERO",
        modeledLowerBoundAtomicUSDG: null,
        systemwideLossUpperBoundAtomicUSDG: null
      }
    ])),
    aggregate,
    candidateBoundComparison: boundComparison,
    lossAbsorbers: [
      { loss: "fee rounding error", absorber: "The process liability receives only totalFee minus the two independently rounded liabilities." },
      { loss: "recorded hook liability", absorber: "Segregated liabilities and exact atomic state transitions keep every recorded liability fully backed." },
      { loss: "cooperative runner cycle principal", absorber: "A separately authorized runner action cap limits only the cooperative action bundle; it is not enforced by the hook." },
      { loss: "compromised current Operations custody", absorber: "The immutable vault destination and vault-to-hook payout path keep Operations process-principal and returned-proceeds custody exposure at exactly zero." },
      { loss: "provider, authorizer, route-executor, bridge, or policy-wallet compromise", absorber: "No numeric upper bound is claimed before exact live bindings. These risks remain separate unresolved nonzero classes." },
      { loss: "payout underfunding or commitment above return", absorber: "Payout funding atomically consumes one cycle-bound proceeds key and exactly the independently observed final PegCycleVault USDG credit." },
      { loss: "duplicate, redirected, or short holder payment", absorber: "Structured recipient-bound leaves and one payout-and-index paid key reject real adversarial calls without mutation." },
      { loss: "rejected or replayed cooperative runner action", absorber: "Each cooperative runner action checks its asset-specific cap and consumes its exact authorization and receipt once; this does not bound unresolved provider or custody-component compromise." },
      { loss: "failed recipient transfer backlog", absorber: "Every failed leaf stays fully funded and independently payable through the same non-expiring permissionless path." }
    ],
    excludedFromModel: [
      "token price or market demand",
      "expected profitability or recurring pack economics",
      "long-term runway or reserve policy",
      "route discovery, quote reliability, or automatic retry queues",
      "USDG or Circle USD Coin price deviation, issuer action, or chain liveness",
      "native-gas conversion to USDG; exact per-asset gas caps bind only after provider selection",
      "cryptographic Merkle proof construction and publication transport; those require independent implementation spikes",
      "runtime bytecode, initcode, and payment gas headroom; those require implementation and official limits",
      "Phase 2 automation, recipient replacement, or any system-wide payout-count policy"
    ]
  };
}

function verifyBoundsFile(results, boundsPath) {
  const bounds = JSON.parse(fs.readFileSync(boundsPath, "utf8"));
  invariant(
    hasExactKeys(bounds, SURVIVABILITY_BOUNDS_ROOT_KEYS),
    `${boundsPath}: survivability bounds must use the exact corrected root schema`
  );
  invariant(bounds.schemaVersion === "hookemon.owner-survivability-bounds.v5", `${boundsPath}: unsupported bounds schema`);
  invariant(bounds.productPhase === 1, `${boundsPath}: bounds must remain scoped to product Phase 1`);
  invariant(bounds.requirementsRevision === results.requirementsRevision, `${boundsPath}: requirements revision differs`);
  invariant(bounds.architectureRevision === results.architectureRevision, `${boundsPath}: architecture revision differs`);
  invariant(
    bounds.approvalState === CORRECTED_BOUNDS_APPROVAL_STATE,
    `${boundsPath}: bounds approval state must require corrected-scope owner reapproval`
  );
  invariant(
    bounds.scope === CORRECTED_BOUNDS_SCOPE,
    `${boundsPath}: bounds scope must match the corrected current authority scope`
  );
  invariant(
    hasExactKeys(bounds.measurementBasis, MEASUREMENT_BASIS_KEYS),
    `${boundsPath}: measurement basis must use the exact schema`
  );
  invariant(
    hasExactKeys(bounds.immutableMarketBounds, IMMUTABLE_MARKET_BOUNDS_KEYS),
    `${boundsPath}: immutable market bounds must use the exact schema`
  );
  invariant(
    bounds.immutableMarketBounds.staticLpFeeBasisPoints === STATIC_LP_FEE
      && bounds.immutableMarketBounds.additionalTradingFeeBasisPoints === 0
      && bounds.immutableMarketBounds.inclusiveHookFeeBasisPoints === Number(TOTAL_FEE_BPS)
      && bounds.immutableMarketBounds.launchAllocationBasisPoints === LAUNCH_ALLOCATION_BPS
      && bounds.immutableMarketBounds.maximumProjectControllableLaunchPositions === 0,
    `${boundsPath}: immutable market bounds differ from the modeled constants`
  );
  invariant(
    hasExactKeys(bounds.ownerApprovalRequest, OWNER_APPROVAL_REQUEST_KEYS),
    `${boundsPath}: owner approval request must use the exact authority schema`
  );
  invariant(
    bounds.ownerApprovalRequest.pending === true,
    `${boundsPath}: corrected bounds owner approval request must remain pending`
  );
  invariant(
    bounds.ownerApprovalRequest.notAnActionAuthorization === true,
    `${boundsPath}: owner approval request must remain separate from action authorization`
  );
  invariant(
    hasExactKeys(bounds.ownerApprovalRequest.numbers, OWNER_APPROVAL_NUMBER_KEYS),
    `${boundsPath}: owner approval numbers must use the exact corrected key set`
  );
  invariant(
    BigInt(bounds.ownerApprovalRequest.numbers.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG)
        === ILLUSTRATIVE_LIVE_PRINCIPAL_ATOMIC
      && BigInt(bounds.ownerApprovalRequest.numbers.minimumNoNewInflowRunwaySeconds) === 0n
      && BigInt(bounds.ownerApprovalRequest.numbers.maximumUnpaidEntitlementsInTheSinglePhaseOnePayout)
        === BigInt(TREE_POSITIONS)
      && BigInt(bounds.ownerApprovalRequest.numbers.allListedConservationAndRejectedCooperativeRunnerMutationBounds)
        === 0n,
    `${boundsPath}: owner approval numbers differ from the corrected modeled candidates`
  );
  invariant(
    hasExactKeys(bounds.candidateBounds, Object.keys(MODEL_CANDIDATE_BOUNDS)),
    `${boundsPath}: candidate bounds must use the exact corrected key set`
  );
  for (const [key, expected] of Object.entries(MODEL_CANDIDATE_BOUNDS)) {
    const entry = bounds.candidateBounds[key];
    const expectedKeys = key === "minimumNoNewInflowRunwaySeconds"
      ? RUNWAY_BOUND_KEYS
      : key === "maximumUnpaidEntitlementsInTheSinglePhaseOnePayout"
        ? UNPAID_ENTITLEMENT_BOUND_KEYS
        : key === "maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG"
          ? COOPERATIVE_RUNNER_CAP_KEYS
          : DEFAULT_CANDIDATE_BOUND_KEYS;
    invariant(
      hasExactKeys(entry, expectedKeys),
      key === "maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG"
        ? `${boundsPath}: cooperative runner cap must use the exact authority schema`
        : `${boundsPath}: candidate bound ${key} must use the exact nested schema`
    );
    invariant(BigInt(entry.value) === expected, `${boundsPath}: ${key} differs from the modeled candidate`);
  }
  const cooperativeRunnerCap =
    bounds.candidateBounds.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG;
  invariant(
    hasExactKeys(cooperativeRunnerCap, COOPERATIVE_RUNNER_CAP_KEYS),
    `${boundsPath}: cooperative runner cap must use the exact authority schema`
  );
  invariant(
    cooperativeRunnerCap.status === COOPERATIVE_RUNNER_CAP_STATUS,
    `${boundsPath}: cooperative runner cap must require corrected-scope owner reapproval`
  );
  invariant(
    cooperativeRunnerCap.scope === COOPERATIVE_RUNNER_CAP_SCOPE,
    `${boundsPath}: cooperative runner cap has invalid authority scope`
  );
  invariant(
    cooperativeRunnerCap.display === COOPERATIVE_RUNNER_CAP_DISPLAY
      && cooperativeRunnerCap.absorber === COOPERATIVE_RUNNER_CAP_ABSORBER,
    `${boundsPath}: cooperative runner cap must retain the corrected authority explanation`
  );
  const compromised = results.adversarialCases.find(
    (scenario) => scenario.id === "compromised-current-operations-trigger-zero-custody"
  );
  invariant(compromised, `${boundsPath}: compromised Operations case is missing`);
  invariant(
    hasExactKeys(
      bounds.currentOperationsCompromiseExposure,
      CURRENT_OPERATIONS_COMPROMISE_EXPOSURE_KEYS
    ),
    `${boundsPath}: compromised Operations exposure must use the exact authority schema`
  );
  invariant(
    bounds.currentOperationsCompromiseExposure.threat === OPERATIONS_COMPROMISE_THREAT
      && bounds.currentOperationsCompromiseExposure.status === OPERATIONS_COMPROMISE_STATUS,
    `${boundsPath}: compromised Operations status must declare zero custody by construction`
  );
  invariant(
    bounds.currentOperationsCompromiseExposure.maximumReleaseRule === OPERATIONS_COMPROMISE_RELEASE_RULE,
    `${boundsPath}: compromised Operations trigger must retain the immutable vault destination rule`
  );
  invariant(
    BigInt(bounds.currentOperationsCompromiseExposure.processPrincipalExposureAtomicUSDG) === 0n
      && BigInt(bounds.currentOperationsCompromiseExposure.returnedProceedsExposureAtomicUSDG) === 0n
      && BigInt(bounds.currentOperationsCompromiseExposure.systemwideCustodyLossUpperBoundAtomicUSDG) === 0n,
    `${boundsPath}: compromised Operations custody exposure must remain exactly zero`
  );
  invariant(
    BigInt(bounds.currentOperationsCompromiseExposure.modelObservedExposureAtomicUSDG)
      === compromised.outcomes.potentialOperationsCustodyLossAtomicUSDG,
    `${boundsPath}: compromised Operations observed exposure differs from the model`
  );
  invariant(
    bounds.currentOperationsCompromiseExposure.modelObservedDisplay === OPERATIONS_COMPROMISE_DISPLAY
      && bounds.currentOperationsCompromiseExposure.absorber === OPERATIONS_COMPROMISE_ABSORBER,
    `${boundsPath}: compromised Operations exposure must retain the immutable custody explanation`
  );
  invariant(
    hasExactKeys(bounds.unresolvedExternalCompromiseExposure, UNRESOLVED_EXTERNAL_COMPROMISE_CLASSES),
    `${boundsPath}: unresolved external compromise classes must use the exact key set`
  );
  for (const riskClass of UNRESOLVED_EXTERNAL_COMPROMISE_CLASSES) {
    const exposure = bounds.unresolvedExternalCompromiseExposure[riskClass];
    invariant(
      hasExactKeys(exposure, UNRESOLVED_EXTERNAL_EXPOSURE_KEYS),
      `${boundsPath}: ${riskClass} compromise exposure must use the exact schema`
    );
    invariant(
      exposure.status === "UNRESOLVED_NONZERO"
        && exposure.modeledLowerBoundAtomicUSDG === null
        && exposure.systemwideLossUpperBoundAtomicUSDG === null
        && typeof exposure.reason === "string"
        && exposure.reason.length > 0,
      `${boundsPath}: ${riskClass} compromise exposure must remain unresolved and nonzero`
    );
  }
  invariant(
    hasExactKeys(bounds.releaseBoundNumericCaps, RELEASE_BOUND_NUMERIC_CAP_KEYS),
    `${boundsPath}: release-bound numeric caps must use the exact pending schema`
  );
  invariant(
    bounds.releaseBoundNumericCaps.status === RELEASE_BOUND_NUMERIC_CAP_STATUS,
    `${boundsPath}: release-bound numeric caps must remain pending provider binding`
  );
  invariant(
    JSON.stringify(bounds.releaseBoundNumericCaps.requiredBeforeLiveAction)
        === JSON.stringify(RELEASE_BOUND_REQUIRED_ACTION_CAPS)
      && bounds.releaseBoundNumericCaps.rule === RELEASE_BOUND_RULE,
    `${boundsPath}: release-bound numeric caps differ from the exact pending requirements`
  );
  invariant(
    hasExactKeys(bounds.modelComparison, MODEL_COMPARISON_KEYS)
      && bounds.modelComparison.command === MODEL_COMPARISON_COMMAND
      && bounds.modelComparison.source === MODEL_COMPARISON_SOURCE
      && bounds.modelComparison.candidateResult === MODEL_COMPARISON_RESULT
      && bounds.modelComparison.authority === MODEL_COMPARISON_AUTHORITY,
    `${boundsPath}: model comparison must remain non-authoritative`
  );
  invariant(
    bounds.modelEvidence === "feasibility/model-results.json",
    `${boundsPath}: model evidence path must remain fixed`
  );
  invariant(
    results.candidateBoundComparison.withinCooperativeCandidateBounds,
    `${boundsPath}: modeled cooperative worst case exceeds candidate bounds`
  );
}

const results = buildResults();
const serialized = json(results);
const verifyIndex = process.argv.indexOf("--verify");
const verifyBoundsIndex = process.argv.indexOf("--verify-bounds");

if (verifyIndex >= 0) {
  const resultPath = path.resolve(process.argv[verifyIndex + 1] ?? defaultResultPath);
  const existing = fs.readFileSync(resultPath, "utf8");
  invariant(existing === serialized, `${resultPath}: stored model result differs from deterministic execution`);
} else {
  fs.writeFileSync(defaultResultPath, serialized);
}

if (verifyBoundsIndex >= 0) {
  invariant(process.argv[verifyBoundsIndex + 1], "--verify-bounds requires a file path");
  const boundsPath = path.resolve(process.argv[verifyBoundsIndex + 1]);
  verifyBoundsFile(results, boundsPath);
}

const printed = Object.fromEntries(results.scenarios.map((scenario) => [scenario.classification, scenario.outcomes]));
process.stdout.write(json({
  requirementsRevision: results.requirementsRevision,
  scenarios: printed,
  stress: results.stressCases[0].outcomes,
  adversarial: results.adversarialCases[0],
  aggregate: results.aggregate,
  candidateBoundComparison: results.candidateBoundComparison,
  resultFile: defaultResultPath,
  verified: verifyIndex >= 0,
  boundsVerified: verifyBoundsIndex >= 0
}));
