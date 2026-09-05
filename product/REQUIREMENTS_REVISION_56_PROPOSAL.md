# Requirements revision 56

## Status

Owner-approved normative correction for local implementation on 1 September 2026. This revision supersedes only the Operations-custody portions of revision 55.

## Immutable peg-cycle custody

The immutable fee split remains 0.10% Programmable, 0.40% treasury, and the exact remainder of the inclusive 3.00% fee as peg-cycle process liability. The hook may debit process liability only while atomically funding its immutable PegCycleVault. Operations is a trigger only and never a process-principal, external-route, return-proceeds, or payout-funding custodian. All exact attributable returned USDG is committed from the vault to the hook as one sum-bound holder payout.

`PegCycleVault` and the hook are mutually bound at deployment. The vault is non-upgradeable and exposes no generic execution, arbitrary transfer, approval, rescue, sweep, delegatecall, or successor-control path. Its single Phase 1 lifecycle is `EMPTY -> FUNDED -> OUTBOUND -> RETURNED -> PAYOUT_COMMITTED`; a terminal evidenced failure permanently locks that one-cycle vault.

One authorization identity, distinct from Operations, treasury, Programmable, hook, and vault, binds requirements revision, binding-manifest digest, Robinhood chain, hook, vault, USDG, cycle, nonce, Operations trigger, exact amount, route and request digests, vault return destination, gas caps, minimum receives, and expiry. Robinhood-specific launch, admission, router, registrar, ABI, and route facts remain `INTEGRATION_PENDING`.

Dashboard and UI remain deferred to Phase 2. This revision authorizes local specification, implementation, and tests only; it does not authorize credentials, signing, broadcasts, deployment, asset movement, publication, push, merge, or production-readiness claims.
