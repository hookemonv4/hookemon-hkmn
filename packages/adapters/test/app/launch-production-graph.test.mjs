// Production acceptance harness. This deliberately uses the literal CLI and loopback HTTP/RPC
// services; it has no composition, stage, signer, or authority injection seam.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi,
  parseTransaction, recoverTransactionAddress, toFunctionSelector, toHex,
} from 'viem';

import { createEmptyOperatorState, mutateOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';
import { assertCycleSnapshot } from '../../../runner/src/cycle/cycle-store.mjs';
import { stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createTestKeychain } from '../fixtures/keychain/fixture.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';
import { deriveAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '../../src/solana-rpc.mjs';

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
const PROCESS_USDG_ATOMIC = 1_000_000n;
// Priced so the unit quote lands exactly on maxUnitPriceMicroUsdg and the aggregate exactly on the
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
    { id: ROBINHOOD_CHAIN_ID, depositEnabled: true, erc20Currencies: [{ address: USDG, supportsBridging: true }] },
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
  [toFunctionSelector('function hookUsdgBalance() view returns (uint256)'), () => abiUint(HOOK_LIABILITY_ATOMIC)],
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
const RELAY_DEPOSIT_SELECTOR = '0xe8017952';
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
  // Fees sit at the fixture's configured EVM gas-price cap, so the cap is exercised rather than
  // bypassed, and two transactions at this limit still fit the loopback native balance.
  const item = data => ({
    data: {
      chainId: 4663, from: sender, to: data.to, data: data.data, value: '0',
      gas: '21000', maxFeePerGas: '2', maxPriorityFeePerGas: '1',
    },
  });
  return [{
    kind: 'transaction',
    id: `deposit-${requestId}`,
    requestId,
    items: [
      item({ to: USDG, data: `${ERC20_APPROVE_SELECTOR}${abiAddressWord(RELAY_DEPOSITORY)}${abiWord(originAmount)}` }),
      item({
        to: RELAY_DEPOSITORY,
        data: `${RELAY_DEPOSIT_SELECTOR}${abiAddressWord(sender)}${abiAddressWord(USDG)}${abiWord(originAmount)}${orderId.replace(/^0x/, '')}`,
      }),
    ],
  }];
}

/**
 * A Relay exact-output quote for the destination amount that was actually requested. The origin
 * USDG it reports is looked up per target rather than scaled, which is what makes this fixture able
 * to fail a planner that derives one quote from the other.
 */
function relayQuote(request) {
  const destinationAmount = String(request.amount);
  const originAmount = destinationAmount === '8'
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
      currencyIn: { currency: { chainId: ROBINHOOD_CHAIN_ID, address: USDG, symbol: 'USDG', decimals: 6 }, amount: originAmount },
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
            payment: { chainId: 'robinhood', currency: USDG, amount: originAmount },
            refunds: [{ chainId: 'robinhood', currency: USDG, recipient: sender, deadline }],
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
  if (data.toLowerCase().startsWith(RELAY_DEPOSIT_SELECTOR)) {
    // Calldata word layout: sender, USDG address, originAmount, orderId (see relayExecutionSteps).
    const [sender, , amount] = [0, 1, 2].map(i => data.slice(10 + (i * 64), 10 + ((i + 1) * 64)));
    return [{
      address: USDG,
      topics: encodeEventTopics({
        abi: HOOK_ABI,
        eventName: 'Transfer',
        args: { from: `0x${sender.slice(-40)}`, to: parsed.to },
      }),
      data: `0x${amount}`,
    }];
  }
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
    // The USDG credit the claim actually moves. The stage verifies this transfer independently of
    // the hook's own event, so both have to agree on sender, recipient, and amount.
    {
      address: USDG,
      topics: encodeEventTopics({ abi: HOOK_ABI, eventName: 'Transfer', args: { from: parsed.to, to: destination } }),
      data: amount,
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
  };
  await execFileAsync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', paths.caKey, '-out', paths.caCert, '-subj', '/CN=HKMN graph fixture']);
  await execFileAsync('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', paths.key, '-out', paths.request, '-subj', '/CN=127.0.0.1']);
  await writeFile(paths.extensions, 'subjectAltName=IP:127.0.0.1\n');
  await execFileAsync('/usr/bin/openssl', ['x509', '-req', '-in', paths.request, '-CA', paths.caCert, '-CAkey', paths.caKey, '-CAcreateserial', '-out', paths.cert, '-days', '1', '-extfile', paths.extensions]);
  const [key, cert] = await Promise.all([readFile(paths.key), readFile(paths.cert)]);
  const calls = {
    evm: 0, solana: 0, methods: [], quotes: [],
    // Purchase's own Collector mutation endpoints. Tracked explicitly (rather than left to the
    // generic 404 branch below) so the graph can assert exactly how many times each was reached,
    // instead of only inferring it from the absence of a durable batch record.
    collectorGenerateYoloPacks: 0, collectorPackStatus: 0, collectorSubmitTransaction: 0,
  };
  const broadcasts = new Map();
  const server = createServer({ key, cert }, async (request, response) => {
    if (request.url === '/alert') { response.writeHead(204); response.end(); return; }
    if (request.url === '/chains') { respond(response, RELAY_CHAINS); return; }
    // `new URL('/api/machines', base)` resolves against the origin, so the configured `/collector`
    // prefix is not part of the request path the client actually sends.
    if (request.url === '/api/machines') {
      respond(response, { machines: [{ code: 'return-fixture', price: PACK_PRICE, contains: 1 }] });
      return;
    }
    // Purchase's own Collector mutation endpoints. A truthful response shape was built and
    // verified for each (two unique memos with syntactically valid unsigned transactions for the
    // isolated Operations address; observation-only pack status), then removed once actual
    // execution proved none of the three is reachable today -- see the frontier comment below this
    // fixture for the real, earlier defect that stops the batch before any of them is called. Only
    // the call count survives, so a future fix that reaches this far is still measured precisely.
    if (request.url === '/api/generateYoloPacks') { calls.collectorGenerateYoloPacks += 1; response.writeHead(404); response.end(); return; }
    if (request.url.startsWith('/api/pack/status')) { calls.collectorPackStatus += 1; response.writeHead(404); response.end(); return; }
    if (request.url === '/api/submitTransaction') { calls.collectorSubmitTransaction += 1; response.writeHead(404); response.end(); return; }
    if (request.url === '/quote/v2') {
      const quoteRequest = await body(request);
      calls.quotes.push({ amount: quoteRequest.amount, tradeType: quoteRequest.tradeType });
      respond(response, relayQuote(quoteRequest));
      return;
    }
    if (!['/rpc', '/archive', '/solana'].includes(request.url)) { response.writeHead(404); response.end(); return; }
    const rpc = await body(request);
    const reply = result => respond(response, { jsonrpc: '2.0', id: rpc.id, result });
    if (request.url !== '/solana') {
      calls.evm += 1;
      calls.methods.push(`evm:${rpc.method}`);
      if (rpc.method === 'eth_chainId') return reply('0x1237');
      if (rpc.method === 'eth_getTransactionCount') return reply('0x0');
      if (rpc.method === 'eth_getBalance') return reply('0x61a80');
      if (rpc.method === 'eth_maxPriorityFeePerGas') return reply('0x1');
      if (rpc.method === 'eth_estimateGas') return reply('0x5208');
      if (rpc.method === 'eth_getBlockByNumber') {
        const number = ['latest', 'finalized'].includes(rpc.params?.[0]) ? '0xa' : rpc.params?.[0];
        // One uniform canonical hash for every block, deliberately: the loopback chain has no real
        // reorg surface, so every block is trivially its own valid parent under this single-hash
        // scheme, and the outbound source-finality proof's own-parent/canonical checks
        // (readCanonicalBlockWithParent, packages/adapters/src/robinhood-rpc.mjs) can bind against
        // it exactly like a real chain's block hash and parent hash would agree across two reads.
        return reply({ number, hash: `0x${'1'.repeat(64)}`, parentHash: `0x${'1'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1' });
      }
      if (rpc.method === 'eth_getLogs') {
        const filter = rpc.params?.[0] ?? {};
        const from = BigInt(filter.fromBlock ?? '0x0');
        const to = BigInt(filter.toBlock ?? '0x0');
        return reply(from <= 1n && to >= 1n ? [{
        address: `0x${'d'.repeat(40)}`,
        topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${'9'.repeat(40)}`],
        data: `0x${'1'.padStart(64, '0')}`, blockNumber: '0x1', logIndex: '0x0', blockHash: `0x${'1'.repeat(64)}`, removed: false,
        }] : []);
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
        if (blockNumber === 1 || blockNumber === 2) {
          if (account === operationsAccount().toLowerCase()) {
            const value = blockNumber === 1 ? PROCESS_USDG_ATOMIC : PROCESS_USDG_ATOMIC - AGGREGATE_FUNDING_ATOMIC;
            return reply(`0x${value.toString(16).padStart(64, '0')}`);
          }
          if (account === RELAY_DEPOSITORY.toLowerCase()) {
            const value = blockNumber === 1 ? 0n : AGGREGATE_FUNDING_ATOMIC;
            return reply(`0x${value.toString(16).padStart(64, '0')}`);
          }
        }
        return reply(`0x${PROCESS_USDG_ATOMIC.toString(16).padStart(64, '0')}`);
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
        broadcasts.set(hash, { hash, raw, parsed, from: sender.toLowerCase(), logs: executionLogs(parsed) });
        return reply(hash);
      }
      if (rpc.method === 'eth_getTransactionReceipt' || rpc.method === 'eth_getTransactionByHash') {
        const sent = broadcasts.get(rpc.params?.[0]);
        if (!sent) return reply(null);
        const { parsed: tx } = sent;
        const common = {
          transactionHash: sent.hash, blockNumber: '0x2', blockHash: `0x${'1'.repeat(64)}`,
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
              ...log, blockNumber: '0x2', blockHash: `0x${'1'.repeat(64)}`, transactionHash: sent.hash,
              transactionIndex: '0x0', logIndex: toHex(index), removed: false,
            })),
            logsBloom: `0x${'0'.repeat(512)}`, contractAddress: null,
          });
      }
      return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled EVM ${rpc.method}` } });
    }
    calls.solana += 1;
    calls.methods.push(`solana:${rpc.method}`);
    if (rpc.method === 'getGenesisHash') return reply('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    if (rpc.method === 'getBalance') return reply({ context: { slot: 1 }, value: 10000000 });
    if (rpc.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } });
    if (rpc.method === 'getBlockHeight') return reply(1);
    // Purchase's own settlement account read: the real jsonParsed shape `readAssociatedTokenAccount`
    // (solana-rpc.mjs) requires, for exactly the ATA this run's own Operations identity derives for
    // the settlement mint -- carrying enough balance to cover the admitted purchase.
    if (rpc.method === 'getAccountInfo') {
      const [address, options] = rpc.params ?? [];
      const settlementAta = operationsSolanaAccount() === null
        ? null
        : deriveAssociatedTokenAddress(operationsSolanaAccount(), SOLANA_MINT).toBase58();
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
                  owner: operationsSolanaAccount(),
                  tokenAmount: { amount: AGGREGATE_PURCHASE_ATOMIC.toString(), decimals: 6 },
                },
              },
            },
          },
        });
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
      if (owner !== null && owner === operationsSolanaAccount()) {
        return reply([{ signature: OUTBOUND_DESTINATION_SIGNATURE, slot: 5, err: null }]);
      }
      return reply([]);
    }
    if (rpc.method === 'getTransaction') {
      const [signature] = rpc.params ?? [];
      if (signature === OUTBOUND_DESTINATION_SIGNATURE) {
        return reply(outboundDestinationTransaction(operationsSolanaAccount()));
      }
      return reply(null);
    }
    return respond(response, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled Solana ${rpc.method}` } });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { baseUrl: `https://127.0.0.1:${server.address().port}`, caCert: paths.caCert, calls };
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

