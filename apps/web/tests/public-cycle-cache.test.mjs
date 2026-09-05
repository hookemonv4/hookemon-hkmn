import assert from "node:assert/strict";
import test from "node:test";

import { proxyPublicCycleStatus } from "../worker/public-cycle-proxy.ts";

const publicStatus = {
  schemaVersion: 3,
  profile: "testnet",
  network: {
    ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
    solana: {
      name: "devnet",
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      label: "Solana Devnet",
    },
  },
  executionState: "active",
  executionReason: null,
  generatedAt: "2026-08-09T12:00:00.000Z",
  nextCycleAt: "2026-08-09T12:20:00.000Z",
  countdownSeconds: 1_200,
  cycle: null,
};

function memoryCache() {
  const entries = new Map();
  return {
    async match(request) {
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      entries.set(request.url, response.clone());
    },
  };
}

test("coalesces concurrent misses and edge-caches only a validated success", async () => {
  const originalFetch = globalThis.fetch;
  let originCalls = 0;
  let releaseOrigin;
  const originGate = new Promise((resolve) => { releaseOrigin = resolve; });
  globalThis.fetch = async () => {
    originCalls += 1;
    await originGate;
    return Response.json(publicStatus);
  };
  const cache = memoryCache();
  const request = new Request("https://hookemon.example/api/cycle-status");
  const env = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    PUBLIC_DASHBOARD_PROFILE: "testnet",
    PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status",
    PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard",
  };
  try {
    const first = proxyPublicCycleStatus(request, env, cache);
    const second = proxyPublicCycleStatus(request, env, cache);
    releaseOrigin();
    const responses = await Promise.all([first, second]);

    assert.equal(originCalls, 1);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "public, max-age=5, stale-while-revalidate=30");
      assert.deepEqual(await response.json(), publicStatus);
    }

    const cached = await proxyPublicCycleStatus(request, env, cache);
    assert.equal(cached.status, 200);
    assert.equal(originCalls, 1);
    assert.deepEqual(await cached.json(), publicStatus);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("never puts failures in the public edge cache", async () => {
  const originalFetch = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  const cache = {
    async match() { return undefined; },
    async put() { puts += 1; },
  };
  try {
    const response = await proxyPublicCycleStatus(
      new Request("https://hookemon.example/api/cycle-status"),
      {
        ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
        PUBLIC_DASHBOARD_PROFILE: "testnet",
        PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status",
        PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard",
      },
      cache,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(puts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isolates cache and in-flight loads by protected profile", async () => {
  const originalFetch = globalThis.fetch;
  const cache = memoryCache();
  let originCalls = 0;
  let releaseOrigin;
  const gate = new Promise((resolve) => { releaseOrigin = resolve; });
  const mainnetStatus = {
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
  };
  globalThis.fetch = async () => {
    originCalls += 1;
    const response = originCalls === 1 ? publicStatus : mainnetStatus;
    await gate;
    return Response.json(response);
  };
  const request = new Request("https://hookemon.example/api/cycle-status");
  const base = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status",
    PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard",
  };
  try {
    const testnet = proxyPublicCycleStatus(request, { ...base, PUBLIC_DASHBOARD_PROFILE: "testnet" }, cache);
    const mainnet = proxyPublicCycleStatus(request, { ...base, PUBLIC_DASHBOARD_PROFILE: "mainnet" }, cache);
    releaseOrigin();
    const [testnetResponse, mainnetResponse] = await Promise.all([testnet, mainnet]);
    assert.equal(originCalls, 2);
    assert.equal((await testnetResponse.json()).profile, "testnet");
    assert.equal((await mainnetResponse.json()).profile, "mainnet");

    await proxyPublicCycleStatus(request, { ...base, PUBLIC_DASHBOARD_PROFILE: "testnet" }, cache);
    await proxyPublicCycleStatus(request, { ...base, PUBLIC_DASHBOARD_PROFILE: "mainnet" }, cache);
    assert.equal(originCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
