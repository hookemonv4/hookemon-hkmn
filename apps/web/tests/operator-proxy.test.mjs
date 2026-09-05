import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const ACCESS_ASSERTION = "signed-access-token";
const PROXY_CREDENTIAL = "server-only-proxy-credential-123456789";
const SERVICE_URL = "https://operator.internal.example";
const REQUIRED_WORKER_SECRETS = [
  "OPERATOR_CONTROL_SERVICE_URL",
  "OPERATOR_CONTROL_PROXY_CREDENTIAL",
  "PUBLIC_DASHBOARD_PROFILE",
  "PUBLIC_CYCLE_STATUS_URL",
  "PUBLIC_COMMUNITY_SNAPSHOT_URL",
];
const FORBIDDEN_EXECUTION_IMPORT = /\b(?:from\s*|import\s*\()\s*["'][^"']*(?:collector-executor|transaction|signer|scheduler|wallet|mainnet|rpc)[^"']*["']/i;

async function builtWorkerModule() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `operator-${process.pid}-${Date.now()}-${Math.random()}`);
  return import(workerUrl.href);
}

function operatorEnv(overrides = {}) {
  return {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    OPERATOR_CONTROL_SERVICE_URL: SERVICE_URL,
    OPERATOR_CONTROL_PROXY_CREDENTIAL: PROXY_CREDENTIAL,
    ...overrides,
  };
}

function executionContext() {
  return { waitUntil() {}, passThroughOnException() {} };
}

function operatorRequest(path, init = {}) {
  return new Request(new URL(path, "https://hookemon.example"), {
    ...init,
    headers: {
      "cf-access-jwt-assertion": ACCESS_ASSERTION,
      ...(init.headers ?? {}),
    },
  });
}

async function withFetch(handler, action) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

test("routes only approved operator requests to the isolated HTTPS control service", async () => {
  const { default: worker } = await builtWorkerModule();
  const forwarded = [];
  const cases = [
    ["/operator/api/bootstrap", "GET"],
    ["/operator/api/dashboard", "GET"],
    ["/operator/api/cards?limit=25&sort=recent&productId=pokemon_25", "GET"],
    ["/operator/api/audit?cursor=9&limit=2", "GET"],
    ["/operator/api/decisions", "POST"],
  ];

  await withFetch(
    async (request) => (forwarded.push(request), Response.json({ ok: true })),
    async () => {
      for (const [path, method] of cases) {
        const response = await worker.fetch(
          operatorRequest(path, {
            method,
            headers: method === "POST" ? { "content-type": "application/json" } : undefined,
            body: method === "POST" ? "{}" : undefined,
          }),
          operatorEnv(),
          executionContext(),
        );
        assert.equal(response.status, 200, `${method} ${path}`);
      }
    },
  );

  assert.deepEqual(
    forwarded.map((request) => request.url),
    cases.map(([path]) => new URL(path, SERVICE_URL).toString()),
  );
});

test("forwards only approved headers, the bounded body and the server credential", async () => {
  const { default: worker } = await builtWorkerModule();
  const forwarded = [];
  const body = JSON.stringify({ requestId: "client-request" });
  const original = operatorRequest("/operator/api/decisions", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: "Bearer browser-secret",
      cookie: "private-cookie=secret",
      "cf-access-client-id": "service-id",
      "cf-access-client-secret": "service-secret",
      "content-type": "application/json",
      origin: "https://hookemon.example",
      "sec-fetch-site": "same-origin",
      "x-hookemon-request": "operator-control",
      "x-hookemon-request-id": "client-id",
      "x-hookemon-proxy-credential": "attacker-value",
      "x-untrusted-client-header": "strip-me",
    },
    body,
  });

  await withFetch(
    async (request) => (forwarded.push(request), Response.json({ ok: true })),
    async () => {
      const response = await worker.fetch(original, operatorEnv(), executionContext());
      assert.equal(response.status, 200);
    },
  );

  assert.equal(forwarded.length, 1);
  const request = forwarded[0];
  assert.equal(request.url, `${SERVICE_URL}/operator/api/decisions`);
  assert.equal(request.redirect, "manual");
  assert.equal(await request.text(), body);
  assert.equal(request.headers.get("cf-access-jwt-assertion"), ACCESS_ASSERTION);
  assert.equal(request.headers.get("x-hookemon-proxy-credential"), PROXY_CREDENTIAL);
  assert.equal(request.headers.get("origin"), "https://hookemon.example");
  assert.equal(request.headers.get("x-hookemon-request"), "operator-control");
  for (const name of [
    "authorization",
    "cookie",
    "cf-access-client-id",
    "cf-access-client-secret",
    "content-length",
    "x-untrusted-client-header",
  ]) {
    assert.equal(request.headers.has(name), false, name);
  }
});

