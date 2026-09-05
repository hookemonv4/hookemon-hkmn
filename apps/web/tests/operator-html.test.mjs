import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webRoot = new URL("../", import.meta.url);

async function renderOperator() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `operator-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("https://hookemon.example/operator", {
      headers: {
        accept: "text/html",
        "cf-access-jwt-assertion": "test-access-assertion",
      },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders one private live operations dashboard with bounded cycle controls", async () => {
  const response = await renderOperator();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(response.headers.get("x-frame-options"), "DENY");

  const html = await response.text();
  assert.match(html, /<meta name="robots" content="[^"]*noindex[^"]*nofollow/i);
  for (const text of [
    "Operator-Steuerung",
    "Verbindung zum Zyklusdienst ausstehend",
    "Nächster Zyklus",
    "Zyklusintervall",
    "Zahlen, Guthaben und Aktivität",
    "Pool beim letzten Zyklusstart",
    "Bestätigte Buybacks",
    "Zurück transferiert",
    "Letzte tatsächliche Ausschüttung",
    "Übersicht als Bild herunterladen",
    "Automatische Auswahl",
    "Eigene Packauswahl",
    "Maximaler Packpreis",
    "Maximale Booster pro Zyklus",
    "Startwert 100",
    "Collector-Bruttobelastung",
    "Nächste Gebührenreserve",
    "Zyklusbudget",
    "24-Stunden-Budget",
    "Automatische Zyklen aktivieren",
    "Nächsten zulässigen Zyklus jetzt starten",
    "Nächsten planmäßigen Zyklus überspringen",
    "Entscheidungshistorie",
  ]) assert.match(html, new RegExp(text, "i"));
});

test("keeps operator commands auditable, concurrency-safe and execution-free", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /x-hookemon-request/);
  assert.match(source, /cache:\s*["']no-store["']/);
  assert.match(source, /maxBoostersPerCycle:\s*Number\(form\.maxBoostersPerCycle\)/);
  assert.match(source, /cycleIntervalMinutes:\s*Number\(form\.cycleIntervalMinutes\)/);
  assert.match(source, /min=\{15\}/);
  assert.match(source, /15–60 Minuten/);
  assert.match(source, /type:\s*["']run-cycle-now["']/);
  assert.match(source, /type:\s*["']skip-next-cycle["']/);
  assert.match(source, /\/operator\/api\/dashboard/);
  assert.match(source, /downloadCommunityCard/);
  assert.match(source, /cycleStartProjectPoolMicroUsdc/);
  assert.match(source, /latestCycleTopAllocations/);
  assert.match(source, /historyComplete/);
  assert.doesNotMatch(source, />Cumulative</);
  assert.match(source, /manualPackOrders:/);
  assert.match(source, /quantityFor\(pack\.id\)/);
  assert.match(source, /parseGermanUsdc\(form\.maxUnitPriceMicroUsdc\)/);
  assert.match(source, /configurationSnapshotFromForm/);
  assert.match(source, /commandConfirmation/);
  assert.match(source, /Ungespeicherte Änderungen werden für diesen Befehl nicht verwendet/);
  assert.match(source, /replaceForm:\s*command\.type === "update-configuration"/);
  assert.match(source, /\/operator\/api\/audit\?[^"'`]*cursor/);
  assert.doesNotMatch(
    source,
    /PRIVY|signTransaction|submitTransaction|ETHEREUM_RPC_URL|SOLANA_RPC_URL/i,
  );
});

test("decodes rolling dashboard schemas fail-closed before rendering arrays", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /readJson<unknown>\(response\)/);
  assert.match(source, /decodeDashboard\(body\)/);
  assert.match(source, /schemaVersion === 1/);
  assert.match(source, /schemaVersion !== 4/);
  assert.match(source, /raw\.top200/);
  assert.match(source, /raw\.latestCycleTopAllocations/);
  assert.match(source, /DASHBOARD_RESPONSE_UNSUPPORTED/);
  assert.match(source, /setDashboard\(null\)/);
  assert.doesNotMatch(source, /readJson<Dashboard/);
});

test("renders complete and truthful German Holder Rewards accounting from dashboard schema v4", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label="Letzte Holder-Rewards-Runde"/);
  for (const label of [
    "Packausgaben",
    "Buyback",
    "Packgewinn",
    "Packverlust",
    "Wallet vorher",
    "Wallet nachher",
    "Angebot ausgehender Transfer",
    "Angebot Rücktransfer",
    "Angebot Collector-API",
    "Angebot Ethereum-Netzwerk",
    "Angebot Solana-Netzwerk",
    "Angebot Slippage",
    "Geschützte Kostenprognose",
    "Bestätigte Kosten",
    "Transaktionsgebühr Kauf",
    "Transaktionsgebühr Buyback",
    "Gebühr Player-Wallet",
    "Reserve vorher",
    "Reserveziel (50 %)",
    "Reserveauffüllung",
    "Reserve nachher",
    "Geplante Holder Rewards",
    "Tatsächlich ausgezahlt",
    "Berechtigte Zuteilungen",
    "Vollständiger Zyklusgewinn",
    "Vollständiger Zyklusverlust",
  ]) assert.match(source, new RegExp(label.replace(/[()]/g, "\\$&")));
  assert.match(source, /Bestätigte Belege stehen aus/);
  assert.match(source, /In dieser Prüfung nicht ausgeführt/);
  assert.doesNotMatch(source, /label="Rewards paid"/);
  assert.match(source, /historicalMicroUsdc/);
  assert.match(source, /Historie unvollständig/);
  assert.match(source, /Gebührenbeleg nicht verfügbar/);
  assert.match(source, /Lamports/);
  assert.match(source, /Bezahlt von/);
  assert.match(source, /decodeLegacyRoundAccounting\(raw, paidMicroUsdc\)/);
  assert.match(source, /decodeRoundAccounting/);
  assert.doesNotMatch(source, /label="(?:Donation|Spende|Guaranteed profit|Holder Rewards)"/i);
});

