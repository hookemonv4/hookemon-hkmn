// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { BaseTestHooks } from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { CustomRevert } from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta, toBeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import { IPositionDescriptor } from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import { IWETH9 } from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import { Actions } from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";

import { PermanentPositionCustody } from "../../src/bindings/RobinhoodBindings.sol";

contract V4TestToken {
    string public constant name = "TEST";
    string public constant symbol = "TEST";
    uint8 public constant decimals = 18;

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

contract V4MockPermit2 {
    function transferFrom(address sender, address recipient, uint160 amount, address token)
        external
    {
        require(
            V4TestToken(token).transferFrom(sender, recipient, uint256(amount)), "TRANSFER_FAILED"
        );
    }
}

contract PinnedInclusiveUsdgFeeHook is BaseTestHooks {
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant TOTAL_FEE_BPS = 300;
    uint256 private constant PROGRAMMABLE_FEE_BPS = 10;
    uint256 private constant TREASURY_FEE_BPS = 40;

    IPoolManager public immutable manager;
    Currency public immutable usdg;
    uint256 public lastExecutedUsdg;
    uint256 public lastTotalFee;
    uint256 public lastProgrammableFee;
    uint256 public lastTreasuryFee;
    uint256 public lastProcessFee;
    int128 public lastRawPoolUsdgDelta;

    constructor(IPoolManager manager_, Currency usdg_) {
        manager = manager_;
        usdg = usdg_;
    }

    modifier onlyPoolManager() {
        require(msg.sender == address(manager), "ONLY_POOL_MANAGER");
        _;
    }

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        Currency specified = specifiedIsCurrency0 ? key.currency0 : key.currency1;
        if (Currency.unwrap(specified) != Currency.unwrap(usdg)) {
            return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
        }

        uint256 executedUsdg = _absolute(params.amountSpecified);
        int128 fee = _collectAndRecord(executedUsdg);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee, 0), 0);
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta rawPoolDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        int128 rawUsdgDelta = Currency.unwrap(usdg) == Currency.unwrap(key.currency0)
            ? rawPoolDelta.amount0()
            : rawPoolDelta.amount1();
        lastRawPoolUsdgDelta = rawUsdgDelta;

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        int128 rawSpecifiedDelta =
            specifiedIsCurrency0 ? rawPoolDelta.amount0() : rawPoolDelta.amount1();
        Currency specified = specifiedIsCurrency0 ? key.currency0 : key.currency1;
        if (Currency.unwrap(specified) == Currency.unwrap(usdg)) {
            require(
                int256(rawSpecifiedDelta) == params.amountSpecified + int256(lastTotalFee),
                "PARTIAL_FILL"
            );
            return (IHooks.afterSwap.selector, 0);
        }

        require(int256(rawSpecifiedDelta) == params.amountSpecified, "PARTIAL_FILL");
        int128 fee = _collectAndRecord(_absolute(int256(rawUsdgDelta)));
        return (IHooks.afterSwap.selector, fee);
    }

    function _collectAndRecord(uint256 executedUsdg) private returns (int128 feeDelta) {
        uint256 total = executedUsdg * TOTAL_FEE_BPS / BPS_DENOMINATOR;
        uint256 programmable = executedUsdg * PROGRAMMABLE_FEE_BPS / BPS_DENOMINATOR;
        uint256 treasury = executedUsdg * TREASURY_FEE_BPS / BPS_DENOMINATOR;
        uint256 process = total - programmable - treasury;
        require(total <= uint256(uint128(type(int128).max)), "FEE_TOO_LARGE");

        lastExecutedUsdg = executedUsdg;
        lastTotalFee = total;
        lastProgrammableFee = programmable;
        lastTreasuryFee = treasury;
        lastProcessFee = process;
        if (total != 0) manager.take(usdg, address(this), total);

        // The bound above proves this conversion cannot truncate or change sign.
        // forge-lint: disable-next-line(unsafe-typecast)
        feeDelta = int128(uint128(total));
    }

    function _absolute(int256 value) private pure returns (uint256) {
        require(value != type(int256).min, "INVALID_DELTA");
        return uint256(value < 0 ? -value : value);
    }
}

contract PinnedInclusiveUsdgFeeHookDeployer {
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;

    function deploy(IPoolManager manager, Currency usdg)
        external
        returns (PinnedInclusiveUsdgFeeHook hook)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(PinnedInclusiveUsdgFeeHook).creationCode, abi.encode(manager, usdg)
            )
        );
        for (uint256 nonce = 0; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
            if (uint160(predicted) & ALL_HOOK_MASK == REQUIRED_HOOK_MASK) {
                hook = new PinnedInclusiveUsdgFeeHook{ salt: salt }(manager, usdg);
                require(address(hook) == predicted, "CREATE2_MISMATCH");
                return hook;
            }
        }
        revert("HOOK_SALT_NOT_FOUND");
    }
}

