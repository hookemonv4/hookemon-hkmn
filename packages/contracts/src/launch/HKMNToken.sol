// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Fixed-supply HKMN target for the three-target Programmable graph.
contract HKMNToken {
    uint256 public constant WHOLE_HKMN_SUPPLY = 1_000_000_000;
    uint256 public constant MARKET_ALLOCATION_BPS = 10_000;
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
    event AllocationCompleted(address indexed canonicalMarket, uint256 marketAllocation);

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

    /// @notice Transfers the complete fixed supply to the canonical market after graph deployment.
    function allocate(address canonicalMarket_) external {
        _allocate(canonicalMarket_);
    }

    function _allocate(address canonicalMarket_) private {
        if (msg.sender != issuanceAuthority) revert UnauthorizedIssuanceAuthority(msg.sender);
        if (allocated) revert AllocationAlreadyCompleted();
        if (canonicalMarket_ == address(0) || canonicalMarket_.code.length == 0) {
            revert InvalidAllocationTarget();
        }

        allocated = true;
        canonicalMarket = canonicalMarket_;

        _transfer(address(this), canonicalMarket_, totalSupply);
        emit AllocationCompleted(canonicalMarket_, totalSupply);
    }

    function validateGraphConfiguration(
        address canonicalMarket_,
        address usdg_,
        uint160 sqrtPriceX96,
        address expectedIssuanceAuthority_,
        uint8 expectedDecimals_
    ) external view returns (bool) {
        return _allocationMatches(
            canonicalMarket_, usdg_, expectedIssuanceAuthority_, expectedDecimals_
        ) && sqrtPriceX96 == launchSqrtPriceX96;
    }

    function validateIssuedAllocation(
        address canonicalMarket_,
        address usdg_,
        address expectedIssuanceAuthority_,
        uint8 expectedDecimals_
    ) external view returns (bool) {
        return _allocationMatches(
            canonicalMarket_, usdg_, expectedIssuanceAuthority_, expectedDecimals_
        );
    }

    function _allocationMatches(
        address canonicalMarket_,
        address usdg_,
        address expectedIssuanceAuthority_,
        uint8 expectedDecimals_
    ) private view returns (bool) {
        return allocated && issuanceAuthority == expectedIssuanceAuthority_
            && expectedDecimals_ == CANONICAL_DECIMALS && decimals == expectedDecimals_
            && totalSupply == WHOLE_HKMN_SUPPLY * _scale(expectedDecimals_) && usdg_ == expectedUsdg
            && canonicalMarket_ == canonicalMarket && balanceOf[canonicalMarket_] == totalSupply
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
}
