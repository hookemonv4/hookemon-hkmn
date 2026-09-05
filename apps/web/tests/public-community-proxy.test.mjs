import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { proxyPublicCommunitySnapshot } from "../worker/public-community-proxy.ts";

function validEnv(overrides = {}) {
  return {
    PUBLIC_DASHBOARD_PROFILE: "testnet",
    PUBLIC_CYCLE_STATUS_URL: "https://operator.example/public/api/cycle-status",
    PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard",
    ...overrides,
  };
}

test("proxies one validated community snapshot without operator credentials", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ request: String(request), init });
    return Response.json(validSnapshot());
  };
  const cache = {
    async match() { return undefined; },
    async put() {},
  };
  try {
    const response = await proxyPublicCommunitySnapshot(
      new Request("https://hookemon.example/api/community-dashboard"),
      validEnv(),
      cache,
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request, "https://operator.example/public/api/community-dashboard");
    assert.deepEqual(calls[0].init.headers, { accept: "application/json" });
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal("authorization" in calls[0].init.headers, false);
    assert.equal(response.headers.get("cache-control"), "public, max-age=5, stale-while-revalidate=30");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), validSnapshot());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects requests outside the exact public community route", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json(validSnapshot());
  };
  try {
    const response = await proxyPublicCommunitySnapshot(
      new Request("https://hookemon.example/api/not-community-dashboard"),
      validEnv(),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { code: "PUBLIC_COMMUNITY_ROUTE_NOT_FOUND" });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed for invalid methods, queries, configuration, and upstream bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ ...validSnapshot(), privateKey: "hidden" });
    const cases = [
      [
        new Request("https://hookemon.example/api/community-dashboard", { method: "POST" }),
        validEnv(),
        405,
        "PUBLIC_COMMUNITY_METHOD_NOT_ALLOWED",
      ],
      [
        new Request("https://hookemon.example/api/community-dashboard?debug=1"),
        validEnv(),
        400,
        "PUBLIC_COMMUNITY_QUERY_INVALID",
      ],
      [
        new Request("https://hookemon.example/api/community-dashboard"),
        validEnv({ PUBLIC_DASHBOARD_PROFILE: undefined }),
        503,
        "PUBLIC_COMMUNITY_UNAVAILABLE",
      ],
      [
        new Request("https://hookemon.example/api/community-dashboard"),
        validEnv({ PUBLIC_COMMUNITY_SNAPSHOT_URL: "http://operator.example/status" }),
        503,
        "PUBLIC_COMMUNITY_UNAVAILABLE",
      ],
      [
        new Request("https://hookemon.example/api/community-dashboard"),
        validEnv(),
        502,
        "PUBLIC_COMMUNITY_INVALID",
      ],
    ];
    for (const [request, env, status, code] of cases) {
      const response = await proxyPublicCommunitySnapshot(request, env);
      assert.equal(response.status, status, code);
      assert.deepEqual(await response.json(), { code }, code);
      assert.equal(response.headers.get("cache-control"), "no-store", code);
    }

    globalThis.fetch = async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "64001" },
    });
    const oversized = await proxyPublicCommunitySnapshot(
      new Request("https://hookemon.example/api/community-dashboard"),
      validEnv(),
    );
    assert.equal(oversized.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid paired configuration before fetch and mismatched profiles after fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => (fetches += 1, Response.json(validSnapshot()));
  const request = new Request("https://hookemon.example/api/community-dashboard");
  try {
    for (const env of [
      validEnv({ PUBLIC_DASHBOARD_PROFILE: "production" }),
      validEnv({ PUBLIC_CYCLE_STATUS_URL: "https://operator.example/wrong" }),
      validEnv({ PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://other.example/public/api/community-dashboard" }),
      validEnv({ PUBLIC_COMMUNITY_SNAPSHOT_URL: "https://operator.example/public/api/community-dashboard?x=1" }),
    ]) {
      const response = await proxyPublicCommunitySnapshot(request, env);
      assert.equal(response.status, 503);
    }
    assert.equal(fetches, 0);

    const mismatched = validSnapshot();
    mismatched.profile = "mainnet";
    mismatched.badge = "MAINNET";
    mismatched.network = {
      ethereum: { name: "mainnet", chainId: 1, label: "Ethereum" },
      solana: {
        name: "mainnet-beta",
        genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        label: "Solana",
      },
    };
    globalThis.fetch = async () => (fetches += 1, Response.json(mismatched));
    const response = await proxyPublicCommunitySnapshot(request, validEnv());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code: "PUBLIC_COMMUNITY_INVALID" });
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker routes the exact public dashboard path through the community proxy", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ proxyPublicCommunitySnapshot \} from ["']\.\/public-community-proxy["']/);
  assert.match(source, /url\.pathname === ["']\/api\/community-dashboard["']/);
  assert.match(source, /proxyPublicCommunitySnapshot\(request, env, cache\)/);
});

