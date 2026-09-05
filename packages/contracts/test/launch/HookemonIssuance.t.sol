// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { HookemonIssuance } from "../../src/launch/HookemonIssuance.sol";

interface Vm {
    function prank(address caller) external;
}

contract HookemonIssuanceHarness is HookemonIssuance {
    constructor(
        address authority,
        uint8 expectedDecimals,
        bytes32 bindingDigest,
        bytes32 runtimeDigest
    ) HookemonIssuance(authority, expectedDecimals, bindingDigest, runtimeDigest) { }
}

contract HookemonIssuanceTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant AUTHORITY = address(0xA11CE);
    address private constant UNAUTHORIZED = address(0xBAD);
    address private constant TOKEN = address(0x7000);
    address private constant MARKET = address(0x7100);
    address private constant REMAINDER = address(0x7200);
    address private constant CUSTODY = address(0x7300);
    address private constant PROJECT = address(0x7400);
    bytes32 private constant BINDING_DIGEST = keccak256("provider binding pending fixture");
    bytes32 private constant RUNTIME_DIGEST = keccak256("runtime authority pending fixture");
    bytes32 private constant PROVIDER_CALL_DIGEST = keccak256("provider call plan fixture");
    bytes32 private constant REMAINDER_DIGEST = keccak256("non-project remainder fixture");
    bytes32 private constant CUSTODY_DIGEST = keccak256("permanent custody fixture");

    function test_preparesAndVerifiesOneExactGuardObservation() external {
        HookemonIssuanceHarness subject = _deploy();
        HookemonIssuance.IssuancePlan memory plan = _plan();
        bytes32 planDigest = _prepare(subject, plan);
        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);
        HookemonIssuance.TransferRecord[] memory trace = _trace();

        VM.prank(AUTHORITY);
        subject.verifyIssuance(plan, observation, trace);

        HookemonIssuance.IssuanceGuardState memory state = subject.readTokenState();
        assert(
            state.status
                == HookemonIssuance.GuardStatus.OBSERVATION_VERIFIED_PROVIDER_BINDING_PENDING
        );
        assert(state.preparedPlanDigest == planDigest);
        assert(state.token == TOKEN);
        assert(state.observationDigest != bytes32(0));
    }

    function test_acceptsSeparatelyBoundCanonicalDecimals() external {
        HookemonIssuanceHarness subject =
            new HookemonIssuanceHarness(AUTHORITY, 6, BINDING_DIGEST, RUNTIME_DIGEST);
        HookemonIssuance.IssuancePlan memory plan = _plan();
        plan.decimals = 6;
        plan.totalSupply = 420_690_000_000 * 1e6;
        plan.marketAllocation = 378_621_000_000 * 1e6;
        plan.remainderAllocation = plan.totalSupply - plan.marketAllocation;
        bytes32 planDigest = _prepare(subject, plan);
        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);
        observation.decimals = plan.decimals;
        observation.totalSupply = plan.totalSupply;
        observation.canonicalMarketBalance = plan.marketAllocation;
        observation.remainderBalance = plan.remainderAllocation;
        HookemonIssuance.TransferRecord[] memory trace = _trace();
        trace[0].amount = plan.marketAllocation;
        trace[1].amount = plan.remainderAllocation;

        VM.prank(AUTHORITY);
        subject.verifyIssuance(plan, observation, trace);

        assert(
            subject.readTokenState().status
                == HookemonIssuance.GuardStatus.OBSERVATION_VERIFIED_PROVIDER_BINDING_PENDING
        );
    }

    function test_rejectsUnauthorizedPrepareAndVerifyWithoutMutation() external {
        HookemonIssuanceHarness subject = _deploy();
        HookemonIssuance.IssuancePlan memory plan = _plan();

        VM.prank(UNAUTHORIZED);
        (bool prepared,) =
            address(subject).call(abi.encodeCall(HookemonIssuance.prepareOfficialIssuance, (plan)));
        assert(!prepared);
        assert(subject.readTokenState().status == HookemonIssuance.GuardStatus.UNPREPARED);

        bytes32 planDigest = _prepare(subject, plan);
        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);
        VM.prank(UNAUTHORIZED);
        (bool verified,) = address(subject)
            .call(abi.encodeCall(HookemonIssuance.verifyIssuance, (plan, observation, _trace())));
        assert(!verified);
        HookemonIssuance.IssuanceGuardState memory state = subject.readTokenState();
        assert(state.status == HookemonIssuance.GuardStatus.PREPARED_PROVIDER_CALL_UNAVAILABLE);
        assert(state.observationDigest == bytes32(0));
    }

    function test_rejectsDuplicatePreparationAndVerification() external {
        HookemonIssuanceHarness subject = _deploy();
        HookemonIssuance.IssuancePlan memory plan = _plan();
        bytes32 planDigest = _prepare(subject, plan);

        VM.prank(AUTHORITY);
        (bool preparedAgain,) =
            address(subject).call(abi.encodeCall(HookemonIssuance.prepareOfficialIssuance, (plan)));
        assert(!preparedAgain);

        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);
        VM.prank(AUTHORITY);
        subject.verifyIssuance(plan, observation, _trace());
        bytes32 observationDigest = subject.readTokenState().observationDigest;

        VM.prank(AUTHORITY);
        (bool verifiedAgain,) = address(subject)
            .call(abi.encodeCall(HookemonIssuance.verifyIssuance, (plan, observation, _trace())));
        assert(!verifiedAgain);
        assert(subject.readTokenState().observationDigest == observationDigest);
    }

    function test_rejectsWrongDecimalsSupplyAndAllocationPlans() external {
        _assertPlanRejected(_mutateDecimals(_plan(), 17));

        HookemonIssuance.IssuancePlan memory plan = _plan();
        plan.totalSupply += 1;
        _assertPlanRejected(plan);

        plan = _plan();
        plan.marketAllocation -= 1;
        plan.remainderAllocation += 1;
        _assertPlanRejected(plan);

        plan = _plan();
        plan.otherAllocation = 1;
        _assertPlanRejected(plan);
    }

    function test_rejectsZeroOverlappingAndProjectControlledDestinations() external {
        HookemonIssuance.IssuancePlan memory plan = _plan();
        plan.canonicalMarket = address(0);
        _assertPlanRejected(plan);

        plan = _plan();
        plan.remainderRepresentation = plan.canonicalMarket;
        _assertPlanRejected(plan);

        plan = _plan();
        plan.marketPositionCustody = plan.projectWallet;
        _assertPlanRejected(plan);

        plan = _plan();
        plan.issuanceSource = plan.projectWallet;
        _assertPlanRejected(plan);
    }

    function test_rejectsZeroStaleOrMismatchedEvidence() external {
        HookemonIssuance.IssuancePlan memory plan = _plan();
        plan.bindingManifestDigest = bytes32(0);
        _assertPlanRejected(plan);

        plan = _plan();
        plan.runtimeAuthorityDigest = keccak256("stale runtime");
        _assertPlanRejected(plan);

        HookemonIssuanceHarness subject = _deploy();
        plan = _plan();
        bytes32 planDigest = _prepare(subject, plan);
        HookemonIssuance.IssuancePlan memory changedPlan = plan;
        changedPlan.providerCallDigest = keccak256("changed provider call");
        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);
        _assertObservationRejected(subject, changedPlan, observation, _trace());

        observation.custodyCommitment = keccak256("different custody");
        _assertObservationRejected(subject, plan, observation, _trace());
    }

    function test_rejectsObservationIdentityBalancesAndAdditionalAllocation() external {
        HookemonIssuanceHarness subject = _deploy();
        HookemonIssuance.IssuancePlan memory plan = _plan();
        bytes32 planDigest = _prepare(subject, plan);
        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);
        observation.symbolHash = keccak256("OTHER");
        _assertObservationRejected(subject, plan, observation, _trace());

        observation = _observation(planDigest);
        observation.canonicalMarketBalance -= 1;
        _assertObservationRejected(subject, plan, observation, _trace());

        observation = _observation(planDigest);
        observation.otherAllocation = 1;
        _assertObservationRejected(subject, plan, observation, _trace());
    }

    function test_rejectsIndirectProjectOrAdditionalIssuanceTrace() external {
        HookemonIssuanceHarness subject = _deploy();
        HookemonIssuance.IssuancePlan memory plan = _plan();
        bytes32 planDigest = _prepare(subject, plan);
        HookemonIssuance.IssuanceObservation memory observation = _observation(planDigest);

        HookemonIssuance.TransferRecord[] memory trace = _trace();
        trace[0].from = PROJECT;
        _assertObservationRejected(subject, plan, observation, trace);

        trace = new HookemonIssuance.TransferRecord[](3);
        trace[0] = HookemonIssuance.TransferRecord(address(0), MARKET, plan.marketAllocation);
        trace[1] = HookemonIssuance.TransferRecord(address(0), REMAINDER, plan.remainderAllocation);
        trace[2] = HookemonIssuance.TransferRecord(address(0), address(0x9999), 1);
        _assertObservationRejected(subject, plan, observation, trace);
    }

    function test_constructorRejectsMissingAuthorityOrEvidence() external {
        assert(!_canDeploy(address(0), 18, BINDING_DIGEST, RUNTIME_DIGEST));
        assert(!_canDeploy(AUTHORITY, 18, bytes32(0), RUNTIME_DIGEST));
        assert(!_canDeploy(AUTHORITY, 18, BINDING_DIGEST, bytes32(0)));
        assert(!_canDeploy(AUTHORITY, type(uint8).max, BINDING_DIGEST, RUNTIME_DIGEST));
    }

    function _deploy() private returns (HookemonIssuanceHarness) {
        return new HookemonIssuanceHarness(AUTHORITY, 18, BINDING_DIGEST, RUNTIME_DIGEST);
    }

    function _plan() private pure returns (HookemonIssuance.IssuancePlan memory plan) {
        uint256 supply = 420_690_000_000 * 1e18;
        uint256 marketAllocation = 378_621_000_000 * 1e18;
        plan = HookemonIssuance.IssuancePlan({
            decimals: 18,
            issuanceSource: address(0),
            canonicalMarket: MARKET,
            remainderRepresentation: REMAINDER,
            marketPositionCustody: CUSTODY,
            projectWallet: PROJECT,
            totalSupply: supply,
            marketAllocation: marketAllocation,
            remainderAllocation: supply - marketAllocation,
            otherAllocation: 0,
            bindingManifestDigest: BINDING_DIGEST,
            runtimeAuthorityDigest: RUNTIME_DIGEST,
            providerCallDigest: PROVIDER_CALL_DIGEST,
            remainderTreatmentDigest: REMAINDER_DIGEST,
            custodyCommitment: CUSTODY_DIGEST
        });
    }

    function _observation(bytes32 planDigest)
        private
        pure
        returns (HookemonIssuance.IssuanceObservation memory observation)
    {
        HookemonIssuance.IssuancePlan memory plan = _plan();
        observation = HookemonIssuance.IssuanceObservation({
            planDigest: planDigest,
            token: TOKEN,
            nameHash: keccak256("Hookemon"),
            symbolHash: keccak256("HKMN"),
            decimals: plan.decimals,
            totalSupply: plan.totalSupply,
            canonicalMarketBalance: plan.marketAllocation,
            remainderBalance: plan.remainderAllocation,
            issuanceSourceBalance: 0,
            projectWalletBalance: 0,
            otherAllocation: 0,
            bindingManifestDigest: plan.bindingManifestDigest,
            runtimeAuthorityDigest: plan.runtimeAuthorityDigest,
            providerCallDigest: plan.providerCallDigest,
            remainderTreatmentDigest: plan.remainderTreatmentDigest,
            custodyCommitment: plan.custodyCommitment
        });
    }

    function _trace() private pure returns (HookemonIssuance.TransferRecord[] memory trace) {
        HookemonIssuance.IssuancePlan memory plan = _plan();
        trace = new HookemonIssuance.TransferRecord[](2);
        trace[0] = HookemonIssuance.TransferRecord(address(0), MARKET, plan.marketAllocation);
        trace[1] = HookemonIssuance.TransferRecord(address(0), REMAINDER, plan.remainderAllocation);
    }

    function _prepare(HookemonIssuanceHarness subject, HookemonIssuance.IssuancePlan memory plan)
        private
        returns (bytes32 planDigest)
    {
        VM.prank(AUTHORITY);
        planDigest = subject.prepareOfficialIssuance(plan);
        assert(planDigest != bytes32(0));
        assert(
            subject.readTokenState().status
                == HookemonIssuance.GuardStatus.PREPARED_PROVIDER_CALL_UNAVAILABLE
        );
    }

    function _assertPlanRejected(HookemonIssuance.IssuancePlan memory plan) private {
        HookemonIssuanceHarness subject = _deploy();
        VM.prank(AUTHORITY);
        (bool success,) =
            address(subject).call(abi.encodeCall(HookemonIssuance.prepareOfficialIssuance, (plan)));
        assert(!success);
        assert(subject.readTokenState().status == HookemonIssuance.GuardStatus.UNPREPARED);
    }

    function _assertObservationRejected(
        HookemonIssuanceHarness subject,
        HookemonIssuance.IssuancePlan memory plan,
        HookemonIssuance.IssuanceObservation memory observation,
        HookemonIssuance.TransferRecord[] memory trace
    ) private {
        VM.prank(AUTHORITY);
        (bool success,) = address(subject)
            .call(abi.encodeCall(HookemonIssuance.verifyIssuance, (plan, observation, trace)));
        assert(!success);
        HookemonIssuance.IssuanceGuardState memory state = subject.readTokenState();
        assert(state.status == HookemonIssuance.GuardStatus.PREPARED_PROVIDER_CALL_UNAVAILABLE);
        assert(state.observationDigest == bytes32(0));
    }

    function _mutateDecimals(HookemonIssuance.IssuancePlan memory plan, uint8 decimals)
        private
        pure
        returns (HookemonIssuance.IssuancePlan memory)
    {
        plan.decimals = decimals;
        return plan;
    }

    function _canDeploy(
        address authority,
        uint8 expectedDecimals,
        bytes32 bindingDigest,
        bytes32 runtimeDigest
    ) private returns (bool) {
        try new HookemonIssuanceHarness(
            authority, expectedDecimals, bindingDigest, runtimeDigest
        ) returns (
            HookemonIssuanceHarness
        ) {
            return true;
        } catch {
            return false;
        }
    }
}
