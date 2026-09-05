// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "../../src/process/IPegCycleRouteExecutor.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { ProcessBudget } from "../../src/process/ProcessBudget.sol";
import { CompileOnlyPegCycleVault } from "./CompileOnlyPegCycleVault.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface Vm {
    function prank(address caller) external;
}

contract ProcessBudgetTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant PROGRAMMABLE = address(0x5000);
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS = address(0x7000);
    address private constant OPERATIONS_TWO = address(0x7001);
    address private constant TREASURY_TWO = address(0x6001);
    address private constant STRANGER = address(0xBAD1);
    bytes32 private constant CYCLE_ONE = keccak256("cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("cycle-two");
    bytes32 private constant BINDING_DIGEST = keccak256("binding-manifest");
    bytes32 private constant OUTBOUND_DIGEST = keccak256("outbound-route");
    bytes32 private constant RETURN_DIGEST = keccak256("return-route");

    function test_openPegCycleFundsOnlyCycleEscrowAndRecordsOperationsAsTrigger() external {
        (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
            _deployAndAccrue();
        _authorize(subject, vault, CYCLE_ONE, 250, OPERATIONS, 1);
        VM.prank(OPERATIONS);
        ProcessBudget.ReleasedCycle memory released = subject.openPegCycle(CYCLE_ONE);
        assert(released.cycleId == CYCLE_ONE);
        assert(released.amount == 250);
        assert(released.operationsTrigger == OPERATIONS);
        assert(token.balanceOf(address(subject)) == 50);
        assert(token.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 250);
        assert(token.balanceOf(address(vault)) == 0);
        assert(token.balanceOf(OPERATIONS) == 0);
        assert(subject.processLiability() == 0);
        assert(subject.totalLiability() == 50);
        assert(subject.isSolvent());
    }

    function test_wrongCallerZeroExcessReplayAndSecondActiveCycleRollbackEverything() external {
        (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
            _deployAndAccrue();
        _authorize(subject, vault, CYCLE_ONE, 250, OPERATIONS, 1);
        _assertOpenRejectedUnchanged(token, subject, vault, CYCLE_ONE, STRANGER);
        VM.prank(OPERATIONS);
        subject.openPegCycle(CYCLE_ONE);
        bytes32 fundedDigest = _stateDigest(token, subject, vault, CYCLE_ONE);
        VM.prank(OPERATIONS);
        (bool replay,) =
            address(subject).call(abi.encodeCall(ProcessBudget.openPegCycle, CYCLE_ONE));
        assert(!replay);
        assert(_stateDigest(token, subject, vault, CYCLE_ONE) == fundedDigest);
        assert(token.balanceOf(OPERATIONS) == 0);

        (, BoundProcessBudgetHarness zeroSubject, PegCycleVault zeroVault) = _deployAndAccrue();
        IPegCycleVault.FundingAuthorization memory zero =
            _authorization(zeroSubject, zeroVault, CYCLE_ONE, 1, OPERATIONS, 1);
        zero.amount = 0;
        _assertAuthorizationRejected(zeroVault, zero);

        (
            ProcessUsdg excessToken,
            BoundProcessBudgetHarness excessSubject,
            PegCycleVault excessVault
        ) = _deployAndAccrue();
        _authorize(excessSubject, excessVault, CYCLE_ONE, 251, OPERATIONS, 1);
        _assertOpenRejectedUnchanged(excessToken, excessSubject, excessVault, CYCLE_ONE, OPERATIONS);
        _assertAuthorizationRejected(
            vault, _authorization(subject, vault, CYCLE_TWO, 1, OPERATIONS, 2)
        );
    }

    function test_tokenFailuresAndReentrancyRollbackLiabilityCycleAndAllBalances() external {
        ProcessUsdg.Behavior[8] memory behaviors;
        behaviors[0] = ProcessUsdg.Behavior.RevertTransfer;
        behaviors[1] = ProcessUsdg.Behavior.ReturnFalse;
        behaviors[2] = ProcessUsdg.Behavior.MalformedReturn;
        behaviors[3] = ProcessUsdg.Behavior.ShortSource;
        behaviors[4] = ProcessUsdg.Behavior.ShortDestination;
        behaviors[5] = ProcessUsdg.Behavior.ExcessSource;
        behaviors[6] = ProcessUsdg.Behavior.ExcessDestination;
        behaviors[7] = ProcessUsdg.Behavior.Reenter;
        for (uint256 index; index < behaviors.length; ++index) {
            (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
                _deployAndAccrue();
            _authorize(subject, vault, CYCLE_ONE, 250, OPERATIONS, 1);
            if (behaviors[index] == ProcessUsdg.Behavior.Reenter) {
                token.configureReentry(
                    address(subject), abi.encodeCall(ProcessBudget.openPegCycle, CYCLE_TWO)
                );
            } else {
                token.setBehavior(behaviors[index]);
            }
            _assertOpenRejectedUnchanged(token, subject, vault, CYCLE_ONE, OPERATIONS);
        }
    }

    function test_legacyRecipientAndArbitraryExecutionSelectorsAreAbsent() external {
        (, BoundProcessBudgetHarness subject,) = _deployAndAccrue();
        bytes4[4] memory forbidden = [
            bytes4(keccak256("releaseProcessBudget(bytes32,uint256)")),
            bytes4(keccak256("releaseProcessBudget(bytes32,uint256,address)")),
            bytes4(keccak256("executeExternal(bytes)")),
            bytes4(keccak256("openPegCycle(bytes32,address)"))
        ];
        for (uint256 index; index < forbidden.length; ++index) {
            (bool success,) = address(subject).call(abi.encodePacked(forbidden[index]));
            assert(!success);
        }
    }

    function test_authorizerCannotBecomeRoleSuccessorButOrdinaryHandoversStillOpenFutureCycle()
        external
    {
        (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
            _deployAndAccrue();
        VM.prank(TREASURY);
        (bool treasuryAuthorizer,) =
            address(subject).call(abi.encodeCall(subject.proposeTreasury, address(this)));
        assert(!treasuryAuthorizer);
        VM.prank(OPERATIONS);
        (bool operationsAuthorizer,) =
            address(subject).call(abi.encodeCall(subject.proposeOperations, address(this)));
        assert(!operationsAuthorizer);

        VM.prank(TREASURY);
        subject.proposeTreasury(TREASURY_TWO);
        VM.prank(TREASURY_TWO);
        subject.acceptTreasury();
        VM.prank(OPERATIONS);
        subject.proposeOperations(OPERATIONS_TWO);
        VM.prank(OPERATIONS_TWO);
        subject.acceptOperations();

        _authorize(subject, vault, CYCLE_ONE, 250, OPERATIONS_TWO, 1);
        VM.prank(OPERATIONS_TWO);
        subject.openPegCycle(CYCLE_ONE);
        assert(token.balanceOf(vault.cycleEscrows(CYCLE_ONE)) == 250);
        assert(token.balanceOf(address(vault)) == 0);
        assert(token.balanceOf(OPERATIONS) == 0);
        assert(token.balanceOf(OPERATIONS_TWO) == 0);
    }

    function test_constructorRejectsEoaVaultAndVaultWithZeroAuthorizer() external {
        ProcessUsdg token = new ProcessUsdg();
        bool acceptedEoa;
        try new BoundProcessBudgetHarness(
            token, PROGRAMMABLE, TREASURY, OPERATIONS, IPegCycleVault(address(0xA11CE))
        ) returns (
            BoundProcessBudgetHarness
        ) {
            acceptedEoa = true;
        } catch { }
        assert(!acceptedEoa);

        ZeroAuthorizerVault zeroAuthorizerVault = new ZeroAuthorizerVault();
        bool acceptedZeroAuthorizer;
        try new BoundProcessBudgetHarness(
            token, PROGRAMMABLE, TREASURY, OPERATIONS, IPegCycleVault(address(zeroAuthorizerVault))
        ) returns (
            BoundProcessBudgetHarness
        ) {
            acceptedZeroAuthorizer = true;
        } catch { }
        assert(!acceptedZeroAuthorizer);
    }

    function test_constructorRejectsRouteExecutorAsInitialOperations() external {
        ProcessUsdg token = new ProcessUsdg();
        ProcessRouteExecutor executor = new ProcessRouteExecutor();
        PegCycleVault vault = new PegCycleVault(
            address(token),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        _assertInitialOperationsRejected(token, IPegCycleVault(address(vault)), address(executor));
    }

    function test_constructorRejectsUsdgAsInitialOperations() external {
        ProcessUsdg token = new ProcessUsdg();
        ProcessRouteExecutor executor = new ProcessRouteExecutor();
        PegCycleVault vault = new PegCycleVault(
            address(token),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        _assertInitialOperationsRejected(token, IPegCycleVault(address(vault)), address(token));
    }

    function test_fundedCycleRejectsRouteExecutorAsOperationsSuccessor() external {
        (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
            _deployAndAccrue();
        _authorize(subject, vault, CYCLE_ONE, 250, OPERATIONS, 1);
        VM.prank(OPERATIONS);
        subject.openPegCycle(CYCLE_ONE);
        address routeExecutor = address(vault.routeExecutor());

        VM.prank(OPERATIONS);
        (bool proposed,) =
            address(subject).call(abi.encodeCall(subject.proposeOperations, routeExecutor));
        assert(!proposed);
        (
            ProcessBudget.RoleState memory roles,,
            ProcessBudget.PendingRoleTransfer memory transfer,
        ) = subject.readRoles(CYCLE_ONE);
        assert(roles.operations == OPERATIONS);
        assert(transfer.proposedAccount == address(0));
        assert(vault.readActiveAuthorization().operationsTrigger == OPERATIONS);
        assert(token.balanceOf(routeExecutor) == 0);
    }

    function test_fundedCycleRejectsUsdgAsOperationsSuccessor() external {
        (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
            _deployAndAccrue();
        _authorize(subject, vault, CYCLE_ONE, 250, OPERATIONS, 1);
        VM.prank(OPERATIONS);
        subject.openPegCycle(CYCLE_ONE);

        VM.prank(OPERATIONS);
        (bool proposed,) =
            address(subject).call(abi.encodeCall(subject.proposeOperations, address(token)));
        assert(!proposed);
        (
            ProcessBudget.RoleState memory roles,,
            ProcessBudget.PendingRoleTransfer memory transfer,
        ) = subject.readRoles(CYCLE_ONE);
        assert(roles.operations == OPERATIONS);
        assert(transfer.proposedAccount == address(0));
        assert(vault.readActiveAuthorization().operationsTrigger == OPERATIONS);
    }

    function test_rejectedOpeningDoesNotBlockAccrualOrFeeClaims() external {
        (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault) =
            _deployAndAccrue();
        _authorize(subject, vault, CYCLE_ONE, 251, OPERATIONS, 1);
        _assertOpenRejectedUnchanged(token, subject, vault, CYCLE_ONE, OPERATIONS);
        subject.collectAndAccrue(10_000);
        VM.prank(PROGRAMMABLE);
        subject.claimProgrammable();
        VM.prank(TREASURY);
        subject.claimTreasury();
        assert(token.balanceOf(PROGRAMMABLE) == 20);
        assert(token.balanceOf(TREASURY) == 80);
        assert(subject.processLiability() == 500);
        assert(token.balanceOf(address(vault)) == 0);
        assert(token.balanceOf(OPERATIONS) == 0);
        assert(subject.isSolvent());
    }

    function test_compileOnlyHarnessCannotTransferProcessPrincipalToOperations() external {
        ProcessUsdg token = new ProcessUsdg();
        ProcessBudgetHarness subject =
            new ProcessBudgetHarness(token, PROGRAMMABLE, TREASURY, OPERATIONS);
        subject.collectAndAccrue(10_000);
        VM.prank(OPERATIONS);
        (bool released,) = address(subject)
            .call(abi.encodeWithSignature("releaseProcessBudget(bytes32,uint256)", CYCLE_ONE, 250));
        assert(!released);
        assert(token.balanceOf(OPERATIONS) == 0);
    }

    function _deployAndAccrue()
        private
        returns (ProcessUsdg token, BoundProcessBudgetHarness subject, PegCycleVault vault)
    {
        token = new ProcessUsdg();
        ProcessRouteExecutor executor = new ProcessRouteExecutor();
        vault = new PegCycleVault(
            address(token),
            address(this),
            address(executor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        subject = new BoundProcessBudgetHarness(
            token, PROGRAMMABLE, TREASURY, OPERATIONS, IPegCycleVault(address(vault))
        );
        vault.bindHook(address(subject));
        subject.collectAndAccrue(10_000);
    }

    function _assertInitialOperationsRejected(
        ProcessUsdg token,
        IPegCycleVault vault,
        address operations
    ) private {
        bool accepted;
        try new BoundProcessBudgetHarness(
            token, PROGRAMMABLE, TREASURY, operations, vault
        ) returns (
            BoundProcessBudgetHarness
        ) {
            accepted = true;
        } catch { }
        assert(!accepted);
    }

    function _authorize(
        BoundProcessBudgetHarness subject,
        PegCycleVault vault,
        bytes32 cycleId,
        uint256 amount,
        address operations,
        uint256 nonce
    ) private {
        vault.authorizeFunding(_authorization(subject, vault, cycleId, amount, operations, nonce));
    }

    function _authorization(
        BoundProcessBudgetHarness subject,
        PegCycleVault vault,
        bytes32 cycleId,
        uint256 amount,
        address operations,
        uint256 nonce
    ) private view returns (IPegCycleVault.FundingAuthorization memory) {
        return IPegCycleVault.FundingAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: cycleId,
            hook: address(subject),
            vault: address(vault),
            usdg: vault.usdg(),
            operationsTrigger: operations,
            amount: amount,
            bindingManifestDigest: BINDING_DIGEST,
            outboundActionDigest: OUTBOUND_DIGEST,
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

    function _assertAuthorizationRejected(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization memory authorization
    ) private {
        (bool success,) = address(vault)
            .call(abi.encodeCall(PegCycleVault.authorizeFunding, authorization));
        assert(!success);
    }

    function _assertOpenRejectedUnchanged(
        ProcessUsdg token,
        BoundProcessBudgetHarness subject,
        PegCycleVault vault,
        bytes32 cycleId,
        address caller
    ) private {
        bytes32 beforeDigest = _stateDigest(token, subject, vault, cycleId);
        VM.prank(caller);
        (bool success,) = address(subject).call(abi.encodeCall(ProcessBudget.openPegCycle, cycleId));
        assert(!success);
        assert(_stateDigest(token, subject, vault, cycleId) == beforeDigest);
        assert(token.balanceOf(OPERATIONS) == 0);
    }

    function _stateDigest(
        ProcessUsdg token,
        BoundProcessBudgetHarness subject,
        PegCycleVault vault,
        bytes32 cycleId
    ) private view returns (bytes32) {
        (,,, ProcessBudget.CycleBoundOperations memory cycle) = subject.readRoles(cycleId);
        return keccak256(
            abi.encode(
                token.balanceOf(address(subject)),
                token.balanceOf(address(vault)),
                token.balanceOf(vault.computeCycleEscrow(CYCLE_ONE)),
                token.balanceOf(vault.computeCycleEscrow(CYCLE_TWO)),
                token.balanceOf(OPERATIONS),
                subject.processLiability(),
                subject.totalLiability(),
                subject.readReleasedCycle(cycleId),
                cycle,
                vault.lifecycle(),
                vault.readPendingAuthorization(),
                vault.readActiveAuthorization()
            )
        );
    }
}

contract BoundProcessBudgetHarness is ProcessBudget {
    ProcessUsdg private immutable token;

    constructor(
        ProcessUsdg token_,
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault vault
    ) ProcessBudget(programmable, treasury, operations, vault) {
        token = token_;
    }

    function collectAndAccrue(uint256 quote) external moneyPath {
        (uint256 fee,,,) = _splitLiability(quote);
        uint256 beforeBalance = _hookUsdgBalance();
        token.mint(address(this), fee);
        _accrueAuthenticatedSwap(quote, beforeBalance);
    }

    function claimProgrammable() external returns (uint256) {
        _authorizeProgrammableClaim(msg.sender, msg.sender);
        return _claimProgrammableLiability();
    }

    function claimTreasury() external returns (uint256) {
        _authorizeTreasuryClaim(msg.sender, msg.sender);
        return _claimTreasuryLiability();
    }

    function processLiability() external view returns (uint256) {
        return _processLiability();
    }

    function totalLiability() external view returns (uint256) {
        return _totalLiability();
    }

    function isSolvent() external view returns (bool) {
        return _isSolvent();
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return token.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        (bool success, bytes memory result) =
            address(token).call(abi.encodeCall(ProcessUsdg.transfer, (recipient, amount)));
        if (!success || result.length != 32) return false;
        return abi.decode(result, (bool));
    }
}

contract ZeroAuthorizerVault {
    function authorizer() external pure returns (address) {
        return address(0);
    }

    function routeExecutor() external pure returns (address) {
        return address(0xBEE1);
    }

    function usdg() external pure returns (address) {
        return address(0xBEE2);
    }
}

contract ProcessBudgetHarness is ProcessBudget {
    ProcessUsdg private immutable token;

    constructor(ProcessUsdg token_, address programmable, address treasury, address operations)
        ProcessBudget(
            programmable,
            treasury,
            operations,
            IPegCycleVault(address(new CompileOnlyPegCycleVault(address(0xBEEF))))
        )
    {
        token = token_;
    }

    function collectAndAccrue(uint256 quote) external moneyPath {
        (uint256 fee,,,) = _splitLiability(quote);
        uint256 beforeBalance = _hookUsdgBalance();
        token.mint(address(this), fee);
        _accrueAuthenticatedSwap(quote, beforeBalance);
    }

    function bindCycleForFixture(bytes32 cycleId) external moneyPath {
        _bindCycleOperationsTrigger(cycleId, msg.sender);
    }

    function processLiability() external view returns (uint256) {
        return _processLiability();
    }

    function totalLiability() external view returns (uint256) {
        return _totalLiability();
    }

    function isSolvent() external view returns (bool) {
        return _isSolvent();
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return token.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return token.transfer(recipient, amount);
    }
}

contract ProcessRouteExecutor is IPegCycleRouteExecutor {
    function executeOutbound(bytes32, address, uint256, address, bytes calldata) external { }
}

contract ProcessUsdg {
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
    Behavior private behavior;
    address private reentryTarget;
    bytes private reentryCall;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
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
