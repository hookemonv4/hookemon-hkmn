# Recorded local gas positions

| Position | Successful local receipts | EVM gas |
|---|---:|---:|
| USDG approval to Permit2 | 1 | 57,916 |
| Permit2 approval to hook | 1 | 47,602 |
| Canonical liquidity seed | 1 | 664,385 |
| Sixteen buy/sell rounds | 32 | 8,381,525 |
| Process-liability claim | 1 | 220,539 |
| Sum of measured positions | 36 | 9,371,967 |

These receipt totals combine separate local fixtures and pinned fork blocks; they are not one continuous mainnet execution. The seed review is `local-router-seed-evidence/independent-review.json`; swap/claim review is `local-router-claim-evidence/independent-review.json` under the coordination directory.

Using the previously supplied 423,574,000 wei/gas gives 3969721550058000 wei (0.003969721550058000 ETH). This is price-scenario arithmetic, separate from measured receipt gas; it is not a live quote or maximum.

Capital remains a separate category: 100 USDG seed plus 50 USDG trader. The 25.298644 USDG claim recycles that capital and is not another top-up. No USDG/USD parity is assumed.

Deployment, provider deployment path, Arbitrum poster/L1 fees, bridge approval/deposit and return fees, Solana funding, Collector purchase/buyback costs and final payout costs remain outside this measured subtotal. No all-in USD budget compliance is asserted.
