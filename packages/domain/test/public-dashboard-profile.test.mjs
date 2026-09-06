import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readPublicDashboardProfile,
  publicDashboardNetwork,
} from "../src/public-dashboard-profile.js";

test("mainnet profile targets Robinhood Chain 4663 and Solana mainnet", () => {
  const profile = readPublicDashboardProfile("mainnet");
  assert.equal(profile.badge, "MAINNET");
  assert.deepEqual(profile.network.evm, { name: "robinhood", chainId: 4663, label: "Robinhood Chain" });
  assert.deepEqual(profile.network.solana, {
    name: "mainnet-beta",
    genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    label: "Solana",
  });
});

test("testnet profile is unchanged Sepolia + Solana devnet", () => {
  const network = publicDashboardNetwork("testnet");
  assert.equal(network.evm.chainId, 11155111);
  assert.equal(network.solana.name, "devnet");
});

test("rejects an unknown profile id", () => {
  assert.throws(() => readPublicDashboardProfile("bogus"), /PUBLIC_DASHBOARD_PROFILE_INVALID/);
});

test("network shape uses evm, not the legacy ethereum key", () => {
  const network = publicDashboardNetwork("mainnet");
  assert.equal(Object.hasOwn(network, "ethereum"), false);
  assert.equal(Object.hasOwn(network, "evm"), true);
});
