import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublicCommunitySnapshot } from "../lib/public-community-snapshot.ts";

const TESTNET_NETWORK = {
  ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  solana: {
    name: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    label: "Solana Devnet",
  },
};

export const validCommunitySnapshot = {
  schemaVersion: 4,
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
    totalCollectorSpendMicroUsdc: "500000",
    totalBuybacksReturnedMicroUsdc: "300000",
    totalBridgedBackMicroUsdc: "300000",
    totalRewardsPaidMicroUsdc: "250000",
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
    paidMicroUsdc: "250000",
    payoutRecipientCount: 2,
    roundAccounting: {
      packSpendMicroUsdc: "10000000",
      buybackMicroUsdc: "8000000",
      packGainMicroUsdc: "0",
      packLossMicroUsdc: "2000000",
      quotedCosts: {
        outboundBridgeMicroUsdc: null,
        inboundBridgeMicroUsdc: null,
        collectorApiMicroUsdc: null,
        ethereumNetworkMicroUsdc: null,
        solanaNetworkMicroUsdc: null,
        slippageMicroUsdc: null,
      },
      protectedCostsMicroUsdc: "3750000",
      confirmedCostsMicroUsdc: null,
      cycleGainMicroUsdc: null,
      cycleLossMicroUsdc: null,
      walletBalanceBeforeMicroUsdc: null,
      walletBalanceAfterMicroUsdc: null,
      networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
      feeReserveBeforeMicroUsdc: "0",
      feeReserveTargetMicroUsdc: "1875000",
      feeReserveTopUpMicroUsdc: "1875000",
      feeReserveAfterMicroUsdc: "1875000",
      plannedHolderRewardsMicroUsdc: "6125000",
      paidHolderRewardsMicroUsdc: "250000",
      holderRewardsStatus: "computed",
      distributionStatus: "reconciled",
    },
    transactions: [{
      chain: "ethereum",
      purpose: "reward-settlement",
      id: `0x${"ab".repeat(32)}`,
    }],
  },
  cards: [{
    cycleId: "cycle-3",
    productId: "pokemon_25",
    rarity: "rare",
    nftAddress: null,
    cardName: "Pikachu",
    setName: null,
    cardNumber: null,
    imageUrl: "https://images.example/pikachu.png",
    packPriceMicroUsdc: "10000000",
    buybackMicroUsdc: "8000000",
  }],
};

