#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateCycleControlBounds,
  validateCycleControlResults
} from "./cycle-control-model.mjs";

const HEX_32 = /^0x[0-9a-f]{64}$/;
const SHA_256 = /^sha256:[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LEGACY_BINDING_SCHEMA = "hookemon.robinhood-binding.v1";
const CURRENT_BINDING_SCHEMA = "hookemon.robinhood-binding.v2";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const INTERFACE_FREEZE_INPUTS = [
  ".gitmodules",
  "architecture/interfaces.json",
  "architecture/provisional-interfaces.json",
  "bindings/robinhood-chain.json",
  "feasibility/cycle-control-model-results.json",
  "feasibility/cycle-control-survivability-bounds.json",
  "feasibility/model-results.json",
  "packages/contracts/foundry.toml",
  "packages/contracts/remappings.txt",
  "product/dependency-pins.json",
  "specs/requirements.json"
];
const EXPECTED_CONTRACTS = [
  "usdg",
  "usdgImplementation",
  "poolManager",
  "positionManager",
  "stateView",
  "universalRouter",
  "liquidityLauncher",
  "uerc20Factory",
  "lbpStrategy"
];
const EXPECTED_CONTRACT_ADDRESSES = {
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  usdgImplementation: "0x68184c449e1a8f34fa18d289737129fd27b66f8f",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x06afba43fd06227fa663b0daecf536f6eaa6bf99",
  liquidityLauncher: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  uerc20Factory: "0x000000e200088d55c39a11f609e5f667729ad49b",
  lbpStrategy: "0x05d552391067389ee44fec3924157ed33f976000"
};
const ALLOWED_CUSTODY_FUNCTIONS = new Set([
  "bindMintedPosition",
  "bindingHook",
  "configureBindingHook",
  "deployer",
  "finalizePosition",
  "positionManager",
  "positionReceived",
  "positionTokenId"
]);
const FORBIDDEN_CUSTODY_WORDS = [
  "approve",
  "collect",
  "decrease",
  "delegatecall",
  "liquidity",
  "rescue",
  "successor",
  "transfer",
  "upgrade",
  "withdraw"
];
const EXPECTED_POOL_KEY_PENDING_REASON =
  "HKMN and the CREATE2 hook do not exist before an owner-authorized deployment. Address ordering and the final PoolId therefore remain unresolved.";
const EXPECTED_HOOK_PERMISSION_REASON =
  "External pool initialization is rejected while before-swap specified deltas and after-swap unspecified deltas cover USDG as either specified or unspecified currency.";
const EXPECTED_CUSTODY_CONSTRUCTION =
  "PermanentPositionCustody binds one expected PositionManager token ID, permits one ownerOf-verified permissionless finalization after direct mint, and exposes no position-control authority.";
const EXPECTED_HOOK_PROCESS_RULE =
  "total minus the independently rounded Programmable and treasury amounts";
const EXPECTED_PRODUCTION_READINESS_RULE =
  "Every blocker remains fail-closed before custody, liability mutation, signing, broadcast, deployment, asset movement, gas spend, or publication.";
const EXPECTED_PRODUCTION_BLOCKERS = [
  "DEPLOYED_ROBINHOOD_POOLMANAGER_CALLBACK_AND_SETTLEMENT_FORK",
  "PROGRAMMABLE_OWNER_AND_CLAIM_DESTINATION_POLICY_RESOLUTION",
  "EXACT_OUTPUT_USDG_Q_GROSS_NET_AND_FEE_CUSTODY_SEMANTICS",
  "CANONICAL_POOLKEY_ADDRESS_ORDER_TICK_SPACING_AND_POOLID",
  "CREATE2_HOOK_ADDRESS_INITCODE_AND_RUNTIME",
  "HKMN_ADDRESS_AND_RUNTIME",
  "PERMANENT_CUSTODY_DEPLOYMENT_RUNTIME_AND_POSITION_TOKEN",
  "PROGRAMMABLE_ROBINHOOD_ADMISSION_AND_BENEFICIARY_BINDING",
  "ROBINHOOD_USDG_COMPLETE_VERIFIED_ABI_AND_BEHAVIOR",
  "ROUTER_AND_PROVIDER_ZERO_SURCHARGE_INTEGRATION_PROOF",
  "SUPPORTED_POST_CUSTODY_FORK_BUY_AND_SELL"
];
const EXPECTED_QUADRANT_SET = {
  tokenOrders: ["HKMN_USDG", "USDG_HKMN"],
  directions: ["BUY_HKMN", "SELL_HKMN"],
  exactness: ["EXACT_INPUT", "EXACT_OUTPUT"]
};
const EXPECTED_DEPENDENCY_GITLINK_PATHS = [
  "packages/contracts/lib/v4-core",
  "packages/contracts/lib/v4-periphery",
  "packages/contracts/lib/liquidity-launcher",
  "packages/contracts/lib/uerc20-factory",
  "packages/contracts/lib/v4-core/lib/solmate",
  "packages/contracts/lib/v4-periphery/lib/permit2",
  "packages/contracts/lib/v4-core/lib/openzeppelin-contracts"
];
const EXPECTED_LOCAL_PROOF_PATHS = [
  "feasibility/model.mjs",
  "packages/contracts/src/bindings/RobinhoodBindings.sol",
  "packages/contracts/test/bindings/RobinhoodBindings.t.sol",
  "packages/contracts/test/bindings/RobinhoodV4PoolManager.t.sol"
];
const EXPECTED_PHASE3_BINDING = {
  requirementsRevision: 65,
  architectureRevision: 9,
  status: "INTEGRATION_PENDING",
  operationsWallet: "0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384",
  programmableBeneficiary: "0x4957f49620AFf3Adbbe8195a4f633E49cc93376c",
  permit2: {
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    runtimeCodeHash: "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca",
    evidencePath: "scripts/tests/fixtures/programmable/capabilities-4663.json",
    evidencePointer: "/chainDeployment/permit2GenesisProvenance",
    evidenceDigest: "sha256:93200f4be1543da0ea876af1d91ff0cd4dc3da0b500f170b3d42731776be8568"
  }
};
const EXPECTED_REPRODUCIBLE_BUILD = {
  historicalRevision54: {
    status: "PASSED_LOCAL_HISTORICAL_SOURCE_BOUND",
    requirementsRevision: 54,
    architectureRevision: 3,
    isolatedCleanBuilds: 2,
    declaredGitlinkPinsChecked: 7,
    bytecode: {
      ImmutableLaunchBinding: {
        creationSha256: "sha256:ed54b2ad7e611fdb298606700bf46dd59249c4f71aff9934d50484bb3ed9322d",
        runtimeSha256: "sha256:99061a1d239d861c2fcb465c2420fcda6ea88d9382c451c2bc2ce78342a6ab19"
      },
      PermanentPositionCustody: {
        creationSha256: "sha256:354b1edc654e3ef04394ceeb3ea5f46ea5322110aa105a0e09f46f51e2a353b6",
        runtimeSha256: "sha256:e0a1cadff0b8e2a6700675cf600abc596dd8af5659429c15e9f24fca33b3dfbc"
      },
      RobinhoodBindings: {
        creationSha256: "sha256:d7ac96d464f78c6fda8aa1de9f7b9d92884b081f3bfcd79bb8a1c198e9752418",
        runtimeSha256: "sha256:00b3b642139567b85e19cd344e804d27960107637f04ae5f72a6e2289fc00e80"
      }
    },
    repeatedExactly: true
  },
  revision56Candidate: {
    status: "PENDING_COMMIT_BOUND_EVIDENCE_GENERATION",
    expectedIsolatedCleanBuilds: 2,
    observedCommitBoundIsolatedCleanBuilds: 0,
    expectedArtifactCount: 20,
    localLoopEvidence: "PENDING_COMMIT_BOUND_EVIDENCE",
    pegCycleVaultConcreteRuntimeEvidence: "PENDING_COMMIT_BOUND_EVIDENCE",
    repeatedExactly: false
  },
  pinnedToolchain: {
    foundry: {
      version: "1.7.1",
      commit: "4072e48705af9d93e3c0f6e29e93b5e9a40caed8"
    },
    solidity: {
      solcVersion: "0.8.26",
      evmVersion: "cancun",
      optimizer: true,
      optimizerRuns: 20_000
    }
  },
  compilerTemplates: {
    PegCycleVault: {
      creationTemplateSha256: "sha256:10c3699cfbd6e4722e48cebd4f2ee0324286717c896c84c01412a738f4114565",
      runtimeTemplateSha256: "sha256:138f608c4153e0c6afe332fe842e8bb5d081e94aac213d34f6b587caf2f90576",
      runtimeHasImmutableReferences: true,
      concreteRuntimeEvidence: "PENDING_COMMIT_BOUND_EVIDENCE"
    }
  }
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    stableJson(actual) === stableJson(wanted),
    `${label} keys must be exactly: ${wanted.join(", ")}`
  );
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalize(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(normalize(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestCollection(value) {
  return sha256Bytes(Buffer.from(stableJson(value)));
}

export function computeCollectionDigest(value) {
  return digestCollection(value);
}

export function computeManifestDigest(manifest) {
  const content = structuredClone(manifest);
  delete content.manifestDigest;
  return digestCollection(content);
}

function assertDigest(value, label) {
  invariant(SHA_256.test(value), `${label} must be a lowercase sha256 digest`);
}

function assertAddress(value, label) {
  invariant(ADDRESS.test(value), `${label} must be an EVM address`);
}

function assertRuntime(contract, label) {
  assertExactKeys(
    contract,
    ["address", "runtimeCodeHash", "runtimeSha256", "codeSize", "proxy", ...(label === "contracts.usdg" ? ["metadata"] : [])],
    label
  );
  assertAddress(contract.address, `${label}.address`);
  invariant(HEX_32.test(contract.runtimeCodeHash), `${label}.runtimeCodeHash must be bytes32`);
  assertDigest(contract.runtimeSha256, `${label}.runtimeSha256`);
  invariant(Number.isInteger(contract.codeSize) && contract.codeSize > 0, `${label}.codeSize must be positive`);
  invariant(contract.proxy && typeof contract.proxy === "object", `${label}.proxy is required`);
}

function validateManifestShape(manifest) {
  const baseKeys = [
    "schemaVersion", "productPhase", "requirementsRevision", "architectureRevision", "observedAt",
    "bindingMode", "manifestDigest", "sourceSetDigest", "abiSetDigest", "runtimeSetDigest", "chain",
    "sources", "abiSources", "contracts", "market", "localProof", "productionReadiness"
  ];
  assertExactKeys(
    manifest,
    manifest.schemaVersion === CURRENT_BINDING_SCHEMA ? [...baseKeys, "phase3"] : baseKeys,
    "manifest"
  );
  assertExactKeys(manifest.chain, ["name", "chainId", "rpcUrl", "genesisHash", "nativeGasAsset", "probeMethods"], "chain");
  for (const [index, source] of manifest.sources.entries()) {
    assertExactKeys(source, ["id", "authority", "url", "revision", "sha256"], `sources[${index}]`);
  }
  for (const [index, source] of manifest.abiSources.entries()) {
    assertExactKeys(source, ["id", "url", "revision", "sha256"], `abiSources[${index}]`);
  }
  assertExactKeys(manifest.contracts, EXPECTED_CONTRACTS, "contracts");
  for (const name of EXPECTED_CONTRACTS) {
    const proxy = manifest.contracts[name]?.proxy;
    assertExactKeys(proxy, name === "usdg" ? ["kind", "implementation", "adminSlot"] : ["kind"], `contracts.${name}.proxy`);
  }
  assertExactKeys(manifest.contracts.usdg.metadata, ["name", "symbol", "decimals"], "contracts.usdg.metadata");
  assertExactKeys(manifest.market, ["poolKey", "hookPermissions", "hookFee", "executedUsdgNormalization", "additionalTradingFeeBasisPoints", "launchAllocationBasisPoints", "custody", "quadrantProof"], "market");
  assertExactKeys(manifest.market.poolKey, ["status", "currency0", "currency1", "staticLpFee", "tickSpacing", "hook", "reason"], "market.poolKey");
  assertExactKeys(manifest.market.hookPermissions, ["mask", "beforeInitialize", "beforeSwap", "afterSwap", "beforeSwapReturnDelta", "afterSwapReturnDelta", "allOtherPermissions", "reason"], "market.hookPermissions");
  assertExactKeys(manifest.market.hookFee, ["totalBasisPoints", "programmableBasisPoints", "treasuryBasisPoints", "processRule"], "market.hookFee");
  assertExactKeys(manifest.market.executedUsdgNormalization, ["specifiedUsdg", "unspecifiedUsdg", "partialFillPolicy"], "market.executedUsdgNormalization");
  assertExactKeys(manifest.market.additionalTradingFeeBasisPoints, ["protocol", "router", "provider", "integrator", "tokenTransfer", "other"], "market.additionalTradingFeeBasisPoints");
  assertExactKeys(manifest.market.custody, ["proofStatus", "construction", "projectControlled", "upgradeable", "forbiddenAuthorityPaths", "productionRuntimeStatus"], "market.custody");
  assertExactKeys(manifest.market.custody.forbiddenAuthorityPaths, ["transfer", "approval", "liquidityDecrease", "principalWithdrawal", "feeCollection", "rescue", "upgrade", "delegatecall", "successorControl"], "market.custody.forbiddenAuthorityPaths");
  assertExactKeys(manifest.market.quadrantProof, ["coverage", "tokenOrders", "directions", "exactness", "fullFillRequired", "postCustodyBuy", "postCustodySell", "ordinaryUserTransfers"], "market.quadrantProof");
  assertExactKeys(manifest.localProof, ["artifacts", "verification"], "localProof");
  for (const [index, artifact] of manifest.localProof.artifacts.entries()) {
    assertExactKeys(artifact, ["path", "sha256"], `localProof.artifacts[${index}]`);
  }
  assertExactKeys(manifest.productionReadiness, ["status", "ready", "blockers", "rule"], "productionReadiness");
  if (manifest.schemaVersion === CURRENT_BINDING_SCHEMA) {
    assertExactKeys(
      manifest.phase3,
      [
        "requirementsRevision",
        "architectureRevision",
        "status",
        "operationsWallet",
        "programmableBeneficiary",
        "permit2"
      ],
      "phase3"
    );
    assertExactKeys(
      manifest.phase3.permit2,
      ["address", "runtimeCodeHash", "evidencePath", "evidencePointer", "evidenceDigest"],
      "phase3.permit2"
    );
  }
}

function assertExactSet(value, expected, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(
    stableJson([...value].sort()) === stableJson([...expected].sort()),
    `${label} must be exactly: ${expected.join(", ")}`
  );
}

function addressFromFact(fact, prefix) {
  const match = new RegExp(`^${prefix} is (0x[0-9a-fA-F]{40})$`).exec(fact);
  return match?.[1]?.toLowerCase();
}

export function parsePinnedOfficialBindingFacts(recheck) {
  assertExactKeys(recheck, ["schemaVersion", "observedAt", "requirementsRevision", "scope", "status", "supersedes", "officialSources", "negativeCompatibilityFacts", "buildFence"], "official recheck");
  const facts = recheck.officialSources.flatMap((source) => source.facts ?? []);
  const chainIdFact = facts.find((fact) => fact === "Mainnet chain ID is 4663");
  invariant(chainIdFact, "official recheck lacks Robinhood mainnet chain ID");
  const addresses = {
    usdg: addressFromFact(facts.find((fact) => fact.startsWith("Canonical USDG is ")) ?? "", "Canonical USDG"),
    poolManager: addressFromFact(facts.find((fact) => fact.startsWith("PoolManager is ")) ?? "", "PoolManager"),
    positionManager: addressFromFact(facts.find((fact) => fact.startsWith("PositionManager is ")) ?? "", "PositionManager"),
    liquidityLauncher: addressFromFact(facts.find((fact) => fact.startsWith("Robinhood LiquidityLauncher is ")) ?? "", "Robinhood LiquidityLauncher"),
    uerc20Factory: addressFromFact(facts.find((fact) => fact.startsWith("Robinhood UERC20Factory is ")) ?? "", "Robinhood UERC20Factory"),
    lbpStrategy: addressFromFact(facts.find((fact) => fact.startsWith("Robinhood LBPStrategy is ")) ?? "", "Robinhood LBPStrategy")
  };
  for (const [name, address] of Object.entries(addresses)) {
    assertAddress(address, `official ${name} address`);
  }
  return { chainId: 4663, addresses };
}

export function validatePinnedOfficialBindingFacts(manifest, facts) {
  invariant(facts.chainId === manifest.chain.chainId, "official chain ID mismatch");
  for (const [name, address] of Object.entries(facts.addresses)) {
    invariant(manifest.contracts[name].address.toLowerCase() === address, `official ${name} address mismatch`);
  }
}

export function parsePinnedUniswapDeploymentFacts(sourceBytes) {
  const deployment = JSON.parse(Buffer.from(sourceBytes).toString("utf8"));
  invariant(deployment.chainId === "4663" || deployment.chainId === 4663, "deployment source chain ID mismatch");
  invariant(deployment.latest && typeof deployment.latest === "object", "deployment source lacks latest contracts");
  const contractNames = {
    poolManager: "PoolManager",
    positionManager: "PositionManager",
    stateView: "StateView",
    universalRouter: "UniversalRouter"
  };
  const addresses = Object.fromEntries(Object.entries(contractNames).map(([name, sourceName]) => {
    const address = deployment.latest[sourceName]?.address;
    assertAddress(address, `deployment source ${sourceName} address`);
    return [name, address.toLowerCase()];
  }));
  return { chainId: 4663, addresses };
}

function pinnedAddressConstant(source, name) {
  const match = new RegExp(
    `const\\s+${name}\\s*=\\s*getAddress\\('?(0x[0-9a-fA-F]{40})'?\\)`
  ).exec(source);
  invariant(match, `launcher source lacks ${name}`);
  return match[1].toLowerCase();
}

export function parsePinnedLiquidityLauncherFacts(sourceBytes) {
  const source = Buffer.from(sourceBytes).toString("utf8");
  const robinhoodBlock = /\[SupportedChainId\.ROBINHOOD\]:\s*\{([\s\S]*?)\n\s*\},/.exec(source)?.[1];
  invariant(robinhoodBlock, "launcher source lacks the Robinhood address block");
  invariant(
    /liquidityLauncher:\s*LIQUIDITY_LAUNCHER_ROBINHOOD\b/.test(robinhoodBlock),
    "Robinhood block does not select the pinned LiquidityLauncher"
  );
  invariant(
    /uerc20Factory:\s*UERC20_FACTORY\b/.test(robinhoodBlock),
    "Robinhood block does not select the pinned UERC20Factory"
  );
  invariant(
    /positionManager:\s*POSITION_MANAGER_ROBINHOOD\b/.test(robinhoodBlock),
    "Robinhood block does not select the pinned PositionManager"
  );
  const lbpStrategy = /lbpStrategy:\s*getAddress\('(0x[0-9a-fA-F]{40})'\)/.exec(
    robinhoodBlock
  )?.[1];
  assertAddress(lbpStrategy, "launcher source Robinhood LBPStrategy address");
  return {
    chainId: 4663,
    addresses: {
      liquidityLauncher: pinnedAddressConstant(source, "LIQUIDITY_LAUNCHER_ROBINHOOD"),
      uerc20Factory: pinnedAddressConstant(source, "UERC20_FACTORY"),
      positionManager: pinnedAddressConstant(source, "POSITION_MANAGER_ROBINHOOD"),
      lbpStrategy: lbpStrategy.toLowerCase()
    }
  };
}

function validatePhase3Binding(phase3) {
  invariant(phase3.requirementsRevision === 65, "Phase 3 requirements revision must be 65");
  invariant(phase3.architectureRevision === 9, "Phase 3 architecture revision must be 9");
  invariant(phase3.status === "INTEGRATION_PENDING", "Phase 3 binding status must remain integration pending");
  assertAddress(phase3.operationsWallet, "Phase 3 Operations wallet");
  invariant(
    phase3.operationsWallet.toLowerCase() === EXPECTED_PHASE3_BINDING.operationsWallet.toLowerCase(),
    "Phase 3 Operations wallet mismatch"
  );
  assertAddress(phase3.programmableBeneficiary, "Phase 3 Programmable beneficiary");
  invariant(
    phase3.programmableBeneficiary.toLowerCase()
      === EXPECTED_PHASE3_BINDING.programmableBeneficiary.toLowerCase(),
    "Phase 3 Programmable beneficiary mismatch"
  );
  assertAddress(phase3.permit2.address, "Phase 3 Permit2 address");
  invariant(
    phase3.permit2.address.toLowerCase() === EXPECTED_PHASE3_BINDING.permit2.address.toLowerCase(),
    "Phase 3 Permit2 address mismatch"
  );
  invariant(
    phase3.permit2.runtimeCodeHash === EXPECTED_PHASE3_BINDING.permit2.runtimeCodeHash,
    "Phase 3 Permit2 runtime mismatch"
  );
  invariant(
    phase3.permit2.evidencePath === EXPECTED_PHASE3_BINDING.permit2.evidencePath,
    "Phase 3 Permit2 evidence path mismatch"
  );
  invariant(
    phase3.permit2.evidencePointer === EXPECTED_PHASE3_BINDING.permit2.evidencePointer,
    "Phase 3 Permit2 evidence pointer mismatch"
  );
  invariant(
    phase3.permit2.evidenceDigest === EXPECTED_PHASE3_BINDING.permit2.evidenceDigest,
    "Phase 3 Permit2 evidence digest mismatch"
  );
}

export function validateManifest(manifest) {
  validateManifestShape(manifest);
  invariant(
    [LEGACY_BINDING_SCHEMA, CURRENT_BINDING_SCHEMA].includes(manifest.schemaVersion),
    "unsupported manifest schema"
  );
  invariant(manifest.productPhase === 1, "product phase must be 1");
  invariant(manifest.requirementsRevision === 54, "requirements revision must be 54");
  invariant(manifest.architectureRevision === 3, "architecture revision must be 3");
  invariant(manifest.bindingMode === "BUILD_ONLY_FAIL_CLOSED", "binding mode must remain build-only fail-closed");
  invariant(manifest.manifestDigest === computeManifestDigest(manifest), "manifest digest mismatch");
  if (manifest.schemaVersion === CURRENT_BINDING_SCHEMA) validatePhase3Binding(manifest.phase3);
  invariant(manifest.chain.chainId === 4663, "Robinhood chain ID must be 4663");
  invariant(
    manifest.chain.rpcUrl === "https://rpc.mainnet.chain.robinhood.com",
    "unexpected Robinhood RPC"
  );
  invariant(HEX_32.test(manifest.chain.genesisHash), "genesis hash must be bytes32");

  invariant(Array.isArray(manifest.sources) && manifest.sources.length > 0, "sources are required");
  for (const [index, source] of manifest.sources.entries()) {
    invariant(source.authority && source.id, `sources[${index}] needs identity`);
    invariant(source.url.startsWith("https://"), `sources[${index}] must use https`);
    assertDigest(source.sha256, `sources[${index}].sha256`);
  }
  invariant(
    manifest.sourceSetDigest === digestCollection(manifest.sources),
    "source set digest mismatch"
  );
  invariant(Array.isArray(manifest.abiSources) && manifest.abiSources.length > 0, "ABI sources are required");
  invariant(
    manifest.abiSetDigest === digestCollection(manifest.abiSources),
    "ABI set digest mismatch"
  );

  for (const name of EXPECTED_CONTRACTS) {
    invariant(manifest.contracts[name], `missing contract ${name}`);
    assertRuntime(manifest.contracts[name], `contracts.${name}`);
    invariant(
      manifest.contracts[name].address.toLowerCase() === EXPECTED_CONTRACT_ADDRESSES[name],
      `contracts.${name} address is not the known Robinhood deployment`
    );
  }
  invariant(manifest.contracts.usdg.proxy.kind === "ERC1967_UUPS", "USDG proxy kind must be explicit");
  invariant(
    manifest.contracts.usdg.proxy.implementation.toLowerCase()
      === manifest.contracts.usdgImplementation.address.toLowerCase(),
    "USDG implementation mismatch"
  );
  invariant(manifest.contracts.poolManager.proxy.kind === "NONE", "PoolManager must be non-proxy");
  invariant(manifest.contracts.positionManager.proxy.kind === "NONE", "PositionManager must be non-proxy");

  const market = manifest.market;
  invariant(market.poolKey.staticLpFee === 0, "PoolKey LP fee must be zero");
  invariant(market.poolKey.status === "INTEGRATION_PENDING", "undeployed PoolKey must fail closed");
  invariant(market.poolKey.currency0 === null, "pending PoolKey currency0 must be null");
  invariant(market.poolKey.currency1 === null, "pending PoolKey currency1 must be null");
  invariant(market.poolKey.tickSpacing === null, "pending PoolKey tickSpacing must be null");
  invariant(market.poolKey.hook === null, "pending PoolKey hook must be null");
  invariant(market.poolKey.reason === EXPECTED_POOL_KEY_PENDING_REASON, "pending PoolKey reason mismatch");
  invariant(market.hookPermissions.mask === "0x20cc", "hook permission mask must be 0x20cc");
  invariant(market.hookPermissions.beforeInitialize === true, "beforeInitialize permission must be true");
  invariant(market.hookPermissions.beforeSwap === true, "beforeSwap permission must be true");
  invariant(market.hookPermissions.afterSwap === true, "afterSwap permission must be true");
  invariant(market.hookPermissions.beforeSwapReturnDelta === true, "beforeSwapReturnDelta permission must be true");
  invariant(market.hookPermissions.afterSwapReturnDelta === true, "afterSwapReturnDelta permission must be true");
  invariant(market.hookPermissions.allOtherPermissions === false, "all other hook permissions must be false");
  invariant(market.hookPermissions.reason === EXPECTED_HOOK_PERMISSION_REASON, "hook permission reason mismatch");
  invariant(market.hookFee.totalBasisPoints === 300, "total Hookemon fee must be 300 bps");
  invariant(market.hookFee.programmableBasisPoints === 10, "Programmable fee must be 10 bps");
  invariant(market.hookFee.treasuryBasisPoints === 40, "treasury fee must be 40 bps");
  invariant(market.hookFee.processRule === EXPECTED_HOOK_PROCESS_RULE, "hook fee process rule mismatch");
  invariant(
    market.executedUsdgNormalization.specifiedUsdg
      === "ABS_FINAL_CALLER_SPECIFIED_DELTA_AFTER_FULL_FILL",
    "specified-USDG normalization mismatch"
  );
  invariant(
    market.executedUsdgNormalization.unspecifiedUsdg
      === "ABS_RAW_POOL_UNSPECIFIED_DELTA_BEFORE_AFTERSWAP_HOOK_DELTA",
    "unspecified-USDG normalization mismatch"
  );
  invariant(
    market.executedUsdgNormalization.partialFillPolicy === "REVERT_WHOLE_SWAP",
    "partial-fill normalization must fail closed"
  );
  invariant(market.launchAllocationBasisPoints === 10_000, "market allocation must be 100 percent");
  invariant(
    Object.values(market.additionalTradingFeeBasisPoints).every((value) => value === 0),
    "an additional trading fee is present"
  );
  invariant(market.custody.proofStatus === "PROVED_LOCALLY", "local permanent custody proof is required");
  invariant(market.custody.construction === EXPECTED_CUSTODY_CONSTRUCTION, "custody construction mismatch");
  invariant(market.custody.projectControlled === false, "custody cannot be project controlled");
  invariant(market.custody.upgradeable === false, "custody cannot be upgradeable");
  invariant(market.custody.productionRuntimeStatus === "INTEGRATION_PENDING", "custody production status must fail closed");
  invariant(
    Object.values(market.custody.forbiddenAuthorityPaths).every((value) => value === false),
    "custody exposes a forbidden authority path"
  );
  invariant(market.quadrantProof.coverage === 8, "all eight swap quadrants are required");
  assertExactSet(market.quadrantProof.tokenOrders, EXPECTED_QUADRANT_SET.tokenOrders, "quadrant token orders");
  assertExactSet(market.quadrantProof.directions, EXPECTED_QUADRANT_SET.directions, "quadrant directions");
  assertExactSet(market.quadrantProof.exactness, EXPECTED_QUADRANT_SET.exactness, "quadrant exactness");
  invariant(market.quadrantProof.fullFillRequired === true, "partial fills must fail closed");
  invariant(market.quadrantProof.postCustodyBuy === true, "post-custody buy proof is required");
  invariant(market.quadrantProof.postCustodySell === true, "post-custody sell proof is required");
  invariant(market.quadrantProof.ordinaryUserTransfers === true, "ordinary user transfer proof is required");

  const readiness = manifest.productionReadiness;
  invariant(readiness.status === "INTEGRATION_PENDING", "production must remain fail-closed");
  invariant(readiness.ready === false, "production readiness cannot be true");
  assertExactSet(readiness.blockers, EXPECTED_PRODUCTION_BLOCKERS, "production blockers");
  invariant(
    readiness.rule === EXPECTED_PRODUCTION_READINESS_RULE,
    "production readiness rule mismatch"
  );

  return {
    manifestDigest: manifest.manifestDigest,
    sourceSetDigest: manifest.sourceSetDigest,
    abiSetDigest: manifest.abiSetDigest,
    runtimeSetDigest: manifest.runtimeSetDigest,
    blockers: [...readiness.blockers],
    phase3: manifest.schemaVersion === CURRENT_BINDING_SCHEMA ? structuredClone(manifest.phase3) : null
  };
}

export function validatePhase3BindingEvidence(manifest, projectRoot) {
  if (manifest.schemaVersion === LEGACY_BINDING_SCHEMA) return { status: "NOT_PRESENT" };
  validatePhase3Binding(manifest.phase3);
  const evidenceFile = path.join(projectRoot, manifest.phase3.permit2.evidencePath);
  invariant(existsSync(evidenceFile), "Phase 3 Permit2 evidence file is missing");
  const evidenceStat = lstatSync(evidenceFile);
  const rootReal = realpathSync(projectRoot);
  const evidenceReal = realpathSync(evidenceFile);
  invariant(
    evidenceStat.isFile() && !evidenceStat.isSymbolicLink()
      && (evidenceReal === rootReal || evidenceReal.startsWith(`${rootReal}${path.sep}`)),
    "Phase 3 Permit2 evidence must be a regular repository file"
  );
  const evidence = JSON.parse(readFileSync(evidenceReal, "utf8"));
  const deployed = evidence?.chainDeployment?.contracts?.permit2;
  const provenance = evidence?.chainDeployment?.permit2GenesisProvenance;
  assertExactKeys(deployed, ["address", "runtimeCodeHash"], "Phase 3 Permit2 deployed evidence");
  assertExactKeys(
    provenance,
    ["address", "runtimeCodeHash", "evidenceDigest"],
    "Phase 3 Permit2 provenance"
  );
  invariant(
    deployed.address.toLowerCase() === manifest.phase3.permit2.address.toLowerCase()
      && provenance.address.toLowerCase() === manifest.phase3.permit2.address.toLowerCase(),
    "Phase 3 Permit2 evidence address mismatch"
  );
  invariant(
    deployed.runtimeCodeHash === manifest.phase3.permit2.runtimeCodeHash
      && provenance.runtimeCodeHash === manifest.phase3.permit2.runtimeCodeHash,
    "Phase 3 Permit2 evidence runtime mismatch"
  );
  invariant(
    provenance.evidenceDigest === manifest.phase3.permit2.evidenceDigest,
    "Phase 3 Permit2 evidence digest mismatch"
  );
  return {
    status: manifest.phase3.status,
    evidenceDigest: provenance.evidenceDigest,
    scope: "IDENTITY_AND_RUNTIME_ONLY"
  };
}

function listedNames(entries) {
  return entries.map((entry) => typeof entry === "string" ? entry : entry.name).sort();
}

function validatePhase3InterfaceFreeze({ freeze, frozen, provisional, projectRoot }) {
  invariant(freeze.schemaVersion === "hookemon.interface-freeze.v1", "unsupported interface freeze schema");
  invariant(freeze.productPhase === 3, "interface freeze product phase must be 3");
  invariant(freeze.requirementsRevision === 65, "interface freeze requirements revision must be 65");
  invariant(freeze.architectureRevision === 9, "interface freeze architecture revision must be 9");
  invariant(
    freeze.status === "PROVISIONAL_PHASE3_PENDING_FEASIBILITY",
    "interface freeze status must remain Phase 3 provisional"
  );
  invariant(frozen.productPhase === 3, "frozen interface product phase must be 3");
  invariant(frozen.requirementsRevision === 65, "frozen interface requirements revision must be 65");
  invariant(frozen.architectureRevision === 9, "frozen interface architecture revision must be 9");
  invariant(
    frozen.status === "PROVISIONAL_PHASE3_PENDING_FEASIBILITY",
    "frozen interface status must remain Phase 3 provisional"
  );
  invariant(
    frozen.bindingManifest === "release/phase3/deployment-manifest.json"
      && frozen.bindingManifestDigest === null
      && freeze.bindingManifestDigest === null,
    "Phase 3 freeze must retain an unresolved deployment manifest digest"
  );
  invariant(provisional.productPhase === 3, "provisional interface product phase must be 3");
  invariant(provisional.requirementsRevision === 65, "provisional requirements revision must be 65");
  invariant(provisional.architectureRevision === 9, "provisional architecture revision must be 9");
  invariant(provisional.status === "PROVISIONAL", "provisional interface status must remain provisional");

  invariant(
    stableJson(Object.keys(freeze.inputHashes).sort())
      === stableJson([...INTERFACE_FREEZE_INPUTS].sort()),
    "interface freeze input set mismatch"
  );
  for (const input of INTERFACE_FREEZE_INPUTS) {
    assertDigest(freeze.inputHashes[input], `interface freeze input ${input}`);
    invariant(
      freeze.inputHashes[input] === hashFile(projectRoot, input),
      `interface freeze input hash mismatch: ${input}`
    );
  }

  const provisionalById = new Map(provisional.modules.map((module) => [module.id, module]));
  const frozenById = new Map(frozen.moduleInterfaces.map((module) => [module.id, module]));
  invariant(provisionalById.size === provisional.modules.length, "duplicate provisional module id");
  invariant(frozenById.size === frozen.moduleInterfaces.length, "duplicate frozen module id");
  invariant(
    stableJson([...provisionalById.keys()].sort()) === stableJson([...frozenById.keys()].sort()),
    "frozen module set differs from provisional architecture"
  );
  for (const [id, source] of provisionalById) {
    const target = frozenById.get(id);
    invariant(
      stableJson(listedNames(source.operations)) === stableJson(listedNames(target.operations)),
      `${id} operation set differs from provisional architecture`
    );
    invariant(
      stableJson(listedNames(source.data)) === stableJson(listedNames(target.records)),
      `${id} record set differs from provisional architecture`
    );
    invariant(
      stableJson(listedNames(source.events)) === stableJson(listedNames(target.events)),
      `${id} event set differs from provisional architecture`
    );
  }

  assertExactKeys(
    freeze.compatibilityVerdict,
    [
      "deferredSelectorOrStoragePresent",
      "exactEventSets",
      "exactModuleSet",
      "exactOperationSets",
      "exactRecordSets",
      "genericAdministratorPresent",
      "outOfScopePhase2SurfacePresent",
      "status",
      "unresolvedProviderFactPromoted"
    ],
    "Phase 3 compatibility verdict"
  );
  invariant(freeze.compatibilityVerdict.status === "PASSED", "architecture compatibility re-check failed");
  invariant(freeze.compatibilityVerdict.exactModuleSet === true, "module compatibility is not exact");
  invariant(freeze.compatibilityVerdict.exactOperationSets === true, "operation compatibility is not exact");
  invariant(freeze.compatibilityVerdict.exactRecordSets === true, "record compatibility is not exact");
  invariant(freeze.compatibilityVerdict.exactEventSets === true, "event compatibility is not exact");
  invariant(
    freeze.compatibilityVerdict.outOfScopePhase2SurfacePresent === false,
    "Phase 3 snapshot must not carry a Phase 2 scope violation"
  );

  const historicalModel = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/model-results.json"), "utf8")
  );
  invariant(
    historicalModel.requirementsRevision === 56 && historicalModel.architectureRevision === 4,
    "historical Phase 1 model must remain bound to revision 56 architecture 4"
  );
  invariant(
    freeze.proofCoverage?.historicalPhase1Model?.status
      === "PRESERVED_HISTORICAL_REVISION_56_ARCHITECTURE_4"
      && freeze.proofCoverage.historicalPhase1Model.requirementsRevision === 56
      && freeze.proofCoverage.historicalPhase1Model.architectureRevision === 4
      && freeze.proofCoverage.historicalPhase1Model.schemaVersion === historicalModel.schemaVersion,
    "historical Phase 1 model coverage mismatch"
  );
  const cycleControlResults = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/cycle-control-model-results.json"), "utf8")
  );
  const cycleControlBounds = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/cycle-control-survivability-bounds.json"), "utf8")
  );
  validateCycleControlResults(cycleControlResults);
  validateCycleControlBounds(cycleControlBounds, cycleControlResults);
  invariant(
    stableJson(freeze.proofCoverage?.cycleControl) === stableJson({
      status: "PASSED_LOCAL_REVISION_57_ARCHITECTURE_5",
      requirementsRevision: 57,
      architectureRevision: 5,
      maximumCrossCycleContaminationAtomicUSDG:
        cycleControlResults.aggregate.maximumCrossCycleContaminationAtomicUSDG,
      maximumBlindRetryMoneyMutationAtomicUSDG:
        cycleControlResults.aggregate.maximumBlindRetryMoneyMutationAtomicUSDG,
      maximumActiveCycles: cycleControlResults.aggregate.maximumActiveCycles,
      minimumDistinctEscrowsObserved: cycleControlResults.aggregate.minimumDistinctEscrowsObserved,
      maximumAuthorizedLossPerCycleAtomicUSDG:
        cycleControlResults.aggregate.maximumAuthorizedLossPerCycleAtomicUSDG,
      cumulativeSystemLossCap: cycleControlResults.aggregate.cumulativeSystemLossCap.status
    }),
    "cycle-control proof coverage mismatch"
  );
  invariant(
    freeze.proofCoverage?.canonicalMarket?.partialFillRejectionQuadrants === 8,
    "all eight partial-fill rejection quadrants are required"
  );
  invariant(
    freeze.proofCoverage?.permanentCustody?.pinnedV4PeripheryPositionManagerMintAndFinalization
      === "PASSED_LOCAL",
    "pinned PositionManager custody proof is required"
  );
  invariant(
    stableJson(freeze.proofCoverage?.reproducibleBuild)
      === stableJson(EXPECTED_REPRODUCIBLE_BUILD),
    "reproducible build evidence mismatch"
  );
  assertExactKeys(
    freeze.proofCoverage?.phase3Interface,
    [
      "architectureRevision",
      "bindingManifest",
      "bindingManifestDigest",
      "codeReadinessDoesNotAuthorizeLive",
      "providerBindingStatus",
      "requirementsRevision",
      "status"
    ],
    "Phase 3 interface coverage"
  );
  invariant(
    freeze.proofCoverage.phase3Interface.status === "PROVISIONAL_PENDING_FEASIBILITY"
      && freeze.proofCoverage.phase3Interface.requirementsRevision === 65
      && freeze.proofCoverage.phase3Interface.architectureRevision === 9
      && freeze.proofCoverage.phase3Interface.bindingManifest
        === "release/phase3/deployment-manifest.json"
      && freeze.proofCoverage.phase3Interface.bindingManifestDigest === null
      && freeze.proofCoverage.phase3Interface.providerBindingStatus === "INTEGRATION_PENDING"
      && freeze.proofCoverage.phase3Interface.codeReadinessDoesNotAuthorizeLive === true,
    "Phase 3 interface coverage must remain provisional"
  );
  invariant(freeze.productionReadiness.ready === false, "interface freeze cannot claim production readiness");
  invariant(
    stableJson(freeze.productionReadiness.blockers) === stableJson(frozen.productionBlockers),
    "Phase 3 freeze production blockers differ from frozen architecture"
  );

  return {
    requirementsRevision: freeze.requirementsRevision,
    architectureRevision: freeze.architectureRevision,
    moduleCount: frozenById.size,
    productionReady: false,
    blockers: [...freeze.productionReadiness.blockers]
  };
}

export function validateInterfaceFreeze({ freeze, frozen, provisional, manifest, projectRoot }) {
  if (freeze?.productPhase === 3) {
    return validatePhase3InterfaceFreeze({ freeze, frozen, provisional, manifest, projectRoot });
  }
  invariant(freeze.schemaVersion === "hookemon.interface-freeze.v1", "unsupported interface freeze schema");
  invariant(freeze.productPhase === 2, "interface freeze product phase must be 2");
  invariant(freeze.requirementsRevision === 57, "interface freeze requirements revision must be 57");
  invariant(freeze.architectureRevision === 5, "interface freeze architecture revision must be 5");
  invariant(
    freeze.status === "FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING",
    "interface freeze status must remain build-only"
  );
  invariant(frozen.productPhase === 2, "frozen interface product phase must be 2");
  invariant(frozen.requirementsRevision === 57, "frozen interface requirements revision must be 57");
  invariant(frozen.architectureRevision === 5, "frozen interface architecture revision must be 5");
  invariant(
    frozen.status === "FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING",
    "frozen interface status must remain build-only"
  );
  invariant(provisional.productPhase === 2, "provisional interface product phase must be 2");
  invariant(provisional.requirementsRevision === 57, "provisional requirements revision must be 57");
  invariant(provisional.architectureRevision === 5, "provisional architecture revision must be 5");
  invariant(frozen.bindingManifestDigest === manifest.manifestDigest, "frozen binding digest mismatch");
  invariant(freeze.bindingManifestDigest === manifest.manifestDigest, "freeze binding digest mismatch");

  invariant(
    stableJson(Object.keys(freeze.inputHashes).sort())
      === stableJson([...INTERFACE_FREEZE_INPUTS].sort()),
    "interface freeze input set mismatch"
  );
  for (const input of INTERFACE_FREEZE_INPUTS) {
    assertDigest(freeze.inputHashes[input], `interface freeze input ${input}`);
    invariant(
      freeze.inputHashes[input] === hashFile(projectRoot, input),
      `interface freeze input hash mismatch: ${input}`
    );
  }

  const provisionalById = new Map(provisional.modules.map((module) => [module.id, module]));
  const frozenById = new Map(frozen.moduleInterfaces.map((module) => [module.id, module]));
  invariant(provisionalById.size === provisional.modules.length, "duplicate provisional module id");
  invariant(frozenById.size === frozen.moduleInterfaces.length, "duplicate frozen module id");
  invariant(
    stableJson([...provisionalById.keys()].sort()) === stableJson([...frozenById.keys()].sort()),
    "frozen module set differs from provisional architecture"
  );
  for (const [id, source] of provisionalById) {
    const target = frozenById.get(id);
    invariant(
      stableJson(listedNames(source.operations)) === stableJson(listedNames(target.operations)),
      `${id} operation set differs from provisional architecture`
    );
    invariant(
      stableJson(listedNames(source.data)) === stableJson(listedNames(target.records)),
      `${id} record set differs from provisional architecture`
    );
    invariant(
      stableJson(listedNames(source.events)) === stableJson(listedNames(target.events)),
      `${id} event set differs from provisional architecture`
    );
  }
  invariant(
    stableJson([...frozen.phaseBoundary.allowedModules].sort())
      === stableJson([...frozenById.keys()].sort()),
    "phase boundary module set differs from frozen interfaces"
  );
  for (const excluded of [
    "dashboard", "browserUi", "httpService", "database", "scheduler",
    "routeDiscovery", "automaticPackSelection", "concurrentCycles", "automaticRetry",
    "genericAdmin", "pause", "upgrade"
  ]) {
    invariant(
      frozen.phaseBoundary.forbidden.includes(excluded),
      `lean Phase 2 boundary must forbid ${excluded}`
    );
  }
  invariant(
    stableJson(frozen.productionBlockers) === stableJson(manifest.productionReadiness.blockers),
    "frozen production blockers differ from binding manifest"
  );
  assertExactKeys(
    frozen.tokenRuntimeAuthority,
    [
      "productionBlocker",
      "requiredEvidence",
      "selectorDenylistRole",
      "selectorDenylistSufficient",
      "status"
    ],
    "tokenRuntimeAuthority"
  );
  invariant(
    stableJson(frozen.tokenRuntimeAuthority.requiredEvidence) === stableJson([
      "EXACT_ALLOWED_EXTERNAL_ABI",
      "PINNED_FACTORY_AND_TOKEN_SOURCE_DIGESTS",
      "INITCODE_AND_DEPLOYED_RUNTIME_HASHES",
      "STORAGE_LAYOUT_AND_SUPPLY_WRITE_AUTHORITY_PROOF",
      "NO_PROXY_DELEGATECALL_OR_DESTRUCTIVE_PATH",
      "CONSTRUCTOR_ONLY_SINGLE_SUPPLY_MINT"
    ]),
    "token runtime authority evidence set mismatch"
  );
  invariant(
    frozen.tokenRuntimeAuthority.selectorDenylistSufficient === false
      && frozen.tokenRuntimeAuthority.selectorDenylistRole === "ADDITIONAL_NEGATIVE_CONTROL_ONLY",
    "selector denylist cannot establish token runtime authority"
  );
  invariant(
    frozen.tokenRuntimeAuthority.status === "INTEGRATION_PENDING_EXACT_HKMN_RUNTIME"
      && frozen.tokenRuntimeAuthority.productionBlocker === "HKMN_ADDRESS_AND_RUNTIME",
    "token runtime authority must remain fail-closed"
  );
  invariant(freeze.compatibilityVerdict.status === "PASSED", "architecture compatibility re-check failed");
  invariant(freeze.compatibilityVerdict.exactModuleSet === true, "module compatibility is not exact");
  invariant(freeze.compatibilityVerdict.exactOperationSets === true, "operation compatibility is not exact");
  invariant(freeze.compatibilityVerdict.exactRecordSets === true, "record compatibility is not exact");
  invariant(freeze.compatibilityVerdict.exactEventSets === true, "event compatibility is not exact");
  invariant(
    freeze.compatibilityVerdict.outOfScopePhase2SurfacePresent === false,
    "an out-of-scope Phase 2 surface entered the freeze"
  );
  const historicalModel = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/model-results.json"), "utf8")
  );
  invariant(
    historicalModel.requirementsRevision === 56 && historicalModel.architectureRevision === 4,
    "historical Phase 1 model must remain bound to revision 56 architecture 4"
  );
  invariant(
    freeze.proofCoverage?.historicalPhase1Model?.status
      === "PRESERVED_HISTORICAL_REVISION_56_ARCHITECTURE_4"
      && freeze.proofCoverage.historicalPhase1Model.requirementsRevision === 56
      && freeze.proofCoverage.historicalPhase1Model.architectureRevision === 4
      && freeze.proofCoverage.historicalPhase1Model.schemaVersion === historicalModel.schemaVersion,
    "historical Phase 1 model coverage mismatch"
  );
  const cycleControlResults = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/cycle-control-model-results.json"), "utf8")
  );
  const cycleControlBounds = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/cycle-control-survivability-bounds.json"), "utf8")
  );
  validateCycleControlResults(cycleControlResults);
  validateCycleControlBounds(cycleControlBounds, cycleControlResults);
  invariant(
    stableJson(freeze.proofCoverage?.cycleControl) === stableJson({
      status: "PASSED_LOCAL_REVISION_57_ARCHITECTURE_5",
      requirementsRevision: 57,
      architectureRevision: 5,
      maximumCrossCycleContaminationAtomicUSDG:
        cycleControlResults.aggregate.maximumCrossCycleContaminationAtomicUSDG,
      maximumBlindRetryMoneyMutationAtomicUSDG:
        cycleControlResults.aggregate.maximumBlindRetryMoneyMutationAtomicUSDG,
      maximumActiveCycles: cycleControlResults.aggregate.maximumActiveCycles,
      minimumDistinctEscrowsObserved: cycleControlResults.aggregate.minimumDistinctEscrowsObserved,
      maximumAuthorizedLossPerCycleAtomicUSDG:
        cycleControlResults.aggregate.maximumAuthorizedLossPerCycleAtomicUSDG,
      cumulativeSystemLossCap: cycleControlResults.aggregate.cumulativeSystemLossCap.status
    }),
    "cycle-control proof coverage mismatch"
  );
  invariant(
    freeze.proofCoverage?.canonicalMarket?.partialFillRejectionQuadrants === 8,
    "all eight partial-fill rejection quadrants are required"
  );
  invariant(
    freeze.proofCoverage?.permanentCustody?.pinnedV4PeripheryPositionManagerMintAndFinalization
      === "PASSED_LOCAL",
    "pinned PositionManager custody proof is required"
  );
  invariant(
    stableJson(freeze.proofCoverage?.reproducibleBuild)
      === stableJson(EXPECTED_REPRODUCIBLE_BUILD),
    "reproducible build evidence mismatch"
  );
  invariant(freeze.productionReadiness.ready === false, "interface freeze cannot claim production readiness");
  invariant(
    stableJson(freeze.productionReadiness.blockers) === stableJson(manifest.productionReadiness.blockers),
    "freeze production blockers differ from binding manifest"
  );

  return {
    requirementsRevision: freeze.requirementsRevision,
    architectureRevision: freeze.architectureRevision,
    moduleCount: frozenById.size,
    productionReady: false,
    blockers: [...freeze.productionReadiness.blockers]
  };
}