/**
 * The real production child signer, not a stub. `hookemon-keychain-signer.mjs` runs unmodified from
 * the isolated source copy and performs the actual EVM/Solana signing; only the macOS Keychain
 * itself is replaced, through the production CLI's own documented
 * `HOOKEMON_OPERATIONS_SECURITY_COMMAND` override, by the shared fake `security` fixture holding
 * freshly generated per-run test keys. Key material never leaves that isolated directory and no
 * signature here is ever broadcast.
 */
async function productionChildSigner(t, sourceRoot, directory) {
  const keychain = await createTestKeychain(t);
  // realpath, like the runner entrypoint above: tmpdir() hands out the `/var` symlink while
  // `import.meta.url` resolves to `/private/var`, and each CLI's own main-module guard compares the
  // two. Invoked through the symlinked path a bin imports cleanly and exits 0 having done nothing.
  const walletBin = await realpath(join(sourceRoot, 'packages', 'adapters', 'bin', 'hookemon-wallet.mjs'));
  const signerBin = await realpath(join(sourceRoot, 'packages', 'adapters', 'bin', 'hookemon-keychain-signer.mjs'));
  const env = { ...process.env, ...keychain.env, HOOKEMON_OPERATIONS_SECURITY_COMMAND: keychain.command };
  const wallets = {};
  for (const identity of ['operations-evm', 'operations-solana']) {
    const result = await runProcess(process.execPath, [
      walletBin, 'generate', '--identity', identity, '--keychain-command', keychain.command,
    ], env);
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new Error(`graph fixture could not generate ${identity}: ${JSON.stringify(result)}`);
    }
    wallets[identity] = JSON.parse(result.stdout);
  }
  // `readEnvironment` refuses any unknown HOOKEMON_* variable, so the fake-Keychain wiring must not
  // be exported to the runner at all. It belongs to the signer child anyway: this wrapper is the
  // only test-owned link in the chain, and it adds nothing but the environment that stands in for a
  // real macOS Keychain before exec'ing the unmodified production signer.
  const command = join(directory, 'keychain-signer-with-test-keychain.mjs');
  await writeFile(command, [
    `#!${process.execPath}`,
    "import { spawn } from 'node:child_process';",
    `const env = { ...process.env, ...${JSON.stringify({ ...keychain.env, HOOKEMON_OPERATIONS_SECURITY_COMMAND: keychain.command })} };`,
    `const child = spawn(process.execPath, [${JSON.stringify(signerBin)}, ...process.argv.slice(2)], { stdio: 'inherit', env });`,
    "child.once('close', (code, signal) => process.exit(signal ? 1 : code ?? 1));",
    '',
  ].join('\n'), { mode: 0o700 });
  return {
    command,
    // Lowercased: the launch manifest and canary role addresses are compared and digested in
    // normalized form, so a checksummed literal would never match its own manifest digest.
    evmAccount: wallets['operations-evm'].address.toLowerCase(),
    solanaAccount: wallets['operations-solana'].publicKey,
  };
}

