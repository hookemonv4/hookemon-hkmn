# packages/adapters

`packages/adapters` is the only npm-dependent package in this repository. `packages/contracts` and
`packages/runner` stay dependency-free (Node 24 builtins only, hash-pinned and auditable byte for
byte); this package exists specifically to isolate the two libraries that real EVM and Solana chain
interaction requires: `viem` (EVM RPC calls, ABI encoding, transaction construction) and
`@solana/web3.js` (Solana RPC calls, transaction construction).

## Boundary

- `packages/adapters` may depend on pinned npm packages with a lockfile. Nothing else in this
  repository may.
- The runner core (`packages/runner/src/{cycle,distribution,operator}`) talks to this package only
  through a narrow, dependency-injected seam (an injected `signerClient` with `sign`/`broadcast`
  methods, supplied at runtime by the operator's own infrastructure). The runner's own test suite
  runs with zero installs; it never imports this package directly.
- The application process in this package holds no key material. The Operations wallet commands use
  short-lived child processes for the narrow Keychain generation, readiness, and signing boundary;
  those children clear known secret buffers before exiting. `viem`/`@solana/web3.js` construct and
  encode transactions; a compromised or vulnerable transitive dependency here cannot move funds on
  its own, because every mutation still goes through the same schema-bound authorization checks
  every other caller does before a signer is ever invoked.

## Dependencies

Exact versions, pinned in `package.json` and locked in `package-lock.json`
(`lockfileVersion` 3, every entry carries an `integrity` field):

- `viem` `2.56.3`
- `@solana/web3.js` `1.98.4`

Install with `npm ci --ignore-scripts` (no lifecycle scripts run). `scripts/verify-control-dependencies.mjs`
verifies the lockfile format and the exact pinned dependency set against `product/dependency-pins.json`.

## Production composition root (`src/app/`, `bin/hookemon-runner.mjs`)

`src/app/` wires the real scheduler and automation service
(`packages/runner/src/scheduler/scheduler.mjs`,
`packages/runner/src/automation/automated-cycle-service.mjs`), and — in the same process, sharing the
same durable cycle repository and operator state file — the dashboard control service
(`packages/dashboard`), to a durable cycle repository, an on-disk exclusive lease, and this package's
provider adapters, into one runnable process:

- `src/app/environment.mjs` — reads configuration from `HOOKEMON_*` environment variables (an exact
  allow-list; unknown `HOOKEMON_*` variables are refused) and, only via `HOOKEMON_SIGNER_MODULE`, an
  operator-supplied signer module path — the one place real key material can enter the process,
  loaded the same way `packages/runner/src/distribution/distribution-signer.mjs`'s
  `loadSignerClient` already loads the distribution-signer/verifier roles. Nothing is ever read from
  a file inside this repository.
- `src/app/cycle-repository.mjs` — adapts WP-27's `DurableCycleStore`
  (`packages/runner/src/cycle/durable-store.mjs`) to the `cycleRepository` seam
  `AutomatedCycleService` requires (`readActiveCycle/createCycle/readStage/prepareStage/
  completeStage/completeCycle`), as its own independent, hash-chained, crash-safe journal — see its
  header comment for exactly why it does not (and today cannot) drive `CycleRunner` itself.
- `src/app/lease-store.mjs` — a synchronous, atomically-written, single-process-safe on-disk
  `leaseStore` for `packages/runner/src/automation/exclusive-lease.mjs`.
- `src/app/stage-driver.mjs` — a thin dispatcher over `src/app/stages/*.mjs`, one module per
  automation stage, each with a real read-only probe (dry run, `liveMode: false`) and a real live
  mutation (`liveMode: true`) for every one of the eight stages, as of WP-36: `funding`/`outbound`/
  `payout` build real `PegCycleVault`/hook calldata (`hook-contract-client.mjs`), sign it with the
  operator EVM signer client, and broadcast it through `robinhood-rpc.mjs`; `purchase`/`open` are
  Collector Crypt gacha-API calls (`open` independently deriving the opened card's mint from the
  open transaction's own post-token-balance state); `buyback` reads that mint and signs/submits the
  real buyback transaction, independently reconciled via `solana-rpc.mjs`; `return` bridges the
  refund token account's real balance back via Relay, signed and broadcast with the operator Solana
  signer client; `distribution` builds a real, finalized-block-anchored HKMN holder snapshot,
  excluding the complete holder-exclusion set `buildHolderExclusionSet` derives (WP-37: vault, hook,
  pool manager, canonical pool, the pinned Programmable beneficiary, the treasury, every prior
  cycle's own return escrow, the zero address, and any operator-supplied exclusions — recorded in
  full alongside the compiled manifest), compiles a real Merkle-sum manifest, and waits for the
  separate `bin/hookemon-verifier.mjs` process's own receipt. No stage refuses unconditionally any
  more — see `docs/modules/composition-root.md` for the exact per-stage "durably happened" contract
  and what remains genuinely unimplemented (a deployed vault/hook, a launched HKMN token).
- **Operator signer-client contract this package's stage modules rely on** (`signerClient.evm`/
  `.solana`, from `loadOperatorSignerClient` — see below): `evm.sign({to, data, chainId})` must
  resolve `{ signedTx }`, a `0x`-prefixed fully-signed raw transaction ready for
  `robinhood-rpc.mjs`'s `sendRawTransaction` (the signer resolves its own nonce/gas — this package
  never does); `solana.sign(unsignedTransactionBase64)` must resolve `{ signedTxBase64 }`, ready for
  `solana-rpc.mjs`'s `submitSignedTransaction` — the same contract `purchase`'s pre-existing
  Collector Crypt integration already used, now shared by every Solana-broadcasting stage.
