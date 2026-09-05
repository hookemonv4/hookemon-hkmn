// Exact-parameter encoding tests for every typed contract-call builder in
// src/hook-contract-client.mjs.
//
// `test/fixtures/hook-contract-client/expected-calldata.json` records calldata independently
// computed via Foundry's `cast calldata`/`cast sig` (a completely separate tool from viem) from
// the canonical Solidity signatures in packages/contracts/src/process/IPegCycleVault.sol /
// PegCycleVault.sol / ProcessBudget.sol / PayoutCommitment.sol. Comparing byte-for-byte against
// that fixture (not merely round-tripping through this module's own decoder) is what actually
// catches a struct field-order transposition bug: many of these structs have several adjacent
// same-type fields (e.g. five consecutive uint256 gas/minimum-receive fields in
// FundingAuthorization), so a swapped pair would still decode successfully — it just wouldn't
// match what the real deployed contract expects. See the fixture's own `note` field for how to
// regenerate it if the source interfaces ever change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { decodeFunctionData, encodeFunctionData, isHex } from 'viem';

import * as hookContractClient from '../src/hook-contract-client.mjs';

const {
  PEG_CYCLE_VAULT_ABI,
  HOOK_ABI,
  CYCLE_LIFECYCLE,
  buildAuthorizeFundingCall,
  buildAuthorizeFundingAfterFailureCall,
  buildCancelExpiredFundingAuthorizationCall,
  buildRenewFundingAuthorizationDeadlineCall,
  buildExecuteOutboundCall,
  buildAuthorizePayoutCall,
  buildRenewPayoutAuthorizationDeadlineCall,
  buildRecordTerminalFailureCall,
  buildRecordDegradedReturnCall,
  buildClaimProcessCall,
  buildOpenPegCycleCall,
  buildFundPayoutFromPegCycleCall,
  buildConsumePayoutAuthorizationCall,
} = hookContractClient;

