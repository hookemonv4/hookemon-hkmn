# Relay Bridge Client

## Purpose

`packages/adapters/src/relay-client.mjs` is the clean-room provider adapter for Relay's
cross-chain bridge (`https://api.relay.link`), covering both legs the peg cycle needs: OUTBOUND
(Robinhood Chain 4663 USDG -> Solana 792703809 stablecoin) and RETURN (Solana stablecoin ->
Robinhood Chain USDG). The Solana asset identity is the configured mint address
(`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` in the recorded fixture), never a ticker
string. It performs real, read-only network calls for quoting and status/detail reads; it never
signs or broadcasts anything itself. A Relay status response does not bind a submitted intent to
source and destination transactions, so it is provider evidence only. The money-moving stage
persists one `RelayLegV1` for each outbound or return leg before signing and refuses settlement
until both finalized deltas are observed by this process's own RPC clients and attributed to that
record.

## Public interface

- `createRelayClient({ baseUrl, apiKey, fetchImpl, timeoutMs })` — returns a client with:
  - `getChains()` — `GET /chains`, always allowed.
  - `quote`, `quoteOutboundBridge`, `quoteReturnBridge` — `POST /quote/v2`; always checks
    `assertRouteEnabled` first (chain-level `depositEnabled` plus per-currency
    `supportsBridging`/presence in `erc20Currencies`/`solverCurrencies`) and never calls `/quote/v2`
    when that check fails. The configured Solana mint overrides only the Solana leg;
    USDG remains fixed on chain 4663. Returns a typed `QuoteResult` (`requestId`, `orderId`,
    `origin`/`destination` `{chainId, address, decimals, amount, minimumAmount}`, sender,
    recipient, order deadline, and `raw`).
  - `simulateExecution({ quote })` — always allowed; a structured "would execute" record, no state
    change, no intent registration.
  - `prepareExecution({ quote, liveMode })` — throws `RelayLiveModeRequiredError` unless
    `liveMode === true`; on success, registers the intent (keyed by `requestId`) for later
    authentication and returns `{ intentDigest, orderId, steps, intent }`. `intent` is the
    serializable `hookemon.relay-intent.v1` record that the cycle journal must retain. The record
    includes both asset identifiers and decimals, amounts, route identities, and deadline.
  - `restoreIntent({ intent })` — validates that serialized record and restores it into a fresh
    client instance before status reconciliation. A conflicting record for the same request ID is
    rejected.
  - `getIntentStatus({ intentDigest })` — `GET /intents/status/v3`; throws
    `RelayUnknownIntentError` for a digest this client instance never submitted via
    `prepareExecution`, and `RelayIntentAuthenticationError` if the response's `originChainId`/
    `destinationChainId` disagree with what was recorded at submission. The endpoint does not echo
    the request or order identifier; any generic transaction hashes it returns are unbound provider
    hints, not cycle settlement evidence.
  - `getIntentDetail({ intentDigest })` — `GET /requests/v3`; requires a configured `apiKey`
    (throws `RelayCredentialsRequiredError` otherwise — this endpoint needs a Relay API key the
    project does not currently have, see Recovery pointers). Parses `data.route.quoted`/
    `data.route.actual` (the quote-vs-execution amounts) and `data.refundCurrencyData.amount` (the
    exact refund figure).
  - `getTerminalDestinationTransactionPointer({ intentDigest })` returns the authenticated terminal
    destination transaction-hash pointer from Relay. It is a pointer only, never settlement
    evidence; return reconciliation still verifies the destination receipt through this process's
    Robinhood RPC client.
  - `getTerminalOriginRefundTransactionPointer({ intentDigest })` returns the authenticated origin
    refund transaction-hash pointer only for an OUTBOUND `REFUND` status. It is a locator for a
    separate finalized Robinhood RPC receipt read, never refund evidence on its own.
  - `reconcile({ intentDigest, statusResult?, detailResult? })` — fetches whatever of
    status/detail was not supplied, then calls `reconcileIntentOutcome`. Its result is a Relay-side
    classification and cannot complete an outbound or return stage.
- Standalone pure functions (no network, usable directly on recorded fixtures):
  `parseQuoteResponse`, `parseIntentStatusResponse`, `parseIntentDetailResponse`,
  `assertRouteEnabled`, `assertQuoteUsable`, `reconcileIntentOutcome`.