contract RobinhoodV4PoolManagerTest {
    uint160 private constant SQRT_PRICE_1_1 = 1 << 96;

    struct QuadrantObservation {
        bool specifiedIsCurrency0;
        bool usdgIsSpecified;
        uint256 hookBalanceBefore;
        BalanceDelta callerDelta;
        int128 rawUsdgDelta;
        uint256 expectedExecutedUsdg;
        uint256 expectedFee;
    }

    PoolManager private manager;
    PoolModifyLiquidityTest private liquidityRouter;
    PoolSwapTest private swapRouter;
    V4TestToken private token0;
    V4TestToken private token1;
    Currency private currency0;
    Currency private currency1;

    function testPinnedPoolManagerCollectsExactlyOneInclusiveUsdgFeeInAllEightQuadrants() external {
        _setUpManagerAndTokens();
        PinnedInclusiveUsdgFeeHookDeployer deployer = new PinnedInclusiveUsdgFeeHookDeployer();
        _exerciseFourQuadrants(deployer.deploy(manager, currency0), true);
        _exerciseFourQuadrants(deployer.deploy(manager, currency1), false);
    }

    function testPinnedPoolManagerRevertsPartialFillAndFeeMutation() external {
        _setUpManagerAndTokens();
        PinnedInclusiveUsdgFeeHookDeployer deployer = new PinnedInclusiveUsdgFeeHookDeployer();
        _exercisePartialFillRejections(deployer.deploy(manager, currency0), true);
        _exercisePartialFillRejections(deployer.deploy(manager, currency1), false);
    }

    function _exercisePartialFillRejections(PinnedInclusiveUsdgFeeHook hook, bool usdgIsCurrency0)
        private
    {
        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -120, tickUpper: 120, liquidityDelta: 10 ** 18, salt: bytes32(0)
            }),
            ""
        );

        for (uint256 direction = 0; direction < 2; ++direction) {
            for (uint256 exactness = 0; exactness < 2; ++exactness) {
                _assertPartialFillRejected(
                    key,
                    hook,
                    usdgIsCurrency0,
                    direction == 0,
                    exactness == 0 ? -int256(10 ** 17) : int256(10 ** 17)
                );
            }
        }
    }

    function _assertPartialFillRejected(
        PoolKey memory key,
        PinnedInclusiveUsdgFeeHook hook,
        bool usdgIsCurrency0,
        bool zeroForOne,
        int256 amountSpecified
    ) private {
        uint256 hookBalanceBefore = _usdgBalance(hook, usdgIsCurrency0);
        bool partialFillRejected;
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(zeroForOne ? int24(-1) : int24(1))
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        ) returns (
            BalanceDelta
        ) { }
        catch (bytes memory reason) {
            bytes memory expected = abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSignature("Error(string)", "PARTIAL_FILL"),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            );
            assert(keccak256(reason) == keccak256(expected));
            partialFillRejected = true;
        }

        assert(partialFillRejected);
        assert(_usdgBalance(hook, usdgIsCurrency0) == hookBalanceBefore);
        assert(hook.lastTotalFee() == 0);
    }

    function testPinnedPositionManagerMintsPermanentCustodyAndTradingContinues() external {
        _setUpManagerAndTokens();
        PinnedInclusiveUsdgFeeHookDeployer deployer = new PinnedInclusiveUsdgFeeHookDeployer();
        PinnedInclusiveUsdgFeeHook hook = deployer.deploy(manager, currency0);
        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, SQRT_PRICE_1_1);

        V4MockPermit2 permit2 = new V4MockPermit2();
        PositionManager positionManager = new PositionManager(
            manager,
            IAllowanceTransfer(address(permit2)),
            100_000,
            IPositionDescriptor(address(0)),
            IWETH9(address(0))
        );
        token0.approve(address(permit2), type(uint256).max);
        token1.approve(address(permit2), type(uint256).max);

        uint256 tokenId = positionManager.nextTokenId();
        PermanentPositionCustody custody =
            new PermanentPositionCustody(address(positionManager), tokenId);
        _mintPosition(positionManager, key, address(custody));

        assert(positionManager.ownerOf(tokenId) == address(custody));
        assert(positionManager.getPositionLiquidity(tokenId) == 10 ** 18);
        assert(!custody.positionReceived());
        custody.finalizePosition();
        assert(custody.positionReceived());

        _assertNoPositionControl(positionManager, custody, tokenId);
        _assertQuadrant(key, hook, true, true, -int256(100_000));
        _assertQuadrant(key, hook, true, false, -int256(100_000));
        assert(positionManager.ownerOf(tokenId) == address(custody));
        assert(positionManager.getPositionLiquidity(tokenId) == 10 ** 18);
    }

    function _setUpManagerAndTokens() private {
        manager = new PoolManager(address(this));
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);

        V4TestToken first = new V4TestToken();
        V4TestToken second = new V4TestToken();
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

    function _exerciseFourQuadrants(PinnedInclusiveUsdgFeeHook hook, bool usdgIsCurrency0) private {
        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -120, tickUpper: 120, liquidityDelta: 10 ** 18, salt: bytes32(0)
            }),
            ""
        );

        for (uint256 direction = 0; direction < 2; ++direction) {
            for (uint256 exactness = 0; exactness < 2; ++exactness) {
                bool zeroForOne = direction == 0;
                int256 amountSpecified = exactness == 0 ? -int256(100_000) : int256(80_000);
                _assertQuadrant(key, hook, usdgIsCurrency0, zeroForOne, amountSpecified);
            }
        }
    }

    function _mintPosition(PositionManager positionManager, PoolKey memory key, address recipient)
        private
    {
        bytes memory actions = abi.encodePacked(
            bytes1(uint8(Actions.MINT_POSITION)), bytes1(uint8(Actions.SETTLE_PAIR))
        );
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            int24(-120),
            int24(120),
            uint256(10 ** 18),
            type(uint128).max,
            type(uint128).max,
            recipient,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1);
    }

    function _assertNoPositionControl(
        PositionManager positionManager,
        PermanentPositionCustody custody,
        uint256 tokenId
    ) private {
        (bool transferred,) = address(positionManager)
            .call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)",
                    address(custody),
                    address(this),
                    tokenId
                )
            );
        assert(!transferred);
        (bool approved,) = address(positionManager)
            .call(abi.encodeWithSignature("approve(address,uint256)", address(this), tokenId));
        assert(!approved);
        assert(positionManager.getApproved(tokenId) == address(0));
        assert(!positionManager.isApprovedForAll(address(custody), address(this)));

        _assertModifyRejected(positionManager, tokenId, 1);
        _assertModifyRejected(positionManager, tokenId, 0);
        assert(positionManager.ownerOf(tokenId) == address(custody));
        assert(positionManager.getPositionLiquidity(tokenId) == 10 ** 18);
    }

    function _assertModifyRejected(
        PositionManager positionManager,
        uint256 tokenId,
        uint256 liquidity
    ) private {
        bytes memory actions = abi.encodePacked(bytes1(uint8(Actions.DECREASE_LIQUIDITY)));
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(tokenId, liquidity, uint128(0), uint128(0), bytes(""));
        (bool modified,) = address(positionManager)
            .call(
                abi.encodeCall(
                    positionManager.modifyLiquidities,
                    (abi.encode(actions, params), block.timestamp + 1)
                )
            );
        assert(!modified);
    }

    function _assertQuadrant(
        PoolKey memory key,
        PinnedInclusiveUsdgFeeHook hook,
        bool usdgIsCurrency0,
        bool zeroForOne,
        int256 amountSpecified
    ) private {
        QuadrantObservation memory observation;
        observation.specifiedIsCurrency0 = (amountSpecified < 0) == zeroForOne;
        observation.usdgIsSpecified = observation.specifiedIsCurrency0 == usdgIsCurrency0;
        observation.hookBalanceBefore = _usdgBalance(hook, usdgIsCurrency0);
        observation.callerDelta = swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );

        int128 callerSpecified = observation.specifiedIsCurrency0
            ? observation.callerDelta.amount0()
            : observation.callerDelta.amount1();
        assert(int256(callerSpecified) == amountSpecified);

        observation.rawUsdgDelta = hook.lastRawPoolUsdgDelta();
        observation.expectedExecutedUsdg = observation.usdgIsSpecified
            ? _absolute(amountSpecified)
            : _absolute(int256(observation.rawUsdgDelta));
        observation.expectedFee = observation.expectedExecutedUsdg * 300 / 10_000;
        // The hook rejects fees above int128.max before returning a delta.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 signedExpectedFee = int256(observation.expectedFee);
        assert(hook.lastExecutedUsdg() == observation.expectedExecutedUsdg);
        assert(hook.lastTotalFee() == observation.expectedFee);
        assert(
            hook.lastTotalFee()
                == hook.lastProgrammableFee() + hook.lastTreasuryFee() + hook.lastProcessFee()
        );

        assert(
            _usdgBalance(hook, usdgIsCurrency0) - observation.hookBalanceBefore
                == observation.expectedFee
        );
        if (observation.usdgIsSpecified) {
            assert(int256(observation.rawUsdgDelta) == amountSpecified + signedExpectedFee);
        } else {
            int128 callerUsdg = usdgIsCurrency0
                ? observation.callerDelta.amount0()
                : observation.callerDelta.amount1();
            assert(int256(callerUsdg) == int256(observation.rawUsdgDelta) - signedExpectedFee);
        }
        assert(key.fee == 0);
    }

    function _usdgBalance(PinnedInclusiveUsdgFeeHook hook, bool usdgIsCurrency0)
        private
        view
        returns (uint256)
    {
        return usdgIsCurrency0 ? token0.balanceOf(address(hook)) : token1.balanceOf(address(hook));
    }

    function _absolute(int256 value) private pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }
}
