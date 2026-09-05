// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IPositionManagerPositionView is IERC721OwnerOf {
    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory poolKey, uint256 positionInfo);

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
}

library RobinhoodBindings {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint32 internal constant REQUIREMENTS_REVISION = 54;
    uint16 internal constant ARCHITECTURE_REVISION = 3;
    uint24 internal constant STATIC_LP_FEE = 0;
    uint16 internal constant TOTAL_HOOK_FEE_BPS = 300;
    uint16 internal constant PROGRAMMABLE_FEE_BPS = 10;
    uint16 internal constant TREASURY_FEE_BPS = 40;
    uint16 internal constant MARKET_ALLOCATION_BPS = 9_000;
    uint160 internal constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 internal constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    int24 internal constant MIN_TICK_SPACING = 1;
    int24 internal constant MAX_TICK_SPACING = 32_767;
    address internal constant ROBINHOOD_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ROBINHOOD_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant ROBINHOOD_POSITION_MANAGER =
        0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant ROBINHOOD_LIQUIDITY_LAUNCHER =
        0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0;
    address internal constant PROGRAMMABLE_GRAPH_FACTORY =
        0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd;
    /// @dev programmable-fee-policy.md's pinned Programmable fee beneficiary. A `Binding` whose
    ///      `programmableBeneficiary` does not match this exact address can never `validate()`,
    ///      so no `ImmutableLaunchBinding` deployment (the frozen preimage every production
    ///      deployment must reproduce) can ever bind to a different Programmable owner.
    address internal constant PROGRAMMABLE_BENEFICIARY = 0x4957f49620AFf3Adbbe8195a4f633E49cc93376c;
    address internal constant OPERATIONS_WALLET = 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384;
    bytes32 internal constant SOURCE_SET_DIGEST =
        0x35ffa674dfdbee0fceef1e64614b3291cd19c2f862fc9fb6c5a0dda7bc25b031;
    bytes32 internal constant ABI_SET_DIGEST =
        0x19419411f02f975f7dc1c62dd948017119d882787c6f5525813f1a60fd8d864e;
    bytes32 internal constant RUNTIME_SET_DIGEST =
        0xa11752c21fc1d8c536e769a57ca10811ae310c5285bd1c84ed2068ec6545595e;

    error AddressPreimageMismatch(address expected, address actual);
    error DuplicateAddress(address value);
    error EmptyDigest();
    error InvalidAddress();
    error InvalidArchitectureRevision(uint16 actual);
    error InvalidChainId(uint256 actual);
    error InvalidFeeContract();
    error InvalidHookPermissionMask(uint160 actual);
    error InvalidKnownProviderIdentity();
    error InvalidMarketAllocation(uint16 actual);
    error InvalidPoolKey();
    error InvalidProgrammableBeneficiary(address actual);
    error InvalidOperationsWallet(address actual);
    error InvalidRequirementsRevision(uint32 actual);
    error MismatchedEvidenceDigest();

    struct Binding {
        uint256 chainId;
        uint32 requirementsRevision;
        uint16 architectureRevision;
        address usdg;
        address hkmn;
        address poolManager;
        address positionManager;
        address launcher;
        address hook;
        address hookDeployer;
        bytes32 hookSalt;
        bytes32 hookInitCodeHash;
        address custody;
        address programmableBeneficiary;
        address treasury;
        address operations;
        address expectedOperations;
        address currency0;
        address currency1;
        int24 tickSpacing;
        bytes32 poolId;
        uint24 poolLpFee;
        uint16 totalHookFeeBasisPoints;
        uint16 programmableFeeBasisPoints;
        uint16 treasuryFeeBasisPoints;
        uint16 marketAllocationBasisPoints;
        uint160 hookPermissionMask;
        bytes32 sourceSetDigest;
        bytes32 abiSetDigest;
        bytes32 runtimeSetDigest;
    }

    function validate(Binding memory binding) internal pure {
        if (binding.chainId != ROBINHOOD_CHAIN_ID) revert InvalidChainId(binding.chainId);
        if (binding.requirementsRevision != REQUIREMENTS_REVISION) {
            revert InvalidRequirementsRevision(binding.requirementsRevision);
        }
        if (binding.architectureRevision != ARCHITECTURE_REVISION) {
            revert InvalidArchitectureRevision(binding.architectureRevision);
        }

        address[11] memory identities = [
            binding.usdg,
            binding.hkmn,
            binding.poolManager,
            binding.positionManager,
            binding.launcher,
            binding.hook,
            binding.hookDeployer,
            binding.custody,
            binding.programmableBeneficiary,
            binding.treasury,
            binding.operations
        ];
        for (uint256 index = 0; index < identities.length; ++index) {
            if (identities[index] == address(0)) revert InvalidAddress();
            for (uint256 other = index + 1; other < identities.length; ++other) {
                if (identities[index] == identities[other]) {
                    revert DuplicateAddress(identities[index]);
                }
            }
        }
        if (
            binding.usdg != ROBINHOOD_USDG || binding.poolManager != ROBINHOOD_POOL_MANAGER
                || binding.positionManager != ROBINHOOD_POSITION_MANAGER
                || binding.launcher != ROBINHOOD_LIQUIDITY_LAUNCHER
        ) revert InvalidKnownProviderIdentity();
        if (binding.programmableBeneficiary != PROGRAMMABLE_BENEFICIARY) {
            revert InvalidProgrammableBeneficiary(binding.programmableBeneficiary);
        }
        if (
            OPERATIONS_WALLET == address(0) || binding.operations != OPERATIONS_WALLET
                || binding.expectedOperations != OPERATIONS_WALLET
        ) {
            revert InvalidOperationsWallet(binding.operations);
        }

        if (
            binding.poolLpFee != STATIC_LP_FEE
                || binding.totalHookFeeBasisPoints != TOTAL_HOOK_FEE_BPS
                || binding.programmableFeeBasisPoints != PROGRAMMABLE_FEE_BPS
                || binding.treasuryFeeBasisPoints != TREASURY_FEE_BPS
                || binding.programmableFeeBasisPoints + binding.treasuryFeeBasisPoints
                    > binding.totalHookFeeBasisPoints
        ) revert InvalidFeeContract();
        address expectedCurrency0 =
            uint160(binding.usdg) < uint160(binding.hkmn) ? binding.usdg : binding.hkmn;
        address expectedCurrency1 = expectedCurrency0 == binding.usdg ? binding.hkmn : binding.usdg;
        if (
            binding.currency0 != expectedCurrency0 || binding.currency1 != expectedCurrency1
                || binding.tickSpacing < MIN_TICK_SPACING || binding.tickSpacing > MAX_TICK_SPACING
                || binding.poolId
                    != keccak256(
                        abi.encode(
                            binding.currency0,
                            binding.currency1,
                            binding.poolLpFee,
                            binding.tickSpacing,
                            binding.hook
                        )
                    )
        ) revert InvalidPoolKey();
        if (binding.marketAllocationBasisPoints != MARKET_ALLOCATION_BPS) {
            revert InvalidMarketAllocation(binding.marketAllocationBasisPoints);
        }
        if (binding.hookPermissionMask != REQUIRED_HOOK_PERMISSION_MASK) {
            revert InvalidHookPermissionMask(binding.hookPermissionMask);
        }
        if (uint160(binding.hook) & ALL_HOOK_PERMISSION_MASK != binding.hookPermissionMask) {
            revert InvalidHookPermissionMask(uint160(binding.hook) & ALL_HOOK_PERMISSION_MASK);
        }

        address expectedHook = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            binding.hookDeployer,
                            binding.hookSalt,
                            binding.hookInitCodeHash
                        )
                    )
                )
            )
        );
        if (expectedHook != binding.hook) {
            revert AddressPreimageMismatch(expectedHook, binding.hook);
        }
        if (
            binding.sourceSetDigest == bytes32(0) || binding.abiSetDigest == bytes32(0)
                || binding.runtimeSetDigest == bytes32(0) || binding.hookInitCodeHash == bytes32(0)
        ) revert EmptyDigest();
        if (
            binding.sourceSetDigest != SOURCE_SET_DIGEST || binding.abiSetDigest != ABI_SET_DIGEST
                || binding.runtimeSetDigest != RUNTIME_SET_DIGEST
        ) revert MismatchedEvidenceDigest();
    }

    function digest(Binding memory binding) internal pure returns (bytes32) {
        validate(binding);
        return keccak256(abi.encode("HOOKEMON_IMMUTABLE_LAUNCH_BINDING_R54_A3", binding));
    }
}

