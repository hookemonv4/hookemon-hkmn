// Production acceptance harness. This deliberately uses the literal CLI and loopback HTTP/RPC
// services; it has no composition, stage, signer, or authority injection seam.
import assert from 'node:assert/strict';
import { setup as nativeRelaySetup } from '../native/relay-native-proof-fixture.mjs';
import { createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { productionMoneyConfiguration } from '../../../runner/test/cycle/production-cycle.mjs';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signMessage } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi,
  parseTransaction, recoverTransactionAddress, toFunctionSelector, toHex, TransactionReceiptNotFoundError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import { createEmptyOperatorState, mutateOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';
import { assertCycleSnapshot } from '../../../runner/src/cycle/cycle-store.mjs';
import { createStandingAuthorityProvider, stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import { assertPolicyAdmission } from '../../../runner/src/automation/policy-engine.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createEligibilityPayoutManifest } from '../../../runner/src/distribution/pro-rata.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { buildClaimProcessCall } from '../../src/hook-contract-client.mjs';
import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
import { compose } from '../../src/app/compose.mjs';
import { assertPayoutManifestUnchanged } from '../../src/app/stages/payout.mjs';
import { supplementaryPayoutStageId } from '../../src/app/stages/supplementary-payout.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';
import {
  buildRelayLegacyTransaction, buildTransferCheckedInstruction, createSolanaRpcClient, deriveAssociatedTokenAddress,
  signedSolanaTransactionSignature, TOKEN_PROGRAM_ID, MPL_CORE_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
} from '../../src/solana-rpc.mjs';
import { COLLECTOR_PURCHASE_BINDING_SCHEMA, COLLECTOR_PURCHASE_BINDING_VERSION } from '../../src/signing/collector-purchase-policy.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA, COLLECTOR_BUYBACK_BINDING_VERSION } from '../../src/signing/collector-buyback-policy.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
  COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
  COLLECTOR_SYNTHETIC_API_KEY,
  RELAY_SYNTHETIC_API_KEY,
} from '../../src/signing/collector-production-binding.mjs';
import {
  createCanonicalTransactionPolicy, createTransactionPolicy, decodeProviderTransaction, evaluate as evaluateTransactionPolicy, readTransactionPolicyRules,
} from '../../src/signing/transaction-policy.mjs';
import { createRelayClient, createQuoteUsdValuation, DIRECTIONS as RELAY_DIRECTIONS, RELAY_CONSTANTS } from '../../src/relay-client.mjs';
import { OPERATOR_EVM_ROLE } from '../../src/signing/signer-client.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';

const execFileAsync = promisify(execFile);
const BIN_PATH = fileURLToPath(new URL('../../bin/hookemon-runner.mjs', import.meta.url));
const SOURCE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const ROBINHOOD_CHAIN_ID = 4663;
const RELAY_SOLANA_CHAIN_ID = 792703809;
const BALANCE_OF_SELECTOR = '0x70a08231';
// One pack costs 0.000008 settlement units, i.e. 8 atomic at 6 decimals, so an N=2 cycle targets 16.
const PACK_PRICE = '0.000008';
const PROCESS_NATIVE_WEI = 1_000_000n;
// Priced so the unit quote lands exactly on maxUnitPriceMicroUsd and the aggregate exactly on the
// per-cycle and 24-hour caps. The aggregate is deliberately NOT twice the unit: a linear pair would
// let a division or multiplication bug pass unnoticed.
const UNIT_FUNDING_ATOMIC = 17n;
const AGGREGATE_FUNDING_ATOMIC = 33n;
// Two packs at 8 atomic settlement-asset units each (PACK_PRICE at 6 decimals). This is the
// aggregate EXACT_OUTPUT destination amount the admission planner requests from Relay for the
// outbound leg, so it is also the exact-output Relay quote's requestId suffix and the exact owner
// token delta the outbound destination observation must prove.
const AGGREGATE_PURCHASE_ATOMIC = 16n;
const AGGREGATE_OUTBOUND_QUOTE_REQUEST_ID = `fixture-quote-${AGGREGATE_PURCHASE_ATOMIC}`;
// Not all-digit: the durable journal's canonical-value guard (assertBoundedCanonicalValue,
// packages/runner/src/cycle/journal.mjs) treats an all-digit string as a decimal literal and
// bounds its digit count, which a fabricated all-numeric "signature" would spuriously trip.
const OUTBOUND_DESTINATION_SIGNATURE = `${'z'.repeat(44)}${'4'.repeat(44)}`;

const RELAY_CHAINS = Object.freeze({
  chains: [
    { id: ROBINHOOD_CHAIN_ID, depositEnabled: true, erc20Currencies: [{ address: USDG, supportsBridging: true }, { address: `0x${'00'.repeat(20)}`, supportsBridging: true }] },
    { id: RELAY_SOLANA_CHAIN_ID, depositEnabled: true, solverCurrencies: [{ address: SOLANA_MINT }] },
  ],
});

// Selector -> encoded return for each hook getter admission reads. Values are generous enough to
// cover this fixture's tiny quotes; the point of the fixture is the read path, not the amounts.
const HOOK_LIABILITY_ATOMIC = 1_000_000n;
const HOOK_STATE_SELECTORS = new Map([
  [toFunctionSelector('function processLiability() view returns (uint256)'), () => abiUint(HOOK_LIABILITY_ATOMIC)],
  [toFunctionSelector('function remainingProcessClaimCapacity() view returns (uint256)'), () => abiUint(HOOK_LIABILITY_ATOMIC)],
  [toFunctionSelector('function activeProcessClaimLimit() view returns (uint256)'), () => abiUint(HOOK_LIABILITY_ATOMIC)],
  [toFunctionSelector('function totalLiability() view returns (uint256)'), () => abiUint(HOOK_LIABILITY_ATOMIC)],
  [toFunctionSelector('function hookEthBalance() view returns (uint256)'), () => abiUint(HOOK_LIABILITY_ATOMIC)],
  [toFunctionSelector('function processClaimsPaused() view returns (bool)'), () => abiUint(0n)],
  [toFunctionSelector('function processClaimCycleUsed(bytes32) view returns (bool)'), () => abiUint(0n)],
  [toFunctionSelector('function isSolvent() view returns (bool)'), () => abiUint(1n)],
  [
    toFunctionSelector('function readRoles(bytes32) view returns ((address,address,address),(bytes32,address,address),(bytes32,address,address),(bytes32,address))'),
    operations => encodeAbiParameters(
      [
        { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'address' }] },
        { type: 'tuple', components: [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }] },
        { type: 'tuple', components: [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }] },
        { type: 'tuple', components: [{ type: 'bytes32' }, { type: 'address' }] },
      ],
      [
        [operations, operations, operations],
        [`0x${'0'.repeat(64)}`, operations, operations],
        [`0x${'0'.repeat(64)}`, operations, operations],
        [`0x${'0'.repeat(64)}`, operations],
      ],
    ),
  ],
]);

function abiUint(value) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const RELAY_DEPOSIT_SELECTOR = toFunctionSelector('function depositNative(address depositor, bytes32 id)');
const RELAY_DEPOSITORY = `0x${'a'.repeat(40)}`;

function abiWord(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function abiAddressWord(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/**
 * The two unsigned EVM transactions Relay's own quote response carries for this route: the USDG
 * approval bounded to the depository, then the depository deposit binding sender, asset, amount and
 * order id. `extractRelayEvmTransactions` re-derives every one of those fields from this calldata,
 * so the fixture cannot smuggle a different spender, amount or order past outbound.
 */
function relayExecutionSteps({ requestId, orderId, originAmount, sender }) {
  return [{ kind: 'transaction', id: `deposit-${requestId}`, requestId, items: [{ data: {
    chainId: 4663, from: sender, to: RELAY_DEPOSITORY,
    data: `${RELAY_DEPOSIT_SELECTOR}${abiAddressWord(sender)}${orderId.slice(2)}`, value: originAmount,
    gas: '21000', maxFeePerGas: '2', maxPriorityFeePerGas: '1',
  } }] }];
}

/**
 * A Relay exact-output quote for the destination amount that was actually requested. The origin
 * USDG it reports is looked up per target rather than scaled, which is what makes this fixture able
 * to fail a planner that derives one quote from the other.
 */
function relayQuote(request) {
  const exactInput = request.tradeType === 'EXACT_INPUT';
  const destinationAmount = exactInput ? '1' : String(request.amount);
  const originAmount = exactInput ? String(request.amount) : destinationAmount === '8'
    ? UNIT_FUNDING_ATOMIC.toString()
    : AGGREGATE_FUNDING_ATOMIC.toString();
  const deadline = Math.floor(Date.now() / 1000) + 900;
  const sender = request.user;
  const recipient = request.recipient;
  const requestId = `fixture-quote-${destinationAmount}`;
  const orderId = `0x${destinationAmount.padStart(64, '0')}`;
  return {
    requestId,
    steps: relayExecutionSteps({ requestId, orderId, originAmount, sender }),
    details: {
      sender,
      recipient,
      currencyIn: { currency: { chainId: ROBINHOOD_CHAIN_ID, address: `0x${'00'.repeat(20)}`, symbol: 'ETH', decimals: 18 }, amount: originAmount, amountUsd: `${BigInt(originAmount) / 1000000n}.${(BigInt(originAmount) % 1000000n).toString().padStart(6, '0')}` },
      currencyOut: {
        currency: { chainId: RELAY_SOLANA_CHAIN_ID, address: SOLANA_MINT, symbol: 'CIRCLE_USD', decimals: 6 },
        amount: destinationAmount,
        minimumAmount: destinationAmount,
      },
    },
    protocol: {
      v2: {
        orderId,
        orderData: {
          output: {
            chainId: 'solana',
            deadline,
            calls: [],
            payments: [{
              recipient, currency: SOLANA_MINT, expectedAmount: destinationAmount, minimumAmount: destinationAmount,
            }],
          },
          inputs: [{
            payment: { chainId: 'robinhood', currency: `0x${'00'.repeat(20)}`, amount: originAmount, amountUsd: `${BigInt(originAmount) / 1000000n}.${(BigInt(originAmount) % 1000000n).toString().padStart(6, '0')}` },
            refunds: [{ chainId: 'robinhood', currency: `0x${'00'.repeat(20)}`, recipient: sender, deadline }],
          }],
        },
      },
    },
  };
}

// The loopback chain's execution semantics: it derives every emitted event from the calldata it was
// actually given, exactly as the deployed hook would. Nothing here is keyed on the runner's intent,
// so a transaction carrying a different cycle, amount, or destination emits a correspondingly
// different event and the stage's own receipt verification refuses it.
const HOOK_ABI = parseAbi([
  'function claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)',
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountAtomicUsdg, address indexed destination, uint256 timestamp, uint256 cap, uint256 usedAfter)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function executionLogs(parsed) {
  // The Relay depository deposit moves USDG from Operations to the depository. Outbound proves its
  // source leg from exactly that finalized transfer, so the chain has to emit it for the same bytes
  // it accepted -- decoded from the deposit calldata, never from what the runner intended.
  const data = parsed.data ?? '0x';
  let call;
  try {
    call = decodeFunctionData({ abi: HOOK_ABI, data });
  } catch {
    return [];
  }
  if (call.functionName !== 'claimProcess') return [];
  const [cycleId, amountAtomicUsdg, destination] = call.args;
  const amount = encodeAbiParameters([{ type: 'uint256' }], [amountAtomicUsdg]);
  return [
    {
      address: parsed.to,
      topics: encodeEventTopics({ abi: HOOK_ABI, eventName: 'ProcessClaimed', args: { cycleId, destination } }),
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [amountAtomicUsdg, 1n, amountAtomicUsdg, amountAtomicUsdg],
      ),
    },
  ];
}

/**
 * The Relay solver's own destination-side settlement transaction on Solana: a foreign chain event
 * this process never signs, so it cannot be derived from bytes this fixture received. It is
 * fabricated to match exactly what `discoverFinalizedRelayDestinationObservation`
 * (packages/adapters/src/solana-rpc.mjs) demands: one owner token-balance credit for the queried
 * owner, denominated in the requested mint, plus exactly one spl-memo instruction carrying the
 * Relay request id the outbound leg is durably keyed on.
 */
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

// Purchase's own settlement leg: the admitted per-pack price (aggregatePurchase / 2, matching this
// fixture's activateTwoPackPolicy admission) and a fixed Collector settlement recipient, pinned
// independently here -- before any candidate response exists -- exactly as
// collector-policy-offline-implementation-scope.md requires (never derive a destination, program,
// signer/account role, mint, decimals, amount, or memo grammar from candidate bytes). This literal
// is a syntactically valid but otherwise arbitrary base58 Solana address, the same shape convention
// already used by stages-collector-lifecycle.test.mjs's own fixture; it names no live account and
// carries no owner approval, provider identity, or runtime-ready policy.
const UNIT_PURCHASE_ATOMIC = AGGREGATE_PURCHASE_ATOMIC / 2n;
const COLLECTOR_SETTLEMENT_RECIPIENT = '8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe';
// Pack 0's own real buyback offer/settlement asset, independently pinned before any candidate
// `/api/buyback/available` response exists.
const EPIC_GATE_SETTLEMENT_ASSET = Object.freeze({ chainId: 'solana-mainnet', assetId: SOLANA_MINT, decimals: 6 });
const EPIC_GATE_SELL_OFFER_ATOMIC = '90';
// The one fixed blockhash this run's own `getLatestBlockhash` always reports (see fixtureServer
// below) -- named here so later candidate builders (buyback) reference the same real value the
// chain actually reports, never a separate literal that could silently drift from it.
const FIXED_LATEST_BLOCKHASH = '11111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// The literal CLI's own real Collector purchase policy (`HOOKEMON_COLLECTOR_PRODUCTION_BINDING_*`,
// resolved through the real `collector-production-binding.mjs` registry, never the Node-test-only
// fixture-binding seam) requires this exact four-instruction template
// (`assertCollectorPurchaseBindingV1`, collector-purchase-policy.mjs): a compute-unit-limit budget,
// a compute-unit-price budget, one SPL `TransferChecked` settlement debit, and one memo instruction
// carrying the provider co-signer. Pinned independently here, before any candidate exists.
const PURCHASE_PROVIDER_COSIGNER = Keypair.generate();
const PURCHASE_MEMO_PREFIX = 'collector-purchase:v1:';
const PURCHASE_COMPUTE_UNIT_LIMIT = 40_000;
// This literal CLI run's own `HOOKEMON_SOLANA_PRIORITY_FEE_CAP` is deliberately tiny ('2'); the
// pinned template's own priority fee must not exceed it, or `assertSolanaSignerFeeEnvelope`
// (solana-money-controls.mjs) correctly refuses before ever signing.
const PURCHASE_PRIORITY_FEE_CAP_ATOMIC = 2n;

/**
 * One syntactically valid, unsigned (except for the provider co-signer's own partial signature)
 * legacy Solana transaction for a single generated pack: the exact four-instruction template the
 * real registry-resolved purchase binding requires, ending in one exact SPL `TransferChecked` from
 * the isolated run's own Operations settlement ATA to the independently fixed
 * `COLLECTOR_SETTLEMENT_RECIPIENT`, for the admitted per-pack amount, and a memo instruction naming
 * this pack's own memo. Built entirely from this fixture's own already-configured identities/facts
 * -- never from a candidate response, since this is the request side. No trusted allowlist, policy,
 * or authority is constructed or implied here.
 */
function unsignedPurchaseTransaction(operationsSolana, memo) {
  const sourceAta = deriveAssociatedTokenAddress(operationsSolana, SOLANA_MINT);
  const transaction = new Transaction({ feePayer: new PublicKey(operationsSolana), recentBlockhash: '11111111111111111111111111111111' });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: PURCHASE_COMPUTE_UNIT_LIMIT }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(PURCHASE_PRIORITY_FEE_CAP_ATOMIC) }));
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(UNIT_PURCHASE_ATOMIC, 1);
  data.writeUInt8(6, 9);
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(SOLANA_MINT), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(COLLECTOR_SETTLEMENT_RECIPIENT), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(operationsSolana), isSigner: true, isWritable: true },
    ],
    data,
  }));
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: PURCHASE_PROVIDER_COSIGNER.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(`${PURCHASE_MEMO_PREFIX}${memo}`, 'utf8'),
  }));
  transaction.partialSign(PURCHASE_PROVIDER_COSIGNER);
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

/**
 * The real registry-resolved purchase binding (`assertCollectorPurchaseBindingV1`,
 * collector-purchase-policy.mjs) matching `unsignedPurchaseTransaction`'s own exact instruction
 * template above, byte for byte -- built independently, before any candidate ever exists, exactly
 * like every other pinned template in this file.
 */
function purchaseProductionBinding() {
  const computeBudgetProgramId = ComputeBudgetProgram.programId.toBase58();
  return Object.freeze({
    schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
    version: COLLECTOR_PURCHASE_BINDING_VERSION,
    provider: 'collector-crypt',
    chainId: NATIVE_SOLANA_CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    settlement: { destination: COLLECTOR_SETTLEMENT_RECIPIENT, mint: SOLANA_MINT, decimals: 6 },
    providerCoSigner: PURCHASE_PROVIDER_COSIGNER.publicKey.toBase58(),
    instructions: [
      {
        kind: 'compute-budget-set-unit-limit', programId: computeBudgetProgramId, accounts: [],
        computeUnitLimit: PURCHASE_COMPUTE_UNIT_LIMIT, priorityFeeCapAtomic: null, memoPrefix: null,
      },
      {
        kind: 'compute-budget-set-unit-price', programId: computeBudgetProgramId, accounts: [],
        computeUnitLimit: null, priorityFeeCapAtomic: PURCHASE_PRIORITY_FEE_CAP_ATOMIC.toString(), memoPrefix: null,
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
        kind: 'unknown', programId: MEMO_PROGRAM_ID,
        accounts: [{ role: 'provider-co-signer', isSigner: true, isWritable: false }],
        computeUnitLimit: null, priorityFeeCapAtomic: null, memoPrefix: PURCHASE_MEMO_PREFIX,
      },
    ],
  });
}

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

// Pack 0's own real held-card sale, once epic-gate reconciles it to a real `sell` decision:
// pinned program/authority/recipient/discriminator/fee facts, before any candidate ever exists,
// exactly mirroring `purchaseProductionBinding` above.
const COLLECTOR_AUTHORITY = Keypair.generate();
const COLLECTOR_BUYBACK_RECIPIENT = Keypair.generate().publicKey.toBase58();
const COLLECTOR_BUYBACK_PROGRAM_ID = Keypair.generate().publicKey.toBase58();
const COLLECTOR_PROCEEDS_SOURCE = Keypair.generate().publicKey.toBase58();
const BUYBACK_SETTLE_DISCRIMINATOR_HEX = 'a1b2c3d4e5f60718';
const BUYBACK_COMPUTE_UNIT_LIMIT = 40_000;
// This literal CLI run's own `HOOKEMON_SOLANA_PRIORITY_FEE_CAP` is deliberately tiny ('2'), same
// reasoning as `PURCHASE_PRIORITY_FEE_CAP_ATOMIC` above.
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

/**
 * One syntactically valid, unsigned (except for the collector authority's own partial signature)
 * legacy Solana transaction for pack 0's own real held-card sale: the exact four-instruction
 * template the real registry-resolved buyback binding requires above -- a settle call to the
 * pinned Collector program, then one exact SPL `TransferChecked` moving the real quoted proceeds
 * from the pinned Collector proceeds source to the operator's own real settlement ATA.
 */
