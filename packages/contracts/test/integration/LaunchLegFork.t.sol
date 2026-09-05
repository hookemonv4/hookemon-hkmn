// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "../../lib/v4-core/lib/forge-std/src/Test.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { PositionManager } from "@uniswap/v4-periphery/src/PositionManager.sol";
import {
    PositionInfo,
    PositionInfoLibrary
} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";

import { HookemonHook } from "../../src/HookemonHook.sol";
import { PermanentPositionCustody } from "../../src/bindings/RobinhoodBindings.sol";
import { HKMNToken } from "../../src/launch/HKMNToken.sol";
import { ProgrammableGraphHarness } from "../launch/LaunchComposition.t.sol";

contract LaunchLegForkToken {
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

contract LaunchLegForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;
    using StateLibrary for IPoolManager;

    uint160 private constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 private constant REQUIRED_HOOK_MASK = 0x20CC;
    uint128 private constant USDG_SEED_AMOUNT = 240_000_000;
    uint128 private constant USDG_CURRENCY0_LIQUIDITY = 489897948556635619;
    uint128 private constant HKMN_CURRENCY0_LIQUIDITY = 489897948572597439;
    int24 private constant TICK_LOWER = -887220;
    int24 private constant TICK_UPPER = 887220;
    uint160 private constant USDG_CURRENCY0_SQRT_PRICE_X96 =
        161723809515207654588927258648643645224;
    uint160 private constant HKMN_CURRENCY0_SQRT_PRICE_X96 = 38813714284914462669;
    string private constant FORK_RPC_URL_ENV = "ROBINHOOD_FORK_RPC_URL";
    address private constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address private constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address private constant PROVIDER_LAUNCHER = 0x34965F2A2ee9254522232C32F02056E92BE0C98a;
    bytes32 private constant POOL_MANAGER_CODEHASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    bytes32 private constant POSITION_MANAGER_CODEHASH =
        0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2;
    address private constant TREASURY = address(0x6000);
    address private constant AUTHORITY = address(0xA11CE);
    address private constant PAYER = address(0xBEEF);
    bytes32 private constant TOKEN_TARGET_ID = keccak256("hkmn-token-target");
    bytes32 private constant HOOK_TARGET_ID = keccak256("hook-target");
    bytes32 private constant CUSTODY_TARGET_ID = keccak256("custody-target");

    error ConfiguredArchiveForkUnavailable();

    IPoolManager private manager;
    PositionManager private positionManager;
    IAllowanceTransfer private permit2;
    LaunchLegForkToken private usdgToken;
    HKMNToken private hkmnToken;
    ProgrammableGraphHarness private graph;
    HookemonHook private hook;
    PermanentPositionCustody private custody;
    bool private forkReady;

    function setUp() external {
        string memory rpcUrl = vm.envOr(FORK_RPC_URL_ENV, string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true, "LaunchLegFork: skipped because ROBINHOOD_FORK_RPC_URL is unset.");
            return;
        }

        try vm.createSelectFork(rpcUrl) { }
        catch {
            revert ConfiguredArchiveForkUnavailable();
        }

        assertEq(block.chainid, 4663, "unexpected fork chain");
        assertEq(POOL_MANAGER.codehash, POOL_MANAGER_CODEHASH, "PoolManager runtime drift");
        assertEq(
            POSITION_MANAGER.codehash, POSITION_MANAGER_CODEHASH, "PositionManager runtime drift"
        );
        assertGt(PERMIT2.code.length, 0, "Permit2 has no runtime code");

        manager = IPoolManager(POOL_MANAGER);
        positionManager = PositionManager(payable(POSITION_MANAGER));
        assertEq(
            address(positionManager.poolManager()), POOL_MANAGER, "PositionManager pool mismatch"
        );
        permit2 = positionManager.permit2();
        assertEq(address(permit2), PERMIT2, "PositionManager Permit2 mismatch");

        vm.etch(USDG, type(LaunchLegForkToken).runtimeCode);
        usdgToken = LaunchLegForkToken(USDG);

        graph = new ProgrammableGraphHarness(
            manager,
            POSITION_MANAGER,
            PERMIT2,
            USDG,
            0,
            AUTHORITY,
            keccak256("launch-leg-fork-route"),
            keccak256("launch-leg-fork-nonce")
        );
        _selectReleasePriceCandidate();
        ProgrammableGraphHarness.GraphRequest memory request = _graphRequest();
        vm.prank(PROVIDER_LAUNCHER);
        (hkmnToken, hook, custody) = graph.launch(request);

        usdgToken.mint(PAYER, USDG_SEED_AMOUNT);

        vm.startPrank(PAYER);
        usdgToken.approve(PERMIT2, USDG_SEED_AMOUNT);
        permit2.approve(USDG, address(hook), USDG_SEED_AMOUNT, type(uint48).max);
        vm.stopPrank();

        forkReady = true;
    }

    function testSeedCanonicalLiquidityUsesForkedManagerAndPermit2() external {
        if (!forkReady) return;

        uint256 tokenId = positionManager.nextTokenId();
        uint256 payerBalanceBefore = usdgToken.balanceOf(PAYER);
        uint256 hookHkmnBefore = hkmnToken.balanceOf(address(hook));
        uint256 treasuryHkmnBefore = hkmnToken.balanceOf(TREASURY);
        uint256 managerHkmnBefore = hkmnToken.balanceOf(address(manager));

        HookemonHook.SeedParams memory params = _seedParams();
        vm.prank(AUTHORITY);
        hook.seedCanonicalLiquidity(params);

        assertTrue(hook.canonicalLiquiditySeeded());
        assertEq(hook.canonicalPositionTokenId(), tokenId);
        assertEq(positionManager.nextTokenId(), tokenId + 1);
        assertEq(custody.positionTokenId(), tokenId);
        assertTrue(custody.positionReceived());
        assertEq(positionManager.ownerOf(tokenId), address(custody));
        assertEq(
            positionManager.getPositionLiquidity(tokenId),
            USDG < address(hkmnToken) ? USDG_CURRENCY0_LIQUIDITY : HKMN_CURRENCY0_LIQUIDITY
        );

        (PoolKey memory key, PositionInfo info) = positionManager.getPoolAndPositionInfo(tokenId);
        assertEq(keccak256(abi.encode(key)), keccak256(abi.encode(_canonicalKey())));
        assertEq(info.tickLower(), TICK_LOWER);
        assertEq(info.tickUpper(), TICK_UPPER);

        uint256 usdgSpent = payerBalanceBefore - usdgToken.balanceOf(PAYER);
        uint256 hkmnSpent = hkmnToken.balanceOf(address(manager)) - managerHkmnBefore;
        uint256 hkmnDustTransferred = hkmnToken.balanceOf(TREASURY) - treasuryHkmnBefore;
        assertEq(usdgSpent, USDG_SEED_AMOUNT);
        assertEq(hkmnSpent, hookHkmnBefore);
        assertEq(hkmnDustTransferred, 0);
        assertEq(usdgToken.balanceOf(address(hook)), 0);
        assertEq(hkmnToken.balanceOf(address(hook)), 0);
        assertEq(hkmnSpent + hkmnDustTransferred, hookHkmnBefore);
        _assertPermit2AllowanceZero(PAYER, USDG, address(hook));
        _assertPermit2AllowanceZero(address(hook), USDG, POSITION_MANAGER);
        _assertPermit2AllowanceZero(address(hook), address(hkmnToken), POSITION_MANAGER);
        assertEq(usdgToken.allowance(address(hook), PERMIT2), 0);
        assertEq(hkmnToken.allowance(address(hook), PERMIT2), 0);
    }

    function testLaunchLegUsesProviderOrderedGraphInitializers() external view {
        if (!forkReady) return;

        HKMNToken graphToken = HKMNToken(address(hkmnToken));
        assertEq(graphToken.issuanceAuthority(), address(graph), "token issuance authority drifted");
        assertEq(graphToken.decimals(), 18, "token decimals drifted");
        assertTrue(graphToken.allocated(), "token allocation was not completed");
        assertEq(
            graphToken.balanceOf(address(hook)),
            graphToken.totalSupply(),
            "graph did not allocate the full supply to the hook"
        );
        assertEq(graphToken.balanceOf(address(custody)), 0, "custody received a token remainder");
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
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(_canonicalKey().toId());
        assertEq(sqrtPriceX96, graph.launchPriceX96(), "release price selection drifted");
    }

    function _seedParams() private view returns (HookemonHook.SeedParams memory) {
        uint256 hkmnMax = hkmnToken.balanceOf(address(hook));
        bool usdgIsCurrency0 = USDG < address(hkmnToken);
        return HookemonHook.SeedParams({
            tickLower: TICK_LOWER,
            tickUpper: TICK_UPPER,
            liquidity: usdgIsCurrency0 ? USDG_CURRENCY0_LIQUIDITY : HKMN_CURRENCY0_LIQUIDITY,
            amount0Max: uint128(usdgIsCurrency0 ? USDG_SEED_AMOUNT : hkmnMax),
            amount1Max: uint128(usdgIsCurrency0 ? hkmnMax : USDG_SEED_AMOUNT),
            deadline: block.timestamp + 1,
            payer: PAYER,
            custody: address(custody)
        });
    }

    function _graphRequest()
        private
        view
        returns (ProgrammableGraphHarness.GraphRequest memory request)
    {
        request = ProgrammableGraphHarness.GraphRequest({
            tokenTargetIdHash: TOKEN_TARGET_ID,
            hookTargetIdHash: HOOK_TARGET_ID,
            custodyTargetIdHash: CUSTODY_TARGET_ID,
            tokenApplicantSalt: keccak256("launch-leg-fork-token-salt"),
            hookApplicantSalt: bytes32(0),
            custodyApplicantSalt: keccak256("launch-leg-fork-custody-salt"),
            initializationPriceX96: graph.launchPriceX96(),
            hookUsdg: USDG,
            allocationCustody: address(0),
            hookExpectedDecimals: 18
        });
        request.hookApplicantSalt = _findGraphHookApplicantSalt(graph.hookInitCodeHash(request));
    }

    function _selectReleasePriceCandidate() private {
        graph.setLaunchPriceX96(USDG_CURRENCY0_SQRT_PRICE_X96);
        (address usdgCurrency0Token,,) = graph.predict(_graphRequest());
        if (USDG < usdgCurrency0Token) return;

        graph.setLaunchPriceX96(HKMN_CURRENCY0_SQRT_PRICE_X96);
        (address hkmnCurrency0Token,,) = graph.predict(_graphRequest());
        assertLt(uint160(hkmnCurrency0Token), uint160(USDG), "price candidate ordering drifted");
    }

    function _findGraphHookApplicantSalt(bytes32 initCodeHash) private view returns (bytes32) {
        for (uint256 nonce; nonce < 100_000; ++nonce) {
            bytes32 applicantSalt = bytes32(nonce);
            address predicted = vm.computeCreate2Address(
                graph.effectiveSalt(HOOK_TARGET_ID, applicantSalt), initCodeHash, address(graph)
            );
            if ((uint160(predicted) & ALL_HOOK_MASK) == REQUIRED_HOOK_MASK) {
                return applicantSalt;
            }
        }
        revert("valid provider hook salt not found");
    }

    function _canonicalKey() private view returns (PoolKey memory) {
        Currency usdg = Currency.wrap(USDG);
        Currency hkmn = Currency.wrap(address(hkmnToken));
        return Currency.unwrap(usdg) < Currency.unwrap(hkmn)
            ? PoolKey(usdg, hkmn, 0, 60, IHooks(address(hook)))
            : PoolKey(hkmn, usdg, 0, 60, IHooks(address(hook)));
    }

    function _assertPermit2AllowanceZero(address owner, address token, address spender)
        private
        view
    {
        (uint160 amount,,) = permit2.allowance(owner, token, spender);
        assertEq(amount, 0);
    }
}
