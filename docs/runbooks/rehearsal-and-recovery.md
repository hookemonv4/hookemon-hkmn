# Rehearsal and recovery

Use this runbook only on the owner-approved Mac for the one-pack Collector-only live rehearsal.
It does not authorize a bridge, an EVM action, a production cycle, a deployment, or a replacement
signature.

The canonical setup is [`collector-only.md`](../rehearsal/collector-only.md). It replaces the old
fake-provider rehearsal instructions. Use its template, its Operations Keychain child, and its
preflight before every live run.

## Exact owner sequence

From the repository root:

```sh
mkdir -p "$HOME/.hookemon"
cp packages/adapters/rehearsal/rehearsal.env.example "$HOME/.hookemon/rehearsal.env"
chmod 600 "$HOME/.hookemon/rehearsal.env"
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
. "$HOME/.hookemon/rehearsal.env"
mkdir -p "$HOOKEMON_STATE_DIR"
node packages/adapters/bin/hookemon-runner.mjs operator initialize-collector-only-policy
node packages/adapters/bin/hookemon-runner.mjs operator status
```

Fill the six owner fields in the copied environment file before sourcing it: Collector key-file
path, pack code, dedicated proceeds account, recipients, state directory, and dashboard credential.
The file fixes the single Operations public key, Keychain service/account path, provider mode,
typed amount configuration, one-pack cap, and equal split.

The initializer creates the exact one-pack policy only in an absent state file. It refuses a
pre-existing state rather than editing it:

```sh
node packages/adapters/bin/hookemon-runner.mjs preflight
node packages/adapters/bin/hookemon-runner.mjs run \
  --mode rehearsal \
  --cycles 1 \
  --cap-usdg 25000000 \
  --collector-only
```

Preflight is read-only. It first requires the trusted Collector transaction-policy bundle, then
verifies the Keychain sign-only path, Collector credentials and selected machine, Solana RPC and
balances, the Operations-owned settlement account, recipient token accounts, the persisted
one-pack policy, typed money configuration, and collector-only canaries. It prints the exact
`25000000` atomic-unit spend. It does not initialize policy state. A refusal must be corrected
before `run`.

`run` performs exactly one cycle and stops. Its policy requires manual approval before the purchase
effect. If it prints `AWAITING_MANUAL_APPROVAL`, write the displayed immutable values to an approval
file, inspect the revision, record the approval, then rerun the identical bounded command:

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

Do not reuse this environment for production. Do not add production bridge, EVM, or Relay variables.
The collector-only profile rejects them.

## Recovery

The cycle repository remains the authority after a process exit. Start with inspection:

```sh
node packages/adapters/bin/hookemon-runner.mjs status --cycle <cycle-id>
node packages/adapters/bin/hookemon-runner.mjs resume <cycle-id>
node packages/adapters/bin/hookemon-runner.mjs abort-cycle <cycle-id> --reason "recorded reconciliation fact"
```

`resume` reconciles recorded work; it does not create a replacement purchase, open, buyback, payout,
signature, or broadcast. Do not invoke `abort-cycle` to discard uncertainty. It records an explicit
terminal owner action and leaves the journal intact.

If finality, the dedicated proceeds delta, or a recipient allocation is missing, retain the state
directory and reconcile the recorded attempt. A cycle that has reached `SENT_UNKNOWN`, a pending
signature, or a held evidence state cannot fund another cycle.

## Open fact: buyback destination semantics

**What is missing:** available Collector documentation does not prove that its buyback destination
field accepts an exact Solana token-account address rather than only a wallet public key.

**How to resolve it:** obtain versioned provider confirmation of the accepted value and bind it to a
controlled test before expanding this procedure.

**Verified safe alternative:** the runner requires the configured Operations-owned settlement
account and pays recipients only from its finalized account-level delta. It holds rather than
substituting a wallet-wide balance or provider response.

## Open fact: Collector transaction-policy bundle

**What is missing:** available provider evidence does not establish the versioned transaction
anchors and rule sidecars needed for the live purchase, buyback, and payout signing policies.

**How to resolve it:** obtain the provider's versioned transaction contract and a controlled
specimen, then install the reviewed bundle through a supported configuration source.

**Verified safe alternative:** preflight refuses before its Keychain probe or any provider request
when the bundle is missing. Do not proceed to `run` after that refusal.
