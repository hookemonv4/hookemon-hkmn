// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Blind adversarial property/fuzz tests for the FeeAccounting ledger (requirements.json rev 62,
// spec statement (1)). These tests deliberately avoid reusing expected numeric values from
// test/access/ProcessClaims.t.sol or test/integration/HookemonHook.t.sol; the oracle here is
// derived directly from the specification's own fee-split math, not from any existing test file.
//
// Independent oracle for a *single* accrual on a freshly-deployed hook (all three cumulative
// remainders start at 0): because
//     increment = floor((remainderBefore + executedUsdg * rateBps) / 10_000)
// with remainderBefore == 0, increment == floor(executedUsdg * rateBps / 10_000) exactly. This
// also holds for the *sum* of any sequence of accruals starting from remainder 0, because the
// remainder carries losslessly between calls (see the algebraic derivation in the test comments
// below), so splitting one gross volume into N accruals must reproduce the same three lifetime
// totals as a single unsplit accrual of the sum.

import { Test } from "@uniswap/v4-core/lib/forge-std/src/Test.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";

import { FeeAccounting } from "../../../src/accounting/FeeAccounting.sol";
import { MoneyRoles } from "../../../src/access/MoneyRoles.sol";
import { RobinhoodBindings } from "../../../src/bindings/RobinhoodBindings.sol";
import { HookemonHook } from "../../../src/HookemonHook.sol";

contract BlindFeeToken {
    mapping(address account => uint256 balance) private balances;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function burn(address account, uint256 amount) external {
        balances[account] -= amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[recipient] += amount;
        return true;
    }
}

/// @dev Exposes the internal accrual/preview/remainder primitives so the ledger math can be
///      fuzzed directly, independent of the Uniswap v4 swap machinery (which is exercised
///      separately in SwapQuadrantsBlind.t.sol).
contract FeeAccountingBlindHarness is HookemonHook {
    BlindFeeToken private immutable usdgToken;

    constructor(HookemonHook.ConstructorConfig memory config, BlindFeeToken configuredToken)
        HookemonHook(config)
    {
        usdgToken = configuredToken;
    }

    function accrueForTest(uint256 executedUsdg) external moneyPath {
        uint256 fee = _previewTotalFee(executedUsdg);
        uint256 balanceBeforeCollection = _hookUsdgBalance();
        usdgToken.mint(address(this), fee);
        _accrueAuthenticatedSwap(executedUsdg, balanceBeforeCollection);
    }

    function programmableRemainderView() external view returns (uint256) {
        return _programmableRemainder();
    }

    function treasuryRemainderView() external view returns (uint256) {
        return _treasuryRemainder();
    }

    function processRemainderView() external view returns (uint256) {
        return _processRemainder();
    }

    function previewFeeView(uint256 executedUsdg) external view returns (uint256) {
        return _previewTotalFee(executedUsdg);
    }
}

contract FeeAccountingBlindFactory {
    HookemonHook.ConstructorConfig private config;
    BlindFeeToken private immutable token;

    constructor(HookemonHook.ConstructorConfig memory configured, BlindFeeToken configuredToken) {
        config = configured;
        token = configuredToken;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(FeeAccountingBlindHarness).creationCode, abi.encode(config, token)
            )
        );
    }

    function deploy(bytes32 salt) external returns (FeeAccountingBlindHarness) {
        return new FeeAccountingBlindHarness{ salt: salt }(config, token);
    }
}

