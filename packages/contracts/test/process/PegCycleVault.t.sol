// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "../../src/process/IPegCycleRouteExecutor.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { PegCycleRouteExecutor } from "../../src/process/PegCycleRouteExecutor.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface VaultVm {
    function prank(address caller) external;
    function warp(uint256 timestamp) external;
    function getNonce(address account) external view returns (uint64);
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
}

contract PegCycleVaultTest {
    VaultVm private constant VM = VaultVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant CYCLE_ONE = keccak256("cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("cycle-two");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");
    bytes32 private constant RETURN_RECEIPT_DIGEST = keccak256("return-receipt");
    bytes32 private constant FAILURE_RECEIPT_DIGEST = keccak256("failure-receipt");
    bytes32 private constant PAYOUT_ONE = keccak256("payout-one");
    bytes32 private constant PAYOUT_TWO = keccak256("payout-two");
    bytes32 private constant MANIFEST_DIGEST = keccak256("distribution-manifest");
    bytes32 private constant ROOT_HASH = keccak256("distribution-root");
    bytes32 private constant RETURN_RECEIPT_DIGEST_TWO = keccak256("return-receipt-two");
    address private constant OPERATIONS = address(0x7000);
    address private constant STRANGER = address(0xBAD1);
    address private constant TARGET = address(0xCAFE);
    bytes4 private constant ROUTE_SELECTOR = bytes4(keccak256("boundRoute(bytes)"));

    function test_authorizationStaysPendingUntilExactHookFundingAndNeverCreditsOperations()
        external
    {
        (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook) =
            _deploy();
        IPegCycleVault.FundingAuthorization memory auth =
            _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
        vault.authorizeFunding(auth);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.EMPTY));
        assert(vault.readPendingAuthorization().cycleId == CYCLE_ONE);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.FUNDED));
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 250);
        assert(usdg.balanceOf(address(vault)) == 0);
        assert(usdg.balanceOf(OPERATIONS) == 0);
        assert(vault.readPendingAuthorization().cycleId == bytes32(0));
        assert(vault.readActiveAuthorization().outboundActionDigest == keccak256(_route()));
        executor;
    }

    function test_wrongAuthorizerAndEveryFrozenIdentityFieldAreRejectedWithoutMutation() external {
        (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook) =
            _deploy();
        IPegCycleVault.FundingAuthorization memory auth =
            _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
        bytes32 beforeDigest = _vaultDigest(usdg, vault);
        VM.prank(STRANGER);
        (bool wrongAuthorizer,) =
            address(vault).call(abi.encodeCall(PegCycleVault.authorizeFunding, auth));
        assert(!wrongAuthorizer);

        auth.requirementsRevision = 55;
        _reject(vault, auth);
        auth.requirementsRevision = 57;
        auth.chainId += 1;
        _reject(vault, auth);
        auth.chainId = block.chainid;
        auth.hook = STRANGER;
        _reject(vault, auth);
        auth.hook = address(hook);
        auth.vault = STRANGER;
        _reject(vault, auth);
        auth.vault = address(vault);
        auth.usdg = STRANGER;
        _reject(vault, auth);
        auth.usdg = address(usdg);
        auth.bindingManifestDigest = bytes32(uint256(1));
        _reject(vault, auth);
        auth.bindingManifestDigest = BINDING_DIGEST;
        auth.operationsTrigger = address(this);
        _reject(vault, auth);
        auth.operationsTrigger = address(executor);
        _reject(vault, auth);
        auth.operationsTrigger = address(usdg);
        _reject(vault, auth);
        auth.operationsTrigger = OPERATIONS;
        auth.returnDestination = STRANGER;
        _reject(vault, auth);
        auth.returnDestination = vault.computeCycleEscrow(CYCLE_ONE);
        auth.amount = 0;
        _reject(vault, auth);
        auth.amount = 250;
        auth.expiresAt = uint64(block.timestamp);
        _reject(vault, auth);
        auth.expiresAt = uint64(block.timestamp + 1 days);
        auth.outboundActionDigest = bytes32(0);
        _reject(vault, auth);
        auth.outboundActionDigest = keccak256(_route());
        auth.returnActionDigest = bytes32(0);
        _reject(vault, auth);
        auth.returnActionDigest = RETURN_DIGEST;
        auth.nonce = 0;
        _reject(vault, auth);
        assert(_vaultDigest(usdg, vault) == beforeDigest);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_nonceAndCycleReplayReachReplayGuardsBeforePendingOrLifecycleChecks() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory auth =
            _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
        vault.authorizeFunding(auth);
        IPegCycleVault.FundingAuthorization memory nonceReplay =
            _auth(usdg, vault, hook, CYCLE_TWO, 1, 1, _route());
        assert(
            _authorizationError(vault, nonceReplay) == PegCycleVault.InvalidAuthorization.selector
        );
        IPegCycleVault.FundingAuthorization memory cycleReplay =
            _auth(usdg, vault, hook, CYCLE_ONE, 1, 2, _route());
        assert(
            _authorizationError(vault, cycleReplay) == PegCycleVault.InvalidAuthorization.selector
        );
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        _reject(vault, _auth(usdg, vault, hook, CYCLE_TWO, 1, 2, _route()));
        (bool rebound,) = address(vault).call(abi.encodeCall(PegCycleVault.bindHook, address(hook)));
        assert(!rebound);
        assert(vault.isNonceConsumed(1));
        assert(vault.isCycleConsumed(CYCLE_ONE));
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_acceptedAuthorizationThatExpiresBeforeConsumptionLeavesEverythingUnchanged()
        external
    {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory auth =
            _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
        auth.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFunding(auth);
        usdg.mint(address(hook), 250);
        VM.warp(block.timestamp + 2);
        bytes32 beforeDigest = _vaultDigest(usdg, vault);
        (bool success,) =
            address(hook).call(abi.encodeCall(VaultHook.fund, (CYCLE_ONE, OPERATIONS)));
        assert(!success);
        assert(_vaultDigest(usdg, vault) == beforeDigest);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_fundingThatExpiresBeforeOutboundCannotExecute() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory auth =
            _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
        auth.expiresAt = uint64(block.timestamp + 1);
        vault.authorizeFunding(auth);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.warp(block.timestamp + 2);
        bytes32 beforeDigest = _vaultDigest(usdg, vault);
        VM.prank(OPERATIONS);
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.executeOutbound, (CYCLE_ONE, _route())));
        assert(!success);
        assert(_vaultDigest(usdg, vault) == beforeDigest);
    }

    function test_bindingRejectsWrongAuthorityAndHookThatNamesAnotherVault() external {
        VaultUsdg usdg = new VaultUsdg();
        VaultRouteExecutor executor = new VaultRouteExecutor(usdg);
        PegCycleVault vault = new PegCycleVault(
            address(usdg),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        PegCycleVault otherVault = new PegCycleVault(
            address(usdg),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        VaultHook wrongHook = new VaultHook(otherVault, usdg);
        VM.prank(STRANGER);
        (bool wrongAuthority,) =
            address(vault).call(abi.encodeCall(PegCycleVault.bindHook, address(wrongHook)));
        assert(!wrongAuthority);
        (bool nonreciprocal,) =
            address(vault).call(abi.encodeCall(PegCycleVault.bindHook, address(wrongHook)));
        assert(!nonreciprocal);
        assert(vault.hook() == address(0));
    }

    function test_outboundUsesOnlyExactDigestTypedExecutorAndConsumesPrincipalOnce() external {
        (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook) =
            _deployFunded();
        bytes memory routeData = _route();
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, routeData);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 0);
        assert(usdg.balanceOf(address(vault)) == 0);
        assert(usdg.balanceOf(address(executor)) == 0);
        assert(usdg.balanceOf(OPERATIONS) == 0);
        assert(usdg.allowance(vault.cycleEscrows(CYCLE_ONE), address(executor)) == 0);
        VM.prank(OPERATIONS);
        (bool replay,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.executeOutbound, (CYCLE_ONE, routeData)));
        assert(!replay);
        hook;
    }

    function test_surplusReceivedAfterFundingCannotBlockExactOutbound() external {
        (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault,) = _deployFunded();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrow, 1);

        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
        assert(usdg.balanceOf(escrow) == 1);
        assert(usdg.balanceOf(address(executor)) == 0);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_wrongCallerDigestTargetSelectorAmountAndAllowanceRollbackOutbound() external {
        _assertOutboundRejected(0, STRANGER, _route(), TARGET, ROUTE_SELECTOR, 250, false);
        _assertOutboundRejected(
            0, OPERATIONS, bytes("wrong-digest"), TARGET, ROUTE_SELECTOR, 250, false
        );
        _assertOutboundRejected(
            1,
            OPERATIONS,
            abi.encode(STRANGER, ROUTE_SELECTOR, uint256(250)),
            TARGET,
            ROUTE_SELECTOR,
            250,
            false
        );
        _assertOutboundRejected(
            1,
            OPERATIONS,
            abi.encode(TARGET, bytes4(0xDEADBEEF), uint256(250)),
            TARGET,
            ROUTE_SELECTOR,
            250,
            false
        );
        _assertOutboundRejected(
            1,
            OPERATIONS,
            abi.encode(TARGET, ROUTE_SELECTOR, uint256(249)),
            TARGET,
            ROUTE_SELECTOR,
            250,
            false
        );
        _assertOutboundRejected(0, OPERATIONS, _route(), TARGET, ROUTE_SELECTOR, 250, true);
    }

    function test_tokenFailureShortExcessDeltaAndReentrancyRollbackOutbound() external {
        VaultUsdg.Behavior[8] memory behaviors;
        behaviors[0] = VaultUsdg.Behavior.RevertTransfer;
        behaviors[1] = VaultUsdg.Behavior.ReturnFalse;
        behaviors[2] = VaultUsdg.Behavior.MalformedReturn;
        behaviors[3] = VaultUsdg.Behavior.ShortSource;
        behaviors[4] = VaultUsdg.Behavior.ShortDestination;
        behaviors[5] = VaultUsdg.Behavior.ExcessSource;
        behaviors[6] = VaultUsdg.Behavior.ExcessDestination;
        behaviors[7] = VaultUsdg.Behavior.Reenter;
        for (uint256 index; index < behaviors.length; ++index) {
            (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault,) = _deployFunded();
            if (behaviors[index] == VaultUsdg.Behavior.Reenter) {
                usdg.configureReentry(
                    address(vault),
                    abi.encodeCall(PegCycleVault.executeOutbound, (CYCLE_ONE, _route()))
                );
            } else {
                usdg.setBehavior(behaviors[index]);
            }
            bytes32 beforeDigest = _vaultDigest(usdg, vault);
            VM.prank(OPERATIONS);
            (bool success,) = address(vault)
                .call(abi.encodeCall(PegCycleVault.executeOutbound, (CYCLE_ONE, _route())));
            assert(!success);
            assert(_vaultDigest(usdg, vault) == beforeDigest);
            assert(usdg.balanceOf(address(executor)) == 0);
            assert(usdg.balanceOf(OPERATIONS) == 0);
        }
    }

    function test_exactReturnedPayoutMovesVaultUsdGToHookAndCommitsCycle() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.RETURNED));
        assert(vault.payoutAuthorizationDigest() == keccak256(abi.encode(auth)));
        address operationsTrigger = hook.consumePayout(auth);

        assert(operationsTrigger == OPERATIONS);
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 0);
        assert(usdg.balanceOf(address(vault)) == 0);
        assert(usdg.balanceOf(address(hook)) == 175);
        assert(usdg.balanceOf(OPERATIONS) == 0);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
        assert(vault.payoutAuthorizationDigest() == bytes32(0));
    }

    function test_activeAuthorizationReadIsScopedToTheLiveCycle() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
        IPegCycleVault vaultView = IPegCycleVault(address(vault));
        assert(vault.readActiveAuthorization().cycleId == bytes32(0));

        vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route()));
        assert(vault.readActiveAuthorization().cycleId == bytes32(0));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        assert(vault.readActiveAuthorization().cycleId == CYCLE_ONE);
        assert(vaultView.cycleLifecycles(CYCLE_ONE) == uint8(PegCycleVault.Lifecycle.FUNDED));

        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());
        assert(vault.readActiveAuthorization().cycleId == CYCLE_ONE);
        assert(vaultView.cycleLifecycles(CYCLE_ONE) == uint8(PegCycleVault.Lifecycle.OUTBOUND));

        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory payout = _payoutAuth(usdg, vault, hook);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), payout);
            vault.authorizePayout(payout, distributionSignature, verifierSignature);
        }

        assert(vault.readActiveAuthorization().cycleId == CYCLE_ONE);
        assert(vaultView.cycleLifecycles(CYCLE_ONE) == uint8(PegCycleVault.Lifecycle.RETURNED));

        hook.consumePayout(payout);
        assert(vault.readActiveAuthorization().cycleId == bytes32(0));
        assert(
            vaultView.cycleLifecycles(CYCLE_ONE) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED)
        );
    }

    function test_surplusPresentAtReturnAuthorizationCannotBlockExactPayout() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrow, 176);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        auth.nonce = 3;

        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        hook.consumePayout(auth);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
        assert(usdg.balanceOf(escrow) == 1);
        assert(usdg.balanceOf(address(hook)) == 175);
        assert(usdg.balanceOf(OPERATIONS) == 0);

        address nextEscrow = vault.computeCycleEscrow(CYCLE_TWO);
        vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_TWO, 250, 2, _route()));
        assert(vault.readPendingAuthorization().cycleId == CYCLE_TWO);
        assert(vault.readPendingAuthorization().nonce == 2);
        assert(vault.cycleEscrows(CYCLE_TWO) == nextEscrow);
        assert(nextEscrow != escrow);
        assert(usdg.balanceOf(escrow) == 1);
        assert(usdg.balanceOf(nextEscrow) == 0);
    }

    function test_surplusReceivedAfterReturnCannotBlockExactPayout() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrow, 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        usdg.mint(escrow, 1);

        hook.consumePayout(auth);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
        assert(usdg.balanceOf(escrow) == 1);
        assert(usdg.balanceOf(address(hook)) == 175);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_everyPayoutIdentityExpiryAndAmountMismatchAreRejectedWithoutMutation() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        bytes32 beforeDigest = _vaultDigest(usdg, vault);

        auth.requirementsRevision = 55;
        _rejectPayout(vault, auth);
        auth.requirementsRevision = 57;
        auth.chainId += 1;
        _rejectPayout(vault, auth);
        auth.chainId = block.chainid;
        auth.cycleId = CYCLE_TWO;
        _rejectPayout(vault, auth);
        auth.cycleId = CYCLE_ONE;
        auth.hook = STRANGER;
        _rejectPayout(vault, auth);
        auth.hook = address(hook);
        auth.vault = STRANGER;
        _rejectPayout(vault, auth);
        auth.vault = address(vault);
        auth.usdg = STRANGER;
        _rejectPayout(vault, auth);
        auth.usdg = address(usdg);
        auth.operationsTrigger = STRANGER;
        _rejectPayout(vault, auth);
        auth.operationsTrigger = OPERATIONS;
        auth.bindingManifestDigest = keccak256("wrong-binding");
        _rejectPayout(vault, auth);
        auth.bindingManifestDigest = BINDING_DIGEST;
        auth.payoutId = bytes32(0);
        _rejectPayout(vault, auth);
        auth.payoutId = PAYOUT_ONE;
        auth.manifestDigest = bytes32(0);
        _rejectPayout(vault, auth);
        auth.manifestDigest = MANIFEST_DIGEST;
        auth.rootHash = bytes32(0);
        _rejectPayout(vault, auth);
        auth.rootHash = ROOT_HASH;
        auth.rootSum = 176;
        _rejectPayout(vault, auth);
        auth.rootSum = 175;
        auth.returnActionDigest = keccak256("wrong-return");
        _rejectPayout(vault, auth);
        auth.returnActionDigest = RETURN_DIGEST;
        auth.returnReceiptDigest = bytes32(0);
        _rejectPayout(vault, auth);
        auth.returnReceiptDigest = RETURN_RECEIPT_DIGEST;
        auth.nonce = 1;
        _rejectPayout(vault, auth);
        auth.nonce = 0;
        _rejectPayout(vault, auth);
        auth.nonce = 2;
        auth.expiresAt = uint64(block.timestamp);
        _rejectPayout(vault, auth);

        assert(_vaultDigest(usdg, vault) == beforeDigest);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_onlyAuthorizerCanAuthorizePayoutWhileLifecycleIsValid() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        bytes32 beforeDigest = _vaultDigest(usdg, vault);

        VM.prank(STRANGER);
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.authorizePayout, (auth, bytes(""), bytes(""))));

        assert(!success);
        assert(_vaultDigest(usdg, vault) == beforeDigest);
    }

    function test_returnMustMeetMinimumEvenWhenVaultBalanceMatchesRootSum() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deploy();
        IPegCycleVault.FundingAuthorization memory funding =
            _auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route());
        funding.minimumReturnUsdg = 176;
        vault.authorizeFunding(funding);
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        bytes32 beforeDigest = _vaultDigest(usdg, vault);

        _rejectPayout(vault, _payoutAuth(usdg, vault, hook));

        assert(_vaultDigest(usdg, vault) == beforeDigest);
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 175);
    }

    function test_coordinatorBalanceCannotFundPayoutOrBypassLifecycle() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployFunded();
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        _rejectPayout(vault, auth);

        usdg.mint(address(vault), 176);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());
        _rejectPayout(vault, auth);
        assert(usdg.balanceOf(address(vault)) == 176);
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 0);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_payoutReplayAndEveryAdversarialTransferRollBack() external {
        VaultUsdg.Behavior[8] memory behaviors;
        behaviors[0] = VaultUsdg.Behavior.RevertTransfer;
        behaviors[1] = VaultUsdg.Behavior.ReturnFalse;
        behaviors[2] = VaultUsdg.Behavior.MalformedReturn;
        behaviors[3] = VaultUsdg.Behavior.ShortSource;
        behaviors[4] = VaultUsdg.Behavior.ShortDestination;
        behaviors[5] = VaultUsdg.Behavior.ExcessSource;
        behaviors[6] = VaultUsdg.Behavior.ExcessDestination;
        behaviors[7] = VaultUsdg.Behavior.Reenter;
        for (uint256 index; index < behaviors.length; ++index) {
            (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
            usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
            IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
            {
                (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                    PayoutSigning.computeDomainSeparator(address(vault)), auth
                );
                vault.authorizePayout(auth, distributionSignature, verifierSignature);
            }

            if (behaviors[index] == VaultUsdg.Behavior.Reenter) {
                usdg.configureReentry(
                    address(vault), abi.encodeCall(PegCycleVault.consumePayoutAuthorization, auth)
                );
            } else {
                usdg.setBehavior(behaviors[index]);
            }
            bytes32 beforeDigest = _vaultDigest(usdg, vault);
            (bool success,) = address(hook).call(abi.encodeCall(VaultHook.consumePayout, auth));
            assert(!success);
            assert(_vaultDigest(usdg, vault) == beforeDigest);
            assert(usdg.balanceOf(OPERATIONS) == 0);
        }

        (VaultUsdg replayUsdg,, PegCycleVault replayVault, VaultHook replayHook) = _deployOutbound();
        replayUsdg.mint(replayVault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory replayAuth =
            _payoutAuth(replayUsdg, replayVault, replayHook);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(replayVault)), replayAuth
            );
            replayVault.authorizePayout(replayAuth, distributionSignature, verifierSignature);
        }

        replayHook.consumePayout(replayAuth);
        bytes32 afterDigest = _vaultDigest(replayUsdg, replayVault);
        (bool replay,) =
            address(replayHook).call(abi.encodeCall(VaultHook.consumePayout, replayAuth));
        assert(!replay);
        _rejectPayout(replayVault, replayAuth);
        assert(_vaultDigest(replayUsdg, replayVault) == afterDigest);
    }

    function test_payoutConsumptionIsHookOnlyAndExpiresWithoutMutation() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        auth.expiresAt = uint64(block.timestamp + 1);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        bytes32 beforeDigest = _vaultDigest(usdg, vault);

        VM.prank(STRANGER);
        (bool wrongCaller,) =
            address(vault).call(abi.encodeCall(PegCycleVault.consumePayoutAuthorization, auth));
        assert(!wrongCaller);
        VM.warp(block.timestamp + 2);
        (bool expired,) = address(hook).call(abi.encodeCall(VaultHook.consumePayout, auth));
        assert(!expired);
        assert(_vaultDigest(usdg, vault) == beforeDigest);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_terminalFailureIsAuthorizerOnlyAndQuarantinesCycleFunds() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployFunded();
        (bool beforeOutbound,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordTerminalFailure, (CYCLE_ONE, FAILURE_RECEIPT_DIGEST)
                )
            );
        assert(!beforeOutbound);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());

        (bool wrongCycle,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordTerminalFailure, (CYCLE_TWO, FAILURE_RECEIPT_DIGEST)
                )
            );
        assert(!wrongCycle);

        VM.prank(STRANGER);
        (bool wrongCaller,) = address(vault)
            .call(
                abi.encodeCall(
                    PegCycleVault.recordTerminalFailure, (CYCLE_ONE, FAILURE_RECEIPT_DIGEST)
                )
            );
        assert(!wrongCaller);
        (bool zeroDigest,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.recordTerminalFailure, (CYCLE_ONE, bytes32(0))));
        assert(!zeroDigest);
        address failedEscrow = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(failedEscrow, 1);
        vault.recordTerminalFailure(CYCLE_ONE, FAILURE_RECEIPT_DIGEST);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.FAILED));
        assert(vault.terminalFailureReceiptDigest() == FAILURE_RECEIPT_DIGEST);
        assert(usdg.balanceOf(OPERATIONS) == 0);
        _reject(vault, _auth(usdg, vault, hook, CYCLE_TWO, 1, 2, _route()));
        assert(usdg.balanceOf(failedEscrow) == 1);
        usdg.mint(failedEscrow, 175);
        _rejectPayout(vault, _payoutAuth(usdg, vault, hook));
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.FAILED));
    }

    function test_failedCycleHistoryRemainsReadableWithoutAStaleActiveAuthorization() external {
        (,, PegCycleVault vault,) = _deployOutbound();

        vault.recordTerminalFailure(CYCLE_ONE, FAILURE_RECEIPT_DIGEST);

        assert(vault.readActiveAuthorization().cycleId == bytes32(0));
        assert(
            IPegCycleVault(address(vault)).cycleLifecycles(CYCLE_ONE)
                == uint8(PegCycleVault.Lifecycle.FAILED)
        );
        assert(vault.failureReceiptDigests(CYCLE_ONE) == FAILURE_RECEIPT_DIGEST);
    }

    function test_onlyPayoutCommittedPermitsTheNextCycle() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory payoutAuth = _payoutAuth(usdg, vault, hook);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(vault)), payoutAuth
            );
            vault.authorizePayout(payoutAuth, distributionSignature, verifierSignature);
        }

        hook.consumePayout(payoutAuth);

        IPegCycleVault.FundingAuthorization memory next =
            _auth(usdg, vault, hook, CYCLE_TWO, 1, 3, _route());
        vault.authorizeFunding(next);
        assert(vault.readPendingAuthorization().cycleId == CYCLE_TWO);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_payoutIdAndReturnReceiptCannotReplayAcrossCompletedCycles() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory first = _payoutAuth(usdg, vault, hook);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), first);
            vault.authorizePayout(first, distributionSignature, verifierSignature);
        }

        hook.consumePayout(first);
        assert(vault.isPayoutIdConsumed(PAYOUT_ONE));
        assert(vault.isReturnReceiptDigestConsumed(RETURN_RECEIPT_DIGEST));

        vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_TWO, 250, 3, _route()));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_TWO, OPERATIONS);
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_TWO, _route());
        usdg.mint(vault.cycleEscrows(CYCLE_TWO), 175);
        IPegCycleVault.PayoutAuthorization memory second = _payoutAuth(usdg, vault, hook);
        second.cycleId = CYCLE_TWO;
        second.nonce = 4;

        _rejectPayout(vault, second);
        second.payoutId = PAYOUT_TWO;
        _rejectPayout(vault, second);
        second.returnReceiptDigest = RETURN_RECEIPT_DIGEST_TWO;
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), second);
            vault.authorizePayout(second, distributionSignature, verifierSignature);
        }

        hook.consumePayout(second);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_TWO)) == 0);
        assert(usdg.balanceOf(address(vault)) == 0);
    }

    function test_dustFastPathTransfersExactlyRootSumLeavingTrivialExcessInEscrow() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        // A one-unit stray donation on top of the exact evidenced root sum must not be able
        // to lock authorizePayout forever: the escrow balance is >= rootSum, so the ordinary
        // (non-DEGRADED) path pays exactly rootSum and leaves the trivial excess in place.
        usdg.mint(escrow, 176);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);

        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        hook.consumePayout(auth);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
        assert(usdg.balanceOf(address(hook)) == 175);
        assert(usdg.balanceOf(escrow) == 1);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function test_expiredPayoutAuthorizationRenewsCleanlyInsteadOfLockingPrincipal() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        address escrow = vault.cycleEscrows(CYCLE_ONE);
        usdg.mint(escrow, 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        auth.expiresAt = uint64(block.timestamp + 1);
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.RETURNED));

        VM.warp(block.timestamp + 2);
        // The stored PayoutAuthorization expired before the hook ever consumed it. Principal
        // is not stuck: the same renewal mechanism used for a stranded FUNDED cycle applies
        // here, and the escrow balance never moves during renewal.
        (bool expired,) = address(hook).call(abi.encodeCall(VaultHook.consumePayout, auth));
        assert(!expired);
        assert(usdg.balanceOf(escrow) == 175);

        IPegCycleVault.PayoutAuthorization memory renewal = auth;
        renewal.expiresAt = uint64(block.timestamp + 1 days);
        renewal.nonce = 5;
        vault.renewPayoutAuthorizationDeadline(renewal);
        assert(vault.payoutAuthorizationDigest() == keccak256(abi.encode(renewal)));
        assert(usdg.balanceOf(escrow) == 175);

        address operationsTrigger = hook.consumePayout(renewal);

        assert(operationsTrigger == OPERATIONS);
        assert(usdg.balanceOf(escrow) == 0);
        assert(usdg.balanceOf(address(hook)) == 175);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.PAYOUT_COMMITTED));
    }

    function test_committedAuthorizationAndReceiptBindingRemainAuditReadable() external {
        (VaultUsdg usdg,, PegCycleVault vault, VaultHook hook) = _deployOutbound();
        usdg.mint(vault.cycleEscrows(CYCLE_ONE), 175);
        IPegCycleVault.PayoutAuthorization memory auth = _payoutAuth(usdg, vault, hook);
        bytes32 expectedAuthorizationDigest = keccak256(abi.encode(auth));
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) =
                PayoutSigning.signPair(PayoutSigning.computeDomainSeparator(address(vault)), auth);
            vault.authorizePayout(auth, distributionSignature, verifierSignature);
        }

        hook.consumePayout(auth);

        (bytes32 authorizationDigest, bytes32 payoutId, bytes32 returnReceiptDigest) =
            vault.readCommittedPayoutBinding(CYCLE_ONE);
        assert(authorizationDigest == expectedAuthorizationDigest);
        assert(payoutId == PAYOUT_ONE);
        assert(returnReceiptDigest == RETURN_RECEIPT_DIGEST);
    }

    /// @notice End-to-end integration test for the concrete typed route executor (WP-28):
    /// unlike every other test in this file (which wires the vault to the generic
    /// `VaultRouteExecutor` mock so the vault's own authorization/replay/delta logic can be
    /// exercised independently of any one route implementation), this test binds a real
    /// `PegCycleRouteExecutor` and confirms `PegCycleVault.executeOutbound` completes against it:
    /// the escrow's pushed principal lands exactly, once, in a mock Relay deposit target, with
    /// no allowance or residual balance left anywhere along the path.
    function test_realPegCycleRouteExecutorCompletesOutboundThroughTheVault() external {
        MockRelayDepository depository = new MockRelayDepository();
        VaultUsdg usdg = new VaultUsdg();

        // PegCycleVault's constructor requires the route executor to already have code, so the
        // executor must deploy first — bound to the vault's own precomputed CREATE address.
        uint64 nonceNow = VM.getNonce(address(this));
        address predictedVault = VM.computeCreateAddress(address(this), nonceNow + 1);
        PegCycleRouteExecutor executor = new PegCycleRouteExecutor(
            address(usdg), predictedVault, address(depository), bytes4(0)
        );
        PegCycleVault vault = new PegCycleVault(
            address(usdg),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        assert(address(vault) == predictedVault);
        assert(executor.vault() == address(vault));

        VaultHook hook = new VaultHook(vault, usdg);
        vault.bindHook(address(hook));

        bytes memory routeData = abi.encode(
            PegCycleRouteExecutor.RouteParams({
                target: address(depository),
                amount: 250,
                requestId: keccak256("relay-request-integration"),
                minimumReceive: 1
            })
        );
        vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_ONE, 250, 1, routeData));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.FUNDED));

        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, routeData);

        assert(uint8(vault.lifecycle()) == uint8(PegCycleVault.Lifecycle.OUTBOUND));
        assert(usdg.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 0);
        assert(usdg.balanceOf(address(executor)) == 0);
        assert(usdg.balanceOf(address(depository)) == 250);
        assert(usdg.allowance(vault.cycleEscrows(CYCLE_ONE), address(executor)) == 0);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function _assertOutboundRejected(
        uint8 digestMode,
        address caller,
        bytes memory routeData,
        address expectedTarget,
        bytes4 expectedSelector,
        uint256 expectedAmount,
        bool retainedAllowance
    ) private {
        (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook) =
            _deploy();
        executor.configure(expectedTarget, expectedSelector, expectedAmount);
        bytes memory authorizedRoute = digestMode == 0 ? _route() : routeData;
        vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_ONE, 250, 1, authorizedRoute));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
        if (retainedAllowance) {
            usdg.setAllowance(vault.cycleEscrows(CYCLE_ONE), address(executor), 1);
        }
        bytes32 beforeDigest = _vaultDigest(usdg, vault);
        VM.prank(caller);
        (bool success, bytes memory reason) = address(vault)
            .call(abi.encodeCall(PegCycleVault.executeOutbound, (CYCLE_ONE, routeData)));
        assert(!success);
        if (retainedAllowance) {
            assert(_selector(reason) == PegCycleVault.RetainedAllowance.selector);
        }
        assert(_vaultDigest(usdg, vault) == beforeDigest);
        assert(usdg.balanceOf(OPERATIONS) == 0);
    }

    function _deployFunded()
        private
        returns (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook)
    {
        (usdg, executor, vault, hook) = _deploy();
        vault.authorizeFunding(_auth(usdg, vault, hook, CYCLE_ONE, 250, 1, _route()));
        usdg.mint(address(hook), 250);
        hook.fund(CYCLE_ONE, OPERATIONS);
    }

    function _deployOutbound()
        private
        returns (VaultUsdg usdg, VaultRouteExecutor executor, PegCycleVault vault, VaultHook hook)
    {
        (usdg, executor, vault, hook) = _deployFunded();
        VM.prank(OPERATIONS);
        vault.executeOutbound(CYCLE_ONE, _route());
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

    function _auth(
        VaultUsdg usdg,
        PegCycleVault vault,
        VaultHook hook,
        bytes32 cycleId,
        uint256 amount,
        uint256 nonce,
        bytes memory routeData
    ) private view returns (IPegCycleVault.FundingAuthorization memory) {
        return IPegCycleVault.FundingAuthorization({
                requirementsRevision: 57,
                chainId: block.chainid,
                cycleId: cycleId,
                hook: address(hook),
                vault: address(vault),
                usdg: address(usdg),
                operationsTrigger: OPERATIONS,
                amount: amount,
                bindingManifestDigest: BINDING_DIGEST,
                outboundActionDigest: keccak256(routeData),
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

    function _reject(PegCycleVault vault, IPegCycleVault.FundingAuthorization memory auth) private {
        (bool success,) = address(vault).call(abi.encodeCall(PegCycleVault.authorizeFunding, auth));
        assert(!success);
    }

    function _rejectPayout(PegCycleVault vault, IPegCycleVault.PayoutAuthorization memory auth)
        private
    {
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.authorizePayout, (auth, bytes(""), bytes(""))));
        assert(!success);
    }

    function _authorizationError(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory auth
    ) private returns (bytes4) {
        (bool success, bytes memory reason) = address(vault)
            .call(abi.encodeCall(PegCycleVault.authorizeFunding, auth));
        assert(!success);
        return _selector(reason);
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }

    function _vaultDigest(VaultUsdg usdg, PegCycleVault vault) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                usdg.balanceOf(address(vault)),
                usdg.balanceOf(vault.computeCycleEscrow(CYCLE_ONE)),
                usdg.balanceOf(vault.computeCycleEscrow(CYCLE_TWO)),
                usdg.balanceOf(OPERATIONS),
                vault.lifecycle(),
                vault.readPendingAuthorization(),
                vault.readActiveAuthorization()
            )
        );
    }
}

