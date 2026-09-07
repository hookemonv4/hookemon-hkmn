import test from "node:test";
import assert from "node:assert/strict";
import { handlePackCatalog, normalizeInventory, normalizePacks } from "../worker/pack-catalog.ts";

const pack = { code: "pokemon_50", name: "Elite Pokémon Gacha Pack", public: true, archived: false, menuCategory: "Pokemon", price: { amount: 50 }, contains: 1, tierRanges: { epic: { start: 250, end: 5001 } } };
const state = { machineStatus: "running", gachas: [{ code: "pokemon_50", isOpen: true }] };
const card = { nft_address: "CaEFz66SgqbgeAB4unvaHWQuPNYETfbuDWnDrrMj6LVh", name: "Charizard", rarity: "epic", insured_value: 3800, image: "https://d1xpxki1g4htqu.cloudfront.net/example", attributes: [{ trait_type: "The Grade", value: "GEM-MT 10" }, { trait_type: "Grading ID", value: "41493778" }], content: { files: [{}, { cc_cdn: "https://arweave.net/reverse" }] } };
const inventory = { nfts: [card], hasMore: true, page: 1, limit: 24 };
const request = path => new Request(`https://hookemon.com${path}`);
function upstream(overrides = {}) { const calls = []; const fetcher = async (url, init) => { calls.push({ url: new URL(url), init }); const body = overrides[url.pathname] ?? (url.pathname === "/api/gachas/all" ? [pack] : url.pathname === "/api/status" ? state : inventory); if (body instanceof Error) throw body; return Response.json(body); }; return { calls, fetcher }; }

test("lists only public, unarchived Pokémon packs with explicit provider status", () => {
  const packs = normalizePacks([pack, { ...pack, code: "private_50", public: false }, { ...pack, code: "archived_50", archived: true }, { ...pack, code: "sport_50", menuCategory: "Sports" }], state);
  assert.equal(packs.length, 1); assert.equal(packs[0].availability, "open"); assert.equal(packs[0].price, 50);
  assert.equal(normalizePacks([pack], { ...state, machineStatus: "stopped" })[0].availability, "closed");
  assert.equal(normalizePacks([pack], { machineStatus: "unknown", gachas: [] })[0].availability, "unknown");
});

test("card data preserves insured value and certificate while dropping unsafe images", () => {
  const result = normalizeInventory({ ...inventory, nfts: [{ ...card, image: "https://d1xpxki1g4htqu.cloudfront.net.evil.test/card" }] }, 1, "epic");
  assert.equal(result.cards[0].image, null); assert.equal(result.cards[0].backImage, "https://arweave.net/reverse");
  assert.equal(result.cards[0].certification, "41493778"); assert.equal(result.cards[0].insuredValue, 3800);
  assert.match(result.cards[0].sourceUrl, /^https:\/\/collectorcrypt\.com\/assets\/solana\//);
});

test("rejects malformed pages, mismatched rarity and invalid numeric values", () => {
  for (const payload of [{ ...inventory, page: 2 }, { ...inventory, hasMore: undefined }, { ...inventory, nfts: [{ ...card, rarity: "common" }] }, { ...inventory, nfts: [{ ...card, insured_value: -1 }] }, { ...inventory, nfts: [{ ...card, nft_address: "javascript:alert(1)" }] }]) assert.throws(() => normalizeInventory(payload, 1, "epic"));
  assert.throws(() => normalizePacks([{ ...pack, price: { amount: "50" } }], state));
});

test("inventory pagination uses the fixed HTTPS provider and bounded GET request", async () => {
  const { calls, fetcher } = upstream();
  const response = await handlePackCatalog(request("/api/packs/inventory?code=pokemon_50&rarity=epic&page=1"), fetcher);
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.cards.length, 1); assert.equal(body.pageSize, 24); assert.equal(body.hasMore, true);
  assert.equal(body.valueType, "provider-insured-value"); assert.ok(Date.parse(body.fetchedAt));
  assert.ok(calls.every(({ url, init }) => url.origin === "https://gacha.collectorcrypt.com" && init.method === "GET" && init.redirect === "manual"));
  assert.equal(calls.at(-1).url.searchParams.get("limit"), "24"); assert.equal(response.headers.get("cache-control"), "no-store");
});

