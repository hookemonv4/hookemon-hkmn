// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "../../src/process/IPegCycleRouteExecutor.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleReturnEscrow } from "../../src/process/PegCycleReturnEscrow.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface RecoveryVm {
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
}

contract PegCycleVaultRecoveryTest {
    RecoveryVm private constant VM =
        RecoveryVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant CYCLE_ONE = keccak256("recovery-cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("recovery-cycle-two");
    bytes32 private constant CYCLE_THREE = keccak256("recovery-cycle-three");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");
    bytes32 private constant FAILURE_DIGEST = keccak256("failure-receipt");
    bytes32 private constant PAYOUT_ID = keccak256("payout-id");
    bytes32 private constant MANIFEST_DIGEST = keccak256("manifest");
    bytes32 private constant ROOT_HASH = keccak256("root");
    bytes32 private constant RECEIPT_DIGEST = keccak256("return-receipt");
    address private constant OPERATIONS = address(0x7000);
    address private constant STRANGER = address(0xBAD1);

    function test_failedCycleCanBeFollowedByFreshIsolatedCycle() external {
        (RecoveryUsdg usdg, RecoveryExecutor executor, PegCycleVault vault, RecoveryHook hook) =
            _deploy();
        address escrowOne = vault.computeCycleEscrow(CYCLE_ONE);
        vault.authorizeFunding(_funding(vault, hook, CYCLE_ONE, 250, 1));
        assert(vault.cycleEscrows(CYCLE_ONE) == escrowOne);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        assert(usdg.balanceOf(escrowOne) == 250);
        assert(usdg.balanceOf(address(vault)) == 0);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));
        vault.recordTerminalFailure(CYCLE_ONE, FAILURE_DIGEST);

        address escrowTwo = vault.computeCycleEscrow(CYCLE_TWO);
        assert(escrowTwo != escrowOne);
        vault.authorizeFundingAfterFailure(
            _funding(vault, hook, CYCLE_TWO, 100, 2), CYCLE_ONE, FAILURE_DIGEST
        );
        usdg.mint(address(hook), 100);
        hook.fund(CYCLE_TWO, OPERATIONS);
        usdg.mint(escrowOne, 77);

        assert(usdg.balanceOf(escrowOne) == 77);
        assert(usdg.balanceOf(escrowTwo) == 100);
        assert(usdg.balanceOf(address(vault)) == 0);
        assert(vault.failureReceiptDigests(CYCLE_ONE) == FAILURE_DIGEST);
        assert(vault.failedCycleSuccessors(CYCLE_ONE) == CYCLE_TWO);
        executor;
    }

    function test_lateFailedReturnCannotAuthorizeSuccessorPayout() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        address escrowOne = vault.computeCycleEscrow(CYCLE_ONE);
        vault.authorizeFunding(_funding(vault, hook, CYCLE_ONE, 250, 1));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));
        vault.recordTerminalFailure(CYCLE_ONE, FAILURE_DIGEST);

        IPegCycleVault.FundingAuthorization memory successor =
            _funding(vault, hook, CYCLE_TWO, 100, 2);
        address escrowTwo = successor.returnDestination;
        vault.authorizeFundingAfterFailure(successor, CYCLE_ONE, FAILURE_DIGEST);
        usdg.mint(address(hook), 100);
        hook.fund(CYCLE_TWO, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_TWO, _route(100));
        usdg.mint(escrowOne, 175);
        usdg.mint(escrowTwo, 99);

        IPegCycleVault.PayoutAuthorization memory payout = _payout(vault, hook, CYCLE_TWO, 100, 3);
        (bool contaminated,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.authorizePayout, (payout, bytes(""), bytes(""))));
        assert(!contaminated);
        assert(usdg.balanceOf(escrowOne) == 175);
        assert(usdg.balanceOf(escrowTwo) == 99);

        usdg.mint(escrowTwo, 1);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), payout);
            vault.authorizePayout(payout, distributionSignature, verifierSignature);
        }

        hook.consumePayout(payout);
        assert(usdg.balanceOf(escrowOne) == 175);
        assert(usdg.balanceOf(escrowTwo) == 0);
        assert(usdg.balanceOf(address(hook)) == 100);
        assert(usdg.balanceOf(address(vault)) == 0);
    }

    function test_failureSuccessorRequiresExactEvidenceAndFreshIdentity() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deployFailed();
        IPegCycleVault.FundingAuthorization memory successor =
            _funding(vault, hook, CYCLE_TWO, 100, 2);

        _rejectOrdinary(vault, successor);
        _rejectRecovery(vault, successor, CYCLE_TWO, FAILURE_DIGEST);
        _rejectRecovery(vault, successor, CYCLE_ONE, keccak256("wrong"));

        IPegCycleVault.FundingAuthorization memory reusedCycle =
            _funding(vault, hook, CYCLE_ONE, 100, 2);
        reusedCycle.cycleId = CYCLE_ONE;
        reusedCycle.returnDestination = vault.computeCycleEscrow(CYCLE_ONE);
        _rejectRecovery(vault, reusedCycle, CYCLE_ONE, FAILURE_DIGEST);

        IPegCycleVault.FundingAuthorization memory reusedNonce =
            _funding(vault, hook, CYCLE_TWO, 100, 1);
        reusedNonce.nonce = 1;
        _rejectRecovery(vault, reusedNonce, CYCLE_ONE, FAILURE_DIGEST);

        IPegCycleVault.FundingAuthorization memory wrongEscrow =
            _funding(vault, hook, CYCLE_TWO, 100, 2);
        wrongEscrow.returnDestination = STRANGER;
        _rejectRecovery(vault, wrongEscrow, CYCLE_ONE, FAILURE_DIGEST);

        vault.authorizeFundingAfterFailure(successor, CYCLE_ONE, FAILURE_DIGEST);
        _rejectRecovery(
            vault, _funding(vault, hook, CYCLE_THREE, 100, 3), CYCLE_ONE, FAILURE_DIGEST
        );
        assert(usdg.balanceOf(address(vault)) == 0);
    }

    function test_failureReceiptCannotBeReusedForAnotherCycle() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deployFailed();
        vault.authorizeFundingAfterFailure(
            _funding(vault, hook, CYCLE_TWO, 100, 2), CYCLE_ONE, FAILURE_DIGEST
        );
        usdg.mint(address(hook), 100);
        hook.fund(CYCLE_TWO, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_TWO, _route(100));

        (bool replayed,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.recordTerminalFailure, (CYCLE_TWO, FAILURE_DIGEST)));

        assert(!replayed);
        assert(vault.failureReceiptDigests(CYCLE_TWO) == bytes32(0));
        assert(vault.lifecycle() == PegCycleVault.Lifecycle.OUTBOUND);
    }

    function test_expiredPendingAuthorizationCanBeCancelledWithoutIdentityReuse() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory auth = _funding(vault, hook, CYCLE_ONE, 250, 1);
        auth.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFunding(auth);
        (bool early,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.cancelExpiredFundingAuthorization, CYCLE_ONE));
        assert(!early);
        VM.warp(block.timestamp + 2);
        vault.cancelExpiredFundingAuthorization(CYCLE_ONE);

        assert(vault.readPendingAuthorization().cycleId == bytes32(0));
        assert(vault.isCycleConsumed(CYCLE_ONE));
        assert(vault.isNonceConsumed(1));
        _rejectOrdinary(vault, auth);
        assert(usdg.balanceOf(address(vault)) == 0);
    }

    function test_cancelledFailedSuccessorLeavesEscrowConsumedButAllowsFreshSuccessor() external {
        (RecoveryUsdg usdg, RecoveryExecutor executor, PegCycleVault vault, RecoveryHook hook) =
            _deployFailed();
        IPegCycleVault.FundingAuthorization memory expired =
            _funding(vault, hook, CYCLE_TWO, 100, 2);
        expired.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFundingAfterFailure(expired, CYCLE_ONE, FAILURE_DIGEST);
        address expiredEscrow = expired.returnDestination;
        VM.warp(block.timestamp + 2);
        vault.cancelExpiredFundingAuthorization(CYCLE_TWO);

        assert(vault.failedCycleSuccessors(CYCLE_ONE) == bytes32(0));
        assert(vault.isCycleConsumed(CYCLE_TWO));
        assert(vault.isNonceConsumed(2));
        assert(vault.cycleEscrows(CYCLE_TWO) == expiredEscrow);
        vault.authorizeFundingAfterFailure(
            _funding(vault, hook, CYCLE_THREE, 100, 3), CYCLE_ONE, FAILURE_DIGEST
        );
        assert(vault.failedCycleSuccessors(CYCLE_ONE) == CYCLE_THREE);
        usdg;
        executor;
    }

    function test_prefundedPredictedEscrowCannotBeAuthorizedOrConsumed() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory auth = _funding(vault, hook, CYCLE_ONE, 250, 1);
        usdg.mint(auth.returnDestination, 1);
        _rejectOrdinary(vault, auth);

        IPegCycleVault.FundingAuthorization memory clean = _funding(vault, hook, CYCLE_TWO, 250, 2);
        vault.authorizeFunding(clean);
        usdg.mint(clean.returnDestination, 1);
        usdg.mint(address(hook), 250);
        (bool consumed,) =
            address(hook).call(abi.encodeCall(RecoveryHook.fund, (CYCLE_TWO, OPERATIONS)));
        assert(!consumed);
        assert(vault.readPendingAuthorization().cycleId == CYCLE_TWO);
    }

    function test_expiredAuthorizationCannotBeCancelledDuringFunding() external {
        (RecoveryUsdg usdg, RecoveryExecutor executor, PegCycleVault vault, RecoveryHook hook) =
            _deploy();
        IPegCycleVault.FundingAuthorization memory auth = _funding(vault, hook, CYCLE_ONE, 250, 1);
        auth.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFunding(auth);
        hook.beginFunding(CYCLE_ONE, OPERATIONS);
        VM.warp(block.timestamp + 2);

        (bool cancelled,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.cancelExpiredFundingAuthorization, CYCLE_ONE));

        assert(!cancelled);
        assert(vault.readPendingAuthorization().cycleId == bytes32(0));
        assert(vault.isCycleConsumed(CYCLE_ONE));
        assert(vault.isNonceConsumed(1));
        usdg;
        executor;
    }

    function test_deadlineRenewalsRequireTheirExactLifecycle() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory funding =
            _funding(vault, hook, CYCLE_ONE, 250, 11);
        _rejectFundingRenewal(vault, funding);

        funding.nonce = 1;
        vault.authorizeFunding(funding);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));

        funding.nonce = 11;
        _rejectFundingRenewal(vault, funding);
        IPegCycleVault.PayoutAuthorization memory payout = _payout(vault, hook, CYCLE_ONE, 175, 2);
        _rejectPayoutRenewal(vault, payout);
    }

    function test_expiredFundedCycleAcceptsExactDeadlineRenewalOnly() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory auth = _funding(vault, hook, CYCLE_ONE, 250, 1);
        auth.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFunding(auth);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.warp(block.timestamp + 2);

        IPegCycleVault.FundingAuthorization memory wrong = vault.readActiveAuthorization();
        wrong.amount += 1;
        wrong.expiresAt = uint64(block.timestamp + 1 days);
        wrong.nonce = 11;
        (bool wrongSubject,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.renewFundingAuthorizationDeadline, wrong));
        assert(!wrongSubject);

        IPegCycleVault.FundingAuthorization memory renewal = vault.readActiveAuthorization();
        renewal.expiresAt = uint64(block.timestamp + 1 days);
        renewal.nonce = 11;
        uint256 escrowBalance = usdg.balanceOf(renewal.returnDestination);
        vault.renewFundingAuthorizationDeadline(renewal);
        assert(vault.readActiveAuthorization().expiresAt == renewal.expiresAt);
        assert(vault.readActiveAuthorization().nonce == 11);
        assert(vault.isNonceConsumed(11));
        assert(usdg.balanceOf(renewal.returnDestination) == escrowBalance);
        assert(usdg.balanceOf(address(vault)) == 0);
    }

    function test_fundingDeadlineRenewalRejectsEverySubjectMutationAndInvalidAuthorityField()
        external
    {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory original =
            _funding(vault, hook, CYCLE_ONE, 250, 1);
        original.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFunding(original);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.warp(block.timestamp + 2);

        IPegCycleVault.FundingAuthorization memory renewal = vault.readActiveAuthorization();
        renewal.expiresAt = uint64(block.timestamp + 1 days);
        renewal.nonce = 11;

        renewal.requirementsRevision = 56;
        _rejectFundingRenewal(vault, renewal);
        renewal.requirementsRevision = 57;
        renewal.chainId += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.chainId = block.chainid;
        renewal.cycleId = CYCLE_TWO;
        _rejectFundingRenewal(vault, renewal);
        renewal.cycleId = CYCLE_ONE;
        renewal.hook = STRANGER;
        _rejectFundingRenewal(vault, renewal);
        renewal.hook = address(hook);
        renewal.vault = STRANGER;
        _rejectFundingRenewal(vault, renewal);
        renewal.vault = address(vault);
        renewal.usdg = STRANGER;
        _rejectFundingRenewal(vault, renewal);
        renewal.usdg = address(usdg);
        renewal.operationsTrigger = STRANGER;
        _rejectFundingRenewal(vault, renewal);
        renewal.operationsTrigger = OPERATIONS;
        renewal.amount += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.amount -= 1;
        renewal.bindingManifestDigest = keccak256("wrong-binding");
        _rejectFundingRenewal(vault, renewal);
        renewal.bindingManifestDigest = BINDING_DIGEST;
        renewal.outboundActionDigest = keccak256("wrong-outbound");
        _rejectFundingRenewal(vault, renewal);
        renewal.outboundActionDigest = original.outboundActionDigest;
        renewal.returnActionDigest = keccak256("wrong-return");
        _rejectFundingRenewal(vault, renewal);
        renewal.returnActionDigest = RETURN_DIGEST;
        renewal.returnDestination = STRANGER;
        _rejectFundingRenewal(vault, renewal);
        renewal.returnDestination = vault.cycleEscrows(CYCLE_ONE);
        renewal.minimumRobinhoodReceive += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.minimumRobinhoodReceive -= 1;
        renewal.minimumSolanaReceive += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.minimumSolanaReceive -= 1;
        renewal.minimumReturnUsdg += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.minimumReturnUsdg -= 1;
        renewal.robinhoodNativeGasCap += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.robinhoodNativeGasCap -= 1;
        renewal.solanaNativeGasCap += 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.solanaNativeGasCap -= 1;

        _rejectFundingRenewalAs(vault, renewal, STRANGER);
        renewal.nonce = 0;
        _rejectFundingRenewal(vault, renewal);
        renewal.nonce = 1;
        _rejectFundingRenewal(vault, renewal);
        renewal.nonce = 11;
        renewal.expiresAt = uint64(block.timestamp);
        _rejectFundingRenewal(vault, renewal);
        renewal.expiresAt = uint64(block.timestamp + 1 days);

        vault.renewFundingAuthorizationDeadline(renewal);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));
        renewal.nonce = 12;
        renewal.expiresAt = uint64(block.timestamp + 2 days);
        _rejectFundingRenewal(vault, renewal);
    }

    function test_expiredReturnedCycleAcceptsExactDeadlineRenewalOnly() external {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        vault.authorizeFunding(_funding(vault, hook, CYCLE_ONE, 250, 1));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory payout = _payout(vault, hook, CYCLE_ONE, 175, 2);
        payout.expiresAt = uint64(block.timestamp + 1);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), payout);
            vault.authorizePayout(payout, distributionSignature, verifierSignature);
        }

        VM.warp(block.timestamp + 2);

        IPegCycleVault.PayoutAuthorization memory wrong = payout;
        wrong.rootHash = keccak256("wrong-root");
        wrong.expiresAt = uint64(block.timestamp + 1 days);
        wrong.nonce = 12;
        (bool wrongSubject,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.renewPayoutAuthorizationDeadline, wrong));
        assert(!wrongSubject);

        IPegCycleVault.PayoutAuthorization memory renewal = _payout(vault, hook, CYCLE_ONE, 175, 12);
        renewal.expiresAt = uint64(block.timestamp + 1 days);
        uint256 escrowBalance = usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE));
        vault.renewPayoutAuthorizationDeadline(renewal);
        assert(vault.payoutAuthorizationDigest() == keccak256(abi.encode(renewal)));
        assert(vault.isNonceConsumed(12));
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == escrowBalance);
        hook.consumePayout(renewal);
    }

    function test_payoutDeadlineRenewalRejectsEverySubjectMutationAndInvalidAuthorityField()
        external
    {
        (RecoveryUsdg usdg,, PegCycleVault vault, RecoveryHook hook) = _deploy();
        vault.authorizeFunding(_funding(vault, hook, CYCLE_ONE, 250, 1));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory original = _payout(vault, hook, CYCLE_ONE, 175, 2);
        original.expiresAt = uint64(block.timestamp + 1);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(vault)), original
            );
            vault.authorizePayout(original, distributionSignature, verifierSignature);
        }

        VM.warp(block.timestamp + 2);

        IPegCycleVault.PayoutAuthorization memory renewal = _payout(vault, hook, CYCLE_ONE, 175, 12);
        renewal.expiresAt = uint64(block.timestamp + 1 days);

        renewal.requirementsRevision = 56;
        _rejectPayoutRenewal(vault, renewal);
        renewal.requirementsRevision = 57;
        renewal.chainId += 1;
        _rejectPayoutRenewal(vault, renewal);
        renewal.chainId = block.chainid;
        renewal.cycleId = CYCLE_TWO;
        _rejectPayoutRenewal(vault, renewal);
        renewal.cycleId = CYCLE_ONE;
        renewal.hook = STRANGER;
        _rejectPayoutRenewal(vault, renewal);
        renewal.hook = address(hook);
        renewal.vault = STRANGER;
        _rejectPayoutRenewal(vault, renewal);
        renewal.vault = address(vault);
        renewal.usdg = STRANGER;
        _rejectPayoutRenewal(vault, renewal);
        renewal.usdg = address(usdg);
        renewal.operationsTrigger = STRANGER;
        _rejectPayoutRenewal(vault, renewal);
        renewal.operationsTrigger = OPERATIONS;
        renewal.bindingManifestDigest = keccak256("wrong-binding");
        _rejectPayoutRenewal(vault, renewal);
        renewal.bindingManifestDigest = BINDING_DIGEST;
        renewal.payoutId = keccak256("wrong-payout");
        _rejectPayoutRenewal(vault, renewal);
        renewal.payoutId = PAYOUT_ID;
        renewal.manifestDigest = keccak256("wrong-manifest");
        _rejectPayoutRenewal(vault, renewal);
        renewal.manifestDigest = MANIFEST_DIGEST;
        renewal.rootHash = keccak256("wrong-root");
        _rejectPayoutRenewal(vault, renewal);
        renewal.rootHash = ROOT_HASH;
        renewal.rootSum += 1;
        _rejectPayoutRenewal(vault, renewal);
        renewal.rootSum -= 1;
        renewal.returnActionDigest = keccak256("wrong-return");
        _rejectPayoutRenewal(vault, renewal);
        renewal.returnActionDigest = RETURN_DIGEST;
        renewal.returnReceiptDigest = keccak256("wrong-receipt");
        _rejectPayoutRenewal(vault, renewal);
        renewal.returnReceiptDigest = RECEIPT_DIGEST;

        _rejectPayoutRenewalAs(vault, renewal, STRANGER);
        renewal.nonce = 0;
        _rejectPayoutRenewal(vault, renewal);
        renewal.nonce = 2;
        _rejectPayoutRenewal(vault, renewal);
        renewal.nonce = 12;
        renewal.expiresAt = uint64(block.timestamp);
        _rejectPayoutRenewal(vault, renewal);
        renewal.expiresAt = uint64(block.timestamp + 1 days);

        vault.renewPayoutAuthorizationDeadline(renewal);
        hook.consumePayout(renewal);
        renewal.nonce = 13;
        renewal.expiresAt = uint64(block.timestamp + 2 days);
        _rejectPayoutRenewal(vault, renewal);
    }

    function test_escrowHasNoArbitraryValueMovementSurface() external {
        (RecoveryUsdg usdg, RecoveryExecutor executor, PegCycleVault vault, RecoveryHook hook) =
            _deploy();
        IPegCycleVault.FundingAuthorization memory auth = _funding(vault, hook, CYCLE_ONE, 250, 1);
        vault.authorizeFunding(auth);
        PegCycleReturnEscrow escrow = PegCycleReturnEscrow(auth.returnDestination);
        assert(escrow.coordinator() == address(vault));
        assert(escrow.usdg() == address(usdg));
        assert(escrow.hook() == address(hook));
        assert(escrow.routeExecutor() == address(executor));
        assert(escrow.cycleId() == CYCLE_ONE);

        VM.prank(STRANGER);
        (bool outbound,) =
            address(escrow).call(abi.encodeCall(PegCycleReturnEscrow.sendOutbound, 1));
        assert(!outbound);
        VM.prank(STRANGER);
        (bool payout,) = address(escrow).call(abi.encodeCall(PegCycleReturnEscrow.sendPayout, 1));
        assert(!payout);

        bytes4[6] memory forbidden = [
            bytes4(keccak256("execute(address,bytes)")),
            bytes4(keccak256("call(address,bytes)")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("transfer(address,uint256)")),
            bytes4(keccak256("rescue(address,uint256)")),
            bytes4(keccak256("sweep(address)"))
        ];
        for (uint256 index; index < forbidden.length; ++index) {
            (bool success,) = address(escrow).call(abi.encodePacked(forbidden[index]));
            assert(!success);
        }
    }

    function _deployFailed()
        private
        returns (
            RecoveryUsdg usdg,
            RecoveryExecutor executor,
            PegCycleVault vault,
            RecoveryHook hook
        )
    {
        (usdg, executor, vault, hook) = _deploy();
        vault.authorizeFunding(_funding(vault, hook, CYCLE_ONE, 250, 1));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route(250));
        vault.recordTerminalFailure(CYCLE_ONE, FAILURE_DIGEST);
    }

    function _deploy()
        private
        returns (
            RecoveryUsdg usdg,
            RecoveryExecutor executor,
            PegCycleVault vault,
            RecoveryHook hook
        )
    {
        usdg = new RecoveryUsdg();
        executor = new RecoveryExecutor(usdg);
        vault = new PegCycleVault(
            address(usdg),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        hook = new RecoveryHook(vault, usdg);
        vault.bindHook(address(hook));
    }

    function _funding(
        PegCycleVault vault,
        RecoveryHook hook,
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
            outboundActionDigest: keccak256(_route(amount)),
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
        RecoveryHook hook,
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
            payoutId: PAYOUT_ID,
            manifestDigest: MANIFEST_DIGEST,
            rootHash: ROOT_HASH,
            rootSum: amount,
            returnActionDigest: RETURN_DIGEST,
            returnReceiptDigest: RECEIPT_DIGEST,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: nonce
        });
    }

    function _route(uint256 amount) private pure returns (bytes memory) {
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

    function _rejectRecovery(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory authorization,
        bytes32 failedCycleId,
        bytes32 failureDigest
    ) private {
        (bool success,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.authorizeFundingAfterFailure,
                    (authorization, failedCycleId, failureDigest)
                )
            );
        assert(!success);
    }

    function _rejectFundingRenewal(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory renewal
    ) private {
        bytes32 beforeDigest = keccak256(
            abi.encode(
                vault.lifecycle(),
                vault.readActiveAuthorization(),
                vault.isNonceConsumed(renewal.nonce)
            )
        );
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.renewFundingAuthorizationDeadline, renewal));
        assert(!success);
        assert(
            keccak256(
                abi.encode(
                    vault.lifecycle(),
                    vault.readActiveAuthorization(),
                    vault.isNonceConsumed(renewal.nonce)
                )
            ) == beforeDigest
        );
    }

    function _rejectPayoutRenewal(
        PegCycleVault vault,
        IPegCycleVault.PayoutAuthorization memory renewal
    ) private {
        bytes32 beforeDigest = keccak256(
            abi.encode(
                vault.lifecycle(),
                vault.payoutAuthorizationDigest(),
                vault.isNonceConsumed(renewal.nonce)
            )
        );
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.renewPayoutAuthorizationDeadline, renewal));
        assert(!success);
        assert(
            keccak256(
                abi.encode(
                    vault.lifecycle(),
                    vault.payoutAuthorizationDigest(),
                    vault.isNonceConsumed(renewal.nonce)
                )
            ) == beforeDigest
        );
    }

    function _rejectFundingRenewalAs(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory renewal,
        address caller
    ) private {
        bytes32 beforeDigest = keccak256(
            abi.encode(
                vault.lifecycle(),
                vault.readActiveAuthorization(),
                vault.isNonceConsumed(renewal.nonce)
            )
        );
        VM.prank(caller);
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.renewFundingAuthorizationDeadline, renewal));
        assert(!success);
        assert(
            keccak256(
                abi.encode(
                    vault.lifecycle(),
                    vault.readActiveAuthorization(),
                    vault.isNonceConsumed(renewal.nonce)
                )
            ) == beforeDigest
        );
    }

    function _rejectPayoutRenewalAs(
        PegCycleVault vault,
        IPegCycleVault.PayoutAuthorization memory renewal,
        address caller
    ) private {
        bytes32 beforeDigest = keccak256(
            abi.encode(
                vault.lifecycle(),
                vault.payoutAuthorizationDigest(),
                vault.isNonceConsumed(renewal.nonce)
            )
        );
        VM.prank(caller);
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.renewPayoutAuthorizationDeadline, renewal));
        assert(!success);
        assert(
            keccak256(
                abi.encode(
                    vault.lifecycle(),
                    vault.payoutAuthorizationDigest(),
                    vault.isNonceConsumed(renewal.nonce)
                )
            ) == beforeDigest
        );
    }
}

contract RecoveryHook {
    PegCycleVault public immutable pegCycleVault;
    RecoveryUsdg private immutable usdg;

    constructor(PegCycleVault vault, RecoveryUsdg token) {
        pegCycleVault = vault;
        usdg = token;
    }

    function fund(bytes32 cycleId, address operationsTrigger) external {
        (IPegCycleVault.FundingAuthorization memory authorization, uint256 balanceBefore) =
            pegCycleVault.consumeFundingAuthorization(cycleId, operationsTrigger);
        require(usdg.transfer(authorization.returnDestination, authorization.amount));
        pegCycleVault.confirmFunding(cycleId, balanceBefore);
    }

    function beginFunding(bytes32 cycleId, address operationsTrigger) external {
        pegCycleVault.consumeFundingAuthorization(cycleId, operationsTrigger);
    }

    function consumePayout(IPegCycleVault.PayoutAuthorization calldata authorization) external {
        pegCycleVault.consumePayoutAuthorization(authorization);
    }
}

contract RecoveryExecutor is IPegCycleRouteExecutor {
    RecoveryUsdg private immutable usdg;

    constructor(RecoveryUsdg token) {
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

contract RecoveryUsdg {
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
