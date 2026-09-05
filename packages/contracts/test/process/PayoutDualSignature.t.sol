// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { PayoutDistributionSignatures } from "../../src/process/PayoutDistributionSignatures.sol";
import { VaultHook, VaultRouteExecutor, VaultUsdg } from "./PegCycleVault.t.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface DualSignatureVm {
    function prank(address caller) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice Covers RT-R58-01 closure at the contract layer (WP-38): `PegCycleVault.authorizePayout`
/// requires two independent EIP-712 signatures, from the pinned `distributionSigner` and
/// `distributionVerifier`, over the authorization's `PayoutDistribution` subject. Every negative
/// path named in the work package is exercised here explicitly, by its own named error, separate
/// from the pre-existing field-mutation coverage in `PegCycleVault.t.sol`.
contract PayoutDualSignatureTest {
    DualSignatureVm private constant VM =
        DualSignatureVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant CYCLE_ONE = keccak256("dual-sig-cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("dual-sig-cycle-two");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");
    bytes32 private constant RETURN_RECEIPT_DIGEST = keccak256("return-receipt");
    bytes32 private constant RETURN_RECEIPT_DIGEST_TWO = keccak256("return-receipt-two");
    bytes32 private constant PAYOUT_ONE = keccak256("dual-sig-payout-one");
    bytes32 private constant MANIFEST_DIGEST = keccak256("distribution-manifest");
    bytes32 private constant ROOT_HASH = keccak256("distribution-root");
    address private constant OPERATIONS = address(0x7000);
    address private constant TARGET = address(0xCAFE);
    bytes4 private constant ROUTE_SELECTOR = bytes4(keccak256("boundRoute(bytes)"));

    /// @dev An arbitrary private key distinct from `PayoutSigning`'s two fixed keys, used to
    /// produce well-formed but wrong-signer signatures.
    uint256 private constant STRANGER_KEY =
        0x9a5f2c7d4b1e8306f9c2a4e7d1b5983047c62e9a1d4f7b0836ce529a48d1f7cc;

    // ---------------------------------------------------------------------
    // Construction-time identity conflicts
    // ---------------------------------------------------------------------

    function test_constructorRejectsDistributionSignerOrVerifierEqualToAuthorizer() external {
        VaultUsdg usdg = new VaultUsdg();
        VaultRouteExecutor executor = new VaultRouteExecutor(usdg);
        address verifier = PayoutSigning.distributionVerifierAddress();

        (bool ok1,) = _tryDeploy(usdg, executor, address(this), address(this), verifier);
        assert(!ok1);

        (bool ok2,) = _tryDeploy(
            usdg, executor, address(this), PayoutSigning.distributionSignerAddress(), address(this)
        );
        assert(!ok2);
    }

    function test_constructorRejectsDistributionSignerEqualToVerifier() external {
        VaultUsdg usdg = new VaultUsdg();
        VaultRouteExecutor executor = new VaultRouteExecutor(usdg);
        address signer = PayoutSigning.distributionSignerAddress();
        (bool ok,) = _tryDeploy(usdg, executor, address(this), signer, signer);
        assert(!ok);
    }

    function test_constructorRejectsZeroDistributionSignerOrVerifier() external {
        VaultUsdg usdg = new VaultUsdg();
        VaultRouteExecutor executor = new VaultRouteExecutor(usdg);
        (bool ok1,) = _tryDeploy(
            usdg, executor, address(this), address(0), PayoutSigning.distributionVerifierAddress()
        );
        assert(!ok1);
        (bool ok2,) = _tryDeploy(
            usdg, executor, address(this), PayoutSigning.distributionSignerAddress(), address(0)
        );
        assert(!ok2);
    }

    function test_fundingRejectsOperationsTriggerEqualToDistributionSignerOrVerifier() external {
        (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook) =
            _deploy();
        IPegCycleVault.FundingAuthorization memory auth =
            _funding(usdg, vault, hook, PayoutSigning.distributionSignerAddress());
        (bool signerAsTrigger,) =
            address(vault).call(abi.encodeCall(PegCycleVault.authorizeFunding, auth));
        assert(!signerAsTrigger);

        auth.operationsTrigger = PayoutSigning.distributionVerifierAddress();
        (bool verifierAsTrigger,) =
            address(vault).call(abi.encodeCall(PegCycleVault.authorizeFunding, auth));
        assert(!verifierAsTrigger);
        executor;
    }

    // ---------------------------------------------------------------------
    // authorizePayout signature validation
    // ---------------------------------------------------------------------

    function test_happyPathAcceptsTwoDistinctValidSignatures() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);

        (bytes memory distributionSignature, bytes memory verifierSignature) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
        vault.authorizePayout(auth, distributionSignature, verifierSignature);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.RETURNED));
        assert(vault.payoutAuthorizationDigest() == keccak256(abi.encode(auth)));
    }

    function test_missingSignatureReverts() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        (, bytes memory verifierSignature) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);

        assert(
            _authorizePayoutSelector(vault, auth, bytes(""), verifierSignature)
                == PayoutDistributionSignatures.MissingSignature.selector
        );
        assert(
            _authorizePayoutSelector(vault, auth, verifierSignature, bytes(""))
                == PayoutDistributionSignatures.MissingSignature.selector
        );
        assert(
            _authorizePayoutSelector(vault, auth, bytes(""), bytes(""))
                == PayoutDistributionSignatures.MissingSignature.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_duplicateSignatureReverts() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        (bytes memory distributionSignature,) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);

        assert(
            _authorizePayoutSelector(vault, auth, distributionSignature, distributionSignature)
                == PayoutDistributionSignatures.DuplicateSignature.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_wrongDistributionSignerReverts() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        bytes32 digest = _digest(vault, auth);
        bytes memory wrongSignature = PayoutSigning.sign(STRANGER_KEY, digest);
        bytes memory verifierSignature =
            PayoutSigning.sign(PayoutSigning.DISTRIBUTION_VERIFIER_KEY, digest);

        assert(
            _authorizePayoutSelector(vault, auth, wrongSignature, verifierSignature)
                == PayoutDistributionSignatures.InvalidDistributionSigner.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_wrongDistributionVerifierReverts() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        bytes32 digest = _digest(vault, auth);
        bytes memory distributionSignature =
            PayoutSigning.sign(PayoutSigning.DISTRIBUTION_SIGNER_KEY, digest);
        bytes memory wrongVerifierSignature = PayoutSigning.sign(STRANGER_KEY, digest);

        assert(
            _authorizePayoutSelector(vault, auth, distributionSignature, wrongVerifierSignature)
                == PayoutDistributionSignatures.InvalidDistributionVerifier.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_swappedSignatureRolesRevert() external {
        // The distribution-signer's signature presented as the verifier's, and vice versa: both
        // signatures are individually well-formed and each recovers to a real pinned identity,
        // just not the one required for that argument slot.
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        (bytes memory distributionSignature, bytes memory verifierSignature) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);

        assert(
            _authorizePayoutSelector(vault, auth, verifierSignature, distributionSignature)
                == PayoutDistributionSignatures.InvalidDistributionSigner.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_malleableSignatureReverts() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        bytes32 digest = _digest(vault, auth);
        (, bytes memory verifierSignature) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
        bytes memory malleableSignature =
            _flipToMalleable(PayoutSigning.sign(PayoutSigning.DISTRIBUTION_SIGNER_KEY, digest));

        assert(
            _authorizePayoutSelector(vault, auth, malleableSignature, verifierSignature)
                == PayoutDistributionSignatures.MalleableSignature.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function test_replayedPayoutIdRevertsEvenWithFreshValidSignatures() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory first = _payoutAuth(usdg, vault, hook);
        (bytes memory sig1, bytes memory sig2) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), first);
        vault.authorizePayout(first, sig1, sig2);
        hook.consumePayout(first);

        vault.authorizeFunding(_funding(usdg, vault, hook, OPERATIONS, CYCLE_TWO, 3));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_TWO, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_TWO, _route());
        usdg.mint(vault.cycleEscrows(CYCLE_TWO), 175);

        IPegCycleVault.PayoutAuthorization memory replay = first;
        replay.cycleId = CYCLE_TWO;
        replay.nonce = 4;
        replay.returnReceiptDigest = RETURN_RECEIPT_DIGEST_TWO;
        // A fresh, correctly-signed pair over the exact replayed (cycle-mismatched) payoutId.
        (bytes memory replaySig1, bytes memory replaySig2) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), replay);

        assert(
            _authorizePayoutSelector(vault, replay, replaySig1, replaySig2)
                == PayoutDistributionSignatures.PayoutIdAlreadyConsumed.selector
        );
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    function testFuzz_validRootSumAlwaysAcceptsMatchingSignaturePair(uint256 rawRootSum) external {
        uint256 rootSum = rawRootSum % 1_000_000 + 1;
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), rootSum);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        auth.rootSum = rootSum;

        (bytes memory distributionSignature, bytes memory verifierSignature) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
        vault.authorizePayout(auth, distributionSignature, verifierSignature);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.RETURNED));
        address operationsTrigger = hook.consumePayout(auth);
        assert(operationsTrigger == OPERATIONS);
        assert(usdg.balanceOf(address(hook)) == rootSum);
    }

    function testFuzz_signatureOverAnyMutatedFieldIsRejected(uint8 fieldIndex, uint256 mutation)
        external
    {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory signed = _payoutAuth(usdg, vault, hook);
        (bytes memory distributionSignature, bytes memory verifierSignature) =
            PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), signed);

        IPegCycleVault.PayoutAuthorization memory submitted = signed;
        uint256 selector = fieldIndex % 4;
        if (selector == 0) {
            submitted.payoutId = keccak256(abi.encode("mutated-payout", mutation));
        } else if (selector == 1) {
            submitted.manifestDigest = keccak256(abi.encode("mutated-manifest", mutation));
        } else if (selector == 2) {
            submitted.rootHash = keccak256(abi.encode("mutated-root", mutation));
        } else {
            uint256 bump = mutation % 1000 + 1;
            submitted.rootSum = signed.rootSum + bump;
            usdg.mint(vault.cycleEscrows(CYCLE_ONE), bump);
        }

        (bool success,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.authorizePayout,
                    (submitted, distributionSignature, verifierSignature)
                )
            );
        assert(!success);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _tryDeploy(
        VaultUsdg usdg,
        VaultRouteExecutor executor,
        address authorizer,
        address distributionSigner,
        address distributionVerifier
    ) private returns (bool success, address deployed) {
        try new PegCycleVault(
            address(usdg),
            authorizer,
            address(executor),
            BINDING_DIGEST,
            address(this),
            distributionSigner,
            distributionVerifier
        ) returns (
            PegCycleVault vault
        ) {
            success = true;
            deployed = address(vault);
        } catch {
            success = false;
        }
    }

    function _deploy()
        private
        returns (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook)
    {
        usdg = new VaultUsdg();
        executor = new VaultRouteExecutor(usdg);
        vault = new PegCycleVault(
            address(usdg),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        hook = new VaultHook(vault, usdg);
        vault.bindHook(address(hook));
    }

    function _deployOutbound()
        private
        returns (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook)
    {
        (usdg, executor, vault, hook) = _deploy();
        vault.authorizeFunding(_funding(usdg, vault, hook, OPERATIONS, CYCLE_ONE, 1));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());
    }

    function _funding(
        VaultUsdg usdg,
        PegCycleVault vault,
        VaultHook hook,
        address operationsTrigger
    ) private view returns (IPegCycleVault.FundingAuthorization memory) {
        return _funding(usdg, vault, hook, operationsTrigger, CYCLE_ONE, 1);
    }

    function _funding(
        VaultUsdg usdg,
        PegCycleVault vault,
        VaultHook hook,
        address operationsTrigger,
        bytes32 cycleId,
        uint256 nonce
    ) private view returns (IPegCycleVault.FundingAuthorization memory) {
        return IPegCycleVault.FundingAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: cycleId,
            hook: address(hook),
            vault: address(vault),
            usdg: address(usdg),
            operationsTrigger: operationsTrigger,
            amount: 250,
            bindingManifestDigest: BINDING_DIGEST,
            outboundActionDigest: keccak256(_route()),
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

    function _route() private pure returns (bytes memory) {
        return abi.encode(TARGET, ROUTE_SELECTOR, uint256(250));
    }

    function _payoutAuth(VaultUsdg usdg, PegCycleVault vault, VaultHook hook)
        private
        view
        returns (IPegCycleVault.PayoutAuthorization memory)
    {
        return IPegCycleVault.PayoutAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: CYCLE_ONE,
            hook: address(hook),
            vault: address(vault),
            usdg: address(usdg),
            operationsTrigger: OPERATIONS,
            bindingManifestDigest: BINDING_DIGEST,
            payoutId: PAYOUT_ONE,
            manifestDigest: MANIFEST_DIGEST,
            rootHash: ROOT_HASH,
            rootSum: 175,
            returnActionDigest: RETURN_DIGEST,
            returnReceiptDigest: RETURN_RECEIPT_DIGEST,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: 2
        });
    }

    function _digest(PegCycleVault vault, IPegCycleVault.PayoutAuthorization memory auth)
        private
        view
        returns (bytes32)
    {
        return PayoutSigning.digest(PayoutSigning.computeDomainSeparator(address(vault)), auth);
    }

    function _authorizePayoutSelector(
        PegCycleVault vault,
        IPegCycleVault.PayoutAuthorization memory auth,
        bytes memory distributionSignature,
        bytes memory verifierSignature
    ) private returns (bytes4 selector) {
        (bool success, bytes memory reason) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.authorizePayout, (auth, distributionSignature, verifierSignature)
                )
            );
        assert(!success);
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }

    /// @dev Flips a signature's `s` into the upper-half order and its `v` accordingly, producing
    /// the ecrecover-malleable counterpart of an otherwise-valid signature over the same digest.
    function _flipToMalleable(bytes memory signature) private pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        // secp256k1 curve order N.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        return abi.encodePacked(r, flippedS, flippedV);
    }
}
