import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';

const contractsRoot = resolve(import.meta.dirname, '../..');

function inspect(field) {
  const forge = process.env.FORGE_BIN ?? 'forge';
  const args = ['inspect', 'PegCycleRouteExecutor', field, '--root', contractsRoot, '--json'];
  if (process.env.SOLC_BIN) args.push('--use', process.env.SOLC_BIN);
  const result = spawnSync(forge, args, { cwd: contractsRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

// Exactly the immutable getters plus the one vault-only mutating entry point declared in
// PegCycleRouteExecutor.sol — no owner, setter, generic call, rescue, or sweep selector exists.
const expectedSignatures = [
  'depositCallbackSelector()',
  'depositTarget()',
  'executeOutbound(bytes32,address,uint256,address,bytes)',
  'usdg()',
  'vault()',
].sort();

test('PegCycleRouteExecutor compiler surface exposes only the typed route executor ABI', () => {
  const methodIdentifiers = JSON.parse(inspect('methodIdentifiers'));
  assert.deepEqual(Object.keys(methodIdentifiers).sort(), expectedSignatures);
  const selectors = Object.values(methodIdentifiers);
  assert.equal(selectors.every((selector) => /^[0-9a-f]{8}$/.test(selector)), true);
  assert.equal(new Set(selectors).size, selectors.length, 'public ABI contains a selector collision');
});

test('PegCycleRouteExecutor runtime stays below the EIP-170 limit', () => {
  const bytecode = inspect('deployedBytecode');
  assert.match(bytecode, /^0x(?:[0-9a-f]{2})+$/);
  const runtimeBytes = (bytecode.length - 2) / 2;
  assert.ok(runtimeBytes <= 24_576, `runtime is ${runtimeBytes} bytes`);
});
