# Operations Wallet

## Purpose

Operations Wallet holds the 2.5 percent process share after a bounded onchain claim and provides
the two external signing identities for a cycle: Operations EVM and Operations Solana. The EVM
identity is the public Operations address and signs only policy-approved EVM work; the Solana
identity signs only policy-approved Solana cycle work. The adapters build an Operations-self claim
only after the eligibility snapshot and custody checks pass, and they do not permit a live
signature until the chain-attempt journal can persist signed bytes. Private material stays outside
the long-lived application Node process. This card covers `REQ-operations-wallet-1` through
`REQ-operations-wallet-3` and the Operations-side contracts in `REQ-cycle-repository-1`,
`REQ-transaction-policy-1`, and `REQ-direct-payout-1`.

## Public interface

The Phase 3 hook interface is represented by the typed adapter calldata builder and the frozen ABI.

- `claimProcess(bytes32 cycleId,uint256 amountAtomicUsdg,address destination)` accepts only current Operations, a nonzero permanently unused cycle identifier, a positive amount within liability and capacity, and `destination == msg.sender`. Its immutable active-entry bound is at most 64.
- `remainingProcessClaimCapacity()` reports currently available capacity, and `activeProcessClaimLimit()` reports the active cap, including a scheduled increase that has reached its activation time.
- Treasury controls `setProcessClaimLimit(uint256)`, `pauseProcessClaims()`, `unpauseProcessClaims()`, `scheduleOperationsRotation(address)`, and `executeOperationsRotation()` as defined by Role Control.
- `claimProgrammable(address destination)` and `claimTreasury(address destination)` transfer full liabilities to a nonzero beneficiary-selected destination. Their amount overloads support positive partial claims and record the exact transfer destination.
- A successful process claim records `cycleId`, amount, destination, timestamp, cap, and used-after amount.
- `prepareClaimProcessRequest` binds the local cycle ID, its deterministic onchain ID, the exact
  atomic amount, the configured USDG asset metadata, and the Operations EVM destination. After
  the durable `PREPARED` transition, the claim path binds a pending EVM nonce, estimated gas,
  EIP-1559 fee fields, and `MoneyConfigurationV1` before a signer can see a transaction. Both
  EIP-1559 fee fields must not exceed the configured per-transaction gas-price cap, and the native
  balance must cover `gasLimit * maxFeePerGas + nativeReserve`.
  `reconcileLiveClaimProcess` requires a canonical finalized successful receipt with the exact
  claim event and USDG transfer; a finalized revert is terminal rather than a retry signal.
- The claim mutator revalidates the live mutation authority immediately before both signing and
  raw-transaction broadcast. A direct caller cannot use the exported mutation helper to bypass
  that boundary.
- Outbound validation accepts only the exact USDG approval and configured Relay EVM depository
  call from Operations. A policy signer is refused unless the chain-attempt journal supplies a
  persisted EVM nonce for the approved transaction. Its durable recovery context also retains the
  signed quote deadline and source sender, depository, and destination-owner route tuple, so
  settlement can bind own-RPC proof to those persisted accounts and use the canonical EVM source
  timestamp and finalized Solana block time rather than a live quote.
- Return reconciliation accepts `ReturnLegDestinationProofV1`: an authenticated terminal Relay
  destination pointer plus this process's finalized Solana source observation and Robinhood
  receipt. It binds return custody before payout only when that receipt shows one exact USDG
  Transfer to Operations for the quoted amount inside the configured settlement window and the
  source and destination hashes are globally unique. Other finalized transfer observations enter a
  named hold. It accepts only the unchanged runtime proof emitted by that process-RPC observation
  and never uses a wallet-wide balance or Relay status as a substitute.
- The frozen standing-authority boundary persists `StandingAuthorityDecisionV1` on first use with
  `authorityDigest`, `verifiedAt`, `intentDigest`, `dayCapReservation`, and `nonceReservation`.
  This is a repository-backed contract: it checks expiry against wall-clock time and writes the
  decision plus both reservations atomically before any signable claim, outbound, return, or
  payout action.
