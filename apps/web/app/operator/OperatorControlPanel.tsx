"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  decodeCycleStartProjectPool,
} from "../../lib/operator-dashboard-pool";
import type { PublicRoundAccounting } from "../../lib/public-cycle-status";
import OperatorCardHistory from "./OperatorCardHistory";
import {
  formatGermanDate,
  formatGermanUsdc,
  germanStatus,
  parseGermanUsdc,
} from "./operator-locale";
import type { ActiveCycle, DashboardCard } from "./operator-types";
import styles from "./operator.module.css";

type Role = "viewer" | "operator";
type Mode = "standard" | "community";
type ManualPackOrder = { productId: string; quantity: number };

type OperatorState = {
  version: number;
  desiredStatus: "active" | "paused";
  mode: Mode;
  communityPackIds: string[];
  manualPackOrders: ManualPackOrder[];
  maxBoostersPerCycle: number;
  cycleIntervalMinutes: number;
  skipNextCycleSequence: number;
  runNowSequence: number;
  maxUnitPriceMicroUsdc: string | null;
  maxCycleBudgetMicroUsdc: string | null;
  max24HourBudgetMicroUsdc: string | null;
  configurationComplete: boolean;
  executionConnected: boolean;
};

type Pack = {
  id: string;
  name: string;
  priceMicroUsdc: string;
  instantBuybackFloorMicroUsdc?: string;
  expectedBuybackMicroUsdc?: string;
  collectorEconomicCostMicroUsdc?: string;
  available: number;
};

type Bootstrap = {
  identity: { subject: string; email: string; role: Role };
  state: OperatorState;
  hardCaps: {
    maxBoostersPerCycle: string;
    maxUnitPriceMicroUsdc: string;
    maxCycleBudgetMicroUsdc: string;
    max24HourBudgetMicroUsdc: string;
  };
  catalog: { status: string; fetchedAtMs: number; packs: Pack[] } | null;
  readiness: { ready: boolean; reasons: string[] };
  executionConnected: boolean;
};

type DashboardRoundAccounting = PublicRoundAccounting;

type Dashboard = {
  schemaVersion: 4;
  historyComplete: boolean;
  cardHistoryComplete: boolean;
  generatedAt: string;
  nextCycleAt: string | null;
  cycleIntervalMinutes: number;
  execution: { connected: boolean; lastHeartbeatAt: string | null };
  cycleStartProjectPoolObservedAt: string | null;
  latestCompletedAllocationCycleId: string | null;
  metrics: {
    cycleStartProjectPoolMicroUsdc: string | null;
    totalCycleFundingMicroUsdc: string;
    totalCollectorSpendMicroUsdc: string;
    totalBuybacksReturnedMicroUsdc: string;
    totalBridgedBackMicroUsdc: string;
    totalRewardsPaidMicroUsdc: string;
    totalRewardsDeferredMicroUsdc: string;
    totalQuotedOperatingCostsMicroUsdc: string;
    latestRetainedReserveMicroUsdc: string;
    latestCycleReserveTargetMicroUsdc: string;
    completedCycles: number;
    skippedCycles: number;
    openedPacks: number;
  };
  latestCycleTopAllocations: Array<{
    rank: number;
    address: string;
    allocatedMicroUsdc: string;
  }>;
  cards: DashboardCard[];
  activeCycle: ActiveCycle | null;
  latestCycle: {
    cycleId: string;
    status: string;
    reason: string | null;
    updatedAt: string | null;
    paidMicroUsdc: string | null;
    payoutRecipientCount: number;
    roundAccounting: DashboardRoundAccounting | null;
    transactions: Array<{ chain: "ethereum" | "solana"; purpose: string; id: string }>;
  } | null;
};

const DASHBOARD_RESPONSE_INVALID = "Dashboard-Daten sind ungültig oder nicht verfügbar.";
const DASHBOARD_RESPONSE_UNSUPPORTED = "Dashboard-Daten verwenden eine nicht unterstützte Version.";
const DASHBOARD_MONEY_FIELDS = [
  "totalCycleFundingMicroUsdc",
  "totalCollectorSpendMicroUsdc",
  "totalBuybacksReturnedMicroUsdc",
  "totalBridgedBackMicroUsdc",
  "totalRewardsPaidMicroUsdc",
  "totalRewardsDeferredMicroUsdc",
  "totalQuotedOperatingCostsMicroUsdc",
  "latestRetainedReserveMicroUsdc",
  "latestCycleReserveTargetMicroUsdc",
] as const;
const DASHBOARD_CARD_KEYS = new Set([
  "cycleId", "productId", "rarity", "nftAddress", "cardName", "setName", "cardNumber",
  "imageUrl", "packPriceMicroUsdc", "buybackMicroUsdc",
]);
const DASHBOARD_ROUND_KEYS = new Set([
  "packSpendMicroUsdc", "buybackMicroUsdc", "packGainMicroUsdc", "packLossMicroUsdc",
  "quotedCosts", "protectedCostsMicroUsdc", "confirmedCostsMicroUsdc",
  "cycleGainMicroUsdc", "cycleLossMicroUsdc", "walletBalanceBeforeMicroUsdc",
  "walletBalanceAfterMicroUsdc", "networkFees", "feeReserveBeforeMicroUsdc",
  "feeReserveTargetMicroUsdc", "feeReserveTopUpMicroUsdc", "feeReserveAfterMicroUsdc",
  "plannedHolderRewardsMicroUsdc", "paidHolderRewardsMicroUsdc", "holderRewardsStatus",
  "distributionStatus",
]);
const DASHBOARD_QUOTED_COST_KEYS = new Set([
  "outboundBridgeMicroUsdc", "inboundBridgeMicroUsdc", "collectorApiMicroUsdc",
  "ethereumNetworkMicroUsdc", "solanaNetworkMicroUsdc", "slippageMicroUsdc",
]);
const DASHBOARD_NETWORK_FEE_KEYS = new Set(["walletLamportsCharged", "purchase", "buyback"]);
const DASHBOARD_TRANSACTION_PURPOSES = {
  ethereum: new Set(["outbound-burn", "inbound-finalization", "reward-settlement"]),
  solana: new Set(["outbound-mint", "inbound-burn", "collector-purchase", "collector-buyback"]),
} as const;
const ACTIVE_CYCLE_KEYS = new Set([
  "cycleId", "status", "updatedAt", "configurationRevision", "allowedPackIds",
  "requestedOrders", "maxBoostersPerCycle", "maxUnitPriceMicroUsdc",
  "maxCycleBudgetMicroUsdc", "max24HourBudgetMicroUsdc", "revealedCards",
]);

type Decision = {
  sequence: string;
  eventId: string;
  occurredAt: string;
  actor: { email: string };
  actorRole: Role;
  action: string;
  outcome: "accepted" | "rejected";
  resultCode: string;
  observedVersion: number;
  note: string | null;
};

type AuditResponse = {
  code?: string;
  decisions: Decision[];
  nextCursor: string | null;
};

type DecisionResponse = {
  code?: string;
};

type Command =
  | { type: "activate" }
  | { type: "pause" }
  | { type: "skip-next-cycle" }
  | { type: "run-cycle-now" }
  | {
      type: "update-configuration";
      configuration: {
        mode: Mode;
        communityPackIds: string[];
        manualPackOrders: ManualPackOrder[];
        maxBoostersPerCycle: number;
        cycleIntervalMinutes: number;
        maxUnitPriceMicroUsdc: string;
        maxCycleBudgetMicroUsdc: string;
        max24HourBudgetMicroUsdc: string;
      };
    };

type FormState = {
  mode: Mode;
  communityPackIds: string[];
  packQuantities: Record<string, string>;
  maxBoostersPerCycle: string;
  cycleIntervalMinutes: string;
  maxUnitPriceMicroUsdc: string;
  maxCycleBudgetMicroUsdc: string;
  max24HourBudgetMicroUsdc: string;
  note: string;
};

const EMPTY_FORM: FormState = {
  mode: "standard",
  communityPackIds: [],
  packQuantities: {},
  maxBoostersPerCycle: "100",
  cycleIntervalMinutes: "20",
  maxUnitPriceMicroUsdc: "",
  maxCycleBudgetMicroUsdc: "",
  max24HourBudgetMicroUsdc: "",
  note: "",
};

