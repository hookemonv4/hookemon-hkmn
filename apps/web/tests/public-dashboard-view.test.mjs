import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicCycleProcess,
  dashboardFeedState,
  latestDashboardCards,
  resolveDashboardEnvironment,
} from "../lib/public-dashboard-view.ts";
import * as dashboardView from "../lib/public-dashboard-view.ts";
import { projectPublicCycle } from "../../../packages/domain/src/cycle-status.js";

const TESTNET_NETWORK = {
  ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  solana: {
    name: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    label: "Solana Devnet",
  },
};

test("returns the latest cards newest-first from both API sources", () => {
  assert.deepEqual(
    latestDashboardCards(
      { cards: [{ productId: "old" }, { productId: "new" }] },
      null,
    ).map(({ productId }) => productId),
    ["new", "old"],
  );
  assert.deepEqual(
    latestDashboardCards(
      null,
      { cards: [{ productId: "new" }, { productId: "old" }] },
    ).map(({ productId }) => productId),
    ["new", "old"],
  );
});

const validCycleStatus = {
  schemaVersion: 2,
  profile: "testnet",
  network: TESTNET_NETWORK,
  executionState: "active",
  executionReason: null,
  generatedAt: "2026-08-19T11:00:00.000Z",
  nextCycleAt: "2026-08-19T11:20:00.000Z",
  countdownSeconds: 1_200,
  cycle: {
    cycleId: "cycle-3",
    status: "complete",
    selectedPackId: "pokemon_25",
    maxBoostersPerCycle: 4,
    plannedBoosters: 4,
    openedBoosters: 4,
    actions: [
      { type: "fees-collected", status: "complete", at: "2026-08-19T10:50:00.000Z" },
      { type: "pack-plan-ready", status: "complete", at: "2026-08-19T10:51:00.000Z" },
      { type: "packs-bought", status: "complete", at: "2026-08-19T10:52:00.000Z" },
      { type: "buybacks-settled", status: "complete", at: "2026-08-19T10:53:00.000Z" },
      { type: "return-bridge-finalized", status: "complete", at: "2026-08-19T10:54:00.000Z" },
      { type: "rewards-complete", status: "complete", at: "2026-08-19T10:55:00.000Z" },
    ],
    cards: Array.from({ length: 4 }, (_, index) => ({
      productId: `pokemon-${index}`,
      rarity: "rare",
    })),
    returnedMicroUsdc: "500000",
    rewardStatus: "complete",
    startedAt: "2026-08-19T10:49:00.000Z",
    updatedAt: "2026-08-19T11:00:00.000Z",
    spentMicroUsdc: "700000",
    paidMicroUsdc: "500000",
  },
};

const validCommunitySnapshot = {
  schemaVersion: 2,
  profile: "testnet",
  badge: "TESTNET",
  network: TESTNET_NETWORK,
  historyComplete: true,
  generatedAt: "2026-08-19T11:00:00.000Z",
  nextCycleAt: "2026-08-19T11:20:00.000Z",
  delayed: false,
  poolObservedAt: "2026-08-19T10:59:00.000Z",
  metrics: {
    latestObservedProjectPoolMicroUsdc: "1000000",
    totalCycleFundingMicroUsdc: "900000",
    totalCollectorSpendMicroUsdc: "700000",
    totalBuybacksReturnedMicroUsdc: "500000",
    totalBridgedBackMicroUsdc: "500000",
    totalRewardsPaidMicroUsdc: "500000",
    totalRewardsDeferredMicroUsdc: "0",
    totalQuotedOperatingCostsMicroUsdc: "10000",
    latestRetainedReserveMicroUsdc: "40000",
    latestCycleReserveTargetMicroUsdc: "50000",
    completedCycles: 3,
    skippedCycles: 1,
    openedPacks: 4,
  },
  latestCycle: {
    cycleId: "cycle-3",
    status: "complete",
    reason: null,
    updatedAt: "2026-08-19T11:00:00.000Z",
    paidMicroUsdc: "500000",
    payoutRecipientCount: 2,
    transactions: [],
  },
  cards: [],
};

test("maps the complete fee-to-holder process without color-only state", () => {
  const steps = buildPublicCycleProcess({
    status: validCycleStatus,
    community: validCommunitySnapshot,
  });

  assert.deepEqual(steps.map(({ id, state }) => [id, state]), [
    ["fees", "complete"],
    ["budget", "complete"],
    ["packs", "complete"],
    ["cards", "complete"],
    ["sales", "complete"],
    ["return", "complete"],
    ["holders", "complete"],
  ]);
  assert.ok(steps.every(({ stateLabel }) => stateLabel.length > 0));
  assert.equal(steps.find(({ id }) => id === "cards").amountText, "4 opened");
});

