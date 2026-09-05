// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { BaseTestHooks } from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {
    BalanceDelta,
    BalanceDeltaLibrary,
    toBalanceDelta
} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { CurrencySettler } from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import { CanonicalMarketCallback } from "../../src/market/CanonicalMarket.sol";

library MarketHookDataFixture {
    function encode(bytes32 operationId, address sender, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(operationId, sender, recipient);
    }
}

interface Vm {
    function prank(address) external;
}

contract MarketTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = allowance[sender][msg.sender];
        if (approved != type(uint256).max) allowance[sender][msg.sender] = approved - amount;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract RecipientPoolSwapTest {
    using CurrencySettler for Currency;

    struct CallbackData {
        address payer;
        address recipient;
        PoolKey key;
        SwapParams params;
        bytes hookData;
    }

    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function swap(
        PoolKey memory key,
        SwapParams memory params,
        address payer,
        address recipient,
        bytes calldata hookData
    ) external returns (BalanceDelta delta) {
        delta = abi.decode(
            manager.unlock(abi.encode(CallbackData(payer, recipient, key, params, hookData))),
            (BalanceDelta)
        );
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        assert(msg.sender == address(manager));
        CallbackData memory data = abi.decode(rawData, (CallbackData));
        BalanceDelta delta = manager.swap(data.key, data.params, data.hookData);
        _settle(data.key.currency0, delta.amount0(), data.payer, data.recipient);
        _settle(data.key.currency1, delta.amount1(), data.payer, data.recipient);
        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 delta, address payer, address recipient) private {
        if (delta < 0) currency.settle(manager, payer, uint256(uint128(-delta)), false);
        if (delta > 0) currency.take(manager, recipient, uint256(uint128(delta)), false);
    }
}

/// @dev This hook deliberately uses a flat 300-bps preview only to isolate callback mechanics.
///      It is not a FeeAccounting conformance model; the real three-remainder economics live in
///      CanonicalMarket.t.sol and HookemonHook.t.sol.
contract LocalCanonicalMarketHook is BaseTestHooks, CanonicalMarketCallback {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public collected;
    uint256 public collectionCalls;
    uint256 public accrualCalls;
    uint256 public lastCollectedFee;
    uint256 public lastAccruedExecutedUsdg;
    bool public reenterOnCollection;
    bool public reentrySucceeded;
    bytes4 public reentrySelector;
    address private reentrySender;
    bytes private reentryData;

    constructor(IPoolManager manager, Currency usdg, Currency hkmn)
        CanonicalMarketCallback(manager, usdg, hkmn, 60)
    { }

    function armSameContextAfterSwapReentry(address sender, bytes calldata data) external {
        reenterOnCollection = true;
        reentrySender = sender;
        reentryData = data;
    }

    function _collectFee(Currency, uint256 feeAmount)
        internal
        override
        returns (uint256 balanceBeforeCollection)
    {
        if (reenterOnCollection) {
            reenterOnCollection = false;
            VM.prank(address(poolManager));
            (bool ok, bytes memory reason) = address(this)
                .call(
                    abi.encodeCall(
                        this.afterSwap,
                        (
                            reentrySender,
                            PoolKey(usdg, hkmn, 0, tickSpacing, IHooks(address(this))),
                            SwapParams(false, -100, 0),
                            toBalanceDelta(100, -100),
                            reentryData
                        )
                    )
                );
            reentrySucceeded = ok;
            reentrySelector = bytes4(reason);
        }
        balanceBeforeCollection = collected;
        ++collectionCalls;
        lastCollectedFee = feeAmount;
        collected += feeAmount;
    }

    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        override
    {
        assert(collected - balanceBeforeCollection == executedUsdg * 300 / 10_000);
        ++accrualCalls;
        lastAccruedExecutedUsdg = executedUsdg;
    }

    function _previewTotalFee(uint256 executedUsdg) internal pure override returns (uint256) {
        return executedUsdg * 300 / 10_000;
    }

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        pure
        override(BaseTestHooks, IHooks)
        returns (bytes4)
    {
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    )
        external
        override(BaseTestHooks, CanonicalMarketCallback)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (BeforeSwapDelta delta, uint24 fee) = _beforeSwap(sender, key, params, data);
        return (IHooks.beforeSwap.selector, delta, fee);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata data
    ) external override(BaseTestHooks, CanonicalMarketCallback) returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, _afterSwap(sender, key, params, delta, data));
    }
}