function runtimeSet(manifest) {
  return EXPECTED_CONTRACTS.map((name) => ({
    name,
    address: manifest.contracts[name].address.toLowerCase(),
    runtimeCodeHash: manifest.contracts[name].runtimeCodeHash,
    runtimeSha256: manifest.contracts[name].runtimeSha256,
    codeSize: manifest.contracts[name].codeSize,
    proxy: manifest.contracts[name].proxy
  }));
}

export function computeRuntimeSetDigest(manifest) {
  return digestCollection(runtimeSet(manifest));
}

function validateRuntimeSetDigest(manifest) {
  invariant(
    manifest.runtimeSetDigest === computeRuntimeSetDigest(manifest),
    "runtime set digest mismatch"
  );
}

function hashFile(projectRoot, relativePath) {
  return sha256Bytes(readFileSync(path.join(projectRoot, relativePath)));
}

export function validateTrackedLocalProof(manifest, projectRoot) {
  assertExactSet(
    manifest.localProof.artifacts.map((artifact) => artifact.path),
    EXPECTED_LOCAL_PROOF_PATHS,
    "local proof paths"
  );
  const rootReal = realpathSync(projectRoot);
  for (const artifact of manifest.localProof.artifacts) {
    const artifactPath = path.join(projectRoot, artifact.path);
    invariant(existsSync(artifactPath), `missing local proof ${artifact.path}`);
    const artifactStat = lstatSync(artifactPath);
    const artifactReal = realpathSync(artifactPath);
    invariant(
      artifactStat.isFile() && !artifactStat.isSymbolicLink()
        && artifactReal.startsWith(`${rootReal}${path.sep}`),
      `local proof must be a regular repository file: ${artifact.path}`
    );
    invariant(hashFile(projectRoot, artifact.path) === artifact.sha256, `local proof hash mismatch: ${artifact.path}`);
  }
}

