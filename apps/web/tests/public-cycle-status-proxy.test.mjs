import assert from "node:assert/strict";
import test from "node:test";

import { proxyPublicCycleStatus } from "../worker/public-cycle-proxy.ts";

function env(overrides = {}) {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    PUBLIC_DASHBOARD_PROFILE: "testnet",
    PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status",
    PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard",
    ...overrides,
  };
}

const testnetNetwork = {
  ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  solana: {
    name: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    label: "Solana Devnet",
  },
};

const publicStatus = {
  schemaVersion: 3,
  profile: "testnet",
  network: testnetNetwork,
  executionState: "active",
  executionReason: null,
  generatedAt: "2026-08-09T12:00:00.000Z",
  nextCycleAt: "2026-08-09T12:20:00.000Z",
  countdownSeconds: 1_200,
  cycle: null,
};

test("proxies only GET cycle status to one configured HTTPS upstream", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ request, init });
    return Response.json(publicStatus, {
      headers: { "cache-control": "private", "set-cookie": "private=secret" },
    });
  };
  try {
    const response = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status", {
        headers: { authorization: "Bearer browser-secret", cookie: "private=secret" },
      }),
      env(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), publicStatus);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=5, stale-while-revalidate=30",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].request), "https://operator.example/public/api/cycle-status");
    assert.equal(calls[0].init?.redirect, "manual");
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the live tracker connected to an empty schema-1 origin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    schemaVersion: 1,
    generatedAt: "2026-08-25T01:15:19.076Z",
    nextCycleAt: "2026-08-25T01:15:19.076Z",
    countdownSeconds: 0,
    cycle: null,
  });
  try {
    const response = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"),
      env(),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schemaVersion, 3);
    assert.equal(body.profile, "testnet");
    assert.deepEqual(body.network, testnetNetwork);
    assert.equal(body.executionState, "unknown");
    assert.equal(body.executionReason, null);
    assert.equal(body.cycle, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed before fetch for missing, partial, or mismatched paired configuration", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => (fetches += 1, Response.json(publicStatus));
  try {
    const invalidEnvironments = [
      env({ PUBLIC_DASHBOARD_PROFILE: undefined }),
      env({ PUBLIC_DASHBOARD_PROFILE: "production" }),
      env({ PUBLIC_CYCLE_STATUS_URL: "http://operator.example/public/api/cycle-status" }),
      env({ PUBLIC_CYCLE_STATUS_URL: "https://operator.example/status" }),
      env({ PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://other.example/public/api/community-dashboard" }),
      env({ PUBLIC_CYCLE_STATUS_URL: "https://user@operator.example/public/api/cycle-status" }),
      env({ PUBLIC_CYCLE_STATUS_URL: "https://operator.example:8443/public/api/cycle-status" }),
      env({ PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status?debug=1" }),
      env({ PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard#fragment" }),
    ];
    for (const workerEnv of invalidEnvironments) {
      const response = await proxyPublicCycleStatus(
        new Request("https://hookemon.example/api/cycle-status"),
        workerEnv,
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "PUBLIC_CYCLE_STATUS_UNAVAILABLE" });
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects methods, caller queries, malformed bodies, and response profile mismatches", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const method = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status", { method: "POST" }),
      env(),
    );
    assert.equal(method.status, 405);
    const query = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status?profile=mainnet"),
      env(),
    );
    assert.equal(query.status, 400);

    globalThis.fetch = async () => Response.json({ ...publicStatus, privateKey: "must-not-pass" });
    const malformed = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"), env(),
    );
    assert.equal(malformed.status, 502);

    globalThis.fetch = async () => Response.json({
      ...publicStatus,
      profile: "mainnet",
      network: {
        ethereum: { name: "mainnet", chainId: 1, label: "Ethereum" },
        solana: {
          name: "mainnet-beta",
          genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
          label: "Solana",
        },
      },
    });
    const mismatch = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"), env(),
    );
    assert.equal(mismatch.status, 502);
    assert.deepEqual(await mismatch.json(), { code: "PUBLIC_CYCLE_STATUS_INVALID" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps the tracker available when the operator raises the booster hard cap", async () => {
  const originalFetch = globalThis.fetch;
  const cards = Array.from({ length: 60 }, (_, index) => ({
    productId: `product-${index}`,
    rarity: "illustration-rare",
    nftAddress: null,
    cardName: `Collector card ${index}`,
    setName: null,
    cardNumber: null,
    imageUrl: `https://images.example/cards/${index}.webp`,
    packPriceMicroUsdc: null,
    buybackMicroUsdc: null,
  }));
  const hardCapStatus = {
    ...publicStatus,
    cycle: {
      cycleId: "manual-hard-cap",
      status: "opening",
      selectedPackId: "collector-pack",
      maxBoostersPerCycle: 20_000,
      plannedBoosters: 20_000,
      openedBoosters: 20_000,
      actions: [],
      cards,
      returnedMicroUsdc: null,
      rewardStatus: null,
      roundAccounting: null,
    },
  };
  globalThis.fetch = async () => Response.json(hardCapStatus);
  try {
    const response = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"),
      env(),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.cycle.openedBoosters, 20_000);
    assert.equal(body.cycle.cards.length, 60);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("caps chunked cycle bodies while accepting an exact byte-limit response", async () => {
  const originalFetch = globalThis.fetch;
  const maximumBytes = 1_000_000;
  try {
    let canceled = false;
    globalThis.fetch = async () => chunkedJsonResponse(publicStatus, maximumBytes + 1, {
      onCancel: () => { canceled = true; },
      keepOpen: true,
    });
    const oversized = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"),
      env(),
    );
    assert.equal(oversized.status, 502);
    assert.deepEqual(await oversized.json(), { code: "PUBLIC_CYCLE_STATUS_INVALID" });
    assert.equal(canceled, true);

    globalThis.fetch = async () => chunkedJsonResponse(publicStatus, maximumBytes);
    const boundary = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"),
      env(),
    );
    assert.equal(boundary.status, 200);
    assert.deepEqual(await boundary.json(), publicStatus);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancels cycle response bodies rejected from status or content-length headers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const responseInit of [
      { status: 500 },
      { status: 200, contentLength: "invalid" },
      { status: 200, contentLength: "1000001" },
      { status: 500, cancelError: new Error("private upstream cancel detail") },
    ]) {
      let canceled = false;
      globalThis.fetch = async () => cancelableHeaderResponse(responseInit, () => {
        canceled = true;
        if (responseInit.cancelError) throw responseInit.cancelError;
      });

      const response = await proxyPublicCycleStatus(
        new Request("https://hookemon.example/api/cycle-status"),
        env(),
      );

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "PUBLIC_CYCLE_STATUS_UNAVAILABLE" });
      assert.equal(canceled, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function cancelableHeaderResponse({ status, contentLength }, onCancel) {
  const headers = contentLength === undefined ? undefined : { "content-length": contentLength };
  return new Response(new ReadableStream({ cancel: onCancel }), { status, headers });
}

function chunkedJsonResponse(value, totalBytes, { onCancel = () => {}, keepOpen = false } = {}) {
  const encoder = new TextEncoder();
  const json = encoder.encode(JSON.stringify(value));
  assert.ok(totalBytes >= json.byteLength);
  const chunks = [json, encoder.encode(" ".repeat(totalBytes - json.byteLength))];
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        if (!keepOpen) controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel() { onCancel(); },
  }), { headers: { "content-type": "application/json" } });
}
