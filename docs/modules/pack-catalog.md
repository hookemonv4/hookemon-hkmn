# Pack catalogue

The read-only pack library presents Collector Crypt's public Pokémon packs and paginated provider inventory. It is separate from Hookemon's showcase examples, holdings, completed pulls and purchase policy. A listed pack does not imply that Hookemon has selected it for its next cycle.

`handlePackCatalog(request)` serves GET `/api/packs` and GET `/api/packs/inventory?code=<public-code>&rarity=<common|uncommon|rare|epic>&page=<1..1000>`. Inventory pages contain at most 24 cards. Rarity is optional at the API boundary. Unknown parameters, repeated keys, invalid codes and page values return 400; unlisted packs return 404. Other methods return 405. The Worker entry point routes these paths to the handler and `/packs` to `comic-production/packs.html`.

List responses contain `provider`, `sourceUrl`, `fetchedAt`, `valueType`, `availabilityNotice` and `packs`. Each pack includes `code`, `name`, `category`, `price`, `currency`, `contains`, `availability`, `sourceUrl` and `tiers` with `rarity`, `minimum`, `maximum`. Inventory adds `code`, `rarity`, `availability`, `cards`, `page`, `pageSize` and `hasMore`. Cards expose name, rarity, insured value, grade, certificate, year, category, variant, population, vault and provider record links. Missing optional details are null.

Provider origin, category, currency, page size and allowed image hosts live in `config/pack-provider.json`. All provider requests use fixed HTTPS URLs, GET, redirect rejection and a timeout. Only public, unarchived packs in the exact `Pokemon` category are listed. Machine status and per-pack status are both consulted; absent status is unknown. Image origins are allowlisted. Provider strings enter the browser through textContent. No wallet, purchase, signature or personal account endpoints are used.

The first accordion expansion loads only the Epic tier's first page; the other tiers and subsequent pages load on demand. Tier selection cancels previous requests. Provider failures clear displayed stock rather than silently substituting cached or example cards. Refresh reloads the catalogue. Responses use `no-store`. `fetchedAt` is our retrieval time, not a provider valuation date. Inventory can change between pages or before purchase. Cards returned on overlapping pages are deduplicated by NFT ID. Category tiers are distinct from printed card rarity; the UI does not infer per-card odds from inventory counts or weights.

Provider values are labelled insured values in USD, never sale proceeds. Card attribution and stock membership come from the inventory response, not the separate showcase configuration. Missing provider data produces an explicit 503 without a cards or packs array. The recovery path is a manual retry or the linked provider page.

Run the scoped tests with `node --experimental-strip-types --test tests/pack-catalog.test.mjs` from `apps/web`. Website lint validates the Worker and browser module. The browser smoke check should open a pack, select each rarity, load another page, expand card metadata and verify the 320px layout.

## Verified external interface

Read-only observations on September 5, 2026:

- `https://gacha.collectorcrypt.com/api/gachas/all` returned HTTP 200 and an array of definitions, including public/private and archived entries. `price.amount`, `contains`, `tierRanges` and `menuCategory` are provider fields.
- `https://gacha.collectorcrypt.com/api/status` returned HTTP 200 with `machineStatus` and `gachas` containing `code`, `status`, `isOpen`.
- `https://gacha.collectorcrypt.com/api/getNfts?code=pokemon_50&page=1&limit=24&rarity=epic` returns `{nfts,hasMore,page,limit}`. Each of common, uncommon, rare and epic was queried separately and returned matching `rarity` values. The provider's own public client uses this endpoint with code, page and limit.
- Card fields include `nft_address`, `name`, `description`, `rarity`, `insured_value`, `image`, `attributes`, `content.files`, `gradePopulation` and `parallel`. Attribute names include `The Grade`, `Grading Company` and `Grading ID`. `taggedAt` is not used as a price-check timestamp.

These are observed public application endpoints, not a versioned integration agreement. Schema drift fails closed and requires a renewed provider check before changing the normalizer.
