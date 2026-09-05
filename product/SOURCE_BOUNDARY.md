# Clean-room Source Boundary

## Normative sources

New product behavior may come only from:

1. explicit owner decisions for this clean-room project;
2. official, versioned Programmable, Robinhood, USDG, Solana, Circle USD Coin, and Collector Crypt technical evidence;
3. requirements and ADRs derived from those sources;
4. tests and release receipts produced from the new implementation.

## Historical repository

Historical Git commits contain a prior product implementation.

That material is:

- recoverable reference;
- non-authoritative;
- not present in the active clean-room source tree;
- not acceptable as a provider binding;
- not acceptable as release evidence;
- not acceptable as an audit of the new system.

## Permitted reference use

A historical implementation may be inspected only after a new requirement already exists. Reuse requires:

1. the behavior is independently justified by a current requirement;
2. no historical address, ABI, role, constant, network, asset, fee, or provider assumption is copied;
3. the code is placed in a new clean-room path and named for the current design;
4. new tests prove the behavior against the current interface;
5. review records the exact source concept studied and why it does not control the design.

Copying a historical file and merely renaming its network or assets is prohibited.

## Provider evidence

Previous-chain Programmable material is labeled `UNVERIFIED_FOR_ROBINHOOD` and may be used only for terminology, interface-shape, and state-machine comparison. Its addresses, ABIs, deployment graph, Registry or Router behavior, legacy bridge message formats, permission bits, and provider API fields are not Robinhood authority.

Production binding requires Robinhood-specific:

- chain ID `4663` with production registry, RPC, and genesis evidence;
- asset identity;
- Factory or Launcher;
- Registrar and custom-hook admission;
- PoolManager, router, and PoolKey;
- fee semantics;
- proof that the canonical PoolKey static LP fee is zero and no protocol, router, provider, integrator, token-transfer, or other trading surcharge applies in addition to the inclusive 3.00 percent Hookemon hook fee;
- a provider-compatible atomic construction that places the position representing the 90 percent HKMN launch allocation into permanent non-project-controlled custody with no transfer, approval, liquidity decrease, principal withdrawal, fee collection, rescue, upgrade, delegatecall, or project-controlled successor authority;
- successful supported buys and sells after permanent custody, with ordinary wallet transfers and user balances unaffected;
- ABI, version, source revision, and code hash.

Unknown values remain `INTEGRATION_PENDING`.

The fixed Phase 1 pack path additionally requires current Collector Crypt Solana evidence for the production API host, authentication boundary, pack identity, canonical Solana USD Coin mint, generated transaction instructions, custody, purchase acknowledgement, pack opening, standard buyback eligibility and transaction construction, fees, settlement, idempotency, and receipt reconstruction. The outbound Robinhood-USDG-to-Solana-USD Coin and return Solana-USD Coin-to-Robinhood-USDG routes require current provider, program or contract, asset, destination, quote, minimum-receive, deadline, and finality evidence. Historical marketplace or bridge assumptions are not evidence.

Requirements revision 56 remains the Phase 1 source for the manually started vault-funded outbound-pack/open-buyback-return-payout path. Requirements revision 57 authorizes only the local manual Phase 2 controls in `REQ-cycle-control-1`: exact pack-snapshot selection, pre-freeze parameter editing, immutable plan freeze, same-cycle journal recovery, and a fresh isolated cycle after evidenced terminal failure. It adds no production provider authority.

Dashboard and UI, scheduling and continuous operation, catalog persistence or refresh, automatic pack strategy, route discovery or optimization, multi-pack execution, concurrency, signing, broadcast, credentials, and production mutations remain outside revision 57. No historical implementation, provider feature, or non-operative note may add those capabilities.

## Identity and secrets

- Repository-visible identity is the neutral Hookemon project identity.
- No personal names, local home paths, private email addresses, or Co-Author trailers belong in new artifacts.
- Pool notation is not a GitHub identity.
- A push or PR actor must be a real authorized project account.
- No credential is committed, logged, copied into a task, or passed through chat.
- Any exposed credential is revoked before use.

## Evidence rule

Only evidence generated from the clean-room source closure and exact integrated release SHA can pass a gate.
