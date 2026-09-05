// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { FeeAccountingHarness, MockUsdg, ClaimActor } from "../accounting/FeeAccounting.t.sol";
import { ProcessBudgetHarness, ProcessUsdg } from "../process/ProcessBudget.t.sol";
import { MockPositionManager, Caller } from "../bindings/RobinhoodBindings.t.sol";
import { PermanentPositionCustody } from "../../src/bindings/RobinhoodBindings.sol";
import { MoneyRoles } from "../../src/access/MoneyRoles.sol";
import { PhaseOneReleasePlan } from "../../script/release/PhaseOneReleasePlan.sol";
import { PayoutCommitmentHarness, FundingUsdg } from "../payout/PayoutCommitment.t.sol";
import { PayoutCommitment } from "../../src/payout/PayoutCommitment.sol";
import { IPegCycleRouteExecutor } from "../../src/process/IPegCycleRouteExecutor.sol";
import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface ReleaseVm {
    function envOr(string calldata name, bytes32 defaultValue) external view returns (bytes32 value);
}

contract ReleasePlanRuntimeFixture { }

abstract contract ReleaseInvariantTargeting {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    address[] private targetedContracts;
    FuzzSelector[] private targetedSelectors;

    function targetContract(address target) internal {
        targetedContracts.push(target);
    }

    function targetSelector(FuzzSelector memory selector) internal {
        targetedSelectors.push(selector);
    }

    function targetContracts() public view returns (address[] memory) {
        return targetedContracts;
    }

    function targetSelectors() public view returns (FuzzSelector[] memory) {
        return targetedSelectors;
    }
}

