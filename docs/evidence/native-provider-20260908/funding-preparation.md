# Native fee-funding preparation

Qualified preparation for the USD 250 envelope, using the preserved 2026-09-08 Relay scenario. This is neither production pricing nor a completed funding test. It does not select a final or separate test deployment and gives no funding order. Exact derived integers and public balance responses are in `funding-preparation.json`.

## Required earned process principal

The preserved exact-output quote requests 25,000,000 Solana USDC atoms and requires **10,243,579,001,330,370 wei** of Robinhood ETH. This includes the quote's bridge economics; source transaction gas is separate. The response hash is `7b1b5a871f7db31b8ad708df47cdbdde73ba9c0905d25c55d69f96c90af03176`. Refresh the quote and provider candidate before any financial packet; a 25 USDC catalogue price alone does not prove all Collector admission, rent, account and transaction costs.

For a new pool with zero cumulative process remainder, preserved 250 bp accounting gives `earnedProcess = floor(grossExecutedWei * 250 / 10000)`. Therefore the exact minimum cumulative executed gross quote volume is `ceil(requiredProcessWei * 10000 / 250)`:

| Quantity | Wei |
| --- | ---: |
| Minimum cumulative gross executed ETH volume | 409,743,160,053,214,800 |
| Process, 250 bp | 10,243,579,001,330,370 |
| Treasury, 40 bp | 1,638,972,640,212,859 |
| Programmable, 10 bp | 409,743,160,053,214 |
| Total cumulative fee diversion | 12,292,294,801,596,443 |
| Other fee streams combined | 2,048,715,800,266,073 |

The gross bound is **0.4097431600532148 ETH**, not a requirement to contribute that much fresh owner capital. Capital can circulate through authenticated buys and sells. At one wei less gross volume the process allocation is one wei short. Each stream rounds cumulatively on its own; the sum is one wei below `floor(gross * 300 / 10000)` at this particular bound. Do not replace the actual stream sum with independently rounded per-swap fees. This derives from current `FeeAccounting._cumulativeIncrement`; it is conditional on the native implementation preserving that approved accounting.

For an existing process remainder `r`, additional desired earned principal `P` needs `max(0, ceil((10000*P-r)/250))` extra executed wei. Existing unclaimed principal can reduce the remaining need only if it is genuine attributed process fees and not owed elsewhere. A claim does not reset the remainder. The initial zero-remainder calculation avoids crediting an unverified existing pool, donation or Operations deposit.

At the historical quote's own displayed USD valuation, the gross-volume bound scales to about **USD 1,013.08996**, and fee diversion to about **USD 30.3926988**. These are scenario conversions, not an ETH acquisition quote. A hypothetical USD 150 capital allocation with USD 100 permanent seed and USD 50 trading float would have only about USD 19.6073012 of that initial float left after the minimum fee diversion, before gas, slippage and liquidity inventory effects. This arithmetic does not establish that the necessary swaps can execute with that float. The full production pool simulation must establish the path, capital trough and permanent custody effects.

Process principal is part of the total fee diversion and already part of owner capital; do not charge it a second time. Treasury and platform liabilities are also inside that diversion. They remain unavailable to the trading float until an authorized actual settlement permits their use. Future buyback or return proceeds cannot pre-fund earlier actions. A held epic card leaves inventory and an unfinished cash cycle rather than a guaranteed return.

## What the historical USDG model establishes

`docs/evidence/process-funding-model/report.md` and `packages/contracts/test/feasibility/OwnerCapital.t.sol` establish a conditional finite-liquidity example with USDG test tokens, real pinned PoolManager and production callback/accounting. Starting from 150 USDG, with 100 seeded and 50 trading float, 32 swaps produced 1,037.820588 USDG gross volume and 25.945514 process principal. Only tokens acquired by preceding buys were sold. The final 18.865368 trader + 100.000016 pool + 31.134616 hook balance conserved the original 150 USDG.

This shows how repeated real swap fees can finance the supplied historical one-pack principal without counting volume as fresh capital. It does not prove that native decimals, native settlement, payable seed/refund, the actual token allocation, production hook/router, process claim, native bridge, holder payout or the new quote work. Native ETH is not a mechanical one-dollar USDG replacement. The model was not rerun here because it would not supply the missing production-native evidence.

