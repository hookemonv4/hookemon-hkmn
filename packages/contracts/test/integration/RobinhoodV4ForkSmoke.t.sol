// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Robinhood v4 fork — current-head drift-detection smoke test (WP-24)
/// @notice The companion to RobinhoodV4Fork.t.sol's block-pinned regression suite. This suite
///         selects `ROBINHOOD_FORK_RPC_URL` at the current head when configured and verifies
///         that the live PoolManager and PositionManager still match their pinned bindings. An
///         unset environment variable preserves the legacy optional skip behavior; a configured
///         archive endpoint turns fork creation and runtime drift into explicit failures.
import { Test } from "../../lib/v4-core/lib/forge-std/src/Test.sol";
import { Vm } from "../../lib/v4-core/lib/forge-std/src/Vm.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { RobinhoodBindings } from "../../src/bindings/RobinhoodBindings.sol";
import { HookemonHook } from "../../src/HookemonHook.sol";

/// @dev Kept separate from RobinhoodV4Fork.t.sol's `ForkTestToken`/`ForkRouteExecutor`/
///      `ForkHookFactory` (rather than imported) so the two suites can be read, compiled, and
///      re-pinned independently -- exactly the "distinguishable in CI output" property WP-24
///      asks for.
contract SmokeTestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
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

contract SmokeHookFactory {
    HookemonHook.ConstructorConfig private config;

    constructor(HookemonHook.ConstructorConfig memory config_) {
        config = config_;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));
    }

    function deploy(bytes32 salt) external returns (HookemonHook) {
        return new HookemonHook{ salt: salt }(config);
    }
}

