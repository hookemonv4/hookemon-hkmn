// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPegCycleVault } from "../../src/process/IPegCycleVault.sol";
import { IPegCycleRouteExecutor } from "../../src/process/IPegCycleRouteExecutor.sol";
import { PegCycleVault } from "../../src/process/PegCycleVault.sol";

import { HolderSettlement } from "../../src/settlement/HolderSettlement.sol";
import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";
import { HookemonIssuance } from "../../src/launch/HookemonIssuance.sol";
import { CanonicalMarketCallback } from "../../src/market/CanonicalMarket.sol";
import { BaseTestHooks } from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { BalanceDelta, toBalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { BeforeSwapDelta } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PayoutSigning } from "../helpers/PayoutSigning.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function ffi(string[] calldata commandInput) external returns (bytes memory result);
    function envOr(string calldata name, string calldata defaultValue)
        external
        view
        returns (string memory value);
    function prank(address caller) external;
    function toString(address value) external pure returns (string memory stringifiedValue);
    function toString(uint256 value) external pure returns (string memory stringifiedValue);
}

contract PhaseOneLocalLoopTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant PROGRAMMABLE = address(0x5000);
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS = address(0x7000);
    address private constant AUTHORITY = address(0xA11CE);
    address private constant CALLBACK_SENDER = address(0x8000);
    address private constant BUYER = address(0xBEEF);
    address private constant REMAINDER = address(0x9000);
    address private constant CUSTODY = address(0xA000);
    address private constant PROJECT = address(0xB000);
    bytes32 private constant BINDING_DIGEST = keccak256("local fixture; provider binding absent");
    bytes32 private constant RUNTIME_DIGEST = keccak256("local fixture; runtime binding absent");
    bytes32 private constant PROVIDER_CALL_DIGEST =
        keccak256("local fixture; provider call not executed");
    bytes32 private constant REMAINDER_DIGEST =
        keccak256("local fixture; remainder treatment not provider-bound");
    bytes32 private constant CUSTODY_DIGEST =
        keccak256("local fixture; custody commitment not provider-bound");
    bytes32 private constant OUTBOUND_DIGEST = keccak256("local exact route");
    bytes32 private constant RETURN_DIGEST = keccak256("local exact return action");
    bytes32 private constant RETURN_RECEIPT_DIGEST = keccak256("local exact return receipt");
    uint256 private constant FUNDED_PRINCIPAL = 10;

    struct LocalPayout {
        bytes32 cycleId;
        bytes32 payoutId;
        bytes32 manifestDigest;
        bytes32 rootHash;
        uint256 rootSum;
        address recipient;
        uint256 amount;
        bytes32[10] siblingHashes;
        uint256[10] siblingSums;
    }

    /// @dev This path is wholly local: it neither calls nor proves any provider behavior.
    function test_localGuardAndAuthenticatedBuyFundOneCommittedLeaf() external {
        VM.chainId(4663);
        LocalLoopUsdg token = new LocalLoopUsdg();
        LocalLoopRouteExecutor routeExecutor = new LocalLoopRouteExecutor(token);
        PegCycleVault payoutVault = new PegCycleVault(
            address(token),
            address(this),
            address(routeExecutor),
            BINDING_DIGEST,
            address(this),
            PayoutSigning.distributionSignerAddress(),
            PayoutSigning.distributionVerifierAddress()
        );
        LocalLoopSettlement subject =
            new LocalLoopSettlement(token, PROGRAMMABLE, TREASURY, OPERATIONS, payoutVault);
        payoutVault.bindHook(address(subject));
        _verifyLocalIssuance(subject);
        _recordAuthenticatedBuy(subject, token);

        LocalPayout memory payout = _loadPayout(subject);

        assert(payout.rootSum == 10);
        assert(payout.amount == payout.rootSum);
        _fundPayout(subject, token, payoutVault, routeExecutor, payout);
        _payEntitlement(
            subject,
            payout.payoutId,
            payout.recipient,
            payout.amount,
            payout.siblingHashes,
            payout.siblingSums
        );

        (uint256 funded, uint256 paid, uint256 unpaid) =
            subject.readPayoutConservation(payout.payoutId);
        assert(funded == 10 && paid == 10 && unpaid == 0);
        assert(subject.isPaid(payout.payoutId, 0, 0));
        assert(token.balanceOf(payout.recipient) == 10);
        assert(token.balanceOf(OPERATIONS) == 0);
        assert(token.balanceOf(address(payoutVault)) == 0);
        assert(subject.isSolvent());
    }

    function _fundPayout(
        LocalLoopSettlement subject,
        LocalLoopUsdg token,
        PegCycleVault vault,
        LocalLoopRouteExecutor routeExecutor,
        LocalPayout memory payout
    ) private {
        bytes memory routeData = abi.encode(OUTBOUND_DIGEST, FUNDED_PRINCIPAL);
        uint256 operationsBalanceBefore = token.balanceOf(OPERATIONS);
        uint256 processBefore = subject.processLiability();
        IPegCycleVault.FundingAuthorization memory fundingAuthorization =
            IPegCycleVault.FundingAuthorization({
                requirementsRevision: 57,
                chainId: block.chainid,
                cycleId: payout.cycleId,
                hook: address(subject),
                vault: address(vault),
                usdg: address(token),
                operationsTrigger: OPERATIONS,
                amount: FUNDED_PRINCIPAL,
                bindingManifestDigest: BINDING_DIGEST,
                outboundActionDigest: keccak256(routeData),
                returnActionDigest: RETURN_DIGEST,
                returnDestination: vault.computeCycleEscrow(payout.cycleId),
                minimumRobinhoodReceive: 1,
                minimumSolanaReceive: 1,
                minimumReturnUsdg: payout.rootSum,
                robinhoodNativeGasCap: 1,
                solanaNativeGasCap: 1,
                expiresAt: uint64(block.timestamp + 1 days),
                nonce: 1
            });
        vault.authorizeFunding(fundingAuthorization);
        VM.prank(OPERATIONS);
        subject.openPegCycle(payout.cycleId);
        assert(subject.processLiability() == processBefore - FUNDED_PRINCIPAL);
        assert(token.balanceOf(vault.cycleEscrows(payout.cycleId)) == FUNDED_PRINCIPAL);
        assert(token.balanceOf(address(vault)) == 0);
        assert(token.balanceOf(OPERATIONS) == operationsBalanceBefore);

        VM.prank(OPERATIONS);
        vault.executeOutbound(payout.cycleId, routeData);
        routeExecutor.returnExact();

        IPegCycleVault.PayoutAuthorization memory payoutAuthorization =
            IPegCycleVault.PayoutAuthorization({
                requirementsRevision: 57,
                chainId: block.chainid,
                cycleId: payout.cycleId,
                hook: address(subject),
                vault: address(subject.pegCycleVault()),
                usdg: address(token),
                operationsTrigger: OPERATIONS,
                bindingManifestDigest: BINDING_DIGEST,
                payoutId: payout.payoutId,
                manifestDigest: payout.manifestDigest,
                rootHash: payout.rootHash,
                rootSum: payout.rootSum,
                returnActionDigest: RETURN_DIGEST,
                returnReceiptDigest: RETURN_RECEIPT_DIGEST,
                expiresAt: uint64(block.timestamp + 1 days),
                nonce: 2
            });
        {
            (bytes memory distributionSignature, bytes memory verifierSignature) = PayoutSigning.signPair(
                PayoutSigning.computeDomainSeparator(address(vault)), payoutAuthorization
            );
            vault.authorizePayout(payoutAuthorization, distributionSignature, verifierSignature);
        }
        VM.prank(BUYER);
        subject.fundPayoutFromPegCycle(payoutAuthorization);
        // Chunk commitment is restricted to the vault's own `authorizer` (the test contract
        // itself, per the vault deployment above) -- `OPERATIONS`, the payout's low-privilege
        // `operationsTrigger`, is no longer authorized to commit a chunk root.
        subject.commitPayoutChunk(payout.payoutId, 0, payout.rootHash, payout.rootSum);
        assert(subject.isManifestClosed(payout.payoutId));
        assert(token.balanceOf(OPERATIONS) == operationsBalanceBefore);
        assert(token.balanceOf(vault.cycleEscrows(payout.cycleId)) == 0);
        assert(token.balanceOf(address(vault)) == 0);
        assert(subject.processLiability() == processBefore - FUNDED_PRINCIPAL);
        assert(subject.payoutLiability(payout.payoutId) == payout.rootSum);
        (bytes32 committedDigest, bytes32 committedPayoutId, bytes32 committedReceipt) =
            vault.readCommittedPayoutBinding(payout.cycleId);
        assert(committedDigest == keccak256(abi.encode(payoutAuthorization)));
        assert(committedPayoutId == payout.payoutId);
        assert(committedReceipt == payoutAuthorization.returnReceiptDigest);
    }

    function _payEntitlement(
        LocalLoopSettlement subject,
        bytes32 payoutId,
        address recipient,
        uint256 amount,
        bytes32[10] memory siblingHashes,
        uint256[10] memory siblingSums
    ) private {
        subject.payEntitlement(payoutId, 0, 0, recipient, amount, siblingHashes, siblingSums);
    }

    function _loadPayout(LocalLoopSettlement subject) private returns (LocalPayout memory payout) {
        string[] memory command = new string[](4);
        command[0] = VM.envOr("HOOKEMON_NODE_BINARY", "node");
        command[1] = VM.envOr(
            "HOOKEMON_PHASE1_LOOP_ADAPTER",
            "../runner/test/integration/phase-one-local-loop-adapter.mjs"
        );
        command[2] = VM.toString(address(subject));
        command[3] = VM.toString(block.chainid);
        payout = abi.decode(VM.ffi(command), (LocalPayout));
    }

    function _verifyLocalIssuance(LocalLoopSettlement subject) private {
        HookemonIssuance issuance = HookemonIssuance(address(subject));
        CanonicalMarketCallback market = CanonicalMarketCallback(address(subject));
        LocalLoopUsdg hkmn = LocalLoopUsdg(Currency.unwrap(market.hkmn()));
        HookemonIssuance.IssuancePlan memory plan = _issuancePlan(address(subject));
        hkmn.mint(address(subject), plan.marketAllocation);
        hkmn.mint(REMAINDER, plan.remainderAllocation);

        VM.prank(AUTHORITY);
        bytes32 planDigest = issuance.prepareOfficialIssuance(plan);
        HookemonIssuance.IssuanceObservation memory observation = _issuanceObservation(
            plan,
            planDigest,
            address(hkmn),
            hkmn.balanceOf(address(subject)),
            hkmn.balanceOf(REMAINDER)
        );
        HookemonIssuance.TransferRecord[] memory trace = _issuanceTrace(plan);
        VM.prank(AUTHORITY);
        issuance.verifyIssuance(plan, observation, trace);
        assert(
            issuance.readTokenState().status
                == HookemonIssuance.GuardStatus.OBSERVATION_VERIFIED_PROVIDER_BINDING_PENDING
        );
    }

    function _recordAuthenticatedBuy(LocalLoopSettlement subject, LocalLoopUsdg token) private {
        CanonicalMarketCallback market = CanonicalMarketCallback(address(subject));
        Currency usdg = market.usdg();
        Currency hkmnCurrency = market.hkmn();
        bool usdg0 = Currency.unwrap(usdg) < Currency.unwrap(hkmnCurrency);
        PoolKey memory key = PoolKey({
            currency0: usdg0 ? usdg : hkmnCurrency,
            currency1: usdg0 ? hkmnCurrency : usdg,
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(subject))
        });
        SwapParams memory params = SwapParams({
            zeroForOne: usdg0, amountSpecified: -int256(10_000), sqrtPriceLimitX96: 0
        });
        bytes memory hookData = abi.encode(keccak256("local authenticated buy"), BUYER);
        IPoolManager manager = market.poolManager();
        VM.prank(address(manager));
        market.beforeSwap(CALLBACK_SENDER, key, params, hookData);
        BalanceDelta delta = usdg0 ? toBalanceDelta(-9_700, 8_000) : toBalanceDelta(8_000, -9_700);
        VM.prank(address(manager));
        market.afterSwap(CALLBACK_SENDER, key, params, delta, hookData);

        assert(market.lastExecutedUsdg() == 10_000);
        assert(token.balanceOf(address(subject)) == 300);
    }

    function _issuancePlan(address market)
        private
        pure
        returns (HookemonIssuance.IssuancePlan memory plan)
    {
        uint256 supply = 420_690_000_000 * 1e18;
        uint256 marketAllocation = 378_621_000_000 * 1e18;
        plan = HookemonIssuance.IssuancePlan({
            decimals: 18,
            issuanceSource: address(0),
            canonicalMarket: market,
            remainderRepresentation: REMAINDER,
            marketPositionCustody: CUSTODY,
            projectWallet: PROJECT,
            totalSupply: supply,
            marketAllocation: marketAllocation,
            remainderAllocation: supply - marketAllocation,
            otherAllocation: 0,
            bindingManifestDigest: BINDING_DIGEST,
            runtimeAuthorityDigest: RUNTIME_DIGEST,
            providerCallDigest: PROVIDER_CALL_DIGEST,
            remainderTreatmentDigest: REMAINDER_DIGEST,
            custodyCommitment: CUSTODY_DIGEST
        });
    }

    function _issuanceObservation(
        HookemonIssuance.IssuancePlan memory plan,
        bytes32 planDigest,
        address hkmn,
        uint256 marketBalance,
        uint256 remainderBalance
    ) private pure returns (HookemonIssuance.IssuanceObservation memory observation) {
        observation = HookemonIssuance.IssuanceObservation({
            planDigest: planDigest,
            token: hkmn,
            nameHash: keccak256("Hookemon"),
            symbolHash: keccak256("HKMN"),
            decimals: plan.decimals,
            totalSupply: plan.totalSupply,
            canonicalMarketBalance: marketBalance,
            remainderBalance: remainderBalance,
            issuanceSourceBalance: 0,
            projectWalletBalance: 0,
            otherAllocation: 0,
            bindingManifestDigest: plan.bindingManifestDigest,
            runtimeAuthorityDigest: plan.runtimeAuthorityDigest,
            providerCallDigest: plan.providerCallDigest,
            remainderTreatmentDigest: plan.remainderTreatmentDigest,
            custodyCommitment: plan.custodyCommitment
        });
    }

    function _issuanceTrace(HookemonIssuance.IssuancePlan memory plan)
        private
        pure
        returns (HookemonIssuance.TransferRecord[] memory trace)
    {
        trace = new HookemonIssuance.TransferRecord[](2);
        trace[0] = HookemonIssuance.TransferRecord(
            plan.issuanceSource, plan.canonicalMarket, plan.marketAllocation
        );
        trace[1] = HookemonIssuance.TransferRecord(
            plan.issuanceSource, plan.remainderRepresentation, plan.remainderAllocation
        );
    }
}