- Typed errors: `RelayNetworkError`, `RelayApiError`, `RelayMalformedResponseError`,
  `RelayRouteNotEnabledError`, `RelayLiveModeRequiredError`, `RelayUnknownIntentError`,
  `RelayIntentAuthenticationError`, `RelayQuoteExpiredError`, `RelayCredentialsRequiredError` — every failure mode names
  itself; nothing falls through to a generic `Error` a caller could mistake for a different
  failure, and nothing throws in a way that leaves the caller able to infer the bridge succeeded.
- `RECONCILE_OUTCOME` — `FILLED_AS_QUOTED`, `FILLED_WITH_SHORTFALL`, `FILLED_WITH_SURPLUS`,
  `REFUNDED`, `FAILED_NO_FUNDS_MOVED`, `AMOUNT_UNCONFIRMED`, `PENDING`, `UNKNOWN`.
- `RelayLegV1` persists `cycleId`, `direction` (`outbound` or `return`),
  `relayRequestId`, `quoteDigest`, typed source and destination chain, transaction, asset, and
  amount fields, `finalizedAtSource`, `finalizedAtDestination`, and destination-unit
  `netDeltaAtomic`. It is a repository record, not a Relay response. For an outbound leg, the
  durable recovery context beside the signed source bytes also retains the quote deadline as
  `relayQuoteDeadlineUnixSeconds`, the validated `hookemon.relay-intent.v1`, and a persisted route
  tuple of EVM sender, EVM depository, and destination owner. Reconciliation never reads either
  boundary or route identity from a live quote.
- `ReturnLegDestinationProofV1` binds a terminal Relay pointer to the process-observed finalized
  Solana source transaction and Robinhood destination receipt. `SETTLED` requires that receipt to
  contain exactly one configured USDG Transfer to Operations for the quoted destination amount and
  a block timestamp inside the persisted settlement window. Other finalized transfer observations
  are retained only for their named terminal hold. Each source or destination hash reserves
  globally in the same durable attribution or settlement path before custody is attributed.

## Invariants

- Every amount this module reads or emits is a canonical unsigned decimal integer string
  (`^(?:0|[1-9][0-9]*)$`), converted to `BigInt` only for comparison; a malformed amount from
  Relay is a hard `RelayMalformedResponseError`, never coerced.
- `assertRouteEnabled` is checked before every quote, for both currencies and both chains, using
  only fields independently re-verified against the live API on 2026-09-02 (see the module's
  header comment for the exact evidence per endpoint); a quote is never trusted without it passing
  first.
- `getIntentStatus`/`getIntentDetail` only ever answer for a digest this exact client instance
  produced via `prepareExecution` or restored through `restoreIntent`; a caller-supplied digest
  that lacks that validated record, or a response whose chain ids disagree with the submission, is
  always rejected.
- EVM addresses compare case-insensitively; every non-EVM address, including a Solana mint or
  recipient, compares byte-exactly. A quote is bound to the requested sender, recipient, exact
  input and output assets and amounts, order ID, and deadline before it is returned. It must have
  exactly one input and output; refund entries may return only the origin asset to the sender or
  the destination asset to the recipient.
- Before a Relay request reaches a signer, its source and destination asset identities and decimal
  precisions must match `MoneyConfigurationV1`. Quote metadata cannot introduce a different Solana
  precision or an implicit money minimum.
- `assertQuoteUsable` rejects at the exact recorded order deadline. A caller that needs a new
  quote must retain the same cycle reserve and request a new intent; it must not silently reuse an
  expired one.
- A Relay `SUCCESS` status is never assumed to mean "delivered exactly as quoted": without
  executed-amount evidence from `getIntentDetail` (which requires an API key this project may not
  have configured), the outcome is honestly `AMOUNT_UNCONFIRMED`, not `FILLED_AS_QUOTED`.
