export type CollectorRarity = "common" | "uncommon" | "rare" | "epic";

export type CollectorCard = {
  id: string;
  name: string;
  description: string;
  year?: number;
  set: string;
  rarity: CollectorRarity;
  gradingCompany: string;
  grade: string;
  imageUrl: string;
  insuredValueUsd?: number;
  instantBuybackPercent?: number;
  sourceLabel: "Collector Crypt inventory";
};

export type NormalizeCollectorCardsOptions = {
  instantBuybackPercent?: number;
  limit?: number;
};

export function prioritizeCollectorCards(cards: readonly CollectorCard[]): CollectorCard[] {
  const valueRank = (card: CollectorCard) => {
    const value = card.insuredValueUsd;
    return value !== undefined && Number.isFinite(value) && value > 0
      ? value
      : Number.NEGATIVE_INFINITY;
  };

  return cards
    .map((card, index) => ({ card, index }))
    .sort((left, right) => {
      const leftValue = valueRank(left.card);
      const rightValue = valueRank(right.card);

      return rightValue - leftValue || left.index - right.index;
    })
    .map(({ card }) => card);
}

export type CollectorPresentation = {
  activeCard?: CollectorCard;
  backgroundCards: CollectorCard[];
};

export function selectCollectorPresentation(
  cards: readonly CollectorCard[],
  activeIndex: number,
  fanCount = 3,
): CollectorPresentation {
  const seenIds = new Set<string>();
  const seenImages = new Set<string>();
  const uniqueCards: CollectorCard[] = [];

  for (const card of cards) {
    const id = card.id.trim();
    const imageUrl = card.imageUrl.trim();
    if (!id || !imageUrl || seenIds.has(id) || seenImages.has(imageUrl)) continue;

    seenIds.add(id);
    seenImages.add(imageUrl);
    uniqueCards.push(card);
  }

  const deck = prioritizeCollectorCards(uniqueCards);
  if (deck.length === 0) return { backgroundCards: [] };

  const index = ((Math.trunc(activeIndex) % deck.length) + deck.length) % deck.length;
  const activeCard = deck[index];
  const backgroundCards: CollectorCard[] = [];
  const backgroundLimit = Math.min(
    Math.max(Math.trunc(fanCount), 0),
    Math.max(deck.length - 1, 0),
  );

  for (let offset = 1; offset < deck.length && backgroundCards.length < backgroundLimit; offset += 1) {
    const candidate = deck[(index + offset) % deck.length];
    if (!candidate || candidate.id === activeCard.id || candidate.imageUrl === activeCard.imageUrl) {
      continue;
    }
    backgroundCards.push(candidate);
  }

  return { activeCard, backgroundCards };
}

