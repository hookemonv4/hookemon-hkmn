# Phase 3 funding sheet

**Critical update (2026-09-06, H2):** while re-checking `agentAttestation`/`launchIntentHash`
against the *current* provider discovery document (`https://programmable.market/.well-known/programmable.json`,
fetched fresh, not from any cached/prior snapshot), the entire premise this sheet is priced against
may be stale. That document now reports, for chain 4663: `apiVersion: "4"`, `profileVersion:
"4.1.0"`, `publicAuthorization: true`, `publicWrites: true`, `releaseReady: true`,
`activationStage: "public-api-wallet-handoff"`, and a new OpenAPI at
`https://programmable.market/openapi/custom-launch-v4.1.json`. That v4.1 schema adds a new
**required** top-level `fundingPlan` field to `CustomLaunchCreateRequestV4` that does not exist in
our committed v4.0-pinned request/profile evidence (`release/phase3/admission/provider-documents.json`).
See `release/phase3/admission/findings.md` ("Resolved LIH-01") for the full evidence. This sheet's
dollar figures (Relay bridge/pack-purchase quotes) are still valid observations of their own
routes, but the *admission-side* funding requirements (what the provider's own `fundingPlan`
now demands) are **not priced here** and were not previously known to exist. Treat this sheet as
covering only the pack-purchase/bridge leg, not the full current provider admission funding
requirement, until a dedicated v4.1 compatibility review runs.

Read-only funding sheet for the Hookemon V4 launch package. No key, secret, signature,
transaction, or provider mutation was used to produce this sheet. All balances and quotes
below are the public snapshot recorded in `H-funding-observations.md` and
`H-sol-prep.md` (public RPC/API reads, `2026-09-05T22:59:38.247Z`–`2026-09-05T23:03:23.375Z`,
Robinhood block `55497461`, Solana finalized slot `444639767`). Figures are **not** re-measured
here; refresh every row from the same public methods immediately before any funding action.

The owner funding ceiling is **$250 total** (`H-brief.md`). The `$300` figure in
`decisions/owner-inputs/launch-inputs-owner.json:96-99` is stale and is not used as authority.
This sheet does not authorize spending; it itemizes requirements against the ceiling and states
the exact shortfall of the currently selected (stale) package.

## 1. Public wallets

| Address | Chain | Role | Native balance | Stable/token balance |
| --- | --- | --- | --- | --- |
| `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729` | Robinhood mainnet (4663) | launch authority, treasury beneficiary, metadata owner, seed payer/refund | `0` wei ETH | `446004` atomic USDG = `0.446004` USDG |
| `0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384` | Robinhood mainnet (4663) | operations wallet, bounded process-claim recipient, bridge principal payer | `0` wei ETH | `0` atomic USDG |
| `0x4957f49620AFf3Adbbe8195a4f633E49cc93376c` | Robinhood mainnet (4663) | immutable Programmable fee beneficiary | `0` wei ETH | `0` atomic USDG | not an owner-funded operating wallet; excluded from top-up rows |
| `BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE` | Solana mainnet-beta | Collector Crypt operator (buy/open/sell, return-leg custody) | `19920066` lamports = `0.019920066` SOL | `0` — no Solana USDC associated token account exists yet for mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Robinhood `eth_gasPrice` at the pinned block was `419666000` wei (`0.419666` gwei); base fee
`417376000` wei. Both EVM wallets need native ETH top-up before any transaction — a `0` balance
cannot pay even one call. Solana rent-exempt minimum for a legacy SPL token account is `1855569`
lamports; the operator balance covers rent plus one small return-leg fee but has not been proven
sufficient for the full pack/open/sell/return message set.

## 2. Itemized requirements (stale/current-candidate package)

Amounts are the raw quoted/measured units from the funding-observations snapshot; USD figures use
the quote's own USD value where one was returned, and are otherwise left `null` (never assumed
1:1). Do not add the Relay relayer fee separately — it is already inside the quoted input amount.