contract VaultHook {
    PegCycleVault public immutable pegCycleVault;
    VaultUsdg private immutable usdg;

    constructor(PegCycleVault vault, VaultUsdg token) {
        pegCycleVault = vault;
        usdg = token;
    }

    function fund(bytes32 cycleId, address operationsTrigger) external {
        (IPegCycleVault.FundingAuthorization memory auth, uint256 beforeBalance) =
            pegCycleVault.consumeFundingAuthorization(cycleId, operationsTrigger);
        usdg.transfer(auth.returnDestination, auth.amount);
        pegCycleVault.confirmFunding(cycleId, beforeBalance);
    }

    function consumePayout(IPegCycleVault.PayoutAuthorization calldata authorization)
        external
        returns (address operationsTrigger)
    {
        return pegCycleVault.consumePayoutAuthorization(authorization);
    }
}

/// @notice Stand-in for a Relay solver's on-chain deposit address. Plain-transfer-mode deposits
/// never call into it — its live USDG balance is the deposit record — so it carries no logic;
/// it exists only to give the destination address a clear name in the integration test above.
contract MockRelayDepository { }

contract VaultRouteExecutor is IPegCycleRouteExecutor {
    VaultUsdg private immutable usdg;
    address private expectedTarget = TARGET_DEFAULT;
    bytes4 private expectedSelector = SELECTOR_DEFAULT;
    uint256 private expectedAmount = 250;
    address private constant TARGET_DEFAULT = address(0xCAFE);
    bytes4 private constant SELECTOR_DEFAULT = bytes4(keccak256("boundRoute(bytes)"));

    constructor(VaultUsdg token) {
        usdg = token;
    }

    function configure(address target, bytes4 selector, uint256 amount) external {
        expectedTarget = target;
        expectedSelector = selector;
        expectedAmount = amount;
    }

    function executeOutbound(
        bytes32,
        address token,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external {
        (address target, bytes4 selector, uint256 routeAmount) =
            abi.decode(routeData, (address, bytes4, uint256));
        require(
            token == address(usdg) && returnDestination != msg.sender && target == expectedTarget
                && selector == expectedSelector && routeAmount == amount && amount == expectedAmount
        );
        usdg.burn(address(this), amount);
    }
}

contract VaultUsdg {
    enum Behavior {
        Normal,
        RevertTransfer,
        ReturnFalse,
        MalformedReturn,
        ShortSource,
        ShortDestination,
        ExcessSource,
        ExcessDestination,
        Reenter
    }
    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowances;
    Behavior private behavior;
    address private reentryTarget;
    bytes private reentryCall;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function burn(address account, uint256 amount) external {
        balances[account] -= amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }

    function setAllowance(address owner, address spender, uint256 amount) external {
        allowances[owner][spender] = amount;
    }

    function setBehavior(Behavior next) external {
        behavior = next;
    }

    function configureReentry(address target, bytes calldata callData) external {
        reentryTarget = target;
        reentryCall = callData;
        behavior = Behavior.Reenter;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        Behavior active = behavior;
        if (active == Behavior.RevertTransfer) revert();
        if (active == Behavior.ReturnFalse) return false;
        if (active == Behavior.Reenter) {
            (bool success,) = reentryTarget.call(reentryCall);
            if (!success) revert();
        }
        uint256 sourceDelta = active == Behavior.ShortSource
            ? amount - 1
            : active == Behavior.ExcessSource ? amount + 1 : amount;
        uint256 destinationDelta = active == Behavior.ShortDestination
            ? amount - 1
            : active == Behavior.ExcessDestination ? amount + 1 : amount;
        balances[msg.sender] -= sourceDelta;
        balances[recipient] += destinationDelta;
        if (active == Behavior.MalformedReturn) assembly ("memory-safe") { return(0, 0) }
        return true;
    }
}
