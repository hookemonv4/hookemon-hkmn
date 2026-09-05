#!/usr/bin/env node
// Read-only, non-blocking watchdog: re-probes the live Robinhood Chain runtime
// bytecode for every contract pinned in bindings/robinhood-chain.json and
// reports whether the live runtime still matches the pinned evidence.
//
// This never mutates state, never signs, never broadcasts, and never exits
// non-zero for an external mismatch or an unreachable RPC endpoint -- a
// pinned binding drifting or an endpoint being briefly unreachable is
// expected, reportable information, not a build failure. It only exits
// non-zero when it cannot even parse its own local input (a genuine
// programmer/config error), matching the fail-closed-on-invariant,
// non-blocking-on-external-fact pattern this script is modeled on
// (see feasibility/verify-robinhood-binding.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { sha256, nowIso } from './lib/util.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function bytesFromHex(value) {
  invariant(HEX_BYTES.test(value ?? ''), 'invalid hex bytes');
  return Buffer.from(value.slice(2), 'hex');
}

function defaultFetch(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(DEFAULT_RPC_TIMEOUT_MS) });
}

async function rpcCall(rpcUrl, method, params, fetchImpl) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  invariant(response.ok, `${method} HTTP ${response.status}`);
  const body = await response.json();
  invariant(!body.error, `${method}: ${body.error?.message ?? 'RPC error'}`);
  return body.result;
}

// Probes one address's live runtime bytecode at the chain head, plus enough
// block context to say whether that head is already finalized. The public
// Robinhood RPC only serves eth_getCode/eth_call state at "latest" (explicit
// older tags and block numbers return "metadata is not found"), so state is
// always read at "latest" with its block hash recorded, never at "finalized"
// directly; eth_getBlockByNumber("finalized") is used only to confirm after
// the fact whether that latest block has since finalized.
export async function probeContractRuntime({ rpcUrl, address, fetchImpl = defaultFetch }) {
  invariant(ADDRESS.test(address ?? ''), 'address must be an EVM address');
  const [latestBlock, finalizedBlock, code] = await Promise.all([
    rpcCall(rpcUrl, 'eth_getBlockByNumber', ['latest', false], fetchImpl),
    rpcCall(rpcUrl, 'eth_getBlockByNumber', ['finalized', false], fetchImpl).catch(() => null),
    rpcCall(rpcUrl, 'eth_getCode', [address, 'latest'], fetchImpl),
  ]);
  const codeBytes = bytesFromHex(code);
  const latestNumber = latestBlock?.number ?? null;
  const finalizedNumber = finalizedBlock?.number ?? null;
  return {
    address: address.toLowerCase(),
    codeSize: codeBytes.length,
    runtimeSha256: sha256(codeBytes),
    hasCode: codeBytes.length > 0,
    probedAtBlockNumber: latestNumber,
    probedAtBlockHash: latestBlock?.hash ?? null,
    finalizedBlockNumber: finalizedNumber,
    finalityConfirmed: Boolean(
      latestNumber && finalizedNumber && BigInt(finalizedNumber) >= BigInt(latestNumber),
    ),
  };
}

