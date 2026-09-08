// Pre-spend failure-matrix harness. Setup copied and trimmed from
// packages/adapters/test/app/launch-production-graph.test.mjs at commit
// ccb55a4fb11282f807884c4c8236a065853a6fc7 (do not import that file directly: it executes its own
// tests). This harness drives the literal `packages/adapters/bin/hookemon-runner.mjs` CLI, loopback
// HTTPS fake RPC/provider endpoints, an isolated fixture keychain and the real signer child
// protocol -- no stage-handler injection, fake repository, or direct completion/ledger seeding.
//
// Deliberately dropped versus the graph fixture: the standing-authority step-authorization
// *producer* (its periodic durable-poll-and-publish loop). None of the failure-matrix cases need a
// real signature to occur, so only the owner-signed standing-authority *document* is written here;
// the private per-signing-boundary artifact (`standing-authority-step-authorizations.json`) is
// never created, which makes every real signing attempt fail closed
// (`environment.mjs`'s `readPrivateStandingAuthorityArtifact`) before it can reach the signer.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi,
  parseTransaction, recoverTransactionAddress, toFunctionSelector, toHex,
} from 'viem';

import { createEmptyOperatorState, mutateOperatorState } from '../../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../../runner/src/config/state-schema.mjs';
import { canonicalJson, digest } from '../../../../runner/src/cycle/journal.mjs';
import { assertCycleSnapshot } from '../../../../runner/src/cycle/cycle-store.mjs';
import { stepAuthorizationIntentDigest } from '../../../../runner/src/cycle/authorization-provider.mjs';
import { createTestKeychain } from '../../fixtures/keychain/fixture.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../../src/signing/standing-authority.mjs';

const execFileAsync = promisify(execFile);
export const SOURCE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

export const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const ROBINHOOD_CHAIN_ID = 4663;
const RELAY_SOLANA_CHAIN_ID = 792703809;
const BALANCE_OF_SELECTOR = '0x70a08231';
// One pack costs 0.000008 settlement units, i.e. 8 atomic at 6 decimals, so an N=2 cycle targets 16.
export const PACK_PRICE = '0.000008';
const PROCESS_USDG_ATOMIC = 1_000_000n;
const UNIT_FUNDING_ATOMIC = 17n;
const AGGREGATE_FUNDING_ATOMIC = 33n;
const AGGREGATE_PURCHASE_ATOMIC = 16n;

const RELAY_CHAINS = Object.freeze({
  chains: [
    { id: ROBINHOOD_CHAIN_ID, depositEnabled: true, erc20Currencies: [{ address: USDG, supportsBridging: true }] },
    { id: RELAY_SOLANA_CHAIN_ID, depositEnabled: true, solverCurrencies: [{ address: SOLANA_MINT }] },
  ],
});

const HOOK_LIABILITY_ATOMIC = 1_000_000n;

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

/** The two unsigned EVM transactions Relay's own quote response carries for this route, exactly as
 * in the pinned graph fixture -- present so an admitted cycle that reaches outbound sees the same
 * real calldata shape, even though no failure-matrix case here lets a signature happen. */
