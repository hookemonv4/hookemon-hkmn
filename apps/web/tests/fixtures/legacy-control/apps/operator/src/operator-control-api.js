import { randomUUID } from "node:crypto";

import { readPublicDashboardProfile } from "../../../packages/domain/src/public-dashboard-profile.js";
import { verifyProxyCredential } from "./operator-access-auth.js";
import { cardHistoryOptions } from "./operator-card-history.js";
import { operatorReadiness } from "./operator-control-policy.js";
import { projectPublicCommunitySnapshot } from "./public-community-snapshot.js";

const MAX_BODY_BYTES = 32_768;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_ERROR_CODES = new Set([
  "ACCESS_ASSERTION_REQUIRED",
  "ACCESS_ASSERTION_INVALID",
  "ACCESS_IDENTITY_INVALID",
]);

export function createPublicCommunitySnapshotHandler({
  dashboardStore,
  profile,
  now = Date.now,
  requestId = randomUUID,
} = {}) {
  if (
    typeof dashboardStore?.readDashboard !== "function" ||
    typeof now !== "function" ||
    typeof requestId !== "function"
  ) {
    throw new TypeError("PUBLIC_COMMUNITY_API_INVALID");
  }
  let selectedProfile;
  try {
    selectedProfile = readPublicDashboardProfile(profile).id;
  } catch {
    throw new TypeError("PUBLIC_COMMUNITY_API_INVALID");
  }

  return async function handlePublicCommunitySnapshot(request) {
    const responseRequestId = requestId();
    try {
      if (!(request instanceof Request)) {
        return json(400, { code: "PUBLIC_COMMUNITY_REQUEST_INVALID" }, responseRequestId);
      }
      const url = new URL(request.url);
      if (url.pathname !== "/public/api/community-dashboard") {
        return json(404, { code: "PUBLIC_COMMUNITY_ROUTE_NOT_FOUND" }, responseRequestId);
      }
      if (request.method !== "GET") {
        const response = json(
          405,
          { code: "PUBLIC_COMMUNITY_METHOD_NOT_ALLOWED" },
          responseRequestId,
        );
        response.headers.set("allow", "GET");
        return response;
      }
      if (url.search.length > 0) {
        return json(400, { code: "PUBLIC_COMMUNITY_QUERY_INVALID" }, responseRequestId);
      }
      return json(
        200,
        projectPublicCommunitySnapshot(await dashboardStore.readDashboard(), {
          nowMs: now(),
          profile: selectedProfile,
        }),
        responseRequestId,
      );
    } catch (error) {
      if (persistenceUnavailable(error)) {
        return json(503, { code: "PUBLIC_COMMUNITY_UNAVAILABLE" }, responseRequestId);
      }
      return json(500, { code: "PUBLIC_COMMUNITY_INTERNAL_ERROR" }, responseRequestId);
    }
  };
}

export function createOperatorControlHandler({
  proxyCredential,
  ...dependencies
} = {}) {
  if (typeof proxyCredential !== "string") {
    throw new TypeError("OPERATOR_CONTROL_API_INVALID");
  }

  return createOperatorControlRouteHandler(dependencies, { proxyCredential });
}

export function createBindingOperatorControlHandler(dependencies = {}) {
  return createOperatorControlRouteHandler(dependencies);
}

