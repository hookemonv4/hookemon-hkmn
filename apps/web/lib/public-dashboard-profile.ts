export type DashboardProfileId = "testnet" | "mainnet";

export type DashboardNetwork = {
  ethereum: {
    name: "sepolia" | "mainnet";
    chainId: 11155111 | 1;
    label: "Sepolia" | "Ethereum";
  };
  solana: {
    name: "devnet" | "mainnet-beta";
    genesisHash:
      | "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
      | "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    label: "Solana Devnet" | "Solana";
  };
};

export type PublicTransactionReference =
  | {
      chain: "ethereum";
      purpose: "outbound-burn" | "inbound-finalization" | "reward-settlement";
      id: string;
    }
  | {
      chain: "solana";
      purpose: "outbound-mint" | "inbound-burn" | "collector-purchase" | "collector-buyback";
      id: string;
    };

const PROFILES = {
  testnet: {
    id: "testnet",
    badge: "TESTNET",
    network: {
      ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
      solana: {
        name: "devnet",
        genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        label: "Solana Devnet",
      },
    },
    explorers: {
      ethereum: "https://sepolia.etherscan.io",
      solana: "https://explorer.solana.com",
      solanaCluster: "devnet",
    },
  },
  mainnet: {
    id: "mainnet",
    badge: "MAINNET",
    network: {
      ethereum: { name: "mainnet", chainId: 1, label: "Ethereum" },
      solana: {
        name: "mainnet-beta",
        genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        label: "Solana",
      },
    },
    explorers: {
      ethereum: "https://etherscan.io",
      solana: "https://explorer.solana.com",
      solanaCluster: null,
    },
  },
} as const;

export function readDashboardProfile(value: unknown) {
  if (typeof value !== "string" || !Object.hasOwn(PROFILES, value)) {
    throw new TypeError("PUBLIC_DASHBOARD_PROFILE_INVALID");
  }
  return structuredClone(PROFILES[value as DashboardProfileId]);
}

export function dashboardExplorerHref(
  profile: unknown,
  reference: PublicTransactionReference,
): string {
  const selected = readDashboardProfile(profile);
  if (!validTransactionReference(reference)) {
    throw new TypeError("PUBLIC_DASHBOARD_TRANSACTION_INVALID");
  }

  const origin = selected.explorers[reference.chain];
  const url = new URL(`/tx/${encodeURIComponent(reference.id)}`, origin);
  if (reference.chain === "solana" && selected.explorers.solanaCluster !== null) {
    url.searchParams.set("cluster", selected.explorers.solanaCluster);
  }
  return url.toString();
}

function validTransactionReference(value: unknown): value is PublicTransactionReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).length !== 3 ||
    !("chain" in source) ||
    !("purpose" in source) ||
    !("id" in source)
  ) return false;

  if (source.chain === "ethereum") {
    return (
      new Set(["outbound-burn", "inbound-finalization", "reward-settlement"]).has(String(source.purpose)) &&
      typeof source.id === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(source.id)
    );
  }
  return (
    source.chain === "solana" &&
    new Set(["outbound-mint", "inbound-burn", "collector-purchase", "collector-buyback"])
      .has(String(source.purpose)) &&
    typeof source.id === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(source.id)
  );
}
