import provider from "../../../config/pack-provider.json" with { type: "json" };
import { cancelResponseBody, readBoundedUtf8Body } from "./bounded-response-body.ts";

type Row = Record<string, unknown>;
const rarities = ["common", "uncommon", "rare", "epic"] as const;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown, max = 250): string => typeof value === "string" ? value.slice(0, max) : "";
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const validCode = (value: string) => /^[a-z][a-z0-9_]{1,63}$/.test(value);

/** Carries a fixed, safe diagnostic code (numeric status or enum tag). Never carries upstream body/stack/secret. */
class ProviderError extends Error {
  readonly diagnostic: string;
  constructor(diagnostic: string, message: string) {
    super(message);
    this.diagnostic = diagnostic;
  }
}

/** Marks a genuine catalogue/inventory shape rejection, distinct from transport or parse failures. */
class SchemaError extends Error {}

function imageUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value, 2048));
    return url.protocol === "https:" && !url.username && !url.password && !url.port && provider.imageHosts.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

/** Maps a caught value to a fixed, safe diagnostic tag. Never returns the raw error name/message. */
function safeCode(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  if (error instanceof Error && error.name === "TypeError") {
    if (/illegal invocation/i.test(error.message)) return "illegal_invocation";
    if (/cannot perform i\/o on behalf of a different request/i.test(error.message)) return "request_context";
    return "type_error";
  }
  return "other";
}

async function read(path: string, fetcher: typeof fetch, scope?: string): Promise<unknown> {
  const tag = (stage: string) => scope ? `${scope}_${stage}` : stage;
  let url: URL, signal: AbortSignal;
  try {
    url = new URL(path, provider.origin);
    signal = AbortSignal.timeout(6500);
  } catch {
    throw new ProviderError(tag("request_setup"), "Provider request failed");
  }
  let responsePromise: Promise<Response>;
  try {
    responsePromise = fetcher(url, { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal });
  } catch (error) {
    throw new ProviderError(tag(`fetch_call_${safeCode(error)}`), "Provider request failed");
  }
  let response: Response;
  try {
    response = await responsePromise;
  } catch (error) {
    throw new ProviderError(tag(`fetch_reject_${safeCode(error)}`), "Provider request failed");
  }
  if (!response.ok) { await cancelResponseBody(response); throw new ProviderError(`http_${response.status}`, "Provider unavailable"); }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > 2_000_000) { await cancelResponseBody(response); throw new ProviderError("oversize", "Provider response too large"); }
  let raw: string;
  try {
    raw = await readBoundedUtf8Body(response, 2_000_000);
  } catch (error) {
    const oversized = error instanceof TypeError && error.message === "PUBLIC_RESPONSE_BODY_OVERSIZED";
    throw new ProviderError(oversized ? "oversize" : "invalid_json", oversized ? "Provider response too large" : "Provider response was not valid text");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError("invalid_json", "Provider response was not valid JSON");
  }
}

export function normalizePacks(value: unknown, statusValue: unknown) {
  if (!Array.isArray(value) || !Array.isArray(object(statusValue).gachas)) throw new SchemaError("Invalid catalogue");
  const state = object(statusValue);
  const statuses = (state.gachas as unknown[]).map(object);
  return value.map(object).filter(pack => pack.public === true && pack.archived === false && pack.menuCategory === provider.category && validCode(text(pack.code)))
    .map(pack => {
      const code = text(pack.code);
      const status = statuses.find(row => row.code === code);
      const price = number(object(pack.price).amount);
      const contains = number(pack.contains);
      if (!text(pack.name) || price === null || contains === null || !Number.isInteger(contains) || contains < 1) throw new SchemaError("Invalid pack");
      return {
        code, name: text(pack.name), category: "Pokémon", price, currency: provider.currency, contains,
        availability: state.machineStatus === "running" && status?.isOpen === true ? "open" : status?.isOpen === false || state.machineStatus === "stopped" ? "closed" : "unknown",
        sourceUrl: provider.source,
        image: imageUrl(pack.imageNobgUrl) ?? imageUrl(pack.image) ?? imageUrl(pack.thumbnailUrl),
        tiers: rarities.map(rarity => {
          const range = object(object(pack.tierRanges)[rarity]);
          return { rarity, minimum: number(range.start), maximum: number(range.end) };
        }),
      };
    }).sort((a, b) => a.price - b.price);
}

