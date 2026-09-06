import {
  normalizePublicCommunitySnapshot,
  type PublicCommunitySnapshot,
} from "../lib/public-community-snapshot.ts";
import type { DashboardProfileId } from "../lib/public-dashboard-profile.ts";
import {
  readPublicDashboardConfig,
  type PublicDashboardEnvironment,
} from "./public-dashboard-config.ts";
import { cancelResponseBody, readBoundedUtf8Body } from "./bounded-response-body.ts";

type PublicCommunityCache = Pick<Cache, "match" | "put">;

const MAX_PUBLIC_COMMUNITY_BYTES = 64_000;
const communityLoads = new Map<string, Promise<PublicCommunitySnapshot>>();

export async function proxyPublicCommunitySnapshot(
  request: Request,
  env: PublicDashboardEnvironment,
  cache?: PublicCommunityCache,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== "/api/community-dashboard") {
    return publicError("PUBLIC_COMMUNITY_ROUTE_NOT_FOUND", 404);
  }
  if (request.method !== "GET") {
    return publicError("PUBLIC_COMMUNITY_METHOD_NOT_ALLOWED", 405, { allow: "GET" });
  }
  if (requestUrl.search.length > 0) {
    return publicError("PUBLIC_COMMUNITY_QUERY_INVALID", 400);
  }

  let profile: DashboardProfileId;
  let upstreamUrl: URL;
  try {
    const config = readPublicDashboardConfig(env);
    profile = config.profile;
    upstreamUrl = config.communitySnapshotUrl;
  } catch {
    return publicError("PUBLIC_COMMUNITY_UNAVAILABLE", 503);
  }

  try {
    const cacheUrl = new URL("/api/community-dashboard", request.url);
    cacheUrl.searchParams.set("profile", profile);
    const cacheKey = new Request(cacheUrl, {
      method: "GET",
    });
    const cached = await readCachedSnapshot(cache, cacheKey, profile);
    if (cached) return publicSuccess(cached);
    const snapshot = await sharedSnapshotLoad(profile, upstreamUrl);
    const response = publicSuccess(snapshot);
    if (cache) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // A transient edge-cache failure must not hide a valid public snapshot.
      }
    }
    return response;
  } catch (error) {
    return error instanceof PublicCommunityUnavailableError
      ? publicError("PUBLIC_COMMUNITY_UNAVAILABLE", 503)
      : publicError("PUBLIC_COMMUNITY_INVALID", 502);
  }
}

async function readCachedSnapshot(
  cache: PublicCommunityCache | undefined,
  cacheKey: Request,
  profile: DashboardProfileId,
): Promise<PublicCommunitySnapshot | undefined> {
  if (!cache) return undefined;
  try {
    const cached = await cache.match(cacheKey);
    if (!cached) return undefined;
    if (!cached.ok || isOversized(cached.headers.get("content-length"))) {
      await cancelResponseBody(cached);
      return undefined;
    }
    const body = await readBoundedUtf8Body(cached, MAX_PUBLIC_COMMUNITY_BYTES);
    return normalizePublicCommunitySnapshot(JSON.parse(body) as unknown, profile);
  } catch {
    return undefined;
  }
}

function sharedSnapshotLoad(
  profile: DashboardProfileId,
  upstreamUrl: URL,
): Promise<PublicCommunitySnapshot> {
  const key = `${profile}:${upstreamUrl.toString()}`;
  const current = communityLoads.get(key);
  if (current) return current;
  const pending = fetchSnapshot(profile, upstreamUrl);
  communityLoads.set(key, pending);
  void pending.then(
    () => communityLoads.get(key) === pending && communityLoads.delete(key),
    () => communityLoads.get(key) === pending && communityLoads.delete(key),
  );
  return pending;
}

async function fetchSnapshot(
  profile: DashboardProfileId,
  upstreamUrl: URL,
): Promise<PublicCommunitySnapshot> {
  const upstream = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(3_500),
  });
  if (!upstream.ok || isOversized(upstream.headers.get("content-length"))) {
    await cancelResponseBody(upstream);
    throw new PublicCommunityUnavailableError();
  }
  const body = await readBoundedUtf8Body(upstream, MAX_PUBLIC_COMMUNITY_BYTES);
  return normalizePublicCommunitySnapshot(JSON.parse(body) as unknown, profile);
}

function isOversized(contentLength: string | null): boolean {
  if (contentLength === null) return false;
  return !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_PUBLIC_COMMUNITY_BYTES;
}

function publicSuccess(snapshot: PublicCommunitySnapshot): Response {
  return Response.json(snapshot, { headers: publicSuccessHeaders() });
}

function publicError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return Response.json({ code }, { status, headers: publicErrorHeaders(extraHeaders) });
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

class PublicCommunityUnavailableError extends Error {}