function createOperatorControlRouteHandler({
  allowedOrigin,
  hardCaps,
  authenticator,
  store,
  catalogService,
  dashboardStore,
  now = Date.now,
  requestId = randomUUID,
} = {}, { proxyCredential } = {}) {
  if (
    typeof allowedOrigin !== "string" ||
    !plainObject(hardCaps) ||
    typeof authenticator?.authenticate !== "function" ||
    typeof store?.readState !== "function" ||
    typeof store?.listDecisions !== "function" ||
    typeof store?.submitDecision !== "function" ||
    typeof catalogService?.read !== "function" ||
    (dashboardStore !== undefined && typeof dashboardStore?.readDashboard !== "function") ||
    typeof now !== "function" ||
    typeof requestId !== "function"
  ) {
    throw new TypeError("OPERATOR_CONTROL_API_INVALID");
  }

  return async function handleOperatorControlRequest(request) {
    const responseRequestId = requestId();
    if (!(request instanceof Request)) {
      return json(400, { code: "OPERATOR_REQUEST_INVALID" }, responseRequestId);
    }
    if (
      proxyCredential !== undefined &&
      !verifyProxyCredential({
        presented: request.headers.get("x-hookemon-proxy-credential"),
        expected: proxyCredential,
      })
    ) {
      return json(401, { code: "PROXY_CREDENTIAL_INVALID" }, responseRequestId);
    }

    let identity;
    try {
      identity = await authenticator.authenticate(
        request.headers.get("cf-access-jwt-assertion") ?? undefined,
      );
    } catch (error) {
      const code = AUTH_ERROR_CODES.has(error?.message)
        ? error.message
        : "ACCESS_ASSERTION_INVALID";
      return json(401, { code }, responseRequestId);
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === "/operator/api/bootstrap") {
        if (request.method !== "GET") {
          return json(405, { code: "OPERATOR_METHOD_NOT_ALLOWED" }, responseRequestId);
        }
        if (url.search.length > 0) {
          return json(400, { code: "OPERATOR_QUERY_INVALID" }, responseRequestId);
        }
        return await bootstrapResponse({
          identity,
          store,
          catalogService,
          hardCaps,
          now,
          responseRequestId,
        });
      }

      if (url.pathname === "/operator/api/audit") {
        if (request.method !== "GET") {
          return json(405, { code: "OPERATOR_METHOD_NOT_ALLOWED" }, responseRequestId);
        }
        const options = auditOptions(url.searchParams);
        const decisions = await store.listDecisions(options);
        return json(
          200,
          {
            decisions,
            nextCursor: decisions.length === 0 ? null : decisions.at(-1).sequence,
          },
          responseRequestId,
        );
      }

      if (url.pathname === "/operator/api/dashboard") {
        if (request.method !== "GET") {
          return json(405, { code: "OPERATOR_METHOD_NOT_ALLOWED" }, responseRequestId);
        }
        if (url.search.length > 0) {
          return json(400, { code: "OPERATOR_QUERY_INVALID" }, responseRequestId);
        }
        if (!dashboardStore) {
          return json(503, { code: "OPERATOR_DASHBOARD_UNAVAILABLE" }, responseRequestId);
        }
        return json(200, await dashboardStore.readDashboard(), responseRequestId);
      }

      if (url.pathname === "/operator/api/cards") {
        if (request.method !== "GET") {
          return json(405, { code: "OPERATOR_METHOD_NOT_ALLOWED" }, responseRequestId);
        }
        if (typeof dashboardStore?.listCards !== "function") {
          return json(503, { code: "OPERATOR_DASHBOARD_UNAVAILABLE" }, responseRequestId);
        }
        return json(
          200,
          await dashboardStore.listCards(cardHistoryOptions(url.searchParams)),
          responseRequestId,
        );
      }

      if (url.pathname === "/operator/api/decisions") {
        if (request.method !== "POST") {
          return json(405, { code: "OPERATOR_METHOD_NOT_ALLOWED" }, responseRequestId);
        }
        const boundaryError = mutationBoundaryError(request, allowedOrigin);
        if (boundaryError) return json(boundaryError.status, { code: boundaryError.code }, responseRequestId);
        const parsed = await decisionBody(request);
        if (parsed.error) return json(parsed.error.status, { code: parsed.error.code }, responseRequestId);
        const catalog =
          identity.role === "operator" && parsed.value.command.type !== "pause"
            ? await catalogService.read()
            : null;
        const result = await store.submitDecision({
          actor: {
            issuer: identity.issuer,
            subject: identity.subject,
            email: identity.email,
          },
          role: identity.role,
          requestId: parsed.value.requestId,
          expectedVersion: parsed.value.expectedVersion,
          command: parsed.value.command,
          note: parsed.value.note ?? null,
          hardCaps,
          catalog,
          nowMs: now(),
        });
        const code = result.event.resultCode;
        const status = decisionStatus(code, result.event.outcome);
        return json(
          status,
          {
            code,
            eventId: result.event.eventId,
            state: result.state,
            replayed: result.replayed,
          },
          responseRequestId,
        );
      }

      return json(404, { code: "OPERATOR_ROUTE_NOT_FOUND" }, responseRequestId);
    } catch (error) {
      if (persistenceUnavailable(error)) {
        return json(503, { code: "OPERATOR_PERSISTENCE_UNAVAILABLE" }, responseRequestId);
      }
      if (error?.message === "OPERATOR_QUERY_INVALID") {
        return json(400, { code: "OPERATOR_QUERY_INVALID" }, responseRequestId);
      }
      return json(500, { code: "OPERATOR_INTERNAL_ERROR" }, responseRequestId);
    }
  };
}