contract FeeAccountingBlindTest is Test {
    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0x9100);
    address private constant OPERATIONS = address(0x9200);

    BlindFeeToken private token;

    function setUp() external {
        vm.warp(2_000_000);
        token = new BlindFeeToken();
    }

    // ---------------------------------------------------------------------
    // (1) Split-vs-unsplit lifetime-total equality.
    // ---------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 200
    function testFuzz_SplitVsUnsplitCumulativeFeesMatchIndependentFloorFormula(
        uint64 rawA,
        uint64 rawB,
        uint64 rawC,
        uint64 rawD
    ) external {
        uint256 a = bound(uint256(rawA), 1_000, 1_000_000_000);
        uint256 b = bound(uint256(rawB), 1_000, 1_000_000_000);
        uint256 c = bound(uint256(rawC), 1_000, 1_000_000_000);
        uint256 d = bound(uint256(rawD), 1_000, 1_000_000_000);
        uint256 total = a + b + c + d;

        FeeAccountingBlindHarness split = _deploy();
        split.accrueForTest(a);
        split.accrueForTest(b);
        split.accrueForTest(c);
        split.accrueForTest(d);

        FeeAccountingBlindHarness unsplit = _deploy();
        unsplit.accrueForTest(total);

        (uint256 pSplit, uint256 tSplit, uint256 prSplit) = split.readFeeLiabilities(TREASURY);
        (uint256 pUnsplit, uint256 tUnsplit, uint256 prUnsplit) =
            unsplit.readFeeLiabilities(TREASURY);

        assertEq(pSplit, pUnsplit, "programmable stream diverged across split");
        assertEq(tSplit, tUnsplit, "treasury stream diverged across split");
        assertEq(prSplit, prUnsplit, "process stream diverged across split");
        assertEq(split.totalLiability(), unsplit.totalLiability(), "total liability diverged");

        // Independent oracle straight from the specification's bps constants (10 / 40 / 250 of
        // 10_000), not read from the contract under test.
        assertEq(pUnsplit, (total * 10) / 10_000, "programmable != floor(total*10/10000)");
        assertEq(tUnsplit, (total * 40) / 10_000, "treasury != floor(total*40/10000)");
        assertEq(prUnsplit, (total * 250) / 10_000, "process != floor(total*250/10000)");
        assertEq(unsplit.totalLiability(), pUnsplit + tUnsplit + prUnsplit);
    }

    /// @dev Same property but with many (16) tiny fragments, to stress the remainder-carry path
    ///      far more aggressively than a 4-way split.
    function testManyTinyFragmentsMatchSingleUnsplitAccrual() external {
        FeeAccountingBlindHarness split = _deploy();
        uint256 total;
        for (uint256 i; i < 16; ++i) {
            uint256 amount = 1_000 + i * 37;
            split.accrueForTest(amount);
            total += amount;
        }

        FeeAccountingBlindHarness unsplit = _deploy();
        unsplit.accrueForTest(total);

        (uint256 pSplit, uint256 tSplit, uint256 prSplit) = split.readFeeLiabilities(TREASURY);
        (uint256 pUnsplit, uint256 tUnsplit, uint256 prUnsplit) =
            unsplit.readFeeLiabilities(TREASURY);
        assertEq(pSplit, pUnsplit);
        assertEq(tSplit, tUnsplit);
        assertEq(prSplit, prUnsplit);
        assertEq(pUnsplit, (total * 10) / 10_000);
        assertEq(tUnsplit, (total * 40) / 10_000);
        assertEq(prUnsplit, (total * 250) / 10_000);
    }

    // ---------------------------------------------------------------------
    // (1) 1000-unit minimum boundary.
    // ---------------------------------------------------------------------

    function testFuzz_SubMinimumGrossReverts(uint256 raw) external {
        uint256 amount = bound(raw, 1, 999);
        FeeAccountingBlindHarness hook = _deploy();
        vm.expectRevert(FeeAccounting.SwapBelowMinimumQuote.selector);
        hook.accrueForTest(amount);
        assertEq(hook.totalLiability(), 0, "failed accrual must not mutate liabilities");
    }

    function testExactlyOneThousandSucceedsAndNineHundredNinetyNineReverts() external {
        FeeAccountingBlindHarness hook = _deploy();
        vm.expectRevert(FeeAccounting.SwapBelowMinimumQuote.selector);
        hook.accrueForTest(999);

        hook.accrueForTest(1_000);
        assertEq(hook.totalLiability(), 30, "3.00% of 1000 must be exactly 30");
        assertTrue(hook.isSolvent());
    }

    // ---------------------------------------------------------------------
    // (2)/(3) Claims never mutate the accrual remainders.
    // ---------------------------------------------------------------------

    function testFuzz_ClaimsNeverAlterAccrualRemainders(
        uint64 rawAccrual,
        uint64 rawProgClaim,
        uint64 rawTreasuryClaim,
        uint64 rawProcessClaim,
        bytes32 cycleSeed
    ) external {
        FeeAccountingBlindHarness hook = _deploy();
        uint256 amount = bound(uint256(rawAccrual), 1_000, 1_000_000_000);
        hook.accrueForTest(amount);

        uint256 progRemainderBefore = hook.programmableRemainderView();
        uint256 treasuryRemainderBefore = hook.treasuryRemainderView();
        uint256 processRemainderBefore = hook.processRemainderView();

        (uint256 progLiability, uint256 treasuryLiability,) = hook.readFeeLiabilities(TREASURY);
        uint256 processLiability = hook.processLiability();

        if (progLiability > 0) {
            uint256 claimAmount = bound(uint256(rawProgClaim), 1, progLiability);
            vm.prank(PROGRAMMABLE);
            hook.claimProgrammable(claimAmount, PROGRAMMABLE);
        }
        if (treasuryLiability > 0) {
            uint256 claimAmount = bound(uint256(rawTreasuryClaim), 1, treasuryLiability);
            vm.prank(TREASURY);
            hook.claimTreasury(claimAmount, TREASURY);
        }
        if (processLiability > 0) {
            uint256 claimAmount = bound(uint256(rawProcessClaim), 1, processLiability);
            bytes32 cycleId = cycleSeed == bytes32(0) ? bytes32(uint256(1)) : cycleSeed;
            vm.prank(OPERATIONS);
            hook.claimProcess(cycleId, claimAmount, OPERATIONS);
        }

        assertEq(hook.programmableRemainderView(), progRemainderBefore);
        assertEq(hook.treasuryRemainderView(), treasuryRemainderBefore);
        assertEq(hook.processRemainderView(), processRemainderBefore);
    }

    // ---------------------------------------------------------------------
    // (1)/(2)/(3) Solvency across random accrual/claim sequences.
    // ---------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 200
    function testFuzz_SolvencyHoldsAcrossRandomAccrualAndClaimSequence(
        uint64 rawA1,
        uint64 rawA2,
        uint64 rawA3,
        uint64 rawClaimProg,
        uint64 rawClaimTreasury,
        uint64 rawClaimProcess,
        bytes32 cycleSeed
    ) external {
        FeeAccountingBlindHarness hook = _deploy();

        _accrueIfAboveMinimum(hook, bound(uint256(rawA1), 0, 1_000_000_000));
        assertGe(hook.hookUsdgBalance(), hook.totalLiability());
        _accrueIfAboveMinimum(hook, bound(uint256(rawA2), 0, 1_000_000_000));
        assertGe(hook.hookUsdgBalance(), hook.totalLiability());
        _accrueIfAboveMinimum(hook, bound(uint256(rawA3), 0, 1_000_000_000));
        assertGe(hook.hookUsdgBalance(), hook.totalLiability());

        (uint256 progLiability,,) = hook.readFeeLiabilities(TREASURY);
        if (progLiability > 0) {
            vm.prank(PROGRAMMABLE);
            hook.claimProgrammable(bound(uint256(rawClaimProg), 1, progLiability), PROGRAMMABLE);
        }
        assertGe(hook.hookUsdgBalance(), hook.totalLiability());

        (, uint256 treasuryLiability,) = hook.readFeeLiabilities(TREASURY);
        if (treasuryLiability > 0) {
            vm.prank(TREASURY);
            hook.claimTreasury(bound(uint256(rawClaimTreasury), 1, treasuryLiability), TREASURY);
        }
        assertGe(hook.hookUsdgBalance(), hook.totalLiability());

        uint256 processLiability = hook.processLiability();
        if (processLiability > 0) {
            bytes32 cycleId = cycleSeed == bytes32(0) ? bytes32(uint256(7)) : cycleSeed;
            vm.prank(OPERATIONS);
            hook.claimProcess(
                cycleId, bound(uint256(rawClaimProcess), 1, processLiability), OPERATIONS
            );
        }

        assertGe(hook.hookUsdgBalance(), hook.totalLiability(), "insolvent after claim sequence");
        (uint256 pFinal, uint256 tFinal,) = hook.readFeeLiabilities(TREASURY);
        assertEq(
            hook.totalLiability(),
            pFinal + tFinal + hook.processLiability(),
            "total liability must equal sum of the three streams at all times"
        );
    }

    function _accrueIfAboveMinimum(FeeAccountingBlindHarness hook, uint256 amount) private {
        if (amount == 0 || amount >= 1_000) {
            hook.accrueForTest(amount);
        }
    }

    function _deploy() private returns (FeeAccountingBlindHarness hook) {
        FeeAccountingBlindFactory factory = new FeeAccountingBlindFactory(
            HookemonHook.ConstructorConfig({
                manager: IPoolManager(address(0x8000)),
                positionManager: address(0x8001),
                permit2: address(0x8002),
                usdg: Currency.wrap(address(token)),
                hkmn: Currency.wrap(address(0x8003)),
                tickSpacing: 60,
                programmable: PROGRAMMABLE,
                treasury: TREASURY,
                operations: OPERATIONS,
                launchAuthority: address(0x8004),
                issuanceAuthority: address(0x8005),
                expectedDecimals: 18,
                bindingDigest: keccak256("blind-fee-binding"),
                runtimeDigest: keccak256("blind-fee-runtime"),
                processClaimLimit6h: 1_000_000_000_000,
                processClaimLimitMax: 1_000_000_000_000,
                processClaimMaxCount: 8,
                operationsRotationDelay: 1 days
            }),
            token
        );
        bytes32 initCodeHash = factory.initCodeHash();
        for (uint256 nonce; nonce < 250_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(salt, initCodeHash, address(factory));
            if ((uint160(predicted) & ALL_HOOK_PERMISSION_MASK) == REQUIRED_HOOK_PERMISSION_MASK) {
                hook = factory.deploy(salt);
                assertEq(address(hook), predicted);
                return hook;
            }
        }
        revert("missing valid fee-accounting hook salt");
    }
}
