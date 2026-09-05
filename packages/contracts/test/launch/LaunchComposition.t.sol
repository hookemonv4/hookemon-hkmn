// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "../../lib/v4-core/lib/forge-std/src/Test.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import { IPositionDescriptor } from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import { IWETH9 } from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";
import { DeployPermit2 } from "permit2/test/utils/DeployPermit2.sol";

import { HookemonHook } from "../../src/HookemonHook.sol";
import {
    PermanentPositionCustody,
    RobinhoodBindings
} from "../../src/bindings/RobinhoodBindings.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";

contract LaunchCompositionTestToken {
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

contract KnownProviderFactory {
    function deploy(bytes32 salt, HookemonHook.ConstructorConfig calldata config)
        external
        returns (HookemonHook hook)
    {
        hook = new HookemonHook{ salt: salt }(config);
    }
}

contract ProgrammableGraphHarness {
    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    bytes32 private constant TARGET_SALT_TYPEHASH = keccak256(
        "ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)"
    );
    bytes32 private constant HOOK_TARGET_ID = keccak256("hook-target");
    address private constant TREASURY = address(0x6000);
    address private constant AUTHORIZED_LAUNCHER = 0x34965F2A2ee9254522232C32F02056E92BE0C98a;

    struct GraphRequest {
        bytes32 tokenTargetIdHash;
        bytes32 hookTargetIdHash;
        bytes32 custodyTargetIdHash;
        bytes32 tokenApplicantSalt;
        bytes32 hookApplicantSalt;
        bytes32 custodyApplicantSalt;
        uint160 initializationPriceX96;
        address hookUsdg;
        address allocationCustody;
        uint8 hookExpectedDecimals;
    }

    struct TargetDeployment {
        bytes initCode;
        bytes32 salt;
        bytes initializerCalldata;
    }

    IPoolManager public immutable poolManager;
    address public immutable positionManager;
    address public immutable permit2;
    address public immutable expectedUsdg;
    uint160 public launchPriceX96;
    address public immutable launchAuthority;
    bytes32 public immutable routeNamespace;
    bytes32 public immutable routeNonce;

    error UnauthorizedLauncher(address caller);
    error TargetDeploymentFailed(uint256 targetIndex);

    mapping(address target => uint256 count) public initializerCalls;
    address[3] public initializedTargets;
    bytes4[3] public initializedSelectors;

    constructor(
        IPoolManager poolManager_,
        address positionManager_,
        address permit2_,
        address expectedUsdg_,
        uint160 launchPriceX96_,
        address launchAuthority_,
        bytes32 routeNamespace_,
        bytes32 routeNonce_
    ) {
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        expectedUsdg = expectedUsdg_;
        launchPriceX96 = launchPriceX96_;
        launchAuthority = launchAuthority_;
        routeNamespace = routeNamespace_;
        routeNonce = routeNonce_;
    }

    function effectiveSalt(bytes32 targetIdHash, bytes32 applicantSalt)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                TARGET_SALT_TYPEHASH,
                block.chainid,
                address(this),
                routeNamespace,
                routeNonce,
                targetIdHash,
                applicantSalt,
                AUTHORIZED_LAUNCHER
            )
        );
    }

    function hookInitCodeHash(GraphRequest calldata request) external view returns (bytes32) {
        address token = _predictToken(request);
        return _hookInitCodeHash(token, request.hookUsdg, request.hookExpectedDecimals);
    }

    function graphHookInitCodeHash(address token, address hookUsdg, uint8 hookExpectedDecimals)
        external
        view
        returns (bytes32)
    {
        return _hookInitCodeHash(token, hookUsdg, hookExpectedDecimals);
    }

    function predict(GraphRequest calldata request)
        external
        view
        returns (address token, address hook, address custody)
    {
        token = _predictToken(request);
        hook = _predict(
            effectiveSalt(request.hookTargetIdHash, request.hookApplicantSalt),
            _hookInitCodeHash(token, request.hookUsdg, request.hookExpectedDecimals)
        );
        custody = _predict(
            effectiveSalt(request.custodyTargetIdHash, request.custodyApplicantSalt),
            keccak256(
                abi.encodePacked(
                    type(PermanentPositionCustody).creationCode, abi.encode(positionManager, 0)
                )
            )
        );
    }

    function launch(GraphRequest calldata request)
        external
        returns (HKMNToken token, HookemonHook hook, PermanentPositionCustody custody)
    {
        if (msg.sender != AUTHORIZED_LAUNCHER) revert UnauthorizedLauncher(msg.sender);

        address[3] memory targets = _execute(_providerDeployments(request));
        token = HKMNToken(targets[0]);
        custody = PermanentPositionCustody(targets[1]);
        hook = HookemonHook(targets[2]);
    }

    function providerDeployments(GraphRequest calldata request)
        external
        view
        returns (TargetDeployment[3] memory)
    {
        return _providerDeployments(request);
    }

    function execute(TargetDeployment[3] calldata deployments)
        external
        returns (address[3] memory targets)
    {
        if (msg.sender != AUTHORIZED_LAUNCHER) revert UnauthorizedLauncher(msg.sender);
        return _execute(deployments);
    }

    function deployGraphModeHook(
        bytes32 salt,
        address token,
        address hookUsdg,
        uint8 hookExpectedDecimals
    ) external returns (HookemonHook) {
        if (msg.sender != AUTHORIZED_LAUNCHER) {
            revert UnauthorizedLauncher(msg.sender);
        }
        return new HookemonHook{ salt: effectiveSalt(HOOK_TARGET_ID, salt) }(
            _hookConfig(token, hookUsdg, hookExpectedDecimals)
        );
    }

    function initializeAgain(address hook, address custody, uint160 sqrtPriceX96) external {
        if (msg.sender != AUTHORIZED_LAUNCHER) revert UnauthorizedLauncher(msg.sender);
        HookemonHook(hook).initializeGraphLaunch(custody, sqrtPriceX96);
    }

    function setLaunchPriceX96(uint160 launchPriceX96_) external {
        launchPriceX96 = launchPriceX96_;
    }

    function _providerDeployments(GraphRequest calldata request)
        private
        view
        returns (TargetDeployment[3] memory deployments)
    {
        (address token, address hook, address custody) = _predict(request);
        address launchCustody =
            request.allocationCustody == address(0) ? custody : request.allocationCustody;

        deployments[0] = TargetDeployment({
            initCode: abi.encodePacked(
                type(HKMNToken).creationCode,
                abi.encode(address(this), expectedUsdg, uint8(18), launchPriceX96)
            ),
            salt: effectiveSalt(request.tokenTargetIdHash, request.tokenApplicantSalt),
            initializerCalldata: abi.encodeCall(HKMNToken.allocate, (hook))
        });
        deployments[1] = TargetDeployment({
            initCode: abi.encodePacked(
                type(PermanentPositionCustody).creationCode, abi.encode(positionManager, 0)
            ),
            salt: effectiveSalt(request.custodyTargetIdHash, request.custodyApplicantSalt),
            initializerCalldata: abi.encodeCall(
                PermanentPositionCustody.configureBindingHook, (hook)
            )
        });
        deployments[2] = TargetDeployment({
            initCode: abi.encodePacked(
                type(HookemonHook).creationCode,
                abi.encode(_hookConfig(token, request.hookUsdg, request.hookExpectedDecimals))
            ),
            salt: effectiveSalt(request.hookTargetIdHash, request.hookApplicantSalt),
            initializerCalldata: abi.encodeCall(
                HookemonHook.initializeGraphLaunch, (launchCustody, request.initializationPriceX96)
            )
        });
    }

    function _execute(TargetDeployment[3] memory deployments)
        private
        returns (address[3] memory targets)
    {
        for (uint256 index; index < targets.length; ++index) {
            bytes memory initCode = deployments[index].initCode;
            address target;
            bytes32 salt = deployments[index].salt;
            assembly ("memory-safe") {
                target := create2(0, add(initCode, 0x20), mload(initCode), salt)
            }
            if (target == address(0)) revert TargetDeploymentFailed(index);
            targets[index] = target;
        }

        for (uint256 index; index < targets.length; ++index) {
            bytes memory initializerCalldata = deployments[index].initializerCalldata;
            (bool success, bytes memory returnData) = targets[index].call(initializerCalldata);
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            }
            initializerCalls[targets[index]] += 1;
            initializedTargets[index] = targets[index];
            if (initializerCalldata.length >= 4) {
                bytes4 selector;
                assembly ("memory-safe") {
                    selector := mload(add(initializerCalldata, 0x20))
                }
                initializedSelectors[index] = selector;
            }
        }
    }

    function _predictToken(GraphRequest calldata request) private view returns (address) {
        return _predict(
            effectiveSalt(request.tokenTargetIdHash, request.tokenApplicantSalt),
            keccak256(
                abi.encodePacked(
                    type(HKMNToken).creationCode,
                    abi.encode(address(this), expectedUsdg, uint8(18), launchPriceX96)
                )
            )
        );
    }

    function _predict(GraphRequest calldata request)
        private
        view
        returns (address token, address hook, address custody)
    {
        token = _predictToken(request);
        hook = _predict(
            effectiveSalt(request.hookTargetIdHash, request.hookApplicantSalt),
            _hookInitCodeHash(token, request.hookUsdg, request.hookExpectedDecimals)
        );
        custody = _predict(
            effectiveSalt(request.custodyTargetIdHash, request.custodyApplicantSalt),
            keccak256(
                abi.encodePacked(
                    type(PermanentPositionCustody).creationCode, abi.encode(positionManager, 0)
                )
            )
        );
    }

    function _predict(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                )
            )
        );
    }

    function _hookInitCodeHash(address token, address hookUsdg, uint8 hookExpectedDecimals)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                type(HookemonHook).creationCode,
                abi.encode(_hookConfig(token, hookUsdg, hookExpectedDecimals))
            )
        );
    }

    function _hookConfig(address token, address hookUsdg, uint8 hookExpectedDecimals)
        private
        view
        returns (HookemonHook.ConstructorConfig memory config)
    {
        config = HookemonHook.ConstructorConfig({
            manager: poolManager,
            positionManager: positionManager,
            permit2: permit2,
            usdg: Currency.wrap(hookUsdg),
            hkmn: Currency.wrap(token),
            tickSpacing: 60,
            programmable: RobinhoodBindings.PROGRAMMABLE_BENEFICIARY,
            treasury: TREASURY,
            operations: address(0x7000),
            launchAuthority: launchAuthority,
            issuanceAuthority: address(this),
            expectedDecimals: hookExpectedDecimals,
            bindingDigest: keccak256("launch-composition-binding"),
            runtimeDigest: keccak256("launch-composition-runtime"),
            processClaimLimit6h: 1_000_000,
            processClaimLimitMax: 2_000_000,
            processClaimMaxCount: 8,
            operationsRotationDelay: 3 days
        });
    }
}

