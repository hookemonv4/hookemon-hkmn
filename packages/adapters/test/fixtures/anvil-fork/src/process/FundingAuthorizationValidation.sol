// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault } from "./IPegCycleVault.sol";

/// @notice Validates one `FundingAuthorization` against the vault's immutable identities and
/// consumption state, exactly the field-level check `PegCycleVault._validateFundingAuthorization`
/// performed inline before this split.
/// @dev Declared as an `external` library deliberately: every function here is called through a
/// real `DELEGATECALL`, not inlined, so this logic's bytecode is deployed once, separately, and
/// does not count against `PegCycleVault`'s own EIP-170 24,576-byte runtime budget -- the same
/// technique `PayoutDistributionSignatures` uses for `authorizePayout`'s validation, applied here
/// to `authorizeFunding`/`authorizeFundingAfterFailure`'s shared validation. `verify` takes every
/// piece of vault state it needs as plain value arguments rather than reading `PegCycleVault`'s
/// storage itself, so a future storage-layout change on the vault can never silently desynchronize
/// it from this check.
library FundingAuthorizationValidation {
    /// @notice Any field of `authorization` does not exactly match the vault's immutable
    /// identities, the computed escrow, or the required consumption/balance state.
    error InvalidAuthorization();

    /// @dev The revision this library's field validation is written for -- identical to
    /// `PegCycleVault.REQUIREMENTS_REVISION` by construction; this library is deployed and pinned
    /// per-vault, not shared generically, so duplicating the constant here (rather than passing
    /// it as a call argument) costs nothing in practice and one less field to encode.
    uint32 private constant REQUIREMENTS_REVISION = 57;

    /// @dev Everything `_validateFundingAuthorization` needs beyond `authorization` itself and
    /// `address(this)` (this function runs via `DELEGATECALL`, so `address(this)` here already
    /// resolves to the vault, not the library).
    struct VaultIdentity {
        address hook;
        address usdg;
        address authorizer;
        address routeExecutor;
        address distributionSigner;
        address distributionVerifier;
        bytes32 bindingManifestDigest;
        address expectedEscrow;
        bool nonceConsumed;
        // `cycleConsumed` alone also covers "this cycle's escrow is already deployed": the two
        // are set together, unconditionally, in the same statement (`_storeFundingAuthorization`
        // is the only place either is ever written), so a separate escrow-nonzero check would
        // only ever duplicate this one.
        bool cycleConsumed;
        uint256 expectedEscrowBalance;
    }

    /// @notice Reverts unless `authorization` exactly matches `identity` (and this vault's own
    /// address, read as `address(this)` under the `DELEGATECALL` this runs through). Returns
    /// nothing on success.
    function verify(
        IPegCycleVault.FundingAuthorization calldata authorization,
        VaultIdentity calldata identity
    ) external view {
        if (
            authorization.requirementsRevision != REQUIREMENTS_REVISION
                || authorization.chainId != block.chainid || authorization.cycleId == bytes32(0)
                || authorization.hook != identity.hook || authorization.vault != address(this)
                || authorization.usdg != identity.usdg
                || authorization.operationsTrigger == address(0)
                || authorization.operationsTrigger == identity.authorizer
                || authorization.operationsTrigger == identity.hook
                || authorization.operationsTrigger == address(this)
                || authorization.operationsTrigger == identity.routeExecutor
                || authorization.operationsTrigger == identity.usdg
                // The operations trigger is the low-trust, always-on automation identity. It
                // must never coincide with either pinned distribution-approval identity
                // (decision D7): that would let the same compromised key that already controls
                // fund flow also stand in as one of the two required payout-authorization
                // signers.
                || authorization.operationsTrigger == identity.distributionSigner
                || authorization.operationsTrigger == identity.distributionVerifier
                || authorization.operationsTrigger == identity.expectedEscrow
                || authorization.amount == 0
                || authorization.bindingManifestDigest != identity.bindingManifestDigest
                || authorization.outboundActionDigest == bytes32(0)
                || authorization.returnActionDigest == bytes32(0)
                || authorization.returnDestination != identity.expectedEscrow
                || authorization.minimumRobinhoodReceive == 0
                || authorization.minimumSolanaReceive == 0 || authorization.minimumReturnUsdg == 0
                || authorization.robinhoodNativeGasCap == 0 || authorization.solanaNativeGasCap == 0
                || authorization.expiresAt <= block.timestamp || authorization.nonce == 0
                || identity.nonceConsumed || identity.cycleConsumed
                || identity.expectedEscrowBalance != 0
        ) revert InvalidAuthorization();
    }
}
