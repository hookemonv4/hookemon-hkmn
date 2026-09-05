// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";

import { IStrategy } from "@uniswap/liquidity-launcher/src/interfaces/IStrategy.sol";
import {
    ILiquidityLauncher
} from "@uniswap/liquidity-launcher/src/interfaces/ILiquidityLauncher.sol";
import { IMulticall } from "@uniswap/liquidity-launcher/src/interfaces/IMulticall.sol";
import { Distribution } from "@uniswap/liquidity-launcher/src/types/Distribution.sol";

// Test-only, clean-room stand-ins for the vendored liquidity-launcher package's
// "LiquidityLauncher" and the vendored uerc20-factory package's "UERC20Factory" contracts.
//
// These exist ONLY because the real vendored contracts cannot be compiled in this environment
// today: "LiquidityLauncher.sol" unconditionally imports "ITokenFactory.sol", whose source (via
// "UERC20MetadataLibrary.sol") calls OpenZeppelin's escapeJSON (added in OZ 5.1+); this repo's
// frozen "@openzeppelin/" remapping pins OZ 5.0.2 (v4-core's vendored copy), which does not have
// it. Reproduced independently by compiling nothing but a single import of the real
// LiquidityLauncher.sol alone -- the identical compile error surfaces with zero code from this
// package involved. Fixing it needs a coordinated remappings.txt/foundry.toml change; both are
// content-hash-pinned by the requirements-revision-57 interface freeze
// (feasibility/interface-freeze.json), so it is outside this work package's writeSet and
// authority -- see docs/modules/custom-launch-strategy.md's "Recovery pointers" for the retest
// plan once that gap closes.
//
// These stand-ins replicate the real contracts' external control flow byte-for-byte for every
// code path CustomLaunchStrategy actually exercises: TestLiquidityLauncher.createToken mints via
// the given factory to the given recipient and emits TokenCreated; distributeToken
// force-approves distribution.strategy for distribution.amount, calls
// IStrategy.initializeDistribution, and reverts exactly like the real contract's own
// AllowanceNotFullyConsumed check unless the full allowance was pulled; multicall is the
// identical self-delegatecall batching pattern (preserving msg.sender across the batch);
// getGraffiti is the identical keccak256(abi.encode(originalCreator)) formula.
// TestUERC20Factory/TestUERC20 replicate the real factory/token's exact CREATE2
// salt/init-code-hash formula and mint-on-construct behavior, so getUERC20Address predictions
// still match the real deployment address these stand-ins produce. They are not the real
// vendored contracts and must not be mistaken for a live integration proof against them.
contract TestLiquidityLauncher is ILiquidityLauncher, IMulticall {
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            if (!success) {
                assembly {
                    revert(add(result, 0x20), mload(result))
                }
            }
            results[i] = result;
        }
    }

    function createToken(
        address factory,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint128 initialSupply,
        address recipient,
        bytes calldata tokenData
    ) external payable override returns (address tokenAddress) {
        if (recipient == address(0)) revert RecipientCannotBeZeroAddress();
        tokenAddress = TestUERC20Factory(factory)
            .createToken(
                name, symbol, decimals, initialSupply, recipient, tokenData, getGraffiti(msg.sender)
            );
        emit TokenCreated(tokenAddress);
    }

    function depositToken(address, uint160) external payable override {
        revert("TestLiquidityLauncher: depositToken unused by CustomLaunchStrategy");
    }

    function distributeToken(address token, Distribution calldata distribution, bytes32 salt)
        external
        payable
        override
    {
        require(IERC20(token).approve(distribution.strategy, distribution.amount));
        IStrategy(distribution.strategy)
            .initializeDistribution(
                token,
                distribution.amount,
                distribution.configData,
                keccak256(abi.encode(msg.sender, salt))
            );
        if (IERC20(token).allowance(address(this), distribution.strategy) != 0) {
            revert AllowanceNotFullyConsumed();
        }
        emit TokenDistributed(token, distribution.strategy, distribution.amount);
    }

    function distributeWithNative(address, bytes calldata, bytes32, uint256)
        external
        payable
        override
    {
        revert("TestLiquidityLauncher: distributeWithNative unused by CustomLaunchStrategy");
    }

    function getGraffiti(address originalCreator) public pure override returns (bytes32 graffiti) {
        graffiti = keccak256(abi.encode(originalCreator));
    }
}

contract TestUERC20Factory {
    struct Parameters {
        uint256 totalSupply;
        bytes32 graffiti;
        address recipient;
        address creator;
        uint8 decimals;
        string name;
        string symbol;
    }

    Parameters private parameters;

    error RecipientCannotBeZeroAddress();
    error TotalSupplyCannotBeZero();

    function getUERC20Address(
        string memory name,
        string memory symbol,
        uint8 decimals,
        address creator,
        bytes32 graffiti
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(name, symbol, decimals, creator, graffiti));
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(TestUERC20).creationCode));
        return Create2.computeAddress(salt, initCodeHash, address(this));
    }

    function getParameters() external view returns (Parameters memory) {
        return parameters;
    }

    function createToken(
        string memory name,
        string memory symbol,
        uint8 decimals,
        uint256 totalSupply,
        address recipient,
        bytes calldata,
        bytes32 graffiti
    ) external returns (address tokenAddress) {
        if (recipient == address(0)) revert RecipientCannotBeZeroAddress();
        if (totalSupply == 0) revert TotalSupplyCannotBeZero();
        parameters = Parameters({
            name: name,
            symbol: symbol,
            totalSupply: totalSupply,
            recipient: recipient,
            decimals: decimals,
            creator: msg.sender,
            graffiti: graffiti
        });
        bytes32 salt = keccak256(abi.encode(name, symbol, decimals, msg.sender, graffiti));
        tokenAddress = address(new TestUERC20{ salt: salt }());
        delete parameters;
    }
}

contract TestUERC20 is IERC20, IERC20Metadata {
    string private _name;
    string private _symbol;
    uint8 private _decimals;
    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    constructor() {
        TestUERC20Factory.Parameters memory params = TestUERC20Factory(msg.sender).getParameters();
        _name = params.name;
        _symbol = params.symbol;
        _decimals = params.decimals;
        _totalSupply = params.totalSupply;
        _balances[params.recipient] = params.totalSupply;
        emit Transfer(address(0), params.recipient, params.totalSupply);
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address ownerAccount, address spender)
        external
        view
        override
        returns (uint256)
    {
        return _allowances[ownerAccount][spender];
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        override
        returns (bool)
    {
        uint256 current = _allowances[from][msg.sender];
        require(current >= amount, "TestUERC20: insufficient allowance");
        if (current != type(uint256).max) {
            _allowances[from][msg.sender] = current - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(_balances[from] >= amount, "TestUERC20: insufficient balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
