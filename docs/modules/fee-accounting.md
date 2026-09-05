# Fee Accounting

## Purpose

Fee accounting derives the inclusive USDG fee from authenticated executed gross quote volume and keeps Programmable, treasury, and process liabilities independently funded. It owns the hook-wide liability ledger and money-path reentrancy lock, covering `REQ-fee-accounting-1` through `REQ-fee-accounting-9` and the fee basis in `REQ-canonical-market-7`.

## Public interface

`packages/contracts/src/accounting/FeeAccounting.sol` implements the internal ledger, and `packages/contracts/src/HookemonHook.sol` exposes the current hook ABI.

- One authenticated canonical-market observation accrues the inclusive fee internally.
- `claimProgrammable(address destination)` transfers the full Programmable liability to its caller-selected nonzero destination. `claimProgrammable(uint256 amountAtomicUsdg,address destination)` transfers a positive partial amount no greater than that liability.
- `claimTreasury(address destination)` transfers the full liability of the calling Treasury beneficiary to its caller-selected nonzero destination. `claimTreasury(uint256 amountAtomicUsdg,address destination)` transfers a positive partial amount no greater than that liability. Treasury beneficiaries recorded at accrual retain access to their own historical liabilities after a role handover.
- `claimProcess(bytes32 cycleId,uint256 amountAtomicUsdg,address destination)` transfers only current Operations' process liability to Operations itself, subject to the bounded six-hour claim window.
- `readFeeLiabilities(address treasuryBeneficiary)`, `processLiability()`, `totalLiability()`, `hookUsdgBalance()`, and `isSolvent()` expose current hook accounting. The simplified hook exposes no `payoutLiability` read, process release, payout funding, or holder-payment entry point.
- Internal primitives debit bounded process liability only while holding the shared money-path lock. The deployed hook stores immutable `processClaimLimit6h`, `processClaimLimitMax`, `processClaimMaxCount`, and `operationsRotationDelay`; the maximum is 500000 USDG, `processClaimMaxCount` is from 1 through 64, and the rotation delay is 43200 seconds.
- `SwapLiabilitiesAccrued` records gross executed USDG, the exact total and three-way split, the two beneficiaries, and all three post-accrual remainders. `ProgrammableClaimed` and `TreasuryClaimed` record the exact destination and amount transferred. `ProcessClaimed` records the cycle identifier, amount, destination, timestamp, active cap, and used-after amount.
- Direct USDG transfers accept only an exact 32-byte canonical `true` result and exact source and destination balance deltas. PoolManager collection is accepted only when the observed hook balance increases by the exact fee.

## Invariants

- The fee basis is authenticated gross executed USDG volume across both token orders, both directions, and exact-input and exact-output swaps. `executedUsdg` is always that gross amount, never a net caller amount or the fee itself.
- The 10-basis-point Programmable, 40-basis-point treasury, and 250-basis-point process streams each keep an independent lifetime quotient/remainder accumulator. Claims never reset, merge, discard, or redistribute a remainder.
- Each stream accrues `floor((remainderBefore + gross * rateBps) / 10,000)` and stores the numerator remainder. Split and unsplit gross volume therefore produce identical lifetime totals and final remainder state for every stream.
- The collected amount equals the three independent liability increments exactly. It is the exact cumulative allocation for the authenticated gross volume, not a per-swap 300-basis-point shortcut.
- A positive executed amount below 1,000 atomic USDG reverts before collection, liability mutation, or event emission. Zero is a no-op; exactly 1,000 is eligible.
- Beneficiary ownership freezes at accrual. A treasury handover does not rewrite historical treasury liability, and process claims can debit only process liability.
- The Hookemon constructor and `RobinhoodBindings.validate` both pin the Programmable production beneficiary to `RobinhoodBindings.PROGRAMMABLE_BENEFICIARY`; neither accepts another value.
- The actual hook USDG balance always covers total unpaid liabilities. Direct or excess USDG creates no liability or withdrawal authority.
- Failed, false, reverted, malformed, short, excess-delta, or reentrant token interactions commit no partial accounting or transfer state.

## State transitions

- A valid finalized swap atomically collects the exact cumulative-remainder fee, updates all three remainders, increases the three fee-liability classes, checks solvency, and emits `SwapLiabilitiesAccrued`.
- A valid Programmable or Treasury claim atomically debits only the caller's own liability by the requested amount, transfers the exact amount to its selected destination, rechecks solvency, and emits its claim event.
- A valid process claim atomically debits only process liability, transfers the exact amount to current Operations, records its permanent cycle identifier and bounded active-window entry, rechecks solvency, and emits `ProcessClaimed`.
- Excluded legacy payout paths do not create a Phase 3 hook liability or a money-moving authority.
- Any rejected swap, collection, claim, or token transfer leaves all liabilities, remainders, and balances unchanged.

## Operational commands

```sh
forge test --root packages/contracts --match-path 'test/accounting/*.t.sol' -vvv
forge test --root packages/contracts --match-path 'test/market/*.t.sol' -vvv
forge test --root packages/contracts --match-path test/integration/HookemonHook.t.sol -vv
forge test --root packages/contracts --match-path test/access/ProcessClaims.t.sol -vv
```

The focused suites cover cumulative-remainder carry, fixed and fuzzed split-versus-unsplit allocation, the 1,000-unit boundary, liability isolation, exact balance-delta collection, malformed token returns, reentrancy, beneficiary-selected destinations, all eight swap quadrants, and global conservation. The integration oracle derives gross volume and fee from PoolManager swap logs plus caller, manager, and hook USDG deltas before comparing recorded hook state; live fragments in every quadrant are also compared with an independent unsplit lifetime allocation. `packages/contracts/test/blind/market-fees/BlindCanonicalMarketAdapter.t.sol` independently mirrors fresh 10/40/250-basis-point streams before accepting a collected fee or the first exact-output gross root. `testBeneficiaryClaimsUseRequestedDestinationsAndLeaveProcessLiabilityUntouched` confirms that beneficiary claims use the supplied destination without changing process liability, and `testClaimsRequireCanonicalTrueTransferReturn` covers the direct transfer contract.

## Recovery pointers

- Stop the affected money path when authenticated volume, collection delta, actual balance, or recorded liabilities disagree.
- Preserve every beneficiary liability, process liability, and remainder while reconciling the failed transition.
- Reconcile exact token deltas and the authenticated swap observation before retrying.
- Never repair solvency by clearing a remainder, reducing a liability, moving value between buckets, or adding a privileged surplus path.
