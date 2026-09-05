// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal ERC20 stand-in for USDG, used only to deploy a real `PegCycleVault` on a local
/// anvil node for packages/adapters' anvil integration test. Not part of packages/contracts; never
/// deployed anywhere but a local, throwaway anvil chain.
contract MockUsdg {
    string public constant name = "Mock USDG";
    string public constant symbol = "mUSDG";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