contract LocalLoopSettlement is
    HolderSettlement,
    BaseTestHooks,
    CanonicalMarketCallback,
    HookemonIssuance
{
    address private constant LOCAL_AUTHORITY = address(0xA11CE);
    bytes32 private constant LOCAL_BINDING_DIGEST =
        keccak256("local fixture; provider binding absent");
    bytes32 private constant LOCAL_RUNTIME_DIGEST =
        keccak256("local fixture; runtime binding absent");
    LocalLoopUsdg private immutable TOKEN;

    constructor(
        LocalLoopUsdg token,
        address programmable,
        address treasury,
        address operations,
        IPegCycleVault payoutVault
    )
        HolderSettlement(programmable, treasury, operations, payoutVault)
        CanonicalMarketCallback(
            IPoolManager(address(new LocalLoopPoolManager())),
            Currency.wrap(address(token)),
            Currency.wrap(address(new LocalLoopUsdg())),
            60
        )
        HookemonIssuance(LOCAL_AUTHORITY, 18, LOCAL_BINDING_DIGEST, LOCAL_RUNTIME_DIGEST)
    {
        TOKEN = token;
    }

    function _collectFee(Currency currency, uint256 feeAmount)
        internal
        override
        returns (uint256 balanceBeforeCollection)
    {
        assert(Currency.unwrap(currency) == address(TOKEN));
        balanceBeforeCollection = TOKEN.balanceOf(address(this));
        TOKEN.mint(address(this), feeAmount);
    }

    function _accrueAuthenticatedSwap(uint256 executedUsdg, uint256 balanceBeforeCollection)
        internal
        override(CanonicalMarketCallback, FeeAccounting)
    {
        FeeAccounting._accrueAuthenticatedSwap(executedUsdg, balanceBeforeCollection);
    }

    function _previewTotalFee(uint256 executedUsdg)
        internal
        view
        override(CanonicalMarketCallback, FeeAccounting)
        returns (uint256)
    {
        return FeeAccounting._previewTotalFee(executedUsdg);
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata data
    )
        external
        override(BaseTestHooks, CanonicalMarketCallback)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (BeforeSwapDelta delta, uint24 feeOverride) = _beforeSwap(sender, key, params, data);
        return (IHooks.beforeSwap.selector, delta, feeOverride);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata data
    ) external override(BaseTestHooks, CanonicalMarketCallback) moneyPath returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, _afterSwap(sender, key, params, delta, data));
    }

    function isSolvent() external view returns (bool) {
        return _isSolvent();
    }

    function processLiability() external view returns (uint256) {
        return _processLiability();
    }

    function payoutLiability(bytes32 payoutId) external view returns (uint256) {
        return _payoutLiabilityOf(payoutId);
    }

    function _usdgBalanceOf(address account) internal view override returns (uint256) {
        return TOKEN.balanceOf(account);
    }

    function _transferUsdg(address recipient, uint256 amount) internal override returns (bool) {
        return TOKEN.transfer(recipient, amount);
    }
}

