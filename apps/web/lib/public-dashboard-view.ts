import type {
  PublicCommunityCard,
  PublicCommunityCycle,
  PublicCommunitySnapshot,
} from "./public-community-snapshot.ts";
import type {
  PublicCycleAction,
  PublicCycleCard,
  PublicCycleStatus,
} from "./public-cycle-status.ts";

export type PublicProcessStepId =
  | "fees" | "budget" | "packs" | "cards" | "sales" | "return" | "holders";
export type PublicProcessState =
  | "waiting" | "active" | "complete" | "paused" | "skipped" | "failed" | "deferred";

export type PublicProcessStep = {
  id: PublicProcessStepId;
  state: PublicProcessState;
  stateLabel: string;
  amountText: string;
  timestamp: string | null;
};

export type DashboardEnvironment =
  | { state: "loading"; profile: null }
  | { state: "verified"; profile: "testnet" | "mainnet" }
  | { state: "mismatch"; profile: null };

export type DashboardFeedInput = {
  hasData: boolean;
  pollFailed: boolean;
  delayed: boolean;
  mismatch: boolean;
};

export type DashboardFeedState = "connecting" | "live" | "delayed" | "unavailable";

export type DashboardPresentation = {
  environment: DashboardEnvironment;
  feedState: DashboardFeedState;
  status: PublicCycleStatus | null;
  community: PublicCommunitySnapshot | null;
};

export const ACTIONS_BY_STEP = {
  fees: ["fees-collected"],
  budget: ["pack-plan-ready"],
  packs: ["packs-bought"],
  cards: ["packs-bought"],
  sales: ["buybacks-settled"],
  return: ["return-bridge-finalized", "ethereum-funded"],
  holders: ["rewards-complete", "rewards-paid", "payouts-settled"],
} as const satisfies Record<PublicProcessStepId, readonly string[]>;

const STEP_IDS: readonly PublicProcessStepId[] = [
  "fees", "budget", "packs", "cards", "sales", "return", "holders",
];

const STATE_LABELS: Record<PublicProcessState, string> = {
  waiting: "Waiting for this step",
  active: "In progress",
  complete: "Complete",
  paused: "Paused — unfinished step",
  skipped: "Skipped — cycle did not continue",
  failed: "Failed — action needs attention",
  deferred: "Deferred — reward distribution is pending",
};

export function resolveDashboardEnvironment(
  status: PublicCycleStatus | null | undefined,
  community: PublicCommunitySnapshot | null | undefined,
): DashboardEnvironment {
  if (status == null || community == null) return { state: "loading", profile: null };

  if (
    status.profile !== community.profile ||
    status.network.ethereum.name !== community.network.ethereum.name ||
    status.network.ethereum.chainId !== community.network.ethereum.chainId ||
    status.network.solana.name !== community.network.solana.name ||
    status.network.solana.genesisHash !== community.network.solana.genesisHash
  ) {
    return { state: "mismatch", profile: null };
  }

  return { state: "verified", profile: status.profile };
}

export function dashboardFeedState({
  hasData,
  pollFailed,
  delayed,
  mismatch,
}: DashboardFeedInput): DashboardFeedState {
  if (mismatch || (!hasData && pollFailed)) return "unavailable";
  if (!hasData) return "connecting";
  if (pollFailed || delayed) return "delayed";
  return "live";
}

export function resolveDashboardPresentation({
  status,
  community,
  isLive,
  pollFailed,
  communityPollFailed,
}: {
  status: PublicCycleStatus | null | undefined;
  community: PublicCommunitySnapshot | null | undefined;
  isLive: boolean;
  pollFailed: boolean;
  communityPollFailed: boolean;
}): DashboardPresentation {
  const environment = resolveDashboardEnvironment(status, community);
  const verified = environment.state === "verified";
  const feedState = dashboardFeedState({
    hasData: verified,
    pollFailed: pollFailed || communityPollFailed,
    delayed: verified && (!isLive || community?.delayed === true),
    mismatch: environment.state === "mismatch",
  });

  return {
    environment,
    feedState,
    status: verified ? status ?? null : null,
    community: verified ? community ?? null : null,
  };
}

export function hasLatestPayoutFacts(
  cycle: PublicCommunityCycle | null | undefined,
): boolean {
  if (cycle === null || cycle === undefined) return false;
  const paidHolderRewards = cycle.roundAccounting?.paidHolderRewardsMicroUsdc;
  return (paidHolderRewards !== null && paidHolderRewards !== undefined) ||
    cycle.paidMicroUsdc !== null;
}

export function latestDashboardCards(
  cycle: { cards: PublicCycleCard[] } | null | undefined,
  community: { cards: PublicCommunityCard[] } | null | undefined,
): Array<PublicCycleCard | PublicCommunityCard> {
  return cycle?.cards.length
    ? [...cycle.cards].reverse()
    : [...(community?.cards ?? [])];
}

