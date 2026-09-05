# Manual One-Cycle Phase 1 Design

## Status

Owner-approved product design as of 31 August 2026. This document narrows Phase 1; it does not authorize a deployment, signature, broadcast, bridge transfer, marketplace action, or spend.

## Outcome

Phase 1 proves one capped, manually started, fully reconciled production-shaped cycle:

1. a controlled buyer purchases HKMN in the canonical USDG/HKMN market;
2. the hook collects and isolates the approved inclusive fee split;
3. Operations releases one bounded process amount;
4. the operator moves that amount through one fixed outbound cross-chain route;
5. the operator buys and opens one selected Collector Crypt pack;
6. the awarded NFT is sold through the standard buyback path;
7. the realized proceeds return through one fixed inbound route;
8. only the attributable net USDG funds one holder payout; and
9. at least one valid entitlement is paid and the complete cycle reconciles.

The first cycle is a mainnet canary, not a public launch or unattended service.

## Design choice

Phase 1 uses a manual one-shot runner. Scheduling, continuous operation, dashboard controls, OpenUI, cached catalog infrastructure, route discovery, and multi-pack strategy support are deferred.

The operator reads the current pack list directly from the existing Collector API and chooses one pack. The chosen pack code and all money-moving parameters are frozen into the cycle authorization before execution. No catalog database, background refresher, or selection UI is required.

## Architecture

### Immutable onchain kernel

The onchain boundary retains only the money and market invariants that cannot safely depend on an offchain operator:

- one fixed-supply HKMN token with no later mint, transfer tax, blacklist, confiscation, proxy, or upgrade path;
- one canonical USDG/HKMN PoolKey and one immutable fee-enforcing hook;
- permanent non-project-controlled custody of the launch position;
- the inclusive 3.00% fee split: 0.10% Programmable, 0.40% treasury, and 2.50% process liability;
- isolated liabilities, exact balance-delta verification, global solvency, and one money-path reentrancy boundary;
- one single-use process release bound to the current Operations identity;
- one fully funded holder-payout commitment; and
- permissionless, non-expiring, at-most-once payment to the recipient committed in each proof.

No scheduler, pack configuration, bridge adapter, marketplace client, catalog, dashboard setting, or arbitrary external call belongs in the hook.

### Reversible offchain runner

One CLI-oriented runner owns the manual cycle workflow. It has no standing authority and holds no secret in repository files or receipts. It performs only these duties:

- read the pack list and current pack facts from the configured production API;
- prepare one cycle artifact from an operator-selected pack;
- verify exact outbound and return-route bindings;
- decode and verify purchase and buyback transactions before signing;
- record intent before every external mutation;
- reconcile independent chain and API evidence after every mutation;
- compile the owner-approved holder manifest and payout proof; and
- prepare the next action or stop with an explicit unresolved state.

The runner does not schedule itself, select a pack automatically, optimize routes, retry uncertain money movements, publish a dashboard, or operate multiple cycles concurrently.

## Frozen cycle input

Before the first money-moving action, one cycle artifact binds:

- the unique cycle identifier and exact release amount;
- the Operations identity and approved execution wallet;
- the selected pack code, quantity one, non-turbo mode, current price, and maximum principal;
- the outbound and return assets, chains, providers, destinations, minimum receives, deadlines, and gas caps;
- the canonical Solana USD Coin mint and approved token account;
- the Collector API host, credential identifier, allowed programs, instructions, accounts, recipients, and memo rules;
- the holder snapshot block and owner-approved distribution-manifest policy; and
- the exact release revision, contract addresses, and dependency evidence used by the run.

Secrets, private keys, seed phrases, raw credentials, and unrestricted signing authority are never cycle-artifact fields.

## Execution and reconciliation

The runner advances through one linear sequence:

```text
prepared
-> process released
-> outbound conversion finalized
-> pack purchase finalized
-> pack opened and NFT custody verified
-> buyback finalized
-> return conversion finalized
-> payout funded
-> entitlement paid
-> reconciled
```

