# Immutable Peg-Cycle Custody

**Status:** Owner-approved for local implementation

**Product phase:** Phase 1 correction

**Requirements baseline:** Revision 56 approved; normative repository bindings are to be implemented by Task 1

**Selected approach:** Full 2.50% path without Operations custody

## Goal

The immutable launch system must enforce the complete purpose of the 2.50% process share. Operations may trigger an exactly authorized cycle, but it must never receive, withdraw, redirect, approve, rescue, or otherwise control process principal or returned proceeds.

The fee split remains compile-time behavior:

- total Hookemon fee: 3.00% of authenticated executed USDG volume;
- Programmable liability: 0.10%;
- treasury liability: 0.40%;
- peg-cycle process liability: the exact remainder, 2.50% under ordinary whole-unit examples.

No role, signature, dashboard, provider response, route, or future phase may change those percentages or reclassify one liability as another.

## Decision

Use an immutable hook-bound peg-cycle vault. The hook may debit process liability only while atomically funding that exact vault. The vault and hook are mutually bound at deployment and expose no upgrade, rescue, arbitrary-transfer, delegatecall, or successor-control path.

Operations remains a replaceable trigger identity. It cannot be a process-fund recipient, route recipient, return recipient, payout funder, vault administrator, or authorization signer.

The rejected alternative was a per-cycle owner co-signature followed by transfer to Operations. That would cap a compromised Operations account but would still give it custody after release and therefore would not satisfy the selected invariant.

## Components

### Hook fee accounting

`FeeAccounting` retains the existing fixed basis-point constants and isolated liabilities. Accrual continues to increase Programmable, historical treasury, and process liabilities by exactly the collected fee, with no configurable split.

`ProcessBudget` no longer transfers USDG to Operations. Its public transition becomes an exact cycle-opening operation that validates the current Operations trigger and one owner authorization, debits process liability, and transfers the authorized amount only to the immutable vault.

### Peg-cycle vault

The vault is a non-upgradeable companion contract created and bound as part of the immutable launch composition. It stores one sequential cycle state and may move USDG only through the selected cycle transitions.

The vault has no generic `execute`, `transfer`, `approve`, `rescue`, `sweep`, administrator, successor, or arbitrary-call interface. Provider calls are exposed through narrow typed operations after the exact production router, selector, asset, chain, and destination bindings pass feasibility.

Phase 1 permits only one active cycle at a time. A later cycle cannot open until the preceding cycle commits its returned proceeds to a payout. A terminal, explicitly evidenced failure state never creates a withdrawal path and permanently locks this one-cycle Phase 1 vault so a delayed return cannot contaminate a later cycle.

### Cycle authorizer

One immutable authorization identity is bound at deployment and must be distinct from Operations, treasury, Programmable, the hook, and the vault. Production may bind an EOA or an ERC-1271 policy wallet, but the exact identity and runtime evidence are release inputs.

The cycle-opening authorization binds at least:

- requirements revision and binding-manifest digest;
- Robinhood chain ID, hook, vault, and USDG identities;
- cycle identifier and single-use authorization nonce;
- current Operations trigger identity;
- exact process amount;
- exact outbound route identity and canonical request digest;
- exact return destination, which must be the vault;
- per-chain native-gas caps, minimum receives, and expiry.

The signature is consumed once. A wrong, expired, replayed, partially matching, or cross-chain authorization fails before liability or token state changes.

### External execution boundary

The runner may prepare and submit actions but never becomes custodian. The Robinhood outbound action must debit only the vault through the frozen route. The Solana leg must use a provider-supported program-controlled or policy wallet that cannot be unilaterally spent by Operations. An ordinary Operations-owned EOA on either chain is forbidden.

Every bridge, pack purchase, open, buyback, and return action retains the existing exact intent, decoded-message, signature, finality, receipt, and replay checks. The production route remains fail-closed until its deployed contracts, Solana authority model, ABIs, code hashes, selectors, and destinations are independently bound.

## Money flow

