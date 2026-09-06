import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublicCycleStatus } from "../lib/public-cycle-status.ts";

const TESTNET_NETWORK = {
  evm: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  solana: {
    name: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    label: "Solana Devnet",
  },
};

const validStatus = {
  schemaVersion: 3,
  profile: "testnet",
  network: TESTNET_NETWORK,
  executionState: "active",
  executionReason: null,
  generatedAt: "2026-08-09T12:00:00.000Z",
  nextCycleAt: "2026-08-09T12:20:00.000Z",
  countdownSeconds: 1_200,
  cycle: {
    cycleId: "cycle-7",
    status: "awaiting-buybacks",
    selectedPackId: "pokemon_25",
    maxBoostersPerCycle: 100,
    plannedBoosters: 100,
    openedBoosters: 1,
    actions: [
      { type: "fees-collected", status: "complete", at: "2026-08-09T11:56:00.000Z" },
      { type: "packs-bought", status: "complete", at: "2026-08-09T11:59:00.000Z" },
    ],
    cards: [{
      productId: "pokemon_25",
      rarity: "Rare",
      nftAddress: "public-address",
      cardName: "Pikachu",
      setName: "Base Set",
      cardNumber: "58/102",
      imageUrl: "https://images.example/pikachu.png",
      packPriceMicroUsdg: "100000000",
      buybackMicroUsdg: "90000000",
    }],
    returnedMicroUsdg: "90000000",
    rewardStatus: "pending",
    roundAccounting: null,
    startedAt: "2026-08-09T11:55:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    spentMicroUsdg: "100000000",
    paidMicroUsdg: "0",
  },
};

