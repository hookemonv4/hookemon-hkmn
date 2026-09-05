const PROFILES = Object.freeze({
  testnet: Object.freeze({
    id: "testnet",
    badge: "TESTNET",
    network: Object.freeze({
      ethereum: Object.freeze({ name: "sepolia", chainId: 11155111, label: "Sepolia" }),
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
      ethereum: Object.freeze({ name: "mainnet", chainId: 1, label: "Ethereum" }),
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