- `src/app/accounting-projection.mjs` — `projectCycleAccounting({cycleRepository, cycleId})`, the
  real per-cycle accounting (pack spend, a derived bridge fee, workflow-state holder-reward/
  distribution status) derived honestly from `cycleRepository`'s durable stage evidence, shaped
  exactly for `packages/dashboard`'s public `roundAccounting` contract field. Never imported by
  `packages/runner` or `packages/dashboard` directly — see its own header.
- `src/app/compose.mjs` — `compose(config) -> { scheduler, service, cycleRepository, dashboard,
  shutdown }` from one explicit config object; the only place all of the above are actually
  instantiated together. `dashboard` is `null` unless `config.dashboard` is supplied, in which case
  it composes the dashboard control service against this same `scheduler`/`cycleRepository`,
  wiring `run-cycle-now`/`restart-request`/`reconcile-request`/real per-cycle accounting to the real
  scheduler/service/`accounting-projection.mjs`.
- `bin/hookemon-runner.mjs` — the CLI: `run` (start the scheduler and, unless `--no-dashboard` is
  given, the dashboard control service, both in this one process; runs until SIGINT/SIGTERM, which
  shuts down both), `tick` (one scheduler tick, then exit), `dry-run` (one cycle-service call with
  `liveMode` forced `false` regardless of the operator state file, then exit), `status` (print the
  current cycle-repository projection). `--state <absolute-path>` overrides the derived
  operator-state.json location for one invocation.

Usage:

```sh
export HOOKEMON_STATE_DIR=/absolute/path/to/a/state/directory   # never inside this repository
node packages/adapters/bin/hookemon-runner.mjs dry-run
node packages/adapters/bin/hookemon-runner.mjs status
node packages/adapters/bin/hookemon-runner.mjs run   # scheduler + dashboard, the actual ~20-minute
                                                      # autonomous loop plus its operator control UI
                                                      # (requires HOOKEMON_DASHBOARD_* too, or pass
                                                      # --no-dashboard to run the scheduler alone)
```

