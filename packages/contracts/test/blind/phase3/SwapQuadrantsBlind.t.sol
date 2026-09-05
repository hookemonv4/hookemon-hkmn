// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Blind adversarial tests for the *live* Uniswap v4 swap path (requirements.json rev 62, spec
// statement (1)): "on the canonical pool, every swap charges exactly 3.00% of the GROSS USDG-side
// volume in all 8 combinations". These tests drive a real PoolManager/PoolSwapTest flow (same
// harness *pattern* as test/integration/HookemonHook.t.sol) but derive their own oracle rather
// than reusing that file's expected numbers.
//
// Oracle strategy: on a *freshly deployed* hook the three cumulative-remainder accumulators start
// at 0, so for the very first swap the fee split must equal floor(gross*bps/10_000) exactly for
// each of the 10/40/250 bps streams (see FeeAccountingBlind.t.sol for the algebraic proof). This
// lets us check the split-math wiring for all 8 quadrants without having to reimplement Uniswap
// v4's tick math to independently predict `gross` itself; the two quadrants where the USDG side is
// the *specified, exact-input* leg are additionally checked against a fully independent gross
// oracle (gross == the caller's requested amount, by construction, regardless of pool price).

import { Test } from "@uniswap/v4-core/lib/forge-std/src/Test.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { RobinhoodBindings } from "../../../src/bindings/RobinhoodBindings.sol";
import { HookemonHook } from "../../../src/HookemonHook.sol";

contract BlindSwapToken {
    mapping(address account => uint256) private balances;
    mapping(address owner => mapping(address spender => uint256)) private allowances;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = allowances[sender][msg.sender];
        if (approved != type(uint256).max) allowances[sender][msg.sender] = approved - amount;
        balances[sender] -= amount;
        balances[recipient] += amount;
        return true;
    }
}

contract SwapQuadrantsBlindFactory {
    HookemonHook.ConstructorConfig private config;

    constructor(HookemonHook.ConstructorConfig memory configured) {
        config = configured;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));
    }

    function deploy(bytes32 salt) external returns (HookemonHook) {
        return new HookemonHook{ salt: salt }(config);
    }
}

