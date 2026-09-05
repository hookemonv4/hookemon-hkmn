"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  cardResultMicroUsdc,
  formatGermanDate,
  formatGermanUsdc,
  parseGermanUsdc,
} from "./operator-locale";
import type {
  CardHistoryCard,
  CardHistoryFilters,
  CardHistoryResponse,
  CardHistorySort,
  DashboardCard,
} from "./operator-types";
import styles from "./operator.module.css";

const EMPTY_FILTERS: CardHistoryFilters = {
  productId: "",
  rarity: "",
  from: "",
  to: "",
  minBuyback: "",
  maxBuyback: "",
};
const CARD_RESPONSE_KEYS = new Set(["cards", "nextCursor", "historyComplete"]);
const CARD_KEYS = new Set([
  "cycleId",
  "packIndex",
  "observedAt",
  "productId",
  "rarity",
  "nftAddress",
  "cardName",
  "setName",
  "cardNumber",
  "imageUrl",
  "packPriceMicroUsdc",
  "buybackMicroUsdc",
]);

export default function OperatorCardHistory({
  liveCards,
  activeCycleId,
}: {
  liveCards: DashboardCard[];
  activeCycleId: string | null;
}) {
  const [filters, setFilters] = useState<CardHistoryFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<CardHistorySort>("recent");
  const [appliedFilters, setAppliedFilters] = useState<CardHistoryFilters>(EMPTY_FILTERS);
  const [appliedSort, setAppliedSort] = useState<CardHistorySort>("recent");
  const [cards, setCards] = useState<CardHistoryCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const requestPage = useCallback(async ({
    cursor,
    selectedFilters,
    selectedSort,
    append,
  }: {
    cursor: string | null;
    selectedFilters: CardHistoryFilters;
    selectedSort: CardHistorySort;
    append: boolean;
  }) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const parameters = cardHistoryParameters(selectedFilters, selectedSort, cursor);
      const query = [...parameters.entries()]
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
      const response = await fetch(`/operator/api/cards?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = decodeCardHistoryResponse(await response.json());
      if (!response.ok) throw new Error("Kartenhistorie ist vorübergehend nicht erreichbar.");
      setCards((current) => append ? deduplicatedCards([...current, ...body.cards]) : body.cards);
      setNextCursor(body.nextCursor);
      setHistoryComplete(body.historyComplete);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(requestError instanceof Error
        ? requestError.message
        : "Kartenhistorie ist vorübergehend nicht erreichbar.");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const initialRequest = window.setTimeout(() => {
      void requestPage({
        cursor: null,
        selectedFilters: EMPTY_FILTERS,
        selectedSort: "recent",
        append: false,
      });
    }, 0);
    return () => {
      window.clearTimeout(initialRequest);
      requestRef.current?.abort();
    };
  }, [requestPage]);

  const liveCard = activeCycleId === null
    ? null
    : liveCards.find((card) => card.cycleId === activeCycleId) ?? null;

  async function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      cardHistoryParameters(filters, sort, null);
    } catch {
      setError("Bitte Buyback-Werte als deutsche USDC-Beträge eingeben, zum Beispiel 12,50.");
      return;
    }
    const selectedFilters = { ...filters };
    setAppliedFilters(selectedFilters);
    setAppliedSort(sort);
    await requestPage({ cursor: null, selectedFilters, selectedSort: sort, append: false });
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS);
    setSort("recent");
    setAppliedFilters(EMPTY_FILTERS);
    setAppliedSort("recent");
    void requestPage({
      cursor: null,
      selectedFilters: EMPTY_FILTERS,
      selectedSort: "recent",
      append: false,
    });
  }

  return (
    <section className={styles.cardHistoryShell} aria-label="Karten und Kartenhistorie">
      <div className={styles.cardHistoryHeading}>
        <div>
          <span>Live</span>
          <h2>Live gezogene Karten</h2>
        </div>
        <p>Bestätigte Kartendaten des laufenden Zyklus erscheinen hier automatisch.</p>
      </div>

      {liveCard ? (
        <CardFocus card={liveCard} title="Zuletzt live bestätigt" />
      ) : (
        <p className={styles.cardHistoryEmpty}>
          Im laufenden Zyklus wurde noch keine Karte bestätigt.
        </p>
      )}

      <div className={styles.cardHistoryHeading}>
        <div>
          <span>Archiv</span>
          <h2>Kartenhistorie</h2>
        </div>
        <p>Dauerhaft gespeicherte, bestätigte Karten nach Zyklus, Pack und Buyback filtern.</p>
      </div>

      <form className={styles.cardFilterGrid} onSubmit={applyFilters}>
        <FilterField label="Produkt-ID">
          <input
            value={filters.productId}
            onChange={(event) => setFilters((current) => ({ ...current, productId: event.target.value }))}
          />
        </FilterField>
        <FilterField label="Seltenheit">
          <input
            value={filters.rarity}
            onChange={(event) => setFilters((current) => ({ ...current, rarity: event.target.value }))}
          />
        </FilterField>
        <FilterField label="Von">
          <input
            type="datetime-local"
            value={filters.from}
            onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
          />
        </FilterField>
        <FilterField label="Bis">
          <input
            type="datetime-local"
            value={filters.to}
            onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
          />
        </FilterField>
        <FilterField label="Mindest-Buyback">
          <input
            inputMode="decimal"
            placeholder="0,00"
            value={filters.minBuyback}
            onChange={(event) => setFilters((current) => ({ ...current, minBuyback: event.target.value }))}
          />
        </FilterField>
        <FilterField label="Höchst-Buyback">
          <input
            inputMode="decimal"
            placeholder="100,00"
            value={filters.maxBuyback}
            onChange={(event) => setFilters((current) => ({ ...current, maxBuyback: event.target.value }))}
          />
        </FilterField>
        <FilterField label="Sortierung">
          <select value={sort} onChange={(event) => setSort(event.target.value as CardHistorySort)}>
            <option value="recent">Neueste zuerst</option>
            <option value="buyback-desc">Buyback absteigend</option>
            <option value="buyback-asc">Buyback aufsteigend</option>
          </select>
        </FilterField>
        <div className={styles.cardFilterActions}>
          <button type="submit" disabled={loading}>Filter anwenden</button>
          <button type="button" disabled={loading} onClick={resetFilters}>Zurücksetzen</button>
        </div>
      </form>

      <div className={styles.cardHistoryToolbar} aria-live="polite">
        <span>{loading ? "Karten werden geladen…" : `${cards.length} Karten geladen`}</span>
        {!historyComplete ? <span>Historischer Import läuft noch.</span> : null}
      </div>
      {error ? <p className={styles.cardHistoryError} role="alert">{error}</p> : null}
      {!loading && !error && cards.length === 0 ? (
        <p className={styles.cardHistoryEmpty}>Keine bestätigten Karten für diese Filter gefunden.</p>
      ) : null}
      {cards.length > 0 ? (
        <div className={styles.cardThumbnailGrid}>
          {cards.map((card) => <HistoryCard key={`${card.cycleId}:${card.packIndex}`} card={card} />)}
        </div>
      ) : null}
      {nextCursor ? (
        <button
          className={styles.cardLoadMore}
          type="button"
          disabled={loading}
          onClick={() => void requestPage({
            cursor: nextCursor,
            selectedFilters: appliedFilters,
            selectedSort: appliedSort,
            append: true,
          })}
        >
          {loading ? "Karten werden geladen…" : "Weitere Karten laden"}
        </button>
      ) : null}
    </section>
  );
}

function CardFocus({ card, title }: { card: DashboardCard; title: string }) {
  return (
    <article className={styles.focusedCard}>
      <div className={styles.focusedCardImage}>
        {card.imageUrl ? (
          <Image src={card.imageUrl} alt="" width={420} height={588} unoptimized />
        ) : <span>Kein Kartenbild bestätigt</span>}
      </div>
      <div className={styles.focusedCardContent}>
        <span>{title}</span>
        <h3>{card.cardName ?? "Noch nicht bestätigt"}</h3>
        <CardFacts card={card} />
      </div>
    </article>
  );
}

function HistoryCard({ card }: { card: CardHistoryCard }) {
  return (
    <article className={styles.historyCard}>
      <div className={styles.historyCardImage}>
        {card.imageUrl ? (
          <Image src={card.imageUrl} alt="" width={240} height={336} unoptimized />
        ) : <span>Kein Kartenbild bestätigt</span>}
      </div>
      <div>
        <strong>{card.cardName ?? "Noch nicht bestätigt"}</strong>
        <span>{formatGermanDate(card.observedAt)}</span>
        <CardResult card={card} />
        <details className={styles.cardTechnicalDetails}>
          <summary>Alle Kartendaten</summary>
          <CardFacts card={card} packIndex={card.packIndex} />
        </details>
      </div>
    </article>
  );
}

function CardFacts({ card, packIndex }: { card: DashboardCard; packIndex?: number }) {
  const pending = "Noch nicht bestätigt";
  return (
    <dl className={styles.cardFacts}>
      <div><dt>Set</dt><dd>{card.setName ?? pending}</dd></div>
      <div><dt>Kartennummer</dt><dd>{card.cardNumber ?? pending}</dd></div>
      <div><dt>Seltenheit</dt><dd>{card.rarity || pending}</dd></div>
      <div><dt>Produkt-ID</dt><dd>{card.productId}</dd></div>
      <div><dt>Packpreis</dt><dd>{moneyOrPending(card.packPriceMicroUsdc)}</dd></div>
      <div><dt>Buyback</dt><dd>{moneyOrPending(card.buybackMicroUsdc)}</dd></div>
      <div><dt>Ergebnis</dt><dd><CardResult card={card} /></dd></div>
      <div><dt>NFT-Adresse</dt><dd>{card.nftAddress ?? pending}</dd></div>
      <div><dt>Zyklus-ID</dt><dd>{card.cycleId}</dd></div>
      {packIndex === undefined ? null : <div><dt>Pack-Index</dt><dd>{packIndex + 1}</dd></div>}
    </dl>
  );
}

function CardResult({ card }: { card: DashboardCard }) {
  const result = cardResultMicroUsdc(card.packPriceMicroUsdc, card.buybackMicroUsdc);
  if (result === null) return <span>Noch nicht bestätigt</span>;
  const tone = BigInt(result) > 0n ? "positive" : BigInt(result) < 0n ? "negative" : "neutral";
  return <span className={styles.cardResultBadge} data-tone={tone}>{formatGermanUsdc(result)}</span>;
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label><span>{label}</span>{children}</label>;
}

function cardHistoryParameters(
  filters: CardHistoryFilters,
  sort: CardHistorySort,
  cursor: string | null,
) {
  const parameters = new URLSearchParams();
  parameters.set("limit", "24");
  parameters.set("sort", sort);
  if (cursor !== null) parameters.set("cursor", cursor);
  if (filters.productId) parameters.set("productId", filters.productId.trim());
  if (filters.rarity) parameters.set("rarity", filters.rarity.trim());
  if (filters.from) parameters.set("from", new Date(filters.from).toISOString());
  if (filters.to) parameters.set("to", new Date(filters.to).toISOString());
  if (filters.minBuyback) {
    parameters.set("minBuybackMicroUsdc", parseGermanUsdc(filters.minBuyback));
  }
  if (filters.maxBuyback) {
    parameters.set("maxBuybackMicroUsdc", parseGermanUsdc(filters.maxBuyback));
  }
  return parameters;
}

function decodeCardHistoryResponse(value: unknown): CardHistoryResponse {
  if (!plainObject(value) || !hasExactKeys(value, CARD_RESPONSE_KEYS)) invalidCardResponse();
  if (
    !Array.isArray(value.cards) ||
    value.cards.length > 24 ||
    !(value.nextCursor === null ||
      (typeof value.nextCursor === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor))) ||
    typeof value.historyComplete !== "boolean"
  ) invalidCardResponse();
  return {
    cards: value.cards.map(decodeHistoryCard),
    nextCursor: value.nextCursor,
    historyComplete: value.historyComplete,
  };
}

function decodeHistoryCard(value: unknown): CardHistoryCard {
  if (!plainObject(value) || !hasExactKeys(value, CARD_KEYS)) invalidCardResponse();
  const card = {
    cycleId: boundedText(value.cycleId),
    packIndex: value.packIndex,
    observedAt: timestamp(value.observedAt),
    productId: boundedText(value.productId),
    rarity: boundedText(value.rarity),
    nftAddress: nullableText(value.nftAddress),
    cardName: nullableText(value.cardName),
    setName: nullableText(value.setName),
    cardNumber: nullableText(value.cardNumber),
    imageUrl: nullableImage(value.imageUrl),
    packPriceMicroUsdc: nullableMoney(value.packPriceMicroUsdc),
    buybackMicroUsdc: nullableMoney(value.buybackMicroUsdc),
  };
  if (!Number.isSafeInteger(card.packIndex) || card.packIndex < 0 || card.packIndex > 9_999) {
    invalidCardResponse();
  }
  return card as CardHistoryCard;
}

function deduplicatedCards(cards: CardHistoryCard[]) {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.cycleId}:${card.packIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function moneyOrPending(value: string | null) {
  return value === null ? "Noch nicht bestätigt" : formatGermanUsdc(value);
}

function nullableMoney(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) invalidCardResponse();
  return value;
}

function boundedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) invalidCardResponse();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : boundedText(value);
}

function nullableImage(value: unknown): string | null {
  if (value === null) return null;
  const image = boundedText(value);
  try {
    const url = new URL(image);
    if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password) {
      invalidCardResponse();
    }
    return url.toString();
  } catch {
    invalidCardResponse();
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) invalidCardResponse();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalidCardResponse();
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: Set<string>) {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCardResponse(): never {
  throw new Error("Kartenhistorie enthält ungültige Daten.");
}
