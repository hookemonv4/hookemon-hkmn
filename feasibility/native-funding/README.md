# Native funding feasibility

The actual native Hookemon contracts can earn and claim the preserved one-pack bridge principal using a bounded recycled trading float. **This is a partial local feasibility result, not a complete USD 250 funding pass, a selected funding allocation, or permission to deploy.**

The historical Relay exact-output response captured at 2026-09-08 08:22:02 UTC requires **0.010243579001330370 ETH** for **25,000,000 Solana USDC atoms** and displays USD 25.327249 for that input. Its SHA-256 is `7b1b5a871f7db31b8ad708df47cdbdde73ba9c0905d25c55d69f96c90af03176`. The quote is expired; no signature or live quote capability survives here. `scenario-source.json` identifies the immutable source commit and response. The displayed ratio gives exactly USD 2,472.50 per ETH for these synthetic comparisons. It is not an acquisition quote, a current oracle, or an assertion that USDC equals USD.

## Actual contract experiment

`packages/contracts/test/native/NativeFundingFeasibility.t.sol` deploys the production `HookemonHook`, standalone fixed-supply `HKMNToken`, permanent position custody, and the pinned real PoolManager and PositionManager with Permit2. The canonical pool contains native currency zero and HKMN. Test addresses and binding digests are synthetic; the test does not authenticate or deploy a live Programmable graph. The pinned PoolSwapTest is the local swap driver, not proof of a production router packet.

The complete 1 billion HKMN stock enters the pool through graph initialization and the payable production seed entry point. The permanent custodian owns the PositionManager NFT. The seed candidate is derived by the existing release math helper and independently checked by actual settlement: 0.04 ETH maximum, **0.039999999999999657 ETH actual debt**, and **343 wei refunded**. No seed value becomes fee liability. No extra HKMN is minted or supplied to the trader.

Each round buys with the available trading float, then sells only HKMN acquired by that buy. Swaps use separate external calls and actual fee callbacks. The test sums gross executed native amounts from Hookemon's emitted accounting events, checks cumulative 250 bp process allocation, checks solvency, and reconciles native capital after every completed round. The event's inherited field name is historical; the executed quote currency in this test is native ETH. Synthetic swap price limits span the valid pool range; no production slippage envelope has been established.

| Synthetic alternative | Seed maximum | Initial float | Swaps | Gross executed ETH | Earned process ETH | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Smaller float | 0.04 ETH | 0.01 ETH | 256 | 0.333196420954146554 | 0.008329910523853663 | Historical principal not reached |
| Medium float | 0.04 ETH | 0.02 ETH | 32 | 0.415128299471828390 | 0.010378207486795709 | Exact historical principal claimed |
| Larger float | 0.04 ETH | 0.04 ETH | 14 | 0.462884963385856451 | 0.011572124084646411 | Exact historical principal claimed |

The two successful paths call production `claimProcess` once and transfer exactly 10,243,579,001,330,370 wei to the Operations fixture. The configured single-claim limits match only this historical test target. Neither bridge execution, Collector acquisition, sale, held-card valuation, return, nor holder payout is fabricated.

The medium case ends trading with 0.007546151015845134 ETH, retains 0.039999999999999673 ETH in the pool, and has accrued 0.012453848984154850 ETH in total fee liabilities. Together with the 343-wei refund these equal the original **0.06 ETH** exactly. After the claim, the same total is split between the pool, trader, refund, remaining hook liabilities and Operations. The 0.415128299471828390 ETH turnover is recycled capital and is never added to funding.

All buys temporarily use the full modeled trading float: **minimum trader balance after a buy is zero**. Consequently the scenario requires a separately reserved and funded gas amount in a real wallet, or a smaller trade schedule. Gas is not debited from ETH balances by this Forge test. No gas reserve is silently assumed inside the reported float, and no current executable funding packet is implied.

## Backward bound and USD 250 accounting

Starting at zero process remainder, the exact gross lower bound is `ceil(10,243,579,001,330,370 * 10000 / 250)` = **409,743,160,053,214,800 wei**. One wei less is insufficient. At this lower bound the cumulative fee streams are:

