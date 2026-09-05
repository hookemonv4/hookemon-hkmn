import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const realRoot = realpathSync(root);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifactFields = [
  'abiSha256',
  'contract',
  'eventSchemaSha256',
  'initcodeBytes',
  'initcodeSha256',
  'localCompilerGas',
  'methodIdentifiers',
  'runtimeBytes',
  'runtimeSha256',
  'source',
];
export const expectedArtifactIdentities = [
  'src/access/MoneyRoles.sol::MoneyRoles',
  'src/accounting/FeeAccounting.sol::FeeAccounting',
  'src/bindings/RobinhoodBindings.sol::IERC721OwnerOf',
  'src/bindings/RobinhoodBindings.sol::IERC721Receiver',
  'src/bindings/RobinhoodBindings.sol::ImmutableLaunchBinding',
  'src/bindings/RobinhoodBindings.sol::PermanentPositionCustody',
  'src/bindings/RobinhoodBindings.sol::RobinhoodBindings',
  'src/HookemonHook.sol::HookemonHook',
  'src/launch/CustomLaunchStrategy.sol::CustomLaunchStrategy',
  'src/launch/CustomLaunchStrategy.sol::IUERC20FactoryLike',
  'src/launch/HookemonIssuance.sol::HookemonIssuance',
  'src/market/CanonicalMarket.sol::CanonicalMarketCallback',
  'src/market/CanonicalMarket.sol::CanonicalSwapHookData',
  'src/payout/CanonicalMerkleSum.sol::CanonicalMerkleSum',
  'src/payout/PayoutCommitment.sol::PayoutCommitment',
  'src/process/FundingAuthorizationValidation.sol::FundingAuthorizationValidation',
  'src/process/IPegCycleRouteExecutor.sol::IPegCycleRouteExecutor',
  'src/process/IPegCycleVault.sol::IPegCycleVault',
  'src/process/IPegCycleVault.sol::PayoutDomainTypedData',
  'src/process/PayoutDistributionSignatures.sol::PayoutDistributionSignatures',
  'src/process/PegCycleEscrowFactory.sol::PegCycleEscrowFactory',
  'src/process/PegCycleReturnEscrow.sol::IPegCycleEscrowUsdg',
  'src/process/PegCycleReturnEscrow.sol::PegCycleReturnEscrow',
  'src/process/PegCycleRouteExecutor.sol::IPegCycleRouteUsdg',
  'src/process/PegCycleRouteExecutor.sol::IPegCycleRouteVaultBinding',
  'src/process/PegCycleRouteExecutor.sol::PegCycleRouteExecutor',
  'src/process/PegCycleVault.sol::IPegCycleHookBinding',
  'src/process/PegCycleVault.sol::IPegCycleUsdg',
  'src/process/PegCycleVault.sol::PegCycleVault',
  'src/process/ProcessBudget.sol::IPegCycleVaultIdentity',
  'src/process/ProcessBudget.sol::ProcessBudget',
  'src/settlement/HolderSettlement.sol::HolderSettlement',
];

// The two Custom Launch Strategy placeholder custody contracts are D10
// PLACEHOLDER_OWNER_DECISION stubs (see docs/modules/custom-launch-strategy.md and design.md
// section 11 D10): compiled internal helpers, never part of the deployed production closure this
// candidate binds. They are the only production-tree artifacts intentionally excluded from
// expectedArtifactIdentities; any other compiled src/ artifact outside that list is a defect the
// reproducibility build must reject loudly (see collectSourceArtifacts in
// verify-phase1-reproducibility.mjs) rather than silently drop.
export const intentionallyUntrackedArtifactIdentities = Object.freeze([
  'src/launch/CustomLaunchStrategy.sol::PlaceholderRemainderCustody',
  'src/launch/CustomLaunchStrategy.sol::PlaceholderMarketPositionCustody',
]);

export const expectedHighRiskMethodIdentifiers = Object.freeze({
  'src/process/IPegCycleRouteExecutor.sol::IPegCycleRouteExecutor': {
    'executeOutbound(bytes32,address,uint256,address,bytes)': '3686c496',
  },
  'src/process/IPegCycleVault.sol::IPegCycleVault': {
    'authorizeFunding((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256))': '80353ac8',
    'authorizeFundingAfterFailure((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256),bytes32,bytes32)': 'b12235e8',
    // WP-38: authorizePayout now takes the two pinned EIP-712 signatures (decision D7) alongside
    // the authorization struct.
    'authorizePayout((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256),bytes,bytes)': '015f4600',
    'cancelExpiredFundingAuthorization(bytes32)': '9eb10a05',
    'computeCycleEscrow(bytes32)': '4361c965',
    'confirmFunding(bytes32,uint256)': '1014c05a',
    'consumeFundingAuthorization(bytes32,address)': '69c3b3cb',
    'consumePayoutAuthorization((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))': '600622c6',
    'cycleEscrows(bytes32)': '036289ad',
    'cycleLifecycles(bytes32)': 'fdbf44d2',
    'failedCycleSuccessors(bytes32)': '259e6cb9',
    'failureReceiptDigests(bytes32)': '41a49aaf',
    'isCycleConsumed(bytes32)': 'f6c14a07',
    'isNonceConsumed(uint256)': '2cc05b37',
    'isPayoutIdConsumed(bytes32)': '0301198c',
    'isReturnReceiptDigestConsumed(bytes32)': '3a18209d',
    'readActiveAuthorization()': 'd2be0885',
    'readCommittedPayoutBinding(bytes32)': '51d999c9',
    'readPendingAuthorization()': '8e8e8455',
    'recordDegradedReturn(bytes32,bytes32,bool)': '8cd494c2',
    'recordTerminalFailure(bytes32,bytes32)': 'f3c9f317',
    'recoveryPredecessors(bytes32)': '41c9c1ff',
    'renewFundingAuthorizationDeadline((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256))': '2befa57f',
    'renewPayoutAuthorizationDeadline((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))': '4e1e7e9d',
  },
  // WP-38 split PegCycleVault's own inline funding-authorization validation, payout-signature
  // verification, and cycle-escrow CREATE2 deployment out into three narrowly scoped external
  // libraries (see each file's own docstring for why: staying under the EIP-170 24,576-byte
  // runtime budget). PegCycleVault calls all three through DELEGATECALL library linking, exactly
  // the same authority surface the inline code used to expose directly, so their own compiled
  // selectors are pinned here for the same reason PegCycleReturnEscrow/PegCycleRouteExecutor are
  // below: to catch ABI drift on logic PegCycleVault's own authority depends on. Note that
  // forge/solc compute the pinned method-identifier key for an external library function taking a
  // struct parameter using the struct's declared (unflattened) type name rather than its
  // canonical tuple encoding; the values below are copied verbatim from the compiled artifact's
  // own `methodIdentifiers`, not hand-derived.
  'src/process/FundingAuthorizationValidation.sol::FundingAuthorizationValidation': {
    'verify(IPegCycleVault.FundingAuthorization,FundingAuthorizationValidation.VaultIdentity)': '1cfa2192',
  },
  'src/process/PayoutDistributionSignatures.sol::PayoutDistributionSignatures': {
    'verify(bytes32,IPegCycleVault.PayoutAuthorization,PayoutDistributionSignatures.ActiveCycleContext,bytes,bytes,address,address)': '3384c292',
  },
  'src/process/PegCycleEscrowFactory.sol::PegCycleEscrowFactory': {
    'computeAddress(address,address,address,bytes32)': 'd54246c1',
    'deploy(address,address,address,bytes32)': 'a1e7ac9e',
  },
  // PegCycleReturnEscrow and PegCycleRouteExecutor are the two market-routing production
  // contracts that move real USDG principal (PegCycleVault calls the escrow by concrete type;
  // the vault calls the route executor only through the already-tracked IPegCycleRouteExecutor
  // interface above). Pinning their own compiled selectors here catches ABI drift on the exact
  // authority surface PegCycleVault depends on, the same way PegCycleVault/IPegCycleVault are
  // both pinned below.
  'src/process/PegCycleReturnEscrow.sol::PegCycleReturnEscrow': {
    'coordinator()': '0a009097',
    'cycleId()': '62e0accb',
    'hook()': '7f5a7c7b',
    'routeExecutor()': '748a7973',
    'sendOutbound(uint256)': '1b905259',
    'sendPayout(uint256)': 'c3de3b88',
    'usdg()': 'f5b91b7b',
  },
  'src/process/PegCycleRouteExecutor.sol::PegCycleRouteExecutor': {
    'depositCallbackSelector()': 'e56152e0',
    'depositTarget()': 'fb1fa08d',
    'executeOutbound(bytes32,address,uint256,address,bytes)': '3686c496',
    'usdg()': 'f5b91b7b',
    'vault()': 'fbfa77cf',
  },
  'src/process/PegCycleVault.sol::PegCycleVault': {
    'authorizeFunding((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256))': '80353ac8',
    'authorizeFundingAfterFailure((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256),bytes32,bytes32)': 'b12235e8',
    // WP-38: authorizePayout now takes the two pinned EIP-712 signatures (decision D7) alongside
    // the authorization struct.
    'authorizePayout((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256),bytes,bytes)': '015f4600',
    'authorizer()': 'd09edf31',
    'bindHook(address)': '10202c54',
    'bindingManifestDigest()': '20dbddee',
    'cancelExpiredFundingAuthorization(bytes32)': '9eb10a05',
    'computeCycleEscrow(bytes32)': '4361c965',
    'confirmFunding(bytes32,uint256)': '1014c05a',
    'consumeFundingAuthorization(bytes32,address)': '69c3b3cb',
    'consumePayoutAuthorization((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))': '600622c6',
    'cycleEscrows(bytes32)': '036289ad',
    'cycleLifecycles(bytes32)': 'fdbf44d2',
    'deploymentAuthority()': '7138d7ba',
    'executeOutbound(bytes32,bytes)': 'bf26e968',
    'failedCycleSuccessors(bytes32)': '259e6cb9',
    'failureReceiptDigests(bytes32)': '41a49aaf',
    'hook()': '7f5a7c7b',
    'isCycleConsumed(bytes32)': 'f6c14a07',
    'isNonceConsumed(uint256)': '2cc05b37',
    'isPayoutIdConsumed(bytes32)': '0301198c',
    'isReturnReceiptDigestConsumed(bytes32)': '3a18209d',
    'lifecycle()': 'ac0cc868',
    'payoutAuthorizationDigest()': 'd1afe0e4',
    'readActiveAuthorization()': 'd2be0885',
    'readCommittedPayoutBinding(bytes32)': '51d999c9',
    'readPendingAuthorization()': '8e8e8455',
    'recordDegradedReturn(bytes32,bytes32,bool)': '8cd494c2',
    'recordTerminalFailure(bytes32,bytes32)': 'f3c9f317',
    'recoveryPredecessors(bytes32)': '41c9c1ff',
    'renewFundingAuthorizationDeadline((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256))': '2befa57f',
    'renewPayoutAuthorizationDeadline((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))': '4e1e7e9d',
    'REQUIREMENTS_REVISION()': '8e55e17b',
    'routeExecutor()': '748a7973',
    'terminalCycleId()': '9c42bb3c',
    'terminalFailureReceiptDigest()': '7454c273',
    'usdg()': 'f5b91b7b',
  },
  'src/process/ProcessBudget.sol::ProcessBudget': {
    'acceptOperations()': '19df4514',
    'acceptTreasury()': 'e49d2a30',
    'openPegCycle(bytes32)': '0e563b37',
    'pegCycleVault()': '702fbe85',
    'proposeOperations(address)': 'f2ab0be5',
    'proposeTreasury(address)': 'f110ed67',
    'readReleasedCycle(bytes32)': '5fb8e68f',
    'readRoles(bytes32)': '47279253',
  },
  'src/payout/PayoutCommitment.sol::PayoutCommitment': {
    'acceptOperations()': '19df4514',
    'acceptTreasury()': 'e49d2a30',
    'commitPayoutChunk(bytes32,uint16,bytes32,uint256)': 'e246eb29',
    'fundPayoutFromPegCycle((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))': '5a97f343',
    'isManifestClosed(bytes32)': 'baea50e3',
    'openPegCycle(bytes32)': '0e563b37',
    'pegCycleVault()': '702fbe85',
    'proposeOperations(address)': 'f2ab0be5',
    'proposeTreasury(address)': 'f110ed67',
    'readPayout(bytes32)': '06258a8d',
    'readPayoutChunk(bytes32,uint16)': '6c7715e0',
    'readPayoutConservation(bytes32)': '6a54977c',
    'readReleasedCycle(bytes32)': '5fb8e68f',
    'readRoles(bytes32)': '47279253',
  },
  'src/settlement/HolderSettlement.sol::HolderSettlement': {
    'acceptOperations()': '19df4514',
    'acceptTreasury()': 'e49d2a30',
    'commitPayoutChunk(bytes32,uint16,bytes32,uint256)': 'e246eb29',
    'fundPayoutFromPegCycle((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))': '5a97f343',
    'isManifestClosed(bytes32)': 'baea50e3',
    'isPaid(bytes32,uint16,uint16)': '0af9fcac',
    'openPegCycle(bytes32)': '0e563b37',
    'payEntitlement(bytes32,uint16,uint16,address,uint256,bytes32[10],uint256[10])': 'e25aa844',
    'pegCycleVault()': '702fbe85',
    'proposeOperations(address)': 'f2ab0be5',
    'proposeTreasury(address)': 'f110ed67',
    'readPayout(bytes32)': '06258a8d',
    'readPayoutChunk(bytes32,uint16)': '6c7715e0',
    'readPayoutConservation(bytes32)': '6a54977c',
    'readReleasedCycle(bytes32)': '5fb8e68f',
    'readRoles(bytes32)': '47279253',
    'verifyEntitlementProof(bytes32,uint16,uint16,address,uint256,bytes32[10],uint256[10])': '1cc2c3be',
  },
});