- `StandingAuthorityProvider.verifyAndRecordStepAuthorization(intent, { cycleRepository, now })`
  reads an exact persisted decision before re-verifying. For a new intent it checks expiry,
  derives the day and nonce reservation keys, and delegates one exact decision plus the
  authority-derived day cap to `recordStandingAuthorityDecision`. A stored replay neither reads a
  new wall-clock authorization nor reserves another capacity slot.
- Production configuration accepts the owner-signed authority document only with both its owner
  and policy public-key paths. The composition loads the branded provider from those inputs; every
  live signing boundary also requires an already policy-signed step intent and refuses before the
  raw signer when either authority input is missing or invalid.
- Production additionally loads `<stateDir>/standing-authority-step-authorizations.json`. It must
  be a private `0600` regular file with canonical
  `hookemon.standing-authority-step-authorizations.v1` JSON, the verified authority digest, and
  unique `{ signerRole, intent }` entries. The loader opens it without following links, validates
  its private regular-file inode through that descriptor, then reads those exact bytes. It contains
  no signing key. The resolver returns an intent only for its exact cycle, stage, authorization
  kind, request digest, and signer role.
- `readEnvironment` builds `MoneyConfigurationV1` from the frozen USDG binding, the configured
  Solana mint and decimals, typed minima, and four explicit native-fee controls.
  `validateMoneyConfiguration` rejects a malformed configuration as
  `MoneyConfigurationRejected`; `compose` repeats that validation outside inspection before it
  opens durable state. The same frozen value is checked by claim, outbound, return, purchase,
  buyback, and payout before their relevant signer boundary.
- Production requires a distinct `HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL`. `compose` creates the
  separate archive evidence client for block-pinned ERC-20 balance reads and rejects the
  latest-only public RPC as finality evidence. Controlled compositions may inject the same narrow
  capability explicitly.
- `hookemon-wallet generate --identity operations-evm|operations-solana` creates the corresponding
  Keychain-backed bot identity. The defaults are service `hookemon-operations` and accounts
  `operator-evm` and `operator-solana`; replacing an existing identity requires `--replace`.
- `hookemon-wallet show --identity ...` reports public identity metadata, `probe --identity ...`
  performs and verifies a fixed internal sign-only check without broadcasting, and
  `export-public --out <absolute-path>` writes both public identities with schema
  `hookemon-operations-wallets-v1`.
- `hookemon-bridge-native --from-chain 1 --to-chain 4663 --amount max|<native>` is an owner-operated
  recovery command for native assets sent to the Operations EVM address on EVM L1. It reads
  only the Keychain-backed public identity, obtains a native Relay quote for the same recipient,
  decodes each returned EVM transaction through the shared transaction-policy decoder, and allows
  exactly one origin-chain native-value transaction. `--confirm` requires an interactive `y`; without
  it the command prints the plan and exits without signing. A confirmation stores the Relay request
  ID, signed-byte digest, and transaction hash in `--state-dir` around the irreversible boundary.
- `hookemon-runner dry-run --mode production` uses fake providers and does not construct an
  Operations signer. It preserves the production-mode dry-run flag in the cycle repository and
  cannot sign, broadcast, or call a provider mutation.
- The short-lived Operations Solana Keychain child accepts a complete legacy or v0 serialized
  transaction only after its loaded public key matches `expectedAccount`. It adds the Operations
  signature without replacing pre-existing co-signer slots, then clears known secret buffers
  before exit. Policy approval and trusted chain context stay at the caller boundary.

## Invariants

- A claim counts in the active window exactly while `block.timestamp - claimedAt < 21600`; an entry at equality is expired.
- Active window entries are bounded by immutable `processClaimMaxCount`, hard-capped at 64. Limit
  decreases and zero take effect immediately; an increase no greater than immutable 500000 USDG
  `Xmax` activates only after 21600 seconds.
