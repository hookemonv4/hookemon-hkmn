# Rehearsal and recovery

Use this runbook on the owner-approved Mac only. It covers a bounded rehearsal and repository
recovery. It does not authorize deployment, funding, a new signer identity, or a transaction that
the policy engine has refused.

## Configuration

Use Node v24.19.0. Keep the environment file outside the repository and replace every angle-bracket
value with a pinned public value before sourcing it. Atomic amounts are integer strings. USDG on
chain 4663 and the Solana settlement asset are different assets; do not convert one into the other
in this file.

```sh
export HOOKEMON_STATE_DIR="$HOME/Library/Application Support/hookemon"
export HOOKEMON_WORKER_OWNER=hookemon-runner
export HOOKEMON_LEASE_TTL_MS=90000

# The runner supports one network profile: mainnet chain 4663.
export HOOKEMON_CHAIN_ID=4663
export HOOKEMON_ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export HOOKEMON_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
export HOOKEMON_OBSERVABILITY_CONFIG_PATH="$HOME/Library/Application Support/hookemon/observability.json"

# The two Operations identities are public identifiers, never key material.
export HOOKEMON_EVM_ACCOUNT=<operations-evm-public-address>
export HOOKEMON_SOLANA_ACCOUNT=<operations-solana-public-address>
export HOOKEMON_SIGNER_BACKEND=keychain
export HOOKEMON_SIGNER_LIVE_MODE=true
export HOOKEMON_KEYCHAIN_COMMAND="$PWD/packages/adapters/bin/hookemon-keychain-signer.mjs"
export HOOKEMON_KEYCHAIN_EVM_ACCOUNT=operator-evm
export HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT=operator-solana

# USDG identity and decimals come from the frozen chain binding. The Solana mint is explicit.
export HOOKEMON_RELAY_BASE_URL=https://api.relay.link
export HOOKEMON_RELAY_SOLANA_MINT=<pinned-solana-stablecoin-mint>
export HOOKEMON_RELAY_EVM_DEPOSITORY=<pinned-relay-evm-depository>
export HOOKEMON_VAULT_ADDRESS=<pinned-vault-address>
export HOOKEMON_HOOK_ADDRESS=<pinned-hook-address>
export HOOKEMON_COLLECTOR_CRYPT_BASE_URL=https://gacha.collectorcrypt.com
export HOOKEMON_RELAY_API_KEY=<approved-secret-source>
export HOOKEMON_COLLECTOR_CRYPT_API_KEY=<approved-secret-source>
export HOOKEMON_PROVIDER_MODE=live

# Policy values are atomic USDG or native-asset amounts, never display amounts.
export HOOKEMON_PACK_CODE=collector-25
export HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG=25000000
export HOOKEMON_BUDGET_PACK_PRICE_USDG=25000000
export HOOKEMON_BUDGET_OUTBOUND_CAP_USDG=25000000
export HOOKEMON_BUDGET_RETURN_CAP_USDG=25000000
export HOOKEMON_BUDGET_OPERATING_MARGIN_USDG=<approved-operating-margin-atomic>
export HOOKEMON_MIN_ROBINHOOD_RECEIVE=<approved-evm-minimum-atomic>
export HOOKEMON_MIN_SOLANA_RECEIVE=<approved-solana-minimum-atomic>
export HOOKEMON_MIN_RETURN_USDG=0
export HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD=<approved-evm-gas-envelope-atomic>
export HOOKEMON_NATIVE_GAS_CAP_SOLANA=<approved-solana-gas-envelope-atomic>
```

Set `HOOKEMON_RELAY_API_KEY` and `HOOKEMON_COLLECTOR_CRYPT_API_KEY` through the approved secret
source. The placeholders above are names only. Do not put either value in a shell history, this
runbook, a journal, or a support request.

The production profile requires `HOOKEMON_PROVIDER_MODE=live` and rejects
`HOOKEMON_REHEARSAL_MODE`, `HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS`,
`HOOKEMON_REHEARSAL_PAYOUT_SPLIT`, `HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT`, and fake providers. A
rehearsal command requires an explicit rehearsal provider mode and rejects production-only provider
wiring. Do not source a production environment and add rehearsal variables to it. The runner selects
the profile with `--mode` and records that immutable mode in each cycle journal.

At start, the runner validates every required field, replays repository integrity, reads
`eth_chainId` from the configured EVM RPC and requires `4663`, probes both Keychain identities, and runs the canary preflight before it
constructs a transaction-capable signer. `observability.json` must be the approved WP14 object and
must require the two signer roles plus EVM and Solana RPC checks. A failed check is a stop
condition, not a reason to remove the check.

The Keychain command refuses every live signing request that lacks its pinned transaction policy and
trusted decode context. If it reports that condition, stop there. Do not change
`HOOKEMON_SIGNER_LIVE_MODE` to bypass the refusal; correct the request-policy integration and repeat
the readiness checks.

## First rehearsal

