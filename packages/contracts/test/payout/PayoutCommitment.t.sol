// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { CanonicalMerkleSum } from "../../src/payout/CanonicalMerkleSum.sol";
import { PayoutCommitment } from "../../src/payout/PayoutCommitment.sol";
import { HolderSettlement } from "../../src/settlement/HolderSettlement.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { VaultRouteExecutor, VaultUsdg } from "../process/PegCycleVault.t.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

contract PayoutCommitmentTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant PROGRAMMABLE = address(0x5000);
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS_ONE = address(0x7000);
    address private constant OPERATIONS_TWO = address(0x7001);
    address private constant STRANGER = address(0xBAD1);
    address private constant TARGET = address(0xCAFE);
    bytes4 private constant ROUTE_SELECTOR = bytes4(keccak256("boundRoute(bytes)"));
    bytes32 private constant CYCLE = keccak256("funding-cycle");
    bytes32 private constant PAYOUT = keccak256("payout-one");
    bytes32 private constant MANIFEST = keccak256("canonical-manifest");
    bytes32 private constant ROOT = keccak256("merkle-sum-root");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");
    bytes32 private constant RETURN_RECEIPT_DIGEST = keccak256("return-receipt");

    function test_fundsExactReturnedPayoutAndRecordsConservationWithoutOperationsMoney() external {
        (
            VaultUsdg token,
            PegCycleVault vault,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(100);
        uint256 hookBefore = token.balanceOf(address(subject));
        uint256 operationsBefore = token.balanceOf(OPERATIONS_ONE);

        VM.recordLogs();
        VM.prank(STRANGER);
        PayoutCommitment.PayoutRecord memory record = subject.fundPayoutFromPegCycle(auth);

        assert(record.cycleId == CYCLE);
        assert(record.operationsTrigger == OPERATIONS_ONE);
        assert(record.payoutId == PAYOUT);
        assert(record.manifestDigest == MANIFEST);
        assert(record.rootHash == ROOT);
        assert(record.rootSum == 100);
        assert(record.paidTotal == 0);
        assert(record.unpaidTotal == 100);
        assert(token.balanceOf(OPERATIONS_ONE) == operationsBefore);
        assert(token.balanceOf(address(subject)) - hookBefore == 100);
        assert(token.balanceOf(vault.cycleEscrows(CYCLE)) == 0);
        assert(token.balanceOf(address(vault)) == 0);
        _assertPayout(subject, PAYOUT, 100, 0, 100);
        _assertFundingEvent(VM.getRecordedLogs(), subject);
        assert(subject.isSolvent());
    }

    function testFuzz_fundsEveryExactPositiveReturnedRootSum(uint256 rawAmount) external {
        uint256 amount = rawAmount % 250 + 1;
        (
            VaultUsdg token,
            PegCycleVault vault,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(amount);

        subject.fundPayoutFromPegCycle(auth);

        assert(token.balanceOf(OPERATIONS_ONE) == 0);
        assert(token.balanceOf(vault.cycleEscrows(CYCLE)) == 0);
        assert(token.balanceOf(address(vault)) == 0);
        _assertPayout(subject, PAYOUT, amount, 0, amount);
        assert(subject.isSolvent());
    }

    function test_historicalOperationsTriggerRemainsMetadataAfterHandover() external {
        (
            VaultUsdg token,,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(100);
        VM.prank(OPERATIONS_ONE);
        subject.proposeOperations(OPERATIONS_TWO);
        VM.prank(OPERATIONS_TWO);
        subject.acceptOperations();

        VM.prank(OPERATIONS_TWO);
        PayoutCommitment.PayoutRecord memory record = subject.fundPayoutFromPegCycle(auth);

        assert(record.operationsTrigger == OPERATIONS_ONE);
        assert(token.balanceOf(OPERATIONS_ONE) == 0);
        assert(token.balanceOf(OPERATIONS_TWO) == 0);
        _assertPayout(subject, PAYOUT, 100, 0, 100);
    }

    function test_rejectsAlteredAuthorizationAndReplayWithoutMutation() external {
        (
            VaultUsdg token,,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(100);
        IPegCycleVault.PayoutAuthorization memory altered = auth;
        altered.rootHash = keccak256("changed-root");
        _assertRejectedUnchanged(token, subject, altered);
        auth.rootHash = ROOT;

        subject.fundPayoutFromPegCycle(auth);
        bytes32 beforeDigest = _stateDigest(token, subject, PAYOUT);
        (bool replay,) =
            address(subject).call(abi.encodeCall(PayoutCommitment.fundPayoutFromPegCycle, auth));
        assert(!replay);
        assert(_stateDigest(token, subject, PAYOUT) == beforeDigest);
    }

    function test_operationsAndExternalWalletFundingPathsAreAbsent() external {
        (
            VaultUsdg token,,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(100);
        token.mint(OPERATIONS_ONE, 100);
        token.mint(STRANGER, 100);
        uint256 liabilityBefore = subject.totalLiability();

        VM.prank(OPERATIONS_ONE);
        (bool operationsFunded,) = address(subject)
            .call(
                abi.encodeWithSignature(
                    "fundPayout(bytes32,bytes32,bytes32,bytes32,uint256)",
                    CYCLE,
                    PAYOUT,
                    MANIFEST,
                    ROOT,
                    100
                )
            );
        assert(!operationsFunded);
        VM.prank(STRANGER);
        token.transfer(address(subject), 10);
        assert(subject.totalLiability() == liabilityBefore);
        assert(subject.totalPayoutLiability() == 0);
        assert(subject.readPayout(PAYOUT).payoutId == bytes32(0));
        assert(token.balanceOf(OPERATIONS_ONE) == 100);
        assert(token.balanceOf(STRANGER) == 90);
        assert(token.balanceOf(address(subject)) == 60);

        subject.fundPayoutFromPegCycle(auth);
        assert(subject.totalPayoutLiability() == 100);
    }

    function test_proxyUpgradeAndSuccessorControlAreAbsentOnVaultAndComposedHook() external {
        (, PegCycleVault vault, PayoutCommitmentHarness subject,) = _deployReturned(100);
        bytes4[8] memory forbidden = [
            bytes4(keccak256("implementation()")),
            bytes4(keccak256("proxiableUUID()")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("upgradeToAndCall(address,bytes)")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("proposeSuccessor(address)")),
            bytes4(keccak256("acceptSuccessor()")),
            bytes4(keccak256("setSuccessor(address)"))
        ];
        for (uint256 index; index < forbidden.length; ++index) {
            (bool vaultSuccess,) = address(vault).call(abi.encodePacked(forbidden[index]));
            (bool hookSuccess,) = address(subject).call(abi.encodePacked(forbidden[index]));
            assert(!vaultSuccess);
            assert(!hookSuccess);
        }
    }

    function test_adversarialVaultTransfersRollbackBalancesRecordAndLiability() external {
        VaultUsdg.Behavior[8] memory behaviors = _adversarialBehaviors();
        for (uint256 index; index < behaviors.length; ++index) {
            (
                VaultUsdg token,,
                PayoutCommitmentHarness subject,
                IPegCycleVault.PayoutAuthorization memory auth
            ) = _deployReturned(100);
            if (behaviors[index] == VaultUsdg.Behavior.Reenter) {
                token.configureReentry(
                    address(subject), abi.encodeCall(PayoutCommitment.fundPayoutFromPegCycle, auth)
                );
            } else {
                token.setBehavior(behaviors[index]);
            }
            _assertRejectedUnchanged(token, subject, auth);
            assert(token.balanceOf(OPERATIONS_ONE) == 0);
        }
    }

    function test_internalSettlementAccountingPreservesIdentityAndConservation() external {
        (
            VaultUsdg token,,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(100);
        subject.fundPayoutFromPegCycle(auth);
        PayoutCommitment.PayoutRecord memory beforeRecord = subject.readPayout(PAYOUT);

        subject.mockConsumeEntitlement(PAYOUT, 40);

        PayoutCommitment.PayoutRecord memory afterRecord = subject.readPayout(PAYOUT);
        assert(afterRecord.cycleId == beforeRecord.cycleId);
        assert(afterRecord.operationsTrigger == beforeRecord.operationsTrigger);
        assert(afterRecord.payoutId == beforeRecord.payoutId);
        assert(afterRecord.manifestDigest == beforeRecord.manifestDigest);
        assert(afterRecord.rootHash == beforeRecord.rootHash);
        assert(afterRecord.rootSum == beforeRecord.rootSum);
        _assertPayout(subject, PAYOUT, 100, 40, 60);
        assert(subject.totalPayoutLiability() == 60);
        assert(subject.isSolvent());
        token;
    }

    /// @dev Regression for the `payoutId != bytes32(0)` sentinel bug: a zero payoutId can never
    ///      reach a funded state at all (the vault and `_creditPayoutLiability` both independently
    ///      reject it), so it can never silently collide with -- or be mistaken for -- an unfunded
    ///      slot. The explicit `funded` boolean this package introduces removes the sentinel
    ///      overload entirely rather than relying on that separate, coincidental guard.
    function test_zeroPayoutIdCanNeverReachFundedStateGuardingTheSentinelCollision() external {
        (
            ,
            PegCycleVault vault,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        ) = _deployReturned(100);
        auth.payoutId = bytes32(0);

        (bool firstAttempt,) =
            address(subject).call(abi.encodeCall(PayoutCommitment.fundPayoutFromPegCycle, auth));
        assert(!firstAttempt);
        assert(!subject.readPayout(bytes32(0)).funded);

        (bool secondAttempt,) =
            address(subject).call(abi.encodeCall(PayoutCommitment.fundPayoutFromPegCycle, auth));
        assert(!secondAttempt);
        assert(!subject.readPayout(bytes32(0)).funded);
        vault;
    }

    /// @dev A genuine (nonzero-payoutId) repeated authorization must revert with the specific
    ///      `PayoutAlreadyFunded` selector on the second call, not merely "some" revert, and must
    ///      not silently overwrite the first record.
    function test_repeatedNonzeroPayoutIdAuthorizationRevertsPayoutAlreadyFundedExactly() external {
        (,, PayoutCommitmentHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployReturned(100);
        subject.fundPayoutFromPegCycle(auth);

        (bool replaySucceeded, bytes memory returnData) =
            address(subject).call(abi.encodeCall(PayoutCommitment.fundPayoutFromPegCycle, auth));
        assert(!replaySucceeded);
        assert(returnData.length == 4);
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(returnData, 0x20))
        }
        assert(selector == PayoutCommitment.PayoutAlreadyFunded.selector);
        assert(subject.readPayout(PAYOUT).funded);
        _assertPayout(subject, PAYOUT, 100, 0, 100);
    }

    function test_singleChunkModeMirrorsFundingAndClosesManifestImmediately() external {
        (,, PayoutCommitmentHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployReturned(100);
        subject.fundPayoutFromPegCycle(auth);
        assert(!subject.isManifestClosed(PAYOUT));

        subject.commitPayoutChunk(PAYOUT, 0, ROOT, 100);

        assert(subject.isManifestClosed(PAYOUT));
        PayoutCommitment.PayoutChunk memory chunk = subject.readPayoutChunk(PAYOUT, 0);
        assert(chunk.committed);
        assert(chunk.rootHash == ROOT);
        assert(chunk.rootSum == 100);
    }

    function test_partialChunkSetDoesNotCloseManifestAndIsRecoverable() external {
        (,, PayoutCommitmentHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployReturned(100);
        subject.fundPayoutFromPegCycle(auth);

        subject.commitPayoutChunk(PAYOUT, 0, keccak256("chunk-0"), 40);
        assert(!subject.isManifestClosed(PAYOUT));

        // A wrong sum (would exceed the funded liability) is rejected rather than accepted and
        // stuck: the manifest can always be corrected before it closes.
        (bool overshoot,) = address(subject)
            .call(
                abi.encodeCall(
                    PayoutCommitment.commitPayoutChunk, (PAYOUT, 1, keccak256("chunk-1-bad"), 70)
                )
            );
        assert(!overshoot);
        assert(!subject.isManifestClosed(PAYOUT));

        // The abandoned/partial state is never permanently stuck: recommitting the same index
        // before close corrects the running sum, and finishing the set closes it exactly.
        subject.commitPayoutChunk(PAYOUT, 0, keccak256("chunk-0-corrected"), 30);
        subject.commitPayoutChunk(PAYOUT, 1, keccak256("chunk-1"), 70);
        assert(subject.isManifestClosed(PAYOUT));
        assert(subject.readPayoutChunk(PAYOUT, 0).rootSum == 30);
        assert(subject.readPayoutChunk(PAYOUT, 1).rootSum == 70);
    }

    function test_chunkCommitmentIsImmutableOnceManifestCloses() external {
        (,, PayoutCommitmentHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployReturned(100);
        subject.fundPayoutFromPegCycle(auth);
        subject.commitPayoutChunk(PAYOUT, 0, ROOT, 100);
        assert(subject.isManifestClosed(PAYOUT));

        (bool recommit,) = address(subject)
            .call(
                abi.encodeCall(
                    PayoutCommitment.commitPayoutChunk, (PAYOUT, 0, keccak256("evil"), 100)
                )
            );
        assert(!recommit);
        assert(subject.readPayoutChunk(PAYOUT, 0).rootHash == ROOT);
    }

    function test_chunkIndexAtOrAboveMaxChunksPerPayoutIsRejected() external {
        (,, PayoutCommitmentHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployReturned(100);
        subject.fundPayoutFromPegCycle(auth);
        uint16 outOfRange = subject.maxChunksPerPayout();

        (bool success,) = address(subject)
            .call(
                abi.encodeCall(PayoutCommitment.commitPayoutChunk, (PAYOUT, outOfRange, ROOT, 100))
            );
        assert(!success);
    }

    function test_commitPayoutChunkRejectsUnfundedPayoutAndUnauthorizedCaller() external {
        (,, PayoutCommitmentHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployReturned(100);

        (bool unfunded,) = address(subject)
            .call(abi.encodeCall(PayoutCommitment.commitPayoutChunk, (PAYOUT, 0, ROOT, 100)));
        assert(!unfunded);

        subject.fundPayoutFromPegCycle(auth);
        VM.prank(STRANGER);
        (bool unauthorized,) = address(subject)
            .call(abi.encodeCall(PayoutCommitment.commitPayoutChunk, (PAYOUT, 0, ROOT, 100)));
        assert(!unauthorized);
        assert(!subject.isManifestClosed(PAYOUT));

        // The payout's own recorded `operationsTrigger` -- the low-privilege automation key -- is
        // explicitly NOT sufficient to commit a chunk root: only the vault's own `authorizer`
        // (the same identity whose off-chain TB-16 process already determined `payout.rootHash`)
        // may do so. Regression for the arbitrary-root privilege-escalation finding.
        assert(subject.readPayout(PAYOUT).operationsTrigger == OPERATIONS_ONE);
        VM.prank(OPERATIONS_ONE);
        (bool operationsTriggerRejected,) = address(subject)
            .call(abi.encodeCall(PayoutCommitment.commitPayoutChunk, (PAYOUT, 0, ROOT, 100)));
        assert(!operationsTriggerRejected);
        assert(!subject.isManifestClosed(PAYOUT));

        // The vault's own authorizer (the test contract itself, per `_deployReturned`) succeeds.
        subject.commitPayoutChunk(PAYOUT, 0, ROOT, 100);
        assert(subject.isManifestClosed(PAYOUT));
    }

    /// @dev Gas-metered per `security-and-evidence.md`'s hard-maximum requirement: measures (not
    ///      merely asserts success of) a full, maximally-deep 1024-leaf chunk's commit-then-claim
    ///      cost. Run with `--gas-report` for the full per-function breakdown.
    function test_gasFullSingleChunkCommitAndClaim() external {
        (
            VaultUsdg token,
            PayoutChunkSettlementHarness subject,
            CanonicalMerkleSum.Node[] memory tree,
            uint256 totalSum
        ) = _deployFullSingleChunk();
        uint16 index = 1023;
        (bytes32[10] memory hashes, uint256[10] memory sums) = _fullProof(tree, index);
        address recipient = _fullRecipient(index);
        uint256 amount = _fullAmount(index);

        uint256 gasBeforeCommit = gasleft();
        subject.commitPayoutChunk(PAYOUT, 0, tree[1].hash, tree[1].sum);
        uint256 commitGasUsed = gasBeforeCommit - gasleft();

        uint256 gasBeforeClaim = gasleft();
        subject.payEntitlement(PAYOUT, 0, index, recipient, amount, hashes, sums);
        uint256 claimGasUsed = gasBeforeClaim - gasleft();

        assert(subject.isManifestClosed(PAYOUT));
        assert(token.balanceOf(recipient) == amount);
        assert(commitGasUsed > 0 && commitGasUsed < 300_000);
        assert(claimGasUsed > 0 && claimGasUsed < 300_000);
        totalSum;
    }

    /// @dev Gas-metered per `security-and-evidence.md`'s hard-maximum requirement: measures the
    ///      total cost of committing and closing out a full `MAX_CHUNKS_PER_PAYOUT`-chunk cycle --
    ///      the declared maximum, not an unbounded loop. Run with `--gas-report` for the
    ///      per-function breakdown.
    function test_gasFullMaxChunksCycleCloseOut() external {
        uint16 maxChunks = 64;
        uint256 perChunk = 1_000;
        uint256 total = uint256(maxChunks) * perChunk;
        (, PayoutChunkSettlementHarness subject, IPegCycleVault.PayoutAuthorization memory auth) =
            _deployFullChunkedFunding(total);
        assert(maxChunks == subject.maxChunksPerPayout());
        subject.fundPayoutFromPegCycle(auth);

        uint256 gasBeforeCycle = gasleft();
        for (uint16 chunkIndex; chunkIndex < maxChunks; ++chunkIndex) {
            subject.commitPayoutChunk(
                PAYOUT, chunkIndex, keccak256(abi.encode("chunk", chunkIndex)), perChunk
            );
        }
        uint256 totalCloseOutGasUsed = gasBeforeCycle - gasleft();

        assert(subject.isManifestClosed(PAYOUT));
        assert(totalCloseOutGasUsed > 0 && totalCloseOutGasUsed < uint256(maxChunks) * 200_000);
    }

    function _deployReturned(uint256 rootSum)
        private
        returns (
            VaultUsdg token,
            PegCycleVault vault,
            PayoutCommitmentHarness subject,
            IPegCycleVault.PayoutAuthorization memory payoutAuth
        )
    {
        token = new VaultUsdg();
        VaultRouteExecutor executor = new VaultRouteExecutor(token);
        vault = new PegCycleVault(
            address(token),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        subject = new PayoutCommitmentHarness(token, PROGRAMMABLE, TREASURY, OPERATIONS_ONE, vault);
        vault.bindHook(address(subject));
        subject.collectAndAccrue(10_000);
        vault.authorizeFunding(_fundingAuth(token, vault, address(subject)));
        VM.prank(OPERATIONS_ONE);
        subject.openPegCycle(CYCLE);
        VM.prank(OPERATIONS_ONE);
        vault.executeOutbound(CYCLE, _route());
        token.mint(vault.cycleEscrows(CYCLE), rootSum);
        payoutAuth = _payoutAuth(token, vault, address(subject), ROOT, rootSum);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(vault)), payoutAuth
            );
            vault.authorizePayout(payoutAuth, distributionSignature, verifierSignature);
        }

        assert(token.balanceOf(OPERATIONS_ONE) == 0);
        assert(subject.isSolvent());
    }

    /// @dev Deploys a chunk+settlement-capable harness, funds it with a full 1024-leaf tree's
    ///      exact total, and returns the tree so the caller can commit chunk 0 and claim from it.
    function _deployFullSingleChunk()
        private
        returns (
            VaultUsdg token,
            PayoutChunkSettlementHarness subject,
            CanonicalMerkleSum.Node[] memory tree,
            uint256 totalSum
        )
    {
        VaultRouteExecutor executor;
        PegCycleVault vault;
        (token, executor, vault, subject) = _deployChunkSettlementFixture();

        CanonicalMerkleSum.Domain memory domain = CanonicalMerkleSum.Domain({
            chainId: block.chainid,
            hook: address(subject),
            cycleId: CYCLE,
            payoutId: PAYOUT,
            manifestDigest: MANIFEST
        });
        (tree, totalSum) = _fullTree(domain);

        token.mint(vault.cycleEscrows(CYCLE), totalSum);
        IPegCycleVault.PayoutAuthorization memory auth =
            _payoutAuth(token, vault, address(subject), tree[1].hash, tree[1].sum);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        subject.fundPayoutFromPegCycle(auth);
        executor;
    }

    /// @dev Deploys a chunk+settlement-capable harness and funds an escrow-backed payout of
    ///      exactly `rootSum` without constructing real Merkle-sum leaf data -- used to exercise
    ///      the chunk-commitment mechanics and their gas cost independently of proof verification.
    function _deployFullChunkedFunding(uint256 rootSum)
        private
        returns (
            VaultUsdg token,
            PayoutChunkSettlementHarness subject,
            IPegCycleVault.PayoutAuthorization memory auth
        )
    {
        VaultRouteExecutor executor;
        PegCycleVault vault;
        (token, executor, vault, subject) = _deployChunkSettlementFixture();
        token.mint(vault.cycleEscrows(CYCLE), rootSum);
        auth =
            _payoutAuth(token, vault, address(subject), keccak256("multi-chunk-manifest"), rootSum);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        executor;
    }

    function _deployChunkSettlementFixture()
        private
        returns (
            VaultUsdg token,
            VaultRouteExecutor executor,
            PegCycleVault vault,
            PayoutChunkSettlementHarness subject
        )
    {
        token = new VaultUsdg();
        executor = new VaultRouteExecutor(token);
        vault = new PegCycleVault(
            address(token),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        subject =
            new PayoutChunkSettlementHarness(token, PROGRAMMABLE, TREASURY, OPERATIONS_ONE, vault);
        vault.bindHook(address(subject));
        subject.collectAndAccrue(10_000);
        vault.authorizeFunding(_fundingAuth(token, vault, address(subject)));
        VM.prank(OPERATIONS_ONE);
        subject.openPegCycle(CYCLE);
        VM.prank(OPERATIONS_ONE);
        vault.executeOutbound(CYCLE, _route());
    }

    function _fullTree(CanonicalMerkleSum.Domain memory domain)
        private
        pure
        returns (CanonicalMerkleSum.Node[] memory tree, uint256 totalSum)
    {
        tree = new CanonicalMerkleSum.Node[](2048);
        for (uint16 index; index < 1024; ++index) {
            address recipient = _fullRecipient(index);
            uint256 amount = _fullAmount(index);
            tree[1024 + index] = CanonicalMerkleSum.nonemptyLeaf(domain, index, recipient, amount);
            totalSum += amount;
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

    function _fullProof(CanonicalMerkleSum.Node[] memory tree, uint16 index)
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

    function _fullRecipient(uint16 index) private pure returns (address) {
        return address(uint160(0x100000 + uint256(index)));
    }

    function _fullAmount(uint16 index) private pure returns (uint256) {
        return uint256(index) + 1;
    }

    function _fundingAuth(VaultUsdg token, PegCycleVault vault, address subject)
        private
        view
        returns (IPegCycleVault.FundingAuthorization memory)
    {
        return IPegCycleVault.FundingAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: CYCLE,
            hook: subject,
            vault: address(vault),
            usdg: address(token),
            operationsTrigger: OPERATIONS_ONE,
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
        address subject,
        bytes32 rootHash,
        uint256 rootSum
    ) private view returns (IPegCycleVault.PayoutAuthorization memory) {
        return IPegCycleVault.PayoutAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: CYCLE,
            hook: subject,
            vault: address(vault),
            usdg: address(token),
            operationsTrigger: OPERATIONS_ONE,
            bindingManifestDigest: BINDING_DIGEST,
            payoutId: PAYOUT,
            manifestDigest: MANIFEST,
            rootHash: rootHash,
            rootSum: rootSum,
            returnActionDigest: RETURN_DIGEST,
            returnReceiptDigest: RETURN_RECEIPT_DIGEST,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: 2
        });
    }

    function _route() private pure returns (bytes memory) {
        return abi.encode(TARGET, ROUTE_SELECTOR, uint256(250));
    }

    function _assertRejectedUnchanged(
        VaultUsdg token,
        PayoutCommitmentHarness subject,
        IPegCycleVault.PayoutAuthorization memory authorization
    ) private {
        bytes32 beforeDigest = _stateDigest(token, subject, authorization.payoutId);
        (bool success,) = address(subject)
            .call(abi.encodeCall(PayoutCommitment.fundPayoutFromPegCycle, authorization));
        assert(!success);
        assert(_stateDigest(token, subject, authorization.payoutId) == beforeDigest);
        assert(subject.isSolvent());
    }

    function _stateDigest(VaultUsdg token, PayoutCommitmentHarness subject, bytes32 payoutId)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                token.balanceOf(address(subject)),
                token.balanceOf(address(subject.pegCycleVault())),
                token.balanceOf(
                    PegCycleVault(address(subject.pegCycleVault())).computeCycleEscrow(CYCLE)
                ),
                token.balanceOf(OPERATIONS_ONE),
                token.balanceOf(OPERATIONS_TWO),
                subject.readPayout(payoutId),
                subject.totalPayoutLiability(),
                subject.totalLiability()
            )
        );
    }

    function _assertPayout(
        PayoutCommitmentHarness subject,
        bytes32 payoutId,
        uint256 funded,
        uint256 paid,
        uint256 unpaid
    ) private view {
        (uint256 actualFunded, uint256 actualPaid, uint256 actualUnpaid) =
            subject.readPayoutConservation(payoutId);
        assert(actualFunded == funded);
        assert(actualPaid == paid);
        assert(actualUnpaid == unpaid);
        assert(actualFunded == actualPaid + actualUnpaid);
    }

    function _assertFundingEvent(Vm.Log[] memory logs, PayoutCommitmentHarness subject)
        private
        pure
    {
        bytes32 signature =
            keccak256("PayoutFunded(bytes32,bytes32,address,bytes32,bytes32,uint256)");
        bool found;
        for (uint256 index; index < logs.length; ++index) {
            Vm.Log memory entry = logs[index];
            if (entry.emitter == address(subject) && entry.topics.length == 4) {
                if (entry.topics[0] != signature) continue;
                assert(entry.topics[1] == PAYOUT);
                assert(entry.topics[2] == CYCLE);
                assert(address(uint160(uint256(entry.topics[3]))) == OPERATIONS_ONE);
                (bytes32 manifestDigest, bytes32 rootHash, uint256 rootSum) =
                    abi.decode(entry.data, (bytes32, bytes32, uint256));
                assert(manifestDigest == MANIFEST);
                assert(rootHash == ROOT);
                assert(rootSum == 100);
                found = true;
            }
        }
        assert(found);
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

contract PayoutCommitmentHarness is PayoutCommitment {
    VaultUsdg private immutable TOKEN;

    constructor(
        VaultUsdg token,
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault vault
    ) PayoutCommitment(programmable, treasury, operations, vault) {
        TOKEN = token;
    }

    function collectAndAccrue(uint256 quote) external moneyPath {
        (uint256 fee,,,) = _splitLiability(quote);
        uint256 balanceBefore = _hookUsdgBalance();
        TOKEN.mint(address(this), fee);
        _accrueAuthenticatedSwap(quote, balanceBefore);
    }

    function mockConsumeEntitlement(bytes32 payoutId, uint256 amount) external moneyPath {
        _consumePayoutEntitlement(payoutId, amount);
    }

    function totalPayoutLiability() external view returns (uint256) {
        return _totalPayoutLiability();
    }

    function totalLiability() external view returns (uint256) {
        return _totalLiability();
    }

    function isSolvent() external view returns (bool) {
        return _isSolvent();
    }

    function maxChunksPerPayout() external pure returns (uint16) {
        return MAX_CHUNKS_PER_PAYOUT;
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return TOKEN.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return TOKEN.transfer(recipient, amount);
    }
}

contract FundingUsdg is VaultUsdg { }

/// @dev Extends `HolderSettlement` (which in turn extends `PayoutCommitment`) so this test file's
///      gas-metered chunk tests can commit a chunk and claim from it in one deployment, matching
///      `test/payout/*.t.sol`'s gas-report command.
contract PayoutChunkSettlementHarness is HolderSettlement {
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

    function maxChunksPerPayout() external pure returns (uint16) {
        return MAX_CHUNKS_PER_PAYOUT;
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return TOKEN.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return TOKEN.transfer(recipient, amount);
    }
}