test("keeps missing values unavailable instead of inventing zero", () => {
  const steps = buildPublicCycleProcess({
    status: { ...validCycleStatus, cycle: null },
    community: validCommunitySnapshot,
  });

  assert.ok(steps.every(({ state }) => state === "waiting"));
  assert.ok(steps.every(({ amountText }) => amountText === "Unavailable"));
  assert.ok(steps.every(({ timestamp }) => timestamp === null));
});

test("shows a neutral public pause reason before the first cycle exists", () => {
  const steps = buildPublicCycleProcess({
    status: {
      ...validCycleStatus,
      executionState: "paused",
      executionReason: "operator-paused",
      cycle: null,
    },
    community: validCommunitySnapshot,
  });

  assert.ok(steps.every(({ state }) => state === "paused"));
  assert.ok(steps.every(({ stateLabel }) => stateLabel === "Paused — operator execution is paused"));
  assert.ok(steps.every(({ amountText }) => amountText === "Unavailable"));
});

test("makes pause, skip, deferred reward, mismatch, and stale data explicit", () => {
  const paused = buildPublicCycleProcess({
    status: {
      ...validCycleStatus,
      executionState: "paused",
      executionReason: "operator-paused",
      cycle: {
        ...validCycleStatus.cycle,
        status: "waiting",
        selectedPackId: null,
        plannedBoosters: 0,
        openedBoosters: 0,
        actions: [],
        cards: [],
        returnedMicroUsdc: null,
        rewardStatus: null,
        spentMicroUsdc: null,
        paidMicroUsdc: null,
      },
    },
    community: validCommunitySnapshot,
  });
  assert.ok(paused.every(({ state }) => state === "paused"));
  assert.ok(paused.every(({ stateLabel }) => stateLabel.includes("Paused")));

  const skipped = buildPublicCycleProcess({
    status: {
      ...validCycleStatus,
      cycle: {
        ...validCycleStatus.cycle,
        status: "skipped",
        actions: [validCycleStatus.cycle.actions[0]],
        selectedPackId: null,
        plannedBoosters: 0,
        openedBoosters: 0,
        cards: [],
        returnedMicroUsdc: null,
        rewardStatus: null,
        spentMicroUsdc: null,
        paidMicroUsdc: null,
      },
    },
    community: validCommunitySnapshot,
  });
  assert.deepEqual(skipped.map(({ state }) => state), [
    "complete", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped",
  ]);
  assert.ok(skipped.slice(1).every(({ stateLabel }) => stateLabel.includes("Skipped")));

  const deferred = buildPublicCycleProcess({
    status: {
      ...validCycleStatus,
      cycle: { ...validCycleStatus.cycle, rewardStatus: "payout-deferred", paidMicroUsdc: null },
    },
    community: validCommunitySnapshot,
  });
  assert.equal(deferred.at(-1).state, "deferred");
  assert.match(deferred.at(-1).stateLabel, /Deferred/);

  const failed = buildPublicCycleProcess({
    status: {
      ...validCycleStatus,
      cycle: {
        ...validCycleStatus.cycle,
        actions: validCycleStatus.cycle.actions.map((action) =>
          action.type === "buybacks-settled" ? { ...action, status: "failed" } : action),
      },
    },
    community: validCommunitySnapshot,
  });
  assert.equal(failed.find(({ id }) => id === "sales").state, "failed");
  assert.match(failed.find(({ id }) => id === "sales").stateLabel, /Failed/);

  assert.equal(resolveDashboardEnvironment(
    validCycleStatus,
    { ...validCommunitySnapshot, profile: "mainnet", badge: "MAINNET" },
  ).state, "mismatch");
  assert.equal(dashboardFeedState({
    hasData: true,
    pollFailed: true,
    delayed: false,
    mismatch: false,
  }), "delayed");
  assert.equal(dashboardFeedState({
    hasData: true,
    pollFailed: false,
    delayed: false,
    mismatch: true,
  }), "unavailable");
});