function relayExecutionSteps({ requestId, orderId, originAmount, sender }) {
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

const HOOK_ABI = parseAbi([
  'function claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)',
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountAtomicUsdg, address indexed destination, uint256 timestamp, uint256 cap, uint256 usedAfter)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function executionLogs(parsed) {
  const data = parsed.data ?? '0x';
  if (data.toLowerCase().startsWith(RELAY_DEPOSIT_SELECTOR)) {
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
    {
      address: USDG,
      topics: encodeEventTopics({ abi: HOOK_ABI, eventName: 'Transfer', args: { from: parsed.to, to: destination } }),
      data: amount,
    },
  ];
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

/**
 * Loopback HTTPS fixture: same production graph endpoints/protocol as the pinned graph fixture,
 * extended with two independently controllable, deterministic failure-injection points:
 *
 *  - `catalogAvailable()`: when it returns false, `/api/machines` (the real catalog endpoint) always
 *    answers HTTP 503, exactly what a provider outage looks like to the literal loader.
 *  - `freezeAfterFirstRead`: when true, the hook/USDG `isFrozen(address)` reader answers `false` on
 *    its very first invocation across the whole run (the healthy observation) and `true` on every
 *    invocation after that (the freeze). The boundary is a real request count, not a sleep: it is
 *    the same production `readUsdgFrozen` call the observability canary makes immediately before
 *    every mutation, so "first call" and "next call" are exactly "startup" and "the next scheduled
 *    mutation check" in real request order.
 *  - `freezeBarrier({ readCount })`: an optional async override of `freezeAfterFirstRead`, awaited
 *    before this same `isFrozen` response is released. Because the child under test is itself
 *    awaiting this exact HTTPS response before it can proceed (`beforeMutation` blocks
 *    `stageDriver.execute()`, `automated-cycle-service.mjs`), a barrier here pins a real,
 *    already-existing request-ordering point instead of adding a race. Caution confirmed by direct
 *    observation while building this: the generic per-stage `prepareStage` entry does precede this
 *    call, but for a chain-journal stage the *request-digest*-bearing entry a standing-authority
 *    producer needs to match against (`recordStageRequestDigest`, `stage-driver.mjs`) is written
 *    *inside* `stageDriver.execute()` -- i.e. strictly after this call, not before it, on that
 *    stage's first-ever attempt. A barrier here can therefore observe that digest deterministically
 *    only from the second call onward (see `readCommittedPreparedAttempts`/`peekPrepared`, exported
 *    below, which reads the same durable state this reasons about); see `authorityGate` for the
 *    barrier this file also offers at a point that does not have that limitation.
 *  - `authorityGate()`: an optional async hook awaited before *every* request this server handles,
 *    regardless of URL or RPC method -- a real, generic public-RPC-boundary point rather than one
 *    tied to `isFrozen` specifically. Since the request-digest for a chain-journal stage's first
 *    attempt is only known partway through that same attempt's own `execute()` (see above), and that
 *    `execute()` still makes further real RPC calls of its own before it ever reaches a signer (this
 *    fixture's own hook-liability reads among them), a caller can hold up whichever of those later
 *    calls happens to be made first once the digest is durably committed, and publish for it there.
 */
export async function fixtureServer(
  t,
  directory,
  operationsAccount = () => `0x${'0'.repeat(40)}`,
  operationsSolanaAccount = () => null,
  { catalogAvailable = () => true, freezeAfterFirstRead = false, freezeBarrier = null, authorityGate = null } = {},
) {
  const paths = {
    caKey: join(directory, 'ca-key.pem'), caCert: join(directory, 'ca-cert.pem'),
    key: join(directory, 'tls-key.pem'), request: join(directory, 'tls-request.pem'),
    cert: join(directory, 'tls-cert.pem'), extensions: join(directory, 'tls-ext.cnf'),
  };
  await execFileAsync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', paths.caKey, '-out', paths.caCert, '-subj', '/CN=HKMN failure-matrix fixture']);
  await execFileAsync('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', paths.key, '-out', paths.request, '-subj', '/CN=127.0.0.1']);
  await writeFile(paths.extensions, 'subjectAltName=IP:127.0.0.1\n');
  await execFileAsync('/usr/bin/openssl', ['x509', '-req', '-in', paths.request, '-CA', paths.caCert, '-CAkey', paths.caKey, '-CAcreateserial', '-out', paths.cert, '-days', '1', '-extfile', paths.extensions]);
  const [key, cert] = await Promise.all([readFile(paths.key), readFile(paths.cert)]);
  let frozenReadCount = 0;
  const calls = {
    evm: 0, solana: 0, methods: [], quotes: [],
    catalog: 0, evmBroadcasts: 0,
    collectorGenerateYoloPacks: 0, collectorPackStatus: 0, collectorSubmitTransaction: 0,
    usdgFrozenObservations: [],
  };
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
      toFunctionSelector('function isFrozen(address account) view returns (bool)'),
      // Async on purpose: when `freezeBarrier` is supplied, this is the real public RPC boundary a
      // test can hold open while it deterministically confirms authority state on disk (see that
      // option's own doc comment above `fixtureServer`) before releasing the response the child is
      // awaiting -- no different in kind from any other real, possibly slow, RPC dependency.
      async () => {
        frozenReadCount += 1;
        const frozen = typeof freezeBarrier === 'function'
          ? await freezeBarrier({ readCount: frozenReadCount })
          : (freezeAfterFirstRead && frozenReadCount > 1);
        calls.usdgFrozenObservations.push(frozen);
        return abiUint(frozen ? 1n : 0n);
      },
    ],
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
  const broadcasts = new Map();
  const server = createServer({ key, cert }, async (request, response) => {
    // A real, generic public-RPC-boundary hook: awaited before any request is even routed, so it
    // can hold up whichever real request happens to be the first one made after some durable
    // condition the child under test does not know this fixture is watching for (see
    // `freeze-authority-boundary.test.mjs`'s `createAuthorityGate` for the concrete use).
    if (typeof authorityGate === 'function') await authorityGate();
    if (request.url === '/alert') { response.writeHead(204); response.end(); return; }
    if (request.url === '/chains') { respond(response, RELAY_CHAINS); return; }
    if (request.url === '/api/machines') {
      calls.catalog += 1;
      if (!catalogAvailable()) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'catalog fixture: provider unavailable' }));
        return;
      }
      respond(response, { machines: [{ code: 'return-fixture', price: PACK_PRICE, contains: 1 }] });
      return;
    }
    if (request.url === '/api/generateYoloPacks') {
      calls.collectorGenerateYoloPacks += 1;
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'failure-matrix fixture: purchase must never be reached' }));
      return;
    }
    if (request.url.startsWith('/api/pack/status')) {
      calls.collectorPackStatus += 1;
      const memo = new URL(request.url, 'https://fixture.invalid').searchParams.get('memo');
      respond(response, { memo, pack: null, send: null, buyback: [] });
      return;
    }
    if (request.url === '/api/submitTransaction') {
      calls.collectorSubmitTransaction += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'failure-matrix fixture: submitTransaction must never be reached' }));
      return;
    }
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
      if (rpc.method === 'eth_call') {
        const call = rpc.params?.[0] ?? {};
        const selector = (call.data ?? '').slice(0, 10).toLowerCase();
        const hookValue = HOOK_STATE_SELECTORS.get(selector);
        if (hookValue !== undefined) return reply(await hookValue(operationsAccount()));
      }
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
      if (rpc.method === 'eth_sendRawTransaction') {
        calls.evmBroadcasts += 1;
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
    if (rpc.method === 'getAccountInfo') return reply({ context: { slot: 1 }, value: null });
    if (rpc.method === 'isBlockhashValid') return reply({ context: { slot: 1 }, value: true });
    if (rpc.method === 'getSignaturesForAddress') return reply([]);
    if (rpc.method === 'getTransaction') return reply(null);
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
 * The real production child signer, not a stub: `hookemon-keychain-signer.mjs` runs unmodified from
 * the isolated source copy. Only the macOS Keychain is replaced, through the production CLI's own
 * documented `HOOKEMON_OPERATIONS_SECURITY_COMMAND` override, by the shared fake `security` fixture.
 *
 * The one test-owned wrapper this run's `HOOKEMON_KEYCHAIN_COMMAND` actually points at appends a
 * durable, append-only JSON-lines log of every invocation (`probe`, `sign`, or `broadcast`) before
 * exec'ing the unmodified signer, so a test can count real signing operations separately from
 * readiness probes without patching production code.
 */
export async function productionChildSigner(t, sourceRoot, directory) {
  const keychain = await createTestKeychain(t);
  const walletBin = await realpath(join(sourceRoot, 'packages', 'adapters', 'bin', 'hookemon-wallet.mjs'));
  const signerBin = await realpath(join(sourceRoot, 'packages', 'adapters', 'bin', 'hookemon-keychain-signer.mjs'));
  const env = { ...process.env, ...keychain.env, HOOKEMON_OPERATIONS_SECURITY_COMMAND: keychain.command };
  const wallets = {};
  for (const identity of ['operations-evm', 'operations-solana']) {
    const result = await runProcess(process.execPath, [
      walletBin, 'generate', '--identity', identity, '--keychain-command', keychain.command,
    ], env);
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new Error(`failure-matrix fixture could not generate ${identity}: ${JSON.stringify(result)}`);
    }
    wallets[identity] = JSON.parse(result.stdout);
  }
  const logPath = join(directory, 'signer-invocations.jsonl');
  await writeFile(logPath, '');
  const command = join(directory, 'keychain-signer-with-test-keychain.mjs');
  await writeFile(command, [
    `#!${process.execPath}`,
    "import { appendFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    `const LOG_PATH = ${JSON.stringify(logPath)};`,
    'const wireArgs = process.argv.slice(2);',
    'appendFileSync(LOG_PATH, `${JSON.stringify({ atMs: Date.now(), operation: wireArgs[0] ?? null, argv: wireArgs })}\\n`);',
    `const env = { ...process.env, ...${JSON.stringify({ ...keychain.env, HOOKEMON_OPERATIONS_SECURITY_COMMAND: keychain.command })} };`,
    `const child = spawn(process.execPath, [${JSON.stringify(signerBin)}, ...wireArgs], { stdio: 'inherit', env });`,
    "child.once('close', (code, signal) => process.exit(signal ? 1 : code ?? 1));",
    '',
  ].join('\n'), { mode: 0o700 });
  return {
    command,
    logPath,
    evmAccount: wallets['operations-evm'].address.toLowerCase(),
    solanaAccount: wallets['operations-solana'].publicKey,
  };
}