test("caps chunked community bodies while accepting an exact byte-limit response", async () => {
  const originalFetch = globalThis.fetch;
  const maximumBytes = 64_000;
  try {
    let canceled = false;
    globalThis.fetch = async () => chunkedJsonResponse(validSnapshot(), maximumBytes + 1, {
      onCancel: () => { canceled = true; },
      keepOpen: true,
    });
    const oversized = await proxyPublicCommunitySnapshot(
      new Request("https://hookemon.example/api/community-dashboard"),
      validEnv(),
    );
    assert.equal(oversized.status, 502);
    assert.deepEqual(await oversized.json(), { code: "PUBLIC_COMMUNITY_INVALID" });
    assert.equal(canceled, true);

    globalThis.fetch = async () => chunkedJsonResponse(validSnapshot(), maximumBytes);
    const boundary = await proxyPublicCommunitySnapshot(
      new Request("https://hookemon.example/api/community-dashboard"),
      validEnv(),
    );
    assert.equal(boundary.status, 200);
    assert.deepEqual(await boundary.json(), validSnapshot());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancels community response bodies rejected from status or content-length headers", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const responseInit of [
      { status: 500 },
      { status: 200, contentLength: "invalid" },
      { status: 200, contentLength: "64001" },
      { status: 500, cancelError: new Error("private upstream cancel detail") },
    ]) {
      let canceled = false;
      globalThis.fetch = async () => cancelableHeaderResponse(responseInit, () => {
        canceled = true;
        if (responseInit.cancelError) throw responseInit.cancelError;
      });

      const response = await proxyPublicCommunitySnapshot(
        new Request("https://hookemon.example/api/community-dashboard"),
        validEnv(),
      );

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "PUBLIC_COMMUNITY_UNAVAILABLE" });
      assert.equal(canceled, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isolates community cache and in-flight loads by protected profile", async () => {
  const originalFetch = globalThis.fetch;
  const entries = new Map();
  const cache = {
    async match(request) { return entries.get(request.url)?.clone(); },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
  let originCalls = 0;
  let releaseOrigin;
  const gate = new Promise((resolve) => { releaseOrigin = resolve; });
  const mainnet = mainnetSnapshot();
  globalThis.fetch = async () => {
    originCalls += 1;
    const response = originCalls === 1 ? validSnapshot() : mainnet;
    await gate;
    return Response.json(response);
  };
  const request = new Request("https://hookemon.example/api/community-dashboard");
  try {
    const testnetLoad = proxyPublicCommunitySnapshot(request, validEnv(), cache);
    const mainnetLoad = proxyPublicCommunitySnapshot(
      request,
      validEnv({ PUBLIC_DASHBOARD_PROFILE: "mainnet" }),
      cache,
    );
    releaseOrigin();
    const [testnetResponse, mainnetResponse] = await Promise.all([testnetLoad, mainnetLoad]);
    assert.equal(originCalls, 2);
    assert.equal((await testnetResponse.json()).profile, "testnet");
    assert.equal((await mainnetResponse.json()).profile, "mainnet");

    await proxyPublicCommunitySnapshot(request, validEnv(), cache);
    await proxyPublicCommunitySnapshot(
      request,
      validEnv({ PUBLIC_DASHBOARD_PROFILE: "mainnet" }),
      cache,
    );
    assert.equal(originCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function validSnapshot() {
  return {
    schemaVersion: 4,
    profile: "testnet",
    badge: "TESTNET",
    network: {
      ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
      solana: {
        name: "devnet",
        genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        label: "Solana Devnet",
      },
    },
    historyComplete: true,
    generatedAt: "2026-08-19T11:00:00.000Z",
    nextCycleAt: "2026-08-19T11:20:00.000Z",
    delayed: false,
    poolObservedAt: "2026-08-19T10:59:00.000Z",
    metrics: {
      latestObservedProjectPoolMicroUsdc: "1000000",
      totalCycleFundingMicroUsdc: "900000",
      totalCollectorSpendMicroUsdc: "500000",
      totalBuybacksReturnedMicroUsdc: "300000",
      totalBridgedBackMicroUsdc: "300000",
      totalRewardsPaidMicroUsdc: "250000",
      totalRewardsDeferredMicroUsdc: "0",
      totalQuotedOperatingCostsMicroUsdc: "10000",
      latestRetainedReserveMicroUsdc: "40000",
      latestCycleReserveTargetMicroUsdc: "50000",
      completedCycles: 3,
      skippedCycles: 1,
      openedPacks: 4,
    },
    latestCycle: {
      cycleId: "cycle-3",
      status: "complete",
      reason: null,
      updatedAt: "2026-08-19T11:00:00.000Z",
      paidMicroUsdc: "250000",
      payoutRecipientCount: 2,
      roundAccounting: {
        packSpendMicroUsdc: "500000",
        buybackMicroUsdc: "300000",
        packGainMicroUsdc: "0",
        packLossMicroUsdc: "200000",
        quotedCosts: {
          outboundBridgeMicroUsdc: null,
          inboundBridgeMicroUsdc: null,
          collectorApiMicroUsdc: null,
          ethereumNetworkMicroUsdc: null,
          solanaNetworkMicroUsdc: null,
          slippageMicroUsdc: null,
        },
        protectedCostsMicroUsdc: "100000",
        confirmedCostsMicroUsdc: null,
        cycleGainMicroUsdc: null,
        cycleLossMicroUsdc: null,
        walletBalanceBeforeMicroUsdc: null,
        walletBalanceAfterMicroUsdc: null,
        networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
        feeReserveBeforeMicroUsdc: "40000",
        feeReserveTargetMicroUsdc: "50000",
        feeReserveTopUpMicroUsdc: "10000",
        feeReserveAfterMicroUsdc: "50000",
        plannedHolderRewardsMicroUsdc: "250000",
        paidHolderRewardsMicroUsdc: "250000",
        holderRewardsStatus: "computed",
        distributionStatus: "reconciled",
      },
      transactions: [{
        chain: "ethereum",
        purpose: "reward-settlement",
        id: `0x${"ab".repeat(32)}`,
      }],
    },
    cards: [],
  };
}

function mainnetSnapshot() {
  return {
    ...validSnapshot(),
    profile: "mainnet",
    badge: "MAINNET",
    network: {
      ethereum: { name: "mainnet", chainId: 1, label: "Ethereum" },
      solana: {
        name: "mainnet-beta",
        genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        label: "Solana",
      },
    },
  };
}

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
