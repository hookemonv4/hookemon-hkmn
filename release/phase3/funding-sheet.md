# Phase 3 funding sheet

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
| `BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE` | Solana mainnet-beta | Collector Crypt operator (buy/open/sell, return-leg custody) | `19920066` lamports = `0.019920066` SOL | `0` — no USDC associated token account exists yet for mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

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
| Two-pack process principal (EXACT_OUTPUT, `2×25` USDC to Solana operator) | Operations (`0xB54A…4384`) | USDG (6 dec) | `50309869` | `0` | `50309869` | `$50.299908` (Relay quote, `2026-09-05T23:03:23.375Z`) | process capital |
| Bridge approval + deposit gas envelope (max, two-pack quote) | Operations | ETH (native) | `92321815544000` wei = `0.000092321815544` ETH | `0` | full amount | `null` — needs a timestamped ETH/USD quote at execution time | gas |
| Programmable admission/launch, USDG-approval, seed-transaction, and factory/router gas | Launch | ETH (native) | `null` — bytecode/addresses unresolved (graph target addresses are not yet materialized) | `0` | `null` | `null` | gas |
| Solana pack/open/sell/return message set (rent + fees) | Solana operator | SOL | `null` — only the single rent figure (`1855569` lamports) and one return-leg gas estimate (`19274` lamports) are priced; the full lifecycle is not simulated | `19920066` lamports | `null`, but at least `0` beyond the priced subset | `null` | gas + rent |
| Solana USDC ATA creation (pack purchase leg), if not paid by the provider | Solana operator | SOL (rent) | `null` — unresolved whether Collector/Relay creates and pays for the missing ATA | n/a | `null` | `null` | rent |

## 3. Cap conservation — current package does not fit

Summing only the two dollar-quoted rows above (seed deficit + two-pack principal, both already
converted at snapshot-time quotes):

```
239.553996 (seed deficit, quoted parity) + 50.299908 (two-pack principal, Relay quote) = 289.853904
```

This **exceeds the $250 ceiling by at least $39.85**, before any of the following unpriced items
are added: Robinhood bridge/approval gas (`≈0.0000923 ETH`), Robinhood admission/deployment/seed
gas (unresolved — bytecode/addresses not yet materialized), and the unsimulated Solana
pack/open/sell/return message set. The true shortfall is therefore **at least $39.85 and likely
larger** once those items are priced. The stale `240000000`-atomic seed selection from
`release/phase3/launch-inputs.json` cannot be combined with an owner-funded two-pack launch under
the current $250 ceiling; this restates the counterfactual in `H-sol-prep.md` with the same
numbers, it does not re-derive new prices.

No holder-payout reserve is included anywhere in this sheet, per the plan's separation of seed,
gas, process capital, treasury funds, and finalized holder proceeds.

## 4. Smaller feasible candidate (for owner decision, not a decision made here)

Reselecting the seed `S` is a product decision (it changes pool depth/tick math and every
dependent manifest/allowance/refund artifact) and is out of this task's scope to choose
unilaterally. What can be stated deterministically:

- Every dollar spent on `S` competes directly with gas and process-pack capital inside the same
  $250 ceiling; there is no second budget.
- With the two-pack principal (`$50.30`) and a conservative combined-gas placeholder budget of
  `$10` (Robinhood bridge/admission/seed gas plus Solana runway — still unpriced, so treat this as
  a lower bound, not a quote), at most **≈ `$189.70`** of the ceiling remains available for the
  seed deficit, i.e. a seed of roughly **`S ≤ 190,146,004` atomic USDG (~190.15 USDG)** after
  crediting the launch wallet's existing `446004` atomic USDG — versus the stale `240000000`
  candidate.
- A one-pack-only first cycle instead of two would free the difference between the two-pack quote
  (`$50.30`) and a one-pack quote; the one-pack `EXACT_INPUT` probe in `H-funding-observations.md`
  did not deliver a full 25-USDC pack (`minimum 24212666` atomic USDC out), so a one-pack
  `EXACT_OUTPUT` quote must be re-run before this alternative can be priced.
- Any smaller-seed or fewer-pack candidate still needs items 3–5 of the "exact focused
  verification prerequisites" in `H-sol-prep.md` priced (deployable-bytecode gas, decoded provider
  pack transaction, full Solana message-set simulation) before its total can be proven to fit
  $250.

**Approval needed from the owner before proceeding:** (a) the final seed `S` (bounded above by the
arithmetic in this section, not fixed by this sheet), (b) whether the first cycle targets one or
two packs, and (c) confirmation that the $50.30 two-pack principal (if kept) is owner top-up
rather than an assumed-available process balance, since the process account is currently `0`
USDG/ETH at Operations.

## 5. Provenance and refresh requirement

Every raw balance/quote above must be re-read from the same public methods
(`eth_chainId`, `eth_getBalance`, ERC-20 `balanceOf` via `eth_call`, `eth_gasPrice`,
`getBalance`, `getTokenAccountsByOwner`, `getMinimumBalanceForRentExemption`, and a fresh
`POST /quote/v2`) immediately before any funding action; this sheet is a point-in-time snapshot,
not a live balance source. See `H-sol-prep.md` and `H-funding-observations.md` for exact
JSON-RPC/HTTP call records and source line references.
