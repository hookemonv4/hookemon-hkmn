// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

import {
    BlindAmountMode,
    BlindCallbackStage,
    BlindCustodyEvidence,
    BlindDeploymentConfig,
    BlindFeeSplit,
    BlindLiabilitySnapshot,
    BlindMarketFeesFixture,
    BlindPoolKey,
    BlindSwapRequest,
    BlindSwapResult,
    BlindSwapSide,
    BlindTokenFailure,
    BlindTokenOrder,
    IBlindMarketFeesSubject
} from "./fixtures/BlindMarketFeesFixture.sol";

interface Vm {
    function expectRevert() external;
    function prank(address sender) external;
}

/// @dev Full P1-004 liability, claim, beneficiary, custody, and token-failure acceptance remains quarantined.
/// The implemented P1-002 callback subset runs through BlindP1002CanonicalMarketAcceptance.
abstract contract BlindMarketFeesAcceptance {
    error BlindAssertionFailed(string reason);

    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant EXECUTED_USDG = 10_000;
    uint256 internal constant HKMN_AMOUNT = 420_690;
    uint256 internal constant EXPECTED_TOTAL_FEE = 300;
    uint256 internal constant EXPECTED_PROGRAMMABLE = 10;
    uint256 internal constant EXPECTED_TREASURY = 40;
    uint256 internal constant EXPECTED_PROCESS = 250;

    function test_buyExactInputWhenUsdgIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Buy, BlindAmountMode.ExactInput, BlindTokenOrder.UsdgCurrency0
        );
    }

    function test_buyExactOutputWhenUsdgIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Buy, BlindAmountMode.ExactOutput, BlindTokenOrder.UsdgCurrency0
        );
    }

    function test_sellExactInputWhenUsdgIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Sell, BlindAmountMode.ExactInput, BlindTokenOrder.UsdgCurrency0
        );
    }

    function test_sellExactOutputWhenUsdgIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Sell, BlindAmountMode.ExactOutput, BlindTokenOrder.UsdgCurrency0
        );
    }

    function test_buyExactInputWhenHkmnIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Buy, BlindAmountMode.ExactInput, BlindTokenOrder.HkmnCurrency0
        );
    }

    function test_buyExactOutputWhenHkmnIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Buy, BlindAmountMode.ExactOutput, BlindTokenOrder.HkmnCurrency0
        );
    }

    function test_sellExactInputWhenHkmnIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Sell, BlindAmountMode.ExactInput, BlindTokenOrder.HkmnCurrency0
        );
    }

    function test_sellExactOutputWhenHkmnIsCurrency0() external {
        _assertQuadrant(
            BlindSwapSide.Sell, BlindAmountMode.ExactOutput, BlindTokenOrder.HkmnCurrency0
        );
    }

    function test_inclusiveThreePercentFeeIsTheOnlyTradingCharge() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, EXECUTED_USDG, HKMN_AMOUNT
        );

        BlindSwapResult memory result = subject.executeFinalizedSwap(request);
        BlindLiabilitySnapshot memory liabilities = subject.liabilitySnapshot();

        _assertEq(result.executedUsdg, EXECUTED_USDG, "fee base must be finalized executed USDG");
        _assertEq(
            result.actualCollectedUsdg,
            EXPECTED_TOTAL_FEE,
            "collected USDG must equal the inclusive fee"
        );
        _assertEq(result.fee.total, EXPECTED_TOTAL_FEE, "total fee must be exactly three percent");
        _assertEq(
            result.fee.programmable, EXPECTED_PROGRAMMABLE, "Programmable share must be exact"
        );
        _assertEq(result.fee.treasury, EXPECTED_TREASURY, "treasury share must be exact");
        _assertEq(
            result.fee.process, EXPECTED_PROCESS, "process share must receive the exact remainder"
        );
        _assertEq(result.lpFeeUsdg, 0, "the canonical market must charge no LP fee");
        _assertEq(result.additionalTradingChargeUsdg, 0, "no second trading charge is allowed");
        _assertEq(liabilities.total, EXPECTED_TOTAL_FEE, "liabilities must equal collected USDG");
        _assertEq(
            liabilities.hookUsdgBalance,
            liabilities.total,
            "collected USDG must back every liability"
        );
    }

    function test_roundingTransitionsAssignEveryCollectedUnit() external {
        _assertFeeAt(1, 0, 0, 0, 0);
        _assertFeeAt(33, 0, 0, 0, 0);
        _assertFeeAt(34, 1, 0, 0, 1);
        _assertFeeAt(249, 7, 0, 0, 7);
        _assertFeeAt(250, 7, 0, 1, 6);
        _assertFeeAt(999, 29, 0, 3, 26);
        _assertFeeAt(1_000, 30, 1, 4, 25);
        _assertFeeAt(3_333, 99, 3, 13, 83);
        _assertFeeAt(3_334, 100, 3, 13, 84);
    }

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_feeSplitConservesEveryCollectedUnit(uint128 executedUsdg) external {
        (,, IBlindMarketFeesSubject subject) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindFeeSplit memory fee = subject.accrueAuthenticatedQuote(uint256(executedUsdg));

        uint256 expectedTotal = uint256(executedUsdg) * 300 / 10_000;
        uint256 expectedProgrammable = uint256(executedUsdg) * 10 / 10_000;
        uint256 expectedTreasury = uint256(executedUsdg) * 40 / 10_000;

        _assertEq(fee.total, expectedTotal, "fuzzed total fee differs from the exact floor formula");
        _assertEq(
            fee.programmable,
            expectedProgrammable,
            "fuzzed Programmable share differs from its floor"
        );
        _assertEq(fee.treasury, expectedTreasury, "fuzzed treasury share differs from its floor");
        _assertEq(
            fee.process,
            expectedTotal - expectedProgrammable - expectedTreasury,
            "fuzzed process share does not receive the exact remainder"
        );
        _assertEq(
            fee.programmable + fee.treasury + fee.process,
            fee.total,
            "fuzzed fee split creates dust"
        );
    }

    function test_beneficiaryOwnershipFreezesAcrossThreeTreasuryEpochs() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        address treasuryTwo = address(0x6001);
        address treasuryThree = address(0x6002);

        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        subject.rotateTreasury(treasuryTwo);
        subject.rotateOperations(address(0x7001));
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        subject.rotateTreasury(treasuryThree);
        subject.rotateOperations(address(0x7002));
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);

        BlindLiabilitySnapshot memory liabilities = subject.liabilitySnapshot();
        _assertEq(
            subject.programmableLiability(config.programmableBeneficiary),
            EXPECTED_PROGRAMMABLE * 3,
            "the immutable Programmable beneficiary must own all three epochs"
        );
        _assertEq(
            subject.treasuryLiability(config.treasuryBeneficiary),
            EXPECTED_TREASURY,
            "the first treasury epoch must not be rewritten"
        );
        _assertEq(
            subject.treasuryLiability(treasuryTwo),
            EXPECTED_TREASURY,
            "the second treasury epoch must remain isolated"
        );
        _assertEq(
            subject.treasuryLiability(treasuryThree),
            EXPECTED_TREASURY,
            "the third treasury epoch must remain isolated"
        );
        _assertEq(
            liabilities.process,
            EXPECTED_PROCESS * 3,
            "Operations rotation must not rewrite process liability"
        );
    }

    function test_programmableClaimDebitsOnlyProgrammableLiability() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        subject.seedPayoutLiability(17);

        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();
        uint256 beneficiaryBalanceBefore =
            subject.tokenBalance(config.usdg, config.programmableBeneficiary);

        VM.prank(config.programmableBeneficiary);
        uint256 claimed =
            subject.claimProgrammable(EXPECTED_PROGRAMMABLE, config.programmableBeneficiary);

        BlindLiabilitySnapshot memory afterSnapshot = subject.liabilitySnapshot();
        _assertEq(
            claimed, EXPECTED_PROGRAMMABLE, "Programmable must receive its exact positive liability"
        );
        _assertEq(afterSnapshot.programmable, 0, "only Programmable liability must be cleared");
        _assertEq(
            afterSnapshot.treasury,
            beforeSnapshot.treasury,
            "treasury liability must remain isolated"
        );
        _assertEq(
            afterSnapshot.process, beforeSnapshot.process, "process liability must remain isolated"
        );
        _assertEq(
            afterSnapshot.payout, beforeSnapshot.payout, "payout liability must remain isolated"
        );
        _assertEq(
            beforeSnapshot.hookUsdgBalance - afterSnapshot.hookUsdgBalance,
            claimed,
            "hook balance must fall by the exact claim"
        );
        _assertEq(
            subject.tokenBalance(config.usdg, config.programmableBeneficiary)
                - beneficiaryBalanceBefore,
            claimed,
            "beneficiary balance must rise by the exact claim"
        );
        _assertSolvent(afterSnapshot);
    }

    function test_historicalTreasuryClaimDebitsOnlyItsFrozenLiability() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        address treasuryTwo = address(0x6001);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        subject.rotateTreasury(treasuryTwo);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);

        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();
        VM.prank(config.treasuryBeneficiary);
        uint256 claimed = subject.claimTreasury(EXPECTED_TREASURY, config.treasuryBeneficiary);
        BlindLiabilitySnapshot memory afterSnapshot = subject.liabilitySnapshot();

        _assertEq(
            claimed,
            EXPECTED_TREASURY,
            "historical treasury must receive its exact frozen liability"
        );
        _assertEq(
            subject.treasuryLiability(config.treasuryBeneficiary),
            0,
            "claimed treasury epoch must be cleared"
        );
        _assertEq(
            subject.treasuryLiability(treasuryTwo),
            EXPECTED_TREASURY,
            "the current treasury epoch must remain isolated"
        );
        _assertEq(
            afterSnapshot.programmable,
            beforeSnapshot.programmable,
            "Programmable liability must not change"
        );
        _assertEq(
            afterSnapshot.process, beforeSnapshot.process, "process liability must not change"
        );
        _assertSolvent(afterSnapshot);
    }

    function test_overclaimRevertsWithoutChangingAnyLiability() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();

        VM.expectRevert();
        VM.prank(config.programmableBeneficiary);
        subject.claimProgrammable(EXPECTED_PROGRAMMABLE + 1, config.programmableBeneficiary);

        _assertSnapshotEq(
            subject.liabilitySnapshot(),
            beforeSnapshot,
            "overclaim changed a liability or hook balance"
        );
    }

    function test_wrongBeneficiaryClaimRevertsWithoutChangingAnyLiability() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();

        VM.expectRevert();
        VM.prank(address(0xBAD1));
        subject.claimProgrammable(EXPECTED_PROGRAMMABLE, config.programmableBeneficiary);

        _assertSnapshotEq(
            subject.liabilitySnapshot(),
            beforeSnapshot,
            "wrong-beneficiary claim changed a liability or hook balance"
        );
    }

    function test_alternateClaimRecipientRevertsWithoutChangingAnyLiability() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();

        VM.expectRevert();
        VM.prank(config.programmableBeneficiary);
        subject.claimProgrammable(EXPECTED_PROGRAMMABLE, address(0xBAD2));

        _assertSnapshotEq(
            subject.liabilitySnapshot(),
            beforeSnapshot,
            "alternate-recipient claim changed a liability or hook balance"
        );
    }

    function test_zeroLiabilityClaimRevertsWithoutChangingAnyLiability() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();

        VM.expectRevert();
        VM.prank(config.programmableBeneficiary);
        subject.claimProgrammable(0, config.programmableBeneficiary);

        _assertSnapshotEq(
            subject.liabilitySnapshot(),
            beforeSnapshot,
            "zero-liability claim changed a liability or hook balance"
        );
    }

    function test_revertedTokenClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.RevertTransfer);
    }

    function test_falseReturnClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.FalseReturn);
    }

    function test_malformedReturnClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.MalformedReturn);
    }

    function test_shortSourceDeltaClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.ShortSourceDelta);
    }

    function test_shortDestinationDeltaClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.ShortDestinationDelta);
    }

    function test_excessSourceDeltaClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.ExcessSourceDelta);
    }

    function test_excessDestinationDeltaClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.ExcessDestinationDelta);
    }

    function test_reentrantClaimLeavesAllLiabilitiesUnchanged() external {
        _assertFailedClaim(BlindTokenFailure.Reenter);
    }

    function test_directUsdgSurplusCreatesNoLiability() external {
        (,, IBlindMarketFeesSubject subject) = _deploy(BlindTokenOrder.UsdgCurrency0);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();

        subject.donateUsdg(123);

        BlindLiabilitySnapshot memory afterSnapshot = subject.liabilitySnapshot();
        _assertEq(
            afterSnapshot.programmable,
            beforeSnapshot.programmable,
            "surplus must not invent Programmable liability"
        );
        _assertEq(
            afterSnapshot.treasury,
            beforeSnapshot.treasury,
            "surplus must not invent treasury liability"
        );
        _assertEq(
            afterSnapshot.process,
            beforeSnapshot.process,
            "surplus must not invent process liability"
        );
        _assertEq(
            afterSnapshot.payout, beforeSnapshot.payout, "surplus must not invent payout liability"
        );
        _assertEq(
            afterSnapshot.hookUsdgBalance,
            beforeSnapshot.hookUsdgBalance + 123,
            "surplus must remain unaccounted"
        );
        _assertSolvent(afterSnapshot);
    }

    function test_canonicalPoolKeyHasZeroStaticLpFee() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindPoolKey memory key = subject.canonicalPoolKey();

        _assertEq(key.staticLpFee, 0, "canonical PoolKey static LP fee must be zero");
        _assertEq(
            uint160(key.currency0),
            uint160(config.canonicalPoolKey.currency0),
            "canonical currency0 must match"
        );
        _assertEq(
            uint160(key.currency1),
            uint160(config.canonicalPoolKey.currency1),
            "canonical currency1 must match"
        );
        _assertEq(
            key.poolId,
            config.canonicalPoolKey.poolId,
            "complete canonical PoolKey identity must match"
        );
    }

    function test_ninetyPercentLaunchPositionHasNoProjectControlPath() external {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindCustodyEvidence memory evidence = subject.custodyEvidence();
        bytes4[9] memory selectors;
        selectors[0] = bytes4(keccak256("transfer(address,uint256)"));
        selectors[1] = bytes4(keccak256("approve(address,uint256)"));
        selectors[2] = bytes4(keccak256("decreaseLiquidity(bytes)"));
        selectors[3] = bytes4(keccak256("withdraw(uint256,address)"));
        selectors[4] = bytes4(keccak256("collect(bytes)"));
        selectors[5] = bytes4(keccak256("rescue(address,address,uint256)"));
        selectors[6] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        selectors[7] = bytes4(keccak256("delegate(address)"));
        selectors[8] = bytes4(keccak256("setSuccessor(address)"));
        address[5] memory callers = [
            address(0xA001),
            address(0xA002),
            config.treasuryBeneficiary,
            config.operations,
            address(0xA005)
        ];

        _assertEq(
            evidence.launchHkmnAllocation,
            config.fixedHkmnSupply * 90 / 100,
            "permanent launch position must contain exactly ninety percent"
        );
        _assertEq(evidence.staticLpFee, 0, "permanent position must use zero LP fee");
        _assertTrue(evidence.immutableCustody, "launch position custody must be immutable");
        _assertFalse(evidence.projectControlled, "no project role may control the launch position");
        _assertFalse(evidence.upgradeable, "launch position custody must not be upgradeable");
        _assertFalse(
            evidence.collectsPositionFees, "launch position must expose no fee collection authority"
        );

        bytes32 beforeDigest = subject.economicsDigest();
        for (uint256 callerIndex; callerIndex < callers.length; ++callerIndex) {
            for (uint256 selectorIndex; selectorIndex < selectors.length; ++selectorIndex) {
                _assertFalse(
                    subject.probePositionControl(selectors[selectorIndex], callers[callerIndex]),
                    "a forbidden launch-position control path succeeded"
                );
            }
        }
        _assertEq(
            subject.economicsDigest(),
            beforeDigest,
            "forbidden position probes must not mutate economics"
        );
    }

    function test_permanentCustodyKeepsNormalBuysSellsAndUserTransfersAvailable() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory buyRequest = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, EXECUTED_USDG, HKMN_AMOUNT
        );
        BlindSwapRequest memory sellRequest = fixture.swapRequest(
            config, BlindSwapSide.Sell, BlindAmountMode.ExactOutput, EXECUTED_USDG, HKMN_AMOUNT
        );

        BlindSwapResult memory buyResult = subject.executeFinalizedSwap(buyRequest);
        BlindSwapResult memory sellResult = subject.executeFinalizedSwap(sellRequest);
        uint256 recipientBefore = subject.tokenBalance(config.hkmn, address(0x9000));
        subject.transferUserHkmn(buyRequest.trader, address(0x9000), 1);

        _assertEq(
            buyResult.traderHkmnDelta,
            int256(HKMN_AMOUNT),
            "post-custody buy must deliver exact HKMN"
        );
        _assertEq(
            sellResult.traderUsdgDelta,
            int256(EXECUTED_USDG),
            "post-custody sell must deliver exact USDG"
        );
        _assertEq(
            subject.tokenBalance(config.hkmn, address(0x9000)) - recipientBefore,
            1,
            "custody must not freeze user HKMN transfers"
        );
    }

    function test_foreignManagerRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.callbackCaller = address(0xDEAD);
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_alteredCurrencyOrderingRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        (request.poolKey.currency0, request.poolKey.currency1) =
        (request.poolKey.currency1, request.poolKey.currency0);
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_nonzeroLpFeeRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.poolKey.staticLpFee = 1;
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_alteredTickSpacingRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.poolKey.tickSpacing += 1;
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_alteredHookRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.poolKey.hooks = address(0xDEAD);
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_alteredPoolIdRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.poolKey.poolId = keccak256("foreign-pool");
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_wrongCallbackStageRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.callbackStage = BlindCallbackStage.BeforeSwap;
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_malformedFinalDeltasRevertWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.currency0TraderDelta = int256(EXECUTED_USDG);
        request.currency1TraderDelta = int256(HKMN_AMOUNT);
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_zeroBuyerOutputRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        if (request.poolKey.currency0 == config.hkmn) {
            request.currency0TraderDelta = 0;
        } else {
            request.currency1TraderDelta = 0;
        }
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_partialFillRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.fullFill = false;
        _assertSwapRevertsUnchanged(subject, request);
    }

    function test_reentrantSwapRevertsWithoutEconomicMutation() external {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindSwapRequest memory request = _validBuy(fixture, config);
        request.attemptsReentry = true;
        _assertSwapRevertsUnchanged(subject, request);
    }

    function _assertQuadrant(BlindSwapSide side, BlindAmountMode amountMode, BlindTokenOrder order)
        internal
    {
        (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        ) = _deploy(order);
        BlindSwapRequest memory request =
            fixture.swapRequest(config, side, amountMode, EXECUTED_USDG, HKMN_AMOUNT);
        uint256 buyerHkmnBefore = subject.tokenBalance(config.hkmn, request.trader);

        BlindSwapResult memory result = subject.executeFinalizedSwap(request);

        int256 expectedUsdgDelta =
            side == BlindSwapSide.Buy ? -int256(EXECUTED_USDG) : int256(EXECUTED_USDG);
        int256 expectedHkmnDelta =
            side == BlindSwapSide.Buy ? int256(HKMN_AMOUNT) : -int256(HKMN_AMOUNT);
        _assertEq(result.executedUsdg, EXECUTED_USDG, "quadrant must use finalized USDG delta");
        _assertEq(result.traderUsdgDelta, expectedUsdgDelta, "quadrant mapped the wrong USDG delta");
        _assertEq(result.traderHkmnDelta, expectedHkmnDelta, "quadrant mapped the wrong HKMN delta");
        _assertEq(
            result.fee.total, EXPECTED_TOTAL_FEE, "quadrant must apply the exact inclusive fee"
        );
        _assertEq(result.lpFeeUsdg, 0, "quadrant must not add an LP fee");
        _assertEq(
            result.additionalTradingChargeUsdg, 0, "quadrant must not add another trading charge"
        );

        if (side == BlindSwapSide.Buy) {
            _assertEq(
                subject.tokenBalance(config.hkmn, request.trader) - buyerHkmnBefore,
                HKMN_AMOUNT,
                "buyer must receive the exact canonical HKMN output"
            );
        }
    }

    function _assertFeeAt(
        uint256 executedUsdg,
        uint256 total,
        uint256 programmable,
        uint256 treasury,
        uint256 process
    ) internal {
        (,, IBlindMarketFeesSubject subject) = _deploy(BlindTokenOrder.UsdgCurrency0);
        BlindFeeSplit memory fee = subject.accrueAuthenticatedQuote(executedUsdg);

        _assertEq(fee.total, total, "rounding total differs");
        _assertEq(fee.programmable, programmable, "rounding Programmable share differs");
        _assertEq(fee.treasury, treasury, "rounding treasury share differs");
        _assertEq(fee.process, process, "rounding process remainder differs");
        _assertEq(
            fee.programmable + fee.treasury + fee.process, fee.total, "rounding creates fee dust"
        );
    }

    function _assertFailedClaim(BlindTokenFailure failure) internal {
        (, BlindDeploymentConfig memory config, IBlindMarketFeesSubject subject) =
            _deploy(BlindTokenOrder.UsdgCurrency0);
        subject.accrueAuthenticatedQuote(EXECUTED_USDG);
        subject.seedPayoutLiability(17);
        subject.configureTokenFailure(failure);
        BlindLiabilitySnapshot memory beforeSnapshot = subject.liabilitySnapshot();
        uint256 beneficiaryBefore =
            subject.tokenBalance(config.usdg, config.programmableBeneficiary);

        VM.expectRevert();
        VM.prank(config.programmableBeneficiary);
        subject.claimProgrammable(EXPECTED_PROGRAMMABLE, config.programmableBeneficiary);

        BlindLiabilitySnapshot memory afterSnapshot = subject.liabilitySnapshot();
        _assertSnapshotEq(
            afterSnapshot, beforeSnapshot, "failed claim changed a liability or hook balance"
        );
        _assertEq(
            subject.tokenBalance(config.usdg, config.programmableBeneficiary),
            beneficiaryBefore,
            "failed claim changed the beneficiary balance"
        );
    }

    function _assertSwapRevertsUnchanged(
        IBlindMarketFeesSubject subject,
        BlindSwapRequest memory request
    ) internal {
        bytes32 beforeDigest = subject.economicsDigest();
        VM.expectRevert();
        subject.executeFinalizedSwap(request);
        _assertEq(subject.economicsDigest(), beforeDigest, "rejected swap changed economic state");
    }

    function _validBuy(BlindMarketFeesFixture fixture, BlindDeploymentConfig memory config)
        internal
        pure
        returns (BlindSwapRequest memory request)
    {
        request = fixture.swapRequest(
            config, BlindSwapSide.Buy, BlindAmountMode.ExactInput, EXECUTED_USDG, HKMN_AMOUNT
        );
    }

    function _deploy(BlindTokenOrder order)
        internal
        virtual
        returns (
            BlindMarketFeesFixture fixture,
            BlindDeploymentConfig memory config,
            IBlindMarketFeesSubject subject
        )
    {
        fixture = new BlindMarketFeesFixture();
        config = fixture.configuration(order);
        subject = fixture.deploy(config);
    }

    function _assertSolvent(BlindLiabilitySnapshot memory snapshot) internal pure {
        _assertEq(
            snapshot.total,
            snapshot.programmable + snapshot.treasury + snapshot.process + snapshot.payout,
            "aggregate liability double-counts or omits value"
        );
        if (snapshot.hookUsdgBalance < snapshot.total) {
            revert BlindAssertionFailed("actual hook USDG balance is below total unpaid liability");
        }
    }

    function _assertSnapshotEq(
        BlindLiabilitySnapshot memory actual,
        BlindLiabilitySnapshot memory expected,
        string memory reason
    ) internal pure {
        if (
            actual.programmable != expected.programmable || actual.treasury != expected.treasury
                || actual.process != expected.process || actual.payout != expected.payout
                || actual.total != expected.total
                || actual.hookUsdgBalance != expected.hookUsdgBalance
        ) {
            revert BlindAssertionFailed(reason);
        }
    }

    function _assertEq(uint256 actual, uint256 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindAssertionFailed(reason);
    }

    function _assertEq(int256 actual, int256 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindAssertionFailed(reason);
    }

    function _assertEq(bytes32 actual, bytes32 expected, string memory reason) internal pure {
        if (actual != expected) revert BlindAssertionFailed(reason);
    }

    function _assertTrue(bool value, string memory reason) internal pure {
        if (!value) revert BlindAssertionFailed(reason);
    }

    function _assertFalse(bool value, string memory reason) internal pure {
        if (value) revert BlindAssertionFailed(reason);
    }
}
