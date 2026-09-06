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
  parseTransaction, recoverTransactionAddress, toHex,
} from 'viem';

import { createEmptyOperatorState, mutateOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';
import { assertCycleSnapshot } from '../../../runner/src/cycle/cycle-store.mjs';
import { stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createTestKeychain } from '../fixtures/keychain/fixture.mjs';
import { attachOwnerSignature, buildCanonicalStandingAuthorityDocument } from '../../src/signing/standing-authority.mjs';

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

const RELAY_CHAINS = Object.freeze({
  chains: [
    { id: ROBINHOOD_CHAIN_ID, depositEnabled: true, erc20Currencies: [{ address: USDG, supportsBridging: true }] },
    { id: RELAY_SOLANA_CHAIN_ID, depositEnabled: true, solverCurrencies: [{ address: SOLANA_MINT }] },
  ],
});

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
  let call;
  try {
    call = decodeFunctionData({ abi: HOOK_ABI, data: parsed.data ?? '0x' });
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

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fixtureServer(t, directory) {
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
  const calls = { evm: 0, solana: 0, methods: [], quotes: [] };
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
        return reply({ number, hash: `0x${'1'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: '0x1' });
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
      // balanceOf is answered with real process funds; every other static call keeps returning zero.
      if (rpc.method === 'eth_call') {
        const data = rpc.params?.[0]?.data ?? '';
        return reply(data.startsWith(BALANCE_OF_SELECTOR)
          ? `0x${PROCESS_USDG_ATOMIC.toString(16).padStart(64, '0')}`
          : `0x${'0'.repeat(64)}`);
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
  const fixture = await fixtureServer(t, directory);
  const { root, binPath } = await isolatedSource(directory);
  const signer = await productionChildSigner(t, root, directory);
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
  const repository = await CycleRepository.open(join(directory, 'cycles'));
  const cycleIds = await repository.listKnownCycleIds();
  assert.equal(cycleIds.length, 1, `production graph did not durably admit one N=2 cycle: ${JSON.stringify({ run, calls: fixture.calls })}`);
  const cycle = await repository.describeCycle(cycleIds[0]);
  assert.equal(cycle.mode, 'production');
  assert.equal(cycle.providerMode, 'live');
  const purchase = cycle.stages.get('purchase') ?? cycle.preparedStages.get('purchase') ?? null;
  assert.ok(purchase, `automatic admission must durably reach the purchase operation boundary for both requested packs; ${JSON.stringify({
    stages: [...cycle.stages.keys()], prepared: [...cycle.preparedStages.keys()],
    chainAttempts: [...cycle.chainAttempts.values()].map(record => ({ stage: record?.attempt?.stage, state: record?.attempt?.state, requestDigest: record?.attempt?.requestDigest })),
    operationalAttempts: [...cycle.operationalAttempts.values()].map(record => ({ stage: record?.attempt?.stage, requestDigest: record?.attempt?.requestDigest })),
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
  })}`);
  assert.equal(cycle.completed, true, 'the automatic N=2 production graph must converge before the scheduler window closes');
  assert.ok(fixture.calls.evm > 0 && fixture.calls.solana > 0, 'production graph must use both loopback chain protocols');
});