test("refuses unlisted packs and invalid queries before inventory fetch", async () => {
  for (const query of ["code=../../secret", "code=pokemon_50&page=-1", "code=pokemon_50&page=1001", "code=pokemon_50&rarity=legendary", "code=pokemon_50&url=https://evil.test", "code=pokemon_50&code=private_50"]) {
    const { calls, fetcher } = upstream(); assert.equal((await handlePackCatalog(request(`/api/packs/inventory?${query}`), fetcher)).status, 400); assert.equal(calls.length, 0);
  }
  const { calls, fetcher } = upstream(); assert.equal((await handlePackCatalog(request("/api/packs/inventory?code=private_50"), fetcher)).status, 404); assert.equal(calls.length, 2);
});

test("provider failure has no stale or showcase fallback", async () => {
  const { fetcher } = upstream({ "/api/status": new Error("network down") });
  const response = await handlePackCatalog(request("/api/packs"), fetcher); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.fetchedAt, null); assert.equal(body.packs, undefined); assert.equal(body.cards, undefined);
  assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "fetch_failed");
  assert.equal((await handlePackCatalog(new Request("https://hookemon.com/api/packs", { method: "POST" }), fetcher)).status, 405);
});

test("oversized streamed provider response is cancelled and rejected", async () => {
  let cancelled = false;
  const fetcher = async url => url.pathname === "/api/status" ? Response.json(state) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2_000_001)); },
    cancel() { cancelled = true; },
  }));
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503); assert.equal(cancelled, true);
  assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "oversize");
});

test("classifies upstream HTTP failure status without leaking upstream body", async () => {
  const fetcher = async url => url.pathname === "/api/status" ? Response.json(state) : new Response("upstream secret detail", { status: 502 });
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503); assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "http_502");
  const body = await response.json(); assert.ok(!JSON.stringify(body).includes("upstream secret detail"));
});

test("classifies a timed-out provider request distinctly from a network failure", async () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const { fetcher } = upstream({ "/api/status": timeout });
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503); assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "timeout");
});

test("classifies a request-setup failure (URL/AbortSignal construction) before any fetcher call", async () => {
  const original = AbortSignal.timeout;
  AbortSignal.timeout = () => { throw new Error("setup boom"); };
  try {
    const { calls, fetcher } = upstream();
    const response = await handlePackCatalog(request("/api/packs"), fetcher);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "request_setup");
    assert.equal(calls.length, 0);
  } finally {
    AbortSignal.timeout = original;
  }
});

test("classifies a synchronous throw from calling fetcher(...) without leaking the message", async () => {
  const { fetcher } = upstream();
  const response = await handlePackCatalog(request("/api/packs"), (url, init) => {
    if (new URL(url).pathname === "/api/status") throw new TypeError("boom during invocation");
    return fetcher(url, init);
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "fetch_failed");
  assert.ok(!JSON.stringify(await response.json()).includes("boom during invocation"));
});

test("classifies an asynchronously rejected transport failure without leaking the message", async () => {
  const { fetcher } = upstream({ "/api/gachas/all": new TypeError("some other transport failure") });
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "fetch_failed");
  assert.ok(!JSON.stringify(await response.json()).includes("some other transport failure"));
});

test("rejects a redirected provider response, cancels its body, and never follows Location", async () => {
  let cancelled = false;
  const fetcher = async url => url.pathname === "/api/status" ? Response.json(state) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
    cancel() { cancelled = true; },
  }), { status: 302, headers: { location: "https://evil.test/redirected" } });
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503); assert.equal(cancelled, true);
  assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "redirect");
  const body = await response.json();
  assert.deepEqual(body, { error: "Provider inventory is temporarily unavailable. Please try again or view Collector Crypt.", provider: "Collector Crypt", sourceUrl: body.sourceUrl, fetchedAt: null });
  assert.ok(!JSON.stringify(body).includes("evil.test"));
});

