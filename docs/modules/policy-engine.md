# Policy engine

## Purpose

Enforce the operator's USD risk controls independently of native ETH principal and gas. The policy engine admits and reserves cycles, checks current execution controls, and retains immutable cost basis through recovery.

## Public interface

`createPolicyEngine` accepts configuration, custody, clock and configuration-mutation capabilities. Its `verifyQuoteUsdValuation(value, expected)` capability defaults to refusal and is supplied by the adapter's fetched-quote producer. The runner never imports an adapter. `evaluate`, `admit`, `evaluatePurchase`, `assertExecutionAllowed`, `evaluateQuoteRefresh` and `recordManualApproval` preserve the scheduling, reservation and approval boundaries.

Operator configuration v4 uses `MicroUsd` controls and ledgers. Policy admission v3 contains separate native TypedAmount funding quotes and `unitFundingUsd`/`aggregateFundingUsd` bindings. Cycle digest v5 binds `releaseAmountWei`, `releaseCostMicroUsd`, admission, mode and all economic policy fields. Historical operator schemas are available through `decodeHistoricalOperatorConfiguration` and USDG admission v2 through `decodeHistoricalPolicyAdmission`; execution never migrates them or accepts an old policy digest.

## Invariants

- Funding identity is 4663/native/18. The wire adapters alone use the zero address; Solana settlement retains its configured USDC mint and six decimals.
- The 55/165/495 USD unit, cycle and trailing-day outer rails remain fixed, with tighter owner caps. USD amounts use canonical integer micro-USD strings and never become transferable amounts. There is no ETH/USD or USDC/USD parity assumption.
- Every new claim and purchase requires producer-authenticated, current, exact-amount cost valuations with upward rounding. Persisted JSON preserves evidence and cost basis but cannot authenticate a new risk decision. Unit and aggregate quotes remain independent.
- A reservation records the aggregate USD cost once. Retries keep that cost and the original timestamp; the current per-cycle custody exposure offsets only the reserved cost already represented in aggregate risk. Unknown retry exposure refuses admission. Per-cycle exposure cannot exceed total custody.
- Held positions retain attributed purchase cost. Their outer limits remain ten positions and 5,000 USD; owner controls may tighten both. Insured or market value cannot replace purchase cost.
- Missing or stale valuation refuses new risk. Observation and existing recovery execution retain their original digest and frozen cost basis. A refreshed quote must preserve native principal and fit the original USD reservation.
- The trailing window, cycle count, modes, manual approvals, pause flags, kill switch, allowlist and fencing checks remain enforced. A pause/resume revision alone does not change a current economic digest.
- Native pre-signature canaries verify the principal identity and require an independently read balance covering principal plus gas reserve. Gas remains separate from spendable principal. Wallet policy for Robinhood admits only the native asset.

## State transitions

Admission appends one cycle record containing wei principal and USD basis, and one USD spend reservation. A matching retry cannot append another reservation or renew its timestamp. Manual approval adds one digest-bound record through the existing revision-checked mutation. A refusal leaves the durable configuration unchanged.

## Operational commands

Run the focused policy, configuration, budget, wallet, service and canary tests under `packages/runner/test/`. Native funds are admitted only after the adapter supplies fresh quote valuation capabilities and the custody projection accounts for current exposure.

## Recovery pointers

Retain old configuration, receipt and journal records as history. Start native execution with v4 configuration and v3 admission rather than relabeling historical USDG principal. Reauthenticate exact fetched-quote valuations before additional risk; use the original cost basis for observation and recovery. Restore unknown custody attribution before admitting another cycle.
