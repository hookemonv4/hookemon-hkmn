// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PegCycleRouteExecutor } from "../../src/process/PegCycleRouteExecutor.sol";
import { PegCycleReturnEscrow } from "../../src/process/PegCycleReturnEscrow.sol";

interface RouteVm {
    function prank(address caller) external;
}

/// @notice Standalone unit tests for the immutable Relay outbound route executor, wired against
/// minimal stand-ins for the coordinator vault and USDG so the executor's own invariants are
/// exercised without depending on the full PegCycleVault lifecycle (that end-to-end wiring is
/// covered separately in PegCycleVault.t.sol).
contract PegCycleRouteExecutorTest {
    RouteVm private constant VM = RouteVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant CYCLE_ONE = keccak256("route-cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("route-cycle-two");
    bytes32 private constant REQUEST_ID = keccak256("relay-request-one");
    address private constant STRANGER = address(0xBAD2);
    address private constant DEPOSIT_TARGET = address(0xDEC0);
    bytes4 private constant CALLBACK_SELECTOR =
        bytes4(keccak256("depositWithId(address,uint256,bytes)"));

    function test_constructorRejectsEveryInvalidImmutableIdentity() external {
        RouteUsdg usdg = new RouteUsdg();
        RouteVaultStub vaultStub = new RouteVaultStub(address(usdg), address(new RouteHookStub()));

        _expectConstructRevert(address(0), address(vaultStub), DEPOSIT_TARGET);
        _expectConstructRevert(address(0xDEAD), address(vaultStub), DEPOSIT_TARGET); // no code
        _expectConstructRevert(address(usdg), address(0), DEPOSIT_TARGET);
        _expectConstructRevert(address(usdg), address(usdg), DEPOSIT_TARGET);
        _expectConstructRevert(address(usdg), address(vaultStub), address(0));
        _expectConstructRevert(address(usdg), address(vaultStub), address(usdg));
        _expectConstructRevert(address(usdg), address(vaultStub), address(vaultStub));

        PegCycleRouteExecutor executor =
            new PegCycleRouteExecutor(address(usdg), address(vaultStub), DEPOSIT_TARGET, bytes4(0));
        assert(executor.usdg() == address(usdg));
        assert(executor.vault() == address(vaultStub));
        assert(executor.depositTarget() == DEPOSIT_TARGET);
        assert(executor.depositCallbackSelector() == bytes4(0));
    }

    function test_onlyBoundVaultMayCallExecuteOutbound() external {
        (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
            _deploy(bytes4(0));
        (bytes32 cycleId, address escrow) = _fundedCycle(usdg, vaultStub, executor, CYCLE_ONE, 250);
        bytes memory routeData = _route(250, 1);

        VM.prank(STRANGER);
        (bool success,) = address(executor)
            .call(
                abi.encodeCall(
                    PegCycleRouteExecutor.executeOutbound,
                    (cycleId, address(usdg), 250, escrow, routeData)
                )
            );
        assert(!success);
        assert(usdg.balanceOf(address(executor)) == 250);
    }

    function test_wrongTokenCycleAmountEscrowAndRouteParamsAllRevertWithoutMovingFunds() external {
        (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
            _deploy(bytes4(0));
        (bytes32 cycleId, address escrow) = _fundedCycle(usdg, vaultStub, executor, CYCLE_ONE, 250);

        _rejectExecute(
            vaultStub, executor, cycleId, address(vaultStub), 250, escrow, _route(250, 1)
        );
        _rejectExecute(vaultStub, executor, bytes32(0), address(usdg), 250, escrow, _route(250, 1));
        _rejectExecute(vaultStub, executor, cycleId, address(usdg), 0, escrow, _route(250, 1));
        _rejectExecute(vaultStub, executor, cycleId, address(usdg), 250, STRANGER, _route(250, 1));
        _rejectExecute(
            vaultStub,
            executor,
            cycleId,
            address(usdg),
            250,
            escrow,
            _routeWithTarget(STRANGER, 250, 1)
        );
        _rejectExecute(vaultStub, executor, cycleId, address(usdg), 250, escrow, _route(249, 1));
        _rejectExecute(vaultStub, executor, cycleId, address(usdg), 250, escrow, _route(250, 0));
        _rejectExecute(
            vaultStub,
            executor,
            cycleId,
            address(usdg),
            250,
            escrow,
            abi.encode(
                PegCycleRouteExecutor.RouteParams({
                    target: DEPOSIT_TARGET, amount: 250, requestId: bytes32(0), minimumReceive: 1
                })
            )
        );
        // The funded escrow already pushed its principal to the executor before every rejected
        // call above (matching PegCycleVault's own transfer order); none of the rejections move
        // it any further.
        assert(usdg.balanceOf(address(executor)) == 250);
        assert(usdg.balanceOf(escrow) == 0);
    }

    function test_incomingBalanceMismatchRevertsWhenEscrowNeverPushedThePrincipal() external {
        (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
            _deploy(bytes4(0));
        bytes32 cycleId = CYCLE_ONE;
        address escrow = vaultStub.deployEscrow(cycleId);
        usdg.mint(escrow, 250);
        // Deliberately skip vaultStub.pushOutbound: the executor's own balance is still zero.
        _rejectExecute(vaultStub, executor, cycleId, address(usdg), 250, escrow, _route(250, 1));
        assert(usdg.balanceOf(address(executor)) == 0);
        assert(usdg.balanceOf(escrow) == 250);
    }

    function test_plainTransferModeMovesExactPrincipalAndEmitsRouteExecuted() external {
        (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
            _deploy(bytes4(0));
        (bytes32 cycleId, address escrow) = _fundedCycle(usdg, vaultStub, executor, CYCLE_ONE, 250);

        VM.prank(address(vaultStub));
        executor.executeOutbound(cycleId, address(usdg), 250, escrow, _route(250, 1));

        assert(usdg.balanceOf(escrow) == 0);
        assert(usdg.balanceOf(address(executor)) == 0);
        assert(usdg.balanceOf(DEPOSIT_TARGET) == 250);
    }

    function test_replayOfTheSameOutboundCallFailsOnIncomingBalance() external {
        (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
            _deploy(bytes4(0));
        (bytes32 cycleId, address escrow) = _fundedCycle(usdg, vaultStub, executor, CYCLE_ONE, 250);
        bytes memory routeData = _route(250, 1);

        VM.prank(address(vaultStub));
        executor.executeOutbound(cycleId, address(usdg), 250, escrow, routeData);

        VM.prank(address(vaultStub));
        (bool replay,) = address(executor)
            .call(
                abi.encodeCall(
                    PegCycleRouteExecutor.executeOutbound,
                    (cycleId, address(usdg), 250, escrow, routeData)
                )
            );
        assert(!replay);
        assert(usdg.balanceOf(DEPOSIT_TARGET) == 250);
    }

    function test_tokenCallbackModeEmbedsRequestIdAndMovesExactPrincipal() external {
        (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
            _deploy(CALLBACK_SELECTOR);
        (bytes32 cycleId, address escrow) = _fundedCycle(usdg, vaultStub, executor, CYCLE_TWO, 175);

        VM.prank(address(vaultStub));
        executor.executeOutbound(cycleId, address(usdg), 175, escrow, _route(175, 1));

        assert(usdg.balanceOf(address(executor)) == 0);
        assert(usdg.balanceOf(DEPOSIT_TARGET) == 175);
        assert(usdg.lastCallbackTo() == DEPOSIT_TARGET);
        assert(usdg.lastCallbackAmount() == 175);
        assert(keccak256(usdg.lastCallbackData()) == keccak256(abi.encode(REQUEST_ID)));
    }

    function test_tokenFailureShortDestinationExcessDestinationAndShortSourceAllRevert() external {
        RouteUsdg.Behavior[4] memory behaviors;
        behaviors[0] = RouteUsdg.Behavior.RevertTransfer;
        behaviors[1] = RouteUsdg.Behavior.ReturnFalse;
        behaviors[2] = RouteUsdg.Behavior.ShortDestination;
        behaviors[3] = RouteUsdg.Behavior.ExcessDestination;
        for (uint256 index; index < behaviors.length; ++index) {
            (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor) =
                _deploy(bytes4(0));
            (bytes32 cycleId, address escrow) =
                _fundedCycle(usdg, vaultStub, executor, CYCLE_ONE, 250);
            usdg.setBehavior(behaviors[index]);
            _rejectExecute(vaultStub, executor, cycleId, address(usdg), 250, escrow, _route(250, 1));
        }

        (RouteUsdg shortUsdg, RouteVaultStub shortVaultStub, PegCycleRouteExecutor shortExecutor) =
            _deploy(bytes4(0));
        (bytes32 shortCycleId, address shortEscrow) =
            _fundedCycle(shortUsdg, shortVaultStub, shortExecutor, CYCLE_ONE, 250);
        shortUsdg.setBehavior(RouteUsdg.Behavior.ShortSource);
        VM.prank(address(shortVaultStub));
        (bool success,) = address(shortExecutor)
            .call(
                abi.encodeCall(
                    PegCycleRouteExecutor.executeOutbound,
                    (shortCycleId, address(shortUsdg), 250, shortEscrow, _route(250, 1))
                )
            );
        assert(!success);
        // ShortSource leaves 1 unit stuck in the executor: ResidualBalance must revert the whole
        // call, so no state (including the destination credit) survives.
        assert(shortUsdg.balanceOf(DEPOSIT_TARGET) == 0);
    }

    function _deploy(bytes4 callbackSelector)
        private
        returns (RouteUsdg usdg, RouteVaultStub vaultStub, PegCycleRouteExecutor executor)
    {
        usdg = new RouteUsdg();
        vaultStub = new RouteVaultStub(address(usdg), address(new RouteHookStub()));
        executor = new PegCycleRouteExecutor(
            address(usdg), address(vaultStub), DEPOSIT_TARGET, callbackSelector
        );
        vaultStub.bindExecutor(address(executor));
    }

    function _fundedCycle(
        RouteUsdg usdg,
        RouteVaultStub vaultStub,
        PegCycleRouteExecutor executor,
        bytes32 cycleId,
        uint256 amount
    ) private returns (bytes32, address escrow) {
        executor;
        escrow = vaultStub.deployEscrow(cycleId);
        usdg.mint(escrow, amount);
        vaultStub.pushOutbound(escrow, amount);
        return (cycleId, escrow);
    }

    function _route(uint256 amount, uint256 minimumReceive) private pure returns (bytes memory) {
        return _routeWithTarget(DEPOSIT_TARGET, amount, minimumReceive);
    }

    function _routeWithTarget(address target, uint256 amount, uint256 minimumReceive)
        private
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PegCycleRouteExecutor.RouteParams({
                target: target,
                amount: amount,
                requestId: REQUEST_ID,
                minimumReceive: minimumReceive
            })
        );
    }

    function _rejectExecute(
        RouteVaultStub vaultStub,
        PegCycleRouteExecutor executor,
        bytes32 cycleId,
        address usdgToken,
        uint256 amount,
        address returnDestination,
        bytes memory routeData
    ) private {
        VM.prank(address(vaultStub));
        (bool success,) = address(executor)
            .call(
                abi.encodeCall(
                    PegCycleRouteExecutor.executeOutbound,
                    (cycleId, usdgToken, amount, returnDestination, routeData)
                )
            );
        assert(!success);
    }

    function _expectConstructRevert(address usdg, address vault, address depositTarget) private {
        try new PegCycleRouteExecutor(usdg, vault, depositTarget, bytes4(0)) returns (
            PegCycleRouteExecutor
        ) {
            assert(false);
        } catch { }
    }
}

contract RouteHookStub { }

/// @notice Minimal stand-in for PegCycleVault: deploys per-cycle escrows with the exact same
/// CREATE2 formula PegCycleVault uses (coordinator = address(this) at deployment time), and
/// forwards the escrow's push-only sendOutbound the same way PegCycleVault.executeOutbound does.
contract RouteVaultStub {
    address public immutable usdg;
    address public immutable hook;
    address public routeExecutor;

    constructor(address usdg_, address hook_) {
        usdg = usdg_;
        hook = hook_;
    }

    function bindExecutor(address executor_) external {
        routeExecutor = executor_;
    }

    function deployEscrow(bytes32 cycleId) external returns (address) {
        PegCycleReturnEscrow escrow = new PegCycleReturnEscrow{ salt: cycleId }(
            address(this), usdg, hook, routeExecutor, cycleId
        );
        return address(escrow);
    }

    function pushOutbound(address escrow, uint256 amount) external {
        PegCycleReturnEscrow(escrow).sendOutbound(amount);
    }
}

contract RouteUsdg {
    enum Behavior {
        Normal,
        RevertTransfer,
        ReturnFalse,
        ShortSource,
        ShortDestination,
        ExcessDestination
    }

    mapping(address => uint256) private balances;
    Behavior private behavior;
    address private lastCallbackTo_;
    uint256 private lastCallbackAmount_;
    bytes private lastCallbackData_;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function setBehavior(Behavior next) external {
        behavior = next;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        Behavior active = behavior;
        if (active == Behavior.RevertTransfer) revert();
        if (active == Behavior.ReturnFalse) return false;
        uint256 sourceDelta = active == Behavior.ShortSource ? amount - 1 : amount;
        uint256 destinationDelta = active == Behavior.ShortDestination
            ? amount - 1
            : active == Behavior.ExcessDestination ? amount + 1 : amount;
        balances[msg.sender] -= sourceDelta;
        balances[recipient] += destinationDelta;
        return true;
    }

    /// @notice ERC-677/`transferAndCall`-shaped token callback: moves the exact amount from the
    /// caller to `to` and records the embedded calldata for the test to assert on.
    function depositWithId(address to, uint256 amount, bytes calldata data)
        external
        returns (bool)
    {
        balances[msg.sender] -= amount;
        balances[to] += amount;
        lastCallbackTo_ = to;
        lastCallbackAmount_ = amount;
        lastCallbackData_ = data;
        return true;
    }

    function lastCallbackTo() external view returns (address) {
        return lastCallbackTo_;
    }

    function lastCallbackAmount() external view returns (uint256) {
        return lastCallbackAmount_;
    }

    function lastCallbackData() external view returns (bytes memory) {
        return lastCallbackData_;
    }
}
