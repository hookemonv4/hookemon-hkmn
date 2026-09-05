// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "@uniswap/v4-core/lib/forge-std/src/Test.sol";
import { Vm } from "@uniswap/v4-core/lib/forge-std/src/Vm.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { CustomRevert } from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { Currency, CurrencyLibrary } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";
import { MoneyRoles } from "../../src/access/MoneyRoles.sol";
import { RobinhoodBindings } from "../../src/bindings/RobinhoodBindings.sol";
import { HookemonHook } from "../../src/HookemonHook.sol";
import { CanonicalMarketCallback } from "../../src/market/CanonicalMarket.sol";

contract HookToken {
    enum TransferReturn {
        True,
        False,
        Empty,
        Short,
        Excess
    }

    enum TransferBalance {
        Exact,
        None,
        Short,
        Excess
    }

    mapping(address account => uint256) private balances;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;
    TransferReturn public transferReturn;
    TransferBalance public transferBalance;
    bool public balanceReturnsMalformed;

    function balanceOf(address account) external view returns (uint256) {
        if (balanceReturnsMalformed) assembly ("memory-safe") { return(0, 0) }
        return balances[account];
    }

    function setTransferReturn(TransferReturn value) external {
        transferReturn = value;
    }

    function setTransferBalance(TransferBalance value) external {
        transferBalance = value;
    }

    function setBalanceReturnsMalformed(bool value) external {
        balanceReturnsMalformed = value;
    }

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        TransferReturn active = transferReturn;
        if (active == TransferReturn.False) return false;
        uint256 moved = amount;
        if (transferBalance == TransferBalance.None) moved = 0;
        if (transferBalance == TransferBalance.Short) moved = amount - 1;
        if (transferBalance == TransferBalance.Excess) moved = amount + 1;
        balances[msg.sender] -= moved;
        balances[recipient] += moved;
        if (active == TransferReturn.Empty) assembly ("memory-safe") { return(0, 0) }
        if (active == TransferReturn.Short) {
            assembly ("memory-safe") {
                mstore(0, 1)
                return(31, 1)
            }
        }
        if (active == TransferReturn.Excess) {
            assembly ("memory-safe") {
                mstore(0, 1)
                mstore(32, 0)
                return(0, 64)
            }
        }
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = allowance[sender][msg.sender];
        if (approved != type(uint256).max) allowance[sender][msg.sender] = approved - amount;
        balances[sender] -= amount;
        balances[recipient] += amount;
        return true;
    }
}

contract HookFactory {
    IPoolManager private immutable manager;
    address private immutable positionManager;
    address private immutable permit2;
    Currency private immutable usdg;
    Currency private immutable hkmn;
    int24 private immutable tickSpacing;
    address private immutable programmable;
    address private immutable treasury;
    address private immutable operations;
    address private immutable launchAuthority;
    address private immutable issuanceAuthority;
    uint8 private immutable expectedDecimals;
    bytes32 private immutable bindingDigest;
    bytes32 private immutable runtimeDigest;
    uint256 private immutable processClaimLimit6h;
    uint256 private immutable processClaimLimitMax;
    uint256 private immutable processClaimMaxCount;
    uint256 private immutable operationsRotationDelay;

    constructor(HookemonHook.ConstructorConfig memory config) {
        manager = config.manager;
        positionManager = config.positionManager;
        permit2 = config.permit2;
        usdg = config.usdg;
        hkmn = config.hkmn;
        tickSpacing = config.tickSpacing;
        programmable = config.programmable;
        treasury = config.treasury;
        operations = config.operations;
        launchAuthority = config.launchAuthority;
        issuanceAuthority = config.issuanceAuthority;
        expectedDecimals = config.expectedDecimals;
        bindingDigest = config.bindingDigest;
        runtimeDigest = config.runtimeDigest;
        processClaimLimit6h = config.processClaimLimit6h;
        processClaimLimitMax = config.processClaimLimitMax;
        processClaimMaxCount = config.processClaimMaxCount;
        operationsRotationDelay = config.operationsRotationDelay;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(HookemonHook).creationCode,
                abi.encode(
                    HookemonHook.ConstructorConfig({
                        manager: manager,
                        positionManager: positionManager,
                        permit2: permit2,
                        usdg: usdg,
                        hkmn: hkmn,
                        tickSpacing: tickSpacing,
                        programmable: programmable,
                        treasury: treasury,
                        operations: operations,
                        launchAuthority: launchAuthority,
                        issuanceAuthority: issuanceAuthority,
                        expectedDecimals: expectedDecimals,
                        bindingDigest: bindingDigest,
                        runtimeDigest: runtimeDigest,
                        processClaimLimit6h: processClaimLimit6h,
                        processClaimLimitMax: processClaimLimitMax,
                        processClaimMaxCount: processClaimMaxCount,
                        operationsRotationDelay: operationsRotationDelay
                    })
                )
            )
        );
    }

    function deploy(bytes32 salt) external returns (HookemonHook) {
        return new HookemonHook{ salt: salt }(
            HookemonHook.ConstructorConfig({
                manager: manager,
                positionManager: positionManager,
                permit2: permit2,
                usdg: usdg,
                hkmn: hkmn,
                tickSpacing: tickSpacing,
                programmable: programmable,
                treasury: treasury,
                operations: operations,
                launchAuthority: launchAuthority,
                issuanceAuthority: issuanceAuthority,
                expectedDecimals: expectedDecimals,
                bindingDigest: bindingDigest,
                runtimeDigest: runtimeDigest,
                processClaimLimit6h: processClaimLimit6h,
                processClaimLimitMax: processClaimLimitMax,
                processClaimMaxCount: processClaimMaxCount,
                operationsRotationDelay: operationsRotationDelay
            })
        );
    }
}