The old 5,700,508 gas figure measured swaps inside one Forge transaction and added intrinsic gas arithmetically. It excludes separate-transaction cold accesses, original SSTORE effects, calldata and many operations, so cannot cap mainnet costs. The old 150*p + E*q + C formula also separated USDG acquisition from ETH gas; a native plan must instead reconcile all ETH capital and gas together at an actual acquisition price, without retaining a second USDG funding term.

## Evidence needed to prove the USD 250 envelope

1. **Release and seed:** admitted exact provider graph and fee agreement; final-versus-test decision; exact deployed bytecode and transaction envelopes; full HKMN allocation, native seed in wei, range, liquidity, initial price, refund target, permanent custody and seed debt. A small real seed changes the final public market if the final deployment is chosen. The current public profile's atomic minimum initial buy must be reconciled with the agreed separate seed route, not silently added to a different sequence.
2. **Separate production swaps:** run the selected buy/sell sequence as separate transactions against the actual native graph and pinned manager/router. Record actual executed gross wei, fees and cumulative remainders, amount limits, slippage, holder effects, each transaction's gas/calldata and the minimum available owner/trader balance. Stop only when genuine claimable process principal covers the exact current outbound requirement. Require the full sequence to stay within the initial owner capital; do not fund its shortfall with an unrelated process deposit.
3. **Deployment, seed and claim gas:** estimate/simulate each exact transaction separately, with native value distinguished from gas and any rollup data fee. Include deployment graph, initialization/seed, any HKMN allowance actually needed by the final route, process claim and recovery attempts. Bind caps to the unsigned bytes, chain, nonce policy and current fee conditions; do not reuse warm Forge totals.
4. **Bridge and Collector:** refresh the exact-output outbound quote, inspect the candidate pack's full Solana instructions, token accounts, fee payer, signatures, rent and SOL reserve. The preserved outbound `gas * maxFeePerGas` is 11,959,701,488,000 wei, while its API gas estimate is 8,023,708,000,000 wei; neither alone proves an all-in final transaction cap or data-fee treatment. The return scenario has an unsupported lookup table and hypothetical proceeds. Resolve its transaction policy and actual post-buyback amount before it becomes signable. Do not double count aggregate relayer fees and their components.
5. **Holder and failure costs:** freeze the eligible finalized holder snapshot and exact recipients/entitlements. Simulate native distribution, record per-recipient gas, rejecting-recipient liability and failed-gas reserve, dust, late/supplementary settlement and expected transaction count. Include quote expiry, refund costs, reverted seed/swap/claim allowances and pending liabilities in the reserve. No assumed fixed holder count or automatic retry is evidenced here.
6. **Owner funding reconciliation:** revalidate historical wallet roles and chain balances, actual ETH acquisition/bridge quote including its fees, Solana SOL/USDC availability, all capital already committed, and the maximum additional external funding. Count each external contribution once and each recycled leg zero additional times. Reconcile conservation across remaining owner ETH, permanent liquidity, fees/liabilities, held cards, pending returns, paid holders and consumed gas/provider costs. Require total committed owner capital and costs at bounded acquisition prices to remain at or below USD 250 before irreversible actions.

The public Robinhood RPC returned **zero native balance** for both historical Treasury `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729` and Operations `0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384` at `latest`, observed 08:29:27 UTC. These are public observations, not ownership checks, finalized balances, liabilities audits or funding instructions. They do not establish balances on other chains or in Solana. The preserved quote's `userBalance` is not substituted for this read.

OPEN FACT: the complete native test's capital and separate-transaction cost bound. The concrete next self-serve step is the production-native separate-transaction rehearsal after its contract/interface baseline is ready, with the current quote requirement above as the earned-fee target. The closest verified result remains the historical USDG finite-liquidity proof plus this exact native accounting lower bound. Independent implementation and unsigned packet preparation can proceed; a USD 250 feasibility claim cannot yet be made.

Validation here used integer arithmetic to check that the reported minimum meets the required principal, one wei less fails, and all three cumulative streams conserve the reported fee diversion. No new budget helper, runtime code, Forge test, provider transaction or wallet action was introduced.