export function validateCustodyArtifact(custodyArtifact) {
  invariant(Array.isArray(custodyArtifact?.abi), "custody artifact ABI is missing");
  const functions = custodyArtifact.abi
    .filter((entry) => entry.type === "function")
    .map((entry) => entry.name)
    .sort();
  invariant(
    stableJson(functions) === stableJson([...ALLOWED_CUSTODY_FUNCTIONS].sort()),
    `custody ABI does not match the exact function set: ${functions.join(",")}`
  );
  for (const word of FORBIDDEN_CUSTODY_WORDS) {
    invariant(
      !functions.some((name) => name.toLowerCase().includes(word)),
      `custody ABI contains forbidden ${word} authority`
    );
  }
  const runtime = custodyArtifact.deployedBytecode?.object;
  invariant(
    typeof runtime === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(runtime),
    "custody runtime bytecode is missing or invalid"
  );
  const bytes = Buffer.from(runtime.slice(2), "hex");
  for (let offset = 0; offset < bytes.length; offset += 1) {
    const opcode = bytes[offset];
    invariant(opcode !== 0xf4, "custody runtime contains DELEGATECALL");
    invariant(opcode !== 0xff, "custody runtime contains SELFDESTRUCT");
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const immediateBytes = opcode - 0x5f;
      offset += immediateBytes;
    }
  }
  return { functions };
}

