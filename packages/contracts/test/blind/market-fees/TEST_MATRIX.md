# Blind Market and Fee Test Matrix

The blind suite is derived only from requirements revision 54, P1-002, P1-004, the canonical-market and fee-accounting module cards, and ADR-0003, ADR-0016, and ADR-0017. The frozen P1-001 callback selectors, PoolKey, raw delta, full-fill, and callback-stage conventions are represented by `BlindSwapRequest`. `BlindCanonicalMarketAdapter.t.sol` is the active, concrete P1-002 adapter; it imports the implementation only at the adapter boundary while the acceptance assertions operate on the blind interface. `BlindMarketFeesAcceptance` and `BlindMarketFeesFixture.deploy` remain quarantined only for the P1-004 surface.

| Area | Vectors | Required result | Trace |
| --- | --- | --- | --- |
| Hook permission mask | Both token orders | The fixture hook address has the frozen low-bit mask `0x20CC`, and the canonical PoolKey references the same address. | P1-001 provider freeze, REQ-canonical-market-1 |
| Swap quadrants | Buy and sell; exact input and exact output; USDG or HKMN as currency0 | Final address-mapped deltas determine executed USDG and HKMN. Displayed nominal USDG is ignored. | REQ-canonical-market-3, REQ-fee-accounting-1, FM-CM-01, FM-FA-02 |
| Untrusted nominal value | All eight swap quadrants | `displayedNominalUsdg` is a poison sentinel. It is neither `specifiedAmount` nor executed USDG, and it never supplies the fee basis. | REQ-canonical-market-3, REQ-fee-accounting-1, FM-CM-01, FM-FA-02 |
| Callback data | Different operation and recipient payload values; changed callback sender; partial fill; reverted swap | Hook data is ignored. The authenticated callback sender, PoolKey, parameters, and final delta remain bound; accepted swaps create no hook-side recipient credit. | REQ-canonical-market-4, REQ-canonical-market-6, FM-CM-02 |
| Canonical authentication | Foreign manager; swapped currencies; nonzero static or live LP fee; nonzero protocol fee; changed tick spacing, hook, or pool ID; wrong callback stage; malformed deltas; fee-delta mutation; nested finalization | Every invalid vector reverts with an unchanged economic digest. | REQ-canonical-market-1, REQ-canonical-market-2, FM-CM-01 |
| Inclusive fee | Executed USDG Q = 10,000 | Total = 300, Programmable = 10, treasury = 40, process = 250, actual collection = 300. | REQ-fee-accounting-1, FM-FA-01 |
| Rounding | Q = 1, 33, 34, 249, 250, 999, 1,000, 3,333, 3,334; 100,000 fuzz runs over uint128 Q | Every share uses its floor formula; process receives only the remainder; the three shares equal total exactly. | REQ-fee-accounting-1, ADR-0016, FM-FA-01, FM-FA-02 |
| Trading charges | Every accepted quadrant | Static LP fee is zero. Protocol, provider, integrator, token-transfer, and every other additional trading charge are zero. Network gas is outside the fee result. | REQ-canonical-market-5, ADR-0017, FM-CM-03 |
| Permanent custody | Exact 90% launch allocation; transfer, approval, liquidity decrease, withdrawal, collection, rescue, upgrade, and successor probes by project roles and an arbitrary caller | Custody is immutable, non-upgradeable, non-project-controlled, and exposes no successful principal or fee-control path. | REQ-canonical-market-5, FM-CM-03 |
| Post-custody use | Supported buy, supported sell, wallet transfer | Permanent launch-position custody does not block trading or freeze user HKMN. | REQ-canonical-market-5, ADR-0017 |
| Beneficiary epochs | Three treasury epochs and two Operations handovers | Programmable and treasury ownership stays frozen at accrual. Process liability is unchanged by handovers. | REQ-fee-accounting-2, FM-FA-03 |
| Claim isolation | Exact claim; liability plus one; zero liability; wrong beneficiary; alternate recipient; historical treasury claim; process and payout liabilities present | Only the beneficiary's exact positive self-directed liability and matching token balances change. | REQ-fee-accounting-3, FM-FA-04 |
| Adversarial USDG | Revert, false return, malformed return, short source, short destination, excess source, excess destination, reentry | Claim reverts; every liability and source or destination balance remains unchanged. | REQ-fee-accounting-3, REQ-fee-accounting-5, FM-FA-04 |
| Solvency and surplus | Accrual, isolated claim, payout liability, direct USDG surplus | Actual hook balance covers the sum of unpaid Programmable, treasury, process, and payout liabilities. Surplus creates no liability. | REQ-fee-accounting-4, FM-FA-05 |

## Active and deferred checks

`BlindMarketFeesSchemaReadinessTest` runs the frozen P1-001 raw-delta mapping and callback sender field. `BlindCanonicalMarketConcreteAcceptance` exercises ignored hook-data payload values and sender-bound finalization against the concrete adapter.

P1-004 liability split/accrual, beneficiary epochs, claims, adversarial token behavior, surplus/solvency, and permanent-custody authority remain intentionally abstract. Production-only checks also remain deferred under their named blockers: `DEPLOYED_ROBINHOOD_POOLMANAGER_CALLBACK_AND_SETTLEMENT_FORK`, `EXACT_OUTPUT_USDG_Q_GROSS_NET_AND_FEE_CUSTODY_SEMANTICS`, final canonical PoolKey/hook identities, HKMN runtime, and deployed custody/post-custody behavior.

The focused check is `forge test --offline --root packages/contracts --match-path 'test/blind/market-fees/*.t.sol'` with only the pinned v4-core and v4-periphery library paths.
