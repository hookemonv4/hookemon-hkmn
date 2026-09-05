# Production environment checklist

Every variable below is read by `packages/adapters/src/app/environment.mjs` (allow-listed; an
unknown `HOOKEMON_*` variable fails startup). Values are configuration, never derived. Keep the
file outside the repository (for example `~/hookemon-production.env`) and `source` it before
`node packages/adapters/bin/hookemon-runner.mjs run`.

The rehearsal file (`docs/rehearsal/collector-only.md`) is a separate file. It must not be
sourced for production: `HOOKEMON_REHEARSAL_MODE` and `HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS`
must be absent, otherwise the runner skips the Robinhood stages and pays fixed Solana wallets.
The repository ships no default wallets; every address below has to be supplied.

## Wallet and identity roles

| Role | Variable | Chain | Holds keys on the runner machine? | Purpose |
| --- | --- | --- | --- | --- |
| Treasury | `HOOKEMON_TREASURY_ADDRESS` | Robinhood (EVM) | No. Hardware wallet. | Fee beneficiary of the hook (2.5 % swap fee), excluded from the holder snapshot, refills the operator wallets. |
| Vault | `HOOKEMON_VAULT_ADDRESS` | Robinhood (EVM) | No, contract. | Per-cycle custody, outbound/return, Merkle payout root. |
| Hook | `HOOKEMON_HOOK_ADDRESS` | Robinhood (EVM) | No, contract. | Deployed Uniswap v4 hook. |
| HKMN token | `HOOKEMON_HKMN_ADDRESS`, `HOOKEMON_HKMN_DEPLOY_BLOCK` | Robinhood (EVM) | No, contract. | Holder snapshot source (`Transfer` logs from the deploy block). |
| Pool | `HOOKEMON_POOL_ADDRESS` | Robinhood (EVM) | No, contract. | Pool-adjacent custody excluded from the snapshot until the binding file carries it. |
| EVM operator | `HOOKEMON_EVM_ACCOUNT` | Robinhood (EVM) | Yes, hot key with cycle budget only. | Authorizes funding, signs cycle actions. |
| Operations trigger | `HOOKEMON_OPERATIONS_TRIGGER_ACCOUNT` | Robinhood (EVM) | Yes, separate key, never the same as the EVM operator. | Signs `executeOutbound` / `fundPayoutFromPegCycle`. |
| Distribution signer | `HOOKEMON_DISTRIBUTION_SIGNER_ADDRESS` | Robinhood (EVM) | Separate process or device. | First EIP-712 signature on a payout root (`HOOKEMON_DISTRIBUTION_PROFILE=production`). |
| Distribution verifier | `HOOKEMON_DISTRIBUTION_VERIFIER_ADDRESS` | Robinhood (EVM) | Separate process (`bin/hookemon-verifier.mjs`). | Second, independent signature. |
| Solana operator (bot) | `HOOKEMON_SOLANA_ACCOUNT` | Solana | Yes, hot key with the daily pack budget only. | Buys, opens and sells packs on Collector Crypt; receives the Solana stablecoin proceeds that are bridged. |
| Relay | `HOOKEMON_RELAY_BASE_URL`, `HOOKEMON_RELAY_API_KEY` | Bridge | API key only. | Robinhood <-> Solana bridge. |
| Collector Crypt | `HOOKEMON_COLLECTOR_CRYPT_BASE_URL`, `HOOKEMON_COLLECTOR_CRYPT_API_KEY` | Solana | API key only. | Pack catalog, buy, open, buyback. |

Rules that the runner enforces: the EVM operator and the operations trigger must differ; the
distribution signer and verifier are required together when the profile is `production` and never
fall back to fixture keys; a holder without a usable payout account is never replaced by an
auto-created account and never redirected.

## Runner and signer

```bash
export HOOKEMON_STATE_DIR=/absolute/path/to/production-state
export HOOKEMON_CHAIN_ID=4663
export HOOKEMON_ROBINHOOD_RPC_URL=<robinhood rpc>
export HOOKEMON_SOLANA_RPC_URL=<solana mainnet rpc>
# Signer: either an external module (the rehearsal used
# packages/adapters/rehearsal/macos-keychain-solana-signer.mjs, Solana only) ...
export HOOKEMON_SIGNER_BACKEND=external-module
export HOOKEMON_SIGNER_MODULE=/absolute/path/to/signer-module.mjs
# ... or the keychain backend: an absolute path to a signing tool that speaks the JSON line
# protocol in packages/adapters/src/signing/keychain-signer.mjs (not the macOS `security` binary).
# export HOOKEMON_SIGNER_BACKEND=keychain
# export HOOKEMON_KEYCHAIN_COMMAND=/absolute/path/to/signing-tool
# export HOOKEMON_KEYCHAIN_EVM_ACCOUNT=<account label>
# export HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT=<account label>
export HOOKEMON_SIGNER_LIVE_MODE=false             # true only for the real launch
export HOOKEMON_STANDING_AUTHORITY_PATH=<owner-signed document>
export HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH=<owner public key>
export HOOKEMON_DISTRIBUTION_DIR=/absolute/path/shared/with/verifier
export HOOKEMON_DISTRIBUTION_PROFILE=production
```

## Budgets and floors (atomic USDG decimal strings)

```bash
export HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG=
export HOOKEMON_BUDGET_PACK_PRICE_USDG=
export HOOKEMON_BUDGET_OUTBOUND_CAP_USDG=
export HOOKEMON_BUDGET_RETURN_CAP_USDG=
export HOOKEMON_BUDGET_OPERATING_MARGIN_USDG=
export HOOKEMON_MIN_ROBINHOOD_RECEIVE=
export HOOKEMON_MIN_SOLANA_RECEIVE=
export HOOKEMON_MIN_RETURN_USDG=
export HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD=
export HOOKEMON_NATIVE_GAS_CAP_SOLANA=
```

The dashboard's own per-pack, per-cycle and 24h caps are stored in the operator state and entered
in USD on the operator page; they apply in addition to these process budgets.

## Dashboard

```bash
export HOOKEMON_DASHBOARD_PROFILE=mainnet
export HOOKEMON_DASHBOARD_PORT=8787
export HOOKEMON_DASHBOARD_PROXY_CREDENTIAL=$(openssl rand -hex 32)   # generate once, keep in the env file
```

The credential is a local page password, not a key. Losing it costs nothing: generate a new one,
update the env file, restart the runner.

## Before the first live cycle

- `HOOKEMON_REHEARSAL_MODE` is unset and the operator page shows `PRODUCTION (HKMN holders)`.
- Treasury, vault, hook, HKMN, pool, both EVM identities, both distribution identities and the
  relay show as configured on the operator page's identity table.
- A full dry-run cycle (`HOOKEMON_SIGNER_LIVE_MODE=false`, dashboard `DRY RUN`) completes.
- The bot wallets hold only the budget for the day; the treasury key is not on the runner machine.