function buybackCandidateTransaction({ operationsSolana, cardMint, offerAtomic, blockhash }) {
  const settlementAta = deriveAssociatedTokenAddress(operationsSolana, SOLANA_MINT).toBase58();
  const transaction = new Transaction({ feePayer: new PublicKey(operationsSolana), recentBlockhash: blockhash });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: BUYBACK_COMPUTE_UNIT_LIMIT }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(BUYBACK_PRIORITY_FEE_CAP_ATOMIC) }));
  const settleData = Buffer.alloc(24);
  Buffer.from(BUYBACK_SETTLE_DISCRIMINATOR_HEX, 'hex').copy(settleData, 0);
  settleData.writeBigUInt64LE(offerAtomic, 8);
  settleData.writeBigUInt64LE(offerAtomic, 16);
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(COLLECTOR_BUYBACK_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(operationsSolana), isSigner: true, isWritable: true },
      { pubkey: COLLECTOR_AUTHORITY.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(cardMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(COLLECTOR_BUYBACK_RECIPIENT), isSigner: false, isWritable: true },
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


async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fixtureServer(t, directory, operationsAccount = () => `0x${'0'.repeat(40)}`, operationsSolanaAccount = () => null) {
  const paths = {
    caKey: join(directory, 'ca-key.pem'), caCert: join(directory, 'ca-cert.pem'),
    key: join(directory, 'tls-key.pem'), request: join(directory, 'tls-request.pem'),
    cert: join(directory, 'tls-cert.pem'), extensions: join(directory, 'tls-ext.cnf'),
    requestConfig: join(directory, 'tls-request.cnf'),
  };
  await writeFile(paths.requestConfig, '[req]\ndistinguished_name=req_dn\n[req_dn]\n');
  await execFileAsync('/usr/bin/openssl', ['req', '-config', paths.requestConfig, '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', paths.caKey, '-out', paths.caCert, '-subj', '/CN=HKMN graph fixture']);
  await execFileAsync('/usr/bin/openssl', ['req', '-config', paths.requestConfig, '-newkey', 'rsa:2048', '-nodes', '-keyout', paths.key, '-out', paths.request, '-subj', '/CN=127.0.0.1']);
  await writeFile(paths.extensions, 'subjectAltName=IP:127.0.0.1\n');
  await execFileAsync('/usr/bin/openssl', ['x509', '-req', '-in', paths.request, '-CA', paths.caCert, '-CAkey', paths.caKey, '-CAcreateserial', '-out', paths.cert, '-days', '1', '-extfile', paths.extensions]);
  const [key, cert] = await Promise.all([readFile(paths.key), readFile(paths.cert)]);
  const calls = {
    evm: 0, solana: 0, methods: [], quotes: [],
    // Purchase's own Collector mutation endpoints. Tracked explicitly (rather than left to the
    // generic 404 branch below) so the graph can assert exactly how many times each was reached,
    // instead of only inferring it from the absence of a durable batch record.
    collectorGenerateYoloPacks: 0, collectorPackStatus: 0, collectorSubmitTransaction: 0,
    collectorOpenPack: 0, collectorGetNfts: 0, collectorBuybackAvailable: 0, collectorBuybackCheck: 0, collectorBuyback: 0,
  };
  const broadcasts = new Map();
  const returnTemplates = new Map();
  const returnTransactions = new Map();
  const balanceEvents = [];
  const sourceRuntimeFixture = await nativeRelaySetup({ runtimeMutation: observation => { const bytes = Buffer.from(observation.value[1].data[0], 'base64'); bytes.writeBigUInt64LE(1n, 4); observation.value[1].data[0] = bytes.toString('base64'); } });
  let holdersChanged = false;
  let holdersChangedAt = null;
  const offerForMemo = memo => memo === 'graph-purchase-pack-1' ? '45' : EPIC_GATE_SELL_OFFER_ATOMIC;
  let finalizedHeight = 97;
  const blockHash = height => `0x${BigInt(height).toString(16).padStart(64, '0')}`;
  const blockTimestamp = Math.floor(Date.now() / 1000);
  const blockTimestamps = new Map();
  function transferLog(from, to, amount) {
    return { address: USDG, topics: [ERC20_TRANSFER_TOPIC, `0x${abiAddressWord(from)}`, `0x${abiAddressWord(to)}`], data: `0x${abiWord(amount)}` };
  }
  function balanceAt(account, height) {
    let balance = [RELAY_RETURN_SOLVER_EVM.toLowerCase(), `0x${'c'.repeat(40)}`].includes(account) ? PROCESS_NATIVE_WEI : account === operationsAccount().toLowerCase() ? 400000n : 0n;
    for (const event of balanceEvents) if (event.height <= height) {
      if (event.from === account) balance -= event.amount;
      if (event.to === account) balance += event.amount;
    }
    return balance;
  }
  // Every purchase settlement transaction this fixture has actually accepted, keyed by its own
  // real signature and derived only from that signature's own decoded bytes -- never from
  // submission order or index. A resubmission of the identical signed bytes is idempotent (the
  // same signature maps to the same already-stored memo/amount, never a second allocation); a
  // reordered, retried, or tampered candidate can never be misattributed to the wrong memo or
  // credited with an amount its own bytes did not actually carry.
  const acceptedPurchaseTransactionsBySignature = new Map();
  // Each pack's own real award (card mint + open transaction signature) and epic-gate facts,
  // independently pinned before any candidate `/api/openPack` request ever exists. Pack 0
  // reconciles to a real `sell` decision; pack 1 follows the documented buyback-unavailable held
  // path -- never a distorted or invented below-40% construction.
  const cardAwardsByMemo = new Map([
    ['graph-purchase-pack-0', { mint: Keypair.generate().publicKey.toBase58(), signature: Keypair.generate().publicKey.toBase58() }],
    ['graph-purchase-pack-1', { mint: Keypair.generate().publicKey.toBase58(), signature: Keypair.generate().publicKey.toBase58() }],
  ]);
  const epicGateFactsByMemo = new Map([
    ['graph-purchase-pack-0', { prizeTier: 4, rarity: 'common', insuredValue: 100, buybackAvailable: true }],
    ['graph-purchase-pack-1', { prizeTier: 3, rarity: 'uncommon', insuredValue: 50, buybackAvailable: false }],
  ]);
  const openedPurchaseMemos = new Set();
  // Every buyback settlement transaction this fixture has actually accepted, keyed by its own real
  // signature and derived only from that signature's own decoded bytes -- same idempotence/
  // integrity reasoning as `acceptedPurchaseTransactionsBySignature` above.
  const acceptedBuybackTransactionsBySignature = new Map();
  // The exact unsigned message bytes this fixture itself generated for each real memo -- the one
  // independently frozen template a submitted candidate's own message must match byte for byte,
  // never merely "some transfer instruction with the right numbers found somewhere in the
  // instruction list." Populated only at generation time, before any candidate exists.
  const purchaseUnsignedMessagesByMemo = new Map();
  const buybackUnsignedMessagesByMemo = new Map();
  let beforeEligibilityResponse = async () => {};
  const server = createServer({ key, cert }, async (request, response) => {
    if (request.url === '/alert') { response.writeHead(204); response.end(); return; }
    if (request.url === '/chains') { respond(response, RELAY_CHAINS); return; }
    // `new URL('/api/machines', base)` resolves against the origin, so the configured `/collector`
    // prefix is not part of the request path the client actually sends.
    if (request.url === '/api/machines') {
      respond(response, { machines: [{ code: 'return-fixture', price: PACK_PRICE, contains: 1, instantBuyback: 90 }] });
      return;
    }
    // Purchase's own Collector mutation endpoints. Independently configured here -- exactly two
    // unique memos, each carrying a syntactically valid unsigned transaction for the isolated run's
    // own Operations address -- before any candidate ever exists; nothing here reads back or
    // derives an allowlist, destination, signer/account role, mint, decimals, amount, or memo
    // grammar from what purchase.mjs later does with these bytes.
    if (request.url === '/api/generateYoloPacks') {
      calls.collectorGenerateYoloPacks += 1;
      const generateRequest = await body(request);
      const operationsSolana = operationsSolanaAccount();
      if (generateRequest.playerAddress !== operationsSolana || generateRequest.quantity !== 2) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unexpected generateYoloPacks request shape', received: generateRequest }));
        return;
      }
      respond(response, {
        packs: [0, 1].map(packIndex => {
          const memo = `graph-purchase-pack-${packIndex}`;
          const transaction = unsignedPurchaseTransaction(operationsSolana, memo);
          purchaseUnsignedMessagesByMemo.set(memo, Transaction.from(Buffer.from(transaction, 'base64')).serializeMessage());
          return { memo, transaction };
        }),
      });
      return;
    }
    // Purchase's and buyback's own shared settlement broadcast endpoint. Fully verifies the
    // submitted signed bytes before ever recording an accepted effect: every signature must
    // cryptographically verify against the transaction's own message (`decoded.verifySignatures()`
    // -- never merely a nonzero extracted first signature), and that exact message must match, byte
    // for byte, one of this fixture's own independently generated unsigned templates (never "the
    // first matching transfer/memo instruction found somewhere in the list") -- so a wrong
    // decimals/authority/destination, an extra or conflicting instruction, or any other deviation
    // from the pinned template is refused outright, not partially accepted. A resubmission is only
    // ever treated as an idempotent retry when its own complete wire bytes are byte-identical to
    // what this fixture already durably accepted for that exact signature; a same-signature
    // different-message submission (impossible for genuinely valid signatures, refused anyway for
    // defense in depth) is refused, never silently treated as a repeat.
    if (request.url === '/api/submitTransaction') {
      calls.collectorSubmitTransaction += 1;
      const { signedTransaction } = await body(request);
      if (typeof signedTransaction !== 'string' || Buffer.from(signedTransaction, 'base64').toString('base64') !== signedTransaction) {
        response.writeHead(422, {'content-type': 'application/json'});
        response.end(JSON.stringify({error: 'signed transaction must use canonical base64 wire bytes'}));
        return;
      }
      const wireDigest = `sha256:${createHash('sha256').update(Buffer.from(signedTransaction, 'base64')).digest('hex')}`;
      const signature = signedSolanaTransactionSignature(signedTransaction);
      const existingPurchase = acceptedPurchaseTransactionsBySignature.get(signature);
      if (existingPurchase !== undefined) {
        if (existingPurchase.rawBytes !== signedTransaction) {
          response.writeHead(422, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'production graph fixture: resubmitted signature does not match its already-accepted transaction bytes' }));
          return;
        }
        respond(response, { success: true, signature, confirmationStatus: 'finalized' });
        return;
      }
      const existingBuyback = acceptedBuybackTransactionsBySignature.get(signature);
      if (existingBuyback !== undefined) {
        if (existingBuyback.rawBytes !== signedTransaction) {
          response.writeHead(422, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'production graph fixture: resubmitted signature does not match its already-accepted transaction bytes' }));
          return;
        }
        respond(response, { success: true, signature, confirmationStatus: 'finalized' });
        return;
      }
      let decoded;
      let verified = false;
      try {
        decoded = Transaction.from(Buffer.from(signedTransaction, 'base64'));
        verified = decoded.verifySignatures();
      } catch {
        verified = false;
      }
      if (!verified) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'production graph fixture: submitted transaction signatures do not verify' }));
        return;
      }
      const message = decoded.serializeMessage();
      const purchaseMemo = [...purchaseUnsignedMessagesByMemo.entries()]
        .find(([, template]) => Buffer.compare(template, message) === 0)?.[0] ?? null;
      if (purchaseMemo !== null) {
        const memoAlreadyClaimed = [...acceptedPurchaseTransactionsBySignature.values()].some(entry => entry.memo === purchaseMemo);
        if (memoAlreadyClaimed) {
          response.writeHead(422, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'production graph fixture: this memo already has an accepted purchase transaction' }));
          return;
        }
        acceptedPurchaseTransactionsBySignature.set(signature, Object.freeze({ memo: purchaseMemo, amountAtomic: decoded.instructions[2].data.readBigUInt64LE(1), rawBytes: signedTransaction, wireDigest }));
        respond(response, { success: true, signature, confirmationStatus: 'finalized' });
        return;
      }
      const buybackMemo = [...buybackUnsignedMessagesByMemo.entries()]
        .find(([, template]) => Buffer.compare(template, message) === 0)?.[0] ?? null;
      if (buybackMemo !== null) {
        const memoAlreadyClaimed = [...acceptedBuybackTransactionsBySignature.values()].some(entry => entry.memo === buybackMemo);
        if (memoAlreadyClaimed) {
          response.writeHead(422, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'production graph fixture: this memo already has an accepted buyback transaction' }));
          return;
        }
        acceptedBuybackTransactionsBySignature.set(signature, Object.freeze({ memo: buybackMemo, amountAtomic: decoded.instructions.at(-1).data.readBigUInt64LE(1), rawBytes: signedTransaction, wireDigest }));
        respond(response, { success: true, signature, confirmationStatus: 'finalized' });
        return;
      }
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'production graph fixture: submitted transaction does not match any pinned policy template' }));
      return;
    }
    // Reports the real award once purchase's own settlement signature has actually been recorded
    // for this exact memo -- never before, and never a fabricated award for an unknown memo.
    if (request.url.startsWith('/api/pack/status')) {
      calls.collectorPackStatus += 1;
      const memo = new URL(request.url, 'https://fixture.invalid').searchParams.get('memo');
      const found = [...acceptedPurchaseTransactionsBySignature.entries()].find(([, entry]) => entry.memo === memo);
      if (found === undefined) {
        respond(response, { memo, pack: null, send: null, buyback: [] });
        return;
      }
      const [signature] = found;
      const award = cardAwardsByMemo.get(memo);
      const epicFacts = epicGateFactsByMemo.get(memo);
      const send = openedPurchaseMemos.has(memo)
        ? {
          transaction_signature: award.signature, nft_address: award.mint, to_wallet: operationsSolanaAccount(),
          prize_tier: epicFacts.prizeTier, insured_value: epicFacts.insuredValue,
        }
        : null;
      respond(response, {
        memo, pack: { transaction_signature: signature, token_mint: SOLANA_MINT, nft_address: null, pack_type: 'return-fixture' },
        send, buyback: [],
      });
      return;
    }
    // The real documented award shape (collector-crypt.mjs's `assertOpenPackResponse`): `success`
    // plus the card's own mint and the provider's own settlement signature for the open. Marking
    // the memo opened here, not before, is what lets `/api/pack/status` above truthfully withhold
    // the memo-bound `send` award until this provider mutation has actually happened.
    if (request.url === '/api/openPack') {
      calls.collectorOpenPack += 1;
      const { memo } = await body(request);
      const award = cardAwardsByMemo.get(memo);
      if (award === undefined) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'production graph fixture: openPack called for unknown memo' }));
        return;
      }
      openedPurchaseMemos.add(memo);
      respond(response, { success: true, nft_address: award.mint, transaction_signature: award.signature });
      return;
    }
    // The documented `getNfts` pagination shape (get-nfts.json): one page carrying both cards' own
    // already-pinned rarity/insured-value records, independently of any candidate call.
    if (request.url.startsWith('/api/getNfts')) {
      calls.collectorGetNfts += 1;
      const query = new URL(request.url, 'https://fixture.invalid').searchParams;
      const page = Number(query.get('page'));
      const limit = Number(query.get('limit'));
      const nfts = [...cardAwardsByMemo.entries()].map(([memo, award]) => {
        const facts = epicGateFactsByMemo.get(memo);
        return { nft_address: award.mint, rarity: facts.rarity, insured_value: facts.insuredValue };
      });
      // Echoes back exactly the page/limit actually requested -- `findMintCard`'s own pagination
      // contract (open.mjs/epic-gate.mjs) requires the response to name the same values the
      // request carried, never a fixture-invented pair.
      respond(response, { nfts, hasMore: false, page, limit });
      return;
    }
    // The documented `buyback/available` shape, already normalized onto the typed settlement asset
    // exactly as collector-crypt.mjs's own real client parses it.
    if (request.url.startsWith('/api/buyback/available')) {
      calls.collectorBuybackAvailable += 1;
      const nft = new URL(request.url, 'https://fixture.invalid').searchParams.get('nft');
      const entry = [...cardAwardsByMemo.entries()].find(([, award]) => award.mint === nft);
      if (entry === undefined) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'production graph fixture: getBuybackAvailable called for unknown card' }));
        return;
      }
      const facts = epicGateFactsByMemo.get(entry[0]);
      if (!facts.buybackAvailable) {
        respond(response, { available: false });
        return;
      }
      respond(response, { available: true, amount: offerForMemo(entry[0]) });
      return;
    }
    // The documented `buyback` mutation: one real unsigned Collector buyback transaction, built
    // here -- lazily, at call time, never before -- from the same independently pinned program/
    // recipient/instruction-data literals the registry-resolved buyback binding above was built
    // from, using this run's own real Operations Solana identity and pack 0's own real blockhash
    // context.
    if (request.url === '/api/buyback') {
      calls.collectorBuyback += 1;
      const { playerAddress, nftAddress } = await body(request);
      const entry = [...cardAwardsByMemo.entries()].find(([, award]) => award.mint === nftAddress);
      if (entry === undefined || playerAddress !== operationsSolanaAccount()) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'production graph fixture: buyback called for unknown card or wallet' }));
        return;
      }
      const [memo] = entry;
      const serializedTransaction = buybackCandidateTransaction({
        operationsSolana: operationsSolanaAccount(), cardMint: nftAddress,
        offerAtomic: BigInt(offerForMemo(memo)), blockhash: FIXED_LATEST_BLOCKHASH,
      });
      buybackUnsignedMessagesByMemo.set(memo, Transaction.from(Buffer.from(serializedTransaction, 'base64')).serializeMessage());
      respond(response, {
        success: true, serializedTransaction, memo,
        refundAmount: offerForMemo(memo),
      });
      return;
    }
    // The documented `buyback/check` shape: only ever consulted for pack 0's own already-broadcast
    // buyback, and only once this fixture's own `submitTransaction` has actually recorded a
    // signature for it -- reconciliation must never observe a completed check before that.
    if (request.url.startsWith('/api/buyback/check')) {
      calls.collectorBuybackCheck += 1;
      const memo = new URL(request.url, 'https://fixture.invalid').searchParams.get('memo');
      const found = [...acceptedBuybackTransactionsBySignature.entries()].find(([, entry]) => entry.memo === memo);
      if (found === undefined) {
        respond(response, { exists: false });
        return;
      }
      const [signature] = found;
      const award = cardAwardsByMemo.get(memo);
      respond(response, {
        exists: true, status: 'complete', playerWallet: operationsSolanaAccount(),
        nft: award.mint, transactionSignature: signature,
        buybackAmount: offerForMemo(memo), createdAt: '2026-09-07T00:00:00.000Z',
      });
      return;
    }
    if (request.url === '/quote/v2') {
      const quoteRequest = await body(request);
      calls.quotes.push({ amount: quoteRequest.amount, tradeType: quoteRequest.tradeType });
      if (String(quoteRequest.originChainId) === String(RELAY_SOLANA_CHAIN_ID)) {
        const instruction = relayReturnInstruction({ source: deriveAssociatedTokenAddress(operationsSolanaAccount(), SOLANA_MINT).toBase58(), destination: RELAY_RETURN_DEPOSITORY_SOLANA, owner: operationsSolanaAccount(), mint: SOLANA_MINT, amount: BigInt(quoteRequest.amount), decimals: 6, orderId: quoteRequest.amount === '45' ? RELAY_SUPPLEMENTARY_RETURN_ORDER_ID : RELAY_RETURN_ORDER_ID });
        const raw = relayReturnQuoteRawResponse({ sender: quoteRequest.user, recipient: quoteRequest.recipient, amountAtomic: quoteRequest.amount, instruction, ...(quoteRequest.amount === '45' ? {requestId: RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID, orderId: RELAY_SUPPLEMENTARY_RETURN_ORDER_ID} : {}) });
        const unsigned = buildRelayLegacyTransaction({ feePayer: operationsSolanaAccount(), recentBlockhash: FIXED_LATEST_BLOCKHASH, instructionPlan: { instructions: [instruction], addressLookupTableAddresses: [] } });
        returnTemplates.set(raw.requestId, { message: Transaction.from(Buffer.from(unsigned, 'base64')).serializeMessage(), amount: BigInt(quoteRequest.amount), recipient: quoteRequest.recipient });
        respond(response, raw);
      } else respond(response, relayQuote(quoteRequest));
      return;
    }
    if (request.url.startsWith('/intents/status/v3')) {
      const id = new URL(request.url, 'https://fixture.invalid').searchParams.get('requestId');
      const entry = [...returnTransactions.values()].find(value => value.requestId === id);
      respond(response, entry ? { status: 'success', originChainId: RELAY_SOLANA_CHAIN_ID, destinationChainId: ROBINHOOD_CHAIN_ID, txHashes: [entry.destinationHash] } : {status: 'pending', txHashes: []});
      return;
    }
    if (!['/rpc', '/archive', '/solana'].includes(request.url)) { response.writeHead(404); response.end(); return; }
    const rpc = await body(request);
    const reply = result => respond(response, { jsonrpc: '2.0', id: rpc.id, result });
    if (request.url !== '/solana') {
      calls.evm += 1;
      calls.methods.push(`evm:${rpc.method}`);
      if (rpc.method === 'eth_chainId') return reply('0x1237');
      if (rpc.method === 'eth_getTransactionCount') return reply(toHex([...broadcasts.values()].filter(entry => entry.from === operationsAccount().toLowerCase()).length));
      if (rpc.method === 'eth_getBalance') return reply(toHex(balanceAt(rpc.params[0].toLowerCase(), rpc.params[1] === 'latest' || rpc.params[1] === 'finalized' ? finalizedHeight : Number(BigInt(rpc.params[1])))));
      if (rpc.method === 'eth_getCode') return reply('0x6000');
      if (rpc.method === 'eth_maxPriorityFeePerGas') return reply('0x1');
      if (rpc.method === 'eth_gasPrice') return reply('0x2');
      if (rpc.method === 'eth_estimateGas') return reply('0x5208');
      if (rpc.method === 'eth_getBlockByNumber') {
        const number = ['latest', 'finalized'].includes(rpc.params?.[0]) ? toHex(finalizedHeight) : rpc.params?.[0];
        // One uniform canonical hash for every block, deliberately: the loopback chain has no real
        // reorg surface, so every block is trivially its own valid parent under this single-hash
        // scheme, and the outbound source-finality proof's own-parent/canonical checks
        // (readCanonicalBlockWithParent, packages/adapters/src/robinhood-rpc.mjs) can bind against
        // it exactly like a real chain's block hash and parent hash would agree across two reads.
        return reply({ number, hash: blockHash(number), parentHash: blockHash(BigInt(number) - 1n), timestamp: toHex(blockTimestamps.get(Number(number)) ?? blockTimestamp), baseFeePerGas: '0x1' });
      }
      if (rpc.method === 'eth_getLogs') {
        await beforeEligibilityResponse();
        const filter = rpc.params?.[0] ?? {};
        const from = BigInt(filter.fromBlock ?? '0x0');
        const to = BigInt(filter.toBlock ?? '0x0');
        const logs = from <= 1n && to >= 1n ? [{
        address: `0x${'d'.repeat(40)}`,
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${'9'.repeat(40)}`],
        data: `0x${'1'.padStart(64, '0')}`, blockNumber: '0x1', logIndex: '0x0', blockHash: blockHash(1), removed: false,
        }] : [];
        if (holdersChangedAt !== null && from <= BigInt(holdersChangedAt) && to >= BigInt(holdersChangedAt)) logs.push({
          address: `0x${'d'.repeat(40)}`, topics: [ERC20_TRANSFER_TOPIC, `0x${abiAddressWord(`0x${'9'.repeat(40)}`)}`, `0x${abiAddressWord(`0x${'2'.repeat(40)}`)}`],
          data: abiUint(1n), blockNumber: toHex(holdersChangedAt), blockHash: blockHash(holdersChangedAt), logIndex: '0x0', removed: false,
        });
        return reply(logs);
      }
      // The hook's process-liability ledger and claim controls, answered from the isolated fixture
      // state at whatever height was asked for. Admission reads these through the real archive
      // capability, so the block and hash binding runs against these values rather than around them.
      if (rpc.method === 'eth_call') {
        const call = rpc.params?.[0] ?? {};
        const selector = (call.data ?? '').slice(0, 10).toLowerCase();
        const hookValue = HOOK_STATE_SELECTORS.get(selector);
        if (hookValue !== undefined) return reply(hookValue(operationsAccount()));
      }
      // balanceOf is answered with real process funds; every other static call keeps returning zero.
      // At the two canonical blocks the outbound source-finality proof actually reads around the
      // deposit's inclusion (block 1 before, block 2 at inclusion), Operations' and the Relay
      // depository's balances move by exactly the deposit's own recorded amount, so the independent
      // historical-balance delta this proof requires
      // (readFinalizedErc20TransferProof/readHistoricalTransferBalances,
      // packages/adapters/src/robinhood-rpc.mjs) is derived from the same bytes the deposit
      // transaction actually carried, not asserted as a constant.
      if (rpc.method === 'eth_call') {
        const data = rpc.params?.[0]?.data ?? '';
        if (!data.startsWith(BALANCE_OF_SELECTOR)) return reply(`0x${'0'.repeat(64)}`);
        const account = `0x${data.slice(-40)}`.toLowerCase();
        const blockTag = rpc.params?.[1];
        const blockNumber = typeof blockTag === 'string' && blockTag.startsWith('0x') ? parseInt(blockTag, 16) : null;
        if (rpc.params?.[0]?.to?.toLowerCase() === `0x${'d'.repeat(40)}`) {
          const changed = holdersChangedAt !== null && (blockNumber ?? finalizedHeight) >= holdersChangedAt;
          return reply(abiUint(account === (changed ? `0x${'2'.repeat(40)}` : `0x${'9'.repeat(40)}`) ? 1n : 0n));
        }
        return reply(abiUint(balanceAt(account, blockNumber ?? finalizedHeight)));
      }
      // The loopback chain accepts raw bytes and reports them back; it never invents a transaction.
      // A receipt exists only for bytes this endpoint was actually handed, under the hash those
      // exact bytes keccak to, so nothing here can manufacture finality for an unsigned or
      // unsubmitted transaction. Inclusion is at block 2 while latest/finalized stay at 10, which
      // keeps the configured finality depth satisfied deterministically.
      if (rpc.method === 'eth_sendRawTransaction') {
        const raw = rpc.params?.[0];
        if (typeof raw !== 'string' || !raw.startsWith('0x')) {
          return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'raw transaction is invalid' } });
        }
        const hash = keccak256(raw);
        const parsed = parseTransaction(raw);
        const sender = await recoverTransactionAddress({ serializedTransaction: raw });
        if (broadcasts.has(hash)) { assert.equal(broadcasts.get(hash).raw, raw); return reply(hash); }
        const height = ++finalizedHeight;
        blockTimestamps.set(height, Math.floor(Date.now() / 1000));
        let logs = executionLogs(parsed);
        balanceEvents.push({ height, from: sender.toLowerCase(), to: null, amount: 42000n });
        if ((parsed.value ?? 0n) > 0n) balanceEvents.push({ height, from: sender.toLowerCase(), to: parsed.to.toLowerCase(), amount: parsed.value });
        if (logs.some(log => log.address.toLowerCase() === `0x${'c'.repeat(40)}`)) {
          const claim = decodeFunctionData({ abi: HOOK_ABI, data: parsed.data });
          balanceEvents.push({ height, from: parsed.to.toLowerCase(), to: claim.args[2].toLowerCase(), amount: claim.args[1] });
        }
        broadcasts.set(hash, { hash, raw, parsed, from: sender.toLowerCase(), logs, height });
        return reply(hash);
      }
      if (rpc.method === 'eth_getTransactionReceipt' || rpc.method === 'eth_getTransactionByHash') {
        const sent = broadcasts.get(rpc.params?.[0]);
        if (!sent) return reply(null);
        const { parsed: tx } = sent;
        const common = {
          transactionHash: sent.hash, blockNumber: toHex(sent.height), blockHash: blockHash(sent.height),
          transactionIndex: '0x0', from: sent.from, to: tx.to ?? null, type: '0x2',
        };
        // Echoed from the decoded raw bytes, never from the runner's own intent: an equivalence
        // check against this endpoint is therefore a real check of what was actually submitted.
        return reply(rpc.method === 'eth_getTransactionByHash'
          ? {
            ...common, hash: sent.hash, input: tx.data ?? '0x', nonce: toHex(tx.nonce ?? 0),
            value: toHex(tx.value ?? 0n), gas: toHex(tx.gas ?? 0n), chainId: toHex(tx.chainId ?? 0),
            maxFeePerGas: toHex(tx.maxFeePerGas ?? 0n), maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas ?? 0n),
            accessList: tx.accessList ?? [], r: tx.r, s: tx.s, v: toHex(tx.v ?? 0n), yParity: toHex(tx.yParity ?? 0),
          }
          : {
            ...common, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x2',
            logs: sent.logs.map((log, index) => ({
              ...log, blockNumber: toHex(sent.height), blockHash: blockHash(sent.height), transactionHash: sent.hash,
              transactionIndex: '0x0', logIndex: toHex(index), removed: false,
            })),
            logsBloom: `0x${'0'.repeat(512)}`, contractAddress: null,
          });
      }
      return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled EVM ${rpc.method}` } });
    }
    calls.solana += 1;
    calls.methods.push(`solana:${rpc.method}`);
    if (rpc.method === 'sendTransaction') {
      const [wire] = rpc.params;
      const transaction = Transaction.from(Buffer.from(wire, 'base64'));
      assert.equal(transaction.verifySignatures(), true);
      const signature = signedSolanaTransactionSignature(wire);
      if (returnTransactions.has(signature)) { assert.equal(returnTransactions.get(signature).wire, wire); return reply(signature); }
      const [requestId, template] = [...returnTemplates].find(([, value]) => value.message.equals(transaction.serializeMessage())) ?? [];
      assert.ok(template, 'return must exactly match its independently issued quote');
      const amount = transaction.instructions[0].data.readBigUInt64LE(8);
      assert.equal(amount, template.amount);
      const height = ++finalizedHeight;
      blockTimestamps.set(height, Math.floor(Date.now() / 1000));
      const destinationHash = requestId === RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID ? RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH : RELAY_RETURN_DESTINATION_TX_HASH;
      const entry = Object.freeze({ wire, wireDigest: `sha256:${createHash('sha256').update(Buffer.from(wire, 'base64')).digest('hex')}`, signature, requestId, amount, destinationHash, height });
      returnTransactions.set(signature, entry);
      balanceEvents.push({ height, from: RELAY_RETURN_SOLVER_EVM.toLowerCase(), to: template.recipient.toLowerCase(), amount: quotedNativeReturnWei(amount) });
      broadcasts.set(destinationHash, { hash: destinationHash, from: RELAY_RETURN_SOLVER_EVM, height,
        parsed: { to: RELAY_RETURN_SOLVER_EVM, data: '0x', nonce: 0, value: 0n, gas: 21000n, chainId: 4663, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
        logs: [{ address: RELAY_RETURN_SOLVER_EVM, topics: encodeEventTopics({ abi: parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']), eventName: 'FundsMovement' }), data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [RELAY_RETURN_SOLVER_EVM, template.recipient, `0x${'00'.repeat(20)}`, quotedNativeReturnWei(amount), requestId === RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID ? RELAY_SUPPLEMENTARY_RETURN_ORDER_ID : RELAY_RETURN_ORDER_ID]) }] });
      return reply(signature);
    }
    if (rpc.method === 'getSlot') return reply(11);
    if (rpc.method === 'getMultipleAccounts') return reply(sourceRuntimeFixture.observation);
    if (rpc.method === 'getGenesisHash') return reply('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    if (rpc.method === 'getBalance') return reply({ context: { slot: 1 }, value: 10000000 });
    if (rpc.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } });
    if (rpc.method === 'getBlockHeight') return reply(1);
    // Purchase's own settlement account read: the real jsonParsed shape `readAssociatedTokenAccount`
    // (solana-rpc.mjs) requires, for exactly the ATA this run's own Operations identity derives for
    // the settlement mint -- carrying enough balance to cover the admitted purchase.
    if (rpc.method === 'getAccountInfo') {
      const [address, options] = rpc.params ?? [];
      const operationsSolana = operationsSolanaAccount();
      const heldCore = cardAwardsByMemo.get('graph-purchase-pack-1');
      if (address === heldCore.mint && options?.encoding === 'base64') {
        const sold = [...acceptedBuybackTransactionsBySignature.values()].some(entry => entry.memo === 'graph-purchase-pack-1');
        const data = Buffer.concat([Buffer.from([1]), new PublicKey(sold ? COLLECTOR_BUYBACK_RECIPIENT : operationsSolana).toBuffer()]);
        return reply({context: {slot: 6}, value: {owner: MPL_CORE_PROGRAM_ID, data: [data.toString('base64'), 'base64']}});
      }
      const settlementAta = operationsSolana === null ? null : deriveAssociatedTokenAddress(operationsSolana, SOLANA_MINT).toBase58();
      if (address === settlementAta && options?.encoding === 'jsonParsed') {
        return reply({
          context: { slot: 1 },
          value: {
            owner: TOKEN_PROGRAM_ID,
            data: {
              program: 'spl-token',
              parsed: {
                type: 'account',
                info: {
                  mint: SOLANA_MINT,
                  owner: operationsSolana,
                  tokenAmount: { amount: (AGGREGATE_PURCHASE_ATOMIC - [...acceptedPurchaseTransactionsBySignature.values()].reduce((sum, value) => sum + value.amountAtomic, 0n) + [...acceptedBuybackTransactionsBySignature.values()].reduce((sum, value) => sum + value.amountAtomic, 0n) - [...returnTransactions.values()].reduce((sum, value) => sum + value.amount, 0n)).toString(), decimals: 6 },
                },
              },
            },
          },
        });
      }
      // Buyback's own real finalized-ownership check (`verifyFinalizedOwnership`, buyback.mjs)
      // independently re-derives the operator's real associated token account for pack 0's own
      // held-card mint -- queried by its own real derived address, never a single hardcoded
      // response regardless of which account was actually asked for. Held once its own real
      // buyback settlement has actually been accepted (the card genuinely left the operator).
      if (operationsSolana !== null) {
        const card = [...cardAwardsByMemo].find(([memo, award]) => memo === 'graph-purchase-pack-0' && address === deriveAssociatedTokenAddress(operationsSolana, award.mint).toBase58());
        const heldCardMint = card?.[1]?.mint ?? null;
        const heldCardAta = heldCardMint === null ? null : deriveAssociatedTokenAddress(operationsSolana, heldCardMint).toBase58();
        if (address === heldCardAta && options?.encoding === 'jsonParsed') {
          const sold = [...acceptedBuybackTransactionsBySignature.values()].some(entry => entry.memo === card?.[0]);
          return reply({
            context: { slot: 1 },
            value: {
              owner: TOKEN_PROGRAM_ID,
              data: {
                program: 'spl-token',
                parsed: {
                  type: 'account',
                  info: { mint: heldCardMint, owner: operationsSolana, tokenAmount: { amount: sold ? '0' : '1', decimals: 0 } },
                },
              },
            },
          });
        }
      }
      return reply({ context: { slot: 1 }, value: null });
    }
    // Purchase's own pre-sign blockhash check: the generated transaction's recent blockhash is
    // still the one this fixture's own `getLatestBlockhash` names, so it truthfully remains usable.
    if (rpc.method === 'isBlockhashValid') return reply({ context: { slot: 1 }, value: true });
    // The outbound leg's destination-chain evidence: the Relay solver's own finalized settlement,
    // discoverable only by the Operations Solana account this run actually generated, and only once
    // that account is known (see the `operationsAccount()` callback pattern above for the EVM twin).
    if (rpc.method === 'getSignaturesForAddress') {
      const [owner] = rpc.params ?? [];
      if (owner !== null && owner === operationsSolanaAccount() && [...broadcasts.values()].some(value => value.parsed.data?.startsWith(RELAY_DEPOSIT_SELECTOR))) {
        return reply([{ signature: OUTBOUND_DESTINATION_SIGNATURE, slot: 5, err: null }]);
      }
      return reply([]);
    }
    // Purchase's own finalized settlement proof: `readFinalizedSignatureStatus`/
    // `getFinalizedTokenBalanceChanges` (solana-rpc.mjs, called from `reconcilePack`,
    // purchase.mjs) independently re-derive each pack's exact settlement debit from these two real
    // RPC methods -- keyed only by signatures `/api/submitTransaction` above actually decoded and
    // accepted, and the reported balance delta is exactly that same real decoded amount, never a
    // value inserted independently of the accepted transaction that actually produced it.
    // Open's own award finality proof: every card-award signature this fixture itself pinned in
    // `cardAwardsByMemo`, before any candidate ever existed, reports finalized only once its own
    // memo has actually been opened (`openedPurchaseMemos`) -- never fabricated ahead of the real
    // provider mutation that would produce it.
    const awardSignatures = new Set([...cardAwardsByMemo.values()].map(award => award.signature));
    if (rpc.method === 'getSignatureStatuses') {
      const [[signature]] = rpc.params ?? [[]];
      const known = returnTransactions.has(signature) || acceptedPurchaseTransactionsBySignature.has(signature)
        || acceptedBuybackTransactionsBySignature.has(signature)
        || (awardSignatures.has(signature) && [...cardAwardsByMemo.entries()].some(
          ([memo, award]) => award.signature === signature && openedPurchaseMemos.has(memo),
        ));
      return reply({ value: [known ? { confirmationStatus: 'finalized', slot: 5, err: null } : null] });
    }
    if (rpc.method === 'getTransaction') {
      const [signature] = rpc.params ?? [];
      if (signature === OUTBOUND_DESTINATION_SIGNATURE) {
        const deposit = [...broadcasts.values()].find(value => value.parsed.data?.startsWith(RELAY_DEPOSIT_SELECTOR));
        assert.ok(deposit, 'outbound destination follows an accepted native deposit');
        return reply({ ...outboundDestinationTransaction(operationsSolanaAccount()), blockTime: blockTimestamps.get(deposit.height) });
      }
      const returned = returnTransactions.get(signature);
      if (returned) {
        const accountKeys = Transaction.from(Buffer.from(returned.wire, 'base64')).compileMessage().accountKeys.map(key => key.toBase58());
        const sourceIndex = accountKeys.indexOf(deriveAssociatedTokenAddress(operationsSolanaAccount(), SOLANA_MINT).toBase58());
        assert.ok(sourceIndex >= 0);
        return reply({ slot: 6, blockTime: blockTimestamps.get(returned.height),
          meta: { err: null, preTokenBalances: [{accountIndex: sourceIndex, mint: SOLANA_MINT, owner: operationsSolanaAccount(), uiTokenAmount: {amount: returned.amount.toString(), decimals: 6}}], postTokenBalances: [{accountIndex: sourceIndex, mint: SOLANA_MINT, owner: operationsSolanaAccount(), uiTokenAmount: {amount: '0', decimals: 6}}] },
          transaction: rpc.params[1]?.encoding === 'base64' ? [returned.wire, 'base64'] : { signatures: [signature], message: {accountKeys} } });
      }
      const accepted = acceptedPurchaseTransactionsBySignature.get(signature);
      if (accepted !== undefined) {
        const accountKeys = Transaction.from(Buffer.from(accepted.rawBytes, 'base64')).compileMessage().accountKeys.map(key => key.toBase58());
        const sourceIndex = accountKeys.indexOf(deriveAssociatedTokenAddress(operationsSolanaAccount(), SOLANA_MINT).toBase58());
        assert.ok(sourceIndex >= 0);
        return reply({
          slot: 5, blockTime: 1,
          meta: {
            err: null,
            preTokenBalances: [{ accountIndex: sourceIndex, mint: SOLANA_MINT, owner: operationsSolanaAccount(), uiTokenAmount: { amount: accepted.amountAtomic.toString(), decimals: 6 } }],
            postTokenBalances: [{ accountIndex: sourceIndex, mint: SOLANA_MINT, owner: operationsSolanaAccount(), uiTokenAmount: { amount: '0', decimals: 6 } }],
          },
          transaction: { signatures: [signature], message: { accountKeys } },
        });
      }
      // Open's own real award: the card mint's own operator-owned balance goes 0 -> 1 in exactly
      // the same real transaction `/api/openPack` above already recorded as this memo's own award.
      const awardEntry = [...cardAwardsByMemo.entries()].find(([memo, award]) => award.signature === signature && openedPurchaseMemos.has(memo));
      if (awardEntry !== undefined) {
        const [memo, award] = awardEntry;
        if (memo === 'graph-purchase-pack-1') return reply({slot: 5, blockTime: blockTimestamp,
          meta: {err: null, preTokenBalances: [], postTokenBalances: []},
          transaction: {message: {accountKeys: [award.mint], instructions: [{programId: MPL_CORE_PROGRAM_ID, accounts: [award.mint], data: 'F'}]}} });
        return reply({
          slot: 5, blockTime: 1,
          meta: {
            err: null,
            preTokenBalances: [{ accountIndex: 0, mint: award.mint, owner: operationsSolanaAccount(), uiTokenAmount: { amount: '0' } }],
            postTokenBalances: [{ accountIndex: 0, mint: award.mint, owner: operationsSolanaAccount(), uiTokenAmount: { amount: '1' } }],
          },
          transaction: { message: { accountKeys: [operationsSolanaAccount()] } },
        });
      }
      // Buyback's own real settlement: the sold card's own operator-owned balance goes 1 -> 0 (it
      // left the operator), and the operator's own real settlement-asset balance increases by
      // exactly the real accepted offer, both in this one same real accepted transaction.
      const acceptedBuyback = acceptedBuybackTransactionsBySignature.get(signature);
      if (acceptedBuyback !== undefined) {
        const award = cardAwardsByMemo.get(acceptedBuyback.memo);
        const accountKeys = Transaction.from(Buffer.from(acceptedBuyback.rawBytes, 'base64')).compileMessage().accountKeys.map(key => key.toBase58());
        const cardIndex = accountKeys.indexOf(award.mint);
        const settlementIndex = accountKeys.indexOf(deriveAssociatedTokenAddress(operationsSolanaAccount(), SOLANA_MINT).toBase58());
        assert.ok(cardIndex >= 0 && settlementIndex >= 0);
        return reply({
          slot: 5, blockTime: 1,
          meta: {
            err: null,
            innerInstructions: acceptedBuyback.memo === 'graph-purchase-pack-1' ? [{index: 2, instructions: [{programId: MPL_CORE_PROGRAM_ID, accounts: [award.mint], data: 'F'}]}] : [],
            preTokenBalances: [
              ...(acceptedBuyback.memo === 'graph-purchase-pack-1' ? [] : [{ accountIndex: cardIndex, mint: award.mint, owner: operationsSolanaAccount(), uiTokenAmount: { amount: '1' } }]),
              { accountIndex: settlementIndex, mint: SOLANA_MINT, owner: operationsSolanaAccount(), uiTokenAmount: { amount: '0' } },
            ],
            postTokenBalances: [
              ...(acceptedBuyback.memo === 'graph-purchase-pack-1' ? [] : [{ accountIndex: cardIndex, mint: award.mint, owner: operationsSolanaAccount(), uiTokenAmount: { amount: '0' } }]),
              { accountIndex: settlementIndex, mint: SOLANA_MINT, owner: operationsSolanaAccount(), uiTokenAmount: { amount: acceptedBuyback.amountAtomic.toString() } },
            ],
          },
          transaction: { message: { accountKeys, instructions: [] } },
        });
      }
      return reply(null);
    }
    return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled Solana ${rpc.method}` } });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { baseUrl: `https://127.0.0.1:${server.address().port}`, caCert: paths.caCert, calls,
    coordinateEligibilityResponse(callback) { beforeEligibilityResponse = callback; },
    changeHoldersAndEnableHeldSale() { holdersChanged = true; holdersChangedAt = ++finalizedHeight; blockTimestamps.set(holdersChangedAt, Math.floor(Date.now() / 1000)); epicGateFactsByMemo.get('graph-purchase-pack-1').buybackAvailable = true; },
    evidence() { return { broadcasts: [...broadcasts.values()], returns: [...returnTransactions.values()], purchases: [...acceptedPurchaseTransactionsBySignature], buybacks: [...acceptedBuybackTransactionsBySignature], balanceEvents: structuredClone(balanceEvents), finalizedHeight, holdersChanged }; },
    balanceAt(account, height) { return balanceAt(account.toLowerCase(), height); },
  };
}

/**
 * The real, reviewed production offline boundary's own owned child protocol
 * (`createIsolatedKeychainChildSetup`, collector-production-binding.mjs) -- never the older
 * Node-test-only fake-Keychain wrapper. Dynamically imported from the isolated copied source root
 * (never this file's own original-tree import), exactly mirroring how the real
 * `bin/hookemon-runner.mjs` entrypoint itself resolves this same module once spawned: both this
 * discovery call and the later spawned CLI process's own internal call
 * (`applySyntheticIsolatedChildSetup`) resolve `bin/hookemon-keychain-signer.mjs`/
 * `bin/hookemon-wallet.mjs`/the fixed fake `security` fixture from the identical copied-root paths,
 * and reopen the identical ephemeral identity at `syntheticRoot` (never mint a second, different
 * pair) since `createIsolatedKeychainChildSetup` itself reuses an already-provisioned identity.
 */
async function syntheticCollectorChildIdentity(root, syntheticRoot) {
  const { createIsolatedKeychainChildSetup } = await import(
    `file://${join(root, 'packages/adapters/src/signing/collector-production-binding.mjs')}`
  );
  return createIsolatedKeychainChildSetup({ directory: syntheticRoot });
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

function eligibilitySnapshotFixture(operations) {
  const launchManifest = {
    supply: { chainId: '4663', assetId: `0x${'d'.repeat(40)}`, decimals: 18, amountAtomic: '1' },
    hook: `0x${'c'.repeat(40)}`, poolManager: `0x${'3'.repeat(40)}`, custody: `0x${'b'.repeat(40)}`,
    operations, treasury: `0x${'8'.repeat(40)}`, programmableRecipient: `0x${'4'.repeat(40)}`,
    launchContracts: [`0x${'b'.repeat(40)}`], burnAddresses: [`0x${'0'.repeat(36)}dead`], roleHistory: [],
  };
  return {
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' }, launchManifest,
    launchManifestDigest: digest({ domain: 'hookemon.eligibility-launch-manifest.v1', launchManifest }),
    primaryLogSourceId: 'fixture-primary', secondaryLogSourceId: 'fixture-secondary', logPageSize: '2', maxRetriesPerPage: 2,
    feasibility: { measuredTransferGas: '50000', maxGasPriceWei: '2', nativeReserveWei: '10', nativeBalanceWei: '400000', maxRecipientCount: 2, maxTransactionCount: 2 },
  };
}

async function activateTwoPackPolicy(directory) {
  const configuration = applyOperatorConfiguration(null, {
    intervalMinutes: 5,
    allowedPackIds: ['return-fixture'],
    requestedOrders: 2,
    maxBoostersPerCycle: 2,
    maxUnitPriceMicroUsd: '17',
    maxCycleBudgetMicroUsd: '34',
    max24HourBudgetMicroUsd: '34',
    paused: false,
    liveMode: true,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsd: '34',
    lossCapMicroUsd: '1000',
    maxOutstandingCustodyMicroUsd: '1000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
  });
  await mutateOperatorState(join(directory, 'operator-state.json'), null, state => ({
    ...(state ?? createEmptyOperatorState()), configuration,
  }));
}

async function testPolicyAuthority(t, directory, operations) {
  const ownerKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const ownerPublicKeyPath = join(directory, 'test-owner-public.pem');
  const policyPublicKeyPath = join(directory, 'test-policy-public.pem');
  const documentPath = join(directory, 'test-standing-authority.json');
  const artifactPath = join(directory, 'standing-authority-step-authorizations.json');
  const artifactNextPath = join(directory, 'standing-authority-step-authorizations.next.json');
  await Promise.all([
    writeFile(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
    writeFile(policyPublicKeyPath, policyKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
  ]);
  const document = attachOwnerSignature(buildCanonicalStandingAuthorityDocument({
    owner: 'test-loopback-authority',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '34',
    // recordStandingAuthorityDecision enforces this document field as a cap on per-day *step
    // authorizations*, counting one decision per signing boundary, while the field is named and
    // documented as a per-day cycle count. One N=2 cycle needs many signatures, so a value of 1
    // stops the graph at its first stage. Dimensioned here for the signatures actually taken; the
    // naming mismatch is reported for review rather than changed under a frozen policy surface.
    // The operator policy's own maxCyclesPerDay stays 1, so one cycle per day is still proven.
    maxCyclesPerDay: 64,
    allowedPacks: ['return-fixture'],
    allowedDestinations: ['test-loopback-authority-destination'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'test-loopback-automatic-policy',
  }), ownerKeys.privateKey);
  await writeFile(documentPath, `${canonicalJson(document)}\n`, { mode: 0o600 });

  const entries = new Map();
  const diagnostics = { publishAttempts: 0, publishWrites: 0, enoent: 0, keys: [] };
  let publication = Promise.resolve();
  const futureClaims = new Map();
  const matchedClaims = new Set();
  let publishedArtifact = null;
  let producerError = null;
  // Deliberately NOT `CycleRepository.open()`. That bootstrap takes the durable store's exclusive
  // SQLite lock, and `acquireSqliteLock` sets `PRAGMA busy_timeout = 0`, so the loser of any
  // collision fails immediately. The production child charges such a failure to its own tick as an
  // outage and doubles its reconcile backoff, while this loop never backs off -- an observer polling
  // the store therefore starves the very runner it is meant to authorize (measured: every tick of a
  // 60s window lost the lock, and the graph never advanced past eligibility-snapshot).
  //
  // This reads the committed active-cycle files directly instead: no lock, no contention, and no
  // weaker evidence. `durable-store.mjs` writes each `active/<cycleId>.json` atomically as canonical
  // JSON plus one newline, so a reader observes either the whole previous version or the whole next
  // one, and `assertCycleSnapshot` re-verifies the journal hash chain before anything here is
  // authorized. An entry that has not been durably committed by the runner is therefore never
  // visible to this producer, which is exactly the fail-closed property the poll must preserve.
  async function readCommittedPreparedAttempts() {
    const activeDirectory = join(directory, 'cycles', 'active');
    let names;
    try {
      names = await readdir(activeDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const prepared = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      let text;
      try {
        text = await readFile(join(activeDirectory, name), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const parsed = JSON.parse(text);
      if (`${canonicalJson(parsed)}\n` !== text) throw new Error('active cycle file is not canonical JSON plus one newline');
      const cycle = assertCycleSnapshot(parsed.cycle);
      const opened = cycle.entries.find(entry => entry.kind === 'cycle-opened');
      assert.ok(opened, 'future claim authority requires an actual committed cycle');
      const amountAtomic = opened.payload.releaseAmount;
      assert.match(amountAtomic, /^[1-9][0-9]*$/);
      const onchainCycleId = deriveOnchainCycleId(cycle.cycleId);
      const request = {
        schema: 'hookemon.claim-process-request.v2', cycleId: cycle.cycleId, onchainCycleId,
        destination: operations,
        amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic },
        call: buildClaimProcessCall(`0x${'c'.repeat(40)}`, onchainCycleId, amountAtomic, operations),
      };
      // stage-driver canonicalizes the production call's bigint argument before hashing.
      const canonicalRequest = JSON.parse(JSON.stringify(request, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      const claimDigest = digest({ schema: 'hookemon.operational-stage-request.v1', cycleId: cycle.cycleId, stage: 'claim-process', request: canonicalRequest });
      if (futureClaims.has(cycle.cycleId)) assert.equal(futureClaims.get(cycle.cycleId), claimDigest);
      futureClaims.set(cycle.cycleId, claimDigest);
      prepared.push({ cycleId: cycle.cycleId, stage: 'claim-process', requestDigest: claimDigest });

      // Payout persists its immutable plan outside the cycle journal before signing. This
      // external authority reads that actual committed plan without opening a competing writer.
      try {
        const payoutText = await readFile(join(directory, 'cycles', 'payout', encodeURIComponent(cycle.cycleId), 'payout', 'manifest.json'), 'utf8');
        const manifest = JSON.parse(payoutText);
        assert.equal(`${canonicalJson(manifest)}\n`, payoutText);
        assert.equal(manifest.schema, 'hookemon.durable-cycle-store.paged-payout-manifest.v1');
        assert.equal(manifest.cycleId, cycle.cycleId);
        assert.equal(manifest.stage, 'payout');
        assert.equal(manifest.pageCount, 0, 'single-holder fixture payout fits the committed manifest');
        const state = manifest.state;
        assertPayoutManifestUnchanged(state, state.plan);
        const request = {
          schema: 'hookemon.direct-payout-request.v2', cycleId: cycle.cycleId,
          planDigest: state.plan.planDigest, recipientCount: state.plan.payableRecipientCount,
          distributablePool: state.plan.distributablePool,
          heldPositionExclusions: state.heldPositionExclusions, plan: state.plan,
        };
        prepared.push({cycleId: cycle.cycleId, stage: 'payout', requestDigest: digest({schema: 'hookemon.operational-stage-request.v1', cycleId: cycle.cycleId, stage: 'payout', request})});
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const entry of cycle.entries) {
        // Two durable shapes carry a digest a signing boundary can demand: the per-transaction
        // attempts, and the stage-level request digest a chain-journal stage publishes for exactly
        // this purpose. Authorizing both is what lets an operational and a chain stage be
        // authorized by the same producer.
        if (entry?.kind === 'stage-request-prepared') {
          const { stage, requestDigest } = entry.payload ?? {};
          if (stage === 'claim-process') {
            assert.equal(requestDigest, futureClaims.get(cycle.cycleId), 'real prepared claim must equal its preauthorized subject');
            matchedClaims.add(cycle.cycleId);
          }
          if (typeof stage === 'string' && typeof requestDigest === 'string') {
            prepared.push({ cycleId: cycle.cycleId, stage, requestDigest });
          }
          continue;
        }
        if (typeof entry?.kind !== 'string' || !entry.kind.endsWith('attempt-prepared')) continue;
        const attempt = entry.payload?.attempt;
        if (typeof attempt?.stage !== 'string' || typeof attempt?.requestDigest !== 'string') continue;
        prepared.push({ cycleId: cycle.cycleId, stage: attempt.stage, requestDigest: attempt.requestDigest });
      }
    }
    return prepared;
  }

  function publish() {
    publication = publication.then(publishOnce);
    return publication;
  }
  async function publishOnce() {
    diagnostics.publishAttempts += 1;
    try {
      for (const { cycleId, stage, requestDigest } of await readCommittedPreparedAttempts()) {
        if (!['claim-process', 'outbound', 'purchase', 'buyback', 'return', 'payout', 'generate', 'open'].includes(stage)) continue;
        for (const signerRole of ['operator-evm', 'operator-solana']) {
          const unsignedIntent = {
            schema: 'hookemon.standing-authority-step-intent.v1',
            standingAuthorityDigest: document.documentDigest,
            cycleId,
            actionKind: stage,
            authorizationKind: 'sign',
            subjectDigest: requestDigest,
            destination: 'test-loopback-authority-destination',
            pack: 'return-fixture',
            spendAmount: '1',
            nonce: `test-${digest({ cycleId, stage, requestDigest, signerRole }).slice('sha256:'.length)}`,
            issuedAt: '2026-09-06T00:00:00.000Z',
          };
          const intent = Object.freeze({
            ...unsignedIntent,
            policySignature: signMessage(null, Buffer.from(stepAuthorizationIntentDigest(unsignedIntent), 'utf8'), policyKeys.privateKey).toString('base64url'),
          });
          const entryKey = canonicalJson({ cycleId, stage, requestDigest, signerRole });
          if (!entries.has(entryKey)) diagnostics.keys.push({ atMs: Date.now(), stage, requestDigest, signerRole });
          entries.set(entryKey, Object.freeze({ signerRole, intent }));
        }
      }
      const artifact = {
        schema: 'hookemon.standing-authority-step-authorizations.v1',
        authorityDigest: document.documentDigest,
        entries: [...entries.values()],
      };
      const artifactText = `${canonicalJson(artifact)}\n`;
      if (artifactText === publishedArtifact) return;
      await writeFile(artifactNextPath, artifactText, { mode: 0o600 });
      await rename(artifactNextPath, artifactPath);
      publishedArtifact = artifactText;
      diagnostics.publishWrites += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      diagnostics.enoent += 1;
    }
  }
  await publish();
  const timer = setInterval(() => {
    void publish().catch(error => { producerError = error; });
  }, 10);
  t.after(() => clearInterval(timer));
  return {
    documentPath,
    ownerPublicKeyPath,
    policyPublicKeyPath,
    diagnostics,
    publish,
    assertClaimSubjectsMatched(diagnostics) {
      assert.ok(futureClaims.size > 0, diagnostics);
      assert.deepEqual([...matchedClaims].sort(), [...futureClaims.keys()].sort());
    },
    // The assertions below reopen the same durable store, and `open()` takes the store's exclusive
    // zero-tolerance SQLite lock. Stop the producer and let its in-flight publish drain first, or
    // the harness reliably races itself into `durable cycle store lock contention`.
    async stop() {
      clearInterval(timer);
      await publication;
    },
    assertHealthy() { if (producerError !== null) throw producerError; },
  };
}

async function readOperatorLedgers(directory) {
  try {
    const state = JSON.parse(await readFile(join(directory, 'operator-state.json'), 'utf8'));
    const configuration = state.configuration ?? {};
    return {
      cycleLedger: configuration.cycleLedger ?? null,
      spendLedger: configuration.spendLedger ?? null,
    };
  } catch (error) {
    return { error: error.message };
  }
}

const POLICY_ENGINE_RELATIVE = 'packages/runner/src/automation/policy-engine.mjs';
const PINNED_OPERATIONS_EVM = "const OPERATIONS_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';";
const PINNED_OPERATIONS_SOLANA = "const OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';";

/**
 * Repoints the deployment-identity pins inside the copied source, and nothing else.
 *
 * The graph drives the literal CLI, which by design has no injection seam, so the only way to run it
 * under isolated keys is to change what the copy considers the approved identity. That is done here,
 * at the test boundary, against a throwaway tree: the production CLI reads the real repository, where
 * the pins are the recorded Operations identities, and nothing in production configuration, state or
 * environment can reach this transformation.
 *
 * Deliberately narrow. It rewrites exactly the two pinned constant declarations, requires each to be
 * present exactly once before rewriting, and asserts every other byte of the file is unchanged --
 * so it cannot silently relax a check, drop a validation, or grow to cover anything but identity.
 */
async function repointCopiedDeploymentIdentity(root, { evm, solana }) {
  const path = join(root, POLICY_ENGINE_RELATIVE);
  const original = await readFile(path, 'utf8');
  for (const pin of [PINNED_OPERATIONS_EVM, PINNED_OPERATIONS_SOLANA]) {
    if (original.split(pin).length !== 2) {
      throw new Error(`isolated identity transformation could not find exactly one ${pin}`);
    }
  }
  const rewritten = original
    .replace(PINNED_OPERATIONS_EVM, `const OPERATIONS_EVM = '${evm.toLowerCase()}';`)
    .replace(PINNED_OPERATIONS_SOLANA, `const OPERATIONS_SOLANA = '${solana}';`);
  const changedLines = original.split('\n')
    .map((line, index) => (line === rewritten.split('\n')[index] ? null : index))
    .filter(index => index !== null);
  if (changedLines.length !== 2) {
    throw new Error(`isolated identity transformation changed ${changedLines.length} lines; only the two identity pins may change`);
  }
  await writeFile(path, rewritten);
  return { path, changedLines };
}

async function isolatedNativeBindingBytes() {
  const fixture = await nativeRelaySetup({ runtimeMutation: observation => {
    const data = Buffer.from(observation.value[1].data[0], 'base64'); data.writeBigUInt64LE(1n, 4);
    observation.value[1].data[0] = data.toString('base64');
  } });
  return Buffer.from(JSON.stringify({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663',
    hook: { address: `0x${'c'.repeat(40)}`, runtimeHash: keccak256('0x6000') },
    relay: { ...fixture.route, sourceInstruction: capturedSourceInstruction, emitter: RELAY_RETURN_SOLVER_EVM, refundsSupported: true } }));
}
async function isolatedFrozenInterfaces() {
  return { schemaVersion: 'hookemon.interfaces.v1', productPhase: 3, requirementsRevision: 71, architectureRevision: 11,
    status: 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING', bindingManifestDigest: `sha256:${'a'.repeat(64)}`,
    nativeMigration: { nativePaymentBindingSha256: createHash('sha256').update(await isolatedNativeBindingBytes()).digest('hex') },
    fixture: 'I-03 isolated test authority; not a release approval' };
}

async function assertCopiedProductionBytes(root, identity) {
  async function check(relative) {
    for (const entry of await readdir(join(SOURCE_ROOT, relative), {withFileTypes: true})) {
      if (entry.name === 'node_modules') continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await check(path);
      else if (entry.isFile()) {
        let expected = await readFile(join(SOURCE_ROOT, path));
        if (path === POLICY_ENGINE_RELATIVE) expected = Buffer.from(expected.toString('utf8')
          .replace(PINNED_OPERATIONS_EVM, `const OPERATIONS_EVM = '${identity.evmAddress.toLowerCase()}';`)
          .replace(PINNED_OPERATIONS_SOLANA, `const OPERATIONS_SOLANA = '${identity.solanaPublicKey}';`));
        if (path === 'architecture/interfaces.json') expected = Buffer.from(`${JSON.stringify(await isolatedFrozenInterfaces())}\n`);
        assert.deepEqual(await readFile(join(root, path)), expected, `copied runtime byte allowlist: ${path}`);
      }
    }
  }
  for (const directory of ['adapters', 'runner', 'contracts', 'dashboard', 'domain']) await check(join('packages', directory));
  await check('architecture');
  await check('bindings');
  assert.deepEqual(await readFile(join(root, 'native-payment-binding.json')), await isolatedNativeBindingBytes());
}

async function isolatedSource(directory) {
  const root = join(directory, 'source');
  const copyFilter = path => !path.includes('/node_modules');
  await Promise.all([
    cp(join(SOURCE_ROOT, 'packages', 'adapters'), join(root, 'packages', 'adapters'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'runner'), join(root, 'packages', 'runner'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'contracts'), join(root, 'packages', 'contracts'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'dashboard'), join(root, 'packages', 'dashboard'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'packages', 'domain'), join(root, 'packages', 'domain'), { recursive: true, filter: copyFilter }),
    cp(join(SOURCE_ROOT, 'architecture'), join(root, 'architecture'), { recursive: true }),
    cp(join(SOURCE_ROOT, 'bindings'), join(root, 'bindings'), { recursive: true }),
  ]);
  await symlink(join(SOURCE_ROOT, 'packages', 'adapters', 'node_modules'), join(root, 'packages', 'adapters', 'node_modules'));
  await writeFile(join(root, 'architecture', 'interfaces.json'), `${JSON.stringify(await isolatedFrozenInterfaces())}\n`);
  await writeFile(join(root, 'native-payment-binding.json'), await isolatedNativeBindingBytes());
  const binPath = await realpath(join(root, 'packages', 'adapters', 'bin', 'hookemon-runner.mjs'));
  let entrypointOutput = '';
  try {
    const result = await execFileAsync(process.execPath, [binPath]);
    entrypointOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (error) {
    entrypointOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (!/Usage: hookemon-runner/.test(entrypointOutput)) {
    throw new Error('isolated production graph fixture did not execute the copied CLI entrypoint');
  }
  return { root, binPath };
}

async function runProductionWindow(binPath, env, durationMs = 30000) {
  const child = spawn(process.execPath, [binPath, 'run', '--mode', 'production', '--no-dashboard'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let finishTick;
  const tick = new Promise(resolve => { finishTick = resolve; });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
    if (stderr.includes('TICK_COMPLETE')) finishTick();
  });
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  const closed = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({exitCode, signal})));
  let timer;
  await Promise.race([tick, closed, new Promise(resolve => { timer = setTimeout(resolve, durationMs); })]);
  clearTimeout(timer);
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  const result = await closed;
  clearTimeout(killTimer);
  assert.equal(result.exitCode, 0, JSON.stringify({stderr, stdout, ...result}));
  assert.match(stderr, /TICK_COMPLETE/, 'each actual CLI process must complete its tick');
  assert.doesNotMatch(stderr, /TICK_FAILED/, 'acceptance cannot recover past a failed tick and hide its refusal');
  return { stderr, stdout, pid: child.pid, ...result };
}

const GRAPH_WINDOW_MS = Number(process.env.HKMN_GRAPH_WINDOW_MS ?? 30000);

test('I-01/I-02 literal production loader pays ordinary and held N=2 proceeds across CLI restarts', { timeout: GRAPH_WINDOW_MS * 6 + 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-graph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The loopback chain must report the hook's Operations role as the account this run actually
  // signs with, and that account only exists once the isolated keys are generated, so the fixture
  // reads it late rather than being handed a placeholder.
  let operationsEvm = `0x${'0'.repeat(40)}`;
  let operationsSolana = null;
  const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana);
  const { root, binPath } = await isolatedSource(directory);
  // The real, reviewed offline execution boundary's own owned child protocol
  // (`createIsolatedKeychainChildSetup`, collector-production-binding.mjs), dynamically resolved
  // from the isolated copied source root, never the older Node-test-only fake-Keychain wrapper.
  // The later spawned CLI process reopens this exact same ephemeral identity at the same
  // `syntheticRoot` (never mints a second, different pair).
  const syntheticRoot = join(directory, 'collector-synthetic-root');
  await mkdir(syntheticRoot, { recursive: true });
  const identity = await syntheticCollectorChildIdentity(root, syntheticRoot);
  operationsEvm = identity.evmAddress;
  operationsSolana = identity.solanaPublicKey;
  // Only the copied tree's identity pins move, and only to the keys this run actually holds.
  await repointCopiedDeploymentIdentity(root, { evm: identity.evmAddress, solana: identity.solanaPublicKey });
  const authority = await testPolicyAuthority(t, directory, identity.evmAddress);
  // Publish a signed future claim for the committed cycle before releasing eligibility RPC data.
  // This creates no stage state; production still checks completed eligibility and exact subject.
  fixture.coordinateEligibilityResponse(() => authority.publish());
  await activateTwoPackPolicy(directory);
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, `${JSON.stringify(observability(fixture.baseUrl, directory, identity.evmAddress))}\n`);
  await writeFile(eligibilitySnapshotPath, `${JSON.stringify(eligibilitySnapshotFixture(identity.evmAddress))}\n`);
  // The real Collector production binding registry: a real JSON file, schema/digest-validated the
  // same way `compose.mjs` validates any other registry source, carrying the exact purchase
  // binding `unsignedPurchaseTransaction` above's own candidate must match instruction-for-
  // instruction. Never the Node-test-only fixture-binding seam, and never a live-authority entry
  // (refused unconditionally by the real loader/resolver regardless).
  const epicGatePath = join(directory, 'collector-epic-gate.json');
  await writeFile(epicGatePath, JSON.stringify({ nftAddressField: 'nft_address', insuredValueField: 'insured_value', prizeTierField: 'prize_tier', rarityField: 'rarity' }));
  const registryPath = join(directory, 'collector-production-binding-registry.json');
  await writeFile(registryPath, JSON.stringify(collectorProductionBindingRegistry([
    collectorProductionBindingRegistryEntry({
      authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'purchase', binding: purchaseProductionBinding(),
    }),
    collectorProductionBindingRegistryEntry({
      authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE, stage: 'buyback', binding: buybackProductionBinding(),
    }),
  ])), 'utf8');
  const env = {
    ...process.env,
    HOOKEMON_STATE_DIR: directory, HOOKEMON_DEFAULT_INTERVAL_MS: '100', HOOKEMON_CHAIN_ID: '4663', HOOKEMON_PROVIDER_MODE: 'live',
    // Keep the existing bounded lease window; authority readiness is coordinated independently.
    HOOKEMON_LEASE_TTL_MS: '30000',
    HOOKEMON_ROBINHOOD_RPC_URL: `${fixture.baseUrl}/rpc`, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: `${fixture.baseUrl}/archive`, HOOKEMON_SOLANA_RPC_URL: `${fixture.baseUrl}/solana`,
    HOOKEMON_NATIVE_PAYMENT_BINDING_PATH: join(root, 'native-payment-binding.json'), HOOKEMON_RELAY_QUOTE_VALIDITY_MS: '600000',
    HOOKEMON_RELAY_BASE_URL: fixture.baseUrl, HOOKEMON_RELAY_MAX_SETTLEMENT_WINDOW_SECONDS: '300', HOOKEMON_RELAY_API_KEY: RELAY_SYNTHETIC_API_KEY, HOOKEMON_RELAY_SOLANA_MINT: SOLANA_MINT, HOOKEMON_RELAY_SOLANA_DECIMALS: '6', HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: `${fixture.baseUrl}/collector`, HOOKEMON_COLLECTOR_CRYPT_API_KEY: COLLECTOR_SYNTHETIC_API_KEY,
    HOOKEMON_COLLECTOR_PRODUCTION_BINDING_AUTHORITY: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
    HOOKEMON_COLLECTOR_PRODUCTION_BINDING_REGISTRY_PATH: registryPath,
    HOOKEMON_COLLECTOR_EPIC_GATE_CONFIG_PATH: epicGatePath,
    HOOKEMON_COLLECTOR_SYNTHETIC_ROOT: syntheticRoot,
    HOOKEMON_EVM_ACCOUNT: identity.evmAddress, HOOKEMON_SOLANA_ACCOUNT: identity.solanaPublicKey, HOOKEMON_VAULT_ADDRESS: `0x${'b'.repeat(40)}`, HOOKEMON_HOOK_ADDRESS: `0x${'c'.repeat(40)}`, HOOKEMON_HKMN_ADDRESS: `0x${'d'.repeat(40)}`, HOOKEMON_HKMN_DECIMALS: '18',
    // `readEnvironment`'s own `requireProfileInputs` still requires this field present for the
    // production profile even under the synthetic-offline authority (only the later
    // `readAbsolutePath` call treats it as optional there); `bin/hookemon-runner.mjs`'s own
    // `applySyntheticIsolatedChildSetup` overrides `signer.keychain.command`/`.isolatedChildSetup`
    // with its authenticated construction regardless, so this value is a placeholder the real
    // isolated setup itself already agrees with (`identity.command`), never trusted directly.
    HOOKEMON_SIGNER_BACKEND: 'keychain', HOOKEMON_SIGNER_LIVE_MODE: 'true', HOOKEMON_KEYCHAIN_COMMAND: identity.command, HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm', HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_STANDING_AUTHORITY_PATH: authority.documentPath, HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: authority.ownerPublicKeyPath, HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: authority.policyPublicKeyPath,
    HOOKEMON_PACK_CODE: 'return-fixture', HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0', HOOKEMON_MIN_SOLANA_RECEIVE: '0', HOOKEMON_MIN_RETURN_ETH: '0', HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0', HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0', HOOKEMON_EVM_GAS_PRICE_CAP: '2', HOOKEMON_EVM_NATIVE_RESERVE: '2', HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2', HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_WEI: '85', HOOKEMON_COLLECTOR_PACK_PRICE_ATOMS: '8', HOOKEMON_BUDGET_PACK_PRICE_WEI: '17', HOOKEMON_BUDGET_OUTBOUND_CAP_WEI: '0', HOOKEMON_BUDGET_RETURN_CAP_WEI: '0', HOOKEMON_BUDGET_OPERATING_MARGIN_WEI: '0', HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath, HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath, NODE_EXTRA_CA_CERTS: fixture.caCert,
  };
  await assertCopiedProductionBytes(root, identity);
  const run = await runProductionWindow(binPath, env, GRAPH_WINDOW_MS);
  authority.assertHealthy();
  await authority.publish();
  authority.assertClaimSubjectsMatched(JSON.stringify({ run, calls: fixture.calls }));
  const { stderr } = run;
  // Read back through the same copied tree the run used. The real tree validates a stored admission
  // against the production pins, which this run's isolated keys deliberately are not.
  const { CycleRepository: IsolatedCycleRepository } = await import(
    `file://${join(root, 'packages/adapters/src/app/cycle-repository.mjs')}`
  );
  const repository = await IsolatedCycleRepository.open(join(directory, 'cycles'));
  const cycleIds = await repository.listKnownCycleIds();
  assert.equal(cycleIds.length, 1, `production graph did not durably admit one N=2 cycle: ${JSON.stringify({ run, calls: fixture.calls })}`);
  const cycle = await repository.describeCycle(cycleIds[0]);
  assert.equal(cycle.mode, 'production');
  assert.equal(cycle.providerMode, 'live');
  const diagnostics = async () => JSON.stringify({
    stages: [...cycle.stages.keys()], prepared: [...cycle.preparedStages.keys()],
    chainAttempts: [...cycle.chainAttempts.values()].map(record => ({ stage: record?.attempt?.stage, state: record?.attempt?.state, requestDigest: record?.attempt?.requestDigest })),
    operationalAttempts: [...cycle.operationalAttempts.values()].map(record => ({ stage: record?.attempt?.stage, requestDigest: record?.attempt?.requestDigest })),
    relayLegs: [...cycle.relayLegs.values()].map(leg => ({
      direction: leg.direction, state: leg.state, relayRequestId: leg.relayRequestId,
      destinationAssetId: leg.destinationAssetId, destinationAmountAtomic: leg.destinationAmountAtomic,
    })),
    authorizations: authority.diagnostics, terminalState: cycle.terminalState,
    admission: cycle.admission === null ? null : {
      quoteDigest: cycle.admission.quoteDigest,
      unitFunding: cycle.admission.unitFundingQuote.amountAtomic,
      aggregateFunding: cycle.admission.aggregateFundingQuote.amountAtomic,
      unitPurchase: cycle.admission.unitPurchase.amountAtomic,
      aggregatePurchase: cycle.admission.aggregatePurchase.amountAtomic,
    },
    ledger: await readOperatorLedgers(directory), quotes: fixture.calls.quotes,
    cycleCount: cycleIds.length,
    stageStatuses: [...cycle.stages.entries()].map(([s, r]) => [s, r.status]),
    epicGateEvidence: cycle.stages.get('epic-gate')?.evidence ?? null,
    payoutEvidence: cycle.stages.get('payout')?.evidence ?? null,
    calls: fixture.calls,
    buybackAttempts: [...cycle.operationalAttempts.values()].filter(r => r?.attempt?.stage === 'buyback'),
    heldPositions: cycle.heldPositions ? [...cycle.heldPositions.values()] : null,
    outbound: [...cycle.chainAttempts.values()].filter(r => r?.attempt?.stage === 'outbound').map(r => ({ digest: r.attempt.requestDigest, state: r.attempt.state, nonce: r.attempt.nonce ?? null })),
    nonces: [...cycle.walletNonceReservations.entries()].map(([k, v]) => ({ k, v })), stderr,
  });
  for (const stage of ['eligibility-snapshot', 'claim-process', 'outbound', 'purchase', 'open', 'epic-gate', 'buyback', 'return', 'payout']) {
    assert.equal(cycle.stages.get(stage)?.status, 'COMPLETE', `stage ${stage} must complete; ${await diagnostics()}`);
  }
  assert.equal(cycle.stages.get('return')?.evidence?.destinationCreditAmount, '9090', await diagnostics());
  assert.equal(cycle.terminalState, 'COMPLETED', await diagnostics());
  const ordinary = fixture.evidence();
  const payout = cycle.stages.get('payout').evidence;
  assert.equal(payout.totalAllocated.amountAtomic, '9090', await diagnostics());
  assert.equal(payout.recipients.length, 1, await diagnostics());
  const recipient = payout.recipients[0];
  assert.equal(recipient.state, 'FINALIZED');
  assert.equal(recipient.recipient.toLowerCase(), `0x${'9'.repeat(40)}`);
  assert.deepEqual(recipient.amount, {chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '9090'});
  assert.equal(recipient.refusalEvidence, null);
  assert.equal(payout.distributablePool.amountAtomic, '9090');
  assert.equal(payout.dust.amountAtomic, '0');
  assert.equal(payout.quarantine.length, 0);
  assert.equal(BigInt(payout.distributablePool.amountAtomic), BigInt(payout.totalAllocated.amountAtomic) + BigInt(payout.dust.amountAtomic));
  assert.equal(recipient.finalizedTransfer.source.toLowerCase(), identity.evmAddress.toLowerCase());
  assert.equal(recipient.finalizedTransfer.amountWei, '9090');
  assert.equal(recipient.finalizedTransfer.gasSpentWei, '42000');
  assert.equal(recipient.finalizedTransfer.calldataDigest, keccak256('0x'));
  assert.ok(ordinary.broadcasts.some(entry => entry.hash === recipient.transactionHash));
  assert.equal(cycle.admission.unitFundingQuote.amountAtomic, '17');
  assert.equal(cycle.admission.aggregateFundingQuote.amountAtomic, '33');
  assert.equal(cycle.admission.unitPurchase.amountAtomic, '8');
  assert.equal(cycle.admission.aggregatePurchase.amountAtomic, '16');
  assert.equal(ordinary.purchases.length, 2);
  assert.equal(ordinary.buybacks.length, 1);
  assert.deepEqual(ordinary.broadcasts.filter(value => value.raw && value.from === identity.evmAddress.toLowerCase()).map(value => value.parsed.nonce), [0, 1, 2]);
  const custody = cycle.custodyLedgers.get(`4663\0native`);
  assert.equal(custody.returnReceived, '9090');
  assert.equal(custody.heldPositions, '0');
  assert.equal(custody.payoutLiability, '0');
  assert.ok(custody.verifiedCurrentBalance);
  assert.equal(cycle.custodyLedgers.get(`4663\0${USDG}`) ?? null, null);

  assert.equal(fixture.balanceAt(`0x${'9'.repeat(40)}`, 101), 9090n);
  assert.equal(ordinary.finalizedHeight, 101);
  const frozenEligibility = canonicalJson(cycle.stages.get('eligibility-snapshot').evidence);
  const frozenOrdinaryAttempts = canonicalJson({chain: [...cycle.chainAttempts], operational: [...cycle.operationalAttempts], payout});
  const ordinaryRestart = await runProductionWindow(binPath, env, GRAPH_WINDOW_MS);
  assert.notEqual(ordinaryRestart.pid, run.pid);
  assert.deepEqual(fixture.evidence(), ordinary, 'ordinary restart must not create another logical transaction or payment');
  const beforeSupplementary = await IsolatedCycleRepository.open(join(directory, 'cycles'));
  const recoveredOrdinary = await beforeSupplementary.describeCycle(cycleIds[0]);
  assert.equal(canonicalJson({chain: [...recoveredOrdinary.chainAttempts], operational: [...recoveredOrdinary.operationalAttempts], payout: recoveredOrdinary.stages.get('payout').evidence}), frozenOrdinaryAttempts);
  const held = [...recoveredOrdinary.heldPositions.values()];
  assert.equal(held.length, 1);
  assert.equal(held[0].memo, 'graph-purchase-pack-1');
  assert.equal(held[0].reason, 'BUYBACK_UNAVAILABLE');
  fixture.changeHoldersAndEnableHeldSale();
  await beforeSupplementary.recordHeldOwnerDecision(held[0].positionId, { heldEvidenceDigest: held[0].evidenceDigest, requestId: randomUUID(), expectedRevision: held[0].positionRevision, choice: 'sell' });
  const supplementaryRuns = [];
  let supplementaryManifestId = null;
  for (const expectedState of ['BUYBACK_SENT_UNKNOWN', 'RETURN_BROADCAST', 'COMPLETE']) {
    const restarted = await runProductionWindow(binPath, env, GRAPH_WINDOW_MS);
    supplementaryRuns.push(restarted);
    const reopened = await IsolatedCycleRepository.open(join(directory, 'cycles'));
    const settlement = await reopened.readSupplementarySettlement(held[0].positionId);
    assert.equal(settlement?.state, expectedState, JSON.stringify({run: restarted, calls: fixture.calls, supplementaryAttempts: [...(await reopened.describeCycle(cycleIds[0])).supplementaryChainAttempts.values()]}));
    assert.equal(typeof settlement.manifestId, 'string');
    supplementaryManifestId ??= settlement.manifestId;
    assert.equal(settlement.manifestId, supplementaryManifestId);
    assert.equal(canonicalJson((await reopened.describeCycle(cycleIds[0])).stages.get('eligibility-snapshot').evidence), frozenEligibility);
  }
  const finalRepository = await IsolatedCycleRepository.open(join(directory, 'cycles'));
  const finalCycle = await finalRepository.describeCycle(cycleIds[0]);
  const finalHeld = [...finalCycle.heldPositions.values()][0];
  assert.equal(finalHeld.positionRevision, held[0].positionRevision + 1);
  assert.equal(finalHeld.ownerDecision.choice, 'sell');
  assert.equal(finalHeld.resolution, null);
  assert.equal((await finalRepository.readSupplementarySettlementEvidence(held[0].positionId)).state, 'COMPLETE');
  const finalCustody = finalCycle.custodyLedgers.get(`4663\0native`);
  for (const bucket of ['claimed', 'bridgeOut', 'payoutLiability', 'heldPositions']) assert.equal(finalCustody[bucket], custody[bucket], `ordinary ${bucket} remains unchanged`);
  assert.equal(finalCustody.returnReceived, '13635');
  assert.equal(finalCustody.heldPositions, '0');
  assert.equal(finalCustody.payoutLiability, '0');
  assert.ok(finalCustody.verifiedCurrentBalance);
  assert.equal(finalCycle.custodyLedgers.get(`4663\0${USDG}`) ?? null, null);

  const supplementaryPayout = await finalRepository.readPagedPayoutState(cycleIds[0], supplementaryPayoutStageId(held[0].positionId));
  assert.equal(supplementaryPayout.manifestId, supplementaryManifestId);
  assert.equal(supplementaryPayout.eligibilitySnapshotEvidenceDigest, (await finalRepository.readSupplementarySettlement(held[0].positionId)).eligibilitySnapshotEvidenceDigest);
  assert.equal(supplementaryPayout.recipients.length, 1);
  const supplementaryRecipient = supplementaryPayout.recipients[0];
  assert.equal(supplementaryRecipient.state, 'FINALIZED');
  assert.equal(supplementaryRecipient.recipient.toLowerCase(), recipient.recipient.toLowerCase());
  assert.deepEqual(supplementaryRecipient.amount, {...recipient.amount, amountAtomic: '4545'});
  assert.equal(supplementaryRecipient.refusalEvidence, null);
  assert.equal(supplementaryRecipient.finalizedTransfer.amountWei, '4545');
  assert.equal(supplementaryRecipient.finalizedTransfer.gasSpentWei, '42000');
  assert.equal(supplementaryRecipient.finalizedTransfer.calldataDigest, keccak256('0x'));
  assert.equal(supplementaryRecipient.finalizedTransfer.source.toLowerCase(), identity.evmAddress.toLowerCase());
  const supplementaryState = supplementaryPayout.payoutState;
  assert.deepEqual(supplementaryState.distributablePool, { ...recipient.amount, amountAtomic: '4545' });
  assert.deepEqual(supplementaryState.plan.totalAllocated, supplementaryState.distributablePool);
  assert.deepEqual(supplementaryState.dust, { ...recipient.amount, amountAtomic: '0' });
  assert.equal(supplementaryState.quarantine.length, 0);
  const supplementaryPaid = supplementaryPayout.recipients
    .filter(value => value.state === 'FINALIZED')
    .reduce((total, value) => total + BigInt(value.amount.amountAtomic), 0n);
  const supplementaryPending = supplementaryPayout.recipients
    .filter(value => value.state !== 'FINALIZED')
    .reduce((total, value) => total + BigInt(value.amount.amountAtomic), 0n);
  assert.equal(supplementaryPending, 0n);
  assert.equal(supplementaryPaid, BigInt(supplementaryState.plan.totalAllocated.amountAtomic));
  assert.equal(BigInt(supplementaryState.distributablePool.amountAtomic),
    supplementaryPaid + supplementaryPending + BigInt(supplementaryState.dust.amountAtomic));


  const completed = fixture.evidence();
  assert.equal(completed.finalizedHeight, 104);
  assert.match(supplementaryRecipient.txHash, /^0x[0-9a-f]{64}$/);
  assert.ok(completed.broadcasts.some(entry => entry.hash === supplementaryRecipient.txHash));
  assert.deepEqual(completed.buybacks.map(([, value]) => value.amountAtomic), [90n, 45n]);
  assert.deepEqual(completed.returns.map(value => value.amount), [90n, 45n]);
  assert.equal(fixture.calls.collectorGenerateYoloPacks, 1);
  assert.equal(fixture.calls.collectorOpenPack, 2);
  assert.equal(fixture.calls.collectorBuyback, 2);
  assert.equal(fixture.calls.collectorSubmitTransaction, 4);
  assert.deepEqual(completed.broadcasts.filter(value => value.raw && value.from === identity.evmAddress.toLowerCase()).map(value => value.parsed.nonce), [0, 1, 2, 3]);
  assert.equal(fixture.balanceAt(`0x${'9'.repeat(40)}`, 104), 13635n);
  assert.equal(fixture.balanceAt(`0x${'2'.repeat(40)}`, 104), 0n);
  assert.equal(fixture.balanceAt(`0x${'9'.repeat(40)}`, 100), 0n);
  assert.equal(fixture.balanceAt(`0x${'9'.repeat(40)}`, 101), 9090n);
  const frozenFinalCycle = canonicalJson({
    cycleIds: await finalRepository.listKnownCycleIds(), terminalState: finalCycle.terminalState,
    chainAttempts: [...finalCycle.chainAttempts], operationalAttempts: [...finalCycle.operationalAttempts],
    supplementaryChainAttempts: [...finalCycle.supplementaryChainAttempts],
    settlement: await finalRepository.readSupplementarySettlement(held[0].positionId),
    settlementEvidence: await finalRepository.readSupplementarySettlementEvidence(held[0].positionId),
    payout: supplementaryPayout, held: [...finalCycle.heldPositions], custody: [...finalCycle.custodyLedgers],
  });
  const frozenFinalProviderCounts = {
    generate: fixture.calls.collectorGenerateYoloPacks, open: fixture.calls.collectorOpenPack,
    buyback: fixture.calls.collectorBuyback, submit: fixture.calls.collectorSubmitTransaction,
  };
  const finalRestart = await runProductionWindow(binPath, env, GRAPH_WINDOW_MS);
  assert.deepEqual(fixture.evidence(), completed, 'supplementary restart must not repeat any logical payment');
  assert.deepEqual({
    generate: fixture.calls.collectorGenerateYoloPacks, open: fixture.calls.collectorOpenPack,
    buyback: fixture.calls.collectorBuyback, submit: fixture.calls.collectorSubmitTransaction,
  }, frozenFinalProviderCounts);
  const restartedRepository = await IsolatedCycleRepository.open(join(directory, 'cycles'));
  const restartedCycle = await restartedRepository.describeCycle(cycleIds[0]);
  assert.equal(canonicalJson({
    cycleIds: await restartedRepository.listKnownCycleIds(), terminalState: restartedCycle.terminalState,
    chainAttempts: [...restartedCycle.chainAttempts], operationalAttempts: [...restartedCycle.operationalAttempts],
    supplementaryChainAttempts: [...restartedCycle.supplementaryChainAttempts],
    settlement: await restartedRepository.readSupplementarySettlement(held[0].positionId),
    settlementEvidence: await restartedRepository.readSupplementarySettlementEvidence(held[0].positionId),
    payout: await restartedRepository.readPagedPayoutState(cycleIds[0], supplementaryPayoutStageId(held[0].positionId)),
    held: [...restartedCycle.heldPositions], custody: [...restartedCycle.custodyLedgers],
  }), frozenFinalCycle, 'final restart preserves durable cycle, manifest, payout, custody and attempt state');
  assert.equal(new Set([run, ordinaryRestart, ...supplementaryRuns, finalRestart].map(value => value.pid)).size, 6);
  await authority.stop();
  authority.assertHealthy();
  await assertCopiedProductionBytes(root, identity);
  assert.equal(BigInt(finalCustody.gasSpent.amountAtomic), BigInt(custody.gasSpent.amountAtomic) + 42000n, 'supplementary native payout adds exactly its own gas');
});

// Supporting in-process scenario uses real composed handlers with synthetic adapters.
// Eligibility and outbound are durable fixture preconditions; the literal CLI test above
// independently proves automatic admission and the complete production transport path.
const NATIVE_SOLANA_CHAIN_ID = 'solana-mainnet';
// The pinned production Operations EVM identity `PRODUCTION_ADMISSION_IDENTITY.evm`
// (policy-engine.mjs) requires by exact equality (default, no `createTestOnlyAdmissionIdentity`
// override -- see the admission header comment below): every admission/quote/liability-evidence
// field this file builds uses this literal. It is deliberately NOT the same account
// `config.accounts.evm` signs with below (`operationsEvmAccount`, an ephemeral in-process test
// key) -- exactly like `config.accounts.solana` (the real signing `operator`) already differs from
// `PRODUCTION_OPERATIONS_SOLANA` (the pinned admission identity) a few lines down. No test can hold
// this address's real private key, and none of this admission-identity plumbing ever needs to sign
// anything itself.
const PRODUCTION_OPERATIONS_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const PRODUCTION_OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const N2_GRAPH_PACK_CODE = 'return-fixture';
const RELAY_FUNDING_ROUTE = Object.freeze({ chainId: '4663', assetId: 'native', decimals: 18 });
// Admission purchase quotes use Relay's numeric namespace; Collector observations use native Solana.
const RELAY_PURCHASE_ROUTE = Object.freeze({ chainId: String(RELAY_SOLANA_CHAIN_ID), assetId: SOLANA_MINT, decimals: 6 });

function composedTyped(asset, amountAtomic) {
  return { ...asset, amountAtomic };
}

function composedOnchainCycleId(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

const COMPOSED_EVIDENCE_CEILING_ATOMIC = '1000000';
const COMPOSED_HOOK_ADDRESS = `0x${'7'.repeat(40)}`;
const COMPOSED_DEADLINE_UNIX_SECONDS = 2_000_000_000;

// Return's own Relay RETURN-direction leg (Solana settlement-asset proceeds -> EVM USDG): a
// syntactically valid, arbitrary Solana depository address (never a live account, same convention
// as `COLLECTOR_SETTLEMENT_RECIPIENT`), the EVM address Relay's own solver would send the
// destination-side credit from (this process never signs that leg -- it is a foreign chain event,
// exactly like `outboundDestinationTransaction`'s own documented rationale above), and one fixed
// destination transaction hash/request/order identity.
const RELAY_RETURN_DEPOSITORY_SOLANA = 'H8sMJSCQxfKiFTCfDR3DjMUdcfsEZ4zL5HWTZ9wioT4x';
const RELAY_RETURN_SOLVER_EVM = `0x${'6'.repeat(40)}`;
const RELAY_RETURN_DESTINATION_TX_HASH = `0x${'b'.repeat(64)}`;
const RELAY_RETURN_REQUEST_ID = 'n2-composed-return';
const RELAY_RETURN_ORDER_ID = `0x${'9'.repeat(64)}`;
// The later supplementary held-card sale's own real return leg, entirely separate identity from
// the main cycle's own -- never a reuse of the main leg's own request id, order id, or destination
// transaction hash.
const RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH = `0x${'5'.repeat(64)}`;
const RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID = 'n2-composed-supplementary-return';
const RELAY_SUPPLEMENTARY_RETURN_ORDER_ID = `0x${'4'.repeat(64)}`;

/**
 * One real, decodable SPL `TransferChecked` instruction moving `amount` of `mint` from
 * `source`/`owner` to `destination` -- built entirely from the installed instruction-builder
 * (`buildTransferCheckedInstruction`, solana-rpc.mjs), then reshaped into the
 * `{programId, keys, data}` wire form `extractRelaySolanaInstructionPlan`/`relayInstruction`
 * (return.mjs/solana-rpc.mjs) require for a Relay-recorded instruction plan. Never derived from a
 * candidate transaction -- this is the request side, independently constructed before any signer or
 * provider response exists.
 */
const SYNTHETIC_RELAY_PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
// Isolated quote rate: each USDC atomic source unit buys 101 wei, never a unit alias.
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

/**
 * The real `/quote/v2` raw response shape `parseQuoteResponse`/`assertQuoteIdentity`
 * (relay-client.mjs) require for a RETURN-direction quote, built entirely from this scenario's own
 * already-configured Operations accounts and the exact independently-built instruction above --
 * never from anything a candidate provides. Reused, chain-reversed, from this same file's own
 * `composedRawRelayQuote` (OUTBOUND-direction admission quote) shape.
 */
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

/** A finalized hook process-liability read, shaped exactly as normalizeProcessLiabilityEvidence
 * (policy-engine.mjs) requires: solvent, unpaused, unused, and internally consistent. */
function composedProcessLiabilityEvidence(cycleId) {
  return {
    schema: 'hookemon.process-liability-evidence.v2',
    chainId: RELAY_FUNDING_ROUTE.chainId,
    assetId: RELAY_FUNDING_ROUTE.assetId,
    decimals: RELAY_FUNDING_ROUTE.decimals,
    hook: COMPOSED_HOOK_ADDRESS,
    cycleId,
    onchainCycleId: composedOnchainCycleId(cycleId),
    blockNumber: '999',
    blockHash: `0x${'4'.repeat(64)}`,
    finalized: true,
    processLiability: COMPOSED_EVIDENCE_CEILING_ATOMIC,
    remainingProcessClaimCapacity: COMPOSED_EVIDENCE_CEILING_ATOMIC,
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: COMPOSED_EVIDENCE_CEILING_ATOMIC,
    totalLiability: COMPOSED_EVIDENCE_CEILING_ATOMIC,
    hookNativeBalance: COMPOSED_EVIDENCE_CEILING_ATOMIC,
    isSolvent: true,
    operations: PRODUCTION_OPERATIONS_EVM,
    ceilingAtomic: COMPOSED_EVIDENCE_CEILING_ATOMIC,
  };
}

/** Relay's own raw exact-output outbound-bridge quote response for one target amount. */
function composedRawRelayQuote({ requestId, orderId, originAmount, destinationAmount, sender = PRODUCTION_OPERATIONS_EVM, recipient = PRODUCTION_OPERATIONS_SOLANA }) {
  return {
    requestId,
    steps: [{ kind: 'transaction', id: `step-${requestId}`, requestId, items: [] }],
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

function composedParsedRelayQuote({ requestId, orderId, originAmount, destinationAmount }) {
  const raw = composedRawRelayQuote({ requestId, orderId, originAmount, destinationAmount });
  return {
    direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', requestId, orderId,
    sender: PRODUCTION_OPERATIONS_EVM, recipient: PRODUCTION_OPERATIONS_SOLANA,
    deadlineUnixSeconds: COMPOSED_DEADLINE_UNIX_SECONDS,
    origin: { chainId: 4663, address: `0x${'00'.repeat(20)}`, symbol: 'ETH', decimals: 18, amount: originAmount, amountFormatted: null, minimumAmount: null },
    destination: {
      chainId: RELAY_SOLANA_CHAIN_ID, address: SOLANA_MINT, symbol: 'CIRCLE_USD', decimals: 6,
      amount: destinationAmount, amountFormatted: null, minimumAmount: destinationAmount,
    },
    stepCount: raw.steps.length, raw, quoteDigest: null,
  };
}

function composedRelayIdentity(quote, destinationAmount) {
  return {
    tradeType: 'EXACT_OUTPUT', requestId: quote.requestId, orderId: quote.orderId,
    deadlineUnixSeconds: quote.deadlineUnixSeconds, sender: quote.sender, recipient: quote.recipient,
    destinationAmount, destinationMinimumAmount: destinationAmount, quoteDigest: quote.quoteDigest,
  };
}

async function composedN2Admission(cycleId, now = Date.now) {
  let unit = composedParsedRelayQuote({
    requestId: `req-unit-${cycleId}`, orderId: `0x${'1'.repeat(64)}`,
    originAmount: UNIT_FUNDING_ATOMIC.toString(), destinationAmount: UNIT_PURCHASE_ATOMIC.toString(),
  });
  let aggregate = composedParsedRelayQuote({
    requestId: `req-aggregate-${cycleId}`, orderId: `0x${'2'.repeat(64)}`,
    originAmount: AGGREGATE_FUNDING_ATOMIC.toString(), destinationAmount: AGGREGATE_PURCHASE_ATOMIC.toString(),
  });
  async function produced(quote) {
    const client = createRelayClient({ now, quoteValidityMs: 600000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(quote.raw) }) });
    return client.quote({ direction: 'OUTBOUND', amount: quote.destination.amount, tradeType: 'EXACT_OUTPUT',
      user: quote.sender, recipient: quote.recipient, skipRouteCheck: true });
  }
  unit = await produced(unit); aggregate = await produced(aggregate);
  return {
    schema: 'hookemon.policy-admission.v3',
    cycleId,
    packId: N2_GRAPH_PACK_CODE,
    quantity: 2,
    quoteDigest: aggregate.quoteDigest,
    unitPurchase: composedTyped(RELAY_PURCHASE_ROUTE, UNIT_PURCHASE_ATOMIC.toString()),
    aggregatePurchase: composedTyped(RELAY_PURCHASE_ROUTE, AGGREGATE_PURCHASE_ATOMIC.toString()),
    unitFundingQuote: composedTyped(RELAY_FUNDING_ROUTE, UNIT_FUNDING_ATOMIC.toString()),
    aggregateFundingQuote: composedTyped(RELAY_FUNDING_ROUTE, AGGREGATE_FUNDING_ATOMIC.toString()),
    unitFundingUsd: createQuoteUsdValuation({ quote: unit, side: 'origin', amount: composedTyped(RELAY_FUNDING_ROUTE, unit.origin.amount), rounding: 'up', nowMs: now() }),
    aggregateFundingUsd: createQuoteUsdValuation({ quote: aggregate, side: 'origin', amount: composedTyped(RELAY_FUNDING_ROUTE, aggregate.origin.amount), rounding: 'up', nowMs: now() }),
    relay: composedRelayIdentity(aggregate, AGGREGATE_PURCHASE_ATOMIC.toString()),
    unitRelay: composedRelayIdentity(unit, UNIT_PURCHASE_ATOMIC.toString()),
    unitRelayQuote: unit,
    relayQuote: aggregate,
    processLiabilityEvidence: composedProcessLiabilityEvidence(cycleId),
  };
}

function composedN2PolicyPatch() {
  return {
    intervalMinutes: 5,
    allowedPackIds: [N2_GRAPH_PACK_CODE],
    requestedOrders: 2,
    maxBoostersPerCycle: 2,
    maxUnitPriceMicroUsd: UNIT_FUNDING_ATOMIC.toString(),
    maxCycleBudgetMicroUsd: AGGREGATE_FUNDING_ATOMIC.toString(),
    max24HourBudgetMicroUsd: AGGREGATE_FUNDING_ATOMIC.toString(),
    paused: false,
    liveMode: true,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsd: AGGREGATE_FUNDING_ATOMIC.toString(),
    lossCapMicroUsd: '1000',
    maxOutstandingCustodyMicroUsd: '1000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
  };
}

// A real, positive HKMN balance is required: `assertPlan`'s own `assertHkmnAmount`
// (payout.mjs:268-288) refuses a plan whose `totalEligibleHkmn` is not a positive atomic integer
// unconditionally, so the zero-entry `NON_SPENDING_NO_ELIGIBLE_HOLDERS` outcome
// `compileDirectPayoutPlan` (payout-plan.mjs) otherwise documents can never durably reach this
// stage's own request boundary. One eligible holder is therefore the truthful minimum manifest.
const ELIGIBLE_HOLDER_ADDRESS = `0x${'9'.repeat(40)}`;

/**
 * A self-consistent, one-eligible-holder `hookemon.eligibility-payout-manifest.v1`, built entirely
 * through the real `createEligibilityPayoutManifest` (pro-rata.mjs) shape validator rather than a
 * placeholder object -- payout's own `compileDirectPayoutPlan` (payout-plan.mjs) durably reads this
 * exact evidence and refuses anything not shaped this way. eligibility-snapshot's own real
 * log-replay/holder-scan machinery is independently covered elsewhere
 * (offline-simulation-acceptance-checklist.md) and remains a precondition here, exactly as this
 * file's own header comment already establishes for this stage.
 */
function composedEligibilityPayoutManifest(cycleId) {
  return createEligibilityPayoutManifest({
    cycleId,
    snapshotBlock: '999',
    snapshotHash: `0x${'5'.repeat(64)}`,
    finality: { policyId: 'n2-graph-composed-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: `0x${'d'.repeat(40)}`, decimals: 18, amountAtomic: '1' },
    entries: [{ recipient: ELIGIBLE_HOLDER_ADDRESS, hkmnBalance: { chainId: '4663', assetId: `0x${'d'.repeat(40)}`, decimals: 18, amountAtomic: '1' } }],
    exclusions: [],
    feasibility: {
      recipientCount: 1,
      transactionCount: 1,
      maxRecipientCount: 2,
      maxTransactionCount: 2,
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      // `payout-plan.mjs`'s own `assertEligibilityPayoutManifest` independently recomputes and
      // cross-checks this whole envelope: estimatedNativeFee = transactionCount * measuredTransferGas
      // * maxGasPriceWei (1 * 50000 * 2 = 100000); requiredNativeAmount = estimatedNativeFee +
      // nativeReserve; nativeBalance must cover requiredNativeAmount. `nativeReserve` must also be at
      // least `config.moneyConfiguration.evm.nativeReserve.amountAtomic` ('2') --
      // `assertDirectPayoutMoneyConfiguration` (payout.mjs) only ever checks that once a real payable
      // recipient reaches this far, unreachable before this session's own real positive return.
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100002' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100002' },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'n2-graph-composed-primary', transferLogDigest: digest({ domain: 'n2-graph-composed-transfer-log.v1', cycleId }), logCount: 0 },
      secondary: null,
    },
    holderSnapshotDigest: digest({ domain: 'n2-graph-composed-holder-snapshot.v1', cycleId }),
    launchManifestDigest: digest({ domain: 'n2-graph-composed-launch-manifest.v1', cycleId }),
  });
}

// `claim-process` is deliberately NOT pre-seeded here: it is the real graph's own first
// money-moving stage, and this scenario now drives it for real (real EVM claim transaction,
// signed and "broadcast" through this file's own in-process EVM fixture, then finalized and
// custody-recorded) through the composed service's real `runOnce()`, exactly like purchase,
// buyback, and return already are. `outbound` remains a durable precondition, pre-completed
// directly through the real `CycleRepository` (unowned by this task -- the core/facade recovery
// owner is actively changing `outbound.mjs` in a separate worktree; this task never depends on or
// exercises its real execution) -- see the header comment above this scenario's `test(...)` for
// the full rationale this pattern already documents.
async function completeN2PriorStages(repository, cycleId) {
  await repository.prepareStage(cycleId, 'eligibility-snapshot');
  await repository.completeStage(cycleId, 'eligibility-snapshot', composedEligibilityPayoutManifest(cycleId));
}

// `outbound` is a durable precondition, pre-completed directly through the real `CycleRepository`
// only once claim-process has really finalized -- `completeStage`'s own predecessor-ordering check
// (cycle-repository.mjs) refuses an out-of-order write otherwise, and this scenario's own real
// claim-process execution below is what actually reaches that point. `outbound.mjs` is unowned by
// this task (the core/facade recovery owner is actively changing it in a separate worktree); this
// never depends on or exercises its real execution -- see the header comment above this scenario's
// `test(...)` for the full rationale this pattern already documents.
async function completeN2OutboundPrecondition(repository, cycleId) {
  await repository.prepareStage(cycleId, 'outbound');
  await repository.completeStage(cycleId, 'outbound', { source: 'n2-graph-composed-precondition' });
}

/** One syntactically valid, unsigned legacy Solana transaction binding the reviewed fixture
 * binding's exact program ids, account roles, destination, mint, decimals, provider co-signer,
 * compute limits/priority cap, and memo prefix -- never derived from any candidate. */
function composedCandidateTransaction({
  memoValue, blockhash, operator, providerCoSigner, destination, computeUnitLimit, priorityFeeCapAtomic, memoPrefix,
}) {
  const sourceAta = deriveAssociatedTokenAddress(operator.publicKey.toBase58(), SOLANA_MINT);
  const transaction = new Transaction({ feePayer: operator.publicKey, recentBlockhash: blockhash });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(priorityFeeCapAtomic) }));
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(UNIT_PURCHASE_ATOMIC, 1);
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

test('N=2 composed offline scenario: real compose(config) drives purchase through the reviewed fixture binding', { timeout: 30000 }, async t => {
  const graphTimeMs = Date.now();
  const graphNow = () => graphTimeMs;
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-n2-composed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = directory;
  const statePath = join(directory, 'operator-state.json');

  // Ephemeral, in-process, public test signer for the EVM Operations role -- the same convention as
  // this scenario's own Solana `operator = Keypair.generate()` below. This is the account
  // claim-process (and, for a real recipient, payout) actually signs its EIP-1559 transactions
  // with; it is deliberately NOT `PRODUCTION_OPERATIONS_EVM` (see that constant's own comment) --
  // `config.accounts.evm` binds to this generated address, never to the pinned admission identity.
  const operationsEvmAccount = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const OPERATIONS_EVM_SIGNING_ADDRESS = operationsEvmAccount.address.toLowerCase();

  const setupRepository = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  const cycleId = setupRepository.nextCycleId();
  const admission = await composedN2Admission(cycleId, graphNow);

  await mutateOperatorState(statePath, null, state => ({
    ...(state ?? createEmptyOperatorState()),
    configuration: applyOperatorConfiguration(null, composedN2PolicyPatch()),
  }));

  await setupRepository.createCycle({
    cycleId, releaseAmount: AGGREGATE_FUNDING_ATOMIC.toString(), mode: 'production', providerMode: 'live', admission,
  });
  await completeN2PriorStages(setupRepository, cycleId);

  // Production-profile signing (this scenario's own `execution.profile: 'production'` /
  // `providerMode: 'live'`) requires a verified standing-authority document at every signing
  // boundary (stage-driver.mjs's own `requiresStandingAuthority`/`configuredStandingAuthority`) --
  // reusing the exact same reviewed, owner-signature-simulating technique the literal-CLI test
  // above already uses (`attachOwnerSignature`/`buildCanonicalStandingAuthorityDocument`/
  // `createStandingAuthorityProvider`, standing-authority.mjs's own documented test seam), but
  // resolved synchronously in-process instead of that test's separate file-watching publisher,
  // since this scenario never spawns a CLI and already has direct access to the policy key.
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
  // Every purchase sign call this run makes shares one stage-level requestDigest (stage-driver.mjs
  // computes `preparedRequestDigest` once per `mutate()` invocation, before either pack signs), so
  // both packs' step-authorization intents are byte-identical and the second is a first-use replay
  // through the real provider's own persisted-decision path -- never a second cap consumption.
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

  // Ephemeral, in-process, public test signer -- no Keychain, no child process, no real chain.
  const operator = Keypair.generate();
  const providerCoSigner = Keypair.generate();
  const settlementDestination = Keypair.generate();
  const signSpy = { calls: 0 };
  // Populated by `signerClient.solana.broadcast` below (return's own `wrapTransactionPolicySignerClient`
  // path) from the real signed bytes it actually broadcasts -- never a hardcoded proceeds amount --
  // so `solanaClient`'s own `getTransaction` fixture (further below) can prove the exact same source
  // debit return.mjs's `readFinalizedRelaySourceDebit` independently re-derives.
  let returnSourceSignature = null;
  const returnSignedBytes = new Map();
  let returnProceedsAtomic = null;
  // Populated by `evmClaimReceiptLogs`'s own `transfer` branch below, from the real decoded
  // arguments of direct payout's own actually-signed-and-broadcast ERC20 `transfer` call -- never a
  // value this fixture invents independently of that accepted transaction -- so the historical
  // source/recipient balance-delta evidence `readFinalizedErc20TransferProof`
  // (robinhood-rpc.mjs) independently re-derives always agrees with what payout actually sent.
  let payoutTransferAmount = null;
  let payoutRecipientAddress = null;
  // The later supplementary held-card sale's own real source signature/proceeds and payout
  // transfer amount/recipient -- populated exactly the same way as the main cycle's own, from the
  // real signed/broadcast bytes only, never inserted independently of them.
  let supplementaryReturnSourceSignature = null;
  let supplementaryReturnProceedsAtomic = null;
  let supplementaryPayoutTransferAmount = null;
  let supplementaryPayoutRecipientAddress = null;
  const signerClient = {
    solana: {
      async probe() { return { ready: true }; },
      // Purchase/buyback call this directly with a bare base64 string; return's own
      // `wrapTransactionPolicySignerClient` (signer-client.mjs) calls it with the full
      // `{transaction, transactionPolicy, transactionPolicyRules, transactionDecodeOptions, liveMode}`
      // request object instead -- both real, reviewed calling conventions this one raw signer must
      // honor, never a hint of which candidate stage is asking.
      async sign(request) {
        signSpy.calls += 1;
        const transactionBase64 = typeof request === 'string' ? request : request.transaction;
        const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
        transaction.partialSign(operator);
        return { signedTxBase64: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64') };
      },
      // Return's own broadcast capability (`wrapTransactionPolicySignerClient` requires both
      // `sign()` and `broadcast()` on the raw signer for any role with `ROLE_CAPABILITIES[role].broadcast`
      // true) -- decodes the exact signed bytes it was actually handed to recover both the real
      // signature and the real proceeds amount pack 0's own TransferChecked instruction carries, so
      // `solanaClient`'s later `getTransaction` read proves exactly this same accepted transaction,
      // never a value inserted independently of it.
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
        // The main cycle's own return always broadcasts first, chronologically; the later
        // supplementary held-card sale's own return only ever broadcasts once the main one already
        // has -- a real, structural ordering this scenario's own sequence guarantees, never a guess.
        if (returnProceedsAtomic === null) {
          returnSourceSignature = signature;
          returnProceedsAtomic = proceeds;
        } else {
          supplementaryReturnSourceSignature = signature;
          supplementaryReturnProceedsAtomic = proceeds;
        }
        return { signature };
      },
    },
    // Ephemeral, in-process EVM signer for claim-process's real EIP-1559 `claimProcess` call (and,
    // for a real payable recipient, direct payout's own transfer) -- `operationsEvmAccount.signTransaction`
    // both serializes and signs, exactly matching what `signerClient.evm.sign` must hand back
    // (claim-process.mjs's own `parseSignedClaim`/`assertSignedClaimStatic` decode and verify these
    // exact bytes). No policy/authority check happens here -- stage-driver.mjs's own guarded facade
    // (never this raw signer) is what enforces the standing-authority/policy gate before this is ever
    // reached, exactly like the Solana signer above.
    evm: {
      // Direct payout's own `createDirectPayoutPolicySignerForAttempt` (payout.mjs) requires this
      // exact role string on the raw signer before it ever wraps it -- unlike return's Solana
      // signer above, it never defaults one on this raw signer's behalf.
      role: OPERATOR_EVM_ROLE,
      async probe() { return { ready: true }; },
      async sign({ transaction }) {
        signSpy.calls += 1;
        // claim-process's own transaction is EIP-1559 (`maxFeePerGas`/`maxPriorityFeePerGas`);
        // direct payout's own transaction (`buildTransaction`, payout.mjs) is legacy (a single
        // `gasPrice`) -- both real, reviewed shapes this one raw signer must honor.
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
      // Direct payout's own EVM transfer also goes through `wrapTransactionPolicySignerClient`
      // (unlike claim-process's own direct call above), which requires both `sign()` and
      // `broadcast()` on the raw signer. Reuses the real `robinhoodStub.sendRawTransaction` --
      // the exact same real broadcast path claim-process's own signed bytes already go through --
      // never a separate, parallel fake broadcast mechanism.
      async broadcast({ signedTx }) {
        const transactionHash = await robinhoodStub.sendRawTransaction({ serializedTransaction: signedTx });
        return { transactionHash };
      },
    },
  };

  // Two independently pinned usable blockhash/height pairs, one per pack, and two distinct durable
  // memos -- exactly as the reviewed purchase policy wiring requires (N=2: one generation call, two
  // memo-bound policies, two signs and two submits).
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
        memoValue: MEMO_PACK_0, blockhash: BLOCKHASH_PACK_0, operator, providerCoSigner,
        destination: settlementDestination, computeUnitLimit: COMPUTE_UNIT_LIMIT,
        priorityFeeCapAtomic: PRIORITY_FEE_CAP_ATOMIC, memoPrefix: MEMO_PREFIX,
      }),
    },
    {
      memo: MEMO_PACK_1,
      transaction: composedCandidateTransaction({
        memoValue: MEMO_PACK_1, blockhash: BLOCKHASH_PACK_1, operator, providerCoSigner,
        destination: settlementDestination, computeUnitLimit: COMPUTE_UNIT_LIMIT,
        priorityFeeCapAtomic: PRIORITY_FEE_CAP_ATOMIC, memoPrefix: MEMO_PREFIX,
      }),
    },
  ];

  const calls = {
    getMachines: 0, generateYoloPacks: 0, getPackStatus: 0, submitTransaction: 0, openPack: 0,
    getNfts: 0, getBuybackAvailable: 0, buyback: 0, getBuybackCheck: 0,
  };
  // Purchase reconciliation (reconcileLivePurchase/reconcilePack, purchase.mjs) requires each
  // pack's provider status to carry a documented `transaction_signature`, which it then verifies
  // finalized on-chain with an exact settlement debit -- so submitTransaction's own broadcast order
  // (packs are signed/submitted in `batch.packs` order, one call each) is the only honest way to
  // learn which of these two independently pinned memos a given signature belongs to.
  const packMemosInBatchOrder = [MEMO_PACK_0, MEMO_PACK_1];
  const purchaseSignaturesByMemo = new Map();
  const buybackSignaturesByMemo = new Map();
  // Open's own award facts, one per memo, independently pinned before any candidate `openPack`
  // call exists: a distinct card mint and a distinct provider-reported transaction signature per
  // pack, exactly as `assertOpenPackResponse` (collector-crypt.mjs) documents a real award
  // carrying (`nft_address`, `transaction_signature`). Card mints are Solana-address-shaped
  // Keypair public keys rather than the settlement mint, so open's own mint-derivation cannot
  // confuse a card award with the purchase settlement debit.
  const cardAwardsByMemo = new Map([
    [MEMO_PACK_0, { mint: Keypair.generate().publicKey.toBase58(), signature: Keypair.generate().publicKey.toBase58() }],
    [MEMO_PACK_1, { mint: Keypair.generate().publicKey.toBase58(), signature: Keypair.generate().publicKey.toBase58() }],
  ]);
  const openedMemos = new Set();
  // Epic-gate's own documented per-card facts (epic-gate.mjs, pack-status.json/get-nfts.json's
  // real field names), independently pinned per memo before any candidate epic-gate call exists.
  // Pack 0 reconciles to a real `sell` decision (prize tier 4/common, so the below-40%-insured
  // threshold -- reserved for tier 1/epic -- never applies); pack 1 follows the documented
  // `buyback is unavailable` held path (epic-gate.mjs's own `HELD_UNAVAILABLE`/`BUYBACK_UNAVAILABLE`
  // outcome), never a distorted or invented below-40% construction.
  const EPIC_GATE_INSTANT_BUYBACK_PERCENT = 90;
  const EPIC_GATE_SETTLEMENT_ASSET = Object.freeze({ chainId: NATIVE_SOLANA_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 });
  const EPIC_GATE_SELL_OFFER_ATOMIC = '90';
  // The later supplementary held-card sale's own real Collector offer, once provider availability
  // genuinely changes -- a distinguishable amount from the main cycle's own 90, never the same
  // value, so every later assertion can tell the two real proceeds apart unambiguously.
  const EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC = '45';
  const epicGateFactsByMemo = new Map([
    [MEMO_PACK_0, { prizeTier: 4, rarity: 'common', insuredValue: 100, buybackAvailable: true }],
    [MEMO_PACK_1, { prizeTier: 3, rarity: 'uncommon', insuredValue: 50, buybackAvailable: false }],
  ]);
  // Provider availability for pack 1's held card genuinely changes later, once the operator's own
  // held-owner-decision has recorded `sell` -- never available from the start, and never flipped
  // before the real decision exists.
  let supplementaryBuybackAvailable = false;
  const availabilityObservations = [];
  const collectorCrypt = {
    async getMachines() {
      calls.getMachines += 1;
      return { machines: [{ code: N2_GRAPH_PACK_CODE, price: PACK_PRICE, contains: 1, instantBuyback: EPIC_GATE_INSTANT_BUYBACK_PERCENT }] };
    },
    async generateYoloPacks({ playerAddress, quantity }) {
      calls.generateYoloPacks += 1;
      assert.equal(playerAddress, operator.publicKey.toBase58());
      assert.equal(quantity, 2);
      return { packs };
    },
    async getPackStatus({ memo }) {
      calls.getPackStatus += 1;
      const signature = purchaseSignaturesByMemo.get(memo);
      if (signature === undefined) return { memo, pack: null, send: null, buyback: [] };
      const award = openedMemos.has(memo) ? cardAwardsByMemo.get(memo) : null;
      const epicFacts = epicGateFactsByMemo.get(memo);
      return {
        memo,
        pack: { transaction_signature: signature, token_mint: SOLANA_MINT, nft_address: null, pack_type: N2_GRAPH_PACK_CODE },
        send: award === null ? null : {
          transaction_signature: award.signature, nft_address: award.mint, to_wallet: operator.publicKey.toBase58(),
          prize_tier: epicFacts.prizeTier, insured_value: epicFacts.insuredValue,
        },
        buyback: [],
      };
    },
    async submitTransaction({ signedTransaction }) {
      const signature = signedSolanaTransactionSignature(signedTransaction);
      // The provider's own single generic submit endpoint, shared by purchase and buyback alike:
      // the first two calls are the purchase batch's own broadcasts, in `batch.packs` order (see
      // the comment above); any call after that is this scenario's own single buyback broadcast,
      // unambiguous because exactly one pack ever reaches a real sell decision.
      if (calls.submitTransaction < packMemosInBatchOrder.length) {
        const memo = packMemosInBatchOrder[calls.submitTransaction];
        calls.submitTransaction += 1;
        purchaseSignaturesByMemo.set(memo, signature);
        // `Set.add` on the exact same recovered signature is a no-op -- a duplicate resubmission
        // (real restart/retry) never advances `getLatestBlockhash`'s own chain-state index twice.
        acceptedPurchaseSignatures.add(signature);
        return { signature };
      }
      // Exactly one more broadcast ever follows the purchase batch: pack 0's own main-cycle
      // buyback, first. The later supplementary held-card sale's own buyback broadcasts strictly
      // after that -- discovered by pack 0's own signature already being recorded, never a raw
      // call-count guess.
      calls.submitTransaction += 1;
      if (!buybackSignaturesByMemo.has(MEMO_PACK_0)) {
        buybackSignaturesByMemo.set(MEMO_PACK_0, signature);
      } else {
        buybackSignaturesByMemo.set(MEMO_PACK_1, signature);
      }
      return { signature };
    },
    // The real documented award shape (collector-crypt.mjs's `assertOpenPackResponse`): `success`
    // plus the card's mint and the provider's own settlement signature for the open. Marking the
    // memo opened here, not before, is what lets `getPackStatus` truthfully withhold the
    // memo-bound send until the provider mutation this fixture models has actually happened.
    async openPack({ memo }) {
      calls.openPack += 1;
      const award = cardAwardsByMemo.get(memo);
      if (award === undefined) throw new Error(`N=2 composed scenario: openPack called for unknown memo ${memo}`);
      openedMemos.add(memo);
      return { success: true, nft_address: award.mint, transaction_signature: award.signature };
    },
    // The documented `getNfts` pagination shape (get-nfts.json): one page carrying both cards'
    // own already-pinned rarity/insured-value records, independently of any candidate call.
    async getNfts({ code, page, limit }) {
      calls.getNfts += 1;
      assert.equal(code, N2_GRAPH_PACK_CODE, `getNfts must be scoped to this cycle's own pack code; ${code}`);
      assert.equal(page, 1);
      assert.equal(limit, 50);
      const nfts = [MEMO_PACK_0, MEMO_PACK_1].map(memo => {
        const facts = epicGateFactsByMemo.get(memo);
        return { nft_address: cardAwardsByMemo.get(memo).mint, rarity: facts.rarity, insured_value: facts.insuredValue };
      });
      return { nfts, hasMore: false, page, limit };
    },
    // The documented `buyback/available` shape (buyback-available.json), already normalized onto
    // the typed settlement asset exactly as collector-crypt.mjs's own real client parses it --
    // this fixture stands directly in for that client, never for its raw unparsed HTTP body.
    async getBuybackAvailable({ nft, wallet }) {
      calls.getBuybackAvailable += 1;
      availabilityObservations.push({nft, wallet, expectedWallet: operator.publicKey.toBase58(), supplementaryBuybackAvailable});
      assert.equal(wallet, operator.publicKey.toBase58());
      const entry = [...epicGateFactsByMemo.entries()].find(([memo]) => cardAwardsByMemo.get(memo).mint === nft);
      if (entry === undefined) throw new Error(`N=2 composed scenario: getBuybackAvailable called for unknown card ${nft}`);
      const [memo, facts] = entry;
      // Pack 1's own availability genuinely changes later, once the operator's real held-owner
      // decision exists -- never available before that, matching the checklist's own required
      // "change provider availability so the held card can sell later" step.
      const available = facts.buybackAvailable || (memo === MEMO_PACK_1 && supplementaryBuybackAvailable);
      if (!available) return { available: false };
      availabilityObservations.at(-1).available = available;
      const offer = memo === MEMO_PACK_1 ? EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC : EPIC_GATE_SELL_OFFER_ATOMIC;
      return { available: true, amount: { ...EPIC_GATE_SETTLEMENT_ASSET, amountAtomic: offer } };
    },
    // The documented `buyback` mutation (buyback.mjs's own `buildCollectorBuybackRequest`): one
    // real unsigned Collector buyback transaction, built here -- lazily, at call time, never
    // before -- from the same independently pinned program/recipient/blockhash/instruction-data
    // literals the trusted policy template below was built from. This candidate is a genuinely
    // separate construction from that template (built later, from this call's own arguments), not
    // a reuse of any object the policy was derived from. Real for either pack's own card: pack 0's
    // main-cycle sale, or pack 1's later supplementary sale once it becomes available.
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
    // The documented `buyback/check` shape: consulted per memo, only once this fixture's own
    // `submitTransaction` has actually recorded a signature for that exact memo's own buyback --
    // reconciliation must never observe a completed check before that, for either pack's own sale.
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
  // One fixture finalized-transaction fact per submitted signature: exactly the admitted per-pack
  // debit (`UNIT_PURCHASE_ATOMIC`), from the operator's own settlement token account, in the
  // configured native settlement mint -- what `reconcilePack`'s own
  // `getFinalizedTokenBalanceChanges` independently re-derives and checks against the cycle's
  // immutable admission, never trusted as a provider-supplied literal.
  const PURCHASE_DEBIT_PRE_ATOMIC = 100n;
  const purchaseTokenAccountAddress = Keypair.generate().publicKey.toBase58();
  // The operator's own card token account credited by each open award -- a distinct fixture
  // account from the settlement token account above, since a card mint is never the settlement
  // mint.
  const cardTokenAccountAddress = Keypair.generate().publicKey.toBase58();

  const blockhashHeights = new Map([[BLOCKHASH_PACK_0, HEIGHT_PACK_0], [BLOCKHASH_PACK_1, HEIGHT_PACK_1]]);
  // Collector buyback's own program/recipient/instruction-data facts, pinned as literals before
  // any candidate buyback transaction exists -- mirroring `COLLECTOR_SETTLEMENT_RECIPIENT`'s own
  // pattern above. Syntactically valid, arbitrary base58 Solana addresses; they name no live
  // account. `BUYBACK_SELL_MINT` reuses pack 0's own card mint, itself independently pinned back
  // in `cardAwardsByMemo` before any purchase/open candidate ever existed.
  const COLLECTOR_BUYBACK_PROGRAM_ID = Keypair.generate().publicKey.toBase58();
  const COLLECTOR_BUYBACK_RECIPIENT = Keypair.generate().publicKey.toBase58();
  const COLLECTOR_BUYBACK_INSTRUCTION_DATA = Buffer.from('collector-buyback:v1', 'utf8');
  const BUYBACK_SELL_MINT = cardAwardsByMemo.get(MEMO_PACK_0).mint;
  // Pack 1's own card mint, reused for its later real supplementary sale once it becomes available.
  const SUPPLEMENTARY_SELL_MINT = cardAwardsByMemo.get(MEMO_PACK_1).mint;
  // The composed config's own trusted Solana blockhash resolver (compose.mjs's
  // `createTrustedSolanaBlockhashContextResolver`, wired in by `compose()` itself for every
  // decode-time revalidation) refuses any blockhash that is not the current "latest" this
  // fixture's own `getLatestBlockhash` sequence reports -- and by the time buyback signs, that
  // sequence's call-count index has long since saturated at its final entry, `BLOCKHASH_PACK_1`.
  // Building the buyback transaction against that same, still-current blockhash is what a real
  // Collector-returned candidate would also have to do; it is not a fixture convenience.
  const BUYBACK_BLOCKHASH = BLOCKHASH_PACK_1;

  /**
   * Builds one syntactically valid, unsigned legacy Solana transaction for a Collector buyback,
   * from exactly the given field values -- never reading any pinned literal itself, so the same
   * builder can produce (a) the independently pinned trusted template used only to build the
   * transaction policy below, before any candidate exists; (b) the fake provider's own later
   * candidate, built separately, at call time, from the correct pinned facts; and (c) a
   * deliberately drifted negative fixture, fed only to the standalone policy-refusal proof below,
   * never to the policy itself.
   */
  function buildBuybackTransactionBytes({ recipient, mint, blockhash, data }) {
    const transaction = new Transaction({ feePayer: operator.publicKey, recentBlockhash: blockhash });
    transaction.add(new TransactionInstruction({
      programId: new PublicKey(COLLECTOR_BUYBACK_PROGRAM_ID),
      keys: [
        { pubkey: new PublicKey(recipient), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      ],
      data,
    }));
    return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
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

  /**
   * The buyback transaction policy this scenario's own `config.collectorCrypt.buyback.policy`
   * pins: built from a decoded transaction using the same real `createCanonicalTransactionPolicy`/
   * `createTransactionPolicy` production path `buyback.mjs` itself uses at signing time -- the
   * same rule-construction shape the reviewed Collector evidence bundle
   * (`collector-policy-loader.mjs`'s own `specimenPolicy`) already uses for real historic
   * evidence. There is no Node-test-only fixture-binding seam for buyback (unlike purchase's
   * `testFixtureBinding`), so this is the one honest way to supply a real policy without inventing
   * a new production capability -- callers below must supply an independently built decode, never
   * a decode of the candidate this policy will later govern.
   */
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

  // The independently pinned trusted template: built and decoded from the pinned program/
  // recipient/mint/blockhash/instruction-data facts above, entirely separately from -- and
  // strictly before -- the fake provider's own `buyback()` handler (below) ever runs or
  // constructs its own candidate. `buybackPolicy` is created from this template's own decode
  // only, so the transaction-policy evaluation this scenario proves is a real, independently
  // pinned boundary, never a decode of the candidate producing its own allowlist. A second,
  // independently pinned trusted template -- built from pack 1's own card mint, for its later real
  // supplementary sale -- contributes its own separate allow-rule to this same policy, never a
  // relaxed or mint-agnostic rule standing in for both real cards.
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

  // Negative proof: a candidate differing from the independently pinned trusted template in
  // exactly one field (here, the Collector recipient) must be refused by the real production
  // `decodeProviderTransaction`/`evaluate` pair -- the identical evaluator `buyback.mjs`'s own
  // `decodeAndSign` calls before ever signing or submitting to the provider -- proving the policy
  // boundary is real, not self-fulfilling. This runs standalone, before `compose()` exists and
  // against neither the fake provider nor the signer, so it can never alter any graph counter.
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
  // Modeled on real external chain-state advancement, not a fragile RPC-call counter (a prior
  // revision of this fixture counted raw `getLatestBlockhash` calls and hardcoded "N reads per
  // pack", which silently broke the moment an upstream call pattern changed -- e.g. once
  // claim-process started running for real ahead of purchase in this same tick). Pack 0's blockhash
  // is "current latest" for every read (policy-build, decode, sign, and broadcast-time revalidation)
  // until pack 0's own distinct signed transaction is actually accepted by the provider
  // (`submitTransaction` below, keyed off the exact signed bytes' own recovered signature, never a
  // raw call count) -- only then does the chain "advance" to pack 1's blockhash. A duplicate
  // resubmission of an already-accepted signature (a real restart/retry) must never advance this
  // index a second time.
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
        // Direct payout's own settlement ATA and, since buyback's own real finalized-ownership
        // check (`verifyFinalizedOwnership`, buyback.mjs) independently re-derives the operator's
        // real associated token account for the exact card mint under sale, pack 0's own held-card
        // ATA -- each queried by its own real derived address, never a single hardcoded response
        // regardless of which account was actually asked for.
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
        // "Current latest" tracks real external chain-state advancement: `index` is the count of
        // distinct purchase signatures the provider has actually accepted so far
        // (`acceptedPurchaseSignatures`, populated only by `submitTransaction` below), clamped to
        // the last known pack. Every read before pack 0's own transaction is accepted -- the
        // compose() start-preflight canary, mutatePurchase's own policy-building read
        // (purchase.mjs:491), the trusted decode-time resolver
        // (createTrustedSolanaBlockhashContextResolver, compose.mjs:418-424),
        // wrapTransactionPolicySignerClient's own sign() re-decode, and that same wrapper's
        // broadcast()-time `revalidateSignedMessage` -- observes pack 0's own blockhash, however many
        // reads that turns out to be; this never hardcodes a read count per pack, so it cannot drift
        // out of sync with the real call pattern the way a raw counter did.
        const index = Math.min(acceptedPurchaseSignatures.size, latestBlockhashSequence.length - 1);
        return jsonRpcResult({ context: { slot: 1 }, value: latestBlockhashSequence[index] }, body.id);
      }
      if (body.method === 'getSignatureStatuses') {
        const [signatures] = body.params;
        const known = new Set([
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
        if (new Set(purchaseSignaturesByMemo.values()).has(signature)) {
          const postAmount = PURCHASE_DEBIT_PRE_ATOMIC - UNIT_PURCHASE_ATOMIC;
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
          // The card mint award: the operator's card token account moves from holding none of
          // this mint to exactly one, the same newly-credited-NFT shape
          // `deriveCardAssetFromOpenTransaction` (open.mjs) selects.
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
          // The finalized buyback settlement: the operator's settlement token account is credited
          // the exact quoted offer, and pack 0's own card mint simultaneously leaves the operator
          // -- the same independent pair `cardLeftOperator`/`exactPositiveDeltaEntry` (buyback.mjs)
          // each re-derive on their own, from the same finalized transaction.
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
        // `readFinalizedRelaySourceDebit` (solana-rpc.mjs, called by return.mjs's own real
        // `reconcileLiveReturn`) independently re-derives pack 0's exact source debit from this
        // response -- `returnSourceSignature`/`returnProceedsAtomic` are read here only after
        // `signerClient.solana.broadcast` above has already decoded them from the real signed
        // bytes, never inserted independently of that accepted transaction.
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

  // Only the two methods the live-service start preflight's own EVM chain-id/canary reads use
  // (compose.mjs's assertMainnetRpcChainId / observability canary checks) -- claim-process and
  // outbound are pre-completed above, so no other robinhood-client method should ever be reached.
  // Real claim-process now runs through this in-process EVM fixture: a minimal loopback-style
  // client (plain method calls, not JSON-RPC transport -- unlike the literal-CLI test's own real
  // HTTPS server above, this composed scenario's other stages already use this simpler direct-object
  // convention) that decodes whatever calldata claim-process actually signs and broadcasts, exactly
  // as the literal-CLI test's own `executionLogs`/HOOK_STATE_SELECTORS do over real JSON-RPC -- never
  // keyed on the runner's own intent. One fixed finalized block backs every finality read
  // (claim-process's own pre-sign hook-liability veto, its post-broadcast receipt finalization, and
  // its post-finalize custody-balance observation all read the same canonical height/hash), and
  // fixed, strictly-earlier inclusion blocks back each real transaction's own receipt.
  const N2_HOOK_EVENT_ABI = parseAbi([
    'function claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountAtomicUsdg, address indexed destination, uint256 timestamp, uint256 cap, uint256 usedAfter)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  // Timestamps deliberately pinned well beyond any realistic wall-clock "now": return's own
  // `returnRelayTerminalState` (cycle-repository.mjs) refuses a destination finality timestamp
  // older than the real `graphNow()`-based request-creation time it independently records
  // (`HELD_RELAY_LATE`), so a receipt-block timestamp frozen in the past would eventually (and did,
  // once this scenario started exercising return for real) drift behind the actual clock.
  // One single, strictly monotonic chain of real, uniquely hashed EVM heights -- never a separate
  // "finalized head" number line disconnected from the actual heights real transactions land in.
  // Each newly accepted real transaction's own inclusion height genuinely BECOMES the new finalized
  // head once it lands (`currentEvmFinalizedBlock`, below): initially height 100 (nothing yet
  // known); once pack 0's real return proceeds are actually broadcast and observed
  // (`returnProceedsAtomic`), the finalized head advances to height 101 -- return's own real
  // inclusion block; once direct payout's own real transfer is also broadcast and observed
  // (`payoutTransferAmount`), the finalized head advances again to height 102 -- payout's own real
  // inclusion block, chained to height 101 as its genuine parent (`parentHash`). No height is ever
  // reused for two different real events, no hash is ever reused for two different heights, and no
  // already-observed height's own historical account balance ever changes on a later re-query --
  // asserted explicitly below. Claim-process is the first real EVM mutation this scenario ever
  // broadcasts, chronologically well before return is even quoted -- its own receipt lands at a
  // distinct, strictly-earlier height, outside this advancing sequence entirely.
  const graphTimestamp = BigInt(Math.floor(graphNow() / 1000));
  const EVM_CLAIM_RECEIPT_BLOCK = Object.freeze({ number: 10n, hash: `0x${'9'.repeat(64)}`, timestamp: graphTimestamp });
  const EVM_BLOCK_INITIAL = Object.freeze({ number: 1n, hash: `0x${'e'.repeat(64)}`, timestamp: graphTimestamp - 1n });
  const EVM_BLOCK_AFTER_RETURN = Object.freeze({
    number: 101n, hash: `0x${'d'.repeat(64)}`, timestamp: graphTimestamp + 1n, parentHash: EVM_CLAIM_RECEIPT_BLOCK.hash,
  });
  const EVM_BLOCK_AFTER_PAYOUT = Object.freeze({
    number: 102n, hash: `0x${'c'.repeat(64)}`, timestamp: graphTimestamp + 2n, parentHash: EVM_BLOCK_AFTER_RETURN.hash,
  });
  // The later supplementary held-card sale's own real return/payout inclusion heights, continuing
  // this exact same one monotonic chain -- reachable only once the main cycle's own return/payout
  // have already landed, chained accordingly.
  const EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN = Object.freeze({
    number: 103n, hash: `0x${'a'.repeat(64)}`, timestamp: graphTimestamp + 3n, parentHash: EVM_BLOCK_AFTER_PAYOUT.hash,
  });
  const EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT = Object.freeze({
    number: 104n, hash: `0x${'f'.repeat(64)}`, timestamp: graphTimestamp + 4n, parentHash: EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN.hash,
  });
  const HOOK_PROCESS_LIABILITY_ATOMIC = 10_000_000n;
  const EVM_NATIVE_BALANCE_ATOMIC = 10_000_000_000_000n;
  let evmNonce = 0n;
  const evmBroadcasts = new Map();

  // Each real broadcast EVM transaction lands in its own real, chronologically distinct block --
  // never two different real transactions sharing one block, and never one height standing in for
  // two different real events.
  function evmClaimReceiptDetails(rawTransaction) {
    const parsed = parseTransaction(rawTransaction);
    if (parsed.data === undefined || parsed.data === '0x') {
      const amount = parsed.value ?? 0n;
      assert.ok(amount > 0n, 'native payout carries a positive signed value');
      if (payoutTransferAmount === null) {
        payoutTransferAmount = amount;
        payoutRecipientAddress = parsed.to;
        return { receiptBlock: EVM_BLOCK_AFTER_PAYOUT, logs: [] };
      }
      supplementaryPayoutTransferAmount = amount;
      supplementaryPayoutRecipientAddress = parsed.to;
      return { receiptBlock: EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT, logs: [] };
    }
    const call = decodeFunctionData({ abi: N2_HOOK_EVENT_ABI, data: parsed.data });
    assert.equal(call.functionName, 'claimProcess');
    const [claimCycleId, amountWei, destination] = call.args;
    return { receiptBlock: EVM_CLAIM_RECEIPT_BLOCK, logs: [{
      address: COMPOSED_HOOK_ADDRESS,
      topics: encodeEventTopics({ abi: N2_HOOK_EVENT_ABI, eventName: 'ProcessClaimed', args: { cycleId: claimCycleId, destination } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [amountWei, 1n, amountWei, amountWei]),
    }] };
  }

  // The one append-only, real, chronologically ordered ledger of every EVM balance-changing event
  // this scenario's own accepted transactions actually produce -- computed lazily from the same
  // atomic flags each real signed/broadcast transaction sets, never imperatively mutated elsewhere.
  // Each entry's own block is one of the fixed heights above; querying any block for any account
  // therefore always reduces to summing exactly the entries at or before that real height, which
  // can never change once an entry's own triggering transaction has actually landed.
  function evmBalanceLedger() {
    const events = [];
    for (const sent of evmBroadcasts.values()) {
      let principal = 0n;
      if (sent.parsed.to?.toLowerCase() === COMPOSED_HOOK_ADDRESS.toLowerCase()) {
        principal = decodeFunctionData({ abi: N2_HOOK_EVENT_ABI, data: sent.parsed.data }).args[1];
      }
      events.push({ block: sent.receiptBlock, operationsDelta: principal - 21000n, recipient: null, recipientDelta: 0n });
    }
    if (returnProceedsAtomic !== null) {
      events.push({ block: EVM_BLOCK_AFTER_RETURN, operationsDelta: quotedNativeReturnWei(returnProceedsAtomic), recipient: null, recipientDelta: 0n });
    }
    if (payoutTransferAmount !== null) {
      events.push({
        block: EVM_BLOCK_AFTER_PAYOUT, operationsDelta: -payoutTransferAmount,
        recipient: payoutRecipientAddress, recipientDelta: payoutTransferAmount,
      });
    }
    if (supplementaryReturnProceedsAtomic !== null) {
      events.push({
        block: EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN, operationsDelta: quotedNativeReturnWei(supplementaryReturnProceedsAtomic),
        recipient: null, recipientDelta: 0n,
      });
    }
    if (supplementaryPayoutTransferAmount !== null) {
      events.push({
        block: EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT, operationsDelta: -supplementaryPayoutTransferAmount,
        recipient: supplementaryPayoutRecipientAddress, recipientDelta: supplementaryPayoutTransferAmount,
      });
    }
    return events.sort((left, right) => Number(left.block.number - right.block.number));
  }

  // The finalized head genuinely IS the real inclusion height of the latest real accepted
  // transaction this fixture knows about -- never a separate number line, never the same
  // already-observed height/hash pair silently reinterpreted once a later transaction is accepted.
  // `cycle-repository.mjs`'s own durable custody-observation write correctly refuses either a
  // reused hash across two heights or two different balances at one same height/hash as internally
  // contradictory evidence; this function, and `readErc20BalanceAtBlock` below, are built so
  // neither can ever happen, asserted explicitly after the tick.
  function currentEvmFinalizedBlock() {
    const events = evmBalanceLedger();
    return events.length === 0 ? EVM_BLOCK_INITIAL : events[events.length - 1].block;
  }

  // Relay's own solver executes the destination-side USDG credit on the EVM chain -- a foreign
  // chain event this process never signs, so it cannot be derived from bytes this fixture receives
  // (exactly `outboundDestinationTransaction`'s own documented rationale, chain-reversed). Computed
  // lazily so the credited amount is always exactly `returnProceedsAtomic` -- the real amount
  // `signerClient.solana.broadcast` decoded from pack 0's own actually-signed and accepted return
  // transaction, never a value inserted independently of it. Lands in its own real, distinct block
  // (`EVM_BLOCK_AFTER_RETURN`), never shared with payout's own later transfer.
  function relayReturnDestinationEntry() {
    if (returnProceedsAtomic === null) return null;
    return {
      hash: RELAY_RETURN_DESTINATION_TX_HASH,
      sender: RELAY_RETURN_SOLVER_EVM,
      parsed: { to: RELAY_RETURN_SOLVER_EVM, data: '0x', value: 0n, nonce: 0, gas: 21_000n, chainId: 4663, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      receiptBlock: EVM_BLOCK_AFTER_RETURN,
      logs: [{
        address: RELAY_RETURN_SOLVER_EVM,
        topics: encodeEventTopics({ abi: parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']), eventName: 'FundsMovement' }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
          [RELAY_RETURN_SOLVER_EVM, OPERATIONS_EVM_SIGNING_ADDRESS, `0x${'00'.repeat(20)}`, quotedNativeReturnWei(returnProceedsAtomic), RELAY_RETURN_ORDER_ID]),
      }],
    };
  }

  // The later supplementary held-card sale's own destination-side USDG credit -- identical
  // reasoning to `relayReturnDestinationEntry` above, entirely separate transaction hash, entirely
  // separate real block (`EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN`), credited from
  // `supplementaryReturnProceedsAtomic` only, never the main leg's own amount.
  function supplementaryRelayReturnDestinationEntry() {
    if (supplementaryReturnProceedsAtomic === null) return null;
    return {
      hash: RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH,
      sender: RELAY_RETURN_SOLVER_EVM,
      parsed: { to: RELAY_RETURN_SOLVER_EVM, data: '0x', value: 0n, nonce: 0, gas: 21_000n, chainId: 4663, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      receiptBlock: EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN,
      logs: [{
        address: RELAY_RETURN_SOLVER_EVM,
        topics: encodeEventTopics({ abi: parseAbi(['event FundsMovement(address from, address to, address currency, uint256 amount, bytes metadata)']), eventName: 'FundsMovement' }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
          [RELAY_RETURN_SOLVER_EVM, OPERATIONS_EVM_SIGNING_ADDRESS, `0x${'00'.repeat(20)}`, quotedNativeReturnWei(supplementaryReturnProceedsAtomic), RELAY_SUPPLEMENTARY_RETURN_ORDER_ID]),
      }],
    };
  }

  // Both real foreign-solver-executed destination credits (main and supplementary) are looked up
  // by their own, entirely distinct transaction hash -- never one hash standing in for the other.
  function evmForeignDestinationEntry(hash) {
    const lower = hash.toLowerCase();
    if (lower === RELAY_RETURN_DESTINATION_TX_HASH.toLowerCase()) return relayReturnDestinationEntry();
    if (lower === RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH.toLowerCase()) return supplementaryRelayReturnDestinationEntry();
    return null;
  }

  const robinhoodStub = {
    async getChainId() { return 4663; },
    async getCode() { return '0x6000'; },
    async readContract({ functionName } = {}) {
      // `isFrozen` is direct payout's own real pre-admission USDG freeze check
      // (`isRecipientFrozen`, payout.mjs) -- a real recipient, never frozen in this scenario.
      // Every other caller (the start-preflight mainnet chain-id/requirements canary) keeps the
      // existing generic shape; it never inspects `functionName`/`args` itself.
      if (functionName === 'isFrozen') return false;
      return { requirementsRevision: 0n, chainId: 4663n };
    },
    async getBlock({ blockTag, blockNumber } = {}) {
      if (blockTag === 'finalized') return { ...currentEvmFinalizedBlock() };
      if (blockNumber === EVM_CLAIM_RECEIPT_BLOCK.number) return { ...EVM_CLAIM_RECEIPT_BLOCK };
      if (blockNumber === EVM_BLOCK_INITIAL.number) return { ...EVM_BLOCK_INITIAL };
      // Each later height is only ever answerable once its own real transaction has actually been
      // accepted -- never a guess at a not-yet-mined block's eventual contents.
      const known = evmBalanceLedger().find(event => event.block.number === blockNumber);
      if (known) return { ...known.block };
      throw new Error(`N=2 composed scenario: unexpected or not-yet-mined EVM block request ${JSON.stringify({ blockTag, blockNumber })}`);
    },
    async getTransactionCount() { return evmNonce; },
    async estimateGas() { return 60_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
    async getBalance({ address, blockNumber } = {}) {
      return (await historicalEvidenceStub.readNativeBalanceAtBlock({ account: address, blockNumber: blockNumber ?? currentEvmFinalizedBlock().number, blockHash: currentEvmFinalizedBlock().hash })).value;
    },
    async sendRawTransaction({ serializedTransaction }) {
      const hash = keccak256(serializedTransaction);
      const parsed = parseTransaction(serializedTransaction);
      const sender = await recoverTransactionAddress({ serializedTransaction });
      const { logs, receiptBlock } = evmClaimReceiptDetails(serializedTransaction);
      evmBroadcasts.set(hash.toLowerCase(), {
        hash, raw: serializedTransaction, parsed, sender, logs, receiptBlock,
      });
      evmNonce += 1n;
      return hash;
    },
    async getTransaction({ hash }) {
      const sent = evmForeignDestinationEntry(hash) ?? evmBroadcasts.get(hash.toLowerCase());
      if (!sent) return null;
      return {
        hash: sent.hash, from: sent.sender, to: sent.parsed.to, input: sent.parsed.data, data: sent.parsed.data,
        blockNumber: sent.receiptBlock.number, blockHash: sent.receiptBlock.hash, value: sent.parsed.value ?? 0n, nonce: sent.parsed.nonce, gas: sent.parsed.gas, chainId: sent.parsed.chainId,
        maxFeePerGas: sent.parsed.maxFeePerGas, maxPriorityFeePerGas: sent.parsed.maxPriorityFeePerGas,
      };
    },
    async getTransactionReceipt({ hash }) {
      const sent = evmForeignDestinationEntry(hash) ?? evmBroadcasts.get(hash.toLowerCase());
      // Real viem clients throw this exact error (never return `null`) when a receipt genuinely
      // does not exist yet -- direct payout's own `reconcileRecipientAttempt` (payout.mjs) checks
      // for it by `instanceof` specifically, to tell "not yet broadcast/mined" apart from a
      // malformed response.
      if (!sent) throw new TransactionReceiptNotFoundError({ hash });
      // Each transaction's own real receipt names the real, distinct block it actually landed in
      // (`sent.receiptBlock`) -- never one shared block standing in for two different transactions.
      return {
        transactionHash: sent.hash, blockNumber: sent.receiptBlock.number, blockHash: sent.receiptBlock.hash,
        status: 'success', gasUsed: 21000n, effectiveGasPrice: 1n, from: sent.sender, to: sent.parsed.to,
        logs: sent.logs.map((log, index) => ({ ...log, logIndex: index, transactionHash: sent.hash, blockHash: sent.receiptBlock.hash, blockNumber: sent.receiptBlock.number })),
      };
    },
  };
  const historicalEvidenceStub = {
    async readNativeBalanceAtBlock({ account, blockNumber, blockHash }) {
      const isOperations = account?.toLowerCase() === OPERATIONS_EVM_SIGNING_ADDRESS.toLowerCase();
      let value = isOperations ? EVM_NATIVE_BALANCE_ATOMIC : 0n;
      for (const event of evmBalanceLedger()) {
        if (event.block.number > blockNumber) continue;
        if (isOperations) value += event.operationsDelta;
        else if (event.recipient?.toLowerCase() === account?.toLowerCase()) value += event.recipientDelta;
      }
      return { value, blockNumber, blockHash };
    },
    async readHookProcessStateAtBlock({ blockNumber, blockHash }) {
      return {
        processLiability: HOOK_PROCESS_LIABILITY_ATOMIC,
        remainingProcessClaimCapacity: HOOK_PROCESS_LIABILITY_ATOMIC,
        processClaimsPaused: false,
        processClaimCycleUsed: false,
        isSolvent: true,
        operations: OPERATIONS_EVM_SIGNING_ADDRESS,
        blockNumber, blockHash,
      };
    },
    // The real finalized Operations USDG balance, tied to the same real accepted return
    // transaction throughout: `0n` before pack 0's return proceeds are actually broadcast and
    // observed (`returnProceedsAtomic`, set only by `signerClient.solana.broadcast` above, from the
    // real signed bytes), and exactly that same real amount once they are -- both return's own
    // informational custody-expectation write (reached before the return transaction is even
    // signed, so still `0n` there, and never gated on this value) and payout-availability.mjs's own
    // real minimum-balance admission check (reached only after return has fully settled) observe
    // this one consistent, honestly-derived value; never a value inserted independently of the
    // accepted transaction that actually produced it.
    // Direct payout's own `readFinalizedErc20TransferProof` also calls this per real
    // `{token, account, blockNumber, blockHash}` request pair (`readHistoricalTransferBalances`,
    // robinhood-rpc.mjs) to independently re-derive BOTH the Operations source debit and the real
    // recipient's credit, at both the block right before payout's own transfer (which already,
    // truthfully, contains the prior finalized return) and the receipt block payout's own transfer
    // actually landed in -- never a single flat value. The later supplementary held-card sale's own
    // return/payout reach this exact same function, unmodified, for the exact same reason.
    //
    // Every balance below is an immutable function of the account and the real historical block
    // height alone, computed purely by summing `evmBalanceLedger()`'s own fixed, strictly-ordered
    // entries at or before the queried height -- never a "has this fixture's own mutable state been
    // set by now" wall-clock check. A query for a given account/height therefore always returns the
    // one true historical value that height actually had, unconditionally, however many times or
    // whenever it is asked: an earlier height can never include a later entry's own delta, no
    // matter when it is queried. Each ledger entry is derived exactly once, from the real accepted
    // transaction that produced it, and never reset -- modeling one real chain's forward-only
    // history, never a retroactive rewrite of an earlier height once a later one becomes known.
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const lowerAccount = account?.toLowerCase();
      const isOperations = lowerAccount === OPERATIONS_EVM_SIGNING_ADDRESS.toLowerCase();
      let value = 0n;
      for (const event of evmBalanceLedger()) {
        if (event.block.number > blockNumber) continue;
        if (isOperations) value += event.operationsDelta;
        else if (event.recipient !== null && lowerAccount === event.recipient.toLowerCase()) value += event.recipientDelta;
      }
      return { value, blockNumber, blockHash };
    },
  };
  // The real `createRelayClient` (relay-client.mjs), faking only its own HTTP transport -- exactly
  // the same convention as `solanaClient`/`robinhoodStub` above, never a hand-built replacement for
  // the real quote-parsing/intent-validation/status-authentication logic that module owns. Outbound
  // never reaches this at all (`assertOutboundConfiguration` refuses first, asserted above), so only
  // the RETURN-direction endpoints this scenario's own real `return.mjs` actually calls are wired:
  // `/chains` (route-enabled check), `/quote/v2` (echoes back exactly the amount return.mjs itself
  // computed from pack 0's own durable buyback-proceeds custody row, never a value this fixture
  // invents), and `/intents/status/v3` (the terminal destination pointer).
  // The main cycle's own return leg is always quoted first, chronologically; the later
  // supplementary held-card sale's own return leg is only ever quoted afterward -- a real,
  // structural ordering this scenario's own sequence guarantees (the supplementary sale cannot
  // even begin until the main cycle's own eligibility snapshot has already completed), never a
  // fragile raw call count standing in for unrelated retry behavior within one single leg.
  let relayReturnQuoteCallCount = 0;
  const relayReturnDestinationTxHashByRequestId = new Map([
    [RELAY_RETURN_REQUEST_ID, RELAY_RETURN_DESTINATION_TX_HASH],
    [RELAY_SUPPLEMENTARY_RETURN_REQUEST_ID, RELAY_SUPPLEMENTARY_RETURN_DESTINATION_TX_HASH],
  ]);
  const relayFetchImpl = async (url, init) => {
    const path = url.pathname;
    if (path === '/chains') {
      return { ok: true, status: 200, text: async () => JSON.stringify(RELAY_CHAINS) };
    }
    if (path === '/quote/v2') {
      const body = JSON.parse(init.body);
      if (body.originChainId === 4663) {
        const raw = composedRawRelayQuote({ requestId: `valuation-${body.amount}`, orderId: `0x${'a'.repeat(64)}`,
          originAmount: body.amount, destinationAmount: '1', sender: body.user, recipient: body.recipient });
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
    hook: { address: COMPOSED_HOOK_ADDRESS, runtimeHash: keccak256('0x6000') }, relay: { ...runtimeFixture.route, sourceInstruction: capturedSourceInstruction, emitter: RELAY_RETURN_SOLVER_EVM } }, createTestProfileMutationAuthority());
  const config = {
    now: graphNow,
    nativePaymentBinding,
    stateDir,
    statePath,
    workerOwner: 'n2-composed-worker',
    leaseTtlMs: 30_000,
    chainId: 4663,
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', dryRun: false, enforceProfile: true },
    accounts: { evm: OPERATIONS_EVM_SIGNING_ADDRESS, solana: operator.publicKey.toBase58() },
    pack: { code: N2_GRAPH_PACK_CODE },
    // Generous enough that the fixed, far-future destination-finality timestamp below
    // (`EVM_BLOCK_AFTER_RETURN`) always falls inside [requestCreatedAt, requestCreatedAt + this window],
    // regardless of the real wall-clock time this scenario happens to run at -- this scenario does
    // not exercise the settlement-window boundary itself, only that a real, non-fabricated window
    // check runs and passes.
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '999999999' },
    solana: {
      chainId: NATIVE_SOLANA_CHAIN_ID,
      blockhashContextResolver: async blockhash => ({
        blockhash, lastValidBlockHeight: String(blockhashHeights.get(blockhash) ?? HEIGHT_PACK_1),
      }),
    },
    collectorCrypt: {
      settlementAsset: { chainId: NATIVE_SOLANA_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 },
      purchase: { testFixtureBinding: fixtureBinding },
      epicGate: {
        nftAddressField: 'nft_address', insuredValueField: 'insured_value', prizeTierField: 'prize_tier', rarityField: 'rarity',
        asset: { ...EPIC_GATE_SETTLEMENT_ASSET },
      },
      buyback: { collectorProgramId: COLLECTOR_BUYBACK_PROGRAM_ID, collectorRecipient: COLLECTOR_BUYBACK_RECIPIENT, policy: { policy: buybackPolicy, rules: readTransactionPolicyRules(buybackPolicy) } },
    },
    budget: {
      availableProcessUsdg: AGGREGATE_FUNDING_ATOMIC.toString(),
      packPriceUsdg: UNIT_FUNDING_ATOMIC.toString(),
      outboundCapUsdg: '0',
      returnCapUsdg: '0',
      operatingMarginUsdg: '0',
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
      evm: { nativeReserve: { ...RELAY_FUNDING_ROUTE, amountAtomic: '2' } },
      solana: { priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '10000' },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' } },
    }),
    signerClient,
    preflightAuthority: createTestProfileMutationAuthority(),
    networkIdentity: {
      readEvmChainId: async () => 4663,
      readSolanaGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    },
    // The real live-service start preflight (compose.mjs's requireStartPreflight, invoked on every
    // `service.runOnce({liveMode:true})`) requires a configured observability canary/alert
    // surface. Reuses this same file's own `observability()` fixture builder (already used by the
    // literal-CLI test above), narrowed to the one signer role this composed scenario actually
    // configures.
    observability: {
      ...observability('https://n2-composed.invalid', directory, OPERATIONS_EVM_SIGNING_ADDRESS),
      startPreflight: { requiredSignerRoles: ['solana', 'evm'], requireEvmRpc: true, requireSolanaRpc: true },
    },
    observabilityDeps: {
      fetchImpl: async () => ({ ok: true, status: 204 }),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
    adapters: {
      robinhood: { client: robinhoodStub, historicalEvidenceClient: historicalEvidenceStub },
      solana: { client: solanaClient },
      relay: relayStub,
      collectorCrypt,
    },
    // stage-driver.mjs's own `reconcile()` deliberately reads purchase's post-mutate provider
    // status through this separate bundle, never the live-mutate `adapters` above, for any profile
    // other than the live collector-only rehearsal -- reconciliation must stay independently
    // sourced from mutation even when, as here, both happen to be the same reviewed fixture
    // transport. `chainJournal` stages (claim-process, outbound, return) route through this exact
    // same `reconciliationAdapters ?? adapters` fallback (stage-driver.mjs's own
    // `chainReconciliationInput`) -- a truthy `reconciliationAdapters` here replaces `adapters`
    // wholesale, not merges with it, so `robinhood`/`relay` must be repeated here too or
    // claim-process's/return's own real reconcile silently reads them as `undefined` and returns
    // `null` before ever touching the fixture, indistinguishable from a genuinely unresolved
    // mutation.
    reconciliationAdapters: {
      collectorCrypt, solana: { client: solanaClient }, relay: relayStub,
      robinhood: { client: robinhoodStub, historicalEvidenceClient: historicalEvidenceStub },
    },
  };

  // Real claim-process tick, its own composition/process lifetime: `AutomatedCycleService`'s own
  // `#run` loop is what calls `policyEngine.admit({boundary:'claim-process', ...})`
  // (automated-cycle-service.mjs:576) right before it durably prepares and mutates the claim-process
  // stage for real -- this is the one true live-tick reservation path; this scenario no longer needs
  // its own out-of-band pre-admit call now that claim-process actually runs (a prior revision of
  // this file called `composition.policyEngine.admit(...)` directly here, only because claim-process
  // was pre-seeded and that internal call never fired). Real EIP-1559 `claimProcess` call
  // construction, gas quoting, the hook-liability pre-sign veto, EVM signing
  // (`operationsEvmAccount` above), raw broadcast, and finalized-receipt reconciliation all happen
  // inside this one tick, through the real `mutateClaimProcess`/`reconcileLiveClaimProcess`
  // (claim-process.mjs) the real `stage-driver` invokes -- nothing here injects a shortcut or
  // pre-completes this stage.
  const claimComposition = await compose(config);
  let claimTickError = null;
  try {
    await claimComposition.service.runOnce({ liveMode: true });
  } catch (error) {
    claimTickError = error;
  } finally {
    await claimComposition.shutdown();
  }
  const claimRepository = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  const claimCycleAfterFirstTick = await claimRepository.describeCycle(cycleId);
  const claimStageAfterFirstTick = claimCycleAfterFirstTick.stages.get('claim-process') ?? null;
  assert.equal(
    claimStageAfterFirstTick?.status, 'COMPLETE',
    `claim-process must durably complete for real in its own tick, real EVM signature and all; claimTickError=${claimTickError ? claimTickError.stack : 'null'}; stages=${JSON.stringify([...claimCycleAfterFirstTick.stages.entries()].map(([s, r]) => [s, r.status]))}`,
  );
  // This same tick then advances straight into `outbound`, the next stage in pipeline order --
  // still an unowned precondition this task never drives for real (see
  // `completeN2OutboundPrecondition`'s own comment). It refuses even earlier than the
  // deliberately-unreachable `relayStub`: `prepareOutboundRequest`'s own `assertOutboundConfiguration`
  // (outbound.mjs:118) refuses first, before any provider adapter is ever touched, on this
  // composed config's missing Relay EVM depository allowlist address -- a real config-validation
  // fail-fast, not a fixture-reachability refusal. Never seeded around: this config deliberately
  // configures no such address, since this task never drives outbound for real.
  assert.match(
    claimTickError?.message ?? '',
    /outbound requires a configured Relay EVM depository allowlist address/,
    `the same tick that finalizes claim-process for real must advance immediately into the unowned outbound precondition and refuse there, never earlier and never silently; claimTickError=${claimTickError ? claimTickError.stack : 'null'}`,
  );
  await completeN2OutboundPrecondition(claimRepository, cycleId);

  // Fresh composition, fresh `CycleRepository.open()` -- `DurableCycleStore` caches a cycle's state
  // in memory per open handle, so a still-live `composition` from the claim tick above would never
  // observe the outbound precondition just written through `claimRepository`, a separate handle.
  // This is a fresh in-process `compose()`/repository handle within this same Node process, proving
  // durable state survives a fresh handle open -- not a real cross-process CLI restart, which
  // remains the separately required literal-CLI proof this checkpoint does not substitute for.
  const composition = await compose(config);
  t.after(() => composition.shutdown());

  let tickError = null;
  try {
    await composition.service.runOnce({ liveMode: true });
  } catch (error) {
    tickError = error;
  }

  // Reopened fresh, like the literal-CLI test's own read-back above: durable state is read through
  // a new repository handle rather than the pre-run `setupRepository`, since compose() itself
  // opened and wrote through its own separate durable-store connection.
  const repository = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  const cycle = await repository.describeCycle(cycleId);

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

  // Exact composed N=2 graph frontier, empirically observed (2026-09-07) through the real
  // compose()/AutomatedCycleService/stage-driver path. Every custody-safety/identity gap this file
  // previously reported here is now resolved by separately owned, independently reviewed fixes
  // (buyback-only facade custody write, `c86af352`; canonical EVM held-position custody identity
  // and payout's reconcile-before-mutate custody-check bypass, `a534afba`; the buyback-vs-return
  // Solana chain-id identity split, `6fdd088c`; return's own payout-facing evidence projection
  // from a settled leg, `994ca12c`; payout-availability.mjs's raw-vs-canonical custody-row lookup,
  // `1c4df906`): claim-process (its own tick above), outbound (precondition), purchase, open,
  // epic-gate, buyback, return, AND payout all durably complete for real in this one tick, and the
  // cycle itself reaches full terminal `COMPLETED` closure.
  //
  // Pack 0 (prize tier 4/common, so the below-40%-insured threshold reserved for tier 1/epic never
  // applies) reconciles to a genuine `sell` decision, generates a real Collector buyback transaction
  // bound to independently pinned program/recipient literals, and is really policy-evaluated,
  // signed, and broadcast. Pack 1 follows the documented `buyback is unavailable` held path
  // (`HELD_UNAVAILABLE`/`BUYBACK_UNAVAILABLE`), never a distorted or invented below-40%
  // construction. `buyback`'s own `reconcileLiveBuyback` durably records pack 0's realized Solana
  // settlement-asset proceeds (`custodyLedgers` row keyed `solana-mainnet\0<mint>`,
  // `buybackProceeds: "90"`), and its operational attempt advances all the way to `RECONCILED`.
  //
  // `return` bridges those 90 units for real: `prepareReturnRequest`'s own native-identity lookup
  // (return.mjs) finds pack 0's real Solana proceeds row, quotes a real RETURN-direction Relay
  // bridge through the real `createRelayClient` (relay-client.mjs, faking only its own HTTP
  // transport, exactly like `solanaClient`/`robinhoodStub`), builds and signs one real SPL
  // `TransferChecked` instruction moving exactly those 90 units to a pinned Relay depository, and
  // broadcasts it through `wrapTransactionPolicySignerClient`'s real `sign()`/`broadcast()` path.
  // `reconcileLiveReturn` then independently re-derives the exact same 90-unit source debit
  // (`readFinalizedRelaySourceDebit`, from `solanaClient`'s own `getTransaction` response, decoded
  // only from the bytes `signerClient.solana.broadcast` actually signed -- never a value this file
  // inserts independently of that accepted transaction), authenticates Relay's own terminal
  // destination pointer, and independently re-verifies the destination-side USDG credit (a real
  // ERC20 Transfer log to Operations EVM, the same "foreign chain event this process never signs"
  // convention `outboundDestinationTransaction` above already documents, chain-reversed) before
  // settling the leg. `return.mjs` then projects a payout-facing evidence shape from the settled
  // leg (`finalized: true`, `destinationAccount`, `destinationAsset`,
  // `destinationCreditAmount: leg.netDeltaAtomic` -- never the quoted `destinationAmountAtomic`),
  // so `payout.mjs`'s own `normalizedReturnDelta` accepts it and computes a real positive
  // `finalizedReturn` of 90 units.
  //
  // Direct payout's own real pre-admission checks (`isRecipientFrozen`, bridge/gas admission,
  // `assertDirectPayoutMoneyConfiguration`'s feasibility-envelope cross-check) all pass against
  // this genuinely payable plan. With `1c4df906` landed, `payout-availability.mjs`'s own
  // `reloadFinalizedReturnAmount` now locates the settled leg's custody-ledger row via the same
  // canonical CAIP identity claim-process/return/payout's own precondition check already agree on
  // (`eip155:4663`/`eip155:4663/erc20:<usdg>`), rather than the leg's raw destination fields, and
  // finds the real 90-unit `returnReceived` row. Payout then signs and broadcasts one real legacy
  // ERC20 `transfer` from Operations to the one eligible holder (`directTransferCalldata`,
  // `buildTransaction`, payout.mjs) through the same guarded `wrapTransactionPolicySignerClient`
  // convention return already exercises for its own signer. `reconcileRecipientAttempt` then
  // independently re-derives the exact finalized transfer
  // (`readFinalizedErc20TransferProof`, robinhood-rpc.mjs) from: the transfer's own Transfer log
  // (decoded only from the bytes payout actually signed and broadcast, never invented), a genuine
  // canonical-block/parent-hash chain proof, and a historical source/recipient balance-delta
  // cross-check (Operations debits exactly 90, the recipient credits exactly 90) -- all modeled in
  // this fixture strictly from that one real accepted transaction, never seeded or hardcoded
  // independently of it. The recipient's payout attempt reaches `FINALIZED`, the cycle's own
  // `assertCycleClosure` accepts the fully reconciled graph, and the cycle durably closes
  // `COMPLETED` -- the first real, finalized, positive recipient payment this graph has ever
  // reached end to end through the real production handlers.
  assert.equal(tickError, null, `the tick must complete with no error: a real positive settled return, a real payout admission, and a real finalized recipient payment now reach full cycle closure; ${diagnostics()}`);
  for (const stage of ['eligibility-snapshot', 'claim-process', 'outbound', 'purchase', 'open', 'epic-gate', 'buyback', 'return', 'payout']) {
    assert.equal(cycle.stages.get(stage)?.status, 'COMPLETE', `stage ${stage} must durably complete; ${diagnostics()}`);
  }
  assert.equal(cycle.terminalState, 'COMPLETED', `the cycle must reach full terminal closure now that every required stage, including payout, has genuinely completed; ${diagnostics()}`);

  const payoutEvidence = cycle.stages.get('payout').evidence;
  assert.equal(payoutEvidence.schema, 'hookemon.direct-payout-result.v2', `payout must finalize with its own real result evidence shape; ${diagnostics()}`);
  assert.equal(payoutEvidence.distributablePool.amountAtomic, '9090', `the distributable pool must equal exactly the return's real 9090-wei finalized credit; ${diagnostics()}`);
  assert.equal(payoutEvidence.distributablePool.assetId?.toLowerCase(), 'native', `the distributable pool must be denominated in ETH; ${diagnostics()}`);
  assert.equal(payoutEvidence.dust.amountAtomic, '0', `no dust may be retained when the one eligible holder's exact share consumes the whole pool; ${diagnostics()}`);
  assert.equal(payoutEvidence.totalAllocated.amountAtomic, '9090', `the total allocated amount must exactly conserve the distributable pool against the recorded dust (9090 = 9090 + 0); ${diagnostics()}`);
  assert.equal(payoutEvidence.quarantine.length, 0, `no recipient may be quarantined in this scenario; ${diagnostics()}`);
  assert.equal(payoutEvidence.recipients.length, 1, `exactly the one eligible holder must receive a payout attempt; ${diagnostics()}`);
  const [payoutRecipientEntry] = payoutEvidence.recipients;
  assert.equal(payoutRecipientEntry.recipient?.toLowerCase(), ELIGIBLE_HOLDER_ADDRESS.toLowerCase(), `the payout must credit exactly the one eligible holder, never a different or invented address; ${diagnostics()}`);
  assert.equal(payoutRecipientEntry.state, 'FINALIZED', `the recipient's own payout attempt must reach FINALIZED, a genuine finalized recipient payment; ${diagnostics()}`);
  assert.equal(payoutRecipientEntry.refusalEvidence, null, `a finalized recipient attempt must carry no refusal evidence; ${diagnostics()}`);
  assert.equal(payoutRecipientEntry.amount.amountAtomic, '9090', `the recipient must be credited exactly the real 90-unit return proceeds, never a partial or invented amount; ${diagnostics()}`);
  assert.equal(payoutRecipientEntry.amount.assetId?.toLowerCase(), 'native', `the recipient's credit must be denominated in ETH; ${diagnostics()}`);
  assert.equal(payoutRecipientEntry.amount.decimals, 18, `the recipient's credit must carry ETH's real decimals; ${diagnostics()}`);
  assert.equal(typeof payoutRecipientEntry.transactionHash, 'string', `a finalized payout attempt must record the real broadcast transaction hash; ${diagnostics()}`);
  const finalizedTransfer = payoutRecipientEntry.finalizedTransfer;
  assert.notEqual(finalizedTransfer, null, `a finalized payout attempt must carry its own independently re-derived finalized-transfer evidence; ${diagnostics()}`);
  assert.equal(finalizedTransfer.source?.toLowerCase(), OPERATIONS_EVM_SIGNING_ADDRESS.toLowerCase(), `the finalized transfer's own recovered sender must be the configured Operations EVM account; ${diagnostics()}`);
  assert.equal(finalizedTransfer.recipient?.toLowerCase(), ELIGIBLE_HOLDER_ADDRESS.toLowerCase(), `the finalized transfer's own recipient must be the one eligible holder; ${diagnostics()}`);
  assert.equal(finalizedTransfer.amountWei, '9090', `the finalized transfer's own re-derived amount must exactly equal the recipient's credited amount; ${diagnostics()}`);
  assert.equal(finalizedTransfer.gasSpentWei, '21000', 'the signed native payment accounts for gas separately');
  assert.equal(finalizedTransfer.calldataDigest, keccak256('0x'), 'the recipient payment carries no contract calldata');
  assert.equal(finalizedTransfer.blockHash, EVM_BLOCK_AFTER_PAYOUT.hash);
  assert.equal(finalizedTransfer.receiptStatus, 'success');

  // Explicit chronology and historic-stability proof: one single, strictly monotonic chain of real,
  // distinct, uniquely hashed EVM heights (claim outside the sequence; then initial, after-return,
  // after-payout in strict order), the finalized head genuinely advancing to each new height as its
  // real transaction is accepted, payout's own block genuinely chained to return's as parent -- so a
  // plausible-looking green transfer can never hide a retroactively rewritten or aliased history.
  const composedBlockHashes = [
    EVM_CLAIM_RECEIPT_BLOCK.hash, EVM_BLOCK_INITIAL.hash, EVM_BLOCK_AFTER_RETURN.hash, EVM_BLOCK_AFTER_PAYOUT.hash,
  ];
  assert.equal(new Set(composedBlockHashes).size, composedBlockHashes.length, `every distinct real EVM block height this scenario ever produces must carry its own distinct hash, never one hash reused across two heights; ${diagnostics()}`);
  assert.ok(EVM_BLOCK_INITIAL.number < EVM_CLAIM_RECEIPT_BLOCK.number, `claim-process's own receipt must land strictly before the scenario's initial finalized head; ${diagnostics()}`);
  assert.ok(EVM_BLOCK_INITIAL.number < EVM_BLOCK_AFTER_RETURN.number, `return's own inclusion height must land strictly after the initial finalized head; ${diagnostics()}`);
  assert.ok(EVM_BLOCK_AFTER_RETURN.number < EVM_BLOCK_AFTER_PAYOUT.number, `payout's own inclusion height must land strictly after return's; ${diagnostics()}`);
  assert.equal(EVM_BLOCK_AFTER_RETURN.parentHash, EVM_CLAIM_RECEIPT_BLOCK.hash, `return's own receipt block must chain to the initial finalized head as its real, direct parent; ${diagnostics()}`);
  assert.equal(EVM_BLOCK_AFTER_PAYOUT.parentHash, EVM_BLOCK_AFTER_RETURN.hash, `payout's own receipt block must chain to return's own receipt block as its real, direct parent; ${diagnostics()}`);
  // The finalized head genuinely IS the latest real accepted transaction's own inclusion height by
  // the time the tick completes -- never a fixed marker disconnected from what actually landed.
  const finalizedHeadAfterTick = currentEvmFinalizedBlock();
  assert.equal(finalizedHeadAfterTick.number, EVM_BLOCK_AFTER_PAYOUT.number, `the finalized head must have genuinely advanced all the way to payout's own real inclusion height by the end of the tick; ${diagnostics()}`);
  assert.equal(finalizedHeadAfterTick.hash, EVM_BLOCK_AFTER_PAYOUT.hash, `the finalized head's own hash must match payout's own real inclusion block, never a stale or reused hash; ${diagnostics()}`);

  // The durable custody ledger's own `verifiedCurrentBalance` is production's own real observation,
  // captured genuinely BEFORE payout ever ran (payout-availability's own pre-signing minimum-balance
  // check, reached only after return settled and only before payout signs) -- an immutable, durably
  // persisted "before" checkpoint this session never re-derives after the fact.
  const evmCustodyCanonicalKey = `4663${String.fromCharCode(0)}native`;
  const evmCustodyLedgerRow = cycle.custodyLedgers?.get?.(evmCustodyCanonicalKey) ?? null;
  assert.notEqual(evmCustodyLedgerRow, null, `the canonical EVM ETH custody row must be durable; ${diagnostics()}`);
  const expectedReturnBalance = EVM_NATIVE_BALANCE_ATOMIC + AGGREGATE_FUNDING_ATOMIC - 21000n + quotedNativeReturnWei(90n);
  const verifiedBeforePayout = evmCustodyLedgerRow.verifiedCurrentBalance;
  assert.equal(verifiedBeforePayout.balance.amountAtomic, expectedReturnBalance.toString(), `production's own durably recorded pre-payout observation of Operations' balance at return's own receipt height must show exactly the settled return credit; ${diagnostics()}`);
  assert.equal(verifiedBeforePayout.finality.height, EVM_BLOCK_AFTER_RETURN.number.toString(), `production's own pre-payout observation must be pinned to return's own real inclusion height; ${diagnostics()}`);
  assert.equal(verifiedBeforePayout.finality.hash, EVM_BLOCK_AFTER_RETURN.hash, `production's own pre-payout observation must be pinned to return's own real inclusion hash; ${diagnostics()}`);
  // Directly re-querying that exact same height/hash/account triple, fresh, now that payout has
  // already been broadcast, finalized, and durably recorded: it must report the exact same, stable,
  // byte-identical value production itself durably observed before payout ever ran -- proving this
  // fixture's own historical account state is never retroactively rewritten once a later real
  // transaction is accepted.
  const returnHeightOperationsBalanceAfterPayout = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: OPERATIONS_EVM_SIGNING_ADDRESS,
    blockNumber: EVM_BLOCK_AFTER_RETURN.number, blockHash: EVM_BLOCK_AFTER_RETURN.hash,
  });
  assert.equal(returnHeightOperationsBalanceAfterPayout.value, expectedReturnBalance, `Operations' own historical balance at return's own receipt height must remain byte-identical to production's own pre-payout observation (90), even when queried fresh after payout's own later transfer has since been accepted; ${diagnostics()}`);
  const returnHeightRecipientBalanceAfterPayout = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: ELIGIBLE_HOLDER_ADDRESS,
    blockNumber: EVM_BLOCK_AFTER_RETURN.number, blockHash: EVM_BLOCK_AFTER_RETURN.hash,
  });
  assert.equal(returnHeightRecipientBalanceAfterPayout.value, 0n, `the recipient's own historical balance at return's own receipt height must remain stable at exactly 0 -- payout had not yet happened at that real height, and querying it later can never change that; ${diagnostics()}`);
  // The scenario's own initial finalized head (before return was even known) sits strictly below
  // both later thresholds and so must remain stable at exactly 0 for Operations, forever, however
  // many later real transactions are accepted.
  const initialHeadOperationsBalanceAfterTick = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: OPERATIONS_EVM_SIGNING_ADDRESS,
    blockNumber: EVM_BLOCK_INITIAL.number, blockHash: EVM_BLOCK_INITIAL.hash,
  });
  assert.equal(initialHeadOperationsBalanceAfterTick.value, EVM_NATIVE_BALANCE_ATOMIC, `Operations' own historical balance at the scenario's initial finalized head must remain stable at exactly 0 after both return and payout have since been accepted; ${diagnostics()}`);
  assert.equal(
    purchaseAttempt?.attempt?.state, 'RECONCILED',
    `purchase's operational attempt must remain durably reconciled from the prior checkpoint; ${diagnostics()}`,
  );
  assert.equal(
    buybackAttempt?.attempt?.state, 'RECONCILED',
    `buyback's operational attempt must now be fully reconciled: pack 0 sold and durably reconciled, pack 1 durably held; ${diagnostics()}`,
  );

  const claimAttemptAfterMainTick = await repository.readOperationalStageAttempt(cycleId, 'claim-process');
  const claimCanonicalKey = `4663${String.fromCharCode(0)}native`;
  const claimCanonicalLedger = cycle.custodyLedgers?.get?.(claimCanonicalKey) ?? null;
  assert.notEqual(claimCanonicalLedger, null, `claim-process's canonical CAIP-keyed custody row must be durable; ${diagnostics()}`);
  assert.equal(claimCanonicalLedger.schema, 'hookemon.custody-ledger.v3', `the native ETH custody row must retain principal and gas in v3; ${diagnostics()}`);
  assert.equal(claimCanonicalLedger.claimed, AGGREGATE_FUNDING_ATOMIC.toString(), `claim-process must record exactly the aggregate cycle release as claimed; ${diagnostics()}`);
  assert.equal(claimCanonicalLedger.heldPositions, '0', `pack 1's held-liability value must be recorded under this exact same canonical row, not a competing raw one; ${diagnostics()}`);
  assert.equal(claimCanonicalLedger.returnReceived, '9090', `return must have bridged exactly pack 0's real 90-unit Solana proceeds back to this one canonical EVM ETH custody row; ${diagnostics()}`);
  assert.equal(claimAttemptAfterMainTick, null, `claim-process's own attempt shape (a chain-transaction attempt, not the generic operational-attempt state machine) is not what \`readOperationalStageAttempt\` reads -- always null for this stage, by design; ${diagnostics()}`);

  const returnEvidence = cycle.stages.get('return').evidence;
  assert.equal(returnEvidence.schema, 'hookemon.return-relay-settlement-evidence.v2', `return must finalize with its own real settled-leg evidence shape; ${diagnostics()}`);
  assert.equal(returnEvidence.finalized, true, `return's payout-facing projection must record itself as finalized; ${diagnostics()}`);
  assert.equal(returnEvidence.destinationAccount?.toLowerCase(), OPERATIONS_EVM_SIGNING_ADDRESS.toLowerCase(), `return's payout-facing projection must credit the configured Operations EVM account; ${diagnostics()}`);
  assert.equal(returnEvidence.destinationAsset?.toLowerCase(), 'native', `return's payout-facing projection must credit ETH; ${diagnostics()}`);
  assert.equal(returnEvidence.destinationCreditAmount, '9090', `return's payout-facing credit must equal the leg's own observed netDeltaAtomic (90), never the quoted destinationAmountAtomic; ${diagnostics()}`);
  assert.equal(returnEvidence.relayLeg.state, 'SETTLED', `the real Relay return leg must reach SETTLED; ${diagnostics()}`);
  assert.equal(returnEvidence.relayLeg.netDeltaAtomic, '9090', `the settled leg's own independently observed net delta must be exactly pack 0's real 90-unit proceeds; ${diagnostics()}`);
  assert.equal(returnEvidence.relayLeg.destinationAssetId?.toLowerCase(), 'native', `the settled leg must credit ETH; ${diagnostics()}`);
  assert.equal(returnEvidence.relayLeg.sourceAmountAtomic, '90', `the source remains 90 USDC atoms while the destination is the separately quoted 9090 wei; ${diagnostics()}`);
  const [[, settledReturnLeg]] = cycle.relayLegs instanceof Map ? [...cycle.relayLegs.entries()] : [];
  assert.equal(cycle.relayLegs.size, 1, `exactly one Relay leg (the real return bridge) may ever be recorded; ${diagnostics()}`);
  assert.equal(settledReturnLeg.direction, 'return', `the one recorded Relay leg must be the return leg; ${diagnostics()}`);
  assert.equal(settledReturnLeg.state, 'SETTLED', `the durably recorded return leg must be SETTLED, matching the stage evidence; ${diagnostics()}`);

  // Native MoneyV2 uses the same identity in Relay legs and the sole custody row.
  assert.equal(settledReturnLeg.destinationChainId, '4663');
  assert.equal(settledReturnLeg.destinationAssetId, 'native');
  const rawDestinationCustodyRow = [...cycle.custodyLedgers.values()].find(
    row => row?.chainId === settledReturnLeg.destinationChainId && row?.assetId === settledReturnLeg.destinationAssetId,
  ) ?? null;
  assert.equal(rawDestinationCustodyRow, evmCustodyLedgerRow, 'native return and payout share one principal/gas custody row');

  const epicGateEvidence = cycle.stages.get('epic-gate').evidence;
  const epicPack0 = epicGateEvidence.packs.find(entry => entry.memo === MEMO_PACK_0);
  assert.equal(epicPack0?.decision, 'sell', `pack 0 must reconcile to a real sell decision at epic-gate; ${diagnostics()}`);
  assert.equal(epicPack0.rarity, 'common', `pack 0's epic-gate decision must bind its documented prize-tier/rarity mapping; ${diagnostics()}`);
  const epicPack1 = epicGateEvidence.packs.find(entry => entry.memo === MEMO_PACK_1);
  assert.equal(epicPack1?.decision, 'held', `pack 1 must hold at epic-gate on the documented buyback-unavailable path; ${diagnostics()}`);
  assert.equal(epicPack1.terminalState, 'HELD_UNAVAILABLE', `pack 1 must hold as HELD_UNAVAILABLE, never a distorted below-40% construction; ${diagnostics()}`);
  assert.equal(epicPack1.reason, 'BUYBACK_UNAVAILABLE', `pack 1 must record the documented BUYBACK_UNAVAILABLE hold reason; ${diagnostics()}`);

  assert.equal(cycle.heldPositions.size, 1, `only pack 1 is a durable held position; pack 0 is mid-sale, never held; ${diagnostics()}`);
  const [heldPosition] = [...cycle.heldPositions.values()];
  assert.equal(heldPosition.memo, MEMO_PACK_1, `the one durable held position must name pack 1's own memo; ${diagnostics()}`);
  assert.equal(heldPosition.reason, 'BUYBACK_UNAVAILABLE', `the durable held position must record BUYBACK_UNAVAILABLE; ${diagnostics()}`);
  assert.equal(heldPosition.terminalState, 'HELD_UNAVAILABLE', `the durable held position must record HELD_UNAVAILABLE; ${diagnostics()}`);
  assert.equal(heldPosition.ownerDecision, null, `the durable held position must have no owner decision yet; ${diagnostics()}`);
  assert.equal(heldPosition.resolution, null, `the durable held position must be unresolved and durable; ${diagnostics()}`);

  assert.deepEqual(
    calls,
    { getMachines: 4, generateYoloPacks: 1, getPackStatus: 8, submitTransaction: 3, openPack: 2, getNfts: 3, getBuybackAvailable: 5, buyback: 1, getBuybackCheck: 1 },
    `the graph must reach exactly these real Collector provider calls for a complete two-pack cycle, no more, no fewer; ${diagnostics()}`,
  );
  assert.equal(signSpy.calls, 6, `exactly six real signer approvals (one EVM claim, two Solana purchase, one Solana buyback, one Solana return, one EVM direct payout), never a duplicate; ${diagnostics()}`);

  // Same-instance no-op recovery proof, second invocation against the same durable cycle (a second
  // call on this same still-running `composition`, in the same process -- not a restarted CLI
  // process, and not asserted as one). Every already-durably-complete stage's own
  // `readStage(...).status === 'COMPLETE'` check would short-circuit before ever reaching a handler
  // again -- no duplicate Collector mutation, no duplicate signer call, no duplicate Relay
  // quote/broadcast, no new custody write for any of them. Now that the cycle has genuinely reached
  // full terminal `COMPLETED` closure on the first tick, `AutomatedCycleService`'s own
  // `readActiveCycle()` no longer returns this cycle at all (a completed cycle is never "active").
  // A plain `runOnce()` call would therefore correctly try to admit and start the NEXT cycle
  // instead -- exactly real production behavior, but not what this no-op recovery check is for (no
  // duplicate effects against THIS SAME cycle), so this uses `recoverActiveCycle()`
  // (`requireActive: true`), the same real entry point a genuine crash-recovery restart would use:
  // with no active cycle left to recover, it reports `NO_ACTIVE_CYCLE` and touches nothing, rather
  // than throwing or duplicating any mutation. This proves same-instance no-op recovery only; it is
  // not a restarted process and must not be read as satisfying the separately required literal-CLI
  // process stop/restart proof.
  const mutationCallsAfterFirstTick = {
    generateYoloPacks: calls.generateYoloPacks, openPack: calls.openPack, buyback: calls.buyback, submitTransaction: calls.submitTransaction,
  };
  const secondTickResult = await composition.service.recoverActiveCycle({ liveMode: true });
  assert.equal(secondTickResult.status, 'NO_ACTIVE_CYCLE', `a restart recovery attempt against this same, already-fully-completed cycle must find no active cycle left to recover, never throw or re-attempt any stage; ${diagnostics()}`);
  assert.equal(secondTickResult.cycleId, null, `a restart recovery attempt with no active cycle must name no cycle; ${diagnostics()}`);
  assert.deepEqual(
    { generateYoloPacks: calls.generateYoloPacks, openPack: calls.openPack, buyback: calls.buyback, submitTransaction: calls.submitTransaction },
    mutationCallsAfterFirstTick,
    `a second tick must reach zero additional Collector mutation calls of any kind; ${diagnostics()}`,
  );
  assert.equal(signSpy.calls, 6, `a second tick must never reach the signer again; ${diagnostics()}`);
  const repositoryAfterSecondTick = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  const cycleAfterSecondTick = await repositoryAfterSecondTick.describeCycle(cycleId);
  const buybackAttemptAfterSecondTick = await repositoryAfterSecondTick.readOperationalStageAttempt(cycleId, 'buyback');
  assert.equal(
    buybackAttemptAfterSecondTick?.attempt?.state, 'RECONCILED',
    `buyback's operational attempt must remain exactly RECONCILED after a second tick and a fresh repository reopen; ${diagnostics()}`,
  );
  assert.equal(
    canonicalJson([...cycleAfterSecondTick.heldPositions.entries()]), canonicalJson([...cycle.heldPositions.entries()]),
    `the one durable held position must be byte-identical after a second tick and a fresh repository reopen -- immutable, never re-derived; ${diagnostics()}`,
  );
  assert.equal(cycleAfterSecondTick.terminalState, 'COMPLETED', `the cycle must remain durably COMPLETED after a second tick and a fresh repository reopen; ${diagnostics()}`);
  assert.equal(cycleAfterSecondTick.stages.get('payout')?.status, 'COMPLETE', `payout must remain durably COMPLETE after a second tick; ${diagnostics()}`);
  assert.equal(
    canonicalJson(cycleAfterSecondTick.stages.get('payout').evidence), canonicalJson(payoutEvidence),
    `payout's own result evidence must be byte-identical after a second tick and a fresh repository reopen -- immutable, never re-paid; ${diagnostics()}`,
  );
  assert.equal(
    canonicalJson(cycleAfterSecondTick.stages.get('return').evidence), canonicalJson(returnEvidence),
    `return's own settled-leg evidence must be byte-identical after a second tick and a fresh repository reopen -- immutable, never re-settled; ${diagnostics()}`,
  );
  assert.equal(
    canonicalJson([...cycleAfterSecondTick.relayLegs.entries()]), canonicalJson([...cycle.relayLegs.entries()]),
    `the one settled Relay leg must be byte-identical after a second tick -- never re-quoted, re-signed, or re-broadcast; ${diagnostics()}`,
  );
  assert.equal(
    canonicalJson([...cycleAfterSecondTick.custodyLedgers.entries()]), canonicalJson([...cycle.custodyLedgers.entries()]),
    `custody ledgers must stay byte-identical after the second tick -- no duplicate write of any kind; ${diagnostics()}`,
  );

  // Later held-card sale: provider availability for pack 1's own held card genuinely changes (its
  // own `getBuybackAvailable` now reports `available: true`), the operator records a real
  // held-owner-sell decision for it, and this same durably COMPLETED cycle's own supplementary
  // settlement machine drives a real Collector resale, a real Solana-to-EVM return bridge, and a
  // real EVM payout -- entirely through the real production `productionSupplementaryStageHandlers`
  // (compose.mjs), reached automatically because this composed config's own
  // `execution.profile: 'production'` and every `runOnce()`/`recoverActiveCycle()` call here already
  // passes `liveMode: true`. Bound, by construction (`prepareSupplementaryPayoutRequest`'s own
  // `eligibilitySnapshotEvidenceDigest` cross-check, supplementary-payout.mjs), to the ORIGINAL
  // eligibility snapshot this cycle already completed -- never a fresh or re-derived one.
  supplementaryBuybackAvailable = true;
  const heldOwnerDecisionRequestId = randomUUID();
  const heldOwnerDecision = await repositoryAfterSecondTick.recordHeldOwnerDecision(heldPosition.positionId, {
    heldEvidenceDigest: heldPosition.evidenceDigest,
    requestId: heldOwnerDecisionRequestId,
    expectedRevision: heldPosition.positionRevision,
    choice: 'sell',
  });
  assert.equal(heldOwnerDecision.choice, 'sell', `the real held-owner decision must record a genuine sell choice; ${diagnostics()}`);

  // A demonstrably different, newly "current" holder address -- proving the supplementary payout
  // below can never newly credit it, since it is bound to the frozen original snapshot, never any
  // live re-derived holder set.
  const OWNERSHIP_CHANGED_NEW_HOLDER_ADDRESS = `0x${'2'.repeat(40)}`;
  const supplementaryComposition = await compose(config);

  let supplementaryBuybackTickError = null;
  try {
    await supplementaryComposition.service.recoverActiveCycle({ liveMode: true });
  } catch (error) {
    supplementaryBuybackTickError = error;
  }
  assert.equal(supplementaryBuybackTickError, null, `the supplementary buyback tick must complete with no error; ${diagnostics()}`);
  const settlementAfterBuyback = await (await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() })).readSupplementarySettlement(heldPosition.positionId);
  assert.equal(settlementAfterBuyback?.state, 'BUYBACK_SENT_UNKNOWN', `the supplementary settlement must advance to BUYBACK_SENT_UNKNOWN after one real Collector resale; ${diagnostics()}`);

  let supplementaryReturnTickError = null;
  try {
    await supplementaryComposition.service.recoverActiveCycle({ liveMode: true });
  } catch (error) {
    supplementaryReturnTickError = error;
  }
  assert.equal(supplementaryReturnTickError, null, `the supplementary return tick must complete with no error; ${diagnostics()}`);
  const settlementAfterReturn = await (await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() })).readSupplementarySettlement(heldPosition.positionId);
  assert.equal(settlementAfterReturn?.state, 'RETURN_BROADCAST', `the supplementary settlement must advance to RETURN_BROADCAST after one real Solana-to-EVM return bridge; ${diagnostics()}`);

  let supplementaryPayoutTickError = null;
  try {
    await supplementaryComposition.service.recoverActiveCycle({ liveMode: true });
  } catch (error) {
    supplementaryPayoutTickError = error;
  }
  assert.equal(supplementaryPayoutTickError, null, `the supplementary payout tick must complete with no error; ${diagnostics()}`);
  const settlementAfterPayout = await (await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() })).readSupplementarySettlement(heldPosition.positionId);
  assert.equal(settlementAfterPayout?.state, 'COMPLETE', `the supplementary settlement must reach COMPLETE after one real finalized EVM payout; ${diagnostics()}`);

  const repositoryAfterSupplementary = await CycleRepository.open(join(directory, 'cycles'), graphNow, { testAuthority: createTestProfileMutationAuthority() });
  const cycleAfterSupplementary = await repositoryAfterSupplementary.describeCycle(cycleId);
  const heldPositionAfterSupplementary = cycleAfterSupplementary.heldPositions.get(heldPosition.positionId);
  assert.equal(heldPositionAfterSupplementary.ownerDecision?.choice, 'sell', `the held position's own durable owner decision must record sell; ${diagnostics()}`);
  assert.equal(heldPositionAfterSupplementary.resolution, null, `the held position resolution itself remains a separate, still-unset field -- supplementary settlement completion is tracked on the settlement record, not by resolving the position; ${diagnostics()}`);

  assert.equal(supplementaryReturnProceedsAtomic, BigInt(EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC), `the real supplementary return proceeds must equal exactly the real Collector resale offer; ${diagnostics()}`);
  assert.equal(supplementaryPayoutTransferAmount, quotedNativeReturnWei(EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC), `the real supplementary payout transfer must credit exactly the real supplementary return proceeds; ${diagnostics()}`);
  assert.equal(supplementaryPayoutRecipientAddress?.toLowerCase(), ELIGIBLE_HOLDER_ADDRESS.toLowerCase(), `the supplementary payout must credit exactly the ORIGINAL eligibility snapshot's one holder, never a different or newly current one; ${diagnostics()}`);
  assert.notEqual(supplementaryPayoutRecipientAddress?.toLowerCase(), OWNERSHIP_CHANGED_NEW_HOLDER_ADDRESS.toLowerCase(), `the supplementary payout must never credit the demonstrably different, newly "current" holder address; ${diagnostics()}`);

  const supplementarySettlementEvidence = await repositoryAfterSupplementary.readSupplementarySettlementEvidence(heldPosition.positionId);
  assert.equal(supplementarySettlementEvidence?.state, 'COMPLETE', `the durable supplementary settlement evidence must itself record COMPLETE; ${diagnostics()}`);

  // Structural proof that the ownership-changed address never receives anything: its own real
  // historical EVM balance, read the exact same way payout's own independent proof reads any
  // account, must remain exactly 0 at every real height this scenario ever produces.
  const newHolderFinalBalance = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: OWNERSHIP_CHANGED_NEW_HOLDER_ADDRESS,
    blockNumber: EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT.number, blockHash: EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT.hash,
  });
  assert.equal(newHolderFinalBalance.value, 0n, `the demonstrably different, newly "current" holder address must never receive any historical proceeds for this old cycle; ${diagnostics()}`);

  // Independent conservation and chronology proof for the supplementary leg, mirroring the main
  // cycle's own: the real supplementary payout's own finalized-transfer evidence, and the real
  // EVM custody row, both agree, and no earlier height's own balance is retroactively rewritten.
  const evmCustodyLedgerRowAfterSupplementary = cycleAfterSupplementary.custodyLedgers?.get?.(evmCustodyCanonicalKey) ?? null;
  assert.notEqual(evmCustodyLedgerRowAfterSupplementary, null, `the one canonical EVM ETH custody row must remain durable after the supplementary settlement; ${diagnostics()}`);
  assert.equal(
    evmCustodyLedgerRowAfterSupplementary.chainId, evmCustodyLedgerRow.chainId,
    `the supplementary settlement must never create a competing raw-identity custody row; the one canonical CAIP-keyed row remains the single source of truth; ${diagnostics()}`,
  );
  const operationsBalanceAtSupplementaryReturn = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: OPERATIONS_EVM_SIGNING_ADDRESS,
    blockNumber: EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN.number, blockHash: EVM_BLOCK_AFTER_SUPPLEMENTARY_RETURN.hash,
  });
  assert.equal(operationsBalanceAtSupplementaryReturn.value, EVM_NATIVE_BALANCE_ATOMIC + AGGREGATE_FUNDING_ATOMIC - 42000n + quotedNativeReturnWei(EPIC_GATE_SUPPLEMENTARY_SELL_OFFER_ATOMIC), `Operations' balance after the supplementary return includes its gas reserve and exactly the quoted native proceeds; ${diagnostics()}`);
  const operationsBalanceAtSupplementaryPayout = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: OPERATIONS_EVM_SIGNING_ADDRESS,
    blockNumber: EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT.number, blockHash: EVM_BLOCK_AFTER_SUPPLEMENTARY_PAYOUT.hash,
  });
  assert.equal(operationsBalanceAtSupplementaryPayout.value, EVM_NATIVE_BALANCE_ATOMIC + AGGREGATE_FUNDING_ATOMIC - 63000n, `Operations' balance after supplementary payout retains its reserve less the three observed gas costs; ${diagnostics()}`);
  // The main cycle's already-observed native pre-payout checkpoint (height 101) must
  // remain byte-identical, even now that two more real transactions have since been accepted.
  const mainReturnHeightBalanceAfterSupplementary = await historicalEvidenceStub.readNativeBalanceAtBlock({
    account: OPERATIONS_EVM_SIGNING_ADDRESS,
    blockNumber: EVM_BLOCK_AFTER_RETURN.number, blockHash: EVM_BLOCK_AFTER_RETURN.hash,
  });
  assert.equal(mainReturnHeightBalanceAfterSupplementary.value, expectedReturnBalance, `the main cycle's already-observed native height-101 checkpoint must remain stable even after both the supplementary return and supplementary payout have since been accepted; ${diagnostics()}`);
});

