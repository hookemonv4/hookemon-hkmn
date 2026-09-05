# Product Phase 2/3 Foundation Draft

## Status

**DRAFT — NON-OPERATIVE — NO ACTION AUTHORIZATION**

This document is shared discovery context only. It does not open Product Phase 2 or Product Phase 3, add or approve a requirement, assign a stable module ID, freeze an interface, create a task or path reservation, select a provider or ABI, authorize credential access, or authorize an API mutation, signature, broadcast, deployment, asset movement, or spend.

Product Phase 2 remains closed until the Product Phase 1 interface and evidence handoff passes and a fresh requirements revision receives exact owner approval. Product Phase 3 remains closed until its predecessor handoff and a separately approved specification pass. Non-operative future notes do not become product authority.

## Evidence basis

This draft summarizes only the current owner-approved Phase 1 boundary and its explicit deferrals:

- `decisions/ADR-0018-manual-one-cycle-phase-boundary.md`;
- `docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md`;
- `specs/requirements.json`, revision 55;
- `architecture/interfaces.json`, architecture revision 4;
- `architecture/trust-boundaries.md`;
- `product/PRD.md`, `product/PHASE_EXECUTION.md`, and `product/OWNER_DECISIONS.md`;
- `docs/modules/phase-boundary.md` and the non-operative historical context in `docs/modules/dashboard.md`; and
- `future/PHASE_2_OWNER_DECISIONS.md`, which remains non-operative.

Where these sources contain a superseded or historical future idea, this draft records it as open rather than treating it as an approved decision.

## Confirmed predecessor invariants

Any later product specification must preserve all of the following unless the owner separately approves a successor design that cannot alter the original deployment:

- The Phase 1 HKMN token, hook, permanent launch-position custody, liabilities, released cycles, payout commitments, paid keys, historical beneficiaries, and unpaid entitlements remain at their original addresses and keep their original semantics.
- Reversible offchain products may consume the proven Phase 1 path, but they cannot weaken permanent custody, liability isolation, payout conservation, committed-recipient payment, or at-most-once external-action and receipt identity.
- Finalized contract reads and events, canonical receipts, digest-matching canonical manifest bytes, and entitlement state remain authoritative inputs. A dashboard, cache, catalog, quote, provider status, or other projection is not live execution evidence.
- The immutable V1 hook gains no deferred selector, storage reservation, scheduler, marketplace adapter, route policy, pack policy, administrator, automation role, pause role, replacement authority, rescue path, proxy, or upgrade mechanism.
- The existing phase-boundary handoff is the predecessor seam. Product Phase 2 may consume `PhaseAuthorityRecord` and `PhaseOneHandoff` only after `validatePhaseTwoOpening` succeeds against the new approved requirements revision and owner receipt.
- Missing, stale, conflicting, nonfinal, or unauthenticated predecessor evidence fails closed. Technical readiness never grants external-action authority.
- `REQ-dashboard-1` remains permanently reserved and cannot be reused for a new requirement.

## Minimum Product Phase 2 boundaries

These four boundaries are the smallest candidate foundation for a future specification. They are not approved requirements and intentionally have no requirement IDs.

### 1. Opening boundary

Product Phase 2 can become operative only when all of the following are true:

1. the Product Phase 1 interface and evidence handoff is complete;
2. a fresh Product Phase 2 requirements revision identifies its exact scope;
3. open product and authority decisions have owner-approved ADRs or equivalent decision records;
4. the owner gives an exact approval bound to that revision; and
5. the delivery boundary records Product Phase 2 as open without relabeling incomplete Phase 1 evidence.

Absent any item, Phase 2 remains closed and no deferred capability becomes implementation work.

### 2. Predecessor compatibility boundary

A future Phase 2 component may observe and invoke only the already approved public Phase 1 interfaces. It cannot assume a mutable V1 ABI, rewrite historical state, migrate liabilities, reinterpret an existing receipt, replace a committed recipient, or require an original claim path to stop operating.

Any behavior that requires new onchain state or authority is outside this reversible compatibility boundary and belongs to a separately specified successor deployment.

### 3. Derived-data authority boundary

Every Phase 2 projection must retain source identity, content digest where applicable, chain finality, observation time, and consistency status. A derived field may be reported only as available, unavailable, or inconsistent; missing or conflicting evidence cannot be converted into inferred success.

Catalog entries, rankings, route candidates, quotes, analytics, alerts, and UI values remain proposals or observations. They cannot authorize a cycle, satisfy a receipt, fund a payout, prove a payment, or replace the predecessor evidence handoff.

### 4. External-action boundary

No scheduler, control surface, strategy, route planner, or orchestration process may mutate external state until a fresh owner-approved Phase 2 authority model defines the exact caller, subject, limits, consumption rule, recovery behavior, and audit evidence.

Whatever authority model is later selected must preserve durable intent-before-mutation, compare-and-swap journal progression, unique authorization and receipt consumption, reconciliation before retry, and rejection of blind or duplicate execution. This boundary does not choose between per-action authorization and a future bounded standing authority; that choice remains open.

## Owner decision matrix

Every row is open. The examples describe the decision surface, not approved options or recommended behavior.