contract PhaseOneReleaseInvariantTest is ReleaseInvariantTargeting {
    struct VaultPlanFixture {
        address usdg;
        address authorizer;
        address routeExecutor;
        address vault;
        bytes32 salt;
        bytes32 initCodeHash;
        bytes32 bindingDigest;
        address distributionSigner;
        address distributionVerifier;
    }

    PhaseOneReleaseInvariantHandler private handler;
    event DeterministicVaultIdentity(
        bytes32 deployer,
        bytes32 salt,
        bytes32 initCodeHash,
        bytes32 concreteRuntimeCodeHash,
        bytes32 vault,
        bytes32 usdg,
        bytes32 authorizer,
        bytes32 routeExecutor,
        bytes32 bindingManifestDigest,
        bytes32 deploymentAuthority,
        bytes32 candidateManifestSha256
    );

    ReleaseVm private constant RELEASE_VM =
        ReleaseVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function setUp() public {
        handler = new PhaseOneReleaseInvariantHandler();

        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = handler.accrue.selector;
        selectors[1] = handler.claimProgrammable.selector;
        selectors[2] = handler.claimTreasury.selector;
        selectors[3] = handler.fundPayout.selector;
        selectors[4] = handler.payPayout.selector;
        selectors[5] = handler.releaseProcess.selector;
        selectors[6] = handler.attemptFailedMoneyTransition.selector;
        selectors[7] = handler.releaseBudget.selector;
        selectors[8] = handler.attemptUnauthorizedOrReplay.selector;
        selectors[9] = handler.attemptCustodyControl.selector;
        selectors[10] = handler.fundProductionPayout.selector;
        selectors[11] = handler.attemptProductionPayoutViolation.selector;
        selectors[12] = handler.attemptPegCycleViolation.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    function invariant_totalLiabilityEqualsEveryKnownLiability() external view {
        require(
            handler.accounting().totalLiability() == handler.aggregateKnownLiability(),
            "aggregate liability diverged"
        );
    }

    function invariant_hookBalanceAlwaysCoversEveryLiability() external view {
        require(
            handler.token().balanceOf(address(handler.accounting()))
                >= handler.accounting().totalLiability(),
            "liabilities exceed custody"
        );
        require(handler.accounting().isSolvent(), "accounting reports insolvency");
        require(handler.budget().isSolvent(), "budget reports insolvency");
    }

    function invariant_failedMoneyTransitionsAlwaysRollBack() external view {
        require(!handler.moneyRollbackViolation(), "failed money path changed state");
    }

    function invariant_onlyBoundOperationsCanReleaseProcessFunds() external view {
        require(!handler.authorityViolation(), "unauthorized release changed state");
    }

    function invariant_cycleAndPayoutReplayCannotMutateState() external view {
        require(!handler.replayViolation(), "replay changed state");
    }

    function invariant_positionCustodyRemainsPermanent() external view {
        require(!handler.custodyViolation(), "custody control escaped");
        require(handler.custody().positionReceived(), "custody was not finalized");
        require(
            handler.positionManager().ownerOf(handler.POSITION_TOKEN_ID())
                == address(handler.custody()),
            "custody lost position"
        );
    }

    function invariant_productionPayoutRecordsConserveFunding() external view {
        require(
            handler.productionPayoutConservationHolds(), "production payout conservation diverged"
        );
        require(handler.payout().isSolvent(), "production payout reports insolvency");
    }

    function invariant_permissionlessPayoutTriggerRemainsAvailable() external view {
        require(!handler.permissionlessPayoutViolation(), "permissionless payout trigger rejected");
    }

    function invariant_operationsNeverReceivesPegCycleUsdG() external view {
        require(
            handler.payoutToken().balanceOf(address(handler)) == 0, "Operations received cycle USDG"
        );
        require(!handler.pegCycleViolation(), "unauthorized peg-cycle transition changed state");
    }

    function test_releasePlanIsReadOnlyAndRejectsAnAccountWithoutRuntimeCode() external {
        PhaseOneReleasePlan releasePlan = new PhaseOneReleasePlan();
        VaultPlanFixture memory vaultFixture = _deployVaultPlanFixture(releasePlan);
        PhaseOneReleasePlan.Plan memory plan = _buildReleasePlan(releasePlan, vaultFixture);

        require(releasePlan.validate(plan) != bytes32(0), "plan digest missing");
        (bytes32 planDigest, bytes32 runtimeSetDigest) = releasePlan.verifyDeployedRuntime(plan);
        require(planDigest != bytes32(0) && runtimeSetDigest != bytes32(0), "runtime proof missing");
        emit DeterministicVaultIdentity(
            bytes32(uint256(uint160(address(this)))),
            vaultFixture.salt,
            vaultFixture.initCodeHash,
            vaultFixture.vault.codehash,
            bytes32(uint256(uint160(vaultFixture.vault))),
            bytes32(uint256(uint160(vaultFixture.usdg))),
            bytes32(uint256(uint160(vaultFixture.authorizer))),
            bytes32(uint256(uint160(vaultFixture.routeExecutor))),
            vaultFixture.bindingDigest,
            bytes32(uint256(uint160(address(this)))),
            plan.candidateManifestSha256
        );

        PhaseOneReleasePlan.Plan memory wrongVaultAddress = _clonePlan(plan);
        wrongVaultAddress.expectedVault = address(0xCAFE);
        (bool wrongVaultAddressAccepted,) =
            address(releasePlan).call(abi.encodeCall(releasePlan.validate, (wrongVaultAddress)));
        require(!wrongVaultAddressAccepted, "wrong vault CREATE2 address accepted");
        PhaseOneReleasePlan.Plan memory overlappingIdentity = _clonePlan(plan);
        overlappingIdentity.operationsTrigger = overlappingIdentity.vaultAuthorizer;
        (bool overlapAccepted,) =
            address(releasePlan).call(abi.encodeCall(releasePlan.validate, (overlappingIdentity)));
        require(!overlapAccepted, "overlapping vault identity accepted");
        PhaseOneReleasePlan.Plan memory inconsistentConstructor = _clonePlan(plan);
        inconsistentConstructor.vaultAuthorizer = address(0x5000);
        (bool inconsistentConstructorAccepted,) = address(releasePlan)
            .call(abi.encodeCall(releasePlan.validate, (inconsistentConstructor)));
        require(
            !inconsistentConstructorAccepted, "inconsistent vault constructor identity accepted"
        );

        PhaseOneReleasePlan.Plan memory wrongRuntime = _clonePlan(plan);
        wrongRuntime.vaultRuntimeCodeHash = keccak256("wrong-runtime");
        (bool wrongRuntimeAccepted,) = address(releasePlan)
            .call(abi.encodeCall(releasePlan.verifyDeployedRuntime, (wrongRuntime)));
        require(!wrongRuntimeAccepted, "wrong runtime accepted");
        PhaseOneReleasePlan.Plan memory emptyRuntime = _clonePlan(plan);
        emptyRuntime.expectedVault = address(0xBEEF);
        emptyRuntime.vaultRuntimeCodeHash = address(0xBEEF).codehash;
        (bool emptyRuntimeAccepted,) = address(releasePlan)
            .call(abi.encodeCall(releasePlan.verifyDeployedRuntime, (emptyRuntime)));
        require(!emptyRuntimeAccepted, "account without runtime accepted");
    }

    function _clonePlan(PhaseOneReleasePlan.Plan memory plan)
        private
        pure
        returns (PhaseOneReleasePlan.Plan memory)
    {
        return abi.decode(abi.encode(plan), (PhaseOneReleasePlan.Plan));
    }

    function _deployVaultPlanFixture(PhaseOneReleasePlan releasePlan)
        private
        returns (VaultPlanFixture memory fixture)
    {
        FundingUsdg vaultUsdg = new FundingUsdg();
        ReleasePayoutAuthorizer vaultAuthorizer = new ReleasePayoutAuthorizer();
        ReleasePayoutRouteExecutor vaultRouteExecutor = new ReleasePayoutRouteExecutor(vaultUsdg);
        bytes32 vaultBindingDigest = keccak256("release plan deterministic vault binding");
        address distributionSigner = PayoutSigning.distributionSignerAddress();
        address distributionVerifier = PayoutSigning.distributionVerifierAddress();
        bytes memory vaultInitCode = abi.encodePacked(
            type(PegCycleVault).creationCode,
            abi.encode(
                address(vaultUsdg),
                address(vaultAuthorizer),
                address(vaultRouteExecutor),
                vaultBindingDigest,
                address(this),
                distributionSigner,
                distributionVerifier
            )
        );
        bytes32 vaultInitCodeHash = keccak256(vaultInitCode);
        bytes32 vaultSalt = keccak256("vault-salt");
        address expectedVault =
            releasePlan.computeCreate2Address(address(this), vaultSalt, vaultInitCodeHash);
        PegCycleVault deployedVault = new PegCycleVault{ salt: vaultSalt }(
            address(vaultUsdg),
            address(vaultAuthorizer),
            address(vaultRouteExecutor),
            vaultBindingDigest,
            address(this),
            distributionSigner,
            distributionVerifier
        );
        require(address(deployedVault) == expectedVault, "vault fixture address mismatch");
        fixture = VaultPlanFixture({
            usdg: address(vaultUsdg),
            authorizer: address(vaultAuthorizer),
            routeExecutor: address(vaultRouteExecutor),
            vault: address(deployedVault),
            salt: vaultSalt,
            initCodeHash: vaultInitCodeHash,
            bindingDigest: vaultBindingDigest,
            distributionSigner: distributionSigner,
            distributionVerifier: distributionVerifier
        });
    }

    function _buildReleasePlan(
        PhaseOneReleasePlan releasePlan,
        VaultPlanFixture memory vaultFixture
    ) private returns (PhaseOneReleasePlan.Plan memory plan) {
        bytes memory initCode = type(ReleasePlanRuntimeFixture).creationCode;
        bytes32 initCodeHash = keccak256(initCode);
        bytes32 salt = keccak256("hook-salt");
        address expectedHook = releasePlan.computeCreate2Address(address(this), salt, initCodeHash);
        ReleasePlanRuntimeFixture deployedHook = new ReleasePlanRuntimeFixture{ salt: salt }();
        require(address(deployedHook) == expectedHook, "fixture address mismatch");
        plan = PhaseOneReleasePlan.Plan({
            chainId: block.chainid,
            usdg: vaultFixture.usdg,
            programmable: address(0x2000),
            treasury: address(0x3000),
            operationsTrigger: address(0x4000),
            positionManager: address(handler.positionManager()),
            vaultDeployer: address(this),
            vaultSalt: vaultFixture.salt,
            vaultInitCodeHash: vaultFixture.initCodeHash,
            expectedVault: vaultFixture.vault,
            vaultUsdg: vaultFixture.usdg,
            vaultAuthorizer: vaultFixture.authorizer,
            vaultRouteExecutor: vaultFixture.routeExecutor,
            vaultBindingManifestDigest: vaultFixture.bindingDigest,
            vaultDeploymentAuthority: address(this),
            vaultDistributionSigner: vaultFixture.distributionSigner,
            vaultDistributionVerifier: vaultFixture.distributionVerifier,
            hookDeployer: address(this),
            hookSalt: salt,
            hookInitCodeHash: initCodeHash,
            expectedHook: expectedHook,
            usdgRuntimeCodeHash: vaultFixture.usdg.codehash,
            positionManagerRuntimeCodeHash: address(handler.positionManager()).codehash,
            vaultRuntimeCodeHash: vaultFixture.vault.codehash,
            hookRuntimeCodeHash: expectedHook.codehash,
            candidateManifestSha256: RELEASE_VM.envOr(
                "HOOKEMON_CANDIDATE_MANIFEST_SHA256",
                keccak256("LOCAL_STANDALONE_UNBOUND_CANDIDATE")
            )
        });
    }
}

contract PhaseOneReleaseInvariantHandler {
    uint256 private constant MAX_QUOTE = 1_000_000_000_000;
    uint256 private constant MIN_POSITIVE_FEE_QUOTE = 34;
    uint256 private constant PAYOUT_COUNT = 4;
    uint256 private constant TREASURY_COUNT = 4;
    bytes32 private constant PAYOUT_BINDING_DIGEST =
        keccak256("release invariant binding manifest");
    bytes32 private constant PAYOUT_ROUTE_MARKER = keccak256("release invariant typed route");
    uint256 public constant POSITION_TOKEN_ID = 7;

    MockUsdg public immutable token;
    FeeAccountingHarness public immutable accounting;
    ClaimActor public immutable programmable;
    ClaimActor public immutable processRecipient;
    ClaimActor[PAYOUT_COUNT] private holders;
    ClaimActor[TREASURY_COUNT] private treasuries;

    ProcessUsdg public immutable budgetToken;
    ProcessBudgetHarness public immutable budget;
    Caller public immutable stranger;
    MockPositionManager public immutable positionManager;
    PermanentPositionCustody public immutable custody;
    FundingUsdg public immutable payoutToken;
    PayoutCommitmentHarness public immutable payout;
    PegCycleVault public immutable payoutVault;
    ReleasePayoutAuthorizer public immutable payoutAuthorizer;
    ReleasePayoutRouteExecutor public immutable payoutRouteExecutor;
    uint256 private payoutProcessRemaining = 250;

    bool public moneyRollbackViolation;
    bool public authorityViolation;
    bool public replayViolation;
    bool public custodyViolation;
    bool public permissionlessPayoutViolation;
    bool public pegCycleViolation;

    constructor() {
        token = new MockUsdg();
        programmable = new ClaimActor();
        processRecipient = new ClaimActor();
        for (uint256 i; i < TREASURY_COUNT; ++i) {
            treasuries[i] = new ClaimActor();
        }
        for (uint256 i; i < PAYOUT_COUNT; ++i) {
            holders[i] = new ClaimActor();
        }
        accounting = new FeeAccountingHarness(token, address(programmable), address(treasuries[0]));

        budgetToken = new ProcessUsdg();
        budget = new ProcessBudgetHarness(
            budgetToken, address(programmable), address(treasuries[0]), address(this)
        );
        budget.collectAndAccrue(10_000);
        stranger = new Caller();

        payoutToken = new FundingUsdg();
        payoutAuthorizer = new ReleasePayoutAuthorizer();
        payoutRouteExecutor = new ReleasePayoutRouteExecutor(payoutToken);
        payoutVault = new PegCycleVault(
            address(payoutToken),
            address(payoutAuthorizer),
            address(payoutRouteExecutor),
            PAYOUT_BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        payout = new PayoutCommitmentHarness(
            payoutToken, address(programmable), address(treasuries[0]), address(this), payoutVault
        );
        payoutVault.bindHook(address(payout));
        payout.collectAndAccrue(10_000);

        positionManager = new MockPositionManager();
        custody = new PermanentPositionCustody(address(positionManager), POSITION_TOKEN_ID);
        positionManager.mint(address(custody), POSITION_TOKEN_ID, 900_000);
        custody.finalizePosition();
    }

    function accrue(uint96 rawQuote, uint8 rawTreasury) external {
        uint256 quote = uint256(rawQuote) % MAX_QUOTE + MIN_POSITIVE_FEE_QUOTE;
        accounting.rotateTreasury(address(treasuries[rawTreasury % TREASURY_COUNT]));
        accounting.collectAndAccrue(quote);
    }

    function claimProgrammable() external {
        (bool success,) =
            address(programmable).call(abi.encodeCall(ClaimActor.claimProgrammable, (accounting)));
        if (!success) return;
    }

    function claimTreasury(uint8 rawTreasury) external {
        ClaimActor treasury = treasuries[rawTreasury % TREASURY_COUNT];
        (bool success,) =
            address(treasury).call(abi.encodeCall(ClaimActor.claimTreasury, (accounting)));
        if (!success) return;
    }

    function fundPayout(uint8 rawPayout, uint96 rawAmount) external {
        uint256 available = accounting.processLiability();
        if (available == 0) return;
        accounting.fundPayout(_payoutId(rawPayout), uint256(rawAmount) % available + 1);
    }

    function payPayout(uint8 rawPayout, uint96 rawAmount) external {
        uint256 payoutIndex = rawPayout % PAYOUT_COUNT;
        bytes32 payoutId = _payoutId(payoutIndex);
        uint256 available = accounting.payoutLiability(payoutId);
        if (available == 0) return;
        accounting.payPayout(
            payoutId, address(holders[payoutIndex]), uint256(rawAmount) % available + 1
        );
    }

    function releaseProcess(uint96 rawAmount) external {
        uint256 available = accounting.processLiability();
        if (available == 0) return;
        accounting.releaseProcess(address(processRecipient), uint256(rawAmount) % available + 1);
    }

    function attemptFailedMoneyTransition(uint8 rawPath, uint8 rawBehavior, uint96 rawAmount)
        external
    {
        uint256 path = rawPath % 3;
        bytes32 payoutId = _payoutId(rawPath);
        address recipient;
        bytes memory callData;
        address callTarget;

        if (path == 0) {
            if (accounting.programmableLiability(address(programmable)) == 0) {
                accounting.collectAndAccrue(10_000);
            }
            recipient = address(programmable);
            callTarget = address(programmable);
            callData = abi.encodeCall(ClaimActor.claimProgrammable, (accounting));
        } else if (path == 1) {
            if (accounting.processLiability() == 0) accounting.collectAndAccrue(10_000);
            uint256 amount = uint256(rawAmount) % accounting.processLiability() + 1;
            recipient = address(processRecipient);
            callTarget = address(accounting);
            callData = abi.encodeCall(
                FeeAccountingHarness.releaseProcess, (address(processRecipient), amount)
            );
        } else {
            uint256 available = accounting.payoutLiability(payoutId);
            if (available == 0) {
                if (accounting.processLiability() == 0) accounting.collectAndAccrue(10_000);
                available = accounting.processLiability();
                accounting.fundPayout(payoutId, available);
            }
            uint256 payoutIndex = rawPath % PAYOUT_COUNT;
            recipient = address(holders[payoutIndex]);
            callTarget = address(accounting);
            callData = abi.encodeCall(
                FeeAccountingHarness.payPayout,
                (payoutId, recipient, uint256(rawAmount) % available + 1)
            );
        }

        MockUsdg.Behavior behavior = MockUsdg.Behavior(rawBehavior % 8 + 1);
        if (behavior == MockUsdg.Behavior.Reenter) token.configureReentry(callTarget, callData);
        else token.setBehavior(behavior);
        bytes32 beforeDigest = _moneyDigest(recipient);
        (bool success,) = callTarget.call(callData);
        if (success || _moneyDigest(recipient) != beforeDigest) moneyRollbackViolation = true;
        token.setBehavior(MockUsdg.Behavior.Normal);
    }

    function releaseBudget(uint8 rawCycle, uint96) external {
        bytes32 cycleId = _cycleId(rawCycle);
        (,,, MoneyRoles.CycleBoundOperations memory cycle) = budget.readRoles(cycleId);
        uint256 available = budget.processLiability();
        if (cycle.operations != address(0) || available == 0) return;
        budget.bindCycleForFixture(cycleId);
    }

    function attemptUnauthorizedOrReplay(uint8 rawPath, uint8 rawCycle) external {
        bytes32 cycleId = _cycleId(rawCycle);
        if (rawPath % 2 == 0) {
            bytes32 unauthorizedBeforeDigest = _budgetDigest(cycleId);
            bool unauthorizedSuccess = stranger.callTarget(
                address(budget), abi.encodeCall(budget.bindCycleForFixture, (cycleId))
            );
            if (unauthorizedSuccess || _budgetDigest(cycleId) != unauthorizedBeforeDigest) {
                authorityViolation = true;
            }
            return;
        }

        (,,, MoneyRoles.CycleBoundOperations memory cycle) = budget.readRoles(cycleId);
        uint256 available = budget.processLiability();
        if (cycle.operations == address(0)) {
            if (available == 0) return;
            budget.bindCycleForFixture(cycleId);
        }
        bytes32 replayBeforeDigest = _budgetDigest(cycleId);
        (bool replaySuccess,) =
            address(budget).call(abi.encodeCall(budget.bindCycleForFixture, (cycleId)));
        if (replaySuccess || _budgetDigest(cycleId) != replayBeforeDigest) replayViolation = true;
    }

    function attemptCustodyControl(uint8 rawPath) external {
        bytes memory callData;
        if (rawPath % 3 == 0) {
            callData = abi.encodeCall(
                positionManager.transferFrom,
                (address(custody), address(stranger), POSITION_TOKEN_ID)
            );
        } else if (rawPath % 3 == 1) {
            callData =
                abi.encodeCall(positionManager.approve, (address(stranger), POSITION_TOKEN_ID));
        } else {
            callData = abi.encodeCall(positionManager.decreaseLiquidity, (POSITION_TOKEN_ID, 1));
        }
        bool success = stranger.callTarget(address(positionManager), callData);
        if (
            success || positionManager.ownerOf(POSITION_TOKEN_ID) != address(custody)
                || positionManager.liquidity(POSITION_TOKEN_ID) != 900_000
        ) custodyViolation = true;
    }

    function fundProductionPayout(uint8 rawPayout, uint96 rawAmount) external {
        bytes32 payoutId = _productionPayoutId(rawPayout);
        if (payout.readPayout(payoutId).payoutId != bytes32(0)) return;
        uint256 amount = uint256(rawAmount) % 200 + 1;
        if (amount > payoutProcessRemaining) amount = payoutProcessRemaining;
        if (!_stageProductionPayout(payoutId, amount)) return;
        (bool success,) = address(payout)
            .call(
                abi.encodeCall(
                    payout.fundPayoutFromPegCycle, (_productionPayoutAuth(payoutId, amount))
                )
            );
        if (!success) permissionlessPayoutViolation = true;
    }

    function attemptProductionPayoutViolation(uint8 rawPath, uint8 rawPayout) external {
        bytes32 payoutId = _productionPayoutId(rawPayout);
        if (rawPath % 2 == 0) {
            if (payout.readPayout(payoutId).payoutId != bytes32(0)) return;
            if (!_stageProductionPayout(payoutId, 1)) return;
            bool permissionlessSuccess = stranger.callTarget(
                address(payout),
                abi.encodeCall(payout.fundPayoutFromPegCycle, (_productionPayoutAuth(payoutId, 1)))
            );
            if (!permissionlessSuccess || payout.readPayout(payoutId).payoutId != payoutId) {
                permissionlessPayoutViolation = true;
            }
            return;
        }

        if (payout.readPayout(payoutId).payoutId == bytes32(0)) {
            if (!_stageProductionPayout(payoutId, 1)) return;
            (bool funded,) = address(payout)
                .call(
                    abi.encodeCall(
                        payout.fundPayoutFromPegCycle, (_productionPayoutAuth(payoutId, 1))
                    )
                );
            if (!funded) {
                permissionlessPayoutViolation = true;
                return;
            }
        }
        bytes32 replayBeforeDigest = _productionPayoutDigest(payoutId);
        (bool replaySuccess,) = address(payout)
            .call(
                abi.encodeCall(payout.fundPayoutFromPegCycle, (_productionPayoutAuth(payoutId, 1)))
            );
        if (replaySuccess || _productionPayoutDigest(payoutId) != replayBeforeDigest) {
            replayViolation = true;
        }
    }

    function attemptPegCycleViolation(uint8 rawPath, uint8 rawPayout) external {
        bytes32 payoutId = _productionPayoutId(rawPayout);
        bytes32 cycleId = _productionCycleId(payoutId);
        uint256 amount = 1;
        bytes32 beforeDigest = _productionVaultDigest(cycleId, payoutId);
        bool success;
        if (rawPath % 6 == 0) {
            (success,) = address(payoutVault)
                .call(
                    abi.encodeCall(
                        PegCycleVault.authorizeFunding, (_productionFundingAuth(payoutId, amount))
                    )
                );
        } else if (rawPath % 6 == 1) {
            (success,) = address(payoutVault)
                .call(
                    abi.encodeCall(
                        PegCycleVault.authorizePayout,
                        (_productionPayoutAuth(payoutId, amount), bytes(""), bytes(""))
                    )
                );
        } else if (rawPath % 6 == 2) {
            (success,) = address(payout).call(abi.encodeCall(payout.openPegCycle, (cycleId)));
        } else if (rawPath % 6 == 3) {
            (success,) = address(payoutVault)
                .call(
                    abi.encodeCall(PegCycleVault.executeOutbound, (cycleId, bytes("wrong route")))
                );
        } else if (rawPath % 6 == 4) {
            (success,) = address(payout)
                .call(abi.encodeWithSignature("fundPayout(bytes32,uint256)", payoutId, amount));
        } else {
            (success,) = address(payoutVault)
                .call(abi.encodeWithSignature("execute(address,bytes)", address(payout), bytes("")));
        }
        if (success || _productionVaultDigest(cycleId, payoutId) != beforeDigest) {
            pegCycleViolation = true;
        }
    }

    function productionPayoutConservationHolds() public view returns (bool) {
        uint256 aggregateUnpaid;
        for (uint256 i; i < PAYOUT_COUNT; ++i) {
            PayoutCommitment.PayoutRecord memory record = payout.readPayout(_productionPayoutId(i));
            if (record.payoutId == bytes32(0)) continue;
            if (record.rootSum != record.paidTotal + record.unpaidTotal) return false;
            (bytes32 authDigest, bytes32 committedPayoutId, bytes32 receiptDigest) =
                payoutVault.readCommittedPayoutBinding(record.cycleId);
            if (
                authDigest
                        != keccak256(
                            abi.encode(_productionPayoutAuth(record.payoutId, record.rootSum))
                        ) || committedPayoutId != record.payoutId
                    || receiptDigest != _productionReturnReceiptDigest(record.payoutId)
            ) return false;
            aggregateUnpaid += record.unpaidTotal;
        }
        return aggregateUnpaid == payout.totalPayoutLiability();
    }

    function aggregateKnownLiability() public view returns (uint256 total) {
        total = accounting.programmableLiability(address(programmable));
        for (uint256 i; i < TREASURY_COUNT; ++i) {
            total += accounting.treasuryLiability(address(treasuries[i]));
        }
        total += accounting.processLiability();
        for (uint256 i; i < PAYOUT_COUNT; ++i) {
            total += accounting.payoutLiability(_payoutId(i));
        }
    }

    function _moneyDigest(address recipient) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                token.balanceOf(address(accounting)),
                token.balanceOf(recipient),
                aggregateKnownLiability(),
                accounting.totalLiability()
            )
        );
    }

    function _budgetDigest(bytes32 cycleId) private view returns (bytes32) {
        (,,, MoneyRoles.CycleBoundOperations memory cycle) = budget.readRoles(cycleId);
        return keccak256(
            abi.encode(
                budgetToken.balanceOf(address(budget)),
                budgetToken.balanceOf(address(this)),
                budget.processLiability(),
                budget.totalLiability(),
                budget.readReleasedCycle(cycleId),
                cycle
            )
        );
    }

    function _productionPayoutDigest(bytes32 payoutId) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                payoutToken.balanceOf(address(this)),
                payoutToken.balanceOf(address(payout)),
                payout.totalPayoutLiability(),
                payout.totalLiability(),
                payout.readPayout(payoutId)
            )
        );
    }

    function _productionPayoutAuth(bytes32 payoutId, uint256 amount)
        private
        view
        returns (IPegCycleVault.PayoutAuthorization memory)
    {
        return IPegCycleVault.PayoutAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: _productionCycleId(payoutId),
            hook: address(payout),
            vault: address(payout.pegCycleVault()),
            usdg: address(payoutToken),
            operationsTrigger: address(this),
            bindingManifestDigest: PAYOUT_BINDING_DIGEST,
            payoutId: payoutId,
            manifestDigest: keccak256(abi.encode("manifest", payoutId)),
            rootHash: keccak256(abi.encode("root", payoutId)),
            rootSum: amount,
            returnActionDigest: _productionReturnActionDigest(payoutId),
            returnReceiptDigest: _productionReturnReceiptDigest(payoutId),
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: _productionNonce("payout", payoutId)
        });
    }

    function _stageProductionPayout(bytes32 payoutId, uint256 amount) private returns (bool) {
        if (amount == 0 || payoutProcessRemaining == 0) return false;
        if (amount > payoutProcessRemaining) amount = payoutProcessRemaining;
        bytes32 cycleId = _productionCycleId(payoutId);
        bytes memory routeData = _productionRouteData(cycleId, amount);
        payoutAuthorizer.authorizeFunding(payoutVault, _productionFundingAuth(payoutId, amount));
        payout.openPegCycle(cycleId);
        payoutVault.executeOutbound(cycleId, routeData);
        payoutRouteExecutor.returnExact(cycleId);
        {
            IPegCycleVault.PayoutAuthorization memory productionAuth =
                _productionPayoutAuth(payoutId, amount);
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(payoutVault)), productionAuth
            );
            payoutAuthorizer.authorizePayout(
                payoutVault, productionAuth, distributionSignature, verifierSignature
            );
        }
        payoutProcessRemaining -= amount;
        return true;
    }

    function _productionFundingAuth(bytes32 payoutId, uint256 amount)
        private
        view
        returns (IPegCycleVault.FundingAuthorization memory)
    {
        bytes32 cycleId = _productionCycleId(payoutId);
        return IPegCycleVault.FundingAuthorization({
            requirementsRevision: 57,
            chainId: block.chainid,
            cycleId: cycleId,
            hook: address(payout),
            vault: address(payoutVault),
            usdg: address(payoutToken),
            operationsTrigger: address(this),
            amount: amount,
            bindingManifestDigest: PAYOUT_BINDING_DIGEST,
            outboundActionDigest: keccak256(_productionRouteData(cycleId, amount)),
            returnActionDigest: _productionReturnActionDigest(payoutId),
            returnDestination: payoutVault.computeCycleEscrow(cycleId),
            minimumRobinhoodReceive: 1,
            minimumSolanaReceive: 1,
            minimumReturnUsdg: amount,
            robinhoodNativeGasCap: 1,
            solanaNativeGasCap: 1,
            expiresAt: uint64(block.timestamp + 1 days),
            nonce: _productionNonce("funding", payoutId)
        });
    }

    function _payoutId(uint256 rawPayout) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("release-invariant-payout", rawPayout % PAYOUT_COUNT));
    }

    function _cycleId(uint256 rawCycle) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("release-invariant-cycle", rawCycle % 4));
    }

    function _productionPayoutId(uint256 rawPayout) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("production-payout", rawPayout % PAYOUT_COUNT));
    }

    function _productionCycleId(bytes32 payoutId) private pure returns (bytes32) {
        return keccak256(abi.encode("production-cycle", payoutId));
    }

    function _productionRouteData(bytes32 cycleId, uint256 amount)
        private
        pure
        returns (bytes memory)
    {
        return abi.encode(PAYOUT_ROUTE_MARKER, cycleId, amount);
    }

    function _productionReturnActionDigest(bytes32 payoutId) private pure returns (bytes32) {
        return keccak256(abi.encode("fixture return action", payoutId));
    }

    function _productionReturnReceiptDigest(bytes32 payoutId) private pure returns (bytes32) {
        return keccak256(abi.encode("fixture return receipt", payoutId));
    }

    function _productionNonce(string memory domain, bytes32 payoutId)
        private
        pure
        returns (uint256 nonce)
    {
        nonce = uint256(keccak256(abi.encode(domain, payoutId)));
        if (nonce == 0) nonce = 1;
    }

    function _productionVaultDigest(bytes32 cycleId, bytes32 payoutId)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256(
                    abi.encode(
                        payoutToken.balanceOf(address(this)),
                        payoutToken.balanceOf(address(payout)),
                        payoutToken.balanceOf(address(payoutVault)),
                        payoutToken.balanceOf(payoutVault.computeCycleEscrow(cycleId)),
                        payoutToken.balanceOf(address(payoutRouteExecutor))
                    )
                ),
                keccak256(
                    abi.encode(
                        payout.totalLiability(),
                        payout.totalPayoutLiability(),
                        payout.readPayout(payoutId)
                    )
                ),
                payoutVault.lifecycle(),
                keccak256(
                    abi.encode(
                        payoutVault.readPendingAuthorization(),
                        payoutVault.readActiveAuthorization()
                    )
                ),
                _productionReplayDigest(cycleId, payoutId)
            )
        );
    }

    function _productionReplayDigest(bytes32 cycleId, bytes32 payoutId)
        private
        view
        returns (bytes32)
    {
        (bytes32 authorizationDigest, bytes32 committedPayoutId, bytes32 receiptDigest) =
            payoutVault.readCommittedPayoutBinding(cycleId);
        return keccak256(
            abi.encode(
                authorizationDigest,
                committedPayoutId,
                receiptDigest,
                payoutVault.isPayoutIdConsumed(payoutId),
                payoutVault.isReturnReceiptDigestConsumed(_productionReturnReceiptDigest(payoutId))
            )
        );
    }
}