| Item | Wallet | Asset | Raw amount required | Raw existing balance | Raw deficit | USD (quoted, snapshot time) | Kind |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Canonical-market USDG seed (stale candidate `S = 240000000`) | Launch (`0xfc82…a729`) | USDG (6 dec) | `240000000` | `446004` | `239553996` | ≈ `$239.55` (USDG ≈ USD parity observed in the two-pack quote; not a fixed rate) | seed |
| Two-pack process principal (EXACT_OUTPUT, `2×25` Solana USDC to Solana operator) | Operations (`0xB54A…4384`) | USDG (6 dec) | `50309869` | `0` | `50309869` | `$50.299908` (Relay quote, `2026-09-05T23:03:23.375Z`) | process capital |
| Bridge approval + deposit gas envelope (max, two-pack quote) | Operations | ETH (native) | `92321815544000` wei = `0.000092321815544` ETH | `0` | full amount | `null` — needs a timestamped ETH/USD quote at execution time | gas |
| Programmable admission/launch, USDG-approval, seed-transaction, and factory/router gas | Launch | ETH (native) | `null` — bytecode/addresses unresolved (graph target addresses are not yet materialized) | `0` | `null` | `null` | gas |
| Solana pack/open/sell/return message set (rent + fees) | Solana operator | SOL | `null` — only the single rent figure (`1855569` lamports) and one return-leg gas estimate (`19274` lamports) are priced; the full lifecycle is not simulated | `19920066` lamports | `null`, but at least `0` beyond the priced subset | `null` | gas + rent |
| Solana USDC ATA creation (pack purchase leg), if not paid by the provider | Solana operator | SOL (rent) | `null` — unresolved whether Collector/Relay creates and pays for the missing ATA | n/a | `null` | `null` | rent |

## 3. Cap conservation — units are not fungible, so no blended dollar total is asserted

The prior version of this sheet summed a seed-deficit figure and the two-pack Relay quote into one
dollar total. That conflated two different things: the $50.299908 figure is a real, timestamped
Relay quote for a specific 50,309,869-atomic-USDG amount; applying that same implied rate to a
much larger, differently-sized seed amount is an extrapolation this sheet does not make. No
quote was ever taken for moving/seeding 240,000,000 atomic USDG, so no USD figure is stated for
the seed. The corrected accounting keeps every amount in its own native unit and only converts to
USD where a specific quote exists for that exact amount:

| Item | Raw amount | Native-unit deficit (after existing balance) | USD conversion available? |
| --- | ---: | ---: | --- |
| Canonical-market USDG seed (stale candidate `S = 240000000`) | `240000000` atomic USDG | `239553996` atomic USDG | **No** — no quote exists at this size; do not assume 1:1 |
| Two-pack process principal (EXACT_OUTPUT, Relay quote) | `50309869` atomic USDG | `50309869` atomic USDG | **Yes** — `$50.299908`, quoted `2026-09-05T23:03:23.375Z`, this exact amount only |
| Bridge approval + deposit gas envelope (max) | `92321815544000` wei | full amount (`0` ETH existing) | **No** — no ETH/USD quote was taken |
| Robinhood admission/deployment/seed/factory gas | unresolved | unresolved | **No** — bytecode/addresses not yet materialized |
| Solana pack/open/sell/return message set | unresolved beyond rent+one return-leg estimate | unresolved | **No** — full lifecycle not simulated |

Because most rows have no USD conversion, this sheet **cannot and does not** state a single blended
total against the $250 ceiling. What it can state precisely: the two-pack principal alone consumes
a confirmed `$50.299908` of the ceiling if owner-funded. Every other row is a real, non-zero
requirement whose USD size is currently unknown, not zero. No claim "the package fits $250" or
"the package exceeds $250 by $X" is made here beyond that single priced row, since asserting a
total would require inventing an exchange rate for the seed and a gas price for two unpriced
chains — exactly what this revision was told not to do.

No holder-payout reserve is included anywhere in this sheet, per the plan's separation of seed,
gas, process capital, treasury funds, and finalized holder proceeds.