test("accepts the exact public cycle contract", () => {
  const result = normalizePublicCycleStatus(validStatus, "testnet");

  assert.deepEqual(result, validStatus);
  assert.notEqual(result, validStatus);
  assert.notEqual(result.cycle, validStatus.cycle);
  assert.throws(
    () => normalizePublicCycleStatus(validStatus, "mainnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("accepts a variable operator cap with an exact latest-card window", () => {
  const cards = Array.from({ length: 60 }, (_, index) => card(`product-${index}`));
  const status = {
    ...validStatus,
    cycle: {
      ...validStatus.cycle,
      maxBoostersPerCycle: 20_000,
      plannedBoosters: 20_000,
      openedBoosters: 20_000,
      cards,
    },
  };

  assert.equal(normalizePublicCycleStatus(status).cycle.cards.length, 60);
});

test("keeps provider count drift visible without blanking the tracker", () => {
  const cards = Array.from({ length: 60 }, (_, index) => card(`product-${index}`));
  const status = {
    ...validStatus,
    cycle: {
      ...validStatus.cycle,
      maxBoostersPerCycle: 100,
      plannedBoosters: 101,
      openedBoosters: 102,
      cards,
    },
  };

  const result = normalizePublicCycleStatus(status);
  assert.equal(result.cycle.plannedBoosters, 101);
  assert.equal(result.cycle.openedBoosters, 102);
});

test("rejects unknown fields instead of forwarding private cycle data", () => {
  assert.throws(
    () => normalizePublicCycleStatus({
      ...validStatus,
      cycle: { ...validStatus.cycle, holders: [{ address: "private" }] },
    }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
  assert.throws(
    () => normalizePublicCycleStatus({ ...validStatus, authorization: "private" }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("rejects malformed money, counts, timestamps, actions and card images", () => {
  const invalidCycles = [
    { ...validStatus.cycle, returnedMicroUsdg: "-1" },
    { ...validStatus.cycle, maxBoostersPerCycle: 0 },
    {
      ...validStatus.cycle,
      plannedBoosters: 61,
      openedBoosters: 61,
      cards: Array.from({ length: 61 }, (_, index) => card(`product-${index}`)),
    },
    { ...validStatus.cycle, actions: [{ type: "fees-collected", status: "secret", at: validStatus.generatedAt }] },
    { ...validStatus.cycle, cards: [{ ...card("pack"), imageUrl: "javascript:alert(1)" }] },
  ];

  for (const cycle of invalidCycles) {
    assert.throws(
      () => normalizePublicCycleStatus({ ...validStatus, cycle }),
      /PUBLIC_CYCLE_STATUS_INVALID/,
    );
  }
  assert.throws(
    () => normalizePublicCycleStatus({ ...validStatus, generatedAt: "not-a-date" }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );

  for (const paidMicroUsdg of [
    "01",
    "",
    1,
    true,
    "+1",
    "-1",
    " 1",
    "1 ",
    "1".repeat(79),
  ]) {
    assert.throws(
      () => normalizePublicCycleStatus({
        ...validStatus,
        cycle: { ...validStatus.cycle, paidMicroUsdg },
      }),
      /PUBLIC_CYCLE_STATUS_INVALID/,
    );
  }
});

test("accepts an explicit idle status and clamps no values", () => {
  const idle = {
    schemaVersion: 3,
    profile: "testnet",
    network: TESTNET_NETWORK,
    executionState: "paused",
    executionReason: "operator-paused",
    generatedAt: "2026-08-09T12:20:00.000Z",
    nextCycleAt: "2026-08-09T12:40:00.000Z",
    countdownSeconds: 1_200,
    cycle: null,
  };

  assert.deepEqual(normalizePublicCycleStatus(idle), idle);
});

test("normalizes one legacy cycle schema to explicit pending fields", () => {
  const legacy = structuredClone(validStatus);
  legacy.schemaVersion = 2;
  delete legacy.cycle.roundAccounting;
  delete legacy.cycle.cards[0].packPriceMicroUsdg;
  delete legacy.cycle.cards[0].buybackMicroUsdg;

  const result = normalizePublicCycleStatus(legacy, "testnet");

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.cycle.roundAccounting, null);
  assert.equal(result.cycle.cards[0].packPriceMicroUsdg, null);
  assert.equal(result.cycle.cards[0].buybackMicroUsdg, null);
});

test("binds only an empty schema-1 tracker response to the expected profile", () => {
  const legacyIdle = {
    schemaVersion: 1,
    generatedAt: "2026-08-25T01:15:19.076Z",
    nextCycleAt: "2026-08-25T01:15:19.076Z",
    countdownSeconds: 0,
    cycle: null,
  };

  assert.deepEqual(normalizePublicCycleStatus(legacyIdle, "testnet"), {
    schemaVersion: 3,
    profile: "testnet",
    network: TESTNET_NETWORK,
    executionState: "unknown",
    executionReason: null,
    generatedAt: legacyIdle.generatedAt,
    nextCycleAt: legacyIdle.nextCycleAt,
    countdownSeconds: 0,
    cycle: null,
  });
  assert.throws(
    () => normalizePublicCycleStatus(legacyIdle),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
  assert.throws(
    () => normalizePublicCycleStatus({ ...legacyIdle, cycle: validStatus.cycle }, "testnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
  assert.throws(
    () => normalizePublicCycleStatus({ ...legacyIdle, privateField: true }, "testnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("accepts only the neutral allowlisted public pause reason", () => {
  const paused = {
    ...validStatus,
    executionState: "paused",
    executionReason: "operator-paused",
  };
  assert.deepEqual(normalizePublicCycleStatus(paused, "testnet"), paused);

  for (const value of [
    { ...paused, executionReason: "database-password-invalid" },
    { ...validStatus, executionReason: "operator-paused" },
    { ...paused, executionReason: null },
  ]) {
    assert.throws(
      () => normalizePublicCycleStatus(value, "testnet"),
      { message: "PUBLIC_CYCLE_STATUS_INVALID" },
    );
  }
});

test("accepts only stable public reasons for skipped cycles", () => {
  const skipped = {
    ...validStatus,
    cycle: {
      ...validStatus.cycle,
      status: "skipped",
      reason: "insufficient-cycle-reserve",
      plannedBoosters: 0,
      openedBoosters: 0,
      cards: [],
    },
  };

  assert.equal(normalizePublicCycleStatus(skipped).cycle.reason, "insufficient-cycle-reserve");
  assert.throws(
    () => normalizePublicCycleStatus({
      ...skipped,
      cycle: { ...skipped.cycle, reason: "private provider detail" },
    }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

const EMPTY_QUOTED_COSTS = {
  outboundBridgeMicroUsdg: null,
  inboundBridgeMicroUsdg: null,
  collectorApiMicroUsdg: null,
  evmNetworkMicroUsdg: null,
  solanaNetworkMicroUsdg: null,
  slippageMicroUsdg: null,
};

function schemaVersion6Fixture() {
  return {
    schemaVersion: 6,
    profile: "testnet",
    network: TESTNET_NETWORK,
    executionState: "active",
    executionReason: null,
    generatedAt: "2026-09-06T12:00:00.000Z",
    nextCycleAt: "2026-09-06T12:20:00.000Z",
    countdownSeconds: 1_200,
    cycle: {
      cycleId: "cycle-9",
      status: "complete",
      selectedPackId: "pokemon_25",
      maxBoostersPerCycle: 4,
      plannedBoosters: 1,
      openedBoosters: 1,
      actions: [{ type: "packs-bought", status: "complete", at: "2026-09-06T11:59:00.000Z" }],
      cards: [card("pokemon_25")],
      returnedMicroUsdg: null,
      rewardStatus: "pending",
      roundAccounting: {
        packSpendMicroUsdg: null,
        buybackMicroUsdg: null,
        outboundBridgeDebit: null,
        inboundBridgeProceeds: null,
        collectorPurchaseDebit: { chainId: "solana:mainnet-beta", assetId: "spl:stablecoin", units: "10000000", decimals: 6 },
        collectorBuybackProceeds: null,
        packGainMicroUsdg: null,
        packLossMicroUsdg: null,
        quotedCosts: EMPTY_QUOTED_COSTS,
        protectedCostsMicroUsdg: null,
        confirmedCostsMicroUsdg: null,
        cycleGainMicroUsdg: null,
        cycleLossMicroUsdg: null,
        walletBalanceBeforeMicroUsdg: null,
        walletBalanceAfterMicroUsdg: null,
        networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
        feeReserveBeforeMicroUsdg: null,
        feeReserveTargetMicroUsdg: null,
        feeReserveTopUpMicroUsdg: null,
        feeReserveAfterMicroUsdg: null,
        plannedHolderRewardsMicroUsdg: null,
        paidHolderRewardsMicroUsdg: null,
        payoutLiabilityMicroUsdg: null,
        payoutDustMicroUsdg: null,
        paidHolderRewardsRecipientCount: null,
        holderRewardsStatus: "pending",
        distributionStatus: "pending",
      },
    },
    heldPositionCount: 1,
    heldPositions: [{ reason: "AWAITING_BUYBACK_WINDOW", ageSeconds: 30, cycleState: "opened" }],
    scheduler: {
      nextCycleAt: "2026-09-06T12:20:00.000Z",
      nextReconcileAt: null,
      automationEnabled: true,
      paused: false,
      pendingReason: null,
    },
  };
}

test("accepts schemaVersion 6 with held positions, scheduler, and typed nullable accounting", () => {
  const fixture = schemaVersion6Fixture();
  const result = normalizePublicCycleStatus(fixture, "testnet");
  assert.deepEqual(result, fixture);
  assert.equal(result.scheduler.nextReconcileAt, null);
  assert.equal(result.cycle.roundAccounting.packSpendMicroUsdg, null);
  assert.deepEqual(result.cycle.roundAccounting.collectorPurchaseDebit, {
    chainId: "solana:mainnet-beta", assetId: "spl:stablecoin", units: "10000000", decimals: 6,
  });
});

test("schemaVersion 6 rejects a missing scheduler, held positions, or a scheduler with both wakeups set", () => {
  const withoutScheduler = schemaVersion6Fixture();
  delete withoutScheduler.scheduler;
  assert.throws(() => normalizePublicCycleStatus(withoutScheduler, "testnet"), /PUBLIC_CYCLE_STATUS_INVALID/);

  const withoutHeldPositions = schemaVersion6Fixture();
  delete withoutHeldPositions.heldPositionCount;
  delete withoutHeldPositions.heldPositions;
  assert.throws(() => normalizePublicCycleStatus(withoutHeldPositions, "testnet"), /PUBLIC_CYCLE_STATUS_INVALID/);

  const bothWakeups = schemaVersion6Fixture();
  bothWakeups.scheduler.nextReconcileAt = "2026-09-06T12:00:05.000Z";
  assert.throws(() => normalizePublicCycleStatus(bothWakeups, "testnet"), /PUBLIC_CYCLE_STATUS_INVALID/);

  const mismatchedHeldCount = schemaVersion6Fixture();
  mismatchedHeldCount.heldPositionCount = 2;
  assert.throws(() => normalizePublicCycleStatus(mismatchedHeldCount, "testnet"), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test("schemaVersion 6 carries real bridge amounts and payout-liability facts distinctly from the Collector-side amounts", () => {
  const fixture = schemaVersion6Fixture();
  fixture.cycle.roundAccounting.outboundBridgeDebit = {
    chainId: "eip155:4663", assetId: "USDG", units: "5000000", decimals: 6,
  };
  fixture.cycle.roundAccounting.payoutLiabilityMicroUsdg = "1200000";
  fixture.cycle.roundAccounting.payoutDustMicroUsdg = "0";
  fixture.cycle.roundAccounting.paidHolderRewardsRecipientCount = 3;
  const result = normalizePublicCycleStatus(fixture, "testnet");
  assert.deepEqual(result.cycle.roundAccounting.outboundBridgeDebit, {
    chainId: "eip155:4663", assetId: "USDG", units: "5000000", decimals: 6,
  });
  assert.equal(result.cycle.roundAccounting.inboundBridgeProceeds, null);
  assert.equal(result.cycle.roundAccounting.payoutLiabilityMicroUsdg, "1200000");
  assert.equal(result.cycle.roundAccounting.paidHolderRewardsRecipientCount, 3);

  const missingBridgeField = schemaVersion6Fixture();
  delete missingBridgeField.cycle.roundAccounting.outboundBridgeDebit;
  assert.throws(
    () => normalizePublicCycleStatus(missingBridgeField, "testnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("schemaVersion 6 never invents a spend/buyback amount before it is actually settled", () => {
  const fixture = schemaVersion6Fixture();
  fixture.cycle.roundAccounting.packSpendMicroUsdg = "0";
  // A real '0' is legitimate once settled at zero, but it must be distinguishable from the
  // fixture's own null (unknown/unsettled) case above -- both must round-trip exactly.
  const result = normalizePublicCycleStatus(fixture, "testnet");
  assert.equal(result.cycle.roundAccounting.packSpendMicroUsdg, "0");
  assert.notEqual(result.cycle.roundAccounting.packSpendMicroUsdg, null);
});

function card(productId) {
  return {
    productId,
    rarity: "Rare",
    nftAddress: null,
    cardName: null,
    setName: null,
    cardNumber: null,
    imageUrl: null,
    packPriceMicroUsdg: null,
    buybackMicroUsdg: null,
  };
}