- Limit changes, pauses, and Operations rotation never reset capacity usage, claim history, or used cycle identifiers.
- Scheduling or executing an emergency Operations rotation auto-pauses claims. Its immutable
  constructor delay is 43200 seconds. Scheduling clears a pending ordinary Operations proposal
  and blocks ordinary Operations proposal and acceptance. Operations cannot cancel or replace a
  pending rotation; only a new explicit Treasury emergency-rotation intent can supersede it with
  a fresh delay. Rotation never clears history.
- Operations custody is limited to its own claimed process share. It has exactly one EVM signing identity and one Solana signing identity. Only a short-lived isolated child handles private material; the long-lived application Node process does not.
- The Solana child validates its expected public identity inside the isolated process before it
  deserializes or signs a transaction. A mismatched account cannot produce a partial signature.
- Environment and composition reject a configured or exported third Operations signer rather than
  selecting one implicitly. The configured Hook destination and every prepared claim use the one
  Operations EVM identity.
- The configured Solana mint and Operations Solana identity compare byte-exactly. The configured
  Relay EVM depository must match the decoded outbound plan exactly.
- Native bridge recovery accepts only chain 1 native assets to chain 4663 native assets, with Operations
  as both Relay sender and recipient. The quote contains exactly one executable transaction with
  native value equal to the quoted input; ERC-20 approvals, transfers, and extra steps are refused.
  `max` reads current fee data, reserves twice the native-transfer gas cost before the first quote,
  estimates the quoted transaction, then requotes once when the final margin-adjusted reserve is
  larger. It refuses a non-positive amount or one below the Relay minimum. A retry may broadcast
  only the persisted signed bytes for its request; it never creates replacement signing material.
- A generic chain attempt reaches `PREPARED` before signing, then retains exact signed bytes,
  `rawSignedBytesHash`, `nonceOrBlockhash`, and `txHash`, with separate broadcast and finality
  evidence. Live outbound and return use the combined Relay signing record to persist policy,
  approval, approved-semantics, signed-message, fencing-token, and source-reservation facts with
  those bytes. Claim retains the generic v1 record, while each direct-payout recipient record
  persists its signed bytes and recovery authority together. No recovery path creates a
  replacement signature.
- One repository-backed wallet nonce reservation covers claim, outbound, return, and payout. It
  binds an active lease window to its fencing token; a different fence can take over only after
  expiry, and a stale release cannot erase the newer reservation. An expired standing authority is
  refused on first use. Replaying an already persisted authority decision is idempotent and cannot
  reserve a second day cap or nonce.
- Durable source `FINALIZED` evidence releases that chain-local wallet reservation even when the
  associated Relay leg is awaiting destination attribution. The release cannot reauthorize its
  immutable signed bytes or change the Relay leg's settlement state.
- An outbound Relay leg signs only the claimed principal for its cycle. A return leg signs only the
  attributed proceeds delta. Both legs record `RelayLegV1` before the first signature and remain
  unsettled until their own RPC observations prove source and destination finality and attribution.
  For an exact outbound credit, this requires the recorded request ID in the destination Solana
  memo, the configured mint and exact atomic amount, and a canonical destination block timestamp
  within the persisted interval from the EVM source timestamp through the signed quote deadline.
  A missing timestamp, memo, or exact credit is not settled.
- A return proof records the terminal Relay pointer plus one finalized Robinhood receipt. `SETTLED`
  requires exactly one USDG Transfer to Operations for the quoted destination amount within the
  persisted settlement window; a partial, late, or wrong token or recipient result enters its named
  `HELD_RELAY_*` state and cannot fund payout.
