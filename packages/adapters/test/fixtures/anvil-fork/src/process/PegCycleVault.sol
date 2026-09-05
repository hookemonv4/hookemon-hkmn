// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleRouteExecutor } from "./IPegCycleRouteExecutor.sol";
import { IPegCycleVault, PayoutDomainTypedData } from "./IPegCycleVault.sol";
import { FundingAuthorizationValidation } from "./FundingAuthorizationValidation.sol";
import { PayoutDistributionSignatures } from "./PayoutDistributionSignatures.sol";
import { PegCycleEscrowFactory } from "./PegCycleEscrowFactory.sol";
import { PegCycleReturnEscrow } from "./PegCycleReturnEscrow.sol";

interface IPegCycleHookBinding {
    function pegCycleVault() external view returns (IPegCycleVault);
}

interface IPegCycleUsdg {
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Immutable hook-bound coordinator for one active peg cycle at a time.
/// @dev Provider-specific route execution remains INTEGRATION_PENDING.
contract PegCycleVault is IPegCycleVault {
    uint32 public constant REQUIREMENTS_REVISION = 57;

    enum Lifecycle {
        EMPTY,
        FUNDED,
        OUTBOUND,
        RETURNED,
        PAYOUT_COMMITTED,
        FAILED,
        DEGRADED
    }

    address public immutable usdg;
    address public immutable authorizer;
    IPegCycleRouteExecutor public immutable routeExecutor;
    bytes32 public immutable bindingManifestDigest;
    address public immutable deploymentAuthority;
    /// @notice Pinned at deployment (decision D7): the automated distribution-signer identity
    /// whose EIP-712 signature over a `PayoutAuthorization`'s `PayoutDistribution` subject
    /// `authorizePayout` requires. Never the authorizer, never equal to `distributionVerifier`.
    address private immutable distributionSigner;
    /// @notice Pinned at deployment (decision D7): the second, independently-held automated
    /// verifier identity `authorizePayout` requires a distinct matching EIP-712 signature from.
    /// Designed to run on a different host and hold a different key from both the authorizer and
    /// `distributionSigner`.
    address private immutable distributionVerifier;
    /// @dev EIP-712 domain separator over this exact deployed vault (name, version, the chain ID
    /// observed at construction, and `address(this)`). Immutable: this vault is never redeployed
    /// across chains or proxied, so the domain never needs to change after construction.
    bytes32 private immutable domainSeparator;
    address public hook;
    Lifecycle public lifecycle;

    FundingAuthorization private pendingAuthorization;
    FundingAuthorization private activeAuthorization;
    FundingAuthorization private fundingAuthorization;
    PayoutAuthorization private payoutAuthorization;
    uint256 private expectedFundingBalanceBefore;
    bytes32 private pendingFailedPredecessor;
    bool private fundingInProgress;
    bool private outboundEntered;
    bool private payoutEntered;
    mapping(uint256 nonce => bool consumed) private consumedNonces;
    mapping(bytes32 cycleId => bool consumed) private consumedCycles;
    mapping(bytes32 payoutId => bool consumed) private consumedPayoutIds;
    mapping(bytes32 returnReceiptDigest => bool consumed) private consumedReturnReceiptDigests;
    mapping(bytes32 cycleId => bytes32 digest) private committedPayoutAuthorizationDigests;
    mapping(bytes32 cycleId => bytes32 payoutId) private committedPayoutIds;
    mapping(bytes32 cycleId => bytes32 digest) private committedReturnReceiptDigests;
    mapping(bytes32 cycleId => address escrow) public cycleEscrows;
    mapping(bytes32 cycleId => Lifecycle cycleLifecycle) private cycleLifecycleRecords;
    mapping(bytes32 cycleId => bytes32 failureReceiptDigest) public failureReceiptDigests;
    mapping(bytes32 failureReceiptDigest => bytes32 cycleId) private failureReceiptOwners;
    mapping(bytes32 failedCycleId => bytes32 successorCycleId) public failedCycleSuccessors;
    mapping(bytes32 successorCycleId => bytes32 failedCycleId) public recoveryPredecessors;
    bytes32 public payoutAuthorizationDigest;
    bytes32 public terminalFailureReceiptDigest;
    bytes32 public terminalCycleId;

    error InvalidImmutableIdentity();
    error UnauthorizedCaller();
    error HookAlreadyBound();
    error InvalidHookBinding();
    error InvalidAuthorization();
    error AuthorizationUnavailable();
    error InvalidLifecycle();
    error TokenBalanceDeltaMismatch();
    error RetainedAllowance();
    error Reentrancy();
    error DegradedConfirmationRequired();
    // `authorizePayout`'s own field-level, consumption, balance, and dual-signature validation
    // (`InvalidAuthorization`, `PayoutIdAlreadyConsumed`, `MissingSignature`,
    // `DuplicateSignature`, `MalleableSignature`, `InvalidSignature`, `InvalidDistributionSigner`,
    // `InvalidDistributionVerifier`) all live on `PayoutDistributionSignatures`, the external
    // library `authorizePayout` delegates that whole check to (see its docstring). A custom
    // error's selector depends only on its name and parameter types, not on which contract
    // declares it, so callers decode the exact same selectors regardless of which contract's ABI
    // they read them from; `InvalidAuthorization` is declared here too since this contract's own
    // other functions (funding, renewal) still revert it directly.
    /// @notice `distributionSigner` or `distributionVerifier` collides with the authorizer (at
    /// construction) or with a cycle's `operationsTrigger` (at funding authorization): the two
    /// pinned distribution-approval identities must never coincide with a lower-trust automation
    /// key, or the key-separation decision D7 exists to enforce is defeated in substance.
    error DistributionSignerConflict();

    event HookBound(address indexed hook);
    event CycleEscrowCreated(bytes32 indexed cycleId, address indexed escrow);
    event FundingAuthorized(bytes32 indexed cycleId, uint256 indexed nonce, uint256 amount);
    event FailedCycleSuccessorAuthorized(
        bytes32 indexed failedCycleId,
        bytes32 indexed successorCycleId,
        bytes32 indexed failureReceiptDigest
    );
    event CycleDegraded(bytes32 indexed cycleId, bytes32 indexed receiptDigest);
    event FundingAuthorizationCancelled(bytes32 indexed cycleId, uint256 indexed nonce);
    event FundingAuthorizationDeadlineRenewed(
        bytes32 indexed cycleId, uint256 indexed nonce, uint64 expiresAt
    );
    event PegCycleVaultFunded(
        bytes32 indexed cycleId, address indexed operationsTrigger, uint256 amount
    );
    event PegCycleOutboundExecuted(bytes32 indexed cycleId, bytes32 indexed actionDigest);
    event PayoutAuthorized(
        bytes32 indexed cycleId, bytes32 indexed payoutId, uint256 indexed nonce, uint256 rootSum
    );
    event PayoutAuthorizationDeadlineRenewed(
        bytes32 indexed cycleId, bytes32 indexed payoutId, uint256 indexed nonce, uint64 expiresAt
    );
    event PayoutAuthorizationConsumed(
        bytes32 indexed cycleId, bytes32 indexed payoutId, uint256 rootSum
    );
    event TerminalFailureRecorded(bytes32 indexed cycleId, bytes32 indexed failureReceiptDigest);

    constructor(
        address usdg_,
        address authorizer_,
        address routeExecutor_,
        bytes32 bindingManifestDigest_,
        address deploymentAuthority_,
        address distributionSigner_,
        address distributionVerifier_
    ) {
        if (
            usdg_ == address(0) || usdg_.code.length == 0 || authorizer_ == address(0)
                || routeExecutor_ == address(0) || routeExecutor_.code.length == 0
                || bindingManifestDigest_ == bytes32(0) || deploymentAuthority_ == address(0)
                || authorizer_ == address(this) || routeExecutor_ == address(this)
                || distributionSigner_ == address(0) || distributionVerifier_ == address(0)
                || distributionSigner_ == address(this) || distributionVerifier_ == address(this)
        ) revert InvalidImmutableIdentity();
        if (
            distributionSigner_ == distributionVerifier_ || distributionSigner_ == authorizer_
                || distributionVerifier_ == authorizer_
        ) revert DistributionSignerConflict();
        usdg = usdg_;
        authorizer = authorizer_;
        routeExecutor = IPegCycleRouteExecutor(routeExecutor_);
        bindingManifestDigest = bindingManifestDigest_;
        deploymentAuthority = deploymentAuthority_;
        distributionSigner = distributionSigner_;
        distributionVerifier = distributionVerifier_;
        domainSeparator = keccak256(
            abi.encode(
                PayoutDomainTypedData.EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(PayoutDomainTypedData.EIP712_DOMAIN_NAME)),
                keccak256(bytes(PayoutDomainTypedData.EIP712_DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function bindHook(address hook_) external {
        if (msg.sender != deploymentAuthority) revert UnauthorizedCaller();
        if (hook != address(0)) revert HookAlreadyBound();
        if (
            hook_ == address(0) || hook_.code.length == 0 || hook_ == authorizer || hook_ == usdg
                || hook_ == address(routeExecutor) || hook_ == address(this)
        ) revert InvalidHookBinding();
        try IPegCycleHookBinding(hook_).pegCycleVault() returns (IPegCycleVault namedVault) {
            if (address(namedVault) != address(this)) revert InvalidHookBinding();
        } catch {
            revert InvalidHookBinding();
        }
        hook = hook_;
        emit HookBound(hook_);
    }

    function computeCycleEscrow(bytes32 cycleId) public view returns (address) {
        // `PegCycleReturnEscrow`'s creation bytecode this address computation embeds lives in
        // `PegCycleEscrowFactory`'s own deployed bytecode, not here (see its docstring) -- purely
        // to keep that ~2.8 KB literal blob out of this contract's own EIP-170 runtime budget.
        return PegCycleEscrowFactory.computeAddress(usdg, hook, address(routeExecutor), cycleId);
    }

    function authorizeFunding(FundingAuthorization calldata authorization) external {
        if (msg.sender != authorizer) revert UnauthorizedCaller();
        _validateFundingAuthorization(authorization);
        if (lifecycle != Lifecycle.EMPTY && lifecycle != Lifecycle.PAYOUT_COMMITTED) {
            revert InvalidLifecycle();
        }
        _storeFundingAuthorization(authorization, bytes32(0));
    }

    /// @notice Binds a fresh successor cycle to the exact predecessor identifier and stored
    /// terminal receipt. Runs identically whether the predecessor closed as FAILED (a
    /// provider/route failure) or DEGRADED (a quarantined short/ambiguous return recorded by
    /// `recordDegradedReturn`) — both are terminal, evidence-quarantined states that only
    /// this function may open a successor from, and neither's escrow is ever touched here.
    function authorizeFundingAfterFailure(
        FundingAuthorization calldata authorization,
        bytes32 failedCycleId,
        bytes32 failureReceiptDigest
    ) external {
        if (msg.sender != authorizer) revert UnauthorizedCaller();
        _validateFundingAuthorization(authorization);
        // FAILED and DEGRADED are exactly the top two Lifecycle ordinals.
        if (uint8(lifecycle) < uint8(Lifecycle.FAILED)) revert InvalidLifecycle();
        if (
            failedCycleId == bytes32(0) || failedCycleId != terminalCycleId
                || failureReceiptDigest == bytes32(0)
                || failureReceiptDigests[failedCycleId] != failureReceiptDigest
                || failureReceiptOwners[failureReceiptDigest] != failedCycleId
                || failedCycleSuccessors[failedCycleId] != bytes32(0)
        ) revert InvalidAuthorization();
        _storeFundingAuthorization(authorization, failedCycleId);
        emit FailedCycleSuccessorAuthorized(
            failedCycleId, authorization.cycleId, failureReceiptDigest
        );
    }

    function cancelExpiredFundingAuthorization(bytes32 cycleId) external {
        FundingAuthorization memory authorization = pendingAuthorization;
        if (
            authorization.cycleId == bytes32(0) || authorization.cycleId != cycleId
                || block.timestamp < authorization.expiresAt || fundingInProgress
        ) revert AuthorizationUnavailable();
        bytes32 failedPredecessor = pendingFailedPredecessor;
        if (failedPredecessor != bytes32(0)) {
            delete failedCycleSuccessors[failedPredecessor];
            delete recoveryPredecessors[cycleId];
            delete pendingFailedPredecessor;
        }
        delete pendingAuthorization;
        emit FundingAuthorizationCancelled(cycleId, authorization.nonce);
    }

    function renewFundingAuthorizationDeadline(FundingAuthorization calldata renewal) external {
        if (msg.sender != authorizer) revert UnauthorizedCaller();
        if (lifecycle != Lifecycle.FUNDED) revert InvalidLifecycle();
        FundingAuthorization memory active = activeAuthorization;
        if (
            renewal.expiresAt <= block.timestamp || renewal.nonce == 0
                || consumedNonces[renewal.nonce]
                || _fundingSubjectDigest(renewal) != _fundingSubjectDigest(active)
        ) revert InvalidAuthorization();
        consumedNonces[renewal.nonce] = true;
        activeAuthorization.expiresAt = renewal.expiresAt;
        activeAuthorization.nonce = renewal.nonce;
        emit FundingAuthorizationDeadlineRenewed(renewal.cycleId, renewal.nonce, renewal.expiresAt);
    }

    function consumeFundingAuthorization(bytes32 cycleId, address operationsTrigger)
        external
        returns (FundingAuthorization memory authorization, uint256 balanceBefore)
    {
        if (msg.sender != hook) revert UnauthorizedCaller();
        // A pending authorization may be consumed only from EMPTY or from a closed slot:
        // PAYOUT_COMMITTED, FAILED, or DEGRADED — exactly the top three Lifecycle ordinals.
        if (lifecycle != Lifecycle.EMPTY && uint8(lifecycle) < uint8(Lifecycle.PAYOUT_COMMITTED)) {
            revert InvalidLifecycle();
        }
        authorization = pendingAuthorization;
        if (
            authorization.cycleId == bytes32(0) || authorization.cycleId != cycleId
                || authorization.operationsTrigger != operationsTrigger
                || authorization.expiresAt <= block.timestamp
        ) revert AuthorizationUnavailable();

        address escrow = cycleEscrows[cycleId];
        balanceBefore = IPegCycleUsdg(usdg).balanceOf(escrow);
        if (escrow == address(0) || balanceBefore != 0) revert TokenBalanceDeltaMismatch();
        delete pendingAuthorization;
        fundingAuthorization = authorization;
        expectedFundingBalanceBefore = balanceBefore;
        fundingInProgress = true;
    }

    function confirmFunding(bytes32 cycleId, uint256 balanceBefore) external {
        if (msg.sender != hook) revert UnauthorizedCaller();
        FundingAuthorization memory authorization = fundingAuthorization;
        if (
            !fundingInProgress || authorization.cycleId != cycleId
                || balanceBefore != expectedFundingBalanceBefore || balanceBefore != 0
        ) revert AuthorizationUnavailable();
        uint256 balanceAfter = IPegCycleUsdg(usdg).balanceOf(cycleEscrows[cycleId]);
        if (balanceAfter != authorization.amount) revert TokenBalanceDeltaMismatch();

        activeAuthorization = authorization;
        delete fundingAuthorization;
        delete expectedFundingBalanceBefore;
        delete pendingFailedPredecessor;
        fundingInProgress = false;
        lifecycle = Lifecycle.FUNDED;
        cycleLifecycleRecords[cycleId] = Lifecycle.FUNDED;
        emit PegCycleVaultFunded(cycleId, authorization.operationsTrigger, authorization.amount);
    }

    function executeOutbound(bytes32 cycleId, bytes calldata routeData) external {
        if (outboundEntered) revert Reentrancy();
        if (lifecycle != Lifecycle.FUNDED) revert InvalidLifecycle();
        if (msg.sender != activeAuthorization.operationsTrigger) revert UnauthorizedCaller();
        uint256 amount = activeAuthorization.amount;
        if (
            cycleId != activeAuthorization.cycleId
                || keccak256(routeData) != activeAuthorization.outboundActionDigest
                || activeAuthorization.expiresAt <= block.timestamp
        ) revert InvalidAuthorization();

        address escrowAddress = cycleEscrows[cycleId];
        outboundEntered = true;
        uint256 escrowBalanceBefore = IPegCycleUsdg(usdg).balanceOf(escrowAddress);
        if (escrowBalanceBefore < amount) revert TokenBalanceDeltaMismatch();
        PegCycleReturnEscrow(escrowAddress).sendOutbound(amount);
        routeExecutor.executeOutbound(cycleId, usdg, amount, escrowAddress, routeData);
        if (IPegCycleUsdg(usdg).balanceOf(escrowAddress) != escrowBalanceBefore - amount) {
            revert TokenBalanceDeltaMismatch();
        }
        if (IPegCycleUsdg(usdg).allowance(escrowAddress, address(routeExecutor)) != 0) {
            revert RetainedAllowance();
        }
        lifecycle = Lifecycle.OUTBOUND;
        cycleLifecycleRecords[cycleId] = Lifecycle.OUTBOUND;
        outboundEntered = false;
        emit PegCycleOutboundExecuted(cycleId, activeAuthorization.outboundActionDigest);
    }

    /// @notice Records exact returned-proceeds evidence, gated on two independent EIP-712
    /// signatures (decision D7) over `authorization`'s `PayoutDistribution` subject: one from the
    /// pinned `distributionSigner`, one from the pinned `distributionVerifier`. The authorizer
    /// still submits this transaction (and every other field-level check below is unchanged), but
    /// can never forge the manifest binding alone -- both signatures are required, from two
    /// distinct, immutable, non-worker-configurable addresses.
    function authorizePayout(
        PayoutAuthorization calldata authorization,
        bytes calldata distributionSignature,
        bytes calldata verifierSignature
    ) external {
        if (msg.sender != authorizer) {
            revert UnauthorizedCaller();
        }
        if (lifecycle != Lifecycle.OUTBOUND) revert InvalidLifecycle();
        bytes32 activeCycleId = activeAuthorization.cycleId;
        address escrowAddress = cycleEscrows[activeCycleId];
        // Every field-level, consumption, and balance check, plus the two-signature check, live
        // in one external-library call (see `PayoutDistributionSignatures`'s docstring): it takes
        // exactly the vault state the check needs as plain arguments and reverts with its own
        // named errors, keeping this logic out of `PegCycleVault`'s own EIP-170 runtime budget.
        PayoutDistributionSignatures.verify(
            domainSeparator,
            authorization,
            PayoutDistributionSignatures.ActiveCycleContext({
                activeCycleId: activeCycleId,
                hook: hook,
                usdg: usdg,
                operationsTrigger: activeAuthorization.operationsTrigger,
                bindingManifestDigest: activeAuthorization.bindingManifestDigest,
                minimumReturnUsdg: activeAuthorization.minimumReturnUsdg,
                returnActionDigest: activeAuthorization.returnActionDigest,
                nonceConsumed: consumedNonces[authorization.nonce],
                payoutIdConsumed: consumedPayoutIds[authorization.payoutId],
                returnReceiptConsumed: consumedReturnReceiptDigests[authorization.returnReceiptDigest],
                escrowBalance: IPegCycleUsdg(usdg).balanceOf(escrowAddress)
            }),
            distributionSignature,
            verifierSignature,
            distributionSigner,
            distributionVerifier
        );

        payoutAuthorization = authorization;
        payoutAuthorizationDigest = keccak256(abi.encode(authorization));
        consumedNonces[authorization.nonce] = true;
        consumedPayoutIds[authorization.payoutId] = true;
        consumedReturnReceiptDigests[authorization.returnReceiptDigest] = true;
        lifecycle = Lifecycle.RETURNED;
        cycleLifecycleRecords[authorization.cycleId] = Lifecycle.RETURNED;
        emit PayoutAuthorized(
            authorization.cycleId,
            authorization.payoutId,
            authorization.nonce,
            authorization.rootSum
        );
    }

    function renewPayoutAuthorizationDeadline(PayoutAuthorization calldata renewal) external {
        if (msg.sender != authorizer) revert UnauthorizedCaller();
        if (lifecycle != Lifecycle.RETURNED) revert InvalidLifecycle();
        PayoutAuthorization memory active = payoutAuthorization;
        if (
            renewal.expiresAt <= block.timestamp || renewal.nonce == 0
                || consumedNonces[renewal.nonce]
                || _payoutSubjectDigest(renewal) != _payoutSubjectDigest(active)
        ) revert InvalidAuthorization();
        consumedNonces[renewal.nonce] = true;
        payoutAuthorization.expiresAt = renewal.expiresAt;
        payoutAuthorization.nonce = renewal.nonce;
        payoutAuthorizationDigest = keccak256(abi.encode(payoutAuthorization));
        emit PayoutAuthorizationDeadlineRenewed(
            renewal.cycleId, renewal.payoutId, renewal.nonce, renewal.expiresAt
        );
    }

    function consumePayoutAuthorization(PayoutAuthorization calldata authorization)
        external
        returns (address operationsTrigger)
    {
        if (payoutEntered) revert Reentrancy();
        if (msg.sender != hook) revert UnauthorizedCaller();
        if (lifecycle != Lifecycle.RETURNED) revert InvalidLifecycle();
        bytes32 authorizationDigest = keccak256(abi.encode(authorization));
        if (
            payoutAuthorizationDigest == bytes32(0)
                || authorizationDigest != payoutAuthorizationDigest
                || authorization.expiresAt <= block.timestamp
        ) revert AuthorizationUnavailable();

        address escrowAddress = cycleEscrows[authorization.cycleId];
        payoutEntered = true;
        uint256 escrowBalanceBefore = IPegCycleUsdg(usdg).balanceOf(escrowAddress);
        if (escrowBalanceBefore < authorization.rootSum) {
            revert TokenBalanceDeltaMismatch();
        }
        PegCycleReturnEscrow(escrowAddress).sendPayout(authorization.rootSum);
        if (
            IPegCycleUsdg(usdg).balanceOf(escrowAddress)
                != escrowBalanceBefore - authorization.rootSum
        ) {
            revert TokenBalanceDeltaMismatch();
        }
        operationsTrigger = payoutAuthorization.operationsTrigger;
        committedPayoutAuthorizationDigests[authorization.cycleId] = authorizationDigest;
        committedPayoutIds[authorization.cycleId] = authorization.payoutId;
        committedReturnReceiptDigests[authorization.cycleId] = authorization.returnReceiptDigest;
        delete payoutAuthorization;
        delete payoutAuthorizationDigest;
        lifecycle = Lifecycle.PAYOUT_COMMITTED;
        cycleLifecycleRecords[authorization.cycleId] = Lifecycle.PAYOUT_COMMITTED;
        terminalCycleId = authorization.cycleId;
        terminalFailureReceiptDigest = bytes32(0);
        payoutEntered = false;
        emit PayoutAuthorizationConsumed(
            authorization.cycleId, authorization.payoutId, authorization.rootSum
        );
    }

    function recordTerminalFailure(bytes32 cycleId, bytes32 failureReceiptDigest) external {
        if (msg.sender != authorizer) revert UnauthorizedCaller();
        _recordTerminalReceipt(cycleId, failureReceiptDigest, Lifecycle.FAILED);
        terminalFailureReceiptDigest = failureReceiptDigest;
        emit TerminalFailureRecorded(cycleId, failureReceiptDigest);
    }

    /// @notice Quarantines a nonzero return that is neither a clean payout (>= rootSum) nor
    /// zero (a clean failure), moving the cycle to the terminal DEGRADED state.
    /// @dev `acceptDegraded` is the authorizer's on-chain attestation that an off-chain,
    /// separately-logged human confirmation already happened before this call was submitted.
    /// The authorizer's own signing policy MUST NOT set `acceptDegraded=true` from an
    /// unattended/automatic path; accepting a short or ambiguous return is an economic
    /// judgment call (real loss vs bridge bug vs fraud), not a mechanical fact. This function
    /// never moves the escrow's balance; the quarantined balance stays in the cycle's
    /// CREATE2-isolated escrow exactly as a FAILED cycle's balance does, and no other function
    /// in this contract ever sweeps a DEGRADED cycle's escrow.
    function recordDegradedReturn(bytes32 cycleId, bytes32 receiptDigest, bool acceptDegraded)
        external
    {
        if (msg.sender != authorizer) revert UnauthorizedCaller();
        if (IPegCycleUsdg(usdg).balanceOf(cycleEscrows[cycleId]) == 0) {
            revert InvalidAuthorization();
        }
        if (!acceptDegraded) revert DegradedConfirmationRequired();
        _recordTerminalReceipt(cycleId, receiptDigest, Lifecycle.DEGRADED);
        emit CycleDegraded(cycleId, receiptDigest);
    }

    function readPendingAuthorization() external view returns (FundingAuthorization memory) {
        return pendingAuthorization;
    }

    function readActiveAuthorization() external view returns (FundingAuthorization memory) {
        // FUNDED, OUTBOUND, and RETURNED are exactly the three Lifecycle ordinals between
        // EMPTY and PAYOUT_COMMITTED.
        if (lifecycle == Lifecycle.EMPTY || uint8(lifecycle) >= uint8(Lifecycle.PAYOUT_COMMITTED)) {
            FundingAuthorization memory empty;
            return empty;
        }
        return activeAuthorization;
    }

    function cycleLifecycles(bytes32 cycleId) external view returns (uint8) {
        return uint8(cycleLifecycleRecords[cycleId]);
    }

    function isNonceConsumed(uint256 nonce) external view returns (bool) {
        return consumedNonces[nonce];
    }

    function isCycleConsumed(bytes32 cycleId) external view returns (bool) {
        return consumedCycles[cycleId];
    }

    function readCommittedPayoutBinding(bytes32 cycleId)
        external
        view
        returns (bytes32 authorizationDigest, bytes32 payoutId, bytes32 returnReceiptDigest)
    {
        return (
            committedPayoutAuthorizationDigests[cycleId],
            committedPayoutIds[cycleId],
            committedReturnReceiptDigests[cycleId]
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

    function _validateFundingAuthorization(FundingAuthorization calldata authorization)
        private
        view
    {
        if (hook == address(0)) revert InvalidHookBinding();
        address expectedEscrow = computeCycleEscrow(authorization.cycleId);
        // Every field-level, identity, consumption, and balance check lives in one
        // external-library call (see `FundingAuthorizationValidation`'s docstring): it takes
        // exactly the vault state the check needs as plain arguments and reverts with its own
        // named error, keeping this logic out of `PegCycleVault`'s own EIP-170 runtime budget.
        FundingAuthorizationValidation.verify(
            authorization,
            FundingAuthorizationValidation.VaultIdentity({
                hook: hook,
                usdg: usdg,
                authorizer: authorizer,
                routeExecutor: address(routeExecutor),
                distributionSigner: distributionSigner,
                distributionVerifier: distributionVerifier,
                bindingManifestDigest: bindingManifestDigest,
                expectedEscrow: expectedEscrow,
                nonceConsumed: consumedNonces[authorization.nonce],
                cycleConsumed: consumedCycles[authorization.cycleId],
                expectedEscrowBalance: IPegCycleUsdg(usdg).balanceOf(expectedEscrow)
            })
        );
        if (pendingAuthorization.cycleId != bytes32(0) || fundingInProgress) {
            revert AuthorizationUnavailable();
        }
    }

    /// @dev Shared terminal-quarantine write for both FAILED (recordTerminalFailure) and
    /// DEGRADED (recordDegradedReturn): binds one nonzero, unreused receipt digest to the
    /// exact active OUTBOUND cycle and closes that cycle's slot under `newLifecycle`. Never
    /// touches the cycle's escrow balance.
    function _recordTerminalReceipt(bytes32 cycleId, bytes32 receiptDigest, Lifecycle newLifecycle)
        private
    {
        if (
            lifecycle != Lifecycle.OUTBOUND || cycleId != activeAuthorization.cycleId
                || receiptDigest == bytes32(0) || failureReceiptOwners[receiptDigest] != bytes32(0)
        ) revert InvalidAuthorization();
        terminalCycleId = cycleId;
        failureReceiptDigests[cycleId] = receiptDigest;
        failureReceiptOwners[receiptDigest] = cycleId;
        lifecycle = newLifecycle;
        cycleLifecycleRecords[cycleId] = newLifecycle;
    }

    function _storeFundingAuthorization(
        FundingAuthorization calldata authorization,
        bytes32 failedPredecessor
    ) private {
        address expectedEscrow = authorization.returnDestination;
        // Deployment, `CREATE2`-address derivation, and the freshly deployed escrow's own
        // factory-identity check all live in `PegCycleEscrowFactory` (see its docstring); this
        // call runs via `DELEGATECALL`, so the escrow deploys exactly as if this contract had
        // called `new` itself. `deploy` already reverts (with the same `InvalidAuthorization`
        // selector this contract declares) unless the escrow's own reported identity matches.
        address escrow =
            PegCycleEscrowFactory.deploy(usdg, hook, address(routeExecutor), authorization.cycleId);
        if (escrow != expectedEscrow) revert InvalidAuthorization();

        cycleEscrows[authorization.cycleId] = expectedEscrow;
        pendingAuthorization = authorization;
        consumedNonces[authorization.nonce] = true;
        consumedCycles[authorization.cycleId] = true;
        if (failedPredecessor != bytes32(0)) {
            pendingFailedPredecessor = failedPredecessor;
            failedCycleSuccessors[failedPredecessor] = authorization.cycleId;
            recoveryPredecessors[authorization.cycleId] = failedPredecessor;
        }
        emit CycleEscrowCreated(authorization.cycleId, expectedEscrow);
        emit FundingAuthorized(authorization.cycleId, authorization.nonce, authorization.amount);
    }

    function _fundingSubjectDigest(FundingAuthorization memory value)
        private
        pure
        returns (bytes32)
    {
        value.expiresAt = 0;
        value.nonce = 0;
        return keccak256(abi.encode(value));
    }

    function _payoutSubjectDigest(PayoutAuthorization memory value) private pure returns (bytes32) {
        value.expiresAt = 0;
        value.nonce = 0;
        return keccak256(abi.encode(value));
    }
}
