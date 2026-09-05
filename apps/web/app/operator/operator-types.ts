export type DashboardCard = {
  cycleId: string;
  productId: string;
  rarity: string;
  nftAddress: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  imageUrl: string | null;
  packPriceMicroUsdc: string | null;
  buybackMicroUsdc: string | null;
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
  requestedOrders: Array<{ productId: string; quantity: number }>;
  maxBoostersPerCycle: number | null;
  maxUnitPriceMicroUsdc: string | null;
  maxCycleBudgetMicroUsdc: string | null;
  max24HourBudgetMicroUsdc: string | null;
  revealedCards: number;
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
