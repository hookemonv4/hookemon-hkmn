import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const binding = JSON.parse(await readFile(new URL('../../../../bindings/robinhood-chain.json', import.meta.url), 'utf8'));
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);

// Read-only RPC allowlist: this helper must never acquire a wallet or mutate a fork.
async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error('RPC_HTTP_FAILURE');
  const body = await response.json();
  if (body.error || !Object.hasOwn(body, 'result')) throw new Error('RPC_RESULT_FAILURE');
  return body.result;
}

export async function inspectFork(localUrl, request = rpc) {
  const report = { schema: 'hookemon.dashboard-fork-preflight.v1',
    evidence: 'UNVERIFIED', reason: null, dashboardPlanVerified: false };
  try {
    const url = new URL(localUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('LOCAL_RPC_REQUIRED');
    }
    const metadata = await request(url.href, 'anvil_metadata');
    if (!metadata?.clientVersion?.toLowerCase().includes('anvil')) throw new Error('ANVIL_REQUIRED');
    const fork = metadata.forkedNetwork;
    if (!fork) return { ...report, evidence: 'LOCAL_UNFORKED', reason: 'NO_FORK_METADATA' };
    if (Number(fork.chainId) !== binding.chain.chainId || Number(metadata.chainId) !== binding.chain.chainId) {
      throw new Error('WRONG_CHAIN');
    }
    if (!Number.isSafeInteger(fork.forkBlockNumber) || fork.forkBlockNumber < 0 || !hash(fork.forkBlockHash)) {
      throw new Error('INVALID_FORK_METADATA');
    }
    const number = `0x${fork.forkBlockNumber.toString(16)}`;
    const [localBlock, upstreamBlock, upstreamChain] = await Promise.all([
      request(url.href, 'eth_getBlockByNumber', [number, false]),
      request(binding.chain.rpcUrl, 'eth_getBlockByNumber', [number, false]),
      request(binding.chain.rpcUrl, 'eth_chainId'),
    ]);
    if (Number(upstreamChain) !== binding.chain.chainId) throw new Error('WRONG_UPSTREAM_CHAIN');
    if (!hash(localBlock?.hash) || !hash(upstreamBlock?.hash) ||
        localBlock.hash.toLowerCase() !== fork.forkBlockHash.toLowerCase() ||
        upstreamBlock.hash.toLowerCase() !== fork.forkBlockHash.toLowerCase() ||
        Number(localBlock.number) !== fork.forkBlockNumber || Number(upstreamBlock.number) !== fork.forkBlockNumber) {
      throw new Error('FORK_BLOCK_MISMATCH');
    }
    return { ...report, evidence: 'ROBINHOOD_MAINNET_FORK',
      chainId: binding.chain.chainId, forkBlockNumber: fork.forkBlockNumber,
      forkBlockHash: fork.forkBlockHash.toLowerCase() };
  } catch (error) {
    // Do not print raw provider messages, metadata or URLs: they may contain credentials.
    const known = ['LOCAL_RPC_REQUIRED', 'ANVIL_REQUIRED', 'WRONG_CHAIN', 'INVALID_FORK_METADATA',
      'WRONG_UPSTREAM_CHAIN', 'FORK_BLOCK_MISMATCH', 'RPC_HTTP_FAILURE', 'RPC_RESULT_FAILURE'];
    return { ...report, reason: known.includes(error.message) ? error.message : 'RPC_UNAVAILABLE' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) attempts.push({ attempt, ...await inspectFork(process.argv[2]) });
  console.log(JSON.stringify({ attempts }, null, 2));
  process.exitCode = attempts.every(result => result.evidence === 'ROBINHOOD_MAINNET_FORK') ? 0 : 1;
}