function validateGeneratedLocalProof(projectRoot) {
  const custodyArtifactPath = path.join(
    projectRoot,
    "packages/contracts/out/RobinhoodBindings.sol/PermanentPositionCustody.json"
  );
  invariant(existsSync(custodyArtifactPath), "Foundry custody artifact is missing; run forge test first");
  const custodyArtifact = JSON.parse(readFileSync(custodyArtifactPath, "utf8"));
  const { functions } = validateCustodyArtifact(custodyArtifact);
  return {
    artifactSha256: hashFile(
      projectRoot,
      "packages/contracts/out/RobinhoodBindings.sol/PermanentPositionCustody.json"
    ),
    functions
  };
}

function validateLocalProof(manifest, projectRoot) {
  validateTrackedLocalProof(manifest, projectRoot);
  return validateGeneratedLocalProof(projectRoot);
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  invariant(response.ok, `${method} HTTP ${response.status}`);
  const body = await response.json();
  invariant(!body.error, `${method}: ${body.error?.message ?? "RPC error"}`);
  return body.result;
}

function bytesFromHex(value) {
  invariant(/^0x(?:[0-9a-fA-F]{2})*$/.test(value), "invalid hex bytes");
  return Buffer.from(value.slice(2), "hex");
}

function decodeAbiString(value) {
  const bytes = bytesFromHex(value);
  invariant(bytes.length >= 64, "invalid ABI string response");
  const offset = Number(BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`));
  const length = Number(BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`));
  return bytes.subarray(offset + 32, offset + 32 + length).toString("utf8");
}