export const FALLBACK_COLLECTOR_CARDS: readonly CollectorCard[] = prioritizeCollectorCards([
  {
    id: "3ygMpX5LaQv3XZKxA2CUTmMkdT5a8sjENvQybGp4XeJc",
    name: "2003 #25 Politoed-Reverse Foil",
    description: "2003 #25 Politoed-Reverse Foil PSA 8 Skyridge Pokémon",
    year: 2003,
    set: "Skyridge",
    rarity: "rare",
    gradingCompany: "PSA",
    grade: "8",
    imageUrl:
      "https://d1xpxki1g4htqu.cloudfront.net/flZJOWzoDcSgRBgSnp83sHWaWyXeLj9QtoXIoKJ-d64",
    insuredValueUsd: 245,
    instantBuybackPercent: 85,
    sourceLabel: "Collector Crypt inventory",
  },
  {
    id: "FgM3Mte1ALNk2nYs5PHrr4D6kygRFqguMbnCzxFZLQmb",
    name: "2005 #10 Marowak-Reverse Foil",
    description: "2005 #10 Marowak-Reverse Foil PSA 9 EX Delta Species",
    year: 2005,
    set: "EX Delta Species",
    rarity: "rare",
    gradingCompany: "PSA",
    grade: "9",
    imageUrl:
      "https://d1xpxki1g4htqu.cloudfront.net/PpV49vGYTi_b3JiUjw16AQ6BfFLGUiAZLccUk4I1ZJI",
    insuredValueUsd: 245,
    instantBuybackPercent: 85,
    sourceLabel: "Collector Crypt inventory",
  },
  {
    id: "3nASATZjJDUxdyJByK755LzwFHPyoHfKxcCVnujqLB1F",
    name: "2006 #104 Pikachu-Holo Gold Star",
    description: "2006 #104 Pikachu-Holo Gold Star PSA 3 EX Holon Phantoms",
    year: 2006,
    set: "EX Holon Phantoms",
    rarity: "epic",
    gradingCompany: "PSA",
    grade: "3",
    imageUrl:
      "https://d1xpxki1g4htqu.cloudfront.net/aadDND0fgpLo4faBw6YraAoWmdNsWf5DAmgu9Ah1Rhk",
    insuredValueUsd: 3850,
    instantBuybackPercent: 85,
    sourceLabel: "Collector Crypt inventory",
  },
  {
    id: "3WF842wuU21fT39Pho9EJTHcNZvRr8wCp3Ch2mzygMt9",
    name: "2024 #185 Applin",
    description: "2024 #185 Applin PSA 10 Twilight Masquerade Pokémon",
    year: 2024,
    set: "Twilight Masquerade",
    rarity: "uncommon",
    gradingCompany: "PSA",
    grade: "10",
    imageUrl:
      "https://d1xpxki1g4htqu.cloudfront.net/SMKsJfdE9atnERKUu8wUniO1yzEUBIWXsvnu-WWNHa4",
    insuredValueUsd: 109,
    instantBuybackPercent: 85,
    sourceLabel: "Collector Crypt inventory",
  },
  {
    id: "3QdHe8z3zJUKEGkkMET5JfqfcF5e5HkaE5s26hSmh3xp",
    name: "2025 #022 Meloetta",
    description: "2025 #022 Meloetta PSA 10 Mega Starter Set Mega Diancie EX",
    year: 2025,
    set: "Mega Starter Set Mega Diancie EX",
    rarity: "common",
    gradingCompany: "PSA",
    grade: "10",
    imageUrl:
      "https://d1xpxki1g4htqu.cloudfront.net/o0TyviEjd6M1LFykIh_V-MuDSo-ORg8m9nu3iPrn6A4",
    insuredValueUsd: 59,
    instantBuybackPercent: 85,
    sourceLabel: "Collector Crypt inventory",
  },
]);

type UnknownRecord = Record<string, unknown>;

const COLLECTOR_RARITIES = new Set<CollectorRarity>([
  "common",
  "uncommon",
  "rare",
  "epic",
]);

export function normalizeCollectorCards(
  payload: unknown,
  { instantBuybackPercent, limit = 12 }: NormalizeCollectorCardsOptions = {},
): CollectorCard[] {
  const cardLimit = Math.min(Math.max(Math.trunc(limit), 0), 12);
  if (cardLimit === 0) return [];

  const seenIds = new Set<string>();
  const seenImages = new Set<string>();
  const cards: CollectorCard[] = [];

  for (const value of readCardArray(payload)) {
    const card = normalizeOneCard(value, instantBuybackPercent);
    if (!card) continue;

    const imageKey = card.imageUrl.trim();
    if (seenIds.has(card.id) || seenImages.has(imageKey)) continue;

    seenIds.add(card.id);
    seenImages.add(imageKey);
    cards.push(card);
    if (cards.length === cardLimit) break;
  }

  return prioritizeCollectorCards(cards);
}

