// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The EIP-712 typed-data schema `PegCycleVault.authorizePayout` checks two pinned,
/// immutable signer identities against (decision D7): a distribution-signer and an independent
/// verifier. Both are declared here, not only in the concrete `PegCycleVault` contract, so
/// off-chain tooling (the distribution-signer and verifier processes, WP-39) can import one
/// canonical source for the exact domain and struct a signature must be produced over, instead of
/// re-deriving it from the contract's bytecode or duplicating it by hand.
///
/// The signed subject is deliberately a strict field subset of the full on-chain
/// `PayoutAuthorization` -- exactly the fields that identify *which distribution this manifest
/// is* (revision, chain, cycle and deployment identities, the binding-manifest digest, and the
/// payout/manifest/root/sum evidence the distribution-signer and verifier independently
/// reconstruct from finalized chain data). It excludes `returnActionDigest`, `returnReceiptDigest`,
/// `expiresAt`, and `nonce`: the first two describe the unrelated *return leg* of the cycle (an
/// on-chain execution fact the vault authorizer already observes directly, never something the
/// distribution process computes), and the last two are deliberately mutable via
/// `renewPayoutAuthorizationDeadline` without invalidating an already-obtained pair of signatures --
/// exactly mirroring how `_payoutSubjectDigest` already excludes them from the renewal-frozen
/// subject.
/// @notice The EIP-712 constants a `PegCycleVault` domain separator and a `PayoutDistribution`
/// struct hash are built from (see the file-level docstring above). A library, not interface
/// members, because Solidity interfaces cannot declare state variables or constants; this stays
/// the one canonical source both `PegCycleVault` and off-chain tooling (WP-39) import.
library PayoutDomainTypedData {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    string internal constant EIP712_DOMAIN_NAME = "HookemonPayoutVault";
    string internal constant EIP712_DOMAIN_VERSION = "1";

    /// @dev keccak256(
    ///   "PayoutDistribution(uint32 requirementsRevision,uint256 chainId,bytes32 cycleId,"
    ///   "address hook,address vault,address usdg,address operationsTrigger,"
    ///   "bytes32 bindingManifestDigest,bytes32 payoutId,bytes32 manifestDigest,"
    ///   "bytes32 rootHash,uint256 rootSum)"
    /// )
    bytes32 internal constant PAYOUT_DISTRIBUTION_TYPEHASH = keccak256(
        "PayoutDistribution(uint32 requirementsRevision,uint256 chainId,bytes32 cycleId,address hook,address vault,address usdg,address operationsTrigger,bytes32 bindingManifestDigest,bytes32 payoutId,bytes32 manifestDigest,bytes32 rootHash,uint256 rootSum)"
    );
}

interface IPegCycleVault {
    struct FundingAuthorization {
        uint32 requirementsRevision;
        uint256 chainId;
        bytes32 cycleId;
        address hook;
        address vault;
        address usdg;
        address operationsTrigger;
        uint256 amount;
        bytes32 bindingManifestDigest;
        bytes32 outboundActionDigest;
        bytes32 returnActionDigest;
        address returnDestination;
        uint256 minimumRobinhoodReceive;
        uint256 minimumSolanaReceive;
        uint256 minimumReturnUsdg;
        uint256 robinhoodNativeGasCap;
        uint256 solanaNativeGasCap;
        uint64 expiresAt;
        uint256 nonce;
    }

    struct PayoutAuthorization {
        uint32 requirementsRevision;
        uint256 chainId;
        bytes32 cycleId;
        address hook;
        address vault;
        address usdg;
        address operationsTrigger;
        bytes32 bindingManifestDigest;
        bytes32 payoutId;
        bytes32 manifestDigest;
        bytes32 rootHash;
        uint256 rootSum;
        bytes32 returnActionDigest;
        bytes32 returnReceiptDigest;
        uint64 expiresAt;
        uint256 nonce;
    }

    function authorizeFunding(FundingAuthorization calldata authorization) external;

    function authorizeFundingAfterFailure(
        FundingAuthorization calldata authorization,
        bytes32 failedCycleId,
        bytes32 failureReceiptDigest
    ) external;

    function cancelExpiredFundingAuthorization(bytes32 cycleId) external;

    function renewFundingAuthorizationDeadline(FundingAuthorization calldata renewal) external;

    function consumeFundingAuthorization(bytes32 cycleId, address operationsTrigger)
        external
        returns (FundingAuthorization memory authorization, uint256 balanceBefore);

    function confirmFunding(bytes32 cycleId, uint256 balanceBefore) external;

    /// @notice Records exact returned-proceeds evidence, gated on two independent EIP-712
    /// signatures (decision D7) over this authorization's `PayoutDistribution` subject (see the
    /// module docstring above): one from the immutable `distributionSigner`, one from the
    /// immutable `distributionVerifier`. The vault authorizer alone can never satisfy both.
    function authorizePayout(
        PayoutAuthorization calldata authorization,
        bytes calldata distributionSignature,
        bytes calldata verifierSignature
    ) external;

    function renewPayoutAuthorizationDeadline(PayoutAuthorization calldata renewal) external;

    function consumePayoutAuthorization(PayoutAuthorization calldata authorization)
        external
        returns (address operationsTrigger);

    function recordTerminalFailure(bytes32 cycleId, bytes32 failureReceiptDigest) external;

    function recordDegradedReturn(bytes32 cycleId, bytes32 receiptDigest, bool acceptDegraded)
        external;

    function computeCycleEscrow(bytes32 cycleId) external view returns (address);

    function cycleEscrows(bytes32 cycleId) external view returns (address);

    function cycleLifecycles(bytes32 cycleId) external view returns (uint8);

    function failureReceiptDigests(bytes32 cycleId) external view returns (bytes32);

    function failedCycleSuccessors(bytes32 failedCycleId) external view returns (bytes32);

    function recoveryPredecessors(bytes32 successorCycleId) external view returns (bytes32);

    function readPendingAuthorization() external view returns (FundingAuthorization memory);

    function readActiveAuthorization() external view returns (FundingAuthorization memory);

    function isNonceConsumed(uint256 nonce) external view returns (bool);

    function isCycleConsumed(bytes32 cycleId) external view returns (bool);

    function readCommittedPayoutBinding(bytes32 cycleId)
        external
        view
        returns (bytes32 authorizationDigest, bytes32 payoutId, bytes32 returnReceiptDigest);

    function isPayoutIdConsumed(bytes32 payoutId) external view returns (bool);

    function isReturnReceiptDigestConsumed(bytes32 returnReceiptDigest) external view returns (bool);
}