See `src/app/environment.mjs` for the full `HOOKEMON_*` variable list (RPC/API URLs and keys,
`HOOKEMON_VAULT_ADDRESS`/`HOOKEMON_HOOK_ADDRESS`, `HOOKEMON_SIGNER_MODULE`, and (WP-37)
`HOOKEMON_TREASURY_ADDRESS`/`HOOKEMON_POOL_ADDRESS`/`HOOKEMON_EXCLUDED_HOLDER_ADDRESSES` for
`distribution.mjs`'s own holder-exclusion-set builder; it also allow-lists, but does not itself
read, `packages/dashboard/src/server.mjs`'s own `HOOKEMON_DASHBOARD_*` variables) and
`docs/modules/composition-root.md` for the seam table and "What remains unimplemented, and why" —
what genuinely still blocks a real, money-moving mainnet cycle (a deployed vault/hook, a launched
HKMN token) versus what WP-36/WP-37 already closed.

## Signer and authority subsystem (`src/signing/`, `bin/hookemon-verifier.mjs`, `bin/hookemon-authority.mjs`)

This is where every production signature this repository ever produces actually goes through
(decision D3, and D7's separate verifier process). The application modules do not read or hold a
private key. The Operations Keychain children are the narrowly scoped exception: each reads one
credential only for one child lifetime, clears its known buffers, and exits.

- `src/signing/signer-client.mjs` — the shared `{ role, sign(request), broadcast(signed) }`
  interface, its four roles (`operator-evm`, `operator-solana`, `distribution-signer`, `verifier` —
  the latter two imported from `packages/runner/src/distribution/distribution-signer.mjs`, never
  redeclared), and `wrapSignerClient`, the one place every implementation gets its two structural
  guarantees: refuses to sign or broadcast unless `liveMode` was `true` at construction, and scrubs
  every result for anything that looks like a private key, a mnemonic, or a seed.
- `src/signing/external-module-signer.mjs` — the operator supplies a path to their own module
  exporting `createSignerClient(role, { liveMode })`; this file only ever imports and calls it —
  the same pattern `distribution-signer.mjs`'s own `loadSignerClient` already uses.
- `src/signing/keychain-signer.mjs` — backs a signer client with an OS-keychain-resident key by
  shelling out to a keychain command-line tool through a caller-injected `exec` function. This
  module imports neither `node:child_process` nor `node:fs` — the *only* way it ever reaches
  outside the process is that injected function, so "this module never reads a key file" is
  checkable by grepping its own source, not by trusting a comment.
- `src/signing/standing-authority.mjs` — builds the canonical, unsigned standing-authority
  document the owner signs OUTSIDE this repository, and loads/verifies a signed one against
  exactly the rules `packages/runner/src/cycle/authorization-provider.mjs`'s
  `StandingAuthorityProvider` enforces (imported directly, never reimplemented).
- `bin/hookemon-authority.mjs` — `print`/`verify` for the standing-authority document. Never signs
  anything; there is deliberately no "sign" subcommand.
- `bin/hookemon-verifier.mjs` — the distribution verifier's own, separate process (decision D7): a
  second, independently-keyed process from the scheduler/runner, watching a filesystem
  "distribution directory" (`pending/`/`receipts/`/`failed/`) for verification requests and
  writing signed receipts back through `distribution-signer.mjs`'s `signDistributionVerification`.
  Refuses to start without a `verifier`-role signer client; `--live-mode` is required with no
  default.
- `src/app/environment.mjs`'s `loadOperatorSignerClient`/`loadStandingAuthority` (the keychain
  backend as an alternative to `HOOKEMON_SIGNER_MODULE`, and the standing-authority document
  loader) are now wired into `bin/hookemon-runner.mjs`'s own composition (WP-35) — every
  subcommand builds the real operator `{evm, solana}` signer client and, when configured, the
  verified standing-authority document, and passes both to `compose.mjs`. Neither ever constructs a
  `distribution-signer`/`verifier`-role client: that role only ever belongs to
  `bin/hookemon-verifier.mjs`'s own, separate process.

## Known accepted advisory

`npm audit` reports 3 moderate-severity advisories against a transitive `uuid` dependency pulled in
by `@solana/web3.js`'s own `jayson` dependency (GHSA-w5hq-g745-h8pq). The only automated fix
(`npm audit fix --force`) downgrades `@solana/web3.js` to a pre-1.0 release, which is not
acceptable. This is accepted as a known, tracked upstream issue; re-check it whenever
`@solana/web3.js` is next bumped.

## Operations wallet identities

The Phase 3 Operations boundary uses exactly two Keychain-backed identities:
`operations-evm` (service `hookemon-operations`, account `operator-evm`) and
`operations-solana` (service `hookemon-operations`, account `operator-solana`). The
`hookemon-wallet` CLI manages their public identity metadata and sign-only readiness:

```sh
node packages/adapters/bin/hookemon-wallet.mjs generate --identity operations-evm
node packages/adapters/bin/hookemon-wallet.mjs generate --identity operations-solana
node packages/adapters/bin/hookemon-wallet.mjs show --identity operations-evm
node packages/adapters/bin/hookemon-wallet.mjs probe --identity operations-solana
node packages/adapters/bin/hookemon-wallet.mjs export-public --out /absolute/path/operations-wallets-public.json
```

The commands accept `[--service hookemon-operations] [--keychain-command /usr/bin/security]` as
needed; generation additionally requires `--replace` to replace an existing identity. They report
or export public identity data only. The export schema is `hookemon-operations-wallets-v1`,
containing the EVM address, Solana public key, Keychain service/account labels, and generation time.

Never place a wallet private key, seed, mnemonic, or Keychain secret in an environment variable,
repository file, dashboard state, journal, CI output, or the public export. The CLI does not sign
an arbitrary money movement, fund an account, broadcast, or rotate an onchain role; its probe only
signs a fixed internal readiness check. Those actions remain behind the transaction-policy and
owner-approved operational controls. See the
[Operations Wallets Runbook](../../docs/runbooks/operations-wallets.md) for setup, recovery,
rotation, and the current production-funding OPEN FACT.
