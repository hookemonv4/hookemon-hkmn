// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import { IStrategy } from "@uniswap/liquidity-launcher/src/interfaces/IStrategy.sol";
import {
    ILiquidityLauncher
} from "@uniswap/liquidity-launcher/src/interfaces/ILiquidityLauncher.sol";
import { IMulticall } from "@uniswap/liquidity-launcher/src/interfaces/IMulticall.sol";
import { Distribution } from "@uniswap/liquidity-launcher/src/types/Distribution.sol";

import { HookemonIssuance } from "./HookemonIssuance.sol";

/// @notice Retained ABI mirror used only by unreachable compatibility helpers.
struct UERC20Metadata {
    string description;
    string website;
    string image;
    bytes extraData;
}

interface IUERC20FactoryLike {
    function getUERC20Address(
        string memory name,
        string memory symbol,
        uint8 decimals,
        address creator,
        bytes32 graffiti
    ) external view returns (address);
}

/// @notice Retained compatibility ABI for the retired launch strategy.
/// @dev Every state-changing strategy entry point reverts. The retained helper code and
///      placeholder types are source evidence only and cannot participate in the launch graph.
contract CustomLaunchStrategy is IStrategy {
    using SafeERC20 for IERC20;

    /// @dev Mirrors `HookemonIssuance.WHOLE_HKMN_SUPPLY` exactly -- kept in lockstep by
    ///      `CustomLaunchStrategy.t.sol` and `HookemonIssuanceIntegration.t.sol`, which assert
    ///      the plan this contract builds is accepted by a real deployed guard.
    uint256 internal constant WHOLE_HKMN_SUPPLY = 420_690_000_000;
    uint256 internal constant MARKET_ALLOCATION_BPS = 9_000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    string internal constant TOKEN_NAME = "Hookemon";
    string internal constant TOKEN_SYMBOL = "HKMN";
    bytes32 internal constant LAUNCH_SALT = keccak256("HOOKEMON_CUSTOM_LAUNCH_STRATEGY_LAUNCH_V1");
    bytes32 internal constant PROVIDER_CALL_SCHEMA =
        keccak256("HOOKEMON_CUSTOM_LAUNCH_STRATEGY_PROVIDER_CALL_V1");

    /// @notice PLACEHOLDER_OWNER_DECISION (design.md section 11 D10-b): a conservative,
    ///         documented default LBP-shaped bootstrap curve description. Committed into the
    ///         plan's `providerCallDigest` so the guard's frozen plan binds to it, but not
    ///         itself executed as a live pool seed by this contract (see the contract-level
    ///         doc comment above). The owner must confirm or replace this curve before any live
    ///         mainnet launch call promotes past this placeholder.
    struct PlaceholderLbpCurve {
        int24 minLaunchTick;
        int24 initialTick;
        uint40 decayDurationSeconds;
        string description;
    }

    /// @notice Retained constructor field with no active launch authority.
    address public immutable launcher;
    /// @notice Retained constructor field with no active mint path.
    address public immutable factory;
    /// @notice Retained constructor field with no active launch path.
    address public immutable owner;
    /// @notice Retained constructor field.
    uint8 public immutable decimals;
    /// @notice Always zero. The retired constructor creates no custody target.
    address public immutable remainderRepresentation;
    /// @notice Always zero. The retired constructor creates no custody target.
    address public immutable marketPositionCustody;
    /// @notice Retained constructor field.
    address public immutable projectWallet;
    bytes32 public immutable bindingManifestDigest;
    bytes32 public immutable runtimeAuthorityDigest;

    /// @notice Retained ABI fields that stay unset because binding is disabled.
    address public issuanceGuard;
    bool public issuanceGuardBound;
    bool public launched;

    /// @dev Retained private state used only by unreachable compatibility helpers.
    bool private _awaitingDistribution;
    address private _expectedToken;

    PlaceholderLbpCurve private _curve;

    error ZeroAddress();
    error OnlyOwner();
    error OnlyLauncher();
    error IssuanceGuardAlreadyBound();
    error IssuanceGuardNotBound();
    error AlreadyLaunched();
    error UnexpectedDistribution(address token, uint256 totalSupply);
    error InvalidSupply(uint256 actual, uint256 expected);
    error InvalidTokenDecimals(uint8 actual, uint8 expected);
    error TokenAmountMismatch(uint256 received, uint256 expected);
    error TokenCreationMismatch(address actual, address predicted);
    error SupplyExceedsUint128(uint256 actual);
    error LaunchPathDisabled();

    event IssuanceGuardBound(address indexed issuanceGuard);
    event MarketAllocationSettled(
        address indexed token, address indexed canonicalMarket, uint256 amount
    );
    event RemainderAllocationSettled(
        address indexed token, address indexed remainderRepresentation, uint256 amount
    );
    event LaunchCompleted(address indexed token, bytes32 planDigest);

    constructor(
        address launcher_,
        address factory_,
        address owner_,
        address projectWallet_,
        uint8 decimals_,
        bytes32 bindingManifestDigest_,
        bytes32 runtimeAuthorityDigest_,
        uint256,
        PlaceholderLbpCurve memory curve_
    ) {
        if (
            launcher_ == address(0) || factory_ == address(0) || owner_ == address(0)
                || projectWallet_ == address(0)
        ) revert ZeroAddress();
        if (bindingManifestDigest_ == bytes32(0) || runtimeAuthorityDigest_ == bytes32(0)) {
            revert ZeroAddress();
        }

        launcher = launcher_;
        factory = factory_;
        owner = owner_;
        projectWallet = projectWallet_;
        decimals = decimals_;
        bindingManifestDigest = bindingManifestDigest_;
        runtimeAuthorityDigest = runtimeAuthorityDigest_;
        _curve = curve_;

        remainderRepresentation = address(0);
        marketPositionCustody = address(0);
    }

    function bindIssuanceGuard(address) external pure {
        revert LaunchPathDisabled();
    }

    function launch() external pure returns (address, bytes32) {
        revert LaunchPathDisabled();
    }

    function initializeDistribution(address, uint256, bytes calldata, bytes32)
        external
        pure
        override
    {
        revert LaunchPathDisabled();
    }

    function readPlaceholderCurve() external view returns (PlaceholderLbpCurve memory) {
        return _curve;
    }

    function _mintAndDistribute(uint256 totalSupply_) private returns (address token) {
        bytes32 graffiti = ILiquidityLauncher(launcher).getGraffiti(address(this));
        address predictedToken = IUERC20FactoryLike(factory)
            .getUERC20Address(TOKEN_NAME, TOKEN_SYMBOL, decimals, launcher, graffiti);

        _expectedToken = predictedToken;
        _awaitingDistribution = true;

        // `LiquidityLauncher.createToken`/`Distribution.amount` both take `uint128`; checked so a
        // future decimals/supply change that would silently truncate reverts instead.
        uint128 launcherSupply = _toUint128(totalSupply_);

        bytes memory tokenData = abi.encode(
            UERC20Metadata({ description: "", website: "", image: "", extraData: "" })
        );
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILiquidityLauncher.createToken,
            (factory, TOKEN_NAME, TOKEN_SYMBOL, decimals, launcherSupply, launcher, tokenData)
        );
        calls[1] = abi.encodeCall(
            ILiquidityLauncher.distributeToken,
            (
                predictedToken,
                Distribution({ strategy: address(this), amount: launcherSupply, configData: "" }),
                LAUNCH_SALT
            )
        );

        bytes[] memory results = IMulticall(launcher).multicall(calls);
        token = abi.decode(results[0], (address));
        if (token != predictedToken) revert TokenCreationMismatch(token, predictedToken);
        // `distributeToken` reverts on a partially-consumed allowance and `initializeDistribution`
        // reverts unless it was actually reached for this exact token, so reaching here already
        // proves the distribution ran; this flag only guards against it never running at all.
        if (_awaitingDistribution) revert UnexpectedDistribution(token, totalSupply_);
    }

    function _pull(address token, uint256 amount) private returns (uint256 received) {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - balanceBefore;
    }

    function _buildPlan(uint256 totalSupply_, uint256 marketAllocation, uint256 remainderAllocation)
        private
        view
        returns (HookemonIssuance.IssuancePlan memory plan)
    {
        plan = HookemonIssuance.IssuancePlan({
            decimals: decimals,
            issuanceSource: address(this),
            canonicalMarket: issuanceGuard,
            remainderRepresentation: remainderRepresentation,
            marketPositionCustody: marketPositionCustody,
            projectWallet: projectWallet,
            totalSupply: totalSupply_,
            marketAllocation: marketAllocation,
            remainderAllocation: remainderAllocation,
            otherAllocation: 0,
            bindingManifestDigest: bindingManifestDigest,
            runtimeAuthorityDigest: runtimeAuthorityDigest,
            providerCallDigest: _providerCallDigest(),
            remainderTreatmentDigest: _remainderTreatmentDigest(),
            custodyCommitment: _custodyCommitment()
        });
    }

    function _buildObservation(
        HookemonIssuance.IssuancePlan memory plan,
        bytes32 planDigest,
        address token
    ) private view returns (HookemonIssuance.IssuanceObservation memory observation) {
        observation = HookemonIssuance.IssuanceObservation({
            planDigest: planDigest,
            token: token,
            nameHash: keccak256(bytes(TOKEN_NAME)),
            symbolHash: keccak256(bytes(TOKEN_SYMBOL)),
            decimals: decimals,
            totalSupply: plan.totalSupply,
            canonicalMarketBalance: IERC20(token).balanceOf(issuanceGuard),
            remainderBalance: IERC20(token).balanceOf(remainderRepresentation),
            issuanceSourceBalance: IERC20(token).balanceOf(address(this)),
            projectWalletBalance: IERC20(token).balanceOf(projectWallet),
            otherAllocation: 0,
            bindingManifestDigest: plan.bindingManifestDigest,
            runtimeAuthorityDigest: plan.runtimeAuthorityDigest,
            providerCallDigest: plan.providerCallDigest,
            remainderTreatmentDigest: plan.remainderTreatmentDigest,
            custodyCommitment: plan.custodyCommitment
        });
    }

    function _buildTrace(uint256 marketAllocation, uint256 remainderAllocation)
        private
        view
        returns (HookemonIssuance.TransferRecord[] memory trace)
    {
        trace = new HookemonIssuance.TransferRecord[](2);
        trace[0] = HookemonIssuance.TransferRecord(address(this), issuanceGuard, marketAllocation);
        trace[1] = HookemonIssuance.TransferRecord(
            address(this), remainderRepresentation, remainderAllocation
        );
    }

    function _providerCallDigest() private view returns (bytes32) {
        return keccak256(abi.encode(PROVIDER_CALL_SCHEMA, launcher, factory, address(this), _curve));
    }

    function _remainderTreatmentDigest() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                "HOOKEMON_PLACEHOLDER_OWNER_DECISION_D10_REMAINDER_CUSTODY_V1",
                remainderRepresentation
            )
        );
    }

    function _custodyCommitment() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                "HOOKEMON_PLACEHOLDER_OWNER_DECISION_D10_MARKET_POSITION_CUSTODY_V1",
                marketPositionCustody,
                _curve
            )
        );
    }

    /// @dev Mirrors `HookemonIssuance._scaledSupply` exactly so the plan this contract builds is
    ///      byte-for-byte the plan the bound guard's `_validatePlan` independently recomputes.
    function _scaledSupply() private view returns (uint256 supply) {
        uint256 scale = 1;
        for (uint256 index; index < decimals; ++index) {
            scale *= 10;
        }
        supply = WHOLE_HKMN_SUPPLY * scale;
    }

    /// @dev Mirrors `HookemonIssuance._basisPoints` exactly.
    function _basisPoints(uint256 amount, uint256 basisPoints) private pure returns (uint256) {
        return amount / BPS_DENOMINATOR * basisPoints + amount % BPS_DENOMINATOR * basisPoints
            / BPS_DENOMINATOR;
    }

    function _toUint128(uint256 value) private pure returns (uint128) {
        if (value > type(uint128).max) revert SupplyExceedsUint128(value);
        return uint128(value);
    }
}

