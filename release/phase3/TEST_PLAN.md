# Native release verification plan

Verify the exact candidate through the required CI, including native contracts, the archive fork, runtime/bytecode reproduction, adapters, runner, dashboard, dependency controls and release closure. Reuse successful checks for unchanged code; a later source change requires current evidence for the resulting candidate.

The local package verifier must reproduce source and artifact digests, native currency0, complete HKMN allocation, deterministic price/debt/refund, positive wei claim ceilings for a materialized candidate (an unset pair remains valid only in an unbound draft), actual eighteen-word hook constructor, exact graph ordering, full-range ticks and native seed value. Historical USDG fixtures remain compatibility evidence only. No USDG allowance belongs in a native seed.

The approved commitment tests establish canonical hash mechanics. Before a signing candidate exists, the active verifier must also authenticate source closure and external runtime authorities, reject circular inputs and match both commitments to the exact constructor, issuance plan, graph and pool. Synthetic vectors are not provider evidence.

Use the staged first-cycle and optional second-cycle procedure in `launch-plan.md`. Record actual transaction effects and reconcile every stage before proceeding. An archive fork validates the pinned on-chain infrastructure with a synthetic graph; it does not prove that an unsent graph is deployed or that Collector, bridge and payout effects have occurred. A rehearsal using fixtures must be labeled accordingly.

The owner has deferred complete EUR 250 affordability analysis until functional testing. Preserve per-action funding, gas/rent reserves, expiry, authorization and loss/retry limits. Do not convert an incomplete cost calculation into a passing release claim.

Local package verification reads no credentials or network state. Follow `preflight/README.md` for the separate preflight procedure, using a committed regenerated package and specifically authorized backend credentials.
