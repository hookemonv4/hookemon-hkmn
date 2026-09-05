// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal thin-V1 money authority shared by the immutable hook capabilities.
abstract contract MoneyRoles {
    struct RoleState {
        address programmableBeneficiary;
        address treasury;
        address operations;
    }

    struct PendingRoleTransfer {
        bytes32 role;
        address currentAccount;
        address proposedAccount;
    }

    struct CycleBoundOperations {
        bytes32 cycleId;
        address operations;
    }

    bytes32 private constant TREASURY_ROLE = keccak256("TREASURY");
    bytes32 private constant OPERATIONS_ROLE = keccak256("OPERATIONS");

    address private immutable _programmable;
    address private _treasury;
    address private _proposedTreasury;
    address private _operations;
    address private _proposedOperations;
    mapping(address beneficiary => bool) private _treasuryBeneficiaries;
    mapping(bytes32 cycleId => address operations) private _cycleOperations;

    error InvalidInitialRole();
    error UnauthorizedCaller();
    error InvalidSuccessor();
    error InvalidRoleBeneficiary();
    error InvalidDestination();
    error InvalidCycle();
    error CycleAlreadyBound();

    event RoleProposed(
        bytes32 indexed role, address indexed currentAccount, address indexed proposedAccount
    );
    event RoleAccepted(
        bytes32 indexed role, address indexed previousAccount, address indexed currentAccount
    );

    constructor(address programmable, address treasury, address operations) {
        if (
            programmable == address(0) || treasury == address(0) || operations == address(0)
                || programmable == address(this) || treasury == address(this)
                || operations == address(this)
        ) {
            revert InvalidInitialRole();
        }
        _programmable = programmable;
        _treasury = treasury;
        _operations = operations;
        _treasuryBeneficiaries[treasury] = true;
    }

    function proposeTreasury(address successor) external {
        if (msg.sender != _treasury) revert UnauthorizedCaller();
        _validateRoleSuccessor(successor, _treasury);
        _proposedTreasury = successor;
        emit RoleProposed(TREASURY_ROLE, _treasury, successor);
    }

    function acceptTreasury() external {
        address successor = _proposedTreasury;
        if (successor == address(0) || msg.sender != successor) revert UnauthorizedCaller();
        address previous = _treasury;
        _treasury = successor;
        _treasuryBeneficiaries[successor] = true;
        delete _proposedTreasury;
        emit RoleAccepted(TREASURY_ROLE, previous, successor);
    }

    function proposeOperations(address successor) external {
        _requireOperationsHandoverAvailable();
        if (msg.sender != _operations) revert UnauthorizedCaller();
        _validateRoleSuccessor(successor, _operations);
        _validateOperationsSuccessor(successor);
        _proposedOperations = successor;
        emit RoleProposed(OPERATIONS_ROLE, _operations, successor);
    }

    function acceptOperations() external {
        _requireOperationsHandoverAvailable();
        address successor = _proposedOperations;
        if (successor == address(0) || msg.sender != successor) revert UnauthorizedCaller();
        address previous = _operations;
        _operations = successor;
        delete _proposedOperations;
        emit RoleAccepted(OPERATIONS_ROLE, previous, successor);
    }

    function readRoles(bytes32 cycleId)
        external
        view
        returns (
            RoleState memory roles,
            PendingRoleTransfer memory treasuryTransfer,
            PendingRoleTransfer memory operationsTransfer,
            CycleBoundOperations memory cycle
        )
    {
        roles = RoleState({
            programmableBeneficiary: _programmable, treasury: _treasury, operations: _operations
        });
        treasuryTransfer = PendingRoleTransfer({
            role: TREASURY_ROLE, currentAccount: _treasury, proposedAccount: _proposedTreasury
        });
        operationsTransfer = PendingRoleTransfer({
            role: OPERATIONS_ROLE, currentAccount: _operations, proposedAccount: _proposedOperations
        });
        cycle = CycleBoundOperations({ cycleId: cycleId, operations: _cycleOperations[cycleId] });
    }

    function _currentTreasury() internal view returns (address) {
        return _treasury;
    }

    function _currentOperations() internal view returns (address) {
        return _operations;
    }

    function _authorizeTreasuryControl() internal view {
        if (msg.sender != _treasury) revert UnauthorizedCaller();
    }

    function _authorizeProcessClaim(address destination) internal view {
        if (msg.sender != _operations) revert UnauthorizedCaller();
        if (destination != msg.sender) revert InvalidDestination();
    }

    function _requireOperationsHandoverAvailable() internal view virtual { }

    function _clearProposedOperations() internal {
        delete _proposedOperations;
    }

    function _replaceOperationsForEmergencyRotation(address successor)
        internal
        returns (address previous)
    {
        _validateRoleSuccessor(successor, _operations);
        _validateOperationsSuccessor(successor);
        previous = _operations;
        _operations = successor;
        _clearProposedOperations();
    }

    function _validateRoleSuccessor(address successor, address currentAccount)
        internal
        view
        virtual
    {
        if (successor == address(0) || successor == currentAccount || successor == address(this)) {
            revert InvalidSuccessor();
        }
    }

    function _validateOperationsSuccessor(address) internal view virtual { }

    function _authorizeProgrammableClaim(address storedBeneficiary, address destination)
        internal
        view
    {
        if (storedBeneficiary != _programmable) revert InvalidRoleBeneficiary();
        if (msg.sender != storedBeneficiary) revert UnauthorizedCaller();
        if (destination == address(0)) revert InvalidDestination();
    }

    function _authorizeTreasuryClaim(address storedBeneficiary, address destination) internal view {
        if (storedBeneficiary == address(0) || !_treasuryBeneficiaries[storedBeneficiary]) {
            revert InvalidRoleBeneficiary();
        }
        if (msg.sender != storedBeneficiary) revert UnauthorizedCaller();
        if (destination == address(0)) revert InvalidDestination();
    }

    function _bindCycleOperationsTrigger(bytes32 cycleId, address trigger)
        internal
        returns (address boundOperations)
    {
        if (msg.sender != _operations) revert UnauthorizedCaller();
        if (trigger != _operations) revert InvalidDestination();
        if (cycleId == bytes32(0)) revert InvalidCycle();
        if (_cycleOperations[cycleId] != address(0)) revert CycleAlreadyBound();
        boundOperations = _operations;
        _cycleOperations[cycleId] = boundOperations;
    }

    function _bindCycleOperations(bytes32 cycleId, address trigger)
        internal
        returns (address boundOperations)
    {
        return _bindCycleOperationsTrigger(cycleId, trigger);
    }

    function _authorizePayoutFunding(bytes32 cycleId, address payer) internal view {
        address boundOperations = _cycleOperations[cycleId];
        if (boundOperations == address(0)) revert InvalidCycle();
        if (msg.sender != boundOperations) revert UnauthorizedCaller();
        if (payer != boundOperations) revert InvalidDestination();
    }

    function _authorizeHolderPayment(address committedRecipient, address destination)
        internal
        pure
    {
        if (committedRecipient == address(0)) revert InvalidRoleBeneficiary();
        if (destination != committedRecipient) revert InvalidDestination();
    }
}
