// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { CanonicalMerkleSum } from "../../src/payout/CanonicalMerkleSum.sol";
import { HolderSettlement } from "../../src/settlement/HolderSettlement.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { VaultRouteExecutor, VaultUsdg } from "../process/PegCycleVault.t.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface Vm {
    function prank(address caller) external;
    function roll(uint256 blockNumber) external;
}

contract HolderSettlementTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant PROGRAMMABLE = address(0x5000);
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS = address(0x7000);
    address private constant RECIPIENT_ZERO = address(0x8000);
    address private constant RECIPIENT_LAST = address(0x8001);
    address private constant CALLER_ONE = address(0x9000);
    address private constant CALLER_TWO = address(0x9001);
    bytes32 private constant CYCLE = keccak256("settlement-cycle");
    bytes32 private constant PAYOUT = keccak256("settlement-payout");
    bytes32 private constant MANIFEST = keccak256("settlement-manifest");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");
    bytes32 private constant RETURN_RECEIPT_DIGEST = keccak256("return-receipt");
    address private constant TARGET = address(0xCAFE);
    bytes4 private constant ROUTE_SELECTOR = bytes4(keccak256("boundRoute(bytes)"));
    uint16 private constant LAST_INDEX = 1023;

    function test_anyCallerPaysImmediateAndLongHorizonLeavesToCommittedRecipients() external {
        (VaultUsdg token, HolderSettlementHarness subject, CanonicalMerkleSum.Node[] memory tree) =
            _deployFunded();
        (bytes32[10] memory zeroHashes, uint256[10] memory zeroSums) = _proof(tree, 0);
        (bytes32[10] memory lastHashes, uint256[10] memory lastSums) = _proof(tree, LAST_INDEX);

        VM.prank(CALLER_ONE);
        subject.payEntitlement(PAYOUT, 0, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums);
        VM.roll(block.number + 1_000_000);
        VM.prank(CALLER_TWO);
        subject.payEntitlement(PAYOUT, 0, LAST_INDEX, RECIPIENT_LAST, 20, lastHashes, lastSums);

        assert(token.balanceOf(RECIPIENT_ZERO) == 10);
        assert(token.balanceOf(RECIPIENT_LAST) == 20);
        assert(subject.isPaid(PAYOUT, 0, 0));
        assert(subject.isPaid(PAYOUT, 0, LAST_INDEX));
        _assertConservation(subject, 30, 30, 0);
        assert(subject.isSolvent());
    }

    function test_proofMutationReplayAndWrongLeafCannotBlockDistinctIndex() external {
        (VaultUsdg token, HolderSettlementHarness subject, CanonicalMerkleSum.Node[] memory tree) =
            _deployFunded();
        (bytes32[10] memory zeroHashes, uint256[10] memory zeroSums) = _proof(tree, 0);
        (bytes32[10] memory lastHashes, uint256[10] memory lastSums) = _proof(tree, LAST_INDEX);
        assert(
            subject.verifyEntitlementProof(PAYOUT, 0, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums)
        );

        bytes32 beforeDigest = _stateDigest(token, subject);
        zeroHashes[0] = bytes32(uint256(zeroHashes[0]) ^ 1);
        assert(
            !subject.verifyEntitlementProof(PAYOUT, 0, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums)
        );
        _assertPaymentRejected(subject, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums);
        assert(_stateDigest(token, subject) == beforeDigest);

        (zeroHashes, zeroSums) = _proof(tree, 0);
        _assertPaymentRejected(subject, 0, RECIPIENT_LAST, 10, zeroHashes, zeroSums);
        _assertPaymentRejected(subject, 0, RECIPIENT_ZERO, 11, zeroHashes, zeroSums);

        VM.prank(CALLER_ONE);
        subject.payEntitlement(PAYOUT, 0, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums);
        _assertPaymentRejected(subject, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums);

        VM.prank(CALLER_TWO);
        subject.payEntitlement(PAYOUT, 0, LAST_INDEX, RECIPIENT_LAST, 20, lastHashes, lastSums);
        assert(token.balanceOf(RECIPIENT_ZERO) == 10);
        assert(token.balanceOf(RECIPIENT_LAST) == 20);
        _assertConservation(subject, 30, 30, 0);
    }

    function test_adversarialTransfersRollbackFailedLeafAndLeaveOtherLeafPayable() external {
        VaultUsdg.Behavior[8] memory behaviors = _adversarialBehaviors();
        for (uint256 behaviorIndex; behaviorIndex < behaviors.length; ++behaviorIndex) {
            (
                VaultUsdg token,
                HolderSettlementHarness subject,
                CanonicalMerkleSum.Node[] memory tree
            ) = _deployFunded();
            (bytes32[10] memory zeroHashes, uint256[10] memory zeroSums) = _proof(tree, 0);
            (bytes32[10] memory lastHashes, uint256[10] memory lastSums) = _proof(tree, LAST_INDEX);
            if (behaviors[behaviorIndex] == VaultUsdg.Behavior.Reenter) {
                token.configureReentry(
                    address(subject),
                    abi.encodeCall(
                        HolderSettlement.payEntitlement,
                        (PAYOUT, 0, LAST_INDEX, RECIPIENT_LAST, 20, lastHashes, lastSums)
                    )
                );
            } else {
                token.setBehavior(behaviors[behaviorIndex]);
            }
            bytes32 beforeDigest = _stateDigest(token, subject);

            _assertPaymentRejected(subject, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums);

            assert(_stateDigest(token, subject) == beforeDigest);
            token.setBehavior(VaultUsdg.Behavior.Normal);
            VM.prank(CALLER_TWO);
            subject.payEntitlement(PAYOUT, 0, LAST_INDEX, RECIPIENT_LAST, 20, lastHashes, lastSums);
            VM.prank(CALLER_ONE);
            subject.payEntitlement(PAYOUT, 0, 0, RECIPIENT_ZERO, 10, zeroHashes, zeroSums);
            _assertConservation(subject, 30, 30, 0);
        }
    }

    function test_recipientReplacementBatchDelayAndRecoverySelectorsAreAbsent() external {
        (VaultUsdg token, HolderSettlementHarness subject,) = _deployFunded();
        token;
        bytes4[8] memory forbidden = [
            bytes4(keccak256("replaceRecipient(bytes32,uint16,address)")),
            bytes4(keccak256("remapRecipient(bytes32,uint16,address)")),
            bytes4(keccak256("payBatch(bytes32,bytes)")),
            bytes4(keccak256("setReadyAt(bytes32,uint256)")),
            bytes4(keccak256("setWorker(address)")),
            bytes4(keccak256("setEmergencyMode(bool)")),
            bytes4(keccak256("retryFailed(bytes32,uint16)")),
            bytes4(keccak256("recoverEntitlement(bytes32,uint16,address)"))
        ];
        bytes32 beforeDigest = _stateDigest(token, subject);
        for (uint256 index; index < forbidden.length; ++index) {
            (bool success,) = address(subject).call(abi.encodePacked(forbidden[index]));
            assert(!success);
        }
        assert(_stateDigest(token, subject) == beforeDigest);
    }

    function _deployFunded()
        private
        returns (
            VaultUsdg token,
            HolderSettlementHarness subject,
            CanonicalMerkleSum.Node[] memory tree
        )
    {
        token = new VaultUsdg();
        VaultRouteExecutor executor = new VaultRouteExecutor(token);
        PegCycleVault vault = new PegCycleVault(
            address(token),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        subject = new HolderSettlementHarness(token, PROGRAMMABLE, TREASURY, OPERATIONS, vault);
        vault.bindHook(address(subject));
        subject.collectAndAccrue(10_000);
        vault.authorizeFunding(_fundingAuth(token, vault, subject));
        VM.prank(OPERATIONS);
        subject.openPegCycle(CYCLE);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE, _route());
        CanonicalMerkleSum.Domain memory domain = _domain(subject);
        tree = _tree(domain);
        token.mint(vault.cycleEscrows(CYCLE), tree[1].sum);
        IPegCycleVault.PayoutAuthorization memory payoutAuth =
            _payoutAuth(token, vault, subject, tree[1]);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(vault)), payoutAuth
            );
            vault.authorizePayout(payoutAuth, distributionSignature, verifierSignature);
        }
        subject.fundPayoutFromPegCycle(payoutAuth);
        // The vault's own `authorizer` (the test contract itself, per the vault deployment below)
        // commits the chunk -- `OPERATIONS`, the payout's low-privilege `operationsTrigger`, is no
        // longer authorized to (see PayoutCommitment's chunk-committer authority regression test).
        subject.commitPayoutChunk(PAYOUT, 0, tree[1].hash, tree[1].sum);
        assert(subject.isManifestClosed(PAYOUT));
        _assertConservation(subject, 30, 0, 30);
        assert(token.balanceOf(OPERATIONS) == 0);
    }

    function _fundingAuth(VaultUsdg token, PegCycleVault vault, HolderSettlementHarness subject)
        private
        view
        returns (IPegCycleVault.FundingAuthorization memory)
    {
        return IPegCycleVault.FundingAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: CYCLE,
            hook: address(subject),
            vault: address(vault),
            usdg: address(token),
            operationsTrigger: OPERATIONS,
            amount: 250,
            bindingManifestDigest: BINDING_DIGEST,
            outboundActionDigest: keccak256(_route()),
            returnActionDigest: RETURN_DIGEST,
            returnDestination: vault.computeCycleEscrow(CYCLE),
            minimumRobinhoodReceive: 1,
            minimumSolanaReceive: 1,
            minimumReturnUsdg: 1,
            robinhoodNativeGasCap: 1,
            solanaNativeGasCap: 1,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: 1
        });
    }

    function _payoutAuth(
        VaultUsdg token,
        PegCycleVault vault,
        HolderSettlementHarness subject,
        CanonicalMerkleSum.Node memory root
    ) private view returns (IPegCycleVault.PayoutAuthorization memory) {
        return IPegCycleVault.PayoutAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: CYCLE,
            hook: address(subject),
            vault: address(vault),
            usdg: address(token),
            operationsTrigger: OPERATIONS,
            bindingManifestDigest: BINDING_DIGEST,
            payoutId: PAYOUT,
            manifestDigest: MANIFEST,
            rootHash: root.hash,
            rootSum: root.sum,
            returnActionDigest: RETURN_DIGEST,
            returnReceiptDigest: RETURN_RECEIPT_DIGEST,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: 2
        });
    }

    function _route() private pure returns (bytes memory) {
        return abi.encode(TARGET, ROUTE_SELECTOR, uint256(250));
    }

    function _tree(CanonicalMerkleSum.Domain memory domain)
        private
        pure
        returns (CanonicalMerkleSum.Node[] memory tree)
    {
        tree = new CanonicalMerkleSum.Node[](2048);
        for (uint16 index; index < 1024; ++index) {
            if (index == 0) {
                tree[1024] = CanonicalMerkleSum.nonemptyLeaf(domain, 0, RECIPIENT_ZERO, 10);
            } else if (index == LAST_INDEX) {
                tree[2047] = CanonicalMerkleSum.nonemptyLeaf(domain, LAST_INDEX, RECIPIENT_LAST, 20);
            } else {
                tree[1024 + index] = CanonicalMerkleSum.emptyLeaf(domain, index);
            }
        }
        uint256 width = 1024;
        for (uint8 level; level < 10; ++level) {
            uint256 parentStart = width >> 1;
            for (uint256 offset; offset < parentStart; ++offset) {
                uint256 parentIndex = parentStart + offset;
                tree[parentIndex] = CanonicalMerkleSum.parentNode(
                    level, tree[parentIndex * 2], tree[parentIndex * 2 + 1]
                );
            }
            width = parentStart;
        }
    }

    function _proof(CanonicalMerkleSum.Node[] memory tree, uint16 index)
        private
        pure
        returns (bytes32[10] memory hashes, uint256[10] memory sums)
    {
        uint256 cursor = 1024 + index;
        for (uint8 level; level < 10; ++level) {
            CanonicalMerkleSum.Node memory sibling = tree[cursor ^ 1];
            hashes[level] = sibling.hash;
            sums[level] = sibling.sum;
            cursor >>= 1;
        }
    }

    function _domain(HolderSettlementHarness subject)
        private
        view
        returns (CanonicalMerkleSum.Domain memory)
    {
        return CanonicalMerkleSum.Domain({
            chainId: block.chainid,
            hook: address(subject),
            cycleId: CYCLE,
            payoutId: PAYOUT,
            manifestDigest: MANIFEST
        });
    }

    function _assertPaymentRejected(
        HolderSettlementHarness subject,
        uint16 index,
        address recipient,
        uint256 amount,
        bytes32[10] memory siblingHashes,
        uint256[10] memory siblingSums
    ) private {
        VM.prank(CALLER_ONE);
        (bool success,) = address(subject)
            .call(
                abi.encodeCall(
                    HolderSettlement.payEntitlement,
                    (PAYOUT, 0, index, recipient, amount, siblingHashes, siblingSums)
                )
            );
        assert(!success);
    }

    function _assertConservation(
        HolderSettlementHarness subject,
        uint256 funded,
        uint256 paid,
        uint256 unpaid
    ) private view {
        (uint256 actualFunded, uint256 actualPaid, uint256 actualUnpaid) =
            subject.readPayoutConservation(PAYOUT);
        assert(actualFunded == funded);
        assert(actualPaid == paid);
        assert(actualUnpaid == unpaid);
        assert(actualFunded == actualPaid + actualUnpaid);
    }

    function _stateDigest(VaultUsdg token, HolderSettlementHarness subject)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                token.balanceOf(address(subject)),
                token.balanceOf(RECIPIENT_ZERO),
                token.balanceOf(RECIPIENT_LAST),
                subject.readPayout(PAYOUT),
                subject.isPaid(PAYOUT, 0, 0),
                subject.isPaid(PAYOUT, 0, LAST_INDEX)
            )
        );
    }

    function _adversarialBehaviors() private pure returns (VaultUsdg.Behavior[8] memory behaviors) {
        behaviors[0] = VaultUsdg.Behavior.RevertTransfer;
        behaviors[1] = VaultUsdg.Behavior.ReturnFalse;
        behaviors[2] = VaultUsdg.Behavior.MalformedReturn;
        behaviors[3] = VaultUsdg.Behavior.ShortSource;
        behaviors[4] = VaultUsdg.Behavior.ShortDestination;
        behaviors[5] = VaultUsdg.Behavior.ExcessSource;
        behaviors[6] = VaultUsdg.Behavior.ExcessDestination;
        behaviors[7] = VaultUsdg.Behavior.Reenter;
    }
}

contract HolderSettlementHarness is HolderSettlement {
    VaultUsdg private immutable TOKEN;

    constructor(
        VaultUsdg token,
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault vault
    ) HolderSettlement(programmable, treasury, operations, vault) {
        TOKEN = token;
    }

    function collectAndAccrue(uint256 quote) external moneyPath {
        (uint256 fee,,,) = _splitLiability(quote);
        uint256 balanceBefore = _hookUsdgBalance();
        TOKEN.mint(address(this), fee);
        _accrueAuthenticatedSwap(quote, balanceBefore);
    }

    function isSolvent() external view returns (bool) {
        return _isSolvent();
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return TOKEN.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return _callToken(abi.encodeCall(VaultUsdg.transfer, (recipient, amount)));
    }

    function _callToken(bytes memory callData) private returns (bool) {
        (bool success, bytes memory result) = address(TOKEN).call(callData);
        if (!success || result.length != 32) return false;
        uint256 returned;
        assembly ("memory-safe") {
            returned := mload(add(result, 0x20))
        }
        return returned == 1;
    }
}
