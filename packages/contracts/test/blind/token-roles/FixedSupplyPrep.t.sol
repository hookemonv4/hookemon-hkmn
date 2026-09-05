// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FixedSupplyBlindEvidence } from "./FixedSupplyBlindEvidence.sol";

contract FixedSupplyEvidenceHarness {
    function validateRuntimeAuthority(
        FixedSupplyBlindEvidence.RuntimeBinding memory binding,
        FixedSupplyBlindEvidence.RuntimeObservation memory observation,
        bytes32 actualRuntimeHash,
        uint256 actualRuntimeSize
    ) external pure {
        FixedSupplyBlindEvidence.validateRuntimeAuthority(
            binding, observation, actualRuntimeHash, actualRuntimeSize
        );
    }

    function validateIssuanceTrace(
        address issuanceSource,
        address permanentMarket,
        address projectWallet,
        uint256 supply,
        FixedSupplyBlindEvidence.TransferRecord[] memory transfers
    ) external pure {
        FixedSupplyBlindEvidence.validateIssuanceTrace(
            issuanceSource, permanentMarket, projectWallet, supply, transfers
        );
    }
}

contract FixedSupplyPrepTest {
    uint256 internal constant WHOLE_HKMN_SUPPLY = 1_000_000_000;

    FixedSupplyEvidenceHarness internal immutable evidenceHarness =
        new FixedSupplyEvidenceHarness();

    function test_PrepCatalogAllocatesWholeSupplyToCanonicalMarket() external pure {
        uint256 marketAllocation = WHOLE_HKMN_SUPPLY;
        uint256 otherAllocation;

        require(marketAllocation == 1_000_000_000, "market allocation catalog");
        require(otherAllocation == 0, "other allocation catalog");
        require(marketAllocation + otherAllocation == WHOLE_HKMN_SUPPLY, "allocation catalog total");
    }

    function test_PrepForbiddenTokenSelectorCatalogHasNoDuplicates() external pure {
        _requireUnique(_forbiddenTokenSelectors(), "duplicate forbidden token selector");
    }

    function test_PrepForbiddenCustodySelectorCatalogHasNoDuplicates() external pure {
        _requireUnique(_forbiddenCustodySelectors(), "duplicate forbidden custody selector");
    }

    function test_PrepRuntimeAuthorityAcceptsOnlyExactBoundEvidence() external view {
        (
            FixedSupplyBlindEvidence.RuntimeBinding memory binding,
            FixedSupplyBlindEvidence.RuntimeObservation memory observation
        ) = _runtimeEvidence();

        evidenceHarness.validateRuntimeAuthority(
            binding, observation, observation.deployedRuntimeHash, observation.runtimeSize
        );
    }

    function test_PrepRuntimeAuthorityRejectsUnexpectedAbiSelector() external {
        (
            FixedSupplyBlindEvidence.RuntimeBinding memory binding,
            FixedSupplyBlindEvidence.RuntimeObservation memory observation
        ) = _runtimeEvidence();
        observation.externalSelectors = new bytes4[](3);
        observation.externalSelectors[0] = bytes4(0x01020304);
        observation.externalSelectors[1] = bytes4(0x11121314);
        observation.externalSelectors[2] = bytes4(0x21222324);

        _expectFailure(
            abi.encodeCall(
                evidenceHarness.validateRuntimeAuthority,
                (binding, observation, observation.deployedRuntimeHash, observation.runtimeSize)
            ),
            "unexpected ABI selector accepted"
        );
    }

    function test_PrepRuntimeAuthorityRejectsSourceRuntimeAndStorageMismatch() external {
        (
            FixedSupplyBlindEvidence.RuntimeBinding memory binding,
            FixedSupplyBlindEvidence.RuntimeObservation memory observation
        ) = _runtimeEvidence();

        observation.sourceSetDigest = keccak256("different source set");
        _expectRuntimeFailure(binding, observation, "source mismatch accepted");

        (, observation) = _runtimeEvidence();
        observation.deployedRuntimeHash = keccak256("different runtime");
        _expectRuntimeFailure(binding, observation, "runtime mismatch accepted");

        (, observation) = _runtimeEvidence();
        observation.storageLayoutDigest = keccak256("different storage layout");
        _expectRuntimeFailure(binding, observation, "storage mismatch accepted");
    }

    function test_PrepIssuanceTraceAcceptsOneDirectFullSupplyMarketAllocation() external view {
        FixedSupplyBlindEvidence.TransferRecord[] memory transfers = _directIssuanceTrace();

        evidenceHarness.validateIssuanceTrace(
            address(0), address(0xBEEF), address(0xCAFE), WHOLE_HKMN_SUPPLY, transfers
        );
    }

    function test_PrepIssuanceTraceRejectsProjectWalletHop() external {
        FixedSupplyBlindEvidence.TransferRecord[] memory transfers =
            new FixedSupplyBlindEvidence.TransferRecord[](2);
        transfers[0] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0), to: address(0xCAFE), amount: WHOLE_HKMN_SUPPLY
        });
        transfers[1] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0xCAFE), to: address(0xBEEF), amount: WHOLE_HKMN_SUPPLY
        });

        _expectFailure(
            abi.encodeCall(
                evidenceHarness.validateIssuanceTrace,
                (address(0), address(0xBEEF), address(0xCAFE), WHOLE_HKMN_SUPPLY, transfers)
            ),
            "project-wallet issuance hop accepted"
        );
    }

    function test_PrepIssuanceTraceRejectsIndirectMarketAllocation() external {
        FixedSupplyBlindEvidence.TransferRecord[] memory transfers =
            new FixedSupplyBlindEvidence.TransferRecord[](2);
        transfers[0] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0), to: address(0xABCD), amount: WHOLE_HKMN_SUPPLY
        });
        transfers[1] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0xABCD), to: address(0xBEEF), amount: WHOLE_HKMN_SUPPLY
        });

        _expectFailure(
            abi.encodeCall(
                evidenceHarness.validateIssuanceTrace,
                (address(0), address(0xBEEF), address(0xCAFE), WHOLE_HKMN_SUPPLY, transfers)
            ),
            "indirect market allocation accepted"
        );
    }

    function test_PrepIssuanceTraceRejectsOtherInitialAllocation() external {
        FixedSupplyBlindEvidence.TransferRecord[] memory transfers =
            new FixedSupplyBlindEvidence.TransferRecord[](2);
        transfers[0] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0), to: address(0xBEEF), amount: WHOLE_HKMN_SUPPLY - 1
        });
        transfers[1] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0), to: address(0xF00D), amount: 1
        });

        _expectFailure(
            abi.encodeCall(
                evidenceHarness.validateIssuanceTrace,
                (address(0), address(0xBEEF), address(0xCAFE), WHOLE_HKMN_SUPPLY, transfers)
            ),
            "other initial allocation accepted"
        );
    }

    function _forbiddenTokenSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](17);
        selectors[0] = bytes4(keccak256("mint(address,uint256)"));
        selectors[1] = bytes4(keccak256("burn(uint256)"));
        selectors[2] = bytes4(keccak256("burnFrom(address,uint256)"));
        selectors[3] = bytes4(keccak256("blacklist(address)"));
        selectors[4] = bytes4(keccak256("confiscate(address,uint256)"));
        selectors[5] = bytes4(keccak256("pause()"));
        selectors[6] = bytes4(keccak256("unpause()"));
        selectors[7] = bytes4(keccak256("setTax(uint256)"));
        selectors[8] = bytes4(keccak256("setFee(uint256)"));
        selectors[9] = bytes4(keccak256("setFeeRecipient(address)"));
        selectors[10] = bytes4(keccak256("owner()"));
        selectors[11] = bytes4(keccak256("admin()"));
        selectors[12] = bytes4(keccak256("transferOwnership(address)"));
        selectors[13] = bytes4(keccak256("upgradeTo(address)"));
        selectors[14] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        selectors[15] = bytes4(keccak256("rescueToken(address,address,uint256)"));
        selectors[16] = bytes4(keccak256("recoverERC20(address,uint256)"));
    }

    function _forbiddenCustodySelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](6);
        selectors[0] = bytes4(keccak256("withdraw(address,uint256)"));
        selectors[1] = bytes4(keccak256("rescueToken(address,address,uint256)"));
        selectors[2] = bytes4(keccak256("recoverERC20(address,uint256)"));
        selectors[3] = bytes4(keccak256("upgradeTo(address)"));
        selectors[4] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        selectors[5] = bytes4(keccak256("transferOwnership(address)"));
    }

    function _requireUnique(bytes4[] memory selectors, string memory label) internal pure {
        for (uint256 i = 0; i < selectors.length; ++i) {
            for (uint256 j = i + 1; j < selectors.length; ++j) {
                require(selectors[i] != selectors[j], label);
            }
        }
    }

    function _runtimeEvidence()
        internal
        pure
        returns (
            FixedSupplyBlindEvidence.RuntimeBinding memory binding,
            FixedSupplyBlindEvidence.RuntimeObservation memory observation
        )
    {
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = bytes4(0x01020304);
        selectors[1] = bytes4(0x11121314);

        bytes32 bindingManifestDigest = keccak256("synthetic binding manifest");
        bytes32 sourceSetDigest = keccak256("synthetic source set");
        bytes32 abiArtifactDigest = keccak256("synthetic ABI artifact");
        bytes32 selectorSetDigest = keccak256(abi.encode(selectors));
        bytes32 initcodeHash = keccak256("synthetic initcode");
        bytes32 deployedRuntimeHash = keccak256("synthetic runtime");
        bytes32 storageLayoutDigest = keccak256("synthetic storage layout");
        bytes32 supplyWriteAuthorityDigest = keccak256("synthetic supply authority proof");

        binding = FixedSupplyBlindEvidence.RuntimeBinding({
            bindingManifestDigest: bindingManifestDigest,
            sourceSetDigest: sourceSetDigest,
            abiArtifactDigest: abiArtifactDigest,
            selectorSetDigest: selectorSetDigest,
            initcodeHash: initcodeHash,
            deployedRuntimeHash: deployedRuntimeHash,
            storageLayoutDigest: storageLayoutDigest,
            supplyWriteAuthorityDigest: supplyWriteAuthorityDigest,
            allowedExternalSelectors: selectors
        });
        observation = FixedSupplyBlindEvidence.RuntimeObservation({
            sourceSetDigest: sourceSetDigest,
            abiArtifactDigest: abiArtifactDigest,
            selectorSetDigest: selectorSetDigest,
            initcodeHash: initcodeHash,
            deployedRuntimeHash: deployedRuntimeHash,
            storageLayoutDigest: storageLayoutDigest,
            supplyWriteAuthorityDigest: supplyWriteAuthorityDigest,
            externalSelectors: selectors,
            runtimeSize: 1,
            constructorOnlySingleSupplyMint: true,
            noProxyDelegatecallOrDestructivePath: true
        });
    }

    function _directIssuanceTrace()
        internal
        pure
        returns (FixedSupplyBlindEvidence.TransferRecord[] memory transfers)
    {
        transfers = new FixedSupplyBlindEvidence.TransferRecord[](1);
        transfers[0] = FixedSupplyBlindEvidence.TransferRecord({
            from: address(0), to: address(0xBEEF), amount: WHOLE_HKMN_SUPPLY
        });
    }

    function _expectRuntimeFailure(
        FixedSupplyBlindEvidence.RuntimeBinding memory binding,
        FixedSupplyBlindEvidence.RuntimeObservation memory observation,
        string memory label
    ) internal {
        _expectFailure(
            abi.encodeCall(
                evidenceHarness.validateRuntimeAuthority,
                (binding, observation, observation.deployedRuntimeHash, observation.runtimeSize)
            ),
            label
        );
    }

    function _expectFailure(bytes memory callData, string memory label) internal {
        (bool succeeded,) = address(evidenceHarness).call(callData);
        require(!succeeded, label);
    }
}
