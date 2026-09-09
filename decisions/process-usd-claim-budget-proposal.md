# Process USD claim budget revision proposal

Status: proposed implementation alignment; this file does not advance the authoritative requirements revision.

The owner's launch request sets USD25,000 as the normal rolling six-hour process budget and USD50,000 as its adjustable maximum. The owner subsequently accepted bot enforcement for this launch. Native ETH remains the claim and payout asset.

Proposed requirement diff: supplement the native wei contract limit with a bot-level `processClaimLimit6hMicroUsd` control in the existing operator configuration, defaulting to 25000000000 and bounded from zero through 50000000000. Before a claim signature and first broadcast, the bot requires the immutable exact-amount authenticated Relay USD quote, rounded upward and still fresh, and reserves its debit durably. Successful claims count for strictly less than six hours from their finalized block timestamp. Unknown or unresolved reservations remain charged until authenticated finality, and only a proven revert releases an unsuccessful claim. Restart, rotation, lower limits, and zero never erase usage. Stale or missing price evidence refuses the effect.

This uses the existing quote producer and operator authority without selecting a new price oracle or changing contract ABI, native payouts, liquidity funding, or launch fees. The guarantee excludes direct Operations transactions outside the bot, matching the accepted scope. Configurations without the new field migrate to USD25,000; old in-flight claims without reservations require explicit reviewed recovery.