function observability(baseUrl, directory, operations) {
  const hash = `0x${'a'.repeat(64)}`;
  const pin = address => ({ address, runtimeHash: hash });
  return {
    canaries: {
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
    maxUnitPriceMicroUsdg: '17',
    maxCycleBudgetMicroUsdg: '34',
    max24HourBudgetMicroUsdg: '34',
    paused: false,
    liveMode: true,
    maxCyclesPerDay: 1,
    perCycleCapMicroUsdg: '34',
    lossCapMicroUsdg: '1000',
    maxOutstandingCustodyMicroUsdg: '1000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
  });
  await mutateOperatorState(join(directory, 'operator-state.json'), null, state => ({
    ...(state ?? createEmptyOperatorState()), configuration,
  }));
}

async function testPolicyAuthority(t, directory) {
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
  let publishing = false;
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
      for (const entry of cycle.entries) {
        // Two durable shapes carry a digest a signing boundary can demand: the per-transaction
        // attempts, and the stage-level request digest a chain-journal stage publishes for exactly
        // this purpose. Authorizing both is what lets an operational and a chain stage be
        // authorized by the same producer.
        if (entry?.kind === 'stage-request-prepared') {
          const { stage, requestDigest } = entry.payload ?? {};
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

  async function publish() {
    if (publishing) return;
    publishing = true;
    diagnostics.publishAttempts += 1;
    try {
      for (const { cycleId, stage, requestDigest } of await readCommittedPreparedAttempts()) {
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
    } finally {
      publishing = false;
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
    // The assertions below reopen the same durable store, and `open()` takes the store's exclusive
    // zero-tolerance SQLite lock. Stop the producer and let its in-flight publish drain first, or
    // the harness reliably races itself into `durable cycle store lock contention`.
    async stop() {
      clearInterval(timer);
      while (publishing) await new Promise(resolve => setTimeout(resolve, 5));
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
  await writeFile(join(root, 'architecture', 'interfaces.json'), `${JSON.stringify({
    schemaVersion: 'hookemon.interfaces.v1', productPhase: 3, requirementsRevision: 65, architectureRevision: 9,
    status: 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING', bindingManifestDigest: `sha256:${'a'.repeat(64)}`,
    fixture: 'I-03 isolated test authority; not a release approval',
  })}\n`);
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

async function runProductionWindow(binPath, env, durationMs = 15000) {
  const child = spawn(process.execPath, [binPath, 'run', '--mode', 'production', '--no-dashboard'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let exitCode = null;
  let signal = null;
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.once('close', (code, receivedSignal) => { exitCode = code; signal = receivedSignal; });
  await new Promise(resolve => setTimeout(resolve, durationMs));
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000)),
  ]);
  return { stderr, stdout, exitCode, signal };
}

const GRAPH_WINDOW_MS = Number(process.env.HKMN_GRAPH_WINDOW_MS ?? 15000);

test('I-01/I-02 literal production loader completes an automatic two-pack cycle', { timeout: GRAPH_WINDOW_MS + 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-graph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The loopback chain must report the hook's Operations role as the account this run actually
  // signs with, and that account only exists once the isolated keys are generated, so the fixture
  // reads it late rather than being handed a placeholder.
  let operationsEvm = `0x${'0'.repeat(40)}`;
  let operationsSolana = null;
  const fixture = await fixtureServer(t, directory, () => operationsEvm, () => operationsSolana);
  const { root, binPath } = await isolatedSource(directory);
  const signer = await productionChildSigner(t, root, directory);
  operationsEvm = signer.evmAccount;
  operationsSolana = signer.solanaAccount;
  // Only the copied tree's identity pins move, and only to the keys this run actually holds.
  await repointCopiedDeploymentIdentity(root, { evm: signer.evmAccount, solana: signer.solanaAccount });
  const authority = await testPolicyAuthority(t, directory);
  await activateTwoPackPolicy(directory);
  const observabilityPath = join(directory, 'observability.json');
  const eligibilitySnapshotPath = join(directory, 'eligibility-snapshot.json');
  await writeFile(observabilityPath, `${JSON.stringify(observability(fixture.baseUrl, directory, signer.evmAccount))}\n`);
  await writeFile(eligibilitySnapshotPath, `${JSON.stringify(eligibilitySnapshotFixture(signer.evmAccount))}\n`);
  const env = {
    ...process.env,
    HOOKEMON_STATE_DIR: directory, HOOKEMON_DEFAULT_INTERVAL_MS: '100', HOOKEMON_CHAIN_ID: '4663', HOOKEMON_PROVIDER_MODE: 'live',
    // Long enough that the lease heartbeat, which runs at half the TTL and rotates the fencing
    // token, cannot fire while a stage is mid-flight. Outbound signs two Relay transactions in one
    // execution, each through a spawned signer child, and a token rotated between them makes the
    // second wallet-nonce reservation collide with the first. A short TTL was only attractive while
    // every stage needed one failed tick to get authorized; now that a chain-journal stage publishes
    // the digest its signing boundary demands, attempts are authorized on their first tick and
    // nothing is left reserved for a later retry to trip over.
    HOOKEMON_LEASE_TTL_MS: '30000',
    HOOKEMON_ROBINHOOD_RPC_URL: `${fixture.baseUrl}/rpc`, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: `${fixture.baseUrl}/archive`, HOOKEMON_SOLANA_RPC_URL: `${fixture.baseUrl}/solana`,
    HOOKEMON_RELAY_BASE_URL: fixture.baseUrl, HOOKEMON_RELAY_API_KEY: 'fixture-relay-key', HOOKEMON_RELAY_SOLANA_MINT: SOLANA_MINT, HOOKEMON_RELAY_SOLANA_DECIMALS: '6', HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: `${fixture.baseUrl}/collector`, HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'fixture-collector-key',
    HOOKEMON_EVM_ACCOUNT: signer.evmAccount, HOOKEMON_SOLANA_ACCOUNT: signer.solanaAccount, HOOKEMON_VAULT_ADDRESS: `0x${'b'.repeat(40)}`, HOOKEMON_HOOK_ADDRESS: `0x${'c'.repeat(40)}`, HOOKEMON_HKMN_ADDRESS: `0x${'d'.repeat(40)}`, HOOKEMON_HKMN_DECIMALS: '18',
    HOOKEMON_SIGNER_BACKEND: 'keychain', HOOKEMON_SIGNER_LIVE_MODE: 'true', HOOKEMON_KEYCHAIN_COMMAND: signer.command, HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm', HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_STANDING_AUTHORITY_PATH: authority.documentPath, HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: authority.ownerPublicKeyPath, HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: authority.policyPublicKeyPath,
    HOOKEMON_PACK_CODE: 'return-fixture', HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0', HOOKEMON_MIN_SOLANA_RECEIVE: '0', HOOKEMON_MIN_RETURN_USDG: '0', HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0', HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0', HOOKEMON_EVM_GAS_PRICE_CAP: '2', HOOKEMON_EVM_NATIVE_RESERVE: '2', HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2', HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '85', HOOKEMON_BUDGET_PACK_PRICE_USDG: '17', HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0', HOOKEMON_BUDGET_RETURN_CAP_USDG: '0', HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0', HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath, HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath, NODE_EXTRA_CA_CERTS: fixture.caCert,
  };
  const run = await runProductionWindow(binPath, env, GRAPH_WINDOW_MS);
  await authority.stop();
  authority.assertHealthy();
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
    outbound: [...cycle.chainAttempts.values()].filter(r => r?.attempt?.stage === 'outbound').map(r => ({ digest: r.attempt.requestDigest, state: r.attempt.state, nonce: r.attempt.nonce ?? null })),
    nonces: [...cycle.walletNonceReservations.entries()].map(([k, v]) => ({ k, v })), stderr,
  });
  // Exact N=2 graph frontier (bot-money-frontier.md): outbound settles from real Solana
  // destination-chain evidence and durably completes (both its approval and deposit chain
  // attempts independently finalized -- packages/adapters/src/app/stages/outbound.mjs), then the
  // next automatic tick durably reaches the purchase operation boundary.
  //
  // Purchase/open/epic-gate/buyback/return/payout completion are the next bounded steps and are
  // deliberately not asserted here yet. Every defect this comment previously named -- the
  // preparation-adapter gap, the pack-quantity config-wiring gap, and the native/Relay
  // settlement-asset namespace mismatch in `assertSolanaSignerMoneyConfiguration` -- is now
  // resolved (solana-money-controls.mjs's `PRODUCTION_RELAY_SOLANA_STABLECOIN_ASSET` mapping).
  // Purchase now durably reads its own settlement ATA (this fixture's `getAccountInfo`) and passes
  // the priority-fee envelope check before attempting to record its batch.
  //
  // `bot-pack-type-parity` (cherry-picked as `fix(cycle): align pack type validators`) closed the
  // `cycle-repository.mjs`/`environment.mjs` pack-code mismatch this comment previously named:
  // purchase now durably records its batch intent for this fixture's hyphenated
  // `HOOKEMON_PACK_CODE`, `'return-fixture'`.
  //
  // The verified next blocker (reproduced 2026-09-06 against this exact env/config, after the
  // pack-type-parity fix) is a distinct, real production defect outside this file's write-set,
  // still one step earlier than the expected Collector-policy refusal: `collector-crypt.mjs` keeps
  // its own separate `packTypePattern` (collector-crypt.mjs:74, `/^[a-z][a-z0-9_]{0,63}$/`, no
  // hyphen), enforced client-side by `validateGenerateYoloPacksRequest` (collector-crypt.mjs:241)
  // before `generateYoloPacks` (collector-crypt.mjs:545) ever attempts an HTTP call. This pattern
  // was not touched by the reviewed parity fix (which only aligned `cycle-repository.mjs` and
  // `money-schemas.mjs`), so it throws "collector-crypt generateYoloPacks packType must be a
  // lowercase machine code" on every tick, still before any Collector Crypt HTTP call, still before
  // the Collector-policy refusal this comment anticipates. Closing it requires reconciling this
  // third pattern with `environment.mjs`'s `packCodePattern` (environment.mjs:211,
  // `/^[a-z0-9][a-z0-9_-]{1,63}$/`), out of this file's write-set. The validator throws inside
  // `generateYoloPacks` itself, before `postMutation`/`fetch` ever runs, so truthful
  // `generateYoloPacks`/`pack/status`/`submitTransaction` fixture response bodies (two unique
  // memos, syntactically valid unsigned transactions for the isolated Operations address,
  // observation-only status) stay left out as still unreachable -- this run's own zero call counts
  // below are the proof -- and only each endpoint's call count is asserted, at zero.
  assert.equal(cycle.stages.get('outbound')?.status, 'COMPLETE', `outbound must durably settle from Solana destination-chain evidence; ${await diagnostics()}`);
  const purchase = cycle.preparedStages.get('purchase') ?? null;
  assert.ok(purchase, `purchase must durably reach the PREPARED operation boundary once outbound settles; ${await diagnostics()}`);
  assert.ok(fixture.calls.evm > 0 && fixture.calls.solana > 0, 'production graph must use both loopback chain protocols');
  assert.match(
    stderr,
    /collector-crypt generateYoloPacks packType must be a lowercase machine code/,
    `every purchase mutate tick must refuse collector-crypt.mjs's own separate packType pattern; ${await diagnostics()}`,
  );
  const purchaseIntent = await repository.readPackBatchIntent(cycleIds[0], 'purchase');
  assert.deepEqual(
    purchaseIntent && { quantity: purchaseIntent.intent.quantity, packType: purchaseIntent.intent.packType },
    { quantity: 2, packType: 'return-fixture' },
    `purchase must now durably record its batch intent for the hyphenated pack code (the parity fix); ${await diagnostics()}`,
  );
  assert.equal(
    await repository.readPackBatchRequest(cycleIds[0], 'purchase'), null,
    `purchase must never durably record generated pack memos while collector-crypt.mjs's own packType validation refuses first; ${await diagnostics()}`,
  );
  const purchaseAttempt = await repository.readOperationalStageAttempt(cycleIds[0], 'purchase');
  assert.equal(
    purchaseAttempt?.attempt?.state, 'SENT_UNKNOWN',
    `purchase's operational attempt must be marked SENT_UNKNOWN once its mutate call was entered, even though the packType validation refused before any Collector HTTP call; ${await diagnostics()}`,
  );
  assert.equal(fixture.calls.collectorGenerateYoloPacks, 0, `purchase must never call generateYoloPacks; ${await diagnostics()}`);
  assert.equal(fixture.calls.collectorPackStatus, 0, `purchase must never poll pack status with no batch to reconcile; ${await diagnostics()}`);
  assert.equal(fixture.calls.collectorSubmitTransaction, 0, `purchase must never submit a signed transaction; ${await diagnostics()}`);
  assert.notEqual(cycle.stages.get('purchase')?.status, 'COMPLETE', `purchase must not be claimed complete; ${await diagnostics()}`);
  assert.equal(cycle.terminalState, null, `the cycle must have no terminal success or failure; ${await diagnostics()}`);
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
