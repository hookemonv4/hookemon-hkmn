import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBindingOperatorControlHandler } from "../../operator/src/operator-control-api.js";
import { DurableOperatorControlStore } from "../../operator/src/operator-control-durable-store.js";
import { verifyDecisionChain } from "../../operator/src/operator-control-store.js";

const ORIGIN = "https://hookemon.example";
const NOW_MS = 1_010_000;
const HARD_CAPS = {
  maxBoostersPerCycle: 10,
  maxUnitPriceMicroUsdc: 100_000_000n,
  maxCycleBudgetMicroUsdc: 500_000_000n,
  max24HourBudgetMicroUsdc: 2_000_000_000n,
};

test("keeps German next-cycle form values separate from canonical decision payloads", async () => {
  const source = await readFile(
    new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /germanMoneyFormValue\(state\.maxUnitPriceMicroUsdc\)/);
  assert.match(source, /parseGermanUsdc\(form\.maxUnitPriceMicroUsdc\)/);
  assert.match(source, /manualPackOrders = form\.mode === "community"/);
  assert.match(source, /catalogPacks\.flatMap/);
  assert.match(source, /quantity > 0 \? \[\{ productId: pack\.id, quantity \}\] : \[\]/);
  assert.match(source, /Gesamtmenge/);
  assert.match(source, /Collector-Bruttobelastung/);
  assert.match(source, /configurationSnapshotFromState\(bootstrap\.state\)/);
  assert.match(source, /Gespeicherte Konfiguration:/);
  assert.match(source, /Ungespeicherte Änderungen werden für diesen Befehl nicht verwendet/);
  assert.match(source, /command\.type === "update-configuration"/);
  assert.match(source, /Nach diesem Zyklus pausieren/);
  assert.doesNotMatch(source, /abort-active-cycle|cancel-active-cycle/);
});

test("persists the exact website control flow through pause, pack changes, and reactivation", async () => {
  const fixture = durableFixture();
  const handler = fixture.handler();

  const [bootstrap, dashboard, emptyAudit] = await Promise.all([
    get(handler, "/operator/api/bootstrap"),
    get(handler, "/operator/api/dashboard"),
    get(handler, "/operator/api/audit?limit=100"),
  ]);
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.state.version, 0);
  assert.equal(bootstrap.body.state.desiredStatus, "paused");
  assert.deepEqual(bootstrap.body.catalog.packs.map(({ id }) => id), ["pokemon_25", "one-piece_10"]);
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.schemaVersion, 2);
  assert.deepEqual(emptyAudit.body.decisions, []);

  const configurationA = communityConfiguration({
    communityPackIds: ["pokemon_25", "one-piece_10"],
    manualPackOrders: [
      { productId: "pokemon_25", quantity: 2 },
      { productId: "one-piece_10", quantity: 1 },
    ],
    maxBoostersPerCycle: 5,
    cycleIntervalMinutes: 15,
    maxUnitPriceMicroUsdc: "60000000",
    maxCycleBudgetMicroUsdc: "150000000",
    max24HourBudgetMicroUsdc: "500000000",
  });
  let version = 0;
  version = await accepted(handler, version, {
    type: "update-configuration",
    configuration: configurationA,
  });

  const reloadedA = await get(handler, "/operator/api/bootstrap");
  assert.equal(reloadedA.body.state.version, version);
  assert.deepEqual(stateConfiguration(reloadedA.body.state), configurationA);

  for (const command of [
    { type: "activate" },
    { type: "run-cycle-now" },
    { type: "skip-next-cycle" },
    { type: "pause" },
  ]) {
    version = await accepted(handler, version, command);
  }

  const paused = await get(handler, "/operator/api/bootstrap");
  assert.equal(paused.body.state.desiredStatus, "paused");
  assert.equal(paused.body.state.runNowSequence, 3);
  assert.equal(paused.body.state.skipNextCycleSequence, 4);

  const configurationB = communityConfiguration({
    communityPackIds: ["one-piece_10"],
    manualPackOrders: [{ productId: "one-piece_10", quantity: 2 }],
    maxBoostersPerCycle: 4,
    cycleIntervalMinutes: 30,
    maxUnitPriceMicroUsdc: "45000000",
    maxCycleBudgetMicroUsdc: "100000000",
    max24HourBudgetMicroUsdc: "600000000",
  });
  version = await accepted(handler, version, {
    type: "update-configuration",
    configuration: configurationB,
  });
  version = await accepted(handler, version, { type: "activate" });

  const reloadedB = await get(handler, "/operator/api/bootstrap");
  assert.equal(reloadedB.body.state.version, version);
  assert.equal(reloadedB.body.state.desiredStatus, "active");
  assert.deepEqual(stateConfiguration(reloadedB.body.state), configurationB);

  const audit = await get(handler, "/operator/api/audit?limit=100");
  assert.deepEqual(
    audit.body.decisions.map(({ action, outcome, resultCode }) => ({ action, outcome, resultCode })),
    [
      acceptedDecision("activate"),
      acceptedDecision("update-configuration"),
      acceptedDecision("pause"),
      acceptedDecision("skip-next-cycle"),
      acceptedDecision("run-cycle-now"),
      acceptedDecision("activate"),
      acceptedDecision("update-configuration"),
    ],
  );
  assert.equal(verifyDecisionChain(audit.body.decisions), true);
  fixture.database.close();
});

