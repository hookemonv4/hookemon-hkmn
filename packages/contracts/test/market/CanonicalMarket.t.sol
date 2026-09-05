// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { BaseTestHooks } from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { BalanceDelta, BalanceDeltaLibrary } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { CanonicalMarketCallback } from "../../src/market/CanonicalMarket.sol";
import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";
import {
    MarketHookDataFixture,
    MarketTestToken,
    RecipientPoolSwapTest
} from "./CanonicalMarketCallbackSurface.t.sol";

interface Vm {
    function prank(address) external;
}

/// @dev End-to-end coverage of programmable-fee-policy.md v1.1.0's cumulative-remainder and
///      minimum-executed-quote requirements through the real `CanonicalMarketCallback` +
///      `FeeAccounting` composition, driven by an actual PoolManager swap (not a mocked
///      `_accrueAuthenticatedSwap`/`_previewTotalFee`, as in CanonicalMarketCallbackSurface.t.sol,
///      which tests callback mechanics in isolation from the fee accrual math).
contract AccountedCanonicalMarketHook is BaseTestHooks, CanonicalMarketCallback, FeeAccounting {
    address public immutable treasuryBeneficiary;

    constructor(
        IPoolManager manager,
        Currency usdgCurrency,
        Currency hkmnCurrency,
        address programmableBeneficiary,
        address treasury
    )
        CanonicalMarketCallback(manager, usdgCurrency, hkmnCurrency, 60)
        FeeAccounting(programmableBeneficiary)
    {
        treasuryBeneficiary = treasury;
    }

    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        override(CanonicalMarketCallback, FeeAccounting)
    {
        FeeAccounting._accrueAuthenticatedSwap(executedUsdg, balanceBeforeCollection);
    }

    function _previewTotalFee(uint256 executedUsdg)
        internal
        view
        override(CanonicalMarketCallback, FeeAccounting)
        returns (uint256)
    {
        return FeeAccounting._previewTotalFee(executedUsdg);
    }

    function beforeInitialize(address, PoolKey calldata, uint160)
        external
        pure
        override(BaseTestHooks, IHooks)
        returns (bytes4)
    {
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    )
        external
        override(BaseTestHooks, CanonicalMarketCallback)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (BeforeSwapDelta delta, uint24 fee) = _beforeSwap(sender, key, params, data);
        return (IHooks.beforeSwap.selector, delta, fee);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata data
    ) external override(BaseTestHooks, CanonicalMarketCallback) moneyPath returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, _afterSwap(sender, key, params, delta, data));
    }

    function claimProgrammable() external returns (uint256) {
        return _claimProgrammableLiability();
    }

    function claimTreasury() external returns (uint256) {
        return _claimTreasuryLiability();
    }

    function programmableLiability() external view returns (uint256) {
        return _programmableLiabilityOf(_fixedProgrammableBeneficiary());
    }

    function treasuryLiability() external view returns (uint256) {
        return _treasuryLiabilityOf(treasuryBeneficiary);
    }

    function processLiability() external view returns (uint256) {
        return _processLiability();
    }

    function totalLiability() external view returns (uint256) {
        return _totalLiability();
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

    function _collectFee(Currency currency, uint256 feeAmount)
        internal
        override
        returns (uint256 balanceBeforeCollection)
    {
        balanceBeforeCollection = _usdgBalanceOf(address(this));
        if (feeAmount != 0) poolManager.take(currency, address(this), feeAmount);
    }

    function _currentTreasuryBeneficiary() internal view override returns (address) {
        return treasuryBeneficiary;
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return usdg.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return _callToken(abi.encodeCall(MarketTestToken.transfer, (recipient, amount)));
    }

    function _callToken(bytes memory callData) private returns (bool) {
        (bool success, bytes memory result) = Currency.unwrap(usdg).call(callData);
        if (!success || result.length != 32) return false;
        uint256 returned;
        assembly ("memory-safe") {
            returned := mload(add(result, 0x20))
        }
        return returned == 1;
    }
}

contract AccountedCanonicalMarketHookDeployer {
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;

    function deploy(
        IPoolManager manager,
        Currency usdg,
        Currency hkmn,
        address programmableBeneficiary,
        address treasury
    ) external returns (AccountedCanonicalMarketHook hook) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AccountedCanonicalMarketHook).creationCode,
                abi.encode(manager, usdg, hkmn, programmableBeneficiary, treasury)
            )
        );
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 salt = bytes32(nonce);
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                    )
                )
            );
            if (uint160(predicted) & ALL_HOOK_MASK == REQUIRED_HOOK_MASK) {
                hook = new AccountedCanonicalMarketHook{ salt: salt }(
                    manager, usdg, hkmn, programmableBeneficiary, treasury
                );
                assert(address(hook) == predicted);
                return hook;
            }
        }
        revert("HOOK_SALT_NOT_FOUND");
    }
}

