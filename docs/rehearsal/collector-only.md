# Collector-only live rehearsal

## Scope

This is the owner-operated admission procedure for a single Collector Crypt pack. The checked-in
transaction-policy bundle currently preserves verified historical evidence but does not authorize
the current Operations identity. Preflight therefore remains closed before any Keychain probe,
provider request, signing, or broadcast. A future runtime-ready bundle may open one selected pack,
accept the buyback only when the stage checks pass, and divide finalized proceeds across the
configured test recipients. It does not claim, bridge, or distribute process funds on another chain.

The run is bounded to one `25000000`-atomic-unit pack. The policy must require manual approval,
allow only the selected pack code, and cap the cycle at one booster. The runner refuses an absent
or changed policy, a missing canary, an unresolved effect, an unfinalized proceeds delta, or a
recipient without the required settlement token account.

The only signing path is the Operations Keychain child:

- Keychain service: `hookemon-operations`
- Keychain account: `operator-solana`
- Expected public key: `BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE`
- Child command: `packages/adapters/bin/hookemon-keychain-signer.mjs`

The runner never uses the rehearsal-specific signer module. The application process receives a
signed transaction, not Keychain key material.

## Prerequisites

- The Keychain item already exists under the service and account above. Do not create, export, or
  paste its secret while preparing this rehearsal.
- The configured proceeds account is an Operations-owned Solana settlement token account. It is
  distinct from the Operations public key and every payout recipient.
- Each recipient already has the expected settlement token account. The rehearsal does not create
  recipient accounts.
- The Collector key is stored in a private local file. The environment file contains only its
  absolute path.
- Run the procedure from the repository root with Node `v24.19.0` on the owner-approved Mac.
- `packages/adapters/rehearsal/collector-policy/bundle.json` is the checked-in Collector evidence
  manifest. The loader verifies its digest and the digest plus decoded summary of every referenced
  specimen before creating process-local sidecars. Its current status is `evidence-only`; it is not
  authority for the current Operations wallet, a v0 transaction, an address lookup table, or a
  provider account role not present in a verified current transaction contract.

## Owner procedure

1. Create the local environment file and restrict its permissions.

   ```sh
   mkdir -p "$HOME/.hookemon"
   cp packages/adapters/rehearsal/rehearsal.env.example "$HOME/.hookemon/rehearsal.env"
   chmod 600 "$HOME/.hookemon/rehearsal.env"
   ```

2. Replace every angle-bracket value in `~/.hookemon/rehearsal.env`. The required owner values are
   the Collector key-file path, pack code, proceeds account, recipient list, state directory, and
   dashboard credential. Do not add bridge, EVM identity, or production-provider variables.

3. Load the isolated environment and initialize the dedicated state directory. The initializer
   succeeds only when no operator state exists, so it cannot weaken or replace an existing policy.

   ```sh
   export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
   . "$HOME/.hookemon/rehearsal.env"
   mkdir -p "$HOOKEMON_STATE_DIR"
   node packages/adapters/bin/hookemon-runner.mjs operator initialize-collector-only-policy
   node packages/adapters/bin/hookemon-runner.mjs operator status
   ```

   The initializer writes exactly one selected pack, one requested order, one booster, one cycle
   per day, and the exact `25000000` atomic-unit limit for price, per-cycle, daily, loss, and
   custody caps. It requires the first cycle to have a manual approval. If it reports a stale state
   revision, stop: this is not an empty dedicated rehearsal directory. Do not weaken an existing
   policy or create a replacement state file.

4. Run the read-only preflight.

   ```sh
   node packages/adapters/bin/hookemon-runner.mjs preflight
   ```

   Preflight first loads and verifies the checked-in Collector evidence bundle. It currently refuses
   at the `evidence-only` runtime boundary because no current-operator provider contract is verified.
   It does not probe Keychain, read the catalog or RPC, purchase, sign, or broadcast. Do not start a
   cycle after this expected refusal.

