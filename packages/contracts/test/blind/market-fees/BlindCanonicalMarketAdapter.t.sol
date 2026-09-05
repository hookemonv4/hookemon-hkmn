// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { BaseTestHooks } from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import { BalanceDelta, toBalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { CanonicalMarketCallback } from "../../../src/market/CanonicalMarket.sol";
import {
    BlindAmountMode,
    BlindCallbackStage,
    BlindDeploymentConfig,
    BlindFeeSplit,
    BlindMarketFeesFixture,
    BlindPoolKey,
    BlindSwapRequest,
    BlindSwapResult,
    BlindSwapSide,
    BlindTokenOrder,
    IBlindCanonicalMarketSubject
} from "./fixtures/BlindMarketFeesFixture.sol";

interface BlindVm {
    function prank(address sender) external;
}

contract BlindPoolManagerStub {
    uint24 private protocolFee;
    uint24 private lpFee;

    function setLiveFees(uint24 protocolFee_, uint24 lpFee_) external {
        protocolFee = protocolFee_;
        lpFee = lpFee_;
    }

    function extsload(bytes32) external view returns (bytes32 value) {
        value = bytes32(uint256(1 << 96) | (uint256(protocolFee) << 184) | (uint256(lpFee) << 208));
    }
}

contract BlindCanonicalMarketHook is BaseTestHooks, CanonicalMarketCallback {
    BlindVm private constant VM = BlindVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public collected;
    uint256 public accrualCalls;
    uint256 public lastAccruedExecutedUsdg;
    bool private reenter;
    address private reentrySender;
    PoolKey private reentryKey;
    SwapParams private reentryParams;
    BalanceDelta private reentryDelta;
    bytes private reentryData;

    error NestedFinalizationAccepted();
    error NestedFinalizationWrongRevert(bytes4 selector);
    error NestedFinalizationRejected();

    constructor(IPoolManager manager, Currency usdg, Currency hkmn)
        CanonicalMarketCallback(manager, usdg, hkmn, 60)
    { }

    function armNestedFinalization(
        address sender,
        PoolKey memory key,
        SwapParams memory params,
        BalanceDelta delta,
        bytes memory data
    ) external {
        reenter = true;
        reentrySender = sender;
        reentryKey = key;
        reentryParams = params;
        reentryDelta = delta;
        reentryData = data;
    }

    function _collectFee(Currency, uint256 feeAmount)
        internal
        override
        returns (uint256 balanceBeforeCollection)
    {
        if (reenter) {
            reenter = false;
            VM.prank(address(poolManager));
            (bool accepted, bytes memory reason) = address(this)
                .call(
                    abi.encodeCall(
                        this.afterSwap,
                        (reentrySender, reentryKey, reentryParams, reentryDelta, reentryData)
                    )
                );
            if (accepted) revert NestedFinalizationAccepted();
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(reason, 0x20))
            }
            if (selector != CanonicalMarketCallback.ReentrantCallback.selector) {
                revert NestedFinalizationWrongRevert(selector);
            }
            revert NestedFinalizationRejected();
        }
        balanceBeforeCollection = collected;
        collected += feeAmount;
    }

    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        override
    {
        assert(collected - balanceBeforeCollection == _previewTotalFee(executedUsdg));
        ++accrualCalls;
        lastAccruedExecutedUsdg = executedUsdg;
    }

    function _previewTotalFee(uint256 executedUsdg) internal pure override returns (uint256) {
        return executedUsdg * 10 / 10_000 + executedUsdg * 40 / 10_000 + executedUsdg * 250 / 10_000;
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

contract BlindCanonicalMarketAdapter is IBlindCanonicalMarketSubject {
    using PoolIdLibrary for PoolKey;

    BlindVm private constant VM = BlindVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    BlindPoolManagerStub public immutable manager;
    BlindCanonicalMarketHook public immutable hook;
    Currency private immutable usdg;
    Currency private immutable hkmn;
    PoolKey private key;
    error BlindPoolIdMismatch();
    error BlindDeltaOutOfBounds();

    constructor(BlindDeploymentConfig memory config) {
        manager = new BlindPoolManagerStub();
        usdg = Currency.wrap(config.usdg);
        hkmn = Currency.wrap(config.hkmn);
        hook = new BlindCanonicalMarketHook(IPoolManager(address(manager)), usdg, hkmn);
        key = PoolKey(
            Currency.wrap(config.canonicalPoolKey.currency0),
            Currency.wrap(config.canonicalPoolKey.currency1),
            0,
            60,
            IHooks(address(hook))
        );
    }

    function executeFinalizedSwap(BlindSwapRequest calldata request)
        external
        returns (BlindSwapResult memory result)
    {
        manager.setLiveFees(request.liveProtocolFee, request.liveLpFee);
        PoolKey memory callbackKey = PoolKey(
            Currency.wrap(request.poolKey.currency0),
            Currency.wrap(request.poolKey.currency1),
            request.poolKey.staticLpFee,
            request.poolKey.tickSpacing,
            IHooks(request.poolKey.hooks)
        );
        if (request.poolKey.poolId != PoolId.unwrap(callbackKey.toId())) {
            revert BlindPoolIdMismatch();
        }
        SwapParams memory params = _params(request);
        BalanceDelta delta = _rawDelta(request, params);
        bytes memory beforeData = abi.encode(request.operationId, request.recipient);
        bytes memory afterData =
            abi.encode(request.finalizedOperationId, request.finalizedRecipient);

        if (request.callbackStage == BlindCallbackStage.BeforeSwap) {
            VM.prank(request.callbackCaller);
            hook.afterSwap(request.finalizedSender, callbackKey, params, delta, afterData);
        }

        VM.prank(request.callbackCaller);
        hook.beforeSwap(request.callbackSender, callbackKey, params, beforeData);
        if (request.attemptsReentry) {
            hook.armNestedFinalization(
                request.finalizedSender, callbackKey, params, delta, afterData
            );
        }
        VM.prank(request.callbackCaller);
        hook.afterSwap(request.finalizedSender, callbackKey, params, delta, afterData);

        result.executedUsdg = hook.lastExecutedUsdg();
        result.traderUsdgDelta = _currencyDelta(request, Currency.unwrap(usdg));
        result.traderHkmnDelta = _currencyDelta(request, Currency.unwrap(hkmn));
        result.actualCollectedUsdg = hook.collected();
        result.fee = _split(result.executedUsdg);
    }

    function canonicalPoolKey() external view returns (BlindPoolKey memory result) {
        result = BlindPoolKey({
            currency0: Currency.unwrap(key.currency0),
            currency1: Currency.unwrap(key.currency1),
            staticLpFee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: address(key.hooks),
            poolId: PoolId.unwrap(key.toId())
        });
    }

    function tokenBalance(address, address) external pure returns (uint256) {
        return 0;
    }

    function economicsDigest() external view returns (bytes32) {
        return keccak256(
            abi.encode(
                hook.collected(),
                hook.accrualCalls(),
                hook.lastAccruedExecutedUsdg(),
                hook.lastExecutedUsdg()
            )
        );
    }

    function _params(BlindSwapRequest calldata request)
        private
        view
        returns (SwapParams memory params)
    {
        address input =
            request.side == BlindSwapSide.Buy ? Currency.unwrap(usdg) : Currency.unwrap(hkmn);
        bool zeroForOne = request.poolKey.currency0 == input;
        int256 amountSpecified = request.amountMode == BlindAmountMode.ExactInput
            ? (zeroForOne ? request.currency0TraderDelta : request.currency1TraderDelta)
            : (zeroForOne ? request.currency1TraderDelta : request.currency0TraderDelta);
        params = SwapParams(zeroForOne, amountSpecified, 0);
    }

    function _rawDelta(BlindSwapRequest calldata request, SwapParams memory params)
        private
        view
        returns (BalanceDelta)
    {
        if (
            request.currency0TraderDelta < type(int128).min
                || request.currency0TraderDelta > type(int128).max
                || request.currency1TraderDelta < type(int128).min
                || request.currency1TraderDelta > type(int128).max
        ) revert BlindDeltaOutOfBounds();
        int128 amount0 = int128(request.currency0TraderDelta);
        int128 amount1 = int128(request.currency1TraderDelta);
        bool specified0 = (params.amountSpecified < 0) == params.zeroForOne;
        bool usdgSpecified = (specified0 ? request.poolKey.currency0 : request.poolKey.currency1)
            == Currency.unwrap(usdg);
        if (usdgSpecified) {
            int128 fee = int128(uint128(_split(_absolute(params.amountSpecified)).total));
            if (specified0) amount0 += fee;
            else amount1 += fee;
        }
        int128 mutation = request.finalizedSpecifiedDeltaMutation;
        if (!request.fullFill && mutation == 0) mutation = 1;
        if (specified0) amount0 += mutation;
        else amount1 += mutation;
        return toBalanceDelta(amount0, amount1);
    }

    function _currencyDelta(BlindSwapRequest calldata request, address currency)
        private
        pure
        returns (int256)
    {
        return request.poolKey.currency0 == currency
            ? request.currency0TraderDelta
            : request.currency1TraderDelta;
    }

    function _split(uint256 executedUsdg) private pure returns (BlindFeeSplit memory fee) {
        fee.programmable = executedUsdg * 10 / 10_000;
        fee.treasury = executedUsdg * 40 / 10_000;
        fee.process = executedUsdg * 250 / 10_000;
        fee.total = fee.programmable + fee.treasury + fee.process;
    }

    function _absolute(int256 value) private pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }
}

