// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";

/// @dev Constructor-compatible vault identity for legacy compile-only harnesses.
contract CompileOnlyPegCycleVault is IPegCycleVault {
    address public constant routeExecutor = address(0xBEE1);
    address public constant usdg = address(0xBEE2);
    address public immutable authorizer;

    constructor(address authorizer_) {
        authorizer = authorizer_;
    }

    function authorizeFunding(FundingAuthorization calldata) external pure {
        revert();
    }

    function authorizeFundingAfterFailure(FundingAuthorization calldata, bytes32, bytes32)
        external
        pure
    {
        revert();
    }

    function cancelExpiredFundingAuthorization(bytes32) external pure {
        revert();
    }

    function renewFundingAuthorizationDeadline(FundingAuthorization calldata) external pure {
        revert();
    }

    function renewPayoutAuthorizationDeadline(PayoutAuthorization calldata) external pure {
        revert();
    }

    function computeCycleEscrow(bytes32) external pure returns (address) {
        return address(0);
    }

    function cycleEscrows(bytes32) external pure returns (address) {
        return address(0);
    }

    function cycleLifecycles(bytes32) external pure returns (uint8) {
        return 0;
    }

    function failureReceiptDigests(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function failedCycleSuccessors(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function recoveryPredecessors(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function readPendingAuthorization() external pure returns (FundingAuthorization memory) {
        FundingAuthorization memory empty;
        return empty;
    }

    function readActiveAuthorization() external pure returns (FundingAuthorization memory) {
        FundingAuthorization memory empty;
        return empty;
    }

    function isNonceConsumed(uint256) external pure returns (bool) {
        return false;
    }

    function isCycleConsumed(bytes32) external pure returns (bool) {
        return false;
    }

    function consumeFundingAuthorization(bytes32, address)
        external
        pure
        returns (FundingAuthorization memory, uint256)
    {
        revert();
    }

    function confirmFunding(bytes32, uint256) external pure {
        revert();
    }

    function authorizePayout(PayoutAuthorization calldata, bytes calldata, bytes calldata)
        external
        pure
    {
        revert();
    }

    function consumePayoutAuthorization(PayoutAuthorization calldata)
        external
        pure
        returns (address)
    {
        revert();
    }

    function recordTerminalFailure(bytes32, bytes32) external pure {
        revert();
    }

    function recordDegradedReturn(bytes32, bytes32, bool) external pure {
        revert();
    }

    function readCommittedPayoutBinding(bytes32) external pure returns (bytes32, bytes32, bytes32) {
        return (bytes32(0), bytes32(0), bytes32(0));
    }

    function isPayoutIdConsumed(bytes32) external pure returns (bool) {
        return false;
    }

    function isReturnReceiptDigestConsumed(bytes32) external pure returns (bool) {
        return false;
    }
}

interface ExecutablePayoutUsdg {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

/// @dev Small executable exact-return fixture. It does not model the real vault lifecycle.
contract ExecutablePayoutVault is IPegCycleVault {
    address public constant routeExecutor = address(0xBEE1);
    address public immutable usdg;
    address public immutable authorizer;
    address public hook;

    bytes32 private pendingAuthorizationDigest;
    address private pendingOperationsTrigger;
    mapping(bytes32 payoutId => bool consumed) private consumedPayoutIds;
    mapping(bytes32 returnReceiptDigest => bool consumed) private consumedReturnReceiptDigests;
    mapping(bytes32 cycleId => bytes32 digest) private committedAuthorizationDigests;
    mapping(bytes32 cycleId => bytes32 payoutId) private committedPayoutIds;
    mapping(bytes32 cycleId => bytes32 digest) private committedReceiptDigests;

    constructor(address usdg_, address authorizer_) {
        usdg = usdg_;
        authorizer = authorizer_;
    }

    function authorizeFunding(FundingAuthorization calldata) external pure {
        revert();
    }

    function authorizeFundingAfterFailure(FundingAuthorization calldata, bytes32, bytes32)
        external
        pure
    {
        revert();
    }

    function cancelExpiredFundingAuthorization(bytes32) external pure {
        revert();
    }

    function renewFundingAuthorizationDeadline(FundingAuthorization calldata) external pure {
        revert();
    }

    function renewPayoutAuthorizationDeadline(PayoutAuthorization calldata) external pure {
        revert();
    }

    function computeCycleEscrow(bytes32) external pure returns (address) {
        return address(0);
    }

    function cycleEscrows(bytes32) external pure returns (address) {
        return address(0);
    }

    function cycleLifecycles(bytes32) external pure returns (uint8) {
        return 0;
    }

    function failureReceiptDigests(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function failedCycleSuccessors(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function recoveryPredecessors(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function readPendingAuthorization() external pure returns (FundingAuthorization memory) {
        FundingAuthorization memory empty;
        return empty;
    }

    function readActiveAuthorization() external pure returns (FundingAuthorization memory) {
        FundingAuthorization memory empty;
        return empty;
    }

    function isNonceConsumed(uint256) external pure returns (bool) {
        return false;
    }

    function isCycleConsumed(bytes32) external pure returns (bool) {
        return false;
    }

    function bindHook(address hook_) external {
        require(msg.sender == authorizer && hook == address(0) && hook_ != address(0));
        hook = hook_;
    }

    function consumeFundingAuthorization(bytes32, address)
        external
        pure
        returns (FundingAuthorization memory, uint256)
    {
        revert();
    }

    function confirmFunding(bytes32, uint256) external pure {
        revert();
    }

    function authorizePayout(
        PayoutAuthorization calldata authorization,
        bytes calldata,
        bytes calldata
    ) external {
        require(msg.sender == authorizer && hook != address(0));
        require(
            authorization.hook == hook && authorization.vault == address(this)
                && authorization.usdg == usdg && authorization.payoutId != bytes32(0)
                && authorization.returnReceiptDigest != bytes32(0) && authorization.rootSum != 0
                && authorization.expiresAt > block.timestamp
                && pendingAuthorizationDigest == bytes32(0)
                && !consumedPayoutIds[authorization.payoutId]
                && !consumedReturnReceiptDigests[authorization.returnReceiptDigest]
                && ExecutablePayoutUsdg(usdg).balanceOf(address(this)) == authorization.rootSum
        );
        pendingAuthorizationDigest = keccak256(abi.encode(authorization));
        pendingOperationsTrigger = authorization.operationsTrigger;
        consumedPayoutIds[authorization.payoutId] = true;
        consumedReturnReceiptDigests[authorization.returnReceiptDigest] = true;
    }

    function consumePayoutAuthorization(PayoutAuthorization calldata authorization)
        external
        returns (address operationsTrigger)
    {
        require(msg.sender == hook && authorization.expiresAt > block.timestamp);
        bytes32 authorizationDigest = keccak256(abi.encode(authorization));
        require(authorizationDigest == pendingAuthorizationDigest);
        uint256 vaultBalanceBefore = ExecutablePayoutUsdg(usdg).balanceOf(address(this));
        uint256 hookBalanceBefore = ExecutablePayoutUsdg(usdg).balanceOf(hook);
        require(vaultBalanceBefore == authorization.rootSum);
        require(ExecutablePayoutUsdg(usdg).transfer(hook, authorization.rootSum));
        require(ExecutablePayoutUsdg(usdg).balanceOf(address(this)) == 0);
        require(
            ExecutablePayoutUsdg(usdg).balanceOf(hook) - hookBalanceBefore == authorization.rootSum
        );
        committedAuthorizationDigests[authorization.cycleId] = authorizationDigest;
        committedPayoutIds[authorization.cycleId] = authorization.payoutId;
        committedReceiptDigests[authorization.cycleId] = authorization.returnReceiptDigest;
        operationsTrigger = pendingOperationsTrigger;
        delete pendingAuthorizationDigest;
        delete pendingOperationsTrigger;
    }

    function recordTerminalFailure(bytes32, bytes32) external pure {
        revert();
    }

    function recordDegradedReturn(bytes32, bytes32, bool) external pure {
        revert();
    }

    function readCommittedPayoutBinding(bytes32 cycleId)
        external
        view
        returns (bytes32, bytes32, bytes32)
    {
        return (
            committedAuthorizationDigests[cycleId],
            committedPayoutIds[cycleId],
            committedReceiptDigests[cycleId]
        );
    }

    function isPayoutIdConsumed(bytes32 payoutId) external view returns (bool) {
        return consumedPayoutIds[payoutId];
    }

    function isReturnReceiptDigestConsumed(bytes32 returnReceiptDigest)
        external
        view
        returns (bool)
    {
        return consumedReturnReceiptDigests[returnReceiptDigest];
    }
}

contract ExecutablePayoutAuthorizer {
    function authorizePayout(
        IPegCycleVault vault,
        IPegCycleVault.PayoutAuthorization calldata authorization,
        bytes calldata distributionSignature,
        bytes calldata verifierSignature
    ) external {
        vault.authorizePayout(authorization, distributionSignature, verifierSignature);
    }

    function bindHook(ExecutablePayoutVault vault, address hook) external {
        vault.bindHook(hook);
    }
}
