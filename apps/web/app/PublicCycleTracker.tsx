"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  normalizePublicCycleStatus,
  type PublicCycle,
  type PublicCycleAction,
  type PublicCycleCard,
  type PublicCycleStatus,
} from "../lib/public-cycle-status";
import {
  normalizePublicCommunitySnapshot,
  type PublicCommunitySnapshot,
} from "../lib/public-community-snapshot";
import { dashboardExplorerHref } from "../lib/public-dashboard-profile";
import {
  buildPublicCycleProcess,
  hasLatestPayoutFacts,
  latestDashboardCards,
  resolveDashboardPresentation,
  type DashboardEnvironment,
  type DashboardFeedState,
  type PublicProcessStepId,
} from "../lib/public-dashboard-view";
import styles from "./PublicCycleTracker.module.css";

const POLL_INTERVAL_MS = 10_000;
const LIVE_WINDOW_MS = 30_000;
const INITIAL_CARD_COUNT = 12;
const CARD_PAGE_SIZE = 24;
const RAIL_CARD_COUNT = 4;
const PROCESS_LABELS: Record<PublicProcessStepId, string> = {
  fees: "Fees collected",
  budget: "Pack budget",
  packs: "Packs purchased",
  cards: "Cards revealed",
  sales: "Cards sold",
  return: "USDC returned",
  holders: "Holders paid",
};

type PublicCycleContextValue = {
  status: PublicCycleStatus | null;
  cycle: PublicCycle | null;
  community: PublicCommunitySnapshot | null;
  isLive: boolean;
  pollFailed: boolean;
  communityPollFailed: boolean;
  nowMs: number;
};

const PublicCycleContext = createContext<PublicCycleContextValue>({
  status: null,
  cycle: null,
  community: null,
  isLive: false,
  pollFailed: false,
  communityPollFailed: false,
  nowMs: 0,
});

export function usePublicCycle(): PublicCycleContextValue {
  return useContext(PublicCycleContext);
}

/**
 * Owns the only public status poller on the page. The header countdown, the current-pulls rail and
 * the detailed tracker all read this state, so every surface stays synchronized without adding a
 * second request loop.
 */
export function PublicCycleProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PublicCycleStatus | null>(null);
  const [community, setCommunity] = useState<PublicCommunitySnapshot | null>(null);
  const [lastSuccessfulPoll, setLastSuccessfulPoll] = useState<number | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [communityPollFailed, setCommunityPollFailed] = useState(false);
  const [nowMs, setNowMs] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    await Promise.all([
      (async () => {
        try {
          const response = await fetch("/api/cycle-status", {
            cache: "no-store",
            credentials: "omit",
            signal,
          });
          if (!response.ok) throw new Error("PUBLIC_CYCLE_STATUS_UNAVAILABLE");
          setStatus(normalizePublicCycleStatus(await response.json()));
          setLastSuccessfulPoll(Date.now());
          setPollFailed(false);
        } catch (error) {
          if (isAbortError(error)) return;
          setPollFailed(true);
        }
      })(),
      (async () => {
        try {
          const response = await fetch("/api/community-dashboard", {
            cache: "no-store",
            credentials: "omit",
            signal,
          });
          if (!response.ok) throw new Error("PUBLIC_COMMUNITY_UNAVAILABLE");
          setCommunity(normalizePublicCommunitySnapshot(await response.json()));
          setCommunityPollFailed(false);
        } catch (error) {
          if (isAbortError(error)) return;
          setCommunityPollFailed(true);
        }
      })(),
    ]);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const pollIfVisible = () => {
      if (document.visibilityState === "visible") {
        setNowMs(Date.now());
        void refresh(controller.signal);
      }
    };
    const updateVisibleClock = () => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    };
    const initialPoll = window.setTimeout(pollIfVisible, 0);
    const pollTimer = window.setInterval(pollIfVisible, POLL_INTERVAL_MS);
    const countdownTimer = window.setInterval(updateVisibleClock, 1_000);
    document.addEventListener("visibilitychange", pollIfVisible);
    return () => {
      controller.abort();
      window.clearTimeout(initialPoll);
      window.clearInterval(pollTimer);
      window.clearInterval(countdownTimer);
      document.removeEventListener("visibilitychange", pollIfVisible);
    };
  }, [refresh]);

  const value = useMemo<PublicCycleContextValue>(
    () => ({
      status,
      cycle: status?.cycle ?? null,
      community,
      isLive: lastSuccessfulPoll !== null && nowMs - lastSuccessfulPoll <= LIVE_WINDOW_MS,
      pollFailed,
      communityPollFailed,
      nowMs,
    }),
    [community, communityPollFailed, lastSuccessfulPoll, nowMs, pollFailed, status],
  );

  return <PublicCycleContext.Provider value={value}>{children}</PublicCycleContext.Provider>;
}

