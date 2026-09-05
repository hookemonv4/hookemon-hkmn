// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Internal USDG liability ledger for one canonical Hookemon custody address.
/// @dev The final external ABI and USDG adapter remain integration-pending. Inheritors must expose
///      only frozen entry points and implement token calls that fail closed on malformed returns.
abstract contract FeeAccounting {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant TOTAL_FEE_BPS = 300;
    uint256 internal constant PROGRAMMABLE_FEE_BPS = 10;
    uint256 internal constant TREASURY_FEE_BPS = 40;
    uint256 internal constant PROCESS_FEE_BPS =
        TOTAL_FEE_BPS - PROGRAMMABLE_FEE_BPS - TREASURY_FEE_BPS;
    /// @dev programmable-fee-policy.md v1.1.0: "A positive gross quote amount below 1,000
    ///      smallest quote-asset units must revert atomically in the standard profile."
    uint256 internal constant MINIMUM_EXECUTED_USDG = 1_000;

    address private immutable fixedProgrammableBeneficiary;
    mapping(address beneficiary => uint256 amount) private programmableLiabilities;
    mapping(address beneficiary => uint256 amount) private treasuryLiabilities;
    mapping(bytes32 payoutId => uint256 amount) private payoutLiabilities;
    uint256 private processLiabilityAmount;
    uint256 private totalPayoutLiabilityAmount;
    uint256 private totalLiabilityAmount;
    bool private moneyPathEntered;
    /// @dev Cumulative fractional-numerator remainders (each always < BPS_DENOMINATOR) for the
    ///      Programmable, treasury, and process streams. They persist for the canonical pool's
    ///      lifetime and claims never reset them, so fragmenting gross quote volume cannot change
    ///      the lifetime allocation for any owner-approved stream.
    uint256 private programmableRemainder;
    uint256 private treasuryRemainder;
    uint256 private processRemainder;

    /// @dev The three remainder values are this swap's post-commit cumulative state, so an
    ///      off-chain observer can reconcile each stream without a second read.
    event SwapLiabilitiesAccrued(
        uint256 executedUsdg,
        uint256 totalFee,
        address indexed programmableBeneficiary,
        uint256 programmableFee,
        address indexed treasuryBeneficiary,
        uint256 treasuryFee,
        uint256 processFee,
        uint256 programmableRemainderAfter,
        uint256 treasuryRemainderAfter,
        uint256 processRemainderAfter
    );

    /// @dev Emitted whenever the Programmable/treasury beneficiary drains its accrued liability
    ///      (`_claimLiability`, `programmable-fee-policy.md`) so the dashboard's status page can
    ///      index claims without polling `readFeeLiabilities`.
    event ProgrammableClaimed(address indexed destination, uint256 amount);
    event TreasuryClaimed(address indexed destination, uint256 amount);

    error InvalidBeneficiary();
    error InvalidCollectionDelta();
    error InvalidLiabilityAmount();
    error MoneyPathReentrancy();
    error TokenTransferFailed();
    error TokenBalanceDeltaMismatch();
    error InsolventAccounting();
    error SwapBelowMinimumQuote();

    modifier moneyPath() {
        if (moneyPathEntered) revert MoneyPathReentrancy();
        moneyPathEntered = true;
        _;
        moneyPathEntered = false;
    }

    constructor(address programmableBeneficiary) {
        if (programmableBeneficiary == address(0) || programmableBeneficiary == address(this)) {
            revert InvalidBeneficiary();
        }
        fixedProgrammableBeneficiary = programmableBeneficiary;
    }

    /// @dev Called only after P1-002 authenticates finalized executed USDG and collects its fee.
    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        virtual
    {
        _requireEnteredMoneyPath();
        address treasuryBeneficiary = _currentTreasuryBeneficiary();
        if (treasuryBeneficiary == address(0) || treasuryBeneficiary == address(this)) {
            revert InvalidBeneficiary();
        }

        uint256 balanceAfterCollection = _usdgBalanceOf(address(this));
        (uint256 totalFee, uint256 programmableFee, uint256 treasuryFee, uint256 processFee) =
            _splitLiability(executedUsdg);
        if (
            balanceBeforeCollection < totalLiabilityAmount
                || balanceAfterCollection < balanceBeforeCollection
                || balanceAfterCollection - balanceBeforeCollection != totalFee
        ) {
            revert InvalidCollectionDelta();
        }

        programmableLiabilities[fixedProgrammableBeneficiary] += programmableFee;
        treasuryLiabilities[treasuryBeneficiary] += treasuryFee;
        processLiabilityAmount += processFee;
        totalLiabilityAmount += totalFee;
        _requireSolventAt(balanceAfterCollection);
        emit SwapLiabilitiesAccrued(
            executedUsdg,
            totalFee,
            fixedProgrammableBeneficiary,
            programmableFee,
            treasuryBeneficiary,
            treasuryFee,
            processFee,
            programmableRemainder,
            treasuryRemainder,
            processRemainder
        );
    }

    function _claimProgrammableLiability() internal returns (uint256 amount) {
        return _claimProgrammableLiability(msg.sender);
    }

    function _claimTreasuryLiability() internal returns (uint256 amount) {
        return _claimTreasuryLiability(msg.sender);
    }

    function _claimProgrammableLiability(address destination) internal returns (uint256 amount) {
        amount = _claimLiability(
            programmableLiabilities, msg.sender, destination, programmableLiabilities[msg.sender]
        );
        emit ProgrammableClaimed(destination, amount);
    }

    function _claimTreasuryLiability(address destination) internal returns (uint256 amount) {
        amount = _claimLiability(
            treasuryLiabilities, msg.sender, destination, treasuryLiabilities[msg.sender]
        );
        emit TreasuryClaimed(destination, amount);
    }

    function _claimProgrammableLiability(uint256 requestedAmount, address destination)
        internal
        returns (uint256 amount)
    {
        amount = _claimLiability(programmableLiabilities, msg.sender, destination, requestedAmount);
        emit ProgrammableClaimed(destination, amount);
    }

    function _claimTreasuryLiability(uint256 requestedAmount, address destination)
        internal
        returns (uint256 amount)
    {
        amount = _claimLiability(treasuryLiabilities, msg.sender, destination, requestedAmount);
        emit TreasuryClaimed(destination, amount);
    }

    function _claimLiability(
        mapping(address beneficiary => uint256 amount) storage liabilities,
        address beneficiary,
        address destination,
        uint256 requestedAmount
    ) private moneyPath returns (uint256 amount) {
        if (
            beneficiary == address(0) || beneficiary == address(this) || destination == address(0)
                || destination == address(this)
        ) {
            revert InvalidBeneficiary();
        }

        amount = requestedAmount;
        if (amount == 0 || amount > liabilities[beneficiary]) revert InvalidLiabilityAmount();

        _requireSolvent();

        liabilities[beneficiary] -= amount;
        totalLiabilityAmount -= amount;
        _transferExactUsdg(destination, amount);
        _requireSolvent();
    }

    /// @dev Bounded ledger primitives. The final role-gated money path must hold this component's
    ///      lock around the complete token transfer or same-custody reclassification.
    function _debitProcessLiability(uint256 amount) internal {
        _requireEnteredMoneyPath();
        _requireSolvent();
        if (amount == 0 || amount > processLiabilityAmount) revert InvalidLiabilityAmount();
        processLiabilityAmount -= amount;
        totalLiabilityAmount -= amount;
    }

    function _claimProcessLiability(uint256 amount, address destination)
        internal
        moneyPath
        returns (uint256 claimed)
    {
        _debitProcessLiability(amount);
        _transferExactUsdg(destination, amount);
        _requireSolvent();
        return amount;
    }

    function _creditPayoutLiability(bytes32 payoutId, uint256 amount) internal {
        _requireEnteredMoneyPath();
        if (payoutId == bytes32(0) || amount == 0) revert InvalidLiabilityAmount();
        payoutLiabilities[payoutId] += amount;
        totalPayoutLiabilityAmount += amount;
        totalLiabilityAmount += amount;
        _requireSolvent();
    }

    function _debitPayoutLiability(bytes32 payoutId, uint256 amount) internal {
        _requireEnteredMoneyPath();
        _requireSolvent();
        if (payoutId == bytes32(0) || amount == 0 || amount > payoutLiabilities[payoutId]) {
            revert InvalidLiabilityAmount();
        }
        payoutLiabilities[payoutId] -= amount;
        totalPayoutLiabilityAmount -= amount;
        totalLiabilityAmount -= amount;
    }

    function _transferExactUsdg(address recipient, uint256 amount) internal {
        _requireEnteredMoneyPath();
        if (recipient == address(0) || recipient == address(this) || amount == 0) {
            revert InvalidBeneficiary();
        }

        uint256 sourceBalanceBefore = _usdgBalanceOf(address(this));
        uint256 destinationBalanceBefore = _usdgBalanceOf(recipient);
        if (!_transferUsdg(recipient, amount)) revert TokenTransferFailed();

        uint256 sourceBalanceAfter = _usdgBalanceOf(address(this));
        uint256 destinationBalanceAfter = _usdgBalanceOf(recipient);
        if (
            sourceBalanceAfter > sourceBalanceBefore
                || sourceBalanceBefore - sourceBalanceAfter != amount
                || destinationBalanceAfter < destinationBalanceBefore
                || destinationBalanceAfter - destinationBalanceBefore != amount
        ) {
            revert TokenBalanceDeltaMismatch();
        }
    }

    /// @dev Commits one swap's cumulative-remainder increment. Must be called at most once per
    ///      authenticated swap (from `_accrueAuthenticatedSwap`): it persists the new remainder
    ///      state, so calling it twice for the same swap would double-draw the carried dust.
    ///      Callers that need to know the fee before committing (to size a token collection) must
    ///      use `_previewTotalFee` first and pass the same `executedUsdg` here.
    function _splitLiability(uint256 executedUsdg)
        internal
        returns (uint256 totalFee, uint256 programmableFee, uint256 treasuryFee, uint256 processFee)
    {
        _requireMinimumExecutedUsdg(executedUsdg);
        (programmableFee, programmableRemainder) =
            _cumulativeIncrement(executedUsdg, PROGRAMMABLE_FEE_BPS, programmableRemainder);
        (treasuryFee, treasuryRemainder) =
            _cumulativeIncrement(executedUsdg, TREASURY_FEE_BPS, treasuryRemainder);
        (processFee, processRemainder) =
            _cumulativeIncrement(executedUsdg, PROCESS_FEE_BPS, processRemainder);
        totalFee = programmableFee + treasuryFee + processFee;
    }

    /// @dev Side-effect-free preview of what `_splitLiability(executedUsdg)` would return if
    ///      called right now. Safe to call multiple times (e.g. once in `beforeSwap` to size the
    ///      delta, once in `afterSwap` to validate it) as long as nothing commits a mutation to
    ///      the remainder state in between within the same transaction.
    function _previewTotalFee(uint256 executedUsdg)
        internal
        view
        virtual
        returns (uint256 totalFee)
    {
        _requireMinimumExecutedUsdg(executedUsdg);
        (uint256 programmableFee,) =
            _cumulativeIncrement(executedUsdg, PROGRAMMABLE_FEE_BPS, programmableRemainder);
        (uint256 treasuryFee,) =
            _cumulativeIncrement(executedUsdg, TREASURY_FEE_BPS, treasuryRemainder);
        (uint256 processFee,) =
            _cumulativeIncrement(executedUsdg, PROCESS_FEE_BPS, processRemainder);
        totalFee = programmableFee + treasuryFee + processFee;
    }

    function _programmableRemainder() internal view returns (uint256) {
        return programmableRemainder;
    }

    function _treasuryRemainder() internal view returns (uint256) {
        return treasuryRemainder;
    }

    function _processRemainder() internal view returns (uint256) {
        return processRemainder;
    }

    /// @dev floor((remainderBefore + executedUsdg * rateBps) / BPS_DENOMINATOR), decomposed to
    ///      avoid overflowing `executedUsdg * rateBps` for large executedUsdg, together with the
    ///      new remainder = (remainderBefore + executedUsdg * rateBps) % BPS_DENOMINATOR.
    ///      `remainderBefore` must already be < BPS_DENOMINATOR; the result preserves that
    ///      invariant for `remainderAfter`.
    function _cumulativeIncrement(uint256 executedUsdg, uint256 rateBps, uint256 remainderBefore)
        private
        pure
        returns (uint256 increment, uint256 remainderAfter)
    {
        uint256 highPart = executedUsdg / BPS_DENOMINATOR * rateBps;
        uint256 lowPart = executedUsdg % BPS_DENOMINATOR * rateBps + remainderBefore;
        increment = highPart + lowPart / BPS_DENOMINATOR;
        remainderAfter = lowPart % BPS_DENOMINATOR;
    }

    function _requireMinimumExecutedUsdg(uint256 executedUsdg) private pure {
        if (executedUsdg != 0 && executedUsdg < MINIMUM_EXECUTED_USDG) {
            revert SwapBelowMinimumQuote();
        }
    }

    function _programmableLiabilityOf(address beneficiary) internal view returns (uint256) {
        return programmableLiabilities[beneficiary];
    }

    function _fixedProgrammableBeneficiary() internal view returns (address) {
        return fixedProgrammableBeneficiary;
    }

    function _treasuryLiabilityOf(address beneficiary) internal view returns (uint256) {
        return treasuryLiabilities[beneficiary];
    }

    function _payoutLiabilityOf(bytes32 payoutId) internal view returns (uint256) {
        return payoutLiabilities[payoutId];
    }

    function _processLiability() internal view returns (uint256) {
        return processLiabilityAmount;
    }

    function _totalPayoutLiability() internal view returns (uint256) {
        return totalPayoutLiabilityAmount;
    }

    function _totalLiability() internal view returns (uint256) {
        return totalLiabilityAmount;
    }

    function _hookUsdgBalance() internal view returns (uint256) {
        return _usdgBalanceOf(address(this));
    }

    function _isSolvent() internal view returns (bool) {
        return _hookUsdgBalance() >= totalLiabilityAmount;
    }

    function _solvencyMargin() internal view returns (uint256) {
        uint256 balance = _hookUsdgBalance();
        if (balance < totalLiabilityAmount) revert InsolventAccounting();
        return balance - totalLiabilityAmount;
    }

    function _requireEnteredMoneyPath() private view {
        if (!moneyPathEntered) revert MoneyPathReentrancy();
    }

    function _requireSolvent() internal view {
        _requireSolventAt(_usdgBalanceOf(address(this)));
    }

    function _requireSolventAt(uint256 balance) private view {
        if (balance < totalLiabilityAmount) revert InsolventAccounting();
    }

    function _currentTreasuryBeneficiary() internal view virtual returns (address);

    function _usdgBalanceOf(address account) internal view virtual returns (uint256);

    function _transferUsdg(address recipient, uint256 amount) internal virtual returns (bool);
}