const fixturePath = fileURLToPath(new URL('./fixtures/hook-contract-client/expected-calldata.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const { sample, expectedCalldata, expectedViewSelectors } = fixture;

// Fixture struct amounts are canonical decimal strings (repo convention); this module's ABI
// takes real bigints, matching every other typed call in the codebase.
function toFundingAuthorization(raw) {
  return {
    ...raw,
    chainId: BigInt(raw.chainId),
    amount: BigInt(raw.amount),
    minimumRobinhoodReceive: BigInt(raw.minimumRobinhoodReceive),
    minimumSolanaReceive: BigInt(raw.minimumSolanaReceive),
    minimumReturnUsdg: BigInt(raw.minimumReturnUsdg),
    robinhoodNativeGasCap: BigInt(raw.robinhoodNativeGasCap),
    solanaNativeGasCap: BigInt(raw.solanaNativeGasCap),
    expiresAt: BigInt(raw.expiresAt),
    nonce: BigInt(raw.nonce),
  };
}
function toPayoutAuthorization(raw) {
  return {
    ...raw,
    chainId: BigInt(raw.chainId),
    rootSum: BigInt(raw.rootSum),
    expiresAt: BigInt(raw.expiresAt),
    nonce: BigInt(raw.nonce),
  };
}

const fundingAuthorization = toFundingAuthorization(fixture.fundingAuthorization);
const payoutAuthorization = toPayoutAuthorization(fixture.payoutAuthorization);

test('buildAuthorizeFundingCall matches an independently-computed cast calldata vector', () => {
  const call = buildAuthorizeFundingCall(sample.vault, fundingAuthorization);
  assert.equal(call.to, sample.vault);
  assert.equal(call.functionName, 'authorizeFunding');
  assert.equal(call.data, expectedCalldata.authorizeFunding);
});

test('buildAuthorizeFundingAfterFailureCall matches an independently-computed cast calldata vector', () => {
  const call = buildAuthorizeFundingAfterFailureCall(
    sample.vault, fundingAuthorization, sample.failedCycleId, sample.failureReceiptDigest,
  );
  assert.equal(call.data, expectedCalldata.authorizeFundingAfterFailure);
});

test('buildCancelExpiredFundingAuthorizationCall matches an independently-computed cast calldata vector', () => {
  const call = buildCancelExpiredFundingAuthorizationCall(sample.vault, sample.cycleId);
  assert.equal(call.data, expectedCalldata.cancelExpiredFundingAuthorization);
});

test('buildRenewFundingAuthorizationDeadlineCall matches an independently-computed cast calldata vector', () => {
  const call = buildRenewFundingAuthorizationDeadlineCall(sample.vault, fundingAuthorization);
  assert.equal(call.data, expectedCalldata.renewFundingAuthorizationDeadline);
});

test('buildExecuteOutboundCall matches an independently-computed cast calldata vector', () => {
  const call = buildExecuteOutboundCall(sample.vault, sample.cycleId, sample.routeData);
  assert.equal(call.data, expectedCalldata.executeOutbound);
});

test('buildAuthorizePayoutCall matches an independently-computed cast calldata vector', () => {
  const call = buildAuthorizePayoutCall(sample.vault, payoutAuthorization, sample.distributionSignature, sample.verifierSignature);
  assert.equal(call.data, expectedCalldata.authorizePayout);
});

test('buildAuthorizePayoutCall rejects a malformed signature rather than encoding a bad call', () => {
  assert.throws(
    () => buildAuthorizePayoutCall(sample.vault, payoutAuthorization, 'not-hex', sample.verifierSignature),
    /distributionSignature/,
  );
  assert.throws(
    () => buildAuthorizePayoutCall(sample.vault, payoutAuthorization, sample.distributionSignature, '0xabc'),
    /verifierSignature/,
  );
});

test('buildRenewPayoutAuthorizationDeadlineCall matches an independently-computed cast calldata vector', () => {
  const call = buildRenewPayoutAuthorizationDeadlineCall(sample.vault, payoutAuthorization);
  assert.equal(call.data, expectedCalldata.renewPayoutAuthorizationDeadline);
});

test('buildRecordTerminalFailureCall matches an independently-computed cast calldata vector', () => {
  const call = buildRecordTerminalFailureCall(sample.vault, sample.cycleId, sample.terminalFailureReceiptDigest);
  assert.equal(call.data, expectedCalldata.recordTerminalFailure);
});

test('buildRecordDegradedReturnCall(acceptDegraded=true) matches an independently-computed cast calldata vector', () => {
  const call = buildRecordDegradedReturnCall(sample.vault, sample.cycleId, sample.degradedReceiptDigest, true);
  assert.equal(call.data, expectedCalldata.recordDegradedReturnTrue);
});

test('buildRecordDegradedReturnCall(acceptDegraded=false) matches an independently-computed cast calldata vector', () => {
  const call = buildRecordDegradedReturnCall(sample.vault, sample.cycleId, sample.degradedReceiptDigest, false);
  assert.equal(call.data, expectedCalldata.recordDegradedReturnFalse);
});

test('buildRecordDegradedReturnCall rejects a non-boolean acceptDegraded (never silently coerced)', () => {
  assert.throws(() => buildRecordDegradedReturnCall(sample.vault, sample.cycleId, sample.degradedReceiptDigest, 1), /boolean/);
  assert.throws(() => buildRecordDegradedReturnCall(sample.vault, sample.cycleId, sample.degradedReceiptDigest, 'true'), /boolean/);
});

test('buildClaimProcessCall encodes the Operations process-claim interface', () => {
  const call = buildClaimProcessCall(sample.hook, sample.cycleId, '25000000', sample.operationsTrigger);
  assert.equal(call.to, sample.hook);
  assert.equal(call.functionName, 'claimProcess');
  assert.equal(
    call.data,
    '0xfea0767c2222222222222222222222222222222222222222222222222222222222222222'
      + '00000000000000000000000000000000000000000000000000000000017d7840'
      + '0000000000000000000000006666666666666666666666666666666666666666',
  );
});

test('buildClaimProcessCall rejects an empty cycle id or nonpositive amount', () => {
  assert.throws(
    () => buildClaimProcessCall(sample.hook, `0x${'0'.repeat(64)}`, '1', sample.operationsTrigger),
    /cycleId/,
  );
  assert.throws(
    () => buildClaimProcessCall(sample.hook, sample.cycleId, '0', sample.operationsTrigger),
    /amountAtomicUsdg/,
  );
});

test('buildOpenPegCycleCall (hook entrypoint) matches an independently-computed cast calldata vector', () => {
  const call = buildOpenPegCycleCall(sample.hook, sample.cycleId);
  assert.equal(call.to, sample.hook);
  assert.equal(call.data, expectedCalldata.openPegCycle);
});

test('buildFundPayoutFromPegCycleCall (hook entrypoint for consumePayoutAuthorization) matches an independently-computed cast calldata vector', () => {
  const call = buildFundPayoutFromPegCycleCall(sample.hook, payoutAuthorization);
  assert.equal(call.data, expectedCalldata.fundPayoutFromPegCycle);
});

test('buildConsumePayoutAuthorizationCall is the documented alias for buildFundPayoutFromPegCycleCall', () => {
  assert.equal(buildConsumePayoutAuthorizationCall, buildFundPayoutFromPegCycleCall);
  const call = buildConsumePayoutAuthorizationCall(sample.hook, payoutAuthorization);
  assert.equal(call.data, expectedCalldata.fundPayoutFromPegCycle);
});

test('every build*Call is pure ABI encoding: decodeFunctionData round-trips to the exact struct given', () => {
  const call = buildAuthorizeFundingCall(sample.vault, fundingAuthorization);
  const decoded = decodeFunctionData({ abi: PEG_CYCLE_VAULT_ABI, data: call.data });
  assert.equal(decoded.functionName, 'authorizeFunding');
  // decodeFunctionData EIP-55-checksums addresses on the way out; compare case-insensitively.
  const [decodedAuth] = decoded.args;
  for (const key of Object.keys(fundingAuthorization)) {
    const expectedValue = fundingAuthorization[key];
    const actualValue = decodedAuth[key];
    if (typeof expectedValue === 'string' && expectedValue.startsWith('0x') && expectedValue.length === 42) {
      assert.equal(actualValue.toLowerCase(), expectedValue.toLowerCase(), `${key} mismatch`);
    } else {
      assert.equal(actualValue, expectedValue, `${key} mismatch`);
    }
  }
});

test('every build*Call rejects a malformed target address rather than encoding a bad call', () => {
  assert.throws(() => buildAuthorizeFundingCall('not-an-address', fundingAuthorization), /valid EVM address/);
  assert.throws(() => buildOpenPegCycleCall('0x1234', sample.cycleId), /valid EVM address/);
});

test('view-function selectors match an independently-computed cast sig for every read', () => {
  const abiByName = Object.fromEntries(
    [...PEG_CYCLE_VAULT_ABI, ...HOOK_ABI]
      .filter((item) => item.type === 'function' && item.stateMutability === 'view')
      .map((item) => [item.name, item]),
  );
  for (const [name, expectedSelector] of Object.entries(expectedViewSelectors)) {
    const abiItem = abiByName[name];
    assert.ok(abiItem, `${name} is missing from the ABI`);
    const dummyArgs = abiItem.inputs.map((input) => (
      input.type === 'bytes32' ? sample.cycleId
        : input.type === 'uint256' ? 1n
          : (() => { throw new Error(`add a dummy value for input type ${input.type}`); })()
    ));
    const abi = PEG_CYCLE_VAULT_ABI.includes(abiItem) ? PEG_CYCLE_VAULT_ABI : HOOK_ABI;
    const data = encodeFunctionData({ abi, functionName: name, args: dummyArgs });
    assert.equal(data.slice(0, 10), expectedSelector, `${name} selector mismatch`);
  }
});

test('CYCLE_LIFECYCLE enum matches PegCycleVault.Lifecycle ordinal order exactly', () => {
  assert.deepEqual(CYCLE_LIFECYCLE, {
    EMPTY: 0, FUNDED: 1, OUTBOUND: 2, RETURNED: 3, PAYOUT_COMMITTED: 4, FAILED: 5, DEGRADED: 6,
  });
});

test('read wrappers call client.readContract with the exact address/functionName/args and return its result untouched', async () => {
  const calls = [];
  const fakeClient = {
    async readContract(request) {
      calls.push(request);
      return 'SENTINEL_RESULT';
    },
  };

  const result = await hookContractClient.readCycleLifecycle(fakeClient, sample.vault, sample.cycleId);
  assert.equal(result, 'SENTINEL_RESULT');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    address: sample.vault,
    abi: PEG_CYCLE_VAULT_ABI,
    functionName: 'cycleLifecycles',
    args: [sample.cycleId],
  });

  await hookContractClient.readPendingAuthorization(fakeClient, sample.vault);
  assert.deepEqual(calls[1], {
    address: sample.vault,
    abi: PEG_CYCLE_VAULT_ABI,
    functionName: 'readPendingAuthorization',
    args: [],
  });

  await hookContractClient.readReleasedCycle(fakeClient, sample.hook, sample.cycleId);
  assert.deepEqual(calls[2], {
    address: sample.hook,
    abi: HOOK_ABI,
    functionName: 'readReleasedCycle',
    args: [sample.cycleId],
  });
});

test('fixture calldata hex strings are well-formed 0x-prefixed hex (sanity guard on the fixture itself)', () => {
  for (const [name, value] of Object.entries(expectedCalldata)) {
    assert.ok(isHex(value), `${name} fixture value is not valid hex`);
  }
  for (const [name, value] of Object.entries(expectedViewSelectors)) {
    assert.ok(isHex(value) && value.length === 10, `${name} fixture selector is not a 4-byte hex value`);
  }
});
