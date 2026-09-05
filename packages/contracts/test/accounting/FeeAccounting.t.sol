// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

contract FeeAccountingTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant QUOTE = 10_000;
    uint256 private constant TOTAL_FEE = 300;
    uint256 private constant PROGRAMMABLE_BPS = 10;
    uint256 private constant TREASURY_BPS = 40;
    uint256 private constant PROCESS_BPS = 250;
    uint256 private constant BPS_DENOM = 10_000;

    struct FeeSplit {
        uint256 total;
        uint256 programmable;
        uint256 treasury;
        uint256 process;
    }

    function test_swapAccrualEmitsCompleteSplit() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();

        VM.recordLogs();
        _accrue(token, accounting, QUOTE);

        _assertSwapLiabilityEvent(
            VM.getRecordedLogs(), accounting, address(programmable), address(treasury)
        );
    }

    /// @dev Every owner-approved stream has its own lifetime remainder. `split` commits the same
    ///      transition as accrual, so this is a multi-swap trace rather than a set of probes.
    function test_independentRemaindersAllocateEveryOwnerApprovedStream() external {
        (MockUsdg token, FeeAccountingHarness accounting, ClaimActor programmable,) = _deploy();
        token;
        programmable;

        // A zero-quote call never accrues and never reverts.
        _assertSplit(accounting, 0, 0, 0, 0, 0);
        // Exactly the minimum executed quote: the whole-unit shares land with both remainders
        // returned to exactly zero, so repeating it is fully deterministic.
        _assertSplit(accounting, 1_000, 30, 1, 4, 25);
        _assertSplit(accounting, 1_000, 30, 1, 4, 25);
        // The three 1,499-unit swaps carry each 10/40/250 stream independently. Their aggregate
        // equals the allocation for one 4,497-unit swap.
        _assertSplit(accounting, 1_499, 43, 1, 5, 37);
        _assertSplit(accounting, 1_499, 44, 1, 6, 37);
        _assertSplit(accounting, 1_499, 46, 2, 6, 38);
        // Further swaps keep drawing on the same carried remainders rather than starting fresh.
        _assertSplit(accounting, 3_333, 100, 3, 14, 83);
        _assertSplit(accounting, 3_334, 101, 4, 13, 84);
        (uint256 total, uint256 programmableFee, uint256 treasuryFee, uint256 processFee) =
            accounting.split(type(uint256).max);
        _assertEq(
            programmableFee + treasuryFee + processFee,
            total,
            "maximum quote split does not conserve fee"
        );
    }

    /// @dev Each owner-approved 10/40/250-bps stream carries its own lifetime fractional
    ///      numerator. Fragmenting an accepted gross quote volume cannot change any stream's
    ///      eventual whole-unit allocation.
    function test_independentLifetimeRemaindersMakeSplitAndUnsplitAllocationsEqual() external {
        (, FeeAccountingHarness split,,) = _deploy();
        (, FeeAccountingHarness unsplit,,) = _deploy();

        (
            uint256 splitThousandOne,
            uint256 splitThousandProgrammableOne,
            uint256 splitThousandTreasuryOne,
            uint256 splitThousandProcessOne
        ) = split.split(1_000);
        (
            uint256 splitThousandTwo,
            uint256 splitThousandProgrammableTwo,
            uint256 splitThousandTreasuryTwo,
            uint256 splitThousandProcessTwo
        ) = split.split(1_000);
        (
            uint256 unsplitThousand,
            uint256 unsplitThousandProgrammable,
            uint256 unsplitThousandTreasury,
            uint256 unsplitThousandProcess
        ) = unsplit.split(2_000);

        _assertEq(
            splitThousandProgrammableOne + splitThousandProgrammableTwo,
            unsplitThousandProgrammable,
            "1,000 fragmentation changed programmable allocation"
        );
        _assertEq(
            splitThousandTreasuryOne + splitThousandTreasuryTwo,
            unsplitThousandTreasury,
            "1,000 fragmentation changed treasury allocation"
        );
        _assertEq(
            splitThousandProcessOne + splitThousandProcessTwo,
            unsplitThousandProcess,
            "1,000 fragmentation changed process allocation"
        );
        _assertEq(
            splitThousandOne + splitThousandTwo,
            unsplitThousand,
            "1,000 fragmentation changed total allocation"
        );
        _assertEq(
            split.programmableRemainder(),
            unsplit.programmableRemainder(),
            "1,000 fragmentation changed programmable remainder"
        );
        _assertEq(
            split.treasuryRemainder(),
            unsplit.treasuryRemainder(),
            "1,000 fragmentation changed treasury remainder"
        );
        _assertEq(
            split.processRemainder(),
            unsplit.processRemainder(),
            "1,000 fragmentation changed process remainder"
        );

        (, FeeAccountingHarness splitFourteenNinetyNine,,) = _deploy();
        (, FeeAccountingHarness unsplitFourteenNinetyNine,,) = _deploy();
        (
            uint256 firstTotal,
            uint256 firstProgrammable,
            uint256 firstTreasury,
            uint256 firstProcess
        ) = splitFourteenNinetyNine.split(1_499);
        (
            uint256 secondTotal,
            uint256 secondProgrammable,
            uint256 secondTreasury,
            uint256 secondProcess
        ) = splitFourteenNinetyNine.split(1_499);
        (
            uint256 wholeTotal,
            uint256 wholeProgrammable,
            uint256 wholeTreasury,
            uint256 wholeProcess
        ) = unsplitFourteenNinetyNine.split(2_998);

        _assertEq(firstTotal, 43, "first 1,499 total is not independently rounded");
        _assertEq(firstProgrammable, 1, "first 1,499 programmable allocation changed");
        _assertEq(firstTreasury, 5, "first 1,499 treasury allocation changed");
        _assertEq(firstProcess, 37, "first 1,499 process allocation changed");
        _assertEq(
            firstProgrammable + secondProgrammable, wholeProgrammable, "programmable split mismatch"
        );
        _assertEq(firstTreasury + secondTreasury, wholeTreasury, "treasury split mismatch");
        _assertEq(firstProcess + secondProcess, wholeProcess, "process split mismatch");
        _assertEq(firstTotal + secondTotal, wholeTotal, "total split mismatch");
        _assertEq(
            splitFourteenNinetyNine.programmableRemainder(),
            unsplitFourteenNinetyNine.programmableRemainder(),
            "1,499 fragmentation changed programmable remainder"
        );
        _assertEq(
            splitFourteenNinetyNine.treasuryRemainder(),
            unsplitFourteenNinetyNine.treasuryRemainder(),
            "1,499 fragmentation changed treasury remainder"
        );
        _assertEq(
            splitFourteenNinetyNine.processRemainder(),
            unsplitFourteenNinetyNine.processRemainder(),
            "1,499 fragmentation changed process remainder"
        );
    }

    /// @dev The per-stream quotient/remainder state is a lifetime property. Arbitrary accepted
    ///      fragments must reach the same stream totals and remainder state as one gross quote.
    function testFuzz_independentLifetimeRemaindersKeepFuzzedSplitAndUnsplitTotalsEqual(
        uint128 rawFirst,
        uint128 rawSecond,
        uint128 rawThird
    ) external {
        (, FeeAccountingHarness split,,) = _deploy();
        (, FeeAccountingHarness unsplit,,) = _deploy();
        uint256 first = _clampPositiveQuote(rawFirst);
        uint256 second = _clampPositiveQuote(rawSecond);
        uint256 third = _clampPositiveQuote(rawThird);

        FeeSplit memory firstSplit = _splitResult(split, first);
        FeeSplit memory secondSplit = _splitResult(split, second);
        FeeSplit memory thirdSplit = _splitResult(split, third);
        FeeSplit memory wholeSplit = _splitResult(unsplit, first + second + third);

        _assertEq(
            firstSplit.programmable + secondSplit.programmable + thirdSplit.programmable,
            wholeSplit.programmable,
            "fuzzed split changed programmable allocation"
        );
        _assertEq(
            firstSplit.treasury + secondSplit.treasury + thirdSplit.treasury,
            wholeSplit.treasury,
            "fuzzed split changed treasury allocation"
        );
        _assertEq(
            firstSplit.process + secondSplit.process + thirdSplit.process,
            wholeSplit.process,
            "fuzzed split changed process allocation"
        );
        _assertEq(
            firstSplit.total + secondSplit.total + thirdSplit.total,
            wholeSplit.total,
            "fuzzed split changed total allocation"
        );
        _assertEq(
            split.programmableRemainder(),
            unsplit.programmableRemainder(),
            "fuzzed split changed programmable remainder"
        );
        _assertEq(
            split.treasuryRemainder(),
            unsplit.treasuryRemainder(),
            "fuzzed split changed treasury remainder"
        );
        _assertEq(
            split.processRemainder(),
            unsplit.processRemainder(),
            "fuzzed split changed process remainder"
        );
    }

    /// @dev A swap below the 1,000-smallest-unit minimum reverts atomically instead of silently
    ///      charging (or omitting) a fee, per programmable-fee-policy.md v1.1.0.
    function test_revision55SwapBelowMinimumQuoteReverts() external {
        (, FeeAccountingHarness accounting,,) = _deploy();

        (bool success,) =
            address(accounting).call(abi.encodeCall(FeeAccountingHarness.split, (999)));

        _assertFalse(success, "sub-minimum quote was accepted");
    }

    /// @dev The minimum boundary itself must succeed: 999 reverts, 1,000 does not.
    function test_revision55SwapAtMinimumQuoteSucceeds() external {
        (, FeeAccountingHarness accounting,,) = _deploy();

        _assertSplit(accounting, 1_000, 30, 1, 4, 25);
    }

    /// @dev A claim zeroes only the claimed beneficiary's liability balance; it must never touch
    ///      the persisted cumulative remainders, so identical follow-up swaps split identically
    ///      whether or not a claim happened in between.
    function test_revision55ClaimNeverResetsCumulativeRemainder() external {
        (
            MockUsdg tokenA,
            FeeAccountingHarness withClaim,
            ClaimActor programmableA,
            ClaimActor treasuryA
        ) = _deploy();
        (, FeeAccountingHarness withoutClaim,,) = _deploy();
        tokenA;

        withClaim.collectAndAccrue(1_499);
        withoutClaim.split(1_499);
        _assertEq(
            withClaim.programmableRemainder(),
            withoutClaim.programmableRemainder(),
            "remainder diverged before any claim"
        );
        _assertEq(
            withClaim.treasuryRemainder(),
            withoutClaim.treasuryRemainder(),
            "treasury remainder diverged before any claim"
        );
        _assertEq(
            withClaim.processRemainder(),
            withoutClaim.processRemainder(),
            "process remainder diverged before any claim"
        );

        programmableA.claimProgrammable(withClaim);
        treasuryA.claimTreasury(withClaim);

        _assertEq(
            withClaim.programmableRemainder(),
            withoutClaim.programmableRemainder(),
            "claim changed the programmable remainder"
        );
        _assertEq(
            withClaim.treasuryRemainder(),
            withoutClaim.treasuryRemainder(),
            "claim changed the treasury remainder"
        );
        _assertEq(
            withClaim.processRemainder(),
            withoutClaim.processRemainder(),
            "claim changed the process remainder"
        );

        (
            uint256 totalAfterClaim,
            uint256 programmableAfterClaim,
            uint256 treasuryAfterClaim,
            uint256 processAfterClaim
        ) = _splitViaCall(withClaim, 1_499);
        (
            uint256 totalNoClaim,
            uint256 programmableNoClaim,
            uint256 treasuryNoClaim,
            uint256 processNoClaim
        ) = _splitViaCall(withoutClaim, 1_499);
        _assertEq(totalAfterClaim, totalNoClaim, "claim changed the next swap's total fee");
        _assertEq(
            programmableAfterClaim,
            programmableNoClaim,
            "claim changed the next swap's programmable share"
        );
        _assertEq(
            treasuryAfterClaim, treasuryNoClaim, "claim changed the next swap's treasury share"
        );
        _assertEq(processAfterClaim, processNoClaim, "claim changed the next swap's process share");
    }

    /// forge-config: default.fuzz.runs = 100000
    function testFuzz_revision55SplitConservesTotal(uint256[5] calldata rawQuotes) external {
        (, FeeAccountingHarness accounting,,) = _deploy();
        uint256 sumTotal;
        uint256 sumProgrammable;
        uint256 sumTreasury;
        uint256 sumProcess;
        uint256 programmableNumerator;
        uint256 treasuryNumerator;
        uint256 processNumerator;

        for (uint256 i; i < rawQuotes.length; ++i) {
            uint256 quote = _clampQuote(rawQuotes[i]);
            (uint256 total, uint256 programmable, uint256 treasury, uint256 process) =
                accounting.split(quote);

            _assertEq(programmable + treasury + process, total, "split does not conserve fee");
            sumTotal += total;
            sumProgrammable += programmable;
            sumTreasury += treasury;
            sumProcess += process;
            programmableNumerator += quote * PROGRAMMABLE_BPS;
            treasuryNumerator += quote * TREASURY_BPS;
            processNumerator += quote * PROCESS_BPS;
        }

        _assertEq(
            sumProgrammable,
            programmableNumerator / BPS_DENOM,
            "cumulative programmable total does not match the kernel doc formula"
        );
        _assertEq(
            sumTreasury,
            treasuryNumerator / BPS_DENOM,
            "cumulative treasury total does not match the independent formula"
        );
        _assertEq(
            sumProcess,
            processNumerator / BPS_DENOM,
            "cumulative process total does not match the independent formula"
        );
        _assertEq(
            sumProgrammable + sumTreasury + sumProcess,
            sumTotal,
            "sum of all buckets and remainders does not equal total fee collected"
        );
    }

    /// @dev Deterministic clamp so every fuzzed quote is either exactly zero or at least the
    ///      1,000-unit minimum, matching the one constraint `_splitLiability` enforces.
    function _clampQuote(uint256 raw) private pure returns (uint256) {
        if (raw % 7 == 0) return 0;
        return _clampPositiveQuote(raw);
    }

    function _clampPositiveQuote(uint256 raw) private pure returns (uint256) {
        uint256 clamped = raw % 1_000_000_000_000_000_000_000_000_000_000;
        return clamped < 1_000 ? clamped + 1_000 : clamped;
    }

    function _splitViaCall(FeeAccountingHarness accounting, uint256 quote)
        private
        returns (uint256 total, uint256 programmableFee, uint256 treasuryFee, uint256 processFee)
    {
        return accounting.split(quote);
    }

    function _splitResult(FeeAccountingHarness accounting, uint256 quote)
        private
        returns (FeeSplit memory result)
    {
        (result.total, result.programmable, result.treasury, result.process) =
            accounting.split(quote);
    }

    function test_accrualFreezesBeneficiariesAcrossTreasuryRotation() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasuryOne
        ) = _deploy();
        ClaimActor treasuryTwo = new ClaimActor();

        _accrue(token, accounting, QUOTE);
        accounting.rotateTreasury(address(treasuryTwo));
        _accrue(token, accounting, QUOTE);

        _assertEq(accounting.programmableLiability(address(programmable)), 20, "programmable drift");
        _assertEq(accounting.treasuryLiability(address(treasuryOne)), 40, "old treasury rewritten");
        _assertEq(accounting.treasuryLiability(address(treasuryTwo)), 40, "new treasury missing");
        _assertEq(accounting.processLiability(), 500, "process remainder mismatch");
        _assertEq(accounting.totalLiability(), 600, "aggregate liability mismatch");
        _assertSolvent(accounting);
    }

    function test_collectionAndAccrualShareOneMoneyPathLock() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();

        accounting.collectAndAccrue(QUOTE);

        _assertEq(token.balanceOf(address(accounting)), TOTAL_FEE, "collection missing");
        _assertEq(
            accounting.programmableLiability(address(programmable)), 10, "programmable missing"
        );
        _assertEq(accounting.treasuryLiability(address(treasury)), 40, "treasury missing");
        _assertEq(accounting.processLiability(), 250, "process missing");
        _assertSolvent(accounting);
    }

    function test_accrualWithoutOuterMoneyPathReverts() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        token.mint(address(accounting), TOTAL_FEE);

        (bool success,) = address(accounting)
            .call(abi.encodeCall(FeeAccountingHarness.accrueWithoutLock, (QUOTE, 0)));

        _assertFalse(success, "unlocked accrual succeeded");
        _assertEq(accounting.programmableLiability(address(programmable)), 0, "programmable added");
        _assertEq(accounting.treasuryLiability(address(treasury)), 0, "treasury added");
        _assertEq(accounting.processLiability(), 0, "process added");
        _assertEq(accounting.totalLiability(), 0, "aggregate added");
    }

    function test_reentrantCollectionRollsBackTokensAndLiabilities() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        bytes32 beforeDigest = _stateDigest(token, accounting, programmable, treasury);
        token.configureReentry(
            address(accounting), abi.encodeCall(FeeAccountingHarness.collectAndAccrue, (QUOTE))
        );

        (bool success,) =
            address(accounting).call(abi.encodeCall(FeeAccountingHarness.collectAndAccrue, (QUOTE)));

        _assertFalse(success, "reentrant collection succeeded");
        _assertEq(
            uint256(_stateDigest(token, accounting, programmable, treasury)),
            uint256(beforeDigest),
            "reentrant collection changed state"
        );
        _assertSolvent(accounting);
    }

    function test_claimMovesExactBalancesAndOnlyOneLiability() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        token.mint(address(programmable), 7);
        _accrue(token, accounting, QUOTE);

        uint256 hookBefore = token.balanceOf(address(accounting));
        uint256 recipientBefore = token.balanceOf(address(programmable));
        uint256 treasuryBefore = accounting.treasuryLiability(address(treasury));
        uint256 processBefore = accounting.processLiability();

        uint256 claimed = programmable.claimProgrammable(accounting);

        _assertEq(claimed, 10, "wrong claim amount");
        _assertEq(hookBefore - token.balanceOf(address(accounting)), claimed, "wrong source delta");
        _assertEq(
            token.balanceOf(address(programmable)) - recipientBefore,
            claimed,
            "wrong recipient delta"
        );
        _assertEq(accounting.programmableLiability(address(programmable)), 0, "claim not debited");
        _assertEq(
            accounting.treasuryLiability(address(treasury)), treasuryBefore, "treasury changed"
        );
        _assertEq(accounting.processLiability(), processBefore, "process changed");
        _assertEq(accounting.totalLiability(), TOTAL_FEE - claimed, "aggregate debit mismatch");
        _assertSolvent(accounting);
    }

    /// @dev WP-05 acceptance: ProgrammableClaimed/TreasuryClaimed events are emitted with exact
    ///      amounts on every claim (programmable-fee-policy.md's dashboard status page indexes
    ///      claims from these events rather than polling `readFeeLiabilities`).
    function test_claimEmitsProgrammableAndTreasuryClaimedWithExactAmounts() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        _accrue(token, accounting, QUOTE);

        VM.recordLogs();
        uint256 programmableClaimed = programmable.claimProgrammable(accounting);
        _assertClaimedEvent(
            VM.getRecordedLogs(),
            "ProgrammableClaimed(address,uint256)",
            address(accounting),
            address(programmable),
            programmableClaimed
        );
        _assertEq(programmableClaimed, 10, "wrong programmable claim");

        VM.recordLogs();
        uint256 treasuryClaimed = treasury.claimTreasury(accounting);
        _assertClaimedEvent(
            VM.getRecordedLogs(),
            "TreasuryClaimed(address,uint256)",
            address(accounting),
            address(treasury),
            treasuryClaimed
        );
        _assertEq(treasuryClaimed, 40, "wrong treasury claim");
    }

    function test_partialBeneficiaryClaimsUseActualDestinationsAndPreserveRemainders() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        _accrue(token, accounting, QUOTE);
        address programmableDestination = address(0xBEEF);
        address treasuryDestination = address(0xCAFE);
        uint256 programmableRemainderBefore = accounting.programmableRemainder();
        uint256 treasuryRemainderBefore = accounting.treasuryRemainder();
        uint256 processRemainderBefore = accounting.processRemainder();
        uint256 hookBefore = token.balanceOf(address(accounting));

        VM.recordLogs();
        uint256 programmableClaimed =
            programmable.claimProgrammableAmountTo(accounting, 4, programmableDestination);
        _assertClaimedEvent(
            VM.getRecordedLogs(),
            "ProgrammableClaimed(address,uint256)",
            address(accounting),
            programmableDestination,
            programmableClaimed
        );
        _assertEq(programmableClaimed, 4, "wrong programmable partial claim");
        _assertEq(token.balanceOf(programmableDestination), 4, "wrong programmable destination");
        _assertEq(
            accounting.programmableLiability(address(programmable)),
            6,
            "wrong programmable remainder"
        );

        VM.recordLogs();
        uint256 treasuryClaimed =
            treasury.claimTreasuryAmountTo(accounting, 15, treasuryDestination);
        _assertClaimedEvent(
            VM.getRecordedLogs(),
            "TreasuryClaimed(address,uint256)",
            address(accounting),
            treasuryDestination,
            treasuryClaimed
        );
        _assertEq(treasuryClaimed, 15, "wrong treasury partial claim");
        _assertEq(token.balanceOf(treasuryDestination), 15, "wrong treasury destination");
        _assertEq(accounting.treasuryLiability(address(treasury)), 25, "wrong treasury remainder");

        uint256 programmableFinal =
            programmable.claimProgrammableAmountTo(accounting, 6, programmableDestination);
        uint256 treasuryFinal = treasury.claimTreasuryAmountTo(accounting, 25, treasuryDestination);
        _assertEq(programmableFinal, 6, "wrong programmable full claim");
        _assertEq(treasuryFinal, 25, "wrong treasury full claim");
        _assertEq(token.balanceOf(programmableDestination), 10, "wrong programmable final balance");
        _assertEq(token.balanceOf(treasuryDestination), 40, "wrong treasury final balance");
        _assertEq(hookBefore - token.balanceOf(address(accounting)), 50, "wrong total claim delta");
        _assertEq(accounting.programmableLiability(address(programmable)), 0, "programmable left");
        _assertEq(accounting.treasuryLiability(address(treasury)), 0, "treasury left");
        _assertEq(
            accounting.programmableRemainder(),
            programmableRemainderBefore,
            "programmable remainder changed"
        );
        _assertEq(
            accounting.treasuryRemainder(), treasuryRemainderBefore, "treasury remainder changed"
        );
        _assertEq(
            accounting.processRemainder(), processRemainderBefore, "process remainder changed"
        );
        _assertSolvent(accounting);
    }

    function test_historicalTreasuryCanClaimOnlyItsFrozenLiability() external {
        (MockUsdg token, FeeAccountingHarness accounting,, ClaimActor treasuryOne) = _deploy();
        ClaimActor treasuryTwo = new ClaimActor();
        _accrue(token, accounting, QUOTE);
        accounting.rotateTreasury(address(treasuryTwo));
        _accrue(token, accounting, QUOTE);

        uint256 claimed = treasuryOne.claimTreasury(accounting);

        _assertEq(claimed, 40, "wrong historical treasury claim");
        _assertEq(accounting.treasuryLiability(address(treasuryOne)), 0, "old epoch not debited");
        _assertEq(accounting.treasuryLiability(address(treasuryTwo)), 40, "new epoch changed");
        _assertSolvent(accounting);
    }

    function test_threeTreasuryHandoversPreserveEveryEpochAndProcessLiability() external {
        (MockUsdg token, FeeAccountingHarness accounting,, ClaimActor treasuryOne) = _deploy();
        ClaimActor treasuryTwo = new ClaimActor();
        ClaimActor treasuryThree = new ClaimActor();
        ClaimActor treasuryFour = new ClaimActor();

        _accrue(token, accounting, QUOTE);
        accounting.rotateTreasury(address(treasuryTwo));
        _accrue(token, accounting, QUOTE);
        accounting.rotateTreasury(address(treasuryThree));
        _accrue(token, accounting, QUOTE);
        accounting.rotateTreasury(address(treasuryFour));
        _accrue(token, accounting, QUOTE);
        uint256 processBeforeClaims = accounting.processLiability();

        treasuryOne.claimTreasury(accounting);
        treasuryTwo.claimTreasury(accounting);
        treasuryThree.claimTreasury(accounting);
        treasuryFour.claimTreasury(accounting);

        _assertEq(token.balanceOf(address(treasuryOne)), 40, "epoch one claim mismatch");
        _assertEq(token.balanceOf(address(treasuryTwo)), 40, "epoch two claim mismatch");
        _assertEq(token.balanceOf(address(treasuryThree)), 40, "epoch three claim mismatch");
        _assertEq(token.balanceOf(address(treasuryFour)), 40, "epoch four claim mismatch");
        _assertEq(accounting.treasuryLiability(address(treasuryOne)), 0, "epoch one remains");
        _assertEq(accounting.treasuryLiability(address(treasuryTwo)), 0, "epoch two remains");
        _assertEq(accounting.treasuryLiability(address(treasuryThree)), 0, "epoch three remains");
        _assertEq(accounting.treasuryLiability(address(treasuryFour)), 0, "epoch four remains");
        _assertEq(
            accounting.processLiability(), processBeforeClaims, "claims changed process liability"
        );
        _assertSolvent(accounting);
    }

    function test_zeroOrWrongBeneficiaryCannotClaim() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        ClaimActor stranger = new ClaimActor();
        _accrue(token, accounting, QUOTE);
        bytes32 beforeDigest = _stateDigest(token, accounting, programmable, treasury);

        (bool wrongProgrammable,) =
            address(stranger).call(abi.encodeCall(ClaimActor.claimProgrammable, (accounting)));
        (bool wrongTreasury,) =
            address(stranger).call(abi.encodeCall(ClaimActor.claimTreasury, (accounting)));

        _assertFalse(wrongProgrammable, "stranger claimed programmable liability");
        _assertFalse(wrongTreasury, "stranger claimed treasury liability");
        _assertEq(
            uint256(_stateDigest(token, accounting, programmable, treasury)),
            uint256(beforeDigest),
            "rejected claimant changed state"
        );
    }

    function test_processAndPayoutTransitionsPreserveGlobalSolvency() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        ClaimActor processRecipient = new ClaimActor();
        ClaimActor holder = new ClaimActor();
        bytes32 payoutId = keccak256("payout-1");
        _accrue(token, accounting, QUOTE);

        accounting.fundPayout(payoutId, 100);
        _assertEq(accounting.processLiability(), 150, "funding debited wrong process amount");
        _assertEq(accounting.payoutLiability(payoutId), 100, "funding credited wrong payout");
        _assertEq(accounting.totalLiability(), 300, "funding changed aggregate liability");
        _assertSolvent(accounting);

        accounting.payPayout(payoutId, address(holder), 60);
        _assertEq(accounting.payoutLiability(payoutId), 40, "payment debited wrong payout");
        _assertEq(token.balanceOf(address(holder)), 60, "holder received wrong amount");
        _assertEq(accounting.totalLiability(), 240, "payment changed wrong aggregate amount");
        _assertSolvent(accounting);

        accounting.releaseProcess(address(processRecipient), 50);
        _assertEq(accounting.processLiability(), 100, "release debited wrong process amount");
        _assertEq(token.balanceOf(address(processRecipient)), 50, "process received wrong amount");
        _assertEq(accounting.totalLiability(), 190, "release changed wrong aggregate amount");
        _assertSolvent(accounting);

        programmable.claimProgrammable(accounting);
        treasury.claimTreasury(accounting);
        _assertEq(accounting.totalLiability(), 140, "final aggregate liability mismatch");
        _assertEq(accounting.hookUsdgBalance(), 140, "final backing mismatch");
        _assertSolvent(accounting);
    }

    function test_falseReturnLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.ReturnFalse);
    }

    function test_revertedTransferLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.RevertTransfer);
    }

    function test_malformedReturnLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.MalformedReturn);
    }

    function test_shortSourceDeltaLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.ShortSource);
    }

    function test_shortDestinationDeltaLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.ShortDestination);
    }

    function test_excessSourceDeltaLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.ExcessSource);
    }

    function test_excessDestinationDeltaLeavesAccountingAndBalancesUnchanged() external {
        _assertFailedClaim(MockUsdg.Behavior.ExcessDestination);
    }

    function test_reentrantClaimLeavesAccountingAndBalancesUnchanged() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        _accrue(token, accounting, QUOTE);
        token.configureReentry(
            address(programmable), abi.encodeCall(ClaimActor.claimProgrammable, (accounting))
        );

        _assertClaimRevertsUnchanged(token, accounting, programmable, treasury);
    }

    function test_releaseRollsBackForEveryAdversarialTokenBehavior() external {
        MockUsdg.Behavior[8] memory behaviors = _adversarialBehaviors();
        for (uint256 i; i < behaviors.length; ++i) {
            _assertFailedRelease(behaviors[i]);
        }
    }

    function test_payoutPaymentRollsBackForEveryAdversarialTokenBehavior() external {
        MockUsdg.Behavior[8] memory behaviors = _adversarialBehaviors();
        for (uint256 i; i < behaviors.length; ++i) {
            _assertFailedPayoutPayment(behaviors[i]);
        }
    }

    function test_wrongCollectionDeltaCreatesNoLiability() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        uint256 balanceBefore = token.balanceOf(address(accounting));
        token.mint(address(accounting), TOTAL_FEE - 1);

        (bool success,) = address(accounting)
            .call(abi.encodeCall(FeeAccountingHarness.accrue, (QUOTE, balanceBefore)));

        _assertFalse(success, "short collection was accepted");
        _assertEq(
            accounting.programmableLiability(address(programmable)), 0, "invented programmable"
        );
        _assertEq(accounting.treasuryLiability(address(treasury)), 0, "invented treasury");
        _assertEq(accounting.processLiability(), 0, "invented process");
        _assertEq(accounting.totalLiability(), 0, "invented aggregate liability");
        _assertSolvent(accounting);
    }

    function test_excessCollectionDeltaCreatesNoLiability() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        uint256 balanceBefore = token.balanceOf(address(accounting));
        token.mint(address(accounting), TOTAL_FEE + 1);

        (bool success,) = address(accounting)
            .call(abi.encodeCall(FeeAccountingHarness.accrue, (QUOTE, balanceBefore)));

        _assertFalse(success, "excess collection was accepted");
        _assertEq(
            accounting.programmableLiability(address(programmable)), 0, "invented programmable"
        );
        _assertEq(accounting.treasuryLiability(address(treasury)), 0, "invented treasury");
        _assertEq(accounting.processLiability(), 0, "invented process");
        _assertEq(accounting.totalLiability(), 0, "invented aggregate liability");
        _assertSolvent(accounting);
    }

    function test_directSurplusCreatesNoLiabilityAndPreservesSolvency() external {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        _accrue(token, accounting, QUOTE);
        uint256 totalBefore = accounting.totalLiability();
        token.mint(address(accounting), 123);

        _assertEq(accounting.totalLiability(), totalBefore, "surplus invented liability");
        _assertEq(
            accounting.programmableLiability(address(programmable)), 10, "programmable changed"
        );
        _assertEq(accounting.treasuryLiability(address(treasury)), 40, "treasury changed");
        _assertEq(accounting.solvencyMargin(), 123, "wrong surplus margin");
        _assertSolvent(accounting);
    }

    function _assertFailedClaim(MockUsdg.Behavior behavior) private {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        _accrue(token, accounting, QUOTE);
        token.setBehavior(behavior);
        _assertClaimRevertsUnchanged(token, accounting, programmable, treasury);
    }

    function _assertFailedRelease(MockUsdg.Behavior behavior) private {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        ClaimActor recipient = new ClaimActor();
        _accrue(token, accounting, QUOTE);
        _configureTransferBehavior(
            token,
            behavior,
            address(accounting),
            abi.encodeCall(FeeAccountingHarness.releaseProcess, (address(recipient), 50))
        );
        bytes32 beforeDigest =
            _transitionDigest(token, accounting, programmable, treasury, recipient, bytes32(0));

        (bool success,) = address(accounting)
            .call(abi.encodeCall(FeeAccountingHarness.releaseProcess, (address(recipient), 50)));

        _assertFalse(success, "adversarial release succeeded");
        _assertEq(
            uint256(
                _transitionDigest(token, accounting, programmable, treasury, recipient, bytes32(0))
            ),
            uint256(beforeDigest),
            "failed release changed state"
        );
        token.setBehavior(MockUsdg.Behavior.Normal);
        _assertSolvent(accounting);
    }

    function _assertFailedPayoutPayment(MockUsdg.Behavior behavior) private {
        (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        ) = _deploy();
        ClaimActor recipient = new ClaimActor();
        bytes32 payoutId = keccak256("adversarial-payout");
        _accrue(token, accounting, QUOTE);
        accounting.fundPayout(payoutId, 100);
        _configureTransferBehavior(
            token,
            behavior,
            address(accounting),
            abi.encodeCall(FeeAccountingHarness.payPayout, (payoutId, address(recipient), 60))
        );
        bytes32 beforeDigest =
            _transitionDigest(token, accounting, programmable, treasury, recipient, payoutId);

        (bool success,) = address(accounting)
            .call(
                abi.encodeCall(FeeAccountingHarness.payPayout, (payoutId, address(recipient), 60))
            );

        _assertFalse(success, "adversarial payout payment succeeded");
        _assertEq(
            uint256(
                _transitionDigest(token, accounting, programmable, treasury, recipient, payoutId)
            ),
            uint256(beforeDigest),
            "failed payout payment changed state"
        );
        token.setBehavior(MockUsdg.Behavior.Normal);
        _assertSolvent(accounting);
    }

    function _configureTransferBehavior(
        MockUsdg token,
        MockUsdg.Behavior behavior,
        address reentryTarget,
        bytes memory reentryCall
    ) private {
        if (behavior == MockUsdg.Behavior.Reenter) {
            token.configureReentry(reentryTarget, reentryCall);
        } else {
            token.setBehavior(behavior);
        }
    }

    function _adversarialBehaviors() private pure returns (MockUsdg.Behavior[8] memory behaviors) {
        behaviors[0] = MockUsdg.Behavior.RevertTransfer;
        behaviors[1] = MockUsdg.Behavior.ReturnFalse;
        behaviors[2] = MockUsdg.Behavior.MalformedReturn;
        behaviors[3] = MockUsdg.Behavior.ShortSource;
        behaviors[4] = MockUsdg.Behavior.ShortDestination;
        behaviors[5] = MockUsdg.Behavior.ExcessSource;
        behaviors[6] = MockUsdg.Behavior.ExcessDestination;
        behaviors[7] = MockUsdg.Behavior.Reenter;
    }

    function _assertClaimRevertsUnchanged(
        MockUsdg token,
        FeeAccountingHarness accounting,
        ClaimActor programmable,
        ClaimActor treasury
    ) private {
        bytes32 beforeDigest = _stateDigest(token, accounting, programmable, treasury);

        (bool success,) =
            address(programmable).call(abi.encodeCall(ClaimActor.claimProgrammable, (accounting)));

        _assertFalse(success, "adversarial claim succeeded");
        _assertEq(
            uint256(_stateDigest(token, accounting, programmable, treasury)),
            uint256(beforeDigest),
            "failed claim changed state"
        );
        _assertSolvent(accounting);
    }

    function _stateDigest(
        MockUsdg token,
        FeeAccountingHarness accounting,
        ClaimActor programmable,
        ClaimActor treasury
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                token.balanceOf(address(accounting)),
                token.balanceOf(address(programmable)),
                accounting.programmableLiability(address(programmable)),
                accounting.treasuryLiability(address(treasury)),
                accounting.processLiability(),
                accounting.payoutLiability(),
                accounting.totalLiability()
            )
        );
    }

    function _transitionDigest(
        MockUsdg token,
        FeeAccountingHarness accounting,
        ClaimActor programmable,
        ClaimActor treasury,
        ClaimActor recipient,
        bytes32 payoutId
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                token.balanceOf(address(accounting)),
                token.balanceOf(address(programmable)),
                token.balanceOf(address(treasury)),
                token.balanceOf(address(recipient)),
                accounting.programmableLiability(address(programmable)),
                accounting.treasuryLiability(address(treasury)),
                accounting.processLiability(),
                accounting.payoutLiability(payoutId),
                accounting.payoutLiability(),
                accounting.totalLiability()
            )
        );
    }

    function _deploy()
        private
        returns (
            MockUsdg token,
            FeeAccountingHarness accounting,
            ClaimActor programmable,
            ClaimActor treasury
        )
    {
        token = new MockUsdg();
        programmable = new ClaimActor();
        treasury = new ClaimActor();
        accounting = new FeeAccountingHarness(token, address(programmable), address(treasury));
    }

    function _accrue(MockUsdg token, FeeAccountingHarness accounting, uint256 quote) private {
        token;
        accounting.collectAndAccrue(quote);
        _assertSolvent(accounting);
    }

    function _assertSplit(
        FeeAccountingHarness accounting,
        uint256 quote,
        uint256 total,
        uint256 programmable,
        uint256 treasury,
        uint256 process
    ) private {
        (
            uint256 actualTotal,
            uint256 actualProgrammable,
            uint256 actualTreasury,
            uint256 actualProcess
        ) = accounting.split(quote);
        _assertEq(actualTotal, total, "total rounding mismatch");
        _assertEq(actualProgrammable, programmable, "programmable rounding mismatch");
        _assertEq(actualTreasury, treasury, "treasury rounding mismatch");
        _assertEq(actualProcess, process, "process rounding mismatch");
    }

    function _assertSolvent(FeeAccountingHarness accounting) private view {
        _assertTrue(accounting.isSolvent(), "accounting is insolvent");
        _assertTrue(
            accounting.hookUsdgBalance() >= accounting.totalLiability(),
            "balance is below aggregate liability"
        );
    }

    function _assertSwapLiabilityEvent(
        Vm.Log[] memory logs,
        FeeAccountingHarness accounting,
        address programmable,
        address treasury
    ) private pure {
        bytes32 signature = keccak256(
            "SwapLiabilitiesAccrued(uint256,uint256,address,uint256,address,uint256,uint256,uint256,uint256,uint256)"
        );
        bool found;
        for (uint256 index; index < logs.length; ++index) {
            Vm.Log memory entry = logs[index];
            if (entry.emitter != address(accounting) || entry.topics.length != 3) continue;
            if (entry.topics[0] != signature) continue;
            assert(address(uint160(uint256(entry.topics[1]))) == programmable);
            assert(address(uint160(uint256(entry.topics[2]))) == treasury);
            (
                uint256 executedUsdg,
                uint256 totalFee,
                uint256 programmableFee,
                uint256 treasuryFee,
                uint256 processFee,
                uint256 programmableRemainderAfter,
                uint256 treasuryRemainderAfter,
                uint256 processRemainderAfter
            ) = abi.decode(
                entry.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
            );
            assert(executedUsdg == QUOTE);
            assert(totalFee == TOTAL_FEE);
            assert(programmableFee == 10);
            assert(treasuryFee == 40);
            assert(processFee == 250);
            // QUOTE (10,000) divides BPS_DENOMINATOR exactly, so this swap leaves no carried dust.
            assert(programmableRemainderAfter == 0);
            assert(treasuryRemainderAfter == 0);
            assert(processRemainderAfter == 0);
            found = true;
        }
        assert(found);
    }

    function _assertClaimedEvent(
        Vm.Log[] memory logs,
        string memory signatureText,
        address emitter,
        address beneficiary,
        uint256 amount
    ) private pure {
        bytes32 signature = keccak256(bytes(signatureText));
        bool found;
        for (uint256 index; index < logs.length; ++index) {
            Vm.Log memory entry = logs[index];
            if (entry.emitter != emitter || entry.topics.length != 2) continue;
            if (entry.topics[0] != signature) continue;
            assert(address(uint160(uint256(entry.topics[1]))) == beneficiary);
            assert(abi.decode(entry.data, (uint256)) == amount);
            found = true;
        }
        assert(found);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory reason) private pure {
        require(actual == expected, reason);
    }

    function _assertTrue(bool value, string memory reason) private pure {
        require(value, reason);
    }

    function _assertFalse(bool value, string memory reason) private pure {
        require(!value, reason);
    }
}