The first rehearsal is one Collector pack capped at 25 USDG. `25000000` is 25 USDG at six decimals.
Set the rehearsal-only values in a separate environment file. The proceeds account is a distinct
Solana public account: it must differ from `HOOKEMON_SOLANA_ACCOUNT` and every payout recipient.

```sh
export HOOKEMON_PROVIDER_MODE=fake
export HOOKEMON_SIGNER_LIVE_MODE=false
export HOOKEMON_REHEARSAL_MODE=collector-only
export HOOKEMON_REHEARSAL_PROCEEDS_ACCOUNT=<dedicated-solana-proceeds-account>
export HOOKEMON_REHEARSAL_PAYOUT_RECIPIENTS=<payout-recipient-1>,<payout-recipient-2>
export HOOKEMON_REHEARSAL_PAYOUT_SPLIT=equal

# A sealed fake profile must not inherit production bridge, contract, or provider credentials.
unset HOOKEMON_RELAY_API_KEY
unset HOOKEMON_RELAY_EVM_DEPOSITORY
unset HOOKEMON_VAULT_ADDRESS
unset HOOKEMON_HOOK_ADDRESS
unset HOOKEMON_COLLECTOR_CRYPT_API_KEY
```

Then run the bounded collector path with restart injection:

```sh
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node packages/adapters/bin/hookemon-runner.mjs run \
  --mode rehearsal \
  --cycles 1 \
  --cap-usdg 25000000 \
  --collector-only \
  --restart-inject
```

The command uses the same cycle runner and durable repository as production. `--collector-only`
uses sealed fake Relay and Collector providers; it never contacts a live provider. Its evidence
proves journal recovery and no duplicate fake effect, not live provider finality. With
`--restart-inject`, a supervisor records the bounded session below the state directory, launches a
worker, and launches a fresh worker after each durable response-recorded effect boundary. The
session retains the requested cycle count, cap, completed evidence paths, and restart count across
worker exits. Evidence is sealed before the cycle is archived and an interrupted session repairs a
missing immutable evidence file from the linked completed cycle.

The policy engine still applies the cap and pause controls. If a first-cycle approval is missing,
the command prints `AWAITING_MANUAL_APPROVAL` with the exact `cycleId` and `policyDigest`. Submit
that digest through the approved operator-control manual-approval path, then use `resume <cycleId>`.
After that cycle completes, rerun the exact bounded `run --mode rehearsal ... --restart-inject`
command. It repairs the linked session's evidence record and starts only its remaining requested
cycles. Do not approve a reconstructed or edited digest.

Live rehearsal is currently refused before signer construction. The generic live stages do not yet
produce the required dedicated Solana proceeds projection and finalized account-level evidence. Use
the collector-only rehearsal for this runbook; production remains a separate, explicitly selected
mode.

The terminal reports the selected mode, cycle ID, restart boundaries, and the path of one evidence
JSON file per completed cycle under the state directory. Each evidence file must contain a unique
cycle ID, finalized attributable deltas, classified residuals, exact payout conservation, and proof
that no irreversible effect ran twice. The collector-only fake path records synthetic
reconciliation evidence only. Its dedicated Solana proceeds account is distinct from Operations and
every payout recipient; an Operations wallet-wide balance is not acceptable evidence.

Stop immediately if a configuration field is named in an error, either Keychain probe fails, a
canary reports drift, manual approval is absent, a delta is not finalized and attributable, a
residual is unclassified, evidence fails conservation, or an irreversible effect is unresolved.

## Recovery commands

These commands read the CycleRepository. They do not create a replacement cycle, load a provider,
or construct a signer merely to report status.

```sh
# Inspect the active cycle, or one recorded cycle.
node packages/adapters/bin/hookemon-runner.mjs status --cycle <cycle-id>

# Resume only after the journal permits recovery.
node packages/adapters/bin/hookemon-runner.mjs resume <cycle-id>

# Record an explicit stop with a concise, factual reason.
node packages/adapters/bin/hookemon-runner.mjs abort-cycle <cycle-id> --reason "provider reconciliation failed"
```

`status` reports the persisted mode, provider profile, stages, attempts, and custody facts. The bounded rehearsal
command prints evidence paths after it writes them. Before `resume`, inspect every attempt. A
`SENT_UNKNOWN` provider attempt or a `SIGNED` chain attempt that
has not reached finality must be reconciled from its recorded request, bytes, digest, and chain or
provider evidence. The runner refuses a new signature, nonce, blockhash, or provider mutation while
such an attempt remains unresolved. `abort-cycle` records the requested terminal action and reason;
it does not erase a journal, reclaim an attempted send, or make an uncertain effect safe.

After a process restart, use `status` first. If the repository reports a lease held by another
runner, leave that runner alone and investigate its liveness before attempting recovery. If the
cycle is held for custody, policy, or data evidence, correct the named fact and use the normal
owner decision path. Never edit a journal or evidence JSON to make a cycle resumable.

## Production boundary

Production uses `--mode production` with live providers and the same durable runner. It rejects
rehearsal flags and fake-provider configuration before startup. The first three production cycles
require manual approval. The onchain claim window is six hours; do not treat a local scheduler
interval as permission to claim outside that window.