async function bootstrapResponse({
  identity,
  store,
  catalogService,
  hardCaps,
  now,
  responseRequestId,
}) {
  const [state, catalog] = await Promise.all([store.readState(), catalogService.read()]);
  const readiness = operatorReadiness({ state, catalog, nowMs: now() });
  return json(
    200,
    {
      identity: {
        subject: identity.subject,
        email: identity.email,
        role: identity.role,
      },
      state,
      hardCaps: Object.fromEntries(
        Object.entries(hardCaps).map(([key, value]) => [key, value.toString()]),
      ),
      catalog,
      readiness,
      executionConnected: state.executionConnected === true,
    },
    responseRequestId,
  );
}

function auditOptions(searchParams) {
  const keys = [...searchParams.keys()];
  if (keys.some((key) => !new Set(["cursor", "limit"]).has(key)) || new Set(keys).size !== keys.length) {
    throw new Error("OPERATOR_QUERY_INVALID");
  }
  const cursor = searchParams.get("cursor");
  const limitText = searchParams.get("limit");
  if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) {
    throw new Error("OPERATOR_QUERY_INVALID");
  }
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("OPERATOR_QUERY_INVALID");
  }
  return { beforeSequence: cursor, limit };
}

function mutationBoundaryError(request, allowedOrigin) {
  if (request.headers.get("origin") !== allowedOrigin) {
    return { status: 403, code: "OPERATOR_ORIGIN_INVALID" };
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return { status: 403, code: "OPERATOR_FETCH_SITE_INVALID" };
  }
  if (request.headers.get("x-hookemon-request") !== "operator-control") {
    return { status: 403, code: "OPERATOR_REQUEST_MARKER_INVALID" };
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { status: 415, code: "OPERATOR_CONTENT_TYPE_INVALID" };
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { status: 413, code: "OPERATOR_BODY_TOO_LARGE" };
  }
  return null;
}

async function decisionBody(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return { error: { status: 413, code: "OPERATOR_BODY_TOO_LARGE" } };
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { error: { status: 400, code: "OPERATOR_BODY_INVALID" } };
  }
  if (!plainObject(value)) return { error: { status: 400, code: "OPERATOR_BODY_INVALID" } };
  const keys = Object.keys(value).sort();
  const expected = ("note" in value
    ? ["command", "expectedVersion", "note", "requestId"]
    : ["command", "expectedVersion", "requestId"]
  ).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { error: { status: 400, code: "OPERATOR_BODY_INVALID" } };
  }
  if (
    typeof value.requestId !== "string" ||
    !UUID_PATTERN.test(value.requestId) ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    !plainObject(value.command)
  ) {
    return { error: { status: 400, code: "OPERATOR_BODY_INVALID" } };
  }
  if ("note" in value && (typeof value.note !== "string" || value.note.length > 500)) {
    return { error: { status: 400, code: "OPERATOR_NOTE_INVALID" } };
  }
  return { value };
}

function decisionStatus(code, outcome) {
  if (outcome === "accepted") return 200;
  if (code === "OPERATOR_ROLE_REQUIRED") return 403;
  if (code === "OPERATOR_STATE_VERSION_CONFLICT") return 409;
  return 400;
}

function persistenceUnavailable(error) {
  return (
    typeof error?.message === "string" &&
    new Set([
      "OPERATOR_CONTROL_CONNECTION_FAILED",
      "OPERATOR_CONTROL_DECISION_FAILED",
      "OPERATOR_CONTROL_STATE_READ_FAILED",
      "OPERATOR_CONTROL_DECISIONS_READ_FAILED",
      "OPERATOR_CATALOG_READ_FAILED",
      "OPERATOR_CATALOG_SAVE_FAILED",
      "OPERATOR_DASHBOARD_READ_FAILED",
    ]).has(error.message)
  );
}

function json(status, body, requestId) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-hookemon-request-id": requestId,
    },
  });
}

function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
