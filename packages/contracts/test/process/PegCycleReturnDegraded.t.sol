// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "../../src/process/IPegCycleRouteExecutor.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface DegradedVm {
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
}

/// @notice Covers the two dead-end fixes closed by WP-03: the dust fast path is exercised in
/// PegCycleVault.t.sol; this file exercises the DEGRADED quarantine and its successor-cycle
/// recovery path exclusively.
contract PegCycleReturnDegradedTest {
    DegradedVm private constant VM =
        DegradedVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant CYCLE_ONE = keccak256("degraded-cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("degraded-cycle-two");
    bytes32 private constant CYCLE_THREE = keccak256("degraded-cycle-three");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");
    bytes32 private constant RECEIPT_DIGEST = keccak256("degraded-receipt");
    address private constant OPERATIONS = address(0x7000);
    address private constant STRANGER = address(0xBAD1);

    function test_recordDegradedReturnIsAuthorizerOnlyAndRequiresOutboundLifecycle() external {
        (DegradedUsdg usdg,, PegCycleVault vault, DegradedHook hook) = _deployFunded();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrow, 50);

        // Not yet in OUTBOUND (still FUNDED): must revert without mutation.
        (bool beforeOutbound,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordDegradedReturn, (CYCLE_ONE, RECEIPT_DIGEST, true)
                )
            );
        assert(!beforeOutbound);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.FUNDED));

        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());

        VM.prank(STRANGER);
        (bool wrongCaller,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordDegradedReturn, (CYCLE_ONE, RECEIPT_DIGEST, true)
                )
            );
        assert(!wrongCaller);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
        assert(usdg.balanceOf(escrow) == 50);
        hook;
    }

    function test_returnBelowMinimumWithoutAcceptDegradedStillRevertsNoSilentLaxity() external {
        (DegradedUsdg usdg,, PegCycleVault vault,) = _deployOutbound();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        // A short/ambiguous return: nonzero, but neither >= rootSum (175, per the funding's
        // minimumReturnUsdg used elsewhere) nor zero.
        usdg.mint(escrow, 50);

        (bool falseFlag,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordDegradedReturn, (CYCLE_ONE, RECEIPT_DIGEST, false)
                )
            );
        assert(!falseFlag);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
        assert(usdg.balanceOf(escrow) == 50);

        // A zero balance and a zero receipt digest are rejected regardless of the flag.
        (bool zeroDigest,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.recordDegradedReturn, (CYCLE_ONE, bytes32(0), true)));
        assert(!zeroDigest);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));

        (bool wrongCycle,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordDegradedReturn, (CYCLE_TWO, RECEIPT_DIGEST, true)
                )
            );
        assert(!wrongCycle);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_zeroBalanceCannotBeRecordedDegradedEvenWithAcceptDegraded() external {
        (,, PegCycleVault vault,) = _deployOutbound();
        (bool zeroBalance,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordDegradedReturn, (CYCLE_ONE, RECEIPT_DIGEST, true)
                )
            );
        assert(!zeroBalance);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_acceptDegradedReachesQuarantineAndPermitsFreshSuccessorCycle() external {
        (DegradedUsdg usdg, DegradedExecutor executor, PegCycleVault vault, DegradedHook hook) =
            _deployOutbound();
        address escrowOne = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrowOne, 50);

        vault.recordDegradedReturn(CYCLE_ONE, RECEIPT_DIGEST, true);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.DEGRADED));
        assert(
            IPegCycleVault(address(vault)).cycleLifecycles(CYCLE_ONE)
                == uint8(PegCycleVault.Lifecycle.DEGRADED)
        );
        assert(vault.failureReceiptDigests(CYCLE_ONE) == RECEIPT_DIGEST);
        // Reaching DEGRADED never touches the balance: it is neither pulled anywhere nor
        // reset. The read-only active-authorization view also clears, exactly like FAILED.
        assert(usdg.balanceOf(escrowOne) == 50);
        assert(vault.readActiveAuthorization().cycleId == bytes32(0));

        // A fresh, isolated successor cycle can now be authorized against the exact
        // DEGRADED predecessor and receipt evidence, through the same
        // authorizeFundingAfterFailure-family recovery path a FAILED cycle uses.
        address escrowTwo = vault.computeCycleEscrow(CYCLE_TWO);
        assert(escrowTwo != escrowOne);
        vault.authorizeFundingAfterFailure(
            _funding(vault, hook, CYCLE_TWO, 100, 2), CYCLE_ONE, RECEIPT_DIGEST
        );
        usdg.mint(address(hook), 100);
        hook.fund(CYCLE_TWO, OPERATIONS);

        assert(usdg.balanceOf(escrowOne) == 50);
        assert(usdg.balanceOf(escrowTwo) == 100);
        assert(usdg.balanceOf(address(vault)) == 0);
        assert(vault.failedCycleSuccessors(CYCLE_ONE) == CYCLE_TWO);
        assert(vault.recoveryPredecessors(CYCLE_TWO) == CYCLE_ONE);
        executor;
    }

    function test_degradedBalanceIsNeverAutoSweptAcrossFullSuccessorLifecycle() external {
        (DegradedUsdg usdg,, PegCycleVault vault, DegradedHook hook) = _deployOutbound();
        address escrowOne = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrowOne, 50);
        vault.recordDegradedReturn(CYCLE_ONE, RECEIPT_DIGEST, true);

        vault.authorizeFundingAfterFailure(
            _funding(vault, hook, CYCLE_TWO, 100, 2), CYCLE_ONE, RECEIPT_DIGEST
        );
        usdg.mint(address(hook), 100);
        hook.fund(CYCLE_TWO, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_TWO, _routeAmount(100));
        usdg.mint(vault.cycleEscrows(CYCLE_TWO), 100);
        IPegCycleVault.PayoutAuthorization memory payout = _payout(vault, hook, CYCLE_TWO, 100, 3);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), payout);
            vault.authorizePayout(payout, distributionSignature, verifierSignature);
        }

        hook.consumePayout(payout);

        // Through the successor's entire funding -> outbound -> payout lifecycle, the
        // DEGRADED cycle's quarantined balance never moved and no function reassigned it.
        assert(usdg.balanceOf(escrowOne) == 50);
        assert(usdg.balanceOf(address(vault)) == 0);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
    }

    function test_degradedSuccessorRequiresExactEvidenceAndFreshIdentity() external {
        (DegradedUsdg usdg,, PegCycleVault vault, DegradedHook hook) = _deployDegraded();
        IPegCycleVault.FundingAuthorization memory successor =
            _funding(vault, hook, CYCLE_TWO, 100, 2);

        _rejectOrdinary(vault, successor);
        _rejectDegradedRecovery(vault, successor, CYCLE_TWO, RECEIPT_DIGEST);
        _rejectDegradedRecovery(vault, successor, CYCLE_ONE, keccak256("wrong-receipt"));

        IPegCycleVault.FundingAuthorization memory reusedCycle =
            _funding(vault, hook, CYCLE_ONE, 100, 2);
        _rejectDegradedRecovery(vault, reusedCycle, CYCLE_ONE, RECEIPT_DIGEST);

        vault.authorizeFundingAfterFailure(successor, CYCLE_ONE, RECEIPT_DIGEST);
        _rejectDegradedRecovery(
            vault, _funding(vault, hook, CYCLE_THREE, 100, 3), CYCLE_ONE, RECEIPT_DIGEST
        );
        assert(usdg.balanceOf(address(vault)) == 0);
    }

    function test_cancelledDegradedSuccessorLeavesEscrowConsumedButAllowsFreshSuccessor() external {
        (,, PegCycleVault vault, DegradedHook hook) = _deployDegraded();
        IPegCycleVault.FundingAuthorization memory expired =
            _funding(vault, hook, CYCLE_TWO, 100, 2);
        expired.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFundingAfterFailure(expired, CYCLE_ONE, RECEIPT_DIGEST);
        address expiredEscrow = expired.returnDestination;
        VM.warp(block.timestamp + 2);
        vault.cancelExpiredFundingAuthorization(CYCLE_TWO);

        assert(vault.failedCycleSuccessors(CYCLE_ONE) == bytes32(0));
        assert(vault.isCycleConsumed(CYCLE_TWO));
        assert(vault.isNonceConsumed(2));
        assert(vault.cycleEscrows(CYCLE_TWO) == expiredEscrow);

        vault.authorizeFundingAfterFailure(
            _funding(vault, hook, CYCLE_THREE, 100, 3), CYCLE_ONE, RECEIPT_DIGEST
        );
        assert(vault.failedCycleSuccessors(CYCLE_ONE) == CYCLE_THREE);
    }

    function _deployDegraded()
        private
        returns (
            DegradedUsdg usdg,
            DegradedExecutor executor,
            PegCycleVault vault,
            DegradedHook hook
        )
    {
        (usdg, executor, vault, hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 50);
        vault.recordDegradedReturn(CYCLE_ONE, RECEIPT_DIGEST, true);
    }

    function _deployOutbound()
        private
        returns (
            DegradedUsdg usdg,
            DegradedExecutor executor,
            PegCycleVault vault,
            DegradedHook hook
        )
    {
        (usdg, executor, vault, hook) = _deployFunded();
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());
    }

    function _deployFunded()
        private
        returns (
            DegradedUsdg usdg,
            DegradedExecutor executor,
            PegCycleVault vault,
            DegradedHook hook
        )
    {
        (usdg, executor, vault, hook) = _deploy();
        vault.authorizeFunding(_funding(vault, hook, CYCLE_ONE, 250, 1));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
    }

    function _deploy()
        private
        returns (
            DegradedUsdg usdg,
            DegradedExecutor executor,
            PegCycleVault vault,
            DegradedHook hook
        )
    {
        usdg = new DegradedUsdg();
        executor = new DegradedExecutor(usdg);
        vault = new PegCycleVault(
            address(usdg),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        hook = new DegradedHook(vault, usdg);
        vault.bindHook(address(hook));
    }

    function _funding(
        PegCycleVault vault,
        DegradedHook hook,
        bytes32 cycleId,
        uint256 amount,
        uint256 nonce
    ) private view returns (IPegCycleVault.FundingAuthorization memory) {
        return IPegCycleVault.FundingAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: cycleId,
            hook: address(hook),
            vault: address(vault),
            usdg: address(vault.usdg()),
            operationsTrigger: OPERATIONS,
            amount: amount,
            bindingManifestDigest: BINDING_DIGEST,
            outboundActionDigest: keccak256(_routeAmount(amount)),
            returnActionDigest: RETURN_DIGEST,
            returnDestination: vault.computeCycleEscrow(cycleId),
            minimumRobinhoodReceive: 1,
            minimumSolanaReceive: 1,
            minimumReturnUsdg: 1,
            robinhoodNativeGasCap: 1,
            solanaNativeGasCap: 1,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: nonce
        });
    }

    function _payout(
        PegCycleVault vault,
        DegradedHook hook,
        bytes32 cycleId,
        uint256 amount,
        uint256 nonce
    ) private view returns (IPegCycleVault.PayoutAuthorization memory) {
        return IPegCycleVault.PayoutAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: cycleId,
            hook: address(hook),
            vault: address(vault),
            usdg: address(vault.usdg()),
            operationsTrigger: OPERATIONS,
            bindingManifestDigest: BINDING_DIGEST,
            payoutId: keccak256("degraded-payout"),
            manifestDigest: keccak256("degraded-manifest"),
            rootHash: keccak256("degraded-root"),
            rootSum: amount,
            returnActionDigest: RETURN_DIGEST,
            returnReceiptDigest: keccak256("degraded-return-receipt"),
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: nonce
        });
    }

    function _route() private pure returns (bytes memory) {
        return _routeAmount(250);
    }

    function _routeAmount(uint256 amount) private pure returns (bytes memory) {
        return abi.encode(amount);
    }

    function _rejectOrdinary(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory authorization
    ) private {
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.authorizeFunding, authorization));
        assert(!success);
    }

    function _rejectDegradedRecovery(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory authorization,
        bytes32 degradedCycleId,
        bytes32 receiptDigest
    ) private {
        (bool success,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.authorizeFundingAfterFailure,
                    (authorization, degradedCycleId, receiptDigest)
                )
            );
        assert(!success);
    }
}

