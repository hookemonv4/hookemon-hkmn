# Collector Crypt fixture HTTP responses

Every endpoint fixture JSON file at this directory's top level is a local test record derived from
the documented response shape for the endpoint of the same name at
`docs.collectorcrypt.com/gacha/api` (captured 2026-09-02). Values may be synthetic. They are used
only to drive `collector-crypt.test.mjs`'s stub `fetchImpl`; no live network call is made by the
default (`node --test`) suite. See
`collector-crypt.live-smoke.test.mjs` for the separate, explicitly-labeled live check.

`get-nfts.json` preserves the documented response shape. **UNVERIFIED:** its `nft_address`,
`rarity`, and `insured_value` values, including the insured-value asset and atomic unit, are
fixture data rather than pinned live facts.

`pack-status.json` is a documented example, not a pinned live contract for nested fields.
**UNVERIFIED:** `send.insured_value`, `send.prize_tier`, their unit and asset linkage, and the
live mapping between numeric prize tiers and card rarity. The documentation maps tiers `1` through
`4` to the documented rarities; the epic gate requires explicit field and asset configuration and
holds when those observations do not agree.

`machines.json` retains the documented string shape for `contains`. The permitted public machine
URL returned HTML rather than JSON on 2026-09-04, as recorded in
`live-2026-09-04/public-readonly-capture.json`. Its current JSON type and economic meaning are
**UNVERIFIED**; no lifecycle rule may rely on it.

`live-2026-09-04/public-readonly-capture.json` records response metadata and the documented
buyback-check fields without storing an API key or a provider response body. The documentation
maps prize tiers `1` through `4` to rarities, but it does not establish an `insured_value` asset or
unit. The epic gate therefore requires configured field and asset bindings and holds malformed or
conflicting observations as `HELD_DATA_UNVERIFIED`.
