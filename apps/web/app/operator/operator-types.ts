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
