# Native contract evidence

`NativeHook.t.sol` exercises the production HookemonHook, the selected standalone 1,000,000,000-HKMN token, real pinned PoolManager/PositionManager/Permit2, and PermanentPositionCustody. Its fixtures use synthetic values and grant no launch funding or provider approval.

The production cases cover four native swap quadrants, the 999/1000-wei boundary, distinct launch caller and refund recipient, exact native value, both debt maxima, current slot0, forced/pre-existing hook and PositionManager ETH, HKMN allowance cleanup, full allocation, permanent custody, rejecting and reentrant refunds, forwarding and rejecting claim recipients, claim reentry, and partial beneficiary payments. A cheatcode-only balance fault exercises the final solvency guard and confirms liability/cycle/window rollback. That fault deliberately bypasses EVM balance journaling; the separate rejected-payment cases prove ordinary atomic balance rollback.

`NativeSeedDebtParity.t.sol` independently compares rounded debt with actual pinned PositionManager execution at nine prices and bounded fuzz inputs. Its test token is a debt fixture, not the selected deployment token. The underpaid-manager case proves PositionManager can consume unrelated native balance, making the hook's own exact-funding check necessary. A synthetic release-math vector binds native maximum 40000000000000000, price 12527072418752396559322253362376889 and liquidity 6324555320336758663997 to native debt 39999999999999657, HKMN debt 1e27 and refund 343.

The calculation follows v4-core `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` (`Pool.sol`, `TickMath.sol`, `SqrtPriceMath.sol`) and v4-periphery `dce236d4e2057422d0791d9a973a58765eb46f65` (`PositionManager.sol`, `base/DeltaResolver.sol`). Solidity is 0.8.26 with Cancun. Native seeding sends only calculated debt to MINT_POSITION + SETTLE_PAIR; it does not use SWEEP or infer refunds from aggregate balances.

Use the existing package configuration and its contextual dependency remappings:

```sh
FOUNDRY_SRC=test/native FOUNDRY_TEST=test/native \
FOUNDRY_OUT=out-native FOUNDRY_CACHE_PATH=cache-native \
forge test --root packages/contracts --offline --match-path 'test/native/*.t.sol' -vv
```

The related local native regressions live in `test/access/ProcessClaims.t.sol`, `test/integration/HookemonHook.t.sol`, `test/blind/phase3/`, and the selected launch tests. Shared FeeAccounting retains its default historical ERC20 semantics; `test/accounting/`, `test/market/`, and `test/process/ProcessBudget.t.sol` retain those regressions.

Native fork consumers compile against current creationCode and preserve required provider-runtime and graph-output comparisons. Their pinned provider graph/runtime values require coordinator regeneration from actual fork execution before the native release gate can pass. Local native fixtures do not establish that fork evidence, live provider admission, deployment or spending authority.