contract RobinhoodV4ForkSmokeTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    bytes32 private constant POOL_SWAP_EVENT =
        keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    string private constant FORK_RPC_URL_ENV = "ROBINHOOD_FORK_RPC_URL";

    error ConfiguredArchiveForkUnavailable();
    error ConfiguredArchiveRuntimeDrift();

    /// @dev bindings/robinhood-chain.json contracts.poolManager / contracts.positionManager.
    address private constant ROBINHOOD_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 private constant ROBINHOOD_POOL_MANAGER_RUNTIME_CODEHASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    address private constant ROBINHOOD_POSITION_MANAGER =
        0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    bytes32 private constant ROBINHOOD_POSITION_MANAGER_RUNTIME_CODEHASH =
        0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2;

    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS = address(0x7000);
    address private constant AUTHORITY = address(0xA11CE);
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 private constant BINDING_DIGEST = keccak256("fork-smoke-binding");
    bytes32 private constant RUNTIME_DIGEST = keccak256("fork-smoke-runtime");

    IPoolManager private manager;
    PoolModifyLiquidityTest private liquidityRouter;
    PoolSwapTest private swapRouter;
    SmokeTestToken private token0;
    SmokeTestToken private token1;
    Currency private currency0;
    Currency private currency1;
    bool private forkReady;
    mapping(address hook => uint256 remainder) private mirrorProgrammableRemainder;
    mapping(address hook => uint256 remainder) private mirrorTreasuryRemainder;
    mapping(address hook => uint256 remainder) private mirrorProcessRemainder;

    struct ExpectedSplit {
        uint256 programmable;
        uint256 treasury;
        uint256 process;
        uint256 total;
    }

    struct ObservedUsdgSwap {
        int128 rawPoolDelta;
        int128 callerDelta;
        uint256 gross;
        uint256 fee;
    }

    function setUp() external {
        string memory archiveRpcUrl = vm.envOr(FORK_RPC_URL_ENV, string(""));
        bool archiveRpcConfigured = bytes(archiveRpcUrl).length != 0;
        if (archiveRpcConfigured) {
            try vm.createSelectFork(archiveRpcUrl) { }
            catch {
                revert ConfiguredArchiveForkUnavailable();
            }
        }

        if (
            ROBINHOOD_POOL_MANAGER.codehash != ROBINHOOD_POOL_MANAGER_RUNTIME_CODEHASH
                || ROBINHOOD_POSITION_MANAGER.codehash
                    != ROBINHOOD_POSITION_MANAGER_RUNTIME_CODEHASH
        ) {
            if (archiveRpcConfigured) {
                revert ConfiguredArchiveRuntimeDrift();
            }
            vm.skip(
                true,
                "RobinhoodV4ForkSmoke: live PoolManager/PositionManager bytecode no longer matches"
                " bindings/robinhood-chain.json. Configure ROBINHOOD_FORK_RPC_URL to make this"
                " drift a required failure."
            );
            return;
        }

        manager = IPoolManager(ROBINHOOD_POOL_MANAGER);
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);

        SmokeTestToken first = new SmokeTestToken();
        SmokeTestToken second = new SmokeTestToken();
        (token0, token1) = address(first) < address(second) ? (first, second) : (second, first);
        currency0 = Currency.wrap(address(token0));
        currency1 = Currency.wrap(address(token1));

        token0.mint(address(this), 10 ** 30);
        token1.mint(address(this), 10 ** 30);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);
        token0.approve(address(swapRouter), type(uint256).max);
        token1.approve(address(swapRouter), type(uint256).max);
        forkReady = true;
    }

    /// @notice Minimal smoke path: swaps with arbitrary and empty hook data reconcile the same
    ///         observed PoolManager/caller/hook USDG deltas. Intentionally not the full
    ///         eight-quadrant sweep the pinned suite runs, so this remains cheap enough for a
    ///         current-head schedule.
    function testSmokeSwapPathWithAndWithoutHookDataCollectsPinnedFee() external {
        if (!forkReady) return; // setUp skipped (see skip reason above)

        HookemonHook hook = _deployHook(currency0);
        PoolKey memory key = _key(hook);
        _initializeHook(hook);
        liquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-120, 120, 10 ** 24, bytes32(0)), bytes("")
        );

        _assertObservedExactInputSwap(hook, key, _hookData(address(0xBEEF)));
        _assertObservedExactInputSwap(hook, key, bytes(""));
    }

    function _assertObservedExactInputSwap(
        HookemonHook hook,
        PoolKey memory key,
        bytes memory hookData
    ) private {
        uint256 callerBefore = token0.balanceOf(address(this));
        uint256 managerBefore = token0.balanceOf(address(manager));
        uint256 hookBefore = token0.balanceOf(address(hook));
        uint256 liabilityBefore = hook.totalLiability();
        vm.recordLogs();
        BalanceDelta delta = swapRouter.swap(
            key,
            SwapParams(true, -int256(100_000), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false),
            hookData
        );
        ObservedUsdgSwap memory observed = _observeUsdgSwap(
            key, delta, callerBefore, managerBefore, hookBefore, vm.getRecordedLogs()
        );
        ExpectedSplit memory expected = _expectedSwapSplit(hook, observed.gross);
        assertEq(observed.fee, expected.total);
        assertEq(hook.lastExecutedUsdg(), observed.gross);
        assertEq(token0.balanceOf(address(hook)) - hookBefore, expected.total);
        assertEq(hook.totalLiability() - liabilityBefore, expected.total);
    }

    function _expectedSwapSplit(HookemonHook hook, uint256 gross)
        private
        returns (ExpectedSplit memory expected)
    {
        (uint256 programmable, uint256 newProgrammableRemainder) =
            _cumulativeIncrement(gross, 10, mirrorProgrammableRemainder[address(hook)]);
        mirrorProgrammableRemainder[address(hook)] = newProgrammableRemainder;
        (uint256 treasury, uint256 newTreasuryRemainder) =
            _cumulativeIncrement(gross, 40, mirrorTreasuryRemainder[address(hook)]);
        mirrorTreasuryRemainder[address(hook)] = newTreasuryRemainder;
        (uint256 process, uint256 newProcessRemainder) =
            _cumulativeIncrement(gross, 250, mirrorProcessRemainder[address(hook)]);
        mirrorProcessRemainder[address(hook)] = newProcessRemainder;

        expected.programmable = programmable;
        expected.treasury = treasury;
        expected.process = process;
        expected.total = programmable + treasury + process;
    }

    function _cumulativeIncrement(uint256 gross, uint256 rateBps, uint256 remainderBefore)
        private
        pure
        returns (uint256 increment, uint256 remainderAfter)
    {
        uint256 highPart = gross / 10_000 * rateBps;
        uint256 lowPart = gross % 10_000 * rateBps + remainderBefore;
        increment = highPart + lowPart / 10_000;
        remainderAfter = lowPart % 10_000;
    }

    function _observeUsdgSwap(
        PoolKey memory key,
        BalanceDelta delta,
        uint256 callerBefore,
        uint256 managerBefore,
        uint256 hookBefore,
        Vm.Log[] memory logs
    ) private view returns (ObservedUsdgSwap memory observed) {
        observed.rawPoolDelta = _rawPoolUsdgDelta(key, logs);
        observed.callerDelta = delta.amount0();

        int256 callerBalanceDelta = _balanceDelta(token0.balanceOf(address(this)), callerBefore);
        int256 managerBalanceDelta =
            _balanceDelta(token0.balanceOf(address(manager)), managerBefore);
        int256 hookBalanceDelta = _balanceDelta(token0.balanceOf(address(key.hooks)), hookBefore);
        int256 observedFee = int256(observed.rawPoolDelta) - int256(observed.callerDelta);

        assertGt(observedFee, 0);
        assertEq(observed.rawPoolDelta < 0, observed.callerDelta < 0);
        assertEq(callerBalanceDelta, int256(observed.callerDelta));
        assertEq(managerBalanceDelta, -int256(observed.rawPoolDelta));
        assertEq(hookBalanceDelta, observedFee);
        assertEq(callerBalanceDelta + managerBalanceDelta + hookBalanceDelta, 0);

        observed.fee = uint256(observedFee);
        observed.gross =
            observed.rawPoolDelta < 0 ? _abs(observed.callerDelta) : _abs(observed.rawPoolDelta);
    }

    function _rawPoolUsdgDelta(PoolKey memory key, Vm.Log[] memory logs)
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
            amount1;
            sqrtPriceX96;
            liquidity;
            tick;
            fee;
            return amount0;
        }
        revert("POOL_SWAP_LOG_NOT_FOUND");
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

    function _abs(int128 value) private pure returns (uint256) {
        return uint256(value < 0 ? -int256(value) : int256(value));
    }

    function _deployHook(Currency usdg) private returns (HookemonHook hook) {
        SmokeHookFactory factory = new SmokeHookFactory(
            HookemonHook.ConstructorConfig({
                manager: manager,
                positionManager: ROBINHOOD_POSITION_MANAGER,
                permit2: PERMIT2,
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
            })
        );
        bytes32 initCodeHash = factory.initCodeHash();
        uint256 originalChainId = block.chainid;
        vm.chainId(31_337);
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(salt, initCodeHash, address(factory));
            if ((uint160(predicted) & ALL_HOOK_MASK) == REQUIRED_HOOK_MASK) {
                hook = factory.deploy(salt);
                assertEq(address(hook), predicted);
                break;
            }
        }
        vm.chainId(originalChainId);
        assertTrue(address(hook) != address(0), "no valid CREATE2 salt found in 100_000 tries");
    }

    function _key(HookemonHook hook) private view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, 0, 60, IHooks(address(hook)));
    }

    function _initializeHook(HookemonHook hook) private {
        vm.prank(AUTHORITY);
        hook.initializeCanonicalPool(uint160(1 << 96));
    }

    function _hookData(address recipient) private pure returns (bytes memory) {
        return abi.encode(recipient, uint256(7));
    }
}