test("classifies a non-JSON provider body distinctly from a schema rejection", async () => {
  const fetcher = async url => url.pathname === "/api/status" ? Response.json(state) : new Response("not json");
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503); assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "invalid_json");
});

test("classifies a genuine catalogue schema rejection as invalid_schema, not a generic bucket", async () => {
  const { fetcher } = upstream({ "/api/gachas/all": [{ ...pack, contains: 0 }] });
  const response = await handlePackCatalog(request("/api/packs"), fetcher);
  assert.equal(response.status, 503); assert.equal(response.headers.get("x-pack-catalog-diagnostic"), "invalid_schema");
});

test("pack covers accept provider artwork and fall back past unsafe or missing URLs", () => {
  const thumbnailUrl = "https://degwuxynwtb2zaso.public.blob.vercel-storage.com/machines/pokemon_100/thumb.png";
  assert.equal(normalizePacks([{ ...pack, thumbnailUrl }], state)[0].image, thumbnailUrl);
  assert.equal(normalizePacks([{ ...pack, image: "javascript:alert(1)", thumbnailUrl }], state)[0].image, thumbnailUrl);
  assert.equal(normalizePacks([{ ...pack, thumbnailUrl: "https://degwuxynwtb2zaso.public.blob.vercel-storage.com.evil.test/cover" }], state)[0].image, null);
  assert.equal(normalizePacks([pack], state)[0].image, null);
});


test("buyback estimates use the requested pack's current percentage", async () => {
  const packs = [
    { ...pack, instantBuyback: { percentageOfValue: 85 } },
    { ...pack, code: "pokemon_500", instantBuyback: { percentageOfValue: 90 } },
    { ...pack, code: "pokemon_5000", instantBuyback: { percentageOfValue: 93 } },
  ];
  const { fetcher } = upstream({ "/api/gachas/all": packs });
  const catalogue = await (await handlePackCatalog(request("/api/packs"), fetcher)).json();
  assert.deepEqual(catalogue.packs.map(pack => pack.instantBuybackPercent), [85, 90, 93]);
  for (const [code, percentage, estimate] of [["pokemon_50", 85, 3230], ["pokemon_500", 90, 3420], ["pokemon_5000", 93, 3534]]) {
    const response = await handlePackCatalog(request(`/api/packs/inventory?code=${code}`), fetcher);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.instantBuybackPercent, percentage);
    assert.equal(body.cards[0].estimatedBuybackUsd, estimate);
    assert.match(body.buybackNotice, /Not a guaranteed offer/);
  }
  assert.equal(normalizeInventory({ ...inventory, nfts: [{ ...card, insured_value: 12.34 }] }, 1, null, 93).cards[0].estimatedBuybackUsd, 11.48);
});

test("missing and malformed buyback percentages never produce an estimate", async () => {
  for (const percentage of [undefined, null, 0, -1, 100.1, Infinity, NaN, "85", "85%", "0x55", "", true, {}, []]) {
    assert.equal(normalizePacks([{ ...pack, instantBuyback: { percentageOfValue: percentage } }], state)[0].instantBuybackPercent, null);
    assert.equal(normalizeInventory(inventory, 1, null, percentage).cards[0].estimatedBuybackUsd, null);
  }
  const { fetcher } = upstream();
  const body = await (await handlePackCatalog(request("/api/packs/inventory?code=pokemon_50"), fetcher)).json();
  assert.equal(body.instantBuybackPercent, null);
  assert.equal(body.cards[0].estimatedBuybackUsd, null);
  assert.equal(normalizeInventory(inventory, 1, null, 100).cards[0].estimatedBuybackUsd, 3800);
});
