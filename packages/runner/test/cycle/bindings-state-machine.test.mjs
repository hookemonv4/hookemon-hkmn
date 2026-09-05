import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { validateBinding, validateCycleCustody } from '../../src/cycle/bindings.mjs';
import { decodeFixtureOnlyMessage, decodeProductionMessage, encodeFixtureOnlyMessage, fixtureMessageForAction, verifyDecodedTransaction } from '../../src/cycle/decoder.mjs';
import { assertFixtureAction, fixtureActionChainIdentity } from '../../src/cycle/schemas.mjs';

const binding = { sourceChainId: 4663, executionCluster: 'mainnet-beta', circleDollarMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', circleDollarDecimals: 6, pack: 'collector-ember', quantity: 1, turbo: false, executionWallet: 'fixture-solana-policy-account', refundTokenAccount: 'fixture-refund-token-account', refundTokenAccountOwner: 'fixture-solana-policy-account' };
const cycleVaultAccount = '0x0000000000000000000000000000000000001002';
const returnAccount = '0x0000000000000000000000000000000000002002';
const action = {
  schema: 'hookemon.fixture-action.v1',
  cycleId: 'cycle-1',
  actionKind: 'outbound',
  preflightDigest: 'sha256:' + '9'.repeat(64),
  operationsTrigger: '0x0000000000000000000000000000000000001004',
  cycleVaultAccount,
  policyAccount: 'fixture-solana-policy-account',
  returnAccount,
  principalAmount: '10',
  minimumReceive: '10',
  nativeGasAmount: '1',
  provider: 'fixture-provider',
  ...fixtureActionChainIdentity('outbound'),
  instructions: [{ program: 'fixture-program', accounts: [
    { address: 'fixture-fee-payer', isSigner: true, isWritable: true },
    { address: 'fixture-token-outbound', isSigner: false, isWritable: true },
    { address: 'fixture-solana-policy-account', isSigner: false, isWritable: true },
  ], data: '016f7574626f756e64' }],
  signers: [{ address: 'fixture-fee-payer', isFeePayer: true }],
  feePayer: 'fixture-fee-payer',
  sourceAccount: returnAccount,
  inputAsset: 'USDG',
  outputAsset: binding.circleDollarMint,
  mint: binding.circleDollarMint,
  tokenAccount: 'fixture-token-outbound',
  destination: 'fixture-solana-policy-account',
  nftMint: 'fixture-nft-mint',
  nftCustodyAccount: binding.executionWallet,
  amount: '10',
  memo: 'cycle-1:outbound',
  validity: { recentBlockhash: 'aabb', currentHeight: '10', lastValidHeight: '20' },
  binding,
};
const keys = { actionDigest: 'sha256:' + '1'.repeat(64), bindingDigest: 'sha256:' + '2'.repeat(64), approvalKey: 'sha256:' + '3'.repeat(64) };
const message = fixtureMessageForAction(action, keys);

test('binding validation does not reconstruct its regular expression at runtime', () => {
  const source = readFileSync(new URL('../../src/cycle/bindings.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /String\.fromCharCode/);
});

test('accepts the exact manually selected pack binding schema', () => {
  assert.deepEqual(validateBinding(binding), binding);
  assert.equal(validateBinding({ ...binding, pack: 'collector-crypt' }).pack, 'collector-crypt');
  assert.throws(() => validateBinding({ ...binding, pack: 'Collector Ember' }), /pack/);
  assert.throws(() => validateBinding({ ...binding, executionWallet: 'fixture-solana-policy-account/' }), /executionWallet/);
  assert.throws(() => validateBinding({ ...binding, quantity: 2 }), /quantity/);
  assert.throws(() => validateBinding({ ...binding, refundTokenAccountOwner: 'other-wallet' }), /execution wallet/);
  assert.throws(() => validateBinding({ ...binding, liveReady: true }), /exact schema/);
});

test('requires a distinct cycle return escrow', () => {
  const custody = {
    operationsTrigger: action.operationsTrigger,
    cycleVaultAccount,
    policyAccount: action.policyAccount,
    returnAccount,
  };
  assert.deepEqual(validateCycleCustody(custody), custody);
  for (const conflictingAccount of [custody.operationsTrigger, custody.cycleVaultAccount, custody.policyAccount]) {
    assert.throws(() => validateCycleCustody({ ...custody, returnAccount: conflictingAccount }), /return|custody|distinct/i);
  }
});

test('fixture codec accepts only canonical exact message bytes and wrapper fields', () => {
  const raw = encodeFixtureOnlyMessage(message);
  assert.deepEqual(decodeFixtureOnlyMessage(raw), message);
  assert.equal(encodeFixtureOnlyMessage(decodeFixtureOnlyMessage(raw)), raw);
  assert.doesNotThrow(() => verifyDecodedTransaction(message, structuredClone(message)));
  assert.deepEqual(decodeFixtureOnlyMessage(raw, { messageBytes: raw, decoded: message }), message);
  assert.throws(() => decodeFixtureOnlyMessage(raw, { messageBytes: raw, decoded: { ...message, amount: '11' } }), /wrapper mismatch/);
});

test('fixture codec rejects extra, noncanonical, duplicate, and stale fields', () => {
  const raw = encodeFixtureOnlyMessage(message);
  const noncanonical = Buffer.from(JSON.stringify(message), 'utf8').toString('hex');
  const duplicate = Buffer.from('{"schema":"hookemon.fixture-message.v1","schema":"attacker"}', 'utf8').toString('hex');
  assert.throws(() => decodeFixtureOnlyMessage(noncanonical), /noncanonical/);
  assert.throws(() => decodeFixtureOnlyMessage(duplicate), /exact schema|discriminator/);
  assert.throws(() => encodeFixtureOnlyMessage({ ...message, attacker: true }), /exact schema/);
  assert.throws(() => encodeFixtureOnlyMessage({ ...message, validity: { ...message.validity, currentHeight: '21' } }), /validity window/);
  assert.throws(() => decodeFixtureOnlyMessage(raw.toUpperCase()), /invalid/);
  // WP-31: decodeProductionMessage is the real production codec now (no longer INTEGRATION_PENDING) —
  // it rejects a fixture-schema message exactly the way decodeFixtureOnlyMessage rejects a
  // production-schema one, since the two profiles' message discriminators are mutually exclusive.
  assert.throws(() => decodeProductionMessage(raw), /discriminator|invalid/);
});

test('rejects oversized instruction, account, decimal, and hex collections before action decoding', () => {
  assert.throws(
    () => assertFixtureAction({ ...action, instructions: Array.from({ length: 17 }, () => structuredClone(action.instructions[0])) }),
    /instruction.*(?:count|limit|bound|large)/i,
  );
  assert.throws(
    () => assertFixtureAction({ ...action, instructions: [{ ...action.instructions[0], accounts: Array.from({ length: 65 }, () => structuredClone(action.instructions[0].accounts[0])) }] }),
    /account.*(?:count|limit|bound|large)/i,
  );
  assert.throws(() => assertFixtureAction({ ...action, amount: '9'.repeat(79) }), /decimal.*(?:digit|limit|bound|large)/i);
  assert.throws(
    () => assertFixtureAction({ ...action, instructions: [{ ...action.instructions[0], data: 'aa'.repeat(65_537) }] }),
    /hex.*(?:byte|limit|bound|large)|instruction.*data.*(?:limit|bound|large)/i,
  );
});
