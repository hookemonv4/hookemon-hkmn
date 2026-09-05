// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PegCycleReturnEscrow } from "./PegCycleReturnEscrow.sol";

/// @notice Computes and `CREATE2`-deploys one cycle's `PegCycleReturnEscrow`, exactly the address
/// computation and deployment `PegCycleVault.computeCycleEscrow` and
/// `PegCycleVault._storeFundingAuthorization` performed inline before this split.
/// @dev Declared as an `external` library deliberately: `PegCycleReturnEscrow`'s full creation
/// bytecode (its constructor plus its own ~2.1 KB deployed runtime code, roughly 2.8 KB total)
/// must be embedded as a literal data blob wherever `type(PegCycleReturnEscrow).creationCode` is
/// read or `new PegCycleReturnEscrow{salt}(...)` is executed -- and both `computeAddress` and
/// `deploy` run at RUNTIME (every cycle open), not at `PegCycleVault`'s own construction time, so
/// that blob would otherwise sit in `PegCycleVault`'s own deployed bytecode forever. Moving it here
/// is the same technique `FundingAuthorizationValidation` and `PayoutDistributionSignatures` use to
/// keep their own logic out of the vault's EIP-170 24,576-byte runtime budget, applied to the one
/// remaining call site that embeds a large literal blob rather than ordinary validation logic.
/// Every function here runs via `DELEGATECALL`, so `address(this)` inside them already resolves to
/// the vault, not this library -- the computed `CREATE2` address (which is keyed on the deployer
/// address) and the freshly deployed escrow's own reported factory identity are unaffected by
/// where this code physically lives.
library PegCycleEscrowFactory {
    /// @notice A freshly `CREATE2`-deployed escrow's own reported identity does not exactly match
    /// the coordinator, USDG, hook, route executor, and cycle identifier it was just deployed
    /// with. A selector depends only on its name and parameter types, never on which contract
    /// declares it, so this is the exact same selector as `PegCycleVault`'s own
    /// `InvalidAuthorization` (declared there for its other inline checks).
    error InvalidAuthorization();

    /// @notice Returns the deterministic `CREATE2` address one cycle's escrow will be deployed to,
    /// given the calling vault's own already-bound identity.
    function computeAddress(address usdg, address hook, address routeExecutor, bytes32 cycleId)
        external
        view
        returns (address)
    {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(PegCycleReturnEscrow).creationCode,
                abi.encode(address(this), usdg, hook, routeExecutor, cycleId)
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), cycleId, initCodeHash))
                )
            )
        );
    }

    /// @notice Deploys one cycle's escrow via `CREATE2` (salt = `cycleId`) and reverts unless the
    /// freshly deployed escrow's own reported identity exactly matches what was requested.
    function deploy(address usdg, address hook, address routeExecutor, bytes32 cycleId)
        external
        returns (address escrow)
    {
        PegCycleReturnEscrow deployed = new PegCycleReturnEscrow{ salt: cycleId }(
            address(this), usdg, hook, routeExecutor, cycleId
        );
        escrow = address(deployed);
        if (
            deployed.coordinator() != address(this) || deployed.usdg() != usdg
                || deployed.hook() != hook || deployed.routeExecutor() != routeExecutor
                || deployed.cycleId() != cycleId
        ) revert InvalidAuthorization();
    }
}
