export type DashboardCard = {
  cycleId: string;
  productId: string;
  rarity: string;
  nftAddress: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  imageUrl: string | null;
  packPriceMicroUsdg: string | null;
  buybackMicroUsdg: string | null;
};

export type CardHistoryCard = DashboardCard & {
  packIndex: number;
  observedAt: string;
};

export type ActiveCycle = {
  cycleId: string;
  status: string;
  updatedAt: string | null;
  configurationRevision: string | null;
  allowedPackIds: string[];
  requestedOrders: number;
  maxBoostersPerCycle: number | null;
  maxUnitPriceMicroUsdg: string | null;
  maxCycleBudgetMicroUsdg: string | null;
  max24HourBudgetMicroUsdg: string | null;
  maxUnitPriceMicroUsd?: string | null;
  maxCycleBudgetMicroUsd?: string | null;
  max24HourBudgetMicroUsd?: string | null;
  revealedCards: number | null;
  rewardRecipientLimit?: number | null;
};

export type CardHistorySort = "recent" | "buyback-desc" | "buyback-asc";

export type CardHistoryFilters = {
  productId: string;
  rarity: string;
  from: string;
  to: string;
  minBuyback: string;
  maxBuyback: string;
};

export type CardHistoryResponse = {
  cards: CardHistoryCard[];
  nextCursor: string | null;
  historyComplete: boolean;
};

export type HeldPosition = {
  positionId: string;
  cycleId: string;
  costMicroUsd: string;
  insuredValue: { chainId: string; assetId: string; decimals: number; units: string } | null;
  reason: string;
  terminalState: string;
  evidenceDigest: string;
  openedAt: string;
  positionRevision: number;
  ownerDecision: {
    positionId: string;
    heldEvidenceDigest: string;
    requestId: string;
    expectedRevision: number;
    choice: "sell" | "keep-holding";
  } | null;
};

export type ManualApproval = {
  cycleId: string;
  cycleDigest: string;
  mode: "production" | "rehearsal";
  ordinal: number;
  releaseCostMicroUsd: string;
  openedAt: string;
  approved: boolean;
  approvedAt: string | null;
};
