// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Provider-independent, fail-closed guard for one future bound HKMN issuance.
/// @dev This component never calls a provider, deploys a token, transfers value, or proves that
///      caller-supplied observations came from Robinhood. A provider adapter may compose it only
///      after the exact ABI, runtime, decimals, allocation path, and remainder treatment are bound.
abstract contract HookemonIssuance {
    uint256 internal constant WHOLE_HKMN_SUPPLY = 420_690_000_000;
    bytes32 internal constant HOOKEMON_NAME_HASH = keccak256("Hookemon");
    bytes32 internal constant HKMN_SYMBOL_HASH = keccak256("HKMN");

    enum GuardStatus {
        UNPREPARED,
        PREPARED_PROVIDER_CALL_UNAVAILABLE,
        OBSERVATION_VERIFIED_PROVIDER_BINDING_PENDING
    }

    struct IssuancePlan {
        uint8 decimals;
        address issuanceSource;
        address canonicalMarket;
        address remainderRepresentation;
        address marketPositionCustody;
        address projectWallet;
        uint256 totalSupply;
        uint256 marketAllocation;
        uint256 remainderAllocation;
        uint256 otherAllocation;
        bytes32 bindingManifestDigest;
        bytes32 runtimeAuthorityDigest;
        bytes32 providerCallDigest;
        bytes32 remainderTreatmentDigest;
        bytes32 custodyCommitment;
    }

    struct IssuanceObservation {
        bytes32 planDigest;
        address token;
        bytes32 nameHash;
        bytes32 symbolHash;
        uint8 decimals;
        uint256 totalSupply;
        uint256 canonicalMarketBalance;
        uint256 remainderBalance;
        uint256 issuanceSourceBalance;
        uint256 projectWalletBalance;
        uint256 otherAllocation;
        bytes32 bindingManifestDigest;
        bytes32 runtimeAuthorityDigest;
        bytes32 providerCallDigest;
        bytes32 remainderTreatmentDigest;
        bytes32 custodyCommitment;
    }

    struct TransferRecord {
        address from;
        address to;
        uint256 amount;
    }

    struct IssuanceGuardState {
        GuardStatus status;
        bytes32 preparedPlanDigest;
        bytes32 observationDigest;
        address token;
    }

    address private immutable _issuanceAuthority;
    uint8 private immutable _expectedDecimals;
    bytes32 private immutable _requiredBindingManifestDigest;
    bytes32 private immutable _requiredRuntimeAuthorityDigest;
    IssuanceGuardState private _guardState;

    error InvalidAuthority();
    error InvalidEvidence();
    error InvalidIdentity();
    error InvalidAllocation();
    error InvalidTrace();
    error GuardAlreadyPrepared();
    error GuardNotPrepared();
    error GuardAlreadyVerified();

    constructor(
        address issuanceAuthority,
        uint8 expectedDecimals,
        bytes32 bindingManifestDigest,
        bytes32 runtimeAuthorityDigest
    ) {
        if (issuanceAuthority == address(0) || issuanceAuthority == address(this)) {
            revert InvalidAuthority();
        }
        if (bindingManifestDigest == bytes32(0) || runtimeAuthorityDigest == bytes32(0)) {
            revert InvalidEvidence();
        }
        _scaledSupply(expectedDecimals);
        _issuanceAuthority = issuanceAuthority;
        _expectedDecimals = expectedDecimals;
        _requiredBindingManifestDigest = bindingManifestDigest;
        _requiredRuntimeAuthorityDigest = runtimeAuthorityDigest;
    }

    /// @notice Freezes one guard plan without calling or authorizing a provider.
    function prepareOfficialIssuance(IssuancePlan calldata plan)
        external
        returns (bytes32 planDigest)
    {
        _requireAuthority();
        if (_guardState.status != GuardStatus.UNPREPARED) revert GuardAlreadyPrepared();
        _validatePlan(plan);
        planDigest = keccak256(abi.encode(plan));
        _guardState.status = GuardStatus.PREPARED_PROVIDER_CALL_UNAVAILABLE;
        _guardState.preparedPlanDigest = planDigest;
    }

    /// @notice Consumes one exact observation; it does not authenticate the observation source.
    function verifyIssuance(
        IssuancePlan calldata plan,
        IssuanceObservation calldata observation,
        TransferRecord[] calldata trace
    ) external {
        _requireAuthority();
        if (_guardState.status == GuardStatus.UNPREPARED) revert GuardNotPrepared();
        if (_guardState.status != GuardStatus.PREPARED_PROVIDER_CALL_UNAVAILABLE) {
            revert GuardAlreadyVerified();
        }
        _validatePlan(plan);
        bytes32 planDigest = keccak256(abi.encode(plan));
        if (planDigest != _guardState.preparedPlanDigest || observation.planDigest != planDigest) {
            revert InvalidEvidence();
        }
        _validateObservation(plan, observation);
        bytes32 traceDigest = _validateTrace(plan, trace);

        _guardState.status = GuardStatus.OBSERVATION_VERIFIED_PROVIDER_BINDING_PENDING;
        _guardState.observationDigest = keccak256(abi.encode(observation, traceDigest));
        _guardState.token = observation.token;
    }

    function readTokenState() external view returns (IssuanceGuardState memory) {
        return _guardState;
    }

    function _validatePlan(IssuancePlan calldata plan) private view {
        if (plan.decimals != _expectedDecimals) revert InvalidIdentity();
        uint256 expectedSupply = _scaledSupply(plan.decimals);
        uint256 expectedMarketAllocation = _basisPoints(expectedSupply, 9_000);
        if (
            plan.totalSupply != expectedSupply || plan.marketAllocation != expectedMarketAllocation
                || plan.remainderAllocation != expectedSupply - expectedMarketAllocation
                || plan.otherAllocation != 0
        ) revert InvalidAllocation();

        _requireDistinctDestinations(plan);
        if (plan.issuanceSource == plan.projectWallet) revert InvalidIdentity();
        if (
            plan.issuanceSource != address(0)
                && (plan.issuanceSource == plan.canonicalMarket
                    || plan.issuanceSource == plan.remainderRepresentation
                    || plan.issuanceSource == plan.marketPositionCustody)
        ) revert InvalidIdentity();
        if (
            plan.bindingManifestDigest != _requiredBindingManifestDigest
                || plan.runtimeAuthorityDigest != _requiredRuntimeAuthorityDigest
                || plan.providerCallDigest == bytes32(0)
                || plan.remainderTreatmentDigest == bytes32(0)
                || plan.custodyCommitment == bytes32(0)
        ) revert InvalidEvidence();
    }

    function _validateObservation(
        IssuancePlan calldata plan,
        IssuanceObservation calldata observation
    ) private pure {
        if (
            observation.token == address(0) || observation.token == plan.projectWallet
                || observation.token == plan.canonicalMarket
                || observation.token == plan.remainderRepresentation
                || observation.token == plan.marketPositionCustody
                || (plan.issuanceSource != address(0) && observation.token == plan.issuanceSource)
                || observation.nameHash != HOOKEMON_NAME_HASH
                || observation.symbolHash != HKMN_SYMBOL_HASH
                || observation.decimals != plan.decimals
        ) revert InvalidIdentity();
        if (
            observation.totalSupply != plan.totalSupply
                || observation.canonicalMarketBalance != plan.marketAllocation
                || observation.remainderBalance != plan.remainderAllocation
                || observation.issuanceSourceBalance != 0 || observation.projectWalletBalance != 0
                || observation.otherAllocation != 0
        ) revert InvalidAllocation();
        if (
            observation.bindingManifestDigest != plan.bindingManifestDigest
                || observation.runtimeAuthorityDigest != plan.runtimeAuthorityDigest
                || observation.providerCallDigest != plan.providerCallDigest
                || observation.remainderTreatmentDigest != plan.remainderTreatmentDigest
                || observation.custodyCommitment != plan.custodyCommitment
        ) revert InvalidEvidence();
    }

    function _validateTrace(IssuancePlan calldata plan, TransferRecord[] calldata trace)
        private
        pure
        returns (bytes32 traceDigest)
    {
        if (trace.length != 2) revert InvalidTrace();
        bool sawMarket;
        bool sawRemainder;
        for (uint256 index; index < trace.length; ++index) {
            TransferRecord calldata record = trace[index];
            if (
                record.from != plan.issuanceSource || record.to == address(0)
                    || record.to == plan.projectWallet || record.amount == 0
            ) revert InvalidTrace();
            if (record.to == plan.canonicalMarket && record.amount == plan.marketAllocation) {
                if (sawMarket) revert InvalidTrace();
                sawMarket = true;
            } else if (
                record.to == plan.remainderRepresentation
                    && record.amount == plan.remainderAllocation
            ) {
                if (sawRemainder) revert InvalidTrace();
                sawRemainder = true;
            } else {
                revert InvalidTrace();
            }
        }
        if (!sawMarket || !sawRemainder) revert InvalidTrace();
        traceDigest = keccak256(abi.encode(trace));
    }

    function _requireDistinctDestinations(IssuancePlan calldata plan) private pure {
        address market = plan.canonicalMarket;
        address remainder = plan.remainderRepresentation;
        address custody = plan.marketPositionCustody;
        address project = plan.projectWallet;
        if (
            market == address(0) || remainder == address(0) || custody == address(0)
                || project == address(0) || market == remainder || market == custody
                || market == project || remainder == custody || remainder == project
                || custody == project
        ) revert InvalidIdentity();
    }

    function _requireAuthority() private view {
        if (msg.sender != _issuanceAuthority) revert InvalidAuthority();
    }

    function _scaledSupply(uint8 decimals) private pure returns (uint256 supply) {
        uint256 scale = 1;
        for (uint256 index; index < decimals; ++index) {
            if (scale > type(uint256).max / 10) revert InvalidAllocation();
            scale *= 10;
        }
        if (WHOLE_HKMN_SUPPLY > type(uint256).max / scale) revert InvalidAllocation();
        supply = WHOLE_HKMN_SUPPLY * scale;
    }

    function _basisPoints(uint256 amount, uint256 basisPoints) private pure returns (uint256) {
        return amount / 10_000 * basisPoints + amount % 10_000 * basisPoints / 10_000;
    }
}

