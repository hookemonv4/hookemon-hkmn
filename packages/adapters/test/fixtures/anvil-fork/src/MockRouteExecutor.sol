// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "./process/IPegCycleRouteExecutor.sol";

/// @notice No-op route executor: the real `PegCycleVault.executeOutbound` already moves the
/// escrow's USDG to this contract before calling `executeOutbound`; this mock only needs to exist
/// (have code) and not revert, so the anvil integration test can exercise the real
/// `PegCycleVault.executeOutbound` calldata this adapter produces.
contract MockRouteExecutor is IPegCycleRouteExecutor {
    event OutboundExecuted(bytes32 indexed cycleId, address usdg, uint256 amount, address returnDestination, bytes routeData);

    function executeOutbound(
        bytes32 cycleId,
        address usdg,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external {
        emit OutboundExecuted(cycleId, usdg, amount, returnDestination, routeData);
    }
}
