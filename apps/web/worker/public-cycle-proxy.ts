import {
  normalizePublicCycleStatus,
  type PublicCycleStatus,
} from "../lib/public-cycle-status.ts";
import {
  readPublicDashboardConfig,
  type PublicDashboardEnvironment,
} from "./public-dashboard-config.ts";
import type { DashboardProfileId } from "../lib/public-dashboard-profile.ts";
import { cancelResponseBody, readBoundedUtf8Body } from "./bounded-response-body.ts";

const MAX_PUBLIC_STATUS_BYTES = 1_000_000;
const publicStatusLoads = new Map<string, Promise<PublicCycleStatus>>();

type PublicStatusCache = Pick<Cache, "match" | "put">;

export async function proxyPublicCycleStatus(
  request: Request,
  env: PublicDashboardEnvironment,
  cache?: PublicStatusCache,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (request.method !== "GET") {
    return publicError("PUBLIC_CYCLE_STATUS_METHOD_NOT_ALLOWED", 405, { allow: "GET" });
  }
  if (requestUrl.search.length > 0) {
    return publicError("PUBLIC_CYCLE_STATUS_QUERY_INVALID", 400);
  }

  let profile: DashboardProfileId;
  let upstreamUrl: URL;
  try {
    const config = readPublicDashboardConfig(env);
    profile = config.profile;
    upstreamUrl = config.cycleStatusUrl;
  } catch {
    return publicError("PUBLIC_CYCLE_STATUS_UNAVAILABLE", 503);
  }

  try {
    const cacheUrl = new URL("/api/cycle-status", request.url);
    cacheUrl.searchParams.set("profile", profile);
    const cacheKey = new Request(cacheUrl, { method: "GET" });
    const cached = await readCachedStatus(cache, cacheKey, profile);
    if (cached) return publicSuccess(cached);

    const status = await sharedPublicStatusLoad(profile, upstreamUrl);
    const response = publicSuccess(status);
    if (cache) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // A transient edge-cache failure must not hide a valid public status.
      }
    }
    return response;
  } catch (error) {
    return error instanceof PublicStatusUnavailableError
      ? publicError("PUBLIC_CYCLE_STATUS_UNAVAILABLE", 503)
      : publicError("PUBLIC_CYCLE_STATUS_INVALID", 502);
  }
}

async function readCachedStatus(
  cache: PublicStatusCache | undefined,
  cacheKey: Request,
  profile: DashboardProfileId,
): Promise<PublicCycleStatus | undefined> {
  if (!cache) return undefined;
  try {
    const cached = await cache.match(cacheKey);
    if (!cached) return undefined;
    if (!cached.ok || isOversized(cached.headers.get("content-length"))) {
      await cancelResponseBody(cached);
      return undefined;
    }
    const body = await readBoundedUtf8Body(cached, MAX_PUBLIC_STATUS_BYTES);
    return normalizePublicCycleStatus(JSON.parse(body) as unknown, profile);
  } catch {
    return undefined;
  }
}

function sharedPublicStatusLoad(
  profile: DashboardProfileId,
  upstreamUrl: URL,
): Promise<PublicCycleStatus> {
  const key = `${profile}:${upstreamUrl.toString()}`;
  const current = publicStatusLoads.get(key);
  if (current) return current;
  const pending = fetchPublicStatus(profile, upstreamUrl);
  publicStatusLoads.set(key, pending);
  void pending.then(
    () => publicStatusLoads.get(key) === pending && publicStatusLoads.delete(key),
    () => publicStatusLoads.get(key) === pending && publicStatusLoads.delete(key),
  );
  return pending;
}

async function fetchPublicStatus(
  profile: DashboardProfileId,
  upstreamUrl: URL,
): Promise<PublicCycleStatus> {
  const upstream = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(3_500),
  });
  if (!upstream.ok || isOversized(upstream.headers.get("content-length"))) {
    await cancelResponseBody(upstream);
    throw new PublicStatusUnavailableError();
  }
  const body = await readBoundedUtf8Body(upstream, MAX_PUBLIC_STATUS_BYTES);
  return normalizePublicCycleStatus(JSON.parse(body) as unknown, profile);
}

function isOversized(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  return !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PUBLIC_STATUS_BYTES;
}

function publicError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return Response.json(
    { code },
    { status, headers: publicErrorHeaders(extraHeaders) },
  );
}

function publicSuccess(status: PublicCycleStatus): Response {
  return Response.json(status, { headers: publicSuccessHeaders() });
}

function publicSuccessHeaders(): Headers {
  const headers = publicBaseHeaders();
  headers.set("cache-control", "public, max-age=5, stale-while-revalidate=30");
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

class PublicStatusUnavailableError extends Error {}
