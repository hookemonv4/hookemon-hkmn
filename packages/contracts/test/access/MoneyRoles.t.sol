// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MoneyRoles } from "../../src/access/MoneyRoles.sol";
import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

contract MoneyRolesHarness is MoneyRoles {
    mapping(uint256 epoch => address beneficiary) public frozenTreasuryBeneficiary;
    mapping(uint256 epoch => uint256 claims) public treasuryClaims;
    uint256 public programmableClaims;
    uint256 public releases;
    mapping(bytes32 cycleId => uint256 fundingCalls) public fundingCalls;
    mapping(address recipient => uint256 payments) public holderPayments;

    constructor(address programmable, address treasury, address operations)
        MoneyRoles(programmable, treasury, operations)
    { }

    function freezeTreasuryBeneficiary(uint256 epoch) external {
        frozenTreasuryBeneficiary[epoch] = _currentTreasury();
    }

    function claimProgrammable(address storedBeneficiary, address destination) external {
        _authorizeProgrammableClaim(storedBeneficiary, destination);
        ++programmableClaims;
    }

    function claimTreasury(uint256 epoch, address destination) external {
        _authorizeTreasuryClaim(frozenTreasuryBeneficiary[epoch], destination);
        ++treasuryClaims[epoch];
    }

    function releaseCycle(bytes32 cycleId, address destination) external {
        _bindCycleOperations(cycleId, destination);
        ++releases;
    }

    function fundCycle(bytes32 cycleId, address payer) external {
        _authorizePayoutFunding(cycleId, payer);
        ++fundingCalls[cycleId];
    }

    function payHolder(address committedRecipient, address destination) external {
        _authorizeHolderPayment(committedRecipient, destination);
        ++holderPayments[committedRecipient];
    }
}

contract SelfRoleMoneyRoles is MoneyRoles {
    constructor(uint8 selfRole)
        MoneyRoles(
            selfRole == 0 ? address(this) : address(0x5000),
            selfRole == 1 ? address(this) : address(0x6000),
            selfRole == 2 ? address(this) : address(0x7000)
        )
    { }
}

contract RoleContractAccount {
    function proposeTreasury(MoneyRoles roles, address successor) external {
        roles.proposeTreasury(successor);
    }

    function acceptTreasury(MoneyRoles roles) external {
        roles.acceptTreasury();
    }

    function proposeOperations(MoneyRoles roles, address successor) external {
        roles.proposeOperations(successor);
    }

    function acceptOperations(MoneyRoles roles) external {
        roles.acceptOperations();
    }
}

contract InternalEscalationProbe {
    function claimProgrammable(MoneyRolesHarness roles, address beneficiary)
        external
        returns (bool accepted)
    {
        (accepted,) = address(roles)
            .call(abi.encodeCall(roles.claimProgrammable, (beneficiary, beneficiary)));
    }

    function releaseCycle(MoneyRolesHarness roles, bytes32 cycleId, address operations)
        external
        returns (bool accepted)
    {
        (accepted,) = address(roles).call(abi.encodeCall(roles.releaseCycle, (cycleId, operations)));
    }
}

abstract contract MoneyRolesAccountingCompositionProbe is FeeAccounting, MoneyRoles {
    constructor(address programmable, address treasury, address operations)
        FeeAccounting(programmable)
        MoneyRoles(programmable, treasury, operations)
    { }

    function _currentTreasuryBeneficiary() internal view override returns (address) {
        return _currentTreasury();
    }
}