test('the isolated identity transformation touches only the two deployment pins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-identity-transform-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  const path = join(root, POLICY_ENGINE_RELATIVE);
  await cp(join(SOURCE_ROOT, 'packages', 'runner'), join(root, 'packages', 'runner'), {
    recursive: true, filter: candidate => !candidate.includes('/node_modules'),
  });
  const before = await readFile(path, 'utf8');

  const { changedLines } = await repointCopiedDeploymentIdentity(root, {
    evm: `0x${'7'.repeat(40)}`,
    solana: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc',
  });
  assert.equal(changedLines.length, 2, 'exactly the two pin declarations may change');

  const after = await readFile(path, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(beforeLines.length, afterLines.length, 'no line may be added or removed');
  for (const [index, line] of beforeLines.entries()) {
    if (changedLines.includes(index)) continue;
    assert.equal(afterLines[index], line, `line ${index} must be untouched`);
  }
  for (const changed of changedLines) {
    assert.match(beforeLines[changed], /^const OPERATIONS_(EVM|SOLANA) = /, 'only a pin declaration may be rewritten');
  }
  // Every other guard the module exports is still present and still refuses a lookalike identity.
  assert.ok(after.includes('testOnlyAdmissionIdentities'), 'the branded identity gate survives');
  assert.ok(after.includes('not the approved production identity'), 'the refusal survives');
});