test("resolves verified profiles and deterministic feed states", () => {
  assert.deepEqual(resolveDashboardEnvironment(null, null), { state: "loading", profile: null });
  assert.deepEqual(resolveDashboardEnvironment(validCycleStatus, validCommunitySnapshot), {
    state: "verified",
    profile: "testnet",
  });
  assert.equal(dashboardFeedState({ hasData: false, pollFailed: false, delayed: false, mismatch: false }), "connecting");
  assert.equal(dashboardFeedState({ hasData: true, pollFailed: false, delayed: false, mismatch: false }), "live");
  assert.equal(dashboardFeedState({ hasData: true, pollFailed: false, delayed: true, mismatch: false }), "delayed");
  assert.equal(dashboardFeedState({ hasData: false, pollFailed: true, delayed: false, mismatch: false }), "unavailable");
});

test("gates every dashboard fact behind a verified pair and preserves delayed last-good data", () => {
  assert.equal(typeof dashboardView.resolveDashboardPresentation, "function");
  const resolvePresentation = dashboardView.resolveDashboardPresentation;

  assert.deepEqual(resolvePresentation({
    status: validCycleStatus,
    community: null,
    isLive: true,
    pollFailed: false,
    communityPollFailed: false,
  }), {
    environment: { state: "loading", profile: null },
    feedState: "connecting",
    status: null,
    community: null,
  });

  const verified = resolvePresentation({
    status: validCycleStatus,
    community: validCommunitySnapshot,
    isLive: true,
    pollFailed: false,
    communityPollFailed: false,
  });
  assert.equal(verified.environment.state, "verified");
  assert.equal(verified.feedState, "live");
  assert.equal(verified.status, validCycleStatus);
  assert.equal(verified.community, validCommunitySnapshot);

  const delayed = resolvePresentation({
    status: validCycleStatus,
    community: { ...validCommunitySnapshot, delayed: true },
    isLive: true,
    pollFailed: false,
    communityPollFailed: false,
  });
  assert.equal(delayed.feedState, "delayed");
  assert.equal(delayed.status, validCycleStatus);
  assert.equal(delayed.community?.delayed, true);

  const lastGood = resolvePresentation({
    status: validCycleStatus,
    community: validCommunitySnapshot,
    isLive: true,
    pollFailed: false,
    communityPollFailed: true,
  });
  assert.equal(lastGood.feedState, "delayed");
  assert.equal(lastGood.status, validCycleStatus);
  assert.equal(lastGood.community, validCommunitySnapshot);

  const mismatch = resolvePresentation({
    status: validCycleStatus,
    community: { ...validCommunitySnapshot, profile: "mainnet", badge: "MAINNET" },
    isLive: true,
    pollFailed: false,
    communityPollFailed: false,
  });
  assert.deepEqual(mismatch, {
    environment: { state: "mismatch", profile: null },
    feedState: "unavailable",
    status: null,
    community: null,
  });
});

test("requires a real payout amount and never treats allocations as payments", () => {
  assert.equal(typeof dashboardView.hasLatestPayoutFacts, "function");
  assert.equal(dashboardView.hasLatestPayoutFacts(null), false);
  assert.equal(dashboardView.hasLatestPayoutFacts({
    ...validCommunitySnapshot.latestCycle,
    paidMicroUsdc: null,
    payoutRecipientCount: 0,
  }), false);
  assert.equal(dashboardView.hasLatestPayoutFacts({
    ...validCommunitySnapshot.latestCycle,
    paidMicroUsdc: "0",
    payoutRecipientCount: 0,
  }), true);
  assert.equal(dashboardView.hasLatestPayoutFacts({
    ...validCommunitySnapshot.latestCycle,
    paidMicroUsdc: null,
    payoutRecipientCount: 2,
  }), false);
});

test("renders the real publisher holder payout as an available completed step", () => {
  const status = projectPublicCycle({
    nowMs: Date.parse("2026-08-19T11:00:00.000Z"),
    nextCycleAtMs: Date.parse("2026-08-19T11:20:00.000Z"),
    profile: "testnet",
    executionState: "active",
    record: {
      cycleId: "publisher-cycle",
      status: "complete",
      settlement: {
        status: "reconciled",
        paidThisCycleMicroUsdc: "70000000",
        deferredThisCycleMicroUsdc: "0",
      },
    },
  });

  const holderStep = buildPublicCycleProcess({
    status,
    community: validCommunitySnapshot,
  }).find(({ id }) => id === "holders");
  assert.equal(holderStep.state, "complete");
  assert.equal(holderStep.amountText, "70000000 micro-USDC");
  assert.notEqual(holderStep.amountText, "Unavailable");
});