// Compares every contract in a bindings manifest (e.g. bindings/robinhood-chain.json)
// against a fresh live probe. Never throws on an individual contract's probe
// failure -- each contract independently reports PASSED, DRIFTED, or
// INTEGRATION_PENDING (probe unreachable/errored) so one bad network call
// never hides every other contract's result.
export async function checkBindingDrift({ manifest, rpcUrl, fetchImpl = defaultFetch }) {
  invariant(manifest && typeof manifest === 'object', 'manifest is required');
  invariant(typeof manifest.chain?.rpcUrl === 'string', 'manifest.chain.rpcUrl is required');
  invariant(manifest.contracts && typeof manifest.contracts === 'object', 'manifest.contracts is required');
  const url = rpcUrl ?? manifest.chain.rpcUrl;
  const names = Object.keys(manifest.contracts).sort();
  invariant(names.length > 0, 'manifest.contracts must name at least one contract');

  const contracts = await Promise.all(names.map(async (name) => {
    const pinned = manifest.contracts[name];
    invariant(ADDRESS.test(pinned?.address ?? ''), `pinned ${name}.address must be an EVM address`);
    try {
      const observed = await probeContractRuntime({ rpcUrl: url, address: pinned.address, fetchImpl });
      const runtimeMatches = typeof pinned.runtimeSha256 === 'string'
        && pinned.runtimeSha256.replace(/^sha256:/, '') === observed.runtimeSha256;
      const sizeMatches = typeof pinned.codeSize !== 'number' || pinned.codeSize === observed.codeSize;
      const status = runtimeMatches && sizeMatches ? 'PASSED' : 'DRIFTED';
      return {
        name,
        address: observed.address,
        status,
        pinnedRuntimeSha256: pinned.runtimeSha256 ?? null,
        observedRuntimeSha256: observed.runtimeSha256,
        pinnedCodeSize: pinned.codeSize ?? null,
        observedCodeSize: observed.codeSize,
        probedAtBlockNumber: observed.probedAtBlockNumber,
        probedAtBlockHash: observed.probedAtBlockHash,
        finalityConfirmed: observed.finalityConfirmed,
      };
    } catch (error) {
      return {
        name,
        address: pinned.address.toLowerCase(),
        status: 'INTEGRATION_PENDING',
        reason: error.message,
      };
    }
  }));

  const drifted = contracts.filter((entry) => entry.status === 'DRIFTED');
  const pending = contracts.filter((entry) => entry.status === 'INTEGRATION_PENDING');
  const status = drifted.length > 0 ? 'DRIFTED' : pending.length > 0 ? 'INTEGRATION_PENDING' : 'PASSED';

  return {
    schemaVersion: 'hookemon.binding-drift.v1',
    observedAt: nowIso(),
    chainId: manifest.chain.chainId ?? null,
    rpcUrl: url,
    status,
    contracts,
  };
}

// Offline mode never fabricates a live result: it honestly marks every
// contract INTEGRATION_PENDING (not probed) rather than faking a PASSED it
// did not earn, matching feasibility/verify-robinhood-binding.mjs's own
// --offline contract (it marks reproducibility unverified, never invents a
// passing reproduction). Use --offline only for CI determinism; run without
// it against a live RPC to get a real drift verdict.
export function buildOfflineReport(manifest) {
  const names = Object.keys(manifest.contracts).sort();
  return {
    schemaVersion: 'hookemon.binding-drift.v1',
    observedAt: nowIso(),
    chainId: manifest.chain?.chainId ?? null,
    rpcUrl: manifest.chain?.rpcUrl ?? null,
    status: 'INTEGRATION_PENDING',
    mode: 'offline',
    reason: 'Offline fixture mode never claims a live drift-free match; run without --offline against a live RPC to confirm PASSED.',
    contracts: names.map((name) => ({
      name,
      address: manifest.contracts[name].address.toLowerCase(),
      status: 'INTEGRATION_PENDING',
      reason: 'not probed: --offline mode performs no live RPC calls',
    })),
  };
}

export function parseInvocation(argv) {
  const args = argv.slice(2);
  let manifestPath = 'bindings/robinhood-chain.json';
  let manifestProvided = false;
  let offline = false;
  for (const arg of args) {
    if (arg === '--offline') {
      invariant(!offline, '--offline may be specified only once');
      offline = true;
    } else {
      invariant(!arg.startsWith('-') && !manifestProvided, 'usage: node scripts/check-binding-drift.mjs [bindings/robinhood-chain.json] [--offline]');
      manifestPath = arg;
      manifestProvided = true;
    }
  }
  return { manifestPath, offline };
}

async function main() {
  const { manifestPath, offline } = parseInvocation(process.argv);
  const manifest = JSON.parse(readFileSync(path.resolve(manifestPath), 'utf8'));
  const report = offline
    ? buildOfflineReport(manifest)
    : await checkBindingDrift({ manifest });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
