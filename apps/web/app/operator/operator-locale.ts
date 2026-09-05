const GERMAN_USDC_PATTERN = /^(0|[1-9]\d*)(?:,(\d{1,6}))?$/;
const CANONICAL_MONEY_PATTERN = /^(0|[1-9]\d*)$/;
const SIGNED_MONEY_PATTERN = /^-?(0|[1-9]\d*)$/;

const GERMAN_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  active: "Aktiv",
  paused: "Pausiert",
  standard: "Standard",
  community: "Manuelle Packauswahl",
  fresh: "Aktuell",
  stale: "Veraltet",
  unavailable: "Nicht verfügbar",
  waiting: "Wartet auf den nächsten Zyklus",
  "collecting-fees": "Gebühren werden erfasst",
  "fees-ready": "Gebühren erfasst",
  "bridging-to-solana": "Transfer zu Solana läuft",
  "solana-funded": "Solana-Wallet finanziert",
  "opening-packs": "Packs werden geöffnet",
  "awaiting-buybacks": "Buybacks werden bestätigt",
  "ready-to-return": "Rücktransfer wird vorbereitet",
  "bridging-to-ethereum": "Rücktransfer zu Ethereum läuft",
  "rewards-funded": "Holder Rewards finanziert",
  settling: "Ausschüttung läuft",
  skipped: "Übersprungen",
  complete: "Abgeschlossen",
  accumulating: "Wird gesammelt",
  "input-captured": "Eingang erfasst",
  "pack-plan-ready": "Packplan bereit",
  buying: "Kauf läuft",
  "collector-complete": "Collector abgeschlossen",
  "outbound-complete": "Ausgehender Transfer abgeschlossen",
  "inbound-complete": "Rücktransfer abgeschlossen",
  "allocations-ready": "Zuteilungen bereit",
  "paused-data": "Wegen fehlender Daten pausiert",
  "paused-outbound-shortfall": "Wegen fehlender Deckung pausiert",
  "retained-solana-float": "Auf Solana zurückbehalten",
  ready: "Bereit",
  "public-ready": "Öffentlich bereit",
  "not-due": "Noch nicht fällig",
  running: "Läuft",
  success: "Erfolgreich",
  failed: "Fehlgeschlagen",
  prepared: "Vorbereitet",
  broadcast: "Gesendet",
  funded: "Finanziert",
  reconciled: "Abgeglichen",
  "reconciled-with-queue": "Mit Warteschlange abgeglichen",
  computed: "Berechnet",
  pending: "Ausstehend",
  "not-executed": "Nicht ausgeführt",
  "not-computed-in-pack-canary": "Im Pack-Test nicht berechnet",
  accepted: "Angenommen",
  rejected: "Abgelehnt",
  activate: "Aktivieren",
  pause: "Pausieren",
  "skip-next-cycle": "Nächsten Zyklus überspringen",
  "run-cycle-now": "Zyklus jetzt starten",
  "update-configuration": "Konfiguration ändern",
  "outbound-burn": "Ausgehender Burn",
  "outbound-mint": "Ausgehendes Minting",
  "inbound-burn": "Rücktransfer-Burn",
  "inbound-finalization": "Rücktransfer abgeschlossen",
  "collector-purchase": "Collector-Kauf",
  "collector-buyback": "Collector-Buyback",
  "reward-settlement": "Holder-Rewards-Ausschüttung",
  CONFIGURATION_INCOMPLETE: "Konfiguration ist unvollständig",
  CATALOG_STALE: "Packkatalog ist veraltet oder nicht erreichbar",
  COMMUNITY_PACK_UNAVAILABLE: "Ein ausgewähltes Pack ist nicht verfügbar",
  COMMUNITY_PACK_PRICE_EXCEEDED: "Ein ausgewähltes Pack überschreitet den Höchstpreis",
  COMMUNITY_PACK_PRICE_EXCEEDS_LIMIT: "Ein ausgewähltes Pack überschreitet den Höchstpreis",
  COMMUNITY_PACK_DUPLICATE: "Ein Pack wurde mehrfach ausgewählt",
  COMMUNITY_PACK_REQUIRED: "Mindestens ein Pack muss ausgewählt werden",
  MANUAL_PACK_STOCK_EXCEEDED: "Die gewählte Menge überschreitet den verfügbaren Bestand",
  MANUAL_PACK_BUDGET_EXCEEDED: "Die Packauswahl überschreitet das Zyklusbudget",
  MANUAL_PACK_QUANTITY_INVALID: "Die Packmenge ist ungültig",
  MANUAL_PACK_REQUIRED: "Mindestens eine Packmenge ist erforderlich",
  MANUAL_PACK_SELECTION_MISMATCH: "Packauswahl und Mengen stimmen nicht überein",
  STANDARD_PACK_SELECTION_FORBIDDEN: "Im Automatikmodus ist keine feste Packauswahl erlaubt",
  CYCLE_INTERVAL_INVALID: "Das Zyklusintervall ist ungültig",
  MAX_BOOSTERS_INVALID: "Die maximale Boosterzahl ist ungültig",
  MAX_BOOSTERS_HARD_CAP_EXCEEDED: "Die Booster-Obergrenze wurde überschritten",
  MAX_UNIT_PRICE_INVALID: "Der maximale Packpreis ist ungültig",
  MAX_UNIT_PRICE_HARD_CAP_EXCEEDED: "Die Obergrenze für den Packpreis wurde überschritten",
  MAX_CYCLE_BUDGET_INVALID: "Das Zyklusbudget ist ungültig",
  MAX_CYCLE_BUDGET_HARD_CAP_EXCEEDED: "Die Obergrenze für das Zyklusbudget wurde überschritten",
  MAX_24_HOUR_BUDGET_INVALID: "Das 24-Stunden-Budget ist ungültig",
  MAX_24_HOUR_BUDGET_HARD_CAP_EXCEEDED: "Die Obergrenze für das 24-Stunden-Budget wurde überschritten",
  BUDGET_ORDER_INVALID: "Die Budgetgrenzen sind widersprüchlich",
  DECISION_ACCEPTED: "Entscheidung angenommen",
  DECISION_SHAPE_INVALID: "Entscheidung ist ungültig aufgebaut",
  DECISION_TYPE_INVALID: "Entscheidungsart ist ungültig",
  OPERATOR_CONFIGURATION_INVALID: "Konfiguration ist ungültig",
  OPERATOR_EXECUTION_PAUSED: "Ausführung ist pausiert",
  OPERATOR_ROLE_REQUIRED: "Diese Identität besitzt nur Leserechte",
  OPERATOR_STATE_VERSION_CONFLICT: "Der Stand hat sich geändert",
  OPERATOR_PERSISTENCE_UNAVAILABLE: "Steuerungsdatenbank ist vorübergehend nicht erreichbar",
  OPERATOR_CONTROL_UNAVAILABLE: "Private Steuerung ist vorübergehend nicht erreichbar",
  OPERATOR_DASHBOARD_UNAVAILABLE: "Dashboard ist vorübergehend nicht erreichbar",
  OPERATOR_QUERY_INVALID: "Filterabfrage ist ungültig",
  OPERATOR_BODY_INVALID: "Entscheidungsdaten sind ungültig",
  OPERATOR_BODY_TOO_LARGE: "Entscheidungsdaten sind zu groß",
  OPERATOR_NOTE_INVALID: "Entscheidungsnotiz ist ungültig",
  OPERATOR_REQUEST_ID_COLLISION: "Diese Anfragekennung wurde bereits anders verwendet",
  ACCESS_ASSERTION_REQUIRED: "Cloudflare-Access-Anmeldung ist erforderlich",
  ACCESS_ASSERTION_INVALID: "Cloudflare-Access-Anmeldung ist ungültig",
});