export default function OperatorControlPanel() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [message, setMessage] = useState("Private Steuerung wird geladen…");
  const [error, setError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadAudit = useCallback(async (cursor?: string) => {
    await Promise.resolve();
    setAuditBusy(true);
    try {
      const endpoint = cursor
        ? `/operator/api/audit?limit=25&cursor=${encodeURIComponent(cursor)}`
        : "/operator/api/audit?limit=25";
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = await readJson<AuditResponse>(response);
      if (!response.ok) throw new Error(stableMessage(body.code));
      setDecisions((current) => (cursor ? [...current, ...body.decisions] : body.decisions));
      setNextCursor(body.nextCursor ?? null);
    } catch (auditError) {
      setError(errorMessage(auditError));
    } finally {
      setAuditBusy(false);
    }
  }, []);

  const loadBootstrap = useCallback(async ({ replaceForm = true } = {}) => {
    await Promise.resolve();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/operator/api/bootstrap", { cache: "no-store" });
      const body = await readJson<Bootstrap & { code?: string }>(response);
      if (!response.ok) throw new Error(stableMessage(body.code));
      setBootstrap(body);
      if (replaceForm) setForm(formFromState(body.state));
      setMessage("Private Steuerung ist geladen.");
    } catch (bootstrapError) {
      setError(errorMessage(bootstrapError));
      setMessage("Private Steuerung konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const response = await fetch("/operator/api/dashboard", { cache: "no-store" });
      const body = await readJson<unknown>(response);
      if (!response.ok) throw new Error(stableMessage(responseCode(body)));
      setDashboard(decodeDashboard(body));
      setDashboardError(null);
    } catch (dashboardLoadError) {
      setDashboard(null);
      setDashboardError(errorMessage(dashboardLoadError));
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void Promise.all([loadBootstrap(), loadAudit(), loadDashboard()]);
    }, 0);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1_000);
    const refresh = window.setInterval(() => void loadDashboard(), 10_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(clock);
      window.clearInterval(refresh);
    };
  }, [loadAudit, loadBootstrap, loadDashboard]);

  const readOnly = bootstrap?.identity.role !== "operator";
  const controlsDisabled = loading || busy || readOnly || !bootstrap;
  const catalogPacks = bootstrap?.catalog?.packs ?? [];
  const reservePreview = computeReservePreview(catalogPacks, form);
  const dashboardPlaceholder = dashboardError ? "Nicht verfügbar" : "Wird geladen…";
  const hasUnsavedChanges = bootstrap
    ? configurationSnapshotFromForm(form, catalogPacks) !== configurationSnapshotFromState(bootstrap.state)
    : false;

  function quantityFor(packId: string) {
    const value = Number(form.packQuantities[packId] ?? "0");
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  async function submitCommand(command: Command, successMessage: string) {
    if (!bootstrap || controlsDisabled) return;
    setBusy(true);
    setError(null);
    setMessage("Entscheidung wird protokolliert…");
    try {
      const response = await fetch("/operator/api/decisions", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-hookemon-request": "operator-control",
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: bootstrap.state.version,
          command,
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        }),
      });
      const body = await readJson<DecisionResponse>(response);
      if (!response.ok) throw new Error(stableMessage(body.code));
      setMessage(successMessage);
      await Promise.all([
        loadBootstrap({ replaceForm: command.type === "update-configuration" }),
        loadAudit(),
        loadDashboard(),
      ]);
    } catch (commandError) {
      setError(errorMessage(commandError));
      setMessage("Entscheidung wurde nicht angenommen.");
      await loadBootstrap({ replaceForm: false });
    } finally {
      setBusy(false);
    }
  }

  function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const manualPackOrders = form.mode === "community"
      ? catalogPacks.flatMap((pack) => {
          const quantity = quantityFor(pack.id);
          return quantity > 0 ? [{ productId: pack.id, quantity }] : [];
        })
      : [];
    let maxUnitPriceMicroUsdc;
    let maxCycleBudgetMicroUsdc;
    let max24HourBudgetMicroUsdc;
    try {
      maxUnitPriceMicroUsdc = parseGermanUsdc(form.maxUnitPriceMicroUsdc);
      maxCycleBudgetMicroUsdc = parseGermanUsdc(form.maxCycleBudgetMicroUsdc);
      max24HourBudgetMicroUsdc = parseGermanUsdc(form.max24HourBudgetMicroUsdc);
    } catch {
      setError("Bitte alle USDC-Grenzen im deutschen Format eingeben, zum Beispiel 12,50.");
      return;
    }
    void submitCommand(
      {
        type: "update-configuration",
        configuration: {
          mode: form.mode,
          communityPackIds: manualPackOrders.map((order) => order.productId),
          manualPackOrders,
          maxBoostersPerCycle: Number(form.maxBoostersPerCycle),
          cycleIntervalMinutes: Number(form.cycleIntervalMinutes),
          maxUnitPriceMicroUsdc,
          maxCycleBudgetMicroUsdc,
          max24HourBudgetMicroUsdc,
        },
      },
      "Konfiguration wurde gespeichert und protokolliert.",
    );
  }

  function activate() {
    if (!bootstrap || !window.confirm(commandConfirmation(
      "Automatische Zyklen mit der gespeicherten Konfiguration aktivieren?",
      bootstrap.state,
      hasUnsavedChanges,
    ))) return;
    void submitCommand({ type: "activate" }, "Automatische Zyklen wurden aktiviert und protokolliert.");
  }

  function pause() {
    void submitCommand({ type: "pause" }, "Neue Zyklen wurden pausiert und protokolliert.");
  }

  function runCycleNow() {
    if (!bootstrap || !window.confirm(commandConfirmation(
      "Den nächsten zulässigen Zyklus jetzt starten? Alle Reserve- und Sicherheitsprüfungen bleiben aktiv.",
      bootstrap.state,
      hasUnsavedChanges,
    ))) return;
    void submitCommand({ type: "run-cycle-now" }, "Sofortiger Zyklusstart wurde vorgemerkt.");
  }

  function skipNextCycle() {
    void submitCommand({ type: "skip-next-cycle" }, "Nächster planmäßiger Zyklus wird übersprungen.");
  }

  function setPackQuantity(pack: Pack, rawValue: string) {
    const digits = rawValue.replace(/\D/g, "");
    const requested = digits.length === 0 ? 0 : Number(digits);
    const boosterLimit = Number(form.maxBoostersPerCycle);
    const maximum = Math.min(
      pack.available,
      Number.isSafeInteger(boosterLimit) && boosterLimit > 0 ? boosterLimit : pack.available,
    );
    const quantity = Number.isSafeInteger(requested)
      ? Math.min(Math.max(requested, 0), maximum)
      : 0;
    setForm((current) => ({
      ...current,
      packQuantities: { ...current.packQuantities, [pack.id]: String(quantity) },
      communityPackIds: quantity > 0
        ? [...new Set([...current.communityPackIds, pack.id])]
        : current.communityPackIds.filter((id) => id !== pack.id),
    }));
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Zur Hookemon-Startseite">
          HOOKEMON
        </Link>
        <div>
          <span className={styles.kicker}>GESCHÜTZTES OPERATING SYSTEM</span>
          <h1>Operator-Steuerung</h1>
          <p>Hier steuerst du die nächste Zykluskonfiguration. Jede Entscheidung wird protokolliert.</p>
        </div>
        <span className={styles.privateBadge}>Zugriff geschützt</span>
      </header>

      <section
        className={dashboard?.execution.connected ? styles.connectedBanner : styles.disconnectBanner}
        role="status"
        aria-live="polite"
      >
        <strong>{dashboard?.execution.connected ? "Zyklusdienst verbunden" : "Verbindung zum Zyklusdienst ausstehend"}</strong>
        <span>
          {dashboard?.execution.connected
            ? `Letztes Lebenszeichen: ${formatDate(dashboard.execution.lastHeartbeatAt ?? dashboard.generatedAt)}.`
            : dashboardError ?? "Es wurde noch kein aktuelles Lebenszeichen bestätigt."}
        </span>
      </section>

      <div className={styles.statusGrid} aria-label="Operator-Status">
        <StatusCard
          label="Nächster Zyklus"
          value={formatCountdown(dashboard?.nextCycleAt, nowMs)}
          tone={dashboard?.execution.connected ? "positive" : "neutral"}
        />
        <StatusCard
          label="Zyklusintervall"
          value={`${dashboard?.cycleIntervalMinutes ?? bootstrap?.state.cycleIntervalMinutes ?? 20} Minuten`}
          tone="neutral"
        />
        <StatusCard
          label="Automatische Zyklen"
          value={bootstrap ? germanStatus(bootstrap.state.desiredStatus) : "Wird geladen…"}
          tone={bootstrap?.state.desiredStatus === "active" ? "warning" : "neutral"}
        />
        <StatusCard
          label="Bereitschaft"
          value={bootstrap?.readiness.ready ? "Bereit" : "Nicht bereit"}
          tone={bootstrap?.readiness.ready ? "positive" : "neutral"}
        />
        <StatusCard
          label="Zugriffsrolle"
          value={bootstrap?.identity.role === "operator" ? "Operator" : "Nur Lesen"}
          tone={bootstrap?.identity.role === "operator" ? "positive" : "neutral"}
        />
        <StatusCard label="Konfigurationsstand" value={String(bootstrap?.state.version ?? "—")} tone="neutral" />
      </div>

      <div className={styles.feedback} aria-live="polite">
        <span>{busy ? "Wird verarbeitet…" : message}</span>
        {error ? (
          <span className={styles.error} role="alert">
            {error} <button type="button" onClick={() => void loadBootstrap()}>Erneut versuchen</button>
          </span>
        ) : null}
      </div>

      <section className={`${styles.panel} ${styles.currentCyclePanel}`} aria-label="Laufender Zyklus">
        <div className={styles.panelHeading}>
          <div>
            <span className={styles.sectionNumber}>AKTUELL</span>
            <h2>Laufender Zyklus</h2>
          </div>
          <span>{dashboard?.activeCycle ? germanStatus(dashboard.activeCycle.status) : "Kein aktiver Zyklus"}</span>
        </div>
        {!dashboard ? (
          <p className={dashboardError ? styles.error : styles.help}>
            {dashboardError ?? "Laufender Zyklus wird geladen…"}
          </p>
        ) : dashboard.activeCycle ? (
          <>
            <p className={styles.help}>
              Diese Werte sind für den laufenden Zyklus eingefroren und werden durch neue Einstellungen nicht verändert.
            </p>
            <dl className={styles.currentCycleGrid}>
              <CurrentValue label="Zyklus-ID" value={dashboard.activeCycle.cycleId} />
              <CurrentValue label="Status" value={germanStatus(dashboard.activeCycle.status)} />
              <CurrentValue
                label="Packauswahl"
                value={dashboard.activeCycle.requestedOrders.length
                  ? dashboard.activeCycle.requestedOrders
                    .map((order) => `${order.quantity} × ${order.productId}`)
                    .join(", ")
                  : "Automatische Auswahl"}
              />
              <CurrentValue label="Maximale Booster" value={nullableInteger(dashboard.activeCycle.maxBoostersPerCycle)} />
              <CurrentValue label="Maximaler Packpreis" value={nullableMoney(dashboard.activeCycle.maxUnitPriceMicroUsdc)} />
              <CurrentValue label="Zyklusbudget" value={nullableMoney(dashboard.activeCycle.maxCycleBudgetMicroUsdc)} />
              <CurrentValue label="24-Stunden-Budget" value={nullableMoney(dashboard.activeCycle.max24HourBudgetMicroUsdc)} />
              <CurrentValue label="Bestätigte Karten" value={String(dashboard.activeCycle.revealedCards)} />
            </dl>
            <details className={styles.technicalDetails}>
              <summary>Technische Details</summary>
              <code>Revision: {dashboard.activeCycle.configurationRevision ?? "nicht bestätigt"}</code>
              <code>Aktualisiert: {dashboard.activeCycle.updatedAt ? formatDate(dashboard.activeCycle.updatedAt) : "nicht bestätigt"}</code>
            </details>
          </>
        ) : (
          <p className={styles.empty}>Zurzeit läuft kein Zyklus. Gespeicherte Einstellungen gelten beim nächsten Start.</p>
        )}
      </section>

      <section className={`${styles.panel} ${styles.dashboardPanel}`}>
        <div className={styles.panelHeading}>
          <div>
            <span className={styles.sectionNumber}>LIVE</span>
            <h2>Zahlen, Guthaben und Aktivität</h2>
          </div>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={!dashboard}
            onClick={() => dashboard && downloadCommunityCard(dashboard)}
          >
            Übersicht als Bild herunterladen
          </button>
        </div>
        {!dashboard ? (
          <p className={dashboardError ? styles.error : styles.help} role={dashboardError ? "alert" : "status"}>
            {dashboardError ?? "Bestätigte Dashboard-Daten werden geladen…"}
          </p>
        ) : null}
        {dashboard && !dashboard.historyComplete ? (
          <p className={styles.help} role="status">
            Historische Summen werden noch importiert. Die angezeigten Gesamtwerte sind vorläufig.
          </p>
        ) : null}
        <div className={styles.metricGrid}>
          <Metric
            label="Pool beim letzten Zyklusstart"
            value={dashboard ? formatCycleStartProjectPool(dashboard) : dashboardPlaceholder}
          />
          <Metric label="Packkäufe" value={dashboard ? historicalMicroUsdc(dashboard, dashboard.metrics.totalCollectorSpendMicroUsdc) : dashboardPlaceholder} />
          <Metric label="Bestätigte Buybacks" value={dashboard ? historicalMicroUsdc(dashboard, dashboard.metrics.totalBuybacksReturnedMicroUsdc) : dashboardPlaceholder} />
          <Metric label="Zurück transferiert" value={dashboard ? historicalMicroUsdc(dashboard, dashboard.metrics.totalBridgedBackMicroUsdc) : dashboardPlaceholder} />
          <Metric label="Letzte tatsächliche Ausschüttung" value={dashboard ? latestActuallyPaid(dashboard) : dashboardPlaceholder} />
          <Metric label="Nächste Gebührenreserve (50 %)" value={dashboard ? latestReserveTarget(dashboard) : dashboardPlaceholder} />
          <Metric label="Angebotene Betriebskosten" value={dashboard ? historicalMicroUsdc(dashboard, dashboard.metrics.totalQuotedOperatingCostsMicroUsdc) : dashboardPlaceholder} />
          <Metric label="Abgeschlossene Zyklen" value={dashboard ? historicalCount(dashboard, dashboard.metrics.completedCycles) : dashboardPlaceholder} />
          <Metric label="Geöffnete Packs" value={dashboard ? historicalCount(dashboard, dashboard.metrics.openedPacks) : dashboardPlaceholder} />
        </div>
        {dashboard?.latestCycle?.roundAccounting ? (
          <div className={styles.accountingGroups} aria-label="Letzte Holder-Rewards-Runde">
            <OperatorAccountingGroup title="Pack-Ergebnis">
              <RoundMetric label="Packausgaben" value={formatMicroUsdc(dashboard.latestCycle.roundAccounting.packSpendMicroUsdc)} />
              <RoundMetric label="Buyback" value={formatMicroUsdc(dashboard.latestCycle.roundAccounting.buybackMicroUsdc)} />
              <RoundMetric label="Packgewinn" value={formatMicroUsdc(dashboard.latestCycle.roundAccounting.packGainMicroUsdc)} />
              <RoundMetric label="Packverlust" value={formatMicroUsdc(dashboard.latestCycle.roundAccounting.packLossMicroUsdc)} />
              <RoundMetric label="Wallet vorher" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.walletBalanceBeforeMicroUsdc, "Guthaben nicht bestätigt")} />
              <RoundMetric label="Wallet nachher" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.walletBalanceAfterMicroUsdc, "Guthaben nicht bestätigt")} />
            </OperatorAccountingGroup>
            <OperatorAccountingGroup title="Angebotene und bestätigte Kosten">
              <RoundMetric label="Angebot ausgehender Transfer" value={quotedMicroUsdc(dashboard.latestCycle.roundAccounting.quotedCosts.outboundBridgeMicroUsdc)} />
              <RoundMetric label="Angebot Rücktransfer" value={quotedMicroUsdc(dashboard.latestCycle.roundAccounting.quotedCosts.inboundBridgeMicroUsdc)} />
              <RoundMetric label="Angebot Collector-API" value={quotedMicroUsdc(dashboard.latestCycle.roundAccounting.quotedCosts.collectorApiMicroUsdc)} />
              <RoundMetric label="Angebot Ethereum-Netzwerk" value={quotedMicroUsdc(dashboard.latestCycle.roundAccounting.quotedCosts.ethereumNetworkMicroUsdc)} />
              <RoundMetric label="Angebot Solana-Netzwerk" value={quotedMicroUsdc(dashboard.latestCycle.roundAccounting.quotedCosts.solanaNetworkMicroUsdc)} />
              <RoundMetric label="Angebot Slippage" value={quotedMicroUsdc(dashboard.latestCycle.roundAccounting.quotedCosts.slippageMicroUsdc)} />
              <RoundMetric label="Geschützte Kostenprognose" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.protectedCostsMicroUsdc, "In dieser Prüfung nicht ausgeführt")} />
              <RoundMetric label="Bestätigte Kosten" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.confirmedCostsMicroUsdc, "Bestätigte Belege stehen aus")} />
              <RoundMetric
                label="Transaktionsgebühr Kauf"
                value={nativeFeeText(dashboard.latestCycle.roundAccounting.networkFees.purchase)}
                detail={nativeFeePayer(dashboard.latestCycle.roundAccounting.networkFees.purchase)}
              />
              <RoundMetric
                label="Transaktionsgebühr Buyback"
                value={nativeFeeText(dashboard.latestCycle.roundAccounting.networkFees.buyback)}
                detail={nativeFeePayer(dashboard.latestCycle.roundAccounting.networkFees.buyback)}
              />
              <RoundMetric
                label="Gebühr Player-Wallet"
                value={dashboard.latestCycle.roundAccounting.networkFees.walletLamportsCharged === null
                  ? "Gebühr nicht bestätigt"
                  : `${formatInteger(dashboard.latestCycle.roundAccounting.networkFees.walletLamportsCharged)} lamports`}
              />
            </OperatorAccountingGroup>
            <OperatorAccountingGroup title="Gebührenreserve">
              <RoundMetric label="Reserve vorher" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.feeReserveBeforeMicroUsdc, "In dieser Prüfung nicht ausgeführt")} />
              <RoundMetric label="Reserveziel (50 %)" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.feeReserveTargetMicroUsdc, "In dieser Prüfung nicht ausgeführt")} />
              <RoundMetric label="Reserveauffüllung" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.feeReserveTopUpMicroUsdc, "In dieser Prüfung nicht ausgeführt")} />
              <RoundMetric label="Reserve nachher" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.feeReserveAfterMicroUsdc, "In dieser Prüfung nicht ausgeführt")} />
            </OperatorAccountingGroup>
            <OperatorAccountingGroup title="Holder-Ausschüttung">
              <RoundMetric
                label="Geplante Holder Rewards"
                value={pendingMicroUsdc(
                  dashboard.latestCycle.roundAccounting.plannedHolderRewardsMicroUsdc,
                  germanStatus(dashboard.latestCycle.roundAccounting.holderRewardsStatus),
                )}
              />
              <RoundMetric
                label="Tatsächlich ausgezahlt"
                value={pendingMicroUsdc(
                  dashboard.latestCycle.roundAccounting.paidHolderRewardsMicroUsdc,
                  germanStatus(dashboard.latestCycle.roundAccounting.distributionStatus),
                )}
              />
              <RoundMetric label="Berechtigte Zuteilungen" value={String(dashboard.latestCycle.payoutRecipientCount)} />
              <RoundMetric label="Vollständiger Zyklusgewinn" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.cycleGainMicroUsdc, "Bestätigte Belege stehen aus")} />
              <RoundMetric label="Vollständiger Zyklusverlust" value={pendingMicroUsdc(dashboard.latestCycle.roundAccounting.cycleLossMicroUsdc, "Bestätigte Belege stehen aus")} />
            </OperatorAccountingGroup>
          </div>
        ) : null}
      </section>

      <div className={styles.contentGrid}>
        <form className={styles.panel} onSubmit={saveConfiguration}>
          <div className={styles.panelHeading}>
            <div>
              <span className={styles.sectionNumber}>NÄCHSTER ZYKLUS</span>
              <h2>Ab nächstem Zyklus</h2>
            </div>
            <span>{readOnly ? "Nur Lesen" : hasUnsavedChanges ? "Ungespeicherte Änderungen" : "Gespeichert"}</span>
          </div>

          <p className={styles.nextCycleNotice}>
            Gilt ab dem nächsten neu gestarteten Zyklus und bleibt gültig, bis du die Einstellung änderst.
          </p>

          <fieldset className={styles.fieldset} disabled={controlsDisabled}>
            <legend>Packauswahl</legend>
            <div className={styles.segmented}>
              {(["standard", "community"] as const).map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    name="mode"
                    value={mode}
                    checked={form.mode === mode}
                    onChange={() => setForm((current) => ({ ...current, mode }))}
                  />
                  <span>{mode === "standard" ? "Automatische Auswahl" : "Eigene Packauswahl"}</span>
                </label>
              ))}
            </div>
            <p className={styles.help}>
              Automatisch wählt die Sicherheitslogik ein zulässiges Pack. Bei eigener Auswahl legst du mehrere Packs und Mengen fest.
            </p>
          </fieldset>

          {form.mode === "community" ? (
            <fieldset className={styles.fieldset} disabled={controlsDisabled}>
              <legend>Menge je ausgewähltem Pack</legend>
              <p className={styles.help}>Menge 0 schließt ein Pack aus. Alle positiven Mengen werden gemeinsam und vollständig angefragt.</p>
              <div className={styles.packList}>
                {bootstrap?.catalog?.packs.length ? (
                  bootstrap.catalog.packs.map((pack) => (
                    <div className={styles.packOption} key={pack.id}>
                      <span>
                        <strong>{pack.name}</strong>
                        <small>
                          {formatMicroUsdc(pack.priceMicroUsdc)} · {pack.available} verfügbar
                          {pack.collectorEconomicCostMicroUsdc
                            ? ` · ${formatMicroUsdc(pack.collectorEconomicCostMicroUsdc)} konservative Collector-Kosten`
                            : ""}
                        </small>
                      </span>
                      <label className={styles.packQuantity}>
                        <span>Menge</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={Math.min(pack.available, Number(form.maxBoostersPerCycle || 0))}
                          step={1}
                          value={quantityFor(pack.id)}
                          onChange={(event) => setPackQuantity(pack, event.target.value)}
                          aria-label={`Menge für ${pack.name}`}
                        />
                      </label>
                    </div>
                  ))
                ) : (
                  <p className={styles.empty}>Zurzeit sind keine Packs im Katalog verfügbar.</p>
                )}
              </div>
            </fieldset>
          ) : null}

          <div className={styles.limitGrid}>
            <BoosterLimitField
              id="max-boosters-per-cycle"
              value={form.maxBoostersPerCycle}
              hardCap={bootstrap?.hardCaps.maxBoostersPerCycle}
              disabled={controlsDisabled}
              onChange={(value) => setForm((current) => ({ ...current, maxBoostersPerCycle: value }))}
            />
            <LimitField
              id="max-unit-price"
              label="Maximaler Packpreis"
              value={form.maxUnitPriceMicroUsdc}
              hardCap={bootstrap?.hardCaps.maxUnitPriceMicroUsdc}
              disabled={controlsDisabled}
              onChange={(value) => setForm((current) => ({ ...current, maxUnitPriceMicroUsdc: value }))}
            />
            <label className={styles.textField} htmlFor="cycle-interval-minutes">
              <span>Zyklusintervall</span>
              <input
                id="cycle-interval-minutes"
                type="number"
                inputMode="numeric"
                min={15}
                max={60}
                step={1}
                required
                value={form.cycleIntervalMinutes}
                disabled={controlsDisabled}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  cycleIntervalMinutes: event.target.value.replace(/\D/g, ""),
                }))}
              />
              <small>15–60 Minuten · gilt ab dem nächsten neu gestarteten Zyklus</small>
            </label>
            <LimitField
              id="max-cycle-budget"
              label="Zyklusbudget"
              value={form.maxCycleBudgetMicroUsdc}
              hardCap={bootstrap?.hardCaps.maxCycleBudgetMicroUsdc}
              disabled={controlsDisabled}
              onChange={(value) => setForm((current) => ({ ...current, maxCycleBudgetMicroUsdc: value }))}
            />
            <LimitField
              id="max-daily-budget"
              label="24-Stunden-Budget"
              value={form.max24HourBudgetMicroUsdc}
              hardCap={bootstrap?.hardCaps.max24HourBudgetMicroUsdc}
              disabled={controlsDisabled}
              onChange={(value) => setForm((current) => ({ ...current, max24HourBudgetMicroUsdc: value }))}
            />
          </div>

          <section className={styles.reservePreview} aria-label="Vorschau für Zyklusreserve">
            <div>
              <span>Gesamtmenge</span>
              <strong>{formatNumber(reservePreview.totalQuantity)}</strong>
            </div>
            <div>
              <span>Collector-Bruttobelastung</span>
              <strong>{formatMicroUsdc(reservePreview.grossCollectorDebitMicroUsdc.toString())}</strong>
            </div>
            <div>
              <span>Packspezifische Collector-Kosten</span>
              <strong>
                {reservePreview.economicsComplete
                  ? formatMicroUsdc(reservePreview.collectorEconomicCostMicroUsdc.toString())
                  : "Aktualisierung erforderlich"}
              </strong>
            </div>
            <div>
              <span>Nächste Gebührenreserve (50 %)</span>
              <strong>Wird bei Ausführung berechnet</strong>
            </div>
            <p>
              Packkapital und vollständige geschützte Kostenprognose müssen vor dem Kauf gedeckt sein.
              Die nächste Gebührenreserve beträgt 50 % dieser Prognose; fehlende Deckung überspringt den Zyklus sicher.
            </p>
          </section>

          <label className={styles.textField} htmlFor="decision-note">
            <span>Entscheidungsnotiz <small>optional</small></span>
            <textarea
              id="decision-note"
              maxLength={500}
              value={form.note}
              disabled={controlsDisabled}
              onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              placeholder="Warum ist diese Änderung nötig?"
            />
          </label>

          <button className={styles.primaryButton} type="submit" disabled={controlsDisabled}>
            {busy ? "Wird gespeichert…" : "Konfiguration speichern"}
          </button>
        </form>

        <aside className={styles.sideColumn}>
          <section className={styles.panel}>
            <div className={styles.panelHeading}>
              <div>
                <span className={styles.sectionNumber}>STEUERUNG</span>
                <h2>Zyklusbefehle</h2>
              </div>
            </div>
            <p className={styles.help}>Jeder Befehl wird protokolliert. Sicherheitsprüfungen und Obergrenzen bleiben immer aktiv.</p>
            {bootstrap?.readiness.reasons.length ? (
              <ul className={styles.reasonList}>
                {bootstrap.readiness.reasons.map((reason) => (
                  <li key={reason}>{germanStatus(reason)}</li>
                ))}
              </ul>
            ) : null}
            <div className={styles.actionStack}>
              <button
                className={styles.activateButton}
                type="button"
                disabled={controlsDisabled || !bootstrap?.readiness.ready}
                onClick={activate}
              >
                Automatische Zyklen aktivieren
              </button>
              <button className={styles.pauseButton} type="button" disabled={controlsDisabled} onClick={pause}>
                {dashboard?.activeCycle ? "Nach diesem Zyklus pausieren" : "Pausieren"}
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={controlsDisabled || bootstrap?.state.desiredStatus !== "active"}
                onClick={runCycleNow}
              >
                Nächsten zulässigen Zyklus jetzt starten
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={controlsDisabled || bootstrap?.state.desiredStatus !== "active"}
                onClick={skipNextCycle}
              >
                Nächsten planmäßigen Zyklus überspringen
              </button>
            </div>
          </section>

          <section className={styles.identityPanel}>
            <span>Angemeldete Identität</span>
            <strong>{bootstrap?.identity.email ?? "Wird geladen…"}</strong>
            <small>Die Cloudflare-Access-Identität wird jeder Entscheidung zugeordnet.</small>
          </section>
        </aside>
      </div>

      <OperatorCardHistory
        liveCards={dashboard?.cards ?? []}
        activeCycleId={dashboard?.activeCycle?.cycleId ?? null}
      />

      <section className={styles.activityGrid}>
        <div className={styles.panel}>
          <div className={styles.panelHeading}>
            <div>
              <span className={styles.sectionNumber}>ZUTEILUNGEN</span>
              <h2>Letzte abgeschlossene Zykluszuteilungen</h2>
            </div>
            <span>Bis zu 200 · ein Zyklus</span>
          </div>
          {!dashboard ? (
            <p className={styles.empty}>
              {dashboardError
                ? "Zuteilungen sind ohne Dashboard-Daten nicht verfügbar."
                : "Bestätigte Zuteilungen werden geladen…"}
            </p>
          ) : dashboard.latestCycleTopAllocations.length ? (
            <ol className={styles.payoutList}>
              {dashboard.latestCycleTopAllocations.map((entry) => (
                <li key={entry.address}>
                  <span>#{entry.rank}</span>
                  <code>{shortAddress(entry.address)}</code>
                  <strong>{formatMicroUsdc(entry.allocatedMicroUsdc)}</strong>
                </li>
              ))}
            </ol>
          ) : <p className={styles.empty}>Zuteilungen erscheinen nach der ersten abgeschlossenen Ausschüttung.</p>}
        </div>
      </section>

      <section className={`${styles.panel} ${styles.auditPanel}`}>
        <div className={styles.panelHeading}>
          <div>
            <span className={styles.sectionNumber}>PROTOKOLL</span>
            <h2>Entscheidungshistorie</h2>
          </div>
          <span>Unveränderbares Protokoll</span>
        </div>
        {decisions.length ? (
          <ol className={styles.auditList}>
            {decisions.map((decision) => (
              <li key={decision.eventId}>
                <div>
                  <span className={decision.outcome === "accepted" ? styles.accepted : styles.rejected}>
                    {germanStatus(decision.outcome)}
                  </span>
                  <strong>{germanStatus(decision.action)}</strong>
                  <small>#{decision.sequence} · Stand {decision.observedVersion}</small>
                </div>
                <div>
                  <span>{decision.actor.email}</span>
                  <time dateTime={decision.occurredAt}>{formatDate(decision.occurredAt)}</time>
                  {decision.note ? <p>{decision.note}</p> : null}
                  <details className={styles.technicalDetails}>
                    <summary>Technische Details</summary>
                    <code>{decision.resultCode}</code>
                    <code>Ereignis: {decision.eventId}</code>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.empty}>{auditBusy ? "Entscheidungshistorie wird geladen…" : "Noch keine Entscheidung protokolliert."}</p>
        )}
        {nextCursor ? (
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={auditBusy}
            onClick={() => void loadAudit(nextCursor)}
          >
            {auditBusy ? "Wird geladen…" : "Ältere Entscheidungen laden"}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: "positive" | "warning" | "neutral" }) {
  return (
    <div className={styles.statusCard} data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CurrentValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong></div>;
}

function OperatorAccountingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.accountingGroup}>
      <h3>{title}</h3>
      <dl className={styles.roundAccounting}>{children}</dl>
    </section>
  );
}

function RoundMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className={styles.roundAccountingMetric}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function LimitField({
  id,
  label,
  value,
  hardCap,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  hardCap?: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <label className={styles.textField} htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        pattern="(?:0|[1-9][0-9]*)(?:,[0-9]{1,6})?"
        autoComplete="off"
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(germanMoneyInput(event.target.value))}
      />
      <small>
        USDC · Obergrenze {hardCap ? formatMicroUsdc(hardCap) : "wird geladen…"}
      </small>
    </label>
  );
}

function BoosterLimitField({
  id,
  value,
  hardCap,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  hardCap?: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const maximum = hardCap && /^\d+$/.test(hardCap) ? Number(hardCap) : undefined;
  return (
    <label className={styles.textField} htmlFor={id}>
      <span>Maximale Booster pro Zyklus</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={maximum}
        step={1}
        autoComplete="off"
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      />
      <small>Startwert 100 · Obergrenze {hardCap ?? "wird geladen…"}</small>
    </label>
  );
}

function formFromState(state: OperatorState): FormState {
  const orders = state.manualPackOrders?.length
    ? state.manualPackOrders
    : state.communityPackIds.map((productId) => ({ productId, quantity: 1 }));
  return {
    mode: state.mode,
    communityPackIds: [...state.communityPackIds],
    packQuantities: Object.fromEntries(
      orders.map((order) => [order.productId, String(order.quantity)]),
    ),
    maxBoostersPerCycle: String(state.maxBoostersPerCycle ?? 100),
    cycleIntervalMinutes: String(state.cycleIntervalMinutes ?? 20),
    maxUnitPriceMicroUsdc: germanMoneyFormValue(state.maxUnitPriceMicroUsdc),
    maxCycleBudgetMicroUsdc: germanMoneyFormValue(state.maxCycleBudgetMicroUsdc),
    max24HourBudgetMicroUsdc: germanMoneyFormValue(state.max24HourBudgetMicroUsdc),
    note: "",
  };
}

function germanMoneyFormValue(value: string | null) {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return "";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const rawFraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole},${rawFraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

function germanMoneyInput(value: string) {
  const sanitized = value.replace(/[^0-9,]/g, "");
  const [whole = "", ...fractions] = sanitized.split(",");
  const fraction = fractions.join("").slice(0, 6);
  return fractions.length ? `${whole},${fraction}` : whole;
}

function configurationSnapshotFromForm(form: FormState, packs: Pack[]) {
  try {
    const orders = form.mode === "community"
      ? packs.flatMap((pack) => {
          const quantity = Number(form.packQuantities[pack.id] ?? "0");
          return Number.isSafeInteger(quantity) && quantity > 0
            ? [{ productId: pack.id, quantity }]
            : [];
        })
      : [];
    return JSON.stringify({
      mode: form.mode,
      orders: normalizedOrders(orders),
      maxBoostersPerCycle: Number(form.maxBoostersPerCycle),
      cycleIntervalMinutes: Number(form.cycleIntervalMinutes),
      maxUnitPriceMicroUsdc: parseGermanUsdc(form.maxUnitPriceMicroUsdc),
      maxCycleBudgetMicroUsdc: parseGermanUsdc(form.maxCycleBudgetMicroUsdc),
      max24HourBudgetMicroUsdc: parseGermanUsdc(form.max24HourBudgetMicroUsdc),
    });
  } catch {
    return JSON.stringify({ invalid: true, form });
  }
}

function configurationSnapshotFromState(state: OperatorState) {
  return JSON.stringify({
    mode: state.mode,
    orders: normalizedOrders(state.mode === "community" ? state.manualPackOrders : []),
    maxBoostersPerCycle: state.maxBoostersPerCycle,
    cycleIntervalMinutes: state.cycleIntervalMinutes,
    maxUnitPriceMicroUsdc: state.maxUnitPriceMicroUsdc,
    maxCycleBudgetMicroUsdc: state.maxCycleBudgetMicroUsdc,
    max24HourBudgetMicroUsdc: state.max24HourBudgetMicroUsdc,
  });
}

function normalizedOrders(orders: ManualPackOrder[]) {
  return orders
    .map((order) => ({ productId: order.productId, quantity: order.quantity }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
}

function commandConfirmation(question: string, state: OperatorState, unsaved: boolean) {
  const packs = state.mode === "community" && state.manualPackOrders.length
    ? state.manualPackOrders.map((order) => `${order.quantity} × ${order.productId}`).join(", ")
    : "Automatische Auswahl";
  return [
    question,
    "",
    "Gespeicherte Konfiguration:",
    `Packs: ${packs}`,
    `Maximaler Packpreis: ${nullableMoney(state.maxUnitPriceMicroUsdc)}`,
    `Zyklusbudget: ${nullableMoney(state.maxCycleBudgetMicroUsdc)}`,
    `24-Stunden-Budget: ${nullableMoney(state.max24HourBudgetMicroUsdc)}`,
    `Zyklusintervall: ${state.cycleIntervalMinutes} Minuten`,
    ...(unsaved ? ["", "Ungespeicherte Änderungen werden für diesen Befehl nicht verwendet."] : []),
  ].join("\n");
}

function computeReservePreview(packs: Pack[], form: FormState) {
  let totalQuantity = 0;
  let grossCollectorDebitMicroUsdc = BigInt(0);
  let collectorEconomicCostMicroUsdc = BigInt(0);
  let economicsComplete = true;
  if (form.mode === "community") {
    for (const pack of packs) {
      const quantity = BigInt(Math.max(0, Number(form.packQuantities[pack.id] ?? "0") || 0));
      if (quantity === BigInt(0)) continue;
      totalQuantity += Number(quantity);
      grossCollectorDebitMicroUsdc += BigInt(pack.priceMicroUsdc) * quantity;
      if (!/^\d+$/.test(pack.collectorEconomicCostMicroUsdc ?? "")) {
        economicsComplete = false;
      } else {
        collectorEconomicCostMicroUsdc += BigInt(pack.collectorEconomicCostMicroUsdc ?? "0") * quantity;
      }
    }
  }
  return {
    totalQuantity,
    grossCollectorDebitMicroUsdc,
    collectorEconomicCostMicroUsdc,
    economicsComplete,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Die private Steuerung hat eine ungültige Antwort geliefert.");
  }
}

function stableMessage(code?: string) {
  const label = germanStatus(code);
  return label === "Unbekannter Status" ? "Die Entscheidung konnte nicht ausgeführt werden." : `${label}.`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Die private Steuerungsanfrage ist fehlgeschlagen.";
}

function formatMicroUsdc(value: string) {
  try {
    return formatGermanUsdc(value);
  } catch {
    return "Nicht bestätigt";
  }
}

function formatOptionalMicroUsdc(value: string | undefined) {
  return value === undefined ? "Noch nicht bestätigt" : formatMicroUsdc(value);
}

function historicalMicroUsdc(dashboard: Dashboard | null, value: string | undefined) {
  if (!dashboard) return "Wird geladen…";
  return dashboard.historyComplete ? formatOptionalMicroUsdc(value) : "Historie unvollständig";
}

function historicalCount(dashboard: Dashboard | null, value: number | undefined) {
  if (!dashboard) return "Wird geladen…";
  return dashboard.historyComplete && value !== undefined ? formatNumber(value) : "Historie unvollständig";
}

function latestActuallyPaid(dashboard: Dashboard | null) {
  if (!dashboard) return "Wird geladen…";
  if (!dashboard.latestCycle) return "Noch keine abgeschlossene Runde";
  const accounting = dashboard.latestCycle.roundAccounting;
  if (accounting) {
    return pendingMicroUsdc(
      accounting.paidHolderRewardsMicroUsdc,
      humanizeStatus(accounting.distributionStatus),
    );
  }
  return pendingMicroUsdc(dashboard.latestCycle.paidMicroUsdc, "Nicht ausgeführt");
}

function latestReserveTarget(dashboard: Dashboard | null) {
  if (!dashboard) return "Wird geladen…";
  if (!dashboard.latestCycle) return "Noch keine abgeschlossene Runde";
  const accounting = dashboard.latestCycle.roundAccounting;
  return accounting
    ? pendingMicroUsdc(
      accounting.feeReserveTargetMicroUsdc,
      "In dieser Prüfung nicht ausgeführt",
    )
    : formatOptionalMicroUsdc(dashboard?.metrics.latestCycleReserveTargetMicroUsdc);
}

function pendingMicroUsdc(value: string | null, pending: string) {
  return value === null ? pending : formatMicroUsdc(value);
}

function quotedMicroUsdc(value: string | null) {
  return value === null ? "Angebot nicht verfügbar" : `${formatMicroUsdc(value)} angeboten`;
}

function nativeFeeText(value: { lamports: string; paidBy: string } | null) {
  return value === null ? "Gebührenbeleg nicht verfügbar" : `${formatInteger(value.lamports)} Lamports`;
}

function nativeFeePayer(value: { lamports: string; paidBy: string } | null) {
  return value === null ? undefined : `Bezahlt von ${value.paidBy}`;
}

function formatInteger(value: string) {
  return BigInt(value).toLocaleString("de-DE");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("de-DE").format(value);
}

function nullableMoney(value: string | null) {
  return value === null ? "Noch nicht bestätigt" : formatMicroUsdc(value);
}

function nullableInteger(value: number | null) {
  return value === null ? "Noch nicht bestätigt" : formatNumber(value);
}

function formatCycleStartProjectPool(dashboard: Dashboard | null) {
  if (!dashboard) return "Nicht beobachtet";
  const pool = decodeCycleStartProjectPool({
    cycleStartProjectPoolMicroUsdc: dashboard.metrics.cycleStartProjectPoolMicroUsdc,
    cycleStartProjectPoolObservedAt: dashboard.cycleStartProjectPoolObservedAt,
  });
  if (pool.cycleStartProjectPoolMicroUsdc === null || pool.cycleStartProjectPoolObservedAt === null) {
    return "Nicht beobachtet";
  }
  return `${formatMicroUsdc(pool.cycleStartProjectPoolMicroUsdc)} · Stand ${formatDate(pool.cycleStartProjectPoolObservedAt)}`;
}

function formatDate(value: string) {
  try {
    return formatGermanDate(value);
  } catch {
    return "Ungültiges Datum";
  }
}

function formatCountdown(nextCycleAt: string | null | undefined, nowMs: number) {
  if (!nextCycleAt) return "Wartet";
  const deadline = new Date(nextCycleAt).getTime();
  if (!Number.isFinite(deadline)) return "Wartet";
  const seconds = Math.max(0, Math.ceil((deadline - nowMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function downloadCommunityCard(dashboard: Dashboard) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1080;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#0b0c0f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f5d94c";
  context.font = "800 42px monospace";
  context.fillText("HOOKEMON / LIVE-ZYKLUS", 72, 100);
  context.fillStyle = "#ffffff";
  context.font = "800 78px sans-serif";
  context.fillText(`${dashboard.metrics.openedPacks} PACKS GEÖFFNET`, 72, 220);
  const lines = [
    ["Pool beim letzten Zyklusstart", formatCycleStartProjectPool(dashboard)],
    ["Bestätigte Buybacks", formatMicroUsdc(dashboard.metrics.totalBuybacksReturnedMicroUsdc)],
    ["Zurück transferiert", formatMicroUsdc(dashboard.metrics.totalBridgedBackMicroUsdc)],
    ["Letzte tatsächliche Ausschüttung", latestActuallyPaid(dashboard)],
    ["Abgeschlossene Zyklen", String(dashboard.metrics.completedCycles)],
    ["Nächster Zyklus", dashboard.nextCycleAt ? formatDate(dashboard.nextCycleAt) : "Wartet auf Deckung"],
  ];
  lines.forEach(([label, value], index) => {
    const y = 350 + index * 125;
    context.fillStyle = "#9296a1";
    context.font = "700 28px monospace";
    context.fillText(label.toUpperCase(), 72, y);
    context.fillStyle = "#ffffff";
    context.font = "700 46px sans-serif";
    context.fillText(value, 72, y + 52);
  });
  context.fillStyle = "#f5d94c";
  context.font = "700 28px monospace";
  context.fillText(
    dashboard.historyComplete ? "GESAMTHISTORIE VOLLSTÄNDIG" : "GESAMTHISTORIE VORLÄUFIG",
    72,
    1010,
  );
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hookemon-community-${new Date(dashboard.generatedAt).toISOString().slice(0, 10)}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function decodeDashboard(value: unknown): Dashboard {
  const raw = dashboardRecord(value);
  if (
    raw.schemaVersion !== 1 &&
    raw.schemaVersion !== 2 &&
    raw.schemaVersion !== 3 &&
    raw.schemaVersion !== 4
  ) {
    throw new Error(DASHBOARD_RESPONSE_UNSUPPORTED);
  }
  const schemaVersion = raw.schemaVersion;
  const metrics = dashboardRecord(raw.metrics);
  const legacyPoolHasNoObservation = schemaVersion === 1 &&
    raw.cycleStartProjectPoolObservedAt === undefined;
  const poolValue = legacyPoolHasNoObservation
    ? null
    : schemaVersion === 1
      ? metrics.cycleStartProjectPoolMicroUsdc ?? metrics.currentProjectPoolMicroUsdc
      : metrics.cycleStartProjectPoolMicroUsdc;
  const decodedMetrics = Object.fromEntries(
    DASHBOARD_MONEY_FIELDS.map((field) => [field, dashboardMoney(metrics[field])]),
  ) as Pick<Dashboard["metrics"], (typeof DASHBOARD_MONEY_FIELDS)[number]>;
  const allocationSource = schemaVersion === 1
    ? raw.top200 ?? raw.latestCycleTopAllocations
    : raw.latestCycleTopAllocations;
  const observedAt = legacyPoolHasNoObservation
    ? null
    : dashboardNullableTimestamp(raw.cycleStartProjectPoolObservedAt);
  const historyComplete = raw.historyComplete === undefined && schemaVersion === 1
    ? true
    : dashboardBoolean(raw.historyComplete);
  const cardHistoryComplete = raw.cardHistoryComplete === undefined
    ? false
    : dashboardBoolean(raw.cardHistoryComplete);
  const latestAllocationCycleId = raw.latestCompletedAllocationCycleId === undefined && schemaVersion === 1
    ? null
    : dashboardNullableText(raw.latestCompletedAllocationCycleId);
  const execution = dashboardRecord(raw.execution);
  const pool = decodeCycleStartProjectPool(poolValue, observedAt);

  return {
    schemaVersion: 4,
    historyComplete,
    cardHistoryComplete,
    generatedAt: dashboardTimestamp(raw.generatedAt),
    nextCycleAt: dashboardNullableTimestamp(raw.nextCycleAt),
    cycleIntervalMinutes: dashboardInteger(raw.cycleIntervalMinutes, 15, 60),
    execution: {
      connected: dashboardBoolean(execution.connected),
      lastHeartbeatAt: dashboardNullableTimestamp(execution.lastHeartbeatAt),
    },
    cycleStartProjectPoolObservedAt: pool.cycleStartProjectPoolObservedAt,
    latestCompletedAllocationCycleId: latestAllocationCycleId,
    metrics: {
      cycleStartProjectPoolMicroUsdc: pool.cycleStartProjectPoolMicroUsdc,
      ...decodedMetrics,
      completedCycles: dashboardInteger(metrics.completedCycles, 0),
      skippedCycles: dashboardInteger(metrics.skippedCycles, 0),
      openedPacks: dashboardInteger(metrics.openedPacks, 0),
    },
    latestCycleTopAllocations: dashboardArray(allocationSource, 200).map((entry) => {
      const allocation = dashboardRecord(entry);
      const address = dashboardText(allocation.address);
      if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(DASHBOARD_RESPONSE_INVALID);
      return {
        rank: dashboardInteger(allocation.rank, 1, 200),
        address,
        allocatedMicroUsdc: dashboardMoney(allocation.allocatedMicroUsdc),
      };
    }),
    cards: dashboardArray(raw.cards, 60).map((card) =>
      decodeDashboardCard(card, schemaVersion)),
    activeCycle: raw.activeCycle === undefined || raw.activeCycle === null
      ? null
      : decodeActiveCycle(raw.activeCycle),
    latestCycle: decodeLatestCycle(raw.latestCycle, schemaVersion),
  };
}

function decodeActiveCycle(value: unknown): ActiveCycle {
  const raw = dashboardRecord(value);
  dashboardExactKeys(raw, ACTIVE_CYCLE_KEYS);
  const allowedPackIds = dashboardArray(raw.allowedPackIds, 10_000).map(dashboardText);
  const allowed = new Set(allowedPackIds);
  if (allowed.size !== allowedPackIds.length) throw new Error(DASHBOARD_RESPONSE_INVALID);
  const seenOrders = new Set<string>();
  const requestedOrders = dashboardArray(raw.requestedOrders, 10_000).map((value) => {
    const order = dashboardRecord(value);
    dashboardExactKeys(order, new Set(["productId", "quantity"]));
    const productId = dashboardText(order.productId);
    if (!allowed.has(productId) || seenOrders.has(productId)) {
      throw new Error(DASHBOARD_RESPONSE_INVALID);
    }
    seenOrders.add(productId);
    return { productId, quantity: dashboardInteger(order.quantity, 1, 10_000) };
  });
  const maxBoostersPerCycle = raw.maxBoostersPerCycle === null
    ? null
    : dashboardInteger(raw.maxBoostersPerCycle, 1, 10_000);
  const totalRequested = requestedOrders.reduce((total, order) => total + order.quantity, 0);
  if (maxBoostersPerCycle !== null && totalRequested > maxBoostersPerCycle) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return {
    cycleId: dashboardText(raw.cycleId),
    status: dashboardText(raw.status),
    updatedAt: dashboardNullableTimestamp(raw.updatedAt),
    configurationRevision: dashboardNullableText(raw.configurationRevision),
    allowedPackIds,
    requestedOrders,
    maxBoostersPerCycle,
    maxUnitPriceMicroUsdc: dashboardOptionalMoney(raw.maxUnitPriceMicroUsdc),
    maxCycleBudgetMicroUsdc: dashboardOptionalMoney(raw.maxCycleBudgetMicroUsdc),
    max24HourBudgetMicroUsdc: dashboardOptionalMoney(raw.max24HourBudgetMicroUsdc),
    revealedCards: dashboardInteger(raw.revealedCards, 0, 10_000),
  };
}

function decodeDashboardCard(value: unknown, schemaVersion: 1 | 2 | 3 | 4): DashboardCard {
  const raw = dashboardRecord(value);
  if (schemaVersion === 4) dashboardExactKeys(raw, DASHBOARD_CARD_KEYS);
  const card: DashboardCard = {
    cycleId: dashboardText(raw.cycleId),
    productId: dashboardText(raw.productId),
    rarity: dashboardText(raw.rarity),
    nftAddress: dashboardOptionalText(raw.nftAddress),
    cardName: dashboardOptionalText(raw.cardName),
    setName: dashboardOptionalText(raw.setName),
    cardNumber: dashboardOptionalText(raw.cardNumber),
    imageUrl: dashboardOptionalText(raw.imageUrl),
    packPriceMicroUsdc: dashboardOptionalMoney(raw.packPriceMicroUsdc),
    buybackMicroUsdc: dashboardOptionalMoney(raw.buybackMicroUsdc),
  };
  if (card.imageUrl !== null) {
    let url;
    try {
      url = new URL(card.imageUrl);
    } catch {
      throw new Error(DASHBOARD_RESPONSE_INVALID);
    }
    if (url.protocol !== "https:") throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return card;
}

function decodeLatestCycle(value: unknown, schemaVersion: 1 | 2 | 3 | 4): Dashboard["latestCycle"] {
  if (value === null) return null;
  const raw = dashboardRecord(value);
  return {
    cycleId: dashboardText(raw.cycleId),
    status: dashboardText(raw.status),
    reason: dashboardNullableText(raw.reason),
    updatedAt: dashboardNullableTimestamp(raw.updatedAt),
    paidMicroUsdc: schemaVersion >= 3 ? dashboardOptionalMoney(raw.paidMicroUsdc) : null,
    payoutRecipientCount: schemaVersion >= 3
      ? dashboardInteger(raw.payoutRecipientCount, 0)
      : 0,
    roundAccounting: schemaVersion === 3 || schemaVersion === 4
      ? decodeRoundAccounting(raw.roundAccounting, schemaVersion, raw.paidMicroUsdc)
      : null,
    transactions: schemaVersion >= 3
      ? dashboardArray(raw.transactions, 24).map(decodeDashboardTransaction)
      : [],
  };
}

function decodeRoundAccounting(
  value: unknown,
  schemaVersion: 3 | 4,
  paidMicroUsdc: unknown,
): DashboardRoundAccounting | null {
  if (value === null) return null;
  const raw = dashboardRecord(value);
  if (schemaVersion === 3) return decodeLegacyRoundAccounting(raw, paidMicroUsdc);
  dashboardExactKeys(raw, DASHBOARD_ROUND_KEYS);
  const accounting: DashboardRoundAccounting = {
    packSpendMicroUsdc: dashboardMoney(raw.packSpendMicroUsdc),
    buybackMicroUsdc: dashboardMoney(raw.buybackMicroUsdc),
    packGainMicroUsdc: dashboardMoney(raw.packGainMicroUsdc),
    packLossMicroUsdc: dashboardMoney(raw.packLossMicroUsdc),
    quotedCosts: decodeQuotedCosts(raw.quotedCosts),
    protectedCostsMicroUsdc: dashboardOptionalMoney(raw.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: dashboardOptionalMoney(raw.confirmedCostsMicroUsdc),
    cycleGainMicroUsdc: dashboardOptionalMoney(raw.cycleGainMicroUsdc),
    cycleLossMicroUsdc: dashboardOptionalMoney(raw.cycleLossMicroUsdc),
    walletBalanceBeforeMicroUsdc: dashboardOptionalMoney(raw.walletBalanceBeforeMicroUsdc),
    walletBalanceAfterMicroUsdc: dashboardOptionalMoney(raw.walletBalanceAfterMicroUsdc),
    networkFees: decodeNetworkFees(raw.networkFees),
    feeReserveBeforeMicroUsdc: dashboardOptionalMoney(raw.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: dashboardOptionalMoney(raw.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: dashboardOptionalMoney(raw.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: dashboardOptionalMoney(raw.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: dashboardOptionalMoney(raw.plannedHolderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: dashboardOptionalMoney(raw.paidHolderRewardsMicroUsdc),
    holderRewardsStatus: dashboardText(raw.holderRewardsStatus),
    distributionStatus: dashboardText(raw.distributionStatus),
  };
  assertDashboardExclusive(accounting.packGainMicroUsdc, accounting.packLossMicroUsdc);
  assertDashboardNullableExclusive(accounting.cycleGainMicroUsdc, accounting.cycleLossMicroUsdc);
  return accounting;
}

function decodeLegacyRoundAccounting(
  raw: Record<string, unknown>,
  paidMicroUsdc: unknown,
): DashboardRoundAccounting {
  const packSpend = BigInt(dashboardMoney(raw.packSpendMicroUsdc));
  const buyback = BigInt(dashboardMoney(raw.buybackMicroUsdc));
  const confirmedCosts = dashboardOptionalMoney(raw.confirmedCostsMicroUsdc);
  const completeCost = confirmedCosts === null ? null : packSpend + BigInt(confirmedCosts);
  return {
    packSpendMicroUsdc: packSpend.toString(),
    buybackMicroUsdc: buyback.toString(),
    packGainMicroUsdc: subtractAtZero(packSpend, buyback, true),
    packLossMicroUsdc: subtractAtZero(packSpend, buyback, false),
    quotedCosts: {
      outboundBridgeMicroUsdc: null,
      inboundBridgeMicroUsdc: null,
      collectorApiMicroUsdc: null,
      ethereumNetworkMicroUsdc: null,
      solanaNetworkMicroUsdc: null,
      slippageMicroUsdc: null,
    },
    protectedCostsMicroUsdc: dashboardMoney(raw.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: confirmedCosts,
    cycleGainMicroUsdc: completeCost === null
      ? null
      : (buyback > completeCost ? buyback - completeCost : BigInt(0)).toString(),
    cycleLossMicroUsdc: completeCost === null
      ? null
      : (completeCost > buyback ? completeCost - buyback : BigInt(0)).toString(),
    walletBalanceBeforeMicroUsdc: null,
    walletBalanceAfterMicroUsdc: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdc: dashboardMoney(raw.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: dashboardMoney(raw.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: dashboardMoney(raw.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: dashboardMoney(raw.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: dashboardMoney(raw.holderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: dashboardOptionalMoney(paidMicroUsdc),
    holderRewardsStatus: "computed",
    distributionStatus: paidMicroUsdc === null ? "pending" : "legacy-settlement-recorded",
  };
}

function decodeQuotedCosts(value: unknown): DashboardRoundAccounting["quotedCosts"] {
  const raw = dashboardRecord(value);
  dashboardExactKeys(raw, DASHBOARD_QUOTED_COST_KEYS);
  return {
    outboundBridgeMicroUsdc: dashboardOptionalMoney(raw.outboundBridgeMicroUsdc),
    inboundBridgeMicroUsdc: dashboardOptionalMoney(raw.inboundBridgeMicroUsdc),
    collectorApiMicroUsdc: dashboardOptionalMoney(raw.collectorApiMicroUsdc),
    ethereumNetworkMicroUsdc: dashboardOptionalMoney(raw.ethereumNetworkMicroUsdc),
    solanaNetworkMicroUsdc: dashboardOptionalMoney(raw.solanaNetworkMicroUsdc),
    slippageMicroUsdc: dashboardOptionalMoney(raw.slippageMicroUsdc),
  };
}

function decodeNetworkFees(value: unknown): DashboardRoundAccounting["networkFees"] {
  const raw = dashboardRecord(value);
  dashboardExactKeys(raw, DASHBOARD_NETWORK_FEE_KEYS);
  return {
    walletLamportsCharged: dashboardOptionalMoney(raw.walletLamportsCharged),
    purchase: decodeNativeFee(raw.purchase),
    buyback: decodeNativeFee(raw.buyback),
  };
}

function decodeNativeFee(value: unknown) {
  if (value === null) return null;
  const raw = dashboardRecord(value);
  dashboardExactKeys(raw, new Set(["lamports", "paidBy"]));
  return { lamports: dashboardMoney(raw.lamports), paidBy: dashboardText(raw.paidBy) };
}

function decodeDashboardTransaction(value: unknown) {
  const raw = dashboardRecord(value);
  dashboardExactKeys(raw, new Set(["chain", "purpose", "id"]));
  const chain = dashboardText(raw.chain);
  const purpose = dashboardText(raw.purpose);
  const id = dashboardText(raw.id);
  if (
    !(
      (chain === "ethereum" &&
        DASHBOARD_TRANSACTION_PURPOSES.ethereum.has(purpose) &&
        /^0x[0-9a-fA-F]{64}$/.test(id)) ||
      (chain === "solana" &&
        DASHBOARD_TRANSACTION_PURPOSES.solana.has(purpose) &&
        /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(id))
    )
  ) throw new Error(DASHBOARD_RESPONSE_INVALID);
  return { chain: chain as "ethereum" | "solana", purpose, id };
}

function assertDashboardExclusive(gain: string, loss: string) {
  if (gain !== "0" && loss !== "0") throw new Error(DASHBOARD_RESPONSE_INVALID);
}

function assertDashboardNullableExclusive(gain: string | null, loss: string | null) {
  if ((gain === null) !== (loss === null)) throw new Error(DASHBOARD_RESPONSE_INVALID);
  if (gain !== null && loss !== null) assertDashboardExclusive(gain, loss);
}

function subtractAtZero(packSpend: bigint, buyback: bigint, gain: boolean) {
  const left = gain ? buyback : packSpend;
  const right = gain ? packSpend : buyback;
  return (left > right ? left - right : BigInt(0)).toString();
}

function dashboardRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return value as Record<string, unknown>;
}

function dashboardExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>) {
  if (Object.keys(value).length !== keys.size) throw new Error(DASHBOARD_RESPONSE_INVALID);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
}

function dashboardArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(DASHBOARD_RESPONSE_INVALID);
  return value;
}

function dashboardText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return value;
}

function dashboardNullableText(value: unknown): string | null {
  return value === null ? null : dashboardText(value);
}

function dashboardOptionalText(value: unknown): string | null {
  return value === undefined || value === null ? null : dashboardText(value);
}

function dashboardTimestamp(value: unknown): string {
  const timestamp = dashboardText(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(DASHBOARD_RESPONSE_INVALID);
  return timestamp;
}

function dashboardNullableTimestamp(value: unknown): string | null {
  return value === null ? null : dashboardTimestamp(value);
}

function dashboardMoney(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return value;
}

function dashboardOptionalMoney(value: unknown): string | null {
  return value === undefined || value === null ? null : dashboardMoney(value);
}

function dashboardInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return value as number;
}

function dashboardBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(DASHBOARD_RESPONSE_INVALID);
  return value;
}

function responseCode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