- Every money minimum is a typed `{chainId, assetId, decimals, amountAtomic}` value. The
  production return minimum is `{chainId: 4663, assetId: USDG, decimals: 6, amountAtomic: 0}`;
  it intentionally sets no general return minimum, and every nonzero value is a configuration
  error. EVM per-transaction gas-price and native reserve caps plus Solana priority-fee and
  lamport reserve caps are mandatory. Atomic value `1` is a configuration error, never a fallback.
  Return, purchase, and buyback cap decoded priority fees and require the configured lamport reserve
  plus the maximum fee before signing; this is a balance check, not a balance reservation.
  Production and rehearsal require
  `HOOKEMON_RELAY_SOLANA_MINT`, `HOOKEMON_RELAY_SOLANA_DECIMALS`,
  `HOOKEMON_EVM_GAS_PRICE_CAP`, `HOOKEMON_EVM_NATIVE_RESERVE`,
  `HOOKEMON_SOLANA_PRIORITY_FEE_CAP`, and `HOOKEMON_SOLANA_LAMPORT_RESERVE`; the retained
  legacy native-cap projection cannot satisfy any of those controls.
- Private keys, seeds, mnemonics, and Keychain secret values never enter the application process, environment variables, repository, dashboard, journal, CI, or public export. `export-public` contains only public addresses and Keychain labels.
- The wallet child starts `/usr/bin/security -i` with no secret in its process arguments and sends `add-generic-password -a <account> -s hookemon-operations [-U] -w <secret> <login-keychain-path>` only over standard input. It refuses use unless the current default Keychain is the login Keychain and names that verified login Keychain for reads and writes.
- The wallet-management CLI does not confer authority to claim, sign arbitrary bytes, broadcast, deploy, or move funds. A transaction still requires the cycle policy, semantic transaction allowlist, and live-operation approval path.
- Failed transfer, wrong caller, invalid destination, repeated cycle identifier, over-cap claim, or reentrant call leaves balances, liability, and history unchanged.

## State transitions

- A valid process claim atomically debits process liability, transfers USDG to Operations, records the cycle identifier, and consumes active-window capacity.
- Claim adapter state is `PREPARED(requestDigest)` →
  `SIGNED(rawSignedBytesHash, nonceOrBlockhash, txHash)` → `BROADCAST` → `FINALIZED`. The generic
  repository record does not persist the frozen v2 policy, fencing, refusal, or approval-digest
  fields. A restart reconciles the existing claim rather than constructing replacement bytes.
- When canonical claim evidence proves the exact USDG credit, the stage records or backfills the
  matching `eip155:4663` custody ledger with the exact `claimed` amount before finality. A
  conflicting nonzero claimed amount is refused.
- The removed degraded-return acceptance route always refuses. It cannot target a legacy custody
  contract or bypass policy, authorization, fencing, and the chain journal.
- Return reconciliation moves from a finalized source debit and terminal Relay pointer to a
  `ReturnLegDestinationProofV1` check against the process-RPC destination receipt. An exact proof
  settles the leg and records attributed return custody before payout; partial, late, and wrong
  transfer evidence records the matching terminal hold.
- First use of a standing authority checks wall-clock expiry, then atomically persists
  `StandingAuthorityDecisionV1` and its day-cap and nonce reservations before it can reach a
  signer. An exact replay reads the same decision, including after authority expiry, without
  reserving again; only an expired first use reaches `REFUSED`.
- Money configuration moves from explicit environment values through canonical
  `MoneyConfigurationV1` validation to a frozen composition value. Missing required controls,
  incorrect asset metadata, an atomic placeholder value, or any nonzero return minimum are rejected
  before adapters or durable state are constructed.
- `collector-only` rehearsal replaces outbound and return with explicit skip handlers. The fake
  `relay-roundtrip` rehearsal profile enables those handlers only with a positive explicit cap and
  the same manual-approval boundary as any other signable work.
- Expired window entries cease counting without erasing historical evidence.
- A scheduled limit increase becomes executable after 21600 seconds. An emergency rotation becomes
  executable after immutable 43200 seconds; rotation leaves process claims paused and cannot be
  cancelled by Operations. Rescheduling requires a new Treasury intent and restarts the delay.
