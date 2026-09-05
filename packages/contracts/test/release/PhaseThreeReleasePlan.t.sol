// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { HookemonHook } from "../../src/HookemonHook.sol";
import { PermanentPositionCustody } from "../../src/bindings/RobinhoodBindings.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";
import { PhaseThreeReleasePlan } from "../../script/release/PhaseThreeReleasePlan.sol";
import { Test } from "forge-std/Test.sol";

contract SeedIntentDigestTarget {
    bytes32 private immutable intentDigest;
    address private immutable launchCustody;

    constructor(bytes32 intentDigest_, address launchCustody_) {
        intentDigest = intentDigest_;
        launchCustody = launchCustody_;
    }

    function seedIntentDigest() external view returns (bytes32) {
        return intentDigest;
    }

    function canonicalLaunchCustody() external view returns (address) {
        return launchCustody;
    }
}

contract PhaseThreeReleasePlanTest is Test {
    function test_creationCodeHashesBindThePinnedLaunchProfile() external {
        if (!vm.envOr("HOOKEMON_ASSERT_LAUNCH_BYTECODE", false)) return;
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        require(
            keccak256(type(HKMNToken).creationCode) == subject.TOKEN_CREATION_CODE_HASH(),
            "token creation hash drifted"
        );
        require(
            keccak256(type(PermanentPositionCustody).creationCode)
                == subject.CUSTODY_CREATION_CODE_HASH(),
            "custody creation hash drifted"
        );
        require(
            keccak256(type(HookemonHook).creationCode) == subject.HOOK_CREATION_CODE_HASH(),
            "hook creation hash drifted"
        );
    }

    function test_poolAllocationBindsTheWholeSupplyAndNoOtherAllocation() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();

        require(subject.POOL_ALLOCATION() == subject.TOTAL_SUPPLY(), "pool allocation drifted");
        require(subject.REMAINDER_CUSTODY_ALLOCATION() == 0, "other allocation drifted");
    }

    function test_validateDraftBindsTheFrozenPolicy() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);

        bytes32 actual = subject.validateDraft(draft);

        require(actual == subject.draftDigest(draft), "draft digest mismatch");
    }

    function test_validateDraftRejectsMaterializedGraphValues() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);
        draft.token = address(0x1009);

        (bool succeeded,) = address(subject).call(abi.encodeCall(subject.validateDraft, (draft)));

        require(!succeeded, "materialized token was accepted");
    }

    function test_validateDraftRejectsUnapprovedPriceTuple() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);
        draft.sqrtPriceX96 += 1;

        (bool succeeded,) = address(subject).call(abi.encodeCall(subject.validateDraft, (draft)));

        require(!succeeded, "unapproved price tuple was accepted");
    }

    function test_validateDraftAcceptsTheHkmnCurrency0FullAllocationTuple() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);
        draft.liquidity = subject.HKMN_CURRENCY0_LIQUIDITY();
        draft.sqrtPriceX96 = subject.HKMN_CURRENCY0_SQRT_PRICE_X96();
        draft.amount0Max = subject.POOL_ALLOCATION();
        draft.amount1Max = subject.USDG_SEED();

        bytes32 actual = subject.validateDraft(draft);

        require(actual == subject.draftDigest(draft), "HKMN-currency0 draft digest mismatch");
    }

    function test_validateDraftRejectsChangedTemplateHash() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);
        draft.hookCreationCodeHash = bytes32(uint256(1));

        (bool succeeded,) = address(subject).call(abi.encodeCall(subject.validateDraft, (draft)));

        require(!succeeded, "changed template hash was accepted");
    }

    function test_validateDraftRejectsChangedSourceFeePolicy() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);
        draft.processFeeBps = 249;

        (bool succeeded,) = address(subject).call(abi.encodeCall(subject.validateDraft, (draft)));

        require(!succeeded, "changed source fee policy was accepted");
    }

    function test_validateDraftRejectsMissingGraphIssuanceAuthority() external {
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        PhaseThreeReleasePlan.Draft memory draft = _draft(subject);
        draft.issuanceAuthority = address(0);

        (bool succeeded,) = address(subject).call(abi.encodeCall(subject.validateDraft, (draft)));

        require(!succeeded, "missing graph issuance authority was accepted");
    }

    function test_validateMaterializedSeedCallAcceptsTheBoundSeed() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);
        bytes32 expectedDigest = _seedIntentDigest(params);
        SeedIntentDigestTarget target = new SeedIntentDigestTarget(expectedDigest, address(0x1002));

        (bool succeeded, bytes memory result) = _validateMaterializedSeedCall(
            subject,
            address(target),
            0,
            seedCalldata,
            address(target),
            address(0x1002),
            expectedDigest
        );

        require(succeeded, "bound seed call was rejected");
        require(abi.decode(result, (bytes32)) == expectedDigest, "seed digest mismatch");
    }

    function test_validateMaterializedSeedCallAcceptsTheHkmnCurrency0BoundSeed() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        params.liquidity = 489897948572597439;
        params.amount0Max = uint128(1_000_000_000e18);
        params.amount1Max = 240000000;
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);
        bytes32 expectedDigest = _seedIntentDigest(params);
        SeedIntentDigestTarget target = new SeedIntentDigestTarget(expectedDigest, address(0x1002));

        (bool succeeded, bytes memory result) = _validateMaterializedSeedCall(
            subject,
            address(target),
            0,
            seedCalldata,
            address(target),
            address(0x1002),
            expectedDigest
        );

        require(succeeded, "HKMN-currency0 seed call was rejected");
        require(abi.decode(result, (bytes32)) == expectedDigest, "HKMN-currency0 digest mismatch");
    }

    function test_validateMaterializedSeedCallRejectsChangedPayer() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.payer = address(0xCAFE);

        _assertSeedRejected(subject, params, expectedDigest, "changed payer was accepted");
    }

    function test_validateMaterializedSeedCallRejectsChangedLowerTick() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.tickLower = -887160;

        _assertSeedRejected(subject, params, expectedDigest, "changed lower tick was accepted");
    }

    function test_validateMaterializedSeedCallRejectsChangedUpperTick() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.tickUpper = 887160;

        _assertSeedRejected(subject, params, expectedDigest, "changed upper tick was accepted");
    }

    function test_validateMaterializedSeedCallRejectsChangedLiquidity() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.liquidity += 1;

        _assertSeedRejected(subject, params, expectedDigest, "changed liquidity was accepted");
    }

    function test_validateMaterializedSeedCallRejectsChangedAmount0Maximum() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.amount0Max -= 1;

        _assertSeedRejected(subject, params, expectedDigest, "changed amount0 maximum was accepted");
    }

    function test_validateMaterializedSeedCallRejectsChangedAmount1Maximum() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.amount1Max -= 1;

        _assertSeedRejected(subject, params, expectedDigest, "changed amount1 maximum was accepted");
    }

    function test_validateMaterializedSeedCallRejectsUnexpectedDigest() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);

        _assertSeedRejected(
            subject, params, bytes32(uint256(expectedDigest) ^ 1), "unexpected digest was accepted"
        );
    }

    function test_validateMaterializedSeedCallRejectsWrongTarget() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);

        (bool succeeded,) = _validateMaterializedSeedCall(
            subject,
            address(0x1003),
            0,
            seedCalldata,
            address(0x1001),
            address(0x1002),
            _seedIntentDigest(params)
        );

        require(!succeeded, "wrong target was accepted");
    }

    function test_validateMaterializedSeedCallRejectsTargetWithoutBoundImmutable() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);

        (bool succeeded,) = _validateMaterializedSeedCall(
            subject,
            address(0x1001),
            0,
            seedCalldata,
            address(0x1001),
            address(0x1002),
            _seedIntentDigest(params)
        );

        require(!succeeded, "target without immutable seed intent was accepted");
    }

    function test_validateMaterializedSeedCallRejectsTargetWithDifferentImmutable() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        SeedIntentDigestTarget target =
            new SeedIntentDigestTarget(bytes32(uint256(expectedDigest) ^ 1), address(0x1002));
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);

        (bool succeeded,) = _validateMaterializedSeedCall(
            subject,
            address(target),
            0,
            seedCalldata,
            address(target),
            address(0x1002),
            expectedDigest
        );

        require(!succeeded, "target with a different immutable seed intent was accepted");
    }

    function test_validateMaterializedSeedCallRejectsTargetWithDifferentCanonicalCustody()
        external
    {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        SeedIntentDigestTarget target = new SeedIntentDigestTarget(expectedDigest, address(0x1003));
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);

        (bool succeeded,) = _validateMaterializedSeedCall(
            subject,
            address(target),
            0,
            seedCalldata,
            address(target),
            address(0x1002),
            expectedDigest
        );

        require(!succeeded, "target with a different canonical custody was accepted");
    }

    function test_validateMaterializedSeedCallRejectsNativeValue() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);

        (bool succeeded,) = _validateMaterializedSeedCall(
            subject,
            address(0x1001),
            1,
            seedCalldata,
            address(0x1001),
            address(0x1002),
            _seedIntentDigest(params)
        );

        require(!succeeded, "native value was accepted");
    }

    function test_validateMaterializedSeedCallRejectsWrongCustody() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.custody = address(0x1003);

        _assertSeedRejected(subject, params, expectedDigest, "wrong custody was accepted");
    }

    function test_validateMaterializedSeedCallRejectsLateDeadline() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes32 expectedDigest = _seedIntentDigest(params);
        params.deadline = block.timestamp + 901;

        _assertSeedRejected(subject, params, expectedDigest, "late deadline was accepted");
    }

    function test_validateMaterializedSeedCallRejectsWrongSelector() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);
        seedCalldata[0] = 0xff;

        _assertCalldataRejected(
            subject, seedCalldata, _seedIntentDigest(params), "wrong selector was accepted"
        );
    }

    function test_validateMaterializedSeedCallRejectsMalformedCalldata() external {
        vm.warp(1_000_000);
        PhaseThreeReleasePlan subject = new PhaseThreeReleasePlan();
        HookemonHook.SeedParams memory params = _seedParams();
        bytes memory seedCalldata =
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params);

        _assertCalldataRejected(
            subject,
            abi.encodePacked(seedCalldata, bytes1(0)),
            _seedIntentDigest(params),
            "malformed calldata was accepted"
        );
    }

    function _seedParams() private view returns (HookemonHook.SeedParams memory) {
        return HookemonHook.SeedParams({
            tickLower: -887220,
            tickUpper: 887220,
            liquidity: 489897948556635619,
            amount0Max: 240000000,
            amount1Max: 1_000_000_000e18,
            deadline: block.timestamp + 900,
            payer: 0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729,
            custody: address(0x1002)
        });
    }

    function _seedIntentDigest(HookemonHook.SeedParams memory params)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                params.payer,
                params.tickLower,
                params.tickUpper,
                params.liquidity,
                params.amount0Max,
                params.amount1Max,
                uint256(900)
            )
        );
    }

    function _assertSeedRejected(
        PhaseThreeReleasePlan subject,
        HookemonHook.SeedParams memory params,
        bytes32 expectedDigest,
        string memory message
    ) private {
        _assertCalldataRejected(
            subject,
            abi.encodeWithSelector(HookemonHook.seedCanonicalLiquidity.selector, params),
            expectedDigest,
            message
        );
    }

    function _assertCalldataRejected(
        PhaseThreeReleasePlan subject,
        bytes memory seedCalldata,
        bytes32 expectedDigest,
        string memory message
    ) private {
        SeedIntentDigestTarget target = new SeedIntentDigestTarget(expectedDigest, address(0x1002));
        (bool succeeded,) = _validateMaterializedSeedCall(
            subject,
            address(target),
            0,
            seedCalldata,
            address(target),
            address(0x1002),
            expectedDigest
        );
        require(!succeeded, message);
    }

    function _validateMaterializedSeedCall(
        PhaseThreeReleasePlan subject,
        address target,
        uint256 value,
        bytes memory seedCalldata,
        address expectedTarget,
        address expectedCustody,
        bytes32 expectedDigest
    ) private returns (bool succeeded, bytes memory result) {
        return address(subject)
            .call(
                abi.encodeWithSignature(
                    "validateMaterializedSeedCall(address,uint256,bytes,address,address,bytes32)",
                    target,
                    value,
                    seedCalldata,
                    expectedTarget,
                    expectedCustody,
                    expectedDigest
                )
            );
    }

    function _draft(PhaseThreeReleasePlan subject)
        private
        view
        returns (PhaseThreeReleasePlan.Draft memory draft)
    {
        draft = PhaseThreeReleasePlan.Draft({
            chainId: 4663,
            graphFactory: 0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd,
            router: 0x34965F2A2ee9254522232C32F02056E92BE0C98a,
            launchWallet: 0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729,
            treasury: 0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729,
            operations: 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384,
            usdg: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,
            poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
            positionManager: 0x58daec3116aae6D93017bAAea7749052E8a04fA7,
            permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
            programmable: 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c,
            launchAuthority: 0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729,
            issuanceAuthority: 0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd,
            tokenCreationCodeHash: subject.TOKEN_CREATION_CODE_HASH(),
            tokenRuntimeTemplateCodeHash: subject.TOKEN_RUNTIME_TEMPLATE_CODE_HASH(),
            hookCreationCodeHash: subject.HOOK_CREATION_CODE_HASH(),
            hookRuntimeTemplateCodeHash: subject.HOOK_RUNTIME_TEMPLATE_CODE_HASH(),
            custodyCreationCodeHash: subject.CUSTODY_CREATION_CODE_HASH(),
            custodyRuntimeTemplateCodeHash: subject.CUSTODY_RUNTIME_TEMPLATE_CODE_HASH(),
            totalSupply: 1_000_000_000e18,
            poolAllocation: 1_000_000_000e18,
            remainderCustodyAllocation: 0,
            usdgSeed: 240_000_000,
            liquidity: 489897948556635619,
            sqrtPriceX96: uint160(161723809515207654588927258648643645224),
            amount0Max: 240_000_000,
            amount1Max: 1_000_000_000e18,
            tickLower: -887220,
            tickUpper: 887220,
            fee: 0,
            tickSpacing: 60,
            programmableFeeBps: 10,
            treasuryFeeBps: 40,
            processFeeBps: 250,
            routeNamespace: bytes32(0),
            routeNonce: bytes32(0),
            topologyHash: bytes32(0),
            graphDigest: bytes32(0),
            graphCalldataDigest: bytes32(0),
            seedCalldataDigest: bytes32(0),
            token: address(0),
            hook: address(0),
            custody: address(0),
            poolId: bytes32(0),
            seedDeadline: 0,
            walletNonce: 0,
            graphValueWei: 0
        });
    }
}
