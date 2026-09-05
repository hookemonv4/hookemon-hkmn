// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault } from "./process/IPegCycleVault.sol";

interface IMockUsdg {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Minimal stand-in for `HookemonHook` exposing exactly the two entrypoints
/// packages/adapters/src/hook-contract-client.mjs targets (`openPegCycle`,
/// `fundPayoutFromPegCycle`), so the anvil integration test can exercise the real deployed
/// `PegCycleVault` this adapter's calldata is built against without needing Uniswap v4's
/// CREATE2 hook-permission-bit address mining (out of packages/adapters' scope — see
/// design.md §7 / WP-20). This mock deliberately reproduces only the on-chain call sequence
/// `ProcessBudget.openPegCycle`/`PayoutCommitment.fundPayoutFromPegCycle` perform against
/// `PegCycleVault`, not their liability-accounting bookkeeping.
contract MockHook {
    IPegCycleVault public immutable pegCycleVault;
    address public immutable usdg;

    constructor(IPegCycleVault pegCycleVault_, address usdg_) {
        pegCycleVault = pegCycleVault_;
        usdg = usdg_;
    }

    function openPegCycle(bytes32 cycleId)
        external
        returns (bytes32 releasedCycleId, uint256 amount, address operationsTrigger)
    {
        (IPegCycleVault.FundingAuthorization memory auth, uint256 beforeBalance) =
            pegCycleVault.consumeFundingAuthorization(cycleId, msg.sender);
        (bool ok,) = usdg.call(abi.encodeWithSignature("transfer(address,uint256)", auth.returnDestination, auth.amount));
        require(ok, "usdg transfer failed");
        pegCycleVault.confirmFunding(cycleId, beforeBalance);
        return (cycleId, auth.amount, auth.operationsTrigger);
    }

    function fundPayoutFromPegCycle(IPegCycleVault.PayoutAuthorization calldata authorization)
        external
        returns (address operationsTrigger, uint256 rootSum)
    {
        uint256 before_ = IMockUsdg(usdg).balanceOf(address(this));
        operationsTrigger = pegCycleVault.consumePayoutAuthorization(authorization);
        uint256 after_ = IMockUsdg(usdg).balanceOf(address(this));
        require(after_ - before_ == authorization.rootSum, "payout balance delta mismatch");
        rootSum = authorization.rootSum;
    }
}