- Process: 10,243,579,001,330,370 wei.
- Treasury: 1,638,972,640,212,859 wei.
- Programmable: 409,743,160,053,214 wei.
- Total: **12,292,294,801,596,443 wei**.

The 0.01 ETH float is below this unavoidable fee diversion. Under the tested closed buy/sell route, the permanent pool never returns seeded capital; even the ideal fee lower bound exceeds that float. The test's bounded 256 swaps confirm failure without claiming they are a useful operating strategy.

| Synthetic starting capital | Historical ratio value, rounded up | Unallocated room under USD 250 for every additional cost |
| --- | ---: | ---: |
| 0.05 ETH | USD 123.625000 | USD 126.375000; principal target not reached |
| 0.06 ETH | USD 148.350000 | USD 101.650000 |
| 0.08 ETH | USD 197.800000 | USD 52.200000 |

Initial capital includes the permanent LP and all trading float. Fee diversion, claimed process principal and the subsequent pack's funded USDC are successive uses of that same capital; they must not be charged again as fresh contributions. Treasury and Programmable fees remain unavailable to the trader. Additional acquisition fees, gas, provider overhead not already in the quoted input, rent, payout costs, failure reserves and any extra funding must fit within the listed room. No card resale or eventual buyback is credited to fund an earlier action. The full cost test remains open.

## Measured gas and its limits

Local execution measurements are recorded individually in `results.json`: token deployment 725,263 gas; hook deployment 6,412,849; custody deployment 666,212; graph wiring 188,756; seed 582,652; claim 150,559. The 32-swap case measures 5,892,831 gas across swaps; the 14-swap case measures 2,715,276. Salt search, infrastructure fixture deployment and test assertions are excluded from these stage measurements.

These are external-call measurements inside a Forge test transaction. They do **not** represent separate-transaction cold state, complete calldata/intrinsic gas, mainnet gas price, rollup data fees, a final graph factory deployment, or retry costs. `swapSeparateTransactionIntrinsicGasLowerBound` reports only the extra 21,000-per-swap arithmetic floor and must not be read as completing the missing gas bound. The lower swap count trades a larger initial float for fewer calls; this evidence does not select either alternative.

OPEN FACT: exact independent transaction costs for the admitted deployment graph, seed, approval, swaps, claim and outbound route. Resolve them with separately simulated unsigned production envelopes on the verified chain state, current fee/data-fee terms and explicit trade limits. The closest verified result is the local per-stage execution measurement and capital conservation here.

OPEN FACT: the complete Collector purchase and downstream cash cycle. Resolve the fresh exact-output quote, actual minimum eligible Collector pack, all Solana instructions, fee payer, account creation/rent and SOL reserve; then actual reveal, buyback/held branch, return attribution, final holder snapshot, native payout gas and failed-recipient reserves. The closest verified funding target is the expired preserved 25-USDC scenario; an unknown card buyback is never treated as income.

OPEN FACT: an all-in USD 250 acquisition and capital envelope. Resolve actual ETH acquisition/bridge pricing, existing capital commitments, gas reserve and the additional costs above before any funding order. The closest verified comparison is the explicitly historical conversion and remaining room shown here. Root has not selected funding, seed limits or operating ceilings.

## Reproduction and evidence

The sole focused Foundry run used `FOUNDRY_PROFILE=launch forge test --match-path test/native/NativeFundingFeasibility.t.sol -vv`: **3 passed, 0 failed**. Solc 0.8.26 compiled 148 files with the launch profile. Exact code hashes, expected root gitlinks, Forge version and export provenance are in `build-inputs.json`. Dependency sources were exported from the existing clean contract worktree with every `.git` entry excluded. Forge's automatic submodule attempt encountered the already exported directories, then successfully compiled those sources; the raw output preserves that diagnostic and the unavailable user-level signature-cache warning.

Run `node feasibility/native-funding/analyze.mjs` to independently check measured conservation, cumulative fee allocation, the one-wei lower bound and upward-rounded historical USD comparisons. It deterministically writes `results.json`. No live RPC, wallet credential, signing or broadcast was used. The process-budget module is frozen compatibility code and was not reactivated or edited.
