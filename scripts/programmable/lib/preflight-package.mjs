import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const CHAIN_ID = '4663';
const PACKAGE_PATHS = Object.freeze([
  'release/phase3/package/graph-draft.json',
  'release/phase3/package/package-manifest.json',
  'release/phase3/admission/provider-documents.json',
]);

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function readCommittedFile(root, commit, path) {
  return execFileSync('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: 'utf8' });
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function loadCommittedPreflightPackage(root) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', `${commit}^{tree}`]);
  const packageTree = git(root, ['rev-parse', `${commit}:release/phase3/package`]);
  const [graphDraftSource, packageManifestSource, providerDocumentsSource] = PACKAGE_PATHS
    .map((path) => readCommittedFile(root, commit, path));
  const graphDraft = JSON.parse(graphDraftSource);
  const packageManifest = JSON.parse(packageManifestSource);
  const providerDocuments = JSON.parse(providerDocumentsSource);
  if (sha256(graphDraftSource) !== packageManifest.graphDraftSha256) {
    throw new Error('the committed graph draft does not match its package manifest digest');
  }
  const profile = providerDocuments.capabilities?.profile;
  if (!profile?.structuralProfileId || !profile.profileDigest) {
    throw new Error('the committed provider evidence does not contain a preflight profile');
  }

  const expected = {
    profile: {
      structuralProfileId: profile.structuralProfileId,
      profileDigest: profile.profileDigest,
    },
    roots: {
      commit,
      tree,
      packageTree,
      packageManifestSha256: sha256(packageManifestSource),
    },
    digests: {
      graphDraftSha256: packageManifest.graphDraftSha256,
      addressManifestSha256: packageManifest.inputDigests.addressManifestSha256,
      launchInputsSha256: packageManifest.inputDigests.launchInputsSha256,
    },
    caller: graphDraft.seed.permit2Allowance.owner,
    deployer: graphDraft.chain.graphFactory,
    graphTransaction: {
      chainId: CHAIN_ID,
      to: graphDraft.chain.router,
      value: '0',
    },
    seedTransaction: {
      permit2Allowance: {
        chainId: CHAIN_ID,
        assetId: 'usdg-4663',
        decimals: 6,
        amountAtomic: '240000000',
      },
      refundDestination: graphDraft.seed.refundAndDust.intendedDestination,
      maximumDeadlineSeconds: graphDraft.seed.deadlinePolicy.maximumSecondsAfterWalletConfirmation,
    },
  };

  return {
    commit,
    tree,
    packageTree,
    graphDraft,
    packageManifest,
    expected,
    request: {
      schemaVersion: 'hookemon.programmable-preflight-request.v1',
      chainId: CHAIN_ID,
      committedPackage: {
        commit,
        tree,
        packageTree,
        graphDraft,
        packageManifest,
      },
      expected,
    },
  };
}

export const PROGRAMMABLE_API_BASE_URL = 'https://api.programmable.market';