contract ReleasePayoutAuthorizer {
    function authorizeFunding(
        PegCycleVault vault,
        IPegCycleVault.FundingAuthorization calldata authorization
    ) external {
        vault.authorizeFunding(authorization);
    }

    function authorizePayout(
        PegCycleVault vault,
        IPegCycleVault.PayoutAuthorization calldata authorization,
        bytes calldata distributionSignature,
        bytes calldata verifierSignature
    ) external {
        vault.authorizePayout(authorization, distributionSignature, verifierSignature);
    }
}

contract ReleasePayoutRouteExecutor is IPegCycleRouteExecutor {
    FundingUsdg private immutable token;
    mapping(bytes32 cycleId => address destination) private destinations;
    mapping(bytes32 cycleId => uint256 amount) private amounts;

    constructor(FundingUsdg token_) {
        token = token_;
    }

    function executeOutbound(
        bytes32 cycleId,
        address usdg,
        uint256 amount,
        address returnDestination,
        bytes calldata routeData
    ) external {
        (bytes32 marker, bytes32 routeCycleId, uint256 routeAmount) =
            abi.decode(routeData, (bytes32, bytes32, uint256));
        require(
            msg.sender != returnDestination && usdg == address(token)
                && marker == keccak256("release invariant typed route") && routeCycleId == cycleId
                && routeAmount == amount && token.balanceOf(address(this)) == amount
        );
        destinations[cycleId] = returnDestination;
        amounts[cycleId] = amount;
    }

    function returnExact(bytes32 cycleId) external {
        address destination = destinations[cycleId];
        uint256 amount = amounts[cycleId];
        require(destination != address(0) && amount != 0);
        delete destinations[cycleId];
        delete amounts[cycleId];
        require(token.transfer(destination, amount));
    }
}
