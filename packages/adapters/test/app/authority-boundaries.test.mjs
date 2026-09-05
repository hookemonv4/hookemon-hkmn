import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function stageSource(name) {
  return readFileSync(new URL(`../../src/app/stages/${name}.mjs`, import.meta.url), 'utf8');
}

function assertAuthorityCheckInCallback(source, callbackMarker, effectMarker, authorityMarker, label) {
  const start = source.indexOf(callbackMarker);
  assert.notEqual(start, -1, `${label}: callback marker is missing`);
  const effect = source.indexOf(effectMarker, start);
  assert.notEqual(effect, -1, `${label}: effect marker is missing`);
  assert.match(source.slice(start, effect), authorityMarker, `${label}: authority is not revalidated before the effect`);
}

function assertAuthorityCheckBetween(source, startMarker, endMarker, authorityMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: signing marker is missing`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${label}: transport marker is missing`);
  assert.match(source.slice(start, end), authorityMarker, `${label}: authority is not revalidated before transport`);
}

function assertAuthorityCheckBefore(source, effectMarker, authorityMarker, label) {
  const effect = source.indexOf(effectMarker);
  assert.notEqual(effect, -1, `${label}: effect marker is missing`);
  assert.match(source.slice(0, effect), authorityMarker, `${label}: authority is not checked before the effect`);
}

test('revalidates the live authority immediately before signing and before every direct transport submission', () => {
  assertAuthorityCheckInCallback(
    stageSource('purchase'),
    'async sign(request) {',
    'return signerClient.solana.sign(request);',
    /requireLiveMutationAuthority\(\);/,
    'purchase signing',
  );
  assertAuthorityCheckInCallback(
    stageSource('purchase'),
    'broadcast: async signed => {',
    'return adapters.collectorCrypt.submitTransaction',
    /requireLiveMutationAuthority\(\);/,
    'purchase submission',
  );
  assertAuthorityCheckInCallback(
    stageSource('buyback'),
    'async sign(request) {',
    'return signerClient.solana.sign(request);',
    /requireLiveMutationAuthority\(\);/,
    'buyback signing',
  );
  assertAuthorityCheckInCallback(
    stageSource('buyback'),
    'broadcast: async signed => {',
    'return adapters.collectorCrypt.submitTransaction',
    /requireLiveMutationAuthority\(\);/,
    'buyback submission',
  );
  const payout = stageSource('payout');
  assertAuthorityCheckBetween(
    payout,
    'const call = buildFundPayoutFromPegCycleCall',
    'const signed = await signerClient.operationsTrigger.sign',
    /requireLiveRetainedCustodyMutationAuthority\(\);/,
    'payout fund signing',
  );
  assertAuthorityCheckBetween(
    payout,
    'const signed = await signerClient.operationsTrigger.sign',
    'const broadcast = await signerClient.operationsTrigger.broadcast',
    /requireLiveRetainedCustodyMutationAuthority\(\);/,
    'payout fund',
  );
  assertAuthorityCheckBetween(
    payout,
    'const call = buildAuthorizePayoutCall',
    'const signed = await signerClient.evm.sign',
    /requireLiveRetainedCustodyMutationAuthority\(\);/,
    'payout authorize signing',
  );
  assertAuthorityCheckBetween(
    payout,
    'const signed = await signerClient.evm.sign',
    'const broadcast = await signerClient.evm.broadcast',
    /requireLiveRetainedCustodyMutationAuthority\(\);/,
    'payout authorize',
  );
  assertAuthorityCheckInCallback(
    stageSource('return'),
    'async sign() {',
    'return policySigner.sign',
    /requireReturnMutationAuthority\(preflightAuthority\);/,
    'return signing',
  );
  assertAuthorityCheckInCallback(
    stageSource('return'),
    'async broadcast(signed) {',
    'return policySigner.broadcast',
    /requireReturnMutationAuthority\(preflightAuthority\);/,
    'return submission',
  );
  assertAuthorityCheckInCallback(
    stageSource('rehearsal'),
    'async sign(request) {',
    'return signerClient.solana.sign(request);',
    /requireLiveMutationAuthority\(\);/,
    'rehearsal payout signing',
  );
  assertAuthorityCheckInCallback(
    stageSource('rehearsal'),
    'broadcast: async signed => {',
    'return { signature: await submitSignedTransaction',
    /requireLiveMutationAuthority\(\);/,
    'rehearsal payout submission',
  );
  assertAuthorityCheckBefore(
    readFileSync(new URL('../../src/signing/payout-distribution.mjs', import.meta.url), 'utf8'),
    'const result = await signerClient.sign',
    /requireLiveRetainedCustodyMutationAuthority\(\);/,
    'production distribution signing',
  );
});
