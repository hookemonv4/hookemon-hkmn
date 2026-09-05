// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPegCycleRouteExecutor {
    function executeOutbound(
        bytes32 cycleId,
        address usdg,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external;
}
