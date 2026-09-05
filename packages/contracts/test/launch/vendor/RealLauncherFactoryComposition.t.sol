// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { LiquidityLauncher } from "@uniswap/liquidity-launcher/src/LiquidityLauncher.sol";
import { IAllowanceTransfer } from "@uniswap/liquidity-launcher/src/Permit2Forwarder.sol";
import {
    ILiquidityLauncher
} from "@uniswap/liquidity-launcher/src/interfaces/ILiquidityLauncher.sol";
import { IStrategy } from "@uniswap/liquidity-launcher/src/interfaces/IStrategy.sol";
import { Distribution } from "@uniswap/liquidity-launcher/src/types/Distribution.sol";
import { UERC20Factory } from "@uniswap/uerc20-factory/src/factories/UERC20Factory.sol";
import { UERC20Metadata } from "@uniswap/uerc20-factory/src/libraries/UERC20MetadataLibrary.sol";

contract PoolManagerDistributionStrategy is IStrategy {
    address public immutable poolManager;
    address public launcher;
    address public token;
    uint256 public amount;
    bytes32 public distributionSalt;

    constructor(address poolManager_) {
        poolManager = poolManager_;
    }

    function initializeDistribution(
        address token_,
        uint256 totalSupply,
        bytes calldata,
        bytes32 distributionSalt_
    ) external override {
        launcher = msg.sender;
        token = token_;
        amount = totalSupply;
        distributionSalt = distributionSalt_;

        IERC20(token_).transferFrom(msg.sender, poolManager, totalSupply);
        emit DistributionInitialized(address(this), token_, totalSupply);
    }
}

/// @notice Exercises the pinned launcher and factory source through one local composition.
contract RealLauncherFactoryCompositionTest {
    uint128 private constant INITIAL_SUPPLY = 1_000_000e18;
    bytes32 private constant LAUNCH_SALT = keccak256("real launcher factory composition");

    function test_realLauncherAndFactoryCreateAndDistributeTokenToLocalPoolManager() external {
        PoolManager manager = new PoolManager(address(this));
        LiquidityLauncher launcher = new LiquidityLauncher(IAllowanceTransfer(address(0)));
        UERC20Factory factory = new UERC20Factory();
        PoolManagerDistributionStrategy strategy =
            new PoolManagerDistributionStrategy(address(manager));

        bytes32 graffiti = launcher.getGraffiti(address(this));
        address predicted = factory.getUERC20Address(
            "Composition Token", "COMP", 18, address(launcher), graffiti
        );
        bytes memory tokenData = abi.encode(
            UERC20Metadata({ description: "", website: "", image: "", extraData: "" })
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken,
            (
                address(factory),
                "Composition Token",
                "COMP",
                18,
                INITIAL_SUPPLY,
                address(launcher),
                tokenData
            )
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (
                predicted,
                Distribution({
                    strategy: address(strategy), amount: INITIAL_SUPPLY, configData: ""
                }),
                LAUNCH_SALT
            )
        );

        bytes[] memory results = launcher.multicall(calls);
        address token = abi.decode(results[0], (address));

        assert(token == predicted);
        assert(token.code.length != 0);
        assert(IERC20(token).totalSupply() == INITIAL_SUPPLY);
        assert(IERC20(token).balanceOf(address(manager)) == INITIAL_SUPPLY);
        assert(IERC20(token).balanceOf(address(launcher)) == 0);
        assert(strategy.launcher() == address(launcher));
        assert(strategy.token() == token);
        assert(strategy.amount() == INITIAL_SUPPLY);
        assert(strategy.distributionSalt() == keccak256(abi.encode(address(this), LAUNCH_SALT)));
    }
}
