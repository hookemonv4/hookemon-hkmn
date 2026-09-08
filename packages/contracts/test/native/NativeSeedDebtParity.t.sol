// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import { IPositionDescriptor } from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import { IWETH9 } from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import { Actions } from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";
import { DeployPermit2 } from "permit2/test/utils/DeployPermit2.sol";

/// @dev Test-only ERC20; this fixture does not replace or prove the deployed HKMN allocation.
contract NativeSeedParityToken {
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

    function transferFrom(address owner, address recipient, uint256 amount)
        external
        returns (bool)
    {
        allowance[owner][msg.sender] -= amount;
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

/// @notice Preparation proof against pinned real managers, without changing Hookemon production.
contract NativeSeedDebtParityTest is Test, DeployPermit2 {
    int24 private constant LOWER = -887220;
    int24 private constant UPPER = 887220;
    uint128 private constant LIQUIDITY = 1e18;
    uint256 private constant FUNDING = 1e40;

    PoolManager private manager;
    PositionManager private positions;
    NativeSeedParityToken private token;
    PoolKey private key;
    uint160 private price;

    function _deployAt(int24 tick) private {
        manager = new PoolManager(address(this));
        IAllowanceTransfer permit = IAllowanceTransfer(deployPermit2());
        positions = new PositionManager(
            IPoolManager(address(manager)),
            permit,
            100_000,
            IPositionDescriptor(address(0)),
            IWETH9(address(0))
        );
        token = new NativeSeedParityToken();
        token.mint(address(this), FUNDING);
        token.approve(address(permit), type(uint256).max);
        permit.approve(address(token), address(positions), type(uint160).max, type(uint48).max);
        key = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(address(token)), 0, 60, IHooks(address(0))
        );
        price = TickMath.getSqrtPriceAtTick(tick);
        manager.initialize(key, price);
        vm.deal(address(this), FUNDING);
    }

    /// @dev Independent explicit-unsigned rounding recipe checked against Pool.modifyLiquidity.
    function _debts(uint128 liquidity)
        private
        view
        returns (uint256 nativeDebt, uint256 tokenDebt)
    {
        uint160 lower = TickMath.getSqrtPriceAtTick(LOWER);
        uint160 upper = TickMath.getSqrtPriceAtTick(UPPER);
        if (price <= lower) {
            nativeDebt = SqrtPriceMath.getAmount0Delta(lower, upper, liquidity, true);
        } else if (price < upper) {
            nativeDebt = SqrtPriceMath.getAmount0Delta(price, upper, liquidity, true);
            tokenDebt = SqrtPriceMath.getAmount1Delta(lower, price, liquidity, true);
        } else {
            tokenDebt = SqrtPriceMath.getAmount1Delta(lower, upper, liquidity, true);
        }
    }

    function _mint(uint128 liquidity, uint128 nativeMax, uint128 tokenMax, uint256 value) private {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, LOWER, UPPER, uint256(liquidity), nativeMax, tokenMax, address(this), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        positions.modifyLiquidities{ value: value }(
            abi.encode(actions, params), block.timestamp + 1
        );
    }

    function _assertParity(int24 tick, uint128 liquidity) private {
        _deployAt(tick);
        (uint256 nativeDebt, uint256 tokenDebt) = _debts(liquidity);
        uint256 tokenId = positions.nextTokenId();
        _mint(liquidity, uint128(nativeDebt), uint128(tokenDebt), nativeDebt);
        assertEq(address(manager).balance, nativeDebt);
        assertEq(token.balanceOf(address(manager)), tokenDebt);
        assertEq(address(positions).balance, 0);
        assertEq(token.balanceOf(address(positions)), 0);
        assertEq(address(this).balance, FUNDING - nativeDebt);
        assertEq(token.balanceOf(address(this)), FUNDING - tokenDebt);
        assertEq(positions.getPositionLiquidity(tokenId), liquidity);
        assertEq(positions.ownerOf(tokenId), address(this));
    }

    function testFullRangeDebtParityAtAndAroundBothBoundaries() external {
        int24[9] memory ticks = [
            int24(-887221),
            LOWER,
            int24(-887219),
            int24(-60),
            int24(0),
            int24(60),
            int24(887219),
            UPPER,
            int24(887221)
        ];
        for (uint256 i; i < ticks.length; ++i) {
            _assertParity(ticks[i], LIQUIDITY);
        }
    }

    function testFuzzInRangeDebtParity(int24 tick, uint128 liquidity) external {
        tick = int24(bound(int256(tick), -10000, 10000));
        liquidity = uint128(bound(uint256(liquidity), 1, 1e24));
        _assertParity(tick, liquidity);
    }

    function testExactDebtPreservesUnrelatedPositionManagerEth() external {
        _deployAt(0);
        (uint256 nativeDebt, uint256 tokenDebt) = _debts(LIQUIDITY);
        vm.deal(address(positions), 17);
        _mint(LIQUIDITY, uint128(nativeDebt), uint128(tokenDebt), nativeDebt);
        assertEq(address(positions).balance, 17);
        assertEq(address(manager).balance, nativeDebt);
    }

    function testManagerCanConsumePriorEthWhenCallerUnderfunds() external {
        _deployAt(0);
        (uint256 nativeDebt, uint256 tokenDebt) = _debts(LIQUIDITY);
        vm.deal(address(positions), 17);
        _mint(LIQUIDITY, uint128(nativeDebt), uint128(tokenDebt), nativeDebt - 1);
        assertEq(address(positions).balance, 16);
        assertEq(address(manager).balance, nativeDebt);
        // The native Hookemon seed must enforce its own exact msg.value and send exact debt.
    }

    function testUnderpaymentWithoutPriorEthRollsBackMintAndTransfers() external {
        _deployAt(0);
        (uint256 nativeDebt, uint256 tokenDebt) = _debts(LIQUIDITY);
        uint256 nextId = positions.nextTokenId();
        vm.expectRevert();
        _mint(LIQUIDITY, uint128(nativeDebt), uint128(tokenDebt), nativeDebt - 1);
        _assertNoMint(nextId);
    }

    function testNativeMaximumOneWeiBelowDebtRollsBack() external {
        _deployAt(1);
        (uint256 nativeDebt, uint256 tokenDebt) = _debts(LIQUIDITY);
        uint256 nextId = positions.nextTokenId();
        vm.expectRevert();
        _mint(LIQUIDITY, uint128(nativeDebt - 1), uint128(tokenDebt), nativeDebt);
        _assertNoMint(nextId);
    }

    function testTokenMaximumOneAtomBelowDebtRollsBack() external {
        _deployAt(-1);
        (uint256 nativeDebt, uint256 tokenDebt) = _debts(LIQUIDITY);
        uint256 nextId = positions.nextTokenId();
        vm.expectRevert();
        _mint(LIQUIDITY, uint128(nativeDebt), uint128(tokenDebt - 1), nativeDebt);
        _assertNoMint(nextId);
    }

    function _assertNoMint(uint256 nextId) private view {
        assertEq(positions.nextTokenId(), nextId);
        assertEq(address(manager).balance, 0);
        assertEq(address(positions).balance, 0);
        assertEq(token.balanceOf(address(manager)), 0);
        assertEq(token.balanceOf(address(this)), FUNDING);
        assertEq(address(this).balance, FUNDING);
    }
}
