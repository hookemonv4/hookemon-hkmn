// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { FeeAccounting } from "./accounting/FeeAccounting.sol";
import { MoneyRoles } from "./access/MoneyRoles.sol";
import { PermanentPositionCustody, RobinhoodBindings } from "./bindings/RobinhoodBindings.sol";
import { HookemonIssuance } from "./launch/HookemonIssuance.sol";
import { CanonicalMarketCallback } from "./market/CanonicalMarket.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { Actions } from "@uniswap/v4-periphery/src/libraries/Actions.sol";

interface ILaunchPermit2 {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);

    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function transferFrom(address from, address to, uint160 amount, address token) external;
}

interface ILaunchPositionManager {
    function nextTokenId() external view returns (uint256);

    function permit2() external view returns (address);

    function poolManager() external view returns (address);

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

interface IGraphIssuedToken {
    function validateGraphConfiguration(
        address canonicalMarket,
        address usdg,
        uint160 sqrtPriceX96,
        address expectedIssuanceAuthority,
        uint8 expectedDecimals
    ) external view returns (bool);

    function validateIssuedAllocation(
        address canonicalMarket,
        address usdg,
        address expectedIssuanceAuthority,
        uint8 expectedDecimals
    ) external view returns (bool);
}

/// @notice The immutable Hookemon v4 callback and money-accounting composition.
contract HookemonHook is FeeAccounting, MoneyRoles, CanonicalMarketCallback, HookemonIssuance {
    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    uint256 private constant PROCESS_CLAIM_WINDOW = 21_600;
    uint256 private constant MAX_PROCESS_CLAIM_WINDOW_ENTRIES = 64;
    uint256 private constant MAX_OPERATIONS_ROTATION_DELAY = 30 days;

    address private immutable programmableBeneficiary;
    address public immutable positionManager;
    address public immutable permit2;
    address public immutable launchAuthority;
    address public immutable graphInitializer;
    bool public immutable graphMode;
    uint8 public immutable graphExpectedDecimals;
    uint256 public immutable processClaimLimit6h;
    uint256 public immutable processClaimLimitMax;
    uint256 public immutable processClaimMaxCount;
    uint256 public immutable operationsRotationDelay;
    uint256 public processClaimLimit;
    uint256 public pendingProcessClaimLimit;
    uint256 public pendingProcessClaimLimitActivation;
    bool public processClaimsPaused;
    bool public canonicalPoolInitialized;
    bool public canonicalLiquiditySeeded;
    uint256 public canonicalPositionTokenId;
    address public canonicalLaunchCustody;

    struct ProcessClaimWindowEntry {
        uint256 amountAtomicUsdg;
        uint256 claimedAt;
    }

    struct ScheduledOperationsRotation {
        address expectedOperations;
        address nextOperations;
        uint256 executableAt;
    }

    mapping(uint256 entryIndex => ProcessClaimWindowEntry entry) private processClaimWindowEntries;
    uint256 private processClaimWindowHead;
    uint256 private processClaimWindowCount;
    uint256 private activeProcessClaimUsage;
    mapping(bytes32 cycleId => bool used) public processClaimCycleUsed;
    ScheduledOperationsRotation private pendingOperationsRotation;

    error InvalidHookAddress();
    error InvalidConstructorConfig();
    error InvalidProcessClaimConfig();
    error UnusedHookCallback();
    error InvalidUsdgCall();
    error InvalidUsdgIdentity();
    error InitializationNotAuthorized();
    error UnauthorizedLaunchAuthority();
    error UnauthorizedGraphInitializer();
    error CanonicalCustodyAlreadyConfigured();
    error InvalidGraphIssuance();
    error CanonicalPoolAlreadyInitialized();
    error CanonicalPoolNotInitialized();
    error CanonicalLiquidityAlreadySeeded();
    error InvalidSeedParams();
    error InvalidSeedCustody();
    error InvalidPositionManagerPermit2();
    error InvalidPositionManagerPoolManager();
    error PayerPermit2AllowanceInvalid();
    error SeedFundingMismatch();
    error SeedPositionMintMismatch();
    error SeedTokenApprovalFailed();
    error SeedResidualTransferFailed();
    error SeedRefundFailed();
    error ProcessClaimsArePaused();
    error ProcessClaimCycleAlreadyUsed();
    error ProcessClaimCapacityExceeded();
    error ProcessClaimEntryLimitReached();
    error ProcessClaimLimitExceedsMaximum();
    error OperationsRotationNotScheduled();
    error OperationsRotationNotReady();
    error StaleOperationsRotation();
    error OperationsRotationPending();
    error OperationsRotationTimestampOverflow();

    event CanonicalLiquiditySeeded(
        address indexed payer,
        address indexed custody,
        uint256 indexed positionTokenId,
        uint256 usdgRefund,
        uint256 hkmnDustTransferred
    );
    event ProcessClaimed(
        bytes32 indexed cycleId,
        uint256 amountAtomicUsdg,
        address indexed destination,
        uint256 timestamp,
        uint256 cap,
        uint256 usedAfter
    );
    event ProcessClaimLimitSet(uint256 activeLimit);
    event ProcessClaimLimitIncreaseScheduled(uint256 pendingLimit, uint256 activationTimestamp);
    event ProcessClaimsPaused(address indexed treasury);
    event ProcessClaimsUnpaused(address indexed treasury);
    event OperationsRotationScheduled(
        address indexed expectedOperations, address indexed nextOperations, uint256 executableAt
    );
    event OperationsRotationExecuted(
        address indexed previousOperations, address indexed nextOperations
    );

    struct ConstructorConfig {
        IPoolManager manager;
        address positionManager;
        address permit2;
        Currency usdg;
        Currency hkmn;
        int24 tickSpacing;
        address programmable;
        address treasury;
        address operations;
        address launchAuthority;
        address issuanceAuthority;
        uint8 expectedDecimals;
        bytes32 bindingDigest;
        bytes32 runtimeDigest;
        uint256 processClaimLimit6h;
        uint256 processClaimLimitMax;
        uint256 processClaimMaxCount;
        uint256 operationsRotationDelay;
    }

    struct SeedParams {
        int24 tickLower;
        int24 tickUpper;
        uint256 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        uint256 deadline;
        address payer;
        address custody;
    }

    constructor(ConstructorConfig memory config)
        FeeAccounting(config.programmable)
        MoneyRoles(config.programmable, config.treasury, config.operations)
        CanonicalMarketCallback(config.manager, config.usdg, config.hkmn, config.tickSpacing)
        HookemonIssuance(
            config.issuanceAuthority,
            config.expectedDecimals,
            config.bindingDigest,
            config.runtimeDigest
        )
    {
        if (config.programmable != RobinhoodBindings.PROGRAMMABLE_BENEFICIARY) {
            revert InvalidConstructorConfig();
        }
        if (uint160(address(this)) & ALL_HOOK_PERMISSION_MASK != REQUIRED_HOOK_PERMISSION_MASK) {
            revert InvalidHookAddress();
        }
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
        if (
            config.positionManager == address(0) || config.permit2 == address(0)
                || config.launchAuthority == address(0)
        ) revert InvalidConstructorConfig();
        bool knownProviderFactory = msg.sender == RobinhoodBindings.PROGRAMMABLE_GRAPH_FACTORY;
        if (knownProviderFactory && config.issuanceAuthority != msg.sender) {
            revert InvalidConstructorConfig();
        }
        bool graphMode_ = knownProviderFactory || config.issuanceAuthority == msg.sender;
        if (graphMode_ && config.launchAuthority == config.issuanceAuthority) {
            revert InvalidConstructorConfig();
        }
        if (
            config.processClaimLimit6h > config.processClaimLimitMax
                || config.processClaimMaxCount == 0
                || config.processClaimMaxCount > MAX_PROCESS_CLAIM_WINDOW_ENTRIES
                || config.operationsRotationDelay == 0
                || config.operationsRotationDelay > MAX_OPERATIONS_ROTATION_DELAY
        ) revert InvalidProcessClaimConfig();
        if (
            block.chainid == RobinhoodBindings.ROBINHOOD_CHAIN_ID
                && Currency.unwrap(config.usdg) != RobinhoodBindings.ROBINHOOD_USDG
        ) revert InvalidUsdgIdentity();
        programmableBeneficiary = config.programmable;
        positionManager = config.positionManager;
        permit2 = config.permit2;
        launchAuthority = config.launchAuthority;
        graphInitializer = config.issuanceAuthority;
        graphMode = graphMode_;
        graphExpectedDecimals = config.expectedDecimals;
        processClaimLimit6h = config.processClaimLimit6h;
        processClaimLimitMax = config.processClaimLimitMax;
        processClaimMaxCount = config.processClaimMaxCount;
        operationsRotationDelay = config.operationsRotationDelay;
        processClaimLimit = config.processClaimLimit6h;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
    }

    function hookPermissionMask() external pure override returns (uint160) {
        return REQUIRED_HOOK_PERMISSION_MASK;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert ForeignPoolManager();
        _;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external override returns (bytes4, BeforeSwapDelta, uint24) {
        (BeforeSwapDelta delta, uint24 feeOverride) = _beforeSwap(sender, key, params, hookData);
        return (IHooks.beforeSwap.selector, delta, feeOverride);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external override moneyPath returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, _afterSwap(sender, key, params, delta, hookData));
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert InitializationNotAuthorized();
    }

    function initializeCanonicalPool(uint160 sqrtPriceX96) external returns (int24 tick) {
        if (graphMode) revert InvalidGraphIssuance();
        if (msg.sender != launchAuthority) revert UnauthorizedLaunchAuthority();
        return _initializeCanonicalPool(sqrtPriceX96);
    }

    function initializeGraphLaunch(address custody, uint160 sqrtPriceX96)
        external
        returns (int24 tick)
    {
        if (!graphMode || msg.sender != graphInitializer) {
            revert UnauthorizedGraphInitializer();
        }
        if (canonicalPoolInitialized) revert CanonicalPoolAlreadyInitialized();
        _configureCanonicalLaunchCustody(custody);
        if (!_graphConfigurationIsValid(sqrtPriceX96)) revert InvalidGraphIssuance();
        return _initializeCanonicalPool(sqrtPriceX96);
    }

    function configureCanonicalLaunchCustody(address custody) external {
        if (graphMode) revert InvalidGraphIssuance();
        if (msg.sender != graphInitializer) revert UnauthorizedGraphInitializer();
        _configureCanonicalLaunchCustody(custody);
    }

    function _configureCanonicalLaunchCustody(address custody) private {
        if (canonicalLaunchCustody != address(0)) revert CanonicalCustodyAlreadyConfigured();
        if (custody == address(0) || custody.code.length == 0) revert InvalidSeedCustody();

        PermanentPositionCustody positionCustody = PermanentPositionCustody(custody);
        if (
            positionCustody.positionManager() != positionManager
                || positionCustody.positionTokenId() != 0 || positionCustody.positionReceived()
                || positionCustody.bindingHook() != address(this)
        ) revert InvalidSeedCustody();
        canonicalLaunchCustody = custody;
    }

    function _initializeCanonicalPool(uint160 sqrtPriceX96) internal returns (int24 tick) {
        if (canonicalPoolInitialized) revert CanonicalPoolAlreadyInitialized();
        tick = poolManager.initialize(_canonicalPoolKey(), sqrtPriceX96);
        canonicalPoolInitialized = true;
    }

    function seedCanonicalLiquidity(SeedParams calldata params) external {
        if (msg.sender != launchAuthority) revert UnauthorizedLaunchAuthority();
        if (!canonicalPoolInitialized) revert CanonicalPoolNotInitialized();
        if (canonicalLiquiditySeeded) revert CanonicalLiquidityAlreadySeeded();
        if (
            params.payer == address(0) || params.custody == address(0)
                || params.custody.code.length == 0 || params.liquidity == 0
                || params.tickLower >= params.tickUpper || params.tickLower % tickSpacing != 0
                || params.tickUpper % tickSpacing != 0 || params.deadline < block.timestamp
        ) revert InvalidSeedParams();

        PoolKey memory key = _canonicalPoolKey();
        (uint256 usdgMax, uint256 hkmnMax) = _seedMaximums(key, params);
        uint256 hkmnBalanceBefore = _tokenBalance(Currency.unwrap(hkmn), address(this));
        uint256 usdgBalanceBefore = _usdgBalanceOf(address(this));
        if (hkmnMax == 0 || usdgMax == 0 || hkmnMax != hkmnBalanceBefore) {
            revert InvalidSeedParams();
        }

        PermanentPositionCustody custody = PermanentPositionCustody(params.custody);
        if (
            custody.positionManager() != positionManager || custody.positionTokenId() != 0
                || custody.positionReceived() || custody.bindingHook() != address(this)
        ) revert InvalidSeedCustody();
        ILaunchPositionManager manager = ILaunchPositionManager(positionManager);
        if (manager.permit2() != permit2) revert InvalidPositionManagerPermit2();
        if (manager.poolManager() != address(poolManager)) {
            revert InvalidPositionManagerPoolManager();
        }
        if (graphMode && (params.custody != canonicalLaunchCustody || !_issuedAllocationIsValid()))
        {
            revert InvalidSeedCustody();
        }
        _requireExactPayerAllowance(params.payer, usdgMax);

        canonicalLiquiditySeeded = true;
        ILaunchPermit2(permit2)
            .transferFrom(params.payer, address(this), uint160(usdgMax), Currency.unwrap(usdg));
        if (_usdgBalanceOf(address(this)) != usdgBalanceBefore + usdgMax) {
            revert SeedFundingMismatch();
        }

        uint256 mintedTokenId =
            _mintAndBindCanonicalPosition(manager, custody, key, params, usdgMax, hkmnMax);
        canonicalPositionTokenId = mintedTokenId;

        uint256 usdgRefund = _refundUsdg(params.payer, usdgBalanceBefore);
        uint256 hkmnDustTransferred;
        if (graphMode) {
            if (_tokenBalance(Currency.unwrap(hkmn), address(this)) != 0) {
                revert SeedResidualTransferFailed();
            }
        } else {
            hkmnDustTransferred = _transferHkmnDustToTreasury();
        }
        emit CanonicalLiquiditySeeded(
            params.payer, params.custody, mintedTokenId, usdgRefund, hkmnDustTransferred
        );
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert UnusedHookCallback();
    }

    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        revert UnusedHookCallback();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4, BalanceDelta) {
        revert UnusedHookCallback();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        revert UnusedHookCallback();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4, BalanceDelta) {
        revert UnusedHookCallback();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert UnusedHookCallback();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert UnusedHookCallback();
    }

