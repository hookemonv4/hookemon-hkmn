# Blind adversarial contract tests (phase 3 claims and fees)

Written from the specification statements only (fee split 10/40/250 bps on gross USDG volume with
three independent cumulative remainders; process claims with a rolling six-hour window, entry
limit, delayed increases, pause and emergency rotation; beneficiary claims with free destinations),
without reading the implementation first. Oracles are derived independently:
`floor(sum(executedUsdg) * bps / 10000)` for lifetime liabilities and hand-derived gross-up for
exact-output swaps.

Run:

```sh
FOUNDRY_LIBS='["lib/v4-core","lib/v4-periphery"]' forge test --root packages/contracts --match-path 'test/blind/phase3/*.t.sol' -vvv
```

Result at the time of writing: 30 tests, 30 passed, 0 failed.

| File | Coverage |
| --- | --- |
| `FeeAccountingBlind.t.sol` | split versus unsplit accrual (fuzzed), sixteen-way fragmentation, sub-minimum reverts, claims never touch remainders, solvency across random accrual and claim sequences |
| `SwapQuadrantsBlind.t.sol` | all eight token-order, direction and exactness combinations on the live PoolManager, USDG-specified exact input equals the requested gross, real consecutive swaps versus one combined swap, exact-output floor at 1000 units |
| `ClaimsAdversarialBlind.t.sol` | cycle reuse, window boundary at exactly 21600 s, entry limit N+1 (fuzzed), delayed increase boundary, increase above the immutable maximum, rotation authority, pending-rotation lock, auto-pause without an Operations unpause path, third-party destinations, full cross-role authorization matrix, same-function and cross-function reentrancy through a malicious token |

Findings:

- No contract defect found in `FeeAccounting`, `HookemonHook`, `MoneyRoles` or `CanonicalMarket`.
- One oracle error in the test author's first draft (swap direction for exact output when USDG is
  currency0) was corrected before reporting; the contract behaved as specified.
- Flag for reviewers: a rotated-out Treasury address keeps standing to claim exactly the liability
  it accrued before rotation and nothing more (`testFormerTreasuryCanStillClaimItsPreRotationAccrualButNothingMore`).
  This matches the specification wording, which qualifies only the Operations role with "current".
  If the owner prefers to freeze former beneficiaries, that is a requirements change, not a bug.
- Cross-function reentrancy (process claim transfer re-entering treasury claim, treasury claim
  re-entering programmable claim) is blocked by the shared money-path lock; the pre-existing suites
  only exercised same-function re-entry.
