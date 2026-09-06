import {
  normalizePublicCycleHistory,
  MAX_HISTORY_PAGE_SIZE,
  type PublicCycleHistory,
} from "../lib/public-cycle-history.ts";
import {
  readPublicDashboardConfig,
  type PublicDashboardEnvironment,
} from "./public-dashboard-config.ts";
import type { DashboardProfileId } from "../lib/public-dashboard-profile.ts";
import { cancelResponseBody, readBoundedUtf8Body } from "./bounded-response-body.ts";

const MAX_PUBLIC_HISTORY_BYTES = 64_000;
const HISTORY_QUERY_KEYS = new Set(["limit", "cursor"]);
const LIMIT_PATTERN = /^[1-9][0-9]*$/;

export async function proxyPublicCycleHistory(
  request: Request,
  env: PublicDashboardEnvironment,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (request.method !== "GET") {
    return publicError("PUBLIC_CYCLE_HISTORY_METHOD_NOT_ALLOWED", 405, { allow: "GET" });
  }
  const query = readHistoryQuery(requestUrl.searchParams);
  if (query === null) return publicError("PUBLIC_CYCLE_HISTORY_QUERY_INVALID", 400);

  let profile: DashboardProfileId;
  let upstreamUrl: URL;
  try {
    const config = readPublicDashboardConfig(env);
    profile = config.profile;
    upstreamUrl = config.cycleHistoryUrl;
  } catch {
    return publicError("PUBLIC_CYCLE_HISTORY_UNAVAILABLE", 503);
  }

  try {
    const history = await fetchPublicCycleHistory(profile, upstreamUrl, query);
    return publicSuccess(history);
  } catch (error) {
    return error instanceof PublicHistoryUnavailableError
      ? publicError("PUBLIC_CYCLE_HISTORY_UNAVAILABLE", 503)
      : publicError("PUBLIC_CYCLE_HISTORY_INVALID", 502);
  }
}

function readHistoryQuery(
  params: URLSearchParams,
): { limit: string | null; cursor: string | null } | null {
  for (const key of params.keys()) {
    if (!HISTORY_QUERY_KEYS.has(key)) return null;
  }
  const limit = params.get("limit");
  if (limit !== null && (!LIMIT_PATTERN.test(limit) || Number(limit) > MAX_HISTORY_PAGE_SIZE)) {
    return null;
  }
  const cursor = params.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 512)) return null;
  return { limit, cursor };
}

async function fetchPublicCycleHistory(
  profile: DashboardProfileId,
  upstreamUrl: URL,
  query: { limit: string | null; cursor: string | null },
): Promise<PublicCycleHistory> {
  const target = new URL(upstreamUrl.toString());
  if (query.limit !== null) target.searchParams.set("limit", query.limit);
  if (query.cursor !== null) target.searchParams.set("cursor", query.cursor);

  const upstream = await fetch(target.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(3_500),
  });
  if (!upstream.ok || isOversized(upstream.headers.get("content-length"))) {
    await cancelResponseBody(upstream);
    throw new PublicHistoryUnavailableError();
  }
  const body = await readBoundedUtf8Body(upstream, MAX_PUBLIC_HISTORY_BYTES);
  return normalizePublicCycleHistory(JSON.parse(body) as unknown, profile);
}

function isOversized(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  return !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PUBLIC_HISTORY_BYTES;
}

function publicSuccess(history: PublicCycleHistory): Response {
  return Response.json(history, { headers: publicSuccessHeaders() });
}

function publicError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return Response.json({ code }, { status, headers: publicErrorHeaders(extraHeaders) });
}

function publicSuccessHeaders(): Headers {
  const headers = publicBaseHeaders();
  headers.set("cache-control", "public, max-age=30, stale-while-revalidate=60");
  return headers;
}

function publicErrorHeaders(extra?: HeadersInit): Headers {
  const headers = publicBaseHeaders(extra);
  headers.set("cache-control", "no-store");
  return headers;
}

function publicBaseHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

class PublicHistoryUnavailableError extends Error {}