contract LocalCanonicalMarketHookDeployer {
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;

    function deploy(IPoolManager manager, Currency usdg, Currency hkmn)
        external
        returns (LocalCanonicalMarketHook hook)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(LocalCanonicalMarketHook).creationCode, abi.encode(manager, usdg, hkmn)
            )
        );
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
            if (uint160(predicted) & ALL_HOOK_MASK == REQUIRED_HOOK_MASK) {
                hook = new LocalCanonicalMarketHook{ salt: salt }(manager, usdg, hkmn);
                assert(address(hook) == predicted);
                return hook;
            }
        }
        revert("HOOK_SALT_NOT_FOUND");
    }
}

/// @dev Uses a distinct PoolManager caller so v4 dispatches the nested callback instead of taking
///      its intentional hook-self callback bypass.
contract SamePoolSwapAttemptor {
    function attempt(
        IPoolManager manager,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    ) external returns (BalanceDelta) {
        return manager.swap(key, params, data);
    }
}

contract SettlementCanonicalMarketHook is BaseTestHooks, CanonicalMarketCallback {
    using CurrencySettler for Currency;

    uint256 public accruedExecutedUsdg;
    uint256 public collectedFee;
    uint256 public recordedBalanceBefore;
    bool public samePoolSwapAttempted;
    bool public samePoolSwapSucceeded;
    bool private samePoolSwapArmed;
    PoolKey private samePoolSwapKey;
    SwapParams private samePoolSwapParams;
    bytes private samePoolSwapData;
    SamePoolSwapAttemptor private immutable samePoolSwapAttemptor;

    constructor(IPoolManager manager, Currency usdg, Currency hkmn)
        CanonicalMarketCallback(manager, usdg, hkmn, 60)
    {
        samePoolSwapAttemptor = new SamePoolSwapAttemptor();
    }

    function armSamePoolSwapDuringCollection(
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    ) external {
        samePoolSwapArmed = true;
        samePoolSwapKey = key;
        samePoolSwapParams = params;
        samePoolSwapData = data;
    }

    function _collectFee(Currency currency, uint256 feeAmount)
        internal
        override
        returns (uint256 balanceBeforeCollection)
    {
        if (samePoolSwapArmed) {
            samePoolSwapArmed = false;
            samePoolSwapAttempted = true;
            (samePoolSwapSucceeded,) = address(samePoolSwapAttemptor)
                .call(
                    abi.encodeCall(
                        SamePoolSwapAttemptor.attempt,
                        (poolManager, samePoolSwapKey, samePoolSwapParams, samePoolSwapData)
                    )
                );
        }
        balanceBeforeCollection = currency.balanceOfSelf();
        if (feeAmount != 0) poolManager.take(currency, address(this), feeAmount);
        collectedFee = feeAmount;
    }

    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        override
    {
        assert(usdg.balanceOfSelf() - balanceBeforeCollection == executedUsdg * 300 / 10_000);
        accruedExecutedUsdg = executedUsdg;
        recordedBalanceBefore = balanceBeforeCollection;
    }

    function _previewTotalFee(uint256 executedUsdg) internal pure override returns (uint256) {
        return executedUsdg * 300 / 10_000;
    }

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        pure
        override(BaseTestHooks, IHooks)
        returns (bytes4)
    {
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    )
        external
        override(BaseTestHooks, CanonicalMarketCallback)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (BeforeSwapDelta delta, uint24 fee) = _beforeSwap(sender, key, params, data);
        return (IHooks.beforeSwap.selector, delta, fee);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata data
    ) external override(BaseTestHooks, CanonicalMarketCallback) returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, _afterSwap(sender, key, params, delta, data));
    }
}

contract SettlementCanonicalMarketHookDeployer {
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;

    function deploy(IPoolManager manager, Currency usdg, Currency hkmn)
        external
        returns (SettlementCanonicalMarketHook hook)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(SettlementCanonicalMarketHook).creationCode, abi.encode(manager, usdg, hkmn)
            )
        );
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
            if (uint160(predicted) & ALL_HOOK_MASK == REQUIRED_HOOK_MASK) {
                hook = new SettlementCanonicalMarketHook{ salt: salt }(manager, usdg, hkmn);
                assert(address(hook) == predicted);
                return hook;
            }
        }
        revert("HOOK_SALT_NOT_FOUND");
    }
}