/// @notice PLACEHOLDER_OWNER_DECISION (design.md section 11 D10-a-i): a conservative timelocked
///         treasury-custody stub for `remainderRepresentation`. Holds whatever ERC20 balance it
///         receives at issuance until `unlockTimestamp`, then lets `beneficiary` sweep it out.
///         This is explicitly not the final custody design -- the owner must confirm or replace
///         it before any live mainnet launch call promotes past this placeholder (see
///         `HookemonIssuance.sol`'s doc comment and design.md sections 3.8/11 D10).
contract PlaceholderRemainderCustody {
    using SafeERC20 for IERC20;

    address public immutable beneficiary;
    uint256 public immutable unlockTimestamp;

    error ZeroAddress();
    error OnlyBeneficiary();
    error StillTimelocked(uint256 unlockTimestamp, uint256 currentTimestamp);

    event Released(address indexed token, address indexed to, uint256 amount);

    constructor(address beneficiary_, uint256 timelockSeconds) {
        if (beneficiary_ == address(0)) revert ZeroAddress();
        beneficiary = beneficiary_;
        unlockTimestamp = block.timestamp + timelockSeconds;
    }

    /// @notice Sweeps `amount` of `token` to `beneficiary` once the timelock has elapsed.
    function release(address token, uint256 amount) external {
        if (msg.sender != beneficiary) revert OnlyBeneficiary();
        if (block.timestamp < unlockTimestamp) {
            revert StillTimelocked(unlockTimestamp, block.timestamp);
        }
        IERC20(token).safeTransfer(beneficiary, amount);
        emit Released(token, beneficiary, amount);
    }
}

/// @notice PLACEHOLDER_OWNER_DECISION (design.md section 11 D10-a-ii): a placeholder permanent
///         lock for the future Uniswap v4 LP position NFT once the canonical market's allocation
///         is actually seeded into a pool -- a step deliberately out of `HookemonIssuance`'s and
///         `CustomLaunchStrategy`'s scope (the guard verifies only the destination *amount*,
///         never the curve or position that later consumes it). Accepts ERC-721 transfers and
///         never moves them back out; the owner must replace this with the real permanent
///         custody contract before any live mainnet pool seeding.
contract PlaceholderMarketPositionCustody is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
