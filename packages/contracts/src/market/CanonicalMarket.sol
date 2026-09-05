// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { BalanceDelta, BalanceDeltaLibrary } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta, toBeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Abstract local v4 callback core; final Robinhood deployment remains binding-pending.
abstract contract CanonicalMarketCallback is IHooks {
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    uint160 internal constant REQUIRED_PERMISSION_MASK = 0x20CC;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant TOTAL_FEE_BPS = 300;
    uint256 private constant MINIMUM_GROSS_USDG = 1_000;
    uint256 private constant EXACT_OUTPUT_SCAN_RADIUS = 8;

    enum CallbackPhase {
        Idle,
        Pending,
        Finalizing
    }

    struct FinalizedSwap {
        uint256 executedUsdg;
        int128 rawUsdgDelta;
        int128 rawHkmnDelta;
        int128 fee;
        bool usdgSpecified;
    }

    IPoolManager public immutable poolManager;
    Currency public immutable usdg;
    Currency public immutable hkmn;
    int24 public immutable tickSpacing;
    CallbackPhase private callbackPhase;
    bytes32 private callbackContext;
    uint256 public lastExecutedUsdg;
    int128 public lastRawPoolUsdgDelta;
    error ForeignPoolManager();
    error InvalidCanonicalPoolKey();
    error InvalidFinalizedSwap();
    error ReentrantCallback();
    event CanonicalSwapObserved(address indexed sender, uint256 executedUsdg, int128 rawHkmnDelta);

    constructor(IPoolManager m, Currency u, Currency h, int24 t) {
        if (
            address(m) == address(0) || Currency.unwrap(u) == address(0)
                || Currency.unwrap(h) == address(0) || Currency.unwrap(u) == Currency.unwrap(h)
                || t <= 0
        ) {
            revert InvalidCanonicalPoolKey();
        }
        poolManager = m;
        usdg = u;
        hkmn = h;
        tickSpacing = t;
    }

    function hookPermissionMask() external pure virtual returns (uint160) {
        return REQUIRED_PERMISSION_MASK;
    }

    /// @dev The canonical callback authenticates only the PoolManager's swap context and deltas.
    ///      Hook data is intentionally ignored.
    function _beforeSwap(address sender, PoolKey calldata k, SwapParams calldata p, bytes calldata)
        internal
        returns (BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert ForeignPoolManager();
        if (callbackPhase != CallbackPhase.Idle) revert ReentrantCallback();
        if (!_matches(k) || p.amountSpecified == 0) revert InvalidCanonicalPoolKey();
        bool s = _specified0(p) == (Currency.unwrap(usdg) == Currency.unwrap(k.currency0));
        int128 f = s ? _feeForSpecifiedUsdg(p.amountSpecified) : int128(0);
        callbackContext = _context(sender, k, p);
        callbackPhase = CallbackPhase.Pending;
        return (toBeforeSwapDelta(f, 0), 0);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata k,
        SwapParams calldata p,
        BalanceDelta d,
        bytes calldata
    ) internal returns (int128) {
        if (msg.sender != address(poolManager)) revert ForeignPoolManager();
        if (callbackPhase == CallbackPhase.Finalizing) revert ReentrantCallback();
        if (
            callbackPhase != CallbackPhase.Pending || !_matches(k)
                || callbackContext != _context(sender, k, p)
        ) {
            revert InvalidCanonicalPoolKey();
        }
        FinalizedSwap memory finalized = _validateFinalizedSwap(k, p, d);
        callbackPhase = CallbackPhase.Finalizing;
        uint256 balanceBeforeCollection = _collectFee(usdg, uint256(uint128(finalized.fee)));
        _accrueAuthenticatedSwap(finalized.executedUsdg, balanceBeforeCollection);
        lastRawPoolUsdgDelta = finalized.rawUsdgDelta;
        lastExecutedUsdg = finalized.executedUsdg;
        callbackPhase = CallbackPhase.Idle;
        callbackContext = bytes32(0);
        emit CanonicalSwapObserved(sender, finalized.executedUsdg, finalized.rawHkmnDelta);
        return finalized.usdgSpecified ? int128(0) : finalized.fee;
    }

    function _validateFinalizedSwap(PoolKey calldata k, SwapParams calldata p, BalanceDelta d)
        private
        view
        returns (FinalizedSwap memory finalized)
    {
        int128 a0 = d.amount0();
        int128 a1 = d.amount1();
        if (a0 == 0 || a1 == 0 || (a0 < 0) == (a1 < 0)) revert InvalidFinalizedSwap();
        bool specified0 = _specified0(p);
        int128 specified = specified0 ? a0 : a1;
        bool usdg0 = Currency.unwrap(usdg) == Currency.unwrap(k.currency0);
        finalized.rawUsdgDelta = usdg0 ? a0 : a1;
        finalized.rawHkmnDelta = usdg0 ? a1 : a0;
        finalized.usdgSpecified = specified0 == usdg0;
        uint256 netUsdg =
            finalized.usdgSpecified ? _abs(p.amountSpecified) : _abs(finalized.rawUsdgDelta);
        if (p.amountSpecified < 0) {
            finalized.executedUsdg = netUsdg;
            finalized.fee = _fee(netUsdg);
        } else {
            uint256 totalFee;
            (finalized.executedUsdg, totalFee) = _grossForExactOutput(netUsdg);
            finalized.fee = _feeDelta(totalFee);
        }
        if (finalized.usdgSpecified && p.amountSpecified > type(int256).max - int256(finalized.fee))
        {
            revert InvalidFinalizedSwap();
        }
        if (
            int256(specified)
                != p.amountSpecified + (finalized.usdgSpecified ? int256(finalized.fee) : int256(0))
        ) {
            revert InvalidFinalizedSwap();
        }
    }

    function _matches(PoolKey calldata k) private view returns (bool) {
        address c0 = Currency.unwrap(usdg) < Currency.unwrap(hkmn)
            ? Currency.unwrap(usdg)
            : Currency.unwrap(hkmn);
        address c1 = c0 == Currency.unwrap(usdg) ? Currency.unwrap(hkmn) : Currency.unwrap(usdg);
        (,, uint24 protocolFee, uint24 liveLpFee) = poolManager.getSlot0(k.toId());
        return Currency.unwrap(k.currency0) == c0 && Currency.unwrap(k.currency1) == c1
            && k.fee == 0 && k.tickSpacing == tickSpacing && address(k.hooks) == address(this)
            && protocolFee == 0 && liveLpFee == 0;
    }

    function _specified0(SwapParams calldata p) private pure returns (bool) {
        return (p.amountSpecified < 0) == p.zeroForOne;
    }

    function _context(address sender, PoolKey calldata k, SwapParams calldata p)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                sender,
                k.currency0,
                k.currency1,
                k.fee,
                k.tickSpacing,
                k.hooks,
                p.zeroForOne,
                p.amountSpecified,
                p.sqrtPriceLimitX96
            )
        );
    }

    /// @dev The charged fee is FeeAccounting's cumulative-remainder total for its three approved
    ///      streams. `_previewTotalFee` does not mutate the remainders, so a specified-USDG quote
    ///      can be previewed before the pool swap and authenticated against the same quote after it.
    function _fee(uint256 x) private view returns (int128) {
        // Reject amounts whose flat TOTAL_FEE_BPS-equivalent floor would already exceed int128
        // before calling into the (potentially carry-adjusted) preview, so an adversarially large
        // `x` reverts with InvalidFinalizedSwap instead of an unchecked-arithmetic panic.
        uint256 maxAmount =
            ((uint256(uint128(type(int128).max)) + 1) * BPS_DENOMINATOR - 1) / TOTAL_FEE_BPS;
        if (x > maxAmount) revert InvalidFinalizedSwap();
        uint256 f = _previewTotalFee(x);
        return _feeDelta(f);
    }

    function _feeForSpecifiedUsdg(int256 amountSpecified) private view returns (int128) {
        uint256 requestedNet = _abs(amountSpecified);
        if (amountSpecified < 0) return _fee(requestedNet);
        (, uint256 fee) = _grossForExactOutput(requestedNet);
        return _feeDelta(fee);
    }

    /// @dev Exact output asks for net USDG. The solver rounds the nominal gross up, then walks
    ///      gross candidates upward and returns the first equality. The three carried-floor
    ///      streams can make `gross - fee` locally non-monotone, so binary search cannot prove
    ///      that it found the least root. Each floor differs from its fractional share by less
    ///      than one atomic unit; the eight-unit window on either side of the rounded 3% estimate
    ///      exceeds the three-stream rounding drift. Every candidate is at least 1,000 before
    ///      FeeAccounting's preview is called. Returning the first root never selects a later,
    ///      higher-gross quote, and the fee remains the exact sum of the three carried increments.
    function _grossForExactOutput(uint256 requestedNet)
        private
        view
        returns (uint256 gross, uint256 fee)
    {
        uint256 estimate = FullMath.mulDivRoundingUp(
            requestedNet, BPS_DENOMINATOR, BPS_DENOMINATOR - TOTAL_FEE_BPS
        );
        uint256 candidate = estimate > EXACT_OUTPUT_SCAN_RADIUS
            ? estimate - EXACT_OUTPUT_SCAN_RADIUS
            : MINIMUM_GROSS_USDG;
        if (candidate < MINIMUM_GROSS_USDG) candidate = MINIMUM_GROSS_USDG;

        for (uint256 i; i <= EXACT_OUTPUT_SCAN_RADIUS * 2; ++i) {
            uint256 candidateFee = _previewTotalFee(candidate);
            if (candidateFee <= candidate && candidate - candidateFee == requestedNet) {
                return (candidate, candidateFee);
            }
            if (candidate == type(uint256).max) break;
            unchecked {
                ++candidate;
            }
        }
        revert InvalidFinalizedSwap();
    }

    function _feeDelta(uint256 feeAmount) private pure returns (int128) {
        if (feeAmount > uint256(uint128(type(int128).max))) revert InvalidFinalizedSwap();
        return int128(uint128(feeAmount));
    }

    function _abs(int256 x) private pure returns (uint256) {
        if (x == type(int256).min) revert InvalidFinalizedSwap();
        return uint256(x < 0 ? -x : x);
    }
    /// @dev Collection and accounting are separate so liabilities cannot consume a rounded fee
    ///      as though it were finalized executed volume.
    function _collectFee(Currency currency, uint256 feeAmount)
        internal
        virtual
        returns (uint256 balanceBeforeCollection);

    /// @dev Called once only after the callback context, final deltas, and full fill authenticate Q.
    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        virtual;

    /// @dev Side-effect-free preview of the total fee FeeAccounting would commit for
    ///      `executedUsdg` right now (see `_fee`'s docs for the non-mutation invariant this
    ///      relies on).
    function _previewTotalFee(uint256 executedUsdg) internal view virtual returns (uint256);

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    ) external virtual override returns (bytes4, BeforeSwapDelta, uint24) {
        (BeforeSwapDelta delta, uint24 feeOverride) = _beforeSwap(sender, key, params, data);
        return (IHooks.beforeSwap.selector, delta, feeOverride);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata data
    ) external virtual override returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, _afterSwap(sender, key, params, delta, data));
    }
}
