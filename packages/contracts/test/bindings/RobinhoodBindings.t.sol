// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    ImmutableLaunchBinding,
    PermanentPositionCustody,
    RobinhoodBindings
} from "../../src/bindings/RobinhoodBindings.sol";

contract MockPositionManager {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => uint256) public liquidity;
    mapping(uint256 => uint256) public collected;

    function mint(address recipient, uint256 tokenId, uint256 amount) external {
        require(ownerOf[tokenId] == address(0), "ALREADY_MINTED");
        ownerOf[tokenId] = recipient;
        liquidity[tokenId] = amount;
    }

    function approve(address operator, uint256 tokenId) external {
        require(msg.sender == ownerOf[tokenId], "NOT_OWNER");
        getApproved[tokenId] = operator;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(from == ownerOf[tokenId], "WRONG_FROM");
        require(
            msg.sender == from || msg.sender == getApproved[tokenId]
                || isApprovedForAll[from][msg.sender],
            "NOT_AUTHORIZED"
        );
        ownerOf[tokenId] = to;
        delete getApproved[tokenId];
    }

    function decreaseLiquidity(uint256 tokenId, uint256 amount) external {
        require(
            msg.sender == ownerOf[tokenId] || msg.sender == getApproved[tokenId], "NOT_AUTHORIZED"
        );
        liquidity[tokenId] -= amount;
    }

    function collect(uint256 tokenId) external {
        require(
            msg.sender == ownerOf[tokenId] || msg.sender == getApproved[tokenId], "NOT_AUTHORIZED"
        );
        collected[tokenId] += 1;
    }
}

contract MockCanonicalMarket {
    PermanentPositionCustody public immutable custody;
    uint256 public buys;
    uint256 public sells;

    constructor(PermanentPositionCustody custody_) {
        custody = custody_;
    }

    function buy() external {
        require(custody.positionReceived(), "CUSTODY_NOT_FINAL");
        buys += 1;
    }

    function sell() external {
        require(custody.positionReceived(), "CUSTODY_NOT_FINAL");
        sells += 1;
    }
}

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract Caller {
    function callTarget(address target, bytes calldata data) external returns (bool ok) {
        (ok,) = target.call(data);
    }
}