contract FeeAccountingHarness is FeeAccounting {
    MockUsdg private immutable TOKEN;
    address private currentTreasury;

    constructor(MockUsdg token, address programmable, address treasury)
        FeeAccounting(programmable)
    {
        TOKEN = token;
        currentTreasury = treasury;
    }

    function rotateTreasury(address treasury) external {
        currentTreasury = treasury;
    }

    function accrue(uint256 quote, uint256 balanceBeforeCollection) external moneyPath {
        _accrueAuthenticatedSwap(quote, balanceBeforeCollection);
    }

    function accrueWithoutLock(uint256 quote, uint256 balanceBeforeCollection) external {
        _accrueAuthenticatedSwap(quote, balanceBeforeCollection);
    }

    function collectAndAccrue(uint256 quote) external moneyPath {
        uint256 fee = _previewTotalFee(quote);
        uint256 balanceBeforeCollection = _hookUsdgBalance();
        if (!_callToken(abi.encodeCall(MockUsdg.collect, (address(this), fee)))) {
            revert TokenTransferFailed();
        }
        _accrueAuthenticatedSwap(quote, balanceBeforeCollection);
    }

    function claimProgrammable() external returns (uint256) {
        return _claimProgrammableLiability();
    }

    function claimTreasury() external returns (uint256) {
        return _claimTreasuryLiability();
    }

    function claimProgrammable(uint256 amount, address destination) external returns (uint256) {
        return _claimProgrammableLiability(amount, destination);
    }

    function claimTreasury(uint256 amount, address destination) external returns (uint256) {
        return _claimTreasuryLiability(amount, destination);
    }

    /// @dev Commits the same cumulative-remainder mutation `_accrueAuthenticatedSwap` would, so
    ///      calling this repeatedly simulates a sequence of swaps for rounding/carry tests.
    function split(uint256 quote)
        external
        returns (uint256 total, uint256 programmable, uint256 treasury, uint256 process)
    {
        return _splitLiability(quote);
    }

    function previewSplit(uint256 quote) external view returns (uint256 total) {
        return _previewTotalFee(quote);
    }

    function programmableRemainder() external view returns (uint256) {
        return _programmableRemainder();
    }

    function treasuryRemainder() external view returns (uint256) {
        return _treasuryRemainder();
    }

    function processRemainder() external view returns (uint256) {
        return _processRemainder();
    }

    function programmableLiability(address beneficiary) external view returns (uint256) {
        return _programmableLiabilityOf(beneficiary);
    }

    function treasuryLiability(address beneficiary) external view returns (uint256) {
        return _treasuryLiabilityOf(beneficiary);
    }

    function processLiability() external view returns (uint256) {
        return _processLiability();
    }

    function payoutLiability() external view returns (uint256) {
        return _totalPayoutLiability();
    }

    function payoutLiability(bytes32 payoutId) external view returns (uint256) {
        return _payoutLiabilityOf(payoutId);
    }

    function fundPayout(bytes32 payoutId, uint256 amount) external moneyPath {
        _debitProcessLiability(amount);
        _creditPayoutLiability(payoutId, amount);
    }

    function payPayout(bytes32 payoutId, address recipient, uint256 amount) external moneyPath {
        _debitPayoutLiability(payoutId, amount);
        _transferExactUsdg(recipient, amount);
        _requireSolvent();
    }

    function releaseProcess(address recipient, uint256 amount) external moneyPath {
        _debitProcessLiability(amount);
        _transferExactUsdg(recipient, amount);
        _requireSolvent();
    }

    function totalLiability() external view returns (uint256) {
        return _totalLiability();
    }

    function hookUsdgBalance() external view returns (uint256) {
        return _hookUsdgBalance();
    }

    function isSolvent() external view returns (bool) {
        return _isSolvent();
    }

    function solvencyMargin() external view returns (uint256) {
        return _solvencyMargin();
    }

    function _currentTreasuryBeneficiary() internal view override returns (address) {
        return currentTreasury;
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return TOKEN.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return _callToken(abi.encodeCall(MockUsdg.transfer, (recipient, amount)));
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

contract ClaimActor {
    function claimProgrammable(FeeAccountingHarness accounting) external returns (uint256) {
        return accounting.claimProgrammable();
    }

    function claimTreasury(FeeAccountingHarness accounting) external returns (uint256) {
        return accounting.claimTreasury();
    }

    function claimProgrammableAmountTo(
        FeeAccountingHarness accounting,
        uint256 amount,
        address destination
    ) external returns (uint256) {
        return accounting.claimProgrammable(amount, destination);
    }

    function claimTreasuryAmountTo(
        FeeAccountingHarness accounting,
        uint256 amount,
        address destination
    ) external returns (uint256) {
        return accounting.claimTreasury(amount, destination);
    }
}

contract MockUsdg {
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

    mapping(address account => uint256 balance) private balances;
    Behavior private behavior;
    address private reentryTarget;
    bytes private reentryCall;

    error TransferReverted();
    error ReentryRejected();

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function collect(address recipient, uint256 amount) external returns (bool) {
        Behavior active = behavior;
        if (active == Behavior.RevertTransfer) revert TransferReverted();
        if (active == Behavior.ReturnFalse) return false;
        balances[recipient] += amount;
        if (active == Behavior.Reenter) {
            (bool success,) = reentryTarget.call(reentryCall);
            if (!success) revert ReentryRejected();
        }
        if (active == Behavior.MalformedReturn) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return true;
    }

    function setBehavior(Behavior nextBehavior) external {
        behavior = nextBehavior;
    }

    function configureReentry(address target, bytes calldata callData) external {
        reentryTarget = target;
        reentryCall = callData;
        behavior = Behavior.Reenter;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        Behavior active = behavior;
        if (active == Behavior.RevertTransfer) revert TransferReverted();
        if (active == Behavior.ReturnFalse) return false;
        if (active == Behavior.Reenter) {
            (bool success,) = reentryTarget.call(reentryCall);
            if (!success) revert ReentryRejected();
        }

        uint256 sourceDelta = active == Behavior.ShortSource
            ? amount - 1
            : active == Behavior.ExcessSource ? amount + 1 : amount;
        uint256 destinationDelta = active == Behavior.ShortDestination
            ? amount - 1
            : active == Behavior.ExcessDestination ? amount + 1 : amount;
        balances[msg.sender] -= sourceDelta;
        balances[recipient] += destinationDelta;
        if (active == Behavior.MalformedReturn) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return true;
    }
}