test('the transformation refuses a tree whose pins are not exactly the expected declarations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-identity-transform-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  const path = join(root, POLICY_ENGINE_RELATIVE);
  await cp(join(SOURCE_ROOT, 'packages', 'runner'), join(root, 'packages', 'runner'), {
    recursive: true, filter: candidate => !candidate.includes('/node_modules'),
  });
  // A tree already repointed once has no remaining production pin, so a second pass cannot run.
  await repointCopiedDeploymentIdentity(root, { evm: `0x${'7'.repeat(40)}`, solana: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc' });
  await assert.rejects(
    () => repointCopiedDeploymentIdentity(root, { evm: `0x${'8'.repeat(40)}`, solana: 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc' }),
    /could not find exactly one/,
  );
  assert.ok((await readFile(path, 'utf8')).includes(`0x${'7'.repeat(40)}`), 'the refused pass changed nothing');
});


test('literal Collector fixture verifies complete signed messages and idempotent reordered submissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-wire-controls-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const owner = Keypair.generate();
  const fixture = await fixtureServer(t, directory, () => `0x${'9'.repeat(40)}`, () => owner.publicKey.toBase58());
  const ca = await readFile(fixture.caCert);
  async function send(path, payload) {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(new URL(path, fixture.baseUrl), {method: payload ? 'POST' : 'GET', ca, headers: {'content-type': 'application/json'}}, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({status: response.statusCode, value: JSON.parse(text)}));
      });
      request.on('error', reject);
      request.end(payload ? JSON.stringify(payload) : undefined);
    });
  }
  const generated = await send('/api/generateYoloPacks', {playerAddress: owner.publicKey.toBase58(), quantity: 2});
  const signed = generated.value.packs.map(pack => {
    const transaction = Transaction.from(Buffer.from(pack.transaction, 'base64'));
    transaction.partialSign(owner);
    return {...pack, wire: transaction.serialize().toString('base64')};
  });
  for (const pack of [...signed].reverse()) assert.equal((await send('/api/submitTransaction', {signedTransaction: pack.wire})).status, 200);
  const accepted = fixture.evidence().purchases;
  assert.deepEqual(accepted.map(([, value]) => value.memo), ['graph-purchase-pack-1', 'graph-purchase-pack-0']);
  assert.equal((await send('/api/submitTransaction', {signedTransaction: signed[0].wire})).status, 200);
  assert.deepEqual(fixture.evidence().purchases, accepted);
  for (const mutate of [
    tx => { tx.instructions[2].data[9] = 5; },
    tx => { tx.instructions[2].keys[2].pubkey = Keypair.generate().publicKey; },
    tx => { tx.add(new TransactionInstruction({programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from('extra')})); },
  ]) {
    const transaction = Transaction.from(Buffer.from(signed[0].wire, 'base64'));
    mutate(transaction);
    transaction.sign(owner, PURCHASE_PROVIDER_COSIGNER);
    assert.equal(transaction.verifySignatures(), true);
    assert.equal((await send('/api/submitTransaction', {signedTransaction: transaction.serialize().toString('base64')})).status, 422);
  }
  const stale = Transaction.from(Buffer.from(signed[0].wire, 'base64'));
  stale.instructions[2].data[9] = 4;
  const staleWire = stale.serialize({requireAllSignatures: false, verifySignatures: false}).toString('base64');
  assert.equal((await send('/api/submitTransaction', {signedTransaction: staleWire})).status, 422);
  assert.deepEqual(fixture.evidence().purchases, accepted);
  const nfts = (await send('/api/getNfts?page=1&limit=50')).value.nfts;
  const sale = (await send('/api/buyback', {playerAddress: owner.publicKey.toBase58(), nftAddress: nfts[0].nft_address})).value;
  const transaction = Transaction.from(Buffer.from(sale.serializedTransaction, 'base64'));
  transaction.partialSign(owner);
  const wire = transaction.serialize().toString('base64');
  assert.equal((await send('/api/submitTransaction', {signedTransaction: wire})).status, 200);
  const sales = fixture.evidence().buybacks;
  assert.equal(sales[0][1].amountAtomic, 90n);
  assert.equal((await send('/api/submitTransaction', {signedTransaction: wire})).status, 200);
  const changed = Transaction.from(Buffer.from(wire, 'base64'));
  changed.instructions[3].data[9] = 5;
  changed.sign(owner, COLLECTOR_AUTHORITY);
  assert.equal(changed.verifySignatures(), true);
  assert.equal((await send('/api/submitTransaction', {signedTransaction: changed.serialize().toString('base64')})).status, 422);
  const staleSale = Transaction.from(Buffer.from(wire, 'base64'));
  staleSale.instructions[3].data[9] = 4;
  assert.equal((await send('/api/submitTransaction', {signedTransaction: staleSale.serialize({requireAllSignatures: false, verifySignatures: false}).toString('base64')})).status, 422);
  assert.deepEqual(fixture.evidence().buybacks, sales);
});
