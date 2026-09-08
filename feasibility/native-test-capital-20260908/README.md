# Native test capital: USD 250 component inventory

**No candidate is yet verified to fit the complete USD 250 limit.** The measured 0.04 ETH seed plus 0.02 ETH trading float can supply the newly quoted one-pack principal, but the actual acquisition price and complete independent transaction costs remain unknown. A conditional arithmetic subtotal is **USD 160.310569**, leaving **USD 89.689431** for every unmeasured addition. This is a scenario remainder, not an executable funding limit or a full-cost upper bound.

This evidence uses repository base `26f757b761e8d9ea349d21f24d47c863952619ed`, the existing real-contract `NativeFundingFeasibility` results (implementation `45a0d52f`), public Collector reads at 11:04:33 UTC and public RPC/Relay reads at 11:05:01 UTC on 2026-09-08. No Foundry suite was repeated. No production budget helper or parameter changed. There were no secret reads, signatures, transfers, contract deployments, purchases or generated Collector transactions.

## Minimum purchase and fresh scenario quotes

Across 28 public, unarchived catalog definitions, the lowest open single-card pack is `pokemon_25`, priced at 25 USDC; `/api/status` reports it open and the overall machine running. `/api/machines` independently lists its price, one-card contents, stock and advertised buyback percentage. Catalog listing and stock are observations, not a reserved pack or guarantee that a future purchase succeeds. No API credential was needed for these public observations; the documented authenticated integration contract remains unchanged.

The fresh exact-output Relay quote exchanges **10,214,270,236,945,073 wei** for **25,000,000 Solana USDC atoms**. The provider displays USD 25.326883 for the input and USD 24.997350 for the output. Their difference, USD 0.329533, is already inside the quoted principal. `fees.relayer`119,184,080,007,031 wei includes its gas and service subfields; adding these again would double-count. Origin transaction gas is separate: `fees.gas` estimates7,626,080,000,000 wei, while the actual returned transaction's gas 32713 times maxFeePerGas 346640000 wei gives11,339,634,320,000 wei. The conditional subtotal uses the latter reservation term, not both.

The return quote is an **independent 25 USDC scenario**, not projected card proceeds: output 10,037,839,882,384,134 wei, minimum 9,837,083,084,736,451 wei at the supplied2% destination slippage. Its65,126 USDC-atom relayer fee is included in the exchange; its200,000lamport origin-gas estimate is separate. No return value or assumed buyback funds an earlier action. A held card may produce no current return or payout; an insured value/advertised buyback percentage cannot substitute for a card-specific executable offer.

Both requests and responses are retained with UTC times, URLs and SHA256. They were fresh when collected and are scenario records now. No configured client quoteValidityMs or process valuation capability was established; a protocol order deadline is not a quote-validity window. Future admission must refetch and authenticate the exact amounts. The old08:22quote remains the historical target actually claimed in the contract test.

## Backwards capital calculation

The current scenario principal requires `ceil(10214270236945073 * 10000 / 250)` = **408,570,809,477,802,920 wei** cumulative gross executed native volume, starting from zero process remainder. One wei less fails the threshold. Its cumulative minimum fee streams are process 10,214,270,236,945,073 wei, treasury 1,634,283,237,911,211 wei and Programmable 408,570,809,477,802 wei: total **12,257,124,284,334,086 wei** diverted from trading float.

The already executed 32-swap scenario measured gross 415,128,299,471,828,390 wei and process 10,378,207,486,795,709 wei, exceeding the fresh principal by163,937,249,850,636 wei. Even its previously executed historical claim exceeds the new requirement by29,308,764,385,297 wei. This comparison does not claim that the test executed a new quote or a live bridge.