/// @dev Supplies only the zero-fee pool-state read used by CanonicalMarketCallback._matches.
contract LocalLoopPoolManager {
    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }
}

contract LocalLoopUsdg {
    mapping(address account => uint256 balance) private balances;

    function mint(address account, uint256 amount) external {
        balances[account] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        return _move(msg.sender, recipient, amount);
    }

    function transferFrom(address from, address recipient, uint256 amount) external returns (bool) {
        return _move(from, recipient, amount);
    }

    function _move(address from, address recipient, uint256 amount) private returns (bool) {
        balances[from] -= amount;
        balances[recipient] += amount;
        return true;
    }
}

contract LocalLoopRouteExecutor is IPegCycleRouteExecutor {
    LocalLoopUsdg private immutable token;
    address private returnDestination;
    uint256 private returnAmount;

    constructor(LocalLoopUsdg token_) {
        token = token_;
    }

    function executeOutbound(
        bytes32,
        address usdg,
        uint256 amount,
        address destination,
        bytes calldata routeData
    ) external {
        (bytes32 action, uint256 routeAmount) = abi.decode(routeData, (bytes32, uint256));
        require(
            msg.sender != destination && usdg == address(token)
                && action == keccak256("local exact route") && routeAmount == amount
                && token.balanceOf(address(this)) == amount
        );
        returnDestination = destination;
        returnAmount = amount;
    }

    function returnExact() external {
        address destination = returnDestination;
        uint256 amount = returnAmount;
        require(destination != address(0) && amount != 0);
        delete returnDestination;
        delete returnAmount;
        require(token.transfer(destination, amount));
    }
}
