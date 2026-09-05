// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { HookemonHook } from "../../src/HookemonHook.sol";
import { PermanentPositionCustody } from "../../src/bindings/RobinhoodBindings.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";
import { PhaseThreeReleasePlan } from "../../script/release/PhaseThreeReleasePlan.sol";
import { Test } from "forge-std/Test.sol";

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
