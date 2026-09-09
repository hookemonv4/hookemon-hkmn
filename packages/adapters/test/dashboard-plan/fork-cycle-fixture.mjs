// Local Robinhood fork integration. Collector, Relay and Solana are explicitly simulated.
// Production handlers remain byte-identical except two deployment identity pins in the launcher copy.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequestListener } from '../../../dashboard/src/server.mjs';
import { createHistoricalErc20EvidenceClient } from '../../src/robinhood-rpc.mjs';
import { setup as nativeRelaySetup } from '../native/relay-native-proof-fixture.mjs';
import { createTestNativePaymentBinding, readReleaseBoundRelaySourceDebit } from '../../src/native-payment-proof.mjs';
import { productionMoneyConfiguration } from '../../../runner/test/cycle/production-cycle.mjs';

import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

import { join, dirname } from 'node:path';

import test from 'node:test';
import { createPublicClient, http, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import { createEmptyOperatorState, mutateOperatorState, readOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';

import { createStandingAuthorityProvider, stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

import { CycleRepository } from '../../src/app/cycle-repository.mjs';

import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
import { compose } from '../../src/app/compose.mjs';
import { readReturnLegDestinationProof } from '../../src/app/stages/return.mjs';

import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';
import { createSolanaRpcClient, deriveAssociatedTokenAddress, signedSolanaTransactionSignature, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from '../../src/solana-rpc.mjs';
import { COLLECTOR_PURCHASE_BINDING_SCHEMA, COLLECTOR_PURCHASE_BINDING_VERSION } from '../../src/signing/collector-purchase-policy.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA, COLLECTOR_BUYBACK_BINDING_VERSION } from '../../src/signing/collector-buyback-policy.mjs';
import { createIsolatedKeychainChildSetup, COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA, COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA } from '../../src/signing/collector-production-binding.mjs';
import { createCanonicalTransactionPolicy, createTransactionPolicy, decodeProviderTransaction, evaluate as evaluateTransactionPolicy, readTransactionPolicyRules } from '../../src/signing/transaction-policy.mjs';
import { createRelayClient, createQuoteUsdValuation, RELAY_CONSTANTS } from '../../src/relay-client.mjs';
import { OPERATOR_EVM_ROLE } from '../../src/signing/signer-client.mjs';

const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const ROBINHOOD_CHAIN_ID = 4663;
const RELAY_SOLANA_CHAIN_ID = 792703809;
let UNIT_FUNDING_ATOMIC;
let AGGREGATE_FUNDING_ATOMIC;
let AGGREGATE_PURCHASE_ATOMIC;
const AGGREGATE_OUTBOUND_QUOTE_REQUEST_ID = `fixture-quote-${AGGREGATE_PURCHASE_ATOMIC}`;
const OUTBOUND_DESTINATION_SIGNATURE = `${'z'.repeat(44)}${'4'.repeat(44)}`;

const RELAY_CHAINS = Object.freeze({
  chains: [
    { id: ROBINHOOD_CHAIN_ID, depositEnabled: true, erc20Currencies: [{ address: USDG, supportsBridging: true }, { address: `0x${'00'.repeat(20)}`, supportsBridging: true }] },
    { id: RELAY_SOLANA_CHAIN_ID, depositEnabled: true, solverCurrencies: [{ address: SOLANA_MINT }] },
  ],
});

const RELAY_DEPOSIT_SELECTOR = toFunctionSelector('function depositNative(address depositor, bytes32 id)');
let RELAY_DEPOSITORY;

function abiAddressWord(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function relayExecutionSteps({ requestId, orderId, originAmount, sender }) {
  return [{ kind: 'transaction', id: `deposit-${requestId}`, requestId, items: [{ data: {
    chainId: 4663, from: sender, to: RELAY_DEPOSITORY,
    data: `${RELAY_DEPOSIT_SELECTOR}${abiAddressWord(sender)}${orderId.slice(2)}`, value: originAmount,
    gas: '100000', maxFeePerGas: '3000000000', maxPriorityFeePerGas: '1000000',
  } }] }];
}

function outboundDestinationTransaction(owner) {
  return {
    slot: 5,
    blockTime: 1,
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [{
        accountIndex: 1, mint: SOLANA_MINT, owner, uiTokenAmount: { amount: AGGREGATE_PURCHASE_ATOMIC.toString() },
      }],
    },
    transaction: {
      message: {
        accountKeys: ['11111111111111111111111111111111', '22222222222222222222222222222222'],
        instructions: [{ program: 'spl-memo', parsed: AGGREGATE_OUTBOUND_QUOTE_REQUEST_ID }],
      },
    },
  };
}


const EPIC_GATE_SETTLEMENT_ASSET = Object.freeze({ chainId: 'solana-mainnet', assetId: SOLANA_MINT, decimals: 6 });
const EPIC_GATE_SELL_OFFER_ATOMIC = '85000000';

function collectorProductionBindingRegistryEntry({ authority, stage, binding }) {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
    version: 1,
    authority,
    stage,
    chainId: NATIVE_SOLANA_CHAIN_ID,
    provider: 'collector-crypt',
    binding,
    expectedDigest: digest(binding),
  };
}

function collectorProductionBindingRegistry(entries) {
  return { schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA, version: 1, entries };
}

const COLLECTOR_AUTHORITY = Keypair.generate();
const COLLECTOR_BUYBACK_RECIPIENT = Keypair.generate().publicKey.toBase58();
const COLLECTOR_BUYBACK_PROGRAM_ID = Keypair.generate().publicKey.toBase58();
const COLLECTOR_PROCEEDS_SOURCE = Keypair.generate().publicKey.toBase58();
const BUYBACK_SETTLE_DISCRIMINATOR_HEX = 'a1b2c3d4e5f60718';
const BUYBACK_COMPUTE_UNIT_LIMIT = 40_000;
const BUYBACK_PRIORITY_FEE_CAP_ATOMIC = 2n;

function buybackProductionBinding() {
  const computeBudgetProgramId = ComputeBudgetProgram.programId.toBase58();
  return Object.freeze({
    schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
    version: COLLECTOR_BUYBACK_BINDING_VERSION,
    provider: 'collector-crypt',
    chainId: NATIVE_SOLANA_CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    proceeds: { source: COLLECTOR_PROCEEDS_SOURCE, mint: SOLANA_MINT, decimals: 6 },
    collectorAuthority: COLLECTOR_AUTHORITY.publicKey.toBase58(),
    collectorRecipient: COLLECTOR_BUYBACK_RECIPIENT,
    instructions: [
      {
        kind: 'compute-budget-set-unit-limit', programId: computeBudgetProgramId, accounts: [],
        computeUnitLimit: BUYBACK_COMPUTE_UNIT_LIMIT, priorityFeeCapAtomic: null, discriminatorHex: null,
      },
      {
        kind: 'compute-budget-set-unit-price', programId: computeBudgetProgramId, accounts: [],
        computeUnitLimit: null, priorityFeeCapAtomic: BUYBACK_PRIORITY_FEE_CAP_ATOMIC.toString(), discriminatorHex: null,
      },
      {
        kind: 'unknown', programId: COLLECTOR_BUYBACK_PROGRAM_ID,
        accounts: [
          { role: 'operator-fee-payer', isSigner: true, isWritable: true },
          { role: 'collector-authority', isSigner: true, isWritable: false },
          { role: 'opened-asset-mint', isSigner: false, isWritable: true },
          { role: 'collector-recipient', isSigner: false, isWritable: true },
        ],
        computeUnitLimit: null, priorityFeeCapAtomic: null, discriminatorHex: BUYBACK_SETTLE_DISCRIMINATOR_HEX,
      },
      {
        kind: 'spl-transfer-checked', programId: TOKEN_PROGRAM_ID,
        accounts: [
          { role: 'proceeds-source', isSigner: false, isWritable: true },
          { role: 'proceeds-mint', isSigner: false, isWritable: false },
          { role: 'proceeds-destination', isSigner: false, isWritable: true },
          { role: 'collector-authority', isSigner: true, isWritable: false },
        ],
        computeUnitLimit: null, priorityFeeCapAtomic: null, discriminatorHex: null,
      },
    ],
  });
}

function observability(baseUrl, directory, operations) {
  const hash = `0x${'a'.repeat(64)}`;
  const pin = address => ({ address, runtimeHash: hash });
  return {
    canaries: {
      nativePrincipal: { chainId: '4663', assetId: 'native', decimals: 18 },
      gasAccounts: { '4663': operations },
      chainId: 4663,
      contracts: { usdg: { proxy: pin(USDG), implementation: pin(`0x${'2'.repeat(40)}`), decimals: 6 }, poolManager: pin(`0x${'3'.repeat(40)}`), positionManager: pin(`0x${'4'.repeat(40)}`), router: pin(`0x${'5'.repeat(40)}`), quoter: pin(`0x${'6'.repeat(40)}`) },
      roles: { hookAddress: `0x${'7'.repeat(40)}`, cycleId: `0x${'0'.repeat(64)}`, treasury: `0x${'8'.repeat(40)}`, operations },
      canonicalPool: { poolId: `0x${'f'.repeat(64)}` }, providerPolicyDigest: hash,
      nativeGasReserves: [{ chainId: 4663, assetId: 'native', decimals: 18, amountAtomic: '1' }, { chainId: 'solana', assetId: 'native', decimals: 9, amountAtomic: '1' }],
    },
    alert: { webhookUrl: `${baseUrl}/alert`, dedupePath: join(directory, 'observability.sqlite') },
    startPreflight: { requiredSignerRoles: ['operator-evm', 'operator-solana'], requireEvmRpc: true, requireSolanaRpc: true },
  };
}

const NATIVE_SOLANA_CHAIN_ID = 'solana-mainnet';
const PRODUCTION_OPERATIONS_EVM = process.env.FORK_TEST_EVM_KEY ? privateKeyToAccount(process.env.FORK_TEST_EVM_KEY).address.toLowerCase() : null;
const PRODUCTION_OPERATIONS_SOLANA = process.env.FORK_TEST_SOLANA_KEY ? Keypair.fromSecretKey(Buffer.from(process.env.FORK_TEST_SOLANA_KEY,'base64')).publicKey.toBase58() : null;
const N2_GRAPH_PACK_CODE = 'return-fixture';
const RELAY_FUNDING_ROUTE = Object.freeze({ chainId: '4663', assetId: 'native', decimals: 18 });
const RELAY_PURCHASE_ROUTE = Object.freeze({ chainId: String(RELAY_SOLANA_CHAIN_ID), assetId: SOLANA_MINT, decimals: 6 });

function composedTyped(asset, amountAtomic) {
  return { ...asset, amountAtomic };
}

let COMPOSED_HOOK_ADDRESS;
const COMPOSED_DEADLINE_UNIX_SECONDS = 2_000_000_000;

const RELAY_RETURN_DEPOSITORY_SOLANA = 'H8sMJSCQxfKiFTCfDR3DjMUdcfsEZ4zL5HWTZ9wioT4x';
let RELAY_RETURN_SOLVER_EVM;
const RELAY_RETURN_DESTINATION_TX_HASH = `0x${'b'.repeat(64)}`;
let RELAY_RETURN_REQUEST_ID;
let RELAY_RETURN_ORDER_ID;
const RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH = `0x${'5'.repeat(64)}`;
const RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID = 'n2-composed-supplementary-return';
const RELAY_SUPPLEMENTARY_RETURN_ORDER_ID = `0x${'4'.repeat(64)}`;

const SYNTHETIC_RELAY_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const quotedNativeReturnWei = amount => BigInt(amount) * 101n;
const capturedSourceInstruction = Object.freeze({ programId: SYNTHETIC_RELAY_PROGRAM,
  discriminatorHex: '0b9c60da27a3b413', dataLengthBytes: 48, amountOffsetBytes: 8, orderIdOffsetBytes: 16 });
function relayReturnInstruction({ owner, mint, amount, orderId = RELAY_RETURN_ORDER_ID }) {
  const program = new PublicKey(SYNTHETIC_RELAY_PROGRAM);
  const depository = PublicKey.findProgramAddressSync([Buffer.from('relay_depository')], program)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from('vault')], program)[0];
  const accounts = [depository.toBase58(), owner, owner, vault.toBase58(), mint,
    deriveAssociatedTokenAddress(owner, mint).toBase58(), deriveAssociatedTokenAddress(vault, mint).toBase58(),
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID];
  const data = Buffer.alloc(48); Buffer.from(capturedSourceInstruction.discriminatorHex, 'hex').copy(data);
  data.writeBigUInt64LE(BigInt(amount), 8); Buffer.from(orderId.slice(2), 'hex').copy(data, 16);
  return { programId: SYNTHETIC_RELAY_PROGRAM,
    keys: accounts.map((pubkey, i) => ({ pubkey, isSigner: i === 1, isWritable: [1, 5, 6].includes(i) })), data: data.toString('hex') };
}

function relayReturnQuoteRawResponse({ sender, recipient, amountAtomic, instruction, requestId = RELAY_RETURN_REQUEST_ID, orderId = RELAY_RETURN_ORDER_ID }) {
  return {
    requestId,
    steps: [{
      kind: 'transaction', id: `step-${requestId}`, requestId,
      items: [{ data: { instructions: [instruction], addressLookupTableAddresses: [] } }],
    }],
    details: {
      sender, recipient,
      currencyIn: { currency: { chainId: RELAY_CONSTANTS.SOLANA_CHAIN_ID, address: SOLANA_MINT, symbol: 'CIRCLE_USD', decimals: 6 }, amount: amountAtomic },
      currencyOut: {
        currency: { chainId: RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID, address: `0x${'00'.repeat(20)}`, symbol: 'ETH', decimals: 18 },
        amount: quotedNativeReturnWei(amountAtomic).toString(), minimumAmount: quotedNativeReturnWei(amountAtomic).toString(), amountUsd: '0.000080',
      },
    },
    protocol: {
      v2: {
        orderId,
        orderData: {
          output: {
            chainId: 'robinhood', deadline: COMPOSED_DEADLINE_UNIX_SECONDS, calls: [],
            payments: [{ recipient, currency: `0x${'00'.repeat(20)}`, expectedAmount: quotedNativeReturnWei(amountAtomic).toString(), minimumAmount: quotedNativeReturnWei(amountAtomic).toString() }],
          },
          inputs: [{
            payment: { chainId: 'solana', currency: SOLANA_MINT, amount: amountAtomic },
            refunds: [{ chainId: 'solana', currency: SOLANA_MINT, recipient: sender, deadline: COMPOSED_DEADLINE_UNIX_SECONDS }],
          }],
        },
      },
    },
  };
}

function composedRawRelayQuote({ requestId, orderId, originAmount, destinationAmount, sender = PRODUCTION_OPERATIONS_EVM, recipient = PRODUCTION_OPERATIONS_SOLANA }) {
  return {
    requestId,
    steps: relayExecutionSteps({requestId,orderId,originAmount,sender}),
    details: {
      sender,
      recipient,
      currencyIn: { currency: { chainId: 4663, address: `0x${'00'.repeat(20)}`, symbol: 'ETH', decimals: 18 }, amount: originAmount, amountUsd: `${BigInt(originAmount) / 1000000n}.${(BigInt(originAmount) % 1000000n).toString().padStart(6, '0')}` },
      currencyOut: {
        currency: { chainId: RELAY_SOLANA_CHAIN_ID, address: SOLANA_MINT, symbol: 'CIRCLE_USD', decimals: 6 },
        amount: destinationAmount, minimumAmount: destinationAmount,
      },
    },
    protocol: {
      v2: {
        orderId,
        orderData: {
          output: {
            chainId: 'solana', deadline: COMPOSED_DEADLINE_UNIX_SECONDS, calls: [],
            payments: [{
              recipient, currency: SOLANA_MINT,
              expectedAmount: destinationAmount, minimumAmount: destinationAmount,
            }],
          },
          inputs: [{
            payment: { chainId: 'robinhood', currency: `0x${'00'.repeat(20)}`, amount: originAmount, amountUsd: `${BigInt(originAmount) / 1000000n}.${(BigInt(originAmount) % 1000000n).toString().padStart(6, '0')}` },
            refunds: [{ chainId: 'robinhood', currency: `0x${'00'.repeat(20)}`, recipient: sender, deadline: COMPOSED_DEADLINE_UNIX_SECONDS }],
          }],
        },
      },
    },
  };
}

function composedN2PolicyPatch() {
  return {
    intervalMinutes: 5,
    allowedPackIds: [N2_GRAPH_PACK_CODE],
    requestedOrders: 2,
    maxBoostersPerCycle: 2,
    maxUnitPriceMicroUsd: '55000000',
    maxCycleBudgetMicroUsd: '165000000',
    max24HourBudgetMicroUsd: '495000000',
    paused: false,
    liveMode: true,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsd: '165000000',
    lossCapMicroUsd: '1000',
    maxOutstandingCustodyMicroUsd: '1000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
  };
}

function composedCandidateTransaction({
  memoValue, blockhash, operator, providerCoSigner, destination, computeUnitLimit, priorityFeeCapAtomic, memoPrefix, amountAtomic,
}) {
  const sourceAta = deriveAssociatedTokenAddress(operator.publicKey.toBase58(), SOLANA_MINT);
  const transaction = new Transaction({ feePayer: operator.publicKey, recentBlockhash: blockhash });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(priorityFeeCapAtomic) }));
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amountAtomic, 1);
  data.writeUInt8(6, 9);
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(SOLANA_MINT), isSigner: false, isWritable: false },
      { pubkey: destination.publicKey, isSigner: false, isWritable: true },
      { pubkey: operator.publicKey, isSigner: true, isWritable: true },
    ],
    data,
  }));
  transaction.add(new TransactionInstruction({
    programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    keys: [{ pubkey: providerCoSigner.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(`${memoPrefix}${memoValue}`, 'utf8'),
  }));
  transaction.partialSign(providerCoSigner);
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

export async function runBuiltInForkCycle(t, { runtime, directory, credential, initialOrders, catalog, duringPurchase = null }) {
  const graphTimeMs = Date.now();
  const graphNow = () => graphTimeMs;
  await mkdir(directory,{recursive:true});
  const stateDir = directory;
  const statePath = join(directory, 'operator-state.json');
  const operationsEvmAccount = runtime.operationsAccount;
  COMPOSED_HOOK_ADDRESS=runtime.hook;RELAY_DEPOSITORY=runtime.relay.toLowerCase();RELAY_RETURN_SOLVER_EVM=RELAY_DEPOSITORY;
  const OPERATIONS_EVM_SIGNING_ADDRESS = operationsEvmAccount.address.toLowerCase();

  const setupRepository = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  let cycleId = setupRepository.nextCycleId();
  let admission;
  const OUTBOUND_DESTINATION_SIGNATURE = Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58();
  RELAY_RETURN_REQUEST_ID = `return-${cycleId}`;
  RELAY_RETURN_ORDER_ID = keccak256(Buffer.from(RELAY_RETURN_REQUEST_ID));
  const openingHolderBalances = await Promise.all(runtime.holders.map(address => runtime.client.getBalance({address})));

  let savedState;
  try { await readFile(statePath); savedState = await readOperatorState(statePath); } catch(error) { if(error.code !== 'ENOENT') throw error; }
  if (!savedState) await mutateOperatorState(statePath, null, state => ({
    ...(state ?? createEmptyOperatorState()),
    configuration: applyOperatorConfiguration(null, { ...composedN2PolicyPatch(), allowedPackIds: catalog.machines.filter(machine => machine.public === true).map(machine => machine.code).sort(),
      packPlan: { orders: [] }, maxCyclesPerDay: 12, maxUnitPriceMicroUsd: '55000000', maxCycleBudgetMicroUsd: '165000000', perCycleCapMicroUsd: '165000000', max24HourBudgetMicroUsd: '495000000', lossCapMicroUsd: '495000000', maxOutstandingCustodyMicroUsd: '495000000' }),
  }));

  let currentPlan = (await readOperatorState(statePath)).configuration.packPlan;
  const needsInitialSelection = currentPlan.orders.length === 0;
  if (needsInitialSelection) currentPlan = { ...currentPlan, orders: initialOrders };
  const priceAtomic = code => {
    const machine = catalog.machines.find(machine => machine.code === code && machine.public === true);
    assert.ok(machine, 'Selected pack must exist in observed public catalog');
    assert.match(String(machine.price), /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/);
    const [whole, fractional = ''] = String(machine.price).split('.');
    return BigInt(whole) * 1000000n + BigInt(fractional.padEnd(6, '0'));
  };
  const expandedOrders = currentPlan.orders.flatMap(order => Array.from({length: order.quantity}, () => ({ code: order.pack, amountAtomic: priceAtomic(order.pack) })));
  assert.equal(expandedOrders.length, 2, 'This bounded simulation requires exactly two purchased packs per cycle');
  AGGREGATE_PURCHASE_ATOMIC = expandedOrders.reduce((sum, order) => sum + order.amountAtomic, 0n);
  AGGREGATE_FUNDING_ATOMIC = AGGREGATE_PURCHASE_ATOMIC * 2n + 1n;
  UNIT_FUNDING_ATOMIC = expandedOrders[0].amountAtomic * 2n + 1n;

  const standingAuthorityOwnerKeys = generateKeyPairSync('ed25519');
  const standingAuthorityPolicyKeys = generateKeyPairSync('ed25519');
  const standingAuthorityDocument = attachOwnerSignature(buildCanonicalStandingAuthorityDocument({
    owner: 'n2-composed-owner',
    policyPublicKey: standingAuthorityPolicyKeys.publicKey,
    perCycleSpendCap: '64',
    maxCyclesPerDay: 64,
    allowedPacks: ['n2-composed-fixture'],
    allowedDestinations: ['n2-composed-destination'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'n2-composed-standing-authority',
  }), standingAuthorityOwnerKeys.privateKey);
  const standingAuthorityProvider = createStandingAuthorityProvider({
    standingAuthority: standingAuthorityDocument,
    ownerPublicKey: standingAuthorityOwnerKeys.publicKey,
    policyPublicKey: standingAuthorityPolicyKeys.publicKey,
  });
  async function standingAuthorityStepAuthorization({ cycleId: intentCycleId, stage, authorizationKind, requestDigest: subjectDigest, signerRole }) {
    const unsignedIntent = {
      schema: 'hookemon.standing-authority-step-intent.v1',
      standingAuthorityDigest: standingAuthorityDocument.documentDigest,
      cycleId: intentCycleId,
      actionKind: stage,
      authorizationKind,
      subjectDigest,
      destination: 'n2-composed-destination',
      pack: 'n2-composed-fixture',
      spendAmount: '1',
      nonce: `n2-composed-${digest({ cycleId: intentCycleId, stage, subjectDigest, signerRole }).slice('sha256:'.length)}`,
      issuedAt: '2026-01-01T00:00:01.000Z',
    };
    return Object.freeze({
      ...unsignedIntent,
      policySignature: signMessage(null, Buffer.from(stepAuthorizationIntentDigest(unsignedIntent), 'utf8'), standingAuthorityPolicyKeys.privateKey).toString('base64url'),
    });
  }

  const operator = Keypair.fromSecretKey(Buffer.from(process.env.FORK_TEST_SOLANA_KEY,'base64'));
  const providerCoSigner = Keypair.generate();
  const settlementDestination = Keypair.generate();
  const signSpy = { calls: 0 };
  let returnSourceSignature = null;
  const returnSignedBytes = new Map();
  let returnProceedsAtomic = null;
  let payoutTransferAmount = null;
  let payoutRecipientAddress = null;
  let supplementaryReturnSourceSignature = null;
  let supplementaryReturnProceedsAtomic = null;
  let supplementaryPayoutTransferAmount = null;
  let supplementaryPayoutRecipientAddress = null;
  const signerClient = {
    solana: {
      async probe() { return { ready: true }; },
      async sign(request) {
        signSpy.calls += 1;
        const transactionBase64 = typeof request === 'string' ? request : request.transaction;
        const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
        transaction.partialSign(operator);
        return { signedTxBase64: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64') };
      },
      async broadcast(signed) {
        const transactionBase64 = signed.signedTxBase64;
        const signature = signedSolanaTransactionSignature(transactionBase64);
        const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
        const transferChecked = transaction.instructions.find(
          instruction => instruction.programId.toBase58() === SYNTHETIC_RELAY_PROGRAM && instruction.data.length === 48 && instruction.data.subarray(0, 8).toString('hex') === capturedSourceInstruction.discriminatorHex,
        );
        if (!transferChecked) throw new Error('N=2 composed scenario: return broadcast could not find its own TransferChecked instruction');
        const proceeds = transferChecked.data.readBigUInt64LE(8);
        returnSignedBytes.set(signature, transactionBase64);
        if (returnProceedsAtomic === null) {
          returnSourceSignature = signature;
          returnProceedsAtomic = proceeds;
          const paid=await runtime.send({to:runtime.relay,value:quotedNativeReturnWei(proceeds),data:encodeFunctionData({abi:runtime.relayAbi,functionName:'pay',args:[OPERATIONS_EVM_SIGNING_ADDRESS,RELAY_RETURN_ORDER_ID]})},'simulated bridge actual local return credit');
          relayReturnDestinationTxHashByRequestId.set(RELAY_RETURN_REQUEST_ID,paid.transactionHash);
          await runtime.request('anvil_mine',['0x50']);
        } else {
          supplementaryReturnSourceSignature = signature;
          supplementaryReturnProceedsAtomic = proceeds;
        }
        return { signature };
      },
    },
    evm: {
      role: OPERATOR_EVM_ROLE,
      async probe() { return { ready: true }; },
      async sign({ transaction }) {
        signSpy.calls += 1;
        const isLegacy = transaction.gasPrice !== undefined && transaction.gasPrice !== null;
        const signedTx = await operationsEvmAccount.signTransaction({
          type: isLegacy ? 'legacy' : 'eip1559',
          to: transaction.to,
          data: transaction.data,
          value: BigInt(transaction.value ?? '0'),
          chainId: Number(transaction.chainId),
          nonce: Number(transaction.nonce),
          gas: BigInt(transaction.gas),
          ...(isLegacy
            ? { gasPrice: BigInt(transaction.gasPrice) }
            : { maxFeePerGas: BigInt(transaction.maxFeePerGas), maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas) }),
        });
        return { signedTx };
      },
      async broadcast({ signedTx }) {
        const transactionHash = await robinhoodStub.sendRawTransaction({ serializedTransaction: signedTx });
        return { transactionHash };
      },
    },
  };

  const BLOCKHASH_PACK_0 = Keypair.generate().publicKey.toBase58();
  const BLOCKHASH_PACK_1 = Keypair.generate().publicKey.toBase58();
  const HEIGHT_PACK_0 = 50_000;
  const HEIGHT_PACK_1 = 50_500;
  const MEMO_PACK_0 = `n2-composed-pack-0-${cycleId}`;
  const MEMO_PACK_1 = `n2-composed-pack-1-${cycleId}`;
  const MEMO_PREFIX = 'collector-purchase:v1:';
  const COMPUTE_UNIT_LIMIT = 40_000;
  const PRIORITY_FEE_CAP_ATOMIC = 5_000n;

  const rawBinding = Object.freeze({
    schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
    version: COLLECTOR_PURCHASE_BINDING_VERSION,
    provider: 'collector-crypt',
    chainId: NATIVE_SOLANA_CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    settlement: { destination: settlementDestination.publicKey.toBase58(), mint: SOLANA_MINT, decimals: 6 },
    providerCoSigner: providerCoSigner.publicKey.toBase58(),
    instructions: [
      {
        kind: 'compute-budget-set-unit-limit', programId: ComputeBudgetProgram.programId.toBase58(), accounts: [],
        computeUnitLimit: COMPUTE_UNIT_LIMIT, priorityFeeCapAtomic: null, memoPrefix: null,
      },
      {
        kind: 'compute-budget-set-unit-price', programId: ComputeBudgetProgram.programId.toBase58(), accounts: [],
        computeUnitLimit: null, priorityFeeCapAtomic: PRIORITY_FEE_CAP_ATOMIC.toString(), memoPrefix: null,
      },
      {
        kind: 'spl-transfer-checked', programId: TOKEN_PROGRAM_ID,
        accounts: [
          { role: 'source-ata', isSigner: false, isWritable: true },
          { role: 'settlement-mint', isSigner: false, isWritable: false },
          { role: 'settlement-destination', isSigner: false, isWritable: true },
          { role: 'operator-fee-payer', isSigner: true, isWritable: true },
        ],
        computeUnitLimit: null, priorityFeeCapAtomic: null, memoPrefix: null,
      },
      {
        kind: 'unknown', programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
        accounts: [{ role: 'provider-co-signer', isSigner: true, isWritable: false }],
        computeUnitLimit: null, priorityFeeCapAtomic: null, memoPrefix: MEMO_PREFIX,
      },
    ],
  });
  const fixtureBinding = Object.freeze({ binding: rawBinding, expectedDigest: digest(rawBinding) });

  const packs = [
    {
      memo: MEMO_PACK_0,
      transaction: composedCandidateTransaction({
        amountAtomic: expandedOrders[0].amountAtomic, memoValue: MEMO_PACK_0, blockhash: BLOCKHASH_PACK_0, operator, providerCoSigner,
        destination: settlementDestination, computeUnitLimit: COMPUTE_UNIT_LIMIT,
        priorityFeeCapAtomic: PRIORITY_FEE_CAP_ATOMIC, memoPrefix: MEMO_PREFIX,
      }),
    },
    {
      memo: MEMO_PACK_1,
      transaction: composedCandidateTransaction({
        amountAtomic: expandedOrders[1].amountAtomic, memoValue: MEMO_PACK_1, blockhash: BLOCKHASH_PACK_1, operator, providerCoSigner,
        destination: settlementDestination, computeUnitLimit: COMPUTE_UNIT_LIMIT,
        priorityFeeCapAtomic: PRIORITY_FEE_CAP_ATOMIC, memoPrefix: MEMO_PREFIX,
      }),
    },
  ];

  const calls = {
    getMachines: 0, generatePack: 0, generateYoloPacks: 0, getPackStatus: 0, submitTransaction: 0, openPack: 0,
    getNfts: 0, getBuybackAvailable: 0, buyback: 0, getBuybackCheck: 0,
  };
  const packMemosInBatchOrder = [MEMO_PACK_0, MEMO_PACK_1];
  const purchaseSignaturesByMemo = new Map();
  const buybackSignaturesByMemo = new Map();
  const cardAwardsByMemo = new Map([
    [MEMO_PACK_0, { mint: Keypair.generate().publicKey.toBase58(), signature: Keypair.generate().publicKey.toBase58() }],
    [MEMO_PACK_1, { mint: Keypair.generate().publicKey.toBase58(), signature: Keypair.generate().publicKey.toBase58() }],
  ]);
  const openedMemos = new Set();
  const EPIC_GATE_INSTANT_BUYBACK_PERCENT = 90;
  const EPIC_GATE_SETTLEMENT_ASSET = Object.freeze({ chainId: NATIVE_SOLANA_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 });
  const EPIC_GATE_SELL_OFFER_ATOMIC = '85000000';
  const EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC = '42500000';
  const epicGateFactsByMemo = new Map([
    [MEMO_PACK_0, { prizeTier: 4, rarity: 'common', insuredValue: 100, buybackAvailable: true }],
    [MEMO_PACK_1, { prizeTier: 3, rarity: 'uncommon', insuredValue: 50, buybackAvailable: true }],
  ]);
  let supplementaryBuybackAvailable = false;
  const availabilityObservations = [];
  const memoPackTypes = new Map();
  let generatedCount = 0;
  let purchaseCallbackCalled = false;
  // One generation implementation behind both provider transports: a single-pack plan order arrives
  // through the bound non-turbo `generatePack`, a multi-pack order through `generateYoloPacks`.
  // Both hand out the same pre-built candidates in plan order, and the first generation call of
  // either kind fires `duringPurchase`, so the callback timing is unchanged.
  async function generateCandidates({ playerAddress, quantity, packType }) {
    assert.equal(playerAddress, operator.publicKey.toBase58());
    assert.ok(currentPlan.orders.some(order => order.pack === packType));
    if (duringPurchase && !purchaseCallbackCalled) { purchaseCallbackCalled = true; await duringPurchase({ composition, request, cycleId }); }
    const selected = packs.slice(generatedCount, generatedCount + quantity);
    assert.equal(selected.length, quantity);
    generatedCount += quantity;
    for (const pack of selected) memoPackTypes.set(pack.memo, packType);
    return selected;
  }
  const collectorCrypt = {
    async getMachines() {
      calls.getMachines += 1;
      return structuredClone(catalog);
    },
    async generatePack({ playerAddress, turbo, packType }) {
      calls.generatePack += 1;
      assert.equal(turbo, false);
      const [pack] = await generateCandidates({ playerAddress, quantity: 1, packType });
      return pack;
    },
    async generateYoloPacks({ playerAddress, quantity, packType }) {
      calls.generateYoloPacks += 1;
      return { packs: await generateCandidates({ playerAddress, quantity, packType }) };
    },
    async getPackStatus({ memo }) {
      calls.getPackStatus += 1;
      const signature = purchaseSignaturesByMemo.get(memo);
      if (signature === undefined) return { memo, pack: null, send: null, buyback: [] };
      const award = openedMemos.has(memo) ? cardAwardsByMemo.get(memo) : null;
      const epicFacts = epicGateFactsByMemo.get(memo);
      return {
        memo,
        pack: { transaction_signature: signature, token_mint: SOLANA_MINT, nft_address: null, pack_type: memoPackTypes.get(memo) },
        send: award === null ? null : {
          transaction_signature: award.signature, nft_address: award.mint, to_wallet: operator.publicKey.toBase58(),
          prize_tier: epicFacts.prizeTier, insured_value: epicFacts.insuredValue,
        },
        buyback: [],
      };
    },
    async submitTransaction({ signedTransaction }) {
      const signature = signedSolanaTransactionSignature(signedTransaction);
      if (calls.submitTransaction < packMemosInBatchOrder.length) {
        const memo = packMemosInBatchOrder[calls.submitTransaction];
        calls.submitTransaction += 1;
        purchaseSignaturesByMemo.set(memo, signature);
        acceptedPurchaseSignatures.add(signature);
        return { signature };
      }
      calls.submitTransaction += 1;
      if (!buybackSignaturesByMemo.has(MEMO_PACK_0)) {
        buybackSignaturesByMemo.set(MEMO_PACK_0, signature);
      } else {
        buybackSignaturesByMemo.set(MEMO_PACK_1, signature);
      }
      return { signature };
    },
    async openPack({ memo }) {
      calls.openPack += 1;
      const award = cardAwardsByMemo.get(memo);
      if (award === undefined) throw new Error(`N=2 composed scenario: openPack called for unknown memo ${memo}`);
      openedMemos.add(memo);
      return { success: true, nft_address: award.mint, transaction_signature: award.signature };
    },
    async getNfts({ code, page, limit }) {
      calls.getNfts += 1;
      assert.ok(currentPlan.orders.some(order => order.pack === code));
      assert.equal(page, 1);
      assert.equal(limit, 50);
      const nfts = [MEMO_PACK_0, MEMO_PACK_1].filter(memo => memoPackTypes.get(memo) === code).map(memo => {
        const facts = epicGateFactsByMemo.get(memo);
        return { nft_address: cardAwardsByMemo.get(memo).mint, rarity: facts.rarity, insured_value: facts.insuredValue };
      });
      return { nfts, hasMore: false, page, limit };
    },
    async getBuybackAvailable({ nft, wallet }) {
      calls.getBuybackAvailable += 1;
      availabilityObservations.push({nft, wallet, expectedWallet: operator.publicKey.toBase58(), supplementaryBuybackAvailable});
      assert.equal(wallet, operator.publicKey.toBase58());
      const entry = [...epicGateFactsByMemo.entries()].find(([memo]) => cardAwardsByMemo.get(memo).mint === nft);
      if (entry === undefined) throw new Error(`N=2 composed scenario: getBuybackAvailable called for unknown card ${nft}`);
      const [memo, facts] = entry;
      const available = facts.buybackAvailable || (memo === MEMO_PACK_1 && supplementaryBuybackAvailable);
      if (!available) return { available: false };
      availabilityObservations.at(-1).available = available;
      const offer = memo === MEMO_PACK_1 ? EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC : EPIC_GATE_SELL_OFFER_ATOMIC;
      return { available: true, amount: { ...EPIC_GATE_SETTLEMENT_ASSET, amountAtomic: offer } };
    },
    async buyback({ playerAddress, nftAddress }) {
      calls.buyback += 1;
      assert.equal(playerAddress, operator.publicKey.toBase58());
      const memo = nftAddress === BUYBACK_SELL_MINT ? MEMO_PACK_0
        : nftAddress === SUPPLEMENTARY_SELL_MINT ? MEMO_PACK_1
        : null;
      if (memo === null) throw new Error(`N=2 composed scenario: buyback called for unknown card ${nftAddress}`);
      const offer = memo === MEMO_PACK_1 ? EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC : EPIC_GATE_SELL_OFFER_ATOMIC;
      return {
        success: true,
        serializedTransaction: buildBuybackTransactionBytes({
          recipient: COLLECTOR_BUYBACK_RECIPIENT, mint: nftAddress, blockhash: BUYBACK_BLOCKHASH, data: COLLECTOR_BUYBACK_INSTRUCTION_DATA,
        }),
        memo,
        refundAmount: { ...EPIC_GATE_SETTLEMENT_ASSET, amountAtomic: offer },
      };
    },
    async getBuybackCheck({ memo }) {
      calls.getBuybackCheck += 1;
      const signature = buybackSignaturesByMemo.get(memo);
      if (signature === undefined) return { exists: false };
      const offer = memo === MEMO_PACK_1 ? EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC : EPIC_GATE_SELL_OFFER_ATOMIC;
      return {
        exists: true, status: 'complete', playerWallet: operator.publicKey.toBase58(),
        nft: cardAwardsByMemo.get(memo).mint, transactionSignature: signature,
        buybackAmount: offer, createdAt: '2026-09-07T00:00:00.000Z',
      };
    },
  };
  const PURCHASE_DEBIT_PRE_ATOMIC = 1000000000000n;
  const purchaseTokenAccountAddress = Keypair.generate().publicKey.toBase58();
  const cardTokenAccountAddress = Keypair.generate().publicKey.toBase58();

  const blockhashHeights = new Map([[BLOCKHASH_PACK_0, HEIGHT_PACK_0], [BLOCKHASH_PACK_1, HEIGHT_PACK_1]]);
  const COLLECTOR_BUYBACK_INSTRUCTION_DATA = Buffer.from(BUYBACK_SETTLE_DISCRIMINATOR_HEX, 'hex');
  const BUYBACK_SELL_MINT = cardAwardsByMemo.get(MEMO_PACK_0).mint;
  const SUPPLEMENTARY_SELL_MINT = cardAwardsByMemo.get(MEMO_PACK_1).mint;
  const BUYBACK_BLOCKHASH = BLOCKHASH_PACK_1;

  function buildBuybackTransactionBytes({ recipient, mint, blockhash, data }) {
    return buybackCandidateTransaction({ operationsSolana: operator.publicKey.toBase58(), cardMint: mint,
      offerAtomic: BigInt(mint === SUPPLEMENTARY_SELL_MINT ? EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC : EPIC_GATE_SELL_OFFER_ATOMIC),
      blockhash, recipient, discriminator: data.toString('hex') });
  }

  function decodeBuybackTransaction(transactionBase64) {
    return decodeProviderTransaction({
      family: 'solana', chainId: NATIVE_SOLANA_CHAIN_ID, transaction: transactionBase64,
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: String(blockhashHeights.get(blockhash) ?? HEIGHT_PACK_1) }),
      currentBlockHeightResolver: async () => '1',
    });
  }

  function amountPolicyRule(value) {
    return value === null ? null : { exact: value };
  }

  function instructionPolicyRule(instruction) {
    return {
      kind: instruction.kind, programId: instruction.programId, instructionId: instruction.instructionId,
      data: instruction.data, accounts: instruction.accounts, source: instruction.source,
      destination: instruction.destination, mint: instruction.mint, token: instruction.token,
      amount: amountPolicyRule(instruction.amount), nativeValue: amountPolicyRule(instruction.nativeValue),
      computeUnitLimit: instruction.computeUnitLimit, priorityFee: amountPolicyRule(instruction.priorityFee),
    };
  }

  function buybackRuleFromDecoded(decoded, id) {
    return {
      id,
      family: decoded.family, format: decoded.format, chainId: decoded.chainId, nonce: decoded.nonce,
      programIds: decoded.programIds, addressLookupTables: decoded.addressLookupTables,
      target: decoded.target, selector: decoded.selector, source: decoded.source, destination: decoded.destination,
      mint: decoded.mint, token: decoded.token, amount: amountPolicyRule(decoded.amount), nativeValue: amountPolicyRule(decoded.nativeValue),
      gas: { computeUnitLimit: decoded.gas.computeUnitLimit, pricePerComputeUnit: amountPolicyRule(decoded.gas.pricePerComputeUnit) },
      feePayer: decoded.feePayer, requiredSigners: decoded.requiredSigners, coSigners: decoded.coSigners,
      instructions: decoded.instructions.map(instructionPolicyRule), extraInstructions: decoded.extraInstructions.map(instructionPolicyRule),
      blockhash: decoded.blockhash, deadline: decoded.deadline, priorityFee: amountPolicyRule(decoded.priorityFee),
    };
  }

  function buildBuybackPolicy(decoded, extraRules = []) {
    return createTransactionPolicy({
      policy: createCanonicalTransactionPolicy({ decoded, stage: 'buyback' }),
      rules: [buybackRuleFromDecoded(decoded, 'n2-composed-buyback-v1'), ...extraRules],
    });
  }

  const buybackTrustedTemplateTransaction = buildBuybackTransactionBytes({
    recipient: COLLECTOR_BUYBACK_RECIPIENT, mint: BUYBACK_SELL_MINT, blockhash: BUYBACK_BLOCKHASH, data: COLLECTOR_BUYBACK_INSTRUCTION_DATA,
  });
  const buybackTrustedDecoded = await decodeBuybackTransaction(buybackTrustedTemplateTransaction);
  const supplementaryBuybackTrustedTemplateTransaction = buildBuybackTransactionBytes({
    recipient: COLLECTOR_BUYBACK_RECIPIENT, mint: SUPPLEMENTARY_SELL_MINT, blockhash: BUYBACK_BLOCKHASH, data: COLLECTOR_BUYBACK_INSTRUCTION_DATA,
  });
  const supplementaryBuybackTrustedDecoded = await decodeBuybackTransaction(supplementaryBuybackTrustedTemplateTransaction);
  const buybackPolicy = buildBuybackPolicy(
    buybackTrustedDecoded,
    [buybackRuleFromDecoded(supplementaryBuybackTrustedDecoded, 'n2-composed-supplementary-buyback-v1')],
  );

  {
    const driftedRecipient = Keypair.generate().publicKey.toBase58();
    assert.notEqual(driftedRecipient, COLLECTOR_BUYBACK_RECIPIENT, 'drift fixture must actually differ from the pinned recipient');
    const driftedTransaction = buildBuybackTransactionBytes({
      recipient: driftedRecipient, mint: BUYBACK_SELL_MINT, blockhash: BUYBACK_BLOCKHASH, data: COLLECTOR_BUYBACK_INSTRUCTION_DATA,
    });
    const driftedDecoded = await decodeBuybackTransaction(driftedTransaction);
    assert.throws(
      () => evaluateTransactionPolicy(buybackPolicy, driftedDecoded),
      /is not explicitly allowed/,
      'a one-field recipient drift from the independently pinned trusted template must be refused by the real transaction-policy evaluator before any sign or submit',
    );
  }

  const latestBlockhashSequence = [
    { blockhash: BLOCKHASH_PACK_0, lastValidBlockHeight: HEIGHT_PACK_0 },
    { blockhash: BLOCKHASH_PACK_1, lastValidBlockHeight: HEIGHT_PACK_1 },
  ];
  const acceptedPurchaseSignatures = new Set();
  function jsonRpcResult(result, id) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
  }
  const solanaClient = createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getSlot') return jsonRpcResult(11, body.id);
      if (body.method === 'getMultipleAccounts') return jsonRpcResult(runtimeFixture.observation, body.id);
      if (body.method === 'getAccountInfo') {
        const [address] = body.params;
        const settlementAta = deriveAssociatedTokenAddress(operator.publicKey.toBase58(), SOLANA_MINT).toBase58();
        const heldMint = [BUYBACK_SELL_MINT, SUPPLEMENTARY_SELL_MINT].find(mint => address === deriveAssociatedTokenAddress(operator.publicKey.toBase58(), mint).toBase58());
        if (heldMint) {
          return jsonRpcResult({
            context: { slot: 1 },
            value: {
              owner: TOKEN_PROGRAM_ID,
              data: {
                program: 'spl-token',
                parsed: {
                  type: 'account',
                  info: { mint: heldMint, owner: operator.publicKey.toBase58(), tokenAmount: { amount: [...buybackSignaturesByMemo.keys()].some(memo => cardAwardsByMemo.get(memo)?.mint === heldMint) ? '0' : '1', decimals: 0 } },
                },
              },
            },
          }, body.id);
        }
        return jsonRpcResult({
          context: { slot: 1 },
          value: {
            owner: TOKEN_PROGRAM_ID,
            data: {
              program: 'spl-token',
              parsed: {
                type: 'account',
                info: { mint: SOLANA_MINT, owner: operator.publicKey.toBase58(), tokenAmount: { amount: AGGREGATE_PURCHASE_ATOMIC.toString(), decimals: 6 } },
              },
            },
          },
        }, body.id);
      }
      if (body.method === 'getBalance') return jsonRpcResult({ context: { slot: 1 }, value: 10_000_000_000 }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpcResult({ context: { slot: 1 }, value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpcResult(1, body.id);
      if (body.method === 'getLatestBlockhash') {
        const index = Math.min(acceptedPurchaseSignatures.size, latestBlockhashSequence.length - 1);
        return jsonRpcResult({ context: { slot: 1 }, value: latestBlockhashSequence[index] }, body.id);
      }
      if(body.method==='getSignaturesForAddress') return jsonRpcResult(outboundDepositHash?[{signature:OUTBOUND_DESTINATION_SIGNATURE,slot:5,err:null}]:[],body.id);
      if (body.method === 'getSignatureStatuses') {
        const [signatures] = body.params;
        const known = new Set([
          ...(outboundDepositHash?[OUTBOUND_DESTINATION_SIGNATURE]:[]),
          ...purchaseSignaturesByMemo.values(),
          ...[...cardAwardsByMemo.values()].map(award => award.signature),
          ...buybackSignaturesByMemo.values(),
        ]);
        return jsonRpcResult({
          context: { slot: 1 },
          value: signatures.map(signature => (known.has(signature) ? { confirmationStatus: 'finalized', slot: 5, err: null } : null)),
        }, body.id);
      }
      if (body.method === 'getTransaction') {
        const [signature] = body.params;
        if(signature===OUTBOUND_DESTINATION_SIGNATURE && outboundDepositHash) {
          const tx=outboundDestinationTransaction(operator.publicKey.toBase58());
          tx.transaction.message.instructions[0].parsed=admission.relay.requestId;
          tx.blockTime=outboundDepositTimestamp+1;
          return jsonRpcResult(tx,body.id);
        }
        if (new Set(purchaseSignaturesByMemo.values()).has(signature)) {
          const purchasedMemo = [...purchaseSignaturesByMemo].find(([, value]) => value === signature)[0];
          const postAmount = PURCHASE_DEBIT_PRE_ATOMIC - priceAtomic(memoPackTypes.get(purchasedMemo));
          return jsonRpcResult({
            slot: 1,
            blockTime: 1_800_000_000,
            transaction: { message: { accountKeys: [purchaseTokenAccountAddress] } },
            meta: {
              err: null,
              preTokenBalances: [{
                accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: PURCHASE_DEBIT_PRE_ATOMIC.toString() },
              }],
              postTokenBalances: [{
                accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: postAmount.toString() },
              }],
            },
          }, body.id);
        }
        const awardEntry = [...cardAwardsByMemo.entries()].find(([, award]) => award.signature === signature);
        if (awardEntry !== undefined) {
          const [, award] = awardEntry;
          return jsonRpcResult({
            slot: 1,
            blockTime: 1_800_000_000,
            transaction: { message: { accountKeys: [cardTokenAccountAddress] } },
            meta: {
              err: null,
              preTokenBalances: [{
                accountIndex: 0, mint: award.mint, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: '0' },
              }],
              postTokenBalances: [{
                accountIndex: 0, mint: award.mint, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: '1' },
              }],
            },
          }, body.id);
        }
        const soldMemo = [...buybackSignaturesByMemo].find(([, value]) => value === signature)?.[0];
        if (soldMemo) {
          const settlementPreAtomic = 1000n;
          const settlementPostAtomic = settlementPreAtomic + BigInt(soldMemo === MEMO_PACK_1 ? EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC : EPIC_GATE_SELL_OFFER_ATOMIC);
          return jsonRpcResult({
            slot: 1,
            blockTime: 1_800_000_000,
            transaction: { message: { accountKeys: [purchaseTokenAccountAddress, cardTokenAccountAddress] } },
            meta: {
              err: null,
              preTokenBalances: [
                { accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(), uiTokenAmount: { amount: settlementPreAtomic.toString() } },
                { accountIndex: 1, mint: cardAwardsByMemo.get(soldMemo).mint, owner: operator.publicKey.toBase58(), uiTokenAmount: { amount: '1' } },
              ],
              postTokenBalances: [
                { accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(), uiTokenAmount: { amount: settlementPostAtomic.toString() } },
                { accountIndex: 1, mint: cardAwardsByMemo.get(soldMemo).mint, owner: operator.publicKey.toBase58(), uiTokenAmount: { amount: '0' } },
              ],
            },
          }, body.id);
        }
        if (signature === returnSourceSignature && returnProceedsAtomic !== null) {
          return jsonRpcResult({
            slot: 5,
            blockTime: Math.floor(graphTimeMs / 1000),
            transaction: body.params[1]?.encoding === 'base64' ? [returnSignedBytes.get(signature), 'base64'] : { message: { accountKeys: [operator.publicKey.toBase58()] } },
            meta: {
              err: null,
              preTokenBalances: [{
                accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: returnProceedsAtomic.toString() },
              }],
              postTokenBalances: [{
                accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: '0' },
              }],
            },
          }, body.id);
        }
        if (signature === supplementaryReturnSourceSignature && supplementaryReturnProceedsAtomic !== null) {
          return jsonRpcResult({
            slot: 6,
            blockTime: Math.floor(graphTimeMs / 1000) + 2,
            transaction: body.params[1]?.encoding === 'base64' ? [returnSignedBytes.get(signature), 'base64'] : { message: { accountKeys: [operator.publicKey.toBase58()] } },
            meta: {
              err: null,
              preTokenBalances: [{
                accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: supplementaryReturnProceedsAtomic.toString() },
              }],
              postTokenBalances: [{
                accountIndex: 0, mint: SOLANA_MINT, owner: operator.publicKey.toBase58(),
                uiTokenAmount: { amount: '0' },
              }],
            },
          }, body.id);
        }
        throw new Error(`N=2 composed scenario: unexpected getTransaction signature ${signature}`);
      }
      throw new Error(`N=2 composed scenario: unexpected Solana RPC method ${body.method}`);
    },
  });

  const N2_HOOK_EVENT_ABI = parseAbi([
    'function claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountAtomicUsdg, address indexed destination, uint256 timestamp, uint256 cap, uint256 usedAfter)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const robinhoodStub = { ...runtime.client, async sendRawTransaction({serializedTransaction}) {
    const parsed=parseTransaction(serializedTransaction);
    assert.equal(Number(parsed.chainId),4663);
    assert.equal((await recoverTransactionAddress({serializedTransaction})).toLowerCase(),OPERATIONS_EVM_SIGNING_ADDRESS);
    const hash=await runtime.client.sendRawTransaction({serializedTransaction});
    const receipt=await runtime.client.waitForTransactionReceipt({hash,pollingInterval:20});
    assert.equal(receipt.status,'success');
    runtime.receipts.push({label:'bot signed '+(parsed.to.toLowerCase()===runtime.hook?'claim-process':parsed.to.toLowerCase()===runtime.relay.toLowerCase()?'outbound':'payout'),hash,blockNumber:receipt.blockNumber.toString(),gasUsed:receipt.gasUsed.toString()});
    if(parsed.to.toLowerCase()===runtime.relay.toLowerCase()) {
      const deposit=decodeFunctionData({abi:runtime.relayAbi,data:parsed.data});
      assert.equal(deposit.functionName,'depositNative');
      assert.equal(deposit.args[0].toLowerCase(),OPERATIONS_EVM_SIGNING_ADDRESS);
      admission = (await composition.cycleRepository.describeCycle(cycleId)).admission;
      assert.equal(deposit.args[1],admission.relay.orderId);
      assert.equal(parsed.value,BigInt(admission.aggregateFundingQuote.amountAtomic));
      outboundDepositHash=hash;
      outboundDepositTimestamp=Number((await runtime.client.getBlock({blockNumber:receipt.blockNumber})).timestamp);
    }
    await runtime.request('anvil_mine',['0x50']);
    return hash;
  }};
  const historicalEvidenceStub=createHistoricalErc20EvidenceClient({client:runtime.client});
  let outboundDepositHash=null;
  let outboundDepositTimestamp=null;
  let relayReturnQuoteCallCount = 0;
  const relayReturnDestinationTxHashByRequestId = new Map([
    [RELAY_RETURN_REQUEST_ID, RELAY_RETURN_DESTINATION_TX_HASH],
    [RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID, RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH],
  ]);
  let outboundQuoteCounter = 0;
  const relayFetchImpl = async (url, init) => {
    const path = url.pathname;
    if (path === '/chains') {
      return { ok: true, status: 200, text: async () => JSON.stringify(RELAY_CHAINS) };
    }
    if (path === '/quote/v2') {
      const body = JSON.parse(init.body);
      if (body.originChainId === 4663) {
        const isFunding = body.tradeType === 'EXACT_OUTPUT';
        const amount = BigInt(body.amount);
        const originAmount = isFunding ? (amount * 2n + 1n).toString() : body.amount;
        const raw = composedRawRelayQuote({ requestId: `quote-${cycleId}-${++outboundQuoteCounter}`, orderId: keccak256(Buffer.from(`${cycleId}:${outboundQuoteCounter}`)),
          originAmount, destinationAmount: isFunding ? body.amount : '1', sender: body.user, recipient: body.recipient });
        raw.details.currencyIn.amountUsd = (isFunding ? amount : amount / 2n).toString().replace(/([0-9]{6})$/, '.$1');
        return { ok: true, status: 200, text: async () => JSON.stringify(raw) };
      }
      relayReturnQuoteCallCount += 1;
      const isSupplementary = relayReturnQuoteCallCount > 1;
      const sourceAta = deriveAssociatedTokenAddress(operator.publicKey.toBase58(), SOLANA_MINT).toBase58();
      const instruction = relayReturnInstruction({
        source: sourceAta, destination: RELAY_RETURN_DEPOSITORY_SOLANA, owner: operator.publicKey.toBase58(),
        mint: SOLANA_MINT, amount: BigInt(body.amount), decimals: 6, orderId: isSupplementary ? RELAY_SUPPLEMENTARY_RETURN_ORDER_ID : RELAY_RETURN_ORDER_ID,
      });
      const raw = relayReturnQuoteRawResponse({
        sender: body.user, recipient: body.recipient, amountAtomic: body.amount, instruction,
        ...(isSupplementary
          ? { requestId: RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID, orderId: RELAY_SUPPLEMENTARY_RETURN_ORDER_ID }
          : {}),
      });
      return { ok: true, status: 200, text: async () => JSON.stringify(raw) };
    }
    if (path === '/intents/status/v3') {
      const requestId = url.searchParams.get('requestId');
      if(requestId===admission.relay.requestId && outboundDepositHash) return {ok:true,status:200,text:async()=>JSON.stringify({status:'success',originChainId:4663,destinationChainId:792703809,txHashes:[OUTBOUND_DESTINATION_SIGNATURE]})};
      const destinationTxHash = relayReturnDestinationTxHashByRequestId.get(requestId) ?? null;
      if (destinationTxHash === null) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'pending', originChainId: null, destinationChainId: null, txHashes: [] }) };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          status: 'success',
          originChainId: RELAY_CONSTANTS.SOLANA_CHAIN_ID,
          destinationChainId: RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID,
          txHashes: [destinationTxHash],
        }),
      };
    }
    throw new Error(`N=2 composed scenario: unexpected Relay request ${path}`);
  };
  const relayStub = createRelayClient({ now: graphNow, quoteValidityMs: 600000, fetchImpl: relayFetchImpl });
  if (process.env.N2_TRACE === '1') {
    const bi = v => (typeof v === 'bigint' ? v.toString() : v);
    for (const [obj, label] of [[robinhoodStub, 'robinhood'], [historicalEvidenceStub, 'archive']]) {
      for (const key of Object.keys(obj)) {
        const orig = obj[key];
        obj[key] = async (...a) => {
          try {
            const r = await orig(...a);
            console.error(`TRACE ${label}.${key}`, JSON.stringify(a, (k, v) => bi(v)), '->', JSON.stringify(r, (k, v) => bi(v)));
            return r;
          } catch (e) {
            console.error(`TRACE ${label}.${key} THREW`, JSON.stringify(a, (k, v) => bi(v)), '->', e.message);
            throw e;
          }
        };
      }
    }
  }

  const runtimeFixture = await nativeRelaySetup({ runtimeMutation: observation => { const bytes = Buffer.from(observation.value[1].data[0], 'base64'); bytes.writeBigUInt64LE(1n, 4); observation.value[1].data[0] = bytes.toString('base64'); } });
  const nativePaymentBinding = createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663',
    hook: { address: COMPOSED_HOOK_ADDRESS, runtimeHash: keccak256(await runtime.client.getCode({address:runtime.hook})) }, relay: { ...runtimeFixture.route, runtimeHash:keccak256(await runtime.client.getCode({address:runtime.relay})), sourceInstruction: capturedSourceInstruction, emitter: RELAY_RETURN_SOLVER_EVM } }, createTestProfileMutationAuthority());
  const isolatedRoot = join(directory, `composed-isolated-child-${cycleId}`);
  await mkdir(isolatedRoot);
  const isolatedSetup = await createIsolatedKeychainChildSetup({ directory: isolatedRoot });
  const composedRegistry = collectorProductionBindingRegistry([
    collectorProductionBindingRegistryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: rawBinding }),
    collectorProductionBindingRegistryEntry({ authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', binding: buybackProductionBinding() }),
  ]);
  const config = {
    ...(await forkSnapshotConfiguration(runtime)),
    processLiabilityReader: { async read(input) { cycleId = input.cycleId; return forkProcessEvidence(runtime, cycleId); } },
    dashboard: { profileId: 'mainnet', proxyCredential: credential, sqlitePath: ':memory:', auditLogPath: join(directory, 'dashboard-audit.log') },
    now: graphNow,
    collectorProductionBindingRegistry: composedRegistry,
    signer: { backend: 'keychain', liveMode: true, keychain: { command: isolatedSetup.command, isolatedChildSetup: isolatedSetup } },
    robinhood: { rpcUrl: 'http://127.0.0.1:1/rpc', archiveRpcUrl: 'http://127.0.0.1:1/archive' },
    nativePaymentBinding,
    stateDir,
    statePath,
    workerOwner: 'n2-composed-worker',
    leaseTtlMs: 30_000,
    chainId: 4663,
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', dryRun: false, enforceProfile: true },
    accounts: { evm: OPERATIONS_EVM_SIGNING_ADDRESS, solana: operator.publicKey.toBase58() },
    pack: { code: currentPlan.orders[0].pack },
    relay: { evmDepository: RELAY_DEPOSITORY, baseUrl: 'http://127.0.0.1:1/relay', solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '999999999' },
    solana: {
      rpcUrl: 'http://127.0.0.1:1/solana',
      chainId: NATIVE_SOLANA_CHAIN_ID,
      blockhashContextResolver: async blockhash => ({
        blockhash, lastValidBlockHeight: String(blockhashHeights.get(blockhash) ?? HEIGHT_PACK_1),
      }),
    },
    collectorCrypt: {
      baseUrl: 'http://127.0.0.1:1/collector',
      productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
      settlementAsset: { chainId: NATIVE_SOLANA_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 },
      purchase: { testFixtureBinding: fixtureBinding },
      epicGate: {
        nftAddressField: 'nft_address', insuredValueField: 'insured_value', prizeTierField: 'prize_tier', rarityField: 'rarity',
        asset: { ...EPIC_GATE_SETTLEMENT_ASSET },
      },
      buyback: { collectorProgramId: COLLECTOR_BUYBACK_PROGRAM_ID, collectorRecipient: COLLECTOR_BUYBACK_RECIPIENT, policy: { policy: buybackPolicy, rules: readTransactionPolicyRules(buybackPolicy) } },
    },
    budget: {
      availableProcessWei: AGGREGATE_FUNDING_ATOMIC.toString(),
      packPriceWei: UNIT_FUNDING_ATOMIC.toString(),
      outboundCapWei: '0',
      returnCapWei: '0',
      operatingMarginWei: '0',
    },
    standingAuthority: Object.freeze({
      documentDigest: standingAuthorityDocument.documentDigest,
      provider: standingAuthorityProvider,
    }),
    standingAuthorityStepAuthorization,
    contracts: {
      vault: `0x${'b'.repeat(40)}`, hook: COMPOSED_HOOK_ADDRESS, usdg: USDG, usdgDecimals: 6,
      treasury: `0x${'8'.repeat(40)}`, pool: null,
    },
    moneyConfiguration: productionMoneyConfiguration({
      minimums: { robinhoodReceive: { ...RELAY_FUNDING_ROUTE, amountAtomic: '0' }, solanaReceive: { ...RELAY_PURCHASE_ROUTE, amountAtomic: '0' } },
      evm: { perTransactionGasPriceCap:{...RELAY_FUNDING_ROUTE,amountAtomic:'3000000000'},nativeReserve: { ...RELAY_FUNDING_ROUTE, amountAtomic: '1000000000000000' } },
      solana: { priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '10000' },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' } },
    }),
    signerClient,
    preflightAuthority: createTestProfileMutationAuthority(),
    networkIdentity: {
      readEvmChainId: async () => 4663,
      readSolanaGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    },
    observability: {
      ...observability('https://n2-composed.invalid', directory, OPERATIONS_EVM_SIGNING_ADDRESS),
      startPreflight: { requiredSignerRoles: ['solana', 'evm'], requireEvmRpc: true, requireSolanaRpc: true },
    },
    observabilityDeps: {
      fetchImpl: async () => ({ ok: true, status: 204 }),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
    adapters: {
      robinhood: { client: robinhoodStub, historicalEvidenceClient: historicalEvidenceStub, archiveClient:runtime.client, secondaryLogClient:createPublicClient({transport:http("http://127.0.0.1:28545")}) },
      solana: { client: solanaClient },
      relay: relayStub,
      collectorCrypt,
    },
    reconciliationAdapters: {
      collectorCrypt, solana: { client: solanaClient }, relay: relayStub,
      robinhood: { client: robinhoodStub, historicalEvidenceClient: historicalEvidenceStub, archiveClient:runtime.client, secondaryLogClient:createPublicClient({transport:http("http://127.0.0.1:28545")}) },
    },
  };

  const composition = await compose(config);
  const originalShutdown = composition.shutdown.bind(composition);
  let shutdownPromise;
  composition.shutdown = () => shutdownPromise ??= originalShutdown();
  t.after(() => composition.shutdown());

  const server = createServer(createRequestListener(composition.dashboard.ctx));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(endpoint + path, { method: body ? 'POST' : 'GET',
      headers: { 'x-hookemon-proxy-credential': credential, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  assert.equal((await request('/operator/api/bootstrap')).status, 200);
  const catalogResponse = await request('/operator/api/packs');
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalogResponse.body.configured, true);
  const bootstrap = await request('/operator/api/bootstrap');
  if (needsInitialSelection) {
    assert.deepEqual((await readOperatorState(statePath)).configuration.packPlan.orders, []);
    const saved = await request('/operator/api/decisions', { requestId: `save-${cycleId}`, expectedVersion: bootstrap.body.state.version,
      command: { type: 'update-configuration', configuration: { packPlan: { orders: initialOrders } } } });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    const refreshed = await request('/operator/api/bootstrap');
    assert.ok(refreshed.body.state.version > bootstrap.body.state.version);
    assert.deepEqual(refreshed.body.state.packPlan.orders, initialOrders);
  }
  assert.deepEqual((await readOperatorState(statePath)).configuration.packPlan.orders, currentPlan.orders);
  let tickError = null;
  let tickOutcome;
  try {
    tickOutcome = await composition.service.runOnce({ liveMode: true });
  } catch (error) {
    tickError = error;
  }

  const repository = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  const cycle = await repository.describeCycle(cycleId);

  if(tickError && returnSourceSignature) {
    try {
      const source=await readReleaseBoundRelaySourceDebit({client:solanaClient,binding:nativePaymentBinding,signature:returnSourceSignature,owner:operator.publicKey.toBase58(),mint:SOLANA_MINT,amountAtomic:returnProceedsAtomic.toString(),signedTransactionBase64:returnSignedBytes.get(returnSourceSignature)});
      const leg=cycle.relayLegs.get(RELAY_RETURN_REQUEST_ID);
      relayStub.restoreIntent({intent:leg.returnAttribution.intent});
      const pointer=await relayStub.getTerminalDestinationTransactionPointer({intentDigest:leg.returnAttribution.intent.requestId});
      await readReturnLegDestinationProof({client:robinhoodStub,pointer,leg,sourceProof:source,nativePaymentBinding});
    }catch(error){console.error('RETURN PROOF DIAGNOSTIC',error.stack);}
  }
  const purchaseAttempt = await repository.readOperationalStageAttempt(cycleId, 'purchase');
  const buybackAttempt = await repository.readOperationalStageAttempt(cycleId, 'buyback');
  const returnAttempt = await repository.readOperationalStageAttempt(cycleId, 'return');
  const payoutAttempt = await repository.readOperationalStageAttempt(cycleId, 'payout');
  const diagnostics = () => JSON.stringify({ availabilityObservations,
    tickError: tickError ? { message: tickError.message, stack: tickError.stack } : null,
    stages: [...cycle.stages.keys()],
    prepared: [...cycle.preparedStages.keys()],
    purchaseAttemptState: purchaseAttempt?.attempt?.state ?? null,
    buybackAttemptState: buybackAttempt?.attempt?.state ?? null,
    returnAttemptState: returnAttempt?.attempt?.state ?? null,
    payoutAttemptState: payoutAttempt?.attempt?.state ?? null,
    terminalState: cycle.terminalState,
    terminalEvidence: cycle.terminalEvidence,
    stageStatuses: [...cycle.stages.entries()].map(([stage, record]) => [stage, record.status]),
    returnEvidence: cycle.stages.get('return')?.evidence ?? null,
    payoutEvidence: cycle.stages.get('payout')?.evidence ?? null,
    relayLegs: cycle.relayLegs ? [...cycle.relayLegs.entries()] : null,
    custodyLedgers: cycle.custodyLedgers ? [...cycle.custodyLedgers.entries()] : null,
    heldPositions: [...cycle.heldPositions.values()],
    calls, signSpy,
  });


  assert.equal(tickError,null,diagnostics());
  assert.equal(tickOutcome?.status, 'COMPLETE', JSON.stringify(tickOutcome));
  for (const stage of ['eligibility-snapshot','claim-process','outbound','purchase','open','epic-gate','buyback','return','payout']) assert.equal(cycle.stages.get(stage)?.status,'COMPLETE',stage);
  assert.equal(cycle.terminalState,'COMPLETED');
  const payout=cycle.stages.get('payout').evidence;
  assert.equal(payout.recipients.length,3, diagnostics());
  for (let i=0;i<runtime.holders.length;i++) {
    const recipient=payout.recipients.find(row=>row.recipient.toLowerCase()===runtime.holders[i]);
    assert.equal(recipient.state,'FINALIZED');
    const expected=BigInt(payout.distributablePool.amountAtomic)*runtime.quantities[i]/runtime.bought;
    assert.equal(BigInt(recipient.amount.amountAtomic),expected);
    assert.equal(await runtime.client.getBalance({address:runtime.holders[i]}),openingHolderBalances[i]+expected);
  }
  return { cycle, composition, request, catalog: catalogResponse.body };
}

async function forkProcessEvidence(runtime,cycleId) {
 const block=await runtime.client.getBlock({blockTag:'finalized'});
 const state=await createHistoricalErc20EvidenceClient({client:runtime.client}).readHookProcessStateAtBlock({hook:runtime.hook,onchainCycleId:deriveOnchainCycleId(cycleId),blockNumber:block.number,blockHash:block.hash});
 const fields=['processLiability','remainingProcessClaimCapacity','activeProcessClaimLimit','totalLiability','hookNativeBalance'];
 return {schema:'hookemon.process-liability-evidence.v2',...RELAY_FUNDING_ROUTE,hook:runtime.hook,cycleId,onchainCycleId:deriveOnchainCycleId(cycleId),blockNumber:block.number.toString(),blockHash:block.hash,finalized:true,...Object.fromEntries(fields.map(k=>[k,state[k].toString()])),processClaimsPaused:state.processClaimsPaused,processClaimCycleUsed:state.processClaimCycleUsed,isSolvent:state.isSolvent,operations:state.operations,ceilingAtomic:(state.processLiability<state.remainingProcessClaimCapacity?state.processLiability:state.remainingProcessClaimCapacity).toString()};
}
async function forkSnapshotConfiguration(runtime) {
 const launchManifest={supply:{chainId:'4663',assetId:runtime.token,decimals:18,amountAtomic:(await runtime.readToken('totalSupply')).toString()},hook:runtime.hook,poolManager:runtime.roles.manager,custody:runtime.custody,operations:runtime.operationsAccount.address.toLowerCase(),treasury:runtime.treasury,programmableRecipient:runtime.roles.programmable,launchContracts:[runtime.executor.toLowerCase(),runtime.account.address.toLowerCase()].sort(),burnAddresses:[],roleHistory:[]};
 return {hkmn:{address:runtime.token,decimals:18,deployBlock:runtime.deployBlock.toString()},eligibilitySnapshot:{finality:{policyId:'robinhood-stage-finality-v1',depth:'64'},primaryLogSourceId:'local-anvil-connection-a',secondaryLogSourceId:'local-anvil-connection-b',launchManifest,launchManifestDigest:digest({domain:'hookemon.eligibility-launch-manifest.v1',launchManifest}),feasibility:{measuredTransferGas:'21000',maxGasPriceWei:'3000000000',nativeReserveWei:'1000000000000000',nativeBalanceWei:(await runtime.client.getBalance({address:runtime.operationsAccount.address})).toString(),maxRecipientCount:3,maxTransactionCount:3}}};
}
function buybackCandidateTransaction({ operationsSolana, cardMint, offerAtomic, blockhash, recipient = COLLECTOR_BUYBACK_RECIPIENT, discriminator = BUYBACK_SETTLE_DISCRIMINATOR_HEX }) {
  const settlementAta = deriveAssociatedTokenAddress(operationsSolana, SOLANA_MINT).toBase58();
  const transaction = new Transaction({ feePayer: new PublicKey(operationsSolana), recentBlockhash: blockhash });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: BUYBACK_COMPUTE_UNIT_LIMIT }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(BUYBACK_PRIORITY_FEE_CAP_ATOMIC) }));
  const settleData = Buffer.alloc(24);
  Buffer.from(discriminator, 'hex').copy(settleData, 0);
  settleData.writeBigUInt64LE(offerAtomic, 8);
  settleData.writeBigUInt64LE(offerAtomic, 16);
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(COLLECTOR_BUYBACK_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(operationsSolana), isSigner: true, isWritable: true },
      { pubkey: COLLECTOR_AUTHORITY.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(cardMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(recipient), isSigner: false, isWritable: true },
    ],
    data: settleData,
  }));
  const transferData = Buffer.alloc(10);
  transferData.writeUInt8(12, 0);
  transferData.writeBigUInt64LE(offerAtomic, 1);
  transferData.writeUInt8(6, 9);
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(COLLECTOR_PROCEEDS_SOURCE), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(SOLANA_MINT), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(settlementAta), isSigner: false, isWritable: true },
      { pubkey: COLLECTOR_AUTHORITY.publicKey, isSigner: true, isWritable: false },
    ],
    data: transferData,
  }));
  transaction.partialSign(COLLECTOR_AUTHORITY);
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}