## 4. Smaller feasible seed candidate — documented bounds actually available

Reselecting the seed `S` is a product decision (it changes pool depth/tick math and every
dependent manifest/allowance/refund artifact) and is out of this task's scope to choose
unilaterally. On a documented minimum: **no minimum-seed or minimum-liquidity constant is
committed anywhere in this repository's own contracts** (checked `RobinhoodBindings.sol`,
`HookemonHook.sol`, `CanonicalMarket.sol`, and `release/phase3/launch-inputs.json` — none define
one). Uniswap v4-core's own tick/liquidity-precision floor would set the real technical minimum,
but `packages/contracts/lib/v4-core` is an uninitialized submodule in this worktree (`git submodule
status` shows a `-` prefix), so that floor cannot be read and verified here rather than guessed.
This is a concrete, resolvable gap, not a decision: initialize the pinned `v4-core` submodule at
`46c6834698c48bc4a463a86d8420f4eb1d7f3b75` and read its `TickMath`/`LiquidityAmounts` minimum
liquidity behavior before fixing a floor for `S`.

What can be stated without inventing a number:

- Every atomic unit spent on `S` competes with gas and process-pack capital inside the same $250
  ceiling; there is no second budget.
- The two-pack principal is a confirmed $50.299908 draw on that ceiling if owner-funded, leaving at
  most $199.700092 of headroom for the seed plus every gas item — but since neither the seed's
  USD value nor most of the gas items have a real quote, this headroom number is an upper bound on
  what's left for unpriced items, not a proof that they fit.
- A one-pack-only first cycle would reduce the confirmed principal below $50.30, but the
  one-pack `EXACT_INPUT` probe in `H-funding-observations.md` did not deliver a full 25 Solana USDC
  pack (`minimum 24212666` atomic Solana USDC out); a fresh one-pack `EXACT_OUTPUT` quote is needed before that
  alternative has its own real number.
- Any smaller-seed or fewer-pack candidate still needs items 3–5 of the "exact focused
  verification prerequisites" in `H-sol-prep.md` priced (deployable-bytecode gas, decoded provider
  pack transaction, full Solana message-set simulation, and now also the v4.1 `fundingPlan`
  requirement noted above) before its total can be proven to fit $250.

**Approval needed from the owner before proceeding:** (a) the final seed `S`, to be fixed only
after the v4-core minimum-liquidity floor is read and a real USDG/USD quote is taken at that exact
size, (b) whether the first cycle targets one or two packs, (c) confirmation that the $50.30
two-pack principal (if kept) is owner top-up rather than an assumed-available process balance,
since the process account is currently `0` USDG/ETH at Operations, and (d) acknowledgement of the
v4.1 compatibility gap in the notice at the top of this document before any of these numbers are
used for a real funding action.

## 5. Unknown prior owner funding — tracked separately, not treated as free headroom

The launch wallet's existing `446004` atomic USDG and the Solana operator's existing `19920066`
lamports were already on those addresses at snapshot time; their origin (whether they were already
counted against the owner's lifetime $250 ceiling, or are fresh/uncounted) is **not established by
a public balance read**. Section 3/4 above treat them only as an offset against the amount that
would otherwise need to move (a real, mechanical reduction of what must be sent), not as
additional headroom inside the $250 cap. Before relying on any "remaining budget" figure, the
owner should confirm whether either existing balance was already funded from, and counted against,
the $250 ceiling this task was given.

## 6. Provenance and refresh requirement

Every raw balance/quote above must be re-read from the same public methods
(`eth_chainId`, `eth_getBalance`, ERC-20 `balanceOf` via `eth_call`, `eth_gasPrice`,
`getBalance`, `getTokenAccountsByOwner`, `getMinimumBalanceForRentExemption`, and a fresh
`POST /quote/v2`) immediately before any funding action; this sheet is a point-in-time snapshot,
not a live balance source. See `H-sol-prep.md` and `H-funding-observations.md` for exact
JSON-RPC/HTTP call records and source line references.