The pool permanently locks39,999,999,999,999,657 wei from the0.04 ETH seed maximum, with343 wei refunded. Initial reusable float is0.02 ETH. After32 swaps, the test reconciles pool 39,999,999,999,999,673 + trader 7,546,151,015,845,134 + all fee liabilities 12,453,848,984,154,850 + refund 343 = **60,000,000,000,000,000 wei**. These are measured local fee diversions; no live fee payment was made by this evidence task. The0.415128 ETH turnover is recycled, not new funding. Claimed process principal, bridge conversion and pack expenditure are successive uses of this same capital, not three extra USD 25 charges.

The current quote's input amount/USD ratio marks0.06 ETH at **USD 148.773525**, rounded up (seedUSD 99.182350, floatUSD 49.591175). It is a scenario conversion, not an acquisition quote or USD/USDC parity. The old ratio valued it atUSD 148.350000. Every buy used the entire modeled float and left zero trader balance temporarily; real trading therefore requires gas money separate from that float.

## Complete component inventory

| Component | Verified amount or measurement | USD 250 treatment and exact remaining measurement |
| --- | --- | --- |
| Permanent LP |0.04 ETH maximum; actual locked39,999,999,999,999,657 wei | Included once in initial0.06 ETH; permanently unavailable for gas or later packs. |
| Reusable trading float |0.02 ETH; measured32 swap path | Included once; turnover never added as capital. Production trade limits must reproduce an admissible path. |
| Process, treasury, Programmable fees | Local diversion12,453,848,984,154,850 wei | Already inside float; no additional surcharge assumed. Provider admission must preserve the agreed inclusive allocation. |
| Pack and outbound exchange overhead |25,000,000USDCatoms funded by quoted10,214,270,236,945,073 wei | Already within process principal; USD 0.329533 quote value difference is not added again. No extraUSD 25 budget charge. |
| ETH acquisition, bridge to4663, source-chain gas, spread | Unknown source asset/network and actual funding quote | Replace scenario capital mark with exact all-in cost to deliver native principal plus gas. Existing EVM roles are empty. No invented origin route. |
| Standalone token deployment | Local725,263 gas | Sensitivity only; final production envelope, intrinsic/calldata, cold state and rollup charges outstanding. |
| Hook deployment | Local6,412,849 gas | Same limitation; final admitted factory/deployment envelope outstanding. |
| Permanent custody deployment | Local666,212 gas | Same limitation; final graph may group calls differently, so avoid counting both component deployments and a full graph transaction. |
| Graph wiring / provider deployment | Local188,756 gas for wiring | Exact admitted graph receipt/unsigned simulation plus any provider service cost outstanding. No public-profile surcharge or atomic-buy alternative assumed authorized. |
| Router or executor setup | No production packet/cost supplied here | Identify whether existing deployed infrastructure suffices. If own deployment is required, measure its exact bytecode envelope; do not infer zero from local PoolSwapTest. |
| Payable seed | Local582,652 gas | Seed ETH included above; gas separate. Need independent payable seed transaction with actual calldata and state. |
| HKMN sale approval / Permit2 | Unknown for selected production router | Native buy needs no native-token approval, but token-sale allowance/setup may require transactions. Include only exact required approval/revocation sequence and measured gas. |
|32 swaps | Local5,892,831executiongas; additional672,000 gas is only32×21,000intrinsic floor | Complete independent transaction simulation, actual slippage limits and rollup data fees outstanding. Local execution plus floor is not a full bound. |
| Process claim | Local150,559 gas | Independent claim transaction plus intrinsic/calldata/rollup fees outstanding. Principal is already included above. |
| Outbound origin gas | Quote32713 gas ×346640000 wei maxFee =11,339,634,320,000 wei | Included in conditional subtotal as provider packet termUSD 0.028118; not an independently verified simulation/maximum for later state. |
| Solana funding and acquisition | Observed19,920,066 lamports already present | Whole observed SOL footprint markedUSD 2.057644 for conditional accounting; original acquisition cost, commitments and future needed reserve remain unknown. Not treated as free capital. |
| Solana USDC token account/rent | No ownerUSDCaccounts; RPC165 byte exemption1,855,569 lamports | Exact payer/account creation policy and current returned transaction needed. The byte-size quote is a conditional rent fact, not proof every required account has this size or that user pays it. Allocate from the SOL footprint once. |
| Collector purchase/open/buyback Solana fees | No generated transaction or card-specific offer | Obtain approved exact transaction/message, payer, signature count, compute budget and any account creation; use public fee/simulation reads. No generate/open/buyback call was made. |
| Return Solana source | Quote origin-gas estimate200,000 lamports | Within existingSOL footprint if available; not added a second time. Exact source message/finality fee and account costs remain unmeasured. Return principal and relayer fee are a deduction from actual future proceeds, never advance income. |
| Return EVM destination | Provider exchange quote includes relayer components | No separate user debit added by assumption. Verify exact destination payer and any required follow-up transaction before final cost bound. |
| Native holder payout | Recipient count and transfer envelopes not fixed | Need actual eligible snapshot, per-recipient gas (including forwarding recipients), batching rules and retry envelopes. No21,000 gas assumption for arbitrary recipients. |
| Failed attempts, refunds, retries, slippage reserve | No selected allowance or measured envelope | Derive from actual proposed transaction limits and allowed retries; no guessed percentage. Unspent reservation remains budgeted capital, consumed gas counted once. |

