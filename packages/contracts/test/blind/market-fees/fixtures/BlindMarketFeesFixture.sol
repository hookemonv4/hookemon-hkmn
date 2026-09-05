// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

enum BlindSwapSide {
    Buy,
    Sell
}

enum BlindAmountMode {
    ExactInput,
    ExactOutput
}

enum BlindTokenOrder {
    UsdgCurrency0,
    HkmnCurrency0
}

enum BlindCallbackStage {
    BeforeSwap,
    FinalizedAfterSwap
}

enum BlindTokenFailure {
    None,
    RevertTransfer,
    FalseReturn,
    MalformedReturn,
    ShortSourceDelta,
    ShortDestinationDelta,
    ExcessSourceDelta,
    ExcessDestinationDelta,
    Reenter
}

struct BlindPoolKey {
    address currency0;
    address currency1;
    uint24 staticLpFee;
    int24 tickSpacing;
    address hooks;
    bytes32 poolId;
}

struct BlindDeploymentConfig {
    address manager;
    address usdg;
    address hkmn;
    address hooks;
    address programmableBeneficiary;
    address treasuryBeneficiary;
    address operations;
    BlindPoolKey canonicalPoolKey;
    uint256 fixedHkmnSupply;
    uint256 launchHkmnAllocation;
}

struct BlindSwapRequest {
    BlindPoolKey poolKey;
    address callbackCaller;
    address callbackSender;
    bytes32 operationId;
    address recipient;
    address finalizedSender;
    bytes32 finalizedOperationId;
    address finalizedRecipient;
    BlindCallbackStage callbackStage;
    BlindSwapSide side;
    BlindAmountMode amountMode;
    int256 currency0TraderDelta;
    int256 currency1TraderDelta;
    uint256 displayedNominalUsdg;
    address trader;
    bool fullFill;
    bool attemptsReentry;
    uint24 liveProtocolFee;
    uint24 liveLpFee;
    int128 finalizedSpecifiedDeltaMutation;
}

struct BlindFeeSplit {
    uint256 total;
    uint256 programmable;
    uint256 treasury;
    uint256 process;
}

struct BlindSwapResult {
    uint256 executedUsdg;
    int256 traderUsdgDelta;
    int256 traderHkmnDelta;
    uint256 actualCollectedUsdg;
    uint256 lpFeeUsdg;
    uint256 additionalTradingChargeUsdg;
    BlindFeeSplit fee;
}

struct BlindLiabilitySnapshot {
    uint256 programmable;
    uint256 treasury;
    uint256 process;
    uint256 payout;
    uint256 total;
    uint256 hookUsdgBalance;
}

struct BlindCustodyEvidence {
    uint256 launchHkmnAllocation;
    uint24 staticLpFee;
    bool immutableCustody;
    bool projectControlled;
    bool upgradeable;
    bool collectsPositionFees;
}

interface IBlindCanonicalMarketSubject {
    function executeFinalizedSwap(BlindSwapRequest calldata request)
        external
        returns (BlindSwapResult memory result);

    function canonicalPoolKey() external view returns (BlindPoolKey memory key);

    function tokenBalance(address token, address account) external view returns (uint256);

    function economicsDigest() external view returns (bytes32);
}

interface IBlindMarketFeesSubject is IBlindCanonicalMarketSubject {
    function accrueAuthenticatedQuote(uint256 executedUsdg)
        external
        returns (BlindFeeSplit memory fee);

    function custodyEvidence() external view returns (BlindCustodyEvidence memory evidence);

    function liabilitySnapshot() external view returns (BlindLiabilitySnapshot memory snapshot);

    function programmableLiability(address beneficiary) external view returns (uint256);

    function treasuryLiability(address beneficiary) external view returns (uint256);

    function rotateTreasury(address nextTreasury) external;

    function rotateOperations(address nextOperations) external;

    function claimProgrammable(uint256 amount, address recipient) external returns (uint256 claimed);

