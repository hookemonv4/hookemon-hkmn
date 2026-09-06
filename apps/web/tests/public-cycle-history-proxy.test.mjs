import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { proxyPublicCycleHistory } from "../worker/public-cycle-history-proxy.ts";
import { normalizePublicCycleHistory } from "../lib/public-cycle-history.ts";

test("worker routes the exact public cycle-history path through the history proxy", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ proxyPublicCycleHistory \} from ["']\.\/public-cycle-history-proxy["']/);
  assert.match(source, /url\.pathname === ["']\/api\/cycle-history["']/);
  assert.match(source, /proxyPublicCycleHistory\(request, env\)/);
});

function env(overrides = {}) {
  return {
    PUBLIC_DASHBOARD_PROFILE: "testnet",
    PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status",
    PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard",
    PUBLIC_CYCLE_HISTORY_URL: "https://operator.example/public/api/cycle-history",
    ...overrides,
  };
}

const testnetNetwork = {
  evm: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  solana: {
    name: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    label: "Solana Devnet",
  },
};

function historyPage(overrides = {}) {
  return {
    schemaVersion: 1,
    profile: "testnet",
    network: testnetNetwork,
    generatedAt: "2026-09-06T12:00:00.000Z",
    asOf: "2026-09-06T11:59:55.000Z",
    historyComplete: true,
    items: [
      { cycleId: "cycle-2", status: "complete", terminalAt: "2026-09-06T11:00:00.000Z", updatedAt: "2026-09-06T11:00:01.000Z" },
      { cycleId: "cycle-1", status: "complete", terminalAt: "2026-09-06T10:00:00.000Z", updatedAt: "2026-09-06T10:00:01.000Z" },
    ],
    nextCursor: null,
    ...overrides,
  };
}

test("forwards only limit/cursor to the exact configured HTTPS upstream and validates the response", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ request, init });
    return Response.json(historyPage(), { headers: { "cache-control": "private" } });
  };
  try {
    const response = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history?limit=5&cursor=abc123"),
      env(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), historyPage());
    assert.equal(response.headers.get("cache-control"), "public, max-age=30, stale-while-revalidate=60");
    assert.equal(calls.length, 1);
    const [call] = calls;
    const upstreamUrl = new URL(String(call.request));
    assert.equal(upstreamUrl.origin, "https://operator.example");
    assert.equal(upstreamUrl.pathname, "/public/api/cycle-history");
    assert.equal(upstreamUrl.searchParams.get("limit"), "5");
    assert.equal(upstreamUrl.searchParams.get("cursor"), "abc123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unsupported methods, unknown query keys, an oversized limit, and an empty cursor before fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return Response.json(historyPage());
  };
  try {
    const post = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history", { method: "POST" }),
      env(),
    );
    assert.equal(post.status, 405);

    const unknownKey = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history?debug=1"),
      env(),
    );
    assert.equal(unknownKey.status, 400);

    const oversizedLimit = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history?limit=21"),
      env(),
    );
    assert.equal(oversizedLimit.status, 400);

    const zeroLimit = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history?limit=0"),
      env(),
    );
    assert.equal(zeroLimit.status, 400);

    const emptyCursor = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history?cursor="),
      env(),
    );
    assert.equal(emptyCursor.status, 400);

    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed on a backend outage, an oversized body, or an invalid response shape", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("upstream down", { status: 503 });
    const outage = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history"),
      env(),
    );
    assert.equal(outage.status, 503);
    assert.deepEqual(await outage.json(), { code: "PUBLIC_CYCLE_HISTORY_UNAVAILABLE" });

    globalThis.fetch = async () => Response.json({ schemaVersion: 1 });
    const invalidShape = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history"),
      env(),
    );
    assert.equal(invalidShape.status, 502);
    assert.deepEqual(await invalidShape.json(), { code: "PUBLIC_CYCLE_HISTORY_INVALID" });

    globalThis.fetch = async () => new Response("timeout");
    // Missing configuration must also fail closed, never fall back to an invented empty page.
    const missingConfig = await proxyPublicCycleHistory(
      new Request("https://hookemon.example/api/cycle-history"),
      env({ PUBLIC_CYCLE_HISTORY_URL: undefined }),
    );
    assert.equal(missingConfig.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizePublicCycleHistory rejects out-of-order items, an incomplete page carrying items, and a null-terminalAt gap", () => {
  const outOfOrder = historyPage({
    items: [
      { cycleId: "cycle-1", status: "complete", terminalAt: "2026-09-06T10:00:00.000Z", updatedAt: null },
      { cycleId: "cycle-2", status: "complete", terminalAt: "2026-09-06T11:00:00.000Z", updatedAt: null },
    ],
  });
  assert.throws(() => normalizePublicCycleHistory(outOfOrder, "testnet"), /PUBLIC_CYCLE_HISTORY_INVALID/);

  const incompleteWithItems = historyPage({ historyComplete: false });
  assert.throws(() => normalizePublicCycleHistory(incompleteWithItems, "testnet"), /PUBLIC_CYCLE_HISTORY_INVALID/);

  const incompleteEmpty = historyPage({ historyComplete: false, items: [], nextCursor: null });
  assert.deepEqual(normalizePublicCycleHistory(incompleteEmpty, "testnet"), incompleteEmpty);

  // A missing terminalAtMs anywhere in the source set fails the whole page closed upstream
  // (items: []) rather than reordering the reachable subset; the client-side validator only needs
  // to accept that honest empty/incomplete shape, not synthesize an order for a null terminalAt.
  const pendingTerminal = historyPage({
    items: [{ cycleId: "cycle-3", status: "awaiting-terminal-timestamp", terminalAt: null, updatedAt: null }],
  });
  const result = normalizePublicCycleHistory(pendingTerminal, "testnet");
  assert.equal(result.items[0].terminalAt, null);
});

test("normalizePublicCycleHistory rejects a mismatched profile and an unknown field", () => {
  assert.throws(
    () => normalizePublicCycleHistory(historyPage(), "mainnet"),
    /PUBLIC_CYCLE_HISTORY_INVALID/,
  );
  const extraField = historyPage();
  extraField.extra = "nope";
  assert.throws(
    () => normalizePublicCycleHistory(extraField, "testnet"),
    /PUBLIC_CYCLE_HISTORY_INVALID/,
  );
});
