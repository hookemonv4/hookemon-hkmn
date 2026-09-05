import provider from "../../../config/pack-provider.json" with { type: "json" };

type Row = Record<string, unknown>;
const rarities = ["common", "uncommon", "rare", "epic"] as const;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown, max = 250): string => typeof value === "string" ? value.slice(0, max) : "";
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const validCode = (value: string) => /^[a-z][a-z0-9_]{1,63}$/.test(value);

function imageUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value, 2048));
    return url.protocol === "https:" && !url.username && !url.password && !url.port && provider.imageHosts.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

async function read(path: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(new URL(path, provider.origin), {
    method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw new Error("Provider unavailable");
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error("Provider response too large");
  return JSON.parse(raw);
}

export function normalizePacks(value: unknown, statusValue: unknown) {
  if (!Array.isArray(value) || !Array.isArray(object(statusValue).gachas)) throw new Error("Invalid catalogue");
  const state = object(statusValue);
  const statuses = (state.gachas as unknown[]).map(object);
  return value.map(object).filter(pack => pack.public === true && pack.archived === false && pack.menuCategory === provider.category && validCode(text(pack.code)))
    .map(pack => {
      const code = text(pack.code);
      const status = statuses.find(row => row.code === code);
      const price = number(object(pack.price).amount);
      const contains = number(pack.contains);
      if (!text(pack.name) || price === null || contains === null || !Number.isInteger(contains) || contains < 1) throw new Error("Invalid pack");
      return {
        code, name: text(pack.name), category: "Pokémon", price, currency: provider.currency, contains,
        availability: state.machineStatus === "running" && status?.isOpen === true ? "open" : status?.isOpen === false || state.machineStatus === "stopped" ? "closed" : "unknown",
        sourceUrl: `${provider.origin}/?pack=${encodeURIComponent(code)}`,
        tiers: rarities.map(rarity => {
          const range = object(object(pack.tierRanges)[rarity]);
          return { rarity, minimum: number(range.start), maximum: number(range.end) };
        }),
      };
    }).sort((a, b) => a.price - b.price);
}

export function normalizeInventory(value: unknown, page: number, rarity: string | null) {
  const payload = object(value);
  if (!Array.isArray(payload.nfts) || typeof payload.hasMore !== "boolean" || payload.page !== page || payload.limit !== provider.pageSize || payload.nfts.length > provider.pageSize) throw new Error("Invalid inventory");
  const cards = payload.nfts.map(item => {
    const card = object(item);
    const attributes = Array.isArray(card.attributes) ? card.attributes.map(object) : [];
    const attribute = (key: string) => text(attributes.find(row => row.trait_type === key)?.value);
    const id = text(card.nft_address || card.id, 80);
    const tier = text(card.rarity);
    const value = number(card.insured_value);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id) || !rarities.includes(tier as typeof rarities[number]) || (rarity && tier !== rarity) || value === null || !text(card.name)) throw new Error("Invalid card");
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
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
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
    const [catalogue, statuses] = await Promise.all([read("/api/gachas/all", fetcher), read("/api/status", fetcher)]);
    const packs = normalizePacks(catalogue, statuses);
    const metadata = { provider: provider.name, sourceUrl: provider.source, fetchedAt: new Date().toISOString(), valueType: "provider-insured-value", availabilityNotice: "Provider inventory snapshot. Cards may change before the next purchase. These are not Hookemon pulls or promised pack contents." };
    if (!inventory) return reply({ ...metadata, packs });
    const pack = packs.find(item => item.code === code);
    if (!pack) return reply({ error: "Pack not publicly listed" }, 404);
    const query = new URLSearchParams({ code, page: String(page), limit: String(provider.pageSize) });
    if (rarity) query.set("rarity", rarity);
    const cards = normalizeInventory(await read(`/api/getNfts?${query}`, fetcher), page, rarity);
    return reply({ ...metadata, fetchedAt: new Date().toISOString(), code, rarity, availability: pack.availability, ...cards });
  } catch {
    return reply({ error: "Provider inventory is temporarily unavailable. Please try again or view Collector Crypt.", provider: provider.name, sourceUrl: provider.source, fetchedAt: null }, 503);
  }
}