export function formatCollectorUsd(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCollectorPercent(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 100) {
    return undefined;
  }

  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function formatIllustrativeBuyback(card: CollectorCard): string | undefined {
  const { insuredValueUsd, instantBuybackPercent } = card;
  if (
    insuredValueUsd === undefined ||
    instantBuybackPercent === undefined ||
    !Number.isFinite(insuredValueUsd) ||
    !Number.isFinite(instantBuybackPercent) ||
    insuredValueUsd <= 0 ||
    instantBuybackPercent <= 0 ||
    instantBuybackPercent > 100
  ) {
    return undefined;
  }

  return formatCollectorUsd((insuredValueUsd * instantBuybackPercent) / 100);
}

export function describeCollectorCard(card: CollectorCard): string {
  const facts = [
    card.name,
    card.year ? String(card.year) : undefined,
    `${card.gradingCompany} ${card.grade}`,
    card.rarity,
    formatCollectorUsd(card.insuredValueUsd)
      ? `insured value ${formatCollectorUsd(card.insuredValueUsd)}`
      : undefined,
  ].filter(Boolean);

  return `${card.sourceLabel}: ${facts.join(", ")}. Inventory example, not a guaranteed reward.`;
}

function normalizeOneCard(value: unknown, machineBuybackPercent?: number): CollectorCard | null {
  const card = asRecord(value);
  if (!card) return null;

  const id = cleanString(card.nft_address ?? card.id, 96);
  const name = cleanString(card.name, 140);
  const description = cleanString(card.description, 320) ?? name;
  const imageUrl = readImageUrl(card);
  const rarityValue = cleanString(card.rarity, 16)?.toLowerCase() as CollectorRarity | undefined;
  const attributes = readAttributes(card.attributes);
  const gradingCompany =
    cleanString(card.gradingCompany, 24) ?? cleanString(attributes.get("grading company"), 24);
  const grade = readGrade(card, attributes);
  const year = readYear(card, description, name, attributes);
  const set = readSet(card, description, gradingCompany, grade, attributes);

  if (
    !id ||
    !name ||
    !description ||
    !imageUrl ||
    !rarityValue ||
    !COLLECTOR_RARITIES.has(rarityValue) ||
    !gradingCompany ||
    !grade ||
    !year ||
    !set
  ) {
    return null;
  }

  const insuredValueUsd = positiveNumber(
    card.insuredValueUsd ?? card.insured_value ?? attributes.get("insured value"),
  );
  const instantBuybackPercent = percentNumber(
    card.instantBuybackPercent ?? machineBuybackPercent,
  );

  return {
    id,
    name,
    description,
    year,
    set,
    rarity: rarityValue,
    gradingCompany,
    grade,
    imageUrl,
    ...(insuredValueUsd === undefined ? {} : { insuredValueUsd }),
    ...(instantBuybackPercent === undefined ? {} : { instantBuybackPercent }),
    sourceLabel: "Collector Crypt inventory",
  };
}

function readCardArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ["nfts", "cards", "items"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function readAttributes(value: unknown): Map<string, unknown> {
  const attributes = new Map<string, unknown>();
  if (!Array.isArray(value)) return attributes;

  for (const entry of value) {
    const attribute = asRecord(entry);
    const trait = cleanString(attribute?.trait_type ?? attribute?.traitType, 64)?.toLowerCase();
    if (trait) attributes.set(trait, attribute?.value);
  }

  return attributes;
}

function readImageUrl(card: UnknownRecord): string | undefined {
  const direct = cleanString(card.imageUrl ?? card.image, 500);
  if (isHttpsUrl(direct)) return direct;

  const content = asRecord(card.content);
  const files = Array.isArray(content?.files) ? content.files : [];
  for (const value of files) {
    const file = asRecord(value);
    const candidate = cleanString(file?.cc_cdn ?? file?.cdn_uri ?? file?.uri, 500);
    if (isHttpsUrl(candidate)) return candidate;
  }

  return undefined;
}

function readGrade(card: UnknownRecord, attributes: Map<string, unknown>): string | undefined {
  const direct = cleanString(card.grade ?? card.gradeNum ?? attributes.get("gradenum"), 24);
  if (direct && /\d/.test(direct)) return direct.match(/\d+(?:\.\d+)?/)?.[0];

  const described = cleanString(attributes.get("the grade"), 32);
  return described?.match(/\d+(?:\.\d+)?/)?.[0];
}

function readYear(
  card: UnknownRecord,
  description: string | undefined,
  name: string | undefined,
  attributes: Map<string, unknown>,
): number | undefined {
  for (const value of [description, name]) {
    const match = value?.match(/\b(?:19|20)\d{2}\b/);
    if (match) return Number(match[0]);
  }

  const candidate = Number(card.year ?? card.cardYear ?? attributes.get("year"));
  return Number.isSafeInteger(candidate) && candidate >= 1900 && candidate <= 2100
    ? candidate
    : undefined;
}

function readSet(
  card: UnknownRecord,
  description: string | undefined,
  gradingCompany: string | undefined,
  grade: string | undefined,
  attributes: Map<string, unknown>,
): string | undefined {
  const direct = cleanString(
    card.set ?? card.series ?? card.collection ?? attributes.get("set"),
    96,
  );
  if (direct) return direct;
  if (!description || !gradingCompany || !grade) return undefined;

  const marker = new RegExp(
    `${escapeRegExp(gradingCompany)}\\s+(?:(?:GEM-MT|MINT|NM-MT|EX-MT|VG|NM)\\s+)?${escapeRegExp(grade)}\\s+(.+)$`,
    "i",
  );
  const tail = description.match(marker)?.[1]
    ?.replace(/\s+Pok[eé]mon$/i, "")
    .trim();
  return cleanString(tail, 96);
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function percentNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100 ? number : undefined;
}

function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
