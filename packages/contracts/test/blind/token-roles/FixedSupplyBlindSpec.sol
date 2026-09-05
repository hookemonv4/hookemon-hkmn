// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FixedSupplyBlindEvidence } from "./FixedSupplyBlindEvidence.sol";

interface VmBlind {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

interface IHookemonTokenBlind {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool);
}

abstract contract FixedSupplyBlindSpec {
    uint256 internal constant WHOLE_HKMN_SUPPLY = 1_000_000_000;
    bytes32 internal constant TRANSFER_EVENT_SIGNATURE =
        keccak256("Transfer(address,address,uint256)");

    address internal constant WALLET_A = address(0xA11CE);
    address internal constant WALLET_B = address(0xB0B);
    address internal constant SPENDER = address(0x5EED);
    address internal constant UNAUTHORIZED = address(0xBAD);

    VmBlind internal constant vm = VmBlind(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Deployment {
        IHookemonTokenBlind token;
        address canonicalMarket;
        address marketPositionCustody;
        address launchAuthority;
        address projectWallet;
    }

    function _deployThroughBoundLaunchPath() internal virtual returns (Deployment memory deployment);
    function _expectedBoundDecimals(Deployment memory deployment)
        internal
        view
        virtual
        returns (uint8);
    function _boundRuntimeAuthority(Deployment memory deployment)
        internal
        view
        virtual
        returns (FixedSupplyBlindEvidence.RuntimeBinding memory binding);
    function _observedRuntimeAuthority(Deployment memory deployment)
        internal
        view
        virtual
        returns (FixedSupplyBlindEvidence.RuntimeObservation memory observation);
    function _boundIssuanceSource(Deployment memory deployment)
        internal
        view
        virtual
        returns (address);
    function _attemptDuplicateIssue(Deployment memory deployment, address caller)
        internal
        virtual
        returns (bool);
    function _attemptUnauthorizedInitialIssue(address caller) internal virtual returns (bool);
    function _isProjectControlled(Deployment memory deployment, address subject)
        internal
        view
        virtual
        returns (bool);
    function _acquireWalletBalance(Deployment memory deployment, address holder)
        internal
        virtual
        returns (uint256 acquiredAmount);
    function _projectFeeLiability(Deployment memory deployment)
        internal
        view
        virtual
        returns (uint256);
    function _marketPositionCommitment(Deployment memory deployment)
        internal
        view
        virtual
        returns (bytes32);
    function _attemptMarketPositionWithdraw(Deployment memory deployment, address caller)
        internal
        virtual
        returns (bool);
    function _attemptMarketPositionRescue(Deployment memory deployment, address caller)
        internal
        virtual
        returns (bool);
    function _attemptMarketPositionUpgrade(Deployment memory deployment, address caller)
        internal
        virtual
        returns (bool);

    function test_BlindFixedSupplyHasExactIdentityAndSupply() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint8 decimals = deployment.token.decimals();

        _assertEq(deployment.token.name(), "Hookemon", "token name");
        _assertEq(deployment.token.symbol(), "HKMN", "token symbol");
        _assertEq(
            uint256(decimals),
            uint256(_expectedBoundDecimals(deployment)),
            "provider-bound decimals"
        );
        _assertEq(deployment.token.totalSupply(), _scaledSupply(decimals), "fixed total supply");
    }

    function test_BlindInitialAllocationIsTheWholeSupplyAtCanonicalMarket() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 supply = deployment.token.totalSupply();

        _assertNonzero(deployment.canonicalMarket, "canonical market");
        _assertNonzero(deployment.projectWallet, "project wallet");
        _assertTrue(
            deployment.canonicalMarket != deployment.projectWallet,
            "canonical market is project wallet"
        );
        _assertEq(
            deployment.token.balanceOf(deployment.canonicalMarket),
            supply,
            "canonical market allocation"
        );
        _assertEq(
            deployment.token.balanceOf(deployment.projectWallet),
            0,
            "project wallet initial allocation"
        );
    }

    function test_BlindIssuanceTraceDirectlyAllocatesMarketWithoutProjectWalletHop() external {
        vm.recordLogs();
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        VmBlind.Log[] memory logs = vm.getRecordedLogs();
        FixedSupplyBlindEvidence.TransferRecord[] memory transfers =
            _tokenTransferRecords(logs, address(deployment.token));

        FixedSupplyBlindEvidence.validateIssuanceTrace(
            _boundIssuanceSource(deployment),
            deployment.canonicalMarket,
            deployment.projectWallet,
            deployment.token.totalSupply(),
            transfers
        );
    }

    function test_BlindIssuanceRejectsDuplicateCreation() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 supplyBefore = deployment.token.totalSupply();

        _assertFalse(
            _attemptDuplicateIssue(deployment, deployment.launchAuthority),
            "duplicate authorized issuance"
        );
        _assertEq(
            deployment.token.totalSupply(), supplyBefore, "supply changed after duplicate issuance"
        );
    }

    function test_BlindIssuanceRejectsUnauthorizedCreation() external {
        _assertFalse(
            _attemptUnauthorizedInitialIssue(UNAUTHORIZED), "unauthorized initial issuance"
        );
    }

    function test_BlindWalletTransferCreditsTheCompleteAmount() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 acquired = _acquireWalletBalance(deployment, WALLET_A);
        uint256 amount = _nonzeroFraction(acquired, 3);
        uint256 senderBefore = deployment.token.balanceOf(WALLET_A);
        uint256 recipientBefore = deployment.token.balanceOf(WALLET_B);
        uint256 liabilityBefore = _projectFeeLiability(deployment);

        _transferAs(deployment.token, WALLET_A, WALLET_B, amount);

        _assertEq(deployment.token.balanceOf(WALLET_A), senderBefore - amount, "sender debit");
        _assertEq(
            deployment.token.balanceOf(WALLET_B), recipientBefore + amount, "recipient credit"
        );
        _assertEq(_projectFeeLiability(deployment), liabilityBefore, "wallet transfer project fee");
    }

    function test_BlindMaximumPracticalWalletTransferCreditsTheCompleteBalance() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 acquired = _acquireWalletBalance(deployment, WALLET_A);
        uint256 recipientBefore = deployment.token.balanceOf(WALLET_B);

        _assertTrue(acquired > 0, "fixture acquired no wallet balance");
        _transferAs(deployment.token, WALLET_A, WALLET_B, acquired);

        _assertEq(deployment.token.balanceOf(WALLET_A), 0, "maximum transfer sender balance");
        _assertEq(
            deployment.token.balanceOf(WALLET_B),
            recipientBefore + acquired,
            "maximum transfer recipient"
        );
    }

    function test_BlindZeroValueTransferHasNoSideEffects() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 senderBefore = deployment.token.balanceOf(WALLET_A);
        uint256 recipientBefore = deployment.token.balanceOf(WALLET_B);
        uint256 liabilityBefore = _projectFeeLiability(deployment);

        _transferAs(deployment.token, WALLET_A, WALLET_B, 0);

        _assertEq(
            deployment.token.balanceOf(WALLET_A), senderBefore, "zero transfer sender balance"
        );
        _assertEq(
            deployment.token.balanceOf(WALLET_B), recipientBefore, "zero transfer recipient balance"
        );
        _assertEq(_projectFeeLiability(deployment), liabilityBefore, "zero transfer project fee");
    }

    function test_BlindSelfTransferHasNoSideEffects() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 acquired = _acquireWalletBalance(deployment, WALLET_A);
        uint256 balanceBefore = deployment.token.balanceOf(WALLET_A);
        uint256 liabilityBefore = _projectFeeLiability(deployment);

        _transferAs(deployment.token, WALLET_A, WALLET_A, _nonzeroFraction(acquired, 2));

        _assertEq(deployment.token.balanceOf(WALLET_A), balanceBefore, "self-transfer balance");
        _assertEq(_projectFeeLiability(deployment), liabilityBefore, "self-transfer project fee");
    }

    function test_BlindAllowanceTransferCreditsTheCompleteAmount() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 acquired = _acquireWalletBalance(deployment, WALLET_A);
        uint256 amount = _nonzeroFraction(acquired, 4);
        uint256 recipientBefore = deployment.token.balanceOf(WALLET_B);

        _approveAs(deployment.token, WALLET_A, SPENDER, amount);
        _transferFromAs(deployment.token, SPENDER, WALLET_A, WALLET_B, amount);

        _assertEq(deployment.token.balanceOf(WALLET_A), acquired - amount, "allowance sender debit");
        _assertEq(
            deployment.token.balanceOf(WALLET_B),
            recipientBefore + amount,
            "allowance recipient credit"
        );
        _assertEq(deployment.token.allowance(WALLET_A, SPENDER), 0, "allowance consumed");
    }

    function testFuzz_BlindWalletTransferNeverChargesProjectFee(uint96 rawAmount) external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        uint256 acquired = _acquireWalletBalance(deployment, WALLET_A);
        _assertTrue(acquired > 0, "fixture acquired no wallet balance");
        uint256 amount = (uint256(rawAmount) % acquired) + 1;
        uint256 recipientBefore = deployment.token.balanceOf(WALLET_B);
        uint256 liabilityBefore = _projectFeeLiability(deployment);

        _transferAs(deployment.token, WALLET_A, WALLET_B, amount);

        _assertEq(
            deployment.token.balanceOf(WALLET_B), recipientBefore + amount, "fuzz recipient credit"
        );
        _assertEq(
            _projectFeeLiability(deployment), liabilityBefore, "fuzz wallet transfer project fee"
        );
    }

    function test_BlindTokenRuntimeMatchesExactBoundAuthorityEvidence() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        FixedSupplyBlindEvidence.RuntimeBinding memory binding = _boundRuntimeAuthority(deployment);
        FixedSupplyBlindEvidence.RuntimeObservation memory observation =
            _observedRuntimeAuthority(deployment);
        address token = address(deployment.token);

        FixedSupplyBlindEvidence.validateRuntimeAuthority(
            binding, observation, token.codehash, token.code.length
        );
    }

    function test_BlindTokenRuntimeHasNoKnownForbiddenSelectors() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        bytes4[] memory forbidden = new bytes4[](17);
        forbidden[0] = bytes4(keccak256("mint(address,uint256)"));
        forbidden[1] = bytes4(keccak256("burn(uint256)"));
        forbidden[2] = bytes4(keccak256("burnFrom(address,uint256)"));
        forbidden[3] = bytes4(keccak256("blacklist(address)"));
        forbidden[4] = bytes4(keccak256("confiscate(address,uint256)"));
        forbidden[5] = bytes4(keccak256("pause()"));
        forbidden[6] = bytes4(keccak256("unpause()"));
        forbidden[7] = bytes4(keccak256("setTax(uint256)"));
        forbidden[8] = bytes4(keccak256("setFee(uint256)"));
        forbidden[9] = bytes4(keccak256("setFeeRecipient(address)"));
        forbidden[10] = bytes4(keccak256("owner()"));
        forbidden[11] = bytes4(keccak256("admin()"));
        forbidden[12] = bytes4(keccak256("transferOwnership(address)"));
        forbidden[13] = bytes4(keccak256("upgradeTo(address)"));
        forbidden[14] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        forbidden[15] = bytes4(keccak256("rescueToken(address,address,uint256)"));
        forbidden[16] = bytes4(keccak256("recoverERC20(address,uint256)"));

        // This denylist is an additional negative control. The exact bound ABI allowlist above is authoritative.
        for (uint256 i = 0; i < forbidden.length; ++i) {
            _assertFalse(
                _containsPush4(address(deployment.token), forbidden[i]), "forbidden token selector"
            );
        }
    }

    function test_BlindTokenRuntimeHasNoReplacementOrDestructionOpcode() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();

        _assertFalse(
            _containsExecutableOpcode(address(deployment.token), 0xf4), "token DELEGATECALL"
        );
        _assertFalse(
            _containsExecutableOpcode(address(deployment.token), 0xff), "token SELFDESTRUCT"
        );
    }

    function test_BlindMarketPositionCustodyIsPermanentAndNotProjectControlled() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        bytes32 commitmentBefore = _marketPositionCommitment(deployment);

        _assertNonzero(deployment.marketPositionCustody, "market position custody");
        _assertFalse(
            _isProjectControlled(deployment, deployment.marketPositionCustody),
            "project-controlled market custody"
        );
        _assertFalse(
            _attemptMarketPositionWithdraw(deployment, deployment.projectWallet),
            "project LP withdrawal"
        );
        _assertFalse(
            _attemptMarketPositionRescue(deployment, deployment.projectWallet), "project LP rescue"
        );
        _assertFalse(
            _attemptMarketPositionUpgrade(deployment, deployment.projectWallet),
            "project LP upgrade"
        );
        _assertEq(
            _marketPositionCommitment(deployment),
            commitmentBefore,
            "market position commitment changed"
        );
    }

    function test_BlindMarketPositionCustodyHasNoUpgradeOrRescueSelectors() external {
        Deployment memory deployment = _deployThroughBoundLaunchPath();
        bytes4[] memory forbidden = new bytes4[](6);
        forbidden[0] = bytes4(keccak256("withdraw(address,uint256)"));
        forbidden[1] = bytes4(keccak256("rescueToken(address,address,uint256)"));
        forbidden[2] = bytes4(keccak256("recoverERC20(address,uint256)"));
        forbidden[3] = bytes4(keccak256("upgradeTo(address)"));
        forbidden[4] = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
        forbidden[5] = bytes4(keccak256("transferOwnership(address)"));

        for (uint256 i = 0; i < forbidden.length; ++i) {
            _assertFalse(
                _containsPush4(deployment.marketPositionCustody, forbidden[i]),
                "forbidden market custody selector"
            );
        }
        _assertFalse(
            _containsExecutableOpcode(deployment.marketPositionCustody, 0xf4),
            "market custody DELEGATECALL"
        );
        _assertFalse(
            _containsExecutableOpcode(deployment.marketPositionCustody, 0xff),
            "market custody SELFDESTRUCT"
        );
    }

    function _transferAs(
        IHookemonTokenBlind token,
        address caller,
        address recipient,
        uint256 amount
    ) internal {
        vm.prank(caller);
        _assertTrue(token.transfer(recipient, amount), "ERC20 transfer returned false");
    }

    function _approveAs(IHookemonTokenBlind token, address owner, address spender, uint256 amount)
        internal
    {
        vm.prank(owner);
        _assertTrue(token.approve(spender, amount), "ERC20 approve returned false");
    }

    function _transferFromAs(
        IHookemonTokenBlind token,
        address caller,
        address owner,
        address recipient,
        uint256 amount
    ) internal {
        vm.prank(caller);
        _assertTrue(
            token.transferFrom(owner, recipient, amount), "ERC20 transferFrom returned false"
        );
    }

    function _scaledSupply(uint8 decimals) internal pure returns (uint256) {
        uint256 scale = 1;
        for (uint256 i = 0; i < decimals; ++i) {
            require(scale <= type(uint256).max / 10, "decimal scale overflow");
            scale *= 10;
        }
        require(WHOLE_HKMN_SUPPLY <= type(uint256).max / scale, "supply scale overflow");
        return WHOLE_HKMN_SUPPLY * scale;
    }

    function _nonzeroFraction(uint256 amount, uint256 divisor) internal pure returns (uint256) {
        require(amount > 0, "fixture acquired no wallet balance");
        uint256 fraction = amount / divisor;
        return fraction == 0 ? 1 : fraction;
    }

    function _tokenTransferRecords(VmBlind.Log[] memory logs, address token)
        internal
        pure
        returns (FixedSupplyBlindEvidence.TransferRecord[] memory transfers)
    {
        uint256 count;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != token || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] != TRANSFER_EVENT_SIGNATURE) continue;
            _requireCanonicalTransferLog(logs[i]);
            count += 1;
        }

        transfers = new FixedSupplyBlindEvidence.TransferRecord[](count);
        uint256 cursor;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != token || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] != TRANSFER_EVENT_SIGNATURE) continue;
            transfers[cursor] = FixedSupplyBlindEvidence.TransferRecord({
                from: address(uint160(uint256(logs[i].topics[1]))),
                to: address(uint160(uint256(logs[i].topics[2]))),
                amount: abi.decode(logs[i].data, (uint256))
            });
            cursor += 1;
        }
    }

    function _requireCanonicalTransferLog(VmBlind.Log memory entry) internal pure {
        require(entry.topics.length == 3 && entry.data.length == 32, "malformed token Transfer log");
        require(
            uint256(entry.topics[1]) >> 160 == 0 && uint256(entry.topics[2]) >> 160 == 0,
            "noncanonical token Transfer address"
        );
    }

    function _containsPush4(address target, bytes4 selector) internal view returns (bool) {
        bytes memory code = target.code;
        uint256 end = _executableLength(code);
        bytes4 candidate;
        for (uint256 i = 0; i + 4 < end; ++i) {
            if (uint8(code[i]) != 0x63) continue;
            assembly ("memory-safe") {
                candidate := mload(add(add(code, 0x21), i))
            }
            if (candidate == selector) return true;
        }
        return false;
    }

    function _containsExecutableOpcode(address target, uint8 needle) internal view returns (bool) {
        bytes memory code = target.code;
        uint256 end = _executableLength(code);
        for (uint256 i = 0; i < end; ++i) {
            uint8 opcode = uint8(code[i]);
            if (opcode == needle) return true;
            if (opcode >= 0x60 && opcode <= 0x7f) i += opcode - 0x5f;
        }
        return false;
    }

    function _executableLength(bytes memory code) internal pure returns (uint256) {
        if (code.length < 2) return code.length;
        uint256 metadataLength = (uint8(code[code.length - 2]) << 8) | uint8(code[code.length - 1]);
        if (metadataLength + 2 > code.length) return code.length;
        return code.length - metadataLength - 2;
    }

    function _assertTrue(bool condition, string memory label) internal pure {
        require(condition, label);
    }

    function _assertFalse(bool condition, string memory label) internal pure {
        require(!condition, label);
    }

    function _assertNonzero(address value, string memory label) internal pure {
        require(value != address(0), label);
    }

    function _assertEq(uint256 actual, uint256 expected, string memory label) internal pure {
        require(actual == expected, label);
    }

    function _assertEq(bytes32 actual, bytes32 expected, string memory label) internal pure {
        require(actual == expected, label);
    }

    function _assertEq(string memory actual, string memory expected, string memory label)
        internal
        pure
    {
        require(keccak256(bytes(actual)) == keccak256(bytes(expected)), label);
    }
}
