# Native mainnet test handoff

Status: preparation for review; no signable launch transaction is present. This handoff covers one complete cycle, followed by a second cycle only after the first is reconciled. The owner prioritizes functional evidence and will fund the wallets separately. The decision in `decisions/owner-approvals/mainnet-test-priority-20260908.json` defers proof that EUR 250 covers the complete process. It does not select a seed amount, increase transaction limits, change fees or authorize a signature.

The assisted-launch revision 0.1.2 is recorded in `decisions/assisted-launch-v012/README.md`. Its fixed economics supersede the earlier draft choices below. Launch time and optional initial purchase remain unset and are not preparation requirements.

## Review inputs

| Item | Bound value or present state |
| --- | --- |
| Chain | Robinhood, chain ID 4663; native ETH at 18 decimals |
| Launch wallet and treasury | `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729` |
| Operations | `0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384` |
| Programmable recipient | `0xD88539d3c4C460136a733A3Fd60cf6BF269079da` |
| Stock | Exactly 1 billion HKMN at 18 decimals, entirely allocated to the canonical market |
| Pool | Native ETH currency0, HKMN currency1; zero LP fee, spacing 60, inventory ticks 133500 through 161220 |
| Project fee | 300 bps inclusive: 250 process, 30 treasury, 20 Programmable; no additional surcharge. |
| Liquidity custody | Permanent position custody; the test provides no withdrawal route |
| Seed and process claim ceilings | Zero creator ETH; initial claim cap 9960873688152935270 wei, maximum 19921747376305870540 wei; 24 claims per six hours |
| Total test funding | Owner plans EUR 250; adequacy is deliberately unproven and measured after the test |

The 0.04 ETH seed and 0.02 ETH recycled float in `feasibility/native-funding/` are local experiment inputs, not selected wallet actions. Their 32 swaps reach one expired historical bridge principal. They do not prove two complete cycles, a fresh quote, a production slippage limit or sufficient gas. USD comparisons in that evidence use a historical ratio and are not an EUR conversion.

The EUR amount is a planned contribution, not a conversion of the earlier USD 250 spec envelope. The owner-approved revision must replace that earlier envelope before this draft becomes an executable test plan; ordinary per-action USD controls remain in force.

Signing or broadcasting requires separate owner authorization for the concrete transaction or bounded test scope, including its network, signer, operations and limits. Funding a wallet alone grants no transaction authority. This also applies to a second cycle.

## Preparation before wallet review

1. Finish the approved source and runtime commitments, reproduce all three predicted addresses and immutable runtime code, and bind the exact source revision, compiler, roles, PoolKey and provider graph. Hashing a supplied runtime record alone does not authenticate it.
2. Produce the complete provider request using verified official packing rules. Obtain exact-request admission of the separate native seed and inclusive fee model. Current public provider terms describe a different fee and funded-launch model; retain that difference until a concrete response resolves it.
3. Select explicit native seed and claim limits in the review candidate. After funding, measure available ETH, Solana USD Coin and SOL independently. Obtain fresh quotes, minimum pack requirements, transaction simulations, gas/rent reserves and deadlines for the next action. Complete-process affordability is not a prerequisite; the next action must still fit its own reviewed amount and reserve.
4. Present each unsigned transaction with chain, sender, recipient, calldata digest, native value, token approvals, maximum fees, expected state change and expiry. Missing fields remain unset. A preflight response never authorizes a signature or a create request.

## Launch and first cycle

| Step | Required result before continuing | Stop or recovery condition |
| --- | --- | --- |
| Deploy and initialize graph | Token, custody and hook match the reviewed addresses and code. Exactly `allocate`, `configureBindingHook`, then `initializeGraphLaunch` execute; graph native value is zero. | Any graph, role, code or pool mismatch stops seeding. |
| Separate payable seed | `msg.value == amount0Max`; full HKMN stock enters the pool; native debt/refund reconcile; the permanent custodian owns the exact LP position. | A reverted seed is inspected before retry; never broaden approvals or invent a compensating withdrawal. |
| Earn process fees | Bounded, separately simulated buys and sells reconcile actual acquired HKMN, native balances and accrued fee liabilities. | Stop at the configured gas/amount/slippage limit; no assumption that the local test's full-float buys are usable in a funded wallet. |
| Claim and outbound bridge | Authorized claim fits earned liability and wei ceilings; Relay quote and destination are fresh; source and finalized destination amounts are attributed to this cycle. | Unknown delivery remains uncertain. Reconcile the original request before another claim or bridge. |
| Collector purchase and reveal | Eligible pack, original instructions, payer, accounts and fees match the approved policy; actual card results are recorded. | Do not replace an ambiguous purchase or substitute a new transaction for an expired original. |
| Sale or held-card path | Record actual buyback acceptance and proceeds, or durable held custody under the defined policy. | A random held card is not fabricated into a sale and does not prove the complete cash return path. |
| Return and payout | Finalized return is attributed once; eligibility snapshot, recipient amounts, reserves and confirmed transfers reconcile. | Retry only through durable authorized recovery. Never re-sign or double-pay to escape an uncertain state. |
| Close cycle | Every external effect has a reconciled receipt; remaining ETH, USD Coin, SOL and cards are accounted for. | No second cycle while the first has unresolved effects or an unexplained balance difference. |

The second cycle uses fresh observations and a new audited cycle identity. It starts only after the first closes and the next action has enough funds and gas. If the first cycle exposes a defect, preserve its journal and transaction identifiers, fix the cause, run the affected regression and review, then resume only through the supported recovery path. Do not reset custody state to make a retry appear new.

## Evidence and cost record

Retain the source revision, package digest, chain/block observations, redacted provider responses, unsigned intent hashes, transaction IDs, actual balance deltas, fees, rent, acquired cards, sale proceeds, recipient transfers and stop reason. Track EUR contributions separately from ETH, USD Coin and SOL units. Recycled turnover and bridge principal are not additional capital contributions. Permanent liquidity is committed capital, and unrealized card value is not spendable balance.

Compare actual costs after the first cycle, then after the optional second cycle. Report any further funding needed from observed balances and the next concrete action. Keep `allInBudgetProven` false until a separate complete cost calculation establishes it.

The current machine-readable draft is `launch-inputs.json`; `feasibility/native-provider-admission/README.md` identifies exact missing provider fields and their official sources. Historical USDG documents under `docs/evidence/usdg-launch-preparation-20260907/` cannot authorize this native launch.
