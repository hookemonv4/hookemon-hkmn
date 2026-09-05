// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "../../lib/v4-core/lib/forge-std/src/Test.sol";
import { Vm } from "../../lib/v4-core/lib/forge-std/src/Vm.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { CustomRevert } from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import { IV4Router } from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import { IV4Quoter } from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import { IStateView } from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";
import { Actions } from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";

import { HookemonHook } from "../../src/HookemonHook.sol";
import { CanonicalMarketCallback } from "../../src/market/CanonicalMarket.sol";
import { FeeAccounting } from "../../src/accounting/FeeAccounting.sol";
import { MoneyRoles } from "../../src/access/MoneyRoles.sol";
import {
    PermanentPositionCustody,
    RobinhoodBindings
} from "../../src/bindings/RobinhoodBindings.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";
import { ProgrammableGraphHarness } from "../launch/LaunchComposition.t.sol";

interface IArchiveForkVm {
    function getRawBlockHeader(uint256 blockNumber) external view returns (bytes memory rlpHeader);
}

interface IArchiveErc20 {
    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);
}

interface IArchiveUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
        external
        payable;
}

interface IArchiveGraphFactory {
    struct GraphAuthorization {
        bytes32 routeNamespace;
        bytes32 routeNonce;
        bytes32 topologyHash;
        bytes32 graphCommitment;
        address authorizedLauncher;
        uint256 totalValue;
    }

    struct Target {
        bytes32 targetIdHash;
        bytes32 applicantSalt;
        uint256 deploymentValue;
        uint256 initializerValue;
        bytes initCode;
        bytes initializerCalldata;
    }

    function computeGraphCommitment(
        GraphAuthorization calldata authorization,
        Target[] calldata targets
    ) external view returns (bytes32 commitment, uint256 targetValueSum);

    function deployGraph(GraphAuthorization calldata authorization, Target[] calldata targets)
        external
        payable
        returns (
            address[] memory deployments,
            bytes32[] memory runtimeCodeHashes,
            bytes[] memory runtimeCodes,
            bytes32 graphDeploymentHash
        );

    function predictTarget(GraphAuthorization calldata authorization, Target calldata target)
        external
        view
        returns (address);
}

interface IArchiveStampRouter {
    enum LaunchKindV1 {
        Invalid,
        CustomGraph,
        Classic
    }

    enum ComponentKindV1 {
        Other,
        Token,
        Hook
    }

    enum ComponentScopeV1 {
        Invalid,
        Exclusive,
        SharedInfrastructure
    }

    struct ExpectedGraphOutputV1 {
        uint8 targetIndex;
        bytes32 targetIdHash;
        address account;
        bytes32 runtimeCodeHash;
    }

    struct CustomGraphRouteV1 {
        bytes32 routeNamespace;
        bytes32 routeNonce;
        bytes32 topologyHash;
        bytes32 graphCommitment;
        IArchiveGraphFactory.Target[] targets;
        ExpectedGraphOutputV1[] expectedOutputs;
        bytes32 expectedGraphDeploymentHash;
    }

    struct ComponentV1 {
        uint8 resultIndex;
        address account;
        bytes32 runtimeCodeHash;
        ComponentKindV1 kind;
        ComponentScopeV1 scope;
    }

    struct StampRequestV1 {
        bytes32 launchId;
        address token;
        bytes32 tokenRuntimeCodeHash;
        PoolKey poolKey;
        bytes32 hookRuntimeCodeHash;
        ComponentV1[] components;
    }

    struct LaunchPermitV1 {
        uint256 chainId;
        address router;
        address launchWallet;
        LaunchKindV1 kind;
        bytes32 routePayloadHash;
        bytes32 expectedResultHash;
        bytes32 stampRequestHash;
        bytes32 nonce;
        uint64 validAfter;
        uint64 deadline;
        uint256 value;
    }

    function GRAPH_FACTORY() external view returns (address);

    function GRAPH_FACTORY_RUNTIME_CODE_HASH() external view returns (bytes32);

    function PERMIT_AUTHORITY() external view returns (address);

    function PERMIT_AUTHORITY_RUNTIME_CODE_HASH() external view returns (bytes32);

    function POOL_MANAGER() external view returns (address);

    function POOL_MANAGER_RUNTIME_CODE_HASH() external view returns (bytes32);

    function CHAIN_ID() external view returns (uint256);

    function computeStampRequestHash(StampRequestV1 calldata request)
        external
        pure
        returns (bytes32);

    function launchAndStampV1(
        LaunchPermitV1 calldata permit,
        StampRequestV1 calldata stampRequest,
        bytes calldata routePayload,
        bytes calldata signature
    ) external payable returns (bytes32 stampHash);

    function launchIdByToken(address token) external view returns (bytes32 launchId);

    function launchIdByComponent(address component) external view returns (bytes32 launchId);

    function componentRuntimeCodeHash(address component) external view returns (bytes32);
}

interface IArchivePermitAuthority {
    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4);
}