test("accepts only the exact public profile-aware community contract", () => {
  const result = normalizePublicCommunitySnapshot(validCommunitySnapshot, "testnet");

  assert.deepEqual(result, validCommunitySnapshot);
  assert.notEqual(result, validCommunitySnapshot);
  assert.notEqual(result.metrics, validCommunitySnapshot.metrics);
  assert.notEqual(result.cards, validCommunitySnapshot.cards);
  assert.throws(
    () => normalizePublicCommunitySnapshot(validCommunitySnapshot, "mainnet"),
    { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
  );
  assert.throws(
    () => normalizePublicCommunitySnapshot({
      ...validCommunitySnapshot,
      operator: { address: "private" },
    }),
    { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
  );
});

test("accepts nullable Devnet card metadata and native fee evidence", () => {
  const snapshot = structuredClone(validCommunitySnapshot);
  snapshot.schemaVersion = 4;
  snapshot.cards[0] = {
    cycleId: "collector-devnet-canary-v1",
    productId: "pokemon_25",
    rarity: "Common",
    nftAddress: "DVj1AN7A8uWgXE4SJjwt3NZJMJg3A62pWSoyHZrf1UpL",
    cardName: null,
    setName: null,
    cardNumber: null,
    imageUrl: null,
    packPriceMicroUsdc: "25000000",
    buybackMicroUsdc: "17000000",
  };
  snapshot.latestCycle.paidMicroUsdc = null;
  snapshot.latestCycle.payoutRecipientCount = 0;
  snapshot.latestCycle.roundAccounting = {
    packSpendMicroUsdc: "25000000",
    buybackMicroUsdc: "17000000",
    packGainMicroUsdc: "0",
    packLossMicroUsdc: "8000000",
    quotedCosts: {
      outboundBridgeMicroUsdc: null,
      inboundBridgeMicroUsdc: null,
      collectorApiMicroUsdc: null,
      ethereumNetworkMicroUsdc: null,
      solanaNetworkMicroUsdc: null,
      slippageMicroUsdc: null,
    },
    protectedCostsMicroUsdc: null,
    confirmedCostsMicroUsdc: null,
    cycleGainMicroUsdc: null,
    cycleLossMicroUsdc: null,
    walletBalanceBeforeMicroUsdc: "26350000",
    walletBalanceAfterMicroUsdc: "18350000",
    networkFees: {
      walletLamportsCharged: "0",
      purchase: {
        lamports: "11600",
        paidBy: "A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv",
      },
      buyback: {
        lamports: "7000",
        paidBy: "A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv",
      },
    },
    feeReserveBeforeMicroUsdc: null,
    feeReserveTargetMicroUsdc: null,
    feeReserveTopUpMicroUsdc: null,
    feeReserveAfterMicroUsdc: null,
    plannedHolderRewardsMicroUsdc: null,
    paidHolderRewardsMicroUsdc: null,
    holderRewardsStatus: "not-computed-in-pack-canary",
    distributionStatus: "not-executed",
  };

  const result = normalizePublicCommunitySnapshot(snapshot, "testnet");

  assert.equal(result.latestCycle.roundAccounting.packLossMicroUsdc, "8000000");
  assert.equal(result.latestCycle.roundAccounting.paidHolderRewardsMicroUsdc, null);
  assert.equal(result.latestCycle.roundAccounting.protectedCostsMicroUsdc, null);
  assert.equal(result.latestCycle.roundAccounting.feeReserveAfterMicroUsdc, null);
  assert.equal(result.latestCycle.roundAccounting.networkFees.purchase.lamports, "11600");
  assert.equal(result.cards[0].cardName, null);
});

test("upgrades a legacy community payload to explicit nullable facts", () => {
  const snapshot = structuredClone(validCommunitySnapshot);
  snapshot.schemaVersion = 3;
  snapshot.latestCycle.roundAccounting = {
    packSpendMicroUsdc: "10000000",
    buybackMicroUsdc: "8000000",
    protectedCostsMicroUsdc: "3750000",
    confirmedCostsMicroUsdc: null,
    feeReserveBeforeMicroUsdc: "0",
    feeReserveTargetMicroUsdc: "1875000",
    feeReserveTopUpMicroUsdc: "1875000",
    feeReserveAfterMicroUsdc: "1875000",
    holderRewardsMicroUsdc: "6125000",
    gainMicroUsdc: "0",
    lossMicroUsdc: "5750000",
  };
  snapshot.cards = [{
    cycleId: "cycle-3",
    productId: "pokemon_25",
    rarity: "rare",
  }];

  const result = normalizePublicCommunitySnapshot(snapshot, "testnet");

  assert.equal(result.schemaVersion, 4);
  assert.equal(result.latestCycle.roundAccounting.cycleLossMicroUsdc, null);
  assert.equal(result.cards[0].cardName, null);
});

test("accepts only paired unavailable pool facts", () => {
  const missing = structuredClone(validCommunitySnapshot);
  missing.poolObservedAt = null;
  missing.metrics.latestObservedProjectPoolMicroUsdc = null;
  assert.deepEqual(normalizePublicCommunitySnapshot(missing, "testnet"), missing);

  for (const value of [
    { ...missing, poolObservedAt: validCommunitySnapshot.poolObservedAt },
    {
      ...validCommunitySnapshot,
      metrics: { ...validCommunitySnapshot.metrics, latestObservedProjectPoolMicroUsdc: null },
    },
    {
      ...validCommunitySnapshot,
      poolObservedAt: "2026-08-19T09:00:00.000Z",
      delayed: false,
    },
  ]) {
    assert.throws(
      () => normalizePublicCommunitySnapshot(value, "testnet"),
      { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
    );
  }
});

test("rejects private nested fields and malformed bounded values", () => {
  const cases = [];
  const mainnet = structuredClone(validCommunitySnapshot);
  mainnet.network.ethereum.name = "mainnet";
  cases.push(mainnet);
  const negativeMoney = structuredClone(validCommunitySnapshot);
  negativeMoney.metrics.totalRewardsPaidMicroUsdc = "-1";
  cases.push(negativeMoney);
  const invalidTimestamp = structuredClone(validCommunitySnapshot);
  invalidTimestamp.poolObservedAt = "unknown";
  cases.push(invalidTimestamp);
  const tooManyCards = structuredClone(validCommunitySnapshot);
  tooManyCards.cards = Array.from({ length: 13 }, () => ({
    cycleId: "cycle-3",
    productId: "pokemon_25",
    rarity: "rare",
  }));
  cases.push(tooManyCards);
  const unsafeImage = structuredClone(validCommunitySnapshot);
  unsafeImage.cards[0].imageUrl = "http://images.example/private.png";
  cases.push(unsafeImage);
  const privateCard = structuredClone(validCommunitySnapshot);
  privateCard.cards[0].purchaseSignature = "private";
  cases.push(privateCard);
  const privateMetric = structuredClone(validCommunitySnapshot);
  privateMetric.metrics.selectedControlLimit = "1";
  cases.push(privateMetric);
  const transactionUrl = structuredClone(validCommunitySnapshot);
  transactionUrl.latestCycle.transactions[0].id = "https://evil.example";
  cases.push(transactionUrl);
  const tooManyTransactions = structuredClone(validCommunitySnapshot);
  tooManyTransactions.latestCycle.transactions = Array.from({ length: 25 }, (_, index) => ({
    chain: "ethereum",
    purpose: "reward-settlement",
    id: `0x${index.toString(16).padStart(64, "0")}`,
  }));
  cases.push(tooManyTransactions);
  const simultaneousGainAndLoss = structuredClone(validCommunitySnapshot);
  simultaneousGainAndLoss.latestCycle.roundAccounting.packGainMicroUsdc = "1";
  simultaneousGainAndLoss.latestCycle.roundAccounting.packLossMicroUsdc = "1";
  cases.push(simultaneousGainAndLoss);
  const malformedConfirmedCosts = structuredClone(validCommunitySnapshot);
  malformedConfirmedCosts.latestCycle.roundAccounting.confirmedCostsMicroUsdc = "unknown";
  cases.push(malformedConfirmedCosts);

  for (const value of cases) {
    assert.throws(
      () => normalizePublicCommunitySnapshot(value),
      { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
    );
  }
});

test("rejects mixed-case duplicate Ethereum transaction references", () => {
  const snapshot = structuredClone(validCommunitySnapshot);
  snapshot.latestCycle.transactions.push({
    ...snapshot.latestCycle.transactions[0],
    purpose: "outbound-burn",
    id: `0x${snapshot.latestCycle.transactions[0].id.slice(2).toUpperCase()}`,
  });

  assert.throws(
    () => normalizePublicCommunitySnapshot(snapshot, "testnet"),
    { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
  );
});
