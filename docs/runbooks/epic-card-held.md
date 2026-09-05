# Epic card held

## Detection

- Planned alert reason (WP10a): the epic gate finds `offerAtomic * 100 < insuredValueAtomic * 40`, or the gate lacks verified offer or insurance evidence.
- Target journal state: record the held card and preserve the `epic-gate` decision with its evidence.

## Safe stop

- Mark the claim path unavailable and do not invoke a live runner for new claims; leave the card in the held-assets custody bucket. An execution-pause control is planned (WP10b).
- Do not sell, buy back, alter the threshold, or fund another cycle from the held card.

## Runner behavior

- Planned (WP10a): the runner persists a `HELD_*` state, blocks new claims in v1, and does not auto-sell the card.
- Equality follows the buyback path; until WP10a lands, a held card requires a separate owner decision before any manual transition.

## Operator recovery

- The production status output does not expose the held-card evidence. The control surface is planned (WP10b).
- The owner-decision control is planned (WP10b). No existing CLI command releases or sells a held card.

## Escalation

Escalate missing or conflicting offer and insurance evidence to the provider owner. Escalate a verified held-card decision to the cycle owner with the card and journal references.

## Evidence

- Failure-matrix cell: `Epic gate:threshold-equality` expects the `buyback` stage and is owned by WP08b.
- Owning work package: WP10a for held-card custody and claim blocking.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP10a
Expected outcome: terminal=none; attempt=none; next=none
Test: OPEN FACT (WP10a): no executed held-card recovery test covers the below-threshold branch.
Alarm reason/code: OPEN FACT (WP10a): no dedicated alert code is emitted for a held card.
Resume command: none supported; a held card requires an owner decision through the planned control surface.
