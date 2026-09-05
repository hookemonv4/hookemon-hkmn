/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { FALLBACK_COLLECTOR_CARDS, normalizeCollectorCards } from "../lib/collector-cards";
import {
  operatorAccessRequiredResponse,
  operatorPageAuthorized,
  proxyOperatorRequest,
} from "./operator-proxy";
import { proxyPublicCommunitySnapshot } from "./public-community-proxy";
import { proxyPublicCycleStatus } from "./public-cycle-proxy";
import { publicPageResponse } from "./public-page-routes";
import { handlePackCatalog } from "./pack-catalog";

interface WorkerEnv extends Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PUBLIC_DASHBOARD_PROFILE: string;
  DB?: unknown;
  COLLECTOR_API_BASE_URL?: string;
  COLLECTOR_API_KEY?: string;
  COLLECTOR_MACHINE_CODE?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const DEFAULT_COLLECTOR_API_BASE_URL = "https://dev-gacha.collectorcrypt.com";
const DEFAULT_COLLECTOR_MACHINE_CODE = "pokemon_50";
const COLLECTOR_RARITIES = ["common", "uncommon", "rare", "epic"] as const;
const COLLECTOR_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const COMIC_PRODUCTION_PATH = "/comic-production/index.html";

async function comicProductionResponse(request: Request, env: WorkerEnv): Promise<Response> {
  const assetUrl = new URL(COMIC_PRODUCTION_PATH, request.url);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, {
    method: request.method,
    headers: request.headers,
  }));
  const headers = new Headers(assetResponse.headers);
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  headers.set("content-location", "/");
  headers.set("x-content-type-options", "nosniff");
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

function collectorFallbackResponse(): Response {
  return Response.json(
    { cards: FALLBACK_COLLECTOR_CARDS, source: "fallback" },
    { headers: { "cache-control": COLLECTOR_CACHE_CONTROL } },
  );
}

async function collectorCardsResponse(env: WorkerEnv): Promise<Response> {
  try {
    const baseUrl = new URL(env.COLLECTOR_API_BASE_URL ?? DEFAULT_COLLECTOR_API_BASE_URL);
    if (baseUrl.protocol !== "https:") throw new Error("Collector API must use HTTPS");
    const machineCode = env.COLLECTOR_MACHINE_CODE?.trim() || DEFAULT_COLLECTOR_MACHINE_CODE;

    const headers: Record<string, string> = { accept: "application/json" };
    if (env.COLLECTOR_API_KEY) headers["x-api-key"] = env.COLLECTOR_API_KEY;

    const machineResponse = await fetch(new URL("/api/gachas/all", baseUrl), {
      headers,
      signal: AbortSignal.timeout(3_500),
    });
    if (!machineResponse.ok) throw new Error("Collector API unavailable");

    const machinePayload: unknown = await machineResponse.json();
    const machine = readCollectorMachine(machinePayload, machineCode);
    const instantBuybackPercent = readMachineBuybackPercent(machine);
    if (instantBuybackPercent === undefined) throw new Error("Collector machine is invalid");

    const inventoryResponses = await Promise.all(
      COLLECTOR_RARITIES.map(async (rarity) => {
        const inventoryUrl = new URL("/api/getNfts", baseUrl);
        inventoryUrl.searchParams.set("code", machineCode);
        inventoryUrl.searchParams.set("page", "1");
        inventoryUrl.searchParams.set("limit", "3");
        inventoryUrl.searchParams.set("rarity", rarity);
        const response = await fetch(inventoryUrl, {
          headers,
          signal: AbortSignal.timeout(3_500),
        });
        if (!response.ok) throw new Error("Collector inventory is unavailable");
        return response.json() as Promise<unknown>;
      }),
    );

    const cards = normalizeCollectorCards(
      { nfts: inventoryResponses.flatMap(readCollectorInventory) },
      { instantBuybackPercent, limit: 12 },
    );
    if (cards.length === 0) throw new Error("Collector inventory is empty");

    return Response.json(
      { cards, source: "remote" },
      { headers: { "cache-control": COLLECTOR_CACHE_CONTROL } },
    );
  } catch {
    return collectorFallbackResponse();
  }
}

function readCollectorMachine(payload: unknown, machineCode: string): Record<string, unknown> | undefined {
  const machines = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.machines)
      ? payload.machines
      : [];
  return machines.find(
    (value) => isRecord(value) && value.code === machineCode,
  ) as Record<string, unknown> | undefined;
}

function readMachineBuybackPercent(machine: Record<string, unknown> | undefined): number | undefined {
  if (!machine) return undefined;
  const instantBuyback = isRecord(machine.instantBuyback) ? machine.instantBuyback : undefined;
  const value = Number(instantBuyback?.percentageOfValue ?? machine.instantBuybackPercent);
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
}

function readCollectorInventory(payload: unknown): unknown[] {
  return isRecord(payload) && Array.isArray(payload.nfts) ? payload.nfts : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function operatorAntiFramingResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const existingPolicy = headers.get("content-security-policy");
  const directives = existingPolicy
    ? existingPolicy
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive.length > 0 && !/^frame-ancestors(?:\s|$)/i.test(directive))
    : [];
  directives.push("frame-ancestors 'none'");
  headers.set("content-security-policy", directives.join("; "));
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const operatorPage = url.pathname === "/operator" || url.pathname.startsWith("/operator/");

    if (url.pathname === "/operator/api" || url.pathname.startsWith("/operator/api/")) {
      return operatorAntiFramingResponse(await proxyOperatorRequest(request, env));
    }

    if (operatorPage && !operatorPageAuthorized(request)) {
      return operatorAntiFramingResponse(operatorAccessRequiredResponse());
    }

    if (request.method === "GET" && url.pathname === "/api/collector-cards") {
      return collectorCardsResponse(env);
    }

    if (url.pathname === "/api/packs" || url.pathname === "/api/packs/inventory") {
      return handlePackCatalog(request);
    }

    const publicPage = await publicPageResponse(request, env.ASSETS);
    if (publicPage) return publicPage;

    if (url.pathname === "/api/cycle-status") {
      const cache = (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)?.default;
      return proxyPublicCycleStatus(request, env, cache);
    }

    if (url.pathname === "/api/community-dashboard") {
      const cache = (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)?.default;
      return proxyPublicCommunitySnapshot(request, env, cache);
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      return comicProductionResponse(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    return operatorPage ? operatorAntiFramingResponse(response) : response;
  },
};

export default worker;