contract MoneyRolesTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant PROGRAMMABLE = address(0x5000);
    address private constant TREASURY_ONE = address(0x6000);
    address private constant TREASURY_TWO = address(0x6001);
    address private constant TREASURY_THREE = address(0x6002);
    address private constant TREASURY_FOUR = address(0x6003);
    address private constant OPERATIONS_ONE = address(0x7000);
    address private constant OPERATIONS_TWO = address(0x7001);
    address private constant OPERATIONS_THREE = address(0x7002);
    address private constant OPERATIONS_FOUR = address(0x7003);
    address private constant UNRELATED = address(0xBAD1);
    address private constant HOLDER = address(0x8000);
    address private constant OTHER_HOLDER = address(0x8001);

    bytes32 private constant CYCLE_ONE = keccak256("cycle-one");
    bytes32 private constant CYCLE_TWO = keccak256("cycle-two");
    bytes32 private constant CYCLE_THREE = keccak256("cycle-three");
    bytes32 private constant CYCLE_FOUR = keccak256("cycle-four");

    MoneyRolesHarness private subject;

    function setUp() external {
        subject = new MoneyRolesHarness(PROGRAMMABLE, TREASURY_ONE, OPERATIONS_ONE);
    }

    function test_initializesExactRolesAndRejectsEveryZeroIdentity() external {
        (
            MoneyRoles.RoleState memory roles,
            MoneyRoles.PendingRoleTransfer memory treasuryTransfer,
            MoneyRoles.PendingRoleTransfer memory operationsTransfer,
            MoneyRoles.CycleBoundOperations memory cycle
        ) = subject.readRoles(CYCLE_ONE);

        assert(roles.programmableBeneficiary == PROGRAMMABLE);
        assert(roles.treasury == TREASURY_ONE);
        assert(roles.operations == OPERATIONS_ONE);
        assert(treasuryTransfer.role == keccak256("TREASURY"));
        assert(treasuryTransfer.currentAccount == TREASURY_ONE);
        assert(treasuryTransfer.proposedAccount == address(0));
        assert(operationsTransfer.role == keccak256("OPERATIONS"));
        assert(operationsTransfer.currentAccount == OPERATIONS_ONE);
        assert(operationsTransfer.proposedAccount == address(0));
        assert(cycle.cycleId == CYCLE_ONE);
        assert(cycle.operations == address(0));

        assert(!_canDeploy(address(0), TREASURY_ONE, OPERATIONS_ONE));
        assert(!_canDeploy(PROGRAMMABLE, address(0), OPERATIONS_ONE));
        assert(!_canDeploy(PROGRAMMABLE, TREASURY_ONE, address(0)));
        assert(!_canDeploySelfRole(0));
        assert(!_canDeploySelfRole(1));
        assert(!_canDeploySelfRole(2));
    }

    function test_treasuryProposalReplacementExactAcceptanceStaleAndReplay() external {
        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_TWO))));
        _assertCurrentRoles(TREASURY_ONE, TREASURY_TWO, OPERATIONS_ONE, address(0));

        assert(!_callAs(OPERATIONS_ONE, abi.encodeCall(subject.acceptTreasury, ())));
        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_THREE))));
        assert(!_callAs(TREASURY_TWO, abi.encodeCall(subject.acceptTreasury, ())));
        assert(_callAs(TREASURY_THREE, abi.encodeCall(subject.acceptTreasury, ())));
        assert(!_callAs(TREASURY_THREE, abi.encodeCall(subject.acceptTreasury, ())));
        assert(!_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_FOUR))));

        _assertCurrentRoles(TREASURY_THREE, address(0), OPERATIONS_ONE, address(0));
    }

    function test_handoverSupportsContractAccountsWithoutWalletAssumptions() external {
        RoleContractAccount treasurySuccessor = new RoleContractAccount();
        RoleContractAccount operationsSuccessor = new RoleContractAccount();

        assert(
            _callAs(
                TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (address(treasurySuccessor)))
            )
        );
        treasurySuccessor.acceptTreasury(subject);
        treasurySuccessor.proposeTreasury(subject, TREASURY_TWO);
        assert(_callAs(TREASURY_TWO, abi.encodeCall(subject.acceptTreasury, ())));

        assert(
            _callAs(
                OPERATIONS_ONE,
                abi.encodeCall(subject.proposeOperations, (address(operationsSuccessor)))
            )
        );
        operationsSuccessor.acceptOperations(subject);
        operationsSuccessor.proposeOperations(subject, OPERATIONS_TWO);
        assert(_callAs(OPERATIONS_TWO, abi.encodeCall(subject.acceptOperations, ())));

        _assertCurrentRoles(TREASURY_TWO, address(0), OPERATIONS_TWO, address(0));
    }

    function test_rolesMayOverlapWhenTheExactSuccessorAccepts() external {
        MoneyRolesHarness overlapping =
            new MoneyRolesHarness(PROGRAMMABLE, TREASURY_ONE, TREASURY_ONE);
        (MoneyRoles.RoleState memory initial,,,) = overlapping.readRoles(bytes32(0));
        assert(initial.treasury == TREASURY_ONE);
        assert(initial.operations == TREASURY_ONE);

        VM.prank(TREASURY_ONE);
        overlapping.proposeTreasury(OPERATIONS_ONE);
        VM.prank(OPERATIONS_ONE);
        overlapping.acceptTreasury();

        (MoneyRoles.RoleState memory accepted,,,) = overlapping.readRoles(bytes32(0));
        assert(accepted.treasury == OPERATIONS_ONE);
        assert(accepted.operations == TREASURY_ONE);
    }

    function test_operationsProposalReplacementExactAcceptanceStaleAndReplay() external {
        assert(_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_TWO))));
        assert(
            _callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_THREE)))
        );
        assert(!_callAs(OPERATIONS_TWO, abi.encodeCall(subject.acceptOperations, ())));
        assert(!_callAs(TREASURY_ONE, abi.encodeCall(subject.acceptOperations, ())));
        assert(_callAs(OPERATIONS_THREE, abi.encodeCall(subject.acceptOperations, ())));
        assert(!_callAs(OPERATIONS_THREE, abi.encodeCall(subject.acceptOperations, ())));
        assert(
            !_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_FOUR)))
        );

        _assertCurrentRoles(TREASURY_ONE, address(0), OPERATIONS_THREE, address(0));
    }

    function test_handoverRejectsZeroSelfCrossRoleAndThirdPartyCalls() external {
        assert(!_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (address(0)))));
        assert(!_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_ONE))));
        assert(!_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_TWO))));
        assert(!_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_TWO))));
        assert(!_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (address(0)))));
        assert(
            !_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_ONE)))
        );
        assert(!_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (address(subject)))));
        assert(
            !_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (address(subject))))
        );

        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_TWO))));
        assert(_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_TWO))));
        assert(!_callAs(UNRELATED, abi.encodeCall(subject.acceptTreasury, ())));
        assert(!_callAs(TREASURY_TWO, abi.encodeCall(subject.acceptOperations, ())));
        assert(!_callAs(OPERATIONS_TWO, abi.encodeCall(subject.acceptTreasury, ())));
        assert(!_callAs(address(0), abi.encodeCall(subject.acceptOperations, ())));

        _assertCurrentRoles(TREASURY_ONE, TREASURY_TWO, OPERATIONS_ONE, OPERATIONS_TWO);
    }

    function test_handoverEventsBindRoleOldAndNewAccounts() external {
        VM.recordLogs();
        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.proposeTreasury, (TREASURY_TWO))));
        assert(_callAs(TREASURY_TWO, abi.encodeCall(subject.acceptTreasury, ())));
        assert(_callAs(OPERATIONS_ONE, abi.encodeCall(subject.proposeOperations, (OPERATIONS_TWO))));
        assert(_callAs(OPERATIONS_TWO, abi.encodeCall(subject.acceptOperations, ())));
        Vm.Log[] memory logs = VM.getRecordedLogs();

        assert(logs.length == 4);
        _assertRoleLog(
            logs[0],
            keccak256("RoleProposed(bytes32,address,address)"),
            keccak256("TREASURY"),
            TREASURY_ONE,
            TREASURY_TWO
        );
        _assertRoleLog(
            logs[1],
            keccak256("RoleAccepted(bytes32,address,address)"),
            keccak256("TREASURY"),
            TREASURY_ONE,
            TREASURY_TWO
        );
        _assertRoleLog(
            logs[2],
            keccak256("RoleProposed(bytes32,address,address)"),
            keccak256("OPERATIONS"),
            OPERATIONS_ONE,
            OPERATIONS_TWO
        );
        _assertRoleLog(
            logs[3],
            keccak256("RoleAccepted(bytes32,address,address)"),
            keccak256("OPERATIONS"),
            OPERATIONS_ONE,
            OPERATIONS_TWO
        );
    }

    function test_exhaustiveCallerMatrixAllowsBeneficiaryDestinationsAndRejectsWrongCallers()
        external
    {
        subject.freezeTreasuryBeneficiary(1);

        assert(
            _callAs(
                PROGRAMMABLE,
                abi.encodeCall(subject.claimProgrammable, (PROGRAMMABLE, PROGRAMMABLE))
            )
        );
        assert(
            !_callAs(
                TREASURY_ONE,
                abi.encodeCall(subject.claimProgrammable, (PROGRAMMABLE, PROGRAMMABLE))
            )
        );
        assert(
            _callAs(
                PROGRAMMABLE, abi.encodeCall(subject.claimProgrammable, (PROGRAMMABLE, UNRELATED))
            )
        );
        assert(
            !_callAs(
                address(0), abi.encodeCall(subject.claimProgrammable, (PROGRAMMABLE, PROGRAMMABLE))
            )
        );

        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.claimTreasury, (1, TREASURY_ONE))));
        assert(!_callAs(PROGRAMMABLE, abi.encodeCall(subject.claimTreasury, (1, TREASURY_ONE))));
        assert(!_callAs(OPERATIONS_ONE, abi.encodeCall(subject.claimTreasury, (1, TREASURY_ONE))));
        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.claimTreasury, (1, UNRELATED))));
        assert(!_callAs(address(0), abi.encodeCall(subject.claimTreasury, (1, address(0)))));

        assert(
            _callAs(
                OPERATIONS_ONE, abi.encodeCall(subject.releaseCycle, (CYCLE_ONE, OPERATIONS_ONE))
            )
        );
        assert(
            !_callAs(
                TREASURY_ONE, abi.encodeCall(subject.releaseCycle, (CYCLE_TWO, OPERATIONS_ONE))
            )
        );
        assert(
            !_callAs(OPERATIONS_ONE, abi.encodeCall(subject.releaseCycle, (CYCLE_TWO, UNRELATED)))
        );
        assert(!_callAs(address(0), abi.encodeCall(subject.releaseCycle, (CYCLE_TWO, address(0)))));
        assert(
            !_callAs(
                OPERATIONS_ONE, abi.encodeCall(subject.releaseCycle, (bytes32(0), OPERATIONS_ONE))
            )
        );

        assert(
            _callAs(OPERATIONS_ONE, abi.encodeCall(subject.fundCycle, (CYCLE_ONE, OPERATIONS_ONE)))
        );
        assert(
            !_callAs(TREASURY_ONE, abi.encodeCall(subject.fundCycle, (CYCLE_ONE, OPERATIONS_ONE)))
        );
        assert(
            !_callAs(OPERATIONS_ONE, abi.encodeCall(subject.fundCycle, (CYCLE_ONE, OPERATIONS_TWO)))
        );
        assert(
            !_callAs(OPERATIONS_ONE, abi.encodeCall(subject.fundCycle, (CYCLE_TWO, OPERATIONS_ONE)))
        );

        assert(_callAs(UNRELATED, abi.encodeCall(subject.payHolder, (HOLDER, HOLDER))));
        assert(_callAs(PROGRAMMABLE, abi.encodeCall(subject.payHolder, (HOLDER, HOLDER))));
        assert(!_callAs(UNRELATED, abi.encodeCall(subject.payHolder, (HOLDER, OTHER_HOLDER))));
        assert(!_callAs(UNRELATED, abi.encodeCall(subject.payHolder, (address(0), address(0)))));

        assert(subject.programmableClaims() == 2);
        assert(subject.treasuryClaims(1) == 2);
        assert(subject.releases() == 1);
        assert(subject.fundingCalls(CYCLE_ONE) == 1);
        assert(subject.holderPayments(HOLDER) == 2);
    }

    function test_internalCallersCannotEscalateIntoMoneyPaths() external {
        InternalEscalationProbe probe = new InternalEscalationProbe();

        assert(!probe.claimProgrammable(subject, PROGRAMMABLE));
        assert(!probe.releaseCycle(subject, CYCLE_ONE, OPERATIONS_ONE));
        assert(subject.programmableClaims() == 0);
        assert(subject.releases() == 0);
    }

    function test_threeHandoversPreserveHistoricalBeneficiariesAndCycleOperations() external {
        subject.freezeTreasuryBeneficiary(1);
        assert(
            _callAs(
                OPERATIONS_ONE, abi.encodeCall(subject.releaseCycle, (CYCLE_ONE, OPERATIONS_ONE))
            )
        );

        _rotateTreasury(TREASURY_ONE, TREASURY_TWO);
        _rotateOperations(OPERATIONS_ONE, OPERATIONS_TWO);
        subject.freezeTreasuryBeneficiary(2);
        assert(
            _callAs(
                OPERATIONS_TWO, abi.encodeCall(subject.releaseCycle, (CYCLE_TWO, OPERATIONS_TWO))
            )
        );

        _rotateTreasury(TREASURY_TWO, TREASURY_THREE);
        _rotateOperations(OPERATIONS_TWO, OPERATIONS_THREE);
        subject.freezeTreasuryBeneficiary(3);
        assert(
            _callAs(
                OPERATIONS_THREE,
                abi.encodeCall(subject.releaseCycle, (CYCLE_THREE, OPERATIONS_THREE))
            )
        );

        _rotateTreasury(TREASURY_THREE, TREASURY_FOUR);
        _rotateOperations(OPERATIONS_THREE, OPERATIONS_FOUR);
        subject.freezeTreasuryBeneficiary(4);
        assert(
            _callAs(
                OPERATIONS_FOUR, abi.encodeCall(subject.releaseCycle, (CYCLE_FOUR, OPERATIONS_FOUR))
            )
        );

        assert(subject.frozenTreasuryBeneficiary(1) == TREASURY_ONE);
        assert(subject.frozenTreasuryBeneficiary(2) == TREASURY_TWO);
        assert(subject.frozenTreasuryBeneficiary(3) == TREASURY_THREE);
        assert(subject.frozenTreasuryBeneficiary(4) == TREASURY_FOUR);
        assert(_cycleOperations(CYCLE_ONE) == OPERATIONS_ONE);
        assert(_cycleOperations(CYCLE_TWO) == OPERATIONS_TWO);
        assert(_cycleOperations(CYCLE_THREE) == OPERATIONS_THREE);
        assert(_cycleOperations(CYCLE_FOUR) == OPERATIONS_FOUR);
        assert(
            _callAs(
                PROGRAMMABLE,
                abi.encodeCall(subject.claimProgrammable, (PROGRAMMABLE, PROGRAMMABLE))
            )
        );

        assert(_callAs(TREASURY_ONE, abi.encodeCall(subject.claimTreasury, (1, TREASURY_ONE))));
        assert(_callAs(TREASURY_TWO, abi.encodeCall(subject.claimTreasury, (2, TREASURY_TWO))));
        assert(_callAs(TREASURY_THREE, abi.encodeCall(subject.claimTreasury, (3, TREASURY_THREE))));
        assert(_callAs(TREASURY_FOUR, abi.encodeCall(subject.claimTreasury, (4, TREASURY_FOUR))));
        assert(
            _callAs(OPERATIONS_ONE, abi.encodeCall(subject.fundCycle, (CYCLE_ONE, OPERATIONS_ONE)))
        );
        assert(
            _callAs(OPERATIONS_TWO, abi.encodeCall(subject.fundCycle, (CYCLE_TWO, OPERATIONS_TWO)))
        );
        assert(
            _callAs(
                OPERATIONS_THREE, abi.encodeCall(subject.fundCycle, (CYCLE_THREE, OPERATIONS_THREE))
            )
        );
        assert(
            _callAs(
                OPERATIONS_FOUR, abi.encodeCall(subject.fundCycle, (CYCLE_FOUR, OPERATIONS_FOUR))
            )
        );

        assert(
            !_callAs(
                OPERATIONS_FOUR, abi.encodeCall(subject.fundCycle, (CYCLE_ONE, OPERATIONS_FOUR))
            )
        );
        assert(
            !_callAs(
                OPERATIONS_ONE,
                abi.encodeCall(subject.releaseCycle, (keccak256("former"), OPERATIONS_ONE))
            )
        );
        assert(
            !_callAs(
                OPERATIONS_FOUR, abi.encodeCall(subject.releaseCycle, (CYCLE_ONE, OPERATIONS_FOUR))
            )
        );
        assert(_cycleOperations(CYCLE_ONE) == OPERATIONS_ONE);
    }

    function test_productionSurfaceHasNoGenericAuthoritySelectors() external view {
        bytes memory runtime = address(subject).code;
        bytes4[5] memory expected = [
            MoneyRoles.proposeTreasury.selector,
            MoneyRoles.acceptTreasury.selector,
            MoneyRoles.proposeOperations.selector,
            MoneyRoles.acceptOperations.selector,
            MoneyRoles.readRoles.selector
        ];
        bytes4[14] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("admin()")),
            bytes4(keccak256("automation()")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("unpause()")),
            bytes4(keccak256("paused()")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("setFee(uint256)")),
            bytes4(keccak256("rescue(address,uint256)")),
            bytes4(keccak256("cancelTreasury()")),
            bytes4(keccak256("cancelOperations()")),
            bytes4(keccak256("bindCycleOperations(bytes32,address)")),
            bytes4(keccak256("authorizePayoutFunding(bytes32,address)"))
        ];

        for (uint256 index; index < expected.length; ++index) {
            assert(_containsSelector(runtime, expected[index]));
        }
        for (uint256 index; index < forbidden.length; ++index) {
            assert(!_containsSelector(runtime, forbidden[index]));
        }
    }

    function _rotateTreasury(address current, address successor) private {
        assert(_callAs(current, abi.encodeCall(subject.proposeTreasury, (successor))));
        assert(_callAs(successor, abi.encodeCall(subject.acceptTreasury, ())));
    }

    function _rotateOperations(address current, address successor) private {
        assert(_callAs(current, abi.encodeCall(subject.proposeOperations, (successor))));
        assert(_callAs(successor, abi.encodeCall(subject.acceptOperations, ())));
    }

    function _cycleOperations(bytes32 cycleId) private view returns (address operations) {
        (,,, MoneyRoles.CycleBoundOperations memory cycle) = subject.readRoles(cycleId);
        return cycle.operations;
    }

    function _assertCurrentRoles(
        address treasury,
        address proposedTreasury,
        address operations,
        address proposedOperations
    ) private view {
        (
            MoneyRoles.RoleState memory roles,
            MoneyRoles.PendingRoleTransfer memory treasuryTransfer,
            MoneyRoles.PendingRoleTransfer memory operationsTransfer,
        ) = subject.readRoles(bytes32(0));
        assert(roles.programmableBeneficiary == PROGRAMMABLE);
        assert(roles.treasury == treasury);
        assert(roles.operations == operations);
        assert(treasuryTransfer.role == keccak256("TREASURY"));
        assert(treasuryTransfer.currentAccount == treasury);
        assert(treasuryTransfer.proposedAccount == proposedTreasury);
        assert(operationsTransfer.role == keccak256("OPERATIONS"));
        assert(operationsTransfer.currentAccount == operations);
        assert(operationsTransfer.proposedAccount == proposedOperations);
    }

    function _assertRoleLog(
        Vm.Log memory entry,
        bytes32 signature,
        bytes32 role,
        address previousAccount,
        address currentAccount
    ) private view {
        assert(entry.emitter == address(subject));
        assert(entry.data.length == 0);
        assert(entry.topics.length == 4);
        assert(entry.topics[0] == signature);
        assert(entry.topics[1] == role);
        assert(entry.topics[2] == bytes32(uint256(uint160(previousAccount))));
        assert(entry.topics[3] == bytes32(uint256(uint160(currentAccount))));
    }

    function _callAs(address caller, bytes memory data) private returns (bool accepted) {
        VM.prank(caller);
        (accepted,) = address(subject).call(data);
    }

    function _containsSelector(bytes memory runtime, bytes4 selector) private pure returns (bool) {
        if (runtime.length < 5) return false;
        for (uint256 offset; offset <= runtime.length - 5; ++offset) {
            if (runtime[offset] != bytes1(0x63)) continue;
            bytes4 candidate;
            assembly ("memory-safe") {
                candidate := mload(add(add(runtime, 0x21), offset))
            }
            if (candidate == selector) return true;
        }
        return false;
    }

    function _canDeploy(address programmable, address treasury, address operations)
        private
        returns (bool deployed)
    {
        try new MoneyRolesHarness(programmable, treasury, operations) returns (
            MoneyRolesHarness created
        ) {
            return address(created) != address(0);
        } catch {
            return false;
        }
    }

    function _canDeploySelfRole(uint8 selfRole) private returns (bool deployed) {
        try new SelfRoleMoneyRoles(selfRole) returns (SelfRoleMoneyRoles created) {
            return address(created) != address(0);
        } catch {
            return false;
        }
    }
}
