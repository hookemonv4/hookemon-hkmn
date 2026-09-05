import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';

const contractsRoot = resolve(import.meta.dirname, '../..');

function inspect(field) {
  const forge = process.env.FORGE_BIN ?? 'forge';
  const args = ['inspect', 'PegCycleVault', field, '--root', contractsRoot, '--json'];
  if (process.env.SOLC_BIN) args.push('--use', process.env.SOLC_BIN);
  const result = spawnSync(forge, args, { cwd: contractsRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

const expectedSignatures = [
  'REQUIREMENTS_REVISION()',
  'authorizeFunding((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256))',
  'authorizeFundingAfterFailure((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256),bytes32,bytes32)',
  'authorizePayout((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256),bytes,bytes)',
  'authorizer()',
  'bindHook(address)',
  'bindingManifestDigest()',
  'cancelExpiredFundingAuthorization(bytes32)',
  'computeCycleEscrow(bytes32)',
  'confirmFunding(bytes32,uint256)',
  'consumeFundingAuthorization(bytes32,address)',
  'consumePayoutAuthorization((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))',
  'cycleEscrows(bytes32)',
  'cycleLifecycles(bytes32)',
  'deploymentAuthority()',
  'executeOutbound(bytes32,bytes)',
  'failedCycleSuccessors(bytes32)',
  'failureReceiptDigests(bytes32)',
  'hook()',
  'isCycleConsumed(bytes32)',
  'isNonceConsumed(uint256)',
  'isPayoutIdConsumed(bytes32)',
  'isReturnReceiptDigestConsumed(bytes32)',
  'lifecycle()',
  'payoutAuthorizationDigest()',
  'readActiveAuthorization()',
  'readCommittedPayoutBinding(bytes32)',
  'readPendingAuthorization()',
  'recordDegradedReturn(bytes32,bytes32,bool)',
  'recordTerminalFailure(bytes32,bytes32)',
  'recoveryPredecessors(bytes32)',
  'renewFundingAuthorizationDeadline((uint32,uint256,bytes32,address,address,address,address,uint256,bytes32,bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint64,uint256))',
  'renewPayoutAuthorizationDeadline((uint32,uint256,bytes32,address,address,address,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes32,uint64,uint256))',
  'routeExecutor()',
  'terminalCycleId()',
  'terminalFailureReceiptDigest()',
  'usdg()',
].sort();

test('PegCycleVault compiler surface matches the exact coordinator ABI', () => {
  const methodIdentifiers = JSON.parse(inspect('methodIdentifiers'));
  assert.deepEqual(Object.keys(methodIdentifiers).sort(), expectedSignatures);
  const selectors = Object.values(methodIdentifiers);
  assert.equal(selectors.every((selector) => /^[0-9a-f]{8}$/.test(selector)), true);
  assert.equal(new Set(selectors).size, selectors.length, 'public ABI contains a selector collision');
});

test('PegCycleVault runtime stays below the EIP-170 limit', () => {
  const rawBytecode = inspect('deployedBytecode');
  // PegCycleVault DELEGATECALLs into two `external` libraries
  // (FundingAuthorizationValidation, PayoutDistributionSignatures) precisely so their bytecode is
  // deployed separately and does not count against the vault's own EIP-170 budget. Solidity
  // therefore leaves each call site as an unlinked `__$<34 hex chars>$__` placeholder (exactly 40
  // hex characters -- the same byte width as a real address) until link time; this suite only
  // inspects the compiled artifact, so it never links. Swap each placeholder for a dummy 20-byte
  // address before validating hex format and measuring runtime size: this keeps the length
  // arithmetic exact while still asserting the rest of the bytecode is valid hex.
  const linkPlaceholder = /__\$[0-9a-f]{34}\$__/g;
  const bytecode = rawBytecode.replace(linkPlaceholder, 'f'.repeat(40));
  assert.match(bytecode, /^0x(?:[0-9a-f]{2})+$/);
  const runtimeBytes = (bytecode.length - 2) / 2;
  assert.ok(runtimeBytes <= 24_576, `runtime is ${runtimeBytes} bytes`);
});
