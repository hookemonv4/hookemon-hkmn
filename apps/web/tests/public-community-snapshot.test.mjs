import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublicCommunitySnapshot } from "../lib/public-community-snapshot.ts";

const TESTNET_NETWORK = {
  evm: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
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
    latestObservedProjectPoolMicroUsdg: "1000000",
    totalCycleFundingMicroUsdg: "900000",
    totalCollectorSpendMicroUsdg: "500000",
    totalBuybacksReturnedMicroUsdg: "300000",
    totalBridgedBackMicroUsdg: "300000",
    totalRewardsPaidMicroUsdg: "250000",
    totalRewardsDeferredMicroUsdg: "0",
    totalQuotedOperatingCostsMicroUsdg: "10000",
    latestRetainedReserveMicroUsdg: "40000",
    latestCycleReserveTargetMicroUsdg: "50000",
    completedCycles: 3,
    skippedCycles: 1,
    openedPacks: 4,
  },
  latestCycle: {
    cycleId: "cycle-3",
    status: "complete",
    reason: null,
    updatedAt: "2026-08-19T11:00:00.000Z",
    paidMicroUsdg: "250000",
    payoutRecipientCount: 2,
    roundAccounting: {
      packSpendMicroUsdg: "10000000",
      buybackMicroUsdg: "8000000",
      packGainMicroUsdg: "0",
      packLossMicroUsdg: "2000000",
      quotedCosts: {
        outboundBridgeMicroUsdg: null,
        inboundBridgeMicroUsdg: null,
        collectorApiMicroUsdg: null,
        evmNetworkMicroUsdg: null,
        solanaNetworkMicroUsdg: null,
        slippageMicroUsdg: null,
      },
      protectedCostsMicroUsdg: "3750000",
      confirmedCostsMicroUsdg: null,
      cycleGainMicroUsdg: null,
      cycleLossMicroUsdg: null,
      walletBalanceBeforeMicroUsdg: null,
      walletBalanceAfterMicroUsdg: null,
      networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
      feeReserveBeforeMicroUsdg: "0",
      feeReserveTargetMicroUsdg: "1875000",
      feeReserveTopUpMicroUsdg: "1875000",
      feeReserveAfterMicroUsdg: "1875000",
      plannedHolderRewardsMicroUsdg: "6125000",
      paidHolderRewardsMicroUsdg: "250000",
      holderRewardsStatus: "computed",
      distributionStatus: "reconciled",
    },
    transactions: [{
      chain: "evm",
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
    packPriceMicroUsdg: "10000000",
    buybackMicroUsdg: "8000000",
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
    packPriceMicroUsdg: "25000000",
    buybackMicroUsdg: "17000000",
  };
  snapshot.latestCycle.paidMicroUsdg = null;
  snapshot.latestCycle.payoutRecipientCount = 0;
  snapshot.latestCycle.roundAccounting = {
    packSpendMicroUsdg: "25000000",
    buybackMicroUsdg: "17000000",
    packGainMicroUsdg: "0",
    packLossMicroUsdg: "8000000",
    quotedCosts: {
      outboundBridgeMicroUsdg: null,
      inboundBridgeMicroUsdg: null,
      collectorApiMicroUsdg: null,
      evmNetworkMicroUsdg: null,
      solanaNetworkMicroUsdg: null,
      slippageMicroUsdg: null,
    },
    protectedCostsMicroUsdg: null,
    confirmedCostsMicroUsdg: null,
    cycleGainMicroUsdg: null,
    cycleLossMicroUsdg: null,
    walletBalanceBeforeMicroUsdg: "26350000",
    walletBalanceAfterMicroUsdg: "18350000",
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
    feeReserveBeforeMicroUsdg: null,
    feeReserveTargetMicroUsdg: null,
    feeReserveTopUpMicroUsdg: null,
    feeReserveAfterMicroUsdg: null,
    plannedHolderRewardsMicroUsdg: null,
    paidHolderRewardsMicroUsdg: null,
    holderRewardsStatus: "not-computed-in-pack-canary",
    distributionStatus: "not-executed",
  };

  const result = normalizePublicCommunitySnapshot(snapshot, "testnet");

  assert.equal(result.latestCycle.roundAccounting.packLossMicroUsdg, "8000000");
  assert.equal(result.latestCycle.roundAccounting.paidHolderRewardsMicroUsdg, null);
  assert.equal(result.latestCycle.roundAccounting.protectedCostsMicroUsdg, null);
  assert.equal(result.latestCycle.roundAccounting.feeReserveAfterMicroUsdg, null);
  assert.equal(result.latestCycle.roundAccounting.networkFees.purchase.lamports, "11600");
  assert.equal(result.cards[0].cardName, null);
});

test("upgrades a legacy community payload to explicit nullable facts", () => {
  const snapshot = structuredClone(validCommunitySnapshot);
  snapshot.schemaVersion = 3;
  snapshot.latestCycle.roundAccounting = {
    packSpendMicroUsdg: "10000000",
    buybackMicroUsdg: "8000000",
    protectedCostsMicroUsdg: "3750000",
    confirmedCostsMicroUsdg: null,
    feeReserveBeforeMicroUsdg: "0",
    feeReserveTargetMicroUsdg: "1875000",
    feeReserveTopUpMicroUsdg: "1875000",
    feeReserveAfterMicroUsdg: "1875000",
    holderRewardsMicroUsdg: "6125000",
    gainMicroUsdg: "0",
    lossMicroUsdg: "5750000",
  };
  snapshot.cards = [{
    cycleId: "cycle-3",
    productId: "pokemon_25",
    rarity: "rare",
  }];

  const result = normalizePublicCommunitySnapshot(snapshot, "testnet");

  assert.equal(result.schemaVersion, 4);
  assert.equal(result.latestCycle.roundAccounting.cycleLossMicroUsdg, null);
  assert.equal(result.cards[0].cardName, null);
});