## Current balances and conditional subtotal

At EVM block 57640799 (`0x9183e847b7bbc37d0359beeb3f91ce544aa31f4d1b4b2e370da1b2f015bd8884`), launch/treasury`0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729` and Operations`0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384` each have0 wei and nonce 0. Latest network gas price was249,274,000 wei. The block is a pinned latest observation, not asserted finalized. Solana Operations`BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE` has19,920,066 lamports at finalizedslot 445322550; the adjacent finalizedslot 445322551 reports zero USDC token accounts. Coordinates do not establish current signing authority or uncommitted funds.

Applying that gas price to the existing14,619,122 local execution-gas units gives0.003644167017428 ETH, scenarioUSD 9.035927. The swap-only intrinsic floor addsUSD 0.415357. Combined rounding of these two ETH terms plus the outbound packet term givesUSD 9.479400. Adding capitalUSD 148.773525 and the entire observedSOL markUSD 2.057644 gives **USD 160.310569**. Whole-SOL inclusion is conservative bookkeeping for this scenario, not proof that its acquisition cost wasUSD 2.057644 or that the wallet's full balance is committed to this test. Fees/rent paid from that includedSOL must not be added again as new capital unless moreSOL is required.

The required backwards inequality is: actual acquisition-cost difference from the quoted capital/SOL marks, plus all missing independent EVM gas/rollup/router/approval costs, additional requiredSOL, payout/failure reserves and any not-yet-included provider cost must fit **USD 89.689431** under these provisional terms. Those missing terms are not known to be zero and the scenario price may change. There is therefore no verifiedUSD 250candidate. The decisive next measurements are the exact admitted graph and trade envelopes with gas/data-fee evidence, an actual acquisition route, and concrete Solana/payout transaction requirements; the scalar remainder alone cannot approve funding.

## Reproduction and sources

`python3 feasibility/native-test-capital-20260908/analyze.py` runs offline and regenerates `calculation.json` using integer rounding, the one-wei process threshold and measured conservation. `collect.py` performs only public read-only RPC calls and Relay scenario quotes; running it replaces the collection and requires re-reviewing the output. It does not query wallet secrets or submit transactions.

Sources: [Collector API contract](https://docs.collectorcrypt.com/gacha/api), [public catalog](https://gacha.collectorcrypt.com/api/gachas/all), [machine status](https://gacha.collectorcrypt.com/api/status), [machine definitions](https://gacha.collectorcrypt.com/api/machines), [Relay quote API](https://docs.relay.link/references/api/get-quote-v2), public RPC endpoints recorded in `collection-sources.json`, and the existing `../native-funding/` real-contract measurements. Raw request/response digests and timestamps are retained. Relay fee fields and the authenticated integration's quote TTL remain distinct from local scenario arithmetic.