contract SwapQuadrantsBlindTest is Test {
    uint160 private constant ALL_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_MASK = 0x20CC;
    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0xA100);
    address private constant OPERATIONS = address(0xA200);
    address private constant AUTHORITY = address(0xA300);

    PoolManager private manager;
    PoolModifyLiquidityTest private liquidityRouter;
    PoolSwapTest private swapRouter;
    BlindSwapToken private tokenA;
    BlindSwapToken private tokenB;
    Currency private currency0;
    Currency private currency1;

    function setUp() external {
        manager = new PoolManager(address(this));
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);
        BlindSwapToken first = new BlindSwapToken();
        BlindSwapToken second = new BlindSwapToken();
        (tokenA, tokenB) = address(first) < address(second) ? (first, second) : (second, first);
        currency0 = Currency.wrap(address(tokenA));
        currency1 = Currency.wrap(address(tokenB));
        tokenA.mint(address(this), 10 ** 30);
        tokenB.mint(address(this), 10 ** 30);
        tokenA.approve(address(liquidityRouter), type(uint256).max);
        tokenB.approve(address(liquidityRouter), type(uint256).max);
        tokenA.approve(address(swapRouter), type(uint256).max);
        tokenB.approve(address(swapRouter), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Fee split matches floor(gross*bps/10_000) for all 8 quadrants.
    // ---------------------------------------------------------------------

    function testAllEightQuadrantsSplitMatchesIndependentFloorFormulaOnFreshHooks() external {
        for (uint256 order; order < 2; ++order) {
            Currency usdgC = order == 0 ? currency0 : currency1;
            for (uint256 direction; direction < 2; ++direction) {
                for (uint256 exactness; exactness < 2; ++exactness) {
                    _assertFreshQuadrantSplit(usdgC, direction == 0, exactness == 0, 50_000);
                }
            }
        }
    }

    /// @dev The two USDG-specified, exact-input quadrants have a gross that is fixed by the
    ///      caller (independent of pool price), so we can additionally assert gross itself.
    function testUsdgSpecifiedExactInputGrossEqualsRequestedAmountBothOrders() external {
        HookemonHook hookUsdg0 = _deployHook(currency0);
        _seedPool(hookUsdg0, currency0);
        _usdgExactInputSwap(hookUsdg0, currency0, 123_456);
        assertEq(hookUsdg0.lastExecutedUsdg(), 123_456);

        HookemonHook hookUsdg1 = _deployHook(currency1);
        _seedPool(hookUsdg1, currency1);
        _usdgExactInputSwap(hookUsdg1, currency1, 654_321);
        assertEq(hookUsdg1.lastExecutedUsdg(), 654_321);
    }

    // ---------------------------------------------------------------------
    // Split vs. unsplit equivalence through the *real* pool (usdg-specified exact-input quadrant,
    // both token orders) -- an end-to-end counterpart to the pure-ledger property in
    // FeeAccountingBlind.t.sol.
    // ---------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 5
    function testFuzz_SplitVsUnsplitAcrossRealConsecutiveSwaps(
        uint32 rawFirst,
        uint32 rawSecond,
        bool useCurrency1AsUsdg
    ) external {
        uint256 first = bound(uint256(rawFirst), 1_000, 5_000_000);
        uint256 second = bound(uint256(rawSecond), 1_000, 5_000_000);
        Currency usdgC = useCurrency1AsUsdg ? currency1 : currency0;

        HookemonHook splitHook = _deployHook(usdgC);
        _seedPool(splitHook, usdgC);
        _usdgExactInputSwap(splitHook, usdgC, first);
        _usdgExactInputSwap(splitHook, usdgC, second);

        HookemonHook unsplitHook = _deployHook(usdgC);
        _seedPool(unsplitHook, usdgC);
        _usdgExactInputSwap(unsplitHook, usdgC, first + second);

        (uint256 pSplit, uint256 tSplit, uint256 prSplit) = splitHook.readFeeLiabilities(TREASURY);
        (uint256 pUnsplit, uint256 tUnsplit, uint256 prUnsplit) =
            unsplitHook.readFeeLiabilities(TREASURY);
        assertEq(pSplit, pUnsplit, "programmable diverged across real split swaps");
        assertEq(tSplit, tUnsplit, "treasury diverged across real split swaps");
        assertEq(prSplit, prUnsplit, "process diverged across real split swaps");
        assertEq(splitHook.totalLiability(), unsplitHook.totalLiability());
        assertTrue(splitHook.isSolvent());
        assertTrue(unsplitHook.isSolvent());
    }

    // ---------------------------------------------------------------------
    // 1000-unit minimum boundary through the real pool.
    // ---------------------------------------------------------------------

    function testFuzz_UsdgSpecifiedExactInputBelowMinimumRevertsBothOrders(uint256 raw) external {
        uint256 amount = bound(raw, 1, 999);

        HookemonHook hook0 = _deployHook(currency0);
        _seedPool(hook0, currency0);
        vm.expectRevert();
        _usdgExactInputSwap(hook0, currency0, amount);

        HookemonHook hook1 = _deployHook(currency1);
        _seedPool(hook1, currency1);
        vm.expectRevert();
        _usdgExactInputSwap(hook1, currency1, amount);
    }

    function testExactOutputCannotProduceGrossBelowOneThousand() external {
        // Requesting a USDG net output tiny enough that no gross >= 1000 can satisfy
        // `gross - fee(gross) == requestedNet` must revert cleanly rather than allow a sub-1000
        // gross swap or leave the ledger mutated. usdg == currency0, so an exact-output swap that
        // specifies USDG needs zeroForOne == false (input is hkmn/currency1, output is
        // usdg/currency0) with a positive amountSpecified.
        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-600, 600, 10 ** 24, bytes32(0)), bytes("")
        );

        vm.expectRevert();
        swapRouter.swap(
            key,
            SwapParams(false, int256(1), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            bytes("")
        );
        assertEq(hook.totalLiability(), 0, "failed exact-output attempt must not mutate ledger");
    }

    function testExactOutputAtTheThousandUnitFloorSucceeds() external {
        // gross=1000 charges a flat fee of exactly 30 on a fresh hook (0 remainder), so
        // requesting a USDG net output of 970 must resolve to gross == 1000 exactly. usdg ==
        // currency0, so the USDG-specified exact-output direction is zeroForOne == false.
        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-600, 600, 10 ** 24, bytes32(0)), bytes("")
        );

        swapRouter.swap(
            key,
            SwapParams(false, int256(970), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            bytes("")
        );
        assertEq(hook.lastExecutedUsdg(), 1_000, "expected the minimum gross to be selected");
        assertEq(hook.totalLiability(), 30);
        assertTrue(hook.isSolvent());
    }

    // ---------------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------------

    function _assertFreshQuadrantSplit(
        Currency usdgC,
        bool zeroForOne,
        bool exactInput,
        uint256 amount
    ) private {
        HookemonHook hook = _deployHook(usdgC);
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-600, 600, 10 ** 24, bytes32(0)), bytes("")
        );

        int256 specified = exactInput ? -int256(amount) : int256(amount);
        swapRouter.swap(
            key,
            SwapParams(
                zeroForOne,
                specified,
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            bytes("")
        );

        uint256 gross = hook.lastExecutedUsdg();
        assertGt(gross, 0, "quadrant produced zero gross");
        (uint256 programmable, uint256 treasury, uint256 process) =
            hook.readFeeLiabilities(TREASURY);
        assertEq(programmable, (gross * 10) / 10_000, "programmable != floor(gross*10/10000)");
        assertEq(treasury, (gross * 40) / 10_000, "treasury != floor(gross*40/10000)");
        assertEq(process, (gross * 250) / 10_000, "process != floor(gross*250/10000)");
        assertEq(hook.totalLiability(), programmable + treasury + process);
        assertTrue(hook.isSolvent());
    }

    function _usdgExactInputSwap(HookemonHook hook, Currency usdgC, uint256 amount) private {
        PoolKey memory key = _key(hook);
        bool zeroForOne = Currency.unwrap(usdgC) == Currency.unwrap(currency0);
        swapRouter.swap(
            key,
            SwapParams(
                zeroForOne,
                -int256(amount),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            bytes("")
        );
    }

    function _seedPool(HookemonHook hook, Currency) private {
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-600, 600, 10 ** 24, bytes32(0)), bytes("")
        );
    }

    function _initializeHook(HookemonHook hook) private {
        vm.prank(AUTHORITY);
        hook.initializeCanonicalPool(uint160(1 << 96));
    }

    function _deployHook(Currency usdgC) private returns (HookemonHook hook) {
        SwapQuadrantsBlindFactory factory = new SwapQuadrantsBlindFactory(_config(usdgC));
        bytes32 hash = factory.initCodeHash();
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(salt, hash, address(factory));
            if ((uint160(predicted) & ALL_MASK) == REQUIRED_MASK) {
                hook = factory.deploy(salt);
                assertEq(address(hook), predicted);
                return hook;
            }
        }
        revert("missing valid swap-quadrant hook salt");
    }

    function _config(Currency usdgC) private view returns (HookemonHook.ConstructorConfig memory) {
        return HookemonHook.ConstructorConfig({
            manager: manager,
            positionManager: address(0xB001),
            permit2: address(0xB002),
            usdg: usdgC,
            hkmn: Currency.unwrap(usdgC) == Currency.unwrap(currency0) ? currency1 : currency0,
            tickSpacing: 60,
            programmable: PROGRAMMABLE,
            treasury: TREASURY,
            operations: OPERATIONS,
            launchAuthority: AUTHORITY,
            issuanceAuthority: AUTHORITY,
            expectedDecimals: 18,
            bindingDigest: keccak256("blind-swap-binding"),
            runtimeDigest: keccak256("blind-swap-runtime"),
            processClaimLimit6h: 1_000_000_000_000,
            processClaimLimitMax: 1_000_000_000_000,
            processClaimMaxCount: 8,
            operationsRotationDelay: 3 days
        });
    }

    function _key(HookemonHook hook) private view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, 0, 60, IHooks(address(hook)));
    }
}