    function claimProgrammable(address destination) external returns (uint256 amount) {
        _authorizeProgrammableClaim(programmableBeneficiary, destination);
        return _claimProgrammableLiability(destination);
    }

    function claimProgrammable(uint256 amountAtomicUsdg, address destination)
        external
        returns (uint256 amount)
    {
        _authorizeProgrammableClaim(programmableBeneficiary, destination);
        return _claimProgrammableLiability(amountAtomicUsdg, destination);
    }

    function claimTreasury(address destination) external returns (uint256 amount) {
        _authorizeTreasuryClaim(msg.sender, destination);
        return _claimTreasuryLiability(destination);
    }

    function claimTreasury(uint256 amountAtomicUsdg, address destination)
        external
        returns (uint256 amount)
    {
        _authorizeTreasuryClaim(msg.sender, destination);
        return _claimTreasuryLiability(amountAtomicUsdg, destination);
    }

    function claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)
        external
        returns (uint256 amount)
    {
        _authorizeProcessClaim(destination);
        if (processClaimsPaused) revert ProcessClaimsArePaused();
        if (cycleId == bytes32(0)) revert InvalidCycle();
        if (processClaimCycleUsed[cycleId]) revert ProcessClaimCycleAlreadyUsed();

        _activateProcessClaimLimitIfDue();
        _pruneExpiredProcessClaimEntries();
        uint256 cap = processClaimLimit;
        uint256 used = activeProcessClaimUsage;
        if (amountAtomicUsdg == 0 || amountAtomicUsdg > _processLiability()) {
            revert InvalidLiabilityAmount();
        }
        if (used >= cap || amountAtomicUsdg > cap - used) revert ProcessClaimCapacityExceeded();
        if (processClaimWindowCount == processClaimMaxCount) {
            revert ProcessClaimEntryLimitReached();
        }

        uint256 entryIndex =
            (processClaimWindowHead + processClaimWindowCount) % processClaimMaxCount;
        processClaimCycleUsed[cycleId] = true;
        processClaimWindowEntries[entryIndex] = ProcessClaimWindowEntry({
            amountAtomicUsdg: amountAtomicUsdg, claimedAt: block.timestamp
        });
        ++processClaimWindowCount;
        uint256 usedAfter = used + amountAtomicUsdg;
        activeProcessClaimUsage = usedAfter;

        amount = _claimProcessLiability(amountAtomicUsdg, destination);
        emit ProcessClaimed(cycleId, amount, destination, block.timestamp, cap, usedAfter);
    }

    function remainingProcessClaimCapacity() external view returns (uint256) {
        uint256 cap = _effectiveProcessClaimLimit();
        uint256 used = _activeProcessClaimUsage();
        return used >= cap ? 0 : cap - used;
    }

    function activeProcessClaimLimit() external view returns (uint256) {
        return _effectiveProcessClaimLimit();
    }

    function setProcessClaimLimit(uint256 newLimit) external {
        _authorizeTreasuryControl();
        uint256 activeLimit = _activateProcessClaimLimitIfDue();
        if (newLimit <= activeLimit) {
            processClaimLimit = newLimit;
            delete pendingProcessClaimLimit;
            delete pendingProcessClaimLimitActivation;
            emit ProcessClaimLimitSet(newLimit);
            return;
        }
        if (newLimit > processClaimLimitMax) revert ProcessClaimLimitExceedsMaximum();

        pendingProcessClaimLimit = newLimit;
        pendingProcessClaimLimitActivation = block.timestamp + PROCESS_CLAIM_WINDOW;
        emit ProcessClaimLimitIncreaseScheduled(newLimit, pendingProcessClaimLimitActivation);
    }

    function pauseProcessClaims() external {
        _authorizeTreasuryControl();
        _pauseProcessClaims();
    }

    function unpauseProcessClaims() external {
        _authorizeTreasuryControl();
        if (pendingOperationsRotation.nextOperations != address(0)) {
            revert OperationsRotationPending();
        }
        if (processClaimsPaused) {
            processClaimsPaused = false;
            emit ProcessClaimsUnpaused(msg.sender);
        }
    }

    function scheduleOperationsRotation(address nextOperations) external {
        _authorizeTreasuryControl();
        address expectedOperations = _currentOperations();
        _validateRoleSuccessor(nextOperations, expectedOperations);
        _validateOperationsSuccessor(nextOperations);

        if (block.timestamp > type(uint256).max - operationsRotationDelay) {
            revert OperationsRotationTimestampOverflow();
        }
        uint256 executableAt = block.timestamp + operationsRotationDelay;
        _clearProposedOperations();
        pendingOperationsRotation = ScheduledOperationsRotation({
            expectedOperations: expectedOperations,
            nextOperations: nextOperations,
            executableAt: executableAt
        });
        _pauseProcessClaims();
        emit OperationsRotationScheduled(expectedOperations, nextOperations, executableAt);
    }

    function executeOperationsRotation() external {
        _authorizeTreasuryControl();
        ScheduledOperationsRotation memory rotation = pendingOperationsRotation;
        if (rotation.nextOperations == address(0)) revert OperationsRotationNotScheduled();
        if (block.timestamp < rotation.executableAt) revert OperationsRotationNotReady();
        if (_currentOperations() != rotation.expectedOperations) revert StaleOperationsRotation();

        address previousOperations = _replaceOperationsForEmergencyRotation(rotation.nextOperations);
        delete pendingOperationsRotation;
        _pauseProcessClaims();
        emit OperationsRotationExecuted(previousOperations, rotation.nextOperations);
    }

    function scheduledOperationsRotation()
        external
        view
        returns (address expectedOperations, address nextOperations, uint256 executableAt)
    {
        ScheduledOperationsRotation memory rotation = pendingOperationsRotation;
        return (rotation.expectedOperations, rotation.nextOperations, rotation.executableAt);
    }

    function readFeeLiabilities(address treasuryBeneficiary)
        external
        view
        returns (uint256 programmable, uint256 treasury, uint256 process)
    {
        return (
            _programmableLiabilityOf(programmableBeneficiary),
            _treasuryLiabilityOf(treasuryBeneficiary),
            _processLiability()
        );
    }

    function processLiability() external view returns (uint256) {
        return _processLiability();
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

    function _activateProcessClaimLimitIfDue() private returns (uint256 activeLimit) {
        if (
            pendingProcessClaimLimitActivation != 0
                && block.timestamp >= pendingProcessClaimLimitActivation
        ) {
            processClaimLimit = pendingProcessClaimLimit;
            delete pendingProcessClaimLimit;
            delete pendingProcessClaimLimitActivation;
            emit ProcessClaimLimitSet(processClaimLimit);
        }
        return processClaimLimit;
    }

    function _effectiveProcessClaimLimit() private view returns (uint256) {
        if (
            pendingProcessClaimLimitActivation != 0
                && block.timestamp >= pendingProcessClaimLimitActivation
        ) {
            return pendingProcessClaimLimit;
        }
        return processClaimLimit;
    }

    function _activeProcessClaimUsage() private view returns (uint256 used) {
        for (uint256 offset; offset < processClaimWindowCount; ++offset) {
            uint256 entryIndex = (processClaimWindowHead + offset) % processClaimMaxCount;
            ProcessClaimWindowEntry storage entry = processClaimWindowEntries[entryIndex];
            if (block.timestamp - entry.claimedAt < PROCESS_CLAIM_WINDOW) {
                used += entry.amountAtomicUsdg;
            }
        }
    }

    function _pruneExpiredProcessClaimEntries() private {
        while (processClaimWindowCount != 0) {
            ProcessClaimWindowEntry memory entry = processClaimWindowEntries[processClaimWindowHead];
            if (block.timestamp - entry.claimedAt < PROCESS_CLAIM_WINDOW) return;

            activeProcessClaimUsage -= entry.amountAtomicUsdg;
            delete processClaimWindowEntries[processClaimWindowHead];
            processClaimWindowHead = (processClaimWindowHead + 1) % processClaimMaxCount;
            --processClaimWindowCount;
        }
    }

    function _pauseProcessClaims() private {
        if (!processClaimsPaused) {
            processClaimsPaused = true;
            emit ProcessClaimsPaused(msg.sender);
        }
    }

    function _requireOperationsHandoverAvailable() internal view override {
        if (pendingOperationsRotation.nextOperations != address(0)) {
            revert OperationsRotationPending();
        }
    }

    function _currentTreasuryBeneficiary() internal view override returns (address) {
        return _currentTreasury();
    }

    function _canonicalPoolKey() private view returns (PoolKey memory key) {
        address currency0 = Currency.unwrap(usdg) < Currency.unwrap(hkmn)
            ? Currency.unwrap(usdg)
            : Currency.unwrap(hkmn);
        address currency1 =
            currency0 == Currency.unwrap(usdg) ? Currency.unwrap(hkmn) : Currency.unwrap(usdg);
        key = PoolKey({
            currency0: Currency.wrap(currency0),
            currency1: Currency.wrap(currency1),
            fee: 0,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(this))
        });
    }

    function _graphConfigurationIsValid(uint160 sqrtPriceX96) private view returns (bool) {
        (bool success, bytes memory result) = Currency.unwrap(hkmn)
            .staticcall(
                abi.encodeCall(
                    IGraphIssuedToken.validateGraphConfiguration,
                    (
                        address(this),
                        Currency.unwrap(usdg),
                        sqrtPriceX96,
                        graphInitializer,
                        graphExpectedDecimals
                    )
                )
            );
        return _strictBooleanResult(success, result);
    }

    function _issuedAllocationIsValid() private view returns (bool) {
        (bool success, bytes memory result) = Currency.unwrap(hkmn)
            .staticcall(
                abi.encodeCall(
                    IGraphIssuedToken.validateIssuedAllocation,
                    (address(this), Currency.unwrap(usdg), graphInitializer, graphExpectedDecimals)
                )
            );
        return _strictBooleanResult(success, result);
    }

    function _strictBooleanResult(bool success, bytes memory result) private pure returns (bool) {
        if (!success || result.length != 32) return false;
        uint256 value;
        assembly ("memory-safe") {
            value := mload(add(result, 0x20))
        }
        return value == 1;
    }

    function _seedMaximums(PoolKey memory key, SeedParams calldata params)
        private
        view
        returns (uint256 usdgMax, uint256 hkmnMax)
    {
        bool usdgIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(usdg);
        usdgMax = usdgIsCurrency0 ? params.amount0Max : params.amount1Max;
        hkmnMax = usdgIsCurrency0 ? params.amount1Max : params.amount0Max;
    }

    function _requireExactPayerAllowance(address payer, uint256 usdgMax) private view {
        (uint160 amount, uint48 expiration,) =
            ILaunchPermit2(permit2).allowance(payer, Currency.unwrap(usdg), address(this));
        if (uint256(amount) != usdgMax || uint256(expiration) < block.timestamp) {
            revert PayerPermit2AllowanceInvalid();
        }
    }

    function _setPositionManagerApprovals(uint256 usdgMax, uint256 hkmnMax) private {
        address usdgToken = Currency.unwrap(usdg);
        address hkmnToken = Currency.unwrap(hkmn);
        _approveToken(usdgToken, permit2, 0);
        _approveToken(hkmnToken, permit2, 0);
        _approveToken(usdgToken, permit2, usdgMax);
        _approveToken(hkmnToken, permit2, hkmnMax);
        ILaunchPermit2 permit = ILaunchPermit2(permit2);
        permit.approve(usdgToken, positionManager, uint160(usdgMax), uint48(block.timestamp));
        permit.approve(hkmnToken, positionManager, uint160(hkmnMax), uint48(block.timestamp));
    }

    function _mintCanonicalPosition(
        ILaunchPositionManager manager,
        PoolKey memory key,
        SeedParams calldata params
    ) private {
        bytes[] memory actionParams = new bytes[](2);
        actionParams[0] = abi.encode(
            key,
            params.tickLower,
            params.tickUpper,
            params.liquidity,
            params.amount0Max,
            params.amount1Max,
            params.custody,
            bytes("")
        );
        actionParams[1] = abi.encode(key.currency0, key.currency1);
        manager.modifyLiquidities(
            abi.encode(
                abi.encodePacked(
                    bytes1(uint8(Actions.MINT_POSITION)), bytes1(uint8(Actions.SETTLE_PAIR))
                ),
                actionParams
            ),
            params.deadline
        );
    }

    function _mintAndBindCanonicalPosition(
        ILaunchPositionManager manager,
        PermanentPositionCustody custody,
        PoolKey memory key,
        SeedParams calldata params,
        uint256 usdgMax,
        uint256 hkmnMax
    ) private returns (uint256 mintedTokenId) {
        uint256 nextTokenIdBefore = manager.nextTokenId();
        _setPositionManagerApprovals(usdgMax, hkmnMax);
        _mintCanonicalPosition(manager, key, params);
        _clearPositionManagerApprovals();

        uint256 nextTokenIdAfter = manager.nextTokenId();
        if (nextTokenIdAfter != nextTokenIdBefore + 1) revert SeedPositionMintMismatch();
        mintedTokenId = nextTokenIdBefore;
        custody.bindMintedPosition(
            mintedTokenId, key, params.tickLower, params.tickUpper, params.liquidity
        );
    }

    function _clearPositionManagerApprovals() private {
        address usdgToken = Currency.unwrap(usdg);
        address hkmnToken = Currency.unwrap(hkmn);
        ILaunchPermit2 permit = ILaunchPermit2(permit2);
        permit.approve(usdgToken, positionManager, 0, 0);
        permit.approve(hkmnToken, positionManager, 0, 0);
        _approveToken(usdgToken, permit2, 0);
        _approveToken(hkmnToken, permit2, 0);
    }

    function _refundUsdg(address payer, uint256 balanceBefore) private returns (uint256 refund) {
        uint256 balanceAfter = _usdgBalanceOf(address(this));
        if (balanceAfter < balanceBefore) revert SeedFundingMismatch();
        refund = balanceAfter - balanceBefore;
        if (refund != 0 && !_transferUsdg(payer, refund)) revert SeedRefundFailed();
        if (_usdgBalanceOf(address(this)) != balanceBefore) revert SeedRefundFailed();
    }

    function _transferHkmnDustToTreasury() private returns (uint256 transferred) {
        address hkmnToken = Currency.unwrap(hkmn);
        transferred = _tokenBalance(hkmnToken, address(this));
        if (transferred != 0) {
            (bool success, bytes memory result) = hkmnToken.call(
                abi.encodeWithSelector(bytes4(0xa9059cbb), _currentTreasury(), transferred)
            );
            if (!success || result.length != 32 || !abi.decode(result, (bool))) {
                revert SeedResidualTransferFailed();
            }
        }
        if (_tokenBalance(hkmnToken, address(this)) != 0) revert SeedResidualTransferFailed();
    }

    function _approveToken(address token, address spender, uint256 amount) private {
        (bool success, bytes memory result) =
            token.call(abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount));
        if (!success || result.length != 32 || !abi.decode(result, (bool))) {
            revert SeedTokenApprovalFailed();
        }
    }

    function _tokenBalance(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory result) =
            token.staticcall(abi.encodeWithSelector(bytes4(0x70a08231), account));
        if (!success || result.length != 32) revert InvalidUsdgCall();
        balance = abi.decode(result, (uint256));
    }

    function _collectFee(Currency currency, uint256 feeAmount)
        internal
        override
        returns (uint256 balanceBeforeCollection)
    {
        balanceBeforeCollection = _usdgBalanceOf(address(this));
        if (feeAmount != 0) poolManager.take(currency, address(this), feeAmount);
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

    function _usdgBalanceOf(address account) internal view override returns (uint256 balance) {
        (bool success, bytes memory result) =
            Currency.unwrap(usdg).staticcall(abi.encodeWithSelector(bytes4(0x70a08231), account));
        if (!success || result.length != 32) revert InvalidUsdgCall();
        balance = abi.decode(result, (uint256));
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        (bool success, bytes memory result) = Currency.unwrap(usdg)
            .call(abi.encodeWithSelector(bytes4(0xa9059cbb), recipient, amount));
        if (!success || result.length != 32 || !abi.decode(result, (bool))) {
            return false;
        }
        return true;
    }
}