test("rejects unsafe website proposals without losing the append-only audit chain", async () => {
  const fixture = durableFixture();
  const handler = fixture.handler();
  let version = 0;
  version = await accepted(handler, version, {
    type: "update-configuration",
    configuration: communityConfiguration(),
  });

  const rejectedConfigurations = [
    [
      communityConfiguration({
        communityPackIds: ["not-allowed"],
        manualPackOrders: [{ productId: "not-allowed", quantity: 1 }],
      }),
      "COMMUNITY_PACK_UNAVAILABLE",
    ],
    [
      communityConfiguration({
        communityPackIds: ["pokemon_25", "pokemon_25"],
        manualPackOrders: [
          { productId: "pokemon_25", quantity: 1 },
          { productId: "pokemon_25", quantity: 1 },
        ],
      }),
      "COMMUNITY_PACK_DUPLICATE",
    ],
    [
      communityConfiguration({
        manualPackOrders: [{ productId: "pokemon_25", quantity: 5 }],
      }),
      "MANUAL_PACK_STOCK_EXCEEDED",
    ],
    [
      communityConfiguration({
        manualPackOrders: [{ productId: "pokemon_25", quantity: 11 }],
      }),
      "MANUAL_PACK_QUANTITY_INVALID",
    ],
    [
      communityConfiguration({ maxUnitPriceMicroUsdc: "30000000" }),
      "COMMUNITY_PACK_PRICE_EXCEEDS_LIMIT",
    ],
    [
      communityConfiguration({
        manualPackOrders: [{ productId: "pokemon_25", quantity: 2 }],
        maxCycleBudgetMicroUsdc: "60000000",
      }),
      "MANUAL_PACK_BUDGET_EXCEEDED",
    ],
  ];

  for (const [configuration, code] of rejectedConfigurations) {
    await rejected(handler, version, {
      type: "update-configuration",
      configuration,
    }, code, 400);
  }

  fixture.catalog = { ...freshCatalog(), fetchedAtMs: NOW_MS - 120_001 };
  await rejected(handler, version, {
    type: "update-configuration",
    configuration: communityConfiguration(),
  }, "CATALOG_STALE", 400);
  fixture.catalog = freshCatalog();

  await rejected(handler, version + 1, { type: "activate" }, "OPERATOR_STATE_VERSION_CONFLICT", 409);
  const viewer = fixture.handler({ role: "viewer" });
  await rejected(viewer, version, { type: "activate" }, "OPERATOR_ROLE_REQUIRED", 403);

  const malformed = await handler(decisionRequest("{", { rawBody: true }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { code: "OPERATOR_BODY_INVALID" });

  const audit = fixture.store.listDecisions({ limit: 100 });
  assert.equal(audit.length, 10);
  assert.equal(audit.filter(({ outcome }) => outcome === "accepted").length, 1);
  assert.equal(audit.filter(({ outcome }) => outcome === "rejected").length, 9);
  assert.equal(verifyDecisionChain(audit), true);
  assert.equal(fixture.store.readState().version, version);
  fixture.database.close();
});

test("keeps pause available during catalog failure and sanitizes persistence failure", async () => {
  const fixture = durableFixture();
  const handler = fixture.handler();
  let version = await accepted(handler, 0, {
    type: "update-configuration",
    configuration: communityConfiguration(),
  });
  version = await accepted(handler, version, { type: "activate" });

  const unavailableCatalog = fixture.handler({ catalogFailure: true });
  version = await accepted(unavailableCatalog, version, { type: "pause" });
  assert.equal(fixture.store.readState().desiredStatus, "paused");

  const unavailableStore = fixture.handler({ persistenceFailure: true });
  const failed = await unavailableStore(decisionRequest(decisionBody(version, { type: "pause" })));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { code: "OPERATOR_PERSISTENCE_UNAVAILABLE" });
  assert.equal(fixture.store.readState().version, version);
  assert.equal(verifyDecisionChain(fixture.store.listDecisions({ limit: 100 })), true);
  fixture.database.close();
});

