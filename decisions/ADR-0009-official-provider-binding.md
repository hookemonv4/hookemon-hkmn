# ADR-0009: Official provider binding before executable integration

## Status

Accepted for Phase 1 on 30 August 2026. The settlement-batch-sizing clause is superseded by ADR-0014 and the fee-rounding deferral clause by ADR-0016; the rest remains applicable. Evidence note (2026-08-30): live discovery spike SPIKE-R53-PROGRAMMABLE-CHAIN-4663 found chain 4663 unsupported as a production launch target (feasibility/integration-spikes.json, tracked as RT-BLD-01).

## Context

Robinhood-specific Programmable Factory, Registrar, PoolManager, router, USDG, PoolKey, callback, fee, gas, and size facts are not yet present as official versioned evidence. Previous-chain material is non-authoritative.

## Decision

- Keep every provider-dependent production path fail closed while any required binding is `INTEGRATION_PENDING`.
- Require official Robinhood-specific chain, asset, address, ABI, source revision, runtime code hash, admission, callback, fee, gas, and deployment-limit evidence.
- Derive currency ordering from final addresses, never display notation.
- Define exact gross/net convention, rounding, LP interaction, exact-output behavior, partial-fill behavior, and batch size only from the bound provider semantics and measured chain evidence.
- Preserve the owner-approved product invariants while refusing to invent executable integration details.

## Alternatives

### Reuse previous-chain bindings

Pros:

- Integration code could start immediately.

Cons:

- Addresses, ABIs, admission rules, token behavior, and fee semantics may differ.

Rejected: historical and previous-chain evidence is not authoritative for Robinhood production.

### Choose local fee semantics independently

Pros:

- Tests could target a complete formula now.

Cons:

- The result may be incompatible with the Launchpad or charge traders incorrectly.

Rejected: executable semantics must conform to official provider behavior.

## Consequences

- Provider-independent accounting and state-machine work can proceed.
- Production integration, exact fee vectors, code-size bounds, and batch sizing remain blocked until evidence exists.
- A missing single binding prevents deployment and mutation.