5. Start the single bounded cycle only after preflight prints a plan.

   ```sh
   node packages/adapters/bin/hookemon-runner.mjs run \
     --mode rehearsal \
     --cycles 1 \
     --cap-usdg 25000000 \
     --collector-only
   ```

   If the runner reports `AWAITING_MANUAL_APPROVAL`, it has not purchased a pack. Copy the exact
   `cycleId` and `cycleDigest` from its output into the approval file, obtain the current operator
   state revision, record the approval, and rerun the same command:

   ```sh
   printf '%s\n' '{"cycleId":"<cycle-id>","cycleDigest":"<cycle-digest>"}' \
     > "$HOME/.hookemon/rehearsal-approval.json"
   node packages/adapters/bin/hookemon-runner.mjs operator status
   node packages/adapters/bin/hookemon-runner.mjs operator manual-approval \
     --expected-revision <revision-reported-by-status> \
     --request-id rehearsal-approval-<cycle-id> \
     --input "$HOME/.hookemon/rehearsal-approval.json"
   node packages/adapters/bin/hookemon-runner.mjs run \
     --mode rehearsal \
     --cycles 1 \
     --cap-usdg 25000000 \
     --collector-only
   ```

   The approval binds the persisted cycle and digest. Do not edit either value, create a replacement
   cycle, or approve a reconstructed plan.

6. Keep the terminal open until the runner reports the finalized evidence path. The resulting
   evidence must show one purchase, one open, one buyback, the dedicated-account balance delta,
   and exact equal-split recipient allocations. A stopped or held cycle is not permission to start
   another one.

## Recovery

Inspect the existing cycle before any recovery action:

```sh
node packages/adapters/bin/hookemon-runner.mjs status --cycle <cycle-id>
node packages/adapters/bin/hookemon-runner.mjs resume <cycle-id>
```

`SENT_UNKNOWN`, an incomplete signature, a missing finalized balance delta, or an account mismatch
requires reconciliation of the recorded attempt. Do not submit a second provider request, sign new
bytes, or rerun the cycle with a different state directory.

## Open fact: buyback destination semantics

**What is missing:** the [current Solana API documentation](https://docs.collectorcrypt.com/gacha/api)
types `altRecipient` as a wallet public key that redirects the refund. It does not establish that
the endpoint accepts a settlement token account.

**How to resolve it:** obtain provider documentation or a non-production provider confirmation that
states the accepted destination form, then bind that fact to the selected API version and test it
against a controlled account.

**Verified safe alternative:** the Collector-only request omits `altRecipient` and sends the
documented `playerAddress` wallet. The live path still requires the finalized delta at the
Operations-owned canonical settlement account; no wallet-wide balance or provider-reported amount
substitutes for that delta.

## Open fact: Collector transaction-policy bundle

**What is verified:** the manifest is version 1 and binds three finalized legacy Solana specimens
from the historical rehearsal wallet. The loader verifies the canonical manifest digest, every
specimen digest, every decoder field, instruction order, program, account, memo data, mint, amount,
and priority-fee value before it returns a sidecar.

| Action | UTC | Signature | Verified effect |
| --- | --- | --- | --- |
| Purchase payment | 2026-09-03 20:38:32 | `HVc9Vbm1LZQEL5LwiCGXTQGVfYi3JqqTNeSBoNNLiUX2aQAe8fGwojQwTFdCTVq3Kc5bocLJoQm3JbSVPPbQMFK` | `25000000` atomic settlement units to the observed provider settlement account |
| Open delivery | 2026-09-03 20:38:36 | `4Sou2f5Sb6tgSUrCjdyBGXFDGUStznwQRJErGZZmqjQzpeSmZzPgSvreRzgE9aVjvqGaXbnu1eKt2VmXbNKwM536` | Metaplex Core transfer-shaped card delivery |
| Buyback | 2026-09-03 20:47:24 | `4XNH9odxkTK4off9tLQt7aNoVZeJtNMpHs4xDHkBm6ezMBsCV3fnyUTUzkUJhDrw4FGQCWRyrgLG4a8WrhyH3ywN` | `17000000` atomic settlement units to the historical wallet's canonical account |

**What is missing:** a Collector transaction for the current Operations wallet, a versioned
provider contract that distinguishes fixed service accounts from per-order values, a documented
machine account derivation, a safe blockhash validity-pair source for provider bytes, a v0/lookup
table specimen, and a signing-slot contract compatible with the current signer boundary. The
historical wallet must never become a current allow-list entry.

**How to resolve it:** obtain a provider-versioned request and transaction contract plus an
authorized current-operator specimen. Record the exact role substitutions, blockhash validity pair,
and any lookup table owner/data evidence, then replace `evidence-only` with a reviewed runtime-ready
bundle revision.

**Verified safe alternative:** `preflight` verifies the bundle and refuses before its Keychain
probe, catalog request, or any mutation. Do not run the cycle command after that refusal.