/// @dev Fee-policy conformance (GAP-1/GAP-2, programmable-fee-policy.md v1.1.0): independent
///      Programmable, treasury, and process remainders persist across swaps and are never reset
///      by a claim, and a swap with gross executed USDG below 1,000 smallest units reverts
///      atomically.
contract CanonicalMarketFeePolicyTest {
    using BalanceDeltaLibrary for BalanceDelta;

    struct Fixture {
        PoolManager manager;
        PoolModifyLiquidityTest liquidityRouter;
        RecipientPoolSwapTest swapRouter;
        AccountedCanonicalMarketHook hook;
        PoolKey key;
        MarketTestToken usdgToken;
        MarketTestToken hkmnToken;
    }

    struct AccountingOutcome {
        int128 amount0;
        int128 amount1;
        uint256 hookUsdgBalance;
        uint256 lastExecutedUsdg;
        int128 lastRawPoolUsdgDelta;
        uint256 programmableLiability;
        uint256 treasuryLiability;
        uint256 processLiability;
        uint256 totalLiability;
        uint256 programmableRemainder;
        uint256 treasuryRemainder;
        uint256 processRemainder;
    }

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant PROGRAMMABLE = address(0xC0FFEE01);
    address private constant TREASURY = address(0xC0FFEE02);

    /// @dev programmable-fee-policy.md v1.1.0: "A positive gross quote amount below 1,000
    ///      smallest quote-asset units must revert atomically in the standard profile."
    function test_swapBelowMinimumQuoteRevertsAtomically() external {
        Fixture memory fixture = _deploy();
        uint256 hookBalanceBefore = fixture.usdgToken.balanceOf(address(fixture.hook));

        bool succeeded = _trySwap(fixture, 999);

        assert(!succeeded);
        assert(fixture.usdgToken.balanceOf(address(fixture.hook)) == hookBalanceBefore);
        assert(fixture.hook.totalLiability() == 0);
    }

    /// @dev The minimum boundary itself must succeed.
    function test_swapAtExactlyMinimumQuoteSucceeds() external {
        Fixture memory fixture = _deploy();

        bool succeeded = _trySwap(fixture, 1_000);

        assert(succeeded);
        // First swap from a fresh pool: independent 10/40/250-bps streams allocate 1/4/25,
        // totaling 30. No prior remainder exists at this boundary.
        assert(fixture.hook.programmableLiability() == 1);
        assert(fixture.hook.treasuryLiability() == 4);
        assert(fixture.hook.processLiability() == 25);
        assert(fixture.hook.totalLiability() == 30);
    }

    function testHookDataVariantsProduceIdenticalFeeAccrualAndDeltas() external {
        AccountingOutcome memory absent = _observeHookDataSwap(bytes(""));
        AccountingOutcome memory malformed = _observeHookDataSwap(hex"deadbeef");
        AccountingOutcome memory arbitrary = _observeHookDataSwap(
            abi.encode(bytes32(uint256(0xBEEF)), address(0xCAFE), address(0xBEEF))
        );

        _assertSameAccountingOutcome(absent, malformed);
        _assertSameAccountingOutcome(absent, arbitrary);
        assert(absent.hookUsdgBalance == 3_000);
        assert(absent.lastExecutedUsdg == 100_000);
        assert(absent.programmableLiability == 100);
        assert(absent.treasuryLiability == 400);
        assert(absent.processLiability == 2_500);
        assert(absent.totalLiability == 3_000);
    }

    /// @dev Exact-output USDG specifies the net amount received by the caller. The callback must
    ///      solve the smallest eligible gross pool delta, including the independent carried floors.
    function test_exactOutputUsdGUsesMinimalGrossPoolDelta() external {
        Fixture memory minimumFixture = _deploy();
        BalanceDelta minimumFinalDelta = _swapExactOutputUsdg(minimumFixture, 970);

        assert(minimumFinalDelta.amount0() == 970);
        assert(minimumFixture.hook.lastRawPoolUsdgDelta() == 1_000);
        assert(minimumFixture.hook.lastExecutedUsdg() == 1_000);
        assert(minimumFixture.hook.totalLiability() == 30);

        Fixture memory nonMonotoneFixture = _deploy();
        BalanceDelta nonMonotoneFinalDelta = _swapExactOutputUsdg(nonMonotoneFixture, 1_940);

        // Fresh 10/40/250 remainders have two valid gross roots for net 1,940. The first is
        // 1,997 with fee 57; choosing 2,000 would over-collect three atomic units.
        assert(nonMonotoneFinalDelta.amount0() == 1_940);
        assert(nonMonotoneFixture.hook.lastRawPoolUsdgDelta() == 1_997);
        assert(nonMonotoneFixture.hook.lastExecutedUsdg() == 1_997);
        assert(nonMonotoneFixture.hook.totalLiability() == 57);
    }

    /// @dev The exact-output gross-up has to use the carried state from earlier swaps, rather
    ///      than a fresh flat 3% estimate. This test derives the candidate fee from independent
    ///      10/40/250-bps arithmetic and proves that the chosen root is the first eligible gross.
    function test_exactOutputUsesFirstGrossRootAfterCarriedRemainders() external {
        Fixture memory fixture = _deploy();
        assert(_trySwap(fixture, 1_499));

        for (uint256 candidate = 1_000; candidate < 1_032; ++candidate) {
            uint256 candidateFee = _independentFeeAfterPriorGross(1_499, candidate);
            assert(candidate - candidateFee != 1_000);
        }
        assert(_independentFeeAfterPriorGross(1_499, 1_032) == 32);

        BalanceDelta finalDelta = _swapExactOutputUsdg(fixture, 1_000);

        assert(finalDelta.amount0() == 1_000);
        assert(fixture.hook.lastRawPoolUsdgDelta() == 1_032);
        assert(fixture.hook.lastExecutedUsdg() == 1_032);
        assert(fixture.hook.programmableLiability() == 2);
        assert(fixture.hook.treasuryLiability() == 10);
        assert(fixture.hook.processLiability() == 63);
        assert(fixture.hook.totalLiability() == 75);
        assert(fixture.hook.programmableRemainder() == 5_310);
        assert(fixture.hook.treasuryRemainder() == 1_240);
        assert(fixture.hook.processRemainder() == 2_750);
    }

    /// @dev Three identical 1,499-unit swaps prove the cumulative remainder carries across real
    ///      pool swaps, not just the FeeAccounting unit harness: per-swap flooring alone would
    ///      total 3 programmable units (1 + 1 + 1) and never release the carried dust. The
    ///      persisted accumulator releases the extra unit on the third swap instead.
    function test_cumulativeRemainderCarriesAcrossRealSwaps() external {
        Fixture memory fixture = _deploy();

        assert(_trySwap(fixture, 1_499));
        assert(_trySwap(fixture, 1_499));
        assert(_trySwap(fixture, 1_499));

        assert(fixture.hook.programmableLiability() == 4);
        assert(fixture.hook.treasuryLiability() == 17);
        assert(fixture.hook.processLiability() == 112);
        assert(fixture.hook.totalLiability() == 133);
    }

    /// @dev A claim must not reset the persisted remainder: the swap immediately after a claim
    ///      splits identically to the same swap without an intervening claim.
    function test_claimBetweenSwapsDoesNotResetCumulativeRemainder() external {
        Fixture memory fixture = _deploy();
        assert(_trySwap(fixture, 1_499));
        uint256 programmableClaimed = fixture.hook.programmableLiability();
        uint256 treasuryClaimed = fixture.hook.treasuryLiability();
        uint256 totalBeforeClaim = fixture.hook.totalLiability();

        VM.prank(PROGRAMMABLE);
        fixture.hook.claimProgrammable();
        VM.prank(TREASURY);
        fixture.hook.claimTreasury();

        assert(fixture.hook.programmableLiability() == 0);
        assert(fixture.hook.treasuryLiability() == 0);
        assert(
            fixture.hook.totalLiability()
                == totalBeforeClaim - programmableClaimed - treasuryClaimed
        );

        assert(_trySwap(fixture, 1_499));

        // Same as the second 1,499 swap in test_cumulativeRemainderCarriesAcrossRealSwaps: 1
        // programmable unit, 6 treasury units, and 37 process units, unaffected by claims.
        assert(fixture.hook.programmableLiability() == 1);
        assert(fixture.hook.treasuryLiability() == 6);
        assert(fixture.hook.processLiability() == 74);
        assert(fixture.hook.totalLiability() == 81);
    }

    function _trySwap(Fixture memory fixture, int256 exactInputUsdg) private returns (bool) {
        try fixture.swapRouter
            .swap(
                fixture.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -exactInputUsdg,
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                address(this),
                address(this),
                MarketHookDataFixture.encode(
                    keccak256(abi.encode(exactInputUsdg, block.timestamp, gasleft())),
                    address(fixture.swapRouter),
                    address(this)
                )
            ) returns (
            BalanceDelta
        ) {
            return true;
        } catch {
            return false;
        }
    }

    function _observeHookDataSwap(bytes memory hookData)
        private
        returns (AccountingOutcome memory outcome)
    {
        Fixture memory fixture = _deploy();
        BalanceDelta delta = fixture.swapRouter
            .swap(
                fixture.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(100_000),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                address(this),
                address(this),
                hookData
            );
        outcome = AccountingOutcome({
            amount0: delta.amount0(),
            amount1: delta.amount1(),
            hookUsdgBalance: fixture.usdgToken.balanceOf(address(fixture.hook)),
            lastExecutedUsdg: fixture.hook.lastExecutedUsdg(),
            lastRawPoolUsdgDelta: fixture.hook.lastRawPoolUsdgDelta(),
            programmableLiability: fixture.hook.programmableLiability(),
            treasuryLiability: fixture.hook.treasuryLiability(),
            processLiability: fixture.hook.processLiability(),
            totalLiability: fixture.hook.totalLiability(),
            programmableRemainder: fixture.hook.programmableRemainder(),
            treasuryRemainder: fixture.hook.treasuryRemainder(),
            processRemainder: fixture.hook.processRemainder()
        });
    }

    function _assertSameAccountingOutcome(
        AccountingOutcome memory expected,
        AccountingOutcome memory actual
    ) private pure {
        assert(expected.amount0 == actual.amount0);
        assert(expected.amount1 == actual.amount1);
        assert(expected.hookUsdgBalance == actual.hookUsdgBalance);
        assert(expected.lastExecutedUsdg == actual.lastExecutedUsdg);
        assert(expected.lastRawPoolUsdgDelta == actual.lastRawPoolUsdgDelta);
        assert(expected.programmableLiability == actual.programmableLiability);
        assert(expected.treasuryLiability == actual.treasuryLiability);
        assert(expected.processLiability == actual.processLiability);
        assert(expected.totalLiability == actual.totalLiability);
        assert(expected.programmableRemainder == actual.programmableRemainder);
        assert(expected.treasuryRemainder == actual.treasuryRemainder);
        assert(expected.processRemainder == actual.processRemainder);
    }

    function _swapExactOutputUsdg(Fixture memory fixture, uint256 requestedNet)
        private
        returns (BalanceDelta)
    {
        return fixture.swapRouter
            .swap(
                fixture.key,
                SwapParams({
                    zeroForOne: false,
                    amountSpecified: int256(requestedNet),
                    sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                }),
                address(this),
                address(this),
                MarketHookDataFixture.encode(
                    keccak256(abi.encode(requestedNet, block.timestamp, gasleft())),
                    address(fixture.swapRouter),
                    address(this)
                )
            );
    }

    function _independentFeeAfterPriorGross(uint256 priorGross, uint256 gross)
        private
        pure
        returns (uint256)
    {
        return _independentIncrement(priorGross, gross, 10)
            + _independentIncrement(priorGross, gross, 40)
            + _independentIncrement(priorGross, gross, 250);
    }

    function _independentIncrement(uint256 priorGross, uint256 gross, uint256 rateBps)
        private
        pure
        returns (uint256)
    {
        return (priorGross + gross) * rateBps / 10_000 - priorGross * rateBps / 10_000;
    }

    function _deploy() private returns (Fixture memory fixture) {
        PoolManager manager = new PoolManager(address(this));
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(manager);
        RecipientPoolSwapTest swapRouter = new RecipientPoolSwapTest(manager);
        MarketTestToken first = new MarketTestToken();
        MarketTestToken second = new MarketTestToken();
        // usdg is currency0 so that an exact-input zeroForOne swap specifies USDG directly,
        // making the executed USDG amount exactly the requested amount (no price-impact
        // dependence), which lets these tests pin `executedUsdg` precisely.
        (MarketTestToken usdgToken, MarketTestToken hkmnToken) =
            address(first) < address(second) ? (first, second) : (second, first);

        AccountedCanonicalMarketHook hook = new AccountedCanonicalMarketHookDeployer()
            .deploy(
                manager,
                Currency.wrap(address(usdgToken)),
                Currency.wrap(address(hkmnToken)),
                PROGRAMMABLE,
                TREASURY
            );
        PoolKey memory key = PoolKey(
            Currency.wrap(address(usdgToken)),
            Currency.wrap(address(hkmnToken)),
            0,
            60,
            IHooks(address(hook))
        );

        usdgToken.mint(address(this), 10 ** 30);
        hkmnToken.mint(address(this), 10 ** 30);
        usdgToken.approve(address(liquidityRouter), type(uint256).max);
        hkmnToken.approve(address(liquidityRouter), type(uint256).max);
        usdgToken.approve(address(swapRouter), type(uint256).max);
        hkmnToken.approve(address(swapRouter), type(uint256).max);
        manager.initialize(key, 1 << 96);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: -120, tickUpper: 120, liquidityDelta: 10 ** 18, salt: bytes32(0)
            }),
            ""
        );

        fixture = Fixture({
            manager: manager,
            liquidityRouter: liquidityRouter,
            swapRouter: swapRouter,
            hook: hook,
            key: key,
            usdgToken: usdgToken,
            hkmnToken: hkmnToken
        });
    }
}