function durableFixture() {
  const database = new DatabaseSync(":memory:");
  const storage = sqliteStorage(database);
  let eventNumber = 0;
  let requestNumber = 0;
  const store = new DurableOperatorControlStore({
    storage,
    now: () => "2026-08-19T12:00:00.000Z",
    eventId: () => uuid(2, ++eventNumber),
  });
  store.initialize();
  const fixture = {
    database,
    store,
    catalog: freshCatalog(),
    handler({ role = "operator", catalogFailure = false, persistenceFailure = false } = {}) {
      return createBindingOperatorControlHandler({
        allowedOrigin: ORIGIN,
        hardCaps: HARD_CAPS,
        authenticator: {
          async authenticate() {
            return {
              issuer: "https://team.cloudflareaccess.com",
              subject: `${role}-subject`,
              email: `${role}@example.com`,
              role,
            };
          },
        },
        store: persistenceFailure
          ? {
              readState: () => store.readState(),
              listDecisions: (options) => store.listDecisions(options),
              submitDecision: async () => { throw new Error("OPERATOR_CONTROL_DECISION_FAILED"); },
            }
          : store,
        catalogService: {
          async read() {
            if (catalogFailure) throw new Error("OPERATOR_CATALOG_READ_FAILED");
            return structuredClone(fixture.catalog);
          },
        },
        dashboardStore: {
          async readDashboard() {
            return { schemaVersion: 2, generatedAt: "2026-08-19T12:00:00.000Z" };
          },
        },
        now: () => NOW_MS,
        requestId: () => uuid(3, ++requestNumber),
      });
    },
  };
  return fixture;
}

function sqliteStorage(database) {
  return {
    sql: {
      exec(sql, ...parameters) {
        const statement = database.prepare(sql);
        return /^\s*(?:SELECT|PRAGMA)/i.test(sql)
          ? statement.all(...parameters)
          : statement.run(...parameters);
      },
    },
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function freshCatalog() {
  return {
    status: "fresh",
    fetchedAtMs: 1_000_000,
    packs: [
      { id: "pokemon_25", name: "Pokemon Pack", priceMicroUsdc: "50000000", available: 4 },
      { id: "one-piece_10", name: "One Piece Pack", priceMicroUsdc: "40000000", available: 5 },
    ],
  };
}

function communityConfiguration(overrides = {}) {
  return {
    mode: "community",
    communityPackIds: ["pokemon_25"],
    manualPackOrders: [{ productId: "pokemon_25", quantity: 1 }],
    maxBoostersPerCycle: 10,
    cycleIntervalMinutes: 20,
    maxUnitPriceMicroUsdc: "60000000",
    maxCycleBudgetMicroUsdc: "200000000",
    max24HourBudgetMicroUsdc: "1000000000",
    ...overrides,
  };
}

function stateConfiguration(state) {
  return {
    mode: state.mode,
    communityPackIds: state.communityPackIds,
    manualPackOrders: state.manualPackOrders,
    maxBoostersPerCycle: state.maxBoostersPerCycle,
    cycleIntervalMinutes: state.cycleIntervalMinutes,
    maxUnitPriceMicroUsdc: state.maxUnitPriceMicroUsdc,
    maxCycleBudgetMicroUsdc: state.maxCycleBudgetMicroUsdc,
    max24HourBudgetMicroUsdc: state.max24HourBudgetMicroUsdc,
  };
}

async function accepted(handler, expectedVersion, command) {
  const { response, body } = await submit(handler, expectedVersion, command);
  assert.equal(response.status, 200, body.code);
  assert.equal(body.code, "DECISION_ACCEPTED");
  assert.equal(body.state.version, expectedVersion + 1);
  return body.state.version;
}

async function rejected(handler, expectedVersion, command, code, status) {
  const result = await submit(handler, expectedVersion, command);
  assert.equal(result.response.status, status, code);
  assert.equal(result.body.code, code);
  assert.equal(result.body.state.version, Math.min(expectedVersion, result.body.state.version));
}

async function submit(handler, expectedVersion, command) {
  const response = await handler(decisionRequest(decisionBody(expectedVersion, command)));
  return { response, body: await response.json() };
}

function decisionBody(expectedVersion, command) {
  return {
    requestId: uuid(1, ++decisionBody.sequence),
    expectedVersion,
    command,
  };
}
decisionBody.sequence = 0;

function decisionRequest(body, { rawBody = false } = {}) {
  return new Request(`${ORIGIN}/operator/api/decisions`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": "test-assertion",
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-hookemon-request": "operator-control",
    },
    body: rawBody ? body : JSON.stringify(body),
  });
}

async function get(handler, path) {
  const response = await handler(new Request(`${ORIGIN}${path}`, {
    headers: { "cf-access-jwt-assertion": "test-assertion" },
  }));
  return { response, body: await response.json() };
}

function acceptedDecision(action) {
  return { action, outcome: "accepted", resultCode: "DECISION_ACCEPTED" };
}

function uuid(namespace, value) {
  return `${namespace}0000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