async function liveProbe(manifest) {
  const rpcUrl = manifest.chain.rpcUrl;
  const chainIdHex = await rpc(rpcUrl, "eth_chainId", []);
  const genesis = await rpc(rpcUrl, "eth_getBlockByNumber", ["0x0", false]);
  const contracts = {};

  await Promise.all(EXPECTED_CONTRACTS.map(async (name) => {
    const expected = manifest.contracts[name];
    const code = await rpc(rpcUrl, "eth_getCode", [expected.address, "latest"]);
    const codeBytes = bytesFromHex(code);
    let proofCodeHash = null;
    try {
      const proof = await rpc(rpcUrl, "eth_getProof", [expected.address, [], "latest"]);
      proofCodeHash = proof.codeHash ?? null;
    } catch {
      proofCodeHash = null;
    }
    contracts[name] = {
      address: expected.address.toLowerCase(),
      runtimeCodeHash: proofCodeHash,
      runtimeSha256: sha256Bytes(codeBytes),
      codeSize: codeBytes.length
    };
  }));

  const implementationWord = await rpc(
    rpcUrl,
    "eth_getStorageAt",
    [manifest.contracts.usdg.address, IMPLEMENTATION_SLOT, "latest"]
  );
  const adminWord = await rpc(
    rpcUrl,
    "eth_getStorageAt",
    [manifest.contracts.usdg.address, ADMIN_SLOT, "latest"]
  );
  const decimalsHex = await rpc(
    rpcUrl,
    "eth_call",
    [{ to: manifest.contracts.usdg.address, data: "0x313ce567" }, "latest"]
  );
  const symbolHex = await rpc(
    rpcUrl,
    "eth_call",
    [{ to: manifest.contracts.usdg.address, data: "0x95d89b41" }, "latest"]
  );
  const nameHex = await rpc(
    rpcUrl,
    "eth_call",
    [{ to: manifest.contracts.usdg.address, data: "0x06fdde03" }, "latest"]
  );

  return {
    chainId: Number(BigInt(chainIdHex)),
    genesisHash: genesis.hash,
    contracts: Object.fromEntries(Object.entries(contracts).sort(([left], [right]) => left.localeCompare(right))),
    usdg: {
      implementation: `0x${implementationWord.slice(-40)}`.toLowerCase(),
      adminSlot: adminWord.toLowerCase(),
      decimals: Number(BigInt(decimalsHex)),
      symbol: decodeAbiString(symbolHex),
      name: decodeAbiString(nameHex)
    }
  };
}