/** Reads the wrapper's durable invocation log and buckets it by wire operation. Safe to call after
 * a restart: the log is append-only across the whole directory's lifetime. */
export async function readSignerInvocations(signer) {
  const text = await readFile(signer.logPath, 'utf8');
  const lines = text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
  return {
    lines,
    probe: lines.filter(line => line.operation === 'probe').length,
    sign: lines.filter(line => line.operation === 'sign').length,
    broadcast: lines.filter(line => line.operation === 'broadcast').length,
  };
}

export function observabilityConfig(baseUrl, directory, operations) {
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

export function eligibilitySnapshotFixture(operations) {
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

export async function activateTwoPackPolicy(directory) {
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

/**
 * Owner-signed standing-authority document only -- no polling producer, no per-signing-boundary
 * artifact. Every case in this file needs the document (required, structurally, by
 * `environment.mjs` at every boot) but must never let a real signature happen; omitting the private
 * `standing-authority-step-authorizations.json` artifact is what makes
 * `readPrivateStandingAuthorityArtifact` fail closed the instant any stage actually tries to sign.
 */
export async function writeStandingAuthorityDocument(directory) {
  const ownerKeys = generateKeyPairSync('ed25519');
  const policyKeys = generateKeyPairSync('ed25519');
  const ownerPublicKeyPath = join(directory, 'test-owner-public.pem');
  const policyPublicKeyPath = join(directory, 'test-policy-public.pem');
  const documentPath = join(directory, 'test-standing-authority.json');
  await Promise.all([
    writeFile(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
    writeFile(policyPublicKeyPath, policyKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 }),
  ]);
  const document = attachOwnerSignature(buildCanonicalStandingAuthorityDocument({
    owner: 'test-loopback-authority',
    policyPublicKey: policyKeys.publicKey,
    perCycleSpendCap: '34',
    maxCyclesPerDay: 64,
    allowedPacks: ['return-fixture'],
    allowedDestinations: ['test-loopback-authority-destination'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'test-loopback-failure-matrix-policy',
  }), ownerKeys.privateKey);
  await writeFile(documentPath, `${canonicalJson(document)}\n`, { mode: 0o600 });
  return { documentPath, ownerPublicKeyPath, policyPublicKeyPath };
}

/**
 * Owner-signed standing-authority document PLUS the real per-step-authorization producer: the
 * durable-poll-and-publish loop `writeStandingAuthorityDocument` above deliberately omits. Read-only
 * reference: this is a straight copy of `testPolicyAuthority` from the reserved
 * `launch-production-graph.test.mjs` at commit ccb55a4fb11282f807884c4c8236a065853a6fc7 (still
 * present unedited at this worktree's base `fa62117c`) -- no field, guard, or validity rule here was
 * invented; every one of them is that function's own. It is copied rather than imported because that
 * file is reserved and importing it would execute its own tests.
 *
 * With this producer running, a stage's first real signing attempt is genuinely authorizable: once
 * this loop observes the stage's own durably committed `*-prepared` entry, it independently signs
 * and publishes a matching step-authorization intent, so a real signature can and (given enough
 * ticks) does happen -- the positive control this file's own boundary case needs. No production key,
 * network, or broadcast is used: `policyKeys`/`ownerKeys` are local, process-only ed25519 keypairs,
 * and the artifact only ever authorizes signing against the loopback fixture.
 *
 * `autoStart: false` skips both the initial publish and the 10ms interval, leaving the artifact
 * unpublished until a caller explicitly awaits the returned `publishOnce()` -- letting a test pin the
 * exact moment authority becomes available to a single, real request-ordering point (e.g. inside a
 * loopback RPC handler already being awaited by the child under test) instead of a background race.
 * `publishOnce()` returns the prepared attempts it just read and whether it wrote a new artifact, so
 * a caller can assert the exact stage/digest it published without re-deriving it.
 */
export async function createStandingAuthorityProducer(t, directory, { autoStart = true } = {}) {
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
    maxCyclesPerDay: 64,
    allowedPacks: ['return-fixture'],
    allowedDestinations: ['test-loopback-authority-destination'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    documentId: 'test-loopback-authority-boundary-policy',
  }), ownerKeys.privateKey);
  await writeFile(documentPath, `${canonicalJson(document)}\n`, { mode: 0o600 });

  const entries = new Map();
  const diagnostics = { publishAttempts: 0, publishWrites: 0, enoent: 0, keys: [] };
  let publishing = false;
  let publishedArtifact = null;
  let producerError = null;
  // Deliberately not CycleRepository.open(): that bootstrap takes the durable store's exclusive
  // zero-tolerance SQLite lock, and a producer polling on the same lock starves the very runner it
  // is meant to authorize. Reads the committed active-cycle files directly instead, re-verifying
  // the journal hash chain (assertCycleSnapshot) before anything here is treated as authorized.
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
    if (publishing) return { prepared: [], wrote: false };
    publishing = true;
    diagnostics.publishAttempts += 1;
    try {
      const prepared = await readCommittedPreparedAttempts();
      for (const { cycleId, stage, requestDigest } of prepared) {
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
      if (artifactText === publishedArtifact) return { prepared, wrote: false };
      await writeFile(artifactNextPath, artifactText, { mode: 0o600 });
      await rename(artifactNextPath, artifactPath);
      publishedArtifact = artifactText;
      diagnostics.publishWrites += 1;
      return { prepared, wrote: true };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      diagnostics.enoent += 1;
      return { prepared: [], wrote: false };
    } finally {
      publishing = false;
    }
  }
  let timer = null;
  if (autoStart) {
    await publish();
    timer = setInterval(() => {
      void publish().catch(error => { producerError = error; });
    }, 10);
    t.after(() => clearInterval(timer));
  }
  return {
    documentPath,
    ownerPublicKeyPath,
    policyPublicKeyPath,
    artifactPath,
    diagnostics,
    // Read-only: the same durable committed-state read `publishOnce` uses internally, without
    // writing anything. Lets a caller decide *whether* a stage's own request has been durably
    // committed yet before choosing to publish, rather than publishing (and thereby creating an
    // artifact that may not yet match anything) on every call.
    async peekPrepared() {
      return readCommittedPreparedAttempts();
    },
    // Runs exactly one read-sign-rename pass and returns only once the atomic rename has completed,
    // so a caller awaiting this knows the artifact on disk already reflects it -- no polling.
    async publishOnce() {
      return publish();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      while (publishing) await new Promise(resolve => setTimeout(resolve, 5));
    },
    assertHealthy() { if (producerError !== null) throw producerError; },
  };
}

const POLICY_ENGINE_RELATIVE = 'packages/runner/src/automation/policy-engine.mjs';
const PINNED_OPERATIONS_EVM = "const OPERATIONS_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';";
const PINNED_OPERATIONS_SOLANA = "const OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';";

/** Repoints the deployment-identity pins inside the copied source, and nothing else. See the pinned
 * graph fixture's own doc comment for the full rationale; behavior here is identical. */
export async function repointCopiedDeploymentIdentity(root, { evm, solana }) {
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

/** Copies the packages a production run needs into an isolated tree and verifies the copied CLI
 * entrypoint actually runs (prints its own usage banner with no arguments). Assert-verbatim from the
 * pinned graph fixture. */
export async function isolatedSource(directory) {
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
    fixture: 'failure-matrix isolated test authority; not a release approval',
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
    throw new Error('isolated failure-matrix fixture did not execute the copied CLI entrypoint');
  }
  return { root, binPath };
}

export function runProductionWindow(binPath, env, durationMs) {
  return new Promise(resolve => {
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
    setTimeout(() => {
      child.kill('SIGTERM');
      Promise.race([
        new Promise(res => child.once('close', res)),
        new Promise(res => setTimeout(() => { child.kill('SIGKILL'); res(); }, 1000)),
      ]).then(() => resolve({ stderr, stdout, exitCode, signal }));
    }, durationMs);
  });
}

/** Wait for a durable proof boundary after a CLI tick, including an expected first-tick
 * missing-authority refusal. The deadline includes startup and the scheduler's five-second
 * retry; only the observed boundary establishes success, never elapsed time. */
export async function runProductionUntil(binPath, env, { deadlineMs, observe }) {
  const child = spawn(process.execPath, [binPath, 'run', '--mode', 'production', '--no-dashboard'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let finish;
  const boundary = new Promise(resolve => { finish = resolve; });
  let inspection = Promise.resolve();
  const inspect = () => {
    inspection = inspection.then(async () => {
      if (await observe({ stderr, stdout })) finish({ reason: 'boundary' });
    }).catch(error => finish({ reason: 'observation-error', error: String(error) }));
  };
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); inspect(); });
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); inspect(); });
  const closed = new Promise(resolve => {
    child.once('error', error => finish({ reason: 'child-error', error: String(error) }));
    child.once('close', (exitCode, signal) => resolve({ reason: 'child-exit', exitCode, signal }));
  });
  let timer;
  const outcome = await Promise.race([
    boundary, closed, new Promise(resolve => { timer = setTimeout(() => resolve({ reason: 'deadline' }), deadlineMs); }),
  ]);
  clearTimeout(timer);
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
  const result = await closed;
  clearTimeout(killTimer);
  await inspection;
  const diagnostics = JSON.stringify({ outcome, ...result, stderr, stdout });
  assert.equal(outcome.reason, 'boundary', `production proof boundary was not reached: ${diagnostics}`);
  assert.equal(result.exitCode, 0, `production child did not shut down cleanly: ${diagnostics}`);
  return { stderr, stdout, exitCode: result.exitCode, signal: result.signal };
}