contract BlindCanonicalMarketConcreteAcceptance {
    error BlindExpectedGrossNotFound();

    enum Mutation {
        ForeignManager,
        SenderMismatch,
        WrongStage,
        PartialFill,
        FeeDelta,
        NestedFinalization,
        StaticLpFee,
        LiveProtocolFee,
        LiveLpFee,
        CurrencyOrder,
        TickSpacing,
        HookAddress,
        PoolId,
        ZeroOutput,
        SameSignDeltas,
        OutOfBoundsDelta
    }

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant TOTAL_FEE_BPS = 300;
    uint256 private constant MINIMUM_GROSS_USDG = 1_000;
    uint256 private constant EXACT_OUTPUT_SCAN_RADIUS = 8;
    uint256 private constant EXECUTED_USDG = 10_000;
    uint256 private constant HKMN_AMOUNT = 420_690;

    function testBlindAdapterAcceptsEveryBuyQuadrantWithArbitraryPayloadValues() external {
        for (uint256 order; order < 2; ++order) {
            for (uint256 mode; mode < 2; ++mode) {
                (
                    BlindMarketFeesFixture fixture,
                    BlindDeploymentConfig memory config,
                    BlindCanonicalMarketAdapter adapter
                ) = _deploy(BlindTokenOrder(order));
                BlindSwapRequest memory request = fixture.swapRequest(
                    config, BlindSwapSide.Buy, BlindAmountMode(mode), EXECUTED_USDG, HKMN_AMOUNT
                );
                request.recipient = address(0xBEEF);
                request.finalizedRecipient = address(0xCAFE);
                request.operationId = keccak256(abi.encode("before", order, mode));
                request.finalizedOperationId = keccak256(abi.encode("after", order, mode));

                (uint256 expectedGross, BlindFeeSplit memory expectedFee) =
                    _expectedBuyResult(BlindAmountMode(mode), EXECUTED_USDG);
                BlindSwapResult memory result = adapter.executeFinalizedSwap(request);
                assert(result.executedUsdg == expectedGross);
                assert(result.actualCollectedUsdg == expectedFee.total);
                assert(result.fee.total == expectedFee.total);
                assert(result.fee.programmable == expectedFee.programmable);
                assert(result.fee.treasury == expectedFee.treasury);
                assert(result.fee.process == expectedFee.process);
                if (BlindAmountMode(mode) == BlindAmountMode.ExactOutput) {
                    assert(result.executedUsdg - result.actualCollectedUsdg == EXECUTED_USDG);
                }
            }
        }
    }

    /// @dev Each quadrant deploys a fresh adapter, so the independent three-stream oracle starts
    ///      each stream with a zero lifetime remainder.
    function _expectedBuyResult(BlindAmountMode mode, uint256 requestedNet)
        private
        pure
        returns (uint256 expectedGross, BlindFeeSplit memory expectedFee)
    {
        if (mode == BlindAmountMode.ExactInput) {
            expectedGross = requestedNet;
            return (expectedGross, _independentSplit(expectedGross));
        }
        return _firstGrossForExactOutput(requestedNet);
    }

    function _firstGrossForExactOutput(uint256 requestedNet)
        private
        pure
        returns (uint256 gross, BlindFeeSplit memory fee)
    {
        uint256 netRate = BPS_DENOMINATOR - TOTAL_FEE_BPS;
        uint256 estimate = (requestedNet * BPS_DENOMINATOR + netRate - 1) / netRate;
        uint256 candidate = estimate > EXACT_OUTPUT_SCAN_RADIUS
            ? estimate - EXACT_OUTPUT_SCAN_RADIUS
            : MINIMUM_GROSS_USDG;
        if (candidate < MINIMUM_GROSS_USDG) candidate = MINIMUM_GROSS_USDG;
        uint256 lastCandidate = estimate + EXACT_OUTPUT_SCAN_RADIUS;

        for (; candidate <= lastCandidate; ++candidate) {
            fee = _independentSplit(candidate);
            if (candidate - fee.total == requestedNet) return (candidate, fee);
        }
        revert BlindExpectedGrossNotFound();
    }

    function _independentSplit(uint256 gross) private pure returns (BlindFeeSplit memory fee) {
        fee.programmable = gross * 10 / BPS_DENOMINATOR;
        fee.treasury = gross * 40 / BPS_DENOMINATOR;
        fee.process = gross * 250 / BPS_DENOMINATOR;
        fee.total = fee.programmable + fee.treasury + fee.process;
    }

    function testBlindAdapterIgnoresZeroRecipientAndOperationPayloadValues() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            BlindCanonicalMarketAdapter adapter
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, EXECUTED_USDG, HKMN_AMOUNT
        );
        request.recipient = address(0);
        request.finalizedRecipient = address(0);
        request.operationId = bytes32(0);
        request.finalizedOperationId = bytes32(0);

        BlindSwapResult memory result = adapter.executeFinalizedSwap(request);
        assert(result.executedUsdg == EXECUTED_USDG);
        assert(result.actualCollectedUsdg == result.fee.total);
    }

    function testBlindAdapterIgnoresRecipientAndOperationPayloadValues() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();
        BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder.UsdgCurrency0);
        BlindCanonicalMarketAdapter adapter = new BlindCanonicalMarketAdapter(config);
        config.manager = address(adapter.manager());
        config.hooks = address(adapter.hook());
        config.canonicalPoolKey = adapter.canonicalPoolKey();
        BlindSwapRequest memory request = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, 10_000, 420_690
        );
        request.finalizedOperationId = keccak256("different operation");
        request.finalizedRecipient = address(0xBEEF);

        BlindSwapResult memory result = adapter.executeFinalizedSwap(request);

        assert(result.executedUsdg == 10_000);
        assert(result.actualCollectedUsdg == 300);
        assert(result.fee.total == 300);
    }

    function testBlindAdapterRejectsAChangedAuthenticatedSender() external {
        BlindMarketFeesFixture fixture = new BlindMarketFeesFixture();
        BlindDeploymentConfig memory config = fixture.configuration(BlindTokenOrder.UsdgCurrency0);
        BlindCanonicalMarketAdapter adapter = new BlindCanonicalMarketAdapter(config);
        config.manager = address(adapter.manager());
        config.hooks = address(adapter.hook());
        config.canonicalPoolKey = adapter.canonicalPoolKey();
        BlindSwapRequest memory request = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, 10_000, 420_690
        );
        request.finalizedSender = address(0xBEEF);

        (bool accepted,) =
            address(adapter).call(abi.encodeCall(adapter.executeFinalizedSwap, (request)));
        assert(!accepted);
    }

    function testBlindAdapterRejectsCallbackContextMutationsWithoutEconomicsMutation() external {
        _assertRejected(Mutation.ForeignManager);
        _assertRejected(Mutation.SenderMismatch);
        _assertRejected(Mutation.WrongStage);
    }

    function testBlindAdapterRejectsFullFillAndNestedFinalizationWithoutMutation() external {
        _assertRejected(Mutation.PartialFill);
        _assertRejected(Mutation.FeeDelta);
        _assertRejected(Mutation.NestedFinalization);
    }

    function testBlindAdapterRejectsStaticLiveAndPoolKeyFeeVectorsWithoutMutation() external {
        _assertRejected(Mutation.StaticLpFee);
        _assertRejected(Mutation.LiveProtocolFee);
        _assertRejected(Mutation.LiveLpFee);
    }

    function testBlindAdapterRejectsPoolKeyAndDeltaMutationsWithoutMutation() external {
        _assertRejected(Mutation.CurrencyOrder);
        _assertRejected(Mutation.TickSpacing);
        _assertRejected(Mutation.HookAddress);
        _assertRejected(Mutation.PoolId);
        _assertRejected(Mutation.ZeroOutput);
        _assertRejected(Mutation.SameSignDeltas);
        _assertRejected(Mutation.OutOfBoundsDelta);
    }

    function _assertRejected(Mutation mutation) private {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            BlindCanonicalMarketAdapter adapter
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, EXECUTED_USDG, HKMN_AMOUNT
        );
        if (mutation == Mutation.ForeignManager) {
            request.callbackCaller = address(0xDEAD);
        } else if (mutation == Mutation.SenderMismatch) {
            request.finalizedSender = address(0xDEAD);
        } else if (mutation == Mutation.WrongStage) {
            request.callbackStage = BlindCallbackStage.BeforeSwap;
        } else if (mutation == Mutation.PartialFill) {
            request.fullFill = false;
        } else if (mutation == Mutation.FeeDelta) {
            request.finalizedSpecifiedDeltaMutation = 1;
        } else if (mutation == Mutation.NestedFinalization) {
            request.attemptsReentry = true;
        } else if (mutation == Mutation.StaticLpFee) {
            request.poolKey.staticLpFee = 1;
            request.poolKey.poolId = _poolId(request.poolKey);
        } else if (mutation == Mutation.LiveProtocolFee) {
            request.liveProtocolFee = 1;
        } else if (mutation == Mutation.LiveLpFee) {
            request.liveLpFee = 1;
        } else if (mutation == Mutation.CurrencyOrder) {
            (request.poolKey.currency0, request.poolKey.currency1) =
            (request.poolKey.currency1, request.poolKey.currency0);
            request.poolKey.poolId = _poolId(request.poolKey);
        } else if (mutation == Mutation.TickSpacing) {
            request.poolKey.tickSpacing += 1;
            request.poolKey.poolId = _poolId(request.poolKey);
        } else if (mutation == Mutation.HookAddress) {
            request.poolKey.hooks = address(0xDEAD);
            request.poolKey.poolId = _poolId(request.poolKey);
        } else if (mutation == Mutation.PoolId) {
            request.poolKey.poolId = bytes32(uint256(request.poolKey.poolId) ^ 1);
        } else if (mutation == Mutation.ZeroOutput) {
            request.currency1TraderDelta = 0;
        } else if (mutation == Mutation.SameSignDeltas) {
            request.currency1TraderDelta = -int256(HKMN_AMOUNT);
        } else if (mutation == Mutation.OutOfBoundsDelta) {
            request.currency1TraderDelta = int256(1 << 128) + int256(HKMN_AMOUNT);
        }

        bytes32 beforeDigest = adapter.economicsDigest();
        (bool accepted,) =
            address(adapter).call(abi.encodeCall(adapter.executeFinalizedSwap, (request)));
        assert(!accepted);
        assert(adapter.economicsDigest() == beforeDigest);
    }

    function _deploy(BlindTokenOrder order)
        private
        returns (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            BlindCanonicalMarketAdapter adapter
        )
    {
        fixture = new BlindMarketFeesFixture();
        config = fixture.configuration(order);
        adapter = new BlindCanonicalMarketAdapter(config);
        config.manager = address(adapter.manager());
        config.hooks = address(adapter.hook());
        config.canonicalPoolKey = adapter.canonicalPoolKey();
    }

    function _poolId(BlindPoolKey memory poolKey) private pure returns (bytes32) {
        return PoolId.unwrap(
            PoolIdLibrary.toId(
                PoolKey(
                    Currency.wrap(poolKey.currency0),
                    Currency.wrap(poolKey.currency1),
                    poolKey.staticLpFee,
                    poolKey.tickSpacing,
                    IHooks(poolKey.hooks)
                )
            )
        );
    }
}
