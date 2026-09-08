# Native seed preparation

These passing fixtures exercise pinned Uniswap managers before the native Hookemon implementation. They do not deploy a native HookemonHook, authorize revision 71, prove the final HKMN supply/allocation or custody graph, or establish provider admission. The test-only token is deliberately identified as a parity fixture.

Pinned Git sources: v4-core `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`; v4-periphery `dce236d4e2057422d0791d9a973a58765eb46f65`. `Pool.sol` lines 206–235 selects below-range, in-range and above-range liquidity debts from current slot0. `SqrtPriceMath.sol`'s signed positive-liquidity overload rounds the required unsigned amount upward. `DeltaResolver.sol` lines 36–48 settles native debt by `poolManager.settle{value: amount}()` from the PositionManager's balance. `PositionManager.sol` handles MINT_POSITION and SETTLE_PAIR, checks both maxima, and does not isolate this caller's msg.value from pre-existing native balance. The fixture compares the independent unsigned round-up recipe against that actual execution. It uses the pinned precompiled Permit2 helper, not a substitute settlement mock.

Seven tests pass, including 64 bounded fuzz runs and nine explicit prices: ticks -887221, -887220, -887219, -60, 0, 60, 887219, 887220 and 887221. They verify exact native/token debts, minted liquidity, sender/manager balances, no stranded PositionManager balance, preservation of unrelated ETH with an exact-debt call, and rollback on underfunding or either maximum being one atomic unit too small.

One deliberately successful adversarial case shows that PositionManager can consume one wei of its pre-existing 17 wei when the caller supplies nativeDebt minus one. This is evidence for the Hookemon entrypoint's explicit msg.value check; it is not a passing Hookemon funding guard. Do not add a zero-PositionManager-balance assumption or use SWEEP to hide that case.

Executed with Forge 1.7.1, Solidity 0.8.26, Cancun and the existing default optimizer profile:

```sh
FOUNDRY_SRC=test/native FOUNDRY_TEST=test/native \
FOUNDRY_OUT=out-native-prep FOUNDRY_CACHE_PATH=cache-native-prep \
forge test --root packages/contracts \
  --match-path 'test/native/NativeSeedDebtParity.t.sol' --fuzz-runs 64 -vv
```

Result: 7 passed, 0 failed, 0 skipped. The source/test overrides compile only this fixture's dependency graph; they do not modify repository configuration. Dependencies were exported from exact locally available Git objects into this worktree. Foundry attempted its automatic dependency bootstrap because those exports have no `.git` entries; the required graph still compiled and passed. Its isolated uerc20-factory checkout was restored to the exact pinned commit, and no tracked dependency or gitlink changed. For subsequent prepared local runs use offline mode and pre-materialized pinned dependencies. The sandbox's optional signature-cache write warning does not affect these test results. Formatting was applied afterward with the repository contract formatter and checked; no semantic test change followed.

## Production change boundary after coordinator go

1. In HookemonHook, CanonicalMarket and selected standalone launch/HKMNToken, bind native currency0 and HKMN currency1; retain supply, allocation, roles, permanent custody, 1000-wei minimum and cumulative 250/40/10 accounting. Do not substitute the historical embedded token in HookemonIssuance.sol.
2. Make the existing seed entrypoint payable with exact native maximum/value validation. After HKMN-only approvals, read current slot0 and compute debt with the proven rounding recipe. Send only nativeDebt into MINT_POSITION/SETTLE_PAIR; refund exactly msg.value minus nativeDebt to the existing explicit payer. Keep launchAuthority and payer distinct. Preserve allowance cleanup, full allocation and custody verification.
3. Give the active hook a native transfer seam under the existing money guard. Preserve the default shared FeeAccounting ERC20 adapter semantics for excluded ProcessBudget. Native claims must accept a recipient that forwards ETH, reject a failed value call atomically, and emit ProcessClaimed after payment. Do not impose ending recipient balance growth.
4. Replace active quote balance/collection adapters and explicit claim-cap units with native wei semantics; leave temporal claim/rotation rules unchanged. No oracle or guessed launch amounts.
5. Extend these fixtures against the actual native hook: insufficient/excess msg.value; native/HKMN maxima; forced/pre-existing ETH in hook and PositionManager; rejecting refund payer; distinct caller/payer; current-price drift before mint; permanent custody and full HKMN allocation; all four swap forms; claim recipient forwarding, rejection and reentrancy; and liability backing across failures.

The final native hook fixtures must exercise production source, not merely this parity recipe. Existing active contract tests are updated in the assigned lane; excluded vault contracts and their historical semantics stay unchanged. Production code waits for the coordinator's confirmed baseline/interface checkpoint. No live RPC, signature, spending or broadcast belongs to this fixture task.