contract HookemonHookTest is Test {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    uint160 private constant REQUIRED_MASK = 0x20CC;
    uint160 private constant ALL_MASK = (1 << 14) - 1;
    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS = address(0x7000);
    address private constant AUTHORITY = address(0xA11CE);
    bytes32 private constant BINDING_DIGEST = keccak256("local-binding");
    bytes32 private constant RUNTIME_DIGEST = keccak256("local-runtime");
    bytes32 private constant POOL_SWAP_EVENT =
        keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    PoolManager private manager;
    PoolModifyLiquidityTest private liquidityRouter;
    PoolSwapTest private swapRouter;
    HookToken private token0;
    HookToken private token1;
    Currency private currency0;
    Currency private currency1;

    struct LiabilitySnapshot {
        uint256 programmable;
        uint256 treasury;
        uint256 process;
        uint256 total;
        uint256 hookUsdgBalance;
        uint256 callerUsdgBalance;
        uint256 managerUsdgBalance;
    }

    function setUp() public {
        manager = new PoolManager(address(this));
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);
        HookToken first = new HookToken();
        HookToken second = new HookToken();
        (token0, token1) = address(first) < address(second) ? (first, second) : (second, first);
        currency0 = Currency.wrap(address(token0));
        currency1 = Currency.wrap(address(token1));
        token0.mint(address(this), 10 ** 30);
        token1.mint(address(this), 10 ** 30);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);
    }

    function testPermissionsAreExactlyTwentyCC() external {
        HookemonHook hook = _deployHook(currency0);
        Hooks.Permissions memory permissions = hook.getHookPermissions();
        assertTrue(permissions.beforeSwap);
        assertTrue(permissions.afterSwap);
        assertTrue(permissions.beforeSwapReturnDelta);
        assertTrue(permissions.afterSwapReturnDelta);
        assertTrue(permissions.beforeInitialize);
        assertFalse(permissions.afterInitialize);
        assertFalse(permissions.beforeAddLiquidity);
        assertFalse(permissions.afterAddLiquidity);
        assertFalse(permissions.beforeRemoveLiquidity);
        assertFalse(permissions.afterRemoveLiquidity);
        assertFalse(permissions.beforeDonate);
        assertFalse(permissions.afterDonate);
        assertFalse(permissions.afterAddLiquidityReturnDelta);
        assertFalse(permissions.afterRemoveLiquidityReturnDelta);
        assertEq(hook.hookPermissionMask(), REQUIRED_MASK);
        assertEq(uint160(address(hook)) & ALL_MASK, REQUIRED_MASK);
        Hooks.validateHookPermissions(IHooks(address(hook)), permissions);
    }

    function testConstructorRejectsWrongAddressPermissionMask() external {
        HookFactory factory = _factory(currency0);
        bytes32 hash = factory.initCodeHash();
        bytes32 salt;
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 candidate = bytes32(nonce);
            address predicted = vm.computeCreate2Address(candidate, hash, address(factory));
            if ((uint160(predicted) & ALL_MASK) != REQUIRED_MASK) {
                salt = candidate;
                break;
            }
        }
        vm.expectRevert(HookemonHook.InvalidHookAddress.selector);
        factory.deploy(salt);
    }

    function testConstructorRejectsWrongUsdgOnRobinhood() external {
        HookFactory factory = _factory(currency0);
        bytes32 salt = _validHookSalt(factory);
        uint256 originalChainId = block.chainid;
        vm.chainId(4663);
        vm.expectRevert(HookemonHook.InvalidUsdgIdentity.selector);
        factory.deploy(salt);
        vm.chainId(originalChainId);
    }

    function testConstructorAcceptsBoundUsdgOnRobinhood() external {
        uint256 originalChainId = block.chainid;
        vm.chainId(RobinhoodBindings.ROBINHOOD_CHAIN_ID);
        HookFactory factory = _factory(Currency.wrap(RobinhoodBindings.ROBINHOOD_USDG));
        HookemonHook hook = factory.deploy(_validHookSalt(factory));
        vm.chainId(originalChainId);
        assertTrue(address(hook) != address(0));
    }

    function testFuzz_ConstructorRejectsEveryNonPinnedNonzeroProgrammable(address candidate)
        external
    {
        vm.assume(candidate != address(0));
        vm.assume(candidate != RobinhoodBindings.PROGRAMMABLE_BENEFICIARY);

        HookemonHook.ConstructorConfig memory config = _config(currency0);
        config.programmable = candidate;

        vm.expectRevert(HookemonHook.InvalidConstructorConfig.selector);
        new HookemonHook(config);
    }

    function testConstructorRejectsMissingKernelAddressesAndInvalidClaimLimits() external {
        HookemonHook.ConstructorConfig memory config = _config(currency0);
        config.positionManager = address(0);
        _expectConfigRevert(config, HookemonHook.InvalidConstructorConfig.selector);

        config = _config(currency0);
        config.permit2 = address(0);
        _expectConfigRevert(config, HookemonHook.InvalidConstructorConfig.selector);

        config = _config(currency0);
        config.launchAuthority = address(0);
        _expectConfigRevert(config, HookemonHook.InvalidConstructorConfig.selector);

        config = _config(currency0);
        config.processClaimLimit6h = config.processClaimLimitMax + 1;
        _expectConfigRevert(config, HookemonHook.InvalidProcessClaimConfig.selector);

        config = _config(currency0);
        config.processClaimMaxCount = 0;
        _expectConfigRevert(config, HookemonHook.InvalidProcessClaimConfig.selector);

        config = _config(currency0);
        config.processClaimMaxCount = 65;
        _expectConfigRevert(config, HookemonHook.InvalidProcessClaimConfig.selector);

        config = _config(currency0);
        config.operationsRotationDelay = 0;
        _expectConfigRevert(config, HookemonHook.InvalidProcessClaimConfig.selector);

        config = _config(currency0);
        config.operationsRotationDelay = 30 days + 1;
        _expectConfigRevert(config, HookemonHook.InvalidProcessClaimConfig.selector);
    }

    function testConstructorStoresKernelConfiguration() external {
        HookemonHook hook = _deployHook(currency0);
        assertEq(hook.positionManager(), address(0x1001));
        assertEq(hook.permit2(), address(0x1002));
        assertEq(hook.launchAuthority(), AUTHORITY);
        assertEq(hook.processClaimLimit6h(), 1_000_000);
        assertEq(hook.processClaimLimitMax(), 2_000_000);
        assertEq(hook.processClaimMaxCount(), 8);
        assertEq(hook.operationsRotationDelay(), 3 days);
    }

    function testDirectCallbacksAndUnusedCallbacksReject() external {
        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _key(hook);
        SwapParams memory params = SwapParams(true, -100, TickMath.MIN_SQRT_PRICE + 1);
        bytes memory data = _hookData(address(this));
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.beforeSwap(address(swapRouter), key, params, data);
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.afterSwap(address(swapRouter), key, params, BalanceDelta.wrap(0), data);

        vm.expectRevert(HookemonHook.InitializationNotAuthorized.selector);
        hook.beforeInitialize(address(this), key, 1 << 96);
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.afterInitialize(address(this), key, 1 << 96, 0);
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.beforeAddLiquidity(
            address(this), key, ModifyLiquidityParams(-120, 120, 1, bytes32(0)), data
        );
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.afterAddLiquidity(
            address(this),
            key,
            ModifyLiquidityParams(-120, 120, 1, bytes32(0)),
            BalanceDelta.wrap(0),
            BalanceDelta.wrap(0),
            data
        );
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.beforeRemoveLiquidity(
            address(this), key, ModifyLiquidityParams(-120, 120, -1, bytes32(0)), data
        );
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.afterRemoveLiquidity(
            address(this),
            key,
            ModifyLiquidityParams(-120, 120, -1, bytes32(0)),
            BalanceDelta.wrap(0),
            BalanceDelta.wrap(0),
            data
        );
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.beforeDonate(address(this), key, 1, 1, data);
        vm.expectRevert(CanonicalMarketCallback.ForeignPoolManager.selector);
        hook.afterDonate(address(this), key, 1, 1, data);

        vm.expectRevert(HookemonHook.InitializationNotAuthorized.selector);
        vm.prank(address(manager));
        hook.beforeInitialize(address(this), key, 1 << 96);
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.afterInitialize(address(this), key, 1 << 96, 0);
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.beforeAddLiquidity(
            address(this), key, ModifyLiquidityParams(-120, 120, 1, bytes32(0)), data
        );
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.afterAddLiquidity(
            address(this),
            key,
            ModifyLiquidityParams(-120, 120, 1, bytes32(0)),
            BalanceDelta.wrap(0),
            BalanceDelta.wrap(0),
            data
        );
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.beforeRemoveLiquidity(
            address(this), key, ModifyLiquidityParams(-120, 120, -1, bytes32(0)), data
        );
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.afterRemoveLiquidity(
            address(this),
            key,
            ModifyLiquidityParams(-120, 120, -1, bytes32(0)),
            BalanceDelta.wrap(0),
            BalanceDelta.wrap(0),
            data
        );
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.beforeDonate(address(this), key, 1, 1, data);
        vm.expectRevert(HookemonHook.UnusedHookCallback.selector);
        vm.prank(address(manager));
        hook.afterDonate(address(this), key, 1, 1, data);
    }

    function testForeignCanonicalInitializationCannotSetPriceBeforeOrAfterDeployment() external {
        HookFactory factory = _factory(currency0);
        bytes32 salt = _validHookSalt(factory);
        address predicted = vm.computeCreate2Address(salt, factory.initCodeHash(), address(factory));
        PoolKey memory key = _keyFor(IHooks(predicted));
        uint256 managerCurrency0Before = token0.balanceOf(address(manager));
        uint256 managerCurrency1Before = token1.balanceOf(address(manager));

        vm.expectRevert(Hooks.InvalidHookResponse.selector);
        manager.initialize(key, uint160(1 << 96));
        assertEq(token0.balanceOf(address(manager)), managerCurrency0Before);
        assertEq(token1.balanceOf(address(manager)), managerCurrency1Before);

        HookemonHook hook = factory.deploy(salt);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(HookemonHook.InitializationNotAuthorized.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(key, uint160(1 << 96));
        assertFalse(hook.canonicalPoolInitialized());
        assertEq(token0.balanceOf(address(manager)), managerCurrency0Before);
        assertEq(token1.balanceOf(address(manager)), managerCurrency1Before);

        _initializeHook(hook);
        assertTrue(hook.canonicalPoolInitialized());
    }

    function testLaunchAuthorityInitializesCanonicalPoolOnlyOnce() external {
        HookemonHook hook = _deployHook(currency0);
        vm.expectRevert(HookemonHook.UnauthorizedLaunchAuthority.selector);
        hook.initializeCanonicalPool(uint160(1 << 96));

        _initializeHook(hook);
        assertTrue(hook.canonicalPoolInitialized());
        vm.expectRevert(HookemonHook.CanonicalPoolAlreadyInitialized.selector);
        vm.prank(AUTHORITY);
        hook.initializeCanonicalPool(uint160(1 << 96));
    }

    function testEightSwapQuadrantsConserveThreePercentAcrossBothTokenOrders() external {
        HookemonHook first = _deployHook(currency0);
        HookemonHook second = _deployHook(currency1);
        _exerciseFourQuadrants(first, currency0);
        _exerciseFourQuadrants(second, currency1);
    }

    /// @dev Every live callback quadrant produces observed gross USDG fragments whose cumulative
    ///      10/40/250-bps allocation matches an independent unsplit lifetime transition. The
    ///      precise 1,000/1,499 two-versus-one boundary proof lives in FeeAccounting.t.sol:
    ///      a real exact-input swap whose USDG is output can round one atomic unit below its
    ///      specified input, so those boundary values are not stable live-pool fixtures.
    function testAllEightLiveQuadrantsKeepSplitObservedGrossEquivalentToUnsplitTransition()
        external
    {
        _exerciseAllLiveQuadrantSplitProperties(2_000, 2_000);
        _exerciseAllLiveQuadrantSplitProperties(2_999, 2_999);
    }

    /// forge-config: default.fuzz.runs = 4
    function testFuzz_allEightLiveQuadrantsKeepFuzzedSplitObservedGrossEquivalentToUnsplitTransition(
        uint16 rawFirst,
        uint16 rawSecond
    ) external {
        uint256 firstAmount = 2_000 + uint256(rawFirst % 8_001);
        uint256 secondAmount = 2_000 + uint256(rawSecond % 8_001);
        _exerciseAllLiveQuadrantSplitProperties(firstAmount, secondAmount);
    }

    function testPoolManagerCollectionUsesExactBalanceDeltaForMalformedReturnData() external {
        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-120, 120, 10 ** 18, bytes32(0)), bytes("")
        );

        HookToken.TransferReturn[2] memory acceptedReturns =
            [HookToken.TransferReturn.Empty, HookToken.TransferReturn.Excess];
        HookToken.TransferBalance[3] memory rejectedBalances = [
            HookToken.TransferBalance.None,
            HookToken.TransferBalance.Short,
            HookToken.TransferBalance.Excess
        ];

        for (uint256 i; i < acceptedReturns.length; ++i) {
            token0.setTransferReturn(acceptedReturns[i]);
            for (uint256 j; j < rejectedBalances.length; ++j) {
                token0.setTransferBalance(rejectedBalances[j]);
                vm.expectRevert(
                    abi.encodeWithSelector(
                        CustomRevert.WrappedError.selector,
                        address(hook),
                        IHooks.afterSwap.selector,
                        abi.encodeWithSelector(FeeAccounting.InvalidCollectionDelta.selector),
                        abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                    )
                );
                _performSwap(key, true, -int256(10_000));
                assertEq(token0.balanceOf(address(hook)), 0);
                assertEq(hook.totalLiability(), 0);
                assertEq(hook.lastExecutedUsdg(), 0);
            }
        }

        token0.setTransferBalance(HookToken.TransferBalance.Exact);
        for (uint256 i; i < acceptedReturns.length; ++i) {
            token0.setTransferReturn(acceptedReturns[i]);
            LiabilitySnapshot memory beforeLiability = _snapshot(hook, currency0);
            vm.recordLogs();
            BalanceDelta delta = _performSwap(key, true, -int256(10_000));
            ObservedUsdgSwap memory observed = _observeUsdgSwap(
                key,
                currency0,
                delta,
                beforeLiability.callerUsdgBalance,
                beforeLiability.managerUsdgBalance,
                beforeLiability.hookUsdgBalance,
                vm.getRecordedLogs()
            );
            ExpectedSplit memory expected = _expectedSwapSplit(hook, observed.gross);
            assertEq(expected.total, observed.fee);
            assertEq(hook.lastExecutedUsdg(), observed.gross);
            _assertFeeBalance(hook, currency0, beforeLiability.hookUsdgBalance, expected);
            _assertLiabilityDelta(hook, beforeLiability, expected);
        }
    }

    function _exerciseFourQuadrants(HookemonHook hook, Currency usdg) private {
        _exerciseFourQuadrants(hook, usdg, 100_000, 80_000);
    }

    function _exerciseFourQuadrants(
        HookemonHook hook,
        Currency usdg,
        uint256 exactInput,
        uint256 exactOutput
    ) private {
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-120, 120, 10 ** 24, bytes32(0)), bytes("")
        );
        for (uint256 direction; direction < 2; ++direction) {
            for (uint256 exactness; exactness < 2; ++exactness) {
                _runQuadrant(
                    hook, key, usdg, direction == 0, exactness == 0, exactInput, exactOutput
                );
            }
        }
    }

    function _exerciseAllLiveQuadrantSplitProperties(uint256 firstAmount, uint256 secondAmount)
        private
    {
        for (uint256 order; order < 2; ++order) {
            Currency usdg = order == 0 ? currency0 : currency1;
            for (uint256 direction; direction < 2; ++direction) {
                for (uint256 exactness; exactness < 2; ++exactness) {
                    _assertLiveQuadrantSplitMatchesUnsplitTransition(
                        usdg, direction == 0, exactness == 0, firstAmount, secondAmount
                    );
                }
            }
        }
    }

    function _assertLiveQuadrantSplitMatchesUnsplitTransition(
        Currency usdg,
        bool zeroForOne,
        bool exactInput,
        uint256 firstAmount,
        uint256 secondAmount
    ) private {
        HookemonHook hook = _deployHook(usdg);
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-120, 120, 10 ** 24, bytes32(0)), bytes("")
        );

        uint256 firstGross =
            _runQuadrant(hook, key, usdg, zeroForOne, exactInput, firstAmount, firstAmount);
        uint256 secondGross =
            _runQuadrant(hook, key, usdg, zeroForOne, exactInput, secondAmount, secondAmount);
        ExpectedSplit memory expected = _expectedFreshLifetimeSplit(firstGross + secondGross);
        LiabilitySnapshot memory actual = _snapshot(hook, usdg);

        assertEq(actual.programmable, expected.programmable);
        assertEq(actual.treasury, expected.treasury);
        assertEq(actual.process, expected.process);
        assertEq(actual.total, expected.total);
    }

    function _runQuadrant(
        HookemonHook hook,
        PoolKey memory key,
        Currency usdg,
        bool zeroForOne,
        bool exactInput,
        uint256 exactInputAmount,
        uint256 exactOutputAmount
    ) private returns (uint256 gross) {
        int256 specified = exactInput ? -int256(exactInputAmount) : int256(exactOutputAmount);
        LiabilitySnapshot memory beforeLiability = _snapshot(hook, usdg);
        vm.recordLogs();
        BalanceDelta delta = _performSwap(key, zeroForOne, specified);
        _assertSwapSpecified(delta, specified, zeroForOne);
        ObservedUsdgSwap memory observed = _observeUsdgSwap(
            key,
            usdg,
            delta,
            beforeLiability.callerUsdgBalance,
            beforeLiability.managerUsdgBalance,
            beforeLiability.hookUsdgBalance,
            vm.getRecordedLogs()
        );
        if (!exactInput) {
            bool usdgSpecified = ((specified < 0) == zeroForOne)
                == (Currency.unwrap(usdg) == Currency.unwrap(key.currency0));
            uint256 requestedNet =
                usdgSpecified ? _abs(specified) : _abs(int256(observed.rawPoolDelta));
            assertEq(observed.gross - observed.fee, requestedNet);
            _assertObservedExactOutputUsesFirstGrossRoot(
                hook, observed.gross, observed.fee, requestedNet
            );
        }
        ExpectedSplit memory expected = _expectedSwapSplit(hook, observed.gross);
        assertEq(expected.total, observed.fee);
        assertEq(hook.lastExecutedUsdg(), observed.gross);
        _assertFeeBalance(hook, usdg, beforeLiability.hookUsdgBalance, expected);
        _assertLiabilityDelta(hook, beforeLiability, expected);
        return observed.gross;
    }

    function _performSwap(PoolKey memory key, bool zeroForOne, int256 specified)
        private
        returns (BalanceDelta)
    {
        return swapRouter.swap(
            key,
            SwapParams(
                zeroForOne,
                specified,
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            _hookData(address(0xBEEF))
        );
    }

    function _assertSwapSpecified(BalanceDelta delta, int256 specified, bool zeroForOne)
        private
        pure
    {
        bool specified0 = (specified < 0) == zeroForOne;
        int128 callerSpecified = specified0 ? delta.amount0() : delta.amount1();
        assert(int256(callerSpecified) == specified);
    }

    struct ExpectedSplit {
        uint256 total;
        uint256 programmable;
        uint256 treasury;
        uint256 process;
    }

    struct ObservedUsdgSwap {
        int128 rawPoolDelta;
        int128 callerDelta;
        uint256 gross;
        uint256 fee;
    }

    struct AccrualRemainders {
        uint256 executedUsdg;
        uint256 programmable;
        uint256 treasury;
        uint256 process;
    }

    /// @dev Mirrors the independent 10/40/250-bps lifetime accumulators from observed gross
    ///      volume. It advances once per successful swap for each hook and never reads hook-owned
    ///      execution state to derive the expectation.
    mapping(address hook => uint256 remainder) private mirrorProgrammableRemainder;
    mapping(address hook => uint256 remainder) private mirrorTreasuryRemainder;
    mapping(address hook => uint256 remainder) private mirrorProcessRemainder;

    function _expectedSwapSplit(HookemonHook hook, uint256 executedUsdg)
        private
        returns (ExpectedSplit memory expected)
    {
        (uint256 programmableInc, uint256 newProgRem) =
            _cumulativeIncrement(executedUsdg, 10, mirrorProgrammableRemainder[address(hook)]);
        mirrorProgrammableRemainder[address(hook)] = newProgRem;
        (uint256 treasuryInc, uint256 newTreasuryRem) =
            _cumulativeIncrement(executedUsdg, 40, mirrorTreasuryRemainder[address(hook)]);
        mirrorTreasuryRemainder[address(hook)] = newTreasuryRem;
        (uint256 processInc, uint256 newProcessRem) =
            _cumulativeIncrement(executedUsdg, 250, mirrorProcessRemainder[address(hook)]);
        mirrorProcessRemainder[address(hook)] = newProcessRem;

        expected.programmable = programmableInc;
        expected.treasury = treasuryInc;
        expected.process = processInc;
        expected.total = programmableInc + treasuryInc + processInc;
    }

    function _expectedFreshLifetimeSplit(uint256 gross)
        private
        pure
        returns (ExpectedSplit memory expected)
    {
        (expected.programmable,) = _cumulativeIncrement(gross, 10, 0);
        (expected.treasury,) = _cumulativeIncrement(gross, 40, 0);
        (expected.process,) = _cumulativeIncrement(gross, 250, 0);
        expected.total = expected.programmable + expected.treasury + expected.process;
    }

    function _assertObservedExactOutputUsesFirstGrossRoot(
        HookemonHook hook,
        uint256 gross,
        uint256 fee,
        uint256 requestedNet
    ) private view {
        assertGe(gross, 1_000);
        uint256 candidate = 1_000;

        while (candidate < gross) {
            assert(candidate - _previewExpectedFee(hook, candidate) != requestedNet);
            ++candidate;
        }
        assertEq(_previewExpectedFee(hook, gross), fee);
    }

    function _previewExpectedFee(HookemonHook hook, uint256 gross) private view returns (uint256) {
        (uint256 programmable,) =
            _cumulativeIncrement(gross, 10, mirrorProgrammableRemainder[address(hook)]);
        (uint256 treasury,) =
            _cumulativeIncrement(gross, 40, mirrorTreasuryRemainder[address(hook)]);
        (uint256 process,) = _cumulativeIncrement(gross, 250, mirrorProcessRemainder[address(hook)]);
        return programmable + treasury + process;
    }

    function _cumulativeIncrement(uint256 executedUsdg, uint256 rateBps, uint256 remainderBefore)
        private
        pure
        returns (uint256 increment, uint256 remainderAfter)
    {
        uint256 highPart = executedUsdg / 10_000 * rateBps;
        uint256 lowPart = executedUsdg % 10_000 * rateBps + remainderBefore;
        increment = highPart + lowPart / 10_000;
        remainderAfter = lowPart % 10_000;
    }

    /// @dev Per-stream carrying makes a single collected total differ from a flat 300-bps floor.
    ///      `_expectedSwapSplit` derives all three allocations from the observed gross volume.
    function _assertFeeBalance(
        HookemonHook hook,
        Currency usdg,
        uint256 beforeBalance,
        ExpectedSplit memory expected
    ) private view {
        assertEq(usdg.balanceOf(address(hook)) - beforeBalance, expected.total);
    }

    function _observeUsdgSwap(
        PoolKey memory key,
        Currency usdg,
        BalanceDelta delta,
        uint256 callerBefore,
        uint256 managerBefore,
        uint256 hookBefore,
        Vm.Log[] memory logs
    ) private view returns (ObservedUsdgSwap memory observed) {
        observed.rawPoolDelta = _rawPoolUsdgDelta(key, usdg, logs);
        observed.callerDelta = Currency.unwrap(usdg) == Currency.unwrap(key.currency0)
            ? delta.amount0()
            : delta.amount1();

        int256 callerBalanceDelta = _balanceDelta(_usdgBalance(usdg, address(this)), callerBefore);
        int256 managerBalanceDelta =
            _balanceDelta(_usdgBalance(usdg, address(manager)), managerBefore);
        int256 hookBalanceDelta = _balanceDelta(_usdgBalance(usdg, address(key.hooks)), hookBefore);
        int256 observedFee = int256(observed.rawPoolDelta) - int256(observed.callerDelta);

        assertGt(observedFee, 0);
        assertEq(observed.rawPoolDelta < 0, observed.callerDelta < 0);
        assertEq(callerBalanceDelta, int256(observed.callerDelta));
        assertEq(managerBalanceDelta, -int256(observed.rawPoolDelta));
        assertEq(hookBalanceDelta, observedFee);
        assertEq(callerBalanceDelta + managerBalanceDelta + hookBalanceDelta, 0);

        observed.fee = uint256(observedFee);
        // If the pool receives USDG, the caller leg includes the hook-collected fee; otherwise
        // the pool's raw USDG output is the gross amount before that fee is returned as a delta.
        observed.gross = observed.rawPoolDelta < 0
            ? _abs(int256(observed.callerDelta))
            : _abs(int256(observed.rawPoolDelta));
    }

    function _rawPoolUsdgDelta(PoolKey memory key, Currency usdg, Vm.Log[] memory logs)
        private
        view
        returns (int128)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != address(manager) || entry.topics.length < 2
                    || entry.topics[0] != POOL_SWAP_EVENT
                    || entry.topics[1] != PoolId.unwrap(key.toId())
            ) continue;
            (
                int128 amount0,
                int128 amount1,
                uint160 sqrtPriceX96,
                uint128 liquidity,
                int24 tick,
                uint24 fee
            ) = abi.decode(entry.data, (int128, int128, uint160, uint128, int24, uint24));
            sqrtPriceX96;
            liquidity;
            tick;
            fee;
            return Currency.unwrap(usdg) == Currency.unwrap(key.currency0) ? amount0 : amount1;
        }
        revert("POOL_SWAP_LOG_NOT_FOUND");
    }

    function _usdgBalance(Currency usdg, address account) private view returns (uint256) {
        return Currency.unwrap(usdg) == address(token0)
            ? token0.balanceOf(account)
            : token1.balanceOf(account);
    }

    function _balanceDelta(uint256 afterBalance, uint256 beforeBalance)
        private
        pure
        returns (int256)
    {
        return afterBalance >= beforeBalance
            ? int256(afterBalance - beforeBalance)
            : -int256(beforeBalance - afterBalance);
    }

    function _abs(int256 value) private pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }

    /// @dev R60 permits each beneficiary to choose its nonzero transfer destination. This replaces
    ///      the earlier rejection oracle, which treated a valid third-party destination as invalid.
    function testBeneficiaryClaimsUseRequestedDestinationsAndLeaveProcessLiabilityUntouched()
        external
    {
        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _prepareHookLiquidity(hook);
        vm.recordLogs();
        _performSwap(key, true, -int256(10_001));
        AccrualRemainders memory firstAccrual = _accrualRemainders(vm.getRecordedLogs(), hook);
        assertGt(firstAccrual.programmable, 0);
        assertGt(firstAccrual.treasury, 0);
        assertGt(firstAccrual.process, 0);
        assertEq(hook.processLiability(), 250);
        address programmableDestination = address(0xBEEF);
        address treasuryDestination = address(0xCAFE);
        token0.setBalanceReturnsMalformed(true);
        vm.expectRevert(HookemonHook.InvalidUsdgCall.selector);
        vm.prank(PROGRAMMABLE);
        hook.claimProgrammable(PROGRAMMABLE);
        token0.setBalanceReturnsMalformed(false);
        token0.setTransferReturn(HookToken.TransferReturn.False);
        vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
        vm.prank(PROGRAMMABLE);
        hook.claimProgrammable(PROGRAMMABLE);
        assertEq(hook.processLiability(), 250);
        token0.setTransferReturn(HookToken.TransferReturn.True);
        vm.expectRevert(MoneyRoles.InvalidDestination.selector);
        vm.prank(PROGRAMMABLE);
        hook.claimProgrammable(address(0));
        vm.expectRevert(MoneyRoles.InvalidDestination.selector);
        vm.prank(TREASURY);
        hook.claimTreasury(address(0));
        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        vm.prank(OPERATIONS);
        hook.claimProgrammable(programmableDestination);
        vm.expectRevert(MoneyRoles.InvalidRoleBeneficiary.selector);
        vm.prank(OPERATIONS);
        hook.claimTreasury(treasuryDestination);

        uint256 programmableBalanceBefore = token0.balanceOf(programmableDestination);
        vm.recordLogs();
        vm.prank(PROGRAMMABLE);
        hook.claimProgrammable(4, programmableDestination);
        _assertBeneficiaryClaimed(
            vm.getRecordedLogs(),
            hook,
            "ProgrammableClaimed(address,uint256)",
            programmableDestination,
            4
        );
        assertEq(token0.balanceOf(programmableDestination) - programmableBalanceBefore, 4);

        uint256 treasuryBalanceBefore = token0.balanceOf(treasuryDestination);
        vm.recordLogs();
        vm.prank(TREASURY);
        hook.claimTreasury(15, treasuryDestination);
        _assertBeneficiaryClaimed(
            vm.getRecordedLogs(), hook, "TreasuryClaimed(address,uint256)", treasuryDestination, 15
        );
        assertEq(token0.balanceOf(treasuryDestination) - treasuryBalanceBefore, 15);
        vm.prank(PROGRAMMABLE);
        hook.claimProgrammable(programmableDestination);
        vm.prank(TREASURY);
        hook.claimTreasury(treasuryDestination);
        assertEq(token0.balanceOf(programmableDestination), 10);
        assertEq(token0.balanceOf(treasuryDestination), 40);
        assertEq(token0.balanceOf(OPERATIONS), 0);
        assertEq(hook.processLiability(), 250);

        vm.recordLogs();
        _performSwap(key, true, -int256(10_001));
        AccrualRemainders memory secondAccrual = _accrualRemainders(vm.getRecordedLogs(), hook);
        assertEq(
            secondAccrual.programmable,
            (firstAccrual.programmable + secondAccrual.executedUsdg * 10) % 10_000
        );
        assertEq(
            secondAccrual.treasury,
            (firstAccrual.treasury + secondAccrual.executedUsdg * 40) % 10_000
        );
        assertEq(
            secondAccrual.process,
            (firstAccrual.process + secondAccrual.executedUsdg * 250) % 10_000
        );
    }

    function testPartialBeneficiaryClaimsRejectZeroAndAmountsAboveLiability() external {
        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _prepareHookLiquidity(hook);
        _performSwap(key, true, -int256(10_001));
        (uint256 programmable, uint256 treasury, uint256 process) =
            hook.readFeeLiabilities(TREASURY);
        assertEq(programmable, 10);
        assertEq(treasury, 40);
        assertEq(process, 250);

        vm.prank(PROGRAMMABLE);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        hook.claimProgrammable(0, address(0xBEEF));
        vm.prank(PROGRAMMABLE);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        hook.claimProgrammable(11, address(0xBEEF));

        vm.prank(TREASURY);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        hook.claimTreasury(0, address(0xCAFE));
        vm.prank(TREASURY);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        hook.claimTreasury(41, address(0xCAFE));

        (programmable, treasury, process) = hook.readFeeLiabilities(TREASURY);
        assertEq(programmable, 10);
        assertEq(treasury, 40);
        assertEq(process, 250);
    }

    function testClaimsRequireCanonicalTrueTransferReturn() external {
        HookemonHook hook = _deployHook(currency0);
        _accrueHookFee(hook);
        HookToken.TransferReturn[4] memory rejected = [
            HookToken.TransferReturn.Empty,
            HookToken.TransferReturn.Short,
            HookToken.TransferReturn.Excess,
            HookToken.TransferReturn.False
        ];

        for (uint256 i; i < rejected.length; ++i) {
            token0.setTransferReturn(rejected[i]);
            vm.expectRevert(FeeAccounting.TokenTransferFailed.selector);
            vm.prank(PROGRAMMABLE);
            hook.claimProgrammable(PROGRAMMABLE);
            assertEq(token0.balanceOf(PROGRAMMABLE), 0);
        }

        token0.setTransferReturn(HookToken.TransferReturn.True);
        vm.prank(PROGRAMMABLE);
        hook.claimProgrammable(PROGRAMMABLE);
        assertEq(token0.balanceOf(PROGRAMMABLE), 10);
    }

    function _accrueHookFee(HookemonHook hook) private {
        PoolKey memory key = _prepareHookLiquidity(hook);
        _performSwap(key, true, -int256(10_000));
    }

    function _prepareHookLiquidity(HookemonHook hook) private returns (PoolKey memory key) {
        key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-120, 120, 10 ** 18, bytes32(0)), bytes("")
        );
    }

    function _assertBeneficiaryClaimed(
        Vm.Log[] memory logs,
        HookemonHook hook,
        string memory signature,
        address destination,
        uint256 amount
    ) private pure {
        bytes32 eventSignature = keccak256(bytes(signature));
        for (uint256 index; index < logs.length; ++index) {
            Vm.Log memory entry = logs[index];
            if (
                entry.emitter != address(hook) || entry.topics.length != 2
                    || entry.topics[0] != eventSignature
                    || address(uint160(uint256(entry.topics[1]))) != destination
            ) continue;
            assertEq(abi.decode(entry.data, (uint256)), amount);
            return;
        }
        assertTrue(false, "missing beneficiary claim event");
    }

    function _accrualRemainders(Vm.Log[] memory logs, HookemonHook hook)
        private
        pure
        returns (AccrualRemainders memory remainders)
    {
        bytes32 eventSignature = keccak256(
            "SwapLiabilitiesAccrued(uint256,uint256,address,uint256,address,uint256,uint256,uint256,uint256,uint256)"
        );
        for (uint256 index; index < logs.length; ++index) {
            Vm.Log memory entry = logs[index];
            if (
                entry.emitter != address(hook) || entry.topics.length != 3
                    || entry.topics[0] != eventSignature
            ) continue;
            (
                remainders.executedUsdg,,,,,
                remainders.programmable,
                remainders.treasury,
                remainders.process
            ) =
                abi.decode(
                    entry.data,
                    (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
                );
            return remainders;
        }
        assertTrue(false, "missing swap liabilities event");
    }

    function _deployHook(Currency usdg) private returns (HookemonHook hook) {
        HookFactory factory = _factory(usdg);
        bytes32 hash = factory.initCodeHash();
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(salt, hash, address(factory));
            if ((uint160(predicted) & ALL_MASK) == REQUIRED_MASK) {
                hook = factory.deploy(salt);
                assertEq(address(hook), predicted);
                break;
            }
        }
        assertTrue(address(hook) != address(0));
    }

    function _snapshot(HookemonHook hook, Currency usdg)
        private
        view
        returns (LiabilitySnapshot memory snapshot)
    {
        (snapshot.programmable, snapshot.treasury, snapshot.process) =
            hook.readFeeLiabilities(TREASURY);
        snapshot.total = hook.totalLiability();
        snapshot.hookUsdgBalance = _usdgBalance(usdg, address(hook));
        snapshot.callerUsdgBalance = _usdgBalance(usdg, address(this));
        snapshot.managerUsdgBalance = _usdgBalance(usdg, address(manager));
    }

    function _assertLiabilityDelta(
        HookemonHook hook,
        LiabilitySnapshot memory beforeLiability,
        ExpectedSplit memory expected
    ) private view {
        (uint256 programmable, uint256 treasury, uint256 process) =
            hook.readFeeLiabilities(TREASURY);
        assertEq(programmable - beforeLiability.programmable, expected.programmable);
        assertEq(treasury - beforeLiability.treasury, expected.treasury);
        assertEq(process - beforeLiability.process, expected.process);
        assertEq(hook.totalLiability() - beforeLiability.total, expected.total);
    }

    function _factory(Currency usdg) private returns (HookFactory factory) {
        factory = new HookFactory(_config(usdg));
    }

    function _config(Currency usdg) private view returns (HookemonHook.ConstructorConfig memory) {
        return HookemonHook.ConstructorConfig({
            manager: manager,
            positionManager: address(0x1001),
            permit2: address(0x1002),
            usdg: usdg,
            hkmn: usdg == currency0 ? currency1 : currency0,
            tickSpacing: 60,
            programmable: PROGRAMMABLE,
            treasury: TREASURY,
            operations: OPERATIONS,
            launchAuthority: AUTHORITY,
            issuanceAuthority: AUTHORITY,
            expectedDecimals: 18,
            bindingDigest: BINDING_DIGEST,
            runtimeDigest: RUNTIME_DIGEST,
            processClaimLimit6h: 1_000_000,
            processClaimLimitMax: 2_000_000,
            processClaimMaxCount: 8,
            operationsRotationDelay: 3 days
        });
    }

    function _expectConfigRevert(HookemonHook.ConstructorConfig memory config, bytes4 selector)
        private
    {
        HookFactory factory = new HookFactory(config);
        bytes32 salt = _validHookSalt(factory);
        vm.expectRevert(selector);
        factory.deploy(salt);
    }

    function _validHookSalt(HookFactory factory) private view returns (bytes32 salt) {
        bytes32 hash = factory.initCodeHash();
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 candidate = bytes32(nonce);
            address predicted = vm.computeCreate2Address(candidate, hash, address(factory));
            if ((uint160(predicted) & ALL_MASK) == REQUIRED_MASK) return candidate;
        }
        revert("valid hook salt not found");
    }

    function _key(HookemonHook hook) private view returns (PoolKey memory) {
        return _keyFor(IHooks(address(hook)));
    }

    function _keyFor(IHooks hook) private view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, 0, 60, hook);
    }

    function _initializeHook(HookemonHook hook) private {
        vm.prank(AUTHORITY);
        hook.initializeCanonicalPool(uint160(1 << 96));
    }

    function _hookData(address recipient) private pure returns (bytes memory) {
        return abi.encode(recipient, uint256(123));
    }
}