export function buildPublicCycleProcess({
  status,
  community,
}: {
  status: PublicCycleStatus | null | undefined;
  community: PublicCommunitySnapshot | null | undefined;
}): PublicProcessStep[] {
  if (
    status == null ||
    community == null ||
    resolveDashboardEnvironment(status, community).state !== "verified"
  ) {
    return STEP_IDS.map((id) => unavailableStep(id));
  }
  if (status.executionState === "paused" && status.cycle == null) {
    return STEP_IDS.map((id) => ({
      ...unavailableStep(id),
      state: "paused",
      stateLabel: "Paused — operator execution is paused",
    }));
  }
  if (status.cycle == null) return STEP_IDS.map((id) => unavailableStep(id));
  const cycle = status.cycle;

  return STEP_IDS.map((id) => {
    const actions = actionsForStep(cycle.actions, id);
    const baseState = stepState(id, cycle, actions);
    const state = finalState(baseState, cycle.status, status.executionState);
    return {
      id,
      state,
      stateLabel: STATE_LABELS[state],
      amountText: amountText(id, cycle),
      timestamp: timestampForStep(id, cycle.updatedAt ?? null, actions),
    };
  });
}

function unavailableStep(id: PublicProcessStepId): PublicProcessStep {
  return {
    id,
    state: "waiting",
    stateLabel: STATE_LABELS.waiting,
    amountText: "Unavailable",
    timestamp: null,
  };
}

function actionsForStep(
  actions: readonly PublicCycleAction[],
  id: PublicProcessStepId,
): PublicCycleAction[] {
  return actions.filter(({ type }) => (ACTIONS_BY_STEP[id] as readonly string[]).includes(type));
}

function stepState(
  id: PublicProcessStepId,
  cycle: NonNullable<PublicCycleStatus["cycle"]>,
  actions: readonly PublicCycleAction[],
): PublicProcessState {
  if (actions.some(({ status }) => status === "failed")) return "failed";
  if (id === "holders" && cycle.rewardStatus?.toLowerCase().includes("deferred")) {
    return "deferred";
  }
  if (isComplete(id, cycle, actions)) return "complete";
  return actions.some(({ status }) => status === "pending") ||
      (id === "cards" && actions.some(({ status }) => status === "complete"))
    ? "active"
    : "waiting";
}

function isComplete(
  id: PublicProcessStepId,
  cycle: NonNullable<PublicCycleStatus["cycle"]>,
  actions: readonly PublicCycleAction[],
): boolean {
  if (id === "budget") return cycle.selectedPackId !== null || cycle.plannedBoosters > 0 || hasComplete(actions);
  if (id === "cards") return cycle.openedBoosters > 0;
  if (id === "holders") {
    return cycle.paidMicroUsdc !== null ||
      /complete|paid|settled/i.test(cycle.rewardStatus ?? "") ||
      hasComplete(actions);
  }
  return hasComplete(actions);
}

function hasComplete(actions: readonly PublicCycleAction[]): boolean {
  return actions.some(({ status }) => status === "complete");
}

function finalState(
  state: PublicProcessState,
  cycleStatus: string,
  executionState: PublicCycleStatus["executionState"],
): PublicProcessState {
  if (state === "waiting" || state === "active") {
    if (cycleStatus.toLowerCase() === "skipped") return "skipped";
    if (executionState === "paused") return "paused";
  }
  return state;
}

function amountText(
  id: PublicProcessStepId,
  cycle: NonNullable<PublicCycleStatus["cycle"]>,
): string {
  if (id === "budget") {
    if (cycle.plannedBoosters > 0) return `${cycle.plannedBoosters} planned`;
    return cycle.selectedPackId === null ? "Unavailable" : "Pack selected";
  }
  if (id === "cards") return cycle.openedBoosters > 0 ? `${cycle.openedBoosters} opened` : "Unavailable";
  if (id === "return") return moneyText(cycle.returnedMicroUsdc);
  if (id === "holders") return moneyText(cycle.paidMicroUsdc ?? null);
  if (id === "packs") return moneyText(cycle.spentMicroUsdc ?? null);
  return "Unavailable";
}

function moneyText(value: string | null): string {
  return value === null ? "Unavailable" : `${value} micro-USDC`;
}

function timestampForStep(
  id: PublicProcessStepId,
  updatedAt: string | null,
  actions: readonly PublicCycleAction[],
): string | null {
  const actionTimestamp = actions.at(-1)?.at;
  if (actionTimestamp !== undefined) return actionTimestamp;
  return id === "budget" || id === "cards" || id === "return" || id === "holders"
    ? updatedAt
    : null;
}
