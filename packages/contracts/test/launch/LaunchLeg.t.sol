// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "../../lib/v4-core/lib/forge-std/src/Test.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import { IPositionDescriptor } from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import { IWETH9 } from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {
    PositionInfo,
    PositionInfoLibrary
} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";
import { DeployPermit2 } from "permit2/test/utils/DeployPermit2.sol";

import { HookemonHook } from "../../src/HookemonHook.sol";
import {
    PermanentPositionCustody,
    RobinhoodBindings
} from "../../src/bindings/RobinhoodBindings.sol";

contract LaunchLegToken {
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address owner, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = allowance[owner][msg.sender];
        if (approved != type(uint256).max) allowance[owner][msg.sender] = approved - amount;
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract LaunchLegHookFactory {
    HookemonHook.ConstructorConfig private config;

    constructor(HookemonHook.ConstructorConfig memory config_) {
        config = config_;
    }

    function initCodeHash() external view returns (bytes32) {
        return keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));
    }

    function deploy(bytes32 salt) external returns (HookemonHook) {
        return new HookemonHook{ salt: salt }(config);
    }
}

contract LaunchLegTest is Test, DeployPermit2 {
    using PositionInfoLibrary for PositionInfo;

    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint160 private constant SEED_MAX = uint160(10 ** 22);
    uint256 private constant SEED_LIQUIDITY = 10 ** 18;
    address private constant PROGRAMMABLE = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
    address private constant TREASURY = address(0x6000);
    address private constant OPERATIONS = address(0x7000);
    address private constant AUTHORITY = address(0xA11CE);
    address private constant PAYER = address(0xBEEF);
    bytes32 private constant BINDING_DIGEST = keccak256("launch-leg-local-binding");
    bytes32 private constant RUNTIME_DIGEST = keccak256("launch-leg-local-runtime");

    PoolManager private manager;
    IAllowanceTransfer private permit2;
    PositionManager private positionManager;
    LaunchLegToken private token0;
    LaunchLegToken private token1;
    Currency private currency0;
    Currency private currency1;
    Currency private usdg;
    Currency private hkmn;
    HookemonHook private hook;
    PermanentPositionCustody private custody;

    function setUp() external {
        manager = new PoolManager(address(this));
        permit2 = IAllowanceTransfer(deployPermit2());
        positionManager = new PositionManager(
            manager, permit2, 100_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );

        LaunchLegToken first = new LaunchLegToken();
        LaunchLegToken second = new LaunchLegToken();
        (token0, token1) = address(first) < address(second) ? (first, second) : (second, first);
        currency0 = Currency.wrap(address(0));
        currency1 = Currency.wrap(address(token1));
        usdg = currency0;
        hkmn = currency1;

        hook = _deployHook();
        custody = new PermanentPositionCustody(address(positionManager), 0);
        custody.configureBindingHook(address(hook));
        token1.mint(address(hook), SEED_MAX);
        vm.deal(AUTHORITY, 1e40);
        vm.deal(PAYER, SEED_MAX);

        vm.prank(AUTHORITY);
        hook.initializeCanonicalPool(uint160(1 << 96));
    }

    function testSeedMintsActualPositionCleansAllowancesAndAccountsForResiduals() external {
        HookemonHook.SeedParams memory params = _seedParams(PAYER);
        uint256 nextTokenId = positionManager.nextTokenId();
        uint256 payerUsdgBefore = PAYER.balance;
        uint256 hookHkmnBefore = token1.balanceOf(address(hook));
        uint256 treasuryHkmnBefore = token1.balanceOf(TREASURY);
        uint256 managerUsdgBefore = address(manager).balance;
        uint256 managerHkmnBefore = token1.balanceOf(address(manager));

        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(params);

        assertTrue(hook.canonicalLiquiditySeeded());
        assertEq(hook.canonicalPositionTokenId(), nextTokenId);
        assertEq(positionManager.nextTokenId(), nextTokenId + 1);
        assertEq(custody.positionTokenId(), nextTokenId);
        assertTrue(custody.positionReceived());
        assertEq(positionManager.ownerOf(nextTokenId), address(custody));
        assertEq(positionManager.getPositionLiquidity(nextTokenId), SEED_LIQUIDITY);

        (PoolKey memory actualKey, PositionInfo info) =
            positionManager.getPoolAndPositionInfo(nextTokenId);
        assertEq(keccak256(abi.encode(actualKey)), keccak256(abi.encode(_canonicalKey())));
        assertEq(info.tickLower(), -887220);
        assertEq(info.tickUpper(), 887220);

        uint256 usdgSpent = address(manager).balance - managerUsdgBefore;
        uint256 hkmnSpent = token1.balanceOf(address(manager)) - managerHkmnBefore;
        uint256 hkmnTransferred = token1.balanceOf(TREASURY) - treasuryHkmnBefore;
        assertGt(usdgSpent, 0);
        assertGt(hkmnSpent, 0);
        assertGt(hkmnTransferred, 0);
        assertEq(PAYER.balance - payerUsdgBefore, SEED_MAX - usdgSpent);
        assertEq(hookHkmnBefore, hkmnSpent + hkmnTransferred);
        assertEq(address(hook).balance, 0);
        assertEq(token1.balanceOf(address(hook)), 0);

        _assertAllowanceZero(PAYER, address(token0), address(hook));
        _assertAllowanceZero(address(hook), address(token0), address(positionManager));
        _assertAllowanceZero(address(hook), address(token1), address(positionManager));
        assertEq(token0.allowance(address(hook), address(permit2)), 0);
        assertEq(token1.allowance(address(hook), address(permit2)), 0);

        (bool canApprove,) = address(custody)
            .call(abi.encodeWithSignature("approve(address,uint256)", address(this), nextTokenId));
        (bool canTransfer,) = address(custody)
            .call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256)",
                    address(custody),
                    address(this),
                    nextTokenId
                )
            );
        assertFalse(canApprove);
        assertFalse(canTransfer);
    }

    function testSeedRejectsWhenObservedPositionCounterDoesNotAdvanceExactlyOnce() external {
        uint256 nextTokenId = positionManager.nextTokenId();
        vm.mockCall(
            address(positionManager),
            abi.encodeWithSignature("nextTokenId()"),
            abi.encode(nextTokenId + 1)
        );

        vm.expectRevert(HookemonHook.SeedPositionMintMismatch.selector);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(_seedParams(PAYER));

        vm.clearMockedCalls();
        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(positionManager.nextTokenId(), nextTokenId);
    }

    function testSeedRevertsAndRollsBackWhenResidualTransferFails() external {
        uint256 nextTokenId = positionManager.nextTokenId();
        uint256 payerUsdgBefore = PAYER.balance;
        uint256 hookHkmnBefore = token1.balanceOf(address(hook));
        uint256 treasuryHkmnBefore = token1.balanceOf(TREASURY);
        uint256 managerUsdgBefore = address(manager).balance;
        uint256 managerHkmnBefore = token1.balanceOf(address(manager));
        bytes4 residualTransferFailure = bytes4(keccak256("SeedResidualTransferFailed()"));

        vm.mockCallRevert(
            address(token1),
            abi.encodeWithSelector(LaunchLegToken.transfer.selector),
            abi.encodeWithSelector(residualTransferFailure)
        );
        vm.expectRevert(residualTransferFailure);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(_seedParams(PAYER));
        vm.clearMockedCalls();

        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(hook.canonicalPositionTokenId(), 0);
        assertEq(positionManager.nextTokenId(), nextTokenId);
        assertEq(PAYER.balance, payerUsdgBefore);
        assertEq(address(hook).balance, 0);
        assertEq(token1.balanceOf(address(hook)), hookHkmnBefore);
        assertEq(token1.balanceOf(TREASURY), treasuryHkmnBefore);
        assertEq(address(manager).balance, managerUsdgBefore);
        assertEq(token1.balanceOf(address(manager)), managerHkmnBefore);
    }

    function testSeedRejectsReversedNativeOrdering() external {
        LaunchLegHookFactory factory = _newHookFactory(currency1, currency0);
        (bytes32 salt,) = _findHookSalt(factory);
        vm.expectRevert();
        factory.deploy(salt);
    }

    function testSeedRejectsSecondCall() external {
        HookemonHook.SeedParams memory params = _seedParams(PAYER);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(params);

        vm.expectRevert(HookemonHook.CanonicalLiquidityAlreadySeeded.selector);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(params);
    }

    function testSeedRequiresLaunchAuthorityAndPoolInitialization() external {
        vm.expectRevert(HookemonHook.UnauthorizedLaunchAuthority.selector);
        vm.prank(PAYER);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(_seedParams(PAYER));

        HookemonHook uninitializedHook = _deployHook();
        PermanentPositionCustody uninitializedCustody =
            new PermanentPositionCustody(address(positionManager), 0);
        uninitializedCustody.configureBindingHook(address(uninitializedHook));
        HookemonHook.SeedParams memory params = _seedParams(PAYER);
        params.custody = address(uninitializedCustody);

        vm.expectRevert(HookemonHook.CanonicalPoolNotInitialized.selector);
        vm.prank(AUTHORITY);
        uninitializedHook.seedCanonicalLiquidity{ value: SEED_MAX }(params);
    }

    function testCustodyRejectsAnUnrelatedBindingCaller() external {
        uint256 nextTokenId = positionManager.nextTokenId();
        vm.expectRevert(
            abi.encodeWithSelector(
                PermanentPositionCustody.UnauthorizedBindingHook.selector, address(this)
            )
        );
        custody.bindMintedPosition(nextTokenId, _canonicalKey(), -120, 120, SEED_LIQUIDITY);
    }

    function testSeedRejectsCustodyThatIsNotBoundToThisHook() external {
        PermanentPositionCustody otherCustody =
            new PermanentPositionCustody(address(positionManager), 0);
        HookemonHook.SeedParams memory params = _seedParams(PAYER);
        params.custody = address(otherCustody);

        vm.expectRevert(HookemonHook.InvalidSeedCustody.selector);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(params);

        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(positionManager.nextTokenId(), 1);
    }

    function testCustodyBindingHookIsConfiguredOnceByItsDeployer() external {
        vm.expectRevert(PermanentPositionCustody.BindingHookAlreadyConfigured.selector);
        custody.configureBindingHook(address(hook));

        PermanentPositionCustody otherCustody =
            new PermanentPositionCustody(address(positionManager), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                PermanentPositionCustody.UnauthorizedCustodyDeployer.selector, PAYER
            )
        );
        vm.prank(PAYER);
        otherCustody.configureBindingHook(address(hook));
    }

    function testSeedRejectsPositionManagerForAnotherPoolManager() external {
        vm.mockCall(
            address(positionManager),
            abi.encodeWithSignature("poolManager()"),
            abi.encode(address(0xD00D))
        );

        vm.expectRevert(HookemonHook.InvalidPositionManagerPoolManager.selector);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX }(_seedParams(PAYER));

        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(positionManager.nextTokenId(), 1);
    }

    function testSeedRejectsMissingExactNativeValueWithoutMutation() external {
        HookemonHook.SeedParams memory params = _seedParams(PAYER);
        uint256 nextTokenId = positionManager.nextTokenId();
        uint256 payerUsdgBefore = PAYER.balance;
        uint256 hookHkmnBefore = token1.balanceOf(address(hook));

        vm.expectRevert(HookemonHook.SeedFundingMismatch.selector);
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity{ value: SEED_MAX - 1 }(params);

        assertFalse(hook.canonicalLiquiditySeeded());
        assertEq(positionManager.nextTokenId(), nextTokenId);
        assertEq(PAYER.balance, payerUsdgBefore);
        assertEq(token1.balanceOf(address(hook)), hookHkmnBefore);
        assertEq(address(hook).balance, 0);
    }

    function testForeignPoolInitializationRevertsBeforeAndAfterHookDeployment() external {
        LaunchLegHookFactory factory = _newHookFactory();
        (bytes32 salt, address predicted) = _findHookSalt(factory);
        PoolKey memory key = PoolKey(currency0, currency1, 0, 60, IHooks(predicted));

        vm.expectRevert();
        manager.initialize(key, uint160(1 << 96));

        HookemonHook uninitializedHook = factory.deploy(salt);
        assertEq(address(uninitializedHook), predicted);
        key.hooks = IHooks(address(uninitializedHook));

        vm.expectRevert();
        manager.initialize(key, uint160(1 << 96));
    }

    function testOnlyLaunchAuthorityInitializesCanonicalPoolOnce() external {
        HookemonHook uninitializedHook = _deployHook();

        vm.expectRevert(HookemonHook.UnauthorizedLaunchAuthority.selector);
        vm.prank(PAYER);
        uninitializedHook.initializeCanonicalPool(uint160(1 << 96));

        vm.prank(AUTHORITY);
        uninitializedHook.initializeCanonicalPool(uint160(1 << 96));
        assertTrue(uninitializedHook.canonicalPoolInitialized());

        vm.expectRevert(HookemonHook.CanonicalPoolAlreadyInitialized.selector);
        vm.prank(AUTHORITY);
        uninitializedHook.initializeCanonicalPool(uint160(1 << 96));
    }

    function _seedParams(address payer) private view returns (HookemonHook.SeedParams memory) {
        return HookemonHook.SeedParams({
            tickLower: -887220,
            tickUpper: 887220,
            liquidity: SEED_LIQUIDITY,
            amount0Max: uint128(SEED_MAX),
            amount1Max: uint128(SEED_MAX),
            deadline: block.timestamp + 1,
            payer: payer,
            custody: address(custody)
        });
    }

    function _deployHook() private returns (HookemonHook deployed) {
        return _deployHook(usdg, hkmn);
    }

    function _deployHook(Currency configuredUsdg, Currency configuredHkmn)
        private
        returns (HookemonHook deployed)
    {
        LaunchLegHookFactory factory = _newHookFactory(configuredUsdg, configuredHkmn);

        (bytes32 salt,) = _findHookSalt(factory);
        deployed = factory.deploy(salt);
    }

    function _newHookFactory() private returns (LaunchLegHookFactory factory) {
        return _newHookFactory(usdg, hkmn);
    }

    function _newHookFactory(Currency configuredUsdg, Currency configuredHkmn)
        private
        returns (LaunchLegHookFactory factory)
    {
        factory = new LaunchLegHookFactory(
            HookemonHook.ConstructorConfig({
                manager: IPoolManager(manager),
                positionManager: address(positionManager),
                permit2: address(permit2),
                quoteCurrency: configuredUsdg,
                hkmn: configuredHkmn,
                tickSpacing: 60,
                programmable: PROGRAMMABLE,
                treasury: TREASURY,
                operations: OPERATIONS,
                launchAuthority: AUTHORITY,
                issuanceAuthority: AUTHORITY,
                expectedDecimals: 18,
                bindingDigest: BINDING_DIGEST,
                runtimeDigest: RUNTIME_DIGEST,
                processClaimLimit6hWei: 1_000_000,
                processClaimLimitMaxWei: 2_000_000,
                processClaimMaxCount: 8,
                operationsRotationDelay: 3 days
            })
        );
    }

    function _findHookSalt(LaunchLegHookFactory factory)
        private
        view
        returns (bytes32 salt, address predicted)
    {
        bytes32 initCodeHash = factory.initCodeHash();
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            salt = bytes32(nonce);
            predicted = vm.computeCreate2Address(salt, initCodeHash, address(factory));
            if ((uint160(predicted) & ALL_HOOK_MASK) == REQUIRED_HOOK_MASK) {
                return (salt, predicted);
            }
        }
        revert("valid hook salt not found");
    }

    function _canonicalKey() private view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, 0, 60, IHooks(address(hook)));
    }

    function _assertAllowanceZero(address owner, address token, address spender) private view {
        (uint160 amount,,) = permit2.allowance(owner, token, spender);
        assertEq(amount, 0);
    }
}