- A Relay status, quote order identifier, or generic transaction hash never proves that the source
  transfer and destination receipt belong to this cycle. A chain-specific source or destination
  transaction identifier can attribute to exactly one `RelayLegV1` across every cycle and direction.
  That uniqueness uses one permanent global reservation for each source or destination hash, staged
  with its own durable attribution or settlement event. For an outbound
  leg, a chain-4663 hash must be a 32-byte EVM transaction hash and is stored and compared in lower
  case; a Solana signature remains byte-exact. Reservation keys include the chain ID, so no EVM hash
  normalization changes a Solana signature. The outbound source proof must bind the persisted route
  sender and depository, and its destination observation must bind the persisted destination owner.
  `SETTLED` requires this process to observe the exact finalized EVM debit and Solana credit through
  its own RPC clients. The repository accepts only opaque runtime evidence capabilities issued by
  those readers, which are never serializable or reconstructible from caller fields. The source
  proof must carry its canonical block timestamp; the destination transaction's canonical block
  time must be at or after that timestamp and no later than the persisted signed-quote deadline.
  Its Solana memo must equal the recorded `relayRequestId`, and its mint and net credit must exactly
  match the recorded destination amount. Missing timestamp, memo, amount, or asset evidence leaves
  the leg unsettled.
- An outbound `HELD_RELAY_REFUND` requires a request-bound OUTBOUND `REFUND` pointer plus one
  finalized origin-chain USDG Transfer from the persisted EVM depository to Operations observed
  through this process's Robinhood RPC client. The refund transfer must be positive, no larger than
  the attributed source amount, and occur no earlier than source finality. A missing credit or
  multiple matching credits leaves the leg `RECORDED`. A Solana owner delta, including a debit,
  neither proves nor disproves that origin-chain refund evidence.
- Outbound funds come only from that cycle's claimed principal. A return leg bridges only that
  cycle's attributed proceeds delta. A partial finality, refund, late result, or wrong destination
  asset is terminal in `HELD_RELAY_PARTIAL`, `HELD_RELAY_REFUND`, `HELD_RELAY_LATE`, or
  `HELD_RELAY_WRONG_ASSET` respectively; Relay-side classification never overrides those states.
- `degradedCandidate` is `true` exactly for `FILLED_WITH_SHORTFALL` and a nonzero `REFUNDED`;
  `terminalFailureCandidate` is `true` exactly for `FAILED_NO_FUNDS_MOVED` and an exact-zero
  `REFUNDED`. The two are mutually exclusive on every outcome.
- **This module never determines on-chain truth.** The peg cycle vault's live escrow balance
  (design.md §2.4 step 8) is the actual finalized fact for `recordDegradedReturn`/
  `recordTerminalFailure`; this adapter's reconciliation is the Relay-side evidence an
  orchestration layer and the vault authorizer's off-chain confirmation step consume alongside
  that on-chain read — it is a strong recommendation input, not a direct contract call.
- `prepareExecution` never signs or broadcasts; it only releases the unsigned `steps` Relay's own
  quote response already carries, gated on `liveMode: true` with no default that admits a live
  submission by accident.
- Each live Relay source step uses the repository's combined signing write: `SIGNED` bytes and hash,
  policy, approval, approved-semantics, signed-message, and fencing-token recovery authority, and
  the applicable source-hash reservation enter one durable append. A restart reauthorizes and
  rebroadcasts those exact bytes or remains unresolved; it never creates a second signature.
- The general chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal, and
  approval-digest fields are unavailable. The combined Relay record supplies recovery fields for
  these routes; it does not retrofit those fields onto every ordinary v1 attempt.
- Once a Relay source attempt is durably `FINALIZED`, its chain-local wallet nonce reservation can
  release without marking the Relay leg settled. Destination finality and request attribution stay
  mandatory settlement evidence.
- A signed return additionally retains its Solana `blockhashLastValidHeight`. It may reauthorize
  the exact raw bytes only before that height. Address-lookup-table-bearing return plans fail
  closed; the supported legacy path is decoded and allowlisted before the Operations signer sees
  it.
- A return destination pointer never proves settlement by itself. Payout receives a return delta
  only after the exact `ReturnLegDestinationProofV1` writes `SETTLED`, its custody ledger, and the
  destination-hash reservation in the same repository settlement append. A wrong amount, late
  receipt, or wrong token or recipient writes its named terminal hold instead.

## State transitions

1. `quote`/`quoteOutboundBridge`/`quoteReturnBridge` → `assertRouteEnabled` (via a fresh
   `GET /chains`) → `POST /quote/v2` → `QuoteResult`. Always allowed, dry-run or live.
2. `QuoteResult` → `simulateExecution` (dry-run, no state change) **or** `prepareExecution`
   (`liveMode: true` only) → a serializable validated intent is registered by `requestId`, and
   the raw `steps` are released to the caller. After restart, `restoreIntent` restores exactly that
   intent before any status request.