export const requiredCandidatePaths = [
  'specs/requirements.json',
  'architecture/interfaces.json',
  'architecture/provisional-interfaces.json',
  'architecture/risk-classes.json',
  'architecture/execution-topology.md',
  'decisions/ADR-0019-immutable-peg-cycle-custody.md',
  'product/PRD.md',
  'product/OWNER_DECISIONS.md',
  'product/SOURCE_BOUNDARY.md',
  'product/REQUIREMENTS_REVISION_56_PROPOSAL.md',
  'product/dependency-pins.json',
  'feasibility/interface-freeze.json',
  'feasibility/refresh-interface-freeze.mjs',
  'feasibility/verify-robinhood-binding.mjs',
  'feasibility/model.mjs',
  'feasibility/model-results.json',
  'feasibility/survivability-bounds.json',
  'feasibility/integration-spikes.json',
  'feasibility/risk-lanes.json',
  'feasibility/programmable-ethereum-api-shape.json',
  'tasks/context-packs.json',
  'docs/modules/index.json',
  'docs/modules/process-budget.md',
  'docs/modules/peg-cycle-vault.md',
  'docs/modules/payout-commitment.md',
  'docs/modules/cycle-runner.md',
  'docs/modules/release-evidence.md',
  'packages/contracts/foundry.toml',
  'packages/contracts/src/HookemonHook.sol',
  'packages/contracts/src/access/MoneyRoles.sol',
  'packages/contracts/src/accounting/FeeAccounting.sol',
  'packages/contracts/src/bindings/RobinhoodBindings.sol',
  'packages/contracts/src/launch/CustomLaunchStrategy.sol',
  'packages/contracts/src/launch/HookemonIssuance.sol',
  'packages/contracts/src/launch/HKMNToken.sol',
  'packages/contracts/src/market/CanonicalMarket.sol',
  'packages/contracts/src/payout/CanonicalMerkleSum.sol',
  'packages/contracts/src/payout/PayoutCommitment.sol',
  'packages/contracts/src/process/FundingAuthorizationValidation.sol',
  'packages/contracts/src/process/IPegCycleRouteExecutor.sol',
  'packages/contracts/src/process/IPegCycleVault.sol',
  'packages/contracts/src/process/PayoutDistributionSignatures.sol',
  'packages/contracts/src/process/PegCycleEscrowFactory.sol',
  'packages/contracts/src/process/PegCycleReturnEscrow.sol',
  'packages/contracts/src/process/PegCycleRouteExecutor.sol',
  'packages/contracts/src/process/PegCycleVault.sol',
  'packages/contracts/src/process/ProcessBudget.sol',
  'packages/contracts/src/settlement/HolderSettlement.sol',
  'packages/contracts/script/release/PhaseOneReleasePlan.sol',
  'packages/contracts/test-js/payout/canonical-merkle-sum.test.mjs',
  'packages/contracts/test-vectors/payout/canonical-merkle-sum-v1.json',
  'packages/contracts/test/integration/PhaseOneLocalLoop.t.sol',
  'packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol',
  'packages/contracts/test/payout/CanonicalMerkleSum.t.sol',
  'packages/contracts/test/payout/PayoutCommitment.t.sol',
  'packages/contracts/test/process/PegCycleVault.t.sol',
  'packages/contracts/test/process/ProcessBudget.t.sol',
  'packages/contracts/test/settlement/HolderSettlement.t.sol',
  'packages/contracts/tooling/payout/canonical-merkle-sum.mjs',
  'packages/runner/src/cycle/authorization.mjs',
  'packages/runner/src/cycle/bindings.mjs',
  'packages/runner/src/cycle/blockhash-validity.mjs',
  'packages/runner/src/cycle/collector.mjs',
  'packages/runner/src/cycle/cycle-runner.mjs',
  'packages/runner/src/cycle/cycle-store.mjs',
  'packages/runner/src/cycle/decoder.mjs',
  'packages/runner/src/cycle/execution-accounting.mjs',
  'packages/runner/src/cycle/journal.mjs',
  'packages/runner/src/cycle/preflight.mjs',
  'packages/runner/src/cycle/receipt-registry.mjs',
  'packages/runner/src/cycle/reducer.mjs',
  'packages/runner/src/cycle/schemas.mjs',
  'packages/runner/src/cycle/verify-fixtures.mjs',
  'packages/runner/src/distribution/manifest.mjs',
  'packages/runner/src/distribution/merkle-sum.mjs',
  'packages/runner/src/distribution/reconcile.mjs',
  'packages/runner/test/cycle/fixture-crypto.mjs',
  'packages/runner/test/cycle/fixture-cycle.mjs',
  'packages/runner/test/cycle/security.test.mjs',
  'packages/runner/test/distribution/holder-candidate.test.mjs',
  'packages/runner/test/distribution/manifest.test.mjs',
  'packages/runner/test/distribution/reconcile.test.mjs',
  'packages/runner/test/integration/phase-one-local-loop-adapter.mjs',
  'scripts/tests/phase1-release.test.mjs',
  'scripts/tests/phase1-reproducibility.test.mjs',
  'scripts/tests/phase-boundary.test.mjs',
  'scripts/tests/reqs.test.mjs',
  'scripts/verify-phase1-release.mjs',
  'scripts/verify-phase1-reproducibility.mjs',
  'release/phase1/external-action-stop.json',
  'release/phase1/local-evidence.json',
  'release/phase1/local-toolchain.json',
  'qa/reviews/phase1-local-risk-review.md',
];

