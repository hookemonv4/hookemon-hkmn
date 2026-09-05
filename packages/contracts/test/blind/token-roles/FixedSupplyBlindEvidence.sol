// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library FixedSupplyBlindEvidence {
    struct RuntimeBinding {
        bytes32 bindingManifestDigest;
        bytes32 sourceSetDigest;
        bytes32 abiArtifactDigest;
        bytes32 selectorSetDigest;
        bytes32 initcodeHash;
        bytes32 deployedRuntimeHash;
        bytes32 storageLayoutDigest;
        bytes32 supplyWriteAuthorityDigest;
        bytes4[] allowedExternalSelectors;
    }

    struct RuntimeObservation {
        bytes32 sourceSetDigest;
        bytes32 abiArtifactDigest;
        bytes32 selectorSetDigest;
        bytes32 initcodeHash;
        bytes32 deployedRuntimeHash;
        bytes32 storageLayoutDigest;
        bytes32 supplyWriteAuthorityDigest;
        bytes4[] externalSelectors;
        uint256 runtimeSize;
        bool constructorOnlySingleSupplyMint;
        bool noProxyDelegatecallOrDestructivePath;
    }

    struct TransferRecord {
        address from;
        address to;
        uint256 amount;
    }

    function validateRuntimeAuthority(
        RuntimeBinding memory binding,
        RuntimeObservation memory observation,
        bytes32 actualRuntimeHash,
        uint256 actualRuntimeSize
    ) internal pure {
        require(binding.bindingManifestDigest != bytes32(0), "binding manifest evidence missing");
        _requireExactDigest(
            binding.sourceSetDigest, observation.sourceSetDigest, "source evidence mismatch"
        );
        _requireExactDigest(
            binding.abiArtifactDigest, observation.abiArtifactDigest, "ABI evidence mismatch"
        );
        _requireExactDigest(
            binding.initcodeHash, observation.initcodeHash, "initcode evidence mismatch"
        );
        _requireExactDigest(
            binding.deployedRuntimeHash,
            observation.deployedRuntimeHash,
            "runtime evidence mismatch"
        );
        _requireExactDigest(
            binding.storageLayoutDigest,
            observation.storageLayoutDigest,
            "storage evidence mismatch"
        );
        _requireExactDigest(
            binding.supplyWriteAuthorityDigest,
            observation.supplyWriteAuthorityDigest,
            "supply authority evidence mismatch"
        );

        require(
            actualRuntimeSize > 0 && observation.runtimeSize == actualRuntimeSize,
            "runtime size mismatch"
        );
        require(actualRuntimeHash == binding.deployedRuntimeHash, "bound runtime hash mismatch");
        require(observation.constructorOnlySingleSupplyMint, "single constructor mint unproven");
        require(
            observation.noProxyDelegatecallOrDestructivePath,
            "replacement or destruction absence unproven"
        );

        bytes4[] memory allowed = binding.allowedExternalSelectors;
        bytes4[] memory observed = observation.externalSelectors;
        require(
            allowed.length > 0 && observed.length == allowed.length,
            "external ABI selector count mismatch"
        );
        require(
            binding.selectorSetDigest == keccak256(abi.encode(allowed)),
            "bound selector digest mismatch"
        );
        require(
            observation.selectorSetDigest == keccak256(abi.encode(observed)),
            "observed selector digest mismatch"
        );
        require(
            binding.selectorSetDigest == observation.selectorSetDigest, "selector evidence mismatch"
        );

        for (uint256 i = 0; i < allowed.length; ++i) {
            require(allowed[i] == observed[i], "external ABI selector mismatch");
            if (i > 0) {
                require(uint32(allowed[i - 1]) < uint32(allowed[i]), "selectors not canonical");
            }
        }
    }

    function validateIssuanceTrace(
        address issuanceSource,
        address permanentMarket,
        address projectWallet,
        uint256 supply,
        TransferRecord[] memory transfers
    ) internal pure {
        require(permanentMarket != address(0), "permanent market missing");
        require(projectWallet != address(0), "project wallet missing");
        require(issuanceSource != projectWallet, "project wallet is issuance source");
        require(permanentMarket != projectWallet, "project wallet is permanent market");
        require(supply > 0, "invalid issuance supply");
        require(transfers.length > 0, "issuance trace missing");

        uint256 directMarketTransfers;
        uint256 directMarketAmount;
        uint256 sourceOutboundAmount;
        for (uint256 i = 0; i < transfers.length; ++i) {
            TransferRecord memory transfer = transfers[i];
            if (transfer.amount == 0) continue;
            require(
                transfer.from != projectWallet && transfer.to != projectWallet,
                "project wallet appears in issuance trace"
            );
            if (transfer.from == issuanceSource) sourceOutboundAmount += transfer.amount;
            if (transfer.to == permanentMarket) {
                require(transfer.from == issuanceSource, "indirect permanent market allocation");
                directMarketTransfers += 1;
                directMarketAmount += transfer.amount;
            }
        }

        require(sourceOutboundAmount == supply, "issuance source trace is incomplete");
        require(directMarketTransfers == 1, "market allocation is not one direct transfer");
        require(directMarketAmount == supply, "direct market allocation is not the full supply");
    }

    function _requireExactDigest(bytes32 expected, bytes32 observed, string memory label)
        private
        pure
    {
        require(expected != bytes32(0) && observed == expected, label);
    }
}