contract CanonicalMarketCallbackSurfaceTest {
    using BalanceDeltaLibrary for BalanceDelta;
    using BeforeSwapDeltaLibrary for BeforeSwapDelta;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct LocalQuadrantObservation {
        bool specified0;
        bool usdgSpecified;
        uint256 netUsdg;
        uint256 executedUsdg;
        int128 fee;
        int128 specifiedDelta;
        int128 unspecifiedDelta;
        int128 amount0;
        int128 amount1;
    }

    struct PoolManagerFixture {
        PoolManager manager;
        PoolModifyLiquidityTest liquidityRouter;
        PoolSwapTest swapRouter;
        SettlementCanonicalMarketHook hook;
        PoolKey key;
        MarketTestToken token0;
        MarketTestToken token1;
        Currency usdg;
    }

    struct PoolManagerSwapOutcome {
        int128 amount0;
        int128 amount1;
        uint256 hookUsdgBalance;
        uint256 collectedFee;
        uint256 accruedExecutedUsdg;
        uint256 lastExecutedUsdg;
        int128 lastRawPoolUsdgDelta;
    }

    function testUsesPinnedV4CallbackSelectors() external pure {
        assert(CanonicalMarketCallback.beforeSwap.selector == IHooks.beforeSwap.selector);
        assert(CanonicalMarketCallback.afterSwap.selector == IHooks.afterSwap.selector);
    }

    function testHookDataIsIgnoredAcrossTheCallbackPair() external {
        PoolManager manager = new PoolManager(address(this));
        MarketTestToken first = new MarketTestToken();
        MarketTestToken second = new MarketTestToken();
        (MarketTestToken usdgToken, MarketTestToken hkmnToken) =
            address(first) < address(second) ? (first, second) : (second, first);
        LocalCanonicalMarketHook hook = new LocalCanonicalMarketHookDeployer()
            .deploy(manager, Currency.wrap(address(usdgToken)), Currency.wrap(address(hkmnToken)));
        PoolKey memory key = PoolKey(
            Currency.wrap(address(usdgToken)),
            Currency.wrap(address(hkmnToken)),
            0,
            60,
            IHooks(address(hook))
        );
        manager.initialize(key, 1 << 96);
        SwapParams memory params = SwapParams(true, -100_000, 0);

        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, bytes("first arbitrary payload"));
        VM.prank(address(manager));
        (, int128 afterDelta) = hook.afterSwap(
            address(this), key, params, toBalanceDelta(-97_000, 80_000), bytes("different bytes")
        );

        assert(afterDelta == 0);
        assert(hook.lastExecutedUsdg() == 100_000);
        assert(hook.lastCollectedFee() == 3_000);
        assert(hook.collectionCalls() == 1);
        assert(hook.accrualCalls() == 1);
    }

    function testRejectsZeroUsdgCurrency() external {
        PoolManager manager = new PoolManager(address(this));
        bool rejected;
        try new LocalCanonicalMarketHook(
            manager, Currency.wrap(address(0)), Currency.wrap(address(0x2000))
        ) returns (
            LocalCanonicalMarketHook
        ) { }
        catch {
            rejected = true;
        }
        assert(rejected);
    }

    function testRejectsZeroHkmnCurrency() external {
        PoolManager manager = new PoolManager(address(this));
        bool rejected;
        try new LocalCanonicalMarketHook(
            manager, Currency.wrap(address(0x1000)), Currency.wrap(address(0))
        ) returns (
            LocalCanonicalMarketHook
        ) { }
        catch {
            rejected = true;
        }
        assert(rejected);
    }

    function testAllEightLocalCallbackQuadrantsWithFlatReference() external {
        for (uint256 order; order < 2; ++order) {
            for (uint256 direction; direction < 2; ++direction) {
                for (uint256 exact; exact < 2; ++exact) {
                    _assertLocalQuadrant(order == 0, direction == 0, exact == 0);
                }
            }
        }
    }

    /// @dev The flat callback fixture still verifies that exact output is expressed as the
    ///      caller's requested net USDG amount. Real carried-remainder gross-up is covered by
    ///      CanonicalMarket.t.sol and HookemonHook.t.sol.
    function testExactOutputGrossesUpSpecifiedAndUnspecifiedUsdg() external {
        (
            PoolManager specifiedManager,
            LocalCanonicalMarketHook specifiedHook,
            PoolKey memory specifiedKey,
        ) = _deploy(true);
        SwapParams memory specifiedParams = SwapParams(false, 970, 0);

        VM.prank(address(specifiedManager));
        (, BeforeSwapDelta specifiedBefore,) =
            specifiedHook.beforeSwap(address(this), specifiedKey, specifiedParams, bytes("before"));
        assert(specifiedBefore.getSpecifiedDelta() == 30);
        VM.prank(address(specifiedManager));
        (, int128 specifiedAfter) = specifiedHook.afterSwap(
            address(this), specifiedKey, specifiedParams, toBalanceDelta(1_000, -80), bytes("after")
        );
        assert(specifiedAfter == 0);
        assert(specifiedHook.lastCollectedFee() == 30);
        assert(specifiedHook.lastExecutedUsdg() == 1_000);

        (
            PoolManager unspecifiedManager,
            LocalCanonicalMarketHook unspecifiedHook,
            PoolKey memory unspecifiedKey,
        ) = _deploy(true);
        SwapParams memory unspecifiedParams = SwapParams(true, 80, 0);

        VM.prank(address(unspecifiedManager));
        (, BeforeSwapDelta unspecifiedBefore,) = unspecifiedHook.beforeSwap(
            address(this), unspecifiedKey, unspecifiedParams, bytes("before")
        );
        assert(unspecifiedBefore.getSpecifiedDelta() == 0);
        VM.prank(address(unspecifiedManager));
        (, int128 unspecifiedAfter) = unspecifiedHook.afterSwap(
            address(this),
            unspecifiedKey,
            unspecifiedParams,
            toBalanceDelta(-970, 80),
            bytes("after")
        );
        assert(unspecifiedAfter == 30);
        assert(unspecifiedHook.lastCollectedFee() == 30);
        assert(unspecifiedHook.lastExecutedUsdg() == 1_000);
    }

    function testDefersSpecifiedCollectionUntilAuthenticatedFinalizedAmount() external {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -10_000, 0);
        bytes memory data = bytes("before and after payloads may differ");
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, data);
        assert(hook.collectionCalls() == 0);
        assert(hook.accrualCalls() == 0);
        assert(hook.lastAccruedExecutedUsdg() == 0);

        VM.prank(address(manager));
        hook.afterSwap(
            address(this), key, params, toBalanceDelta(-9_700, 8_000), bytes("other payload")
        );
        assert(hook.collected() == 300);
        assert(hook.collectionCalls() == 1);
        assert(hook.accrualCalls() == 1);
        assert(hook.lastCollectedFee() == 300);
        assert(hook.lastAccruedExecutedUsdg() == 10_000);
    }

    function testFencesSameContextAfterSwapReentryDuringCollection() external {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(false, -100, 0);
        bytes memory data = bytes("reentry payload");
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, data);
        hook.armSameContextAfterSwapReentry(address(this), data);

        VM.prank(address(manager));
        hook.afterSwap(address(this), key, params, toBalanceDelta(100, -100), bytes("changed"));
        assert(!hook.reentrySucceeded());
        assert(hook.reentrySelector() == CanonicalMarketCallback.ReentrantCallback.selector);
        assert(hook.collected() == 3);
        assert(hook.accrualCalls() == 1);
        assert(hook.lastExecutedUsdg() == 100);
    }

    function testRejectsForeignKeyAndNestedBeforeSwap() external {
        _assertBeforeRejected(false, true, false);

        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -100, 0);
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, bytes("first"));
        VM.prank(address(manager));
        (bool ok, bytes memory reason) = address(hook)
            .call(abi.encodeCall(hook.beforeSwap, (address(this), key, params, bytes("second"))));
        assert(!ok);
        assert(_selector(reason) == CanonicalMarketCallback.ReentrantCallback.selector);
        assert(hook.collected() == 0);
        assert(hook.lastExecutedUsdg() == 0);
    }

    function testNegativeCallbackVectorsDoNotCollect() external {
        _assertBeforeRejected(false, true, false);
        _assertBeforeRejected(true, false, false);
        _assertBeforeRejected(false, false, true);
        _assertAfterRejected(true, false);
        _assertAfterRejected(false, true);
        _assertAfterRejected(false, false);
    }

    function testLocalFlatReferenceRoundingCollectsOnlyAtFirstFloorUnit() external {
        _assertRoundedCollection(33, 0);
        _assertRoundedCollection(34, 1);
        _assertUnspecifiedRoundedCollection(33, 0);
        _assertUnspecifiedRoundedCollection(34, 1);
    }

    function testPartialFillUsesInvalidFinalizedSwapSelector() external {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -100, 0);
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, bytes("any"));
        VM.prank(address(manager));
        (bool ok, bytes memory reason) = address(hook)
            .call(
                abi.encodeCall(
                    hook.afterSwap,
                    (address(this), key, params, toBalanceDelta(-96, 80), bytes("different"))
                )
            );
        assert(!ok);
        assert(_selector(reason) == CanonicalMarketCallback.InvalidFinalizedSwap.selector);
        assert(hook.collected() == 0);
    }

    function testExtremeSpecifiedAmountUsesInvalidFinalizedSwapSelector() external {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -type(int256).max, 0);
        VM.prank(address(manager));
        (bool ok, bytes memory reason) = address(hook)
            .call(abi.encodeCall(hook.beforeSwap, (address(this), key, params, bytes("any"))));
        assert(!ok);
        assert(_selector(reason) == CanonicalMarketCallback.InvalidFinalizedSwap.selector);

        (manager, hook, key,) = _deploy(true);
        params = SwapParams(true, type(int256).min, 0);
        VM.prank(address(manager));
        (ok, reason) = address(hook)
            .call(abi.encodeCall(hook.beforeSwap, (address(this), key, params, bytes("any"))));
        assert(!ok);
        assert(_selector(reason) == CanonicalMarketCallback.InvalidFinalizedSwap.selector);
        assert(hook.collected() == 0);
        assert(hook.lastExecutedUsdg() == 0);
    }

    function testMaximumPracticalSpecifiedAmountAndNextUnitBoundary() external {
        uint256 maxAmount = ((uint256(uint128(type(int128).max)) + 1) * 10_000 - 1) / 300;
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -int256(maxAmount), 0);
        VM.prank(address(manager));
        (, BeforeSwapDelta before,) = hook.beforeSwap(address(this), key, params, bytes("any"));
        assert(before.getSpecifiedDelta() == type(int128).max);
        assert(hook.collected() == 0);
        assert(hook.collectionCalls() == 0);

        (manager, hook, key,) = _deploy(true);
        params = SwapParams(true, -int256(maxAmount + 1), 0);
        VM.prank(address(manager));
        (bool ok, bytes memory reason) = address(hook)
            .call(abi.encodeCall(hook.beforeSwap, (address(this), key, params, bytes("any"))));
        assert(!ok);
        assert(_selector(reason) == CanonicalMarketCallback.InvalidFinalizedSwap.selector);
        assert(hook.collected() == 0);
        assert(hook.lastExecutedUsdg() == 0);
    }

    function testFuzzLocalFlatReferenceSpecifiedAmountsDoNotOverflow(uint128 amount) external {
        uint256 specified = amount == 0 ? 1 : amount;
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -int256(specified), 0);
        VM.prank(address(manager));
        (, BeforeSwapDelta before,) = hook.beforeSwap(address(this), key, params, bytes("any"));
        uint256 fee = specified * 300 / 10_000;
        assert(before.getSpecifiedDelta() == int128(uint128(fee)));
        assert(hook.collected() == 0);
        assert(hook.collectionCalls() == 0);
        assert(hook.lastExecutedUsdg() == 0);
    }

    function testPoolManagerPartialFillRollsBackCollectionAndObservation() external {
        PoolManagerFixture memory fixture = _deployPoolManagerFixture(true);
        uint256 hookBalanceBefore = fixture.token0.balanceOf(address(fixture.hook));
        bool rejected = _swapRejected(
            fixture.swapRouter,
            fixture.key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(10 ** 17),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(-1)
            }),
            bytes("arbitrary payload")
        );

        assert(rejected);
        assert(fixture.token0.balanceOf(address(fixture.hook)) == hookBalanceBefore);
        assert(fixture.hook.collectedFee() == 0);
        assert(fixture.hook.accruedExecutedUsdg() == 0);
        assert(fixture.hook.lastExecutedUsdg() == 0);
    }

    function testPoolManagerRejectsNonzeroProtocolFeeWithoutMutation() external {
        PoolManagerFixture memory fixture = _deployPoolManagerFixture(true);
        fixture.manager.setProtocolFeeController(address(this));
        fixture.manager.setProtocolFee(fixture.key, uint24(100) | (uint24(100) << 12));

        uint256 hookBalanceBefore = fixture.token0.balanceOf(address(fixture.hook));
        bool rejected = _swapRejected(
            fixture.swapRouter,
            fixture.key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(100_000),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            bytes("arbitrary payload")
        );

        assert(rejected);
        assert(fixture.token0.balanceOf(address(fixture.hook)) == hookBalanceBefore);
        assert(fixture.hook.collectedFee() == 0);
        assert(fixture.hook.accruedExecutedUsdg() == 0);
        assert(fixture.hook.lastExecutedUsdg() == 0);
    }

    function testPoolManagerAcceptsArbitraryHookDataInBothTokenOrders() external {
        for (uint256 order; order < 2; ++order) {
            PoolManagerFixture memory fixture = _deployPoolManagerFixture(order == 0);
            bool usdgFirst = order == 0;
            BalanceDelta delta = fixture.swapRouter
                .swap(
                    fixture.key,
                    SwapParams({
                        zeroForOne: usdgFirst,
                        amountSpecified: -int256(100_000),
                        sqrtPriceLimitX96: usdgFirst
                            ? TickMath.MIN_SQRT_PRICE + 1
                            : TickMath.MAX_SQRT_PRICE - 1
                    }),
                    PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                    abi.encode(address(0xBEEF), bytes32(uint256(order)))
                );
            int128 hkmnDelta = usdgFirst ? delta.amount1() : delta.amount0();
            assert(hkmnDelta > 0);
            assert(fixture.hook.accruedExecutedUsdg() == 100_000);
            assert(fixture.hook.collectedFee() == 3_000);
        }
    }

    function testPoolManagerTreatsHookDataVariantsIdentically() external {
        PoolManagerSwapOutcome memory absent = _observePoolManagerSwap(bytes(""));
        PoolManagerSwapOutcome memory malformed = _observePoolManagerSwap(hex"deadbeef");
        PoolManagerSwapOutcome memory arbitrary = _observePoolManagerSwap(
            abi.encode(bytes32(uint256(0xBEEF)), address(0xCAFE), address(0xBEEF))
        );

        _assertSamePoolManagerSwapOutcome(absent, malformed);
        _assertSamePoolManagerSwapOutcome(absent, arbitrary);
        assert(absent.hookUsdgBalance == 3_000);
        assert(absent.collectedFee == 3_000);
        assert(absent.accruedExecutedUsdg == 100_000);
        assert(absent.lastExecutedUsdg == 100_000);
    }

    /// @dev The hook can never use fee collection to re-enter `PoolManager.swap` on its own
    ///      canonical pool. The inner call is attempted while the outer callback is finalizing
    ///      and must fail without preventing the authenticated outer swap from completing.
    function testSamePoolSwapDuringCollectionIsForbidden() external {
        PoolManagerFixture memory fixture = _deployPoolManagerFixture(true);
        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(10_000),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        fixture.hook.armSamePoolSwapDuringCollection(fixture.key, params, bytes("same-pool"));

        fixture.swapRouter
            .swap(
                fixture.key,
                params,
                PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                bytes("outer")
            );

        assert(fixture.hook.samePoolSwapAttempted());
        assert(!fixture.hook.samePoolSwapSucceeded());
        assert(fixture.hook.accruedExecutedUsdg() == 10_000);
        assert(fixture.hook.collectedFee() == 300);
    }

    function _assertLocalQuadrant(bool usdgFirst, bool zeroForOne, bool exactInput) private {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key, bool usdg0) =
            _deploy(usdgFirst);
        int256 specified = exactInput ? -int256(100_000) : int256(80_000);
        LocalQuadrantObservation memory observed;
        observed.specified0 = (specified < 0) == zeroForOne;
        observed.usdgSpecified = observed.specified0 == usdg0;
        observed.unspecifiedDelta = exactInput ? int128(80_000) : -int128(100_000);
        observed.netUsdg = observed.usdgSpecified
            ? uint256(specified < 0 ? -specified : specified)
            : uint256(
                observed.unspecifiedDelta < 0
                    ? -int256(observed.unspecifiedDelta)
                    : int256(observed.unspecifiedDelta)
            );
        if (exactInput) {
            observed.executedUsdg = observed.netUsdg;
            observed.fee = int128(uint128(observed.executedUsdg * 300 / 10_000));
        } else {
            uint256 feeAmount;
            (observed.executedUsdg, feeAmount) = _flatGrossForNet(observed.netUsdg);
            observed.fee = int128(uint128(feeAmount));
        }
        observed.specifiedDelta =
            int128(specified) + (observed.usdgSpecified ? observed.fee : int128(0));
        observed.amount0 = observed.specified0 ? observed.specifiedDelta : observed.unspecifiedDelta;
        observed.amount1 = observed.specified0 ? observed.unspecifiedDelta : observed.specifiedDelta;
        SwapParams memory params = SwapParams(zeroForOne, specified, 0);

        VM.prank(address(manager));
        (, BeforeSwapDelta before,) = hook.beforeSwap(address(this), key, params, bytes("before"));
        assert(before.getSpecifiedDelta() == (observed.usdgSpecified ? observed.fee : int128(0)));
        VM.prank(address(manager));
        (, int128 afterDelta) = hook.afterSwap(
            address(this),
            key,
            params,
            toBalanceDelta(observed.amount0, observed.amount1),
            bytes("after")
        );
        assert(afterDelta == (observed.usdgSpecified ? int128(0) : observed.fee));
        assert(hook.lastExecutedUsdg() == observed.executedUsdg);
        assert(hook.lastAccruedExecutedUsdg() == observed.executedUsdg);
        assert(hook.lastCollectedFee() == uint256(uint128(observed.fee)));
        assert(hook.collectionCalls() == 1);
        assert(hook.accrualCalls() == 1);
        assert(key.fee == 0);
    }

    function _flatGrossForNet(uint256 requestedNet)
        private
        pure
        returns (uint256 gross, uint256 fee)
    {
        uint256 estimate = (requestedNet * 10_000 + 9_699) / 9_700;
        uint256 candidate = estimate > 8 ? estimate - 8 : 0;
        for (uint256 i; i <= 16; ++i) {
            uint256 candidateFee = candidate * 300 / 10_000;
            if (candidate - candidateFee == requestedNet) return (candidate, candidateFee);
            ++candidate;
        }
        revert("GROSS_NOT_FOUND");
    }

    function _assertBeforeRejected(bool foreignManager, bool wrongFee, bool zeroAmount) private {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        if (wrongFee) key.fee = 1;
        SwapParams memory params = SwapParams(true, zeroAmount ? int256(0) : -int256(100), 0);
        address caller = foreignManager ? address(0xBEEF) : address(manager);
        VM.prank(caller);
        (bool ok, bytes memory reason) = address(hook)
            .call(abi.encodeCall(hook.beforeSwap, (address(this), key, params, bytes("payload"))));
        assert(!ok);
        bytes4 expected = foreignManager
            ? CanonicalMarketCallback.ForeignPoolManager.selector
            : CanonicalMarketCallback.InvalidCanonicalPoolKey.selector;
        assert(_selector(reason) == expected);
        assert(hook.collected() == 0);
        assert(hook.lastExecutedUsdg() == 0);
    }

    function _assertAfterRejected(bool changedSender, bool sameSign) private {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -100, 0);
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, bytes("before"));
        uint256 beforeCollected = hook.collected();
        VM.prank(address(manager));
        (bool ok, bytes memory reason) = address(hook)
            .call(
                abi.encodeCall(
                    hook.afterSwap,
                    (
                        changedSender ? address(0xBEEF) : address(this),
                        key,
                        params,
                        sameSign ? toBalanceDelta(-97, -80) : toBalanceDelta(0, 80),
                        bytes("after")
                    )
                )
            );
        assert(!ok);
        bytes4 expected = changedSender
            ? CanonicalMarketCallback.InvalidCanonicalPoolKey.selector
            : CanonicalMarketCallback.InvalidFinalizedSwap.selector;
        assert(_selector(reason) == expected);
        assert(hook.collected() == beforeCollected);
        assert(hook.lastExecutedUsdg() == 0);
    }

    function _assertRoundedCollection(int256 amount, uint256 expected) private {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(true, -amount, 0);
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, bytes("before"));
        int128 fee = int128(uint128(uint256(amount) * 300 / 10_000));
        VM.prank(address(manager));
        hook.afterSwap(
            address(this), key, params, toBalanceDelta(-int128(amount) + fee, 80), bytes("after")
        );
        assert(hook.collected() == expected);
    }

    function _assertUnspecifiedRoundedCollection(int256 amount, uint256 expected) private {
        (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key,) = _deploy(true);
        SwapParams memory params = SwapParams(false, -100, 0);
        VM.prank(address(manager));
        hook.beforeSwap(address(this), key, params, bytes("before"));
        VM.prank(address(manager));
        hook.afterSwap(
            address(this), key, params, toBalanceDelta(int128(amount), -100), bytes("after")
        );
        assert(hook.collected() == expected);
    }

    function _swapRejected(
        PoolSwapTest swapRouter,
        PoolKey memory key,
        SwapParams memory params,
        bytes memory hookData
    ) private returns (bool rejected) {
        try swapRouter.swap(
            key,
            params,
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            hookData
        ) returns (
            BalanceDelta
        ) { }
        catch {
            rejected = true;
        }
    }

    function _observePoolManagerSwap(bytes memory hookData)
        private
        returns (PoolManagerSwapOutcome memory outcome)
    {
        PoolManagerFixture memory fixture = _deployPoolManagerFixture(true);
        BalanceDelta delta = fixture.swapRouter
            .swap(
                fixture.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(100_000),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                hookData
            );
        outcome = PoolManagerSwapOutcome({
            amount0: delta.amount0(),
            amount1: delta.amount1(),
            hookUsdgBalance: fixture.token0.balanceOf(address(fixture.hook)),
            collectedFee: fixture.hook.collectedFee(),
            accruedExecutedUsdg: fixture.hook.accruedExecutedUsdg(),
            lastExecutedUsdg: fixture.hook.lastExecutedUsdg(),
            lastRawPoolUsdgDelta: fixture.hook.lastRawPoolUsdgDelta()
        });
    }

    function _assertSamePoolManagerSwapOutcome(
        PoolManagerSwapOutcome memory expected,
        PoolManagerSwapOutcome memory actual
    ) private pure {
        assert(expected.amount0 == actual.amount0);
        assert(expected.amount1 == actual.amount1);
        assert(expected.hookUsdgBalance == actual.hookUsdgBalance);
        assert(expected.collectedFee == actual.collectedFee);
        assert(expected.accruedExecutedUsdg == actual.accruedExecutedUsdg);
        assert(expected.lastExecutedUsdg == actual.lastExecutedUsdg);
        assert(expected.lastRawPoolUsdgDelta == actual.lastRawPoolUsdgDelta);
    }

    function _deployPoolManagerFixture(bool usdgFirst)
        private
        returns (PoolManagerFixture memory fixture)
    {
        PoolManager manager = new PoolManager(address(this));
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(manager);
        PoolSwapTest swapRouter = new PoolSwapTest(manager);
        MarketTestToken first = new MarketTestToken();
        MarketTestToken second = new MarketTestToken();
        (MarketTestToken token0, MarketTestToken token1) =
            address(first) < address(second) ? (first, second) : (second, first);
        Currency usdg = Currency.wrap(address(usdgFirst ? token0 : token1));
        Currency hkmn = Currency.wrap(address(usdgFirst ? token1 : token0));
        SettlementCanonicalMarketHook hook =
            new SettlementCanonicalMarketHookDeployer().deploy(manager, usdg, hkmn);
        PoolKey memory key = PoolKey(
            Currency.wrap(address(token0)),
            Currency.wrap(address(token1)),
            0,
            60,
            IHooks(address(hook))
        );

        token0.mint(address(this), 10 ** 30);
        token1.mint(address(this), 10 ** 30);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);
        manager.initialize(key, 1 << 96);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -120, tickUpper: 120, liquidityDelta: 10 ** 18, salt: bytes32(0)
            }),
            ""
        );
        fixture = PoolManagerFixture({
            manager: manager,
            liquidityRouter: liquidityRouter,
            swapRouter: swapRouter,
            hook: hook,
            key: key,
            token0: token0,
            token1: token1,
            usdg: usdg
        });
    }

    function _deploy(bool usdgFirst)
        private
        returns (PoolManager manager, LocalCanonicalMarketHook hook, PoolKey memory key, bool usdg0)
    {
        manager = new PoolManager(address(this));
        Currency first = Currency.wrap(address(0x1000));
        Currency second = Currency.wrap(address(0x2000));
        Currency usdg = usdgFirst ? first : second;
        Currency hkmn = usdgFirst ? second : first;
        hook = new LocalCanonicalMarketHookDeployer().deploy(manager, usdg, hkmn);
        key = PoolKey(first, second, 0, 60, IHooks(address(hook)));
        usdg0 = usdgFirst;
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }
}
