import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { canonicalJson, cloneJson } from './canonical-json.mjs';
import {
  normalizeV4PreflightNonce,
  unresolvedV4RequestPaths,
  validateRecordedV4RequestTemplate,
} from './create-request-materializer.mjs';

const CHAIN_ID = '4663';
const CAIP2 = 'eip155:4663';
const REQUEST_PATH = 'release/phase3/package/create-request.json';
const PROVIDER_DOCUMENTS_PATH = 'release/phase3/admission/provider-documents.json';
const OWNER_INPUTS_PATH = 'decisions/owner-inputs/launch-inputs-owner.json';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function readCommittedFile(root, commit, path) {
  return execFileSync('git', ['-C', root, 'show', `${commit}:${path}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertCapabilitiesMatch(capabilities, pinnedCapabilities) {
  if (String(capabilities?.chain?.id) !== CHAIN_ID) throw new Error('capabilities.chain.id must be 4663');
  if (capabilities?.chain?.caip2 !== CAIP2) throw new Error('capabilities.chain.caip2 must be eip155:4663');
  for (const field of ['chainDeployment', 'chainDeploymentDescriptorDigest', 'profile']) {
    if (pinnedCapabilities?.[field] === null || pinnedCapabilities?.[field] === undefined) {
      throw new Error(`committed provider evidence is missing capabilities.${field}`);
    }
    if (!sameJson(capabilities?.[field], pinnedCapabilities?.[field])) {
      throw new Error(`capabilities.${field} does not match committed provider evidence`);
    }
  }
}

function unixSeconds(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now must be a valid Date');
  return Math.floor(now.getTime() / 1000);
}

/**
 * Checks the provider contract evidence retained in the repository. The
 * provider's full nested schemas were not retained, so this validates the
 * recorded envelope and refuses any unresolved template leaf before a POST.
 */
export function validateV4RequestContract(request, contract, { allowPlaceholders = false } = {}) {
  validateRecordedV4RequestTemplate(request, contract);
  const unresolved = unresolvedV4RequestPaths(request);
  if (!allowPlaceholders && unresolved.length > 0) {
    throw new Error(`request contains unresolved fields: ${unresolved.join(', ')}`);
  }
  return request;
}

/**
 * Applies only values that are live at preflight time to an already committed,
 * materialized request. This avoids fabricating provider-controlled graph data.
 */
export function assembleV4PreflightRequest({
  template,
  contract,
  capabilities,
  pinnedCapabilities,
  launchWallet,
  nonce,
  now = new Date(),
} = {}) {
  assertCapabilitiesMatch(capabilities, pinnedCapabilities);
  validateV4RequestContract(template, contract, { allowPlaceholders: true });
  const request = cloneJson(template);
  request.schemaVersion = 'programmable.custom-launch-create-request.v4';
  request.chainId = CHAIN_ID;
  request.caip2 = CAIP2;
  request.chainDeployment = cloneJson(capabilities.chainDeployment);
  request.chainDeploymentDescriptorDigest = capabilities.chainDeploymentDescriptorDigest;
  request.profile = cloneJson(capabilities.profile);
  request.launchWallet = requiredString(launchWallet, 'launchWallet');
  request.nonce = normalizeV4PreflightNonce(requiredString(nonce, 'nonce'));
  const validAfter = unixSeconds(now);
  request.permitWindow = { validAfter: String(validAfter), deadline: String(validAfter + 900) };
  return validateV4RequestContract(request, contract);
}

function assertPublicSource(root, source) {
  if (source === undefined) return;
  const repositoryUrl = requiredString(source.repositoryUrl, '--repository-url');
  const sourceCommit = requiredString(source.sourceCommit, '--source-commit');
  const sourceTree = requiredString(source.sourceTree, '--source-tree');
  const parsed = new URL(repositoryUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('--repository-url must be a public HTTPS repository URL without credentials');
  }
  const commit = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (git(root, ['rev-parse', sourceCommit]) !== commit) throw new Error('--source-commit must resolve to HEAD');
  const sourceTreePath = resolve(sourceTree);
  if (sourceTree !== tree && sourceTreePath !== resolve(root)) {
    throw new Error('--source-tree must be HEAD^{tree} or the repository root');
  }
}

export function loadCommittedPreflightPackage(root, { source } = {}) {
  assertPublicSource(root, source);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', `${commit}^{tree}`]);
  const providerDocuments = JSON.parse(readCommittedFile(root, commit, PROVIDER_DOCUMENTS_PATH));
  const ownerInputs = JSON.parse(readCommittedFile(root, commit, OWNER_INPUTS_PATH));
  const pinnedCapabilities = providerDocuments.capabilities;
  if (pinnedCapabilities === null || typeof pinnedCapabilities !== 'object') {
    throw new Error('committed provider evidence does not contain capabilities');
  }
  let templateSource;
  try {
    templateSource = readCommittedFile(root, commit, REQUEST_PATH);
  } catch {
    throw new Error('graphBundle.targets[0].applicantSalt cannot be derived from committed evidence; release/phase3/package/create-request.json is required');
  }
  const template = JSON.parse(templateSource);
  validateV4RequestContract(template, providerDocuments.v4RequestContract, { allowPlaceholders: true });
  const launchWallet = requiredString(ownerInputs?.launchWallet?.address, 'launchWallet');
  return {
    commit,
    tree,
    providerDocuments,
    pinnedCapabilities,
    contract: providerDocuments.v4RequestContract,
    template,
    launchWallet,
    packageDigest: sha256(templateSource),
  };
}

export const PROGRAMMABLE_API_BASE_URL = process.env.PROGRAMMABLE_API_BASE_URL || 'https://api.programmable.market';
export const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