Before each external mutation, the runner appends the exact authorized intent and canonical request or transaction digest. After the mutation, it records the response, signed-bytes digest where applicable, transaction identifier, independent finality evidence, and observed balance or custody change.

An action may advance only when the observed result matches the frozen input. Ambiguous, pending, expired, wrong-chain, wrong-asset, wrong-recipient, altered, short, duplicate, or unreconciled results stop the cycle. Restarting the runner resumes the same cycle identifier and first reconciles the prior intent. It never creates a replacement purchase, sale, or bridge action while the earlier action might still execute.

## Pack and buyback boundary

The canary uses exactly one operator-selected standard Collector pack. Quantity is one, turbo is disabled, and alternate recipients are forbidden.

The purchase transaction must match the frozen player, pack, asset, amount, memo, signer, fee payer, programs, accounts, and destination before it can be signed. Opening occurs once after the purchase is finalized. The awarded NFT must be observed at the approved wallet.

The buyback receives a separate authorization because the NFT identity is unknown before opening. That authorization binds the exact mint, current owner, original Collector destination, approved USD Coin account, API refund amount, and owner minimum receive. Completion requires the same finalized transaction to debit the NFT and credit the approved positive amount.

## Return and payout

Displayed pack value, estimates, quotes, API success responses, pending transactions, and unsold NFTs never fund holders. The distributable amount is the exact attributable net USDG credit received after the return route. Native gas remains separate.

The existing owner-approved snapshot and Merkle-sum payout model remains the Phase 1 distribution boundary:

- a finalized HKMN snapshot determines eligible direct holders;
- one canonical manifest contains the approved recipients and amounts;
- the complete manifest sum equals the attributable net USDG return;
- Operations funds that exact sum into one payout commitment; and
- any caller may submit a valid proof, but payment always goes to the committed recipient.

No dashboard is required to create, fund, verify, or claim the payout. Contract reads, events, receipts, and canonical manifest bytes are the sources of truth.

## Mainnet canary

The first live proof uses one exact release and small owner-approved monetary caps. It requires fresh local tests, pinned-fork tests, independent review, exact deployed-runtime verification, and an execution bundle that names every chain, address, asset, destination, maximum spend, minimum receive, and gas cap.

The canary succeeds only when one continuous receipt chain proves:

```text
HKMN buy
-> fee split
-> process release
-> outbound conversion
-> pack purchase and open
-> NFT buyback
-> return conversion
-> exact payout funding
-> at least one holder payment
-> final reconciliation
```

A fixture replay, local test, dashboard projection, or receipt from another release does not count as live evidence.

## Deferred to Phase 2

- public or operator dashboard;
- OpenUI and dashboard-configurable controls;
- periodic or twenty-minute triggers;
- continuous and unattended operation;
- catalog persistence, caching, background refresh, search, or ranking;
- automatic pack selection and multiple pack strategies;
- route discovery, provider optimization, and automatic bridge selection;
- multiple concurrent cycles;
- generalized marketplace abstractions;
- advanced holder selection, analytics, alerts, and product polish.

Phase 2 may add these only around the proven money path. It must not weaken historical liabilities, permanent custody, receipt identity, payout conservation, or at-most-once external actions.

## Task-boundary consequences

- P1-011 moves out of Phase 1 because no dashboard is required for the canary.
- P1-010 is limited to the minimal append-only intent, receipt, restart, and reconciliation journal required for one manual cycle. It does not include scheduling, catalog refresh, control-plane state, or continuous operation.
- P1-009 remains because the returned net USDG must be bound to a deterministic holder manifest and fully funded payout.
- P1-012 no longer depends on a dashboard. Its live proof ends with contract, receipt, manifest, and entitlement reconciliation.
- No Phase 1 task may introduce UI, scheduling, catalog persistence, route optimization, multi-pack support, or unattended execution.

The detailed requirements revision and ledger migration follow only after this written design is reviewed.