/** The full literal-production env, matching the pinned graph fixture's own env one field at a
 * time. Callers pass the fixture/signer/authority objects this module already builds. */
export function buildProductionEnv({ directory, fixture, signer, authority, observabilityPath, eligibilitySnapshotPath, leaseTtlMs = '30000', intervalMs = '100' }) {
  return {
    ...process.env,
    HOOKEMON_STATE_DIR: directory, HOOKEMON_DEFAULT_INTERVAL_MS: intervalMs, HOOKEMON_CHAIN_ID: '4663', HOOKEMON_PROVIDER_MODE: 'live',
    HOOKEMON_LEASE_TTL_MS: leaseTtlMs,
    HOOKEMON_ROBINHOOD_RPC_URL: `${fixture.baseUrl}/rpc`, HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL: `${fixture.baseUrl}/archive`, HOOKEMON_SOLANA_RPC_URL: `${fixture.baseUrl}/solana`,
    HOOKEMON_RELAY_BASE_URL: fixture.baseUrl, HOOKEMON_RELAY_API_KEY: 'fixture-relay-key', HOOKEMON_RELAY_SOLANA_MINT: SOLANA_MINT, HOOKEMON_RELAY_SOLANA_DECIMALS: '6', HOOKEMON_RELAY_EVM_DEPOSITORY: `0x${'a'.repeat(40)}`,
    HOOKEMON_COLLECTOR_CRYPT_BASE_URL: `${fixture.baseUrl}/collector`, HOOKEMON_COLLECTOR_CRYPT_API_KEY: 'fixture-collector-key',
    HOOKEMON_EVM_ACCOUNT: signer.evmAccount, HOOKEMON_SOLANA_ACCOUNT: signer.solanaAccount, HOOKEMON_VAULT_ADDRESS: `0x${'b'.repeat(40)}`, HOOKEMON_HOOK_ADDRESS: `0x${'c'.repeat(40)}`, HOOKEMON_HKMN_ADDRESS: `0x${'d'.repeat(40)}`, HOOKEMON_HKMN_DECIMALS: '18',
    HOOKEMON_SIGNER_BACKEND: 'keychain', HOOKEMON_SIGNER_LIVE_MODE: 'true', HOOKEMON_KEYCHAIN_COMMAND: signer.command, HOOKEMON_KEYCHAIN_EVM_ACCOUNT: 'operator-evm', HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT: 'operator-solana',
    HOOKEMON_STANDING_AUTHORITY_PATH: authority.documentPath, HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH: authority.ownerPublicKeyPath, HOOKEMON_STANDING_AUTHORITY_POLICY_PUBLIC_KEY_PATH: authority.policyPublicKeyPath,
    HOOKEMON_PACK_CODE: 'return-fixture', HOOKEMON_MIN_ROBINHOOD_RECEIVE: '0', HOOKEMON_MIN_SOLANA_RECEIVE: '0', HOOKEMON_MIN_RETURN_USDG: '0', HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD: '0', HOOKEMON_NATIVE_GAS_CAP_SOLANA: '0', HOOKEMON_EVM_GAS_PRICE_CAP: '2', HOOKEMON_EVM_NATIVE_RESERVE: '2', HOOKEMON_SOLANA_PRIORITY_FEE_CAP: '2', HOOKEMON_SOLANA_LAMPORT_RESERVE: '2',
    HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG: '85', HOOKEMON_BUDGET_PACK_PRICE_USDG: '17', HOOKEMON_BUDGET_OUTBOUND_CAP_USDG: '0', HOOKEMON_BUDGET_RETURN_CAP_USDG: '0', HOOKEMON_BUDGET_OPERATING_MARGIN_USDG: '0', HOOKEMON_OBSERVABILITY_CONFIG_PATH: observabilityPath, HOOKEMON_ELIGIBILITY_SNAPSHOT_CONFIG_PATH: eligibilitySnapshotPath, NODE_EXTRA_CA_CERTS: fixture.caCert,
  };
}

export { assert };