export function normalizeInventory(value: unknown, page: number, rarity: string | null) {
  const payload = object(value);
  if (!Array.isArray(payload.nfts) || typeof payload.hasMore !== "boolean" || payload.page !== page || payload.limit !== provider.pageSize || payload.nfts.length > provider.pageSize) throw new SchemaError("Invalid inventory");
  const cards = payload.nfts.map(item => {
    const card = object(item);
    const attributes = Array.isArray(card.attributes) ? card.attributes.map(object) : [];
    const attribute = (key: string) => text(attributes.find(row => row.trait_type === key)?.value);
    const id = text(card.nft_address || card.id, 80);
    const tier = text(card.rarity);
    const value = number(card.insured_value);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id) || !rarities.includes(tier as typeof rarities[number]) || (rarity && tier !== rarity) || value === null || !text(card.name)) throw new SchemaError("Invalid card");
    const files = object(card.content).files;
    const back = Array.isArray(files) ? object(files[1]) : {};
    return {
      id, name: text(card.description || card.name, 400), rarity: tier, insuredValue: value, currency: provider.currency,
      image: imageUrl(card.image), backImage: imageUrl(back.cc_cdn || back.uri),
      grade: attribute("The Grade") || null, gradingCompany: attribute("Grading Company") || null,
      certification: attribute("Grading ID") || null, year: attribute("Year") || null,
      category: attribute("Category") || null, parallel: text(card.parallel) || null,
      population: number(card.gradePopulation), vault: attribute("Vault") || null,
      sourceUrl: `https://collectorcrypt.com/assets/solana/${id}`,
    };
  });
  return { cards, page, pageSize: provider.pageSize, hasMore: payload.hasMore };
}

/** Public, read-only provider catalogue. Never substitutes showcase cards for inventory. */
export async function handlePackCatalog(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const reply = (body: unknown, status = 200, diagnostic?: string) =>
    Response.json(body, { status, headers: diagnostic ? { ...headers, "x-pack-catalog-diagnostic": diagnostic } : headers });
  const url = new URL(request.url);
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, allow: "GET" } });
  const inventory = url.pathname === "/api/packs/inventory";
  if (!inventory && url.pathname !== "/api/packs") return reply({ error: "Not found" }, 404);
  const allowed = inventory ? ["code", "rarity", "page"] : [];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return reply({ error: "Invalid query" }, 400);
  const code = url.searchParams.get("code") || "";
  const rarity = url.searchParams.get("rarity");
  const pageText = url.searchParams.get("page") || "1";
  const page = Number(pageText);
  if (inventory && (!validCode(code) || (rarity !== null && !rarities.includes(rarity as typeof rarities[number])) || !/^[1-9][0-9]{0,3}$/.test(pageText) || page > 1000)) return reply({ error: "Invalid query" }, 400);
  try {
    const [catalogue, statuses] = await Promise.all([read("/api/gachas/all", fetcher, "catalogue"), read("/api/status", fetcher, "status")]);
    const packs = normalizePacks(catalogue, statuses);
    const metadata = { provider: provider.name, sourceUrl: provider.source, fetchedAt: new Date().toISOString(), valueType: "provider-insured-value", availabilityNotice: "Provider inventory snapshot. Cards may change before the next purchase. These are not Hookemon pulls or promised pack contents." };
    if (!inventory) return reply({ ...metadata, packs });
    const pack = packs.find(item => item.code === code);
    if (!pack) return reply({ error: "Pack not publicly listed" }, 404);
    const query = new URLSearchParams({ code, page: String(page), limit: String(provider.pageSize) });
    if (rarity) query.set("rarity", rarity);
    const cards = normalizeInventory(await read(`/api/getNfts?${query}`, fetcher), page, rarity);
    return reply({ ...metadata, fetchedAt: new Date().toISOString(), code, rarity, availability: pack.availability, ...cards });
  } catch (error) {
    const diagnostic = error instanceof ProviderError ? error.diagnostic : error instanceof SchemaError ? "invalid_schema" : "unknown";
    return reply({ error: "Provider inventory is temporarily unavailable. Please try again or view Collector Crypt.", provider: provider.name, sourceUrl: provider.source, fetchedAt: null }, 503, diagnostic);
  }
}