3. Once a caller observes a broadcast or timeout, `getIntentStatus` polls
   `GET /intents/status/v3` for a provider status authenticated only to the registered chain pair.
   It cannot advance a money-moving stage.
4. When a Relay API key is configured, `getIntentDetail` reads `GET /requests/v3` for quote-vs-
   actual amounts and/or a refund amount. It still does not authenticate source and destination
   transaction identities for a cycle.
5. `reconcileIntentOutcome` (pure) combines the registered submission with status (and detail, when
   available) into one typed provider outcome. The stage layer must hold until its separate
   canonical chain and global reuse evidence is complete.
6. The stage persists `RelayLegV1` before a money-moving leg and records source and
   destination finality independently. No Relay status transition can change a leg to `SETTLED`.
7. An outbound leg reaches `SETTLED` only after the own-RPC source debit and destination credit
   are exact, the canonical destination block time is within the persisted interval from source
   timestamp through quote deadline, and the destination memo equals the recorded request ID.
   Positive partial, late, and wrong-asset observations enter their named terminal recovery state
   and wait for an idempotent owner decision.
8. An outbound refund enters `HELD_RELAY_REFUND` only after a restored durable intent authenticates
   the Relay refund pointer and the process-observed Robinhood receipt proves one origin USDG
   credit from its persisted depository to Operations. A destination-side debit cannot enter that
   state.
9. A return leg reaches `SETTLED` only after its authenticated Relay pointer, finalized source
   transaction, and finalized Robinhood receipt satisfy `ReturnLegDestinationProofV1`. Its net
   destination delta, custody ledger, and destination-hash reservation are committed together
   before payout can be prepared.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test packages/adapters/test/relay-client.test.mjs
node --test packages/adapters/test/app/outbound.test.mjs packages/adapters/test/app/return.test.mjs
# Separate, non-blocking, real network call — never part of the required CI gate:
node packages/adapters/test/relay-client.live-chains.mjs
```

## Recovery pointers

- Follow the incident procedures for a [lost response](../runbooks/relay-delay.md), an
  [expired quote](../runbooks/relay-quote-expired.md), or a pre-broadcast
  [wrong asset](../runbooks/relay-wrong-asset.md) before any retry or reconciliation. Each linked
  recovery contract records the supported resume command or its absence.
- A finalized Relay leg holds in its own named terminal state: [partial finality](../runbooks/relay-partial.md),
  [refund finality](../runbooks/relay-refund.md), [late finality](../runbooks/relay-late.md), or
  [wrong-asset finality](../runbooks/relay-wrong-asset-finalized.md). Each retains the complete
  `RelayLegV1` and both own-RPC observations and records the matching `HELD_RELAY_*` state pending
  an idempotent owner decision.
- `getIntentDetail` fails closed with `RelayCredentialsRequiredError` until a Relay API key is
  configured for the client (`createRelayClient({ apiKey })`); this is a recorded external-readiness
  blocker (`product/SOURCE_BOUNDARY.md`, design.md §12 "Blocked on live credentials"), not a bug —
  do not work around it by parsing amounts out of `getIntentStatus`, which never carries one
  (independently confirmed live and against Relay's published OpenAPI schema).
- If Relay ever adds an amount field to `GET /intents/status/v3`, or the `/requests/v3` response
  shape changes, `parseIntentStatusResponse`/`parseIntentDetailResponse` are the two functions to
  update; `reconcileIntentOutcome`'s outcome/degraded-candidate logic should not need to change.
- A `RelayApiError` carries Relay's own `errorCode`/`message`/`httpStatus`; a `RelayNetworkError`
  carries the underlying `cause`. Neither is retried inside this module. Provider status is never
  settlement on its own: the stage records no custody change until its own RPC observations satisfy
  the persisted leg's source, destination, and attribution checks.
- If either chain observation or destination attribution is unavailable, retain the Relay leg and
  its durable chain attempts for reconciliation. Do not substitute generic hashes from a Relay
  status response, request a new signature, or start payout from provider evidence.
- When a terminal Relay pointer, source finality, or process-RPC destination receipt is absent,
  retain the leg `RECORDED` and do not attribute custody or start payout. A duplicate source or
  destination hash remains rejected across every cycle.