function validateLiveProbe(manifest, probe) {
  invariant(probe.chainId === manifest.chain.chainId, "live chain ID mismatch");
  invariant(probe.genesisHash === manifest.chain.genesisHash, "live genesis mismatch");
  for (const name of EXPECTED_CONTRACTS) {
    const expected = manifest.contracts[name];
    const actual = probe.contracts[name];
    invariant(actual.runtimeSha256 === expected.runtimeSha256, `${name} runtime SHA-256 mismatch`);
    invariant(actual.codeSize === expected.codeSize, `${name} code size mismatch`);
    if (actual.runtimeCodeHash !== null) {
      invariant(actual.runtimeCodeHash === expected.runtimeCodeHash, `${name} runtime code hash mismatch`);
    }
  }
  invariant(
    probe.usdg.implementation === manifest.contracts.usdg.proxy.implementation.toLowerCase(),
    "USDG live implementation mismatch"
  );
  invariant(
    probe.usdg.adminSlot === manifest.contracts.usdg.proxy.adminSlot,
    "USDG live admin slot mismatch"
  );
  invariant(probe.usdg.decimals === 6, "USDG decimals mismatch");
  invariant(probe.usdg.symbol === "USDG", "USDG symbol mismatch");
  invariant(probe.usdg.name === "Global Dollar", "USDG name mismatch");
}