    function claimTreasury(uint256 amount, address recipient) external returns (uint256 claimed);

    function configureTokenFailure(BlindTokenFailure failure) external;

    function seedPayoutLiability(uint256 amount) external;

    function donateUsdg(uint256 amount) external;

    function probePositionControl(bytes4 selector, address caller) external returns (bool succeeded);

    function transferUserHkmn(address from, address to, uint256 amount) external;
}

/// @dev P1-002 binds the canonical callback subset through BlindCanonicalMarketAdapter.
/// This factory remains the binding seam for the quarantined P1-004 liability and custody suite.
contract BlindMarketFeesFixture {
    error BlindMarketFeesImplementationNotBound();

    uint256 internal constant FIXED_HKMN_SUPPLY = 420_690_000_000 ether;

    function configuration(BlindTokenOrder order)
        external
        pure
        returns (BlindDeploymentConfig memory config)
    {
        address usdg;
        address hkmn;

        if (order == BlindTokenOrder.UsdgCurrency0) {
            usdg = address(0x1000);
            hkmn = address(0x2000);
        } else {
            hkmn = address(0x1000);
            usdg = address(0x2000);
        }

        address manager = address(0x3000);
        address hooks = address(0x20CC);
        address currency0 = usdg < hkmn ? usdg : hkmn;
        address currency1 = usdg < hkmn ? hkmn : usdg;
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, uint24(0), int24(60), hooks));

        config = BlindDeploymentConfig({
            manager: manager,
            usdg: usdg,
            hkmn: hkmn,
            hooks: hooks,
            programmableBeneficiary: address(0x5000),
            treasuryBeneficiary: address(0x6000),
            operations: address(0x7000),
            canonicalPoolKey: BlindPoolKey({
                currency0: currency0,
                currency1: currency1,
                staticLpFee: 0,
                tickSpacing: 60,
                hooks: hooks,
                poolId: poolId
            }),
            fixedHkmnSupply: FIXED_HKMN_SUPPLY,
            launchHkmnAllocation: FIXED_HKMN_SUPPLY * 90 / 100
        });
    }

    function swapRequest(
        BlindDeploymentConfig memory config,
        BlindSwapSide side,
        BlindAmountMode amountMode,
        uint256 executedUsdg,
        uint256 hkmnAmount
    ) external pure returns (BlindSwapRequest memory request) {
        int256 usdgDelta = side == BlindSwapSide.Buy ? -int256(executedUsdg) : int256(executedUsdg);
        int256 hkmnDelta = side == BlindSwapSide.Buy ? int256(hkmnAmount) : -int256(hkmnAmount);
        bool usdgIsCurrency0 = config.canonicalPoolKey.currency0 == config.usdg;

        request = BlindSwapRequest({
            poolKey: config.canonicalPoolKey,
            callbackCaller: config.manager,
            callbackSender: address(0x9000),
            operationId: keccak256("HOOKEMON_BLIND_SWAP_OPERATION"),
            recipient: address(0x8000),
            finalizedSender: address(0x9000),
            finalizedOperationId: keccak256("HOOKEMON_BLIND_SWAP_OPERATION"),
            finalizedRecipient: address(0x8000),
            callbackStage: BlindCallbackStage.FinalizedAfterSwap,
            side: side,
            amountMode: amountMode,
            currency0TraderDelta: usdgIsCurrency0 ? usdgDelta : hkmnDelta,
            currency1TraderDelta: usdgIsCurrency0 ? hkmnDelta : usdgDelta,
            displayedNominalUsdg: type(uint128).max,
            trader: address(0x8000),
            fullFill: true,
            attemptsReentry: false,
            liveProtocolFee: 0,
            liveLpFee: 0,
            finalizedSpecifiedDeltaMutation: 0
        });
    }

    function deploy(BlindDeploymentConfig memory) external pure returns (IBlindMarketFeesSubject) {
        revert BlindMarketFeesImplementationNotBound();
    }
}