/// @notice Fixed-supply HKMN target for the three-target Programmable graph.
contract HKMNToken {
    uint256 public constant WHOLE_HKMN_SUPPLY = 420_690_000_000;
    uint256 public constant MARKET_ALLOCATION_BPS = 9_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint8 public constant CANONICAL_DECIMALS = 18;

    string public constant name = "Hookemon";
    string public constant symbol = "HKMN";
    uint8 public immutable decimals;
    uint256 public immutable totalSupply;
    address public immutable issuanceAuthority;
    address public immutable expectedUsdg;
    uint160 public immutable launchSqrtPriceX96;
    address public canonicalMarket;
    address public remainderCustody;
    bool public allocated;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    error AllocationAlreadyCompleted();
    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidAllocationTarget();
    error InvalidLaunchConfiguration();
    error UnauthorizedIssuanceAuthority(address caller);

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AllocationCompleted(
        address indexed canonicalMarket,
        address indexed remainderCustody,
        uint256 marketAllocation,
        uint256 remainderAllocation
    );

    constructor(
        address issuanceAuthority_,
        address expectedUsdg_,
        uint8 decimals_,
        uint160 launchSqrtPriceX96_
    ) {
        if (
            issuanceAuthority_ == address(0) || issuanceAuthority_ != msg.sender
                || expectedUsdg_ == address(0) || decimals_ != CANONICAL_DECIMALS
                || launchSqrtPriceX96_ == 0
        ) revert InvalidLaunchConfiguration();
        uint256 scale = _scale(decimals_);
        if (WHOLE_HKMN_SUPPLY > type(uint256).max / scale) revert InvalidLaunchConfiguration();

        issuanceAuthority = issuanceAuthority_;
        expectedUsdg = expectedUsdg_;
        decimals = decimals_;
        launchSqrtPriceX96 = launchSqrtPriceX96_;
        totalSupply = WHOLE_HKMN_SUPPLY * scale;
        balanceOf[address(this)] = totalSupply;
        emit Transfer(address(0), address(this), totalSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = allowance[owner][msg.sender];
        if (approved != type(uint256).max) {
            if (approved < amount) revert InsufficientAllowance();
            unchecked {
                allowance[owner][msg.sender] = approved - amount;
            }
            emit Approval(owner, msg.sender, allowance[owner][msg.sender]);
        }
        _transfer(owner, recipient, amount);
        return true;
    }

    /// @notice Transfers the exact 90/10 allocation after the graph has deployed every target.
    function allocate(address canonicalMarket_, address remainderCustody_) external {
        if (msg.sender != issuanceAuthority) revert UnauthorizedIssuanceAuthority(msg.sender);
        if (allocated) revert AllocationAlreadyCompleted();
        if (
            canonicalMarket_ == address(0) || remainderCustody_ == address(0)
                || canonicalMarket_ == remainderCustody_ || canonicalMarket_.code.length == 0
                || remainderCustody_.code.length == 0
        ) revert InvalidAllocationTarget();

        allocated = true;
        canonicalMarket = canonicalMarket_;
        remainderCustody = remainderCustody_;

        uint256 marketAllocation = _basisPoints(totalSupply, MARKET_ALLOCATION_BPS);
        uint256 remainderAllocation = totalSupply - marketAllocation;
        _transfer(address(this), canonicalMarket_, marketAllocation);
        _transfer(address(this), remainderCustody_, remainderAllocation);
        emit AllocationCompleted(
            canonicalMarket_, remainderCustody_, marketAllocation, remainderAllocation
        );
    }

    function validateGraphConfiguration(
        address canonicalMarket_,
        address remainderCustody_,
        address usdg_,
        uint160 sqrtPriceX96,
        address expectedIssuanceAuthority_,
        uint8 expectedDecimals_
    ) external view returns (bool) {
        return _allocationMatches(
            canonicalMarket_,
            remainderCustody_,
            usdg_,
            expectedIssuanceAuthority_,
            expectedDecimals_
        ) && sqrtPriceX96 == launchSqrtPriceX96;
    }

    function validateIssuedAllocation(
        address canonicalMarket_,
        address remainderCustody_,
        address usdg_,
        address expectedIssuanceAuthority_,
        uint8 expectedDecimals_
    ) external view returns (bool) {
        return _allocationMatches(
            canonicalMarket_,
            remainderCustody_,
            usdg_,
            expectedIssuanceAuthority_,
            expectedDecimals_
        );
    }

    function _allocationMatches(
        address canonicalMarket_,
        address remainderCustody_,
        address usdg_,
        address expectedIssuanceAuthority_,
        uint8 expectedDecimals_
    ) private view returns (bool) {
        uint256 marketAllocation = _basisPoints(totalSupply, MARKET_ALLOCATION_BPS);
        return allocated && issuanceAuthority == expectedIssuanceAuthority_
            && expectedDecimals_ == CANONICAL_DECIMALS && decimals == expectedDecimals_
            && totalSupply == WHOLE_HKMN_SUPPLY * _scale(expectedDecimals_) && usdg_ == expectedUsdg
            && canonicalMarket_ == canonicalMarket && remainderCustody_ == remainderCustody
            && balanceOf[canonicalMarket_] == marketAllocation
            && balanceOf[remainderCustody_] == totalSupply - marketAllocation
            && balanceOf[address(this)] == 0;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidAllocationTarget();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _scale(uint8 decimals_) private pure returns (uint256 scale) {
        scale = 1;
        for (uint256 index; index < decimals_; ++index) {
            if (scale > type(uint256).max / 10) revert InvalidLaunchConfiguration();
            scale *= 10;
        }
    }

    function _basisPoints(uint256 amount, uint256 basisPoints) private pure returns (uint256) {
        return amount / BPS_DENOMINATOR * basisPoints + amount % BPS_DENOMINATOR * basisPoints
            / BPS_DENOMINATOR;
    }
}
