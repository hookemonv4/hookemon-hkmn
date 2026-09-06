# Public information pages

The owner requested cycle records, holder rules and transparency as dedicated subpages, alongside the expandable pack explorer. These pages implement that approved website scope; this document does not revise the authoritative distribution specification.

Routes are `/cycles`, `/holders` and `/transparency`. They share the existing wordmark, cream, navy and yellow palette, responsive navigation, keyboard-accessible native disclosures and a skip link.

The cycle page reuses the homepage's strict public-dashboard validators, completion-aware payout helper, history completeness rule and exact integer amount formatting. It fetches both observations together with a bounded timeout. A refresh failure clears the previous financial presentation. Transaction URLs are derived only after the payload's profile, network and transaction identity are validated. The legacy USDC feed is explicitly separated from the current documented USDG payout policy; no conversion or network relabelling occurs. The available source exposes a latest record, not a complete per-cycle archive.

Holder copy is grounded in `docs/modules/eligibility-snapshot.md`, `docs/modules/holder-snapshot-indexer.md` and `docs/modules/pro-rata-distribution.md`: finalized pre-claim balances, manifest-derived exclusions, proportional allocations, floor rounding with carried dust, and finalized direct transfers. No historical top-holder ranking or time-weighted eligibility policy is asserted. Wallet-specific eligibility and production availability require their own published evidence.

Transparency separates valuations, asking prices and actual proceeds; preserves the approved gross-volume fee split; and does not publish unverified addresses, custody cover or redemption promises. Source links expose the public feeds and provider homepage. Missing deployment evidence remains explicit rather than replaced by an invented address.

Run `node --experimental-strip-types --test tests/information-pages.test.mjs` from `apps/web` to check missing data, partial payouts, cross-network rejection, explorer URLs, import isolation and accessible page structure.