export function PublicCycleHeaderStatus() {
  const dashboard = usePublicCycle();
  const { feedState, status } = resolveDashboardPresentation(dashboard);
  const countdown = status
    ? formatCountdown(Date.parse(status.nextCycleAt) - dashboard.nowMs)
    : "--:--";

  return (
    <a className={styles.headerStatus} href="#live-machine" data-state={feedState}>
      <span className={styles.headerStatusLabel}>NEXT CYCLE</span>
      <strong className={styles.headerStatusValue}>{countdown}</strong>
      <small className={styles.headerStatusState}>{feedState.toUpperCase()}</small>
    </a>
  );
}

export function PublicCycleCardRail() {
  const dashboard = usePublicCycle();
  const { environment, feedState, status, community } = resolveDashboardPresentation(dashboard);
  const profileMismatch = environment.state === "mismatch";
  const cycle = status?.cycle ?? null;
  const cards = latestDashboardCards(cycle, community).slice(0, RAIL_CARD_COUNT);

  return (
    <section className={styles.pullRail} aria-labelledby="current-pulls-title" data-state={feedState}>
      <div className={styles.pullRailShell}>
        <div className={styles.pullRailHeading}>
          <span className={styles.pullRailTitle} id="current-pulls-title">
            CURRENT PULLS
          </span>
          <span className={styles.pullRailState}>{feedState.toUpperCase()}</span>
          <a
            className={styles.pullRailLink}
            href="#live-machine"
            aria-label="Open the complete live cycle tracker"
          >
            Live tracker <span aria-hidden="true">↓</span>
          </a>
        </div>
        {cards.length ? (
          <ul className={styles.pullRailCards}>
            {cards.map((card, index) => (
              <li className={styles.pullRailCard} key={`${card.nftAddress ?? card.productId}-${index}`}>
                <span className={styles.pullRailArt}>
                  {card.imageUrl ? (
                    // Dynamic card images are already restricted to credential-free HTTPS URLs by the parser.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={card.imageUrl}
                      alt={cardAltText(card)}
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span aria-hidden="true">H</span>
                  )}
                </span>
                <span className={styles.pullRailCopy}>
                  <span>{card.rarity}</span>
                  <strong>{card.cardName ?? "Name pending"}</strong>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.pullRailEmpty}>
            {profileMismatch || feedState === "unavailable"
              ? "Network data unavailable"
              : resolveEmptyPullsMessage(status, cycle)}
          </p>
        )}
      </div>
    </section>
  );
}

export function PublicDeploymentDisclosure() {
  const dashboard = usePublicCycle();
  const environment = resolveDashboardPresentation(dashboard).environment;
  if (environment.state === "mismatch") {
    return <span>Network status unavailable. Do not rely on displayed deployment claims.</span>;
  }
  if (environment.profile === "mainnet") {
    return <span>Mainnet dashboard data is read-only. Verify every public contract and transaction link.</span>;
  }
  if (environment.profile === "testnet") {
    return <span>Testnet prototype only. Displayed assets have no production value.</span>;
  }
  return <span>Network status is loading. No deployment claim is being made.</span>;
}

export default function PublicCycleTracker() {
  const dashboard = usePublicCycle();
  const {
    environment,
    feedState,
    status,
    community: dashboardCommunity,
  } = resolveDashboardPresentation(dashboard);
  const profileMismatch = environment.state === "mismatch";
  const cycle = status?.cycle ?? null;
  const cycleId = cycle?.cycleId ?? null;
  const [cardWindow, setCardWindow] = useState({ cycleId, count: INITIAL_CARD_COUNT });
  const visibleCardCount = cardWindow.cycleId === cycleId
    ? cardWindow.count
    : INITIAL_CARD_COUNT;

  const connectionLabel = `● ${feedState.toUpperCase()}`;
  const nextCycleAt = status?.nextCycleAt ?? dashboardCommunity?.nextCycleAt ?? null;
  const countdown = nextCycleAt
    ? formatCountdown(Date.parse(nextCycleAt) - dashboard.nowMs)
    : "--:--";
  const actions = [...(cycle?.actions ?? [])].sort((left, right) => left.at.localeCompare(right.at));
  const cards = latestDashboardCards(cycle, dashboardCommunity);
  const visibleCards = cards.slice(0, visibleCardCount);
  const processSteps = buildPublicCycleProcess({ status, community: dashboardCommunity });
  const latestCycle = dashboardCommunity?.latestCycle ?? null;
  const roundAccounting = cycle?.roundAccounting ?? latestCycle?.roundAccounting ?? null;

  return (
    <section className={`machine-section ${styles.section}`} id="live-machine">
      <div className={`section-shell ${styles.shell}`}>
        <div className={styles.testnetStrip} role="status" aria-live="polite">
          <strong className={styles.testnetBadge}>
            {profileMismatch || feedState === "unavailable"
              ? "NETWORK UNAVAILABLE"
              : environment.state === "verified"
                ? dashboardCommunity?.badge
                : "NETWORK LOADING"}
          </strong>
          <span>
            {profileMismatch
              ? "Configured network data does not match."
              : environment.state === "verified"
                ? `${status?.network.ethereum.label ?? "Network"} · ${status?.network.solana.label ?? "Network"}`
                : feedState === "unavailable"
                  ? "Verified network data unavailable."
                  : "Awaiting validated network data"}
          </span>
          <small>{environmentStatusCopy({ environment, feedState })}</small>
        </div>
        <div className={styles.heading}>
          <div>
            <span className="section-kicker">LIVE CYCLE TRACKER</span>
            <h1>Watch every cycle move</h1>
            <p>
              Follow completed actions, opened boosters, revealed cards and the exact countdown to
              the next cycle.
            </p>
          </div>
          <div
            className={styles.connection}
            data-live={feedState === "live" ? "true" : "false"}
            role="status"
            aria-live="polite"
          >
            <strong>{connectionLabel}</strong>
            <span>
              {profileMismatch
                ? "Configured network data does not match."
                : feedState === "unavailable"
                  ? "Verified network data unavailable."
                  : feedState === "connecting"
                  ? "Connecting to live cycle data"
                  : feedState === "delayed"
                  ? "Showing the last verified cycle"
                  : `Cycle ${cycle?.cycleId ?? "idle"}`}
            </span>
          </div>
        </div>

        <dl className={styles.primaryMetrics} aria-label="Public dashboard summary">
          <Metric
            label="Latest observed pool"
            value={formatMicroUsdc(dashboardCommunity?.metrics.latestObservedProjectPoolMicroUsdc)}
            detail={formatObservationAge(dashboardCommunity?.poolObservedAt, dashboard.nowMs)}
          />
          <Metric
            label="Latest round actually paid"
            value={roundAccounting
              ? pendingMoney(
                roundAccounting.paidHolderRewardsMicroUsdc,
                humanize(roundAccounting.distributionStatus),
              )
              : latestCycle
                ? pendingMoney(latestCycle.paidMicroUsdc, "Not executed")
                : "Unavailable"}
            detail={latestCycle ? `Cycle ${latestCycle.cycleId}` : "No verified settlement"}
          />
          <Metric
            label="Next cycle"
            value={countdown}
            detail={cycleScheduleLabel(status)}
            emphasized
          />
          <Metric
            label="Packs opened"
            value={cycle
              ? formatCount(cycle.openedBoosters)
              : historyCount(dashboardCommunity, dashboardCommunity?.metrics.openedPacks)}
            detail="Verified completed and active packs"
          />
          <Metric
            label="Cards drawn"
            value={cards.length ? formatCount(cards.length) : "—"}
            detail="Latest verified reveals"
          />
        </dl>

        <ol className={styles.process} aria-label="Current fee-to-holder process">
          {processSteps.map((step, index) => (
            <li key={step.id} data-state={step.state}>
              <span className={styles.processIndex}>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{PROCESS_LABELS[step.id]}</strong>
                <small>{processStepDetail(step.amountText, step.timestamp)}</small>
              </div>
              <span className={styles.processState}>{step.stateLabel}</span>
            </li>
          ))}
        </ol>

        {hasLatestPayoutFacts(latestCycle) && roundAccounting === null ? (
          <dl className={styles.payoutFacts} aria-label="Latest verified payout">
            {latestCycle?.paidMicroUsdc !== null && latestCycle?.paidMicroUsdc !== undefined ? (
              <Metric label="Latest payout" value={formatMicroUsdc(latestCycle.paidMicroUsdc)} />
            ) : null}
            {latestCycle?.payoutRecipientCount !== undefined ? (
              <Metric label="Eligible allocations" value={formatCount(latestCycle.payoutRecipientCount)} />
            ) : null}
          </dl>
        ) : null}

        {roundAccounting ? (
          <div className={styles.accountingGroups} aria-label="Latest Holder Rewards round">
            <AccountingGroup title="Pack result">
              <Metric label="Pack spend" value={formatMicroUsdc(roundAccounting.packSpendMicroUsdc)} />
              <Metric label="Buyback" value={formatMicroUsdc(roundAccounting.buybackMicroUsdc)} />
              <Metric label="Pack gain" value={formatMicroUsdc(roundAccounting.packGainMicroUsdc)} />
              <Metric label="Pack loss" value={formatMicroUsdc(roundAccounting.packLossMicroUsdc)} />
              <Metric
                label="Wallet before"
                value={pendingMoney(roundAccounting.walletBalanceBeforeMicroUsdc, "Balance not supplied")}
              />
              <Metric
                label="Wallet after"
                value={pendingMoney(roundAccounting.walletBalanceAfterMicroUsdc, "Balance not supplied")}
              />
            </AccountingGroup>
            <AccountingGroup title="Quoted and confirmed costs">
              <Metric label="Quoted outbound bridge" value={quotedMoney(roundAccounting.quotedCosts.outboundBridgeMicroUsdc)} />
              <Metric label="Quoted inbound bridge" value={quotedMoney(roundAccounting.quotedCosts.inboundBridgeMicroUsdc)} />
              <Metric label="Quoted Collector API" value={quotedMoney(roundAccounting.quotedCosts.collectorApiMicroUsdc)} />
              <Metric label="Quoted Ethereum network" value={quotedMoney(roundAccounting.quotedCosts.ethereumNetworkMicroUsdc)} />
              <Metric label="Quoted Solana network" value={quotedMoney(roundAccounting.quotedCosts.solanaNetworkMicroUsdc)} />
              <Metric label="Quoted slippage" value={quotedMoney(roundAccounting.quotedCosts.slippageMicroUsdc)} />
              <Metric label="Protected cost forecast" value={pendingMoney(roundAccounting.protectedCostsMicroUsdc, "Not executed in this pack check")} />
              <Metric
                label="Confirmed costs"
                value={pendingMoney(roundAccounting.confirmedCostsMicroUsdc, "Awaiting confirmed receipts")}
              />
              <Metric
                label="Purchase transaction fee"
                value={nativeFeeText(roundAccounting.networkFees.purchase)}
                detail={nativeFeePayer(roundAccounting.networkFees.purchase)}
              />
              <Metric
                label="Buyback transaction fee"
                value={nativeFeeText(roundAccounting.networkFees.buyback)}
                detail={nativeFeePayer(roundAccounting.networkFees.buyback)}
              />
              <Metric
                label="Player wallet fee"
                value={roundAccounting.networkFees.walletLamportsCharged === null
                  ? "Fee not supplied"
                  : `${formatInteger(roundAccounting.networkFees.walletLamportsCharged)} lamports`}
              />
            </AccountingGroup>
            <AccountingGroup title="Fee reserve">
              <Metric label="Reserve before" value={pendingMoney(roundAccounting.feeReserveBeforeMicroUsdc, "Not executed in this pack check")} />
              <Metric label="Reserve target (50%)" value={pendingMoney(roundAccounting.feeReserveTargetMicroUsdc, "Not executed in this pack check")} />
              <Metric label="Reserve top-up" value={pendingMoney(roundAccounting.feeReserveTopUpMicroUsdc, "Not executed in this pack check")} />
              <Metric label="Reserve after" value={pendingMoney(roundAccounting.feeReserveAfterMicroUsdc, "Not executed in this pack check")} />
            </AccountingGroup>
            <AccountingGroup title="Holder settlement">
              <Metric
                label="Planned Holder Rewards"
                value={pendingMoney(
                  roundAccounting.plannedHolderRewardsMicroUsdc,
                  humanize(roundAccounting.holderRewardsStatus),
                )}
              />
              <Metric
                label="Actually paid"
                value={pendingMoney(
                  roundAccounting.paidHolderRewardsMicroUsdc,
                  humanize(roundAccounting.distributionStatus),
                )}
              />
              <Metric
                label="Eligible allocations"
                value={latestCycle ? formatCount(latestCycle.payoutRecipientCount) : "Not computed"}
              />
              <Metric
                label="Complete cycle gain"
                value={pendingMoney(roundAccounting.cycleGainMicroUsdc, "Awaiting confirmed receipts")}
              />
              <Metric
                label="Complete cycle loss"
                value={pendingMoney(roundAccounting.cycleLossMicroUsdc, "Awaiting confirmed receipts")}
              />
            </AccountingGroup>
          </div>
        ) : null}

        {environment.state === "verified" && latestCycle?.transactions.length ? (
          <nav className={styles.transactions} aria-label="Latest verified transactions">
            {latestCycle.transactions.map((transaction) => (
              <a
                href={dashboardExplorerHref(environment.profile, transaction)}
                key={`${transaction.chain}-${transaction.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {transactionPurposeLabel(transaction.purpose)}
                <small>{shortTransactionId(transaction.id)}</small>
              </a>
            ))}
          </nav>
        ) : null}

        <dl className={styles.communityMetrics} aria-label="Public dashboard totals">
          <Metric
            label="Cycle funding"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.totalCycleFundingMicroUsdc)}
          />
          <Metric
            label="Collector spend"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.totalCollectorSpendMicroUsdc)}
          />
          <Metric
            label="Buybacks returned"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.totalBuybacksReturnedMicroUsdc)}
          />
          <Metric
            label="Bridged back"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.totalBridgedBackMicroUsdc)}
          />
          <Metric
            label="Retained reserve"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.latestRetainedReserveMicroUsdc)}
          />
          <Metric
            label="Deferred rewards"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.totalRewardsDeferredMicroUsdc)}
          />
          <Metric
            label="Quoted operating costs"
            value={historyMoney(dashboardCommunity, dashboardCommunity?.metrics.totalQuotedOperatingCostsMicroUsdc)}
          />
          <Metric
            label="Cycle reserve target"
            value={roundAccounting
              ? pendingMoney(
                roundAccounting.feeReserveTargetMicroUsdc,
                "Not executed in this pack check",
              )
              : formatMicroUsdc(dashboardCommunity?.metrics.latestCycleReserveTargetMicroUsdc)}
          />
          <Metric label="Completed cycles" value={historyCount(dashboardCommunity, dashboardCommunity?.metrics.completedCycles)} />
          <Metric label="Skipped cycles" value={historyCount(dashboardCommunity, dashboardCommunity?.metrics.skippedCycles)} />
        </dl>

        <div className={styles.communityFreshness}>
          <span>Last pool observation</span>
          <time dateTime={dashboardCommunity?.poolObservedAt ?? undefined}>
            {formatTimestamp(dashboardCommunity?.poolObservedAt)}
          </time>
          <span>Last verified snapshot</span>
          <time dateTime={dashboardCommunity?.generatedAt}>
            {formatTimestamp(dashboardCommunity?.generatedAt)}
          </time>
          {dashboardCommunity && !dashboardCommunity.historyComplete ? (
            <small>Historical totals are still being backfilled.</small>
          ) : null}
        </div>

        <div className={`live-cycle-screen ${styles.trackerGrid}`}>
          <article className={styles.actionsPanel}>
            <div className={styles.panelHeader}>
              <div>
                <span>Cycle actions</span>
                <strong>{cycle ? humanize(cycle.status) : "Waiting for cycle"}</strong>
              </div>
              <span>
                {cycle
                  ? `${actions.filter((action) => action.status === "complete").length}/${actions.length}`
                  : "—"}
              </span>
            </div>
            {cycle?.status === "skipped" && cycle.reason ? (
              <p className={styles.windowNotice}>
                Cycle skipped: {humanize(cycle.reason)}. No funds moved; the next regular cycle remains scheduled.
              </p>
            ) : null}
            {actions.length ? (
              <ol className={styles.actionList}>
                {actions.map((action, index) => (
                  <ActionRow action={action} index={index} key={`${action.type}-${action.at}-${index}`} />
                ))}
              </ol>
            ) : (
              <p className={styles.empty}>
                {cycle ? "No cycle actions recorded yet." : "Cycle actions unavailable."}
              </p>
            )}
          </article>

          <article className={styles.cardsPanel}>
            <div className={styles.panelHeader}>
              <div>
                <span>Drawn cards</span>
                <strong>
                  {cards.length
                    ? cycle
                      ? `${cycle.openedBoosters} revealed`
                      : `${cards.length} latest verified`
                    : "Awaiting booster results"}
                </strong>
              </div>
              <span>{cycle?.selectedPackId ?? cards[0]?.productId ?? "UNAVAILABLE"}</span>
            </div>
            {cycle && cycle.openedBoosters > cards.length ? (
              <p className={styles.windowNotice}>
                Showing latest {cards.length} of {cycle.openedBoosters} revealed cards.
              </p>
            ) : null}
            {visibleCards.length ? (
              <div className={styles.cardGrid}>
                {visibleCards.map((card, index) => (
                  <CycleCard card={card} key={`${card.nftAddress ?? card.productId}-${index}`} />
                ))}
              </div>
            ) : (
              <p className={styles.empty}>Cards appear here as soon as boosters are resolved.</p>
            )}
            {visibleCards.length < cards.length ? (
              <button
                className={styles.moreButton}
                type="button"
                onClick={() => setCardWindow({
                  cycleId,
                  count: visibleCardCount + CARD_PAGE_SIZE,
                })}
              >
                Show more cards ({cards.length - visibleCards.length} remaining)
              </button>
            ) : null}
          </article>
        </div>

        <div className={styles.footer}>
          <span>Reward settlement</span>
          <strong>{cycle?.rewardStatus ? humanize(cycle.rewardStatus) : "Unavailable"}</strong>
          <span>Paid</span>
          <strong>
            {roundAccounting
              ? pendingMoney(
                roundAccounting.paidHolderRewardsMicroUsdc,
                humanize(roundAccounting.distributionStatus),
              )
              : cycle?.paidMicroUsdc === null || cycle?.paidMicroUsdc === undefined
                ? "Not executed"
                : formatMicroUsdc(cycle.paidMicroUsdc)}
          </strong>
          <span>Booster limit</span>
          <strong>
            {cycle?.maxBoostersPerCycle === null || cycle?.maxBoostersPerCycle === undefined
              ? "Unavailable"
              : `${cycle.maxBoostersPerCycle} per cycle`}
          </strong>
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  detail,
  emphasized = false,
}: {
  label: string;
  value: string;
  detail?: string;
  emphasized?: boolean;
}) {
  return (
    <div data-emphasized={emphasized ? "true" : "false"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function AccountingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.accountingGroup}>
      <h2>{title}</h2>
      <dl className={styles.roundAccounting}>{children}</dl>
    </section>
  );
}

function ActionRow({ action, index }: { action: PublicCycleAction; index: number }) {
  return (
    <li data-status={action.status}>
      <span className={styles.actionIndex}>{String(index + 1).padStart(2, "0")}</span>
      <span className={styles.actionMarker} aria-hidden="true" />
      <div>
        <strong>{humanize(action.type)}</strong>
        <time dateTime={action.at}>{formatTime(action.at)}</time>
      </div>
      <span className={styles.actionStatus}>{action.status}</span>
    </li>
  );
}

function CycleCard({ card }: { card: PublicCycleCard }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardArt}>
        {card.imageUrl ? (
          // Dynamic card images are already restricted to credential-free HTTPS URLs by the parser.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.imageUrl}
            alt={cardAltText(card)}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span>Image pending</span>
        )}
      </div>
      <div className={styles.cardCopy}>
        <span>{card.rarity}</span>
        <strong>{card.cardName ?? "Name pending"}</strong>
        <small>Set: {card.setName ?? "pending"}</small>
        <small>Card number: {card.cardNumber ?? "pending"}</small>
        <small>NFT: {card.nftAddress ?? "pending"}</small>
        <small>Pack price: {pendingMoney(card.packPriceMicroUsdc, "pending")}</small>
        <small>Buyback: {pendingMoney(card.buybackMicroUsdc, "pending")}</small>
      </div>
    </div>
  );
}

function environmentStatusCopy({
  environment,
  feedState,
}: {
  environment: DashboardEnvironment;
  feedState: DashboardFeedState;
}): string {
  if (environment.state === "mismatch") return "Last verified snapshot unavailable";
  if (feedState === "unavailable") return "Public snapshot unavailable";
  if (feedState === "connecting") return "Loading public snapshot";
  if (feedState === "delayed") return "Showing the last verified snapshot";
  return "Verified public snapshot";
}

function formatObservationAge(value: string | null | undefined, nowMs: number): string {
  if (!value || nowMs <= 0) return "Observation age unavailable";
  const ageSeconds = Math.floor((nowMs - Date.parse(value)) / 1_000);
  if (ageSeconds < 0) return "Observation age unavailable";
  if (ageSeconds < 60) return "Observed less than a minute ago";
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `Observed ${ageMinutes} min ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return `Observed ${ageHours} hr ago`;
}

function cycleScheduleLabel(status: PublicCycleStatus | null): string {
  if (!status) return "Schedule unavailable";
  if (status.executionState === "paused") return "Regular schedule · execution paused";
  if (status.executionState === "unknown") {
    return "Regular schedule · execution state unavailable";
  }
  return `Scheduled ${formatTimestamp(status.nextCycleAt)}`;
}

function processStepDetail(amountText: string, timestamp: string | null): string {
  const amountMatch = /^(\d+) micro-USDC$/.exec(amountText);
  const amount = amountMatch ? formatMicroUsdc(amountMatch[1]) : amountText;
  return timestamp ? `${amount} · ${formatTimestamp(timestamp)}` : amount;
}

function transactionPurposeLabel(purpose: string): string {
  return humanize(purpose);
}

function shortTransactionId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function resolveEmptyPullsMessage(
  status: PublicCycleStatus | null,
  cycle: PublicCycle | null,
): string {
  if (!status) return "Connecting to live pulls";
  if (!cycle) return "No cycle running right now";
  return "No cards revealed in this cycle yet";
}

export function cardAltText(card: PublicCycleCard): string {
  return card.cardName ? `${card.cardName} card` : `Revealed ${card.rarity} card`;
}

function pendingMoney(value: string | null, pending: string): string {
  return value === null ? pending : formatMicroUsdc(value);
}

function historyMoney(
  snapshot: PublicCommunitySnapshot | null,
  value: string | null | undefined,
): string {
  if (!snapshot) return "—";
  return snapshot.historyComplete ? formatMicroUsdc(value) : "History incomplete";
}

function historyCount(
  snapshot: PublicCommunitySnapshot | null,
  value: number | undefined,
): string {
  if (!snapshot) return "—";
  return snapshot.historyComplete ? formatCount(value) : "History incomplete";
}

function quotedMoney(value: string | null): string {
  return value === null ? "Quote unavailable" : `${formatMicroUsdc(value)} quoted`;
}

function nativeFeeText(value: { lamports: string; paidBy: string } | null): string {
  return value === null ? "Fee evidence unavailable" : `${formatInteger(value.lamports)} lamports`;
}

function nativeFeePayer(value: { lamports: string; paidBy: string } | null): string | undefined {
  return value === null ? undefined : `Paid by ${value.paidBy}`;
}

function formatInteger(value: string): string {
  return BigInt(value).toLocaleString("en-US");
}

export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatMicroUsdc(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return `${grouped}${fraction ? `.${fraction}` : ""} USDC`;
}

export function formatCount(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Awaiting observation";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function humanize(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