contract DegradedHook {
    PegCycleVault public immutable pegCycleVault;
    DegradedUsdg private immutable usdg;

    constructor(PegCycleVault vault, DegradedUsdg token) {
        pegCycleVault = vault;
        usdg = token;
    }

    function fund(bytes32 cycleId, address operationsTrigger) external {
        (IPegCycleVault.FundingAuthorization memory authorization, uint256 balanceBefore) =
            pegCycleVault.consumeFundingAuthorization(cycleId, operationsTrigger);
        require(usdg.transfer(authorization.returnDestination, authorization.amount));
        pegCycleVault.confirmFunding(cycleId, balanceBefore);
    }

    function consumePayout(IPegCycleVault.PayoutAuthorization calldata authorization)
        external
        returns (address operationsTrigger)
    {
        return pegCycleVault.consumePayoutAuthorization(authorization);
    }
}

contract DegradedExecutor is IPegCycleRouteExecutor {
    DegradedUsdg private immutable usdg;

    constructor(DegradedUsdg token) {
        usdg = token;
    }

    function executeOutbound(
        bytes32,
        address token,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external {
        require(token == address(usdg));
        require(returnDestination != msg.sender);
        require(abi.decode(routeData, (uint256)) == amount);
        usdg.burn(address(this), amount);
    }
}

contract DegradedUsdg {
    mapping(address account => uint256 balance) private balances;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function burn(address account, uint256 amount) external {
        balances[account] -= amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[recipient] += amount;
        return true;
    }
}
