import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardExplorerHref,
  readDashboardProfile,
} from "../lib/public-dashboard-profile.ts";

test("constructs only canonical explorer transaction URLs", () => {
  assert.equal(
    dashboardExplorerHref("testnet", {
      chain: "ethereum",
      purpose: "reward-settlement",
      id: `0x${"ab".repeat(32)}`,
    }),
    `https://sepolia.etherscan.io/tx/0x${"ab".repeat(32)}`,
  );
  assert.equal(
    dashboardExplorerHref("testnet", {
      chain: "solana",
      purpose: "collector-purchase",
      id: "4Nd1mY9YvS7FcQxwY8K9eVx4PKoC4pR8E2FqvM8gM4fY",
    }),
    "https://explorer.solana.com/tx/4Nd1mY9YvS7FcQxwY8K9eVx4PKoC4pR8E2FqvM8gM4fY?cluster=devnet",
  );
  assert.equal(
    dashboardExplorerHref("mainnet", {
      chain: "solana",
      purpose: "outbound-mint",
      id: "4Nd1mY9YvS7FcQxwY8K9eVx4PKoC4pR8E2FqvM8gM4fY",
    }),
    "https://explorer.solana.com/tx/4Nd1mY9YvS7FcQxwY8K9eVx4PKoC4pR8E2FqvM8gM4fY",
  );
});

test("rejects profile and transaction injection", () => {
  for (const profile of [undefined, "production", "MAINNET", "mainnet?redirect=evil"]) {
    assert.throws(() => readDashboardProfile(profile), /PUBLIC_DASHBOARD_PROFILE_INVALID/);
  }
  assert.throws(
    () => dashboardExplorerHref("testnet", {
      chain: "ethereum",
      purpose: "reward-settlement",
      id: "https://evil.example",
    }),
    /PUBLIC_DASHBOARD_TRANSACTION_INVALID/,
  );
  assert.throws(
    () => dashboardExplorerHref("testnet", {
      chain: "solana",
      purpose: "reward-settlement",
      id: "4Nd1mY9YvS7FcQxwY8K9eVx4PKoC4pR8E2FqvM8gM4fY",
    }),
    /PUBLIC_DASHBOARD_TRANSACTION_INVALID/,
  );
});