async function fetchSources(sources) {
  const results = await Promise.all(sources.map(async (source) => {
    const response = await fetch(source.url, { redirect: "follow" });
    invariant(response.ok, `${source.id} source HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    return { id: source.id, sha256: sha256Bytes(body), body };
  }));
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

function validateSources(manifest, observed) {
  const expected = new Map(manifest.sources.map((source) => [source.id, source.sha256]));
  for (const source of observed) {
    invariant(source.sha256 === expected.get(source.id), `${source.id} source digest mismatch`);
  }
}

function command(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function readJson(projectRoot, relativePath) {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function gitlinkOid(projectRoot, relativePath) {
  const line = command("git", ["-C", projectRoot, "ls-files", "--stage", "--", relativePath]);
  const match = /^160000 ([0-9a-f]{40}) \d\t/.exec(line);
  invariant(match, `${relativePath} must be a tracked mode-160000 Gitlink`);
  return match[1];
}

function assertCleanCheckout(projectRoot) {
  invariant(existsSync(path.join(projectRoot, ".git")), `${projectRoot} is not a Git checkout`);
  const status = command("git", ["-C", projectRoot, "status", "--porcelain=v1", "--untracked-files=all"]);
  invariant(status === "", `${projectRoot} must be a clean checkout`);
}

function buildCheckoutIdentity(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  invariant(existsSync(path.join(resolvedRoot, ".git")), `${projectRoot} is not a Git checkout`);
  const canonicalRoot = realpathSync(resolvedRoot);
  const topLevel = realpathSync(command("git", ["-C", canonicalRoot, "rev-parse", "--show-toplevel"]));
  invariant(canonicalRoot === topLevel, `${projectRoot} must name a Git working-tree root`);
  const gitDirectory = realpathSync(command("git", ["-C", canonicalRoot, "rev-parse", "--absolute-git-dir"]));
  return { root: canonicalRoot, gitDirectory };
}

export function resolveReleaseManifestCheckout(manifestPath) {
  const requestedManifest = path.resolve(manifestPath);
  invariant(existsSync(requestedManifest), `${manifestPath} is not a release manifest`);
  const stat = lstatSync(requestedManifest);
  invariant(
    stat.isFile() && !stat.isSymbolicLink(),
    "release manifest must be a regular file"
  );
  const canonicalManifest = realpathSync(requestedManifest);
  const checkoutRoot = realpathSync(
    command("git", ["-C", path.dirname(canonicalManifest), "rev-parse", "--show-toplevel"])
  );
  const canonicalExpected = realpathSync(
    path.join(checkoutRoot, "bindings/robinhood-chain.json")
  );
  invariant(
    canonicalManifest === canonicalExpected,
    "release manifest must be the canonical bindings/robinhood-chain.json"
  );
  return checkoutRoot;
}

export function validateDistinctBuildCheckouts(checkoutOne, checkoutTwo) {
  const one = buildCheckoutIdentity(checkoutOne);
  const two = buildCheckoutIdentity(checkoutTwo);
  invariant(
    one.root !== two.root && one.gitDirectory !== two.gitDirectory,
    "reproducible build requires two distinct Git working trees"
  );
  return [one.root, two.root];
}

function checkoutHead(projectRoot) {
  const head = command("git", ["-C", projectRoot, "rev-parse", "HEAD"]);
  invariant(/^[0-9a-f]{40}$/.test(head), `${projectRoot} HEAD must be a full commit`);
  return head;
}

function loadBuildContract(projectRoot) {
  assertCleanCheckout(projectRoot);
  const manifest = readJson(projectRoot, "bindings/robinhood-chain.json");
  validateManifest(manifest);
  validatePhase3BindingEvidence(manifest, projectRoot);
  validateRuntimeSetDigest(manifest);
  const frozen = readJson(projectRoot, "architecture/interfaces.json");
  const provisional = readJson(projectRoot, "architecture/provisional-interfaces.json");
  const freeze = readJson(projectRoot, "feasibility/interface-freeze.json");
  validateInterfaceFreeze({ freeze, frozen, provisional, manifest, projectRoot });
  validateTrackedLocalProof(manifest, projectRoot);
  const reproducibleBuild = freeze.proofCoverage.reproducibleBuild;
  return {
    head: checkoutHead(projectRoot),
    manifestDigest: manifest.manifestDigest,
    freezeManifestDigest: freeze.bindingManifestDigest,
    expectedBytecode: {
      historicalRevision54: structuredClone(reproducibleBuild.historicalRevision54.bytecode),
      compilerTemplates: structuredClone(reproducibleBuild.compilerTemplates)
    }
  };
}

function normalizeExpectedReproducibleBytecode(expected) {
  invariant(
    expected?.historicalRevision54 && expected?.compilerTemplates?.PegCycleVault,
    "recorded release bytecode must contain historical revision 54 and PegCycleVault compiler templates"
  );
  const vault = expected.compilerTemplates.PegCycleVault;
  invariant(
    vault.concreteRuntimeEvidence === "PENDING_COMMIT_BOUND_EVIDENCE",
    "recorded PegCycleVault template must retain pending commit-bound evidence semantics"
  );
  return {
    ...structuredClone(expected.historicalRevision54),
    PegCycleVault: {
      ...structuredClone(vault),
      concreteRuntimeEvidence: "COMMIT_BOUND_EVIDENCE_IS_SEPARATE_FROM_COMPILER_TEMPLATE"
    }
  };
}

function normalizeGeneratedReproducibleBytecode(generated) {
  invariant(
    generated?.PegCycleVault?.concreteRuntimeEvidence === "BOUND_SEPARATELY_IN_LOCAL_CANDIDATE",
    "generated PegCycleVault runtime evidence must be bound separately in local candidate"
  );
  return {
    ...structuredClone(generated),
    PegCycleVault: {
      ...structuredClone(generated.PegCycleVault),
      concreteRuntimeEvidence: "COMMIT_BOUND_EVIDENCE_IS_SEPARATE_FROM_COMPILER_TEMPLATE"
    }
  };
}

export function validateReproducibleReleaseArtifacts(release, checkoutOne, checkoutTwo) {
  const expectedBytecode = normalizeExpectedReproducibleBytecode(release.expectedBytecode);
  for (const [label, checkout] of [
    ["first checkout", checkoutOne],
    ["second checkout", checkoutTwo]
  ]) {
    invariant(checkout.head === release.head, `${label} release commit mismatch`);
    invariant(
      checkout.manifestDigest === release.manifestDigest,
      `${label} release manifest digest mismatch`
    );
    invariant(
      checkout.freezeManifestDigest === release.manifestDigest,
      `${label} freeze manifest digest mismatch`
    );
    invariant(
      stableJson(normalizeGeneratedReproducibleBytecode(checkout.bytecode)) === stableJson(expectedBytecode),
      `${label} bytecode differs from recorded release bytecode`
    );
  }
  invariant(
    stableJson(normalizeGeneratedReproducibleBytecode(checkoutOne.bytecode))
      === stableJson(normalizeGeneratedReproducibleBytecode(checkoutTwo.bytecode)),
    "binding/custody bytecode reproduction mismatch"
  );
}

export function validateDeclaredGitlinkCoverage(gitlinks) {
  invariant(Array.isArray(gitlinks), "pinned dependency Gitlinks are required");
  assertExactSet(
    gitlinks.map((pin) => pin?.path),
    EXPECTED_DEPENDENCY_GITLINK_PATHS,
    "Gitlink declarations"
  );
}

export function validateBuildPins(projectRoot) {
  const pins = readJson(projectRoot, "product/dependency-pins.json").phase1Toolchain;
  invariant(pins?.status === "FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING", "phase-1 toolchain must remain build-only");
  const gitlinks = pins.uniswap?.dependencyGitlinks;
  validateDeclaredGitlinkCoverage(gitlinks);
  for (const pin of gitlinks) {
    const nested = /^packages\/contracts\/lib\/(v4-core|v4-periphery)\/(.+)$/.exec(pin.path);
    const repositoryRoot = nested
      ? path.join(projectRoot, "packages/contracts/lib", nested[1])
      : projectRoot;
    const repositoryPath = nested ? nested[2] : pin.path;
    invariant(gitlinkOid(repositoryRoot, repositoryPath) === pin.commit, `Gitlink pin mismatch: ${pin.path}`);
  }

  const contractsRoot = path.join(projectRoot, "packages/contracts");
  const forge = process.env.FORGE_BIN ?? "forge";
  const version = command(forge, ["--version"]);
  invariant(version.includes(`forge Version: ${pins.foundry.version}`), "Foundry version mismatch");
  invariant(version.includes(`Commit SHA: ${pins.foundry.commit}`), "Foundry commit mismatch");
  const config = JSON.parse(command(forge, ["config", "--json"], { cwd: contractsRoot }));
  invariant(config.solc === pins.solidity.solcVersion, "active Solc version mismatch");
  invariant(config.evm_version === pins.solidity.evmVersion, "active EVM version mismatch");
  invariant(config.optimizer === pins.solidity.optimizer, "active optimizer setting mismatch");
  invariant(config.optimizer_runs === pins.solidity.optimizerRuns, "active optimizer runs mismatch");
  invariant(config.auto_detect_remappings === false, "automatic remappings must be disabled");
  return {
    foundry: { version: pins.foundry.version, commit: pins.foundry.commit },
    solidity: structuredClone(pins.solidity),
    gitlinks: gitlinks.map(({ path: pinnedPath, commit }) => ({ path: pinnedPath, commit }))
  };
}

function bindingBytecodeHashes(projectRoot) {
  const contractsRoot = path.join(projectRoot, "packages/contracts");
  const artifactRoot = path.join(contractsRoot, "out/RobinhoodBindings.sol");
  const names = ["ImmutableLaunchBinding", "PermanentPositionCustody", "RobinhoodBindings"];
  const hashes = {};
  for (const name of names) {
    const artifact = JSON.parse(readFileSync(path.join(artifactRoot, `${name}.json`), "utf8"));
    const creation = artifact.bytecode?.object;
    const runtime = artifact.deployedBytecode?.object;
    invariant(typeof creation === "string" && creation.length > 0, `${name} creation bytecode is missing`);
    invariant(typeof runtime === "string" && runtime.length > 0, `${name} runtime bytecode is missing`);
    hashes[name] = {
      creationSha256: sha256Bytes(Buffer.from(creation.replace(/^0x/, ""), "hex")),
      runtimeSha256: sha256Bytes(Buffer.from(runtime.replace(/^0x/, ""), "hex"))
    };
  }
  const vaultArtifact = JSON.parse(readFileSync(
    path.join(contractsRoot, "out/PegCycleVault.sol/PegCycleVault.json"),
    "utf8"
  ));
  const vaultCreation = vaultArtifact.bytecode?.object;
  const vaultRuntime = vaultArtifact.deployedBytecode?.object;
  invariant(typeof vaultCreation === "string" && vaultCreation.length > 0, "PegCycleVault creation template is missing");
  invariant(typeof vaultRuntime === "string" && vaultRuntime.length > 0, "PegCycleVault runtime template is missing");
  hashes.PegCycleVault = {
    creationTemplateSha256: sha256Bytes(Buffer.from(vaultCreation.replace(/^0x/, ""), "hex")),
    runtimeTemplateSha256: sha256Bytes(Buffer.from(vaultRuntime.replace(/^0x/, ""), "hex")),
    runtimeHasImmutableReferences: true,
    concreteRuntimeEvidence: "BOUND_SEPARATELY_IN_LOCAL_CANDIDATE"
  };
  return hashes;
}

function buildPinnedCheckout(projectRoot) {
  assertCleanCheckout(projectRoot);
  const forge = process.env.FORGE_BIN ?? "forge";
  command(forge, ["build", "--force"], { cwd: path.join(projectRoot, "packages/contracts") });
  const pins = validateBuildPins(projectRoot);
  const localProof = validateGeneratedLocalProof(projectRoot);
  return { pins, bytecode: bindingBytecodeHashes(projectRoot), localProof };
}

export function verifyReproducibleBuild(manifestPath, checkoutOne, checkoutTwo) {
  const [checkoutOneRoot, checkoutTwoRoot] = validateDistinctBuildCheckouts(checkoutOne, checkoutTwo);
  const releaseRoot = resolveReleaseManifestCheckout(manifestPath);
  const release = loadBuildContract(releaseRoot);
  const checkoutOneContract = loadBuildContract(checkoutOneRoot);
  const checkoutTwoContract = loadBuildContract(checkoutTwoRoot);
  const one = buildPinnedCheckout(checkoutOneRoot);
  const two = buildPinnedCheckout(checkoutTwoRoot);
  invariant(stableJson(one.pins) === stableJson(two.pins), "pinned build toolchains differ");
  checkoutOneContract.bytecode = one.bytecode;
  checkoutTwoContract.bytecode = two.bytecode;
  validateReproducibleReleaseArtifacts(release, checkoutOneContract, checkoutTwoContract);
  return {
    releaseCommit: release.head,
    manifestDigest: release.manifestDigest,
    checkouts: [checkoutOneRoot, checkoutTwoRoot],
    toolchain: one.pins,
    bytecode: one.bytecode,
    repeatedExactly: true
  };
}

const REPRODUCIBLE_BUILD_USAGE =
  "usage: node feasibility/verify-robinhood-binding.mjs bindings/robinhood-chain.json --reproducible-build CHECKOUT_A CHECKOUT_B";

export function parseVerifierInvocation(argv) {
  const args = argv.slice(2);
  const reproducibleIndex = args.indexOf("--reproducible-build");
  if (reproducibleIndex !== -1) {
    invariant(
      args.length === 4 && reproducibleIndex === 1 && !args[0].startsWith("-")
        && args[2] && !args[2].startsWith("-") && args[3] && !args[3].startsWith("-"),
      REPRODUCIBLE_BUILD_USAGE
    );
    return {
      manifestPath: args[0],
      mode: "reproducible-build",
      checkouts: [args[2], args[3]]
    };
  }

  let manifestPath = "bindings/robinhood-chain.json";
  let manifestProvided = false;
  let offline = false;
  for (const arg of args) {
    if (arg === "--offline") {
      invariant(!offline, "--offline may be specified only once");
      offline = true;
    } else {
      invariant(!arg.startsWith("-") && !manifestProvided, "usage: node feasibility/verify-robinhood-binding.mjs [bindings/robinhood-chain.json] [--offline]");
      manifestPath = arg;
      manifestProvided = true;
    }
  }
  return { manifestPath, mode: "verify", offline };
}

async function main() {
  const invocation = parseVerifierInvocation(process.argv);
  if (invocation.mode === "reproducible-build") {
    const build = verifyReproducibleBuild(invocation.manifestPath, ...invocation.checkouts);
    process.stdout.write(`${JSON.stringify({ status: "REPRODUCED_BUILD_ONLY_FAIL_CLOSED", build, productionReady: false }, null, 2)}\n`);
    return;
  }

  const manifestPath = path.resolve(invocation.manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const projectRoot = process.cwd();
  const staticResult = validateManifest(manifest);
  validatePhase3BindingEvidence(manifest, projectRoot);
  const officialRecheck = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/official-robinhood-binding-recheck.json"), "utf8")
  );
  validatePinnedOfficialBindingFacts(manifest, parsePinnedOfficialBindingFacts(officialRecheck));
  validateRuntimeSetDigest(manifest);
  const frozen = JSON.parse(readFileSync(path.join(projectRoot, "architecture/interfaces.json"), "utf8"));
  const provisional = JSON.parse(
    readFileSync(path.join(projectRoot, "architecture/provisional-interfaces.json"), "utf8")
  );
  const freeze = JSON.parse(
    readFileSync(path.join(projectRoot, "feasibility/interface-freeze.json"), "utf8")
  );
  const interfaceFreeze = validateInterfaceFreeze({
    freeze,
    frozen,
    provisional,
    manifest,
    projectRoot
  });
  const localProof = validateLocalProof(manifest, projectRoot);
  const { offline } = invocation;

  let reproducibility = { offline: true };
  if (!offline) {
    const [sourcesOne, sourcesTwo, probeOne, probeTwo] = await Promise.all([
      fetchSources([...manifest.sources, ...manifest.abiSources]),
      fetchSources([...manifest.sources, ...manifest.abiSources]),
      liveProbe(manifest),
      liveProbe(manifest)
    ]);
    validateSources(
      { sources: [...manifest.sources, ...manifest.abiSources] },
      sourcesOne
    );
    validateSources(
      { sources: [...manifest.sources, ...manifest.abiSources] },
      sourcesTwo
    );
    validateLiveProbe(manifest, probeOne);
    validateLiveProbe(manifest, probeTwo);
    const deploymentSource = sourcesOne.find((source) => source.id === "uniswap-chain-4663-deployment");
    invariant(deploymentSource, "pinned Uniswap deployment source is missing");
    validatePinnedOfficialBindingFacts(manifest, parsePinnedUniswapDeploymentFacts(deploymentSource.body));
    const launcherSource = sourcesOne.find(
      (source) => source.id === "uniswap-liquidity-launcher-addresses"
    );
    invariant(launcherSource, "pinned liquidity-launcher address source is missing");
    validatePinnedOfficialBindingFacts(
      manifest,
      parsePinnedLiquidityLauncherFacts(launcherSource.body)
    );
    const comparableSourcesOne = sourcesOne.map(({ id, sha256 }) => ({ id, sha256 }));
    const comparableSourcesTwo = sourcesTwo.map(({ id, sha256 }) => ({ id, sha256 }));
    invariant(stableJson(comparableSourcesOne) === stableJson(comparableSourcesTwo), "source reproduction mismatch");
    invariant(stableJson(probeOne) === stableJson(probeTwo), "live probe reproduction mismatch");
    reproducibility = {
      offline: false,
      sourceProbeDigest: digestCollection(comparableSourcesOne),
      runtimeProbeDigest: digestCollection(probeOne),
      repeatedExactly: true
    };
  }

  process.stdout.write(`${JSON.stringify({
    status: "VERIFIED_BUILD_ONLY_FAIL_CLOSED",
    ...staticResult,
    interfaceFreeze,
    localProof,
    reproducibility,
    productionReady: false
  }, null, 2)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
