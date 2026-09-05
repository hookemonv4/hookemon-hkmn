// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { FeeAccounting } from "../accounting/FeeAccounting.sol";
import { MoneyRoles } from "../access/MoneyRoles.sol";
import { IPegCycleVault } from "./IPegCycleVault.sol";

interface IPegCycleVaultIdentity {
    function authorizer() external view returns (address);
    function routeExecutor() external view returns (address);
    function usdg() external view returns (address);
}

/// @notice Atomically funds the immutable escrow for one authorized peg cycle.
abstract contract ProcessBudget is FeeAccounting, MoneyRoles {
    struct ReleasedCycle {
        bytes32 cycleId;
        uint256 amount;
        address operationsTrigger;
    }

    IPegCycleVault public immutable pegCycleVault;
    address private immutable pegCycleAuthorizer;
    address private immutable pegCycleRouteExecutor;
    address internal immutable pegCycleUsdg;
    mapping(bytes32 cycleId => ReleasedCycle cycle) private releasedCycles;

    event ProcessBudgetReleased(
        bytes32 indexed cycleId, address indexed operations, uint256 amount
    );

    constructor(
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault pegCycleVault_
    ) FeeAccounting(programmable) MoneyRoles(programmable, treasury, operations) {
        address vault = address(pegCycleVault_);
        if (vault == address(0) || vault.code.length == 0) revert InvalidDestination();
        address vaultAuthorizer = IPegCycleVaultIdentity(vault).authorizer();
        address vaultRouteExecutor = IPegCycleVaultIdentity(vault).routeExecutor();
        address vaultUsdg = IPegCycleVaultIdentity(vault).usdg();
        if (
            vaultAuthorizer == address(0) || vault == address(this) || vault == programmable
                || vault == treasury || vault == operations || vaultAuthorizer == programmable
                || vaultAuthorizer == treasury || vaultAuthorizer == operations
                || vaultAuthorizer == address(this) || operations == vaultRouteExecutor
                || operations == vaultUsdg
        ) revert InvalidDestination();
        pegCycleVault = pegCycleVault_;
        pegCycleAuthorizer = vaultAuthorizer;
        pegCycleRouteExecutor = vaultRouteExecutor;
        pegCycleUsdg = vaultUsdg;
    }

    function openPegCycle(bytes32 cycleId)
        external
        moneyPath
        returns (ReleasedCycle memory released)
    {
        address operations = _bindCycleOperationsTrigger(cycleId, msg.sender);
        (IPegCycleVault.FundingAuthorization memory auth, uint256 beforeBalance) =
            pegCycleVault.consumeFundingAuthorization(cycleId, operations);
        _debitProcessLiability(auth.amount);
        _transferExactUsdg(auth.returnDestination, auth.amount);
        pegCycleVault.confirmFunding(cycleId, beforeBalance);
        released =
            ReleasedCycle({ cycleId: cycleId, amount: auth.amount, operationsTrigger: operations });
        releasedCycles[cycleId] = released;
        emit ProcessBudgetReleased(cycleId, operations, auth.amount);
    }

    function readReleasedCycle(bytes32 cycleId) external view returns (ReleasedCycle memory) {
        return releasedCycles[cycleId];
    }

    function _currentTreasuryBeneficiary() internal view override returns (address) {
        return _currentTreasury();
    }

    function _validateRoleSuccessor(address successor, address currentAccount)
        internal
        view
        override
    {
        super._validateRoleSuccessor(successor, currentAccount);
        if (successor == pegCycleAuthorizer) revert InvalidSuccessor();
    }

    function _validateOperationsSuccessor(address successor) internal view override {
        if (successor == pegCycleRouteExecutor || successor == pegCycleUsdg) {
            revert InvalidSuccessor();
        }
    }
}
