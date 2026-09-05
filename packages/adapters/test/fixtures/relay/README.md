# Relay fixtures — provenance

Recorded from the live `https://api.relay.link` API on 2026-09-02 (read-only GETs and a POST
`/quote/v2` quote request — quoting is a real read, never an execution; see
`packages/adapters/src/relay-client.mjs`'s header comment for what was independently re-verified
against each endpoint):

- `chains.json` — a real `GET /chains` response, trimmed to the Robinhood Chain (4663) and Solana
  (792703809) entries.
- `quote-outbound.json` — a real `POST /quote/v2` response for the OUTBOUND direction (25 USDG on
  Robinhood Chain -> Circle USD on Solana).
- `quote-return.json` — a real `POST /quote/v2` response for the RETURN direction (24 Circle USD on
  Solana -> USDG on Robinhood Chain).

Synthetic, schema-verified (not obtainable without moving real funds through a completed bridge
cycle; shaped exactly against Relay's published OpenAPI document at
`https://api.relay.link/documentation/json`, using the real `requestId`/`orderId` from
`quote-outbound.json` so the fixtures correlate):

- `intents-status-refund.json` — a `GET /intents/status/v3` `status: "refund"` response.
- `requests-refund-detail.json` — a `GET /requests/v3` response for the same intent, carrying the
  exact refund amount (`data.refundCurrencyData.amount`) and the quoted-vs-actual route
  (`data.route.quoted`/`data.route.actual`) this adapter's differential check reads.

`GET /requests/v3` itself requires a Relay API key this project does not have (confirmed live: a
keyless call returns `{"message":"headers must have required property 'x-api-key'"}`) — see
`product/SOURCE_BOUNDARY.md`'s external-readiness note. `requests-refund-detail.json` exists so the
adapter's own parsing/reconciliation code can be exercised against a real-shaped response now,
ahead of that credential being available.

Every recorded `symbol`/`id`/logo-slug value that named the retired stablecoin ticker was
neutralized to the placeholder `CIRCLE_USD` (this repository forbids that ticker string, per
`scripts/check-cleanroom.mjs`); every other field — amounts, addresses, chain ids, request/order
ids, step shapes — is the untouched real response. The adapter itself never relies on a ticker
string: it identifies the Solana asset only by its mint address
(`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, see `CIRCLE_USD_MINT` in
`packages/adapters/src/relay-client.mjs`), so the neutralized symbol values do not affect what the
tests actually verify.