contract RobinhoodV4ArchiveForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 private constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 private constant PINNED_BLOCK = 54_484_625;
    bytes32 private constant PINNED_BLOCK_HASH =
        0x88959d6f23a8b713b923fbed50459580c56a1ba5acb4e65707594673bcc26743;
    address private constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 private constant POOL_MANAGER_RUNTIME_CODEHASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    address private constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    bytes32 private constant POSITION_MANAGER_RUNTIME_CODEHASH =
        0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2;
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 private constant PERMIT2_RUNTIME_CODEHASH =
        0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca;
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    bytes32 private constant USDG_PROXY_RUNTIME_CODEHASH =
        0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6;
    address private constant USDG_IMPLEMENTATION = 0x68184C449E1a8f34fA18d289737129FD27B66f8F;
    bytes32 private constant USDG_IMPLEMENTATION_RUNTIME_CODEHASH =
        0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf;
    address private constant GRAPH_FACTORY = 0x0B6b3F40f84Df25D3bd69238f937096177DD09Bd;
    bytes32 private constant GRAPH_FACTORY_RUNTIME_CODEHASH =
        0xd23692fae59331592048e71a96d4963e170ee56e449683dc9f7fa3f9470018b8;
    address private constant PERMIT_AUTHORITY = 0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06;
    bytes32 private constant PERMIT_AUTHORITY_RUNTIME_CODEHASH =
        0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c;
    bytes32 private constant PROVIDER_ROUTER_RUNTIME_CODEHASH =
        0x1dbbdaaad901ea3c6134dca0d4872a4789b3c071bf8ccfb44edd65d26d817388;
    address private constant UNIVERSAL_ROUTER = 0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99;
    bytes32 private constant UNIVERSAL_ROUTER_RUNTIME_CODEHASH =
        0xbe8e8191bb42d843c2e948a5a55772eaab864ce01e54dcd47c9d089170b302d5;
    address private constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    bytes32 private constant V4_QUOTER_RUNTIME_CODEHASH =
        0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6;
    address private constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    bytes32 private constant STATE_VIEW_RUNTIME_CODEHASH =
        0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6;
    bytes32 private constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant POOL_SWAP_EVENT =
        keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    bytes32 private constant SWAP_LIABILITIES_ACCRUED_EVENT = keccak256(
        "SwapLiabilitiesAccrued(uint256,uint256,address,uint256,address,uint256,uint256,uint256,uint256,uint256)"
    );
    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint128 private constant USDG_SEED_AMOUNT = 240_000_000;
    uint256 private constant HKMN_POOL_ALLOCATION = 1_000_000_000e18;
    uint128 private constant USDG_CURRENCY0_LIQUIDITY = 489897948556635619;
    uint128 private constant HKMN_CURRENCY0_LIQUIDITY = 489897948572597439;
    int24 private constant TICK_LOWER = -887220;
    int24 private constant TICK_UPPER = 887220;
    uint128 private constant USDG_ROUTER_TRADE_AMOUNT = 10_000_000;
    uint128 private constant HKMN_ROUTER_TRADE_AMOUNT = 10_000_000e18;
    uint128 private constant NON_DIVISIBLE_USDG_ROUTER_TRADE_AMOUNT = 1_499;
    uint128 private constant USDG_ROUTER_EXACT_OUTPUT_AMOUNT = 5_000_000;
    uint128 private constant HKMN_ROUTER_EXACT_OUTPUT_AMOUNT = 5_000_000e18;
    uint128 private constant USDG_ROUTER_FUNDING_AMOUNT = 250_000_000;
    uint128 private constant HKMN_PARTIAL_FILL_AMOUNT = 10 ** 37;
    uint256 private constant GENESIS_GAS_ENVELOPE_LIMIT = 30_000_000;
    uint256 private constant PROVIDER_ROUTE_GAS_MARGIN = 1_000_000;
    uint256 private constant EVM_TRANSACTION_BASE_GAS = 21_000;
    uint256 private constant EVM_ZERO_CALLDATA_BYTE_GAS = 4;
    uint256 private constant EVM_NONZERO_CALLDATA_BYTE_GAS = 16;
    uint160 private constant USDG_CURRENCY0_SQRT_PRICE_X96 =
        161723809515207654588927258648643645224;
    uint160 private constant HKMN_CURRENCY0_SQRT_PRICE_X96 = 38813714284914462669;
    bytes32 private constant TARGET_SALT_TYPEHASH = keccak256(
        "ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)"
    );
    bytes32 private constant EXPECTED_GRAPH_OUTPUT_TYPEHASH = keccak256(
        "ProgrammableExpectedGraphOutputV1(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)"
    );
    bytes32 private constant EXPECTED_GRAPH_RESULT_TYPEHASH = keccak256(
        "ProgrammableExpectedGraphResultV1(bytes32 expectedOutputsHash,bytes32 graphDeploymentHash)"
    );
    address private constant TREASURY = address(0x6000);
    address private constant GRAPH_OPERATIONS = address(0x7000);
    address private constant PROVIDER_LAUNCHER = 0x34965F2A2ee9254522232C32F02056E92BE0C98a;
    address private constant AUTHORITY = address(0xA11CE);
    address private constant PAYER = address(0xBEEF);
    address private constant SECOND_PAYER = address(0xBEE2);
    address private constant THIRD_PAYER = address(0xBEE3);
    address private constant UNFUNDED_PAYER = address(0xBEE4);
    address private constant TRADER = address(0xCAFE);
    address private constant SECOND_TRADER = address(0xCAFE2);
    address private constant THIRD_PARTY = address(0xD00D);
    bytes32 private constant TOKEN_TARGET_ID = keccak256("hkmn-token-target");
    bytes32 private constant HOOK_TARGET_ID = keccak256("hook-target");
    bytes32 private constant CUSTODY_TARGET_ID = keccak256("custody-target");
    bytes32 private constant PROVIDER_GAS_TOKEN_TARGET_ID =
        keccak256("phase-three-gas-token-target-v1");
    bytes32 private constant PROVIDER_GAS_CUSTODY_TARGET_ID =
        keccak256("phase-three-gas-custody-target-v1");
    bytes32 private constant PROVIDER_GAS_HOOK_TARGET_ID =
        keccak256("phase-three-gas-hook-target-v1");
    bytes32 private constant PROVIDER_GAS_TOKEN_RUNTIME_CODEHASH =
        0x2aa20909e57ee56fb5b49a02b96d11572fa4ef677c73b2d42dc19dad4e30454f;
    bytes32 private constant PROVIDER_GAS_CUSTODY_RUNTIME_CODEHASH =
        0x0d63637b005fc544332b142fa4debae3af6e3bc14dc7493a718b2154a70dfb87;
    bytes32 private constant PROVIDER_GAS_HOOK_RUNTIME_CODEHASH =
        0x2ca1fa1c1a23730bc06cb37a8bd38e1cc61e62880c84fa6022d7b23d94e79051;
    bytes32 private constant PROVIDER_GAS_GRAPH_DEPLOYMENT_HASH =
        0xe1b2b55129c74cc24d49d5da4f80d7573bb61b4e43bf1ed653950409d3dda0ef;
    bytes32 private constant PROVIDER_GAS_ROUTE_NAMESPACE =
        keccak256("phase-three-provider-gas-namespace-v1");
    bytes32 private constant PROVIDER_GAS_ROUTE_NONCE =
        keccak256("phase-three-provider-gas-nonce-v1");
    bytes32 private constant PROVIDER_GAS_TOPOLOGY_HASH =
        keccak256("phase-three-provider-gas-topology-v1");
    bytes32 private constant PROVIDER_GAS_LAUNCH_ID =
        keccak256("phase-three-provider-gas-launch-id-v1");

    error ProviderRouteGasEnvelopeExceeded(uint256 observedGas, uint256 documentedMargin);
    error ProviderTokenOrderNotFound();
    error ProviderHookSaltNotFound();

    struct Market {
        HKMNToken token;
        HookemonHook hook;
        PermanentPositionCustody custody;
        ProgrammableGraphHarness executor;
        address tokenPredicted;
        address hookPredicted;
        address custodyPredicted;
    }

    struct ProviderGraphPlan {
        IArchiveGraphFactory.GraphAuthorization authorization;
        IArchiveGraphFactory.Target[] targets;
        address token;
        address custody;
        address hook;
        uint160 initializationPriceX96;
    }

    struct ProviderGraphObservation {
        address[] deployments;
        bytes32[] runtimeCodeHashes;
        bytes[] runtimeCodes;
        bytes32 graphDeploymentHash;
    }

    struct ProviderRouteEnvelope {
        bytes routePayload;
        IArchiveStampRouter.StampRequestV1 stampRequest;
        IArchiveStampRouter.LaunchPermitV1 permit;
    }

    struct ProviderRouteGasObservation {
        uint256 calleeGas;
        uint256 calldataBytes;
        uint256 calldataGas;
        uint256 intrinsicTransactionGas;
        uint256 transactionGas;
    }

    struct FeeSnapshot {
        uint256 usdgBalance;
        uint256 liability;
        uint256 programmable;
        uint256 treasury;
        uint256 process;
    }

    struct RouterUsdgObservation {
        int128 rawPoolDelta;
        int256 traderDelta;
        int256 managerDelta;
        int256 routerDelta;
        int256 hookDelta;
        uint256 fee;
        uint256 gross;
        uint256 accruedGross;
        uint256 accruedFee;
        uint256 accruedProgrammable;
        uint256 accruedTreasury;
        uint256 accruedProcess;
        FeeRemainders remainders;
    }

    struct RouterUsdgBalances {
        uint256 trader;
        uint256 manager;
        uint256 router;
        uint256 hook;
    }

    struct RouterRollbackSnapshot {
        FeeSnapshot fees;
        RouterUsdgBalances usdgBalances;
        uint256 traderHkmn;
        uint256 managerHkmn;
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
        uint128 liquidity;
    }

    struct FeeRemainders {
        uint256 programmable;
        uint256 treasury;
        uint256 process;
    }

    struct ClaimedFees {
        uint256 programmable;
        uint256 treasury;
        uint256 process;
    }

    struct FeeAccrual {
        uint256 gross;
        uint256 programmable;
        uint256 treasury;
        uint256 process;
        uint256 total;
        FeeRemainders remainders;
    }

    struct Permit2AllowanceSnapshot {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct SeedSnapshot {
        uint256 payerUsdg;
        uint256 hookUsdg;
        uint256 poolManagerUsdg;
        uint256 positionManagerUsdg;
        uint256 payerHkmn;
        uint256 hookHkmn;
        uint256 poolManagerHkmn;
        uint256 positionManagerHkmn;
        uint256 payerUsdgPermit2Allowance;
        uint256 hookUsdgPermit2Allowance;
        uint256 hookHkmnPermit2Allowance;
        Permit2AllowanceSnapshot payerUsdgToHook;
        Permit2AllowanceSnapshot hookUsdgToPositionManager;
        Permit2AllowanceSnapshot hookHkmnToPositionManager;
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
        uint128 liquidity;
        uint256 nextTokenId;
        address custodyBindingHook;
        uint256 custodyPositionTokenId;
        bool custodyPositionReceived;
        bool canonicalPoolInitialized;
        bool canonicalLiquiditySeeded;
        uint256 canonicalPositionTokenId;
        address canonicalLaunchCustody;
    }

    struct QuoteState {
        FeeSnapshot fees;
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
        uint128 liquidity;
        uint256 lastExecutedUsdg;
        int128 lastRawPoolUsdgDelta;
        uint256 managerCurrency0;
        uint256 managerCurrency1;
        uint256 hookCurrency0;
        uint256 hookCurrency1;
    }

    IPoolManager private manager;
    IStateView private stateView;
    PositionManager private positionManager;
    IV4Quoter private v4Quoter;
    IAllowanceTransfer private permit2;
    ProgrammableGraphHarness private graph;
    HKMNToken private hkmn;
    HookemonHook private hook;
    PermanentPositionCustody private custody;
    address private tokenPredicted;
    address private hookPredicted;
    address private custodyPredicted;
    uint256 private nextTokenIdBeforeSeed;
    mapping(address target => uint256 gross) private observedGrossUsdg;
    mapping(address target => FeeRemainders remainders) private observedFeeRemainders;

    function setUp() external {
        vm.createSelectFork(vm.envString("ROBINHOOD_FORK_RPC_URL"), PINNED_BLOCK);
        _assertPinnedRuntimeBundle();
        manager = IPoolManager(POOL_MANAGER);
        stateView = IStateView(STATE_VIEW);
        assertEq(address(stateView.poolManager()), POOL_MANAGER, "StateView PoolManager drifted");
        positionManager = PositionManager(payable(POSITION_MANAGER));
        v4Quoter = IV4Quoter(V4_QUOTER);
        assertEq(address(v4Quoter.poolManager()), POOL_MANAGER, "V4Quoter PoolManager drifted");
        permit2 = IAllowanceTransfer(PERMIT2);
        _deployThreeTargets();
        _launchAndSeed();
        _assertSolvent();
    }

    function testArchiveForkIsMandatoryAndPinned() external view {
        assertEq(block.chainid, ROBINHOOD_CHAIN_ID, "archive fork was not selected");
        assertEq(block.number, PINNED_BLOCK, "archive fork block drifted");

        assertEq(
            keccak256(IArchiveForkVm(address(vm)).getRawBlockHeader(PINNED_BLOCK)),
            PINNED_BLOCK_HASH,
            "archive header hash drifted"
        );
    }

    function testLaunchAndSeedUseThePinnedProviderContracts() external view {
        assertTrue(address(hook) != address(0), "launch target was not deployed");
        assertEq(address(hkmn), tokenPredicted, "token CREATE2 reproduction failed");
        assertEq(address(hook), hookPredicted, "hook CREATE2 reproduction failed");
        assertEq(address(custody), custodyPredicted, "custody CREATE2 reproduction failed");
        assertEq(custody.bindingHook(), address(hook), "custody binding hook drifted");
        assertTrue(
            hook.canonicalPoolInitialized(), "launch transaction did not initialize the pool"
        );
        assertTrue(hook.canonicalLiquiditySeeded(), "seed transaction did not mint liquidity");
        assertEq(positionManager.ownerOf(hook.canonicalPositionTokenId()), address(custody));
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(_canonicalKey().toId());
        assertEq(sqrtPriceX96, graph.launchPriceX96(), "harness launch price drifted");
        assertEq(
            sqrtPriceX96,
            _usdgIsCurrency0() ? USDG_CURRENCY0_SQRT_PRICE_X96 : HKMN_CURRENCY0_SQRT_PRICE_X96,
            "release price candidate drifted"
        );
        _assertStateViewMatchesManager(_canonicalKey());
    }

    function testProviderRouterMeasuresThreeTargetGraphAndWritesStamp() external {
        IArchiveGraphFactory factory = IArchiveGraphFactory(GRAPH_FACTORY);
        IArchiveStampRouter router = IArchiveStampRouter(PROVIDER_LAUNCHER);
        ProviderGraphPlan memory plan = _buildProviderGraphPlan(factory);
        ProviderGraphObservation memory observation = _observeProviderGraph(factory, plan);
        assertEq(
            observation.graphDeploymentHash,
            PROVIDER_GAS_GRAPH_DEPLOYMENT_HASH,
            "provider graph deployment hash pin drifted"
        );
        emit log_named_bytes32("provider graph deployment hash", observation.graphDeploymentHash);
        ProviderRouteEnvelope memory envelope = _providerRouteEnvelope(router, plan, observation);
        ProviderRouteGasObservation memory gasObservation = _launchProviderRoute(router, envelope);

        _assertProviderPostLaunchState(
            plan, envelope.stampRequest, observation.runtimeCodeHashes, router
        );
        _assertProviderRouteGasEnvelope(gasObservation.transactionGas, PROVIDER_ROUTE_GAS_MARGIN);
        emit log_named_uint("provider route callee gas", gasObservation.calleeGas);
        emit log_named_uint("provider route calldata bytes", gasObservation.calldataBytes);
        emit log_named_uint("provider route calldata gas", gasObservation.calldataGas);
        emit log_named_uint(
            "provider route intrinsic transaction gas", gasObservation.intrinsicTransactionGas
        );
        emit log_named_uint(
            "provider route aggregate transaction gas", gasObservation.transactionGas
        );
        emit log_named_uint("provider route documented margin", PROVIDER_ROUTE_GAS_MARGIN);
        emit log_named_uint(
            "provider route remaining genesis envelope gas",
            GENESIS_GAS_ENVELOPE_LIMIT - gasObservation.transactionGas - PROVIDER_ROUTE_GAS_MARGIN
        );
    }

    function testProviderRouteGasEnvelopeRejectsOversizedMargin() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                ProviderRouteGasEnvelopeExceeded.selector, GENESIS_GAS_ENVELOPE_LIMIT, uint256(0)
            )
        );
        this.assertProviderRouteGasEnvelope(GENESIS_GAS_ENVELOPE_LIMIT - 1, 1, 0);
    }

    function testProviderRouteIntrinsicGasCountsBaseAndCalldataBytes() external pure {
        assertEq(_providerRouteIntrinsicGas(hex""), 21_000, "transaction base gas drifted");
        assertEq(_providerRouteIntrinsicGas(hex"0001"), 21_020, "calldata gas accounting drifted");
    }

    function assertProviderRouteGasEnvelope(
        uint256 calleeGas,
        uint256 intrinsicTransactionGas,
        uint256 documentedMargin
    ) external pure {
        _assertProviderRouteGasEnvelope(calleeGas + intrinsicTransactionGas, documentedMargin);
    }

    function testArchiveForkLaunchUsesProviderOrderedGraphInitializers() external view {
        HKMNToken graphToken = HKMNToken(address(hkmn));

        assertEq(graphToken.issuanceAuthority(), address(graph), "token issuance authority drifted");
        assertEq(graphToken.decimals(), 18, "token decimals drifted");
        assertTrue(graphToken.allocated(), "token allocation was not completed");
        assertEq(graph.initializerCalls(address(graphToken)), 1, "token initializer count drifted");
        assertEq(graph.initializerCalls(address(custody)), 1, "custody initializer count drifted");
        assertEq(graph.initializerCalls(address(hook)), 1, "hook initializer count drifted");
        assertEq(
            graph.initializedTargets(0), address(graphToken), "token initializer order drifted"
        );
        assertEq(graph.initializedTargets(1), address(custody), "custody initializer order drifted");
        assertEq(graph.initializedTargets(2), address(hook), "hook initializer order drifted");
        assertEq(graph.initializedSelectors(0), HKMNToken.allocate.selector);
        assertEq(
            graph.initializedSelectors(1), PermanentPositionCustody.configureBindingHook.selector
        );
        assertEq(graph.initializedSelectors(2), HookemonHook.initializeGraphLaunch.selector);
        assertTrue(hook.graphMode(), "hook did not enter graph mode");
        assertEq(hook.canonicalLaunchCustody(), address(custody), "graph custody drifted");
        assertEq(
            hook.canonicalPositionTokenId(), nextTokenIdBeforeSeed, "minted position ID drifted"
        );
        assertEq(
            positionManager.nextTokenId(), nextTokenIdBeforeSeed + 1, "position ID snapshot drifted"
        );
    }

    function testUniversalRouterExactInputCollectsTheGrossUsdgFee() external {
        _fundRouterTrader(hkmn, TRADER);
        uint256 hookBalanceBefore = IArchiveErc20(USDG).balanceOf(address(hook));
        uint256 liabilityBefore = hook.totalLiability();

        RouterUsdgObservation memory route =
            _executeExactInput(TRADER, _usdgIsCurrency0(), USDG_ROUTER_TRADE_AMOUNT);

        uint256 expectedFee = uint256(USDG_ROUTER_TRADE_AMOUNT) * 300 / 10_000;
        (uint256 programmable, uint256 treasury, uint256 process) =
            hook.readFeeLiabilities(TREASURY);
        assertEq(hook.lastExecutedUsdg(), USDG_ROUTER_TRADE_AMOUNT, "gross USDG mismatch");
        assertEq(route.gross, USDG_ROUTER_TRADE_AMOUNT, "router-derived gross USDG mismatch");
        assertEq(route.fee, expectedFee, "router-derived USDG fee mismatch");
        assertEq(IArchiveErc20(USDG).balanceOf(address(hook)) - hookBalanceBefore, expectedFee);
        assertEq(hook.totalLiability() - liabilityBefore, expectedFee);
        assertEq(programmable, uint256(USDG_ROUTER_TRADE_AMOUNT) * 10 / 10_000);
        assertEq(treasury, uint256(USDG_ROUTER_TRADE_AMOUNT) * 40 / 10_000);
        assertEq(process, uint256(USDG_ROUTER_TRADE_AMOUNT) * 250 / 10_000);
        _assertSolvent();
    }

    function testV4QuoterAndUniversalRouterCoverEightFeeQuadrantsAcrossBothTokenOrders() external {
        Market memory inverseOrder = _deploySeededMarket(false, SECOND_PAYER);
        Market memory primaryOrder = Market({
            token: hkmn,
            hook: hook,
            custody: custody,
            executor: graph,
            tokenPredicted: tokenPredicted,
            hookPredicted: hookPredicted,
            custodyPredicted: custodyPredicted
        });
        assertTrue(_usdgIsCurrency0(), "first market token order drifted");
        assertFalse(
            Currency.unwrap(_canonicalKeyFor(inverseOrder.token, inverseOrder.hook).currency0)
                == USDG,
            "second market token order drifted"
        );
        _fundRouterTrader(primaryOrder.token, TRADER);
        _fundRouterTrader(inverseOrder.token, SECOND_TRADER);
        _runAllQuoteAndRouterQuadrants(primaryOrder, TRADER);
        _runAllQuoteAndRouterQuadrants(inverseOrder, SECOND_TRADER);
        assertGt(
            hook.totalLiability() + inverseOrder.hook.totalLiability(),
            0,
            "fee quadrants did not run"
        );
    }

    function testUniversalRouterSlippageMinimumRevertsAtomically() external {
        _fundRouterTrader(hkmn, TRADER);
        PoolKey memory key = _canonicalKey();
        RouterRollbackSnapshot memory before = _routerRollbackSnapshot(hkmn, hook, key, TRADER);
        uint128 quotedAmountOut =
            _quoteExactInput(hook, key, _usdgIsCurrency0(), USDG_ROUTER_TRADE_AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IV4Router.V4TooLittleReceived.selector, type(uint128).max, uint256(quotedAmountOut)
            )
        );
        _executeExactInputViaRouter(
            TRADER, key, _usdgIsCurrency0(), USDG_ROUTER_TRADE_AMOUNT, type(uint128).max
        );

        _assertRouterRollback(hkmn, hook, key, TRADER, before);
        _assertSolvent();
    }

    function testPartialFillPolicyRevertsAtCanonicalFinalization() external {
        _fundRouterTrader(hkmn, TRADER);
        deal(address(hkmn), TRADER, HKMN_PARTIAL_FILL_AMOUNT);
        assertEq(
            hkmn.balanceOf(TRADER), HKMN_PARTIAL_FILL_AMOUNT, "HKMN partial-fill funding mismatch"
        );
        PoolKey memory key = _canonicalKey();
        RouterRollbackSnapshot memory before = _routerRollbackSnapshot(hkmn, hook, key, TRADER);

        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(CanonicalMarketCallback.InvalidFinalizedSwap.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        _executeExactInputViaRouter(TRADER, key, !_usdgIsCurrency0(), HKMN_PARTIAL_FILL_AMOUNT, 0);

        _assertRouterRollback(hkmn, hook, key, TRADER, before);
        _assertSolvent();
    }

    function testClaimsRespectTheSixHourBoundaryAndConfiguredDestinations() external {
        address programmable = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
        address operations = GRAPH_OPERATIONS;
        _fundRouterTrader(hkmn, TRADER);
        _executeExactInputAndAssert(
            hook, TRADER, _canonicalKey(), _usdgIsCurrency0(), USDG_ROUTER_TRADE_AMOUNT
        );

        (uint256 programmableLiability, uint256 treasuryLiability, uint256 processLiability) =
            hook.readFeeLiabilities(TREASURY);
        assertEq(processLiability, 250_000, "process fee did not fill the six-hour cap");
        _assertClaimAuthorizationGuards(programmable, operations);

        _claimProgrammableAndAssert(programmableLiability / 2, programmable);
        _claimProgrammableAndAssert(programmableLiability - programmableLiability / 2, THIRD_PARTY);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        vm.prank(programmable);
        hook.claimProgrammable(1, programmable);

        _claimTreasuryAndAssert(treasuryLiability / 2, TREASURY);
        _claimTreasuryAndAssert(treasuryLiability - treasuryLiability / 2, THIRD_PARTY);
        vm.expectRevert(FeeAccounting.InvalidLiabilityAmount.selector);
        vm.prank(TREASURY);
        hook.claimTreasury(1, TREASURY);

        uint256 claimTimestamp = block.timestamp;
        _claimProcessAndAssert(bytes32("process-one"), processLiability, operations);
        vm.expectRevert(HookemonHook.ProcessClaimCycleAlreadyUsed.selector);
        vm.prank(operations);
        hook.claimProcess(bytes32("process-one"), 1, operations);

        for (uint256 tradeIndex; tradeIndex < 4; ++tradeIndex) {
            _executeExactInputAndAssert(
                hook, TRADER, _canonicalKey(), _usdgIsCurrency0(), USDG_ROUTER_TRADE_AMOUNT
            );
        }
        uint256 secondProcessLiability = hook.processLiability();
        assertEq(
            secondProcessLiability, 1_000_000, "process liability did not reach graph capacity"
        );
        vm.warp(claimTimestamp + 21_599);
        FeeSnapshot memory beforeEarlyProcessClaim = _feeSnapshot(hook);
        vm.expectRevert(HookemonHook.ProcessClaimCapacityExceeded.selector);
        vm.prank(operations);
        hook.claimProcess(bytes32("process-two"), secondProcessLiability, operations);
        _assertFeeSnapshotUnchanged(hook, beforeEarlyProcessClaim);
        _assertSolvent();

        vm.warp(claimTimestamp + 21_600);
        _claimProcessAndAssert(bytes32("process-two"), secondProcessLiability, operations);
    }

    function testGraphInitializersRejectUnauthorizedWrongOrderAndReplay() external {
        Market memory candidate =
            _deployGraphMarket(false, keccak256("archive-fork-foreign-initialization"));

        _assertGraphInitializerGuards(candidate);
        _assertWrongOrderGraphInitializationRollsBack();
        _assertSolvent(candidate.hook);
    }

    function testSeedPermit2FundingAndCustodyFailuresRevertAtomically() external {
        Market memory missingPermit = _deployUnseededMarket(true);
        _prepareSeedInventory(SECOND_PAYER, true);
        _assertSolvent(missingPermit.hook);
        uint256 missingPermitHkmnBefore = missingPermit.token.balanceOf(address(missingPermit.hook));
        uint256 missingPermitUsdgBefore = IArchiveErc20(USDG).balanceOf(SECOND_PAYER);
        uint256 nextTokenBefore = positionManager.nextTokenId();
        HookemonHook.SeedParams memory missingPermitParams = _seedParams(
            missingPermit.token, missingPermit.hook, SECOND_PAYER, address(missingPermit.custody)
        );
        vm.expectRevert(HookemonHook.PayerPermit2AllowanceInvalid.selector);
        vm.prank(AUTHORITY);
        missingPermit.hook.seedCanonicalLiquidity(missingPermitParams);
        assertFalse(missingPermit.hook.canonicalLiquiditySeeded());
        assertEq(
            missingPermit.token.balanceOf(address(missingPermit.hook)), missingPermitHkmnBefore
        );
        assertEq(IArchiveErc20(USDG).balanceOf(SECOND_PAYER), missingPermitUsdgBefore);
        assertEq(positionManager.nextTokenId(), nextTokenBefore);
        _assertSolvent(missingPermit.hook);

        Market memory fundingFailure = _deployUnseededMarket(true);
        _prepareSeedInventory(UNFUNDED_PAYER, false);
        _assertSolvent(fundingFailure.hook);
        _approveSeedPayer(UNFUNDED_PAYER, fundingFailure.hook);
        uint256 fundingHkmnBefore = fundingFailure.token.balanceOf(address(fundingFailure.hook));
        uint256 fundingUsdgBefore = IArchiveErc20(USDG).balanceOf(UNFUNDED_PAYER);
        nextTokenBefore = positionManager.nextTokenId();
        HookemonHook.SeedParams memory fundingFailureParams = _seedParams(
            fundingFailure.token,
            fundingFailure.hook,
            UNFUNDED_PAYER,
            address(fundingFailure.custody)
        );
        vm.expectRevert();
        vm.prank(AUTHORITY);
        fundingFailure.hook.seedCanonicalLiquidity(fundingFailureParams);
        assertFalse(fundingFailure.hook.canonicalLiquiditySeeded());
        assertEq(fundingFailure.token.balanceOf(address(fundingFailure.hook)), fundingHkmnBefore);
        assertEq(IArchiveErc20(USDG).balanceOf(UNFUNDED_PAYER), fundingUsdgBefore);
        assertEq(positionManager.nextTokenId(), nextTokenBefore);
        _assertSolvent(fundingFailure.hook);

        Market memory custodyMismatch = _deployUnseededMarket(true);
        _prepareSeedInventory(THIRD_PAYER, true);
        _assertSolvent(custodyMismatch.hook);
        _approveSeedPayer(THIRD_PAYER, custodyMismatch.hook);
        PermanentPositionCustody foreignCustody = new PermanentPositionCustody(POSITION_MANAGER, 0);
        uint256 mismatchHkmnBefore = custodyMismatch.token.balanceOf(address(custodyMismatch.hook));
        uint256 mismatchUsdgBefore = IArchiveErc20(USDG).balanceOf(THIRD_PAYER);
        nextTokenBefore = positionManager.nextTokenId();
        HookemonHook.SeedParams memory custodyMismatchParams = _seedParams(
            custodyMismatch.token, custodyMismatch.hook, THIRD_PAYER, address(foreignCustody)
        );
        vm.expectRevert(HookemonHook.InvalidSeedCustody.selector);
        vm.prank(AUTHORITY);
        custodyMismatch.hook.seedCanonicalLiquidity(custodyMismatchParams);
        assertFalse(custodyMismatch.hook.canonicalLiquiditySeeded());
        assertEq(custodyMismatch.token.balanceOf(address(custodyMismatch.hook)), mismatchHkmnBefore);
        assertEq(IArchiveErc20(USDG).balanceOf(THIRD_PAYER), mismatchUsdgBefore);
        assertEq(positionManager.nextTokenId(), nextTokenBefore);
        _assertSolvent(custodyMismatch.hook);
    }

    function testSeedCustodyBindingFailureAfterMintRollsBackAllState() external {
        Market memory candidate = _deployUnseededMarket(true);
        _prepareSeedInventory(THIRD_PAYER, true);
        _approveSeedPayer(THIRD_PAYER, candidate.hook);

        _assertLateSeedCustodyRollback(candidate, THIRD_PAYER);
    }

    function testNonDivisibleSplitVolumePreservesCumulativeFeesAcrossClaims() external {
        Market memory splitMarket = _deploySeededMarket(true, SECOND_PAYER);
        _fundRouterTrader(hkmn, TRADER);
        _fundRouterTrader(splitMarket.token, SECOND_TRADER);

        uint128 fragment = NON_DIVISIBLE_USDG_ROUTER_TRADE_AMOUNT;
        _executeExactInputAndAssert(hook, TRADER, _canonicalKey(), true, fragment * 3);
        PoolKey memory splitKey = _canonicalKeyFor(splitMarket.token, splitMarket.hook);
        _executeExactInputAndAssert(splitMarket.hook, SECOND_TRADER, splitKey, true, fragment);
        ClaimedFees memory claimed = _claimSplitMarketFees(splitMarket.hook);
        _executeExactInputAndAssert(splitMarket.hook, SECOND_TRADER, splitKey, true, fragment);
        _executeExactInputAndAssert(splitMarket.hook, SECOND_TRADER, splitKey, true, fragment);

        _assertNonDivisibleCumulativeFees(hook, splitMarket.hook, claimed);
        _assertSolvent();
        _assertSolvent(splitMarket.hook);
    }

    function _deployThreeTargets() private {
        Market memory primary = _deployGraphMarket(true, keccak256("archive-fork-primary"));
        hkmn = primary.token;
        hook = primary.hook;
        custody = primary.custody;
        graph = primary.executor;
        tokenPredicted = primary.tokenPredicted;
        hookPredicted = primary.hookPredicted;
        custodyPredicted = primary.custodyPredicted;
    }

    function _deploySeededMarket(bool usdgIsCurrency0, address payer)
        private
        returns (Market memory market)
    {
        market = _deployGraphMarket(
            usdgIsCurrency0, keccak256(abi.encodePacked("archive-fork-seeded", payer))
        );
        _fundUsdg(payer, USDG_SEED_AMOUNT);
        deal(payer, 100 ether);
        vm.startPrank(payer);
        assertTrue(IArchiveErc20(USDG).approve(PERMIT2, USDG_SEED_AMOUNT), "USDG approval failed");
        permit2.approve(USDG, address(market.hook), USDG_SEED_AMOUNT, type(uint48).max);
        vm.stopPrank();

        uint256 hkmnFunded = market.token.balanceOf(address(market.hook));
        uint256 payerUsdgBefore = IArchiveErc20(USDG).balanceOf(payer);
        uint256 treasuryHkmnBefore = market.token.balanceOf(TREASURY);
        uint256 poolManagerHkmnBefore = market.token.balanceOf(POOL_MANAGER);
        HookemonHook.SeedParams memory params =
            _seedParams(market.token, market.hook, payer, address(market.custody));
        vm.prank(AUTHORITY);
        market.hook.seedCanonicalLiquidity(params);

        uint256 hkmnContributed = market.token.balanceOf(POOL_MANAGER) - poolManagerHkmnBefore;
        uint256 hkmnDustTransferred = market.token.balanceOf(TREASURY) - treasuryHkmnBefore;
        assertEq(hkmnFunded, HKMN_POOL_ALLOCATION, "graph allocation drifted");
        assertEq(hkmnContributed, hkmnFunded, "seed did not consume the complete allocation");
        assertEq(hkmnDustTransferred, 0, "graph seed transferred HKMN to treasury");
        assertEq(
            IArchiveErc20(USDG).balanceOf(payer),
            payerUsdgBefore - USDG_SEED_AMOUNT,
            "full-range seed refunded USDG"
        );
        assertEq(market.token.balanceOf(address(market.hook)), 0, "seed left HKMN in hook");
        assertEq(
            hkmnFunded, hkmnContributed + hkmnDustTransferred, "seed HKMN conservation drifted"
        );
        _assertSolvent(market.hook);
    }

    function _deployUnseededMarket(bool usdgIsCurrency0) private returns (Market memory market) {
        return _deployGraphMarket(
            usdgIsCurrency0, keccak256(abi.encodePacked("archive-fork-unseeded", usdgIsCurrency0))
        );
    }

    function _prepareSeedInventory(address payer, bool fundPayer) private {
        if (fundPayer) {
            _fundUsdg(payer, USDG_SEED_AMOUNT);
        } else {
            deal(USDG, payer, 0, true);
        }
        deal(payer, 100 ether);
    }

    function _approveSeedPayer(address payer, HookemonHook target) private {
        vm.startPrank(payer);
        assertTrue(IArchiveErc20(USDG).approve(PERMIT2, USDG_SEED_AMOUNT), "USDG approval failed");
        permit2.approve(USDG, address(target), USDG_SEED_AMOUNT, type(uint48).max);
        vm.stopPrank();
    }

    function _launchAndSeed() private {
        assertEq(
            address(positionManager.poolManager()), POOL_MANAGER, "PositionManager pool mismatch"
        );
        assertEq(address(positionManager.permit2()), PERMIT2, "PositionManager Permit2 mismatch");

        _fundUsdg(PAYER, USDG_SEED_AMOUNT);
        deal(PAYER, 100 ether);

        vm.startPrank(PAYER);
        assertTrue(IArchiveErc20(USDG).approve(PERMIT2, USDG_SEED_AMOUNT), "USDG approval failed");
        permit2.approve(USDG, address(hook), USDG_SEED_AMOUNT, type(uint48).max);
        vm.stopPrank();

        nextTokenIdBeforeSeed = positionManager.nextTokenId();
        HookemonHook.SeedParams memory params = _seedParams(hkmn, hook, PAYER, address(custody));
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity(params);
    }

    function _fundRouterTrader(HKMNToken token, address trader) private {
        deal(address(token), trader, HKMN_POOL_ALLOCATION);
        _fundUsdg(trader, USDG_ROUTER_FUNDING_AMOUNT);
        deal(trader, 100 ether);

        vm.startPrank(trader);
        assertTrue(token.approve(PERMIT2, type(uint256).max), "HKMN Permit2 approval failed");
        assertTrue(
            IArchiveErc20(USDG).approve(PERMIT2, type(uint256).max), "USDG Permit2 approval failed"
        );
        permit2.approve(address(token), UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        permit2.approve(USDG, UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _executeExactInput(address trader, bool zeroForOne, uint128 amountIn)
        private
        returns (RouterUsdgObservation memory)
    {
        PoolKey memory key = _canonicalKey();
        return _executeExactInputFor(trader, key, zeroForOne, amountIn);
    }

    function _executeExactInputFor(
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn
    ) private returns (RouterUsdgObservation memory observation) {
        return _executeExactInputForWithMinimum(trader, key, zeroForOne, amountIn, 0);
    }

    function _executeExactInputForWithMinimum(
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 amountOutMinimum
    ) private returns (RouterUsdgObservation memory observation) {
        RouterUsdgBalances memory before = _routerUsdgBalances(trader, key);
        vm.recordLogs();
        _executeExactInputViaRouter(trader, key, zeroForOne, amountIn, amountOutMinimum);
        observation = _observeRouterUsdgSwap(key, trader, before, vm.getRecordedLogs());
        _assertStateViewMatchesManager(key);
    }

    function _executeExactInputViaRouter(
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 amountOutMinimum
    ) private {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        bytes memory actions = abi.encodePacked(
            bytes1(uint8(Actions.SWAP_EXACT_IN_SINGLE)),
            bytes1(uint8(Actions.SETTLE_ALL)),
            bytes1(uint8(Actions.TAKE_ALL))
        );
        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        actionParams[1] = abi.encode(input, type(uint256).max);
        actionParams[2] = abi.encode(output, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, actionParams);
        vm.prank(trader);
        IArchiveUniversalRouter(UNIVERSAL_ROUTER).execute(hex"10", inputs, block.timestamp + 1);
    }

    function _executeExactOutputForWithMaximum(
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountOut,
        uint128 amountInMaximum
    ) private returns (RouterUsdgObservation memory observation) {
        RouterUsdgBalances memory before = _routerUsdgBalances(trader, key);
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        bytes memory actions = abi.encodePacked(
            bytes1(uint8(Actions.SWAP_EXACT_OUT_SINGLE)),
            bytes1(uint8(Actions.SETTLE_ALL)),
            bytes1(uint8(Actions.TAKE_ALL))
        );
        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = abi.encode(
            IV4Router.ExactOutputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountOut: amountOut,
                amountInMaximum: amountInMaximum,
                minHopPriceX36: 0,
                hookData: bytes("")
            })
        );
        actionParams[1] = abi.encode(input, type(uint256).max);
        actionParams[2] = abi.encode(output, uint256(0));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, actionParams);
        vm.recordLogs();
        vm.prank(trader);
        IArchiveUniversalRouter(UNIVERSAL_ROUTER).execute(hex"10", inputs, block.timestamp + 1);
        observation = _observeRouterUsdgSwap(key, trader, before, vm.getRecordedLogs());
        _assertStateViewMatchesManager(key);
    }

    function _runAllQuoteAndRouterQuadrants(Market memory market, address trader) private {
        PoolKey memory key = _canonicalKeyFor(market.token, market.hook);
        _runQuoteAndRouterQuadrant(market.hook, trader, key, true, true);
        _runQuoteAndRouterQuadrant(market.hook, trader, key, true, false);
        _runQuoteAndRouterQuadrant(market.hook, trader, key, false, true);
        _runQuoteAndRouterQuadrant(market.hook, trader, key, false, false);
    }

    function _executeExactInputAndAssert(
        HookemonHook target,
        address trader,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn
    ) private {
        FeeSnapshot memory before = _feeSnapshot(target);
        RouterUsdgObservation memory route =
            _executeExactInputFor(trader, key, zeroForOne, amountIn);
        _assertFeeAccrual(target, before, route);
    }

    function _runQuoteAndRouterQuadrant(
        HookemonHook target,
        address trader,
        PoolKey memory key,
        bool exactInput,
        bool zeroForOne
    ) private {
        FeeSnapshot memory before = _feeSnapshot(target);

        RouterUsdgObservation memory route;
        if (exactInput) {
            uint128 amountIn = _routerExactInputAmount(key, zeroForOne);
            uint128 amountOutMinimum = _quoteExactInput(target, key, zeroForOne, amountIn);
            route = _executeExactInputForWithMinimum(
                trader, key, zeroForOne, amountIn, amountOutMinimum
            );
        } else {
            uint128 amountOut = _routerExactOutputAmount(key, zeroForOne);
            uint128 amountInMaximum = _quoteExactOutput(target, key, zeroForOne, amountOut);
            route = _executeExactOutputForWithMaximum(
                trader, key, zeroForOne, amountOut, amountInMaximum
            );
        }

        _assertFeeAccrual(target, before, route);
    }

    function _routerExactInputAmount(PoolKey memory key, bool zeroForOne)
        private
        pure
        returns (uint128)
    {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        return Currency.unwrap(input) == USDG ? USDG_ROUTER_TRADE_AMOUNT : HKMN_ROUTER_TRADE_AMOUNT;
    }

    function _routerExactOutputAmount(PoolKey memory key, bool zeroForOne)
        private
        pure
        returns (uint128)
    {
        Currency output = zeroForOne ? key.currency1 : key.currency0;
        return Currency.unwrap(output) == USDG
            ? USDG_ROUTER_EXACT_OUTPUT_AMOUNT
            : HKMN_ROUTER_EXACT_OUTPUT_AMOUNT;
    }

    function _quoteExactInput(
        HookemonHook target,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn
    ) private returns (uint128 amountOut) {
        QuoteState memory before = _quoteState(target, key);
        (uint256 quotedAmountOut,) = v4Quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: bytes("")
            })
        );
        assertLe(
            quotedAmountOut, type(uint128).max, "V4Quoter exact-input amount overflowed router"
        );
        _assertQuoteStateUnchanged(target, key, before);
        return uint128(quotedAmountOut);
    }

    function _quoteExactOutput(
        HookemonHook target,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountOut
    ) private returns (uint128 amountIn) {
        QuoteState memory before = _quoteState(target, key);
        (uint256 quotedAmountIn,) = v4Quoter.quoteExactOutputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: key, zeroForOne: zeroForOne, exactAmount: amountOut, hookData: bytes("")
            })
        );
        assertLe(
            quotedAmountIn, type(uint128).max, "V4Quoter exact-output amount overflowed router"
        );
        _assertQuoteStateUnchanged(target, key, before);
        return uint128(quotedAmountIn);
    }

    function _quoteState(HookemonHook target, PoolKey memory key)
        private
        view
        returns (QuoteState memory snapshot)
    {
        snapshot.fees = _feeSnapshot(target);
        (snapshot.sqrtPriceX96, snapshot.tick, snapshot.protocolFee, snapshot.lpFee) =
            manager.getSlot0(key.toId());
        snapshot.liquidity = manager.getLiquidity(key.toId());
        snapshot.lastExecutedUsdg = target.lastExecutedUsdg();
        snapshot.lastRawPoolUsdgDelta = target.lastRawPoolUsdgDelta();
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        snapshot.managerCurrency0 = IArchiveErc20(currency0).balanceOf(address(manager));
        snapshot.managerCurrency1 = IArchiveErc20(currency1).balanceOf(address(manager));
        snapshot.hookCurrency0 = IArchiveErc20(currency0).balanceOf(address(target));
        snapshot.hookCurrency1 = IArchiveErc20(currency1).balanceOf(address(target));
    }

    function _assertQuoteStateUnchanged(
        HookemonHook target,
        PoolKey memory key,
        QuoteState memory before
    ) private view {
        QuoteState memory afterQuote = _quoteState(target, key);
        _assertFeeSnapshotUnchanged(target, before.fees);
        assertEq(afterQuote.sqrtPriceX96, before.sqrtPriceX96, "V4Quoter changed pool price");
        assertEq(afterQuote.tick, before.tick, "V4Quoter changed pool tick");
        assertEq(afterQuote.protocolFee, before.protocolFee, "V4Quoter changed protocol fee");
        assertEq(afterQuote.lpFee, before.lpFee, "V4Quoter changed LP fee");
        assertEq(afterQuote.liquidity, before.liquidity, "V4Quoter changed pool liquidity");
        assertEq(
            afterQuote.lastExecutedUsdg, before.lastExecutedUsdg, "V4Quoter changed finalized USDG"
        );
        assertEq(
            afterQuote.lastRawPoolUsdgDelta,
            before.lastRawPoolUsdgDelta,
            "V4Quoter changed finalized pool delta"
        );
        assertEq(
            afterQuote.managerCurrency0,
            before.managerCurrency0,
            "V4Quoter changed PoolManager currency0"
        );
        assertEq(
            afterQuote.managerCurrency1,
            before.managerCurrency1,
            "V4Quoter changed PoolManager currency1"
        );
        assertEq(afterQuote.hookCurrency0, before.hookCurrency0, "V4Quoter changed hook currency0");
        assertEq(afterQuote.hookCurrency1, before.hookCurrency1, "V4Quoter changed hook currency1");
        _assertStateViewMatchesManager(key);
    }

    function _assertFeeAccrual(
        HookemonHook target,
        FeeSnapshot memory before,
        RouterUsdgObservation memory route
    ) private {
        uint256 grossBefore = observedGrossUsdg[address(target)];
        uint256 grossAfter = grossBefore + route.gross;
        FeeAccrual memory beforeAccrual = _feeAccrualForGross(grossBefore);
        FeeAccrual memory afterAccrual = _feeAccrualForGross(grossAfter);
        uint256 expectedProgrammable = afterAccrual.programmable - beforeAccrual.programmable;
        uint256 expectedTreasury = afterAccrual.treasury - beforeAccrual.treasury;
        uint256 expectedProcess = afterAccrual.process - beforeAccrual.process;
        uint256 expectedTotal = expectedProgrammable + expectedTreasury + expectedProcess;
        FeeSnapshot memory observed = _feeSnapshot(target);
        assertGt(route.gross, 1_000, "router swap did not execute USDG");
        assertEq(target.lastExecutedUsdg(), route.gross, "hook gross differs from router evidence");
        assertEq(route.fee, expectedTotal, "router USDG fee differs from fee schedule");
        assertEq(
            route.accruedGross, route.gross, "accrual event gross differs from router evidence"
        );
        assertEq(
            route.accruedFee, expectedTotal, "accrual event total differs from direct floor formula"
        );
        assertEq(
            route.accruedProgrammable,
            expectedProgrammable,
            "accrual event programmable fee differs from direct floor formula"
        );
        assertEq(
            route.accruedTreasury,
            expectedTreasury,
            "accrual event treasury fee differs from direct floor formula"
        );
        assertEq(
            route.accruedProcess,
            expectedProcess,
            "accrual event process fee differs from direct floor formula"
        );
        assertEq(observed.usdgBalance - before.usdgBalance, expectedTotal);
        assertEq(observed.liability - before.liability, expectedTotal);
        assertEq(observed.programmable - before.programmable, expectedProgrammable);
        assertEq(observed.treasury - before.treasury, expectedTreasury);
        assertEq(observed.process - before.process, expectedProcess);
        assertEq(
            expectedTotal,
            expectedProgrammable + expectedTreasury + expectedProcess,
            "fee split did not conserve the USDG balance delta"
        );
        assertEq(
            route.remainders.programmable,
            afterAccrual.remainders.programmable,
            "programmable remainder differs from the direct floor formula"
        );
        assertEq(
            route.remainders.treasury,
            afterAccrual.remainders.treasury,
            "treasury remainder differs from the direct floor formula"
        );
        assertEq(
            route.remainders.process,
            afterAccrual.remainders.process,
            "process remainder differs from the direct floor formula"
        );
        observedGrossUsdg[address(target)] = grossAfter;
        observedFeeRemainders[address(target)] = route.remainders;
        _assertSolvent(target);
    }

    function _observeRouterUsdgSwap(
        PoolKey memory key,
        address trader,
        RouterUsdgBalances memory before,
        Vm.Log[] memory logs
    ) private view returns (RouterUsdgObservation memory observation) {
        observation.rawPoolDelta = _rawPoolUsdgDelta(key, logs);
        observation.traderDelta =
            _balanceDelta(IArchiveErc20(USDG).balanceOf(trader), before.trader);
        observation.managerDelta =
            _balanceDelta(IArchiveErc20(USDG).balanceOf(address(manager)), before.manager);
        observation.routerDelta =
            _balanceDelta(IArchiveErc20(USDG).balanceOf(UNIVERSAL_ROUTER), before.router);
        observation.hookDelta =
            _balanceDelta(IArchiveErc20(USDG).balanceOf(address(key.hooks)), before.hook);

        int256 fee = int256(observation.rawPoolDelta) - observation.traderDelta;
        assertGt(fee, 0, "router route did not collect a USDG fee");
        assertEq(
            observation.rawPoolDelta < 0,
            observation.traderDelta < 0,
            "router USDG direction drifted"
        );
        assertEq(
            observation.managerDelta,
            -int256(observation.rawPoolDelta),
            "PoolManager USDG balance disagrees with its Swap event"
        );
        assertEq(observation.routerDelta, 0, "Universal Router retained USDG");
        assertEq(observation.hookDelta, fee, "hook USDG balance differs from router fee");
        assertEq(
            observation.traderDelta + observation.managerDelta + observation.routerDelta
                + observation.hookDelta,
            0,
            "router USDG balance conservation failed"
        );

        observation.fee = uint256(fee);
        observation.gross = observation.rawPoolDelta < 0
            ? _abs(observation.traderDelta)
            : _abs(int256(observation.rawPoolDelta));
        FeeAccrual memory accrual = _accrualFromLogs(address(key.hooks), logs);
        observation.accruedGross = accrual.gross;
        observation.accruedFee = accrual.total;
        observation.accruedProgrammable = accrual.programmable;
        observation.accruedTreasury = accrual.treasury;
        observation.accruedProcess = accrual.process;
        observation.remainders = accrual.remainders;
    }

    function _routerUsdgBalances(address trader, PoolKey memory key)
        private
        view
        returns (RouterUsdgBalances memory balances)
    {
        balances.trader = IArchiveErc20(USDG).balanceOf(trader);
        balances.manager = IArchiveErc20(USDG).balanceOf(address(manager));
        balances.router = IArchiveErc20(USDG).balanceOf(UNIVERSAL_ROUTER);
        balances.hook = IArchiveErc20(USDG).balanceOf(address(key.hooks));
    }

    function _routerRollbackSnapshot(
        HKMNToken token,
        HookemonHook target,
        PoolKey memory key,
        address trader
    ) private view returns (RouterRollbackSnapshot memory snapshot) {
        snapshot.fees = _feeSnapshot(target);
        snapshot.usdgBalances = _routerUsdgBalances(trader, key);
        snapshot.traderHkmn = token.balanceOf(trader);
        snapshot.managerHkmn = token.balanceOf(address(manager));
        (snapshot.sqrtPriceX96, snapshot.tick, snapshot.protocolFee, snapshot.lpFee) =
            manager.getSlot0(key.toId());
        snapshot.liquidity = manager.getLiquidity(key.toId());
    }

    function _assertRouterRollback(
        HKMNToken token,
        HookemonHook target,
        PoolKey memory key,
        address trader,
        RouterRollbackSnapshot memory before
    ) private view {
        RouterRollbackSnapshot memory afterRollback =
            _routerRollbackSnapshot(token, target, key, trader);
        assertEq(
            afterRollback.usdgBalances.trader,
            before.usdgBalances.trader,
            "router rollback changed trader USDG"
        );
        assertEq(
            afterRollback.usdgBalances.manager,
            before.usdgBalances.manager,
            "router rollback changed PoolManager USDG"
        );
        assertEq(
            afterRollback.usdgBalances.router,
            before.usdgBalances.router,
            "router rollback changed Universal Router USDG"
        );
        assertEq(
            afterRollback.usdgBalances.hook,
            before.usdgBalances.hook,
            "router rollback changed hook USDG"
        );
        assertEq(afterRollback.traderHkmn, before.traderHkmn, "router rollback changed trader HKMN");
        assertEq(
            afterRollback.managerHkmn,
            before.managerHkmn,
            "router rollback changed PoolManager HKMN"
        );
        _assertFeeSnapshotUnchanged(target, before.fees);
        assertEq(
            afterRollback.sqrtPriceX96, before.sqrtPriceX96, "router rollback changed pool price"
        );
        assertEq(afterRollback.tick, before.tick, "router rollback changed pool tick");
        assertEq(
            afterRollback.protocolFee,
            before.protocolFee,
            "router rollback changed pool protocol fee"
        );
        assertEq(afterRollback.lpFee, before.lpFee, "router rollback changed pool LP fee");
        assertEq(
            afterRollback.liquidity, before.liquidity, "router rollback changed pool liquidity"
        );
        _assertStateViewMatchesManager(key);
    }

    function _rawPoolUsdgDelta(PoolKey memory key, Vm.Log[] memory logs)
        private
        view
        returns (int128)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != address(manager) || entry.topics.length < 3
                    || entry.topics[0] != POOL_SWAP_EVENT
                    || entry.topics[1] != PoolId.unwrap(key.toId())
                    || entry.topics[2] != bytes32(uint256(uint160(UNIVERSAL_ROUTER)))
            ) continue;
            (
                int128 amount0,
                int128 amount1,
                uint160 sqrtPriceX96,
                uint128 liquidity,
                int24 tick,
                uint24 fee
            ) = abi.decode(entry.data, (int128, int128, uint160, uint128, int24, uint24));
            sqrtPriceX96;
            liquidity;
            tick;
            fee;
            return Currency.unwrap(key.currency0) == USDG ? amount0 : amount1;
        }
        revert("UNIVERSAL_ROUTER_POOL_SWAP_LOG_NOT_FOUND");
    }

    function _assertStateViewMatchesManager(PoolKey memory key) private view {
        PoolId poolId = key.toId();
        (uint160 managerPrice, int24 managerTick, uint24 managerProtocolFee, uint24 managerLpFee) =
            manager.getSlot0(poolId);
        (uint160 viewPrice, int24 viewTick, uint24 viewProtocolFee, uint24 viewLpFee) =
            stateView.getSlot0(poolId);
        assertEq(viewPrice, managerPrice, "StateView price differs from PoolManager");
        assertEq(viewTick, managerTick, "StateView tick differs from PoolManager");
        assertEq(
            viewProtocolFee, managerProtocolFee, "StateView protocol fee differs from PoolManager"
        );
        assertEq(viewLpFee, managerLpFee, "StateView LP fee differs from PoolManager");
    }

    function _balanceDelta(uint256 afterBalance, uint256 beforeBalance)
        private
        pure
        returns (int256)
    {
        return afterBalance >= beforeBalance
            ? int256(afterBalance - beforeBalance)
            : -int256(beforeBalance - afterBalance);
    }

    function _abs(int256 value) private pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }

    function _feeSnapshot(HookemonHook target) private view returns (FeeSnapshot memory snapshot) {
        snapshot.usdgBalance = IArchiveErc20(USDG).balanceOf(address(target));
        snapshot.liability = target.totalLiability();
        (snapshot.programmable, snapshot.treasury, snapshot.process) =
            target.readFeeLiabilities(TREASURY);
    }

    function _assertFeeSnapshotUnchanged(HookemonHook target, FeeSnapshot memory before)
        private
        view
    {
        FeeSnapshot memory afterSnapshot = _feeSnapshot(target);
        assertEq(afterSnapshot.usdgBalance, before.usdgBalance, "fee rollback changed hook USDG");
        assertEq(afterSnapshot.liability, before.liability, "fee rollback changed total liability");
        assertEq(
            afterSnapshot.programmable,
            before.programmable,
            "fee rollback changed programmable liability"
        );
        assertEq(afterSnapshot.treasury, before.treasury, "fee rollback changed treasury liability");
        assertEq(afterSnapshot.process, before.process, "fee rollback changed process liability");
    }

    function _accrualFromLogs(address target, Vm.Log[] memory logs)
        private
        pure
        returns (FeeAccrual memory accrual)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != target || entry.topics.length != 3
                    || entry.topics[0] != SWAP_LIABILITIES_ACCRUED_EVENT
            ) continue;

            assertEq(
                entry.topics[1],
                bytes32(uint256(uint160(RobinhoodBindings.PROGRAMMABLE_BENEFICIARY))),
                "accrual event programmable beneficiary drifted"
            );
            assertEq(
                entry.topics[2],
                bytes32(uint256(uint160(TREASURY))),
                "accrual event treasury beneficiary drifted"
            );
            (
                uint256 gross,
                uint256 total,
                uint256 programmable,
                uint256 treasury,
                uint256 process,
                uint256 programmableRemainder,
                uint256 treasuryRemainder,
                uint256 processRemainder
            ) = abi.decode(
                entry.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
            );
            return FeeAccrual({
                gross: gross,
                programmable: programmable,
                treasury: treasury,
                process: process,
                total: total,
                remainders: FeeRemainders({
                    programmable: programmableRemainder,
                    treasury: treasuryRemainder,
                    process: processRemainder
                })
            });
        }
        revert("SWAP_LIABILITIES_ACCRUED_EVENT_NOT_FOUND");
    }

    function _feeAccrualForGross(uint256 gross) private pure returns (FeeAccrual memory accrual) {
        accrual.gross = gross;
        accrual.programmable = _floorFee(gross, 10);
        accrual.treasury = _floorFee(gross, 40);
        accrual.process = _floorFee(gross, 250);
        accrual.total = accrual.programmable + accrual.treasury + accrual.process;
        accrual.remainders = FeeRemainders({
            programmable: _feeRemainder(gross, 10),
            treasury: _feeRemainder(gross, 40),
            process: _feeRemainder(gross, 250)
        });
    }

    function _floorFee(uint256 gross, uint256 basisPoints) private pure returns (uint256) {
        return gross * basisPoints / 10_000;
    }

    function _feeRemainder(uint256 gross, uint256 basisPoints) private pure returns (uint256) {
        return gross * basisPoints % 10_000;
    }

    function _claimSplitMarketFees(HookemonHook target)
        private
        returns (ClaimedFees memory claimed)
    {
        FeeSnapshot memory before = _feeSnapshot(target);
        claimed.programmable = before.programmable;
        claimed.treasury = before.treasury;
        assertGt(claimed.programmable, 0, "nondivisible route did not accrue programmable fees");
        assertGt(claimed.treasury, 0, "nondivisible route did not accrue treasury fees");

        address programmable = RobinhoodBindings.PROGRAMMABLE_BENEFICIARY;
        uint256 programmableBefore = IArchiveErc20(USDG).balanceOf(programmable);
        vm.prank(programmable);
        assertEq(
            target.claimProgrammable(claimed.programmable, programmable),
            claimed.programmable,
            "nondivisible programmable claim amount drifted"
        );
        FeeSnapshot memory afterProgrammable = _feeSnapshot(target);
        _assertClaimDebit(target, before, afterProgrammable, claimed.programmable, 0, 0);
        assertEq(
            IArchiveErc20(USDG).balanceOf(programmable) - programmableBefore,
            claimed.programmable,
            "nondivisible programmable destination amount drifted"
        );

        uint256 treasuryBefore = IArchiveErc20(USDG).balanceOf(TREASURY);
        vm.prank(TREASURY);
        assertEq(
            target.claimTreasury(claimed.treasury, TREASURY),
            claimed.treasury,
            "nondivisible treasury claim amount drifted"
        );
        FeeSnapshot memory afterTreasury = _feeSnapshot(target);
        _assertClaimDebit(target, afterProgrammable, afterTreasury, 0, claimed.treasury, 0);
        assertEq(
            IArchiveErc20(USDG).balanceOf(TREASURY) - treasuryBefore,
            claimed.treasury,
            "nondivisible treasury destination amount drifted"
        );
    }

    function _assertNonDivisibleCumulativeFees(
        HookemonHook unsplit,
        HookemonHook split,
        ClaimedFees memory claimed
    ) private view {
        uint256 unsplitGross = observedGrossUsdg[address(unsplit)];
        uint256 splitGross = observedGrossUsdg[address(split)];
        assertEq(splitGross, unsplitGross, "split gross USDG differs from unsplit gross USDG");
        assertEq(
            splitGross,
            uint256(NON_DIVISIBLE_USDG_ROUTER_TRADE_AMOUNT) * 3,
            "nondivisible test gross USDG drifted"
        );

        FeeAccrual memory expected = _feeAccrualForGross(unsplitGross);
        FeeSnapshot memory unsplitObserved = _feeSnapshot(unsplit);
        FeeSnapshot memory splitObserved = _feeSnapshot(split);
        assertEq(unsplitObserved.programmable, expected.programmable);
        assertEq(unsplitObserved.treasury, expected.treasury);
        assertEq(unsplitObserved.process, expected.process);
        assertEq(unsplitObserved.liability, expected.total);
        assertEq(splitObserved.programmable + claimed.programmable, expected.programmable);
        assertEq(splitObserved.treasury + claimed.treasury, expected.treasury);
        assertEq(splitObserved.process + claimed.process, expected.process);
        assertEq(
            splitObserved.liability + claimed.programmable + claimed.treasury + claimed.process,
            expected.total,
            "claims changed cumulative nondivisible fees"
        );

        FeeRemainders memory splitRemainders = observedFeeRemainders[address(split)];
        assertEq(
            splitRemainders.programmable,
            expected.remainders.programmable,
            "programmable remainder did not survive the claim"
        );
        assertEq(
            splitRemainders.treasury,
            expected.remainders.treasury,
            "treasury remainder did not survive the claim"
        );
        assertEq(
            splitRemainders.process,
            expected.remainders.process,
            "process remainder did not survive the claim"
        );
    }

    function _assertClaimDebit(
        HookemonHook target,
        FeeSnapshot memory before,
        FeeSnapshot memory afterClaim,
        uint256 programmableDebit,
        uint256 treasuryDebit,
        uint256 processDebit
    ) private view {
        uint256 totalDebit =
            programmableDebit + treasuryDebit + processDebit;
        assertEq(afterClaim.usdgBalance, before.usdgBalance - totalDebit);
        assertEq(afterClaim.liability, before.liability - totalDebit);
        assertEq(afterClaim.programmable, before.programmable - programmableDebit);
        assertEq(afterClaim.treasury, before.treasury - treasuryDebit);
        assertEq(afterClaim.process, before.process - processDebit);
        _assertSolvent(target);
    }

    function _assertClaimAuthorizationGuards(address programmable, address operations) private {
        FeeSnapshot memory before = _feeSnapshot(hook);

        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        vm.prank(THIRD_PARTY);
        hook.claimProgrammable(1, programmable);

        vm.expectRevert(MoneyRoles.InvalidRoleBeneficiary.selector);
        vm.prank(THIRD_PARTY);
        hook.claimTreasury(1, TREASURY);

        vm.expectRevert(MoneyRoles.UnauthorizedCaller.selector);
        vm.prank(THIRD_PARTY);
        hook.claimProcess(bytes32("unauthorized-process"), 1, operations);

        _assertFeeSnapshotUnchanged(hook, before);
    }

    function _claimProgrammableAndAssert(uint256 amount, address destination) private {
        FeeSnapshot memory before = _feeSnapshot(hook);
        uint256 destinationBefore = IArchiveErc20(USDG).balanceOf(destination);
        vm.prank(RobinhoodBindings.PROGRAMMABLE_BENEFICIARY);
        assertEq(hook.claimProgrammable(amount, destination), amount);
        FeeSnapshot memory afterClaim = _feeSnapshot(hook);
        _assertClaimDebit(hook, before, afterClaim, amount, 0, 0);
        assertEq(IArchiveErc20(USDG).balanceOf(destination) - destinationBefore, amount);
    }

    function _claimTreasuryAndAssert(uint256 amount, address destination) private {
        FeeSnapshot memory before = _feeSnapshot(hook);
        uint256 destinationBefore = IArchiveErc20(USDG).balanceOf(destination);
        vm.prank(TREASURY);
        assertEq(hook.claimTreasury(amount, destination), amount);
        FeeSnapshot memory afterClaim = _feeSnapshot(hook);
        _assertClaimDebit(hook, before, afterClaim, 0, amount, 0);
        assertEq(IArchiveErc20(USDG).balanceOf(destination) - destinationBefore, amount);
    }

    function _claimProcessAndAssert(bytes32 cycleId, uint256 amount, address operations) private {
        FeeSnapshot memory before = _feeSnapshot(hook);
        uint256 destinationBefore = IArchiveErc20(USDG).balanceOf(operations);
        vm.prank(operations);
        assertEq(hook.claimProcess(cycleId, amount, operations), amount);
        FeeSnapshot memory afterClaim = _feeSnapshot(hook);
        _assertClaimDebit(hook, before, afterClaim, 0, 0, amount);
        assertEq(IArchiveErc20(USDG).balanceOf(operations) - destinationBefore, amount);
    }

    function _assertLateSeedCustodyRollback(Market memory market, address payer) private {
        SeedSnapshot memory before = _seedSnapshot(market, payer);
        PoolKey memory key = _canonicalKeyFor(market.token, market.hook);
        HookemonHook.SeedParams memory params =
            _seedParams(market.token, market.hook, payer, address(market.custody));
        bytes memory bindCalldata = abi.encodeCall(
            PermanentPositionCustody.bindMintedPosition,
            (before.nextTokenId, key, params.tickLower, params.tickUpper, params.liquidity)
        );

        vm.expectCall(
            POSITION_MANAGER, abi.encodeWithSelector(PositionManager.modifyLiquidities.selector)
        );
        vm.mockCallRevert(
            address(market.custody),
            bindCalldata,
            abi.encodeWithSelector(
                PermanentPositionCustody.InvalidPositionLiquidity.selector, uint128(0)
            )
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                PermanentPositionCustody.InvalidPositionLiquidity.selector, uint128(0)
            )
        );
        vm.prank(AUTHORITY);
        market.hook.seedCanonicalLiquidity(params);
        vm.clearMockedCalls();

        _assertSeedSnapshot(market, payer, before);
        _assertSolvent(market.hook);
    }

    function _seedSnapshot(Market memory market, address payer)
        private
        view
        returns (SeedSnapshot memory snapshot)
    {
        PoolKey memory key = _canonicalKeyFor(market.token, market.hook);
        snapshot.payerUsdg = IArchiveErc20(USDG).balanceOf(payer);
        snapshot.hookUsdg = IArchiveErc20(USDG).balanceOf(address(market.hook));
        snapshot.poolManagerUsdg = IArchiveErc20(USDG).balanceOf(POOL_MANAGER);
        snapshot.positionManagerUsdg = IArchiveErc20(USDG).balanceOf(POSITION_MANAGER);
        snapshot.payerHkmn = market.token.balanceOf(payer);
        snapshot.hookHkmn = market.token.balanceOf(address(market.hook));
        snapshot.poolManagerHkmn = market.token.balanceOf(POOL_MANAGER);
        snapshot.positionManagerHkmn = market.token.balanceOf(POSITION_MANAGER);
        snapshot.payerUsdgPermit2Allowance = IArchiveErc20(USDG).allowance(payer, PERMIT2);
        snapshot.hookUsdgPermit2Allowance =
            IArchiveErc20(USDG).allowance(address(market.hook), PERMIT2);
        snapshot.hookHkmnPermit2Allowance = market.token.allowance(address(market.hook), PERMIT2);
        (
            snapshot.payerUsdgToHook.amount,
            snapshot.payerUsdgToHook.expiration,
            snapshot.payerUsdgToHook.nonce
        ) = permit2.allowance(payer, USDG, address(market.hook));
        (
            snapshot.hookUsdgToPositionManager.amount,
            snapshot.hookUsdgToPositionManager.expiration,
            snapshot.hookUsdgToPositionManager.nonce
        ) = permit2.allowance(address(market.hook), USDG, POSITION_MANAGER);
        (
            snapshot.hookHkmnToPositionManager.amount,
            snapshot.hookHkmnToPositionManager.expiration,
            snapshot.hookHkmnToPositionManager.nonce
        ) = permit2.allowance(address(market.hook), address(market.token), POSITION_MANAGER);
        (snapshot.sqrtPriceX96, snapshot.tick, snapshot.protocolFee, snapshot.lpFee) =
            manager.getSlot0(key.toId());
        snapshot.liquidity = manager.getLiquidity(key.toId());
        snapshot.nextTokenId = positionManager.nextTokenId();
        snapshot.custodyBindingHook = market.custody.bindingHook();
        snapshot.custodyPositionTokenId = market.custody.positionTokenId();
        snapshot.custodyPositionReceived = market.custody.positionReceived();
        snapshot.canonicalPoolInitialized = market.hook.canonicalPoolInitialized();
        snapshot.canonicalLiquiditySeeded = market.hook.canonicalLiquiditySeeded();
        snapshot.canonicalPositionTokenId = market.hook.canonicalPositionTokenId();
        snapshot.canonicalLaunchCustody = market.hook.canonicalLaunchCustody();
    }

    function _assertSeedSnapshot(Market memory market, address payer, SeedSnapshot memory before)
        private
        view
    {
        SeedSnapshot memory afterFailure = _seedSnapshot(market, payer);
        assertEq(afterFailure.payerUsdg, before.payerUsdg, "late rollback changed payer USDG");
        assertEq(afterFailure.hookUsdg, before.hookUsdg, "late rollback changed hook USDG");
        assertEq(
            afterFailure.poolManagerUsdg,
            before.poolManagerUsdg,
            "late rollback changed PoolManager USDG"
        );
        assertEq(
            afterFailure.positionManagerUsdg,
            before.positionManagerUsdg,
            "late rollback changed PositionManager USDG"
        );
        assertEq(afterFailure.payerHkmn, before.payerHkmn, "late rollback changed payer HKMN");
        assertEq(afterFailure.hookHkmn, before.hookHkmn, "late rollback changed hook HKMN");
        assertEq(
            afterFailure.poolManagerHkmn,
            before.poolManagerHkmn,
            "late rollback changed PoolManager HKMN"
        );
        assertEq(
            afterFailure.positionManagerHkmn,
            before.positionManagerHkmn,
            "late rollback changed PositionManager HKMN"
        );
        assertEq(
            afterFailure.payerUsdgPermit2Allowance,
            before.payerUsdgPermit2Allowance,
            "late rollback changed payer USDG Permit2 allowance"
        );
        assertEq(
            afterFailure.hookUsdgPermit2Allowance,
            before.hookUsdgPermit2Allowance,
            "late rollback changed hook USDG Permit2 allowance"
        );
        assertEq(
            afterFailure.hookHkmnPermit2Allowance,
            before.hookHkmnPermit2Allowance,
            "late rollback changed hook HKMN Permit2 allowance"
        );
        _assertPermit2Allowance(
            afterFailure.payerUsdgToHook,
            before.payerUsdgToHook,
            "late rollback changed payer Permit2 approval"
        );
        _assertPermit2Allowance(
            afterFailure.hookUsdgToPositionManager,
            before.hookUsdgToPositionManager,
            "late rollback changed hook USDG PositionManager approval"
        );
        _assertPermit2Allowance(
            afterFailure.hookHkmnToPositionManager,
            before.hookHkmnToPositionManager,
            "late rollback changed hook HKMN PositionManager approval"
        );
        assertEq(afterFailure.sqrtPriceX96, before.sqrtPriceX96, "late rollback changed pool price");
        assertEq(afterFailure.tick, before.tick, "late rollback changed pool tick");
        assertEq(
            afterFailure.protocolFee, before.protocolFee, "late rollback changed pool protocol fee"
        );
        assertEq(afterFailure.lpFee, before.lpFee, "late rollback changed pool LP fee");
        assertEq(afterFailure.liquidity, before.liquidity, "late rollback changed pool liquidity");
        assertEq(
            afterFailure.nextTokenId,
            before.nextTokenId,
            "late rollback changed position token counter"
        );
        assertEq(
            afterFailure.custodyBindingHook,
            before.custodyBindingHook,
            "late rollback changed custody binding hook"
        );
        assertEq(
            afterFailure.custodyPositionTokenId,
            before.custodyPositionTokenId,
            "late rollback changed custody position token ID"
        );
        assertEq(
            afterFailure.custodyPositionReceived,
            before.custodyPositionReceived,
            "late rollback changed custody receipt state"
        );
        assertEq(
            afterFailure.canonicalPoolInitialized,
            before.canonicalPoolInitialized,
            "late rollback changed canonical pool initialization"
        );
        assertEq(
            afterFailure.canonicalLiquiditySeeded,
            before.canonicalLiquiditySeeded,
            "late rollback changed seed state"
        );
        assertEq(
            afterFailure.canonicalPositionTokenId,
            before.canonicalPositionTokenId,
            "late rollback changed canonical position token ID"
        );
        assertEq(
            afterFailure.canonicalLaunchCustody,
            before.canonicalLaunchCustody,
            "late rollback changed canonical custody"
        );
    }

    function _assertPermit2Allowance(
        Permit2AllowanceSnapshot memory actual,
        Permit2AllowanceSnapshot memory expected,
        string memory message
    ) private pure {
        assertEq(actual.amount, expected.amount, message);
        assertEq(actual.expiration, expected.expiration, message);
        assertEq(actual.nonce, expected.nonce, message);
    }

    function _seedParams(
        HKMNToken token,
        HookemonHook target,
        address seedPayer,
        address seedCustody
    ) private view returns (HookemonHook.SeedParams memory) {
        uint256 hkmnMaximum = token.balanceOf(address(target));
        bool usdgIsCurrency0 = Currency.unwrap(_canonicalKeyFor(token, target).currency0) == USDG;
        return HookemonHook.SeedParams({
            tickLower: TICK_LOWER,
            tickUpper: TICK_UPPER,
            liquidity: usdgIsCurrency0 ? USDG_CURRENCY0_LIQUIDITY : HKMN_CURRENCY0_LIQUIDITY,
            amount0Max: uint128(usdgIsCurrency0 ? USDG_SEED_AMOUNT : hkmnMaximum),
            amount1Max: uint128(usdgIsCurrency0 ? hkmnMaximum : USDG_SEED_AMOUNT),
            deadline: block.timestamp + 1,
            payer: seedPayer,
            custody: seedCustody
        });
    }

    function _fundUsdg(address recipient, uint256 amount) private {
        deal(USDG, recipient, amount, true);
        assertEq(IArchiveErc20(USDG).balanceOf(recipient), amount, "USDG funding mismatch");
    }

    function _canonicalKey() private view returns (PoolKey memory) {
        return _canonicalKeyFor(hkmn, hook);
    }

    function _canonicalKeyFor(HKMNToken token, HookemonHook target)
        private
        pure
        returns (PoolKey memory)
    {
        Currency usdgCurrency = Currency.wrap(USDG);
        Currency hkmnCurrency = Currency.wrap(address(token));
        return Currency.unwrap(usdgCurrency) < Currency.unwrap(hkmnCurrency)
            ? PoolKey(usdgCurrency, hkmnCurrency, 0, 60, IHooks(address(target)))
            : PoolKey(hkmnCurrency, usdgCurrency, 0, 60, IHooks(address(target)));
    }

    function _usdgIsCurrency0() private view returns (bool) {
        return Currency.unwrap(_canonicalKey().currency0) == USDG;
    }

    function _assertSolvent() private view {
        _assertSolvent(hook);
    }

    function _assertSolvent(HookemonHook target) private view {
        FeeSnapshot memory snapshot = _feeSnapshot(target);
        assertTrue(target.isSolvent(), "hook reported insolvency");
        assertEq(
            snapshot.liability,
            snapshot.programmable + snapshot.treasury + snapshot.process,
            "fee liabilities do not reconcile to the total liability"
        );
        assertEq(
            snapshot.usdgBalance,
            snapshot.liability,
            "hook USDG balance does not reconcile to liabilities"
        );
    }

    function _assertGraphInitializerGuards(Market memory candidate) private {
        uint160 launchPriceX96 = candidate.executor.launchPriceX96();

        vm.expectRevert(HookemonHook.UnauthorizedGraphInitializer.selector);
        vm.prank(AUTHORITY);
        candidate.hook.initializeGraphLaunch(address(candidate.custody), launchPriceX96);

        vm.expectRevert(HookemonHook.CanonicalPoolAlreadyInitialized.selector);
        vm.prank(PROVIDER_LAUNCHER);
        candidate.executor
            .initializeAgain(address(candidate.hook), address(candidate.custody), launchPriceX96);
        assertEq(
            candidate.executor.initializerCalls(address(candidate.hook)),
            1,
            "replayed graph initializer changed the initializer count"
        );
    }

    function _assertWrongOrderGraphInitializationRollsBack() private {
        bytes32 graphNonce = keccak256("archive-fork-wrong-initializer-order");
        ProgrammableGraphHarness executor = _newGraphExecutor(graphNonce);
        executor.setLaunchPriceX96(_releaseSqrtPriceX96(false));
        ProgrammableGraphHarness.GraphRequest memory request =
            _graphRequest(executor, false, graphNonce);
        (address predictedToken, address predictedHook, address predictedCustody) =
            executor.predict(request);
        ProgrammableGraphHarness.TargetDeployment[3] memory deployments =
            executor.providerDeployments(request);
        ProgrammableGraphHarness.TargetDeployment memory hookDeployment = deployments[2];
        deployments[2] = deployments[1];
        deployments[1] = hookDeployment;

        vm.expectRevert(HookemonHook.InvalidSeedCustody.selector);
        vm.prank(PROVIDER_LAUNCHER);
        executor.execute(deployments);

        assertEq(predictedToken.code.length, 0, "wrong-order token deployment did not roll back");
        assertEq(predictedHook.code.length, 0, "wrong-order hook deployment did not roll back");
        assertEq(
            predictedCustody.code.length, 0, "wrong-order custody deployment did not roll back"
        );
    }

    function _deployGraphMarket(bool usdgIsCurrency0, bytes32 graphNonce)
        private
        returns (Market memory market)
    {
        market.executor = _newGraphExecutor(graphNonce);
        market.executor.setLaunchPriceX96(_releaseSqrtPriceX96(usdgIsCurrency0));
        ProgrammableGraphHarness.GraphRequest memory request =
            _graphRequest(market.executor, usdgIsCurrency0, graphNonce);
        (market.tokenPredicted, market.hookPredicted, market.custodyPredicted) =
            market.executor.predict(request);

        vm.prank(PROVIDER_LAUNCHER);
        (market.token, market.hook, market.custody) = market.executor.launch(request);

        assertEq(address(market.token), market.tokenPredicted, "token CREATE2 address mismatch");
        assertEq(address(market.hook), market.hookPredicted, "hook CREATE2 address mismatch");
        assertEq(
            address(market.custody), market.custodyPredicted, "custody CREATE2 address mismatch"
        );
        assertEq(
            market.token.balanceOf(address(market.hook)),
            HKMN_POOL_ALLOCATION,
            "graph did not allocate the full supply to the hook"
        );
        assertEq(
            market.token.balanceOf(address(market.custody)), 0, "custody received a token remainder"
        );
        assertEq(
            market.executor.launchPriceX96(),
            _releaseSqrtPriceX96(usdgIsCurrency0),
            "release price selection drifted"
        );
    }

    function _newGraphExecutor(bytes32 graphNonce)
        private
        returns (ProgrammableGraphHarness executor)
    {
        executor = new ProgrammableGraphHarness(
            manager,
            POSITION_MANAGER,
            PERMIT2,
            USDG,
            0,
            AUTHORITY,
            keccak256(abi.encodePacked("archive-fork-route", graphNonce)),
            keccak256(abi.encodePacked("archive-fork-nonce", graphNonce))
        );
    }

    function _releaseSqrtPriceX96(bool usdgIsCurrency0) private pure returns (uint160) {
        return usdgIsCurrency0 ? USDG_CURRENCY0_SQRT_PRICE_X96 : HKMN_CURRENCY0_SQRT_PRICE_X96;
    }

    function _graphRequest(
        ProgrammableGraphHarness executor,
        bool usdgIsCurrency0,
        bytes32 graphNonce
    ) private view returns (ProgrammableGraphHarness.GraphRequest memory request) {
        request = ProgrammableGraphHarness.GraphRequest({
            tokenTargetIdHash: TOKEN_TARGET_ID,
            hookTargetIdHash: HOOK_TARGET_ID,
            custodyTargetIdHash: CUSTODY_TARGET_ID,
            tokenApplicantSalt: bytes32(0),
            hookApplicantSalt: bytes32(0),
            custodyApplicantSalt: keccak256(abi.encodePacked("archive-fork-custody", graphNonce)),
            initializationPriceX96: executor.launchPriceX96(),
            hookUsdg: USDG,
            allocationCustody: address(0),
            hookExpectedDecimals: 18
        });

        for (uint256 nonce; nonce < 10_000; ++nonce) {
            request.tokenApplicantSalt =
                keccak256(abi.encodePacked("archive-fork-token", graphNonce, nonce));
            (address predictedToken,,) = executor.predict(request);
            if ((USDG < predictedToken) == usdgIsCurrency0) break;
            if (nonce == 9_999) revert("ordered graph token salt not found");
        }

        request.hookApplicantSalt =
            _findGraphHookApplicantSalt(executor, executor.hookInitCodeHash(request));
    }

    function _findGraphHookApplicantSalt(
        ProgrammableGraphHarness executor,
        bytes32 hookInitCodeHash
    ) private view returns (bytes32) {
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 applicantSalt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(
                executor.effectiveSalt(HOOK_TARGET_ID, applicantSalt),
                hookInitCodeHash,
                address(executor)
            );
            if ((uint160(predicted) & ALL_HOOK_MASK) == REQUIRED_HOOK_MASK) {
                return applicantSalt;
            }
        }
        revert("archive graph hook salt not found");
    }

    function _observeProviderGraph(IArchiveGraphFactory factory, ProviderGraphPlan memory plan)
        private
        returns (ProviderGraphObservation memory observation)
    {
        uint256 snapshot = vm.snapshotState();
        vm.prank(PROVIDER_LAUNCHER);
        (
            observation.deployments,
            observation.runtimeCodeHashes,
            observation.runtimeCodes,
            observation.graphDeploymentHash
        ) = factory.deployGraph(plan.authorization, plan.targets);
        _assertProviderGraphExecution(
            plan, observation.deployments, observation.runtimeCodeHashes, observation.runtimeCodes
        );
        assertTrue(vm.revertTo(snapshot), "provider graph snapshot did not revert");
    }

    function _providerRouteEnvelope(
        IArchiveStampRouter router,
        ProviderGraphPlan memory plan,
        ProviderGraphObservation memory observation
    ) private view returns (ProviderRouteEnvelope memory envelope) {
        IArchiveStampRouter.ExpectedGraphOutputV1[] memory expectedOutputs =
            _providerExpectedOutputs(plan, observation.runtimeCodeHashes);
        envelope.routePayload = abi.encode(
            IArchiveStampRouter.CustomGraphRouteV1({
                routeNamespace: plan.authorization.routeNamespace,
                routeNonce: plan.authorization.routeNonce,
                topologyHash: plan.authorization.topologyHash,
                graphCommitment: plan.authorization.graphCommitment,
                targets: plan.targets,
                expectedOutputs: expectedOutputs,
                expectedGraphDeploymentHash: observation.graphDeploymentHash
            })
        );
        envelope.stampRequest = _providerStampRequest(plan, observation.runtimeCodeHashes);
        envelope.permit = IArchiveStampRouter.LaunchPermitV1({
            chainId: ROBINHOOD_CHAIN_ID,
            router: PROVIDER_LAUNCHER,
            launchWallet: PAYER,
            kind: IArchiveStampRouter.LaunchKindV1.CustomGraph,
            routePayloadHash: keccak256(envelope.routePayload),
            expectedResultHash: _providerExpectedResultHash(
                expectedOutputs, observation.graphDeploymentHash
            ),
            stampRequestHash: router.computeStampRequestHash(envelope.stampRequest),
            nonce: plan.authorization.routeNonce,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 1 hours),
            value: 0
        });
    }

    function _launchProviderRoute(IArchiveStampRouter router, ProviderRouteEnvelope memory envelope)
        private
        returns (ProviderRouteGasObservation memory observation)
    {
        bytes32 permitAuthorityCodehashBefore = PERMIT_AUTHORITY.codehash;
        bytes memory launchCalldata = abi.encodeWithSelector(
            IArchiveStampRouter.launchAndStampV1.selector,
            envelope.permit,
            envelope.stampRequest,
            envelope.routePayload,
            hex"01"
        );
        observation.calldataBytes = launchCalldata.length;
        observation.intrinsicTransactionGas = _providerRouteIntrinsicGas(launchCalldata);
        observation.calldataGas = observation.intrinsicTransactionGas - EVM_TRANSACTION_BASE_GAS;
        vm.mockCall(
            PERMIT_AUTHORITY,
            abi.encodeWithSelector(IArchivePermitAuthority.isValidSignature.selector),
            abi.encode(bytes4(0x1626ba7e))
        );
        vm.prank(PAYER);
        (bool succeeded, bytes memory returnData) = address(router).call(launchCalldata);
        observation.calleeGas = vm.lastCallGas().gasTotalUsed;
        assertTrue(succeeded, "provider router launch call reverted");
        bytes32 stampHash = abi.decode(returnData, (bytes32));
        observation.transactionGas = observation.calleeGas + observation.intrinsicTransactionGas;
        assertTrue(stampHash != bytes32(0), "provider router did not return a stamp");
        assertEq(PERMIT_AUTHORITY.codehash, permitAuthorityCodehashBefore, "permit code changed");
    }

    function _providerRouteIntrinsicGas(bytes memory calldataBytes)
        private
        pure
        returns (uint256 intrinsicGas)
    {
        intrinsicGas = EVM_TRANSACTION_BASE_GAS;
        for (uint256 index; index < calldataBytes.length; ++index) {
            intrinsicGas += calldataBytes[index] == bytes1(0)
                ? EVM_ZERO_CALLDATA_BYTE_GAS
                : EVM_NONZERO_CALLDATA_BYTE_GAS;
        }
    }

    function _buildProviderGraphPlan(IArchiveGraphFactory factory)
        private
        view
        returns (ProviderGraphPlan memory plan)
    {
        IArchiveGraphFactory.GraphAuthorization memory authorization =
            IArchiveGraphFactory.GraphAuthorization({
                routeNamespace: PROVIDER_GAS_ROUTE_NAMESPACE,
                routeNonce: PROVIDER_GAS_ROUTE_NONCE,
                topologyHash: PROVIDER_GAS_TOPOLOGY_HASH,
                graphCommitment: bytes32(uint256(1)),
                authorizedLauncher: PROVIDER_LAUNCHER,
                totalValue: 0
            });
        IArchiveGraphFactory.Target[] memory targets = new IArchiveGraphFactory.Target[](3);
        (targets[0], plan.token, plan.initializationPriceX96) =
            _providerOrderedTokenTarget(factory, authorization);

        HookemonHook.ConstructorConfig memory hookConfig = _providerHookConfig(plan.token);
        targets[2] = IArchiveGraphFactory.Target({
            targetIdHash: PROVIDER_GAS_HOOK_TARGET_ID,
            applicantSalt: _findProviderHookApplicantSalt(
                authorization,
                keccak256(abi.encodePacked(type(HookemonHook).creationCode, abi.encode(hookConfig)))
            ),
            deploymentValue: 0,
            initializerValue: 0,
            initCode: abi.encodePacked(type(HookemonHook).creationCode, abi.encode(hookConfig)),
            initializerCalldata: bytes("")
        });
        plan.hook = _predictProviderTarget(factory, authorization, targets[2]);

        targets[1] = IArchiveGraphFactory.Target({
            targetIdHash: PROVIDER_GAS_CUSTODY_TARGET_ID,
            applicantSalt: keccak256(
                abi.encodePacked("phase-three-provider-gas-custody", PROVIDER_GAS_ROUTE_NONCE)
            ),
            deploymentValue: 0,
            initializerValue: 0,
            initCode: abi.encodePacked(
                type(PermanentPositionCustody).creationCode, abi.encode(POSITION_MANAGER, 0)
            ),
            initializerCalldata: bytes("")
        });
        plan.custody = _predictProviderTarget(factory, authorization, targets[1]);

        targets[0].initializerCalldata = abi.encodeCall(HKMNToken.allocate, (plan.hook));
        targets[1].initializerCalldata =
            abi.encodeCall(PermanentPositionCustody.configureBindingHook, (plan.hook));
        targets[2].initializerCalldata = abi.encodeCall(
            HookemonHook.initializeGraphLaunch, (plan.custody, plan.initializationPriceX96)
        );
        uint256 targetValueSum;
        (authorization.graphCommitment, targetValueSum) =
            factory.computeGraphCommitment(authorization, targets);
        assertEq(targetValueSum, 0, "provider graph native value drifted");

        plan.authorization = authorization;
        plan.targets = targets;
    }

    function _providerOrderedTokenTarget(
        IArchiveGraphFactory factory,
        IArchiveGraphFactory.GraphAuthorization memory authorization
    )
        private
        view
        returns (IArchiveGraphFactory.Target memory target, address predicted, uint160 price)
    {
        for (uint256 candidate; candidate < 10_000; ++candidate) {
            bytes32 applicantSalt =
                keccak256(abi.encodePacked("phase-three-provider-gas-token", candidate));
            target = _providerTokenTarget(applicantSalt, USDG_CURRENCY0_SQRT_PRICE_X96);
            predicted = _predictProviderTarget(factory, authorization, target);
            if (USDG < predicted) return (target, predicted, USDG_CURRENCY0_SQRT_PRICE_X96);

            target = _providerTokenTarget(applicantSalt, HKMN_CURRENCY0_SQRT_PRICE_X96);
            predicted = _predictProviderTarget(factory, authorization, target);
            if (predicted < USDG) return (target, predicted, HKMN_CURRENCY0_SQRT_PRICE_X96);
        }
        revert ProviderTokenOrderNotFound();
    }

    function _providerTokenTarget(bytes32 applicantSalt, uint160 price)
        private
        pure
        returns (IArchiveGraphFactory.Target memory)
    {
        return IArchiveGraphFactory.Target({
            targetIdHash: PROVIDER_GAS_TOKEN_TARGET_ID,
            applicantSalt: applicantSalt,
            deploymentValue: 0,
            initializerValue: 0,
            initCode: abi.encodePacked(
                type(HKMNToken).creationCode, abi.encode(GRAPH_FACTORY, USDG, uint8(18), price)
            ),
            initializerCalldata: bytes("")
        });
    }

    function _providerHookConfig(address token)
        private
        pure
        returns (HookemonHook.ConstructorConfig memory config)
    {
        config = HookemonHook.ConstructorConfig({
            manager: IPoolManager(POOL_MANAGER),
            positionManager: POSITION_MANAGER,
            permit2: PERMIT2,
            usdg: Currency.wrap(USDG),
            hkmn: Currency.wrap(token),
            tickSpacing: 60,
            programmable: RobinhoodBindings.PROGRAMMABLE_BENEFICIARY,
            treasury: TREASURY,
            operations: GRAPH_OPERATIONS,
            launchAuthority: AUTHORITY,
            issuanceAuthority: GRAPH_FACTORY,
            expectedDecimals: 18,
            bindingDigest: keccak256("phase-three-provider-gas-binding-v1"),
            runtimeDigest: keccak256("phase-three-provider-gas-runtime-v1"),
            processClaimLimit6h: 50_000_000_000,
            processClaimLimitMax: 500_000_000_000,
            processClaimMaxCount: 24,
            operationsRotationDelay: 43_200
        });
    }

    function _predictProviderTarget(
        IArchiveGraphFactory factory,
        IArchiveGraphFactory.GraphAuthorization memory authorization,
        IArchiveGraphFactory.Target memory target
    ) private view returns (address predicted) {
        bytes32 effectiveSalt = keccak256(
            abi.encode(
                TARGET_SALT_TYPEHASH,
                block.chainid,
                GRAPH_FACTORY,
                authorization.routeNamespace,
                authorization.routeNonce,
                target.targetIdHash,
                target.applicantSalt,
                authorization.authorizedLauncher
            )
        );
        predicted =
            vm.computeCreate2Address(effectiveSalt, keccak256(target.initCode), GRAPH_FACTORY);
        assertEq(
            factory.predictTarget(authorization, target),
            predicted,
            "provider graph target prediction drifted"
        );
    }

    function _findProviderHookApplicantSalt(
        IArchiveGraphFactory.GraphAuthorization memory authorization,
        bytes32 hookInitCodeHash
    ) private view returns (bytes32 applicantSalt) {
        for (uint256 candidate; candidate < 262_144; ++candidate) {
            applicantSalt = keccak256(abi.encodePacked("phase-three-provider-gas-hook", candidate));
            bytes32 effectiveSalt = keccak256(
                abi.encode(
                    TARGET_SALT_TYPEHASH,
                    block.chainid,
                    GRAPH_FACTORY,
                    authorization.routeNamespace,
                    authorization.routeNonce,
                    PROVIDER_GAS_HOOK_TARGET_ID,
                    applicantSalt,
                    authorization.authorizedLauncher
                )
            );
            address predicted =
                vm.computeCreate2Address(effectiveSalt, hookInitCodeHash, GRAPH_FACTORY);
            if ((uint160(predicted) & ALL_HOOK_MASK) == REQUIRED_HOOK_MASK) return applicantSalt;
        }
        revert ProviderHookSaltNotFound();
    }

    function _assertProviderGraphExecution(
        ProviderGraphPlan memory plan,
        address[] memory deployments,
        bytes32[] memory runtimeCodeHashes,
        bytes[] memory runtimeCodes
    ) private view {
        assertEq(deployments.length, 3, "provider graph deployment count drifted");
        assertEq(runtimeCodeHashes.length, 3, "provider graph hash count drifted");
        assertEq(runtimeCodes.length, 3, "provider graph code count drifted");
        assertEq(deployments[0], plan.token, "provider token prediction drifted");
        assertEq(deployments[1], plan.custody, "provider custody prediction drifted");
        assertEq(deployments[2], plan.hook, "provider hook prediction drifted");
        assertEq(
            runtimeCodeHashes[0],
            PROVIDER_GAS_TOKEN_RUNTIME_CODEHASH,
            "provider token runtime pin drifted"
        );
        assertEq(
            runtimeCodeHashes[1],
            PROVIDER_GAS_CUSTODY_RUNTIME_CODEHASH,
            "provider custody runtime pin drifted"
        );
        assertEq(
            runtimeCodeHashes[2],
            PROVIDER_GAS_HOOK_RUNTIME_CODEHASH,
            "provider hook runtime pin drifted"
        );

        for (uint256 index; index < deployments.length; ++index) {
            assertEq(
                deployments[index].codehash,
                runtimeCodeHashes[index],
                "provider deployed runtime hash drifted"
            );
            assertEq(
                keccak256(runtimeCodes[index]),
                runtimeCodeHashes[index],
                "provider returned runtime bytes drifted"
            );
        }
    }

    function _providerExpectedOutputs(
        ProviderGraphPlan memory plan,
        bytes32[] memory runtimeCodeHashes
    ) private pure returns (IArchiveStampRouter.ExpectedGraphOutputV1[] memory outputs) {
        outputs = new IArchiveStampRouter.ExpectedGraphOutputV1[](3);
        outputs[0] = IArchiveStampRouter.ExpectedGraphOutputV1({
            targetIndex: 0,
            targetIdHash: PROVIDER_GAS_TOKEN_TARGET_ID,
            account: plan.token,
            runtimeCodeHash: runtimeCodeHashes[0]
        });
        outputs[1] = IArchiveStampRouter.ExpectedGraphOutputV1({
            targetIndex: 1,
            targetIdHash: PROVIDER_GAS_CUSTODY_TARGET_ID,
            account: plan.custody,
            runtimeCodeHash: runtimeCodeHashes[1]
        });
        outputs[2] = IArchiveStampRouter.ExpectedGraphOutputV1({
            targetIndex: 2,
            targetIdHash: PROVIDER_GAS_HOOK_TARGET_ID,
            account: plan.hook,
            runtimeCodeHash: runtimeCodeHashes[2]
        });
    }

    function _providerStampRequest(
        ProviderGraphPlan memory plan,
        bytes32[] memory runtimeCodeHashes
    ) private pure returns (IArchiveStampRouter.StampRequestV1 memory request) {
        IArchiveStampRouter.ComponentV1[] memory components =
            _providerComponents(plan, runtimeCodeHashes);
        request = IArchiveStampRouter.StampRequestV1({
            launchId: PROVIDER_GAS_LAUNCH_ID,
            token: plan.token,
            tokenRuntimeCodeHash: runtimeCodeHashes[0],
            poolKey: _canonicalKeyFor(HKMNToken(plan.token), HookemonHook(plan.hook)),
            hookRuntimeCodeHash: runtimeCodeHashes[2],
            components: components
        });
    }

    function _providerComponents(ProviderGraphPlan memory plan, bytes32[] memory runtimeCodeHashes)
        private
        pure
        returns (IArchiveStampRouter.ComponentV1[] memory components)
    {
        components = new IArchiveStampRouter.ComponentV1[](3);
        components[0] = IArchiveStampRouter.ComponentV1({
            resultIndex: 0,
            account: plan.token,
            runtimeCodeHash: runtimeCodeHashes[0],
            kind: IArchiveStampRouter.ComponentKindV1.Token,
            scope: IArchiveStampRouter.ComponentScopeV1.Exclusive
        });
        components[1] = IArchiveStampRouter.ComponentV1({
            resultIndex: 1,
            account: plan.custody,
            runtimeCodeHash: runtimeCodeHashes[1],
            kind: IArchiveStampRouter.ComponentKindV1.Other,
            scope: IArchiveStampRouter.ComponentScopeV1.Exclusive
        });
        components[2] = IArchiveStampRouter.ComponentV1({
            resultIndex: 2,
            account: plan.hook,
            runtimeCodeHash: runtimeCodeHashes[2],
            kind: IArchiveStampRouter.ComponentKindV1.Hook,
            scope: IArchiveStampRouter.ComponentScopeV1.Exclusive
        });

        for (uint256 index; index < components.length; ++index) {
            for (uint256 next = index + 1; next < components.length; ++next) {
                if (components[index].account > components[next].account) {
                    IArchiveStampRouter.ComponentV1 memory swapped = components[index];
                    components[index] = components[next];
                    components[next] = swapped;
                }
            }
        }
    }

    function _providerExpectedResultHash(
        IArchiveStampRouter.ExpectedGraphOutputV1[] memory outputs,
        bytes32 graphDeploymentHash
    ) private pure returns (bytes32) {
        bytes32[] memory outputHashes = new bytes32[](outputs.length);
        for (uint256 index; index < outputs.length; ++index) {
            IArchiveStampRouter.ExpectedGraphOutputV1 memory output = outputs[index];
            outputHashes[index] = keccak256(
                abi.encode(
                    EXPECTED_GRAPH_OUTPUT_TYPEHASH,
                    output.targetIndex,
                    output.targetIdHash,
                    output.account,
                    output.runtimeCodeHash
                )
            );
        }
        return keccak256(
            abi.encode(
                EXPECTED_GRAPH_RESULT_TYPEHASH,
                keccak256(abi.encodePacked(outputHashes)),
                graphDeploymentHash
            )
        );
    }

    function _assertProviderPostLaunchState(
        ProviderGraphPlan memory plan,
        IArchiveStampRouter.StampRequestV1 memory stampRequest,
        bytes32[] memory runtimeCodeHashes,
        IArchiveStampRouter router
    ) private view {
        assertEq(plan.token.codehash, runtimeCodeHashes[0], "provider token runtime hash drifted");
        assertEq(
            plan.custody.codehash, runtimeCodeHashes[1], "provider custody runtime hash drifted"
        );
        assertEq(plan.hook.codehash, runtimeCodeHashes[2], "provider hook runtime hash drifted");
        HKMNToken token = HKMNToken(plan.token);
        assertEq(
            token.balanceOf(plan.hook),
            token.totalSupply(),
            "provider graph did not allocate the full supply to the hook"
        );
        assertEq(token.balanceOf(plan.custody), 0, "provider custody received a token remainder");
        assertEq(
            router.launchIdByToken(plan.token),
            stampRequest.launchId,
            "provider token stamp mapping drifted"
        );
        for (uint256 index; index < stampRequest.components.length; ++index) {
            IArchiveStampRouter.ComponentV1 memory component = stampRequest.components[index];
            assertEq(
                router.launchIdByComponent(component.account),
                stampRequest.launchId,
                "provider component stamp mapping drifted"
            );
            assertEq(
                router.componentRuntimeCodeHash(component.account),
                component.runtimeCodeHash,
                "provider component runtime mapping drifted"
            );
        }
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(stampRequest.poolKey.toId());
        assertEq(sqrtPriceX96, plan.initializationPriceX96, "provider pool price drifted");
        assertEq(
            sqrtPriceX96,
            _releaseSqrtPriceX96(USDG < plan.token),
            "provider release price candidate drifted"
        );
    }

    function _assertProviderRouteGasEnvelope(uint256 observedGas, uint256 documentedMargin)
        private
        pure
    {
        if (
            observedGas >= GENESIS_GAS_ENVELOPE_LIMIT
                || documentedMargin >= GENESIS_GAS_ENVELOPE_LIMIT - observedGas
        ) {
            revert ProviderRouteGasEnvelopeExceeded(observedGas, documentedMargin);
        }
    }

    function _assertPinnedRuntimeBundle() private view {
        assertEq(
            GRAPH_FACTORY.codehash,
            GRAPH_FACTORY_RUNTIME_CODEHASH,
            "provider graph factory runtime drifted"
        );
        assertEq(
            PROVIDER_LAUNCHER.codehash,
            PROVIDER_ROUTER_RUNTIME_CODEHASH,
            "provider router runtime drifted"
        );
        assertEq(
            PERMIT_AUTHORITY.codehash,
            PERMIT_AUTHORITY_RUNTIME_CODEHASH,
            "permit authority runtime drifted"
        );
        assertEq(
            POOL_MANAGER.codehash, POOL_MANAGER_RUNTIME_CODEHASH, "PoolManager runtime drifted"
        );
        assertEq(
            POSITION_MANAGER.codehash,
            POSITION_MANAGER_RUNTIME_CODEHASH,
            "PositionManager runtime drifted"
        );
        assertEq(PERMIT2.codehash, PERMIT2_RUNTIME_CODEHASH, "Permit2 runtime drifted");
        assertEq(USDG.codehash, USDG_PROXY_RUNTIME_CODEHASH, "USDG proxy runtime drifted");
        assertEq(
            UNIVERSAL_ROUTER.codehash,
            UNIVERSAL_ROUTER_RUNTIME_CODEHASH,
            "Universal Router runtime drifted"
        );
        assertEq(STATE_VIEW.codehash, STATE_VIEW_RUNTIME_CODEHASH, "StateView runtime drifted");
        assertEq(V4_QUOTER.codehash, V4_QUOTER_RUNTIME_CODEHASH, "V4Quoter runtime drifted");

        address implementation =
            address(uint160(uint256(vm.load(USDG, EIP1967_IMPLEMENTATION_SLOT))));
        assertEq(implementation, USDG_IMPLEMENTATION, "USDG implementation address drifted");
        assertEq(
            implementation.codehash,
            USDG_IMPLEMENTATION_RUNTIME_CODEHASH,
            "USDG implementation runtime drifted"
        );

        IArchiveStampRouter router = IArchiveStampRouter(PROVIDER_LAUNCHER);
        assertEq(router.GRAPH_FACTORY(), GRAPH_FACTORY, "router graph factory binding drifted");
        assertEq(
            router.GRAPH_FACTORY_RUNTIME_CODE_HASH(),
            GRAPH_FACTORY_RUNTIME_CODEHASH,
            "router graph factory hash binding drifted"
        );
        assertEq(
            router.PERMIT_AUTHORITY(), PERMIT_AUTHORITY, "router permit authority binding drifted"
        );
        assertEq(
            router.PERMIT_AUTHORITY_RUNTIME_CODE_HASH(),
            PERMIT_AUTHORITY_RUNTIME_CODEHASH,
            "router permit authority hash binding drifted"
        );
        assertEq(router.POOL_MANAGER(), POOL_MANAGER, "router pool manager binding drifted");
        assertEq(
            router.POOL_MANAGER_RUNTIME_CODE_HASH(),
            POOL_MANAGER_RUNTIME_CODEHASH,
            "router pool manager hash binding drifted"
        );
        assertEq(router.CHAIN_ID(), ROBINHOOD_CHAIN_ID, "router chain binding drifted");
    }
}