- An immediate limit decrease or zero clears any pending increase. Claims remain paused until Treasury resumes them after a scheduled Operations rotation has executed or is no longer pending.
- A beneficiary claim debits only its own accrued liability after its exact transfer succeeds; it can withdraw a positive partial amount or the full remaining liability without changing any fee remainder.
- A bot identity moves from absent to generated only through `hookemon-wallet generate`. A replacement requires `--replace` and prints the old public record before Keychain replacement begins. `show` and `export-public` reveal public metadata only, while `probe` signs and verifies a fixed internal check without broadcasting.
- Native bridge recovery moves from a displayed dry-run plan to interactive owner confirmation,
  persisted signed bytes, origin broadcast, and destination credit observation. A timeout leaves
  the persisted record available for a byte-identical retry.
- A suspected compromise or planned rotation moves operations through execution pause, unresolved-action reconciliation, public-binding rotation, replacement identity generation, readiness probing, and only then controlled resumption.

## Operational commands

```sh
node packages/adapters/bin/hookemon-wallet.mjs show --identity operations-evm
node packages/adapters/bin/hookemon-wallet.mjs show --identity operations-solana
node packages/adapters/bin/hookemon-wallet.mjs probe --identity operations-evm
node packages/adapters/bin/hookemon-wallet.mjs probe --identity operations-solana
node packages/adapters/bin/hookemon-wallet.mjs export-public --out /absolute/path/operations-wallets-public.json
node packages/adapters/bin/hookemon-bridge-native.mjs --from-chain 1 --to-chain 4663 --amount max --state-dir /absolute/path/to/operations-bridge-state
```

Create or replace an identity only through the documented `generate` command and its explicit
`--replace` guard. The CLI must not be used to export secret material or as a substitute for
onchain role rotation. See [`operations-wallets.md`](../runbooks/operations-wallets.md) for the full
setup, backup, funding, and incident procedure. Contract acceptance covers the 21,600-second
equality boundary, bounded `N` entries, cap transitions, automatic pauses, permanent replay
protection, exact destinations, and independent fee remainders. The offline wallet and signer
checks are `packages/adapters/test/wallet-cli.test.mjs` and
`packages/adapters/test/signing/hookemon-keychain-signer.test.mjs`.

## Recovery pointers

- Pause claims and execution before responding to an Operations-key incident, then use the owner-approved onchain and signer-policy rotation path.
- Reconcile an unresolved claim from its recorded cycle identifier, transfer delta, cap, used-after value, and any signed or broadcast transaction before retrying. Never create replacement bytes while the earlier request is unresolved.
- Keep an encrypted whole-Mac backup that includes the login Keychain, or be ready to generate
  replacements and use the approved emergency rotation path. Test recovery against a
  non-production Keychain context using `show`, `probe`, and a public export only.
- Production funding remains an OPEN FACT until public addresses, gas floats, funding sources, policy caps, canaries, and owner authorization are recorded. Until then, use readiness checks and rehearsal without production funding, signing, or broadcast.
- Do not clear claim history, reset usage, redirect a beneficiary claim, or put secret material in an environment variable to restore operations.
- Keep the standing-authority artifact private and canonical in the state directory. A missing or
  digest-mismatched artifact is a signing refusal, not a reason to synthesize an intent or bypass
  the first-use reservation.
- The durable first-use API requires a repository that implements
  `recordStandingAuthorityDecision(cycleId, decision, { maxCyclesPerDay })`; if it also provides
  `readStandingAuthorityDecision(cycleId, intentDigest)`, replay can proceed after authority
  expiry without a second verification. Callers that use the legacy synchronous verifier alone do
  not create a durable decision and must not use it as a signable-action boundary.
- For native assets sent to the Operations address on EVM L1, run the recovery command in
  dry-run mode, review its single-step Relay plan, then rerun with `--confirm` and answer `y`.
  Reuse the same state directory after a submission disconnect. Do not delete its bridge record or
  request a replacement signature.