contract LaunchCompositionTest is Test, DeployPermit2 {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 private constant ALL_HOOK_PERMISSION_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_PERMISSION_MASK = 0x20CC;
    uint160 private constant USDG_CURRENCY0_SQRT_PRICE_X96 =
        161723809515207654588927258648643645224;
    uint160 private constant HKMN_CURRENCY0_SQRT_PRICE_X96 = 38813714284914462669;
    uint128 private constant USDG_CURRENCY0_LIQUIDITY = 489897948556635619;
    uint128 private constant HKMN_CURRENCY0_LIQUIDITY = 489897948572597439;
    uint256 private constant USDG_MAX = 240_000_000;
    int24 private constant TICK_LOWER = -887220;
    int24 private constant TICK_UPPER = 887220;
    address private constant ROUTER = 0x34965F2A2ee9254522232C32F02056E92BE0C98a;
    address private constant PROGRAMMABLE_GRAPH_FACTORY =
        0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd;
    address private constant TREASURY = address(0x6000);
    address private constant OWNER = address(0xA11CE);
    address private constant PAYER = address(0xBEEF);
    address private constant ATTACKER = address(0xBAD);
    bytes32 private constant TOKEN_TARGET_ID = keccak256("hkmn-token-target");
    bytes32 private constant HOOK_TARGET_ID = keccak256("hook-target");
    bytes32 private constant CUSTODY_TARGET_ID = keccak256("custody-target");

    PoolManager private manager;
    IAllowanceTransfer private permit2;
    PositionManager private positionManager;
    LaunchCompositionTestToken private usdg;
    LaunchCompositionTestToken private wrongUsdg;
    ProgrammableGraphHarness private graph;

    function setUp() external {
        manager = new PoolManager(address(this));
        permit2 = IAllowanceTransfer(deployPermit2());
        positionManager = new PositionManager(
            manager, permit2, 100_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );
        usdg = new LaunchCompositionTestToken();
        wrongUsdg = new LaunchCompositionTestToken();
        graph = new ProgrammableGraphHarness(
            manager,
            address(positionManager),
            address(permit2),
            address(usdg),
            0,
            OWNER,
            keccak256("launch-composition-route"),
            keccak256("launch-composition-nonce")
        );
        _selectReleasePriceCandidate();
    }

    function testGraphLaunchInitializesAndSeedsTheThreeProviderTargets() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        (address predictedToken, address predictedHook, address predictedCustody) =
            graph.predict(request);

        vm.prank(ROUTER);
        (HKMNToken token, HookemonHook hook, PermanentPositionCustody custody) =
            graph.launch(request);

        assertEq(address(token), predictedToken);
        assertEq(address(hook), predictedHook);
        assertEq(address(custody), predictedCustody);
        assertGt(address(token).code.length, 0);
        assertGt(address(hook).code.length, 0);
        assertGt(address(custody).code.length, 0);
        assertEq(graph.initializerCalls(address(token)), 1);
        assertEq(graph.initializerCalls(address(custody)), 1);
        assertEq(graph.initializerCalls(address(hook)), 1);
        assertEq(graph.initializedTargets(0), address(token));
        assertEq(graph.initializedTargets(1), address(custody));
        assertEq(graph.initializedTargets(2), address(hook));
        assertEq(graph.initializedSelectors(0), HKMNToken.allocate.selector);
        assertEq(
            graph.initializedSelectors(1), PermanentPositionCustody.configureBindingHook.selector
        );
        assertEq(graph.initializedSelectors(2), HookemonHook.initializeGraphLaunch.selector);
        assertTrue(hook.canonicalPoolInitialized());
        assertTrue(hook.graphMode());
        assertEq(hook.canonicalLaunchCustody(), address(custody));
        assertEq(custody.bindingHook(), address(hook));

        PoolKey memory key = _key(token, hook);
        (uint160 sqrtPriceX96,,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertEq(sqrtPriceX96, graph.launchPriceX96());

        uint256 supply = 1_000_000_000e18;
        uint256 marketAllocation = supply;
        assertEq(token.name(), "Hookemon");
        assertEq(token.symbol(), "HKMN");
        assertEq(token.decimals(), 18);
        assertEq(token.WHOLE_HKMN_SUPPLY(), 1_000_000_000);
        assertEq(token.issuanceAuthority(), address(graph));
        assertEq(token.decimals(), hook.graphExpectedDecimals());
        assertEq(token.totalSupply(), supply);
        assertEq(token.MARKET_ALLOCATION_BPS(), 10_000);
        assertEq(token.balanceOf(address(hook)), marketAllocation);
        assertEq(token.balanceOf(address(custody)), 0);
        assertEq(token.balanceOf(address(token)), 0);
        assertEq(token.balanceOf(address(graph)), 0);
        assertEq(usdg.balanceOf(address(hook)), 0);
        (bool custodyCanTransferRemainder,) =
            address(custody).call(abi.encodeWithSelector(bytes4(0xa9059cbb), OWNER, 1));
        assertFalse(custodyCanTransferRemainder);
        assertTrue(
            token.validateGraphConfiguration(
                address(hook), address(usdg), graph.launchPriceX96(), address(graph), 18
            )
        );

        vm.expectRevert(
            abi.encodeWithSelector(HKMNToken.UnauthorizedIssuanceAuthority.selector, OWNER)
        );
        vm.prank(OWNER);
        token.allocate(address(hook));
        (bool canMint,) =
            address(token).call(abi.encodeWithSignature("mint(address,uint256)", OWNER, 1));
        assertFalse(canMint);

        _approvePayer(address(hook), USDG_MAX);
        HookemonHook.SeedParams memory seedParams = _seedParams(token, hook, custody);
        vm.prank(OWNER);
        hook.seedCanonicalLiquidity(seedParams);

        uint256 positionTokenId = hook.canonicalPositionTokenId();
        assertTrue(hook.canonicalLiquiditySeeded());
        assertGt(positionTokenId, 0);
        assertEq(positionManager.nextTokenId(), positionTokenId + 1);
        assertEq(custody.positionTokenId(), positionTokenId);
        assertTrue(custody.positionReceived());
        assertEq(positionManager.ownerOf(positionTokenId), address(custody));
        assertEq(usdg.balanceOf(address(hook)), 0);
        uint256 hkmnSpent = token.balanceOf(address(manager));
        uint256 hkmnDustTransferred = token.balanceOf(TREASURY);
        assertEq(hkmnDustTransferred, 0);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(hkmnSpent, marketAllocation);
        assertEq(usdg.balanceOf(PAYER), 0);
    }

    function testWrongPriceRevertsTheWholeGraphLaunch() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        request.initializationPriceX96 = graph.launchPriceX96() + 1;

        _expectGraphLaunchRevert(request);
    }

    function testSecondInitializationRevertsWithoutChangingTheLaunchState() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        vm.prank(ROUTER);
        (HKMNToken token, HookemonHook hook, PermanentPositionCustody custody) =
            graph.launch(request);
        uint256 hookBalance = token.balanceOf(address(hook));
        uint256 custodyBalance = token.balanceOf(address(custody));
        uint160 launchPriceX96 = graph.launchPriceX96();

        vm.expectRevert(HookemonHook.CanonicalPoolAlreadyInitialized.selector);
        vm.prank(ROUTER);
        graph.initializeAgain(address(hook), address(custody), launchPriceX96);

        assertTrue(hook.canonicalPoolInitialized());
        assertEq(token.balanceOf(address(hook)), hookBalance);
        assertEq(token.balanceOf(address(custody)), custodyBalance);
    }

    function testWrongAuthorityRevertsBeforeAnyGraphTargetExists() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        (address token, address hook, address custody) = graph.predict(request);

        vm.expectRevert(
            abi.encodeWithSelector(ProgrammableGraphHarness.UnauthorizedLauncher.selector, ATTACKER)
        );
        vm.prank(ATTACKER);
        graph.launch(request);

        _assertNoGraphTargets(token, hook, custody);
    }

    function testWrongUsdgRevertsTheWholeGraphLaunch() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        request.hookUsdg = address(wrongUsdg);

        _expectGraphLaunchRevert(request);
    }

    function testCustodyMismatchRevertsTheWholeGraphLaunch() external {
        PermanentPositionCustody wrongCustody =
            new PermanentPositionCustody(address(positionManager), 0);
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        request.allocationCustody = address(wrongCustody);

        _expectGraphLaunchRevert(request);
        assertEq(usdg.balanceOf(address(wrongCustody)), 0);
    }

    function testProviderExecutorRejectsOutOfOrderTriplesAndRollsBackAllTargets() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        (address token, address hook, address custody) = graph.predict(request);
        ProgrammableGraphHarness.TargetDeployment[3] memory deployments =
            graph.providerDeployments(request);
        ProgrammableGraphHarness.TargetDeployment memory displaced = deployments[1];
        deployments[1] = deployments[2];
        deployments[2] = displaced;

        vm.expectRevert();
        vm.prank(ROUTER);
        graph.execute(deployments);

        _assertNoGraphTargets(token, hook, custody);
    }

    function testMismatchedHookExpectedDecimalsRevertsTheWholeGraphLaunch() external {
        ProgrammableGraphHarness.GraphRequest memory request = _request();
        request.hookExpectedDecimals = 6;

        _expectGraphLaunchRevert(request);
    }

    function testTokenRejectsAnIssuanceAuthorityOtherThanItsFactory() external {
        uint160 launchPriceX96 = graph.launchPriceX96();
        vm.expectRevert(HKMNToken.InvalidLaunchConfiguration.selector);
        new HKMNToken(OWNER, address(usdg), 18, launchPriceX96);
    }

    function testTokenRejectsNonCanonicalDecimals() external {
        uint160 launchPriceX96 = graph.launchPriceX96();
        vm.expectRevert(HKMNToken.InvalidLaunchConfiguration.selector);
        new HKMNToken(address(this), address(usdg), 6, launchPriceX96);
    }

    function testGraphModeRejectsLegacyInitializerForMalformedToken() external {
        LaunchCompositionTestToken malformedToken = new LaunchCompositionTestToken();
        bytes32 initCodeHash =
            graph.graphHookInitCodeHash(address(malformedToken), address(usdg), 18);
        bytes32 applicantSalt = _findHookApplicantSalt(initCodeHash);
        address predicted = vm.computeCreate2Address(
            graph.effectiveSalt(HOOK_TARGET_ID, applicantSalt), initCodeHash, address(graph)
        );

        vm.prank(ROUTER);
        HookemonHook malformedHook =
            graph.deployGraphModeHook(applicantSalt, address(malformedToken), address(usdg), 18);
        assertEq(address(malformedHook), predicted);
        assertTrue(malformedHook.graphMode());
        uint160 launchPriceX96 = graph.launchPriceX96();

        vm.expectRevert(HookemonHook.InvalidGraphIssuance.selector);
        vm.prank(OWNER);
        malformedHook.initializeCanonicalPool(launchPriceX96);

        assertFalse(malformedHook.canonicalPoolInitialized());
    }

    function testKnownProviderFactoryRejectsMismatchedAuthorityBeforeLegacyInitialization()
        external
    {
        LaunchCompositionTestToken malformedToken = new LaunchCompositionTestToken();
        HookemonHook.ConstructorConfig memory config =
            _knownFactoryHookConfig(address(malformedToken));
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(config)));
        bytes32 salt = _findDirectHookSalt(PROGRAMMABLE_GRAPH_FACTORY, initCodeHash);
        KnownProviderFactory implementation = new KnownProviderFactory();
        vm.etch(PROGRAMMABLE_GRAPH_FACTORY, address(implementation).code);

        vm.expectRevert(HookemonHook.InvalidConstructorConfig.selector);
        KnownProviderFactory(PROGRAMMABLE_GRAPH_FACTORY).deploy(salt, config);
    }

    function _expectGraphLaunchRevert(ProgrammableGraphHarness.GraphRequest memory request)
        private
    {
        (address token, address hook, address custody) = graph.predict(request);

        vm.expectRevert();
        vm.prank(ROUTER);
        graph.launch(request);

        _assertNoGraphTargets(token, hook, custody);
    }

    function _assertNoGraphTargets(address token, address hook, address custody) private view {
        assertEq(token.code.length, 0);
        assertEq(hook.code.length, 0);
        assertEq(custody.code.length, 0);
    }

    function _request()
        private
        view
        returns (ProgrammableGraphHarness.GraphRequest memory request)
    {
        request = ProgrammableGraphHarness.GraphRequest({
                tokenTargetIdHash: TOKEN_TARGET_ID,
                hookTargetIdHash: HOOK_TARGET_ID,
                custodyTargetIdHash: CUSTODY_TARGET_ID,
                tokenApplicantSalt: keccak256("launch-composition-token-salt"),
                hookApplicantSalt: bytes32(0),
                custodyApplicantSalt: keccak256("launch-composition-custody-salt"),
                initializationPriceX96: graph.launchPriceX96(),
                hookUsdg: address(usdg),
                allocationCustody: address(0),
                hookExpectedDecimals: 18
            });
        bytes32 hookInitCodeHash = graph.hookInitCodeHash(request);
        request.hookApplicantSalt = _findHookApplicantSalt(hookInitCodeHash);
    }

    function _findHookApplicantSalt(bytes32 hookInitCodeHash) private view returns (bytes32) {
        for (uint256 nonce; nonce < 2_000_000; ++nonce) {
            bytes32 applicantSalt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(
                graph.effectiveSalt(HOOK_TARGET_ID, applicantSalt), hookInitCodeHash, address(graph)
            );
            if ((uint160(predicted) & ALL_HOOK_PERMISSION_MASK) == REQUIRED_HOOK_PERMISSION_MASK) {
                return applicantSalt;
            }
        }
        revert("valid provider hook salt not found");
    }

    function _findDirectHookSalt(address factory, bytes32 initCodeHash)
        private
        pure
        returns (bytes32 salt)
    {
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            salt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(salt, initCodeHash, factory);
            if ((uint160(predicted) & ALL_HOOK_PERMISSION_MASK) == REQUIRED_HOOK_PERMISSION_MASK) {
                return salt;
            }
        }
        revert("valid known-provider hook salt not found");
    }

    function _knownFactoryHookConfig(address token)
        private
        view
        returns (HookemonHook.ConstructorConfig memory config)
    {
        config = HookemonHook.ConstructorConfig({
            manager: manager,
            positionManager: address(positionManager),
            permit2: address(permit2),
            usdg: Currency.wrap(address(usdg)),
            hkmn: Currency.wrap(token),
            tickSpacing: 60,
            programmable: RobinhoodBindings.PROGRAMMABLE_BENEFICIARY,
            treasury: TREASURY,
            operations: address(0x7000),
            launchAuthority: OWNER,
            issuanceAuthority: OWNER,
            expectedDecimals: 18,
            bindingDigest: keccak256("known-provider-binding"),
            runtimeDigest: keccak256("known-provider-runtime"),
            processClaimLimit6h: 1_000_000,
            processClaimLimitMax: 2_000_000,
            processClaimMaxCount: 8,
            operationsRotationDelay: 3 days
        });
    }

    function _key(HKMNToken token, HookemonHook hook) private view returns (PoolKey memory) {
        address currency0 = address(usdg) < address(token) ? address(usdg) : address(token);
        address currency1 = currency0 == address(usdg) ? address(token) : address(usdg);
        return
            PoolKey(
                Currency.wrap(currency0), Currency.wrap(currency1), 0, 60, IHooks(address(hook))
            );
    }

    function _approvePayer(address hook, uint256 amount) private {
        usdg.mint(PAYER, amount);
        vm.startPrank(PAYER);
        usdg.approve(address(permit2), amount);
        permit2.approve(address(usdg), hook, uint160(amount), type(uint48).max);
        vm.stopPrank();
    }

    function _seedParams(HKMNToken token, HookemonHook hook, PermanentPositionCustody custody)
        private
        view
        returns (HookemonHook.SeedParams memory params)
    {
        uint256 hkmnMax = token.balanceOf(address(hook));
        bool usdgIsCurrency0 = address(usdg) < address(token);
        params = HookemonHook.SeedParams({
            tickLower: TICK_LOWER,
            tickUpper: TICK_UPPER,
            liquidity: usdgIsCurrency0 ? USDG_CURRENCY0_LIQUIDITY : HKMN_CURRENCY0_LIQUIDITY,
            amount0Max: uint128(usdgIsCurrency0 ? USDG_MAX : hkmnMax),
            amount1Max: uint128(usdgIsCurrency0 ? hkmnMax : USDG_MAX),
            deadline: block.timestamp + 1,
            payer: PAYER,
            custody: address(custody)
        });
    }

    function _selectReleasePriceCandidate() private {
        graph.setLaunchPriceX96(USDG_CURRENCY0_SQRT_PRICE_X96);
        (address usdgCurrency0Token,,) = graph.predict(_request());
        if (address(usdg) < usdgCurrency0Token) return;

        graph.setLaunchPriceX96(HKMN_CURRENCY0_SQRT_PRICE_X96);
        (address hkmnCurrency0Token,,) = graph.predict(_request());
        assertLt(uint160(hkmnCurrency0Token), uint160(address(usdg)));
    }
}