contract RobinhoodBindingsTest {
    uint160 internal constant HOOK_MASK = 0x20CC;
    uint160 internal constant ALL_HOOK_MASK = (1 << 14) - 1;

    function testPermanentCustodyHasNoProjectControlAndTradingContinues() external {
        MockPositionManager manager = new MockPositionManager();
        PermanentPositionCustody unbackedCustody = new PermanentPositionCustody(address(manager), 8);
        (bool finalizedWithoutOwnership,) =
            address(unbackedCustody).call(abi.encodeCall(unbackedCustody.finalizePosition, ()));
        assert(!finalizedWithoutOwnership);
        assert(!unbackedCustody.positionReceived());

        PermanentPositionCustody custody = new PermanentPositionCustody(address(manager), 7);
        MockCanonicalMarket market = new MockCanonicalMarket(custody);
        (bool tradedBeforeCustody,) = address(market).call(abi.encodeCall(market.buy, ()));
        assert(!tradedBeforeCustody);
        uint256 fixedSupply = 1_000_000;
        uint256 marketAllocation = 900_000;
        assert(marketAllocation * 10_000 == fixedSupply * 9_000);
        manager.mint(address(custody), 7, marketAllocation);

        assert(manager.ownerOf(7) == address(custody));
        assert(manager.getApproved(7) == address(0));
        assert(manager.liquidity(7) == 900_000);
        assert(!custody.positionReceived());
        custody.finalizePosition();
        assert(custody.positionReceived());

        (bool finalizedTwice,) = address(custody).call(abi.encodeCall(custody.finalizePosition, ()));
        assert(!finalizedTwice);

        _assertNoProjectPositionControl(manager, custody);

        market.buy();
        market.sell();
        assert(market.buys() == 1);
        assert(market.sells() == 1);

        MockToken token = new MockToken();
        token.mint(address(this), 100);
        Caller recipient = new Caller();
        assert(token.transfer(address(recipient), 40));
        assert(token.balanceOf(address(this)) == 60);
        assert(token.balanceOf(address(recipient)) == 40);
    }

    function _assertNoProjectPositionControl(
        MockPositionManager manager,
        PermanentPositionCustody custody
    ) private {
        _assertExternalCallRejected(
            address(manager),
            abi.encodeCall(manager.transferFrom, (address(custody), address(this), 7))
        );
        _assertExternalCallRejected(
            address(manager), abi.encodeCall(manager.approve, (address(this), 7))
        );
        _assertExternalCallRejected(
            address(manager), abi.encodeCall(manager.decreaseLiquidity, (7, 1))
        );
        _assertExternalCallRejected(address(manager), abi.encodeCall(manager.collect, (7)));
        assert(manager.ownerOf(7) == address(custody));
        assert(manager.liquidity(7) == 900_000);
        assert(manager.collected(7) == 0);
    }

    function _assertExternalCallRejected(address target, bytes memory data) private {
        Caller actor = new Caller();
        assert(!actor.callTarget(target, data));
    }

    function testBindingRejectsEveryMissingOrDuplicateIdentity() external {
        RobinhoodBindings.Binding memory base = _validBinding();
        for (uint256 index = 0; index < 11; ++index) {
            RobinhoodBindings.Binding memory missing = _clone(base);
            _setIdentity(missing, index, address(0));
            _assertRejected(missing);

            RobinhoodBindings.Binding memory duplicate = _clone(base);
            address duplicateValue = index == 0 ? base.hkmn : base.usdg;
            _setIdentity(duplicate, index, duplicateValue);
            _assertRejected(duplicate);
        }
    }

    /// @dev WP-05: programmable-fee-policy.md pins the Programmable fee beneficiary to a fixed
    ///      address. A `Binding` whose `programmableBeneficiary` is any other nonzero, non-
    ///      duplicate address must be rejected specifically with `InvalidProgrammableBeneficiary`
    ///      (not merely rejected for some other reason), and the pinned address itself must
    ///      validate cleanly.
    function testBindingRejectsProgrammableBeneficiaryOtherThanPinnedAddress() external {
        RobinhoodBindings.Binding memory base = _validBinding();
        assert(base.programmableBeneficiary == RobinhoodBindings.PROGRAMMABLE_BENEFICIARY);

        RobinhoodBindings.Binding memory binding = _clone(base);
        address wrongBeneficiary = address(0x9999);
        binding.programmableBeneficiary = wrongBeneficiary;
        try new ImmutableLaunchBinding(binding) {
            assert(false);
        } catch (bytes memory reason) {
            assert(_selector(reason) == RobinhoodBindings.InvalidProgrammableBeneficiary.selector);
        }
    }

    function testBindingRejectsOperationsWalletDifferentFromCommittedIdentity() external {
        RobinhoodBindings.Binding memory binding = _validBinding();
        binding.operations = address(0x9999);
        _assertOperationsWalletRejected(binding);
    }

    function testBindingRejectsExpectedOperationsWalletDifferentFromCommittedIdentity() external {
        RobinhoodBindings.Binding memory binding = _validBinding();
        binding.expectedOperations = address(0x9999);
        _assertOperationsWalletRejected(binding);
    }

    function testBindingAcceptsOwnerPinnedOperationsWallet() external {
        RobinhoodBindings.Binding memory binding = _validBinding();
        assert(binding.operations == 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384);
        assert(binding.expectedOperations == 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384);

        ImmutableLaunchBinding frozen = new ImmutableLaunchBinding(binding);
        assert(frozen.operations() == 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384);
    }

    function testBindingRejectsEqualButUnapprovedOperationsWallet() external {
        RobinhoodBindings.Binding memory binding = _validBinding();
        binding.operations = address(0x9999);
        binding.expectedOperations = address(0x9999);
        _assertOperationsWalletRejected(binding);
    }

    function testBindingRejectsEveryPoolPermissionConstructionAndDigestMismatch() external {
        RobinhoodBindings.Binding memory base = _validBinding();

        RobinhoodBindings.Binding memory binding = _clone(base);
        (binding.currency0, binding.currency1) = (binding.currency1, binding.currency0);
        _assertRejected(binding);

        binding = _clone(base);
        binding.tickSpacing = 0;
        _assertRejected(binding);

        binding = _clone(base);
        binding.poolLpFee = 1;
        _assertRejected(binding);

        binding = _clone(base);
        binding.poolId = bytes32(uint256(base.poolId) ^ 1);
        _assertRejected(binding);

        for (uint160 bit = 0; bit < 14; ++bit) {
            binding = _clone(base);
            binding.hookPermissionMask = base.hookPermissionMask ^ (uint160(1) << bit);
            _assertRejected(binding);
        }

        binding = _clone(base);
        binding.hookSalt = bytes32(uint256(base.hookSalt) + 1);
        _assertRejected(binding);

        binding = _clone(base);
        binding.hookInitCodeHash = keccak256("WRONG_INITCODE");
        _assertRejected(binding);

        binding = _clone(base);
        binding.hookDeployer = address(0xD3E11);
        _assertRejected(binding);

        binding = _clone(base);
        binding.sourceSetDigest = bytes32(0);
        _assertRejected(binding);

        binding = _clone(base);
        binding.abiSetDigest = bytes32(0);
        _assertRejected(binding);

        binding = _clone(base);
        binding.runtimeSetDigest = bytes32(0);
        _assertRejected(binding);

        binding = _clone(base);
        binding.sourceSetDigest = keccak256("wrong sources");
        _assertRejected(binding);

        binding = _clone(base);
        binding.abiSetDigest = keccak256("wrong abis");
        _assertRejected(binding);

        binding = _clone(base);
        binding.runtimeSetDigest = keccak256("wrong runtimes");
        _assertRejected(binding);
    }

    function testBindingRejectsRevisionFeeAllocationAndDigestMismatch() external {
        RobinhoodBindings.Binding memory base = _validBinding();
        RobinhoodBindings.Binding memory binding = _clone(base);
        binding.chainId = 46630;
        _assertRejected(binding);

        binding = _clone(base);
        binding.requirementsRevision = 53;
        _assertRejected(binding);

        binding = _clone(base);
        binding.architectureRevision = 2;
        _assertRejected(binding);

        binding = _clone(base);
        binding.totalHookFeeBasisPoints = 301;
        _assertRejected(binding);

        binding = _clone(base);
        binding.programmableFeeBasisPoints = 11;
        _assertRejected(binding);

        binding = _clone(base);
        binding.treasuryFeeBasisPoints = 41;
        _assertRejected(binding);

        binding = _clone(base);
        binding.marketAllocationBasisPoints = 8_999;
        _assertRejected(binding);

        binding = _clone(base);
        binding.hookInitCodeHash = bytes32(0);
        _assertRejected(binding);
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        assembly ("memory-safe") { selector := mload(add(reason, 0x20)) }
    }

    function _assertOperationsWalletRejected(RobinhoodBindings.Binding memory binding) private {
        try new ImmutableLaunchBinding(binding) {
            assert(false);
        } catch (bytes memory reason) {
            assert(_selector(reason) == RobinhoodBindings.InvalidOperationsWallet.selector);
        }
    }

    function _assertRejected(RobinhoodBindings.Binding memory binding) internal {
        uint256 balanceBefore = address(this).balance;
        try new ImmutableLaunchBinding(binding) {
            assert(false);
        } catch { }
        assert(address(this).balance == balanceBefore);
    }

    function _clone(RobinhoodBindings.Binding memory binding)
        internal
        pure
        returns (RobinhoodBindings.Binding memory)
    {
        return abi.decode(abi.encode(binding), (RobinhoodBindings.Binding));
    }

    function _setIdentity(RobinhoodBindings.Binding memory binding, uint256 index, address value)
        internal
        pure
    {
        if (index == 0) binding.usdg = value;
        else if (index == 1) binding.hkmn = value;
        else if (index == 2) binding.poolManager = value;
        else if (index == 3) binding.positionManager = value;
        else if (index == 4) binding.launcher = value;
        else if (index == 5) binding.hook = value;
        else if (index == 6) binding.hookDeployer = value;
        else if (index == 7) binding.custody = value;
        else if (index == 8) binding.programmableBeneficiary = value;
        else if (index == 9) binding.treasury = value;
        else binding.operations = value;
    }

    function _validBinding() internal pure returns (RobinhoodBindings.Binding memory binding) {
        address deployer = address(0xD3E10);
        bytes32 initCodeHash = keccak256("HOOKEMON_R54_HOOK_INITCODE");
        bytes32 salt;
        address hook;
        for (uint256 candidate = 0; candidate < 100_000; ++candidate) {
            salt = bytes32(candidate);
            hook = address(
                uint160(
                    uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))
                )
            );
            if (uint160(hook) & ALL_HOOK_MASK == HOOK_MASK) break;
        }
        assert(uint160(hook) & ALL_HOOK_MASK == HOOK_MASK);

        address usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        address hkmn = address(0x1002);
        address currency0 = hkmn;
        address currency1 = usdg;
        int24 tickSpacing = 60;
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, uint24(0), tickSpacing, hook));

        binding = RobinhoodBindings.Binding({
            chainId: 4663,
            requirementsRevision: 54,
            architectureRevision: 3,
            usdg: usdg,
            hkmn: hkmn,
            poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
            positionManager: 0x58daec3116aae6D93017bAAea7749052E8a04fA7,
            launcher: 0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0,
            hook: hook,
            hookDeployer: deployer,
            hookSalt: salt,
            hookInitCodeHash: initCodeHash,
            custody: address(0x1007),
            programmableBeneficiary: RobinhoodBindings.PROGRAMMABLE_BENEFICIARY,
            treasury: address(0x1009),
            operations: 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384,
            expectedOperations: 0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384,
            currency0: currency0,
            currency1: currency1,
            tickSpacing: tickSpacing,
            poolId: poolId,
            poolLpFee: 0,
            totalHookFeeBasisPoints: 300,
            programmableFeeBasisPoints: 10,
            treasuryFeeBasisPoints: 40,
            marketAllocationBasisPoints: 9_000,
            hookPermissionMask: HOOK_MASK,
            sourceSetDigest: 0x35ffa674dfdbee0fceef1e64614b3291cd19c2f862fc9fb6c5a0dda7bc25b031,
            abiSetDigest: 0x19419411f02f975f7dc1c62dd948017119d882787c6f5525813f1a60fd8d864e,
            runtimeSetDigest: 0xa11752c21fc1d8c536e769a57ca10811ae310c5285bd1c84ed2068ec6545595e
        });
    }
}