test("accepts only paired unavailable pool facts", () => {
  const missing = structuredClone(validCommunitySnapshot);
  missing.poolObservedAt = null;
  missing.metrics.latestObservedProjectPoolMicroUsdg = null;
  assert.deepEqual(normalizePublicCommunitySnapshot(missing, "testnet"), missing);

  for (const value of [
    { ...missing, poolObservedAt: validCommunitySnapshot.poolObservedAt },
    {
      ...validCommunitySnapshot,
      metrics: { ...validCommunitySnapshot.metrics, latestObservedProjectPoolMicroUsdg: null },
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
  mainnet.network.evm.name = "mainnet";
  cases.push(mainnet);
  const negativeMoney = structuredClone(validCommunitySnapshot);
  negativeMoney.metrics.totalRewardsPaidMicroUsdg = "-1";
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
    chain: "evm",
    purpose: "reward-settlement",
    id: `0x${index.toString(16).padStart(64, "0")}`,
  }));
  cases.push(tooManyTransactions);
  const simultaneousGainAndLoss = structuredClone(validCommunitySnapshot);
  simultaneousGainAndLoss.latestCycle.roundAccounting.packGainMicroUsdg = "1";
  simultaneousGainAndLoss.latestCycle.roundAccounting.packLossMicroUsdg = "1";
  cases.push(simultaneousGainAndLoss);
  const malformedConfirmedCosts = structuredClone(validCommunitySnapshot);
  malformedConfirmedCosts.latestCycle.roundAccounting.confirmedCostsMicroUsdg = "unknown";
  cases.push(malformedConfirmedCosts);

  for (const value of cases) {
    assert.throws(
      () => normalizePublicCommunitySnapshot(value),
      { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
    );
  }
});

test("rejects mixed-case duplicate EVM transaction references", () => {
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

function schemaVersion8Fixture() {
  return {
    ...structuredClone(validCommunitySnapshot),
    schemaVersion: 8,
    latestCycle: {
      ...structuredClone(validCommunitySnapshot.latestCycle),
      rewardRecipientLimit: 100,
      roundAccounting: {
        packSpendMicroUsdg: null,
        buybackMicroUsdg: null,
        collectorPurchaseDebit: { chainId: "solana:mainnet-beta", assetId: "USDC", units: "10000000", decimals: 6 },
        collectorBuybackProceeds: { chainId: "solana:mainnet-beta", assetId: "USDC", units: "8000000", decimals: 6 },
        packGainMicroUsdg: null,
        packLossMicroUsdg: null,
        quotedCosts: validCommunitySnapshot.latestCycle.roundAccounting.quotedCosts,
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
        holderRewardsStatus: "pending",
        distributionStatus: "pending",
      },
    },
    cards: [{
      cycleId: "cycle-3", operationId: "op-1", packIndex: 0, memo: "memo-1", mint: null,
      eventId: "evt-1", sequence: "1", state: "finalized", name: "Pikachu",
      imageUrl: "https://images.example/pikachu.png",
      observedAt: "2026-08-19T10:58:00.000Z", finalizedAt: "2026-08-19T11:00:00.000Z",
      transactionId: null,
      proceeds: { chainId: "solana:mainnet-beta", assetId: "USDC", units: "8000000", decimals: 6 },
    }],
    heldPositionCount: 1,
    heldPositions: [{ reason: "AWAITING_BUYBACK_WINDOW", ageSeconds: 15, cycleState: "opened" }],
  };
}

test("accepts schemaVersion 8 with the frozen PublicCardEvent card feed and typed nullable accounting", () => {
  const fixture = schemaVersion8Fixture();
  const result = normalizePublicCommunitySnapshot(fixture, "testnet");
  assert.deepEqual(result, fixture);
  assert.equal(result.cards[0].state, "finalized");
  assert.equal(result.latestCycle.roundAccounting.packSpendMicroUsdg, null);
  assert.deepEqual(result.latestCycle.roundAccounting.collectorBuybackProceeds, {
    chainId: "solana:mainnet-beta", assetId: "USDC", units: "8000000", decimals: 6,
  });
});

test("schemaVersion 8 rejects a legacy productId/rarity card, a missing held-position count, and an invalid card event", () => {
  const legacyCardShape = schemaVersion8Fixture();
  legacyCardShape.cards = [validCommunitySnapshot.cards[0]];
  assert.throws(
    () => normalizePublicCommunitySnapshot(legacyCardShape, "testnet"),
    { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
  );

  const missingHeldPositions = schemaVersion8Fixture();
  delete missingHeldPositions.heldPositionCount;
  delete missingHeldPositions.heldPositions;
  assert.throws(
    () => normalizePublicCommunitySnapshot(missingHeldPositions, "testnet"),
    { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
  );

  const invalidCardState = schemaVersion8Fixture();
  invalidCardState.cards[0].state = "sold";
  assert.throws(
    () => normalizePublicCommunitySnapshot(invalidCardState, "testnet"),
    { message: "PUBLIC_COMMUNITY_SNAPSHOT_INVALID" },
  );
});