1. An authenticated canonical swap pays the fixed inclusive 3.00% Hookemon fee into the hook.
2. The hook atomically records 0.10% Programmable, 0.40% treasury, and the exact 2.50% process remainder as separate liabilities.
3. Operations submits a valid owner-authorized cycle opening. The hook transfers the exact authorized process amount only to the immutable vault.
4. The vault permits only the exact bound outbound route and amount. Operations cannot substitute a destination or receive an approval.
5. The policy-controlled external path performs the selected pack purchase, open, buyback, and return under the existing single-use action ledger.
6. The return route names the vault as the Robinhood USDG recipient. Returned proceeds never pass through Operations.
7. After independent finality and exact balance-delta verification, a second owner authorization binds the cycle, returned amount, payout identifier, manifest digest, Merkle-sum root, and root sum.
8. The vault transfers the exact returned USDG to the hook while the hook atomically records the matching payout liability. The root sum must equal the vault debit, hook credit, and exact attributable returned amount.
9. Holder payments remain permissionless and sum-bound. Operations has no payout-funding custody or withdrawal step.

All actual attributable returned USDG is committed to the holder payout. A quote, estimate, API success response, pending transaction, unrelated balance change, or unresolved asset cannot fund a payout.

## State and failure behavior

The minimal vault lifecycle is `EMPTY -> FUNDED -> OUTBOUND -> RETURNED -> PAYOUT_COMMITTED`. Each transition is single-use and records the exact cycle and evidence digests.

Every validation and token transfer is atomic. A failed authorization, token call, balance check, provider binding, action decode, finality check, return attribution, publication preflight, or payout commitment leaves the current state unchanged.

If external execution fails after principal leaves the vault, the system stops and preserves evidence. It must not invent returned proceeds, repay the loss from another liability, reopen a consumed authorization, or give Operations a recovery withdrawal. Any future recovery route requires a separately specified immutable provider mechanism and fresh owner approval before production binding.

## Contract and runner changes

Implementation will:

- preserve `FeeAccounting` split constants and accrual formula;
- replace Operations-directed `releaseProcessBudget` behavior with vault-only cycle funding;
- add the immutable hook-bound vault and typed authorization records;
- replace Operations-funded `fundPayout` with vault-funded returned-proceeds commitment;
- remove Operations balance attribution from the runner's outbound and return accounting;
- require vault or policy-account attribution for every external action and return receipt;
- update requirements, module cards, interface freeze, risk model, task acceptance, and release evidence without opening Product Phase 2;
- keep the dashboard read-only and deferred.

## Verification

Tests are written before implementation and must first fail against the current Operations-custody behavior. The focused proof covers:

- unchanged 3.00% / 0.10% / 0.40% / 2.50% fee conservation and rounding;
- Operations cannot receive process principal or returned USDG;
- no alternate recipient, approval, rescue, upgrade, delegatecall, or arbitrary call exists;
- wrong signer, trigger, chain, hook, vault, asset, amount, route, request digest, return destination, nonce, expiry, or binding digest fails without mutation;
- cycle and authorization replay fail;
- a second concurrent cycle fails;
- exact vault debit, route spend, return credit, hook credit, payout root sum, and liability conservation;
- unrelated vault or hook balance changes cannot become cycle proceeds;
- payout commitment cannot be funded by Operations or an external wallet;
- Operations rotation affects only the trigger for a future unopened cycle;
- the complete local Phase 1 loop ends with holder payment while every Operations USDG balance delta attributable to process principal or returned proceeds is zero.

Only focused contract and runner tests run locally during implementation. The complete invariant, build, lint, type, and release checks remain the single later CI/full-gate pass.

## Validation sequence

The corrected version is completed and tested locally before any live action. Validation then proceeds in this order:

1. focused unit and runner tests while implementing;
2. one complete local loop and one pinned Robinhood fork using the final candidate bindings;
3. independent review and remediation of material findings;
4. one separately authorized, minimum-value Mainnet canary with exact contract addresses, signer identities, assets, destinations, calldata digests, maximum principal, minimum returns, and per-chain gas caps;
5. analysis of the canary receipts and balance deltas;
6. any required adjustment in a new candidate deployment, followed by the affected focused tests and review;
7. final production deployment only after the adjusted candidate passes the release gates.

The Mainnet canary is disposable evidence. It cannot be promoted into production authority, and no mutable proxy or upgrade path is added to make post-canary adjustments. A changed contract is a new bytecode candidate with a new manifest and deployment address.

## Release boundary

This design authorizes local specification, implementation, and tests only. The owner's instruction approves the validation sequence in principle but is not the exact action authorization required for its Mainnet step. It does not yet authorize credentials, signing, broadcast, deployment, bridge or marketplace actions, asset movement, publication, spend, GitHub push, merge, or a production-readiness claim.

Phase 1 remains incomplete until the corrected contracts and runner pass review, the final production vault and route bindings pass pinned-fork verification, all severe findings close, and the separately authorized live evidence path succeeds. Product Phase 2 remains closed.
