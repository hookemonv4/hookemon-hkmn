// Clean-room re-implementation of the hookemon.com website's dashboard profile contract
// (readSet: apps/web/lib/public-dashboard-profile.ts on the legacy codex/mainnet-cycle-canary
// branch). Two profiles: "testnet" (Sepolia + Solana devnet, unchanged from the legacy site) and
// "mainnet", which this package's coordinator directives redefine for the Robinhood Chain / USDG
// product instead of EVM mainnet / Circle USD:
//
//   network.evm = { name: 'robinhood', chainId: 4663, label: 'Robinhood Chain' }
//   network.solana   = { name: 'mainnet-beta', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
//                         label: 'Solana' }
//
// This exact shape is a PLACEHOLDER_OWNER_DECISION only in the sense that WP-18 (website
// integration, not yet built at this package's integration head) must adopt the identical shape in
// its own copy of this file when it re-homes the site; it is not placeholder in the sense of being
// arbitrary — it is the shape the WP-17/WP-18 coordinator notes settle on. See docs/modules/dashboard.md.
const PROFILES = {
  testnet: {
    id: 'testnet',
    badge: 'TESTNET',
    network: {
      evm: { name: 'sepolia', chainId: 11155111, label: 'Sepolia' },
      solana: {
        name: 'devnet',
        genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        label: 'Solana Devnet',
      },
    },
    explorers: {
      evm: 'https://sepolia.etherscan.io',
      solana: 'https://explorer.solana.com',
      solanaCluster: 'devnet',
    },
  },
  mainnet: {
    id: 'mainnet',
    badge: 'MAINNET',
    network: {
      evm: { name: 'robinhood', chainId: 4663, label: 'Robinhood Chain' },
      solana: {
        name: 'mainnet-beta',
        genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        label: 'Solana',
      },
    },
    explorers: {
      // docs.robinhood.com does not publish a public block-explorer origin for Robinhood Chain as of
      // this writing; WP-18 must confirm the exact explorer origin when it re-homes the website. This
      // value is never sent in a dashboard API response (see dashboardExplorerHref below), so it never
      // reaches a validator that would fail on it.
      evm: 'https://explorer.robinhood.com',
      solana: 'https://explorer.solana.com',
      solanaCluster: null,
    },
  },
};

export function readDashboardProfile(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PROFILES, value)) {
    throw new TypeError('PUBLIC_DASHBOARD_PROFILE_INVALID');
  }
  return structuredClone(PROFILES[value]);
}

const evmTransactionPurposes = new Set(['outbound-burn', 'inbound-finalization', 'reward-settlement']);
const solanaTransactionPurposes = new Set([
  'outbound-mint',
  'inbound-burn',
  'collector-purchase',
  'collector-buyback',
]);

export function validTransactionReference(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value;
  if (
    Object.keys(source).length !== 3
    || !('chain' in source)
    || !('purpose' in source)
    || !('id' in source)
  ) return false;

  if (source.chain === 'evm') {
    return (
      evmTransactionPurposes.has(String(source.purpose))
      && typeof source.id === 'string'
      && /^0x[0-9a-fA-F]{64}$/.test(source.id)
    );
  }
  return (
    source.chain === 'solana'
    && solanaTransactionPurposes.has(String(source.purpose))
    && typeof source.id === 'string'
    && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(source.id)
  );
}

export function dashboardExplorerHref(profile, reference) {
  const selected = readDashboardProfile(profile);
  if (!validTransactionReference(reference)) {
    throw new TypeError('PUBLIC_DASHBOARD_TRANSACTION_INVALID');
  }
  const origin = selected.explorers[reference.chain];
  const url = new URL(`/tx/${encodeURIComponent(reference.id)}`, origin);
  if (reference.chain === 'solana' && selected.explorers.solanaCluster !== null) {
    url.searchParams.set('cluster', selected.explorers.solanaCluster);
  }
  return url.toString();
}
