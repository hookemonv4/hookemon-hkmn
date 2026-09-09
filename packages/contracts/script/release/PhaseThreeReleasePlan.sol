// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Pool } from "@uniswap/v4-core/src/libraries/Pool.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

/// @notice Draft-only validator for the frozen Phase 3 policy before provider address derivation.
/// @dev It rejects materialized graph fields. It does not verify CREATE2 outputs or deployed runtime.
contract PhaseThreeReleasePlan {
    bytes32 public constant SCHEMA = keccak256("HOOKEMON_PHASE_THREE_RELEASE_DRAFT_V2");
    bool public constant IS_DRAFT_ONLY = true;

    uint256 public constant TARGET_CHAIN_ID = 4663;
    address public constant GRAPH_FACTORY = 0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd;
    address public constant LAUNCH_ROUTER = 0x34965F2A2ee9254522232C32F02056E92BE0C98a;
    address public constant LAUNCH_WALLET = 0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729;
    address public constant OPERATIONS = 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384;
    address public constant QUOTE_CURRENCY = address(0);
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant PROGRAMMABLE_PLATFORM = 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c;

    bytes32 public constant TOKEN_CREATION_CODE_HASH =
        0x07c73a86681594f0605efd4caa948a53aaf05db1ca9abf2779364b3d2618c374;
    bytes32 public constant TOKEN_RUNTIME_TEMPLATE_CODE_HASH =
        0x7ff51070f093ca0416aaf3407fbdfb6b2f45f63e1f9395261ac7b6920f188e15;
    bytes32 public constant TOKEN_ARTIFACT_SHA256 =
        0x7b3b75b1ddf253a3bcab2f7c9fecf18fc1085d44cb1db0f4b753d58d16c7c100;
    bytes32 public constant HOOK_CREATION_CODE_HASH =
        0xefe377c78f3143219f2bbde8b98d48ade578ec858a318c97ed03bd247a542cd7;
    bytes32 public constant HOOK_RUNTIME_TEMPLATE_CODE_HASH =
        0x48b586046a8849c27094560246a5e0feabe8a08c60b0a23c1008a0704482bfb0;
    bytes32 public constant HOOK_ARTIFACT_SHA256 =
        0x3f1d8c2c6c0e12e4d2633c9003623c36abd419ebb5ba40c11f436a1295a23080;
    bytes32 public constant CUSTODY_CREATION_CODE_HASH =
        0x612740484e055828758b43eaccb7d5fdc6927423e6ab84b433221999a2ebce77;
    bytes32 public constant CUSTODY_RUNTIME_TEMPLATE_CODE_HASH =
        0xf66dd925b98becf4c6f4410abf52e0c95e31b407eb99115f19d1357b6cbf5334;
    bytes32 public constant CUSTODY_ARTIFACT_SHA256 =
        0xd618a60be3470c29cef847a9db46bd2c7870a7b1b262c607c98e0ef30ef8811a;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant POOL_ALLOCATION = TOTAL_SUPPLY;
    uint256 public constant REMAINDER_CUSTODY_ALLOCATION = 0;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;
    uint16 public constant PROGRAMMABLE_FEE_BPS = 10;
    uint16 public constant TREASURY_FEE_BPS = 40;
    uint16 public constant PROCESS_FEE_BPS = 250;

    struct Draft {
        uint256 chainId;
        address graphFactory;
        address router;
        address launchWallet;
        address treasury;
        address operations;
        address quoteCurrency;
        address poolManager;
        address positionManager;
        address permit2;
        address programmable;
        address launchAuthority;
        address issuanceAuthority;
        bytes32 tokenCreationCodeHash;
        bytes32 tokenRuntimeTemplateCodeHash;
        bytes32 hookCreationCodeHash;
        bytes32 hookRuntimeTemplateCodeHash;
        bytes32 custodyCreationCodeHash;
        bytes32 custodyRuntimeTemplateCodeHash;
        uint256 totalSupply;
        uint256 poolAllocation;
        uint256 remainderCustodyAllocation;
        uint256 nativeSeedWei;
        uint128 liquidity;
        uint160 sqrtPriceX96;
        uint256 amount0Max;
        uint256 amount1Max;
        int24 tickLower;
        int24 tickUpper;
        uint24 fee;
        int24 tickSpacing;
        uint16 programmableFeeBps;
        uint16 treasuryFeeBps;
        uint16 processFeeBps;
        bytes32 routeNamespace;
        bytes32 routeNonce;
        bytes32 topologyHash;
        bytes32 graphDigest;
        bytes32 graphCalldataDigest;
        bytes32 seedCalldataDigest;
        address token;
        address hook;
        address custody;
        bytes32 poolId;
        uint256 seedDeadline;
        uint256 walletNonce;
        uint256 graphValueWei;
    }

    error InvalidDraft();
    error WrongChain(uint256 expected, uint256 actual);

    function draftDigest(Draft calldata draft) public pure returns (bytes32) {
        return keccak256(abi.encode(SCHEMA, draft));
    }

    /// @notice Checks source and debt feasibility, not a funding-to-price selection or signing authority.
    /// @dev Deterministic price and external seed intent are verified by the native package tools.
    function validateDraft(Draft calldata draft) external pure returns (bytes32) {
        _validateDraft(draft);
        return draftDigest(draft);
    }

    function _validateDraft(Draft calldata draft) private pure {
        if (draft.chainId != TARGET_CHAIN_ID) revert WrongChain(TARGET_CHAIN_ID, draft.chainId);
        if (
            draft.graphFactory != GRAPH_FACTORY || draft.router != LAUNCH_ROUTER
                || draft.launchWallet != LAUNCH_WALLET || draft.treasury != LAUNCH_WALLET
                || draft.operations != OPERATIONS || draft.quoteCurrency != QUOTE_CURRENCY
                || draft.poolManager != POOL_MANAGER || draft.positionManager != POSITION_MANAGER
                || draft.permit2 != PERMIT2 || draft.programmable != PROGRAMMABLE_PLATFORM
                || draft.launchAuthority != LAUNCH_WALLET
                || draft.issuanceAuthority != GRAPH_FACTORY
                || draft.tokenCreationCodeHash != TOKEN_CREATION_CODE_HASH
                || draft.tokenRuntimeTemplateCodeHash != TOKEN_RUNTIME_TEMPLATE_CODE_HASH
                || draft.hookCreationCodeHash != HOOK_CREATION_CODE_HASH
                || draft.hookRuntimeTemplateCodeHash != HOOK_RUNTIME_TEMPLATE_CODE_HASH
                || draft.custodyCreationCodeHash != CUSTODY_CREATION_CODE_HASH
                || draft.custodyRuntimeTemplateCodeHash != CUSTODY_RUNTIME_TEMPLATE_CODE_HASH
                || draft.totalSupply != TOTAL_SUPPLY || draft.poolAllocation != POOL_ALLOCATION
                || draft.remainderCustodyAllocation != REMAINDER_CUSTODY_ALLOCATION
                || draft.fee != POOL_FEE || draft.tickSpacing != TICK_SPACING
                || draft.programmableFeeBps != PROGRAMMABLE_FEE_BPS
                || draft.treasuryFeeBps != TREASURY_FEE_BPS
                || draft.processFeeBps != PROCESS_FEE_BPS
        ) revert InvalidDraft();
        if (!_isFeasibleNativeSeedTuple(draft)) revert InvalidDraft();
        if (
            draft.routeNamespace != bytes32(0) || draft.routeNonce != bytes32(0)
                || draft.topologyHash != bytes32(0) || draft.graphDigest != bytes32(0)
                || draft.graphCalldataDigest != bytes32(0) || draft.seedCalldataDigest != bytes32(0)
                || draft.token != address(0) || draft.hook != address(0)
                || draft.custody != address(0) || draft.poolId != bytes32(0)
                || draft.seedDeadline != 0 || draft.walletNonce != 0 || draft.graphValueWei != 0
        ) revert InvalidDraft();
    }

    function _isFeasibleNativeSeedTuple(Draft calldata draft) private pure returns (bool) {
        if (
            draft.nativeSeedWei > type(uint128).max || draft.amount0Max != draft.nativeSeedWei
                || draft.amount1Max != POOL_ALLOCATION || draft.liquidity == 0
                || draft.liquidity > uint128(type(int128).max)
        ) return false;
        if (draft.nativeSeedWei == 0) {
            if (
                draft.tickLower < TickMath.MIN_TICK || draft.tickUpper >= TickMath.MAX_TICK
                    || draft.tickLower >= draft.tickUpper || draft.tickLower % TICK_SPACING != 0
                    || draft.tickUpper % TICK_SPACING != 0
                    || draft.liquidity > Pool.tickSpacingToMaxLiquidityPerTick(TICK_SPACING)
            ) return false;
            uint160 inventoryLower = TickMath.getSqrtPriceAtTick(draft.tickLower);
            uint160 inventoryUpper = TickMath.getSqrtPriceAtTick(draft.tickUpper);
            return draft.sqrtPriceX96 == inventoryUpper
                && uint256(draft.liquidity)
                    == (POOL_ALLOCATION << 96) / (uint256(inventoryUpper) - inventoryLower);
        }
        if (draft.tickLower != TICK_LOWER || draft.tickUpper != TICK_UPPER) return false;
        uint160 lower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 upper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        if (draft.sqrtPriceX96 <= lower || draft.sqrtPriceX96 >= upper) return false;
        return SqrtPriceMath.getAmount0Delta(draft.sqrtPriceX96, upper, draft.liquidity, true)
                <= draft.nativeSeedWei
            && SqrtPriceMath.getAmount1Delta(lower, draft.sqrtPriceX96, draft.liquidity, true)
                == POOL_ALLOCATION;
    }
}
