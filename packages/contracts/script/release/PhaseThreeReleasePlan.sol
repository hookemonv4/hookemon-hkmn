// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Draft-only validator for the frozen Phase 3 policy before provider address derivation.
/// @dev It rejects materialized graph fields. It does not verify CREATE2 outputs or deployed runtime.
contract PhaseThreeReleasePlan {
    bytes32 public constant SCHEMA = keccak256("HOOKEMON_PHASE_THREE_RELEASE_DRAFT_V1");
    bool public constant IS_DRAFT_ONLY = true;

    uint256 public constant TARGET_CHAIN_ID = 4663;
    address public constant GRAPH_FACTORY = 0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd;
    address public constant LAUNCH_ROUTER = 0x34965F2A2ee9254522232C32F02056E92BE0C98a;
    address public constant LAUNCH_WALLET = 0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729;
    address public constant OPERATIONS = 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384;
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address public constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address public constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant PROGRAMMABLE_PLATFORM = 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c;

    bytes32 public constant TOKEN_CREATION_CODE_HASH =
        0xbe3146f7eb5c0a9a287bb927f197c518611fed9e371f5262552856d6b3e52e58;
    bytes32 public constant TOKEN_RUNTIME_TEMPLATE_CODE_HASH =
        0xc79e26bd2c8c26952c04f1d3749db091f009febd7507b67232b3838bb148f429;
    bytes32 public constant TOKEN_ARTIFACT_SHA256 =
        0x8a134aa16b09ca267055c976d05c5760ccc865c35ab608ceed20248a0e54ac68;
    bytes32 public constant HOOK_CREATION_CODE_HASH =
        0x39c3aeecae31c42f7ad707dae7b18ea976687d33f715befbe9941b853e0af8c2;
    bytes32 public constant HOOK_RUNTIME_TEMPLATE_CODE_HASH =
        0x95302da944386ccd8b7fb1b898d128098cce7aef178b318998a7a14c1897a36c;
    bytes32 public constant HOOK_ARTIFACT_SHA256 =
        0x389f63c267cbb76cd703101fd22d00f1221656cd7ea3adcb082d2719dd41aa66;
    bytes32 public constant CUSTODY_CREATION_CODE_HASH =
        0x778625cf6f5b602c891c7d605941d5e3cfc4662624a9407d67e2873cd4d99dd5;
    bytes32 public constant CUSTODY_RUNTIME_TEMPLATE_CODE_HASH =
        0x06f47cecc7026b4d9c5d393c39f8883c7e87c3fdacd30cf6f496ee41c9d4ca0c;
    bytes32 public constant CUSTODY_ARTIFACT_SHA256 =
        0x08043ea6d688242703d972040bb476b4d5da3ef4a5e9c04db1e0636a1ff86ae5;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant POOL_ALLOCATION = TOTAL_SUPPLY;
    uint256 public constant REMAINDER_CUSTODY_ALLOCATION = 0;
    uint256 public constant USDG_SEED = 240_000_000;
    uint128 public constant USDG_CURRENCY0_LIQUIDITY = 489897948556635619;
    uint128 public constant HKMN_CURRENCY0_LIQUIDITY = 489897948572597439;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;
    uint16 public constant PROGRAMMABLE_FEE_BPS = 10;
    uint16 public constant TREASURY_FEE_BPS = 40;
    uint16 public constant PROCESS_FEE_BPS = 250;

    uint160 public constant USDG_CURRENCY0_SQRT_PRICE_X96 = 161723809515207654588927258648643645224;
    uint160 public constant HKMN_CURRENCY0_SQRT_PRICE_X96 = 38813714284914462669;

    struct Draft {
        uint256 chainId;
        address graphFactory;
        address router;
        address launchWallet;
        address treasury;
        address operations;
        address usdg;
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
        uint256 usdgSeed;
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

    function validateDraft(Draft calldata draft) external pure returns (bytes32) {
        _validateDraft(draft);
        return draftDigest(draft);
    }

    function _validateDraft(Draft calldata draft) private pure {
        if (draft.chainId != TARGET_CHAIN_ID) revert WrongChain(TARGET_CHAIN_ID, draft.chainId);
        if (
            draft.graphFactory != GRAPH_FACTORY || draft.router != LAUNCH_ROUTER
                || draft.launchWallet != LAUNCH_WALLET || draft.treasury != LAUNCH_WALLET
                || draft.operations != OPERATIONS || draft.usdg != USDG
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
                || draft.usdgSeed != USDG_SEED || draft.tickLower != TICK_LOWER
                || draft.tickUpper != TICK_UPPER || draft.fee != POOL_FEE
                || draft.tickSpacing != TICK_SPACING
                || draft.programmableFeeBps != PROGRAMMABLE_FEE_BPS
                || draft.treasuryFeeBps != TREASURY_FEE_BPS
                || draft.processFeeBps != PROCESS_FEE_BPS
        ) revert InvalidDraft();
        if (!_isApprovedSeedTuple(draft)) revert InvalidDraft();
        if (
            draft.routeNamespace != bytes32(0) || draft.routeNonce != bytes32(0)
                || draft.topologyHash != bytes32(0) || draft.graphDigest != bytes32(0)
                || draft.graphCalldataDigest != bytes32(0) || draft.seedCalldataDigest != bytes32(0)
                || draft.token != address(0) || draft.hook != address(0)
                || draft.custody != address(0) || draft.poolId != bytes32(0)
                || draft.seedDeadline != 0 || draft.walletNonce != 0 || draft.graphValueWei != 0
        ) revert InvalidDraft();
    }

    function _isApprovedSeedTuple(Draft calldata draft) private pure returns (bool) {
        return (draft.sqrtPriceX96 == USDG_CURRENCY0_SQRT_PRICE_X96
                && draft.liquidity == USDG_CURRENCY0_LIQUIDITY
                && draft.amount0Max == USDG_SEED
                && draft.amount1Max == POOL_ALLOCATION)
            || (draft.sqrtPriceX96 == HKMN_CURRENCY0_SQRT_PRICE_X96
                && draft.liquidity == HKMN_CURRENCY0_LIQUIDITY
                && draft.amount0Max == POOL_ALLOCATION
                && draft.amount1Max == USDG_SEED);
    }
}