export function parseGermanUsdc(value: string): string {
  const match = GERMAN_USDC_PATTERN.exec(value);
  if (!match) throw new Error("USDC_BETRAG_UNGUELTIG");
  const fractional = (match[2] ?? "").padEnd(6, "0");
  return (BigInt(match[1]) * 1_000_000n + BigInt(fractional || "0")).toString();
}

export function formatGermanUsdc(value: string): string {
  if (!SIGNED_MONEY_PATTERN.test(value) || value === "-0") {
    throw new Error("USDC_WERT_UNGUELTIG");
  }
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const amount = BigInt(digits);
  const whole = amount / 1_000_000n;
  const rawFraction = (amount % 1_000_000n).toString().padStart(6, "0");
  const fraction = rawFraction.replace(/0+$/, "").padEnd(2, "0");
  const wholeLabel = new Intl.NumberFormat("de-DE", { useGrouping: true }).format(whole);
  return `${negative ? "−" : ""}${wholeLabel},${fraction} USDC`;
}

export function cardResultMicroUsdc(
  packPriceMicroUsdc: string | null,
  buybackMicroUsdc: string | null,
): string | null {
  if (packPriceMicroUsdc === null || buybackMicroUsdc === null) return null;
  if (
    !CANONICAL_MONEY_PATTERN.test(packPriceMicroUsdc) ||
    !CANONICAL_MONEY_PATTERN.test(buybackMicroUsdc)
  ) throw new Error("USDC_WERT_UNGUELTIG");
  return (BigInt(buybackMicroUsdc) - BigInt(packPriceMicroUsdc)).toString();
}

export function formatGermanDate(value: string): string {
  if (typeof value !== "string" || value.length !== 24) throw new Error("DATUM_UNGUELTIG");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("DATUM_UNGUELTIG");
  }
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")}, ${part("hour")}:${part("minute")}`;
}

export function germanStatus(code: string | null | undefined): string {
  return typeof code === "string" && GERMAN_STATUS_LABELS[code]
    ? GERMAN_STATUS_LABELS[code]
    : "Unbekannter Status";
}
