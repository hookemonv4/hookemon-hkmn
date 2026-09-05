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
  assert.ok(calls.every(({ url, init }) => url.origin === "https://gacha.collectorcrypt.com" && init.method === "GET" && init.redirect === "error"));
  assert.equal(calls.at(-1).url.searchParams.get("limit"), "24"); assert.equal(response.headers.get("cache-control"), "no-store");
});

test("refuses unlisted packs and invalid queries before inventory fetch", async () => {
  for (const query of ["code=../../secret", "code=pokemon_50&page=-1", "code=pokemon_50&page=1001", "code=pokemon_50&rarity=legendary", "code=pokemon_50&url=https://evil.test", "code=pokemon_50&code=private_50"]) {
    const { calls, fetcher } = upstream(); assert.equal((await handlePackCatalog(request(`/api/packs/inventory?${query}`), fetcher)).status, 400); assert.equal(calls.length, 0);
  }
  const { calls, fetcher } = upstream(); assert.equal((await handlePackCatalog(request("/api/packs/inventory?code=private_50"), fetcher)).status, 404); assert.equal(calls.length, 2);
});

test("provider failure has no stale or showcase fallback", async () => {
  const { fetcher } = upstream({ "/api/status": new Error("timeout") });
  const response = await handlePackCatalog(request("/api/packs"), fetcher); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.fetchedAt, null); assert.equal(body.packs, undefined); assert.equal(body.cards, undefined);
  assert.equal((await handlePackCatalog(new Request("https://hookemon.com/api/packs", { method: "POST" }), fetcher)).status, 405);
});
