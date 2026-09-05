"use client";

import Image from "next/image";
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
  FALLBACK_COLLECTOR_CARDS,
  describeCollectorCard,
  formatCollectorPercent,
  formatCollectorUsd,
  formatIllustrativeBuyback,
  normalizeCollectorCards,
  selectCollectorPresentation,
  type CollectorCard,
} from "../lib/collector-cards";

const HERO_ROTATION_MS = 1_800;

type CollectorCardsContextValue = {
  cards: readonly CollectorCard[];
  reportImageFailure: (id: string) => void;
};

const CollectorCardsContext = createContext<CollectorCardsContextValue>({
  cards: FALLBACK_COLLECTOR_CARDS,
  reportImageFailure: () => undefined,
});

export type CollectorJourneyState =
  | "destination"
  | "charging"
  | "bridged"
  | "opened"
  | "buyback"
  | "payout";

export function CollectorCardsProvider({ children }: { children: ReactNode }) {
  const [remoteCards, setRemoteCards] = useState<CollectorCard[] | null>(null);
  const [failedCardIds, setFailedCardIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();

    async function refreshCards() {
      try {
        const response = await fetch("/api/collector-cards", {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) return;

        const cards = normalizeCollectorCards(await response.json());
        if (cards.length > 0) setRemoteCards(cards);
      } catch {
        // The bundled deck is already rendered and remains the stable fallback.
      }
    }

    void refreshCards();
    return () => controller.abort();
  }, []);

  const reportImageFailure = useCallback((id: string) => {
    setFailedCardIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const cards = useMemo(() => {
    const remoteAvailable = remoteCards?.filter((card) => !failedCardIds.has(card.id)) ?? [];
    if (remoteAvailable.length > 0) return remoteAvailable;
    return FALLBACK_COLLECTOR_CARDS.filter((card) => !failedCardIds.has(card.id));
  }, [failedCardIds, remoteCards]);

  const value = useMemo(
    () => ({ cards, reportImageFailure }),
    [cards, reportImageFailure],
  );

  return <CollectorCardsContext.Provider value={value}>{children}</CollectorCardsContext.Provider>;
}

function useCollectorCards() {
  return useContext(CollectorCardsContext);
}

function CollectorCardImage({
  card,
  priority = false,
  sizes,
}: {
  card: CollectorCard;
  priority?: boolean;
  sizes: string;
}) {
  const { reportImageFailure } = useCollectorCards();

  return (
    <Image
      src={card.imageUrl}
      alt=""
      fill
      sizes={sizes}
      priority={priority}
      unoptimized
      onError={() => reportImageFailure(card.id)}
    />
  );
}

function CollectorCardFacts({ card, compact = false }: { card: CollectorCard; compact?: boolean }) {
  const insuredValue = formatCollectorUsd(card.insuredValueUsd);

  return (
    <dl className={compact ? "collector-card-facts is-compact" : "collector-card-facts"}>
      <div>
        <dt>YEAR</dt>
        <dd>{card.year ?? "—"}</dd>
      </div>
      <div>
        <dt>GRADE</dt>
        <dd>{card.gradingCompany} {card.grade}</dd>
      </div>
      <div>
        <dt>RARITY</dt>
        <dd>{card.rarity}</dd>
      </div>
      {insuredValue ? (
        <div>
          <dt>INSURED</dt>
          <dd>{insuredValue}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function HeroCollectorCards() {
  const { cards } = useCollectorCards();
  const [activeIndex, setActiveIndex] = useState(0);
  const [rotationEpoch, setRotationEpoch] = useState(0);
  const normalizedActiveIndex = cards.length === 0 ? 0 : activeIndex % cards.length;

  useEffect(() => {
    if (cards.length < 2) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timeout = 0;

    const clearRotation = () => window.clearTimeout(timeout);
    const scheduleRotation = () => {
      clearRotation();
      if (reducedMotion.matches || document.hidden) return;
      timeout = window.setTimeout(() => {
        setActiveIndex((current) => (current + 1) % cards.length);
        scheduleRotation();
      }, HERO_ROTATION_MS);
    };
    const handleMotionPreference = () => {
      if (reducedMotion.matches) setActiveIndex(0);
      scheduleRotation();
    };

    scheduleRotation();
    document.addEventListener("visibilitychange", scheduleRotation);
    reducedMotion.addEventListener?.("change", handleMotionPreference);

    return () => {
      clearRotation();
      document.removeEventListener("visibilitychange", scheduleRotation);
      reducedMotion.removeEventListener?.("change", handleMotionPreference);
    };
  }, [cards.length, rotationEpoch]);

  const showCard = (direction: -1 | 1) => {
    if (cards.length < 2) return;
    setActiveIndex((current) => (current + direction + cards.length) % cards.length);
    setRotationEpoch((current) => current + 1);
  };

  if (cards.length === 0) {
    return (
      <div className="collector-hero" data-collector-autoplay={HERO_ROTATION_MS}>
        <div className="collector-unavailable" role="status">
          COLLECTOR CRYPT INVENTORY UNAVAILABLE
        </div>
      </div>
    );
  }

  const { activeCard, backgroundCards } = selectCollectorPresentation(
    cards,
    normalizedActiveIndex,
    3,
  );
  if (!activeCard) return null;

  return (
    <div
      className="collector-hero"
      role="group"
      aria-roledescription="carousel"
      aria-label={describeCollectorCard(activeCard)}
      data-collector-autoplay={HERO_ROTATION_MS}
      data-active-card={activeCard.id}
    >
      <div className="collector-fan" aria-hidden="true">
        {backgroundCards.map((card, index) => (
          <div className="collector-fan-card" data-fan-position={index + 1} key={card.id}>
            <CollectorCardImage card={card} sizes="(min-width: 1024px) 190px, 32vw" />
          </div>
        ))}
      </div>

      <div className="collector-active-frame" key={activeCard.id}>
        <span className="collector-source-label">COLLECTOR CRYPT INVENTORY</span>
        <div className="collector-active-card">
          <CollectorCardImage
            card={activeCard}
            priority
            sizes="(min-width: 1024px) 230px, (min-width: 761px) 32vw, 52vw"
          />
        </div>
        <div className="collector-card-identity">
          <strong>{activeCard.name}</strong>
          <span>{activeCard.set}</span>
        </div>
        <CollectorCardFacts card={activeCard} />
      </div>

      <div className="collector-controls">
        <button
          type="button"
          aria-label="Show previous Collector Crypt inventory card"
          onClick={() => showCard(-1)}
          disabled={cards.length < 2}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <span className="collector-position" aria-hidden="true">
          {String(normalizedActiveIndex + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}
        </span>
        <button
          type="button"
          aria-label="Show next Collector Crypt inventory card"
          onClick={() => showCard(1)}
          disabled={cards.length < 2}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="collector-route-label" aria-label="Ethereum swap to pack to card to USDC">
        ETH SWAP → PACK → CARD → USDC
      </div>
    </div>
  );
}

const journeyStateLabels: Record<CollectorJourneyState, string> = {
  destination: "A Collector Crypt Gacha pack is the next destination of the route.",
  charging: "Yellow energy charges toward the Collector Crypt Gacha pack destination.",
  bridged: "The Collector Crypt Gacha pack destination activates in the Solana lane.",
  opened: "A Collector Crypt Gacha pack reveals the inventory example.",
  buyback: "The same card remains visible beside illustrative instant buyback data.",
  payout: "The card recedes while automatic USDC payout takes priority.",
};

export function JourneyCollectorCardViewport({ state }: { state: CollectorJourneyState }) {
  const { cards } = useCollectorCards();
  const card = cards[0];

  if (!card) {
    return (
      <div className="journey-collector-viewport is-unavailable" data-collector-state={state}>
        <div className="collector-unavailable" role="status">
          COLLECTOR CRYPT INVENTORY UNAVAILABLE
        </div>
      </div>
    );
  }

  const buybackPercent = formatCollectorPercent(card.instantBuybackPercent);
  const illustrativeReturn = formatIllustrativeBuyback(card);

  return (
    <div
      className="journey-collector-viewport"
      data-collector-state={state}
      role="group"
      aria-label={`${journeyStateLabels[state]} ${describeCollectorCard(card)}`}
    >
      <div className="collector-lane-label">
        <span>ETH</span>
        <i aria-hidden="true" />
        <strong>COLLECTOR CRYPT</strong>
        <i aria-hidden="true" />
        <span>SOLANA</span>
      </div>
      <div className="journey-collector-energy" aria-hidden="true" />
      <div className="journey-pack-target" aria-hidden="true">
        <div className="journey-pack-icon">
          <span>PACK</span>
        </div>
        <div className="journey-pack-copy">
          <span>NEXT ROUTE DESTINATION</span>
          <strong>COLLECTOR CRYPT GACHA PACK</strong>
          <small>Pack destination — not an opened result</small>
        </div>
      </div>
      <div className="journey-card-frame">
        <div className="journey-card-image">
          <CollectorCardImage card={card} sizes="(min-width: 861px) 180px, 128px" />
        </div>
        <div className="journey-card-details">
          <strong>{card.name}</strong>
          <span>{card.set}</span>
          <CollectorCardFacts card={card} compact />
        </div>
      </div>
      <div className="journey-buyback-panel" aria-hidden={state !== "buyback"}>
        <span>INSTANT BUYBACK</span>
        {buybackPercent ? <strong>{buybackPercent} OF INSURED VALUE</strong> : null}
        {illustrativeReturn ? <small>Illustrative return: {illustrativeReturn}</small> : null}
      </div>
      <div className="journey-payout-panel" aria-hidden={state !== "payout"}>
        <span>AUTOMATIC USDC PAYOUT</span>
        <strong>ELIGIBLE HOLDERS RECEIVE ROUTED USDC</strong>
        <small>No claim required. Amounts are not promised.</small>
      </div>
    </div>
  );
}