// Explicit surface policy: every production Solidity source is classified exactly once as
// either 'custody' (holds or moves USDG principal; the strict forbidden-authority rules in
// validateCustodySourceSurfaces apply with zero exceptions beyond the one documented canonical
// pegged-token transfer idiom below) or 'market-routing' (the v4 hook callback surface, the
// launch strategy, the deposit route, and the Robinhood position bindings, which legitimately
// perform a small number of additional external calls). validateCandidateProductionSourceClosure
// asserts every production source file appears here exactly once.
export const sourceSurfaceClasses = Object.freeze({
  'packages/contracts/src/access/MoneyRoles.sol': 'custody',
  'packages/contracts/src/accounting/FeeAccounting.sol': 'custody',
  'packages/contracts/src/payout/CanonicalMerkleSum.sol': 'custody',
  'packages/contracts/src/payout/PayoutCommitment.sol': 'custody',
  // The three libraries below are WP-38's dual-signature payout split: PegCycleVault delegates
  // its own inline validation/signature/CREATE2 logic to them (see each file's own docstring) to
  // stay under the EIP-170 runtime size budget. None performs a generic call, delegatecall,
  // staticcall, or selfdestruct -- FundingAuthorizationValidation and PayoutDistributionSignatures
  // are pure field/signature validation (no external call of any kind), and PegCycleEscrowFactory
  // only computes a CREATE2 address and deploys PegCycleReturnEscrow through it, then reads back
  // the freshly deployed escrow's own reported identity via ordinary view calls. All three keep
  // the strict custody rules with zero allow-list exceptions.
  'packages/contracts/src/process/FundingAuthorizationValidation.sol': 'custody',
  'packages/contracts/src/process/IPegCycleRouteExecutor.sol': 'custody',
  'packages/contracts/src/process/IPegCycleVault.sol': 'custody',
  'packages/contracts/src/process/PayoutDistributionSignatures.sol': 'custody',
  'packages/contracts/src/process/PegCycleEscrowFactory.sol': 'custody',
  'packages/contracts/src/process/PegCycleReturnEscrow.sol': 'custody',
  'packages/contracts/src/process/PegCycleVault.sol': 'custody',
  'packages/contracts/src/process/ProcessBudget.sol': 'custody',
  'packages/contracts/src/settlement/HolderSettlement.sol': 'custody',
  'packages/contracts/src/HookemonHook.sol': 'market-routing',
  'packages/contracts/src/bindings/RobinhoodBindings.sol': 'market-routing',
  'packages/contracts/src/launch/CustomLaunchStrategy.sol': 'market-routing',
  'packages/contracts/src/launch/HookemonIssuance.sol': 'market-routing',
  // The fixed-supply Phase 3 target exposes the standard ERC-20 declarations and the graph-only
  // allocation endpoint; its exact declaration inventory is constrained below.
  'packages/contracts/src/launch/HKMNToken.sol': 'market-routing',
  'packages/contracts/src/market/CanonicalMarket.sol': 'market-routing',
  'packages/contracts/src/process/PegCycleRouteExecutor.sol': 'market-routing',
});

export const custodySourcePaths = Object.freeze(Object.keys(sourceSurfaceClasses)
  .filter((path) => sourceSurfaceClasses[path] === 'custody')
  .sort());
export const marketRoutingSourcePaths = Object.freeze(Object.keys(sourceSurfaceClasses)
  .filter((path) => sourceSurfaceClasses[path] === 'market-routing')
  .sort());

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function lexSolidityAuthoritySurface(source) {
  if (typeof source !== 'string') throw new Error('custody source must be Solidity text');
  const characters = [...source];
  let state = 'code';
  let quote = '';
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    const next = characters[index + 1];
    if (state === 'code') {
      if (current === '/' && next === '/') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        state = 'line-comment';
        index += 1;
      } else if (current === '/' && next === '*') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        state = 'block-comment';
        index += 1;
      } else if (current === '"' || current === "'") {
        quote = current;
        characters[index] = ' ';
        state = 'string';
      }
    } else if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code';
      else characters[index] = ' ';
    } else if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        characters[index] = ' ';
        characters[index + 1] = ' ';
        state = 'code';
        index += 1;
      } else if (current !== '\n' && current !== '\r') characters[index] = ' ';
    } else if (state === 'string') {
      characters[index] = current === '\n' || current === '\r' ? current : ' ';
      if (current === '\\') {
        if (index + 1 >= characters.length) throw new Error('custody source contains an unterminated string');
        index += 1;
        characters[index] = characters[index] === '\n' || characters[index] === '\r' ? characters[index] : ' ';
      } else if (current === quote) {
        state = 'code';
        quote = '';
      }
    }
  }
  if (state === 'block-comment' || state === 'string') {
    throw new Error('custody source contains an unterminated lexical construct');
  }
  return characters.join('');
}

// The one external-call idiom every custody surface may use without becoming a market-routing
// surface: a low-level call on the immutable pegged USDG token (`usdg`, set once at construction
// and never owner-mutable) that encodes exactly the ERC-20 `transfer` selector via
// `abi.encodeCall` against a locally declared `I*Usdg` interface, moving funds to a caller-fixed
// recipient. PegCycleReturnEscrow uses this to move its escrowed principal to the immutable
// `hook`/`routeExecutor` addresses fixed at construction, verifying the balance delta before and
// after. It is not a generic call: the token, the selector, and the encoding shape are frozen.
const CANONICAL_PEGGED_TRANSFER_CALL =
  /\busdg\s*\.\s*call\s*\(\s*abi\.encodeCall\s*\(\s*I[A-Za-z0-9_]*Usdg\s*\.\s*transfer\s*,\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*\)\s*\)\s*\)/g;

// Market-routing-only idiom: PegCycleRouteExecutor's single alternate deposit path, an
// ERC-677/`transferAndCall`-shaped call of a fixed, construction-time `depositCallbackSelector`
// on the immutable pegged token, to the immutable `depositTarget`, carrying the exact `amount`
// and `requestId` the vault itself authorized. No caller-supplied target or selector.
const ROUTE_EXECUTOR_CALLBACK_DEPOSIT_CALL =
  /\busdg\s*\.\s*call\s*\(\s*abi\.encodeWithSelector\s*\(\s*depositCallbackSelector\s*,\s*depositTarget\s*,\s*amount\s*,\s*abi\.encode\s*\(\s*requestId\s*\)\s*\)\s*\)/g;

// Market-routing-only idiom: HookemonHook's raw ERC-20 `balanceOf` staticcall against the
// immutable pegged currency, used because the hook accepts an arbitrary ERC-20 as USDG and
// cannot assume a typed interface. Fixed selector (0x70a08231 == balanceOf(address)), fixed
// receiver expression, no owner-mutable input beyond the queried account.
const PEGGED_CURRENCY_BALANCE_STATICCALL =
  /Currency\.unwrap\s*\(\s*usdg\s*\)\s*\.\s*staticcall\s*\(\s*abi\.encodeWithSelector\s*\(\s*bytes4\s*\(\s*0x70a08231\s*\)\s*,\s*account\s*\)\s*\)/g;

// Market-routing-only idiom: HookemonHook's raw ERC-20 `transfer` call against the immutable
// pegged currency (fixed selector 0xa9059cbb == transfer(address,uint256)). `recipient` is
// always resolved internally by FeeAccounting/HolderSettlement to the programmable, treasury, or
// payout destinations -- never an owner-settable address -- which this pattern enforces
// structurally by requiring the literal parameter name `recipient`.
const PEGGED_CURRENCY_TRANSFER_CALL =
  /Currency\.unwrap\s*\(\s*usdg\s*\)\s*\.\s*call\s*\(\s*abi\.encodeWithSelector\s*\(\s*bytes4\s*\(\s*0xa9059cbb\s*\)\s*,\s*recipient\s*,\s*amount\s*\)\s*\)/g;

const HOOKEMON_SOURCE_PATH = 'packages/contracts/src/HookemonHook.sol';
const HOOKEMON_ISSUANCE_SOURCE_PATH = 'packages/contracts/src/launch/HookemonIssuance.sol';
const HKMN_TOKEN_SOURCE_PATH = 'packages/contracts/src/launch/HKMNToken.sol';
const HOOKEMON_PERMIT2_TRANSFER_CALL =
  /ILaunchPermit2\s*\(\s*permit2\s*\)\s*\.\s*transferFrom\s*\(\s*params\.payer\s*,\s*address\s*\(\s*this\s*\)\s*,\s*uint160\s*\(\s*usdgMax\s*\)\s*,\s*Currency\.unwrap\s*\(\s*usdg\s*\)\s*\)\s*;/g;
const HOOKEMON_PERMIT2_APPROVAL_CALL =
  /\bpermit\s*\.\s*approve\s*\(\s*(?:usdgToken|hkmnToken)\s*,\s*positionManager\s*,\s*(?:uint160\s*\(\s*(?:usdgMax|hkmnMax)\s*\)|0)\s*,\s*(?:uint48\s*\(\s*block\.timestamp\s*\)|0)\s*\)\s*;/g;
const HOOKEMON_RAW_APPROVE_CALL =
  /\btoken\s*\.\s*call\s*\(\s*abi\.encodeWithSelector\s*\(\s*bytes4\s*\(\s*0x095ea7b3\s*\)\s*,\s*spender\s*,\s*amount\s*\)\s*\)/g;
const HOOKEMON_RAW_BALANCE_CALL =
  /\btoken\s*\.\s*staticcall\s*\(\s*abi\.encodeWithSelector\s*\(\s*bytes4\s*\(\s*0x70a08231\s*\)\s*,\s*account\s*\)\s*\)/g;
// The legacy non-graph seed path can transfer an exact residual to the internally resolved
// treasury. Graph-mode seeding never reaches this path and instead reverts on an HKMN residual.
const HOOKEMON_HKMN_DUST_TRANSFER_CALL =
  /\bhkmnToken\s*\.\s*call\s*\(\s*abi\.encodeWithSelector\s*\(\s*bytes4\s*\(\s*0xa9059cbb\s*\)\s*,\s*_currentTreasury\s*\(\s*\)\s*,\s*transferred\s*\)\s*\)/g;
const HOOKEMON_GRAPH_CONFIGURATION_CALL =
  /Currency\.unwrap\s*\(\s*hkmn\s*\)\s*\.\s*staticcall\s*\(\s*abi\.encodeCall\s*\(\s*IGraphIssuedToken\.validateGraphConfiguration\s*,\s*\(\s*address\s*\(\s*this\s*\)\s*,\s*Currency\.unwrap\s*\(\s*usdg\s*\)\s*,\s*sqrtPriceX96\s*,\s*graphInitializer\s*,\s*graphExpectedDecimals\s*\)\s*\)\s*\)/g;
const HOOKEMON_ISSUED_ALLOCATION_CALL =
  /Currency\.unwrap\s*\(\s*hkmn\s*\)\s*\.\s*staticcall\s*\(\s*abi\.encodeCall\s*\(\s*IGraphIssuedToken\.validateIssuedAllocation\s*,\s*\(\s*address\s*\(\s*this\s*\)\s*,\s*Currency\.unwrap\s*\(\s*usdg\s*\)\s*,\s*graphInitializer\s*,\s*graphExpectedDecimals\s*\)\s*\)\s*\)/g;
