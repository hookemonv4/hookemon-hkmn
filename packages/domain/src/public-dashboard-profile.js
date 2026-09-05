// Network/profile shape mirrors the authoritative packages/dashboard/src/contracts/dashboard-profile.mjs:
// "mainnet" targets the Robinhood Chain / USDG product, not EVM mainnet / Circle USDC.
const PROFILES = Object.freeze({
  testnet: Object.freeze({
    id: "testnet",
    badge: "TESTNET",
    network: Object.freeze({
      evm: Object.freeze({ name: "sepolia", chainId: 11155111, label: "Sepolia" }),
      solana: Object.freeze({
        name: "devnet",
        genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        label: "Solana Devnet",
      }),
    }),
  }),
  mainnet: Object.freeze({
    id: "mainnet",
    badge: "MAINNET",
    network: Object.freeze({
      evm: Object.freeze({ name: "robinhood", chainId: 4663, label: "Robinhood Chain" }),
      solana: Object.freeze({
        name: "mainnet-beta",
        genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        label: "Solana",
      }),
    }),
  }),
});

export function readPublicDashboardProfile(value) {
  if (typeof value !== "string" || !Object.hasOwn(PROFILES, value)) {
    throw new TypeError("PUBLIC_DASHBOARD_PROFILE_INVALID");
  }
  return structuredClone(PROFILES[value]);
}

export function publicDashboardNetwork(value) {
  return readPublicDashboardProfile(value).network;
}