| Decision surface | Evidence-constrained question for the owner | Must be fixed before | Default while open |
| --- | --- | --- | --- |
| Initial Phase 2 scope | Which deferred capabilities, if any, form the first approved Phase 2 increment? | Requirements approval | No deferred capability is active |
| Audience | Is a future product public, operator-facing, holder-facing, or separated into distinct surfaces? | UI and access architecture | No UI scope |
| UI authority | Is a surface strictly read-only, or may it prepare or request actions under a separately approved boundary? | UI interface and threat model | Read-only discovery only; no action preparation |
| Trigger model | Are cycles manual, periodic, event-driven, or continuously evaluated? | Orchestration requirements | No scheduler or unattended trigger |
| External-action authority | Does Phase 2 retain exact per-action authorization or introduce another bounded model? Who can start, stop, and recover it? | Any mutation or secret access | No standing authority and no execution |
| Catalog lifecycle | Which source, persistence, refresh, freshness, conflict, and outage rules govern pack facts? | Catalog interface | Direct observations are non-authoritative candidates |
| Pack strategy | Which packs, quantities, modes, eligibility rules, budgets, and selection criteria are allowed? | Strategy interface | No automatic selection or multi-pack behavior |
| Routing | Which providers, assets, chains, quote comparison, slippage, deadlines, and finality rules are allowed? | Routing and provider interfaces | No discovery, optimization, or bridge selection |
| Retry and recovery | What proves an intent absent, terminal, resumable, or safe to retry after uncertain external state? | Durable orchestration | Reconcile and stop; never blind retry |
| Concurrency | How many cycles may coexist, how are leases and budgets isolated, and which identities remain globally unique? | Multi-cycle state model | One manually started cycle only |
| Holder policy | Are direct balances retained, or are ranking, LP weighting, cohorts, or another allocation policy introduced? | Distribution specification | No inferred ranking or new allocation policy |
| Analytics and alerts | Which signals, retention periods, freshness targets, and incident actions are required? | Operational requirements | No SLO or automated response is implied |
| Marketplace abstraction | Is Collector still the only marketplace integration, or is a generalized adapter actually required? | Provider architecture | No generic marketplace abstraction |
| Product Phase 3 scope | Which holder-support or successor-hook behaviors, if any, belong in Phase 3? | Phase 3 specification | No Phase 3 feature is authorized |

The owner may choose none of the deferred capabilities. Deferral to Phase 2 means "eligible for a fresh specification," not "approved for implementation."

## Conflict-minimizing discovery and module lanes

The lane descriptions below are provisional ownership boundaries only. They do not assign stable module IDs or reserve repository paths.

| Provisional lane | Discovery responsibility | Outputs it may propose | Must not own |
| --- | --- | --- | --- |
| Phase opening and handoff | Opening gate, predecessor hashes, authority order, compatibility checks | Candidate opening and migration requirements | Product behavior, provider ABI, or external execution |
| Read-model and observability | Finalized chain/event reads, artifact verification, projection status, public/operator presentation questions | Candidate read models and stale/conflict failure modes | Secrets, signing, mutation, scheduler, or contract changes |
| Catalog and pack facts | Source evidence, cache/freshness questions, pack eligibility inputs | Candidate catalog snapshot seam | Selection authority, routing, execution, or stable policy |
| Pack strategy | Candidate selection and multi-pack decision surface | Candidate strategy inputs and explanations | Catalog ingestion, asset routing, signing, or spending |
| Routing and quotes | Provider evidence, route/quote comparison inputs, finality and receipt questions | Candidate route-proposal records | Authorization, broadcast, custody, or blind retry |
| Orchestration and concurrency | Trigger, lease, journal, restart, recovery, and multi-cycle decision surface | Candidate durable state transitions and on-call questions | Provider selection, signing secret, or onchain state |
| External-action authority | Authorization subject, caps, consumption, audit, and execution boundary | Candidate trust boundary and abuse cases | Product strategy, UI, or provider-specific ABI invention |
| Independent evidence and red-team | Cross-lane abuse cases, replay, stale data, conflict, duplicate action, and recovery testing | Independent test and review plans | Production implementation or approval decisions |
| Phase 3 successor discovery | Onchain-change inventory, historical-state compatibility, no-migration constraints | Candidate successor questions only | Editing V1 contracts or treating historical replacement ideas as approved |

One future spec/architecture integrator must be the sole writer for central requirements, ADR numbering, capability maps, interface registries, gates, dependency configuration, and final module IDs. Shared journal, authorization, receipt, custody, and money-path code must remain a serial high-risk integration surface. Parallel research is safe only when each lane writes to its own eventual module card or discovery artifact after the owner approves the path layout.

## Product Phase 3 successor boundary

General read-only dashboards and reversible offchain product surfaces may be considered in a fresh Phase 2 specification. A holder-support feature that changes a committed recipient, paid-state semantics, claim timing, failure state, role authority, or payout storage cannot be added around the existing hook as an offchain convenience.

The following behavior requires a fresh successor specification and a separately deployed hook, and therefore remains Product Phase 3 or later unless the owner explicitly defines a different later-phase order:

- recipient replacement, remapping, or holder-driven wallet migration;
- batch-only settlement state, delayed claim state, or explicit failed-recipient state;
- new administrator, automation, pause, rescue, surplus-recovery, policy, or emergency-withdrawal authority;
- new onchain ranking, LP weighting, marketplace, route, pack, scheduler, or support-product state; and
- any proxy, upgrade, delegatecall replacement, state import, or migration mechanism.

The original V1 deployment must remain available for every historical beneficiary, released cycle, funded payout, paid key, and unpaid entitlement. A successor handles only newly specified activity and does not relabel, copy, disable, or absorb historical state.

Earlier records mentioning a Product Phase 3 holder-facing verification interface sit inside superseded historical decisions. They identify a question for a fresh owner decision; they do not authorize that interface or transfer general Phase 2 UI scope into Phase 3 automatically.

## Exit condition for this draft

This draft can influence operative artifacts only after the Phase 2 opening prerequisite is satisfied and the owner answers the relevant decision-matrix rows. At that point, a fresh spec must create typed, measurable requirements with new stable IDs, and a subsequent architecture phase must choose stable module IDs and provisional interfaces. Until then, this file remains non-operative discovery context.