contract ImmutableLaunchBinding {
    bytes32 public immutable bindingDigest;
    address public immutable custody;
    address public immutable hook;
    address public immutable poolManager;
    address public immutable positionManager;
    bytes32 public immutable poolId;
    address public immutable operations;
    address public immutable usdg;

    constructor(RobinhoodBindings.Binding memory binding) {
        bytes32 frozenDigest = RobinhoodBindings.digest(binding);
        bindingDigest = frozenDigest;
        custody = binding.custody;
        hook = binding.hook;
        poolManager = binding.poolManager;
        positionManager = binding.positionManager;
        poolId = binding.poolId;
        operations = binding.operations;
        usdg = binding.usdg;
    }
}

contract PermanentPositionCustody {
    address public immutable deployer;
    address public immutable positionManager;
    address public bindingHook;
    uint256 public positionTokenId;
    bool public positionReceived;

    error AlreadyReceived();
    error BindingHookAlreadyConfigured();
    error CustodyHookMismatch(address actualHook);
    error InvalidBindingHook();
    error InvalidPositionManager();
    error InvalidPositionPoolKey();
    error InvalidPositionToken(uint256 actual);
    error InvalidPositionTicks(int24 actualLower, int24 actualUpper);
    error InvalidPositionLiquidity(uint128 actual);
    error NotMintedPosition();
    error PositionAlreadyBound();
    error PositionOwnershipMismatch(address actualOwner);
    error UnauthorizedBindingHook(address actualCaller);
    error UnauthorizedCustodyDeployer(address actualCaller);

    event BindingHookConfigured(address indexed hook);
    event PositionPermanentlyReceived(address indexed positionManager, uint256 indexed tokenId);

    constructor(address manager, uint256 tokenId) {
        if (manager == address(0)) revert InvalidPositionManager();
        deployer = msg.sender;
        positionManager = manager;
        positionTokenId = tokenId;
    }

    function configureBindingHook(address hook) external {
        if (msg.sender != deployer) revert UnauthorizedCustodyDeployer(msg.sender);
        if (hook == address(0)) revert InvalidBindingHook();
        if (bindingHook != address(0)) revert BindingHookAlreadyConfigured();
        if (positionTokenId != 0 || positionReceived) revert PositionAlreadyBound();

        bindingHook = hook;
        emit BindingHookConfigured(hook);
    }

    function finalizePosition() external {
        if (positionTokenId == 0) revert NotMintedPosition();
        _finalizePosition();
    }

    function bindMintedPosition(
        uint256 tokenId,
        PoolKey calldata expectedPoolKey,
        int24 expectedTickLower,
        int24 expectedTickUpper,
        uint256 expectedLiquidity
    ) external {
        if (msg.sender != bindingHook) {
            revert UnauthorizedBindingHook(msg.sender);
        }
        if (positionReceived) revert AlreadyReceived();
        if (positionTokenId != 0) revert InvalidPositionToken(positionTokenId);

        IPositionManagerPositionView manager = IPositionManagerPositionView(positionManager);
        address actualOwner = manager.ownerOf(tokenId);
        if (actualOwner != address(this)) revert PositionOwnershipMismatch(actualOwner);
        (PoolKey memory actualPoolKey, uint256 positionInfo) =
            manager.getPoolAndPositionInfo(tokenId);
        if (address(actualPoolKey.hooks) != msg.sender) {
            revert CustodyHookMismatch(address(actualPoolKey.hooks));
        }
        if (keccak256(abi.encode(actualPoolKey)) != keccak256(abi.encode(expectedPoolKey))) {
            revert InvalidPositionPoolKey();
        }
        (int24 actualTickLower, int24 actualTickUpper) = _ticks(positionInfo);
        if (actualTickLower != expectedTickLower || actualTickUpper != expectedTickUpper) {
            revert InvalidPositionTicks(actualTickLower, actualTickUpper);
        }
        uint128 actualLiquidity = manager.getPositionLiquidity(tokenId);
        if (uint256(actualLiquidity) != expectedLiquidity) {
            revert InvalidPositionLiquidity(actualLiquidity);
        }

        positionTokenId = tokenId;
        positionReceived = true;
        emit PositionPermanentlyReceived(positionManager, tokenId);
    }

    function _finalizePosition() private {
        if (positionReceived) revert AlreadyReceived();
        address actualOwner = IERC721OwnerOf(positionManager).ownerOf(positionTokenId);
        if (actualOwner != address(this)) revert PositionOwnershipMismatch(actualOwner);
        positionReceived = true;
        emit PositionPermanentlyReceived(positionManager, positionTokenId);
    }

    function _ticks(uint256 positionInfo) private pure returns (int24 tickLower, int24 tickUpper) {
        assembly ("memory-safe") {
            tickLower := signextend(2, shr(8, positionInfo))
            tickUpper := signextend(2, shr(32, positionInfo))
        }
    }
}
