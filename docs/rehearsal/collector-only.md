# Collector-only real-money rehearsal

## Purpose and limits

This rehearsal runs Collector Crypt's real `purchase → open → buyback` sequence, then pays the
observed Circle USD proceeds to a fixed list of Solana test wallets. It deliberately skips the
Robinhood-chain funding, outbound, return, and distribution stages.

The rehearsal does **not** prove Robinhood bridging, vault funding or outbound execution, return
bridging, an HKMN holder snapshot or distribution, or hook-fee behavior. It is a Collector Crypt
and Solana payout rehearsal only.

## Configuration

The environment contains no private key:

```sh
export HOOKEMON_STATE_DIR=/absolute/path/to/rehearsal-state
export HOOKEMON_REHEARSAL_MODE=collector-only
export HOOKEMON_COLLECTOR_CRYPT_API_KEY=<collector-crypt-api-key>
export HOOKEMON_PACK_CODE=<code from GET /api/machines, such as the 25 USD machine>
export HOOKEMON_SOLANA_ACCOUNT=<operator-solana-public-key>
export HOOKEMON_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
export HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS=<recipient-1>,<recipient-2>
export HOOKEMON_REHEARSAL_PAYOUT_SPLIT=equal
export HOOKEMON_SIGNER_MODULE=/absolute/path/to/packages/adapters/rehearsal/macos-keychain-solana-signer.mjs
export HOOKEMON_SIGNER_LIVE_MODE=true
export HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG=<available-process-budget>
export HOOKEMON_BUDGET_PACK_PRICE_USDG=<pack-price>
export HOOKEMON_BUDGET_OUTBOUND_CAP_USDG=0
export HOOKEMON_BUDGET_RETURN_CAP_USDG=0
export HOOKEMON_BUDGET_OPERATING_MARGIN_USDG=0
export HOOKEMON_DASHBOARD_PROFILE=mainnet
export HOOKEMON_DASHBOARD_PORT=8787
export HOOKEMON_DASHBOARD_PROXY_CREDENTIAL=<local-dashboard-credential>
```

Store the operator's Solana secret in macOS Keychain:

```sh
security add-generic-password -s hookemon-rehearsal -a operator-solana -w
```

The operator wallet must hold at least the pack price in the Solana stablecoin and enough SOL for transaction fees.
Every recipient wallet must already have an existing Circle USD associated token account and a
small Solana stablecoin balance. The rehearsal never creates recipient token accounts.

## Run procedure

Run a dry-run first:

```sh
node packages/adapters/bin/hookemon-runner.mjs dry-run
```

Confirm that purchase, open, and buyback are configured and that the payout plan contains the
intended recipients and micro-unit amounts. Then start the live runner:

```sh
node packages/adapters/bin/hookemon-runner.mjs run
```

To enable live mode in the dashboard, turn on the **Live mode** toggle, set
`maxBoostersPerCycle=1`, and set `allowedPackIds` to the selected pack code.

What it costs: the selected pack price in the Solana stablecoin, plus Solana transaction fees in SOL.

Read the cycle journal for stage evidence and signatures. The dashboard shows the current cycle,
rehearsal skip evidence, payout status, and the configured public identities; it never displays
secrets or API keys.

## Recovery

If the process stops after broadcasting, restart it or issue the dashboard's reconcile request.
The durable payout attempt is reconciled against Solana signature status and is not signed or
broadcast a second time while it remains pending. Review a finalized failure before starting a new
rehearsal.