const HOOKEMON_PERMIT2_DECLARATIONS = Object.freeze([
  /\bfunction\s+approve\s*\(\s*address\s+token\s*,\s*address\s+spender\s*,\s*uint160\s+amount\s*,\s*uint48\s+expiration\s*\)\s*external\s*;/g,
  /\bfunction\s+transferFrom\s*\(\s*address\s+from\s*,\s*address\s+to\s*,\s*uint160\s+amount\s*,\s*address\s+token\s*\)\s*external\s*;/g,
]);
const HOOKEMON_ISSUANCE_ERC20_DECLARATIONS = Object.freeze([
  /\bfunction\s+approve\s*\(\s*address\s+spender\s*,\s*uint256\s+amount\s*\)\s*external\s+returns\s*\(\s*bool\s*\)\s*\{/g,
  /\bfunction\s+transfer\s*\(\s*address\s+recipient\s*,\s*uint256\s+amount\s*\)\s*external\s+returns\s*\(\s*bool\s*\)\s*\{/g,
  /\bfunction\s+transferFrom\s*\(\s*address\s+owner\s*,\s*address\s+recipient\s*,\s*uint256\s+amount\s*\)\s*external\s+returns\s*\(\s*bool\s*\)\s*\{/g,
]);
const HOOKEMON_ISSUANCE_ERC20_DECLARATION_INVENTORY = Object.freeze([
  'function approve(address spender, uint256 amount) external returns (bool) {',
  'function transfer(address recipient, uint256 amount) external returns (bool) {',
  'function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {',
]);

export const marketRoutingAllowedCallSites = Object.freeze([
  CANONICAL_PEGGED_TRANSFER_CALL,
  ROUTE_EXECUTOR_CALLBACK_DEPOSIT_CALL,
  PEGGED_CURRENCY_BALANCE_STATICCALL,
  PEGGED_CURRENCY_TRANSFER_CALL,
]);

function blankAllowedCallSites(productionSource, allowedCallPatterns) {
  return allowedCallPatterns.reduce(
    (blanked, pattern) => blanked.replace(pattern, (match) => match.replace(/[^\n\r]/g, ' ')),
    productionSource,
  );
}

function normalizedStatements(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[0].replace(/\s+/g, ''));
}

function requireExactStatementSet(source, pattern, expected) {
  const actual = normalizedStatements(source, pattern).sort();
  const normalizedExpected = expected.map((statement) => statement.replace(/\s+/g, '')).sort();
  if (canonicalJson(actual) !== canonicalJson(normalizedExpected)) {
    throw new Error('market-routing source surface has undocumented Hookemon call sites');
  }
}

function validateHookemonIssuanceDeclarationInventory(productionSource) {
  const lexicalSource = lexSolidityAuthoritySurface(productionSource);
  for (let index = 0; index < HOOKEMON_ISSUANCE_ERC20_DECLARATIONS.length; index += 1) {
    requireExactStatementSet(
      lexicalSource,
      HOOKEMON_ISSUANCE_ERC20_DECLARATIONS[index],
      [HOOKEMON_ISSUANCE_ERC20_DECLARATION_INVENTORY[index]],
    );
  }
}

function validateHookemonCallInventory(productionSource) {
  requireExactStatementSet(
    productionSource,
    /\b_approveToken\s*\([^;{}]*\)\s*;/g,
    [
      '_approveToken(usdgToken, permit2, 0);',
      '_approveToken(hkmnToken, permit2, 0);',
      '_approveToken(usdgToken, permit2, usdgMax);',
      '_approveToken(hkmnToken, permit2, hkmnMax);',
      '_approveToken(usdgToken, permit2, 0);',
      '_approveToken(hkmnToken, permit2, 0);',
    ],
  );
  requireExactStatementSet(
    productionSource,
    /\b_tokenBalance\s*\([^;{}]*\)\s*;/g,
    [
      '_tokenBalance(Currency.unwrap(hkmn), address(this));',
      '_tokenBalance(hkmnToken, address(this));',
      '_tokenBalance(hkmnToken, address(this)) != 0) revert SeedResidualTransferFailed();',
    ],
  );
  requireExactStatementSet(productionSource, HOOKEMON_PERMIT2_TRANSFER_CALL, [
    'ILaunchPermit2(permit2).transferFrom(params.payer,address(this),uint160(usdgMax),Currency.unwrap(usdg));',
  ]);
  requireExactStatementSet(productionSource, HOOKEMON_PERMIT2_APPROVAL_CALL, [
    'permit.approve(usdgToken,positionManager,uint160(usdgMax),uint48(block.timestamp));',
    'permit.approve(hkmnToken,positionManager,uint160(hkmnMax),uint48(block.timestamp));',
    'permit.approve(usdgToken,positionManager,0,0);',
    'permit.approve(hkmnToken,positionManager,0,0);',
  ]);
  requireExactStatementSet(productionSource, HOOKEMON_RAW_APPROVE_CALL, [
    'token.call(abi.encodeWithSelector(bytes4(0x095ea7b3),spender,amount))',
  ]);
  requireExactStatementSet(productionSource, HOOKEMON_RAW_BALANCE_CALL, [
    'token.staticcall(abi.encodeWithSelector(bytes4(0x70a08231),account))',
  ]);
  requireExactStatementSet(productionSource, HOOKEMON_HKMN_DUST_TRANSFER_CALL, [
    'hkmnToken.call(abi.encodeWithSelector(bytes4(0xa9059cbb),_currentTreasury(),transferred))',
  ]);
  requireExactStatementSet(productionSource, HOOKEMON_GRAPH_CONFIGURATION_CALL, [
    'Currency.unwrap(hkmn).staticcall(abi.encodeCall(IGraphIssuedToken.validateGraphConfiguration,(address(this),Currency.unwrap(usdg),sqrtPriceX96,graphInitializer,graphExpectedDecimals)))',
  ]);
  requireExactStatementSet(productionSource, HOOKEMON_ISSUED_ALLOCATION_CALL, [
    'Currency.unwrap(hkmn).staticcall(abi.encodeCall(IGraphIssuedToken.validateIssuedAllocation,(address(this),Currency.unwrap(usdg),graphInitializer,graphExpectedDecimals)))',
  ]);
}

function validateAuthoritySurface(source, {
  label,
  allowedCallPatterns,
  allowedDeclarationPatterns = [],
}) {
  const productionSource = lexSolidityAuthoritySurface(source);
  // Every custody/route file declares its own narrowly scoped `I*Usdg` ERC-20 view of the
  // pegged token (IPegCycleUsdg, IPegCycleEscrowUsdg, IPegCycleRouteUsdg, ...); each such
  // interface's `transfer` declaration is exempt from the forbidden-name scan below because it
  // only ever backs the one canonical low-level transfer idiom, never an executable body.
  let declarationSource = productionSource.replace(
    /(\binterface\s+I[A-Za-z0-9_]*Usdg\s*\{)([^}]*)(\})/gs,
    (_interface, open, body, close) => `${open}${body.replace(
      /\bfunction\s+transfer\s*\(\s*address\s+recipient\s*,\s*uint256\s+amount\s*\)\s*external\s+returns\s*\(\s*bool\s*\)\s*;/g,
      ' ',
    )}${close}`,
  );
  declarationSource = blankAllowedCallSites(declarationSource, allowedDeclarationPatterns);
  const declarations = [...declarationSource.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
    .map((match) => match[1]);
  const forbiddenExact = new Set([
    'releaseProcessBudget', 'releaseProcess', 'fundPayout', 'execute', 'call', 'approve',
    'transfer', 'transferFrom', 'rescue', 'sweep', 'delegatecall', 'upgradeTo', 'upgradeToAndCall',
    'setAuthorizer', 'setVault', 'setRouteExecutor', 'setAdministrator', 'setAdmin', 'setSuccessor',
  ]);
  const authoritySource = blankAllowedCallSites(productionSource, allowedCallPatterns);
  if (
    declarations.some((name) => forbiddenExact.has(name))
    || declarations.some((name) => /^(?:set|change|update)(?:Authorizer|Vault|Route|Executor|Admin|Administrator)/.test(name))
    || /\.\s*(?:approve|transferFrom|execute|releaseProcessBudget|releaseProcess|fundPayout|rescue|sweep|upgradeTo|upgradeToAndCall)\s*(?:\{|\()/.test(authoritySource)
    || /\.\s*(?:call|delegatecall|staticcall|callcode)\s*(?:\{|\()/.test(authoritySource)
    || /(?:^|[^A-Za-z0-9_.])(?:call|delegatecall|staticcall|callcode)\s*\(/m.test(authoritySource)
    || /\bverbatim(?:_[0-9]+i_[0-9]+o)?\s*\(/.test(authoritySource)
    || /\bselfdestruct\s*\(/.test(authoritySource)
  ) throw new Error(`${label} source surface exposes forbidden authority`);
}

// Custody surfaces: strict forbidden-authority rules, no generic call/delegatecall/staticcall,
// no owner-mutable setters, no rescue/sweep/upgrade -- with exactly one documented exception,
// the canonical pegged-token transfer idiom above.
export function validateCustodySourceSurfaces(source) {
  validateAuthoritySurface(source, {
    label: 'custody',
    allowedCallPatterns: [CANONICAL_PEGGED_TRANSFER_CALL],
  });
}

// Market and routing surfaces: the same strict rules, plus the small, exact, documented
// allow-list of external-call patterns above -- and nothing else. No owner-mutable recipients,
// no arbitrary call targets, no selfdestruct, no delegatecall.
export function validateMarketRoutingSourceSurfaces(source, sourcePath) {
  const isHookemon = sourcePath === HOOKEMON_SOURCE_PATH;
  const isHookemonIssuance = sourcePath === HOOKEMON_ISSUANCE_SOURCE_PATH;
  const isHkmnToken = sourcePath === HKMN_TOKEN_SOURCE_PATH;
  const isLaunchErc20Target = isHookemonIssuance || isHkmnToken;
  const allowedCallPatterns = isHookemon
    ? [
        ...marketRoutingAllowedCallSites,
        HOOKEMON_PERMIT2_TRANSFER_CALL,
        HOOKEMON_PERMIT2_APPROVAL_CALL,
        HOOKEMON_RAW_APPROVE_CALL,
        HOOKEMON_RAW_BALANCE_CALL,
        HOOKEMON_HKMN_DUST_TRANSFER_CALL,
        HOOKEMON_GRAPH_CONFIGURATION_CALL,
        HOOKEMON_ISSUED_ALLOCATION_CALL,
      ]
    : marketRoutingAllowedCallSites;
  if (isHookemon) validateHookemonCallInventory(lexSolidityAuthoritySurface(source));
  if (isLaunchErc20Target) validateHookemonIssuanceDeclarationInventory(source);
  validateAuthoritySurface(source, {
    label: 'market-routing',
    allowedCallPatterns,
    allowedDeclarationPatterns: isHookemon
      ? HOOKEMON_PERMIT2_DECLARATIONS
      : isLaunchErc20Target ? HOOKEMON_ISSUANCE_ERC20_DECLARATIONS : [],
  });
}

function listProductionSoliditySources(projectRoot) {
  const sourceRoot = resolve(projectRoot, 'packages/contracts/src');
  const sources = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.sol')) {
        sources.push(relative(projectRoot, absolute).split(sep).join('/'));
      } else if (entry.isSymbolicLink()) {
        throw new Error('production Solidity source tree cannot contain symlinks');
      }
    }
  };
  visit(sourceRoot);
  return sources.sort();
}

function solidityImportSpecifiers(source) {
  const lexical = lexSolidityAuthoritySurface(source);
  const imports = [];
  for (const statement of lexical.matchAll(/\bimport\b[^;]*;/g)) {
    const raw = source.slice(statement.index, statement.index + statement[0].length);
    const specifiers = [...raw.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    if (specifiers.length !== 1) throw new Error('production Solidity import is malformed');
    imports.push(specifiers[0]);
  }
  return imports;
}

function validatePinnedDependencyImport(projectRoot, specifier, { prefix, libDir, label }) {
  const remainder = specifier.slice(prefix.length);
  if (
    remainder.length === 0
    || remainder.startsWith('/')
    || remainder.includes('\\')
    || remainder.includes('%')
    || remainder.split('/').includes('..')
  ) throw new Error(`pinned ${label} import path is invalid: ${specifier}`);

  const declaredRoot = resolve(projectRoot, libDir);
  const declaredTarget = resolve(declaredRoot, remainder);
  let pinnedRoot;
  let imported;
  try {
    pinnedRoot = realpathSync(declaredRoot);
    imported = realpathSync(declaredTarget);
  } catch {
    throw new Error(`pinned ${label} import path is invalid: ${specifier}`);
  }
  const importedType = lstatSync(declaredTarget);
  if (
    !imported.startsWith(`${pinnedRoot}${sep}`)
    || !importedType.isFile()
    || importedType.isSymbolicLink()
  ) throw new Error(`pinned ${label} import path is invalid: ${specifier}`);
}

function validatePinnedV4CoreImport(projectRoot, specifier) {
  validatePinnedDependencyImport(projectRoot, specifier, {
    prefix: '@uniswap/v4-core/',
    libDir: 'packages/contracts/lib/v4-core',
    label: 'v4-core',
  });
}

// The market-routing launch strategy also imports two additional pinned, submodule-vendored
// dependencies (see remappings.txt): the Uniswap liquidity launcher and the OpenZeppelin
// interfaces v4-core already vendors. Both are validated with the same containment rules as the
// v4-core import above, under their own dependency label.
const additionalPinnedDependencyImportPrefixes = Object.freeze([
  {
    prefix: '@uniswap/v4-periphery/',
    libDir: 'packages/contracts/lib/v4-periphery',
    label: 'v4-periphery',
  },
  {
    prefix: '@uniswap/liquidity-launcher/',
    libDir: 'packages/contracts/lib/liquidity-launcher',
    label: 'liquidity-launcher',
  },
  {
    prefix: '@openzeppelin/',
    libDir: 'packages/contracts/lib/v4-core/lib/openzeppelin-contracts',
    label: 'openzeppelin',
  },
]);

export function validateCandidateProductionSourceClosure({ projectRoot, candidatePaths }) {
  const candidateSources = candidatePaths
    .filter((path) => path.startsWith('packages/contracts/src/') && path.endsWith('.sol'))
    .sort();
  if (new Set(candidateSources).size !== candidateSources.length) {
    throw new Error('candidate production Solidity source set contains duplicates');
  }
  const treeSources = listProductionSoliditySources(projectRoot);
  if (canonicalJson(candidateSources) !== canonicalJson(treeSources)) {
    throw new Error('production Solidity source set mismatch');
  }

  const candidateSet = new Set(candidateSources);
  const sourceRoot = resolve(projectRoot, 'packages/contracts/src');
  for (const sourcePath of treeSources) {
    const absoluteSource = resolve(projectRoot, sourcePath);
    for (const specifier of solidityImportSpecifiers(readFileSync(absoluteSource, 'utf8'))) {
      if (specifier.startsWith('@uniswap/v4-core/')) {
        validatePinnedV4CoreImport(projectRoot, specifier);
        continue;
      }
      const additionalPinnedDependency = additionalPinnedDependencyImportPrefixes
        .find((entry) => specifier.startsWith(entry.prefix));
      if (additionalPinnedDependency) {
        validatePinnedDependencyImport(projectRoot, specifier, additionalPinnedDependency);
        continue;
      }
      if (!specifier.startsWith('.')) {
        throw new Error(`unsupported production Solidity import: ${specifier}`);
      }
      const imported = resolve(dirname(absoluteSource), specifier);
      const importedPath = relative(projectRoot, imported).split(sep).join('/');
      if (
        imported !== sourceRoot
        && !imported.startsWith(`${sourceRoot}${sep}`)
        || !candidateSet.has(importedPath)
      ) {
        throw new Error(`production Solidity import escapes candidate source closure: ${specifier}`);
      }
      const importedType = lstatSync(imported);
      if (!importedType.isFile() || importedType.isSymbolicLink()) {
        throw new Error(`production Solidity import is not a regular file: ${specifier}`);
      }
    }
  }
  return candidateSources;
}

// Defense in depth for the surface policy: every production Solidity source the candidate
// closure actually contains must have an explicit custody/market-routing classification above.
// A future contract added to packages/contracts/src without updating sourceSurfaceClasses fails
// loudly here instead of silently going unchecked by either validator.
export function validateSourceSurfacePolicyCoverage(candidateSources) {
  if (canonicalJson([...candidateSources].sort()) !== canonicalJson(Object.keys(sourceSurfaceClasses).sort())) {
    throw new Error('production Solidity source set is missing an explicit surface policy classification');
  }
}

const deterministicVaultIdentityPattern = /emit DeterministicVaultIdentity\(deployer: (0x[0-9a-f]{64}), salt: (0x[0-9a-f]{64}), initCodeHash: (0x[0-9a-f]{64}), concreteRuntimeCodeHash: (0x[0-9a-f]{64}), vault: (0x[0-9a-f]{64}), usdg: (0x[0-9a-f]{64}), authorizer: (0x[0-9a-f]{64}), routeExecutor: (0x[0-9a-f]{64}), bindingManifestDigest: (0x[0-9a-f]{64}), deploymentAuthority: (0x[0-9a-f]{64}), candidateManifestSha256: (0x[0-9a-f]{64})\)/g;

export function parseDeterministicVaultIdentity(output) {
  const matches = [...output.matchAll(deterministicVaultIdentityPattern)];
  if (matches.length !== 1) throw new Error('deterministic vault identity evidence is missing or duplicated');
  const address = (word) => `0x${word.slice(-40)}`;
  const [, deployer, salt, initcodeKeccak256, concreteRuntimeCodeKeccak256, expectedVault,
    usdg, authorizer, routeExecutor, bindingManifestDigest, deploymentAuthority,
    candidateManifestSha256] = matches[0];
  return {
    deployer: address(deployer),
    salt,
    initcodeKeccak256,
    concreteRuntimeCodeKeccak256,
    expectedVault: address(expectedVault),
    usdg: address(usdg),
    authorizer: address(authorizer),
    routeExecutor: address(routeExecutor),
    bindingManifestDigest,
    deploymentAuthority: address(deploymentAuthority),
    candidateManifestSha256,
  };
}

export function validateDeterministicVaultIdentity(manifest, output, expectedManifestSha256) {
  const candidate = Object.fromEntries(Object.entries(manifest.deterministicLocalVault ?? {})
    .filter(([key]) => key !== 'authority')
    .map(([key, value]) => [key, typeof value === 'string' ? value.toLowerCase() : value]));
  const { candidateManifestSha256, ...emitted } = parseDeterministicVaultIdentity(output);
  if (
    !/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? '')
    || candidateManifestSha256 !== `0x${expectedManifestSha256}`
    || canonicalJson(candidate) !== canonicalJson(emitted)
  ) {
    throw new Error('deterministic vault identity does not match the local candidate');
  }
}

export function validateHighRiskCompilerSurfaces(artifacts) {
  const byIdentity = new Map(
    artifacts.map((artifact) => [`${artifact.source}::${artifact.contract}`, artifact.methodIdentifiers]),
  );
  for (const [identity, expected] of Object.entries(expectedHighRiskMethodIdentifiers)) {
    if (canonicalJson(byIdentity.get(identity)) !== canonicalJson(expected)) {
      throw new Error(`high-risk compiler surface mismatch: ${identity}`);
    }
  }
}

export function validateReproducibilityReport({
  report,
  expectedManifestSha256,
  sourceCommitManifestSha256,
  toolchain,
  dependencyPins,
  manifest,
}) {
  if (
    report?.schema !== 'hookemon.phase1-local-reproducibility.v1'
    || report.authority !== 'LOCAL_BUILD_EVIDENCE_ONLY_NO_RELEASE_APPROVAL'
    || report.isolation?.sourceTrees !== 2
    || report.isolation?.sourceMethod !== 'INDEPENDENT_GIT_ARCHIVES_FROM_EXACT_COMMIT'
    || report.isolation?.independentOutputAndCacheDirectories !== true
    || report.isolation?.network !== 'OFFLINE'
    || report.isolation?.dependencyCopies !== 2
    || report.isolation?.dependencyMethod !== 'INDEPENDENT_CLEAN_COPIES_INSIDE_EACH_SOURCE_TREE'
    || report.reproducibility?.reproducible !== true
    || report.reproducibility?.buildCount !== 2
    || report.reproducibility?.artifactCount !== 32
    || !Array.isArray(report.artifacts)
    || report.artifacts.length !== 32
  ) throw new Error('local reproducibility report shape or authority is invalid');
  if (report.staticInputs?.candidateManifestSha256 !== expectedManifestSha256) {
    throw new Error('reproducibility report does not bind the trusted candidate manifest');
  }
  if (!/^[0-9a-f]{40}$/.test(report.sourceCommit ?? '')) {
    throw new Error('reproducibility report source commit is invalid');
  }
  if (sourceCommitManifestSha256 !== expectedManifestSha256) {
    throw new Error('reproducibility report source commit does not bind the trusted manifest');
  }
  const runnerFiles = manifest.files
    .filter((file) => file.path.startsWith('packages/runner/'))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedStaticInputs = {
    candidateManifestSha256: expectedManifestSha256,
    runnerSourceCount: 24,
    runnerSourceSetSha256: sha256(canonicalJson(runnerFiles)),
  };
  if (canonicalJson(report.staticInputs) !== canonicalJson(expectedStaticInputs)) {
    throw new Error('reproducibility report static inputs are invalid');
  }
  const artifactIdentities = report.artifacts.map((artifact) => `${artifact.source}::${artifact.contract}`);
  const invalidArtifact = report.artifacts.some((artifact) => {
    const keys = Object.keys(artifact).sort();
    const compilerGas = artifact.localCompilerGas;
    return canonicalJson(keys) !== canonicalJson(artifactFields)
      || !['abiSha256', 'eventSchemaSha256', 'initcodeSha256', 'runtimeSha256']
        .every((field) => /^[0-9a-f]{64}$/.test(artifact[field] ?? ''))
      || !Number.isSafeInteger(artifact.initcodeBytes)
      || artifact.initcodeBytes < 0
      || !Number.isSafeInteger(artifact.runtimeBytes)
      || artifact.runtimeBytes < 0
      || !artifact.methodIdentifiers
      || typeof artifact.methodIdentifiers !== 'object'
      || Array.isArray(artifact.methodIdentifiers)
      || Object.values(artifact.methodIdentifiers).some((selector) => !/^[0-9a-f]{8}$/.test(selector))
      || (compilerGas !== null && (
        canonicalJson(Object.keys(compilerGas).sort())
          !== canonicalJson(['codeDepositCost', 'executionCost', 'totalCost'])
        || !Object.values(compilerGas).every((value) => typeof value === 'string')
      ));
  });
  if (invalidArtifact || canonicalJson(artifactIdentities) !== canonicalJson(expectedArtifactIdentities)) {
    throw new Error('reproducibility report artifact source and contract set is invalid');
  }
  validateHighRiskCompilerSurfaces(report.artifacts);
  if (
    !/^[0-9a-f]{64}$/.test(report.reproducibility.artifactSetSha256 ?? '')
    || sha256(canonicalJson(report.artifacts)) !== report.reproducibility.artifactSetSha256
  ) throw new Error('reproducibility report artifact set digest is invalid');
  const expectedToolchain = {
    node: toolchain.node,
    forge: toolchain.forge,
    solc: toolchain.solc,
  };
  if (canonicalJson(report.toolchain) !== canonicalJson(expectedToolchain)) {
    throw new Error('reproducibility report toolchain does not match pinned local metadata');
  }
  const pins = dependencyPins.phase1Toolchain?.uniswap?.dependencyGitlinks ?? [];
  const expectedDependency = {
    path: 'packages/contracts/lib/v4-core',
    commit: pins.find((entry) => entry.path === 'packages/contracts/lib/v4-core')?.commit,
    nested: ['lib/solmate', 'lib/openzeppelin-contracts'].map((path) => ({
      path,
      commit: pins.find((entry) => entry.path === `packages/contracts/lib/v4-core/${path}`)?.commit,
    })),
  };
  if (canonicalJson(report.isolation.dependency) !== canonicalJson(expectedDependency)) {
    throw new Error('reproducibility report dependency identities do not match frozen pins');
  }
  const expectedAdditionalDependency = {
    path: 'packages/contracts/lib/liquidity-launcher',
    commit: pins.find((entry) => entry.path === 'packages/contracts/lib/liquidity-launcher')?.commit,
  };
  if (canonicalJson(report.isolation.additionalDependency) !== canonicalJson(expectedAdditionalDependency)) {
    throw new Error('reproducibility report additional dependency identity does not match frozen pins');
  }
  const expectedSecondaryDependency = {
    path: 'packages/contracts/lib/v4-periphery',
    commit: pins.find((entry) => entry.path === 'packages/contracts/lib/v4-periphery')?.commit,
    nested: [{
      path: 'packages/contracts/lib/v4-periphery/lib/permit2',
      commit: pins.find((entry) => entry.path === 'packages/contracts/lib/v4-periphery/lib/permit2')?.commit,
    }],
  };
  if (canonicalJson(report.isolation.secondaryDependency) !== canonicalJson(expectedSecondaryDependency)) {
    throw new Error('reproducibility report secondary dependency identity does not match frozen pins');
  }
  const expectedLocalGas = {
    authority: 'LOCAL_FOUNDRY_TEST_MEASUREMENT_ONLY',
    test: 'test/bindings/RobinhoodBindings.t.sol',
    passed: 7,
    contracts: [
      {
        source: 'src/bindings/RobinhoodBindings.sol',
        contract: 'ImmutableLaunchBinding',
        localDeploymentGas: 264921,
        observedDeploymentSizeBytes: 5502,
        officialLimit: 'INTEGRATION_PENDING',
        officialHeadroom: 'NOT_CLAIMED',
      },
      {
        source: 'src/bindings/RobinhoodBindings.sol',
        contract: 'PermanentPositionCustody',
        localDeploymentGas: 378891,
        observedDeploymentSizeBytes: 1813,
        officialLimit: 'INTEGRATION_PENDING',
        officialHeadroom: 'NOT_CLAIMED',
      },
    ],
  };
  const expectedProductionLimits = {
    status: 'INTEGRATION_PENDING',
    headroom: 'NOT_CLAIMED',
    reason: 'Official Robinhood deployment and gas limits are not bound by current local evidence.',
  };
  if (
    canonicalJson(report.localGas) !== canonicalJson(expectedLocalGas)
    || canonicalJson(report.productionLimits) !== canonicalJson(expectedProductionLimits)
  ) throw new Error('local gas evidence is not the exact narrow seven-test production-contract set');
}

export function buildForgeBase({ forgeRoot, contractsRoot, v4CorePath, liquidityLauncherPath, solcBinary }) {
  return [
    'test',
    '--offline',
    '--use',
    solcBinary,
    '--root',
    contractsRoot,
    '--config-path',
    resolve(contractsRoot, 'foundry.toml'),
    '--out',
    resolve(forgeRoot, 'out'),
    '--cache-path',
    resolve(forgeRoot, 'cache'),
    '--evm-version',
    'cancun',
    '--optimize',
    '--optimizer-runs',
    '20000',
    '-R',
    `@uniswap/v4-core/=${v4CorePath}/`,
    '-R',
    `solmate/=${resolve(v4CorePath, 'lib/solmate')}/`,
    '-R',
    `@openzeppelin/=${resolve(v4CorePath, 'lib/openzeppelin-contracts')}/`,
    '-R',
    `@uniswap/liquidity-launcher/=${liquidityLauncherPath}/`,
    '--skip',
    'FeeAccountingInvariant',
    '--skip',
    'RobinhoodV4PoolManager',
    '--skip',
    'market-fees',
    '-vv',
  ];
}

export function validateReadOnlyReleaseScript(source) {
  if (
    /\b(?:startBroadcast|stopBroadcast|broadcast|sign|deriveKey)\s*\(/.test(source)
    || /\bfunction\s+run\s*\(/.test(source)
    || /\b(?:fallback|receive)\s*\(/.test(source)
    || /\b(?:Vm|Script|assembly|selfdestruct)\b/.test(source)
    || /\bnew\s+[A-Za-z_]/.test(source)
    || /\.(?:call|delegatecall|staticcall)\s*[({]/.test(source)
  ) throw new Error('broadcast-capable release script is forbidden');

  const exposedFunctions = [];
  for (const declaration of source.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*([^;{]*)/gs)) {
    const modifiers = declaration[2];
    if (/\b(?:external|public)\b/.test(modifiers) && !/\b(?:view|pure)\b/.test(modifiers)) {
      throw new Error('release script exposes a state-changing entrypoint');
    }
    if (/\b(?:external|public)\b/.test(modifiers)) exposedFunctions.push(declaration[1]);
  }
  const expectedFunctions = ['computeCreate2Address', 'validate', 'verifyDeployedRuntime'];
  if (JSON.stringify(exposedFunctions.sort()) !== JSON.stringify(expectedFunctions)) {
    throw new Error('release script exposes an unexpected public surface');
  }
}

export function countPositiveInvariantResults(output) {
  return [
    ...output.matchAll(
      /^\[PASS\]\s+invariant_[A-Za-z0-9_]+\(\)\s+\(runs:\s*[1-9]\d*,\s*calls:\s*[1-9]\d*,/gm,
    ),
  ].length;
}

export const RELEASE_CHECK_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export function spawnReleaseCheckChild(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: RELEASE_CHECK_MAX_BUFFER_BYTES,
  });
}

export function validateReleaseCheckChildResult({
  check,
  result,
  forgeBinary,
  manifest,
  expectedManifestSha256,
}) {
  if (result.error) {
    const code = result.error.code ? ` ${result.error.code}` : '';
    throw new Error(`${check.id} child process failed${code}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const signal = result.signal ? ` (signal ${result.signal})` : '';
    throw new Error(
      `${check.id} child exited with status ${String(result.status)}${signal}\n${result.stderr ?? ''}`,
    );
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const count = Number(output.match(check.countPattern)?.[1]);
  const summaries = check.command === forgeBinary
    ? [...output.matchAll(/Suite result: (?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) skipped;/g)]
    : [];
  const summary = summaries.reduce((total, match) => ({
    passed: total.passed + Number(match[1]),
    failed: total.failed + Number(match[2]),
    skipped: total.skipped + Number(match[3]),
  }), { passed: 0, failed: 0, skipped: 0 });
  const invariantResultCount = countPositiveInvariantResults(output);
  if (check.bindsDeterministicVaultIdentity) {
    validateDeterministicVaultIdentity(manifest, output, expectedManifestSha256);
  }
  if (
    count !== check.expectedPasses
    || (
      check.expectedInvariantResults !== undefined
      && invariantResultCount !== check.expectedInvariantResults
    )
    || (check.command === forgeBinary && (
      summaries.length === 0
      || summary.passed !== check.expectedPasses
      || summary.failed !== 0
      || summary.skipped !== 0
    ))
  ) {
    throw new Error(`${check.id} failed or reported an unexpected pass count\n${output}`);
  }
  return output;
}

export function requireAbsoluteRegularFile(binary) {
  if (typeof binary !== 'string' || resolve(binary) !== binary) {
    throw new Error('executable path must be absolute');
  }
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('executable path must be a regular non-symlink file');
  }
  return binary;
}

// The system scratch root is fixed (not TMPDIR) so a hostile TMPDIR cannot move the Forge scratch
// tree into the repository; /tmp resolves to /private/tmp on macOS and stays /tmp on Linux.
const SYSTEM_SCRATCH_ROOT = realpathSync('/tmp');

export function withNonGitForgeRoot(repositoryRoot, operation, postCheck = () => {}) {
  const forgeRoot = mkdtempSync(resolve(SYSTEM_SCRATCH_ROOT, 'hookemon-p1-release-forge-'));
  try {
    const realRepositoryRoot = realpathSync(repositoryRoot);
    const realForgeRoot = realpathSync(forgeRoot);
    if (realForgeRoot.startsWith(`${realRepositoryRoot}/`)) {
      throw new Error('Forge scratch root is inside the repository');
    }
    const gitProbe = spawnSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], {
      cwd: realForgeRoot,
      encoding: 'utf8',
      env: {
        HOME: realForgeRoot,
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    if (gitProbe.status === 0) throw new Error('Forge scratch root is inside a Git worktree');
    return operation(realForgeRoot);
  } finally {
    try {
      postCheck();
    } finally {
      rmSync(forgeRoot, { recursive: true, force: true });
    }
  }
}

function runGit(v4CorePath, args, childEnv) {
  const result = spawnSync('git', ['-c', 'core.excludesfile=/dev/null', ...args], {
    cwd: v4CorePath,
    encoding: 'utf8',
    env: {
      ...childEnv,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.status !== 0) throw new Error(`unable to validate pinned v4-core dependency: ${result.stderr}`);
  return result.stdout.trim();
}

function manifestDigestAtCommit(sourceCommit, childEnv) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) {
    throw new Error('reproducibility report source commit is invalid');
  }
  const gitEnv = {
    ...childEnv,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const commitCheck = spawnSync('git', [
    '-c',
    'core.excludesfile=/dev/null',
    'cat-file',
    '-e',
    `${sourceCommit}^{commit}`,
  ], { cwd: root, encoding: 'utf8', env: gitEnv });
  if (commitCheck.status !== 0) {
    throw new Error('reproducibility report source commit is unavailable');
  }
  const result = spawnSync('git', [
    '-c',
    'core.excludesfile=/dev/null',
    'show',
    `${sourceCommit}:release/phase1/local-candidate.json`,
  ], {
    cwd: root,
    encoding: null,
    env: gitEnv,
  });
  if (result.status !== 0) throw new Error('reproducibility report source commit is unavailable');
  return sha256(result.stdout);
}

function validateV4Core(v4CorePath, dependencyPins, childEnv) {
  if (resolve(v4CorePath) !== v4CorePath) {
    throw new Error('HOOKEMON_V4_CORE_PATH must be absolute');
  }
  const stat = lstatSync(v4CorePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('HOOKEMON_V4_CORE_PATH must be a real directory');
  }
  const pins = dependencyPins.phase1Toolchain.uniswap.dependencyGitlinks;
  const repositories = [
    ['packages/contracts/lib/v4-core', v4CorePath],
    ['packages/contracts/lib/v4-core/lib/solmate', resolve(v4CorePath, 'lib/solmate')],
    ['packages/contracts/lib/v4-core/lib/openzeppelin-contracts', resolve(v4CorePath, 'lib/openzeppelin-contracts')],
  ];
  for (const [pinPath, repository] of repositories) {
    const expected = pins.find((entry) => entry.path === pinPath)?.commit;
    const actual = runGit(repository, ['rev-parse', 'HEAD'], childEnv);
    const status = runGit(repository, ['status', '--porcelain', '--untracked-files=all'], childEnv);
    if (!expected || actual !== expected) throw new Error(`pinned dependency mismatch: ${pinPath}`);
    if (status !== '') throw new Error(`pinned dependency is not clean: ${pinPath}`);
  }
}

// The market-routing launch strategy's second pinned dependency: same independent
// git-identity check as v4-core above, no nested submodule since CustomLaunchStrategy.sol only
// imports self-contained interfaces and types from the top-level liquidity-launcher source.
function validateLiquidityLauncher(liquidityLauncherPath, dependencyPins, childEnv) {
  if (resolve(liquidityLauncherPath) !== liquidityLauncherPath) {
    throw new Error('HOOKEMON_LIQUIDITY_LAUNCHER_PATH must be absolute');
  }
  const stat = lstatSync(liquidityLauncherPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('HOOKEMON_LIQUIDITY_LAUNCHER_PATH must be a real directory');
  }
  const pinPath = 'packages/contracts/lib/liquidity-launcher';
  const expected = dependencyPins.phase1Toolchain.uniswap.dependencyGitlinks
    .find((entry) => entry.path === pinPath)?.commit;
  const actual = runGit(liquidityLauncherPath, ['rev-parse', 'HEAD'], childEnv);
  const status = runGit(liquidityLauncherPath, ['status', '--porcelain', '--untracked-files=all'], childEnv);
  if (!expected || actual !== expected) throw new Error(`pinned dependency mismatch: ${pinPath}`);
  if (status !== '') throw new Error(`pinned dependency is not clean: ${pinPath}`);
}

function main() {
  const manifestBytes = readFileSync(resolve(root, 'release/phase1/local-candidate.json'));
  const manifest = JSON.parse(manifestBytes);
  const stop = JSON.parse(readFileSync(resolve(root, 'release/phase1/external-action-stop.json'), 'utf8'));
  const evidence = JSON.parse(readFileSync(resolve(root, 'release/phase1/local-evidence.json'), 'utf8'));
  const reproducibility = JSON.parse(
    readFileSync(resolve(root, 'release/phase1/local-reproducibility.json'), 'utf8'),
  );
  const toolchain = JSON.parse(readFileSync(resolve(root, 'release/phase1/local-toolchain.json'), 'utf8'));
  const dependencyPins = JSON.parse(readFileSync(resolve(root, 'product/dependency-pins.json'), 'utf8'));
  const expectedManifestSha256 = process.env.HOOKEMON_PHASE1_MANIFEST_SHA256;

  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? '')) {
    throw new Error('HOOKEMON_PHASE1_MANIFEST_SHA256 must be a caller-supplied SHA-256 digest');
  }
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error('local candidate manifest digest does not match the caller-supplied digest');
  }

const expectedExternalStatus = {
  programmablePreviousChainDocs: 'UNVERIFIED_FOR_ROBINHOOD_API_SHAPE_ONLY',
  programmableRobinhoodLaunch: 'INTEGRATION_PENDING',
  robinhoodPegCycleRoute: 'INTEGRATION_PENDING',
  solanaPolicyCustody: 'INTEGRATION_PENDING',
  mainnetCanary: 'SEPARATE_EXACT_ACTION_AUTHORIZATION_REQUIRED',
  productionReady: false,
};
if (
  manifest.schema !== 'hookemon.phase1-local-candidate.v2'
  || manifest.authority !== 'LOCAL_ONLY_NOT_RELEASE_APPROVAL'
  || manifest.phase !== 1
  || manifest.phaseTwo !== 'CLOSED_REQUIRES_FRESH_SPEC_AND_OWNER_APPROVAL'
  || manifest.requirementsRevision !== 56
  || manifest.architectureRevision !== 4
  || canonicalJson(manifest.externalStatus) !== canonicalJson(expectedExternalStatus)
  || canonicalJson(Object.keys(manifest.custodyRoles ?? {}).sort())
    !== canonicalJson(['cycleVaultAccount', 'operationsTrigger', 'policyAccount', 'returnAccount'])
  || manifest.custodyRoles.returnAccount !== manifest.custodyRoles.cycleVaultAccount
  || manifest.custodyRoles.operationsTrigger === manifest.custodyRoles.cycleVaultAccount
  || manifest.custodyRoles.operationsTrigger === manifest.custodyRoles.policyAccount
  || manifest.custodyRoles.cycleVaultAccount === manifest.custodyRoles.policyAccount
  || manifest.deterministicLocalVault?.authority !== 'EPHEMERAL_FOUNDRY_TEST_PLAN_ONLY'
  || !['deployer', 'salt', 'initcodeKeccak256', 'expectedVault', 'concreteRuntimeCodeKeccak256',
    'usdg', 'authorizer', 'routeExecutor', 'bindingManifestDigest']
    .concat(['deploymentAuthority'])
    .every((field) => typeof manifest.deterministicLocalVault?.[field] === 'string')
  || !['salt', 'initcodeKeccak256', 'concreteRuntimeCodeKeccak256', 'bindingManifestDigest']
    .every((field) => /^0x[0-9a-f]{64}$/.test(manifest.deterministicLocalVault[field]))
  || !['deployer', 'expectedVault', 'usdg', 'authorizer', 'routeExecutor', 'deploymentAuthority']
    .every((field) => /^0x[0-9a-fA-F]{40}$/.test(manifest.deterministicLocalVault[field]))
) throw new Error('local candidate authority or phase boundary is invalid');
if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error('local candidate file set is empty');
}
const paths = new Set();
for (const file of manifest.files) {
  if (
    !file
    || typeof file.path !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file.path)
    || file.path.includes('..')
    || !/^[0-9a-f]{64}$/.test(file.sha256)
    || paths.has(file.path)
  ) throw new Error('local candidate file record is invalid or duplicate');
  paths.add(file.path);
  const resolved = resolve(root, file.path);
  const fileType = lstatSync(resolved);
  const realFile = realpathSync(resolved);
  if (
    !fileType.isFile()
    || fileType.isSymbolicLink()
    || (!realFile.startsWith(`${realRoot}/`) && realFile !== realRoot)
  ) throw new Error(`local candidate path escapes the workspace or is not a regular file: ${file.path}`);
  const actual = sha256(readFileSync(realFile));
  if (actual !== file.sha256) throw new Error(`local candidate hash mismatch: ${file.path}`);
}
if (
  paths.size !== requiredCandidatePaths.length
  || requiredCandidatePaths.some((path) => !paths.has(path))
) throw new Error('local candidate does not contain the exact required file set');

const candidateProductionSources = validateCandidateProductionSourceClosure({
  projectRoot: root,
  candidatePaths: requiredCandidatePaths,
});
validateSourceSurfacePolicyCoverage(candidateProductionSources);
validateCustodySourceSurfaces(custodySourcePaths
  .map((path) => readFileSync(resolve(root, path), 'utf8'))
  .join('\n'));
for (const path of marketRoutingSourcePaths) {
  validateMarketRoutingSourceSurfaces(readFileSync(resolve(root, path), 'utf8'), path);
}

const stoppedActions = [
  'accessSecrets',
  'deploy',
  'sign',
  'broadcast',
  'spend',
  'publish',
  'mutateProvider',
  'initialize',
  'seedLiquidity',
  'runLiveCanary',
  'claimProductionReadiness',
];
if (
  stop.schema !== 'hookemon.phase1-external-action-stop.v1'
  || stop.authority !== 'POLICY_ONLY_DENY_UNLESS_SEPARATELY_OWNER_AUTHORIZED'
  || stop.enforcement !== 'POLICY_ONLY_NO_RUNTIME_EXTERNAL_ACTION_INTERPOSITION'
  || Object.keys(stop.actions).length !== stoppedActions.length
  || stoppedActions.some((action) => stop.actions[action] !== false)
) throw new Error('external action stop record is invalid');
const expectedChecks = [
  { id: 'holder-settlement-solidity', expectedPasses: 7 },
  { id: 'canonical-merkle-cross-language', expectedPasses: 4 },
  { id: 'distribution-runner', expectedPasses: 16 },
  { id: 'phase-one-local-loop', expectedPasses: 1 },
  { id: 'phase-one-release-invariants', expectedPasses: 10 },
  { id: 'cycle-custody-security', expectedPasses: 52 },
];
const expectedReproducibilityEvidence = {
  report: 'release/phase1/local-reproducibility.json',
  expectedBuilds: 2,
  expectedArtifacts: 32,
  expectedLocalGasTests: 7,
  productionLimits: 'INTEGRATION_PENDING',
  officialHeadroom: 'NOT_CLAIMED',
};
if (
  evidence.schema !== 'hookemon.phase1-local-evidence.v1'
  || evidence.authority !== 'LOCAL_FIXTURE_AND_OFFLINE_TESTS_ONLY'
  || !Array.isArray(evidence.checks)
  || JSON.stringify(evidence.checks) !== JSON.stringify(expectedChecks)
  || canonicalJson(evidence.reproducibility) !== canonicalJson(expectedReproducibilityEvidence)
  || !Array.isArray(evidence.unresolvedProductionEvidence)
  || evidence.unresolvedProductionEvidence.length === 0
) throw new Error('local evidence record is invalid');

validateReadOnlyReleaseScript(readFileSync(
  resolve(root, 'packages/contracts/script/release/PhaseOneReleasePlan.sol'),
  'utf8',
));

if (
  toolchain.schema !== 'hookemon.phase1-local-toolchain.v1'
  || toolchain.authority !== 'LOCAL_EXECUTABLE_BYTES_ONLY'
  || ![toolchain.node, toolchain.forge, toolchain.solc].every((tool) => (
    tool && typeof tool.version === 'string' && /^[0-9a-f]{64}$/.test(tool.sha256)
  ))
  || typeof toolchain.forge.commit !== 'string'
) throw new Error('local toolchain metadata is invalid');
if (
  toolchain.node.version.replace(/^v/, '') !== dependencyPins.controlRuntime?.node
  || toolchain.forge.version !== dependencyPins.phase1Toolchain?.foundry?.version
  || toolchain.forge.commit !== dependencyPins.phase1Toolchain?.foundry?.commit
  || !toolchain.solc.version.startsWith(`${dependencyPins.phase1Toolchain?.solidity?.solcVersion}+`)
) throw new Error('local toolchain metadata does not match the frozen dependency pins');

const nodeBinary = process.env.HOOKEMON_NODE_BINARY;
const forgeBinary = process.env.HOOKEMON_FORGE_BINARY;
const solcBinary = process.env.HOOKEMON_SOLC_BINARY;
if (!nodeBinary || !forgeBinary || !solcBinary) {
  throw new Error('HOOKEMON_NODE_BINARY, HOOKEMON_FORGE_BINARY, and HOOKEMON_SOLC_BINARY are required');
}
const childEnv = Object.freeze({
  HOME: root,
  PATH: '/usr/bin:/bin',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  OPENSSL_CONF: '/dev/null',
  NO_COLOR: '1',
  FOUNDRY_OFFLINE: 'true',
  HOOKEMON_NODE_BINARY: nodeBinary,
});
function validateBinary(label, binary, expected, versionIsExpected) {
  const validatedBinary = requireAbsoluteRegularFile(binary);
  if (sha256(readFileSync(validatedBinary)) !== expected.sha256) {
    throw new Error(`${label} binary does not match pinned SHA-256 metadata`);
  }
  const result = spawnSync(validatedBinary, ['--version'], {
    cwd: root,
    encoding: 'utf8',
    env: childEnv,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 || !versionIsExpected(output)) {
    throw new Error(`${label} binary does not match pinned version metadata`);
  }
}
validateBinary('Node', nodeBinary, toolchain.node, (output) => output.trim() === toolchain.node.version);
validateBinary('Forge', forgeBinary, toolchain.forge, (output) => (
  output.includes(`forge Version: ${toolchain.forge.version}`)
  && output.includes(`Commit SHA: ${toolchain.forge.commit}`)
));
validateBinary('solc', solcBinary, toolchain.solc, (output) => output.includes(`Version: ${toolchain.solc.version}`));

validateReproducibilityReport({
  report: reproducibility,
  expectedManifestSha256,
  sourceCommitManifestSha256: manifestDigestAtCommit(reproducibility.sourceCommit, childEnv),
  toolchain,
  dependencyPins,
  manifest,
});

const v4CorePath = process.env.HOOKEMON_V4_CORE_PATH;
const liquidityLauncherPath = process.env.HOOKEMON_LIQUIDITY_LAUNCHER_PATH;
if (!v4CorePath) throw new Error('HOOKEMON_V4_CORE_PATH is required');
if (!liquidityLauncherPath) throw new Error('HOOKEMON_LIQUIDITY_LAUNCHER_PATH is required');
validateV4Core(v4CorePath, dependencyPins, childEnv);
validateLiquidityLauncher(liquidityLauncherPath, dependencyPins, childEnv);
withNonGitForgeRoot(root, (forgeRoot) => {
  const contractsRoot = resolve(root, 'packages/contracts');
  const forgeTmp = resolve(forgeRoot, 'tmp');
  mkdirSync(forgeTmp, { mode: 0o700 });
  const forgeBase = buildForgeBase({
    forgeRoot,
    contractsRoot,
    v4CorePath,
    liquidityLauncherPath,
    solcBinary,
  });
  const checks = [
    {
      ...expectedChecks[0],
      command: forgeBinary,
      args: [...forgeBase, '--match-contract', '(CanonicalMerkleSumTest|HolderSettlementTest)'],
      countPattern: /Ran 2 test suites[\s\S]*?\((\d+) total tests\)/,
    },
    {
      ...expectedChecks[1],
      command: nodeBinary,
      args: ['--test', 'packages/contracts/test-js/payout/canonical-merkle-sum.test.mjs'],
      countPattern: /ℹ pass (\d+)/,
    },
    {
      ...expectedChecks[2],
      command: nodeBinary,
      args: [
        '--test',
        'packages/runner/test/distribution/holder-candidate.test.mjs',
        'packages/runner/test/distribution/manifest.test.mjs',
        'packages/runner/test/distribution/reconcile.test.mjs',
      ],
      countPattern: /ℹ pass (\d+)/,
    },
    {
      ...expectedChecks[3],
      command: forgeBinary,
      args: [
        ...forgeBase,
        '--ffi',
        '--match-path',
        'test/integration/PhaseOneLocalLoop.t.sol',
      ],
      countPattern: /Ran 1 test suite[\s\S]*?\((\d+) total tests\)/,
    },
    {
      ...expectedChecks[4],
      expectedInvariantResults: 9,
      bindsDeterministicVaultIdentity: true,
      command: forgeBinary,
      args: [
        ...forgeBase,
        '--match-path',
        'test/invariant/PhaseOneReleaseInvariant.t.sol',
        '-vvvv',
      ],
      countPattern: /Ran 1 test suite[\s\S]*?\((\d+) total tests\)/,
    },
    {
      ...expectedChecks[5],
      command: nodeBinary,
      args: ['--test', 'packages/runner/test/cycle/security.test.mjs'],
      countPattern: /ℹ pass (\d+)/,
    },
  ];
  for (const check of checks) {
    const result = spawnReleaseCheckChild(check.command, check.args, {
      cwd: check.command === forgeBinary ? contractsRoot : root,
      env: {
        ...childEnv,
        HOME: check.command === forgeBinary ? forgeRoot : root,
        TMPDIR: check.command === forgeBinary ? forgeTmp : childEnv.TMPDIR,
        HOOKEMON_PHASE1_LOOP_ADAPTER: resolve(
          root,
          'packages/runner/test/integration/phase-one-local-loop-adapter.mjs',
        ),
        HOOKEMON_CANDIDATE_MANIFEST_SHA256: `0x${expectedManifestSha256}`,
      },
    });
    validateReleaseCheckChildResult({
      check,
      result,
      forgeBinary,
      manifest,
      expectedManifestSha256,
    });
  }
}, () => {
  validateV4Core(v4CorePath, dependencyPins, childEnv);
  validateLiquidityLauncher(liquidityLauncherPath, dependencyPins, childEnv);
});

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  authority: manifest.authority,
  files: manifest.files.length,
  checks: expectedChecks.length,
  externalActionPolicy: stop.authority,
  phaseTwo: manifest.phaseTwo,
})}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
