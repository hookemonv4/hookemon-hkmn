"use client";

import { resolveDashboardPresentation } from "../lib/public-dashboard-view";
import {
  cardAltText,
  formatCount,
  formatCountdown,
  formatMicroUsdc,
  usePublicCycle,
} from "./PublicCycleTracker";
import styles from "./PublicCycleTracker.module.css";

const HERO_CARD_COUNT = 3;

export default function HeroDashboard() {
  const dashboard = usePublicCycle();
  const { feedState, status, community } = resolveDashboardPresentation(dashboard);
  const cycle = status?.cycle ?? null;
  const nextCycleAt = status?.nextCycleAt ?? community?.nextCycleAt ?? null;
  const countdown = nextCycleAt
    ? formatCountdown(Date.parse(nextCycleAt) - dashboard.nowMs)
    : "--:--";
  const verifiedCards = cycle?.cards?.length ? cycle.cards : community?.cards ?? [];
  const latestCards = [...verifiedCards].slice(-HERO_CARD_COUNT).reverse();

  return (
    <aside className={styles.heroDashboard} aria-label="Live dashboard summary" data-state={feedState}>
      <div className={styles.heroDashboardTop}>
        <span className={styles.heroDashboardTitle}>LIVE DASHBOARD</span>
        <span className={styles.heroDashboardState}>{feedState.toUpperCase()}</span>
      </div>
      <dl className={styles.heroDashboardMetrics}>
        <div>
          <dt>Rewards paid</dt>
          <dd>{formatMicroUsdc(community?.metrics.totalRewardsPaidMicroUsdc)}</dd>
        </div>
        <div>
          <dt>Packs opened</dt>
          <dd>{formatCount(community?.metrics.openedPacks)}</dd>
        </div>
        <div>
          <dt>Next cycle</dt>
          <dd>{countdown}</dd>
        </div>
      </dl>
      <div className={styles.heroDashboardCards}>
        <span className={styles.heroDashboardCardsLabel}>Latest pulls</span>
        {latestCards.length ? (
          <ul>
            {latestCards.map((card, index) => (
              <li key={`${card.nftAddress ?? card.productId}-${index}`}>
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
              </li>
            ))}
          </ul>
        ) : (
          <span className={styles.heroDashboardEmpty}>Awaiting verified pulls</span>
        )}
      </div>
      <a className={styles.heroDashboardLink} href="#live-machine">
        Open the full dashboard <span aria-hidden="true">↓</span>
      </a>
    </aside>
  );
}