test("rejects unauthenticated, malformed and excessive requests before external fetch", async () => {
  const { default: worker } = await builtWorkerModule();
  let fetches = 0;
  const cases = [
    [new Request("https://hookemon.example/operator"), 401, "ACCESS_ASSERTION_REQUIRED"],
    [new Request("https://hookemon.example/operator/api/bootstrap"), 401, "ACCESS_ASSERTION_REQUIRED"],
    [operatorRequest("/operator/api/missing"), 404, "OPERATOR_ROUTE_NOT_FOUND"],
    [operatorRequest("/operator/api/bootstrap?debug=1"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/dashboard?debug=1"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/cards?unknown=true"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/cards?limit=1&limit=2"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/cards?limit=51"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/cards?sort=popular"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/cards?minBuybackMicroUsdc=1.5"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/cards?from=2026-08-25"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest(`/operator/api/cards?cursor=${"x".repeat(513)}`), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/audit?cursor=0"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/audit?limit=101"), 400, "OPERATOR_QUERY_INVALID"],
    [operatorRequest("/operator/api/bootstrap", { method: "POST" }), 405, "OPERATOR_METHOD_NOT_ALLOWED"],
    [operatorRequest("/operator/api/dashboard", { method: "POST" }), 405, "OPERATOR_METHOD_NOT_ALLOWED"],
    [operatorRequest("/operator/api/cards", { method: "POST" }), 405, "OPERATOR_METHOD_NOT_ALLOWED"],
    [operatorRequest("/operator/api/decisions", { method: "GET" }), 405, "OPERATOR_METHOD_NOT_ALLOWED"],
    [operatorRequest("/operator/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "32769" },
      body: "{}",
    }), 413, "OPERATOR_BODY_TOO_LARGE"],
  ];

  await withFetch(async () => (fetches += 1, Response.json({ ok: true })), async () => {
    for (const [request, status, code] of cases) {
      const response = await worker.fetch(request, operatorEnv(), executionContext());
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { code });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
    }
  });
  assert.equal(fetches, 0);
});

test("sanitizes service responses and rejects redirects or unavailable configuration", async () => {
  const { default: worker } = await builtWorkerModule();
  const sanitized = await withFetch(
    async () => Response.json(
      { ok: true },
      { headers: {
        "cache-control": "public, max-age=86400",
        location: "https://private.example/secret",
        "set-cookie": "private=secret",
        "x-hookemon-request-id": "service-id",
        "x-private-detail": "strip-me",
      } },
    ),
    () => worker.fetch(operatorRequest("/operator/api/bootstrap"), operatorEnv(), executionContext()),
  );
  assert.equal(sanitized.status, 200);
  assert.equal(sanitized.headers.get("cache-control"), "no-store");
  assert.equal(sanitized.headers.get("x-content-type-options"), "nosniff");
  assert.equal(sanitized.headers.get("x-hookemon-request-id"), "service-id");
  assert.equal(sanitized.headers.has("location"), false);
  assert.equal(sanitized.headers.has("set-cookie"), false);
  assert.equal(sanitized.headers.has("x-private-detail"), false);

  const redirect = await withFetch(
    async () => new Response(null, { status: 302, headers: { location: "https://private.example" } }),
    () => worker.fetch(operatorRequest("/operator/api/bootstrap"), operatorEnv(), executionContext()),
  );
  assert.equal(redirect.status, 502);
  assert.deepEqual(await redirect.json(), { code: "OPERATOR_CONTROL_INVALID" });

  for (const env of [
    operatorEnv({ OPERATOR_CONTROL_SERVICE_URL: "http://operator.internal.example" }),
    operatorEnv({ OPERATOR_CONTROL_PROXY_CREDENTIAL: "too-short" }),
  ]) {
    let called = false;
    const response = await withFetch(
      async () => (called = true, Response.json({ ok: true })),
      () => worker.fetch(operatorRequest("/operator/api/bootstrap"), env, executionContext()),
    );
    assert.equal(response.status, 503);
    assert.equal(called, false);
  }

  const unavailable = await withFetch(
    async () => { throw new Error("private network detail"); },
    () => worker.fetch(operatorRequest("/operator/api/bootstrap"), operatorEnv(), executionContext()),
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { code: "OPERATOR_CONTROL_UNAVAILABLE" });
});

test("build contains only secret names and no control credential or execution capability", async () => {
  const workerModule = await builtWorkerModule();
  assert.equal(workerModule.OperatorControlDurableObject, undefined);

  const roots = [new URL("../dist/server/", import.meta.url), new URL("../dist/client/", import.meta.url)];
  for (const root of roots) {
    const files = await readdir(root, { recursive: true });
    for (const relativePath of files.filter((file) => /\.(?:js|css|html|json)$/.test(file))) {
      const source = await readFile(new URL(relativePath, root), "utf8");
      assert.equal(source.includes(PROXY_CREDENTIAL), false, `${relativePath}: credential`);
      assert.equal(FORBIDDEN_EXECUTION_IMPORT.test(source), false, `${relativePath}: execution import`);
    }
  }

  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.secrets, { required: REQUIRED_WORKER_SECRETS });
  assert.deepEqual(config.durable_objects?.bindings ?? [], []);
  assert.deepEqual(config.routes, [{ pattern: "hookemon.com", custom_domain: true }]);
  assert.deepEqual(config.migrations, [
    {
      tag: "v1",
      new_sqlite_classes: ["OperatorControlDurableObject"],
    },
    {
      tag: "v2",
      deleted_classes: ["OperatorControlDurableObject"],
    },
  ]);

  const [proxySource, indexSource, cycleProxySource, communityProxySource, generatedTypes] = await Promise.all([
    readFile(new URL("../worker/operator-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/public-cycle-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/public-community-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker-configuration.d.ts", import.meta.url), "utf8"),
  ]);
  assert.match(proxySource, /OPERATOR_CONTROL_SERVICE_URL/);
  assert.match(proxySource, /OPERATOR_CONTROL_PROXY_CREDENTIAL/);
  assert.doesNotMatch(indexSource, /OperatorControlDurableObject/);
  assert.doesNotMatch(generatedTypes, /OPERATOR_CONTROL: DurableObjectNamespace</);
  for (const source of [indexSource, cycleProxySource, communityProxySource]) {
    assert.doesNotMatch(
      source,
      /(?:ethereumRpc|solanaRpc|privateKey|signTransaction|sendTransaction|walletClient)/i,
    );
  }
  for (const name of REQUIRED_WORKER_SECRETS) {
    assert.match(generatedTypes, new RegExp(`\\b${name}: string;`), name);
  }
});
