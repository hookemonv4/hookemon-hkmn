import { test } from "node:test";
import assert from "node:assert/strict";

import { projectPublicCycle, normalizePublicCycleStatus } from "../src/cycle-status.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const NEXT_CYCLE = NOW + 60_000;

test("projectPublicCycle emits network.evm for the mainnet profile", () => {
  const status = projectPublicCycle({
    nowMs: NOW,
    nextCycleAtMs: NEXT_CYCLE,
    record: null,
    profile: "mainnet",
    executionState: "active",
  });
  assert.deepEqual(status.network.evm, { name: "robinhood", chainId: 4663, label: "Robinhood Chain" });
  assert.equal(Object.hasOwn(status.network, "ethereum"), false);
});

test("normalizePublicCycleStatus rejects a status still using the legacy ethereum network key", () => {
  const status = projectPublicCycle({
    nowMs: NOW,
    nextCycleAtMs: NEXT_CYCLE,
    record: null,
    profile: "testnet",
    executionState: "active",
  });
  const legacyShaped = {
    ...status,
    network: { ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" }, solana: status.network.solana },
  };
  assert.throws(() => normalizePublicCycleStatus(legacyShaped), /PUBLIC_CYCLE_STATUS_INVALID/);
});

test("projectPublicCycle carries a completed cycle's round accounting with MicroUsdg fields", () => {
  const record = {
    cycleId: "cycle-1",
    status: "complete",
    timeline: [],
    packs: [
      { productId: "booster-1", rarity: "common", cardName: "Ember Chick" },
    ],
    packPlan: { orders: [{ productId: "booster-1", quantity: 1, unitPrice: 10_000n }] },
    inbound: { amountReceived: 100_000n },
    settlement: { status: "paid", paidThisCycleMicroUsdg: "40000" },
    roundAccounting: {
      grossPackDebitMicroUsdg: 10_000n,
      confirmedBuybackMicroUsdc: 15_000n,
      confirmedCostMicroUsdg: "-500",
      holderRewardsMicroUsdg: 40_000n,
    },
    roundEvidence: {
      holderRewardsStatus: "paid",
      distributionStatus: "complete",
    },
  };

  const status = projectPublicCycle({
    nowMs: NOW,
    nextCycleAtMs: NEXT_CYCLE,
    record,
    profile: "testnet",
    executionState: "active",
  });

  const accounting = status.cycle.roundAccounting;
  assert.equal(accounting.packSpendMicroUsdg, "10000");
  assert.equal(accounting.buybackMicroUsdg, "15000");
  assert.equal(accounting.confirmedCostsMicroUsdg, "-500");
  assert.equal(accounting.paidHolderRewardsMicroUsdg, "40000");
  assert.equal(status.cycle.paidMicroUsdg, "40000");

  // Round-trips through the public validator, proving the emitted shape matches the contract.
  const normalized = normalizePublicCycleStatus(status);
  assert.equal(normalized.cycle.roundAccounting.confirmedCostsMicroUsdg, "-500");
});

test("a negative confirmedCostsMicroUsdg from durable evidence is accepted as signed money", () => {
  const status = projectPublicCycle({
    nowMs: NOW,
    nextCycleAtMs: NEXT_CYCLE,
    record: {
      cycleId: "cycle-2",
      status: "complete",
      packs: [],
      roundAccounting: {
        grossPackDebitMicroUsdg: 0n,
        confirmedBuybackMicroUsdc: 0n,
        confirmedCostMicroUsdg: "-1234",
      },
    },
    profile: "testnet",
    executionState: "active",
  });
  assert.equal(status.cycle.roundAccounting.confirmedCostsMicroUsdg, "-1234");
});

test("normalizePublicCycleStatus rejects a non-numeric confirmedCostsMicroUsdg", () => {
  const status = projectPublicCycle({
    nowMs: NOW,
    nextCycleAtMs: NEXT_CYCLE,
    record: null,
    profile: "testnet",
    executionState: "active",
  });
  const invalidStatus = {
    ...status,
    cycle: {
      cycleId: "c",
      status: "complete",
      selectedPackId: null,
      maxBoostersPerCycle: null,
      plannedBoosters: 0,
      openedBoosters: 0,
      actions: [],
      cards: [],
      returnedMicroUsdg: null,
      rewardStatus: null,
      roundAccounting: {
        packSpendMicroUsdg: "0",
        buybackMicroUsdg: "0",
        packGainMicroUsdg: "0",
        packLossMicroUsdg: "0",
        quotedCosts: {
          outboundBridgeMicroUsdg: null,
          inboundBridgeMicroUsdg: null,
          collectorApiMicroUsdg: null,
          evmNetworkMicroUsdg: null,
          solanaNetworkMicroUsdg: null,
          slippageMicroUsdg: null,
        },
        protectedCostsMicroUsdg: null,
        confirmedCostsMicroUsdg: "not-a-number",
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
        holderRewardsStatus: "pending",
        distributionStatus: "pending",
      },
    },
  };
  assert.throws(() => normalizePublicCycleStatus(invalidStatus), /PUBLIC_CYCLE_STATUS_INVALID/);
});