test("distinguishes the initial German dashboard load from empty and failed data", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /Bestätigte Dashboard-Daten werden geladen…/);
  assert.match(source, /Bestätigte Zuteilungen werden geladen…/);
  assert.match(source, /Zuteilungen sind ohne Dashboard-Daten nicht verfügbar\./);
  assert.match(source, /dashboardPlaceholder/);
  assert.match(source, /Noch keine abgeschlossene Runde/);
  assert.match(source, /OperatorCardHistory/);
});

test("shows the cycle-start pool only with an observation timestamp", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");
  const poolSource = await readFile(new URL("../lib/operator-dashboard-pool.ts", import.meta.url), "utf8");

  assert.match(source, /formatCycleStartProjectPool/);
  assert.match(source, /decodeCycleStartProjectPool\(poolValue, observedAt\)/);
  assert.match(source, /Nicht beobachtet/);
  assert.match(source, /Stand \$\{formatDate/);
  assert.match(poolSource, /\(decodedPool === null\) !== \(decodedObservedAt === null\)/);
  assert.doesNotMatch(
    source,
    /cycleStartProjectPoolMicroUsdc \?\? ["']0["']/,
  );
});

test("uses isolated responsive styling with visible focus and minimum touch targets", async () => {
  const css = await readFile(new URL("../app/operator/operator.module.css", import.meta.url), "utf8");

  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\([^)]*max-width:\s*700px/);
  assert.match(css, /\.accountingGroups/);
  assert.match(css, /\.accountingGroup/);
  assert.match(css, /prefers-reduced-motion/);
  assert.equal(await exists(new URL("../app/operator/page.tsx", import.meta.url)), true);
  assert.equal(webRoot.pathname.endsWith("/apps/web/"), true);
});

test("provides live cards and a German filterable card history", async () => {
  const source = await readFile(
    new URL("../app/operator/OperatorCardHistory.tsx", import.meta.url),
    "utf8",
  );

  for (const text of [
    "Live gezogene Karten",
    "Kartenhistorie",
    "Mindest-Buyback",
    "Höchst-Buyback",
    "Neueste zuerst",
    "Buyback absteigend",
    "Buyback aufsteigend",
    "Filter anwenden",
    "Zurücksetzen",
    "Weitere Karten laden",
    "Noch nicht bestätigt",
    "Kein Kartenbild bestätigt",
  ]) assert.match(source, new RegExp(text));
  assert.match(source, /\/operator\/api\/cards/);
  assert.match(source, /encodeURIComponent/);
  assert.match(source, /cardResultMicroUsdc/);
  assert.match(source, /alt=""/);
  assert.match(source, /card\.cardName/);
  assert.match(source, /AbortController/);
  assert.match(source, /limit", "24"/);
});

test("separates the running cycle from persistent next-cycle settings in German", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../app/operator/page.tsx", import.meta.url), "utf8");

  for (const text of [
    "Operator-Steuerung",
    "Laufender Zyklus",
    "Ab nächstem Zyklus",
    "Automatische Auswahl",
    "Eigene Packauswahl",
    "Menge",
    "Maximaler Packpreis",
    "Zyklusbudget",
    "24-Stunden-Budget",
    "Zyklusintervall",
    "Gilt ab dem nächsten neu gestarteten Zyklus und bleibt gültig, bis du die Einstellung änderst.",
    "Konfiguration speichern",
    "Automatische Zyklen aktivieren",
    "Nächsten zulässigen Zyklus jetzt starten",
    "Nächsten planmäßigen Zyklus überspringen",
    "Entscheidungshistorie",
    "Technische Details",
  ]) assert.match(source, new RegExp(text));
  for (const english of [
    "Operator control",
    "Recent cards",
    "Run cycle now",
    "Save configuration",
    "Loading verified",
    "History incomplete",
  ]) assert.doesNotMatch(source, new RegExp(english));
  assert.match(source, /dashboard\.activeCycle/);
  assert.match(source, /Nach diesem Zyklus pausieren/);
  assert.match(source, /<OperatorCardHistory/);
  assert.match(source, /liveCards=\{dashboard\?\.cards \?\? \[\]\}/);
  assert.match(source, /activeCycleId=\{dashboard\?\.activeCycle\?\.cycleId \?\? null\}/);
  assert.match(pageSource, /title: "Operator-Steuerung · Hookemon"/);
  assert.doesNotMatch(pageSource, /Operator control|Private Hookemon policy/);
});

async function exists(url) {
  try {
    await readFile(url);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
