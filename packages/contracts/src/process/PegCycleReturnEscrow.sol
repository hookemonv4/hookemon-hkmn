// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPegCycleEscrowUsdg {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/// @notice Immutable USDG custody for exactly one peg cycle.
contract PegCycleReturnEscrow {
    address public immutable coordinator;
    address public immutable usdg;
    address public immutable hook;
    address public immutable routeExecutor;
    bytes32 public immutable cycleId;

    error InvalidIdentity();
    error UnauthorizedCaller();
    error TokenTransferFailed();
    error TokenBalanceDeltaMismatch();

    constructor(
        address coordinator_,
        address usdg_,
        address hook_,
        address routeExecutor_,
        bytes32 cycleId_
    ) {
        if (
            coordinator_ == address(0) || coordinator_.code.length == 0 || usdg_ == address(0)
                || usdg_.code.length == 0 || hook_ == address(0) || hook_.code.length == 0
                || routeExecutor_ == address(0) || routeExecutor_.code.length == 0
                || cycleId_ == bytes32(0) || coordinator_ == usdg_ || coordinator_ == hook_
                || coordinator_ == routeExecutor_ || hook_ == routeExecutor_
        ) revert InvalidIdentity();
        coordinator = coordinator_;
        usdg = usdg_;
        hook = hook_;
        routeExecutor = routeExecutor_;
        cycleId = cycleId_;
    }

    function sendOutbound(uint256 amount) external {
        if (msg.sender != coordinator) revert UnauthorizedCaller();
        _transferExact(routeExecutor, amount);
    }

    function sendPayout(uint256 amount) external {
        if (msg.sender != coordinator) revert UnauthorizedCaller();
        _transferExact(hook, amount);
    }

    function _transferExact(address recipient, uint256 amount) private {
        uint256 sourceBalanceBefore = IPegCycleEscrowUsdg(usdg).balanceOf(address(this));
        uint256 destinationBalanceBefore = IPegCycleEscrowUsdg(usdg).balanceOf(recipient);
        (bool success, bytes memory result) =
            usdg.call(abi.encodeCall(IPegCycleEscrowUsdg.transfer, (recipient, amount)));
        if (!success || result.length != 32) revert TokenTransferFailed();
        uint256 returned;
        assembly ("memory-safe") {
            returned := mload(add(result, 0x20))
        }
        if (returned != 1) revert TokenTransferFailed();
        uint256 sourceBalanceAfter = IPegCycleEscrowUsdg(usdg).balanceOf(address(this));
        uint256 destinationBalanceAfter = IPegCycleEscrowUsdg(usdg).balanceOf(recipient);
        if (
            sourceBalanceAfter > sourceBalanceBefore
                || sourceBalanceBefore - sourceBalanceAfter != amount
                || destinationBalanceAfter < destinationBalanceBefore
                || destinationBalanceAfter - destinationBalanceBefore != amount
        ) revert TokenBalanceDeltaMismatch();
    }
}
