// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "./IPegCycleRouteExecutor.sol";
import { PegCycleReturnEscrow } from "./PegCycleReturnEscrow.sol";

interface IPegCycleRouteVaultBinding {
    function hook() external view returns (address);
}

interface IPegCycleRouteUsdg {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/// @notice Immutable, single-purpose relay of the exact vault-authorized outbound USDG principal
/// into the Robinhood -> Solana Relay bridge deposit for one bound coordinator vault.
/// @dev Bound at construction to the USDG token, the coordinator vault, the vault's own
/// CREATE2 escrow formula, and exactly one immutable Relay deposit target (plus an optional
/// single token-side callback selector). Exposes no owner, setter, generic call, delegatecall,
/// approve-to-arbitrary, rescue, or sweep surface: `executeOutbound` is the only mutating
/// function, callable only by the bound vault, and it always ends with zero USDG left in this
/// contract. Production Relay deposit target/selector wiring remains INTEGRATION_PENDING per
/// product/SOURCE_BOUNDARY.md (see docs/modules/peg-cycle-route-executor.md).
contract PegCycleRouteExecutor is IPegCycleRouteExecutor {
    /// @notice The vault-authorized route, bound off-chain into `outboundActionDigest` via
    /// `keccak256(abi.encode(RouteParams))` so it cannot be swapped at execution time.
    struct RouteParams {
        address target;
        uint256 amount;
        bytes32 requestId;
        uint256 minimumReceive;
    }

    address public immutable usdg;
    address public immutable vault;
    address public immutable depositTarget;
    /// @notice Zero means plain-transfer mode: `usdg.transfer(depositTarget, amount)`.
    /// Nonzero names a single fixed token-side callback selector called as
    /// `usdg.call(abi.encodeWithSelector(depositCallbackSelector, depositTarget, amount, abi.encode(requestId)))`
    /// (an ERC-677/`transferAndCall`-shaped call), so the cycle-bound request identifier reaches
    /// the deposit in the same atomic call that moves the tokens. Never a call routed through
    /// `depositTarget` itself, and never a call that grants any allowance.
    bytes4 public immutable depositCallbackSelector;

    error InvalidImmutableIdentity();
    error UnauthorizedCaller();
    error InvalidToken();
    error InvalidAmount();
    error InvalidEscrow();
    error InvalidRouteParams();
    error IncomingBalanceMismatch();
    error TokenTransferFailed();
    error TokenBalanceDeltaMismatch();
    error ResidualBalance();

    event RouteExecuted(
        bytes32 indexed cycleId,
        address indexed target,
        uint256 amount,
        bytes32 indexed requestIdDigest
    );

    constructor(
        address usdg_,
        address vault_,
        address depositTarget_,
        bytes4 depositCallbackSelector_
    ) {
        // `vault_` is intentionally not required to already carry code: this contract must be
        // deployed before the vault (the vault's own constructor requires the route executor to
        // already have code), so the vault address is a precomputed CREATE address at this point.
        if (
            usdg_ == address(0) || usdg_.code.length == 0 || vault_ == address(0) || vault_ == usdg_
                || vault_ == address(this) || depositTarget_ == address(0)
                || depositTarget_ == usdg_ || depositTarget_ == vault_
                || depositTarget_ == address(this)
        ) revert InvalidImmutableIdentity();
        usdg = usdg_;
        vault = vault_;
        depositTarget = depositTarget_;
        depositCallbackSelector = depositCallbackSelector_;
    }

    /// @notice Callable only by the bound vault during `PegCycleVault.executeOutbound`. The
    /// escrow has already pushed exactly `amount` USDG to this contract (the vault's own
    /// transfer order); this function verifies that exact incoming balance, decodes and checks
    /// `routeData` against the immutable deposit target and the `amount` the vault itself
    /// passed, performs the single allowed deposit action, and reverts unless this contract's
    /// USDG balance is exactly zero afterward.
    function executeOutbound(
        bytes32 cycleId,
        address usdgToken,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external {
        if (msg.sender != vault) revert UnauthorizedCaller();
        if (usdgToken != usdg) revert InvalidToken();
        if (cycleId == bytes32(0) || amount == 0) revert InvalidAmount();
        if (returnDestination != _computeCycleEscrow(cycleId)) revert InvalidEscrow();

        RouteParams memory route = abi.decode(routeData, (RouteParams));
        if (
            route.target != depositTarget || route.amount != amount || route.requestId == bytes32(0)
                || route.minimumReceive == 0
        ) revert InvalidRouteParams();

        uint256 incomingBalance = IPegCycleRouteUsdg(usdg).balanceOf(address(this));
        if (incomingBalance != amount) revert IncomingBalanceMismatch();

        if (depositCallbackSelector == bytes4(0)) {
            _depositByTransfer(amount);
        } else {
            _depositByTokenCallback(route.requestId, amount);
        }

        if (IPegCycleRouteUsdg(usdg).balanceOf(address(this)) != 0) revert ResidualBalance();

        emit RouteExecuted(cycleId, depositTarget, amount, keccak256(abi.encode(route.requestId)));
    }

    function _computeCycleEscrow(bytes32 cycleId) private view returns (address) {
        address hook = IPegCycleRouteVaultBinding(vault).hook();
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(PegCycleReturnEscrow).creationCode,
                abi.encode(vault, usdg, hook, address(this), cycleId)
            )
        );
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), vault, cycleId, initCodeHash)))
            )
        );
    }

    function _depositByTransfer(uint256 amount) private {
        uint256 destinationBefore = IPegCycleRouteUsdg(usdg).balanceOf(depositTarget);
        (bool success, bytes memory result) =
            usdg.call(abi.encodeCall(IPegCycleRouteUsdg.transfer, (depositTarget, amount)));
        _requireCanonicalTrueReturn(success, result);
        uint256 destinationAfter = IPegCycleRouteUsdg(usdg).balanceOf(depositTarget);
        if (destinationAfter < destinationBefore || destinationAfter - destinationBefore != amount)
        {
            revert TokenBalanceDeltaMismatch();
        }
    }

    function _depositByTokenCallback(bytes32 requestId, uint256 amount) private {
        uint256 destinationBefore = IPegCycleRouteUsdg(usdg).balanceOf(depositTarget);
        (bool success, bytes memory result) = usdg.call(
            abi.encodeWithSelector(
                depositCallbackSelector, depositTarget, amount, abi.encode(requestId)
            )
        );
        if (!success) revert TokenTransferFailed();
        result;
        uint256 destinationAfter = IPegCycleRouteUsdg(usdg).balanceOf(depositTarget);
        if (destinationAfter < destinationBefore || destinationAfter - destinationBefore != amount)
        {
            revert TokenBalanceDeltaMismatch();
        }
    }

    function _requireCanonicalTrueReturn(bool success, bytes memory result) private pure {
        if (!success || result.length != 32) revert TokenTransferFailed();
        uint256 returned;
        assembly ("memory-safe") {
            returned := mload(add(result, 0x20))
        }
        if (returned != 1) revert TokenTransferFailed();
    }
}
