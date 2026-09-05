// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { StdInvariant } from "../../lib/v4-core/lib/forge-std/src/StdInvariant.sol";
import { FeeAccountingHarness, MockUsdg, ClaimActor } from "./FeeAccounting.t.sol";

contract FeeAccountingInvariantTest is StdInvariant {
    FeeAccountingInvariantHandler private handler;

    function setUp() public {
        handler = new FeeAccountingInvariantHandler();

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.accrue.selector;
        selectors[1] = handler.claimProgrammable.selector;
        selectors[2] = handler.claimTreasury.selector;
        selectors[3] = handler.fundPayout.selector;
        selectors[4] = handler.payPayout.selector;
        selectors[5] = handler.releaseProcess.selector;
        selectors[6] = handler.attemptFailedTransition.selector;
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
    }

    function invariant_failedTransitionsAlwaysRollBack() external view {
        require(!handler.rollbackViolation(), "failed money path changed state");
    }

    /// @dev Each 10/40/250-bps stream stores only the unallocated fractional numerator. Claims
    ///      may clear liabilities, but can never grow, reset, or merge this lifetime state.
    function invariant_eachLifetimeRemainderStaysWithinOneBasisPointDenominator() external view {
        FeeAccountingHarness accounting = handler.accounting();
        require(accounting.programmableRemainder() < 10_000, "programmable remainder out of range");
        require(accounting.treasuryRemainder() < 10_000, "treasury remainder out of range");
        require(accounting.processRemainder() < 10_000, "process remainder out of range");
    }
}

contract FeeAccountingInvariantHandler {
    uint256 private constant MAX_QUOTE = 1_000_000_000_000;
    uint256 private constant MIN_POSITIVE_FEE_QUOTE = 1_000;
    uint256 private constant PAYOUT_COUNT = 4;
    uint256 private constant TREASURY_COUNT = 4;

    MockUsdg public immutable token;
    FeeAccountingHarness public immutable accounting;
    ClaimActor public immutable programmable;
    ClaimActor public immutable processRecipient;
    ClaimActor[PAYOUT_COUNT] private holders;
    ClaimActor[TREASURY_COUNT] private treasuries;
    bool public rollbackViolation;

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

    function attemptFailedTransition(uint8 rawPath, uint8 rawBehavior, uint96 rawAmount) external {
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
                uint256 funding = accounting.processLiability();
                accounting.fundPayout(payoutId, funding);
                available = funding;
            }
            uint256 payoutIndex = rawPath % PAYOUT_COUNT;
            uint256 amount = uint256(rawAmount) % available + 1;
            recipient = address(holders[payoutIndex]);
            callTarget = address(accounting);
            callData = abi.encodeCall(FeeAccountingHarness.payPayout, (payoutId, recipient, amount));
        }

        MockUsdg.Behavior behavior = MockUsdg.Behavior(rawBehavior % 8 + 1);
        if (behavior == MockUsdg.Behavior.Reenter) {
            token.configureReentry(callTarget, callData);
        } else {
            token.setBehavior(behavior);
        }
        bytes32 beforeDigest = _transitionDigest(recipient);
        (bool success,) = callTarget.call(callData);
        if (success || _transitionDigest(recipient) != beforeDigest) rollbackViolation = true;
        token.setBehavior(MockUsdg.Behavior.Normal);
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

    function _transitionDigest(address recipient) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                token.balanceOf(address(accounting)),
                token.balanceOf(recipient),
                aggregateKnownLiability(),
                accounting.totalLiability()
            )
        );
    }

    function _payoutId(uint256 rawPayout) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("invariant-payout", rawPayout % PAYOUT_COUNT));
    }
}
